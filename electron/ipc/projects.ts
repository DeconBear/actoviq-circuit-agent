import { app, BrowserWindow, type IpcMain, shell } from 'electron';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { loadSettings } from './settings.js';
import { getActiveWorkspace } from '../workspaceState.js';

interface ProjectSummary {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  projectRoot: string;
  moduleCount: number;
}

interface SavedDesignMemorySummary {
  ok: true;
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
}

interface DesignMemoryItem {
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  createdAt?: string;
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
}

let activeWatcher: FSWatcher | null = null;
let watchedProjectId = '';
let watchTimer: NodeJS.Timeout | null = null;

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function assertModuleId(moduleId: string): string {
  if (typeof moduleId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(moduleId)) {
    throw new Error(`Invalid module id: ${moduleId}`);
  }
  return moduleId;
}

async function projectsRoot(): Promise<string> {
  const workspace = await getActiveWorkspace();
  const root = path.resolve(workspace.root, 'projects');
  await mkdir(root, { recursive: true });
  return root;
}

async function resolveProjectRoot(projectId: string): Promise<string> {
  const root = await projectsRoot();
  const candidate = path.resolve(root, String(projectId ?? '').trim());
  const relative = path.relative(root, candidate);
  if (!projectId || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  if (!(await exists(path.resolve(candidate, 'project.circuit.json')))) {
    throw new Error(`Circuit project not found: ${projectId}`);
  }
  return candidate;
}

function timestampForId(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'circuit-design';
}

function relativeReferencePath(referencesDir: string, targetPath: string): string {
  return path.relative(referencesDir, targetPath).replace(/\\/g, '/');
}

async function uniqueProjectRoot(projectsRootPath: string, name: string): Promise<{ projectId: string; projectRoot: string }> {
  const baseId = slugify(name);
  let projectId = baseId;
  let suffix = 2;
  while (await exists(path.resolve(projectsRootPath, projectId))) {
    projectId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return {
    projectId,
    projectRoot: path.resolve(projectsRootPath, projectId),
  };
}

async function copyFileIfExists(source: string, target: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

async function copyDirectoryIfExists(source: string, target: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return true;
}

async function readJsonFile<T>(targetPath: string): Promise<T> {
  return JSON.parse(await readFile(targetPath, 'utf8')) as T;
}

async function designMemoryTargetRoot(
  kind: 'templates' | 'flows',
  project: { name: string; revision: number },
): Promise<{ workspaceReferencesDir: string; targetRoot: string; memoryId: string }> {
  const workspace = await getActiveWorkspace();
  const memoryId = `${slugify(project.name)}-r${project.revision}-${timestampForId()}`;
  const targetRoot = path.resolve(workspace.referencesDir, 'design-memory', kind, memoryId);
  await mkdir(targetRoot, { recursive: false });
  return { workspaceReferencesDir: workspace.referencesDir, targetRoot, memoryId };
}

function renderModuleSummary(project: {
  modules?: Array<{
    id: string;
    name: string;
    kind: string;
    function?: string;
    parameters?: Record<string, string>;
    ports?: Array<{ name: string; direction: string; signal_type: string; net: string; network?: string }>;
  }>;
}): string {
  return (project.modules ?? []).map((module) => {
    const ports = (module.ports ?? [])
      .map((port) => `${port.direction} ${port.name}=${port.network ?? port.net} (${port.signal_type})`)
      .join('; ');
    const parameters = Object.entries(module.parameters ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('; ');
    return [
      `- ${module.id} (${module.kind}): ${module.name}`,
      module.function ? `  Function: ${module.function}` : '',
      parameters ? `  Parameters: ${parameters}` : '',
      ports ? `  Ports: ${ports}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

function buildTemplateGuide(input: {
  memoryId: string;
  project: {
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  };
  hasSystemNetlist: boolean;
  hasReport: boolean;
}): string {
  return [
    `# Saved Design Template: ${input.project.name}`,
    '',
    `Template id: ${input.memoryId}`,
    `Source project: ${input.project.project_id}`,
    `Source revision: ${input.project.revision}`,
    '',
    '## How To Reuse',
    '',
    '- Prefer this template when the requested circuit matches the topology, module partitioning, or sizing strategy below.',
    '- Start from `template.cir` when present; otherwise inspect `project.circuit.json` and `modules/`.',
    '- Preserve the module boundary and port naming pattern unless the new requirement clearly needs a different architecture.',
    '- Treat `modules/<id>/schematic.overrides.json` as layout memory only; do not infer electrical connectivity from it.',
    '',
    '## Files',
    '',
    '- `template.json`: structured metadata for agents.',
    '- `template.cir`: reusable flat SPICE starter netlist when the source project had a compiled system netlist.',
    '- `project.circuit.json`: saved module canvas and system connectivity.',
    '- `modules/`: module JSON, notebooks, and schematic layout overrides.',
    input.hasReport ? '- `source-report.md`: generated report from the source project.' : '',
    '',
    '## Module Summary',
    '',
    renderModuleSummary(input.project as Parameters<typeof renderModuleSummary>[0]) || '- No modules recorded.',
    '',
    '## Reuse Notes',
    '',
    `- Module count: ${input.project.modules?.length ?? 0}`,
    `- Connection count: ${input.project.connections?.length ?? 0}`,
    `- System netlist saved: ${input.hasSystemNetlist ? 'yes' : 'no'}`,
    `- Source report saved: ${input.hasReport ? 'yes' : 'no'}`,
    '',
  ].filter((line) => line !== '').join('\n');
}

async function readAppliedCommands(projectRoot: string): Promise<Array<{
  file: string;
  command_id?: string;
  message?: string;
  operations?: Array<{ op?: string; module_id?: string }>;
}>> {
  const commandsRoot = path.resolve(projectRoot, 'commands', 'applied');
  if (!(await exists(commandsRoot))) return [];
  const entries = (await readdir(commandsRoot)).filter((entry) => entry.endsWith('.json')).sort();
  const commands = [];
  for (const entry of entries) {
    try {
      const command = await readJsonFile<{
        command_id?: string;
        message?: string;
        operations?: Array<{ op?: string; module_id?: string }>;
      }>(path.resolve(commandsRoot, entry));
      commands.push({ file: entry, ...command });
    } catch {
      // Ignore partially written command records.
    }
  }
  return commands;
}

function buildFlowMarkdown(input: {
  memoryId: string;
  project: {
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  };
  commands: Awaited<ReturnType<typeof readAppliedCommands>>;
}): string {
  const commandLines = input.commands.length > 0
    ? input.commands.map((command, index) => {
        const ops = (command.operations ?? [])
          .map((operation) => operation.module_id ? `${operation.op}:${operation.module_id}` : operation.op)
          .filter(Boolean)
          .join(', ');
        return [
          `${index + 1}. ${command.command_id ?? command.file}`,
          command.message ? `   Intent: ${command.message}` : '',
          ops ? `   Operations: ${ops}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n')
    : '1. No applied GUI command log was recorded for this project.';
  return [
    `# Saved Design Flow: ${input.project.name}`,
    '',
    `Flow id: ${input.memoryId}`,
    `Source project: ${input.project.project_id}`,
    `Source revision: ${input.project.revision}`,
    '',
    '## When To Reuse',
    '',
    '- Use this flow as a process reference for similar circuit families, module partitioning, naming conventions, and verification order.',
    '- Re-run validation and simulation for new requirements; this flow is guidance, not a proof of correctness for a new design.',
    '',
    '## Source Architecture',
    '',
    renderModuleSummary(input.project as Parameters<typeof renderModuleSummary>[0]) || '- No modules recorded.',
    '',
    '## Applied Command Flow',
    '',
    commandLines,
    '',
    '## Agent Checklist',
    '',
    '- Start from the closest saved template or bundled starter netlist.',
    '- Preserve useful module and net naming from this flow when it improves readability.',
    '- Compile modules after netlist changes, then inspect schematic geometry before accepting the design.',
    '- Save any new reusable topology back into design memory after verification.',
    '',
  ].join('\n');
}

async function saveDesignTemplate(projectId: string): Promise<SavedDesignMemorySummary> {
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<{
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  }>(path.resolve(projectRoot, 'project.circuit.json'));
  const { workspaceReferencesDir, targetRoot, memoryId } = await designMemoryTargetRoot('templates', project);

  await copyFile(path.resolve(projectRoot, 'project.circuit.json'), path.resolve(targetRoot, 'project.circuit.json'));
  await copyDirectoryIfExists(path.resolve(projectRoot, 'modules'), path.resolve(targetRoot, 'modules'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'build-manifest.json'), path.resolve(targetRoot, 'build-manifest.json'));
  const hasSystemNetlist = await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'design.final.cir'),
    path.resolve(targetRoot, 'template.cir'),
  );
  const hasReport = await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'report.md'),
    path.resolve(targetRoot, 'source-report.md'),
  );

  const manifest = {
    schema: 'actoviq.design-template.v1',
    id: memoryId,
    name: project.name,
    source_project_id: project.project_id,
    source_revision: project.revision,
    created_at: new Date().toISOString(),
    files: {
      agent_guide: 'agent-guide.md',
      template_netlist: hasSystemNetlist ? 'template.cir' : null,
      project: 'project.circuit.json',
      modules: 'modules/',
      source_report: hasReport ? 'source-report.md' : null,
    },
  };
  await writeFile(path.resolve(targetRoot, 'template.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.resolve(targetRoot, 'agent-guide.md'),
    buildTemplateGuide({ memoryId, project, hasSystemNetlist, hasReport }),
    'utf8',
  );

  return {
    ok: true,
    id: memoryId,
    kind: 'template',
    name: project.name,
    rootPath: targetRoot,
    relativePath: relativeReferencePath(workspaceReferencesDir, targetRoot),
    guidePath: path.resolve(targetRoot, 'agent-guide.md'),
    templatePath: hasSystemNetlist ? path.resolve(targetRoot, 'template.cir') : undefined,
  };
}

async function saveDesignFlow(projectId: string): Promise<SavedDesignMemorySummary> {
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<{
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  }>(path.resolve(projectRoot, 'project.circuit.json'));
  const commands = await readAppliedCommands(projectRoot);
  const { workspaceReferencesDir, targetRoot, memoryId } = await designMemoryTargetRoot('flows', project);

  await copyDirectoryIfExists(path.resolve(projectRoot, 'commands', 'applied'), path.resolve(targetRoot, 'commands', 'applied'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'build-manifest.json'), path.resolve(targetRoot, 'build-manifest.json'));
  const flowPath = path.resolve(targetRoot, 'design-flow.md');
  const manifest = {
    schema: 'actoviq.design-flow.v1',
    id: memoryId,
    name: project.name,
    source_project_id: project.project_id,
    source_revision: project.revision,
    created_at: new Date().toISOString(),
    command_count: commands.length,
    files: {
      design_flow: 'design-flow.md',
      applied_commands: 'commands/applied/',
    },
  };
  await writeFile(path.resolve(targetRoot, 'flow.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(flowPath, buildFlowMarkdown({ memoryId, project, commands }), 'utf8');

  return {
    ok: true,
    id: memoryId,
    kind: 'flow',
    name: project.name,
    rootPath: targetRoot,
    relativePath: relativeReferencePath(workspaceReferencesDir, targetRoot),
    flowPath,
  };
}

async function listDesignMemoryKind(
  referencesDir: string,
  directoryName: 'templates' | 'flows',
  kind: 'template' | 'flow',
): Promise<DesignMemoryItem[]> {
  const root = path.resolve(referencesDir, 'design-memory', directoryName);
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const items: DesignMemoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetRoot = path.resolve(root, entry.name);
    const relative = path.relative(root, targetRoot);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const manifestPath = path.resolve(targetRoot, kind === 'template' ? 'template.json' : 'flow.json');
    try {
      const manifest = await readJsonFile<{
        id?: string;
        name?: string;
        source_project_id?: string;
        source_revision?: number;
        created_at?: string;
        files?: Record<string, string | null>;
      }>(manifestPath);
      const fallbackStat = await stat(targetRoot);
      const files = manifest.files ?? {};
      const agentGuide = files.agent_guide;
      const templateNetlist = files.template_netlist;
      const designFlow = files.design_flow;
      items.push({
        id: manifest.id || entry.name,
        kind,
        name: manifest.name || entry.name,
        rootPath: targetRoot,
        relativePath: relativeReferencePath(referencesDir, targetRoot),
        sourceProjectId: manifest.source_project_id,
        sourceRevision: manifest.source_revision,
        createdAt: manifest.created_at || fallbackStat.mtime.toISOString(),
        guidePath: typeof agentGuide === 'string' ? path.resolve(targetRoot, agentGuide) : undefined,
        templatePath: typeof templateNetlist === 'string' ? path.resolve(targetRoot, templateNetlist) : undefined,
        flowPath: typeof designFlow === 'string' ? path.resolve(targetRoot, designFlow) : undefined,
      });
    } catch {
      // Ignore incomplete or hand-edited design memory folders.
    }
  }
  return items.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
}

async function listDesignMemory(): Promise<{ templates: DesignMemoryItem[]; flows: DesignMemoryItem[] }> {
  const workspace = await getActiveWorkspace();
  const [templates, flows] = await Promise.all([
    listDesignMemoryKind(workspace.referencesDir, 'templates', 'template'),
    listDesignMemoryKind(workspace.referencesDir, 'flows', 'flow'),
  ]);
  return { templates, flows };
}

async function findDesignMemoryItem(kind: 'template' | 'flow', id: string): Promise<DesignMemoryItem> {
  const memory = await listDesignMemory();
  const items = kind === 'template' ? memory.templates : memory.flows;
  const item = items.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`Saved ${kind} not found: ${id}`);
  }
  return item;
}

async function createProjectFromTemplate(input: {
  templateId: string;
  name?: string;
}): Promise<Record<string, unknown>> {
  const template = await findDesignMemoryItem('template', String(input.templateId ?? '').trim());
  const sourceProjectPath = path.resolve(template.rootPath, 'project.circuit.json');
  if (!(await exists(sourceProjectPath))) {
    throw new Error(`Saved template has no project.circuit.json: ${template.id}`);
  }

  const sourceProject = await readJsonFile<{
    schema: string;
    project_id: string;
    name: string;
    revision: number;
    modules?: Array<{ id?: string; source?: string }>;
    connections?: unknown[];
    analyses?: unknown;
  }>(sourceProjectPath);
  const name = input.name?.trim() || `${sourceProject.name || template.name} copy`;
  const root = await projectsRoot();
  const { projectId, projectRoot } = await uniqueProjectRoot(root, name);
  await mkdir(projectRoot, { recursive: false });
  await mkdir(path.resolve(projectRoot, 'modules'), { recursive: true });
  await Promise.all(
    ['commands/pending', 'commands/applied', 'commands/rejected', 'revisions', 'build', 'logs']
      .map((directory) => mkdir(path.resolve(projectRoot, directory), { recursive: true })),
  );
  await copyDirectoryIfExists(path.resolve(template.rootPath, 'modules'), path.resolve(projectRoot, 'modules'));

  const now = new Date().toISOString();
  const project = {
    ...sourceProject,
    project_id: projectId,
    name,
    revision: 0,
    created_at: now,
    updated_at: now,
  };
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(projectRoot, 'project.settings.json'), `${JSON.stringify({
    schema: 'actoviq.project-settings.v1',
    imported_from_template: template.id,
    imported_at: now,
  }, null, 2)}\n`, 'utf8');

  for (const moduleRef of project.modules ?? []) {
    const moduleId = moduleRef.id;
    if (!moduleId) continue;
    const moduleRoot = path.resolve(projectRoot, 'modules', moduleId);
    const modulePath = path.resolve(moduleRoot, 'module.circuit.json');
    if (await exists(modulePath)) {
      try {
        const module = await readJsonFile<Record<string, unknown>>(modulePath);
        module.revision = 0;
        await writeFile(modulePath, `${JSON.stringify(module, null, 2)}\n`, 'utf8');
      } catch {
        // The project summary step below will surface invalid module files.
      }
    }
    const overridesPath = path.resolve(moduleRoot, 'schematic.overrides.json');
    if (await exists(overridesPath)) {
      try {
        const overrides = await readJsonFile<Record<string, unknown>>(overridesPath);
        overrides.project_id = projectId;
        overrides.module_id = moduleId;
        overrides.updated_at = now;
        await writeFile(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
      } catch {
        // Invalid overrides are non-fatal; rendering can regenerate them later.
      }
    }
  }

  const bundle = await runProjectTool(['summary', '--project-root', projectRoot]);
  return enrichProjectBundle(projectRoot, bundle);
}

function projectScriptPath(): string {
  const candidates = [
    path.resolve(app.getAppPath(), 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py'),
    path.resolve(process.resourcesPath, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py'),
  ];
  const candidate = candidates.find((value) => existsSync(value));
  if (!candidate) {
    throw new Error('circuit_project.py is missing from the application bundle.');
  }
  return candidate;
}

function runProjectTool(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN?.trim() || 'python';
    const child = spawn(python, [projectScriptPath(), ...args], {
      cwd: app.getAppPath(),
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Circuit project tool timed out.'));
    }, 120_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(line) as Record<string, unknown>;
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || `Circuit project tool exited with ${code}`));
        return;
      }
      if (code !== 0 || result.ok !== true) {
        reject(new Error(String(result.error ?? stderr.trim() ?? `Circuit project tool exited with ${code}`)));
        return;
      }
      resolve(result);
    });
  });
}

async function listProjects(): Promise<ProjectSummary[]> {
  const root = await projectsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(root, entry.name);
    try {
      const project = JSON.parse(
        await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'),
      ) as {
        project_id: string;
        name: string;
        revision: number;
        updated_at?: string;
        modules?: unknown[];
      };
      projects.push({
        projectId: project.project_id,
        name: project.name,
        revision: project.revision,
        updatedAt: project.updated_at ?? '',
        projectRoot,
        moduleCount: project.modules?.length ?? 0,
      });
    } catch {
      // Ignore invalid or partially written project directories.
    }
  }
  return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function enrichProjectBundle(
  projectRoot: string,
  bundle: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const project = bundle.project as {
    modules?: Array<{ id?: string; name?: string; function?: string }>;
  } | undefined;
  const manifestPath = path.resolve(projectRoot, 'build', 'build-manifest.json');
  let manifestModules: Record<string, { revision?: number }> = {};
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      modules?: Record<string, { revision?: number }>;
    };
    manifestModules = manifest.modules ?? {};
  } catch {
    manifestModules = {};
  }
  const previews: Record<string, {
    svg: string;
    svgPath: string;
    netlistPath: string;
    netlist: string;
    notebook: string;
    notebookPath: string;
    builtRevision?: number;
    schematicOverrides?: Record<string, unknown>;
  }> = {};
  for (const moduleRef of project?.modules ?? []) {
    const moduleId = moduleRef.id;
    if (!moduleId) continue;
    const moduleBuildRoot = path.resolve(projectRoot, 'build', 'modules', moduleId);
    const svgPath = path.resolve(moduleBuildRoot, 'schematic.svg');
    const netlistPath = path.resolve(moduleBuildRoot, 'design.cir');
    if (!(await exists(svgPath)) && !(await exists(netlistPath))) continue;
    const netlist = await exists(netlistPath) ? await readFile(netlistPath, 'utf8') : '';
    const notebookPath = path.resolve(projectRoot, 'modules', moduleId, 'netlist-notebook.md');
    const overridesPath = path.resolve(projectRoot, 'modules', moduleId, 'schematic.overrides.json');
    const notebook = await exists(notebookPath)
      ? await readFile(notebookPath, 'utf8')
      : [
          `# ${moduleRef.name ?? moduleId}`,
          '',
          moduleRef.function ?? 'Describe this circuit module here.',
          '',
          '## SPICE netlist',
          '',
          '```spice',
          netlist.trim(),
          '```',
          '',
          '## Notes',
          '',
          'Add implementation notes, assumptions, review comments, or Agent instructions here.',
          '',
        ].join('\n');
    previews[moduleId] = {
      svg: await exists(svgPath) ? await readFile(svgPath, 'utf8') : '',
      svgPath,
      netlistPath,
      netlist,
      notebook,
      notebookPath,
      builtRevision: manifestModules[moduleId]?.revision,
      schematicOverrides: await exists(overridesPath)
        ? JSON.parse(await readFile(overridesPath, 'utf8')) as Record<string, unknown>
        : undefined,
    };
  }
  return { ...bundle, module_previews: previews };
}

function notifyProjectChanged(projectId: string): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('project:changed', { projectId, timestamp: Date.now() });
    }
  }, 120);
}

async function watchProject(projectId: string): Promise<void> {
  if (activeWatcher && watchedProjectId === projectId) return;
  activeWatcher?.close();
  activeWatcher = null;
  watchedProjectId = projectId;
  const root = await resolveProjectRoot(projectId);
  activeWatcher = watch(root, { recursive: true }, () => notifyProjectChanged(projectId));
}

export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('project:list', async () => listProjects());

  ipcMain.handle('project:create', async (_event, input: { name: string; demo?: boolean }) => {
    const root = await projectsRoot();
    return runProjectTool([
      input.demo ? 'create-demo' : 'create',
      '--projects-root', root,
      '--name', input.name,
    ]);
  });

  ipcMain.handle(
    'project:create-from-template',
    async (_event, input: { templateId: string; name?: string }) => createProjectFromTemplate(input),
  );

  ipcMain.handle('project:get', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    const bundle = await runProjectTool(['summary', '--project-root', root]);
    return enrichProjectBundle(root, bundle);
  });

  ipcMain.handle('project:apply-command', async (_event, projectId: string, command: unknown) => {
    return runProjectTool([
      'apply',
      '--project-root', await resolveProjectRoot(projectId),
      '--command-json', JSON.stringify(command),
    ]);
  });

  ipcMain.handle('project:compile', async (_event, projectId: string) => {
    return runProjectTool(['compile', '--project-root', await resolveProjectRoot(projectId)]);
  });

  ipcMain.handle('project:simulate', async (_event, projectId: string) => {
    const settings = await loadSettings();
    return runProjectTool([
      'simulate',
      '--project-root', await resolveProjectRoot(projectId),
      '--ngspice-bin', settings.ngspiceBin,
    ]);
  });

  ipcMain.handle('project:compile-module', async (_event, projectId: string, moduleId: string) => {
    assertModuleId(moduleId);
    return runProjectTool([
      'compile-module',
      '--project-root', await resolveProjectRoot(projectId),
      '--module-id', moduleId,
    ]);
  });

  ipcMain.handle(
    'project:save-module-notebook',
    async (_event, projectId: string, moduleId: string, markdown: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(moduleId)) {
        throw new Error(`Invalid module id: ${moduleId}`);
      }
      if (!/```(?:spice|cir|netlist)\s*\r?\n[\s\S]+?```/i.test(markdown)) {
        throw new Error('The notebook needs a fenced spice, cir, or netlist code block.');
      }
      const root = await resolveProjectRoot(projectId);
      const moduleRoot = path.resolve(root, 'modules', moduleId);
      const relative = path.relative(root, moduleRoot);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Invalid module path: ${moduleId}`);
      }
      await mkdir(moduleRoot, { recursive: true });
      await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), markdown, 'utf8');
      return runProjectTool([
        'compile-module',
        '--project-root', root,
        '--module-id', moduleId,
      ]);
    },
  );

  ipcMain.handle('project:simulate-module', async (_event, projectId: string, moduleId: string) => {
    assertModuleId(moduleId);
    const settings = await loadSettings();
    return runProjectTool([
      'simulate-module',
      '--project-root', await resolveProjectRoot(projectId),
      '--module-id', moduleId,
      '--ngspice-bin', settings.ngspiceBin,
    ]);
  });

  ipcMain.handle('project:read-build', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    const manifestPath = path.resolve(root, 'build', 'build-manifest.json');
    if (!(await exists(manifestPath))) return null;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const simulationPath = path.resolve(root, 'build', 'system', 'simulation', 'result.json');
    const reportPath = path.resolve(root, 'build', 'system', 'report.md');
    return {
      manifest,
      simulation: await exists(simulationPath)
        ? JSON.parse(await readFile(simulationPath, 'utf8')) as Record<string, unknown>
        : null,
      report: await exists(reportPath) ? await readFile(reportPath, 'utf8') : '',
    };
  });

  ipcMain.handle('project:save-design-template', async (_event, projectId: string) => {
    return saveDesignTemplate(projectId);
  });

  ipcMain.handle('project:save-design-flow', async (_event, projectId: string) => {
    return saveDesignFlow(projectId);
  });

  ipcMain.handle('project:list-design-memory', async () => {
    return listDesignMemory();
  });

  ipcMain.handle('project:open-design-memory', async (_event, input: { kind: 'template' | 'flow'; id: string }) => {
    const item = await findDesignMemoryItem(input.kind, input.id);
    return shell.openPath(item.rootPath);
  });

  ipcMain.handle('project:watch', async (_event, projectId: string) => {
    await watchProject(projectId);
  });

  ipcMain.on('project:open-folder', async (_event, projectId: string) => {
    await shell.openPath(await resolveProjectRoot(projectId));
  });
}

import { app, BrowserWindow, dialog, type IpcMain, shell } from 'electron';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { loadSettings, loadSettingsWithSecrets } from './settings.js';
import { getActiveWorkspace } from '../workspaceState.js';
import { generateDesktopTechnicalReport } from '../agent/desktopAgentService.js';

interface ProjectSummary {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  projectRoot: string;
  moduleCount: number;
}

interface TrashProjectSummary extends ProjectSummary {
  trashId: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
}

interface ProjectHistoryEntry {
  revision: number;
  baseRevision: number;
  actor: string;
  message: string;
  createdAt: string;
  documentHash?: string;
  restorable: boolean;
  buildStatus?: string;
  netlistDiff: { added: string[]; removed: string[] };
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

interface EdaExportRequest {
  scope: 'project' | 'module';
  moduleId?: string;
  targets: Array<'kicad' | 'altium' | 'orcad' | 'virtuoso'>;
  view: 'design' | 'simulation';
  mappingFile?: string;
  nativeConvert: 'auto' | 'never' | 'required';
  strictLayout: boolean;
  sourceRevision: number;
  /** Optional parent directory. Export is written to <outputDir>/<export_id>/. */
  outputDir?: string;
}

interface DesignMemoryItem {
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  sourceDocumentHash?: string;
  createdAt?: string;
  circuitFamilies?: string[];
  validationStatus?: string;
  preferredForAgentReuse?: boolean;
  simulationCoverage?: string[];
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
}

let activeWatcher: FSWatcher | null = null;
let watchedProjectId = '';
let watchTimer: NodeJS.Timeout | null = null;
let watchPollTimer: NodeJS.Timeout | null = null;
let watchedProjectRevision: number | null = null;
let watchPauseDepth = 0;
const legacyArchivePromises = new Map<string, Promise<void>>();

function pauseProjectWatcher(): void {
  watchPauseDepth += 1;
  if (watchPauseDepth === 1) {
    try {
      activeWatcher?.close();
    } catch {
      // ignore
    }
    activeWatcher = null;
  }
}

async function resumeProjectWatcher(): Promise<void> {
  watchPauseDepth = Math.max(0, watchPauseDepth - 1);
  if (watchPauseDepth > 0 || !watchedProjectId) return;
  await watchProject(watchedProjectId);
}

async function withProjectWatchPaused<T>(work: () => Promise<T>): Promise<T> {
  pauseProjectWatcher();
  try {
    return await work();
  } finally {
    await resumeProjectWatcher().catch((error) => {
      console.warn('project watcher resume failed:', error);
    });
  }
}

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

async function trashProjectsRoot(): Promise<string> {
  const workspace = await getActiveWorkspace();
  const root = path.resolve(workspace.root, '.trash', 'projects');
  await mkdir(root, { recursive: true });
  return root;
}

function assertDirectChild(root: string, candidate: string, id: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!id || !relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`Invalid project entry id: ${id}`);
  }
}

function stopProjectWatcher(projectId: string): void {
  if (watchedProjectId !== projectId) return;
  activeWatcher?.close();
  activeWatcher = null;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  if (watchPollTimer) clearInterval(watchPollTimer);
  watchPollTimer = null;
  watchedProjectId = '';
  watchedProjectRevision = null;
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
  await mkdir(path.dirname(targetRoot), { recursive: true });
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
  const agentContext = await runProjectTool(['agent-context', '--project-root', projectRoot]);
  const erc = agentContext.erc as {
    status?: string;
    summary?: { errors?: number; warnings?: number };
    document_hash?: string;
  } | undefined;
  const simulation = agentContext.simulation as {
    state?: string;
    run?: {
      ok?: boolean;
      specification_status?: string;
      analyses?: Array<{ type?: string; status?: string }>;
    } | null;
  } | undefined;
  const circuitFamilies = [...new Set((project.modules as Array<{ kind?: string }> | undefined ?? [])
    .map((module) => module.kind)
    .filter((kind): kind is string => Boolean(kind)))];
  const simulationCoverage = [...new Set((simulation?.run?.analyses ?? [])
    .filter((analysis) => analysis.status === 'completed')
    .map((analysis) => analysis.type)
    .filter((type): type is string => Boolean(type)))];
  const specificationPassed = ['pass', 'passed'].includes(simulation?.run?.specification_status ?? '');
  const simulationPassed = simulation?.state === 'current' && simulation.run?.ok === true;
  const ercClean = (erc?.summary?.errors ?? 0) === 0;
  const validationStatus = specificationPassed && simulationPassed && ercClean
    ? 'verified'
    : simulationPassed && ercClean ? 'simulated' : ercClean ? 'erc_clean' : 'unverified';

  await copyFile(path.resolve(projectRoot, 'project.circuit.json'), path.resolve(targetRoot, 'project.circuit.json'));
  await copyDirectoryIfExists(path.resolve(projectRoot, 'modules'), path.resolve(targetRoot, 'modules'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'build-manifest.json'), path.resolve(targetRoot, 'build-manifest.json'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'erc.json'), path.resolve(targetRoot, 'erc.json'));
  await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json'),
    path.resolve(targetRoot, 'simulation-result.json'),
  );
  const hasSystemNetlist = await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'design.final.cir'),
    path.resolve(targetRoot, 'template.cir'),
  );
  const hasReport = await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'report.md'),
    path.resolve(targetRoot, 'source-report.md'),
  );

  const manifest = {
    schema: 'actoviq.design-template.v2',
    id: memoryId,
    name: project.name,
    source_project_id: project.project_id,
    source_revision: project.revision,
    source_document_hash: agentContext.document_hash,
    created_at: new Date().toISOString(),
    applicability: {
      circuit_families: circuitFamilies,
      parameter_summary: (project.modules as Array<{ id?: string; parameters?: Record<string, string> }> | undefined ?? [])
        .map((module) => ({ module_id: module.id, parameters: module.parameters ?? {} })),
    },
    validation: {
      status: validationStatus,
      preferred_for_agent_reuse: validationStatus === 'verified',
      erc_status: erc?.status ?? 'unknown',
      erc_summary: erc?.summary ?? null,
      simulation_state: simulation?.state ?? 'missing',
      simulation_coverage: simulationCoverage,
      specification_status: simulation?.run?.specification_status ?? 'not_evaluated',
    },
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
  const agentContext = await runProjectTool(['agent-context', '--project-root', projectRoot]);
  const erc = agentContext.erc as { status?: string; summary?: { errors?: number; warnings?: number } } | undefined;
  const simulation = agentContext.simulation as {
    state?: string;
    run?: { ok?: boolean; specification_status?: string; analyses?: Array<{ type?: string; status?: string }> } | null;
  } | undefined;
  const simulationCoverage = [...new Set((simulation?.run?.analyses ?? [])
    .filter((analysis) => analysis.status === 'completed')
    .map((analysis) => analysis.type)
    .filter((type): type is string => Boolean(type)))];
  const specificationPassed = ['pass', 'passed'].includes(simulation?.run?.specification_status ?? '');
  const simulationPassed = simulation?.state === 'current' && simulation.run?.ok === true;
  const ercClean = (erc?.summary?.errors ?? 0) === 0;
  const validationStatus = specificationPassed && simulationPassed && ercClean
    ? 'verified'
    : simulationPassed && ercClean ? 'simulated' : ercClean ? 'erc_clean' : 'unverified';

  await copyDirectoryIfExists(path.resolve(projectRoot, 'commands', 'applied'), path.resolve(targetRoot, 'commands', 'applied'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'build-manifest.json'), path.resolve(targetRoot, 'build-manifest.json'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'erc.json'), path.resolve(targetRoot, 'erc.json'));
  await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json'),
    path.resolve(targetRoot, 'simulation-result.json'),
  );
  const flowPath = path.resolve(targetRoot, 'design-flow.md');
  const manifest = {
    schema: 'actoviq.design-flow.v2',
    id: memoryId,
    name: project.name,
    source_project_id: project.project_id,
    source_revision: project.revision,
    source_document_hash: agentContext.document_hash,
    created_at: new Date().toISOString(),
    command_count: commands.length,
    applicability: {
      circuit_families: [...new Set((project.modules as Array<{ kind?: string }> | undefined ?? [])
        .map((module) => module.kind)
        .filter((kind): kind is string => Boolean(kind)))],
    },
    validation: {
      status: validationStatus,
      preferred_for_agent_reuse: validationStatus === 'verified',
      erc_status: erc?.status ?? 'unknown',
      erc_summary: erc?.summary ?? null,
      simulation_state: simulation?.state ?? 'missing',
      simulation_coverage: simulationCoverage,
      specification_status: simulation?.run?.specification_status ?? 'not_evaluated',
    },
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
        source_document_hash?: string;
        created_at?: string;
        files?: Record<string, string | null>;
        applicability?: { circuit_families?: string[] };
        validation?: {
          status?: string;
          preferred_for_agent_reuse?: boolean;
          simulation_coverage?: string[];
        };
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
        sourceDocumentHash: manifest.source_document_hash,
        createdAt: manifest.created_at || fallbackStat.mtime.toISOString(),
        circuitFamilies: manifest.applicability?.circuit_families ?? [],
        validationStatus: manifest.validation?.status ?? 'legacy_unverified',
        preferredForAgentReuse: manifest.validation?.preferred_for_agent_reuse ?? false,
        simulationCoverage: manifest.validation?.simulation_coverage ?? [],
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

async function readOptionalJson(targetPath: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(targetPath))) return null;
  try {
    return JSON.parse(await readFile(targetPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readOptionalText(targetPath: string): Promise<string> {
  return await exists(targetPath) ? readFile(targetPath, 'utf8') : '';
}

async function generateProjectTechnicalReport(projectId: string, sourceRevision: number): Promise<{
  ok: true;
  report: string;
  metadata: Record<string, unknown>;
}> {
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<Record<string, unknown>>(path.resolve(projectRoot, 'project.circuit.json'));
  const currentRevision = Number(project.revision);
  if (!Number.isInteger(sourceRevision) || sourceRevision < 0 || currentRevision !== sourceRevision) {
    throw new Error(`Stale report request: expected project revision ${currentRevision}, received ${sourceRevision}.`);
  }

  const buildRoot = path.resolve(projectRoot, 'build');
  const manifest = await readOptionalJson(path.resolve(buildRoot, 'build-manifest.json'));
  if (!manifest) throw new Error('Compile the project before generating a technical report.');
  const buildRevision = Number(manifest.source_revision ?? manifest.revision);
  if (buildRevision !== currentRevision) {
    throw new Error(`Build is stale: project revision ${currentRevision}, build revision ${buildRevision}.`);
  }

  const [agentContext, erc, simulation, sourceMap, netlist, baselineReport] = await Promise.all([
    runProjectTool(['agent-context', '--project-root', projectRoot]),
    readOptionalJson(path.resolve(buildRoot, 'erc.json')),
    readOptionalJson(path.resolve(buildRoot, 'system', 'simulation', 'result.json')),
    readOptionalJson(path.resolve(buildRoot, 'system', 'source-map.json')),
    readOptionalText(path.resolve(buildRoot, 'system', 'design.final.cir')),
    readOptionalText(path.resolve(buildRoot, 'system', 'report.md')),
  ]);
  const documentHash = typeof agentContext.document_hash === 'string'
    ? agentContext.document_hash
    : typeof manifest.document_hash === 'string' ? manifest.document_hash : undefined;
  const settings = await loadSettingsWithSecrets();
  if (!settings.actoviqAuthToken) {
    throw new Error('Configure an API key before generating an AI technical report.');
  }

  const generated = await generateDesktopTechnicalReport({
    provider: settings.actoviqProvider,
    apiKey: settings.actoviqAuthToken,
    baseURL: settings.actoviqBaseUrl,
    model: settings.reasoningModel || settings.chatModel,
    workDir: projectRoot,
  }, {
    projectId,
    sourceRevision,
    documentHash,
    evidence: {
      project,
      build_manifest: manifest,
      agent_context: agentContext,
      erc,
      simulation,
      source_map: sourceMap,
      compiled_netlist: netlist,
      deterministic_report: baselineReport,
    },
  });
  const reportPath = path.resolve(buildRoot, 'system', 'technical-report.md');
  const metadataPath = path.resolve(buildRoot, 'system', 'technical-report.json');
  const metadata = {
    schema: 'actoviq.technical-report.v1',
    project_id: projectId,
    source_revision: sourceRevision,
    document_hash: documentHash,
    generated_at: new Date().toISOString(),
    generator: 'actoviq-agent-sdk',
    model: generated.model,
    run_id: generated.runId,
    report_sha256: createHash('sha256').update(generated.report).digest('hex'),
    usage: generated.usage,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${generated.report.trim()}\n`, 'utf8');
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { ok: true, report: generated.report, metadata };
}

async function readProjectSummary(projectRoot: string): Promise<ProjectSummary> {
  const project = JSON.parse(
    await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'),
  ) as {
    project_id: string;
    name: string;
    revision: number;
    updated_at?: string;
    modules?: unknown[];
  };
  return {
    projectId: project.project_id,
    name: project.name,
    revision: project.revision,
    updatedAt: project.updated_at ?? '',
    projectRoot,
    moduleCount: project.modules?.length ?? 0,
  };
}

async function uniqueTrashTarget(root: string, projectId: string): Promise<{ trashId: string; trashPath: string }> {
  const base = `${timestampForId()}-${projectId}`;
  let trashId = base;
  let suffix = 2;
  while (await exists(path.resolve(root, trashId))) {
    trashId = `${base}-${suffix}`;
    suffix += 1;
  }
  const trashPath = path.resolve(root, trashId);
  assertDirectChild(root, trashPath, trashId);
  return { trashId, trashPath };
}

async function moveProjectToTrash(projectId: string): Promise<TrashProjectSummary> {
  const projectRoot = await resolveProjectRoot(projectId);
  const summary = await readProjectSummary(projectRoot);
  const root = await trashProjectsRoot();
  const { trashId, trashPath } = await uniqueTrashTarget(root, projectId);
  const deletedAt = new Date().toISOString();
  stopProjectWatcher(projectId);
  await rename(projectRoot, trashPath);
  const item: TrashProjectSummary = {
    ...summary,
    projectRoot: trashPath,
    trashId,
    deletedAt,
    originalPath: projectRoot,
    trashPath,
  };
  try {
    await writeFile(path.resolve(trashPath, 'trash.json'), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  } catch (error) {
    await rename(trashPath, projectRoot).catch(() => undefined);
    throw error;
  }
  return item;
}

async function archiveLegacyPlaywrightProjects(): Promise<void> {
  const root = await projectsRoot();
  const existing = legacyArchivePromises.get(root);
  if (existing) return existing;
  const migration = (async () => {
    const trashRoot = await trashProjectsRoot();
    const markerPath = path.resolve(trashRoot, '..', 'legacy-playwright-projects-v1.json');
    if (await exists(markerPath)) return;
    const archived: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectRoot = path.resolve(root, entry.name);
      try {
        const summary = await readProjectSummary(projectRoot);
        if (!/^Playwright Keyboard Project \d+$/.test(summary.name)) continue;
        await moveProjectToTrash(summary.projectId);
        archived.push(summary.projectId);
      } catch {
        // Ignore invalid projects and continue migrating exact test fixtures.
      }
    }
    await writeFile(markerPath, `${JSON.stringify({ migratedAt: new Date().toISOString(), archived }, null, 2)}\n`, 'utf8');
  })();
  legacyArchivePromises.set(root, migration);
  return migration;
}

async function listTrashProjects(): Promise<TrashProjectSummary[]> {
  const root = await trashProjectsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const items: TrashProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const trashPath = path.resolve(root, entry.name);
    try {
      const metadataPath = path.resolve(trashPath, 'trash.json');
      const metadata = await exists(metadataPath)
        ? await readJsonFile<TrashProjectSummary>(metadataPath)
        : null;
      const summary = await readProjectSummary(trashPath);
      items.push({
        ...summary,
        trashId: entry.name,
        deletedAt: metadata?.deletedAt ?? summary.updatedAt,
        originalPath: metadata?.originalPath ?? path.resolve(await projectsRoot(), summary.projectId),
        trashPath,
      });
    } catch {
      // Ignore incomplete trash entries instead of exposing unsafe restore actions.
    }
  }
  return items.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

async function resolveTrashProject(trashId: string): Promise<string> {
  const root = await trashProjectsRoot();
  const candidate = path.resolve(root, String(trashId ?? '').trim());
  assertDirectChild(root, candidate, trashId);
  if (!(await exists(path.resolve(candidate, 'project.circuit.json')))) {
    throw new Error(`Trashed project not found: ${trashId}`);
  }
  return candidate;
}

async function restoreTrashProjects(trashIds: string[]): Promise<ProjectSummary[]> {
  const root = await projectsRoot();
  const restored: ProjectSummary[] = [];
  for (const trashId of [...new Set(trashIds)]) {
    const trashPath = await resolveTrashProject(trashId);
    const summary = await readProjectSummary(trashPath);
    const target = path.resolve(root, summary.projectId);
    assertDirectChild(root, target, summary.projectId);
    if (await exists(target)) {
      throw new Error(`Cannot restore ${summary.name}: project id ${summary.projectId} already exists.`);
    }
    await rename(trashPath, target);
    await rm(path.resolve(target, 'trash.json'), { force: true });
    restored.push(await readProjectSummary(target));
  }
  return restored;
}

async function purgeTrashProjects(trashIds: string[]): Promise<void> {
  for (const trashId of [...new Set(trashIds)]) {
    const trashPath = await resolveTrashProject(trashId);
    await rm(trashPath, { recursive: true, force: true });
  }
}

function spiceLines(markdown: string): string[] {
  const matches = [...markdown.matchAll(/```(?:spice|cir|netlist)\s*\r?\n([\s\S]*?)```/gi)];
  const source = matches.length > 0 ? matches.map((match) => match[1]).join('\n') : markdown;
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function snapshotNetlistLines(snapshotRoot: string): Promise<string[]> {
  const projectPath = path.resolve(snapshotRoot, 'project.circuit.json');
  if (!(await exists(projectPath))) return [];
  const project = await readJsonFile<{ modules?: Array<{ id?: string }> }>(projectPath);
  const lines: string[] = [];
  for (const module of project.modules ?? []) {
    if (!module.id) continue;
    const notebookPath = path.resolve(snapshotRoot, 'modules', module.id, 'netlist-notebook.md');
    if (await exists(notebookPath)) lines.push(...spiceLines(await readFile(notebookPath, 'utf8')));
  }
  return lines;
}

function netlistDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const line of before) beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  for (const line of after) afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, count] of afterCounts) {
    for (let index = beforeCounts.get(line) ?? 0; index < count && added.length < 40; index += 1) added.push(line);
  }
  for (const [line, count] of beforeCounts) {
    for (let index = afterCounts.get(line) ?? 0; index < count && removed.length < 40; index += 1) removed.push(line);
  }
  return { added, removed };
}

async function listProjectHistory(projectId: string): Promise<ProjectHistoryEntry[]> {
  const projectRoot = await resolveProjectRoot(projectId);
  const revisionsRoot = path.resolve(projectRoot, 'revisions');
  const entries = await readdir(revisionsRoot, { withFileTypes: true }).catch(() => []);
  let buildRevision: number | undefined;
  let buildStatus: string | undefined;
  try {
    const manifest = await readJsonFile<{ source_revision?: number; revision?: number; status?: string }>(
      path.resolve(projectRoot, 'build', 'build-manifest.json'),
    );
    buildRevision = manifest.source_revision ?? manifest.revision;
    buildStatus = manifest.status;
  } catch {
    // History remains available before the first build.
  }
  const history: ProjectHistoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{6}$/.test(entry.name)) continue;
    const revisionRoot = path.resolve(revisionsRoot, entry.name);
    try {
      const metadata = await readJsonFile<{
        revision: number;
        base_revision?: number;
        actor?: string;
        message?: string;
        created_at?: string;
        document_hash?: string;
      }>(path.resolve(revisionRoot, 'metadata.json'));
      const resultRoot = path.resolve(revisionRoot, 'result');
      const [before, after] = await Promise.all([
        snapshotNetlistLines(path.resolve(revisionRoot, 'snapshot')),
        snapshotNetlistLines(resultRoot),
      ]);
      history.push({
        revision: metadata.revision,
        baseRevision: metadata.base_revision ?? Math.max(0, metadata.revision - 1),
        actor: metadata.actor ?? 'unknown',
        message: metadata.message ?? '',
        createdAt: metadata.created_at ?? '',
        documentHash: metadata.document_hash,
        restorable: await exists(path.resolve(resultRoot, 'project.circuit.json')),
        buildStatus: buildRevision === metadata.revision ? buildStatus : undefined,
        netlistDiff: netlistDiff(before, after),
      });
    } catch {
      // Ignore incomplete revision folders while an external transaction is being written.
    }
  }
  return history.sort((left, right) => right.revision - left.revision);
}

async function readSimulationDataset(
  projectId: string,
  input: {
    runId: string;
    analysisId: string;
    moduleId?: string;
    maxPoints?: number;
    xMin?: number;
    xMax?: number;
  },
): Promise<Record<string, unknown>> {
  const projectRoot = await resolveProjectRoot(projectId);
  if (!/^[A-Za-z0-9_.:-]+$/.test(input.runId) || !/^[A-Za-z0-9_.:-]+$/.test(input.analysisId)) {
    throw new Error('Invalid simulation dataset identifier.');
  }
  const simulationRoot = input.moduleId
    ? path.resolve(projectRoot, 'build', 'modules', assertModuleId(input.moduleId), 'simulation')
    : path.resolve(projectRoot, 'build', 'system', 'simulation');
  const result = await readJsonFile<{
    run_id?: string;
    analyses?: Array<{ id?: string; dataset?: { path?: string } | null }>;
  }>(path.resolve(simulationRoot, 'result.json'));
  if (result.run_id !== input.runId) throw new Error(`Simulation run is stale or unavailable: ${input.runId}`);
  const analysis = result.analyses?.find((entry) => entry.id === input.analysisId);
  const relativeDatasetPath = analysis?.dataset?.path;
  if (!relativeDatasetPath) throw new Error(`Simulation analysis has no dataset: ${input.analysisId}`);
  const datasetPath = path.resolve(simulationRoot, relativeDatasetPath);
  const relative = path.relative(simulationRoot, datasetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Simulation dataset path escapes its run.');
  const dataset = await readJsonFile<{
    x?: { values?: number[] };
    traces?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }>(datasetPath);
  const xValues = dataset.x?.values ?? [];
  let indices = xValues.map((_value, index) => index).filter((index) => (
    (input.xMin === undefined || xValues[index]! >= input.xMin) &&
    (input.xMax === undefined || xValues[index]! <= input.xMax)
  ));
  const maxPoints = Math.max(50, Math.min(5000, Math.floor(input.maxPoints ?? 1200)));
  if (indices.length > maxPoints) {
    const source = indices;
    indices = Array.from({ length: maxPoints }, (_value, index) => (
      source[Math.round(index * (source.length - 1) / (maxPoints - 1))]!
    ));
  }
  const selectValues = (value: unknown): unknown => (
    Array.isArray(value) && value.length === xValues.length
      ? indices.map((index) => value[index])
      : value
  );
  return {
    ...dataset,
    point_count: indices.length,
    total_point_count: xValues.length,
    x: dataset.x ? { ...dataset.x, values: indices.map((index) => xValues[index]) } : dataset.x,
    traces: (dataset.traces ?? []).map((trace) => Object.fromEntries(
      Object.entries(trace).map(([key, value]) => [key, selectValues(value)]),
    )),
  };
}

async function listProjects(): Promise<ProjectSummary[]> {
  await archiveLegacyPlaywrightProjects();
  const root = await projectsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(root, entry.name);
    try {
      projects.push(await readProjectSummary(projectRoot));
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
      schematicOverrides: await readOptionalJson(overridesPath) ?? undefined,
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

function normalizeAtomicSourcePath(relativePath: string): string {
  return relativePath.replace(
    /(^|\/)\.(project\.circuit\.json|module\.circuit\.json|netlist-notebook\.md|schematic\.overrides\.json)\.[^/]+\.tmp$/,
    '$1$2',
  );
}

async function watchProject(projectId: string): Promise<void> {
  if (watchPauseDepth > 0) {
    watchedProjectId = projectId;
    return;
  }
  if (activeWatcher && watchedProjectId === projectId) return;
  activeWatcher?.close();
  activeWatcher = null;
  if (watchPollTimer) clearInterval(watchPollTimer);
  watchPollTimer = null;
  watchedProjectId = projectId;
  const root = await resolveProjectRoot(projectId);
  try {
    const initial = JSON.parse(await readFile(path.join(root, 'project.circuit.json'), 'utf8')) as { revision?: number };
    watchedProjectRevision = typeof initial.revision === 'number' ? initial.revision : null;
  } catch {
    watchedProjectRevision = null;
  }
  activeWatcher = watch(root, { recursive: true }, (_eventType, filename) => {
    try {
      const relative = normalizeAtomicSourcePath(String(filename ?? '').replace(/\\/g, '/'));
      if (!relative || relative.startsWith('build/') || relative.startsWith('commands/') ||
          relative.startsWith('revisions/') || relative.startsWith('logs/')) return;
      if (relative !== 'project.circuit.json' &&
          !/modules\/[^/]+\/(?:module\.circuit\.json|netlist-notebook\.md|schematic\.overrides\.json)$/.test(relative)) return;
      notifyProjectChanged(projectId);
    } catch (error) {
      // Keep the desktop alive if a watcher callback fails mid-compile/reload.
      console.warn(`project watch callback failed for ${projectId}:`, error);
    }
  });
  // Windows recursive watchers can emit 'error' when compile writes many build/
  // artifacts quickly (buffer overflow / EPERM on synced disks). Unhandled
  // EventEmitter errors would otherwise terminate the Electron main process.
  activeWatcher.on('error', (error) => {
    console.warn(`project watcher error for ${projectId}:`, error);
    if (watchedProjectId !== projectId) return;
    try {
      activeWatcher?.close();
    } catch {
      // ignore close failures while recovering
    }
    activeWatcher = null;
    // Best-effort resubscribe after the burst of filesystem activity settles.
    setTimeout(() => {
      if (watchedProjectId !== projectId || activeWatcher || watchPauseDepth > 0) return;
      void watchProject(projectId).catch((restartError) => {
        console.warn(`project watcher restart failed for ${projectId}:`, restartError);
      });
    }, 1_000);
  });
  watchPollTimer = setInterval(() => {
    void (async () => {
      if (watchedProjectId !== projectId) return;
      try {
        const current = JSON.parse(await readFile(path.join(root, 'project.circuit.json'), 'utf8')) as { revision?: number };
        if (typeof current.revision !== 'number' || current.revision === watchedProjectRevision) return;
        watchedProjectRevision = current.revision;
        notifyProjectChanged(projectId);
      } catch {
        // The watcher will retry on its next interval while an atomic replace is in flight.
      }
    })();
  }, 500);
}

export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('project:list', async () => listProjects());

  ipcMain.handle('project:trash', async (_event, projectIds: string[]) => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      throw new Error('Select at least one project to move to trash.');
    }
    const trashed: TrashProjectSummary[] = [];
    for (const projectId of [...new Set(projectIds)]) {
      trashed.push(await moveProjectToTrash(projectId));
    }
    return trashed;
  });

  ipcMain.handle('project:list-trash', async () => {
    await archiveLegacyPlaywrightProjects();
    return listTrashProjects();
  });

  ipcMain.handle('project:restore-trash', async (_event, trashIds: string[]) => {
    if (!Array.isArray(trashIds) || trashIds.length === 0) {
      throw new Error('Select at least one trashed project to restore.');
    }
    return restoreTrashProjects(trashIds);
  });

  ipcMain.handle('project:purge-trash', async (_event, trashIds: string[]) => {
    if (!Array.isArray(trashIds) || trashIds.length === 0) {
      throw new Error('Select at least one trashed project to purge.');
    }
    await purgeTrashProjects(trashIds);
  });

  ipcMain.handle('project:list-history', async (_event, projectId: string) => {
    return listProjectHistory(projectId);
  });

  ipcMain.handle(
    'project:restore-revision',
    async (_event, projectId: string, revision: number, baseRevision: number) => {
      if (!Number.isInteger(revision) || revision < 1) throw new Error(`Invalid revision: ${revision}`);
      const root = await resolveProjectRoot(projectId);
      const result = await runProjectTool([
        'apply',
        '--project-root', root,
        '--command-json', JSON.stringify({
          schema: 'actoviq.command.v1',
          command_id: `restore-${revision}-${Date.now()}`,
          actor: 'user',
          project_id: projectId,
          base_revision: baseRevision,
          message: `Restore revision ${revision}`,
          operations: [{ op: 'restore_revision', revision }],
        }),
      ]);
      const build = await withProjectWatchPaused(async () => (
        runProjectTool(['compile', '--project-root', root])
      ));
      return { ...result, build };
    },
  );

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

  ipcMain.handle('project:run-erc', async (_event, projectId: string) => {
    return runProjectTool(['erc', '--project-root', await resolveProjectRoot(projectId)]);
  });

  ipcMain.handle('project:agent-context', async (_event, projectId: string) => {
    return runProjectTool(['agent-context', '--project-root', await resolveProjectRoot(projectId)]);
  });

  ipcMain.handle('project:compile', async (_event, projectId: string) => {
    return withProjectWatchPaused(async () => (
      runProjectTool(['compile', '--project-root', await resolveProjectRoot(projectId)])
    ));
  });

  ipcMain.handle('project:export-eda', async (_event, projectId: string, input: EdaExportRequest) => {
    const root = await resolveProjectRoot(projectId);
    if (input.scope === 'module') assertModuleId(input.moduleId ?? '');
    const allowedTargets = new Set(['kicad', 'altium', 'orcad', 'virtuoso']);
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.some((target) => !allowedTargets.has(target))) {
      throw new Error('Select at least one supported EDA target.');
    }
    if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) {
      throw new Error(`Invalid source revision: ${input.sourceRevision}`);
    }
    const args = [
      'export-eda', '--project-root', root,
      '--scope', input.scope,
      '--targets', [...new Set(input.targets)].join(','),
      '--view', input.view,
      '--native-convert', input.nativeConvert,
      '--source-revision', String(input.sourceRevision),
    ];
    if (input.scope === 'module') args.push('--module-id', input.moduleId ?? '');
    if (input.mappingFile?.trim()) args.push('--mapping-file', path.resolve(input.mappingFile.trim()));
    if (input.outputDir?.trim()) args.push('--output-dir', path.resolve(input.outputDir.trim()));
    if (input.strictLayout) args.push('--strict-layout');
    return runProjectTool(args);
  });

  ipcMain.handle('project:choose-eda-mapping', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Actoviq EDA symbol mapping',
      properties: ['openFile'],
      filters: [{ name: 'JSON mapping', extensions: ['json'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:choose-eda-output-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select EDA export folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:simulate', async (_event, projectId: string) => {
    const settings = await loadSettings();
    return withProjectWatchPaused(async () => (
      runProjectTool([
        'simulate',
        '--project-root', await resolveProjectRoot(projectId),
        '--ngspice-bin', settings.ngspiceBin,
      ])
    ));
  });

  ipcMain.handle(
    'project:generate-technical-report',
    async (_event, projectId: string, sourceRevision: number) => (
      generateProjectTechnicalReport(projectId, sourceRevision)
    ),
  );

  ipcMain.handle('project:compile-module', async (_event, projectId: string, moduleId: string) => {
    assertModuleId(moduleId);
    return withProjectWatchPaused(async () => (
      runProjectTool([
        'compile-module',
        '--project-root', await resolveProjectRoot(projectId),
        '--module-id', moduleId,
      ])
    ));
  });

  ipcMain.handle(
    'project:save-module-notebook',
    async (_event, projectId: string, moduleId: string, markdown: string, baseRevision?: number) => {
      if (!/^[A-Za-z0-9_-]+$/.test(moduleId)) {
        throw new Error(`Invalid module id: ${moduleId}`);
      }
      if (!/```(?:spice|cir|netlist)\s*\r?\n[\s\S]+?```/i.test(markdown)) {
        throw new Error('The notebook needs a fenced spice, cir, or netlist code block.');
      }
      const root = await resolveProjectRoot(projectId);
      const project = await readJsonFile<{ revision: number }>(path.resolve(root, 'project.circuit.json'));
      await runProjectTool([
        'apply',
        '--project-root', root,
        '--command-json', JSON.stringify({
          schema: 'actoviq.command.v1',
          command_id: `netlist-${Date.now()}`,
          actor: 'user',
          project_id: projectId,
          base_revision: baseRevision ?? project.revision,
          message: `Edit module netlist ${moduleId}`,
          operations: [{ op: 'set_module_netlist', module_id: moduleId, netlist_notebook: markdown }],
        }),
      ]);
      return withProjectWatchPaused(async () => (
        runProjectTool([
          'compile-module',
          '--project-root', root,
          '--module-id', moduleId,
        ])
      ));
    },
  );

  ipcMain.handle('project:simulate-module', async (_event, projectId: string, moduleId: string) => {
    assertModuleId(moduleId);
    const settings = await loadSettings();
    return withProjectWatchPaused(async () => (
      runProjectTool([
        'simulate-module',
        '--project-root', await resolveProjectRoot(projectId),
        '--module-id', moduleId,
        '--ngspice-bin', settings.ngspiceBin,
      ])
    ));
  });

  ipcMain.handle('project:read-build', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    const manifestPath = path.resolve(root, 'build', 'build-manifest.json');
    if (!(await exists(manifestPath))) return null;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const simulationPath = path.resolve(root, 'build', 'system', 'simulation', 'result.json');
    const ercPath = path.resolve(root, 'build', 'erc.json');
    const sourceMapPath = path.resolve(root, 'build', 'system', 'source-map.json');
    const reportPath = path.resolve(root, 'build', 'system', 'report.md');
    const technicalReportPath = path.resolve(root, 'build', 'system', 'technical-report.md');
    const technicalReportMetadataPath = path.resolve(root, 'build', 'system', 'technical-report.json');
    const technicalReportMetadata = await readOptionalJson(technicalReportMetadataPath);
    const manifestRevision = Number(manifest.source_revision ?? manifest.revision);
    const technicalReportCurrent = technicalReportMetadata?.source_revision === manifestRevision
      && (!manifest.document_hash || technicalReportMetadata.document_hash === manifest.document_hash);
    return {
      manifest,
      erc: await exists(ercPath)
        ? JSON.parse(await readFile(ercPath, 'utf8')) as Record<string, unknown>
        : null,
      simulation: await exists(simulationPath)
        ? JSON.parse(await readFile(simulationPath, 'utf8')) as Record<string, unknown>
        : null,
      sourceMap: await exists(sourceMapPath)
        ? JSON.parse(await readFile(sourceMapPath, 'utf8')) as Record<string, unknown>
        : null,
      report: technicalReportCurrent && await exists(technicalReportPath)
        ? await readFile(technicalReportPath, 'utf8')
        : await exists(reportPath) ? await readFile(reportPath, 'utf8') : '',
      technicalReport: technicalReportCurrent ? technicalReportMetadata : null,
    };
  });

  ipcMain.handle(
    'project:read-simulation-dataset',
    async (_event, projectId: string, input: Parameters<typeof readSimulationDataset>[1]) => (
      readSimulationDataset(projectId, input)
    ),
  );

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

  ipcMain.handle('project:open-folder', async (_event, projectId: string) => {
    const projectRoot = await resolveProjectRoot(projectId);
    if (process.env.ACTOVIQ_E2E !== '1') {
      const error = await shell.openPath(projectRoot);
      if (error) throw new Error(error);
    }
    return projectRoot;
  });

  ipcMain.handle('project:open-export-folder', async (
    _event,
    projectId: string,
    exportId: string,
    exportRoot?: string,
  ) => {
    if (!/^[A-Za-z0-9_-]+$/.test(exportId)) throw new Error(`Invalid export id: ${exportId}`);
    const projectRoot = await resolveProjectRoot(projectId);
    const defaultRoot = path.resolve(projectRoot, 'build', 'exports', exportId);
    const candidate = typeof exportRoot === 'string' && exportRoot.trim()
      ? path.resolve(exportRoot.trim())
      : defaultRoot;
    if (path.basename(candidate) !== exportId) {
      throw new Error(`EDA export path does not match export id: ${exportId}`);
    }
    if (!(await exists(candidate))) {
      throw new Error(`EDA export not found: ${exportId}`);
    }
    if (process.env.ACTOVIQ_E2E !== '1') {
      const error = await shell.openPath(candidate);
      if (error) throw new Error(error);
    }
    return candidate;
  });
}

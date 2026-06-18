import { app, BrowserWindow, type IpcMain, shell } from 'electron';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

  ipcMain.handle('project:watch', async (_event, projectId: string) => {
    await watchProject(projectId);
  });

  ipcMain.on('project:open-folder', async (_event, projectId: string) => {
    await shell.openPath(await resolveProjectRoot(projectId));
  });
}

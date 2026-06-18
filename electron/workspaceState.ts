import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(currentDir, '..');
const settingsDir = path.resolve(homedir(), '.actoviq');
const workspaceConfigPath = path.resolve(settingsDir, 'actoviq-circuit-agent-workspaces.json');
const defaultWorkspaceRoot = path.resolve(PROJECT_ROOT, 'workspace', 'workspaces', 'default');

export interface WorkspaceSummary {
  id: string;
  name: string;
  root: string;
  jobsDir: string;
  projectsDir: string;
  referencesDir: string;
  createdAt: string;
  lastOpenedAt: string;
}

interface WorkspaceConfig {
  activeWorkspaceId: string;
  workspaces: WorkspaceSummary[];
}

export interface ReferenceDocument {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
  ocrTextPath?: string;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'workspace';
}

function buildWorkspace(id: string, name: string, root: string, createdAt = new Date().toISOString()): WorkspaceSummary {
  const normalizedRoot = path.resolve(root);
  return {
    id,
    name,
    root: normalizedRoot,
    jobsDir: path.resolve(normalizedRoot, 'jobs'),
    projectsDir: path.resolve(normalizedRoot, 'projects'),
    referencesDir: path.resolve(normalizedRoot, 'references'),
    createdAt,
    lastOpenedAt: createdAt,
  };
}

async function ensureWorkspaceDirs(workspace: WorkspaceSummary): Promise<void> {
  await Promise.all([
    mkdir(workspace.root, { recursive: true }),
    mkdir(workspace.jobsDir, { recursive: true }),
    mkdir(workspace.projectsDir, { recursive: true }),
    mkdir(workspace.referencesDir, { recursive: true }),
  ]);
  const markerPath = path.resolve(workspace.root, '.actoviq-workspace.json');
  if (!(await exists(markerPath))) {
    await writeFile(
      markerPath,
      `${JSON.stringify({
        version: 'actoviq.workspace.v1',
        id: workspace.id,
        name: workspace.name,
        jobsDir: 'jobs',
        projectsDir: 'projects',
        referencesDir: 'references',
      }, null, 2)}\n`,
      'utf8',
    );
  }
}

async function readConfig(): Promise<WorkspaceConfig> {
  try {
    const parsed = JSON.parse(await readFile(workspaceConfigPath, 'utf8')) as WorkspaceConfig;
    if (Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
      const workspaces = parsed.workspaces.map((workspace) =>
        buildWorkspace(
          workspace.id,
          workspace.name,
          workspace.root,
          workspace.createdAt,
        ),
      );
      const activeWorkspaceId = workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : workspaces[0]!.id;
      return { activeWorkspaceId, workspaces };
    }
  } catch {
    // Create a default config below.
  }

  const workspace = buildWorkspace('default', 'Default Workspace', defaultWorkspaceRoot);
  return {
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
  };
}

async function persistConfig(config: WorkspaceConfig): Promise<void> {
  await mkdir(settingsDir, { recursive: true });
  await writeFile(workspaceConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function writeConfig(config: WorkspaceConfig): Promise<void> {
  await Promise.all(config.workspaces.map(ensureWorkspaceDirs));
  await persistConfig(config);
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const config = await readConfig();
  await Promise.all(config.workspaces.map(ensureWorkspaceDirs));
  // Persist only on first-run defaulting; reads must not rewrite the config file.
  if (!(await exists(workspaceConfigPath))) {
    await persistConfig(config);
  }
  return config.workspaces;
}

export async function getActiveWorkspace(): Promise<WorkspaceSummary> {
  const config = await readConfig();
  const active = config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ?? config.workspaces[0];
  if (!active) {
    throw new Error('No workspace is configured.');
  }
  await ensureWorkspaceDirs(active);
  if (!(await exists(workspaceConfigPath))) {
    await persistConfig(config);
  }
  return active;
}

export async function getActiveWorkspaceRoot(): Promise<string> {
  return (await getActiveWorkspace()).root;
}

export async function createWorkspace(input: { name?: string; root?: string }): Promise<WorkspaceSummary> {
  const config = await readConfig();
  const now = new Date().toISOString();
  const name = input.name?.trim() || `Workspace ${config.workspaces.length + 1}`;
  const baseId = slugify(name);
  let id = baseId;
  let suffix = 2;
  while (config.workspaces.some((workspace) => workspace.id === id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const root = input.root?.trim()
    ? path.resolve(input.root.trim())
    : path.resolve(PROJECT_ROOT, 'workspace', 'workspaces', id);
  const workspace = buildWorkspace(id, name, root, now);
  config.workspaces.push(workspace);
  config.activeWorkspaceId = workspace.id;
  await writeConfig(config);
  return workspace;
}

export async function selectWorkspace(id: string): Promise<WorkspaceSummary> {
  const config = await readConfig();
  const workspace = config.workspaces.find((entry) => entry.id === id);
  if (!workspace) {
    throw new Error(`Workspace not found: ${id}`);
  }
  workspace.lastOpenedAt = new Date().toISOString();
  config.activeWorkspaceId = workspace.id;
  await writeConfig(config);
  return workspace;
}

export async function resolveWorkspaceRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ocrOutputPath(workspace: WorkspaceSummary, referencePath: string): string {
  const relative = path.relative(workspace.referencesDir, referencePath).replace(/[\\/]/g, '__');
  return path.resolve(workspace.referencesDir, '.ocr', `${relative}.ocr.md`);
}

async function collectReferenceDocuments(
  workspace: WorkspaceSummary,
  root: string,
  maxDepth = 4,
): Promise<ReferenceDocument[]> {
  if (maxDepth < 0 || !(await exists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const docs: ReferenceDocument[] = [];
  for (const entry of entries) {
    if (entry.name === '.ocr') {
      continue;
    }
    const fullPath = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      docs.push(...(await collectReferenceDocuments(workspace, fullPath, maxDepth - 1)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const info = await stat(fullPath);
    const ocrPath = ocrOutputPath(workspace, fullPath);
    docs.push({
      name: entry.name,
      relativePath: path.relative(workspace.referencesDir, fullPath).replace(/\\/g, '/'),
      absolutePath: fullPath,
      sizeBytes: info.size,
      updatedAt: info.mtime.toISOString(),
      ocrTextPath: (await exists(ocrPath)) ? ocrPath : undefined,
    });
  }
  return docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function listReferenceDocuments(): Promise<ReferenceDocument[]> {
  const workspace = await getActiveWorkspace();
  await ensureWorkspaceDirs(workspace);
  return collectReferenceDocuments(workspace, workspace.referencesDir);
}

export async function resolveReferenceDocument(relativePath: string): Promise<{ workspace: WorkspaceSummary; absolutePath: string; ocrPath: string }> {
  const workspace = await getActiveWorkspace();
  const absolutePath = path.resolve(workspace.referencesDir, relativePath);
  if (!isPathInside(workspace.referencesDir, absolutePath)) {
    throw new Error(`Reference path escapes workspace references: ${relativePath}`);
  }
  if (!(await exists(absolutePath))) {
    throw new Error(`Reference document not found: ${relativePath}`);
  }
  return {
    workspace,
    absolutePath,
    ocrPath: ocrOutputPath(workspace, absolutePath),
  };
}

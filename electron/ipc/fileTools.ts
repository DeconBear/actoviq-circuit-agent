import { IpcMain, shell } from 'electron';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

import archiver from 'archiver';
import { getActiveWorkspaceRoot } from '../workspaceState.js';

const WORKFLOW_STAGE_COUNT = 8;

interface WorkflowStateFile {
  jobId?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  completedStages?: Array<{ key?: string; status?: string }>;
}

interface ManifestFile {
  jobId?: string;
  job_id?: string;
  jobRoot?: string;
  job_root?: string;
  createdAt?: string;
  created_at?: string;
  stageCount?: number;
  stage_count?: number;
  completedStages?: number;
  completed_stages?: number;
  status?: string;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
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

async function collectJobRoots(root: string, maxDepth = 5): Promise<string[]> {
  if (maxDepth < 0 || !(await exists(root))) {
    return [];
  }

  const roots: string[] = [];
  if (
    await exists(path.resolve(root, 'logs', 'workflow-state.json')) ||
    await exists(path.resolve(root, 'reports', 'manifest.json'))
  ) {
    roots.push(root);
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    roots.push(...(await collectJobRoots(path.resolve(root, entry.name), maxDepth - 1)));
  }
  return roots;
}

async function resolveJobRoot(jobIdOrPath: string): Promise<string> {
  const input = String(jobIdOrPath ?? '').trim();
  if (!input) {
    throw new Error('Job id is required.');
  }

  const workspaceRoot = await getActiveWorkspaceRoot();
  const jobsDir = path.resolve(workspaceRoot, 'jobs');
  const directRoot = path.resolve(jobsDir, input);
  if (
    await exists(path.resolve(directRoot, 'logs', 'workflow-state.json')) ||
    await exists(path.resolve(directRoot, 'reports', 'manifest.json'))
  ) {
    return directRoot;
  }

  if (path.isAbsolute(input)) {
    const absoluteRoot = path.resolve(input);
    const relative = path.relative(workspaceRoot, absoluteRoot);
    if (
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      (
        await exists(path.resolve(absoluteRoot, 'logs', 'workflow-state.json')) ||
        await exists(path.resolve(absoluteRoot, 'reports', 'manifest.json'))
      )
    ) {
      return absoluteRoot;
    }
  }

  const roots = await collectJobRoots(jobsDir);
  for (const root of roots) {
    if (path.basename(root) === input) {
      return root;
    }
    const state = await readJsonFile<WorkflowStateFile>(path.resolve(root, 'logs', 'workflow-state.json'));
    const manifest = await readJsonFile<ManifestFile>(path.resolve(root, 'reports', 'manifest.json'));
    if (state?.jobId === input || manifest?.jobId === input || manifest?.job_id === input) {
      return root;
    }
  }

  throw new Error(`Job not found: ${input}`);
}

function resolveJobFile(jobRoot: string, relativePath: string): string {
  const targetPath = path.resolve(jobRoot, String(relativePath ?? ''));
  const relative = path.relative(jobRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes job root: ${relativePath}`);
  }
  return targetPath;
}

function createdAtFromJobId(jobId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(jobId);
  if (!match) {
    return '';
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function summarizeWorkflowStatus(state: WorkflowStateFile | null, manifest: ManifestFile | null): {
  createdAt: string;
  stageCount: number;
  completedStages: number;
  status: 'completed' | 'failed' | 'running' | 'unknown' | 'incomplete';
} {
  const stageRecords = state?.completedStages ?? [];
  const latestByKey = new Map<string, string>();
  for (const record of stageRecords) {
    if (record.key) {
      latestByKey.set(record.key, record.status ?? 'unknown');
    }
  }
  const latestStatuses = [...latestByKey.values()];
  const hasError = latestStatuses.includes('error');
  const completedStages = latestStatuses.filter((status) => status === 'completed').length;
  const stageCount = manifest?.stageCount ?? manifest?.stage_count ?? WORKFLOW_STAGE_COUNT;
  const workflowLeadDone = latestByKey.get('workflow-lead') === 'completed';
  const status = hasError
    ? 'failed'
    : workflowLeadDone || (completedStages >= stageCount && completedStages > 0)
      ? 'completed'
      : completedStages > 0
        ? 'running'
        : manifest?.status === 'completed' || manifest?.status === 'failed'
          ? manifest.status
          : manifest
            ? 'completed'
          : 'incomplete';

  return {
    createdAt: state?.createdAt ?? manifest?.createdAt ?? manifest?.created_at ?? '',
    stageCount,
    completedStages: manifest?.completedStages ?? manifest?.completed_stages ?? completedStages,
    status,
  };
}

export function registerFileHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('file:read', async (_event, { jobId, relativePath }) => {
    try {
      const jobRoot = await resolveJobRoot(jobId);
      const filePath = resolveJobFile(jobRoot, relativePath);
      return await readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('file:write', async (_event, { jobId, relativePath, content }) => {
    const jobRoot = await resolveJobRoot(jobId);
    const filePath = resolveJobFile(jobRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  });

  ipcMain.handle('file:list-jobs', async () => {
    const workspaceRoot = await getActiveWorkspaceRoot();
    const jobsDir = path.resolve(workspaceRoot, 'jobs');
    try {
      const roots = await collectJobRoots(jobsDir);
      const jobs = [];
      for (const jobRoot of roots) {
        const manifestPath = path.join(jobRoot, 'reports', 'manifest.json');
        const statePath = path.join(jobRoot, 'logs', 'workflow-state.json');
        const manifest = await readJsonFile<ManifestFile>(manifestPath);
        const state = await readJsonFile<WorkflowStateFile>(statePath);
        const summary = summarizeWorkflowStatus(state, manifest);
        const jobId = state?.jobId ?? manifest?.jobId ?? manifest?.job_id ?? path.basename(jobRoot);
        jobs.push({
          jobId,
          jobRoot,
          createdAt: state?.lastUpdatedAt ?? (summary.createdAt || createdAtFromJobId(jobId)),
          stageCount: summary.stageCount,
          completedStages: summary.completedStages,
          status: summary.status,
        });
      }
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  });

  ipcMain.on('file:open-folder', async (_event, { jobId }) => {
    try {
      const jobDir = await resolveJobRoot(jobId);
      shell.openPath(jobDir);
    } catch {
      // Ignore invalid job references from stale UI state.
    }
  });

  ipcMain.handle('file:export', async (_event, { jobId }) => {
    const jobDir = await resolveJobRoot(jobId);
    const zipPath = path.resolve(path.dirname(jobDir), `${path.basename(jobDir)}.zip`);
    const output = createWriteStream(zipPath);

    return new Promise<string>((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.pipe(output);
      archive.directory(jobDir, jobId);
      archive.on('close', () => resolve(zipPath));
      archive.on('error', reject);
      archive.finalize();
    });
  });
}

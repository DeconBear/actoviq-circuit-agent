import { IpcMain, shell } from 'electron';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
const WORKSPACE_ROOT =
  process.env.ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT?.trim() ||
  process.cwd();

import archiver from 'archiver';

const WORKFLOW_STAGE_COUNT = 8;

interface WorkflowStateFile {
  createdAt?: string;
  completedStages?: Array<{ key?: string; status?: string }>;
}

interface ManifestFile {
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
    const filePath = path.resolve(WORKSPACE_ROOT, 'jobs', jobId, relativePath);
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('file:write', async (_event, { jobId, relativePath, content }) => {
    const filePath = path.resolve(WORKSPACE_ROOT, 'jobs', jobId, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  });

  ipcMain.handle('file:list-jobs', async () => {
    const jobsDir = path.resolve(WORKSPACE_ROOT, 'jobs');
    try {
      const entries = await readdir(jobsDir, { withFileTypes: true });
      const jobs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const jobRoot = path.join(jobsDir, entry.name);
        const manifestPath = path.join(jobsDir, entry.name, 'reports', 'manifest.json');
        const statePath = path.join(jobsDir, entry.name, 'logs', 'workflow-state.json');
        const manifest = await readJsonFile<ManifestFile>(manifestPath);
        const state = await readJsonFile<WorkflowStateFile>(statePath);
        const summary = summarizeWorkflowStatus(state, manifest);
        jobs.push({
          jobId: entry.name,
          jobRoot,
          createdAt: summary.createdAt || createdAtFromJobId(entry.name),
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

  ipcMain.on('file:open-folder', (_event, { jobId }) => {
    const jobDir = path.resolve(WORKSPACE_ROOT, 'jobs', jobId);
    shell.openPath(jobDir);
  });

  ipcMain.handle('file:export', async (_event, { jobId }) => {
    const jobDir = path.resolve(WORKSPACE_ROOT, 'jobs', jobId);
    const zipPath = path.resolve(WORKSPACE_ROOT, 'jobs', `${jobId}.zip`);
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

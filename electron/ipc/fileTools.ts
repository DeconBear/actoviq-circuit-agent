import { IpcMain, shell } from 'electron';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
const WORKSPACE_ROOT =
  process.env.ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT?.trim() ||
  process.cwd();

import archiver from 'archiver';

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
        const manifestPath = path.join(jobsDir, entry.name, 'reports', 'manifest.json');
        try {
          const manifestRaw = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(manifestRaw);
          jobs.push({
            jobId: entry.name,
            jobRoot: path.join(jobsDir, entry.name),
            createdAt: manifest.created_at ?? '',
            stageCount: manifest.stage_count ?? 0,
            completedStages: manifest.completed_stages ?? 0,
            status: manifest.status ?? 'unknown',
          });
        } catch {
          jobs.push({
            jobId: entry.name,
            jobRoot: path.join(jobsDir, entry.name),
            createdAt: '',
            stageCount: 0,
            completedStages: 0,
            status: 'incomplete',
          });
        }
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

import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { JOBS_ROOT } from '../config/projectPaths.js';

export type ArtifactName = 'manifest' | 'summary' | 'design-report' | 'netlist' | 'review' | 'svg';

export interface JobReference {
  jobId: string;
  jobRoot: string;
  manifestPath?: string;
  updatedAt?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectJobRoots(root: string, maxDepth = 4): Promise<string[]> {
  if (maxDepth < 0 || !(await exists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const roots: string[] = [];
  if (await exists(path.resolve(root, 'logs', 'workflow-state.json'))) {
    roots.push(root);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    roots.push(...(await collectJobRoots(path.resolve(root, entry.name), maxDepth - 1)));
  }
  return roots;
}

export async function listRecentJobs(limit = 12): Promise<JobReference[]> {
  const roots = await collectJobRoots(JOBS_ROOT);
  const refs = await Promise.all(
    roots.map(async (jobRoot) => {
      const statePath = path.resolve(jobRoot, 'logs', 'workflow-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        jobId?: string;
        lastUpdatedAt?: string;
        createdAt?: string;
      };
      const manifestPath = path.resolve(jobRoot, 'reports', 'manifest.json');
      return {
        jobId: state.jobId ?? path.basename(jobRoot),
        jobRoot,
        manifestPath: (await exists(manifestPath)) ? manifestPath : undefined,
        updatedAt: state.lastUpdatedAt ?? state.createdAt,
      };
    }),
  );

  return refs
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit);
}

export async function resolveJobReference(jobIdOrPath: string): Promise<JobReference> {
  const input = jobIdOrPath.trim();
  const candidate = path.resolve(input);
  const statePath = input && path.isAbsolute(input)
    ? path.resolve(candidate.toLowerCase().endsWith('workflow-state.json') ? path.dirname(path.dirname(candidate)) : candidate, 'logs', 'workflow-state.json')
    : path.resolve(JOBS_ROOT, input, 'logs', 'workflow-state.json');

  if (await exists(statePath)) {
    const jobRoot = path.dirname(path.dirname(statePath));
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { jobId?: string; lastUpdatedAt?: string };
    return {
      jobId: state.jobId ?? path.basename(jobRoot),
      jobRoot,
      manifestPath: path.resolve(jobRoot, 'reports', 'manifest.json'),
      updatedAt: state.lastUpdatedAt,
    };
  }

  const recent = await listRecentJobs(100);
  const found = recent.find((job) => job.jobId === input || job.jobRoot === input || path.basename(job.jobRoot) === input);
  if (found) {
    return found;
  }

  throw new Error(`Job not found: ${jobIdOrPath}`);
}

export function artifactPath(jobRoot: string, artifact: ArtifactName): string {
  if (artifact === 'manifest') {
    return path.resolve(jobRoot, 'reports', 'manifest.json');
  }
  if (artifact === 'summary') {
    return path.resolve(jobRoot, 'reports', 'final-summary.md');
  }
  if (artifact === 'design-report') {
    return path.resolve(jobRoot, 'design', 'detailed-design-report.md');
  }
  if (artifact === 'netlist') {
    return path.resolve(jobRoot, 'design', 'design.final.cir');
  }
  if (artifact === 'review') {
    return path.resolve(jobRoot, 'verification', 'final-review.md');
  }
  return path.resolve(jobRoot, 'render', 'netlistsvg.svg');
}

export async function readArtifactSummary(jobRoot: string, artifact: ArtifactName): Promise<{
  artifact: ArtifactName;
  path: string;
  exists: boolean;
  bytes?: number;
  preview?: string;
}> {
  const filePath = artifactPath(jobRoot, artifact);
  if (!(await exists(filePath))) {
    return { artifact, path: filePath, exists: false };
  }

  const info = await stat(filePath);
  const text = await readFile(filePath, 'utf8');
  return {
    artifact,
    path: filePath,
    exists: true,
    bytes: info.size,
    preview: text.replace(/\s+/g, ' ').slice(0, 1800),
  };
}

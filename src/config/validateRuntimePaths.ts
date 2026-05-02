import { access } from 'node:fs/promises';

import {
  CIRCUIT_ASSETS_ROOT,
  PYTHON_HELPERS_ROOT,
  SCRIPT_ROOT,
  TEMPLATE_ROOT,
  TOOL_PATHS_PATH,
} from './projectPaths.js';

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export interface RuntimePathStatus {
  label: string;
  targetPath: string;
  exists: boolean;
  envVar?: string;
}

export async function validateRuntimePaths(): Promise<RuntimePathStatus[]> {
  const entries: Array<Omit<RuntimePathStatus, 'exists'>> = [
    {
      label: 'bundled circuit asset root',
      targetPath: CIRCUIT_ASSETS_ROOT,
    },
    {
      label: 'template directory',
      targetPath: TEMPLATE_ROOT,
    },
    {
      label: 'script directory',
      targetPath: SCRIPT_ROOT,
    },
    {
      label: 'tool path config',
      targetPath: TOOL_PATHS_PATH,
    },
    {
      label: 'python helper directory',
      targetPath: PYTHON_HELPERS_ROOT,
    },
  ];

  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      exists: await exists(entry.targetPath),
    })),
  );
}

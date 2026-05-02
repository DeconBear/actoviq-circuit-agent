import path from 'node:path';

import { PROJECT_ROOT } from '../config/projectPaths.js';
import { runPythonJson } from '../utils/processUtils.js';
import { SCRIPT_ROOT } from '../config/projectPaths.js';

export interface NetlistsvgPipelineResult {
  ok: boolean;
  jsonPath: string;
  svgPath: string;
  stderr?: string;
  stdout?: string;
  details?: unknown;
}

export async function runNetlistsvgPipeline(options: {
  designJsonPath: string;
  svgPath: string;
}): Promise<NetlistsvgPipelineResult> {
  const netlistsvgBin = path.resolve(
    PROJECT_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'netlistsvg.cmd' : 'netlistsvg',
  );

  const result = await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'render_netlistsvg.py'),
    args: [
      '--json-path',
      options.designJsonPath,
      '--svg-path',
      options.svgPath,
      '--netlistsvg-bin',
      netlistsvgBin,
      '--skin-profile',
      'analog',
    ],
  });

  return {
    ok: result.ok,
    jsonPath: options.designJsonPath,
    svgPath: options.svgPath,
    stderr: result.stderr,
    stdout: result.stdout,
    details: result.data,
  };
}

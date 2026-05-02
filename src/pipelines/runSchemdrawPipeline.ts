import path from 'node:path';

import { SCRIPT_ROOT } from '../config/projectPaths.js';
import { runPythonJson } from '../utils/processUtils.js';

export interface SchemdrawPipelineResult {
  ok: boolean;
  jsonPath: string;
  svgPath: string;
  stderr?: string;
  stdout?: string;
  details?: unknown;
}

export async function runSchemdrawPipeline(options: {
  designJsonPath: string;
  svgPath: string;
}): Promise<SchemdrawPipelineResult> {
  const result = await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'render_schemdraw.py'),
    args: [
      '--json-path',
      options.designJsonPath,
      '--svg-path',
      options.svgPath,
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

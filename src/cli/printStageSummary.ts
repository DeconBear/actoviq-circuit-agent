import path from 'node:path';
import { colorBoldRed, colorRed, writeStderr, writeStdout } from '../utils/runtimeSupport.js';

export interface StageArtifactSummary {
  label: string;
  path: string;
  exists: boolean;
}

export function printStageSummary(options: {
  stageLabel: string;
  artifacts: StageArtifactSummary[];
  toolCount: number;
  responseText: string;
  status?: 'completed' | 'error';
  errorMessage?: string;
  errorExplanation?: string;
}): void {
  const preview = options.responseText.trim().replace(/\s+/g, ' ').slice(0, 220);
  const status = options.status ?? 'completed';
  writeStdout(`\n[stage-summary] ${options.stageLabel}\n`);
  if (status === 'error') {
    writeStderr(colorBoldRed(`[status] ${status}\n`));
  } else {
    writeStdout(`[status] ${status}\n`);
  }
  writeStdout(`[tool-calls] ${options.toolCount}\n`);
  if (options.errorMessage) {
    writeStderr(colorBoldRed(`[error] ${options.errorMessage}\n`));
  }
  if (options.errorExplanation) {
    writeStderr(colorRed(`[error-explained] ${options.errorExplanation.replace(/\s+/g, ' ').slice(0, 320)}\n`));
  }
  if (preview) {
    writeStdout(`[preview] ${preview}${options.responseText.trim().length > 220 ? '...' : ''}\n`);
  }
  for (const artifact of options.artifacts) {
    writeStdout(
      `[artifact:${artifact.exists ? 'ok' : 'missing'}] ${artifact.label}: ${path.normalize(artifact.path)}\n`,
    );
  }
}

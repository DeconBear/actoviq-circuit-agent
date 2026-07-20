import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createVisionLayoutReviewHost } from '../vision/visionLayoutReviewHost.js';

interface CliRequest {
  provider: 'anthropic' | 'openai';
  model: string;
  base_url?: string;
  work_dir: string;
  session_directory?: string;
  svg_path: string;
  image_path?: string;
  layout_quality_report_path: string;
  module_id: string;
  source_revision: number;
  connectivity_hash: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function requestText(): Promise<string> {
  const requestIndex = process.argv.indexOf('--request');
  if (requestIndex >= 0) {
    const requestPath = process.argv[requestIndex + 1];
    if (!requestPath) throw new Error('--request requires a JSON file path.');
    return readFile(path.resolve(requestPath), 'utf8');
  }
  return readStdin();
}

function parseRequest(text: string): CliRequest {
  const value = JSON.parse(text) as Partial<CliRequest>;
  if (value.provider !== 'anthropic' && value.provider !== 'openai') throw new Error('provider must be anthropic or openai.');
  if (!value.model?.trim()) throw new Error('model is required.');
  if (!value.work_dir?.trim()) throw new Error('work_dir is required.');
  if (!value.svg_path?.trim() || !value.layout_quality_report_path?.trim()) {
    throw new Error('svg_path and layout_quality_report_path are required.');
  }
  if (value.image_path !== undefined && !value.image_path.trim()) {
    throw new Error('image_path must be a non-empty path when provided.');
  }
  if (!value.module_id?.trim()) throw new Error('module_id is required.');
  if (!Number.isInteger(value.source_revision) || Number(value.source_revision) < 0) {
    throw new Error('source_revision must be a non-negative integer.');
  }
  if (!/^[0-9a-f]{64}$/.test(value.connectivity_hash ?? '')) throw new Error('connectivity_hash must be 64 lowercase hex characters.');
  return value as CliRequest;
}

async function main(): Promise<void> {
  const request = parseRequest(await requestText());
  const apiKey = process.env.ACTOVIQ_API_KEY ?? process.env.ACTOVIQ_AUTH_TOKEN ?? '';
  if (!apiKey) throw new Error('ACTOVIQ_API_KEY or ACTOVIQ_AUTH_TOKEN is required.');
  const host = await createVisionLayoutReviewHost({
    provider: request.provider,
    model: request.model,
    modelCapabilities: ['vision'],
    apiKey,
    authToken: request.provider === 'anthropic' ? apiKey : undefined,
    baseURL: request.base_url,
    workDir: path.resolve(request.work_dir),
    sessionDirectory: request.session_directory ? path.resolve(request.session_directory) : undefined,
  });
  try {
    const result = await host.review({
      svgPath: path.resolve(request.svg_path),
      imagePath: request.image_path ? path.resolve(request.image_path) : undefined,
      layoutQualityReportPath: path.resolve(request.layout_quality_report_path),
      moduleId: request.module_id,
      sourceRevision: request.source_revision,
      connectivityHash: request.connectivity_hash,
    });
    process.stdout.write(`${JSON.stringify(result.patchSet)}\n`);
  } finally {
    await host.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
});

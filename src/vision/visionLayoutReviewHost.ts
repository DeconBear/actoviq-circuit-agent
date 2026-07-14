import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createAgentSdk,
  createOpenaiModelApi,
  resolveRuntimeConfig,
  type AgentRunResult,
  type CreateAgentSdkOptions,
  type ModelApi,
} from 'actoviq-agent-sdk';

import { createVisionLayoutReviewSkill } from '../skills/visionLayoutReviewSkill.js';
import { createOpenAiVisionModelApi } from './openAiVisionModelApi.js';

const VISION_SKILL_NAME = 'review-schematic-layout-vision';
const VISION_CAPABILITIES = new Set(['image', 'images', 'vision']);

export interface VisionLayoutReviewHostOptions {
  provider: 'anthropic' | 'openai';
  model: string;
  modelCapabilities: readonly string[];
  workDir: string;
  homeDir?: string;
  sessionDirectory?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  modelApi?: ModelApi;
}

export interface VisionLayoutReviewRequest {
  svgPath: string;
  layoutQualityReportPath: string;
  moduleId: string;
  sourceRevision: number;
  connectivityHash: string;
  signal?: AbortSignal;
}

export interface VisionLayoutReviewHost {
  review(request: VisionLayoutReviewRequest): Promise<AgentRunResult>;
  close(): Promise<void>;
}

function normalizedVisionCapabilities(capabilities: readonly string[]): string[] {
  const normalized = [...new Set(capabilities.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (!normalized.some((value) => VISION_CAPABILITIES.has(value))) {
    throw new Error('A trusted vision-capable model configuration is required for schematic visual review.');
  }
  return normalized;
}

async function stagePacket(request: VisionLayoutReviewRequest): Promise<string> {
  const layoutQualityReportPath = path.resolve(request.layoutQualityReportPath);
  const layoutQualityReport = JSON.parse(await readFile(layoutQualityReportPath, 'utf8')) as unknown;
  return JSON.stringify({
    schema: 'actoviq.vision-layout-review-request.v1',
    svg_path: path.resolve(request.svgPath),
    layout_quality_report_path: layoutQualityReportPath,
    layout_quality_report: layoutQualityReport,
    module_id: request.moduleId,
    source_revision: request.sourceRevision,
    connectivity_hash: request.connectivityHash,
  });
}

export async function createVisionLayoutReviewHost(
  options: VisionLayoutReviewHostOptions,
): Promise<VisionLayoutReviewHost> {
  const modelCapabilities = normalizedVisionCapabilities(options.modelCapabilities);
  const trustedMetadata = {
    surface: 'vision-layout-review-host',
    vision_capable: true,
    model_capabilities: modelCapabilities,
  };
  const sdkOptions: CreateAgentSdkOptions = {
    provider: options.provider,
    model: options.model,
    workDir: path.resolve(options.workDir),
    homeDir: options.homeDir ? path.resolve(options.homeDir) : undefined,
    sessionDirectory: options.sessionDirectory ? path.resolve(options.sessionDirectory) : undefined,
    apiKey: options.apiKey,
    authToken: options.authToken,
    baseURL: options.baseURL,
    metadata: trustedMetadata,
    maxToolIterations: 2,
    tools: [],
    mcpServers: [],
    skills: [createVisionLayoutReviewSkill()],
    disableDefaultAgents: true,
    loadDefaultAgentDirectories: false,
    disableDefaultSkills: true,
    loadDefaultSkillDirectories: false,
    permissionMode: 'default',
  };

  if (options.provider === 'openai') {
    const baseModelApi = options.modelApi
      ?? createOpenaiModelApi(await resolveRuntimeConfig(sdkOptions));
    sdkOptions.modelApi = createOpenAiVisionModelApi(baseModelApi);
  } else if (options.modelApi) {
    sdkOptions.modelApi = options.modelApi;
  }

  const sdk = await createAgentSdk(sdkOptions);
  return {
    review: async (request) => sdk.skills.run(VISION_SKILL_NAME, await stagePacket(request), {
      model: options.model,
      signal: request.signal,
      metadata: trustedMetadata,
    }),
    close: () => sdk.close(),
  };
}

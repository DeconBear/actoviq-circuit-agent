import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { createAgentSdk } from 'actoviq-agent-sdk';

const PROBE_AGENT_NAME = 'desktop-layout-vision-capability-probe';

const COLORS = [
  { name: 'RED', rgb: [232, 40, 40] },
  { name: 'BLUE', rgb: [38, 94, 224] },
  { name: 'YELLOW', rgb: [245, 206, 40] },
  { name: 'MAGENTA', rgb: [211, 48, 190] },
  { name: 'CYAN', rgb: [31, 190, 204] },
] as const;

export interface LayoutVisionProbeOptions {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  baseURL: string;
  model: string;
  workDir: string;
  sessionDirectory: string;
}

interface VisionChallenge {
  pngBase64: string;
  expected: string;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createRgbPng(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgb = pixel(x, y);
      const offset = row + 1 + x * 3;
      raw[offset] = rgb[0] ?? 0;
      raw[offset + 1] = rgb[1] ?? 0;
      raw[offset + 2] = rgb[2] ?? 0;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createChallenge(): VisionChallenge {
  const remaining = [...COLORS];
  const selected: Array<(typeof COLORS)[number]> = [];
  while (remaining.length > 0) {
    const [entry] = remaining.splice(randomInt(remaining.length), 1);
    if (entry) selected.push(entry);
  }
  const panelStarts = [20, 180, 340, 500, 660];
  const png = createRgbPng(820, 180, (x, y) => {
    if (y < 20 || y >= 160) return [255, 255, 255];
    for (let index = 0; index < panelStarts.length; index += 1) {
      const start = panelStarts[index];
      if (start !== undefined && x >= start && x < start + 140) {
        return selected[index]?.rgb ?? [255, 255, 255];
      }
    }
    return [255, 255, 255];
  });
  return {
    pngBase64: png.toString('base64'),
    expected: `ACTOVIQ_VISION:${selected.map((entry) => entry.name).join(',')}`,
  };
}

function normalizeAnswer(value: string): string {
  return value.toUpperCase().replace(/[\s`*_]/g, '');
}

/**
 * Sends a real, randomized PNG to an isolated no-tool SDK agent. A successful
 * text-only provider request is deliberately insufficient for this probe.
 */
export async function probeLayoutVisionModel(options: LayoutVisionProbeOptions): Promise<void> {
  const challenge = createChallenge();
  let sdk: Awaited<ReturnType<typeof createAgentSdk>> | null = null;
  try {
    sdk = await createAgentSdk({
      provider: options.provider,
      apiKey: options.apiKey,
      authToken: options.provider === 'anthropic' ? options.apiKey : undefined,
      baseURL: options.baseURL,
      model: options.model,
      maxTokens: 64,
      maxRetries: 0,
      runTimeoutMs: 30_000,
      workDir: options.workDir,
      sessionDirectory: options.sessionDirectory,
      clientName: 'actoviq-circuit-agent-layout-vision-probe',
      tools: [],
      agents: [{
        name: PROBE_AGENT_NAME,
        description: 'Isolated image-input capability probe for the dedicated schematic layout model.',
        systemPrompt: [
          'Inspect the supplied image yourself. You have no tools.',
          'It contains five solid color panels ordered from left to right.',
          'Reply only as ACTOVIQ_VISION:<1>,<2>,<3>,<4>,<5>.',
          'Use only RED, BLUE, YELLOW, MAGENTA, or CYAN as color names.',
        ].join(' '),
        tools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 1,
        source: 'custom',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'plan',
    });

    const result = await sdk.runWithAgent(PROBE_AGENT_NAME, [{
      type: 'text' as const,
      text: 'Read the five panels in the attached image from left to right and return the required one-line answer.',
    }, {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png',
        data: challenge.pngBase64,
      },
    }], {
      maxTokens: 64,
      temperature: 0,
    });

    const answer = normalizeAnswer(result.text);
    if (!answer.includes(normalizeAnswer(challenge.expected))) {
      throw new Error('The model did not correctly identify the randomized image challenge.');
    }
  } finally {
    await sdk?.close().catch(() => undefined);
  }
}

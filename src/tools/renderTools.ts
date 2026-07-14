import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { PROJECT_ROOT, SCRIPT_ROOT, WORKSPACE_ROOT } from '../config/projectPaths.js';
import { runNetlistsvgPipeline } from '../pipelines/runNetlistsvgPipeline.js';
import { runSchemdrawPipeline } from '../pipelines/runSchemdrawPipeline.js';
import { runAgentSvgPipeline } from '../pipelines/runAgentSvgPipeline.js';
import { runPythonJson } from '../utils/processUtils.js';

interface SchematicVisionImageResult {
  ok: true;
  schema: 'actoviq.vision-layout-image.v1';
  svgPath: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  rasterizer: 'electron' | 'electron-helper';
  imageBase64: string;
}

const MAX_VISION_PNG_BYTES = 6_000_000;

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAllowedSchematicPath(svgPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, svgPath);
  if (![cwd, PROJECT_ROOT, WORKSPACE_ROOT].some((root) => isPathInside(root, resolved))) {
    throw new Error(`Schematic path is outside allowed roots: ${resolved}`);
  }
  if (path.extname(resolved).toLowerCase() !== '.svg') {
    throw new Error(`Vision layout input must be an SVG schematic: ${resolved}`);
  }
  return resolved;
}

function explicitVisionCapability(metadata: Record<string, unknown>): boolean | undefined {
  if (typeof metadata.vision_capable === 'boolean') {
    return metadata.vision_capable;
  }
  const capabilities = metadata.model_capabilities;
  if (!Array.isArray(capabilities)) {
    return undefined;
  }
  return capabilities.some((value) => ['image', 'images', 'vision'].includes(String(value).toLowerCase()));
}

async function rasterizeInElectron(svg: string): Promise<{
  png: Buffer;
  width: number;
  height: number;
}> {
  const { BrowserWindow, nativeImage } = await import('electron');
  const directImage = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  if (!directImage.isEmpty()) {
    const size = directImage.getSize();
    return { png: directImage.toPNG(), width: size.width, height: size.height };
  }
  const window = new BrowserWindow({
    show: false,
    width: 2400,
    height: 1800,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  try {
    const html = `<style>html,body{margin:0;background:#fff}svg{display:block;max-width:2400px;max-height:1800px}</style>${svg}`;
    await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    const box = await window.webContents.executeJavaScript(`(() => {
      const svg = document.querySelector('svg');
      if (!svg) return null;
      const bounds = svg.getBoundingClientRect();
      return { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
    })()`);
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('Rendered schematic has no visible SVG bounds.');
    }
    const width = Math.min(2400, Number(box.width));
    const height = Math.min(1800, Number(box.height));
    window.setContentSize(width, height);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    return { png: image.toPNG(), width, height };
  } finally {
    window.destroy();
  }
}

async function rasterizeWithElectronHelper(svgPath: string): Promise<{
  png: Buffer;
  width: number;
  height: number;
}> {
  const { _electron } = await import('playwright');
  const helperPath = path.resolve(
    PROJECT_ROOT,
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'rasterize_schematic.cjs',
  );
  const resultPath = path.join(tmpdir(), `actoviq-rasterizer-result-${randomUUID()}.json`);
  const userDataPath = path.join(tmpdir(), `actoviq-rasterizer-profile-${randomUUID()}`);
  let electronApp: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    electronApp = await _electron.launch({
      args: [
        `--user-data-dir=${userDataPath}`,
        '--no-sandbox',
        '--disable-gpu-sandbox',
        helperPath,
        svgPath,
        resultPath,
      ],
      cwd: PROJECT_ROOT,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
        ),
      ),
    });
    let serialized = '';
    const deadline = Date.now() + 15_000;
    while (!serialized && Date.now() < deadline) {
      serialized = await readFile(resultPath, 'utf8').catch(() => '');
      if (!serialized) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!serialized.trim()) {
      throw new Error('Electron schematic rasterizer returned no data before timeout.');
    }
    const parsed = JSON.parse(serialized) as {
      ok?: boolean;
      error?: string;
      png_base64?: string;
      width?: number;
      height?: number;
    };
    if (!parsed.ok) {
      throw new Error(`Electron schematic rasterizer failed: ${parsed.error ?? 'unknown error'}`);
    }
    if (!parsed.png_base64 || !parsed.width || !parsed.height) {
      throw new Error('Electron schematic rasterizer returned an invalid result.');
    }
    return { png: Buffer.from(parsed.png_base64, 'base64'), width: parsed.width, height: parsed.height };
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(resultPath, { force: true }).catch(() => undefined);
    await rm(userDataPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function rasterizeSvg(svg: string, svgPath: string): Promise<{
  png: Buffer;
  width: number;
  height: number;
  rasterizer: 'electron' | 'electron-helper';
}> {
  if (process.versions.electron) {
    const rendered = await rasterizeInElectron(svg);
    return { ...rendered, rasterizer: 'electron' };
  }
  const rendered = await rasterizeWithElectronHelper(svgPath);
  return { ...rendered, rasterizer: 'electron-helper' };
}

export function createNetlistToJsonTool() {
  return tool(
    {
      name: 'netlist_to_json',
      description: 'Convert a SPICE netlist to the shared design JSON format.',
      inputSchema: z.object({
        netlist_path: z.string(),
        json_path: z.string(),
        input_node: z.string().optional(),
        output_node: z.string().optional(),
        module_manifest_path: z.string().optional(),
        view: z.enum(['full', 'schematic']).optional(),
      }),
    },
    async ({ netlist_path, json_path, input_node, output_node, module_manifest_path, view }) => {
      const renderView = view ?? 'schematic';
      const args = ['--netlist-path', netlist_path, '--json-path', json_path, '--view', renderView];
      if (input_node) args.push('--input-node', input_node);
      if (output_node) args.push('--output-node', output_node);
      if (module_manifest_path) args.push('--module-manifest-path', module_manifest_path);

      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(SCRIPT_ROOT, 'netlist_to_json.py'),
        args,
      });
      return { ok: result.ok, json_path, stderr: result.stderr, data: result.data };
    },
  );
}

export function createRenderNetlistsvgTool() {
  return tool(
    {
      name: 'render_netlistsvg',
      description:
        'Render the canonical schematic SVG using netlistsvg, custom analog skin, publication layout postprocessing, and geometry/readability reports.',
      inputSchema: z.object({
        design_json_path: z.string(),
        svg_path: z.string(),
      }),
    },
    async ({ design_json_path, svg_path }) => runNetlistsvgPipeline({
      designJsonPath: design_json_path,
      svgPath: svg_path,
    }),
  );
}

export function createSchematicVisionImageTool() {
  return tool(
    {
      name: 'view_schematic_for_layout',
      description:
        'VISION-MODEL ONLY. Return the rendered circuit schematic as a PNG image for visual layout/routing review. Text-only models must not call this tool.',
      searchHint: 'inspect schematic image layout routing',
      inputSchema: z.object({
        svg_path: z.string().describe('Path to an existing generated schematic SVG inside the workflow or project workspace.'),
      }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 8_000_000,
      prompt: () => [
        'This is a vision-only read tool.',
        'Call it only when the current model can inspect image content.',
        'A text-only model MUST NOT call it; use layout-quality JSON instead.',
        'The returned image is evidence for placement/routing review only and never authorizes electrical edits.',
      ].join('\n'),
      validateInput: (_input, context) => {
        if (explicitVisionCapability(context.metadata) !== true) {
          return {
            result: false,
            message: 'view_schematic_for_layout requires an explicitly vision-capable run; text-only or unspecified models cannot call it.',
          };
        }
        return { result: true };
      },
      serialize: (output: SchematicVisionImageResult) => [
        {
          type: 'text',
          text: JSON.stringify({
            schema: output.schema,
            ok: output.ok,
            svg_path: output.svgPath,
            media_type: output.mediaType,
            width: output.width,
            height: output.height,
            bytes: output.bytes,
            sha256: output.sha256,
            rasterizer: output.rasterizer,
            instruction: 'Inspect the attached schematic image; propose layout-only changes and preserve connectivity.',
          }),
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: output.mediaType,
            data: output.imageBase64,
          },
        },
      ],
    },
    async ({ svg_path }, context): Promise<SchematicVisionImageResult> => {
      if (explicitVisionCapability(context.metadata) !== true) {
        throw new Error(
          'view_schematic_for_layout requires an explicitly vision-capable run; text-only or unspecified models cannot call it.',
        );
      }
      const resolved = resolveAllowedSchematicPath(svg_path, context.cwd);
      const fileStats = await stat(resolved);
      if (!fileStats.isFile()) {
        throw new Error(`Schematic path is not a file: ${resolved}`);
      }
      if (fileStats.size > 10_000_000) {
        throw new Error(`Schematic SVG exceeds the 10 MB vision limit: ${resolved}`);
      }
      const svg = await readFile(resolved, 'utf8');
      if (!/<svg\b/i.test(svg)) {
        throw new Error(`File does not contain an SVG schematic: ${resolved}`);
      }
      const rendered = await rasterizeSvg(svg, resolved);
      if (rendered.png.byteLength > MAX_VISION_PNG_BYTES) {
        throw new Error(`Rendered schematic PNG exceeds the 6 MB vision limit: ${resolved}`);
      }
      return {
        ok: true,
        schema: 'actoviq.vision-layout-image.v1',
        svgPath: resolved,
        mediaType: 'image/png',
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.png.byteLength,
        sha256: createHash('sha256').update(rendered.png).digest('hex'),
        rasterizer: rendered.rasterizer,
        imageBase64: rendered.png.toString('base64'),
      };
    },
  );
}

export function createRenderSchemdrawTool() {
  return tool(
    {
      name: 'render_schemdraw',
      description: 'Render a schematic SVG using the schemdraw pipeline.',
      inputSchema: z.object({
        design_json_path: z.string(),
        svg_path: z.string(),
      }),
    },
    async ({ design_json_path, svg_path }) => runSchemdrawPipeline({
      designJsonPath: design_json_path,
      svgPath: svg_path,
    }),
  );
}

export function createRenderAgentSvgTool() {
  return tool(
    {
      name: 'render_agent_svg',
      description: 'Render a custom SVG using scene hints and A* routing.',
      inputSchema: z.object({
        design_json_path: z.string(),
        svg_path: z.string(),
        scene_path: z.string().optional(),
        title: z.string().optional(),
      }),
    },
    async ({ design_json_path, svg_path, scene_path, title }) =>
      runAgentSvgPipeline({
        designJsonPath: design_json_path,
        svgPath: svg_path,
        scenePath: scene_path,
        title,
      }),
  );
}

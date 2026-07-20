import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
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
  sourcePath: string;
  sourceKind: 'svg' | 'png';
  mediaType: 'image/png';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  rasterizer: 'electron' | 'electron-helper' | 'pre-rendered';
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

function resolveAllowedPngPath(imagePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, imagePath);
  if (![cwd, PROJECT_ROOT, WORKSPACE_ROOT].some((root) => isPathInside(root, resolved))) {
    throw new Error(`Schematic image path is outside allowed roots: ${resolved}`);
  }
  if (path.extname(resolved).toLowerCase() !== '.png') {
    throw new Error(`Vision layout image input must be a PNG: ${resolved}`);
  }
  return resolved;
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Vision layout image is not a valid PNG document.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 10_000 || height > 10_000) {
    throw new Error(`Vision layout PNG dimensions are invalid: ${width}x${height}.`);
  }
  return { width, height };
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
  const helperPath = path.resolve(
    PROJECT_ROOT,
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'rasterize_schematic.cjs',
  );
  const resultPath = path.join(tmpdir(), `actoviq-rasterizer-result-${randomUUID()}.json`);
  const userDataPath = path.join(tmpdir(), `actoviq-rasterizer-profile-${randomUUID()}`);
  let electronApp: { close(): Promise<void> } | undefined;
  let electronChild: ChildProcess | undefined;
  let launchError: Error | undefined;
  try {
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
      ),
    );
    const args = [
      `--user-data-dir=${userDataPath}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      helperPath,
      svgPath,
      resultPath,
    ];
    if (process.versions.electron) {
      // The desktop host starts this CLI with ELECTRON_RUN_AS_NODE. Relaunch
      // the same executable without that flag so BrowserWindow is available;
      // packaged builds therefore do not depend on Playwright at runtime.
      electronChild = spawn(process.execPath, args, {
        cwd: PROJECT_ROOT,
        env: cleanEnvironment,
        windowsHide: true,
        stdio: 'ignore',
      });
      electronChild.once('error', (error) => { launchError = error; });
      electronChild.once('exit', (code) => {
        if (code && code !== 0) launchError = new Error(`Electron schematic rasterizer exited with ${code}.`);
      });
    } else {
      const { _electron } = await import('playwright');
      electronApp = await _electron.launch({ args, cwd: PROJECT_ROOT, env: cleanEnvironment });
    }
    let serialized = '';
    // Cold Electron startup on Windows can legitimately take more than 15 s,
    // especially from a synced workspace. Keep the bound finite, but avoid
    // turning a slow helper launch into a false vision-capability failure.
    const deadline = Date.now() + 30_000;
    while (!serialized && !launchError && Date.now() < deadline) {
      serialized = await readFile(resultPath, 'utf8').catch(() => '');
      if (!serialized) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (launchError) throw launchError;
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
    if (electronChild && electronChild.exitCode === null) electronChild.kill();
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
  const electronProcess = process as NodeJS.Process & { type?: string };
  // ELECTRON_RUN_AS_NODE keeps process.versions.electron but does not expose
  // BrowserWindow/nativeImage. Only use the in-process path in a real main process.
  if (process.versions.electron && electronProcess.type === 'browser') {
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
        svg_path: z.string().optional().describe('Generated schematic SVG path; use only when image_path is absent.'),
        image_path: z.string().optional().describe('Preferred pre-rendered schematic PNG path from the trusted desktop layout stage.'),
      }).strict().refine((value) => Boolean(value.svg_path) !== Boolean(value.image_path), {
        message: 'Provide exactly one of svg_path or image_path.',
      }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      // A 6 MB PNG expands to 8 MB in base64 before metadata/tool framing.
      maxResultSizeChars: 8_500_000,
      prompt: () => [
        'This is a vision-only read tool.',
        'Call it only when the current model can inspect image content.',
        'A text-only model MUST NOT call it; use layout-quality JSON instead.',
        'Use the trusted image_path when the stage packet provides one; otherwise pass svg_path.',
        'The returned image is evidence for placement/routing review only and never authorizes electrical edits.',
      ].join('\n'),
      validateInput: (input, context) => {
        if (explicitVisionCapability(context.metadata) !== true) {
          return {
            result: false,
            message: 'view_schematic_for_layout requires an explicitly vision-capable run; text-only or unspecified models cannot call it.',
          };
        }
        const requiredImagePath = context.metadata.required_layout_image_path;
        if (typeof requiredImagePath === 'string'
          && (!input.image_path || path.resolve(context.cwd, input.image_path) !== path.resolve(requiredImagePath))) {
          return {
            result: false,
            message: 'This layout review must use the trusted pre-rendered image_path from its stage packet.',
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
            source_path: output.sourcePath,
            source_kind: output.sourceKind,
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
    async ({ svg_path, image_path }, context): Promise<SchematicVisionImageResult> => {
      if (explicitVisionCapability(context.metadata) !== true) {
        throw new Error(
          'view_schematic_for_layout requires an explicitly vision-capable run; text-only or unspecified models cannot call it.',
        );
      }
      const requiredImagePath = context.metadata.required_layout_image_path;
      if (typeof requiredImagePath === 'string'
        && (!image_path || path.resolve(context.cwd, image_path) !== path.resolve(requiredImagePath))) {
        throw new Error('This layout review must use the trusted pre-rendered image_path from its stage packet.');
      }
      if (image_path) {
        const resolved = resolveAllowedPngPath(image_path, context.cwd);
        const fileStats = await stat(resolved);
        if (!fileStats.isFile()) throw new Error(`Schematic image path is not a file: ${resolved}`);
        if (fileStats.size > MAX_VISION_PNG_BYTES) {
          throw new Error(`Schematic PNG exceeds the 6 MB vision limit: ${resolved}`);
        }
        const png = await readFile(resolved);
        const dimensions = pngDimensions(png);
        return {
          ok: true,
          schema: 'actoviq.vision-layout-image.v1',
          sourcePath: resolved,
          sourceKind: 'png',
          mediaType: 'image/png',
          width: dimensions.width,
          height: dimensions.height,
          bytes: png.byteLength,
          sha256: createHash('sha256').update(png).digest('hex'),
          rasterizer: 'pre-rendered',
          imageBase64: png.toString('base64'),
        };
      }
      if (!svg_path) throw new Error('A schematic svg_path or image_path is required.');
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
      const dimensions = pngDimensions(rendered.png);
      return {
        ok: true,
        schema: 'actoviq.vision-layout-image.v1',
        sourcePath: resolved,
        sourceKind: 'svg',
        mediaType: 'image/png',
        width: dimensions.width,
        height: dimensions.height,
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

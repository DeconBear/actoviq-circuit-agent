import path from 'node:path';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { SCRIPT_ROOT } from '../config/projectPaths.js';
import { runNetlistsvgPipeline } from '../pipelines/runNetlistsvgPipeline.js';
import { runSchemdrawPipeline } from '../pipelines/runSchemdrawPipeline.js';
import { runAgentSvgPipeline } from '../pipelines/runAgentSvgPipeline.js';
import { runPythonJson } from '../utils/processUtils.js';

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

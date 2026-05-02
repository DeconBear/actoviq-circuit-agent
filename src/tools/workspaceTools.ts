import { readdir } from 'node:fs/promises';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import {
  CIRCUIT_ASSETS_ROOT,
  PYTHON_HELPERS_ROOT,
  SCRIPT_ROOT,
  TEMPLATE_ROOT,
  TOOL_PATHS_PATH,
} from '../config/projectPaths.js';

export function createDescribeProjectAssetsTool() {
  return tool(
    {
      name: 'describe_project_assets',
      description: 'Describe bundled circuit assets, helper scripts, and starter templates.',
      inputSchema: z.object({}),
    },
    async () => {
      const templates = (await readdir(TEMPLATE_ROOT)).filter((entry) => entry.endsWith('.cir')).sort();
      return {
        bundled_assets: {
          circuit_assets_root: CIRCUIT_ASSETS_ROOT,
          template_root: TEMPLATE_ROOT,
          script_root: SCRIPT_ROOT,
          tool_paths_path: TOOL_PATHS_PATH,
          python_helpers_root: PYTHON_HELPERS_ROOT,
        },
        templates,
        primary_renderer: 'netlistsvg',
        renderers: ['netlistsvg', 'schemdraw', 'agent_svg'],
        renderer_policy:
          'Use netlistsvg as the canonical schematic output; use schemdraw and agent_svg as secondary comparison outputs.',
      };
    },
  );
}

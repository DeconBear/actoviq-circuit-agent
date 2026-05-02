import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { SCRIPT_ROOT, TEMPLATE_ROOT } from '../config/projectPaths.js';
import { runPythonJson } from '../utils/processUtils.js';

export function createListTemplatesTool() {
  return tool(
    {
      name: 'list_available_templates',
      description: 'List reusable starter netlist templates.',
      inputSchema: z.object({}),
    },
    async () => {
      const entries = await readdir(TEMPLATE_ROOT);
      return {
        templates: entries.filter((entry) => entry.endsWith('.cir')).sort(),
      };
    },
  );
}

export function createCopyTemplateTool() {
  return tool(
    {
      name: 'copy_template_netlist',
      description: 'Copy a starter template netlist into a target design path.',
      inputSchema: z.object({
        template_name: z.string(),
        output_path: z.string(),
      }),
    },
    async ({ template_name, output_path }) => {
      const source = path.resolve(TEMPLATE_ROOT, template_name);
      const target = path.resolve(output_path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      return { ok: true, source, target };
    },
  );
}

export function createNormalizeSpecTool() {
  return tool(
    {
      name: 'normalize_spec',
      description: 'Normalize a spec.json file using the bundled circuit helper.',
      inputSchema: z.object({
        spec_path: z.string(),
        output_path: z.string(),
      }),
    },
    async ({ spec_path, output_path }) => {
      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(SCRIPT_ROOT, 'normalize_spec.py'),
        args: ['--spec-path', spec_path, '--output-path', output_path],
      });
      return {
        ok: result.ok,
        output_path,
        stderr: result.stderr,
        data: result.data,
      };
    },
  );
}

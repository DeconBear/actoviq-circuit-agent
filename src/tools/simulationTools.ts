import path from 'node:path';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { SCRIPT_ROOT } from '../config/projectPaths.js';
import { runPythonJson } from '../utils/processUtils.js';

export function createStrictParamCheckTool() {
  return tool(
    {
      name: 'strict_param_check',
      description: 'Run strict parameter completeness validation on a netlist.',
      inputSchema: z.object({
        netlist_path: z.string(),
        output_path: z.string(),
      }),
    },
    async ({ netlist_path, output_path }) => {
      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(SCRIPT_ROOT, 'strict_param_check.py'),
        args: ['--netlist-path', netlist_path, '--allow-expression', '--output-path', output_path],
      });
      return { ok: result.ok, output_path, stderr: result.stderr, data: result.data };
    },
  );
}

export function createValidateNetlistPrimitivesTool() {
  return tool(
    {
      name: 'validate_netlist_primitives',
      description: 'Validate that a netlist stays in primitive-only mode.',
      inputSchema: z.object({
        netlist_path: z.string(),
      }),
    },
    async ({ netlist_path }) => {
      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(SCRIPT_ROOT, 'validate_netlist_primitives.py'),
        args: ['--netlist-path', netlist_path],
      });
      return { ok: result.ok, stderr: result.stderr, data: result.data };
    },
  );
}

export function createRunDualAnalysisTool() {
  return tool(
    {
      name: 'run_dual_analysis',
      description: 'Run split AC/power ngspice analyses and evaluate against spec.',
      inputSchema: z.object({
        work_dir: z.string(),
        netlist_path: z.string(),
        spec_path: z.string().optional(),
      }),
    },
    async ({ work_dir, netlist_path, spec_path }) => {
      const args = ['--work-dir', work_dir, '--netlist-path', netlist_path];
      if (spec_path) {
        args.push('--spec-path', spec_path);
      }

      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(SCRIPT_ROOT, 'run_dual_analysis.py'),
        args,
      });
      return { ok: result.ok, work_dir, stderr: result.stderr, data: result.data };
    },
  );
}

export function createPatchNetlistTool() {
  return tool(
    {
      name: 'patch_netlist',
      description: 'Apply a deterministic patch plan to a netlist.',
      inputSchema: z.object({
        netlist_path: z.string(),
        patch_plan_path: z.string(),
        output_path: z.string(),
      }),
    },
    async ({ netlist_path, patch_plan_path, output_path }) => {
      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(SCRIPT_ROOT, 'patch_netlist.py'),
        args: [
          '--netlist-path',
          netlist_path,
          '--patch-plan-path',
          patch_plan_path,
          '--output-path',
          output_path,
        ],
      });
      return { ok: result.ok, output_path, stderr: result.stderr, data: result.data };
    },
  );
}

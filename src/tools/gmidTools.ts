import path from 'node:path';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { PYTHON_HELPERS_ROOT } from '../config/projectPaths.js';
import { runPythonJson } from '../utils/processUtils.js';

const SUPPORTED_MODELS = ['nmos180', 'pmos180', 'nmos45hp', 'pmos45hp', 'nmos22hp', 'pmos22hp'];

export function createListGmidModelsTool() {
  return tool(
    {
      name: 'list_gmid_models',
      description: 'List supported gm/ID characterization models.',
      inputSchema: z.object({}),
    },
    async () => ({
      models: SUPPORTED_MODELS,
    }),
  );
}

export function createGmidSizeDeviceTool() {
  return tool(
    {
      name: 'gmid_size_device',
      description: 'Size a device using the gm/ID lookup tables.',
      inputSchema: z.object({
        mode: z.enum(['id', 'gm', 'w', 'ft', 'gmro']),
        model: z.string(),
        l_um: z.number().positive(),
        vds: z.number().positive(),
        gmid: z.number().positive().optional(),
        id_a: z.number().positive().optional(),
        gm_s: z.number().positive().optional(),
        w_um: z.number().positive().optional(),
        ft_hz: z.number().positive().optional(),
        gmro: z.number().positive().optional(),
      }),
    },
    async (input) => {
      const args = [
        '--mode',
        input.mode,
        '--model',
        input.model,
        '--l-um',
        String(input.l_um),
        '--vds',
        String(input.vds),
      ];

      if (input.gmid != null) args.push('--gmid', String(input.gmid));
      if (input.id_a != null) args.push('--id-a', String(input.id_a));
      if (input.gm_s != null) args.push('--gm-s', String(input.gm_s));
      if (input.w_um != null) args.push('--w-um', String(input.w_um));
      if (input.ft_hz != null) args.push('--ft-hz', String(input.ft_hz));
      if (input.gmro != null) args.push('--gmro', String(input.gmro));

      const result = await runPythonJson<Record<string, unknown>>({
        scriptPath: path.resolve(PYTHON_HELPERS_ROOT, 'gmid_lookup.py'),
        args,
      });

      return {
        ok: result.ok,
        stderr: result.stderr,
        data: result.data,
      };
    },
  );
}

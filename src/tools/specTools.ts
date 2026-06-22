import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { SCRIPT_ROOT, TEMPLATE_ROOT } from '../config/projectPaths.js';
import { listSavedDesignTemplates, resolveSavedTemplateNetlist } from '../utils/designMemory.js';
import { runPythonJson } from '../utils/processUtils.js';

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createListTemplatesTool() {
  return tool(
    {
      name: 'list_available_templates',
      description: 'List reusable starter netlist templates.',
      inputSchema: z.object({}),
    },
    async () => {
      const entries = await readdir(TEMPLATE_ROOT);
      const savedDesignTemplates = await listSavedDesignTemplates();
      return {
        templates: entries.filter((entry) => entry.endsWith('.cir')).sort(),
        saved_design_templates: savedDesignTemplates.map((template) => ({
          id: template.id,
          name: template.name,
          source_project_id: template.sourceProjectId,
          source_revision: template.sourceRevision,
          template_netlist_path: template.templateNetlistPath,
          agent_guide_path: template.agentGuidePath,
        })),
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
      let source = path.resolve(TEMPLATE_ROOT, template_name);
      if (!isPathInside(TEMPLATE_ROOT, source) || !(await exists(source))) {
        const savedTemplate = await resolveSavedTemplateNetlist(template_name);
        if (!savedTemplate) {
          throw new Error(`Template not found: ${template_name}`);
        }
        source = savedTemplate.templateNetlistPath;
      }
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

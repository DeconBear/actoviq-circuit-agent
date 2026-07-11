import { readdir } from 'node:fs/promises';

import { tool } from 'actoviq-agent-sdk';
import { z } from 'zod';

import {
  CIRCUIT_ASSETS_ROOT,
  DESIGN_MEMORY_ROOT,
  PYTHON_HELPERS_ROOT,
  SAVED_FLOW_ROOT,
  SAVED_TEMPLATE_ROOT,
  SCRIPT_ROOT,
  TEMPLATE_ROOT,
  TOOL_PATHS_PATH,
} from '../config/projectPaths.js';
import { listSavedDesignFlows, listSavedDesignTemplates } from '../utils/designMemory.js';

export function createDescribeProjectAssetsTool() {
  return tool(
    {
      name: 'describe_project_assets',
      description: 'Describe bundled circuit assets, helper scripts, and starter templates.',
      inputSchema: z.object({}),
    },
    async () => {
      const templates = (await readdir(TEMPLATE_ROOT)).filter((entry) => entry.endsWith('.cir')).sort();
      const savedDesignTemplates = await listSavedDesignTemplates();
      const savedDesignFlows = await listSavedDesignFlows();
      return {
        bundled_assets: {
          circuit_assets_root: CIRCUIT_ASSETS_ROOT,
          template_root: TEMPLATE_ROOT,
          script_root: SCRIPT_ROOT,
          tool_paths_path: TOOL_PATHS_PATH,
          python_helpers_root: PYTHON_HELPERS_ROOT,
        },
        templates,
        design_memory: {
          root: DESIGN_MEMORY_ROOT,
          template_root: SAVED_TEMPLATE_ROOT,
          flow_root: SAVED_FLOW_ROOT,
          saved_templates: savedDesignTemplates.map((template) => ({
            id: template.id,
            name: template.name,
            source_project_id: template.sourceProjectId,
            source_revision: template.sourceRevision,
            source_document_hash: template.sourceDocumentHash,
            validation_status: template.validationStatus,
            preferred_for_agent_reuse: template.preferredForAgentReuse,
            simulation_coverage: template.simulationCoverage,
            template_netlist_path: template.templateNetlistPath,
            agent_guide_path: template.agentGuidePath,
          })),
          saved_flows: savedDesignFlows.map((flow) => ({
            id: flow.id,
            name: flow.name,
            source_project_id: flow.sourceProjectId,
            source_revision: flow.sourceRevision,
            source_document_hash: flow.sourceDocumentHash,
            validation_status: flow.validationStatus,
            preferred_for_agent_reuse: flow.preferredForAgentReuse,
            simulation_coverage: flow.simulationCoverage,
            flow_path: flow.flowPath,
          })),
        },
        primary_renderer: 'netlistsvg',
        renderers: ['netlistsvg', 'schemdraw', 'agent_svg'],
        renderer_policy:
          'Use the CircuitDocument SVG as the editable canonical projection; use netlistsvg as a compatibility export and geometry comparison.',
      };
    },
  );
}

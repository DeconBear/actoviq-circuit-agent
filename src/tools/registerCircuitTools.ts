import type { AgentToolDefinition } from 'actoviq-agent-sdk';

import { PROJECT_ROOT, WORKSPACE_ROOT } from '../config/projectPaths.js';
import { createWorkspaceFileTools } from './fileTools.js';
import { createGmidSizeDeviceTool, createListGmidModelsTool } from './gmidTools.js';
import { createRenderAgentSvgTool, createRenderNetlistsvgTool, createRenderSchemdrawTool, createNetlistToJsonTool } from './renderTools.js';
import { createCopyTemplateTool, createListTemplatesTool, createNormalizeSpecTool } from './specTools.js';
import {
  createPatchNetlistTool,
  createRunDualAnalysisTool,
  createStrictParamCheckTool,
  createValidateNetlistPrimitivesTool,
} from './simulationTools.js';
import { withAgentFacingToolErrorsForAll } from './toolErrorFeedback.js';
import { createDescribeProjectAssetsTool } from './workspaceTools.js';
import { createDisabledTaskTool } from './disabledTaskTool.js';

export function registerCircuitTools(workDir: string): AgentToolDefinition[] {
  return withAgentFacingToolErrorsForAll([
    createDisabledTaskTool(),
    ...createWorkspaceFileTools({
      cwd: workDir,
      allowedRoots: [workDir, PROJECT_ROOT, WORKSPACE_ROOT],
    }),
    createDescribeProjectAssetsTool(),
    createListTemplatesTool(),
    createCopyTemplateTool(),
    createNormalizeSpecTool(),
    createListGmidModelsTool(),
    createGmidSizeDeviceTool(),
    createStrictParamCheckTool(),
    createValidateNetlistPrimitivesTool(),
    createRunDualAnalysisTool(),
    createPatchNetlistTool(),
    createNetlistToJsonTool(),
    createRenderNetlistsvgTool(),
    createRenderSchemdrawTool(),
    createRenderAgentSvgTool(),
  ]);
}

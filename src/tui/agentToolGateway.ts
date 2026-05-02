import type { Interface } from 'node:readline/promises';

import type { AgentToolDefinition } from 'actoviq-agent-sdk';

import { createDisabledTaskTool } from '../tools/disabledTaskTool.js';
import { withAgentFacingToolErrorsForAll } from '../tools/toolErrorFeedback.js';
import { TuiStateStore } from './TuiState.js';
import { createTuiWorkflowTools } from './workflowTools.js';

export function createConversationToolGateway(options: {
  stateStore: TuiStateStore;
  rl: Interface;
}): AgentToolDefinition[] {
  return withAgentFacingToolErrorsForAll([
    createDisabledTaskTool(),
    ...createTuiWorkflowTools(options),
  ]);
}

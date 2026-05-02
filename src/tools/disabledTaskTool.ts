import { tool, type AgentToolDefinition } from 'actoviq-agent-sdk';
import { z } from 'zod';

export function createDisabledTaskTool(): AgentToolDefinition {
  return tool(
    {
      name: 'Task',
      description: [
        'Task delegation is disabled in actoviq-circuit-agent workflow runs.',
        'Do not call this tool. Complete the current stage directly with the registered circuit tools.',
      ].join(' '),
      inputSchema: z.object({
        description: z.unknown().optional(),
        prompt: z.unknown().optional(),
        subagent_type: z.unknown().optional(),
      }).passthrough(),
      serialize: () => 'Task delegation is disabled; continue directly in the current agent stage.',
    },
    async () => ({
      disabled: true,
      message: 'Task delegation is disabled for this workflow. Continue directly with the current stage tools.',
    }),
  );
}

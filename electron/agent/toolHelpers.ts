import { tool, type AgentToolDefinition } from 'actoviq-agent-sdk';
import { z } from 'zod';

export function createDisabledTaskTool(): AgentToolDefinition {
  return tool(
    {
      name: 'Task',
      description: [
        'Task delegation is disabled in the desktop circuit agent.',
        'Do not call this tool. Use the registered circuit_project tools directly.',
      ].join(' '),
      inputSchema: z.object({
        description: z.unknown().optional(),
        prompt: z.unknown().optional(),
        subagent_type: z.unknown().optional(),
      }).passthrough(),
      serialize: () => 'Task delegation is disabled; continue with circuit tools.',
    },
    async () => ({
      disabled: true,
      message: 'Task delegation is disabled. Continue with circuit tools.',
    }),
  );
}

function summarizeInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 1200);
  } catch {
    return String(input).slice(0, 1200);
  }
}

export function withAgentFacingToolErrors<T extends AgentToolDefinition>(definition: T): T {
  return {
    ...definition,
    async execute(input, context) {
      try {
        return await definition.execute(input, context);
      } catch (error) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        throw new Error([
          'Tool execution failed and this error is intentionally returned to the Agent for correction.',
          `Tool: ${definition.name}`,
          '',
          'Original error:',
          originalMessage,
          '',
          'Input summary:',
          summarizeInput(input),
          '',
          'Agent correction instruction:',
          '- Do not repeat the same tool call with the same arguments.',
          '- Fix arguments, paths, base_revision, or command shape before retrying.',
        ].join('\n'));
      }
    },
  };
}

export function withAgentFacingToolErrorsForAll<T extends AgentToolDefinition>(definitions: T[]): T[] {
  return definitions.map((definition) => withAgentFacingToolErrors(definition));
}

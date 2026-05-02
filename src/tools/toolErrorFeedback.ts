import type { AgentToolDefinition } from 'actoviq-agent-sdk';

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}... [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => summarizeValue(entry));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 16);
    return Object.fromEntries(entries.map(([key, entry]) => [key, summarizeValue(entry)]));
  }
  return value;
}

function summarizeInput(input: unknown): string {
  try {
    return JSON.stringify(summarizeValue(input), null, 2).slice(0, 1200);
  } catch {
    return String(input).slice(0, 1200);
  }
}

function formatToolError(toolName: string, input: unknown, error: unknown): Error {
  const originalMessage = error instanceof Error ? error.message : String(error);
  return new Error(
    [
      'Tool execution failed and this error is intentionally returned to the Agent for correction.',
      `Tool: ${toolName}`,
      '',
      'Original error:',
      originalMessage,
      '',
      'Input summary:',
      summarizeInput(input),
      '',
      'Agent correction instruction:',
      '- Do not repeat the same tool call with the same arguments.',
      '- Read the original error and fix the arguments, missing files, paths, or command inputs before retrying.',
      '- If this is Write, call it with top-level JSON exactly like {"file_path":"ABSOLUTE_OUTPUT_PATH","content":"FULL_FILE_CONTENT"}.',
      '- If you cannot fix the issue, write a concise explanation artifact or report the blocker instead of looping.',
    ].join('\n'),
  );
}

export function withAgentFacingToolErrors<T extends AgentToolDefinition>(definition: T): T {
  return {
    ...definition,
    async execute(input, context) {
      try {
        return await definition.execute(input, context);
      } catch (error) {
        throw formatToolError(definition.name, input, error);
      }
    },
  };
}

export function withAgentFacingToolErrorsForAll<T extends AgentToolDefinition>(definitions: T[]): T[] {
  return definitions.map((definition) => withAgentFacingToolErrors(definition));
}

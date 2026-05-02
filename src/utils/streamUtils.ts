import type { AgentRunResult, AgentRunStream } from 'actoviq-agent-sdk';
import { colorBoldRed, colorRed, writeStderr, writeStdout } from './runtimeSupport.js';

function formatToolResultPreview(content: unknown): string {
  if (typeof content === 'string') {
    return content.replace(/\s+/g, ' ').slice(0, 1200);
  }

  if (content === undefined || content === null) {
    return '';
  }

  try {
    const serialized = JSON.stringify(content);
    return typeof serialized === 'string' ? serialized.replace(/\s+/g, ' ').slice(0, 1200) : '';
  } catch {
    return String(content).replace(/\s+/g, ' ').slice(0, 1200);
  }
}

export async function streamToConsole(stream: AgentRunStream, label: string): Promise<AgentRunResult> {
  let printed = false;
  let lastToolId = '';
  let streamError: unknown;
  let settledResult: AgentRunResult | null = null;

  // Guard the SDK result promise immediately so provider-side failures do not surface
  // as unhandled rejections before we await the final result.
  const guardedResult = stream.result
    .then((result) => {
      settledResult = result;
      return result;
    })
    .catch((error) => {
      streamError = error;
      return null;
    });

  writeStdout(`\n[${label}] `);
  try {
    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        printed = true;
        writeStdout(event.delta);
        continue;
      }

      if (event.type === 'tool.call') {
        const toolId = event.call.id.slice(0, 8);
        lastToolId = toolId;
        writeStdout(`\n[tool:${event.call.publicName}#${toolId}]`);
        continue;
      }

      if (event.type === 'tool.result') {
        const toolId = event.result.id.slice(0, 8);
        const toolResultLabel = `\n[tool-result:${event.result.publicName}#${toolId}:${event.result.isError ? 'error' : 'ok'}]`;
        if (event.result.isError) {
          writeStderr(colorBoldRed(toolResultLabel));
        } else {
          writeStdout(toolResultLabel);
        }
        if (event.result.isError) {
          const resultWithContent = event.result as typeof event.result & {
            content?: unknown;
            error?: unknown;
            message?: unknown;
            outputText?: unknown;
            output?: unknown;
          };
          const preview = formatToolResultPreview(
            resultWithContent.content ??
              resultWithContent.outputText ??
              resultWithContent.error ??
              resultWithContent.message ??
              resultWithContent.output ??
              resultWithContent,
          );
          if (preview) {
            writeStderr(colorRed(` ${preview}`));
          }
        }
        if (lastToolId === toolId) {
          lastToolId = '';
        }
      }
    }
  } catch (error) {
    streamError ??= error;
  }

  await guardedResult;
  if (streamError) {
    writeStdout('\n');
    throw streamError;
  }

  if (!settledResult) {
    writeStdout('\n');
    throw new Error(`stage stream for ${label} completed without a final result`);
  }
  const result: AgentRunResult = settledResult;

  if (!printed && result.text.trim()) {
    writeStdout(result.text);
  }
  writeStdout('\n');
  return result;
}

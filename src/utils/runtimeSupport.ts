import process from 'node:process';

import { classifyError, formatUnknownError } from './errors.js';

let stdoutBroken = false;
let stderrBroken = false;
let handlersInstalled = false;

function colorize(text: string, ansiCode: string): string {
  if (process.env.NO_COLOR || process.env.FORCE_COLOR === '0') {
    return text;
  }
  return `\u001b[${ansiCode}m${text}\u001b[0m`;
}

export function colorRed(text: string): string {
  return colorize(text, '31');
}

export function colorBoldRed(text: string): string {
  return colorize(text, '1;31');
}

function installStreamErrorHandlers(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  process.stdout.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      stdoutBroken = true;
    }
  });

  process.stderr.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      stderrBroken = true;
    }
  });
}

export function formatErrorMessage(error: unknown): string {
  return formatUnknownError(error);
}

export function isBrokenPipeError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return /\bEPIPE\b/i.test(message) || /broken pipe/i.test(message);
}

export function isRetryableTransportError(error: unknown): boolean {
  return classifyError(error).retryable;
}

function writeToStream(target: 'stdout' | 'stderr', text: string): boolean {
  installStreamErrorHandlers();
  const stream = target === 'stdout' ? process.stdout : process.stderr;
  const isBroken = target === 'stdout' ? stdoutBroken : stderrBroken;

  if (isBroken || stream.destroyed || !stream.writable) {
    return false;
  }

  try {
    stream.write(text);
    return true;
  } catch (error) {
    if (isBrokenPipeError(error)) {
      if (target === 'stdout') {
        stdoutBroken = true;
      } else {
        stderrBroken = true;
      }
      return false;
    }
    throw error;
  }
}

export function writeStdout(text: string): boolean {
  return writeToStream('stdout', text);
}

export function writeStderr(text: string): boolean {
  return writeToStream('stderr', text);
}

export function writeError(text: string): boolean {
  return writeStderr(colorBoldRed(text));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export function projectScriptPath(appPath = app.getAppPath(), resourcesPath = process.resourcesPath): string {
  const candidates = [
    path.resolve(appPath, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py'),
    path.resolve(resourcesPath, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py'),
  ];
  const candidate = candidates.find((value) => existsSync(value));
  if (!candidate) {
    throw new Error('circuit_project.py is missing from the application bundle.');
  }
  return candidate;
}

export interface RunProjectToolOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a circuit_project.py subcommand and parse the last JSON line.
 * Same contract used by Skill agents and Electron IPC.
 */
export function runProjectTool(
  args: string[],
  options: RunProjectToolOptions = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN?.trim() || 'python';
    const cwd = options.cwd ?? app.getAppPath();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const child = spawn(python, [projectScriptPath(), ...args], {
      cwd,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Circuit project tool timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(line) as Record<string, unknown>;
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || `Circuit project tool exited with ${code}`));
        return;
      }
      if (code !== 0 || result.ok !== true) {
        reject(new Error(String(result.error ?? stderr.trim() ?? `Circuit project tool exited with ${code}`)));
        return;
      }
      resolve(result);
    });
  });
}

export function summarizeToolResult(result: Record<string, unknown>, maxChars = 8_000): string {
  try {
    const text = JSON.stringify(result, null, 2);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
  } catch {
    return String(result);
  }
}

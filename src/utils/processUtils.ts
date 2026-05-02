import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

export interface CommandJsonResult<T = unknown> {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  data: T | null;
}

export function resolvePythonExecutable(): string {
  const envValue = process.env.ACTOVIQ_PYTHON_BIN?.trim();
  const candidates = [envValue, 'python', 'py'].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const args = candidate === 'py' ? ['-3', '--version'] : ['--version'];
    const checked = spawnSync(candidate, args, {
      stdio: 'pipe',
      shell: false,
      encoding: 'utf8',
    });
    if (checked.status === 0) {
      return candidate === 'py' ? 'py -3' : candidate;
    }
  }

  return 'python';
}

function splitCommand(executable: string): { command: string; prefixArgs: string[] } {
  const parts = executable.split(' ').filter(Boolean);
  return {
    command: parts[0]!,
    prefixArgs: parts.slice(1),
  };
}

export async function runJsonCommand<T = unknown>(options: {
  executable: string;
  args: string[];
  cwd?: string;
}): Promise<CommandJsonResult<T>> {
  const { command, prefixArgs } = splitCommand(options.executable);

  return new Promise((resolve) => {
    const child = spawn(command, [...prefixArgs, ...options.args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      let data: T | null = null;
      try {
        data = trimmed ? (JSON.parse(trimmed) as T) : null;
      } catch {
        data = null;
      }
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        data,
      });
    });
  });
}

export async function runPythonJson<T = unknown>(options: {
  scriptPath: string;
  args: string[];
  cwd?: string;
}): Promise<CommandJsonResult<T>> {
  const python = resolvePythonExecutable();
  return runJsonCommand<T>({
    executable: python,
    args: [path.resolve(options.scriptPath), ...options.args],
    cwd: options.cwd,
  });
}

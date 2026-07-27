import { spawn } from 'node:child_process';

export type ExecutionTarget =
  | 'local_linux'
  | 'ssh_linux'
  | 'container'
  | 'local_windows'
  | 'wsl2';

export type ToolFailureKind =
  | 'cancelled'
  | 'timeout'
  | 'license'
  | 'syntax'
  | 'convergence'
  | 'not_found'
  | 'execution';

export interface ToolCapability {
  providerId: string;
  available: boolean;
  executable: string;
  version?: string;
  target: ExecutionTarget;
  diagnostics: string[];
}

export interface ToolJob {
  id: string;
  kind: string;
  cwd: string;
  sourceRevision?: number;
  documentHash?: string;
  pdkFingerprint?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface PreparedJob extends ToolJob {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  sensitiveValues?: string[];
}

export interface ToolExecution {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  target: ExecutionTarget;
  failureKind?: ToolFailureKind;
}

export interface VerificationResult {
  schema: 'actoviq.verification-run.v1';
  runId: string;
  kind: string;
  providerId: string;
  sourceRevision?: number;
  documentHash?: string;
  pdkFingerprint?: string;
  executed: boolean;
  status: 'passed' | 'failed' | 'cancelled';
  diagnostics: string[];
  artifacts: Array<{ kind: string; path: string; hash?: string }>;
}

export interface ToolProvider<TJob extends ToolJob = ToolJob> {
  readonly id: string;
  readonly target: ExecutionTarget;
  probe(signal?: AbortSignal): Promise<ToolCapability>;
  prepare(job: TJob): Promise<PreparedJob> | PreparedJob;
  run(job: PreparedJob, signal?: AbortSignal): Promise<ToolExecution>;
  parse(job: TJob, execution: ToolExecution): Promise<VerificationResult> | VerificationResult;
  openNative?(artifact: { kind: string; path: string }): Promise<void> | void;
}

export function validateVerificationResult(result: VerificationResult): VerificationResult {
  if (result.schema !== 'actoviq.verification-run.v1') throw new Error('Invalid verification result schema');
  if (!result.runId.trim() || !result.kind.trim() || !result.providerId.trim()) {
    throw new Error('Verification result requires runId, kind, and providerId');
  }
  if (!['passed', 'failed', 'cancelled'].includes(result.status)) {
    throw new Error(`Invalid verification result status: ${String(result.status)}`);
  }
  if (typeof result.executed !== 'boolean') {
    throw new Error('Verification result executed must be boolean');
  }
  if (!Array.isArray(result.diagnostics) || !result.diagnostics.every((item) => typeof item === 'string')) {
    throw new Error('Verification result diagnostics must be a string array');
  }
  if (!Array.isArray(result.artifacts) || result.artifacts.some((artifact) => (
    !artifact.kind?.trim() || !artifact.path?.trim()
  ))) {
    throw new Error('Verification result artifacts must contain kind and path');
  }
  return result;
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|license|lm_license_file)/i;
const SAFE_BASE_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
] as const;

export function sanitizeEnvironment(
  values: Record<string, string>,
  allowedKeys: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowedKeys);
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => allowed.has(key)),
  );
}

export function redactToolText(text: string, sensitiveValues: readonly string[] = []): string {
  let result = text;
  for (const value of sensitiveValues) {
    if (value) result = result.split(value).join('[redacted]');
  }
  return result
    .replace(
      /\b(?:api[_-]?key|token|secret|password|lm_license_file)\s*[:=]\s*[^\s,;]+/gi,
      (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`,
    )
    .replace(/\b(?:sk|pat|ghp)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

export function classifyToolFailure(
  code: number | null,
  stderr: string,
  timedOut = false,
  cancelled = false,
): ToolFailureKind | undefined {
  if (cancelled) return 'cancelled';
  if (timedOut) return 'timeout';
  if (code === 0) return undefined;
  const message = stderr.toLowerCase();
  if (/license|checkout|lm_license_file|flexnet/.test(message)) return 'license';
  if (/syntax|parse error|unexpected token/.test(message)) return 'syntax';
  if (/converg|singular matrix|timestep too small/.test(message)) return 'convergence';
  if (/not found|enoent|no such file/.test(message)) return 'not_found';
  return 'execution';
}

export async function runPreparedTool(
  job: PreparedJob,
  target: ExecutionTarget,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const startedAt = new Date().toISOString();
  const timeoutMs = job.timeoutMs ?? 120_000;
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_BASE_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(job.env ?? {})) {
    if (!SECRET_KEY.test(key) || value) env[key] = value;
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = signal?.aborted ?? false;
    let settled = false;
    const child = spawn(job.executable, job.args, {
      cwd: job.cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      const sensitive = job.sensitiveValues ?? [];
      const cleanStdout = redactToolText(stdout, sensitive);
      const cleanStderr = redactToolText(stderr, sensitive);
      resolve({
        command: job.executable,
        args: [...job.args],
        code,
        stdout: cleanStdout,
        stderr: cleanStderr,
        startedAt,
        finishedAt: new Date().toISOString(),
        target,
        failureKind: classifyToolFailure(code, cleanStderr, timedOut, cancelled),
      });
    };
    const abort = (): void => {
      cancelled = true;
      child.kill();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on('close', finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (cancelled) abort();
  });
}

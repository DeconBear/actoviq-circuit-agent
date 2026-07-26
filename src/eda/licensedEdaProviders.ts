import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ExecutionTarget,
  type PreparedJob,
  type ToolCapability,
  type ToolExecution,
  type ToolJob,
  type ToolProvider,
  type VerificationResult,
  runPreparedTool,
  sanitizeEnvironment,
} from './toolProvider.js';

export type LicensedProviderId =
  | 'cadence_spectre'
  | 'synopsys_primesim_hspice'
  | 'synopsys_primesim_xa'
  | 'siemens_afs'
  | 'cadence_xcelium_ams'
  | 'synopsys_vcs_ams'
  | 'siemens_questa_ams';

export type QualificationState = 'configured' | 'unverified' | 'native_verified';

export interface LicensedExecutionProfile {
  schema: 'actoviq.execution-profile.v1';
  id: string;
  providerId: LicensedProviderId;
  target: Extract<ExecutionTarget, 'local_linux' | 'local_windows' | 'ssh_linux'>;
  executable?: string;
  allowedRoots: string[];
  environment?: Record<string, string>;
  allowedEnvironmentKeys?: string[];
  ssh?: {
    host: string;
    executable?: string;
    remoteWorkingDirectory: string;
  };
  qualification: QualificationState;
}

export interface LicensedEdaJob extends ToolJob {
  inputPath: string;
  outputDirectory: string;
  top?: string;
  measurementCsv?: string;
}

interface ProviderDefinition {
  id: LicensedProviderId;
  displayName: string;
  domain: 'analog' | 'ams';
  executable: string;
  versionArgs: string[];
  environmentKeys: string[];
  prepareArgs(job: LicensedEdaJob): string[];
}

function analogArgs(style: 'spectre' | 'hspice' | 'xa' | 'afs', job: LicensedEdaJob): string[] {
  if (style === 'spectre') return ['-64', job.inputPath, '-raw', job.outputDirectory];
  if (style === 'hspice') return ['-i', job.inputPath, '-o', path.resolve(job.outputDirectory, 'hspice')];
  if (style === 'xa') return [job.inputPath, '-o', job.outputDirectory];
  return [job.inputPath, '-o', job.outputDirectory];
}

export const LICENSED_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'cadence_spectre',
    displayName: 'Cadence Spectre',
    domain: 'analog',
    executable: 'spectre',
    versionArgs: ['-W'],
    environmentKeys: ['CDS_LIC_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => analogArgs('spectre', job),
  },
  {
    id: 'synopsys_primesim_hspice',
    displayName: 'Synopsys PrimeSim HSPICE',
    domain: 'analog',
    executable: 'hspice',
    versionArgs: ['-V'],
    environmentKeys: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => analogArgs('hspice', job),
  },
  {
    id: 'synopsys_primesim_xa',
    displayName: 'Synopsys PrimeSim XA',
    domain: 'analog',
    executable: 'xa',
    versionArgs: ['-version'],
    environmentKeys: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => analogArgs('xa', job),
  },
  {
    id: 'siemens_afs',
    displayName: 'Siemens AFS',
    domain: 'analog',
    executable: 'afs',
    versionArgs: ['-version'],
    environmentKeys: ['MGLS_LICENSE_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => analogArgs('afs', job),
  },
  {
    id: 'cadence_xcelium_ams',
    displayName: 'Cadence Xcelium + Spectre AMS',
    domain: 'ams',
    executable: 'xrun',
    versionArgs: ['-version'],
    environmentKeys: ['CDS_LIC_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => ['-f', job.inputPath, ...(job.top ? ['-top', job.top] : [])],
  },
  {
    id: 'synopsys_vcs_ams',
    displayName: 'Synopsys VCS + PrimeSim',
    domain: 'ams',
    executable: 'vcs',
    versionArgs: ['-ID'],
    environmentKeys: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => ['-f', job.inputPath, ...(job.top ? ['-top', job.top] : [])],
  },
  {
    id: 'siemens_questa_ams',
    displayName: 'Siemens Questa + AFS',
    domain: 'ams',
    executable: 'vsim',
    versionArgs: ['-version'],
    environmentKeys: ['MGLS_LICENSE_FILE', 'LM_LICENSE_FILE'],
    prepareArgs: (job) => ['-c', '-do', job.inputPath, ...(job.top ? [job.top] : [])],
  },
] as const;

function definitionFor(id: LicensedProviderId): ProviderDefinition {
  const definition = LICENSED_PROVIDER_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown licensed EDA provider: ${id}`);
  return definition;
}

function assertWithinRoots(target: string, roots: readonly string[], label: string): string {
  const resolved = path.resolve(target);
  const allowed = roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) throw new Error(`${label} is outside the execution profile allowlist: ${resolved}`);
  return resolved;
}

function sshPrepared(job: PreparedJob, profile: LicensedExecutionProfile): PreparedJob {
  if (!profile.ssh) throw new Error('ssh_linux profile requires ssh settings');
  if (!/^[A-Za-z0-9_.@-]+$/.test(profile.ssh.host)) throw new Error('Invalid SSH host');
  if (!profile.ssh.remoteWorkingDirectory.startsWith('/') || /[\r\n\0]/.test(profile.ssh.remoteWorkingDirectory)) {
    throw new Error('SSH working directory must be an absolute Linux path');
  }
  return {
    ...job,
    executable: profile.ssh.executable || 'ssh',
    args: [
      '-o', 'BatchMode=yes',
      profile.ssh.host,
      '--',
      'env',
      '-C',
      profile.ssh.remoteWorkingDirectory,
      job.executable,
      ...job.args,
    ],
    cwd: profile.allowedRoots[0]!,
    env: {},
    sensitiveValues: [],
  };
}

function assertRemotePath(value: string, label: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be an absolute Linux path for ssh_linux`);
  }
  return value;
}

function parseMeasurements(text: string): Array<{ name: string; value: number }> {
  const values: Array<{ name: string; value: number }> = [];
  const seen = new Set<string>();
  const pattern = /^\s*([A-Za-z_][\w.:-]*)\s*=\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s*$/gim;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    values.push({ name, value: Number(match[2]) });
  }
  return values;
}

async function fileHash(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export class LicensedEdaProvider implements ToolProvider<LicensedEdaJob> {
  readonly id: LicensedProviderId;
  readonly target: LicensedExecutionProfile['target'];
  private readonly definition: ProviderDefinition;

  constructor(
    readonly profile: LicensedExecutionProfile,
    definitionOverride?: ProviderDefinition,
  ) {
    if (profile.schema !== 'actoviq.execution-profile.v1') {
      throw new Error('Licensed EDA profile must use actoviq.execution-profile.v1');
    }
    if (!profile.allowedRoots.length) throw new Error('Execution profile requires allowedRoots');
    this.definition = definitionOverride ?? definitionFor(profile.providerId);
    this.id = this.definition.id;
    this.target = profile.target;
  }

  async probe(signal?: AbortSignal): Promise<ToolCapability> {
    const executable = this.profile.executable || this.definition.executable;
    const prepared: PreparedJob = {
      id: `probe-${this.id}`,
      kind: 'probe',
      cwd: path.resolve(this.profile.allowedRoots[0]!),
      executable,
      args: [...this.definition.versionArgs],
      timeoutMs: 15_000,
      env: sanitizeEnvironment(
        this.profile.environment ?? {},
        this.profile.allowedEnvironmentKeys ?? this.definition.environmentKeys,
      ),
      sensitiveValues: Object.values(this.profile.environment ?? {}),
    };
    const execution = await runPreparedTool(
      this.target === 'ssh_linux' ? sshPrepared(prepared, this.profile) : prepared,
      this.target,
      signal,
    );
    const version = `${execution.stdout}\n${execution.stderr}`.trim().split(/\r?\n/, 1)[0];
    return {
      providerId: this.id,
      available: execution.code === 0,
      executable,
      version: version || undefined,
      target: this.target,
      diagnostics: execution.code === 0 ? [] : [execution.stderr || execution.failureKind || 'probe failed'],
    };
  }

  async prepare(job: LicensedEdaJob): Promise<PreparedJob> {
    const cwd = assertWithinRoots(job.cwd, this.profile.allowedRoots, 'working directory');
    const inputPath = this.target === 'ssh_linux'
      ? assertRemotePath(job.inputPath, 'input')
      : assertWithinRoots(job.inputPath, this.profile.allowedRoots, 'input');
    const outputDirectory = this.target === 'ssh_linux'
      ? assertRemotePath(job.outputDirectory, 'output')
      : assertWithinRoots(job.outputDirectory, this.profile.allowedRoots, 'output');
    if (this.target !== 'ssh_linux') await access(inputPath);
    const normalized = { ...job, cwd, inputPath, outputDirectory };
    const environment = sanitizeEnvironment(
      this.profile.environment ?? {},
      this.profile.allowedEnvironmentKeys ?? this.definition.environmentKeys,
    );
    return {
      ...normalized,
      executable: this.profile.executable || this.definition.executable,
      args: this.definition.prepareArgs(normalized),
      env: this.target === 'ssh_linux' ? {} : environment,
      sensitiveValues: this.target === 'ssh_linux' ? [] : Object.values(environment),
    };
  }

  run(job: PreparedJob, signal?: AbortSignal): Promise<ToolExecution> {
    return runPreparedTool(
      this.target === 'ssh_linux' ? sshPrepared(job, this.profile) : job,
      this.target,
      signal,
    );
  }

  async parse(job: LicensedEdaJob, execution: ToolExecution): Promise<VerificationResult> {
    const measurements = parseMeasurements(`${execution.stdout}\n${execution.stderr}`);
    if (job.measurementCsv) {
      const csvPath = assertWithinRoots(job.measurementCsv, this.profile.allowedRoots, 'measurement CSV');
      try {
        const csv = await readFile(csvPath, 'utf8');
        for (const line of csv.split(/\r?\n/).slice(1)) {
          const [name, rawValue] = line.split(',', 2);
          const value = Number(rawValue);
          if (name?.trim() && Number.isFinite(value)) measurements.push({ name: name.trim(), value });
        }
      } catch {
        // Optional exported measurements are absent when the native run failed early.
      }
    }
    const artifacts: VerificationResult['artifacts'] = [];
    for (const [kind, artifactPath] of [
      ['input', job.inputPath],
      ['measurements', job.measurementCsv],
    ] as const) {
      if (!artifactPath) continue;
      try {
        artifacts.push({ kind, path: artifactPath, hash: await fileHash(artifactPath) });
      } catch {
        // An optional artifact may not exist after a failed native run.
      }
    }
    const success = execution.code === 0;
    return {
      schema: 'actoviq.verification-run.v1',
      runId: job.id,
      kind: job.kind,
      providerId: this.id,
      sourceRevision: job.sourceRevision,
      documentHash: job.documentHash,
      pdkFingerprint: job.pdkFingerprint,
      executed: execution.code !== null,
      status: execution.failureKind === 'cancelled' ? 'cancelled' : success ? 'passed' : 'failed',
      diagnostics: [
        ...(execution.stderr ? [execution.stderr] : []),
        `qualification=${this.profile.qualification}`,
        `measurements=${measurements.length}`,
      ],
      artifacts,
      qualification: this.profile.qualification,
      measured: measurements.length > 0,
      amsVerified: (
        this.definition.domain === 'ams'
        && success
        && this.profile.qualification === 'native_verified'
      ),
      measurements,
    } as VerificationResult;
  }
}

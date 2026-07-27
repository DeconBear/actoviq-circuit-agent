import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type LicensedProviderId =
  | 'ngspice'
  | 'xyce'
  | 'cadence_spectre'
  | 'synopsys_primesim_hspice'
  | 'synopsys_primesim_xa'
  | 'siemens_afs'
  | 'cadence_xcelium_ams'
  | 'synopsys_vcs_ams'
  | 'siemens_questa_ams';

export type ExecutionTarget = 'local_linux' | 'local_windows' | 'ssh_linux';
export type QualificationState = 'configured' | 'unverified' | 'native_verified';

export interface ResolvedExecutionProfile {
  schema: 'actoviq.execution-profile.v1';
  id: string;
  providerId: LicensedProviderId;
  target: ExecutionTarget;
  executable?: string;
  allowedRoots: string[];
  environment: Record<string, string>;
  allowedEnvironmentKeys: string[];
  ssh?: {
    host: string;
    executable?: string;
    scpExecutable?: string;
    remoteWorkingDirectory: string;
  };
  qualification: QualificationState;
}

const PROVIDER_ENVIRONMENT_KEYS: Record<LicensedProviderId, readonly string[]> = {
  ngspice: [],
  xyce: [],
  cadence_spectre: ['CDS_LIC_FILE', 'LM_LICENSE_FILE'],
  synopsys_primesim_hspice: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'],
  synopsys_primesim_xa: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'],
  siemens_afs: ['MGLS_LICENSE_FILE', 'LM_LICENSE_FILE'],
  cadence_xcelium_ams: ['CDS_LIC_FILE', 'LM_LICENSE_FILE'],
  synopsys_vcs_ams: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'],
  siemens_questa_ams: ['MGLS_LICENSE_FILE', 'LM_LICENSE_FILE'],
};

export interface StoredExecutionProfile {
  schema: 'actoviq.execution-profile.v1';
  id: string;
  providerId: LicensedProviderId;
  target: ExecutionTarget;
  executable?: string;
  allowedRoots: string[];
  environmentKeys: string[];
  ssh?: {
    host: string;
    executable?: string;
    scpExecutable?: string;
    remoteWorkingDirectory: string;
  };
  qualification: QualificationState;
}

export interface ExecutionProfileRegistry {
  schema: 'actoviq.execution-profile-registry.v1';
  profiles: StoredExecutionProfile[];
}

const defaultRegistryPath = path.resolve(homedir(), '.actoviq', 'execution-profiles.json');
const idPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const environmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function providerDefinition(providerId: LicensedProviderId) {
  const environmentKeys = PROVIDER_ENVIRONMENT_KEYS[providerId];
  if (!environmentKeys) throw new Error(`Unsupported execution provider: ${providerId}`);
  return { environmentKeys };
}

export function validateStoredExecutionProfile(input: unknown): StoredExecutionProfile {
  if (!input || typeof input !== 'object') throw new Error('Execution profile must be an object');
  const raw = input as Partial<StoredExecutionProfile>;
  if (raw.schema !== 'actoviq.execution-profile.v1') {
    throw new Error('Execution profile must use actoviq.execution-profile.v1');
  }
  const id = String(raw.id ?? '').trim();
  if (!idPattern.test(id)) {
    throw new Error('Execution profile id must start with a letter and contain only letters, digits, dot, dash, or underscore');
  }
  const providerId = String(raw.providerId ?? '') as LicensedProviderId;
  const definition = providerDefinition(providerId);
  const target = raw.target;
  if (target !== 'local_linux' && target !== 'local_windows' && target !== 'ssh_linux') {
    throw new Error(`Unsupported execution target: ${String(target ?? '')}`);
  }
  const allowedRoots = Array.isArray(raw.allowedRoots)
    ? [...new Set(raw.allowedRoots.map((value) => String(value).trim()).filter(Boolean))]
    : [];
  if (!allowedRoots.length || allowedRoots.some((root) => !path.isAbsolute(root))) {
    throw new Error('Execution profile requires at least one absolute allowed root');
  }
  const environmentKeys = Array.isArray(raw.environmentKeys)
    ? [...new Set(raw.environmentKeys.map((value) => String(value).trim()).filter(Boolean))]
    : [];
  const unsupportedKey = environmentKeys.find((key) => (
    !environmentKeyPattern.test(key) || !definition.environmentKeys.includes(key)
  ));
  if (unsupportedKey) {
    throw new Error(`${unsupportedKey} is not an allowed environment key for ${providerId}`);
  }
  const executable = String(raw.executable ?? '').trim();
  if (/[\r\n\0]/.test(executable)) throw new Error('Executable contains unsupported characters');
  let ssh: StoredExecutionProfile['ssh'];
  if (target === 'ssh_linux') {
    const host = String(raw.ssh?.host ?? '').trim();
    const remoteWorkingDirectory = String(raw.ssh?.remoteWorkingDirectory ?? '').trim();
    const sshExecutable = String(raw.ssh?.executable ?? '').trim();
    const scpExecutable = String(raw.ssh?.scpExecutable ?? '').trim();
    if (!/^[A-Za-z0-9_.@-]+$/.test(host)) throw new Error('SSH host is invalid');
    if (!/^\/[A-Za-z0-9_./-]+$/.test(remoteWorkingDirectory)
      || remoteWorkingDirectory.split('/').includes('..')) {
      throw new Error('SSH working directory must be a shell-safe absolute Linux path');
    }
    if (/[\r\n\0]/.test(sshExecutable)) throw new Error('SSH executable contains unsupported characters');
    if (/[\r\n\0]/.test(scpExecutable)) throw new Error('SCP executable contains unsupported characters');
    ssh = {
      host,
      remoteWorkingDirectory,
      ...(sshExecutable ? { executable: sshExecutable } : {}),
      ...(scpExecutable ? { scpExecutable } : {}),
    };
  }
  return {
    schema: 'actoviq.execution-profile.v1',
    id,
    providerId,
    target,
    ...(executable ? { executable } : {}),
    allowedRoots,
    environmentKeys,
    ...(ssh ? { ssh } : {}),
    qualification: raw.qualification === 'native_verified' || raw.qualification === 'configured'
      ? raw.qualification
      : 'unverified',
  };
}

export async function loadExecutionProfileRegistry(
  registryPath = defaultRegistryPath,
): Promise<ExecutionProfileRegistry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as {
      schema?: string;
      profiles?: unknown[];
    };
    if (parsed.schema !== 'actoviq.execution-profile-registry.v1' || !Array.isArray(parsed.profiles)) {
      throw new Error('Execution profile registry has an unsupported schema');
    }
    return {
      schema: 'actoviq.execution-profile-registry.v1',
      profiles: parsed.profiles.map(validateStoredExecutionProfile),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: 'actoviq.execution-profile-registry.v1', profiles: [] };
    }
    throw error;
  }
}

async function persistRegistry(
  registry: ExecutionProfileRegistry,
  registryPath: string,
): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, registryPath);
}

export async function saveExecutionProfile(
  input: unknown,
  registryPath = defaultRegistryPath,
): Promise<ExecutionProfileRegistry> {
  const profile = validateStoredExecutionProfile(input);
  const registry = await loadExecutionProfileRegistry(registryPath);
  const profiles = registry.profiles.filter((entry) => entry.id !== profile.id);
  profiles.push(profile);
  profiles.sort((left, right) => left.id.localeCompare(right.id));
  const next = { ...registry, profiles };
  await persistRegistry(next, registryPath);
  return next;
}

export async function deleteExecutionProfile(
  id: string,
  registryPath = defaultRegistryPath,
): Promise<ExecutionProfileRegistry> {
  const registry = await loadExecutionProfileRegistry(registryPath);
  const profiles = registry.profiles.filter((entry) => entry.id !== id);
  if (profiles.length === registry.profiles.length) throw new Error(`Execution profile not found: ${id}`);
  const next = { ...registry, profiles };
  await persistRegistry(next, registryPath);
  return next;
}

export async function resolveExecutionProfile(
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
  registryPath = defaultRegistryPath,
): Promise<ResolvedExecutionProfile> {
  const registry = await loadExecutionProfileRegistry(registryPath);
  const stored = registry.profiles.find((entry) => entry.id === id);
  if (!stored) throw new Error(`Execution profile not found: ${id}`);
  const environmentValues = Object.fromEntries(
    stored.environmentKeys.flatMap((key) => (
      environment[key] === undefined ? [] : [[key, environment[key]!]]
    )),
  );
  return {
    schema: stored.schema,
    id: stored.id,
    providerId: stored.providerId,
    target: stored.target,
    executable: stored.executable,
    allowedRoots: stored.allowedRoots,
    environment: environmentValues,
    allowedEnvironmentKeys: stored.environmentKeys,
    ssh: stored.ssh,
    qualification: stored.qualification,
  };
}

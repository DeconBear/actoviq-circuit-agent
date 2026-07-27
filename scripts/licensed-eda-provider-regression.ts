import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  LICENSED_PROVIDER_DEFINITIONS,
  LicensedEdaProvider,
  type LicensedExecutionProfile,
} from '../src/eda/licensedEdaProviders.js';
import {
  deleteExecutionProfile,
  loadExecutionProfileRegistry,
  resolveExecutionProfile,
  saveExecutionProfile,
} from '../electron/eda/executionProfileRegistry.js';

const target = process.platform === 'win32' ? 'local_windows' : 'local_linux';

function profile(
  root: string,
  providerId: LicensedExecutionProfile['providerId'] = 'cadence_spectre',
  qualification: LicensedExecutionProfile['qualification'] = 'unverified',
): LicensedExecutionProfile {
  return {
    schema: 'actoviq.execution-profile.v1',
    id: `test-${providerId}`,
    providerId,
    target,
    executable: process.execPath,
    allowedRoots: [root],
    environment: {
      LM_LICENSE_FILE: 'secret-license-server',
      UNAPPROVED_SECRET: 'must-not-pass',
    },
    allowedEnvironmentKeys: ['LM_LICENSE_FILE'],
    qualification,
  };
}

async function main(): Promise<void> {
  assert.deepEqual(
    LICENSED_PROVIDER_DEFINITIONS.map((entry) => entry.id),
    [
      'cadence_spectre',
      'synopsys_primesim_hspice',
      'synopsys_primesim_xa',
      'siemens_afs',
      'cadence_xcelium_ams',
      'synopsys_vcs_ams',
      'siemens_questa_ams',
    ],
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-licensed-eda-'));
  const registryPath = path.resolve(root, 'execution-profiles.json');
  const deck = path.resolve(root, 'deck.cir');
  const output = path.resolve(root, 'results');
  await writeFile(deck, 'Title\n.end\n', 'utf8');
  await mkdir(output);

  const storedProfile = {
    schema: 'actoviq.execution-profile.v1' as const,
    id: 'spectre-local',
    providerId: 'cadence_spectre' as const,
    target,
    executable: process.execPath,
    allowedRoots: [root],
    environmentKeys: ['LM_LICENSE_FILE'],
    qualification: 'unverified' as const,
  };
  await saveExecutionProfile(storedProfile, registryPath);
  const registry = await loadExecutionProfileRegistry(registryPath);
  assert.equal(registry.profiles.length, 1);
  const persistedText = await readFile(registryPath, 'utf8');
  assert.ok(!persistedText.includes('secret-license-server'));
  const resolvedProfile = await resolveExecutionProfile(
    'spectre-local',
    { LM_LICENSE_FILE: 'secret-license-server' },
    registryPath,
  );
  assert.equal(resolvedProfile.environment?.LM_LICENSE_FILE, 'secret-license-server');
  await assert.rejects(
    saveExecutionProfile({ ...storedProfile, environmentKeys: ['UNAPPROVED_SECRET'] }, registryPath),
    /not an allowed environment key/,
  );

  const definition = {
    id: 'cadence_spectre' as const,
    displayName: 'Fake Spectre',
    domain: 'analog' as const,
    executable: process.execPath,
    versionArgs: ['--version'],
    environmentKeys: ['LM_LICENSE_FILE'],
    prepareArgs: () => [
      '-e',
      'process.stdout.write("gain = 2.5\\nlicense=" + process.env.LM_LICENSE_FILE)',
    ],
  };
  const provider = new LicensedEdaProvider(profile(root), definition);
  const capability = await provider.probe();
  assert.equal(capability.available, true);
  const job = {
    id: 'spectre-run',
    kind: 'simulation',
    cwd: root,
    inputPath: deck,
    outputDirectory: output,
    sourceRevision: 4,
    pdkFingerprint: 'pdk-hash',
  };
  const prepared = await provider.prepare(job);
  assert.equal(prepared.env?.LM_LICENSE_FILE, 'secret-license-server');
  assert.equal(prepared.env?.UNAPPROVED_SECRET, undefined);
  const execution = await provider.run(prepared);
  assert.equal(execution.code, 0);
  assert.ok(!execution.stdout.includes('secret-license-server'));
  const result = await provider.parse(job, execution) as unknown as {
    status: string;
    qualification: string;
    measured: boolean;
    amsVerified: boolean;
    measurements: Array<{ name: string; value: number }>;
  };
  assert.equal(result.status, 'passed');
  assert.equal(result.qualification, 'unverified');
  assert.equal(result.measured, true);
  assert.equal(result.amsVerified, false);
  assert.deepEqual(result.measurements, [{ name: 'gain', value: 2.5 }]);

  const amsDefinition = {
    ...definition,
    id: 'cadence_xcelium_ams' as const,
    domain: 'ams' as const,
  };
  const amsProvider = new LicensedEdaProvider(
    profile(root, 'cadence_xcelium_ams', 'native_verified'),
    amsDefinition,
  );
  const amsPrepared = await amsProvider.prepare({ ...job, id: 'ams-run', kind: 'ams' });
  const amsExecution = await amsProvider.run(amsPrepared);
  const amsResult = await amsProvider.parse(
    { ...job, id: 'ams-run', kind: 'ams' },
    amsExecution,
  ) as unknown as { amsVerified: boolean };
  assert.equal(amsResult.amsVerified, true);

  await assert.rejects(
    provider.prepare({
      ...job,
      inputPath: path.resolve(root, '..', 'outside.cir'),
    }),
    /outside the execution profile allowlist/,
  );

  await deleteExecutionProfile('spectre-local', registryPath);
  assert.equal((await loadExecutionProfileRegistry(registryPath)).profiles.length, 0);

  const sshProfile: LicensedExecutionProfile = {
    ...profile(root),
    target: 'ssh_linux',
    ssh: {
      host: 'eda-user@licensed-host',
      remoteWorkingDirectory: '/work/actoviq',
    },
  };
  const sshProvider = new LicensedEdaProvider(sshProfile, definition);
  const sshPrepared = await sshProvider.prepare({
    ...job,
    inputPath: '/work/actoviq/deck.cir',
    outputDirectory: '/work/actoviq/results',
  });
  assert.equal(sshPrepared.env && Object.keys(sshPrepared.env).length, 0);
  await assert.rejects(
    sshProvider.prepare({ ...job, inputPath: 'relative.cir', outputDirectory: '/tmp/out' }),
    /absolute Linux path/,
  );

  process.stdout.write('licensed EDA provider regression passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

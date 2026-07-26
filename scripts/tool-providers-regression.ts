import assert from 'node:assert/strict';
import process from 'node:process';

import {
  classifyToolFailure,
  redactToolText,
  runPreparedTool,
  sanitizeEnvironment,
} from '../src/eda/toolProvider.js';

async function main(): Promise<void> {
  const execution = await runPreparedTool({
    id: 'provider-smoke',
    kind: 'probe',
    cwd: process.cwd(),
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    timeoutMs: 5_000,
  }, process.platform === 'win32' ? 'local_windows' : 'local_linux');
  assert.equal(execution.code, 0);
  assert.equal(execution.stdout, 'ok');
  assert.equal(execution.failureKind, undefined);

  assert.equal(classifyToolFailure(1, 'FlexNet license checkout failed'), 'license');
  assert.equal(classifyToolFailure(1, 'singular matrix; convergence failed'), 'convergence');
  assert.equal(redactToolText('TOKEN=abcdefghi', ['abcdefghi']), 'TOKEN=[redacted]');
  assert.deepEqual(
    sanitizeEnvironment({ PATH: 'bin', SECRET: 'nope' }, ['PATH']),
    { PATH: 'bin' },
  );

  const timeout = await runPreparedTool({
    id: 'provider-timeout',
    kind: 'probe',
    cwd: process.cwd(),
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 20,
  }, process.platform === 'win32' ? 'local_windows' : 'local_linux');
  assert.equal(timeout.failureKind, 'timeout');
  process.stdout.write('tool provider regression passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

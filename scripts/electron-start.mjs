#!/usr/bin/env node
/**
 * Cross-platform `electron:start`: load dist-renderer without Vite.
 * Avoids Unix-only `VAR=value cmd` which breaks under Windows cmd.exe.
 */
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ACTOVIQ_USE_BUILT_RENDERER: '1',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

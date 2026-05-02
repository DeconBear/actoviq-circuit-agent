#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const binDir = path.dirname(currentFile);
const packageRoot = path.resolve(binDir, '..');
const sourceEntry = path.resolve(packageRoot, 'src', 'app.ts');
const distEntry = path.resolve(packageRoot, 'dist', 'app.js');
const tsxCli = path.resolve(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function isLinkedDevelopmentCheckout() {
  return !packageRoot.toLowerCase().includes(`${path.sep}node_modules${path.sep}`);
}

function runNode(entry, extraArgs) {
  const child = spawnSync(process.execPath, [entry, ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  if (child.error) {
    console.error(child.error);
    process.exit(1);
  }
  if (child.signal) {
    process.kill(process.pid, child.signal);
  }
  process.exit(child.status ?? 0);
}

function main() {
  const args = process.argv.slice(2);
  const preferredMode = process.env.ACTOVIQ_CIRCUIT_AGENT_BIN_MODE?.trim().toLowerCase();
  const canRunSource = existsSync(sourceEntry) && existsSync(tsxCli);
  const canRunDist = existsSync(distEntry);

  if ((preferredMode === 'source' || (!preferredMode && isLinkedDevelopmentCheckout())) && canRunSource) {
    runNode(tsxCli, [sourceEntry, ...args]);
  }

  if (preferredMode === 'dist' && canRunDist) {
    runNode(distEntry, args);
  }

  if (canRunDist) {
    runNode(distEntry, args);
  }

  if (canRunSource) {
    runNode(tsxCli, [sourceEntry, ...args]);
  }

  console.error('actoviq-circuit-agent bootstrap failed: neither dist/app.js nor src/app.ts is runnable.');
  console.error(`package root: ${packageRoot}`);
  console.error(`checked dist entry: ${distEntry}`);
  console.error(`checked source entry: ${sourceEntry}`);
  process.exit(1);
}

main();

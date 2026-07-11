import { app, IpcMain } from 'electron';
import { cp, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

interface SkillManifest {
  schema: string;
  skill: string;
  skill_version: string;
  protocol_version: string;
}

interface SkillTargetStatus {
  agent: 'codex' | 'claude';
  path: string;
  effectivePath: string;
  status: 'current' | 'outdated' | 'missing';
  installedVersion?: string;
}

export interface CircuitSkillStatus {
  sourcePath: string;
  sourceVersion: string;
  protocolVersion: string;
  current: boolean;
  targets: SkillTargetStatus[];
}

function sourceSkillRoot(): string {
  const candidates = [
    path.resolve(app.getAppPath(), 'skills', 'circuit-design-ngspice'),
    path.resolve(process.resourcesPath, 'skills', 'circuit-design-ngspice'),
  ];
  const source = candidates.find((candidate) => existsSync(path.resolve(candidate, 'skill-version.json')));
  if (!source) throw new Error('Bundled circuit-design-ngspice skill manifest is missing.');
  return source;
}

function installTargets(): Array<{ agent: 'codex' | 'claude'; path: string }> {
  return [
    { agent: 'codex', path: path.resolve(homedir(), '.codex', 'skills', 'circuit-design-ngspice') },
    { agent: 'claude', path: path.resolve(homedir(), '.claude', 'skills', 'circuit-design-ngspice') },
  ];
}

async function readManifest(root: string): Promise<SkillManifest | null> {
  try {
    return JSON.parse(await readFile(path.resolve(root, 'skill-version.json'), 'utf8')) as SkillManifest;
  } catch {
    return null;
  }
}

async function effectiveTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

export async function inspectCircuitSkillStatus(): Promise<CircuitSkillStatus> {
  const sourcePath = sourceSkillRoot();
  const source = await readManifest(sourcePath);
  if (!source) throw new Error('Bundled circuit skill version manifest is invalid.');
  const targets: SkillTargetStatus[] = [];
  for (const target of installTargets()) {
    const effectivePath = await effectiveTarget(target.path);
    const installed = await readManifest(effectivePath);
    const current = Boolean(
      installed
      && installed.skill_version === source.skill_version
      && installed.protocol_version === source.protocol_version
    );
    targets.push({
      agent: target.agent,
      path: target.path,
      effectivePath,
      status: current ? 'current' : existsSync(effectivePath) ? 'outdated' : 'missing',
      installedVersion: installed?.skill_version,
    });
  }
  return {
    sourcePath,
    sourceVersion: source.skill_version,
    protocolVersion: source.protocol_version,
    current: targets.every((target) => target.status === 'current'),
    targets,
  };
}

async function syncCircuitSkills(): Promise<CircuitSkillStatus> {
  const status = await inspectCircuitSkillStatus();
  const syncedTargets = new Set<string>();
  for (const target of status.targets) {
    if (target.status === 'current') continue;
    const normalizedTarget = path.normalize(target.effectivePath).toLowerCase();
    if (syncedTargets.has(normalizedTarget)) continue;
    syncedTargets.add(normalizedTarget);
    const staging = `${target.effectivePath}.sync-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(target.effectivePath), { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await cp(status.sourcePath, staging, {
      recursive: true,
      filter: (source) => !/(?:^|[\\/])__pycache__(?:[\\/]|$)|\.(?:pyc|pyo)$/.test(source),
    });
    await rm(target.effectivePath, { recursive: true, force: true });
    await rename(staging, target.effectivePath);
  }
  return inspectCircuitSkillStatus();
}

export function registerSkillHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('skill:circuit-status', async () => inspectCircuitSkillStatus());
  ipcMain.handle('skill:circuit-sync', async () => syncCircuitSkills());
}

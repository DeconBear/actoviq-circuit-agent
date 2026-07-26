/**
 * Visual check: launch the desktop app against an isolated copy of the real
 * buck-boost-2 project and screenshot the auto-laid-out power_stage schematic.
 * Artifacts: output/playwright/buckboost-{workbench,editor}.png
 *
 * Run: node scripts/playwright-buckboost-visual.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { _electron: electron } = await import('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const e2eRunRoot = path.resolve(outputRoot, '.workspace', `visual-buckboost-${process.pid}-${Date.now()}`);
const workspaceRoot = path.resolve(e2eRunRoot, 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const sourceProject = path.resolve(root, 'workspace', 'workspaces', 'default', 'projects', 'buck-boost-2');
const vitePort = await allocatePort();
const viteUrl = `http://127.0.0.1:${vitePort}`;
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 5199;
      server.close(() => resolve(port));
    });
  });
}

async function canFetch(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function startVite() {
  const child = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort'], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await canFetch(viteUrl)) return child;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error('vite did not start');
}

await mkdir(projectsRoot, { recursive: true });
await cp(sourceProject, path.resolve(projectsRoot, 'buck-boost-2'), { recursive: true });
await mkdir(outputRoot, { recursive: true });

const viteProcess = await startVite();
const e2eUserDataDir = path.resolve(e2eRunRoot, 'electron-user-data');
const e2eHomeDir = path.resolve(e2eRunRoot, 'home');
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
await mkdir(e2eUserDataDir, { recursive: true });
await mkdir(e2eHomeDir, { recursive: true });
const electronApp = await electron.launch({
  args: [`--user-data-dir=${e2eUserDataDir}`, '--no-sandbox', '--disable-gpu-sandbox', '.'],
  cwd: root,
  env: {
    ...process.env,
    ACTOVIQ_E2E: '1',
    ACTOVIQ_E2E_WORKSPACE_ROOT: workspaceRoot,
    ACTOVIQ_RENDERER_URL: viteUrl,
    HOME: e2eHomeDir,
    USERPROFILE: e2eHomeDir,
    PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  slowMo: 50,
});

let succeeded = false;
try {
  const page = electronApp.windows()[0] ?? await electronApp.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await page.getByTestId('sidebar-project-buck-boost-2').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="circuit-workbench"]');
    return node?.getAttribute('data-project-id') === 'buck-boost-2';
  });
  await page.getByTestId('module-card-power_stage').waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.resolve(outputRoot, 'buckboost-workbench.png'), fullPage: false });
  console.log('[visual] workbench captured');

  const card = page.getByTestId('module-card-power_stage');
  await card.evaluate((node) => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2, view: window }));
  });
  await page.waitForSelector('[data-testid="schematic-editor"]', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-busy') === 'false' && node?.getAttribute('data-preview-busy') === 'false';
  });
  await page.getByTestId('schematic-editor-fit').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.resolve(outputRoot, 'buckboost-editor.png'), fullPage: false });
  console.log('[visual] editor captured');
  succeeded = true;
} finally {
  await electronApp.close().catch(() => null);
  viteProcess.kill();
  if (!succeeded) process.exitCode = 1;
}
assert.ok(succeeded);
console.log('[visual] ok');

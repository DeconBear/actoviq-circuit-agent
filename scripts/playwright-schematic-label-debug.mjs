/**
 * Focused Playwright debug for schematic label overlap + selection chrome.
 * Reproduces the half-bridge MOS stage from the interaction-bug screenshots.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { _electron: electron } = await import('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const runId = Date.now().toString(36);
const e2eRunRoot = path.resolve(outputRoot, '.workspace', `label-debug-${process.pid}-${runId}`);
const workspaceRoot = path.resolve(e2eRunRoot, 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const projectPrefix = 'playwright-label-debug-';
const vitePort = Number(process.env.ACTOVIQ_E2E_VITE_PORT ?? (await allocatePort()));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const skillScript = path.resolve(root, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py');

function runSkill(args) {
  return JSON.parse(execFileSync('python', [skillScript, ...args], {
    cwd: root,
    encoding: 'utf8',
  }));
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 5173;
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

async function startViteIfNeeded() {
  let exited = null;
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Vite exited early: ${JSON.stringify(exited)}`);
    if (await canFetch(viteUrl)) {
      await fetch(`${viteUrl}/src/main.tsx`).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`Timed out waiting for Vite at ${viteUrl}`);
}

async function removePrefixedProjects() {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(projectPrefix)) continue;
    await rm(path.resolve(projectsRoot, entry.name), { recursive: true, force: true });
  }
}

async function createHalfBridgeProject() {
  const projectId = `${projectPrefix}half-bridge-${runId}`;
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${projectPrefix}half-bridge-${Date.now()}`,
    '--project-id', projectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  const modulePorts = [
    { id: 'sw', name: 'IN', direction: 'inout', signal_type: 'analog', net: 'sw' },
    { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'half_bridge',
    name: 'Half bridge switch',
    kind: 'switch',
    function: 'PMOS/NMOS half-bridge used to debug label overlap and selection chrome.',
    parameters: {},
    notes: '',
    preview_enabled: true,
    source: 'modules/half_bridge/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 420, height: 280 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'half_bridge',
    name: 'Half bridge switch',
    revision: 0,
    ports: modulePorts,
    components: [
      {
        id: 'm1',
        type: 'M',
        name: 'M1',
        value: 'PMOS W=100U L=1U',
        position: { x: 280, y: 220 },
        rotation: 0,
        pins: [
          { id: 'd', name: 'D', net: 'sw' },
          { id: 'g', name: 'G', net: 'vg1' },
          { id: 's', name: 'S', net: 'vin' },
          { id: 'b', name: 'B', net: 'vin' },
        ],
      },
      {
        id: 'm2',
        type: 'M',
        name: 'M2',
        value: 'NMOS W=100U L=1U',
        position: { x: 460, y: 320 },
        rotation: 0,
        pins: [
          { id: 'd', name: 'D', net: 'sw' },
          { id: 'g', name: 'G', net: 'vg2' },
          { id: 's', name: 'S', net: '0' },
          { id: 'b', name: 'B', net: '0' },
        ],
      },
      {
        id: 'vin',
        type: 'V',
        name: 'Vin',
        value: 'DC 12',
        position: { x: 160, y: 140 },
        rotation: 90,
        pins: [
          { id: 'p', name: '+', net: 'vin' },
          { id: 'n', name: '-', net: '0' },
        ],
      },
      {
        id: 'vg1',
        type: 'V',
        name: 'vg1',
        value: 'PULSE(12 0 0 10N 10N 4U 10U)',
        position: { x: 160, y: 260 },
        rotation: 90,
        pins: [
          { id: 'p', name: '+', net: 'vg1' },
          { id: 'n', name: '-', net: '0' },
        ],
      },
      {
        id: 'vg2',
        type: 'V',
        name: 'vg2',
        value: 'PULSE(0 5 4.4U 10N 10N 5.4U 10U)',
        position: { x: 340, y: 360 },
        rotation: 90,
        pins: [
          { id: 'p', name: '+', net: 'vg2' },
          { id: 'n', name: '-', net: '0' },
        ],
      },
    ],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'half_bridge');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# Half bridge switch',
    '',
    '```spice',
    'Vin vin 0 DC 12',
    'Vg1 vg1 0 PULSE(12 0 0 10N 10N 4U 10U)',
    'Vg2 vg2 0 PULSE(0 5 4.4U 10N 10N 5.4U 10U)',
    'M1 sw vg1 vin vin PMOS W=100U L=1U',
    'M2 sw vg2 0 0 NMOS W=100U L=1U',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

await mkdir(projectsRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });
await removePrefixedProjects();
const halfBridge = await createHalfBridgeProject();
const viteProcess = await startViteIfNeeded();
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
  slowMo: 40,
});

let page;
let testSucceeded = false;
try {
  page = electronApp.windows()[0] ?? await electronApp.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await page.getByTestId(`sidebar-project-${halfBridge.projectId}`).click();
  await page.waitForFunction((projectId) => (
    document.querySelector('[data-testid="circuit-workbench"]')?.getAttribute('data-project-id') === projectId
  ), halfBridge.projectId);
  await page.getByTestId('module-card-half_bridge').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'half_bridge'
  ));
  await page.waitForTimeout(500);

  const beforeSelect = path.resolve(outputRoot, 'schematic-label-debug-half-bridge.png');
  await page.screenshot({ path: beforeSelect });
  console.log(`[debug] screenshot ${beforeSelect}`);

  const labelReport = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="schematic-editor-svg"]');
    if (!(svg instanceof SVGSVGElement)) throw new Error('missing schematic svg');
    const texts = [...svg.querySelectorAll('[data-testid="schematic-component-name-label"], [data-testid="schematic-component-value-label"], [data-testid="schematic-net-label-text"]')]
      .filter((node) => node instanceof SVGGraphicsElement)
      .map((node) => {
        const box = node.getBBox();
        return {
          testId: node.getAttribute('data-testid'),
          text: (node.textContent ?? '').trim(),
          fullValue: node.getAttribute('data-full-value') ?? '',
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        };
      })
      .filter((entry) => entry.text.length > 0);

    const overlaps = [];
    for (let i = 0; i < texts.length; i += 1) {
      for (let j = i + 1; j < texts.length; j += 1) {
        const a = texts[i];
        const b = texts[j];
        const pad = 2;
        const intersect = !(
          a.x + a.width + pad <= b.x
          || b.x + b.width + pad <= a.x
          || a.y + a.height + pad <= b.y
          || b.y + b.height + pad <= a.y
        );
        if (intersect) overlaps.push({ a: a.text, b: b.text, aTestId: a.testId, bTestId: b.testId });
      }
    }

    const pulseRendered = texts
      .filter((entry) => entry.testId === 'schematic-component-value-label')
      .filter((entry) => /PULSE\s*\(/i.test(entry.fullValue || entry.text))
      .map((entry) => ({ text: entry.text, fullValue: entry.fullValue }));

    return { texts, overlaps, pulseRendered };
  });

  console.log('[debug] label count', labelReport.texts.length);
  console.log('[debug] pulse labels', JSON.stringify(pulseRenderedSafe(labelReport.pulseRendered)));
  console.log('[debug] overlaps', JSON.stringify(labelReport.overlaps, null, 2));

  for (const pulse of labelReport.pulseRendered) {
    assert.equal(pulse.text, 'PULSE(...)', `long PULSE value should render compacted, got "${pulse.text}"`);
  }

  const severe = labelReport.overlaps.filter((entry) => {
    const pair = `${entry.a}||${entry.b}`;
    // Allow name+value of the same component to sit close; flag cross-component / net collisions.
    if (/^M\d+$/.test(entry.a) && /MOS/.test(entry.b)) return false;
    if (/^M\d+$/.test(entry.b) && /MOS/.test(entry.a)) return false;
    if (/^vg\d+$/i.test(entry.a) && entry.b === 'PULSE(...)') return false;
    if (/^vg\d+$/i.test(entry.b) && entry.a === 'PULSE(...)') return false;
    if (entry.a === 'Vin' && entry.b === 'DC 12') return false;
    if (entry.b === 'Vin' && entry.a === 'DC 12') return false;
    return true;
  });
  assert.deepEqual(severe, [], 'half-bridge schematic still has severe cross-label overlaps');

  // Select M2 and ensure only one component selection frame (no fragmented net-label frames).
  const m2Point = await page.getByTestId('schematic-editor-svg').evaluate((svg) => {
    if (!(svg instanceof SVGSVGElement)) throw new Error('missing svg');
    const positions = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}');
    const m2 = positions.m2;
    if (!m2) throw new Error('m2 missing');
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error('no CTM');
    const point = svg.createSVGPoint();
    point.x = Number(m2.x);
    point.y = Number(m2.y);
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(m2Point.x, m2Point.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:m2'
  ));
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 1);
  assert.equal(await page.getByTestId('schematic-selected-net-label-frame').count(), 0);

  const afterSelect = path.resolve(outputRoot, 'schematic-label-debug-half-bridge-selected.png');
  await page.screenshot({ path: afterSelect });
  console.log(`[debug] screenshot ${afterSelect}`);

  // Compact SW net must stay wired — no floating signal labels.
  assert.equal(
    await page.locator('[data-testid="schematic-net-label"][data-kind="signal"][data-net="sw"]').count(),
    0,
    'compact SW net must not render floating signal labels',
  );

  testSucceeded = true;
  console.log('[debug] half-bridge label/selection checks passed');
} finally {
  await electronApp.close().catch(() => undefined);
  viteProcess.kill();
  await removePrefixedProjects().catch(() => undefined);
}

assert.equal(testSucceeded, true, 'label debug did not complete successfully');

function pulseRenderedSafe(entries) {
  return entries;
}

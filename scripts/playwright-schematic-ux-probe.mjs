/**
 * Interactive UX probe for the schematic editor, modeled on qucs_s
 * (https://github.com/ra3xdh/qucs_s) schematic interaction conventions.
 *
 * Unlike the smoke test this script does NOT assert the desired behavior;
 * it operates the real app via Playwright and records what actually happens
 * so interaction gaps can be identified and then fixed. Findings and
 * screenshots are written to output/playwright/.
 *
 * Probes (qucs_s reference behavior in parentheses):
 *  P1  place persistence   (place mode stays active after each placement)
 *  P2  ghost preview        (symbol preview follows the cursor while placing)
 *  P3  rotate-while-placing (R / right-click rotates the pending symbol)
 *  P4  right-click cancel   (ESC cancels placement; right-click rotates)
 *  P5  double-click edit    (double-click a component edits its value)
 *  P6  wire double-click    (double-click ends the in-progress wire)
 *  P7  wire right-click     (right-click cancels the in-progress wire)
 *  P8  wire chain after pin (landing on a pin keeps chaining - informational)
 *  P9  ctrl+wheel zoom      (wheel zoom is cursor centered - informational)
 *  P10 initial layout shot  (visual layout/routing quality inspection)
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
const e2eRunRoot = path.resolve(outputRoot, '.workspace', `ux-probe-${process.pid}-${runId}`);
const workspaceRoot = path.resolve(e2eRunRoot, 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const projectPrefix = 'playwright-ux-probe-';
const vitePort = Number(process.env.ACTOVIQ_E2E_VITE_PORT ?? (await allocatePort()));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const skillScript = path.resolve(root, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py');

const findings = [];
function record(id, qucsBehavior, actual, verdict, extra = undefined) {
  findings.push({ id, qucsBehavior, actual, verdict, extra });
  console.log(`[probe] ${id}: ${verdict} — ${actual}`);
}

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

async function editorAttr(page, name) {
  return page.getByTestId('schematic-editor').getAttribute(name);
}

async function editorViewBox(page) {
  const raw = await page.getByTestId('schematic-editor-svg').getAttribute('viewBox');
  const [minX, minY, width, height] = String(raw || '0 0 1 1').trim().split(/\s+/).map(Number);
  return { minX, minY, width, height };
}

function worldToScreen(point, viewBox, svgBox) {
  const scale = Math.min(svgBox.width / viewBox.width, svgBox.height / viewBox.height);
  const xOffset = (svgBox.width - viewBox.width * scale) / 2;
  const yOffset = (svgBox.height - viewBox.height * scale) / 2;
  return {
    x: svgBox.x + xOffset + (point.x - viewBox.minX) * scale,
    y: svgBox.y + yOffset + (point.y - viewBox.minY) * scale,
  };
}

async function worldPointToScreen(page, point) {
  const viewBox = await editorViewBox(page);
  const svgBox = await page.getByTestId('schematic-editor-svg').boundingBox();
  assert.ok(svgBox, 'editor svg has no bounding box');
  return worldToScreen(point, viewBox, svgBox);
}

async function componentPositions(page) {
  return JSON.parse((await editorAttr(page, 'data-component-positions')) || '{}');
}

async function componentRotations(page) {
  return JSON.parse((await editorAttr(page, 'data-component-rotations')) || '{}');
}

async function editorWires(page) {
  return JSON.parse((await editorAttr(page, 'data-wires')) || '[]');
}

async function waitForEditorIdle(page) {
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-busy') === 'false' &&
      node?.getAttribute('data-preview-busy') === 'false';
  });
}

/** Pick a free world point (snapped to grid) away from all components/ports,
 *  clamped inside the current viewBox so the click always lands on canvas. */
async function freeWorldPoint(page, preferred) {
  const positions = await componentPositions(page);
  const ports = JSON.parse((await editorAttr(page, 'data-port-positions')) || '{}');
  const occupied = [...Object.values(positions), ...Object.values(ports)];
  const viewBox = await editorViewBox(page);
  const snap = (value) => Math.round(value / 20) * 20;
  const clampX = (value) => Math.min(Math.max(value, viewBox.minX + 60), viewBox.minX + viewBox.width - 60);
  const clampY = (value) => Math.min(Math.max(value, viewBox.minY + 60), viewBox.minY + viewBox.height - 60);
  let candidate = { x: snap(clampX(preferred.x)), y: snap(clampY(preferred.y)) };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const clear = occupied.every((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) > 90);
    if (clear) return candidate;
    candidate = {
      x: snap(clampX(candidate.x + (attempt % 3 === 0 ? -80 : 60))),
      y: snap(clampY(candidate.y + (attempt % 2 === 0 ? 60 : -60))),
    };
  }
  return candidate;
}

async function waitForWorkbenchProject(page, targetProjectId) {
  await page.waitForFunction((projectId) => {
    const node = document.querySelector('[data-testid="circuit-workbench"]');
    return node?.getAttribute('data-project-id') === projectId &&
      node?.getAttribute('data-action-project-id') === projectId;
  }, targetProjectId);
}

await mkdir(outputRoot, { recursive: true });
await removePrefixedProjects();

const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright UX Probe ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectRoot = created.project_root;
for (const module of created.project.modules) {
  const compiled = runSkill(['compile-module', '--project-root', projectRoot, '--module-id', module.id]);
  assert.equal(compiled.render.ok, true);
}

const viteProcess = await startViteIfNeeded();
const pageErrors = [];
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

let page;
try {
  page = electronApp.windows()[0] ?? await electronApp.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.waitForTimeout(1000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-component-count') === '2' &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });
  await page.getByTestId('schematic-editor-svg').waitFor({ timeout: 20_000 });
  await waitForEditorIdle(page);
  console.log('[probe] editor open on demo filter module');

  // ---- P10: initial layout screenshot for visual inspection ----
  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-10-initial-layout.png') });

  const positions = await componentPositions(page);
  const xs = Object.values(positions).map((p) => p.x);
  const ys = Object.values(positions).map((p) => p.y);
  const farRight = { x: Math.max(...xs) + 240, y: Math.min(...ys) };

  // ---- P2: ghost preview while placing ----
  await page.getByTestId('schematic-editor-place-R').click();
  assert.equal(await editorAttr(page, 'data-tool'), 'place', 'place tool should be active after toolbar click');
  const hoverSpot = await freeWorldPoint(page, farRight);
  const hoverScreen = await worldPointToScreen(page, hoverSpot);
  await page.mouse.move(hoverScreen.x, hoverScreen.y);
  await page.waitForTimeout(300);
  const ghostCount = await page.getByTestId('schematic-editor-svg')
    .locator('[data-testid="schematic-place-ghost"], [data-testid="schematic-placement-preview"]')
    .count();
  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-02-place-mode-hover.png') });
  record('P2-ghost-preview', 'symbol preview follows cursor while placing',
    ghostCount > 0 ? 'ghost preview rendered at cursor' : 'no placement preview at cursor (blind placement)',
    ghostCount > 0 ? 'ok' : 'gap');

  // ---- P1: place mode persistence ----
  await page.mouse.click(hoverScreen.x, hoverScreen.y);
  await waitForEditorIdle(page);
  const toolAfterPlace = await editorAttr(page, 'data-tool');
  record('P1-place-persistence', 'place mode stays active so another part can be placed immediately',
    `after placing one resistor data-tool="${toolAfterPlace}"`,
    toolAfterPlace === 'place' ? 'ok' : 'gap');

  // If still in place mode, a second click places another resistor; otherwise re-enter.
  const beforeSecond = await componentPositions(page);
  if (toolAfterPlace !== 'place') {
    await page.getByTestId('schematic-editor-place-R').click();
  }
  const secondSpot = await freeWorldPoint(page, { x: hoverSpot.x + 160, y: hoverSpot.y + 120 });
  const secondScreen = await worldPointToScreen(page, secondSpot);
  await page.mouse.click(secondScreen.x, secondScreen.y);
  await waitForEditorIdle(page);
  const afterSecond = await componentPositions(page);
  const newIds = Object.keys(afterSecond).filter((id) => !(id in beforeSecond));
  assert.ok(newIds.length >= 1, 'second resistor was not placed');

  // ---- P3: rotate while placing (R hotkey) ----
  if ((await editorAttr(page, 'data-tool')) !== 'place') {
    await page.getByTestId('schematic-editor-place-R').click();
  }
  const selectedBeforeR = (await editorAttr(page, 'data-selected')) || '';
  const rotationsBeforeR = await componentRotations(page);
  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  const rotationsAfterR = await componentRotations(page);
  const selectedId = selectedBeforeR.replace('component:', '');
  const selectedRotated = selectedId && rotationsBeforeR[selectedId] !== rotationsAfterR[selectedId];
  const thirdSpot = await freeWorldPoint(page, { x: hoverSpot.x, y: hoverSpot.y + 240 });
  const thirdScreen = await worldPointToScreen(page, thirdSpot);
  const rotationsBefore = await componentRotations(page);
  await page.mouse.click(thirdScreen.x, thirdScreen.y);
  await waitForEditorIdle(page);
  const rotationsAfter = await componentRotations(page);
  const placedId = Object.keys(rotationsAfter).filter((id) => !(id in rotationsBefore)).pop();
  const placedRotation = placedId ? rotationsAfter[placedId] : null;
  record('P3-rotate-while-placing', 'R (or right-click) rotates the pending symbol before placement',
    placedRotation === null
      ? `no component placed; pressing R ${selectedRotated ? 'rotated the SELECTED component instead' : 'had no effect'}`
      : `placed resistor rotation=${placedRotation}; pressing R ${selectedRotated ? 'also rotated the SELECTED component' : 'left selection untouched'}`,
    Number(placedRotation) !== 0 && placedRotation !== null && !selectedRotated ? 'ok' : 'gap');
  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-03-after-rotated-place.png') });

  // ---- P4: right-click during placement ----
  if ((await editorAttr(page, 'data-tool')) !== 'place') {
    await page.getByTestId('schematic-editor-place-R').click();
  }
  const rcSpot = await freeWorldPoint(page, { x: thirdSpot.x + 200, y: thirdSpot.y });
  const rcScreen = await worldPointToScreen(page, rcSpot);
  await page.mouse.move(rcScreen.x, rcScreen.y);
  await page.mouse.click(rcScreen.x, rcScreen.y, { button: 'right' });
  await page.waitForTimeout(300);
  const toolAfterRightClick = await editorAttr(page, 'data-tool');
  const contextMenuCount = await page.getByTestId('schematic-context-menu').count().catch(() => 0);
  record('P4-right-click-while-placing', 'right-click rotates pending symbol (ESC cancels place mode)',
    `after right-click data-tool="${toolAfterRightClick}", context menu count=${contextMenuCount}`,
    toolAfterRightClick === 'place' ? 'ok(rotate)' : 'info(cancel)');

  // ---- ESC cancels placement ----
  if ((await editorAttr(page, 'data-tool')) === 'place') {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const toolAfterEsc = await editorAttr(page, 'data-tool');
    record('P4b-esc-cancels-placement', 'ESC exits place mode',
      `after ESC data-tool="${toolAfterEsc}"`,
      toolAfterEsc === 'select' ? 'ok' : 'gap');
  } else {
    await page.keyboard.press('Escape');
    record('P4b-esc-cancels-placement', 'ESC exits place mode',
      'place mode already exited by right-click (ESC not required)', 'info');
  }

  // ---- P5: double-click component edits value ----
  const targetId = Object.keys(await componentPositions(page))[0];
  const targetPos = (await componentPositions(page))[targetId];
  const targetScreen = await worldPointToScreen(page, targetPos);
  await page.mouse.click(targetScreen.x, targetScreen.y); // ensure selected
  await page.waitForFunction((id) => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `component:${id}`
  ), targetId, { timeout: 3000 }).catch(() => undefined);
  await page.mouse.dblclick(targetScreen.x, targetScreen.y);
  await page.waitForTimeout(400);
  const dialogCount = await page.locator('[data-testid="schematic-edit-dialog"], [role="dialog"]').count();
  const valueFocused = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    return active.getAttribute('data-testid') === 'schematic-editor-component-value' ||
      active.getAttribute('data-testid') === 'schematic-editor-component-name';
  });
  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-05-after-dblclick.png') });
  record('P5-double-click-edit', 'double-click a component opens/focuses value editing',
    `after dblclick: edit dialog count=${dialogCount}, inspector value focused=${valueFocused}`,
    dialogCount > 0 || valueFocused ? 'ok' : 'gap');
  await page.keyboard.press('Escape');

  // ---- P6: double-click ends wire ----
  await page.getByTestId('schematic-editor-wire').click();
  const wireA = await freeWorldPoint(page, { x: Math.min(...xs) - 80, y: Math.max(...ys) + 260 });
  const wireB = await freeWorldPoint(page, { x: wireA.x + 160, y: wireA.y });
  const wireC = await freeWorldPoint(page, { x: wireB.x, y: wireB.y + 120 });
  const wiresBefore = await editorWires(page);
  const screenA = await worldPointToScreen(page, wireA);
  const screenB = await worldPointToScreen(page, wireB);
  const screenC = await worldPointToScreen(page, wireC);
  await page.mouse.click(screenA.x, screenA.y);
  await page.waitForTimeout(200);
  await page.mouse.click(screenB.x, screenB.y);
  await page.waitForTimeout(200);
  await page.mouse.dblclick(screenC.x, screenC.y);
  await page.waitForTimeout(400);
  const wiresAfterDbl = await editorWires(page);
  const wireStartAfterDbl = await editorAttr(page, 'data-wire-start');
  record('P6-wire-double-click-end', 'double-click ends the in-progress wire',
    `wires ${wiresBefore.length} -> ${wiresAfterDbl.length}, data-wire-start="${wireStartAfterDbl}" after dblclick`,
    wireStartAfterDbl === '' || wireStartAfterDbl === null ? 'ok' : 'gap');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---- P7: right-click cancels in-progress wire ----
  await page.getByTestId('schematic-editor-wire').click();
  const wireD = await freeWorldPoint(page, { x: wireA.x, y: wireA.y + 200 });
  const wireE = await freeWorldPoint(page, { x: wireD.x + 200, y: wireD.y });
  const screenD = await worldPointToScreen(page, wireD);
  const screenE = await worldPointToScreen(page, wireE);
  const wiresBeforeCancel = await editorWires(page);
  await page.mouse.click(screenD.x, screenD.y);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-06-wire-preview.png') });
  await page.mouse.click(screenE.x, screenE.y, { button: 'right' });
  await page.waitForTimeout(300);
  const wiresAfterCancel = await editorWires(page);
  const wireStartAfterCancel = await editorAttr(page, 'data-wire-start');
  const menuAfterWireRight = await page.getByTestId('schematic-context-menu').count().catch(() => 0);
  record('P7-wire-right-click-cancel', 'right-click (or ESC) abandons the in-progress wire',
    `wires ${wiresBeforeCancel.length} -> ${wiresAfterCancel.length}, wire-start="${wireStartAfterCancel}", menu=${menuAfterWireRight}`,
    wiresAfterCancel.length === wiresBeforeCancel.length && !wireStartAfterCancel ? 'ok' : 'gap');
  await page.keyboard.press('Escape');

  // ---- P8: wire chaining after landing on a pin (informational) ----
  const pinPoints = await page.getByTestId('schematic-editor-svg').evaluate(() => {
    const node = document.querySelector(
      'circle[data-endpoint-kind="pin"][data-visible="true"]',
    );
    if (!(node instanceof SVGCircleElement)) return null;
    const svg = node.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const point = svg.createSVGPoint();
    point.x = Number(node.getAttribute('cx'));
    point.y = Number(node.getAttribute('cy'));
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y, worldX: point.x, worldY: point.y };
  });
  if (pinPoints) {
    await page.getByTestId('schematic-editor-wire').click();
    const chainTarget = await freeWorldPoint(page, { x: pinPoints.worldX + 180, y: pinPoints.worldY + 100 });
    const chainScreen = await worldPointToScreen(page, chainTarget);
    await page.mouse.click(pinPoints.x, pinPoints.y);
    await page.waitForTimeout(200);
    await page.mouse.click(chainScreen.x, chainScreen.y);
    await page.waitForTimeout(300);
    const wireStartAfterPin = await editorAttr(page, 'data-wire-start');
    record('P8-wire-chain-after-pin', 'informational: chaining continues from wire end (KiCad-like)',
      `after pin->free wire, data-wire-start="${wireStartAfterPin}"`, 'info');
    await page.keyboard.press('Escape');
  }

  // ---- P9: ctrl+wheel zoom (informational; plain wheel already zooms) ----
  const zoomBefore = Number(await editorAttr(page, 'data-zoom'));
  const svgBox = await page.getByTestId('schematic-editor-svg').boundingBox();
  await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  const zoomAfter = Number(await editorAttr(page, 'data-zoom'));
  record('P9-wheel-zoom', 'wheel zooms (cursor centered)',
    `zoom ${zoomBefore} -> ${zoomAfter} after wheel`,
    zoomAfter > zoomBefore ? 'ok' : 'gap');
  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-09-zoomed.png') });

  // ---- P11: marquee selection content (components only?) ----
  await page.getByTestId('schematic-editor-select').click();
  await page.keyboard.press('Escape');
  const allPos = await componentPositions(page);
  const allXs = Object.values(allPos).map((p) => p.x);
  const allYs = Object.values(allPos).map((p) => p.y);
  const marqueeFrom = await worldPointToScreen(page, { x: Math.min(...allXs) - 120, y: Math.min(...allYs) - 120 });
  const marqueeTo = await worldPointToScreen(page, { x: Math.max(...allXs) + 120, y: Math.max(...allYs) + 120 });
  await page.mouse.move(marqueeFrom.x, marqueeFrom.y);
  await page.mouse.down();
  await page.mouse.move(marqueeTo.x, marqueeTo.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const marqueeSelected = await editorAttr(page, 'data-selected');
  const marqueeCount = await editorAttr(page, 'data-selected-component-count');
  record('P11-marquee-selection', 'marquee selects enclosed objects (qucs: components+wires)',
    `after marquee data-selected="${marqueeSelected}" count=${marqueeCount}`,
    'info');
  await page.keyboard.press('Escape');

  await page.screenshot({ path: path.resolve(outputRoot, 'ux-probe-99-final.png') });
} finally {
  const findingsPath = path.resolve(outputRoot, 'ux-probe-findings.json');
  await writeFile(findingsPath, `${JSON.stringify({ findings, pageErrors }, null, 2)}\n`, 'utf8');
  console.log(`[probe] findings written to ${findingsPath}`);
  await electronApp.close().catch(() => undefined);
  viteProcess.kill();
  await removePrefixedProjects().catch(() => undefined);
  await rm(e2eRunRoot, { recursive: true, force: true }).catch(() => undefined);
}

const fatalErrors = pageErrors.filter((entry) => !entry.includes('ERR_CONNECTION_FAILED'));
if (fatalErrors.length > 0) {
  console.error('[probe] page errors detected:', fatalErrors);
}
console.log('[probe] done');

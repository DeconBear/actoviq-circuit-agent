import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const projectPrefix = 'playwright-schematic-editor-';
const viteUrl = 'http://127.0.0.1:5173';
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const skillScript = path.resolve(root, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py');

function runSkill(args) {
  return JSON.parse(execFileSync('python', [skillScript, ...args], {
    cwd: root,
    encoding: 'utf8',
  }));
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
  if (await canFetch(viteUrl)) return null;
  let exited = null;
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173'], {
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
    if (await canFetch(viteUrl)) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`Timed out waiting for Vite at ${viteUrl}`);
}

async function removePrefixedProjects() {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(projectPrefix)) continue;
    const target = path.resolve(projectsRoot, entry.name);
    assert.equal(path.dirname(target), projectsRoot);
    await rm(target, { recursive: true, force: true });
  }
}

async function componentPositions(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-component-positions');
  return JSON.parse(raw || '{}');
}

async function editorCamera(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-camera');
  return JSON.parse(raw || '{"x":0,"y":0,"scale":1}');
}

async function editorWirePoints(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-wire-points');
  return JSON.parse(raw || '[]');
}

function worldToScreen(point, camera, canvasBox) {
  return {
    x: canvasBox.x + camera.x + point.x * camera.scale,
    y: canvasBox.y + camera.y + point.y * camera.scale,
  };
}

async function firstVisibleWireSegment(page) {
  const canvasBox = await page.getByTestId('schematic-editor-canvas').boundingBox();
  assert.ok(canvasBox);
  const camera = await editorCamera(page);
  const wires = await editorWirePoints(page);
  for (const points of wires) {
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (!start || !end) continue;
      if (Math.abs(start.x - end.x) + Math.abs(start.y - end.y) < 20) continue;
      return {
        start: worldToScreen(start, camera, canvasBox),
        end: worldToScreen(end, camera, canvasBox),
      };
    }
  }
  throw new Error('No visible wire segment in editor state.');
}

function assertPositionEqual(actual, expected, label) {
  assert.deepEqual(
    { x: Number(actual?.x), y: Number(actual?.y) },
    { x: Number(expected?.x), y: Number(expected?.y) },
    label,
  );
}

function assertPositionChanged(actual, expected, label) {
  assert.notDeepEqual(
    { x: Number(actual?.x), y: Number(actual?.y) },
    { x: Number(expected?.x), y: Number(expected?.y) },
    label,
  );
}

async function countVisibleWirePixels(page, start, end) {
  return page.getByTestId('schematic-editor-canvas').evaluate((canvas, points) => {
    if (!(canvas instanceof HTMLCanvasElement)) return 0;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const padding = 18;
    const x0 = Math.max(0, Math.floor((Math.min(points.start.x, points.end.x) - rect.left - padding) * scaleX));
    const y0 = Math.max(0, Math.floor((Math.min(points.start.y, points.end.y) - rect.top - padding) * scaleY));
    const x1 = Math.min(canvas.width, Math.ceil((Math.max(points.start.x, points.end.x) - rect.left + padding) * scaleX));
    const y1 = Math.min(canvas.height, Math.ceil((Math.max(points.start.y, points.end.y) - rect.top + padding) * scaleY));
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    const data = context.getImageData(x0, y0, width, height).data;
    let visible = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const darkWire = r < 45 && g < 65 && b < 95;
      const blueWire = r < 80 && g < 130 && b > 170;
      if (darkWire || blueWire) visible += 1;
    }
    return visible;
  }, { start, end });
}

await mkdir(outputRoot, { recursive: true });
await removePrefixedProjects();

const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Schematic Editor ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const projectRoot = created.project_root;
for (const module of created.project.modules) {
  const compiled = runSkill(['compile-module', '--project-root', projectRoot, '--module-id', module.id]);
  assert.equal(compiled.render.ok, true);
}

const viteProcess = await startViteIfNeeded();
const pageErrors = [];
const electronApp = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, ACTOVIQ_E2E: '1' },
});

let page;
try {
  page = await electronApp.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();

  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor({ timeout: 20_000 });
  await page.getByTestId('schematic-editor-tab').click();
  const editor = page.getByTestId('schematic-editor');
  await editor.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-component-count') === '2' &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });

  const canvas = page.getByTestId('schematic-editor-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box);
  const initialWireCount = Number(await editor.getAttribute('data-wire-count'));
  const initialSegment = await firstVisibleWireSegment(page);
  const visibleImplicitWirePixels = await countVisibleWirePixels(page, initialSegment.start, initialSegment.end);
  assert.ok(visibleImplicitWirePixels > 60, `netlist-derived wire is not visible; counted ${visibleImplicitWirePixels} pixels`);
  const placePoint = { x: box.x + Math.min(430, box.width * 0.62), y: box.y + Math.min(280, box.height * 0.48) };

  await page.getByTestId('schematic-editor-place-R').click();
  await page.mouse.click(placePoint.x, placePoint.y);
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-component-count') === '3' &&
      node?.getAttribute('data-selected')?.startsWith('component:r');
  });
  const filterPositionsAfterPlace = await componentPositions(page);

  await page.getByTestId('schematic-editor-select').click();
  await page.mouse.move(placePoint.x, placePoint.y);
  await page.mouse.down();
  await page.mouse.move(placePoint.x + 60, placePoint.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ));
  const filterPositionsAfterDrag = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterDrag.r_filter, filterPositionsAfterPlace.r_filter, 'dragging added resistor moved r_filter');
  assertPositionEqual(filterPositionsAfterDrag.c_filter, filterPositionsAfterPlace.c_filter, 'dragging added resistor moved c_filter');
  assertPositionChanged(filterPositionsAfterDrag.r1, filterPositionsAfterPlace.r1, 'added resistor did not move');

  const cameraAfterDrag = await editorCamera(page);
  const canvasBoxAfterDrag = await canvas.boundingBox();
  assert.ok(canvasBoxAfterDrag);
  const wireStart = worldToScreen(
    { x: filterPositionsAfterDrag.r_filter.x + 48, y: filterPositionsAfterDrag.r_filter.y },
    cameraAfterDrag,
    canvasBoxAfterDrag,
  );
  const wireEnd = worldToScreen(
    { x: filterPositionsAfterDrag.r1.x - 48, y: filterPositionsAfterDrag.r1.y },
    cameraAfterDrag,
    canvasBoxAfterDrag,
  );
  await page.getByTestId('schematic-editor-wire').click();
  await page.mouse.move(wireStart.x, wireStart.y);
  await page.mouse.down();
  await page.mouse.move(wireEnd.x, wireEnd.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction((count) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') > count
  ), initialWireCount);
  const visibleWirePixelsAfterDraw = await countVisibleWirePixels(page, wireStart, wireEnd);
  assert.ok(visibleWirePixelsAfterDraw > 60, `drawn wire is not visibly drawn; counted ${visibleWirePixelsAfterDraw} pixels`);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-wire-visible.png') });

  await page.getByTestId('schematic-editor-save').click();
  await page.getByText('Applied netlist and SVG rebuilt', { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-dirty') === 'false' &&
      node?.getAttribute('data-component-count') === '3' &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });

  const moduleData = JSON.parse(await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
  assert.equal(moduleData.components.length, 3);
  assert.ok(moduleData.components.some((component) => component.id === 'r1' && component.type === 'R'));
  assert.match(
    await readFile(path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'), 'utf8'),
    /Rfilter_R1\s+out\s+\S+\s+1k/,
  );

  await page.getByTestId('schematic-svg-tab').click();
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor({ timeout: 20_000 });
  assert.match(await page.getByTestId('module-netlistsvg').innerHTML(), /cell_Rfilter_R1/);
  await page.getByTestId('back-to-board').click();
  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('schematic-editor-tab').click();
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') >= 3
  ));
  const reloadSegment = await firstVisibleWireSegment(page);
  const visibleWirePixelsAfterReload = await countVisibleWirePixels(page, reloadSegment.start, reloadSegment.end);
  assert.ok(visibleWirePixelsAfterReload > 60, `wire is not visible after reload; counted ${visibleWirePixelsAfterReload} pixels`);
  await page.getByTestId('back-to-board').click();

  await page.getByTestId('module-card-power').dblclick();
  await page.getByTestId('schematic-editor-tab').click();
  await editor.waitFor({ timeout: 20_000 });
  const powerCanvas = page.getByTestId('schematic-editor-canvas');
  const powerBox = await powerCanvas.boundingBox();
  assert.ok(powerBox);
  const powerPlacePoint = {
    x: powerBox.x + Math.min(430, powerBox.width * 0.62),
    y: powerBox.y + Math.min(260, powerBox.height * 0.45),
  };
  await page.getByTestId('schematic-editor-place-R').click();
  await page.mouse.click(powerPlacePoint.x, powerPlacePoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3'
  ));
  const powerPositionsAfterPlace = await componentPositions(page);
  await page.getByTestId('schematic-editor-select').click();
  await page.mouse.move(powerPlacePoint.x, powerPlacePoint.y);
  await page.mouse.down();
  await page.mouse.move(powerPlacePoint.x + 70, powerPlacePoint.y + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ));
  const powerPositionsAfterDrag = await componentPositions(page);
  assertPositionEqual(powerPositionsAfterDrag.v_signal, powerPositionsAfterPlace.v_signal, 'dragging resistor moved Vsignal');
  assertPositionEqual(powerPositionsAfterDrag.v_supply, powerPositionsAfterPlace.v_supply, 'dragging resistor moved VDD source');
  assertPositionChanged(powerPositionsAfterDrag.r1, powerPositionsAfterPlace.r1, 'power-module resistor did not move');

  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-smoke.png') });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    ok: true,
    projectId,
    moduleComponentCount: moduleData.components.length,
    moduleWireCount: moduleData.wires.length,
    screenshot: 'output/playwright/schematic-editor-smoke.png',
    wireScreenshot: 'output/playwright/schematic-editor-wire-visible.png',
  }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-failure.png') }).catch(() => {});
    console.error(JSON.stringify({
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500),
      pageErrors,
    }, null, 2));
  }
  throw error;
} finally {
  await electronApp.close();
  if (viteProcess) viteProcess.kill();
}

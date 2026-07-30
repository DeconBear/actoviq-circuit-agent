/**
 * M0-03 GUI performance baseline: measure first-paint, pan, zoom, drag, and save
 * timings for 100- and 500-component modules in the Electron editor.
 *
 * The large modules are generated in-process and written to the filter module
 * file, then recompiled so the editor loads them fresh. Timings are captured
 * with page.evaluate performance.now() and Playwright mouse/click timings.
 *
 * Run:  node scripts/e2e/schematic-editor-perf-baseline.mjs
 */
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'perf' });
const {
  outputRoot, e2eRunRoot, workspaceRoot, projectsRoot,
  runSkill, removePrefixedProjects, startEnvironment,
  openModuleCard, waitForWorkbenchProject,
  componentScreenCenter, selectComponentForDrag,
} = h;

const SIZES = (process.env.ACTOVIQ_PERF_SIZES ?? '100,500')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const STOP_AFTER = process.env.ACTOVIQ_PERF_STOP_AFTER ?? '';

function generateLargeModuleJson(componentCount) {
  const components = [];
  const cols = Math.ceil(Math.sqrt(componentCount));
  for (let i = 0; i < componentCount; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    components.push({
      id: `r${i}`,
      type: 'R',
      name: `R${i}`,
      value: '1k',
      position: { x: 60 + col * 80, y: 60 + row * 80 },
      rotation: 0,
      pins: [
        { id: 'a', name: '1', net: `n${i}` },
        { id: 'b', name: '2', net: `n${i + 1}` },
      ],
    });
  }
  return {
    schema: 'actoviq.module.v2',
    module_id: 'filter',
    name: `Perf ${componentCount}`,
    revision: 0,
    ports: [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ],
    components,
    wires: [],
    annotations: [],
  };
}

await removePrefixedProjects();
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Perf ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const projectRoot = created.project_root;
const filterModulePath = path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json');

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();
const results = [];

async function reloadAndOpen(size) {
  // Write the size-specific module. Board/editor projection consumes module.v2
  // directly; a large-sheet load must not wait for netlistsvg compilation.
  const moduleJson = generateLargeModuleJson(size);
  await writeFile(filterModulePath, JSON.stringify(moduleJson, null, 2), 'utf8');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 30_000 });
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await page.getByTestId('module-preview-filter').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="module-card-filter"]')?.getAttribute('data-projection-ready') === 'true'
  ), { timeout: 30_000 });
  const t0 = await page.evaluate(() => performance.now());
  await openModuleCard(page, 'filter');
  await page.getByTestId('schematic-editor').waitFor({ timeout: 60_000 });
  await page.waitForFunction((expected) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') >= expected
  ), size, { timeout: 60_000 });
  // "First interactive" intentionally excludes the derived netlistsvg build
  // that may still be running in the background. Wait for two paint frames so
  // the editable SVG and its event handlers have reached the compositor.
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const t1 = await page.evaluate(() => performance.now());
  return t1 - t0;
}

async function waitForInteractionIdle() {
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-busy') === 'false'
      && node?.getAttribute('data-drag-preview') === 'false';
  });
}

async function measurePan() {
  await waitForInteractionIdle();
  const editor = page.getByTestId('schematic-editor');
  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  assert.ok(box, 'schematic canvas must be visible for the pan baseline');
  const before = JSON.parse(await editor.getAttribute('data-viewport') || '{}');
  // Anchor the gesture to rendered geometry instead of the SVG bounding-box
  // centre: preserveAspectRatio can leave large letterboxed regions that do
  // not receive pointer events in Electron.
  const start = await componentScreenCenter(page, 'r0');
  await editor.focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-space-pan') === 'true'
  ));
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(start.x + 80, start.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-viewport') ?? '{}';
    const viewport = JSON.parse(raw);
    return Number(viewport.minX) !== Number(previous.minX)
      || Number(viewport.minY) !== Number(previous.minY);
  }, before);
  const t1 = await page.evaluate(() => performance.now());
  return Math.round((t1 - t0) * 10) / 10;
}

async function measureZoom() {
  const editor = page.getByTestId('schematic-editor');
  const before = await editor.getAttribute('data-zoom');
  const t0 = await page.evaluate(() => performance.now());
  await page.getByTestId('schematic-editor-fit').click();
  await page.waitForFunction(() => (
    Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
  ), { timeout: 30_000 });
  const t1 = await page.evaluate(() => performance.now());
  return { ms: Math.round((t1 - t0) * 10) / 10, zoomBefore: before };
}

async function measureDrag() {
  await selectComponentForDrag(page, 'r0', [
    { x: 0, y: 0 },
    { x: 0, y: -10 },
    { x: 0, y: 10 },
    { x: 12, y: 0 },
  ]);
  const center = await componentScreenCenter(page, 'r0');
  await page.evaluate(() => { window.__actoviqDragPreviewMs = []; });
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  // Twenty samples make p95 ignore a single outlier without letting
  // Playwright input-injection overhead dominate the observation.
  await page.mouse.move(center.x + 240, center.y + 120, { steps: 20 });
  await page.mouse.up();
  await waitForInteractionIdle();
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const t1 = await page.evaluate(() => performance.now());
  const timings = await page.evaluate(() => window.__actoviqDragPreviewMs ?? []);
  const ordered = timings.slice().sort((left, right) => left - right);
  const p95 = ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
  return {
    gestureMs: Math.round((t1 - t0) * 10) / 10,
    previewP95Ms: Math.round(p95 * 100) / 100,
    sampleCount: timings.length,
  };
}

async function measureSave() {
  // Place a component to make the editor dirty, then time the save.
  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  await page.getByTestId('schematic-editor-place-R').click();
  // Avoid the floating component/module palettes in the canvas' upper-left.
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.75);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ), { timeout: 15_000 });
  const t0 = await page.evaluate(() => performance.now());
  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
  ), { timeout: 60_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="circuit-workbench"]')
      ?.getAttribute('data-last-preview-build-module') === 'filter'
  ), { timeout: 60_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-busy') === 'false'
  ), { timeout: 60_000 });
  const t1 = await page.evaluate(() => performance.now());
  const compiledModules = [
    await page.getByTestId('circuit-workbench').getAttribute('data-last-preview-build-module'),
  ].filter(Boolean);
  assert.deepEqual(
    [...new Set(compiledModules)],
    ['filter'],
    'single-module save must compile only the affected module',
  );
  return Math.round((t1 - t0) * 10) / 10;
}

async function measureMemory() {
  return await page.evaluate(() => {
    const mem = performance.memory;
    return mem ? Math.round((mem.usedJSHeapSize / 1024 / 1024) * 10) / 10 : null;
  });
}

try {
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
  await page.waitForTimeout(1000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 30_000 });

  for (const size of SIZES) {
    console.log(`[perf] opening ${size}-component module`);
    const firstPaintMs = Math.round((await reloadAndOpen(size)) * 10) / 10;
    console.log(`[perf] ${size} first interactive: ${firstPaintMs}ms`);
    assert.ok(firstPaintMs < 2000, `${size}-component first paint exceeded 2s: ${firstPaintMs}ms`);
    if (STOP_AFTER === 'open') {
      results.push({ componentCount: size, firstPaintMs });
      continue;
    }
    const panMs = await measurePan();
    console.log(`[perf] ${size} pan: ${panMs}ms`);
    if (STOP_AFTER === 'pan') {
      results.push({ componentCount: size, firstPaintMs, panMs });
      continue;
    }
    const zoom = await measureZoom();
    console.log(`[perf] ${size} zoom: ${zoom.ms}ms`);
    if (STOP_AFTER === 'zoom') {
      results.push({ componentCount: size, firstPaintMs, panMs, zoomMs: zoom.ms });
      continue;
    }
    const drag = await measureDrag();
    console.log(`[perf] ${size} drag preview p95: ${drag.previewP95Ms}ms`);
    assert.ok(drag.sampleCount >= 20, `${size}-component drag produced only ${drag.sampleCount} preview timing samples`);
    assert.ok(drag.previewP95Ms < 16, `${size}-component drag preview p95 exceeded 16ms: ${drag.previewP95Ms}ms`);
    if (STOP_AFTER === 'drag') {
      results.push({
        componentCount: size,
        firstPaintMs,
        panMs,
        zoomMs: zoom.ms,
        dragGestureMs: drag.gestureMs,
        dragPreviewP95Ms: drag.previewP95Ms,
        dragPreviewSamples: drag.sampleCount,
      });
      continue;
    }
    const saveMs = await measureSave();
    console.log(`[perf] ${size} source save: ${saveMs}ms`);
    const heapMb = await measureMemory();
    if (size === 500) {
      await page.getByTestId('schematic-hierarchy-recommendation').waitFor();
      await page.screenshot({ path: path.resolve(outputRoot, 'large-sheet-guidance.png'), fullPage: true });
    }
    results.push({
      componentCount: size,
      firstPaintMs,
      panMs,
      zoomMs: zoom.ms,
      dragGestureMs: drag.gestureMs,
      dragPreviewP95Ms: drag.previewP95Ms,
      dragPreviewSamples: drag.sampleCount,
      saveMs,
      rendererHeapMb: heapMb,
    });
    console.log(`[perf] ${size} components: firstPaint=${firstPaintMs}ms pan=${panMs}ms zoom=${zoom.ms}ms dragP95=${drag.previewP95Ms}ms save=${saveMs}ms heap=${heapMb}MB`);
    await page.getByTestId('back-to-board').click().catch(() => {});
  }

  assert.deepEqual(pageErrors.filter((e) => (
    !e.startsWith('electron-window')
    && !e.startsWith('framenavigated')
    && !e.startsWith('domcontentloaded')
    && !e.startsWith('load:')
  )), []);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'perf-failure.png') }).catch(() => {});
    console.error('page text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 1000));
  }
  console.error(JSON.stringify({ pageErrors, error: String(error) }, null, 2));
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (viteProcess) viteProcess.kill();
}

console.log(JSON.stringify({ ok: true, baseline: 'M0-03 gui', results }, null, 2));

/**
 * M0-03 GUI performance baseline: measure first-paint, zoom, drag, and save
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
  openModuleCard, waitForEditorIdle, waitForWorkbenchProject,
} = h;

const SIZES = [100, 500];

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

// Pre-generate and compile large modules so the editor can load them.
for (const size of SIZES) {
  const moduleJson = generateLargeModuleJson(size);
  await writeFile(filterModulePath, JSON.stringify(moduleJson, null, 2), 'utf8');
  runSkill(['compile-module', '--project-root', projectRoot, '--module-id', 'filter']);
}

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();
const results = [];

async function reloadAndOpen(size) {
  // Write the size-specific module and recompile before reload.
  const moduleJson = generateLargeModuleJson(size);
  await writeFile(filterModulePath, JSON.stringify(moduleJson, null, 2), 'utf8');
  runSkill(['compile-module', '--project-root', projectRoot, '--module-id', 'filter']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 30_000 });
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await page.getByTestId('module-preview-filter').waitFor({ timeout: 30_000 });
  const t0 = await page.evaluate(() => performance.now());
  await openModuleCard(page, 'filter');
  await page.getByTestId('schematic-editor').waitFor({ timeout: 60_000 });
  await page.waitForFunction((expected) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') >= expected
  ), size, { timeout: 60_000 });
  await waitForEditorIdle(page);
  const t1 = await page.evaluate(() => performance.now());
  return t1 - t0;
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
  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 40, center.y + 40, { steps: 8 });
  await page.mouse.up();
  await waitForEditorIdle(page);
  const t1 = await page.evaluate(() => performance.now());
  return Math.round((t1 - t0) * 10) / 10;
}

async function measureSave() {
  // Place a component to make the editor dirty, then time the save.
  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  await page.getByTestId('schematic-editor-place-R').click();
  await page.mouse.click(box.x + 50, box.y + 50);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ), { timeout: 15_000 });
  const t0 = await page.evaluate(() => performance.now());
  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
  ), { timeout: 60_000 });
  const t1 = await page.evaluate(() => performance.now());
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
    const firstPaintMs = Math.round((await reloadAndOpen(size)) * 10) / 10;
    const zoom = await measureZoom();
    const dragMs = await measureDrag();
    const saveMs = await measureSave();
    const heapMb = await measureMemory();
    results.push({ componentCount: size, firstPaintMs, zoomMs: zoom.ms, dragMs, saveMs, rendererHeapMb: heapMb });
    console.log(`[perf] ${size} components: firstPaint=${firstPaintMs}ms zoom=${zoom.ms}ms drag=${dragMs}ms save=${saveMs}ms heap=${heapMb}MB`);
    await page.getByTestId('back-to-board').click().catch(() => {});
  }

  assert.deepEqual(pageErrors.filter((e) => !e.startsWith('electron-window') && !e.startsWith('domcontentloaded') && !e.startsWith('load:')), []);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'perf-failure.png') }).catch(() => {});
    console.error('page text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 1000));
  }
  console.error(JSON.stringify({ pageErrors, error: String(error) }, null, 2));
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

console.log(JSON.stringify({ ok: true, baseline: 'M0-03 gui', results }, null, 2));

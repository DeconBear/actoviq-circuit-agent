import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const projectPrefix = 'playwright-schematic-editor-';
const legacyLdoPrefix = `${projectPrefix}legacy-ldo-`;
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

async function createLegacyLdoProject() {
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyLdoPrefix}${Date.now()}`,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  const modulePorts = [
    { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
    { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'ldo',
    name: 'PMOS-pass LDO',
    kind: 'regulator',
    function: 'Legacy notebook-only LDO used to verify SPICE-to-editable hydration.',
    parameters: { Vin: '5.0 V', Vout: '3.3 V' },
    notes: '',
    preview_enabled: true,
    source: 'modules/ldo/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 360, height: 260 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'ldo',
    name: 'PMOS-pass LDO',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'ldo');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# PMOS-pass LDO',
    '',
    '```spice',
    '* Legacy notebook-only LDO fixture',
    '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
    '.model PMOS1 PMOS (LEVEL=1 VTO=-0.7 KP=40u)',
    'Vin vin 0 DC 5',
    'Vref vref 0 DC 1.2',
    'Itail tail 0 DC 20u',
    'M1 n1 fb tail 0 NMOS1 W=20u L=1u',
    'M2 eaout vref tail 0 NMOS1 W=20u L=1u',
    'M3 n1 n1 vin vin PMOS1 W=40u L=1u',
    'M4 eaout n1 vin vin PMOS1 W=40u L=1u',
    'MP vout eaout vin vin PMOS1 W=2000u L=0.5u',
    'Rtop fb vout 210k',
    'Rbot fb 0 120k',
    'Rload vout 0 330',
    'Cout vout 0 1u',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function componentPositions(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-component-positions');
  return JSON.parse(raw || '{}');
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

async function countVisibleSchematicWires(page) {
  return page.getByTestId('schematic-editor-svg').locator('g[data-wire-id] polyline:not([stroke="transparent"])').evaluateAll((nodes) => (
    nodes.filter((node) => {
      if (!(node instanceof SVGGraphicsElement)) return false;
      const box = node.getBBox();
      return box.width > 0 || box.height > 0;
    }).length
  ));
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
const legacyLdoProject = await createLegacyLdoProject();

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
  await page.getByTestId('module-preview-filter').waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId('module-preview-filter').getAttribute('data-schematic-source'), 'document');
  assert.ok(
    await page.getByTestId('module-preview-document-svg-filter').locator('g[data-wire-id]').count() >= 3,
    'module card preview did not render document wires',
  );

  await page.getByTestId('module-card-filter').dblclick();
  const editor = page.getByTestId('schematic-editor');
  await editor.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-component-count') === '2' &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });
  await page.getByTestId('schematic-editor-svg').waitFor({ timeout: 20_000 });
  assert.equal(await editor.getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('schematic-editor-svg').getAttribute('data-schematic-source'), 'document');
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-document-backed.png') });

  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  assert.ok(box);
  const initialWireCount = Number(await editor.getAttribute('data-wire-count'));
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
  const r1PlaceViewBox = await editorViewBox(page);
  const r1PlaceBox = await canvas.boundingBox();
  assert.ok(r1PlaceBox);
  const r1PlacePoint = worldToScreen(filterPositionsAfterPlace.r1, r1PlaceViewBox, r1PlaceBox);
  await page.mouse.move(r1PlacePoint.x, r1PlacePoint.y);
  await page.mouse.down();
  await page.mouse.move(r1PlacePoint.x + 60, r1PlacePoint.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ));
  const filterPositionsAfterDrag = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterDrag.r_filter, filterPositionsAfterPlace.r_filter, 'dragging added resistor moved r_filter');
  assertPositionEqual(filterPositionsAfterDrag.c_filter, filterPositionsAfterPlace.c_filter, 'dragging added resistor moved c_filter');
  assertPositionChanged(filterPositionsAfterDrag.r1, filterPositionsAfterPlace.r1, 'added resistor did not move');

  const viewBoxAfterDrag = await editorViewBox(page);
  const canvasBoxAfterDrag = await canvas.boundingBox();
  assert.ok(canvasBoxAfterDrag);
  const wireStart = worldToScreen(
    { x: filterPositionsAfterDrag.r_filter.x + 52, y: filterPositionsAfterDrag.r_filter.y },
    viewBoxAfterDrag,
    canvasBoxAfterDrag,
  );
  const wireEnd = worldToScreen(
    { x: filterPositionsAfterDrag.r1.x - 52, y: filterPositionsAfterDrag.r1.y },
    viewBoxAfterDrag,
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
  const visibleWiresAfterDraw = await countVisibleSchematicWires(page);
  assert.ok(visibleWiresAfterDraw > initialWireCount, `drawn wire is not visibly drawn; counted ${visibleWiresAfterDraw} wires`);
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
  assert.ok((moduleData.wires ?? []).length >= 3, 'saved schematic document did not persist visible wires');
  assert.ok(moduleData.components.some((component) => component.id === 'r1' && component.type === 'R'));
  assert.match(
    await readFile(path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'), 'utf8'),
    /Rfilter_R1\s+out\s+\S+\s+1k/,
  );

  await page.getByTestId('schematic-svg-tab').click();
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('module-document-svg').getAttribute('data-schematic-source'), 'document');
  await page.getByTestId('back-to-board').click();
  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') >= 3
  ));
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-schematic-source'), 'document');
  await page.getByTestId('back-to-board').click();

  await page.getByTestId(`sidebar-project-${legacyLdoProject.projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(legacyLdoProject.projectName, { exact: true }).waitFor();
  await page.getByTestId('module-card-ldo').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 12 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 10;
  });
  const ldoPositions = await componentPositions(page);
  assert.ok(ldoPositions.mp, 'hydrated LDO pass MOSFET is missing from editable schematic');
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-ldo.png') });

  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }

  await page.getByTestId('module-card-power').dblclick();
  await editor.waitFor({ timeout: 20_000 });
  const powerCanvas = page.getByTestId('schematic-editor-svg');
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
  const powerR1PlaceViewBox = await editorViewBox(page);
  const powerR1PlaceBox = await powerCanvas.boundingBox();
  assert.ok(powerR1PlaceBox);
  const powerR1PlacePoint = worldToScreen(powerPositionsAfterPlace.r1, powerR1PlaceViewBox, powerR1PlaceBox);
  await page.mouse.move(powerR1PlacePoint.x, powerR1PlacePoint.y);
  await page.mouse.down();
  await page.mouse.move(powerR1PlacePoint.x + 70, powerR1PlacePoint.y + 40, { steps: 10 });
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

/**
 * M4-01..03 visual and functional regression for hierarchical editing.
 */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'hierarchy-navigation' });
const {
  e2eRunRoot,
  outputRoot,
  projectsRoot,
  runSkill,
  removePrefixedProjects,
  startEnvironment,
  openModuleCard,
  waitForEditorIdle,
  waitForWorkbenchProject,
  componentScreenCenter,
  root,
} = h;

await removePrefixedProjects();
const created = runSkill([
  'create',
  '--projects-root', projectsRoot,
  '--name', `Playwright Hierarchy Navigation ${Date.now()}`,
  '--project-kind', 'analog_ic',
]);
const project = created.project;
const projectRoot = created.project_root;

const ports = (inputNet, outputNet) => [
  {
    id: 'vin',
    name: 'VIN',
    direction: 'input',
    signal_type: 'analog',
    net: inputNet,
    net_id: `net_${inputNet}`,
    position: { x: 100, y: 260 },
  },
  {
    id: 'vout',
    name: 'VOUT',
    direction: 'output',
    signal_type: 'analog',
    net: outputNet,
    net_id: `net_${outputNet}`,
    position: { x: 700, y: 260 },
  },
];

const leaf = {
  schema: 'actoviq.module.v2',
  module_id: 'leaf',
  name: 'Leaf gain cell',
  revision: 2,
  domain: 'analog',
  ports: ports('leaf_in', 'leaf_out'),
  nets: [
    { id: 'net_leaf_in', name: 'leaf_in', kind: 'analog' },
    { id: 'net_leaf_out', name: 'leaf_out', kind: 'analog' },
  ],
  components: [{
    id: 'rleaf',
    type: 'R',
    name: 'RLEAF',
    value: '1k',
    position: { x: 400, y: 260 },
    rotation: 0,
    pins: [
      { id: 'a', name: '1', net: 'leaf_in', net_id: 'net_leaf_in' },
      { id: 'b', name: '2', net: 'leaf_out', net_id: 'net_leaf_out' },
    ],
  }],
  wires: [],
  annotations: [],
};

const mid = {
  schema: 'actoviq.module.v2',
  module_id: 'mid',
  name: 'Middle stage',
  revision: 1,
  domain: 'analog',
  ports: ports('mid_in', 'mid_out'),
  nets: [
    { id: 'net_mid_in', name: 'mid_in', kind: 'analog' },
    { id: 'net_mid_out', name: 'mid_out', kind: 'analog' },
    { id: 'net_legacy', name: 'legacy', kind: 'analog' },
  ],
  components: [{
    id: 'xleaf',
    type: 'MODULE',
    name: 'XLEAF',
    value: 'leaf',
    position: { x: 400, y: 260 },
    rotation: 0,
    pins: [
      { id: 'vin', name: 'VIN', net: 'mid_in', net_id: 'net_mid_in', side: 'left' },
      { id: 'legacy', name: 'OLD', net: 'legacy', net_id: 'net_legacy', side: 'right' },
    ],
    block: { width: 100, height: 100 },
    module_ref: { module_id: 'leaf', revision: 0 },
    parameters: {},
  }],
  wires: [],
  annotations: [],
};

const top = {
  schema: 'actoviq.module.v2',
  module_id: 'top',
  name: 'Top level',
  revision: 0,
  domain: 'analog',
  ports: ports('top_in', 'top_out'),
  nets: [
    { id: 'net_top_in', name: 'top_in', kind: 'analog' },
    { id: 'net_top_out', name: 'top_out', kind: 'analog' },
  ],
  components: [{
    id: 'xmid',
    type: 'MODULE',
    name: 'XMID',
    value: 'mid',
    position: { x: 400, y: 260 },
    rotation: 0,
    pins: [
      { id: 'vin', name: 'VIN', net: 'top_in', net_id: 'net_top_in', side: 'left' },
      { id: 'vout', name: 'VOUT', net: 'top_out', net_id: 'net_top_out', side: 'right' },
    ],
    block: { width: 100, height: 100 },
    module_ref: { module_id: 'mid', revision: 1 },
    parameters: {},
  }],
  wires: [],
  annotations: [],
};

project.composition = { mode: 'hierarchical', top_module_id: 'top' };
project.modules = [
  { id: 'top', name: top.name, kind: 'hierarchy', function: 'Top', source: 'modules/top/module.circuit.json', position: { x: 100, y: 100 }, size: { width: 320, height: 220 }, ports: top.ports },
  { id: 'mid', name: mid.name, kind: 'hierarchy', function: 'Middle', source: 'modules/mid/module.circuit.json', position: { x: 500, y: 100 }, size: { width: 320, height: 220 }, ports: mid.ports },
  { id: 'leaf', name: leaf.name, kind: 'leaf', function: 'Leaf', source: 'modules/leaf/module.circuit.json', position: { x: 900, y: 100 }, size: { width: 320, height: 220 }, ports: leaf.ports },
];
project.connections = [];
await writeFile(
  path.resolve(projectRoot, 'project.circuit.json'),
  `${JSON.stringify(project, null, 2)}\n`,
  'utf8',
);
for (const module of [top, mid, leaf]) {
  const moduleRoot = path.resolve(projectRoot, 'modules', module.module_id);
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(
    path.resolve(moduleRoot, 'module.circuit.json'),
    `${JSON.stringify(module, null, 2)}\n`,
    'utf8',
  );
}
for (const module of [top, mid, leaf]) {
  const compiled = runSkill([
    'compile-module',
    '--project-root', projectRoot,
    '--module-id', module.module_id,
  ]);
  assert.equal(compiled.render.ok, true);
}

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();

async function openEditor(moduleId) {
  await openModuleCard(page, moduleId);
  await page.waitForFunction((expected) => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-module-id') === expected
  ), moduleId);
  await waitForEditorIdle(page);
}

async function selectComponent(componentId) {
  await page.getByTestId('schematic-editor').focus();
  await page.keyboard.press('Control+a');
  const selected = await page.waitForFunction((expected) => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-selected') === `component:${expected}`
  ), componentId, { timeout: 2_500 }).then(() => true).catch(() => false);
  if (!selected) {
    const detail = await page.evaluate(() => ({
      selected: document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected'),
      components: document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-components'),
    }));
    throw new Error(`Component ${componentId} selection failed: ${JSON.stringify(detail)}`);
  }
}

try {
  page.setDefaultTimeout(30_000);
  await page.getByTestId(`sidebar-project-${project.project_id}`).click();
  await waitForWorkbenchProject(page, project.project_id);
  await page.getByTestId('circuit-workbench').getByText(project.name, { exact: true }).waitFor();
  await openEditor('top');
  await selectComponent('xmid');

  const editor = page.getByTestId('schematic-editor');
  const topSelection = await editor.getAttribute('data-selected');
  const topViewportBefore = JSON.parse(await editor.getAttribute('data-viewport') || '{}');
  const topPoint = await componentScreenCenter(page, 'xmid');
  await page.mouse.move(topPoint.x, topPoint.y);
  await page.mouse.wheel(0, -480);
  await page.waitForFunction((before) => {
    const viewport = JSON.parse(
      document.querySelector('[data-testid="schematic-editor"]')
        ?.getAttribute('data-viewport') || '{}',
    );
    return Number(viewport.maxX) - Number(viewport.minX) < Number(before.maxX) - Number(before.minX);
  }, topViewportBefore);
  const topViewportZoomed = await editor.getAttribute('data-viewport');

  await page.getByTestId('schematic-editor-open-child-module').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-module-id') === 'mid'
  ));
  assert.equal(
    await page.getByTestId('schematic-hierarchy-breadcrumb').getAttribute('data-instance-path'),
    'top/xmid',
  );
  await selectComponent('xleaf');
  assert.equal(
    await page.locator('[data-testid="schematic-module-diagnostic"][data-code="module_revision_mismatch"]').count(),
    1,
  );
  assert.equal(
    await page.locator('[data-testid="schematic-module-diagnostic"][data-code="module_port_missing"]').count(),
    1,
  );
  await page.getByTestId('schematic-editor-module-ref').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.resolve(outputRoot, 'stale-instance.png'),
    fullPage: true,
  });

  await page.getByTestId('schematic-module-trace-vin').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-module-id') === 'leaf'
  ));
  assert.equal(
    await page.getByTestId('schematic-hierarchy-breadcrumb').getAttribute('data-instance-path'),
    'top/xmid/xleaf',
  );
  assert.equal(await editor.getAttribute('data-hierarchy-trace'), 'net_leaf_in');
  await page.waitForFunction(() => Number(
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-selected-wire-count'),
  ) > 0);
  await page.screenshot({
    path: path.resolve(outputRoot, 'three-level-net-trace.png'),
    fullPage: true,
  });

  await page.getByTestId('schematic-hierarchy-parent').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-module-id') === 'mid'
  ));
  assert.equal(await editor.getAttribute('data-selected'), 'component:xleaf');
  await page.getByTestId('schematic-editor-update-module-instance').click();
  assert.equal(
    await page.getByTestId('schematic-editor-module-ref').getAttribute('data-module-ref-status'),
    'current',
  );
  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-dirty') === 'false'
      && node?.getAttribute('data-busy') === 'false';
  });

  await page.getByTestId('schematic-hierarchy-crumb-0').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-module-id') === 'top'
  ));
  assert.equal(await editor.getAttribute('data-selected'), topSelection);
  assert.equal(await editor.getAttribute('data-viewport'), topViewportZoomed);

  await page.getByTestId('back-to-board').click();
  await openEditor('mid');
  await selectComponent('xleaf');
  assert.equal(
    await page.getByTestId('schematic-editor-module-ref').getAttribute('data-module-ref-status'),
    'current',
  );
  assert.deepEqual(
    JSON.parse(await editor.getAttribute('data-components') || '[]')
      .find((component) => component.id === 'xleaf')
      .pins.map((pin) => pin.id).sort(),
    ['vin', 'vout'],
  );

  assert.deepEqual(
    pageErrors.filter((entry) => (
      !entry.startsWith('electron-window')
      && !entry.startsWith('domcontentloaded')
      && !entry.startsWith('load:')
    )),
    [],
  );
  console.log(JSON.stringify({
    ok: true,
    suite: 'schematic-hierarchy-navigation',
    threeLevelBreadcrumb: true,
    parentRestoresSelection: true,
    parentRestoresViewport: true,
    explicitPortMapTrace: true,
    staleRevisionDetected: true,
    explicitInstanceUpdatePersisted: true,
    artifacts: [
      path.relative(root, path.resolve(outputRoot, 'stale-instance.png')),
      path.relative(root, path.resolve(outputRoot, 'three-level-net-trace.png')),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'hierarchy-navigation-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

/**
 * M3-06 visual and functional regression for split/join/cut/trim/collapse.
 *
 * Run: node scripts/e2e/schematic-wire-topology.mjs
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'wire-topology' });
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
  focusEditorByClickingCanvas,
  editorWires,
  wireScreenPointAwayFromComponents,
  root,
} = h;

await removePrefixedProjects();
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Wire Topology ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const projectRoot = created.project_root;
for (const module of created.project.modules) {
  const compiled = runSkill([
    'compile-module',
    '--project-root', projectRoot,
    '--module-id', module.id,
  ]);
  assert.equal(compiled.render.ok, true);
}

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();

async function openFilterEditor() {
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await page.getByTestId('module-preview-filter').waitFor({ timeout: 20_000 });
  await openModuleCard(page, 'filter');
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await waitForEditorIdle(page);
  await focusEditorByClickingCanvas(page);
}

async function openWireContext(wireId) {
  const point = await wireScreenPointAwayFromComponents(page, wireId);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByTestId('schematic-context-menu').waitFor();
  return point;
}

try {
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await openFilterEditor();

  const initialPortIds = await page.getByTestId('schematic-port-hit-target')
    .evaluateAll((ports) => ports.map((port) => port.getAttribute('data-port-id')).sort());
  const initialWires = await editorWires(page);
  const target = initialWires.find((wire) => (
    Array.isArray(wire.points) && wire.points.length >= 2
  ));
  assert.ok(target);

  // Split materializes a generated wire if needed and creates an explicit
  // junction. The action leaves both segments selected for immediate Join.
  await openWireContext(target.id);
  await page.getByTestId('schematic-context-menu-split').click();
  await page.waitForFunction((before) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-selected-wire-count')) === 2
    && JSON.parse(document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-wires') || '[]').length >= before + 1
  ), initialWires.length);
  assert.ok(await page.getByTestId('schematic-junction').count() > 0);
  await page.screenshot({
    path: path.resolve(outputRoot, 'split-junction.png'),
    fullPage: true,
  });

  await openWireContext(target.id);
  await page.getByTestId('schematic-context-menu-join').click();
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-selected-wire-count')) === 1
  ));
  const joined = (await editorWires(page)).find((wire) => wire.id === target.id);
  assert.ok(joined);
  assert.deepEqual(joined.points, target.points);

  // The one-shot cut tool must return to select and create distinct nets at
  // the break. Undo then restores the original wire.
  const cutPoint = await wireScreenPointAwayFromComponents(page, target.id);
  await page.getByTestId('schematic-editor-cut').click();
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-tool'), 'cut');
  await page.mouse.click(cutPoint.x, cutPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'select'
  ));
  let cutWires = (await editorWires(page)).filter((wire) => (
    wire.id === target.id || wire.id.startsWith(`${target.id}__cut`)
  ));
  assert.equal(cutWires.length, 2);
  assert.notEqual(cutWires[0].net, cutWires[1].net);
  assert.notEqual(cutWires[0].to?.junction_id, cutWires[1].from?.junction_id);
  await page.screenshot({
    path: path.resolve(outputRoot, 'cut-distinct-nets.png'),
    fullPage: true,
  });
  await page.getByTestId('schematic-editor-undo').click();
  await page.waitForFunction((wireId) => (
    JSON.parse(document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-wires') || '[]')
      .filter((wire) => wire.id === wireId || wire.id.startsWith(`${wireId}__cut`))
      .length === 1
  ), target.id);

  // Draw a free-space dangling wire, then trim its nearest end. Collapse is
  // exposed on the same context menu and covered geometrically by core tests.
  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  assert.ok(box);
  const beforeFreeIds = new Set((await editorWires(page)).map((wire) => wire.id));
  const freeStart = { x: box.x + box.width * 0.18, y: box.y + box.height * 0.84 };
  const freeEnd = { x: box.x + box.width * 0.42, y: box.y + box.height * 0.84 };
  await page.getByTestId('schematic-editor-wire').click();
  await page.mouse.click(freeStart.x, freeStart.y);
  await page.mouse.click(freeEnd.x, freeEnd.y);
  await page.keyboard.press('Escape');
  const freeWire = (await editorWires(page)).find((wire) => !beforeFreeIds.has(wire.id));
  assert.ok(freeWire, 'free-space wire was not created');
  const freeBeforeTrim = structuredClone(freeWire.points);
  await openWireContext(freeWire.id);
  assert.equal(await page.getByTestId('schematic-context-menu-collapse').count(), 1);
  await page.getByTestId('schematic-context-menu-trim').click();
  const trimmed = (await editorWires(page)).find((wire) => wire.id === freeWire.id);
  assert.ok(trimmed);
  assert.notDeepEqual(trimmed.points, freeBeforeTrim);

  // Reapply cut and persist it so save/reopen validates the new net boundary.
  const persistentCutPoint = await wireScreenPointAwayFromComponents(page, target.id);
  await page.getByTestId('schematic-editor-cut').click();
  await page.mouse.click(persistentCutPoint.x, persistentCutPoint.y);
  cutWires = (await editorWires(page)).filter((wire) => (
    wire.id === target.id || wire.id.startsWith(`${target.id}__cut`)
  ));
  assert.equal(cutWires.length, 2);
  const cutNetNames = cutWires.map((wire) => wire.net).sort();
  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    return (
      editor?.getAttribute('data-save-error')
      || (
        editor?.getAttribute('data-dirty') === 'false'
        && editor?.getAttribute('data-busy') === 'false'
      )
    );
  });
  assert.equal(
    await page.getByTestId('schematic-editor').getAttribute('data-save-error'),
    '',
  );
  await page.getByTestId('back-to-board').click();
  await openFilterEditor();
  const reopenedPorts = JSON.parse(
    await page.getByTestId('schematic-editor').getAttribute('data-ports') || '[]',
  );
  assert.deepEqual(
    await page.getByTestId('schematic-port-hit-target')
      .evaluateAll((ports) => ports.map((port) => port.getAttribute('data-port-id')).sort()),
    initialPortIds,
    `cut/save/reopen must not hide or discard module ports: ${JSON.stringify(reopenedPorts)}`,
  );
  const reopenedCutWires = (await editorWires(page)).filter((wire) => (
    wire.id === target.id || wire.id.startsWith(`${target.id}__cut`)
  ));
  assert.equal(reopenedCutWires.length, 2);
  assert.deepEqual(reopenedCutWires.map((wire) => wire.net).sort(), cutNetNames);
  await page.screenshot({
    path: path.resolve(outputRoot, 'wire-topology-saved.png'),
    fullPage: true,
  });

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
    suite: 'schematic-wire-topology',
    targetWireId: target.id,
    splitJoinReversible: true,
    cutCreatedDistinctNets: true,
    trimChangedDanglingPath: true,
    collapseActionAvailable: true,
    reopenPreservedCut: true,
    artifacts: [
      path.relative(root, path.resolve(outputRoot, 'split-junction.png')),
      path.relative(root, path.resolve(outputRoot, 'cut-distinct-nets.png')),
      path.relative(root, path.resolve(outputRoot, 'wire-topology-saved.png')),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'wire-topology-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

/**
 * M3-04 visual and functional regression for connected stretch and free move.
 *
 * Run: node scripts/e2e/schematic-move-modes.mjs
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'move-modes' });
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
  componentPositions,
  componentScreenCenter,
  editorWires,
  selectComponentForDrag,
  root,
} = h;

await removePrefixedProjects();
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Move Modes ${Date.now()}`,
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

function touchesOnlyOneEnd(wire, componentId) {
  return (
    (wire.from?.component_id === componentId) !==
    (wire.to?.component_id === componentId)
  );
}

async function dragComponent(componentId, delta, previewTestId, screenshotName) {
  const start = await componentScreenCenter(page, componentId);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 });
  // A perfectly horizontal/vertical SVG polyline has a zero CSS bounding-box
  // dimension, so Playwright may classify it as hidden even though the stroke
  // is rendered. Presence in the preview layer is the stable assertion.
  await page.getByTestId(previewTestId).first().waitFor({
    state: 'attached',
    timeout: 10_000,
  });
  await page.screenshot({
    path: path.resolve(outputRoot, screenshotName),
    fullPage: true,
  });
  await page.mouse.up();
}

try {
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await openFilterEditor();

  const components = JSON.parse(
    await page.getByTestId('schematic-editor').getAttribute('data-components') || '[]',
  );
  const initialWires = await editorWires(page);
  const target = components.find((component) => (
    initialWires.some((wire) => touchesOnlyOneEnd(wire, component.id))
  ));
  assert.ok(target, 'fixture must contain a component with an external attached wire');
  const targetId = target.id;
  const externalWire = initialWires.find((wire) => touchesOnlyOneEnd(wire, targetId));
  assert.ok(externalWire);
  const initialPositions = await componentPositions(page);

  await selectComponentForDrag(page, targetId);
  await page.getByTestId('schematic-editor-move-stretch').click();
  assert.equal(
    await page.getByTestId('schematic-editor').getAttribute('data-move-mode'),
    'stretch',
  );
  await dragComponent(
    targetId,
    { x: 85, y: 45 },
    'schematic-rubber-band-wire',
    'stretch-preview.png',
  );
  const stretchedPositions = await componentPositions(page);
  assert.notDeepEqual(stretchedPositions[targetId], initialPositions[targetId]);
  const stretchedWire = (await editorWires(page)).find((wire) => wire.id === externalWire.id);
  assert.ok(stretchedWire);
  assert.ok(
    stretchedWire.from?.component_id === targetId || stretchedWire.to?.component_id === targetId,
    'stretch move must keep the component endpoint attached',
  );

  await page.getByTestId('schematic-editor-undo').click();
  await page.waitForFunction(({ id, position }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-component-positions');
    const positions = JSON.parse(raw || '{}');
    return positions[id]?.x === position.x && positions[id]?.y === position.y;
  }, { id: targetId, position: initialPositions[targetId] });

  // Escape during a preview must not commit geometry or topology.
  await selectComponentForDrag(page, targetId);
  await page.getByTestId('schematic-editor-move-stretch').click();
  const cancelStart = await componentScreenCenter(page, targetId);
  await page.mouse.move(cancelStart.x, cancelStart.y);
  await page.mouse.down();
  await page.mouse.move(cancelStart.x + 70, cancelStart.y - 35, { steps: 6 });
  await page.getByTestId('schematic-rubber-band-wire').first().waitFor();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual((await componentPositions(page))[targetId], initialPositions[targetId]);
  assert.deepEqual(await editorWires(page), initialWires);

  await selectComponentForDrag(page, targetId);
  await page.getByTestId('schematic-editor-move-free').click();
  assert.equal(
    await page.getByTestId('schematic-editor').getAttribute('data-move-mode'),
    'free',
  );
  await dragComponent(
    targetId,
    { x: 90, y: 55 },
    'schematic-detached-wire-preview',
    'free-preview.png',
  );
  const freePositions = await componentPositions(page);
  assert.notDeepEqual(freePositions[targetId], initialPositions[targetId]);
  const freeWire = (await editorWires(page)).find((wire) => wire.id === externalWire.id);
  assert.ok(freeWire);
  const detachedEnd = externalWire.from?.component_id === targetId ? freeWire.from : freeWire.to;
  assert.equal(detachedEnd?.component_id, undefined);
  assert.match(detachedEnd?.junction_id ?? '', /^j_detached_/);

  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    return editor?.getAttribute('data-dirty') === 'false'
      && editor?.getAttribute('data-busy') === 'false';
  });
  await page.screenshot({
    path: path.resolve(outputRoot, 'free-move-saved.png'),
    fullPage: true,
  });

  await page.getByTestId('back-to-board').click();
  await openFilterEditor();
  const reopenedWire = (await editorWires(page)).find((wire) => wire.id === externalWire.id);
  assert.ok(reopenedWire);
  const reopenedDetachedEnd = (
    externalWire.from?.component_id === targetId ? reopenedWire.from : reopenedWire.to
  );
  assert.equal(reopenedDetachedEnd?.component_id, undefined);
  assert.match(reopenedDetachedEnd?.junction_id ?? '', /^j_detached_/);

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
    suite: 'schematic-move-modes',
    targetId,
    externalWireId: externalWire.id,
    stretchPreservedConnection: true,
    freeMoveDetachedConnection: true,
    cancelWasPure: true,
    reopenPreservedDetachment: true,
    artifacts: [
      path.relative(root, path.resolve(outputRoot, 'stretch-preview.png')),
      path.relative(root, path.resolve(outputRoot, 'free-preview.png')),
      path.relative(root, path.resolve(outputRoot, 'free-move-saved.png')),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'move-modes-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

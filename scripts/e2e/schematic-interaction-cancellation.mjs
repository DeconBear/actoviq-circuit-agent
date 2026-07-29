/**
 * M3-09 visual and functional regression for modal interaction semantics.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'interaction-cancellation' });
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
  componentScreenCenter,
  root,
} = h;

await removePrefixedProjects();
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Interaction Cancellation ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
for (const module of created.project.modules) {
  const compiled = runSkill([
    'compile-module',
    '--project-root', created.project_root,
    '--module-id', module.id,
  ]);
  assert.equal(compiled.render.ok, true);
}

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();

async function openEditor() {
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await page.getByTestId('module-preview-filter').waitFor({ timeout: 20_000 });
  await openModuleCard(page, 'filter');
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await waitForEditorIdle(page);
  await focusEditorByClickingCanvas(page);
}

async function editorSnapshot() {
  const editor = page.getByTestId('schematic-editor');
  return {
    components: await editor.getAttribute('data-components'),
    wires: await editor.getAttribute('data-wires'),
    positions: await editor.getAttribute('data-component-positions'),
    history: await editor.getAttribute('data-history-count'),
    sourceRevision: await editor.getAttribute('data-source-revision'),
    dirty: await editor.getAttribute('data-dirty'),
  };
}

async function expectState(state) {
  await page.waitForFunction((expected) => (
    document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-interaction-state') === expected
  ), state);
}

try {
  page.setDefaultTimeout(30_000);
  await openEditor();
  const editor = page.getByTestId('schematic-editor');
  const svg = page.getByTestId('schematic-editor-svg');
  const canvas = await svg.boundingBox();
  assert.ok(canvas);
  const emptyPoint = { x: canvas.x + canvas.width * 0.78, y: canvas.y + canvas.height * 0.72 };

  const initial = await editorSnapshot();
  await page.keyboard.press('r');
  await expectState('placing.component');
  assert.equal(await editor.getAttribute('data-place-rotation'), '0');
  await page.mouse.click(emptyPoint.x, emptyPoint.y, { button: 'right' });
  assert.equal(await editor.getAttribute('data-place-rotation'), '90');
  await expectState('placing.component');
  await page.screenshot({
    path: path.resolve(outputRoot, 'placement-modal-status.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expectState('idle');
  assert.deepEqual(await editorSnapshot(), initial);

  await page.keyboard.press('w');
  await expectState('wiring.preview');
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  assert.notEqual(await editor.getAttribute('data-wire-start'), '');
  await page.keyboard.press('Enter');
  await expectState('idle');
  assert.equal(await editor.getAttribute('data-wire-start'), '');
  assert.deepEqual(await editorSnapshot(), initial);

  await page.keyboard.press('w');
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await page.mouse.click(emptyPoint.x + 20, emptyPoint.y, { button: 'right' });
  await expectState('idle');
  assert.equal(await page.getByTestId('schematic-context-menu').count(), 0);
  assert.deepEqual(await editorSnapshot(), initial);

  const components = JSON.parse(await editor.getAttribute('data-components') || '[]');
  const targetId = components[0]?.id;
  assert.ok(targetId);
  const target = await componentScreenCenter(page, targetId);
  await page.mouse.click(target.x, target.y);
  const selectedBeforeDialog = await editor.getAttribute('data-selected');
  assert.notEqual(selectedBeforeDialog, '');
  await page.keyboard.press('b');
  await expectState('dialog');
  assert.match(
    await editor.getAttribute('data-interaction-status') || '',
    /^Dialog/,
  );
  await page.screenshot({
    path: path.resolve(outputRoot, 'block-dialog-status.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expectState('idle');
  assert.equal(await editor.getAttribute('data-selected'), selectedBeforeDialog);
  assert.deepEqual(await editorSnapshot(), initial);

  await page.keyboard.press('b');
  await page.getByTestId('schematic-block-value').focus();
  await page.keyboard.press('Enter');
  await expectState('placing.component');
  assert.equal(await editor.getAttribute('data-block-dialog'), 'false');
  await page.keyboard.press('Escape');
  await expectState('idle');
  assert.deepEqual(await editorSnapshot(), initial);

  await page.getByTestId('schematic-editor-move-stretch').click();
  const beforeEscapeDrag = await editorSnapshot();
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 80, target.y + 40, { steps: 6 });
  await expectState('moving.stretch');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectState('idle');
  assert.deepEqual(await editorSnapshot(), beforeEscapeDrag);

  await page.getByTestId('schematic-editor-move-free').click();
  const beforePointerCancel = await editorSnapshot();
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 70, target.y - 30, { steps: 6 });
  await expectState('moving.free');
  await svg.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  await page.mouse.up();
  await expectState('idle');
  assert.deepEqual(await editorSnapshot(), beforePointerCancel);

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
    suite: 'schematic-interaction-cancellation',
    placementRightClickRotates: true,
    enterFinishesWire: true,
    rightClickCancelsWire: true,
    modalEscapePreservesSelection: true,
    modalEnterConfirms: true,
    escapeCancelIsPure: true,
    pointerCancelIsPure: true,
    artifacts: [
      path.relative(root, path.resolve(outputRoot, 'placement-modal-status.png')),
      path.relative(root, path.resolve(outputRoot, 'block-dialog-status.png')),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'interaction-cancellation-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

/**
 * M3-05 visual and functional regression for snap priority and auto-wire.
 *
 * Run: node scripts/e2e/schematic-snap-autowire.mjs
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'snap-autowire' });
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
  '--name', `Playwright Snap Autowire ${Date.now()}`,
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

async function pinScreenPoint(componentId, pinId) {
  const circle = page.getByTestId('schematic-editor-svg').locator(
    `circle[data-endpoint-kind="pin"][data-component-id="${componentId}"][data-pin-id="${pinId}"]`,
  );
  await circle.waitFor({ state: 'attached' });
  return circle.evaluate((node) => {
    if (!(node instanceof SVGCircleElement) || !node.ownerSVGElement) {
      throw new Error('pin endpoint is not an SVG circle');
    }
    const matrix = node.ownerSVGElement.getScreenCTM();
    if (!matrix) throw new Error('pin endpoint has no screen transform');
    const point = node.ownerSVGElement.createSVGPoint();
    point.x = Number(node.getAttribute('cx'));
    point.y = Number(node.getAttribute('cy'));
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  });
}

try {
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await openFilterEditor();

  const beforeComponents = JSON.parse(
    await page.getByTestId('schematic-editor').getAttribute('data-components') || '[]',
  );
  const canvas = page.getByTestId('schematic-editor-svg');
  const canvasBox = await canvas.boundingBox();
  assert.ok(canvasBox);
  await page.getByTestId('schematic-editor-place-R').click();
  await page.mouse.click(
    canvasBox.x + canvasBox.width * 0.72,
    canvasBox.y + canvasBox.height * 0.72,
  );
  const placed = await page.waitForFunction((beforeIds) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-components');
    const components = JSON.parse(raw || '[]');
    return components.find((component) => !beforeIds.includes(component.id)) ?? null;
  }, beforeComponents.map((component) => component.id)).then((handle) => handle.jsonValue());
  assert.ok(placed?.id);

  await page.getByTestId('schematic-editor-select').click();
  const pinPoint = await pinScreenPoint(placed.id, 'a');
  await page.mouse.move(pinPoint.x, pinPoint.y);
  await page.getByTestId('schematic-hover-endpoint').waitFor();
  assert.match(
    await page.getByTestId('schematic-editor').getAttribute('data-hover-endpoint') || '',
    new RegExp(placed.name, 'i'),
  );

  // A direct click on an unconnected pin starts wiring without first choosing
  // the wire tool.
  await page.mouse.click(pinPoint.x, pinPoint.y);
  await page.waitForFunction(({ componentId }) => {
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    return editor?.getAttribute('data-tool') === 'wire'
      && editor?.getAttribute('data-wire-start') === `pin:${componentId}:a`;
  }, { componentId: placed.id });

  const targetWire = (await editorWires(page)).find((wire) => (
    wire.from?.component_id !== placed.id && wire.to?.component_id !== placed.id
  ));
  assert.ok(targetWire, 'fixture must expose a target net segment');
  const segmentPoint = await wireScreenPointAwayFromComponents(page, targetWire.id);
  await page.mouse.move(segmentPoint.x, segmentPoint.y);
  await page.getByTestId('schematic-hover-endpoint').waitFor();
  assert.match(
    await page.getByTestId('schematic-hover-endpoint-label').textContent() || '',
    /Wire|Junction/i,
  );
  await page.screenshot({
    path: path.resolve(outputRoot, 'segment-snap-preview.png'),
    fullPage: true,
  });
  await page.mouse.click(segmentPoint.x, segmentPoint.y);
  await page.keyboard.press('Escape');

  await page.waitForFunction((componentId) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')
      ?.getAttribute('data-wires');
    const wires = JSON.parse(raw || '[]');
    return wires.some((wire) => (
      wire.from?.component_id === componentId || wire.to?.component_id === componentId
    ));
  }, placed.id);
  const connectedWire = (await editorWires(page)).find((wire) => (
    wire.from?.component_id === placed.id || wire.to?.component_id === placed.id
  ));
  assert.ok(connectedWire);
  const joinedEndpoint = (
    connectedWire.from?.component_id === placed.id
      ? connectedWire.to
      : connectedWire.from
  );
  assert.ok(
    joinedEndpoint?.junction_id || joinedEndpoint?.component_id || joinedEndpoint?.port_id,
    'segment snap must create or reuse an identified graph endpoint',
  );

  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    return editor?.getAttribute('data-dirty') === 'false'
      && editor?.getAttribute('data-busy') === 'false';
  });
  await page.getByTestId('back-to-board').click();
  await openFilterEditor();
  assert.ok((await editorWires(page)).some((wire) => (
    wire.from?.component_id === placed.id || wire.to?.component_id === placed.id
  )));
  await page.screenshot({
    path: path.resolve(outputRoot, 'autowire-saved.png'),
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
    suite: 'schematic-snap-autowire',
    componentId: placed.id,
    targetWireId: targetWire.id,
    autoWireFromPin: true,
    segmentSnapCreatedIdentifiedNode: true,
    reopenPreservedConnection: true,
    artifacts: [
      path.relative(root, path.resolve(outputRoot, 'segment-snap-preview.png')),
      path.relative(root, path.resolve(outputRoot, 'autowire-saved.png')),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'snap-autowire-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

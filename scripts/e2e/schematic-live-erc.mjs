/**
 * M3-08 visual and functional regression for immediate canvas ERC.
 */
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'live-erc' });
const {
  e2eRunRoot,
  outputRoot,
  createJunctionInteractionProject,
  removePrefixedProjects,
  startEnvironment,
  waitForWorkbenchProject,
  openModuleCard,
  waitForEditorIdle,
  root,
} = h;

await removePrefixedProjects();
const fixture = await createJunctionInteractionProject();
const modulePath = path.resolve(
  fixture.projectRoot,
  'modules',
  'junctions',
  'module.circuit.json',
);
const invalidModule = JSON.parse(await readFile(modulePath, 'utf8'));
const invalidPin = invalidModule.components
  .find((component) => component.id === 'spare_block')
  .pins.find((pin) => pin.id === 'nc');
invalidPin.no_connect = true;
invalidModule.wires.push({
  id: 'invalid_nc_stub',
  net: 'SPARE',
  net_id: 'net_spare',
  source: 'stored',
  from: { x: 526, y: 100, component_id: 'spare_block', pin_id: 'nc' },
  to: { x: 460, y: 100, junction_id: 'j_invalid_nc' },
  points: [{ x: 526, y: 100 }, { x: 460, y: 100 }],
});
await writeFile(modulePath, `${JSON.stringify(invalidModule, null, 2)}\n`, 'utf8');
const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();

async function openEditor() {
  await page.getByTestId(`sidebar-project-${fixture.projectId}`).click();
  await waitForWorkbenchProject(page, fixture.projectId);
  await page.getByTestId('circuit-workbench').getByText(fixture.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await openModuleCard(page, 'junctions');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-module-id') === 'junctions'
  ));
  await waitForEditorIdle(page);
}

async function pinCenter() {
  const pin = page.locator(
    '[data-endpoint-kind="pin"][data-component-id="spare_block"][data-pin-id="nc"]',
  );
  const box = await pin.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

try {
  page.setDefaultTimeout(30_000);
  await openEditor();

  const editor = page.getByTestId('schematic-editor');
  const initialWarnings = Number(await editor.getAttribute('data-live-erc-warning-count'));
  assert.ok(initialWarnings > 0);
  assert.equal(await editor.getAttribute('data-live-erc-error-count'), '1');
  assert.equal(
    await page.locator('[data-testid="schematic-live-erc-item"][data-code="connected_no_connect"]').count(),
    1,
  );
  assert.equal(
    await page.locator('[data-testid="schematic-inline-diagnostic"][data-code="connected_no_connect"][data-severity="error"]').count(),
    1,
  );

  await page.locator(
    '[data-testid="schematic-live-erc-item"][data-code="connected_no_connect"]',
  ).click();
  assert.equal(await editor.getAttribute('data-selected'), 'component:spare_block');
  const errorScreenshot = path.resolve(outputRoot, 'live-erc-error.png');
  await page.screenshot({ path: errorScreenshot, fullPage: true });

  const pin = await pinCenter();
  await page.mouse.click(pin.x, pin.y, { button: 'right' });
  assert.equal(await page.getByTestId('schematic-context-menu-no-connect').textContent(), 'Clear no-connect');
  await page.getByTestId('schematic-context-menu-no-connect').click();
  assert.equal(await editor.getAttribute('data-live-erc-error-count'), '0');
  assert.equal(await page.locator('[data-code="connected_no_connect"]').count(), 0);

  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-save-error')
      || (
        node?.getAttribute('data-dirty') === 'false'
        && node?.getAttribute('data-busy') === 'false'
      );
  });
  assert.equal(await editor.getAttribute('data-save-error'), '');
  await page.getByTestId('back-to-board').click();
  await openEditor();
  assert.equal(await editor.getAttribute('data-live-erc-error-count'), '0');
  assert.equal(
    await page.locator('[data-testid="schematic-no-connect-marker"][data-component-id="spare_block"][data-pin-id="nc"]').count(),
    0,
  );
  const warningScreenshot = path.resolve(outputRoot, 'live-erc-warning.png');
  await page.screenshot({ path: warningScreenshot, fullPage: true });

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
    suite: 'schematic-live-erc',
    immediateWarning: true,
    diagnosticFocus: true,
    immediateError: true,
    fixClearsError: true,
    saveReopenPreservesFix: true,
    artifacts: [
      path.relative(root, errorScreenshot),
      path.relative(root, warningScreenshot),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'live-erc-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

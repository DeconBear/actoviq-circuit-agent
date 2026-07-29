/**
 * M4-04..06 visual and functional regression for bound-PDK device placement.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'pdk-device-browser' });
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
  root,
} = h;

await removePrefixedProjects();
const registryPath = path.resolve(e2eRunRoot, 'pdk-registry.json');
const pdkRoot = path.resolve(e2eRunRoot, 'ihp-fixture');
const modelPath = path.resolve(pdkRoot, 'libs.tech', 'ngspice', 'models.lib');
await mkdir(path.dirname(modelPath), { recursive: true });
await mkdir(path.resolve(pdkRoot, 'libs.tech', 'xschem'), { recursive: true });
await writeFile(modelPath, '* synthetic model metadata only\n', 'utf8');

const previousRegistry = process.env.ACTOVIQ_PDK_REGISTRY;
process.env.ACTOVIQ_PDK_REGISTRY = registryPath;
const registered = runSkill([
  'pdk-register',
  '--root', pdkRoot,
  '--adapter', 'ihp-sg13g2',
  '--version', 'e2e',
  '--registry-path', registryPath,
  '--license-accepted',
]).installation;
assert.equal(registered.logical_id, 'ihp-sg13g2');

const created = runSkill([
  'create',
  '--projects-root', projectsRoot,
  '--name', `Playwright PDK Browser ${Date.now()}`,
  '--project-kind', 'analog_ic',
]);
const project = created.project;
const projectRoot = created.project_root;
const moduleId = 'core';
const module = {
  schema: 'actoviq.module.v2',
  module_id: moduleId,
  name: 'PDK placement core',
  revision: 0,
  domain: 'analog',
  ports: [],
  nets: [],
  components: [],
  wires: [],
  annotations: [],
};
project.modules = [{
  id: moduleId,
  name: module.name,
  kind: 'leaf',
  function: 'PDK device placement regression',
  source: `modules/${moduleId}/module.circuit.json`,
  position: { x: 120, y: 120 },
  size: { width: 320, height: 220 },
  ports: [],
}];
project.analog_ic_profile = {
  schema: 'actoviq.analog-ic-profile.v2',
  simulation_profile_id: 'ngspice-local',
  pdk_binding: {
    schema: 'actoviq.pdk-binding.v1',
    pdk_ref: 'ihp-sg13g2',
    fingerprint: registered.fingerprint,
    version: 'e2e',
    default_corner: 'tt',
    corner_sweep: ['ss', 'tt', 'ff'],
  },
  sizing: { require_explicit_w_l: true, require_scale_suffix: true },
};
const moduleRoot = path.resolve(projectRoot, 'modules', moduleId);
await mkdir(moduleRoot, { recursive: true });
await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
assert.equal(runSkill(['compile-module', '--project-root', projectRoot, '--module-id', moduleId]).render.ok, true);

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();
try {
  page.setDefaultTimeout(30_000);
  await page.getByTestId(`sidebar-project-${project.project_id}`).click();
  await waitForWorkbenchProject(page, project.project_id);
  await openModuleCard(page, moduleId);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-module-id') === 'core'
  ));
  await waitForEditorIdle(page);

  await page.getByTestId('schematic-editor-open-pdk-browser').click();
  const browser = page.getByTestId('schematic-pdk-device-browser');
  await browser.waitFor();
  assert.equal(await browser.getAttribute('data-pdk-ref'), 'ihp-sg13g2');
  await page.getByTestId('schematic-pdk-search').fill('sg13_lv_nmos');
  assert.equal(await page.getByTestId('schematic-pdk-results').locator('[data-testid^="schematic-pdk-device-"]').count(), 1);
  await page.getByTestId('schematic-pdk-device-nmos').click();
  await page.getByTestId('schematic-pdk-favorite-nmos').click();
  await page.getByTestId('schematic-pdk-param-w').fill('0');
  assert.equal(
    await page.locator('[data-testid="schematic-pdk-diagnostics"] [data-code="parameter_range"]').count(),
    1,
  );
  assert.equal(await page.getByTestId('schematic-pdk-place').isDisabled(), true);
  await page.getByTestId('schematic-pdk-param-w').fill('2u');
  assert.equal(await page.getByTestId('schematic-pdk-place').isEnabled(), true);
  await page.screenshot({
    path: path.resolve(outputRoot, 'catalog-search-and-sizing.png'),
    fullPage: true,
  });
  await page.getByTestId('schematic-pdk-place').click();

  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.45);
  await page.getByTestId('schematic-place-ghost').waitFor();
  await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.45);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '1'
  ));
  const editor = page.getByTestId('schematic-editor');
  const placed = JSON.parse(await editor.getAttribute('data-components') || '[]')[0];
  assert.equal(placed.type, 'M');
  assert.equal(placed.parameters.device_id, 'nmos');
  assert.equal(placed.parameters.model, 'sg13_lv_nmos');
  assert.equal(placed.parameters.w, '2u');
  assert.equal(placed.parameters.corner, 'tt');
  assert.equal(placed.parameters.symbol, 'mos4');
  assert.deepEqual(placed.pins.map((pin) => pin.id), ['d', 'g', 's', 'b']);
  assert.deepEqual(placed.pins.map((pin) => pin.order), [0, 1, 2, 3]);

  await page.keyboard.press('Escape');
  await page.getByTestId('schematic-editor-open-pdk-browser').click();
  await page.getByTestId('schematic-pdk-search').fill('');
  await page.getByText('Favorites', { exact: true }).locator('input').check();
  assert.equal(await page.getByTestId('schematic-pdk-results').locator('[data-testid^="schematic-pdk-device-"]').count(), 1);
  assert.equal(await page.getByTestId('schematic-pdk-device-nmos').count(), 1);
  await browser.getByRole('button', { name: 'Close PDK browser' }).click();

  await editor.focus();
  await page.keyboard.press('Control+a');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:m1'
  ));
  await page.getByTestId('schematic-param-l').fill('0');
  assert.equal(
    await page.locator('[data-testid="schematic-param-pdk-diagnostics"] [data-code="parameter_range"]').count(),
    1,
  );
  await page.getByTestId('schematic-param-l').fill('180n');
  assert.equal(await page.getByTestId('schematic-param-pdk-diagnostics').count(), 0);
  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-dirty') === 'false'
      && node?.getAttribute('data-busy') === 'false'
      && node?.getAttribute('data-preview-busy') === 'false';
  });
  await editor.focus();
  await page.keyboard.press('Control+a');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:m1'
  ));
  await page.getByTestId('schematic-param-pdk-device').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.resolve(outputRoot, 'placed-catalog-device.png'),
    fullPage: true,
  });

  const saved = JSON.parse(await readFile(path.resolve(moduleRoot, 'module.circuit.json'), 'utf8'));
  assert.deepEqual(saved.components[0].pins.map((pin) => pin.name), ['D', 'G', 'S', 'B']);
  const netlist = await readFile(path.resolve(projectRoot, 'build', 'modules', moduleId, 'design.cir'), 'utf8');
  assert.match(
    netlist,
    /^M\S*\s+n_m1_1\s+n_m1_2\s+n_m1_3\s+n_m1_4\s+sg13_lv_nmos\s+W=2u\s+L=180n\s+M=1\s+NF=1/im,
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
    suite: 'schematic-pdk-device-browser',
    currentBindingOnly: true,
    searchCategoryFavoriteRecent: true,
    placementTimeValidation: true,
    catalogPinOrderPersisted: true,
    canonicalNetlistVerified: true,
    artifacts: [
      path.relative(root, path.resolve(outputRoot, 'catalog-search-and-sizing.png')),
      path.relative(root, path.resolve(outputRoot, 'placed-catalog-device.png')),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'pdk-device-browser-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
  if (previousRegistry === undefined) delete process.env.ACTOVIQ_PDK_REGISTRY;
  else process.env.ACTOVIQ_PDK_REGISTRY = previousRegistry;
}

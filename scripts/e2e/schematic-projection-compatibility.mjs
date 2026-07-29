/**
 * M5-01..06 visual and functional regression for projection and legacy
 * netlistsvg compatibility boundaries.
 */
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'projection-compatibility' });
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
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Projection Compatibility ${Date.now()}`,
]);
const project = created.project;
const projectRoot = created.project_root;
const moduleId = 'filter';
const modulePath = path.resolve(projectRoot, 'modules', moduleId, 'module.circuit.json');
const moduleBefore = await readFile(modulePath, 'utf8');
const module = JSON.parse(moduleBefore);
const component = module.components[0];
const baseRenderId = `${moduleId}_${component.name}`.replace(/[^A-Za-z0-9_.:+-]+/g, '_');
const renderId = baseRenderId.toUpperCase().startsWith(component.type.toUpperCase())
  ? baseRenderId
  : `${component.type}${baseRenderId}`;
const importedOverrides = path.resolve(e2eRunRoot, 'legacy-overrides.json');
await writeFile(importedOverrides, JSON.stringify({
  schema: 'actoviq.schematic-overrides.v1',
  project_id: project.project_id,
  module_id: moduleId,
  items: {
    [renderId]: { x: 120, y: 160, locked: true },
    removed_renderer_cell: { x: 40, y: 80, locked: false },
  },
}), 'utf8');
runSkill([
  'schematic-overrides-import',
  '--project-root', projectRoot,
  '--module-id', moduleId,
  '--input-path', importedOverrides,
]);
const compiled = runSkill([
  'compile-module',
  '--project-root', projectRoot,
  '--module-id', moduleId,
]);
assert.equal(compiled.render.ok, true);
assert.ok(compiled.render_map_path);

const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();
try {
  page.setDefaultTimeout(30_000);
  await page.getByTestId(`sidebar-project-${project.project_id}`).click();
  await waitForWorkbenchProject(page, project.project_id);
  await openModuleCard(page, moduleId);
  await waitForEditorIdle(page);
  await page.getByTestId('rebuild-module-svg').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="module-canvas"]')?.getAttribute('data-preview-busy') === 'false'
    && (document.body.textContent ?? '').includes('Module SVG updated')
  ));

  await page.getByTestId('schematic-svg-tab').click();
  assert.equal(
    await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'),
    'document',
  );

  await page.getByTestId('schematic-netlistsvg-compatibility-tab').click();
  await page.getByTestId('schematic-compatibility-notice').waitFor();
  assert.equal(
    await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'),
    'netlistsvg-compatibility',
  );
  const summary = await page.getByTestId('schematic-overrides-migration-summary').innerText();
  assert.match(summary, /2 overrides/);
  assert.match(summary, /1 renderer id mapped/);
  assert.match(summary, /1 require review/);
  assert.match(summary, /0 applied automatically/);

  await page.getByTestId('schematic-compatibility-layout-toggle').click();
  await page.getByTestId('schematic-layout-tools').waitFor();
  await page.getByTestId('schematic-overrides-panel').waitFor();
  assert.equal(await page.getByText('Legacy overrides (compatibility only)', { exact: true }).count(), 1);
  await page.screenshot({
    path: path.resolve(outputRoot, 'netlistsvg-compatibility-mode.png'),
    fullPage: true,
  });

  assert.equal(await readFile(modulePath, 'utf8'), moduleBefore);
  const documentArtifact = JSON.parse(await readFile(
    path.resolve(projectRoot, 'build', 'modules', moduleId, 'schematic-document.json'),
    'utf8',
  ));
  const renderMap = JSON.parse(await readFile(compiled.render_map_path, 'utf8'));
  assert.equal(documentArtifact.schema, 'actoviq.schematic-document.v1');
  assert.equal(renderMap.schema, 'actoviq.schematic-render-map.v1');
  assert.equal(renderMap.render_output.editable, false);
  assert.equal(renderMap.truth.role, 'canonical_edit_source');
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
    suite: 'schematic-projection-compatibility',
    projectedDocumentVisible: true,
    netlistsvgCompatibilityLabeled: true,
    migrationReportVisible: true,
    moduleV2Unchanged: true,
    artifact: path.relative(root, path.resolve(outputRoot, 'netlistsvg-compatibility-mode.png')),
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'projection-compatibility-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

/**
 * M0-05 baseline tests: capture the CURRENT behavior of three interaction gaps
 * that the refactor plan targets. These are intentionally probing tests, not
 * goal-state assertions. Each test records pass / expected-failure so the
 * baseline is explicit before M2/M3 change the behavior.
 *
 *   1. undo-after-save:  can the user undo after saving? (target: yes; today: no)
 *   2. stale-revision:   is a save against a stale base_revision rejected? (target: yes)
 *   3. unsaved-draft-nav: does an unsaved draft survive navigating away and back?
 *
 * Run:  node scripts/e2e/schematic-editor-baseline.mjs
 */
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'baseline' });
const {
  root, outputRoot, e2eRunRoot, workspaceRoot, projectsRoot,
  runSkill, removePrefixedProjects, startEnvironment,
  openModuleCard, waitForEditorIdle, waitForWorkbenchProject, focusEditorByClickingCanvas,
} = h;

const results = [];

function record(name, { pass, detail }) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'EXPECTED-FAILURE';
  console.log(`[baseline] ${tag} ${name}: ${detail}`);
}

await removePrefixedProjects();
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Baseline ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const projectRoot = created.project_root;
for (const module of created.project.modules) {
  const compiled = runSkill(['compile-module', '--project-root', projectRoot, '--module-id', module.id]);
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
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') >= 2
  ));
  await waitForEditorIdle(page);
}

async function placeResistor() {
  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  await page.getByTestId('schematic-editor-place-R').click();
  await page.mouse.click(box.x + Math.min(430, box.width * 0.62), box.y + Math.min(280, box.height * 0.48));
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-dirty') === 'true';
  }, { timeout: 10_000 });
}

try {
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.waitForTimeout(1000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });

  // === Test 1: undo-after-save ===
  await openFilterEditor();
  await focusEditorByClickingCanvas(page);
  await placeResistor();
  // Wait for the place commitDraft to push history (React state update is async).
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor-undo"]')?.getAttribute('aria-disabled') === 'false' ||
    !document.querySelector('[data-testid="schematic-editor-undo"]')?.hasAttribute('disabled')
  ), { timeout: 10_000 }).catch(() => {});
  assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), false,
    'undo should be enabled after placing a component (precondition)');
  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
  ));
  // After save the module reloads; let the preserve-history effect settle.
  await page.waitForTimeout(500);
  const undoDisabledAfterSave = await page.getByTestId('schematic-editor-undo').isDisabled();
  record('undo-after-save', {
    pass: !undoDisabledAfterSave,
    detail: undoDisabledAfterSave
      ? 'undo is disabled after save (history cleared)'
      : 'undo remains enabled after save',
  });

  // === Test 2: stale-revision ===
  const moduleBefore = JSON.parse(await readFile(
    path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
  const staleRevision = moduleBefore.revision;
  // Attempt a command against the stale base_revision via the apply API.
  let staleRejected = false;
  let staleDetail = '';
  try {
    const applyResult = runSkill([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'baseline-stale-probe',
        actor: 'playwright-baseline',
        project_id: projectId,
        base_revision: staleRevision,
        message: 'probe stale base_revision rejection',
        operations: [{
          op: 'set_module_metadata',
          module_id: 'filter',
          name: 'Filter (baseline probe)',
        }],
      }),
    ]);
    // If the above succeeded, check whether revision actually advanced; if the
    // apply returned ok but did not reject the stale base, that is a gap.
    staleDetail = `stale base_revision accepted: ok=${applyResult?.ok}`;
  } catch (error) {
    staleRejected = true;
    staleDetail = `stale base_revision rejected: ${String(error.message).slice(0, 120)}`;
  }
  record('stale-revision', {
    pass: staleRejected,
    detail: staleDetail,
  });

  // === Test 3: unsaved-draft-nav ===
  // Reopen the editor, make an unsaved edit, navigate away, come back, check draft.
  await page.getByTestId('back-to-board').click();
  await openFilterEditor();
  await focusEditorByClickingCanvas(page);
  await placeResistor();
  const dirtyBeforeNav = await page.getByTestId('schematic-editor').getAttribute('data-dirty');
  await page.getByTestId('back-to-board').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]') == null
  ), { timeout: 10_000 }).catch(() => {});
  await openFilterEditor();
  const dirtyAfterReopen = await page.getByTestId('schematic-editor').getAttribute('data-dirty');
  const draftSurvived = dirtyAfterReopen === 'true';
  record('unsaved-draft-nav', {
    pass: draftSurvived,
    detail: `dirty before nav=${dirtyBeforeNav}, after reopen=${dirtyAfterReopen} (${draftSurvived ? 'draft survived' : 'draft lost'})`,
  });

  assert.deepEqual(pageErrors.filter((e) => !e.startsWith('electron-window') && !e.startsWith('domcontentloaded') && !e.startsWith('load:')), []);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'baseline-failure.png') }).catch(() => {});
    console.error('page text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 1500));
    const editorNode = await page.getByTestId('schematic-editor').count();
    const compCount = await page.getByTestId('schematic-editor').getAttribute('data-component-count').catch(() => 'missing');
    console.error(`schematic-editor count=${editorNode}, data-component-count=${compCount}`);
  }
  console.error(JSON.stringify({ pageErrors, error: String(error) }, null, 2));
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

const expectedFailures = results.filter((r) => !r.pass).map((r) => r.name);
const passes = results.filter((r) => r.pass).map((r) => r.name);
console.log(JSON.stringify({
  ok: true,
  baseline: 'M0-05',
  pass: passes,
  expectedFailure: expectedFailures,
  note: 'expected-failure items capture the current behavior the refactor plan targets; they should turn into passes as M2/M3 land.',
}, null, 2));

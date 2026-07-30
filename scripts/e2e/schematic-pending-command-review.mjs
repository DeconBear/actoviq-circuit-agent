/**
 * M2-06 visual/functional regression for Agent transaction review.
 *
 * Covers reject-without-revision, accept-and-apply, and stale proposal blocking.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'pending-command-review' });
const {
  e2eRunRoot,
  outputRoot,
  projectsRoot,
  removePrefixedProjects,
  runSkill,
  startEnvironment,
  waitForWorkbenchProject,
} = h;

await removePrefixedProjects();
const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Pending Review ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();

function v2Command(commandId, baseRevision, expectedModuleRevision, name) {
  return {
    schema: 'actoviq.command.v2',
    command_id: commandId,
    actor: 'agent',
    project_id: projectId,
    module_id: 'filter',
    base_revision: baseRevision,
    expected_module_revision: expectedModuleRevision,
    message: `Rename filter to ${name}`,
    source: 'agent',
    operations: [{ op: 'set_module_metadata', name }],
  };
}

async function openProject() {
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
}

async function stage(command) {
  const result = await page.evaluate(
    ({ id, proposal }) => window.electronAPI.stageCircuitCommand(id, proposal),
    { id: projectId, proposal: command },
  );
  assert.equal(result.status, 'pending');
}

async function openReview(commandId) {
  await page.getByTestId('open-pending-command-review').click();
  await page.getByTestId(`pending-command-${commandId}`).waitFor();
}

try {
  page.setDefaultTimeout(30_000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 30_000 });
  await openProject();

  await stage(v2Command('e2e-reject', 0, 0, 'Rejected Agent Name'));
  await openReview('e2e-reject');
  await page.getByTestId('reject-pending-command-e2e-reject').click();
  await page.getByTestId('pending-command-e2e-reject').waitFor({ state: 'detached' });
  assert.match(await page.getByTestId('project-meta').innerText(), /revision 0\b/);

  await page.getByTestId('close-pending-command-review').click();
  await stage(v2Command('e2e-accept', 0, 0, 'Accepted Agent Name'));
  await openReview('e2e-accept');
  await page.getByTestId('accept-pending-command-e2e-accept').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="project-meta"]')?.textContent?.includes('revision 1')
  ));
  const acceptedBundle = await page.evaluate(
    (id) => window.electronAPI.getCircuitProject(id),
    projectId,
  );
  assert.equal(acceptedBundle.modules.filter.name, 'Accepted Agent Name');
  await page.screenshot({
    path: path.resolve(outputRoot, 'pending-command-accepted.png'),
    fullPage: true,
  });

  await page.getByTestId('close-pending-command-review').click();
  await stage(v2Command('e2e-stale', 1, 1, 'Stale Agent Name'));
  await page.evaluate(
    ({ id }) => window.electronAPI.applyCircuitCommand(id, {
      schema: 'actoviq.command.v1',
      command_id: 'e2e-intervening',
      actor: 'user',
      project_id: id,
      base_revision: 1,
      message: 'Intervening edit',
      operations: [{ op: 'set_module_note', module_id: 'power', notes: 'intervening' }],
    }),
    { id: projectId },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 30_000 });
  await openProject();
  await openReview('e2e-stale');
  const staleProposal = page.getByTestId('pending-command-e2e-stale');
  assert.equal(await staleProposal.getAttribute('data-stale'), 'true');
  assert.equal(await page.getByTestId('accept-pending-command-e2e-stale').isDisabled(), true);
  await page.screenshot({
    path: path.resolve(outputRoot, 'pending-command-stale.png'),
    fullPage: true,
  });
  await page.getByTestId('reject-pending-command-e2e-stale').click();
  await staleProposal.waitFor({ state: 'detached' });

  assert.deepEqual(
    pageErrors.filter((entry) => (
      !entry.startsWith('electron-window')
      && !entry.startsWith('domcontentloaded')
      && !entry.startsWith('load:')
      && !entry.startsWith('framenavigated:')
    )),
    [],
  );
  console.log(JSON.stringify({
    ok: true,
    suite: 'schematic-pending-command-review',
    rejectPreservesRevision: true,
    acceptAppliesTransaction: true,
    staleProposalBlocked: true,
    artifacts: [
      path.resolve(outputRoot, 'pending-command-accepted.png'),
      path.resolve(outputRoot, 'pending-command-stale.png'),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'pending-command-review-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}

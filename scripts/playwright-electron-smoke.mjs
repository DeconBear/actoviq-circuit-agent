import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const e2eRunRoot = path.resolve(outputRoot, '.workspace', `electron-${process.pid}-${Date.now()}`);
const workspacesRoot = path.resolve(e2eRunRoot, 'workspaces');
const workspaceRoot = path.resolve(workspacesRoot, 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const designMemoryRoot = path.resolve(workspaceRoot, 'references', 'design-memory');
const e2eWorkspacePrefix = 'playwright-workspace-';
const e2eProjectPrefix = 'playwright-module-hub-';
const e2eUiProjectPrefix = 'playwright-ui-project-';
const e2eInlineProjectPrefix = 'playwright-inline-project-';
const e2eJobPrefix = 'playwright-job-action-';
const vitePort = Number(process.env.ACTOVIQ_E2E_VITE_PORT ?? (await allocatePort()));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const skillScript = path.resolve(
  root,
  'skills',
  'circuit-design-ngspice',
  'scripts',
  'circuit_project.py',
);

function runSkill(args) {
  return JSON.parse(execFileSync('python', [skillScript, ...args], {
    cwd: root,
    encoding: 'utf8',
  }));
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 5173;
      server.close(() => resolve(port));
    });
  });
}

async function canFetch(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function warmUpVite() {
  await fetch(`${viteUrl}/src/main.tsx`).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function startViteIfNeeded() {
  let exited = null;
  const child = spawn(process.execPath, [
    viteBin,
    '--host',
    '127.0.0.1',
    '--port',
    String(vitePort),
    '--strictPort',
  ], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`Vite exited before serving ${viteUrl}: ${JSON.stringify(exited)}`);
    }
    if (await canFetch(viteUrl)) {
      await warmUpVite();
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`Timed out waiting for Vite at ${viteUrl}`);
}

async function removePrefixedDirectories(rootDir, prefix) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = path.resolve(rootDir, entry.name);
    assert.equal(path.dirname(target), rootDir);
    await rm(target, { recursive: true, force: true });
  }
}

async function removePrefixedFiles(rootDir, prefix) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const target = path.resolve(rootDir, entry.name);
    assert.equal(path.dirname(target), rootDir);
    await rm(target, { force: true });
  }
}

async function cleanE2eDesignMemory() {
  await Promise.all([
    removePrefixedDirectories(path.resolve(designMemoryRoot, 'templates'), e2eProjectPrefix),
    removePrefixedDirectories(path.resolve(designMemoryRoot, 'flows'), e2eProjectPrefix),
  ]);
}

async function cleanE2eArtifacts() {
  await rm(e2eRunRoot, { recursive: true, force: true });
}

async function createFixtureJob() {
  const jobId = `${e2eJobPrefix}${Date.now()}`;
  const jobRoot = path.resolve(workspaceRoot, 'jobs', jobId);
  await mkdir(path.resolve(jobRoot, 'logs'), { recursive: true });
  await mkdir(path.resolve(jobRoot, 'reports'), { recursive: true });
  const createdAt = new Date().toISOString();
  await writeFile(path.resolve(jobRoot, 'logs', 'workflow-state.json'), JSON.stringify({
    jobId,
    createdAt,
    lastUpdatedAt: createdAt,
    completedStages: [{ key: 'workflow-lead', status: 'completed' }],
  }, null, 2), 'utf8');
  await writeFile(path.resolve(jobRoot, 'reports', 'manifest.json'), JSON.stringify({
    jobId,
    createdAt,
    stageCount: 1,
    completedStages: 1,
    status: 'completed',
  }, null, 2), 'utf8');
  return { jobId, jobRoot };
}

async function readDesignMemoryManifest(kind, id) {
  const rootDir = path.resolve(designMemoryRoot, kind === 'template' ? 'templates' : 'flows', id);
  const manifestPath = path.resolve(rootDir, kind === 'template' ? 'template.json' : 'flow.json');
  return {
    rootDir,
    manifestPath,
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
  };
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function waitForCompiledBuildManifest(filePath, previousBuiltAt, requiredModuleIds = []) {
  const deadline = Date.now() + 120_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const manifest = await readJsonFile(filePath);
      const modules = Object.values(manifest.modules ?? {});
      const hasRequiredModules = requiredModuleIds.every((moduleId) => (
        manifest.modules?.[moduleId]?.render_ok === true
      ));
      if (
        manifest.status === 'compiled' &&
        manifest.built_at &&
        manifest.built_at !== previousBuiltAt &&
        (requiredModuleIds.length === 0 ? modules.length > 0 : hasRequiredModules) &&
        modules.every((module) => module.render_ok === true)
      ) {
        return manifest;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for compiled build manifest at ${filePath}: ${lastError?.message ?? 'no matching manifest'}`);
}

async function findProjectByName(name) {
  return findProjectByNameInRoot(projectsRoot, name);
}

async function findProjectByNameInRoot(searchProjectsRoot, name) {
  const entries = await readdir(searchProjectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(searchProjectsRoot, entry.name);
    const manifestPath = path.resolve(projectRoot, 'project.circuit.json');
    try {
      const project = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (project.name === name) return { projectRoot, project };
    } catch {
      // Ignore folders that are not circuit projects.
    }
  }
  throw new Error(`Project not found by name: ${name}`);
}

async function countProjectsByNameInRoot(searchProjectsRoot, name) {
  const entries = await readdir(searchProjectsRoot, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.resolve(searchProjectsRoot, entry.name, 'project.circuit.json');
    try {
      const project = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (project.name === name) count += 1;
    } catch {
      // Ignore folders that are not circuit projects.
    }
  }
  return count;
}

async function waitForWorkbenchProject(page, projectId) {
  await page.waitForFunction((id) => {
    const node = document.querySelector('[data-testid="circuit-workbench"]');
    return node?.getAttribute('data-project-id') === id &&
      node?.getAttribute('data-action-project-id') === id;
  }, projectId);
}

async function clickEnabledTestId(page, testId) {
  const locator = page.getByTestId(testId);
  await locator.waitFor();
  await page.waitForFunction((id) => {
    const node = document.querySelector(`[data-testid="${id}"]`);
    return node instanceof HTMLButtonElement && !node.disabled;
  }, testId);
  await locator.click();
}

async function clickSchematicComponent(page, componentId) {
  const point = await page.getByTestId('schematic-editor-svg').locator(
    `g[data-component-id="${componentId}"] [data-testid="schematic-symbol-body"]`,
  ).evaluate((node) => {
    if (!(node instanceof SVGGraphicsElement)) throw new Error('schematic symbol body is not SVG geometry');
    const box = node.getBBox();
    const matrix = node.getScreenCTM();
    if (!matrix) throw new Error('schematic symbol body has no screen transform');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return {
      x: matrix.a * x + matrix.c * y + matrix.e,
      y: matrix.b * x + matrix.d * y + matrix.f,
    };
  });
  await page.mouse.click(point.x, point.y);
}

async function clickApplicationMenuPath(electronApp, labels) {
  await electronApp.evaluate(({ BrowserWindow, Menu }, menuLabels) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let selected = null;
    for (const label of menuLabels) {
      selected = items.find((item) => item.label === label) ?? null;
      if (!selected) throw new Error(`Application menu item not found: ${menuLabels.join(' > ')}`);
      items = selected.submenu?.items ?? [];
    }
    if (!selected?.click) throw new Error(`Application menu item is not clickable: ${menuLabels.join(' > ')}`);
    selected.click(undefined, BrowserWindow.getAllWindows()[0] ?? undefined, undefined);
  }, labels);
}
await cleanE2eArtifacts();
const fixtureJob = await createFixtureJob();

const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Module Hub ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const initialRevision = created.project.revision;
const projectRoot = created.project_root;

for (const module of created.project.modules) {
  const compiled = runSkill([
    'compile-module',
    '--project-root', projectRoot,
    '--module-id', module.id,
  ]);
  assert.equal(compiled.render.ok, true);
  assert.ok(compiled.schematic_path.endsWith('schematic.svg'));
}

await mkdir(outputRoot, { recursive: true });

const viteProcess = await startViteIfNeeded();
const pageErrors = [];
const e2eUserDataDir = path.resolve(e2eRunRoot, 'electron-user-data');
const e2eHomeDir = path.resolve(e2eRunRoot, 'home');
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
await mkdir(e2eUserDataDir, { recursive: true });
await mkdir(e2eHomeDir, { recursive: true });
const electronApp = await electron.launch({
  args: [
    `--user-data-dir=${e2eUserDataDir}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
    '--allow-file-access-from-files',
    '.',
  ],
  cwd: root,
  env: {
    ...process.env,
    ACTOVIQ_E2E: '1',
    ACTOVIQ_E2E_WORKSPACE_ROOT: workspaceRoot,
    ACTOVIQ_RENDERER_URL: viteUrl,
    HOME: e2eHomeDir,
    USERPROFILE: e2eHomeDir,
    PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  slowMo: 50,
});

let page;
let testSucceeded = false;
try {
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });

  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  assert.equal(await page.getByTestId('sidebar-refresh-jobs').getAttribute('aria-label'), 'Refresh jobs and projects');
  assert.equal((await page.getByTestId('sidebar-refresh-jobs').textContent())?.trim(), 'Refresh');
  assert.equal(await page.getByTestId('sidebar-collapse').getAttribute('aria-label'), 'Collapse sidebar');
  assert.equal((await page.getByTestId('sidebar-collapse').textContent())?.trim(), '<');
  assert.equal(await page.getByTestId('topbar-settings').getAttribute('aria-label'), 'Settings');
  assert.equal((await page.getByTestId('topbar-settings').textContent())?.trim(), '');
  assert.equal(await page.getByTestId('topbar-settings').locator('svg').count(), 1);
  await page.getByTestId('sidebar-refresh-jobs').click();
  await page.getByTestId('sidebar-collapse').click();
  await page.getByTestId('sidebar-expand').waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId('sidebar-expand').getAttribute('aria-label'), 'Expand sidebar');
  assert.equal((await page.getByTestId('sidebar-expand').textContent())?.trim(), '>');
  await page.getByTestId('sidebar-expand').click();
  await page.getByTestId('sidebar-new-workspace').waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId('sidebar-new-workspace').getAttribute('aria-label'), 'Create workspace');
  assert.equal(await page.getByTestId('sidebar-new-workspace').getAttribute('title'), 'Create workspace');
  assert.equal(await page.getByTestId('sidebar-open-workspace-root').getAttribute('aria-label'), 'Open active workspace folder');
  assert.equal(await page.getByTestId('sidebar-new-demo-project').getAttribute('aria-label'), 'Create demo project');
  assert.equal(await page.getByTestId('sidebar-new-blank-project').getAttribute('aria-label'), 'Create blank project');
  await clickApplicationMenuPath(electronApp, ['File', 'Settings']);
  await page.getByTestId('settings-dialog').waitFor({ timeout: 10_000 });
  await page.getByTestId('circuit-skill-status').getByText('actoviq.project-agent.v2', { exact: false }).waitFor();
  await page.getByTestId('skill-target-codex').waitFor();
  await page.getByTestId('skill-target-claude').waitFor();
  await page.getByTestId('sync-circuit-skill').waitFor();
  await page.getByTestId('settings-dialog-close').click();
  await page.getByTestId('settings-dialog').waitFor({ state: 'detached', timeout: 10_000 });
  await clickApplicationMenuPath(electronApp, ['File', 'New Design']);
  await page.getByTestId('chat-close').waitFor({ timeout: 10_000 });
  await page.getByTestId('chat-close').click();
  await page.getByTestId('chat-close').waitFor({ state: 'detached', timeout: 10_000 });
  const fixtureJobOpenFolder = page.getByTestId(`sidebar-job-open-folder-${fixtureJob.jobId}`);
  const fixtureJobExport = page.getByTestId(`sidebar-job-export-${fixtureJob.jobId}`);
  await page.getByText(fixtureJob.jobId, { exact: true }).waitFor({ timeout: 20_000 });
  await fixtureJobExport.scrollIntoViewIfNeeded();
  assert.equal(await fixtureJobOpenFolder.getAttribute('aria-label'), `Open job folder ${fixtureJob.jobId}`);
  assert.equal(await fixtureJobExport.getAttribute('aria-label'), `Export job ${fixtureJob.jobId} as ZIP`);
  await fixtureJobExport.click();
  await page.getByTestId('sidebar-notice').getByText(/^Exported ZIP: /).waitFor({ timeout: 20_000 });
  assert.equal((await stat(`${fixtureJob.jobRoot}.zip`)).isFile(), true);

  const workspaceName = `Playwright Workspace ${Date.now()}`;
  let createdWorkspaceRoot = '';
  await page.getByTestId('sidebar-new-workspace').click();
  await page.getByTestId('workspace-create-panel').waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId('workspace-create-submit').isDisabled(), true);
  assert.equal(await page.getByTestId('workspace-root-choose').getAttribute('aria-label'), 'Choose workspace folder');
  assert.equal(await page.getByTestId('workspace-create-cancel').getAttribute('aria-label'), 'Cancel workspace creation');
  assert.equal(await page.getByTestId('workspace-create-submit').getAttribute('aria-label'), 'Create workspace');
  await page.keyboard.press('Escape');
  await page.getByTestId('workspace-create-panel').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByTestId('sidebar-new-workspace').click();
  await page.getByTestId('workspace-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('workspace-create-cancel').click();
  await page.getByTestId('workspace-create-panel').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByTestId('sidebar-new-workspace').click();
  await page.getByTestId('workspace-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('workspace-name-input').fill(workspaceName);
  await page.getByTestId('workspace-create-submit').dblclick();
  await page.getByTestId('sidebar-notice').getByText(`Workspace created: ${workspaceName}`, { exact: true }).waitFor({ timeout: 20_000 });
  await page.waitForFunction((name) => {
    const select = document.querySelector('[data-testid="workspace-select"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    return [...select.options].some((option) => option.textContent === name) &&
      select.selectedOptions[0]?.textContent === name;
  }, workspaceName);
  assert.equal(await page.getByTestId('workspace-select').evaluate((select, name) => (
    select instanceof HTMLSelectElement
      ? [...select.options].filter((option) => option.textContent === name).length
      : 0
  ), workspaceName), 1, 'double-clicking workspace create should create exactly one workspace option');
  createdWorkspaceRoot = String(await page.getByTestId('active-workspace-path').textContent());
  assert.ok(createdWorkspaceRoot.endsWith(workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')));
  const workspaceMarker = JSON.parse(await readFile(path.resolve(createdWorkspaceRoot, '.actoviq-workspace.json'), 'utf8'));
  assert.equal(workspaceMarker.name, workspaceName);
  for (const relative of ['projects', 'references', 'jobs']) {
    assert.equal((await stat(path.resolve(createdWorkspaceRoot, relative))).isDirectory(), true);
  }
  await page.getByTestId('create-demo-project').waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId('create-demo-project').getAttribute('aria-label'), 'Create three-module demo project');
  assert.equal(await page.getByTestId('create-demo-project').getAttribute('title'), 'Create three-module demo project');
  assert.equal(await page.getByTestId('create-blank-project').getAttribute('aria-label'), 'Create blank project');
  await page.getByTestId('create-demo-project').click();
  await page.getByTestId('empty-project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByText('Demo project', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('empty-project-create-submit').isDisabled(), false);
  assert.equal(await page.getByTestId('empty-project-cancel').getAttribute('aria-label'), 'Cancel project creation');
  assert.equal(await page.getByTestId('empty-project-create-submit').getAttribute('aria-label'), 'Create project');
  await page.getByTestId('empty-project-cancel').click();
  await page.getByTestId('empty-project-create-panel').waitFor({ state: 'detached', timeout: 10_000 });
  const emptyBlankProjectName = `Playwright Empty Blank ${Date.now()}`;
  await page.getByTestId('create-blank-project').waitFor({ timeout: 20_000 });
  await page.getByTestId('create-blank-project').click();
  await page.getByTestId('empty-project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('empty-project-name-input').fill(emptyBlankProjectName);
  await page.getByTestId('empty-project-create-submit').dblclick();
  await page.getByTestId('circuit-workbench').getByText(emptyBlankProjectName, { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(
    await countProjectsByNameInRoot(path.resolve(createdWorkspaceRoot, 'projects'), emptyBlankProjectName),
    1,
    'double-clicking empty-state project create should create exactly one project',
  );
  const emptyProjectManifest = await findProjectByNameInRoot(path.resolve(createdWorkspaceRoot, 'projects'), emptyBlankProjectName);
  assert.equal(emptyProjectManifest.project.modules.length, 0);
  await waitForWorkbenchProject(page, emptyProjectManifest.project.project_id);
  const emptySidebarProject = page.locator('[data-testid^="sidebar-project-"]').filter({ hasText: emptyBlankProjectName }).first();
  await emptySidebarProject.waitFor({ timeout: 30_000 });
  assert.equal(await emptySidebarProject.getAttribute('data-active'), 'true');
  assert.equal(await emptySidebarProject.getAttribute('aria-current'), 'true');
  assert.equal(await page.getByTestId('project-title').textContent(), emptyBlankProjectName);
  await page.getByTestId('sidebar-open-workspace-root').click();
  await page.getByTestId('sidebar-notice').getByText(/^Workspace opened: /).waitFor({ timeout: 20_000 });
  await page.getByTestId('sidebar-open-references').scrollIntoViewIfNeeded();
  await page.getByTestId('sidebar-open-references').click();
  await page.getByTestId('sidebar-notice').getByText(/^References opened: /).waitFor({ timeout: 20_000 });
  await page.getByTestId('sidebar-refresh-references').scrollIntoViewIfNeeded();
  assert.equal(await page.getByTestId('sidebar-refresh-references').getAttribute('aria-label'), 'Refresh references');
  await page.getByTestId('sidebar-refresh-references').click();
  const keyboardWorkspaceName = `Playwright Workspace Keyboard ${Date.now()}`;
  await page.getByTestId('sidebar-new-workspace').scrollIntoViewIfNeeded();
  await page.getByTestId('sidebar-new-workspace').click();
  await page.getByTestId('workspace-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('workspace-name-input').fill(keyboardWorkspaceName);
  await page.keyboard.press('Enter');
  await page.getByTestId('sidebar-notice').getByText(`Workspace created: ${keyboardWorkspaceName}`, { exact: true }).waitFor({ timeout: 20_000 });
  await page.waitForFunction((name) => {
    const select = document.querySelector('[data-testid="workspace-select"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    return [...select.options].some((option) => option.textContent === name) &&
      select.selectedOptions[0]?.textContent === name;
  }, keyboardWorkspaceName);
  assert.equal(await page.getByTestId('workspace-select').evaluate((select, name) => (
    select instanceof HTMLSelectElement
      ? [...select.options].filter((option) => option.textContent === name).length
      : 0
  ), keyboardWorkspaceName), 1, 'pressing Enter in workspace create should create exactly one workspace option');
  await page.getByTestId('workspace-select').selectOption('default');
  await page.getByTestId(`sidebar-project-${projectId}`).waitFor({ timeout: 20_000 });

  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await waitForWorkbenchProject(page, projectId);

  const sidebarProjectName = `Playwright Inline Project ${Date.now()}`;
  await page.getByTestId('sidebar-new-blank-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId('project-create-cancel').getAttribute('aria-label'), 'Cancel project creation');
  assert.equal(await page.getByTestId('project-create-submit').getAttribute('aria-label'), 'Create project');
  await page.keyboard.press('Escape');
  await page.getByTestId('project-create-panel').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByTestId('sidebar-new-blank-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('project-name-input').fill('');
  assert.equal(await page.getByTestId('project-create-submit').isDisabled(), true);
  await page.getByTestId('project-create-cancel').click();
  await page.getByTestId('project-create-panel').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByTestId('sidebar-new-blank-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('project-name-input').fill(sidebarProjectName);
  await page.getByTestId('project-create-submit').dblclick();
  await page.getByTestId('sidebar-notice').getByText(`Project created: ${sidebarProjectName}`, { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(
    await countProjectsByNameInRoot(projectsRoot, sidebarProjectName),
    1,
    'double-clicking sidebar blank project create should create exactly one project',
  );
  const sidebarBlankProjectManifest = await findProjectByName(sidebarProjectName);
  await waitForWorkbenchProject(page, sidebarBlankProjectManifest.project.project_id);
  const sidebarBlankProject = page.locator('[data-testid^="sidebar-project-"]').filter({ hasText: sidebarProjectName }).first();
  await sidebarBlankProject.waitFor({ timeout: 30_000 });
  assert.equal(await sidebarBlankProject.getAttribute('data-active'), 'true');
  assert.equal(await sidebarBlankProject.getAttribute('aria-current'), 'true');
  assert.equal(await sidebarBlankProject.getAttribute('aria-label'), `Open project ${sidebarProjectName}`);
  assert.equal(await page.getByTestId('project-title').textContent(), sidebarProjectName);
  const originalProjectButton = page.getByTestId(`sidebar-project-${projectId}`);
  assert.equal(await originalProjectButton.getAttribute('aria-label'), `Open project ${projectName}`);
  await originalProjectButton.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await waitForWorkbenchProject(page, projectId);
  assert.equal(await page.getByTestId(`sidebar-project-${projectId}`).getAttribute('data-active'), 'true');

  const sidebarKeyboardProjectName = `Playwright Keyboard Project ${Date.now()}`;
  await page.getByTestId('sidebar-new-blank-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('project-name-input').fill(sidebarKeyboardProjectName);
  await page.keyboard.press('Enter');
  await page.getByTestId('sidebar-notice').getByText(`Project created: ${sidebarKeyboardProjectName}`, { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(
    await countProjectsByNameInRoot(projectsRoot, sidebarKeyboardProjectName),
    1,
    'pressing Enter in sidebar project create should create exactly one project',
  );
  const sidebarKeyboardProjectManifest = await findProjectByName(sidebarKeyboardProjectName);
  await waitForWorkbenchProject(page, sidebarKeyboardProjectManifest.project.project_id);
  const sidebarKeyboardProject = page.locator('[data-testid^="sidebar-project-"]').filter({ hasText: sidebarKeyboardProjectName }).first();
  await sidebarKeyboardProject.waitFor({ timeout: 30_000 });
  assert.equal(await sidebarKeyboardProject.getAttribute('data-active'), 'true');
  assert.equal(await sidebarKeyboardProject.getAttribute('aria-current'), 'true');
  assert.equal(await page.getByTestId('project-title').textContent(), sidebarKeyboardProjectName);

  const sidebarDemoProjectName = `${e2eUiProjectPrefix}${Date.now()}`;
  await page.getByTestId('sidebar-new-demo-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByText('Demo project', { exact: true }).waitFor();
  await page.getByTestId('project-name-input').fill(sidebarDemoProjectName);
  await page.getByTestId('project-create-submit').dblclick();
  await page.getByTestId('sidebar-notice').getByText(`Project created: ${sidebarDemoProjectName}`, { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(
    await countProjectsByNameInRoot(projectsRoot, sidebarDemoProjectName),
    1,
    'double-clicking sidebar demo project create should create exactly one project',
  );
  const sidebarDemoProjectManifest = await findProjectByName(sidebarDemoProjectName);
  await waitForWorkbenchProject(page, sidebarDemoProjectManifest.project.project_id);
  const sidebarDemoProject = page.locator('[data-testid^="sidebar-project-"]').filter({ hasText: sidebarDemoProjectName }).first();
  await sidebarDemoProject.waitFor({ timeout: 30_000 });
  assert.equal(await sidebarDemoProject.getAttribute('data-active'), 'true');
  assert.equal(await sidebarDemoProject.getAttribute('aria-current'), 'true');
  assert.equal(await page.getByTestId('project-title').textContent(), sidebarDemoProjectName);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="module-card-"]').length === 3);
  await page.getByTestId('open-project-erc').click();
  await page.getByTestId('project-erc-panel').waitFor();
  await page.getByTestId('project-erc-panel').getByText(/Revision \d+ \| \d+ errors \| \d+ warnings/).waitFor();
  await page.getByTestId('close-project-erc').click();
  await page.getByTestId('project-erc-panel').waitFor({ state: 'detached' });
  assert.equal(sidebarDemoProjectManifest.project.modules.length, 3);
  assert.ok(sidebarDemoProjectManifest.project.connections.length >= 2);
  assert.ok(sidebarDemoProjectManifest.project.modules.some((module) => module.id === 'filter'));

  await sidebarDemoProject.click({ button: 'right' });
  await page.getByTestId('sidebar-project-context-menu').waitFor();
  await page.getByTestId('sidebar-context-trash-project').click();
  await page.getByTestId('project-delete-confirmation').getByText(sidebarDemoProjectName, { exact: true }).waitFor();
  await page.getByTestId('project-delete-confirm').click();
  await page.getByTestId(`sidebar-project-${sidebarDemoProjectManifest.project.project_id}`).waitFor({ state: 'detached' });
  await page.waitForFunction((deletedId) => (
    document.querySelector('[data-testid="circuit-workbench"]')?.getAttribute('data-project-id') !== deletedId
  ), sidebarDemoProjectManifest.project.project_id);
  const trashedDemo = page.locator('[data-testid^="sidebar-trash-"]')
    .filter({ hasText: sidebarDemoProjectName }).last();
  await trashedDemo.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByTestId(`sidebar-project-${sidebarDemoProjectManifest.project.project_id}`).waitFor({ timeout: 30_000 });

  await page.getByTestId('sidebar-project-selection-mode').click();
  await page.getByTestId(`sidebar-project-select-${sidebarBlankProjectManifest.project.project_id}`).check();
  await page.getByTestId(`sidebar-project-select-${sidebarKeyboardProjectManifest.project.project_id}`).check();
  await page.getByTestId('sidebar-trash-selected-projects').click();
  const batchConfirmation = page.getByTestId('project-delete-confirmation');
  await batchConfirmation.getByText(sidebarProjectName, { exact: true }).waitFor();
  await batchConfirmation.getByText(sidebarKeyboardProjectName, { exact: true }).waitFor();
  await page.getByTestId('project-delete-confirm').click();
  await page.getByTestId(`sidebar-project-${sidebarBlankProjectManifest.project.project_id}`).waitFor({ state: 'detached' });
  await page.getByTestId(`sidebar-project-${sidebarKeyboardProjectManifest.project.project_id}`).waitFor({ state: 'detached' });
  for (const [name, id] of [
    [sidebarProjectName, sidebarBlankProjectManifest.project.project_id],
    [sidebarKeyboardProjectName, sidebarKeyboardProjectManifest.project.project_id],
  ]) {
    const trashItem = page.locator('[data-testid^="sidebar-trash-"]').filter({ hasText: name }).last();
    await trashItem.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByTestId(`sidebar-project-${id}`).waitFor({ timeout: 30_000 });
  }

  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await waitForWorkbenchProject(page, projectId);
  await clickEnabledTestId(page, 'open-project-folder');
  await page.getByText(/^Opened project folder: /).waitFor({ timeout: 20_000 });

  await clickEnabledTestId(page, 'open-eda-export');
  await page.getByTestId('eda-export-dialog').waitFor();
  await page.getByTestId('eda-export-native-convert').selectOption('never');
  await clickEnabledTestId(page, 'run-eda-export');
  await page.getByTestId('eda-export-result').waitFor({ timeout: 60_000 });
  const expectedExportStatuses = {
    kicad: 'syntax_validated',
    altium: 'kicad_import_source',
    orcad: 'syntax_validated',
    virtuoso: 'generated_unverified',
  };
  for (const [target, status] of Object.entries(expectedExportStatuses)) {
    await page.getByTestId(`eda-export-status-${target}`).getByText(status, { exact: true }).waitFor();
  }
  const exportNotice = await page.locator('[role="status"]').textContent();
  const exportId = exportNotice?.match(/EDA export (\S+) complete/)?.[1] ?? '';
  assert.match(exportId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  const exportManifest = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'exports', exportId, 'manifest.json'), 'utf8'));
  assert.equal(exportManifest.schema, 'actoviq.eda-export-manifest.v1');
  assert.equal(new Set(Object.values(exportManifest.targets).map((target) => target.connectivity_hash)).size, 1);
  await clickEnabledTestId(page, 'open-eda-export-folder');
  await page.getByTestId('close-eda-export').click();
  await page.getByTestId('eda-export-dialog').waitFor({ state: 'detached' });

  assert.equal(await page.getByTestId('system-canvas').count(), 1);
  assert.equal(await page.locator('[data-testid^="module-card-"]').count(), 3);
  assert.equal(await page.getByTestId('module-preview-power').locator('svg').count(), 1);
  assert.equal(await page.getByTestId('module-preview-power').getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('module-summary-amplifier').count(), 1);
  assert.equal(await page.getByTestId('module-preview-filter').locator('svg').count(), 1);
  assert.equal(await page.getByTestId('module-preview-filter').getAttribute('data-schematic-source'), 'document');
  assert.ok(
    await page.getByTestId('module-preview-document-svg-filter').locator('g[data-wire-id]').count() >= 3,
    'filter card preview did not render document wires',
  );
  assert.equal(await page.getByTestId('module-preview-filter').getByText(/Rload_/).count(), 0);
  assert.equal(await page.locator('[data-testid="system-canvas"] > svg').count(), 0);
  assert.equal(await page.locator('[data-testid="system-canvas"] [data-connection-id]').count(), 0);

  const filterCard = page.getByTestId('module-card-filter');
  assert.equal(
    (await filterCard.getByTestId('interface-input').textContent())?.replace(/\s+/g, ' ').trim(),
    'IN: AMP_OUT, VDD',
  );
  assert.equal(
    (await filterCard.getByTestId('interface-output').textContent())?.replace(/\s+/g, ' ').trim(),
    'OUT: out',
  );
  assert.equal(
    (await filterCard.getByTestId('interface-ground').textContent())?.replace(/\s+/g, ' ').trim(),
    'GND: GND',
  );
  assert.equal(
    (await page.getByTestId('module-card-power').getByTestId('interface-output').textContent())
      ?.replace(/\s+/g, ' ').trim(),
    'OUT: SIGNAL, VDD',
  );
  assert.equal(
    (await page.getByTestId('module-card-amplifier').getByTestId('interface-input').textContent())
      ?.replace(/\s+/g, ' ').trim(),
    'IN: SIGNAL, VDD',
  );

  await filterCard.click();
  await page.getByTestId('topbar-tab-netlist').click();
  await page.getByTestId('netlist-notebook').waitFor();
  await page.getByText('RC low-pass filter · Design module', { exact: true }).waitFor();
  const notebookPreview = page.getByTestId('netlist-notebook-preview');
  await notebookPreview.getByRole('heading', { name: 'RC low-pass filter', exact: true }).waitFor();
  assert.equal(await notebookPreview.getByText('Power and stimulus', { exact: true }).count(), 0);

  const filterNetlist = await readFile(
    path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'),
    'utf8',
  );
  const notebookText = [
    '# RC low-pass filter',
    '',
    'Selected Design module notebook. This note is editable and persists beside the module.',
    '',
    '## SPICE netlist',
    '',
    '```spice',
    filterNetlist.trim(),
    '```',
    '',
    '## Notes',
    '',
    'Playwright verified the Markdown notebook and matching SVG context.',
    '',
  ].join('\n');
  await page.getByTestId('netlist-mode-edit').click();
  const editorKind = await Promise.race([
    page.locator('.monaco-editor').waitFor({ timeout: 8_000 }).then(() => 'monaco').catch(() => null),
    page.getByTestId('netlist-notebook-editor').waitFor({ timeout: 8_000 }).then(() => 'textarea').catch(() => null),
  ]);
  assert.ok(editorKind, 'notebook editor did not mount Monaco or textarea fallback');
  if (editorKind === 'monaco') {
    await page.locator('.monaco-editor').click({ position: { x: 220, y: 120 } });
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(notebookText);
  } else {
    assert.equal(
      await page.getByTestId('netlist-notebook-editor').getAttribute('data-editor-kind'),
      'e2e-plain-text',
      'Electron e2e should use the local textarea editor to avoid Monaco network loader flakiness',
    );
    await page.getByTestId('netlist-notebook-editor').fill(notebookText);
  }
  await page.getByTestId('save-netlist-notebook').click();
  await page.getByText('Saved and SVG refreshed', { exact: true }).waitFor({ timeout: 20_000 });
  assert.match(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'netlist-notebook.md'), 'utf8'),
    /Playwright verified the Markdown notebook/,
  );
  const revisionAfterNotebook = JSON.parse(
    await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'),
  ).revision;
  assert.equal(revisionAfterNotebook, initialRevision + 1, 'notebook save should create exactly one project revision');
  await page.getByTestId('netlist-mode-preview').click();
  await page.getByTestId('netlist-notebook-preview')
    .getByText('Playwright verified the Markdown notebook and matching SVG context.', { exact: true })
    .waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'light-netlist-notebook.png') });

  await page.getByTestId('topbar-tab-svg').click();
  await page.getByTestId('svg-context-label').getByText(/RC low-pass filter/).waitFor();
  assert.equal(await page.getByTestId('schematic-svg-viewport').locator('svg').count(), 1);
  assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
  const svgWrapperBox = await page.getByTestId('module-netlistsvg').boundingBox();
  assert.ok(svgWrapperBox && svgWrapperBox.width > 200 && svgWrapperBox.height > 160, 'document SVG wrapper has invalid dimensions');
  await page.screenshot({ path: path.resolve(outputRoot, 'light-svg-context.png') });

  const lightTheme = await page.evaluate(() => {
    const app = document.querySelector('.theme-light');
    const svgTab = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'SVG');
    const tabBar = svgTab?.parentElement;
    return {
      appBackground: app ? getComputedStyle(app).backgroundColor : '',
      tabBarBackground: tabBar ? getComputedStyle(tabBar).backgroundColor : '',
    };
  });
  assert.match(lightTheme.appBackground, /rgb\(243,\s*245,\s*247\)/);
  assert.match(lightTheme.tabBarBackground, /rgb\(233,\s*237,\s*242\)/);

  await page.getByTestId('topbar-tab-design').click();
  await page.getByTestId('system-canvas').waitFor();

  const systemFit = await page.evaluate(() => {
    const workbench = document.querySelector('[data-testid="circuit-workbench"]')?.getBoundingClientRect();
    const canvas = document.querySelector('[data-testid="system-canvas"]')?.getBoundingClientRect();
    const canvasPanel = document.querySelector('[data-testid="canvas-panel"]')?.getBoundingClientRect();
    const inspector = document.querySelector('[data-testid="circuit-inspector"]')?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      documentOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      workbenchBottom: workbench?.bottom ?? 0,
      canvasWidth: canvas?.width ?? 0,
      canvasPanelRight: canvasPanel?.right ?? 0,
      inspectorLeft: inspector?.left ?? 0,
    };
  });
  assert.equal(systemFit.documentOverflowX, false);
  assert.equal(systemFit.documentOverflowY, false);
  assert.ok(systemFit.workbenchBottom <= systemFit.height + 1);
  assert.ok(systemFit.canvasWidth > 0);
  assert.ok(systemFit.canvasPanelRight <= systemFit.inspectorLeft + 1);
  await page.screenshot({ path: path.resolve(outputRoot, 'module-hub-canvas.png') });

  const canvasPanel = page.getByTestId('canvas-panel');
  const canvasBox = await canvasPanel.boundingBox();
  assert.ok(canvasBox);
  await canvasPanel.dispatchEvent('wheel', {
    deltaY: -120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await page.getByTestId('canvas-zoom').getByText('75%', { exact: true }).waitFor();
  assert.equal(await canvasPanel.getAttribute('data-canvas-zoom'), '75');

  await canvasPanel.focus();
  await page.keyboard.press('+');
  await page.getByTestId('canvas-zoom').getByText('85%', { exact: true }).waitFor();
  await page.keyboard.press('-');
  await page.getByTestId('canvas-zoom').getByText('75%', { exact: true }).waitFor();
  await canvasPanel.evaluate((element) => {
    element.scrollLeft = 260;
    element.scrollTop = 180;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.keyboard.press('Home');
  await page.getByTestId('canvas-zoom').getByText('65%', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const raw = document.querySelector('[data-testid="canvas-panel"]')?.getAttribute('data-canvas-scroll') ?? '{}';
    const scroll = JSON.parse(raw);
    const canvas = document.querySelector('[data-testid="system-canvas"]');
    const zoom = Number(document.querySelector('[data-testid="canvas-panel"]')?.getAttribute('data-canvas-zoom') ?? '65') / 100;
    const expectedLeft = Math.round(Number(canvas?.getAttribute('data-board-origin-x') ?? '0') * zoom);
    const expectedTop = Math.round(Number(canvas?.getAttribute('data-board-origin-y') ?? '0') * zoom);
    return Number(scroll.left) === expectedLeft && Number(scroll.top) === expectedTop;
  });

  await page.getByTestId('canvas-zoom-in').click();
  await page.getByTestId('canvas-zoom').getByText('75%', { exact: true }).waitFor();
  assert.equal(await canvasPanel.getAttribute('data-canvas-zoom'), '75');
  await page.getByTestId('canvas-zoom-out').click();
  await page.getByTestId('canvas-zoom').getByText('65%', { exact: true }).waitFor();
  assert.equal(await canvasPanel.getAttribute('data-canvas-zoom'), '65');
  assert.equal(await page.getByTestId('arrange-modules').isEnabled(), true);

  const scrollBeforePan = await canvasPanel.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await page.mouse.move(canvasBox.x + 700, canvasBox.y + 650);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(canvasBox.x + 520, canvasBox.y + 520, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  const scrollAfterPan = await canvasPanel.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  assert.ok(
    scrollAfterPan.left > scrollBeforePan.left ||
    scrollAfterPan.top > scrollBeforePan.top,
  );
  await canvasPanel.evaluate((element) => {
    element.scrollLeft = 220;
    element.scrollTop = 160;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const scrollBeforeSpacePan = await canvasPanel.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await canvasPanel.focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="canvas-panel"]')?.getAttribute('data-space-pan') === 'true'
  ));
  await page.mouse.move(canvasBox.x + Math.min(500, canvasBox.width - 40), canvasBox.y + Math.min(360, canvasBox.height - 40));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="canvas-panel"]')?.getAttribute('data-panning') === 'true'
  ));
  await page.mouse.move(canvasBox.x + Math.min(360, canvasBox.width - 80), canvasBox.y + Math.min(280, canvasBox.height - 80), { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="canvas-panel"]')?.getAttribute('data-space-pan') === 'false'
  ));
  const scrollAfterSpacePan = await canvasPanel.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  assert.ok(
    scrollAfterSpacePan.left > scrollBeforeSpacePan.left ||
    scrollAfterSpacePan.top > scrollBeforeSpacePan.top,
  );

  await filterCard.scrollIntoViewIfNeeded();
  const cardBeforeResize = await filterCard.boundingBox();
  const resizeHandle = page.getByTestId('resize-module-filter');
  const resizeHandleBox = await resizeHandle.boundingBox();
  assert.ok(cardBeforeResize && resizeHandleBox);
  await page.mouse.move(
    resizeHandleBox.x + resizeHandleBox.width / 2,
    resizeHandleBox.y + resizeHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    resizeHandleBox.x + resizeHandleBox.width / 2 + 90,
    resizeHandleBox.y + resizeHandleBox.height / 2 + 60,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.getByText(new RegExp(`revision ${revisionAfterNotebook + 1}`)).waitFor({ timeout: 10_000 });
  const cardAfterResize = await filterCard.boundingBox();
  assert.ok(cardAfterResize);
  assert.ok(cardAfterResize.width > cardBeforeResize.width + 60);
  assert.ok(cardAfterResize.height > cardBeforeResize.height + 35);

  await filterCard.click();
  await page.getByTestId('copy-id-filter').click();
  await page.getByTestId('copy-id-filter').getByText('Copied', { exact: true }).waitFor();

  await page.getByTestId('module-note').fill('Reduce the cutoff frequency and preserve the IN/OUT/GND interface.');
  await page.getByTestId('save-module-note').click();
  await page.getByText(new RegExp(`revision ${revisionAfterNotebook + 2}`)).waitFor({ timeout: 10_000 });

  let projectForPreview = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  runSkill([
    'apply',
    '--project-root', projectRoot,
    '--command-json', JSON.stringify({
      schema: 'actoviq.command.v1',
      command_id: `playwright-preview-off-${Date.now()}`,
      actor: 'playwright',
      project_id: projectId,
      base_revision: projectForPreview.revision,
      message: 'Hide filter preview',
      operations: [{ op: 'set_module_preview', module_id: 'filter', enabled: false }],
    }),
  ]);
  await page.getByText(new RegExp(`revision ${revisionAfterNotebook + 3}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-summary-filter').waitFor();
  await page.getByText('15.9 nF', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'module-summary-mode.png') });

  projectForPreview = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  runSkill([
    'apply',
    '--project-root', projectRoot,
    '--command-json', JSON.stringify({
      schema: 'actoviq.command.v1',
      command_id: `playwright-preview-on-${Date.now()}`,
      actor: 'playwright',
      project_id: projectId,
      base_revision: projectForPreview.revision,
      message: 'Show filter preview',
      operations: [{ op: 'set_module_preview', module_id: 'filter', enabled: true }],
    }),
  ]);
  await page.getByText(new RegExp(`revision ${revisionAfterNotebook + 4}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-preview-filter').locator('svg').waitFor();

  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('module-canvas').waitFor();
  await page.getByTestId('schematic-editor').waitFor();
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('schematic-editor-svg').getAttribute('data-schematic-source'), 'document');
  const editorSvgBox = await page.getByTestId('schematic-editor-svg').boundingBox();
  assert.ok(editorSvgBox && editorSvgBox.width > 100 && editorSvgBox.height > 100);
  await page.screenshot({ path: path.resolve(outputRoot, 'module-document-editor.png') });
  await page.getByTestId('schematic-svg-tab').click();
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor();
  assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('module-document-svg').getAttribute('data-schematic-source'), 'document');
  const moduleSvgBox = await page.getByTestId('module-document-svg').boundingBox();
  assert.ok(moduleSvgBox && moduleSvgBox.width > 100 && moduleSvgBox.height > 100);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  assert.ok(
    moduleSvgBox.y >= 0 && moduleSvgBox.y + moduleSvgBox.height <= viewportHeight + 1,
    'module document SVG is not fully visible in the current viewport',
  );
  await page.screenshot({ path: path.resolve(outputRoot, 'module-document-svg.png') });

  await page.getByTestId('rebuild-module-svg').click();
  await page.getByText('Module SVG updated', { exact: true }).waitFor({ timeout: 20_000 });

  await page.getByTestId('simulate-module').click();
  await page.getByText('Module simulation complete', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('module_output_1khz_db', { exact: true }).waitFor();

  const projectBeforeAgent = JSON.parse(
    await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'),
  );
  const externalCommand = {
    schema: 'actoviq.command.v1',
    command_id: `playwright-agent-${Date.now()}`,
    actor: 'codex',
    project_id: projectId,
    base_revision: projectBeforeAgent.revision,
    message: 'Agent updates module filter by stable ID.',
    operations: [{
      op: 'set_component_value',
      module_id: 'filter',
      component_id: 'c_filter',
      value: '22n',
    }, {
      op: 'set_module_note',
      module_id: 'filter',
      notes: 'Agent applied 22 nF and regenerated the module SVG.',
    }, {
      op: 'set_module_metadata',
      module_id: 'filter',
      parameters: {
        Resistance: '10 kohm',
        Capacitance: '22 nF',
        'Target cutoff': 'about 723 Hz',
      },
    }, {
      op: 'set_connection_network',
      connection_id: 'amplifier-to-filter',
      network: 'DAC#1',
    }],
  };
  runSkill([
    'apply',
    '--project-root', projectRoot,
    '--command-json', JSON.stringify(externalCommand),
  ]);
  const agentCompile = runSkill([
    'compile-module',
    '--project-root', projectRoot,
    '--module-id', 'filter',
  ]);
  assert.equal(agentCompile.render.ok, true);

  const projectAfterAgent = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  await page.getByText(new RegExp(`revision ${projectAfterAgent.revision}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-note').waitFor();
  await page.waitForFunction(() => {
    const note = document.querySelector('[data-testid="module-note"]');
    return note instanceof HTMLTextAreaElement &&
      note.value === 'Agent applied 22 nF and regenerated the module SVG.';
  });
  await page.getByText('22 nF', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('module-netlistsvg').locator('svg').count(), 1);
  assert.match(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'),
    /"value": "22n"/,
  );

  await page.getByTestId('open-project-history').click();
  await page.getByTestId('project-history-panel').waitFor();
  await page.getByTestId(`history-revision-${projectAfterAgent.revision}`).waitFor();
  assert.ok(
    await page.locator('[data-testid^="history-netlist-diff-"]').filter({ hasText: /Netlist diff \+[1-9]/ }).count() >= 1,
    'history should expose at least one notebook netlist change',
  );
  await page.getByTestId(`restore-history-revision-${projectAfterAgent.revision}`).click();
  await page.getByTestId('project-meta')
    .filter({ hasText: `revision ${projectAfterAgent.revision + 1}` })
    .waitFor({ timeout: 30_000 });
  await page.getByTestId('close-project-history').click();
  await page.getByTestId('project-history-panel').waitFor({ state: 'detached' });

  await page.getByTestId('back-to-board').click();
  await page.getByTestId('module-preview-filter').locator('svg').waitFor();
  assert.equal(
    (await page.getByTestId('module-card-amplifier').getByTestId('interface-output').textContent())
      ?.replace(/\s+/g, ' ').trim(),
    'OUT: DAC#1',
  );
  assert.equal(
    (await page.getByTestId('module-card-filter').getByTestId('interface-input').textContent())
      ?.replace(/\s+/g, ' ').trim(),
    'IN: DAC#1, VDD',
  );

  const buildManifestPath = path.resolve(projectRoot, 'build', 'build-manifest.json');
  const previousBuildManifest = await readJsonFile(buildManifestPath).catch(() => null);
  await waitForWorkbenchProject(page, projectId);
  await clickApplicationMenuPath(electronApp, ['Design', 'Render Schematic']);
  const menuBuildManifest = await waitForCompiledBuildManifest(
    buildManifestPath,
    previousBuildManifest?.built_at ?? '',
    ['power', 'amplifier', 'filter'],
  );
  assert.equal(menuBuildManifest.status, 'compiled');
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
  await page.getByTestId('topbar-tab-design').click();
  await waitForWorkbenchProject(page, projectId);
  await clickEnabledTestId(page, 'build-project');
  const buildManifest = await waitForCompiledBuildManifest(
    buildManifestPath,
    menuBuildManifest.built_at,
    ['power', 'amplifier', 'filter'],
  );
  assert.equal(buildManifest.status, 'compiled');
  assert.equal(buildManifest.modules.filter.render_ok, true);
  await page.getByTestId('module-preview-filter').locator('svg').waitFor();

  await waitForWorkbenchProject(page, projectId);
  await clickApplicationMenuPath(electronApp, ['Design', 'Run Simulation']);
  await page.getByTestId('project-simulation').waitFor({ timeout: 30_000 });
  await page.getByRole('cell', { name: 'output_1khz_db', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId('simulation-analysis-select').selectOption('ac-1');
  await page.getByTestId('simulation-bode-chart').waitFor({ timeout: 30_000 });
  await page.getByTestId('simulation-diagram-table').click();
  await page.getByTestId('simulation-dataset-table').waitFor();
  assert.ok(await page.getByTestId('simulation-dataset-table').getByRole('row').count() > 10);
  await page.getByRole('columnheader', { name: 'Target', exact: true }).waitFor();
  await page.getByText('not evaluated', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'simulation-workbench.png') });
  await page.getByTestId('topbar-tab-design').click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('module-card-filter').dblclick();
  const probeEditor = page.getByTestId('schematic-editor');
  await probeEditor.waitFor();
  const probeResistorId = await probeEditor.evaluate((node) => {
    const components = JSON.parse(node.getAttribute('data-components') ?? '[]');
    return components.find((component) => component.type === 'R')?.id ?? '';
  });
  assert.ok(probeResistorId, 'filter schematic should expose a resistor for current probing');
  await clickSchematicComponent(page, probeResistorId);
  await page.getByTestId('schematic-editor-probe-current').click();
  const currentProbeStatus = page.getByTestId('simulation-probe-status');
  await currentProbeStatus.getByText(/^Added i\(.+\) from filter$/).waitFor({ timeout: 30_000 });
  const currentProbeText = await currentProbeStatus.textContent();
  const currentTraceName = currentProbeText?.match(/^Added (.+) from filter$/)?.[1] ?? '';
  assert.ok(currentTraceName, 'current probe should resolve a simulation trace');
  const currentTraceChoice = page.locator('label').filter({ hasText: currentTraceName }).first().locator('input');
  assert.equal(await currentTraceChoice.isChecked(), true, 'current probe trace should be selected');
  assert.equal(
    await page.getByTestId('simulation-trace-panel').locator('input:checked').count(),
    1,
    'current probing should isolate the requested ampere trace',
  );
  assert.doesNotMatch(
    await page.getByTestId('simulation-bode-chart').innerText(),
    /-6000/,
    'current probe Bode plot should not contain a synthetic zero-vector floor',
  );
  await page.screenshot({ path: path.resolve(outputRoot, 'simulation-probe-current.png') });

  await page.getByTestId('topbar-tab-design').click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('module-card-filter').dblclick();
  await clickSchematicComponent(page, probeResistorId);
  await page.getByTestId(/^schematic-editor-probe-pin-/).last().click();
  const voltageProbeStatus = page.getByTestId('simulation-probe-status');
  await voltageProbeStatus.getByText(/^Added v\(.+\) from filter$/).waitFor({ timeout: 30_000 });
  const voltageProbeText = await voltageProbeStatus.textContent();
  const voltageTraceName = voltageProbeText?.match(/^Added (.+) from filter$/)?.[1] ?? '';
  assert.ok(voltageTraceName, 'voltage probe should resolve a simulation trace');
  const voltageTraceChoice = page.locator('label').filter({ hasText: voltageTraceName }).first().locator('input');
  assert.equal(await voltageTraceChoice.isChecked(), true, 'voltage probe trace should be selected');
  assert.doesNotMatch(
    await page.getByTestId('simulation-bode-chart').innerText(),
    /-6000/,
    'default voltage traces should omit unexcited rails that collapse the Bode scale',
  );
  await page.screenshot({ path: path.resolve(outputRoot, 'simulation-probe-voltage.png') });
  await page.getByTestId('topbar-tab-design').click();
  await waitForWorkbenchProject(page, projectId);

  await waitForWorkbenchProject(page, projectId);
  await clickEnabledTestId(page, 'save-design-template');
  await page.getByText(/Saved template playwright-module-hub-/).waitFor({ timeout: 30_000 });
  const templateNotice = await page.locator('[role="status"]').textContent();
  const templateId = templateNotice?.match(/Saved template (\S+)/)?.[1] ?? '';
  assert.match(templateId, /^playwright-module-hub-/);
  await page.getByTestId(`design-memory-template-${templateId}`).waitFor({ timeout: 10_000 });
  const savedTemplate = await readDesignMemoryManifest('template', templateId);
  assert.equal(savedTemplate.manifest.schema, 'actoviq.design-template.v2');
  assert.equal(savedTemplate.manifest.source_project_id, projectId);
  assert.match(savedTemplate.manifest.source_document_hash, /^[a-f0-9]{64}$/);
  assert.equal(savedTemplate.manifest.validation.status, 'simulated');
  assert.equal(savedTemplate.manifest.validation.preferred_for_agent_reuse, false);
  assert.ok(savedTemplate.manifest.validation.simulation_coverage.includes('ac'));
  assert.equal(savedTemplate.manifest.files.template_netlist, 'template.cir');
  assert.match(await readFile(path.resolve(savedTemplate.rootDir, 'agent-guide.md'), 'utf8'), /Saved Design Template/);
  assert.match(await readFile(path.resolve(savedTemplate.rootDir, 'template.cir'), 'utf8'), /22n/);

  await waitForWorkbenchProject(page, projectId);
  await clickEnabledTestId(page, 'save-design-flow');
  await page.getByText(/Saved flow playwright-module-hub-/).waitFor({ timeout: 30_000 });
  const flowNotice = await page.locator('[role="status"]').textContent();
  const flowId = flowNotice?.match(/Saved flow (\S+)/)?.[1] ?? '';
  assert.match(flowId, /^playwright-module-hub-/);
  await page.getByTestId(`design-memory-flow-${flowId}`).waitFor({ timeout: 10_000 });
  const savedFlow = await readDesignMemoryManifest('flow', flowId);
  assert.equal(savedFlow.manifest.schema, 'actoviq.design-flow.v2');
  assert.equal(savedFlow.manifest.source_project_id, projectId);
  assert.match(savedFlow.manifest.source_document_hash, /^[a-f0-9]{64}$/);
  assert.equal(savedFlow.manifest.validation.status, 'simulated');
  assert.ok(savedFlow.manifest.validation.simulation_coverage.includes('ac'));
  assert.ok(savedFlow.manifest.command_count >= 4);
  assert.match(await readFile(path.resolve(savedFlow.rootDir, 'design-flow.md'), 'utf8'), /Agent updates module filter/);
  await page.screenshot({ path: path.resolve(outputRoot, 'saved-design-memory.png') });

  await canvasPanel.evaluate((element) => {
    const canvas = document.querySelector('[data-testid="system-canvas"]');
    const zoom = Number(element.getAttribute('data-canvas-zoom') ?? '65') / 100;
    const originX = Number(canvas?.getAttribute('data-board-origin-x') ?? '0');
    const originY = Number(canvas?.getAttribute('data-board-origin-y') ?? '0');
    element.scrollLeft = Math.max(0, Math.round(originX * zoom - 260));
    element.scrollTop = Math.max(0, Math.round(originY * zoom - 180));
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await canvasPanel.click({ button: 'right', position: { x: 80, y: 80 } });
  await page.getByTestId('canvas-context-menu').waitFor();
  await page.getByTestId('context-add-module').click();
  await page.getByTestId('module-editor').waitFor();
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), false);
  await page.getByTestId('module-editor-id').fill('');
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), true, 'module editor save should be disabled without an ID');
  await page.getByTestId('module-editor-id').fill('bad id');
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), true, 'module editor save should be disabled for invalid IDs');
  await page.getByTestId('module-editor-id').fill('sensor');
  await page.getByTestId('module-editor-parameters').fill('Input range');
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), true, 'module editor save should be disabled for invalid parameter lines');
  await page.getByTestId('module-editor-name').fill('Sensor front end');
  await page.getByTestId('module-editor-kind').fill('input');
  await page.getByTestId('module-editor-function').fill('Conditions a sensor signal before amplification.');
  await page.getByTestId('module-editor-parameters').fill('Input range = 0-1 V');
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), false);
  const projectBeforeSensorAdd = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  await page.getByTestId('save-module-editor').click();
  await page.getByText(new RegExp(`revision ${projectBeforeSensorAdd.revision + 1}`)).waitFor({ timeout: 10_000 });
  const projectAfterSensorAdd = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  const sensorAfterAdd = projectAfterSensorAdd.modules.find((module) => module.id === 'sensor');
  assert.ok(sensorAfterAdd.position.x < 0, 'infinite canvas add should allow negative logical x');
  assert.ok(sensorAfterAdd.position.y < 0, 'infinite canvas add should allow negative logical y');
  await page.getByTestId('module-card-sensor').waitFor();
  await page.getByTestId('module-summary-sensor').getByText('0-1 V', { exact: true }).waitFor();

  await page.getByTestId('module-card-sensor').scrollIntoViewIfNeeded();
  await page.getByTestId('module-card-sensor').click({ button: 'right' });
  await page.getByTestId('context-edit-module').click();
  await page.getByTestId('module-editor-name').fill('');
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), true, 'module edit save should be disabled without a name');
  await page.getByTestId('module-editor-name').fill('Sensor front end');
  await page.getByTestId('module-editor-function').fill(
    'Conditions and protects the sensor signal before amplification.',
  );
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="save-module-editor"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  assert.equal(await page.getByTestId('save-module-editor').isDisabled(), false);
  const projectBeforeSensorEdit = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  await page.getByTestId('save-module-editor').click();
  await page.getByText(new RegExp(`revision ${projectBeforeSensorEdit.revision + 1}`)).waitFor({ timeout: 10_000 });
  await page.getByText(
    'Conditions and protects the sensor signal before amplification.',
    { exact: true },
  ).first().waitFor();

  await page.getByTestId('topbar-chat').click();
  await page.getByTestId('chat-close').waitFor();
  await page.getByTestId('chat-close').click();
  assert.equal(await page.getByTestId('chat-close').count(), 0);

  const staleCommand = { ...externalCommand, command_id: 'stale-command-check', base_revision: 0 };
  let staleRejected = false;
  try {
    runSkill([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(staleCommand),
    ]);
  } catch {
    staleRejected = true;
  }
  assert.equal(staleRejected, true);

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(960, 640);
  });
  await page.waitForTimeout(500);
  const minimumFit = await page.evaluate(() => {
    const workbench = document.querySelector('[data-testid="circuit-workbench"]')?.getBoundingClientRect();
    const toolbar = document.querySelector('[data-testid="build-project"]')?.getBoundingClientRect();
    const canvasPanel = document.querySelector('[data-testid="canvas-panel"]')?.getBoundingClientRect();
    const inspector = document.querySelector('[data-testid="circuit-inspector"]')?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      documentOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      workbenchRight: workbench?.right ?? 0,
      workbenchBottom: workbench?.bottom ?? 0,
      toolbarVisible: Boolean(toolbar && toolbar.top >= 0 && toolbar.bottom <= window.innerHeight),
      canvasWidth: canvasPanel?.width ?? 0,
      inspectorWidth: inspector?.width ?? 0,
    };
  });
  assert.equal(minimumFit.documentOverflowX, false);
  assert.equal(minimumFit.documentOverflowY, false);
  assert.ok(minimumFit.workbenchRight <= minimumFit.width + 1);
  assert.ok(minimumFit.workbenchBottom <= minimumFit.height + 1);
  assert.equal(minimumFit.toolbarVisible, true);
  assert.ok(minimumFit.canvasWidth > 0);
  assert.ok(minimumFit.inspectorWidth > 0);
  await page.screenshot({ path: path.resolve(outputRoot, 'minimum-window.png') });

  const finalProject = JSON.parse(await readFile(
    path.resolve(projectRoot, 'project.circuit.json'),
    'utf8',
  ));
  assert.equal(finalProject.revision, projectBeforeSensorEdit.revision + 1);
  assert.equal(finalProject.modules.length, 4);
  const finalFilter = finalProject.modules.find((module) => module.id === 'filter');
  assert.equal(finalFilter.preview_enabled, true);
  assert.ok(finalFilter.size.width > 400, 'filter resize width was not persisted');
  assert.ok(finalFilter.size.height > 300, 'filter resize height was not persisted');
  assert.equal(
    finalProject.connections.find((connection) => connection.id === 'amplifier-to-filter').network,
    'DAC#1',
  );
  assert.equal(
    finalProject.modules.find((module) => module.id === 'sensor').function,
    'Conditions and protects the sensor signal before amplification.',
  );

  const importedProjectName = `${projectName} copy`;
  await page.getByTestId(`use-design-memory-template-${templateId}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`use-design-memory-template-${templateId}`).click();
  await page.getByTestId('circuit-workbench')
    .getByText(importedProjectName, { exact: true })
    .waitFor({ timeout: 30_000 });
  assert.equal(
    await page.getByTestId('circuit-workbench').locator('[data-testid^="module-card-"]').count(),
    3,
  );
  const importedProjects = (await readdir(projectsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(e2eProjectPrefix) && entry.name !== projectId)
    .map((entry) => entry.name);
  assert.equal(importedProjects.length, 1);
  const importedProjectRoot = path.resolve(projectsRoot, importedProjects[0]);
  const importedProject = JSON.parse(await readFile(
    path.resolve(importedProjectRoot, 'project.circuit.json'),
    'utf8',
  ));
  assert.equal(importedProject.name, importedProjectName);
  assert.equal(importedProject.revision, 0);
  const importedFilterModule = JSON.parse(await readFile(
    path.resolve(importedProjectRoot, 'modules', 'filter', 'module.circuit.json'),
    'utf8',
  ));
  assert.equal(importedFilterModule.module_id, 'filter');
  assert.ok(importedFilterModule.components.some((component) => component.id === 'c_filter'));
  await page.screenshot({ path: path.resolve(outputRoot, 'imported-template-project.png') });
  assert.deepEqual(
    pageErrors.filter((entry) => !(
      entry.includes('ERR_NETWORK_ACCESS_DENIED') ||
      entry.includes('ERR_CONNECTION_CLOSED') ||
      entry.includes('Monaco initialization') ||
      entry === 'pageerror: Event'
    )),
    [],
  );
  console.log(JSON.stringify({
    ok: true,
    projectId,
    systemFit,
    minimumFit,
    screenshots: [
      'output/playwright/module-hub-canvas.png',
      'output/playwright/module-summary-mode.png',
      'output/playwright/module-document-editor.png',
      'output/playwright/module-document-svg.png',
      'output/playwright/simulation-workbench.png',
      'output/playwright/simulation-probe-current.png',
      'output/playwright/simulation-probe-voltage.png',
      'output/playwright/saved-design-memory.png',
      'output/playwright/imported-template-project.png',
      'output/playwright/light-netlist-notebook.png',
      'output/playwright/light-svg-context.png',
      'output/playwright/minimum-window.png',
    ],
  }, null, 2));
  testSucceeded = true;
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'failure.png') }).catch(() => {});
    console.error(JSON.stringify({
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500),
      html: (await page.locator('body').innerHTML().catch(() => '')).slice(0, 2500),
      pageErrors,
    }, null, 2));
  }
  throw error;
} finally {
  await electronApp.close();
  await cleanE2eArtifacts();
  if (viteProcess) {
    viteProcess.kill();
  }
}

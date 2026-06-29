import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const designMemoryRoot = path.resolve(workspaceRoot, 'references', 'design-memory');
const e2eProjectPrefix = 'playwright-module-hub-';
const e2eUiProjectPrefix = 'playwright-ui-project-';
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

async function cleanE2eDesignMemory() {
  await Promise.all([
    removePrefixedDirectories(path.resolve(designMemoryRoot, 'templates'), e2eProjectPrefix),
    removePrefixedDirectories(path.resolve(designMemoryRoot, 'flows'), e2eProjectPrefix),
  ]);
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
  const deadline = Date.now() + 60_000;
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
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(projectsRoot, entry.name);
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
await Promise.all([
  removePrefixedDirectories(projectsRoot, e2eProjectPrefix),
  removePrefixedDirectories(projectsRoot, e2eUiProjectPrefix),
]);
await cleanE2eDesignMemory();

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
const e2eUserDataDir = path.resolve(outputRoot, `electron-smoke-user-data-${Date.now()}`);
const e2eHomeDir = path.resolve(outputRoot, `electron-smoke-home-${Date.now()}`);
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
    ACTOVIQ_RENDERER_URL: viteUrl,
    HOME: e2eHomeDir,
    USERPROFILE: e2eHomeDir,
    PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  slowMo: 50,
});

let page;
try {
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });

  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });

  const workspaceName = `Playwright Workspace ${Date.now()}`;
  await page.getByTestId('sidebar-new-workspace').click();
  await page.getByTestId('workspace-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('workspace-name-input').fill(workspaceName);
  await page.getByTestId('workspace-name-input').press('Enter');
  await page.getByTestId('sidebar-notice').getByText(`Workspace created: ${workspaceName}`, { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByTestId('create-blank-project').waitFor({ timeout: 20_000 });
  await page.getByTestId('create-blank-project').click();
  await page.getByTestId('circuit-workbench').getByText('New circuit project', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId('sidebar-open-workspace-root').click();
  await page.getByTestId('sidebar-notice').getByText(/^Workspace opened: /).waitFor({ timeout: 20_000 });
  await page.getByTestId('sidebar-open-references').scrollIntoViewIfNeeded();
  await page.getByTestId('sidebar-open-references').click();
  await page.getByTestId('sidebar-notice').getByText(/^References opened: /).waitFor({ timeout: 20_000 });
  await page.getByTestId('workspace-select').selectOption('default');
  await page.getByTestId(`sidebar-project-${projectId}`).waitFor({ timeout: 20_000 });

  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();

  const sidebarProjectName = `Playwright Inline Project ${Date.now()}`;
  await page.getByTestId('sidebar-new-blank-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.getByTestId('project-create-panel').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByTestId('sidebar-new-blank-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByTestId('project-name-input').fill(sidebarProjectName);
  await page.getByTestId('project-name-input').press('Enter');
  await page.getByTestId('sidebar-notice').getByText(`Project created: ${sidebarProjectName}`, { exact: true }).waitFor({ timeout: 60_000 });
  await page.locator('[data-testid^="sidebar-project-"]').filter({ hasText: sidebarProjectName }).first().waitFor({ timeout: 30_000 });
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();

  const sidebarDemoProjectName = `${e2eUiProjectPrefix}${Date.now()}`;
  await page.getByTestId('sidebar-new-demo-project').click();
  await page.getByTestId('project-create-panel').waitFor({ timeout: 10_000 });
  await page.getByText('Demo project', { exact: true }).waitFor();
  await page.getByTestId('project-name-input').fill(sidebarDemoProjectName);
  await page.getByTestId('project-create-submit').click();
  await page.getByTestId('sidebar-notice').getByText(`Project created: ${sidebarDemoProjectName}`, { exact: true }).waitFor({ timeout: 60_000 });
  await page.locator('[data-testid^="sidebar-project-"]').filter({ hasText: sidebarDemoProjectName }).first().waitFor({ timeout: 30_000 });
  await page.getByTestId('circuit-workbench').getByText(sidebarDemoProjectName, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="module-card-"]').length === 3);
  const sidebarDemoProject = await findProjectByName(sidebarDemoProjectName);
  assert.equal(sidebarDemoProject.project.modules.length, 3);
  assert.ok(sidebarDemoProject.project.connections.length >= 2);
  assert.ok(sidebarDemoProject.project.modules.some((module) => module.id === 'filter'));
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await page.getByTestId('open-project-folder').click();
  await page.getByText(/^Opened project folder: /).waitFor({ timeout: 20_000 });

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
  await page.getByRole('button', { name: 'Netlist', exact: true }).click();
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
    await page.getByTestId('netlist-notebook-editor').fill(notebookText);
  }
  await page.getByTestId('save-netlist-notebook').click();
  await page.getByText('Saved and SVG refreshed', { exact: true }).waitFor({ timeout: 20_000 });
  assert.match(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'netlist-notebook.md'), 'utf8'),
    /Playwright verified the Markdown notebook/,
  );
  await page.getByTestId('netlist-mode-preview').click();
  await page.getByTestId('netlist-notebook-preview')
    .getByText('Playwright verified the Markdown notebook and matching SVG context.', { exact: true })
    .waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'light-netlist-notebook.png') });

  await page.getByRole('button', { name: 'SVG', exact: true }).click();
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
  assert.match(lightTheme.tabBarBackground, /rgb\(255,\s*255,\s*255\)/);

  await page.getByRole('button', { name: 'Design', exact: true }).click();
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
  await page.getByText(new RegExp(`revision ${initialRevision + 1}`)).waitFor({ timeout: 10_000 });
  const cardAfterResize = await filterCard.boundingBox();
  assert.ok(cardAfterResize);
  assert.ok(cardAfterResize.width > cardBeforeResize.width + 60);
  assert.ok(cardAfterResize.height > cardBeforeResize.height + 35);

  await filterCard.click();
  await page.getByTestId('copy-id-filter').click();
  await page.getByTestId('copy-id-filter').getByText('Copied', { exact: true }).waitFor();

  await page.getByTestId('module-note').fill('Reduce the cutoff frequency and preserve the IN/OUT/GND interface.');
  await page.getByTestId('save-module-note').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 2}`)).waitFor({ timeout: 10_000 });

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
  await page.getByText(new RegExp(`revision ${initialRevision + 3}`)).waitFor({ timeout: 10_000 });
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
  await page.getByText(new RegExp(`revision ${initialRevision + 4}`)).waitFor({ timeout: 10_000 });
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
  await page.getByTestId('build-project').click();
  const buildManifest = await waitForCompiledBuildManifest(
    buildManifestPath,
    previousBuildManifest?.built_at ?? '',
    ['power', 'amplifier', 'filter'],
  );
  assert.equal(buildManifest.status, 'compiled');
  assert.equal(buildManifest.modules.filter.render_ok, true);
  await page.getByTestId('module-preview-filter').locator('svg').waitFor();

  await page.getByTestId('simulate-project').click();
  await page.getByText('System simulation complete', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('output_1khz_db', { exact: true }).waitFor();

  await page.getByTestId('save-design-template').click();
  await page.getByText(/Saved template playwright-module-hub-/).waitFor({ timeout: 30_000 });
  const templateNotice = await page.locator('[role="status"]').textContent();
  const templateId = templateNotice?.match(/Saved template (\S+)/)?.[1] ?? '';
  assert.match(templateId, /^playwright-module-hub-/);
  await page.getByTestId(`design-memory-template-${templateId}`).waitFor({ timeout: 10_000 });
  const savedTemplate = await readDesignMemoryManifest('template', templateId);
  assert.equal(savedTemplate.manifest.schema, 'actoviq.design-template.v1');
  assert.equal(savedTemplate.manifest.source_project_id, projectId);
  assert.equal(savedTemplate.manifest.files.template_netlist, 'template.cir');
  assert.match(await readFile(path.resolve(savedTemplate.rootDir, 'agent-guide.md'), 'utf8'), /Saved Design Template/);
  assert.match(await readFile(path.resolve(savedTemplate.rootDir, 'template.cir'), 'utf8'), /22n/);

  await page.getByTestId('save-design-flow').click();
  await page.getByText(/Saved flow playwright-module-hub-/).waitFor({ timeout: 30_000 });
  const flowNotice = await page.locator('[role="status"]').textContent();
  const flowId = flowNotice?.match(/Saved flow (\S+)/)?.[1] ?? '';
  assert.match(flowId, /^playwright-module-hub-/);
  await page.getByTestId(`design-memory-flow-${flowId}`).waitFor({ timeout: 10_000 });
  const savedFlow = await readDesignMemoryManifest('flow', flowId);
  assert.equal(savedFlow.manifest.schema, 'actoviq.design-flow.v1');
  assert.equal(savedFlow.manifest.source_project_id, projectId);
  assert.ok(savedFlow.manifest.command_count >= 4);
  assert.match(await readFile(path.resolve(savedFlow.rootDir, 'design-flow.md'), 'utf8'), /Agent updates module filter/);
  await page.screenshot({ path: path.resolve(outputRoot, 'saved-design-memory.png') });

  await canvasPanel.click({ button: 'right', position: { x: 520, y: 500 } });
  await page.getByTestId('canvas-context-menu').waitFor();
  await page.getByTestId('context-add-module').click();
  await page.getByTestId('module-editor').waitFor();
  await page.getByTestId('module-editor-id').fill('sensor');
  await page.getByTestId('module-editor-name').fill('Sensor front end');
  await page.getByTestId('module-editor-kind').fill('input');
  await page.getByTestId('module-editor-function').fill('Conditions a sensor signal before amplification.');
  await page.getByTestId('module-editor-parameters').fill('Input range = 0-1 V');
  const projectBeforeSensorAdd = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  await page.getByTestId('save-module-editor').click();
  await page.getByText(new RegExp(`revision ${projectBeforeSensorAdd.revision + 1}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-card-sensor').waitFor();
  await page.getByTestId('module-summary-sensor').getByText('0-1 V', { exact: true }).waitFor();

  await page.getByTestId('module-card-sensor').click({ button: 'right' });
  await page.getByTestId('context-edit-module').click();
  await page.getByTestId('module-editor-function').fill(
    'Conditions and protects the sensor signal before amplification.',
  );
  const projectBeforeSensorEdit = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
  await page.getByTestId('save-module-editor').click();
  await page.getByText(new RegExp(`revision ${projectBeforeSensorEdit.revision + 1}`)).waitFor({ timeout: 10_000 });
  await page.getByText(
    'Conditions and protects the sensor signal before amplification.',
    { exact: true },
  ).first().waitFor();

  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByText('Chat Workflow', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.getByText('Chat Workflow', { exact: true }).count(), 0);

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
  assert.equal(finalFilter.size.width, 440);
  assert.equal(finalFilter.size.height, 330);
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
      'output/playwright/saved-design-memory.png',
      'output/playwright/imported-template-project.png',
      'output/playwright/light-netlist-notebook.png',
      'output/playwright/light-svg-context.png',
      'output/playwright/minimum-window.png',
    ],
  }, null, 2));
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
  if (viteProcess) {
    viteProcess.kill();
  }
}

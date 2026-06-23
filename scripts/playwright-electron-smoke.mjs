import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const designMemoryRoot = path.resolve(workspaceRoot, 'references', 'design-memory');
const e2eProjectPrefix = 'playwright-module-hub-';
const viteUrl = 'http://127.0.0.1:5173';
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

async function canFetch(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function startViteIfNeeded() {
  if (await canFetch(viteUrl)) return null;
  let exited = null;
  const child = spawn(process.execPath, [
    viteBin,
    '--host',
    '127.0.0.1',
    '--port',
    '5173',
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
    if (await canFetch(viteUrl)) return child;
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

async function fileMtimeMs(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function waitForFileMtimeAfter(filePath, previousMtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastMtime = 0;
  while (Date.now() < deadline) {
    lastMtime = await fileMtimeMs(filePath);
    if (lastMtime > previousMtime) return lastMtime;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${filePath} to update after ${previousMtime}; last mtime was ${lastMtime}`);
}

const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
for (const entry of entries) {
  if (
    !entry.isDirectory() ||
    !entry.name.startsWith(e2eProjectPrefix)
  ) continue;
  const target = path.resolve(projectsRoot, entry.name);
  assert.equal(path.dirname(target), projectsRoot);
  await rm(target, { recursive: true, force: true });
}
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
const electronApp = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, ACTOVIQ_E2E: '1' },
});

let page;
try {
  page = await electronApp.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();

  assert.equal(await page.getByTestId('system-canvas').count(), 1);
  assert.equal(await page.locator('[data-testid^="module-card-"]').count(), 3);
  assert.equal(await page.getByTestId('module-preview-power').locator('svg').count(), 1);
  assert.equal(await page.getByTestId('module-summary-amplifier').count(), 1);
  assert.equal(await page.getByTestId('module-preview-filter').locator('svg').count(), 1);
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
  await page.locator('.monaco-editor').waitFor();
  await page.locator('.monaco-editor').click({ position: { x: 220, y: 120 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(notebookText);
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

  await page.getByTestId('preview-toggle-filter').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 3}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-summary-filter').waitFor();
  await page.getByText('15.9 nF', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'module-summary-mode.png') });

  await page.getByTestId('preview-toggle-filter').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 4}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-preview-filter').locator('svg').waitFor();

  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('module-canvas').waitFor();
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor();
  const moduleSvgBefore = await page.getByTestId('module-netlistsvg').innerHTML();
  assert.match(moduleSvgBefore, /<svg\b/);
  const moduleSvgBox = await page.getByTestId('module-netlistsvg').locator('svg').boundingBox();
  assert.ok(moduleSvgBox && moduleSvgBox.width > 100 && moduleSvgBox.height > 100);
  await page.screenshot({ path: path.resolve(outputRoot, 'module-netlistsvg.png') });

  await page.getByTestId('toggle-schematic-layout-edit').click();
  await page.getByTestId('toggle-schematic-layout-edit').getByText('Done', { exact: true }).waitFor();
  const filterCapacitor = page.locator('[data-testid="module-netlistsvg"] svg #cell_Cfilter_Cfilter');
  await filterCapacitor.waitFor();
  const capacitorBox = await filterCapacitor.boundingBox();
  assert.ok(capacitorBox);
  await page.mouse.move(capacitorBox.x + capacitorBox.width / 2, capacitorBox.y + capacitorBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    capacitorBox.x + capacitorBox.width / 2 + 55,
    capacitorBox.y + capacitorBox.height / 2 + 28,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.getByText(new RegExp(`revision ${initialRevision + 5}`)).waitFor({ timeout: 20_000 });
  await page.getByText('Moved Cfilter_Cfilter', { exact: true }).waitFor({ timeout: 20_000 });
  const filterOverrides = JSON.parse(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'schematic.overrides.json'), 'utf8'),
  );
  assert.equal(filterOverrides.schema, 'actoviq.schematic-overrides.v1');
  assert.equal(filterOverrides.items.Cfilter_Cfilter.locked, true);
  assert.equal(typeof filterOverrides.items.Cfilter_Cfilter.x, 'number');
  assert.equal(typeof filterOverrides.items.Cfilter_Cfilter.y, 'number');
  await page.getByTestId('schematic-overrides-panel').waitFor();
  await page.getByTestId('schematic-selected-item').getByText(/Cfilter_Cfilter/).waitFor();
  await page.getByTestId('schematic-override-Cfilter_Cfilter').waitFor();
  const movedX = filterOverrides.items.Cfilter_Cfilter.x;
  const movedY = filterOverrides.items.Cfilter_Cfilter.y;

  await page.getByTestId('schematic-nudge-right').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 6}`)).waitFor({ timeout: 20_000 });
  const nudgedOverrides = JSON.parse(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'schematic.overrides.json'), 'utf8'),
  );
  assert.equal(nudgedOverrides.items.Cfilter_Cfilter.x, movedX + 10);
  assert.equal(nudgedOverrides.items.Cfilter_Cfilter.y, movedY);

  await page.getByTestId('schematic-undo').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 7}`)).waitFor({ timeout: 20_000 });
  const undoneOverrides = JSON.parse(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'schematic.overrides.json'), 'utf8'),
  );
  assert.equal(undoneOverrides.items.Cfilter_Cfilter.x, movedX);
  assert.equal(undoneOverrides.items.Cfilter_Cfilter.y, movedY);

  await page.getByTestId('schematic-redo').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 8}`)).waitFor({ timeout: 20_000 });
  const redoneOverrides = JSON.parse(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'schematic.overrides.json'), 'utf8'),
  );
  assert.equal(redoneOverrides.items.Cfilter_Cfilter.x, movedX + 10);

  await page.getByTestId('schematic-reset-selected').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 9}`)).waitFor({ timeout: 20_000 });
  await page.getByText('Reset Cfilter_Cfilter', { exact: true }).waitFor({ timeout: 20_000 });
  const resetOverrides = JSON.parse(
    await readFile(path.resolve(projectRoot, 'modules', 'filter', 'schematic.overrides.json'), 'utf8'),
  );
  assert.equal(resetOverrides.items.Cfilter_Cfilter, undefined);

  await filterCapacitor.waitFor();
  const capacitorBoxAfterReset = await filterCapacitor.boundingBox();
  assert.ok(capacitorBoxAfterReset);
  await page.mouse.move(
    capacitorBoxAfterReset.x + capacitorBoxAfterReset.width / 2,
    capacitorBoxAfterReset.y + capacitorBoxAfterReset.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    capacitorBoxAfterReset.x + capacitorBoxAfterReset.width / 2 + 35,
    capacitorBoxAfterReset.y + capacitorBoxAfterReset.height / 2 + 25,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.getByText(new RegExp(`revision ${initialRevision + 10}`)).waitFor({ timeout: 20_000 });
  await page.getByTestId('schematic-override-Cfilter_Cfilter').waitFor({ timeout: 20_000 });
  await page.getByTestId('toggle-schematic-layout-edit').click();
  await page.screenshot({ path: path.resolve(outputRoot, 'module-layout-edit.png') });

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

  await page.getByText(new RegExp(`revision ${initialRevision + 11}`)).waitFor({ timeout: 10_000 });
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
  const buildManifestMtime = await fileMtimeMs(buildManifestPath);
  await page.getByTestId('build-project').click();
  await waitForFileMtimeAfter(buildManifestPath, buildManifestMtime, 30_000);
  await page.getByTestId('module-preview-filter').locator('svg').waitFor();

  const systemSimulationPath = path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json');
  const systemSimulationMtime = await fileMtimeMs(systemSimulationPath);
  await page.getByTestId('simulate-project').click();
  await waitForFileMtimeAfter(systemSimulationPath, systemSimulationMtime, 30_000);
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
  assert.ok(savedFlow.manifest.command_count >= 5);
  assert.match(await readFile(path.resolve(savedFlow.rootDir, 'design-flow.md'), 'utf8'), /Move schematic item Cfilter_Cfilter/);
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
  await page.getByTestId('save-module-editor').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 12}`)).waitFor({ timeout: 10_000 });
  await page.getByTestId('module-card-sensor').waitFor();
  await page.getByTestId('module-summary-sensor').getByText('0-1 V', { exact: true }).waitFor();

  await page.getByTestId('module-card-sensor').click({ button: 'right' });
  await page.getByTestId('context-edit-module').click();
  await page.getByTestId('module-editor-function').fill(
    'Conditions and protects the sensor signal before amplification.',
  );
  await page.getByTestId('save-module-editor').click();
  await page.getByText(new RegExp(`revision ${initialRevision + 13}`)).waitFor({ timeout: 10_000 });
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
  assert.equal(finalProject.revision, initialRevision + 13);
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
  const importedFilterOverrides = JSON.parse(await readFile(
    path.resolve(importedProjectRoot, 'modules', 'filter', 'schematic.overrides.json'),
    'utf8',
  ));
  assert.equal(importedFilterOverrides.project_id, importedProject.project_id);
  assert.equal(typeof importedFilterOverrides.items.Cfilter_Cfilter.x, 'number');
  await page.screenshot({ path: path.resolve(outputRoot, 'imported-template-project.png') });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    ok: true,
    projectId,
    systemFit,
    minimumFit,
    screenshots: [
      'output/playwright/module-hub-canvas.png',
      'output/playwright/module-summary-mode.png',
      'output/playwright/module-netlistsvg.png',
      'output/playwright/module-layout-edit.png',
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

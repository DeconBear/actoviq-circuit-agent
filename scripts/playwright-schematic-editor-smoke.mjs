import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { _electron: electron } = await import('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const projectPrefix = 'playwright-schematic-editor-';
const runId = Date.now().toString(36);
const legacyLdoPrefix = `${projectPrefix}legacy-ldo-`;
const legacyBjtResetPrefix = `${projectPrefix}legacy-bjt-reset-`;
const legacyVoltageDividerPrefix = `${projectPrefix}legacy-divider-`;
const legacyMosAmplifierPrefix = `${projectPrefix}legacy-mos-amp-`;
const legacyCmosInverterPrefix = `${projectPrefix}legacy-cmos-inverter-`;
const legacyDifferentialPairPrefix = `${projectPrefix}legacy-diff-pair-`;
const vitePort = Number(process.env.ACTOVIQ_E2E_VITE_PORT ?? (await allocatePort()));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const skillScript = path.resolve(root, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py');
const schematicGrid = 20;

function runSkill(args) {
  return JSON.parse(execFileSync('python', [skillScript, ...args], {
    cwd: root,
    encoding: 'utf8',
  }));
}

function legacyProjectId(kind) {
  return `${projectPrefix}${kind}-${runId}`;
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
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
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
    if (exited) throw new Error(`Vite exited early: ${JSON.stringify(exited)}`);
    if (await canFetch(viteUrl)) {
      await warmUpVite();
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`Timed out waiting for Vite at ${viteUrl}`);
}

async function removePrefixedProjects() {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(projectPrefix)) continue;
    const target = path.resolve(projectsRoot, entry.name);
    assert.equal(path.dirname(target), projectsRoot);
    await rm(target, { recursive: true, force: true });
  }
}

async function createLegacyLdoProject() {
  const expectedProjectId = legacyProjectId('ldo');
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyLdoPrefix}${Date.now()}`,
    '--project-id', expectedProjectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  assert.equal(project.project_id, expectedProjectId, 'legacy LDO fixture project id should not be truncated or reused');
  const modulePorts = [
    { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
    { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'ldo',
    name: 'PMOS-pass LDO',
    kind: 'regulator',
    function: 'Legacy notebook-only LDO used to verify SPICE-to-editable hydration.',
    parameters: { Vin: '5.0 V', Vout: '3.3 V' },
    notes: '',
    preview_enabled: true,
    source: 'modules/ldo/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 360, height: 260 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'ldo',
    name: 'PMOS-pass LDO',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'ldo');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# PMOS-pass LDO',
    '',
    '```spice',
    '* Legacy notebook-only LDO fixture',
    '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
    '.model PMOS1 PMOS (LEVEL=1 VTO=-0.7 KP=40u)',
    'Vin vin 0 DC 5',
    'Vref vref 0 DC 1.2',
    'Itail tail 0 DC 20u',
    'M1 n1 fb tail 0 NMOS1 W=20u L=1u',
    'M2 eaout vref tail 0 NMOS1 W=20u L=1u',
    'M3 n1 n1 vin vin PMOS1 W=40u L=1u',
    'M4 eaout n1 vin vin PMOS1 W=40u L=1u',
    'MP vout eaout vin vin PMOS1 W=2000u L=0.5u',
    'Rtop fb vout 210k',
    'Rbot fb 0 120k',
    'Rload vout 0 330',
    'Cout vout 0 1u',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function createLegacyBjtResetProject() {
  const expectedProjectId = legacyProjectId('bjt-reset');
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyBjtResetPrefix}${Date.now()}`,
    '--project-id', expectedProjectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  assert.equal(project.project_id, expectedProjectId, 'legacy BJT reset fixture project id should not be truncated or reused');
  const modulePorts = [
    { id: 'vdd', name: '+3.3V', direction: 'input', signal_type: 'power', net: 'vdd' },
    { id: 'rst', name: 'RST', direction: 'input', signal_type: 'digital', net: 'rst' },
    { id: 'dtr', name: 'DTR', direction: 'input', signal_type: 'digital', net: 'dtr' },
    { id: 'rts', name: 'RTS', direction: 'output', signal_type: 'digital', net: 'rts' },
    { id: 'boot0', name: 'BOOT0', direction: 'output', signal_type: 'digital', net: 'boot0' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'reset',
    name: 'BJT reset handshake',
    kind: 'interface',
    function: 'Two-transistor reset/boot control network used to verify KiCad-like discrete schematic layout.',
    parameters: { Vdd: '3.3 V' },
    notes: '',
    preview_enabled: true,
    source: 'modules/reset/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 420, height: 280 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'reset',
    name: 'BJT reset handshake',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'reset');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# BJT reset handshake',
    '',
    '```spice',
    '* Legacy notebook-only BJT reset/boot fixture',
    '.model S8050 NPN (IS=1e-14 BF=160)',
    '.model D4148 D (IS=2.52n RS=0.568 N=1.906)',
    'Q_BOOT vdd rts_drive boot_node S8050',
    'Q_RST rst_pull dtr_drive rts S8050',
    'D1 rst rst_pull D4148',
    'R50 vdd rst_pull 10k',
    'R51 dtr_drive dtr 1k',
    'R49 rts_drive rts 1k',
    'R52 boot_node boot0 1k',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function createLegacyVoltageDividerProject() {
  const expectedProjectId = legacyProjectId('divider');
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyVoltageDividerPrefix}${Date.now()}`,
    '--project-id', expectedProjectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  assert.equal(project.project_id, expectedProjectId, 'legacy divider fixture project id should not be truncated or reused');
  const modulePorts = [
    { id: 'vdd', name: '+5V', direction: 'input', signal_type: 'power', net: 'vdd' },
    { id: 'output', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'divider',
    name: 'Power-input voltage divider',
    kind: 'bias',
    function: 'Legacy notebook-only voltage divider used to verify power-fed passive schematic layout.',
    parameters: { Vin: '5.0 V', Ratio: '2:1' },
    notes: '',
    preview_enabled: true,
    source: 'modules/divider/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 360, height: 260 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'divider',
    name: 'Power-input voltage divider',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'divider');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# Power-input voltage divider',
    '',
    '```spice',
    '* Legacy notebook-only voltage divider fixture',
    'Rtop vdd vout 10k',
    'Rbot vout 0 20k',
    'Cflt vout 0 100n',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function createLegacyMosAmplifierProject() {
  const expectedProjectId = legacyProjectId('mos-amp');
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyMosAmplifierPrefix}${Date.now()}`,
    '--project-id', expectedProjectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  assert.equal(project.project_id, expectedProjectId, 'legacy MOS amplifier fixture project id should not be truncated or reused');
  const modulePorts = [
    { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
    { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
    { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'mosamp',
    name: 'MOS common-source amplifier',
    kind: 'amplifier',
    function: 'Legacy notebook-only common-source stage used to verify MOS gate/body layout hydration.',
    parameters: { Gain: 'midband', Bias: 'resistive divider' },
    notes: '',
    preview_enabled: true,
    source: 'modules/mosamp/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 420, height: 280 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'mosamp',
    name: 'MOS common-source amplifier',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'mosamp');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# MOS common-source amplifier',
    '',
    '```spice',
    '* Legacy notebook-only MOS common-source amplifier fixture',
    '.model NMOS1 NMOS (LEVEL=1 VTO=1 KP=120u)',
    'Cin in gate 100n',
    'Rg1 vdd gate 1Meg',
    'Rg2 gate 0 220k',
    'M1 drain gate source 0 NMOS1 W=20u L=1u',
    'Rd vdd drain 10k',
    'Rs source 0 1k',
    'Cs source 0 10u',
    'Cout drain out 1u',
    'Rload out 0 100k',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function createLegacyCmosInverterProject() {
  const expectedProjectId = legacyProjectId('cmos-inv');
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyCmosInverterPrefix}${Date.now()}`,
    '--project-id', expectedProjectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  assert.equal(project.project_id, expectedProjectId, 'legacy CMOS inverter fixture project id should not be truncated or reused');
  const modulePorts = [
    { id: 'input', name: 'IN', direction: 'input', signal_type: 'digital', net: 'in' },
    { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
    { id: 'output', name: 'OUT', direction: 'output', signal_type: 'digital', net: 'out' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'inverter',
    name: 'CMOS inverter',
    kind: 'logic',
    function: 'Legacy notebook-only CMOS inverter used to verify complementary MOS layout hydration.',
    parameters: { Vdd: '3.3 V', Load: '10 pF' },
    notes: '',
    preview_enabled: true,
    source: 'modules/inverter/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 420, height: 280 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'inverter',
    name: 'CMOS inverter',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'inverter');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# CMOS inverter',
    '',
    '```spice',
    '* Legacy notebook-only CMOS inverter fixture',
    '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
    '.model PMOS1 PMOS (LEVEL=1 VTO=-0.7 KP=40u)',
    'MP1 out in vdd vdd PMOS1 W=40u L=1u',
    'MN1 out in 0 0 NMOS1 W=20u L=1u',
    'Cload out 0 10p',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function createLegacyDifferentialPairProject() {
  const expectedProjectId = legacyProjectId('diff-pair');
  const created = runSkill([
    'create',
    '--projects-root', projectsRoot,
    '--name', `${legacyDifferentialPairPrefix}${Date.now()}`,
    '--project-id', expectedProjectId,
  ]);
  const projectRoot = created.project_root;
  const project = created.project;
  assert.equal(project.project_id, expectedProjectId, 'legacy differential pair fixture project id should not be truncated or reused');
  const modulePorts = [
    { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
    { id: 'inp', name: 'IN+', direction: 'input', signal_type: 'analog', net: 'inp' },
    { id: 'inn', name: 'IN-', direction: 'input', signal_type: 'analog', net: 'inn' },
    { id: 'outp', name: 'OUT+', direction: 'output', signal_type: 'analog', net: 'outp' },
    { id: 'outn', name: 'OUT-', direction: 'output', signal_type: 'analog', net: 'outn' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ];
  const moduleRef = {
    id: 'diffpair',
    name: 'MOS differential pair',
    kind: 'amplifier',
    function: 'Legacy notebook-only NMOS differential pair used to verify analog pair layout hydration.',
    parameters: { Tail: '100 uA', Load: '10 kohm' },
    notes: '',
    preview_enabled: true,
    source: 'modules/diffpair/module.circuit.json',
    position: { x: 120, y: 120 },
    size: { width: 460, height: 300 },
    ports: modulePorts,
  };
  const module = {
    schema: 'actoviq.module.v1',
    module_id: 'diffpair',
    name: 'MOS differential pair',
    revision: 0,
    ports: modulePorts,
    components: [],
    wires: [],
    annotations: [],
  };
  project.modules = [moduleRef];
  project.updated_at = new Date().toISOString();
  const moduleRoot = path.resolve(projectRoot, 'modules', 'diffpair');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# MOS differential pair',
    '',
    '```spice',
    '* Legacy notebook-only MOS differential pair fixture',
    '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
    'M_INP outp inp tail 0 NMOS1 W=20u L=1u',
    'M_INN outn inn tail 0 NMOS1 W=20u L=1u',
    'RDP vdd outp 10k',
    'RDN vdd outn 10k',
    'Itail tail 0 DC 100u',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return { projectId: project.project_id, projectName: project.name };
}

async function componentPositions(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-component-positions');
  return JSON.parse(raw || '{}');
}

async function componentRotations(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-component-rotations');
  return JSON.parse(raw || '{}');
}

async function componentPinNets(page, componentId) {
  return page.getByTestId('schematic-editor-svg').locator(
    `g[data-component-id="${componentId}"] circle[data-endpoint-kind="pin"]`,
  ).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-net') ?? ''));
}

async function editorViewBox(page) {
  const raw = await page.getByTestId('schematic-editor-svg').getAttribute('viewBox');
  const [minX, minY, width, height] = String(raw || '0 0 1 1').trim().split(/\s+/).map(Number);
  return { minX, minY, width, height };
}

async function editorZoom(page) {
  return Number(await page.getByTestId('schematic-editor').getAttribute('data-zoom'));
}

async function editorViewport(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-viewport');
  return JSON.parse(raw || '{}');
}

async function editorWires(page) {
  const raw = await page.getByTestId('schematic-editor').getAttribute('data-wires');
  return JSON.parse(raw || '[]');
}

async function waitForEditorIdle(page) {
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-busy') === 'false' &&
      node?.getAttribute('data-preview-busy') === 'false';
  });
}

async function focusEditorByClickingCanvas(page) {
  const box = await page.getByTestId('schematic-editor-svg').boundingBox();
  assert.ok(box, 'schematic editor canvas has no bounding box');
  await page.mouse.click(box.x + 12, box.y + 12);
  await page.getByTestId('schematic-editor').focus();
}

async function componentPinWorldPoints(page, componentId) {
  return page.getByTestId('schematic-editor-svg').locator(
    `circle[data-endpoint-kind="pin"][data-component-id="${componentId}"]`,
  ).evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [
    node.getAttribute('data-pin-id') ?? '',
    {
      x: Number(node.getAttribute('cx')),
      y: Number(node.getAttribute('cy')),
    },
  ]).filter(([pinId]) => pinId)));
}

async function assertWireEndpointsMatchComponentPins(page, componentId, label) {
  const [pins, wires] = await Promise.all([
    componentPinWorldPoints(page, componentId),
    editorWires(page),
  ]);
  const endpoints = [];
  for (const wire of wires) {
    const first = wire.points?.[0];
    const last = wire.points?.[wire.points.length - 1];
    if (wire.from?.component_id === componentId && first) {
      endpoints.push({ endpoint: wire.from, point: first, wireId: wire.id, side: 'from' });
    }
    if (wire.to?.component_id === componentId && last) {
      endpoints.push({ endpoint: wire.to, point: last, wireId: wire.id, side: 'to' });
    }
  }
  assert.ok(endpoints.length > 0, `${label}: no connected wire endpoints for ${componentId}`);
  for (const { endpoint, point, wireId, side } of endpoints) {
    const pin = pins[endpoint.pin_id];
    assert.ok(pin, `${label}: missing pin ${endpoint.pin_id} for ${componentId}.${side} on ${wireId}`);
    assert.equal(Number(point.x), Number(pin.x), `${label}: ${wireId}.${side} x is not on ${componentId}.${endpoint.pin_id}`);
    assert.equal(Number(point.y), Number(pin.y), `${label}: ${wireId}.${side} y is not on ${componentId}.${endpoint.pin_id}`);
  }
}

function longestEditableGeneratedWireSegment(wires) {
  let best = null;
  for (const wire of wires.filter((entry) => entry.source === 'net')) {
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (!start || !end) continue;
      const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
      if (length < 60) continue;
      if (!best || length > best.length) {
        best = { wire, segmentIndex: index, start, end, length };
      }
    }
  }
  return best;
}

function worldToScreen(point, viewBox, svgBox) {
  const scale = Math.min(svgBox.width / viewBox.width, svgBox.height / viewBox.height);
  const xOffset = (svgBox.width - viewBox.width * scale) / 2;
  const yOffset = (svgBox.height - viewBox.height * scale) / 2;
  return {
    x: svgBox.x + xOffset + (point.x - viewBox.minX) * scale,
    y: svgBox.y + yOffset + (point.y - viewBox.minY) * scale,
  };
}

async function componentScreenCenter(page, componentId) {
  return componentScreenPoint(page, componentId, { x: 0, y: 0 });
}

async function componentScreenPoint(page, componentId, offset = { x: 0, y: 0 }) {
  const positions = await componentPositions(page);
  const position = positions[componentId];
  if (!position) throw new Error(`Component ${componentId} position is not exposed`);
  const viewBox = await editorViewBox(page);
  const svgBox = await page.getByTestId('schematic-editor-svg').boundingBox();
  assert.ok(svgBox);
  return worldToScreen({ x: position.x + offset.x, y: position.y + offset.y }, viewBox, svgBox);
}

async function selectedComponentFrameScreenPoint(page, componentId, offset = { x: 0, y: 0 }) {
  return page.getByTestId('schematic-editor-svg').locator(
    `g[data-component-id="${componentId}"] [data-testid="schematic-selected-component-frame"]`,
  ).evaluate((node, pointOffset) => {
    if (!(node instanceof SVGGraphicsElement)) {
      throw new Error('selected component frame is not an SVG graphics element');
    }
    const svg = node.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) throw new Error('selected component frame has no SVG screen matrix');
    const box = node.getBBox();
    const point = svg.createSVGPoint();
    point.x = box.x + box.width / 2 + Number(pointOffset.x);
    point.y = box.y + box.height / 2 + Number(pointOffset.y);
    const screenPoint = point.matrixTransform(matrix);
    return { x: screenPoint.x, y: screenPoint.y };
  }, offset);
}

async function selectedComponentFrameEdgeScreenPoint(page, componentId) {
  return page.getByTestId('schematic-editor-svg').locator(
    `g[data-component-id="${componentId}"] [data-testid="schematic-selected-component-frame"]`,
  ).evaluate((node) => {
    if (!(node instanceof SVGGraphicsElement)) {
      throw new Error('selected component frame is not an SVG graphics element');
    }
    const svg = node.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) throw new Error('selected component frame has no SVG screen matrix');
    const box = node.getBBox();
    const point = svg.createSVGPoint();
    point.x = box.x + box.width / 2;
    point.y = box.y;
    const screenPoint = point.matrixTransform(matrix);
    return { x: screenPoint.x, y: screenPoint.y };
  });
}

async function selectedComponentCornerScreenPoint(page, componentId, cornerIndex = 0) {
  return page.getByTestId('schematic-editor-svg').locator(
    `g[data-component-id="${componentId}"] [data-testid="schematic-selected-component-corner"]`,
  ).nth(cornerIndex).evaluate((node) => {
    if (!(node instanceof SVGGraphicsElement)) {
      throw new Error('selected component corner is not an SVG graphics element');
    }
    const svg = node.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) throw new Error('selected component corner has no SVG screen matrix');
    const box = node.getBBox();
    const point = svg.createSVGPoint();
    point.x = box.x + box.width / 2;
    point.y = box.y + box.height / 2;
    const screenPoint = point.matrixTransform(matrix);
    return { x: screenPoint.x, y: screenPoint.y };
  });
}

async function selectComponentForDrag(page, componentId, offsets = [{ x: 0, y: 0 }]) {
  await page.getByTestId('schematic-editor-select').click();
  for (const offset of offsets) {
    const point = await componentScreenPoint(page, componentId, offset);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    const selected = await page.waitForFunction((id) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `component:${id}`
    ), componentId, { timeout: 1200 }).then(() => true).catch(() => false);
    if (selected) return point;
  }
  throw new Error(`Component ${componentId} could not be selected for drag`);
}

function assertPositionEqual(actual, expected, label) {
  assert.deepEqual(
    { x: Number(actual?.x), y: Number(actual?.y) },
    { x: Number(expected?.x), y: Number(expected?.y) },
    label,
  );
}

function assertPositionChanged(actual, expected, label) {
  assert.notDeepEqual(
    { x: Number(actual?.x), y: Number(actual?.y) },
    { x: Number(expected?.x), y: Number(expected?.y) },
    label,
  );
}

async function wireScreenPointAwayFromComponents(page, wireId) {
  return page.getByTestId('schematic-editor-svg').evaluate((svg, id) => {
    if (!(svg instanceof SVGSVGElement)) throw new Error('schematic editor svg is not an SVG element');
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    const wires = JSON.parse(editor?.getAttribute('data-wires') ?? '[]');
    const wire = wires.find((entry) => entry.id === id);
    if (!wire || !Array.isArray(wire.points) || wire.points.length < 2) {
      throw new Error(`wire ${id} points not found`);
    }
    const componentPositions = Object.values(JSON.parse(editor?.getAttribute('data-component-positions') ?? '{}'));
    let best = null;
    for (let index = 1; index < wire.points.length; index += 1) {
      const start = wire.points[index - 1];
      const end = wire.points[index];
      if (!start || !end) continue;
      for (let step = 2; step <= 8; step += 1) {
        const ratio = step / 10;
        const point = {
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio,
        };
        const nearestComponent = componentPositions.reduce((nearest, position) => {
          const dx = point.x - Number(position.x);
          const dy = point.y - Number(position.y);
          return Math.min(nearest, Math.hypot(dx, dy));
        }, Number.POSITIVE_INFINITY);
        if (!best || nearestComponent > best.nearestComponent) {
          best = { point, nearestComponent };
        }
      }
    }
    if (!best) throw new Error(`wire ${id} has no selectable candidate point`);
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error('schematic editor svg has no screen matrix');
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = best.point.x;
    svgPoint.y = best.point.y;
    const screenPoint = svgPoint.matrixTransform(matrix);
    return { x: screenPoint.x, y: screenPoint.y };
  }, wireId);
}

async function wireHandleScreenPoint(page, wireId, pointIndex) {
  return page.getByTestId('schematic-editor-svg').locator(
    `[data-testid="schematic-wire-point-handle"][data-wire-id="${wireId}"][data-point-index="${pointIndex}"]`,
  ).evaluate((node) => {
    if (!(node instanceof SVGCircleElement)) {
      throw new Error('wire handle is not an SVG circle');
    }
    const svg = node.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) throw new Error('wire handle has no SVG screen matrix');
    const point = svg.createSVGPoint();
    point.x = Number(node.getAttribute('cx'));
    point.y = Number(node.getAttribute('cy'));
    const screenPoint = point.matrixTransform(matrix);
    return { x: screenPoint.x, y: screenPoint.y };
  });
}

async function countVisibleSchematicWires(page) {
  return page.getByTestId('schematic-editor-svg').locator('g[data-wire-id] polyline:not([stroke="transparent"])').evaluateAll((nodes) => (
    nodes.filter((node) => {
      if (!(node instanceof SVGGraphicsElement)) return false;
      const box = node.getBBox();
      return box.width > 0 || box.height > 0;
    }).length
  ));
}

async function isWireVisible(page, wireId) {
  return page.getByTestId('schematic-editor-svg').locator(`g[data-wire-id="${wireId}"] polyline:not([stroke="transparent"])`).evaluateAll((nodes) => (
    nodes.some((node) => {
      if (!(node instanceof SVGGraphicsElement)) return false;
      const box = node.getBBox();
      return box.width > 0 || box.height > 0;
    })
  ));
}

async function countVisibleSchematicComponents(page) {
  return page.getByTestId('schematic-editor-svg').locator('g[data-component-id]').evaluateAll((nodes) => (
    nodes.filter((node) => {
      if (!(node instanceof SVGGraphicsElement)) return false;
      const box = node.getBBox();
      return box.width > 0 && box.height > 0;
    }).length
  ));
}

await mkdir(outputRoot, { recursive: true });
await removePrefixedProjects();

const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Schematic Editor ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const projectRoot = created.project_root;
for (const module of created.project.modules) {
  const compiled = runSkill(['compile-module', '--project-root', projectRoot, '--module-id', module.id]);
  assert.equal(compiled.render.ok, true);
}
const legacyLdoProject = await createLegacyLdoProject();
const legacyBjtResetProject = await createLegacyBjtResetProject();
const legacyVoltageDividerProject = await createLegacyVoltageDividerProject();
const legacyMosAmplifierProject = await createLegacyMosAmplifierProject();
const legacyCmosInverterProject = await createLegacyCmosInverterProject();
const legacyDifferentialPairProject = await createLegacyDifferentialPairProject();

const viteProcess = await startViteIfNeeded();
const pageErrors = [];
const e2eUserDataDir = path.resolve(outputRoot, `schematic-editor-user-data-${Date.now()}`);
const e2eHomeDir = path.resolve(outputRoot, `schematic-editor-home-${Date.now()}`);
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
await mkdir(e2eUserDataDir, { recursive: true });
await mkdir(e2eHomeDir, { recursive: true });
const electronApp = await electron.launch({
  args: [`--user-data-dir=${e2eUserDataDir}`, '--no-sandbox', '--disable-gpu-sandbox', '.'],
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
electronApp.process()?.on('exit', (code, signal) => {
  pageErrors.push(`electron-exit: code=${code} signal=${signal ?? ''}`);
});
const observedWindows = new WeakSet();
function observeWindow(windowPage) {
  if (observedWindows.has(windowPage)) return;
  observedWindows.add(windowPage);
  pageErrors.push(`electron-window: ${windowPage.url()}`);
  windowPage.on('domcontentloaded', () => pageErrors.push(`domcontentloaded: ${windowPage.url()}`));
  windowPage.on('load', () => pageErrors.push(`load: ${windowPage.url()}`));
  windowPage.on('crash', () => pageErrors.push(`page-crash: ${windowPage.url()}`));
  windowPage.on('framenavigated', (frame) => {
    if (frame === windowPage.mainFrame()) pageErrors.push(`framenavigated: ${frame.url()}`);
  });
  windowPage.on('close', () => pageErrors.push(`page-close: ${windowPage.url()}`));
  windowPage.on('requestfailed', (request) => {
    pageErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
}
electronApp.on('window', observeWindow);

async function waitForWorkbenchProject(page, targetProjectId) {
  await page.waitForFunction((projectId) => {
    const node = document.querySelector('[data-testid="circuit-workbench"]');
    return node?.getAttribute('data-project-id') === projectId &&
      node?.getAttribute('data-action-project-id') === projectId;
  }, targetProjectId);
}

let page;
let testSucceeded = false;
try {
  page = electronApp.windows()[0] ?? await electronApp.firstWindow({ timeout: 20_000 });
  observeWindow(page);
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.waitForTimeout(1000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  console.log('[e2e] shell loaded');
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  await page.getByTestId('module-preview-filter').waitFor({ timeout: 20_000 });
  console.log('[e2e] project selected');
  assert.equal(await page.getByTestId('module-preview-filter').getAttribute('data-schematic-source'), 'document');
  assert.ok(
    await page.getByTestId('module-preview-document-svg-filter').locator('g[data-wire-id]').count() >= 3,
    'module card preview did not render document wires',
  );

  await page.getByTestId('module-card-filter').dblclick();
  const editor = page.getByTestId('schematic-editor');
  await editor.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-component-count') === '2' &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });
  await page.getByTestId('schematic-editor-svg').waitFor({ timeout: 20_000 });
  assert.equal(await editor.getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('schematic-editor-svg').getAttribute('data-schematic-source'), 'document');
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id][data-connected="false"]').count(),
    0,
    'unconnected module ports should not be visible or influence the editor plot bounds',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="gnd"]').count(),
    0,
    'rail ports with local schematic labels should not render as duplicate floating ports',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('circle[data-endpoint-kind="pin"][data-visible="true"]').count(),
    0,
    'unselected component pins should not render as persistent red endpoint dots',
  );
  assert.ok(
    await page.getByTestId('schematic-editor-svg').locator('text[paint-order="stroke"]').count() >= 6,
    'schematic labels should render with a white halo for wire overlap readability',
  );
  const positionsBeforeSelectAll = await componentPositions(page);
  await focusEditorByClickingCanvas(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter'
  ));
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 2, 'select-all should show all component frames');
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeSelectAll,
    'select-all should not move schematic components',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
  ));
  assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), true, 'Undo should be disabled before the first edit');
  assert.equal(await page.getByTestId('schematic-editor-redo').isDisabled(), true, 'Redo should be disabled before the first edit');
  assert.equal(await page.getByTestId('schematic-editor-delete').isDisabled(), true, 'Delete should be disabled without a selection');
  assert.equal(await page.getByTestId('schematic-editor-save').isDisabled(), true, 'Apply should be disabled when there are no unsaved edits');
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-document-backed.png') });
  console.log('[e2e] filter editor loaded');

  const canvas = page.getByTestId('schematic-editor-svg');
  const box = await canvas.boundingBox();
  assert.ok(box);
  const zoomBefore = await editorZoom(page);
  const viewportBeforeZoom = await editorViewport(page);
  const pageScrollBeforeZoom = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    top: document.scrollingElement?.scrollTop ?? 0,
  }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForFunction((previousZoom) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') > previousZoom
  ), zoomBefore);
  assert.deepEqual(
    await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      top: document.scrollingElement?.scrollTop ?? 0,
    })),
    pageScrollBeforeZoom,
    'mouse wheel zoom should not scroll the application page',
  );
  const viewportAfterZoom = await editorViewport(page);
  assert.ok(
    viewportAfterZoom.maxX - viewportAfterZoom.minX < viewportBeforeZoom.maxX - viewportBeforeZoom.minX,
    'mouse wheel zoom did not shrink the world viewport',
  );
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForFunction((before) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-viewport') ?? '{}';
    const viewport = JSON.parse(raw);
    return Number(viewport.minX) !== Number(before.minX) || Number(viewport.minY) !== Number(before.minY);
  }, viewportAfterZoom);
  await page.getByTestId('schematic-editor-fit').click();
  await page.waitForFunction(() => (
    Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
  ));
  const zoomBeforeKeyboard = await editorZoom(page);
  await editor.focus();
  await page.keyboard.press('Equal');
  await page.waitForFunction((previousZoom) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') > previousZoom
  ), zoomBeforeKeyboard);
  const zoomAfterKeyboardIn = await editorZoom(page);
  await page.keyboard.press('Minus');
  await page.waitForFunction((previousZoom) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') < previousZoom
  ), zoomAfterKeyboardIn);
  await page.keyboard.press('Home');
  await page.waitForFunction(() => (
    Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
  ));
  await page.keyboard.press('Equal');
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') > 1
  ));
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => (
    Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
  ));
  const viewportBeforeSpacePan = await editorViewport(page);
  const positionsBeforeSpacePan = await componentPositions(page);
  await editor.focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-space-pan') === 'true' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
  ));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 - 55, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForFunction((before) => {
    const editorNode = document.querySelector('[data-testid="schematic-editor"]');
    const viewport = JSON.parse(editorNode?.getAttribute('data-viewport') ?? '{}');
    return editorNode?.getAttribute('data-space-pan') === 'false' &&
      (Number(viewport.minX) !== Number(before.minX) || Number(viewport.minY) !== Number(before.minY));
  }, viewportBeforeSpacePan);
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeSpacePan,
    'space-pan should not move any schematic component',
  );
  const viewportAfterSpacePan = await editorViewport(page);
  const gridAfterSpacePan = await page.getByTestId('schematic-grid-background').evaluate((node) => ({
    x: Number(node.getAttribute('x')),
    y: Number(node.getAttribute('y')),
    width: Number(node.getAttribute('width')),
    height: Number(node.getAttribute('height')),
  }));
  assert.ok(
    viewportAfterSpacePan.minX < viewportBeforeSpacePan.minX || viewportAfterSpacePan.minY < viewportBeforeSpacePan.minY ||
      viewportAfterSpacePan.maxX > viewportBeforeSpacePan.maxX || viewportAfterSpacePan.maxY > viewportBeforeSpacePan.maxY,
    'space-pan did not move the schematic viewport beyond the fitted document bounds',
  );
  assert.equal(gridAfterSpacePan.x, viewportAfterSpacePan.minX, 'infinite grid background x should follow the panned viewport');
  assert.equal(gridAfterSpacePan.y, viewportAfterSpacePan.minY, 'infinite grid background y should follow the panned viewport');
  assert.equal(gridAfterSpacePan.width, viewportAfterSpacePan.maxX - viewportAfterSpacePan.minX, 'infinite grid background width should cover the panned viewport');
  assert.equal(gridAfterSpacePan.height, viewportAfterSpacePan.maxY - viewportAfterSpacePan.minY, 'infinite grid background height should cover the panned viewport');
  const viewportBeforeMiddlePan = await editorViewport(page);
  const positionsBeforeMiddlePan = await componentPositions(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 - 45, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForFunction((before) => {
    const viewport = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-viewport') ?? '{}');
    return Number(viewport.minX) !== Number(before.minX) || Number(viewport.minY) !== Number(before.minY);
  }, viewportBeforeMiddlePan);
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeMiddlePan,
    'middle-button pan should not move any schematic component',
  );
  await page.getByTestId('schematic-editor-fit').click();
  await page.waitForFunction(() => (
    Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
  ));
  console.log('[e2e] viewport zoom alt-pan space-pan middle-pan keyboard fit verified');
  const initialWireCount = Number(await editor.getAttribute('data-wire-count'));
  const filterPositionsInitial = await componentPositions(page);
  const filterViewBoxInitial = await editorViewBox(page);
  const cFilterMarqueeStart = worldToScreen(
    { x: filterPositionsInitial.c_filter.x + 10, y: filterPositionsInitial.c_filter.y - 70 },
    filterViewBoxInitial,
    box,
  );
  const cFilterMarqueeEnd = worldToScreen(
    { x: filterPositionsInitial.c_filter.x + 70, y: filterPositionsInitial.c_filter.y + 70 },
    filterViewBoxInitial,
    box,
  );
  await page.getByTestId('schematic-editor-select').click();
  await page.mouse.move(cFilterMarqueeStart.x, cFilterMarqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(cFilterMarqueeEnd.x, cFilterMarqueeEnd.y, { steps: 8 });
  await page.getByTestId('schematic-selection-marquee').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c_filter'
  ));
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 1, 'marquee component selection frame is missing');
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'marquee selection should not move schematic components',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
  ));
  const rFilterScreenPoint = await componentScreenPoint(page, 'r_filter');
  const cFilterScreenPoint = await componentScreenPoint(page, 'c_filter');
  await page.mouse.click(rFilterScreenPoint.x, rFilterScreenPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r_filter'
  ));
  await page.keyboard.down('Shift');
  await page.mouse.click(cFilterScreenPoint.x, cFilterScreenPoint.y);
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
  ));
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 2, 'Shift-click multi-selection should show two component frames');
  await page.keyboard.down('Shift');
  await page.mouse.click(cFilterScreenPoint.x, cFilterScreenPoint.y);
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r_filter' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '1'
  ));
  await page.keyboard.down('Shift');
  await page.mouse.click(cFilterScreenPoint.x, cFilterScreenPoint.y);
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter'
  ));
  await page.mouse.move(cFilterScreenPoint.x, cFilterScreenPoint.y);
  await page.mouse.down();
  await page.mouse.move(cFilterScreenPoint.x + 90, cFilterScreenPoint.y + 30, { steps: 8 });
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c_filter' &&
      Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
  }, filterPositionsInitial);
  await assertWireEndpointsMatchComponentPins(page, 'c_filter', 'dragging Cfilter should keep wire endpoints on moving pins');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
      Number(positions.c_filter?.y) === Number(previous.c_filter.y);
  }, filterPositionsInitial);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
  ));
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'cancelled direct drag from a Shift-click multi-selection should restore schematic components',
  );
  const multiMarqueeStart = {
    x: Math.min(rFilterScreenPoint.x, cFilterScreenPoint.x) - 90,
    y: Math.min(rFilterScreenPoint.y, cFilterScreenPoint.y) - 40,
  };
  const multiMarqueeEnd = {
    x: Math.max(rFilterScreenPoint.x, cFilterScreenPoint.x) + 120,
    y: Math.max(rFilterScreenPoint.y, cFilterScreenPoint.y) + 120,
  };
  await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
  await page.getByTestId('schematic-selection-marquee').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
  ));
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 2, 'marquee multi-selection should show two component frames');
  const cFilterFrameEdgePoint = await selectedComponentFrameEdgeScreenPoint(page, 'c_filter');
  await page.mouse.move(cFilterFrameEdgePoint.x, cFilterFrameEdgePoint.y);
  await page.mouse.down();
  await page.mouse.move(cFilterFrameEdgePoint.x + 70, cFilterFrameEdgePoint.y + 28, { steps: 8 });
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c_filter' &&
      Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
  }, filterPositionsInitial);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
      Number(positions.c_filter?.y) === Number(previous.c_filter.y);
  }, filterPositionsInitial);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'cancelled selection-frame-edge drag should restore schematic components',
  );
  await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
  await page.getByTestId('schematic-selection-marquee').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
  ));
  const cFilterDirectDragPoint = await componentScreenPoint(page, 'c_filter');
  await page.mouse.move(cFilterDirectDragPoint.x, cFilterDirectDragPoint.y);
  await page.mouse.down();
  await page.mouse.move(cFilterDirectDragPoint.x + 90, cFilterDirectDragPoint.y + 30, { steps: 8 });
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c_filter' &&
      Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
  }, filterPositionsInitial);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
      Number(positions.c_filter?.y) === Number(previous.c_filter.y);
  }, filterPositionsInitial);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'cancelled direct drag from a multi-selection should restore schematic components',
  );
  await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
  await page.getByTestId('schematic-selection-marquee').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
  ));
  const cFilterGroupHandlePoint = await selectedComponentCornerScreenPoint(page, 'c_filter', 0);
  await page.mouse.move(cFilterGroupHandlePoint.x, cFilterGroupHandlePoint.y);
  await page.mouse.down();
  await page.mouse.move(cFilterGroupHandlePoint.x + 90, cFilterGroupHandlePoint.y + 30, { steps: 8 });
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
      (Number(positions.r_filter?.x) !== Number(previous.r_filter.x) || Number(positions.r_filter?.y) !== Number(previous.r_filter.y)) &&
      (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
  }, filterPositionsInitial);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
      Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
      Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
      Number(positions.c_filter?.y) === Number(previous.c_filter.y);
  }, filterPositionsInitial);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'cancelled selection-handle group drag should restore schematic components',
  );
  await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
  await page.getByTestId('schematic-selection-marquee').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
  ));
  const filterRotationsBeforeMultiRotate = await componentRotations(page);
  await editor.focus();
  await page.keyboard.press('r');
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
    const rotations = JSON.parse(raw);
    return Number(rotations.r_filter) === (Number(previous.r_filter ?? 0) + 90) % 360 &&
      Number(rotations.c_filter) === (Number(previous.c_filter ?? 0) + 90) % 360;
  }, filterRotationsBeforeMultiRotate);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'rotating multi-selection should not move schematic components',
  );
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
    const rotations = JSON.parse(raw);
    return Number(rotations.r_filter) === Number(previous.r_filter ?? 0) &&
      Number(rotations.c_filter) === Number(previous.c_filter ?? 0);
  }, filterRotationsBeforeMultiRotate);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'undoing multi-selection rotation should restore schematic component positions',
  );
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
  ));
  const generatedSegment = longestEditableGeneratedWireSegment(await editorWires(page));
  assert.ok(generatedSegment, 'initial generated net wire segment was not exposed to the editor');
  const dirtyBeforeGeneratedWire = await editor.getAttribute('data-dirty');
  const generatedSegmentBox = await canvas.boundingBox();
  assert.ok(generatedSegmentBox);
  const generatedSegmentViewBox = await editorViewBox(page);
  const generatedSegmentMidpoint = {
    x: (generatedSegment.start.x + generatedSegment.end.x) / 2,
    y: (generatedSegment.start.y + generatedSegment.end.y) / 2,
  };
  const generatedSegmentScreenPoint = worldToScreen(generatedSegmentMidpoint, generatedSegmentViewBox, generatedSegmentBox);
  await page.mouse.move(generatedSegmentScreenPoint.x, generatedSegmentScreenPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
  ));
  const generatedHorizontal = Math.abs(generatedSegment.end.x - generatedSegment.start.x) >=
    Math.abs(generatedSegment.end.y - generatedSegment.start.y);
  await page.mouse.down();
  await page.mouse.move(
    generatedSegmentScreenPoint.x + (generatedHorizontal ? 0 : 70),
    generatedSegmentScreenPoint.y + (generatedHorizontal ? 70 : 0),
    { steps: 8 },
  );
  await page.waitForFunction((wireId) => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    const wires = JSON.parse(node?.getAttribute('data-wires') ?? '[]');
    return node?.getAttribute('data-dirty') === 'true' &&
      wires.some((wire) => wire.id === wireId && wire.source === 'stored');
  }, generatedSegment.wire.id);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'dragging a generated net wire should not move schematic components',
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((wireId) => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    const wires = JSON.parse(node?.getAttribute('data-wires') ?? '[]');
    return node?.getAttribute('data-selected') === '' &&
      !wires.some((wire) => wire.id === wireId && wire.source === 'stored');
  }, generatedSegment.wire.id);
  assert.equal(await editor.getAttribute('data-dirty'), dirtyBeforeGeneratedWire);
  const filterViewBoxAfterGeneratedWire = await editorViewBox(page);
  const filterBoxAfterGeneratedWire = await canvas.boundingBox();
  assert.ok(filterBoxAfterGeneratedWire);
  const storedWireCountBeforeGeneratedDelete = (await editorWires(page))
    .filter((wire) => wire.source === 'stored')
    .length;
  const generatedDeleteSegment = longestEditableGeneratedWireSegment(await editorWires(page));
  assert.ok(generatedDeleteSegment, 'generated net wire segment was not available for delete');
  const generatedDeletePoint = worldToScreen({
    x: (generatedDeleteSegment.start.x + generatedDeleteSegment.end.x) / 2,
    y: (generatedDeleteSegment.start.y + generatedDeleteSegment.end.y) / 2,
  }, filterViewBoxAfterGeneratedWire, filterBoxAfterGeneratedWire);
  await page.mouse.click(generatedDeletePoint.x, generatedDeletePoint.y);
  await page.waitForFunction((wireId) => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
  ), generatedDeleteSegment.wire.id);
  await editor.focus();
  await page.keyboard.press('Delete');
  await page.waitForFunction((wireId) => {
    const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
    return !wires.some((wire) => wire.id === wireId) &&
      wires.some((wire) => wire.source === 'stored');
  }, generatedDeleteSegment.wire.id);
  assert.deepEqual(
    await componentPositions(page),
    filterPositionsInitial,
    'deleting a generated net wire should not move schematic components',
  );
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction(({ wireId, storedBefore }) => {
    const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
    return wires.some((wire) => wire.id === wireId && wire.source === 'net') &&
      wires.filter((wire) => wire.source === 'stored').length === storedBefore;
  }, { wireId: generatedDeleteSegment.wire.id, storedBefore: storedWireCountBeforeGeneratedDelete });
  const filterViewBoxAfterGeneratedDelete = await editorViewBox(page);
  const filterBoxAfterGeneratedDelete = await canvas.boundingBox();
  assert.ok(filterBoxAfterGeneratedDelete);
  const filterWireSnapPoint = worldToScreen(
    { x: filterPositionsInitial.r_filter.x + 52, y: filterPositionsInitial.r_filter.y },
    filterViewBoxAfterGeneratedDelete,
    filterBoxAfterGeneratedDelete,
  );
  await page.getByTestId('schematic-editor-wire').click();
  await page.mouse.move(filterWireSnapPoint.x, filterWireSnapPoint.y);
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Boolean(node?.getAttribute('data-hover-endpoint')?.includes('Rfilter'));
  });
  assert.equal(await page.getByTestId('schematic-hover-endpoint').count(), 1, 'wire tool did not show endpoint snap feedback');
  await page.getByTestId('schematic-hover-endpoint-label').getByText(/Rfilter/).waitFor();
  assert.match(
    (await page.getByTestId('schematic-hover-endpoint').getAttribute('data-net')) ?? '',
    /out|in/i,
    'wire endpoint snap feedback did not expose the endpoint net',
  );
  await page.mouse.click(filterWireSnapPoint.x, filterWireSnapPoint.y);
  await page.waitForFunction(() => (
    Boolean(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-start'))
  ));
  await page.mouse.click(filterWireSnapPoint.x + 80, filterWireSnapPoint.y, { button: 'right' });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-wire-start') === '' &&
      node?.getAttribute('data-tool') === 'select';
  });
  assert.equal(await page.getByTestId('schematic-wire-preview').count(), 0, 'right-click should cancel the active wire preview');
  await page.getByTestId('schematic-editor-select').click();
  const placePoint = { x: box.x + Math.min(430, box.width * 0.62), y: box.y + Math.min(280, box.height * 0.48) };

  await editor.focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
  ));
  await page.keyboard.press('w');
  assert.equal(await editor.getAttribute('data-tool'), 'wire', 'W hotkey did not activate wire tool');
  await page.keyboard.press('r');
  assert.equal(await editor.getAttribute('data-tool'), 'place', 'R hotkey did not activate placement tool');
  await page.mouse.click(placePoint.x, placePoint.y);
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-component-count') === '3' &&
      node?.getAttribute('data-selected')?.startsWith('component:r');
  });
  assert.equal(
    await page.getByTestId('schematic-selected-component-handles').count(),
    1,
    'selected component should use lightweight selection handles',
  );
  assert.equal(
    await page.locator('g[data-component-id="r1"] circle[data-endpoint-kind="pin"][data-visible="true"]').count(),
    2,
    'selected resistor should reveal only its own pin snap points',
  );
  assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), false, 'Undo should be enabled after placing a component');
  assert.equal(await page.getByTestId('schematic-editor-redo').isDisabled(), true, 'Redo should stay disabled until an undo is available');
  assert.equal(await page.getByTestId('schematic-editor-delete').isDisabled(), false, 'Delete should be enabled for the selected component');
  assert.equal(await page.getByTestId('schematic-editor-save').isDisabled(), false, 'Apply should be enabled after an unsaved component edit');
  await page.getByTestId('schematic-editor-component-name').fill('Rtrim');
  await page.getByTestId('schematic-editor-component-value').fill('2k');
  await page.getByTestId('schematic-editor-component-rotation').selectOption('90');
  await page.waitForFunction(() => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
    const rotations = JSON.parse(raw);
    return Number(rotations.r1) === 90 &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true';
  });
  await page.getByTestId('schematic-editor-component-rotation').selectOption('0');
  await page.waitForFunction(() => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
    const rotations = JSON.parse(raw);
    return Number(rotations.r1 ?? 0) === 0;
  });
  const filterPositionsAfterPlace = await componentPositions(page);
  const r1NetsBeforeDuplicate = await componentPinNets(page, 'r1');
  await editor.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+D' : 'Control+D');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '4' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r2'
  ));
  const filterPositionsAfterDuplicate = await componentPositions(page);
  assert.deepEqual(
    filterPositionsAfterDuplicate.r2,
    {
      x: filterPositionsAfterPlace.r1.x + schematicGrid * 2,
      y: filterPositionsAfterPlace.r1.y + schematicGrid * 2,
    },
    'duplicate component should be offset by two grid steps',
  );
  assert.notDeepEqual(
    await componentPinNets(page, 'r2'),
    r1NetsBeforeDuplicate,
    'duplicated component should receive fresh pin nets instead of shorting to the original',
  );
  assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), false, 'Undo toolbar button should be enabled after duplicate');
  await page.getByTestId('schematic-editor-undo').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
    !document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
  ));
  assert.equal(await page.getByTestId('schematic-editor-redo').isDisabled(), false, 'Redo toolbar button should be enabled after toolbar undo');
  await page.getByTestId('schematic-editor-redo').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '4' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
  ));
  await page.getByTestId('schematic-editor-undo').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
    !document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
  ));
  const r1AfterDuplicateUndo = await componentScreenPoint(page, 'r1');
  await page.mouse.click(r1AfterDuplicateUndo.x, r1AfterDuplicateUndo.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
  ));
  await editor.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(({ previousX, grid }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r1?.x) === Number(previousX) + Number(grid);
  }, { previousX: filterPositionsAfterPlace.r1.x, grid: schematicGrid });
  const filterPositionsAfterNudge = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterNudge.r_filter, filterPositionsAfterPlace.r_filter, 'nudging added resistor moved r_filter');
  assertPositionEqual(filterPositionsAfterNudge.c_filter, filterPositionsAfterPlace.c_filter, 'nudging added resistor moved c_filter');
  assert.deepEqual(
    { x: Number(filterPositionsAfterNudge.r1.x), y: Number(filterPositionsAfterNudge.r1.y) },
    { x: Number(filterPositionsAfterPlace.r1.x) + schematicGrid, y: Number(filterPositionsAfterPlace.r1.y) },
    'ArrowRight did not nudge added resistor by one grid step',
  );
  const filterRotationsAfterNudge = await componentRotations(page);
  await editor.focus();
  await page.keyboard.press('r');
  await page.waitForFunction(({ componentId, previousRotation }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
    const rotations = JSON.parse(raw);
    return Number(rotations[componentId]) === (Number(previousRotation) + 90) % 360;
  }, { componentId: 'r1', previousRotation: filterRotationsAfterNudge.r1 ?? 0 });
  const filterPositionsAfterRotate = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterRotate.r_filter, filterPositionsAfterNudge.r_filter, 'rotating added resistor moved r_filter');
  assertPositionEqual(filterPositionsAfterRotate.c_filter, filterPositionsAfterNudge.c_filter, 'rotating added resistor moved c_filter');
  assertPositionEqual(filterPositionsAfterRotate.r1, filterPositionsAfterNudge.r1, 'rotating added resistor moved its origin');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction(({ componentId, previousRotation }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
    const rotations = JSON.parse(raw);
    return Number(rotations[componentId]) === Number(previousRotation);
  }, { componentId: 'r1', previousRotation: filterRotationsAfterNudge.r1 ?? 0 });
  console.log('[e2e] component placed');

  await page.getByTestId('schematic-editor-select').click();
  const r1PlaceViewBox = await editorViewBox(page);
  const r1PlaceBox = await canvas.boundingBox();
  assert.ok(r1PlaceBox);
  const r1PlacePoint = worldToScreen(filterPositionsAfterNudge.r1, r1PlaceViewBox, r1PlaceBox);
  await page.mouse.move(r1PlacePoint.x, r1PlacePoint.y);
  await page.mouse.down();
  await page.mouse.move(r1PlacePoint.x + 100, r1PlacePoint.y + 60, { steps: 8 });
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r1?.x) !== Number(previous.x) || Number(positions.r1?.y) !== Number(previous.y);
  }, filterPositionsAfterNudge.r1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r1?.x) === Number(previous.x) && Number(positions.r1?.y) === Number(previous.y);
  }, filterPositionsAfterNudge.r1);
  const filterPositionsAfterCancelDrag = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterCancelDrag.r_filter, filterPositionsAfterNudge.r_filter, 'cancelled drag moved r_filter');
  assertPositionEqual(filterPositionsAfterCancelDrag.c_filter, filterPositionsAfterNudge.c_filter, 'cancelled drag moved c_filter');
  assertPositionEqual(filterPositionsAfterCancelDrag.r1, filterPositionsAfterNudge.r1, 'Escape did not cancel the active drag');

  await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
  ));
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 1, 'component selection frame is missing');
  const componentSelectionFrame = page.getByTestId('schematic-selected-component-frame').first();
  assert.equal(await componentSelectionFrame.evaluate((node) => node.tagName.toLowerCase()), 'rect', 'component selection should use a frame rectangle');
  assert.equal(await componentSelectionFrame.getAttribute('data-selection-kind'), 'component');
  assert.equal(await componentSelectionFrame.getAttribute('data-selection-shape'), 'frame');
  assert.equal(await componentSelectionFrame.getAttribute('stroke-dasharray'), '8 6', 'component selection should use a dashed frame');
  const componentSelectionStroke = await componentSelectionFrame.getAttribute('stroke');
  assert.equal(await page.getByTestId('schematic-selected-component-corner').count(), 4, 'component selection should use square corner handles');
  assert.equal(
    await page.getByTestId('schematic-selected-component-corner').first().getAttribute('data-selection-handle-shape'),
    'square',
    'component selection handles should be square',
  );
  const r1FrameDragPoint = await selectedComponentCornerScreenPoint(page, 'r1', 2);
  await page.mouse.move(r1FrameDragPoint.x, r1FrameDragPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
  ));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(r1FrameDragPoint.x + 80, r1FrameDragPoint.y + 40, { steps: 8 });
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r1?.x) !== Number(previous.x) || Number(positions.r1?.y) !== Number(previous.y);
  }, filterPositionsAfterNudge.r1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r1?.x) === Number(previous.x) && Number(positions.r1?.y) === Number(previous.y);
  }, filterPositionsAfterNudge.r1);
  const filterPositionsAfterFrameDragCancel = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterFrameDragCancel.r_filter, filterPositionsAfterNudge.r_filter, 'cancelled frame drag moved r_filter');
  assertPositionEqual(filterPositionsAfterFrameDragCancel.c_filter, filterPositionsAfterNudge.c_filter, 'cancelled frame drag moved c_filter');
  assertPositionEqual(filterPositionsAfterFrameDragCancel.r1, filterPositionsAfterNudge.r1, 'Escape did not cancel selected-frame drag');
  await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
  ));
  await editor.focus();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '2'
  ));
  const filterPositionsAfterDelete = await componentPositions(page);
  assert.equal(filterPositionsAfterDelete.r1, undefined, 'Delete did not remove the selected resistor');
  assertPositionEqual(filterPositionsAfterDelete.r_filter, filterPositionsAfterNudge.r_filter, 'deleting added resistor moved r_filter');
  assertPositionEqual(filterPositionsAfterDelete.c_filter, filterPositionsAfterNudge.c_filter, 'deleting added resistor moved c_filter');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
      Number(positions.r1?.x) === Number(previous.x) &&
      Number(positions.r1?.y) === Number(previous.y);
  }, filterPositionsAfterNudge.r1);
  const filterPositionsAfterDeleteUndo = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterDeleteUndo.r_filter, filterPositionsAfterNudge.r_filter, 'undo delete moved r_filter');
  assertPositionEqual(filterPositionsAfterDeleteUndo.c_filter, filterPositionsAfterNudge.c_filter, 'undo delete moved c_filter');
  assertPositionEqual(filterPositionsAfterDeleteUndo.r1, filterPositionsAfterNudge.r1, 'undo delete did not restore r1');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '2'
  ));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
      Number(positions.r1?.x) === Number(previous.x) &&
      Number(positions.r1?.y) === Number(previous.y);
  }, filterPositionsAfterNudge.r1);
  const filterPositionsAfterRedoUndo = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterRedoUndo.r_filter, filterPositionsAfterNudge.r_filter, 'redo/undo delete moved r_filter');
  assertPositionEqual(filterPositionsAfterRedoUndo.c_filter, filterPositionsAfterNudge.c_filter, 'redo/undo delete moved c_filter');
  assertPositionEqual(filterPositionsAfterRedoUndo.r1, filterPositionsAfterNudge.r1, 'redo/undo delete did not restore r1');
  console.log('[e2e] delete undo redo isolated');

  await page.mouse.move(r1PlacePoint.x, r1PlacePoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
  ));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(r1PlacePoint.x + 60, r1PlacePoint.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') !== 'grabbing'
  ));
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ));
  const filterPositionsAfterDrag = await componentPositions(page);
  assertPositionEqual(filterPositionsAfterDrag.r_filter, filterPositionsAfterNudge.r_filter, 'dragging added resistor moved r_filter');
  assertPositionEqual(filterPositionsAfterDrag.c_filter, filterPositionsAfterNudge.c_filter, 'dragging added resistor moved c_filter');
  assertPositionChanged(filterPositionsAfterDrag.r1, filterPositionsAfterNudge.r1, 'added resistor did not move');
  console.log('[e2e] component drag isolated');

  const viewBoxAfterDrag = await editorViewBox(page);
  const canvasBoxAfterDrag = await canvas.boundingBox();
  assert.ok(canvasBoxAfterDrag);
  const wireStart = worldToScreen(
    { x: filterPositionsAfterDrag.r_filter.x + 52, y: filterPositionsAfterDrag.r_filter.y },
    viewBoxAfterDrag,
    canvasBoxAfterDrag,
  );
  const wireEnd = worldToScreen(
    { x: filterPositionsAfterDrag.r1.x - 52, y: filterPositionsAfterDrag.r1.y },
    viewBoxAfterDrag,
    canvasBoxAfterDrag,
  );
  await page.getByTestId('schematic-editor-wire').click();
  await page.mouse.move(wireStart.x, wireStart.y);
  await page.mouse.down();
  await page.mouse.move(wireEnd.x, wireEnd.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction((count) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') > count
  ), initialWireCount);
  const wiresAfterDraw = await editorWires(page);
  const storedWiresAfterDraw = wiresAfterDraw.filter((wire) => wire.source === 'stored');
  const drawnWire = storedWiresAfterDraw.at(-1);
  assert.ok(drawnWire, 'drawn stored wire was not exposed to the editor');
  assert.ok(Array.isArray(drawnWire.points) && drawnWire.points.length >= 2, 'drawn wire points were not exposed to the editor');
  assert.ok(await isWireVisible(page, drawnWire.id), 'drawn wire is not visibly drawn');
  assert.notEqual(
    await editor.getAttribute('data-wire-start'),
    '',
    'wire tool should keep the last endpoint active for KiCad-like continuous drawing',
  );
  const chainWireCount = Number(await editor.getAttribute('data-wire-count'));
  const chainViewBox = await editorViewBox(page);
  const chainCanvasBox = await canvas.boundingBox();
  assert.ok(chainCanvasBox);
  const chainEnd = worldToScreen(
    { x: filterPositionsAfterDrag.r1.x - 52, y: filterPositionsAfterDrag.r1.y + 80 },
    chainViewBox,
    chainCanvasBox,
  );
  await page.mouse.click(chainEnd.x, chainEnd.y);
  await page.waitForFunction((count) => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') > count
  ), chainWireCount);
  assert.match(
    await editor.getAttribute('data-wire-start') ?? '',
    /^point:/,
    'wire tool should continue from the chained free point',
  );
  const wiresAfterChain = await editorWires(page);
  const chainedWire = wiresAfterChain.filter((wire) => wire.source === 'stored').at(-1);
  assert.ok(chainedWire && chainedWire.id !== drawnWire.id, 'continuous wire drawing did not create a second stored wire');
  assert.ok(await isWireVisible(page, chainedWire.id), 'continuous wire segment is not visibly drawn');
  const positionsBeforeWireDrag = await componentPositions(page);
  const wirePointsBeforeDrag = drawnWire.points;
  const wireDragPoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
  await page.getByTestId('schematic-editor-select').click();
  await page.mouse.move(wireDragPoint.x, wireDragPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
  ));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(wireDragPoint.x + 70, wireDragPoint.y + 55, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(({ wireId, before }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
    return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
  }, { wireId: drawnWire.id, before: wirePointsBeforeDrag });
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeWireDrag,
    'dragging a stored wire segment should not move schematic components',
  );
  assert.equal(await editor.getAttribute('data-selected'), `wire:${drawnWire.id}`, 'dragged wire should stay selected');
  assert.ok(await isWireVisible(page, drawnWire.id), 'dragged wire segment is not visibly drawn');
  console.log('[e2e] stored wire segment drag isolated');
  const wiresAfterSegmentDrag = await editorWires(page);
  const wireAfterSegmentDrag = wiresAfterSegmentDrag.find((wire) => wire.id === drawnWire.id);
  assert.ok(wireAfterSegmentDrag, 'dragged wire disappeared before cancel-drag regression');
  const wireCancelDragPoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
  await page.mouse.move(wireCancelDragPoint.x, wireCancelDragPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
  ));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(wireCancelDragPoint.x - 80, wireCancelDragPoint.y + 50, { steps: 8 });
  await page.waitForFunction(({ wireId, before }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
    return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
  }, { wireId: drawnWire.id, before: wireAfterSegmentDrag.points });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction(({ wireId, before }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
    return wire && JSON.stringify(wire.points) === JSON.stringify(before);
  }, { wireId: drawnWire.id, before: wireAfterSegmentDrag.points });
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeWireDrag,
    'Escape-canceling a stored wire segment drag moved schematic components',
  );
  console.log('[e2e] stored wire segment cancel isolated');
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-wire-visible.png') });
  console.log('[e2e] wire drawn');

  const wireSelectPoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
  await page.getByTestId('schematic-editor-select').click();
  await page.mouse.click(wireSelectPoint.x, wireSelectPoint.y);
  await page.waitForFunction(() => (
    Boolean(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected'))
  ));
  const selectedAfterWireClick = await editor.getAttribute('data-selected');
  if (selectedAfterWireClick !== `wire:${drawnWire.id}`) {
    console.log('[e2e] wire click selected unexpected item', JSON.stringify({
      drawnWireId: drawnWire.id,
      selectedAfterWireClick,
      wireSelectPoint,
      storedWireIds: storedWiresAfterDraw.map((wire) => wire.id),
    }));
  }
  assert.equal(selectedAfterWireClick, `wire:${drawnWire.id}`, 'clicking the drawn wire did not select that stored wire');
  assert.equal(await page.getByTestId('schematic-selected-wire-highlight').count(), 1, 'wire selection highlight is missing');
  const wireSelectionHighlight = page.getByTestId('schematic-selected-wire-highlight').first();
  assert.equal(await wireSelectionHighlight.evaluate((node) => node.tagName.toLowerCase()), 'polyline', 'wire selection should follow the selected route');
  assert.equal(await wireSelectionHighlight.getAttribute('data-selection-kind'), 'wire');
  assert.equal(await wireSelectionHighlight.getAttribute('data-selection-shape'), 'route');
  assert.equal(await wireSelectionHighlight.getAttribute('stroke-width'), '11', 'wire selection should use a broad route highlight');
  assert.equal(await wireSelectionHighlight.getAttribute('stroke-dasharray'), null, 'wire selection should not use the component dashed frame style');
  assert.notEqual(
    await wireSelectionHighlight.getAttribute('stroke'),
    componentSelectionStroke,
    'wire and component selections should use visibly different strokes',
  );
  assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 0, 'wire selection should not show component selection frame');
  assert.equal(await page.getByTestId('schematic-selected-component-corner').count(), 0, 'wire selection should not show component corner handles');
  assert.ok(
    await page.getByTestId('schematic-wire-point-handle').count() >= 4,
    'selected stored wire should expose visible point handles after segment drag',
  );
  assert.equal(
    await page.getByTestId('schematic-wire-point-handle').first().getAttribute('data-selection-handle-shape'),
    'circle',
    'wire selection handles should be circular',
  );
  const positionsBeforeWirePointDrag = await componentPositions(page);
  const wiresBeforePointDrag = await editorWires(page);
  const wireBeforePointDrag = wiresBeforePointDrag.find((wire) => wire.id === drawnWire.id);
  assert.ok(wireBeforePointDrag?.points?.[1], 'dragged stored wire should have an interior point handle');
  const wirePointHandle = await wireHandleScreenPoint(page, drawnWire.id, 1);
  await page.mouse.move(wirePointHandle.x, wirePointHandle.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
  ));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(wirePointHandle.x + 45, wirePointHandle.y - 45, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(({ wireId, before }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
    return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
  }, { wireId: drawnWire.id, before: wireBeforePointDrag.points });
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeWirePointDrag,
    'dragging a wire point handle should not move schematic components',
  );
  assert.equal(await editor.getAttribute('data-selected'), `wire:${drawnWire.id}`, 'wire point drag should keep the wire selected');
  console.log('[e2e] stored wire point handle drag isolated');
  const wiresAfterPointDrag = await editorWires(page);
  const wireAfterPointDrag = wiresAfterPointDrag.find((wire) => wire.id === drawnWire.id);
  assert.ok(wireAfterPointDrag?.points?.[1], 'wire point drag result is missing an interior point handle');
  const wirePointCancelHandle = await wireHandleScreenPoint(page, drawnWire.id, 1);
  await page.mouse.move(wirePointCancelHandle.x, wirePointCancelHandle.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
  ));
  await page.mouse.down();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(wirePointCancelHandle.x - 55, wirePointCancelHandle.y - 35, { steps: 8 });
  await page.waitForFunction(({ wireId, before }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
    return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
  }, { wireId: drawnWire.id, before: wireAfterPointDrag.points });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction(({ wireId, before }) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
    return wire && JSON.stringify(wire.points) === JSON.stringify(before);
  }, { wireId: drawnWire.id, before: wireAfterPointDrag.points });
  assert.deepEqual(
    await componentPositions(page),
    positionsBeforeWirePointDrag,
    'Escape-canceling a wire point handle drag moved schematic components',
  );
  console.log('[e2e] stored wire point cancel isolated');
  const wireDeletePoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
  await page.getByTestId('schematic-editor-select').click();
  await page.mouse.click(wireDeletePoint.x, wireDeletePoint.y);
  await page.waitForFunction((wireId) => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
  ), drawnWire.id);
  await page.keyboard.press('Delete');
  await page.waitForFunction((wireId) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    return !JSON.parse(raw).some((wire) => wire.id === wireId);
  }, drawnWire.id);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction((wireId) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    return JSON.parse(raw).some((wire) => wire.id === wireId);
  }, drawnWire.id);
  assert.ok(await isWireVisible(page, drawnWire.id), 'undo did not restore the deleted visible wire');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
  await page.waitForFunction((wireId) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    return !JSON.parse(raw).some((wire) => wire.id === wireId);
  }, drawnWire.id);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await page.waitForFunction((wireId) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
    return JSON.parse(raw).some((wire) => wire.id === wireId);
  }, drawnWire.id);
  console.log('[e2e] wire delete undo redo isolated');

  assert.equal(await editor.getAttribute('data-dirty'), 'true', 'Ctrl/Cmd+S persistence check requires a dirty schematic');
  await editor.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await page.getByText('Applied netlist and SVG rebuilt', { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return node?.getAttribute('data-dirty') === 'false' &&
      node?.getAttribute('data-component-count') === '3' &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });

  const moduleData = JSON.parse(await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
  assert.equal(moduleData.components.length, 3);
  assert.ok((moduleData.wires ?? []).length >= 3, 'saved schematic document did not persist visible wires');
  assert.ok(moduleData.components.some((component) => component.id === 'r1' && component.type === 'R'));
  const savedR1 = moduleData.components.find((component) => component.id === 'r1');
  assert.equal(savedR1?.name, 'Rtrim');
  assert.equal(savedR1?.value, '2k');
  assert.match(
    await readFile(path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'), 'utf8'),
    /Rfilter_Rtrim\s+out\s+\S+\s+2k/,
  );
  console.log('[e2e] apply persisted');

  await page.getByTestId('schematic-svg-tab').click();
  await page.getByTestId('module-netlistsvg').locator('svg').waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
  assert.equal(await page.getByTestId('module-document-svg').getAttribute('data-schematic-source'), 'document');
  console.log('[e2e] svg tab verified');
  await page.getByTestId('back-to-board').click();
  await page.getByTestId('module-card-filter').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') >= 3
  ));
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-schematic-source'), 'document');
  await page.getByTestId('back-to-board').click();

  await page.getByTestId(`sidebar-project-${legacyLdoProject.projectId}`).click();
  await waitForWorkbenchProject(page, legacyLdoProject.projectId);
  await page.getByTestId('circuit-workbench').getByText(legacyLdoProject.projectName, { exact: true }).waitFor();
  await page.getByTestId('module-card-ldo').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 12 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 5 &&
      Number(node?.getAttribute('data-net-label-count') ?? '0') >= 10;
  });
  const ldoPositions = await componentPositions(page);
  assert.ok(ldoPositions.mp, 'hydrated LDO pass MOSFET is missing from editable schematic');
  assert.ok(await countVisibleSchematicComponents(page) >= 12, 'hydrated LDO components are not visibly drawn');
  assert.ok(await countVisibleSchematicWires(page) >= 5, 'hydrated LDO signal wires are not visibly drawn');
  assert.ok(
    Number(await page.getByTestId('schematic-editor').getAttribute('data-net-label-count')) >= 8,
    'hydrated LDO should render local power and ground labels',
  );
  assert.ok(
    await page.getByTestId('schematic-net-label').count() >= 8,
    'hydrated LDO local rail labels are not visibly drawn',
  );
  assert.ok(
    await page.locator('[data-testid="schematic-net-label"][data-kind="signal"]').count() >= 4,
    'hydrated LDO should render long named internal nets as local signal labels',
  );
  const ldoWires = await editorWires(page);
  assert.equal(ldoWires.some((wire) => wire.net === 'vin' || wire.net === '0'), false, 'LDO rail nets should not be rendered as long generated wires');
  assert.equal(
    ldoWires.some((wire) => ['fb', 'tail', 'eaout', 'vref'].includes(wire.net)),
    false,
    'LDO long named internal nets should be represented by local labels instead of long generated wires',
  );
  assert.ok(
    ldoPositions.mp.x > Math.max(ldoPositions.m1?.x ?? 0, ldoPositions.m2?.x ?? 0, ldoPositions.m3?.x ?? 0, ldoPositions.m4?.x ?? 0),
    'LDO pass MOSFET should be placed to the right of the error amplifier',
  );
  if (ldoPositions.rtop && ldoPositions.rbot) {
    assert.ok(Math.abs(ldoPositions.rtop.x - ldoPositions.rbot.x) <= 40, 'LDO feedback divider should be vertically aligned');
    assert.ok(ldoPositions.rtop.y < ldoPositions.rbot.y, 'LDO top feedback resistor should sit above bottom feedback resistor');
  }
  if (ldoPositions.cout && ldoPositions.rload) {
    assert.ok(ldoPositions.cout.x >= ldoPositions.mp.x, 'LDO output capacitor should be placed on the output side');
    assert.ok(ldoPositions.rload.x >= ldoPositions.mp.x, 'LDO load should be placed on the output side');
  }
  await waitForEditorIdle(page);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-ldo.png') });
  console.log('[e2e] legacy ldo loaded');
  await focusEditorByClickingCanvas(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') ?? '0') >= 12
  ));
  const mpBodyPoint = await componentScreenPoint(page, 'mp');
  await page.mouse.move(mpBodyPoint.x, mpBodyPoint.y);
  await page.mouse.down();
  await page.mouse.move(mpBodyPoint.x - 90, mpBodyPoint.y - 45, { steps: 10 });
  await page.waitForFunction((previous) => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    const raw = node?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    const unchangedIds = ['m1', 'm2', 'm3', 'm4', 'rtop', 'rbot', 'rload', 'cout', 'vin', 'vref', 'itail'];
    return node?.getAttribute('data-selected') === 'component:mp' &&
      (Number(positions.mp?.x) !== Number(previous.mp.x) || Number(positions.mp?.y) !== Number(previous.mp.y)) &&
      unchangedIds.every((id) => (
        Number(positions[id]?.x) === Number(previous[id]?.x) &&
        Number(positions[id]?.y) === Number(previous[id]?.y)
      ));
  }, ldoPositions);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    const raw = node?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return node?.getAttribute('data-selected') === '' &&
      Object.entries(previous).every(([id, point]) => (
        Number(positions[id]?.x) === Number(point.x) &&
        Number(positions[id]?.y) === Number(point.y)
      ));
  }, ldoPositions);
  assert.deepEqual(
    await componentPositions(page),
    ldoPositions,
    'cancelled direct body drag from a full LDO selection should restore schematic components',
  );
  console.log('[e2e] legacy ldo direct body drag isolated');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-busy') === 'false' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
  ));
  await page.getByTestId('schematic-editor-rebuild-svg').click();
  await page.waitForFunction(() => {
    const editorNode = document.querySelector('[data-testid="schematic-editor"]');
    const text = document.body.textContent ?? '';
    return editorNode?.getAttribute('data-preview-busy') === 'true' || text.includes('Module SVG updated');
  });
  assert.equal(
    await page.getByTestId('schematic-editor').getAttribute('data-busy'),
    'false',
    'background netlistsvg build should not lock the editable schematic',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-select').isEnabled(),
    true,
    'select tool should remain available while background netlistsvg build runs',
  );
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
  ));
  await selectComponentForDrag(page, 'mp', [
    { x: 0, y: 0 },
    { x: -20, y: 0 },
    { x: 12, y: 0 },
    { x: 24, y: -24 },
  ]);
  const mpPoint = await selectedComponentFrameScreenPoint(page, 'mp');
  await page.mouse.move(mpPoint.x, mpPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
  ));
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-busy') === 'false'
  ));
  await page.mouse.down();
  await page.mouse.move(mpPoint.x - 30, mpPoint.y - 20, { steps: 4 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(mpPoint.x - 130, mpPoint.y - 70, { steps: 14 });
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ));
  const ldoPositionsAfterMpDrag = await componentPositions(page);
  assertPositionChanged(ldoPositionsAfterMpDrag.mp, ldoPositions.mp, 'dragging MP did not move MP');
  for (const id of ['m1', 'm2', 'm3', 'm4', 'rtop', 'rbot', 'rload', 'cout', 'vin', 'vref', 'itail']) {
    assertPositionEqual(ldoPositionsAfterMpDrag[id], ldoPositions[id], `dragging MP moved ${id}`);
  }
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-ldo-drag.png') });
  console.log('[e2e] legacy ldo drag isolated');

  await page.getByTestId(`sidebar-project-${legacyBjtResetProject.projectId}`).click();
  await waitForWorkbenchProject(page, legacyBjtResetProject.projectId);
  await page.getByTestId('circuit-workbench').getByText(legacyBjtResetProject.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await page.getByTestId('module-card-reset').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 7 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 4;
  });
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="rst"]').getAttribute('data-port-side'),
    'left',
    'BJT reset RST input should render on the left edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="dtr"]').getAttribute('data-port-side'),
    'right',
    'BJT reset DTR input should render outside R51 on the right edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="rts"]').getAttribute('data-port-side'),
    'right',
    'BJT reset RTS output should render on the right edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="boot0"]').getAttribute('data-port-side'),
    'right',
    'BJT reset BOOT0 output should render outside R52',
  );
  const bjtResetPositions = await componentPositions(page);
  for (const id of ['q_boot', 'q_rst', 'd1', 'r50', 'r51', 'r49', 'r52']) {
    assert.ok(bjtResetPositions[id], `hydrated BJT reset component ${id} is missing from editable schematic`);
  }
  assert.ok(await countVisibleSchematicComponents(page) >= 7, 'hydrated BJT reset components are not visibly drawn');
  assert.ok(await countVisibleSchematicWires(page) >= 4, 'hydrated BJT reset signal wires are not visibly drawn');
  assert.ok(bjtResetPositions.q_boot.x < bjtResetPositions.q_rst.x, 'BJT reset boot transistor should be left of reset transistor in GUI');
  assert.ok(bjtResetPositions.d1.x < bjtResetPositions.q_rst.x, 'BJT reset diode should feed reset transistor from the left in GUI');
  assert.ok(bjtResetPositions.r50.y < bjtResetPositions.q_rst.y, 'BJT reset pull-up should sit above reset transistor in GUI');
  assert.ok(bjtResetPositions.r51.x > bjtResetPositions.q_rst.x, 'BJT reset DTR resistor should sit on the output side in GUI');
  assert.ok(
    bjtResetPositions.r49.x > bjtResetPositions.q_boot.x && bjtResetPositions.r49.x < bjtResetPositions.q_rst.x,
    'BJT reset RTS resistor should bridge the two transistor stages in GUI',
  );
  assert.ok(bjtResetPositions.r52.y > bjtResetPositions.q_boot.y, 'BJT reset BOOT resistor should sit below boot transistor in GUI');
  await waitForEditorIdle(page);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-bjt-reset.png') });
  console.log('[e2e] legacy bjt reset loaded');

  await page.getByTestId(`sidebar-project-${legacyVoltageDividerProject.projectId}`).click();
  await waitForWorkbenchProject(page, legacyVoltageDividerProject.projectId);
  await page.getByTestId('circuit-workbench').getByText(legacyVoltageDividerProject.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await page.getByTestId('module-card-divider').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 3 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });
  const dividerPositions = await componentPositions(page);
  for (const id of ['rtop', 'rbot', 'cflt']) {
    assert.ok(dividerPositions[id], `hydrated voltage divider component ${id} is missing from editable schematic`);
  }
  assert.ok(await countVisibleSchematicComponents(page) >= 3, 'hydrated voltage divider components are not visibly drawn');
  assert.ok(await countVisibleSchematicWires(page) >= 3, 'hydrated voltage divider wires are not visibly drawn');
  assert.ok(
    Math.abs(dividerPositions.rtop.x - dividerPositions.rbot.x) <= schematicGrid,
    'voltage divider resistors should align vertically in GUI',
  );
  assert.ok(dividerPositions.rtop.y < dividerPositions.rbot.y, 'voltage divider top resistor should sit above bottom resistor in GUI');
  assert.ok(dividerPositions.cflt.x > dividerPositions.rbot.x, 'voltage divider shunt capacitor should sit beside the divider in GUI');
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
    'right',
    'voltage divider output should render on the right edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="gnd"]').count(),
    0,
    'voltage divider ground rail should render as a local label instead of a duplicate floating port',
  );
  await waitForEditorIdle(page);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-voltage-divider.png') });
  console.log('[e2e] legacy voltage divider loaded');

  await page.getByTestId(`sidebar-project-${legacyMosAmplifierProject.projectId}`).click();
  await waitForWorkbenchProject(page, legacyMosAmplifierProject.projectId);
  await page.getByTestId('circuit-workbench').getByText(legacyMosAmplifierProject.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await page.getByTestId('module-card-mosamp').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 9 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 7;
  });
  const mosAmpPositions = await componentPositions(page);
  for (const id of ['cin', 'rg1', 'rg2', 'm1', 'rd', 'rs', 'cs', 'cout', 'rload']) {
    assert.ok(mosAmpPositions[id], `hydrated MOS amplifier component ${id} is missing from editable schematic`);
  }
  assert.ok(await countVisibleSchematicComponents(page) >= 9, 'hydrated MOS amplifier components are not visibly drawn');
  assert.ok(await countVisibleSchematicWires(page) >= 7, 'hydrated MOS amplifier wires are not visibly drawn');
  assert.ok(mosAmpPositions.cin.x < mosAmpPositions.m1.x, 'MOS amplifier input capacitor should sit left of M1 in GUI');
  assert.ok(mosAmpPositions.rg1.y < mosAmpPositions.m1.y, 'MOS amplifier gate pull-up should sit above M1 in GUI');
  assert.ok(mosAmpPositions.rg2.y > mosAmpPositions.m1.y, 'MOS amplifier gate pull-down should sit below M1 in GUI');
  assert.ok(mosAmpPositions.rd.y < mosAmpPositions.m1.y, 'MOS amplifier drain load should sit above M1 in GUI');
  assert.ok(mosAmpPositions.rs.y > mosAmpPositions.m1.y, 'MOS amplifier source resistor should sit below M1 in GUI');
  assert.ok(mosAmpPositions.cs.y > mosAmpPositions.m1.y, 'MOS amplifier source bypass should sit below M1 in GUI');
  assert.ok(mosAmpPositions.cout.x > mosAmpPositions.m1.x, 'MOS amplifier output capacitor should sit right of M1 in GUI');
  assert.ok(mosAmpPositions.rload.x > mosAmpPositions.cout.x, 'MOS amplifier output load should sit beyond the output capacitor in GUI');
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="input"]').getAttribute('data-port-side'),
    'left',
    'MOS amplifier input should render on the left edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
    'right',
    'MOS amplifier output should render on the right edge',
  );
  await waitForEditorIdle(page);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-mos-amplifier.png') });
  console.log('[e2e] legacy mos amplifier loaded');
  await focusEditorByClickingCanvas(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') ?? '0') >= 9
  ));
  await selectComponentForDrag(page, 'm1', [
    { x: 0, y: 0 },
    { x: -18, y: 0 },
    { x: 12, y: 18 },
    { x: 26, y: -18 },
  ]);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:m1' &&
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '1'
  ));
  const mosAmpM1DragPoint = await selectedComponentFrameScreenPoint(page, 'm1');
  await page.mouse.move(mosAmpM1DragPoint.x, mosAmpM1DragPoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
  ));
  await page.mouse.down();
  await page.mouse.move(mosAmpM1DragPoint.x + 30, mosAmpM1DragPoint.y - 20, { steps: 4 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
  ));
  await page.mouse.move(mosAmpM1DragPoint.x + 110, mosAmpM1DragPoint.y - 40, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
  ));
  const mosAmpPositionsAfterM1Drag = await componentPositions(page);
  assertPositionChanged(mosAmpPositionsAfterM1Drag.m1, mosAmpPositions.m1, 'dragging MOS amplifier M1 did not move M1');
  for (const id of ['cin', 'rg1', 'rg2', 'rd', 'rs', 'cs', 'cout', 'rload']) {
    assertPositionEqual(mosAmpPositionsAfterM1Drag[id], mosAmpPositions[id], `dragging MOS amplifier M1 moved ${id}`);
  }
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-mos-amplifier-drag.png') });
  console.log('[e2e] legacy mos amplifier drag isolated');

  await page.getByTestId(`sidebar-project-${legacyCmosInverterProject.projectId}`).click();
  await waitForWorkbenchProject(page, legacyCmosInverterProject.projectId);
  await page.getByTestId('circuit-workbench').getByText(legacyCmosInverterProject.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await page.getByTestId('module-card-inverter').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 3 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
  ));
  const cmosInverterPositions = await componentPositions(page);
  for (const id of ['mp1', 'mn1', 'cload']) {
    assert.ok(cmosInverterPositions[id], `hydrated CMOS inverter component ${id} is missing from editable schematic`);
  }
  assert.ok(await countVisibleSchematicComponents(page) >= 3, 'hydrated CMOS inverter components are not visibly drawn');
  assert.ok(await countVisibleSchematicWires(page) >= 3, 'hydrated CMOS inverter wires are not visibly drawn');
  assert.ok(cmosInverterPositions.mp1.y < cmosInverterPositions.mn1.y, 'CMOS inverter PMOS should sit above NMOS in GUI');
  assert.ok(
    Math.abs(cmosInverterPositions.mp1.x - cmosInverterPositions.mn1.x) <= schematicGrid,
    'CMOS inverter devices should share the output column in GUI',
  );
  assert.ok(cmosInverterPositions.cload.x > cmosInverterPositions.mn1.x, 'CMOS inverter load should sit on the output side in GUI');
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="input"]').getAttribute('data-port-side'),
    'left',
    'CMOS inverter input should render on the left edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
    'right',
    'CMOS inverter output should render on the right edge',
  );
  await waitForEditorIdle(page);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cmos-inverter.png') });
  console.log('[e2e] legacy cmos inverter loaded');

  await page.getByTestId(`sidebar-project-${legacyDifferentialPairProject.projectId}`).click();
  await waitForWorkbenchProject(page, legacyDifferentialPairProject.projectId);
  await page.getByTestId('circuit-workbench').getByText(legacyDifferentialPairProject.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await page.getByTestId('module-card-diffpair').dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="schematic-editor"]');
    return Number(node?.getAttribute('data-component-count') ?? '0') >= 5 &&
      Number(node?.getAttribute('data-wire-count') ?? '0') >= 5;
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
  ));
  const diffPairPositions = await componentPositions(page);
  for (const id of ['m_inp', 'm_inn', 'rdp', 'rdn', 'itail']) {
    assert.ok(diffPairPositions[id], `hydrated differential pair component ${id} is missing from editable schematic`);
  }
  assert.ok(await countVisibleSchematicComponents(page) >= 5, 'hydrated differential pair components are not visibly drawn');
  assert.ok(await countVisibleSchematicWires(page) >= 5, 'hydrated differential pair wires are not visibly drawn');
  assert.ok(diffPairPositions.m_inp.x < diffPairPositions.m_inn.x, 'differential pair IN+ device should sit left of IN- device in GUI');
  assert.ok(
    Math.abs(diffPairPositions.m_inp.y - diffPairPositions.m_inn.y) <= schematicGrid,
    'differential pair input devices should align horizontally in GUI',
  );
  assert.ok(diffPairPositions.rdp.y < diffPairPositions.m_inp.y, 'differential pair left load should sit above M_INP in GUI');
  assert.ok(diffPairPositions.rdn.y < diffPairPositions.m_inn.y, 'differential pair right load should sit above M_INN in GUI');
  assert.ok(diffPairPositions.itail.y > diffPairPositions.m_inp.y, 'differential pair tail current source should sit below the pair in GUI');
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="outp"]').getAttribute('data-port-side'),
    'right',
    'differential pair OUT+ should render on the right edge',
  );
  assert.equal(
    await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="outn"]').getAttribute('data-port-side'),
    'right',
    'differential pair OUT- should render on the right edge',
  );
  const differentialOutputPorts = await page.getByTestId('schematic-editor-svg').evaluate(() => {
    const outp = document.querySelector('g[data-port-id="outp"]');
    const outn = document.querySelector('g[data-port-id="outn"]');
    if (!(outp instanceof SVGGraphicsElement) || !(outn instanceof SVGGraphicsElement)) {
      throw new Error('differential pair output port SVG groups are missing');
    }
    const outpBox = outp.getBBox();
    const outnBox = outn.getBBox();
    return {
      minX: Math.min(outpBox.x, outnBox.x),
      centerGapY: Math.abs((outpBox.y + outpBox.height / 2) - (outnBox.y + outnBox.height / 2)),
    };
  });
  assert.ok(
    differentialOutputPorts.minX > diffPairPositions.m_inn.x + 52,
    'differential pair output ports should render outside the right device, not between the input pair',
  );
  assert.ok(
    differentialOutputPorts.centerGapY >= schematicGrid * 2,
    'differential pair output ports should be visibly separated on the right edge',
  );
  await waitForEditorIdle(page);
  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-differential-pair.png') });
  console.log('[e2e] legacy differential pair loaded');

  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await waitForWorkbenchProject(page, projectId);
  await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }

  await page.getByTestId('module-card-power').dblclick();
  await editor.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'power'
  ));
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
  ));
  const powerCanvas = page.getByTestId('schematic-editor-svg');
  const powerBox = await powerCanvas.boundingBox();
  assert.ok(powerBox);
  const powerPlacePoint = worldToScreen({ x: 520, y: 320 }, await editorViewBox(page), powerBox);
  await page.getByTestId('schematic-editor-place-R').click();
  await page.mouse.click(powerPlacePoint.x, powerPlacePoint.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3'
  ));
  const powerPositionsAfterPlace = await componentPositions(page);
  await selectComponentForDrag(page, 'r1', [{ x: 0, y: -10 }, { x: 0, y: 0 }, { x: 10, y: 0 }]);
  const powerR1PlacePoint = await selectedComponentFrameScreenPoint(page, 'r1');
  await page.mouse.move(powerR1PlacePoint.x, powerR1PlacePoint.y);
  await page.mouse.down();
  await page.mouse.move(powerR1PlacePoint.x + 70, powerR1PlacePoint.y + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
    const positions = JSON.parse(raw);
    return Number(positions.r1?.x) !== Number(previous.r1.x) ||
      Number(positions.r1?.y) !== Number(previous.r1.y);
  }, powerPositionsAfterPlace);
  const powerPositionsAfterDrag = await componentPositions(page);
  assertPositionEqual(powerPositionsAfterDrag.v_signal, powerPositionsAfterPlace.v_signal, 'dragging resistor moved Vsignal');
  assertPositionEqual(powerPositionsAfterDrag.v_supply, powerPositionsAfterPlace.v_supply, 'dragging resistor moved VDD source');
  assertPositionChanged(powerPositionsAfterDrag.r1, powerPositionsAfterPlace.r1, 'power-module resistor did not move');
  console.log('[e2e] power module drag isolated');

  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-smoke.png') });
  assert.deepEqual(
    pageErrors.filter((entry) => /^(pageerror|console:|requestfailed|page-crash)/.test(entry)),
    [],
  );
  console.log(JSON.stringify({
    ok: true,
    projectId,
    moduleComponentCount: moduleData.components.length,
    moduleWireCount: moduleData.wires.length,
    screenshot: 'output/playwright/schematic-editor-smoke.png',
    wireScreenshot: 'output/playwright/schematic-editor-wire-visible.png',
  }, null, 2));
  testSucceeded = true;
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-failure.png') }).catch(() => {});
    console.error(JSON.stringify({
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500),
      pageErrors,
    }, null, 2));
  }
  throw error;
} finally {
  await electronApp.close();
  if (testSucceeded) await removePrefixedProjects();
  if (viteProcess) viteProcess.kill();
}

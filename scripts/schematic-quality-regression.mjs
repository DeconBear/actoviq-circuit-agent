import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'schematic-quality');
const skillScriptsRoot = path.resolve(root, 'skills', 'circuit-design-ngspice', 'scripts');
const netlistToJsonPath = path.resolve(skillScriptsRoot, 'netlist_to_json.py');
const renderPath = path.resolve(skillScriptsRoot, 'render_netlistsvg.py');
const netlistsvgBin = path.resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'netlistsvg.cmd' : 'netlistsvg',
);
const python = process.env.PYTHON_BIN?.trim() || 'python';

const fixtures = [
  {
    id: 'rc-low-pass',
    inputNode: 'in',
    outputNode: 'out',
    netlist: [
      '* RC low-pass fixture',
      'Vin in 0 AC 1',
      'R1 in out 10k',
      'C1 out 0 10n',
      'Rload out 0 100k',
      '.end',
    ],
    overrides: {
      R1: { x: 150, y: 190 },
      C1: { x: 330, y: 265 },
      Rload: { x: 470, y: 265 },
    },
  },
  {
    id: 'rlc-band-pass',
    inputNode: 'n1',
    outputNode: 'out',
    netlist: [
      '* RLC band-pass fixture',
      'Vin in 0 AC 1',
      'Rsrc in n1 50',
      'C1 n1 n2 100n',
      'L1 n2 out 10u',
      'Rload out 0 50',
      '.end',
    ],
    overrides: {
      C1: { x: 270, y: 190 },
      L1: { x: 410, y: 190 },
      Rload: { x: 550, y: 265 },
      OUT: { x: 660, y: 190 },
    },
  },
  {
    id: 'diode-rectifier',
    inputNode: 'ac',
    outputNode: 'rect',
    netlist: [
      '* Half-wave rectifier fixture',
      '.model DGEN D(IS=1n RS=0.5)',
      'V1 ac 0 SIN(0 1 1k)',
      'D1 ac rect DGEN',
      'C1 rect 0 10u',
      'Rload rect 0 1k',
      '.end',
    ],
    overrides: {
      D1: { x: 190, y: 190 },
      C1: { x: 350, y: 265 },
      Rload: { x: 500, y: 265 },
    },
  },
  {
    id: 'bjt-common-emitter',
    inputNode: 'in',
    outputNode: 'load',
    netlist: [
      '* BJT common-emitter amplifier fixture',
      '.model QNPN NPN(IS=1e-15 BF=120)',
      'VCC vcc 0 DC 12',
      'Vin in 0 AC 1',
      'CIN in b 100n',
      'R1 vcc b 47k',
      'R2 b 0 10k',
      'Q1 out b e QNPN',
      'RC vcc out 4.7k',
      'RE e 0 1k',
      'CE e 0 10u',
      'COUT out load 1u',
      'RLOAD load 0 10k',
      '.end',
    ],
    overrides: {
      CIN: { x: 110, y: 210 },
      Q1: { x: 285, y: 190 },
      RC: { x: 295, y: 70 },
      RE: { x: 295, y: 315 },
      COUT: { x: 445, y: 210 },
      RLOAD: { x: 585, y: 265 },
    },
  },
  {
    id: 'mos-common-source',
    inputNode: 'in',
    outputNode: 'load',
    netlist: [
      '* MOS common-source amplifier fixture',
      '.model NM1 NMOS(LEVEL=1 VTO=0.8 KP=120u)',
      'VDD vdd 0 DC 5',
      'Vin in 0 AC 1',
      'Rgate in gate 1k',
      'M1 out gate source 0 NM1 W=20u L=1u',
      'RD vdd out 2k',
      'RS source 0 200',
      'COUT out load 1u',
      'RLOAD load 0 10k',
      '.end',
    ],
    overrides: {
      Rgate: { x: 115, y: 210 },
      M1: { x: 285, y: 190 },
      RD: { x: 300, y: 70 },
      RS: { x: 300, y: 315 },
      COUT: { x: 445, y: 210 },
      RLOAD: { x: 585, y: 265 },
    },
  },
  {
    id: 'mos-ldo',
    inputNode: 'vin',
    outputNode: 'vout',
    netlist: [
      '* MOSFET LDO fixture',
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
    ],
    overrides: {
      MP: { x: 500, y: 128 },
      Rtop: { x: 620, y: 220 },
      Rbot: { x: 620, y: 304 },
      Cout: { x: 730, y: 304 },
      Rload: { x: 800, y: 304 },
    },
  },
];

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout.trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  let parsed = null;
  try {
    parsed = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    parsed = null;
  }
  if (result.status !== 0 || !parsed) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
      result.stderr.trim(),
      stdout,
    ].filter(Boolean).join('\n'));
  }
  return parsed;
}

function overrideDocument(fixture) {
  return {
    schema: 'actoviq.schematic-overrides.v1',
    project_id: 'schematic-quality-regression',
    module_id: fixture.id,
    items: Object.fromEntries(
      Object.entries(fixture.overrides).map(([id, position]) => [
        id,
        { ...position, locked: true, updated_at: '2026-06-23T00:00:00.000Z' },
      ]),
    ),
  };
}

function hardGeometryOk(summary) {
  return summary.missing_pin_connections === 0
    && summary.wire_crossings === 0
    && summary.component_overlaps === 0
    && summary.wire_body_intrusions === 0;
}

await mkdir(path.dirname(outputRoot), { recursive: true });
assert.equal(path.dirname(outputRoot), path.resolve(root, 'output'));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const results = [];
for (const fixture of fixtures) {
  const fixtureRoot = path.resolve(outputRoot, fixture.id);
  await mkdir(fixtureRoot, { recursive: true });
  const netlistPath = path.resolve(fixtureRoot, 'design.cir');
  const jsonPath = path.resolve(fixtureRoot, 'design.json');
  const svgPath = path.resolve(fixtureRoot, 'schematic.svg');
  const overridesPath = path.resolve(fixtureRoot, 'schematic.overrides.json');

  await writeFile(netlistPath, `${fixture.netlist.join('\n')}\n`, 'utf8');
  await writeFile(overridesPath, `${JSON.stringify(overrideDocument(fixture), null, 2)}\n`, 'utf8');

  const converted = runJson(python, [
    netlistToJsonPath,
    '--netlist-path', netlistPath,
    '--json-path', jsonPath,
    '--view', 'schematic',
    '--input-node', fixture.inputNode,
    '--output-node', fixture.outputNode,
  ]);
  assert.equal(converted.ok, true, fixture.id);

  const rendered = runJson(python, [
    renderPath,
    '--json-path', jsonPath,
    '--svg-path', svgPath,
    '--netlistsvg-bin', netlistsvgBin,
    '--skin-profile', 'analog',
    '--overrides-path', overridesPath,
    '--timeout-sec', '45',
  ]);
  assert.equal(rendered.ok, true, fixture.id);

  const geometryPath = svgPath.replace(/\.svg$/, '.geometry.json');
  const layoutPath = svgPath.replace(/\.svg$/, '.layout.json');
  const geometry = JSON.parse(await readFile(geometryPath, 'utf8'));
  const moved = rendered.formatted_layout?.schematic_overrides?.moved ?? [];
  const skipped = rendered.formatted_layout?.schematic_overrides?.skipped ?? [];
  const missingMoves = Object.keys(fixture.overrides).filter((id) => !moved.includes(id));
  const summary = geometry.summary ?? {};

  assert.deepEqual(skipped, [], `${fixture.id} skipped schematic overrides`);
  assert.deepEqual(missingMoves, [], `${fixture.id} missing schematic override moves`);
  assert.equal(geometry.ok, true, `${fixture.id} geometry failed: ${JSON.stringify(summary)}`);
  assert.equal(hardGeometryOk(summary), true, `${fixture.id} hard geometry issues: ${JSON.stringify(summary)}`);
  assert.ok((rendered.layout_report?.readability_score ?? 0) >= 85, `${fixture.id} readability below 85`);
  assert.deepEqual(geometry.readability?.issues ?? [], [], `${fixture.id} readability issues: ${JSON.stringify(geometry.readability?.issues ?? [])}`);

  results.push({
    id: fixture.id,
    profile: rendered.planner?.profile ?? rendered.formatted_layout?.profile ?? 'unknown',
    svgPath,
    jsonPath,
    geometryPath,
    layoutPath,
    overrideMoves: moved,
    geometry: summary,
    readabilityScore: rendered.layout_report?.readability_score ?? null,
  });
}

const summaryPath = path.resolve(outputRoot, 'summary.json');
await writeFile(
  summaryPath,
  `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    fixtureCount: results.length,
    outputRoot,
    results,
  }, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify({
  ok: true,
  fixtureCount: results.length,
  outputRoot,
  summaryPath,
  fixtures: results.map((result) => ({
    id: result.id,
    profile: result.profile,
    readabilityScore: result.readabilityScore,
    overrideMoves: result.overrideMoves.length,
  })),
}, null, 2));

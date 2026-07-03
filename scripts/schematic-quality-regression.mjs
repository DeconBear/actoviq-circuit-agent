import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
      Rgate: { x: 155, y: 205 },
      M1: { x: 290, y: 185 },
      RD: { x: 315, y: 85 },
      RS: { x: 345, y: 315 },
      COUT: { x: 420, y: 195 },
      RLOAD: { x: 605, y: 315 },
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
  {
    id: 'cmos-inverter',
    inputNode: 'in',
    outputNode: 'out',
    netlist: [
      '* CMOS inverter fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      '.model PMOS1 PMOS (LEVEL=1 VTO=-0.7 KP=40u)',
      'MP1 out in vdd vdd PMOS1 W=40u L=1u',
      'MN1 out in 0 0 NMOS1 W=20u L=1u',
      'Cload out 0 10p',
      '.end',
    ],
    overrides: {
      MP1: { x: 300, y: 110 },
      MN1: { x: 300, y: 290 },
      Cload: { x: 470, y: 255 },
      OUT: { x: 610, y: 200 },
    },
  },
  {
    id: 'mos-differential-pair',
    inputNode: 'inp',
    outputNode: 'outp',
    netlist: [
      '* MOS differential pair fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      'M_INP outp inp tail 0 NMOS1 W=20u L=1u',
      'M_INN outn inn tail 0 NMOS1 W=20u L=1u',
      'RDP vdd outp 10k',
      'RDN vdd outn 10k',
      'Itail tail 0 DC 100u',
      '.end',
    ],
    overrides: {
      M_INP: { x: 230, y: 240 },
      M_INN: { x: 430, y: 240 },
      RDP: { x: 230, y: 85 },
      RDN: { x: 430, y: 85 },
      ITAIL: { x: 330, y: 420 },
      OUT: { x: 610, y: 155 },
    },
  },
  {
    id: 'bjt-reset-handshake',
    inputNode: 'dtr',
    outputNode: 'boot0',
    netlist: [
      '* BJT reset/boot handshake fixture',
      '.model S8050 NPN (IS=1e-14 BF=160)',
      '.model D4148 D (IS=2.52n RS=0.568 N=1.906)',
      'Q_BOOT vdd rts_drive boot_node S8050',
      'Q_RST rst_pull dtr_drive rts S8050',
      'D1 rst rst_pull D4148',
      'R50 vdd rst_pull 10k',
      'R51 dtr dtr_drive 1k',
      'R49 rts_drive rts 1k',
      'R52 boot_node boot0 1k',
      '.end',
    ],
    moduleManifest: {
      version: 1,
      modules: [
        {
          name: 'reset_handshake',
          label: 'RESET HANDSHAKE',
          component_names: ['Q_BOOT', 'Q_RST', 'D1', 'R50', 'R51', 'R49', 'R52'],
          input_nets: ['rst', 'dtr'],
          output_nets: ['rts', 'boot0'],
          shared_nets: ['vdd'],
          ports: [
            { id: 'vdd', name: '+3.3V', direction: 'input', signal_type: 'power', net: 'vdd', side: 'top' },
            { id: 'rst', name: 'RST', direction: 'input', signal_type: 'digital', net: 'rst', side: 'left' },
            { id: 'dtr', name: 'DTR', direction: 'input', signal_type: 'digital', net: 'dtr', side: 'right' },
            { id: 'rts', name: 'RTS', direction: 'output', signal_type: 'digital', net: 'rts', side: 'right' },
            { id: 'boot0', name: 'BOOT0', direction: 'output', signal_type: 'digital', net: 'boot0', side: 'right' },
          ],
        },
      ],
    },
    overrides: {
      Q_BOOT: { x: 150, y: 250 },
      Q_RST: { x: 430, y: 165 },
      D1: { x: 275, y: 165 },
      R50: { x: 430, y: 55 },
      R51: { x: 350, y: 165 },
      R49: { x: 285, y: 320 },
      R52: { x: 205, y: 277 },
      RST: { x: 215, y: 165 },
      DTR: { x: 330, y: 130 },
      RTS: { x: 720, y: 320 },
      BOOT0: { x: 280, y: 277 },
    },
  },
  {
    id: 'current-mirror',
    inputNode: 'bias',
    outputNode: 'out',
    netlist: [
      '* NMOS current mirror fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      'IREF vdd bias DC 100u',
      'MREF bias bias 0 0 NMOS1 W=20u L=1u',
      'MOUT out bias 0 0 NMOS1 W=20u L=1u',
      'RLOAD vdd out 10k',
      '.end',
    ],
    overrides: {
      MREF: { x: 185, y: 200 },
      MOUT: { x: 360, y: 200 },
      RLOAD: { x: 360, y: 80 },
      OUT: { x: 545, y: 170 },
    },
  },
  {
    id: 'signal-chain-comparator',
    inputNode: 'in',
    outputNode: 'alarm_n',
    netlist: [
      '* VCVS opamp + RC + active-low comparator fixture',
      'Vsupply vdd 0 DC 5',
      'Vin in 0 DC 0 AC 1',
      'EOPAMP op_out 0 in amp_fb 100k',
      'Rfb_top op_out amp_fb 70k',
      'Rfb_bot amp_fb 0 10k',
      'Rlp op_out filt 10k',
      'Clp filt 0 10n',
      'Rth1 vdd vth 10k',
      'Rth2 vth 0 10k',
      'ECOMP alarm_n 0 filt vth 1e6',
      'Rpull vdd alarm_n 4.7k',
      'Cout alarm_n 0 2p',
      '.end',
    ],
    overrides: {
      EOPAMP: { x: 188, y: 170 },
      Rfb_top: { x: 188, y: 105 },
      Rfb_bot: { x: 70, y: 250 },
      Rlp: { x: 382, y: 195 },
      Clp: { x: 417, y: 258 },
      Rth1: { x: 570, y: 82 },
      Rth2: { x: 570, y: 132 },
      ECOMP: { x: 480, y: 170 },
      Rpull: { x: 600, y: 140 },
      Cout: { x: 640, y: 190 },
      OUT: { x: 700, y: 180 },
    },
  },
  {
    id: 'buck-converter',
    inputNode: 'vin',
    outputNode: 'vout',
    netlist: [
      '* Buck converter fixture',
      '.model PMOS1 PMOS (LEVEL=1 VTO=-0.8 KP=60u)',
      '.model DFAST D(IS=1n RS=0.1 TT=10n)',
      'Vin vin 0 DC 12',
      'Vgate gate 0 PULSE(12 0 0 20n 20n 5u 10u)',
      'Msw sw gate vin vin PMOS1 W=200u L=1u',
      'Dfree 0 sw DFAST',
      'L1 sw vout 22u',
      'Cout vout 0 47u',
      'Rload vout 0 10',
      '.end',
    ],
    overrides: {
      Msw: { x: 150, y: 100 },
      Dfree: { x: 225, y: 150 },
      L1: { x: 300, y: 195 },
      Cout: { x: 395, y: 200 },
      Rload: { x: 465, y: 200 },
      OUT: { x: 505, y: 190 },
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

function assertRenderedQuality(fixture, caseLabel, rendered, geometry) {
  const summary = geometry.summary ?? {};
  assert.equal(geometry.ok, true, `${fixture.id} ${caseLabel} geometry failed: ${JSON.stringify(summary)}`);
  assert.equal(hardGeometryOk(summary), true, `${fixture.id} ${caseLabel} hard geometry issues: ${JSON.stringify(summary)}`);
  assert.ok((rendered.layout_report?.readability_score ?? 0) >= 85, `${fixture.id} ${caseLabel} readability below 85`);
  assert.deepEqual(
    geometry.readability?.issues ?? [],
    [],
    `${fixture.id} ${caseLabel} readability issues: ${JSON.stringify(geometry.readability?.issues ?? [])}`,
  );
}

async function renderCase({
  fixture,
  caseLabel,
  sourceJsonPath,
  caseRoot,
  overridesPath,
}) {
  await mkdir(caseRoot, { recursive: true });
  const jsonPath = path.resolve(caseRoot, 'design.json');
  const svgPath = path.resolve(caseRoot, 'schematic.svg');
  await copyFile(sourceJsonPath, jsonPath);

  const args = [
    renderPath,
    '--json-path', jsonPath,
    '--svg-path', svgPath,
    '--netlistsvg-bin', netlistsvgBin,
    '--skin-profile', 'analog',
    '--timeout-sec', '45',
  ];
  if (overridesPath) {
    args.push('--overrides-path', overridesPath);
  }

  const rendered = runJson(python, args);
  assert.equal(rendered.ok, true, `${fixture.id} ${caseLabel}`);

  const geometryPath = svgPath.replace(/\.svg$/, '.geometry.json');
  const layoutPath = svgPath.replace(/\.svg$/, '.layout.json');
  const geometry = JSON.parse(await readFile(geometryPath, 'utf8'));
  assertRenderedQuality(fixture, caseLabel, rendered, geometry);

  return {
    id: fixture.id,
    case: caseLabel,
    profile: rendered.planner?.profile ?? rendered.formatted_layout?.profile ?? 'unknown',
    svgPath,
    jsonPath,
    geometryPath,
    layoutPath,
    rendered,
    geometry,
    geometrySummary: geometry.summary ?? {},
    readabilityScore: rendered.layout_report?.readability_score ?? null,
  };
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
  const overridesPath = path.resolve(fixtureRoot, 'schematic.overrides.json');
  const manifestPath = path.resolve(fixtureRoot, 'module-manifest.json');

  await writeFile(netlistPath, `${fixture.netlist.join('\n')}\n`, 'utf8');
  await writeFile(overridesPath, `${JSON.stringify(overrideDocument(fixture), null, 2)}\n`, 'utf8');
  if (fixture.moduleManifest) {
    await writeFile(manifestPath, `${JSON.stringify(fixture.moduleManifest, null, 2)}\n`, 'utf8');
  }

  const convertArgs = [
    netlistToJsonPath,
    '--netlist-path', netlistPath,
    '--json-path', jsonPath,
    '--view', 'schematic',
    '--input-node', fixture.inputNode,
    '--output-node', fixture.outputNode,
  ];
  if (fixture.moduleManifest) {
    convertArgs.push('--module-manifest-path', manifestPath);
  }
  const converted = runJson(python, convertArgs);
  assert.equal(converted.ok, true, fixture.id);

  const autoResult = await renderCase({
    fixture,
    caseLabel: 'auto',
    sourceJsonPath: jsonPath,
    caseRoot: path.resolve(fixtureRoot, 'auto'),
  });
  const adjustedResult = await renderCase({
    fixture,
    caseLabel: 'adjusted',
    sourceJsonPath: jsonPath,
    caseRoot: path.resolve(fixtureRoot, 'adjusted'),
    overridesPath,
  });

  const moved = adjustedResult.rendered.formatted_layout?.schematic_overrides?.moved ?? [];
  const skipped = adjustedResult.rendered.formatted_layout?.schematic_overrides?.skipped ?? [];
  const missingMoves = Object.keys(fixture.overrides).filter((id) => !moved.includes(id));

  assert.deepEqual(skipped, [], `${fixture.id} skipped schematic overrides`);
  assert.deepEqual(missingMoves, [], `${fixture.id} missing schematic override moves`);

  results.push({
    id: fixture.id,
    profile: adjustedResult.profile,
    auto: {
      svgPath: autoResult.svgPath,
      jsonPath: autoResult.jsonPath,
      geometryPath: autoResult.geometryPath,
      layoutPath: autoResult.layoutPath,
      geometry: autoResult.geometrySummary,
      readabilityScore: autoResult.readabilityScore,
    },
    adjusted: {
      svgPath: adjustedResult.svgPath,
      jsonPath: adjustedResult.jsonPath,
      geometryPath: adjustedResult.geometryPath,
      layoutPath: adjustedResult.layoutPath,
      geometry: adjustedResult.geometrySummary,
      readabilityScore: adjustedResult.readabilityScore,
    },
    overrideMoves: moved,
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
    autoReadabilityScore: result.auto.readabilityScore,
    adjustedReadabilityScore: result.adjusted.readabilityScore,
    overrideMoves: result.overrideMoves.length,
  })),
}, null, 2));

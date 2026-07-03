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
    id: 'opamp-feedback',
    inputNode: 'in',
    outputNode: 'vout',
    netlist: [
      '* VCVS opamp feedback fixture',
      'Vsupply vdd 0 DC 5',
      'Vin in 0 DC 1 AC 1',
      'EOPAMP vout 0 in fb 100k',
      'R2F vout fb 90k',
      'R1F fb 0 10k',
      'Cload vout 0 10p',
      'Rload vout 0 10k',
      '.end',
    ],
    overrides: {
      EOPAMP: { x: 188, y: 170 },
      R2F: { x: 188, y: 105 },
      R1F: { x: 70, y: 250 },
      Cload: { x: 340, y: 258 },
      Rload: { x: 430, y: 258 },
      OUT: { x: 475, y: 190 },
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
  {
    id: 'mos-cascode-amplifier',
    inputNode: 'in',
    outputNode: 'out',
    netlist: [
      '* MOS cascode amplifier fixture',
      '.param VDD=5',
      '.param IBIAS=350u',
      'VDD vdd 0 DC {VDD}',
      'VIN in 0 AC 1',
      'VBIAS vb 0 DC 1.85',
      'I1 vdd ns DC {IBIAS}',
      'RS ns 0 1.2k',
      'M1 nd in ns 0 NMOS W=800u L=1u',
      'M2 no vb nd 0 NMOS W=500u L=1u',
      'RL vdd no 25k',
      'CINT no 0 1.5p',
      'CCOMP no in 0.8p',
      'ROUT no out 8ohm',
      'CLOAD out 0 12p',
      'RPROBE out 0 1Meg',
      '.model NMOS NMOS(LEVEL=1 VTO=0.8 KP=250u LAMBDA=0.03)',
      '.end',
    ],
    overrides: {},
  },
  {
    id: 'cmos-ring-oscillator',
    inputNode: 'n1',
    outputNode: 'n3',
    netlist: [
      '* 3-stage CMOS ring oscillator fixture',
      '.param VDD=5',
      '.param CLOAD=120f',
      'VDD vdd 0 DC {VDD}',
      'M1 n1 n3 0 0 NMOS W=60u L=1u',
      'M2 n1 n3 vdd vdd PMOS W=120u L=1u',
      'M3 n2 n1 0 0 NMOS W=60u L=1u',
      'M4 n2 n1 vdd vdd PMOS W=120u L=1u',
      'M5 n3 n2 0 0 NMOS W=60u L=1u',
      'M6 n3 n2 vdd vdd PMOS W=120u L=1u',
      'C1 n1 0 {CLOAD}',
      'C2 n2 0 {CLOAD}',
      'C3 n3 0 {CLOAD}',
      'RLEAK1 n1 0 5Meg',
      'RLEAK2 n2 0 5Meg',
      'RLEAK3 n3 0 5Meg',
      '.model NMOS NMOS(LEVEL=1 VTO=0.9 KP=220u LAMBDA=0.02)',
      '.model PMOS PMOS(LEVEL=1 VTO=-0.9 KP=110u LAMBDA=0.02)',
      '.end',
    ],
    overrides: {},
  },
  {
    id: 'rf-lna-common-emitter',
    inputNode: 'in',
    outputNode: 'out',
    netlist: [
      '* RF common-emitter LNA fixture',
      '.param VCC=15',
      '.param RS=50ohm',
      '.param RL=50ohm',
      'VCC vcc 0 DC {VCC}',
      'VIN src 0 AC 1',
      'RSRC src in {RS}',
      'CIN in b 68p',
      'RB1 vcc b 22k',
      'RB2 b 0 4.7k',
      'RE e 0 39ohm',
      'CE e 0 4.7n',
      'Q1 c b e QNPN',
      'RC vcc c 680ohm',
      'COUT c out 100p',
      'RLOAD out 0 {RL}',
      '.model QNPN NPN(IS=6.734e-15 BF=220 VAF=120 IKF=0.15)',
      '.end',
    ],
    overrides: {},
  },
  {
    id: 'rf-mixed-signal-detector',
    inputNode: 'rf_in',
    outputNode: 'adc_n',
    netlist: [
      '* RF mixed-signal detector + comparator fixture',
      '.model NMOS NMOS(LEVEL=1 VTO=0.8 KP=120u)',
      '.model DFAST D(IS=1n RS=1 TT=5n)',
      'VDD vdd 0 DC 5',
      'VIN rf_in 0 AC 1',
      'CIN rf_in match 10p',
      'LMATCH match gate 47n',
      'CMATCH match 0 2p',
      'RGTOP vdd vgate 100k',
      'RGBOT vgate 0 33k',
      'RGATE vgate gate 100',
      'M1 drain gate src 0 NMOS W=120u L=1u',
      'RS src 0 100',
      'LCHOKE vdd drain 100n',
      'CCOUPLE drain det_in 10p',
      'DDET det_in env DFAST',
      'RDET env 0 100k',
      'CDET env 0 1n',
      'RLP env lpf 10k',
      'CLP lpf 0 100p',
      'RTH1 vdd vth 100k',
      'RTH2 vth 0 100k',
      'ECOMP adc_n 0 lpf vth 1e6',
      'RPU vdd adc_n 10k',
      'COUT adc_n 0 2p',
      '.end',
    ],
    overrides: {},
  },
  {
    id: 'baseband-detail',
    inputNode: 'det_out',
    outputNode: 'bb_out',
    moduleDetail: 'baseband_conditioning',
    expectedProfile: 'baseband_detail',
    netlist: [
      '* Baseband conditioning detail fixture',
      '.model QNPN NPN(IS=1e-15 BF=120)',
      'VDD vdd 0 DC 5',
      'VIN det_out 0 AC 1',
      'VREF ref 0 DC 1.2',
      'Rdec vdd bb_vdd 10',
      'Cdec bb_vdd 0 100n',
      'Rin det_out base 10k',
      'Rbias1 bb_vdd base 100k',
      'Q2 n1 base tail QNPN',
      'Q3 fb ref tail QNPN',
      'Re_tail tail 0 1k',
      'Rf bb_out fb 100k',
      'Rg fb 0 10k',
      'Rsk1 n1 n2 10k',
      'Csk1 n2 0 1n',
      'Rsk2 n2 bb_drive 10k',
      'Csk2 bb_drive 0 1n',
      'Q4 bb_out bb_drive 0 QNPN',
      'Rload_bb bb_vdd bb_out 10k',
      '.end',
    ],
    overrides: {},
  },
  {
    id: 'window-comparator-detail',
    inputNode: 'in',
    outputNode: 'out_n',
    moduleDetail: 'window_comparator',
    expectedProfile: 'window_comparator_detail',
    netlist: [
      '* Window comparator detail fixture',
      '.model QNPN NPN(IS=1e-15 BF=120)',
      '.model DFAST D(IS=1n RS=1)',
      'VDD vdd 0 DC 5',
      'VIN in 0 DC 1',
      'Rdiv1 vdd vh 100k',
      'Rdiv2 vh vl 100k',
      'Rdiv3 vl 0 100k',
      'Q5 out_hi in tail_hi QNPN',
      'R1 vdd out_hi 10k',
      'Rref1 tail_hi 0 2k',
      'Q6 out_lo vl tail_lo QNPN',
      'R2 vdd out_lo 10k',
      'D2 out_hi out_n DFAST',
      'D3 out_lo out_n DFAST',
      'Rpull vdd out_n 10k',
      '.end',
    ],
    overrides: {},
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
    profile: rendered.formatted_layout?.profile ?? rendered.planner?.profile ?? 'unknown',
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
  if (fixture.moduleDetail) {
    const payload = JSON.parse(await readFile(jsonPath, 'utf8'));
    payload.schematic_intent = {
      ...(payload.schematic_intent ?? {}),
      module_detail: fixture.moduleDetail,
    };
    await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

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
  if (fixture.expectedProfile) {
    assert.equal(autoResult.profile, fixture.expectedProfile, `${fixture.id} auto profile`);
    assert.equal(adjustedResult.profile, fixture.expectedProfile, `${fixture.id} adjusted profile`);
  }

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

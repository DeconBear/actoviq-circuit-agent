import type { CircuitComponent, CircuitModule, CircuitPort } from '../../renderer/src/types';

const defaultPorts: CircuitPort[] = [
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const bjtResetPorts: CircuitPort[] = [
  { id: 'vdd', name: '+3.3V', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'rst', name: 'RST', direction: 'input', signal_type: 'digital', net: 'rst' },
  { id: 'dtr', name: 'DTR', direction: 'input', signal_type: 'digital', net: 'dtr' },
  { id: 'rts', name: 'RTS', direction: 'output', signal_type: 'digital', net: 'rts' },
  { id: 'boot0', name: 'BOOT0', direction: 'output', signal_type: 'digital', net: 'boot0' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const voltageDividerPorts: CircuitPort[] = [
  { id: 'vdd', name: '+5V', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

export const ldoPorts: CircuitPort[] = [
  { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
  { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const pmosLdoBenchPorts: CircuitPort[] = [
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'vin' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
];

const differentialPairPorts: CircuitPort[] = [
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'inp', name: 'IN+', direction: 'input', signal_type: 'analog', net: 'inp' },
  { id: 'inn', name: 'IN-', direction: 'input', signal_type: 'analog', net: 'inn' },
  { id: 'outp', name: 'OUT+', direction: 'output', signal_type: 'analog', net: 'outp' },
  { id: 'outn', name: 'OUT-', direction: 'output', signal_type: 'analog', net: 'outn' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const cmosRingPorts: CircuitPort[] = [
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'digital', net: 'n3' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const basebandPorts: CircuitPort[] = [
  { id: 'det_out', name: 'DET_OUT', direction: 'input', signal_type: 'analog', net: 'det_out' },
  { id: 'ref', name: 'VREF', direction: 'input', signal_type: 'analog', net: 'ref' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'bb_vdd', name: 'BB_VDD', direction: 'input', signal_type: 'power', net: 'bb_vdd' },
  { id: 'bb_out', name: 'BB_OUT', direction: 'output', signal_type: 'analog', net: 'bb_out' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const windowComparatorPorts: CircuitPort[] = [
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT_N', direction: 'output', signal_type: 'digital', net: 'out_n' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const opampFeedbackPorts: CircuitPort[] = [
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'vout' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const cascodePorts: CircuitPort[] = [
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const buckBoostPorts: CircuitPort[] = [
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  { id: 'vin_power', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
  { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'analog', net: 'vin' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'vout' },
  { id: 'g1', name: 'G1', direction: 'input', signal_type: 'analog', net: 'g1' },
  { id: 'g2', name: 'G2', direction: 'input', signal_type: 'analog', net: 'g2' },
  { id: 'g3', name: 'G3', direction: 'input', signal_type: 'analog', net: 'g3' },
  { id: 'g4', name: 'G4', direction: 'input', signal_type: 'analog', net: 'g4' },
];

export function component(
  id: string,
  type: CircuitComponent['type'],
  value: string,
  x: number,
  y: number,
  pins: Array<[string, string, string]>,
): CircuitComponent {
  return {
    id,
    type,
    name: id.toUpperCase(),
    value,
    position: { x, y },
    rotation: 0,
    pins: pins.map(([pinId, name, net]) => ({ id: pinId, name, net })),
  };
}

export function moduleFixture(moduleId: string, components: CircuitComponent[], modulePorts: CircuitPort[] = defaultPorts): CircuitModule {
  return {
    schema: 'actoviq.module.v1',
    module_id: moduleId,
    name: moduleId,
    revision: 0,
    ports: modulePorts,
    components,
    wires: [],
    annotations: [],
  };
}

export const fixtures: CircuitModule[] = [
  moduleFixture('rc_low_pass', [
    component('r1', 'R', '10k', 80, 120, [['a', '1', 'in'], ['b', '2', 'out']]),
    component('c1', 'C', '15.9n', 240, 220, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
  moduleFixture('custom_block', [{
    id: 'adc_block',
    type: 'BLOCK',
    name: 'U1',
    value: 'ADC + DSP',
    position: { x: 300, y: 220 },
    rotation: 0,
    pins: [
      { id: 'ain', name: 'AIN', net: 'in', side: 'left', order: 0 },
      { id: 'data', name: 'DATA', net: 'out', side: 'right', order: 0 },
      { id: 'vdd', name: 'VDD', net: 'vdd', side: 'top', order: 0 },
      { id: 'gnd', name: 'GND', net: '0', side: 'bottom', order: 0 },
    ],
    block: { width: 180, height: 140 },
  }]),
  moduleFixture('rlc_band_pass', [
    component('r1', 'R', '50', 80, 120, [['a', '1', 'in'], ['b', '2', 'n1']]),
    component('l1', 'L', '10u', 220, 120, [['a', '1', 'n1'], ['b', '2', 'out']]),
    component('c1', 'C', '100n', 360, 220, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
  moduleFixture('voltage_divider', [
    component('rtop', 'R', '10k', 120, 80, [['a', '1', 'vdd'], ['b', '2', 'vout']]),
    component('rbot', 'R', '20k', 120, 240, [['a', '1', 'vout'], ['b', '2', '0']]),
    component('cflt', 'C', '100n', 260, 240, [['a', '1', 'vout'], ['b', '2', '0']]),
  ], voltageDividerPorts),
  moduleFixture('diode_rectifier', [
    component('d1', 'D', 'D', 120, 120, [['a', 'A', 'in'], ['b', 'K', 'out']]),
    component('c1', 'C', '10u', 270, 220, [['a', '1', 'out'], ['b', '2', '0']]),
    component('r1', 'R', '10k', 420, 220, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
  moduleFixture('bjt_common_emitter', [
    component('cin', 'C', '100n', 80, 180, [['a', '1', 'in'], ['b', '2', 'b']]),
    component('r1', 'R', '47k', 150, 80, [['a', '1', 'vdd'], ['b', '2', 'b']]),
    component('r2', 'R', '10k', 150, 300, [['a', '1', 'b'], ['b', '2', '0']]),
    component('q1', 'Q', 'NPN', 220, 180, [['c', 'C', 'out'], ['b', 'B', 'b'], ['e', 'E', 'e']]),
    component('rc', 'R', '4.7k', 220, 60, [['a', '1', 'vdd'], ['b', '2', 'out']]),
    component('re', 'R', '1k', 220, 310, [['a', '1', 'e'], ['b', '2', '0']]),
    component('cout', 'C', '1u', 360, 180, [['a', '1', 'out'], ['b', '2', 'load']]),
    component('rload', 'R', '10k', 500, 260, [['a', '1', 'load'], ['b', '2', '0']]),
  ]),
  moduleFixture('bjt_reset_network', [
    component('q_boot', 'Q', 'S8050', 160, 220, [['c', 'C', 'vdd'], ['b', 'B', 'rts_drive'], ['e', 'E', 'boot_node']]),
    component('q_rst', 'Q', 'S8050', 420, 180, [['c', 'C', 'rst_pull'], ['b', 'B', 'dtr_drive'], ['e', 'E', 'rts']]),
    component('d_rst', 'D', '1N4148W', 280, 120, [['a', 'A', 'rst'], ['b', 'K', 'rst_pull']]),
    component('r50', 'R', '10k', 420, 60, [['a', '1', 'vdd'], ['b', '2', 'rst_pull']]),
    component('r51', 'R', '1k', 560, 180, [['a', '1', 'dtr_drive'], ['b', '2', 'dtr']]),
    component('r49', 'R', '1k', 290, 280, [['a', '1', 'rts_drive'], ['b', '2', 'rts']]),
    component('r52', 'R', '1k', 160, 380, [['a', '1', 'boot_node'], ['b', '2', 'boot0']]),
  ], bjtResetPorts),
  moduleFixture('mos_common_source', [
    component('m1', 'M', 'NMOS W=10u L=1u', 220, 180, [
      ['d', 'D', 'out'],
      ['g', 'G', 'in'],
      ['s', 'S', '0'],
      ['b', 'B', '0'],
    ]),
    component('rd', 'R', '10k', 220, 60, [['a', '1', 'vdd'], ['b', '2', 'out']]),
  ]),
  moduleFixture('mos_common_source_full', [
    component('cin', 'C', '100n', 80, 180, [['a', '1', 'in'], ['b', '2', 'gate']]),
    component('rg1', 'R', '1M', 150, 80, [['a', '1', 'vdd'], ['b', '2', 'gate']]),
    component('rg2', 'R', '220k', 150, 300, [['a', '1', 'gate'], ['b', '2', '0']]),
    component('m1', 'M', 'NMOS W=20u L=1u', 260, 180, [
      ['d', 'D', 'drain'],
      ['g', 'G', 'gate'],
      ['s', 'S', 'source'],
      ['b', 'B', '0'],
    ]),
    component('rd', 'R', '10k', 260, 60, [['a', '1', 'vdd'], ['b', '2', 'drain']]),
    component('rs', 'R', '1k', 260, 320, [['a', '1', 'source'], ['b', '2', '0']]),
    component('cs', 'C', '10u', 380, 320, [['a', '1', 'source'], ['b', '2', '0']]),
    component('cout', 'C', '1u', 420, 180, [['a', '1', 'drain'], ['b', '2', 'out']]),
    component('rload', 'R', '100k', 560, 300, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
  moduleFixture('cmos_inverter', [
    component('mp1', 'M', 'PMOS W=40u L=1u', 240, 120, [
      ['d', 'D', 'out'],
      ['g', 'G', 'in'],
      ['s', 'S', 'vdd'],
      ['b', 'B', 'vdd'],
    ]),
    component('mn1', 'M', 'NMOS W=20u L=1u', 240, 300, [
      ['d', 'D', 'out'],
      ['g', 'G', 'in'],
      ['s', 'S', '0'],
      ['b', 'B', '0'],
    ]),
    component('cload', 'C', '10p', 430, 250, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
  moduleFixture('cmos_ring_oscillator', [
    component('m1', 'M', 'NMOS W=60u L=1u', 180, 300, [
      ['d', 'D', 'n1'], ['g', 'G', 'n3'], ['s', 'S', '0'], ['b', 'B', '0'],
    ]),
    component('m2', 'M', 'PMOS W=120u L=1u', 180, 120, [
      ['d', 'D', 'n1'], ['g', 'G', 'n3'], ['s', 'S', 'vdd'], ['b', 'B', 'vdd'],
    ]),
    component('m3', 'M', 'NMOS W=60u L=1u', 500, 300, [
      ['d', 'D', 'n2'], ['g', 'G', 'n1'], ['s', 'S', '0'], ['b', 'B', '0'],
    ]),
    component('m4', 'M', 'PMOS W=120u L=1u', 500, 120, [
      ['d', 'D', 'n2'], ['g', 'G', 'n1'], ['s', 'S', 'vdd'], ['b', 'B', 'vdd'],
    ]),
    component('m5', 'M', 'NMOS W=60u L=1u', 820, 300, [
      ['d', 'D', 'n3'], ['g', 'G', 'n2'], ['s', 'S', '0'], ['b', 'B', '0'],
    ]),
    component('m6', 'M', 'PMOS W=120u L=1u', 820, 120, [
      ['d', 'D', 'n3'], ['g', 'G', 'n2'], ['s', 'S', 'vdd'], ['b', 'B', 'vdd'],
    ]),
    component('c1', 'C', '120f', 300, 500, [['a', '1', 'n1'], ['b', '2', '0']]),
    component('c2', 'C', '120f', 620, 500, [['a', '1', 'n2'], ['b', '2', '0']]),
    component('c3', 'C', '120f', 940, 500, [['a', '1', 'n3'], ['b', '2', '0']]),
    component('rleak1', 'R', '5Meg', 390, 500, [['a', '1', 'n1'], ['b', '2', '0']]),
    component('rleak2', 'R', '5Meg', 710, 500, [['a', '1', 'n2'], ['b', '2', '0']]),
    component('rleak3', 'R', '5Meg', 1030, 500, [['a', '1', 'n3'], ['b', '2', '0']]),
  ], cmosRingPorts),
  moduleFixture('mos_differential_pair', [
    component('m_inp', 'M', 'NMOS W=20u L=1u', 220, 240, [
      ['d', 'D', 'outp'],
      ['g', 'G', 'inp'],
      ['s', 'S', 'tail'],
      ['b', 'B', '0'],
    ]),
    component('m_inn', 'M', 'NMOS W=20u L=1u', 430, 240, [
      ['d', 'D', 'outn'],
      ['g', 'G', 'inn'],
      ['s', 'S', 'tail'],
      ['b', 'B', '0'],
    ]),
    component('rdp', 'R', '10k', 220, 80, [['a', '1', 'vdd'], ['b', '2', 'outp']]),
    component('rdn', 'R', '10k', 430, 80, [['a', '1', 'vdd'], ['b', '2', 'outn']]),
    component('itail', 'I', 'DC 100u', 325, 420, [['p', '+', 'tail'], ['n', '-', '0']]),
  ], differentialPairPorts),
  moduleFixture('mos_ldo', [
    component('m1', 'M', 'NMOS W=20u L=1u', 220, 180, [
      ['d', 'D', 'n1'],
      ['g', 'G', 'fb'],
      ['s', 'S', 'tail'],
      ['b', 'B', '0'],
    ]),
    component('m2', 'M', 'NMOS W=20u L=1u', 390, 180, [
      ['d', 'D', 'eaout'],
      ['g', 'G', 'vref'],
      ['s', 'S', 'tail'],
      ['b', 'B', '0'],
    ]),
    component('m3', 'M', 'PMOS W=40u L=1u', 220, 50, [
      ['d', 'D', 'n1'],
      ['g', 'G', 'n1'],
      ['s', 'S', 'vin'],
      ['b', 'B', 'vin'],
    ]),
    component('m4', 'M', 'PMOS W=40u L=1u', 390, 50, [
      ['d', 'D', 'eaout'],
      ['g', 'G', 'n1'],
      ['s', 'S', 'vin'],
      ['b', 'B', 'vin'],
    ]),
    component('mp', 'M', 'PMOS W=2000u L=0.5u', 560, 120, [
      ['d', 'D', 'vout'],
      ['g', 'G', 'eaout'],
      ['s', 'S', 'vin'],
      ['b', 'B', 'vin'],
    ]),
    component('vin', 'V', 'DC 5', 80, 250, [['p', '+', 'vin'], ['n', '-', '0']]),
    component('vref', 'V', 'DC 1.2', 80, 420, [['p', '+', 'vref'], ['n', '-', '0']]),
    component('itail', 'I', 'DC 20u', 300, 460, [['p', '+', 'tail'], ['n', '-', '0']]),
    component('rtop', 'R', '210k', 720, 250, [['a', '1', 'fb'], ['b', '2', 'vout']]),
    component('rbot', 'R', '120k', 720, 420, [['a', '1', 'fb'], ['b', '2', '0']]),
    component('rload', 'R', '330', 860, 420, [['a', '1', 'vout'], ['b', '2', '0']]),
    component('cout', 'C', '1u', 990, 420, [['a', '1', 'vout'], ['b', '2', '0']]),
  ], ldoPorts),
  moduleFixture('pmos_ldo_bench', [
    component('vin', 'V', 'DC {VIN_NOM} AC 0', 100, 220, [['p', '+', 'vin'], ['n', '-', '0']]),
    component('vref_src', 'V', 'DC {VREF} AC 1', 340, 420, [['p', '+', 'vref'], ['n', '-', '0']]),
    component('rpu', 'R', '47k', 200, 120, [['a', '1', 'vin'], ['b', '2', 'gate']]),
    component('qerr', 'Q', 'QNPN', 480, 320, [
      ['c', 'C', 'gate'],
      ['b', 'B', 'vref'],
      ['e', 'E', 'fb'],
    ]),
    component('mpass', 'M', 'PMOSPASS W=20m L=1u', 320, 180, [
      ['d', 'D', 'out'],
      ['g', 'G', 'gate'],
      ['s', 'S', 'vin'],
      ['b', 'B', 'vin'],
    ]),
    component('rfb1', 'R', '{RTOP}', 680, 220, [['a', '1', 'out'], ['b', '2', 'fb']]),
    component('rfb2', 'R', '{RBOT}', 680, 400, [['a', '1', 'fb'], ['b', '2', '0']]),
    component('cout', 'C', '{COUTVAL}', 860, 300, [['a', '1', 'out'], ['b', '2', '0']]),
    component('iload', 'I', 'DC 0 PULSE(0 {ILOAD_STEP} 0.5m 1u 1u 0.5m 5m)', 980, 300, [
      ['p', '+', 'out'],
      ['n', '-', '0'],
    ]),
  ], pmosLdoBenchPorts),
  moduleFixture('baseband_conditioning', [
    component('rdec', 'R', '10', 70, 60, [['a', '1', 'vdd'], ['b', '2', 'bb_vdd']]),
    component('cdec', 'C', '100n', 120, 320, [['a', '1', 'bb_vdd'], ['b', '2', '0']]),
    component('rin', 'R', '10k', 90, 210, [['a', '1', 'det_out'], ['b', '2', 'base']]),
    component('rbias1', 'R', '100k', 210, 300, [['a', '1', 'bb_vdd'], ['b', '2', 'base']]),
    component('q2', 'Q', 'QNPN', 250, 140, [['c', 'C', 'n1'], ['b', 'B', 'base'], ['e', 'E', 'tail']]),
    component('q3', 'Q', 'QNPN', 350, 140, [['c', 'C', 'fb'], ['b', 'B', 'ref'], ['e', 'E', 'tail']]),
    component('re_tail', 'R', '1k', 290, 260, [['a', '1', 'tail'], ['b', '2', '0']]),
    component('rf', 'R', '100k', 380, 70, [['a', '1', 'fb'], ['b', '2', 'bb_out']]),
    component('rg', 'R', '10k', 390, 310, [['a', '1', 'fb'], ['b', '2', '0']]),
    component('rsk1', 'R', '10k', 470, 210, [['a', '1', 'n1'], ['b', '2', 'n2']]),
    component('csk1', 'C', '1n', 520, 320, [['a', '1', 'n2'], ['b', '2', '0']]),
    component('rsk2', 'R', '10k', 590, 210, [['a', '1', 'n2'], ['b', '2', 'bb_drive']]),
    component('csk2', 'C', '1n', 640, 320, [['a', '1', 'bb_drive'], ['b', '2', '0']]),
    component('q4', 'Q', 'QNPN', 710, 160, [['c', 'C', 'bb_out'], ['b', 'B', 'bb_drive'], ['e', 'E', '0']]),
    component('rload_bb', 'R', '10k', 790, 310, [['a', '1', 'bb_vdd'], ['b', '2', 'bb_out']]),
  ], basebandPorts),
  moduleFixture('window_comparator', [
    component('rdiv1', 'R', '100k', 170, 60, [['a', '1', 'vdd'], ['b', '2', 'vh']]),
    component('rdiv2', 'R', '100k', 170, 140, [['a', '1', 'vh'], ['b', '2', 'vl']]),
    component('rdiv3', 'R', '100k', 170, 320, [['a', '1', 'vl'], ['b', '2', '0']]),
    component('q5', 'Q', 'QNPN', 310, 180, [['c', 'C', 'out_hi'], ['b', 'B', 'in'], ['e', 'E', 'tail_hi']]),
    component('r1', 'R', '10k', 310, 60, [['a', '1', 'vdd'], ['b', '2', 'out_hi']]),
    component('rref1', 'R', '2k', 310, 320, [['a', '1', 'tail_hi'], ['b', '2', '0']]),
    component('q6', 'Q', 'QNPN', 480, 180, [['c', 'C', 'out_lo'], ['b', 'B', 'vl'], ['e', 'E', 'tail_lo']]),
    component('r2', 'R', '10k', 480, 60, [['a', '1', 'vdd'], ['b', '2', 'out_lo']]),
    component('d2', 'D', 'DFAST', 620, 170, [['a', 'A', 'out_hi'], ['b', 'K', 'out_n']]),
    component('d3', 'D', 'DFAST', 620, 230, [['a', 'A', 'out_lo'], ['b', 'K', 'out_n']]),
    component('rpull', 'R', '10k', 710, 60, [['a', '1', 'vdd'], ['b', '2', 'out_n']]),
  ], windowComparatorPorts),
  moduleFixture('current_mirror', [
    component('m_ref', 'M', 'NMOS W=20u L=1u', 170, 180, [
      ['d', 'D', 'bias'],
      ['g', 'G', 'bias'],
      ['s', 'S', '0'],
      ['b', 'B', '0'],
    ]),
    component('m_out', 'M', 'NMOS W=20u L=1u', 340, 180, [
      ['d', 'D', 'out'],
      ['g', 'G', 'bias'],
      ['s', 'S', '0'],
      ['b', 'B', '0'],
    ]),
    component('i_ref', 'I', 'DC 100u', 170, 50, [['p', '+', 'vdd'], ['n', '-', 'bias']]),
    component('rload', 'R', '10k', 340, 50, [['a', '1', 'vdd'], ['b', '2', 'out']]),
  ]),
  moduleFixture('opamp_feedback', [
    component('eopamp', 'E', '100k', 240, 180, [
      ['p', 'OUT+', 'vout'],
      ['n', 'OUT-', '0'],
      ['cp', '+', 'in'],
      ['cn', '-', 'fb'],
    ]),
    component('vin', 'V', 'DC 1 AC 1', 80, 240, [['p', '+', 'in'], ['n', '-', '0']]),
    component('vsupply', 'V', 'DC 5', 80, 80, [['p', '+', 'vdd'], ['n', '-', '0']]),
    component('r2f', 'R', '90k', 240, 80, [['a', '1', 'vout'], ['b', '2', 'fb']]),
    component('r1f', 'R', '10k', 120, 300, [['a', '1', 'fb'], ['b', '2', '0']]),
    component('cload', 'C', '10p', 390, 300, [['a', '1', 'vout'], ['b', '2', '0']]),
    component('rload', 'R', '10k', 520, 300, [['a', '1', 'vout'], ['b', '2', '0']]),
  ], opampFeedbackPorts),
  moduleFixture('mos_cascode_amplifier', [
    component('vddsrc', 'V', 'DC 5', 80, 80, [['p', '+', 'vdd'], ['n', '-', '0']]),
    component('vin', 'V', 'AC 1', 80, 260, [['p', '+', 'in'], ['n', '-', '0']]),
    component('vbias', 'V', 'DC 1.85', 80, 180, [['p', '+', 'vb'], ['n', '-', '0']]),
    component('i1', 'I', 'DC 350u', 220, 380, [['p', '+', 'vdd'], ['n', '-', 'ns']]),
    component('rs', 'R', '1.2k', 280, 440, [['a', '1', 'ns'], ['b', '2', '0']]),
    component('m1', 'M', 'NMOS W=800u L=1u', 330, 300, [
      ['d', 'D', 'nd'],
      ['g', 'G', 'in'],
      ['s', 'S', 'ns'],
      ['b', 'B', '0'],
    ]),
    component('m2', 'M', 'NMOS W=500u L=1u', 330, 160, [
      ['d', 'D', 'no'],
      ['g', 'G', 'vb'],
      ['s', 'S', 'nd'],
      ['b', 'B', '0'],
    ]),
    component('rl', 'R', '25k', 330, 50, [['a', '1', 'vdd'], ['b', '2', 'no']]),
    component('cint', 'C', '1.5p', 460, 250, [['a', '1', 'no'], ['b', '2', '0']]),
    component('ccomp', 'C', '0.8p', 460, 90, [['a', '1', 'no'], ['b', '2', 'in']]),
    component('rout', 'R', '8ohm', 520, 160, [['a', '1', 'no'], ['b', '2', 'out']]),
    component('cload', 'C', '12p', 660, 260, [['a', '1', 'out'], ['b', '2', '0']]),
    component('rprobe', 'R', '1Meg', 780, 260, [['a', '1', 'out'], ['b', '2', '0']]),
  ], cascodePorts),
  // Four-switch buck-boost power stage captured from a real agent design session:
  // stored positions are the compiler's dense grid (with outright collisions), so
  // auto-layout must rebuild the geometry from topology alone.
  moduleFixture('buck_boost_power_stage', [
    component('m1', 'M', 'NMOS W=0.01 L=1e-6', 140, 120, [['d', 'D', 'vin'], ['g', 'G', 'g1'], ['s', 'S', 'sw1'], ['b', 'B', '0']]),
    component('d1', 'D', 'DMOD', 320, 120, [['a', 'A', 'sw1'], ['b', 'K', 'vin']]),
    component('m2', 'M', 'NMOS W=0.01 L=1e-6', 320, 120, [['d', 'D', 'sw1'], ['g', 'G', 'g2'], ['s', 'S', '0'], ['b', 'B', '0']]),
    component('d2', 'D', 'DMOD', 680, 120, [['a', 'A', '0'], ['b', 'K', 'sw1']]),
    component('l1', 'L', '100u', 500, 120, [['a', '1', 'sw1'], ['b', '2', 'sw2']]),
    component('m3', 'M', 'NMOS W=0.01 L=1e-6', 680, 120, [['d', 'D', 'vout'], ['g', 'G', 'g3'], ['s', 'S', 'sw2'], ['b', 'B', '0']]),
    component('d3', 'D', 'DMOD', 500, 260, [['a', 'A', 'sw2'], ['b', 'K', 'vout']]),
    component('m4', 'M', 'NMOS W=0.01 L=1e-6', 140, 260, [['d', 'D', 'sw2'], ['g', 'G', 'g4'], ['s', 'S', '0'], ['b', 'B', '0']]),
    component('d4', 'D', 'DMOD', 140, 400, [['a', 'A', '0'], ['b', 'K', 'sw2']]),
    component('cin', 'C', '100u', 320, 260, [['a', '1', 'vin'], ['b', '2', '0']]),
    component('cout', 'C', '470u', 500, 260, [['a', '1', 'vout'], ['b', '2', '0']]),
    component('rload', 'R', '10', 680, 260, [['a', '1', 'vout'], ['b', '2', '0']]),
  ], buckBoostPorts),
];

import assert from 'node:assert/strict';
import type { CircuitComponent, CircuitModule, CircuitPort } from '../renderer/src/types';
import {
  createSchematicDocument,
  endpointWorldPosition,
  isGroundPort,
  isPmosComponent,
  pinWorld,
} from '../renderer/src/schematic/schematicDocument';

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

const ldoPorts: CircuitPort[] = [
  { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
  { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

const differentialPairPorts: CircuitPort[] = [
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'inp', name: 'IN+', direction: 'input', signal_type: 'analog', net: 'inp' },
  { id: 'inn', name: 'IN-', direction: 'input', signal_type: 'analog', net: 'inn' },
  { id: 'outp', name: 'OUT+', direction: 'output', signal_type: 'analog', net: 'outp' },
  { id: 'outn', name: 'OUT-', direction: 'output', signal_type: 'analog', net: 'outn' },
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

function component(
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

function moduleFixture(moduleId: string, components: CircuitComponent[], modulePorts: CircuitPort[] = defaultPorts): CircuitModule {
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

const fixtures: CircuitModule[] = [
  moduleFixture('rc_low_pass', [
    component('r1', 'R', '10k', 80, 120, [['a', '1', 'in'], ['b', '2', 'out']]),
    component('c1', 'C', '15.9n', 240, 220, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
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
  ]),
];

for (const fixture of fixtures) {
  const document = createSchematicDocument(fixture);
  assert.equal(document.schema, 'actoviq.schematic-document.v1');
  assert.equal(document.module.components.length, fixture.components.length);
  assert.ok(document.wires.length > 0, `${fixture.module_id} has no materialized wires`);

  for (const component of document.module.components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      assert.ok(pin);
      const point = pinWorld(component, pin, index);
      assert.equal(Number.isFinite(point.x), true, `${fixture.module_id}.${component.id}.${pin.id} x`);
      assert.equal(Number.isFinite(point.y), true, `${fixture.module_id}.${component.id}.${pin.id} y`);
    }
  }

  for (const wire of document.wires) {
    assert.ok((wire.points ?? []).length >= 2, `${fixture.module_id}.${wire.id} has too few points`);
    for (const point of wire.points) {
      assert.equal(Number.isFinite(point.x), true, `${fixture.module_id}.${wire.id} x`);
      assert.equal(Number.isFinite(point.y), true, `${fixture.module_id}.${wire.id} y`);
    }
    for (const endpoint of [wire.from, wire.to]) {
      const resolved = endpointWorldPosition(document.module, endpoint, document.portPositions);
      if (!resolved) continue;
      assert.equal(resolved.x, endpoint?.x, `${fixture.module_id}.${wire.id} endpoint x`);
      assert.equal(resolved.y, endpoint?.y, `${fixture.module_id}.${wire.id} endpoint y`);
    }
  }

  assertReadableLayout(document.module);
  assertReadablePortPlacement(document);
  assertRailLabels(document.module, document.netLabels, document.wires);
  assertNoMosBodyRailLabels(document.module, document.netLabels);
  assertLdoInternalLabels(document);
}

console.log(JSON.stringify({
  ok: true,
  fixtureCount: fixtures.length,
  fixtures: fixtures.map((fixture) => fixture.module_id),
}, null, 2));

function assertReadableLayout(module: CircuitModule) {
  if (module.module_id === 'rc_low_pass') {
    const resistor = mustComponent(module, 'r1');
    const capacitor = mustComponent(module, 'c1');
    assertPinLeftOf(resistor, 'in', 'out', module.module_id);
    assertPinAbove(capacitor, 'out', '0', module.module_id);
    assert.ok(resistor.position.y < capacitor.position.y, 'RC shunt capacitor should sit below the series resistor');
  }
  if (module.module_id === 'rlc_band_pass') {
    const resistor = mustComponent(module, 'r1');
    const inductor = mustComponent(module, 'l1');
    const capacitor = mustComponent(module, 'c1');
    assert.ok(resistor.position.x < inductor.position.x, 'RLC series resistor should precede inductor');
    assertPinLeftOf(resistor, 'in', 'n1', module.module_id);
    assertPinLeftOf(inductor, 'n1', 'out', module.module_id);
    assertPinAbove(capacitor, 'out', '0', module.module_id);
  }
  if (module.module_id === 'voltage_divider') {
    const top = mustComponent(module, 'rtop');
    const bottom = mustComponent(module, 'rbot');
    const filter = mustComponent(module, 'cflt');
    assertPinAbove(top, 'vdd', 'vout', module.module_id);
    assertPinAbove(bottom, 'vout', '0', module.module_id);
    assertPinAbove(filter, 'vout', '0', module.module_id);
    assert.ok(Math.abs(top.position.x - bottom.position.x) <= 1, 'voltage divider resistors should align vertically');
    assert.ok(top.position.y < bottom.position.y, 'voltage divider top resistor should sit above bottom resistor');
    assert.ok(filter.position.x > bottom.position.x, 'voltage divider shunt capacitor should sit beside the divider');
  }
  if (module.module_id === 'diode_rectifier') {
    const diode = mustComponent(module, 'd1');
    const capacitor = mustComponent(module, 'c1');
    assertPinLeftOf(diode, 'in', 'out', module.module_id);
    assertPinAbove(capacitor, 'out', '0', module.module_id);
  }
  if (module.module_id === 'bjt_common_emitter') {
    const transistor = mustComponent(module, 'q1');
    const inputCoupling = mustComponent(module, 'cin');
    const collectorLoad = mustComponent(module, 'rc');
    const emitterLoad = mustComponent(module, 're');
    const outputCoupling = mustComponent(module, 'cout');
    const outputLoad = mustComponent(module, 'rload');
    assertActivePins(transistor, module.module_id);
    assert.ok(inputCoupling.position.x < transistor.position.x, 'BJT input coupling should sit before the transistor base');
    assert.ok(outputCoupling.position.x > transistor.position.x, 'BJT output coupling should sit after the collector');
    assert.ok(outputLoad.position.x >= outputCoupling.position.x, 'BJT output load should sit on the output side');
    assert.ok(collectorLoad.position.y < transistor.position.y, 'BJT collector load should sit above the transistor');
    assert.ok(emitterLoad.position.y > transistor.position.y, 'BJT emitter load should sit below the transistor');
    assert.ok(outputLoad.position.y > outputCoupling.position.y, 'BJT output load should drop toward ground');
    assertPinLeftOf(inputCoupling, 'in', 'b', module.module_id);
    assertPinLeftOf(outputCoupling, 'out', 'load', module.module_id);
    assertPinAbove(collectorLoad, 'vdd', 'out', module.module_id);
    assertPinAbove(emitterLoad, 'e', '0', module.module_id);
    assertPinAbove(outputLoad, 'load', '0', module.module_id);
  }
  if (module.module_id === 'bjt_reset_network') {
    const boot = mustComponent(module, 'q_boot');
    const reset = mustComponent(module, 'q_rst');
    const diode = mustComponent(module, 'd_rst');
    const pullup = mustComponent(module, 'r50');
    const dtr = mustComponent(module, 'r51');
    const rts = mustComponent(module, 'r49');
    const boot0 = mustComponent(module, 'r52');
    assertActivePins(boot, module.module_id);
    assertActivePins(reset, module.module_id);
    assert.ok(boot.position.x < reset.position.x, 'BJT reset boot transistor should be left of reset transistor');
    assert.ok(diode.position.x < reset.position.x, 'BJT reset diode should feed the reset transistor from the left');
    assert.ok(pullup.position.y < reset.position.y, 'BJT reset pull-up should sit above reset transistor');
    assert.ok(dtr.position.x > reset.position.x, 'BJT reset DTR resistor should sit on the output side');
    assert.ok(rts.position.x > boot.position.x && rts.position.x < reset.position.x, 'BJT reset RTS resistor should bridge the two transistor stages');
    assert.ok(boot0.position.y > boot.position.y, 'BJT reset BOOT resistor should sit below boot transistor');
    assertPinLeftOf(diode, 'rst', 'rst_pull', module.module_id);
    assertPinAbove(pullup, 'vdd', 'rst_pull', module.module_id);
    assertPinLeftOf(dtr, 'dtr_drive', 'dtr', module.module_id);
    assertPinLeftOf(rts, 'rts_drive', 'rts', module.module_id);
    assertPinAbove(boot0, 'boot_node', 'boot0', module.module_id);
    assertNoComponentOverlap(module, ['q_boot', 'q_rst', 'd_rst', 'r50', 'r51', 'r49', 'r52']);
  }
  if (module.module_id === 'mos_common_source') {
    const transistor = mustComponent(module, 'm1');
    assertActivePins(transistor, module.module_id);
  }
  if (module.module_id === 'mos_common_source_full') {
    const transistor = mustComponent(module, 'm1');
    const inputCoupling = mustComponent(module, 'cin');
    const gatePullup = mustComponent(module, 'rg1');
    const gatePulldown = mustComponent(module, 'rg2');
    const drainLoad = mustComponent(module, 'rd');
    const sourceResistor = mustComponent(module, 'rs');
    const sourceBypass = mustComponent(module, 'cs');
    const outputCoupling = mustComponent(module, 'cout');
    const outputLoad = mustComponent(module, 'rload');
    assertActivePins(transistor, module.module_id);
    assert.ok(inputCoupling.position.x < transistor.position.x, 'MOS input coupling should sit before the gate');
    assert.ok(outputCoupling.position.x > transistor.position.x, 'MOS output coupling should sit after the drain');
    assert.ok(outputLoad.position.x >= outputCoupling.position.x, 'MOS output load should sit on the output side');
    assert.ok(gatePullup.position.y < transistor.position.y, 'MOS gate pull-up should sit above the gate');
    assert.ok(gatePulldown.position.y > transistor.position.y, 'MOS gate pull-down should sit below the gate');
    assert.ok(drainLoad.position.y < transistor.position.y, 'MOS drain load should sit above the transistor');
    assert.ok(sourceResistor.position.y > transistor.position.y, 'MOS source resistor should sit below the transistor');
    assert.ok(sourceBypass.position.y > transistor.position.y, 'MOS source bypass should sit below the transistor');
    assertPinLeftOf(inputCoupling, 'in', 'gate', module.module_id);
    assertPinLeftOf(outputCoupling, 'drain', 'out', module.module_id);
    assertPinAbove(gatePullup, 'vdd', 'gate', module.module_id);
    assertPinAbove(gatePulldown, 'gate', '0', module.module_id);
    assertPinAbove(drainLoad, 'vdd', 'drain', module.module_id);
    assertPinAbove(sourceResistor, 'source', '0', module.module_id);
    assertPinAbove(sourceBypass, 'source', '0', module.module_id);
    assertPinAbove(outputLoad, 'out', '0', module.module_id);
    assertNoComponentOverlap(module, ['cin', 'rg1', 'rg2', 'm1', 'rd', 'rs', 'cs', 'cout', 'rload']);
  }
  if (module.module_id === 'cmos_inverter') {
    const pmos = mustComponent(module, 'mp1');
    const nmos = mustComponent(module, 'mn1');
    const load = mustComponent(module, 'cload');
    assertActivePins(pmos, module.module_id);
    assertActivePins(nmos, module.module_id);
    assert.ok(pmos.position.y < nmos.position.y, 'CMOS inverter PMOS should sit above NMOS');
    assert.ok(Math.abs(pmos.position.x - nmos.position.x) <= 1, 'CMOS inverter devices should share the output column');
    assert.ok(load.position.x > nmos.position.x, 'CMOS inverter output load should sit on the right side');
    assertPinAbove(pmos, 'vdd', 'out', module.module_id);
    assertPinAbove(nmos, 'out', '0', module.module_id);
    assertPinAbove(load, 'out', '0', module.module_id);
    assertNoComponentOverlap(module, ['mp1', 'mn1', 'cload']);
  }
  if (module.module_id === 'mos_differential_pair') {
    const left = mustComponent(module, 'm_inp');
    const right = mustComponent(module, 'm_inn');
    const leftLoad = mustComponent(module, 'rdp');
    const rightLoad = mustComponent(module, 'rdn');
    const tail = mustComponent(module, 'itail');
    assertActivePins(left, module.module_id);
    assertActivePins(right, module.module_id);
    assert.ok(left.position.x < right.position.x, 'differential pair positive input device should sit left of negative input device');
    assert.ok(Math.abs(left.position.y - right.position.y) <= 1, 'differential pair devices should align horizontally');
    assert.ok(leftLoad.position.y < left.position.y, 'differential pair left drain load should sit above the device');
    assert.ok(rightLoad.position.y < right.position.y, 'differential pair right drain load should sit above the device');
    assert.ok(tail.position.y > left.position.y && tail.position.y > right.position.y, 'differential pair tail source should sit below both devices');
    assertPinAbove(leftLoad, 'vdd', 'outp', module.module_id);
    assertPinAbove(rightLoad, 'vdd', 'outn', module.module_id);
    assertPinAbove(tail, 'tail', '0', module.module_id);
    assertNoComponentOverlap(module, ['m_inp', 'm_inn', 'rdp', 'rdn', 'itail']);
  }
  if (module.module_id === 'mos_ldo') {
    const leftInput = mustComponent(module, 'm1');
    const rightInput = mustComponent(module, 'm2');
    const leftLoad = mustComponent(module, 'm3');
    const rightLoad = mustComponent(module, 'm4');
    const pass = mustComponent(module, 'mp');
    const topDivider = mustComponent(module, 'rtop');
    const bottomDivider = mustComponent(module, 'rbot');
    const outputLoad = mustComponent(module, 'rload');
    const outputCap = mustComponent(module, 'cout');
    assertActivePins(leftInput, module.module_id);
    assertActivePins(rightInput, module.module_id);
    assertActivePins(leftLoad, module.module_id);
    assertActivePins(rightLoad, module.module_id);
    assertActivePins(pass, module.module_id);
    assert.ok(leftLoad.position.y < leftInput.position.y, 'LDO PMOS mirror load should sit above left input device');
    assert.ok(rightLoad.position.y < rightInput.position.y, 'LDO PMOS mirror load should sit above right input device');
    assert.ok(leftInput.position.x < rightInput.position.x, 'LDO error amplifier input devices should be separated left-to-right');
    assert.ok(leftLoad.position.x < rightLoad.position.x, 'LDO PMOS mirror devices should be separated left-to-right');
    assert.ok(pass.position.x > rightLoad.position.x && pass.position.x > rightInput.position.x, 'LDO pass MOSFET should sit to the right of the error amplifier');
    assert.ok(topDivider.position.x > pass.position.x, 'LDO feedback divider should sit on the output side');
    assert.ok(outputLoad.position.x > pass.position.x, 'LDO output load should sit on the output side');
    assert.ok(outputCap.position.x > pass.position.x, 'LDO output capacitor should sit on the output side');
    assert.ok(Math.abs(topDivider.position.x - bottomDivider.position.x) <= 1, 'LDO feedback divider resistors should align vertically');
    assert.ok(topDivider.position.y < bottomDivider.position.y, 'LDO top feedback resistor should sit above bottom feedback resistor');
    assertPinAbove(topDivider, 'vout', 'fb', module.module_id);
    assertPinAbove(bottomDivider, 'fb', '0', module.module_id);
    assertPinAbove(outputLoad, 'vout', '0', module.module_id);
    assertPinAbove(outputCap, 'vout', '0', module.module_id);
    assertNoComponentOverlap(module, ['m1', 'm2', 'm3', 'm4', 'mp', 'vin', 'vref', 'itail', 'rtop', 'rbot', 'rload', 'cout']);
  }
  if (module.module_id === 'current_mirror') {
    const reference = mustComponent(module, 'm_ref');
    const output = mustComponent(module, 'm_out');
    assertActivePins(reference, module.module_id);
    assertActivePins(output, module.module_id);
    assert.ok(reference.position.x < output.position.x, 'current mirror reference device should be left of output device');
  }
}

function assertReadablePortPlacement(document: ReturnType<typeof createSchematicDocument>) {
  const { module, portPositions } = document;
  if (module.module_id === 'mos_ldo') {
    const outputPort = mustPortPosition(portPositions, 'vout');
    assert.ok(document.viewBox.maxX - outputPort.x >= 110, 'LDO VOUT port should leave room for the right-side symbol and label');
  }
  if (module.module_id === 'mos_differential_pair') {
    const rightDevice = mustComponent(module, 'm_inn');
    const outpPort = mustPortPosition(portPositions, 'outp');
    const outnPort = mustPortPosition(portPositions, 'outn');
    const rightEdge = boundsForComponent(rightDevice).maxX;

    assert.ok(outpPort.x > rightEdge, 'differential pair OUT+ should sit outside the right edge');
    assert.ok(outnPort.x > rightEdge, 'differential pair OUT- should sit outside the right edge');
    assert.ok(Math.abs(outpPort.y - outnPort.y) >= 60, 'differential pair output ports should be vertically separated');
    return;
  }
  if (module.module_id !== 'bjt_reset_network') return;

  const resetDiode = mustComponent(module, 'd_rst');
  const dtrResistor = mustComponent(module, 'r51');
  const boot0Resistor = mustComponent(module, 'r52');
  const rstPort = mustPortPosition(portPositions, 'rst');
  const dtrPort = mustPortPosition(portPositions, 'dtr');
  const rtsPort = mustPortPosition(portPositions, 'rts');
  const boot0Port = mustPortPosition(portPositions, 'boot0');

  assert.ok(rstPort.x < pinPointForNet(resetDiode, 'rst').x, 'BJT reset RST input should stay outside the left edge');
  assert.ok(dtrPort.x > pinPointForNet(dtrResistor, 'dtr').x, 'BJT reset DTR input should sit outside R51 on the right edge');
  assert.ok(rtsPort.x > pinPointForNet(mustComponent(module, 'q_rst'), 'rts').x, 'BJT reset RTS output should sit on the right edge');
  const boot0Pin = pinPointForNet(boot0Resistor, 'boot0');
  assert.ok(boot0Port.x > boot0Pin.x, 'BJT reset BOOT0 output should sit outside R52');
  assert.ok(boot0Port.x - boot0Pin.x <= 140, 'BJT reset BOOT0 output should stay near the local BOOT0 branch');
}

function assertRailLabels(module: CircuitModule, netLabels: ReturnType<typeof createSchematicDocument>['netLabels'], wires: ReturnType<typeof createSchematicDocument>['wires']) {
  const railNets = new Set(
    module.ports
      .filter((port) => port.signal_type === 'power' || isGroundPort(port))
      .map((port) => port.net),
  );
  const railPins = module.components.flatMap((component) => (
    component.pins
      .filter((pin) => railNets.has(pin.net))
      .map((pin) => ({ component, pin }))
  ));
  if (railPins.length === 0) return;

  assert.ok(netLabels.length > 0, `${module.module_id} should expose local rail labels`);
  for (const wire of wires) {
    assert.ok(!railNets.has(wire.net ?? ''), `${module.module_id}.${wire.id} should not render a generated rail bus for ${wire.net}`);
  }
}

function assertNoMosBodyRailLabels(module: CircuitModule, netLabels: ReturnType<typeof createSchematicDocument>['netLabels']) {
  const bodyPinKeys = new Set(
    module.components
      .filter((component) => component.type === 'M')
      .flatMap((component) => component.pins
        .filter((pin) => /body|bulk|\bb\b/i.test(`${pin.id} ${pin.name}`))
        .map((pin) => `${component.id}:${pin.id}`)),
  );
  for (const label of netLabels) {
    const componentId = label.endpoint.component_id;
    const pinId = label.endpoint.pin_id;
    if (!componentId || !pinId) continue;
    assert.equal(
      bodyPinKeys.has(`${componentId}:${pinId}`),
      false,
      `${module.module_id}.${componentId}.${pinId} should not render a MOS body rail label`,
    );
  }
}

function assertLdoInternalLabels(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'mos_ldo') return;
  const localNets = new Set(['fb', 'tail', 'eaout', 'vref']);
  const moduleNets = new Set(document.module.components.flatMap((component) => component.pins.map((pin) => pin.net)));
  const signalLabelNets = new Set(
    document.netLabels
      .filter((label) => label.kind === 'signal')
      .map((label) => label.net),
  );
  for (const net of localNets) {
    if (!moduleNets.has(net)) continue;
    assert.equal(signalLabelNets.has(net), true, `mos_ldo should render ${net} as local labels`);
    assert.equal(
      document.wires.some((wire) => wire.net === net),
      false,
      `mos_ldo should not render ${net} as a generated long wire`,
    );
  }
}

function mustComponent(module: CircuitModule, id: string): CircuitComponent {
  const component = module.components.find((entry) => entry.id === id);
  assert.ok(component, `${module.module_id}.${id} missing`);
  return component;
}

function mustPortPosition(portPositions: ReturnType<typeof createSchematicDocument>['portPositions'], id: string) {
  const position = portPositions.get(id);
  assert.ok(position, `port ${id} missing`);
  return position;
}

function assertPinLeftOf(component: CircuitComponent, leftNet: string, rightNet: string, label: string) {
  const left = pinPointForNet(component, leftNet);
  const right = pinPointForNet(component, rightNet);
  assert.ok(left.x < right.x, `${label}.${component.id} should route ${leftNet} left of ${rightNet}`);
}

function assertPinAbove(component: CircuitComponent, topNet: string, bottomNet: string, label: string) {
  const top = pinPointForNet(component, topNet);
  const bottom = pinPointForNet(component, bottomNet);
  assert.ok(top.y < bottom.y, `${label}.${component.id} should route ${topNet} above ${bottomNet}`);
}

function assertActivePins(component: CircuitComponent, label: string) {
  const gate = pinPointByName(component, /gate|base|\bg\b|\bb\b/);
  const drain = pinPointByName(component, /drain|collector|\bd\b|\bc\b/);
  const source = pinPointByName(component, /source|emitter|\bs\b|\be\b/);
  assert.ok(gate.x < drain.x, `${label}.${component.id} gate/base should be left of drain/collector`);
  assert.ok(gate.x < source.x, `${label}.${component.id} gate/base should be left of source/emitter`);
  if (component.type === 'M' && isPmosComponent(component)) {
    assert.ok(source.y < drain.y, `${label}.${component.id} PMOS source should be above drain`);
  } else {
    assert.ok(drain.y < source.y, `${label}.${component.id} drain/collector should be above source/emitter`);
  }
}

function assertNoComponentOverlap(module: CircuitModule, componentIds: string[]) {
  const components = componentIds.map((id) => mustComponent(module, id));
  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const left = components[leftIndex];
      const right = components[rightIndex];
      assert.ok(left && right);
      const leftBounds = boundsForComponent(left);
      const rightBounds = boundsForComponent(right);
      assert.ok(
        leftBounds.maxX < rightBounds.minX ||
          rightBounds.maxX < leftBounds.minX ||
          leftBounds.maxY < rightBounds.minY ||
          rightBounds.maxY < leftBounds.minY,
        `${module.module_id}.${left.id} overlaps ${right.id}`,
      );
    }
  }
}

function boundsForComponent(component: CircuitComponent) {
  const points = component.pins.map((pin, index) => pinWorld(component, pin, index));
  const xs = [component.position.x - 58, component.position.x + 58, ...points.map((point) => point.x)];
  const ys = [component.position.y - 58, component.position.y + 58, ...points.map((point) => point.y)];
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function pinPointForNet(component: CircuitComponent, net: string) {
  const index = component.pins.findIndex((pin) => pin.net === net);
  assert.notEqual(index, -1, `${component.id}.${net} pin missing`);
  const pin = component.pins[index];
  assert.ok(pin);
  return pinWorld(component, pin, index);
}

function pinPointByName(component: CircuitComponent, pattern: RegExp) {
  const index = component.pins.findIndex((pin) => pattern.test(`${pin.id} ${pin.name}`.toLowerCase()));
  assert.notEqual(index, -1, `${component.id}.${pattern.source} pin missing`);
  const pin = component.pins[index];
  assert.ok(pin);
  return pinWorld(component, pin, index);
}

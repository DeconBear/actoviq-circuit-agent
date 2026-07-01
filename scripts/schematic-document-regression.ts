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
  moduleFixture('mos_ldo', [
    component('m_pass', 'M', 'PMOS W=40u L=1u', 220, 150, [
      ['d', 'D', 'out'],
      ['g', 'G', 'ctrl'],
      ['s', 'S', 'vdd'],
      ['b', 'B', 'vdd'],
    ]),
    component('r_load', 'R', '1k', 360, 250, [['a', '1', 'out'], ['b', '2', '0']]),
    component('c_out', 'C', '22u', 500, 250, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
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
  if (module.module_id === 'mos_ldo') {
    const pass = mustComponent(module, 'm_pass');
    assertActivePins(pass, module.module_id);
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
  if (module.module_id !== 'bjt_reset_network') return;

  const resetDiode = mustComponent(module, 'd_rst');
  const dtrResistor = mustComponent(module, 'r51');
  const rstPort = mustPortPosition(portPositions, 'rst');
  const dtrPort = mustPortPosition(portPositions, 'dtr');
  const rtsPort = mustPortPosition(portPositions, 'rts');
  const boot0Port = mustPortPosition(portPositions, 'boot0');

  assert.ok(rstPort.x < pinPointForNet(resetDiode, 'rst').x, 'BJT reset RST input should stay outside the left edge');
  assert.ok(dtrPort.x > pinPointForNet(dtrResistor, 'dtr').x, 'BJT reset DTR input should sit outside R51 on the right edge');
  assert.ok(rtsPort.x > pinPointForNet(mustComponent(module, 'q_rst'), 'rts').x, 'BJT reset RTS output should sit on the right edge');
  assert.ok(boot0Port.x > pinPointForNet(mustComponent(module, 'r52'), 'boot0').x, 'BJT reset BOOT0 output should sit outside R52');
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

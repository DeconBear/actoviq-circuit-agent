import assert from 'node:assert/strict';
import type { CircuitComponent, CircuitModule, CircuitPort } from '../renderer/src/types';
import {
  createSchematicDocument,
  endpointWorldPosition,
  pinWorld,
} from '../renderer/src/schematic/schematicDocument';

const ports: CircuitPort[] = [
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
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

function moduleFixture(moduleId: string, components: CircuitComponent[]): CircuitModule {
  return {
    schema: 'actoviq.module.v1',
    module_id: moduleId,
    name: moduleId,
    revision: 0,
    ports,
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
  moduleFixture('diode_rectifier', [
    component('d1', 'D', 'D', 120, 120, [['a', 'A', 'in'], ['b', 'K', 'out']]),
    component('c1', 'C', '10u', 270, 220, [['a', '1', 'out'], ['b', '2', '0']]),
    component('r1', 'R', '10k', 420, 220, [['a', '1', 'out'], ['b', '2', '0']]),
  ]),
  moduleFixture('bjt_common_emitter', [
    component('q1', 'Q', 'NPN', 220, 180, [['c', 'C', 'out'], ['b', 'B', 'in'], ['e', 'E', '0']]),
    component('rc', 'R', '4.7k', 220, 60, [['a', '1', 'vdd'], ['b', '2', 'out']]),
    component('re', 'R', '1k', 220, 310, [['a', '1', '0'], ['b', '2', '0']]),
  ]),
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
}

console.log(JSON.stringify({
  ok: true,
  fixtureCount: fixtures.length,
  fixtures: fixtures.map((fixture) => fixture.module_id),
}, null, 2));

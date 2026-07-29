import assert from 'node:assert/strict';

import {
  createSchematicDocument,
  hitEndpoint,
  pinWorld,
} from '../renderer/src/schematic/schematicDocument';
import type { CircuitComponent, CircuitModule, CircuitWire } from '../renderer/src/types';

function component(id: string, x: number, y: number): CircuitComponent {
  return {
    id,
    type: 'R',
    name: id.toUpperCase(),
    value: '1k',
    position: { x, y },
    rotation: 0,
    pins: [
      { id: 'a', name: '1', net: 'in', net_id: 'net_in' },
      { id: 'b', name: '2', net: 'out', net_id: 'net_out' },
    ],
  };
}

function wire(
  id: string,
  points: CircuitWire['points'],
  net: string,
  netId: string,
): CircuitWire {
  return {
    id,
    points,
    from: { ...points[0]!, junction_id: `${id}_from` },
    to: { ...points.at(-1)!, junction_id: `${id}_to` },
    net,
    net_id: netId,
    source: 'stored',
  };
}

function moduleFixture(
  components: CircuitComponent[] = [],
  wires: CircuitWire[] = [],
): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: 'snap',
    name: 'Snap',
    revision: 0,
    domain: 'analog',
    nets: [
      { id: 'net_in', name: 'in', kind: 'analog', aliases: [] },
      { id: 'net_out', name: 'out', kind: 'analog', aliases: [] },
    ],
    ports: [],
    components,
    wires,
    annotations: [],
  };
}

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}

check('pin wins over a coincident wire segment and preserves net_id', () => {
  const r1 = component('r1', 100, 100);
  const pin = pinWorld(r1, r1.pins[0]!, 0);
  const document = createSchematicDocument(moduleFixture(
    [r1],
    [wire('under-pin', [
      { x: pin.x - 40, y: pin.y },
      { x: pin.x + 40, y: pin.y },
    ], 'out', 'net_out')],
  ), { autoLayout: false });
  const hit = hitEndpoint(document, pin);
  assert.equal(hit?.kind, 'pin');
  assert.equal(hit?.component_id, 'r1');
  assert.equal(hit?.pin_id, 'a');
  assert.equal(hit?.net_id, 'net_in');
});

check('wire segment snap exposes the nearest point and stable net identity', () => {
  const document = createSchematicDocument(moduleFixture([], [
    wire('segment', [{ x: 0, y: 0 }, { x: 120, y: 0 }], 'in', 'net_in'),
  ]), { autoLayout: false });
  const hit = hitEndpoint(document, { x: 57, y: 3 });
  assert.equal(hit?.kind, 'point');
  assert.equal(hit?.wire_id, 'segment');
  assert.equal(hit?.net_id, 'net_in');
  assert.deepEqual({ x: hit?.x, y: hit?.y }, { x: 60, y: 0 });
});

check('different nets crossing geometrically do not create a snap connection', () => {
  const document = createSchematicDocument(moduleFixture([], [
    wire('horizontal', [{ x: 0, y: 40 }, { x: 80, y: 40 }], 'in', 'net_in'),
    wire('vertical', [{ x: 40, y: 0 }, { x: 40, y: 80 }], 'out', 'net_out'),
  ]), { autoLayout: false });
  assert.equal(hitEndpoint(document, { x: 40, y: 40 }), null);
});

check('explicit junction endpoint wins over a nearby segment', () => {
  const horizontal = wire(
    'horizontal',
    [{ x: 0, y: 40 }, { x: 40, y: 40 }],
    'in',
    'net_in',
  );
  horizontal.to = { x: 40, y: 40, junction_id: 'j_explicit' };
  const document = createSchematicDocument(moduleFixture([], [
    horizontal,
    wire('vertical', [{ x: 40, y: 40 }, { x: 40, y: 80 }], 'in', 'net_in'),
  ]), { autoLayout: false });
  const hit = hitEndpoint(document, { x: 42, y: 41 });
  assert.equal(hit?.kind, 'junction');
  assert.equal(hit?.junction_id, 'j_explicit');
});

console.log(JSON.stringify({
  ok: failed === 0,
  passed,
  failed,
  total: passed + failed,
}, null, 2));
if (failed > 0) process.exit(1);

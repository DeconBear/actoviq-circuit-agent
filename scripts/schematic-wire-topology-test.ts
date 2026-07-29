import assert from 'node:assert/strict';

import {
  collapseWireTopology,
  cutWireTopology,
  joinWireTopology,
  splitWireTopology,
  trimWireTopology,
} from '../renderer/src/schematic-core/connectivity/wireTopology';
import type { CircuitComponent, CircuitModule, CircuitWire } from '../renderer/src/types';

function resistor(id: string, x: number): CircuitComponent {
  return {
    id,
    type: 'R',
    name: id.toUpperCase(),
    value: '1k',
    position: { x, y: 0 },
    rotation: 0,
    pins: [{ id: 'a', name: '1', net: 'in', net_id: 'net_in' }],
  };
}

function connectedWire(): CircuitWire {
  return {
    id: 'w1',
    points: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
    from: { x: 0, y: 0, component_id: 'left', pin_id: 'a' },
    to: { x: 200, y: 0, component_id: 'right', pin_id: 'a' },
    net: 'in',
    net_id: 'net_in',
    source: 'stored',
  };
}

function fixture(wires: CircuitWire[] = [connectedWire()]): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: 'wire-tools',
    name: 'Wire tools',
    revision: 0,
    domain: 'analog',
    nets: [{ id: 'net_in', name: 'in', kind: 'analog', aliases: [] }],
    ports: [],
    components: [resistor('left', 0), resistor('right', 200)],
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

check('split creates two identified segments and join restores the chain', () => {
  const source = fixture();
  const split = splitWireTopology(source, 'w1', { x: 100, y: 0 }, 'j_mid');
  assert.equal(split.module.wires.length, 2);
  assert.equal(split.module.wires[0]?.to?.junction_id, 'j_mid');
  assert.equal(split.module.wires[1]?.from?.junction_id, 'j_mid');
  const joined = joinWireTopology(
    split.module,
    split.module.wires.map((wire) => wire.id).reverse(),
  );
  assert.equal(joined.module.wires.length, 1);
  assert.deepEqual(joined.module.wires[0]?.points, source.wires[0]?.points);
  assert.deepEqual(joined.module.wires[0]?.from, source.wires[0]?.from);
  assert.deepEqual(joined.module.wires[0]?.to, source.wires[0]?.to);
  assert.deepEqual(source, fixture(), 'source must remain immutable');
});

check('cut creates distinct dangling endpoints and a new right-side net', () => {
  const source = fixture();
  const cut = cutWireTopology(source, 'w1', { x: 100, y: 0 });
  assert.equal(cut.module.wires.length, 2);
  const left = cut.module.wires.find((wire) => wire.id === 'w1')!;
  const right = cut.module.wires.find((wire) => wire.id !== 'w1')!;
  assert.notEqual(left.to?.junction_id, right.from?.junction_id);
  assert.notEqual(left.net_id, right.net_id);
  assert.equal(cut.module.components.find((item) => item.id === 'left')?.pins[0]?.net_id, 'net_in');
  assert.equal(
    cut.module.components.find((item) => item.id === 'right')?.pins[0]?.net_id,
    cut.createdNetId,
  );
  assert.notDeepEqual(cut.module.wires[0]?.to, cut.module.wires[1]?.from);
  assert.ok((cut.module.wires[0]?.to?.x ?? 0) < (cut.module.wires[1]?.from?.x ?? 0));
  assert.ok(cut.module.nets?.some((net) => net.id === cut.createdNetId));
  assert.deepEqual(source, fixture(), 'cut must not mutate source');
});

check('trim shortens only a dangling end', () => {
  const dangling: CircuitWire = {
    id: 'stub',
    points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }],
    from: { x: 0, y: 0, junction_id: 'j_dangling' },
    to: { x: 80, y: 80, component_id: 'right', pin_id: 'a' },
    net: 'in',
    net_id: 'net_in',
    source: 'stored',
  };
  const result = trimWireTopology(fixture([dangling]), 'stub', { x: 40, y: 0 });
  assert.deepEqual(result.module.wires[0]?.points[0], { x: 40, y: 0 });
  assert.match(result.module.wires[0]?.from?.junction_id ?? '', /^j_trim_/);
  assert.equal(result.module.wires[0]?.to?.component_id, 'right');
});

check('trim rejects a wire whose two ends are connected entities', () => {
  assert.throws(
    () => trimWireTopology(fixture(), 'w1', { x: 100, y: 0 }),
    /no dangling end/,
  );
});

check('collapse removes duplicate and collinear route points', () => {
  const noisy = connectedWire();
  noisy.points = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 0 },
    { x: 120, y: 0 },
    { x: 200, y: 0 },
  ];
  const result = collapseWireTopology(fixture([noisy]), 'w1');
  assert.deepEqual(result.module.wires[0]?.points, [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ]);
});

check('join rejects removing a junction that still has an unselected branch', () => {
  const split = splitWireTopology(fixture(), 'w1', { x: 100, y: 0 }, 'j_mid').module;
  split.wires.push({
    id: 'branch',
    points: [{ x: 100, y: 0 }, { x: 100, y: 80 }],
    from: { x: 100, y: 0, junction_id: 'j_mid' },
    to: { x: 100, y: 80, junction_id: 'j_branch_end' },
    net: 'in',
    net_id: 'net_in',
    source: 'stored',
  });
  assert.throws(
    () => joinWireTopology(split, split.wires.slice(0, 2).map((wire) => wire.id)),
    /unselected branch/,
  );
});

console.log(JSON.stringify({
  ok: failed === 0,
  passed,
  failed,
  total: passed + failed,
}, null, 2));
if (failed > 0) process.exit(1);

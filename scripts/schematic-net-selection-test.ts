import assert from 'node:assert/strict';
import type { CircuitWire } from '../renderer/src/types';
import {
  branchWireIds,
  netWireIds,
  wireSelectionScope,
} from '../renderer/src/schematic-core/selection/netSelection';

const wire = (
  id: string,
  fromJunction: string,
  toJunction: string,
  net = 'signal',
  netId = 'net_signal',
): CircuitWire => ({
  id,
  points: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
  from: { x: 0, y: 0, junction_id: fromJunction },
  to: { x: 40, y: 0, junction_id: toJunction },
  net,
  net_id: netId,
  source: 'stored',
});

const wires = [
  wire('left', 'j_left', 'j_center'),
  wire('right_a', 'j_center', 'j_a'),
  wire('right_b', 'j_center', 'j_b'),
  wire('tail', 'j_a', 'j_tail'),
  wire('crossing_other_net', 'j_other_1', 'j_other_2', 'other', 'net_other'),
];

assert.deepEqual(branchWireIds(wires, 'left'), ['left']);
assert.deepEqual(branchWireIds(wires, 'right_a'), ['right_a', 'tail']);
assert.deepEqual(
  netWireIds(wires, 'left'),
  ['left', 'right_a', 'right_b', 'tail'],
);
assert.equal(wireSelectionScope(wires, ['right_a', 'tail']), 'branch');
assert.equal(
  wireSelectionScope(wires, ['left', 'right_a', 'right_b', 'tail']),
  'net',
);
assert.equal(wireSelectionScope(wires, ['left', 'tail']), 'item');
assert.deepEqual(
  branchWireIds([
    wire('horizontal', 'j_h1', 'j_h2'),
    wire('vertical', 'j_v1', 'j_v2', 'other', 'net_other'),
  ], 'horizontal'),
  ['horizontal'],
  'geometric crossings from different nets must not join a branch selection',
);

console.log(JSON.stringify({ ok: true, passed: 7, failed: 0, total: 7 }, null, 2));

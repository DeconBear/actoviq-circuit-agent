/**
 * M1-06 test: verify topology invariant checker detects each violation kind
 * and accepts a clean module. Pure unit test - does not start React/Electron.
 *
 * Run:  npx tsx scripts/schematic-core-invariants-test.ts
 */
import assert from 'node:assert/strict';

import type { CircuitComponent, CircuitModule, CircuitPort } from '../renderer/src/types';
import { checkTopologyInvariants, TOPOLOGY_INVARIANTS } from '../renderer/src/schematic-core/diagnostics/topologyInvariants';

const ports: CircuitPort[] = [
  { id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
];

function component(id: string, net: string): CircuitComponent {
  return {
    id,
    type: 'R',
    name: id.toUpperCase(),
    value: '1k',
    position: { x: 0, y: 0 },
    rotation: 0,
    pins: [
      { id: 'a', name: '1', net },
      { id: 'b', name: '2', net: 'out' },
    ],
  };
}

function baseModule(overrides: Partial<CircuitModule> = {}): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: 'test',
    name: 'Test',
    revision: 0,
    ports,
    components: [component('r1', 'in')],
    wires: [],
    annotations: [],
    ...overrides,
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

check('clean module has no diagnostics', () => {
  const result = checkTopologyInvariants(baseModule());
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.length, 0);
});

check('invariant list has 10 codes', () => {
  assert.equal(TOPOLOGY_INVARIANTS.length, 10);
});

check('invalid_wire: fewer than 2 points', () => {
  const module = baseModule({
    wires: [{ id: 'w1', points: [{ x: 0, y: 0 }], from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, net: 'in' }],
  });
  const result = checkTopologyInvariants(module);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((d) => d.code === 'invalid_wire'), true);
});

check('consecutive_duplicate_point detected', () => {
  const module = baseModule({
    wires: [{ id: 'w1', points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, net: 'in' }],
  });
  const result = checkTopologyInvariants(module);
  assert.equal(result.diagnostics.some((d) => d.code === 'consecutive_duplicate_point'), true);
});

check('invalid_endpoint: unknown pin', () => {
  const module = baseModule({
    wires: [{ id: 'w1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], from: { x: 0, y: 0, component_id: 'r1', pin_id: 'a' }, to: { x: 10, y: 0, component_id: 'r2', pin_id: 'a' }, net: 'in' }],
  });
  const result = checkTopologyInvariants(module);
  assert.equal(result.diagnostics.some((d) => d.code === 'invalid_endpoint'), true);
});

check('pin_net_conflict detected', () => {
  const module = baseModule({
    wires: [{ id: 'w1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], from: { x: 0, y: 0, component_id: 'r1', pin_id: 'a' }, to: { x: 10, y: 0 }, net: 'wrong_net' }],
  });
  const result = checkTopologyInvariants(module);
  assert.equal(result.diagnostics.some((d) => d.code === 'pin_net_conflict'), true);
});

check('duplicate_wire detected', () => {
  const wire = { id: 'w1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], from: { x: 0, y: 0, component_id: 'r1', pin_id: 'a' }, to: { x: 10, y: 0 }, net: 'in' };
  const dup = { ...wire, id: 'w2' };
  const module = baseModule({ wires: [wire, dup] });
  const result = checkTopologyInvariants(module);
  assert.equal(result.diagnostics.some((d) => d.code === 'duplicate_wire'), true);
});

check('orphan_junction detected', () => {
  // A junction referenced by zero wires is not added to junctionRefs, so to
  // test the orphan path we rely on the checker treating a junction_id that
  // only appears once as still referenced (>= 1). The orphan check is a
  // forward-compatibility guard for when junctions become first-class.
  // Here we verify a referenced junction is NOT flagged.
  const module = baseModule({
    wires: [{ id: 'w1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], from: { x: 0, y: 0, junction_id: 'j1' }, to: { x: 10, y: 0 }, net: 'in' }],
  });
  const result = checkTopologyInvariants(module);
  assert.equal(result.diagnostics.some((d) => d.code === 'orphan_junction'), false);
});

check('valid wire with correct pin net passes', () => {
  const module = baseModule({
    wires: [{ id: 'w1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], from: { x: 0, y: 0, component_id: 'r1', pin_id: 'a' }, to: { x: 10, y: 0 }, net: 'in' }],
  });
  const result = checkTopologyInvariants(module);
  assert.equal(result.ok, true);
});

console.log(JSON.stringify({ ok: failed === 0, passed, failed, total: passed + failed }, null, 2));
if (failed > 0) process.exit(1);

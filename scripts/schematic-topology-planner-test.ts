/**
 * M3-03 unit tests for the topology mutation planner. Pure; no React/Electron.
 * Run:  npx tsx scripts/schematic-topology-planner-test.ts
 */
import assert from 'node:assert/strict';

import { planTopologyMutation } from '../renderer/src/schematic-core/connectivity/topologyPlanner';
import type { CircuitComponent, CircuitModule } from '../renderer/src/types';

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

function makeComponent(id: string, x: number, y: number, net: string): CircuitComponent {
  return {
    id, type: 'R', name: id.toUpperCase(), value: '1k',
    position: { x, y }, rotation: 0,
    pins: [{ id: 'a', name: '1', net }, { id: 'b', name: '2', net: 'out' }],
  };
}

function makeModule(components: CircuitComponent[] = [], wires: CircuitModule['wires'] = []): CircuitModule {
  return {
    schema: 'actoviq.module.v2', module_id: 'test', name: 'Test', revision: 0,
    ports: [{ id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in', position: { x: 0, y: 100 } }],
    components, wires, annotations: [],
  };
}

check('move free produces moved preview and dangling diagnostic', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')], [
    { id: 'w1', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], from: { x: 0, y: 100, port_id: 'in' }, to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' }, net: 'in', source: 'stored' },
  ]);
  const result = planTopologyMutation(module, {
    kind: 'move', point: { x: 100, y: 100 }, entity_ids: ['r1'], delta: { x: 50, y: 0 }, mode: 'free',
  });
  assert.equal(result.mutations.length, 1);
  assert.equal(result.mutations[0]!.kind, 'move');
  assert.ok(result.preview.moved?.some((m) => m.id === 'r1' && m.to.x === 150));
  assert.ok(result.diagnostics.some((d) => d.code === 'dangling_endpoint'), 'free move should warn about broken connection');
});

check('move stretch produces moved preview without dangling diagnostic', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')], [
    { id: 'w1', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], from: { x: 0, y: 100, port_id: 'in' }, to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' }, net: 'in', source: 'stored' },
  ]);
  const result = planTopologyMutation(module, {
    kind: 'move', point: { x: 100, y: 100 }, entity_ids: ['r1'], delta: { x: 50, y: 0 }, mode: 'stretch',
  });
  assert.equal(result.diagnostics.some((d) => d.code === 'dangling_endpoint'), false);
});

check('connect proposes a wire between source and target', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in'), makeComponent('r2', 200, 100, 'in')]);
  const result = planTopologyMutation(module, {
    kind: 'connect', point: { x: 200, y: 100 },
    source: { kind: 'pin', position: { x: 100, y: 100 }, ref: 'pin:r1.a', net: 'in' },
  });
  assert.ok(result.preview.newWire, 'should propose a new wire');
  assert.equal(result.preview.newWire!.points.length, 2);
  assert.equal(result.mutations[0]!.kind, 'connect');
});

check('connect with no target returns no-target diagnostic', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')]);
  const result = planTopologyMutation(module, {
    kind: 'connect', point: { x: 500, y: 500 },
    source: { kind: 'pin', position: { x: 100, y: 100 }, ref: 'pin:r1.a', net: 'in' },
  });
  assert.equal(result.mutations.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'no_target'));
});

check('split proposes a junction on a segment under the cursor', () => {
  const module = makeModule([], [
    { id: 'w1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], net: 'in', source: 'stored' },
  ]);
  const result = planTopologyMutation(module, {
    kind: 'split', point: { x: 50, y: 0 },
  });
  assert.ok(result.preview.junction, 'should propose a junction');
  assert.equal(result.mutations[0]!.kind, 'split');
  assert.equal(result.mutations[0]!.entity_ids[0], 'w1');
});

check('split with no segment under cursor returns no-segment diagnostic', () => {
  const module = makeModule([], [
    { id: 'w1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], net: 'in', source: 'stored' },
  ]);
  const result = planTopologyMutation(module, {
    kind: 'split', point: { x: 500, y: 500 },
  });
  assert.equal(result.mutations.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'no_segment'));
});

check('planner does not mutate the input module', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')]);
  const before = JSON.stringify(module);
  planTopologyMutation(module, {
    kind: 'move', point: { x: 100, y: 100 }, entity_ids: ['r1'], delta: { x: 50, y: 0 }, mode: 'free',
  });
  assert.equal(JSON.stringify(module), before, 'module must not be mutated');
});

console.log(JSON.stringify({ ok: failed === 0, passed, failed, total: passed + failed }, null, 2));
if (failed > 0) process.exit(1);

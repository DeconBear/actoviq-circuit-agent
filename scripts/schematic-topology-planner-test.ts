/**
 * M3-03 unit tests for the topology mutation planner. Pure; no React/Electron.
 * Run:  npx tsx scripts/schematic-topology-planner-test.ts
 */
import assert from 'node:assert/strict';

import { commitMove, mutationToTransaction } from '../renderer/src/schematic-core/connectivity/topologyCommit';
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
    pins: [
      { id: 'a', name: '1', net, net_id: `net_${net}` },
      { id: 'b', name: '2', net: 'out', net_id: 'net_out' },
    ],
  };
}

function makeModule(components: CircuitComponent[] = [], wires: CircuitModule['wires'] = []): CircuitModule {
  return {
    schema: 'actoviq.module.v2', module_id: 'test', name: 'Test', revision: 0,
    nets: [
      { id: 'net_in', name: 'in', kind: 'analog', aliases: [] },
      { id: 'net_out', name: 'out', kind: 'analog', aliases: [] },
    ],
    ports: [{
      id: 'in',
      name: 'IN',
      direction: 'input',
      signal_type: 'analog',
      net: 'in',
      net_id: 'net_in',
      position: { x: 0, y: 100 },
    }],
    components, wires, annotations: [],
  };
}

check('move free produces moved preview and dangling diagnostic', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')], [
    { id: 'w1', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], from: { x: 0, y: 100, port_id: 'in' }, to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' }, net: 'in', net_id: 'net_in', source: 'stored' },
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
    { id: 'w1', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], from: { x: 0, y: 100, port_id: 'in' }, to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' }, net: 'in', net_id: 'net_in', source: 'stored' },
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
    source: {
      kind: 'pin',
      position: { x: 100, y: 100 },
      ref: 'pin:r1.a',
      net: 'in',
      net_id: 'net_in',
      endpoint: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' },
    },
  });
  assert.ok(result.preview.newWire, 'should propose a new wire');
  assert.equal(result.preview.newWire!.points.length, 2);
  assert.equal(result.mutations[0]!.kind, 'connect');
});

check('connect with no target returns no-target diagnostic', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')]);
  const result = planTopologyMutation(module, {
    kind: 'connect', point: { x: 500, y: 500 },
    source: {
      kind: 'pin',
      position: { x: 100, y: 100 },
      ref: 'pin:r1.a',
      net: 'in',
      net_id: 'net_in',
      endpoint: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' },
    },
  });
  assert.equal(result.mutations.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'no_target'));
});

check('planned connection becomes a deterministic create_wire transaction', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in'), makeComponent('r2', 200, 100, 'in')]);
  const planned = planTopologyMutation(module, {
    kind: 'connect',
    point: { x: 200, y: 100 },
    source: {
      kind: 'pin',
      position: { x: 100, y: 100 },
      ref: 'pin:r1.a',
      net: 'in',
      net_id: 'net_in',
      endpoint: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' },
    },
  });
  const transaction = mutationToTransaction(planned.mutations[0]!, {
    module_id: module.module_id,
    project_id: 'p1',
    actor: 'test',
    base_revision: 7,
    expected_module_revision: module.revision,
    command_id: 'connect-1',
  });
  assert.equal(transaction.base_revision, 7);
  assert.equal(transaction.expected_module_revision, 0);
  const operation = transaction.operations[0];
  assert.ok(operation?.op === 'create_wire');
  assert.equal(operation.wire_id, 'w_connect-1');
  assert.equal(operation.net_id, 'net_in');
  assert.equal(operation.from.component_id, 'r1');
  assert.equal(operation.to.component_id, 'r2');
});

check('commitMove applies explicit free semantics without mutating the source', () => {
  const module = makeModule([makeComponent('r1', 100, 100, 'in')], [
    { id: 'w1', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], from: { x: 0, y: 100, port_id: 'in' }, to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' }, net: 'in', net_id: 'net_in', source: 'stored' },
  ]);
  const before = structuredClone(module);
  const result = commitMove(module, {
    entity_ids: ['r1'],
    delta: { x: 40, y: 20 },
    mode: 'free',
  }, {
    module_id: module.module_id,
    project_id: 'p1',
    actor: 'test',
    command_id: 'move-free-1',
    base_revision: 12,
  });
  assert.deepEqual(module, before);
  assert.deepEqual(result.module.components[0]?.position, { x: 140, y: 120 });
  assert.equal(result.module.wires[0]?.to?.component_id, undefined);
  assert.match(result.module.wires[0]?.to?.junction_id ?? '', /^j_detached_/);
});

check('split proposes a junction on a segment under the cursor', () => {
  const module = makeModule([], [
    { id: 'w1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], from: { x: 0, y: 0, junction_id: 'j_left' }, to: { x: 100, y: 0, junction_id: 'j_right' }, net: 'in', net_id: 'net_in', source: 'stored' },
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
    { id: 'w1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], from: { x: 0, y: 0, junction_id: 'j_left' }, to: { x: 100, y: 0, junction_id: 'j_right' }, net: 'in', net_id: 'net_in', source: 'stored' },
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

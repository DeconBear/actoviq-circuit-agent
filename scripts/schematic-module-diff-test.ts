import assert from 'node:assert/strict';

import { applyTransaction } from '../renderer/src/schematic-core/commands/applyTransaction';
import { diffModuleToOperations } from '../renderer/src/schematic-core/commands/diffModule';
import type { CircuitModule } from '../renderer/src/types';

function moduleFixture(): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: 'filter',
    name: 'Filter',
    revision: 3,
    domain: 'analog',
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
    components: [{
      id: 'r1',
      type: 'R',
      name: 'R1',
      value: '1k',
      position: { x: 100, y: 100 },
      rotation: 0,
      pins: [
        { id: 'a', name: '1', net: 'in', net_id: 'net_in' },
        { id: 'b', name: '2', net: 'out', net_id: 'net_out' },
      ],
    }],
    wires: [{
      id: 'w1',
      points: [{ x: 0, y: 100 }, { x: 100, y: 100 }],
      from: { x: 0, y: 100, port_id: 'in' },
      to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' },
      net: 'in',
      net_id: 'net_in',
      source: 'stored',
    }],
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

check('component movement and property edit become granular operations', () => {
  const before = moduleFixture();
  const after = structuredClone(before);
  after.components[0]!.position = { x: 140, y: 120 };
  after.components[0]!.value = '2k';
  after.wires[0]!.points = [{ x: 0, y: 100 }, { x: 0, y: 120 }, { x: 140, y: 120 }];
  after.wires[0]!.to = { ...after.wires[0]!.to!, x: 140, y: 120 };
  const result = diffModuleToOperations(before, after);
  assert.deepEqual(result.unsupported, []);
  assert.ok(result.operations.some((operation) => operation.op === 'move_entities'));
  assert.ok(result.operations.some((operation) => operation.op === 'update_component'));
  assert.ok(result.operations.some((operation) => operation.op === 'edit_wire_path'));
  assert.equal(result.operations.some((operation) => operation.op === 'set_module_schematic'), false);
  const applied = applyTransaction(before, {
    schema: 'actoviq.command.v2',
    command_id: 'diff-round-trip',
    actor: 'test',
    project_id: 'p1',
    module_id: before.module_id,
    base_revision: 9,
    expected_module_revision: before.revision,
    operations: result.operations,
  });
  after.revision += 1;
  assert.deepEqual(applied.module, after);
});

check('new port, component, and wire use typed v2 operations', () => {
  const before = moduleFixture();
  const after = structuredClone(before);
  after.ports.push({
    id: 'out',
    name: 'OUT',
    direction: 'output',
    signal_type: 'analog',
    net: 'out',
    net_id: 'net_out',
  });
  after.components.push({
    id: 'c1',
    type: 'C',
    name: 'C1',
    value: '1n',
    position: { x: 220, y: 160 },
    rotation: 0,
    pins: [
      { id: 'a', name: '1', net: 'out', net_id: 'net_out' },
      { id: 'b', name: '2', net: '0', net_id: 'net_0' },
    ],
  });
  after.wires.push({
    id: 'w2',
    points: [{ x: 100, y: 140 }, { x: 220, y: 140 }],
    from: { x: 100, y: 140, junction_id: 'j1' },
    to: { x: 220, y: 140, component_id: 'c1', pin_id: 'a' },
    net: 'out',
    net_id: 'net_out',
    source: 'stored',
  });
  const result = diffModuleToOperations(before, after);
  assert.ok(result.operations.some((operation) => operation.op === 'upsert_port'));
  assert.ok(result.operations.some((operation) => operation.op === 'place_component'));
  const create = result.operations.find((operation) => operation.op === 'create_wire');
  assert.ok(create && create.net_id === 'net_out' && create.to.component_id === 'c1');
});

check('unsupported source fields are reported, not silently dropped', () => {
  const before = moduleFixture();
  const after = structuredClone(before);
  after.annotations = [{ text: 'changed' }];
  after.spice = { directives: ['.tran 1n 1u'] };
  const result = diffModuleToOperations(before, after);
  assert.deepEqual(result.unsupported.sort(), ['annotations', 'spice']);
});

check('module instance placement preserves pins and revision binding', () => {
  const before = moduleFixture();
  const after = structuredClone(before);
  after.components.push({
    id: 'amp1',
    type: 'MODULE',
    name: 'AMP1',
    value: 'amplifier',
    position: { x: 300, y: 200 },
    rotation: 0,
    pins: [{ id: 'out', name: 'OUT', net: 'out', net_id: 'net_out' }],
    module_ref: { module_id: 'amplifier', revision: 2 },
  });
  const result = diffModuleToOperations(before, after);
  const place = result.operations.find((operation) => operation.op === 'place_module_instance');
  assert.ok(place && place.pins[0]?.id === 'out' && place.module_ref.revision === 2);
});

check('component replacement recreates attached wires after cascading delete', () => {
  const before = moduleFixture();
  const after = structuredClone(before);
  after.components[0]!.pins.push({
    id: 'sense',
    name: 'SENSE',
    net: 'out',
    net_id: 'net_out',
  });
  const result = diffModuleToOperations(before, after);
  assert.deepEqual(
    result.operations.map((operation) => operation.op),
    ['delete_entities', 'place_component', 'delete_entities', 'create_wire'],
  );
  const applied = applyTransaction(before, {
    schema: 'actoviq.command.v2',
    command_id: 'replace-round-trip',
    actor: 'test',
    project_id: 'p1',
    module_id: before.module_id,
    base_revision: 9,
    expected_module_revision: before.revision,
    operations: result.operations,
  });
  after.revision += 1;
  assert.deepEqual(applied.module, after);
});

console.log(JSON.stringify({ ok: failed === 0, passed, failed, total: passed + failed }, null, 2));
if (failed > 0) process.exit(1);

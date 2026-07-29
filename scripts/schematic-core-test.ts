/**
 * M1-03 unit tests for the pure schematic-core API: applyTransaction reducer
 * and SelectionSet helpers. No React, no Electron.
 *
 * Run:  npx tsx scripts/schematic-core-test.ts
 */
import assert from 'node:assert/strict';

import type { CircuitComponent, CircuitModule, CircuitWire } from '../renderer/src/types';
import { applyTransaction, type Transaction } from '../renderer/src/schematic-core/commands/applyTransaction';
import {
  addToSelection,
  allSelectedIds,
  clearSelection,
  cloneSelection,
  emptySelection,
  selectionIsEmpty,
  selectionSize,
  toggleSelection,
} from '../renderer/src/schematic-core/selection/selectionSet';

function makeComponent(id: string): CircuitComponent {
  return {
    id,
    type: 'R',
    name: id.toUpperCase(),
    value: '1k',
    position: { x: 100, y: 100 },
    rotation: 0,
    pins: [{ id: 'a', name: '1', net: 'in' }, { id: 'b', name: '2', net: 'out' }],
  };
}

function makeModule(components: CircuitComponent[] = []): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: 'test',
    name: 'Test',
    revision: 0,
    nets: [
      { id: 'net_in', name: 'in', kind: 'analog', aliases: [] },
      { id: 'net_out', name: 'out', kind: 'analog', aliases: [] },
    ],
    ports: [{ id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in', net_id: 'net_in' }],
    components,
    wires: [],
    annotations: [],
  };
}

function identifiedWire(
  id: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  options: {
    from?: CircuitWire['from'];
    to?: CircuitWire['to'];
    net?: string;
    net_id?: string;
  } = {},
): CircuitWire {
  return {
    id,
    points: [start, end],
    from: options.from ?? { ...start, junction_id: `${id}_from` },
    to: options.to ?? { ...end, junction_id: `${id}_to` },
    net: options.net ?? 'in',
    net_id: options.net_id ?? 'net_in',
    source: 'stored',
  };
}

function makeTransaction(operations: Transaction['operations']): Transaction {
  return {
    schema: 'actoviq.command.v2',
    command_id: 't1',
    actor: 'test',
    project_id: 'p1',
    module_id: 'test',
    base_revision: 0,
    expected_module_revision: 0,
    operations,
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

// === applyTransaction ===

check('place_component adds component and produces delete inverse', () => {
  const module = makeModule();
  const result = applyTransaction(module, makeTransaction([{ op: 'place_component', component: makeComponent('r1') }]));
  assert.equal(result.module.components.length, 1);
  assert.equal(result.module.revision, 1);
  assert.deepEqual(result.affected, ['r1']);
  assert.equal(result.inverse[0]?.op, 'delete_entities');
});

check('delete_entities removes component and produces place inverse', () => {
  const module = makeModule([makeComponent('r1')]);
  const result = applyTransaction(module, makeTransaction([{ op: 'delete_entities', entity_ids: ['r1'] }]));
  assert.equal(result.module.components.length, 0);
  assert.equal(result.inverse[0]?.op, 'place_component');
});

check('move_entities shifts position and inverse restores it', () => {
  const module = makeModule([makeComponent('r1')]);
  const result = applyTransaction(module, makeTransaction([{ op: 'move_entities', entity_ids: ['r1'], delta: { x: 50, y: -30 }, mode: 'free' }]));
  assert.deepEqual(result.module.components[0]!.position, { x: 150, y: 70 });
  assert.equal(result.inverse[0]?.op, 'move_entities');
  assert.deepEqual((result.inverse[0] as { delta: { x: number; y: number } }).delta, { x: -50, y: 30 });
});

check('update_component changes value and inverse restores it', () => {
  const module = makeModule([makeComponent('r1')]);
  const result = applyTransaction(module, makeTransaction([{ op: 'update_component', component_id: 'r1', value: '2k' }]));
  assert.equal(result.module.components[0]!.value, '2k');
  assert.equal(result.inverse[0]?.op, 'update_component');
  assert.equal((result.inverse[0] as { value?: string }).value, '1k');
});

check('inverse round-trip restores original module', () => {
  const module = makeModule([makeComponent('r1')]);
  const result = applyTransaction(module, makeTransaction([
    { op: 'place_component', component: makeComponent('r2') },
    { op: 'move_entities', entity_ids: ['r1'], delta: { x: 10, y: 10 }, mode: 'free' },
  ]));
  assert.equal(result.module.components.length, 2);
  // Apply inverse in reverse order.
  const inverseTx = makeTransaction([...result.inverse].reverse());
  inverseTx.expected_module_revision = result.module.revision;
  const restored = applyTransaction(result.module, inverseTx);
  assert.equal(restored.module.components.length, 1);
  assert.equal(restored.module.components[0]!.id, 'r1');
  assert.deepEqual(restored.module.components[0]!.position, { x: 100, y: 100 });
});

check('project base_revision is independent from module revision', () => {
  const module = makeModule();
  module.revision = 5;
  const tx = makeTransaction([{ op: 'place_component', component: makeComponent('r1') }]);
  tx.base_revision = 3;
  tx.expected_module_revision = 5;
  assert.equal(applyTransaction(module, tx).module.revision, 6);
});

check('stale expected_module_revision is rejected', () => {
  const module = makeModule();
  const tx = makeTransaction([{ op: 'place_component', component: makeComponent('r1') }]);
  tx.expected_module_revision = 4;
  assert.throws(() => applyTransaction(module, tx), /stale expected_module_revision/);
});

check('transaction module_id mismatch is rejected', () => {
  const module = makeModule();
  const tx = makeTransaction([{ op: 'place_component', component: makeComponent('r1') }]);
  tx.module_id = 'other';
  assert.throws(() => applyTransaction(module, tx), /module_id mismatch/);
});

check('result includes topology diagnostics', () => {
  const module = makeModule();
  const result = applyTransaction(module, makeTransaction([{ op: 'place_component', component: makeComponent('r1') }]));
  assert.ok(Array.isArray(result.diagnostics));
  // A clean placed component on a module with no wires is invariant-clean.
  assert.equal(result.ok, true);
});

// === M2-01: wire, junction, net, port, module-instance, metadata ops ===

check('create_wire adds stored wire and produces delete inverse', () => {
  const module = makeModule([makeComponent('r1')]);
  const result = applyTransaction(module, makeTransaction([
    {
      op: 'create_wire',
      wire_id: 'w1',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      from: { x: 0, y: 0, junction_id: 'j1' },
      to: { x: 100, y: 0, junction_id: 'j2' },
      net: 'in',
      net_id: 'net_in',
    },
  ]));
  assert.equal(result.module.wires?.length, 1);
  assert.equal(result.module.wires?.[0]?.source, 'stored');
  assert.equal(result.module.wires?.[0]?.from?.junction_id, 'j1');
  assert.equal(result.module.wires?.[0]?.to?.junction_id, 'j2');
  assert.equal(result.module.wires?.[0]?.net_id, 'net_in');
  assert.equal(result.inverse[0]?.op, 'delete_entities');
});

check('edit_wire_path replaces points and inverse restores', () => {
  const module = makeModule();
  module.wires = [identifiedWire('w1', { x: 0, y: 0 }, { x: 100, y: 0 })];
  const result = applyTransaction(module, makeTransaction([
    { op: 'edit_wire_path', wire_id: 'w1', points: [{ x: 0, y: 0 }, { x: 200, y: 50 }] },
  ]));
  assert.deepEqual(result.module.wires?.[0]?.points?.[1], { x: 200, y: 50 });
  assert.equal(result.inverse[0]?.op, 'edit_wire_path');
});

check('split_wire creates identified segments and inverse restores the wire', () => {
  const module = makeModule();
  module.wires = [identifiedWire('w1', { x: 0, y: 0 }, { x: 100, y: 0 })];
  const result = applyTransaction(module, makeTransaction([
    { op: 'split_wire', wire_id: 'w1', point: { x: 50, y: 0 }, junction_id: 'j_mid' },
  ]));
  assert.equal(result.module.wires?.length, 2);
  assert.equal(result.module.wires?.[0]?.to?.junction_id, 'j_mid');
  assert.equal(result.module.wires?.[1]?.from?.junction_id, 'j_mid');
  const inverseTx = makeTransaction([...result.inverse].reverse());
  inverseTx.expected_module_revision = result.module.revision;
  const restored = applyTransaction(result.module, inverseTx);
  assert.deepEqual(
    [...restored.module.wires].sort((left, right) => left.id.localeCompare(right.id)),
    [...module.wires].sort((left, right) => left.id.localeCompare(right.id)),
  );
});

check('upsert_junction splits every same-net crossing and has a lossless inverse', () => {
  const module = makeModule();
  module.wires = [
    identifiedWire('horizontal', { x: 0, y: 50 }, { x: 100, y: 50 }),
    identifiedWire('vertical', { x: 50, y: 0 }, { x: 50, y: 100 }),
  ];
  const result = applyTransaction(module, makeTransaction([{
    op: 'upsert_junction',
    junction_id: 'j_cross',
    point: { x: 50, y: 50 },
    net: 'in',
  }]));
  assert.equal(result.module.wires?.length, 4);
  assert.equal(
    result.module.wires?.filter((wire) => (
      wire.from?.junction_id === 'j_cross' || wire.to?.junction_id === 'j_cross'
    )).length,
    4,
  );
  const inverseTx = makeTransaction([...result.inverse].reverse());
  inverseTx.expected_module_revision = result.module.revision;
  const restored = applyTransaction(result.module, inverseTx);
  assert.deepEqual(
    [...restored.module.wires].sort((left, right) => left.id.localeCompare(right.id)),
    [...module.wires].sort((left, right) => left.id.localeCompare(right.id)),
  );
});

check('join_wires merges two wires and inverse restores both', () => {
  const module = makeModule();
  module.wires = [
    identifiedWire(
      'w1',
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { to: { x: 100, y: 0, junction_id: 'j_shared' } },
    ),
    identifiedWire(
      'w2',
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { from: { x: 100, y: 0, junction_id: 'j_shared' } },
    ),
  ];
  const result = applyTransaction(module, makeTransaction([
    { op: 'join_wires', wire_ids: ['w1', 'w2'] },
  ]));
  assert.equal(result.module.wires?.length, 1);
  assert.equal(result.module.wires?.[0]?.id, 'w1');
  assert.equal(result.module.wires?.[0]?.points?.length, 3);
});

check('rename_net updates pins, ports, and wires; inverse restores', () => {
  const module = makeModule([makeComponent('r1')]);
  module.wires = [identifiedWire('w1', { x: 0, y: 0 }, { x: 10, y: 0 })];
  const result = applyTransaction(module, makeTransaction([
    { op: 'rename_net', old_net: 'in', new_net: 'input' },
  ]));
  assert.equal(result.module.components[0]!.pins[0]!.net, 'input');
  assert.equal(result.module.ports[0]!.net, 'input');
  assert.equal(result.module.wires?.[0]?.net, 'input');
  assert.deepEqual(result.inverse[0], { op: 'rename_net', old_net: 'input', new_net: 'in' });
});

check('upsert_port adds new port and inverse removes it', () => {
  const module = makeModule();
  const result = applyTransaction(module, makeTransaction([
    { op: 'upsert_port', port: { id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' } },
  ]));
  assert.equal(result.module.ports.length, 2);
  assert.equal(result.module.ports[1]!.id, 'out');
  const inverseTx = makeTransaction([...result.inverse].reverse());
  inverseTx.expected_module_revision = result.module.revision;
  const restored = applyTransaction(result.module, inverseTx);
  assert.equal(restored.module.ports.some((port) => port.id === 'out'), false);
});

check('upsert_port updates existing port and inverse restores', () => {
  const module = makeModule();
  const result = applyTransaction(module, makeTransaction([
    { op: 'upsert_port', port: { id: 'in', name: 'INPUT', direction: 'input', signal_type: 'analog', net: 'in' } },
  ]));
  assert.equal(result.module.ports[0]!.name, 'INPUT');
  assert.equal(result.inverse[0]?.op, 'upsert_port');
});

check('place_module_instance adds MODULE component with module_ref', () => {
  const module = makeModule();
  const result = applyTransaction(module, makeTransaction([
    {
      op: 'place_module_instance',
      component_id: 'm1',
      module_ref: { module_id: 'amp', revision: 2 },
      position: { x: 200, y: 200 },
      pins: [{ id: 'in', name: 'IN', net: 'm1_in' }],
    },
  ]));
  assert.equal(result.module.components.length, 1);
  assert.equal(result.module.components[0]!.type, 'MODULE');
  assert.equal(result.module.components[0]!.module_ref?.module_id, 'amp');
  assert.equal(result.module.components[0]!.module_ref?.revision, 2);
});

check('set_module_metadata updates name and inverse restores', () => {
  const module = makeModule();
  const result = applyTransaction(module, makeTransaction([
    { op: 'set_module_metadata', name: 'Renamed' },
  ]));
  assert.equal(result.module.name, 'Renamed');
  assert.equal(result.inverse[0]?.op, 'set_module_metadata');
});

check('delete_entities also removes wires by id', () => {
  const module = makeModule([makeComponent('r1')]);
  module.wires = [
    identifiedWire('w1', { x: 0, y: 0 }, { x: 10, y: 0 }),
    identifiedWire(
      'w2',
      { x: 0, y: 20 },
      { x: 20, y: 20 },
      { net: 'out', net_id: 'net_out' },
    ),
  ];
  const result = applyTransaction(module, makeTransaction([
    { op: 'delete_entities', entity_ids: ['w1'] },
  ]));
  assert.equal(result.module.wires?.length, 1);
  assert.equal(result.module.wires?.[0]?.id, 'w2');
  assert.equal(result.inverse[0]?.op, 'create_wire');
});

check('delete component removes attached wires and inverse restores topology', () => {
  const component = makeComponent('r1');
  component.pins[0]!.net_id = 'net_in';
  const module = makeModule([component]);
  module.wires = [
    identifiedWire(
      'w1',
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      {
        from: { x: 0, y: 0, port_id: 'in' },
        to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' },
      },
    ),
  ];
  const result = applyTransaction(module, makeTransaction([
    { op: 'delete_entities', entity_ids: ['r1'] },
  ]));
  assert.equal(result.module.components.length, 0);
  assert.equal(result.module.wires.length, 0);
  const inverseTx = makeTransaction([...result.inverse].reverse());
  inverseTx.expected_module_revision = result.module.revision;
  const restored = applyTransaction(result.module, inverseTx);
  assert.equal(restored.module.components.some((entry) => entry.id === 'r1'), true);
  assert.equal(restored.module.wires.some((entry) => entry.id === 'w1'), true);
});

check('join three wires has a lossless inverse', () => {
  const module = makeModule();
  module.wires = [
    identifiedWire(
      'w1',
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { to: { x: 100, y: 0, junction_id: 'j1' } },
    ),
    identifiedWire(
      'w2',
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      {
        from: { x: 100, y: 0, junction_id: 'j1' },
        to: { x: 200, y: 0, junction_id: 'j2' },
      },
    ),
    identifiedWire(
      'w3',
      { x: 200, y: 0 },
      { x: 300, y: 0 },
      { from: { x: 200, y: 0, junction_id: 'j2' } },
    ),
  ];
  const result = applyTransaction(module, makeTransaction([
    { op: 'join_wires', wire_ids: ['w1', 'w2', 'w3'] },
  ]));
  assert.equal(result.module.wires.length, 1);
  assert.equal(result.module.wires[0]!.points.length, 4);
  const inverseTx = makeTransaction([...result.inverse].reverse());
  inverseTx.expected_module_revision = result.module.revision;
  const restored = applyTransaction(result.module, inverseTx);
  assert.deepEqual(
    restored.module.wires.map((wire) => wire.id).sort(),
    ['w1', 'w2', 'w3'],
  );
});

// === SelectionSet ===

check('empty selection is empty', () => {
  const sel = emptySelection();
  assert.equal(selectionIsEmpty(sel), true);
  assert.equal(selectionSize(sel), 0);
});

check('toggle adds then removes', () => {
  let sel = emptySelection();
  sel = toggleSelection(sel, 'component', 'r1');
  assert.equal(selectionSize(sel), 1);
  assert.deepEqual(allSelectedIds(sel), ['r1']);
  sel = toggleSelection(sel, 'component', 'r1');
  assert.equal(selectionIsEmpty(sel), true);
});

check('addSelection accumulates across kinds', () => {
  let sel = emptySelection();
  sel = addToSelection(sel, 'component', ['r1', 'r2']);
  sel = addToSelection(sel, 'wire', ['w1']);
  assert.equal(selectionSize(sel), 3);
  assert.equal(sel.components.size, 2);
  assert.equal(sel.wires.size, 1);
});

check('cloneSelection is independent', () => {
  const sel = addToSelection(emptySelection(), 'component', ['r1']);
  const copy = cloneSelection(sel);
  copy.components.add('r2');
  assert.equal(sel.components.size, 1);
  assert.equal(copy.components.size, 2);
});

check('clearSelection empties all kinds', () => {
  let sel = addToSelection(emptySelection(), 'component', ['r1']);
  sel = addToSelection(sel, 'wire', ['w1']);
  sel = clearSelection(sel);
  assert.equal(selectionIsEmpty(sel), true);
});

console.log(JSON.stringify({ ok: failed === 0, passed, failed, total: passed + failed }, null, 2));
if (failed > 0) process.exit(1);

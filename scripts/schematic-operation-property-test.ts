/**
 * M3 acceptance: 1,000 deterministic legal command.v2 operations preserve
 * topology invariants. Previewed-and-cancelled transactions are discarded and
 * must not change content or revision.
 */
import assert from 'node:assert/strict';

import type {
  CircuitComponent,
  CircuitModule,
  CircuitWireEndpoint,
} from '../renderer/src/types';
import {
  applyTransaction,
  type Transaction,
  type TransactionOperation,
} from '../renderer/src/schematic-core/commands/applyTransaction';
import { checkTopologyInvariants } from '../renderer/src/schematic-core/diagnostics/topologyInvariants';

let seed = 0x5eed1234;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function component(id: string, serial: number): CircuitComponent {
  return {
    id,
    type: 'BLOCK',
    name: id.toUpperCase(),
    value: `block-${serial}`,
    position: { x: serial * 40, y: (serial % 7) * 60 },
    rotation: 0,
    pins: [{
      id: 'p',
      name: 'P',
      net: 'bus',
      net_id: 'net_bus',
      side: 'right',
    }],
  };
}

function initialModule(): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: 'property',
    name: 'Property',
    revision: 0,
    ports: [],
    components: [component('c0', 0), component('c1', 1)],
    nets: [{ id: 'net_bus', name: 'bus', kind: 'analog', aliases: [] }],
    wires: [],
    annotations: [],
  };
}

function transaction(module: CircuitModule, serial: number, operation: TransactionOperation): Transaction {
  return {
    schema: 'actoviq.command.v2',
    command_id: `property-${serial}`,
    actor: 'property-test',
    project_id: 'property',
    module_id: module.module_id,
    base_revision: 0,
    expected_module_revision: module.revision,
    operations: [operation],
  };
}

function wiredComponentIds(module: CircuitModule): Set<string> {
  return new Set(
    (module.wires ?? []).flatMap((wire) => [wire.from, wire.to])
      .filter((endpoint): endpoint is CircuitWireEndpoint => Boolean(endpoint?.component_id))
      .map((endpoint) => endpoint.component_id!),
  );
}

function createLegalOperation(module: CircuitModule, step: number): TransactionOperation {
  const components = module.components;
  const wires = module.wires ?? [];
  const used = wiredComponentIds(module);
  const free = components.filter((item) => !used.has(item.id));
  const choices = ['place', 'move', 'update', 'metadata'];
  if (components.length > 2) choices.push('delete-component');
  if (free.length >= 2) choices.push('create-wire');
  if (wires.length > 0) choices.push('delete-wire', 'edit-wire');
  if (components.length >= 36) {
    choices.splice(choices.indexOf('place'), 1);
  }

  switch (pick(choices)) {
    case 'place':
      return { op: 'place_component', component: component(`c${step + 2}`, step + 2) };
    case 'move': {
      const target = pick(components);
      return {
        op: 'move_entities',
        entity_ids: [target.id],
        delta: {
          x: (Math.floor(random() * 5) - 2) * 10,
          y: (Math.floor(random() * 5) - 2) * 10,
        },
        mode: random() < 0.5 ? 'stretch' : 'free',
      };
    }
    case 'update': {
      const target = pick(components);
      return {
        op: 'update_component',
        component_id: target.id,
        value: `value-${step}`,
        rotation: (Math.floor(random() * 4) * 90),
      };
    }
    case 'delete-component':
      return { op: 'delete_entities', entity_ids: [pick(components).id] };
    case 'create-wire': {
      const first = pick(free);
      const second = pick(free.filter((item) => item.id !== first.id));
      const from = { ...first.position, component_id: first.id, pin_id: 'p' };
      const to = { ...second.position, component_id: second.id, pin_id: 'p' };
      if (from.x === to.x && from.y === to.y) {
        return {
          op: 'move_entities',
          entity_ids: [second.id],
          delta: { x: 20, y: 0 },
          mode: 'stretch',
        };
      }
      return {
        op: 'create_wire',
        wire_id: `w${step}`,
        points: [from, to],
        from,
        to,
        net: 'bus',
        net_id: 'net_bus',
        source: 'stored',
      };
    }
    case 'delete-wire':
      return { op: 'delete_entities', entity_ids: [pick(wires).id] };
    case 'edit-wire': {
      const wire = pick(wires);
      const from = wire.points[0]!;
      const to = wire.points.at(-1)!;
      if (from.x === to.x && from.y === to.y) {
        return { op: 'delete_entities', entity_ids: [wire.id] };
      }
      const middle = { x: from.x, y: to.y };
      const points = (
        (middle.x === from.x && middle.y === from.y)
        || (middle.x === to.x && middle.y === to.y)
      ) ? [from, to] : [from, middle, to];
      return { op: 'edit_wire_path', wire_id: wire.id, points };
    }
    default:
      return { op: 'set_module_metadata', name: `Property ${step}` };
  }
}

let module = initialModule();
let cancelled = 0;
for (let step = 0; step < 1_000; step += 1) {
  const operation = createLegalOperation(module, step);
  const before = JSON.stringify(module);
  const result = applyTransaction(module, transaction(module, step, operation));
  assert.equal(result.ok, true, `step ${step} ${operation.op}: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(checkTopologyInvariants(result.module).ok, true);

  if (step % 13 === 0) {
    // A reducer preview is cancellable by discarding its result.
    assert.equal(JSON.stringify(module), before);
    cancelled += 1;
  } else {
    module = result.module;
  }
}

assert.equal(checkTopologyInvariants(module).ok, true);
console.log(JSON.stringify({
  ok: true,
  suite: 'schematic-operation-property',
  seed: '0x5eed1234',
  legalOperations: 1_000,
  cancelledPreviews: cancelled,
  finalRevision: module.revision,
  finalComponents: module.components.length,
  finalWires: module.wires?.length ?? 0,
}, null, 2));

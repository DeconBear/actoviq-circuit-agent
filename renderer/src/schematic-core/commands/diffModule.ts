import type {
  CircuitComponent,
  CircuitModule,
  CircuitPosition,
  CircuitWire,
} from '../../types';
import type { TransactionOperation } from './applyTransaction';

export interface ModuleDiffResult {
  operations: TransactionOperation[];
  unsupported: string[];
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createComponentOperation(component: CircuitComponent): TransactionOperation {
  if (component.type === 'MODULE' && component.module_ref) {
    return {
      op: 'place_module_instance',
      component_id: component.id,
      module_ref: { ...component.module_ref },
      position: { ...component.position },
      rotation: component.rotation,
      pins: component.pins.map((pin) => ({ ...pin })),
    };
  }
  return {
    op: 'place_component',
    component: JSON.parse(JSON.stringify(component)) as CircuitComponent,
  };
}

function componentRequiresReplacement(
  before: CircuitComponent,
  after: CircuitComponent,
): boolean {
  return !equal(
    {
      type: before.type,
      pins: before.pins,
      stable_id: before.stable_id,
      eda: before.eda,
      block: before.block,
      module_ref: before.module_ref,
      spice: before.spice,
    },
    {
      type: after.type,
      pins: after.pins,
      stable_id: after.stable_id,
      eda: after.eda,
      block: after.block,
      module_ref: after.module_ref,
      spice: after.spice,
    },
  );
}

function endpointIdentity(endpoint: CircuitWire['from']): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) {
    return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  }
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  return '';
}

function wireTouchesAnyComponent(wire: CircuitWire, componentIds: Set<string>): boolean {
  return Boolean(
    wire.from?.component_id && componentIds.has(wire.from.component_id)
    || wire.to?.component_id && componentIds.has(wire.to.component_id),
  );
}

function createWireOperation(wire: CircuitWire): TransactionOperation {
  if (!wire.from || !wire.to || !wire.net || !wire.net_id) {
    throw new Error(`wire ${wire.id} is missing identified endpoints or net_id`);
  }
  return {
    op: 'create_wire',
    wire_id: wire.id,
    points: wire.points.map((point) => ({ ...point })),
    from: { ...wire.from },
    to: { ...wire.to },
    net: wire.net,
    net_id: wire.net_id,
    source: wire.source ?? 'stored',
  };
}

function positionDelta(before: CircuitPosition, after: CircuitPosition): CircuitPosition {
  return { x: after.x - before.x, y: after.y - before.y };
}

/**
 * Convert a saved module draft into granular command.v2 operations.
 *
 * The diff is deliberately strict: fields without a v2 operation are
 * reported as unsupported instead of being silently dropped. Normal editor
 * actions (place/update/move/delete/wire/port/net rename) are fully covered.
 */
export function diffModuleToOperations(
  before: CircuitModule,
  after: CircuitModule,
): ModuleDiffResult {
  if (before.module_id !== after.module_id) {
    throw new Error(`module diff id mismatch: ${before.module_id} != ${after.module_id}`);
  }

  const operations: TransactionOperation[] = [];
  const unsupported: string[] = [];
  const beforeComponents = new Map(before.components.map((component) => [component.id, component]));
  const afterComponents = new Map(after.components.map((component) => [component.id, component]));
  const replacedComponentIds = new Set<string>();

  for (const component of before.components) {
    if (!afterComponents.has(component.id)) {
      operations.push({ op: 'delete_entities', entity_ids: [component.id] });
    }
  }
  for (const component of after.components) {
    const previous = beforeComponents.get(component.id);
    if (!previous) {
      operations.push(createComponentOperation(component));
      continue;
    }
    if (componentRequiresReplacement(previous, component)) {
      replacedComponentIds.add(component.id);
      operations.push(
        { op: 'delete_entities', entity_ids: [component.id] },
        createComponentOperation(component),
      );
      continue;
    }
    if (!equal(previous.position, component.position)) {
      operations.push({
        op: 'move_entities',
        entity_ids: [component.id],
        delta: positionDelta(previous.position, component.position),
        mode: 'stretch',
      });
    }
    const patch: Extract<TransactionOperation, { op: 'update_component' }> = {
      op: 'update_component',
      component_id: component.id,
    };
    if (previous.name !== component.name) patch.name = component.name;
    if (previous.value !== component.value) patch.value = component.value;
    if (previous.rotation !== component.rotation) patch.rotation = component.rotation;
    if (!equal(previous.parameters, component.parameters)) {
      patch.parameters = { ...(component.parameters ?? {}) };
    }
    if (Object.keys(patch).length > 2) operations.push(patch);
  }

  const beforePorts = new Map(before.ports.map((port) => [port.id, port]));
  const afterPorts = new Map(after.ports.map((port) => [port.id, port]));
  for (const port of before.ports) {
    if (!afterPorts.has(port.id)) {
      operations.push({ op: 'delete_entities', entity_ids: [`port:${port.id}`] });
    }
  }
  for (const port of after.ports) {
    const previous = beforePorts.get(port.id);
    if (!previous || !equal(previous, port)) {
      operations.push({
        op: 'upsert_port',
        port: JSON.parse(JSON.stringify(port)) as typeof port,
      });
    }
  }

  const afterNetById = new Map((after.nets ?? []).map((net) => [net.id, net]));
  for (const net of before.nets ?? []) {
    const next = afterNetById.get(net.id);
    if (next && net.name !== next.name) {
      operations.push({ op: 'rename_net', old_net: net.name, new_net: next.name });
    }
  }

  const beforeWires = new Map((before.wires ?? []).map((wire) => [wire.id, wire]));
  const afterWires = new Map((after.wires ?? []).map((wire) => [wire.id, wire]));
  for (const wire of before.wires ?? []) {
    if (!afterWires.has(wire.id)) {
      operations.push({ op: 'delete_entities', entity_ids: [wire.id] });
    }
  }
  for (const wire of after.wires ?? []) {
    const previous = beforeWires.get(wire.id);
    if (!previous) {
      operations.push(createWireOperation(wire));
      continue;
    }
    const endpointIdentityChanged = (
      endpointIdentity(previous.from) !== endpointIdentity(wire.from)
      || endpointIdentity(previous.to) !== endpointIdentity(wire.to)
    );
    const electricalIdentityChanged = (
      previous.net !== wire.net
      || previous.net_id !== wire.net_id
      || previous.source !== wire.source
    );
    if (
      endpointIdentityChanged
      || electricalIdentityChanged
      || wireTouchesAnyComponent(wire, replacedComponentIds)
    ) {
      operations.push(
        { op: 'delete_entities', entity_ids: [wire.id] },
        createWireOperation(wire),
      );
    } else if (
      !equal(previous.points, wire.points)
      || !equal(previous.from, wire.from)
      || !equal(previous.to, wire.to)
    ) {
      operations.push({
        op: 'edit_wire_path',
        wire_id: wire.id,
        points: wire.points.map((point) => ({ ...point })),
      });
    }
  }

  if (!equal(before.annotations, after.annotations)) unsupported.push('annotations');
  if (!equal(before.spice, after.spice)) unsupported.push('spice');
  if (!equal(before.parameter_defs, after.parameter_defs)) unsupported.push('parameter_defs');
  if (before.domain !== after.domain || before.name !== after.name) {
    operations.push({
      op: 'set_module_metadata',
      ...(before.name !== after.name ? { name: after.name } : {}),
      ...(before.domain !== after.domain ? { domain: after.domain } : {}),
    });
  }

  return { operations, unsupported };
}

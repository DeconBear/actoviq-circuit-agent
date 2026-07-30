/**
 * Pure transaction reducer for the schematic core.
 *
 * applyTransaction(module, transaction) applies a v2 command's operations to
 * a module and returns the next module plus a computed inverse, the affected
 * entity ids, and topology diagnostics. It is pure: it does not mutate the
 * input module and does not start React/Electron (M1-03 requirement).
 *
 * The reducer covers every command.v2 operation used by the desktop editor.
 * It also computes inverse operations and runs topology invariants so callers
 * can preview a transaction, reject stale module edits, and implement undo
 * without starting React or Electron.
 */

import type {
  CircuitComponent,
  CircuitModule,
  CircuitPin,
  CircuitPort,
  CircuitPosition,
  CircuitWire,
  CircuitWireEndpoint,
} from '../../types';
import { checkTopologyInvariants, type TopologyDiagnostic } from '../diagnostics/topologyInvariants';

export type TransactionOperation =
  | { op: 'place_component'; component: CircuitComponent }
  | { op: 'update_component'; component_id: string; name?: string; value?: string; position?: CircuitPosition; rotation?: number; parameters?: Record<string, string> }
  | { op: 'move_entities'; entity_ids: string[]; delta: CircuitPosition; mode: 'free' | 'stretch' }
  | { op: 'delete_entities'; entity_ids: string[] }
  | {
      op: 'create_wire';
      wire_id: string;
      points: CircuitPosition[];
      from: CircuitWireEndpoint;
      to: CircuitWireEndpoint;
      net: string;
      net_id: string;
      source?: 'stored' | 'net';
    }
  | { op: 'edit_wire_path'; wire_id: string; points: CircuitPosition[] }
  | { op: 'split_wire'; wire_id: string; point: CircuitPosition; junction_id?: string }
  | { op: 'join_wires'; wire_ids: string[] }
  | { op: 'upsert_junction'; junction_id: string; point: CircuitPosition; net: string }
  | { op: 'rename_net'; old_net: string; new_net: string }
  | { op: 'upsert_port'; port: CircuitPort }
  | {
      op: 'place_module_instance';
      component_id: string;
      module_ref: { module_id: string; revision?: number };
      position: CircuitPosition;
      pins: CircuitPin[];
      rotation?: number;
    }
  | { op: 'set_module_metadata'; name?: string; domain?: 'analog' | 'digital' | 'mixed_boundary' | 'testbench' };

export interface Transaction {
  schema: 'actoviq.command.v2';
  command_id: string;
  actor: string;
  project_id: string;
  module_id: string;
  base_revision: number;
  expected_module_revision: number;
  operations: TransactionOperation[];
  message?: string;
  notebook_markdown?: string;
  source?: string;
}

export interface ApplyTransactionResult {
  module: CircuitModule;
  inverse: TransactionOperation[];
  affected: string[];
  diagnostics: TopologyDiagnostic[];
  ok: boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createWireOperation(wire: CircuitWire): TransactionOperation {
  if (!wire.from || !wire.to || !wire.net || !wire.net_id) {
    throw new Error(`create_wire inverse: wire ${wire.id} is missing identified endpoints or net_id`);
  }
  return {
    op: 'create_wire',
    wire_id: wire.id,
    points: clone(wire.points),
    from: clone(wire.from),
    to: clone(wire.to),
    net: wire.net,
    net_id: wire.net_id,
    source: wire.source ?? 'stored',
  };
}

function samePoint(left: CircuitPosition, right: CircuitPosition, epsilon = 0.001): boolean {
  return Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon;
}

function pointOnSegment(
  point: CircuitPosition,
  left: CircuitPosition,
  right: CircuitPosition,
  epsilon = 0.001,
): boolean {
  const withinX = (
    point.x >= Math.min(left.x, right.x) - epsilon
    && point.x <= Math.max(left.x, right.x) + epsilon
  );
  const withinY = (
    point.y >= Math.min(left.y, right.y) - epsilon
    && point.y <= Math.max(left.y, right.y) + epsilon
  );
  const cross = (
    (right.x - left.x) * (point.y - left.y)
    - (right.y - left.y) * (point.x - left.x)
  );
  return withinX && withinY && Math.abs(cross) <= epsilon;
}

function junctionEndpoint(point: CircuitPosition, junctionId: string): CircuitWireEndpoint {
  return { ...point, junction_id: junctionId };
}

function uniqueSplitWireId(wires: CircuitWire[], wireId: string, junctionId: string): string {
  const existing = new Set(wires.map((wire) => wire.id));
  const base = `${wireId}__${junctionId}`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function endpointTouchesEntities(
  endpoint: CircuitWireEndpoint | undefined,
  componentIds: Set<string>,
  portIds: Set<string>,
): boolean {
  return Boolean(
    endpoint
    && (
      (endpoint.component_id && componentIds.has(endpoint.component_id))
      || (endpoint.port_id && portIds.has(endpoint.port_id))
    )
  );
}

function translateWireInPlace(wire: CircuitWire, delta: CircuitPosition): void {
  const move = (point: CircuitPosition): CircuitPosition => ({
    x: point.x + delta.x,
    y: point.y + delta.y,
  });
  wire.points = wire.points.map(move);
  if (wire.from) wire.from = { ...wire.from, ...move(wire.from) };
  if (wire.to) wire.to = { ...wire.to, ...move(wire.to) };
}

function stretchWireEndpointInPlace(
  wire: CircuitWire,
  side: 'from' | 'to',
  delta: CircuitPosition,
): void {
  if (wire.points.length < 2) return;
  const endpointIndex = side === 'from' ? 0 : wire.points.length - 1;
  const neighborIndex = side === 'from' ? 1 : wire.points.length - 2;
  const original = wire.points[endpointIndex]!;
  const neighbor = wire.points[neighborIndex]!;
  const moved = { x: original.x + delta.x, y: original.y + delta.y };
  wire.points[endpointIndex] = moved;
  if (original.x === neighbor.x) {
    wire.points[neighborIndex] = { ...neighbor, x: moved.x };
  } else if (original.y === neighbor.y) {
    wire.points[neighborIndex] = { ...neighbor, y: moved.y };
  }
  const endpoint = wire[side];
  if (endpoint) wire[side] = { ...endpoint, ...moved };
}

function detachWireEndpointInPlace(wire: CircuitWire, side: 'from' | 'to'): void {
  const endpoint = wire[side];
  if (!endpoint) return;
  wire[side] = {
    x: endpoint.x,
    y: endpoint.y,
    junction_id: `j_detached_${wire.id}_${side}`,
  };
}

function splitWireInPlace(
  wires: CircuitWire[],
  wire: CircuitWire,
  point: CircuitPosition,
  junctionId: string,
): string[] {
  if (!wire.from || !wire.to || wire.points.length < 2) {
    throw new Error(`split_wire: wire ${wire.id} is missing a valid path or endpoints`);
  }
  const existingPointIndex = wire.points.findIndex((candidate) => samePoint(candidate, point));
  if (existingPointIndex === 0) {
    wire.from = junctionEndpoint(point, junctionId);
    return [wire.id];
  }
  if (existingPointIndex === wire.points.length - 1) {
    wire.to = junctionEndpoint(point, junctionId);
    return [wire.id];
  }
  // Interior bend vertices are valid split sites — reuse the existing vertex
  // instead of rejecting the transaction.
  const splitIndex = existingPointIndex >= 1
    ? existingPointIndex
    : wire.points.findIndex((candidate, index) => (
      index > 0 && pointOnSegment(point, wire.points[index - 1]!, candidate)
    ));
  if (splitIndex < 1) {
    throw new Error(`split_wire: point not on wire ${wire.id}`);
  }
  const originalPoints = clone(wire.points);
  const originalTo = clone(wire.to);
  const rightId = uniqueSplitWireId(wires, wire.id, junctionId);
  const splitPoint = clone(originalPoints[splitIndex]!);
  const right: CircuitWire = {
    ...clone(wire),
    id: rightId,
    points: [splitPoint, ...originalPoints.slice(splitIndex + (existingPointIndex >= 1 ? 1 : 0))],
    from: junctionEndpoint(splitPoint, junctionId),
    to: originalTo,
  };
  // When splitting at an existing bend, keep the shared vertex on both sides.
  // When splitting mid-segment, insert the new point on the left half.
  wire.points = existingPointIndex >= 1
    ? originalPoints.slice(0, splitIndex + 1)
    : [...originalPoints.slice(0, splitIndex), clone(point)];
  wire.to = junctionEndpoint(
    existingPointIndex >= 1 ? splitPoint : point,
    junctionId,
  );
  wires.push(right);
  return [wire.id, rightId];
}

function applyOperation(module: CircuitModule, operation: TransactionOperation): { module: CircuitModule; inverse: TransactionOperation[]; affected: string[] } {
  switch (operation.op) {
    case 'place_component': {
      const next = clone(module);
      if (next.components.some((component) => component.id === operation.component.id)) {
        throw new Error(`place_component: component ${operation.component.id} already exists`);
      }
      next.components = [...next.components, clone(operation.component)];
      return { module: next, inverse: [{ op: 'delete_entities', entity_ids: [operation.component.id] }], affected: [operation.component.id] };
    }
    case 'update_component': {
      const next = clone(module);
      const index = next.components.findIndex((c) => c.id === operation.component_id);
      if (index < 0) throw new Error(`update_component: component ${operation.component_id} not found`);
      const before = next.components[index]!;
      const inverse: TransactionOperation = { op: 'update_component', component_id: operation.component_id };
      if (operation.name !== undefined) { inverse.name = before.name; before.name = operation.name; }
      if (operation.value !== undefined) { inverse.value = before.value; before.value = operation.value; }
      if (operation.position !== undefined) { inverse.position = before.position; before.position = operation.position; }
      if (operation.rotation !== undefined) { inverse.rotation = before.rotation; before.rotation = operation.rotation; }
      if (operation.parameters !== undefined) { inverse.parameters = before.parameters; before.parameters = operation.parameters; }
      return { module: next, inverse: [inverse], affected: [operation.component_id] };
    }
    case 'move_entities': {
      const next = clone(module);
      const moved: string[] = [];
      const componentIds = new Set<string>();
      const portIds = new Set<string>();
      for (const component of next.components) {
        if (operation.entity_ids.includes(component.id)) {
          component.position = { x: component.position.x + operation.delta.x, y: component.position.y + operation.delta.y };
          moved.push(component.id);
          componentIds.add(component.id);
        }
      }
      for (const port of next.ports) {
        if (operation.entity_ids.includes(`port:${port.id}`)) {
          const position = port.position ?? { x: 0, y: 0 };
          port.position = {
            x: position.x + operation.delta.x,
            y: position.y + operation.delta.y,
          };
          moved.push(`port:${port.id}`);
          portIds.add(port.id);
        }
      }
      const affectedWires: CircuitWire[] = [];
      for (const wire of next.wires ?? []) {
        const fromMoved = endpointTouchesEntities(wire.from, componentIds, portIds);
        const toMoved = endpointTouchesEntities(wire.to, componentIds, portIds);
        if (!fromMoved && !toMoved) continue;
        affectedWires.push(clone(wire));
        if (fromMoved && toMoved) {
          translateWireInPlace(wire, operation.delta);
        } else if (operation.mode === 'free') {
          if (fromMoved) detachWireEndpointInPlace(wire, 'from');
          if (toMoved) detachWireEndpointInPlace(wire, 'to');
        } else {
          if (fromMoved) stretchWireEndpointInPlace(wire, 'from', operation.delta);
          if (toMoved) stretchWireEndpointInPlace(wire, 'to', operation.delta);
        }
      }
      const inverseDelta = { x: -operation.delta.x, y: -operation.delta.y };
      const inverse: TransactionOperation[] = [
        ...affectedWires.map(createWireOperation),
        ...(affectedWires.length > 0
          ? [{
              op: 'delete_entities' as const,
              entity_ids: affectedWires.map((wire) => wire.id),
            }]
          : []),
        {
          op: 'move_entities',
          entity_ids: moved,
          delta: inverseDelta,
          mode: operation.mode,
        },
      ];
      return {
        module: next,
        inverse,
        affected: [...moved, ...affectedWires.map((wire) => wire.id)],
      };
    }
    case 'delete_entities': {
      const next = clone(module);
      const deleted: CircuitComponent[] = [];
      const requested = new Set(operation.entity_ids);
      const deletedPortIds = new Set(
        next.ports
          .filter((port) => requested.has(`port:${port.id}`))
          .map((port) => port.id),
      );
      const deletedPorts = next.ports.filter((port) => deletedPortIds.has(port.id));
      next.components = next.components.filter((c) => {
        if (requested.has(c.id)) { deleted.push(c); return false; }
        return true;
      });
      next.ports = next.ports.filter((port) => !deletedPortIds.has(port.id));
      const deletedComponentIds = new Set(deleted.map((component) => component.id));
      const deletedWires = (next.wires ?? []).filter((wire) => (
        requested.has(wire.id)
        || Boolean(wire.from?.component_id && deletedComponentIds.has(wire.from.component_id))
        || Boolean(wire.to?.component_id && deletedComponentIds.has(wire.to.component_id))
        || Boolean(wire.from?.port_id && deletedPortIds.has(wire.from.port_id))
        || Boolean(wire.to?.port_id && deletedPortIds.has(wire.to.port_id))
      ));
      const deletedWireIds = new Set(deletedWires.map((wire) => wire.id));
      next.wires = (next.wires ?? []).filter((wire) => !deletedWireIds.has(wire.id));
      const inverse: TransactionOperation[] = [
        ...deleted.map((c) => ({ op: 'place_component' as const, component: clone(c) })),
        ...deletedPorts.map((port) => ({ op: 'upsert_port' as const, port: clone(port) })),
        ...deletedWires.map(createWireOperation),
      ];
      return {
        module: next,
        inverse,
        affected: [...requested, ...deletedWireIds],
      };
    }
    case 'create_wire': {
      const next = clone(module);
      if ((next.wires ?? []).some((wire) => wire.id === operation.wire_id)) {
        throw new Error(`create_wire: wire ${operation.wire_id} already exists`);
      }
      const first = operation.points[0];
      const last = operation.points.at(-1);
      if (!first || !last || !samePoint(first, operation.from) || !samePoint(last, operation.to)) {
        throw new Error(`create_wire: wire ${operation.wire_id} path must start/end at its endpoints`);
      }
      const wire: CircuitWire = {
        id: operation.wire_id,
        points: clone(operation.points),
        from: clone(operation.from),
        to: clone(operation.to),
        net: operation.net,
        net_id: operation.net_id,
        source: operation.source ?? 'stored',
      };
      next.wires = [...(next.wires ?? []), wire];
      return { module: next, inverse: [{ op: 'delete_entities', entity_ids: [operation.wire_id] }], affected: [operation.wire_id] };
    }
    case 'edit_wire_path': {
      const next = clone(module);
      const wire = (next.wires ?? []).find((w) => w.id === operation.wire_id);
      if (!wire) throw new Error(`edit_wire_path: wire ${operation.wire_id} not found`);
      const beforePoints = clone(wire.points);
      wire.points = clone(operation.points);
      const first = wire.points[0];
      const last = wire.points.at(-1);
      if (first && wire.from) wire.from = { ...wire.from, x: first.x, y: first.y };
      if (last && wire.to) wire.to = { ...wire.to, x: last.x, y: last.y };
      return { module: next, inverse: [{ op: 'edit_wire_path', wire_id: operation.wire_id, points: beforePoints }], affected: [operation.wire_id] };
    }
    case 'split_wire': {
      const next = clone(module);
      const wire = (next.wires ?? []).find((w) => w.id === operation.wire_id);
      if (!wire) throw new Error(`split_wire: wire ${operation.wire_id} not found`);
      const before = clone(wire);
      const junctionId = operation.junction_id ?? `j_${operation.wire_id}_split`;
      const resultIds = splitWireInPlace(next.wires ?? [], wire, operation.point, junctionId);
      return {
        module: next,
        inverse: [
          createWireOperation(before),
          { op: 'delete_entities', entity_ids: resultIds },
        ],
        affected: resultIds,
      };
    }
    case 'join_wires': {
      const next = clone(module);
      const joined = operation.wire_ids.map((wireId) => {
        const wire = (next.wires ?? []).find((candidate) => candidate.id === wireId);
        if (!wire) throw new Error(`join_wires: wire ${wireId} not found`);
        return wire;
      });
      const first = joined[0];
      if (!first) throw new Error('join_wires: requires at least two wire ids');
      if (joined.some((wire) => wire.net_id !== first.net_id || wire.net !== first.net)) {
        throw new Error('join_wires: all wires must belong to the same net');
      }
      const snapshots = joined.map((wire) => clone(wire));
      let points = clone(first.points);
      let tail = first.to ? clone(first.to) : undefined;
      for (const wire of joined.slice(1)) {
        const currentEnd = points.at(-1);
        const wireStart = wire.points[0];
        const wireEnd = wire.points.at(-1);
        if (!currentEnd || !wireStart || !wireEnd) throw new Error(`join_wires: wire ${wire.id} has no path`);
        if (samePoint(currentEnd, wireStart)) {
          points.push(...clone(wire.points.slice(1)));
          tail = wire.to ? clone(wire.to) : tail;
        } else if (samePoint(currentEnd, wireEnd)) {
          points.push(...clone([...wire.points].reverse().slice(1)));
          tail = wire.from ? clone(wire.from) : tail;
        } else {
          throw new Error(`join_wires: wire ${wire.id} is not connected to the current tail`);
        }
      }
      first.points = points;
      first.to = tail;
      const removedIds = new Set(operation.wire_ids.slice(1));
      next.wires = (next.wires ?? []).filter((wire) => !removedIds.has(wire.id));
      return {
        module: next,
        // applyTransaction callers reverse inverse operations before applying
        // them, so delete the merged wire first, then restore every snapshot.
        inverse: [
          ...snapshots.map(createWireOperation),
          { op: 'delete_entities', entity_ids: [first.id] },
        ],
        affected: operation.wire_ids,
      };
    }
    case 'upsert_junction': {
      const next = clone(module);
      const matching = (next.wires ?? []).filter((wire) => (
        wire.net === operation.net
        && wire.points.some((right, index) => (
          index > 0 && pointOnSegment(operation.point, wire.points[index - 1]!, right)
        ))
      ));
      if (matching.length === 0) {
        throw new Error(`upsert_junction: no wire on net ${operation.net} at point`);
      }
      const snapshots = matching.map((wire) => clone(wire));
      const resultIds = matching.flatMap((wire) => (
        splitWireInPlace(next.wires ?? [], wire, operation.point, operation.junction_id)
      ));
      return {
        module: next,
        inverse: [
          ...snapshots.map(createWireOperation),
          { op: 'delete_entities', entity_ids: resultIds },
        ],
        affected: [operation.junction_id, ...resultIds],
      };
    }
    case 'rename_net': {
      const next = clone(module);
      const affected: string[] = [];
      for (const component of next.components) {
        for (const pin of component.pins) {
          if (pin.net === operation.old_net) { pin.net = operation.new_net; affected.push(`${component.id}.${pin.id}`); }
        }
      }
      for (const port of next.ports) {
        if (port.net === operation.old_net) { port.net = operation.new_net; affected.push(`port:${port.id}`); }
      }
      for (const wire of (next.wires ?? [])) {
        if (wire.net === operation.old_net) { wire.net = operation.new_net; affected.push(wire.id); }
      }
      for (const net of (next.nets ?? [])) {
        if (net.name === operation.old_net) {
          net.name = operation.new_net;
          affected.push(`net:${net.id}`);
        } else if (Array.isArray(net.aliases) && net.aliases.includes(operation.old_net)) {
          net.aliases = net.aliases.map((alias) => (
            alias === operation.old_net ? operation.new_net : alias
          ));
          affected.push(`net:${net.id}`);
        }
      }
      return { module: next, inverse: [{ op: 'rename_net', old_net: operation.new_net, new_net: operation.old_net }], affected };
    }
    case 'upsert_port': {
      const next = clone(module);
      const index = next.ports.findIndex((p) => p.id === operation.port.id);
      if (index >= 0) {
        const before = clone(next.ports[index]!);
        next.ports[index] = { ...operation.port };
        return { module: next, inverse: [{ op: 'upsert_port', port: before }], affected: [operation.port.id] };
      }
      next.ports = [...next.ports, { ...operation.port }];
      return { module: next, inverse: [{ op: 'delete_entities', entity_ids: [`port:${operation.port.id}`] }], affected: [operation.port.id] };
    }
    case 'place_module_instance': {
      const next = clone(module);
      const component: CircuitComponent = {
        id: operation.component_id,
        type: 'MODULE',
        name: operation.component_id.toUpperCase(),
        value: operation.module_ref.module_id,
        position: clone(operation.position),
        rotation: operation.rotation ?? 0,
        pins: clone(operation.pins),
        module_ref: { module_id: operation.module_ref.module_id, revision: operation.module_ref.revision },
      };
      next.components = [...next.components, component];
      return { module: next, inverse: [{ op: 'delete_entities', entity_ids: [operation.component_id] }], affected: [operation.component_id] };
    }
    case 'set_module_metadata': {
      const next = clone(module);
      const inverse: TransactionOperation = { op: 'set_module_metadata' };
      if (operation.name !== undefined) { inverse.name = next.name; next.name = operation.name; }
      if (operation.domain !== undefined) { inverse.domain = next.domain; next.domain = operation.domain; }
      return { module: next, inverse: [inverse], affected: [] };
    }
    default:
      throw new Error(`applyOperation: op '${(operation as { op: string }).op}' not implemented`);
  }
}

/**
 * Apply a transaction to a module. Pure: returns a new module, does not
 * mutate the input. Always runs topology invariants on the result.
 */
export function applyTransaction(module: CircuitModule, transaction: Transaction): ApplyTransactionResult {
  // The module reducer cannot validate project-level base_revision because it
  // intentionally receives no project document. The persistence boundary
  // validates that precondition; this reducer validates the module revision.
  if (transaction.expected_module_revision !== module.revision) {
    throw new Error(
      `applyTransaction: stale expected_module_revision `
      + `(transaction=${transaction.expected_module_revision}, module=${module.revision})`,
    );
  }
  if (transaction.module_id !== module.module_id) {
    throw new Error(
      `applyTransaction: module_id mismatch (transaction=${transaction.module_id}, module=${module.module_id})`,
    );
  }
  let current = clone(module);
  const inverse: TransactionOperation[] = [];
  const affected: string[] = [];
  for (const operation of transaction.operations) {
    const result = applyOperation(current, operation);
    current = result.module;
    inverse.push(...result.inverse);
    affected.push(...result.affected);
  }
  current.revision = module.revision + 1;
  const invariantResult = checkTopologyInvariants(current);
  return {
    module: current,
    inverse,
    affected: [...new Set(affected)],
    diagnostics: invariantResult.diagnostics,
    ok: invariantResult.ok,
  };
}

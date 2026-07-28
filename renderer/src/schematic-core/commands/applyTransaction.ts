/**
 * Pure transaction reducer for the schematic core.
 *
 * applyTransaction(module, transaction) applies a v2 command's operations to
 * a module and returns the next module plus a computed inverse, the affected
 * entity ids, and topology diagnostics. It is pure: it does not mutate the
 * input module and does not start React/Electron (M1-03 requirement).
 *
 * M1-03 implements the API contract and the four most common operations
 * (place_component, update_component, move_entities, delete_entities). The
 * remaining operations (wire editing, junction, rename_net, port, module
 * instance, metadata) are stubbed to throw so M2 can fill them in without
 * changing the call site. The reducer always runs topology invariants on the
 * result so a transaction that would leave the module in an invalid state
 * reports diagnostics (M1-06 contract).
 */

import type { CircuitComponent, CircuitModule, CircuitPosition } from '../../types';
import { checkTopologyInvariants, type TopologyDiagnostic } from '../diagnostics/topologyInvariants';

export type TransactionOperation =
  | { op: 'place_component'; component: CircuitComponent }
  | { op: 'update_component'; component_id: string; name?: string; value?: string; position?: CircuitPosition; rotation?: number; parameters?: Record<string, string> }
  | { op: 'move_entities'; entity_ids: string[]; delta: CircuitPosition; mode: 'free' | 'stretch' }
  | { op: 'delete_entities'; entity_ids: string[] }
  | { op: 'create_wire'; wire_id: string; points: CircuitPosition[]; net: string }
  | { op: 'edit_wire_path'; wire_id: string; points: CircuitPosition[] }
  | { op: 'split_wire'; wire_id: string; point: CircuitPosition }
  | { op: 'join_wires'; wire_ids: string[] }
  | { op: 'upsert_junction'; junction_id: string; point: CircuitPosition; net: string }
  | { op: 'rename_net'; old_net: string; new_net: string }
  | { op: 'upsert_port'; port: { id: string; name: string; direction: 'input' | 'output' | 'bidirectional'; signal_type: 'analog' | 'digital' | 'power' | 'ground'; net: string; position?: CircuitPosition } }
  | { op: 'place_module_instance'; component_id: string; module_ref: { module_id: string; revision?: number }; position: CircuitPosition; rotation?: number }
  | { op: 'set_module_metadata'; name?: string; domain?: 'analog' | 'digital' | 'mixed_boundary' | 'testbench' };

export interface Transaction {
  schema: 'actoviq.command.v2';
  command_id: string;
  actor: string;
  project_id: string;
  module_id: string;
  base_revision: number;
  expected_module_revision?: number;
  operations: TransactionOperation[];
  message?: string;
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

function applyOperation(module: CircuitModule, operation: TransactionOperation): { module: CircuitModule; inverse: TransactionOperation[]; affected: string[] } {
  switch (operation.op) {
    case 'place_component': {
      const next = clone(module);
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
      for (const component of next.components) {
        if (operation.entity_ids.includes(component.id)) {
          component.position = { x: component.position.x + operation.delta.x, y: component.position.y + operation.delta.y };
          moved.push(component.id);
        }
      }
      const inverseDelta = { x: -operation.delta.x, y: -operation.delta.y };
      return { module: next, inverse: [{ op: 'move_entities', entity_ids: moved, delta: inverseDelta, mode: operation.mode }], affected: moved };
    }
    case 'delete_entities': {
      const next = clone(module);
      const deleted: CircuitComponent[] = [];
      next.components = next.components.filter((c) => {
        if (operation.entity_ids.includes(c.id)) { deleted.push(c); return false; }
        return true;
      });
      const deletedWires = (next.wires ?? []).filter((w) => operation.entity_ids.includes(w.id));
      next.wires = (next.wires ?? []).filter((w) => !operation.entity_ids.includes(w.id));
      const inverse: TransactionOperation[] = [
        ...deleted.map((c) => ({ op: 'place_component' as const, component: clone(c) })),
        ...deletedWires.map((w) => ({ op: 'create_wire' as const, wire_id: w.id, points: clone(w.points), net: w.net ?? '0', from: w.from, to: w.to })),
      ];
      return { module: next, inverse, affected: operation.entity_ids };
    }
    case 'create_wire': {
      const next = clone(module);
      const wire = { id: operation.wire_id, points: clone(operation.points), from: undefined, to: undefined, net: operation.net, source: 'stored' as const };
      next.wires = [...(next.wires ?? []), wire];
      return { module: next, inverse: [{ op: 'delete_entities', entity_ids: [operation.wire_id] }], affected: [operation.wire_id] };
    }
    case 'edit_wire_path': {
      const next = clone(module);
      const wire = (next.wires ?? []).find((w) => w.id === operation.wire_id);
      if (!wire) throw new Error(`edit_wire_path: wire ${operation.wire_id} not found`);
      const beforePoints = clone(wire.points);
      wire.points = clone(operation.points);
      return { module: next, inverse: [{ op: 'edit_wire_path', wire_id: operation.wire_id, points: beforePoints }], affected: [operation.wire_id] };
    }
    case 'split_wire': {
      const next = clone(module);
      const wire = (next.wires ?? []).find((w) => w.id === operation.wire_id);
      if (!wire) throw new Error(`split_wire: wire ${operation.wire_id} not found`);
      const points = wire.points;
      // Find the segment whose bounding box contains the split point, then
      // insert the point at that position. M3 will add junction-aware splitting.
      let splitIdx = -1;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const withinX = operation.point.x >= Math.min(a.x, b.x) - 0.001 && operation.point.x <= Math.max(a.x, b.x) + 0.001;
        const withinY = operation.point.y >= Math.min(a.y, b.y) - 0.001 && operation.point.y <= Math.max(a.y, b.y) + 0.001;
        if (withinX && withinY) { splitIdx = i; break; }
      }
      if (splitIdx < 0) throw new Error(`split_wire: point not on wire ${operation.wire_id}`);
      const beforePoints = clone(points);
      points.splice(splitIdx, 0, clone(operation.point));
      return { module: next, inverse: [{ op: 'edit_wire_path', wire_id: operation.wire_id, points: beforePoints }], affected: [operation.wire_id] };
    }
    case 'join_wires': {
      const next = clone(module);
      const firstId = operation.wire_ids[0];
      const secondId = operation.wire_ids[1];
      if (!firstId || !secondId) throw new Error('join_wires: requires at least two wire ids');
      const first = (next.wires ?? []).find((w) => w.id === firstId);
      const second = (next.wires ?? []).find((w) => w.id === secondId);
      if (!first || !second) throw new Error(`join_wires: wire not found`);
      const restIds = operation.wire_ids.slice(2);
      const beforeFirst = clone(first.points);
      const beforeSecond = clone(second.points);
      first.points = [...first.points, ...second.points.slice(1)];
      next.wires = (next.wires ?? []).filter((w) => w.id !== secondId && !restIds.includes(w.id));
      return { module: next, inverse: [
        { op: 'edit_wire_path', wire_id: firstId, points: beforeFirst },
        { op: 'create_wire', wire_id: secondId, points: beforeSecond, net: second.net ?? '0' },
      ], affected: [firstId, secondId] };
    }
    case 'upsert_junction': {
      // Junctions are represented as wire endpoints with junction_id; M3 will
      // add first-class junction entities. For now this is a no-op marker.
      return { module: clone(module), inverse: [{ op: 'upsert_junction', junction_id: operation.junction_id, point: operation.point, net: operation.net }], affected: [operation.junction_id] };
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
        pins: [],
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
  if (transaction.base_revision !== module.revision) {
    throw new Error(`applyTransaction: stale base_revision (transaction=${transaction.base_revision}, module=${module.revision})`);
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

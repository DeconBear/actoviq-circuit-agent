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
      return { module: next, inverse: deleted.map((c) => ({ op: 'place_component', component: clone(c) })), affected: deleted.map((c) => c.id) };
    }
    default:
      throw new Error(`applyOperation: op '${operation.op}' not implemented in M1-03; deferred to M2`);
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

/**
 * Topology mutation commit (M3-04).
 *
 * Converts a topology mutation plan (from planTopologyMutation) into a v2
 * transaction that applyTransaction can reduce. Pure: returns a transaction,
 * does not apply it. The UI calls applyTransaction(module, transaction) to
 * commit; a cancel never reaches this path.
 *
 * Plan §4.1.1: Move maintains connections and preview; Free Move proactively
 * decouples unselected connections; Stretch keeps connections attached.
 */

import type { CircuitModule, CircuitPosition } from '../../types';
import { applyTransaction, type Transaction, type TransactionOperation } from '../commands/applyTransaction';
import type { TopologyMutation } from './topologyPlanner';

/**
 * Build a v2 transaction from a topology mutation plan. The transaction's
 * base_revision must match the module the caller will apply it to.
 */
export function mutationToTransaction(
  mutation: TopologyMutation,
  context: {
    module_id: string;
    project_id: string;
    actor: string;
    base_revision: number;
    expected_module_revision: number;
    command_id: string;
    wire_id?: string;
  },
): Transaction {
  const operations = mutationOperations(mutation, context);
  return {
    schema: 'actoviq.command.v2',
    command_id: context.command_id,
    actor: context.actor,
    project_id: context.project_id,
    module_id: context.module_id,
    base_revision: context.base_revision,
    expected_module_revision: context.expected_module_revision,
    message: mutation.label,
    operations,
  };
}

function mutationOperations(
  mutation: TopologyMutation,
  context: { command_id: string; wire_id?: string },
): TransactionOperation[] {
  switch (mutation.kind) {
    case 'move': {
      const moved = mutation.preview.moved ?? [];
      if (moved.length === 0) return [];
      // Compute the delta from the first moved entity; all moved entities
      // share the same delta because the planner applies one gesture delta.
      const first = moved[0]!;
      const delta: CircuitPosition = { x: first.to.x - first.from.x, y: first.to.y - first.from.y };
      return [{
        op: 'move_entities',
        entity_ids: moved.map((m) => m.id),
        delta,
        mode: mutation.moveMode ?? 'free',
      }];
    }
    case 'connect': {
      const wire = mutation.preview.newWire;
      if (!wire) return [];
      return [{
        op: 'create_wire',
        wire_id: context.wire_id ?? `w_${context.command_id.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
        points: wire.points,
        from: wire.from,
        to: wire.to,
        net: wire.net,
        net_id: wire.net_id,
      }];
    }
    case 'split': {
      const junction = mutation.preview.junction;
      if (!junction || mutation.entity_ids.length === 0) return [];
      return [{
        op: 'split_wire',
        wire_id: mutation.entity_ids[0]!,
        point: junction.position,
        junction_id: `j_${context.command_id.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      }];
    }
    case 'join': {
      if (mutation.entity_ids.length < 2) return [];
      return [{ op: 'join_wires', wire_ids: mutation.entity_ids }];
    }
    case 'delete': {
      return [{ op: 'delete_entities', entity_ids: mutation.entity_ids }];
    }
    default:
      return [];
  }
}

/**
 * Convenience: plan + commit in one call for a move gesture. Returns the
 * next module after applying the transaction, or the original module if the
 * plan produced no mutations.
 */
export function commitMove(
  module: CircuitModule,
  gesture: { entity_ids: string[]; delta: CircuitPosition; mode: 'free' | 'stretch' },
  context: {
    module_id: string;
    project_id: string;
    actor: string;
    command_id: string;
    base_revision: number;
  },
): { module: CircuitModule; ok: boolean } {
  // Reuse the applyTransaction reducer directly for the move; the planner's
  // preview is for the UI, the reducer's inverse is for undo.
  const tx: Transaction = {
    schema: 'actoviq.command.v2',
    command_id: context.command_id,
    actor: context.actor,
    project_id: context.project_id,
    module_id: context.module_id,
    base_revision: context.base_revision,
    expected_module_revision: module.revision,
    message: gesture.mode === 'stretch' ? 'Stretch connected' : 'Move free',
    operations: [{
      op: 'move_entities',
      entity_ids: gesture.entity_ids,
      delta: gesture.delta,
      mode: gesture.mode,
    }],
  };
  return applyTransaction(module, tx);
}

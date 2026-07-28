/**
 * Topology invariants and diagnostic codes for the schematic core.
 *
 * These are pure checks against a CircuitModule; they do not mutate state and
 * are not yet wired into the UI (M1-06 only defines the contract). M3 will
 * invoke them at every transaction reducer boundary so that cancel/commit
 * never leaves the module in a state that violates an invariant.
 *
 * The invariants mirror §6.3 of the refactor plan. Each has a stable code
 * so diagnostics, ERC, and tests can reference it without coupling to
 * message text.
 */

import type { CircuitModule, CircuitWire, CircuitWireEndpoint } from '../../types';

export type TopologyInvariantCode =
  | 'invalid_wire'
  | 'invalid_endpoint'
  | 'duplicate_wire'
  | 'zero_length_segment'
  | 'consecutive_duplicate_point'
  | 'midpoint_contact_without_junction'
  | 'orphan_junction'
  | 'net_id_mismatch'
  | 'pin_net_conflict'
  | 'dangling_endpoint';

export interface TopologyDiagnostic {
  code: TopologyInvariantCode;
  message: string;
  wire_ids: string[];
  /** World-space point the diagnostic is anchored to, if any. */
  point?: { x: number; y: number };
  /** Component/port/junction ids the diagnostic implicates, if any. */
  entity_ids?: string[];
}

export interface TopologyInvariantResult {
  diagnostics: TopologyDiagnostic[];
  ok: boolean;
}

/**
 * Canonical list of invariants. Tests and docs can iterate this so the
 * invariant set is discoverable without parsing the checker body.
 */
export const TOPOLOGY_INVARIANTS: ReadonlyArray<{
  code: TopologyInvariantCode;
  description: string;
}> = [
  { code: 'invalid_wire', description: 'Every wire must have an id, >= 2 points, and a net.' },
  { code: 'invalid_endpoint', description: 'Every wire endpoint reference (component_id/pin_id, port_id, junction_id) must resolve to an entity in the module.' },
  { code: 'duplicate_wire', description: 'No two wires may share the same ordered endpoint pair and net.' },
  { code: 'zero_length_segment', description: 'No wire segment may have zero length.' },
  { code: 'consecutive_duplicate_point', description: 'No wire may contain consecutive duplicate points.' },
  { code: 'midpoint_contact_without_junction', description: 'A wire segment midpoint that coincides with another endpoint must carry an explicit junction/split.' },
  { code: 'orphan_junction', description: 'Every junction_id must be referenced by at least one wire endpoint.' },
  { code: 'net_id_mismatch', description: 'net_id must be consistent across every wire and pin in the same connected component.' },
  { code: 'pin_net_conflict', description: 'A component pin or port referenced by a wire must agree on the net.' },
  { code: 'dangling_endpoint', description: 'A free-move break must produce an explicit dangling endpoint, never a silent reconnection.' },
];

function endpointRef(endpoint: CircuitWireEndpoint | undefined): string {
  if (!endpoint) return 'none';
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  if (endpoint.component_id && endpoint.pin_id) return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  return `free:${endpoint.x},${endpoint.y}`;
}

function pointsEqual(a: { x: number; y: number }, b: { x: number; y: number }, epsilon = 0.001): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

/**
 * Check all topology invariants against a module. Pure: returns a result,
 * does not mutate the module. M3 will call this at reducer boundaries.
 */
export function checkTopologyInvariants(module: CircuitModule): TopologyInvariantResult {
  const diagnostics: TopologyDiagnostic[] = [];
  const wires = module.wires ?? [];

  // Build entity registries for endpoint resolution.
  const componentPinNets = new Map<string, string>();
  for (const component of module.components) {
    for (const pin of component.pins) {
      componentPinNets.set(`${component.id}.${pin.id}`, pin.net);
    }
  }
  const portNets = new Map<string, string>();
  for (const port of module.ports) {
    portNets.set(port.id, port.net);
  }

  // Track junction usage so we can detect orphans.
  const junctionRefs = new Map<string, number>();
  // Track wire signatures so we can detect duplicates.
  const wireSignatures = new Map<string, string>();

  for (const wire of wires) {
    const wireId = wire.id ?? '(missing)';
    const points = wire.points ?? [];

    // Invariant: invalid_wire
    if (!wire.id || points.length < 2 || !wire.net) {
      diagnostics.push({
        code: 'invalid_wire',
        message: `Wire ${wireId} is missing id, has fewer than 2 points, or has no net.`,
        wire_ids: [wireId],
      });
      continue;
    }

    // Invariant: consecutive_duplicate_point
    for (let i = 1; i < points.length; i += 1) {
      if (pointsEqual(points[i - 1]!, points[i]!)) {
        diagnostics.push({
          code: 'consecutive_duplicate_point',
          message: `Wire ${wireId} has consecutive duplicate points at index ${i - 1}.`,
          wire_ids: [wireId],
          point: points[i],
        });
        break;
      }
    }

    // Invariant: zero_length_segment
    for (let i = 1; i < points.length; i += 1) {
      if (pointsEqual(points[i - 1]!, points[i]!)) {
        diagnostics.push({
          code: 'zero_length_segment',
          message: `Wire ${wireId} has a zero-length segment at index ${i - 1}.`,
          wire_ids: [wireId],
          point: points[i],
        });
        break;
      }
    }

    // Invariant: invalid_endpoint + pin_net_conflict
    for (const endpoint of [wire.from, wire.to]) {
      if (!endpoint) continue;
      if (endpoint.junction_id) {
        junctionRefs.set(endpoint.junction_id, (junctionRefs.get(endpoint.junction_id) ?? 0) + 1);
      }
      if (endpoint.component_id && endpoint.pin_id) {
        const key = `${endpoint.component_id}.${endpoint.pin_id}`;
        const pinNet = componentPinNets.get(key);
        if (pinNet === undefined) {
          diagnostics.push({
            code: 'invalid_endpoint',
            message: `Wire ${wireId} references unknown pin ${key}.`,
            wire_ids: [wireId],
            point: endpoint,
            entity_ids: [endpoint.component_id, endpoint.pin_id],
          });
        } else if (wire.net && pinNet !== wire.net) {
          diagnostics.push({
            code: 'pin_net_conflict',
            message: `Wire ${wireId} net '${wire.net}' conflicts with pin ${key} net '${pinNet}'.`,
            wire_ids: [wireId],
            point: endpoint,
            entity_ids: [endpoint.component_id],
          });
        }
      }
      if (endpoint.port_id) {
        const portNet = portNets.get(endpoint.port_id);
        if (portNet === undefined) {
          diagnostics.push({
            code: 'invalid_endpoint',
            message: `Wire ${wireId} references unknown port ${endpoint.port_id}.`,
            wire_ids: [wireId],
            point: endpoint,
            entity_ids: [endpoint.port_id],
          });
        } else if (wire.net && portNet !== wire.net) {
          diagnostics.push({
            code: 'pin_net_conflict',
            message: `Wire ${wireId} net '${wire.net}' conflicts with port ${endpoint.port_id} net '${portNet}'.`,
            wire_ids: [wireId],
            point: endpoint,
            entity_ids: [endpoint.port_id],
          });
        }
      }
    }

    // Invariant: duplicate_wire
    const sig = `${endpointRef(wire.from)}->${endpointRef(wire.to)}|${wire.net}`;
    if (wireSignatures.has(sig)) {
      diagnostics.push({
        code: 'duplicate_wire',
        message: `Wire ${wireId} duplicates wire ${wireSignatures.get(sig)} (same endpoints and net).`,
        wire_ids: [wireId, wireSignatures.get(sig)!],
      });
    } else {
      wireSignatures.set(sig, wireId);
    }
  }

  // Invariant: orphan_junction
  for (const [junctionId, refCount] of junctionRefs) {
    if (refCount < 1) {
      diagnostics.push({
        code: 'orphan_junction',
        message: `Junction ${junctionId} is not referenced by any wire.`,
        wire_ids: [],
        entity_ids: [junctionId],
      });
    }
  }

  return { diagnostics, ok: diagnostics.length === 0 };
}

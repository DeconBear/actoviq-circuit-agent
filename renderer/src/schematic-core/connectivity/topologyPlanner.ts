/**
 * Topology mutation planner (M3-03).
 *
 * planTopologyMutation(module, gesture) returns a pure mutation plan:
 * { preview, mutations, diagnostics } without touching the module. The UI
 * draws the preview; on commit the mutations become a v2 transaction (M3-04).
 *
 * Plan §4.1.2 (Qucs-S healer): the planner first generates a plan, then the
 * UI previews it, then commit converts it to commands. This separation means
 * a cancel never produces a command or topology change.
 *
 * M3-03 implements the three core gesture kinds:
 *   - move (free): translate entities, break/stretch connections per mode
 *   - connect: propose a wire between two endpoints
 *   - split: propose a junction at a segment midpoint
 */

import type {
  CircuitModule,
  CircuitPosition,
  CircuitWire,
  CircuitWireEndpoint,
} from '../../types';
import { buildSpatialIndex, queryEndpoints, querySegments, type EndpointEntry, type IndexedSegment } from '../connectivity/spatialIndex';

export type MutationKind = 'move' | 'connect' | 'split' | 'join' | 'delete';

export interface TopologyMutation {
  kind: MutationKind;
  /** Electrical move semantics; never infer this from the display label. */
  moveMode?: 'free' | 'stretch';
  /** Entities the mutation affects, for affected-build-scope on commit. */
  entity_ids: string[];
  /** Proposed new wire/point state for preview; commit converts these. */
  preview: {
    moved?: Array<{ id: string; from: CircuitPosition; to: CircuitPosition }>;
    newWire?: {
      net: string;
      net_id: string;
      points: CircuitPosition[];
      from: CircuitWireEndpoint;
      to: CircuitWireEndpoint;
    };
    junction?: { position: CircuitPosition; net: string };
  };
  /** Human-readable label for the status bar. */
  label: string;
}

export interface TopologyGesture {
  kind: 'move' | 'connect' | 'split';
  /** World-space anchor for the gesture. */
  point: CircuitPosition;
  /** For move: entities being dragged and the delta. */
  entity_ids?: string[];
  delta?: CircuitPosition;
  mode?: 'free' | 'stretch';
  /** For connect: the source endpoint to connect from. */
  source?: EndpointEntry;
}

export interface TopologyPlanResult {
  preview: TopologyMutation['preview'];
  mutations: TopologyMutation[];
  diagnostics: Array<{ code: string; message: string }>;
}

function pointsEqual(a: CircuitPosition, b: CircuitPosition, epsilon = 0.001): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

/**
 * Plan a topology mutation for a gesture. Pure: returns a plan, does not
 * mutate the module. The UI previews the plan; commit (M3-04) applies it.
 */
export function planTopologyMutation(module: CircuitModule, gesture: TopologyGesture): TopologyPlanResult {
  const wires = module.wires ?? [];
  const pins: EndpointEntry[] = [];
  for (const component of module.components) {
    for (const pin of component.pins) {
      // Approximate pin world position from component position; the real
      // projection supplies exact positions via buildSpatialIndex caller.
      // For the planner we only need pins the gesture could connect to.
      pins.push({
        kind: 'pin',
        position: component.position,
        ref: `pin:${component.id}.${pin.id}`,
        net: pin.net,
        net_id: pin.net_id,
        endpoint: {
          x: component.position.x,
          y: component.position.y,
          component_id: component.id,
          pin_id: pin.id,
        },
      });
    }
  }
  const index = buildSpatialIndex(wires, pins, module.ports.map((p) => ({
    kind: 'port' as const,
    position: p.position ?? { x: 0, y: 0 },
    ref: `port:${p.id}`,
    net: p.net,
    net_id: p.net_id,
    endpoint: {
      x: p.position?.x ?? 0,
      y: p.position?.y ?? 0,
      port_id: p.id,
    },
  })));

  switch (gesture.kind) {
    case 'move': {
      const ids = gesture.entity_ids ?? [];
      const delta = gesture.delta ?? { x: 0, y: 0 };
      const moved = module.components
        .filter((c) => ids.includes(c.id))
        .map((c) => ({ id: c.id, from: c.position, to: { x: c.position.x + delta.x, y: c.position.y + delta.y } }));
      const diagnostics: Array<{ code: string; message: string }> = [];
      if (gesture.mode === 'free') {
        // Free move: warn about broken connections. M3-04 will emit explicit
        // dangling endpoints instead of silently reconnecting.
        for (const wire of wires) {
          for (const ep of [wire.from, wire.to]) {
            if (ep?.component_id && ids.includes(ep.component_id)) {
              diagnostics.push({
                code: 'dangling_endpoint',
                message: `Free move breaks wire ${wire.id} connection to ${ep.component_id}.${ep.pin_id}; commit will leave a dangling endpoint.`,
              });
            }
          }
        }
      }
      return {
        preview: { moved },
        mutations: [{
          kind: 'move',
          moveMode: gesture.mode ?? 'free',
          entity_ids: ids,
          preview: { moved },
          label: gesture.mode === 'stretch' ? 'Stretch connected' : 'Move free',
        }],
        diagnostics,
      };
    }

    case 'connect': {
      const source = gesture.source;
      const candidates = queryEndpoints(index, gesture.point, 20);
      const target = candidates.find((c) => c.ref !== source?.ref);
      if (!target) {
        return {
          preview: {},
          mutations: [],
          diagnostics: [{ code: 'no_target', message: 'No connectable endpoint near the cursor.' }],
        };
      }
      const net = source?.net ?? target.net ?? '0';
      const netId = source?.net_id ?? target.net_id;
      if (!source?.endpoint || !target.endpoint || !netId) {
        return {
          preview: {},
          mutations: [],
          diagnostics: [{
            code: 'unidentified_target',
            message: 'Both wire endpoints and the stable net id must be identified before commit.',
          }],
        };
      }
      const points = source ? [source.position, target.position] : [gesture.point, target.position];
      const newWire = {
        net,
        net_id: netId,
        points,
        from: { ...source.endpoint, x: points[0]!.x, y: points[0]!.y },
        to: { ...target.endpoint, x: points.at(-1)!.x, y: points.at(-1)!.y },
      };
      return {
        preview: { newWire },
        mutations: [{
          kind: 'connect',
          entity_ids: [source?.ref ?? 'free', target.ref],
          preview: { newWire },
          label: `Connect ${source?.ref ?? 'free'} -> ${target.ref}`,
        }],
        diagnostics: [],
      };
    }

    case 'split': {
      const segments = querySegments(index, gesture.point);
      const hit = segments.find((s) => segmentContainsPoint(s, gesture.point));
      if (!hit) {
        return {
          preview: {},
          mutations: [],
          diagnostics: [{ code: 'no_segment', message: 'No wire segment under the cursor to split.' }],
        };
      }
      const wire = wires.find((w) => w.id === hit.wireId);
      return {
        preview: { junction: { position: gesture.point, net: wire?.net ?? '0' } },
        mutations: [{
          kind: 'split',
          entity_ids: [hit.wireId],
          preview: { junction: { position: gesture.point, net: wire?.net ?? '0' } },
          label: `Split ${hit.wireId} at (${gesture.point.x}, ${gesture.point.y})`,
        }],
        diagnostics: [],
      };
    }

    default:
      return { preview: {}, mutations: [], diagnostics: [{ code: 'unknown_gesture', message: 'Unknown gesture kind.' }] };
  }
}

function segmentContainsPoint(segment: IndexedSegment, point: CircuitPosition, tolerance = 4): boolean {
  // Perpendicular distance from point to the segment.
  const { start, end } = segment;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return pointsEqual(start, point, tolerance);
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = start.x + t * dx;
  const py = start.y + t * dy;
  const dist2 = (point.x - px) ** 2 + (point.y - py) ** 2;
  return dist2 <= tolerance * tolerance;
}

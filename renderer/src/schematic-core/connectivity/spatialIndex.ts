/**
 * Spatial index for schematic connectivity (M3-02).
 *
 * Builds a grid-cell index over pins, wire endpoints, and wire segments so
 * hit-testing and snap candidates are O(1) per cell instead of O(n) per
 * query. Pure: built from a SchematicDocument, no mutation, no React.
 *
 * Plan §6.3: pin, port, wire endpoint, junction are connection nodes; wire
 * segment is an edge. The index lets the topology engine and the snap
 * planner find candidates without scanning every entity.
 */

import type { CircuitPosition, CircuitWire, CircuitWireEndpoint } from '../../types';

export type EndpointKind = 'pin' | 'port' | 'wirepoint' | 'junction';

export interface EndpointEntry {
  kind: EndpointKind;
  /** World-space position. */
  position: CircuitPosition;
  /** Resolved entity reference, e.g. component_id.pin_id or port_id. */
  ref: string;
  /** Net the endpoint belongs to, if known. */
  net?: string;
  /** Stable net identity, when available. */
  net_id?: string;
  /** Identified module endpoint payload used when committing a snapped wire. */
  endpoint?: CircuitWireEndpoint;
  /** Source wire id for wirepoints/junctions. */
  wireId?: string;
  /** Segment index on the source wire, for wirepoints. */
  segmentIndex?: number;
}

export interface IndexedSegment {
  wireId: string;
  segmentIndex: number;
  start: CircuitPosition;
  end: CircuitPosition;
  net?: string;
  net_id?: string;
}

export interface SpatialIndex {
  cellSize: number;
  endpoints: Map<string, EndpointEntry[]>;
  segments: Map<string, IndexedSegment[]>;
  endpointCount: number;
  segmentCount: number;
}

function cellKey(point: CircuitPosition, cellSize: number): string {
  return `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
}

function cellsForSegment(start: CircuitPosition, end: CircuitPosition, cellSize: number): string[] {
  // Collect every cell the segment's bounding box covers. Sufficient for
  // hit-testing; a precise segment intersection check happens on the candidates.
  const minX = Math.floor(Math.min(start.x, end.x) / cellSize);
  const maxX = Math.floor(Math.max(start.x, end.x) / cellSize);
  const minY = Math.floor(Math.min(start.y, end.y) / cellSize);
  const maxY = Math.floor(Math.max(start.y, end.y) / cellSize);
  const keys: string[] = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

function endpointRef(endpoint: CircuitWireEndpoint | undefined): string {
  if (!endpoint) return '';
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  if (endpoint.component_id && endpoint.pin_id) return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  return `free:${endpoint.x},${endpoint.y}`;
}

/**
 * Build a spatial index from wires + explicit endpoint lists. The caller
 * supplies pins and ports because they live on components/ports, not wires.
 */
export function buildSpatialIndex(
  wires: CircuitWire[],
  pins: EndpointEntry[] = [],
  ports: EndpointEntry[] = [],
  cellSize = 40,
): SpatialIndex {
  const endpointCells = new Map<string, EndpointEntry[]>();
  const segmentCells = new Map<string, IndexedSegment[]>();
  let endpointCount = 0;
  let segmentCount = 0;

  const addEndpoint = (entry: EndpointEntry) => {
    const key = cellKey(entry.position, cellSize);
    const list = endpointCells.get(key) ?? [];
    list.push(entry);
    endpointCells.set(key, list);
    endpointCount += 1;
  };

  for (const pin of pins) addEndpoint(pin);
  for (const port of ports) addEndpoint(port);

  for (const wire of wires) {
    const points = wire.points ?? [];
    // Index every wire vertex as a wirepoint endpoint.
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i]!;
      const isEndpoint = i === 0 || i === points.length - 1;
      const ref = isEndpoint ? endpointRef(i === 0 ? wire.from : wire.to) : `wirepoint:${wire.id}:${i}`;
      addEndpoint({
        kind: isEndpoint ? (wire.from?.junction_id || wire.to?.junction_id ? 'junction' : 'wirepoint') : 'wirepoint',
        position: point,
        ref,
        net: wire.net,
        net_id: wire.net_id,
        endpoint: isEndpoint ? { ...(i === 0 ? wire.from : wire.to)! } : undefined,
        wireId: wire.id,
        segmentIndex: isEndpoint ? undefined : i - 1,
      });
    }
    // Index every segment by the cells its bounding box covers.
    for (let i = 1; i < points.length; i += 1) {
      const start = points[i - 1]!;
      const end = points[i]!;
      const segment: IndexedSegment = {
        wireId: wire.id,
        segmentIndex: i - 1,
        start,
        end,
        net: wire.net,
        net_id: wire.net_id,
      };
      for (const key of cellsForSegment(start, end, cellSize)) {
        const list = segmentCells.get(key) ?? [];
        list.push(segment);
        segmentCells.set(key, list);
        segmentCount += 1;
      }
    }
  }

  return { cellSize, endpoints: endpointCells, segments: segmentCells, endpointCount, segmentCount };
}

/**
 * Find endpoints within `radius` of a point. Returns candidates sorted by
 * distance so the snap planner can pick the closest.
 */
export function queryEndpoints(index: SpatialIndex, point: CircuitPosition, radius: number): EndpointEntry[] {
  const r2 = radius * radius;
  const minCellX = Math.floor((point.x - radius) / index.cellSize);
  const maxCellX = Math.floor((point.x + radius) / index.cellSize);
  const minCellY = Math.floor((point.y - radius) / index.cellSize);
  const maxCellY = Math.floor((point.y + radius) / index.cellSize);
  const candidates: Array<{ entry: EndpointEntry; dist2: number }> = [];
  for (let cx = minCellX; cx <= maxCellX; cx += 1) {
    for (let cy = minCellY; cy <= maxCellY; cy += 1) {
      const list = index.endpoints.get(`${cx},${cy}`);
      if (!list) continue;
      for (const entry of list) {
        const dx = entry.position.x - point.x;
        const dy = entry.position.y - point.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= r2) candidates.push({ entry, dist2 });
      }
    }
  }
  candidates.sort((a, b) => a.dist2 - b.dist2);
  return candidates.map((c) => c.entry);
}

/**
 * Find segments whose bounding box overlaps the query point's cell. The
 * caller does the precise segment intersection test on the candidates.
 */
export function querySegments(index: SpatialIndex, point: CircuitPosition): IndexedSegment[] {
  const key = cellKey(point, index.cellSize);
  const list = index.segments.get(key);
  return list ? [...list] : [];
}

import type {
  CircuitModule,
  CircuitPosition,
  CircuitWire,
  CircuitWireEndpoint,
} from '../../types';

export interface WireTopologyResult {
  module: CircuitModule;
  affectedWireIds: string[];
  createdWireIds: string[];
  removedWireIds: string[];
  createdNetId?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  const cross = (
    (right.x - left.x) * (point.y - left.y)
    - (right.y - left.y) * (point.x - left.x)
  );
  return (
    point.x >= Math.min(left.x, right.x) - epsilon
    && point.x <= Math.max(left.x, right.x) + epsilon
    && point.y >= Math.min(left.y, right.y) - epsilon
    && point.y <= Math.max(left.y, right.y) + epsilon
    && Math.abs(cross) <= epsilon
  );
}

function compactPoints(points: CircuitPosition[]): CircuitPosition[] {
  const compact: CircuitPosition[] = [];
  for (const point of points) {
    const previous = compact.at(-1);
    if (previous && samePoint(previous, point)) continue;
    const beforePrevious = compact.at(-2);
    if (
      beforePrevious
      && previous
      && (
        (beforePrevious.x === previous.x && previous.x === point.x)
        || (beforePrevious.y === previous.y && previous.y === point.y)
      )
    ) {
      compact[compact.length - 1] = { ...point };
    } else {
      compact.push({ ...point });
    }
  }
  return compact;
}

function identifiedEndpoint(
  point: CircuitPosition,
  junctionId: string,
): CircuitWireEndpoint {
  return { ...point, junction_id: junctionId };
}

function retractCutEnd(
  point: CircuitPosition,
  neighbor: CircuitPosition,
): CircuitPosition {
  const dx = neighbor.x - point.x;
  const dy = neighbor.y - point.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.01) throw new Error('cut point is too close to a wire vertex');
  const distance = Math.min(6, length / 3);
  return {
    x: point.x + (dx / length) * distance,
    y: point.y + (dy / length) * distance,
  };
}

function endpointKey(endpoint: CircuitWireEndpoint | undefined): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) {
    return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  }
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  return '';
}

function uniqueId(base: string, existing: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function splitPointIndex(points: CircuitPosition[], point: CircuitPosition): {
  points: CircuitPosition[];
  index: number;
} {
  const existingIndex = points.findIndex((candidate) => samePoint(candidate, point));
  if (existingIndex >= 0) return { points: clone(points), index: existingIndex };
  const segmentIndex = points.findIndex((right, index) => (
    index > 0 && pointOnSegment(point, points[index - 1]!, right)
  ));
  if (segmentIndex < 1) throw new Error('point is not on the selected wire');
  const next = clone(points);
  next.splice(segmentIndex, 0, clone(point));
  return { points: next, index: segmentIndex };
}

function requireWire(module: CircuitModule, wireId: string): CircuitWire {
  const wire = (module.wires ?? []).find((candidate) => candidate.id === wireId);
  if (!wire) throw new Error(`wire ${wireId} not found`);
  if (!wire.from || !wire.to || !wire.net || !wire.net_id || wire.points.length < 2) {
    throw new Error(`wire ${wireId} is missing identified topology`);
  }
  return wire;
}

export function splitWireTopology(
  source: CircuitModule,
  wireId: string,
  point: CircuitPosition,
  junctionId: string,
): WireTopologyResult {
  const module = clone(source);
  const wire = requireWire(module, wireId);
  const split = splitPointIndex(wire.points, point);
  if (split.index <= 0 || split.index >= split.points.length - 1) {
    throw new Error('split point must be inside the wire');
  }
  const existingIds = new Set((module.wires ?? []).map((candidate) => candidate.id));
  const rightId = uniqueId(`${wire.id}__${junctionId}`, existingIds);
  const originalTo = clone(wire.to!);
  const junction = identifiedEndpoint(point, junctionId);
  const right: CircuitWire = {
    ...clone(wire),
    id: rightId,
    points: compactPoints([clone(point), ...split.points.slice(split.index + 1)]),
    from: clone(junction),
    to: originalTo,
    source: 'stored',
  };
  wire.points = compactPoints([...split.points.slice(0, split.index), clone(point)]);
  wire.to = clone(junction);
  wire.source = 'stored';
  module.wires = [...(module.wires ?? []), right];
  return {
    module,
    affectedWireIds: [wire.id, rightId],
    createdWireIds: [rightId],
    removedWireIds: [],
  };
}

export function cutWireTopology(
  source: CircuitModule,
  wireId: string,
  point: CircuitPosition,
): WireTopologyResult {
  const module = clone(source);
  const wire = requireWire(module, wireId);
  const split = splitPointIndex(wire.points, point);
  if (split.index <= 0 || split.index >= split.points.length - 1) {
    throw new Error('cut point must be inside the wire');
  }
  const fromKey = endpointKey(wire.from);
  const toKey = endpointKey(wire.to);
  const otherWires = (module.wires ?? []).filter((candidate) => candidate.id !== wire.id);
  const reachableWireIds = new Set<string>();
  const reachableNodes = new Set<string>(toKey ? [toKey] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of otherWires) {
      if (reachableWireIds.has(candidate.id)) continue;
      const left = endpointKey(candidate.from);
      const right = endpointKey(candidate.to);
      if (
        (left && reachableNodes.has(left))
        || (right && reachableNodes.has(right))
      ) {
        reachableWireIds.add(candidate.id);
        if (left) reachableNodes.add(left);
        if (right) reachableNodes.add(right);
        changed = true;
      }
    }
  }
  if (fromKey && reachableNodes.has(fromKey)) {
    throw new Error('cut would not disconnect this cyclic net');
  }

  const netIds = new Set((module.nets ?? []).map((net) => net.id));
  const netNames = new Set((module.nets ?? []).map((net) => net.name));
  const newNetId = uniqueId(`net_cut_${wire.id}`, netIds);
  const newNetName = uniqueId(`n_cut_${wire.id}`, netNames);
  const oldNet = (module.nets ?? []).find((net) => net.id === wire.net_id);
  module.nets = [
    ...(module.nets ?? []),
    {
      id: newNetId,
      name: newNetName,
      kind: oldNet?.kind ?? 'signal',
      aliases: [],
    },
  ];

  const existingWireIds = new Set((module.wires ?? []).map((candidate) => candidate.id));
  const rightId = uniqueId(`${wire.id}__cut`, existingWireIds);
  const leftPoints = [...split.points.slice(0, split.index), clone(point)];
  const rightPoints = [clone(point), ...split.points.slice(split.index + 1)];
  const leftCutEnd = retractCutEnd(point, leftPoints.at(-2)!);
  const rightCutEnd = retractCutEnd(point, rightPoints[1]!);
  leftPoints[leftPoints.length - 1] = leftCutEnd;
  rightPoints[0] = rightCutEnd;
  const existingJunctionIds = new Set(
    (module.wires ?? [])
      .flatMap((candidate) => [candidate.from?.junction_id, candidate.to?.junction_id])
      .filter((id): id is string => Boolean(id)),
  );
  const leftJunctionId = uniqueId(`j_cut_${wire.id}_left`, existingJunctionIds);
  const rightJunctionId = uniqueId(`j_cut_${wire.id}_right`, existingJunctionIds);
  const leftJunction = identifiedEndpoint(leftCutEnd, leftJunctionId);
  const rightJunction = identifiedEndpoint(rightCutEnd, rightJunctionId);
  const originalTo = clone(wire.to!);
  const right: CircuitWire = {
    ...clone(wire),
    id: rightId,
    points: compactPoints(rightPoints),
    from: rightJunction,
    to: originalTo,
    net: newNetName,
    net_id: newNetId,
    source: 'stored',
  };
  wire.points = compactPoints(leftPoints);
  wire.to = leftJunction;
  wire.source = 'stored';
  module.wires = [...(module.wires ?? []), right];

  const rightSideWireIds = new Set([...reachableWireIds, rightId]);
  for (const candidate of module.wires) {
    if (!rightSideWireIds.has(candidate.id)) continue;
    candidate.net = newNetName;
    candidate.net_id = newNetId;
  }
  const rightEndpoints = module.wires
    .filter((candidate) => rightSideWireIds.has(candidate.id))
    .flatMap((candidate) => [candidate.from, candidate.to])
    .filter((endpoint): endpoint is CircuitWireEndpoint => Boolean(endpoint));
  for (const endpoint of rightEndpoints) {
    if (endpoint.component_id && endpoint.pin_id) {
      const component = module.components.find((candidate) => candidate.id === endpoint.component_id);
      const pin = component?.pins.find((candidate) => candidate.id === endpoint.pin_id);
      if (pin) {
        pin.net = newNetName;
        pin.net_id = newNetId;
      }
    }
    if (endpoint.port_id) {
      const port = module.ports.find((candidate) => candidate.id === endpoint.port_id);
      if (port) {
        port.net = newNetName;
        port.net_id = newNetId;
      }
    }
  }

  return {
    module,
    affectedWireIds: [wire.id, ...rightSideWireIds],
    createdWireIds: [rightId],
    removedWireIds: [],
    createdNetId: newNetId,
  };
}

export function collapseWireTopology(
  source: CircuitModule,
  wireId: string,
): WireTopologyResult {
  const module = clone(source);
  const wire = requireWire(module, wireId);
  const points = compactPoints(wire.points);
  if (points.length < 2) throw new Error('collapse would remove the complete wire');
  wire.points = points;
  wire.from = { ...wire.from!, ...points[0]! };
  wire.to = { ...wire.to!, ...points.at(-1)! };
  return {
    module,
    affectedWireIds: [wire.id],
    createdWireIds: [],
    removedWireIds: [],
  };
}

function endpointReferenceCount(module: CircuitModule, key: string): number {
  if (!key) return 0;
  return (module.wires ?? []).reduce((count, wire) => (
    count
    + (endpointKey(wire.from) === key ? 1 : 0)
    + (endpointKey(wire.to) === key ? 1 : 0)
  ), 0);
}

function endpointIsTrimmable(module: CircuitModule, endpoint: CircuitWireEndpoint): boolean {
  if (endpoint.component_id || endpoint.port_id) return false;
  const key = endpointKey(endpoint);
  return !key || endpointReferenceCount(module, key) <= 1;
}

export function trimWireTopology(
  source: CircuitModule,
  wireId: string,
  point: CircuitPosition,
): WireTopologyResult {
  const module = clone(source);
  const wire = requireWire(module, wireId);
  const split = splitPointIndex(wire.points, point);
  if (split.index <= 0 || split.index >= split.points.length - 1) {
    throw new Error('trim point must be inside the wire');
  }
  const fromTrimmable = endpointIsTrimmable(module, wire.from!);
  const toTrimmable = endpointIsTrimmable(module, wire.to!);
  if (!fromTrimmable && !toTrimmable) {
    throw new Error('wire has no dangling end to trim');
  }
  const fromDistance = Math.hypot(point.x - wire.from!.x, point.y - wire.from!.y);
  const toDistance = Math.hypot(point.x - wire.to!.x, point.y - wire.to!.y);
  const trimFrom = fromTrimmable && (!toTrimmable || fromDistance <= toDistance);
  if (trimFrom) {
    wire.points = compactPoints([clone(point), ...split.points.slice(split.index + 1)]);
    wire.from = identifiedEndpoint(point, `j_trim_${wire.id}_from`);
  } else {
    wire.points = compactPoints([...split.points.slice(0, split.index), clone(point)]);
    wire.to = identifiedEndpoint(point, `j_trim_${wire.id}_to`);
  }
  return {
    module,
    affectedWireIds: [wire.id],
    createdWireIds: [],
    removedWireIds: [],
  };
}

export function joinWireTopology(
  source: CircuitModule,
  wireIds: string[],
): WireTopologyResult {
  if (wireIds.length < 2) throw new Error('join requires at least two wires');
  const module = clone(source);
  const selected = wireIds.map((wireId) => requireWire(module, wireId));
  const first = selected[0]!;
  if (selected.some((wire) => wire.net_id !== first.net_id || wire.net !== first.net)) {
    throw new Error('join requires wires on the same net');
  }
  const selectedById = new Map(selected.map((wire) => [wire.id, wire]));
  const endpointCounts = new Map<string, number>();
  for (const wire of selected) {
    for (const key of [endpointKey(wire.from), endpointKey(wire.to)]) {
      if (key) endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
    }
  }
  const terminals = [...endpointCounts]
    .filter(([, count]) => count === 1)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  if (terminals.length !== 2) {
    throw new Error('selected wires do not form one non-branching chain');
  }
  const globalCounts = new Map<string, number>();
  for (const wire of module.wires ?? []) {
    for (const key of [endpointKey(wire.from), endpointKey(wire.to)]) {
      if (key) globalCounts.set(key, (globalCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of endpointCounts) {
    if (count > 1 && (globalCounts.get(key) ?? 0) !== count) {
      throw new Error('cannot join through a junction with an unselected branch');
    }
  }

  const ordered: Array<{ wire: CircuitWire; reversed: boolean }> = [];
  const remaining = new Set(selectedById.keys());
  let cursor = terminals[0]!;
  while (remaining.size > 0) {
    const next = selected.find((wire) => (
      remaining.has(wire.id)
      && (endpointKey(wire.from) === cursor || endpointKey(wire.to) === cursor)
    ));
    if (!next) throw new Error('selected wires are not contiguous');
    const reversed = endpointKey(next.to) === cursor;
    ordered.push({ wire: next, reversed });
    remaining.delete(next.id);
    cursor = reversed ? endpointKey(next.from) : endpointKey(next.to);
  }
  if (cursor !== terminals[1]) throw new Error('selected wires do not terminate cleanly');

  const head = ordered[0]!;
  const resultId = head.wire.id;
  const resultFrom = clone(head.reversed ? head.wire.to! : head.wire.from!);
  const resultPoints: CircuitPosition[] = [];
  let resultTo = resultFrom;
  for (const [index, item] of ordered.entries()) {
    const points = item.reversed
      ? [...item.wire.points].reverse()
      : item.wire.points;
    resultPoints.push(...clone(index === 0 ? points : points.slice(1)));
    resultTo = clone(item.reversed ? item.wire.from! : item.wire.to!);
  }
  const removedWireIds = ordered.slice(1).map((item) => item.wire.id);
  const result = selectedById.get(resultId)!;
  result.points = compactPoints(resultPoints);
  result.from = resultFrom;
  result.to = resultTo;
  result.source = 'stored';
  const removedSet = new Set(removedWireIds);
  module.wires = (module.wires ?? []).filter((wire) => !removedSet.has(wire.id));
  return {
    module,
    affectedWireIds: wireIds,
    createdWireIds: [],
    removedWireIds,
  };
}

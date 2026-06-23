import type {
  CircuitComponent,
  CircuitModule,
  CircuitPin,
  CircuitPort,
  CircuitPosition,
  CircuitWire,
  CircuitWireEndpoint,
} from '../types';

export const SCHEMATIC_GRID = 20;
export const PIN_REACH = 12;

export type ToolComponentType = CircuitComponent['type'];

export type SchematicSelection =
  | { kind: 'component'; id: string }
  | { kind: 'wire'; id: string }
  | null;

export interface EndpointHit extends CircuitWireEndpoint {
  kind: 'pin' | 'port' | 'point';
  label: string;
  net?: string;
}

export interface SchematicBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SchematicDocument {
  schema: 'actoviq.schematic-document.v1';
  moduleId: string;
  moduleName: string;
  module: CircuitModule;
  portPositions: Map<string, CircuitPosition>;
  wires: CircuitWire[];
  bounds: SchematicBounds;
  viewBox: SchematicBounds;
}

export const COMPONENT_TYPES: ToolComponentType[] = ['R', 'C', 'L', 'D', 'M', 'Q', 'V', 'I'];

export const DEFAULT_VALUES: Record<ToolComponentType, string> = {
  R: '1k',
  C: '1n',
  L: '1u',
  D: 'D',
  M: 'NMOS W=1u L=180n',
  Q: 'NPN',
  V: 'DC 1',
  I: 'DC 1m',
};

const PIN_DEFS: Record<ToolComponentType, Array<[string, string]>> = {
  R: [['a', '1'], ['b', '2']],
  C: [['a', '1'], ['b', '2']],
  L: [['a', '1'], ['b', '2']],
  D: [['a', 'A'], ['b', 'K']],
  V: [['p', '+'], ['n', '-']],
  I: [['p', '+'], ['n', '-']],
  Q: [['c', 'C'], ['b', 'B'], ['e', 'E']],
  M: [['d', 'D'], ['g', 'G'], ['s', 'S'], ['b', 'B']],
};

export function cloneModule(module: CircuitModule): CircuitModule {
  return JSON.parse(JSON.stringify(module)) as CircuitModule;
}

export function createSchematicDocument(module: CircuitModule): SchematicDocument {
  const next = cloneModule(module);
  for (const component of next.components) {
    component.rotation = normalizeRotation(component.rotation);
    component.position = snapPoint(component.position);
  }
  const portPositions = computePortPositions(next);
  const wires = materializeNetWires(next, portPositions);
  const bounds = moduleBounds(next, portPositions, wires);
  const viewBox = padBounds(bounds, 70);
  return {
    schema: 'actoviq.schematic-document.v1',
    moduleId: next.module_id,
    moduleName: next.name,
    module: next,
    portPositions,
    wires,
    bounds,
    viewBox,
  };
}

export function snap(value: number): number {
  return Math.round(value / SCHEMATIC_GRID) * SCHEMATIC_GRID;
}

export function snapPoint(point: CircuitPosition): CircuitPosition {
  return { x: snap(point.x), y: snap(point.y) };
}

export function normalizeRotation(value: number | undefined): number {
  const rotation = ((Number(value ?? 0) % 360) + 360) % 360;
  return Math.round(rotation / 90) * 90;
}

export function makeId(prefix: string, existing: Set<string>): string {
  for (let index = 1; index < 10000; index += 1) {
    const id = `${prefix}${index}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}${Date.now()}`;
}

export function makePlacedComponent(
  module: CircuitModule,
  type: ToolComponentType,
  position: CircuitPosition,
): CircuitComponent {
  const existingIds = new Set(module.components.map((component) => component.id));
  const id = makeId(type.toLowerCase(), existingIds);
  const name = `${type}${id.replace(/^[a-z]+/i, '')}`;
  const pins: CircuitPin[] = PIN_DEFS[type].map(([pinId, pinName], index) => ({
    id: pinId,
    name: pinName,
    net: `n_${id}_${index + 1}`,
  }));
  return {
    id,
    type,
    name,
    value: DEFAULT_VALUES[type],
    position,
    rotation: 0,
    pins,
  };
}

export function pinWorld(component: CircuitComponent, pin: CircuitPin, index: number): CircuitPosition {
  const offset = pinOffset(component, pin, index);
  return {
    x: component.position.x + offset.x,
    y: component.position.y + offset.y,
  };
}

export function componentBounds(component: CircuitComponent): SchematicBounds {
  const pins = component.pins.map((pin, index) => pinWorld(component, pin, index));
  const xs = [component.position.x - 52, component.position.x + 52, ...pins.map((pin) => pin.x)];
  const ys = [component.position.y - 52, component.position.y + 52, ...pins.map((pin) => pin.y)];
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function computePortPositions(module: CircuitModule): Map<string, CircuitPosition> {
  const bounds = moduleBounds(module, new Map(), module.wires ?? []);
  const inputs = module.ports.filter((port) => !isGroundPort(port) && port.signal_type !== 'power' && port.direction !== 'output');
  const outputs = module.ports.filter((port) => !isGroundPort(port) && port.direction === 'output');
  const powers = module.ports.filter((port) => !isGroundPort(port) && port.signal_type === 'power');
  const grounds = module.ports.filter(isGroundPort);
  const map = new Map<string, CircuitPosition>();

  inputs.forEach((port, index) => {
    map.set(port.id, snapPoint({ x: bounds.minX - 120, y: bounds.minY + 70 + index * 60 }));
  });
  outputs.forEach((port, index) => {
    map.set(port.id, snapPoint({ x: bounds.maxX + 120, y: bounds.minY + 70 + index * 60 }));
  });
  powers.forEach((port, index) => {
    map.set(port.id, snapPoint({ x: bounds.minX + 110 + index * 110, y: bounds.minY - 90 }));
  });
  grounds.forEach((port, index) => {
    map.set(port.id, snapPoint({ x: bounds.minX + 110 + index * 110, y: bounds.maxY + 100 }));
  });
  return map;
}

export function moduleBounds(
  module: CircuitModule,
  portPositions: Map<string, CircuitPosition>,
  wires: CircuitWire[],
): SchematicBounds {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const component of module.components) {
    const bounds = componentBounds(component);
    xs.push(bounds.minX, bounds.maxX);
    ys.push(bounds.minY, bounds.maxY);
  }
  for (const wire of wires) {
    for (const point of wire.points ?? []) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }
  for (const point of portPositions.values()) {
    xs.push(point.x);
    ys.push(point.y);
  }
  if (xs.length === 0) {
    xs.push(0, 600);
    ys.push(0, 360);
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function padBounds(bounds: SchematicBounds, padding: number): SchematicBounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

export function isGroundPort(port: CircuitPort): boolean {
  const text = `${port.name} ${port.net} ${port.signal_type}`.toLowerCase();
  return port.signal_type === 'ground' || text.includes('gnd') || port.net === '0';
}

export function endpointKey(endpoint: CircuitWireEndpoint | undefined): string | null {
  if (!endpoint) return null;
  if (endpoint.component_id && endpoint.pin_id) return `c:${endpoint.component_id}:${endpoint.pin_id}`;
  if (endpoint.port_id) return `p:${endpoint.port_id}`;
  return null;
}

export function endpointNet(module: CircuitModule, endpoint: CircuitWireEndpoint | undefined): string | null {
  if (!endpoint) return null;
  if (endpoint.component_id && endpoint.pin_id) {
    const component = module.components.find((entry) => entry.id === endpoint.component_id);
    return component?.pins.find((pin) => pin.id === endpoint.pin_id)?.net ?? null;
  }
  if (endpoint.port_id) {
    return module.ports.find((port) => port.id === endpoint.port_id)?.net ?? null;
  }
  return null;
}

export function replaceNet(module: CircuitModule, oldNet: string, newNet: string) {
  if (oldNet === newNet) return;
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net === oldNet) pin.net = newNet;
    }
  }
  for (const port of module.ports) {
    if (port.net === oldNet) port.net = newNet;
  }
  for (const wire of module.wires ?? []) {
    if (wire.net === oldNet) wire.net = newNet;
  }
}

export function chooseMergedNet(left: string | null, right: string | null): string {
  if (left === '0' || right === '0') return '0';
  return left || right || `n_${Date.now()}`;
}

export function addWire(module: CircuitModule, start: EndpointHit, end: EndpointHit) {
  const startPoint = endpointDrawPoint(start);
  const endPoint = endpointDrawPoint(end);
  const leftNet = endpointNet(module, start);
  const rightNet = endpointNet(module, end);
  const mergedNet = chooseMergedNet(leftNet, rightNet);
  if (leftNet && rightNet) {
    replaceNet(module, leftNet === mergedNet ? rightNet : leftNet, mergedNet);
  }
  const id = makeId('w', new Set((module.wires ?? []).map((wire) => wire.id)));
  module.wires = [
    ...(module.wires ?? []),
    {
      id,
      points: routePoints(startPoint, endPoint),
      from: stripEndpoint(startPoint, start),
      to: stripEndpoint(endPoint, end),
      net: mergedNet,
    },
  ];
}

export function routePoints(startPoint: CircuitPosition, endPoint: CircuitPosition): CircuitPosition[] {
  if (startPoint.x === endPoint.x || startPoint.y === endPoint.y) {
    return [startPoint, endPoint];
  }
  const horizontalFirst = Math.abs(endPoint.x - startPoint.x) >= Math.abs(endPoint.y - startPoint.y);
  return horizontalFirst
    ? [startPoint, { x: endPoint.x, y: startPoint.y }, endPoint]
    : [startPoint, { x: startPoint.x, y: endPoint.y }, endPoint];
}

export function stripEndpoint(point: CircuitPosition, endpoint: EndpointHit): CircuitWireEndpoint {
  const value: CircuitWireEndpoint = { x: point.x, y: point.y };
  if (endpoint.component_id && endpoint.pin_id) {
    value.component_id = endpoint.component_id;
    value.pin_id = endpoint.pin_id;
  }
  if (endpoint.port_id) value.port_id = endpoint.port_id;
  return value;
}

export function endpointDrawPoint(endpoint: EndpointHit): CircuitPosition {
  if (endpoint.kind === 'point') return snapPoint(endpoint);
  return { x: endpoint.x, y: endpoint.y };
}

export function normalizeConnectivity(module: CircuitModule): CircuitModule {
  const next = cloneModule(module);
  const parent = new Map<string, string>();
  const nets = new Map<string, string>();

  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    const current = parent.get(key);
    if (current === key || !current) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const component of next.components) {
    for (const pin of component.pins) {
      const key = `c:${component.id}:${pin.id}`;
      find(key);
      nets.set(key, pin.net);
    }
  }
  for (const port of next.ports) {
    const key = `p:${port.id}`;
    find(key);
    nets.set(key, port.net);
  }
  for (const wire of next.wires ?? []) {
    const left = endpointKey(wire.from);
    const right = endpointKey(wire.to);
    if (left && right) union(left, right);
    if (left && wire.net) nets.set(left, wire.net);
    if (right && wire.net) nets.set(right, wire.net);
  }

  const groupNets = new Map<string, string[]>();
  for (const [key, net] of nets) {
    const root = find(key);
    groupNets.set(root, [...(groupNets.get(root) ?? []), net]);
  }
  const chosen = new Map<string, string>();
  for (const [root, candidates] of groupNets) {
    chosen.set(root, candidates.includes('0') ? '0' : candidates.find(Boolean) ?? `n_${root.replace(/[^A-Za-z0-9_]/g, '_')}`);
  }

  for (const component of next.components) {
    for (const pin of component.pins) {
      pin.net = chosen.get(find(`c:${component.id}:${pin.id}`)) ?? pin.net;
    }
  }
  for (const port of next.ports) {
    port.net = chosen.get(find(`p:${port.id}`)) ?? port.net;
  }
  next.wires = (next.wires ?? []).map((wire) => {
    const left = endpointKey(wire.from);
    const right = endpointKey(wire.to);
    const net = (left && chosen.get(find(left))) || (right && chosen.get(find(right))) || wire.net;
    return { ...wire, net };
  });
  return next;
}

export function endpointWorldPosition(
  module: CircuitModule,
  endpoint: CircuitWireEndpoint | undefined,
  portPositions: Map<string, CircuitPosition>,
): CircuitPosition | null {
  if (!endpoint) return null;
  if (endpoint.component_id && endpoint.pin_id) {
    const component = module.components.find((entry) => entry.id === endpoint.component_id);
    if (!component) return { x: endpoint.x, y: endpoint.y };
    const pinIndex = component.pins.findIndex((pin) => pin.id === endpoint.pin_id);
    const pin = pinIndex >= 0 ? component.pins[pinIndex] : undefined;
    if (!pin) return { x: endpoint.x, y: endpoint.y };
    return pinWorld(component, pin, pinIndex);
  }
  if (endpoint.port_id) {
    return portPositions.get(endpoint.port_id) ?? { x: endpoint.x, y: endpoint.y };
  }
  return { x: endpoint.x, y: endpoint.y };
}

export function rerouteWire(
  module: CircuitModule,
  wire: CircuitWire,
  portPositions: Map<string, CircuitPosition>,
): CircuitWire {
  const start = endpointWorldPosition(module, wire.from, portPositions);
  const end = endpointWorldPosition(module, wire.to, portPositions);
  if (!start || !end) return wire;
  return {
    ...wire,
    from: wire.from ? { ...wire.from, x: start.x, y: start.y } : wire.from,
    to: wire.to ? { ...wire.to, x: end.x, y: end.y } : wire.to,
    points: routePoints(start, end),
  };
}

export function rerouteStoredWires(module: CircuitModule): CircuitWire[] {
  const portPositions = computePortPositions(module);
  return (module.wires ?? []).map((wire) => rerouteWire(module, wire, portPositions));
}

export function pointEndpoint(point: CircuitPosition): EndpointHit {
  return { kind: 'point', x: point.x, y: point.y, label: `${point.x},${point.y}` };
}

export function hitEndpoint(document: SchematicDocument, world: CircuitPosition): EndpointHit | null {
  for (const component of document.module.components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      if (!pin) continue;
      const point = pinWorld(component, pin, index);
      if (distance(point, world) <= PIN_REACH) {
        return {
          kind: 'pin',
          x: point.x,
          y: point.y,
          component_id: component.id,
          pin_id: pin.id,
          label: `${component.name}.${pin.name}`,
          net: pin.net,
        };
      }
    }
  }
  for (const port of document.module.ports) {
    const point = document.portPositions.get(port.id);
    if (point && distance(point, world) <= PIN_REACH + 3) {
      return {
        kind: 'port',
        x: point.x,
        y: point.y,
        port_id: port.id,
        label: port.name,
        net: port.net,
      };
    }
  }
  return null;
}

export function hitComponent(document: SchematicDocument, world: CircuitPosition): CircuitComponent | null {
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (!component) continue;
    const bounds = componentBounds(component);
    if (
      world.x >= bounds.minX - 6 &&
      world.x <= bounds.maxX + 6 &&
      world.y >= bounds.minY - 6 &&
      world.y <= bounds.maxY + 6
    ) {
      return component;
    }
  }
  return null;
}

export function hitWire(document: SchematicDocument, world: CircuitPosition): CircuitWire | null {
  const wires = document.wires ?? [];
  for (let wireIndex = wires.length - 1; wireIndex >= 0; wireIndex -= 1) {
    const wire = wires[wireIndex];
    if (!wire) continue;
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (start && end && pointToSegmentDistance(world, start, end) < 7) return wire;
    }
  }
  return null;
}

export function distance(left: CircuitPosition, right: CircuitPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function pointToSegmentDistance(point: CircuitPosition, start: CircuitPosition, end: CircuitPosition): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

export function wireIdToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'net';
}

function pinOffset(component: CircuitComponent, pin: CircuitPin, index: number): CircuitPosition {
  const key = `${pin.id} ${pin.name}`.toLowerCase();
  let offset: CircuitPosition;
  if (component.type === 'M') {
    if (/gate|\bg\b/.test(key)) offset = { x: -58, y: 0 };
    else if (/drain|\bd\b/.test(key)) offset = { x: 26, y: -52 };
    else if (/source|\bs\b/.test(key)) offset = { x: 26, y: 52 };
    else offset = { x: 58, y: 0 };
  } else if (component.type === 'Q') {
    if (/base|\bb\b/.test(key)) offset = { x: -58, y: 0 };
    else if (/collector|\bc\b/.test(key)) offset = { x: 30, y: -52 };
    else offset = { x: 30, y: 52 };
  } else {
    const sign = index === 0 ? -1 : 1;
    offset = { x: sign * 52, y: 0 };
  }
  return rotateOffset(offset, normalizeRotation(component.rotation));
}

function rotateOffset(offset: CircuitPosition, rotation: number): CircuitPosition {
  if (rotation === 90) return { x: -offset.y, y: offset.x };
  if (rotation === 180) return { x: -offset.x, y: -offset.y };
  if (rotation === 270) return { x: offset.y, y: -offset.x };
  return offset;
}

function materializeNetWires(
  module: CircuitModule,
  portPositions: Map<string, CircuitPosition>,
): CircuitWire[] {
  const stored = (module.wires ?? [])
    .filter((wire) => (wire.points ?? []).length >= 2)
    .map((wire) => rerouteWire(module, wire, portPositions));
  const usedPairs = new Set(stored.map((wire) => endpointPairKey(wire.from, wire.to)));
  const existingIds = new Set(stored.map((wire) => wire.id));
  const endpointsByNet = new Map<string, EndpointHit[]>();

  const remember = (net: string | undefined, endpoint: EndpointHit) => {
    if (!net) return;
    endpointsByNet.set(net, [...(endpointsByNet.get(net) ?? []), endpoint]);
  };

  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      const point = pinWorld(component, pin, index);
      remember(pin.net, {
        kind: 'pin',
        x: point.x,
        y: point.y,
        component_id: component.id,
        pin_id: pin.id,
        label: `${component.name}.${pin.name}`,
        net: pin.net,
      });
    });
  }

  for (const port of module.ports) {
    const point = portPositions.get(port.id);
    if (!point) continue;
    remember(port.net, {
      kind: 'port',
      x: point.x,
      y: point.y,
      port_id: port.id,
      label: port.name,
      net: port.net,
    });
  }

  const wires = [...stored];
  for (const [net, endpoints] of endpointsByNet) {
    if (endpoints.length < 2) continue;
    const anchor = chooseNetAnchor(endpoints);
    for (const endpoint of endpoints) {
      if (endpoint === anchor) continue;
      const pairKey = endpointPairKey(anchor, endpoint);
      if (usedPairs.has(pairKey)) continue;
      usedPairs.add(pairKey);
      const id = makeId(`net_${wireIdToken(net)}_`, existingIds);
      existingIds.add(id);
      wires.push({
        id,
        points: routePoints(endpointDrawPoint(anchor), endpointDrawPoint(endpoint)),
        from: stripEndpoint(endpointDrawPoint(anchor), anchor),
        to: stripEndpoint(endpointDrawPoint(endpoint), endpoint),
        net,
      });
    }
  }
  return wires;
}

function chooseNetAnchor(endpoints: EndpointHit[]): EndpointHit {
  const ports = endpoints.filter((endpoint) => endpoint.kind === 'port');
  const pins = endpoints.filter((endpoint) => endpoint.kind === 'pin');
  if (ports.length > 0 && pins.length > 0) {
    const port = ports[0];
    if (port) {
      return pins.reduce((best, endpoint) => (
        distance(endpoint, port) < distance(best, port) ? endpoint : best
      ), pins[0] ?? port);
    }
  }
  return [...endpoints].sort((left, right) => (left.x - right.x) || (left.y - right.y))[0] ?? endpoints[0]!;
}

function endpointPairKey(left: CircuitWireEndpoint | undefined, right: CircuitWireEndpoint | undefined): string {
  const leftKey = endpointKey(left) ?? `${left?.x ?? ''},${left?.y ?? ''}`;
  const rightKey = endpointKey(right) ?? `${right?.x ?? ''},${right?.y ?? ''}`;
  return [leftKey, rightKey].sort().join('<->');
}

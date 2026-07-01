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
  | { kind: 'components'; ids: string[] }
  | { kind: 'wire'; id: string }
  | null;

type SignalPortSide = 'left' | 'right';

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

export interface SchematicNetLabel {
  id: string;
  kind: 'power' | 'ground' | 'signal';
  net: string;
  name: string;
  position: CircuitPosition;
  endpoint: CircuitWireEndpoint;
  side?: 'left' | 'right' | 'top' | 'bottom';
}

export interface SchematicDocument {
  schema: 'actoviq.schematic-document.v1';
  moduleId: string;
  moduleName: string;
  module: CircuitModule;
  portPositions: Map<string, CircuitPosition>;
  connectedPortIds: Set<string>;
  netLabels: SchematicNetLabel[];
  wires: CircuitWire[];
  bounds: SchematicBounds;
  viewBox: SchematicBounds;
}

export interface SchematicDocumentOptions {
  autoLayout?: boolean;
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

export function createSchematicDocument(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SchematicDocument {
  const shouldAutoLayout = options.autoLayout !== false && (module.wires ?? []).length === 0;
  const next = shouldAutoLayout ? autoLayoutModule(cloneModule(module)) : cloneModule(module);
  for (const component of next.components) {
    component.rotation = normalizeRotation(component.rotation);
    component.position = snapPoint(component.position);
  }
  const portPositions = computePortPositions(next);
  const connectedPortIds = computeConnectedPortIds(next);
  const netLabels = createNetLabels(next, portPositions);
  const wires = materializeNetWires(next, portPositions);
  const bounds = moduleBounds(next, filterPortPositions(portPositions, connectedPortIds), wires, netLabels);
  const viewBox = padBounds(bounds, 70);
  return {
    schema: 'actoviq.schematic-document.v1',
    moduleId: next.module_id,
    moduleName: next.name,
    module: next,
    portPositions,
    connectedPortIds,
    netLabels,
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

function autoLayoutModule(module: CircuitModule): CircuitModule {
  if (module.components.length === 0) return module;
  const activeComponents = module.components.filter((component) => component.type === 'M' || component.type === 'Q');
  if (activeComponents.length > 0 && isBjtResetLikeModule(module, activeComponents)) return autoLayoutBjtResetModule(module, activeComponents);
  if (activeComponents.length > 0 && isLdoLikeModule(module, activeComponents)) return autoLayoutLdoModule(module, activeComponents);
  const differentialPairLayout = findDifferentialPairLayout(module, activeComponents);
  if (differentialPairLayout) return autoLayoutDifferentialPairModule(module, differentialPairLayout);
  const cmosInverterLayout = findCmosInverterLayout(module, activeComponents);
  if (cmosInverterLayout) return autoLayoutCmosInverterModule(module, cmosInverterLayout);
  if (activeComponents.length === 1 && isSingleTransistorStageLikeModule(activeComponents[0])) {
    return autoLayoutSingleTransistorStageModule(module, activeComponents[0]);
  }
  if (activeComponents.length > 0) return autoLayoutActiveModule(module, activeComponents);
  return autoLayoutPassiveModule(module);
}

function autoLayoutPassiveModule(module: CircuitModule): CircuitModule {
  if (isVoltageDividerLikeModule(module)) return autoLayoutVoltageDividerModule(module);
  const inputNet = preferredPortNet(module, 'input');
  const outputNet = preferredPortNet(module, 'output');
  const path = inputNet && outputNet ? findSeriesPath(module, inputNet, outputNet) : [];
  if (path.length === 0) return autoLayoutGenericModule(module);

  const pathComponents = new Set(path.map((entry) => entry.component.id));
  const nodeX = new Map<string, number>();
  const yMain = 180;
  const xStart = 210;
  const spacing = 180;

  path.forEach((entry, index) => {
    const center = { x: xStart + index * spacing, y: yMain };
    placeHorizontal(entry.component, entry.leftNet, entry.rightNet, center);
    rememberPinX(nodeX, entry.component);
  });

  const lowerCounts = new Map<string, number>();
  const upperCounts = new Map<string, number>();
  const floating: CircuitComponent[] = [];

  for (const component of module.components) {
    if (pathComponents.has(component.id)) continue;
    if (component.pins.length !== 2) {
      floating.push(component);
      continue;
    }
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstSignal = nodeX.has(first.net) && !isRailNet(first.net, module);
    const secondSignal = nodeX.has(second.net) && !isRailNet(second.net, module);
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    if (firstSignal && secondRail) {
      placeRailBranch(component, first.net, second.net, nodeX, lowerCounts, upperCounts, yMain, module);
      continue;
    }
    if (secondSignal && firstRail) {
      placeRailBranch(component, second.net, first.net, nodeX, lowerCounts, upperCounts, yMain, module);
      continue;
    }
    floating.push(component);
  }

  floating.forEach((component, index) => {
    component.position = snapPoint({ x: xStart + path.length * spacing + 120, y: yMain + index * 120 });
    component.rotation = normalizeRotation(component.rotation);
  });
  return module;
}

interface VoltageDividerLayout {
  top: CircuitComponent;
  bottom: CircuitComponent;
  powerNet: string;
  outputNet: string;
  groundNet: string;
}

interface CmosInverterLayout {
  pmos: CircuitComponent;
  nmos: CircuitComponent;
  inputNet: string;
  outputNet: string;
  powerNet: string;
  groundNet: string;
}

interface DifferentialPairLayout {
  left: CircuitComponent;
  right: CircuitComponent;
  leftInputNet: string;
  rightInputNet: string;
  leftOutputNet: string;
  rightOutputNet: string;
  tailNet: string;
  powerNet: string;
  groundNet: string;
}

function isVoltageDividerLikeModule(module: CircuitModule): boolean {
  return Boolean(findVoltageDividerLayout(module));
}

function autoLayoutVoltageDividerModule(module: CircuitModule): CircuitModule {
  const layout = findVoltageDividerLayout(module);
  if (!layout) return module;

  const placed = new Set<string>();
  const xMain = 280;
  placeVertical(layout.top, layout.powerNet, layout.outputNet, { x: xMain, y: 150 });
  placed.add(layout.top.id);
  placeVertical(layout.bottom, layout.outputNet, layout.groundNet, { x: xMain, y: 330 });
  placed.add(layout.bottom.id);

  let shuntIndex = 0;
  let floatingIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(layout.outputNet) && (nets.has(layout.groundNet) || nets.has(layout.powerNet))) {
        const railNet = nets.has(layout.groundNet) ? layout.groundNet : layout.powerNet;
        const topNet = railNet === layout.groundNet ? layout.outputNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.outputNet;
        placeVertical(component, topNet, bottomNet, {
          x: xMain + 130 + shuntIndex * 110,
          y: railNet === layout.groundNet ? 330 : 150,
        });
        shuntIndex += 1;
        placed.add(component.id);
        continue;
      }
    }
    component.position = snapPoint({ x: xMain + 160 + (floatingIndex % 2) * 130, y: 150 + Math.floor(floatingIndex / 2) * 130 });
    component.rotation = normalizeRotation(component.rotation);
    floatingIndex += 1;
    placed.add(component.id);
  }
  return module;
}

function findCmosInverterLayout(module: CircuitModule, activeComponents: CircuitComponent[]): CmosInverterLayout | null {
  const mosComponents = activeComponents.filter((component) => component.type === 'M');
  const pmosComponents = mosComponents.filter(isPmosComponent);
  const nmosComponents = mosComponents.filter((component) => !isPmosComponent(component));
  if (pmosComponents.length === 0 || nmosComponents.length === 0) return null;

  const preferredOutputNet = preferredPortNet(module, 'output');
  const powerNets = module.ports
    .filter((port) => port.signal_type === 'power' && !isGroundPort(port))
    .map((port) => port.net);

  for (const pmos of pmosComponents) {
    const pmosNets = activeNetMap(pmos);
    for (const nmos of nmosComponents) {
      const nmosNets = activeNetMap(nmos);
      if (!pmosNets.gate || pmosNets.gate !== nmosNets.gate) continue;
      if (!pmosNets.drain || pmosNets.drain !== nmosNets.drain) continue;
      if (!pmosNets.source || !nmosNets.source) continue;
      if (preferredOutputNet && pmosNets.drain !== preferredOutputNet) continue;
      if (isGroundNet(pmosNets.source, module) || !isGroundNet(nmosNets.source, module)) continue;
      if (powerNets.length > 0 && !powerNets.includes(pmosNets.source)) continue;
      return {
        pmos,
        nmos,
        inputNet: pmosNets.gate,
        outputNet: pmosNets.drain,
        powerNet: pmosNets.source,
        groundNet: nmosNets.source,
      };
    }
  }
  return null;
}

function findDifferentialPairLayout(module: CircuitModule, activeComponents: CircuitComponent[]): DifferentialPairLayout | null {
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  for (let leftIndex = 0; leftIndex < activeComponents.length; leftIndex += 1) {
    const first = activeComponents[leftIndex];
    if (!first || (first.type === 'M' && isPmosComponent(first))) continue;
    const firstNets = activeNetMap(first);
    if (!firstNets.gate || !firstNets.drain || !firstNets.source) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < activeComponents.length; rightIndex += 1) {
      const second = activeComponents[rightIndex];
      if (!second || second.type !== first.type || (second.type === 'M' && isPmosComponent(second))) continue;
      const secondNets = activeNetMap(second);
      if (!secondNets.gate || !secondNets.drain || !secondNets.source) continue;
      if (firstNets.source !== secondNets.source) continue;
      if (firstNets.gate === secondNets.gate || firstNets.drain === secondNets.drain) continue;
      if (isRailNet(firstNets.source, module)) continue;

      const [left, right] = orderDifferentialPairDevices(module, first, second);
      const leftNets = activeNetMap(left);
      const rightNets = activeNetMap(right);
      if (!leftNets.gate || !rightNets.gate || !leftNets.drain || !rightNets.drain || !leftNets.source) continue;
      return {
        left,
        right,
        leftInputNet: leftNets.gate,
        rightInputNet: rightNets.gate,
        leftOutputNet: leftNets.drain,
        rightOutputNet: rightNets.drain,
        tailNet: leftNets.source,
        powerNet,
        groundNet,
      };
    }
  }
  return null;
}

function orderDifferentialPairDevices(
  module: CircuitModule,
  first: CircuitComponent,
  second: CircuitComponent,
): [CircuitComponent, CircuitComponent] {
  const firstGate = activeNetMap(first).gate ?? '';
  const secondGate = activeNetMap(second).gate ?? '';
  const firstRank = differentialInputRank(module, firstGate);
  const secondRank = differentialInputRank(module, secondGate);
  if (firstRank !== secondRank) return firstRank < secondRank ? [first, second] : [second, first];
  return first.id.localeCompare(second.id) <= 0 ? [first, second] : [second, first];
}

function differentialInputRank(module: CircuitModule, net: string): number {
  const portIndex = module.ports.findIndex((port) => port.net === net);
  const port = portIndex >= 0 ? module.ports[portIndex] : undefined;
  const label = `${port?.id ?? ''} ${port?.name ?? ''} ${net}`.toLowerCase();
  if (/inp|vinp|\bin\+|\+|plus|pos|noninv|non-inv/.test(label)) return 0;
  if (/inn|vinn|\bin-|-|minus|neg|inv/.test(label)) return 1;
  return 10 + (portIndex >= 0 ? portIndex : 100);
}

function autoLayoutDifferentialPairModule(module: CircuitModule, layout: DifferentialPairLayout): CircuitModule {
  const placed = new Set<string>();
  layout.left.position = snapPoint({ x: 360, y: 330 });
  layout.left.rotation = 0;
  placed.add(layout.left.id);
  layout.right.position = snapPoint({ x: 620, y: 330 });
  layout.right.rotation = 0;
  placed.add(layout.right.id);

  const activeLoads = module.components.filter((component) => (
    !placed.has(component.id) &&
    (component.type === 'M' || component.type === 'Q') &&
    (
      componentHasNets(component, layout.powerNet, layout.leftOutputNet) ||
      componentHasNets(component, layout.powerNet, layout.rightOutputNet)
    )
  ));
  for (const component of activeLoads) {
    const nets = activeNetMap(component);
    const outputNet = nets.drain === layout.leftOutputNet ? layout.leftOutputNet : layout.rightOutputNet;
    const anchor = outputNet === layout.leftOutputNet
      ? pinPointForComponentNet(layout.left, layout.leftOutputNet)
      : pinPointForComponentNet(layout.right, layout.rightOutputNet);
    component.position = snapPoint({ x: anchor?.x ?? component.position.x, y: 130 });
    component.rotation = 0;
    placed.add(component.id);
  }

  const drainLoads = [
    { outputNet: layout.leftOutputNet, pair: layout.left, side: -1 },
    { outputNet: layout.rightOutputNet, pair: layout.right, side: 1 },
  ];
  for (const { outputNet, pair } of drainLoads) {
    const load = findTwoPinWithNets(module.components, placed, /r(d|c)|load|collector|drain/i, layout.powerNet, outputNet);
    const anchor = pinPointForComponentNet(pair, outputNet);
    if (load && anchor) {
      placeVertical(load, layout.powerNet, outputNet, { x: anchor.x, y: 165 });
      placed.add(load.id);
    }
  }

  const tail = findTwoPinWithNets(module.components, placed, /tail|bias|i(ref)?|source/i, layout.tailNet, layout.groundNet);
  if (tail) {
    placeVertical(tail, layout.tailNet, layout.groundNet, { x: 490, y: 525 });
    placed.add(tail.id);
  }

  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      const leftOutputBranch = nets.has(layout.leftOutputNet) && nets.has(layout.groundNet);
      const rightOutputBranch = nets.has(layout.rightOutputNet) && nets.has(layout.groundNet);
      if (leftOutputBranch || rightOutputBranch) {
        const outputNet = leftOutputBranch ? layout.leftOutputNet : layout.rightOutputNet;
        const x = leftOutputBranch ? 220 : 760;
        placeVertical(component, outputNet, layout.groundNet, { x, y: 470 + fallbackIndex * 12 });
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }
      if (nets.has(layout.leftInputNet) || nets.has(layout.rightInputNet)) {
        const inputNet = nets.has(layout.leftInputNet) ? layout.leftInputNet : layout.rightInputNet;
        const otherNet = first.net === inputNet ? second.net : first.net;
        const x = inputNet === layout.leftInputNet ? 185 : 705;
        placeHorizontal(component, otherNet, inputNet, { x, y: 330 });
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }
    }
    component.position = snapPoint({
      x: 850 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 140,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutCmosInverterModule(module: CircuitModule, layout: CmosInverterLayout): CircuitModule {
  const placed = new Set<string>();
  layout.pmos.position = snapPoint({ x: 420, y: 150 });
  layout.pmos.rotation = 0;
  placed.add(layout.pmos.id);

  layout.nmos.position = snapPoint({ x: 420, y: 370 });
  layout.nmos.rotation = 0;
  placed.add(layout.nmos.id);

  let outputShuntIndex = 0;
  let inputBiasIndex = 0;
  let outputSeriesIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(layout.outputNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.outputNet, layout.groundNet, {
          x: 620 + outputShuntIndex * 130,
          y: 310 + outputShuntIndex * 20,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (nets.has(layout.powerNet) && nets.has(layout.outputNet)) {
        placeVertical(component, layout.powerNet, layout.outputNet, {
          x: 620 + outputShuntIndex * 130,
          y: 150,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (nets.has(layout.inputNet) && (nets.has(layout.groundNet) || nets.has(layout.powerNet))) {
        const railNet = nets.has(layout.groundNet) ? layout.groundNet : layout.powerNet;
        const topNet = railNet === layout.groundNet ? layout.inputNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.inputNet;
        placeVertical(component, topNet, bottomNet, {
          x: 245 + inputBiasIndex * 120,
          y: railNet === layout.groundNet ? 405 : 110,
        });
        placed.add(component.id);
        inputBiasIndex += 1;
        continue;
      }
      if (nets.has(layout.outputNet)) {
        const rightNet = first.net === layout.outputNet ? second.net : first.net;
        placeHorizontal(component, layout.outputNet, rightNet, {
          x: 650 + outputSeriesIndex * 150,
          y: 260,
        });
        placed.add(component.id);
        outputSeriesIndex += 1;
        continue;
      }
      if (nets.has(layout.inputNet)) {
        const leftNet = first.net === layout.inputNet ? second.net : first.net;
        placeHorizontal(component, leftNet, layout.inputNet, {
          x: 250,
          y: 260 + inputBiasIndex * 90,
        });
        placed.add(component.id);
        inputBiasIndex += 1;
        continue;
      }
    }

    component.position = snapPoint({
      x: 760 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 140,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutActiveModule(module: CircuitModule, activeComponents: CircuitComponent[]): CircuitModule {
  const sortedActive = [...activeComponents].sort((left, right) => (
    activePlacementScore(left) - activePlacementScore(right) || left.id.localeCompare(right.id)
  ));
  const mainY = 220;
  sortedActive.forEach((component, index) => {
    component.position = snapPoint({ x: 250 + index * 190, y: mainY });
    component.rotation = 0;
  });

  const primary = sortedActive[0];
  const primaryNets = primary ? activeNetMap(primary) : {};
  const placed = new Set(sortedActive.map((component) => component.id));
  const usedSlots = { right: 0 };
  const upperCounts = new Map<string, number>();
  const lowerCounts = new Map<string, number>();
  const outputCounts = new Map<string, number>();
  const nodeAnchors = new Map<string, CircuitPosition>();
  sortedActive.forEach((component) => rememberComponentPinAnchors(nodeAnchors, component));

  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    if (component.pins.length !== 2) {
      component.position = snapPoint({ x: 250 + sortedActive.length * 190 + usedSlots.right * 150, y: mainY });
      component.rotation = 0;
      usedSlots.right += 1;
      continue;
    }
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    const signalNet = firstRail ? second.net : first.net;
    const railNet = firstRail ? first.net : secondRail ? second.net : '';
    const signalPin = nearestPinPointForNet(sortedActive, signalNet) ?? nodeAnchors.get(signalNet);

    if (railNet && signalPin) {
      if (isGroundNet(railNet, module)) {
        const index = lowerCounts.get(signalNet) ?? 0;
        lowerCounts.set(signalNet, index + 1);
        placeVertical(component, signalNet, railNet, {
          x: signalPin.x + index * 110,
          y: signalPin.y + 90,
        });
      } else {
        const index = upperCounts.get(signalNet) ?? 0;
        upperCounts.set(signalNet, index + 1);
        placeVertical(component, railNet, signalNet, {
          x: signalPin.x + index * 110,
          y: signalPin.y - 90,
        });
      }
      rememberComponentPinAnchors(nodeAnchors, component);
      continue;
    }

    const primaryOutputNet = primaryNets.drain;
    if (primaryOutputNet && (first.net === primaryOutputNet || second.net === primaryOutputNet)) {
      const anchor = nearestPinPointForNet(sortedActive, primaryOutputNet) ?? nodeAnchors.get(primaryOutputNet);
      if (anchor) {
        const index = outputCounts.get(primaryOutputNet) ?? 0;
        outputCounts.set(primaryOutputNet, index + 1);
        const otherNet = first.net === primaryOutputNet ? second.net : first.net;
        placeHorizontal(component, primaryOutputNet, otherNet, {
          x: anchor.x + 170 + index * 150,
          y: anchor.y,
        });
        rememberComponentPinAnchors(nodeAnchors, component);
        continue;
      }
    }

    if (primaryNets.gate && (first.net === primaryNets.gate || second.net === primaryNets.gate)) {
      placeHorizontal(component, first.net, second.net, {
        x: (primary?.position.x ?? 250) - 160,
        y: mainY,
      });
      rememberComponentPinAnchors(nodeAnchors, component);
      continue;
    }

    component.position = snapPoint({ x: 250 + sortedActive.length * 190 + usedSlots.right * 150, y: mainY + 100 });
    component.rotation = 0;
    usedSlots.right += 1;
    rememberComponentPinAnchors(nodeAnchors, component);
  }
  return module;
}

function isSingleTransistorStageLikeModule(component: CircuitComponent | undefined): component is CircuitComponent {
  if (!component) return false;
  const nets = activeNetMap(component);
  return Boolean(nets.gate && nets.drain && nets.source);
}

function autoLayoutSingleTransistorStageModule(module: CircuitModule, active: CircuitComponent): CircuitModule {
  const placed = new Set<string>();
  const nets = activeNetMap(active);
  const inputNet = preferredPortNet(module, 'input');
  const outputNet = preferredPortNet(module, 'output');
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';

  active.position = snapPoint({ x: 380, y: 240 });
  active.rotation = 0;
  placed.add(active.id);

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2 && !placed.has(component.id));
  const inputCoupling = inputNet && nets.gate && inputNet !== nets.gate
    ? findTwoPinWithNets(twoPinComponents, placed, /c(in|input|coupl)|input/i, inputNet, nets.gate)
    : undefined;
  if (inputCoupling && inputNet && nets.gate) {
    placeHorizontal(inputCoupling, inputNet, nets.gate, { x: 150, y: 240 });
    placed.add(inputCoupling.id);
  }

  const gatePullup = nets.gate
    ? findTwoPinWithNets(twoPinComponents, placed, /r(g|bias|1)|pull|up/i, powerNet, nets.gate)
    : undefined;
  if (gatePullup && nets.gate) {
    placeVertical(gatePullup, powerNet, nets.gate, { x: 280, y: 115 });
    placed.add(gatePullup.id);
  }

  const gatePulldown = nets.gate
    ? findTwoPinWithNets(twoPinComponents, placed, /r(g|bias|2)|pull|down/i, nets.gate, groundNet)
    : undefined;
  if (gatePulldown && nets.gate) {
    placeVertical(gatePulldown, nets.gate, groundNet, { x: 280, y: 365 });
    placed.add(gatePulldown.id);
  }

  const drainLoad = nets.drain
    ? findTwoPinWithNets(twoPinComponents, placed, /r(d|c)|drain|collector|load/i, powerNet, nets.drain)
    : undefined;
  if (drainLoad && nets.drain) {
    placeVertical(drainLoad, powerNet, nets.drain, { x: 405, y: 100 });
    placed.add(drainLoad.id);
  }

  const sourceResistor = nets.source
    ? findTwoPinWithNets(twoPinComponents, placed, /r(s|e)|source|emitter|degeneration/i, nets.source, groundNet)
    : undefined;
  if (sourceResistor && nets.source) {
    placeVertical(sourceResistor, nets.source, groundNet, { x: 405, y: 410 });
    placed.add(sourceResistor.id);
  }

  const sourceBypass = nets.source
    ? findTwoPinWithNets(twoPinComponents, placed, /c(s|e)|source|emitter|bypass/i, nets.source, groundNet)
    : undefined;
  if (sourceBypass && nets.source) {
    placeVertical(sourceBypass, nets.source, groundNet, { x: 540, y: 410 });
    placed.add(sourceBypass.id);
  }

  let outputLoadNet = outputNet && outputNet !== nets.drain ? outputNet : undefined;
  const outputCoupling = nets.drain
    ? findOutputCouplingComponent(twoPinComponents, placed, nets.drain, outputLoadNet, module)
    : undefined;
  if (outputCoupling && nets.drain) {
    outputLoadNet = outputLoadNet ?? otherComponentNet(outputCoupling, nets.drain);
    if (outputLoadNet) placeHorizontal(outputCoupling, nets.drain, outputLoadNet, { x: 590, y: 188 });
    placed.add(outputCoupling.id);
  }

  const outputLoad = outputLoadNet
    ? findTwoPinWithNets(twoPinComponents, placed, /r(load|out)|load/i, outputLoadNet, groundNet)
    : undefined;
  if (outputLoad && outputLoadNet) {
    placeVertical(outputLoad, outputLoadNet, groundNet, { x: 745, y: 360 });
    placed.add(outputLoad.id);
  }

  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    component.position = snapPoint({
      x: 700 + (fallbackIndex % 3) * 150,
      y: 180 + Math.floor(fallbackIndex / 3) * 140,
    });
    component.rotation = normalizeRotation(component.rotation);
    fallbackIndex += 1;
  }
  return module;
}

function isBjtResetLikeModule(module: CircuitModule, activeComponents: CircuitComponent[]): boolean {
  const bjtCount = activeComponents.filter((component) => component.type === 'Q').length;
  if (bjtCount < 2 || !module.components.some((component) => component.type === 'D')) return false;
  const text = [
    module.module_id,
    module.name,
    ...module.components.flatMap((component) => [
      component.id,
      component.name,
      component.value,
      ...component.pins.map((pin) => pin.net),
    ]),
  ].join(' ').toLowerCase();
  return /rst|reset/.test(text) && /dtr/.test(text) && /rts/.test(text) && /boot/.test(text);
}

function autoLayoutBjtResetModule(module: CircuitModule, activeComponents: CircuitComponent[]): CircuitModule {
  const placed = new Set<string>();
  const bjtComponents = activeComponents.filter((component) => component.type === 'Q');
  const reset = findNamedComponent(bjtComponents, /rst|reset/) ?? bjtComponents[1] ?? bjtComponents[0];
  const boot = findNamedComponent(bjtComponents, /boot/) ?? bjtComponents.find((component) => component.id !== reset?.id) ?? bjtComponents[0];
  const resetNets = reset ? activeNetMap(reset) : {};
  const bootNets = boot ? activeNetMap(boot) : {};
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';

  if (boot) {
    boot.position = snapPoint({ x: 260, y: 300 });
    boot.rotation = 0;
    placed.add(boot.id);
  }
  if (reset) {
    reset.position = snapPoint({ x: 620, y: 220 });
    reset.rotation = 0;
    placed.add(reset.id);
  }

  const resetCollector = reset && resetNets.drain ? pinPointForComponentNet(reset, resetNets.drain) : null;
  const resetBase = reset && resetNets.gate ? pinPointForComponentNet(reset, resetNets.gate) : null;
  const resetEmitter = reset && resetNets.source ? pinPointForComponentNet(reset, resetNets.source) : null;
  const bootBase = boot && bootNets.gate ? pinPointForComponentNet(boot, bootNets.gate) : null;
  const bootEmitter = boot && bootNets.source ? pinPointForComponentNet(boot, bootNets.source) : null;

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2 && !placed.has(component.id));
  const pullup = findTwoPinWithNets(twoPinComponents, placed, /r50|pull|up/i, powerNet, resetNets.drain);
  if (pullup && resetCollector && resetNets.drain) {
    placeVertical(pullup, powerNet, resetNets.drain, {
      x: resetCollector.x,
      y: resetCollector.y - 95,
    });
    placed.add(pullup.id);
  }

  const diode = findTwoPinWithNets(twoPinComponents, placed, /d|diode|rst|reset/i, undefined, resetNets.drain);
  if (diode && resetCollector && resetNets.drain) {
    const leftNet = diode.pins.find((pin) => pin.net !== resetNets.drain)?.net ?? diode.pins[0]?.net ?? resetNets.drain;
    placeHorizontal(diode, leftNet, resetNets.drain, {
      x: resetCollector.x - 165,
      y: resetCollector.y,
    });
    placed.add(diode.id);
  }

  const dtrResistor = findTwoPinWithNets(twoPinComponents, placed, /r51|dtr/i, resetNets.gate, undefined);
  if (dtrResistor && resetBase && resetNets.gate) {
    const rightNet = dtrResistor.pins.find((pin) => pin.net !== resetNets.gate)?.net ?? dtrResistor.pins[1]?.net ?? resetNets.gate;
    placeHorizontal(dtrResistor, resetNets.gate, rightNet, {
      x: resetBase.x + 170,
      y: resetBase.y,
    });
    placed.add(dtrResistor.id);
  }

  const rtsResistor = findTwoPinWithNets(twoPinComponents, placed, /r49|rts/i, bootNets.gate, resetNets.source);
  if (rtsResistor && bootBase && resetEmitter && bootNets.gate && resetNets.source) {
    placeHorizontal(rtsResistor, bootNets.gate, resetNets.source, {
      x: (bootBase.x + resetEmitter.x) / 2,
      y: resetEmitter.y + 54,
    });
    placed.add(rtsResistor.id);
  }

  const bootResistor = findTwoPinWithNets(twoPinComponents, placed, /r52|boot/i, bootNets.source, undefined);
  if (bootResistor && bootEmitter && bootNets.source) {
    const bottomNet = bootResistor.pins.find((pin) => pin.net !== bootNets.source)?.net ?? bootResistor.pins[1]?.net ?? bootNets.source;
    placeVertical(bootResistor, bootNets.source, bottomNet, {
      x: bootEmitter.x,
      y: bootEmitter.y + 100,
    });
    placed.add(bootResistor.id);
  }

  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    component.position = snapPoint({
      x: 820 + (fallbackIndex % 3) * 170,
      y: 200 + Math.floor(fallbackIndex / 3) * 135,
    });
    component.rotation = normalizeRotation(component.rotation);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutLdoModule(module: CircuitModule, activeComponents: CircuitComponent[]): CircuitModule {
  const placed = new Set<string>();
  const inputNet = preferredPortNet(module, 'input') ?? 'vin';
  const outputNet = preferredPortNet(module, 'output') ?? 'vout';
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? inputNet;

  const pass = findPassDevice(activeComponents, powerNet, outputNet);
  const differential = activeComponents
    .filter((component) => component.id !== pass?.id)
    .sort((left, right) => activePlacementScore(left) - activePlacementScore(right) || left.id.localeCompare(right.id));

  const currentSources = differential.filter((component) => /current|mirror|bias|load|p?mos/i.test(component.value) && isPmosComponent(component));
  const signalPair = differential.filter((component) => !isPmosComponent(component));
  const fallbackActives = differential.filter((component) => !currentSources.includes(component) && !signalPair.includes(component));

  const activeSlots: Array<{ component: CircuitComponent | undefined; x: number; y: number }> = [
    { component: currentSources[0], x: 360, y: 125 },
    { component: currentSources[1], x: 680, y: 125 },
    { component: signalPair[0] ?? fallbackActives[0], x: 360, y: 430 },
    { component: signalPair[1] ?? fallbackActives[1], x: 680, y: 430 },
    { component: pass, x: 980, y: 280 },
  ];

  activeSlots.forEach(({ component, x, y }) => {
    if (!component || placed.has(component.id)) return;
    component.position = snapPoint({ x, y });
    component.rotation = 0;
    placed.add(component.id);
  });

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2 && !placed.has(component.id));
  placeNamedTwoPin(twoPinComponents, placed, /v(in|dd|supply)|input/i, powerNet, groundNet, { x: 145, y: 330 });
  placeNamedTwoPin(twoPinComponents, placed, /vref|reference/i, 'vref', groundNet, { x: 165, y: 600 });
  placeNamedTwoPin(twoPinComponents, placed, /itail|tail|bias/i, 'tail', groundNet, { x: 540, y: 650 });
  placeNamedTwoPin(twoPinComponents, placed, /r(top|fb1|upper)|feedback.*top/i, outputNet, 'fb', { x: 1180, y: 380 });
  placeNamedTwoPin(twoPinComponents, placed, /r(bot|fb2|lower)|feedback.*bot/i, 'fb', groundNet, { x: 1180, y: 590 });
  placeNamedTwoPin(twoPinComponents, placed, /r(load|out)|load/i, outputNet, groundNet, { x: 1370, y: 535 });
  placeNamedTwoPin(twoPinComponents, placed, /c(out|load)|output.*cap/i, outputNet, groundNet, { x: 1530, y: 535 });

  for (const component of twoPinComponents) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    const signalNet = firstRail ? second.net : first.net;
    const railNet = firstRail ? first.net : secondRail ? second.net : '';
    const anchor = nearestPinPointForNet(activeComponents, signalNet);
    if (railNet && anchor) {
      placeVertical(component, signalNet, railNet, {
        x: anchor.x,
        y: anchor.y + (isGroundNet(railNet, module) ? 135 : -135),
      });
    } else {
      component.position = snapPoint({ x: 820 + placed.size * 80, y: 520 });
      component.rotation = normalizeRotation(component.rotation);
    }
    placed.add(component.id);
  }

  module.components.forEach((component, index) => {
    if (placed.has(component.id)) return;
    component.position = snapPoint({ x: 230 + (index % 4) * 180, y: 590 + Math.floor(index / 4) * 120 });
    component.rotation = normalizeRotation(component.rotation);
  });

  return module;
}

function autoLayoutGenericModule(module: CircuitModule): CircuitModule {
  const columns = Math.max(1, Math.ceil(Math.sqrt(module.components.length)));
  module.components.forEach((component, index) => {
    component.position = snapPoint({
      x: 180 + (index % columns) * 180,
      y: 170 + Math.floor(index / columns) * 140,
    });
    component.rotation = normalizeRotation(component.rotation);
  });
  return module;
}

function placeRailBranch(
  component: CircuitComponent,
  signalNet: string,
  railNet: string,
  nodeX: Map<string, number>,
  lowerCounts: Map<string, number>,
  upperCounts: Map<string, number>,
  yMain: number,
  module: CircuitModule,
) {
  const xBase = nodeX.get(signalNet) ?? 240;
  if (isGroundNet(railNet, module)) {
    const index = lowerCounts.get(signalNet) ?? 0;
    lowerCounts.set(signalNet, index + 1);
    placeVertical(component, signalNet, railNet, {
      x: xBase + index * 95,
      y: yMain + 95 + index * 12,
    });
    return;
  }
  const index = upperCounts.get(signalNet) ?? 0;
  upperCounts.set(signalNet, index + 1);
  placeVertical(component, railNet, signalNet, {
    x: xBase + index * 95,
    y: yMain - 95 - index * 12,
  });
}

function placeHorizontal(component: CircuitComponent, leftNet: string, rightNet: string, center: CircuitPosition) {
  component.position = snapPoint(center);
  const [first, second] = component.pins;
  if (first?.net === leftNet && second?.net === rightNet) {
    component.rotation = 0;
  } else if (first?.net === rightNet && second?.net === leftNet) {
    component.rotation = 180;
  } else {
    component.rotation = 0;
  }
}

function placeVertical(component: CircuitComponent, topNet: string, bottomNet: string, center: CircuitPosition) {
  component.position = snapPoint(center);
  const [first, second] = component.pins;
  if (first?.net === topNet && second?.net === bottomNet) {
    component.rotation = 90;
  } else if (first?.net === bottomNet && second?.net === topNet) {
    component.rotation = 270;
  } else {
    component.rotation = 90;
  }
}

function rememberComponentPinAnchors(anchors: Map<string, CircuitPosition>, component: CircuitComponent) {
  component.pins.forEach((pin, index) => {
    anchors.set(pin.net, pinWorld(component, pin, index));
  });
}

interface SeriesPathEntry {
  component: CircuitComponent;
  leftNet: string;
  rightNet: string;
}

function findSeriesPath(module: CircuitModule, inputNet: string, outputNet: string): SeriesPathEntry[] {
  const graph = new Map<string, SeriesPathEntry[]>();
  for (const component of module.components) {
    if (component.pins.length !== 2) continue;
    const [first, second] = component.pins;
    if (!first || !second || first.net === second.net) continue;
    if (isRailNet(first.net, module) || isRailNet(second.net, module)) continue;
    const forward = { component, leftNet: first.net, rightNet: second.net };
    const reverse = { component, leftNet: second.net, rightNet: first.net };
    graph.set(first.net, [...(graph.get(first.net) ?? []), forward]);
    graph.set(second.net, [...(graph.get(second.net) ?? []), reverse]);
  }

  const queue: Array<{ net: string; path: SeriesPathEntry[]; used: Set<string> }> = [
    { net: inputNet, path: [], used: new Set() },
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.net === outputNet) return current.path;
    if (visited.has(current.net)) continue;
    visited.add(current.net);
    for (const edge of graph.get(current.net) ?? []) {
      if (current.used.has(edge.component.id)) continue;
      queue.push({
        net: edge.rightNet,
        path: [...current.path, edge],
        used: new Set([...current.used, edge.component.id]),
      });
    }
  }
  return [];
}

function preferredPortNet(module: CircuitModule, direction: 'input' | 'output'): string | null {
  const port = module.ports.find((entry) => (
    entry.direction === direction &&
    entry.signal_type !== 'ground' &&
    entry.signal_type !== 'power'
  ));
  return port?.net ?? null;
}

function rememberPinX(nodeX: Map<string, number>, component: CircuitComponent) {
  component.pins.forEach((pin, index) => {
    const point = pinWorld(component, pin, index);
    nodeX.set(pin.net, point.x);
  });
}

function activeNetMap(component: CircuitComponent): { gate?: string; drain?: string; source?: string } {
  const result: { gate?: string; drain?: string; source?: string } = {};
  for (const pin of component.pins) {
    const key = `${pin.id} ${pin.name}`.toLowerCase();
    if (component.type === 'M') {
      if (/gate|\bg\b/.test(key)) result.gate = pin.net;
      if (/drain|\bd\b/.test(key)) result.drain = pin.net;
      if (/source|\bs\b/.test(key)) result.source = pin.net;
      continue;
    }
    if (/base|\bb\b/.test(key)) result.gate = pin.net;
    if (/collector|\bc\b/.test(key)) result.drain = pin.net;
    if (/emitter|\be\b/.test(key)) result.source = pin.net;
  }
  return result;
}

function activePlacementScore(component: CircuitComponent): number {
  const text = `${component.id} ${component.name}`.toLowerCase();
  if (/ref|bias|diode/.test(text)) return 0;
  if (/out|load/.test(text)) return 2;
  return 1;
}

function isLdoLikeModule(module: CircuitModule, activeComponents: CircuitComponent[]): boolean {
  const text = [
    module.module_id,
    module.name,
    ...module.components.flatMap((component) => [component.id, component.name, component.value]),
  ].join(' ').toLowerCase();
  const hasPassDevice = activeComponents.some((component) => /pass|ldo|pmos/i.test(`${component.id} ${component.name} ${component.value}`));
  const hasInputOutputRails = module.ports.some((port) => port.direction === 'input' && !isGroundPort(port)) &&
    module.ports.some((port) => port.direction === 'output' && !isGroundPort(port));
  return activeComponents.length >= 3 && hasInputOutputRails && (text.includes('ldo') || hasPassDevice);
}

function findPassDevice(activeComponents: CircuitComponent[], powerNet: string, outputNet: string): CircuitComponent | undefined {
  return activeComponents.find((component) => /(^|[_-])m?p(ass)?($|[_-])|\bmp\b|pass/i.test(`${component.id} ${component.name} ${component.value}`)) ??
    activeComponents.find((component) => (
      isPmosComponent(component) &&
      component.pins.some((pin) => pin.net === powerNet) &&
      component.pins.some((pin) => pin.net === outputNet)
    )) ??
    activeComponents.find(isPmosComponent);
}

function findNamedComponent(components: CircuitComponent[], pattern: RegExp): CircuitComponent | undefined {
  return components.find((component) => pattern.test(`${component.id} ${component.name} ${component.value}`));
}

function findVoltageDividerLayout(module: CircuitModule): VoltageDividerLayout | null {
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNets = module.ports
    .filter((port) => port.signal_type === 'power' && !isGroundPort(port))
    .map((port) => port.net);
  if (powerNets.length === 0) return null;

  const resistors = module.components.filter((component) => component.type === 'R' && component.pins.length === 2);
  if (resistors.length < 2) return null;
  const outputCandidates = uniqueStrings([
    preferredPortNet(module, 'output'),
    ...resistors.flatMap((component) => component.pins.map((pin) => pin.net))
      .filter((net) => net !== groundNet && !powerNets.includes(net)),
  ]);

  for (const outputNet of outputCandidates) {
    if (!outputNet) continue;
    for (const powerNet of powerNets) {
      const top = resistors.find((component) => componentHasNets(component, powerNet, outputNet));
      const bottom = resistors.find((component) => component.id !== top?.id && componentHasNets(component, outputNet, groundNet));
      if (top && bottom) return { top, bottom, powerNet, outputNet, groundNet };
    }
  }
  return null;
}

function findTwoPinWithNets(
  components: CircuitComponent[],
  placed: Set<string>,
  pattern: RegExp,
  firstNet?: string,
  secondNet?: string,
): CircuitComponent | undefined {
  const matchesNets = (component: CircuitComponent) => {
    const nets = new Set(component.pins.map((pin) => pin.net));
    return (!firstNet || nets.has(firstNet)) && (!secondNet || nets.has(secondNet));
  };
  return components.find((component) => !placed.has(component.id) && pattern.test(`${component.id} ${component.name} ${component.value}`) && matchesNets(component)) ??
    components.find((component) => !placed.has(component.id) && matchesNets(component));
}

function findOutputCouplingComponent(
  components: CircuitComponent[],
  placed: Set<string>,
  drainNet: string,
  preferredOutputNet: string | undefined,
  module: CircuitModule,
): CircuitComponent | undefined {
  if (preferredOutputNet) {
    return findTwoPinWithNets(components, placed, /c(out|output|coupl)|output/i, drainNet, preferredOutputNet);
  }
  return components.find((component) => {
    if (placed.has(component.id) || component.type !== 'C' || component.pins.length !== 2) return false;
    const otherNet = otherComponentNet(component, drainNet);
    return Boolean(otherNet && !isRailNet(otherNet, module));
  });
}

function otherComponentNet(component: CircuitComponent, net: string): string | undefined {
  return component.pins.find((pin) => pin.net !== net)?.net;
}

function componentHasNets(component: CircuitComponent, firstNet: string, secondNet: string): boolean {
  const nets = new Set(component.pins.map((pin) => pin.net));
  return nets.has(firstNet) && nets.has(secondNet);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function pinPointForComponentNet(component: CircuitComponent, net: string): CircuitPosition | null {
  const index = component.pins.findIndex((pin) => pin.net === net);
  const pin = index >= 0 ? component.pins[index] : undefined;
  return pin ? pinWorld(component, pin, index) : null;
}

function placeNamedTwoPin(
  components: CircuitComponent[],
  placed: Set<string>,
  pattern: RegExp,
  topNet: string,
  bottomNet: string,
  center: CircuitPosition,
) {
  const component = components.find((entry) => !placed.has(entry.id) && pattern.test(`${entry.id} ${entry.name} ${entry.value}`));
  if (!component) return;
  const [first, second] = component.pins;
  if (!first || !second) return;
  const nets = [first.net, second.net];
  const actualTop = nets.includes(topNet) ? topNet : first.net;
  const actualBottom = nets.includes(bottomNet) ? bottomNet : nets.find((net) => net !== actualTop) ?? second.net;
  placeVertical(component, actualTop, actualBottom, center);
  placed.add(component.id);
}

function nearestPinPointForNet(components: CircuitComponent[], net: string): CircuitPosition | null {
  for (const component of components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      if (!pin || pin.net !== net) continue;
      return pinWorld(component, pin, index);
    }
  }
  return null;
}

function isRailNet(net: string, module: CircuitModule): boolean {
  return isGroundNet(net, module) || module.ports.some((port) => port.net === net && port.signal_type === 'power');
}

function isGroundNet(net: string, module: CircuitModule): boolean {
  return net === '0' || module.ports.some((port) => port.net === net && isGroundPort(port));
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

function pinPointsByNetName(module: CircuitModule): Map<string, CircuitPosition[]> {
  const points = new Map<string, CircuitPosition[]>();
  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      const point = pinWorld(component, pin, index);
      points.set(pin.net, [...(points.get(pin.net) ?? []), point]);
    });
  }
  return points;
}

function computeConnectedPortIds(module: CircuitModule): Set<string> {
  const pinNets = new Set(module.components.flatMap((component) => component.pins.map((pin) => pin.net)));
  const portNetCounts = new Map<string, number>();
  for (const port of module.ports) {
    portNetCounts.set(port.net, (portNetCounts.get(port.net) ?? 0) + 1);
  }
  const wiredPorts = new Set(
    (module.wires ?? []).flatMap((wire) => [wire.from?.port_id, wire.to?.port_id].filter(Boolean) as string[]),
  );
  return new Set(
    module.ports
      .filter((port) => pinNets.has(port.net) || wiredPorts.has(port.id) || (portNetCounts.get(port.net) ?? 0) > 1)
      .map((port) => port.id),
  );
}

function filterPortPositions(
  portPositions: Map<string, CircuitPosition>,
  connectedPortIds: Set<string>,
): Map<string, CircuitPosition> {
  return new Map([...portPositions].filter(([portId]) => connectedPortIds.has(portId)));
}

function leftmost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.x < best.x ? point : best
  ), null);
}

function rightmost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.x > best.x ? point : best
  ), null);
}

function topmost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.y < best.y ? point : best
  ), null);
}

function bottommost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.y > best.y ? point : best
  ), null);
}

export function computePortPositions(module: CircuitModule): Map<string, CircuitPosition> {
  const bounds = moduleBounds(module, new Map(), module.wires ?? []);
  const signalPorts = module.ports.filter((port) => !isGroundPort(port) && port.signal_type !== 'power');
  const powers = module.ports.filter((port) => !isGroundPort(port) && port.signal_type === 'power');
  const grounds = module.ports.filter(isGroundPort);
  const pinPointsByNet = pinPointsByNetName(module);
  const map = new Map<string, CircuitPosition>();
  const signalSideCounts: Record<SignalPortSide, number> = { left: 0, right: 0 };

  signalPorts.forEach((port) => {
    const points = pinPointsByNet.get(port.net) ?? [];
    const side = signalPortSide(port, points, bounds);
    const index = signalSideCounts[side];
    signalSideCounts[side] += 1;
    const anchor = side === 'right' ? rightmost(points) : leftmost(points);
    const fallback = {
      x: side === 'right' ? bounds.maxX : bounds.minX,
      y: bounds.minY + 70 + index * 60,
    };
    const base = anchor ?? fallback;
    map.set(port.id, snapPoint({
      x: base.x + (side === 'right' ? 110 : -110),
      y: base.y + index * 16,
    }));
  });
  powers.forEach((port, index) => {
    const points = pinPointsByNet.get(port.net) ?? [];
    const anchor = topmost(points);
    map.set(port.id, snapPoint(anchor
      ? { x: anchor.x + index * 80, y: anchor.y - 110 }
      : { x: bounds.minX + 110 + index * 110, y: bounds.minY - 90 }));
  });
  grounds.forEach((port, index) => {
    const points = pinPointsByNet.get(port.net) ?? [];
    const anchor = bottommost(points);
    map.set(port.id, snapPoint(anchor
      ? { x: anchor.x + index * 80, y: anchor.y + 120 }
      : { x: bounds.minX + 110 + index * 110, y: bounds.maxY + 100 }));
  });
  return map;
}

function signalPortSide(port: CircuitPort, points: CircuitPosition[], bounds: SchematicBounds): SignalPortSide {
  if (points.length === 0) return port.direction === 'output' ? 'right' : 'left';
  if (port.direction === 'output') return 'right';
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const anchor = leftmost(points);
  if (!anchor) return 'left';
  return anchor.x > centerX + SCHEMATIC_GRID ? 'right' : 'left';
}

export function moduleBounds(
  module: CircuitModule,
  portPositions: Map<string, CircuitPosition>,
  wires: CircuitWire[],
  netLabels: SchematicNetLabel[] = [],
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
  for (const label of netLabels) {
    xs.push(label.position.x - 72, label.position.x + 72);
    ys.push(label.position.y - 58, label.position.y + 58);
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

export function isPmosComponent(component: CircuitComponent): boolean {
  return /pmos|pfet|p-channel|p channel|\bp\b/i.test(`${component.id} ${component.name} ${component.value}`);
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
      points: routePointsForModule(module, startPoint, endPoint, start, end),
      from: stripEndpoint(startPoint, start),
      to: stripEndpoint(endPoint, end),
      net: mergedNet,
    },
  ];
}

export function removeWireAndUpdateConnectivity(module: CircuitModule, wireOrId: CircuitWire | string): CircuitModule {
  const next = cloneModule(module);
  const selectedWire = typeof wireOrId === 'string'
    ? next.wires?.find((wire) => wire.id === wireOrId)
    : wireOrId;
  const selectedId = typeof wireOrId === 'string' ? wireOrId : wireOrId.id;
  next.wires = (next.wires ?? []).filter((wire) => wire.id !== selectedId);
  if (selectedWire) splitNetAfterWireRemoval(next, selectedWire);
  return normalizeConnectivity(next);
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

function routePointsForModule(
  module: CircuitModule,
  startPoint: CircuitPosition,
  endPoint: CircuitPosition,
  startEndpoint?: CircuitWireEndpoint,
  endEndpoint?: CircuitWireEndpoint,
): CircuitPosition[] {
  const excludedComponentIds = new Set(
    [startEndpoint?.component_id, endEndpoint?.component_id].filter(Boolean) as string[],
  );
  const obstacles = module.components
    .filter((component) => !excludedComponentIds.has(component.id))
    .map((component) => padBounds(componentBounds(component), 14));
  const candidates = orthogonalRouteCandidates(startPoint, endPoint, obstacles);
  return candidates
    .filter((points) => routeIsClear(points, obstacles))
    .sort((left, right) => routeCost(left) - routeCost(right))[0] ?? routePoints(startPoint, endPoint);
}

function orthogonalRouteCandidates(
  startPoint: CircuitPosition,
  endPoint: CircuitPosition,
  obstacles: SchematicBounds[],
): CircuitPosition[][] {
  const candidates = [
    routePoints(startPoint, endPoint),
    [startPoint, { x: startPoint.x, y: endPoint.y }, endPoint],
    [startPoint, { x: endPoint.x, y: startPoint.y }, endPoint],
  ];
  const detourXs = new Set<number>();
  const detourYs = new Set<number>();
  for (const obstacle of obstacles) {
    detourXs.add(snap(obstacle.minX - SCHEMATIC_GRID));
    detourXs.add(snap(obstacle.maxX + SCHEMATIC_GRID));
    detourYs.add(snap(obstacle.minY - SCHEMATIC_GRID));
    detourYs.add(snap(obstacle.maxY + SCHEMATIC_GRID));
  }
  for (const x of detourXs) {
    candidates.push([startPoint, { x, y: startPoint.y }, { x, y: endPoint.y }, endPoint]);
  }
  for (const y of detourYs) {
    candidates.push([startPoint, { x: startPoint.x, y }, { x: endPoint.x, y }, endPoint]);
  }
  return candidates.map(compactRoute);
}

function compactRoute(points: CircuitPosition[]): CircuitPosition[] {
  const deduped: CircuitPosition[] = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    deduped.push(point);
  }
  if (deduped.length <= 2) return deduped;
  return deduped.filter((point, index) => {
    if (index === 0 || index === deduped.length - 1) return true;
    const previous = deduped[index - 1];
    const next = deduped[index + 1];
    if (!previous || !next) return true;
    return !(
      previous.x === point.x && point.x === next.x ||
      previous.y === point.y && point.y === next.y
    );
  });
}

function routeIsClear(points: CircuitPosition[], obstacles: SchematicBounds[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    if (obstacles.some((obstacle) => segmentIntersectsBounds(start, end, obstacle))) return false;
  }
  return true;
}

function segmentIntersectsBounds(start: CircuitPosition, end: CircuitPosition, bounds: SchematicBounds): boolean {
  if (start.x === end.x) {
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return start.x >= bounds.minX && start.x <= bounds.maxX && maxY >= bounds.minY && minY <= bounds.maxY;
  }
  if (start.y === end.y) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    return start.y >= bounds.minY && start.y <= bounds.maxY && maxX >= bounds.minX && minX <= bounds.maxX;
  }
  return segmentIntersectsBounds(start, { x: end.x, y: start.y }, bounds) ||
    segmentIntersectsBounds({ x: end.x, y: start.y }, end, bounds);
}

function routeCost(points: CircuitPosition[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    length += Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
  }
  return length + points.length * 8;
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
    if (left && wire.net && !nets.get(left)) nets.set(left, wire.net);
    if (right && wire.net && !nets.get(right)) nets.set(right, wire.net);
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
    points: routePointsForModule(module, start, end, wire.from, wire.to),
  };
}

function syncWireEndpointPoints(
  module: CircuitModule,
  wire: CircuitWire,
  portPositions: Map<string, CircuitPosition>,
): CircuitWire {
  const start = endpointWorldPosition(module, wire.from, portPositions);
  const end = endpointWorldPosition(module, wire.to, portPositions);
  if (!start || !end) return wire;
  const points = (wire.points ?? []).map((point) => ({ x: point.x, y: point.y }));
  if (points.length < 2) {
    return rerouteWire(module, wire, portPositions);
  }
  points[0] = start;
  points[points.length - 1] = end;
  return {
    ...wire,
    from: wire.from ? { ...wire.from, x: start.x, y: start.y } : wire.from,
    to: wire.to ? { ...wire.to, x: end.x, y: end.y } : wire.to,
    points: compactRoute(points),
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
    if (!document.connectedPortIds.has(port.id)) continue;
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
    if (pointHitsComponentGraphic(component, world)) return component;
  }
  return null;
}

export function hitWire(document: SchematicDocument, world: CircuitPosition): CircuitWire | null {
  const wires = document.wires ?? [];
  const storedIds = new Set((document.module.wires ?? []).map((wire) => wire.id));
  const stored = wires.filter((wire) => wire.source === 'stored' || storedIds.has(wire.id));
  const generated = wires.filter((wire) => wire.source !== 'stored' && !storedIds.has(wire.id));
  return hitWireGroup(stored, world) ?? hitWireGroup(generated, world);
}

export function distance(left: CircuitPosition, right: CircuitPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pointHitsComponentGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const pins = component.pins.map((pin, index) => pinWorld(component, pin, index));
  if (pins.some((point) => distance(point, world) <= PIN_REACH)) return true;
  if (component.pins.length === 2 && pointNearTwoPinLeads(component, world)) return true;

  if (component.type === 'M') return pointNearMosGraphic(component, world);
  if (component.type === 'Q') return pointNearBjtGraphic(component, world);

  const local = componentLocalPoint(component, world);
  if (component.type === 'R') return Math.abs(local.x) <= 32 && Math.abs(local.y) <= 14;
  if (component.type === 'C') return Math.abs(local.x) <= 16 && Math.abs(local.y) <= 36;
  if (component.type === 'L') return Math.abs(local.x) <= 38 && Math.abs(local.y) <= 12;
  if (component.type === 'D') return local.x >= -26 && local.x <= 26 && local.y >= -29 && local.y <= 29;
  if (component.type === 'V' || component.type === 'I') return Math.hypot(local.x, local.y) <= 31;
  return Math.hypot(local.x, local.y) <= 28;
}

function pointNearTwoPinLeads(component: CircuitComponent, world: CircuitPosition): boolean {
  const offsets = twoPinBodyTerminalOffsets(component);
  return component.pins.some((pin, index) => {
    const pinPoint = pinWorld(component, pin, index);
    const offset = offsets[index];
    if (!offset) return false;
    const bodyPoint = {
      x: component.position.x + offset.x,
      y: component.position.y + offset.y,
    };
    return pointToSegmentDistance(world, pinPoint, bodyPoint) <= 7;
  });
}

function twoPinBodyTerminalOffsets(component: CircuitComponent): [CircuitPosition, CircuitPosition] {
  let span = 28;
  if (component.type === 'C') span = 8;
  if (component.type === 'D') span = 22;
  if (component.type === 'L') span = 36;
  if (component.type === 'V' || component.type === 'I') span = 28;
  return [
    rotateOffset({ x: -span, y: 0 }, normalizeRotation(component.rotation)),
    rotateOffset({ x: span, y: 0 }, normalizeRotation(component.rotation)),
  ];
}

function componentLocalPoint(component: CircuitComponent, world: CircuitPosition): CircuitPosition {
  const dx = world.x - component.position.x;
  const dy = world.y - component.position.y;
  const rotation = normalizeRotation(component.rotation);
  if (rotation === 90) return { x: dy, y: -dx };
  if (rotation === 180) return { x: -dx, y: -dy };
  if (rotation === 270) return { x: -dy, y: dx };
  return { x: dx, y: dy };
}

function pointNearMosGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const local = componentLocalPoint(component, world);
  if (Math.abs(local.x) <= 46 && Math.abs(local.y) <= 58) return true;
  const pmos = isPmosComponent(component);
  const gateX = -20;
  const channelX = 12;
  const segments: Array<[CircuitPosition, CircuitPosition]> = [
    [{ x: gateX, y: -34 }, { x: gateX, y: 34 }],
    [{ x: channelX, y: -38 }, { x: channelX, y: 38 }],
    [{ x: -58, y: 0 }, { x: pmos ? -31 : gateX, y: 0 }],
    [{ x: channelX, y: -30 }, { x: 26, y: -52 }],
    [{ x: channelX, y: 30 }, { x: 26, y: 52 }],
    [{ x: channelX, y: 0 }, { x: 58, y: 0 }],
  ];
  return segments.some(([start, end]) => pointToSegmentDistance(local, start, end) <= 8);
}

function pointNearBjtGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const local = componentLocalPoint(component, world);
  if (Math.abs(local.x) <= 44 && Math.abs(local.y) <= 58) return true;
  const segments: Array<[CircuitPosition, CircuitPosition]> = [
    [{ x: -18, y: -34 }, { x: -18, y: 34 }],
    [{ x: -58, y: 0 }, { x: -18, y: 0 }],
    [{ x: -18, y: -20 }, { x: 30, y: -52 }],
    [{ x: -18, y: 20 }, { x: 30, y: 52 }],
  ];
  return segments.some(([start, end]) => pointToSegmentDistance(local, start, end) <= 8);
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
    const pmos = isPmosComponent(component);
    if (/gate|\bg\b/.test(key)) offset = { x: -58, y: 0 };
    else if (/drain|\bd\b/.test(key)) offset = { x: 26, y: pmos ? 52 : -52 };
    else if (/source|\bs\b/.test(key)) offset = { x: 26, y: pmos ? -52 : 52 };
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
    .map((wire) => ({ ...syncWireEndpointPoints(module, wire, portPositions), source: 'stored' as const }));
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

  const wires: CircuitWire[] = [...stored];
  for (const [net, endpoints] of endpointsByNet) {
    if (endpoints.length < 2) continue;
    if (shouldRepresentNetWithLocalLabel(module, net)) continue;
    if (shouldRepresentSignalNetWithLocalLabel(module, net, endpoints)) continue;
    const anchor = chooseNetAnchor(endpoints);
    for (const endpoint of endpoints) {
      if (endpoint === anchor) continue;
      if (distance(endpointDrawPoint(anchor), endpointDrawPoint(endpoint)) < 1) continue;
      const pairKey = endpointPairKey(anchor, endpoint);
      if (usedPairs.has(pairKey)) continue;
      usedPairs.add(pairKey);
      const id = makeId(`net_${wireIdToken(net)}_`, existingIds);
      existingIds.add(id);
      const startPoint = endpointDrawPoint(anchor);
      const endPoint = endpointDrawPoint(endpoint);
      wires.push({
        id,
        points: routePointsForModule(module, startPoint, endPoint, anchor, endpoint),
        from: stripEndpoint(startPoint, anchor),
        to: stripEndpoint(endPoint, endpoint),
        net,
        source: 'net',
      });
    }
  }
  return wires;
}

function createNetLabels(module: CircuitModule, portPositions: Map<string, CircuitPosition>): SchematicNetLabel[] {
  const labels: SchematicNetLabel[] = [];
  const endpointsByNet = new Map<string, EndpointHit[]>();

  const remember = (net: string | undefined, endpoint: EndpointHit) => {
    if (!net) return;
    endpointsByNet.set(net, [...(endpointsByNet.get(net) ?? []), endpoint]);
  };

  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      const position = pinWorld(component, pin, index);
      remember(pin.net, {
        kind: 'pin',
        x: position.x,
        y: position.y,
        component_id: component.id,
        pin_id: pin.id,
        label: `${component.name}.${pin.name}`,
        net: pin.net,
      });
      if (!shouldRepresentNetWithLocalLabel(module, pin.net)) return;
      if (!shouldLabelRailPin(component, pin)) return;
      labels.push({
        id: `label_${wireIdToken(pin.net)}_${component.id}_${pin.id}`,
        kind: isGroundNet(pin.net, module) ? 'ground' : 'power',
        net: pin.net,
        name: railLabelName(module, pin.net),
        position,
        endpoint: {
          x: position.x,
          y: position.y,
          component_id: component.id,
          pin_id: pin.id,
        },
      });
    });
  }

  for (const port of module.ports) {
    const position = portPositions.get(port.id);
    if (!position) continue;
    remember(port.net, {
      kind: 'port',
      x: position.x,
      y: position.y,
      port_id: port.id,
      label: port.name,
      net: port.net,
    });
  }

  for (const [net, endpoints] of endpointsByNet) {
    if (!shouldRepresentSignalNetWithLocalLabel(module, net, endpoints)) continue;
    for (const endpoint of endpoints) {
      if (endpoint.kind !== 'pin' || !endpoint.component_id || !endpoint.pin_id) continue;
      const component = module.components.find((entry) => entry.id === endpoint.component_id);
      const pinIndex = component?.pins.findIndex((pin) => pin.id === endpoint.pin_id) ?? -1;
      const pin = pinIndex >= 0 ? component?.pins[pinIndex] : undefined;
      if (!component || !pin) continue;
      labels.push({
        id: `label_${wireIdToken(net)}_${component.id}_${pin.id}`,
        kind: 'signal',
        net,
        name: formatSignalLabelName(net),
        position: { x: endpoint.x, y: endpoint.y },
        endpoint: {
          x: endpoint.x,
          y: endpoint.y,
          component_id: component.id,
          pin_id: pin.id,
        },
        side: labelSideForPin(component, pin, pinIndex),
      });
    }
  }
  return labels;
}

function shouldRepresentNetWithLocalLabel(module: CircuitModule, net: string | undefined): boolean {
  return Boolean(net && isRailNet(net, module));
}

function shouldLabelRailPin(component: CircuitComponent, pin: CircuitPin): boolean {
  if (component.type !== 'M') return true;
  const pinKey = `${pin.id} ${pin.name}`.toLowerCase();
  if (!/body|bulk|\bb\b/.test(pinKey)) return true;
  return false;
}

function railLabelName(module: CircuitModule, net: string): string {
  if (isGroundNet(net, module)) {
    return module.ports.find((port) => port.net === net && isGroundPort(port))?.name || 'GND';
  }
  return module.ports.find((port) => port.net === net && port.signal_type === 'power')?.name || net.toUpperCase();
}

function shouldRepresentSignalNetWithLocalLabel(module: CircuitModule, net: string | undefined, endpoints: EndpointHit[]): boolean {
  if (!net || endpoints.length < 2) return false;
  if (!isReadableSignalNetName(net)) return false;
  if (module.ports.some((port) => port.net === net)) return false;
  const xs = endpoints.map((endpoint) => endpoint.x);
  const ys = endpoints.map((endpoint) => endpoint.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return spanX > 260 || spanY > 180;
}

function isReadableSignalNetName(net: string): boolean {
  return !/^(n|net|node)[_-]?\d+$/i.test(net) && net.length <= 18;
}

function formatSignalLabelName(net: string): string {
  return net.replace(/_/g, ' ').toUpperCase();
}

function labelSideForPin(component: CircuitComponent, pin: CircuitPin, index: number): 'left' | 'right' | 'top' | 'bottom' {
  const point = pinWorld(component, pin, index);
  const dx = point.x - component.position.x;
  const dy = point.y - component.position.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

function hitWireGroup(wires: CircuitWire[], world: CircuitPosition): CircuitWire | null {
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

function splitNetAfterWireRemoval(module: CircuitModule, removedWire: CircuitWire) {
  const affectedNet = removedWire.net ?? endpointNet(module, removedWire.from) ?? endpointNet(module, removedWire.to);
  const leftKey = endpointKey(removedWire.from);
  const rightKey = endpointKey(removedWire.to);
  if (!affectedNet || !leftKey || !rightKey) return;

  const affectedKeys = endpointKeysForNet(module, affectedNet);
  if (!affectedKeys.has(leftKey) || !affectedKeys.has(rightKey)) return;

  const adjacency = new Map<string, Set<string>>();
  for (const key of affectedKeys) adjacency.set(key, new Set());
  for (const wire of module.wires ?? []) {
    const left = endpointKey(wire.from);
    const right = endpointKey(wire.to);
    if (!left || !right || !affectedKeys.has(left) || !affectedKeys.has(right)) continue;
    adjacency.get(left)?.add(right);
    adjacency.get(right)?.add(left);
  }

  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const key of affectedKeys) {
    if (seen.has(key)) continue;
    const group: string[] = [];
    const queue = [key];
    seen.add(key);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      group.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  if (groups.length <= 1) return;

  const existingNets = collectNets(module);
  const keptGroup = groups.find((group) => group.includes(leftKey)) ?? groups[0];
  for (const group of groups) {
    if (group === keptGroup) continue;
    const nextNet = makeFreshNet(affectedNet, existingNets);
    existingNets.add(nextNet);
    for (const key of group) setEndpointNetByKey(module, key, nextNet);
  }
}

function endpointKeysForNet(module: CircuitModule, net: string): Set<string> {
  const keys = new Set<string>();
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net === net) keys.add(`c:${component.id}:${pin.id}`);
    }
  }
  for (const port of module.ports) {
    if (port.net === net) keys.add(`p:${port.id}`);
  }
  return keys;
}

function collectNets(module: CircuitModule): Set<string> {
  const nets = new Set<string>();
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net) nets.add(pin.net);
    }
  }
  for (const port of module.ports) {
    if (port.net) nets.add(port.net);
  }
  for (const wire of module.wires ?? []) {
    if (wire.net) nets.add(wire.net);
  }
  return nets;
}

function makeFreshNet(baseNet: string, existingNets: Set<string>): string {
  const token = wireIdToken(baseNet);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `n_${token}_${index}`;
    if (!existingNets.has(candidate)) return candidate;
  }
  return `n_${token}_${Date.now()}`;
}

function setEndpointNetByKey(module: CircuitModule, key: string, net: string) {
  if (key.startsWith('c:')) {
    const [, componentId, pinId] = key.split(':');
    const component = module.components.find((entry) => entry.id === componentId);
    const pin = component?.pins.find((entry) => entry.id === pinId);
    if (pin) pin.net = net;
    return;
  }
  if (key.startsWith('p:')) {
    const [, portId] = key.split(':');
    const port = module.ports.find((entry) => entry.id === portId);
    if (port) port.net = net;
  }
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

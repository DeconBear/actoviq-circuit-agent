import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface DesignComponent {
  name: string;
  type: string;
  nodes: string[];
  schematic_nodes?: string[];
  control_nodes?: string[];
  display_value?: string;
  sim_value?: string;
  mount_policy?: string;
  symbol_hint?: string;
}

interface DesignPayload {
  components?: DesignComponent[];
  interfaces?: {
    input_node?: string | null;
    output_node?: string | null;
  };
  io_inference?: {
    input_node?: string | null;
    output_node?: string | null;
  };
}

interface ScenePlacementRecord {
  x?: number;
  y?: number;
  rotation?: number;
  label?: string;
}

interface ScenePlacementArrayItem {
  component?: string;
  position?: [number, number];
  rotation?: number;
  label?: string;
}

interface SceneAnnotation {
  text?: string;
  position?: [number, number];
  font_size?: number;
}

interface SceneHint {
  title?: string;
  placements?: Record<string, ScenePlacementRecord> | ScenePlacementArrayItem[];
  annotations?: SceneAnnotation[];
}

interface NormalizedScene {
  title?: string;
  placements: Record<string, ScenePlacementRecord>;
  annotations: SceneAnnotation[];
}

interface Point {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

type Orientation = 'horizontal' | 'vertical';
type SymbolKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'source'
  | 'bjt'
  | 'mosfet'
  | 'opamp'
  | 'comparator'
  | 'terminal_in'
  | 'terminal_out'
  | 'ground'
  | 'vcc'
  | 'vee'
  | 'generic';

interface Port {
  node: string;
  point: Point;
  owner: 'component' | 'terminal';
}

interface PlacedSymbol {
  id: string;
  kind: SymbolKind;
  orientation: Orientation;
  box: Box;
  ports: Port[];
  label: string;
  value: string;
}

interface NetWire {
  net: string;
  points: Point[];
}

const GRID = 16;
const MARGIN = 48;
const TERMINAL_SPACING = 96;

type LayoutProfile = 'generic' | 'signal_chain_comparator' | 'rf_mixed_signal';

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function componentNodes(component: DesignComponent): string[] {
  return component.schematic_nodes?.length ? component.schematic_nodes : component.nodes;
}

function resolveLayoutProfile(
  components: DesignComponent[],
  inputNode: string | null,
  outputNode: string | null,
): LayoutProfile {
  if (isSignalChainComparatorProfile(components, inputNode, outputNode)) {
    return 'signal_chain_comparator';
  }
  return isRfMixedSignalProfile(components, inputNode, outputNode) ? 'rf_mixed_signal' : 'generic';
}

function routeKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function compactValueLabel(value: string): string {
  const text = value.trim();
  if (!text) {
    return '';
  }
  if (text.length > 38 || /tanh|v\(|\{|\}/i.test(text)) {
    return 'behavioral threshold';
  }
  return text;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeScene(raw: SceneHint | null | undefined): NormalizedScene {
  const placements: Record<string, ScenePlacementRecord> = {};
  const source = raw?.placements;
  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || !item.component) {
        continue;
      }
      const [x, y] = Array.isArray(item.position) ? item.position : [undefined, undefined];
      placements[item.component] = {
        x: isFiniteNumber(x) ? x : undefined,
        y: isFiniteNumber(y) ? y : undefined,
        rotation: isFiniteNumber(item.rotation) ? item.rotation : undefined,
        label: typeof item.label === 'string' ? item.label : undefined,
      };
    }
  } else if (source && typeof source === 'object') {
    for (const [name, hint] of Object.entries(source)) {
      placements[name] = {
        x: isFiniteNumber(hint?.x) ? hint.x : undefined,
        y: isFiniteNumber(hint?.y) ? hint.y : undefined,
        rotation: isFiniteNumber(hint?.rotation) ? hint.rotation : undefined,
        label: typeof hint?.label === 'string' ? hint.label : undefined,
      };
    }
  }

  return {
    title: typeof raw?.title === 'string' ? raw.title : undefined,
    placements,
    annotations: Array.isArray(raw?.annotations) ? raw.annotations : [],
  };
}

function railKind(node: string): 'gnd' | 'vcc' | 'vee' | null {
  const value = node.trim().toLowerCase();
  if (value === '0' || value.endsWith('gnd') || ['gnd', 'agnd', 'dgnd', 'pgnd'].includes(value)) {
    return 'gnd';
  }
  if (value.startsWith('vcc') || value.startsWith('vdd')) {
    return 'vcc';
  }
  if (value.startsWith('vee') || value.startsWith('vss')) {
    return 'vee';
  }
  return null;
}

function isRailNode(node: string): boolean {
  return railKind(node) !== null;
}

function normalizeRotation(rotation: number | undefined): number {
  const source = isFiniteNumber(rotation) ? rotation : 0;
  const turns = Math.round(source / 90);
  const normalized = turns * 90;
  return ((normalized % 360) + 360) % 360;
}

function symbolKindForComponent(component: DesignComponent): SymbolKind {
  const symbolHint = component.symbol_hint?.trim().toLowerCase();
  if (symbolHint === 'opamp') {
    return 'opamp';
  }
  if (symbolHint === 'comparator') {
    return 'comparator';
  }
  switch (component.type) {
    case 'resistor':
      return 'resistor';
    case 'capacitor':
      return 'capacitor';
    case 'inductor':
      return 'inductor';
    case 'diode':
      return 'diode';
    case 'voltage_source':
    case 'current_source':
      return 'source';
    case 'bjt':
      return 'bjt';
    case 'mosfet':
      return 'mosfet';
    default:
      return 'generic';
  }
}

function isSignalChainComparatorProfile(
  components: DesignComponent[],
  inputNode: string | null,
  outputNode: string | null,
): boolean {
  if (!inputNode || !outputNode) {
    return false;
  }
  const hints = new Set(
    components.map((component) => component.symbol_hint?.trim().toLowerCase()).filter((value): value is string => Boolean(value)),
  );
  if (!hints.has('opamp') || !hints.has('comparator')) {
    return false;
  }
  const nodeSet = new Set(components.flatMap((component) => componentNodes(component).map((node) => node.toLowerCase())));
  return nodeSet.has('filt') || nodeSet.has('vth') || outputNode.toLowerCase().endsWith('_n');
}

function isRfMixedSignalProfile(
  components: DesignComponent[],
  inputNode: string | null,
  outputNode: string | null,
): boolean {
  if (!inputNode || !outputNode) {
    return false;
  }
  const types = new Set(components.map((component) => component.type.toLowerCase()));
  const hints = new Set(
    components.map((component) => component.symbol_hint?.trim().toLowerCase()).filter((value): value is string => Boolean(value)),
  );
  const nodeSet = new Set(components.flatMap((component) => componentNodes(component).map((node) => node.toLowerCase())));
  const hasRfFrontend = types.has('inductor') && (types.has('mosfet') || types.has('bjt'));
  const hasDetector = types.has('diode') && [...nodeSet].some((node) => /^(det|env|lpf|adc)/.test(node));
  const hasDigitizer = hints.has('comparator') || [...nodeSet].some((node) => node.endsWith('_n'));
  return hasRfFrontend && hasDetector && hasDigitizer;
}

function placementForSignalChainComparator(
  component: DesignComponent,
  inputNode: string | null,
  outputNode: string | null,
): ScenePlacementRecord | undefined {
  const name = component.name.toLowerCase();
  const nodes = componentNodes(component).map((node) => node.toLowerCase());
  const hasNode = (value: string | null | undefined): boolean => Boolean(value && nodes.includes(value.toLowerCase()));
  const hasAnyNode = (...values: string[]): boolean => values.some((value) => nodes.includes(value.toLowerCase()));

  if (component.symbol_hint?.toLowerCase() === 'opamp') {
    return { x: 224, y: 206 };
  }
  if (component.symbol_hint?.toLowerCase() === 'comparator') {
    return { x: 512, y: 206 };
  }
  if (name.startsWith('rin') || (hasNode(inputNode) && hasAnyNode('vp', 'inp', 'vinp'))) {
    return { x: 132, y: 170 };
  }
  if (name.startsWith('rfb_top') || (hasAnyNode('op_out', 'opout') && hasAnyNode('vn', 'inn', 'vinn'))) {
    return { x: 236, y: 124 };
  }
  if (name.startsWith('rfb_bot') || (hasAnyNode('vn', 'inn', 'vinn') && nodes.some((node) => railKind(node) === 'gnd'))) {
    return { x: 60, y: 286, rotation: 90 };
  }
  if (name.startsWith('rop') || (hasAnyNode('op_raw') && hasAnyNode('op_out', 'opout'))) {
    return { x: 316, y: 206 };
  }
  if (name.startsWith('cop') || (hasAnyNode('op_out', 'opout') && nodes.some((node) => railKind(node) === 'gnd'))) {
    return { x: 304, y: 302, rotation: 90 };
  }
  if (name.startsWith('rlp') || (hasAnyNode('op_out', 'opout') && hasAnyNode('filt', 'flt'))) {
    return { x: 392, y: 168 };
  }
  if (name.startsWith('clp') || (hasAnyNode('filt', 'flt') && nodes.some((node) => railKind(node) === 'gnd'))) {
    return { x: 404, y: 302, rotation: 90 };
  }
  if (name.startsWith('rth1') || (hasAnyNode('vth', 'ref') && nodes.some((node) => railKind(node) === 'vcc'))) {
    return { x: 540, y: 118, rotation: 90 };
  }
  if (name.startsWith('rth2') || (hasAnyNode('vth', 'ref') && nodes.some((node) => railKind(node) === 'gnd'))) {
    return { x: 540, y: 286, rotation: 90 };
  }
  if (hasNode(outputNode) || name.startsWith('rout')) {
    return { x: 600, y: 206 };
  }
  return undefined;
}

function placementForRfMixedSignal(
  component: DesignComponent,
  inputNode: string | null,
  outputNode: string | null,
): ScenePlacementRecord | undefined {
  const name = component.name.toLowerCase();
  const nodes = componentNodes(component).map((node) => node.toLowerCase());
  const hasNode = (value: string | null | undefined): boolean => Boolean(value && nodes.includes(value.toLowerCase()));
  const hasAnyNode = (...values: string[]): boolean => values.some((value) => nodes.includes(value.toLowerCase()));
  const hasGround = nodes.some((node) => railKind(node) === 'gnd');
  const hasPower = nodes.some((node) => railKind(node) === 'vcc');

  if (hasNode(inputNode)) {
    return { x: 116, y: 226 };
  }
  if (name.startsWith('cin') || name.startsWith('crf') || name.startsWith('cblock')) {
    return { x: 124, y: 226 };
  }
  if (name.startsWith('lmatch') || name.startsWith('lin') || (component.type === 'inductor' && hasAnyNode('match', 'gate'))) {
    return { x: 212, y: 226 };
  }
  if (name.startsWith('cmatch') || (component.type === 'capacitor' && hasAnyNode('match') && hasGround)) {
    return { x: 212, y: 326, rotation: 90 };
  }
  if (component.type === 'mosfet' || component.type === 'bjt') {
    return { x: 360, y: 226 };
  }
  if (name.startsWith('rg_top') || (hasAnyNode('vgate', 'vbias') && hasPower)) {
    return { x: 264, y: 112, rotation: 90 };
  }
  if (name.startsWith('rg_bot') || (hasAnyNode('vgate', 'vbias') && hasGround)) {
    return { x: 264, y: 340, rotation: 90 };
  }
  if (name.startsWith('rgate') || name.startsWith('riso') || name.startsWith('rg_stop')) {
    return { x: 260, y: 226 };
  }
  if (name.startsWith('rs') && hasGround) {
    return { x: 360, y: 340, rotation: 90 };
  }
  if (name.startsWith('lload') || name.startsWith('ldrain') || (component.type === 'inductor' && hasPower)) {
    return { x: 412, y: 112, rotation: 90 };
  }
  if ((name.startsWith('cdd') || name.startsWith('cdec') || name.startsWith('cvdd') || name.startsWith('cbyp')) && hasPower && hasGround) {
    return { x: 924, y: 340, rotation: 90 };
  }
  if (name.startsWith('ccouple') || (component.type === 'capacitor' && hasAnyNode('rf_amp', 'det_in'))) {
    return { x: 484, y: 226 };
  }
  if (component.type === 'diode' || name.startsWith('ddet')) {
    return { x: 580, y: 226 };
  }
  if (name.startsWith('rdet') || (component.type === 'resistor' && hasAnyNode('env', 'det', 'lpf') && hasGround)) {
    return { x: 620, y: 340, rotation: 90 };
  }
  if (name.startsWith('cdet') || (component.type === 'capacitor' && hasAnyNode('env', 'det') && hasGround)) {
    return { x: 672, y: 340, rotation: 90 };
  }
  if (name.startsWith('rlp') || name.startsWith('radc') || (component.type === 'resistor' && hasAnyNode('env', 'lpf', 'adc'))) {
    return { x: 740, y: 226 };
  }
  if (name.startsWith('clp') || name.startsWith('cadc') || (component.type === 'capacitor' && hasAnyNode('lpf', 'adc') && hasGround)) {
    return { x: 780, y: 340, rotation: 90 };
  }
  if (name.startsWith('rth1') || name.startsWith('rref_top') || (hasAnyNode('vth', 'ref') && hasPower)) {
    return { x: 1010, y: 112, rotation: 90 };
  }
  if (name.startsWith('rth2') || name.startsWith('rref_bot') || (hasAnyNode('vth', 'ref') && hasGround)) {
    return { x: 1010, y: 340, rotation: 90 };
  }
  if (component.symbol_hint?.toLowerCase() === 'comparator') {
    return { x: 940, y: 226 };
  }
  if (hasNode(outputNode)) {
    return { x: 940, y: 226 };
  }
  return undefined;
}

function buildHeuristicPlacements(
  components: DesignComponent[],
  inputNode: string | null,
  outputNode: string | null,
): Record<string, ScenePlacementRecord> {
  const profile = resolveLayoutProfile(components, inputNode, outputNode);
  if (profile === 'generic') {
    return {};
  }

  const placements: Record<string, ScenePlacementRecord> = {};
  for (const component of components) {
    const placement =
      profile === 'rf_mixed_signal'
        ? placementForRfMixedSignal(component, inputNode, outputNode)
        : placementForSignalChainComparator(component, inputNode, outputNode);
    if (placement) {
      placements[component.name] = placement;
    }
  }
  return placements;
}

function inferOrientation(component: DesignComponent, hint?: ScenePlacementRecord): Orientation {
  const rotation = normalizeRotation(hint?.rotation);
  if (rotation === 90 || rotation === 270) {
    return 'vertical';
  }
  if (component.type === 'bjt' || component.type === 'mosfet') {
    return 'vertical';
  }
  if (componentNodes(component).length === 2 && componentNodes(component).some((node) => isRailNode(node))) {
    return 'vertical';
  }
  return 'horizontal';
}

function symbolSize(kind: SymbolKind, orientation: Orientation): { width: number; height: number } {
  if (kind === 'terminal_in' || kind === 'terminal_out') {
    return { width: 36, height: 24 };
  }
  if (kind === 'ground') {
    return { width: 28, height: 28 };
  }
  if (kind === 'vcc' || kind === 'vee') {
    return { width: 20, height: 28 };
  }
  if (kind === 'bjt') {
    return { width: 56, height: 56 };
  }
  if (kind === 'mosfet') {
    return { width: 56, height: 76 };
  }
  if (kind === 'opamp' || kind === 'comparator') {
    return { width: 88, height: 72 };
  }
  if (orientation === 'vertical') {
    return { width: 40, height: 96 };
  }
  return { width: 96, height: 40 };
}

function centerToBox(center: Point, size: { width: number; height: number }): Box {
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

function defaultPlacement(index: number): Point {
  return {
    x: MARGIN + 120 + index * 160,
    y: MARGIN + 160,
  };
}

function buildComponentPorts(box: Box, component: DesignComponent, orientation: Orientation): Port[] {
  const nodes = componentNodes(component);
  if (component.type === 'bjt') {
    return [
      { node: nodes[0] ?? 'C', point: { x: box.x + box.width / 2, y: box.y }, owner: 'component' },
      { node: nodes[1] ?? 'B', point: { x: box.x, y: box.y + box.height / 2 }, owner: 'component' },
      { node: nodes[2] ?? 'E', point: { x: box.x + box.width / 2, y: box.y + box.height }, owner: 'component' },
    ];
  }
  if (component.type === 'mosfet') {
    return [
      { node: nodes[0] ?? 'D', point: { x: box.x + box.width / 2, y: box.y }, owner: 'component' },
      { node: nodes[1] ?? 'G', point: { x: box.x, y: box.y + box.height / 2 }, owner: 'component' },
      { node: nodes[2] ?? 'S', point: { x: box.x + box.width / 2, y: box.y + box.height }, owner: 'component' },
      { node: nodes[3] ?? 'B', point: { x: box.x + box.width, y: box.y + box.height / 2 }, owner: 'component' },
    ];
  }
  if (component.symbol_hint === 'opamp' || component.symbol_hint === 'comparator') {
    return [
      { node: nodes[0] ?? 'OUT', point: { x: box.x + box.width, y: box.y + box.height / 2 }, owner: 'component' as const },
      { node: nodes[1] ?? '+', point: { x: box.x, y: box.y + box.height - 22 }, owner: 'component' as const },
      { node: nodes[2] ?? '-', point: { x: box.x, y: box.y + 22 }, owner: 'component' as const },
    ].slice(0, nodes.length);
  }
  if (orientation === 'vertical') {
    return [
      { node: nodes[0] ?? 'A', point: { x: box.x + box.width / 2, y: box.y }, owner: 'component' },
      { node: nodes[1] ?? 'B', point: { x: box.x + box.width / 2, y: box.y + box.height }, owner: 'component' },
    ];
  }
  return [
    { node: nodes[0] ?? 'A', point: { x: box.x, y: box.y + box.height / 2 }, owner: 'component' },
    { node: nodes[1] ?? 'B', point: { x: box.x + box.width, y: box.y + box.height / 2 }, owner: 'component' },
  ];
}

function buildComponentPlacement(component: DesignComponent, hint: ScenePlacementRecord | undefined, index: number): PlacedSymbol {
  const orientation = inferOrientation(component, hint);
  const kind = symbolKindForComponent(component);
  const center = {
    x: hint?.x ?? defaultPlacement(index).x,
    y: hint?.y ?? defaultPlacement(index).y,
  };
  const box = centerToBox(center, symbolSize(kind, orientation));
  return {
    id: component.name,
    kind,
    orientation,
    box,
    ports: buildComponentPorts(box, component, orientation),
    label: component.name,
    value: component.display_value ?? component.sim_value ?? hint?.label ?? component.type,
  };
}

function average(points: Point[], pick: (point: Point) => number): number {
  if (points.length === 0) {
    return 0;
  }
  const sum = points.reduce((acc, point) => acc + pick(point), 0);
  return sum / points.length;
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function snapPoint(point: Point): Point {
  return { x: snap(point.x), y: snap(point.y) };
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => snap(value)))].sort((left, right) => left - right);
}

function measureBounds(items: PlacedSymbol[]): Bounds {
  if (items.length === 0) {
    return {
      minX: MARGIN,
      maxX: MARGIN + 320,
      minY: MARGIN,
      maxY: MARGIN + 240,
    };
  }
  return {
    minX: Math.min(...items.map((item) => item.box.x)),
    maxX: Math.max(...items.map((item) => item.box.x + item.box.width)),
    minY: Math.min(...items.map((item) => item.box.y)),
    maxY: Math.max(...items.map((item) => item.box.y + item.box.height)),
  };
}

function buildTerminal(net: string, role: SymbolKind, points: Point[], bounds: Bounds): PlacedSymbol | null {
  if (points.length === 0) {
    return null;
  }

  let center: Point;
  if (role === 'terminal_in') {
    center = {
      x: Math.max(MARGIN / 2, bounds.minX - TERMINAL_SPACING),
      y: Math.round(average(points, (point) => point.y)),
    };
  } else if (role === 'terminal_out') {
    center = {
      x: Math.round(bounds.maxX + TERMINAL_SPACING),
      y: Math.round(average(points, (point) => point.y)),
    };
  } else if (role === 'ground') {
    center = {
      x: Math.round(average(points, (point) => point.x)),
      y: Math.round(bounds.maxY + TERMINAL_SPACING),
    };
  } else {
    center = {
      x: Math.round(average(points, (point) => point.x)),
      y: Math.max(72, Math.round(bounds.minY - TERMINAL_SPACING)),
    };
  }

  const orientation: Orientation = role === 'ground' ? 'vertical' : 'horizontal';
  const box = centerToBox(center, symbolSize(role, orientation));
  let portPoint: Point = center;
  if (role === 'terminal_in') {
    portPoint = { x: box.x + box.width, y: center.y };
  } else if (role === 'terminal_out') {
    portPoint = { x: box.x, y: center.y };
  } else if (role === 'ground') {
    portPoint = { x: center.x, y: box.y };
  } else {
    portPoint = { x: center.x, y: box.y + box.height };
  }

  const label =
    role === 'terminal_in'
      ? 'IN'
      : role === 'terminal_out'
        ? 'OUT'
        : role === 'ground'
          ? net
          : net.toUpperCase();

  return {
    id: `${role}_${net}`,
    kind: role,
    orientation,
    box,
    ports: [{ node: net, point: portPoint, owner: 'terminal' }],
    label,
    value: '',
  };
}

function buildObstacleSet(items: PlacedSymbol[]): Set<string> {
  const blocked = new Set<string>();
  for (const item of items) {
    const minX = Math.floor((item.box.x - 12) / GRID);
    const minY = Math.floor((item.box.y - 12) / GRID);
    const maxX = Math.ceil((item.box.x + item.box.width + 12) / GRID);
    const maxY = Math.ceil((item.box.y + item.box.height + 12) / GRID);
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gy = minY; gy <= maxY; gy += 1) {
        blocked.add(`${gx},${gy}`);
      }
    }
  }
  return blocked;
}

function toGrid(point: Point): Point {
  return {
    x: Math.round(point.x / GRID),
    y: Math.round(point.y / GRID),
  };
}

function fromGrid(point: Point): Point {
  return {
    x: point.x * GRID,
    y: point.y * GRID,
  };
}

function heuristic(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstruct(cameFrom: Map<string, string>, current: Point): Point[] {
  const path: Point[] = [current];
  let cursor = routeKey(current);
  while (cameFrom.has(cursor)) {
    const prev = cameFrom.get(cursor)!;
    const [xText, yText] = prev.split(',');
    path.push({ x: Number(xText), y: Number(yText) });
    cursor = prev;
  }
  return path.reverse().map(fromGrid);
}

function neighbors(point: Point): Point[] {
  return [
    { x: point.x + 1, y: point.y },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x, y: point.y - 1 },
  ];
}

function simplifyPath(points: Point[]): Point[] {
  if (points.length <= 2) {
    return points.filter((point, index) => index === 0 || routeKey(point) !== routeKey(points[index - 1]!));
  }
  const simplified: Point[] = [points[0]!];
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = simplified[simplified.length - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const dx1 = current.x - prev.x;
    const dy1 = current.y - prev.y;
    const dx2 = next.x - current.x;
    const dy2 = next.y - current.y;
    if (dx1 === dx2 && dy1 === dy2) {
      continue;
    }
    simplified.push(current);
  }
  simplified.push(points[points.length - 1]!);
  return simplified.filter((point, index) => index === 0 || routeKey(point) !== routeKey(simplified[index - 1]!));
}

function fallbackDogleg(start: Point, end: Point): Point[] {
  return simplifyPath([start, { x: end.x, y: start.y }, end]);
}

function candidateDoglegs(start: Point, end: Point): Point[][] {
  const candidates: Point[][] = [];
  if (start.x === end.x || start.y === end.y) {
    candidates.push([start, end]);
  } else {
    candidates.push([start, { x: end.x, y: start.y }, end]);
    candidates.push([start, { x: start.x, y: end.y }, end]);
  }
  return candidates;
}

function segmentGridPoints(start: Point, end: Point): Point[] {
  const startGrid = toGrid(start);
  const endGrid = toGrid(end);
  const points: Point[] = [startGrid];
  if (startGrid.x === endGrid.x) {
    const step = startGrid.y <= endGrid.y ? 1 : -1;
    for (let y = startGrid.y + step; y !== endGrid.y + step; y += step) {
      points.push({ x: startGrid.x, y });
    }
    return points;
  }
  if (startGrid.y === endGrid.y) {
    const step = startGrid.x <= endGrid.x ? 1 : -1;
    for (let x = startGrid.x + step; x !== endGrid.x + step; x += step) {
      points.push({ x, y: startGrid.y });
    }
    return points;
  }
  return [startGrid, endGrid];
}

function isCandidatePathClear(points: Point[], blocked: Set<string>): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentPoints = segmentGridPoints(points[index]!, points[index + 1]!);
    for (const point of segmentPoints.slice(1, -1)) {
      if (blocked.has(routeKey(point))) {
        return false;
      }
    }
  }
  return true;
}

function candidatePathPenalty(points: Point[], congestion: Map<string, number>): number {
  let penalty = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentPoints = segmentGridPoints(points[index]!, points[index + 1]!);
    penalty += segmentPoints.length;
    for (const point of segmentPoints) {
      penalty += (congestion.get(routeKey(point)) ?? 0) * 5;
    }
  }
  if (points.length > 2) {
    penalty += (points.length - 2) * 6;
  }
  return penalty;
}

function markPathCongestion(points: Point[], congestion: Map<string, number>): void {
  for (let index = 0; index < points.length - 1; index += 1) {
    for (const point of segmentGridPoints(points[index]!, points[index + 1]!)) {
      const key = routeKey(point);
      congestion.set(key, (congestion.get(key) ?? 0) + 1);
    }
  }
}

function routeAStar(start: Point, end: Point, blocked: Set<string>, congestion: Map<string, number>): Point[] {
  const startGrid = toGrid(start);
  const endGrid = toGrid(end);
  const startKey = routeKey(startGrid);
  const endKey = routeKey(endGrid);
  blocked.delete(startKey);
  blocked.delete(endKey);

  const structuredCandidate = candidateDoglegs(start, end)
    .filter((points) => isCandidatePathClear(points, blocked))
    .sort((left, right) => candidatePathPenalty(left, congestion) - candidatePathPenalty(right, congestion))[0];
  if (structuredCandidate) {
    return simplifyPath(structuredCandidate);
  }

  const open = new Set<string>([startKey]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[startKey, 0]]);
  const fScore = new Map<string, number>([[startKey, heuristic(startGrid, endGrid)]]);

  let guard = 0;
  while (open.size > 0 && guard < 8000) {
    guard += 1;
    let currentKey = '';
    let currentScore = Number.POSITIVE_INFINITY;
    for (const key of open) {
      const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
      if (score < currentScore) {
        currentScore = score;
        currentKey = key;
      }
    }

    if (!currentKey) {
      break;
    }

    const [cxText, cyText] = currentKey.split(',');
    const current = { x: Number(cxText), y: Number(cyText) };
    if (currentKey === endKey) {
      return simplifyPath(reconstruct(cameFrom, current));
    }

    open.delete(currentKey);
    for (const next of neighbors(current)) {
      const nextKey = routeKey(next);
      if (blocked.has(nextKey)) {
        continue;
      }
      const tentative =
        (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) +
        1 +
        (congestion.get(nextKey) ?? 0) * 3;
      if (tentative >= (gScore.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      cameFrom.set(nextKey, currentKey);
      gScore.set(nextKey, tentative);
      fScore.set(nextKey, tentative + heuristic(next, endGrid));
      open.add(nextKey);
    }
  }

  return fallbackDogleg(start, end);
}

function sortPortsForNet(
  net: string,
  ports: Port[],
  inputNode: string | null,
  outputNode: string | null,
): Port[] {
  const terminals = ports.filter((port) => port.owner === 'terminal');
  const components = ports.filter((port) => port.owner === 'component');
  const sortedComponents = [...components].sort((a, b) => {
    if (a.point.x !== b.point.x) {
      return a.point.x - b.point.x;
    }
    return a.point.y - b.point.y;
  });

  const terminal = terminals[0];
  const rail = railKind(net);
  if (terminal && net === inputNode) {
    return [terminal, ...sortedComponents];
  }
  if (terminal && (net === outputNode || rail === 'gnd' || rail === 'vcc' || rail === 'vee')) {
    return [...sortedComponents, terminal];
  }
  if (terminal) {
    return [...sortedComponents, terminal];
  }
  return sortedComponents;
}

function sharedTrunkOrientation(
  net: string,
  ports: Port[],
  inputNode: string | null,
  outputNode: string | null,
  profile: LayoutProfile,
): Orientation {
  if (railKind(net)) {
    return 'horizontal';
  }

  if (profile === 'signal_chain_comparator') {
    const lower = net.toLowerCase();
    const preferredHorizontal = new Set([
      inputNode?.toLowerCase() ?? '',
      outputNode?.toLowerCase() ?? '',
      'vp',
      'vn',
      'op_raw',
      'op_out',
      'filt',
      'alarm_n',
    ]);
    if (lower === 'vth') {
      return 'vertical';
    }
    if (preferredHorizontal.has(lower)) {
      return 'horizontal';
    }
  }
  if (profile === 'rf_mixed_signal') {
    const lower = net.toLowerCase();
    const preferredHorizontal = new Set([
      inputNode?.toLowerCase() ?? '',
      outputNode?.toLowerCase() ?? '',
      'rf_in',
      'match',
      'gate',
      'drain',
      'rf_amp',
      'det_in',
      'env',
      'lpf',
      'adc',
      'adc_in',
      'alarm_n',
    ]);
    if (['vgate', 'vbias', 'vth', 'ref'].includes(lower)) {
      return 'vertical';
    }
    if (preferredHorizontal.has(lower)) {
      return 'horizontal';
    }
  }

  const xs = ports.map((port) => port.point.x);
  const ys = ports.map((port) => port.point.y);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const ySpan = Math.max(...ys) - Math.min(...ys);
  return xSpan >= ySpan ? 'horizontal' : 'vertical';
}

function buildNetAnchor(
  net: string,
  ports: Port[],
  inputNode: string | null,
  outputNode: string | null,
  profile: LayoutProfile,
): Point {
  const rail = railKind(net);
  const terminal =
    ports.find((port) => net === inputNode && port.owner === 'terminal') ??
    ports.find((port) => net === outputNode && port.owner === 'terminal') ??
    ports.find((port) => Boolean(rail) && port.owner === 'terminal');
  if (terminal) {
    return snapPoint(terminal.point);
  }

  const orientation = sharedTrunkOrientation(net, ports, inputNode, outputNode, profile);
  if (orientation === 'horizontal') {
    return {
      x: snap(average(ports.map((port) => port.point), (point) => point.x)),
      y: snap(average(ports.map((port) => port.point), (point) => point.y)),
    };
  }
  return {
    x: snap(average(ports.map((port) => port.point), (point) => point.x)),
    y: snap(average(ports.map((port) => port.point), (point) => point.y)),
  };
}

function dedupeWires(wires: NetWire[]): NetWire[] {
  const seen = new Set<string>();
  const deduped: NetWire[] = [];
  for (const wire of wires) {
    const forward = wire.points.map((point) => routeKey(point)).join('->');
    const reverse = [...wire.points].reverse().map((point) => routeKey(point)).join('->');
    const key = `${wire.net}:${forward < reverse ? forward : reverse}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(wire);
  }
  return deduped;
}

function buildJunctions(wires: NetWire[]): Point[] {
  const counts = new Map<string, number>();
  for (const wire of wires) {
    for (const point of wire.points) {
      const key = routeKey(point);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([key]) => {
      const [xText, yText] = key.split(',');
      return { x: Number(xText), y: Number(yText) };
    });
}

function buildSharedTrunkWires(
  netMap: Map<string, Port[]>,
  inputNode: string | null,
  outputNode: string | null,
  profile: LayoutProfile,
): NetWire[] {
  const wires: NetWire[] = [];
  for (const [net, rawPorts] of netMap) {
    if (rawPorts.length < 2) {
      continue;
    }
    const ports = sortPortsForNet(net, rawPorts, inputNode, outputNode);
    const anchor = buildNetAnchor(net, ports, inputNode, outputNode, profile);
    const orientation = sharedTrunkOrientation(net, ports, inputNode, outputNode, profile);

    if (orientation === 'horizontal') {
      const y = anchor.y;
      const xs = [...new Set([anchor.x, ...ports.map((port) => port.point.x)])].sort((left, right) => left - right);
      for (const port of ports) {
        const point = port.point;
        if (point.y !== y) {
          wires.push({ net, points: [point, { x: point.x, y }] });
        }
      }
      for (let index = 0; index < xs.length - 1; index += 1) {
        wires.push({ net, points: [{ x: xs[index]!, y }, { x: xs[index + 1]!, y }] });
      }
      continue;
    }

    const x = anchor.x;
    const ys = [...new Set([anchor.y, ...ports.map((port) => port.point.y)])].sort((top, bottom) => top - bottom);
    for (const port of ports) {
      const point = port.point;
      if (point.x !== x) {
        wires.push({ net, points: [point, { x, y: point.y }] });
      }
    }
    for (let index = 0; index < ys.length - 1; index += 1) {
      wires.push({ net, points: [{ x, y: ys[index]! }, { x, y: ys[index + 1]! }] });
    }
  }
  return dedupeWires(wires);
}

function svgPolyline(points: Point[]): string {
  const data = points.map((point) => `${point.x},${point.y}`).join(' ');
  return `<polyline points="${data}" class="wire" />`;
}

function svgText(x: number, y: number, text: string, klass: string, anchor = 'middle'): string {
  return `<text x="${x}" y="${y}" class="${klass}" text-anchor="${anchor}">${escapeXml(text)}</text>`;
}

function drawResistor(box: Box, orientation: Orientation): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (orientation === 'vertical') {
    return [
      `<polyline class="device" points="${cx},${box.y} ${cx},${box.y + 12} ${cx - 10},${box.y + 24} ${cx + 10},${box.y + 36} ${cx - 10},${box.y + 48} ${cx + 10},${box.y + 60} ${cx},${box.y + 72} ${cx},${box.y + box.height}" />`,
    ];
  }
  return [
    `<polyline class="device" points="${box.x},${cy} ${box.x + 12},${cy} ${box.x + 24},${cy - 10} ${box.x + 36},${cy + 10} ${box.x + 48},${cy - 10} ${box.x + 60},${cy + 10} ${box.x + 72},${cy} ${box.x + box.width},${cy}" />`,
  ];
}

function drawCapacitor(box: Box, orientation: Orientation): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (orientation === 'vertical') {
    return [
      `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${cy - 12}" />`,
      `<line class="device" x1="${cx - 16}" y1="${cy - 12}" x2="${cx + 16}" y2="${cy - 12}" />`,
      `<line class="device" x1="${cx - 16}" y1="${cy + 12}" x2="${cx + 16}" y2="${cy + 12}" />`,
      `<line class="device" x1="${cx}" y1="${cy + 12}" x2="${cx}" y2="${box.y + box.height}" />`,
    ];
  }
  return [
    `<line class="device" x1="${box.x}" y1="${cy}" x2="${cx - 12}" y2="${cy}" />`,
    `<line class="device" x1="${cx - 12}" y1="${cy - 16}" x2="${cx - 12}" y2="${cy + 16}" />`,
    `<line class="device" x1="${cx + 12}" y1="${cy - 16}" x2="${cx + 12}" y2="${cy + 16}" />`,
    `<line class="device" x1="${cx + 12}" y1="${cy}" x2="${box.x + box.width}" y2="${cy}" />`,
  ];
}

function drawInductor(box: Box, orientation: Orientation): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (orientation === 'vertical') {
    return [
      `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${box.y + 14}" />`,
      `<circle class="device" cx="${cx}" cy="${box.y + 28}" r="8" />`,
      `<circle class="device" cx="${cx}" cy="${box.y + 44}" r="8" />`,
      `<circle class="device" cx="${cx}" cy="${box.y + 60}" r="8" />`,
      `<circle class="device" cx="${cx}" cy="${box.y + 76}" r="8" />`,
      `<line class="device" x1="${cx}" y1="${box.y + 84}" x2="${cx}" y2="${box.y + box.height}" />`,
    ];
  }
  return [
    `<line class="device" x1="${box.x}" y1="${cy}" x2="${box.x + 12}" y2="${cy}" />`,
    `<circle class="device" cx="${box.x + 28}" cy="${cy}" r="8" />`,
    `<circle class="device" cx="${box.x + 44}" cy="${cy}" r="8" />`,
    `<circle class="device" cx="${box.x + 60}" cy="${cy}" r="8" />`,
    `<circle class="device" cx="${box.x + 76}" cy="${cy}" r="8" />`,
    `<line class="device" x1="${box.x + 84}" y1="${cy}" x2="${box.x + box.width}" y2="${cy}" />`,
  ];
}

function drawDiode(box: Box, orientation: Orientation): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (orientation === 'vertical') {
    return [
      `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${box.y + 18}" />`,
      `<path class="device" d="M ${cx - 16} ${cy - 6} L ${cx + 16} ${cy - 6} L ${cx} ${cy + 18} Z" />`,
      `<line class="device" x1="${cx - 16}" y1="${cy + 24}" x2="${cx + 16}" y2="${cy + 24}" />`,
      `<line class="device" x1="${cx}" y1="${cy + 24}" x2="${cx}" y2="${box.y + box.height}" />`,
    ];
  }
  return [
    `<line class="device" x1="${box.x}" y1="${cy}" x2="${box.x + 18}" y2="${cy}" />`,
    `<path class="device" d="M ${cx - 8} ${cy - 16} L ${cx - 8} ${cy + 16} L ${cx + 12} ${cy} Z" />`,
    `<line class="device" x1="${cx + 18}" y1="${cy - 16}" x2="${cx + 18}" y2="${cy + 16}" />`,
    `<line class="device" x1="${cx + 18}" y1="${cy}" x2="${box.x + box.width}" y2="${cy}" />`,
  ];
}

function drawSource(box: Box, orientation: Orientation): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (orientation === 'vertical') {
    return [
      `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${cy - 18}" />`,
      `<circle class="device" cx="${cx}" cy="${cy}" r="18" />`,
      `<line class="device" x1="${cx}" y1="${cy - 8}" x2="${cx}" y2="${cy + 8}" />`,
      `<line class="device" x1="${cx - 6}" y1="${cy}" x2="${cx + 6}" y2="${cy}" />`,
      `<line class="device" x1="${cx}" y1="${cy + 18}" x2="${cx}" y2="${box.y + box.height}" />`,
    ];
  }
  return [
    `<line class="device" x1="${box.x}" y1="${cy}" x2="${cx - 18}" y2="${cy}" />`,
    `<circle class="device" cx="${cx}" cy="${cy}" r="18" />`,
    `<line class="device" x1="${cx}" y1="${cy - 8}" x2="${cx}" y2="${cy + 8}" />`,
    `<line class="device" x1="${cx - 6}" y1="${cy}" x2="${cx + 6}" y2="${cy}" />`,
    `<line class="device" x1="${cx + 18}" y1="${cy}" x2="${box.x + box.width}" y2="${cy}" />`,
  ];
}

function drawBjt(box: Box): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [
    `<circle class="device" cx="${cx}" cy="${cy}" r="18" />`,
    `<line class="device" x1="${box.x}" y1="${cy}" x2="${cx - 10}" y2="${cy}" />`,
    `<line class="device" x1="${cx - 10}" y1="${cy}" x2="${cx + 8}" y2="${cy - 12}" />`,
    `<line class="device" x1="${cx - 10}" y1="${cy}" x2="${cx + 8}" y2="${cy + 12}" />`,
    `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${cy - 18}" />`,
    `<line class="device" x1="${cx}" y1="${cy + 18}" x2="${cx}" y2="${box.y + box.height}" />`,
  ];
}

function drawMosfet(box: Box): string[] {
  const cx = box.x + box.width / 2;
  return [
    `<line class="device" x1="${cx}" y1="${box.y + 10}" x2="${cx}" y2="${box.y + box.height - 10}" />`,
    `<rect class="device" x="${cx - 10}" y="${box.y + 16}" width="20" height="${box.height - 32}" rx="3" />`,
    `<line class="device" x1="${box.x}" y1="${box.y + box.height / 2}" x2="${cx - 10}" y2="${box.y + box.height / 2}" />`,
    `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${box.y + 16}" />`,
    `<line class="device" x1="${cx}" y1="${box.y + box.height - 16}" x2="${cx}" y2="${box.y + box.height}" />`,
    `<line class="device" x1="${cx + 10}" y1="${box.y + box.height / 2}" x2="${box.x + box.width}" y2="${box.y + box.height / 2}" />`,
  ];
}

function drawOpamp(box: Box, kind: 'opamp' | 'comparator', activeLow = false): string[] {
  const leftX = box.x + 10;
  const rightX = box.x + box.width - 10;
  const topY = box.y + 8;
  const bottomY = box.y + box.height - 8;
  const centerY = box.y + box.height / 2;
  const midX = box.x + box.width - 26;

  return [
    `<path class="device symbol-fill" d="M ${leftX} ${topY} L ${leftX} ${bottomY} L ${midX} ${centerY} Z" />`,
    `<line class="device" x1="${midX}" y1="${centerY}" x2="${rightX}" y2="${centerY}" />`,
    ...(activeLow ? [`<circle class="device" cx="${rightX + 8}" cy="${centerY}" r="5" />`] : []),
    `<line class="device" x1="${box.x}" y1="${box.y + 22}" x2="${leftX}" y2="${box.y + 22}" />`,
    `<line class="device" x1="${box.x}" y1="${box.y + box.height - 22}" x2="${leftX}" y2="${box.y + box.height - 22}" />`,
    svgText(box.x + 14, box.y + 26, '-', 'net', 'start'),
    svgText(box.x + 14, box.y + box.height - 18, '+', 'net', 'start'),
    ...(kind === 'comparator'
      ? [svgText(box.x + box.width / 2 - 4, box.y + box.height / 2 + 4, 'CMP', 'net')]
      : []),
  ];
}

function drawTerminal(box: Box, kind: SymbolKind): string[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (kind === 'terminal_in') {
    return [`<path class="device" d="M ${box.x} ${box.y} L ${box.x} ${box.y + box.height} L ${box.x + box.width} ${cy} Z" />`];
  }
  if (kind === 'terminal_out') {
    return [`<path class="device" d="M ${box.x + box.width} ${box.y} L ${box.x + box.width} ${box.y + box.height} L ${box.x} ${cy} Z" />`];
  }
  if (kind === 'ground') {
    return [
      `<line class="device" x1="${cx}" y1="${box.y}" x2="${cx}" y2="${box.y + 10}" />`,
      `<line class="device" x1="${box.x}" y1="${box.y + 10}" x2="${box.x + box.width}" y2="${box.y + 10}" />`,
      `<line class="device" x1="${box.x + 4}" y1="${box.y + 16}" x2="${box.x + box.width - 4}" y2="${box.y + 16}" />`,
      `<line class="device" x1="${box.x + 8}" y1="${box.y + 22}" x2="${box.x + box.width - 8}" y2="${box.y + 22}" />`,
    ];
  }
  const cxArrow = box.x + box.width / 2;
  if (kind === 'vcc') {
    return [
      `<line class="device" x1="${cxArrow}" y1="${box.y + box.height}" x2="${cxArrow}" y2="${box.y + 10}" />`,
      `<path class="device" d="M ${cxArrow - 8} ${box.y + 14} L ${cxArrow} ${box.y} L ${cxArrow + 8} ${box.y + 14}" />`,
    ];
  }
  return [
    `<line class="device" x1="${cxArrow}" y1="${box.y}" x2="${cxArrow}" y2="${box.y + box.height - 10}" />`,
    `<path class="device" d="M ${cxArrow - 8} ${box.y + box.height - 14} L ${cxArrow} ${box.y + box.height} L ${cxArrow + 8} ${box.y + box.height - 14}" />`,
  ];
}

function drawGeneric(box: Box): string[] {
  return [`<rect class="device" x="${box.x + 8}" y="${box.y + 8}" width="${box.width - 16}" height="${box.height - 16}" rx="6" />`];
}

function drawSymbol(symbol: PlacedSymbol): string[] {
  switch (symbol.kind) {
    case 'resistor':
      return drawResistor(symbol.box, symbol.orientation);
    case 'capacitor':
      return drawCapacitor(symbol.box, symbol.orientation);
    case 'inductor':
      return drawInductor(symbol.box, symbol.orientation);
    case 'diode':
      return drawDiode(symbol.box, symbol.orientation);
    case 'source':
      return drawSource(symbol.box, symbol.orientation);
    case 'bjt':
      return drawBjt(symbol.box);
    case 'mosfet':
      return drawMosfet(symbol.box);
    case 'opamp':
    case 'comparator':
      return drawOpamp(symbol.box, symbol.kind, symbol.kind === 'comparator' && symbol.ports[0]?.node.toLowerCase().endsWith('_n'));
    case 'terminal_in':
    case 'terminal_out':
    case 'ground':
    case 'vcc':
    case 'vee':
      return drawTerminal(symbol.box, symbol.kind);
    default:
      return drawGeneric(symbol.box);
  }
}

function usesSideLabels(symbol: PlacedSymbol): boolean {
  return (
    symbol.orientation === 'vertical' &&
    ['resistor', 'capacitor', 'inductor', 'diode', 'source'].includes(symbol.kind)
  );
}

function deriveCanvas(items: PlacedSymbol[], annotations: SceneAnnotation[]): { width: number; height: number } {
  const xs = items.flatMap((item) => [item.box.x, item.box.x + item.box.width]);
  const ys = items.flatMap((item) => [item.box.y, item.box.y + item.box.height]);
  for (const annotation of annotations) {
    const [x, y] = Array.isArray(annotation.position) ? annotation.position : [0, 0];
    xs.push(x);
    ys.push(y);
  }
  const maxX = Math.max(...xs, 720);
  const maxY = Math.max(...ys, 420);
  return { width: maxX + MARGIN, height: maxY + MARGIN };
}

export interface AgentSvgPipelineResult {
  ok: boolean;
  svgPath: string;
  scenePath?: string;
  wireCount: number;
}

export async function runAgentSvgPipeline(options: {
  designJsonPath: string;
  svgPath: string;
  scenePath?: string;
  title?: string;
}): Promise<AgentSvgPipelineResult> {
  const design = parseJson<DesignPayload>(await readFile(options.designJsonPath, 'utf8'));
  const scene = options.scenePath
    ? normalizeScene(parseJson<SceneHint>(await readFile(options.scenePath, 'utf8')))
    : normalizeScene(undefined);

  const components = (design.components ?? []).filter((component) => component.mount_policy !== 'testbench_exclude');
  const inputNode = design.interfaces?.input_node ?? design.io_inference?.input_node ?? null;
  const outputNode = design.interfaces?.output_node ?? design.io_inference?.output_node ?? null;
  const profile = resolveLayoutProfile(components, inputNode, outputNode);
  const heuristicPlacements = buildHeuristicPlacements(components, inputNode, outputNode);
  const mergedPlacements: Record<string, ScenePlacementRecord> = { ...heuristicPlacements, ...scene.placements };
  const placedComponents = components.map((component, index) =>
    buildComponentPlacement(component, mergedPlacements[component.name], index),
  );

  const netMap = new Map<string, Port[]>();
  for (const item of placedComponents) {
    for (const port of item.ports) {
      const ports = netMap.get(port.node) ?? [];
      ports.push(port);
      netMap.set(port.node, ports);
    }
  }

  const terminals: PlacedSymbol[] = [];
  const componentBounds = measureBounds(placedComponents);

  for (const [net, ports] of [...netMap.entries()]) {
    let terminalKind: SymbolKind | null = null;
    if (inputNode && net === inputNode) {
      terminalKind = 'terminal_in';
    } else if (outputNode && net === outputNode) {
      terminalKind = 'terminal_out';
    } else {
      const rail = railKind(net);
      if (rail === 'gnd') {
        terminalKind = 'ground';
      } else if (rail === 'vcc') {
        terminalKind = 'vcc';
      } else if (rail === 'vee') {
        terminalKind = 'vee';
      }
    }

    if (!terminalKind) {
      continue;
    }
    const terminal = buildTerminal(net, terminalKind, ports.map((port) => port.point), componentBounds);
    if (!terminal) {
      continue;
    }
    terminals.push(terminal);
    const list = netMap.get(net) ?? [];
    list.push(...terminal.ports);
    netMap.set(net, list);
  }

  const allSymbols = [...placedComponents, ...terminals];
  const blocked = buildObstacleSet(allSymbols);
  const congestion = new Map<string, number>();
  const wires: NetWire[] = [];

  if (profile === 'signal_chain_comparator' || profile === 'rf_mixed_signal') {
    wires.push(...buildSharedTrunkWires(netMap, inputNode, outputNode, profile));
  } else {
    for (const [net, ports] of netMap) {
      if (ports.length < 2) {
        continue;
      }
      const ordered = sortPortsForNet(net, ports, inputNode, outputNode);
      for (let index = 0; index < ordered.length - 1; index += 1) {
        const start = ordered[index]!;
        const end = ordered[index + 1]!;
        const path = routeAStar(start.point, end.point, new Set(blocked), congestion);
        markPathCongestion(path, congestion);
        wires.push({
          net,
          points: path,
        });
      }
    }
  }

  const finalWires = dedupeWires(wires);
  const junctions = buildJunctions(finalWires);
  const canvas = deriveCanvas(allSymbols, scene.annotations);
  const title = options.title ?? scene.title ?? 'Agent SVG Schematic';
  const svgParts: string[] = [];

  for (const wire of finalWires) {
    svgParts.push(svgPolyline(wire.points));
  }
  for (const point of junctions) {
    svgParts.push(`<circle cx="${point.x}" cy="${point.y}" r="3.6" class="junction" />`);
  }
  for (const item of allSymbols) {
    svgParts.push(...drawSymbol(item));
    if (item.kind === 'terminal_in' || item.kind === 'terminal_out') {
      const terminalLabel =
        item.kind === 'terminal_out' && item.ports[0]?.node.toLowerCase().endsWith('_n') ? 'OUT_N' : item.label;
      svgParts.push(svgText(item.box.x + item.box.width / 2, item.box.y - 8, terminalLabel, 'ref'));
      svgParts.push(svgText(item.box.x + item.box.width / 2, item.box.y + item.box.height + 18, item.ports[0]?.node ?? '', 'net'));
      continue;
    }
    if (item.kind === 'ground' || item.kind === 'vcc' || item.kind === 'vee') {
      const labelY = item.kind === 'vcc' ? item.box.y - 8 : item.box.y + item.box.height + 18;
      svgParts.push(svgText(item.box.x + item.box.width / 2, labelY, item.label, 'net'));
      continue;
    }
    if (usesSideLabels(item)) {
      const cy = item.box.y + item.box.height / 2;
      svgParts.push(svgText(item.box.x - 8, cy - 6, item.label, 'ref', 'end'));
      const valueLabel = compactValueLabel(item.value);
      if (valueLabel) {
        svgParts.push(svgText(item.box.x + item.box.width + 8, cy + 12, valueLabel, 'value', 'start'));
      }
      continue;
    }
    svgParts.push(svgText(item.box.x + item.box.width / 2, item.box.y - 10, item.label, 'ref'));
    const valueLabel = compactValueLabel(item.value);
    if (valueLabel) {
      svgParts.push(svgText(item.box.x + item.box.width / 2, item.box.y + item.box.height + 18, valueLabel, 'value'));
    }
  }
  for (const annotation of scene.annotations) {
    if (!annotation.text || !Array.isArray(annotation.position)) {
      continue;
    }
    const [x, y] = annotation.position;
    const fontSize = isFiniteNumber(annotation.font_size) ? annotation.font_size : 12;
    svgParts.push(
      `<text x="${x}" y="${y}" class="annotation" text-anchor="start" style="font-size:${fontSize}px">${escapeXml(annotation.text)}</text>`,
    );
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">
  <style>
    .bg { fill: #f8f6ef; }
    .title { fill: #17212b; font: 700 18px "Segoe UI", sans-serif; }
    .device { fill: none; stroke: #203246; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .symbol-fill { fill: #f8f6ef; }
    .wire { fill: none; stroke: #355c7d; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    .junction { fill: #355c7d; }
    .ref { fill: #17212b; font: 700 13px "Segoe UI", sans-serif; }
    .value { fill: #5d4037; font: 12px "Segoe UI", sans-serif; }
    .net { fill: #4e5d6c; font: 11px "Segoe UI", sans-serif; }
    .annotation { fill: #536471; font: 12px "Segoe UI", sans-serif; }
  </style>
  <rect class="bg" x="0" y="0" width="${canvas.width}" height="${canvas.height}" rx="16" />
  <text x="${canvas.width / 2}" y="28" class="title" text-anchor="middle">${escapeXml(title)}</text>
  ${svgParts.join('\n  ')}
</svg>`;

  await mkdir(path.dirname(options.svgPath), { recursive: true }).catch(() => undefined);
  await writeFile(options.svgPath, svg, 'utf8');

  return {
    ok: true,
    svgPath: options.svgPath,
    scenePath: options.scenePath,
    wireCount: finalWires.length,
  };
}

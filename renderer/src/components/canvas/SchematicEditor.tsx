import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  CircuitComponent,
  CircuitModule,
  CircuitPin,
  CircuitPort,
  CircuitPosition,
  CircuitWire,
  CircuitWireEndpoint,
} from '../../types';

type ToolMode = 'select' | 'wire' | 'place';
type PlaceType = CircuitComponent['type'];
type Selection = { kind: 'component'; id: string } | { kind: 'wire'; id: string } | null;
type EndpointHit = CircuitWireEndpoint & {
  kind: 'pin' | 'port' | 'point';
  label: string;
  net?: string;
};

const GRID = 20;
const PIN_REACH = 12;
const COMPONENT_TYPES: PlaceType[] = ['R', 'C', 'L', 'D', 'M', 'Q', 'V', 'I'];
const DEFAULT_VALUES: Record<PlaceType, string> = {
  R: '1k',
  C: '1n',
  L: '1u',
  D: 'D',
  M: 'NMOS W=1u L=180n',
  Q: 'NPN',
  V: 'DC 1',
  I: 'DC 1m',
};

interface Props {
  module: CircuitModule;
  busy: boolean;
  onSave: (module: CircuitModule) => Promise<void>;
  onBuild: () => void;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface DragState {
  componentId: string;
  startWorld: CircuitPosition;
  originalPosition: CircuitPosition;
  originalModule: CircuitModule;
  moved: boolean;
}

interface WireDragState {
  start: EndpointHit;
  startClient: CircuitPosition;
  moved: boolean;
}

export function SchematicEditor({ module, busy, onSave, onBuild }: Props) {
  const [draft, setDraft] = useState(() => cloneModule(module));
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<ToolMode>('select');
  const [placeType, setPlaceType] = useState<PlaceType>('R');
  const [selection, setSelection] = useState<Selection>(null);
  const [wireStart, setWireStart] = useState<EndpointHit | null>(null);
  const [hoverWorld, setHoverWorld] = useState<CircuitPosition | null>(null);
  const [history, setHistory] = useState<CircuitModule[]>([]);
  const [future, setFuture] = useState<CircuitModule[]>([]);
  const [camera, setCamera] = useState<Camera>({ x: 120, y: 90, scale: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 900, height: 600 });
  const [portPositions, setPortPositions] = useState(() => computePortPositions(module));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);

  useEffect(() => {
    setDraft(cloneModule(module));
    setDirty(false);
    setSelection(null);
    setWireStart(null);
    setHoverWorld(null);
    setHistory([]);
    setFuture([]);
    setPortPositions(computePortPositions(module));
  }, [module.module_id, module.revision]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect;
      if (!rect) return;
      setCanvasSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(260, Math.floor(rect.height)),
      });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const selectedComponent = selection?.kind === 'component'
    ? draft.components.find((component) => component.id === selection.id) ?? null
    : null;

  const commitDraft = useCallback((next: CircuitModule, previous = draft) => {
    setHistory((items) => [...items, cloneModule(previous)].slice(-40));
    setFuture([]);
    setDraft(next);
    setDirty(true);
  }, [draft]);

  const fitView = useCallback(() => {
    const bounds = moduleBounds(draft, portPositions);
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.max(0.45, Math.min(2.4, Math.min(
      (canvasSize.width - 80) / width,
      (canvasSize.height - 80) / height,
    )));
    setCamera({
      scale,
      x: 40 - bounds.minX * scale,
      y: 40 - bounds.minY * scale,
    });
  }, [canvasSize.height, canvasSize.width, draft, portPositions]);

  useEffect(() => {
    fitView();
  }, [module.module_id, module.revision]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvasSize.width * ratio));
    canvas.height = Math.max(1, Math.floor(canvasSize.height * ratio));
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawEditor(context, {
      module: draft,
      camera,
      size: canvasSize,
      selection,
      wireStart,
      wirePreview: hoverWorld
        ? hitEndpoint(draft, portPositions, hoverWorld) ?? pointEndpoint(snapPoint(hoverWorld))
        : null,
      portPositions,
    });
  }, [camera, canvasSize, draft, hoverWorld, portPositions, selection, wireStart]);

  function screenToWorldFromClient(canvas: HTMLCanvasElement, clientX: number, clientY: number): CircuitPosition {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - camera.x) / camera.scale,
      y: (clientY - rect.top - camera.y) / camera.scale,
    };
  }

  function screenToWorld(event: ReactMouseEvent<HTMLCanvasElement> | ReactPointerEvent<HTMLCanvasElement>): CircuitPosition {
    return screenToWorldFromClient(event.currentTarget, event.clientX, event.clientY);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const world = screenToWorld(event);
    setHoverWorld(world);
    if (tool === 'place') {
      const next = cloneModule(draft);
      const component = makePlacedComponent(next, placeType, snapPoint(world));
      next.components.push(component);
      commitDraft(next);
      setSelection({ kind: 'component', id: component.id });
      setTool('select');
      return;
    }

    if (tool === 'wire') {
      const hit = hitEndpoint(draft, portPositions, world) ?? pointEndpoint(snapPoint(world));
      if (!wireStart) {
        setWireStart(hit);
        wireDragRef.current = {
          start: hit,
          startClient: { x: event.clientX, y: event.clientY },
          moved: false,
        };
        return;
      }
      const next = cloneModule(draft);
      addWire(next, wireStart, hit);
      commitDraft(next);
      setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
      setWireStart(null);
      setHoverWorld(null);
      wireDragRef.current = null;
      return;
    }

    const componentHit = hitComponent(draft, world);
    if (componentHit) {
      setSelection({ kind: 'component', id: componentHit.id });
      dragRef.current = {
        componentId: componentHit.id,
        startWorld: world,
        originalPosition: { ...componentHit.position },
        originalModule: cloneModule(draft),
        moved: false,
      };
      return;
    }
    const wireHit = hitWire(draft, world);
    if (wireHit) {
      setSelection({ kind: 'wire', id: wireHit.id });
      return;
    }
    setSelection(null);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.stopPropagation();
    const world = screenToWorld(event);
    setHoverWorld(world);
    const wireDrag = wireDragRef.current;
    if (wireDrag && !wireDrag.moved) {
      wireDrag.moved = Math.abs(event.clientX - wireDrag.startClient.x) + Math.abs(event.clientY - wireDrag.startClient.y) > 8;
    }
    const drag = dragRef.current;
    if (!drag || busy) return;
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    drag.moved = true;
    const nextPosition = snapPoint({
      x: drag.originalPosition.x + dx,
      y: drag.originalPosition.y + dy,
    });
    setDraft((current) => {
      const next = cloneModule(current);
      const component = next.components.find((entry) => entry.id === drag.componentId);
      if (component) component.position = nextPosition;
      next.wires = (next.wires ?? []).map((wire) => rerouteWire(next, wire, portPositions));
      return next;
    });
    setDirty(true);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const wireDrag = wireDragRef.current;
    wireDragRef.current = null;
    if (wireDrag?.moved && tool === 'wire') {
      const world = screenToWorld(event);
      const end = hitEndpoint(draft, portPositions, world) ?? pointEndpoint(snapPoint(world));
      const next = cloneModule(draft);
      addWire(next, wireDrag.start, end);
      commitDraft(next);
      setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
      setWireStart(null);
      setHoverWorld(null);
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    setHistory((items) => [...items, drag.originalModule].slice(-40));
    setFuture([]);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.stopPropagation();
    dragRef.current = null;
    wireDragRef.current = null;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    if (event.key === 'Escape') {
      setWireStart(null);
      setSelection(null);
      setTool('select');
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
      event.preventDefault();
      deleteSelection();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous || busy) return;
    setFuture((items) => [...items, cloneModule(draft)].slice(-40));
    setHistory((items) => items.slice(0, -1));
    setDraft(previous);
    setDirty(true);
    setSelection(null);
    setWireStart(null);
  }

  function redo() {
    const next = future.at(-1);
    if (!next || busy) return;
    setHistory((items) => [...items, cloneModule(draft)].slice(-40));
    setFuture((items) => items.slice(0, -1));
    setDraft(next);
    setDirty(true);
    setSelection(null);
    setWireStart(null);
  }

  function deleteSelection() {
    if (!selection || busy) return;
    const next = cloneModule(draft);
    if (selection.kind === 'component') {
      next.components = next.components.filter((component) => component.id !== selection.id);
      next.wires = next.wires.filter((wire) => (
        wire.from?.component_id !== selection.id && wire.to?.component_id !== selection.id
      ));
    } else {
      next.wires = next.wires.filter((wire) => wire.id !== selection.id);
    }
    commitDraft(next);
    setSelection(null);
  }

  function updateSelectedComponent(patch: Partial<CircuitComponent>) {
    if (!selectedComponent) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    Object.assign(component, patch);
    commitDraft(next);
  }

  async function saveAndRebuild() {
    const normalized = normalizeConnectivity(draft);
    await onSave(normalized);
    setDirty(false);
    setHistory([]);
    setFuture([]);
  }

  return (
    <div
      style={styles.editorShell}
      data-testid="schematic-editor"
      data-tool={tool}
      data-dirty={dirty ? 'true' : 'false'}
      data-selected={selection ? `${selection.kind}:${selection.id}` : ''}
      data-component-count={draft.components.length}
      data-wire-count={(draft.wires ?? []).length}
      data-component-positions={JSON.stringify(Object.fromEntries(
        draft.components.map((component) => [component.id, component.position]),
      ))}
      data-wire-points={JSON.stringify((draft.wires ?? []).map((wire) => wire.points))}
    >
      <div style={styles.toolbar}>
        <button
          style={tool === 'select' ? styles.activeToolButton : styles.toolButton}
          onClick={() => { setTool('select'); setWireStart(null); }}
          disabled={busy}
          data-testid="schematic-editor-select"
        >
          Select
        </button>
        <button
          style={tool === 'wire' ? styles.activeToolButton : styles.toolButton}
          onClick={() => { setTool('wire'); setWireStart(null); }}
          disabled={busy}
          data-testid="schematic-editor-wire"
        >
          Wire
        </button>
        {COMPONENT_TYPES.map((type) => (
          <button
            key={type}
            style={tool === 'place' && placeType === type ? styles.activeToolButton : styles.toolButton}
            onClick={() => { setTool('place'); setPlaceType(type); setWireStart(null); }}
            disabled={busy}
            data-testid={`schematic-editor-place-${type}`}
          >
            {type}
          </button>
        ))}
        <span style={styles.toolbarDivider} />
        <button style={styles.toolButton} onClick={undo} disabled={busy || history.length === 0} data-testid="schematic-editor-undo">
          Undo
        </button>
        <button style={styles.toolButton} onClick={redo} disabled={busy || future.length === 0} data-testid="schematic-editor-redo">
          Redo
        </button>
        <button style={styles.toolButton} onClick={deleteSelection} disabled={busy || !selection} data-testid="schematic-editor-delete">
          Delete
        </button>
        <button style={styles.toolButton} onClick={fitView} disabled={busy} data-testid="schematic-editor-fit">
          Fit
        </button>
        <button style={styles.primaryButton} onClick={() => void saveAndRebuild()} disabled={busy || !dirty} data-testid="schematic-editor-save">
          Save
        </button>
        <button style={styles.toolButton} onClick={onBuild} disabled={busy} data-testid="schematic-editor-rebuild-svg">
          Rebuild SVG
        </button>
        <span style={styles.statusText} data-testid="schematic-editor-status">
          {wireStart ? `Wire from ${wireStart.label}` : dirty ? 'Unsaved' : 'Saved'}
        </span>
      </div>

      <div style={styles.content}>
        <div style={styles.stage} ref={stageRef}>
          <canvas
            ref={canvasRef}
            style={styles.canvas}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            data-testid="schematic-editor-canvas"
          />
        </div>
        <aside style={styles.panel} data-testid="schematic-editor-panel">
          <div style={styles.panelTitle}>Selection</div>
          {selectedComponent ? (
            <>
              <label style={styles.fieldLabel}>
                Name
                <input
                  style={styles.input}
                  value={selectedComponent.name}
                  onChange={(event) => updateSelectedComponent({ name: event.target.value })}
                  disabled={busy}
                  data-testid="schematic-editor-component-name"
                />
              </label>
              <label style={styles.fieldLabel}>
                Value
                <input
                  style={styles.input}
                  value={selectedComponent.value}
                  onChange={(event) => updateSelectedComponent({ value: event.target.value })}
                  disabled={busy}
                  data-testid="schematic-editor-component-value"
                />
              </label>
              <label style={styles.fieldLabel}>
                Rotation
                <select
                  style={styles.input}
                  value={String(selectedComponent.rotation ?? 0)}
                  onChange={(event) => updateSelectedComponent({ rotation: Number(event.target.value) })}
                  disabled={busy}
                  data-testid="schematic-editor-component-rotation"
                >
                  <option value="0">0</option>
                  <option value="90">90</option>
                  <option value="180">180</option>
                  <option value="270">270</option>
                </select>
              </label>
              <div style={styles.pinList}>
                {selectedComponent.pins.map((pin) => (
                  <div key={pin.id} style={styles.pinRow}>
                    <span>{pin.name}</span>
                    <code>{pin.net}</code>
                  </div>
                ))}
              </div>
            </>
          ) : selection?.kind === 'wire' ? (
            <div style={styles.emptyText}>Wire {selection.id}</div>
          ) : (
            <div style={styles.emptyText}>No item selected</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function cloneModule(module: CircuitModule): CircuitModule {
  return JSON.parse(JSON.stringify(module)) as CircuitModule;
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function snapPoint(point: CircuitPosition): CircuitPosition {
  return { x: snap(point.x), y: snap(point.y) };
}

function normalizeRotation(value: number | undefined): number {
  const rotation = ((Number(value ?? 0) % 360) + 360) % 360;
  return Math.round(rotation / 90) * 90;
}

function makeId(prefix: string, existing: Set<string>): string {
  for (let index = 1; index < 10000; index += 1) {
    const id = `${prefix}${index}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}${Date.now()}`;
}

function makePlacedComponent(module: CircuitModule, type: PlaceType, position: CircuitPosition): CircuitComponent {
  const existingIds = new Set(module.components.map((component) => component.id));
  const id = makeId(type.toLowerCase(), existingIds);
  const name = `${type}${id.replace(/^[a-z]+/i, '')}`;
  const pinCount = type === 'M' || type === 'Q' ? 3 : 2;
  const pins: CircuitPin[] = Array.from({ length: pinCount }, (_value, index) => {
    const pinId = pinCount === 3
      ? (type === 'M' ? ['g', 'd', 's'][index] : ['b', 'c', 'e'][index])
      : ['a', 'b'][index];
    return {
      id: pinId ?? `p${index + 1}`,
      name: pinId?.toUpperCase() ?? `${index + 1}`,
      net: `n_${id}_${index + 1}`,
    };
  });
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

function pinWorld(component: CircuitComponent, pin: CircuitPin, index: number): CircuitPosition {
  const rotation = normalizeRotation(component.rotation);
  const horizontal = rotation === 0 || rotation === 180;
  const position = component.position;
  if (component.pins.length <= 2) {
    const sign = index === 0 ? -1 : 1;
    if (horizontal) {
      return { x: position.x + sign * 48, y: position.y };
    }
    return { x: position.x, y: position.y + sign * 48 };
  }

  const key = `${pin.id} ${pin.name}`.toLowerCase();
  if (/gate|base|\bg\b|\bb\b/.test(key)) return { x: position.x - 52, y: position.y };
  if (/drain|collector|\bd\b|\bc\b/.test(key)) return { x: position.x + 30, y: position.y - 46 };
  if (/source|emitter|\bs\b|\be\b/.test(key)) return { x: position.x + 30, y: position.y + 46 };
  return { x: position.x - 52 + index * 42, y: position.y + 50 };
}

function componentBounds(component: CircuitComponent) {
  const pins = component.pins.map((pin, index) => pinWorld(component, pin, index));
  const xs = [component.position.x - 38, component.position.x + 38, ...pins.map((pin) => pin.x)];
  const ys = [component.position.y - 34, component.position.y + 34, ...pins.map((pin) => pin.y)];
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function computePortPositions(module: CircuitModule): Map<string, CircuitPosition> {
  const bounds = moduleBounds(module, new Map());
  const inputs = module.ports.filter((port) => !isGroundPort(port) && port.direction !== 'output');
  const outputs = module.ports.filter((port) => !isGroundPort(port) && port.direction === 'output');
  const grounds = module.ports.filter(isGroundPort);
  const map = new Map<string, CircuitPosition>();
  inputs.forEach((port, index) => {
    map.set(port.id, { x: bounds.minX - 120, y: bounds.minY + 70 + index * 60 });
  });
  outputs.forEach((port, index) => {
    map.set(port.id, { x: bounds.maxX + 120, y: bounds.minY + 70 + index * 60 });
  });
  grounds.forEach((port, index) => {
    map.set(port.id, { x: bounds.minX + 90 + index * 100, y: bounds.maxY + 110 });
  });
  return map;
}

function moduleBounds(module: CircuitModule, portPositions: Map<string, CircuitPosition>) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const component of module.components) {
    const bounds = componentBounds(component);
    xs.push(bounds.minX, bounds.maxX);
    ys.push(bounds.minY, bounds.maxY);
  }
  for (const wire of module.wires ?? []) {
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
    minX: Math.min(...xs) - 80,
    minY: Math.min(...ys) - 80,
    maxX: Math.max(...xs) + 80,
    maxY: Math.max(...ys) + 80,
  };
}

function isGroundPort(port: CircuitPort): boolean {
  const text = `${port.name} ${port.net} ${port.signal_type}`.toLowerCase();
  return port.signal_type === 'ground' || text.includes('gnd') || port.net === '0';
}

function endpointKey(endpoint: CircuitWireEndpoint | undefined): string | null {
  if (!endpoint) return null;
  if (endpoint.component_id && endpoint.pin_id) return `c:${endpoint.component_id}:${endpoint.pin_id}`;
  if (endpoint.port_id) return `p:${endpoint.port_id}`;
  return null;
}

function endpointNet(module: CircuitModule, endpoint: CircuitWireEndpoint | undefined): string | null {
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

function replaceNet(module: CircuitModule, oldNet: string, newNet: string) {
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

function chooseMergedNet(left: string | null, right: string | null): string {
  if (left === '0' || right === '0') return '0';
  return left || right || `n_${Date.now()}`;
}

function addWire(module: CircuitModule, start: EndpointHit, end: EndpointHit) {
  const startPoint = snapPoint(start);
  const endPoint = snapPoint(end);
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

function routePoints(startPoint: CircuitPosition, endPoint: CircuitPosition): CircuitPosition[] {
  if (startPoint.x === endPoint.x || startPoint.y === endPoint.y) {
    return [startPoint, endPoint];
  }
  return [startPoint, { x: endPoint.x, y: startPoint.y }, endPoint];
}

function stripEndpoint(point: CircuitPosition, endpoint: EndpointHit): CircuitWireEndpoint {
  const value: CircuitWireEndpoint = { x: point.x, y: point.y };
  if (endpoint.component_id && endpoint.pin_id) {
    value.component_id = endpoint.component_id;
    value.pin_id = endpoint.pin_id;
  }
  if (endpoint.port_id) value.port_id = endpoint.port_id;
  return value;
}

function normalizeConnectivity(module: CircuitModule): CircuitModule {
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

function endpointWorldPosition(
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

function rerouteWire(
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

function pointEndpoint(point: CircuitPosition): EndpointHit {
  return { kind: 'point', x: point.x, y: point.y, label: `${point.x},${point.y}` };
}

function hitEndpoint(module: CircuitModule, portPositions: Map<string, CircuitPosition>, world: CircuitPosition): EndpointHit | null {
  for (const component of module.components) {
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
  for (const port of module.ports) {
    const point = portPositions.get(port.id);
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

function hitComponent(module: CircuitModule, world: CircuitPosition): CircuitComponent | null {
  for (let index = module.components.length - 1; index >= 0; index -= 1) {
    const component = module.components[index];
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

function hitWire(module: CircuitModule, world: CircuitPosition): CircuitWire | null {
  const wires = module.wires ?? [];
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

function distance(left: CircuitPosition, right: CircuitPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pointToSegmentDistance(point: CircuitPosition, start: CircuitPosition, end: CircuitPosition): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function drawEditor(
  context: CanvasRenderingContext2D,
  input: {
    module: CircuitModule;
    camera: Camera;
    size: { width: number; height: number };
    selection: Selection;
    wireStart: EndpointHit | null;
    wirePreview: EndpointHit | null;
    portPositions: Map<string, CircuitPosition>;
  },
) {
  const { module, camera, size, selection, wireStart, wirePreview, portPositions } = input;
  context.save();
  context.clearRect(0, 0, size.width, size.height);
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, size.width, size.height);
  context.translate(camera.x, camera.y);
  context.scale(camera.scale, camera.scale);
  drawGrid(context, camera, size);
  drawPorts(context, module, portPositions);
  for (const component of module.components) {
    drawComponent(context, component, selection?.kind === 'component' && selection.id === component.id);
  }
  drawWires(context, module, selection);
  if (wireStart && wirePreview) {
    drawWirePreview(context, wireStart, wirePreview);
  }
  if (wireStart) {
    context.strokeStyle = '#2563eb';
    context.fillStyle = '#2563eb';
    context.setLineDash([8, 6]);
    context.beginPath();
    context.arc(wireStart.x, wireStart.y, 6, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();
}

function drawWirePreview(context: CanvasRenderingContext2D, start: CircuitPosition, end: CircuitPosition) {
  const points = routePoints(snapPoint(start), snapPoint(end));
  const first = points[0];
  if (!first) return;
  context.save();
  context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  context.lineWidth = 8;
  context.setLineDash([8, 6]);
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.strokeStyle = '#2563eb';
  context.lineWidth = 3.5;
  context.stroke();
  context.restore();
}

function drawGrid(context: CanvasRenderingContext2D, camera: Camera, size: { width: number; height: number }) {
  const minX = Math.floor((-camera.x / camera.scale) / GRID) * GRID;
  const minY = Math.floor((-camera.y / camera.scale) / GRID) * GRID;
  const maxX = ((size.width - camera.x) / camera.scale) + GRID;
  const maxY = ((size.height - camera.y) / camera.scale) + GRID;
  context.strokeStyle = '#e5eaf0';
  context.lineWidth = 1 / camera.scale;
  context.beginPath();
  for (let x = minX; x <= maxX; x += GRID) {
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
  }
  for (let y = minY; y <= maxY; y += GRID) {
    context.moveTo(minX, y);
    context.lineTo(maxX, y);
  }
  context.stroke();
}

function drawPorts(context: CanvasRenderingContext2D, module: CircuitModule, portPositions: Map<string, CircuitPosition>) {
  context.font = '13px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textBaseline = 'middle';
  for (const port of module.ports) {
    const point = portPositions.get(port.id);
    if (!point) continue;
    context.fillStyle = '#ffffff';
    context.strokeStyle = '#111827';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = '#111827';
    context.fillText(port.name, point.x + 10, point.y - 10);
    context.fillStyle = '#64748b';
    context.fillText(port.net, point.x + 10, point.y + 10);
  }
}

function drawWires(context: CanvasRenderingContext2D, module: CircuitModule, selection: Selection) {
  for (const wire of module.wires ?? []) {
    if ((wire.points ?? []).length < 2) continue;
    const selected = selection?.kind === 'wire' && selection.id === wire.id;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const first = wire.points[0];
    if (!first) continue;
    const strokeWirePath = () => {
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (let index = 1; index < wire.points.length; index += 1) {
        const point = wire.points[index];
        if (point) context.lineTo(point.x, point.y);
      }
      context.stroke();
    };
    context.strokeStyle = 'rgba(255, 255, 255, 0.96)';
    context.lineWidth = selected ? 9 : 8;
    strokeWirePath();
    context.strokeStyle = selected ? '#2563eb' : '#0f172a';
    context.lineWidth = selected ? 5 : 3.5;
    strokeWirePath();
  }
}

function drawComponent(context: CanvasRenderingContext2D, component: CircuitComponent, selected: boolean) {
  const bounds = componentBounds(component);
  if (selected) {
    context.fillStyle = 'rgba(37, 99, 235, 0.12)';
    context.strokeStyle = '#2563eb';
    context.lineWidth = 2;
    context.strokeRect(bounds.minX - 8, bounds.minY - 8, bounds.maxX - bounds.minX + 16, bounds.maxY - bounds.minY + 16);
  }

  context.strokeStyle = '#111827';
  context.fillStyle = '#111827';
  context.lineWidth = 2.4;
  context.font = '13px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const pins = component.pins.map((pin, index) => ({ pin, point: pinWorld(component, pin, index) }));
  for (const entry of pins) {
    context.beginPath();
    context.arc(entry.point.x, entry.point.y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(entry.point.x, entry.point.y);
    context.lineTo(component.position.x, component.position.y);
    context.stroke();
  }

  drawSymbolBody(context, component);
  context.fillText(component.name, component.position.x, component.position.y - 50);
  context.fillText(component.value, component.position.x, component.position.y + 50);
}

function drawSymbolBody(context: CanvasRenderingContext2D, component: CircuitComponent) {
  const { x, y } = component.position;
  if (component.type === 'R') {
    context.strokeRect(x - 28, y - 10, 56, 20);
  } else if (component.type === 'C') {
    context.beginPath();
    context.moveTo(x - 8, y - 28);
    context.lineTo(x - 8, y + 28);
    context.moveTo(x + 8, y - 28);
    context.lineTo(x + 8, y + 28);
    context.stroke();
  } else if (component.type === 'L') {
    context.beginPath();
    for (let index = 0; index < 4; index += 1) {
      context.arc(x - 24 + index * 16, y, 8, Math.PI, 0);
    }
    context.stroke();
  } else if (component.type === 'D') {
    context.beginPath();
    context.moveTo(x - 22, y - 24);
    context.lineTo(x - 22, y + 24);
    context.lineTo(x + 20, y);
    context.closePath();
    context.stroke();
    context.beginPath();
    context.moveTo(x + 22, y - 24);
    context.lineTo(x + 22, y + 24);
    context.stroke();
  } else if (component.type === 'M' || component.type === 'Q') {
    context.beginPath();
    context.moveTo(x - 18, y - 28);
    context.lineTo(x - 18, y + 28);
    context.moveTo(x + 14, y - 34);
    context.lineTo(x + 14, y + 34);
    context.moveTo(x - 18, y);
    context.lineTo(x - 40, y);
    context.moveTo(x + 14, y - 28);
    context.lineTo(x + 30, y - 46);
    context.moveTo(x + 14, y + 28);
    context.lineTo(x + 30, y + 46);
    context.stroke();
  } else {
    context.beginPath();
    context.arc(x, y, 26, 0, Math.PI * 2);
    context.stroke();
    context.fillText(component.type, x, y);
  }
}

const styles: Record<string, CSSProperties> = {
  editorShell: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    border: '1px solid #d8dee8',
    background: '#ffffff',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 10px',
    borderBottom: '1px solid #d8dee8',
    flexWrap: 'wrap',
    background: '#ffffff',
  },
  toolButton: {
    minWidth: 42,
    height: 32,
    padding: '0 10px',
    border: '1px solid #c7ced6',
    borderRadius: 5,
    background: '#ffffff',
    color: '#253041',
    fontWeight: 650,
    cursor: 'pointer',
  },
  activeToolButton: {
    minWidth: 42,
    height: 32,
    padding: '0 10px',
    border: '1px solid #2563eb',
    borderRadius: 5,
    background: '#2563eb',
    color: '#ffffff',
    fontWeight: 700,
    cursor: 'pointer',
  },
  primaryButton: {
    minWidth: 58,
    height: 32,
    padding: '0 12px',
    border: 'none',
    borderRadius: 5,
    background: '#2563eb',
    color: '#ffffff',
    fontWeight: 700,
    cursor: 'pointer',
  },
  toolbarDivider: { width: 1, height: 24, background: '#d8dee8', margin: '0 2px' },
  statusText: {
    marginLeft: 'auto',
    color: '#526071',
    fontSize: 12,
    minWidth: 90,
    textAlign: 'right',
  },
  content: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', minHeight: 0, flex: 1 },
  stage: { minHeight: 0, position: 'relative', overflow: 'hidden' },
  canvas: {
    width: '100%',
    height: '100%',
    display: 'block',
    cursor: 'crosshair',
    outline: 'none',
  },
  panel: {
    borderLeft: '1px solid #d8dee8',
    padding: 12,
    overflow: 'auto',
    background: '#fbfcfe',
  },
  panelTitle: {
    color: '#697386',
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  fieldLabel: { display: 'grid', gap: 5, fontSize: 12, color: '#536172', marginBottom: 10, fontWeight: 650 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid #c7ced6',
    borderRadius: 4,
    padding: '6px 8px',
    color: '#202a37',
    background: '#ffffff',
  },
  pinList: { display: 'grid', gap: 6, marginTop: 12 },
  pinRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 8px',
    border: '1px solid #e2e7ee',
    borderRadius: 4,
    background: '#ffffff',
    fontSize: 12,
  },
  emptyText: { color: '#748094', fontSize: 12, lineHeight: 1.5 },
};

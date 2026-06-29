import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { CircuitComponent, CircuitModule, CircuitPosition, CircuitWire } from '../../types';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import {
  addWire,
  cloneModule,
  COMPONENT_TYPES,
  createSchematicDocument,
  hitComponent,
  hitEndpoint,
  hitWire,
  makePlacedComponent,
  normalizeConnectivity,
  normalizeRotation,
  pointToSegmentDistance,
  pointEndpoint,
  removeWireAndUpdateConnectivity,
  rerouteStoredWires,
  SCHEMATIC_GRID,
  snapPoint,
  type EndpointHit,
  type SchematicBounds,
  type SchematicSelection,
  type ToolComponentType,
} from '../../schematic/schematicDocument';

type ToolMode = 'select' | 'wire' | 'place';
type EditorCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'copy' | 'move';

interface Props {
  module: CircuitModule;
  busy: boolean;
  onSave: (module: CircuitModule) => Promise<void>;
  onBuild: () => void;
}

interface DragState {
  componentId: string;
  startWorld: CircuitPosition;
  originalPosition: CircuitPosition;
  lastPosition: CircuitPosition;
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
}

interface WireDragState {
  start: EndpointHit;
  startClient: CircuitPosition;
  moved: boolean;
}

interface PanState {
  startClient: CircuitPosition;
  originalViewBox: SchematicBounds;
}

interface WireSegmentDragState {
  wireId: string;
  segmentIndex: number;
  startWorld: CircuitPosition;
  originalPoints: CircuitPosition[];
  lastPoints: CircuitPosition[];
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
}

interface WirePointDragState {
  wireId: string;
  pointIndex: number;
  startWorld: CircuitPosition;
  originalPoint: CircuitPosition;
  originalPoints: CircuitPosition[];
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
}

export function SchematicEditor({ module, busy, onSave, onBuild }: Props) {
  const [draft, setDraft] = useState(() => createSchematicDocument(module).module);
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<ToolMode>('select');
  const [placeType, setPlaceType] = useState<ToolComponentType>('R');
  const [selection, setSelection] = useState<SchematicSelection>(null);
  const [wireStart, setWireStart] = useState<EndpointHit | null>(null);
  const [hoverWorld, setHoverWorld] = useState<CircuitPosition | null>(null);
  const [hoverEndpoint, setHoverEndpoint] = useState<EndpointHit | null>(null);
  const [interactionCursor, setInteractionCursor] = useState<EditorCursor>('default');
  const [viewport, setViewport] = useState<SchematicBounds | null>(null);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [history, setHistory] = useState<CircuitModule[]>([]);
  const [future, setFuture] = useState<CircuitModule[]>([]);
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const wireSegmentDragRef = useRef<WireSegmentDragState | null>(null);
  const wirePointDragRef = useRef<WirePointDragState | null>(null);
  const panRef = useRef<PanState | null>(null);

  const document = useMemo(() => createSchematicDocument(draft, { autoLayout: false }), [draft]);
  const activeViewBox = viewport ?? document.viewBox;
  const zoom = Math.max(
    0.05,
    (document.viewBox.maxX - document.viewBox.minX) / Math.max(1, activeViewBox.maxX - activeViewBox.minX),
  );
  const selectedComponent = selection?.kind === 'component'
    ? draft.components.find((component) => component.id === selection.id) ?? null
    : null;
  const wirePreview = hoverWorld
    ? hoverEndpoint ?? pointEndpoint(snapPoint(hoverWorld))
    : null;
  const editorCursor: EditorCursor = (() => {
    if (interactionCursor === 'grabbing') return 'grabbing';
    if (spacePanActive) return 'grab';
    if (tool === 'wire') return 'crosshair';
    if (tool === 'place') return 'copy';
    return interactionCursor;
  })();

  useEffect(() => {
    setDraft(createSchematicDocument(module).module);
    setDirty(false);
    setSelection(null);
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setInteractionCursor('default');
    setViewport(null);
    setSpacePanActive(false);
    setHistory([]);
    setFuture([]);
  }, [module.module_id, module.revision]);

  const commitDraft = useCallback((next: CircuitModule, previous = draft) => {
    setHistory((items) => [...items, cloneModule(previous)].slice(-40));
    setFuture([]);
    setDraft(next);
    setDirty(true);
  }, [draft]);

  function clientToWorld(svg: SVGSVGElement, clientX: number, clientY: number): CircuitPosition {
    svgRef.current = svg;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(matrix);
    return { x: transformed.x, y: transformed.y };
  }

  function screenToWorld(event: ReactPointerEvent<SVGSVGElement>): CircuitPosition {
    return clientToWorld(event.currentTarget, event.clientX, event.clientY);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!svg) return;
      zoomAtClientPoint(svg, event.clientX, event.clientY, event.deltaY);
    }

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [activeViewBox, document.viewBox]);

  function zoomAtClientPoint(svg: SVGSVGElement, clientX: number, clientY: number, deltaY: number) {
    editorShellRef.current?.focus();
    const current = activeViewBox;
    const world = clientToWorld(svg, clientX, clientY);
    zoomAtWorldPoint(world, deltaY > 0 ? 1.14 : 0.88);
  }

  function zoomAtWorldPoint(world: CircuitPosition, factor: number) {
    const current = activeViewBox;
    const width = current.maxX - current.minX;
    const height = current.maxY - current.minY;
    const baseWidth = document.viewBox.maxX - document.viewBox.minX;
    const nextWidth = clamp(width * factor, Math.max(120, baseWidth * 0.18), Math.max(2400, baseWidth * 5));
    const nextHeight = nextWidth * (height / Math.max(1, width));
    const ratioX = (world.x - current.minX) / Math.max(1, width);
    const ratioY = (world.y - current.minY) / Math.max(1, height);
    const minX = world.x - ratioX * nextWidth;
    const minY = world.y - ratioY * nextHeight;
    setViewport({ minX, minY, maxX: minX + nextWidth, maxY: minY + nextHeight });
  }

  function zoomAtViewCenter(factor: number) {
    const current = activeViewBox;
    zoomAtWorldPoint({
      x: (current.minX + current.maxX) / 2,
      y: (current.minY + current.maxY) / 2,
    }, factor);
  }

  function fitViewport() {
    panRef.current = null;
    setViewport(null);
    setInteractionCursor('default');
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (busy || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    event.stopPropagation();
    svgRef.current = event.currentTarget;
    editorShellRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.button === 1 || (event.button === 0 && (event.altKey || spacePanActive))) {
      panRef.current = {
        startClient: { x: event.clientX, y: event.clientY },
        originalViewBox: activeViewBox,
      };
      setInteractionCursor('grabbing');
      return;
    }

    const world = screenToWorld(event);
    setHoverWorld(world);
    setHoverEndpoint(tool === 'wire' || tool === 'place' || wireStart ? hitEndpoint(document, world) : null);

    if (tool === 'place') {
      const next = cloneModule(draft);
      const component = makePlacedComponent(next, placeType, snapPoint(world));
      next.components.push(component);
      commitDraft(next);
      setSelection({ kind: 'component', id: component.id });
      setTool('select');
      setInteractionCursor('grab');
      return;
    }

    if (tool === 'wire') {
      const hit = hitEndpoint(document, world) ?? pointEndpoint(snapPoint(world));
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
      setHoverEndpoint(null);
      wireDragRef.current = null;
      return;
    }

    const componentHit = hitComponent(document, world);
    if (componentHit) {
      setSelection({ kind: 'component', id: componentHit.id });
      setInteractionCursor('grabbing');
      dragRef.current = {
        componentId: componentHit.id,
        startWorld: world,
        originalPosition: { ...componentHit.position },
        lastPosition: { ...componentHit.position },
        originalModule: cloneModule(draft),
        originalDirty: dirty,
        moved: false,
      };
      return;
    }

    const wirePointHit = hitSelectedStoredWirePoint(document.wires, draft, selection, world);
    if (wirePointHit) {
      setSelection({ kind: 'wire', id: wirePointHit.wire.id });
      setInteractionCursor('grabbing');
      wirePointDragRef.current = {
        wireId: wirePointHit.wire.id,
        pointIndex: wirePointHit.pointIndex,
        startWorld: world,
        originalPoint: { ...wirePointHit.point },
        originalPoints: clonePoints(wirePointHit.wire.points),
        originalModule: cloneModule(draft),
        originalDirty: dirty,
        moved: false,
      };
      return;
    }

    const wireSegmentHit = hitStoredWireSegment(document.wires, draft, world);
    const wireHit = wireSegmentHit?.wire ?? hitWire(document, world);
    if (wireHit) {
      setSelection({ kind: 'wire', id: wireHit.id });
      if (wireSegmentHit) {
        setInteractionCursor('grabbing');
        wireSegmentDragRef.current = {
          wireId: wireSegmentHit.wire.id,
          segmentIndex: wireSegmentHit.segmentIndex,
          startWorld: world,
          originalPoints: clonePoints(wireSegmentHit.wire.points),
          lastPoints: clonePoints(wireSegmentHit.wire.points),
          originalModule: cloneModule(draft),
          originalDirty: dirty,
          moved: false,
        };
      } else {
        setInteractionCursor('default');
      }
      return;
    }
    setSelection(null);
    setInteractionCursor('default');
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    const pan = panRef.current;
    if (pan) {
      const svgBox = event.currentTarget.getBoundingClientRect();
      const width = pan.originalViewBox.maxX - pan.originalViewBox.minX;
      const height = pan.originalViewBox.maxY - pan.originalViewBox.minY;
      const dx = (event.clientX - pan.startClient.x) * (width / Math.max(1, svgBox.width));
      const dy = (event.clientY - pan.startClient.y) * (height / Math.max(1, svgBox.height));
      setViewport({
        minX: pan.originalViewBox.minX - dx,
        minY: pan.originalViewBox.minY - dy,
        maxX: pan.originalViewBox.maxX - dx,
        maxY: pan.originalViewBox.maxY - dy,
      });
      setInteractionCursor('grabbing');
      return;
    }
    const world = screenToWorld(event);
    if (tool === 'wire' || tool === 'place' || wireStart) {
      const hit = hitEndpoint(document, world);
      setHoverEndpoint((current) => (
        endpointIdentity(current) === endpointIdentity(hit) ? current : hit
      ));
      setHoverWorld(world);
    }
    const wireDrag = wireDragRef.current;
    if (wireDrag && !wireDrag.moved) {
      wireDrag.moved = Math.abs(event.clientX - wireDrag.startClient.x) + Math.abs(event.clientY - wireDrag.startClient.y) > 8;
    }
    const wirePointDrag = wirePointDragRef.current;
    if (wirePointDrag) {
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextPoint = snapPoint({
        x: wirePointDrag.originalPoint.x + world.x - wirePointDrag.startWorld.x,
        y: wirePointDrag.originalPoint.y + world.y - wirePointDrag.startWorld.y,
      });
      const nextPoints = clonePoints(wirePointDrag.originalPoints);
      nextPoints[wirePointDrag.pointIndex] = nextPoint;
      if (samePoints(nextPoints, wirePointDrag.originalPoints)) return;
      wirePointDrag.moved = true;
      setDraft((current) => applyWirePointDrag(current, wirePointDrag, nextPoints));
      setDirty(true);
      return;
    }
    const wireSegmentDrag = wireSegmentDragRef.current;
    if (wireSegmentDrag) {
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextPoints = dragWireSegmentPoints(
        wireSegmentDrag.originalPoints,
        wireSegmentDrag.segmentIndex,
        world.x - wireSegmentDrag.startWorld.x,
        world.y - wireSegmentDrag.startWorld.y,
      );
      if (samePoints(nextPoints, wireSegmentDrag.lastPoints)) return;
      wireSegmentDrag.lastPoints = clonePoints(nextPoints);
      wireSegmentDrag.moved = true;
      setDraft((current) => {
        const existingWire = current.wires?.find((wire) => wire.id === wireSegmentDrag.wireId);
        if (!existingWire) return current;
        const next = cloneModule(current);
        const wire = next.wires?.find((entry) => entry.id === wireSegmentDrag.wireId);
        if (wire) wire.points = clonePoints(nextPoints);
        return next;
      });
      setDirty(true);
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      if (tool === 'select') {
        setInteractionCursor((current) => {
          const next = cursorForWorld(document, draft, selection, world);
          return current === next ? current : next;
        });
      }
      return;
    }
    setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    drag.moved = true;
    const nextPosition = snapPoint({
      x: drag.originalPosition.x + dx,
      y: drag.originalPosition.y + dy,
    });
    if (drag.lastPosition.x === nextPosition.x && drag.lastPosition.y === nextPosition.y) return;
    drag.lastPosition = nextPosition;
    setDraft((current) => {
      const currentComponent = current.components.find((entry) => entry.id === drag.componentId);
      if (
        !currentComponent ||
        (currentComponent.position.x === nextPosition.x && currentComponent.position.y === nextPosition.y)
      ) {
        return current;
      }
      const next = cloneModule(current);
      const component = next.components.find((entry) => entry.id === drag.componentId);
      if (component) component.position = nextPosition;
      next.wires = rerouteStoredWires(next);
      return next;
    });
    setDirty(true);
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (panRef.current) {
      panRef.current = null;
      setInteractionCursor('default');
      return;
    }
    const wireDrag = wireDragRef.current;
    wireDragRef.current = null;
    if (wireDrag?.moved && tool === 'wire') {
      const world = screenToWorld(event);
      const end = hitEndpoint(document, world) ?? pointEndpoint(snapPoint(world));
      const next = cloneModule(draft);
      addWire(next, wireDrag.start, end);
      commitDraft(next);
      setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
      setWireStart(null);
      setHoverWorld(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      return;
    }
    const drag = dragRef.current;
    const wirePointDrag = wirePointDragRef.current;
    const wireSegmentDrag = wireSegmentDragRef.current;
    dragRef.current = null;
    wirePointDragRef.current = null;
    wireSegmentDragRef.current = null;
    const world = screenToWorld(event);
    setInteractionCursor(cursorForWorld(document, draft, selection, world));
    if (wirePointDrag?.moved) {
      setHistory((items) => [...items, wirePointDrag.originalModule].slice(-40));
      setFuture([]);
      return;
    }
    if (wireSegmentDrag?.moved) {
      setHistory((items) => [...items, wireSegmentDrag.originalModule].slice(-40));
      setFuture([]);
      return;
    }
    if (!drag?.moved) return;
    setHistory((items) => [...items, drag.originalModule].slice(-40));
    setFuture([]);
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    cancelActiveDrag();
    setHoverEndpoint(null);
    setInteractionCursor('default');
  }

  function cancelActiveDrag() {
    const drag = dragRef.current;
    dragRef.current = null;
    wireDragRef.current = null;
    const wirePointDrag = wirePointDragRef.current;
    wirePointDragRef.current = null;
    const wireSegmentDrag = wireSegmentDragRef.current;
    wireSegmentDragRef.current = null;
    panRef.current = null;
    setInteractionCursor('default');
    if (wirePointDrag?.moved) {
      setDraft(wirePointDrag.originalModule);
      setDirty(wirePointDrag.originalDirty);
      return;
    }
    if (wireSegmentDrag?.moved) {
      setDraft(wireSegmentDrag.originalModule);
      setDirty(wireSegmentDrag.originalDirty);
      return;
    }
    if (!drag) return;
    if (drag.moved) {
      setDraft(drag.originalModule);
      setDirty(drag.originalDirty);
    }
  }

  function nudgeSelectedComponent(dx: number, dy: number) {
    if (!selectedComponent || busy) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    const nextPosition = snapPoint({
      x: component.position.x + dx,
      y: component.position.y + dy,
    });
    if (component.position.x === nextPosition.x && component.position.y === nextPosition.y) return;
    component.position = nextPosition;
    next.wires = rerouteStoredWires(next);
    commitDraft(next);
  }

  function rotateSelectedComponent() {
    if (!selectedComponent || busy) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    component.rotation = normalizeRotation((component.rotation ?? 0) + 90);
    next.wires = rerouteStoredWires(next);
    commitDraft(next);
  }

  function handleKeyboardEvent(event: Pick<KeyboardEvent | ReactKeyboardEvent<HTMLDivElement>, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey' | 'target'>) {
    if (isEditableKeyboardTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelActiveDrag();
      setWireStart(null);
      setHoverEndpoint(null);
      setSelection(null);
      setTool('select');
      setSpacePanActive(false);
      setInteractionCursor('default');
      return;
    }
    if (isSpacePanKey(event) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setSpacePanActive(true);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'default'));
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if ((event.key === '+' || event.key === '=') && !event.altKey) {
      event.preventDefault();
      zoomAtViewCenter(0.88);
      return;
    }
    if ((event.key === '-' || event.key === '_') && !event.altKey) {
      event.preventDefault();
      zoomAtViewCenter(1.14);
      return;
    }
    if (event.key === 'Home' || ((event.ctrlKey || event.metaKey) && key === '0')) {
      event.preventDefault();
      fitViewport();
      return;
    }
    if (event.key.startsWith('Arrow') && selectedComponent) {
      event.preventDefault();
      const step = event.shiftKey ? SCHEMATIC_GRID * 5 : SCHEMATIC_GRID;
      if (event.key === 'ArrowLeft') nudgeSelectedComponent(-step, 0);
      if (event.key === 'ArrowRight') nudgeSelectedComponent(step, 0);
      if (event.key === 'ArrowUp') nudgeSelectedComponent(0, -step);
      if (event.key === 'ArrowDown') nudgeSelectedComponent(0, step);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key === 'r' && selectedComponent) {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      rotateSelectedComponent();
      return;
    }
    if (key === 'w') {
      event.preventDefault();
      setTool('wire');
      setWireStart(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      return;
    }
    if (key === 's') {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      return;
    }
    const componentType = event.key.toUpperCase() as ToolComponentType;
    if ((COMPONENT_TYPES as readonly string[]).includes(componentType)) {
      event.preventDefault();
      setTool('place');
      setPlaceType(componentType);
      setWireStart(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    handleKeyboardEvent(event);
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isSpacePanKey(event)) {
      event.preventDefault();
      setSpacePanActive(false);
      if (!panRef.current) setInteractionCursor('default');
    }
  }

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent) {
      const shell = editorShellRef.current;
      if (!shell || event.defaultPrevented || isEditableKeyboardTarget(event.target)) return;
      const target = event.target;
      const activeElement = window.document.activeElement;
      if (target instanceof Node && shell.contains(target)) return;
      if (activeElement && activeElement !== window.document.body && !shell.contains(activeElement)) return;
      handleKeyboardEvent(event);
    }

    function handleWindowKeyUp(event: KeyboardEvent) {
      if (!isSpacePanKey(event) || isEditableKeyboardTarget(event.target)) return;
      setSpacePanActive(false);
      if (!panRef.current) setInteractionCursor('default');
    }

    function handleWindowBlur() {
      setSpacePanActive(false);
      panRef.current = null;
      setInteractionCursor('default');
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    window.addEventListener('keyup', handleWindowKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      window.removeEventListener('keyup', handleWindowKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  });

  function undo() {
    const previous = history.at(-1);
    if (!previous || busy) return;
    setFuture((items) => [...items, cloneModule(draft)].slice(-40));
    setHistory((items) => items.slice(0, -1));
    setDraft(previous);
    setDirty(true);
    setSelection(null);
    setWireStart(null);
    setHoverEndpoint(null);
    setInteractionCursor('default');
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
    setHoverEndpoint(null);
    setInteractionCursor('default');
  }

  function deleteSelection() {
    if (!selection || busy) return;
    const next = cloneModule(draft);
    if (selection.kind === 'component') {
      next.components = next.components.filter((component) => component.id !== selection.id);
      next.wires = (next.wires ?? []).filter((wire) => (
        wire.from?.component_id !== selection.id && wire.to?.component_id !== selection.id
      ));
    } else {
      const selectedWire = document.wires.find((wire) => wire.id === selection.id);
      const updated = removeWireAndUpdateConnectivity(next, selectedWire ?? selection.id);
      next.components = updated.components;
      next.ports = updated.ports;
      next.wires = updated.wires;
    }
    commitDraft(next);
    setSelection(null);
    setInteractionCursor('default');
  }

  function updateSelectedComponent(patch: Partial<CircuitComponent>) {
    if (!selectedComponent) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    Object.assign(component, patch);
    if (patch.rotation !== undefined) {
      component.rotation = normalizeRotation(Number(patch.rotation));
      next.wires = rerouteStoredWires(next);
    }
    commitDraft(next);
  }

  async function saveAndRebuild() {
    const normalized = normalizeConnectivity({ ...draft, wires: document.wires });
    await onSave(normalized);
    setDirty(false);
    setHistory([]);
    setFuture([]);
  }

  return (
    <div
      ref={editorShellRef}
      style={styles.editorShell}
      data-testid="schematic-editor"
      data-tool={tool}
      data-dirty={dirty ? 'true' : 'false'}
      data-selected={selection ? `${selection.kind}:${selection.id}` : ''}
      data-hover-endpoint={hoverEndpoint ? hoverEndpoint.label : ''}
      data-cursor-mode={editorCursor}
      data-zoom={zoom.toFixed(3)}
      data-space-pan={spacePanActive ? 'true' : 'false'}
      data-viewport={JSON.stringify(activeViewBox)}
      data-component-count={draft.components.length}
      data-wire-count={document.wires.length}
      data-net-label-count={document.netLabels.length}
      data-component-positions={JSON.stringify(Object.fromEntries(
        draft.components.map((component) => [component.id, component.position]),
      ))}
      data-component-rotations={JSON.stringify(Object.fromEntries(
        draft.components.map((component) => [component.id, normalizeRotation(component.rotation)]),
      ))}
      data-wire-points={JSON.stringify(document.wires.map((wire) => wire.points))}
      data-wires={JSON.stringify(document.wires.map((wire) => ({
        id: wire.id,
        net: wire.net,
        source: wire.source,
        points: wire.points,
      })))}
      data-schematic-source="document"
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      tabIndex={0}
    >
      <div style={styles.toolbar}>
        <button
          style={tool === 'select' ? styles.activeToolButton : styles.toolButton}
          onClick={() => { setTool('select'); setWireStart(null); setHoverEndpoint(null); }}
          disabled={busy}
          data-testid="schematic-editor-select"
        >
          Select
        </button>
        <button
          style={tool === 'wire' ? styles.activeToolButton : styles.toolButton}
          onClick={() => { setTool('wire'); setWireStart(null); setHoverEndpoint(null); }}
          disabled={busy}
          data-testid="schematic-editor-wire"
        >
          Wire
        </button>
        {COMPONENT_TYPES.map((type) => (
          <button
            key={type}
            style={tool === 'place' && placeType === type ? styles.activeToolButton : styles.toolButton}
            onClick={() => { setTool('place'); setPlaceType(type); setWireStart(null); setHoverEndpoint(null); }}
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
        <button style={styles.primaryButton} onClick={() => void saveAndRebuild()} disabled={busy || !dirty} data-testid="schematic-editor-save">
          Apply
        </button>
        <button
          style={styles.toolButton}
          onClick={fitViewport}
          disabled={busy}
          data-testid="schematic-editor-fit"
        >
          Fit
        </button>
        <button style={styles.toolButton} onClick={onBuild} disabled={busy} data-testid="schematic-editor-rebuild-svg">
          Build netlistsvg
        </button>
        <span style={styles.statusText} data-testid="schematic-editor-status">
          {wireStart
            ? `Wire from ${wireStart.label}${hoverEndpoint ? ` to ${hoverEndpoint.label}` : ''}`
            : hoverEndpoint
              ? `Snap ${hoverEndpoint.label}`
              : dirty ? 'Unsaved' : 'Saved'}
        </span>
        <span style={styles.statusText} data-testid="schematic-editor-zoom">
          {Math.round(zoom * 100)}%
        </span>
      </div>

      <div style={styles.content}>
        <div style={styles.stage}>
          <SchematicDocumentSvg
            document={document}
            selection={selection}
            wireStart={wireStart}
            wirePreview={wirePreview}
            hoverEndpoint={hoverEndpoint}
            showGrid
            cursor={editorCursor}
            viewBoxOverride={activeViewBox}
            testId="schematic-editor-svg"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            svgRef={svgRef}
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

function endpointIdentity(endpoint: EndpointHit | null): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) return `pin:${endpoint.component_id}:${endpoint.pin_id}`;
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  return `point:${endpoint.x},${endpoint.y}`;
}

function hitStoredWireSegment(
  wires: CircuitWire[],
  module: CircuitModule,
  world: CircuitPosition,
): { wire: CircuitWire; segmentIndex: number } | null {
  const storedIds = new Set((module.wires ?? []).map((wire) => wire.id));
  for (let wireIndex = wires.length - 1; wireIndex >= 0; wireIndex -= 1) {
    const wire = wires[wireIndex];
    if (!wire || (wire.source !== 'stored' && !storedIds.has(wire.id))) continue;
    const points = wire.points ?? [];
    for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex += 1) {
      const start = points[segmentIndex - 1];
      const end = points[segmentIndex];
      if (start && end && pointToSegmentDistance(world, start, end) < 7) {
        return { wire, segmentIndex };
      }
    }
  }
  return null;
}

function hitSelectedStoredWirePoint(
  wires: CircuitWire[],
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): { wire: CircuitWire; pointIndex: number; point: CircuitPosition } | null {
  if (selection?.kind !== 'wire') return null;
  const storedIds = new Set((module.wires ?? []).map((wire) => wire.id));
  const wire = wires.find((entry) => entry.id === selection.id && (entry.source === 'stored' || storedIds.has(entry.id)));
  if (!wire) return null;
  const points = wire.points ?? [];
  for (let pointIndex = points.length - 1; pointIndex >= 0; pointIndex -= 1) {
    const point = points[pointIndex];
    if (!point || distanceSquared(point, world) > 12 * 12) continue;
    if (wirePointIsDraggable(wire, pointIndex)) return { wire, pointIndex, point };
  }
  return null;
}

function wirePointIsDraggable(wire: CircuitWire, pointIndex: number): boolean {
  if (pointIndex > 0 && pointIndex < wire.points.length - 1) return true;
  const endpoint = pointIndex === 0 ? wire.from : pointIndex === wire.points.length - 1 ? wire.to : undefined;
  return Boolean(endpoint && !endpoint.component_id && !endpoint.port_id);
}

function cursorForWorld(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): EditorCursor {
  if (hitComponent(document, world)) return 'grab';
  if (hitSelectedStoredWirePoint(document.wires, module, selection, world)) return 'move';
  return hitStoredWireSegment(document.wires, module, world) ? 'move' : 'default';
}

function applyWirePointDrag(
  module: CircuitModule,
  drag: WirePointDragState,
  nextPoints: CircuitPosition[],
): CircuitModule {
  const next = cloneModule(module);
  const wire = next.wires?.find((entry) => entry.id === drag.wireId);
  if (!wire) return module;
  wire.points = compactEditorRoute(nextPoints);
  if (drag.pointIndex === 0 && wire.from && !wire.from.component_id && !wire.from.port_id) {
    wire.from = { ...wire.from, ...nextPoints[0] };
  }
  if (drag.pointIndex === drag.originalPoints.length - 1 && wire.to && !wire.to.component_id && !wire.to.port_id) {
    wire.to = { ...wire.to, ...nextPoints[nextPoints.length - 1] };
  }
  return next;
}

function dragWireSegmentPoints(
  points: CircuitPosition[],
  segmentIndex: number,
  dx: number,
  dy: number,
): CircuitPosition[] {
  const start = points[segmentIndex - 1];
  const end = points[segmentIndex];
  if (!start || !end) return clonePoints(points);
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const lastIndex = points.length - 1;
  const shiftedStart = horizontal
    ? { x: start.x, y: snapPoint({ x: 0, y: start.y + dy }).y }
    : { x: snapPoint({ x: start.x + dx, y: 0 }).x, y: start.y };
  const shiftedEnd = horizontal
    ? { x: end.x, y: shiftedStart.y }
    : { x: shiftedStart.x, y: end.y };
  const rebuilt: CircuitPosition[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    if (index === segmentIndex - 1) {
      if (index === 0) {
        rebuilt.push(point, shiftedStart);
      } else {
        rebuilt.push(shiftedStart);
      }
      continue;
    }
    if (index === segmentIndex) {
      if (index === lastIndex) {
        rebuilt.push(shiftedEnd, point);
      } else {
        rebuilt.push(shiftedEnd);
      }
      continue;
    }
    rebuilt.push(point);
  }
  return compactEditorRoute(rebuilt);
}

function compactEditorRoute(points: CircuitPosition[]): CircuitPosition[] {
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

function clonePoints(points: CircuitPosition[]): CircuitPosition[] {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function samePoints(left: CircuitPosition[], right: CircuitPosition[]): boolean {
  return left.length === right.length &&
    left.every((point, index) => point.x === right[index]?.x && point.y === right[index]?.y);
}

function distanceSquared(left: CircuitPosition, right: CircuitPosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function isSpacePanKey(event: Pick<KeyboardEvent | ReactKeyboardEvent<HTMLDivElement>, 'key'>): boolean {
  return event.key === ' ' || event.key === 'Spacebar';
}

const styles: Record<string, CSSProperties> = {
  editorShell: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 auto',
    minWidth: 0,
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
  content: { display: 'flex', flexDirection: 'column', minHeight: 520, flex: '1 1 520px' },
  stage: {
    flex: '1 1 420px',
    minHeight: 420,
    position: 'relative',
    overflow: 'hidden',
    background: '#ffffff',
  },
  panel: {
    borderTop: '1px solid #d8dee8',
    padding: 12,
    overflow: 'auto',
    background: '#fbfcfe',
    minHeight: 86,
    maxHeight: 180,
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

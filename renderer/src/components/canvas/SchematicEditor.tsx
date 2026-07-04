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
import type { CircuitComponent, CircuitModule, CircuitPosition, CircuitWire } from '../../types';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import {
  addWire,
  cloneModule,
  COMPONENT_TYPES,
  componentBounds,
  createSchematicDocument,
  hitComponent,
  hitEndpoint,
  hitWire,
  makeId,
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
  buildBusy?: boolean;
  onSave: (module: CircuitModule) => Promise<void>;
  onBuild: () => void;
}

interface DragState {
  componentIds: string[];
  startWorld: CircuitPosition;
  originalPositions: Record<string, CircuitPosition>;
  lastPositions: Record<string, CircuitPosition>;
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
  materializedWire?: CircuitWire;
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

interface MarqueeState {
  startWorld: CircuitPosition;
  currentWorld: CircuitPosition;
  startClient: CircuitPosition;
  moved: boolean;
}

type DraftUpdate = (current: CircuitModule) => CircuitModule;

export function SchematicEditor({ module, busy, buildBusy = false, onSave, onBuild }: Props) {
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
  const [editorFocused, setEditorFocused] = useState(false);
  const [marqueeBounds, setMarqueeBounds] = useState<SchematicBounds | null>(null);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [history, setHistory] = useState<CircuitModule[]>([]);
  const [future, setFuture] = useState<CircuitModule[]>([]);
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const wireSegmentDragRef = useRef<WireSegmentDragState | null>(null);
  const wirePointDragRef = useRef<WirePointDragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const draftUpdateFrameRef = useRef<number | null>(null);
  const pendingDraftUpdateRef = useRef<DraftUpdate | null>(null);
  const viewportUpdateFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<SchematicBounds | null>(null);

  const document = useMemo(() => createSchematicDocument(draft, { autoLayout: false }), [draft]);
  const activeViewBox = viewport ?? document.viewBox;
  const zoom = Math.max(
    0.05,
    (document.viewBox.maxX - document.viewBox.minX) / Math.max(1, activeViewBox.maxX - activeViewBox.minX),
  );
  const selectedComponentIds = componentIdsForSelection(selection);
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
    cancelPendingViewportUpdate();
    setDraft(createSchematicDocument(module).module);
    setDirty(false);
    setSelection(null);
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setInteractionCursor('default');
    setViewport(null);
    setMarqueeBounds(null);
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

  function scheduleDraftUpdate(update: DraftUpdate) {
    pendingDraftUpdateRef.current = update;
    if (draftUpdateFrameRef.current !== null) return;
    draftUpdateFrameRef.current = window.requestAnimationFrame(() => {
      draftUpdateFrameRef.current = null;
      const pending = pendingDraftUpdateRef.current;
      pendingDraftUpdateRef.current = null;
      if (pending) setDraft(pending);
    });
  }

  function flushPendingDraftUpdate() {
    const pending = pendingDraftUpdateRef.current;
    pendingDraftUpdateRef.current = null;
    if (draftUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(draftUpdateFrameRef.current);
      draftUpdateFrameRef.current = null;
    }
    if (pending) setDraft(pending);
  }

  function cancelPendingDraftUpdate() {
    pendingDraftUpdateRef.current = null;
    if (draftUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(draftUpdateFrameRef.current);
      draftUpdateFrameRef.current = null;
    }
  }

  function scheduleViewportUpdate(next: SchematicBounds) {
    pendingViewportRef.current = next;
    if (viewportUpdateFrameRef.current !== null) return;
    viewportUpdateFrameRef.current = window.requestAnimationFrame(() => {
      viewportUpdateFrameRef.current = null;
      const pending = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (pending) setViewport(pending);
    });
  }

  function flushPendingViewportUpdate() {
    const pending = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (viewportUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportUpdateFrameRef.current);
      viewportUpdateFrameRef.current = null;
    }
    if (pending) setViewport(pending);
  }

  function cancelPendingViewportUpdate() {
    pendingViewportRef.current = null;
    if (viewportUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportUpdateFrameRef.current);
      viewportUpdateFrameRef.current = null;
    }
  }

  function markDirty() {
    setDirty((current) => (current ? current : true));
  }

  useEffect(() => () => {
    cancelPendingDraftUpdate();
    cancelPendingViewportUpdate();
  }, []);

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
    cancelPendingViewportUpdate();
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
      setWireStart(hit);
      setHoverWorld(null);
      setHoverEndpoint(null);
      wireDragRef.current = null;
      return;
    }

    const selectedHandleHit = selectedComponentHandleFromPointerTarget(document, event.target);
    const directComponentHit = componentFromPointerTarget(document, event.target) ?? hitComponent(document, world);
    const selectedFrameHit = selectedHandleHit ?? (!directComponentHit ? hitSelectedComponentFrame(document, selection, world) : null);
    const componentHit = selectedHandleHit ??
      directComponentHit ??
      selectedFrameHit ??
      null;
    if (componentHit) {
      const currentComponentIds = componentIdsForSelection(selection);
      if (event.shiftKey) {
        const nextComponentIds = currentComponentIds.includes(componentHit.id)
          ? currentComponentIds.filter((componentId) => componentId !== componentHit.id)
          : [...currentComponentIds, componentHit.id];
        setSelection(selectionForComponentIds(nextComponentIds));
        setInteractionCursor(nextComponentIds.includes(componentHit.id) ? 'grab' : 'default');
        return;
      }
      const shouldDragGroup = Boolean(selectedHandleHit && currentComponentIds.includes(componentHit.id));
      const componentIds = shouldDragGroup ? currentComponentIds : [componentHit.id];
      if (!shouldDragGroup || !currentComponentIds.includes(componentHit.id)) {
        setSelection(selectionForComponentIds(componentIds));
      }
      setInteractionCursor('grabbing');
      dragRef.current = {
        componentIds,
        startWorld: world,
        originalPositions: componentPositionsById(draft, componentIds),
        lastPositions: componentPositionsById(draft, componentIds),
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

    const wireSegmentHit = hitEditableWireSegment(document.wires, draft, world);
    const wireHit = wireSegmentHit?.wire ?? hitWire(document, world);
    if (wireHit) {
      setSelection({ kind: 'wire', id: wireHit.id });
      if (wireSegmentHit) {
        const materializedWire = isStoredWire(wireSegmentHit.wire, draft)
          ? undefined
          : materializeEditableWire(wireSegmentHit.wire);
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
          materializedWire,
        };
      } else {
        setInteractionCursor('default');
      }
      return;
    }
    if (tool === 'select') {
      marqueeRef.current = {
        startWorld: world,
        currentWorld: world,
        startClient: { x: event.clientX, y: event.clientY },
        moved: false,
      };
      setMarqueeBounds(null);
      setInteractionCursor('default');
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
      scheduleViewportUpdate({
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
      scheduleDraftUpdate((current) => applyWirePointDrag(current, wirePointDrag, nextPoints));
      markDirty();
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
      scheduleDraftUpdate((current) => {
        const next = cloneModule(current);
        if (!next.wires) next.wires = [];
        let wire = next.wires.find((entry) => entry.id === wireSegmentDrag.wireId);
        if (!wire && wireSegmentDrag.materializedWire) {
          const materialized = cloneWire(wireSegmentDrag.materializedWire);
          next.wires.push(materialized);
          wire = materialized;
        }
        if (wire) wire.points = clonePoints(nextPoints);
        return next;
      });
      markDirty();
      return;
    }
    const marquee = marqueeRef.current;
    if (marquee) {
      marquee.currentWorld = world;
      if (!marquee.moved) {
        marquee.moved = Math.abs(event.clientX - marquee.startClient.x) + Math.abs(event.clientY - marquee.startClient.y) > 6;
      }
      setMarqueeBounds(marquee.moved ? normalizedBounds(marquee.startWorld, world) : null);
      setInteractionCursor('default');
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
    const nextPositions = Object.fromEntries(
      drag.componentIds.map((componentId) => {
        const original = drag.originalPositions[componentId];
        return [componentId, original ? snapPoint({ x: original.x + dx, y: original.y + dy }) : undefined];
      }).filter((entry): entry is [string, CircuitPosition] => Boolean(entry[1])),
    );
    if (samePositionMap(drag.lastPositions, nextPositions)) return;
    drag.lastPositions = clonePositionMap(nextPositions);
    scheduleDraftUpdate((current) => {
      const next = cloneModule(current);
      let changed = false;
      for (const [componentId, nextPosition] of Object.entries(nextPositions)) {
        const component = next.components.find((entry) => entry.id === componentId);
        if (!component) continue;
        if (component.position.x === nextPosition.x && component.position.y === nextPosition.y) continue;
        component.position = nextPosition;
        changed = true;
      }
      if (!changed) return current;
      return next;
    });
    markDirty();
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    flushPendingDraftUpdate();
    flushPendingViewportUpdate();
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
      setWireStart(end);
      setHoverWorld(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      return;
    }
    const drag = dragRef.current;
    const wirePointDrag = wirePointDragRef.current;
    const wireSegmentDrag = wireSegmentDragRef.current;
    const marquee = marqueeRef.current;
    dragRef.current = null;
    wirePointDragRef.current = null;
    wireSegmentDragRef.current = null;
    marqueeRef.current = null;
    setMarqueeBounds(null);
    const world = screenToWorld(event);
    setInteractionCursor(cursorForWorld(document, draft, selection, world));
    if (marquee) {
      setSelection(marquee.moved ? selectionForMarquee(document, normalizedBounds(marquee.startWorld, marquee.currentWorld)) : null);
      return;
    }
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
    if (!drag?.moved) {
      if (drag) setInteractionCursor('grab');
      return;
    }
    setHistory((items) => [...items, drag.originalModule].slice(-40));
    setFuture([]);
    setDraft((current) => {
      const next = cloneModule(current);
      next.wires = rerouteStoredWires(next);
      return next;
    });
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    cancelActiveDrag();
    setHoverEndpoint(null);
    setInteractionCursor('default');
  }

  function handleContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveDrag();
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setMarqueeBounds(null);
    setSpacePanActive(false);
    setTool('select');
    setInteractionCursor('default');
  }

  function cancelActiveDrag() {
    cancelPendingDraftUpdate();
    cancelPendingViewportUpdate();
    const drag = dragRef.current;
    dragRef.current = null;
    wireDragRef.current = null;
    const wirePointDrag = wirePointDragRef.current;
    wirePointDragRef.current = null;
    const wireSegmentDrag = wireSegmentDragRef.current;
    wireSegmentDragRef.current = null;
    marqueeRef.current = null;
    panRef.current = null;
    setMarqueeBounds(null);
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

  function nudgeSelectedComponents(dx: number, dy: number) {
    if (selectedComponentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    let changed = false;
    for (const componentId of selectedComponentIds) {
      const component = next.components.find((entry) => entry.id === componentId);
      if (!component) continue;
      const nextPosition = snapPoint({
        x: component.position.x + dx,
        y: component.position.y + dy,
      });
      if (component.position.x === nextPosition.x && component.position.y === nextPosition.y) continue;
      component.position = nextPosition;
      changed = true;
    }
    if (!changed) return;
    next.wires = rerouteStoredWires(next);
    commitDraft(next);
  }

  function rotateSelectedComponents() {
    if (selectedComponentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    let changed = false;
    for (const componentId of selectedComponentIds) {
      const component = next.components.find((entry) => entry.id === componentId);
      if (!component) continue;
      component.rotation = normalizeRotation((component.rotation ?? 0) + 90);
      changed = true;
    }
    if (!changed) return;
    next.wires = rerouteStoredWires(next);
    commitDraft(next);
  }

  function duplicateSelectedComponents() {
    if (selectedComponentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    const selectedIds = new Set(selectedComponentIds);
    const existingIds = new Set(next.components.map((component) => component.id));
    const selectedComponents = draft.components.filter((component) => selectedIds.has(component.id));
    const duplicatedIds: string[] = [];
    for (const component of selectedComponents) {
      const id = makeId(component.type.toLowerCase(), existingIds);
      existingIds.add(id);
      next.components.push({
        ...cloneComponent(component),
        id,
        name: `${component.type}${id.replace(/^[a-z]+/i, '')}`,
        position: snapPoint({
          x: component.position.x + SCHEMATIC_GRID * 2,
          y: component.position.y + SCHEMATIC_GRID * 2,
        }),
        pins: component.pins.map((pin, index) => ({
          ...pin,
          net: `n_${id}_${index + 1}`,
        })),
      });
      duplicatedIds.push(id);
    }
    if (duplicatedIds.length === 0) return;
    commitDraft(next);
    setSelection(selectionForComponentIds(duplicatedIds));
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setInteractionCursor('grab');
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
    if ((event.ctrlKey || event.metaKey) && key === 'a') {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setSelection(selectionForComponentIds(draft.components.map((component) => component.id)));
      setInteractionCursor('default');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      if (!busy && dirty) void saveAndRebuild();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'd') {
      event.preventDefault();
      duplicateSelectedComponents();
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
    if (event.key.startsWith('Arrow') && selectedComponentIds.length > 0) {
      event.preventDefault();
      const step = event.shiftKey ? SCHEMATIC_GRID * 5 : SCHEMATIC_GRID;
      if (event.key === 'ArrowLeft') nudgeSelectedComponents(-step, 0);
      if (event.key === 'ArrowRight') nudgeSelectedComponents(step, 0);
      if (event.key === 'ArrowUp') nudgeSelectedComponents(0, -step);
      if (event.key === 'ArrowDown') nudgeSelectedComponents(0, step);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key === 'f') {
      event.preventDefault();
      fitViewport();
      return;
    }
    if (key === 'r' && selectedComponentIds.length > 0) {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      rotateSelectedComponents();
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
    setMarqueeBounds(null);
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
    setMarqueeBounds(null);
    setInteractionCursor('default');
  }

  function deleteSelection() {
    if (!selection || busy) return;
    const next = cloneModule(draft);
    const componentIds = componentIdsForSelection(selection);
    if (componentIds.length > 0) {
      const selectedIds = new Set(componentIds);
      next.components = next.components.filter((component) => !selectedIds.has(component.id));
      next.wires = (next.wires ?? []).filter((wire) => (
        !selectedIds.has(wire.from?.component_id ?? '') &&
        !selectedIds.has(wire.to?.component_id ?? '')
      ));
    } else if (selection.kind === 'wire') {
      const selectedWire = document.wires.find((wire) => wire.id === selection.id);
      if (selectedWire && !isStoredWire(selectedWire, next)) {
        next.wires = [
          ...(next.wires ?? []),
          ...document.wires
            .filter((wire) => wire.id !== selectedWire.id && wire.net === selectedWire.net && !isStoredWire(wire, next))
            .map(materializeEditableWire),
        ];
      }
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
      style={editorFocused ? { ...styles.editorShell, ...styles.editorShellFocused } : styles.editorShell}
      data-testid="schematic-editor"
      data-tool={tool}
      data-busy={busy ? 'true' : 'false'}
      data-preview-busy={buildBusy ? 'true' : 'false'}
      data-dirty={dirty ? 'true' : 'false'}
      data-selected={selectionAttribute(selection)}
      data-selected-component-count={String(selectedComponentIds.length)}
      data-hover-endpoint={hoverEndpoint ? hoverEndpoint.label : ''}
      data-wire-start={endpointIdentity(wireStart)}
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
        from: wire.from,
        to: wire.to,
        points: wire.points,
      })))}
      data-schematic-source="document"
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={() => setEditorFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditorFocused(false);
      }}
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
        <button style={styles.toolButton} onClick={onBuild} disabled={busy || buildBusy} data-testid="schematic-editor-rebuild-svg">
          {buildBusy ? 'Building...' : 'Build netlistsvg'}
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
            marqueeBounds={marqueeBounds}
            showGrid
            cursor={editorCursor}
            viewBoxOverride={activeViewBox}
            testId="schematic-editor-svg"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={handleContextMenu}
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
          ) : selection?.kind === 'components' ? (
            <div style={styles.emptyText}>{selection.ids.length} components selected</div>
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

function cloneComponent(component: CircuitComponent): CircuitComponent {
  return {
    ...component,
    position: { ...component.position },
    pins: component.pins.map((pin) => ({ ...pin })),
  };
}

function cloneWire(wire: CircuitWire): CircuitWire {
  return {
    ...wire,
    points: clonePoints(wire.points),
    from: wire.from ? { ...wire.from } : undefined,
    to: wire.to ? { ...wire.to } : undefined,
  };
}

function isStoredWire(wire: CircuitWire, module: CircuitModule): boolean {
  return wire.source === 'stored' || Boolean((module.wires ?? []).some((entry) => entry.id === wire.id));
}

function materializeEditableWire(wire: CircuitWire): CircuitWire {
  return {
    ...cloneWire(wire),
    source: 'stored',
  };
}

function hitEditableWireSegment(
  wires: CircuitWire[],
  module: CircuitModule,
  world: CircuitPosition,
): { wire: CircuitWire; segmentIndex: number } | null {
  return hitWireSegment(wires, world, (wire) => isStoredWire(wire, module)) ??
    hitWireSegment(wires, world, (wire) => !isStoredWire(wire, module));
}

function hitWireSegment(
  wires: CircuitWire[],
  world: CircuitPosition,
  includeWire: (wire: CircuitWire) => boolean,
): { wire: CircuitWire; segmentIndex: number } | null {
  for (let wireIndex = wires.length - 1; wireIndex >= 0; wireIndex -= 1) {
    const wire = wires[wireIndex];
    if (!wire || !includeWire(wire)) continue;
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
  if (hitSelectedComponentFrame(document, selection, world)) return 'grab';
  if (hitSelectedStoredWirePoint(document.wires, module, selection, world)) return 'move';
  return hitEditableWireSegment(document.wires, module, world) ? 'move' : 'default';
}

function hitSelectedComponentFrame(
  document: ReturnType<typeof createSchematicDocument>,
  selection: SchematicSelection,
  world: CircuitPosition,
): CircuitComponent | null {
  const selectedIds = new Set(componentIdsForSelection(selection));
  if (selectedIds.size === 0) return null;
  const padding = 28;
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (!component || !selectedIds.has(component.id)) continue;
    const bounds = componentBounds(component);
    if (
      world.x >= bounds.minX - padding &&
      world.x <= bounds.maxX + padding &&
      world.y >= bounds.minY - padding &&
      world.y <= bounds.maxY + padding
    ) {
      return component;
    }
  }
  return null;
}

function componentFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitComponent | null {
  if (!(target instanceof Element)) return null;
  const componentId = target.closest('[data-component-id]')?.getAttribute('data-component-id');
  if (!componentId) return null;
  return document.module.components.find((component) => component.id === componentId) ?? null;
}

function selectedComponentHandleFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitComponent | null {
  if (!(target instanceof Element)) return null;
  const handle = target.closest('[data-testid="schematic-selected-component-frame"], [data-testid="schematic-selected-component-corner"]');
  const componentId = handle?.closest('[data-component-id]')?.getAttribute('data-component-id');
  if (!componentId) return null;
  return document.module.components.find((component) => component.id === componentId) ?? null;
}

function selectionForMarquee(
  document: ReturnType<typeof createSchematicDocument>,
  bounds: SchematicBounds,
): SchematicSelection {
  const componentIds: string[] = [];
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (component && boundsIntersect(bounds, componentBounds(component))) {
      componentIds.unshift(component.id);
    }
  }
  if (componentIds.length === 1) {
    const componentId = componentIds[0];
    return componentId ? { kind: 'component', id: componentId } : null;
  }
  if (componentIds.length > 1) return { kind: 'components', ids: componentIds };
  const wire = document.wires.find((entry) => wireIntersectsBounds(entry, bounds));
  return wire ? { kind: 'wire', id: wire.id } : null;
}

function componentIdsForSelection(selection: SchematicSelection): string[] {
  if (selection?.kind === 'component') return [selection.id];
  if (selection?.kind === 'components') return selection.ids;
  return [];
}

function selectionForComponentIds(componentIds: string[]): SchematicSelection {
  const uniqueIds = [...new Set(componentIds)].filter(Boolean);
  if (uniqueIds.length === 0) return null;
  const firstId = uniqueIds[0];
  if (uniqueIds.length === 1 && firstId) return { kind: 'component', id: firstId };
  return { kind: 'components', ids: uniqueIds };
}

function selectionAttribute(selection: SchematicSelection): string {
  if (!selection) return '';
  if (selection.kind === 'components') return `components:${selection.ids.join(',')}`;
  return `${selection.kind}:${selection.id}`;
}

function componentPositionsById(module: CircuitModule, componentIds: string[]): Record<string, CircuitPosition> {
  return Object.fromEntries(
    componentIds
      .map((componentId) => {
        const component = module.components.find((entry) => entry.id === componentId);
        return component ? [componentId, { ...component.position }] : null;
      })
      .filter((entry): entry is [string, CircuitPosition] => Boolean(entry)),
  );
}

function clonePositionMap(positions: Record<string, CircuitPosition>): Record<string, CircuitPosition> {
  return Object.fromEntries(
    Object.entries(positions).map(([componentId, position]) => [componentId, { ...position }]),
  );
}

function samePositionMap(left: Record<string, CircuitPosition>, right: Record<string, CircuitPosition>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((componentId) => (
    left[componentId]?.x === right[componentId]?.x &&
    left[componentId]?.y === right[componentId]?.y
  ));
}

function normalizedBounds(start: CircuitPosition, end: CircuitPosition): SchematicBounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function boundsIntersect(left: SchematicBounds, right: SchematicBounds): boolean {
  return left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY;
}

function wireIntersectsBounds(wire: CircuitWire, bounds: SchematicBounds): boolean {
  const points = wire.points ?? [];
  if (points.some((point) => pointInBounds(point, bounds))) return true;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start && end && segmentIntersectsBounds(start, end, bounds)) return true;
  }
  return false;
}

function pointInBounds(point: CircuitPosition, bounds: SchematicBounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

function segmentIntersectsBounds(start: CircuitPosition, end: CircuitPosition, bounds: SchematicBounds): boolean {
  if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) return true;
  const topLeft = { x: bounds.minX, y: bounds.minY };
  const topRight = { x: bounds.maxX, y: bounds.minY };
  const bottomRight = { x: bounds.maxX, y: bounds.maxY };
  const bottomLeft = { x: bounds.minX, y: bounds.maxY };
  const edges: Array<[CircuitPosition, CircuitPosition]> = [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ];
  return edges.some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd));
}

function segmentsIntersect(a: CircuitPosition, b: CircuitPosition, c: CircuitPosition, d: CircuitPosition): boolean {
  const direction = (p: CircuitPosition, q: CircuitPosition, r: CircuitPosition) => (
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  );
  const abC = direction(a, b, c);
  const abD = direction(a, b, d);
  const cdA = direction(c, d, a);
  const cdB = direction(c, d, b);
  if (abC === 0 && pointInBounds(c, normalizedBounds(a, b))) return true;
  if (abD === 0 && pointInBounds(d, normalizedBounds(a, b))) return true;
  if (cdA === 0 && pointInBounds(a, normalizedBounds(c, d))) return true;
  if (cdB === 0 && pointInBounds(b, normalizedBounds(c, d))) return true;
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
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
    outline: 'none',
  },
  editorShellFocused: {
    border: '1px solid #93b4ff',
    boxShadow: '0 0 0 2px rgba(37, 99, 235, 0.16)',
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

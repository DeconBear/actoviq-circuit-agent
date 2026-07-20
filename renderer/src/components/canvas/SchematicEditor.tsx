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
import type { CircuitComponent, CircuitModule, CircuitPin, CircuitPort, CircuitPosition, CircuitWire } from '../../types';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import { EditorCommandToolbar, FloatingComponentPalette } from './toolbars/SchematicToolbars';
import {
  addWire,
  cloneModule,
  COMPONENT_TYPES,
  componentBounds,
  computePortPositions,
  createSchematicDocument,
  hitComponent,
  hitEndpoint,
  hitPort,
  hitWire,
  makeId,
  makePlacedBlock,
  makePlacedComponent,
  moduleBounds,
  normalizeConnectivity,
  normalizeRotation,
  padBounds,
  pointToSegmentDistance,
  pointEndpoint,
  removeWireAndUpdateConnectivity,
  rerouteWire,
  rerouteStoredWires,
  SCHEMATIC_GRID,
  snapPoint,
  type BlockDefinition,
  type BlockPinSide,
  type EndpointHit,
  type SchematicDocument,
  type SchematicBounds,
  type SchematicSelection,
  type ToolComponentType,
} from '../../schematic/schematicDocument';

type ToolMode = 'select' | 'wire' | 'place' | 'place-block';
type EditorCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'copy' | 'move';

const AUTOPAN_MARGIN_PX = 44;
const AUTOPAN_STEP_RATIO = 0.055;
const MAX_BLOCK_PINS = 32;

interface BlockDraftPin {
  id: string;
  name: string;
  net: string;
  side: BlockPinSide;
}

interface BlockDraft {
  name: string;
  value: string;
  width: number;
  height: number;
  pins: BlockDraftPin[];
}

function defaultBlockDraft(): BlockDraft {
  return {
    name: '',
    value: 'Functional block',
    width: 180,
    height: 120,
    pins: [
      { id: 'p1', name: 'IN', net: 'block_in', side: 'left' },
      { id: 'p2', name: 'EN', net: 'block_en', side: 'left' },
      { id: 'p3', name: 'OUT', net: 'block_out', side: 'right' },
      { id: 'p4', name: 'GND', net: '0', side: 'bottom' },
    ],
  };
}

interface Props {
  module: CircuitModule;
  busy: boolean;
  buildBusy?: boolean;
  onSave: (module: CircuitModule) => Promise<void>;
  onBuild: () => void;
  onProbe?: (probe: SchematicProbeSelection) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface SchematicProbeSelection {
  kind: 'voltage' | 'current';
  label: string;
  candidates: string[];
  net?: string;
  componentId?: string;
  componentType?: CircuitComponent['type'];
}

function componentCurrentCandidates(component: CircuitComponent): string[] {
  const parameter = ({
    R: 'i', C: 'i', L: 'i', D: 'id', M: 'id', Q: 'ic', I: 'current',
  } as Partial<Record<CircuitComponent['type'], string>>)[component.type];
  return [
    ...(parameter ? [`i(@${component.name}[${parameter}])`] : []),
    `i(${component.name})`,
  ];
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

interface PortDragState {
  portId: string;
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

interface ContextMenuState {
  x: number;
  y: number;
  selection: NonNullable<SchematicSelection>;
}

type DraftUpdate = (current: CircuitModule) => CircuitModule;

export function SchematicEditor({ module, busy, buildBusy = false, onSave, onBuild, onProbe, onDirtyChange }: Props) {
  const [draft, setDraft] = useState(() => createSchematicDocument(module).module);
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<ToolMode>('select');
  const [placeType, setPlaceType] = useState<ToolComponentType>('R');
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [blockDraft, setBlockDraft] = useState<BlockDraft>(() => defaultBlockDraft());
  const [pendingBlock, setPendingBlock] = useState<BlockDefinition | null>(null);
  const [selection, setSelection] = useState<SchematicSelection>(null);
  const [wireStart, setWireStart] = useState<EndpointHit | null>(null);
  const [hoverWorld, setHoverWorld] = useState<CircuitPosition | null>(null);
  const [hoverEndpoint, setHoverEndpoint] = useState<EndpointHit | null>(null);
  const [hoverSelection, setHoverSelection] = useState<SchematicSelection>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [interactionCursor, setInteractionCursor] = useState<EditorCursor>('default');
  const [viewport, setViewport] = useState<SchematicBounds | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [marqueeBounds, setMarqueeBounds] = useState<SchematicBounds | null>(null);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [dragPreviewPositions, setDragPreviewPositions] = useState<Record<string, CircuitPosition> | null>(null);
  const [clipboardComponentCount, setClipboardComponentCount] = useState(0);
  const [history, setHistory] = useState<CircuitModule[]>([]);
  const [future, setFuture] = useState<CircuitModule[]>([]);
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const portDragRef = useRef<PortDragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const wireSegmentDragRef = useRef<WireSegmentDragState | null>(null);
  const wirePointDragRef = useRef<WirePointDragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const componentClipboardRef = useRef<CircuitComponent[]>([]);
  const pasteSerialRef = useRef(0);
  const draftUpdateFrameRef = useRef<number | null>(null);
  const pendingDraftUpdateRef = useRef<DraftUpdate | null>(null);
  const viewportUpdateFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<SchematicBounds | null>(null);
  const dragPreviewFrameRef = useRef<number | null>(null);
  const pendingDragPreviewRef = useRef<Record<string, CircuitPosition> | null>(null);

  const baseDocument = useMemo(() => createSchematicDocument(draft, { autoLayout: false }), [draft]);
  const previewDraft = useMemo(() => {
    if (!dragPreviewPositions) return draft;
    const next = cloneModule(draft);
    applyComponentPositions(next, dragPreviewPositions);
    return next;
  }, [draft, dragPreviewPositions]);
  const document = useMemo(() => (
    dragPreviewPositions
      ? createDragPreviewDocument(baseDocument, previewDraft, Object.keys(dragPreviewPositions))
      : baseDocument
  ), [baseDocument, dragPreviewPositions, previewDraft]);
  const rubberBandWireIds = useMemo(() => (
    dragPreviewPositions
      ? previewWireIdsForComponents(baseDocument.wires, Object.keys(dragPreviewPositions))
      : undefined
  ), [baseDocument.wires, dragPreviewPositions]);
  const displayedComponentPositions = useMemo(() => {
    return componentPositionsById(previewDraft, previewDraft.components.map((component) => component.id));
  }, [previewDraft]);
  const activeViewBox = viewport ?? document.viewBox;
  const zoom = Math.max(
    0.05,
    (document.viewBox.maxX - document.viewBox.minX) / Math.max(1, activeViewBox.maxX - activeViewBox.minX),
  );
  const selectedComponentIds = componentIdsForSelection(selection);
  const selectedComponent = selection?.kind === 'component'
    ? draft.components.find((component) => component.id === selection.id) ?? null
    : null;
  const selectedPort = selection?.kind === 'port'
    ? draft.ports.find((port) => port.id === selection.id) ?? null
    : null;
  const selectedWire = selection?.kind === 'wire'
    ? document.wires.find((wire) => wire.id === selection.id) ?? null
    : null;
  const wirePreview = hoverWorld
    ? hoverEndpoint ?? pointEndpoint(snapPoint(hoverWorld))
    : null;
  const editorCursor: EditorCursor = (() => {
    if (interactionCursor === 'grabbing') return 'grabbing';
    if (spacePanActive) return 'grab';
    if (tool === 'wire') return 'crosshair';
    if (tool === 'place' || tool === 'place-block') return 'copy';
    return interactionCursor;
  })();

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    cancelPendingViewportUpdate();
    cancelPendingDragPreviewUpdate();
    setDraft(createSchematicDocument(module).module);
    setDirty(false);
    setTool('select');
    setSelection(null);
    setBlockDialogOpen(false);
    setBlockDraft(defaultBlockDraft());
    setPendingBlock(null);
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
    setInteractionCursor('default');
    setViewport(null);
    setMarqueeBounds(null);
    setSpacePanActive(false);
    setDragPreviewPositions(null);
    componentClipboardRef.current = [];
    pasteSerialRef.current = 0;
    setClipboardComponentCount(0);
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

  function scheduleDragPreviewPositions(next: Record<string, CircuitPosition>) {
    pendingDragPreviewRef.current = next;
    if (dragPreviewFrameRef.current !== null) return;
    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null;
      const pending = pendingDragPreviewRef.current;
      pendingDragPreviewRef.current = null;
      if (pending) setDragPreviewPositions(pending);
    });
  }

  function cancelPendingDragPreviewUpdate() {
    pendingDragPreviewRef.current = null;
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
  }

  function markDirty() {
    setDirty((current) => (current ? current : true));
  }

  useEffect(() => () => {
    cancelPendingDraftUpdate();
    cancelPendingViewportUpdate();
    cancelPendingDragPreviewUpdate();
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

  function autoPanViewport(svg: SVGSVGElement, clientX: number, clientY: number) {
    const box = svg.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const xDirection = clientX <= box.left + AUTOPAN_MARGIN_PX
      ? -1
      : clientX >= box.right - AUTOPAN_MARGIN_PX ? 1 : 0;
    const yDirection = clientY <= box.top + AUTOPAN_MARGIN_PX
      ? -1
      : clientY >= box.bottom - AUTOPAN_MARGIN_PX ? 1 : 0;
    if (xDirection === 0 && yDirection === 0) return;
    const current = pendingViewportRef.current ?? activeViewBox;
    const width = current.maxX - current.minX;
    const height = current.maxY - current.minY;
    const dx = xDirection * width * AUTOPAN_STEP_RATIO;
    const dy = yDirection * height * AUTOPAN_STEP_RATIO;
    scheduleViewportUpdate({
      minX: current.minX + dx,
      minY: current.minY + dy,
      maxX: current.maxX + dx,
      maxY: current.maxY + dy,
    });
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
    setHoverSelection(null);
    setContextMenu(null);

    if (event.button === 1 || (event.button === 0 && (event.altKey || spacePanActive))) {
      panRef.current = {
        startClient: { x: event.clientX, y: event.clientY },
        originalViewBox: activeViewBox,
      };
      setInteractionCursor('grabbing');
      return;
    }

    const world = screenToWorld(event);
    setHoverWorld(snapPoint(world));
    setHoverEndpoint(tool === 'wire' || tool === 'place' || wireStart ? hitEndpoint(document, world) : null);

    if (tool === 'place-block') {
      if (!pendingBlock) {
        setBlockDialogOpen(true);
        return;
      }
      const next = cloneModule(draft);
      const component = makePlacedBlock(next, snapPoint(world), pendingBlock);
      next.components.push(component);
      commitDraft(next);
      setSelection({ kind: 'component', id: component.id });
      setPendingBlock(null);
      setTool('select');
      setInteractionCursor('grab');
      return;
    }

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
      const nextWireStart = addWire(next, wireStart, hit, document.wires);
      if (!nextWireStart) return;
      commitDraft(next);
      setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
      setWireStart(nextWireStart);
      setHoverWorld(null);
      setHoverEndpoint(null);
      wireDragRef.current = null;
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

    const portHit = portFromPointerTarget(document, event.target) ?? hitPort(document, world);
    if (portHit) {
      const position = document.portPositions.get(portHit.id);
      if (!position) return;
      setSelection({ kind: 'port', id: portHit.id });
      setInteractionCursor('grabbing');
      portDragRef.current = {
        portId: portHit.id,
        startWorld: world,
        originalPosition: { ...position },
        lastPosition: { ...position },
        originalModule: cloneModule(draft),
        originalDirty: dirty,
        moved: false,
      };
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
      setHoverSelection(null);
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
      setHoverSelection(null);
      const hit = hitEndpoint(document, world);
      setHoverEndpoint((current) => (
        endpointIdentity(current) === endpointIdentity(hit) ? current : hit
      ));
      const nextHoverWorld = snapPoint(world);
      setHoverWorld((current) => (samePosition(current, nextHoverWorld) ? current : nextHoverWorld));
    }
    const wireDrag = wireDragRef.current;
    if (wireDrag && !wireDrag.moved) {
      wireDrag.moved = Math.abs(event.clientX - wireDrag.startClient.x) + Math.abs(event.clientY - wireDrag.startClient.y) > 8;
    }
    if (wireDrag) {
      setHoverSelection(null);
      if (wireDrag.moved) autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const wirePointDrag = wirePointDragRef.current;
    if (wirePointDrag) {
      setHoverSelection(null);
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
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const wireSegmentDrag = wireSegmentDragRef.current;
    if (wireSegmentDrag) {
      setHoverSelection(null);
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
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const portDrag = portDragRef.current;
    if (portDrag) {
      setHoverSelection(null);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextPosition = snapPoint({
        x: portDrag.originalPosition.x + world.x - portDrag.startWorld.x,
        y: portDrag.originalPosition.y + world.y - portDrag.startWorld.y,
      });
      if (samePosition(portDrag.lastPosition, nextPosition)) return;
      portDrag.lastPosition = { ...nextPosition };
      portDrag.moved = true;
      scheduleDraftUpdate((current) => {
        const next = cloneModule(current);
        const port = next.ports.find((entry) => entry.id === portDrag.portId);
        if (port) port.position = { ...nextPosition };
        next.wires = rerouteStoredWires(next, { portIds: [portDrag.portId] });
        return next;
      });
      markDirty();
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const marquee = marqueeRef.current;
    if (marquee) {
      setHoverSelection(null);
      marquee.currentWorld = world;
      if (!marquee.moved) {
        marquee.moved = Math.abs(event.clientX - marquee.startClient.x) + Math.abs(event.clientY - marquee.startClient.y) > 6;
      }
      setMarqueeBounds(marquee.moved ? normalizedBounds(marquee.startWorld, world) : null);
      setInteractionCursor('default');
      if (marquee.moved) autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      if (tool === 'select') {
        const nextHoverSelection = hoverSelectionForWorld(document, draft, selection, world);
        setHoverSelection((current) => (
          selectionAttribute(current) === selectionAttribute(nextHoverSelection) ? current : nextHoverSelection
        ));
        setInteractionCursor((current) => {
          const next = cursorForWorld(document, draft, selection, world);
          return current === next ? current : next;
        });
      } else {
        setHoverSelection(null);
      }
      return;
    }
    setHoverSelection(null);
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
    scheduleDragPreviewPositions(nextPositions);
    autoPanViewport(event.currentTarget, event.clientX, event.clientY);
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
      const nextWireStart = addWire(next, wireDrag.start, end, document.wires);
      if (!nextWireStart) return;
      commitDraft(next);
      setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
      setWireStart(nextWireStart);
      setHoverWorld(null);
      setHoverEndpoint(null);
      setInteractionCursor('default');
      return;
    }
    const drag = dragRef.current;
    const portDrag = portDragRef.current;
    const wirePointDrag = wirePointDragRef.current;
    const wireSegmentDrag = wireSegmentDragRef.current;
    const marquee = marqueeRef.current;
    dragRef.current = null;
    portDragRef.current = null;
    wirePointDragRef.current = null;
    wireSegmentDragRef.current = null;
    marqueeRef.current = null;
    cancelPendingDragPreviewUpdate();
    setMarqueeBounds(null);
    setDragPreviewPositions(null);
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
    if (portDrag?.moved) {
      setHistory((items) => [...items, portDrag.originalModule].slice(-40));
      setFuture([]);
      setDraft((current) => {
        const next = cloneModule(current);
        const port = next.ports.find((entry) => entry.id === portDrag.portId);
        if (port) port.position = { ...portDrag.lastPosition };
        next.wires = rerouteStoredWires(next, { portIds: [portDrag.portId] });
        return next;
      });
      setDirty(true);
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
      applyComponentPositions(next, drag.lastPositions);
      next.wires = rerouteStoredWires(next, { componentIds: drag.componentIds });
      return next;
    });
    setDirty(true);
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    cancelActiveDrag();
    setHoverEndpoint(null);
    setHoverSelection(null);
    setInteractionCursor('default');
  }

  function handlePointerLeave(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    setHoverSelection(null);
    if (!wireStart) {
      setHoverEndpoint(null);
      setHoverWorld(null);
    }
  }

  function handleContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    const activeGesture = Boolean(
      wireStart || tool !== 'select' || dragRef.current || portDragRef.current || wireDragRef.current || wirePointDragRef.current || wireSegmentDragRef.current || marqueeRef.current || panRef.current,
    );
    const world = clientToWorld(event.currentTarget, event.clientX, event.clientY);
    const menuSelection = activeGesture
      ? null
      : contextMenuSelectionForTarget(document, draft, event.target, world);
    cancelActiveDrag();
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setMarqueeBounds(null);
    setSpacePanActive(false);
    setTool('select');
    setInteractionCursor('default');
    if (menuSelection) {
      setSelection(menuSelection);
      setContextMenu({ x: event.clientX, y: event.clientY, selection: menuSelection });
    } else {
      setSelection(null);
      setContextMenu(null);
    }
  }

  function cancelActiveDrag() {
    cancelPendingDraftUpdate();
    cancelPendingViewportUpdate();
    cancelPendingDragPreviewUpdate();
    const drag = dragRef.current;
    dragRef.current = null;
    const portDrag = portDragRef.current;
    portDragRef.current = null;
    wireDragRef.current = null;
    const wirePointDrag = wirePointDragRef.current;
    wirePointDragRef.current = null;
    const wireSegmentDrag = wireSegmentDragRef.current;
    wireSegmentDragRef.current = null;
    marqueeRef.current = null;
    panRef.current = null;
    setMarqueeBounds(null);
    setDragPreviewPositions(null);
    setHoverSelection(null);
    setContextMenu(null);
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
    if (portDrag?.moved) {
      setDraft(portDrag.originalModule);
      setDirty(portDrag.originalDirty);
      return;
    }
    if (!drag) return;
    if (drag.moved) {
      setDraft(drag.originalModule);
      setDirty(drag.originalDirty);
    }
  }

  function nudgeSelectedComponents(dx: number, dy: number) {
    if (busy) return;
    const next = cloneModule(draft);
    if (selectedPort) {
      const port = next.ports.find((entry) => entry.id === selectedPort.id);
      const position = document.portPositions.get(selectedPort.id);
      if (!port || !position) return;
      port.position = snapPoint({ x: position.x + dx, y: position.y + dy });
      next.wires = rerouteStoredWires(next, { portIds: [selectedPort.id] });
      commitDraft(next);
      return;
    }
    if (selectedComponentIds.length === 0) return;
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
    next.wires = rerouteStoredWires(next, { componentIds: selectedComponentIds });
    commitDraft(next);
    setContextMenu(null);
  }

  function rotateSelectedComponents(targetSelection: SchematicSelection = selection) {
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    let changed = false;
    for (const componentId of componentIds) {
      const component = next.components.find((entry) => entry.id === componentId);
      if (!component) continue;
      component.rotation = normalizeRotation((component.rotation ?? 0) + 90);
      changed = true;
    }
    if (!changed) return;
    next.wires = rerouteStoredWires(next, { componentIds });
    commitDraft(next);
    setContextMenu(null);
  }

  function duplicateSelectedComponents(targetSelection: SchematicSelection = selection) {
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    const selectedIds = new Set(componentIds);
    const selectedComponents = draft.components.filter((component) => selectedIds.has(component.id));
    const copiedComponentIds = appendCopiedComponents(next, selectedComponents, SCHEMATIC_GRID * 2);
    if (copiedComponentIds.length === 0) return;
    commitDraft(next);
    setSelection(selectionForComponentIds(copiedComponentIds));
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setContextMenu(null);
    setInteractionCursor('grab');
  }

  function copySelectedComponents(targetSelection: SchematicSelection = selection) {
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length === 0) return;
    const selectedIds = new Set(componentIds);
    componentClipboardRef.current = draft.components
      .filter((component) => selectedIds.has(component.id))
      .map(cloneComponent);
    setClipboardComponentCount(componentClipboardRef.current.length);
    pasteSerialRef.current = 0;
  }

  function pasteCopiedComponents() {
    if (busy || componentClipboardRef.current.length === 0) return;
    pasteSerialRef.current += 1;
    const next = cloneModule(draft);
    const copiedComponentIds = appendCopiedComponents(
      next,
      componentClipboardRef.current,
      SCHEMATIC_GRID * 2 * pasteSerialRef.current,
    );
    if (copiedComponentIds.length === 0) return;
    commitDraft(next);
    setSelection(selectionForComponentIds(copiedComponentIds));
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
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
      setContextMenu(null);
      setTool('select');
      setBlockDialogOpen(false);
      setPendingBlock(null);
      setSpacePanActive(false);
      setHoverSelection(null);
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
      setHoverSelection(null);
      setContextMenu(null);
      setSelection(selectionForComponentIds(draft.components.map((component) => component.id)));
      setInteractionCursor('default');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      if (!busy && dirty) void saveAndRebuild();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'c') {
      event.preventDefault();
      copySelectedComponents();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'v') {
      event.preventDefault();
      pasteCopiedComponents();
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
    if (event.key.startsWith('Arrow') && (selectedComponentIds.length > 0 || selectedPort)) {
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
      setHoverSelection(null);
      setInteractionCursor('default');
      rotateSelectedComponents();
      return;
    }
    if (key === 'w') {
      event.preventDefault();
      setTool('wire');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      return;
    }
    if (key === 's') {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      return;
    }
    if (key === 'b') {
      event.preventDefault();
      openBlockDialog();
      return;
    }
    const componentType = event.key.toUpperCase() as ToolComponentType;
    if ((COMPONENT_TYPES as readonly string[]).includes(componentType)) {
      event.preventDefault();
      setTool('place');
      setPlaceType(componentType);
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
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
    setHoverSelection(null);
    setContextMenu(null);
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
    setHoverSelection(null);
    setContextMenu(null);
    setMarqueeBounds(null);
    setInteractionCursor('default');
  }

  function deleteSelection(targetSelection: SchematicSelection = selection) {
    if (!targetSelection || busy) return;
    if (targetSelection.kind === 'port') return;
    const next = cloneModule(draft);
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length > 0) {
      const selectedIds = new Set(componentIds);
      next.components = next.components.filter((component) => !selectedIds.has(component.id));
      next.wires = (next.wires ?? []).filter((wire) => (
        !selectedIds.has(wire.from?.component_id ?? '') &&
        !selectedIds.has(wire.to?.component_id ?? '')
      ));
    } else if (targetSelection.kind === 'wire') {
      const selectedWire = document.wires.find((wire) => wire.id === targetSelection.id);
      if (selectedWire && !isStoredWire(selectedWire, next)) {
        next.wires = [
          ...(next.wires ?? []),
          ...document.wires
            .filter((wire) => wire.id !== selectedWire.id && wire.net === selectedWire.net && !isStoredWire(wire, next))
            .map(materializeEditableWire),
        ];
      }
      const updated = removeWireAndUpdateConnectivity(next, selectedWire ?? targetSelection.id);
      next.components = updated.components;
      next.ports = updated.ports;
      next.wires = updated.wires;
    }
    commitDraft(next);
    setSelection(null);
    setHoverSelection(null);
    setContextMenu(null);
    setInteractionCursor('default');
  }

  function openBlockDialog() {
    setBlockDraft(defaultBlockDraft());
    setBlockDialogOpen(true);
    setPendingBlock(null);
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
  }

  function setBlockPinCount(value: number) {
    const count = clamp(Math.round(value || 1), 1, MAX_BLOCK_PINS);
    setBlockDraft((current) => {
      const pins = current.pins.slice(0, count);
      while (pins.length < count) {
        const index = pins.length;
        pins.push({
          id: `p${index + 1}`,
          name: `PIN${index + 1}`,
          net: `block_${index + 1}`,
          side: index % 2 === 0 ? 'left' : 'right',
        });
      }
      return { ...current, pins };
    });
  }

  function updateBlockDraftPin(index: number, patch: Partial<BlockDraftPin>) {
    setBlockDraft((current) => ({
      ...current,
      pins: current.pins.map((pin, pinIndex) => pinIndex === index ? { ...pin, ...patch } : pin),
    }));
  }

  function beginBlockPlacement() {
    const definition: BlockDefinition = {
      name: blockDraft.name,
      value: blockDraft.value,
      width: blockDraft.width,
      height: blockDraft.height,
      pins: blockDraft.pins.map((pin, index) => ({ ...pin, order: index })),
    };
    setPendingBlock(definition);
    setBlockDialogOpen(false);
    setTool('place-block');
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setInteractionCursor('default');
    editorShellRef.current?.focus();
  }

  function updateSelectedBlockPin(pinId: string, patch: Partial<CircuitPin>) {
    if (!selectedComponent || selectedComponent.type !== 'BLOCK') return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    const pin = component?.pins.find((entry) => entry.id === pinId);
    if (!component || !pin) return;
    const previousNet = pin.net;
    Object.assign(pin, patch);
    if (patch.net !== undefined) {
      pin.net = patch.net.trim() || previousNet;
      for (const wire of next.wires ?? []) {
        const touchesPin = [wire.from, wire.to].some((endpoint) => (
          endpoint?.component_id === component.id && endpoint.pin_id === pin.id
        ));
        if (touchesPin) wire.net = pin.net;
      }
    }
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
  }

  function addSelectedBlockPin() {
    if (!selectedComponent || selectedComponent.type !== 'BLOCK' || selectedComponent.pins.length >= MAX_BLOCK_PINS) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    const existing = new Set(component.pins.map((pin) => pin.id));
    const pinId = makeId('p', existing);
    const index = component.pins.length;
    component.pins.push({
      id: pinId,
      name: `PIN${index + 1}`,
      net: `n_${component.id}_${index + 1}`,
      side: index % 2 === 0 ? 'left' : 'right',
      order: index,
    });
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
  }

  function removeSelectedBlockPin(pinId: string) {
    if (!selectedComponent || selectedComponent.type !== 'BLOCK' || selectedComponent.pins.length <= 1) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    component.pins = component.pins.filter((pin) => pin.id !== pinId);
    next.wires = (next.wires ?? []).filter((wire) => ![wire.from, wire.to].some((endpoint) => (
      endpoint?.component_id === component.id && endpoint.pin_id === pinId
    )));
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
  }

  function updateSelectedComponent(patch: Partial<CircuitComponent>) {
    if (!selectedComponent) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    Object.assign(component, patch);
    if (patch.rotation !== undefined) {
      component.rotation = normalizeRotation(Number(patch.rotation));
      next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    }
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
      ref={editorShellRef}
      style={editorFocused ? { ...styles.editorShell, ...styles.editorShellFocused } : styles.editorShell}
      data-testid="schematic-editor"
      data-tool={tool}
      data-busy={busy ? 'true' : 'false'}
      data-preview-busy={buildBusy ? 'true' : 'false'}
      data-dirty={dirty ? 'true' : 'false'}
      data-selected={selectionAttribute(selection)}
      data-selected-component-count={String(selectedComponentIds.length)}
      data-clipboard-component-count={String(clipboardComponentCount)}
      data-hover-target={selectionAttribute(hoverSelection)}
      data-hover-endpoint={hoverEndpoint ? hoverEndpoint.label : ''}
      data-wire-start={endpointIdentity(wireStart)}
      data-cursor-mode={editorCursor}
      data-zoom={zoom.toFixed(3)}
      data-space-pan={spacePanActive ? 'true' : 'false'}
      data-block-dialog={blockDialogOpen ? 'true' : 'false'}
      data-block-placement-ready={pendingBlock ? 'true' : 'false'}
      data-viewport={JSON.stringify(activeViewBox)}
      data-component-count={draft.components.length}
      data-components={JSON.stringify(draft.components)}
      data-wire-count={document.wires.length}
      data-net-label-count={document.netLabels.length}
      data-drag-preview={dragPreviewPositions ? 'true' : 'false'}
      data-component-positions={JSON.stringify(displayedComponentPositions)}
      data-port-positions={JSON.stringify(Object.fromEntries(document.portPositions))}
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
      <EditorCommandToolbar
        selectActive={tool === 'select'}
        wireActive={tool === 'wire'}
        disabled={busy}
        canUndo={history.length > 0}
        canRedo={future.length > 0}
        hasSelection={Boolean(selection)}
        dirty={dirty}
        buildBusy={buildBusy}
        status={wireStart
          ? `Wire from ${wireStart.label}${hoverEndpoint ? ` to ${hoverEndpoint.label}` : ''}`
          : hoverEndpoint
            ? `Snap ${hoverEndpoint.label}`
            : dirty ? 'Unsaved' : 'Saved'}
        zoom={zoom}
        onSelect={() => {
          setTool('select');
          setPendingBlock(null);
          setWireStart(null);
          setHoverEndpoint(null);
          setHoverSelection(null);
        }}
        onWire={() => {
          setTool('wire');
          setPendingBlock(null);
          setWireStart(null);
          setHoverEndpoint(null);
          setHoverSelection(null);
        }}
        onUndo={undo}
        onRedo={redo}
        onDelete={() => deleteSelection()}
        onSave={() => void saveAndRebuild()}
        onFit={fitViewport}
        onBuild={onBuild}
      />

      <div style={styles.content}>
        <div style={styles.stage}>
          <FloatingComponentPalette
            activeType={tool === 'place' ? placeType : null}
            blockActive={tool === 'place-block' || blockDialogOpen}
            disabled={busy}
            onSelectType={(type) => {
              setTool('place');
              setPendingBlock(null);
              setPlaceType(type);
              setWireStart(null);
              setHoverEndpoint(null);
              setHoverSelection(null);
            }}
            onSelectBlock={openBlockDialog}
          />
          <SchematicDocumentSvg
            document={document}
            selection={selection}
            hoverSelection={hoverSelection}
            wireStart={wireStart}
            wirePreview={wirePreview}
            hoverEndpoint={hoverEndpoint}
            marqueeBounds={marqueeBounds}
            showGrid
            cursor={editorCursor}
            viewBoxOverride={activeViewBox}
            rubberBandWireIds={rubberBandWireIds}
            testId="schematic-editor-svg"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
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
              {onProbe && selectedComponent.type !== 'BLOCK' ? (
                <div style={styles.probeActions}>
                  <button
                    type="button"
                    style={styles.smallButton}
                    onClick={() => onProbe({
                      kind: 'current',
                      label: `Current through ${selectedComponent.name}`,
                      candidates: componentCurrentCandidates(selectedComponent),
                      componentId: selectedComponent.id,
                      componentType: selectedComponent.type,
                    })}
                    disabled={busy || dirty}
                    title={dirty ? 'Apply schematic changes before probing' : `Plot current through ${selectedComponent.name}`}
                    data-testid="schematic-editor-probe-current"
                  >
                    Plot current
                  </button>
                </div>
              ) : null}
              {selectedComponent.type === 'BLOCK' ? (
                <>
                  <div style={styles.fieldGrid}>
                    <label style={styles.fieldLabel}>
                      Width
                      <input
                        type="number"
                        min="120"
                        max="480"
                        step="20"
                        style={styles.input}
                        value={selectedComponent.block?.width ?? 180}
                        onChange={(event) => updateSelectedComponent({
                          block: { ...selectedComponent.block, width: Number(event.target.value) },
                        })}
                        disabled={busy}
                        data-testid="schematic-editor-block-width"
                      />
                    </label>
                    <label style={styles.fieldLabel}>
                      Height
                      <input
                        type="number"
                        min="84"
                        max="480"
                        step="20"
                        style={styles.input}
                        value={selectedComponent.block?.height ?? 120}
                        onChange={(event) => updateSelectedComponent({
                          block: { ...selectedComponent.block, height: Number(event.target.value) },
                        })}
                        disabled={busy}
                        data-testid="schematic-editor-block-height"
                      />
                    </label>
                  </div>
                  <div style={styles.pinEditorHeader}>
                    <span>Pins ({selectedComponent.pins.length})</span>
                    <button
                      type="button"
                      style={styles.smallButton}
                      onClick={addSelectedBlockPin}
                      disabled={busy || selectedComponent.pins.length >= MAX_BLOCK_PINS}
                      data-testid="schematic-editor-block-add-pin"
                    >
                      Add pin
                    </button>
                  </div>
                  <div style={styles.blockPinList} data-testid="schematic-editor-block-pins">
                    {selectedComponent.pins.map((pin) => (
                      <div key={pin.id} style={styles.blockPinRow} data-testid={`schematic-editor-block-pin-${pin.id}`}>
                        <code style={styles.pinId}>{pin.id}</code>
                        <input
                          style={styles.compactInput}
                          value={pin.name}
                          onChange={(event) => updateSelectedBlockPin(pin.id, { name: event.target.value })}
                          aria-label={`Pin ${pin.id} label`}
                          data-testid={`schematic-editor-block-pin-label-${pin.id}`}
                        />
                        <input
                          style={styles.compactInput}
                          value={pin.net}
                          onChange={(event) => updateSelectedBlockPin(pin.id, { net: event.target.value })}
                          aria-label={`Pin ${pin.id} net`}
                          data-testid={`schematic-editor-block-pin-net-${pin.id}`}
                        />
                        <select
                          style={styles.compactInput}
                          value={pin.side ?? 'left'}
                          onChange={(event) => updateSelectedBlockPin(pin.id, { side: event.target.value as BlockPinSide })}
                          aria-label={`Pin ${pin.id} side`}
                          data-testid={`schematic-editor-block-pin-side-${pin.id}`}
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="top">Top</option>
                          <option value="bottom">Bottom</option>
                        </select>
                        <button
                          type="button"
                          style={styles.removePinButton}
                          onClick={() => removeSelectedBlockPin(pin.id)}
                          disabled={busy || selectedComponent.pins.length <= 1}
                          aria-label={`Remove pin ${pin.id}`}
                          title={`Remove pin ${pin.id}`}
                          data-testid={`schematic-editor-block-pin-remove-${pin.id}`}
                        >
                          X
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={styles.pinList}>
                  {selectedComponent.pins.map((pin) => (
                    <div key={pin.id} style={styles.pinRow}>
                      <span>{pin.name}</span>
                      <span style={styles.pinProbeGroup}>
                        <code>{pin.net}</code>
                        {onProbe ? (
                          <button
                            type="button"
                            style={styles.probeIconButton}
                            onClick={() => onProbe({
                              kind: 'voltage',
                              label: `Voltage at ${pin.net}`,
                              candidates: [`v(${pin.net})`],
                              net: pin.net,
                            })}
                            disabled={busy || dirty}
                            aria-label={`Plot voltage at ${pin.net}`}
                            title={dirty ? 'Apply schematic changes before probing' : `Plot voltage at ${pin.net}`}
                            data-testid={`schematic-editor-probe-pin-${pin.id}`}
                          >
                            V
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : selection?.kind === 'components' ? (
            <div style={styles.emptyText}>{selection.ids.length} components selected</div>
          ) : selectedPort ? (
            <div style={styles.pinList} data-testid="schematic-editor-port-panel">
              <div style={styles.pinRow}>
                <span>Port</span>
                <code>{selectedPort.name}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Net</span>
                <code data-testid="schematic-editor-port-net">{selectedPort.net}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Position</span>
                <code data-testid="schematic-editor-port-position">
                  {document.portPositions.get(selectedPort.id)
                    ? `${document.portPositions.get(selectedPort.id)?.x}, ${document.portPositions.get(selectedPort.id)?.y}`
                    : '-'}
                </code>
              </div>
            </div>
          ) : selectedWire ? (
            <div style={styles.pinList} data-testid="schematic-editor-wire-panel">
              <div style={styles.pinRow}>
                <span>Wire</span>
                <code>{selectedWire.id}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Net</span>
                <code data-testid="schematic-editor-wire-net">{selectedWire.net ?? '-'}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Source</span>
                <code data-testid="schematic-editor-wire-source">{selectedWire.source ?? 'net'}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Points</span>
                <code data-testid="schematic-editor-wire-point-count">{selectedWire.points.length}</code>
              </div>
              {onProbe && selectedWire.net ? (
                <button
                  type="button"
                  style={styles.smallButton}
                  onClick={() => onProbe({
                    kind: 'voltage',
                    label: `Voltage at ${selectedWire.net}`,
                    candidates: [`v(${selectedWire.net})`],
                    net: selectedWire.net,
                  })}
                  disabled={busy || dirty}
                  title={dirty ? 'Apply schematic changes before probing' : `Plot voltage at ${selectedWire.net}`}
                  data-testid="schematic-editor-probe-wire"
                >
                  Plot voltage
                </button>
              ) : null}
            </div>
          ) : (
            <div style={styles.emptyText}>No item selected</div>
          )}
        </aside>
      </div>
      {contextMenu ? (
        <div
          style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          data-testid="schematic-context-menu"
          data-menu-target={selectionAttribute(contextMenu.selection)}
          data-menu-kind={contextMenu.selection.kind === 'wire' ? 'wire' : 'component'}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.selection.kind !== 'wire' ? (
            <>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => rotateSelectedComponents(contextMenu.selection)}
                data-testid="schematic-context-menu-rotate"
              >
                Rotate
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => duplicateSelectedComponents(contextMenu.selection)}
                data-testid="schematic-context-menu-duplicate"
              >
                Duplicate
              </button>
            </>
          ) : null}
          <button
            type="button"
            style={styles.contextMenuItemDanger}
            onClick={() => deleteSelection(contextMenu.selection)}
            data-testid="schematic-context-menu-delete"
          >
            Delete
          </button>
        </div>
      ) : null}
      {blockDialogOpen ? (
        <div
          style={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Configure custom block"
          data-testid="schematic-block-dialog"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setBlockDialogOpen(false);
            }
          }}
        >
          <div style={styles.blockModal}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.panelTitle}>Custom symbol</div>
                <div style={styles.modalTitle}>Place block</div>
              </div>
              <button
                type="button"
                style={styles.modalCloseButton}
                onClick={() => setBlockDialogOpen(false)}
                aria-label="Close block dialog"
                title="Close"
                data-testid="schematic-block-cancel-x"
              >
                X
              </button>
            </div>
            <div style={styles.fieldGrid}>
              <label style={styles.fieldLabel}>
                Reference
                <input
                  style={styles.input}
                  value={blockDraft.name}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="U1"
                  data-testid="schematic-block-name"
                />
              </label>
              <label style={styles.fieldLabel}>
                Block label
                <input
                  style={styles.input}
                  value={blockDraft.value}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, value: event.target.value }))}
                  data-testid="schematic-block-value"
                />
              </label>
              <label style={styles.fieldLabel}>
                Width
                <input
                  type="number"
                  min="120"
                  max="480"
                  step="20"
                  style={styles.input}
                  value={blockDraft.width}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, width: clamp(Number(event.target.value), 120, 480) }))}
                  data-testid="schematic-block-width"
                />
              </label>
              <label style={styles.fieldLabel}>
                Height
                <input
                  type="number"
                  min="84"
                  max="480"
                  step="20"
                  style={styles.input}
                  value={blockDraft.height}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, height: clamp(Number(event.target.value), 84, 480) }))}
                  data-testid="schematic-block-height"
                />
              </label>
            </div>
            <label style={styles.fieldLabel}>
              Pin count
              <input
                type="number"
                min="1"
                max={MAX_BLOCK_PINS}
                style={styles.input}
                value={blockDraft.pins.length}
                onChange={(event) => setBlockPinCount(Number(event.target.value))}
                data-testid="schematic-block-pin-count"
              />
            </label>
            <div style={styles.blockDraftHeader} aria-hidden="true">
              <span>ID</span><span>Label</span><span>Net</span><span>Side</span>
            </div>
            <div style={styles.blockDraftPins} data-testid="schematic-block-pin-config">
              {blockDraft.pins.map((pin, index) => (
                <div key={pin.id} style={styles.blockDraftPinRow} data-testid={`schematic-block-draft-pin-${index + 1}`}>
                  <code style={styles.pinId}>{pin.id}</code>
                  <input
                    style={styles.compactInput}
                    value={pin.name}
                    onChange={(event) => updateBlockDraftPin(index, { name: event.target.value })}
                    aria-label={`Block pin ${index + 1} label`}
                    data-testid={`schematic-block-draft-pin-label-${index + 1}`}
                  />
                  <input
                    style={styles.compactInput}
                    value={pin.net}
                    onChange={(event) => updateBlockDraftPin(index, { net: event.target.value })}
                    aria-label={`Block pin ${index + 1} net`}
                    data-testid={`schematic-block-draft-pin-net-${index + 1}`}
                  />
                  <select
                    style={styles.compactInput}
                    value={pin.side}
                    onChange={(event) => updateBlockDraftPin(index, { side: event.target.value as BlockPinSide })}
                    aria-label={`Block pin ${index + 1} side`}
                    data-testid={`schematic-block-draft-pin-side-${index + 1}`}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                    <option value="top">Top</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </div>
              ))}
            </div>
            <div style={styles.modalActions}>
              <button
                type="button"
                style={styles.toolButton}
                onClick={() => setBlockDialogOpen(false)}
                data-testid="schematic-block-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={beginBlockPlacement}
                disabled={!blockDraft.value.trim() || blockDraft.pins.length === 0}
                data-testid="schematic-block-place"
              >
                Place on canvas
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
    block: component.block ? { ...component.block } : undefined,
  };
}

function appendCopiedComponents(
  module: CircuitModule,
  sourceComponents: CircuitComponent[],
  offset: number,
): string[] {
  const existingIds = new Set(module.components.map((component) => component.id));
  const componentIds: string[] = [];
  for (const source of sourceComponents) {
    const id = makeId(source.type.toLowerCase(), existingIds);
    existingIds.add(id);
    const component: CircuitComponent = {
      ...cloneComponent(source),
      id,
      name: `${source.type}${id.replace(/^[a-z]+/i, '')}`,
      position: snapPoint({
        x: source.position.x + offset,
        y: source.position.y + offset,
      }),
      pins: source.pins.map((pin, index) => ({
        ...pin,
        net: `n_${id}_${index + 1}`,
      })),
    };
    module.components.push(component);
    componentIds.push(id);
  }
  return componentIds;
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

function createDragPreviewDocument(
  baseDocument: SchematicDocument,
  previewModule: CircuitModule,
  draggedComponentIds: string[],
): SchematicDocument {
  const draggedIds = new Set(draggedComponentIds);
  const portPositions = computePortPositions(previewModule);
  const wires = baseDocument.wires.map((wire) => (
    wireTouchesPreviewComponent(wire, draggedIds)
      ? rerouteWire(previewModule, wire, portPositions)
      : wire
  ));
  const bounds = moduleBounds(previewModule, portPositions, wires, baseDocument.netLabels);
  return {
    ...baseDocument,
    module: previewModule,
    portPositions,
    wires,
    bounds,
    viewBox: padBounds(bounds, 70),
  };
}

function wireTouchesPreviewComponent(wire: CircuitWire, componentIds: Set<string>): boolean {
  return Boolean(
    wire.from?.component_id && componentIds.has(wire.from.component_id) ||
    wire.to?.component_id && componentIds.has(wire.to.component_id),
  );
}

function previewWireIdsForComponents(wires: CircuitWire[], componentIds: string[]): Set<string> {
  const ids = new Set(componentIds);
  return new Set(wires.filter((wire) => wireTouchesPreviewComponent(wire, ids)).map((wire) => wire.id));
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
  // Shared semantic junctions must move as a whole graph. Until a junction-drag
  // gesture is active, keep them anchored instead of silently detaching one edge.
  return Boolean(endpoint && !endpoint.component_id && !endpoint.port_id && !endpoint.junction_id);
}

function cursorForWorld(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): EditorCursor {
  if (hitSelectedStoredWirePoint(document.wires, module, selection, world)) return 'move';
  if (hitPort(document, world)) return 'grab';
  if (hitComponent(document, world)) return 'grab';
  if (hitSelectedComponentFrame(document, selection, world)) return 'grab';
  return hitEditableWireSegment(document.wires, module, world) ? 'move' : 'default';
}

function hoverSelectionForWorld(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): SchematicSelection {
  const port = hitPort(document, world);
  if (port && !(selection?.kind === 'port' && selection.id === port.id)) {
    return { kind: 'port', id: port.id };
  }
  const component = hitComponent(document, world);
  if (component && !componentIdsForSelection(selection).includes(component.id)) {
    return { kind: 'component', id: component.id };
  }
  const wire = hitEditableWireSegment(document.wires, module, world)?.wire ?? hitWire(document, world);
  if (wire && !(selection?.kind === 'wire' && selection.id === wire.id)) {
    return { kind: 'wire', id: wire.id };
  }
  return null;
}

function contextMenuSelectionForTarget(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  target: EventTarget | null,
  world: CircuitPosition,
): SchematicSelection {
  const component = componentFromPointerTarget(document, target) ?? hitComponent(document, world);
  if (component) return { kind: 'component', id: component.id };
  const wire = hitEditableWireSegment(document.wires, module, world)?.wire ?? hitWire(document, world);
  return wire ? { kind: 'wire', id: wire.id } : null;
}

function hitSelectedComponentFrame(
  document: ReturnType<typeof createSchematicDocument>,
  selection: SchematicSelection,
  world: CircuitPosition,
): CircuitComponent | null {
  const selectedIds = new Set(componentIdsForSelection(selection));
  if (selectedIds.size === 0) return null;
  const frameInset = 6;
  const hitBand = 10;
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (!component || !selectedIds.has(component.id)) continue;
    const bounds = componentBounds(component);
    const outer = {
      minX: bounds.minX - frameInset - hitBand,
      minY: bounds.minY - frameInset - hitBand,
      maxX: bounds.maxX + frameInset + hitBand,
      maxY: bounds.maxY + frameInset + hitBand,
    };
    const inner = {
      minX: bounds.minX - frameInset + hitBand,
      minY: bounds.minY - frameInset + hitBand,
      maxX: bounds.maxX + frameInset - hitBand,
      maxY: bounds.maxY + frameInset - hitBand,
    };
    const insideOuter = world.x >= outer.minX && world.x <= outer.maxX && world.y >= outer.minY && world.y <= outer.maxY;
    const insideInner = world.x >= inner.minX && world.x <= inner.maxX && world.y >= inner.minY && world.y <= inner.maxY;
    if (insideOuter && !insideInner) {
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

function portFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitPort | null {
  if (!(target instanceof Element)) return null;
  const portId = target.closest('[data-port-id]')?.getAttribute('data-port-id');
  if (!portId) return null;
  return document.module.ports.find((port) => port.id === portId) ?? null;
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

function applyComponentPositions(module: CircuitModule, positions: Record<string, CircuitPosition>) {
  for (const [componentId, position] of Object.entries(positions)) {
    const component = module.components.find((entry) => entry.id === componentId);
    if (component) component.position = { ...position };
  }
}

function clonePositionMap(positions: Record<string, CircuitPosition>): Record<string, CircuitPosition> {
  return Object.fromEntries(
    Object.entries(positions).map(([componentId, position]) => [componentId, { ...position }]),
  );
}

function samePosition(left: CircuitPosition | null, right: CircuitPosition | null): boolean {
  return left?.x === right?.x && left?.y === right?.y;
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
  const orthogonal = orthogonalizeEditorRoute(deduped);
  if (orthogonal.length <= 2) return orthogonal;
  return orthogonal.filter((point, index) => {
    if (index === 0 || index === orthogonal.length - 1) return true;
    const previous = orthogonal[index - 1];
    const next = orthogonal[index + 1];
    if (!previous || !next) return true;
    return !(
      previous.x === point.x && point.x === next.x ||
      previous.y === point.y && point.y === next.y
    );
  });
}

function orthogonalizeEditorRoute(points: CircuitPosition[]): CircuitPosition[] {
  const routed: CircuitPosition[] = [];
  for (const point of points) {
    const previous = routed.at(-1);
    if (!previous) {
      routed.push(point);
      continue;
    }
    if (previous.x === point.x || previous.y === point.y) {
      routed.push(point);
      continue;
    }
    const beforePrevious = routed.length > 1 ? routed[routed.length - 2] : undefined;
    const elbow = chooseEditorRouteElbow(beforePrevious, previous, point);
    if (elbow.x !== previous.x || elbow.y !== previous.y) routed.push(elbow);
    routed.push(point);
  }
  return routed;
}

function chooseEditorRouteElbow(
  beforeStart: CircuitPosition | undefined,
  start: CircuitPosition,
  end: CircuitPosition,
): CircuitPosition {
  if (beforeStart?.y === start.y) return { x: end.x, y: start.y };
  if (beforeStart?.x === start.x) return { x: start.x, y: end.y };
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
    ? { x: end.x, y: start.y }
    : { x: start.x, y: end.y };
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
    position: 'relative',
    border: '1px solid #d8dee8',
    background: '#ffffff',
    outline: 'none',
  },
  editorShellFocused: {
    border: '1px solid #93b4ff',
    boxShadow: '0 0 0 2px rgba(37, 99, 235, 0.16)',
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
    boxSizing: 'border-box',
    flex: '0 0 min(220px, 28vh)',
    height: 'min(220px, 28vh)',
    minHeight: 160,
    maxHeight: 'min(220px, 28vh)',
  },
  panelTitle: {
    color: '#697386',
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  fieldLabel: { display: 'grid', gap: 5, fontSize: 12, color: '#536172', marginBottom: 10, fontWeight: 650 },
  fieldGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0 10px' },
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
  probeActions: { display: 'flex', justifyContent: 'flex-end', margin: '2px 0 10px' },
  pinProbeGroup: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  probeIconButton: {
    width: 26,
    height: 26,
    border: '1px solid #b8c6d8',
    borderRadius: 4,
    background: '#ffffff',
    color: '#1f5f96',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 800,
  },
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
  pinEditorHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 4,
    color: '#536172',
    fontSize: 12,
    fontWeight: 750,
  },
  blockPinList: { display: 'grid', gap: 5, marginTop: 8 },
  blockPinRow: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(92px, 1fr) minmax(110px, 1.2fr) 96px 30px',
    gap: 6,
    alignItems: 'center',
  },
  compactInput: {
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
    height: 30,
    border: '1px solid #c7ced6',
    borderRadius: 4,
    padding: '4px 6px',
    color: '#202a37',
    background: '#ffffff',
    fontSize: 12,
  },
  pinId: { color: '#64748b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
  smallButton: {
    height: 28,
    padding: '0 8px',
    border: '1px solid #c7ced6',
    borderRadius: 4,
    background: '#ffffff',
    color: '#253041',
    cursor: 'pointer',
    fontWeight: 650,
    fontSize: 11,
  },
  removePinButton: {
    width: 30,
    height: 30,
    border: '1px solid #d8a5a5',
    borderRadius: 4,
    background: '#ffffff',
    color: '#a32626',
    cursor: 'pointer',
    fontWeight: 800,
  },
  emptyText: { color: '#748094', fontSize: 12, lineHeight: 1.5 },
  contextMenu: {
    position: 'fixed',
    zIndex: 1000,
    display: 'grid',
    gap: 2,
    minWidth: 132,
    padding: 5,
    border: '1px solid #c7ced6',
    borderRadius: 5,
    background: '#ffffff',
    boxShadow: '0 12px 28px rgba(15, 23, 42, 0.16)',
  },
  contextMenuItem: {
    height: 30,
    padding: '0 10px',
    border: 'none',
    borderRadius: 4,
    background: '#ffffff',
    color: '#253041',
    textAlign: 'left',
    fontWeight: 650,
    cursor: 'pointer',
  },
  contextMenuItemDanger: {
    height: 30,
    padding: '0 10px',
    border: 'none',
    borderRadius: 4,
    background: '#ffffff',
    color: '#b42318',
    textAlign: 'left',
    fontWeight: 700,
    cursor: 'pointer',
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1200,
    display: 'grid',
    placeItems: 'center',
    padding: 20,
    background: 'rgba(15, 23, 42, 0.34)',
  },
  blockModal: {
    width: 'min(760px, calc(100vw - 40px))',
    maxHeight: 'min(760px, calc(100vh - 40px))',
    overflow: 'auto',
    boxSizing: 'border-box',
    padding: 16,
    border: '1px solid #c7ced6',
    borderRadius: 6,
    background: '#ffffff',
    boxShadow: '0 18px 46px rgba(15, 23, 42, 0.24)',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 14,
  },
  modalTitle: { color: '#1f2937', fontSize: 18, fontWeight: 760 },
  modalCloseButton: {
    width: 30,
    height: 30,
    border: '1px solid #c7ced6',
    borderRadius: 4,
    background: '#ffffff',
    color: '#526071',
    cursor: 'pointer',
    fontWeight: 750,
  },
  blockDraftHeader: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(120px, 1fr) minmax(140px, 1.2fr) 104px',
    gap: 6,
    padding: '0 0 5px',
    color: '#697386',
    fontSize: 10,
    fontWeight: 800,
    textTransform: 'uppercase',
  },
  blockDraftPins: { display: 'grid', gap: 6, maxHeight: 310, overflow: 'auto', paddingRight: 3 },
  blockDraftPinRow: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(120px, 1fr) minmax(140px, 1.2fr) 104px',
    gap: 6,
    alignItems: 'center',
  },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
};

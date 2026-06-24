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
import type { CircuitComponent, CircuitModule, CircuitPosition } from '../../types';
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
  pointEndpoint,
  rerouteStoredWires,
  snapPoint,
  type EndpointHit,
  type SchematicSelection,
  type ToolComponentType,
} from '../../schematic/schematicDocument';

type ToolMode = 'select' | 'wire' | 'place';

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
  originalModule: CircuitModule;
  moved: boolean;
}

interface WireDragState {
  start: EndpointHit;
  startClient: CircuitPosition;
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
  const [history, setHistory] = useState<CircuitModule[]>([]);
  const [future, setFuture] = useState<CircuitModule[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);

  const document = useMemo(() => createSchematicDocument(draft, { autoLayout: false }), [draft]);
  const selectedComponent = selection?.kind === 'component'
    ? draft.components.find((component) => component.id === selection.id) ?? null
    : null;
  const wirePreview = hoverWorld
    ? hitEndpoint(document, hoverWorld) ?? pointEndpoint(snapPoint(hoverWorld))
    : null;

  useEffect(() => {
    setDraft(createSchematicDocument(module).module);
    setDirty(false);
    setSelection(null);
    setWireStart(null);
    setHoverWorld(null);
    setHistory([]);
    setFuture([]);
  }, [module.module_id, module.revision]);

  const commitDraft = useCallback((next: CircuitModule, previous = draft) => {
    setHistory((items) => [...items, cloneModule(previous)].slice(-40));
    setFuture([]);
    setDraft(next);
    setDirty(true);
  }, [draft]);

  function screenToWorld(event: ReactPointerEvent<SVGSVGElement>): CircuitPosition {
    const svg = event.currentTarget;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(matrix);
    return { x: transformed.x, y: transformed.y };
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    svgRef.current = event.currentTarget;
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
      wireDragRef.current = null;
      return;
    }

    const componentHit = hitComponent(document, world);
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
    const wireHit = hitWire(document, world);
    if (wireHit) {
      setSelection({ kind: 'wire', id: wireHit.id });
      return;
    }
    setSelection(null);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
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
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    setHistory((items) => [...items, drag.originalModule].slice(-40));
    setFuture([]);
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    dragRef.current = null;
    wireDragRef.current = null;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
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
      next.wires = (next.wires ?? []).filter((wire) => (
        wire.from?.component_id !== selection.id && wire.to?.component_id !== selection.id
      ));
    } else {
      next.wires = (next.wires ?? []).filter((wire) => wire.id !== selection.id);
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
    const normalized = normalizeConnectivity({ ...draft, wires: document.wires });
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
      data-wire-count={document.wires.length}
      data-component-positions={JSON.stringify(Object.fromEntries(
        draft.components.map((component) => [component.id, component.position]),
      ))}
      data-wire-points={JSON.stringify(document.wires.map((wire) => wire.points))}
      data-schematic-source="document"
      onKeyDown={handleKeyDown}
      tabIndex={0}
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
        <button style={styles.primaryButton} onClick={() => void saveAndRebuild()} disabled={busy || !dirty} data-testid="schematic-editor-save">
          Apply
        </button>
        <button style={styles.toolButton} onClick={onBuild} disabled={busy} data-testid="schematic-editor-rebuild-svg">
          Build netlistsvg
        </button>
        <span style={styles.statusText} data-testid="schematic-editor-status">
          {wireStart ? `Wire from ${wireStart.label}` : dirty ? 'Unsaved' : 'Saved'}
        </span>
      </div>

      <div style={styles.content}>
        <div style={styles.stage}>
          <SchematicDocumentSvg
            document={document}
            selection={selection}
            wireStart={wireStart}
            wirePreview={wirePreview}
            showGrid
            testId="schematic-editor-svg"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
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

import {
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Hammer,
  Maximize2,
  MousePointer2,
  Redo2,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { CircuitSymbolIcon, type CircuitSymbolKind } from '../../common/CircuitSymbolIcon';
import { IconButton } from '../../common/IconButton';
import { COMPONENT_TYPES, type ToolComponentType } from '../../../schematic/schematicDocument';
import './schematicToolbars.css';

const PALETTE_INSET = 12;

const COMPONENT_TOOL_LABELS: Record<ToolComponentType, string> = {
  R: 'Place resistor (R)',
  C: 'Place capacitor (C)',
  L: 'Place inductor (L)',
  D: 'Place diode (D)',
  M: 'Place MOSFET (M)',
  Q: 'Place BJT (Q)',
  V: 'Place voltage source (V)',
  I: 'Place current source (I)',
};

const COMPONENT_TOOL_ICONS: Record<ToolComponentType, CircuitSymbolKind> = {
  R: 'resistor',
  C: 'capacitor',
  L: 'inductor',
  D: 'diode',
  M: 'nmos',
  Q: 'npn',
  V: 'voltage-source',
  I: 'current-source',
};

interface EditorCommandToolbarProps {
  selectActive: boolean;
  wireActive: boolean;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  dirty: boolean;
  buildBusy: boolean;
  status: string;
  zoom: number;
  onSelect: () => void;
  onWire: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onSave: () => void;
  onFit: () => void;
  onBuild: () => void;
}

export function EditorCommandToolbar({
  selectActive,
  wireActive,
  disabled,
  canUndo,
  canRedo,
  hasSelection,
  dirty,
  buildBusy,
  status,
  zoom,
  onSelect,
  onWire,
  onUndo,
  onRedo,
  onDelete,
  onSave,
  onFit,
  onBuild,
}: EditorCommandToolbarProps) {
  return (
    <nav className="av-schematic-command-bar" aria-label="Schematic editing commands">
      <div className="av-schematic-command-bar__commands">
        <div className="av-schematic-command-group" role="group" aria-label="Interaction tools">
          <IconButton
            size="sm"
            label="Select tool (S)"
            icon={<MousePointer2 size={17} />}
            selected={selectActive}
            onClick={onSelect}
            disabled={disabled}
            data-testid="schematic-editor-select"
          />
          <IconButton
            size="sm"
            label="Wire tool (W)"
            icon={<CircuitSymbolIcon kind="wire" size={18} />}
            selected={wireActive}
            onClick={onWire}
            disabled={disabled}
            data-testid="schematic-editor-wire"
          />
        </div>

        <span className="av-schematic-command-divider" role="separator" aria-orientation="vertical" />

        <div className="av-schematic-command-group" role="group" aria-label="Edit history">
          <IconButton
            size="sm"
            label="Undo (Ctrl+Z)"
            icon={<Undo2 size={17} />}
            onClick={onUndo}
            disabled={disabled || !canUndo}
            data-testid="schematic-editor-undo"
          />
          <IconButton
            size="sm"
            label="Redo (Ctrl+Y)"
            icon={<Redo2 size={17} />}
            onClick={onRedo}
            disabled={disabled || !canRedo}
            data-testid="schematic-editor-redo"
          />
          <IconButton
            size="sm"
            label="Delete selected item (Delete/Backspace)"
            icon={<Trash2 size={17} />}
            variant="danger"
            onClick={onDelete}
            disabled={disabled || !hasSelection}
            data-testid="schematic-editor-delete"
          />
        </div>

        <span className="av-schematic-command-divider" role="separator" aria-orientation="vertical" />

        <div className="av-schematic-command-group" role="group" aria-label="Schematic actions">
          <IconButton
            size="sm"
            label="Apply schematic and rebuild SVG (Ctrl+S)"
            icon={<Check size={17} />}
            variant="primary"
            onClick={onSave}
            disabled={disabled || !dirty}
            data-testid="schematic-editor-save"
          />
          <IconButton
            size="sm"
            label="Fit schematic view (F)"
            icon={<Maximize2 size={17} />}
            onClick={onFit}
            disabled={disabled}
            data-testid="schematic-editor-fit"
          />
          <IconButton
            size="sm"
            label="Build netlistsvg preview"
            icon={<Hammer size={17} />}
            onClick={onBuild}
            disabled={disabled}
            busy={buildBusy}
            data-testid="schematic-editor-rebuild-svg"
          />
        </div>
      </div>

      <div className="av-schematic-command-bar__status" aria-live="polite">
        <span className="av-schematic-command-bar__status-text" data-testid="schematic-editor-status">
          {status}
        </span>
        <span className="av-schematic-command-bar__zoom" data-testid="schematic-editor-zoom">
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </nav>
  );
}

interface FloatingComponentPaletteProps {
  activeType: ToolComponentType | null;
  blockActive: boolean;
  disabled: boolean;
  onSelectType: (type: ToolComponentType) => void;
  onSelectBlock: () => void;
}

interface PalettePosition {
  x: number;
  y: number;
}

interface PaletteDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: PalettePosition;
}

export function FloatingComponentPalette({
  activeType,
  blockActive,
  disabled,
  onSelectType,
  onSelectBlock,
}: FloatingComponentPaletteProps) {
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<PaletteDrag | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<PalettePosition>({ x: PALETTE_INSET, y: PALETTE_INSET });

  const clampPosition = useCallback((candidate: PalettePosition): PalettePosition => {
    const palette = paletteRef.current;
    const stage = palette?.parentElement;
    if (!palette || !stage) return candidate;
    const maximumX = Math.max(PALETTE_INSET, stage.clientWidth - palette.offsetWidth - PALETTE_INSET);
    const maximumY = Math.max(PALETTE_INSET, stage.clientHeight - palette.offsetHeight - PALETTE_INSET);
    return {
      x: Math.min(maximumX, Math.max(PALETTE_INSET, candidate.x)),
      y: Math.min(maximumY, Math.max(PALETTE_INSET, candidate.y)),
    };
  }, []);

  useLayoutEffect(() => {
    const palette = paletteRef.current;
    const stage = palette?.parentElement;
    if (!palette || !stage) return undefined;
    const keepPaletteInBounds = () => setPosition((current) => clampPosition(current));
    keepPaletteInBounds();
    const observer = new ResizeObserver(keepPaletteInBounds);
    observer.observe(stage);
    observer.observe(palette);
    return () => observer.disconnect();
  }, [clampPosition, collapsed]);

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: position,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setPosition(clampPosition({
      x: drag.startPosition.x + event.clientX - drag.startClientX,
      y: drag.startPosition.y + event.clientY - drag.startClientY,
    }));
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      ref={paletteRef}
      className="av-schematic-component-palette"
      style={{ left: position.x, top: position.y }}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-testid="schematic-editor-component-palette"
      role="toolbar"
      aria-label="Component placement tools"
      aria-orientation="horizontal"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <IconButton
        className="av-schematic-component-palette__drag"
        size="sm"
        label="Move component tools"
        icon={<GripVertical size={16} />}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        tooltipSide="bottom"
        data-testid="schematic-editor-component-palette-drag"
      />

      {!collapsed ? (
        <div className="av-schematic-component-palette__tools" role="group" aria-label="Components">
          {COMPONENT_TYPES.map((type) => (
            <IconButton
              key={type}
              size="sm"
              label={COMPONENT_TOOL_LABELS[type]}
              icon={<CircuitSymbolIcon kind={COMPONENT_TOOL_ICONS[type]} size={20} />}
              selected={activeType === type}
              onClick={() => onSelectType(type)}
              disabled={disabled}
              tooltipSide="bottom"
              data-testid={`schematic-editor-place-${type}`}
            />
          ))}
          <span className="av-schematic-command-divider" role="separator" aria-orientation="vertical" />
          <IconButton
            size="sm"
            label="Place custom block (B)"
            icon={<CircuitSymbolIcon kind="block" size={20} />}
            selected={blockActive}
            onClick={onSelectBlock}
            disabled={disabled}
            tooltipSide="bottom"
            data-testid="schematic-editor-place-block"
          />
        </div>
      ) : null}

      <IconButton
        size="sm"
        label={collapsed ? 'Expand component tools' : 'Collapse component tools'}
        icon={collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        onClick={() => setCollapsed((current) => !current)}
        onPointerDown={(event) => event.stopPropagation()}
        tooltipSide="bottom"
        data-testid="schematic-editor-component-palette-toggle"
      />
    </div>
  );
}

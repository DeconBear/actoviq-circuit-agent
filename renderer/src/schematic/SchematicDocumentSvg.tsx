import type { MouseEventHandler, PointerEventHandler, Ref } from 'react';
import type { CircuitComponent, CircuitPosition, CircuitWire } from '../types';
import {
  componentBounds,
  isPmosComponent,
  isGroundPort,
  pinWorld,
  routePoints,
  SCHEMATIC_GRID,
  type EndpointHit,
  type SchematicDocument,
  type SchematicBounds,
  type SchematicNetLabel,
  type SchematicSelection,
} from './schematicDocument';

const WIRE_COLOR = '#17851f';
const SYMBOL_COLOR = '#a00012';
const LABEL_COLOR = '#0000cc';
const MUTED_LABEL_COLOR = '#334155';
const LABEL_HALO_COLOR = '#ffffff';
const LABEL_FONT = 'Arial, Helvetica, sans-serif';
const MONO_FONT = 'Consolas, monospace';
const NET_LABEL_FONT_SIZE = 16;
const COMPONENT_NAME_FONT_SIZE = 17;
const COMPONENT_VALUE_FONT_SIZE = 15;
const WIRE_STROKE = 3;
const SYMBOL_STROKE = 2.4;
const WIRE_SELECTION_COLOR = '#0ea5e9';
const COMPONENT_SELECTION_COLOR = '#f59e0b';

type PortSide = 'left' | 'right' | 'top' | 'bottom';

interface Props {
  document: SchematicDocument;
  selection?: SchematicSelection;
  wireStart?: EndpointHit | null;
  wirePreview?: EndpointHit | null;
  hoverEndpoint?: EndpointHit | null;
  marqueeBounds?: SchematicBounds | null;
  showGrid?: boolean;
  cursor?: CSSCursor;
  viewBoxOverride?: SchematicBounds;
  testId?: string;
  onPointerDown?: PointerEventHandler<SVGSVGElement>;
  onPointerMove?: PointerEventHandler<SVGSVGElement>;
  onPointerUp?: PointerEventHandler<SVGSVGElement>;
  onPointerCancel?: PointerEventHandler<SVGSVGElement>;
  onContextMenu?: MouseEventHandler<SVGSVGElement>;
  svgRef?: Ref<SVGSVGElement>;
}

export function SchematicDocumentSvg({
  document,
  selection = null,
  wireStart = null,
  wirePreview = null,
  hoverEndpoint = null,
  marqueeBounds = null,
  showGrid = false,
  cursor = 'default',
  viewBoxOverride,
  testId = 'schematic-document-svg',
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  svgRef,
}: Props) {
  const viewBox = viewBoxOverride ?? document.viewBox;
  const width = Math.max(1, viewBox.maxX - viewBox.minX);
  const height = Math.max(1, viewBox.maxY - viewBox.minY);
  const gridId = `grid-${document.moduleId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const majorGridId = `major-grid-${document.moduleId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const previewPoints = wireStart && wirePreview ? routePoints(wireStart, wirePreview) : [];
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      className="schematic-document-svg"
      viewBox={`${viewBox.minX} ${viewBox.minY} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block', background: '#ffffff', touchAction: 'none', userSelect: 'none', cursor }}
      data-testid={testId}
      data-schematic-source="document"
      data-module-id={document.moduleId}
      data-cursor-mode={cursor}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
    >
      <defs>
        <style>{`
          .schematic-document-svg line,
          .schematic-document-svg path,
          .schematic-document-svg rect,
          .schematic-document-svg polygon,
          .schematic-document-svg polyline,
          .schematic-document-svg circle {
            vector-effect: non-scaling-stroke;
          }
        `}</style>
        <pattern id={gridId} width={SCHEMATIC_GRID} height={SCHEMATIC_GRID} patternUnits="userSpaceOnUse">
          <path
            d={`M ${SCHEMATIC_GRID / 2} 0 L ${SCHEMATIC_GRID / 2} ${SCHEMATIC_GRID} M 0 ${SCHEMATIC_GRID / 2} L ${SCHEMATIC_GRID} ${SCHEMATIC_GRID / 2}`}
            fill="none"
            stroke="#f3f6fa"
            strokeWidth="1"
          />
          <path d={`M ${SCHEMATIC_GRID} 0 L 0 0 0 ${SCHEMATIC_GRID}`} fill="none" stroke="#e8eef5" strokeWidth="1" />
        </pattern>
        <pattern id={majorGridId} width={SCHEMATIC_GRID * 5} height={SCHEMATIC_GRID * 5} patternUnits="userSpaceOnUse">
          <path d={`M ${SCHEMATIC_GRID * 5} 0 L 0 0 0 ${SCHEMATIC_GRID * 5}`} fill="none" stroke="#d9e3ee" strokeWidth="1.25" />
        </pattern>
      </defs>
      {showGrid ? (
        <>
          <rect
            x={viewBox.minX}
            y={viewBox.minY}
            width={width}
            height={height}
            fill={`url(#${gridId})`}
            data-testid="schematic-grid-background"
          />
          <rect
            x={viewBox.minX}
            y={viewBox.minY}
            width={width}
            height={height}
            fill={`url(#${majorGridId})`}
            pointerEvents="none"
            data-testid="schematic-major-grid-background"
          />
        </>
      ) : null}
      <g data-layer="wires">
        {document.wires.map((wire) => (
          <WirePath key={wire.id} wire={wire} selected={selection?.kind === 'wire' && selection.id === wire.id} />
        ))}
        {previewPoints.length >= 2 ? (
          <polyline
            points={pointsAttribute(previewPoints)}
            fill="none"
            stroke="#2563eb"
            strokeWidth="4"
            strokeDasharray="9 7"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
            data-testid="schematic-wire-preview"
          />
        ) : null}
      </g>
      <g data-layer="net-labels">
        {document.netLabels.map((label) => (
          <NetLabelSymbol key={label.id} label={label} />
        ))}
      </g>
      <g data-layer="ports">
        {document.module.ports.map((port) => {
          const position = document.portPositions.get(port.id);
          if (!position) return null;
          const connected = document.connectedPortIds.has(port.id);
          if (!connected) return null;
          const isRailPort = isGroundPort(port) || port.signal_type === 'power';
          const hasLocalRailLabel = isRailPort && document.netLabels.some((label) => label.net === port.net);
          if (hasLocalRailLabel) return null;
          const portSide = portRenderSide(document, port, position);
          const labelPosition = portNamePosition(position, portSide);
          return (
            <g
              key={port.id}
              data-port-id={port.id}
              data-net={port.net}
              data-connected={connected ? 'true' : 'false'}
              data-port-side={portSide}
              opacity={connected ? 1 : 0.38}
            >
              {isGroundPort(port) ? (
                <GroundSymbol position={position} />
              ) : port.signal_type === 'power' ? (
                <PowerFlagSymbol position={position} />
              ) : (
                <PortSymbol position={position} side={portSide === 'right' ? 'right' : 'left'} />
              )}
              <EndpointCircle
                point={position}
                kind="port"
                id={port.id}
                label={port.name}
                net={port.net}
              />
              <text
                x={labelPosition.x}
                y={labelPosition.y}
                textAnchor={labelPosition.anchor}
                fontSize="14"
                fontFamily={LABEL_FONT}
                fontWeight="700"
                fill={LABEL_COLOR}
                stroke={LABEL_HALO_COLOR}
                strokeWidth="3"
                paintOrder="stroke"
              >
                {port.name}
              </text>
            </g>
          );
        })}
      </g>
      <g data-layer="components">
        {document.module.components.map((component) => (
          <ComponentSymbol
            key={component.id}
            component={component}
            selected={selectionHasComponent(selection, component.id)}
          />
        ))}
      </g>
      <g data-layer="junctions" pointerEvents="none">
        {junctions(document).map((point) => (
          <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r="4.6" fill="#cc0000" stroke="#ffffff" strokeWidth="1.2" />
        ))}
      </g>
      {wireStart ? (
        <circle
          cx={wireStart.x}
          cy={wireStart.y}
          r="7"
          fill="none"
          stroke="#2563eb"
          strokeWidth="2.5"
          strokeDasharray="6 5"
          pointerEvents="none"
        />
      ) : null}
      {marqueeBounds ? <MarqueeRect bounds={marqueeBounds} /> : null}
      {hoverEndpoint ? <EndpointHover endpoint={hoverEndpoint} /> : null}
    </svg>
  );
}

function selectionHasComponent(selection: SchematicSelection, componentId: string): boolean {
  if (selection?.kind === 'component') return selection.id === componentId;
  if (selection?.kind === 'components') return selection.ids.includes(componentId);
  return false;
}

function MarqueeRect({ bounds }: { bounds: SchematicBounds }) {
  return (
    <rect
      x={bounds.minX}
      y={bounds.minY}
      width={Math.max(1, bounds.maxX - bounds.minX)}
      height={Math.max(1, bounds.maxY - bounds.minY)}
      fill="rgba(37, 99, 235, 0.08)"
      stroke="#2563eb"
      strokeWidth="1.8"
      strokeDasharray="8 5"
      pointerEvents="none"
      data-testid="schematic-selection-marquee"
    />
  );
}

function NetLabelSymbol({ label }: { label: SchematicNetLabel }) {
  const { position } = label;
  const nameY = label.kind === 'power' ? position.y - 52 : position.y + 54;
  if (label.kind === 'signal') {
    return <SignalNetLabelSymbol label={label} />;
  }
  return (
    <g
      data-testid="schematic-net-label"
      data-net-label-id={label.id}
      data-net={label.net}
      data-kind={label.kind}
      pointerEvents="none"
    >
      {label.kind === 'ground' ? <GroundSymbol position={position} /> : <PowerFlagSymbol position={position} />}
      <text
        x={position.x}
        y={nameY}
        textAnchor="middle"
        fontSize={NET_LABEL_FONT_SIZE}
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        data-testid="schematic-net-label-text"
      >
        {label.name}
      </text>
    </g>
  );
}

function SignalNetLabelSymbol({ label }: { label: SchematicNetLabel }) {
  const { position } = label;
  const side = label.side ?? 'right';
  const stubLength = 34;
  const end = {
    x: position.x + (side === 'left' ? -stubLength : side === 'right' ? stubLength : 0),
    y: position.y + (side === 'top' ? -stubLength : side === 'bottom' ? stubLength : 0),
  };
  const text = signalLabelTextPosition(end, side);
  return (
    <g
      data-testid="schematic-net-label"
      data-net-label-id={label.id}
      data-net={label.net}
      data-kind={label.kind}
      pointerEvents="none"
    >
      <line
        x1={position.x}
        y1={position.y}
        x2={end.x}
        y2={end.y}
        stroke={WIRE_COLOR}
        strokeWidth={WIRE_STROKE}
      />
      <circle cx={position.x} cy={position.y} r="3.8" fill="#9aa3ad" stroke="#ffffff" strokeWidth="1" />
      <text
        x={text.x}
        y={text.y}
        textAnchor={text.anchor}
        fontSize={NET_LABEL_FONT_SIZE}
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        data-testid="schematic-net-label-text"
      >
        {label.name}
      </text>
    </g>
  );
}

function signalLabelTextPosition(
  end: CircuitPosition,
  side: NonNullable<SchematicNetLabel['side']>,
): CircuitPosition & { anchor: TextAnchor } {
  if (side === 'left') return { x: end.x - 6, y: end.y + 4, anchor: 'end' };
  if (side === 'right') return { x: end.x + 6, y: end.y + 4, anchor: 'start' };
  if (side === 'top') return { x: end.x, y: end.y - 8, anchor: 'middle' };
  return { x: end.x, y: end.y + 18, anchor: 'middle' };
}

type CSSCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'copy' | 'move';

function WirePath({ wire, selected }: { wire: CircuitWire; selected: boolean }) {
  const points = pointsAttribute(wire.points ?? []);
  if (!points) return null;
  return (
    <g data-wire-id={wire.id} data-wire-source={wire.source ?? ''} data-net={wire.net ?? ''}>
      <polyline
        points={points}
        fill="none"
        stroke="transparent"
        strokeWidth="16"
        strokeLinecap="round"
        strokeLinejoin="round"
        data-wire-hitbox="true"
      />
      <polyline
        points={points}
        fill="none"
        stroke={selected ? WIRE_SELECTION_COLOR : 'transparent'}
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={selected ? 0.42 : 0}
        pointerEvents="none"
        data-testid={selected ? 'schematic-selected-wire-highlight' : undefined}
        data-selection-kind={selected ? 'wire' : undefined}
        data-selection-shape={selected ? 'route' : undefined}
      />
      <polyline
        points={points}
        fill="none"
        stroke={WIRE_COLOR}
        strokeWidth={WIRE_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
      {selected ? <WirePointHandles wire={wire} /> : null}
    </g>
  );
}

function WirePointHandles({ wire }: { wire: CircuitWire }) {
  const points = wire.points ?? [];
  return (
    <g data-testid="schematic-wire-point-handles" pointerEvents="none">
      {points.map((point, index) => {
        const endpoint = index === 0 || index === points.length - 1;
        return (
          <circle
            key={`${wire.id}-${index}-${point.x},${point.y}`}
            cx={point.x}
            cy={point.y}
            r={endpoint ? 5.2 : 4.8}
            fill={endpoint ? '#ffffff' : WIRE_SELECTION_COLOR}
            stroke={WIRE_SELECTION_COLOR}
            strokeWidth="1.8"
            data-testid="schematic-wire-point-handle"
            data-wire-id={wire.id}
            data-point-index={index}
            data-selection-kind="wire"
            data-selection-handle-shape="circle"
          />
        );
      })}
    </g>
  );
}

function ComponentSymbol({ component, selected }: { component: CircuitComponent; selected: boolean }) {
  const bounds = componentBounds(component);
  const pins = component.pins.map((pin, index) => ({ pin, point: pinWorld(component, pin, index) }));
  const labels = componentLabelPositions(component);
  return (
    <g data-component-id={component.id} data-component-type={component.type}>
      {selected ? <ComponentSelectionHandles bounds={bounds} /> : null}
      <LeadLines component={component} />
      <SymbolBody component={component} />
      {pins.map(({ pin, point }) => (
        <EndpointCircle
          key={pin.id}
          point={point}
          kind="pin"
          id={`${component.id}:${pin.id}`}
          label={`${component.name}.${pin.name}`}
          net={pin.net}
          componentId={component.id}
          pinId={pin.id}
          visible={selected}
        />
      ))}
      <text
        x={labels.name.x}
        y={labels.name.y}
        textAnchor={labels.name.anchor}
        fontSize={COMPONENT_NAME_FONT_SIZE}
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        pointerEvents="none"
        data-testid="schematic-component-name-label"
      >
        {component.name}
      </text>
      <text
        x={labels.value.x}
        y={labels.value.y}
        textAnchor={labels.value.anchor}
        fontSize={COMPONENT_VALUE_FONT_SIZE}
        fontFamily={LABEL_FONT}
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        pointerEvents="none"
        data-testid="schematic-component-value-label"
      >
        {component.value}
      </text>
    </g>
  );
}

function ComponentSelectionHandles({ bounds }: { bounds: ReturnType<typeof componentBounds> }) {
  const inset = 6;
  const size = 8;
  const corners = [
    { x: bounds.minX - inset, y: bounds.minY - inset },
    { x: bounds.maxX + inset, y: bounds.minY - inset },
    { x: bounds.maxX + inset, y: bounds.maxY + inset },
    { x: bounds.minX - inset, y: bounds.maxY + inset },
  ];
  return (
    <g data-testid="schematic-selected-component-handles" pointerEvents="none">
      <rect
        x={bounds.minX - inset}
        y={bounds.minY - inset}
        width={bounds.maxX - bounds.minX + inset * 2}
        height={bounds.maxY - bounds.minY + inset * 2}
        fill="#f59e0b"
        fillOpacity="0.07"
        stroke={COMPONENT_SELECTION_COLOR}
        strokeWidth="1.8"
        strokeDasharray="8 6"
        pointerEvents="none"
        data-testid="schematic-selected-component-frame"
        data-selection-kind="component"
        data-selection-shape="frame"
      />
      {corners.map((corner) => (
        <rect
          key={`${corner.x},${corner.y}`}
          x={corner.x - size / 2}
          y={corner.y - size / 2}
          width={size}
          height={size}
          rx="1.5"
          fill="#ffffff"
          stroke={COMPONENT_SELECTION_COLOR}
          strokeWidth="1.6"
          pointerEvents="all"
          data-testid="schematic-selected-component-corner"
          data-selection-kind="component"
          data-selection-handle-shape="square"
        />
      ))}
    </g>
  );
}

type TextAnchor = 'start' | 'middle' | 'end';

function portNamePosition(position: CircuitPosition, side: PortSide): CircuitPosition & { anchor: TextAnchor } {
  if (side === 'right') {
    return { x: position.x + 50, y: position.y - 4, anchor: 'start' };
  }
  if (side === 'left') {
    return { x: position.x - 50, y: position.y - 4, anchor: 'end' };
  }
  if (side === 'top') {
    return { x: position.x, y: position.y - 54, anchor: 'middle' };
  }
  return { x: position.x + 12, y: position.y + 38, anchor: 'start' };
}

function componentLabelPositions(component: CircuitComponent): {
  name: CircuitPosition & { anchor: TextAnchor };
  value: CircuitPosition & { anchor: TextAnchor };
} {
  const { x, y } = component.position;
  const rotation = ((component.rotation ?? 0) % 360 + 360) % 360;
  const isVerticalTwoPin = component.pins.length === 2 && (rotation === 90 || rotation === 270);
  if (isVerticalTwoPin) {
    return {
      name: { x: x + 46, y: y - 22, anchor: 'start' },
      value: { x: x + 46, y: y + 24, anchor: 'start' },
    };
  }
  const isActive = component.type === 'M' || component.type === 'Q';
  if (component.type === 'Q') {
    return {
      name: { x: x + 52, y: y - 52, anchor: 'start' },
      value: { x: x + 52, y: y + 58, anchor: 'start' },
    };
  }
  return {
    name: { x, y: y - (isActive ? 68 : 42), anchor: 'middle' },
    value: { x, y: y + (isActive ? 74 : 44), anchor: 'middle' },
  };
}

function LeadLines({ component }: { component: CircuitComponent }) {
  if (component.pins.length !== 2) return null;
  const bodyOffsets = bodyTerminalOffsets(component);
  return (
    <g stroke={SYMBOL_COLOR} strokeWidth="2" pointerEvents="none">
      {component.pins.map((pin, index) => {
        const point = pinWorld(component, pin, index);
        const offset = bodyOffsets[index];
        if (!offset) return null;
        return (
          <line
            key={`lead-${pin.id}`}
            x1={point.x}
            y1={point.y}
            x2={component.position.x + offset.x}
            y2={component.position.y + offset.y}
          />
        );
      })}
    </g>
  );
}

function SymbolBody({ component }: { component: CircuitComponent }) {
  const { x, y } = component.position;
  const rotation = component.rotation ?? 0;
  if (component.type === 'R') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} pointerEvents="none">
        <rect x={x - 29} y={y - 10} width="58" height="20" rx="2" fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      </g>
    );
  }
  if (component.type === 'C') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} pointerEvents="none">
        <line x1={x - 8} y1={y - 30} x2={x - 8} y2={y + 30} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
        <line x1={x + 8} y1={y - 30} x2={x + 8} y2={y + 30} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      </g>
    );
  }
  if (component.type === 'L') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.4" pointerEvents="none">
        <path d={`M ${x - 32} ${y} A 8 8 0 0 1 ${x - 16} ${y} A 8 8 0 0 1 ${x} ${y} A 8 8 0 0 1 ${x + 16} ${y} A 8 8 0 0 1 ${x + 32} ${y}`} />
      </g>
    );
  }
  if (component.type === 'D') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.4" pointerEvents="none">
        <path d={`M ${x - 22} ${y - 24} L ${x - 22} ${y + 24} L ${x + 20} ${y} Z`} />
        <line x1={x + 22} y1={y - 25} x2={x + 22} y2={y + 25} />
      </g>
    );
  }
  if (component.type === 'M') {
    const pmos = isPmosComponent(component);
    const gateX = x - 20;
    const channelX = x + 12;
    return (
      <g
        transform={`rotate(${rotation} ${x} ${y})`}
        fill="none"
        stroke={SYMBOL_COLOR}
        strokeWidth={SYMBOL_STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
        pointerEvents="none"
      >
        <line x1={gateX} y1={y - 34} x2={gateX} y2={y + 34} />
        <line x1={channelX} y1={y - 38} x2={channelX} y2={y + 38} />
        <line x1={x - 58} y1={y} x2={pmos ? x - 31 : gateX} y2={y} />
        {pmos ? <circle cx={x - 26} cy={y} r="5" fill="#fff" /> : null}
        <line x1={channelX} y1={y - 30} x2={x + 26} y2={y - 52} />
        <line x1={channelX} y1={y + 30} x2={x + 26} y2={y + 52} />
        <line x1={channelX} y1={y} x2={x + 58} y2={y} />
        <path
          d={pmos
            ? `M ${x + 21} ${y - 19} l 10 -5 l -3 10 z`
            : `M ${x + 32} ${y + 24} l -10 5 l 3 -10 z`}
          fill={SYMBOL_COLOR}
          stroke="none"
        />
      </g>
    );
  }
  if (component.type === 'Q') {
    const pnp = isPnpComponent(component);
    return (
      <g
        transform={`rotate(${rotation} ${x} ${y})`}
        fill="none"
        stroke={SYMBOL_COLOR}
        strokeWidth={SYMBOL_STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
        pointerEvents="none"
      >
        <line x1={x - 18} y1={y - 34} x2={x - 18} y2={y + 34} />
        <line x1={x - 58} y1={y} x2={x - 18} y2={y} />
        <line x1={x - 18} y1={y - 20} x2={x + 30} y2={y - 52} />
        <line x1={x - 18} y1={y + 20} x2={x + 30} y2={y + 52} />
        <path
          d={pnp
            ? `M ${x + 4} ${y + 34} L ${x + 20} ${y + 39} L ${x + 9} ${y + 51} Z`
            : `M ${x + 31} ${y + 52} L ${x + 14} ${y + 48} L ${x + 24} ${y + 36} Z`}
          fill={SYMBOL_COLOR}
          stroke="none"
        />
      </g>
    );
  }
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r="28" fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      {component.type === 'V' ? (
        <>
          <text x={x} y={y + 6} textAnchor="middle" fontSize="20" fontFamily={LABEL_FONT} fontWeight="700" fill="#0f172a">V</text>
          <text x={x - 18} y={y - 16} textAnchor="middle" fontSize="13" fontFamily={LABEL_FONT} fontWeight="700" fill={SYMBOL_COLOR}>+</text>
          <text x={x - 18} y={y + 24} textAnchor="middle" fontSize="15" fontFamily={LABEL_FONT} fontWeight="700" fill={SYMBOL_COLOR}>-</text>
        </>
      ) : component.type === 'I' ? (
        <>
          <line x1={x} y1={y + 16} x2={x} y2={y - 13} stroke={SYMBOL_COLOR} strokeWidth="2.2" />
          <path d={`M ${x - 7} ${y - 6} L ${x} ${y - 17} L ${x + 7} ${y - 6}`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.2" />
        </>
      ) : (
        <text x={x} y={y + 4} textAnchor="middle" fontSize="15" fontFamily={LABEL_FONT} fontWeight="700">
          {component.type}
        </text>
      )}
    </g>
  );
}

function isPnpComponent(component: CircuitComponent): boolean {
  return /\bpnp\b|p-bipolar|p bipolar/i.test(`${component.id} ${component.name} ${component.value}`);
}

function bodyTerminalOffsets(component: CircuitComponent): [CircuitPosition, CircuitPosition] {
  let span = 28;
  if (component.type === 'C') span = 8;
  if (component.type === 'D') span = 22;
  if (component.type === 'L') span = 36;
  if (component.type === 'V' || component.type === 'I') span = 28;
  return [
    rotateOffset({ x: -span, y: 0 }, component.rotation ?? 0),
    rotateOffset({ x: span, y: 0 }, component.rotation ?? 0),
  ];
}

function rotateOffset(offset: CircuitPosition, rotation: number): CircuitPosition {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90) return { x: -offset.y, y: offset.x };
  if (normalized === 180) return { x: -offset.x, y: -offset.y };
  if (normalized === 270) return { x: offset.y, y: -offset.x };
  return offset;
}

function EndpointHover({ endpoint }: { endpoint: EndpointHit }) {
  return (
    <g pointerEvents="none" data-testid="schematic-hover-endpoint" data-label={endpoint.label} data-net={endpoint.net ?? ''}>
      <circle cx={endpoint.x} cy={endpoint.y} r="10" fill="rgba(37, 99, 235, 0.10)" stroke="#2563eb" strokeWidth="2" />
      <circle cx={endpoint.x} cy={endpoint.y} r="4" fill="#2563eb" />
      <text
        x={endpoint.x + 12}
        y={endpoint.y - 12}
        fontSize="11"
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        data-testid="schematic-hover-endpoint-label"
      >
        {endpoint.label}
      </text>
      {endpoint.net ? (
        <text
          x={endpoint.x + 12}
          y={endpoint.y + 3}
          fontSize="9"
          fontFamily={MONO_FONT}
          fill={MUTED_LABEL_COLOR}
          stroke={LABEL_HALO_COLOR}
          strokeWidth="2.5"
          paintOrder="stroke"
          data-testid="schematic-hover-endpoint-net"
        >
          {endpoint.net}
        </text>
      ) : null}
    </g>
  );
}

function EndpointCircle({
  point,
  kind,
  id,
  label,
  net,
  componentId,
  pinId,
  visible,
}: {
  point: CircuitPosition;
  kind: 'pin' | 'port';
  id: string;
  label: string;
  net: string;
  componentId?: string;
  pinId?: string;
  visible?: boolean;
}) {
  const pin = kind === 'pin';
  const show = !pin || visible;
  return (
    <circle
      cx={point.x}
      cy={point.y}
      r={pin ? (show ? 3.2 : 5.5) : 3.6}
      fill={pin ? (show ? '#cc0000' : 'transparent') : '#7b8490'}
      stroke={show ? '#ffffff' : 'none'}
      strokeWidth={show ? '1.2' : '0'}
      opacity={show ? (pin ? 0.9 : 0.82) : 0}
      data-endpoint-kind={kind}
      data-endpoint-id={id}
      data-component-id={componentId}
      data-pin-id={pinId}
      data-label={label}
      data-net={net}
      data-visible={show ? 'true' : 'false'}
    />
  );
}

function PortSymbol({ position, side }: { position: CircuitPosition; side: 'left' | 'right' }) {
  const points = side === 'left'
    ? [
        `${position.x} ${position.y}`,
        `${position.x - 24} ${position.y - 18}`,
        `${position.x - 42} ${position.y - 18}`,
        `${position.x - 42} ${position.y + 18}`,
        `${position.x - 24} ${position.y + 18}`,
      ]
    : [
        `${position.x} ${position.y - 18}`,
        `${position.x + 24} ${position.y - 18}`,
        `${position.x + 42} ${position.y}`,
        `${position.x + 24} ${position.y + 18}`,
        `${position.x} ${position.y + 18}`,
      ];
  return <polygon points={points.join(' ')} fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2" pointerEvents="none" />;
}

function portRenderSide(document: SchematicDocument, port: SchematicDocument['module']['ports'][number], position: CircuitPosition): PortSide {
  if (isGroundPort(port)) return 'bottom';
  if (port.signal_type === 'power') return 'top';
  if (port.direction === 'output') return 'right';
  const pinPoints = document.module.components.flatMap((component) => (
    component.pins
      .flatMap((pin, index) => (pin.net === port.net ? [pinWorld(component, pin, index)] : []))
  ));
  if (pinPoints.length === 0) return 'left';
  const first = pinPoints[0];
  if (!first) return 'left';
  const nearest = pinPoints.slice(1).reduce((best, point) => (
    distanceSquared(position, point) < distanceSquared(position, best) ? point : best
  ), first);
  const dx = position.x - nearest.x;
  const dy = position.y - nearest.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function distanceSquared(left: CircuitPosition, right: CircuitPosition): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function PowerFlagSymbol({ position }: { position: CircuitPosition }) {
  return (
    <g fill="none" pointerEvents="none">
      <line x1={position.x} y1={position.y} x2={position.x} y2={position.y - 34} stroke={WIRE_COLOR} strokeWidth="2.4" />
      <line x1={position.x - 18} y1={position.y - 34} x2={position.x + 18} y2={position.y - 34} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      <line x1={position.x} y1={position.y - 34} x2={position.x} y2={position.y - 46} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
    </g>
  );
}

function GroundSymbol({ position }: { position: CircuitPosition }) {
  return (
    <g stroke={SYMBOL_COLOR} strokeWidth="2" fill="none" pointerEvents="none">
      <line x1={position.x} y1={position.y} x2={position.x} y2={position.y + 22} />
      <line x1={position.x - 20} y1={position.y + 22} x2={position.x + 20} y2={position.y + 22} />
      <line x1={position.x - 13} y1={position.y + 30} x2={position.x + 13} y2={position.y + 30} />
      <line x1={position.x - 6} y1={position.y + 38} x2={position.x + 6} y2={position.y + 38} />
    </g>
  );
}

function pointsAttribute(points: CircuitPosition[]): string {
  return points.map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function junctions(document: SchematicDocument): CircuitPosition[] {
  const counts = new Map<string, { point: CircuitPosition; count: number }>();
  for (const wire of document.wires) {
    for (const point of wire.points ?? []) {
      const key = `${round(point.x)},${round(point.y)}`;
      const current = counts.get(key);
      counts.set(key, { point, count: (current?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].filter((entry) => entry.count > 2).map((entry) => entry.point);
}

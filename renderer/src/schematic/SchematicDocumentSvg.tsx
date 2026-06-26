import type { PointerEventHandler } from 'react';
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
  type SchematicSelection,
} from './schematicDocument';

const WIRE_COLOR = '#17851f';
const SYMBOL_COLOR = '#a00012';
const LABEL_COLOR = '#0000cc';
const MUTED_LABEL_COLOR = '#334155';
const LABEL_HALO_COLOR = '#ffffff';

interface Props {
  document: SchematicDocument;
  selection?: SchematicSelection;
  wireStart?: EndpointHit | null;
  wirePreview?: EndpointHit | null;
  hoverEndpoint?: EndpointHit | null;
  showGrid?: boolean;
  cursor?: CSSCursor;
  testId?: string;
  onPointerDown?: PointerEventHandler<SVGSVGElement>;
  onPointerMove?: PointerEventHandler<SVGSVGElement>;
  onPointerUp?: PointerEventHandler<SVGSVGElement>;
  onPointerCancel?: PointerEventHandler<SVGSVGElement>;
}

export function SchematicDocumentSvg({
  document,
  selection = null,
  wireStart = null,
  wirePreview = null,
  hoverEndpoint = null,
  showGrid = false,
  cursor = 'default',
  testId = 'schematic-document-svg',
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: Props) {
  const viewBox = document.viewBox;
  const width = Math.max(1, viewBox.maxX - viewBox.minX);
  const height = Math.max(1, viewBox.maxY - viewBox.minY);
  const gridId = `grid-${document.moduleId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const previewPoints = wireStart && wirePreview ? routePoints(wireStart, wirePreview) : [];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${viewBox.minX} ${viewBox.minY} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block', background: '#ffffff', touchAction: 'none', cursor }}
      data-testid={testId}
      data-schematic-source="document"
      data-module-id={document.moduleId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <defs>
        <pattern id={gridId} width={SCHEMATIC_GRID} height={SCHEMATIC_GRID} patternUnits="userSpaceOnUse">
          <path
            d={`M ${SCHEMATIC_GRID / 2} 0 L ${SCHEMATIC_GRID / 2} ${SCHEMATIC_GRID} M 0 ${SCHEMATIC_GRID / 2} L ${SCHEMATIC_GRID} ${SCHEMATIC_GRID / 2}`}
            fill="none"
            stroke="#f2f5f8"
            strokeWidth="1"
          />
          <path d={`M ${SCHEMATIC_GRID} 0 L 0 0 0 ${SCHEMATIC_GRID}`} fill="none" stroke="#e4ebf2" strokeWidth="1" />
        </pattern>
      </defs>
      {showGrid ? (
        <rect x={viewBox.minX} y={viewBox.minY} width={width} height={height} fill={`url(#${gridId})`} />
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
      <g data-layer="ports">
        {document.module.ports.map((port) => {
          const position = document.portPositions.get(port.id);
          if (!position) return null;
          const connected = document.connectedPortIds.has(port.id);
          if (!connected) return null;
          const portKind = isGroundPort(port) ? 'ground' : port.signal_type === 'power' ? 'power' : port.direction === 'output' ? 'output' : 'input';
          const labelPosition = portLabelPositions(position, portKind);
          return (
            <g
              key={port.id}
              data-port-id={port.id}
              data-net={port.net}
              data-connected={connected ? 'true' : 'false'}
              opacity={connected ? 1 : 0.38}
            >
              {isGroundPort(port) ? (
                <GroundSymbol position={position} />
              ) : port.signal_type === 'power' ? (
                <PowerFlagSymbol position={position} />
              ) : (
                <PortSymbol position={position} direction={port.direction === 'output' ? 'output' : 'input'} />
              )}
              <EndpointCircle
                point={position}
                kind="port"
                id={port.id}
                label={port.name}
                net={port.net}
              />
              <text
                x={labelPosition.name.x}
                y={labelPosition.name.y}
                textAnchor={labelPosition.name.anchor}
                fontSize="12"
                fontFamily="Consolas, monospace"
                fontWeight="700"
                fill={LABEL_COLOR}
                stroke={LABEL_HALO_COLOR}
                strokeWidth="3"
                paintOrder="stroke"
              >
                {port.name}
              </text>
              <text
                x={labelPosition.net.x}
                y={labelPosition.net.y}
                textAnchor={labelPosition.net.anchor}
                fontSize="9"
                fontFamily="Consolas, monospace"
                fill={MUTED_LABEL_COLOR}
                stroke={LABEL_HALO_COLOR}
                strokeWidth="2.5"
                paintOrder="stroke"
              >
                {port.net}
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
            selected={selection?.kind === 'component' && selection.id === component.id}
          />
        ))}
      </g>
      <g data-layer="junctions" pointerEvents="none">
        {junctions(document).map((point) => (
          <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r="3.8" fill="#cc0000" stroke="#ffffff" strokeWidth="1" />
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
      {hoverEndpoint ? <EndpointHover endpoint={hoverEndpoint} /> : null}
    </svg>
  );
}

type CSSCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'copy' | 'move';

function WirePath({ wire, selected }: { wire: CircuitWire; selected: boolean }) {
  const points = pointsAttribute(wire.points ?? []);
  if (!points) return null;
  return (
    <g data-wire-id={wire.id} data-net={wire.net ?? ''}>
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
        stroke={selected ? '#2563eb' : 'transparent'}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={selected ? 0.28 : 0}
        pointerEvents="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke={WIRE_COLOR}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
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
        fontSize="13"
        fontFamily="Consolas, monospace"
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        pointerEvents="none"
      >
        {component.name}
      </text>
      <text
        x={labels.value.x}
        y={labels.value.y}
        textAnchor={labels.value.anchor}
        fontSize="12"
        fontFamily="Consolas, monospace"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        pointerEvents="none"
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
      {corners.map((corner) => (
        <rect
          key={`${corner.x},${corner.y}`}
          x={corner.x - size / 2}
          y={corner.y - size / 2}
          width={size}
          height={size}
          rx="1.5"
          fill="#ffffff"
          stroke="#2563eb"
          strokeWidth="1.6"
        />
      ))}
    </g>
  );
}

type TextAnchor = 'start' | 'middle' | 'end';

function portLabelPositions(position: CircuitPosition, direction: 'input' | 'output' | 'ground' | 'power'): {
  name: CircuitPosition & { anchor: TextAnchor };
  net: CircuitPosition & { anchor: TextAnchor };
} {
  if (direction === 'output') {
    return {
      name: { x: position.x + 50, y: position.y - 12, anchor: 'start' },
      net: { x: position.x + 50, y: position.y + 14, anchor: 'start' },
    };
  }
  if (direction === 'input') {
    return {
      name: { x: position.x - 50, y: position.y - 22, anchor: 'start' },
      net: { x: position.x - 50, y: position.y + 4, anchor: 'start' },
    };
  }
  if (direction === 'power') {
    return {
      name: { x: position.x, y: position.y - 54, anchor: 'middle' },
      net: { x: position.x + 12, y: position.y + 16, anchor: 'start' },
    };
  }
  return {
    name: { x: position.x + 12, y: position.y - 12, anchor: 'start' },
    net: { x: position.x + 12, y: position.y + 14, anchor: 'start' },
  };
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
      <g fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.4" pointerEvents="none">
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
    return (
      <g fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.4" pointerEvents="none">
        <line x1={x - 18} y1={y - 34} x2={x - 18} y2={y + 34} />
        <line x1={x - 58} y1={y} x2={x - 18} y2={y} />
        <line x1={x - 18} y1={y - 20} x2={x + 30} y2={y - 52} />
        <line x1={x - 18} y1={y + 20} x2={x + 30} y2={y + 52} />
      </g>
    );
  }
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r="28" fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      {component.type === 'V' ? (
        <>
          <text x={x} y={y - 7} textAnchor="middle" fontSize="16" fontFamily="Consolas, monospace" fontWeight="700">+</text>
          <text x={x} y={y + 16} textAnchor="middle" fontSize="18" fontFamily="Consolas, monospace" fontWeight="700">-</text>
        </>
      ) : component.type === 'I' ? (
        <>
          <line x1={x} y1={y + 16} x2={x} y2={y - 13} stroke={SYMBOL_COLOR} strokeWidth="2.2" />
          <path d={`M ${x - 7} ${y - 6} L ${x} ${y - 17} L ${x + 7} ${y - 6}`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.2" />
        </>
      ) : (
        <text x={x} y={y + 4} textAnchor="middle" fontSize="15" fontFamily="Consolas, monospace" fontWeight="700">
          {component.type}
        </text>
      )}
    </g>
  );
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

function PortSymbol({ position, direction }: { position: CircuitPosition; direction: 'input' | 'output' }) {
  const points = direction === 'input'
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

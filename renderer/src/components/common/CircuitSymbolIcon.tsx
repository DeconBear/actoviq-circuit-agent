import { useId, type SVGProps } from 'react';

export type CircuitSymbolKind =
  | 'wire'
  | 'junction'
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'nmos'
  | 'pmos'
  | 'npn'
  | 'pnp'
  | 'opamp'
  | 'switch'
  | 'voltage-source'
  | 'current-source'
  | 'ground'
  | 'port-in'
  | 'port-out'
  | 'block';

export interface CircuitSymbolIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  kind: CircuitSymbolKind;
  size?: number;
  title?: string;
}

type CircuitFamily = 'wire' | 'passive' | 'active' | 'source' | 'ground' | 'port';

function circuitFamily(kind: CircuitSymbolKind): CircuitFamily {
  if (kind === 'wire' || kind === 'junction') return 'wire';
  if (kind === 'resistor' || kind === 'capacitor' || kind === 'inductor' || kind === 'diode') return 'passive';
  if (kind === 'voltage-source' || kind === 'current-source') return 'source';
  if (kind === 'ground') return 'ground';
  if (kind === 'port-in' || kind === 'port-out') return 'port';
  return 'active';
}

function SymbolPaths({ kind }: { kind: CircuitSymbolKind }) {
  switch (kind) {
    case 'wire':
      return <path d="M3 17 9 11h12" />;
    case 'junction':
      return <><path d="M3 12h18M12 3v18" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></>;
    case 'resistor':
      return <path d="M2 12h3l1.5-4 3 8 3-8 3 8 2-4H22" />;
    case 'capacitor':
      return <><path d="M2 12h7M9 5v14M15 5v14M15 12h7" /></>;
    case 'inductor':
      return <path d="M2 12h3c0-5 4-5 4 0 0-5 4-5 4 0 0-5 4-5 4 0h5" />;
    case 'diode':
      return <><path d="M2 12h6M16 12h6M8 6v12l8-6-8-6ZM16 6v12" /></>;
    case 'led':
      return <><path d="M2 13h5M15 13h7M7 7v12l8-6-8-6ZM15 7v12M14 5l3-3M17 6l3-3" /><path d="m16 2 1 .1-.1 1M19 3l1 .1-.1 1" /></>;
    case 'nmos':
    case 'pmos':
      return <>
        <path d="M3 12h5M8 6v12M12 7v10M12 8h5v-5M12 16h5v5M17 8v8" />
        {kind === 'pmos' ? <circle cx="10" cy="12" r="1.7" /> : null}
        <path d={kind === 'nmos' ? 'm17 12-3-2v4l3-2Z' : 'm14 12 3-2v4l-3-2Z'} fill="currentColor" />
      </>;
    case 'npn':
    case 'pnp':
      return <>
        <path d="M3 12h6M9 6v12M9 9l7-5h4M9 15l7 5h4" />
        <path d={kind === 'npn' ? 'm16 20-1-4 4 1-3 3Z' : 'm11 14 4 1-2 3-2-4Z'} fill="currentColor" />
      </>;
    case 'opamp':
      return <><path d="M5 4v16l14-8L5 4ZM2 8h3M2 16h3M19 12h3" /><path d="M6.5 8h3M8 6.5v3M6.5 16h3" /></>;
    case 'switch':
      return <><path d="M2 15h5l9-7M17 15h5" /><circle cx="7" cy="15" r="1.5" /><circle cx="17" cy="15" r="1.5" /></>;
    case 'voltage-source':
      return <><path d="M2 12h4M18 12h4" /><circle cx="12" cy="12" r="6" /><path d="M12 7v4M10 9h4M10 15h4" /></>;
    case 'current-source':
      return <><path d="M2 12h4M18 12h4" /><circle cx="12" cy="12" r="6" /><path d="M9 12h6m-3-3 3 3-3 3" /></>;
    case 'ground':
      return <><path d="M12 3v8M5 11h14M7.5 15h9M10 19h4" /></>;
    case 'port-in':
      return <><path d="M2 12h5M7 7h7l5 5-5 5H7V7Z" /><path d="m10 12 3-2v4l-3-2Z" fill="currentColor" /></>;
    case 'port-out':
      return <><path d="M22 12h-5M17 7h-7l-5 5 5 5h7V7Z" /><path d="m14 12-3-2v4l3-2Z" fill="currentColor" /></>;
    case 'block':
      return <><rect x="5" y="4" width="14" height="16" rx="1.5" /><path d="M2 8h3M2 16h3M19 8h3M19 16h3" /></>;
  }
}

export function CircuitSymbolIcon({
  kind,
  size = 20,
  title,
  className,
  strokeWidth = 1.65,
  ...svgProps
}: CircuitSymbolIconProps) {
  const titleId = useId();
  const classes = ['av-circuit-icon', className].filter(Boolean).join(' ');

  return (
    <svg
      {...svgProps}
      className={classes}
      data-family={circuitFamily(kind)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      <SymbolPaths kind={kind} />
    </svg>
  );
}


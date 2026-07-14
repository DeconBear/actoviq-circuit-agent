import { useId, type ReactNode } from 'react';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  children: ReactNode;
  content: ReactNode;
  side?: TooltipSide;
  shortcut?: string;
  className?: string;
}

export function Tooltip({
  children,
  content,
  side = 'bottom',
  shortcut,
  className,
}: TooltipProps) {
  const tooltipId = useId();
  const classes = ['av-tooltip', className].filter(Boolean).join(' ');

  return (
    <span className={classes}>
      {children}
      <span id={tooltipId} role="tooltip" className="av-tooltip__content" data-side={side}>
        {content}
        {shortcut ? <span className="av-tooltip__shortcut">{shortcut}</span> : null}
      </span>
    </span>
  );
}


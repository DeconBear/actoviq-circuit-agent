import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { LoaderCircle } from 'lucide-react';
import { Tooltip, type TooltipSide } from './Tooltip';

export type IconButtonVariant = 'ghost' | 'outline' | 'primary' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  selected?: boolean;
  busy?: boolean;
  showLabel?: boolean;
  badge?: ReactNode;
  shortcut?: string;
  tooltipSide?: TooltipSide;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    selected = false,
    busy = false,
    showLabel = false,
    badge,
    shortcut,
    tooltipSide = 'bottom',
    className,
    disabled,
    type = 'button',
    ...buttonProps
  },
  ref,
) {
  const classes = [
    'av-icon-button',
    `av-icon-button--${size}`,
    `av-icon-button--${variant}`,
    showLabel ? '' : 'av-icon-button--square',
    selected ? 'av-icon-button--selected' : '',
    className,
  ].filter(Boolean).join(' ');

  const button = (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      className={classes}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-pressed={buttonProps['aria-pressed'] ?? (selected || undefined)}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled || busy}
    >
      <span className="av-icon-button__icon" aria-hidden="true">
        {busy ? <LoaderCircle size={size === 'sm' ? 14 : 16} className="av-icon-button__spinner" /> : icon}
      </span>
      {showLabel ? <span className="av-icon-button__label">{label}</span> : null}
      {badge !== undefined && badge !== null ? (
        <span className="av-icon-button__badge" aria-hidden="true">{badge}</span>
      ) : null}
    </button>
  );

  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
});


import {
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

export interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  block?: boolean;
  responsiveLabels?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  size = 'md',
  block = false,
  responsiveLabels = false,
  className,
}: SegmentedControlProps<T>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const classes = [
    'av-segmented',
    `av-segmented--${size}`,
    block ? 'av-segmented--block' : '',
    className,
  ].filter(Boolean).join(' ');

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
    const isBoundaryKey = event.key === 'Home' || event.key === 'End';
    if (direction === 0 && !isBoundaryKey) return;

    event.preventDefault();
    const enabledIndices = options
      .map((option, index) => option.disabled ? -1 : index)
      .filter((index) => index >= 0);
    if (enabledIndices.length === 0) return;

    let nextIndex: number;
    if (event.key === 'Home') {
      nextIndex = enabledIndices[0]!;
    } else if (event.key === 'End') {
      nextIndex = enabledIndices[enabledIndices.length - 1]!;
    } else {
      const currentEnabledIndex = enabledIndices.indexOf(currentIndex);
      const baseIndex = currentEnabledIndex >= 0 ? currentEnabledIndex : 0;
      const wrappedIndex = (baseIndex + direction + enabledIndices.length) % enabledIndices.length;
      nextIndex = enabledIndices[wrappedIndex]!;
    }

    const option = options[nextIndex];
    if (!option || option.disabled) return;
    onChange(option.value);
    buttonRefs.current[nextIndex]?.focus();
  };

  return (
    <div className={classes} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => { buttonRefs.current[index] = element; }}
            type="button"
            role="radio"
            className="av-segmented__item"
            aria-checked={checked}
            aria-label={option.label}
            title={option.label}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => moveSelection(event, index)}
          >
            {option.icon ? <span className="av-segmented__icon" aria-hidden="true">{option.icon}</span> : null}
            <span className={responsiveLabels ? 'av-segmented__label--responsive' : undefined}>
              {option.label}
            </span>
            {option.badge !== undefined && option.badge !== null ? (
              <span className="av-segmented__badge" aria-hidden="true">{option.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}


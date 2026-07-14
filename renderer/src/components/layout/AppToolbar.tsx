import { Activity } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  IconButton,
  type IconButtonSize,
  type IconButtonVariant,
} from '../common/IconButton';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '../common/SegmentedControl';

export interface AppToolbarTab<T extends string> extends SegmentedControlOption<T> {}

export interface AppToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  selected?: boolean;
  disabled?: boolean;
  busy?: boolean;
  showLabel?: boolean;
  badge?: ReactNode;
  shortcut?: string;
  testId?: string;
}

export interface AppToolbarStatus {
  label: string;
  tone?: 'neutral' | 'active' | 'success' | 'warning' | 'danger';
}

export interface AppToolbarProps<T extends string> {
  appName?: string;
  contextLabel?: string;
  mark?: ReactNode;
  tabs: readonly AppToolbarTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  primaryActions?: readonly AppToolbarAction[];
  utilityActions?: readonly AppToolbarAction[];
  status?: AppToolbarStatus;
  startContent?: ReactNode;
  endContent?: ReactNode;
  floating?: boolean;
  className?: string;
}

function ToolbarActions({ actions }: { actions: readonly AppToolbarAction[] }) {
  return (
    <div className="av-app-toolbar__actions">
      {actions.map((action) => (
        <IconButton
          key={action.id}
          label={action.label}
          icon={action.icon}
          onClick={action.onClick}
          variant={action.variant}
          size={action.size}
          selected={action.selected}
          disabled={action.disabled}
          busy={action.busy}
          showLabel={action.showLabel}
          badge={action.badge}
          shortcut={action.shortcut}
          data-testid={action.testId}
        />
      ))}
    </div>
  );
}

export function ToolbarDivider() {
  return <span className="av-toolbar-divider" role="separator" aria-orientation="vertical" />;
}

export function AppToolbar<T extends string>({
  appName = 'Actoviq Circuit Agent',
  contextLabel,
  mark = <Activity size={17} />,
  tabs,
  activeTab,
  onTabChange,
  primaryActions = [],
  utilityActions = [],
  status,
  startContent,
  endContent,
  floating = false,
  className,
}: AppToolbarProps<T>) {
  const classes = [
    'av-app-toolbar',
    floating ? 'av-app-toolbar--floating' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <header className={classes} aria-label="Application toolbar">
      <div className="av-app-toolbar__start">
        {startContent}
        <div className="av-app-toolbar__identity">
          <span className="av-app-toolbar__mark" aria-hidden="true">{mark}</span>
          <div className="av-app-toolbar__titles">
            <div className="av-app-toolbar__title">{appName}</div>
            {contextLabel ? <div className="av-app-toolbar__subtitle">{contextLabel}</div> : null}
          </div>
        </div>
        {primaryActions.length > 0 ? <ToolbarActions actions={primaryActions} /> : null}
      </div>

      <nav className="av-app-toolbar__center" aria-label="Workspace views">
        <SegmentedControl
          ariaLabel="Workspace view"
          options={tabs}
          value={activeTab}
          onChange={onTabChange}
          responsiveLabels
        />
      </nav>

      <div className="av-app-toolbar__end">
        {status ? (
          <span className="av-toolbar-status" data-tone={status.tone ?? 'neutral'} title={status.label}>
            <span className="av-toolbar-status__dot" aria-hidden="true" />
            <span>{status.label}</span>
          </span>
        ) : null}
        {utilityActions.length > 0 ? <ToolbarActions actions={utilityActions} /> : null}
        {endContent}
      </div>
    </header>
  );
}


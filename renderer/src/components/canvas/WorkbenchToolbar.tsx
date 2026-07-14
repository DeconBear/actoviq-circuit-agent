import {
  AlertTriangle,
  ArrowLeft,
  BookmarkPlus,
  FileOutput,
  FolderOpen,
  History,
  Minus,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { CircuitSymbolIcon } from '../common/CircuitSymbolIcon';
import { IconButton } from '../common/IconButton';
import './WorkbenchToolbar.css';

interface WorkbenchErcSummary {
  status?: string;
  errors: number;
  warnings: number;
}

interface WorkbenchToolbarProps {
  view: 'board' | 'module';
  zoom: number;
  busy: boolean;
  previewBusy: boolean;
  erc: WorkbenchErcSummary | null;
  onBackToBoard: () => void;
  onArrangeModules: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onBuild: () => void;
  onSimulate: () => void;
  onSaveTemplate: () => void;
  onSaveFlow: () => void;
  onOpenEdaExport: () => void;
  onOpenErc: () => void;
  onOpenHistory: () => void;
  onOpenFolder: () => void;
}

export function WorkbenchToolbar({
  view,
  zoom,
  busy,
  previewBusy,
  erc,
  onBackToBoard,
  onArrangeModules,
  onZoomOut,
  onZoomIn,
  onBuild,
  onSimulate,
  onSaveTemplate,
  onSaveFlow,
  onOpenEdaExport,
  onOpenErc,
  onOpenHistory,
  onOpenFolder,
}: WorkbenchToolbarProps) {
  const commandDisabled = busy || previewBusy;
  const ercLabel = erc ? `ERC ${erc.errors}/${erc.warnings}` : 'ERC -';
  const ercTone = erc?.status === 'error'
    ? 'error'
    : erc?.status === 'warning' ? 'warning' : 'clean';

  const ErcIcon = ercTone === 'error'
    ? ShieldAlert
    : ercTone === 'warning' ? AlertTriangle : ShieldCheck;

  return (
    <nav className="av-workbench-toolbar" aria-label="Circuit project commands">
      <div className="av-workbench-toolbar__group" aria-label="Canvas navigation">
        {view === 'module' ? (
          <IconButton
            label="Back to canvas"
            icon={<ArrowLeft size={17} />}
            variant="outline"
            onClick={onBackToBoard}
            data-testid="back-to-board"
          />
        ) : (
          <>
            <IconButton
              label="Arrange modules"
              icon={<CircuitSymbolIcon kind="block" size={18} />}
              variant="outline"
              onClick={onArrangeModules}
              disabled={busy}
              data-testid="arrange-modules"
            />
            <div className="av-workbench-zoom" role="group" aria-label="Canvas zoom">
              <IconButton
                label="Zoom out"
                icon={<Minus size={15} />}
                size="sm"
                onClick={onZoomOut}
                data-testid="canvas-zoom-out"
              />
              <span className="av-workbench-zoom__value" data-testid="canvas-zoom">{zoom}%</span>
              <IconButton
                label="Zoom in"
                icon={<Plus size={15} />}
                size="sm"
                onClick={onZoomIn}
                data-testid="canvas-zoom-in"
              />
            </div>
          </>
        )}
      </div>

      <div className="av-workbench-toolbar__group" aria-label="Build and simulation">
        <IconButton
          label="Refresh SVGs"
          icon={<RefreshCw size={17} />}
          variant="outline"
          onClick={onBuild}
          disabled={commandDisabled}
          data-testid="build-project"
        />
        <IconButton
          label="Simulate system"
          icon={<Play size={17} fill="currentColor" />}
          variant="primary"
          onClick={onSimulate}
          disabled={commandDisabled}
          data-testid="simulate-project"
        />
      </div>

      <IconButton
        label={ercLabel}
        icon={<ErcIcon size={16} />}
        showLabel
        size="sm"
        variant="outline"
        className={`av-workbench-erc av-workbench-erc--${ercTone}`}
        onClick={onOpenErc}
        disabled={busy}
        data-testid="open-project-erc"
      />

      <div className="av-workbench-toolbar__group av-workbench-toolbar__secondary" aria-label="Project tools">
        <IconButton
          label="Save template"
          icon={<BookmarkPlus size={16} />}
          size="sm"
          onClick={onSaveTemplate}
          disabled={commandDisabled}
          data-testid="save-design-template"
        />
        <IconButton
          label="Save flow"
          icon={<Workflow size={16} />}
          size="sm"
          onClick={onSaveFlow}
          disabled={commandDisabled}
          data-testid="save-design-flow"
        />
        <IconButton
          label="Export EDA"
          icon={<FileOutput size={16} />}
          size="sm"
          onClick={onOpenEdaExport}
          disabled={busy}
          data-testid="open-eda-export"
        />
        <IconButton
          label="Project history"
          icon={<History size={16} />}
          size="sm"
          onClick={onOpenHistory}
          disabled={busy}
          data-testid="open-project-history"
        />
        <IconButton
          label="Open project folder"
          icon={<FolderOpen size={16} />}
          size="sm"
          onClick={onOpenFolder}
          data-testid="open-project-folder"
        />
      </div>
    </nav>
  );
}

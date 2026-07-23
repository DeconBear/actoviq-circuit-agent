import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { conversationsForProject, conversationHasContent } from '../../store/chatHistoryPersistence';
import type { CircuitTrashItem, ProjectKind, ReferenceDocument, WorkspaceSummary } from '../../types';
import type { CircuitProjectSummary } from '../../types';

interface JobEntry {
  jobId: string;
  createdAt: string;
  status: string;
}

interface Props {
  collapsed: boolean;
  width: number;
  onToggle: () => void;
  activeJobId: string | null;
  onSelectJob: (jobId: string) => void;
  onNewDesign: () => void;
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  referenceDocuments: ReferenceDocument[];
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: (input: { name: string; root?: string }) => Promise<void>;
  onRefreshReferences: () => void;
  circuitProjects: CircuitProjectSummary[];
  trashProjects: CircuitTrashItem[];
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (demo: boolean, name: string, projectKind?: ProjectKind) => Promise<void>;
  onTrashProjects: (projectIds: string[]) => Promise<void>;
  onRestoreProjects: (trashIds: string[]) => Promise<void>;
  onPurgeProjects: (trashIds: string[]) => Promise<void>;
  onRefreshTrash: () => void;
}

export function Sidebar({
  collapsed,
  width,
  onToggle,
  activeJobId,
  onSelectJob,
  onNewDesign,
  activeWorkspace,
  workspaces,
  referenceDocuments,
  onSelectWorkspace,
  onCreateWorkspace,
  onRefreshReferences,
  circuitProjects,
  trashProjects,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  onTrashProjects,
  onRestoreProjects,
  onPurgeProjects,
  onRefreshTrash,
}: Props) {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [exportingJobId, setExportingJobId] = useState<string | null>(null);
  const [ocrRunningPath, setOcrRunningPath] = useState<string | null>(null);
  const [catalogAssets, setCatalogAssets] = useState<Array<Record<string, unknown>>>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [projectModules, setProjectModules] = useState<Array<{ id: string; name: string }>>([]);
  const [moduleAction, setModuleAction] = useState<{
    kind: 'layout' | 'promote';
    assetId: string;
    assetName: string;
  } | null>(null);
  const [moduleActionId, setModuleActionId] = useState('');
  const [layoutPrep, setLayoutPrep] = useState<{
    hashMatch: boolean | null;
    useAs: string;
    message: string;
  } | null>(null);
  const activeModuleId = useAppStore((s) => s.activeModuleId);
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [projectForm, setProjectForm] = useState<{ demo: boolean; name: string; projectKind: ProjectKind } | null>(null);
  const [creating, setCreating] = useState(false);
  const [projectSelectionMode, setProjectSelectionMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [trashOpen, setTrashOpen] = useState(false);
  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [projectConfirmation, setProjectConfirmation] = useState<{
    kind: 'trash' | 'purge';
    ids: string[];
    names: string[];
  } | null>(null);
  const creatingRef = useRef(false);
  const conversations = useAppStore((s) => s.conversations);
  const conversationMessages = useAppStore((s) => s.conversationMessages);
  const conversationId = useAppStore((s) => s.conversationId);
  const projectConversations = useMemo(
    () => conversationsForProject(conversations, activeProjectId, conversationMessages)
      .filter((entry) => conversationHasContent(entry, conversationMessages) || entry.id === conversationId),
    [activeProjectId, conversationId, conversationMessages, conversations],
  );
  const setConversationId = useAppStore((s) => s.setConversationId);

  useEffect(() => {
    setSelectedProjectIds((selected) => new Set(
      [...selected].filter((projectId) => circuitProjects.some((project) => project.projectId === projectId)),
    ));
  }, [circuitProjects]);

  useEffect(() => {
    const closeContextMenu = () => setProjectContextMenu(null);
    window.addEventListener('pointerdown', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    return () => {
      window.removeEventListener('pointerdown', closeContextMenu);
      window.removeEventListener('blur', closeContextMenu);
    };
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const list = await window.electronAPI.listJobs();
      setJobs(list);
    } catch { setJobs([]); }
  }, []);

  useEffect(() => {
    refreshJobs();
    // Keep externally generated skill jobs visible without requiring a manual refresh.
    const interval = setInterval(refreshJobs, 5000);
    return () => clearInterval(interval);
  }, [refreshJobs, activeWorkspace?.id]);

  const handleRunOcr = useCallback(async (relativePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.electronAPI) return;
    setOcrRunningPath(relativePath);
    setNotice(null);
    try {
      const result = await window.electronAPI.runReferenceOcr(relativePath);
      setNotice({ type: 'ok', text: `OCR saved: ${result.textPath}` });
      onRefreshReferences();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({ type: 'error', text: `OCR failed: ${message}` });
    } finally {
      setOcrRunningPath(null);
    }
  }, [onRefreshReferences]);

  const handleSelectConversation = useCallback((convId: string) => {
    setConversationId(convId);
    const conv = useAppStore.getState().conversations.find((entry) => entry.id === convId);
    if (conv?.jobId) {
      onSelectJob(conv.jobId);
    }
  }, [onSelectJob, setConversationId]);

  const handleDeleteConversation = useCallback((convId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const target = useAppStore.getState().conversations.find((entry) => entry.id === convId);
    const label = target?.title || 'this conversation';
    if (!window.confirm(`Delete “${label}”? This cannot be undone.`)) return;
    useAppStore.getState().deleteConversation(convId);
  }, []);

  const handleRenameConversation = useCallback((convId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const target = useAppStore.getState().conversations.find((entry) => entry.id === convId);
    const next = window.prompt('Rename conversation', target?.title || '');
    if (next == null) return;
    const trimmed = next.trim();
    if (trimmed) useAppStore.getState().renameConversation(convId, trimmed);
  }, []);

  const handleExport = useCallback(async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.electronAPI) return;
    setExportingJobId(jobId);
    setNotice(null);
    try {
      const zipPath = await window.electronAPI.exportJob(jobId);
      setNotice({ type: 'ok', text: `Exported ZIP: ${zipPath}` });
      window.electronAPI.openJobFolder(jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({ type: 'error', text: `Export failed: ${message}` });
    } finally {
      setExportingJobId(null);
    }
  }, []);

  const handleOpenFolder = useCallback((jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.electronAPI) {
      window.electronAPI.openJobFolder(jobId);
    }
  }, []);

  const handleChooseWorkspaceRoot = useCallback(async () => {
    if (!window.electronAPI || creating) return;
    const root = await window.electronAPI.chooseWorkspaceRoot();
    if (root) setWorkspaceRoot(root);
  }, [creating]);

  const handleOpenWorkspaceRoot = useCallback(async () => {
    if (!window.electronAPI || creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const openedPath = await window.electronAPI.openWorkspaceRoot();
      setNotice({ type: 'ok', text: `Workspace opened: ${openedPath}` });
    } catch (error) {
      setNotice({ type: 'error', text: `Open workspace failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setCreating(false);
    }
  }, [creating]);

  const handleOpenWorkspaceReferences = useCallback(async () => {
    if (!window.electronAPI || creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const openedPath = await window.electronAPI.openWorkspaceReferences();
      setNotice({ type: 'ok', text: `References opened: ${openedPath}` });
    } catch (error) {
      setNotice({ type: 'error', text: `Open references failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setCreating(false);
    }
  }, [creating]);

  const refreshCatalog = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.listReferenceCatalog();
      setCatalogAssets(Array.isArray(result.assets) ? result.assets : []);
    } catch {
      setCatalogAssets([]);
    }
  }, []);

  const refreshProjectModules = useCallback(async () => {
    if (!window.electronAPI || !activeProjectId) {
      setProjectModules([]);
      return;
    }
    try {
      const bundle = await window.electronAPI.getCircuitProject(activeProjectId) as {
        project?: { modules?: Array<{ id?: string; name?: string }> };
        modules?: Record<string, { name?: string }>;
      };
      const fromProject = (bundle.project?.modules ?? [])
        .map((module) => ({
          id: String(module.id ?? ''),
          name: String(module.name ?? module.id ?? ''),
        }))
        .filter((module) => module.id);
      const fromMap = Object.entries(bundle.modules ?? {}).map(([id, module]) => ({
        id,
        name: String(module.name ?? id),
      }));
      setProjectModules(fromProject.length > 0 ? fromProject : fromMap);
    } catch {
      setProjectModules([]);
    }
  }, [activeProjectId]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog, activeWorkspace?.id]);

  useEffect(() => {
    void refreshProjectModules();
    setModuleAction(null);
    setLayoutPrep(null);
  }, [refreshProjectModules, activeProjectId]);

  useEffect(() => {
    if (!moduleAction) return;
    const preferred = activeModuleId && projectModules.some((module) => module.id === activeModuleId)
      ? activeModuleId
      : (projectModules[0]?.id ?? '');
    setModuleActionId(preferred);
    setLayoutPrep(null);
  }, [moduleAction, activeModuleId, projectModules]);

  useEffect(() => {
    if (!moduleAction || moduleAction.kind !== 'layout' || !activeProjectId || !moduleActionId || !window.electronAPI) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electronAPI.prepareLayoutReference({
          projectId: activeProjectId,
          moduleId: moduleActionId,
          assetId: moduleAction.assetId,
        }) as {
          hash_match?: boolean;
          use_as?: string;
          message?: string;
        };
        if (cancelled) return;
        setLayoutPrep({
          hashMatch: result.hash_match === true,
          useAs: String(result.use_as ?? ''),
          message: String(result.message ?? ''),
        });
      } catch (error) {
        if (cancelled) return;
        setLayoutPrep({
          hashMatch: false,
          useAs: 'agent_context_only',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => { cancelled = true; };
  }, [moduleAction, activeProjectId, moduleActionId]);

  const handleCatalogImportCircuit = useCallback(async () => {
    if (!window.electronAPI) return;
    setCatalogBusy(true);
    setNotice(null);
    try {
      const result = await window.electronAPI.importCircuitReference() as {
        ok?: boolean;
        cancelled?: boolean;
        error?: string;
      };
      if (result.cancelled) return;
      if (result.ok === false) throw new Error(result.error || 'Import failed');
      setNotice({ type: 'ok', text: 'Circuit reference imported' });
      await refreshCatalog();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCatalogBusy(false);
    }
  }, [refreshCatalog]);

  const handleCatalogImportVisual = useCallback(async () => {
    if (!window.electronAPI) return;
    setCatalogBusy(true);
    setNotice(null);
    try {
      const result = await window.electronAPI.importVisualReference() as {
        ok?: boolean;
        cancelled?: boolean;
        error?: string;
      };
      if (result.cancelled) return;
      if (result.ok === false) throw new Error(result.error || 'Import failed');
      setNotice({ type: 'ok', text: 'Layout visual reference imported' });
      await refreshCatalog();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCatalogBusy(false);
    }
  }, [refreshCatalog]);

  const handleCatalogCreateProject = useCallback(async (assetId: string, name: string) => {
    if (!window.electronAPI) return;
    setCatalogBusy(true);
    setNotice(null);
    try {
      const result = await window.electronAPI.createProjectFromReference({ assetId, name }) as {
        ok?: boolean;
        project_id?: string;
        error?: string;
      };
      if (!result.ok) throw new Error(result.error || 'Create project failed');
      setNotice({ type: 'ok', text: `Created project ${result.project_id}` });
      onRefreshReferences();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCatalogBusy(false);
    }
  }, [onRefreshReferences]);

  const handleCatalogInsertModule = useCallback(async (assetId: string) => {
    if (!window.electronAPI) return;
    if (!activeProjectId) {
      setNotice({ type: 'error', text: 'Open a project before inserting a module' });
      return;
    }
    setCatalogBusy(true);
    setNotice(null);
    try {
      const result = await window.electronAPI.insertModuleFromReference({
        projectId: activeProjectId,
        assetId,
      }) as { ok?: boolean; module_id?: string; error?: string };
      if (!result.ok) throw new Error(result.error || 'Insert failed');
      setNotice({ type: 'ok', text: `Inserted module ${result.module_id}` });
      onSelectProject(activeProjectId);
      await refreshProjectModules();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCatalogBusy(false);
    }
  }, [activeProjectId, onSelectProject, refreshProjectModules]);

  const openModuleAction = useCallback((kind: 'layout' | 'promote', assetId: string, assetName: string) => {
    if (!activeProjectId) {
      setNotice({ type: 'error', text: 'Open a project before using layout actions' });
      return;
    }
    if (projectModules.length === 0) {
      setNotice({ type: 'error', text: 'Current project has no modules to select' });
      void refreshProjectModules();
      return;
    }
    setModuleAction({ kind, assetId, assetName });
  }, [activeProjectId, projectModules.length, refreshProjectModules]);

  const confirmModuleAction = useCallback(async () => {
    if (!window.electronAPI || !activeProjectId || !moduleAction || !moduleActionId) return;
    if (moduleAction.kind === 'layout' && layoutPrep && layoutPrep.hashMatch === false) {
      setNotice({
        type: 'error',
        text: layoutPrep.message || 'Connectivity changed; layout reference is context-only',
      });
      return;
    }
    setCatalogBusy(true);
    setNotice(null);
    try {
      if (moduleAction.kind === 'layout') {
        const result = await window.electronAPI.applyLayoutReference({
          projectId: activeProjectId,
          moduleId: moduleActionId,
          assetId: moduleAction.assetId,
        }) as { ok?: boolean; applied?: boolean; message?: string; error?: string };
        if (!result.ok) throw new Error(result.error || result.message || 'Apply layout failed');
        setNotice({
          type: 'ok',
          text: result.applied
            ? `Layout applied to ${moduleActionId}`
            : (result.message || 'Layout prepared without applying'),
        });
        onSelectProject(activeProjectId);
      } else {
        const result = await window.electronAPI.promoteVisualReferenceFromModule({
          projectId: activeProjectId,
          moduleId: moduleActionId,
          assetId: moduleAction.assetId,
        }) as { ok?: boolean; error?: string };
        if (!result.ok) throw new Error(result.error || 'Promote failed');
        setNotice({ type: 'ok', text: `Promoted visual using module ${moduleActionId}` });
        await refreshCatalog();
      }
      setModuleAction(null);
      setLayoutPrep(null);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCatalogBusy(false);
    }
  }, [
    activeProjectId,
    layoutPrep,
    moduleAction,
    moduleActionId,
    onSelectProject,
    refreshCatalog,
  ]);

  const handleCatalogAttachChat = useCallback(async (assetId: string) => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.attachReferenceToChat({ assetId }) as {
        ok?: boolean;
        attachment?: { summary?: string };
      };
      if (!result.ok) throw new Error('Attach failed');
      setNotice({ type: 'ok', text: `Attached: ${result.attachment?.summary || assetId}` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const handleCreateWorkspace = useCallback(async () => {
    const name = workspaceName.trim();
    if (!name || creating || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setNotice(null);
    try {
      await onCreateWorkspace({ name, root: workspaceRoot.trim() || undefined });
      setWorkspaceFormOpen(false);
      setWorkspaceName('');
      setWorkspaceRoot('');
      setNotice({ type: 'ok', text: `Workspace created: ${name}` });
    } catch (error) {
      setNotice({ type: 'error', text: `Workspace failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [creating, onCreateWorkspace, workspaceName, workspaceRoot]);

  const handleCreateProject = useCallback(async () => {
    if (!projectForm || creating || creatingRef.current) return;
    const name = projectForm.name.trim();
    if (!name) return;
    creatingRef.current = true;
    setCreating(true);
    setNotice(null);
    try {
      await onCreateProject(projectForm.demo, name, projectForm.projectKind);
      setProjectForm(null);
      setNotice({ type: 'ok', text: `Project created: ${name}` });
    } catch (error) {
      setNotice({ type: 'error', text: `Project failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [creating, onCreateProject, projectForm]);

  const requestProjectTrash = useCallback((projectIds: string[]) => {
    const uniqueIds = [...new Set(projectIds)];
    const projects = uniqueIds
      .map((projectId) => circuitProjects.find((project) => project.projectId === projectId))
      .filter((project): project is CircuitProjectSummary => Boolean(project));
    if (projects.length === 0) return;
    setProjectContextMenu(null);
    setProjectConfirmation({
      kind: 'trash',
      ids: projects.map((project) => project.projectId),
      names: projects.map((project) => project.name),
    });
  }, [circuitProjects]);

  const requestTrashPurge = useCallback((items: CircuitTrashItem[]) => {
    if (items.length === 0) return;
    setProjectConfirmation({
      kind: 'purge',
      ids: items.map((item) => item.trashId),
      names: items.map((item) => item.name),
    });
  }, []);

  const handleConfirmedProjectAction = useCallback(async () => {
    if (!projectConfirmation || creating) return;
    setCreating(true);
    setNotice(null);
    try {
      if (projectConfirmation.kind === 'trash') {
        await onTrashProjects(projectConfirmation.ids);
        setSelectedProjectIds(new Set());
        setProjectSelectionMode(false);
        setTrashOpen(true);
        setNotice({ type: 'ok', text: `Moved ${projectConfirmation.ids.length} project(s) to trash` });
      } else {
        await onPurgeProjects(projectConfirmation.ids);
        setNotice({ type: 'ok', text: `Permanently removed ${projectConfirmation.ids.length} project(s)` });
      }
      setProjectConfirmation(null);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCreating(false);
    }
  }, [creating, onPurgeProjects, onTrashProjects, projectConfirmation]);

  const handleRestoreProject = useCallback(async (trashId: string) => {
    if (creating) return;
    setCreating(true);
    setNotice(null);
    try {
      await onRestoreProjects([trashId]);
      setNotice({ type: 'ok', text: 'Project restored' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCreating(false);
    }
  }, [creating, onRestoreProjects]);

  const closeWorkspaceForm = useCallback(() => {
    if (creating) return;
    setWorkspaceFormOpen(false);
    setWorkspaceName('');
    setWorkspaceRoot('');
  }, [creating]);

  const handleWorkspaceFormKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleCreateWorkspace();
    } else if (event.key === 'Escape' && !creating) {
      event.preventDefault();
      closeWorkspaceForm();
    }
  }, [closeWorkspaceForm, creating, handleCreateWorkspace]);

  const handleProjectFormKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleCreateProject();
    } else if (event.key === 'Escape' && !creating) {
      event.preventDefault();
      setProjectForm(null);
    }
  }, [creating, handleCreateProject]);

  if (collapsed) {
    return (
      <div style={styles.collapsed}>
        <button
          onClick={onToggle}
          style={styles.toggleBtn}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          data-testid="sidebar-expand"
        >
          &gt;
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...styles.panel, width, minWidth: width }}>
      <div style={styles.header}>
        <span style={styles.title}>Workspace</span>
        <div style={styles.headerActions}>
          <button
            type="button"
            onClick={refreshJobs}
            style={styles.refreshBtn}
            title="Refresh"
            aria-label="Refresh jobs and projects"
            data-testid="sidebar-refresh-jobs"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onToggle}
            style={styles.toggleBtn}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            data-testid="sidebar-collapse"
          >
            &lt;
          </button>
        </div>
      </div>
      <div style={styles.workspaceBox}>
        <select
          value={activeWorkspace?.id ?? ''}
          onChange={(event) => onSelectWorkspace(event.target.value)}
          style={styles.workspaceSelect}
          data-testid="workspace-select"
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <div style={styles.workspaceActions}>
          <button
            type="button"
            onClick={() => {
              if (creating) return;
              setWorkspaceFormOpen((open) => !open);
              setProjectForm(null);
              setNotice(null);
            }}
            style={styles.smallBtn}
            disabled={creating}
            title="Create workspace"
            aria-label="Create workspace"
            data-testid="sidebar-new-workspace"
          >
            + Workspace
          </button>
          <button
            type="button"
            onClick={() => { void handleOpenWorkspaceRoot(); }}
            style={styles.smallBtn}
            disabled={creating}
            title="Open active workspace folder"
            aria-label="Open active workspace folder"
            data-testid="sidebar-open-workspace-root"
          >
            Open Root
          </button>
        </div>
        {workspaceFormOpen && (
          <div
            style={styles.createPanel}
            data-testid="workspace-create-panel"
            data-busy={creating ? 'true' : 'false'}
            aria-busy={creating}
            onKeyDown={handleWorkspaceFormKeyDown}
          >
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Workspace name"
              style={styles.inlineInput}
              data-testid="workspace-name-input"
              autoFocus
            />
            <div style={styles.pathRow}>
              <input
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                placeholder="Default location"
                style={styles.inlineInput}
                data-testid="workspace-root-input"
              />
              <button
                type="button"
                onClick={handleChooseWorkspaceRoot}
                style={styles.iconBtn}
                title="Choose folder"
                aria-label="Choose workspace folder"
                disabled={creating}
                data-testid="workspace-root-choose"
              >
                ...
              </button>
            </div>
            <div style={styles.formActions}>
              <button
                type="button"
                onClick={closeWorkspaceForm}
                style={styles.formBtn}
                disabled={creating}
                title="Cancel workspace creation"
                aria-label="Cancel workspace creation"
                data-testid="workspace-create-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreateWorkspace()}
                style={styles.formPrimaryBtn}
                disabled={creating || !workspaceName.trim()}
                title="Create workspace"
                aria-label="Create workspace"
                data-testid="workspace-create-submit"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        )}
        {activeWorkspace && (
          <div
            style={styles.workspacePath}
            data-testid="active-workspace-path"
            data-workspace-id={activeWorkspace.id}
          >
            {activeWorkspace.root}
          </div>
        )}
      </div>
      <div style={styles.projectActions}>
        <button
          type="button"
          onClick={() => {
            if (creating) return;
            setProjectForm({ demo: true, name: 'Modular analog chain', projectKind: 'simulation' });
            setWorkspaceFormOpen(false);
            setNotice(null);
          }}
          style={styles.newBtn}
          disabled={creating}
          title="Create demo project"
          aria-label="Create demo project"
          data-testid="sidebar-new-demo-project"
        >
          + Demo Project
        </button>
        <button
          type="button"
          onClick={() => {
            if (creating) return;
            setProjectForm({ demo: false, name: 'New circuit project', projectKind: 'simulation' });
            setWorkspaceFormOpen(false);
            setNotice(null);
          }}
          style={styles.blankProjectBtn}
          disabled={creating}
          title="Create blank project"
          aria-label="Create blank project"
          data-testid="sidebar-new-blank-project"
        >
          Blank
        </button>
      </div>
      {projectForm && (
        <div
          style={styles.createPanel}
          data-testid="project-create-panel"
          data-busy={creating ? 'true' : 'false'}
          aria-busy={creating}
          onKeyDown={handleProjectFormKeyDown}
        >
          <div style={styles.formTitle}>{projectForm.demo ? 'Demo project' : 'Blank project'}</div>
          <input
            value={projectForm.name}
            onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })}
            placeholder="Project name"
            style={styles.inlineInput}
            data-testid="project-name-input"
            autoFocus
          />
          <label style={styles.projectKindField}>
            <span style={styles.projectKindLabel}>Project kind</span>
            <select
              value={projectForm.projectKind}
              onChange={(event) => setProjectForm({
                ...projectForm,
                projectKind: event.target.value as ProjectKind,
              })}
              style={styles.projectKindSelect}
              disabled={creating}
              data-testid="project-kind-select"
            >
              <option value="simulation">仿真/教学</option>
              <option value="pcb_schematic">PCB 原理图</option>
              <option value="analog_ic">模拟 IC</option>
            </select>
          </label>
          <div style={styles.formActions}>
            <button
              type="button"
              onClick={() => {
                if (!creating) setProjectForm(null);
              }}
              style={styles.formBtn}
              disabled={creating}
              title="Cancel project creation"
              aria-label="Cancel project creation"
              data-testid="project-create-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreateProject()}
              style={styles.formPrimaryBtn}
              disabled={creating || !projectForm.name.trim()}
              title="Create project"
              aria-label="Create project"
              data-testid="project-create-submit"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div style={{
          ...styles.notice,
          ...(notice.type === 'error' ? styles.noticeError : styles.noticeOk),
        }} data-testid="sidebar-notice">
          {notice.text}
        </div>
      )}
      {projectContextMenu ? (
        <div
          style={{ ...styles.projectContextMenu, left: projectContextMenu.x, top: projectContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          data-testid="sidebar-project-context-menu"
        >
          <button
            type="button"
            style={styles.contextDangerButton}
            onClick={() => requestProjectTrash([projectContextMenu.projectId])}
            data-testid="sidebar-context-trash-project"
          >
            Move to Trash
          </button>
        </div>
      ) : null}
      {projectConfirmation ? (
        <div style={styles.confirmOverlay} data-testid="project-delete-confirmation">
          <div
            style={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-delete-confirmation-title"
          >
            <div id="project-delete-confirmation-title" style={styles.confirmTitle}>
              {projectConfirmation.kind === 'trash'
                ? `Move ${projectConfirmation.ids.length} project(s) to Trash?`
                : `Permanently delete ${projectConfirmation.ids.length} project(s)?`}
            </div>
            <div style={styles.confirmDescription}>
              {projectConfirmation.kind === 'trash'
                ? 'Projects can be restored later.'
                : 'This cannot be undone.'}
            </div>
            <div style={styles.confirmNames}>
              {projectConfirmation.names.map((name) => <div key={name}>{name}</div>)}
            </div>
            <div style={styles.formActions}>
              <button
                type="button"
                style={styles.formBtn}
                onClick={() => setProjectConfirmation(null)}
                disabled={creating}
                data-testid="project-delete-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.dangerButton}
                onClick={() => { void handleConfirmedProjectAction(); }}
                disabled={creating}
                data-testid="project-delete-confirm"
              >
                {projectConfirmation.kind === 'trash' ? 'Move to Trash' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div style={styles.list}>
        <div style={styles.sectionHeader}>
          <span>Circuit Projects</span>
          <div style={styles.sectionActions}>
            {projectSelectionMode && selectedProjectIds.size > 0 ? (
              <button
                type="button"
                style={styles.inlineDangerBtn}
                onClick={() => requestProjectTrash([...selectedProjectIds])}
                disabled={creating}
                data-testid="sidebar-trash-selected-projects"
              >
                Trash {selectedProjectIds.size}
              </button>
            ) : null}
            <button
              type="button"
              style={styles.inlineActionBtn}
              onClick={() => {
                setProjectSelectionMode((enabled) => !enabled);
                setSelectedProjectIds(new Set());
              }}
              disabled={creating}
              data-testid="sidebar-project-selection-mode"
            >
              {projectSelectionMode ? 'Cancel' : 'Select'}
            </button>
          </div>
        </div>
        {circuitProjects.length === 0 && (
          <div style={styles.empty}>No circuit projects yet</div>
        )}
        {circuitProjects.map((project) => (
          <div
            key={project.projectId}
            style={styles.projectRow}
            onContextMenu={(event) => {
              event.preventDefault();
              setProjectContextMenu({ projectId: project.projectId, x: event.clientX, y: event.clientY });
            }}
          >
            {projectSelectionMode ? (
              <input
                type="checkbox"
                checked={selectedProjectIds.has(project.projectId)}
                onChange={(event) => {
                  setSelectedProjectIds((selected) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(project.projectId);
                    else next.delete(project.projectId);
                    return next;
                  });
                }}
                style={styles.projectCheckbox}
                aria-label={`Select project ${project.name}`}
                data-testid={`sidebar-project-select-${project.projectId}`}
              />
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (projectSelectionMode) {
                  setSelectedProjectIds((selected) => {
                    const next = new Set(selected);
                    if (next.has(project.projectId)) next.delete(project.projectId);
                    else next.add(project.projectId);
                    return next;
                  });
                } else {
                  onSelectProject(project.projectId);
                }
              }}
              style={{
                ...styles.projectItemButton,
                ...(projectSelectionMode ? styles.projectItemSelecting : {}),
                ...(activeProjectId === project.projectId ? styles.itemActive : {}),
              }}
              data-testid={`sidebar-project-${project.projectId}`}
              data-active={activeProjectId === project.projectId ? 'true' : 'false'}
              aria-label={`${projectSelectionMode ? 'Select' : 'Open'} project ${project.name}`}
              aria-current={activeProjectId === project.projectId ? 'true' : undefined}
            >
              <div style={styles.itemName}>{project.name}</div>
              <div style={styles.itemMeta}>
                <span>{project.moduleCount} modules</span>
                <span>rev {project.revision}</span>
              </div>
            </button>
          </div>
        ))}
        <div style={styles.sectionHeader}>
          <button
            type="button"
            style={styles.trashToggle}
            onClick={() => {
              setTrashOpen((open) => !open);
              if (!trashOpen) onRefreshTrash();
            }}
            data-testid="sidebar-trash-toggle"
          >
            Trash ({trashProjects.length}) {trashOpen ? 'Hide' : 'Show'}
          </button>
          {trashOpen && trashProjects.length > 0 ? (
            <button
              type="button"
              style={styles.inlineDangerBtn}
              onClick={() => requestTrashPurge(trashProjects)}
              disabled={creating}
              data-testid="sidebar-empty-trash"
            >
              Empty
            </button>
          ) : null}
        </div>
        {trashOpen ? (
          <div data-testid="sidebar-trash-list">
            {trashProjects.length === 0 ? <div style={styles.emptyCompact}>Trash is empty</div> : null}
            {trashProjects.map((item) => (
              <div key={item.trashId} style={styles.trashItem} data-testid={`sidebar-trash-${item.trashId}`}>
                <div style={styles.trashItemText}>
                  <div style={styles.itemName}>{item.name}</div>
                  <div style={styles.trashDate}>{new Date(item.deletedAt).toLocaleString()}</div>
                </div>
                <button
                  type="button"
                  style={styles.restoreBtn}
                  onClick={() => { void handleRestoreProject(item.trashId); }}
                  disabled={creating}
                  data-testid={`sidebar-restore-${item.trashId}`}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onNewDesign}
          style={styles.legacyDesignBtn}
          title="Start legacy chat design"
          aria-label="Start legacy chat design"
        >
          Legacy chat design
        </button>
        {projectConversations.length > 0 && (
          <>
            <div style={styles.sectionHeader}>
              Conversations
              <div style={styles.sectionActions}>
                <button
                  type="button"
                  onClick={() => {
                    const scope = activeProjectId ? 'this project' : 'workspace chat';
                    if (!window.confirm(`Delete all ${projectConversations.length} conversations for ${scope}?`)) return;
                    useAppStore.getState().clearConversationsForProject(activeProjectId);
                    useAppStore.getState().newConversation(activeProjectId);
                  }}
                  style={styles.inlineActionBtn}
                  data-testid="sidebar-clear-conversations"
                >
                  Clear
                </button>
              </div>
            </div>
            {projectConversations.slice(0, 20).map((conv) => (
              <div
                key={conv.id}
                onClick={() => handleSelectConversation(conv.id)}
                style={{
                  ...styles.convItem,
                  ...(conversationId === conv.id ? styles.convItemActive : {}),
                }}
                data-testid={`sidebar-conversation-${conv.id}`}
              >
                <div style={styles.convItemTitle}>{conv.title}</div>
                <div style={styles.convItemMeta}>
                  {conv.messageCount} msgs · {new Date(conv.updatedAt).toLocaleString()}
                </div>
                <div style={styles.convItemActions}>
                  <button
                    type="button"
                    style={styles.convActionBtn}
                    onClick={(event) => handleRenameConversation(conv.id, event)}
                    title="Rename"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    style={styles.convActionBtn}
                    onClick={(event) => handleDeleteConversation(conv.id, event)}
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
        <div style={styles.sectionHeader}>
          Reference catalog
          <div style={styles.sectionActions}>
            <button
              onClick={() => { void handleCatalogImportCircuit(); }}
              style={styles.inlineActionBtn}
              disabled={catalogBusy}
              title="Import a .cir / .sp netlist"
              data-testid="sidebar-import-circuit-ref"
            >
              Import circuit
            </button>
            <button
              onClick={() => { void handleCatalogImportVisual(); }}
              style={styles.inlineActionBtn}
              disabled={catalogBusy}
              title="Import a schematic screenshot or PDF page"
              data-testid="sidebar-import-visual-ref"
            >
              Import image
            </button>
            <button
              onClick={() => { void refreshCatalog(); }}
              style={styles.inlineActionBtn}
              disabled={catalogBusy}
              data-testid="sidebar-refresh-catalog"
            >
              Refresh
            </button>
          </div>
        </div>
        {!activeProjectId && (
          <div style={styles.empty}>Open a project to insert modules or apply layout.</div>
        )}
        {moduleAction && (
          <div style={styles.createPanel} data-testid="catalog-module-picker">
            <div style={styles.formTitle}>
              {moduleAction.kind === 'layout' ? 'Apply layout' : 'Promote visual'} · {moduleAction.assetName}
            </div>
            <label style={styles.projectKindLabel} htmlFor="catalog-module-select">Module</label>
            <select
              id="catalog-module-select"
              style={styles.projectKindSelect}
              value={moduleActionId}
              disabled={catalogBusy || projectModules.length === 0}
              onChange={(event) => setModuleActionId(event.target.value)}
            >
              {projectModules.map((module) => (
                <option key={module.id} value={module.id}>
                  {module.name} ({module.id})
                </option>
              ))}
            </select>
            {moduleAction.kind === 'layout' && layoutPrep && (
              <div style={{
                ...styles.refMeta,
                color: layoutPrep.hashMatch ? '#166534' : '#9a3412',
              }}>
                {layoutPrep.hashMatch
                  ? 'Connectivity matches — safe to apply.'
                  : (layoutPrep.message || 'Connectivity changed — layout is context-only.')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                style={styles.newBtn}
                disabled={
                  catalogBusy
                  || !moduleActionId
                  || (moduleAction.kind === 'layout' && layoutPrep?.hashMatch === false)
                }
                title={
                  moduleAction.kind === 'layout' && layoutPrep?.hashMatch === false
                    ? 'Connectivity changed; cannot apply layout seed'
                    : undefined
                }
                onClick={() => { void confirmModuleAction(); }}
              >
                {moduleAction.kind === 'layout' ? 'Apply' : 'Promote'}
              </button>
              <button
                type="button"
                style={styles.blankProjectBtn}
                disabled={catalogBusy}
                onClick={() => {
                  setModuleAction(null);
                  setLayoutPrep(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {catalogAssets.length === 0 && (
          <div style={styles.empty}>Import a circuit netlist or layout image to get started.</div>
        )}
        {catalogAssets.slice(0, 10).map((asset) => {
          const id = String(asset.id ?? '');
          const kind = String(asset.kind ?? '');
          const name = String(asset.name ?? id);
          const useAs = Array.isArray(asset.use_as) ? asset.use_as.map(String) : [];
          const canMutateProject = Boolean(activeProjectId);
          return (
            <div key={id} style={styles.refItem} data-testid={`catalog-asset-${id}`}>
              <div style={styles.refTitle}>{name}</div>
              <div style={styles.refMeta}>{kind} · {String(asset.trust ?? '')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {useAs.includes('seed_new_project') && (
                  <button
                    type="button"
                    style={styles.refOcrBtn}
                    disabled={catalogBusy}
                    title="Create a new project from this circuit reference"
                    onClick={() => { void handleCatalogCreateProject(id, name); }}
                  >
                    New project
                  </button>
                )}
                {useAs.includes('insert_module') && (
                  <button
                    type="button"
                    style={styles.refOcrBtn}
                    disabled={catalogBusy || !canMutateProject}
                    title={canMutateProject ? 'Insert as a module into the open project' : 'Open a project first'}
                    onClick={() => { void handleCatalogInsertModule(id); }}
                  >
                    Insert module
                  </button>
                )}
                {(useAs.includes('apply_layout_seed') || useAs.includes('guide_router')) && (
                  <button
                    type="button"
                    style={styles.refOcrBtn}
                    disabled={catalogBusy || !canMutateProject}
                    title={
                      canMutateProject
                        ? 'Choose a module and apply layout if connectivity matches'
                        : 'Open a project first'
                    }
                    onClick={() => openModuleAction('layout', id, name)}
                  >
                    Apply layout
                  </button>
                )}
                {kind === 'layout_visual' && (
                  <button
                    type="button"
                    style={styles.refOcrBtn}
                    disabled={catalogBusy || !canMutateProject}
                    title={
                      canMutateProject
                        ? 'Promote this image using the selected module placement'
                        : 'Open a project first'
                    }
                    onClick={() => openModuleAction('promote', id, name)}
                  >
                    Promote
                  </button>
                )}
                <button
                  type="button"
                  style={styles.refOcrBtn}
                  disabled={catalogBusy}
                  title="Attach this reference summary to chat context"
                  onClick={() => { void handleCatalogAttachChat(id); }}
                >
                  Attach chat
                </button>
              </div>
            </div>
          );
        })}
        <div style={styles.sectionHeader}>
          Documents
          <div style={styles.sectionActions}>
            <button
              onClick={() => { void handleOpenWorkspaceReferences(); }}
              style={styles.inlineActionBtn}
              disabled={creating}
              data-testid="sidebar-open-references"
            >
              Open folder
            </button>
            <button
              onClick={onRefreshReferences}
              style={styles.inlineActionBtn}
              aria-label="Refresh references"
              data-testid="sidebar-refresh-references"
            >
              Refresh
            </button>
          </div>
        </div>
        {referenceDocuments.length === 0 && (
          <div style={styles.empty}>Put PDFs or images in references/</div>
        )}
        {referenceDocuments.slice(0, 8).map((doc) => (
          <div key={doc.relativePath} style={styles.refItem}>
            <div style={styles.refTitle}>{doc.relativePath}</div>
            <div style={styles.refMeta}>
              {Math.max(1, Math.round(doc.sizeBytes / 1024))} KB
              {doc.ocrTextPath ? ' · OCR ready' : ''}
            </div>
            <button
              onClick={(event) => handleRunOcr(doc.relativePath, event)}
              style={styles.refOcrBtn}
              disabled={ocrRunningPath === doc.relativePath}
            >
              {ocrRunningPath === doc.relativePath ? 'OCR...' : 'OCR'}
            </button>
          </div>
        ))}
        <div style={styles.sectionHeader}>Jobs</div>
        {jobs.length === 0 && (
          <div style={styles.empty}>No jobs yet</div>
        )}
        {jobs.map((job) => (
          <div
            key={job.jobId}
            onClick={() => onSelectJob(job.jobId)}
            style={{
              ...styles.item,
              ...(activeJobId === job.jobId ? styles.itemActive : {}),
            }}
          >
            <div style={styles.itemHeader}>
              <div style={styles.itemName}>{job.jobId}</div>
              <div style={styles.itemActions}>
                <button
                  onClick={(e) => handleOpenFolder(job.jobId, e)}
                  style={styles.actionBtn}
                  title="Open folder"
                  aria-label={`Open job folder ${job.jobId}`}
                  data-testid={`sidebar-job-open-folder-${job.jobId}`}
                >📂</button>
                <button
                  onClick={(e) => handleExport(job.jobId, e)}
                  style={styles.actionBtn}
                  title="Export as ZIP"
                  disabled={exportingJobId === job.jobId}
                  aria-label={`Export job ${job.jobId} as ZIP`}
                  data-testid={`sidebar-job-export-${job.jobId}`}
                >{exportingJobId === job.jobId ? '…' : '📦'}</button>
              </div>
            </div>
            <div style={styles.itemMeta}>
              <span style={{
                ...styles.status,
                color: job.status === 'completed' ? '#267346' :
                       job.status === 'failed' ? '#a32d38' :
                       job.status === 'running' ? '#a26108' : '#69727d',
              }}>
                {job.status}
              </span>
              {job.createdAt && (
                <span style={styles.date}>
                  {new Date(job.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    backgroundColor: '#ffffff',
    color: '#28313b',
    borderRight: '1px solid #dfe3e8',
    display: 'flex',
    flexDirection: 'column',
  },
  collapsed: {
    width: 32,
    minWidth: 32,
    backgroundColor: '#ffffff',
    borderRight: '1px solid #dfe3e8',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: 8,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 12px',
    borderBottom: '1px solid #dfe3e8',
  },
  title: { fontWeight: 600, fontSize: 14 },
  headerActions: { display: 'flex', gap: 4 },
  workspaceBox: {
    padding: '10px 12px 8px',
    borderBottom: '1px solid #eef0f2',
  },
  workspaceSelect: {
    width: '100%',
    backgroundColor: '#ffffff',
    color: '#303741',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    padding: '5px 6px',
    fontSize: 12,
  },
  workspaceActions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 },
  smallBtn: {
    padding: '5px 6px',
    backgroundColor: '#ffffff',
    color: '#59636e',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
  },
  workspacePath: {
    marginTop: 8,
    color: '#8a929d',
    fontSize: 10,
    lineHeight: 1.35,
    wordBreak: 'break-all',
  },
  refreshBtn: {
    background: '#ffffff',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 11,
    padding: '3px 6px',
  },
  toggleBtn: {
    background: '#ffffff',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 11,
    padding: '3px 6px',
  },
  projectActions: { display: 'grid', gridTemplateColumns: '1fr 62px', gap: 6, margin: '10px 12px' },
  projectRow: { position: 'relative', display: 'flex', alignItems: 'stretch', backgroundColor: '#ffffff' },
  projectCheckbox: { width: 16, margin: '0 0 0 10px', flex: '0 0 16px', accentColor: '#2563eb' },
  newBtn: {
    padding: '8px 0',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  blankProjectBtn: {
    padding: '8px 0',
    backgroundColor: '#ffffff',
    color: '#3f4a56',
    border: '1px solid #c8cfd7',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 650,
  },
  createPanel: {
    margin: '0 12px 10px',
    padding: 8,
    border: '1px solid #d8dee8',
    borderRadius: 5,
    backgroundColor: '#f8fafc',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  formTitle: {
    color: '#59636e',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  inlineInput: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    padding: '6px 7px',
    fontSize: 12,
    color: '#253041',
    backgroundColor: '#ffffff',
  },
  projectKindField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  projectKindLabel: {
    color: '#59636e',
    fontSize: 11,
    fontWeight: 600,
  },
  projectKindSelect: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    padding: '6px 7px',
    fontSize: 12,
    color: '#253041',
    backgroundColor: '#ffffff',
  },
  pathRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 32px',
    gap: 5,
  },
  iconBtn: {
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    backgroundColor: '#ffffff',
    color: '#59636e',
    cursor: 'pointer',
    fontWeight: 700,
  },
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 6,
  },
  formBtn: {
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    backgroundColor: '#ffffff',
    color: '#59636e',
    padding: '5px 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 650,
  },
  formPrimaryBtn: {
    border: '1px solid #2563eb',
    borderRadius: 4,
    backgroundColor: '#2563eb',
    color: '#ffffff',
    padding: '5px 9px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  },
  legacyDesignBtn: {
    margin: '8px 12px 4px',
    padding: '6px',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    color: '#69727d',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 10,
  },
  notice: {
    margin: '0 12px 8px',
    padding: '6px 8px',
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1.4,
    wordBreak: 'break-all',
  },
  noticeOk: {
    color: '#267346',
    backgroundColor: '#edf8f1',
    border: '1px solid #b8dec5',
  },
  noticeError: {
    color: '#a32d38',
    backgroundColor: '#fff0f2',
    border: '1px solid #e7b8be',
  },
  list: { flex: 1, overflowY: 'auto' },
  item: {
    padding: '10px 14px',
    cursor: 'pointer',
    borderBottom: '1px solid #eef0f2',
    transition: 'background 0.1s',
  },
  projectItemButton: {
    width: '100%',
    display: 'block',
    padding: '10px 14px',
    cursor: 'pointer',
    border: 'none',
    borderBottom: '1px solid #eef0f2',
    backgroundColor: '#ffffff',
    color: '#28313b',
    textAlign: 'left',
    font: 'inherit',
    transition: 'background 0.1s',
  },
  projectItemSelecting: { padding: '10px 14px 10px 10px' },
  trashToggle: {
    padding: 0,
    border: 0,
    background: 'transparent',
    color: '#7b8490',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  trashItem: {
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px 7px 14px',
    borderBottom: '1px solid #eef0f2',
    backgroundColor: '#fafbfc',
  },
  trashItemText: { minWidth: 0, flex: 1 },
  trashDate: { marginTop: 2, color: '#8a929d', fontSize: 9 },
  restoreBtn: {
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    background: '#ffffff',
    color: '#46515e',
    cursor: 'pointer',
    fontSize: 10,
    padding: '4px 6px',
  },
  emptyCompact: { padding: '10px 14px', color: '#8a929d', fontSize: 11 },
  projectContextMenu: {
    position: 'fixed',
    zIndex: 80,
    minWidth: 148,
    padding: 4,
    border: '1px solid #cbd2db',
    borderRadius: 5,
    background: '#ffffff',
    boxShadow: '0 8px 24px rgba(25, 34, 45, 0.18)',
  },
  contextDangerButton: {
    width: '100%',
    border: 0,
    borderRadius: 3,
    background: 'transparent',
    color: '#a32d38',
    cursor: 'pointer',
    fontSize: 12,
    padding: '7px 9px',
    textAlign: 'left',
  },
  confirmOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(27, 34, 43, 0.28)',
  },
  confirmDialog: {
    width: 360,
    maxWidth: 'calc(100vw - 32px)',
    padding: 16,
    border: '1px solid #cbd2db',
    borderRadius: 6,
    background: '#ffffff',
    boxShadow: '0 16px 48px rgba(25, 34, 45, 0.22)',
  },
  confirmTitle: { color: '#252d37', fontSize: 15, fontWeight: 700 },
  confirmDescription: { marginTop: 5, color: '#66717e', fontSize: 12 },
  confirmNames: {
    maxHeight: 160,
    overflowY: 'auto',
    margin: '12px 0',
    padding: '8px 10px',
    border: '1px solid #e1e5ea',
    background: '#f7f8fa',
    color: '#3f4955',
    fontSize: 11,
    lineHeight: 1.6,
    wordBreak: 'break-word',
  },
  dangerButton: {
    border: '1px solid #b43b48',
    borderRadius: 4,
    background: '#b43b48',
    color: '#ffffff',
    padding: '5px 9px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  },
  itemActive: { backgroundColor: '#eaf2ff', boxShadow: 'inset 3px 0 #2563eb' },
  itemHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  itemName: { fontSize: 12, fontWeight: 500, wordBreak: 'break-all', flex: 1 },
  itemActions: { display: 'flex', gap: 2 },
  actionBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 10,
    padding: '1px 4px',
    opacity: 0.7,
  },
  itemMeta: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#7b8490' },
  status: { fontWeight: 600 },
  date: { color: '#8a929d' },
  empty: { padding: 20, textAlign: 'center', color: '#8a929d', fontSize: 13 },
  sectionHeader: {
    padding: '10px 14px 6px',
    fontSize: 11,
    fontWeight: 600,
    color: '#7b8490',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionActions: { display: 'flex', gap: 4 },
  inlineActionBtn: {
    background: 'transparent',
    border: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    fontSize: 10,
    padding: 0,
    textTransform: 'none',
    letterSpacing: 0,
  },
  inlineDangerBtn: {
    background: 'transparent',
    border: 'none',
    color: '#b43b48',
    cursor: 'pointer',
    fontSize: 10,
    padding: 0,
    textTransform: 'none',
    letterSpacing: 0,
  },
  refItem: {
    position: 'relative',
    padding: '8px 58px 8px 14px',
    borderBottom: '1px solid #eef0f2',
  },
  refTitle: {
    fontSize: 12,
    color: '#303741',
    wordBreak: 'break-all',
    lineHeight: 1.35,
  },
  refMeta: {
    marginTop: 2,
    fontSize: 10,
    color: '#8a929d',
  },
  refOcrBtn: {
    position: 'absolute',
    right: 10,
    top: 10,
    backgroundColor: '#ffffff',
    color: '#59636e',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 10,
    padding: '3px 7px',
  },
  convItem: {
    padding: '8px 14px',
    cursor: 'pointer',
    borderBottom: '1px solid #eef0f2',
    transition: 'background 0.1s',
  },
  convItemActive: { backgroundColor: '#eaf2ff' },
  convItemTitle: {
    fontSize: 12,
    fontWeight: 500,
    color: '#303741',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  convItemMeta: { fontSize: 10, color: '#8a929d', marginTop: 2 },
  convItemActions: {
    display: 'flex',
    gap: 6,
    marginTop: 6,
  },
  convActionBtn: {
    padding: '2px 6px',
    border: '1px solid #d8dee7',
    borderRadius: 4,
    background: '#fff',
    color: '#59636e',
    cursor: 'pointer',
    fontSize: 10,
  },
};

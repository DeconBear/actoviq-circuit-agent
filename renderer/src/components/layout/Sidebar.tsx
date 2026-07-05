import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import type { ReferenceDocument, WorkspaceSummary } from '../../types';
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
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (demo: boolean, name: string) => Promise<void>;
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
  activeProjectId,
  onSelectProject,
  onCreateProject,
}: Props) {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [exportingJobId, setExportingJobId] = useState<string | null>(null);
  const [ocrRunningPath, setOcrRunningPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [projectForm, setProjectForm] = useState<{ demo: boolean; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const conversations = useAppStore((s) => s.conversations);
  const conversationId = useAppStore((s) => s.conversationId);
  const setConversationId = useAppStore((s) => s.setConversationId);

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
      await onCreateProject(projectForm.demo, name);
      setProjectForm(null);
      setNotice({ type: 'ok', text: `Project created: ${name}` });
    } catch (error) {
      setNotice({ type: 'error', text: `Project failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [creating, onCreateProject, projectForm]);

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
            setProjectForm({ demo: true, name: 'Modular analog chain' });
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
            setProjectForm({ demo: false, name: 'New circuit project' });
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
      <div style={styles.list}>
        <div style={styles.sectionHeader}>Circuit Projects</div>
        {circuitProjects.length === 0 && (
          <div style={styles.empty}>No circuit projects yet</div>
        )}
        {circuitProjects.map((project) => (
          <button
            key={project.projectId}
            type="button"
            onClick={() => onSelectProject(project.projectId)}
            style={{
              ...styles.projectItemButton,
              ...(activeProjectId === project.projectId ? styles.itemActive : {}),
            }}
            data-testid={`sidebar-project-${project.projectId}`}
            data-active={activeProjectId === project.projectId ? 'true' : 'false'}
            aria-label={`Open project ${project.name}`}
            aria-current={activeProjectId === project.projectId ? 'true' : undefined}
          >
            <div style={styles.itemName}>{project.name}</div>
            <div style={styles.itemMeta}>
              <span>{project.moduleCount} modules</span>
              <span>rev {project.revision}</span>
            </div>
          </button>
        ))}
        <button
          type="button"
          onClick={onNewDesign}
          style={styles.legacyDesignBtn}
          title="Start legacy chat design"
          aria-label="Start legacy chat design"
        >
          Legacy chat design
        </button>
        {conversations.length > 0 && (
          <>
            <div style={styles.sectionHeader}>Conversations</div>
            {conversations.slice(0, 5).map((conv) => (
              <div
                key={conv.id}
                onClick={() => handleSelectConversation(conv.id)}
                style={{
                  ...styles.convItem,
                  ...(conversationId === conv.id ? styles.convItemActive : {}),
                }}
              >
                <div style={styles.convItemTitle}>{conv.title}</div>
                <div style={styles.convItemMeta}>
                  {conv.messageCount} msgs · {new Date(conv.updatedAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </>
        )}
        <div style={styles.sectionHeader}>
          References
          <div style={styles.sectionActions}>
            <button
              onClick={() => { void handleOpenWorkspaceReferences(); }}
              style={styles.inlineActionBtn}
              disabled={creating}
              data-testid="sidebar-open-references"
            >
              Open
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
};

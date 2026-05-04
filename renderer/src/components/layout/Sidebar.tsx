import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';

interface JobEntry {
  jobId: string;
  createdAt: string;
  status: string;
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  activeJobId: string | null;
  onSelectJob: (jobId: string) => void;
  onNewDesign: () => void;
}

export function Sidebar({ collapsed, onToggle, activeJobId, onSelectJob, onNewDesign }: Props) {
  const [jobs, setJobs] = useState<JobEntry[]>([]);

  const refreshJobs = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const list = await window.electronAPI.listJobs();
      setJobs(list);
    } catch { setJobs([]); }
  }, []);

  useEffect(() => {
    refreshJobs();
    // Refresh every 30 seconds
    const interval = setInterval(refreshJobs, 30000);
    return () => clearInterval(interval);
  }, [refreshJobs]);

  const handleExport = useCallback(async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.electronAPI) return;
    const zipPath = await window.electronAPI.exportJob(jobId);
    window.electronAPI.openJobFolder(jobId);
  }, []);

  const handleOpenFolder = useCallback((jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.electronAPI) {
      window.electronAPI.openJobFolder(jobId);
    }
  }, []);

  if (collapsed) {
    return (
      <div style={styles.collapsed}>
        <button onClick={onToggle} style={styles.toggleBtn} title="Expand sidebar">
          →
        </button>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Jobs</span>
        <div style={styles.headerActions}>
          <button onClick={refreshJobs} style={styles.refreshBtn} title="Refresh">↻</button>
          <button onClick={onToggle} style={styles.toggleBtn} title="Collapse sidebar">←</button>
        </div>
      </div>
      <button onClick={onNewDesign} style={styles.newBtn}>+ New Design</button>
      <div style={styles.list}>
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
                >📂</button>
                <button
                  onClick={(e) => handleExport(job.jobId, e)}
                  style={styles.actionBtn}
                  title="Export as ZIP"
                >📦</button>
              </div>
            </div>
            <div style={styles.itemMeta}>
              <span style={{
                ...styles.status,
                color: job.status === 'completed' ? '#4caf50' :
                       job.status === 'failed' ? '#e94560' :
                       job.status === 'running' ? '#ff9800' : '#a0a0b0',
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
    width: 240,
    minWidth: 240,
    backgroundColor: '#16213e',
    borderRight: '1px solid #0f3460',
    display: 'flex',
    flexDirection: 'column',
  },
  collapsed: {
    width: 32,
    minWidth: 32,
    backgroundColor: '#16213e',
    borderRight: '1px solid #0f3460',
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
    borderBottom: '1px solid #0f3460',
  },
  title: { fontWeight: 600, fontSize: 14 },
  headerActions: { display: 'flex', gap: 4 },
  refreshBtn: {
    background: 'transparent',
    border: 'none',
    color: '#a0a0b0',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
  },
  toggleBtn: {
    background: 'transparent',
    border: 'none',
    color: '#a0a0b0',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
  },
  newBtn: {
    margin: '10px 12px',
    padding: '8px 0',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  list: { flex: 1, overflowY: 'auto' },
  item: {
    padding: '10px 14px',
    cursor: 'pointer',
    borderBottom: '1px solid #0f346033',
    transition: 'background 0.1s',
  },
  itemActive: { backgroundColor: '#0f3460' },
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
  itemMeta: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#808090' },
  status: { fontWeight: 600 },
  date: { color: '#606080' },
  empty: { padding: 20, textAlign: 'center', color: '#606070', fontSize: 13 },
};

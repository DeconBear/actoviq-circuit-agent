import { useEffect, useState } from 'react';

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

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.listJobs().then(setJobs).catch(() => setJobs([]));
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
        <button onClick={onToggle} style={styles.toggleBtn} title="Collapse sidebar">
          ←
        </button>
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
            <div style={styles.itemName}>{job.jobId}</div>
            <div style={styles.itemMeta}>
              <span style={{
                ...styles.status,
                color: job.status === 'completed' ? '#4caf50' :
                       job.status === 'failed' ? '#e94560' :
                       job.status === 'running' ? '#ff9800' : '#a0a0b0',
              }}>
                {job.status}
              </span>
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
  itemName: { fontSize: 12, fontWeight: 500, marginBottom: 2, wordBreak: 'break-all' },
  itemMeta: { fontSize: 11, color: '#808090' },
  status: { fontWeight: 600 },
  empty: { padding: 20, textAlign: 'center', color: '#606070', fontSize: 13 },
};

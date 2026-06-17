import { useAppStore } from '../../store/appStore';
import type { StageState } from '../../types';

interface Props {
  collapsed: boolean;
  width: number;
  onToggle: () => void;
}

export function StagePanel({ collapsed, width, onToggle }: Props) {
  const stages = useAppStore((s) => s.stages);
  const toolCalls = useAppStore((s) => s.toolCalls);
  const isRunning = useAppStore((s) => s.isRunning);

  if (collapsed) {
    return (
      <div style={styles.collapsed}>
        <button onClick={onToggle} style={styles.toggleBtn} title="Expand stage panel">
          ←
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...styles.panel, width, minWidth: width }}>
      <div style={styles.header}>
        <span style={styles.title}>Workflow</span>
        <button onClick={onToggle} style={styles.toggleBtn} title="Collapse panel">
          →
        </button>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          Stages {isRunning && <span style={styles.spinner}>●</span>}
        </div>
        <div style={styles.stageList}>
          {stages.length === 0 && (
            <div style={styles.empty}>Waiting for workflow...</div>
          )}
          {stages.map((stage, i) => (
            <div key={stage.key} style={styles.stageItem}>
              <div style={styles.stageDot}>
                {stage.status === 'running' && <span style={styles.dotRunning}>●</span>}
                {stage.status === 'done' && <span style={styles.dotDone}>✓</span>}
                {stage.status === 'error' && <span style={styles.dotError}>✗</span>}
                {stage.status === 'waiting' && <span style={styles.dotWaiting}>○</span>}
              </div>
              <div style={styles.stageInfo}>
                <div style={styles.stageName}>{stage.name}</div>
                <div style={{ ...styles.stageStatus, color: statusColor(stage.status) }}>
                  {stage.status}
                </div>
              </div>
              {i < stages.length - 1 && (
                <div style={{
                  ...styles.connector,
                  borderLeftColor: stage.status === 'done' ? '#68ad7e' : '#dfe3e8',
                }} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Tool Calls</div>
        <div style={styles.toolList}>
          {toolCalls.length === 0 && (
            <div style={styles.empty}>No tool calls yet</div>
          )}
          {toolCalls.map((tc, i) => (
            <div key={`${tc.tool}-${tc.timestamp}-${i}`} style={styles.toolItem}>
              <div style={styles.toolName}>{tc.tool}</div>
              <div style={styles.toolMeta}>
                {tc.stageKey} · {new Date(tc.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function statusColor(status: StageState['status']): string {
  switch (status) {
    case 'running': return '#a26108';
    case 'done': return '#267346';
    case 'error': return '#a32d38';
    default: return '#8a929d';
  }
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    backgroundColor: '#ffffff',
    color: '#28313b',
    borderLeft: '1px solid #dfe3e8',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
  },
  collapsed: {
    width: 32,
    minWidth: 32,
    backgroundColor: '#ffffff',
    borderLeft: '1px solid #dfe3e8',
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
  toggleBtn: {
    background: 'transparent',
    border: 'none',
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
  },
  section: { padding: '10px 0' },
  sectionTitle: {
    padding: '0 14px 8px',
    fontSize: 12,
    fontWeight: 600,
    color: '#7b8490',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  spinner: {
    color: '#2563eb',
    animation: 'actoviq-pulse 1.2s ease-in-out infinite',
    display: 'inline-block',
  },
  stageList: { display: 'flex', flexDirection: 'column', paddingLeft: 14 },
  stageItem: {
    position: 'relative',
    paddingLeft: 28,
    paddingBottom: 14,
    minHeight: 32,
    transition: 'opacity 0.15s',
  },
  stageDot: {
    position: 'absolute',
    left: 0,
    top: 2,
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotRunning: { color: '#a26108', fontSize: 10 },
  dotDone: { color: '#267346', fontSize: 10 },
  dotError: { color: '#a32d38', fontSize: 10, fontWeight: 700 },
  dotWaiting: { color: '#a6adb5', fontSize: 10 },
  connector: {
    position: 'absolute',
    left: 8,
    top: 22,
    width: 0,
    height: 'calc(100% - 8px)',
    borderLeft: '2px solid',
  },
  stageInfo: {},
  stageName: { fontSize: 12, fontWeight: 500, lineHeight: 1.4 },
  stageStatus: { fontSize: 10 },
  toolList: { display: 'flex', flexDirection: 'column', padding: '0 14px', gap: 4 },
  toolItem: {
    padding: '4px 8px',
    backgroundColor: '#f3f5f7',
    border: '1px solid #e5e8ec',
    borderRadius: 4,
    fontSize: 11,
  },
  toolName: { fontFamily: "'Cascadia Code', 'Consolas', monospace", color: '#303741' },
  toolMeta: { color: '#8a929d', fontSize: 10, marginTop: 1 },
  empty: { padding: '8px 14px', color: '#8a929d', fontSize: 12, fontStyle: 'italic' },
};

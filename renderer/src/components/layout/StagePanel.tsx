import type { StageState, ToolCallEntry } from '../../types';

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  stages: StageState[];
  toolCalls: ToolCallEntry[];
  isRunning: boolean;
}

export function StagePanel({ collapsed, onToggle, stages, toolCalls, isRunning }: Props) {
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
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Workflow</span>
        <button onClick={onToggle} style={styles.toggleBtn} title="Collapse panel">
          →
        </button>
      </div>

      {/* Stage Stepper */}
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
                  borderColor: stage.status === 'done' ? '#4caf50' : '#2a2a4a',
                }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Tool Call Log */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Tool Calls</div>
        <div style={styles.toolList}>
          {toolCalls.length === 0 && (
            <div style={styles.empty}>No tool calls yet</div>
          )}
          {toolCalls.map((tc, i) => (
            <div key={`${tc.tool}-${i}`} style={styles.toolItem}>
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
    case 'running': return '#ff9800';
    case 'done': return '#4caf50';
    case 'error': return '#e94560';
    default: return '#606070';
  }
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 280,
    minWidth: 280,
    backgroundColor: '#16213e',
    borderLeft: '1px solid #0f3460',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
  },
  collapsed: {
    width: 32,
    minWidth: 32,
    backgroundColor: '#16213e',
    borderLeft: '1px solid #0f3460',
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
  section: { padding: '10px 0' },
  sectionTitle: {
    padding: '0 14px 8px',
    fontSize: 12,
    fontWeight: 600,
    color: '#808090',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  spinner: { color: '#e94560', animation: 'none' },
  stageList: { display: 'flex', flexDirection: 'column', paddingLeft: 14 },
  stageItem: { position: 'relative', paddingLeft: 28, paddingBottom: 14, minHeight: 32 },
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
  dotRunning: { color: '#ff9800', fontSize: 10 },
  dotDone: { color: '#4caf50', fontSize: 10 },
  dotError: { color: '#e94560', fontSize: 10, fontWeight: 700 },
  dotWaiting: { color: '#404060', fontSize: 10 },
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
    backgroundColor: '#1a1a2e',
    borderRadius: 4,
    fontSize: 11,
  },
  toolName: { fontFamily: "'Cascadia Code', 'Consolas', monospace", color: '#e0e0e0' },
  toolMeta: { color: '#606080', fontSize: 10, marginTop: 1 },
  empty: { padding: '8px 14px', color: '#505060', fontSize: 12, fontStyle: 'italic' },
};

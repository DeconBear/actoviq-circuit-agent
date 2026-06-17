import type { CSSProperties } from 'react';
import { useAppStore } from '../../store/appStore';

interface Props {
  onOpenTab: (tab: 'svg' | 'netlist' | 'simulation' | 'report') => void;
  onOpenChat: () => void;
  onOpenReferences: () => void;
}

export function ResultWorkbench({ onOpenTab, onOpenChat, onOpenReferences }: Props) {
  const activeJobId = useAppStore((s) => s.activeJobId);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const svgContent = useAppStore((s) => s.svgContent);
  const netlistContent = useAppStore((s) => s.netlistContent);
  const reportContent = useAppStore((s) => s.reportContent);
  const simulationData = useAppStore((s) => s.simulationData);
  const moduleManifest = useAppStore((s) => s.moduleManifest);
  const isRunning = useAppStore((s) => s.isRunning);

  const passCount = simulationData?.filter((entry) => entry.pass).length ?? 0;
  const metricCount = simulationData?.length ?? 0;

  return (
    <div style={styles.container}>
      <div style={styles.headerBand}>
        <div>
          <div style={styles.eyebrow}>Circuit Design Workspace</div>
          <h1 style={styles.title}>{activeJobId ?? 'No design selected'}</h1>
          <div style={styles.subtitle}>
            {activeWorkspace ? activeWorkspace.root : 'Loading workspace...'}
          </div>
        </div>
        <div style={styles.headerActions}>
          <button onClick={onOpenReferences} style={styles.secondaryBtn}>References</button>
          <button onClick={onOpenChat} style={styles.primaryBtn}>Open Chat</button>
        </div>
      </div>

      <div style={styles.body}>
        <div style={styles.viewerPanel}>
          {svgContent ? (
            <>
              <div style={styles.panelToolbar}>
                <span style={styles.panelTitle}>Schematic Preview</span>
                <button onClick={() => onOpenTab('svg')} style={styles.linkBtn}>Open SVG</button>
              </div>
              <div style={styles.svgPreview} dangerouslySetInnerHTML={{ __html: sanitizeSvg(svgContent) }} />
            </>
          ) : (
            <div style={styles.emptyViewer}>
              <div style={styles.emptyTitle}>Waiting for a schematic</div>
              <div style={styles.emptyText}>
                Use Claude Code, Codex, or the built-in chat workflow to generate a job in this workspace.
                Results under `jobs/` will appear here.
              </div>
              <button onClick={onOpenChat} style={styles.primaryBtn}>Start from Chat</button>
            </div>
          )}
        </div>

        <div style={styles.sidePanel}>
          <StatusRow label="Agent Job" value={isRunning ? 'Running' : activeJobId ? 'Ready' : 'Idle'} tone={isRunning ? 'warn' : 'ok'} />
          <StatusRow label="Schematic" value={svgContent ? 'Available' : 'Missing'} tone={svgContent ? 'ok' : 'muted'} />
          <StatusRow label="Netlist" value={netlistContent ? 'Available' : 'Missing'} tone={netlistContent ? 'ok' : 'muted'} />
          <StatusRow
            label="Simulation"
            value={metricCount > 0 ? `${passCount}/${metricCount} pass` : 'No metrics'}
            tone={metricCount > 0 && passCount === metricCount ? 'ok' : metricCount > 0 ? 'warn' : 'muted'}
          />
          <StatusRow label="Report" value={reportContent ? 'Available' : 'Missing'} tone={reportContent ? 'ok' : 'muted'} />
          <StatusRow
            label="Modules"
            value={moduleManifest
              ? `${moduleManifest.module_count} blocks / ${moduleManifest.component_count} parts`
              : 'Single block'}
            tone={moduleManifest?.strategy === 'partitioned' ? 'ok' : 'muted'}
          />

          <div style={styles.quickActions}>
            <button onClick={() => onOpenTab('netlist')} style={styles.secondaryBtn} disabled={!netlistContent}>Netlist</button>
            <button onClick={() => onOpenTab('simulation')} style={styles.secondaryBtn} disabled={!simulationData}>Simulation</button>
            <button onClick={() => onOpenTab('report')} style={styles.secondaryBtn} disabled={!reportContent}>Report</button>
          </div>

          <div style={styles.agentNote}>
            Agent-native path: place generated jobs under this workspace's `jobs/` directory.
            The desktop refreshes from the job artifacts and shows the corresponding result here.
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'muted' }) {
  const color = tone === 'ok' ? '#267346' : tone === 'warn' ? '#a26108' : '#8a929d';
  return (
    <div style={styles.statusRow}>
      <span style={styles.statusLabel}>{label}</span>
      <span style={{ ...styles.statusValue, color }}>{value}</span>
    </div>
  );
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, '');
}

const styles: Record<string, CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  headerBand: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #dfe3e8',
    gap: 16,
  },
  eyebrow: { fontSize: 11, color: '#7b8490', textTransform: 'uppercase', letterSpacing: '0.5px' },
  title: { fontSize: 20, margin: '3px 0', color: '#303741', fontWeight: 700 },
  subtitle: { fontSize: 12, color: '#7b8490', wordBreak: 'break-all' },
  headerActions: { display: 'flex', gap: 8, flexShrink: 0 },
  body: { flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', minHeight: 0 },
  viewerPanel: { minWidth: 0, display: 'flex', flexDirection: 'column', backgroundColor: '#f3f5f7' },
  panelToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 14px',
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #dfe3e8',
  },
  panelTitle: { fontSize: 12, color: '#59636e', fontWeight: 600 },
  svgPreview: {
    flex: 1,
    margin: 18,
    padding: 16,
    overflow: 'auto',
    backgroundColor: '#fff',
    borderRadius: 6,
  },
  emptyViewer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    padding: 32,
    color: '#7b8490',
    textAlign: 'center',
  },
  emptyTitle: { color: '#303741', fontSize: 17, fontWeight: 700 },
  emptyText: { maxWidth: 560, fontSize: 13, lineHeight: 1.6 },
  sidePanel: {
    borderLeft: '1px solid #dfe3e8',
    backgroundColor: '#ffffff',
    padding: 14,
    overflowY: 'auto',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid #eef0f2',
    gap: 12,
  },
  statusLabel: { color: '#69727d', fontSize: 12 },
  statusValue: { fontSize: 12, fontWeight: 700 },
  quickActions: { display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginTop: 16 },
  agentNote: {
    marginTop: 16,
    padding: 10,
    border: '1px solid #dfe3e8',
    borderRadius: 6,
    color: '#69727d',
    fontSize: 12,
    lineHeight: 1.5,
  },
  primaryBtn: {
    padding: '7px 14px',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
  },
  secondaryBtn: {
    padding: '7px 12px',
    backgroundColor: '#ffffff',
    color: '#3f4a56',
    border: '1px solid #c8cfd7',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
  },
  linkBtn: {
    background: 'transparent',
    color: '#2563eb',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  },
};

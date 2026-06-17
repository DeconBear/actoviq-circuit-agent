import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { useAppStore, type SimulationMetric } from '../../store/appStore';

export function SimulationTab() {
  const data = useAppStore((s) => s.simulationData);

  // Parse simulation output to extract waveform-like data
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return null;
    // Build a simple index-based chart from metrics for visualization
    return data.map((m, i) => ({
      name: m.name,
      measured: parseFloat(m.measured) || 0,
      target: parseFloat(m.target) || parseFloat(m.target.replace(/[^0-9.-]/g, '')) || 0,
      index: i,
    }));
  }, [data]);

  if (!data || data.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>📊</div>
        <div style={styles.emptyTitle}>No Simulation Data</div>
        <div style={styles.emptyDesc}>
          Run the simulation stage to see results.<br />
          Metrics and comparison charts will appear here.
        </div>
      </div>
    );
  }

  const passCount = data.filter((m) => m.pass).length;
  const overallPass = passCount === data.length;

  return (
    <div style={styles.container}>
      <div style={styles.summary}>
        <div style={{
          ...styles.summaryBadge,
          backgroundColor: overallPass ? '#edf8f1' : '#fff0f2',
          borderColor: overallPass ? '#68ad7e' : '#d58b95',
          color: overallPass ? '#267346' : '#a32d38',
        }}>
          {overallPass ? 'ALL PASS' : `${passCount}/${data.length} PASS`}
        </div>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Metric</th>
            <th style={styles.th}>Target</th>
            <th style={styles.th}>Measured</th>
            <th style={styles.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.name} style={styles.tr}>
              <td style={styles.td}>{row.name}</td>
              <td style={{ ...styles.td, ...styles.tdMono }}>{row.target}</td>
              <td style={{ ...styles.td, ...styles.tdMono }}>{row.measured}</td>
              <td style={styles.td}>
                <span style={{
                  ...styles.badge,
                  color: row.pass ? '#267346' : '#a32d38',
                  backgroundColor: row.pass ? '#edf8f1' : '#fff0f2',
                }}>
                  {row.pass ? 'PASS' : 'FAIL'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {chartData && chartData.length > 1 && (
        <div style={styles.chartSection}>
          <div style={styles.chartTitle}>Metrics Comparison</div>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dfe3e8" />
              <XAxis dataKey="name" stroke="#7b8490" tick={{ fontSize: 11 }} />
              <YAxis stroke="#7b8490" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #dfe3e8',
                  borderRadius: 4,
                  color: '#303741',
                }}
              />
              <Legend />
              <Line type="monotone" dataKey="target" stroke="#c73b4a" name="Target" strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="measured" stroke="#267346" name="Measured" strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#f7f8fa', color: '#303741' },
  summary: { marginBottom: 16 },
  summaryBadge: {
    display: 'inline-block',
    padding: '8px 18px',
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    fontWeight: 700,
    fontSize: 14,
  },
  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 24 },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '2px solid #c8cfd7',
    color: '#69727d',
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
  },
  tr: { borderBottom: '1px solid #e5e8ec' },
  td: { padding: '8px 12px', fontSize: 13, color: '#303741' },
  tdMono: { fontFamily: "'Cascadia Code', 'Consolas', monospace", fontSize: 12 },
  badge: {
    padding: '2px 10px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
  },
  chartSection: { marginTop: 16 },
  chartTitle: { fontSize: 13, fontWeight: 600, color: '#59636e', marginBottom: 12 },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#8a929d',
    gap: 8,
  },
  emptyIcon: { fontSize: 40, opacity: 0.4 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: '#303741' },
  emptyDesc: { fontSize: 13, color: '#7b8490', textAlign: 'center', lineHeight: 1.6 },
};

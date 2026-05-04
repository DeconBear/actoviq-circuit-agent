interface SimulationMetric {
  name: string;
  target: string;
  measured: string;
  pass: boolean;
}

interface Props {
  data: SimulationMetric[] | null;
}

export function SimulationTab({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div style={styles.empty}>
        <p>No simulation data. Run the simulation stage to see results.</p>
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
          backgroundColor: overallPass ? '#1a3a1a' : '#4a1a1a',
          borderColor: overallPass ? '#4caf50' : '#e94560',
        }}>
          {overallPass ? '✓ ALL PASS' : `${passCount}/${data.length} PASS`}
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
                  color: row.pass ? '#4caf50' : '#e94560',
                  backgroundColor: row.pass ? '#1a3a1a' : '#4a1a1a',
                }}>
                  {row.pass ? 'PASS' : 'FAIL'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '20px 24px', overflowY: 'auto', height: '100%' },
  summary: { marginBottom: 16 },
  summaryBadge: {
    display: 'inline-block',
    padding: '8px 18px',
    borderRadius: 6,
    border: '1px solid',
    fontWeight: 700,
    fontSize: 14,
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '2px solid #0f3460',
    color: '#808090',
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
  },
  tr: { borderBottom: '1px solid #0f346033' },
  td: { padding: '8px 12px', fontSize: 13, color: '#e0e0e0' },
  tdMono: { fontFamily: "'Cascadia Code', 'Consolas', monospace", fontSize: 12 },
  badge: {
    padding: '2px 10px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
};

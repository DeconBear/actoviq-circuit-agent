interface Props {
  content: string;
}

export function ReportPreview({ content }: Props) {
  if (!content) {
    return (
      <div style={styles.empty}>
        <p>No report generated. Complete the summary stage to see the final report.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.label}>Final Summary Report</span>
      </div>
      <div style={styles.content}>
        <pre style={styles.pre}>{content}</pre>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 16px',
    backgroundColor: '#16213e',
    borderBottom: '1px solid #0f3460',
  },
  label: { fontSize: 12, color: '#a0a0b0' },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
  },
  pre: {
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
    fontSize: 13,
    lineHeight: 1.7,
    color: '#c9d1d9',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
};

import { useMemo } from 'react';
import { useAppStore } from '../../store/appStore';
import { createSafeMarkdownParser, escapeHtml } from '../../utils/markdown';

const reportMarkdown = createSafeMarkdownParser({
  highlightCode: true,
});

export function ReportPreview() {
  const content = useAppStore((s) => s.reportContent);

  const html = useMemo(() => {
    if (!content) return '';
    try {
      return reportMarkdown.parse(content) as string;
    } catch {
      return `<pre>${escapeHtml(content)}</pre>`;
    }
  }, [content]);

  if (!content) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>📋</div>
        <div style={styles.emptyTitle}>No Report Generated</div>
        <div style={styles.emptyDesc}>
          Complete the summary stage to see the final report.<br />
          The report includes design analysis, verification results, and recommendations.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.label}>Final Summary Report</span>
      </div>
      <div
        className="markdown-content"
        style={styles.content}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 16px',
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #dfe3e8',
  },
  label: { fontSize: 12, color: '#59636e', fontWeight: 650 },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
    color: '#303741',
    background: '#f7f8fa',
    fontSize: 13,
    lineHeight: 1.7,
  },
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

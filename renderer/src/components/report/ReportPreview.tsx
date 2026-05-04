import { useMemo } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { useAppStore } from '../../store/appStore';

// Configure marked with highlight.js
marked.setOptions({
  highlight: (code: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

export function ReportPreview() {
  const content = useAppStore((s) => s.reportContent);

  const html = useMemo(() => {
    if (!content) return '';
    try {
      return marked.parse(content) as string;
    } catch {
      return `<pre>${escapeHtml(content)}</pre>`;
    }
  }, [content]);

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
      <div
        className="markdown-content"
        style={styles.content}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    color: '#c9d1d9',
    fontSize: 13,
    lineHeight: 1.7,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
};

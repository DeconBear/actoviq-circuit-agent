import { useCallback, useState } from 'react';

interface Props {
  content: string;
  jobId: string | null;
}

export function NetlistEditor({ content, jobId }: Props) {
  const [edited, setEdited] = useState(content);
  const [saved, setSaved] = useState(false);

  const handleSave = useCallback(async () => {
    if (!jobId || !window.electronAPI) return;
    await window.electronAPI.writeJobFile(jobId, 'design/design.final.cir', edited);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [jobId, edited]);

  // Sync prop changes
  if (content !== edited && !saved) {
    // Only sync if content changed externally
    if (edited === '' || content !== edited) {
      // Keep local edits; sync only if empty
      if (!edited) setEdited(content);
    }
  }

  if (!content) {
    return (
      <div style={styles.empty}>
        <p>No netlist loaded. Run a design workflow to generate one.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>design/design.final.cir</span>
        <button onClick={handleSave} style={styles.saveBtn} disabled={!jobId}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </div>
      <textarea
        value={edited}
        onChange={(e) => setEdited(e.target.value)}
        style={styles.editor}
        spellCheck={false}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 16px',
    backgroundColor: '#16213e',
    borderBottom: '1px solid #0f3460',
  },
  fileName: { fontSize: 12, fontFamily: "'Cascadia Code', 'Consolas', monospace", color: '#a0a0b0' },
  saveBtn: {
    padding: '4px 14px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  editor: {
    flex: 1,
    backgroundColor: '#0d1117',
    color: '#c9d1d9',
    border: 'none',
    padding: '16px',
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    lineHeight: 1.6,
    resize: 'none',
    outline: 'none',
    tabSize: 2,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
};

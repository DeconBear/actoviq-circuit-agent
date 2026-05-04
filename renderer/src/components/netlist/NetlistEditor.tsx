import { useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '../../store/appStore';

export function NetlistEditor() {
  const content = useAppStore((s) => s.netlistContent);
  const jobId = useAppStore((s) => s.activeJobId);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const handleSave = useCallback(async () => {
    if (!jobId || !window.electronAPI || !editorRef.current) return;
    const value = editorRef.current.getValue();
    await window.electronAPI.writeJobFile(jobId, 'design/design.final.cir', value);
  }, [jobId]);

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
        <div style={styles.toolGroup}>
          <button onClick={handleSave} style={styles.saveBtn} disabled={!jobId}>
            Save (Ctrl+S)
          </button>
        </div>
      </div>
      <Editor
        height="100%"
        defaultLanguage="spice"
        theme="vs-dark"
        value={content}
        onMount={handleMount}
        options={{
          fontSize: 13,
          fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
          lineNumbers: 'on',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          readOnly: !jobId,
        }}
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
  toolGroup: { display: 'flex', gap: 8 },
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
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
};

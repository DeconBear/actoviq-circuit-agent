import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '../../store/appStore';

export function NetlistEditor() {
  const content = useAppStore((s) => s.netlistContent);
  const jobId = useAppStore((s) => s.activeJobId);
  const setNetlistContent = useAppStore((s) => s.setNetlistContent);
  const [draft, setDraft] = useState(content);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    setDraft(content);
    setDirty(false);
    setSaveStatus('idle');
    setSaveMessage('');
  }, [content, jobId]);

  const handleSave = useCallback(async () => {
    if (!jobId || !window.electronAPI || !editorRef.current) return;
    const value = editorRef.current.getValue();
    setSaveStatus('saving');
    setSaveMessage('Saving...');
    try {
      await window.electronAPI.writeJobFile(jobId, 'design/design.final.cir', value);
      setNetlistContent(value);
      setDraft(value);
      setDirty(false);
      setSaveStatus('saved');
      setSaveMessage('Saved');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveStatus('error');
      setSaveMessage(`Save failed: ${message}`);
    }
  }, [jobId, setNetlistContent]);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  if (!content) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>🔌</div>
        <div style={styles.emptyTitle}>No Netlist Loaded</div>
        <div style={styles.emptyDesc}>
          Run a design workflow to generate a SPICE netlist.<br />
          The netlist will appear here for viewing and editing.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>design/design.final.cir{dirty ? ' *' : ''}</span>
        <div style={styles.toolGroup}>
          {saveMessage && (
            <span style={{
              ...styles.saveStatus,
              ...(saveStatus === 'error' ? styles.saveStatusError : {}),
            }}>
              {saveMessage}
            </span>
          )}
          <button onClick={handleSave} style={styles.saveBtn} disabled={!jobId || saveStatus === 'saving'}>
            {saveStatus === 'saving' ? 'Saving...' : 'Save (Ctrl+S)'}
          </button>
        </div>
      </div>
      <Editor
        height="100%"
        defaultLanguage="spice"
        theme="vs-dark"
        value={draft}
        onChange={(value) => {
          const next = value ?? '';
          setDraft(next);
          setDirty(next !== content);
          if (saveStatus !== 'idle') {
            setSaveStatus('idle');
            setSaveMessage('');
          }
        }}
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
  saveStatus: {
    alignSelf: 'center',
    fontSize: 12,
    color: '#4caf50',
    maxWidth: 260,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  saveStatusError: { color: '#e94560' },
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
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
    gap: 8,
  },
  emptyIcon: { fontSize: 40, opacity: 0.4 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: '#808090' },
  emptyDesc: { fontSize: 13, color: '#505060', textAlign: 'center', lineHeight: 1.6 },
};

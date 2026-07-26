import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '../../store/appStore';

interface HdlSymbol {
  name: string;
  line: number;
}

function inspectVerilog(content: string): { diagnostics: string[]; symbols: HdlSymbol[] } {
  const diagnostics: string[] = [];
  const symbols: HdlSymbol[] = [];
  let moduleCount = 0;
  let endmoduleCount = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const moduleMatch = line.match(/^\s*module\s+([A-Za-z_][A-Za-z0-9_$]*)\b/);
    if (moduleMatch) {
      moduleCount += 1;
      symbols.push({ name: moduleMatch[1]!, line: index + 1 });
    }
    if (/^\s*endmodule\b/.test(line)) endmoduleCount += 1;
  }
  if (moduleCount !== endmoduleCount) {
    diagnostics.push(`module/endmodule count differs (${moduleCount}/${endmoduleCount})`);
  }
  if (!moduleCount && content.trim()) diagnostics.push('No Verilog module declaration found');
  return { diagnostics, symbols };
}

export function HdlEditor() {
  const projectId = useAppStore((state) => state.activeProjectId);
  const bundle = useAppStore((state) => state.circuitProject);
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState('');
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const forcePlainEditor = Boolean(window.electronAPI?.isE2E?.());

  useEffect(() => {
    let cancelled = false;
    async function loadFiles() {
      if (!projectId) {
        setFiles([]);
        setActiveFile('');
        return;
      }
      try {
        const next = await window.electronAPI.listHdlFiles(projectId);
        if (cancelled) return;
        setFiles(next);
        setActiveFile((current) => (
          current && next.includes(current)
            ? current
            : next.find((path) => path.endsWith('manifest.json')) ?? next[0] ?? ''
        ));
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
      }
    }
    void loadFiles();
    return () => { cancelled = true; };
  }, [projectId, bundle?.project.revision]);

  useEffect(() => {
    let cancelled = false;
    async function loadFile() {
      if (!projectId || !activeFile) {
        setDraft('');
        setSaved('');
        return;
      }
      try {
        const content = await window.electronAPI.readHdlFile(projectId, activeFile);
        if (cancelled) return;
        setDraft(content);
        setSaved(content);
        setStatus('');
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
      }
    }
    void loadFile();
    return () => { cancelled = true; };
  }, [activeFile, projectId]);

  const inspection = useMemo(
    () => activeFile.endsWith('.json')
      ? { diagnostics: [] as string[], symbols: [] as HdlSymbol[] }
      : inspectVerilog(draft),
    [activeFile, draft],
  );

  async function saveFile() {
    if (!projectId || !activeFile) return;
    setStatus('Saving…');
    try {
      await window.electronAPI.writeHdlFile(projectId, activeFile, draft);
      setSaved(draft);
      setStatus('Saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function jumpTo(symbol: HdlSymbol) {
    editorRef.current?.revealLineInCenter(symbol.line);
    editorRef.current?.setPosition({ lineNumber: symbol.line, column: 1 });
    editorRef.current?.focus();
  }

  if (!projectId) {
    return <div style={styles.empty}>Select a circuit project to open its HDL workspace.</div>;
  }
  if (!files.length) {
    return (
      <div style={styles.empty} data-testid="hdl-workspace-empty">
        <strong>No HDL manifest</strong>
        <span>Create <code>hdl/manifest.json</code> and Verilog sources in the project folder.</span>
      </div>
    );
  }

  return (
    <div style={styles.root} data-testid="hdl-workspace">
      <div style={styles.toolbar}>
        <select
          value={activeFile}
          onChange={(event) => setActiveFile(event.target.value)}
          style={styles.select}
          aria-label="HDL source file"
        >
          {files.map((file) => <option key={file} value={file}>{file}</option>)}
        </select>
        <div style={styles.symbols}>
          {inspection.symbols.map((symbol) => (
            <button key={`${symbol.name}:${symbol.line}`} style={styles.symbol} onClick={() => jumpTo(symbol)}>
              {symbol.name}:{symbol.line}
            </button>
          ))}
        </div>
        <span style={inspection.diagnostics.length ? styles.error : styles.status}>
          {inspection.diagnostics.join('; ') || status || 'Verilog-2005 workspace'}
        </span>
        <button
          style={styles.save}
          onClick={() => void saveFile()}
          disabled={draft === saved}
          data-testid="save-hdl-file"
        >
          Save
        </button>
      </div>
      <div style={styles.editor}>
        {forcePlainEditor ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            style={styles.textarea}
            data-testid="hdl-source-editor"
          />
        ) : (
          <Editor
            height="100%"
            language={activeFile.endsWith('.json') ? 'json' : 'verilog'}
            theme="vs"
            value={draft}
            onChange={(value) => setDraft(value ?? '')}
            onMount={(editor) => { editorRef.current = editor; }}
            options={{
              automaticLayout: true,
              fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
              fontSize: 13,
              minimap: { enabled: false },
              tabSize: 2,
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' },
  toolbar: {
    minHeight: 52,
    padding: '8px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    borderBottom: '1px solid #dfe3e8',
  },
  select: { minWidth: 220, padding: '6px 8px', border: '1px solid #cbd2da', borderRadius: 5 },
  symbols: { display: 'flex', gap: 4, flex: 1, overflow: 'auto' },
  symbol: { border: 0, color: '#1f5fbf', background: '#eaf2ff', borderRadius: 4, padding: '4px 7px' },
  status: { color: '#66717e', fontSize: 11 },
  error: { color: '#a32d38', fontSize: 11 },
  save: { padding: '6px 14px', border: 0, borderRadius: 5, background: '#2563eb', color: '#fff' },
  editor: { flex: 1, minHeight: 0 },
  textarea: {
    width: '100%',
    height: '100%',
    resize: 'none',
    border: 0,
    outline: 0,
    padding: 14,
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: 13,
  },
  empty: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    color: '#66717e',
  },
};

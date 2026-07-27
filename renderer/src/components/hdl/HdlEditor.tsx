import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '../../store/appStore';
import type { HdlVerificationRun } from '../../types';

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
  const [reloadIndex, setReloadIndex] = useState(0);
  const [runBusy, setRunBusy] = useState(false);
  const [verificationRun, setVerificationRun] = useState<HdlVerificationRun | null>(null);
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
  }, [projectId, bundle?.project.revision, reloadIndex]);

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

  async function initializeWorkspace() {
    if (!projectId) return;
    setStatus('Creating HDL workspace...');
    try {
      await window.electronAPI.initializeHdlWorkspace(projectId);
      setReloadIndex((current) => current + 1);
      setStatus('HDL workspace created');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function createFile() {
    if (!projectId) return;
    const relativePath = window.prompt('New HDL path inside hdl/ (for example rtl/control.v):', 'new_module.v')?.trim();
    if (!relativePath) return;
    setStatus('Creating HDL file...');
    try {
      await window.electronAPI.createHdlFile(projectId, relativePath);
      setReloadIndex((current) => current + 1);
      setActiveFile(relativePath.replace(/\\/g, '/'));
      setStatus('HDL file created');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function runHdl(action: 'simulate' | 'synthesize' | 'gate-regression') {
    if (!projectId || draft !== saved || inspection.diagnostics.length) return;
    setRunBusy(true);
    setVerificationRun(null);
    setStatus(action === 'simulate' ? 'Running Icarus simulation...'
      : action === 'synthesize' ? 'Running Yosys synthesis...' : 'Running synthesis and gate regression...');
    try {
      const result = await window.electronAPI.runHdlAction(projectId, action);
      setVerificationRun(result);
      setStatus(`${result.provider_id}: ${result.status}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunBusy(false);
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
        <span>Initialize a Verilog-2005 workspace with a manifest and top module.</span>
        <button style={styles.primaryAction} onClick={() => void initializeWorkspace()} data-testid="initialize-hdl-workspace">
          Initialize HDL workspace
        </button>
        {status ? <span style={styles.error}>{status}</span> : null}
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
        <button style={styles.secondaryAction} onClick={() => void createFile()} data-testid="create-hdl-file">
          New file
        </button>
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
      <div style={styles.runbar} data-testid="hdl-run-controls">
        <span style={styles.runHint}>
          {draft !== saved ? 'Save changes before running tools.'
            : inspection.diagnostics.length ? 'Resolve source diagnostics before running tools.'
              : 'Manifest controls the active source set, top, testbench, libraries, and defines.'}
        </span>
        <button
          style={styles.secondaryAction}
          onClick={() => void runHdl('simulate')}
          disabled={runBusy || draft !== saved || inspection.diagnostics.length > 0}
          data-testid="hdl-simulate"
        >
          Simulate
        </button>
        <button
          style={styles.secondaryAction}
          onClick={() => void runHdl('synthesize')}
          disabled={runBusy || draft !== saved || inspection.diagnostics.length > 0}
          data-testid="hdl-synthesize"
        >
          Synthesize
        </button>
        <button
          style={styles.primaryAction}
          onClick={() => void runHdl('gate-regression')}
          disabled={runBusy || draft !== saved || inspection.diagnostics.length > 0}
          data-testid="hdl-gate-regression"
        >
          Gate regression
        </button>
      </div>
      {verificationRun ? (
        <div
          style={verificationRun.status === 'passed' ? styles.runResultOk : styles.runResultError}
          data-testid="hdl-verification-result"
        >
          <strong>{verificationRun.kind}: {verificationRun.status}</strong>
          <span>Provider {verificationRun.provider_id}</span>
          <span>{verificationRun.artifacts.length} artifact{verificationRun.artifacts.length === 1 ? '' : 's'}</span>
          {verificationRun.diagnostics.slice(0, 2).map((diagnostic, index) => (
            <span key={`${index}-${diagnostic}`}>{diagnostic}</span>
          ))}
        </div>
      ) : null}
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
  runbar: {
    minHeight: 44,
    padding: '6px 12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    borderBottom: '1px solid #dfe3e8',
    background: '#f8fafc',
  },
  runHint: { flex: 1, color: '#66717e', fontSize: 11 },
  primaryAction: {
    padding: '7px 12px',
    border: 0,
    borderRadius: 5,
    background: '#2563eb',
    color: '#fff',
    fontWeight: 700,
  },
  secondaryAction: {
    padding: '6px 10px',
    border: '1px solid #cbd2da',
    borderRadius: 5,
    background: '#fff',
    color: '#34404d',
    fontWeight: 700,
  },
  runResultOk: {
    display: 'flex',
    gap: 12,
    padding: '7px 12px',
    borderBottom: '1px solid #b7dfc5',
    background: '#eefbf2',
    color: '#24663a',
    fontSize: 11,
  },
  runResultError: {
    display: 'flex',
    gap: 12,
    padding: '7px 12px',
    borderBottom: '1px solid #efc2c7',
    background: '#fff1f2',
    color: '#9f2734',
    fontSize: 11,
  },
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '../../store/appStore';
import { createSafeMarkdownParser, escapeHtml } from '../../utils/markdown';
import { createNetlistNotebook, extractNetlistCode } from '../../utils/netlistNotebook';

interface Props {
  onValidate?: () => void;
  onReloadProject?: (projectId: string) => Promise<void>;
  isWorkflowRunning?: boolean;
}

const notebookMarkdown = createSafeMarkdownParser({
  codeBlockClassName: 'netlist-code-block',
  highlightCode: true,
  showLanguageLabel: true,
});

export function NetlistEditor({
  onValidate,
  onReloadProject,
  isWorkflowRunning = false,
}: Props) {
  const netlistContent = useAppStore((state) => state.netlistContent);
  const jobId = useAppStore((state) => state.activeJobId);
  const projectId = useAppStore((state) => state.activeProjectId);
  const moduleId = useAppStore((state) => state.activeModuleId);
  const bundle = useAppStore((state) => state.circuitProject);
  const setNetlistContent = useAppStore((state) => state.setNetlistContent);
  const moduleRef = bundle?.project.modules.find((module) => module.id === moduleId);
  const modulePreview = moduleId ? bundle?.module_previews[moduleId] : undefined;
  const projectContext = Boolean(projectId && moduleId && bundle);
  const sourceKey = projectContext ? `project:${projectId}:${moduleId}` : `job:${jobId ?? ''}`;
  const [draft, setDraft] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [editorFallback, setEditorFallback] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const loadedSourceKeyRef = useRef('');
  const forcePlainEditor = Boolean(window.electronAPI?.isE2E?.());

  useEffect(() => {
    let cancelled = false;
    async function loadNotebook() {
      let value = '';
      if (projectContext) {
        value = modulePreview?.notebook ?? '';
      } else if (jobId) {
        const stored = await window.electronAPI.readJobFile(jobId, 'design/netlist-notebook.md');
        value = stored || createNetlistNotebook(
          'Circuit netlist',
          'This notebook documents the generated workflow netlist.',
          netlistContent,
        );
      }
      if (cancelled) return;
      const sourceChanged = loadedSourceKeyRef.current !== sourceKey;
      loadedSourceKeyRef.current = sourceKey;
      setDraft(value);
      setSavedValue(value);
      if (sourceChanged) {
        setSaveStatus('idle');
        setSaveMessage('');
        setMode('preview');
      }
    }
    void loadNotebook();
    return () => {
      cancelled = true;
    };
  }, [jobId, modulePreview?.notebook, netlistContent, projectContext, sourceKey]);

  const dirty = draft !== savedValue;
  const html = useMemo(() => {
    if (!draft) return '';
    try {
      return notebookMarkdown.parse(draft) as string;
    } catch {
      return `<pre>${escapeHtml(draft)}</pre>`;
    }
  }, [draft]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    const value = editorRef.current?.getValue() ?? draft;
    let netlist: string;
    try {
      netlist = extractNetlistCode(value);
    } catch (error) {
      setSaveStatus('error');
      setSaveMessage(error instanceof Error ? error.message : String(error));
      return false;
    }

    setSaveStatus('saving');
    setSaveMessage(projectContext ? 'Saving and rendering SVG...' : 'Saving notebook...');
    try {
      if (projectContext && projectId && moduleId) {
        const result = await window.electronAPI.saveCircuitModuleNotebook(projectId, moduleId, value);
        if (!result.render.ok) {
          throw new Error(result.render.error || 'netlistsvg could not render this code block.');
        }
        await onReloadProject?.(projectId);
      } else if (jobId) {
        await Promise.all([
          window.electronAPI.writeJobFile(jobId, 'design/netlist-notebook.md', value),
          window.electronAPI.writeJobFile(jobId, 'design/design.final.cir', netlist),
        ]);
      } else {
        return false;
      }
      setNetlistContent(netlist);
      setDraft(value);
      setSavedValue(value);
      setSaveStatus('saved');
      setSaveMessage(projectContext ? 'Saved and SVG refreshed' : 'Notebook saved');
      return true;
    } catch (error) {
      setSaveStatus('error');
      setSaveMessage(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [draft, jobId, moduleId, onReloadProject, projectContext, projectId, setNetlistContent]);

  const handleSaveAndValidate = useCallback(async () => {
    const saved = dirty ? await handleSave() : true;
    if (saved) onValidate?.();
  }, [dirty, handleSave, onValidate]);

  const handleBuildModule = useCallback(async () => {
    if (!projectId || !moduleId) return;
    setSaveStatus('saving');
    setSaveMessage('Building module notebook source...');
    try {
      await window.electronAPI.compileCircuitModule(projectId, moduleId);
      await onReloadProject?.(projectId);
      setSaveStatus('saved');
      setSaveMessage('Module built');
    } catch (error) {
      setSaveStatus('error');
      setSaveMessage(error instanceof Error ? error.message : String(error));
    }
  }, [moduleId, onReloadProject, projectId]);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    setEditorFallback(false);
  }, []);

  useEffect(() => {
    if (mode !== 'edit') {
      setEditorFallback(false);
      return undefined;
    }
    if (forcePlainEditor) {
      editorRef.current = null;
      setEditorFallback(false);
      return undefined;
    }
    editorRef.current = null;
    setEditorFallback(false);
    const timer = window.setTimeout(() => {
      if (!editorRef.current) setEditorFallback(true);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [forcePlainEditor, mode]);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (saveStatus !== 'idle') {
      setSaveStatus('idle');
      setSaveMessage('');
    }
  }, [saveStatus]);

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

  if (!draft) {
    return (
      <div style={styles.empty} data-testid="netlist-notebook-empty">
        <div style={styles.emptyTitle}>
          {projectContext ? 'Module netlist has not been built' : 'No netlist loaded'}
        </div>
        <div style={styles.emptyDesc}>
          {projectContext
            ? 'Build the selected Design module to create its Markdown netlist notebook.'
            : 'Select a completed workflow job to open its netlist notebook.'}
        </div>
        {projectContext && (
          <button style={styles.primaryBtn} onClick={() => void handleBuildModule()}>
            Build selected module
          </button>
        )}
      </div>
    );
  }

  const fileName = projectContext
    ? `modules/${moduleId}/netlist-notebook.md`
    : 'design/netlist-notebook.md';

  return (
    <div style={styles.container} data-testid="netlist-notebook">
      <div style={styles.toolbar}>
        <div style={styles.fileGroup}>
          <span style={styles.contextLabel}>
            {projectContext ? `${moduleRef?.name ?? moduleId} · Design module` : 'Workflow job'}
          </span>
          <span style={styles.fileName}>{fileName}{dirty ? ' *' : ''}</span>
        </div>
        <div style={styles.toolGroup}>
          <div style={styles.segmented}>
            <button
              style={{ ...styles.segmentBtn, ...(mode === 'edit' ? styles.segmentActive : {}) }}
              onClick={() => setMode('edit')}
              data-testid="netlist-mode-edit"
            >
              Edit
            </button>
            <button
              style={{ ...styles.segmentBtn, ...(mode === 'preview' ? styles.segmentActive : {}) }}
              onClick={() => setMode('preview')}
              data-testid="netlist-mode-preview"
            >
              Preview
            </button>
          </div>
          {saveMessage && (
            <span style={{
              ...styles.saveStatus,
              ...(saveStatus === 'error' ? styles.saveStatusError : {}),
            }}>
              {saveMessage}
            </span>
          )}
          <button
            onClick={() => void handleSave()}
            style={styles.primaryBtn}
            disabled={saveStatus === 'saving'}
            data-testid="save-netlist-notebook"
          >
            {projectContext ? 'Save & Render' : 'Save'}
          </button>
          {!projectContext && (
            <button
              onClick={() => void handleSaveAndValidate()}
              style={styles.secondaryBtn}
              disabled={saveStatus === 'saving' || isWorkflowRunning}
            >
              {isWorkflowRunning ? 'Workflow Running' : 'Save & Validate'}
            </button>
          )}
        </div>
      </div>
      {mode === 'edit' ? (
        forcePlainEditor || editorFallback ? (
          <textarea
            data-testid="netlist-notebook-editor"
            data-editor-kind={forcePlainEditor ? 'e2e-plain-text' : 'fallback'}
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            spellCheck={false}
            style={styles.fallbackEditor}
          />
        ) : (
          <Editor
            height="100%"
            defaultLanguage="markdown"
            theme="vs"
            value={draft}
            onChange={(value) => handleDraftChange(value ?? '')}
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
            }}
          />
        )
      ) : (
        <div
          className="markdown-content netlist-notebook-preview"
          style={styles.preview}
          dangerouslySetInnerHTML={{ __html: html }}
          data-testid="netlist-notebook-preview"
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', background: '#f7f8fa' },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 56,
    padding: '8px 16px',
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #dfe3e8',
    gap: 12,
  },
  fileGroup: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  contextLabel: { fontSize: 12, color: '#303741', fontWeight: 700 },
  fileName: { fontSize: 10, fontFamily: "'Cascadia Code', 'Consolas', monospace", color: '#7b8490' },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  segmented: { display: 'flex', border: '1px solid #cbd2da', borderRadius: 5, overflow: 'hidden' },
  segmentBtn: { border: 0, background: '#fff', color: '#606a75', padding: '5px 10px', cursor: 'pointer', fontSize: 11 },
  segmentActive: { background: '#eaf2ff', color: '#1f5fbf', fontWeight: 700 },
  saveStatus: { fontSize: 11, color: '#267346', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' },
  saveStatusError: { color: '#a32d38' },
  primaryBtn: {
    padding: '6px 14px',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: '1px solid #2563eb',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  },
  secondaryBtn: {
    padding: '6px 14px',
    backgroundColor: '#fff',
    color: '#3f4a56',
    border: '1px solid #c5ccd4',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 650,
  },
  preview: {
    flex: 1,
    overflowY: 'auto',
    padding: '28px max(32px, calc((100% - 920px) / 2)) 80px',
    color: '#303741',
    background: '#f7f8fa',
    fontSize: 14,
    lineHeight: 1.7,
  },
  fallbackEditor: {
    flex: 1,
    width: '100%',
    minHeight: 0,
    border: 0,
    outline: 'none',
    resize: 'none',
    padding: '16px 18px 80px',
    color: '#243041',
    background: '#ffffff',
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    fontSize: 13,
    lineHeight: 1.55,
    whiteSpace: 'pre',
    overflow: 'auto',
  },
  empty: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#69727d',
    gap: 10,
    background: '#f7f8fa',
    textAlign: 'center',
  },
  emptyTitle: { fontSize: 17, fontWeight: 700, color: '#303741' },
  emptyDesc: { fontSize: 13, color: '#7b8490', maxWidth: 480, lineHeight: 1.6 },
};

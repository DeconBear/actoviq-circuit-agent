import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, CircuitSkillStatus } from '../../types';

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [skillStatus, setSkillStatus] = useState<CircuitSkillStatus | null>(null);
  const [skillSyncing, setSkillSyncing] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) {
      setError('electronAPI not available — are you running in Electron?');
      setLoading(false);
      return;
    }
    Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getCircuitSkillStatus().catch(() => null),
    ])
      .then(([s, nextSkillStatus]) => {
        setSettings(s);
        setSkillStatus(nextSkillStatus);
        setLoading(false);
      })
      .catch((err) => {
        setError(`Failed to load settings: ${err?.message ?? String(err)}`);
        setLoading(false);
      });
  }, []);

  const syncSkill = useCallback(async () => {
    setSkillSyncing(true);
    setError(null);
    try {
      setSkillStatus(await window.electronAPI.syncCircuitSkill());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to sync circuit skill: ${message}`);
    } finally {
      setSkillSyncing(false);
    }
  }, []);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings || !window.electronAPI) return;
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.saveSettings(settings);
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to save: ${msg}`);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved settings changes?')) {
      return;
    }
    onClose();
  }, [dirty, onClose]);

  return (
    <div style={styles.overlay} onClick={requestClose} data-testid="settings-dialog">
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 style={styles.title}>Settings</h2>
          <button onClick={requestClose} style={styles.closeBtn} data-testid="settings-dialog-close">✕</button>
        </div>

        <div style={styles.body}>
          {loading && (
            <div style={styles.statusMsg}>Loading settings...</div>
          )}
          {error && (
            <div style={styles.errorMsg}>
              <p>{error}</p>
              <button onClick={() => setError(null)} style={styles.dismissBtn}>Dismiss</button>
            </div>
          )}
          {settings && (
            <>
              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Actoviq Provider (Anthropic-compatible)</h3>
                <Field label="Base URL" value={settings.actoviqBaseUrl} onChange={(v) => update('actoviqBaseUrl', v)} />
                <Field label="Auth Token" value={settings.actoviqAuthToken} onChange={(v) => update('actoviqAuthToken', v)} type="password" />
                <Field label="Opus Model" value={settings.opusModel} onChange={(v) => update('opusModel', v)} />
                <Field label="Sonnet Model" value={settings.sonnetModel} onChange={(v) => update('sonnetModel', v)} />
                <Field label="Haiku Model" value={settings.haikuModel} onChange={(v) => update('haikuModel', v)} />
              </section>

              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Tool Paths</h3>
                <Field label="ngspice Binary" value={settings.ngspiceBin} onChange={(v) => update('ngspiceBin', v)} placeholder="e.g. E:/Program/ngspice/bin/ngspice.exe" />
              </section>

              <section style={styles.section} data-testid="circuit-skill-status">
                <div style={styles.skillHeader}>
                  <h3 style={styles.sectionTitle}>Circuit Agent Skill</h3>
                  <button
                    type="button"
                    style={styles.syncBtn}
                    onClick={() => { void syncSkill(); }}
                    disabled={skillSyncing || skillStatus?.current}
                    data-testid="sync-circuit-skill"
                  >
                    {skillSyncing ? 'Syncing...' : skillStatus?.current ? 'Current' : 'Sync skill'}
                  </button>
                </div>
                {skillStatus ? (
                  <>
                    <div style={styles.skillVersion}>
                      Version {skillStatus.sourceVersion} | {skillStatus.protocolVersion}
                    </div>
                    {skillStatus.targets.map((target) => (
                      <div key={target.agent} style={styles.skillTarget} data-testid={`skill-target-${target.agent}`}>
                        <span>{target.agent}</span>
                        <strong style={{ color: target.status === 'current' ? '#267047' : '#9a5b10' }}>
                          {target.status}
                        </strong>
                      </div>
                    ))}
                  </>
                ) : (
                  <div style={styles.skillVersion}>Status unavailable</div>
                )}
              </section>

              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Workspace</h3>
                <Field label="Workspace Root" value={settings.workspaceRoot} onChange={(v) => update('workspaceRoot', v)} placeholder="Leave blank for default" />
              </section>

              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Yunzhisheng OCR</h3>
                <Field label="OCR Endpoint" value={settings.yunzhishengOcrBaseUrl} onChange={(v) => update('yunzhishengOcrBaseUrl', v)} placeholder="https://.../ocr" />
                <Field label="OCR API Key" value={settings.yunzhishengOcrApiKey} onChange={(v) => update('yunzhishengOcrApiKey', v)} type="password" />
                <Field label="OCR Model" value={settings.yunzhishengOcrModel} onChange={(v) => update('yunzhishengOcrModel', v)} placeholder="Optional model name" />
              </section>
            </>
          )}
        </div>

        {settings && (
          <div style={styles.footer}>
            <button onClick={handleSave} style={styles.saveBtn} disabled={saving || !dirty}>
              {saving ? 'Saving...' : saved ? 'Saved ✓' : dirty ? 'Save' : 'Saved'}
            </button>
            <button onClick={requestClose} style={styles.cancelBtn}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div style={fieldStyles.wrapper}>
      <label style={fieldStyles.label}>{label}</label>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={fieldStyles.input}
      />
    </div>
  );
}

const fieldStyles: Record<string, React.CSSProperties> = {
  wrapper: { marginBottom: 10 },
  label: { display: 'block', fontSize: 12, color: '#69727d', marginBottom: 4 },
  input: {
    width: '100%',
    padding: '6px 10px',
    backgroundColor: '#ffffff',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    color: '#303741',
    fontSize: 13,
    outline: 'none',
  },
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(32,42,56,0.24)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  dialog: {
    backgroundColor: '#ffffff',
    border: '1px solid #dfe3e8',
    borderRadius: 12,
    width: 520,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: '1px solid #dfe3e8',
  },
  title: { color: '#2563eb', fontSize: 18, margin: 0 },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 18,
  },
  body: { padding: '16px 24px', overflowY: 'auto', flex: 1 },
  statusMsg: { color: '#69727d', textAlign: 'center', padding: 24 },
  errorMsg: {
    backgroundColor: '#fff0f2',
    border: '1px solid #e7b8be',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 12,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    color: '#a32d38',
    fontSize: 13,
  },
  dismissBtn: {
    background: '#a32d38',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 13,
    color: '#2563eb',
    marginBottom: 12,
    marginTop: 0,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  skillHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  skillVersion: { color: '#68727e', fontSize: 11, marginBottom: 7 },
  skillTarget: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    borderTop: '1px solid #e8ebef',
    color: '#49535f',
    fontSize: 12,
    textTransform: 'capitalize',
  },
  syncBtn: {
    border: '1px solid #b9c1cb',
    borderRadius: 4,
    background: '#fff',
    color: '#35404b',
    padding: '5px 9px',
    cursor: 'pointer',
    fontSize: 11,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '12px 24px',
    borderTop: '1px solid #dfe3e8',
  },
  saveBtn: {
    padding: '8px 20px',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
  cancelBtn: {
    padding: '8px 20px',
    backgroundColor: 'transparent',
    color: '#59636e',
    border: '1px solid #c8cfd7',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
};

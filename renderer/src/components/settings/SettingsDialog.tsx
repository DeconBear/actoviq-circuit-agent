import { useCallback, useEffect, useState } from 'react';

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getSettings().then(setSettings);
    }
  }, []);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings || !window.electronAPI) return;
    await window.electronAPI.saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [settings]);

  if (!settings) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 style={styles.title}>Settings</h2>
          <button onClick={onClose} style={styles.closeBtn}>✕</button>
        </div>

        <div style={styles.body}>
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

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Workspace</h3>
            <Field label="Workspace Root" value={settings.workspaceRoot} onChange={(v) => update('workspaceRoot', v)} placeholder="Leave blank for default" />
          </section>
        </div>

        <div style={styles.footer}>
          <button onClick={handleSave} style={styles.saveBtn}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
        </div>
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
  label: { display: 'block', fontSize: 12, color: '#808090', marginBottom: 4 },
  input: {
    width: '100%',
    padding: '6px 10px',
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: 4,
    color: '#e0e0e0',
    fontSize: 13,
    outline: 'none',
  },
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  dialog: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
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
    borderBottom: '1px solid #0f3460',
  },
  title: { color: '#e94560', fontSize: 18, margin: 0 },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#a0a0b0',
    cursor: 'pointer',
    fontSize: 18,
  },
  body: { padding: '16px 24px', overflowY: 'auto', flex: 1 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 13,
    color: '#e94560',
    marginBottom: 12,
    marginTop: 0,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '12px 24px',
    borderTop: '1px solid #0f3460',
  },
  saveBtn: {
    padding: '8px 20px',
    backgroundColor: '#e94560',
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
    color: '#a0a0b0',
    border: '1px solid #0f3460',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
};

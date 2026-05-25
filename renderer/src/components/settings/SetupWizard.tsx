import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import type { AppSettings } from '../../types';

interface Props {
  onClose: () => void;
}

const STEPS = ['Provider', 'Tools', 'Ready'];

export function SetupWizard({ onClose }: Props) {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) {
      setError('electronAPI not available. Please run the app in Electron.');
      return;
    }
    window.electronAPI.getSettings().then((s) => {
      setSettings(s);
      // Auto-detect if setup is needed
      if (s.actoviqAuthToken) {
        onClose();
      }
    }).catch((err) => {
      setError(`Failed to load settings: ${err?.message ?? String(err)}`);
    });
  }, [onClose]);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const handleNext = () => {
    if (step === 0 && !settings?.actoviqAuthToken.trim()) {
      setError('Auth Token is required before continuing.');
      return;
    }
    setError(null);
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    }
  };

  const handleBack = () => {
    if (step > 0) {
      setStep((s) => s - 1);
    }
  };

  const handleFinish = async () => {
    if (settings && window.electronAPI) {
      setSaving(true);
      setError(null);
      try {
        await window.electronAPI.saveSettings(settings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to save settings: ${message}`);
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    onClose();
  };

  if (!settings) {
    return (
      <div style={styles.overlay}>
        <div style={styles.card}>
          <p style={error ? styles.loadingError : styles.loading}>
            {error ?? 'Loading settings...'}
          </p>
        </div>
      </div>
    );
  }

  const isLast = step === STEPS.length - 1;

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h2 style={styles.title}>Welcome to Actoviq Circuit Agent</h2>
          <p style={styles.subtitle}>Let's configure the essentials to get you started.</p>
        </div>

        <div style={styles.stepper}>
          {STEPS.map((label, i) => (
            <div key={label} style={styles.step}>
              <div style={{
                ...styles.stepDot,
                backgroundColor: i <= step ? '#e94560' : '#2a2a4a',
                color: i <= step ? '#fff' : '#606070',
              }}>
                {i < step ? '✓' : i + 1}
              </div>
              <div style={{
                ...styles.stepLabel,
                color: i <= step ? '#e0e0e0' : '#606070',
              }}>
                {label}
              </div>
              {i < STEPS.length - 1 && (
                <div style={{
                  ...styles.stepConnector,
                  backgroundColor: i < step ? '#e94560' : '#2a2a4a',
                }} />
              )}
            </div>
          ))}
        </div>

        <div style={styles.body}>
          {error && <div style={styles.errorMsg}>{error}</div>}
          {step === 0 && (
            <div>
              <h3 style={styles.sectionTitle}>Actoviq Provider (Anthropic-compatible API)</h3>
              <StepField label="Base URL" value={settings.actoviqBaseUrl} onChange={(v) => update('actoviqBaseUrl', v)} />
              <StepField label="Auth Token" value={settings.actoviqAuthToken} onChange={(v) => update('actoviqAuthToken', v)} type="password" placeholder="sk-ant-..." />
              <StepField label="Opus Model" value={settings.opusModel} onChange={(v) => update('opusModel', v)} />
              <StepField label="Sonnet Model" value={settings.sonnetModel} onChange={(v) => update('sonnetModel', v)} />
              <StepField label="Haiku Model" value={settings.haikuModel} onChange={(v) => update('haikuModel', v)} />
            </div>
          )}

          {step === 1 && (
            <div>
              <h3 style={styles.sectionTitle}>Tool Paths</h3>
              <StepField label="ngspice Binary" value={settings.ngspiceBin} onChange={(v) => update('ngspiceBin', v)} placeholder="e.g. E:/Program/ngspice/bin/ngspice.exe or /usr/bin/ngspice" />
              <StepField label="Workspace Root" value={settings.workspaceRoot} onChange={(v) => update('workspaceRoot', v)} placeholder="Leave blank for default" />
            </div>
          )}

          {step === 2 && (
            <div style={styles.readySection}>
              <h3 style={styles.sectionTitle}>You're all set!</h3>
              <div style={styles.summary}>
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>Base URL:</span>
                  <span style={styles.summaryValue}>{settings.actoviqBaseUrl}</span>
                </div>
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>Auth Token:</span>
                  <span style={styles.summaryValue}>
                    {settings.actoviqAuthToken ? 'Configured ✓' : 'Not set ✗'}
                  </span>
                </div>
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>ngspice:</span>
                  <span style={styles.summaryValue}>
                    {settings.ngspiceBin || 'Using PATH'}
                  </span>
                </div>
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>Workspace:</span>
                  <span style={styles.summaryValue}>
                    {settings.workspaceRoot || 'Default'}
                  </span>
                </div>
              </div>
              <p style={styles.hint}>
                You can always change these later in Settings (⚙ in the toolbar).
              </p>
            </div>
          )}
        </div>

        <div style={styles.footer}>
          {step > 0 && (
            <button onClick={handleBack} style={styles.secondaryBtn}>Back</button>
          )}
          <div style={styles.footerSpacer} />
          {!isLast ? (
            <button onClick={handleNext} style={styles.primaryBtn}>Next</button>
          ) : (
            <button onClick={handleFinish} style={styles.primaryBtn} disabled={saving}>
              {saving ? 'Saving...' : 'Get Started'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepField({ label, value, onChange, type, placeholder }: {
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
  wrapper: { marginBottom: 12 },
  label: { display: 'block', fontSize: 12, color: '#808090', marginBottom: 4 },
  input: {
    width: '100%',
    padding: '8px 12px',
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: 6,
    color: '#e0e0e0',
    fontSize: 13,
    outline: 'none',
  },
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 300,
  },
  card: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: 12,
    width: 560,
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    padding: '24px 32px 16px',
    borderBottom: '1px solid #0f3460',
  },
  title: { color: '#e94560', fontSize: 20, margin: '0 0 6px' },
  subtitle: { color: '#a0a0b0', fontSize: 13, margin: 0 },
  loading: { color: '#a0a0b0', textAlign: 'center', padding: 40 },
  loadingError: { color: '#e94560', textAlign: 'center', padding: 40 },
  errorMsg: {
    backgroundColor: '#4a1a1a',
    border: '1px solid #e94560',
    borderRadius: 6,
    color: '#e0e0e0',
    fontSize: 13,
    marginBottom: 12,
    padding: '8px 10px',
  },
  stepper: {
    display: 'flex',
    justifyContent: 'center',
    padding: '20px 32px',
    gap: 0,
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    position: 'relative',
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  },
  stepLabel: { fontSize: 12, fontWeight: 600 },
  stepConnector: {
    width: 48,
    height: 2,
    margin: '0 4px',
  },
  body: {
    padding: '8px 32px 16px',
    flex: 1,
    overflowY: 'auto',
  },
  sectionTitle: {
    fontSize: 14,
    color: '#e94560',
    marginBottom: 14,
    marginTop: 0,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  readySection: {},
  summary: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    padding: '12px 16px',
    marginBottom: 12,
  },
  summaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    borderBottom: '1px solid #0f346033',
  },
  summaryLabel: { fontSize: 12, color: '#808090' },
  summaryValue: { fontSize: 12, color: '#e0e0e0', fontFamily: "'Cascadia Code', 'Consolas', monospace", wordBreak: 'break-all' },
  hint: { fontSize: 12, color: '#606080', fontStyle: 'italic' },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '12px 32px',
    borderTop: '1px solid #0f3460',
  },
  footerSpacer: { flex: 1 },
  primaryBtn: {
    padding: '8px 24px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
  secondaryBtn: {
    padding: '8px 24px',
    backgroundColor: 'transparent',
    color: '#a0a0b0',
    border: '1px solid #0f3460',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
};

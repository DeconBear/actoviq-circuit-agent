import { useCallback, useEffect, useState } from 'react';
import type {
  ActoviqProviderPreset,
  AppSettings,
  CircuitSkillStatus,
  LayoutModelTestResult,
  ProviderTestResult,
} from '../../types';
import { SecretField } from './SecretField';

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
  const [testingProvider, setTestingProvider] = useState(false);
  const [providerTest, setProviderTest] = useState<ProviderTestResult | null>(null);
  const [testingLayoutModel, setTestingLayoutModel] = useState(false);
  const [layoutModelTest, setLayoutModelTest] = useState<LayoutModelTestResult | null>(null);

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
      .then(async ([s, nextSkillStatus]) => {
        let next = s;
        if (s.hasActoviqAuthToken && !s.actoviqAuthToken && window.electronAPI.revealActoviqAuthToken) {
          try {
            const revealed = await window.electronAPI.revealActoviqAuthToken();
            if (revealed) next = { ...s, actoviqAuthToken: revealed };
          } catch {
            // Keep the masked placeholder if reveal fails.
          }
        }
        setSettings(next);
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
    const invalidatesLayoutVerification = key === 'actoviqProvider'
      || key === 'actoviqBaseUrl'
      || key === 'layoutVisionModel';
    setSettings((prev) => (prev ? {
      ...prev,
      [key]: value,
      ...(key === 'actoviqAuthToken' ? { clearActoviqAuthToken: false } : {}),
      ...(invalidatesLayoutVerification ? {
        layoutVisionVerification: {
          status: 'unverified' as const,
          fingerprint: '',
        },
      } : {}),
    } : prev));
    setSaved(false);
    setDirty(true);
    setProviderTest(null);
    if (invalidatesLayoutVerification) setLayoutModelTest(null);
  }, []);

  const revealProviderKey = useCallback(async (): Promise<string | null> => {
    if (!window.electronAPI?.revealActoviqAuthToken) return null;
    try {
      return await window.electronAPI.revealActoviqAuthToken();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to reveal API key: ${message}`);
      return null;
    }
  }, []);

  const applyProviderPreset = useCallback((preset: ActoviqProviderPreset) => {
    setSettings((prev) => {
      if (!prev) return prev;
      if (preset === 'anthropic') {
        return {
          ...prev,
          actoviqProviderPreset: preset,
          actoviqProvider: 'anthropic',
          actoviqBaseUrl: 'https://api.anthropic.com',
          basicModel: 'claude-haiku-4-5-20251001',
          mediumModel: 'claude-sonnet-4-6',
          professionalModel: 'claude-opus-4-7',
          chatModel: 'claude-sonnet-4-6',
          reasoningModel: 'claude-opus-4-7',
          haikuModel: 'claude-haiku-4-5-20251001',
          sonnetModel: 'claude-sonnet-4-6',
          opusModel: 'claude-opus-4-7',
          layoutVisionVerification: { status: 'unverified', fingerprint: '' },
        };
      }
      if (preset === 'deepseek') {
        return {
          ...prev,
          actoviqProviderPreset: preset,
          actoviqProvider: 'openai',
          actoviqBaseUrl: 'https://api.deepseek.com',
          basicModel: 'deepseek-v4-flash',
          mediumModel: 'deepseek-v4-flash',
          professionalModel: 'deepseek-v4-pro',
          chatModel: 'deepseek-v4-flash',
          reasoningModel: 'deepseek-v4-pro',
          haikuModel: 'deepseek-v4-flash',
          sonnetModel: 'deepseek-v4-flash',
          opusModel: 'deepseek-v4-pro',
          layoutVisionVerification: { status: 'unverified', fingerprint: '' },
        };
      }
      const wasKnownPreset = prev.actoviqProviderPreset !== 'openai-compatible';
      return {
        ...prev,
        actoviqProviderPreset: preset,
        actoviqProvider: 'openai',
        actoviqBaseUrl: wasKnownPreset ? 'https://api.openai.com' : prev.actoviqBaseUrl,
        basicModel: wasKnownPreset ? 'gpt-4.1-mini' : prev.basicModel,
        mediumModel: wasKnownPreset ? 'gpt-4.1-mini' : prev.mediumModel,
        professionalModel: wasKnownPreset ? 'o3' : prev.professionalModel,
        chatModel: wasKnownPreset ? 'gpt-4.1-mini' : prev.chatModel,
        reasoningModel: wasKnownPreset ? 'o3' : prev.reasoningModel,
        haikuModel: wasKnownPreset ? 'gpt-4.1-mini' : prev.haikuModel,
        sonnetModel: wasKnownPreset ? 'gpt-4.1-mini' : prev.sonnetModel,
        opusModel: wasKnownPreset ? 'o3' : prev.opusModel,
        layoutVisionVerification: { status: 'unverified', fingerprint: '' },
      };
    });
    setSaved(false);
    setDirty(true);
    setProviderTest(null);
    setLayoutModelTest(null);
  }, []);

  const clearProviderKey = useCallback(() => {
    setSettings((prev) => prev ? {
      ...prev,
      actoviqAuthToken: '',
      hasActoviqAuthToken: false,
      maskedActoviqAuthToken: '',
      clearActoviqAuthToken: true,
    } : prev);
    setSaved(false);
    setDirty(true);
    setProviderTest(null);
  }, []);

  const handleTestProvider = useCallback(async () => {
    if (!settings || !window.electronAPI) return;
    setTestingProvider(true);
    setProviderTest(null);
    setError(null);
    try {
      setProviderTest(await window.electronAPI.testProviderSettings(settings));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setProviderTest({
        ok: false,
        provider: settings.actoviqProvider,
        model: settings.mediumModel || settings.chatModel,
        latencyMs: 0,
        error: message,
      });
    } finally {
      setTestingProvider(false);
    }
  }, [settings]);

  const handleTestLayoutModel = useCallback(async () => {
    if (!settings || !window.electronAPI) return;
    setTestingLayoutModel(true);
    setLayoutModelTest(null);
    setError(null);
    try {
      const result = await window.electronAPI.testLayoutModelSettings(settings);
      setLayoutModelTest(result);
      setSettings((prev) => prev ? {
        ...prev,
        layoutVisionVerification: result.ok ? {
          status: 'verified',
          fingerprint: result.fingerprint,
          verifiedAt: result.verifiedAt,
        } : {
          status: 'error',
          fingerprint: result.fingerprint,
          error: result.error ?? 'Image capability verification failed.',
        },
      } : prev);
      setSaved(false);
      setDirty(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const result: LayoutModelTestResult = {
        ok: false,
        status: 'error',
        provider: settings.actoviqProvider,
        model: settings.layoutVisionModel,
        fingerprint: settings.layoutVisionVerification.fingerprint,
        latencyMs: 0,
        error: message,
      };
      setLayoutModelTest(result);
      setSettings((prev) => prev ? {
        ...prev,
        layoutVisionVerification: {
          status: 'error',
          fingerprint: result.fingerprint,
          error: message,
        },
      } : prev);
      setDirty(true);
    } finally {
      setTestingLayoutModel(false);
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    if (!settings || !window.electronAPI) return;
    setSaving(true);
    setError(null);
    try {
      const draftToken = settings.actoviqAuthToken;
      const nextSettings = await window.electronAPI.saveSettings(settings);
      setSettings({
        ...nextSettings,
        actoviqAuthToken: draftToken || nextSettings.actoviqAuthToken,
      });
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
    <div className="av-modal-overlay" onClick={requestClose} data-testid="settings-dialog">
      <div className="av-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="av-modal__header">
          <div>
            <h2 className="av-modal__title">Settings</h2>
            <div className="av-modal__subtitle">Provider, models, tools, and workspace</div>
          </div>
          <button type="button" className="av-btn av-btn--secondary" onClick={requestClose} data-testid="settings-dialog-close">
            Close
          </button>
        </div>

        <div className="av-modal__body">
          {loading && <div className="av-form-hint" style={{ textAlign: 'center', padding: 24 }}>Loading settings...</div>}
          {error && (
            <div className="av-form-status av-form-status--error" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{error}</span>
              <button type="button" className="av-btn av-btn--secondary" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
          {settings && (
            <>
              <section className="av-form-section">
                <h3 className="av-form-section__title">Built-in agent provider</h3>
                <label className="av-form-field">
                  <span>Provider preset</span>
                  <select
                    value={settings.actoviqProviderPreset}
                    onChange={(event) => applyProviderPreset(event.target.value as ActoviqProviderPreset)}
                    className="av-settings-input"
                    data-testid="settings-provider-preset"
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai-compatible">Custom OpenAI-compatible</option>
                  </select>
                </label>
                <Field label="Base URL" value={settings.actoviqBaseUrl} onChange={(v) => update('actoviqBaseUrl', v)} />
                <SecretField
                  label="API key"
                  value={settings.actoviqAuthToken}
                  onChange={(v) => update('actoviqAuthToken', v)}
                  hasSavedSecret={settings.hasActoviqAuthToken && !settings.clearActoviqAuthToken}
                  onRevealSaved={revealProviderKey}
                  placeholder={settings.hasActoviqAuthToken && !settings.clearActoviqAuthToken
                    ? `${settings.maskedActoviqAuthToken} — leave blank to keep`
                    : 'Enter the provider API key'}
                  testId="settings-api-key"
                />
                <div className="av-form-meta">
                  <span>
                    {settings.hasActoviqAuthToken && !settings.clearActoviqAuthToken
                      ? settings.actoviqAuthTokenStorage === 'encrypted'
                        ? 'A key is saved in OS-protected storage.'
                        : 'A key is configured; secure storage is unavailable on this system.'
                      : 'No saved API key.'}
                  </span>
                  {settings.hasActoviqAuthToken && !settings.clearActoviqAuthToken && (
                    <button type="button" className="av-btn--danger-link" onClick={clearProviderKey}>Clear saved key</button>
                  )}
                </div>
              </section>

              <section className="av-form-section" data-testid="layout-vision-model-settings">
                <h3 className="av-form-section__title">LLM-assisted schematic layout</h3>
                <Field
                  label="Dedicated multimodal model"
                  value={settings.layoutVisionModel}
                  onChange={(value) => update('layoutVisionModel', value)}
                  placeholder="Enter a model that accepts image input"
                  testId="settings-layout-vision-model"
                />
                <p className="av-form-hint">
                  This model is used only by the isolated layout review loop. It must pass a real image-input
                  challenge before layout runs are enabled; ordinary text chat cannot access the visual layout tool.
                </p>
                <div className="av-form-meta">
                  <span>Capability status: {settings.layoutVisionVerification.status}</span>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void handleTestLayoutModel(); }}
                    disabled={testingLayoutModel || !settings.layoutVisionModel.trim()}
                    data-testid="settings-test-layout-model"
                  >
                    {testingLayoutModel ? 'Verifying image input...' : 'Verify multimodal model'}
                  </button>
                </div>
                <div
                  className={`av-form-status ${settings.layoutVisionVerification.status === 'verified'
                    ? 'av-form-status--ok'
                    : settings.layoutVisionVerification.status === 'error'
                      ? 'av-form-status--error'
                      : ''}`}
                  role="status"
                  data-testid="settings-layout-model-status"
                >
                  {settings.layoutVisionVerification.status === 'verified'
                    ? `Verified image input for ${settings.layoutVisionModel}${settings.layoutVisionVerification.verifiedAt
                      ? ` at ${new Date(settings.layoutVisionVerification.verifiedAt).toLocaleString()}`
                      : ''}.`
                    : settings.layoutVisionVerification.status === 'error'
                      ? settings.layoutVisionVerification.error ?? layoutModelTest?.error ?? 'Image capability verification failed.'
                      : 'Unverified. LLM-assisted layout is disabled until this exact provider, Base URL, and model pass.'}
                </div>
              </section>

              <section className="av-form-section">
                <h3 className="av-form-section__title">Chat model tiers</h3>
                <ModelTierField
                  label="Basic model"
                  value={settings.basicModel}
                  onChange={(v) => {
                    update('basicModel', v);
                    update('haikuModel', v);
                  }}
                  context1M={settings.basicContext1M}
                  onContext1MChange={(v) => update('basicContext1M', v)}
                  testId="settings-basic-model"
                />
                <ModelTierField
                  label="Medium model"
                  value={settings.mediumModel}
                  onChange={(v) => {
                    update('mediumModel', v);
                    update('chatModel', v);
                    update('sonnetModel', v);
                  }}
                  context1M={settings.mediumContext1M}
                  onContext1MChange={(v) => update('mediumContext1M', v)}
                  testId="settings-medium-model"
                />
                <ModelTierField
                  label="Professional model"
                  value={settings.professionalModel}
                  onChange={(v) => {
                    update('professionalModel', v);
                    update('reasoningModel', v);
                    update('opusModel', v);
                  }}
                  context1M={settings.professionalContext1M}
                  onContext1MChange={(v) => update('professionalContext1M', v)}
                  testId="settings-professional-model"
                />
                <p className="av-form-hint">
                  Check “1M context” for a 1M-token window; unchecked defaults to 200K.
                  Chat history is auto-compressed when it exceeds the selected limit.
                </p>
                <div className="av-form-meta">
                  <span>SDK adapter: {settings.actoviqProvider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}</span>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void handleTestProvider(); }}
                    disabled={testingProvider}
                    data-testid="settings-test-provider"
                  >
                    {testingProvider ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
                {providerTest && (
                  <div
                    className={`av-form-status ${providerTest.ok ? 'av-form-status--ok' : 'av-form-status--error'}`}
                    role="status"
                    data-testid="settings-provider-test-result"
                  >
                    {providerTest.ok
                      ? `Connected to ${providerTest.model} in ${providerTest.latencyMs} ms.`
                      : providerTest.error ?? 'Connection test failed.'}
                  </div>
                )}
              </section>

              <section className="av-form-section">
                <h3 className="av-form-section__title">Tool paths</h3>
                <Field label="ngspice binary" value={settings.ngspiceBin} onChange={(v) => update('ngspiceBin', v)} placeholder="e.g. E:/Program/ngspice/bin/ngspice.exe" />
              </section>

              <section className="av-form-section" data-testid="circuit-skill-status">
                <div className="av-form-section__header">
                  <h3 className="av-form-section__title">Circuit agent skill</h3>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void syncSkill(); }}
                    disabled={skillSyncing || skillStatus?.current}
                    data-testid="sync-circuit-skill"
                  >
                    {skillSyncing ? 'Syncing...' : skillStatus?.current ? 'Current' : 'Sync skill'}
                  </button>
                </div>
                {skillStatus ? (
                  <>
                    <p className="av-form-hint">Version {skillStatus.sourceVersion} | {skillStatus.protocolVersion}</p>
                    {skillStatus.targets.map((target) => (
                      <div key={target.agent} className="av-form-meta" data-testid={`skill-target-${target.agent}`}>
                        <span style={{ textTransform: 'capitalize', color: 'var(--av-text-secondary)' }}>{target.agent}</span>
                        <strong style={{ color: target.status === 'current' ? 'var(--av-success)' : 'var(--av-warning)' }}>
                          {target.status}
                        </strong>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="av-form-hint">Status unavailable</p>
                )}
              </section>

              <section className="av-form-section">
                <h3 className="av-form-section__title">Workspace</h3>
                <Field label="Workspace root" value={settings.workspaceRoot} onChange={(v) => update('workspaceRoot', v)} placeholder="Leave blank for default" />
              </section>

              <section className="av-form-section">
                <h3 className="av-form-section__title">立创商城 (LCSC)</h3>
                <SecretField
                  label="LCSC API key"
                  value={settings.lcscApiKey}
                  onChange={(v) => update('lcscApiKey', v)}
                  placeholder="Enter LCSC API key"
                  testId="settings-lcsc-api-key"
                />
                <SecretField
                  label="LCSC API secret"
                  value={settings.lcscApiSecret}
                  onChange={(v) => update('lcscApiSecret', v)}
                  placeholder="Enter LCSC API secret"
                  testId="settings-lcsc-api-secret"
                />
                <label className="av-form-check">
                  <input
                    type="checkbox"
                    checked={settings.lcscUseFallback}
                    onChange={(event) => update('lcscUseFallback', event.target.checked)}
                    data-testid="settings-lcsc-use-fallback"
                  />
                  Use non-production fallback search when API credentials are missing
                </label>
                <p className="av-form-hint">
                  Fallback mode is for development only and may return incomplete or stale part data.
                </p>
              </section>

              <section className="av-form-section">
                <h3 className="av-form-section__title">Yunzhisheng OCR</h3>
                <Field label="OCR endpoint" value={settings.yunzhishengOcrBaseUrl} onChange={(v) => update('yunzhishengOcrBaseUrl', v)} placeholder="https://.../ocr" />
                <SecretField
                  label="OCR API key"
                  value={settings.yunzhishengOcrApiKey}
                  onChange={(v) => update('yunzhishengOcrApiKey', v)}
                  placeholder="Enter OCR API key"
                  testId="settings-ocr-api-key"
                />
                <Field label="OCR model" value={settings.yunzhishengOcrModel} onChange={(v) => update('yunzhishengOcrModel', v)} placeholder="Optional model name" />
              </section>
            </>
          )}
        </div>

        {settings && (
          <div className="av-modal__footer">
            <button type="button" className="av-btn av-btn--secondary" onClick={requestClose}>Cancel</button>
            <button
              type="button"
              className="av-btn av-btn--primary"
              onClick={() => { void handleSave(); }}
              disabled={saving || !dirty}
            >
              {saving ? 'Saving...' : saved ? 'Saved ✓' : dirty ? 'Save' : 'Saved'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type, placeholder, testId }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <label className="av-form-field">
      <span>{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="av-settings-input"
        data-testid={testId}
      />
    </label>
  );
}

function ModelTierField({
  label,
  value,
  onChange,
  context1M,
  onContext1MChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  context1M: boolean;
  onContext1MChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <div className="av-form-row">
      <label className="av-form-field">
        <span>{label}</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="av-settings-input"
          data-testid={testId}
        />
      </label>
      <label className="av-form-check" title="Checked: 1M tokens. Unchecked: 200K tokens." style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={context1M}
          onChange={(e) => onContext1MChange(e.target.checked)}
          data-testid={`${testId}-1m`}
        />
        <span>1M context</span>
      </label>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type {
  ActoviqProviderPreset,
  AppSettings,
  CircuitSkillStatus,
  ExecutionProfileProbe,
  ExecutionProfileRegistry,
  IcDiagnostics,
  LayoutModelTestResult,
  ProviderTestResult,
  StoredExecutionProfile,
} from '../../types';
import { SecretField } from './SecretField';

interface Props {
  onClose: () => void;
}

const EXECUTION_PROVIDERS: Array<{
  id: StoredExecutionProfile['providerId'];
  label: string;
  environmentKeys: string[];
}> = [
  { id: 'ngspice', label: 'ngspice', environmentKeys: [] },
  { id: 'xyce', label: 'Xyce', environmentKeys: [] },
  { id: 'cadence_spectre', label: 'Cadence Spectre', environmentKeys: ['CDS_LIC_FILE', 'LM_LICENSE_FILE'] },
  { id: 'synopsys_primesim_hspice', label: 'Synopsys PrimeSim HSPICE', environmentKeys: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'] },
  { id: 'synopsys_primesim_xa', label: 'Synopsys PrimeSim XA', environmentKeys: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'] },
  { id: 'siemens_afs', label: 'Siemens AFS', environmentKeys: ['MGLS_LICENSE_FILE', 'LM_LICENSE_FILE'] },
  { id: 'cadence_xcelium_ams', label: 'Cadence Xcelium AMS', environmentKeys: ['CDS_LIC_FILE', 'LM_LICENSE_FILE'] },
  { id: 'synopsys_vcs_ams', label: 'Synopsys VCS AMS', environmentKeys: ['SNPSLMD_LICENSE_FILE', 'LM_LICENSE_FILE'] },
  { id: 'siemens_questa_ams', label: 'Siemens Questa AMS', environmentKeys: ['MGLS_LICENSE_FILE', 'LM_LICENSE_FILE'] },
];

function emptyExecutionProfile(): StoredExecutionProfile {
  const provider = EXECUTION_PROVIDERS[0]!;
  return {
    schema: 'actoviq.execution-profile.v1',
    id: '',
    providerId: provider.id,
    target: navigator.platform.toLowerCase().includes('win') ? 'local_windows' : 'local_linux',
    allowedRoots: [],
    environmentKeys: provider.environmentKeys,
    qualification: 'unverified',
  };
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
  const [icDiagnostics, setIcDiagnostics] = useState<IcDiagnostics | null>(null);
  const [testingIcTools, setTestingIcTools] = useState(false);
  const [pdkAdapter, setPdkAdapter] = useState<'ihp-sg13g2' | 'sky130' | 'gf180mcu' | 'commercial'>('ihp-sg13g2');
  const [pdkLicenseAccepted, setPdkLicenseAccepted] = useState(false);
  const [pdkImportStatus, setPdkImportStatus] = useState('');
  const [pendingPdk, setPendingPdk] = useState<{
    input: {
      root: string;
      adapter: typeof pdkAdapter;
      mappingFile?: string;
      revision?: string;
    };
    installation: Record<string, unknown>;
  } | null>(null);
  const [executionProfiles, setExecutionProfiles] = useState<ExecutionProfileRegistry | null>(null);
  const [executionDraft, setExecutionDraft] = useState<StoredExecutionProfile>(emptyExecutionProfile);
  const [executionProfileStatus, setExecutionProfileStatus] = useState('');
  const [executionProbe, setExecutionProbe] = useState<ExecutionProfileProbe | null>(null);
  const [savingExecutionProfile, setSavingExecutionProfile] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) {
      setError('electronAPI not available — are you running in Electron?');
      setLoading(false);
      return;
    }
    Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getCircuitSkillStatus().catch(() => null),
      window.electronAPI.listExecutionProfiles().catch(() => null),
    ])
      .then(async ([s, nextSkillStatus, profileRegistry]) => {
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
        setExecutionProfiles(profileRegistry);
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

  const handleIcDiagnostics = useCallback(async () => {
    setTestingIcTools(true);
    setError(null);
    try {
      setIcDiagnostics(await window.electronAPI.getIcDiagnostics());
    } catch (err: unknown) {
      setError(`IC diagnostics failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTestingIcTools(false);
    }
  }, []);

  const handlePdkImport = useCallback(async () => {
    setPdkImportStatus('');
    setPendingPdk(null);
    try {
      const root = await window.electronAPI.choosePdkRoot();
      if (!root) return;
      const mappingFile = pdkAdapter === 'commercial'
        ? await window.electronAPI.choosePdkMappingPack()
        : null;
      if (pdkAdapter === 'commercial' && !mappingFile) return;
      const scanned = await window.electronAPI.scanPdkInstallation({
        root,
        adapter: pdkAdapter,
        mappingFile: mappingFile || undefined,
      });
      setPendingPdk({
        input: {
          root,
          adapter: pdkAdapter,
          mappingFile: mappingFile || undefined,
        },
        installation: scanned.installation ?? {},
      });
      setPdkImportStatus('Scan complete. Review the discovered identity and capabilities before registering.');
    } catch (err: unknown) {
      setPdkImportStatus(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pdkAdapter]);

  const handleOpenPdkInstall = useCallback(async () => {
    if (pdkAdapter === 'commercial') {
      setPdkImportStatus('Commercial PDKs must be imported in place and are never downloaded by Actoviq.');
      return;
    }
    if (!pdkLicenseAccepted) {
      setPdkImportStatus('Review and accept the open PDK license before acquiring its source.');
      return;
    }
    const destination = await window.electronAPI.choosePdkInstallDestination();
    if (!destination) return;
    setPdkImportStatus('Acquiring the open PDK source and submodules. This can take several minutes...');
    setPendingPdk(null);
    try {
      const installed = await window.electronAPI.installOpenPdk({
        adapter: pdkAdapter,
        destination,
        licenseAccepted: true,
      });
      const revision = String(installed.receipt?.resolved_revision ?? '');
      const scanned = await window.electronAPI.scanPdkInstallation({
        root: destination,
        adapter: pdkAdapter,
        revision,
      });
      setPendingPdk({
        input: { root: destination, adapter: pdkAdapter, revision },
        installation: scanned.installation ?? {},
      });
      setPdkImportStatus('Source acquired. Review discovered capabilities, then confirm local registration.');
    } catch (err: unknown) {
      setPdkImportStatus(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pdkAdapter, pdkLicenseAccepted]);

  const confirmPdkImport = useCallback(async () => {
    if (!pendingPdk || !pdkLicenseAccepted) return;
    try {
      const registered = await window.electronAPI.registerPdkInstallation({
        ...pendingPdk.input,
        licenseAccepted: true,
      });
      setPdkImportStatus(`Registered ${String(
        registered.installation?.installation_id
        ?? pendingPdk.installation.installation_id
        ?? pdkAdapter,
      )}`);
      setPendingPdk(null);
      setPdkLicenseAccepted(false);
      await handleIcDiagnostics();
    } catch (err: unknown) {
      setPdkImportStatus(`Registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [handleIcDiagnostics, pdkAdapter, pdkLicenseAccepted, pendingPdk]);

  const updateExecutionDraft = useCallback(<K extends keyof StoredExecutionProfile>(
    key: K,
    value: StoredExecutionProfile[K],
  ) => {
    setExecutionDraft((current) => ({ ...current, [key]: value }));
    setExecutionProbe(null);
    setExecutionProfileStatus('');
  }, []);

  const handleExecutionProviderChange = useCallback((providerId: StoredExecutionProfile['providerId']) => {
    const provider = EXECUTION_PROVIDERS.find((entry) => entry.id === providerId)!;
    setExecutionDraft((current) => ({
      ...current,
      providerId,
      environmentKeys: provider.environmentKeys,
    }));
    setExecutionProbe(null);
    setExecutionProfileStatus('');
  }, []);

  const chooseExecutionRoot = useCallback(async () => {
    const root = await window.electronAPI.chooseWorkspaceRoot();
    if (root) updateExecutionDraft('allowedRoots', [root]);
  }, [updateExecutionDraft]);

  const saveExecutionDraft = useCallback(async () => {
    setSavingExecutionProfile(true);
    setExecutionProfileStatus('');
    try {
      const next = await window.electronAPI.saveExecutionProfile(executionDraft);
      setExecutionProfiles(next);
      setExecutionProfileStatus(`Saved execution profile ${executionDraft.id}.`);
    } catch (err: unknown) {
      setExecutionProfileStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingExecutionProfile(false);
    }
  }, [executionDraft]);

  const deleteExecutionDraft = useCallback(async () => {
    if (!executionDraft.id || !executionProfiles?.profiles.some((profile) => profile.id === executionDraft.id)) return;
    if (!window.confirm(`Delete execution profile ${executionDraft.id}?`)) return;
    try {
      const next = await window.electronAPI.deleteExecutionProfile(executionDraft.id);
      setExecutionProfiles(next);
      setExecutionDraft(emptyExecutionProfile());
      setExecutionProbe(null);
      setExecutionProfileStatus('Execution profile deleted.');
    } catch (err: unknown) {
      setExecutionProfileStatus(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [executionDraft.id, executionProfiles]);

  const probeExecutionDraft = useCallback(async () => {
    if (!executionDraft.id) return;
    setExecutionProfileStatus('Probing configured tool...');
    try {
      const result = await window.electronAPI.probeExecutionProfile(executionDraft.id);
      setExecutionProbe(result);
      setExecutionProfileStatus(result.available
        ? `Available: ${result.version || result.executable}`
        : `Probe failed: ${result.diagnostics.join('; ') || 'tool unavailable'}`);
    } catch (err: unknown) {
      setExecutionProbe(null);
      setExecutionProfileStatus(`Probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [executionDraft.id]);

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

              <section className="av-form-section" data-testid="ic-tool-diagnostics">
                <div className="av-form-section__header">
                  <h3 className="av-form-section__title">IC tools and PDKs</h3>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void handleIcDiagnostics(); }}
                    disabled={testingIcTools}
                    data-testid="run-ic-diagnostics"
                  >
                    {testingIcTools ? 'Probing…' : 'Run diagnostics'}
                  </button>
                </div>
                <p className="av-form-hint">
                  Probes are version-only. Commercial tools remain unverified until qualified in a licensed environment.
                </p>
                {icDiagnostics && (
                  <div data-testid="ic-diagnostics-result">
                    <div className="av-form-meta">
                      <span>Open simulation</span><strong>{icDiagnostics.features.openSimulation ? 'available' : 'missing'}</strong>
                    </div>
                    <div className="av-form-meta">
                      <span>Physical verification</span><strong>{icDiagnostics.features.physicalVerification ? 'available' : 'missing'}</strong>
                    </div>
                    <div className="av-form-meta">
                      <span>HDL flow</span><strong>{icDiagnostics.features.hdlFlow ? 'available' : 'missing'}</strong>
                    </div>
                    {icDiagnostics.tools.map((tool) => (
                      <div key={tool.id} className="av-form-meta" data-testid={`ic-tool-${tool.id}`}>
                        <span>{tool.label}</span>
                        <strong style={{ color: tool.available ? 'var(--av-success)' : 'var(--av-text-tertiary)' }}>
                          {tool.available
                            ? tool.domain === 'commercial' ? 'configured / unverified' : tool.version || 'available'
                            : 'not found'}
                        </strong>
                      </div>
                    ))}
                    <p className="av-form-hint">
                      Registered PDKs: {icDiagnostics.pdkRegistry.installations?.length ?? 0}
                    </p>
                  </div>
                )}
                <div className="av-form-meta" style={{ alignItems: 'center', gap: 8 }}>
                  <select
                    value={pdkAdapter}
                    onChange={(event) => setPdkAdapter(event.target.value as typeof pdkAdapter)}
                    className="av-settings-input"
                    aria-label="PDK adapter"
                    data-testid="pdk-adapter-select"
                  >
                    <option value="ihp-sg13g2">IHP SG13G2</option>
                    <option value="sky130">SKY130</option>
                    <option value="gf180mcu">GF180MCU (experimental)</option>
                    <option value="commercial">Commercial mapping pack</option>
                  </select>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void handlePdkImport(); }}
                    data-testid="import-local-pdk"
                  >
                    Scan local PDK
                  </button>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void handleOpenPdkInstall(); }}
                    disabled={pdkAdapter === 'commercial' || !pdkLicenseAccepted}
                    title={pdkAdapter === 'commercial'
                      ? 'Commercial PDK files must remain in the user-provided installation.'
                      : 'Clone the official open-PDK source into an empty local folder.'}
                    data-testid="install-open-pdk"
                  >
                    Acquire open PDK
                  </button>
                </div>
                {pendingPdk ? (
                  <div className="av-form-status" data-testid="pdk-scan-review">
                    <div className="av-form-meta">
                      <span>Installation</span>
                      <strong>{String(pendingPdk.installation.name ?? pendingPdk.installation.logical_id ?? 'Unknown')}</strong>
                    </div>
                    <div className="av-form-meta">
                      <span>ID</span>
                      <strong>{String(pendingPdk.installation.installation_id ?? 'Not generated')}</strong>
                    </div>
                    <div className="av-form-meta">
                      <span>Process</span>
                      <strong>{String(pendingPdk.installation.process ?? 'Unknown')}</strong>
                    </div>
                    <div className="av-form-meta">
                      <span>Support</span>
                      <strong>{String(pendingPdk.installation.support_status ?? 'Unqualified')}</strong>
                    </div>
                    <div className="av-form-meta">
                      <span>Capabilities found</span>
                      <strong>
                        {Object.values(
                          (pendingPdk.installation.capabilities ?? {}) as Record<string, unknown>,
                        ).filter(Boolean).length}
                      </strong>
                    </div>
                    <div className="av-form-meta">
                      <span>Mapped devices</span>
                      <strong>
                        {Array.isArray(
                          (pendingPdk.installation.device_catalog as { devices?: unknown[] } | undefined)?.devices,
                        )
                          ? (pendingPdk.installation.device_catalog as { devices: unknown[] }).devices.length
                          : 0}
                      </strong>
                    </div>
                    <p className="av-form-hint">
                      Root: {String(pendingPdk.installation.root ?? pendingPdk.input.root)}
                    </p>
                  </div>
                ) : null}
                <label className="av-form-check">
                  <input
                    type="checkbox"
                    checked={pdkLicenseAccepted}
                    onChange={(event) => setPdkLicenseAccepted(event.target.checked)}
                    data-testid="pdk-license-accepted"
                  />
                  I have reviewed and accept this PDK&apos;s license; keep all files in place.
                </label>
                {pendingPdk ? (
                  <div className="av-form-meta" style={{ justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      type="button"
                      className="av-btn av-btn--secondary"
                      onClick={() => {
                        setPendingPdk(null);
                        setPdkImportStatus('Registration cancelled; no registry changes were made.');
                      }}
                      data-testid="cancel-pdk-registration"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="av-btn av-btn--primary"
                      onClick={() => { void confirmPdkImport(); }}
                      disabled={!pdkLicenseAccepted}
                      data-testid="confirm-pdk-registration"
                    >
                      Confirm registration
                    </button>
                  </div>
                ) : null}
                {pdkImportStatus && <p className="av-form-hint" role="status">{pdkImportStatus}</p>}
              </section>

              <section className="av-form-section" data-testid="execution-profile-settings">
                <div className="av-form-section__header">
                  <h3 className="av-form-section__title">Licensed EDA execution profiles</h3>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => {
                      setExecutionDraft(emptyExecutionProfile());
                      setExecutionProbe(null);
                      setExecutionProfileStatus('');
                    }}
                    data-testid="new-execution-profile"
                  >
                    New profile
                  </button>
                </div>
                <p className="av-form-hint">
                  Profiles store tool paths and allowlists only. License values are read from the launch environment
                  and are never written to the project or this registry.
                </p>
                <div className="av-form-meta" style={{ alignItems: 'center', gap: 8 }}>
                  <select
                    className="av-settings-input"
                    value={executionDraft.id}
                    onChange={(event) => {
                      const selected = executionProfiles?.profiles.find((profile) => profile.id === event.target.value);
                      if (selected) {
                        setExecutionDraft(selected);
                        setExecutionProbe(null);
                        setExecutionProfileStatus('');
                      }
                    }}
                    aria-label="Saved execution profile"
                    data-testid="execution-profile-select"
                  >
                    <option value="">New profile</option>
                    {executionProfiles?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.id}</option>
                    ))}
                  </select>
                  <span>{executionProfiles?.profiles.length ?? 0} saved</span>
                </div>
                <Field
                  label="Profile ID"
                  value={executionDraft.id}
                  onChange={(value) => updateExecutionDraft('id', value)}
                  placeholder="spectre-local"
                  testId="execution-profile-id"
                />
                <label className="av-form-field">
                  <span className="av-form-field__label">Provider</span>
                  <select
                    className="av-settings-input"
                    value={executionDraft.providerId}
                    onChange={(event) => handleExecutionProviderChange(
                      event.target.value as StoredExecutionProfile['providerId'],
                    )}
                    data-testid="execution-profile-provider"
                  >
                    {EXECUTION_PROVIDERS.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.label}</option>
                    ))}
                  </select>
                </label>
                <label className="av-form-field">
                  <span className="av-form-field__label">Execution target</span>
                  <select
                    className="av-settings-input"
                    value={executionDraft.target}
                    onChange={(event) => updateExecutionDraft(
                      'target',
                      event.target.value as StoredExecutionProfile['target'],
                    )}
                    data-testid="execution-profile-target"
                  >
                    <option value="local_linux">Local Linux</option>
                    <option value="local_windows">Local Windows</option>
                    <option value="ssh_linux">SSH Linux</option>
                  </select>
                </label>
                <Field
                  label="Executable override"
                  value={executionDraft.executable ?? ''}
                  onChange={(value) => updateExecutionDraft('executable', value)}
                  placeholder="Leave blank to use the provider default"
                  testId="execution-profile-executable"
                />
                <div className="av-form-field">
                  <span className="av-form-field__label">Allowed local root</span>
                  <div className="av-form-meta" style={{ alignItems: 'center', gap: 8 }}>
                    <input
                      className="av-settings-input"
                      value={executionDraft.allowedRoots[0] ?? ''}
                      readOnly
                      placeholder="Choose a working directory"
                      data-testid="execution-profile-root"
                    />
                    <button type="button" className="av-btn av-btn--secondary" onClick={() => { void chooseExecutionRoot(); }}>
                      Choose
                    </button>
                  </div>
                </div>
                {executionDraft.target === 'ssh_linux' && (
                  <>
                    <Field
                      label="SSH host"
                      value={executionDraft.ssh?.host ?? ''}
                      onChange={(value) => updateExecutionDraft('ssh', {
                        host: value,
                        remoteWorkingDirectory: executionDraft.ssh?.remoteWorkingDirectory ?? '/work/actoviq',
                        ...(executionDraft.ssh?.executable ? { executable: executionDraft.ssh.executable } : {}),
                        ...(executionDraft.ssh?.scpExecutable ? { scpExecutable: executionDraft.ssh.scpExecutable } : {}),
                      })}
                      placeholder="eda-user@workstation"
                      testId="execution-profile-ssh-host"
                    />
                    <Field
                      label="Remote working directory"
                      value={executionDraft.ssh?.remoteWorkingDirectory ?? '/work/actoviq'}
                      onChange={(value) => updateExecutionDraft('ssh', {
                        host: executionDraft.ssh?.host ?? '',
                        remoteWorkingDirectory: value,
                        ...(executionDraft.ssh?.executable ? { executable: executionDraft.ssh.executable } : {}),
                        ...(executionDraft.ssh?.scpExecutable ? { scpExecutable: executionDraft.ssh.scpExecutable } : {}),
                      })}
                      placeholder="/work/actoviq"
                      testId="execution-profile-ssh-root"
                    />
                    <Field
                      label="SSH client (optional)"
                      value={executionDraft.ssh?.executable ?? ''}
                      onChange={(value) => updateExecutionDraft('ssh', {
                        host: executionDraft.ssh?.host ?? '',
                        remoteWorkingDirectory: executionDraft.ssh?.remoteWorkingDirectory ?? '/work/actoviq',
                        ...(value ? { executable: value } : {}),
                        ...(executionDraft.ssh?.scpExecutable ? { scpExecutable: executionDraft.ssh.scpExecutable } : {}),
                      })}
                      placeholder="ssh"
                      testId="execution-profile-ssh-executable"
                    />
                    <Field
                      label="SCP client (optional)"
                      value={executionDraft.ssh?.scpExecutable ?? ''}
                      onChange={(value) => updateExecutionDraft('ssh', {
                        host: executionDraft.ssh?.host ?? '',
                        remoteWorkingDirectory: executionDraft.ssh?.remoteWorkingDirectory ?? '/work/actoviq',
                        ...(executionDraft.ssh?.executable ? { executable: executionDraft.ssh.executable } : {}),
                        ...(value ? { scpExecutable: value } : {}),
                      })}
                      placeholder="scp"
                      testId="execution-profile-scp-executable"
                    />
                  </>
                )}
                <p className="av-form-hint">
                  Environment allowlist: {executionDraft.environmentKeys.join(', ') || 'none'}.
                  Qualification remains unverified until this exact tool version passes in a licensed environment.
                </p>
                <div className="av-form-meta" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    className="av-btn av-btn--danger-link"
                    onClick={() => { void deleteExecutionDraft(); }}
                    disabled={!executionProfiles?.profiles.some((profile) => profile.id === executionDraft.id)}
                    data-testid="delete-execution-profile"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => { void probeExecutionDraft(); }}
                    disabled={!executionProfiles?.profiles.some((profile) => profile.id === executionDraft.id)}
                    data-testid="probe-execution-profile"
                  >
                    Probe saved profile
                  </button>
                  <button
                    type="button"
                    className="av-btn av-btn--primary"
                    onClick={() => { void saveExecutionDraft(); }}
                    disabled={savingExecutionProfile || !executionDraft.id || !executionDraft.allowedRoots.length}
                    data-testid="save-execution-profile"
                  >
                    {savingExecutionProfile ? 'Saving...' : 'Save profile'}
                  </button>
                </div>
                {executionProfileStatus && (
                  <div
                    className={`av-form-status ${executionProbe?.available ? 'av-form-status--ok' : ''}`}
                    role="status"
                    data-testid="execution-profile-status"
                  >
                    {executionProfileStatus}
                  </div>
                )}
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

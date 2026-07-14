import { IpcMain, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createAgentSdk } from 'actoviq-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type ActoviqProvider = 'anthropic' | 'openai';
export type ActoviqProviderPreset = 'anthropic' | 'deepseek' | 'openai-compatible';
export type SecretStorageMode = 'encrypted' | 'plaintext-fallback' | 'environment' | 'none';

export interface AppSettings {
  actoviqProvider: ActoviqProvider;
  actoviqProviderPreset: ActoviqProviderPreset;
  actoviqBaseUrl: string;
  /** Renderer input only. The main process never returns the saved token here. */
  actoviqAuthToken: string;
  hasActoviqAuthToken: boolean;
  maskedActoviqAuthToken: string;
  clearActoviqAuthToken?: boolean;
  actoviqAuthTokenStorage: SecretStorageMode;
  chatModel: string;
  reasoningModel: string;
  /** Legacy model tiers retained for existing workflow/config consumers. */
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
  yunzhishengOcrBaseUrl: string;
  yunzhishengOcrApiKey: string;
  yunzhishengOcrModel: string;
}

export type PersistedAppSettings = Omit<
  AppSettings,
  'hasActoviqAuthToken' | 'maskedActoviqAuthToken' | 'clearActoviqAuthToken' | 'actoviqAuthTokenStorage'
> & {
  /** Decrypted secret. This type must only be used in the Electron main process. */
  actoviqAuthToken: string;
  actoviqAuthTokenStorage: SecretStorageMode;
};

export interface ProviderTestResult {
  ok: boolean;
  provider: ActoviqProvider;
  model: string;
  latencyMs: number;
  error?: string;
}

interface StoredSettings extends Partial<PersistedAppSettings> {
  schema?: string;
  actoviqAuthTokenEncrypted?: string;
}

const settingsDir = path.resolve(homedir(), '.actoviq');
const settingsPath = path.join(settingsDir, 'actoviq-circuit-agent-desktop.json');

const defaultSettings: PersistedAppSettings = {
  actoviqProvider: 'anthropic',
  actoviqProviderPreset: 'anthropic',
  actoviqBaseUrl: 'https://api.anthropic.com',
  actoviqAuthToken: '',
  actoviqAuthTokenStorage: 'none',
  chatModel: 'claude-sonnet-4-6',
  reasoningModel: 'claude-opus-4-7',
  opusModel: 'claude-opus-4-7',
  sonnetModel: 'claude-sonnet-4-6',
  haikuModel: 'claude-haiku-4-5-20251001',
  ngspiceBin: '',
  workspaceRoot: '',
  yunzhishengOcrBaseUrl: '',
  yunzhishengOcrApiKey: '',
  yunzhishengOcrModel: '',
};

function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function inferPreset(raw: StoredSettings): ActoviqProviderPreset {
  if (raw.actoviqProviderPreset === 'anthropic'
    || raw.actoviqProviderPreset === 'deepseek'
    || raw.actoviqProviderPreset === 'openai-compatible') {
    return raw.actoviqProviderPreset;
  }
  if (String(raw.actoviqBaseUrl ?? '').toLowerCase().includes('deepseek')) {
    return 'deepseek';
  }
  return raw.actoviqProvider === 'openai' ? 'openai-compatible' : 'anthropic';
}

function normalizeStoredSettings(raw: StoredSettings, authToken: string, storage: SecretStorageMode): PersistedAppSettings {
  const preset = inferPreset(raw);
  const provider: ActoviqProvider = preset === 'anthropic' ? 'anthropic' : 'openai';
  const isDeepSeek = preset === 'deepseek';
  const legacySonnet = typeof raw.sonnetModel === 'string' && raw.sonnetModel.trim()
    ? raw.sonnetModel.trim()
    : defaultSettings.sonnetModel;
  const legacyOpus = typeof raw.opusModel === 'string' && raw.opusModel.trim()
    ? raw.opusModel.trim()
    : defaultSettings.opusModel;

  return {
    ...defaultSettings,
    actoviqProvider: provider,
    actoviqProviderPreset: preset,
    actoviqBaseUrl: (typeof raw.actoviqBaseUrl === 'string' && raw.actoviqBaseUrl.trim())
      ? raw.actoviqBaseUrl.trim()
      : isDeepSeek ? 'https://api.deepseek.com' : defaultSettings.actoviqBaseUrl,
    actoviqAuthToken: authToken,
    actoviqAuthTokenStorage: authToken ? storage : 'none',
    chatModel: (typeof raw.chatModel === 'string' && raw.chatModel.trim())
      ? raw.chatModel.trim()
      : isDeepSeek ? 'deepseek-chat' : legacySonnet,
    reasoningModel: (typeof raw.reasoningModel === 'string' && raw.reasoningModel.trim())
      ? raw.reasoningModel.trim()
      : isDeepSeek ? 'deepseek-reasoner' : legacyOpus,
    opusModel: legacyOpus,
    sonnetModel: legacySonnet,
    haikuModel: typeof raw.haikuModel === 'string' && raw.haikuModel.trim()
      ? raw.haikuModel.trim()
      : defaultSettings.haikuModel,
    ngspiceBin: typeof raw.ngspiceBin === 'string' ? raw.ngspiceBin : '',
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
    yunzhishengOcrBaseUrl: typeof raw.yunzhishengOcrBaseUrl === 'string' ? raw.yunzhishengOcrBaseUrl : '',
    yunzhishengOcrApiKey: typeof raw.yunzhishengOcrApiKey === 'string' ? raw.yunzhishengOcrApiKey : '',
    yunzhishengOcrModel: typeof raw.yunzhishengOcrModel === 'string' ? raw.yunzhishengOcrModel : '',
  };
}

function decryptStoredToken(raw: StoredSettings): { token: string; storage: SecretStorageMode; legacyPlaintext: boolean } {
  if (typeof raw.actoviqAuthTokenEncrypted === 'string' && raw.actoviqAuthTokenEncrypted) {
    try {
      const token = safeStorage.decryptString(Buffer.from(raw.actoviqAuthTokenEncrypted, 'base64'));
      return { token, storage: token ? 'encrypted' : 'none', legacyPlaintext: false };
    } catch {
      return { token: '', storage: 'none', legacyPlaintext: false };
    }
  }
  if (typeof raw.actoviqAuthToken === 'string' && raw.actoviqAuthToken) {
    return { token: raw.actoviqAuthToken, storage: 'plaintext-fallback', legacyPlaintext: true };
  }
  const envToken = process.env.ACTOVIQ_API_KEY ?? process.env.ACTOVIQ_AUTH_TOKEN ?? '';
  return { token: envToken, storage: envToken ? 'environment' : 'none', legacyPlaintext: false };
}

async function readStoredSettings(): Promise<StoredSettings> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as StoredSettings : {};
  } catch {
    return {};
  }
}

function toRendererSettings(settings: PersistedAppSettings): AppSettings {
  const masked = maskSecret(settings.actoviqAuthToken);
  return {
    ...settings,
    actoviqAuthToken: '',
    hasActoviqAuthToken: Boolean(settings.actoviqAuthToken),
    maskedActoviqAuthToken: masked,
    clearActoviqAuthToken: false,
  };
}

function maskSecret(secret: string): string {
  if (!secret) return '';
  const suffix = secret.length > 4 ? secret.slice(-4) : '';
  return `${'\u2022'.repeat(8)}${suffix}`;
}

export async function loadSettingsWithSecrets(): Promise<PersistedAppSettings> {
  const raw = await readStoredSettings();
  const secret = decryptStoredToken(raw);
  const settings = normalizeStoredSettings(raw, secret.token, secret.storage);

  // Migrate legacy plaintext tokens after Electron's OS-backed storage is ready.
  if (secret.legacyPlaintext && isEncryptionAvailable()) {
    await persistSettings(settings);
    settings.actoviqAuthTokenStorage = 'encrypted';
  }
  return settings;
}

export async function loadSettings(): Promise<AppSettings> {
  return toRendererSettings(await loadSettingsWithSecrets());
}

async function persistSettings(settings: PersistedAppSettings): Promise<void> {
  const {
    actoviqAuthToken,
    actoviqAuthTokenStorage: _storage,
    ...nonSecretSettings
  } = settings;
  const payload: StoredSettings = {
    schema: 'actoviq.desktop-settings.v2',
    ...nonSecretSettings,
  };

  if (actoviqAuthToken && settings.actoviqAuthTokenStorage !== 'environment') {
    if (isEncryptionAvailable()) {
      payload.actoviqAuthTokenEncrypted = safeStorage.encryptString(actoviqAuthToken).toString('base64');
    } else {
      // Keep settings usable on platforms where Electron cannot access a secure backend.
      // The renderer still receives only a masked state, never this fallback value.
      payload.actoviqAuthToken = actoviqAuthToken;
    }
  }

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(payload, null, 2), 'utf8');
}

function resolveDraftSettings(current: PersistedAppSettings, draft: AppSettings): PersistedAppSettings {
  const suppliedToken = typeof draft.actoviqAuthToken === 'string' ? draft.actoviqAuthToken.trim() : '';
  const token = draft.clearActoviqAuthToken
    ? suppliedToken
    : suppliedToken || current.actoviqAuthToken;
  return normalizeStoredSettings(
    {
      ...current,
      ...draft,
      actoviqAuthToken: undefined,
    },
    token,
    token === current.actoviqAuthToken ? current.actoviqAuthTokenStorage : isEncryptionAvailable() ? 'encrypted' : 'plaintext-fallback',
  );
}

export function applySettingsToEnvironment(settings: PersistedAppSettings): void {
  const setOrDelete = (name: string, value: string): void => {
    if (value) process.env[name] = value;
    else delete process.env[name];
  };

  process.env.ACTOVIQ_PROVIDER = settings.actoviqProvider;
  setOrDelete('ACTOVIQ_API_KEY', settings.actoviqAuthToken);
  setOrDelete('ACTOVIQ_AUTH_TOKEN', settings.actoviqAuthToken);
  setOrDelete('ACTOVIQ_BASE_URL', settings.actoviqBaseUrl);
  setOrDelete('ACTOVIQ_MODEL', settings.chatModel);
  setOrDelete('ACTOVIQ_DEFAULT_MIN_MODEL', settings.haikuModel);
  setOrDelete('ACTOVIQ_DEFAULT_MEDIUM_MODEL', settings.chatModel || settings.sonnetModel);
  setOrDelete('ACTOVIQ_DEFAULT_MAX_MODEL', settings.reasoningModel || settings.opusModel);
  setOrDelete('NGSPICE_BIN', settings.ngspiceBin);
}

function sanitizeProviderError(error: unknown, token: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join('[redacted]');
  message = message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(authorization|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return (message || 'Provider request failed.').slice(0, 500);
}

async function testProvider(draft: AppSettings): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  const current = await loadSettingsWithSecrets();
  const settings = resolveDraftSettings(current, draft);
  const resultBase = {
    provider: settings.actoviqProvider,
    model: settings.chatModel,
  };

  if (!settings.actoviqAuthToken) {
    return { ...resultBase, ok: false, latencyMs: Date.now() - startedAt, error: 'API key is not configured.' };
  }
  try {
    const parsedUrl = new URL(settings.actoviqBaseUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('Base URL must use http or https.');
    }
  } catch (error) {
    return {
      ...resultBase,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: sanitizeProviderError(error, settings.actoviqAuthToken),
    };
  }
  if (!settings.chatModel.trim()) {
    return { ...resultBase, ok: false, latencyMs: Date.now() - startedAt, error: 'Chat model is required.' };
  }

  let sdk: Awaited<ReturnType<typeof createAgentSdk>> | null = null;
  try {
    sdk = await createAgentSdk({
      provider: settings.actoviqProvider,
      apiKey: settings.actoviqAuthToken,
      authToken: settings.actoviqProvider === 'anthropic' ? settings.actoviqAuthToken : undefined,
      baseURL: settings.actoviqBaseUrl,
      model: settings.chatModel,
      maxTokens: 24,
      maxRetries: 0,
      runTimeoutMs: 20_000,
      workDir: process.cwd(),
      sessionDirectory: path.join(settingsDir, 'desktop-agent-sessions'),
      clientName: 'actoviq-circuit-agent-desktop-provider-test',
      tools: [],
      agents: [{
        name: 'desktop-provider-connection-check',
        description: 'No-tool provider connectivity check for the desktop settings dialog.',
        systemPrompt: 'This is a connection check. Reply with only OK and do not call tools.',
        tools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 1,
        source: 'custom',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'plan',
    });
    await sdk.runWithAgent('desktop-provider-connection-check', 'Reply with exactly: OK', {
      maxTokens: 24,
      temperature: 0,
    });
    return { ...resultBase, ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ...resultBase,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: sanitizeProviderError(error, settings.actoviqAuthToken),
    };
  } finally {
    await sdk?.close().catch(() => undefined);
  }
}

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  // Make saved provider settings available to spawned workflow processes immediately.
  void loadSettingsWithSecrets().then(applySettingsToEnvironment).catch(() => undefined);

  ipcMain.handle('settings:get', async () => {
    return loadSettings();
  });

  ipcMain.handle('settings:save', async (_event, draft: AppSettings) => {
    const current = await loadSettingsWithSecrets();
    const settings = resolveDraftSettings(current, draft);
    await persistSettings(settings);
    applySettingsToEnvironment(settings);
    return toRendererSettings({
      ...settings,
      actoviqAuthTokenStorage: settings.actoviqAuthToken
        ? isEncryptionAvailable() ? 'encrypted' : 'plaintext-fallback'
        : 'none',
    });
  });

  ipcMain.handle('settings:test-provider', async (_event, draft: AppSettings) => {
    return testProvider(draft);
  });

  ipcMain.handle('app:version', async () => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version: string };
    return pkg.version;
  });
}

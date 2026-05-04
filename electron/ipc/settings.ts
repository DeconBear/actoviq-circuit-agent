import { IpcMain } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AppSettings {
  actoviqBaseUrl: string;
  actoviqAuthToken: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
}

const settingsDir = path.resolve(homedir(), '.actoviq');
const settingsPath = path.join(settingsDir, 'actoviq-circuit-agent-desktop.json');

const defaultSettings: AppSettings = {
  actoviqBaseUrl: 'https://api.anthropic.com',
  actoviqAuthToken: '',
  opusModel: 'claude-opus-4-7',
  sonnetModel: 'claude-sonnet-4-6',
  haikuModel: 'claude-haiku-4-5-20251001',
  ngspiceBin: '',
  workspaceRoot: '',
};

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const saved = JSON.parse(raw);
    return { ...defaultSettings, ...saved };
  } catch {
    return { ...defaultSettings };
  }
}

async function persistSettings(settings: AppSettings): Promise<void> {
  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('settings:get', async () => {
    return loadSettings();
  });

  ipcMain.handle('settings:save', async (_event, settings: AppSettings) => {
    await persistSettings(settings);
    // Apply to process.env for workflow consumption
    if (settings.actoviqAuthToken) {
      process.env.ACTOVIQ_AUTH_TOKEN = settings.actoviqAuthToken;
    }
    if (settings.actoviqBaseUrl) {
      process.env.ACTOVIQ_BASE_URL = settings.actoviqBaseUrl;
    }
    if (settings.ngspiceBin) {
      process.env.NGSPICE_BIN = settings.ngspiceBin;
    }
  });

  ipcMain.handle('app:version', async () => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version: string };
    return pkg.version;
  });
}

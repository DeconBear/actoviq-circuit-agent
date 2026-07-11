import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMenu } from './menu.js';
import { registerChatHandlers } from './ipc/chat.js';
import { registerWorkflowHandlers } from './ipc/workflow.js';
import { registerFileHandlers } from './ipc/fileTools.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerWorkspaceHandlers } from './ipc/workspaces.js';
import { registerProjectHandlers } from './ipc/projects.js';
import { inspectCircuitSkillStatus, registerSkillHandlers } from './ipc/skills.js';

let mainWindow: BrowserWindow | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function appIconPath(): string {
  // Windows taskbar/window chrome prefer .ico; other platforms use PNG.
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', fileName)
    : path.join(app.getAppPath(), 'assets', fileName);
}

function createWindow(): void {
  const iconPath = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Actoviq Circuit Agent',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Ensure taskbar icon updates even if the shell cached an older asset.
  if (process.platform === 'win32') {
    mainWindow.setIcon(iconPath);
  }

  const menu = buildMenu(mainWindow);
  Menu.setApplicationMenu(menu);

  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.ACTOVIQ_RENDERER_URL ?? 'http://127.0.0.1:5173');
    // Opt-in only: set ACTOVIQ_DEVTOOLS=1 to open DevTools on startup.
    if (process.env.ACTOVIQ_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  registerChatHandlers(ipcMain);
  registerWorkflowHandlers(ipcMain);
  registerFileHandlers(ipcMain);
  registerSettingsHandlers(ipcMain);
  registerWorkspaceHandlers(ipcMain);
  registerProjectHandlers(ipcMain);
  registerSkillHandlers(ipcMain);
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.actoviq.circuit-agent');
  }
  registerIpcHandlers();
  void inspectCircuitSkillStatus().catch((error) => {
    console.warn('Circuit skill version check failed:', error);
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

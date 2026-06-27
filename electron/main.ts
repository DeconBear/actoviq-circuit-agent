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

let mainWindow: BrowserWindow | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.png')
    : path.join(app.getAppPath(), 'assets', 'icon.png');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Actoviq Circuit Agent',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const menu = buildMenu(mainWindow);
  Menu.setApplicationMenu(menu);

  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.ACTOVIQ_RENDERER_URL ?? 'http://127.0.0.1:5173');
    if (process.env.ACTOVIQ_E2E !== '1') {
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
}

app.whenReady().then(() => {
  registerIpcHandlers();
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

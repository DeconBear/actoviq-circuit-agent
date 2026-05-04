import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMenu } from './menu.js';
import { registerChatHandlers } from './ipc/chat.js';
import { registerWorkflowHandlers } from './ipc/workflow.js';
import { registerFileHandlers } from './ipc/fileTools.js';
import { registerSettingsHandlers } from './ipc/settings.js';

let mainWindow: BrowserWindow | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Actoviq Circuit Agent',
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
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
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

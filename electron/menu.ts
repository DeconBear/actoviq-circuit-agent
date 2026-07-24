import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';

export function buildMenu(mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Design',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu:new-design'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow.webContents.send('menu:open-settings'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Design',
      submenu: [
        {
          label: 'Start Workflow',
          accelerator: 'CmdOrCtrl+Return',
          click: () => mainWindow.webContents.send('menu:start-workflow'),
        },
        {
          label: 'Pause',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow.webContents.send('menu:pause-workflow'),
        },
        {
          label: 'Resume',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow.webContents.send('menu:resume-workflow'),
        },
        { type: 'separator' },
        {
          label: 'Validate Netlist',
          click: () => mainWindow.webContents.send('menu:validate-netlist'),
        },
        {
          label: 'Run Simulation',
          click: () => mainWindow.webContents.send('menu:run-simulation'),
        },
        {
          label: 'Render Schematic',
          click: () => mainWindow.webContents.send('menu:render-schematic'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => shell.openExternal('https://github.com/DeconBear/actoviq-circuit-agent'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

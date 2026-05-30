const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { startLocalServer } = require('./server');
const { startSyncEngine } = require('./sync');
const Store = require('electron-store');

const store = new Store();

let mainWindow;
let localPort = 3741; // local API port

// ── App ready ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Start local API server (replaces Cloudflare Worker)
  await startLocalServer(localPort, store);

  // Start background sync engine
  startSyncEngine(store, localPort);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Excelerate HSC',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading local resources
      webSecurity: false,
    },
    // Use system frame on Windows, custom on Mac
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  // Load the WebFiles index.html
  const webFilesPath = getWebFilesPath();
  mainWindow.loadFile(path.join(webFilesPath, 'index.html'));

  // Inject local API URL override once page is ready
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      // Override the Worker URL to point to our local Express server
      if (window.EXCELERATE_CONFIG) {
        window.EXCELERATE_CONFIG.apiUrl = 'http://localhost:${localPort}';
        window.EXCELERATE_CONFIG._isElectron = true;
        window.EXCELERATE_CONFIG._localPort = ${localPort};
      }
      // Signal the app that we're running in Electron
      window.__ELECTRON__ = true;
    `);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  buildMenu();
}

function getWebFilesPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'WebFiles');
  }
  // In dev: WebFiles is cloned into the repo root via:
  //   git clone https://github.com/fhall2008/HSCSTUDY-Cloudflare-pages webfiles
  // Then WebFiles lives at: webfiles/project/WebFiles
  const envPath = process.env.WEBFILES_PATH;
  if (envPath) return envPath;
  return path.join(__dirname, '..', 'webfiles', 'project', 'WebFiles');
}

// ── App menu ───────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.NODE_ENV === 'development' ? [{ role: 'toggleDevTools' }] : [])
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in Browser',
          click: () => shell.openExternal('https://hscstudyphcs.pages.dev')
        },
        {
          label: 'Check for Updates',
          click: () => checkForUpdates()
        },
        {
          label: 'Sync Status',
          click: () => {
            const lastSync = store.get('lastSync');
            const status = store.get('syncStatus', 'unknown');
            const msg = lastSync
              ? `Last sync: ${new Date(lastSync).toLocaleString()}\nStatus: ${status}`
              : 'Not yet synced with school server.';
            require('electron').dialog.showMessageBox(mainWindow, {
              title: 'Sync Status', message: msg, type: 'info'
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-sync-status', () => ({
  lastSync: store.get('lastSync'),
  status: store.get('syncStatus', 'idle'),
  isOnline: store.get('isOnline', false),
}));

ipcMain.handle('force-sync', async () => {
  const { runSync } = require('./sync');
  return runSync(store, localPort);
});

// ── Update check ───────────────────────────────────────────────────────────
async function checkForUpdates() {
  try {
    const fetch = require('node-fetch');
    const res = await fetch('https://hscstudyphcs.pages.dev/version.json').catch(() => null);
    if (!res) {
      require('electron').dialog.showMessageBox(mainWindow, {
        title: 'Update Check', message: 'Could not check for updates — no internet connection.', type: 'info'
      });
      return;
    }
    const { version } = await res.json();
    if (version && version !== app.getVersion()) {
      const { response } = await require('electron').dialog.showMessageBox(mainWindow, {
        title: 'Update Available',
        message: `Version ${version} is available. You have ${app.getVersion()}.\n\nDownload the latest version from your school IT team.`,
        type: 'info',
        buttons: ['Open Download Page', 'Later']
      });
      if (response === 0) shell.openExternal('https://hscstudyphcs.pages.dev');
    } else {
      require('electron').dialog.showMessageBox(mainWindow, {
        title: 'Up to Date', message: `You have the latest version (${app.getVersion()}).`, type: 'info'
      });
    }
  } catch (e) {
    console.error('Update check failed:', e);
  }
}

const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const { statSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerPrintHandlers } = require('./printing.cjs');
const { registerDriveHandlers } = require('./driveAttachments.cjs');

const { productName } = require('../package.json');

const appData = app.getPath('appData');
const previousProfile = path.join(appData, 'museum-collections-desk');
if (app.getPath('userData') === path.join(appData, productName) &&
    statSync(previousProfile, { throwIfNoEntry: false })?.isDirectory()) {
  app.setPath('userData', previousProfile);
}

const appFile = path.join(__dirname, '../dist/index.html');
const appUrl = app.isPackaged ? pathToFileURL(appFile).href
  : new URL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173').href;

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1100, minHeight: 720,
    backgroundColor: '#fff', title: productName,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url).catch(error => console.error('Could not open link:', error.message));
    }
    return { action: 'deny' };
  });

  try {
    if (app.isPackaged) {
      await window.loadFile(appFile);
    } else {
      await window.loadURL(appUrl);
    }
  } catch (error) {
    if (window.isDestroyed()) return;
    dialog.showErrorBox('Could not open ' + productName, error.message);
    window.close();
  }
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerPrintHandlers(appUrl);
  registerDriveHandlers(appUrl);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

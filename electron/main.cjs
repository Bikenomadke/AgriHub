const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let backendProcess;

function startBackend() {
  const serverPath = path.join(__dirname, '../backend/server.js');
  backendProcess = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '4000' }
  });
  backendProcess.stdout.on('data', d => process.stdout.write('[backend] ' + d));
  backendProcess.stderr.on('data', d => process.stderr.write('[backend] ' + d));
  backendProcess.on('error', err => console.error('Failed to start backend:', err.message));
  backendProcess.on('exit', code => console.log('Backend exited with code', code));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '../public/favicon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    autoHideMenuBar: true
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    startBackend();
    mainWindow.loadURL('http://localhost:4000');
  }

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Set Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https: http:; " +
          "font-src 'self' data:; " +
          "connect-src 'self' ws: wss: https: http:; " +
          "frame-src 'none'; " +
          "object-src 'none';"
        ],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'X-XSS-Protection': ['1; mode=block'],
      }
    });
  });

  // Grant geolocation permission (required for Electron)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'geolocation') {
      callback(true);
    } else {
      callback(false);
    }
  });
  // Also handle permission checks (Chromium's newer API)
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'geolocation') return true;
    return false;
  });
  createWindow();
});

app.on('window-all-closed', function () {
  if (backendProcess) { backendProcess.kill(); backendProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', function () {
  if (backendProcess) { backendProcess.kill(); backendProcess = null; }
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

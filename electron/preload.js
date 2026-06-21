const { contextBridge, ipcRenderer } = require('electron');

// Expose secure APIs to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Geolocation permission
  requestGeolocation: () => ipcRenderer.invoke('request-geolocation'),
  
  // Secure storage (optional - can be implemented later)
  setItem: (key, value) => ipcRenderer.invoke('set-item', key, value),
  getItem: (key) => ipcRenderer.invoke('get-item', key),
  removeItem: (key) => ipcRenderer.invoke('remove-item', key),
  
  // App info
  getVersion: () => process.versions.electron,
  getPlatform: () => process.platform
});

// Remove all Node.js references from renderer
window.node = null;
window.process = null;
window.global = null;

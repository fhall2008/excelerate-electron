const { contextBridge, ipcRenderer } = require('electron');

// Expose safe electron APIs to the renderer
contextBridge.exposeInMainWorld('electronAPI', {
  getSyncStatus: () => ipcRenderer.invoke('get-sync-status'),
  forceSync: () => ipcRenderer.invoke('force-sync'),
  isElectron: true,
});

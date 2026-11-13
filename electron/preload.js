const { contextBridge, ipcRenderer } = require('electron')

// Runs sandboxed: only these IPC calls are exposed. read/save work only on paths
// the user chose in the open/save dialogs (enforced in main.js).
contextBridge.exposeInMainWorld('electronAPI', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),
  capturePage: (options) => ipcRenderer.invoke('capture-page', options),
})

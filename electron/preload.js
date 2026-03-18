const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),
  listFiles: (dirPath, extension) => ipcRenderer.invoke('list-files', dirPath, extension),
})

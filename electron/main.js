const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'CNC Trainer',
  })

  // In dev mode, load from Vite server
  const isDev = process.env.NODE_ENV !== 'production'
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// IPC: Read file
ipcMain.handle('read-file', async (_event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    return { error: err.message }
  }
})

// IPC: Open file dialog
ipcMain.handle('open-file-dialog', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: options?.filters || [
      { name: 'VMID Files', extensions: ['vmid'] },
      { name: 'G-Code Files', extensions: ['mpf', 'nc', 'tap', 'gcode'] },
      { name: 'GPP Files', extensions: ['gpp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

// IPC: Save file dialog
ipcMain.handle('save-file-dialog', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: options?.filters || [
      { name: 'VMID Files', extensions: ['vmid'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    defaultPath: options?.defaultPath || 'machine.vmid',
  })
  if (result.canceled) return null
  return result.filePath
})

// IPC: Save file
ipcMain.handle('save-file', async (_event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (err) {
    return { error: err.message }
  }
})

// IPC: List files in directory
ipcMain.handle('list-files', async (_event, dirPath, extension) => {
  try {
    const files = fs.readdirSync(dirPath)
      .filter(f => !extension || f.endsWith(extension))
      .map(f => path.join(dirPath, f))
    return files
  } catch (err) {
    return { error: err.message }
  }
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

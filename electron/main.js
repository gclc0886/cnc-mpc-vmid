const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

const DEV_URL = 'http://localhost:5173'
// Packaged builds load dist/; unpackaged runs use the Vite dev server unless NODE_ENV=production
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'

let mainWindow

/*
 * File access from the renderer is limited to files the user picked in a dialog:
 * open-file-dialog grants read, save-file-dialog grants write. A compromised page
 * cannot read or overwrite arbitrary files. (The MCP server reads files on its own,
 * outside the renderer.)
 */
const grantedRead = new Set()
const grantedWrite = new Set()
const key = (p) => path.resolve(String(p)).toLowerCase()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'CNC Trainer',
  })

  // No pop-ups, no navigation away from the app
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file:')
    if (!allowed) event.preventDefault()
  })

  // Optional non-default MCP bridge port (e.g. a second instance for testing)
  const bridgePort = process.env.CNC_BRIDGE_PORT
  if (isDev) {
    mainWindow.loadURL(DEV_URL + (bridgePort ? `/?bridgePort=${encodeURIComponent(bridgePort)}` : ''))
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), bridgePort ? { query: { bridgePort } } : undefined)
  }
}

/** VMIDs are often ISO-8859-1 (declared in the header); otherwise UTF-8 with a latin1 fallback. */
function decodeText(buf) {
  const head = buf.subarray(0, 200).toString('latin1')
  if (/encoding\s*=\s*"(ISO-8859-1|latin1)"/i.test(head)) return buf.toString('latin1')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return buf.toString('latin1')
  }
}

// IPC: Open file dialog (grants read access to the chosen file)
ipcMain.handle('open-file-dialog', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: options?.filters || [
      { name: 'VMID Files', extensions: ['vmid'] },
      { name: 'G-Code Files', extensions: ['mpf', 'spf', 'nc', 'tap', 'gcode'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  grantedRead.add(key(result.filePaths[0]))
  return result.filePaths[0]
})

// IPC: Read a file previously chosen in the open dialog
ipcMain.handle('read-file', async (_event, filePath) => {
  if (!grantedRead.has(key(filePath))) return { error: 'Access denied: choose the file in the Open dialog' }
  try {
    return decodeText(fs.readFileSync(filePath))
  } catch (err) {
    return { error: err.message }
  }
})

// IPC: Save file dialog (grants write access to the chosen path)
ipcMain.handle('save-file-dialog', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: options?.filters || [
      { name: 'VMID Files', extensions: ['vmid'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    defaultPath: options?.defaultPath || 'machine.vmid',
  })
  if (result.canceled || !result.filePath) return null
  grantedWrite.add(key(result.filePath))
  return result.filePath
})

// IPC: Write a file previously chosen in the save dialog
ipcMain.handle('save-file', async (_event, filePath, content) => {
  if (!grantedWrite.has(key(filePath))) return { error: 'Access denied: choose the file in the Save dialog' }
  try {
    fs.writeFileSync(filePath, String(content), 'utf-8')
    return { success: true }
  } catch (err) {
    return { error: err.message }
  }
})

// IPC: Capture the app window as JPEG (used by the MCP capture_screenshot tool)
ipcMain.handle('capture-page', async (_event, options) => {
  try {
    if (!mainWindow) return { error: 'No window' }
    let image = await mainWindow.webContents.capturePage()
    const maxWidth = Math.max(200, Math.min(4000, Number(options?.width) || 1200))
    if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth, quality: 'good' })
    const { width, height } = image.getSize()
    return { data: image.toJPEG(80).toString('base64'), width, height }
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

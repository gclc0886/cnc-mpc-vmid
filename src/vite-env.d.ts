/// <reference types="vite/client" />

interface ElectronAPI {
  readFile: (filePath: string) => Promise<string | { error: string }>
  openFileDialog: (options?: object) => Promise<string | null>
  saveFile: (filePath: string, content: string) => Promise<{ success?: boolean; error?: string }>
  saveFileDialog: (options?: object) => Promise<string | null>
  listFiles: (dirPath: string, extension?: string) => Promise<string[] | { error: string }>
  capturePage?: (options?: { width?: number }) =>
    Promise<{ data: string; width: number; height: number } | { error: string }>
}

interface Window {
  electronAPI?: ElectronAPI
}

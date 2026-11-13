import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Viewport3D } from './components/Viewport3D'
import { MatrixPanel } from './components/MatrixPanel'
import { AxisControls } from './components/AxisControls'
import { GCodeEditor } from './components/GCodeEditor'
import { ConfiguratorPanel } from './components/ConfiguratorPanel'
import { SetupPanel } from './components/SetupPanel'
import { PlaybackControls } from './components/PlaybackControls'
import { parseVMID, exportVMID } from './engine/VMIDLoader'
import { useShallow } from 'zustand/react/shallow'
import { useMachineStore } from './store/useMachineStore'
import { CoordDisplay } from './components/CoordDisplay'
import { PRESET_NAMES } from './presets/machinePresets'
import { initBridge, onConnectionChange } from './api/BridgeClient'

type SideTab = 'controls' | 'setup' | 'configurator'

function App() {
  // Only slow-changing state here: playback updates go to the panels that show them
  const { chain, machineName, machineInfo, loadPreset, loadConfig, resetAxes, requestCameraView } = useMachineStore(useShallow(s => ({
    chain: s.chain, machineName: s.machineName, machineInfo: s.machineInfo,
    loadPreset: s.loadPreset, loadConfig: s.loadConfig, resetAxes: s.resetAxes,
    requestCameraView: s.requestCameraView,
  })))

  const [sideTab, setSideTab] = useState<SideTab>('controls')
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [sideWidth, setSideWidth] = useState(360)
  const [bottomHeight, setBottomHeight] = useState(200)
  const dragging = useRef<'v' | 'h' | null>(null)

  // Initialize MCP bridge
  useEffect(() => {
    initBridge()
    return onConnectionChange(setBridgeConnected)
  }, [])

  // Resize handlers
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      if (dragging.current === 'v') {
        const w = window.innerWidth - e.clientX
        setSideWidth(Math.max(200, Math.min(800, w)))
      } else {
        const h = window.innerHeight - e.clientY
        setBottomHeight(Math.max(80, Math.min(600, h)))
      }
    }
    const onMouseUp = () => { dragging.current = null; document.body.style.cursor = '' }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Load VMID file
  const loadVMID = useCallback(async () => {
    try {
      let xmlContent: string | null = null

      if (window.electronAPI) {
        const filePath = await window.electronAPI.openFileDialog({
          filters: [{ name: 'VMID Files', extensions: ['vmid'] }],
        })
        if (!filePath) return
        const result = await window.electronAPI.readFile(filePath)
        if (typeof result === 'string') xmlContent = result
      } else {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.vmid'
        xmlContent = await new Promise<string | null>((resolve) => {
          input.onchange = () => {
            const file = input.files?.[0]
            if (!file) { resolve(null); return }
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.readAsText(file)
          }
          input.click()
        })
      }

      if (!xmlContent) return
      const config = parseVMID(xmlContent)
      loadConfig(config)
    } catch (err) {
      console.error('Failed to load VMID:', err)
      alert(`Error loading VMID: ${err}`)
    }
  }, [loadConfig])

  // Save VMID file
  const saveVMID = useCallback(async () => {
    const config = useMachineStore.getState().config
    if (!config) { alert('No machine loaded'); return }
    try {
      const xmlContent = exportVMID(config)
      const defaultName = (config.name || 'machine').replace(/[^a-zA-Z0-9_-]/g, '_') + '.vmid'

      if (window.electronAPI?.saveFileDialog) {
        const filePath = await window.electronAPI.saveFileDialog({
          filters: [{ name: 'VMID Files', extensions: ['vmid'] }],
          defaultPath: defaultName,
        })
        if (!filePath) return
        const result = await window.electronAPI.saveFile(filePath, xmlContent)
        if (result?.error) throw new Error(result.error)
        console.log('[VMID] Saved successfully to', filePath)
      } else {
        // Browser fallback: download as file
        const blob = new Blob([xmlContent], { type: 'application/xml' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = defaultName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (err) {
      console.error('Failed to save VMID:', err)
      alert(`Error saving VMID: ${err}`)
    }
  }, [])

  return (
    <div className="app-layout" style={{
      gridTemplateColumns: `1fr 6px ${sideWidth}px`,
      gridTemplateRows: `1fr 6px ${bottomHeight}px`,
    }}>
      {/* 3D Viewport */}
      <div className="viewport-3d">
        <div className="toolbar">
          {PRESET_NAMES.map(p => (
            <button key={p.key} onClick={() => loadPreset(p.key)}>{p.label}</button>
          ))}
          <button onClick={loadVMID}>VMID</button>
          <button onClick={saveVMID} disabled={!chain}>Save VMID</button>
          <span className="toolbar-sep">|</span>
          <button onClick={resetAxes} disabled={!chain}>Reset</button>
          <span className="toolbar-sep">|</span>
          {([['iso', 'Iso'], ['front', 'Front'], ['top', 'Top'], ['right', 'Right'], ['fit', 'Fit']] as const).map(([v, label]) => (
            <button key={v} onClick={() => requestCameraView(v)} disabled={!chain} title={`Camera: ${label}`}>{label}</button>
          ))}
          {bridgeConnected && (
            <span title="Claude MCP connected" style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: '#4caf50', marginLeft: 8, boxShadow: '0 0 4px #4caf50',
            }} />
          )}
        </div>

        <ErrorBoundary>
          <Viewport3D chain={chain} />
        </ErrorBoundary>

        <CoordDisplay />
      </div>

      {/* Vertical divider */}
      <div
        className="divider divider-v"
        onMouseDown={() => { dragging.current = 'v'; document.body.style.cursor = 'col-resize' }}
      />

      {/* Side Panel */}
      <div className="side-panel">
        <div className="tab-bar">
          <button
            className={`tab-btn ${sideTab === 'controls' ? 'active' : ''}`}
            onClick={() => setSideTab('controls')}
          >
            Controls
          </button>
          <button
            className={`tab-btn ${sideTab === 'setup' ? 'active' : ''}`}
            onClick={() => setSideTab('setup')}
          >
            Setup
          </button>
          <button
            className={`tab-btn ${sideTab === 'configurator' ? 'active' : ''}`}
            onClick={() => setSideTab('configurator')}
          >
            Configure
          </button>
        </div>

        {machineName && (
          <div className="machine-info">
            <div className="name">{machineName}</div>
            <div className="detail">{machineInfo}</div>
          </div>
        )}

        {sideTab === 'controls' && (
          <>
            <AxisControls />
            <PlaybackControls />
            <MatrixPanel />
          </>
        )}

        {sideTab === 'setup' && (
          <SetupPanel />
        )}

        {sideTab === 'configurator' && (
          <ConfiguratorPanel />
        )}
      </div>

      {/* Horizontal divider */}
      <div
        className="divider divider-h"
        onMouseDown={() => { dragging.current = 'h'; document.body.style.cursor = 'row-resize' }}
      />

      {/* Bottom Panel: G-Code Editor */}
      <div className="bottom-panel">
        <GCodeEditor />
      </div>
    </div>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(err: Error) { return { error: err.message } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: '#f44', padding: 20, background: '#1a1a1a', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 16, marginBottom: 10 }}>3D render error: {this.state.error}</div>
          <button onClick={() => this.setState({ error: null })} style={{ padding: '6px 16px', cursor: 'pointer' }}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}

export default App

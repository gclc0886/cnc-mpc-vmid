import type { BridgeCommand, BridgeResponse } from './bridge-types'
import { useMachineStore } from '../store/useMachineStore'
import { parseVMID } from '../engine/VMIDLoader'

const BRIDGE_PORT = 3100
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10000

let ws: WebSocket | null = null
let reconnectDelay = RECONNECT_BASE_MS
let initialized = false

// Connection state callback for UI
type ConnectionListener = (connected: boolean) => void
const listeners = new Set<ConnectionListener>()

export function onConnectionChange(fn: ConnectionListener) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notifyListeners(connected: boolean) {
  for (const fn of listeners) fn(connected)
}

function connect() {
  try {
    ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`)
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log('[bridge] Connected to MCP server')
    reconnectDelay = RECONNECT_BASE_MS
    notifyListeners(true)
  }

  ws.onmessage = (event) => {
    try {
      const cmd: BridgeCommand = JSON.parse(event.data as string)
      handleCommand(cmd)
    } catch (e) {
      console.error('[bridge] Bad message:', e)
    }
  }

  ws.onclose = () => {
    console.log('[bridge] Disconnected')
    notifyListeners(false)
    scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

function scheduleReconnect() {
  setTimeout(() => {
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS)
}

function send(response: BridgeResponse) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response))
  }
}

// --- Command Dispatcher ---

function handleCommand(cmd: BridgeCommand) {
  const { id, method, params } = cmd
  try {
    const result = dispatch(method, params)
    send({ id, result })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    send({ id, error: msg })
  }
}

function dispatch(method: string, params: Record<string, unknown>): unknown {
  const store = useMachineStore.getState()
  const { chain, config } = store

  switch (method) {
    // --- Group A: State Reading ---

    case 'get_machine_state': {
      return {
        name: store.machineName,
        info: store.machineInfo,
        category: chain?.machineCategory ?? null,
        positions: chain?.getAllPositions() ?? {},
        toolTip: chain ? { mcs: chain.getToolTipPosition() } : null,
        gcode: store.gcode.substring(0, 200) + (store.gcode.length > 200 ? '...' : ''),
        animationStep: store.currentStep,
        totalSteps: store.toolPath.length,
        isPlaying: store.isPlaying,
      }
    }

    case 'get_axis_positions': {
      return chain?.getAllPositions() ?? {}
    }

    case 'get_matrices': {
      if (!chain) return 'No machine loaded'
      const matrices = chain.getAllMatrices()
      const lines: string[] = []
      for (const { name, matrix } of matrices) {
        lines.push(`=== ${name} (world) ===`)
        const m = matrix.data
        for (let r = 0; r < 4; r++) {
          lines.push(
            `| ${m[r * 4 + 0].toFixed(4).padStart(9)} ${m[r * 4 + 1].toFixed(4).padStart(9)} ${m[r * 4 + 2].toFixed(4).padStart(9)} ${m[r * 4 + 3].toFixed(4).padStart(9)} |`
          )
        }
        lines.push('')
      }

      // Add relative matrix
      const rel = chain.getRelativeMatrix()
      lines.push('=== Relative (Inv(Table) × Spindle) ===')
      const rm = rel.data
      for (let r = 0; r < 4; r++) {
        lines.push(
          `| ${rm[r * 4 + 0].toFixed(4).padStart(9)} ${rm[r * 4 + 1].toFixed(4).padStart(9)} ${rm[r * 4 + 2].toFixed(4).padStart(9)} ${rm[r * 4 + 3].toFixed(4).padStart(9)} |`
        )
      }
      return lines.join('\n')
    }

    case 'get_tool_position': {
      if (!chain) return { error: 'No machine loaded' }
      const mcs = chain.getToolTipPosition()
      const rel = chain.getRelativeMatrix()
      const wcs = rel.getTranslation()
      return {
        mcs: { x: mcs[0], y: mcs[1], z: mcs[2] },
        wcs: { x: wcs[0], y: wcs[1], z: wcs[2] },
      }
    }

    case 'get_config': {
      return config
    }

    // --- Group B: Machine Control ---

    case 'load_preset': {
      store.loadPreset(params.key as string)
      return { success: true, name: useMachineStore.getState().machineName }
    }

    case 'load_vmid': {
      const xml = params.xml as string
      const vmidConfig = parseVMID(xml)
      store.loadConfig(vmidConfig)
      return { success: true, name: vmidConfig.name }
    }

    case 'set_axis_value': {
      store.setAxisValue(params.name as string, params.value as number)
      return { success: true }
    }

    case 'set_axes': {
      const axes = params.axes as Record<string, number>
      for (const [name, value] of Object.entries(axes)) {
        store.setAxisValue(name, value)
      }
      return { success: true }
    }

    case 'reset_axes': {
      store.resetAxes()
      return { success: true }
    }

    // --- Group C: G-code ---

    case 'load_gcode': {
      store.setGcode(params.gcode as string)
      return { success: true }
    }

    case 'parse_gcode': {
      store.parseGcode()
      const state = useMachineStore.getState()
      return { totalSteps: state.toolPath.length }
    }

    // --- Group D: Animation ---

    case 'play_animation': {
      store.setIsPlaying(true)
      return { success: true }
    }

    case 'pause_animation': {
      store.setIsPlaying(false)
      return { success: true }
    }

    case 'set_animation_step': {
      store.setCurrentStep(params.step as number)
      return { success: true }
    }

    case 'get_animation_state': {
      return {
        currentStep: store.currentStep,
        totalSteps: store.toolPath.length,
        isPlaying: store.isPlaying,
      }
    }

    // --- Group E: Configuration ---

    case 'update_axis_config': {
      store.updateAxis(params.axisName as string, params.changes as Record<string, unknown>)
      return { success: true }
    }

    case 'add_axis': {
      store.addAxis(
        params.parentAxisName as string,
        params.deviceId as number,
        params.axis as any,
      )
      return { success: true }
    }

    case 'add_device': {
      store.addDevice(params.device as any)
      return { success: true }
    }

    case 'remove_axis': {
      store.removeAxis(params.axisName as string)
      return { success: true }
    }

    default:
      throw new Error(`Unknown method: ${method}`)
  }
}

// --- Public API ---

export function initBridge() {
  if (initialized) return
  initialized = true
  connect()
}

export function isBridgeConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

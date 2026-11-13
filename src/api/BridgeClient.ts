import type {
  BridgeCommand, BridgeResponse, BridgeMethod, BridgeParams, BridgeResult, StepInfo, SetupInfo, CombinationsInfo,
} from './bridge-types'
import { useMachineStore, INITIAL_WORK_OFFSET, PLAYBACK_SPEEDS, CAMERA_VIEWS } from '../store/useMachineStore'
import type { CameraView } from '../store/useMachineStore'
import { parseVMID, exportVMID } from '../engine/VMIDLoader'
import { checkAxisLimit } from '../engine/KinematicChain'
import type { LimitViolation } from '../engine/KinematicChain'
import { mapPointToAxes, describeMapping, buildAxisMapping } from '../engine/AxisMapping'

/** 3100 by default; `?bridgePort=NNNN` (set by Electron from CNC_BRIDGE_PORT) overrides it. */
const BRIDGE_PORT = (() => {
  const p = Number(new URLSearchParams(window.location.search).get('bridgePort'))
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 3100
})()
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
      void handleCommand(cmd)
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

async function handleCommand(cmd: BridgeCommand) {
  const { id, method, params } = cmd
  try {
    const handler = handlers[method] as ((p: unknown) => unknown) | undefined
    if (!handler) throw new Error(`Unknown method: ${method}`)
    const result = await handler(params ?? {})
    send({ id, result })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    send({ id, error: msg })
  }
}

const store = () => useMachineStore.getState()

function requireChain() {
  const { chain } = store()
  if (!chain) throw new Error('No machine loaded')
  return chain
}

function formatMatrixRows(m: number[]): string[] {
  const rows: string[] = []
  for (let r = 0; r < 4; r++) {
    rows.push('| ' + [0, 1, 2, 3].map(c => m[r * 4 + c].toFixed(4).padStart(9)).join(' ') + ' |')
  }
  return rows
}

function toolPosition() {
  const chain = requireChain()
  const mcs = chain.getToolTipPosition()
  const wcs = chain.getRelativeMatrix().getTranslation()
  return {
    mcs: { x: mcs[0], y: mcs[1], z: mcs[2] },
    wcs: { x: wcs[0], y: wcs[1], z: wcs[2] },
  }
}

/** Everything about one playback step, computed without moving the machine. */
function buildStepInfo(stepArg?: number): StepInfo {
  const s = store()
  const chain = requireChain()
  const total = s.toolPath.length
  if (total === 0) throw new Error('No tool path — call parse_gcode first')
  const step = stepArg ?? s.currentStep
  if (!Number.isInteger(step) || step < 0 || step >= total) {
    throw new Error(`Step ${step} out of range 0..${total - 1}`)
  }
  const pt = s.toolPath[step]
  const block = s.parsedBlocks[pt.blockIndex]
  const mapping = s.axisMapping
  const axes = mapping ? mapPointToAxes(pt, mapping) : {}
  const violations: LimitViolation[] = []
  for (const [name, value] of Object.entries(axes)) {
    const node = chain.nodes.get(name)
    const v = node && checkAxisLimit(node.axis, value)
    if (v) violations.push(v)
  }
  const combo = s.config?.combinations?.find(c => c.id === s.activeCombinationId)
  return {
    step,
    totalSteps: total,
    blockIndex: pt.blockIndex,
    line: block?.line ?? null,
    source: block?.raw ?? null,
    rapid: pt.rapid,
    feed: pt.feed,
    time: pt.t,
    programmed: { X: pt.x, Y: pt.y, Z: pt.z, A: pt.a, B: pt.b, C: pt.c },
    machine: { X: pt.mx, Y: pt.my, Z: pt.mz, A: pt.ma, B: pt.mb, C: pt.mc },
    tool: { length: pt.toolLen, radius: pt.toolRadius },
    axes,
    mapping: mapping ? describeMapping(mapping) : {},
    activeCombination: combo ? { id: combo.id, name: combo.name } : null,
    limitViolations: violations,
    tcp: step === s.currentStep ? toolPosition() : null,
  }
}

function combinationsInfo(): CombinationsInfo {
  const { config, chain, activeCombinationId } = store()
  if (!config || !chain) throw new Error('No machine loaded')
  return {
    active: activeCombinationId,
    combinations: config.combinations.map(c => ({
      id: c.id, name: c.name, turretId: c.turretId, tableId: c.tableId,
      mapping: describeMapping(buildAxisMapping(config, chain, c.id)),
    })),
  }
}

function setupInfo(): SetupInfo {
  const s = store()
  return {
    workOffsets: s.workOffsets,
    autoWorkOffset: s.autoWorkOffset,
    initialWorkOffset: INITIAL_WORK_OFFSET,
    tools: s.tools,
    toolsUsed: s.toolsUsed,
    workOffsetsUsed: s.workOffsetsUsed,
  }
}

type Handlers = {
  [M in BridgeMethod]: (params: BridgeParams<M>) => BridgeResult<M> | Promise<BridgeResult<M>>
}

const handlers: Handlers = {
  // --- State reading ---

  get_machine_state: () => {
    const s = store()
    const { chain } = s
    return {
      name: s.machineName,
      info: s.machineInfo,
      category: chain?.machineCategory ?? null,
      positions: chain?.getAllPositions() ?? {},
      toolTip: chain ? toolPosition() : null,
      limitViolations: chain?.getLimitViolations() ?? [],
      activeCombinationId: s.activeCombinationId,
      gcode: s.gcode.substring(0, 200) + (s.gcode.length > 200 ? '...' : ''),
      animationStep: s.currentStep,
      totalSteps: s.toolPath.length,
      isPlaying: s.isPlaying,
    }
  },

  get_axis_positions: () => store().chain?.getAllPositions() ?? {},

  get_matrices: () => {
    const chain = store().chain
    if (!chain) return 'No machine loaded'
    const lines: string[] = []
    for (const { name, matrix } of chain.getAllMatrices()) {
      lines.push(`=== ${name} (world) ===`, ...formatMatrixRows(matrix.data), '')
    }
    lines.push('=== Relative (Inv(Table) × Spindle) ===', ...formatMatrixRows(chain.getRelativeMatrix().data))
    return lines.join('\n')
  },

  get_tool_position: () => (store().chain ? toolPosition() : { error: 'No machine loaded' }),

  get_config: () => store().config,

  // --- Machine control ---

  load_preset: ({ key }) => {
    store().loadPreset(key)
    if (!store().config) throw new Error(`Unknown preset: ${key}`)
    return { success: true, name: store().machineName }
  },

  load_vmid: ({ xml }) => {
    const cfg = parseVMID(xml)
    store().loadConfig(cfg)
    return { success: true, name: cfg.name, axes: cfg.axisCount, combinations: cfg.combinations.length }
  },

  set_axis_value: ({ name, value }) => {
    if (!requireChain().nodes.has(name)) throw new Error(`Unknown axis: ${name}`)
    store().setAxisValue(name, value)
    return { success: true }
  },

  set_axes: ({ axes }) => {
    const chain = requireChain()
    const unknown = Object.keys(axes).filter(n => !chain.nodes.has(n))
    if (unknown.length) throw new Error(`Unknown axes: ${unknown.join(', ')}`)
    chain.setAxisValues(axes)
    store().bumpVersion()
    return { success: true }
  },

  reset_axes: () => {
    store().resetAxes()
    return { success: true }
  },

  // --- G-code ---

  load_gcode: ({ gcode }) => {
    store().setGcode(gcode)
    return { success: true }
  },

  parse_gcode: () => {
    store().parseGcode()
    const s = store()
    return {
      totalSteps: s.toolPath.length,
      blocks: s.parsedBlocks.length,
      duration: s.programDuration,
      dialect: s.gcodeDialect,
      errors: s.diagnostics.filter(d => d.severity === 'error').length,
      warnings: s.diagnostics.filter(d => d.severity === 'warning').length,
      diagnostics: s.diagnostics.slice(0, 50),
    }
  },

  // --- Animation ---

  play_animation: () => {
    store().setIsPlaying(true)
    return { success: true }
  },

  pause_animation: () => {
    store().setIsPlaying(false)
    return { success: true }
  },

  set_animation_step: ({ step }) => {
    const info = buildStepInfo(step) // validates range
    store().setIsPlaying(false)
    store().applyStep(step)
    return { ...info, tcp: toolPosition() }
  },

  get_animation_state: () => {
    const s = store()
    return { currentStep: s.currentStep, totalSteps: s.toolPath.length, isPlaying: s.isPlaying }
  },

  get_step_info: ({ step }) => buildStepInfo(step),

  // --- Configuration ---

  update_axis_config: ({ axisName, changes }) => {
    store().updateAxis(axisName, changes)
    return { success: true }
  },

  add_axis: ({ parentAxisName, deviceId, axis }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store().addAxis(parentAxisName, deviceId, axis as any)
    return { success: true }
  },

  add_device: ({ device }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store().addDevice(device as any)
    return { success: true }
  },

  remove_axis: ({ axisName }) => {
    store().removeAxis(axisName)
    return { success: true }
  },

  // --- Setup ---

  get_setup: () => setupInfo(),

  set_work_offset: ({ name, offset }) => {
    if (!/^G(5[4-7]|5\d\d)$/.test(name)) throw new Error(`Unknown work offset ${name} (use G54…G57, G505…)`)
    const cur = store().workOffsets[name] ?? { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }
    store().setWorkOffset(name, { ...cur, ...offset })
    return setupInfo()
  },

  set_tool: ({ key, length, radius, remove }) => {
    if (!key) throw new Error('Tool key is required (T value as text, e.g. "1" or "INSTRUMENT_2")')
    if (remove) store().setTool(key, null)
    else {
      const cur = store().tools[key] ?? { length: 0, radius: 0 }
      store().setTool(key, { length: length ?? cur.length, radius: radius ?? cur.radius })
    }
    return setupInfo()
  },

  // --- Machine structure ---

  list_combinations: () => combinationsInfo(),

  set_active_combination: ({ id }) => {
    const { config } = store()
    if (!config?.combinations.some(c => c.id === id)) {
      throw new Error(`No combination with id ${id}. Available: ${config?.combinations.map(c => `${c.id} (${c.name})`).join(', ') || 'none'}`)
    }
    store().setActiveCombination(id)
    return combinationsInfo()
  },

  get_channels: () => {
    const { config } = store()
    return { channels: config?.channels ?? [], accessPatterns: config?.accessPatterns ?? [] }
  },

  export_vmid: () => {
    const { config } = store()
    if (!config) throw new Error('No machine loaded')
    return { name: config.name, xml: exportVMID(config) }
  },

  // --- Program analysis / playback ---

  get_diagnostics: ({ severity }) => {
    const d = store().diagnostics
    return {
      errors: d.filter(x => x.severity === 'error').length,
      warnings: d.filter(x => x.severity === 'warning').length,
      items: severity ? d.filter(x => x.severity === severity) : d,
    }
  },

  find_limit_violations: () => {
    const { pathKin, toolPath, parsedBlocks } = store()
    if (!pathKin) throw new Error('No tool path — call parse_gcode first')
    return {
      violations: pathKin.limits.map(l => {
        const block = parsedBlocks[toolPath[l.firstStep]?.blockIndex ?? -1]
        return { ...l, line: block?.line ?? null, source: block?.raw ?? null }
      }),
    }
  },

  run_to_line: ({ line }) => {
    const step = store().jumpToLine(line)
    if (step < 0) throw new Error(`No motion at or after line ${line}`)
    return { ...buildStepInfo(step), tcp: toolPosition() }
  },

  set_playback_speed: ({ speed }) => {
    const allowed = [...PLAYBACK_SPEEDS] as number[]
    if (!allowed.includes(speed)) throw new Error(`Speed must be one of ${allowed.join(', ')} (× real time)`)
    store().setPlaybackSpeed(speed)
    return { speed, allowed }
  },

  // --- View ---

  set_camera_view: ({ view }) => {
    if (!(CAMERA_VIEWS as string[]).includes(view)) throw new Error(`View must be one of ${CAMERA_VIEWS.join(', ')}`)
    store().requestCameraView(view as CameraView)
    return { success: true }
  },

  capture_screenshot: async ({ width }) => {
    const api = window.electronAPI
    if (!api?.capturePage) throw new Error('Screenshots are available only in the Electron app')
    const res = await api.capturePage({ width })
    if ('error' in res) throw new Error(res.error)
    return { mimeType: 'image/jpeg', ...res }
  },
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

import { create } from 'zustand'
import { KinematicChain } from '../engine/KinematicChain'
import type { KinematicConfig, AxisDef, LimitViolation } from '../engine/KinematicChain'
import { parseProgram } from '../engine/GCodeParser'
import type { SimPoint, GCodeBlock, Diagnostic, AxisLetter, Dialect } from '../engine/GCodeParser'
import { buildAxisMapping, mapPointToAxes } from '../engine/AxisMapping'
import type { AxisMapping } from '../engine/AxisMapping'
import { PRESETS } from '../presets/machinePresets'

interface MachineStore {
  // Machine config & chain
  config: KinematicConfig | null
  chain: KinematicChain | null
  machineName: string
  machineInfo: string
  version: number  // incremented to trigger re-renders on axis changes

  // G-code / Animation
  gcode: string
  parsedBlocks: GCodeBlock[]
  toolPath: SimPoint[]
  /** Interpreter messages from the last parse (unsupported words, arc errors, missing F …). */
  diagnostics: Diagnostic[]
  /** Estimated program time of the last parse, seconds. */
  programDuration: number
  /** Controller dialect detected in the last parse. */
  gcodeDialect: Dialect | null
  currentStep: number
  isPlaying: boolean
  playbackSpeed: number  // steps per frame (1=slow, 2, 5, 10, 20=fast)

  // Active combination (sub-machine) for axis mapping
  activeCombinationId: number | null
  /** Programmed X/Y/Z/A/B/C → physical axis names, resolved from the active combination. */
  axisMapping: AxisMapping | null
  /** Axes outside their limits at the current playback step (empty when none). */
  stepViolations: LimitViolation[]

  // Configurator
  selectedNode: string | null

  // Actions
  loadPreset: (key: string) => void
  loadConfig: (config: KinematicConfig, preserveState?: boolean) => void
  setAxisValue: (name: string, value: number) => void
  resetAxes: () => void
  bumpVersion: () => void

  // G-code actions
  setGcode: (gcode: string) => void
  parseGcode: () => void
  setCurrentStep: (step: number) => void
  setIsPlaying: (playing: boolean) => void
  setToolPath: (points: SimPoint[]) => void
  setPlaybackSpeed: (speed: number) => void
  applyStep: (step: number) => void  // apply toolPath[step] to chain axes

  setActiveCombination: (id: number | null) => void

  // Configurator actions
  setSelectedNode: (name: string | null) => void
  addAxis: (parentAxisName: string, deviceId: number, axis: AxisDef) => void
  addDevice: (device: { name: string; type: string; axes: AxisDef[] }) => void
  removeAxis: (axisName: string) => void
  updateAxis: (axisName: string, changes: Partial<AxisDef>) => void
  rebuildChain: () => void
}

function buildInfoString(config: KinematicConfig): string {
  return (
    `${config.kinematic} | ${config.axisCount} axes ` +
    `(${config.linearAxes.join(',')}) ` +
    `(${config.rotaryAxes.join(',') || 'none'}) | ` +
    `PP: ${config.postprocessor}`
  )
}

const DEFAULT_GCODE = `; CNC Trainer - Example G-Code
; Siemens Sinumerik format
G90 G17 ; absolute, XY plane
G54     ; work coordinate system 1

; --- Rapid to start ---
G0 X0 Y0 Z50
G0 X10 Y10

; --- Square profile ---
G1 Z-5 F500
G1 X100 F1000
G1 Y100
G1 X10
G1 Y10

; --- Diagonal ---
G0 Z50
G0 X50 Y50
G1 Z-10 F300
G1 X150 Y150

; --- Return home ---
G0 Z100
G0 X0 Y0
M30
`

export const useMachineStore = create<MachineStore>((set, get) => ({
  config: null,
  chain: null,
  machineName: '',
  machineInfo: '',
  version: 0,

  gcode: DEFAULT_GCODE,
  parsedBlocks: [],
  toolPath: [],
  diagnostics: [],
  programDuration: 0,
  gcodeDialect: null,
  currentStep: 0,
  isPlaying: false,
  playbackSpeed: 2,

  selectedNode: null,
  activeCombinationId: null,
  axisMapping: null,
  stepViolations: [],

  loadPreset: (key) => {
    const config = PRESETS[key]
    if (config) get().loadConfig(config)
  },

  loadConfig: (config, preserveState = false) => {
    const prev = get()
    const chain = new KinematicChain(config)
    // Restore axis positions from previous chain if preserving state.
    // No clamping: a simulated out-of-limit position must survive a config edit.
    if (preserveState && prev.chain) {
      chain.setAxisValues(prev.chain.getAllPositions(), false)
    }
    chain.updateMatrices()
    // Keep the selected combination across edits if it still exists, else pick the first one
    const combos = config.combinations ?? []
    const keepComb = preserveState && combos.some(c => c.id === prev.activeCombinationId)
    const combId = keepComb ? prev.activeCombinationId : (combos.length > 0 ? combos[0].id : null)
    set({
      config,
      chain,
      machineName: config.name,
      machineInfo: buildInfoString(config),
      activeCombinationId: combId,
      axisMapping: buildAxisMapping(config, chain, combId),
      ...(preserveState
        ? {}
        : { toolPath: [], parsedBlocks: [], diagnostics: [], programDuration: 0, currentStep: 0, isPlaying: false, selectedNode: null, stepViolations: [] }),
      version: get().version + 1,
    })
  },

  setAxisValue: (name, value) => {
    const { chain } = get()
    if (!chain) return
    chain.setAxisValue(name, value)
    set({ version: get().version + 1 })
  },

  resetAxes: () => {
    const { chain } = get()
    if (!chain) return
    const zeros: Record<string, number> = {}
    for (const name of chain.nodes.keys()) zeros[name] = 0
    chain.setAxisValues(zeros)
    set({ version: get().version + 1, stepViolations: [] })
  },

  bumpVersion: () => set({ version: get().version + 1 }),

  setGcode: (gcode) => set({ gcode }),

  parseGcode: () => {
    const { gcode, chain, axisMapping } = get()
    // Rapid rates of the physical axes each programmed letter drives (for G0 timing)
    const rapid: Partial<Record<AxisLetter, number>> = {}
    if (chain && axisMapping) {
      const letters: AxisLetter[][] = [['X', 'Y', 'Z'], ['A', 'B', 'C']]
      ;[axisMapping.linear, axisMapping.rotary].forEach((names, g) => names.forEach((name, i) => {
        const r = name ? chain.nodes.get(name)?.axis.rapid : undefined
        if (r) rapid[letters[g][i]] = r
      }))
    }
    const res = parseProgram(gcode, { rapid })
    const diagnostics = [...res.diagnostics]
    // Programmed axes the active sub-machine cannot drive — their motion is silently lost otherwise
    if (axisMapping) {
      const driven = describeDriven(axisMapping)
      for (const [letter, line] of Object.entries(res.usedAxes)) {
        if (!driven.has(letter)) {
          diagnostics.push({ line: line!, severity: 'warning', message: `${letter} is programmed but the active sub-machine has no axis mapped to it — ${letter} moves are not shown` })
        }
      }
      diagnostics.sort((a, b) => (a.line || Infinity) - (b.line || Infinity))
    }
    set({
      parsedBlocks: res.blocks, toolPath: res.points, diagnostics, programDuration: res.duration,
      gcodeDialect: res.dialect, currentStep: 0, isPlaying: false, stepViolations: [],
    })
  },

  setCurrentStep: (step) => set({ currentStep: step }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setToolPath: (points) => set({ toolPath: points }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

  applyStep: (step) => {
    const { chain, toolPath, axisMapping, stepViolations } = get()
    if (!chain || !axisMapping || step < 0 || step >= toolPath.length) return
    // Mapping is pre-resolved (combination axis IDs → names); one matrix update per step.
    // Simulation never clamps — out-of-limit moves are reported, not hidden.
    const violations = chain.setAxisValues(mapPointToAxes(toolPath[step], axisMapping), false)
    // Keep the same empty array while in limits, so selectors don't see a new value every frame
    const changed = violations.length > 0 || stepViolations.length > 0
    set({
      currentStep: step,
      version: get().version + 1,
      ...(changed ? { stepViolations: violations } : {}),
    })
  },

  setActiveCombination: (id) => {
    const { config, chain } = get()
    set({
      activeCombinationId: id,
      axisMapping: config && chain ? buildAxisMapping(config, chain, id) : null,
    })
  },

  setSelectedNode: (name) => set({ selectedNode: name }),

  addAxis: (parentAxisName, deviceId, axis) => {
    const { config } = get()
    if (!config) return

    // Ensure required defaults for missing fields
    const completeAxis: AxisDef = {
      ...axis,
      id: axis.id ?? Math.floor(Math.random() * 9000) + 1000,
      homeRef: axis.homeRef ?? 0,
      children: axis.children ?? [],
    }

    const newConfig = JSON.parse(JSON.stringify(config)) as KinematicConfig

    const addToChildren = (axes: AxisDef[]): boolean => {
      for (const a of axes) {
        if (a.name === parentAxisName) {
          if (!a.children) a.children = []
          a.children.push(completeAxis)
          return true
        }
        if (a.children && addToChildren(a.children)) return true
      }
      return false
    }

    const dev = newConfig.devices.find(d => d.id === deviceId)
    if (dev) {
      if (!parentAxisName) {
        dev.axes.push(completeAxis)
      } else {
        addToChildren(dev.axes)
      }
    }

    // Update axis count and lists
    newConfig.axisCount = countAxes(newConfig)
    const { linear, rotary } = collectAxisNames(newConfig)
    newConfig.linearAxes = linear
    newConfig.rotaryAxes = rotary

    get().loadConfig(newConfig, true)
  },

  addDevice: (device) => {
    const { config } = get()
    if (!config) return

    const newConfig = JSON.parse(JSON.stringify(config)) as KinematicConfig
    const maxId = newConfig.devices.reduce((mx, d) => Math.max(mx, d.id), 0)
    newConfig.devices.push({
      id: maxId + 1,
      name: device.name,
      type: device.type as any,
      maxSpin: device.type === 'spindle' ? 20000 : 0,
      axes: device.axes.map(a => ({
        ...a,
        id: a.id ?? Math.floor(Math.random() * 9000) + 1000,
        homeRef: a.homeRef ?? 0,
        children: a.children ?? [],
      })),
    })

    newConfig.axisCount = countAxes(newConfig)
    const { linear, rotary } = collectAxisNames(newConfig)
    newConfig.linearAxes = linear
    newConfig.rotaryAxes = rotary

    get().loadConfig(newConfig, true)
  },

  removeAxis: (axisName) => {
    const { config } = get()
    if (!config) return

    const newConfig = JSON.parse(JSON.stringify(config)) as KinematicConfig

    const removeFromArray = (axes: AxisDef[]): boolean => {
      const idx = axes.findIndex(a => a.name === axisName)
      if (idx >= 0) {
        axes.splice(idx, 1)
        return true
      }
      for (const a of axes) {
        if (a.children && removeFromArray(a.children)) return true
      }
      return false
    }

    for (const dev of newConfig.devices) {
      if (removeFromArray(dev.axes)) break
    }

    newConfig.axisCount = countAxes(newConfig)
    const { linear, rotary } = collectAxisNames(newConfig)
    newConfig.linearAxes = linear
    newConfig.rotaryAxes = rotary

    get().loadConfig(newConfig, true)
  },

  updateAxis: (axisName, changes) => {
    const { config } = get()
    if (!config) return

    const newConfig = JSON.parse(JSON.stringify(config)) as KinematicConfig

    const updateInTree = (axes: AxisDef[]): boolean => {
      for (const a of axes) {
        if (a.name === axisName) {
          Object.assign(a, changes)
          return true
        }
        if (a.children && updateInTree(a.children)) return true
      }
      return false
    }

    for (const dev of newConfig.devices) {
      if (updateInTree(dev.axes)) break
    }

    newConfig.axisCount = countAxes(newConfig)
    const { linear, rotary } = collectAxisNames(newConfig)
    newConfig.linearAxes = linear
    newConfig.rotaryAxes = rotary

    // Rebuild chain preserving axis positions
    get().loadConfig(newConfig, true)
  },

  rebuildChain: () => {
    const { config } = get()
    if (config) get().loadConfig(config, true)
  },
}))

/** Programmed letters that the mapping drives. */
function describeDriven(m: AxisMapping): Set<string> {
  const s = new Set<string>()
  ;['X', 'Y', 'Z'].forEach((l, i) => { if (m.linear[i]) s.add(l) })
  ;['A', 'B', 'C'].forEach((l, i) => { if (m.rotary[i]) s.add(l) })
  return s
}

function countAxes(config: KinematicConfig): number {
  let count = 0
  const countInTree = (axes: AxisDef[]) => {
    for (const a of axes) {
      if (a.type !== 'static') count++
      if (a.children) countInTree(a.children)
    }
  }
  for (const dev of config.devices) countInTree(dev.axes)
  return count
}

function collectAxisNames(config: KinematicConfig): { linear: string[]; rotary: string[] } {
  const linear: string[] = []
  const rotary: string[] = []
  const collect = (axes: AxisDef[]) => {
    for (const a of axes) {
      if (a.type === 'linear') linear.push(a.name)
      if (a.type === 'rotary') rotary.push(a.name)
      if (a.children) collect(a.children)
    }
  }
  for (const dev of config.devices) collect(dev.axes)
  return { linear, rotary }
}

export { DEFAULT_GCODE }

// Debug: expose store globally for console/MCP testing
if (typeof window !== 'undefined') {
  ;(window as any).__MACHINE_STORE__ = useMachineStore
}

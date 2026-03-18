import { create } from 'zustand'
import { KinematicChain } from '../engine/KinematicChain'
import type { KinematicConfig, AxisDef } from '../engine/KinematicChain'
import { GCodeParser } from '../engine/GCodeParser'
import type { SimPoint, GCodeBlock } from '../engine/GCodeParser'
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
  currentStep: number
  isPlaying: boolean
  playbackSpeed: number  // steps per frame (1=slow, 2, 5, 10, 20=fast)

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
  currentStep: 0,
  isPlaying: false,
  playbackSpeed: 2,

  selectedNode: null,

  loadPreset: (key) => {
    const config = PRESETS[key]
    if (config) get().loadConfig(config)
  },

  loadConfig: (config, preserveState = false) => {
    const prev = get()
    const chain = new KinematicChain(config)
    // Restore axis positions from previous chain if preserving state
    if (preserveState && prev.chain) {
      const oldPositions = prev.chain.getAllPositions()
      for (const [name, value] of Object.entries(oldPositions)) {
        try { chain.setAxisValue(name, value) } catch { /* axis may not exist anymore */ }
      }
    }
    chain.updateMatrices()
    set({
      config,
      chain,
      machineName: config.name,
      machineInfo: buildInfoString(config),
      ...(preserveState ? {} : { toolPath: [], currentStep: 0, isPlaying: false, selectedNode: null }),
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
    for (const [name] of chain.nodes) {
      chain.setAxisValue(name, 0)
    }
    set({ version: get().version + 1 })
  },

  bumpVersion: () => set({ version: get().version + 1 }),

  setGcode: (gcode) => set({ gcode }),

  parseGcode: () => {
    const { gcode } = get()
    const parser = new GCodeParser()
    parser.parse(gcode)
    const points = parser.interpolate(1.0)
    set({ parsedBlocks: parser.blocks, toolPath: points, currentStep: 0, isPlaying: false })
  },

  setCurrentStep: (step) => set({ currentStep: step }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setToolPath: (points) => set({ toolPath: points }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

  applyStep: (step) => {
    const { chain, toolPath } = get()
    if (!chain || step < 0 || step >= toolPath.length) return
    const pt = toolPath[step]
    const axisMap: Record<string, number> = {
      'X': pt.x, 'Y': pt.y, 'Z': pt.z,
      'A': pt.a, 'B': pt.b, 'C': pt.c,
    }
    for (const [name] of chain.nodes) {
      if (name in axisMap) chain.setAxisValue(name, axisMap[name])
    }
    set({ currentStep: step, version: get().version + 1 })
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

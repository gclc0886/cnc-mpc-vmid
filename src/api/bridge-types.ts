/**
 * Contract between the MCP server (mcp-server/cnc-trainer-mcp.ts) and the app
 * (src/api/BridgeClient.ts). Both sides import these types, so adding a method
 * here forces a matching handler in BridgeClient (compile-time exhaustive).
 *
 * Type-only module: no runtime imports, safe to import from the Node MCP server.
 */

type Vec3 = { x: number; y: number; z: number }
type Ok = { success: true }
type NoParams = Record<string, never>

export interface LimitViolationInfo {
  axis: string
  value: number
  min: number
  max: number
}

export interface StepInfo {
  step: number
  totalSteps: number
  /** Index into parsed blocks, and the 1-based source line it came from. */
  blockIndex: number
  line: number | null
  source: string | null
  rapid: boolean
  /** Effective path speed: mm/min (deg/min for pure rotary moves). */
  feed: number
  /** Program time at this step, seconds. */
  time: number
  /** Programmed coordinates at this step (as interpolated from the G-code). */
  programmed: { X: number; Y: number; Z: number; A: number; B: number; C: number }
  /** Physical axis values the active sub-machine maps them to. */
  axes: Record<string, number>
  /** Which physical axis each programmed letter drives (null = not driven). */
  mapping: Record<string, string | null>
  activeCombination: { id: number; name: string } | null
  limitViolations: LimitViolationInfo[]
  /** Tool tip, only when `step` is the step currently applied to the machine. */
  tcp: { mcs: Vec3; wcs: Vec3 } | null
}

export interface DiagnosticInfo {
  line: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface ParseSummary {
  totalSteps: number
  blocks: number
  /** Estimated program time, seconds. */
  duration: number
  dialect: string | null
  errors: number
  warnings: number
  /** First diagnostics (up to 50), sorted by line. */
  diagnostics: DiagnosticInfo[]
}

/** method → { params, result } */
export interface BridgeMethods {
  // --- State reading ---
  get_machine_state: { params: NoParams; result: unknown }
  get_axis_positions: { params: NoParams; result: Record<string, number> }
  get_matrices: { params: NoParams; result: string }
  get_tool_position: { params: NoParams; result: { mcs: Vec3; wcs: Vec3 } | { error: string } }
  get_config: { params: NoParams; result: unknown }

  // --- Machine control ---
  load_preset: { params: { key: string }; result: { success: true; name: string } }
  load_vmid: { params: { xml: string }; result: { success: true; name: string; axes: number; combinations: number } }
  set_axis_value: { params: { name: string; value: number }; result: Ok }
  set_axes: { params: { axes: Record<string, number> }; result: Ok }
  reset_axes: { params: NoParams; result: Ok }

  // --- G-code ---
  load_gcode: { params: { gcode: string }; result: Ok }
  parse_gcode: { params: NoParams; result: ParseSummary }

  // --- Animation ---
  play_animation: { params: NoParams; result: Ok }
  pause_animation: { params: NoParams; result: Ok }
  set_animation_step: { params: { step: number }; result: StepInfo }
  get_animation_state: { params: NoParams; result: { currentStep: number; totalSteps: number; isPlaying: boolean } }
  get_step_info: { params: { step?: number }; result: StepInfo }

  // --- Configuration ---
  update_axis_config: { params: { axisName: string; changes: Record<string, unknown> }; result: Ok }
  add_axis: { params: { parentAxisName: string; deviceId: number; axis: Record<string, unknown> }; result: Ok }
  add_device: { params: { device: Record<string, unknown> }; result: Ok }
  remove_axis: { params: { axisName: string }; result: Ok }

  // --- View ---
  /** JPEG of the app window, base64 (Electron only). */
  capture_screenshot: { params: { width?: number }; result: { mimeType: 'image/jpeg'; data: string; width: number; height: number } }
}

export type BridgeMethod = keyof BridgeMethods
export type BridgeParams<M extends BridgeMethod> = BridgeMethods[M]['params']
export type BridgeResult<M extends BridgeMethod> = BridgeMethods[M]['result']

/** Command sent from MCP server to the app via WebSocket */
export interface BridgeCommand<M extends BridgeMethod = BridgeMethod> {
  id: number
  method: M
  params: BridgeParams<M>
}

/** Response sent from the app back to the MCP server */
export interface BridgeResponse {
  id: number
  result?: unknown
  error?: string
}

/**
 * Control message a newer MCP server instance sends to the one holding the port,
 * asking it to release it (the latest Claude Code session takes over the app).
 */
export interface BridgeControl {
  control: 'takeover'
}

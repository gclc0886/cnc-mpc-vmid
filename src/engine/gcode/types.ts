/** Shared types of the G-code pipeline: text → Lexer → Interpreter → Interpolator. */

export type Dialect = 'sinumerik' | 'fanuc'

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  /** 1-based source line. */
  line: number
  severity: Severity
  message: string
}

/** Per-word positioning modifier (Sinumerik AC/IC/DC/ACP/ACN). */
export type PosMode = 'AC' | 'IC' | 'DC' | 'ACP' | 'ACN'

export type Word =
  /**
   * Address with a value: X10, G1, F=R1*2, X=IC(5), CR=20, A=DC(90).
   * `value` is set for literals; `expr` holds an expression evaluated at run time.
   * `letter` is the address name: one letter, or an extended address like CR / TURN.
   */
  | { kind: 'addr'; letter: string; value: number | null; expr?: string; mode?: PosMode; text: string }
  /** Parameter / variable assignment: R1=10, R2=R1*2 */
  | { kind: 'assign'; name: string; expr: string; text: string }
  /** Bare keyword: DIAMON, TRAORI, MCALL, SUPA, TRANS, GOTOF … */
  | { kind: 'keyword'; name: string; text: string }
  /** Call with arguments: CYCLE83(…), WORKPIECE(…), MSG("…") */
  | { kind: 'call'; name: string; args: string[]; text: string }
  /** Value given as a string: T="DRILL_10" */
  | { kind: 'string'; letter: string; value: string; text: string }
  /** Something the lexer could not read. */
  | { kind: 'unknown'; text: string }

export interface LexedBlock {
  /** 1-based source line. */
  line: number
  raw: string
  /** N-number if present. */
  blockNumber?: number
  /** Sinumerik jump label (LABEL:). */
  label?: string
  /** Block starts with '/' (skippable). Executed by default. */
  skippable: boolean
  words: Word[]
  comment?: string
}

export interface Pos6 { x: number; y: number; z: number; a: number; b: number; c: number }

export type Plane = 17 | 18 | 19
export type FeedMode = 'G93' | 'G94' | 'G95'

/** Offsets per programmed axis letter (mm / degrees). */
export interface AxisOffsets { x: number; y: number; z: number; a: number; b: number; c: number }

export interface ToolEntry {
  /** Length L1 (mm), applied along the tool axis of the working plane. */
  length: number
  /** Radius (mm) — for display; radius compensation is not simulated. */
  radius: number
}

/**
 * Machine setup the program runs against: settable work offsets (G54…) and tool table.
 * Keys: 'G54'…'G57', 'G505'… ; tool keys are the T value as text ("1", "INSTRUMENT_2")
 * and, for Fanuc G43 H, the H number as text.
 */
export interface MachineSetup {
  workOffsets: Record<string, AxisOffsets>
  tools: Record<string, ToolEntry>
}

/**
 * Program (WCS) → machine axis values for one move, without kinematic transformation:
 *   linear: m = R·p + t + offset + toolVec      rotary: m = p + rotShift + offset
 * R, t: programmable frame (TRANS/ROT…); offset: active G54…; toolVec: tool length along
 * the working plane's tool axis (G17 → Z, G18 → Y, G19 → X).
 */
export interface MoveTransform {
  /** Row-major 3×3 rotation of the programmable frame. */
  R: number[]
  t: [number, number, number]
  rotShift: [number, number, number]
  offset: AxisOffsets
  toolVec: [number, number, number]
  toolLength: number
  toolRadius: number
  /** Key of the active tool in the tool table (null = none). */
  toolKey: string | null
}

/** One programmed motion, in program (workpiece) coordinates. */
export interface ProgramMove {
  /** Index into the lexed blocks / `GCodeBlock[]`. */
  blockIndex: number
  line: number
  /** 'swivel' = rotary positioning of CYCLE800 (target orientation in `swivel`). */
  kind: 'rapid' | 'linear' | 'arc' | 'dwell' | 'swivel'
  start: Pos6
  end: Pos6
  arc?: {
    /** Arc center in program coordinates (in-plane components; helix axis = start value). */
    center: { x: number; y: number; z: number }
    plane: Plane
    cw: boolean
    /** Radius at the start point. */
    radius: number
    /** Radius at the end point (differs from `radius` when the end point is off the circle). */
    endRadius: number
    /** Signed sweep in radians, positive = counter-clockwise viewed from the plane normal. */
    sweep: number
  }
  /** Programmed F (mm/min for G94, mm/rev for G95, 1/min for G93). */
  feed: number
  feedMode: FeedMode
  /** Spindle speed in effect (rpm), needed for G95 timing. */
  spindle: number
  /** Dwell duration in seconds (kind = 'dwell'). */
  dwell?: number
  tool: { T: number | string | null; D: number }
  workOffset: string
  /** G53/G153/SUPA: the block was programmed in machine coordinates (already converted to WCS). */
  machineCoords: boolean
  plane: Plane
  /** How program coordinates of this move become machine axis values. */
  xf: MoveTransform
  /**
   * Kinematic transformation in effect:
   * 'none'   — axes = MachineMapper (frame + offset + tool length);
   * 'traori' — TRAORI: tool tip held on the programmed point while rotary axes move (RTCP);
   * 'swivel' — CYCLE800 plane active: rotary axes fixed, linear axes solved through the kinematics.
   */
  kin: 'none' | 'traori' | 'swivel'
  /** Axis letters programmed in this block (e.g. "XZ"); unprogrammed axes keep their actual position. */
  programmed: string
  /** TRAORI orientation vector A3/B3/C3 at the end of the move, in program coordinates (unit). */
  orient?: [number, number, number]
  /** CYCLE800 rotary positioning: tool axis to reach (program frame before the new plane) and direction choice. */
  swivel?: { toolAxis: [number, number, number]; dir: -1 | 0 | 1; direct?: number[] }
}

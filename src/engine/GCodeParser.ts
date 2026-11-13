/**
 * Facade over the G-code pipeline in ./gcode:
 *   text → Lexer → Interpreter (modal state) → ProgramMove[] → Interpolator → SimPoint[]
 */
import { interpret } from './gcode/Interpreter'
import type { AxisLetter, InterpretOptions } from './gcode/Interpreter'
import { interpolate } from './gcode/Interpolator'
import type { InterpolateOptions, SimPoint } from './gcode/Interpolator'
import type { Diagnostic, Dialect, ProgramMove } from './gcode/types'

export type { SimPoint } from './gcode/Interpolator'
export type { Diagnostic, Dialect, ProgramMove, MachineSetup, AxisOffsets, ToolEntry } from './gcode/types'
export type { AxisLetter } from './gcode/Interpreter'

/** One non-empty source line. `SimPoint.blockIndex` indexes this array. */
export interface GCodeBlock {
  /** 1-based source line number. */
  line: number
  raw: string
}

export interface ParseResult {
  blocks: GCodeBlock[]
  moves: ProgramMove[]
  points: SimPoint[]
  diagnostics: Diagnostic[]
  /** Program time in seconds. */
  duration: number
  /** Programmed axis letters → first line using them. */
  usedAxes: Partial<Record<AxisLetter, number>>
  /** Controller dialect used (auto-detected unless given). */
  dialect: Dialect
  /** Tool-table keys the program uses (T values / Fanuc H numbers). */
  toolsUsed: string[]
  /** Work offsets the program selects. */
  workOffsetsUsed: string[]
}

export type ParseOptions = InterpretOptions & Omit<InterpolateOptions, 'dialect'>

export function parseProgram(text: string, options: ParseOptions = {}): ParseResult {
  const r = interpret(text, options)
  const { points, duration, coarsened } = interpolate(r.moves, { ...options, dialect: r.dialect })
  const diagnostics = [...r.diagnostics]
  if (coarsened > 1) {
    diagnostics.push({
      line: 0, severity: 'info',
      message: `Long program: interpolation step coarsened ×${coarsened.toFixed(1)} to stay under the sample limit`,
    })
  }
  return {
    blocks: r.blocks.map(b => ({ line: b.line, raw: b.raw })),
    moves: r.moves,
    points,
    diagnostics,
    duration,
    usedAxes: r.usedAxes,
    dialect: r.dialect,
    toolsUsed: r.toolsUsed,
    workOffsetsUsed: r.workOffsetsUsed,
  }
}

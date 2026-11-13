import type { Dialect, Pos6, ProgramMove } from './types'
import type { AxisLetter } from './Interpreter'

/** One simulation sample (program coordinates) — consumed by playback, toolpath and MCP. */
export interface SimPoint {
  x: number
  y: number
  z: number
  a: number
  b: number
  c: number
  /** Effective path speed for display: mm/min, or deg/min for pure rotary moves. */
  feed: number
  rapid: boolean
  /** Index into the program blocks (`GCodeBlock[]`). */
  blockIndex: number
  /** Program time at this sample, seconds from start. */
  t: number
}

export interface InterpolateOptions {
  /** Feed semantics; normally the dialect the interpreter resolved. */
  dialect?: Dialect | 'auto'
  /** Max linear distance between samples, mm (default 1). */
  linearStep?: number
  /** Max rotary change between samples, degrees (default 1). */
  angularStep?: number
  /** Max angle swept per arc sample, degrees — keeps small circles round (default 10). */
  arcAngleStep?: number
  /** Upper bound on the number of samples; steps are coarsened to stay under it (default 500 000). */
  maxSamples?: number
  /** Rapid rate per programmed axis, mm/min or deg/min (from the machine's VMID). */
  rapid?: Partial<Record<AxisLetter, number>>
  defaultRapidLinear?: number
  defaultRapidRotary?: number
}

export interface InterpolateResult {
  points: SimPoint[]
  /** Total program time, seconds. */
  duration: number
  /** Step multiplier applied to respect maxSamples (1 = none). */
  coarsened: number
}

const LIN: (keyof Pos6)[] = ['x', 'y', 'z']
const ROT: (keyof Pos6)[] = ['a', 'b', 'c']
const LETTER: Record<keyof Pos6, AxisLetter> = { x: 'X', y: 'Y', z: 'Z', a: 'A', b: 'B', c: 'C' }
const PLANE_AXES: Record<17 | 18 | 19, [keyof Pos6, keyof Pos6, keyof Pos6]> = {
  17: ['x', 'y', 'z'], 18: ['z', 'x', 'y'], 19: ['y', 'z', 'x'],
}
const DEG = Math.PI / 180

function linearLength(m: ProgramMove): number {
  if (m.kind === 'arc' && m.arc) {
    const [, , wk] = PLANE_AXES[m.arc.plane]
    const rAvg = (m.arc.radius + m.arc.endRadius) / 2
    return Math.hypot(Math.abs(m.arc.sweep) * rAvg, m.end[wk] - m.start[wk])
  }
  return Math.hypot(m.end.x - m.start.x, m.end.y - m.start.y, m.end.z - m.start.z)
}

function rotaryLength(m: ProgramMove): number {
  return Math.hypot(m.end.a - m.start.a, m.end.b - m.start.b, m.end.c - m.start.c)
}

function maxRotaryDelta(m: ProgramMove): number {
  return Math.max(...ROT.map(k => Math.abs(m.end[k] - m.start[k])))
}

/**
 * Block duration in seconds.
 * Sinumerik: F is the path speed of the geometry axes; rotary axes follow. Only when no
 * linear axis moves is F taken as deg/min for the rotary axes. Fanuc: F applies to the
 * combined vector (mm and degrees mixed).
 */
function moveSeconds(m: ProgramMove, opts: Required<Pick<InterpolateOptions, 'defaultRapidLinear' | 'defaultRapidRotary'>> & InterpolateOptions): { seconds: number; speed: number } {
  if (m.kind === 'dwell') return { seconds: m.dwell ?? 0, speed: 0 }

  if (m.kind === 'rapid') {
    // Linear-interpolated rapid: the slowest axis sets the time
    let minutes = 0
    for (const k of [...LIN, ...ROT]) {
      const d = Math.abs(m.end[k] - m.start[k])
      if (d < 1e-9) continue
      const isRot = ROT.includes(k)
      const rate = opts.rapid?.[LETTER[k]] ?? (isRot ? opts.defaultRapidRotary : opts.defaultRapidLinear)
      minutes = Math.max(minutes, d / rate)
    }
    const lin = linearLength(m)
    const len = lin > 1e-9 ? lin : rotaryLength(m)
    return { seconds: minutes * 60, speed: minutes > 0 ? len / minutes : 0 }
  }

  const lin = linearLength(m)
  const rot = rotaryLength(m)
  const len = opts.dialect === 'fanuc' ? Math.hypot(lin, rot) : (lin > 1e-9 ? lin : rot)
  if (len < 1e-12) return { seconds: 0, speed: 0 }

  if (m.feedMode === 'G93') {
    const minutes = m.feed > 0 ? 1 / m.feed : 0
    return { seconds: minutes * 60, speed: minutes > 0 ? len / minutes : 0 }
  }
  let speed = m.feed // mm/min (or deg/min)
  if (m.feedMode === 'G95') speed = m.spindle > 0 ? m.feed * m.spindle : m.feed
  if (speed <= 0) speed = 1000 // no F: already reported by the interpreter; keep time finite
  return { seconds: (len / speed) * 60, speed }
}

function stepsFor(m: ProgramMove, lin: number, ang: number, arcAng: number): number {
  if (m.kind === 'dwell') return 1
  let n = Math.max(Math.ceil(linearLength(m) / lin), Math.ceil(maxRotaryDelta(m) / ang))
  if (m.kind === 'arc' && m.arc) n = Math.max(n, Math.ceil(Math.abs(m.arc.sweep) / (arcAng * DEG)))
  return Math.max(1, n)
}

function pointAt(m: ProgramMove, t: number): Pos6 {
  const p: Pos6 = {
    x: m.start.x + (m.end.x - m.start.x) * t,
    y: m.start.y + (m.end.y - m.start.y) * t,
    z: m.start.z + (m.end.z - m.start.z) * t,
    a: m.start.a + (m.end.a - m.start.a) * t,
    b: m.start.b + (m.end.b - m.start.b) * t,
    c: m.start.c + (m.end.c - m.start.c) * t,
  }
  if (m.kind === 'arc' && m.arc) {
    if (t >= 1) return { ...m.end }
    const [uk, vk] = PLANE_AXES[m.arc.plane]
    const cu = m.arc.center[uk as 'x' | 'y' | 'z']
    const cv = m.arc.center[vk as 'x' | 'y' | 'z']
    const a0 = Math.atan2(m.start[vk] - cv, m.start[uk] - cu)
    const ang = a0 + m.arc.sweep * t
    const r = m.arc.radius + (m.arc.endRadius - m.arc.radius) * t
    p[uk] = cu + r * Math.cos(ang)
    p[vk] = cv + r * Math.sin(ang)
    // helix axis (w) stays linear in t, already set above
  }
  return p
}

export function interpolate(moves: ProgramMove[], options: InterpolateOptions = {}): InterpolateResult {
  const opts = {
    defaultRapidLinear: 10000,
    defaultRapidRotary: 7200,
    ...options,
  }
  let lin = opts.linearStep ?? 1
  let ang = opts.angularStep ?? 1
  let arcAng = opts.arcAngleStep ?? 10
  const maxSamples = opts.maxSamples ?? 500_000

  let estimate = 0
  for (const m of moves) estimate += stepsFor(m, lin, ang, arcAng)
  let coarsened = 1
  if (estimate > maxSamples) {
    coarsened = estimate / maxSamples
    lin *= coarsened; ang *= coarsened; arcAng = Math.min(arcAng * coarsened, 45)
  }

  const points: SimPoint[] = []
  let time = 0
  for (const m of moves) {
    const { seconds, speed } = moveSeconds(m, opts)
    const n = stepsFor(m, lin, ang, arcAng)
    for (let s = 1; s <= n; s++) {
      const f = s / n
      const p = pointAt(m, f)
      points.push({
        ...p,
        feed: speed,
        rapid: m.kind === 'rapid',
        blockIndex: m.blockIndex,
        t: time + seconds * f,
      })
    }
    time += seconds
  }
  return { points, duration: time, coarsened }
}

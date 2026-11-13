import { KinematicChain, hasRealLimits } from './KinematicChain'
import type { KinematicConfig } from './KinematicChain'
import type { AxisMapping } from './AxisMapping'
import type { SimPoint, ProgramMove, Diagnostic } from './GCodeParser'
import { apply3, toMachine } from './gcode/MachineMapper'
import type { Pos6 } from './gcode/types'

type V3 = [number, number, number]
const DEG = Math.PI / 180

/**
 * Inverse kinematics on any serial machine description (no per-machine formulas).
 *
 * Positions are tool-tip coordinates in the workpiece (table leaf) frame — the same
 * frame the trace is drawn in. Values are indexed by programmed letter:
 * 0..2 = X/Y/Z (linear), 3..5 = A/B/C (rotary); the active sub-machine mapping
 * resolves letters to physical axes.
 */
export class KinematicSolver {
  readonly chain: KinematicChain
  private readonly names: (string | null)[]
  private readonly linCache = new Map<string, { f0: V3; Jinv: number[] | null }>()

  constructor(config: KinematicConfig, mapping: AxisMapping) {
    this.chain = new KinematicChain(config)
    const zeros: Record<string, number> = {}
    for (const n of this.chain.nodes.keys()) zeros[n] = 0
    this.chain.setAxisValues(zeros, false)
    this.names = [...mapping.linear.slice(0, 3), ...mapping.rotary.slice(0, 3)]
    while (this.names.length < 6) this.names.push(null)
  }

  /** Letters (3..5) that drive a physical rotary axis. */
  get freeRotary(): number[] {
    return [3, 4, 5].filter(i => this.names[i] !== null)
  }

  private apply(values: number[], toolLen: number) {
    const rec: Record<string, number> = {}
    for (let i = 0; i < 6; i++) {
      const n = this.names[i]
      if (n !== null && values[i] !== undefined) rec[n] = values[i]
    }
    this.chain.setTool(toolLen, 0)
    this.chain.setAxisValues(rec, false)
  }

  /** Tool tip in the workpiece frame for machine values (by letter). */
  tipRel(values: number[], toolLen: number): V3 {
    this.apply(values, toolLen)
    return this.chain.getRelativeMatrix().getTranslation()
  }

  /** Tool axis (unit, from tip towards the spindle) in the workpiece frame. */
  toolAxisRel(values: number[]): V3 {
    this.apply(values, 0)
    const leaf = this.chain.getDeviceLeafNode('spindle')
    const table = this.chain.getDeviceLeafNode('table')
    if (!leaf) return [0, 0, 1]
    const a = this.chain.toolAxis
    const L = leaf.worldMatrix.data
    const w: V3 = [
      L[0] * a.x + L[1] * a.y + L[2] * a.z,
      L[4] * a.x + L[5] * a.y + L[6] * a.z,
      L[8] * a.x + L[9] * a.y + L[10] * a.z,
    ]
    if (!table) return w
    const T = table.worldMatrix.data // rotation transpose: world → table leaf
    return [
      T[0] * w[0] + T[4] * w[1] + T[8] * w[2],
      T[1] * w[0] + T[5] * w[1] + T[9] * w[2],
      T[2] * w[0] + T[6] * w[1] + T[10] * w[2],
    ]
  }

  /**
   * Linear machine values (X,Y,Z letters) that put the tool tip at `target` (workpiece
   * frame) with the rotary letters fixed at `rot` (A,B,C). With rotaries fixed the
   * forward kinematics is affine in the linear axes: tip = f0 + J·lin, so one 3×3 solve
   * is exact. J and f0 are cached per rotary state and tool length.
   */
  solveLinear(rot: number[], toolLen: number, target: V3): V3 | null {
    const key = `${rot[0]},${rot[1]},${rot[2]}|${toolLen}`
    let c = this.linCache.get(key)
    if (!c) {
      const base = [0, 0, 0, rot[0], rot[1], rot[2]]
      const f0 = this.tipRel(base, toolLen)
      const J = [0, 0, 0, 0, 0, 0, 0, 0, 0]
      for (let j = 0; j < 3; j++) {
        if (this.names[j] === null) continue
        const v = base.slice(); v[j] = 1
        const r = this.tipRel(v, toolLen)
        for (let i = 0; i < 3; i++) J[i * 3 + j] = r[i] - f0[i]
      }
      c = { f0, Jinv: invert3(J) }
      if (this.linCache.size > 20000) this.linCache.clear()
      this.linCache.set(key, c)
    }
    if (!c.Jinv) return null
    return apply3(c.Jinv, [target[0] - c.f0[0], target[1] - c.f0[1], target[2] - c.f0[2]])
  }

  /**
   * Rotary values (A,B,C letters) that align the tool axis with `target` (workpiece
   * frame). Finds all solutions (coarse grid + Gauss-Newton), brings each into the axis
   * limits as close to `current` as possible, then chooses by `dir` (sign of the first
   * free rotary axis; 0 = closest to current). Returns null when unreachable.
   */
  solveOrientation(target: V3, current: number[], dir: -1 | 0 | 1 = 0): { rot: number[]; errorDeg: number } | null {
    const free = this.freeRotary
    const t = normalize(target)
    const base = [0, 0, 0, current[0] ?? 0, current[1] ?? 0, current[2] ?? 0]
    if (free.length === 0) {
      const e = angleBetween(this.toolAxisRel(base), t)
      return e < 0.01 ? { rot: current.slice(0, 3), errorDeg: e } : null
    }
    const vars = free.slice(0, 2) // two rotary axes define the tool direction
    const residual = (ang: number[]): V3 => {
      const v = base.slice()
      vars.forEach((k, i) => { v[k] = ang[i] })
      const a = this.toolAxisRel(v)
      return [a[0] - t[0], a[1] - t[1], a[2] - t[2]]
    }
    const err2 = (ang: number[]) => { const r = residual(ang); return r[0] * r[0] + r[1] * r[1] + r[2] * r[2] }

    // Coarse search
    const step = vars.length === 1 ? 2 : 10
    const seeds: { ang: number[]; e: number }[] = []
    if (vars.length === 1) {
      for (let a = -180; a < 180; a += step) seeds.push({ ang: [a], e: err2([a]) })
    } else {
      for (let a = -180; a < 180; a += step) for (let b = -180; b < 180; b += step) seeds.push({ ang: [a, b], e: err2([a, b]) })
    }
    seeds.sort((p, q) => p.e - q.e)

    // Refine the best seeds with Gauss-Newton (numeric Jacobian, degrees)
    const sols: number[][] = []
    for (const s of seeds.slice(0, 24)) {
      const ang = s.ang.slice()
      for (let it = 0; it < 40; it++) {
        const r0 = residual(ang)
        const h = 1e-4
        const cols = ang.map((_, j) => {
          const a2 = ang.slice(); a2[j] += h
          const r = residual(a2)
          return [(r[0] - r0[0]) / h, (r[1] - r0[1]) / h, (r[2] - r0[2]) / h]
        })
        // Normal equations (1×1 or 2×2)
        if (cols.length === 1) {
          const c = cols[0]
          const n = c[0] * c[0] + c[1] * c[1] + c[2] * c[2]
          if (n < 1e-18) break
          ang[0] -= (c[0] * r0[0] + c[1] * r0[1] + c[2] * r0[2]) / n
        } else {
          const [c0, c1] = cols
          const a11 = dot(c0, c0), a12 = dot(c0, c1), a22 = dot(c1, c1)
          const b1 = dot(c0, r0), b2 = dot(c1, r0)
          const det = a11 * a22 - a12 * a12
          if (Math.abs(det) < 1e-18) break
          ang[0] -= (a22 * b1 - a12 * b2) / det
          ang[1] -= (a11 * b2 - a12 * b1) / det
        }
        if (Math.sqrt(dot(r0, r0)) < 1e-12) break
      }
      if (angleOfResidual(residual(ang)) < 1e-3 && !sols.some(o => o.every((v, i) => sameAngle(v, ang[i])))) sols.push(ang)
    }
    if (sols.length === 0) return null

    // Bring each solution into limits near the current position
    const placed: number[][] = []
    for (const s of sols) {
      const rot = [current[0] ?? 0, current[1] ?? 0, current[2] ?? 0]
      let ok = true
      vars.forEach((k, i) => {
        const cur = rot[k - 3]
        const v = this.wrapIntoLimits(k, s[i], cur)
        if (v === null) ok = false
        else rot[k - 3] = v
      })
      if (ok) placed.push(rot)
    }
    if (placed.length === 0) return null

    const first = vars[0] - 3
    const cost = (r: number[]) => r.reduce((acc, v, i) => acc + Math.abs(v - (current[i] ?? 0)), 0)
    placed.sort((a, b) => {
      if (dir !== 0) {
        const pa = Math.sign(a[first]) === dir ? 0 : 1
        const pb = Math.sign(b[first]) === dir ? 0 : 1
        if (pa !== pb) return pa - pb
      }
      return cost(a) - cost(b)
    })
    const best = placed[0]
    const v = base.slice(); v[3] = best[0]; v[4] = best[1]; v[5] = best[2]
    return { rot: best, errorDeg: angleBetween(this.toolAxisRel(v), t) }
  }

  /** Equivalent angle (±360·k) inside the axis limits, closest to `near`; null if none. */
  private wrapIntoLimits(letter: number, angle: number, near: number): number | null {
    const name = this.names[letter]
    const node = name ? this.chain.nodes.get(name) : undefined
    let v = angle + 360 * Math.round((near - angle) / 360)
    if (!node || !hasRealLimits(node.axis)) return v
    const { min, max } = node.axis.limits
    if (v >= min - 1e-9 && v <= max + 1e-9) return v
    // Try the nearest equivalents on both sides
    const cands: number[] = []
    for (let k = -20; k <= 20; k++) {
      const c = angle + 360 * k
      if (c >= min - 1e-9 && c <= max + 1e-9) cands.push(c)
    }
    if (cands.length === 0) return null
    cands.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))
    v = cands[0]
    return v
  }

  /** Rapid rate of a rotary letter (deg/min), default 7200. */
  rotaryRapid(letter: number): number {
    const n = this.names[letter]
    return (n ? this.chain.nodes.get(n)?.axis.rapid : undefined) ?? 7200
  }
}

// ─── Transformation stage over the whole program ────────────────────────────

const toArr = (p: Pos6) => [p.x, p.y, p.z, p.a, p.b, p.c]
const LETTERS = 'XYZABC'

/**
 * Computes machine values (mx..mc) for moves under TRAORI and CYCLE800 through the
 * kinematics, and keeps the machine position continuous across frame / offset /
 * transformation changes (a real control starts each move from where the axes are).
 * Updates `points` in place (machine values and times); returns diagnostics.
 */
export function applyKinematics(
  points: SimPoint[], moves: ProgramMove[], config: KinematicConfig, mapping: AxisMapping,
): Diagnostic[] {
  const diags: Diagnostic[] = []
  if (moves.length === 0 || points.length === 0) return diags
  const warned = new Set<string>()
  const once = (key: string, d: Diagnostic) => { if (!warned.has(key)) { warned.add(key); diags.push(d) } }

  let solver: KinematicSolver | null = null
  const S = () => (solver ??= new KinematicSolver(config, mapping))
  const workOrigin = new Map<string, V3>()
  /** Program zero in the workpiece frame for a work offset: tool tip with linear axes at the offset. */
  const wOf = (m: ProgramMove): V3 => {
    const o = m.xf.offset
    const key = `${o.x},${o.y},${o.z}`
    let w = workOrigin.get(key)
    if (!w) { w = S().tipRel([o.x, o.y, o.z, 0, 0, 0], 0); workOrigin.set(key, w) }
    return w
  }

  let actual = toArr(toMachine(moves[0].xf, moves[0].start))
  let shift = 0
  let i = 0

  for (let mi = 0; mi < moves.length; mi++) {
    const mv = moves[mi]
    const start = i
    while (i < points.length && points[i].moveIndex === mi) i++
    const end = i
    const startM = actual.slice()
    const set = (p: SimPoint, m: number[]) => { p.mx = m[0]; p.my = m[1]; p.mz = m[2]; p.ma = m[3]; p.mb = m[4]; p.mc = m[5] }

    if (mv.kind === 'swivel' && mv.swivel) {
      // CYCLE800: swivel rotary axes so the tool is normal to the new plane; linear axes hold
      const sol = S().solveOrientation(mv.swivel.toolAxis, startM.slice(3), mv.swivel.dir)
      let rotEnd = startM.slice(3)
      if (!sol || sol.errorDeg > 0.01) {
        diags.push({ line: mv.line, severity: 'error', message: `CYCLE800: this plane orientation is not reachable with the machine's rotary axes${sol ? ` (best ${sol.errorDeg.toFixed(3)}° off)` : ''}` })
      } else rotEnd = sol.rot
      let minutes = 0
      for (let k = 0; k < 3; k++) minutes = Math.max(minutes, Math.abs(rotEnd[k] - startM[3 + k]) / S().rotaryRapid(3 + k))
      const dur = minutes * 60
      for (let j = start; j < end; j++) {
        const f = points[j].frac
        set(points[j], [startM[0], startM[1], startM[2], ...[0, 1, 2].map(k => startM[3 + k] + (rotEnd[k] - startM[3 + k]) * f)])
        points[j].t += shift + dur * f
        points[j].rapid = true
      }
      shift += dur
    } else if (mv.kin === 'traori' || mv.kin === 'swivel') {
      const s = S()
      const w = wOf(mv)
      const R = mv.xf.R, tt = mv.xf.t
      const tipProg = (p: Pos6): V3 => {
        const r = apply3(R, [p.x, p.y, p.z])
        return [r[0] + tt[0] + w[0], r[1] + tt[1] + w[1], r[2] + tt[2] + w[2]]
      }
      // Rotary end state
      const startRot = startM.slice(3)
      let rotEnd = startRot.slice()
      if (mv.kin === 'traori') {
        if (mv.orient) {
          const sol = s.solveOrientation(apply3(R, mv.orient), startRot, 0)
          if (!sol || sol.errorDeg > 0.01) diags.push({ line: mv.line, severity: 'error', message: 'TRAORI: orientation A3/B3/C3 is not reachable with the rotary axes' })
          else rotEnd = sol.rot
        } else {
          const mEnd = toArr(toMachine(mv.xf, mv.end))
          for (let k = 0; k < 3; k++) if (mv.programmed.includes(LETTERS[3 + k])) rotEnd[k] = mEnd[3 + k]
        }
      }
      // Continuity: start from the actual tool tip, blend the difference out over the move
      const tip0 = s.tipRel(startM, mv.xf.toolLength)
      const prog0 = tipProg(mv.start)
      const dTip: V3 = [tip0[0] - prog0[0], tip0[1] - prog0[1], tip0[2] - prog0[2]]
      for (let j = start; j < end; j++) {
        const p = points[j]
        const f = p.frac
        const rot = [0, 1, 2].map(k => startRot[k] + (rotEnd[k] - startRot[k]) * f)
        const tp = tipProg(p)
        const target: V3 = [tp[0] + (1 - f) * dTip[0], tp[1] + (1 - f) * dTip[1], tp[2] + (1 - f) * dTip[2]]
        const lin = s.solveLinear(rot, mv.xf.toolLength, target)
        if (!lin) {
          once('singular', { line: mv.line, severity: 'error', message: 'Kinematics: linear axes cannot reach the point at this rotary position (singular)' })
          set(p, [startM[0], startM[1], startM[2], ...rot])
        } else set(p, [...lin, ...rot])
        p.t += shift
      }
    } else if (mv.kind === 'dwell') {
      for (let j = start; j < end; j++) { set(points[j], startM); points[j].t += shift }
    } else {
      // No transformation: MachineMapper values, made continuous with the actual position
      const ideal0 = toArr(toMachine(mv.xf, mv.start))
      const delta = ideal0.map((v, k) => startM[k] - v)
      const disc = delta.some(d => Math.abs(d) > 1e-6)
      if (disc) {
        const isArc = mv.kind === 'arc'
        for (let j = start; j < end; j++) {
          const p = points[j]
          const f = p.frac
          const q = [p.mx, p.my, p.mz, p.ma, p.mb, p.mc]
          set(p, q.map((v, k) => {
            const programmed = mv.programmed.includes(LETTERS[k]) || (isArc && k < 3)
            return programmed ? v + (1 - f) * delta[k] : startM[k]
          }))
        }
      }
      if (shift) for (let j = start; j < end; j++) points[j].t += shift
    }

    if (end > start) {
      const p = points[end - 1]
      actual = [p.mx, p.my, p.mz, p.ma, p.mb, p.mc]
    }
  }
  return diags
}

// ─── small math ──────────────────────────────────────────────────────────────

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, k] = m
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  const inv = 1 / det
  return [
    A * inv, -(b * k - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * k - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
  ]
}
function dot(a: number[], b: number[]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function normalize(v: V3): V3 { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n] }
function angleBetween(a: V3, b: V3): number {
  const c = Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))
  return Math.acos(c) / DEG
}
function angleOfResidual(r: V3): number { return 2 * Math.asin(Math.min(1, Math.hypot(r[0], r[1], r[2]) / 2)) / DEG }
function sameAngle(a: number, b: number): boolean {
  const d = ((a - b) % 360 + 540) % 360 - 180
  return Math.abs(d) < 0.01
}

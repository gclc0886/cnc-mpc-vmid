import type { KinematicChain, KinematicConfig } from './KinematicChain'
import type { SimPoint } from './GCodeParser'

/**
 * Which physical axis receives each programmed coordinate.
 * linear[0..2] ← G-code X/Y/Z, rotary[0..2] ← G-code A/B/C. null = not driven.
 */
export interface AxisMapping {
  linear: (string | null)[]
  rotary: (string | null)[]
  /** 'combination' when taken from a sub-machine axis order, 'names' for the X→X fallback. */
  source: 'combination' | 'names'
}

const LIN = ['X', 'Y', 'Z'] as const
const ROT = ['A', 'B', 'C'] as const

/**
 * Resolve the active sub-machine's axis order (axis IDs) to axis names once,
 * so per-step playback does no lookups. Falls back to direct name mapping
 * (G-code X → axis named X, …) when there is no matching combination.
 */
export function buildAxisMapping(
  config: KinematicConfig,
  chain: KinematicChain,
  combinationId: number | null,
): AxisMapping {
  const combo = config.combinations?.find(c => c.id === combinationId)
  if (combo) {
    const resolve = (ids: number[]) =>
      [0, 1, 2].map(i => (i < ids.length ? chain.axisNameById(ids[i]) ?? null : null))
    return {
      // Linear: L1/L2/L3 → X/Y/Z by position (names like XA, ZB stay positional)
      linear: resolve(combo.axesOrder.linear),
      rotary: assignRotaryLetters(chain, combo.axesOrder.rotary),
      source: 'combination',
    }
  }
  const byName = (names: readonly string[]) => names.map(n => (chain.nodes.has(n) ? n : null))
  return { linear: byName(LIN), rotary: byName(ROT), source: 'names' }
}

/**
 * Which program letter (A/B/C) drives each rotary axis of a sub-machine.
 * The combination only orders the rotary axes (R1, R2, R3); the letter in the program
 * comes from the postprocessor. Rule, in order:
 *   1. first letter of the physical axis name (A, C1, C-1, B …),
 *   2. rotation vector (about X → A, Y → B, Z → C, dominant component),
 *   3. remaining free letters by position.
 * So a trunnion with A and C gets A→A, C→C (not B→C), a lathe C1 gets C.
 */
function assignRotaryLetters(chain: KinematicChain, ids: number[]): (string | null)[] {
  const out: (string | null)[] = [null, null, null]
  const axes = ids.map(id => chain.nodesById.get(id)?.axis).filter((a): a is NonNullable<typeof a> => !!a)
  const pending: typeof axes = []
  for (const a of axes) {
    const k = 'ABC'.indexOf(a.name.charAt(0).toUpperCase())
    if (k >= 0 && out[k] === null) out[k] = a.name
    else pending.push(a)
  }
  const rest: typeof axes = []
  for (const a of pending) {
    const v = [Math.abs(a.vector.x), Math.abs(a.vector.y), Math.abs(a.vector.z)]
    const k = v.indexOf(Math.max(...v))
    if (out[k] === null) out[k] = a.name
    else rest.push(a)
  }
  for (const a of rest) {
    const k = out.indexOf(null)
    if (k >= 0) out[k] = a.name
  }
  return out
}

/**
 * Physical axis values for one interpolated point under the given mapping.
 * Uses the machine values (after frames, work offset and tool length), not the program values.
 */
export function mapPointToAxes(pt: SimPoint, mapping: AxisMapping): Record<string, number> {
  const out: Record<string, number> = {}
  const lin = [pt.mx, pt.my, pt.mz]
  const rot = [pt.ma, pt.mb, pt.mc]
  for (let i = 0; i < 3; i++) {
    const l = mapping.linear[i]
    if (l) out[l] = lin[i]
    const r = mapping.rotary[i]
    if (r) out[r] = rot[i]
  }
  return out
}

/** Human-readable mapping, e.g. { X: "X", Y: "Y", Z: "Z", A: "A" }. */
export function describeMapping(mapping: AxisMapping): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  LIN.forEach((g, i) => { out[g] = mapping.linear[i] ?? null })
  ROT.forEach((g, i) => { out[g] = mapping.rotary[i] ?? null })
  return out
}

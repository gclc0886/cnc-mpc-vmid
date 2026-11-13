import { KinematicChain, checkAxisLimit } from './KinematicChain'
import type { KinematicConfig } from './KinematicChain'
import { mapPointToAxes } from './AxisMapping'
import type { AxisMapping } from './AxisMapping'
import type { SimPoint } from './GCodeParser'

/** One axis that leaves its travel range somewhere in the program. */
export interface LimitSummary {
  axis: string
  min: number
  max: number
  /** Value furthest outside the range. */
  worst: number
  /** First sample out of range. */
  firstStep: number
  /** Number of samples out of range. */
  count: number
}

/**
 * The tool path as the machine actually executes it, from forward kinematics
 * of every sample (programmed coordinates → physical axes → matrices).
 */
export interface PathKinematics {
  /** Tool tip in the workpiece (table leaf) frame, xyz per sample. What gets cut on the part. */
  tcpWork: Float32Array
  /** Tool tip in machine/world coordinates, xyz per sample. */
  tcpWorld: Float32Array
  /** 1 where at least one mapped axis is outside its limits. */
  limitFlags: Uint8Array
  limits: LimitSummary[]
}

/**
 * Runs forward kinematics over all samples on a private chain, so the live
 * machine state is not disturbed. Cost is linear in samples (a few µs each).
 */
export function computePathKinematics(
  config: KinematicConfig,
  mapping: AxisMapping,
  points: SimPoint[],
): PathKinematics {
  const n = points.length
  const tcpWork = new Float32Array(n * 3)
  const tcpWorld = new Float32Array(n * 3)
  const limitFlags = new Uint8Array(n)
  const byAxis = new Map<string, LimitSummary>()

  const chain = new KinematicChain(config)
  chain.updateMatrices()
  const tool = chain.getDeviceLeafNode('spindle')
  const table = chain.getDeviceLeafNode('table')

  for (let i = 0; i < n; i++) {
    const values = mapPointToAxes(points[i], mapping)
    chain.setAxisValues(values, false)
    for (const name in values) {
      const node = chain.nodes.get(name)
      const v = node && checkAxisLimit(node.axis, values[name])
      if (!v) continue
      limitFlags[i] = 1
      const s = byAxis.get(name)
      if (!s) byAxis.set(name, { axis: name, min: v.min, max: v.max, worst: v.value, firstStep: i, count: 1 })
      else {
        s.count++
        const out = (x: number) => Math.max(s.min - x, x - s.max)
        if (out(v.value) > out(s.worst)) s.worst = v.value
      }
    }
    if (tool) {
      const w = tool.worldMatrix.data
      tcpWorld[i * 3] = w[3]; tcpWorld[i * 3 + 1] = w[7]; tcpWorld[i * 3 + 2] = w[11]
      if (table) {
        const p = table.worldMatrix.inverse().transformPoint(w[3], w[7], w[11])
        tcpWork[i * 3] = p[0]; tcpWork[i * 3 + 1] = p[1]; tcpWork[i * 3 + 2] = p[2]
      } else {
        tcpWork[i * 3] = w[3]; tcpWork[i * 3 + 1] = w[7]; tcpWork[i * 3 + 2] = w[11]
      }
    }
  }

  return { tcpWork, tcpWorld, limitFlags, limits: [...byAxis.values()].sort((a, b) => a.firstStep - b.firstStep) }
}

/**
 * Index of the sample at program time `t` (first sample whose time ≥ t).
 * Samples are in non-decreasing time order.
 */
export function stepAtTime(points: SimPoint[], t: number): number {
  const n = points.length
  if (n === 0) return 0
  if (t <= points[0].t) return 0
  if (t >= points[n - 1].t) return n - 1
  let lo = 0, hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First sample of the next (dir=1) or previous (dir=-1) block relative to `step`. */
export function stepOfAdjacentBlock(points: SimPoint[], step: number, dir: 1 | -1): number {
  const n = points.length
  if (n === 0) return 0
  const cur = points[Math.min(Math.max(step, 0), n - 1)].blockIndex
  if (dir === 1) {
    let i = step
    while (i < n && points[i].blockIndex === cur) i++
    return Math.min(i, n - 1)
  }
  // Back: to the start of the current block, or of the previous one if already there
  let i = step
  while (i > 0 && points[i - 1].blockIndex === cur) i--
  if (i < step) return i
  if (i === 0) return 0
  const prev = points[i - 1].blockIndex
  i--
  while (i > 0 && points[i - 1].blockIndex === prev) i--
  return i
}

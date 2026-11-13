import { Matrix4x4 } from './Matrix4x4'
import type { KinematicChain, KinematicNode } from './KinematicChain'

type V3 = { x: number; y: number; z: number }

/** One node of a kinematic chain, explained: what it contributes and where it puts the frame. */
export interface ChainStep {
  name: string
  type: 'linear' | 'rotary' | 'static'
  value: number
  unit: string
  vector: V3
  /** Human-readable local transform, e.g. "T(0, 0, −50) · T((−1, 0, 0) · 25.924)". */
  formula: string
  local: Matrix4x4
  world: Matrix4x4
  /** World rotation of this frame as angle (deg) about a unit axis; angle 0 → no rotation. */
  rotation: { angle: number; axis: V3 }
}

export interface DeviceExplain {
  id: number
  name: string
  type: string
  steps: ChainStep[]
}

export interface ChainExplanation {
  devices: DeviceExplain[]
  tool: { length: number; axis: V3; tip: Matrix4x4 } | null
  /** Inv(table leaf) × tool tip — the tool tip seen from the workpiece. */
  relative: Matrix4x4 | null
}

const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000
  return (Object.is(r, -0) ? 0 : r).toString().replace('-', '−')
}
const vec = (v: V3) => `(${n(v.x)}, ${n(v.y)}, ${n(v.z)})`
const isZero = (v?: V3) => !v || (Math.abs(v.x) < 1e-12 && Math.abs(v.y) < 1e-12 && Math.abs(v.z) < 1e-12)

/** Rotation part of a matrix as angle/axis (degrees). */
export function rotationOf(m: Matrix4x4): { angle: number; axis: V3 } {
  const d = m.data
  const tr = d[0] + d[5] + d[10]
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2))
  const angle = Math.acos(c) * 180 / Math.PI
  if (angle < 1e-6) return { angle: 0, axis: { x: 0, y: 0, z: 1 } }
  let ax = { x: d[9] - d[6], y: d[2] - d[8], z: d[4] - d[1] }
  let len = Math.hypot(ax.x, ax.y, ax.z)
  if (len < 1e-9) {
    // 180°: axis from the diagonal
    const x = Math.sqrt(Math.max(0, (d[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (d[5] + 1) / 2)), z = Math.sqrt(Math.max(0, (d[10] + 1) / 2))
    ax = { x, y: d[1] >= 0 ? y : -y, z: d[2] >= 0 ? z : -z }
    len = Math.hypot(ax.x, ax.y, ax.z) || 1
  }
  return { angle, axis: { x: ax.x / len, y: ax.y / len, z: ax.z / len } }
}

/** The formula of a node's local transform (offset · motion). */
export function nodeFormula(node: KinematicNode): string {
  const a = node.axis
  const parts: string[] = []
  if (!isZero(a.offset)) parts.push(`T${vec(a.offset!)}`)
  if (a.type === 'linear') parts.push(`T(${vec(a.vector)} · ${n(node.currentValue)})`)
  else if (a.type === 'rotary') {
    const r = `R(${vec(a.vector)}, ${n(node.currentValue)}°)`
    parts.push(isZero(a.center) ? r : `T${vec(a.center!)} · ${r} · T${vec({ x: -a.center!.x, y: -a.center!.y, z: -a.center!.z })}`)
  }
  return parts.length ? parts.join(' · ') : 'I'
}

/** Path from a device's first root to the leaf the chain uses (last child at every level). */
function leafPath(root: KinematicNode): KinematicNode[] {
  const path = [root]
  let cur = root
  while (cur.children.length > 0) {
    cur = cur.children[cur.children.length - 1]
    path.push(cur)
  }
  return path
}

export function explainChain(chain: KinematicChain): ChainExplanation {
  const devices: DeviceExplain[] = []
  for (const dev of chain.config.devices) {
    const roots = chain.deviceNodes.get(dev.id)
    if (!roots?.length) continue
    devices.push({
      id: dev.id, name: dev.name, type: dev.type,
      steps: leafPath(roots[0]).map(node => ({
        name: node.axis.name,
        type: node.axis.type,
        value: node.currentValue,
        unit: node.axis.type === 'rotary' ? '°' : node.axis.type === 'linear' ? 'mm' : '',
        vector: node.axis.vector,
        formula: nodeFormula(node),
        local: node.localMatrix,
        world: node.worldMatrix,
        rotation: rotationOf(node.worldMatrix),
      })),
    })
  }
  const hasSpindle = chain.getDeviceLeafNode('spindle') !== null
  const hasTable = chain.getDeviceLeafNode('table') !== null
  return {
    devices,
    tool: hasSpindle ? { length: chain.toolLength, axis: chain.toolAxis, tip: chain.getToolTipMatrix() } : null,
    relative: hasSpindle && hasTable ? chain.getRelativeMatrix() : null,
  }
}

/** Product of the local matrices along a path — equals the leaf's world matrix. */
export function composeLocals(steps: ChainStep[]): Matrix4x4 {
  return steps.reduce((acc, s) => acc.multiply(s.local), Matrix4x4.identity())
}

import { Matrix4x4 } from './Matrix4x4'

/** Axis definition loaded from VMID or presets. */
export interface AxisDef {
  name: string
  id: number
  type: 'linear' | 'rotary' | 'static'
  vector: { x: number; y: number; z: number }
  center?: { x: number; y: number; z: number }
  offset?: { x: number; y: number; z: number }
  homeRef: number
  limits: { min: number; max: number }
  children?: AxisDef[]
}

/** A single kinematic node (axis) in the chain. */
export interface KinematicNode {
  axis: AxisDef
  currentValue: number       // mm for linear, degrees for rotary
  localMatrix: Matrix4x4     // This axis's transformation
  worldMatrix: Matrix4x4     // Accumulated from root
  children: KinematicNode[]
}

/** Device from VMID. */
export interface DeviceDef {
  id: number
  name: string
  type: string
  maxSpin: number
  axes: AxisDef[]
  coordSys?: {
    vecX: { x: number; y: number; z: number }
    vecY: { x: number; y: number; z: number }
    vecZ: { x: number; y: number; z: number }
    place: { x: number; y: number; z: number }
  }
}

/** Combination of turret + table with axis mapping. */
export interface CombinationDef {
  id: number
  name: string
  turretId: number
  tableId: number
  axesOrder: { linear: number[]; rotary: number[] }
}

/** Channel definition — independent axis group. */
export interface ChannelDef {
  id: number
  name: string
  submachineIds: number[]   // References to Combination IDs
  numLinearAxes: number
  numRotaryAxes: number
}

/** Access pattern — axis exchange mode between channels. */
export interface AccessPatternDef {
  id: number
  name: string
  /** Per-axis permission: axis ID → 'normal' | 'forbidden' | 'exchange' */
  axisPermissions: Record<number, string>
}

/** Full kinematic config from VMID JSON export. */
export interface KinematicConfig {
  name: string
  type: string
  kinematic: string
  axisCount: number
  linearAxes: string[]
  rotaryAxes: string[]
  devices: DeviceDef[]
  combinations: CombinationDef[]
  channels: ChannelDef[]
  accessPatterns: AccessPatternDef[]
  postprocessor: string
}

/** Machine category for visualization. */
export type MachineCategory = 'mill_3x' | 'mill_4x' | 'mill_5x' | 'mill_5x_headhead' | 'turn_mill'

/** An axis value outside its configured travel limits. */
export interface LimitViolation {
  axis: string
  value: number
  min: number
  max: number
}

/** Limits beyond this magnitude are VMID placeholders for "unlimited". */
const UNLIMITED = 1e8

/** True when the axis has real (non-placeholder) limits. */
export function hasRealLimits(axis: AxisDef): boolean {
  const { min, max } = axis.limits
  return Math.abs(min) < UNLIMITED && Math.abs(max) < UNLIMITED && min < max
}

/** Returns a violation if `value` is outside the axis limits (static axes never violate). */
export function checkAxisLimit(axis: AxisDef, value: number, eps = 1e-6): LimitViolation | null {
  if (axis.type === 'static' || !hasRealLimits(axis)) return null
  const { min, max } = axis.limits
  if (value < min - eps || value > max + eps) return { axis: axis.name, value, min, max }
  return null
}

/**
 * Kinematic chain engine.
 * Manages axis tree, forward kinematics, matrix computation.
 */
export class KinematicChain {
  config: KinematicConfig
  nodes: Map<string, KinematicNode> = new Map()
  /** Same nodes keyed by VMID axis ID (combinations reference axes by ID). */
  nodesById: Map<number, KinematicNode> = new Map()
  deviceNodes: Map<number, KinematicNode[]> = new Map()

  /** Determine machine category from config for visualization. */
  get machineCategory(): MachineCategory {
    if (this.config.type === 'turn_mill') return 'turn_mill'
    if (this.config.rotaryAxes.length >= 2) {
      // Head-head: rotary axes on spindle device
      const spindleDev = this.config.devices.find(d => d.type === 'spindle')
      if (spindleDev && this._deviceHasRotary(spindleDev.axes)) {
        return 'mill_5x_headhead'
      }
      return 'mill_5x'
    }
    if (this.config.rotaryAxes.length === 1) return 'mill_4x'
    return 'mill_3x'
  }

  private _deviceHasRotary(axes: AxisDef[]): boolean {
    for (const a of axes) {
      if (a.type === 'rotary') return true
      if (a.children && this._deviceHasRotary(a.children)) return true
    }
    return false
  }

  constructor(config: KinematicConfig) {
    this.config = config
    this._buildNodes()
  }

  private _buildNodes() {
    for (const dev of this.config.devices) {
      const deviceNodes: KinematicNode[] = []
      for (const axisDef of dev.axes) {
        const node = this._buildAxisNode(axisDef)
        deviceNodes.push(node)
      }
      this.deviceNodes.set(dev.id, deviceNodes)
    }
  }

  private _buildAxisNode(axisDef: AxisDef): KinematicNode {
    const node: KinematicNode = {
      axis: axisDef,
      currentValue: axisDef.homeRef ?? 0,
      localMatrix: Matrix4x4.identity(),
      worldMatrix: Matrix4x4.identity(),
      children: [],
    }
    this.nodes.set(axisDef.name, node)
    this.nodesById.set(axisDef.id, node)

    if (axisDef.children) {
      for (const child of axisDef.children) {
        node.children.push(this._buildAxisNode(child))
      }
    }
    return node
  }

  /**
   * Set one axis value (mm or degrees) and recompute matrices.
   * `clamp` (default true, for manual jogging) keeps the value inside limits.
   * Simulation passes clamp=false so out-of-limit moves stay visible as violations.
   */
  setAxisValue(axisName: string, value: number, clamp = true): LimitViolation | null {
    const v = this._assign(axisName, value, clamp)
    this.updateMatrices()
    return v
  }

  /**
   * Set several axes and recompute matrices once.
   * Returns the limit violations among the assigned values (only when clamp=false;
   * clamped values never violate).
   */
  setAxisValues(values: Record<string, number>, clamp = true): LimitViolation[] {
    const violations: LimitViolation[] = []
    for (const name in values) {
      const v = this._assign(name, values[name], clamp)
      if (v) violations.push(v)
    }
    this.updateMatrices()
    return violations
  }

  private _assign(axisName: string, value: number, clamp: boolean): LimitViolation | null {
    const node = this.nodes.get(axisName)
    if (!node || !Number.isFinite(value)) return null
    if (clamp && hasRealLimits(node.axis)) {
      const { min, max } = node.axis.limits
      value = Math.max(min, Math.min(max, value))
    }
    node.currentValue = value
    return clamp ? null : checkAxisLimit(node.axis, value)
  }

  /** All axes currently outside their limits. */
  getLimitViolations(): LimitViolation[] {
    const out: LimitViolation[] = []
    for (const node of this.nodes.values()) {
      const v = checkAxisLimit(node.axis, node.currentValue)
      if (v) out.push(v)
    }
    return out
  }

  /** Axis name for a VMID axis ID, or undefined. */
  axisNameById(id: number): string | undefined {
    return this.nodesById.get(id)?.axis.name
  }

  /** Get current axis value. */
  getAxisValue(axisName: string): number {
    return this.nodes.get(axisName)?.currentValue ?? 0
  }

  /** Compute transformation matrix for a single axis node. */
  private _computeLocalMatrix(node: KinematicNode): Matrix4x4 {
    const { axis, currentValue } = node
    const v = axis.vector ?? { x: 0, y: 0, z: 1 }
    const off = axis.offset

    // Offset translation (physical mounting displacement from parent)
    let offsetMatrix = Matrix4x4.identity()
    if (off && (off.x !== 0 || off.y !== 0 || off.z !== 0)) {
      offsetMatrix = Matrix4x4.translation(off.x, off.y, off.z)
    }

    // Static nodes contribute only offset
    if (axis.type === 'static') {
      return offsetMatrix
    }

    if (axis.type === 'linear') {
      const motion = Matrix4x4.translation(
        v.x * currentValue,
        v.y * currentValue,
        v.z * currentValue,
      )
      return offsetMatrix.multiply(motion)
    }

    // Rotary: rotate around vector through center
    const cx = axis.center?.x ?? 0
    const cy = axis.center?.y ?? 0
    const cz = axis.center?.z ?? 0

    let rotation: Matrix4x4
    if (cx !== 0 || cy !== 0 || cz !== 0) {
      const toCenter = Matrix4x4.translation(-cx, -cy, -cz)
      const rotate = Matrix4x4.rotationAxis(v.x, v.y, v.z, currentValue)
      const fromCenter = Matrix4x4.translation(cx, cy, cz)
      rotation = fromCenter.multiply(rotate).multiply(toCenter)
    } else {
      rotation = Matrix4x4.rotationAxis(v.x, v.y, v.z, currentValue)
    }

    return offsetMatrix.multiply(rotation)
  }

  /** Recompute all world matrices (forward kinematics). */
  updateMatrices() {
    for (const [, deviceNodes] of this.deviceNodes) {
      for (const root of deviceNodes) {
        this._updateNodeRecursive(root, Matrix4x4.identity())
      }
    }
  }

  private _updateNodeRecursive(node: KinematicNode, parentWorld: Matrix4x4) {
    node.localMatrix = this._computeLocalMatrix(node)
    node.worldMatrix = parentWorld.multiply(node.localMatrix)

    for (const child of node.children) {
      this._updateNodeRecursive(child, node.worldMatrix)
    }
  }

  /** Get the deepest (leaf) node for a given device type. */
  getDeviceLeafNode(deviceType: string): KinematicNode | null {
    const dev = this.config.devices.find(d => d.type === deviceType)
    if (!dev) return null
    const deviceNodes = this.deviceNodes.get(dev.id)
    if (!deviceNodes?.length) return null

    let deepest = deviceNodes[0]
    const findDeepest = (node: KinematicNode) => {
      deepest = node
      for (const child of node.children) {
        findDeepest(child)
      }
    }
    findDeepest(deviceNodes[0])
    return deepest
  }

  /** Get tool tip position in world coordinates (forward kinematics result). */
  getToolTipPosition(): [number, number, number] {
    const leaf = this.getDeviceLeafNode('spindle')
    if (!leaf) return [0, 0, 0]
    return leaf.worldMatrix.getTranslation()
  }

  /** Compute relative matrix: Inverse(Workpiece) × Tool */
  getRelativeMatrix(): Matrix4x4 {
    const toolLeaf = this.getDeviceLeafNode('spindle')
    const workpieceLeaf = this.getDeviceLeafNode('table')
    if (!toolLeaf || !workpieceLeaf) return Matrix4x4.identity()
    return workpieceLeaf.worldMatrix.inverse().multiply(toolLeaf.worldMatrix)
  }

  /** Get all axis positions as dict. */
  getAllPositions(): Record<string, number> {
    const positions: Record<string, number> = {}
    for (const [name, node] of this.nodes) {
      positions[name] = node.currentValue
    }
    return positions
  }

  /** Get all matrices for UI display. */
  getAllMatrices(): { name: string; matrix: Matrix4x4 }[] {
    const result: { name: string; matrix: Matrix4x4 }[] = []
    for (const [name, node] of this.nodes) {
      result.push({ name, matrix: node.worldMatrix })
    }
    return result
  }

  /** Get the composed matrix (product of all axis matrices). */
  getComposedMatrix(): Matrix4x4 {
    let result = Matrix4x4.identity()
    // Multiply all root-level nodes together
    for (const [, deviceNodes] of this.deviceNodes) {
      for (const root of deviceNodes) {
        const leaf = this._getLeafMatrix(root)
        result = result.multiply(leaf)
      }
    }
    return result
  }

  private _getLeafMatrix(node: KinematicNode): Matrix4x4 {
    if (node.children.length === 0) return node.worldMatrix
    return this._getLeafMatrix(node.children[node.children.length - 1])
  }
}

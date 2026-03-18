import React, { useRef, useMemo, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { KinematicChain, KinematicNode, MachineCategory } from '../engine/KinematicChain'

interface Props {
  chain: KinematicChain
}

// ═══════════════════════════════════════════════════════════════
//  COLORS — bold, saturated like the Gemini reference
// ═══════════════════════════════════════════════════════════════

const SPINDLE_BLUE = '#2196f3'
const TOOL_YELLOW = '#ffc107'
const WORKPIECE_GREEN = '#4caf50'
const ROTARY_DISC = '#26a69a'
const ROTARY_RING = '#ffc107'

// ═══════════════════════════════════════════════════════════════
//  ENGINE — matrix updater + node group
// ═══════════════════════════════════════════════════════════════

function MatrixUpdater({ chain }: { chain: KinematicChain }) {
  useFrame(() => {
    try { chain.updateMatrices() } catch { /* guard rebuild race */ }
  }, -1)
  return null
}

function AxisNodeGroup({ node, children }: { node: KinematicNode; children?: ReactNode }) {
  const ref = useRef<THREE.Group>(null!)
  useFrame(() => {
    if (!ref.current) return
    try {
      const arr = node.localMatrix.toThreeArray()
      // Guard against NaN matrices
      if (arr.some((v: number) => !isFinite(v))) return
      const m = new THREE.Matrix4()
      m.fromArray(arr)
      ref.current.matrix.copy(m)
    } catch { /* axis may have been removed/rebuilt */ }
  })
  return <group ref={ref} matrixAutoUpdate={false}>{children}</group>
}

// ═══════════════════════════════════════════════════════════════
//  SPINDLE HOUSING — wide blue cylinder above origin
//  Origin = bottom face of housing (where tool attaches)
// ═══════════════════════════════════════════════════════════════

/** Compute rotation to align -Z with the given tool approach vector */
function toolApproachRotation(vec: { x: number; y: number; z: number }): THREE.Euler {
  // Default tool geometry points along -Z. We need to rotate it to point along -vec.
  const target = new THREE.Vector3(-vec.x, -vec.y, -vec.z).normalize()
  const defaultDir = new THREE.Vector3(0, 0, -1)
  const q = new THREE.Quaternion().setFromUnitVectors(defaultDir, target)
  return new THREE.Euler().setFromQuaternion(q)
}

// ═══════════════════════════════════════════════════════════════
//  SPINDLE + TOOL — combined so they always rotate together
//  Origin = TCP (tool tip, Z=0). Both shaft and housing go UP.
// ═══════════════════════════════════════════════════════════════

function SpindleWithTool({ approachVec }: { approachVec: { x: number; y: number; z: number } }) {
  const shaftLen = 100
  const euler = toolApproachRotation(approachVec)

  return (
    <group rotation={euler}>
      {/* TCP axes at origin (tool tip = Z=0) */}
      <axesHelper args={[60]} />
      {/* Tool shaft goes UP from TCP */}
      <mesh position={[0, 0, shaftLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[8, 8, shaftLen, 16]} />
        <meshStandardMaterial color={TOOL_YELLOW} metalness={0.6} roughness={0.2} />
      </mesh>
      {/* Spindle housing above the tool shaft */}
      <mesh position={[0, 0, shaftLen + 50]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[50, 55, 100, 32]} />
        <meshStandardMaterial color={SPINDLE_BLUE} metalness={0.4} roughness={0.4} />
      </mesh>
    </group>
  )
}

// ═══════════════════════════════════════════════════════════════
//  ROTARY AXIS — semi-transparent protractor disc with degree ticks
//  Auto-scales to stay readable at any zoom level
// ═══════════════════════════════════════════════════════════════

function createProtractorTexture(): THREE.CanvasTexture {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2, cy = size / 2
  const r = size * 0.38  // main circle radius, leaving room for labels outside

  // Transparent background
  ctx.clearRect(0, 0, size, size)

  // Outer ring
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.6)'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  // Semi-transparent fill
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  grad.addColorStop(0, 'rgba(79, 195, 247, 0.03)')
  grad.addColorStop(0.7, 'rgba(79, 195, 247, 0.06)')
  grad.addColorStop(1, 'rgba(79, 195, 247, 0.12)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  // Degree ticks & labels
  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg - 90) * Math.PI / 180
    const isMajor = deg % 30 === 0
    const isMid = deg % 10 === 0
    const tickLen = isMajor ? 24 : isMid ? 14 : 7
    const x1 = cx + (r - tickLen) * Math.cos(rad)
    const y1 = cy + (r - tickLen) * Math.sin(rad)
    const x2 = cx + r * Math.cos(rad)
    const y2 = cy + r * Math.sin(rad)

    ctx.strokeStyle = isMajor ? 'rgba(79, 195, 247, 0.85)' : 'rgba(79, 195, 247, 0.35)'
    ctx.lineWidth = isMajor ? 2.5 : 1
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    // Labels: outside the circle, rotated radially
    if (isMajor) {
      const lr = r + 50  // outside the ring
      const lx = cx + lr * Math.cos(rad)
      const ly = cy + lr * Math.sin(rad)

      ctx.save()
      ctx.translate(lx, ly)
      // Rotate so text reads radially outward
      // Add PI/2 because 0deg is at top (-90deg in canvas coords)
      let textAngle = rad + Math.PI / 2
      // Flip text on the bottom half so it's not upside down
      if (deg > 90 && deg < 270) textAngle += Math.PI
      ctx.rotate(textAngle)

      ctx.fillStyle = 'rgba(79, 195, 247, 1.0)'
      ctx.font = 'bold 50px Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${deg}\u00b0`, 0, 0)
      ctx.restore()
    }
  }

  // Center crosshair
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.3)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy)
  ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14)
  ctx.stroke()

  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

const BASE_RADIUS = 80 // base radius at reference distance
const REF_DISTANCE = 500 // camera distance where scale = 1

function RotaryDisc({ vector }: { vector: { x: number; y: number; z: number } }) {
  const groupRef = useRef<THREE.Group>(null!)
  const { camera } = useThree()
  const texture = useMemo(() => createProtractorTexture(), [])

  const vx = Math.abs(vector.x), vy = Math.abs(vector.y), vz = Math.abs(vector.z)

  // Orient disc perpendicular to rotation axis (in CNC coords mapped to Three.js)
  let rotation: [number, number, number] = [0, 0, 0]  // Z-axis: disc lies flat in XY
  if (vx > 0.5) rotation = [0, Math.PI / 2, 0]  // A-axis
  if (vy > 0.5) rotation = [Math.PI / 2, 0, 0]  // B-axis

  // Auto-scale based on camera distance
  useFrame(() => {
    if (!groupRef.current) return
    const worldPos = new THREE.Vector3()
    groupRef.current.getWorldPosition(worldPos)
    const dist = camera.position.distanceTo(worldPos)
    const s = dist / REF_DISTANCE
    groupRef.current.scale.setScalar(s)
  })

  return (
    <group ref={groupRef} rotation={rotation}>
      <mesh>
        <planeGeometry args={[BASE_RADIUS * 2, BASE_RADIUS * 2]} />
        <meshBasicMaterial
          map={texture}
          transparent
          opacity={0.9}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

// ═══════════════════════════════════════════════════════════════
//  WORKPIECE shapes — origin on TOP / END FACE (CNC convention)
// ═══════════════════════════════════════════════════════════════

/** 3-axis / 5-axis block — WCS on top face */
function WorkpieceBlock() {
  const h = 50
  return (
    <mesh position={[0, 0, -h / 2]}>
      <boxGeometry args={[100, 100, h]} />
      <meshStandardMaterial color={WORKPIECE_GREEN} metalness={0.2} roughness={0.6} />
    </mesh>
  )
}

/** 4-axis workpiece — green cylinder horizontal along X, WCS on near face */
function WorkpieceCylinder() {
  const len = 200
  return (
    <mesh rotation={[0, 0, Math.PI / 2]} position={[len / 2, 0, 0]}>
      <cylinderGeometry args={[50, 50, len, 32]} />
      <meshStandardMaterial color={WORKPIECE_GREEN} metalness={0.2} roughness={0.5} />
    </mesh>
  )
}

/** Turn-mill workpiece — green cylinder along Z, WCS on face (Z=0) */
function WorkpieceLatheCylinder() {
  const len = 180
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -len / 2]}>
      <cylinderGeometry args={[45, 45, len, 32]} />
      <meshStandardMaterial color={WORKPIECE_GREEN} metalness={0.2} roughness={0.5} />
    </mesh>
  )
}

// ═══════════════════════════════════════════════════════════════
//  RECURSIVE TREE BUILDER
// ═══════════════════════════════════════════════════════════════

/** Check if a node is the deepest linear axis in its chain (spindle housing goes here) */
function isDeepestLinear(node: KinematicNode): boolean {
  if (node.axis.type !== 'linear') return false
  if (node.children.length === 0) return true
  return node.children.every(c => c.axis.type !== 'linear')
}

/** Find the spindle approach vector — use the LEAF (deepest) linear axis vector */
function findDeepestLinearVector(node: KinematicNode): { x: number; y: number; z: number } {
  let deepestVec = { x: 0, y: 0, z: 1 } // default: Z
  const walk = (n: KinematicNode) => {
    if (n.axis.type === 'linear') {
      deepestVec = n.axis.vector ?? { x: 0, y: 0, z: 1 }
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  return deepestVec
}

function renderNodeTree(
  node: KinematicNode,
  deviceType: string,
  _category: MachineCategory,
  depth: number,
  approachVec: { x: number; y: number; z: number },
): React.JSX.Element {
  const isLeaf = node.children.length === 0
  const axisType = node.axis.type

  return (
    <AxisNodeGroup key={node.axis.name} node={node}>
      {/* Rotary disc indicator */}
      {axisType === 'rotary' && <RotaryDisc vector={node.axis.vector} />}

      {/* Spindle housing + tool at leaf of spindle chain (always together) */}
      {isLeaf && deviceType === 'spindle' && <SpindleWithTool approachVec={approachVec} />}

      {/* Axes at workpiece/table origin */}
      {isLeaf && deviceType === 'table' && <axesHelper args={[60]} />}

      {node.children.map(child => renderNodeTree(child, deviceType, _category, depth + 1, approachVec))}
    </AxisNodeGroup>
  )
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

export function MachineModel({ chain }: Props) {
  const category = chain.machineCategory

  return (
    <group>
      <MatrixUpdater chain={chain} />

      {/* World origin axes */}
      <axesHelper args={[100]} />

      {chain.config.devices.map(dev => {
        try {
          const deviceNodes = chain.deviceNodes.get(dev.id)
          if (!deviceNodes?.length) return null
          // For spindle chain: find the deepest linear axis vector (tool approach direction)
          const approachVec = dev.type === 'spindle' && deviceNodes[0]
            ? findDeepestLinearVector(deviceNodes[0])
            : { x: 0, y: 0, z: 1 }
          return (
            <group key={dev.id}>
              {deviceNodes.map(rootNode => renderNodeTree(rootNode, dev.type, category, 0, approachVec))}
            </group>
          )
        } catch (e) {
          console.error(`[MachineModel] Error rendering device ${dev.id} (${dev.name}):`, e)
          return null
        }
      })}
    </group>
  )
}

import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import type { SimPoint } from '../engine/GCodeParser'

interface Props {
  points: SimPoint[]
  currentStep: number
}

/**
 * Optimized toolpath renderer.
 * Geometry is built once when points change.
 * drawRange is updated cheaply each step via precomputed lookup arrays.
 */
export function ToolPathLine({ points, currentStep }: Props) {
  const rapidRef = useRef<THREE.BufferGeometry>(null!)
  const feedRef = useRef<THREE.BufferGeometry>(null!)

  // Build geometry + precompute step→drawCount lookup
  const { rapidGeom, feedGeom, rapidCountAt, feedCountAt } = useMemo(() => {
    const rapidPts: THREE.Vector3[] = []
    const feedPts: THREE.Vector3[] = []
    // For each step i, how many rapid/feed vertices are visible
    const rCountAt = new Uint32Array(points.length + 1)
    const fCountAt = new Uint32Array(points.length + 1)
    let rCount = 0
    let fCount = 0

    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      const v = new THREE.Vector3(p.x, p.y, p.z)
      if (p.rapid) {
        rapidPts.push(v)
        rCount++
      } else {
        feedPts.push(v)
        fCount++
      }
      rCountAt[i + 1] = rCount
      fCountAt[i + 1] = fCount
    }

    return {
      rapidGeom: new THREE.BufferGeometry().setFromPoints(
        rapidPts.length > 0 ? rapidPts : [new THREE.Vector3()]
      ),
      feedGeom: new THREE.BufferGeometry().setFromPoints(
        feedPts.length > 0 ? feedPts : [new THREE.Vector3()]
      ),
      rapidCountAt: rCountAt,
      feedCountAt: fCountAt,
    }
  }, [points])

  // Update drawRange — O(1) lookup, no loops
  useEffect(() => {
    const idx = Math.min(currentStep + 1, points.length)
    if (rapidRef.current) rapidRef.current.setDrawRange(0, rapidCountAt[idx])
    if (feedRef.current) feedRef.current.setDrawRange(0, feedCountAt[idx])
  }, [currentStep, points.length, rapidCountAt, feedCountAt])

  const currentPt = points[currentStep]
  const currentPos = currentPt
    ? new THREE.Vector3(currentPt.x, currentPt.y, currentPt.z)
    : null

  return (
    <group>
      {/* Rapid moves - dashed orange */}
      <line>
        <bufferGeometry ref={rapidRef} attach="geometry" {...rapidGeom} />
        <lineDashedMaterial color="#ff9800" dashSize={5} gapSize={3} linewidth={1} />
      </line>

      {/* Feed moves - solid cyan */}
      <line>
        <bufferGeometry ref={feedRef} attach="geometry" {...feedGeom} />
        <lineBasicMaterial color="#00bcd4" linewidth={2} />
      </line>

      {/* Current position marker */}
      {currentPos && (
        <mesh position={currentPos}>
          <sphereGeometry args={[2, 8, 8]} />
          <meshStandardMaterial
            color="#f44336"
            emissive="#f44336"
            emissiveIntensity={0.8}
          />
        </mesh>
      )}
    </group>
  )
}

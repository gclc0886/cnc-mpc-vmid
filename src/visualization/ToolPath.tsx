import { useMemo } from 'react'
import * as THREE from 'three'
import type { SimPoint } from '../engine/GCodeParser'

interface Props {
  points: SimPoint[]
  currentStep: number
}

export function ToolPathLine({ points, currentStep }: Props) {
  const { rapidGeometry, feedGeometry, currentPos } = useMemo(() => {
    const rapidPts: THREE.Vector3[] = []
    const feedPts: THREE.Vector3[] = []

    const visiblePoints = points.slice(0, currentStep + 1)

    for (const p of visiblePoints) {
      const v = new THREE.Vector3(p.x, p.y, p.z) // Direct CNC coords (wrapper handles transform)
      if (p.rapid) {
        rapidPts.push(v)
      } else {
        feedPts.push(v)
      }
    }

    const rapidGeom = new THREE.BufferGeometry().setFromPoints(rapidPts)
    const feedGeom = new THREE.BufferGeometry().setFromPoints(feedPts)

    const current = visiblePoints.length > 0
      ? visiblePoints[visiblePoints.length - 1]
      : null

    return {
      rapidGeometry: rapidGeom,
      feedGeometry: feedGeom,
      currentPos: current
        ? new THREE.Vector3(current.x, current.y, current.z)
        : null,
    }
  }, [points, currentStep])

  return (
    <group>
      {/* Rapid moves - dashed orange */}
      <line>
        <bufferGeometry attach="geometry" {...rapidGeometry} />
        <lineDashedMaterial color="#ff9800" dashSize={5} gapSize={3} linewidth={1} />
      </line>

      {/* Feed moves - solid cyan */}
      <line>
        <bufferGeometry attach="geometry" {...feedGeometry} />
        <lineBasicMaterial color="#00bcd4" linewidth={2} />
      </line>

      {/* Current position marker */}
      {currentPos && (
        <mesh position={currentPos}>
          <sphereGeometry args={[2, 16, 16]} />
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

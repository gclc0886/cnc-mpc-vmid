import { useMemo, useRef, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { KinematicChain } from '../engine/KinematicChain'
import { useMachineStore } from '../store/useMachineStore'

const RAPID = new THREE.Color('#ff9800')
const FEED = new THREE.Color('#00bcd4')
const LIMIT = new THREE.Color('#ff1744')

/**
 * Tool trace from forward kinematics of the whole program (store.pathKin).
 *
 * 'work' frame: the trace is drawn in the table leaf frame and moves with the table —
 * this is the path the tool cuts on the part (wraps around the cylinder on a 4-axis).
 * 'world' frame: tool tip positions in machine space.
 *
 * The whole program is shown faint; the executed part is bright. Out-of-limit samples
 * are red. Progress, marker and table frame are updated imperatively in useFrame,
 * so playback does not re-render React.
 */
export function ToolPathLine({ chain }: { chain: KinematicChain }) {
  const toolPath = useMachineStore(s => s.toolPath)
  const pathKin = useMachineStore(s => s.pathKin)
  const traceFrame = useMachineStore(s => s.traceFrame)

  const groupRef = useRef<THREE.Group>(null!)
  const markerRef = useRef<THREE.Mesh>(null!)
  const last = useRef({ step: -1, rev: -1, frame: '' })

  const tableLeaf = useMemo(() => chain.getDeviceLeafNode('table'), [chain])

  const scene = useMemo(() => {
    if (!pathKin || toolPath.length === 0) return null
    const src = traceFrame === 'work' ? pathKin.tcpWork : pathKin.tcpWorld
    const n = toolPath.length
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const c = pathKin.limitFlags[i] ? LIMIT : toolPath[i].rapid ? RAPID : FEED
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
    }
    const position = new THREE.BufferAttribute(src, 3)
    const color = new THREE.BufferAttribute(colors, 3)

    const ghostGeom = new THREE.BufferGeometry()
    ghostGeom.setAttribute('position', position)
    ghostGeom.setAttribute('color', color)
    const progressGeom = new THREE.BufferGeometry()
    progressGeom.setAttribute('position', position)
    progressGeom.setAttribute('color', color)
    progressGeom.setDrawRange(0, 0)

    const ghost = new THREE.Line(ghostGeom, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false,
    }))
    const progress = new THREE.Line(progressGeom, new THREE.LineBasicMaterial({ vertexColors: true }))
    // The trace moves with the table; bounding spheres would be stale, so never cull it
    ghost.frustumCulled = false
    progress.frustumCulled = false
    return { src, ghost, progress, progressGeom }
  }, [pathKin, toolPath, traceFrame])

  useEffect(() => {
    last.current = { step: -1, rev: -1, frame: '' }
    return () => {
      if (!scene) return
      for (const l of [scene.ghost, scene.progress]) {
        l.geometry.dispose()
        ;(l.material as THREE.Material).dispose()
      }
    }
  }, [scene])

  useFrame(() => {
    if (!scene || !groupRef.current) return
    const g = groupRef.current

    // Attach to the table leaf (work frame) or to machine space
    const wantWork = traceFrame === 'work' && tableLeaf !== null
    if (chain.revision !== last.current.rev || last.current.frame !== traceFrame) {
      if (wantWork) {
        const d = tableLeaf!.worldMatrix.data
        g.matrix.set(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15])
      } else {
        g.matrix.identity()
      }
      g.matrixWorldNeedsUpdate = true
      last.current.rev = chain.revision
      last.current.frame = traceFrame
    }

    const step = useMachineStore.getState().currentStep
    if (step !== last.current.step) {
      const s = Math.min(Math.max(step, 0), toolPath.length - 1)
      scene.progressGeom.setDrawRange(0, s + 1)
      markerRef.current?.position.set(scene.src[s * 3], scene.src[s * 3 + 1], scene.src[s * 3 + 2])
      last.current.step = step
    }
  })

  if (!scene) return null
  return (
    <group ref={groupRef} matrixAutoUpdate={false}>
      <primitive object={scene.ghost} />
      <primitive object={scene.progress} />
      <mesh ref={markerRef}>
        <sphereGeometry args={[2, 8, 8]} />
        <meshStandardMaterial color="#f44336" emissive="#f44336" emissiveIntensity={0.8} />
      </mesh>
    </group>
  )
}

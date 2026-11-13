import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { KinematicChain, MachineCategory } from '../engine/KinematicChain'
import { useMachineStore } from '../store/useMachineStore'
import type { CameraView } from '../store/useMachineStore'

/** View directions (camera position relative to target) in CNC coordinates. */
const DIRS: Record<Exclude<CameraView, 'fit'>, [number, number, number]> = {
  iso: [1, -1, 1],
  front: [0, -1, 0],
  top: [0, -0.002, 1], // tiny tilt keeps CNC +Y up on screen without flipping the camera
  right: [1, 0, 0],
  left: [-1, 0, 0],
}

/** CNC → Three.js world (the scene wraps CNC space in a group rotated −90° about X for mills). */
function cncToThree(category: MachineCategory | null, v: [number, number, number]): THREE.Vector3 {
  if (category === 'turn_mill') return new THREE.Vector3(v[0], v[1], v[2])
  return new THREE.Vector3(v[0], v[2], -v[1])
}

/**
 * Applies camera view requests from the store (toolbar buttons, MCP set_camera_view).
 * Frames the tool trace in machine space when there is one, else the machine origin.
 * The move is animated over ~0.35 s.
 */
export function CameraController({ chain }: { chain: KinematicChain | null }) {
  const { camera, controls } = useThree() as unknown as {
    camera: THREE.PerspectiveCamera
    controls: { target: THREE.Vector3; update: () => void } | null
  }
  const request = useMachineStore(s => s.cameraRequest)
  const anim = useRef<{ fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTgt: THREE.Vector3; toTgt: THREE.Vector3; t: number } | null>(null)

  useEffect(() => {
    if (!request || !controls) return
    const category = chain?.machineCategory ?? null
    const { pathKin } = useMachineStore.getState()

    // Bounds of the trace in machine space (CNC), or a default box around the origin
    let center: [number, number, number] = [0, 0, 0]
    let radius = 250
    if (pathKin && pathKin.tcpWorld.length >= 3) {
      const a = pathKin.tcpWorld
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = a[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v
      }
      center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
      radius = Math.max(60, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2)
    }
    const target = cncToThree(category, center)
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15

    let dir: THREE.Vector3
    if (request.view === 'fit') dir = camera.position.clone().sub(controls.target).normalize()
    else dir = cncToThree(category, DIRS[request.view]).normalize()

    anim.current = {
      fromPos: camera.position.clone(), toPos: target.clone().add(dir.multiplyScalar(dist)),
      fromTgt: controls.target.clone(), toTgt: target, t: 0,
    }
  }, [request, controls, camera, chain])

  useFrame((_, dt) => {
    const a = anim.current
    if (!a || !controls) return
    a.t = Math.min(1, a.t + dt / 0.35)
    const e = 1 - Math.pow(1 - a.t, 3)
    camera.position.lerpVectors(a.fromPos, a.toPos, e)
    controls.target.lerpVectors(a.fromTgt, a.toTgt, e)
    controls.update()
    if (a.t >= 1) anim.current = null
  })

  return null
}

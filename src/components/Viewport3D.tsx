import React, { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from '@react-three/drei'
import { MachineModel } from '../visualization/MachineModel'
import { ToolPathLine } from '../visualization/ToolPath'
import type { KinematicChain, MachineCategory } from '../engine/KinematicChain'
import type { SimPoint } from '../engine/GCodeParser'

interface Props {
  chain: KinematicChain | null
  toolPath: SimPoint[]
  currentStep: number
}

/**
 * CNC→Three.js coordinate rotation based on machine type.
 *
 * Milling (Z-up):
 *   rotation [-PI/2, 0, 0] transforms:
 *   CNC X → Three.js X  (right)
 *   CNC Y → Three.js -Z (into screen)
 *   CNC Z → Three.js Y  (up)         ← Z is vertical!
 *
 * Turn-mill (Z-horizontal):
 *   No rotation needed — CNC Z stays horizontal (Three.js Z),
 *   CNC Y stays up (Three.js Y).
 */
function getCNCRotation(category: MachineCategory | null): [number, number, number] {
  if (category === 'turn_mill') return [0, 0, 0]
  return [-Math.PI / 2, 0, 0]  // Z-up for all milling types (3x, 4x, 5x, 5x_headhead)
}

class CanvasErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: Error) { return { error: e.message } }
  componentDidCatch(e: Error) { console.error('[Viewport3D] Render error:', e) }
  render() {
    if (this.state.error) {
      return <div style={{ color: '#ff6b6b', padding: 20, fontFamily: 'monospace' }}>
        3D render error: {this.state.error}
        <button onClick={() => this.setState({ error: null })} style={{ marginLeft: 10 }}>Retry</button>
      </div>
    }
    return this.props.children
  }
}

export function Viewport3D({ chain, toolPath, currentStep }: Props) {
  const category = chain?.machineCategory ?? null
  const cncRotation = useMemo(() => getCNCRotation(category), [category])

  return (
    <CanvasErrorBoundary>
    <Canvas
      camera={{ position: [250, 300, 400], fov: 45, near: 0.1, far: 100000 }}
      style={{ background: '#0f0f23' }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[300, 400, 300]} intensity={0.9} castShadow />
      <directionalLight position={[-200, 200, -100]} intensity={0.4} />
      <directionalLight position={[0, -100, 200]} intensity={0.2} />

      {/* CNC coordinate space wrapper — everything inside uses CNC axes */}
      <group rotation={cncRotation}>
        {/* Grid on CNC XY floor plane (rotate from Three.js XZ to XY) */}
        <Grid
          args={[1000, 1000]}
          cellSize={10}
          sectionSize={50}
          cellColor="#1a2a3e"
          sectionColor="#2a3a5e"
          fadeDistance={800}
          infiniteGrid
          rotation={[Math.PI / 2, 0, 0]}
        />

        {chain && <MachineModel chain={chain} />}
        {toolPath.length > 0 && (
          <ToolPathLine points={toolPath} currentStep={currentStep} />
        )}
      </group>

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={10}
        maxDistance={5000}
      />

      <GizmoHelper alignment="bottom-right" margin={[80, 80]} key={category ?? 'default'}>
        {/* Wrap in rotation to convert Three.js axes → CNC axes in gizmo display */}
        {/* For milling: [PI/2,0,0] maps local Y→world -Z (CNC Y+ into screen), local Z→world Y (CNC Z+ up) */}
        <group rotation={category === 'turn_mill' ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}>
          <GizmoViewport
            axisColors={['#ff4444', '#44ff44', '#4444ff']}
            labels={['X', 'Y', 'Z']}
            labelColor="white"
          />
        </group>
      </GizmoHelper>
    </Canvas>
    </CanvasErrorBoundary>
  )
}

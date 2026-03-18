import { useRef, useCallback } from 'react'
import { useMachineStore } from '../store/useMachineStore'

function useRepeatAction() {
  const timer = useRef<number>(0)
  const interval = useRef<number>(0)

  const start = useCallback((action: () => void) => {
    action()
    timer.current = window.setTimeout(() => {
      interval.current = window.setInterval(action, 80)
    }, 400)
  }, [])

  const stop = useCallback(() => {
    clearTimeout(timer.current)
    clearInterval(interval.current)
  }, [])

  return { start, stop }
}

function getAxisDescription(name: string, type: string, vector: { x: number; y: number; z: number }): string {
  if (type === 'rotary') {
    if (Math.abs(vector.x) > 0.5) return 'Rotary table'
    if (Math.abs(vector.y) > 0.5) return 'Tilt axis'
    if (Math.abs(vector.z) > 0.5) return 'Rotary table (C)'
    return 'Rotary'
  }
  if (type === 'static') return 'Static mount'
  if (Math.abs(vector.x) > 0.5) return 'Table left/right'
  if (Math.abs(vector.y) > 0.5) return 'Table forward/back'
  if (Math.abs(vector.z) > 0.5) return 'Spindle up/down'
  return 'Linear'
}

function StepButton({ label, action }: { label: string; action: () => void }) {
  const { start, stop } = useRepeatAction()
  return (
    <button
      className="axis-step-btn"
      onMouseDown={() => start(action)}
      onMouseUp={stop}
      onMouseLeave={stop}
      dangerouslySetInnerHTML={{ __html: label }}
    />
  )
}

export function AxisControls() {
  const { chain, version, setAxisValue, resetAxes } = useMachineStore()
  void version

  if (!chain) return null

  const axes = Array.from(chain.nodes.entries()).filter(
    ([, node]) => node.axis.type !== 'static'
  )

  return (
    <div>
      <div className="panel-header">Machine Axes (Forward Kinematics)</div>
      {axes.map(([name, node]) => {
        const isRotary = node.axis.type === 'rotary'
        const min = Math.abs(node.axis.limits.min) < 1e6 ? node.axis.limits.min : (isRotary ? -360 : -500)
        const max = Math.abs(node.axis.limits.max) < 1e6 ? node.axis.limits.max : (isRotary ? 360 : 500)
        const step = isRotary ? 0.5 : 0.1
        const unit = isRotary ? '\u00b0' : 'mm'
        const color = isRotary ? '#ffb74d' : '#81c784'
        const desc = getAxisDescription(name, node.axis.type, node.axis.vector)

        return (
          <div key={name} className="axis-control">
            <label style={{ color }}>
              {name} <span className="axis-desc">({desc})</span>
            </label>
            <StepButton label="&lsaquo;" action={() => {
              const cur = useMachineStore.getState().chain?.getAxisValue(name) ?? 0
              setAxisValue(name, Math.max(min, cur - 1))
            }} />
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={node.currentValue}
              onChange={(e) => setAxisValue(name, parseFloat(e.target.value))}
            />
            <StepButton label="&rsaquo;" action={() => {
              const cur = useMachineStore.getState().chain?.getAxisValue(name) ?? 0
              setAxisValue(name, Math.min(max, cur + 1))
            }} />
            <span className="value" style={{ color }}>
              {node.currentValue.toFixed(isRotary ? 1 : 2)}{unit}
            </span>
          </div>
        )
      })}
      <button className="reset-btn" onClick={resetAxes}>
        Reset to Zero
      </button>
    </div>
  )
}

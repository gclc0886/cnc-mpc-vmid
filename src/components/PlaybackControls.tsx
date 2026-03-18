import { useEffect, useRef, useCallback } from 'react'
import { useMachineStore } from '../store/useMachineStore'

const SPEED_OPTIONS = [
  { label: '0.5x', value: 1 },
  { label: '1x', value: 2 },
  { label: '2x', value: 5 },
  { label: '5x', value: 10 },
  { label: '10x', value: 20 },
]

export function PlaybackControls() {
  const {
    toolPath, currentStep, isPlaying, playbackSpeed, config,
    setIsPlaying, setPlaybackSpeed, applyStep, parseGcode,
  } = useMachineStore()

  const animRef = useRef<number>(0)
  const stepRef = useRef(currentStep)

  // Keep stepRef in sync when currentStep changes externally
  stepRef.current = currentStep

  const totalSteps = toolPath.length

  // Animation loop
  const animate = useCallback(() => {
    const { playbackSpeed, toolPath } = useMachineStore.getState()
    stepRef.current += playbackSpeed
    if (stepRef.current >= toolPath.length) {
      stepRef.current = toolPath.length - 1
      useMachineStore.getState().applyStep(stepRef.current)
      useMachineStore.getState().setIsPlaying(false)
      return
    }
    useMachineStore.getState().applyStep(stepRef.current)
    animRef.current = requestAnimationFrame(animate)
  }, [])

  useEffect(() => {
    if (isPlaying) {
      animRef.current = requestAnimationFrame(animate)
    }
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [isPlaying, animate])

  const play = () => {
    if (totalSteps === 0) return
    if (currentStep >= totalSteps - 1) {
      // Restart from beginning
      applyStep(0)
      stepRef.current = 0
    }
    setIsPlaying(true)
  }

  const pause = () => setIsPlaying(false)

  const stop = () => {
    setIsPlaying(false)
    applyStep(0)
  }

  const stepForward = () => {
    if (totalSteps === 0) return
    const next = Math.min(currentStep + playbackSpeed, totalSteps - 1)
    applyStep(next)
  }

  const stepBack = () => {
    if (totalSteps === 0) return
    const prev = Math.max(currentStep - playbackSpeed, 0)
    applyStep(prev)
  }

  const jumpForward = () => {
    if (totalSteps === 0) return
    const next = Math.min(currentStep + playbackSpeed * 20, totalSteps - 1)
    applyStep(next)
  }

  const jumpBack = () => {
    if (totalSteps === 0) return
    const prev = Math.max(currentStep - playbackSpeed * 20, 0)
    applyStep(prev)
  }

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const step = parseInt(e.target.value)
    applyStep(step)
  }

  const pct = totalSteps > 0 ? ((currentStep / (totalSteps - 1)) * 100).toFixed(1) : '0'
  const currentPt = toolPath[currentStep]
  const blockLine = currentPt?.blockIndex ?? 0
  const feedRate = currentPt?.feed ?? 0
  const isRapid = currentPt?.rapid ?? false

  return (
    <div className="playback-controls">
      <div className="playback-header">
        <span className="playback-title">PLAYBACK</span>
        <button className="playback-parse-btn" onClick={parseGcode} disabled={isPlaying}>
          Parse G-Code
        </button>
      </div>

      {totalSteps > 0 && (
        <>
          {/* Scrub bar */}
          <div className="playback-scrub">
            <input
              type="range"
              min={0}
              max={Math.max(totalSteps - 1, 0)}
              value={currentStep}
              onChange={onScrub}
              disabled={isPlaying}
              className="playback-slider"
            />
          </div>

          {/* Transport buttons */}
          <div className="playback-transport">
            <button onClick={stop} title="Stop (rewind)">&#9632;</button>
            <button onClick={jumpBack} title="Jump back">&laquo;</button>
            <button onClick={stepBack} title="Step back">&lsaquo;</button>
            {isPlaying ? (
              <button onClick={pause} title="Pause" className="playback-main-btn">&#10074;&#10074;</button>
            ) : (
              <button onClick={play} title="Play" className="playback-main-btn">&#9654;</button>
            )}
            <button onClick={stepForward} title="Step forward">&rsaquo;</button>
            <button onClick={jumpForward} title="Jump forward">&raquo;</button>
          </div>

          {/* Speed selector */}
          <div className="playback-speed">
            <span>Speed:</span>
            {SPEED_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={playbackSpeed === opt.value ? 'active' : ''}
                onClick={() => setPlaybackSpeed(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Info line */}
          <div className="playback-info">
            <span>Step {currentStep}/{totalSteps - 1} ({pct}%)</span>
            <span>Line {blockLine}</span>
            <span>{isRapid ? 'G0 Rapid' : `F${feedRate}`}</span>
          </div>
          {/* Rotary angles & angular velocity */}
          {config && config.rotaryAxes.length > 0 && currentPt && (() => {
            const prevPt = currentStep > 0 ? toolPath[currentStep - 1] : null
            const axisMap: Record<string, number> = { A: currentPt.a, B: currentPt.b, C: currentPt.c }
            const prevMap: Record<string, number> = prevPt
              ? { A: prevPt.a, B: prevPt.b, C: prevPt.c }
              : axisMap
            return (
              <div className="playback-info playback-rotary">
                {config.rotaryAxes.map(name => {
                  const angle = axisMap[name] ?? 0
                  const prevAngle = prevMap[name] ?? 0
                  const delta = Math.abs(angle - prevAngle)
                  // Approximate angular velocity: delta_deg * F / linear_dist
                  let angVel = ''
                  if (prevPt && delta > 0.001 && !currentPt.rapid && currentPt.feed > 0) {
                    const linDist = Math.sqrt(
                      (currentPt.x - prevPt.x) ** 2 +
                      (currentPt.y - prevPt.y) ** 2 +
                      (currentPt.z - prevPt.z) ** 2
                    )
                    const totalDist = Math.sqrt(linDist ** 2 + delta ** 2)
                    const rate = totalDist > 0.001 ? (delta / totalDist) * currentPt.feed : 0
                    angVel = ` (${rate.toFixed(1)}°/min)`
                  }
                  return (
                    <span key={name}>
                      {name}={angle.toFixed(3)}°{angVel}
                    </span>
                  )
                })}
              </div>
            )
          })()}
        </>
      )}

      {totalSteps === 0 && (
        <div className="playback-empty">Parse G-Code to enable playback</div>
      )}
    </div>
  )
}

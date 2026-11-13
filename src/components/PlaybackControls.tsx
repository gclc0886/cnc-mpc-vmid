import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMachineStore, PLAYBACK_SPEEDS } from '../store/useMachineStore'
import { stepAtTime, stepOfAdjacentBlock } from '../engine/PathKinematics'
import { useLiveVersion } from '../hooks/useLiveVersion'

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const store = () => useMachineStore.getState()

/**
 * Real-time playback loop: advances program time by frame time × speed, independent
 * of FPS, and applies the sample at that time. Runs only while isPlaying.
 */
function usePlaybackLoop(isPlaying: boolean) {
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    let lastNow = performance.now()
    const s0 = store()
    let time = s0.toolPath[s0.currentStep]?.t ?? 0

    const frame = (now: number) => {
      const s = store()
      if (!s.isPlaying || s.toolPath.length === 0) return
      const dt = Math.min((now - lastNow) / 1000, 0.25) // clamp after tab switches
      lastNow = now
      time += dt * s.playbackSpeed
      const last = s.toolPath.length - 1
      if (time >= s.toolPath[last].t) {
        s.applyStep(last)
        s.setIsPlaying(false)
        return
      }
      const step = stepAtTime(s.toolPath, time)
      if (step !== s.currentStep) s.applyStep(step)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying])
}

function DiagnosticsList() {
  const { diagnostics, gcodeDialect, programDuration, hasPath, jumpToLine } = useMachineStore(useShallow(s => ({
    diagnostics: s.diagnostics, gcodeDialect: s.gcodeDialect, programDuration: s.programDuration,
    hasPath: s.toolPath.length > 0, jumpToLine: s.jumpToLine,
  })))
  if (!hasPath && diagnostics.length === 0) return null
  const errors = diagnostics.filter(d => d.severity === 'error').length
  const warnings = diagnostics.filter(d => d.severity === 'warning').length
  const color = errors ? '#ff5252' : warnings ? '#ffb74d' : '#81c784'
  return (
    <details className="playback-diagnostics" open={errors > 0}>
      <summary>
        <span>{gcodeDialect === 'fanuc' ? 'Fanuc' : 'Sinumerik'} · {formatTime(programDuration)}</span>
        <span style={{ color }}>
          {errors || warnings ? `${errors} err · ${warnings} warn` : 'no issues'}
        </span>
      </summary>
      {diagnostics.length > 0 && (
        <ul>
          {diagnostics.slice(0, 200).map((d, i) => (
            <li
              key={i}
              className={`diag-${d.severity}`}
              onClick={() => d.line > 0 && jumpToLine(d.line)}
              title={d.line > 0 ? 'Jump to this line' : undefined}
            >
              {d.line > 0 && <b>L{d.line}</b>} {d.message}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

/** Step / time / line read-out and the time scrubber — throttled to ~10 Hz during playback. */
function PlaybackStatus() {
  useLiveVersion()
  const { toolPath, currentStep, parsedBlocks, programDuration, isPlaying, applyStep } = store()
  const total = toolPath.length
  const pt = toolPath[currentStep]
  const line = pt ? (parsedBlocks[pt.blockIndex]?.line ?? 0) : 0
  const t = pt?.t ?? 0
  const duration = Math.max(programDuration, 1e-6)
  return (
    <>
      <div className="playback-scrub">
        <input
          type="range"
          min={0}
          max={duration}
          step={duration / 2000}
          value={t}
          onChange={(e) => applyStep(stepAtTime(toolPath, parseFloat(e.target.value)))}
          disabled={isPlaying}
          className="playback-slider"
          title="Program time"
        />
      </div>
      <div className="playback-info">
        <span>Time {formatTime(t)} / {formatTime(programDuration)}</span>
        <span>Line {line}</span>
        <span>{pt?.rapid ? 'G0' : `F${Math.round(pt?.feed ?? 0)}`}</span>
      </div>
      <div className="playback-info">
        <span>Step {currentStep}/{Math.max(total - 1, 0)}</span>
        <span>{total > 0 ? ((t / duration) * 100).toFixed(1) : '0'}%</span>
      </div>
    </>
  )
}

export function PlaybackControls() {
  const {
    hasPath, isPlaying, playbackSpeed, config, activeCombinationId, traceFrame,
    setIsPlaying, setPlaybackSpeed, applyStep, parseGcode, setActiveCombination, setTraceFrame,
  } = useMachineStore(useShallow(s => ({
    hasPath: s.toolPath.length > 0, isPlaying: s.isPlaying, playbackSpeed: s.playbackSpeed,
    config: s.config, activeCombinationId: s.activeCombinationId, traceFrame: s.traceFrame,
    setIsPlaying: s.setIsPlaying, setPlaybackSpeed: s.setPlaybackSpeed, applyStep: s.applyStep,
    parseGcode: s.parseGcode, setActiveCombination: s.setActiveCombination, setTraceFrame: s.setTraceFrame,
  })))

  usePlaybackLoop(isPlaying)

  const play = () => {
    const { toolPath, currentStep } = store()
    if (toolPath.length === 0) return
    if (currentStep >= toolPath.length - 1) applyStep(0) // restart from the beginning
    setIsPlaying(true)
  }
  const stop = () => { setIsPlaying(false); applyStep(0) }
  const stepBy = (d: number) => {
    const { toolPath, currentStep } = store()
    if (toolPath.length === 0) return
    applyStep(Math.min(Math.max(currentStep + d, 0), toolPath.length - 1))
  }
  const blockBy = (dir: 1 | -1) => {
    const { toolPath, currentStep } = store()
    if (toolPath.length === 0) return
    setIsPlaying(false)
    applyStep(stepOfAdjacentBlock(toolPath, currentStep, dir))
  }

  return (
    <div className="playback-controls">
      <div className="playback-header">
        <span className="playback-title">PLAYBACK</span>
        <button className="playback-parse-btn" onClick={parseGcode} disabled={isPlaying}>
          Parse G-Code
        </button>
      </div>

      {/* Sub-machine (combination) selector */}
      {config && config.combinations && config.combinations.length > 1 && (
        <div className="playback-combination">
          <span>Sub-machine:</span>
          <select
            value={activeCombinationId ?? ''}
            onChange={(e) => setActiveCombination(e.target.value ? Number(e.target.value) : null)}
            disabled={isPlaying}
          >
            {config.combinations.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {hasPath && (
        <>
          <PlaybackStatus />

          <div className="playback-transport">
            <button onClick={stop} title="Stop (rewind)">&#9632;</button>
            <button onClick={() => blockBy(-1)} title="Previous block">&laquo;</button>
            <button onClick={() => stepBy(-1)} title="Previous sample">&lsaquo;</button>
            {isPlaying ? (
              <button onClick={() => setIsPlaying(false)} title="Pause" className="playback-main-btn">&#10074;&#10074;</button>
            ) : (
              <button onClick={play} title="Play" className="playback-main-btn">&#9654;</button>
            )}
            <button onClick={() => stepBy(1)} title="Next sample">&rsaquo;</button>
            <button onClick={() => blockBy(1)} title="Next block">&raquo;</button>
          </div>

          <div className="playback-speed">
            <span title="Multiple of real program time">Speed:</span>
            {PLAYBACK_SPEEDS.map(v => (
              <button key={v} className={playbackSpeed === v ? 'active' : ''} onClick={() => setPlaybackSpeed(v)}>
                {v}×
              </button>
            ))}
          </div>

          <div className="playback-speed">
            <span title="Where the tool trace is drawn">Trace:</span>
            <button className={traceFrame === 'work' ? 'active' : ''} onClick={() => setTraceFrame('work')}
              title="On the workpiece — moves with the table (what is actually cut)">on part</button>
            <button className={traceFrame === 'world' ? 'active' : ''} onClick={() => setTraceFrame('world')}
              title="Tool tip in machine space">in machine</button>
          </div>
        </>
      )}

      {!hasPath && (
        <div className="playback-empty">Parse G-Code to enable playback</div>
      )}

      <DiagnosticsList />
    </div>
  )
}

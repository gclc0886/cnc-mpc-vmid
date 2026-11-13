import { useMachineStore } from '../store/useMachineStore'
import { useLiveVersion } from '../hooks/useLiveVersion'

type StoreState = ReturnType<typeof useMachineStore.getState>

/** Angular speed of each driven rotary axis at the current sample, from sample times (deg/min). */
function rotaryRates(s: StoreState): { name: string; rate: number }[] {
  const { toolPath, currentStep, axisMapping } = s
  if (!axisMapping || currentStep < 1 || currentStep >= toolPath.length) return []
  const pt = toolPath[currentStep]
  const prev = toolPath[currentStep - 1]
  const dt = pt.t - prev.t
  if (dt <= 1e-9) return []
  const out: { name: string; rate: number }[] = []
  ;(['a', 'b', 'c'] as const).forEach((k, i) => {
    const name = axisMapping.rotary[i]
    const d = Math.abs(pt[k] - prev[k])
    if (name && d > 1e-6) out.push({ name, rate: (d / dt) * 60 })
  })
  return out
}

/**
 * Overlay with MCS/WCS tool tip, rotary angles, feed and limit warnings.
 * Re-renders at most ~10 Hz during playback (useLiveVersion).
 */
export function CoordDisplay() {
  useLiveVersion()
  const s = useMachineStore.getState()
  const { chain, config, toolPath, currentStep, stepViolations } = s
  if (!chain) return null

  const toolTip = chain.getToolTipPosition()
  // TCP in the workpiece (table leaf) frame: Inv(Table) × Tool. Work offset not applied yet.
  const tcpWork = chain.getRelativeMatrix().getTranslation()
  const categoryBadge = chain.machineCategory.replace(/_/g, ' ').toUpperCase()
  const pt = toolPath.length > 0 ? toolPath[currentStep] : undefined

  return (
    <div className="coord-display">
      <div className="category-badge">{categoryBadge}</div>
      <div className="mcs">
        MCS: X={toolTip[0].toFixed(3)} Y={toolTip[1].toFixed(3)} Z={toolTip[2].toFixed(3)}
      </div>
      <div className="wcs" title="Tool tip in the workpiece (table) frame: Inv(Table) × Tool. Work offset (G54) not applied.">
        WCS: X={tcpWork[0].toFixed(3)} Y={tcpWork[1].toFixed(3)} Z={tcpWork[2].toFixed(3)}
      </div>
      {stepViolations.length > 0 && (
        <div className="limit-warning">
          LIMIT: {stepViolations.map(v => `${v.axis}=${v.value.toFixed(3)} [${v.min}…${v.max}]`).join('  ')}
        </div>
      )}
      {config && config.rotaryAxes.length > 0 && (
        <div className="rotary-display">
          {config.rotaryAxes.map(name => (
            <span key={name} className="rotary-axis">
              {name}={chain.getAxisValue(name).toFixed(3)}°
            </span>
          ))}
        </div>
      )}
      {pt && (
        <div className="feed-display">
          <span>{pt.rapid ? `G0 Rapid ${Math.round(pt.feed)} mm/min` : `F${Math.round(pt.feed)} mm/min`}</span>
          {rotaryRates(s).map(r => (
            <span key={r.name}> {r.name}̇={r.rate.toFixed(0)}°/min</span>
          ))}
        </div>
      )}
    </div>
  )
}

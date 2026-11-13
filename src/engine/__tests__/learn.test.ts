import { describe, it, expect } from 'vitest'
import { KinematicChain } from '../KinematicChain'
import { explainChain, composeLocals, rotationOf, nodeFormula } from '../ChainExplain'
import { Matrix4x4 } from '../Matrix4x4'
import { PRESETS } from '../../presets/machinePresets'
import { useMachineStore } from '../../store/useMachineStore'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('explainChain', () => {
  it.each(Object.keys(PRESETS))('%s: product of the local matrices equals the leaf world matrix', key => {
    const ch = new KinematicChain(clone(PRESETS[key]))
    const vals: Record<string, number> = {}
    let k = 1
    for (const [name, node] of ch.nodes) vals[name] = node.axis.type === 'rotary' ? 17 * k++ : 3.5 * k++
    ch.setAxisValues(vals, false)
    ch.setTool(80, 4)
    const ex = explainChain(ch)
    expect(ex.devices.length).toBeGreaterThan(0)
    for (const d of ex.devices) {
      const leaf = d.steps[d.steps.length - 1]
      const prod = composeLocals(d.steps)
      for (let i = 0; i < 16; i++) expect(prod.data[i]).toBeCloseTo(leaf.world.data[i], 9)
    }
    // tool tip and relative match the chain's own results
    expect(ex.tool!.tip.getTranslation()).toEqual(ch.getToolTipPosition())
    expect(ex.relative!.data).toEqual(ch.getRelativeMatrix().data)
  })

  it('writes the local transform as offset · motion', () => {
    const ch = new KinematicChain(clone(PRESETS['4x']))
    ch.setAxisValues({ A: 30, X: 12.5 }, false)
    expect(nodeFormula(ch.nodes.get('A')!)).toBe('T(0, 0, −40) · R((−1, 0, 0), 30°)')
    expect(nodeFormula(ch.nodes.get('X')!)).toBe('T((−1, 0, 0) · 12.5)')
  })

  it('rotationOf recovers angle and axis', () => {
    const r = rotationOf(Matrix4x4.rotationAxis(0, 1, 1, 40))
    expect(r.angle).toBeCloseTo(40, 9)
    expect(r.axis.y).toBeCloseTo(Math.SQRT1_2, 9)
    expect(r.axis.z).toBeCloseTo(Math.SQRT1_2, 9)
    expect(rotationOf(Matrix4x4.rotationX(180)).angle).toBeCloseTo(180, 9)
    expect(rotationOf(Matrix4x4.identity()).angle).toBe(0)
  })
})

describe('with / without transformation', () => {
  const store = () => useMachineStore.getState()

  it('TRAORI program: without RTCP the tip drifts on the part; the stats point at the rotary move', () => {
    store().loadPreset('5x_ac')
    store().setTool('1', { length: 100, radius: 5 })
    store().setGcode('T1\nTRAORI\nG1 X10 Y5 Z20 F500\nG1 A30 C45\nTRAFOOF')
    store().parseGcode()
    expect(store().hasTransformations).toBe(true)
    store().setCompareTransform(true)
    const st = store().compareStats!
    expect(st.maxDev).toBeGreaterThan(10)
    expect(st.line).toBe(4)
    expect(store().comparePath!.length).toBeGreaterThan(0)
    store().setCompareTransform(false)
    expect(store().comparePath).toBeNull()
    store().setTool('1', null)
  })

  it('a program without TRAORI/CYCLE800 has nothing to compare', () => {
    store().loadPreset('3x')
    store().setGcode('G1 X10 F100')
    store().parseGcode()
    expect(store().hasTransformations).toBe(false)
    store().setCompareTransform(true)
    expect(store().compareStats).toBeNull()
    store().setCompareTransform(false)
  })
})

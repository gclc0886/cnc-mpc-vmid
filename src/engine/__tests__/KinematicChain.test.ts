import { describe, it, expect } from 'vitest'
import { KinematicChain } from '../KinematicChain'
import { PRESETS } from '../../presets/machinePresets'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const chainFor = (key: string) => new KinematicChain(clone(PRESETS[key]))

function expectVec(actual: number[], expected: number[], digits = 9) {
  expected.forEach((e, i) => expect(actual[i]).toBeCloseTo(e, digits))
}

describe('forward kinematics on presets', () => {
  it('3-axis: tool and table leaves at zero', () => {
    const ch = chainFor('3x')
    ch.updateMatrices()
    expectVec(ch.getToolTipPosition(), [0, 0, 200])
    expectVec(ch.getDeviceLeafNode('table')!.worldMatrix.getTranslation(), [0, 0, -50])
    expectVec(ch.getRelativeMatrix().getTranslation(), [0, 0, 250])
  })

  it('3-axis: programmed X+ moves the tool +X relative to the workpiece (table moves −X)', () => {
    const ch = chainFor('3x')
    ch.setAxisValues({ X: 10, Z: -20 })
    expectVec(ch.getToolTipPosition(), [0, 0, 180])
    expectVec(ch.getDeviceLeafNode('table')!.worldMatrix.getTranslation(), [-10, 0, -50])
    expectVec(ch.getRelativeMatrix().getTranslation(), [10, 0, 230])
  })

  it('4-axis: A=+90 turns the tool +90° about the workpiece X axis (+Z → −Y)', () => {
    // Table A vector is (−1,0,0): the table turns −90° about X, so relative to the part
    // the tool turns +90° about +X: Rx(90)·(0,0,290) = (0,−290,0).
    const ch = chainFor('4x')
    ch.setAxisValues({ A: 90 })
    expectVec(ch.getRelativeMatrix().getTranslation(), [0, -290, 0])
  })

  it('relative matrix is a proper rigid transform after rotations', () => {
    const ch = chainFor('5x_ac')
    ch.setAxisValues({ X: 12, Y: -7, Z: 30, A: 35, C: 140 })
    const rel = ch.getRelativeMatrix()
    // Rebuild the tool world matrix from table × relative
    const table = ch.getDeviceLeafNode('table')!.worldMatrix
    const tool = ch.getDeviceLeafNode('spindle')!.worldMatrix
    const rebuilt = table.multiply(rel)
    for (let i = 0; i < 16; i++) expect(rebuilt.data[i]).toBeCloseTo(tool.data[i], 9)
  })

  it('head-head: B tilt swings the tool tip around the B pivot', () => {
    const ch = chainFor('5x_bc')
    ch.updateMatrices()
    const z0 = ch.getToolTipPosition()
    ch.setAxisValues({ B: 90 })
    const z90 = ch.getToolTipPosition()
    // C sits 50 mm below B; a 90° turn about Y moves that lever from -Z to -X
    expect(z90[0] - z0[0]).toBeCloseTo(-50, 9)
    expect(z90[2] - z0[2]).toBeCloseTo(50, 9)
  })
})

describe('ISO 841 direction convention on milling presets', () => {
  // Positive programmed motion = tool moves positive relative to the workpiece
  it.each(['3x', '4x', '5x_ac', '5x_bc'])('%s: X+, Y+, Z+ move the tool + in the workpiece frame', key => {
    const ch = chainFor(key)
    ch.updateMatrices()
    const p0 = ch.getRelativeMatrix().getTranslation()
    for (const [axis, i] of [['X', 0], ['Y', 1], ['Z', 2]] as const) {
      ch.setAxisValues({ X: 0, Y: 0, Z: 0, [axis]: 5 })
      const p = ch.getRelativeMatrix().getTranslation()
      expect(p[i] - p0[i]).toBeCloseTo(5, 9)
    }
  })

  it.each([['4x', 'A', 0], ['5x_ac', 'A', 0], ['5x_ac', 'C', 2]] as const)(
    '%s: %s+ rotates the tool positively about the workpiece axis', (key, axis, k) => {
      const ch = chainFor(key)
      ch.setAxisValues({ [axis]: 10 })
      // Rotation of the tool relative to the part: R = rotation block of Inv(Table)×Tool
      const r = ch.getRelativeMatrix().data
      const s = k === 0 ? r[9] : r[4] // sin θ for Rx (row 2, col 1) / Rz (row 1, col 0)
      expect(s).toBeCloseTo(Math.sin(10 * Math.PI / 180), 9)
    })
})

describe('tool length in the kinematics', () => {
  it('the tool tip hangs L below the spindle nose along the tool axis', () => {
    const ch = chainFor('3x')
    ch.updateMatrices()
    const nose = ch.getToolTipPosition()
    ch.setTool(100, 5)
    expectVec(ch.getToolTipPosition(), [nose[0], nose[1], nose[2] - 100])
    expect(ch.getRelativeMatrix().getTranslation()[2]).toBeCloseTo(250 - 100, 9)
  })

  it('on a head-head machine the tool tilts with the head', () => {
    const ch = chainFor('5x_bc')
    ch.setTool(100, 5)
    ch.setAxisValues({ B: 90 })
    const tip = ch.getToolTipPosition()
    ch.setTool(0, 0)
    const nose = ch.getToolTipPosition()
    // B=90 about Y turns the tool axis from −Z to −X
    expect(tip[0] - nose[0]).toBeCloseTo(-100, 9)
    expect(tip[2] - nose[2]).toBeCloseTo(0, 9)
  })
})

describe('setAxisValues', () => {
  it('assigns several axes with a single matrix update', () => {
    const ch = chainFor('5x_ac')
    let updates = 0
    const orig = ch.updateMatrices.bind(ch)
    ch.updateMatrices = () => { updates++; orig() }
    ch.setAxisValues({ X: 1, Y: 2, Z: 3, A: 4, C: 5 })
    expect(updates).toBe(1)
    expect(ch.getAllPositions()).toMatchObject({ X: 1, Y: 2, Z: 3, A: 4, C: 5 })
  })

  it('ignores unknown axes and non-finite values', () => {
    const ch = chainFor('3x')
    ch.setAxisValues({ Q: 5, X: NaN, Y: 4 })
    expect(ch.getAxisValue('X')).toBe(0)
    expect(ch.getAxisValue('Y')).toBe(4)
  })
})

describe('limits', () => {
  it('clamps by default (manual jogging)', () => {
    const ch = chainFor('5x_ac') // A limits ±120
    expect(ch.setAxisValue('A', 200)).toBeNull()
    expect(ch.getAxisValue('A')).toBe(120)
    expect(ch.getLimitViolations()).toEqual([])
  })

  it('keeps the value and reports a violation when clamp=false (simulation)', () => {
    const ch = chainFor('5x_ac')
    const v = ch.setAxisValues({ A: 200, X: 10 }, false)
    expect(ch.getAxisValue('A')).toBe(200)
    expect(v).toEqual([{ axis: 'A', value: 200, min: -120, max: 120 }])
    expect(ch.getLimitViolations()).toEqual(v)
  })

  it('treats huge VMID placeholder limits as unlimited', () => {
    const cfg = clone(PRESETS['3x'])
    cfg.devices[1].axes[0].limits = { min: -2539999.96, max: 2539999.96 }
    const ch = new KinematicChain(cfg)
    expect(ch.setAxisValues({ X: 1e6 }, false)).toEqual([])
  })

  it('static axes never violate', () => {
    const ch = chainFor('5x_bc') // TABLE is static with limits 0..0
    expect(ch.getLimitViolations()).toEqual([])
  })
})

describe('axis ID index', () => {
  it('resolves combination axis IDs to names', () => {
    const ch = chainFor('5x_ac')
    expect(ch.axisNameById(1)).toBe('X')
    expect(ch.axisNameById(5)).toBe('C')
    expect(ch.axisNameById(999)).toBeUndefined()
  })
})

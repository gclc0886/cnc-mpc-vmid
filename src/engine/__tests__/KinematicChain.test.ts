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

  it('3-axis: moving the table +X moves the tool -X relative to the workpiece', () => {
    const ch = chainFor('3x')
    ch.setAxisValues({ X: 10, Z: -20 })
    expectVec(ch.getToolTipPosition(), [0, 0, 180])
    expectVec(ch.getRelativeMatrix().getTranslation(), [-10, 0, 230])
  })

  it('4-axis: A=90 puts the spindle on the workpiece +Y side', () => {
    // Table leaf = T(0,0,-50)·T(0,0,-40)·Rx(90); tool at (0,0,200).
    // In the workpiece frame the tool is 290 mm away along +Y (Rx(90) maps +Y → +Z).
    const ch = chainFor('4x')
    ch.setAxisValues({ A: 90 })
    expectVec(ch.getRelativeMatrix().getTranslation(), [0, 290, 0])
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

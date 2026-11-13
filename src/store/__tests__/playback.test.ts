import { describe, it, expect, beforeEach } from 'vitest'
import { useMachineStore } from '../useMachineStore'

const store = () => useMachineStore.getState()

describe('playback through the store', () => {
  beforeEach(() => {
    store().loadPreset('5x_ac') // A limits ±120
  })

  it('applyStep drives physical axes through the combination mapping (plus the auto G54)', () => {
    store().setGcode('G0 X0 Y0 Z0\nG1 X10 Y20 Z-5 F500')
    store().parseGcode()
    const last = store().toolPath.length - 1
    store().applyStep(last)
    expect(store().currentStep).toBe(last)
    const g54 = store().workOffsets.G54
    expect(store().chain!.getAllPositions()).toMatchObject({ X: 10 + g54.x, Y: 20 + g54.y, Z: -5 + g54.z })
  })

  it('auto G54 puts program zero on the workpiece origin', () => {
    expect(store().workOffsets.G54.z).toBeCloseTo(-380, 6) // spindle nose 250 above, table leaf 130 below
    store().setGcode('G54\nG0 X0 Y0 Z0')
    store().parseGcode()
    store().applyStep(store().toolPath.length - 1)
    store().chain!.getRelativeMatrix().getTranslation().forEach(v => expect(v).toBeCloseTo(0, 6))
  })

  it('tool length lifts the spindle but keeps the tool tip on the program point', () => {
    store().setTool('1', { length: 100, radius: 5 })
    store().setGcode('G54\nT1\nG0 X0 Y0 Z0')
    store().parseGcode()
    store().applyStep(store().toolPath.length - 1)
    expect(store().chain!.getAxisValue('Z')).toBeCloseTo(-380 + 100, 6)
    store().chain!.getRelativeMatrix().getTranslation().forEach(v => expect(v).toBeCloseTo(0, 6))
    expect(store().toolsUsed).toEqual(['1'])
    store().setTool('1', null)
  })

  it('editing a work offset re-simulates at the current step', () => {
    store().setGcode('G54\nG1 X100 F1000')
    store().parseGcode()
    store().applyStep(50)
    store().setWorkOffset('G54', { ...store().workOffsets.G54, x: 7 })
    expect(store().currentStep).toBe(50)
    expect(store().chain!.getAxisValue('X')).toBeCloseTo(51 + 7, 6)
  })

  it('does not clamp during simulation and reports the violation', () => {
    store().setGcode('G1 A50 F1000\nG1 A150')
    store().parseGcode()
    const last = store().toolPath.length - 1
    store().applyStep(last)
    expect(store().chain!.getAxisValue('A')).toBeCloseTo(150, 9)
    expect(store().stepViolations.map(v => v.axis)).toEqual(['A'])
    // Last sample of the first block (A0→A50 is interpolated in 1° steps), back inside limits
    const endOfFirst = store().toolPath.findIndex(p => p.blockIndex === 1) - 1
    store().applyStep(endOfFirst)
    expect(store().chain!.getAxisValue('A')).toBeCloseTo(50, 9)
    expect(store().stepViolations).toEqual([])
  })

  it('warns when the program uses an axis the sub-machine cannot drive', () => {
    store().loadPreset('3x')
    store().setGcode('G1 X10 F100\nG1 A45')
    store().parseGcode()
    const d = store().diagnostics.find(x => /A is programmed/.test(x.message))
    expect(d).toMatchObject({ line: 2, severity: 'warning' })
  })

  it('times G0 with the rapid rate of the mapped physical axis', () => {
    const cfg = JSON.parse(JSON.stringify(store().config))
    cfg.devices[1].axes[0].rapid = 5000 // X on the 5x_ac table
    store().loadConfig(cfg)
    store().setGcode('G0 X100')
    store().parseGcode()
    expect(store().programDuration).toBeCloseTo(1.2, 9)
  })

  it('keeps the same empty violations array while in limits', () => {
    store().setGcode('G1 X50 F1000')
    store().parseGcode()
    const before = store().stepViolations
    store().applyStep(3)
    store().applyStep(4)
    expect(store().stepViolations).toBe(before)
  })

  it('switching sub-machine rebuilds the axis mapping', () => {
    const cfg = JSON.parse(JSON.stringify(store().config))
    cfg.combinations.push({ id: 2, name: 'Swapped', turretId: 1, tableId: 2,
      axesOrder: { linear: [2, 1, 3], rotary: [4, 5] } })
    store().loadConfig(cfg)
    store().setActiveCombination(2)
    store().setGcode('G1 X7 Y3 F100')
    store().parseGcode()
    store().applyStep(store().toolPath.length - 1)
    expect(store().chain!.getAllPositions()).toMatchObject({ X: 3, Y: 7 })
  })

  it('config edits keep the selected sub-machine', () => {
    const cfg = JSON.parse(JSON.stringify(store().config))
    cfg.combinations.push({ id: 2, name: 'Other', turretId: 1, tableId: 2,
      axesOrder: { linear: [1, 2, 3], rotary: [4, 5] } })
    store().loadConfig(cfg)
    store().setActiveCombination(2)
    store().updateAxis('X', { limits: { min: -500, max: 500 } })
    expect(store().activeCombinationId).toBe(2)
  })
})

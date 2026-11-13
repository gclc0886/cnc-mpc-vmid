import { describe, it, expect, beforeEach } from 'vitest'
import { useMachineStore } from '../useMachineStore'

const store = () => useMachineStore.getState()

describe('playback through the store', () => {
  beforeEach(() => {
    store().loadPreset('5x_ac') // A limits ±120
  })

  it('applyStep drives physical axes through the combination mapping', () => {
    store().setGcode('G0 X0 Y0 Z0\nG1 X10 Y20 Z-5 F500')
    store().parseGcode()
    const last = store().toolPath.length - 1
    store().applyStep(last)
    expect(store().currentStep).toBe(last)
    expect(store().chain!.getAllPositions()).toMatchObject({ X: 10, Y: 20, Z: -5 })
  })

  it('does not clamp during simulation and reports the violation', () => {
    store().setGcode('G1 A50 F1000\nG1 A150')
    store().parseGcode()
    const last = store().toolPath.length - 1
    store().applyStep(last)
    expect(store().chain!.getAxisValue('A')).toBeCloseTo(150, 9)
    expect(store().stepViolations.map(v => v.axis)).toEqual(['A'])
    store().applyStep(0) // back inside limits
    expect(store().chain!.getAxisValue('A')).toBeCloseTo(50, 9)
    expect(store().stepViolations).toEqual([])
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

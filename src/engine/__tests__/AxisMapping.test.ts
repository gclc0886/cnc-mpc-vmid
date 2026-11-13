import { describe, it, expect } from 'vitest'
import { KinematicChain } from '../KinematicChain'
import { buildAxisMapping, mapPointToAxes, describeMapping } from '../AxisMapping'
import { PRESETS } from '../../presets/machinePresets'
import type { SimPoint } from '../GCodeParser'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
/** Sample whose machine values equal its program values (no offsets). */
const pt = (p: Partial<SimPoint>): SimPoint => {
  const q = { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, ...p }
  return {
    ...q, feed: 100, rapid: false, blockIndex: 0, t: 0, toolLen: 0, toolRadius: 0, moveIndex: 0, frac: 1,
    mx: q.x, my: q.y, mz: q.z, ma: q.a, mb: q.b, mc: q.c,
  }
}

describe('buildAxisMapping', () => {
  it('resolves the combination axis order by ID', () => {
    const cfg = clone(PRESETS['5x_ac'])
    const m = buildAxisMapping(cfg, new KinematicChain(cfg), 1)
    expect(m.source).toBe('combination')
    expect(describeMapping(m)).toEqual({ X: 'X', Y: 'Y', Z: 'Z', A: 'A', B: null, C: 'C' })
  })

  it('assigns rotary letters by axis name, then by rotation vector, then by position', () => {
    const cfg = clone(PRESETS['5x_ac'])
    // Rename: "C1" keeps C by its first letter; an axis named "R" about X falls back to its vector → A
    const table = cfg.devices[1].axes[0].children![0].children![0]
    table.name = 'R'                       // vector (−1,0,0) → A
    table.children![0].name = 'C1'         // name → C
    const m = buildAxisMapping(cfg, new KinematicChain(cfg), 1)
    expect(describeMapping(m)).toMatchObject({ A: 'R', B: null, C: 'C1' })
  })

  it('turn-mill preset: the only rotary axis C is driven by programmed C', () => {
    const cfg = clone(PRESETS['turn_mill'])
    const m = buildAxisMapping(cfg, new KinematicChain(cfg), 1)
    expect(describeMapping(m)).toMatchObject({ A: null, C: 'C' })
  })

  it('follows a non-standard axis order (physical axes named differently)', () => {
    const cfg = clone(PRESETS['3x'])
    cfg.devices[1].axes[0].name = 'X1'      // id 1
    cfg.combinations[0].axesOrder.linear = [3, 1, 2]
    const m = buildAxisMapping(cfg, new KinematicChain(cfg), 1)
    expect(mapPointToAxes(pt({ x: 10, y: 20, z: 30 }), m)).toEqual({ Z: 10, X1: 20, Y: 30 })
  })

  it('falls back to direct names without a combination', () => {
    const cfg = clone(PRESETS['4x'])
    cfg.combinations = []
    const m = buildAxisMapping(cfg, new KinematicChain(cfg), null)
    expect(m.source).toBe('names')
    expect(mapPointToAxes(pt({ x: 1, y: 2, z: 3, a: 45, c: 9 }), m)).toEqual({ X: 1, Y: 2, Z: 3, A: 45 })
  })

  it('leaves unknown axis IDs unmapped', () => {
    const cfg = clone(PRESETS['3x'])
    cfg.combinations[0].axesOrder.linear = [1, 2, 777]
    const m = buildAxisMapping(cfg, new KinematicChain(cfg), 1)
    expect(m.linear).toEqual(['X', 'Y', null])
  })
})

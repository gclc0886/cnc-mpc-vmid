import { describe, it, expect } from 'vitest'
import { computePathKinematics, stepAtTime, stepOfAdjacentBlock } from '../PathKinematics'
import { KinematicChain } from '../KinematicChain'
import { buildAxisMapping } from '../AxisMapping'
import { parseProgram } from '../GCodeParser'
import type { SimPoint } from '../GCodeParser'
import { PRESETS } from '../../presets/machinePresets'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

function run(presetKey: string, gcode: string) {
  const cfg = clone(PRESETS[presetKey])
  const mapping = buildAxisMapping(cfg, new KinematicChain(cfg), cfg.combinations[0]?.id ?? null)
  const { points } = parseProgram(gcode)
  return { points, kin: computePathKinematics(cfg, mapping, points) }
}

const at = (a: Float32Array, i: number) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]

describe('computePathKinematics', () => {
  it('3-axis: the trace on the part follows the programmed XY (table moves, tool cuts)', () => {
    const { points, kin } = run('3x', 'G1 X10 Y5 Z-20 F100')
    const last = points.length - 1
    const w = at(kin.tcpWork, last)
    // Relative to the part: programmed X/Y, plus the fixed Z distance between tool and table leaf
    expect(w[0]).toBeCloseTo(10, 4)
    expect(w[1]).toBeCloseTo(5, 4)
    // In machine space the tool only moves in Z (X/Y are on the table)
    const m = at(kin.tcpWorld, last)
    expect(m[0]).toBeCloseTo(0, 4)
    expect(m[1]).toBeCloseTo(0, 4)
  })

  it('4-axis: a pure A rotation wraps the trace around the part', () => {
    const { points, kin } = run('4x', 'G1 A90 F1000')
    const w = at(kin.tcpWork, points.length - 1)
    expect(w[1]).toBeCloseTo(-290, 3)
    expect(w[2]).toBeCloseTo(0, 3)
    // …while in machine space the tool does not move at all
    expect(at(kin.tcpWorld, points.length - 1)).toEqual(at(kin.tcpWorld, 0))
  })

  it('flags out-of-limit samples and summarises them per axis', () => {
    // 5x_ac: A limits ±120
    const { kin } = run('5x_ac', 'G1 A100 F1000\nG1 A130\nG1 A110')
    expect(kin.limits).toHaveLength(1)
    const s = kin.limits[0]
    expect(s).toMatchObject({ axis: 'A', min: -120, max: 120 })
    expect(s.worst).toBeCloseTo(130, 6)
    expect(s.count).toBe(10 + 9) // A121..A130 going up, A129..A121 coming back
    expect(kin.limitFlags[s.firstStep]).toBe(1)
    expect(kin.limitFlags[s.firstStep - 1]).toBe(0)
  })
})

describe('time and block navigation', () => {
  const pts = (ts: number[], blocks: number[]): SimPoint[] =>
    ts.map((t, i) => ({
      x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, mx: 0, my: 0, mz: 0, ma: 0, mb: 0, mc: 0,
      toolLen: 0, toolRadius: 0, feed: 0, rapid: false, blockIndex: blocks[i], t, moveIndex: blocks[i], frac: 1,
    }))

  it('stepAtTime finds the first sample at or after t', () => {
    const p = pts([1, 2, 2, 3, 5], [0, 0, 1, 1, 2])
    expect(stepAtTime(p, 0)).toBe(0)
    expect(stepAtTime(p, 1.5)).toBe(1)
    expect(stepAtTime(p, 2)).toBe(1)
    expect(stepAtTime(p, 4)).toBe(4)
    expect(stepAtTime(p, 99)).toBe(4)
    expect(stepAtTime([], 1)).toBe(0)
  })

  it('stepOfAdjacentBlock moves to the next block start, and back to the current or previous one', () => {
    const p = pts([1, 2, 3, 4, 5, 6], [0, 0, 1, 1, 1, 2])
    expect(stepOfAdjacentBlock(p, 0, 1)).toBe(2)
    expect(stepOfAdjacentBlock(p, 3, 1)).toBe(5)
    expect(stepOfAdjacentBlock(p, 5, 1)).toBe(5)
    expect(stepOfAdjacentBlock(p, 4, -1)).toBe(2) // to start of current block
    expect(stepOfAdjacentBlock(p, 2, -1)).toBe(0) // already at start → previous block
    expect(stepOfAdjacentBlock(p, 0, -1)).toBe(0)
  })
})

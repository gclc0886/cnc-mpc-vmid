import { describe, it, expect } from 'vitest'
import { parseProgram } from '../GCodeParser'
import type { MachineSetup, SimPoint } from '../GCodeParser'
import { rotRPY, apply3 } from '../gcode/MachineMapper'

const ZERO = { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }
const SETUP: MachineSetup = {
  workOffsets: {
    G54: { ...ZERO, x: 100, y: 50, z: -300 },
    G55: { ...ZERO, x: -20, a: 90 },
  },
  tools: {
    '1': { length: 120, radius: 5 },
    DRILL_8: { length: 80, radius: 4 },
    '7': { length: 55, radius: 3 }, // Fanuc H7
  },
}

const lastPt = (src: string, opts = {}) => {
  const r = parseProgram(src, { setup: SETUP, ...opts })
  return { r, p: r.points[r.points.length - 1] as SimPoint }
}
const machine = (p: SimPoint) => [p.mx, p.my, p.mz, p.ma, p.mb, p.mc].map(v => +v.toFixed(6))

describe('work offsets', () => {
  it('G54 shifts the machine values, not the program values', () => {
    const { p } = lastPt('G54\nG1 X10 Y5 Z2 F100')
    expect([p.x, p.y, p.z]).toEqual([10, 5, 2])
    expect(machine(p)).toEqual([110, 55, -298, 0, 0, 0])
  })

  it('G500 deselects; rotary offsets apply to A/B/C', () => {
    expect(machine(lastPt('G54\nG500\nG1 X10 F100').p)).toEqual([10, 0, 0, 0, 0, 0])
    expect(machine(lastPt('G55\nG1 X10 A5 F100').p)).toEqual([-10, 0, 0, 95, 0, 0])
  })

  it('starts in the initial work offset when the program selects none', () => {
    expect(machine(lastPt('G1 X10 F100', { initialWorkOffset: 'G54' }).p)[0]).toBe(110)
  })

  it('warns once about an undefined work offset and lists the offsets used', () => {
    const { r } = lastPt('G56\nG1 X1 F100\nX2')
    expect(r.diagnostics.filter(d => /G56 is not defined/.test(d.message))).toHaveLength(1)
    expect(r.workOffsetsUsed).toEqual(['G56'])
  })
})

describe('tool length', () => {
  it('Sinumerik: active on M6 with D1, along Z in G17, removed with D0', () => {
    const { r, p } = lastPt('T1\nG1 X0 Y0 Z0 F100\nM6\nG1 Z10\nD0\nG1 Z20')
    // before M6: no length; after M6: +120 in Z; after D0: none
    const z = r.moves.map(m => m.xf.toolLength)
    expect(z).toEqual([0, 120, 0])
    expect(machine(p)[2]).toBe(20)
    expect(r.points.find(q => q.blockIndex === 3)!.toolLen).toBe(120)
  })

  it('without M6 in the program the tool is active as soon as T is programmed', () => {
    expect(lastPt('T="DRILL_8"\nG1 Z0 F100').p.mz).toBe(80)
  })

  it('acts along the tool axis of the working plane (G18 → Y, G19 → X)', () => {
    expect(machine(lastPt('T1\nG18\nG1 X0 Y0 Z0 F100').p).slice(0, 3)).toEqual([0, 120, 0])
    expect(machine(lastPt('T1\nG19\nG1 X0 Y0 Z0 F100').p).slice(0, 3)).toEqual([120, 0, 0])
  })

  it('Fanuc: only under G43 with H, cancelled by G49', () => {
    const r = parseProgram('O1 (T)\nT7 M6\nG0 Z0\nG43 H7 Z0\nG49 Z0', { setup: SETUP })
    expect(r.dialect).toBe('fanuc')
    expect(r.moves.map(m => m.xf.toolLength)).toEqual([0, 55, 0])
  })

  it('warns about a tool missing from the table and reports tools used', () => {
    const r = parseProgram('T="UNKNOWN"\nG1 X1 F100', { setup: SETUP })
    expect(r.diagnostics.some(d => /"UNKNOWN" is not in the tool table/.test(d.message))).toBe(true)
    expect(r.toolsUsed).toEqual(['UNKNOWN'])
  })
})

describe('programmable frames', () => {
  it('TRANS replaces, ATRANS adds, bare TRANS deletes', () => {
    expect(machine(lastPt('TRANS X10 Y20\nG1 X1 Y1 F100').p).slice(0, 2)).toEqual([11, 21])
    expect(machine(lastPt('TRANS X10\nATRANS X5\nG1 X1 F100').p)[0]).toBe(16)
    expect(machine(lastPt('TRANS X10\nTRANS\nG1 X1 F100').p)[0]).toBe(1)
  })

  it('ROT Z rotates the program about the frame origin; AROT adds', () => {
    const p = lastPt('ROT Z90\nG1 X10 Y0 F100').p
    expect(p.mx).toBeCloseTo(0, 9)
    expect(p.my).toBeCloseTo(10, 9)
    const q = lastPt('ROT Z45\nAROT Z45\nG1 X10 Y0 F100').p
    expect(q.mx).toBeCloseTo(0, 9)
    expect(q.my).toBeCloseTo(10, 9)
  })

  it('TRANS then AROT rotates about the translated origin', () => {
    const p = lastPt('TRANS X100\nAROT Z90\nG1 X10 Y0 F100').p
    expect(p.mx).toBeCloseTo(100, 9)
    expect(p.my).toBeCloseTo(10, 9)
  })

  it('ROT X Y Z uses RPY order (Z, then Y\', then X\'\')', () => {
    const p = lastPt('ROT X30 Y20 Z10\nG1 X1 Y2 Z3 F100').p
    const e = apply3(rotRPY(30, 20, 10), [1, 2, 3])
    expect(p.mx).toBeCloseTo(e[0], 9)
    expect(p.my).toBeCloseTo(e[1], 9)
    expect(p.mz).toBeCloseTo(e[2], 9)
  })

  it('ROT RPL= rotates in the working plane', () => {
    const p = lastPt('ROT RPL=90\nG1 X10 F100').p
    expect(p.my).toBeCloseTo(10, 9)
  })

  it('frame, work offset and tool length combine: m = R·p + t + G54 + L', () => {
    const p = lastPt('G54\nT1 D1\nTRANS X1\nG1 X0 Y0 Z0 F100').p
    expect(machine(p)).toEqual([101, 50, -180, 0, 0, 0])
  })
})

describe('machine coordinates (G53/SUPA)', () => {
  it('Sinumerik G53 Z0 drives the axis to machine Z0 + tool length, then returns to WCS', () => {
    const r = parseProgram('G54\nT1\nG0 X0 Y0 Z10\nG0 G53 Z0\nG0 Z10', { setup: SETUP })
    const ends = r.moves.map(m => { const s = r.points.filter(q => q.blockIndex === m.blockIndex); return s[s.length - 1] })
    expect(ends[1].mz).toBeCloseTo(120, 9)        // machine Z0 with the tool length kept
    expect(ends[1].mx).toBeCloseTo(100, 9)        // X untouched (still WCS X0 under G54)
    expect(ends[2].mz).toBeCloseTo(-300 + 10 + 120, 9)
  })

  it('Fanuc G53 positions the axis itself (no tool length)', () => {
    const r = parseProgram('O1 (T)\nG54\nT7 M6\nG43 H7 Z50\nG0 G53 Z0', { setup: SETUP })
    expect(r.points[r.points.length - 1].mz).toBeCloseTo(0, 9)
  })
})

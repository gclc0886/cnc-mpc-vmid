import { describe, it, expect } from 'vitest'
import { interpret } from '../gcode/Interpreter'
import { parseProgram } from '../GCodeParser'
import { planSteps, holePattern, expandSinumerikCycle } from '../gcode/Cycles'

/** Z profile of the moves the program produced (start → each end), rounded. */
const zPath = (src: string) => {
  const r = interpret(src)
  return r.moves.filter(m => m.kind !== 'dwell').map(m => Math.round(m.end.z * 1000) / 1000)
}
const kinds = (src: string) => interpret(src).moves.map(m => m.kind)
const diags = (src: string) => interpret(src).diagnostics

describe('Sinumerik drilling cycles', () => {
  it('CYCLE81 at the current position: safety plane, feed to depth, rapid to RTP', () => {
    const r = interpret('G0 X10 Y20 Z100\nF200\nCYCLE81(50,0,2,-15)')
    const cyc = r.moves.slice(1)
    expect(cyc.map(m => [m.kind, m.end.z])).toEqual([['rapid', 2], ['linear', -15], ['rapid', 50]])
    expect(cyc.every(m => m.end.x === 10 && m.end.y === 20)).toBe(true)
    expect(cyc[1].feed).toBe(200)
  })

  it('DPR (relative depth) wins over DP when not zero', () => {
    expect(zPath('F100\nCYCLE81(10,5,1,-100,8)')).toEqual([6, -3, 10])
    expect(zPath('F100\nCYCLE81(10,5,1,-20,0)')).toEqual([6, -20, 10])
  })

  it('CYCLE82 dwells at the bottom (seconds, or revolutions when negative)', () => {
    const r = interpret('S600 F100\nCYCLE82(10,0,1,-5,,-3)')
    const dw = r.moves.find(m => m.kind === 'dwell')!
    expect(dw.dwell).toBeCloseTo(3 / 600 * 60, 9)
    expect(dw.end.z).toBe(-5)
  })

  it('CYCLE83 chip removal (VARI=1) as SolidCAM writes it: 5 mm pecks with DAM=5', () => {
    // 4xx.mpf: MCALL CYCLE83(50,41.164,2,9,,,5,5,,,1,1) → RFP 41.164, depth 9, steps of 5
    const z = zPath('F300\nCYCLE83(50,41.164,2,9,,,5,5,,,1,1)')
    const linearEnds = interpret('F300\nCYCLE83(50,41.164,2,9,,,5,5,,,1,1)').moves.filter(m => m.kind === 'linear').map(m => +m.end.z.toFixed(3))
    expect(linearEnds).toEqual([36.164, 31.164, 26.164, 21.164, 16.164, 11.164, 9])
    // chip removal: back to the safety plane (43.164) between pecks
    expect(z.filter(v => v === 43.164).length).toBeGreaterThanOrEqual(7)
    expect(z[z.length - 1]).toBe(50)
  })

  it('CYCLE83 with absolute first depth and DAM=0 keeps the first infeed (STUPICA format)', () => {
    const ends = interpret('F100\nCYCLE83(5, 0, 5, -35.403, , -8, , 0, , , 1, 1, , 8, 0, 0, 0)').moves
      .filter(m => m.kind === 'linear').map(m => +m.end.z.toFixed(3))
    expect(ends).toEqual([-8, -16, -24, -32, -35.403])
  })

  it('CYCLE83 chip breaking (VARI=0) only backs off by _VRT', () => {
    const r = interpret('F100\nCYCLE83(10,0,2,-12,,,4,0,,,1,0,,,0.5)')
    const seq = r.moves.map(m => +m.end.z.toFixed(3))
    expect(seq).toEqual([2, -4, -3.5, -8, -7.5, -12, 10])
  })

  it('CYCLE84 rigid tapping: feed = SST × PIT down, SST1 × PIT up (STUPICA format)', () => {
    const r = interpret('S500 F100\nCYCLE84 (10,,2,-8,0,0.,3,,1,0,100,200,,,1221)')
    const lin = r.moves.filter(m => m.kind === 'linear')
    expect(lin.map(m => [m.end.z, m.feed])).toEqual([[-8, 100], [2, 200]])
  })

  it('reports the swapped parameter order of the old post (depth above RFP)', () => {
    // Old SolidCAM output CYCLE83(RTP, DP, RFP, FEED, …): read as RFP=9, DP=300
    const d = diags('MCALL CYCLE83 (50,9,41.164,300,,5,,5,,,1,1)\nX0 Y0\nMCALL')
    expect(d.some(x => x.severity === 'error' && /not below the reference plane.*parameter order/.test(x.message))).toBe(true)
  })

  it('warns when RTP is below the safety plane', () => {
    expect(diags('F100\nCYCLE81(1,0,2,-5)').some(x => /RTP 1 is below the safety plane/.test(x.message))).toBe(true)
  })
})

describe('MCALL', () => {
  it('runs the cycle after every block with motion until MCALL alone', () => {
    const r = interpret('G0 Z50\nF100\nMCALL CYCLE81(10,0,1,-5)\nX10 Y0\nX20\nMCALL\nX30')
    // three positions; holes at the first two only
    const holes = r.moves.filter(m => m.kind === 'linear' && m.end.z === -5).map(m => m.end.x)
    expect(holes).toEqual([10, 20])
  })

  it('a block with axis words drills even if the position does not change (SolidCAM style)', () => {
    const r = interpret('G0 X25.924 Y0 Z120\nF300\nMCALL CYCLE83(50,41.164,2,9,,,5,5,,,1,1)\nX25.924 Y0\nMCALL')
    expect(r.moves.some(m => m.kind === 'linear' && m.end.z === 9)).toBe(true)
    expect(r.diagnostics.filter(d => d.severity !== 'info')).toEqual([])
  })

  it('reports MCALL cancelled before any motion — the old post produced no hole', () => {
    const r = interpret('G0 X25.924 Z50\nF300\nMCALL CYCLE81(50,41,2,9)\n\nMCALL')
    expect(r.moves.some(m => m.kind === 'linear')).toBe(false)
    expect(r.diagnostics.some(d => /cancelled before any block with motion — no hole drilled/.test(d.message))).toBe(true)
  })

  it('HOLES1 / HOLES2 position the modal cycle', () => {
    const row = interpret('G0 Z20\nF100\nMCALL CYCLE81(10,0,1,-5)\nHOLES1(0,0,0,10,20,3)\nMCALL')
    expect(row.moves.filter(m => m.kind === 'linear').map(m => m.end.x)).toEqual([10, 30, 50])
    const circ = interpret('G0 Z20\nF100\nMCALL CYCLE81(10,0,1,-5)\nHOLES2(0,0,50,0,0,4)\nMCALL')
    const pts = circ.moves.filter(m => m.kind === 'linear').map(m => [+m.end.x.toFixed(6) + 0, +m.end.y.toFixed(6) + 0])
    expect(pts).toEqual([[50, 0], [0, 50], [-50, 0], [0, -50]])
  })

  it('timing includes the drilling cycle', () => {
    // 15 mm at F150 = 6 s plus rapids
    const r = parseProgram('G0 X0 Y0 Z50\nF150\nCYCLE81(50,0,0,-15)')
    expect(r.duration).toBeGreaterThan(6)
    expect(r.duration).toBeLessThan(7)
  })
})

describe('Fanuc canned cycles', () => {
  const F = (body: string) => `O1 (T)\n${body}`

  it('G81 is modal: X/Y positions drill until G80; Z is the depth, not a move', () => {
    const r = interpret(F('G0 X0 Y0 Z50\nG81 X10 Y10 Z-5 R2 F100\nX20\nG80\nX30'))
    expect(r.dialect).toBe('fanuc')
    const holes = r.moves.filter(m => m.kind === 'linear' && m.end.z === -5).map(m => m.end.x)
    expect(holes).toEqual([10, 20])
    // G98 (default) returns to the initial level 50
    expect(r.moves.filter(m => m.kind === 'rapid').map(m => m.end.z)).toContain(50)
  })

  it('G99 returns to the R plane; G83 pecks by Q', () => {
    const r = interpret(F('G0 X0 Y0 Z50\nG99 G83 X0 Y0 Z-10 R2 Q4 F100\nG80'))
    const lin = r.moves.filter(m => m.kind === 'linear').map(m => m.end.z)
    expect(lin).toEqual([-2, -6, -10])
    expect(r.moves[r.moves.length - 1].end.z).toBe(2)
  })

  it('G4 P is a dwell in milliseconds', () => {
    const r = interpret(F('G4 P1500'))
    expect(r.moves[0]).toMatchObject({ kind: 'dwell', dwell: 1.5 })
  })
})

describe('Cycle helpers', () => {
  it('planSteps without pecking', () => {
    expect(planSteps({ approach: 2, depth: -5, feedIn: 100, dwellBottom: 0, out: { kind: 'rapid' }, retract: 10 }))
      .toEqual([{ kind: 'rapid', w: 2 }, { kind: 'linear', w: -5, feed: 100 }, { kind: 'rapid', w: 10 }])
  })

  it('HOLES2 with INDA=0 spreads holes evenly', () => {
    expect(holePattern('HOLES2', [0, 0, 10, 90, 0, 2]).points.map(p => p.map(v => +v.toFixed(6) + 0))).toEqual([[0, 10], [0, -10]])
  })

  it('unknown cycle names are not expanded', () => {
    expect(expandSinumerikCycle('CYCLE99', [], { feed: 100, spindle: 0, w: 0 })).toBeNull()
  })

  void kinds
})

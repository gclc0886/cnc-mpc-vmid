import { describe, it, expect } from 'vitest'
import { lexLine, detectDialect } from '../gcode/Lexer'
import { evaluate } from '../gcode/Expression'
import { interpret } from '../gcode/Interpreter'
import { parseProgram } from '../GCodeParser'
import type { SimPoint } from '../GCodeParser'

const moves = (src: string, opts = {}) => interpret(src, opts).moves
const last = <T>(a: T[]) => a[a.length - 1]
const errors = (src: string) => interpret(src).diagnostics.filter(d => d.severity === 'error')
const warnings = (src: string) => interpret(src).diagnostics.filter(d => d.severity === 'warning')
/** Sample at the middle of a block's samples. */
function midOf(points: SimPoint[], blockIndex: number): SimPoint {
  const pts = points.filter(p => p.blockIndex === blockIndex)
  return pts[Math.floor(pts.length / 2) - 1]
}

describe('Lexer', () => {
  it('splits words written without spaces (postprocessor output)', () => {
    const b = lexLine('N150 G42G1 X21.124 F800', 1)!
    expect(b.blockNumber).toBe(150)
    expect(b.words.map(w => w.text)).toEqual(['G42', 'G1', 'X21.124', 'F800'])
  })

  it('reads MCALL with a cycle call that has a space before "(" and empty arguments', () => {
    const b = lexLine('N140 MCALL CYCLE83 (50,9,41.164,300,,5,,5,,,1,1)', 1)!
    expect(b.words[0]).toMatchObject({ kind: 'keyword', name: 'MCALL' })
    expect(b.words[1]).toMatchObject({ kind: 'call', name: 'CYCLE83' })
    const args = (b.words[1] as { args: string[] }).args
    expect(args).toHaveLength(12)
    expect(args[4]).toBe('')
  })

  it('reads string tool names, headers, comments and block skip', () => {
    expect(lexLine('N30 T="INSTRUMENT_2"', 1)!.words[0]).toMatchObject({ kind: 'string', letter: 'T', value: 'INSTRUMENT_2' })
    expect(lexLine('%_N_4XX_MPF', 1)!.words).toEqual([])
    const c = lexLine('G0 X1 ; rapid; to start', 1)!
    expect(c.comment).toBe('rapid; to start')
    expect(c.words).toHaveLength(2)
    expect(lexLine('/N10 G0 X1', 1)!.skippable).toBe(true)
  })

  it('reads extended addresses, positioning modes and assignments', () => {
    const w = lexLine('G1 X=IC(5) A=DC(90) CR=R1*2 R2=R1+1', 1)!.words
    expect(w[1]).toMatchObject({ kind: 'addr', letter: 'X', mode: 'IC', value: 5 })
    expect(w[2]).toMatchObject({ kind: 'addr', letter: 'A', mode: 'DC', value: 90 })
    expect(w[3]).toMatchObject({ kind: 'addr', letter: 'CR', value: null, expr: 'R1*2' })
    expect(w[4]).toMatchObject({ kind: 'assign', name: 'R2', expr: 'R1+1' })
  })

  it('treats "(…)" as a comment in Fanuc and as a comment line in Sinumerik', () => {
    expect(lexLine('G0 (move) X1', 1, 'fanuc')!.words.map(w => w.text)).toEqual(['G0', 'X1'])
    expect(lexLine('(SETUP SHEET)', 1)!.words).toEqual([])
  })
})

describe('Dialect detection', () => {
  it('recognises Sinumerik postprocessor output and Fanuc programs', () => {
    expect(detectDialect('%_N_4XX_MPF\nN10 G90 G54\nN30 T="INSTRUMENT_2"\nG2 X1 Y1 CR=5')).toBe('sinumerik')
    expect(detectDialect('%\nO1 (5AXIS)\nG17\n(--- Init ---)\nG0 G40 G49 G80 G21\nG3 X1 Y1 R4.')).toBe('fanuc')
    expect(detectDialect('G0 X0 Y0\nG1 X10 F100')).toBe('sinumerik')
  })

  it('Fanuc R is an arc radius, Sinumerik needs CR=', () => {
    const r = interpret('O1 (TEST)\nG0 X0 Y0\nG2 X20 Y0 R10. F100')
    expect(r.dialect).toBe('fanuc')
    expect(r.moves[1].arc!.radius).toBeCloseTo(10, 9)
  })
})

describe('Expression', () => {
  it('evaluates arithmetic, functions in degrees and R-parameters', () => {
    expect(evaluate('2+3*4')).toBe(14)
    expect(evaluate('-(2+3)/5')).toBe(-1)
    expect(evaluate('SIN(30)')).toBeCloseTo(0.5, 12)
    expect(evaluate('R1*2+R2', n => ({ R1: 5, R2: 1 } as Record<string, number>)[n])).toBe(11)
    expect(evaluate('7 MOD 3')).toBe(1)
    expect(() => evaluate('FOO+1')).toThrow(/Unknown variable FOO/)
  })
})

describe('Interpreter — regressions B2–B6', () => {
  it('B2: an M-code in a motion block does not drop the motion', () => {
    const m = moves('G1 X10 F100 M8')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ kind: 'linear', end: { x: 10 } })
  })

  it('B3: several G-codes per block; non-motion G does not change the motion mode', () => {
    expect(moves('G0 G90 X10')[0].kind).toBe('rapid')
    const m = moves('G1 X5 F100\nG54\nX10')
    expect(m.map(x => x.kind)).toEqual(['linear', 'linear'])
    expect(m[1].workOffset).toBe('G54')
  })

  it('B4: a pure rotary move is interpolated in angular steps and timed in deg/min', () => {
    const r = parseProgram('G1 A90 F1000')
    expect(r.points).toHaveLength(90)
    expect(r.points[44].a).toBeCloseTo(45, 9)
    expect(r.duration).toBeCloseTo(90 / 1000 * 60, 9)
  })

  it('B5: G91 incremental and IC/AC per word', () => {
    expect(last(moves('G91 G1 X10 F100\nX10 Y5')).end).toMatchObject({ x: 20, y: 5 })
    expect(last(moves('G90 G1 X10 F100\nX=IC(5) Y=AC(3)')).end).toMatchObject({ x: 15, y: 3 })
    expect(last(moves('G91 G1 X10 F100\nG90 X1')).end.x).toBe(1)
  })

  it('B6: expressions and R-parameters; frame statements do not move', () => {
    expect(last(moves('R1=10\nG1 X=R1+5 F100')).end.x).toBe(15)
    const m = moves('G0 X1\nTRANS X10 Y20\nG0 X2')
    expect(m.map(x => x.end.x)).toEqual([1, 2]) // program coordinates unchanged; the frame acts on machine values
  })
})

describe('Interpreter — arcs', () => {
  it('G17 G2 quarter with IJK goes clockwise viewed from +Z', () => {
    const r = parseProgram('G0 X10 Y0\nG17 G2 X0 Y-10 I-10 J0 F100')
    const mid = midOf(r.points, 1)
    expect(mid.x).toBeGreaterThan(5)
    expect(mid.y).toBeLessThan(-5)
    expect(r.moves[1].arc!.sweep).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('G18 G2 goes clockwise viewed from +Y (plane Z–X, regression: was mirrored)', () => {
    const r = parseProgram('G0 X0 Z10\nG18 G2 X0 Z-10 K-10 F100')
    const pts = r.points.filter(p => p.blockIndex === 1)
    const mid = pts[Math.floor(pts.length / 2) - 1]
    expect(mid.x).toBeCloseTo(-10, 1)
    expect(Math.abs(mid.z)).toBeLessThan(0.5)
  })

  it('G19 G3 quarter goes counter-clockwise viewed from +X', () => {
    const m = moves('G0 Y10 Z0\nG19 G3 Y0 Z10 J-10 F100')
    expect(m[1].arc!.sweep).toBeCloseTo(Math.PI / 2, 9)
  })

  it('CR= half circle and minor/major arcs by sign', () => {
    const r = parseProgram('G0 X0 Y0\nG2 X20 Y0 CR=10 F100')
    expect(midOf(r.points, 1).y).toBeCloseTo(10, 1)
    expect(Math.abs(moves('G2 X10 Y10 CR=10 F100')[0].arc!.sweep)).toBeCloseTo(Math.PI / 2, 9)
    expect(Math.abs(moves('G2 X10 Y10 CR=-10 F100')[0].arc!.sweep)).toBeCloseTo(3 * Math.PI / 2, 9)
  })

  it('full circle with centre words only, and a helix with TURN=', () => {
    const full = moves('G0 X10 Y0\nG3 I-10 F100')[1]
    expect(full.arc!.sweep).toBeCloseTo(2 * Math.PI, 9)
    expect(full.end).toMatchObject({ x: 10, y: 0 })
    const helix = moves('G0 X10 Y0 Z0\nG3 X10 Y0 Z-5 I-10 TURN=2 F100')[1]
    expect(helix.arc!.sweep).toBeCloseTo(6 * Math.PI, 9)
    expect(helix.end.z).toBe(-5)
  })

  it('reports an end point off the circle and a radius too small for the chord', () => {
    expect(warnings('G0 X10 Y0\nG2 X0 Y-12 I-10 F100').some(d => /not on the circle/.test(d.message))).toBe(true)
    expect(errors('G0 X0 Y0\nG2 X30 Y0 CR=10 F100').some(d => /smaller than half the chord/.test(d.message))).toBe(true)
  })
})

describe('Interpreter — rotary modulo positioning', () => {
  it.each([
    ['A=DC(10)', 350, 370],
    ['A=DC(350)', 10, -10],
    ['A=ACP(350)', 10, 350],
    ['A=ACN(10)', 350, 10],
    ['A=ACN(20)', 10, -340], // 10 → 20 the negative way round: −350°
  ])('%s from A=%d → %d', (word, start, expected) => {
    expect(last(moves(`G0 ${word}`, { start: { a: start } })).end.a).toBeCloseTo(expected, 9)
  })
})

describe('Interpreter — other modal behaviour', () => {
  it('G4 F is a dwell time and does not change the feed', () => {
    const m = moves('G1 X10 F500\nG4 F2\nG1 X20')
    expect(m[1]).toMatchObject({ kind: 'dwell', dwell: 2 })
    expect(m[2].feed).toBe(500)
  })

  it('stops at M30', () => {
    expect(moves('G0 X1\nM30\nG0 X99')).toHaveLength(1)
  })

  it('reports feed motion without F once', () => {
    expect(errors('G1 X10\nG1 X20').filter(d => /without F/.test(d.message))).toHaveLength(1)
  })

  it('G70 inch and DIAMON diameter programming', () => {
    expect(moves('G70 G1 X1 F10')[0].end.x).toBeCloseTo(25.4, 9)
    expect(moves('DIAMON\nG1 X40 F10')[0].end.x).toBe(20)
  })

  it('flags unsupported features with the phase that adds them', () => {
    const d = interpret('TRACYL(40)\nIF R1>5 GOTOF L1').diagnostics
    expect(d.some(x => /TRACYL.*Mill-Turn/.test(x.message))).toBe(true)
    expect(d.some(x => /IF.*1e/.test(x.message))).toBe(true)
  })

  it('reports repeated diagnostics only a few times plus a summary', () => {
    const d = interpret(Array.from({ length: 10 }, () => 'G1 X1 F1 G41').join('\n')).diagnostics
    expect(d.filter(x => /radius compensation/.test(x.message))).toHaveLength(3)
    expect(d.some(x => /repeated 7 more/.test(x.message))).toBe(true)
  })
})

describe('Interpolator — timing', () => {
  it('G1 uses F mm/min over the linear path', () => {
    expect(parseProgram('G1 X100 F1000').duration).toBeCloseTo(6, 9)
  })

  it('G0 uses the slowest axis rapid rate', () => {
    expect(parseProgram('G0 X100').duration).toBeCloseTo(0.6, 9)
    expect(parseProgram('G0 X100 Y100', { rapid: { X: 5000, Y: 20000 } }).duration).toBeCloseTo(1.2, 9)
  })

  it('G95 feed per revolution and G93 inverse time', () => {
    expect(parseProgram('S1000 G95 G1 X100 F0.1').duration).toBeCloseTo(60, 9)
    expect(parseProgram('G93 G1 X100 F2').duration).toBeCloseTo(30, 9)
  })

  it('linear + rotary: Sinumerik times by the linear path, Fanuc by the combined vector', () => {
    expect(parseProgram('G1 X10 A90 F100').duration).toBeCloseTo(6, 9)
    expect(parseProgram('G1 X10 A90 F100', { dialect: 'fanuc' }).duration).toBeCloseTo(Math.hypot(10, 90) / 100 * 60, 9)
  })

  it('samples carry increasing time and end exactly on the target', () => {
    const r = parseProgram('G0 X10 Y0\nG3 X-10 Y0 CR=10 F100')
    for (let i = 1; i < r.points.length; i++) expect(r.points[i].t).toBeGreaterThanOrEqual(r.points[i - 1].t)
    expect(last(r.points)).toMatchObject({ x: -10, y: 0 })
    expect(last(r.points).t).toBeCloseTo(r.duration, 9)
  })

  it('coarsens the step for very long programs', () => {
    const r = parseProgram('G1 X100000 F1000', { maxSamples: 1000 })
    expect(r.points.length).toBeLessThanOrEqual(1001)
    expect(r.diagnostics.some(d => /coarsened/.test(d.message))).toBe(true)
  })
})

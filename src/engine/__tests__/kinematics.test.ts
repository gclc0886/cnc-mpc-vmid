import { describe, it, expect } from 'vitest'
import { KinematicChain } from '../KinematicChain'
import { buildAxisMapping } from '../AxisMapping'
import { parseProgram } from '../GCodeParser'
import { applyKinematics, KinematicSolver } from '../Kinematics'
import { computePathKinematics, computeAutoWorkOffset } from '../PathKinematics'
import { rotX, apply3 } from '../gcode/MachineMapper'
import { PRESETS } from '../../presets/machinePresets'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** Full machine-dependent pipeline, as the store runs it. */
function simulate(presetKey: string, gcode: string, tools: Record<string, { length: number; radius: number }> = {}) {
  const config = clone(PRESETS[presetKey])
  const mapping = buildAxisMapping(config, new KinematicChain(config), config.combinations[0].id)
  const g54 = computeAutoWorkOffset(config, mapping)
  const res = parseProgram(gcode, { setup: { workOffsets: { G54: g54 }, tools }, initialWorkOffset: 'G54' })
  const kinDiags = applyKinematics(res.points, res.moves, config, mapping)
  const kin = computePathKinematics(config, mapping, res.points)
  const tip = (i: number) => [kin.tcpWork[i * 3], kin.tcpWork[i * 3 + 1], kin.tcpWork[i * 3 + 2]]
  const ofBlock = (line: number) => res.points.map((p, i) => ({ p, i })).filter(({ p }) => res.blocks[p.blockIndex].line === line)
  return { res, kin, tip, ofBlock, diags: [...res.diagnostics, ...kinDiags], config, mapping }
}

function expectNear(a: number[], b: number[], digits = 4) {
  b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, digits))
}

describe('TRAORI (RTCP)', () => {
  it.each(['5x_ac', '5x_bc'])('%s: the tool tip stays on the programmed point while the rotary axes turn', key => {
    const rot = key === '5x_ac' ? 'A30 C45' : 'B30 C45'
    const { ofBlock, tip, res } = simulate(key, `T1\nTRAORI\nG1 X10 Y5 Z20 F500\nG1 ${rot}`, { '1': { length: 100, radius: 5 } })
    const samples = ofBlock(4)
    expect(samples.length).toBeGreaterThan(10)
    for (const { i } of samples) expectNear(tip(i), [10, 5, 20])
    // and both rotaries really moved (programmed letters reach the right physical axes)
    const last = res.points[res.points.length - 1]
    expect(key === '5x_ac' ? last.ma : last.mb).toBeCloseTo(30, 6)
    expect(last.mc).toBeCloseTo(45, 6)
  })

  it('without TRAORI the same rotation drags the tool tip across the part', () => {
    const { ofBlock, tip } = simulate('5x_ac', 'G1 X10 Y5 Z20 F500\nG1 A30 C45')
    const s = ofBlock(2)
    const d = Math.hypot(...tip(s[s.length - 1].i).map((v, k) => v - [10, 5, 20][k]))
    expect(d).toBeGreaterThan(5)
  })

  it('linear moves under TRAORI follow the programmed line on the tilted part', () => {
    const { ofBlock, tip } = simulate('5x_ac', 'TRAORI\nG1 X0 Y0 Z10 A20 C10 F500\nG1 X40 Y-20')
    for (const { p, i } of ofBlock(3)) expectNear(tip(i), [p.x, p.y, p.z])
  })

  it('A3/B3/C3 orientation vector: tool axis on the part follows the vector (head-head)', () => {
    const v = [Math.sin(30 * Math.PI / 180), 0, Math.cos(30 * Math.PI / 180)]
    const { res, tip, config, mapping } = simulate('5x_bc', `T1\nTRAORI\nG1 X0 Y0 Z10 F500\nG1 X5 A3=${v[0]} B3=0 C3=${v[2]}`,
      { '1': { length: 80, radius: 4 } })
    const last = res.points.length - 1
    expectNear(tip(last), [5, 0, 10])
    const s = new KinematicSolver(config, mapping)
    const p = res.points[last]
    expectNear(s.toolAxisRel([p.mx, p.my, p.mz, p.ma, p.mb, p.mc]), v, 6)
  })
})

describe('CYCLE800 (swivel plane)', () => {
  it('4-axis: rotation about X positions A and machines in the tilted plane', () => {
    const { res, tip, ofBlock, diags } = simulate('4x',
      'CYCLE800(0,"TC1",0,57,0,0,0,30,0,0,0,0,0,1)\nG1 X10 Y0 Z0 F500\nG1 X0 Y10 Z0')
    expect(diags.filter(d => d.severity === 'error')).toEqual([])
    const swivel = ofBlock(1)
    expect(swivel[swivel.length - 1].p.ma).toBeCloseTo(30, 6)
    // Points of the tilted plane, seen on the part: R·p
    const R = rotX(30)
    const s2 = ofBlock(2); expectNear(tip(s2[s2.length - 1].i), apply3(R, [10, 0, 0]))
    const s3 = ofBlock(3); expectNear(tip(s3[s3.length - 1].i), apply3(R, [0, 10, 0]))
    // The swivel takes time (rotary rapid) before the cut starts
    expect(s2[0].p.t).toBeGreaterThan(swivel[0].p.t)
    void res
  })

  it('reset with CYCLE800() keeps the rotary axis where it is', () => {
    const { res } = simulate('4x', 'CYCLE800(0,"TC1",0,57,0,0,0,30,0,0,0,0,0,1)\nG1 Z10 F500\nCYCLE800()\nG0 Z50')
    expect(res.points[res.points.length - 1].ma).toBeCloseTo(30, 6)
  })

  it('reports an orientation the machine cannot reach', () => {
    const { diags } = simulate('4x', 'CYCLE800(0,"TC1",0,57,0,0,0,0,30,0,0,0,0,1)\nG1 X10 F500')
    expect(diags.some(d => d.severity === 'error' && /not reachable/.test(d.message))).toBe(true)
  })

  it('_DIR chooses between the two trunnion solutions', () => {
    const plus = simulate('5x_ac', 'CYCLE800(0,"TC1",0,57,0,0,0,30,0,0,0,0,0,1)\nG1 X1 F500').res.points
    const minus = simulate('5x_ac', 'CYCLE800(0,"TC1",0,57,0,0,0,30,0,0,0,0,0,-1)\nG1 X1 F500').res.points
    expect(plus[plus.length - 1].ma).toBeGreaterThan(0)
    expect(minus[minus.length - 1].ma).toBeLessThan(0)
  })

  it('_MODE 39 (Z, X, Y) rotates in that order', () => {
    // Z90 then X30: new Z axis = Rz(90)·Rx(30)·(0,0,1)
    const { config, mapping, res } = simulate('5x_ac', 'CYCLE800(0,"TC1",0,39,0,0,0,90,30,0,0,0,0,1)\nG1 X1 F500')
    const p = res.points[res.points.length - 1]
    const axis = new KinematicSolver(config, mapping).toolAxisRel([p.mx, p.my, p.mz, p.ma, p.mb, p.mc])
    const s = Math.sin(30 * Math.PI / 180), c = Math.cos(30 * Math.PI / 180)
    expectNear(axis, [s, 0, c], 6) // Rz(90)·(0,−s,c) = (s,0,c)
  })
})

describe('continuity across frame changes', () => {
  it('after TRANS the next move starts from the actual position (no jump)', () => {
    const { res } = simulate('3x', 'G1 X0 Y0 Z0 F500\nTRANS X10\nG1 X20')
    let maxStep = 0
    for (let i = 1; i < res.points.length; i++) {
      const a = res.points[i - 1], b = res.points[i]
      maxStep = Math.max(maxStep, Math.hypot(b.mx - a.mx, b.my - a.my, b.mz - a.mz))
    }
    // Without continuity the first sample after TRANS would jump 10 mm. With it the 30 mm of
    // machine travel are spread over the 20 samples of the 20 mm programmed move.
    expect(maxStep).toBeLessThan(2)
    expect(res.points[res.points.length - 1].mx).toBeCloseTo(30, 6)
  })
})

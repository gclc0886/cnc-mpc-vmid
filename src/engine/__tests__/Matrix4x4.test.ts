import { describe, it, expect } from 'vitest'
import { Matrix4x4 } from '../Matrix4x4'

function expectMatrixClose(a: Matrix4x4, b: Matrix4x4, eps = 1e-9) {
  for (let i = 0; i < 16; i++) expect(a.data[i]).toBeCloseTo(b.data[i], -Math.log10(eps))
}

/** Deterministic pseudo-random generator so failures are reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
}

function randomRigid(rnd: () => number): Matrix4x4 {
  const axis = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]
  const angle = (rnd() - 0.5) * 720
  const r = Matrix4x4.rotationAxis(axis[0], axis[1], axis[2], angle)
  const t = Matrix4x4.translation((rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000)
  return t.multiply(r)
}

describe('Matrix4x4.inverse', () => {
  it('inverts a pure Z rotation (regression: rotation block was not transposed)', () => {
    const m = Matrix4x4.translation(10, 20, 30).multiply(Matrix4x4.rotationZ(90))
    expectMatrixClose(m.multiply(m.inverse()), Matrix4x4.identity())
    expectMatrixClose(m.inverse().multiply(m), Matrix4x4.identity())
  })

  it('M · inv(M) = I for random rigid transforms', () => {
    const rnd = lcg(42)
    for (let k = 0; k < 200; k++) {
      const m = randomRigid(rnd)
      expectMatrixClose(m.multiply(m.inverse()), Matrix4x4.identity(), 1e-7)
      expectMatrixClose(m.inverse().multiply(m), Matrix4x4.identity(), 1e-7)
    }
  })

  it('inv(A·B) = inv(B)·inv(A)', () => {
    const rnd = lcg(7)
    const a = randomRigid(rnd), b = randomRigid(rnd)
    expectMatrixClose(a.multiply(b).inverse(), b.inverse().multiply(a.inverse()), 1e-7)
  })

  it('maps a transformed point back to the original', () => {
    const m = Matrix4x4.translation(5, -3, 100).multiply(Matrix4x4.rotationX(30))
    const p = m.transformPoint(1, 2, 3)
    const back = m.inverse().transformPoint(...p)
    expect(back[0]).toBeCloseTo(1, 9)
    expect(back[1]).toBeCloseTo(2, 9)
    expect(back[2]).toBeCloseTo(3, 9)
  })
})

describe('Matrix4x4 rotations', () => {
  it('rotationAxis matches the named rotations', () => {
    expectMatrixClose(Matrix4x4.rotationAxis(1, 0, 0, 37), Matrix4x4.rotationX(37))
    expectMatrixClose(Matrix4x4.rotationAxis(0, 1, 0, -64), Matrix4x4.rotationY(-64))
    expectMatrixClose(Matrix4x4.rotationAxis(0, 0, 5, 123), Matrix4x4.rotationZ(123))
  })

  it('rotationZ(90) turns +X into +Y (right-handed)', () => {
    const p = Matrix4x4.rotationZ(90).transformPoint(1, 0, 0)
    expect(p[0]).toBeCloseTo(0, 12)
    expect(p[1]).toBeCloseTo(1, 12)
  })

  it('toThreeArray is the column-major transpose', () => {
    const m = Matrix4x4.translation(1, 2, 3)
    const a = m.toThreeArray()
    expect([a[12], a[13], a[14]]).toEqual([1, 2, 3])
  })
})

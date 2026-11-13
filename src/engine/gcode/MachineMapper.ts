import type { AxisOffsets, MoveTransform, Plane, Pos6 } from './types'

/**
 * Program (WCS) ↔ machine axis values without a kinematic transformation
 * (no TRAORI): what a Sinumerik does with frames, work offsets and tool length.
 */

export const ZERO_OFFSETS: AxisOffsets = { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }
export const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

const DEG = Math.PI / 180

export function mul3(A: number[], B: number[]): number[] {
  const r = new Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]
  }
  return r
}

export function apply3(R: number[], v: [number, number, number]): [number, number, number] {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ]
}

function transpose3(R: number[]): number[] {
  return [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]
}

export function rotX(deg: number): number[] {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}
export function rotY(deg: number): number[] {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}
export function rotZ(deg: number): number[] {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** Sinumerik ROT X.. Y.. Z.. in RPY mode: rotate about Z, then Y', then X'' → R = Rz·Ry·Rx. */
export function rotRPY(x: number, y: number, z: number): number[] {
  return mul3(rotZ(z), mul3(rotY(y), rotX(x)))
}

/** ROT RPL=…: rotation in the working plane, about its normal axis. */
export function rotInPlane(plane: Plane, deg: number): number[] {
  return plane === 17 ? rotZ(deg) : plane === 18 ? rotY(deg) : rotX(deg)
}

/** Tool length vector added to the machine axes for the working plane (Sinumerik L1). */
export function toolVector(plane: Plane, length: number): [number, number, number] {
  return plane === 17 ? [0, 0, length] : plane === 18 ? [0, length, 0] : [length, 0, 0]
}

export function toMachine(xf: MoveTransform, p: Pos6): Pos6 {
  const [rx, ry, rz] = apply3(xf.R, [p.x, p.y, p.z])
  return {
    x: rx + xf.t[0] + xf.offset.x + xf.toolVec[0],
    y: ry + xf.t[1] + xf.offset.y + xf.toolVec[1],
    z: rz + xf.t[2] + xf.offset.z + xf.toolVec[2],
    a: p.a + xf.rotShift[0] + xf.offset.a,
    b: p.b + xf.rotShift[1] + xf.offset.b,
    c: p.c + xf.rotShift[2] + xf.offset.c,
  }
}

export function fromMachine(xf: MoveTransform, m: Pos6): Pos6 {
  const v: [number, number, number] = [
    m.x - xf.t[0] - xf.offset.x - xf.toolVec[0],
    m.y - xf.t[1] - xf.offset.y - xf.toolVec[1],
    m.z - xf.t[2] - xf.offset.z - xf.toolVec[2],
  ]
  const [x, y, z] = apply3(transpose3(xf.R), v)
  return {
    x, y, z,
    a: m.a - xf.rotShift[0] - xf.offset.a,
    b: m.b - xf.rotShift[1] - xf.offset.b,
    c: m.c - xf.rotShift[2] - xf.offset.c,
  }
}

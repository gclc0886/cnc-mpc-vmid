/**
 * Educational 4x4 homogeneous transformation matrix.
 * Row-major storage for clear math display.
 *
 * Layout:
 * | R00 R01 R02 Tx |
 * | R10 R11 R12 Ty |
 * | R20 R21 R22 Tz |
 * |  0   0   0   1 |
 */
export class Matrix4x4 {
  data: number[]

  constructor(data?: number[]) {
    this.data = data || [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]
  }

  static identity(): Matrix4x4 {
    return new Matrix4x4()
  }

  static translation(x: number, y: number, z: number): Matrix4x4 {
    return new Matrix4x4([
      1, 0, 0, x,
      0, 1, 0, y,
      0, 0, 1, z,
      0, 0, 0, 1,
    ])
  }

  static rotationX(angleDeg: number): Matrix4x4 {
    const r = angleDeg * Math.PI / 180
    const c = Math.cos(r), s = Math.sin(r)
    return new Matrix4x4([
      1, 0, 0, 0,
      0, c, -s, 0,
      0, s, c, 0,
      0, 0, 0, 1,
    ])
  }

  static rotationY(angleDeg: number): Matrix4x4 {
    const r = angleDeg * Math.PI / 180
    const c = Math.cos(r), s = Math.sin(r)
    return new Matrix4x4([
      c, 0, s, 0,
      0, 1, 0, 0,
      -s, 0, c, 0,
      0, 0, 0, 1,
    ])
  }

  static rotationZ(angleDeg: number): Matrix4x4 {
    const r = angleDeg * Math.PI / 180
    const c = Math.cos(r), s = Math.sin(r)
    return new Matrix4x4([
      c, -s, 0, 0,
      s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ])
  }

  /** Rotation around arbitrary axis through origin. */
  static rotationAxis(vx: number, vy: number, vz: number, angleDeg: number): Matrix4x4 {
    const r = angleDeg * Math.PI / 180
    const c = Math.cos(r), s = Math.sin(r), t = 1 - c
    // Normalize
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz)
    if (len < 1e-10) return Matrix4x4.identity()
    const x = vx / len, y = vy / len, z = vz / len
    return new Matrix4x4([
      t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    ])
  }

  /** Get element at row i, column j (0-indexed). */
  get(i: number, j: number): number {
    return this.data[i * 4 + j]
  }

  /** Set element at row i, column j. */
  set(i: number, j: number, val: number) {
    this.data[i * 4 + j] = val
  }

  /** Multiply this * other. */
  multiply(other: Matrix4x4): Matrix4x4 {
    const a = this.data, b = other.data, r = new Array(16)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        r[i * 4 + j] =
          a[i * 4 + 0] * b[0 * 4 + j] +
          a[i * 4 + 1] * b[1 * 4 + j] +
          a[i * 4 + 2] * b[2 * 4 + j] +
          a[i * 4 + 3] * b[3 * 4 + j]
      }
    }
    return new Matrix4x4(r)
  }

  /** Transform a point [x, y, z] → [x', y', z']. */
  transformPoint(x: number, y: number, z: number): [number, number, number] {
    const d = this.data
    return [
      d[0] * x + d[1] * y + d[2] * z + d[3],
      d[4] * x + d[5] * y + d[6] * z + d[7],
      d[8] * x + d[9] * y + d[10] * z + d[11],
    ]
  }

  /** Extract translation. */
  getTranslation(): [number, number, number] {
    return [this.data[3], this.data[7], this.data[11]]
  }

  /** Convert to Three.js column-major array (for Matrix4.fromArray). */
  toThreeArray(): number[] {
    const d = this.data
    // Three.js uses column-major
    return [
      d[0], d[4], d[8], d[12],
      d[1], d[5], d[9], d[13],
      d[2], d[6], d[10], d[14],
      d[3], d[7], d[11], d[15],
    ]
  }

  /** Format as readable 4x4 grid. */
  toString(precision = 4): string {
    const rows: string[] = []
    for (let i = 0; i < 4; i++) {
      const cells = []
      for (let j = 0; j < 4; j++) {
        cells.push(this.get(i, j).toFixed(precision).padStart(10))
      }
      rows.push(`| ${cells.join(' ')} |`)
    }
    return rows.join('\n')
  }

  /**
   * Inverse for rigid-body transforms (rotation + translation).
   * Uses: inv = [R^T | -R^T * t]
   */
  inverse(): Matrix4x4 {
    const d = this.data
    // R^T (transpose of 3x3 rotation submatrix)
    const r00 = d[0], r01 = d[4], r02 = d[8]
    const r10 = d[1], r11 = d[5], r12 = d[9]
    const r20 = d[2], r21 = d[6], r22 = d[10]
    // Translation
    const tx = d[3], ty = d[7], tz = d[11]
    // -R^T * t
    const itx = -(r00 * tx + r01 * ty + r02 * tz)
    const ity = -(r10 * tx + r11 * ty + r12 * tz)
    const itz = -(r20 * tx + r21 * ty + r22 * tz)
    return new Matrix4x4([
      r00, r10, r20, itx,
      r01, r11, r21, ity,
      r02, r12, r22, itz,
      0, 0, 0, 1,
    ])
  }

  clone(): Matrix4x4 {
    return new Matrix4x4([...this.data])
  }
}

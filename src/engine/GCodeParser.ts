/** Parsed G-code block. */
export interface GCodeBlock {
  line: number
  raw: string
  type: 'G0' | 'G1' | 'G2' | 'G3' | 'M' | 'comment' | 'other'
  G?: number
  M?: number
  X?: number
  Y?: number
  Z?: number
  A?: number
  B?: number
  C?: number
  F?: number
  S?: number
  I?: number
  J?: number
  K?: number
  R?: number
  CR?: number
  comment?: string
}

/** Interpolated point for simulation. */
export interface SimPoint {
  x: number
  y: number
  z: number
  a: number
  b: number
  c: number
  feed: number
  rapid: boolean
  blockIndex: number
}

/**
 * Basic G-code parser for CNC simulation.
 * Supports: G0, G1, G2, G3, M codes, comments.
 */
export class GCodeParser {
  blocks: GCodeBlock[] = []

  parse(gcode: string): GCodeBlock[] {
    this.blocks = []
    const lines = gcode.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim()
      if (!raw) continue

      // Comment-only line
      if (raw.startsWith(';') || raw.startsWith('(')) {
        this.blocks.push({
          line: i + 1,
          raw,
          type: 'comment',
          comment: raw,
        })
        continue
      }

      const block = this._parseLine(raw, i + 1)
      this.blocks.push(block)
    }

    return this.blocks
  }

  private _parseLine(raw: string, lineNum: number): GCodeBlock {
    // Strip inline comments
    let line = raw
    let comment: string | undefined
    const commentIdx = line.indexOf(';')
    if (commentIdx >= 0) {
      comment = line.slice(commentIdx)
      line = line.slice(0, commentIdx)
    }

    // Strip N-numbers
    line = line.replace(/^N\d+\s*/i, '')

    const block: GCodeBlock = {
      line: lineNum,
      raw,
      type: 'other',
      comment,
    }

    // Extract CR=value (Sinumerik arc radius format) before single-letter parsing
    const crMatch = line.match(/CR\s*=\s*([+-]?\d*\.?\d+)/i)
    if (crMatch) {
      block.CR = parseFloat(crMatch[1])
      line = line.replace(crMatch[0], '')  // remove so R doesn't pick up the digits
    }

    // Extract word-value pairs
    const words = line.match(/[A-Z][+-]?\d*\.?\d+/gi) || []
    for (const word of words) {
      const letter = word[0].toUpperCase()
      const value = parseFloat(word.slice(1))

      switch (letter) {
        case 'G':
          block.G = value
          if (value === 0) block.type = 'G0'
          else if (value === 1) block.type = 'G1'
          else if (value === 2) block.type = 'G2'
          else if (value === 3) block.type = 'G3'
          break
        case 'M': block.M = value; block.type = 'M'; break
        case 'X': block.X = value; break
        case 'Y': block.Y = value; break
        case 'Z': block.Z = value; break
        case 'A': block.A = value; break
        case 'B': block.B = value; break
        case 'C': block.C = value; break
        case 'F': block.F = value; break
        case 'S': block.S = value; break
        case 'I': block.I = value; break
        case 'J': block.J = value; break
        case 'K': block.K = value; break
        case 'R': block.R = value; break
      }
    }

    return block
  }

  /** Interpolate parsed blocks into discrete simulation points. */
  interpolate(stepSize: number = 1.0): SimPoint[] {
    const points: SimPoint[] = []
    let currentX = 0, currentY = 0, currentZ = 0
    let currentA = 0, currentB = 0, currentC = 0
    let currentFeed = 1000
    let modalG = 0

    for (let bi = 0; bi < this.blocks.length; bi++) {
      const b = this.blocks[bi]
      if (b.type === 'comment' || b.type === 'M') continue

      // Update modal G
      if (b.G !== undefined) modalG = b.G
      if (b.F !== undefined) currentFeed = b.F

      // Skip blocks with no motion data (no coordinates at all)
      const hasCoords = b.X !== undefined || b.Y !== undefined || b.Z !== undefined ||
                        b.A !== undefined || b.B !== undefined || b.C !== undefined
      if (b.type === 'other' && !hasCoords) continue
      // 'other' with coordinates → use modal G (e.g. "X100 Y200" after G1)

      const targetX = b.X ?? currentX
      const targetY = b.Y ?? currentY
      const targetZ = b.Z ?? currentZ
      const targetA = b.A ?? currentA
      const targetB = b.B ?? currentB
      const targetC = b.C ?? currentC

      const isRapid = modalG === 0
      const isArc = modalG === 2 || modalG === 3

      if (isArc) {
        // --- Circular interpolation G2 (CW) / G3 (CCW) ---
        const cw = modalG === 2
        // Support both I/J/K (incremental center) and R (radius) formats
        // Default plane: G17 = XY, G18 = XZ, G19 = YZ
        // For simplicity, detect plane from which coords change + I/J/K presence
        let arcPoints: SimPoint[]

        if (b.R !== undefined || b.CR !== undefined) {
          // R-format or CR= (Sinumerik) arc
          const radius = b.CR ?? b.R!
          arcPoints = this._arcFromR(
            currentX, currentY, currentZ,
            targetX, targetY, targetZ,
            radius, cw, currentA, currentB, currentC,
            targetA, targetB, targetC,
            currentFeed, bi, stepSize,
          )
        } else {
          // I/J/K format (incremental from start point)
          const ci = b.I ?? 0
          const cj = b.J ?? 0
          const ck = b.K ?? 0
          arcPoints = this._arcFromIJK(
            currentX, currentY, currentZ,
            targetX, targetY, targetZ,
            ci, cj, ck, cw,
            currentA, currentB, currentC,
            targetA, targetB, targetC,
            currentFeed, bi, stepSize,
          )
        }
        points.push(...arcPoints)
      } else {
        // --- Linear interpolation G0/G1 ---
        const dx = targetX - currentX
        const dy = targetY - currentY
        const dz = targetZ - currentZ
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (dist < 0.001 && Math.abs(targetA - currentA) < 0.001 &&
            Math.abs(targetB - currentB) < 0.001 && Math.abs(targetC - currentC) < 0.001) {
          // No movement at all — skip duplicate point
        } else if (dist < 0.001) {
          // No linear movement, just rotary
          points.push({
            x: targetX, y: targetY, z: targetZ,
            a: targetA, b: targetB, c: targetC,
            feed: currentFeed, rapid: isRapid, blockIndex: bi,
          })
        } else {
          const steps = Math.max(1, Math.ceil(dist / stepSize))
          for (let s = 1; s <= steps; s++) {
            const t = s / steps
            points.push({
              x: currentX + dx * t,
              y: currentY + dy * t,
              z: currentZ + dz * t,
              a: currentA + (targetA - currentA) * t,
              b: currentB + (targetB - currentB) * t,
              c: currentC + (targetC - currentC) * t,
              feed: currentFeed,
              rapid: isRapid,
              blockIndex: bi,
            })
          }
        }
      }

      currentX = targetX
      currentY = targetY
      currentZ = targetZ
      currentA = targetA
      currentB = targetB
      currentC = targetC
    }

    return points
  }

  /** Arc interpolation from I/J/K (incremental center offsets) */
  private _arcFromIJK(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    ci: number, cj: number, ck: number,
    cw: boolean,
    a0: number, b0: number, c0: number,
    a1: number, b1: number, c1: number,
    feed: number, blockIndex: number, stepSize: number,
  ): SimPoint[] {
    // Determine arc plane from I/J/K usage
    // G17 (XY): I,J used → center = (x0+I, y0+J)
    // G18 (XZ): I,K used → center = (x0+I, z0+K)
    // G19 (YZ): J,K used → center = (y0+J, z0+K)
    // Default to XY plane (G17)
    const hasI = ci !== 0
    const hasJ = cj !== 0
    const hasK = ck !== 0

    if (hasK && !hasJ) {
      // G18: XZ plane
      return this._interpolateArc(
        x0, z0, y0, x1, z1, y1,
        x0 + ci, z0 + ck,
        cw, 'xz',
        a0, b0, c0, a1, b1, c1,
        feed, blockIndex, stepSize,
      )
    } else if (hasJ && hasK && !hasI) {
      // G19: YZ plane
      return this._interpolateArc(
        y0, z0, x0, y1, z1, x1,
        y0 + cj, z0 + ck,
        cw, 'yz',
        a0, b0, c0, a1, b1, c1,
        feed, blockIndex, stepSize,
      )
    } else {
      // G17: XY plane (default)
      return this._interpolateArc(
        x0, y0, z0, x1, y1, z1,
        x0 + ci, y0 + cj,
        cw, 'xy',
        a0, b0, c0, a1, b1, c1,
        feed, blockIndex, stepSize,
      )
    }
  }

  /** Arc interpolation from R (radius) format */
  private _arcFromR(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    R: number, cw: boolean,
    a0: number, b0: number, c0: number,
    a1: number, b1: number, c1: number,
    feed: number, blockIndex: number, stepSize: number,
  ): SimPoint[] {
    // XY plane assumed for R-format
    const dx = x1 - x0
    const dy = y1 - y0
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d < 0.0001) {
      return [{ x: x1, y: y1, z: z1, a: a1, b: b1, c: c1, feed, rapid: false, blockIndex }]
    }

    const absR = Math.abs(R)
    let h = Math.sqrt(Math.max(0, absR * absR - (d / 2) * (d / 2)))

    // R > 0 → minor arc, R < 0 → major arc
    // CW + R>0: center to the right; CCW + R>0: center to the left
    const sign = ((cw && R > 0) || (!cw && R < 0)) ? -1 : 1
    if (R < 0) h = -h

    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    const cx = mx + sign * h * (-dy / d)
    const cy = my + sign * h * (dx / d)

    return this._interpolateArc(
      x0, y0, z0, x1, y1, z1,
      cx, cy,
      cw, 'xy',
      a0, b0, c0, a1, b1, c1,
      feed, blockIndex, stepSize,
    )
  }

  /** Core arc interpolation given center point and plane */
  private _interpolateArc(
    u0: number, v0: number, w0: number,  // start (in-plane u,v + helical w)
    u1: number, v1: number, w1: number,  // end
    cu: number, cv: number,               // center in-plane
    cw: boolean, plane: 'xy' | 'xz' | 'yz',
    a0: number, b0: number, c0: number,
    a1: number, b1: number, c1: number,
    feed: number, blockIndex: number, stepSize: number,
  ): SimPoint[] {
    const points: SimPoint[] = []

    let startAngle = Math.atan2(v0 - cv, u0 - cu)
    let endAngle = Math.atan2(v1 - cv, u1 - cu)
    const radius = Math.sqrt((u0 - cu) ** 2 + (v0 - cv) ** 2)

    // Calculate sweep angle
    let sweep: number
    if (cw) {
      // Clockwise: negative sweep
      sweep = endAngle - startAngle
      if (sweep >= 0) sweep -= 2 * Math.PI
    } else {
      // Counter-clockwise: positive sweep
      sweep = endAngle - startAngle
      if (sweep <= 0) sweep += 2 * Math.PI
    }

    // Full circle detection (start ≈ end)
    const du = u1 - u0
    const dv = v1 - v0
    if (Math.sqrt(du * du + dv * dv) < 0.001) {
      sweep = cw ? -2 * Math.PI : 2 * Math.PI
    }

    const arcLen = Math.abs(sweep) * radius
    const steps = Math.max(4, Math.ceil(arcLen / stepSize))

    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const angle = startAngle + sweep * t
      const u = cu + radius * Math.cos(angle)
      const v = cv + radius * Math.sin(angle)
      const w = w0 + (w1 - w0) * t  // helical interpolation

      let x: number, y: number, z: number
      if (plane === 'xy') { x = u; y = v; z = w }
      else if (plane === 'xz') { x = u; y = w; z = v }
      else { x = w; y = u; z = v }  // yz

      points.push({
        x, y, z,
        a: a0 + (a1 - a0) * t,
        b: b0 + (b1 - b0) * t,
        c: c0 + (c1 - c0) * t,
        feed, rapid: false, blockIndex,
      })
    }

    return points
  }
}

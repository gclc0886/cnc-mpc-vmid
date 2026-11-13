/**
 * Drilling / tapping / boring cycles expanded into simple moves along the tool axis.
 * Values are tool-axis coordinates (Z in G17) in program coordinates; the hole position
 * in the plane is wherever the tool is when the cycle runs.
 *
 * Sinumerik 840D parameter order (checked against SolidCAM output, see the
 * solidcam-postprocessor skill):
 *   CYCLE81(RTP, RFP, SDIS, DP, DPR)
 *   CYCLE82(RTP, RFP, SDIS, DP, DPR, DTB)
 *   CYCLE83(RTP, RFP, SDIS, DP, DPR, FDEP, FDPR, DAM, DTB, DTS, FRF, VARI, _AXN, _MDEP, _VRT, _DTD, _DIS1)
 *   CYCLE84(RTP, RFP, SDIS, DP, DPR, DTB, SDAC, MPIT, PIT, POSS, SST, SST1, …)
 *   CYCLE840(RTP, RFP, SDIS, DP, DPR, DTB, SDR, SDAC, ENC, MPIT, PIT, …)
 *   CYCLE85(RTP, RFP, SDIS, DP, DPR, DTB, FFR, RFF)
 *   CYCLE86(RTP, RFP, SDIS, DP, DPR, DTB, SDIR, RPA, RPO, RPAP, POSS)
 *   CYCLE87/88(RTP, RFP, SDIS, DP, DPR[, DTB], SDIR) · CYCLE89(RTP, RFP, SDIS, DP, DPR, DTB)
 */

export type CycleStep =
  | { kind: 'rapid'; w: number }
  | { kind: 'linear'; w: number; feed: number }
  | { kind: 'dwell'; seconds: number }

export interface CycleIssue { severity: 'error' | 'warning' | 'info'; message: string }

export interface CycleContext {
  /** Current feed (mm/min) and spindle speed (rpm). */
  feed: number
  spindle: number
  /** Current tool-axis coordinate. */
  w: number
}

export interface CycleResult { steps: CycleStep[]; issues: CycleIssue[] }

/** Metric coarse thread pitches (MPIT = nominal size). */
const METRIC_PITCH: Record<number, number> = {
  3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 18: 2.5, 20: 2.5, 22: 2.5,
  24: 3, 27: 3, 30: 3.5, 33: 3.5, 36: 4, 39: 4, 42: 4.5, 45: 4.5, 48: 5,
}

export const SINUMERIK_CYCLES = new Set(['CYCLE81', 'CYCLE82', 'CYCLE83', 'CYCLE84', 'CYCLE840', 'CYCLE85', 'CYCLE86', 'CYCLE87', 'CYCLE88', 'CYCLE89'])

/** Plan of one hole: approach, infeed (with optional pecking), dwell, way out. */
interface DrillPlan {
  /** Rapid to this level first (reference plane + safety distance / Fanuc R plane). */
  approach: number
  depth: number
  feedIn: number
  peck?: {
    /** Absolute first depth. */
    first: number
    /** First infeed (from the reference plane), seed for `next`. */
    firstInfeed: number
    /** Next infeed from the previous one. */
    next: (prevInfeed: number) => number
    mode: 'removal' | 'break'
    /** Chip breaking: rapid back by this amount. Chip removal: rapid back down to this far above the last depth. */
    back: number
    /** Chip removal: rapid up to this level after each infeed. */
    clear: number
    /** Feed factor for the first infeed. */
    firstFactor: number
    dwellAtDepth: number
    dwellAtTop: number
  }
  dwellBottom: number
  /** Way out from the bottom. */
  out: { kind: 'rapid' } | { kind: 'feed'; feed: number; to: number }
  /** Final rapid level. */
  retract: number
}

export function planSteps(p: DrillPlan): CycleStep[] {
  const s: CycleStep[] = [{ kind: 'rapid', w: p.approach }]
  if (p.peck && p.peck.first > p.depth) {
    const pk = p.peck
    let target = pk.first
    let infeed = pk.firstInfeed
    s.push({ kind: 'linear', w: target, feed: p.feedIn * pk.firstFactor })
    for (let guard = 0; target > p.depth + 1e-9 && guard < 10000; guard++) {
      const reached = target
      if (pk.mode === 'removal') {
        if (pk.dwellAtDepth > 0) s.push({ kind: 'dwell', seconds: pk.dwellAtDepth })
        s.push({ kind: 'rapid', w: pk.clear })
        if (pk.dwellAtTop > 0) s.push({ kind: 'dwell', seconds: pk.dwellAtTop })
        s.push({ kind: 'rapid', w: reached + pk.back })
      } else {
        s.push({ kind: 'rapid', w: reached + pk.back })
      }
      infeed = Math.max(pk.next(infeed), 1e-3)
      target = Math.max(p.depth, reached - infeed)
      s.push({ kind: 'linear', w: target, feed: p.feedIn })
    }
  } else {
    s.push({ kind: 'linear', w: p.depth, feed: p.feedIn })
  }
  if (p.dwellBottom > 0) s.push({ kind: 'dwell', seconds: p.dwellBottom })
  if (p.out.kind === 'feed') s.push({ kind: 'linear', w: p.out.to, feed: p.out.feed })
  s.push({ kind: 'rapid', w: p.retract })
  return s
}

/** Dwell: seconds, or (negative) spindle revolutions. */
function dwellSeconds(v: number | undefined, spindle: number): number {
  if (!v) return 0
  if (v > 0) return v
  return spindle > 0 ? (-v / spindle) * 60 : 0
}

/** Chip-removal anticipation distance used when the cycle doesn't give one (approximation of the 840D rule). */
function autoAnticipation(depthFromRfp: number): number {
  return depthFromRfp <= 30 ? 0.6 : Math.min(7, depthFromRfp / 50)
}

/**
 * Expand a Sinumerik CYCLE8x call. `a` are the evaluated arguments (undefined = empty).
 * Returns null for an unknown name.
 */
export function expandSinumerikCycle(name: string, a: (number | undefined)[], ctx: CycleContext): CycleResult | null {
  if (!SINUMERIK_CYCLES.has(name)) return null
  const issues: CycleIssue[] = []
  const rtp = a[0]
  const rfp = a[1] ?? 0
  const sdis = Math.abs(a[2] ?? 0)
  const dpr = a[4]
  const depth = dpr ? rfp - Math.abs(dpr) : a[3]
  if (rtp === undefined) {
    issues.push({ severity: 'error', message: `${name}: retraction plane RTP (1st parameter) is missing` })
    return { steps: [], issues }
  }
  if (depth === undefined) {
    issues.push({ severity: 'error', message: `${name}: final depth DP/DPR (4th/5th parameter) is missing` })
    return { steps: [], issues }
  }
  if (depth >= rfp) {
    issues.push({
      severity: 'error',
      message: `${name}: final depth ${fmt(depth)} is not below the reference plane RFP ${fmt(rfp)} — check the parameter order (840D: RTP, RFP, SDIS, DP, DPR, …)`,
    })
    return { steps: [], issues }
  }
  const safety = rfp + sdis
  if (rtp < safety - 1e-9) {
    issues.push({ severity: 'warning', message: `${name}: retraction plane RTP ${fmt(rtp)} is below the safety plane RFP+SDIS ${fmt(safety)}` })
  }
  const F = ctx.feed > 0 ? ctx.feed : 100
  const base = { approach: safety, depth, feedIn: F, retract: rtp }

  switch (name) {
    case 'CYCLE81':
      return { steps: planSteps({ ...base, dwellBottom: 0, out: { kind: 'rapid' } }), issues }
    case 'CYCLE82':
      return { steps: planSteps({ ...base, dwellBottom: dwellSeconds(a[5], ctx.spindle), out: { kind: 'rapid' } }), issues }
    case 'CYCLE83': {
      const fdep = a[5], fdpr = a[6], dam = a[7] ?? 0
      const dtb = dwellSeconds(a[8], ctx.spindle)
      const dts = dwellSeconds(a[9], ctx.spindle)
      const frf = a[10] && a[10] > 0 && a[10] <= 1 ? a[10] : 1
      const vari = a[11] ?? 0
      const mdep = a[13]
      const vrt = a[14]
      const dis1 = a[16]
      let first = fdpr ? rfp - Math.abs(fdpr) : fdep !== undefined ? fdep : depth
      if (first < depth) first = depth
      const minInfeed = mdep && mdep > 0 ? mdep : dam > 0 ? dam : 0
      const next = (prev: number) => {
        const n = dam > 0 ? prev - dam : dam < 0 ? prev * (1 + dam / 100) : prev
        return Math.max(n, minInfeed, 1e-3)
      }
      const removal = vari === 1
      const antic = dis1 && dis1 > 0 ? dis1 : autoAnticipation(rfp - depth)
      if (!removal && vari !== 0) issues.push({ severity: 'warning', message: `CYCLE83: VARI=${vari} is not 0 (chip breaking) or 1 (chip removal) — chip breaking used` })
      return {
        steps: planSteps({
          ...base,
          peck: {
            first, firstInfeed: rfp - first, next, mode: removal ? 'removal' : 'break',
            back: removal ? antic : (vrt && vrt > 0 ? vrt : 1),
            clear: safety, firstFactor: frf, dwellAtDepth: dtb, dwellAtTop: removal ? dts : 0,
          },
          dwellBottom: dtb, out: { kind: 'rapid' },
        }),
        issues,
      }
    }
    case 'CYCLE84':
    case 'CYCLE840': {
      const dtb = dwellSeconds(a[5], ctx.spindle)
      const mpit = name === 'CYCLE84' ? a[7] : a[9]
      const pit = name === 'CYCLE84' ? a[8] : a[10]
      let pitch = pit ? Math.abs(pit) : mpit ? METRIC_PITCH[Math.abs(Math.round(mpit))] : undefined
      if (mpit && !pit && pitch === undefined) issues.push({ severity: 'warning', message: `${name}: MPIT=${mpit} is not a metric coarse thread size` })
      let down = F, up = F
      if (pitch && name === 'CYCLE84') {
        const sst = a[10] || ctx.spindle
        const sst1 = a[11] || sst
        if (!sst) issues.push({ severity: 'warning', message: 'CYCLE84: no tapping speed (SST) and no spindle speed S — feed F used' })
        else { down = sst * pitch; up = sst1 * pitch }
      } else if (pitch && ctx.spindle > 0) {
        down = up = ctx.spindle * pitch
      }
      if (!pitch) pitch = undefined
      return {
        steps: planSteps({ ...base, feedIn: down, dwellBottom: dtb, out: { kind: 'feed', feed: up, to: safety } }),
        issues,
      }
    }
    case 'CYCLE85':
      return {
        steps: planSteps({
          ...base, feedIn: a[6] || F, dwellBottom: dwellSeconds(a[5], ctx.spindle),
          out: { kind: 'feed', feed: a[7] || F, to: safety },
        }),
        issues,
      }
    case 'CYCLE86':
      issues.push({ severity: 'info', message: 'CYCLE86: oriented spindle stop and lift-off are not simulated — the tool retracts straight up' })
      return { steps: planSteps({ ...base, dwellBottom: dwellSeconds(a[5], ctx.spindle), out: { kind: 'rapid' } }), issues }
    case 'CYCLE87':
    case 'CYCLE88':
      issues.push({ severity: 'info', message: `${name}: spindle stop / M0 at the bottom is not simulated — the tool retracts straight up` })
      return { steps: planSteps({ ...base, dwellBottom: name === 'CYCLE88' ? dwellSeconds(a[5], ctx.spindle) : 0, out: { kind: 'rapid' } }), issues }
    case 'CYCLE89':
      return {
        steps: planSteps({ ...base, dwellBottom: dwellSeconds(a[5], ctx.spindle), out: { kind: 'feed', feed: F, to: safety } }),
        issues,
      }
  }
  return null
}

// ─── Hole patterns ───────────────────────────────────────────────────────────

/**
 * HOLES1(SPCA, SPCO, STA1, FDIS, DBH, NUM): row of holes from reference point (SPCA, SPCO),
 * angle STA1 to the abscissa, first hole at FDIS, spacing DBH.
 * HOLES2(CPA, CPO, RAD, STA1, INDA, NUM): circle around (CPA, CPO), radius RAD, start angle
 * STA1, increment INDA (0 → evenly spaced over 360°).
 * Returns (abscissa, ordinate) pairs in the working plane.
 */
export function holePattern(name: string, a: (number | undefined)[]): { points: [number, number][]; issues: CycleIssue[] } {
  const issues: CycleIssue[] = []
  const v = (i: number) => a[i] ?? 0
  const num = Math.round(v(5))
  if (num < 1) {
    issues.push({ severity: 'error', message: `${name}: NUM (6th parameter) must be at least 1` })
    return { points: [], issues }
  }
  const pts: [number, number][] = []
  const D = Math.PI / 180
  if (name === 'HOLES1') {
    const ang = v(2) * D
    for (let k = 0; k < num; k++) {
      const d = v(3) + k * v(4)
      pts.push([v(0) + d * Math.cos(ang), v(1) + d * Math.sin(ang)])
    }
  } else {
    const inda = v(4) || 360 / num
    for (let k = 0; k < num; k++) {
      const ang = (v(3) + k * inda) * D
      pts.push([v(0) + v(2) * Math.cos(ang), v(1) + v(2) * Math.sin(ang)])
    }
  }
  return { points: pts, issues }
}

// ─── Fanuc canned cycles ─────────────────────────────────────────────────────

export interface FanucCycleArgs {
  code: number
  /** R plane and final depth (absolute tool-axis coordinates). */
  r: number
  z: number
  /** Initial level (G98 return). */
  initial: number
  returnToR: boolean
  q?: number
  /** P dwell in milliseconds. */
  p?: number
  feed: number
  spindle: number
}

export function expandFanucCycle(c: FanucCycleArgs): CycleResult {
  const issues: CycleIssue[] = []
  if (c.z >= c.r) {
    issues.push({ severity: 'error', message: `G${c.code}: depth Z ${fmt(c.z)} is not below the R plane ${fmt(c.r)}` })
    return { steps: [], issues }
  }
  const back = c.returnToR ? c.r : c.initial
  const base = { approach: c.r, depth: c.z, feedIn: c.feed > 0 ? c.feed : 100, retract: back }
  const dwell = c.p ? c.p / 1000 : 0
  switch (c.code) {
    case 81: return { steps: planSteps({ ...base, dwellBottom: 0, out: { kind: 'rapid' } }), issues }
    case 82: return { steps: planSteps({ ...base, dwellBottom: dwell, out: { kind: 'rapid' } }), issues }
    case 73:
    case 83: {
      const q = Math.abs(c.q ?? 0)
      if (!q) issues.push({ severity: 'warning', message: `G${c.code} without Q (peck depth) — drilled in one pass` })
      return {
        steps: planSteps({
          ...base,
          peck: q ? {
            first: Math.max(c.z, c.r - q), firstInfeed: q, next: () => q, mode: c.code === 83 ? 'removal' : 'break',
            back: 1, clear: c.r, firstFactor: 1, dwellAtDepth: 0, dwellAtTop: 0,
          } : undefined,
          dwellBottom: 0, out: { kind: 'rapid' },
        }),
        issues,
      }
    }
    case 84: return { steps: planSteps({ ...base, dwellBottom: dwell, out: { kind: 'feed', feed: base.feedIn, to: c.r } }), issues }
    case 85: return { steps: planSteps({ ...base, dwellBottom: 0, out: { kind: 'feed', feed: base.feedIn, to: c.r } }), issues }
    case 86: return { steps: planSteps({ ...base, dwellBottom: 0, out: { kind: 'rapid' } }), issues }
    case 89: return { steps: planSteps({ ...base, dwellBottom: dwell, out: { kind: 'feed', feed: base.feedIn, to: c.r } }), issues }
  }
  issues.push({ severity: 'warning', message: `G${c.code} canned cycle is not supported — ignored` })
  return { steps: [], issues }
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

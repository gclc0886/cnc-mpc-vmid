import { lexProgram, detectDialect } from './Lexer'
import { evaluate, ExpressionError } from './Expression'
import type {
  Diagnostic, Dialect, FeedMode, LexedBlock, Plane, Pos6, PosMode, ProgramMove, Severity, Word,
} from './types'

/**
 * Executes lexed blocks with Sinumerik modal semantics and produces programmed
 * moves in program (workpiece) coordinates. Work offsets, tool length and
 * kinematic transformations are applied later (MachineMapper, phases 1b/1c).
 */

export type AxisLetter = 'X' | 'Y' | 'Z' | 'A' | 'B' | 'C'
const LINEAR: AxisLetter[] = ['X', 'Y', 'Z']
const ROTARY: AxisLetter[] = ['A', 'B', 'C']
const AXES: AxisLetter[] = [...LINEAR, ...ROTARY]
const KEY: Record<AxisLetter, keyof Pos6> = { X: 'x', Y: 'y', Z: 'z', A: 'a', B: 'b', C: 'c' }

export interface InterpretOptions {
  /** Controller dialect; 'auto' (default) guesses from the program text. */
  dialect?: Dialect | 'auto'
  /** Position before the first block (default all zero). */
  start?: Partial<Pos6>
  /** Initial motion mode (default G0). */
  initialMotion?: 0 | 1
}

export interface InterpretResult {
  blocks: LexedBlock[]
  moves: ProgramMove[]
  diagnostics: Diagnostic[]
  /** Programmed axis letters → first source line using them. */
  usedAxes: Partial<Record<AxisLetter, number>>
  /** Program end (M2/M30) was reached. */
  ended: boolean
  /** Dialect actually used (resolved when 'auto'). */
  dialect: Dialect
}

/** Sinumerik G-codes accepted without any effect on the simulated path. */
const IGNORED_G = new Set([
  9, 60, 64, 601, 602, 603, 641, 642, 643, 644, 645, // exact stop / continuous path
  25, 26, 96, 97, 961, 971, // spindle limits, constant cutting speed
  40, 450, 451, // compensation off, corner behaviour
  140, 141, 142, 143, 147, 148, 247, 248, 340, 341, 347, 348, // approach/retract
  500, 507, 931, 942, 952, 962, 972, 973,
])

/** Fanuc G-codes accepted without effect: cancels, return-point modes, polar/scaling off, etc. */
const IGNORED_G_FANUC = new Set([40, 49, 80, 98, 99, 15, 50, 67, 69, 64, 61, 8, 5.1])

/** Fanuc codes recognised but not simulated yet. */
const LATER_G_FANUC: Record<number, string> = {
  43: '1b (tool length)', 44: '1b (tool length)', 68: '1b (coordinate rotation)', 51: '1b (scaling)',
  28: '1b (reference return)', 30: '1b (reference return)', 81: '1d (drilling cycles)', 82: '1d (drilling cycles)',
  83: '1d (drilling cycles)', 84: '1d (drilling cycles)', 85: '1d (drilling cycles)', 86: '1d (drilling cycles)',
  73: '1d (drilling cycles)', 76: '1d (drilling cycles)', 16: '1b (polar coordinates)',
}

/** Keywords accepted silently (motion smoothing, look-ahead, etc.). */
const IGNORED_KEYWORDS = new Set([
  'SOFT', 'BRISK', 'DRIVE', 'FFWON', 'FFWOF', 'CFC', 'CFTCP', 'CFIN', 'COMPCAD', 'COMPCURV', 'COMPOF', 'COMPON',
  'STOPRE', 'FNORM', 'FLIN', 'FCUB', 'UPATH', 'SPATH', 'ORIWKS', 'ORIMKS', 'ORIAXES', 'ORIVECT', 'ORIEULER', 'ORIRPY',
  'CUT2D', 'CUT2DF', 'CUT3DC', 'CUT3DF', 'NORM', 'KONT', 'DISKUL', 'G_GROUP',
  'TRAFOOF', 'DIAMCYCOF', 'SPOS', 'SPOSA',
])

/** Frame statements: their axis words are frame parameters, not motion. */
const FRAME_KEYWORDS = new Set(['TRANS', 'ATRANS', 'ROT', 'AROT', 'SCALE', 'ASCALE', 'MIRROR', 'AMIRROR'])

/** Program-flow / declaration keywords: the block is not executed as motion until phase 1e. */
const FLOW_KEYWORDS = new Set([
  'IF', 'ELSE', 'ENDIF', 'GOTO', 'GOTOF', 'GOTOB', 'GOTOC', 'WHILE', 'ENDWHILE', 'FOR', 'ENDFOR',
  'LOOP', 'ENDLOOP', 'REPEAT', 'UNTIL', 'DEF', 'CALL',
])

/** Features recognised but not simulated yet → warning naming the phase that adds them. */
const LATER: Record<string, string> = {
  TRANS: '1b (frames)', ATRANS: '1b (frames)', ROT: '1b (frames)', AROT: '1b (frames)',
  SCALE: '1b (frames)', ASCALE: '1b (frames)', MIRROR: '1b (frames)', AMIRROR: '1b (frames)',
  TRAORI: '1c (TRAORI/RTCP)', TRANSMIT: '1c (TRANSMIT)', TRACYL: '1c (TRACYL)', CYCLE800: '1c (CYCLE800)',
  CYCLE81: '1d (drilling cycles)', CYCLE82: '1d (drilling cycles)', CYCLE83: '1d (drilling cycles)',
  CYCLE84: '1d (drilling cycles)', CYCLE840: '1d (drilling cycles)', CYCLE85: '1d (drilling cycles)',
  CYCLE86: '1d (drilling cycles)', CYCLE87: '1d (drilling cycles)', CYCLE88: '1d (drilling cycles)',
  CYCLE89: '1d (drilling cycles)', HOLES1: '1d (hole patterns)', HOLES2: '1d (hole patterns)',
  IF: '1e (program flow)', ELSE: '1e (program flow)', ENDIF: '1e (program flow)', GOTO: '1e (program flow)',
  GOTOF: '1e (program flow)', GOTOB: '1e (program flow)', GOTOC: '1e (program flow)', WHILE: '1e (program flow)',
  ENDWHILE: '1e (program flow)', FOR: '1e (program flow)', ENDFOR: '1e (program flow)', LOOP: '1e (program flow)',
  ENDLOOP: '1e (program flow)', REPEAT: '1e (program flow)', UNTIL: '1e (program flow)', CALL: '1e (subprograms)',
  DEF: '1e (variables)',
}

const KNOWN_CALLS_IGNORED = new Set(['MSG', 'WORKPIECE', 'SETMS', 'G_GROUP', 'CYCLE832', 'STOPRE', 'WRITE', 'DISPLON', 'DISPLOF'])

class DiagnosticSink {
  readonly items: Diagnostic[] = []
  private counts = new Map<string, number>()
  constructor(private perKey = 3) {}

  /** Same `key` is reported at most `perKey` times; the rest are counted. */
  add(line: number, severity: Severity, message: string, key = message) {
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    if (n <= this.perKey) this.items.push({ line, severity, message })
  }

  finish() {
    for (const [key, n] of this.counts) {
      if (n > this.perKey) {
        this.items.push({ line: 0, severity: 'info', message: `"${key}" repeated ${n - this.perKey} more time(s)` })
      }
    }
    this.items.sort((a, b) => (a.line || Infinity) - (b.line || Infinity))
    return this.items
  }
}

interface AxisWord { value: number; mode?: PosMode; line: number }

export function interpret(text: string, opts: InterpretOptions = {}): InterpretResult {
  const dialect: Dialect = !opts.dialect || opts.dialect === 'auto' ? detectDialect(text) : opts.dialect
  const blocks = lexProgram(text, dialect)
  const diag = new DiagnosticSink()
  const moves: ProgramMove[] = []
  const usedAxes: Partial<Record<AxisLetter, number>> = {}

  // ---- Modal state ----
  const pos: Pos6 = { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, ...opts.start }
  let motion: 0 | 1 | 2 | 3 = opts.initialMotion ?? 0
  let plane: Plane = 17
  let absolute = true
  let feedMode: FeedMode = 'G94'
  let inch = false
  let inchFeed = false // G700 (Sinumerik) / G20 (Fanuc) also scale F
  let diamon = false
  let workOffset = 'G500'
  let feed = 0
  let spindle = 0
  let tool: ProgramMove['tool'] = { T: null, D: 1 }
  let feedWarned = false
  const params = new Map<string, number>()
  let ended = false

  const lookup = (name: string) => params.get(name) ?? (/^R\d+$/.test(name) ? 0 : undefined)

  const numberOf = (w: Extract<Word, { kind: 'addr' }>, line: number): number | null => {
    if (w.value !== null) return w.value
    try {
      return evaluate(w.expr ?? '', lookup)
    } catch (e) {
      diag.add(line, 'error', e instanceof ExpressionError ? e.message : `Cannot evaluate ${w.text}`)
      return null
    }
  }

  for (let bi = 0; bi < blocks.length && !ended; bi++) {
    const b = blocks[bi]
    const line = b.line
    if (b.words.length === 0) continue

    // ---- Pass 1: G-codes (modal changes take effect in this block) ----
    let dwellBlock = false
    let machineCoords = false
    for (const w of b.words) {
      if (w.kind !== 'addr' || w.letter !== 'G') continue
      const g = numberOf(w, line)
      if (g === null) continue
      switch (g) {
        case 0: case 1: case 2: case 3: motion = g; break
        case 4: dwellBlock = true; break
        case 17: case 18: case 19: plane = g; break
        case 90: absolute = true; break
        case 91: absolute = false; break
        case 93: feedMode = 'G93'; break
        case 94: feedMode = 'G94'; break
        case 95: feedMode = 'G95'; break
        case 53: case 153: machineCoords = true; break
        case 54: case 55: case 56: case 57: workOffset = `G${g}`; break
        case 500: workOffset = 'G500'; break
        case 70: inch = true; inchFeed = false; break
        case 71: inch = false; inchFeed = false; break
        case 700: inch = true; inchFeed = true; break
        case 710: inch = false; inchFeed = false; break
        case 20: if (dialect === 'fanuc') { inch = true; inchFeed = true } else diag.add(line, 'warning', 'G20 is not a Sinumerik code (inch is G70/G700)'); break
        case 21: if (dialect === 'fanuc') { inch = false; inchFeed = false } break
        case 41: case 42:
          diag.add(line, 'warning', `G${g}: cutter radius compensation is not simulated — path shown is the programmed contour`, 'G41/G42')
          break
        default:
          if (dialect === 'fanuc') {
            if (IGNORED_G_FANUC.has(g)) break
            if (LATER_G_FANUC[g]) { diag.add(line, 'warning', `G${g} is not simulated yet — phase ${LATER_G_FANUC[g]}`, `G${g}`); break }
          }
          if (g >= 505 && g <= 599) { workOffset = `G${g}`; break }
          if (!IGNORED_G.has(g)) diag.add(line, 'warning', `G${g} is not supported — ignored`, `G${g}`)
      }
    }

    // ---- Pass 2: everything else ----
    const axisWords: Partial<Record<AxisLetter, AxisWord>> = {}
    const center: { I?: AxisWord; J?: AxisWord; K?: AxisWord } = {}
    let radius: number | null = null
    let turns = 0
    let dwellF: number | null = null
    let dwellS: number | null = null
    let modalCallPending = false
    let skipMotion = false

    for (const w of b.words) {
      switch (w.kind) {
        case 'assign': {
          if (/^R\d+$/.test(w.name)) {
            try { params.set(w.name, evaluate(w.expr, lookup)) }
            catch (e) { diag.add(line, 'error', e instanceof Error ? e.message : String(e)) }
          } else {
            diag.add(line, 'warning', `Assignment to ${w.name} is not simulated — phase 1e (variables)`, `assign ${w.name}`)
          }
          break
        }
        case 'string':
          if (w.letter === 'T') tool = { ...tool, T: w.value }
          else diag.add(line, 'warning', `${w.text}: string value for ${w.letter} not supported`)
          break
        case 'keyword': {
          const k = w.name
          if (k === 'SUPA') machineCoords = true
          else if (k === 'DIAMON' || k === 'DIAM90') diamon = true
          else if (k === 'DIAMOF') diamon = false
          else if (k === 'MCALL') modalCallPending = true
          else if (k === 'RET') { /* subprogram end in main program: ignore */ }
          else if (FRAME_KEYWORDS.has(k)) {
            // "TRANS" alone resets the frame (identity until phase 1b); with arguments it defines one
            skipMotion = true
            if (b.words.length > 1) diag.add(line, 'warning', `${k} is not simulated yet — phase ${LATER[k]}; following positions are shown without this frame`, k)
          }
          else if (FLOW_KEYWORDS.has(k)) {
            skipMotion = true
            diag.add(line, 'warning', `${k} is not simulated yet — phase ${LATER[k]}; block skipped, program runs straight through`, k)
          }
          else if (LATER[k]) diag.add(line, 'warning', `${k} is not simulated yet — phase ${LATER[k]}`, k)
          else if (!IGNORED_KEYWORDS.has(k)) diag.add(line, 'warning', `Unknown word "${k}" — ignored`, `kw ${k}`)
          break
        }
        case 'call': {
          const n = w.name
          if (FRAME_KEYWORDS.has(n)) { skipMotion = true; diag.add(line, 'warning', `${n} is not simulated yet — phase ${LATER[n]}`, n) }
          else if (LATER[n]) diag.add(line, 'warning', `${n} is not simulated yet — phase ${LATER[n]}${modalCallPending ? ' (modal MCALL: holes at following positions are missing)' : ''}`, n)
          else if (!KNOWN_CALLS_IGNORED.has(n)) diag.add(line, 'warning', `Call ${n}(…) is not simulated — ignored`, `call ${n}`)
          break
        }
        case 'unknown':
          diag.add(line, 'error', `Cannot read "${w.text}"`)
          break
        case 'addr': {
          const L = w.letter
          if (L === 'G') break
          const v = numberOf(w, line)
          if (v === null) break
          if ((AXES as string[]).includes(L)) {
            axisWords[L as AxisLetter] = { value: v, mode: w.mode, line }
          } else if (L === 'I' || L === 'J' || L === 'K') {
            center[L] = { value: v, mode: w.mode, line }
          } else if (L === 'CR' || (L === 'R' && dialect === 'fanuc')) {
            radius = v
          } else if (L === 'TURN') {
            turns = Math.max(0, Math.round(v))
          } else if (L === 'F') {
            if (dwellBlock) dwellF = v
            else feed = inchFeed ? v * 25.4 : v
          } else if (L === 'S') {
            if (dwellBlock) dwellS = v
            else spindle = v
          } else if (L === 'T') {
            tool = { ...tool, T: v }
          } else if (L === 'D') {
            tool = { ...tool, D: v }
          } else if (L === 'M') {
            if (v === 2 || v === 30) ended = true
            else if (v === 17 && dialect === 'sinumerik') { /* end of subprogram */ }
          } else if (L === 'N' || L === 'H' || L === 'E' || (L === 'O' && dialect === 'fanuc')) {
            // block number inside a line / H & E auxiliary functions / Fanuc program number: no motion
          } else if (L === 'L') {
            diag.add(line, 'warning', `Subprogram call L${v} is not simulated — phase 1e (subprograms)`, 'L call')
          } else if (L === 'R' && dialect === 'sinumerik') {
            diag.add(line, 'warning', `"${w.text}": R without "=" — ignored`)
          } else if (/^(AP|RP|RND|CHF|CHR|ANG|RPL)$/.test(L)) {
            diag.add(line, 'warning', `${L}= (polar/chamfer/contour definition) is not supported — ignored`, L)
          } else if (L.length > 1 && /^[XYZABC]\d+$/.test(L)) {
            diag.add(line, 'warning', `Axis address ${L}= is not mapped — ignored`, `addr ${L}`)
          } else {
            diag.add(line, 'warning', `Address ${L} is not supported — ignored`, `addr ${L}`)
          }
        }
      }
    }

    if (skipMotion) continue

    const baseMove = () => ({
      blockIndex: bi, line,
      feed, feedMode, spindle,
      tool: { ...tool }, workOffset, machineCoords,
    })

    // ---- Dwell ----
    if (dwellBlock) {
      let seconds: number | null = null
      if (dwellF !== null) seconds = dwellF
      else if (dwellS !== null && spindle > 0) seconds = (dwellS / spindle) * 60
      if (seconds === null) diag.add(line, 'error', 'G4 without F (seconds) or S (revolutions)')
      else moves.push({ ...baseMove(), kind: 'dwell', start: { ...pos }, end: { ...pos }, dwell: seconds })
      continue
    }

    // ---- Target position ----
    const end: Pos6 = { ...pos }
    let hasAxis = false
    for (const L of AXES) {
      const aw = axisWords[L]
      if (!aw) continue
      hasAxis = true
      if (usedAxes[L] === undefined) usedAxes[L] = line
      const k = KEY[L]
      const isLinear = LINEAR.includes(L)
      let v = aw.value
      if (isLinear && inch) v *= 25.4
      if (L === 'X' && diamon) v /= 2
      const mode = aw.mode ?? (absolute || machineCoords ? 'AC' : 'IC')
      if (mode === 'AC') end[k] = v
      else if (mode === 'IC') end[k] = pos[k] + v
      else if (isLinear) {
        diag.add(line, 'error', `${mode}() is only valid for rotary axes (${L})`)
        end[k] = v
      } else {
        // Modulo positioning of a rotary axis: target is 0..360, path chosen by mode
        const cur = pos[k]
        const curMod = ((cur % 360) + 360) % 360
        const tgt = ((v % 360) + 360) % 360
        let d = tgt - curMod
        if (mode === 'DC') { if (d > 180) d -= 360; if (d < -180) d += 360 }
        else if (mode === 'ACP') { if (d < 0) d += 360 }
        else if (mode === 'ACN') { if (d > 0) d -= 360 }
        end[k] = cur + d
      }
    }

    const hasCenter = center.I !== undefined || center.J !== undefined || center.K !== undefined
    const isArc = motion === 2 || motion === 3
    // No axis words → no motion, except a full circle programmed with centre words only ("G2 I-10")
    if (!hasAxis && !(isArc && hasCenter)) continue

    // ---- Feed checks ----
    if (motion !== 0 && feed <= 0 && !feedWarned) {
      diag.add(line, 'error', 'Feed motion without F programmed (Sinumerik alarm 10860)')
      feedWarned = true
    }
    if (motion !== 0 && feedMode === 'G95' && spindle <= 0) {
      diag.add(line, 'warning', 'G95 (feed per revolution) with spindle speed S = 0 — time estimate uses F as mm/min', 'G95 S0')
    }

    if (!isArc) {
      moves.push({ ...baseMove(), kind: motion === 0 ? 'rapid' : 'linear', start: { ...pos }, end })
      Object.assign(pos, end)
      continue
    }

    // ---- Arc ----
    const arc = computeArc(pos, end, plane, motion === 2, center, radius, turns, inch, line, diag)
    if (arc) {
      moves.push({ ...baseMove(), kind: 'arc', start: { ...pos }, end, arc })
    }
    Object.assign(pos, end)
  }

  return { blocks, moves, diagnostics: diag.finish(), usedAxes, ended, dialect }
}

/** In-plane (u, v) and helix (w) components for each working plane, right-handed. */
const PLANE_AXES: Record<Plane, [keyof Pos6, keyof Pos6, keyof Pos6]> = {
  17: ['x', 'y', 'z'],
  18: ['z', 'x', 'y'],
  19: ['y', 'z', 'x'],
}
const CENTER_WORD: Record<'x' | 'y' | 'z', 'I' | 'J' | 'K'> = { x: 'I', y: 'J', z: 'K' }

function computeArc(
  start: Pos6, end: Pos6, plane: Plane, cw: boolean,
  center: { I?: AxisWord; J?: AxisWord; K?: AxisWord },
  radiusWord: number | null, turns: number, inch: boolean,
  line: number, diag: DiagnosticSink,
): ProgramMove['arc'] | null {
  const [uk, vk, wk] = PLANE_AXES[plane]
  const u0 = start[uk], v0 = start[vk]
  const u1 = end[uk], v1 = end[vk]
  const chord = Math.hypot(u1 - u0, v1 - v0)
  const scale = inch ? 25.4 : 1
  let cu: number, cv: number

  if (radiusWord !== null) {
    const r = Math.abs(radiusWord) * scale
    if (chord < 1e-6) {
      diag.add(line, 'error', 'Full circle cannot be programmed with CR=/R — use I/J/K')
      return null
    }
    const half = chord / 2
    let h2 = r * r - half * half
    if (h2 < 0) {
      if (h2 < -Math.max(1e-4, 1e-6 * r * r)) {
        diag.add(line, 'error', `Arc radius ${r.toFixed(3)} is smaller than half the chord ${half.toFixed(3)} (Sinumerik alarm 14040)`)
        return null
      }
      h2 = 0
    }
    const h = Math.sqrt(h2)
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2
    // Unit normal to the chord pointing to the RIGHT of the travel direction
    const nu = (v1 - v0) / chord, nv = -(u1 - u0) / chord
    // CW with a minor arc (CR>0) → centre on the right; CCW → left; CR<0 flips it (major arc)
    const side = (cw ? 1 : -1) * (radiusWord >= 0 ? 1 : -1)
    cu = mu + side * h * nu
    cv = mv + side * h * nv
  } else {
    const word = (axis: keyof Pos6): number => {
      const w = center[CENTER_WORD[axis as 'x' | 'y' | 'z']]
      if (!w) return start[axis] // missing centre word = 0 offset
      const v = w.value * scale
      return w.mode === 'AC' ? v : start[axis] + v
    }
    cu = word(uk)
    cv = word(vk)
  }

  const rs = Math.hypot(u0 - cu, v0 - cv)
  const re = Math.hypot(u1 - cu, v1 - cv)
  if (rs < 1e-6) {
    diag.add(line, 'error', 'Arc radius is zero — check I/J/K and the working plane (G17/G18/G19)')
    return null
  }
  if (Math.abs(rs - re) > Math.max(0.01, 1e-4 * rs)) {
    diag.add(line, 'warning',
      `Arc end point is not on the circle: start radius ${rs.toFixed(3)}, end radius ${re.toFixed(3)} (Sinumerik alarm 14040 if over tolerance)`,
      'arc radius mismatch')
  }

  const a0 = Math.atan2(v0 - cv, u0 - cu)
  const a1 = Math.atan2(v1 - cv, u1 - cu)
  let sweep = a1 - a0
  const fullCircle = chord < 1e-6
  if (cw) {
    if (fullCircle) sweep = -2 * Math.PI
    else { while (sweep >= 0) sweep -= 2 * Math.PI; while (sweep < -2 * Math.PI) sweep += 2 * Math.PI }
    sweep -= turns * 2 * Math.PI
  } else {
    if (fullCircle) sweep = 2 * Math.PI
    else { while (sweep <= 0) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI }
    sweep += turns * 2 * Math.PI
  }

  const c = { x: start.x, y: start.y, z: start.z }
  ;(c as Record<string, number>)[uk] = cu
  ;(c as Record<string, number>)[vk] = cv
  void wk
  return { center: c, plane, cw, radius: rs, endRadius: re, sweep }
}

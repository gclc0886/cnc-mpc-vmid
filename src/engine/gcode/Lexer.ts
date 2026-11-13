import type { Dialect, LexedBlock, PosMode, Word } from './types'

/**
 * Splits one source line into words. No semantics here — the Interpreter decides
 * what G54, CR=, MCALL or CYCLE83(…) mean.
 *
 * Handles real postprocessor output, e.g.
 *   N150 G42G1 X21.124 F800          (words without spaces)
 *   N140 MCALL CYCLE83 (50,9,41.164,300,,5,,5,,,1,1)
 *   N30 T="INSTRUMENT_2"
 *   %_N_4XX_MPF                      (program header)
 */

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)/
const POS_MODE = /^(AC|IC|DC|ACP|ACN)\s*\((.*)\)$/i

/** Locate a `;` comment start outside string literals. */
function commentStart(s: string): number {
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') inStr = !inStr
    else if (c === ';' && !inStr) return i
  }
  return -1
}

/** Read balanced "(...)" starting at s[i] === '('. Returns the index after ')' or -1. */
function matchParen(s: string, i: number): number {
  let depth = 0
  let inStr = false
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '"') inStr = !inStr
    if (inStr) continue
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return j + 1 }
  }
  return -1
}

/** Split call arguments on top-level commas; keeps empty slots (CYCLE83(50,,5)). */
function splitArgs(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let cur = ''
  for (const c of inner) {
    if (c === '"') inStr = !inStr
    if (!inStr) {
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    }
    cur += c
  }
  out.push(cur.trim())
  return out
}

/** Read an expression after '=': up to whitespace at paren depth 0 (quotes respected). */
function readExpr(s: string, i: number): number {
  let depth = 0
  let inStr = false
  let j = i
  while (j < s.length && /\s/.test(s[j])) j++ // allow "X= 10"
  for (; j < s.length; j++) {
    const c = s[j]
    if (c === '"') inStr = !inStr
    if (inStr) continue
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /\s/.test(c)) break
  }
  return j
}

function addrFromExpr(letter: string, rhs: string, text: string): Word {
  const t = rhs.trim()
  if (t.startsWith('"')) return { kind: 'string', letter, value: t.replace(/^"|"$/g, ''), text }
  const pm = POS_MODE.exec(t)
  if (pm) {
    const inner = pm[2].trim()
    const lit = NUMBER.exec(inner)
    const isLit = lit !== null && lit[0].length === inner.length
    return {
      kind: 'addr', letter, mode: pm[1].toUpperCase() as PosMode,
      value: isLit ? parseFloat(inner) : null, ...(isLit ? {} : { expr: inner }), text,
    }
  }
  const lit = NUMBER.exec(t)
  if (lit && lit[0].length === t.length) return { kind: 'addr', letter, value: parseFloat(t), text }
  return { kind: 'addr', letter, value: null, expr: t, text }
}

export function lexLine(rawLine: string, lineNumber: number, dialect: Dialect = 'sinumerik'): LexedBlock | null {
  const raw = rawLine.replace(/\r$/, '')
  let s = raw.trim()
  if (!s) return null

  const block: LexedBlock = { line: lineNumber, raw: s, skippable: false, words: [] }

  // Program header / tape markers: %_N_NAME_MPF, %, %O1234
  if (s.startsWith('%')) { block.comment = s; return block }

  // Comments
  const ci = commentStart(s)
  if (ci >= 0) { block.comment = s.slice(ci + 1).trim(); s = s.slice(0, ci) }
  if (dialect === 'fanuc') {
    s = s.replace(/\(([^)]*)\)/g, (_m, c: string) => { block.comment = (block.comment ? block.comment + ' ' : '') + c.trim(); return ' ' })
  } else if (/^\s*\([^=]*\)\s*$/.test(s)) {
    // "(COMMENT)" on its own line — not Sinumerik syntax, but common in pasted programs
    block.comment = s.trim().slice(1, -1).trim()
    s = ''
  }
  s = s.trim()

  // Block skip "/" or "/1".."/9"
  const skip = /^\/\d?\s*/.exec(s)
  if (skip) { block.skippable = true; s = s.slice(skip[0].length) }

  // Block number N123 or main block :123
  const bn = /^[N:](\d+)\s*/i.exec(s)
  if (bn) { block.blockNumber = parseInt(bn[1]); s = s.slice(bn[0].length) }

  // Jump label "MARK1:" (at least two chars, not followed by "=")
  const lbl = /^([A-Z_][A-Z0-9_]+):(?!=)\s*/i.exec(s)
  if (lbl) { block.label = lbl[1].toUpperCase(); s = s.slice(lbl[0].length) }

  let i = 0
  while (i < s.length) {
    const rest = s.slice(i)
    const sp = /^\s+/.exec(rest)
    if (sp) { i += sp[0].length; continue }

    // R1=…, X1=… : indexed name followed by '='
    const idxAssign = /^([A-Z])(\d+)\s*=/i.exec(rest)
    if (idxAssign) {
      const name = (idxAssign[1] + idxAssign[2]).toUpperCase()
      const start = i + idxAssign[0].length
      const end = readExpr(s, start)
      const rhs = s.slice(start, end)
      const text = s.slice(i, end)
      block.words.push(
        name[0] === 'R'
          ? { kind: 'assign', name, expr: rhs.trim(), text }
          : addrFromExpr(name, rhs, text), // extended address such as X1=10 (axis named X1)
      )
      i = end
      continue
    }

    // Plain address: letter + number (G42G1, X-10.5, F300)
    const addr = /^([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/i.exec(rest)
    if (addr && !/^[A-Z]{2}/i.test(rest)) {
      block.words.push({ kind: 'addr', letter: addr[1].toUpperCase(), value: parseFloat(addr[2]), text: addr[0] })
      i += addr[0].length
      continue
    }

    // Identifier: keyword, call, or extended address with '='
    const id = /^[A-Z_$][A-Z0-9_$]*/i.exec(rest)
    if (id) {
      const name = id[0].toUpperCase()
      let j = i + id[0].length
      while (j < s.length && s[j] === ' ') j++
      if (s[j] === '(') {
        const end = matchParen(s, j)
        if (end < 0) {
          block.words.push({ kind: 'unknown', text: s.slice(i) })
          break
        }
        block.words.push({ kind: 'call', name, args: splitArgs(s.slice(j + 1, end - 1)), text: s.slice(i, end) })
        i = end
        continue
      }
      if (s[j] === '=' && s[j + 1] !== '=') {
        const start = j + 1
        const end = readExpr(s, start)
        const rhs = s.slice(start, end)
        const text = s.slice(i, end)
        block.words.push(name.length === 1 || /^(CR|TURN|AP|RP|RND|CHF|CHR|ANG|RPL)$/.test(name)
          ? addrFromExpr(name, rhs, text)
          : { kind: 'assign', name, expr: rhs.trim(), text })
        i = end
        continue
      }
      block.words.push({ kind: 'keyword', name, text: id[0] })
      i += id[0].length
      continue
    }

    // Anything else: collect until whitespace
    const junk = /^\S+/.exec(rest)!
    block.words.push({ kind: 'unknown', text: junk[0] })
    i += junk[0].length
  }

  return block
}

/**
 * Guess the controller dialect from typical markers. Ties go to Sinumerik.
 * Fanuc: O-number, "(comment)" at line start or after a word, R-radius arcs (G2 … R4.).
 * Sinumerik: CR=, %_N_ headers, MCALL / CYCLExx, T="name", R1= assignments, ;-comments.
 */
export function detectDialect(text: string): Dialect {
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text
  let fanuc = 0
  let sinu = 0
  if (/^\s*O\d+/m.test(sample)) fanuc += 3
  if (/^\s*(?:N\d+\s*)?\([^)]*\)/m.test(sample)) fanuc += 2
  if (/\b[GM]\d+[^;\n]*\s\([A-Za-z\s-]/.test(sample)) fanuc += 1
  if (/\bG[23]\b[^;\n]*\bR-?\d/i.test(sample)) fanuc += 3
  if (/\bG(?:43|49|80|28)\b/.test(sample)) fanuc += 1
  if (/\bCR\s*=/i.test(sample)) sinu += 3
  if (/^%_N_/m.test(sample)) sinu += 3
  if (/\b(?:MCALL|CYCLE\d+|TRAORI|SUPA|DIAMON|G500)\b/i.test(sample)) sinu += 2
  if (/\bT\s*=\s*"/.test(sample)) sinu += 2
  if (/\bR\d+\s*=/.test(sample)) sinu += 1
  if (/;/.test(sample)) sinu += 1
  return fanuc > sinu ? 'fanuc' : 'sinumerik'
}

export function lexProgram(text: string, dialect: Dialect = 'sinumerik'): LexedBlock[] {
  const out: LexedBlock[] = []
  const lines = text.split('\n')
  for (let k = 0; k < lines.length; k++) {
    const b = lexLine(lines[k], k + 1, dialect)
    if (b) out.push(b)
  }
  return out
}

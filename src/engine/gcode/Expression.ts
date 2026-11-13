/**
 * Arithmetic expressions in G-code words: X=R1+10, F=R2*2, CR=SQRT(R3).
 *
 *   expr   = term   { ("+" | "-") term }
 *   term   = factor { ("*" | "/" | "DIV" | "MOD") factor }
 *   factor = ("+" | "-") factor | number | Rn | NAME "(" expr {"," expr} ")" | "(" expr ")"
 *
 * Trigonometry works in degrees (Sinumerik convention).
 */

export class ExpressionError extends Error {}

const DEG = Math.PI / 180

const FUNCS: Record<string, (...a: number[]) => number> = {
  SIN: (x) => Math.sin(x * DEG),
  COS: (x) => Math.cos(x * DEG),
  TAN: (x) => Math.tan(x * DEG),
  ASIN: (x) => Math.asin(x) / DEG,
  ACOS: (x) => Math.acos(x) / DEG,
  ATAN2: (y, x) => Math.atan2(y, x) / DEG,
  SQRT: (x) => Math.sqrt(x),
  ABS: (x) => Math.abs(x),
  POT: (x) => x * x,
  TRUNC: (x) => Math.trunc(x),
  ROUND: (x) => Math.round(x),
  LN: (x) => Math.log(x),
  EXP: (x) => Math.exp(x),
  MINVAL: (a, b) => Math.min(a, b),
  MAXVAL: (a, b) => Math.max(a, b),
}

export type ParamLookup = (name: string) => number | undefined

export function evaluate(text: string, lookup: ParamLookup = () => undefined): number {
  const src = text.toUpperCase()
  let i = 0

  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  const peek = () => { ws(); return src[i] }
  const fail = (msg: string): never => { throw new ExpressionError(`${msg} in "${text}"`) }

  function number(): number | null {
    ws()
    const m = /^(\d+\.?\d*|\.\d+)(EX[+-]?\d+)?/.exec(src.slice(i))
    if (!m) return null
    i += m[0].length
    const base = parseFloat(m[1])
    return m[2] ? base * Math.pow(10, parseInt(m[2].slice(2))) : base
  }

  function ident(): string | null {
    ws()
    const m = /^[A-Z_$][A-Z0-9_$]*/.exec(src.slice(i))
    if (!m) return null
    i += m[0].length
    return m[0]
  }

  function factor(): number {
    const c = peek()
    if (c === '-') { i++; return -factor() }
    if (c === '+') { i++; return factor() }
    if (c === '(') {
      i++
      const v = expr()
      if (peek() !== ')') fail('Missing ")"')
      i++
      return v
    }
    const n = number()
    if (n !== null) return n
    const id = ident()
    if (id === null) fail(`Unexpected "${c ?? 'end'}"`)
    if (peek() === '(') {
      const fn = FUNCS[id!]
      if (!fn) fail(`Unknown function ${id}`)
      i++
      const args = [expr()]
      while (peek() === ',') { i++; args.push(expr()) }
      if (peek() !== ')') fail('Missing ")"')
      i++
      return fn(...args)
    }
    // R-parameter (R1, R[1] is not supported) or other variable
    const v = lookup(id!)
    if (v === undefined) fail(`Unknown variable ${id}`)
    return v!
  }

  function term(): number {
    let v = factor()
    for (;;) {
      const c = peek()
      if (c === '*') { i++; v *= factor() }
      else if (c === '/') { i++; v /= factor() }
      else if (src.startsWith('DIV', i) && !/[A-Z0-9_]/.test(src[i + 3] ?? '')) { i += 3; v = Math.trunc(v / factor()) }
      else if (src.startsWith('MOD', i) && !/[A-Z0-9_]/.test(src[i + 3] ?? '')) { i += 3; v = v % factor() }
      else return v
    }
  }

  function expr(): number {
    let v = term()
    for (;;) {
      const c = peek()
      if (c === '+') { i++; v += term() }
      else if (c === '-') { i++; v -= term() }
      else return v
    }
  }

  const v = expr()
  ws()
  if (i < src.length) fail(`Unexpected "${src.slice(i)}"`)
  if (!Number.isFinite(v)) fail('Result is not a finite number')
  return v
}

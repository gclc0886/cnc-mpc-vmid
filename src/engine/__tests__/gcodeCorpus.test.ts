/**
 * Smoke test over real programs on disk (not in the repo).
 * Run:  CNC_GCODE_CORPUS="C:\CLAUDE-MCP\sinumeric-4x;C:\CLAUDE-MCP\Experiment\G-codes" npm test
 * Every program must interpret without throwing, produce motion, and have no *reading*
 * errors (lexer/expression). Errors the interpreter finds IN the program (e.g. a cycle
 * with swapped parameters from an old postprocessor) are listed in the summary.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseProgram } from '../GCodeParser'

const DIRS = (process.env.CNC_GCODE_CORPUS ?? '').split(';').map(s => s.trim()).filter(Boolean)
const EXT = /\.(mpf|spf|nc|tap|cnc|gcode)$/i

function find(dir: string): string[] {
  try {
    if (statSync(dir).isFile()) return EXT.test(dir) ? [dir] : []
    return readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? find(p) : EXT.test(n) ? [p] : []
    })
  } catch { return [] }
}

function decode(buf: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { return new TextDecoder('windows-1251').decode(buf) }
}

const files = DIRS.flatMap(find)
const summary: string[] = []
const programErrors: string[] = []
const warningKinds = new Map<string, number>()

describe.skipIf(files.length === 0)(`G-code corpus (${files.length} files)`, () => {
  it.each(files.map(f => [basename(f), f]))('%s', (_name, file) => {
    const r = parseProgram(decode(readFileSync(file as string)))
    const errs = r.diagnostics.filter(d => d.severity === 'error')
    const warns = r.diagnostics.filter(d => d.severity === 'warning')
    for (const w of warns) {
      const kind = w.message.replace(/[\d.-]+/g, '#').slice(0, 80)
      warningKinds.set(kind, (warningKinds.get(kind) ?? 0) + 1)
    }
    const mins = (r.duration / 60).toFixed(1)
    summary.push(`${String(_name).padEnd(34)} ${r.dialect.padEnd(9)} ${String(r.moves.length).padStart(6)} moves ${String(r.points.length).padStart(8)} samples ${mins.padStart(7)} min  ${errs.length} err ${warns.length} warn`)
    for (const e of errs) programErrors.push(`${_name} L${e.line}: ${e.message.slice(0, 110)}`)
    const readErrors = errs.filter(e => /^(Cannot read|Cannot evaluate|Unknown variable|Unknown function|Missing|Unexpected|Argument \d+:)/.test(e.message))
    expect(r.moves.length).toBeGreaterThan(0)
    expect(readErrors, readErrors.map(e => `line ${e.line}: ${e.message}`).join('\n')).toEqual([])
  })

  afterAll(() => {
    console.log(['G-code corpus summary', ...summary,
      `Errors found in programs (${programErrors.length}):`, ...programErrors.slice(0, 20).map(e => '  ' + e),
      'Warning kinds:',
      ...[...warningKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n}× ${k}`)].join('\n'))
  })
})

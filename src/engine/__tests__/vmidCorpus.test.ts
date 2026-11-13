// @vitest-environment jsdom
/**
 * Smoke test over a local folder of real VMID files (not in the repo).
 * Run:  CNC_VMID_CORPUS=C:\POSTs npm test
 * Hard checks: every file parses without throwing and yields at least one device.
 * Soft checks are printed as a summary — they track known loader gaps
 * (see docs/UPGRADE_PLAN.md B12–B15) without failing the build.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseVMID } from '../VMIDLoader'
import { KinematicChain } from '../KinematicChain'
import type { AxisDef } from '../KinematicChain'
import { decodeVmid } from './vmidText'

const CORPUS = process.env.CNC_VMID_CORPUS

function findVmids(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...findVmids(p))
    else if (name.toLowerCase().endsWith('.vmid')) out.push(p)
  }
  return out
}

const files = CORPUS ? findVmids(CORPUS) : []

const stats = {
  parsed: 0,
  noAxes: [] as string[],
  noCombinations: [] as string[],
  unresolvedComboAxes: [] as string[],
  multiDeviceCollapsed: [] as string[],
  duplicateAxisNames: [] as string[],
}

function allAxes(axes: AxisDef[]): AxisDef[] {
  return axes.flatMap(a => [a, ...allAxes(a.children ?? [])])
}

describe.skipIf(!CORPUS)(`VMID corpus (${files.length} files)`, () => {
  it.each(files.map(f => [relative(CORPUS!, f), f]))('%s', (_rel, file) => {
    const rel = _rel as string
    const xml = decodeVmid(readFileSync(file as string))
    const cfg = parseVMID(xml)
    expect(cfg.devices.length).toBeGreaterThan(0)
    // Building the chain must not throw either
    const chain = new KinematicChain(cfg)
    chain.updateMatrices()
    stats.parsed++

    const axes = cfg.devices.flatMap(d => allAxes(d.axes))
    if (axes.length === 0) stats.noAxes.push(rel)
    if (cfg.combinations.length === 0) stats.noCombinations.push(rel)
    const ids = new Set(axes.map(a => a.id))
    const missing = cfg.combinations.flatMap(c => [...c.axesOrder.linear, ...c.axesOrder.rotary]).filter(id => !ids.has(id))
    if (missing.length) stats.unresolvedComboAxes.push(`${rel} [${[...new Set(missing)].join(',')}]`)
    const names = axes.map(a => a.name)
    if (new Set(names).size !== names.length) stats.duplicateAxisNames.push(rel)
    // Device IDs referenced by combinations but absent after parsing → devices were merged
    const devIds = new Set(cfg.devices.map(d => d.id))
    const refDev = cfg.combinations.flatMap(c => [c.turretId, c.tableId]).filter(id => !devIds.has(id))
    if (refDev.length) stats.multiDeviceCollapsed.push(`${rel} [${[...new Set(refDev)].join(',')}]`)
  })

  afterAll(() => {
    const list = (title: string, items: string[]) =>
      `${title}: ${items.length}` + (items.length ? '\n    ' + items.slice(0, 15).join('\n    ') + (items.length > 15 ? '\n    …' : '') : '')
    console.log([
      `VMID corpus summary — parsed ${stats.parsed}/${files.length}`,
      list('  no axes', stats.noAxes),
      list('  no combinations', stats.noCombinations),
      list('  combination axis IDs not found (B14)', stats.unresolvedComboAxes),
      list('  combination device IDs not found (B12/B13)', stats.multiDeviceCollapsed),
      list('  duplicate axis names (B10)', stats.duplicateAxisNames),
    ].join('\n'))
  })
})

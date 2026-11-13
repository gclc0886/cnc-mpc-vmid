import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMachineStore } from '../store/useMachineStore'
import { useLiveVersion } from '../hooks/useLiveVersion'
import { explainChain, rotationOf } from '../engine/ChainExplain'
import type { ChainStep } from '../engine/ChainExplain'
import type { Matrix4x4 } from '../engine/Matrix4x4'

const f = (v: number, d = 3) => {
  const r = v.toFixed(d)
  return r.startsWith('-') && Number(r) === 0 ? r.slice(1) : r
}
const fv = (v: { x: number; y: number; z: number }, d = 3) => `(${f(v.x, d)}, ${f(v.y, d)}, ${f(v.z, d)})`
const pos = (m: Matrix4x4) => { const t = m.getTranslation(); return `(${f(t[0])}, ${f(t[1])}, ${f(t[2])})` }
const rot = (m: Matrix4x4) => {
  const r = rotationOf(m)
  return r.angle < 1e-4 ? 'no rotation' : `${f(r.angle, 2)}° about ${fv(r.axis, 3)}`
}

function MiniMatrix({ m }: { m: Matrix4x4 }) {
  return (
    <div className="matrix-grid learn-matrix">
      {m.data.map((v, i) => (
        <div key={i} className={`matrix-cell ${i % 4 === 3 && i < 12 ? 'highlight' : ''}`}>{f(v)}</div>
      ))}
    </div>
  )
}

function StepRow({ s, index, parent, selected, onSelect }: {
  s: ChainStep; index: number; parent: string; selected: boolean; onSelect: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`learn-step ${selected ? 'selected' : ''} type-${s.type}`}>
      <div className="learn-step-head" onClick={onSelect} title="Click to highlight in 3D">
        <span className="learn-idx">{index}</span>
        <b>{s.name}</b>
        <span className="learn-type">{s.type}</span>
        {s.type !== 'static' && <span className="learn-val">{f(s.value)} {s.unit}</span>}
        <button className="learn-more" onClick={e => { e.stopPropagation(); setOpen(!open) }}>{open ? '▾' : '▸'}</button>
      </div>
      <div className="learn-formula">L<sub>{s.name}</sub> = {s.formula}</div>
      <div className="learn-formula">W<sub>{s.name}</sub> = {parent} · L<sub>{s.name}</sub> → origin {pos(s.world)}, {rot(s.world)}</div>
      {open && (
        <div className="learn-mats">
          <div><span>L (local)</span><MiniMatrix m={s.local} /></div>
          <div><span>W (world)</span><MiniMatrix m={s.world} /></div>
        </div>
      )}
    </div>
  )
}

function CompareSection() {
  const { hasKin, compare, stats, setCompare, applyStep, parsedBlocks } = useMachineStore(useShallow(s => ({
    hasKin: s.hasTransformations, compare: s.compareTransform, stats: s.compareStats,
    setCompare: s.setCompareTransform, applyStep: s.applyStep, parsedBlocks: s.parsedBlocks,
  })))
  void parsedBlocks
  return (
    <div className="learn-section">
      <div className="panel-header">With / without transformation</div>
      <div className="setup-hint">
        Same program, computed as if TRAORI and CYCLE800 were not there: axes take the programmed
        values directly. The dashed magenta trace shows where the tool would go — the difference
        is what RTCP / the swivel cycle compensates.
      </div>
      {!hasKin ? (
        <div className="setup-hint">The current program has no TRAORI or CYCLE800.</div>
      ) : (
        <>
          <label className="learn-toggle">
            <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />
            Show the trace without transformation
          </label>
          {compare && stats && (
            <div className="learn-stats">
              Largest difference on the part: <b>{f(stats.maxDev, 2)} mm</b> at line {stats.line}
              <button className="setup-btn" onClick={() => applyStep(stats.step)}>Go there</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Teaching view of the forward kinematics at the current machine state: every node of the
 * workpiece and tool chains with its local transform and the accumulated world matrix,
 * the tool length step and the relative matrix Inv(table) × tool tip.
 */
export function LearnPanel() {
  useLiveVersion()
  const { chain, selectedNode, setSelectedNode } = useMachineStore(useShallow(s => ({
    chain: s.chain, selectedNode: s.selectedNode, setSelectedNode: s.setSelectedNode,
  })))
  if (!chain) return <div style={{ color: '#666', fontSize: 11 }}>Load a machine first</div>

  const ex = explainChain(chain)
  const order = [...ex.devices].sort((a, b) => (a.type === 'table' ? -1 : 1) - (b.type === 'table' ? -1 : 1))
  const L = ex.tool?.length ?? 0

  return (
    <div className="learn-panel">
      <div className="setup-hint">
        Forward kinematics: each axis contributes a local transform L (fixed offset · its motion).
        Multiplying them from the machine base gives the world matrix W of every frame.
        Live at the current machine position; click a node to see it in 3D.
      </div>

      {order.map(dev => (
        <div key={dev.id} className="learn-section">
          <div className="panel-header">
            {dev.type === 'table' ? 'Workpiece chain' : 'Tool chain'} — {dev.name}
          </div>
          {dev.steps.map((s, i) => (
            <StepRow
              key={s.name}
              s={s}
              index={i + 1}
              parent={i === 0 ? 'I' : `W${dev.steps[i - 1].name}`.replace(/^W/, 'W_')}
              selected={selectedNode === s.name}
              onSelect={() => setSelectedNode(selectedNode === s.name ? null : s.name)}
            />
          ))}
          {dev.type === 'spindle' && ex.tool && (
            <div className="learn-step type-tool">
              <div className="learn-step-head"><span className="learn-idx">⤓</span><b>Tool tip</b><span className="learn-type">length {f(L)} mm</span></div>
              <div className="learn-formula">
                W<sub>tip</sub> = W<sub>{dev.steps[dev.steps.length - 1]?.name}</sub> · T(−L · {fv(ex.tool.axis, 2)}) → origin {pos(ex.tool.tip)}
              </div>
            </div>
          )}
        </div>
      ))}

      {ex.relative && (
        <div className="learn-section">
          <div className="panel-header">Tool tip seen from the workpiece</div>
          <div className="learn-formula">R = W<sub>table</sub><sup>−1</sup> · W<sub>tip</sub></div>
          <div className="learn-formula">→ tool tip {pos(ex.relative)} on the part, tool axis {rot(ex.relative)}</div>
          <MiniMatrix m={ex.relative} />
          <div className="setup-hint">
            This is what the CAM programmed (before the work offset): to hold it while rotary axes move,
            the control must change the linear axes — that is RTCP.
          </div>
        </div>
      )}

      <CompareSection />
    </div>
  )
}

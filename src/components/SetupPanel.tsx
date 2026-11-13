import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMachineStore, WORK_OFFSET_NAMES, INITIAL_WORK_OFFSET } from '../store/useMachineStore'
import type { AxisOffsets } from '../engine/GCodeParser'
import { NumericInput } from './ConfiguratorPanel'

const AXES: (keyof AxisOffsets)[] = ['x', 'y', 'z', 'a', 'b', 'c']

const cellInput: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box' }

/**
 * Machine setup the program runs against: settable work offsets (G54…) and the tool table.
 * Changing a value re-simulates the program at the current step.
 */
export function SetupPanel() {
  const {
    workOffsets, autoWorkOffset, tools, toolsUsed, workOffsetsUsed, setWorkOffset, setTool, hasMachine,
  } = useMachineStore(useShallow(s => ({
    workOffsets: s.workOffsets, autoWorkOffset: s.autoWorkOffset, tools: s.tools,
    toolsUsed: s.toolsUsed, workOffsetsUsed: s.workOffsetsUsed,
    setWorkOffset: s.setWorkOffset, setTool: s.setTool, hasMachine: s.config !== null,
  })))
  const [newTool, setNewTool] = useState('')

  if (!hasMachine) return <div style={{ color: '#666', fontSize: 11 }}>Load a machine first</div>

  const toolKeys = [...toolsUsed, ...Object.keys(tools).filter(k => !toolsUsed.includes(k)).sort()]
  const isAuto = (o: AxisOffsets) => AXES.every(k => Math.abs(o[k] - autoWorkOffset[k]) < 1e-9)

  return (
    <div className="setup-panel">
      <div className="panel-header">Work offsets (machine values)</div>
      <div className="setup-hint">
        Axis = program × frame + offset + tool length. Start state: {INITIAL_WORK_OFFSET}.
        “Auto” puts program zero on the workpiece origin of this machine.
      </div>
      <table className="setup-table">
        <thead>
          <tr><th />{AXES.map(k => <th key={k}>{k.toUpperCase()}</th>)}<th /></tr>
        </thead>
        <tbody>
          {WORK_OFFSET_NAMES.map(name => {
            const o = workOffsets[name] ?? autoWorkOffset
            const used = workOffsetsUsed.includes(name)
            return (
              <tr key={name} className={used ? 'used' : ''}>
                <td title={used ? 'Used by the program' : undefined}>{name}{used ? ' •' : ''}</td>
                {AXES.map(k => (
                  <td key={k}>
                    <NumericInput style={cellInput} value={o[k]} onChange={v => setWorkOffset(name, { ...o, [k]: v })} />
                  </td>
                ))}
                <td>
                  <button
                    className="setup-btn"
                    title={`Set to ${AXES.map(k => `${k.toUpperCase()}${autoWorkOffset[k]}`).join(' ')}`}
                    disabled={isAuto(o)}
                    onClick={() => setWorkOffset(name, autoWorkOffset)}
                  >Auto</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="panel-header" style={{ marginTop: 12 }}>Tool table</div>
      <div className="setup-hint">
        Length L1 acts along the tool axis of the working plane (G17 → Z). Fanuc: key = H number under G43.
        Radius is for display only (G41/G42 are not simulated).
      </div>
      <table className="setup-table">
        <thead>
          <tr><th style={{ textAlign: 'left' }}>Tool</th><th>Length</th><th>Radius</th><th /></tr>
        </thead>
        <tbody>
          {toolKeys.length === 0 && (
            <tr><td colSpan={4} style={{ color: '#666' }}>Parse a program to list its tools, or add one below</td></tr>
          )}
          {toolKeys.map(key => {
            const t = tools[key]
            const used = toolsUsed.includes(key)
            return (
              <tr key={key} className={used ? 'used' : ''}>
                <td style={{ textAlign: 'left', wordBreak: 'break-all' }} title={used ? 'Used by the program' : undefined}>
                  {key}{used ? ' •' : ''}{!t && <span className="setup-missing"> missing</span>}
                </td>
                <td><NumericInput style={cellInput} value={t?.length ?? 0} onChange={v => setTool(key, { length: v, radius: t?.radius ?? 0 })} /></td>
                <td><NumericInput style={cellInput} value={t?.radius ?? 0} onChange={v => setTool(key, { length: t?.length ?? 0, radius: v })} /></td>
                <td>{t && <button className="setup-btn" title="Remove from table" onClick={() => setTool(key, null)}>×</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="editor-row" style={{ marginTop: 6 }}>
        <input
          value={newTool}
          placeholder='T number or name, e.g. 1 or INSTRUMENT_2'
          onChange={e => setNewTool(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newTool.trim()) { setTool(newTool.trim(), { length: 0, radius: 0 }); setNewTool('') } }}
          style={{ flex: 1 }}
        />
        <button
          className="setup-btn"
          disabled={!newTool.trim()}
          onClick={() => { setTool(newTool.trim(), { length: 0, radius: 0 }); setNewTool('') }}
        >Add</button>
      </div>
    </div>
  )
}

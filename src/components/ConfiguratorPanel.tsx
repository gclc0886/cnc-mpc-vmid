import { useState } from 'react'
import { useMachineStore } from '../store/useMachineStore'
import type { AxisDef } from '../engine/KinematicChain'
import { PRESET_NAMES } from '../presets/machinePresets'

function safeParseFloat(val: string): number {
  if (val === '' || val === '-') return 0
  const n = parseFloat(val)
  return isNaN(n) ? 0 : n
}

function NumericInput({ value, onChange, style, step, placeholder }: {
  value: number
  onChange: (v: number) => void
  style?: React.CSSProperties
  step?: string
  placeholder?: string
}) {
  const [local, setLocal] = useState(String(value))
  const [focused, setFocused] = useState(false)

  // Sync from outside when not focused
  if (!focused && String(value) !== local && safeParseFloat(local) !== value) {
    setLocal(String(value))
  }

  const commit = () => {
    const n = safeParseFloat(local)
    onChange(n)
    setLocal(String(n))
    setFocused(false)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={focused ? local : String(value)}
      onFocus={() => { setFocused(true); setLocal(String(value)) }}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit() }}
      style={style}
      step={step}
      placeholder={placeholder}
    />
  )
}

function AxisTreeNode({
  axis,
  deviceId,
  depth,
  selectedNode,
  onSelect,
}: {
  axis: AxisDef
  deviceId: number
  depth: number
  selectedNode: string | null
  onSelect: (name: string) => void
}) {
  const isSelected = selectedNode === axis.name
  const typeIcon = axis.type === 'rotary' ? '\u21bb' : axis.type === 'static' ? '\u25a0' : '\u2192'
  const typeColor = axis.type === 'rotary' ? '#ffb74d' : axis.type === 'static' ? '#90a4ae' : '#81c784'

  return (
    <div>
      <div
        onClick={() => onSelect(axis.name)}
        style={{
          paddingLeft: depth * 16 + 4,
          padding: '3px 4px 3px ' + (depth * 16 + 4) + 'px',
          cursor: 'pointer',
          background: isSelected ? '#2a3a5e' : 'transparent',
          borderRadius: 3,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 1,
        }}
      >
        <span style={{ color: typeColor, fontWeight: 'bold', width: 14, textAlign: 'center' }}>
          {typeIcon}
        </span>
        <span style={{ color: isSelected ? '#4fc3f7' : '#e0e0e0', fontWeight: isSelected ? 'bold' : 'normal' }}>
          {axis.name}
        </span>
        <span style={{ color: '#666', fontSize: 10 }}>
          {axis.type}
        </span>
        {axis.type !== 'static' && (
          <span style={{ color: '#555', fontSize: 10 }}>
            v=[{axis.vector.x},{axis.vector.y},{axis.vector.z}]
          </span>
        )}
      </div>
      {axis.children?.map(child => (
        <AxisTreeNode
          key={child.name}
          axis={child}
          deviceId={deviceId}
          depth={depth + 1}
          selectedNode={selectedNode}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function findAxisInConfig(axes: AxisDef[], name: string): AxisDef | null {
  for (const a of axes) {
    if (a.name === name) return a
    if (a.children) {
      const found = findAxisInConfig(a.children, name)
      if (found) return found
    }
  }
  return null
}

function NodeEditor({ axisName }: { axisName: string }) {
  const { config, updateAxis, removeAxis } = useMachineStore()
  if (!config) return null

  let axis: AxisDef | null = null
  for (const dev of config.devices) {
    axis = findAxisInConfig(dev.axes, axisName)
    if (axis) break
  }
  if (!axis) return <div style={{ color: '#666', fontSize: 11 }}>Node not found</div>

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontSize: 10, color: '#4fc3f7', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        Edit: {axis.name}
      </div>

      {/* Type */}
      <div className="editor-row">
        <label>Type</label>
        <select
          value={axis.type}
          onChange={e => updateAxis(axisName, { type: e.target.value as AxisDef['type'] })}
        >
          <option value="linear">Linear</option>
          <option value="rotary">Rotary</option>
          <option value="static">Static</option>
        </select>
      </div>

      {/* Vector */}
      {axis.type !== 'static' && (
        <div className="editor-row">
          <label>Vector</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['x', 'y', 'z'] as const).map(c => (
              <NumericInput
                key={c}
                step="0.1"
                value={axis!.vector[c]}
                onChange={v => updateAxis(axisName, {
                  vector: { ...axis!.vector, [c]: v }
                })}
                style={{ width: 50 }}
                placeholder={c.toUpperCase()}
              />
            ))}
          </div>
        </div>
      )}

      {/* Offset */}
      <div className="editor-row">
        <label>Offset</label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['x', 'y', 'z'] as const).map(c => (
            <NumericInput
              key={c}
              step="1"
              value={axis!.offset?.[c] ?? 0}
              onChange={v => updateAxis(axisName, {
                offset: {
                  x: axis!.offset?.x ?? 0,
                  y: axis!.offset?.y ?? 0,
                  z: axis!.offset?.z ?? 0,
                  [c]: v,
                }
              })}
              style={{ width: 50 }}
              placeholder={c.toUpperCase()}
            />
          ))}
        </div>
      </div>

      {/* Limits */}
      {axis.type !== 'static' && (
        <div className="editor-row">
          <label>Limits</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <NumericInput
              value={axis.limits.min}
              onChange={v => updateAxis(axisName, {
                limits: { ...axis!.limits, min: v }
              })}
              style={{ width: 70 }}
              placeholder="Min"
            />
            <NumericInput
              value={axis.limits.max}
              onChange={v => updateAxis(axisName, {
                limits: { ...axis!.limits, max: v }
              })}
              style={{ width: 70 }}
              placeholder="Max"
            />
          </div>
        </div>
      )}

      {/* Center (rotary only) */}
      {axis.type === 'rotary' && (
        <div className="editor-row">
          <label>Center</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['x', 'y', 'z'] as const).map(c => (
              <NumericInput
                key={c}
                step="1"
                value={axis!.center?.[c] ?? 0}
                onChange={v => updateAxis(axisName, {
                  center: {
                    x: axis!.center?.x ?? 0,
                    y: axis!.center?.y ?? 0,
                    z: axis!.center?.z ?? 0,
                    [c]: v,
                  }
                })}
                style={{ width: 50 }}
                placeholder={c.toUpperCase()}
              />
            ))}
          </div>
        </div>
      )}

      {/* Delete */}
      <button
        onClick={() => removeAxis(axisName)}
        style={{
          marginTop: 8,
          padding: '4px 12px',
          background: '#5c2020',
          color: '#ff8a80',
          border: '1px solid #7c3030',
          borderRadius: 3,
          cursor: 'pointer',
          fontSize: 11,
        }}
      >
        Remove Axis
      </button>
    </div>
  )
}

export function ConfiguratorPanel() {
  const { config, selectedNode, setSelectedNode, addAxis, loadPreset } = useMachineStore()
  const [addingTo, setAddingTo] = useState<{ deviceId: number; parentName: string } | null>(null)
  const [newAxisName, setNewAxisName] = useState('')
  const [newAxisType, setNewAxisType] = useState<'linear' | 'rotary'>('linear')

  return (
    <div>
      {/* Preset selector */}
      <div className="panel-header">Preset Machines</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {PRESET_NAMES.map(p => (
          <button
            key={p.key}
            onClick={() => loadPreset(p.key)}
            className="preset-btn"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Kinematic tree */}
      {config && (
        <>
          <div className="panel-header">Kinematic Tree</div>
          {config.devices.map(dev => (
            <div key={dev.id} style={{ marginBottom: 8 }}>
              <div style={{
                fontSize: 11,
                color: dev.type === 'spindle' ? '#ff8a65' : '#81c784',
                fontWeight: 'bold',
                marginBottom: 2,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                {dev.type === 'spindle' ? 'Tool Chain' : 'Workpiece Chain'}
                <span style={{ color: '#666', fontWeight: 'normal' }}>({dev.name})</span>
                <button
                  onClick={() => {
                    setAddingTo({ deviceId: dev.id, parentName: '' })
                    setNewAxisName('')
                  }}
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    background: '#1a3a2e',
                    color: '#81c784',
                    border: '1px solid #2a5a3e',
                    borderRadius: 3,
                    cursor: 'pointer',
                    marginLeft: 'auto',
                  }}
                >
                  + Root Axis
                </button>
              </div>
              {dev.axes.map(axis => (
                <AxisTreeNode
                  key={axis.name}
                  axis={axis}
                  deviceId={dev.id}
                  depth={0}
                  selectedNode={selectedNode}
                  onSelect={setSelectedNode}
                />
              ))}
            </div>
          ))}

          {/* Add axis form */}
          {addingTo && (
            <div style={{
              padding: 8,
              background: '#0f1a2e',
              borderRadius: 4,
              marginBottom: 8,
              border: '1px solid #333',
            }}>
              <div style={{ fontSize: 10, color: '#4fc3f7', marginBottom: 4 }}>
                Add Axis {addingTo.parentName ? `under ${addingTo.parentName}` : '(root)'}
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                <input
                  type="text"
                  value={newAxisName}
                  onChange={e => setNewAxisName(e.target.value.toUpperCase())}
                  placeholder="Name (e.g. A)"
                  style={{ width: 60, padding: '2px 4px', background: '#0a0a1a', color: '#e0e0e0', border: '1px solid #333', borderRadius: 3, fontSize: 11 }}
                />
                <select
                  value={newAxisType}
                  onChange={e => setNewAxisType(e.target.value as 'linear' | 'rotary')}
                  style={{ padding: '2px 4px', background: '#0a0a1a', color: '#e0e0e0', border: '1px solid #333', borderRadius: 3, fontSize: 11 }}
                >
                  <option value="linear">Linear</option>
                  <option value="rotary">Rotary</option>
                </select>
                <button
                  onClick={() => {
                    if (!newAxisName) return
                    const vec = newAxisType === 'rotary'
                      ? { x: 1, y: 0, z: 0 }
                      : newAxisName === 'X' ? { x: 1, y: 0, z: 0 }
                        : newAxisName === 'Y' ? { x: 0, y: 1, z: 0 }
                          : { x: 0, y: 0, z: 1 }
                    const newAxis: AxisDef = {
                      name: newAxisName,
                      id: Date.now() % 10000,
                      type: newAxisType,
                      vector: vec,
                      offset: { x: 0, y: 0, z: 0 },
                      homeRef: 0,
                      limits: newAxisType === 'rotary' ? { min: -360, max: 360 } : { min: -500, max: 500 },
                    }
                    addAxis(addingTo.parentName, addingTo.deviceId, newAxis)
                    setAddingTo(null)
                  }}
                  style={{ padding: '2px 8px', background: '#1a3a2e', color: '#81c784', border: '1px solid #2a5a3e', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
                >
                  Add
                </button>
                <button
                  onClick={() => setAddingTo(null)}
                  style={{ padding: '2px 8px', background: '#3a1a1a', color: '#ff8a80', border: '1px solid #5a2a2a', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Add child button when node selected */}
          {selectedNode && !addingTo && (
            <button
              onClick={() => {
                const dev = config.devices.find(d => {
                  const find = (axes: AxisDef[]): boolean => {
                    for (const a of axes) {
                      if (a.name === selectedNode) return true
                      if (a.children && find(a.children)) return true
                    }
                    return false
                  }
                  return find(d.axes)
                })
                if (dev) {
                  setAddingTo({ deviceId: dev.id, parentName: selectedNode })
                  setNewAxisName('')
                }
              }}
              style={{
                padding: '4px 12px',
                background: '#1a3a2e',
                color: '#81c784',
                border: '1px solid #2a5a3e',
                borderRadius: 3,
                cursor: 'pointer',
                fontSize: 11,
                marginBottom: 8,
              }}
            >
              + Add Child to {selectedNode}
            </button>
          )}

          {/* Node editor */}
          {selectedNode && (
            <div style={{ borderTop: '1px solid #333', marginTop: 4 }}>
              <NodeEditor axisName={selectedNode} />
            </div>
          )}
        </>
      )}

      {!config && (
        <div style={{ color: '#666', fontSize: 11, marginTop: 8 }}>
          Select a preset to start configuring
        </div>
      )}
    </div>
  )
}

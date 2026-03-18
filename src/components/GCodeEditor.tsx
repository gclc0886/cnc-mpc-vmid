import { useMachineStore } from '../store/useMachineStore'

interface Props {
  value: string
  onChange: (value: string) => void
  currentLine: number
}

export function GCodeEditor({ value, onChange, currentLine }: Props) {
  const { parsedBlocks } = useMachineStore()
  const activeLineNum = parsedBlocks[currentLine]?.line ?? 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header" style={{ padding: '4px 8px' }}>
        G-Code Editor
        {activeLineNum > 0 && (
          <span style={{ float: 'right', color: '#81c784' }}>
            Line: {activeLineNum}
          </span>
        )}
      </div>
      <textarea
        className="gcode-textarea-simple"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  )
}

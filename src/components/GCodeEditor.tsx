import { useRef, useEffect, useCallback } from 'react'
import { useMachineStore } from '../store/useMachineStore'

interface Props {
  value: string
  onChange: (value: string) => void
  currentLine: number   // blockIndex from toolPath
}

/**
 * G-Code editor with line numbers and current-line highlighting during simulation.
 * Uses overlay approach: transparent textarea on top of highlighted code display.
 */
export function GCodeEditor({ value, onChange, currentLine }: Props) {
  const { parsedBlocks, isPlaying } = useMachineStore()
  const linesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const codeRef = useRef<HTMLDivElement>(null)

  // Map blockIndex → source line number
  const activeLineNum = parsedBlocks[currentLine]?.line ?? 0

  const lines = value.split('\n')

  // Sync scroll between textarea and overlay
  const syncScroll = useCallback(() => {
    if (textareaRef.current && linesRef.current && codeRef.current) {
      const top = textareaRef.current.scrollTop
      const left = textareaRef.current.scrollLeft
      linesRef.current.scrollTop = top
      codeRef.current.scrollTop = top
      codeRef.current.scrollLeft = left
    }
  }, [])

  // Auto-scroll to current line during playback
  useEffect(() => {
    if (activeLineNum <= 0) return
    const lineIdx = activeLineNum - 1
    const lineHeight = 18 // match CSS line-height
    const scrollTarget = lineIdx * lineHeight

    if (textareaRef.current) {
      const viewTop = textareaRef.current.scrollTop
      const viewHeight = textareaRef.current.clientHeight
      // Only scroll if line is out of view
      if (scrollTarget < viewTop || scrollTarget > viewTop + viewHeight - lineHeight * 2) {
        const newTop = Math.max(0, scrollTarget - viewHeight / 3)
        textareaRef.current.scrollTop = newTop
        syncScroll()
      }
    }
  }, [activeLineNum, syncScroll])

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
      <div className="gcode-container">
        {/* Line numbers */}
        <div className="gcode-line-numbers" ref={linesRef}>
          {lines.map((_, i) => (
            <div
              key={i}
              className={`gcode-ln${i + 1 === activeLineNum ? ' gcode-ln-active' : ''}`}
            >
              {i + 1}
            </div>
          ))}
        </div>

        {/* Code area with highlight overlay + textarea */}
        <div className="gcode-code-area">
          {/* Highlighted code (behind textarea) */}
          <div className="gcode-highlight" ref={codeRef}>
            {lines.map((line, i) => (
              <div
                key={i}
                className={`gcode-code-line${i + 1 === activeLineNum ? ' gcode-line-current' : ''}`}
              >
                {line || '\u00A0'}
              </div>
            ))}
          </div>

          {/* Transparent textarea for editing */}
          <textarea
            ref={textareaRef}
            className="gcode-textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  )
}

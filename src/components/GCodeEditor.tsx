import { useEffect, useRef, useState } from 'react'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, Decoration, keymap, lineNumbers, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { lintGutter, setDiagnostics } from '@codemirror/lint'
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { tags as t } from '@lezer/highlight'
import { useMachineStore } from '../store/useMachineStore'

// ─── Syntax: Sinumerik / Fanuc words ─────────────────────────────────────────

const gcodeLanguage = StreamLanguage.define<null>({
  name: 'gcode',
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match(';')) { stream.skipToEnd(); return 'comment' }
    if (stream.sol() && stream.match(/^%.*/)) return 'meta'
    if (stream.match(/^"[^"]*"?/)) return 'string'
    // "(text comment)" — Fanuc; Sinumerik call arguments rarely contain 3+ letters/spaces
    if (stream.match(/^\((?=[^)]*[A-Za-z ]{3})[^)]*\)?/)) return 'comment'
    if (stream.match(/^[N:]\d+/i)) return 'def'
    if (stream.match(/^G\d+(\.\d+)?/i)) return 'keyword'
    if (stream.match(/^M\d+/i)) return 'atom'
    if (stream.match(/^R\d+/i)) return 'variable'
    // Axis / centre address: only when a value follows (keeps CYCLE800, CALL … whole)
    if (stream.match(/^(CR|TURN|[XYZABCIJKUVW]\d?)(?=\s*=|\s*[-+.\d])/i)) return 'property'
    if (stream.match(/^[FSTDHL]\s*=?\s*(?=[-+.\d"])/i)) return 'number'
    if (stream.match(/^[-+]?(\d+\.?\d*|\.\d+)/)) return 'number'
    if (stream.match(/^[A-Z_][A-Z0-9_]*/i)) return 'builtin'
    stream.next()
    return null
  },
})

const gcodeHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.meta, color: '#808080' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.keyword, color: '#4fc3f7', fontWeight: 'bold' },
  { tag: t.atom, color: '#ce93d8' },
  { tag: t.propertyName, color: '#dcdcaa' },
  { tag: t.number, color: '#b5cea8' },
  { tag: t.variableName, color: '#9cdcfe' },
  { tag: t.definition(t.variableName), color: '#5c6370' },
  { tag: t.standard(t.variableName), color: '#ff8a65' },
])

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#14141e', color: '#d4d4d4', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'Consolas, "Courier New", monospace', lineHeight: '1.45' },
  '.cm-gutters': { backgroundColor: '#14141e', color: '#555', borderRight: '1px solid #2a2a3a' },
  '.cm-activeLineGutter': { backgroundColor: '#20203a' },
  '.cm-exec-line': { backgroundColor: 'rgba(76, 175, 80, 0.22)', boxShadow: 'inset 3px 0 0 #4caf50' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#4fc3f7' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#264f78 !important' },
}, { dark: true })

// ─── Executing line: one line decoration, changed only when the block changes ─

const setExecLine = StateEffect.define<number | null>()

const execLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setExecLine)) continue
      if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) { deco = Decoration.none; continue }
      const line = tr.state.doc.line(e.value)
      deco = Decoration.set([Decoration.line({ class: 'cm-exec-line' }).range(line.from)])
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

/** Source line of the sample currently applied to the machine (0 = none). */
function currentSourceLine(): number {
  const s = useMachineStore.getState()
  const pt = s.toolPath[s.currentStep]
  return pt ? (s.parsedBlocks[pt.blockIndex]?.line ?? 0) : 0
}

function toCmDiagnostics(state: EditorState): CmDiagnostic[] {
  const out: CmDiagnostic[] = []
  for (const d of useMachineStore.getState().diagnostics) {
    if (d.line < 1 || d.line > state.doc.lines) continue
    const line = state.doc.line(d.line)
    out.push({ from: line.from, to: line.to, severity: d.severity, message: d.message })
  }
  return out
}

/**
 * G-code editor (CodeMirror 6). Two-way bound to store.gcode; highlights the line
 * being executed, shows interpreter/limit diagnostics in the gutter, and jumps
 * playback to a line on double-click.
 */
export function GCodeEditor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [line, setLine] = useState(0)

  useEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      gcodeLanguage,
      syntaxHighlighting(gcodeHighlight),
      lintGutter(),
      execLineField,
      editorTheme,
      EditorView.updateListener.of(u => {
        if (!u.docChanged) return
        const text = u.state.doc.toString()
        if (text !== useMachineStore.getState().gcode) useMachineStore.getState().setGcode(text)
      }),
      EditorView.domEventHandlers({
        dblclick: (e, view) => {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos === null) return false
          useMachineStore.getState().jumpToLine(view.state.doc.lineAt(pos).number)
          return false
        },
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: useMachineStore.getState().gcode, extensions }),
      parent: hostRef.current!,
    })
    viewRef.current = view

    // Executing line: follows playback at most ~15 Hz, only when the source line changes
    let shown = -1
    let lastAt = 0
    let timer: number | undefined
    const showLine = () => {
      timer = undefined
      lastAt = performance.now()
      const ln = currentSourceLine()
      if (ln === shown) return
      shown = ln
      setLine(ln)
      const effects: StateEffect<unknown>[] = [setExecLine.of(ln || null)]
      if (ln >= 1 && ln <= view.state.doc.lines) {
        effects.push(EditorView.scrollIntoView(view.state.doc.line(ln).from, { y: 'nearest', yMargin: 40 }))
      }
      view.dispatch({ effects })
    }

    const unsub = useMachineStore.subscribe((s, prev) => {
      // Program text changed from outside (MCP load_gcode, file load)
      if (s.gcode !== prev.gcode && s.gcode !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s.gcode } })
        shown = -1
      }
      if (s.diagnostics !== prev.diagnostics) {
        view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state)))
      }
      if (s.currentStep !== prev.currentStep || s.toolPath !== prev.toolPath) {
        const wait = 66 - (performance.now() - lastAt)
        if (wait <= 0 || !s.isPlaying) { if (timer !== undefined) clearTimeout(timer); showLine() }
        else if (timer === undefined) timer = window.setTimeout(showLine, wait)
      }
    })
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state)))
    showLine()

    return () => {
      unsub()
      if (timer !== undefined) clearTimeout(timer)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header" style={{ padding: '4px 8px' }}>
        G-Code Editor
        <span style={{ float: 'right', color: '#81c784' }} title="Double-click a line to jump playback there">
          {line > 0 ? `Line: ${line}` : 'double-click a line to jump'}
        </span>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
    </div>
  )
}

import { useMachineStore } from '../store/useMachineStore'
import type { Matrix4x4 } from '../engine/Matrix4x4'

function MatrixDisplay({ name, matrix, highlight }: { name: string; matrix: Matrix4x4; highlight?: string }) {
  const pos = matrix.getTranslation()
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: highlight || '#4fc3f7', marginBottom: 3 }}>
        {name} [{pos[0].toFixed(2)}, {pos[1].toFixed(2)}, {pos[2].toFixed(2)}]
      </div>
      <div className="matrix-grid">
        {Array.from({ length: 16 }).map((_, idx) => {
          const row = Math.floor(idx / 4)
          const col = idx % 4
          const val = matrix.get(row, col)
          const isTranslation = col === 3 && row < 3
          return (
            <div
              key={idx}
              className={`matrix-cell ${isTranslation ? 'highlight' : ''}`}
            >
              {val.toFixed(3)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function MatrixPanel() {
  const { chain, version } = useMachineStore()
  void version

  if (!chain) {
    return (
      <div>
        <div className="panel-header">Matrices</div>
        <div style={{ color: '#666', fontSize: 11 }}>Load a machine to see matrices</div>
      </div>
    )
  }

  // Tool chain (spindle) leaf matrix
  const toolLeaf = chain.getDeviceLeafNode('spindle')
  // Workpiece chain (table) leaf matrix
  const workpieceLeaf = chain.getDeviceLeafNode('table')
  // Relative matrix: Inverse(Workpiece) × Tool
  const relativeMatrix = chain.getRelativeMatrix()

  return (
    <div>
      <div className="panel-header">Transformation Matrices (4x4)</div>

      {/* Tool Chain */}
      {toolLeaf && (
        <div style={{ borderBottom: '1px solid #333', paddingBottom: 6, marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: '#ff8a65', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Tool Chain
          </div>
          <MatrixDisplay name="Tool → World" matrix={toolLeaf.worldMatrix} highlight="#ff8a65" />
        </div>
      )}

      {/* Workpiece Chain */}
      {workpieceLeaf && (
        <div style={{ borderBottom: '1px solid #333', paddingBottom: 6, marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: '#81c784', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Workpiece Chain
          </div>
          <MatrixDisplay name="Workpiece → World" matrix={workpieceLeaf.worldMatrix} highlight="#81c784" />
        </div>
      )}

      {/* Relative Matrix */}
      <div style={{ borderTop: '1px solid #555', paddingTop: 8, marginTop: 4 }}>
        <div style={{ fontSize: 10, color: '#ce93d8', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
          Relative (Tool → Workpiece)
        </div>
        <MatrixDisplay name="Inv(Workpiece) × Tool" matrix={relativeMatrix} highlight="#ce93d8" />
      </div>
    </div>
  )
}

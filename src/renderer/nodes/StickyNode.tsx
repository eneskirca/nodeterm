import { useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'
import { ColumnPill } from '../components/kanban/ColumnPill'

/**
 * A sticky note node: a colored, resizable card with free-text content.
 * No PTY — purely a visual note for organizing the canvas (handy for ADHD users).
 */
export function StickyNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)
  /**
   * The title is a plain SPAN until it is clicked, exactly as on a terminal node.
   *
   * It used to be a permanent `<input class="term-node__title">`, and that class is `flex: 1` — so
   * the input covered the whole header strip. Everything in that strip was therefore a text field:
   * clicking to pick the note up put a caret in the title instead, and there was no bare header
   * left to grab. Reported 2026-08-09 ("the click area is full width, it should only be the name").
   * The terminal's `.term-node__title-text` is content-width, which is the behaviour being matched.
   */
  const [editingTitle, setEditingTitle] = useState(false)
  /** The value editing started with, so Escape can put it back. */
  const [titleBefore, setTitleBefore] = useState('')
  const collapsed = !!data.collapsed

  const toggleCollapse = () =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n
        const next = !n.data.collapsed
        const expandedHeight =
          (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 200
        const height = next ? COLLAPSED_HEIGHT : expandedHeight
        return {
          ...n,
          height,
          style: { ...n.style, height },
          data: { ...n.data, collapsed: next, expandedHeight }
        }
      })
    )

  return (
    <>
    {/* Sibling of the root: .sticky-node is overflow:hidden and would clip the half-pill. */}
    <ColumnPill nodeId={id} />
    <div
      className={`sticky-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}`}
      style={{ background: `${data.color}22`, borderColor: data.color }}
    >
      <NodeResizer minWidth={NODE_MIN_SIZES.sticky.width} minHeight={NODE_MIN_SIZES.sticky.height} isVisible={selected && !collapsed} color={data.color} />

      {/* Note-link handles: drag to/from a terminal node to attach this note as context. */}
      <Handle
        id="link-out"
        type="source"
        position={Position.Right}
        className="bridge-handle bridge-handle--out"
        data-tip="Link out — drag to a terminal to attach this note as context"
      />
      <Handle
        id="link-in"
        type="target"
        position={Position.Left}
        className="bridge-handle bridge-handle--in"
        data-tip="Link in — drop a link here to attach this note as context"
      />

      <div className="sticky-node__header" style={{ background: `${data.color}33` }}>
        <button className="term-node__collapse" title={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapse}>
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          className="term-node__color"
          style={{ background: data.color }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <div className="color-popover">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                onClick={() => {
                  updateNodeData(id, { color: c })
                  setShowColors(false)
                }}
              />
            ))}
          </div>
        )}
        {editingTitle ? (
          <input
            className="term-node__title nodrag"
            value={data.title}
            spellCheck={false}
            autoFocus
            onChange={(e) => updateNodeData(id, { title: e.target.value })}
            // Every exit commits what is on screen — the edits are live, so there is nothing to
            // save — except Escape, which puts back the value editing started with.
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setEditingTitle(false)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                updateNodeData(id, { title: titleBefore })
                setEditingTitle(false)
              }
            }}
          />
        ) : (
          <span
            className="term-node__title-text nodrag"
            title="Click to rename"
            onClick={() => {
              setTitleBefore((data.title as string) ?? '')
              setEditingTitle(true)
            }}
          >
            {(data.title as string) || 'Note'}
          </span>
        )}
        {/* Pushes the close button back to the right edge now that the title is content-width — and
            it is deliberately NOT `nodrag`, so this is the bare strip of header the note is picked
            up by. That grab area is what the permanent full-width input used to swallow. Absent
            while editing, since the input takes the `flex: 1` role itself. */}
        {!editingTitle && <span className="term-node__spacer" />}
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <textarea
        className="sticky-node__body nodrag nowheel"
        value={data.text ?? ''}
        placeholder="Write a note…"
        spellCheck={false}
        onChange={(e) => updateNodeData(id, { text: e.target.value })}
      />
    </div>
    </>
  )
}

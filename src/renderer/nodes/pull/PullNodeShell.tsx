// The frame the pull request node and the issues node share: resizers, rope handles, the header with
// its colour dot, editable title, Maximize and Close. Each node passes its own header buttons and body.
import { useEffect, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import { Tooltip } from '../../components/Tooltip'
import { IconClose } from '../../components/icons'
import { NODE_MIN_SIZES } from '../../lib/nodeSizing'
import type { CanvasNode } from '../../state/workspace'
import { MaximizeButton } from '../MaximizeButton'

type PullNodeShellProps = {
  id: string
  data: CanvasNode['data']
  selected: boolean
  kind: 'pull' | 'issues'
  /** Shown after the title (the pull node's repository). */
  headerExtra?: ReactNode
  /** The header buttons before Maximize. */
  actions: ReactNode
  /** The body element. */
  children: ReactNode
}

export function PullNodeShell({ id, data, selected, kind, headerExtra, actions, children }: PullNodeShellProps) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const min = NODE_MIN_SIZES[kind]
  // Lazy-loaded: React Flow measured the Suspense fallback, which has no handle, so its edges had no
  // anchor until the node resized. Re-measure once the real node (and its handle) is mounted.
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => updateNodeInternals(id), [id, updateNodeInternals])

  return (
    <>
    <div className={`pull-node${kind === 'issues' ? ' issues-node' : ''}${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer
        minWidth={min.width}
        minHeight={min.height}
        isVisible={selected}
        color={data.color}
        lineClassName="nt-resize-ghost"
        handleClassName="nt-resize-ghost"
      />
      {/* Invisible target handle so the opener's rope and context link (open-pr) can attach, as on
          the web node. React Flow draws no edge to a node without a handle. */}
      {kind === 'pull' && (
        <Handle
          id="flow-in"
          type="target"
          position={Position.Top}
          isConnectable={false}
          style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
        />
      )}
      {/* And a source handle for the rope to the agent "Work on this" started. */}
      <Handle
        id="flow-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', bottom: 0 }}
      />
      <div className="pull-node__header" style={{ background: `${data.color}33` }}>
        <span className="term-node__color" style={{ background: data.color }} />
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        {headerExtra}
        <span className="term-node__spacer" />
        {actions}
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
      </div>
      {children}
    </div>
    {/* The live resizer: a sibling AFTER the root, like every other node (see .nt-resize-ghost in
        styles.css). The one inside the root only paints, so without this the node never resized. */}
    <NodeResizer minWidth={min.width} minHeight={min.height} isVisible={selected} color={data.color} />
    </>
  )
}

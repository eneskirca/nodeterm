import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { BrowserSurface } from './BrowserSurface'

/**
 * A navigable Chromium browser node: node chrome (frame/header/resize/close) wrapping the shared
 * {@link BrowserSurface} (webview + toolbar). The last top-level URL persists to `data.url` so the
 * node reopens where it was; the same surface backs the kanban card modal's browser popup.
 */
export default function BrowserNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements, updateNodeData } = useReactFlow()

  return (
    <div className={`term-node browser-node${selected ? ' selected' : ''}`} style={{ borderTopColor: data.color }}>
      <NodeResizer minWidth={NODE_MIN_SIZES.browser.width} minHeight={NODE_MIN_SIZES.browser.height} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />
      {/* Invisible source handle so a rope to a browser node this one spawned (new-window) attaches. */}
      <Handle
        id="flow-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', bottom: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={(data.url as string) || ''}>
          {(data.title as string) || 'Browser'}
        </span>
        <span className="term-node__spacer" />
        <button className="term-node__close" title="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
          ×
        </button>
      </div>

      <div className="editor-node__body">
        <BrowserSurface
          nodeId={id}
          url={(data.url as string) ?? ''}
          onUrlChange={(u) => updateNodeData(id, { url: u })}
          onTitleChange={(t) => updateNodeData(id, { title: t })}
        />
      </div>
    </div>
  )
}

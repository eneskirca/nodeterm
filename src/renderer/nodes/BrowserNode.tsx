import type { GitHubLink } from '@shared/github-issues'
import { GitHubLinkChip } from '../components/github/GitHubLinkChip'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { BrowserSurface } from './BrowserSurface'
import { BrowserDrivingIndicator } from './BrowserDrivingChip'
import { useWebviewKeepAlive } from '../state/webviewKeepAlive'

/**
 * A navigable Chromium browser node: node chrome (frame/header/resize/close) wrapping the shared
 * {@link BrowserSurface} (webview + toolbar). The last top-level URL persists to `data.url` so the
 * node reopens where it was; the same surface backs the kanban card modal's browser popup.
 *
 * A background KEEP-ALIVE GHOST (`data.ghost` — see lib/webviewKeepAlive.ts) renders the same
 * tree (the mounted `<webview>` is the point), hidden by the ghost node's `display:none` style.
 * Only the wiring differs: navigation/title facts go to the pool entry (there is no live node in
 * React Flow to update — `updateNodeData` on a ghost id is a dropped change), and a memory-saver
 * discard ends the entry outright (a ghost without its guest is a husk holding a cap slot).
 */
export default function BrowserNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements, updateNodeData } = useReactFlow()
  const ghost = data.ghost === true

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
        {/* The driving chip — present the whole time an agent holds a control lease on this node,
            with the one obvious Stop. Renders nothing otherwise (and, until PR 7 ships the verb that
            drives a lease, in every case today). */}
        <BrowserDrivingIndicator nodeId={id} />
        <GitHubLinkChip nodeId={id} links={(data.github as GitHubLink[] | undefined) ?? []} variant="node" />
        <span className="term-node__spacer" />
        <button className="term-node__close" title="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
          ×
        </button>
      </div>

      <div className="editor-node__body">
        <BrowserSurface
          nodeId={id}
          url={(data.url as string) ?? ''}
          partition={data.partition as string | undefined}
          onUrlChange={(u) =>
            ghost ? useWebviewKeepAlive.getState().updateGhostData(id, { url: u }) : updateNodeData(id, { url: u })
          }
          onTitleChange={(t) =>
            ghost ? useWebviewKeepAlive.getState().updateGhostData(id, { title: t }) : updateNodeData(id, { title: t })
          }
          onGuestDiscarded={ghost ? () => useWebviewKeepAlive.getState().drop(id) : undefined}
        />
      </div>
    </div>
  )
}

import { Handle, NodeResizer, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { MaximizeButton } from './MaximizeButton'
import { IconClose } from '../components/icons'
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
  const dockTo = typeof data.dockTo === 'string' ? data.dockTo : undefined
  const canDock = useStore((st) => !ghost && !!dockTo && st.nodeLookup.get(dockTo)?.data?.runConfig !== undefined)

  return (
    <>
    <div className={`term-node browser-node${selected ? ' selected' : ''}`} style={{ borderTopColor: data.color }}>
      {/* Paint only: the old resize box in its old place (see .nt-resize-ghost in styles.css). */}
      <NodeResizer isVisible={selected} color={data.color} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
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
        <span className="term-node__spacer" />
        {/* Popped out of a run node's browser panel: dock it back. */}
        {canDock && (
          <Tooltip label="Dock back into its run node">
            <button
              className="term-node__close"
              aria-label="Dock into run node"
              onClick={() => window.dispatchEvent(new CustomEvent('nodeterm:dock-preview', { detail: { nodeId: id, runNodeId: data.dockTo } }))}
            >
              ⇲
            </button>
          </Tooltip>
        )}
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
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
    {/* Sibling of the root, not a child: under Liquid Glass the root has a backdrop-filter,
        which makes it the containing block for these absolute edges, so they were clipped and
        covered (only the top edge stayed grabbable). Out here they sit on the node wrapper.
        AFTER the root, never before it: focus mode reparents the root out of this wrapper, and
        React inserting a control "before the root" would then throw NotFoundError. */}
    <NodeResizer minWidth={NODE_MIN_SIZES.browser.width} minHeight={NODE_MIN_SIZES.browser.height} isVisible={selected} color={data.color} />
    </>
  )
}

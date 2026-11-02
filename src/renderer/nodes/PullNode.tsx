import { useEffect, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconClose, IconExternal, IconReload } from '../components/icons'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useSession } from '../session/session'
import { useOwningProjectId } from '../session/owning-project'
import { MaximizeButton } from './MaximizeButton'
import { PullNodeView } from './PullNodeView'
import { PULL_REFRESH_EVENT, pullWebUrl } from '@shared/pull-node'
import { usePullAgent } from '../state/pullAgent'
import { PULL_WORK_EVENT, type PullWorkRequest } from '@shared/pull-work'

/**
 * A pull request on the canvas: Overview, Files and Conversation tabs. Node data holds only the reference
 * (`data.pull`, shared/pull-node.ts); everything shown is read through the core's GitHub layer on
 * mount and on Refresh, and nothing read is ever persisted.
 */
export function PullNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const { api } = useSession()
  const owner = useOwningProjectId()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const projectId = owner ?? activeProjectId
  const [refreshTick, setRefreshTick] = useState(0)
  const pull = data.pull
  const proposal = usePullAgent((s) => s.proposal[id])
  const highlight = usePullAgent((s) => s.highlight[id])
  // Lazy-loaded: React Flow measured the Suspense fallback, which has no handle, so its edges had no
  // anchor until the node resized. Re-measure once the real node (and its handle) is mounted.
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => updateNodeInternals(id), [id, updateNodeInternals])

  useEffect(() => {
    const onRefresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) setRefreshTick((tick) => tick + 1)
    }
    window.addEventListener(PULL_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(PULL_REFRESH_EVENT, onRefresh)
  }, [id])

  return (
    <div className={`pull-node${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.pull.width}
        minHeight={NODE_MIN_SIZES.pull.height}
        isVisible={selected}
        color={data.color}
        lineClassName="nt-resize-ghost"
        handleClassName="nt-resize-ghost"
      />
      {/* Invisible target handle so the opener's rope and context link (open-pr) can attach, as on
          the web node. React Flow draws no edge to a node without a handle. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />
      {/* And a source handle for the rope to the agent "Work on this PR" started. */}
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
        <span className="term-node__spacer" />
        <Tooltip label="Refresh">
          <button
            className="term-node__maximize nodrag"
            aria-label="Refresh pull request"
            onClick={(e) => {
              e.stopPropagation()
              setRefreshTick((tick) => tick + 1)
            }}
          >
            <IconReload />
          </button>
        </Tooltip>
        {pull && (
          <Tooltip label="Open on GitHub">
            <button
              className="term-node__maximize nodrag"
              aria-label="Open on GitHub"
              onClick={(e) => {
                e.stopPropagation()
                void api.shell.openExternal(pullWebUrl(pull.repository, pull.pullNumber))
              }}
            >
              <IconExternal />
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
      <div className="pull-node__body nodrag nowheel">
        <PullNodeView
          api={api.githubIssues}
          projectId={projectId}
          pull={pull}
          refreshTick={refreshTick}
          onTab={(tab) => { if (pull) updateNodeData(id, { pull: { ...pull, tab } }) }}
          onSelectFile={(selectedFile) => { if (pull) updateNodeData(id, { pull: { ...pull, selectedFile } }) }}
          onOpenExternal={(url) => void api.shell.openExternal(url)}
          onWritten={() => setRefreshTick((tick) => tick + 1)}
          onOpenTerminal={(cmd) => window.dispatchEvent(new CustomEvent('nodeterm:open-terminal', { detail: { cmd, nearNodeId: id } }))}
          onWork={(detail) => window.dispatchEvent(new CustomEvent<PullWorkRequest>(PULL_WORK_EVENT, { detail: { nodeId: id, detail } }))}
          proposal={proposal}
          onDismiss={() => usePullAgent.getState().dismiss(id)}
          highlight={highlight}
        />
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
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

/**
 * A pull request on the canvas (ticket 01: the Overview). Node data holds only the reference
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
          onOpenExternal={(url) => void api.shell.openExternal(url)}
        />
      </div>
    </div>
  )
}

import { useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconClose, IconExternal, IconReload } from '../components/icons'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useSession } from '../session/session'
import { useOwningProjectId } from '../session/owning-project'
import { MaximizeButton } from './MaximizeButton'
import { IssuesNodeView } from './IssuesNodeView'
import { ISSUE_WORK_EVENT, issuesWebUrl, type IssueWorkRequest } from '@shared/issues-node'
import { PULL_OPEN_EVENT, type PullOpenRequest } from '../lib/openPullNode'

/**
 * The open issues of the folder's repository, with one issue's detail and comments beside the list.
 * Node data holds only the reference (`data.issues`, shared/issues-node.ts); everything shown is read
 * through the core's GitHub layer and never persisted. "Work on this" asks Canvas to start the
 * default agent on the issue; agents never write issues from here.
 */
export function IssuesNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const { api } = useSession()
  const owner = useOwningProjectId()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const projectId = owner ?? activeProjectId
  const [refreshTick, setRefreshTick] = useState(0)
  const issues = data.issues

  return (
    <>
    <div className={`pull-node issues-node${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.issues.width}
        minHeight={NODE_MIN_SIZES.issues.height}
        isVisible={selected}
        color={data.color}
        lineClassName="nt-resize-ghost"
        handleClassName="nt-resize-ghost"
      />
      {/* Invisible source handle so the rope to an agent it started can attach. */}
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
            aria-label="Refresh issues"
            onClick={(e) => {
              e.stopPropagation()
              setRefreshTick((tick) => tick + 1)
            }}
          >
            <IconReload />
          </button>
        </Tooltip>
        {issues && (
          <Tooltip label="Open on GitHub">
            <button
              className="term-node__maximize nodrag"
              aria-label="Open on GitHub"
              onClick={(e) => {
                e.stopPropagation()
                void api.shell.openExternal(issuesWebUrl(issues.repository))
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
        {issues
          ? (
            <IssuesNodeView
              api={api.githubIssues}
              projectId={projectId}
              issues={issues}
              refreshTick={refreshTick}
              onSelect={(issueNumber) => updateNodeData(id, { issues: { ...issues, issueNumber } })}
              onWork={(issue, worktree) => {
                const detail: IssueWorkRequest = { nodeId: id, issue, worktree }
                window.dispatchEvent(new CustomEvent(ISSUE_WORK_EVENT, { detail }))
              }}
              onOpenExternal={(url) => void api.shell.openExternal(url)}
              onOpenPull={(pullNumber) =>
                window.dispatchEvent(new CustomEvent<PullOpenRequest>(PULL_OPEN_EVENT, { detail: { pullNumber } }))}
            />
          )
          : <p className="pull-node__state">This node names no repository. Add the Issues node again.</p>}
      </div>
    </div>
    {/* The live resizer, a sibling after the root like every other node; the one inside only paints. */}
    <NodeResizer minWidth={NODE_MIN_SIZES.issues.width} minHeight={NODE_MIN_SIZES.issues.height} isVisible={selected} color={data.color} />
    </>
  )
}

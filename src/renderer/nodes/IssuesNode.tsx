import './pull/pull-node.css'
import { useState } from 'react'
import { useReactFlow, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconExternal, IconReload } from '../components/icons'
import { PullNodeShell } from './pull/PullNodeShell'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useSession } from '../session/session'
import { useOwningProjectId } from '../session/owning-project'
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
  const { updateNodeData } = useReactFlow()
  const { api } = useSession()
  const owner = useOwningProjectId()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const projectId = owner ?? activeProjectId
  const [refreshTick, setRefreshTick] = useState(0)
  const issues = data.issues

  return (
    <PullNodeShell
      id={id}
      data={data}
      selected={!!selected}
      kind="issues"
      actions={<>
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
      </>}
    >
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
    </PullNodeShell>
  )
}

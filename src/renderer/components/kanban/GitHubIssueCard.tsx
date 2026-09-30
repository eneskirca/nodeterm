import { memo, useState } from 'react'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type { GitHubPullStatus, PullStatusFreshness } from '@shared/github-pull-status'
import type { KanbanColumn } from '@shared/types'
import { updatedRelative } from '../../lib/relativeTime'
import { PullRefChip } from './PullStatusBadges'
import { NO_ISSUE_RUNS, type IssueRun } from '../../lib/issueRuns'
import { IssueRunChips } from './IssueRunChips'
import { DispatchChip } from './DispatchChip'

export const GitHubIssueCard = memo(function GitHubIssueCard({
  issue,
  columns,
  moving,
  readOnly,
  status,
  pulls,
  pullFreshness = 'fresh',
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
  runs = NO_ISSUE_RUNS,
  onOpenRun,
  onContext
}: {
  issue: GitHubIssueCardView
  columns: KanbanColumn[]
  moving: boolean
  readOnly: boolean
  status?: string
  /** Open PRs that close this issue on merge (GitHub's own link). */
  pulls?: GitHubPullStatus[]
  pullFreshness?: PullStatusFreshness
  onOpen: (issue: GitHubIssueCardView) => void
  onMove: (issue: GitHubIssueCardView, columnId: string | null) => void
  onDragStart: (issue: GitHubIssueCardView) => void
  onDragEnd: () => void
  /** Agent sessions bound to this issue (started on it). Shown as live chips; empty = none. */
  runs?: readonly IssueRun[]
  /** Open a bound session's card (a chip click). */
  onOpenRun?: (nodeId: string) => void
  /** Right-click: the issue card's menu ("Start with agent ▸", Open on GitHub). */
  onContext?: (issue: GitHubIssueCardView, x: number, y: number) => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  return (
    <article
      className={`kanban-card kanban-card--github${dragging ? ' kanban-card--dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Open GitHub issue #${issue.number}: ${issue.title}`}
      draggable={!moving && !readOnly}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        onDragStart(issue)
      }}
      onDragEnd={() => {
        setDragging(false)
        onDragEnd()
      }}
      onClick={() => onOpen(issue)}
      onContextMenu={onContext ? (event) => {
        event.preventDefault()
        event.stopPropagation()
        onContext(issue, event.clientX, event.clientY)
      } : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        if ((event.target as HTMLElement).closest('select')) return
        event.preventDefault()
        onOpen(issue)
      }}
    >
      <div className="kanban-card__row">
        <span className={`github-issue-state github-issue-state--${issue.state}`} aria-hidden="true" />
        <span className="kanban-card__title">{issue.title}</span>
        <span className="github-issue-source" title="GitHub issue">GH</span>
      </div>
      <div className="github-issue-card__number">#{issue.number}</div>
      {pulls && pulls.length > 0 && (
        <div className="pull-refs">
          {pulls.slice(0, 3).map((pull) => (
            <PullRefChip key={pull.number} status={pull} freshness={pullFreshness} />
          ))}
        </div>
      )}
      {issue.labels.length > 0 && (
        <div className="github-issue-card__labels">
          {issue.labels.slice(0, 5).map((label) => (
            <span
              key={label.id}
              className="github-issue-label"
              style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}
            >
              {label.name}
            </span>
          ))}
          {issue.labels.length > 5 && <span className="github-issue-label">+{issue.labels.length - 5}</span>}
        </div>
      )}
      {onOpenRun && <IssueRunChips runs={runs} onOpen={onOpenRun} />}
      <DispatchChip htmlUrl={issue.htmlUrl} number={issue.number} />
      <div className="github-issue-card__footer">
        <span>{moving ? 'Syncing…' : updatedRelative(issue.updatedAt)}</span>
        {issue.conflict && <span className="github-issue-conflict">Needs a column</span>}
        {issue.assignees.length > 0 && (
          <span className="kanban-card__avatars">
            {issue.assignees.slice(0, 3).map((assignee) => {
              const avatar = issue.avatarDataUrls?.[String(assignee.id)]
              return avatar ? (
                <img key={assignee.id} className="github-issue-avatar" src={avatar} alt={assignee.login} />
              ) : (
                <span key={assignee.id} className="github-issue-avatar github-issue-avatar--initial" title={assignee.login}>
                  {(assignee.login[0] ?? '?').toUpperCase()}
                </span>
              )
            })}
          </span>
        )}
        <label className="github-issue-move" onClick={(event) => event.stopPropagation()}>
          <span className="sr-only">Move issue #{issue.number}</span>
          <select
            aria-label={`Move issue #${issue.number}`}
            value={issue.columnId ?? ''}
            disabled={moving || readOnly}
            onChange={(event) => onMove(issue, event.target.value || null)}
          >
            <option value="">Ungrouped</option>
            {columns.map((column) => (
              <option key={column.id} value={column.id}>{column.title}</option>
            ))}
          </select>
        </label>
      </div>
      {status && <div className="github-issue-card__status" role="status">{status}</div>}
    </article>
  )
})

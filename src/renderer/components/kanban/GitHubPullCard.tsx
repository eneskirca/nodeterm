import { memo } from 'react'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { PULL_STATE_LABEL, pullCardState } from '../../lib/githubPull'
import { updatedRelative } from '../../lib/relativeTime'

/** A pull request on the board. The `pulls` source is `readOnly`, so this card carries no drag
 *  and no move control — its column is derived from the PR's own labels and state, and there is
 *  nothing here the board could write back. */
export const GitHubPullCard = memo(function GitHubPullCard({
  pull,
  onOpen
}: {
  pull: GitHubIssueCardView
  onOpen: (pull: GitHubIssueCardView) => void
}): React.JSX.Element {
  const state = pullCardState(pull)
  return (
    <article
      className="kanban-card kanban-card--github kanban-card--pull"
      role="button"
      tabIndex={0}
      aria-label={`Open pull request #${pull.number}: ${pull.title}`}
      onClick={() => onOpen(pull)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(pull)
      }}
    >
      <div className="kanban-card__row">
        <span className={`github-pull-state github-pull-state--${state}`} aria-hidden="true" />
        <span className="kanban-card__title">{pull.title}</span>
        <span className="github-issue-source" title="GitHub pull request">PR</span>
      </div>
      <div className="github-issue-card__number">
        #{pull.number}
        <span className={`github-pull-badge github-pull-badge--${state}`}>{PULL_STATE_LABEL[state]}</span>
      </div>
      {pull.labels.length > 0 && (
        <div className="github-issue-card__labels">
          {pull.labels.slice(0, 5).map((label) => (
            <span
              key={label.id}
              className="github-issue-label"
              style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}
            >
              {label.name}
            </span>
          ))}
          {pull.labels.length > 5 && <span className="github-issue-label">+{pull.labels.length - 5}</span>}
        </div>
      )}
      <div className="github-issue-card__footer">
        <span>{updatedRelative(pull.updatedAt)}</span>
        {pull.assignees.length > 0 && (
          <span className="kanban-card__avatars">
            {pull.assignees.slice(0, 3).map((assignee) => {
              const avatar = pull.avatarDataUrls?.[String(assignee.id)]
              return avatar ? (
                <img key={assignee.id} className="github-issue-avatar" src={avatar} alt={assignee.login} />
              ) : (
                <span
                  key={assignee.id}
                  className="github-issue-avatar github-issue-avatar--initial"
                  title={assignee.login}
                >
                  {(assignee.login[0] ?? '?').toUpperCase()}
                </span>
              )
            })}
          </span>
        )}
      </div>
    </article>
  )
})

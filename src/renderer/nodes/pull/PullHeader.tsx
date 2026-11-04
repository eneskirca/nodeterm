import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { PullLifecycle } from '@shared/github-pull-status'
import type { PullNodeRef } from '@shared/pull-node'
import { mergeLabel } from '../../components/kanban/PullStatusBadges'

const LIFECYCLE_TEXT: Record<PullLifecycle, string> = {
  open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed'
}

/** The PR at a glance, above the tabs: title, number, state, author and "base <- head". Before the
 *  detail read lands it names only the repository and number. */
export function PullHeader({ pull, detail: d }: { pull: PullNodeRef; detail: GitHubPullDetail | undefined }): React.JSX.Element {
  if (!d) {
    return (
      <header className="pull-head">
        <h3 className="pull-node__title">{pull.repository} <span className="pull-node__number">#{pull.pullNumber}</span></h3>
      </header>
    )
  }
  const merge = d.lifecycle === 'open' || d.lifecycle === 'draft' ? mergeLabel(d.merge) : null
  return (
    <header className="pull-head">
      <h3 className="pull-node__title">
        {d.title} <span className="pull-node__number">#{d.number}</span>
      </h3>
      <div className="pull-node__meta">
        <span className={`pull-node__lifecycle pull-node__lifecycle--${d.lifecycle}`}>{LIFECYCLE_TEXT[d.lifecycle]}</span>
        {d.author && <span className="pull-node__author">{d.author.login}</span>}
        <span className="pull-node__branches">
          <code>{d.base.ref}</code> ← <code>{d.head.ref}</code>
        </span>
        <span className="pull-node__size">
          +{d.additions} −{d.deletions} · {d.changedFiles} {d.changedFiles === 1 ? 'file' : 'files'}
        </span>
        {merge && <span className={`pull-status__merge pull-status__merge--${d.merge}`}>{merge}</span>}
      </div>
    </header>
  )
}

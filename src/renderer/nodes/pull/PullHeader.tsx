import type { GitHubPullDetail, PullAvatarDataUrls } from '@shared/github-pull-detail'
import type { PullLifecycle } from '@shared/github-pull-status'
import type { PullNodeRef } from '@shared/pull-node'
import { Avatar } from './Avatar'
import { Icon, type IconName } from './Icon'

const LIFECYCLE: Record<PullLifecycle, { text: string; icon: IconName }> = {
  open: { text: 'Open', icon: 'pr' },
  draft: { text: 'Draft', icon: 'draft' },
  merged: { text: 'Merged', icon: 'merged' },
  closed: { text: 'Closed', icon: 'closed' }
}

/** The PR's state as a filled pill with its icon (F1, F4). */
export function PullStatePill({ lifecycle }: { lifecycle: PullLifecycle }): React.JSX.Element {
  const { text, icon } = LIFECYCLE[lifecycle]
  return <span className={`pr-state pr-state--${lifecycle}`}><Icon name={icon} size={14} />{text}</span>
}

/** The PR at a glance, above the readiness bar (F1): title and number with the lead action beside
 *  them, then state, author and "wants to merge N commits into base from head". Before the detail
 *  read lands it names only the repository and number. */
export function PullHeader({ pull, detail: d, avatars, action, onCopy }: {
  pull: PullNodeRef; detail: GitHubPullDetail | undefined; avatars?: PullAvatarDataUrls
  /** The NextAction button and its menu, top right. */
  action?: React.ReactNode
  onCopy?: (text: string) => void
}): React.JSX.Element {
  if (!d) {
    return (
      <header className="pr-head">
        <h3 className="pr-head__title">{pull.repository} <span className="pr-head__number">#{pull.pullNumber}</span></h3>
      </header>
    )
  }
  const commits = d.commits === undefined ? '' : ` ${d.commits} ${d.commits === 1 ? 'commit' : 'commits'}`
  return (
    <header className="pr-head">
      <div className="pr-head__top">
        <h3 className="pr-head__title">{d.title} <span className="pr-head__number">#{d.number}</span></h3>
        {action}
      </div>
      <div className="pr-head__meta">
        <PullStatePill lifecycle={d.lifecycle} />
        {d.author && <Avatar user={d.author} avatars={avatars} size={18} />}
        <span className="pr-head__sentence">
          {d.author && <span className="pr-head__author">{d.author.login}</span>}
          {d.lifecycle === 'merged' ? ' merged' : ' wants to merge'}{commits} into <code className="pr-branch">{d.base.ref}</code> from{' '}
          <code className="pr-branch">{d.head.ref}</code>
        </span>
        {onCopy && (
          <button type="button" className="pr-btn pr-btn--ghost pr-btn--small" aria-label="Copy branch name" title="Copy branch name"
            onClick={() => onCopy(d.head.ref)}>
            <Icon name="copy" size={14} />
          </button>
        )}
      </div>
    </header>
  )
}

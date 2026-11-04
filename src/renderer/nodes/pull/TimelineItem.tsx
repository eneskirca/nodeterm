// One GitHub timeline entry (a comment, a review, a commit or an event) with its avatar, actor and
// time. Takes no pull-only props, so the issues node can render its own timeline with it.
import type { PullAvatarDataUrls, PullReviewVerdict } from '@shared/github-pull-detail'
import type { PullTimelineItem } from '@shared/github-pull-timeline'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { Avatar } from './Avatar'

const VERDICT_TEXT: Record<PullReviewVerdict, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'
}

const short = (oid: string | null): string => oid ? oid.slice(0, 7) : 'an unknown commit'

/** A label as a colored chip. ponytail: inline color; the sidebar (ticket 06) may own a shared chip. */
export function LabelChip({ label }: { label: { name: string; color: string } }): React.JSX.Element {
  return <span className="pull-label" style={{ background: `#${label.color}` }}>{label.name}</span>
}

/** What an event says after its actor's login. */
function eventText(item: PullTimelineItem): React.ReactNode {
  switch (item.kind) {
    case 'commit': return <>added <code>{short(item.oid)}</code> {item.headline}</>
    case 'force-push': return <>force-pushed from <code>{short(item.before)}</code> to <code>{short(item.after)}</code></>
    case 'labeled': return <>added the <LabelChip label={item.label} /> label</>
    case 'unlabeled': return <>removed the <LabelChip label={item.label} /> label</>
    case 'review-requested': return <>requested a review from <strong>{item.reviewer ?? 'someone'}</strong></>
    case 'assigned': return <>assigned <strong>{item.assignee?.login ?? 'ghost'}</strong></>
    case 'unassigned': return <>unassigned <strong>{item.assignee?.login ?? 'ghost'}</strong></>
    case 'closed': return 'closed this'
    case 'reopened': return 'reopened this'
    case 'merged': return <>merged commit <code>{short(item.oid)}</code> into <code>{item.base}</code></>
    case 'ready-for-review': return 'marked this as ready for review'
    case 'converted-to-draft': return 'marked this as a draft'
    case 'cross-referenced':
      return <>mentioned this in {item.source.pull ? 'pull request' : 'issue'} <strong>{item.source.repository}#{item.source.number}</strong> {item.source.title}</>
    default: return null
  }
}

/** One entry. `children` render under a comment or review body (a review's line comments). */
export function TimelineItem({ item, avatars, children }: {
  item: PullTimelineItem; avatars?: PullAvatarDataUrls; children?: React.ReactNode
}): React.JSX.Element {
  const head = (
    <div className="pull-convo__head">
      <span className="pull-person">
        <Avatar user={item.actor} avatars={avatars} />
        <span className="pull-node__author">{item.actor?.login ?? 'ghost'}</span>
      </span>
      {item.kind === 'review' && (
        <span className={`pull-convo__verdict pull-convo__verdict--${item.verdict}`}>{VERDICT_TEXT[item.verdict]}</span>
      )}
      {item.kind !== 'comment' && item.kind !== 'review' && <span className="pull-convo__event-text">{eventText(item)}</span>}
      <time className="pull-convo__time" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
    </div>
  )
  if (item.kind !== 'comment' && item.kind !== 'review') {
    return <li className={`pull-convo__event pull-convo__item--${item.kind}`}>{head}</li>
  }
  return (
    <li className={`pull-convo__item pull-convo__item--${item.kind}`}>
      {head}
      {item.body.trim() && <NoteMarkdown text={item.body} className="sticky-node__md pull-node__md" />}
      {children}
    </li>
  )
}

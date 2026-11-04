// One GitHub timeline entry (a comment, a review, a commit or an event) with its avatar, actor and
// time. Takes no pull-only props, so the issues node can render its own timeline with it.
import type { PullAvatarDataUrls, PullReviewVerdict } from '@shared/github-pull-detail'
import type { PullTimelineItem } from '@shared/github-pull-timeline'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { Avatar } from './Avatar'
import { LabelChip } from './LabelChip'

const VERDICT_TEXT: Record<PullReviewVerdict, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'
}

const short = (oid: string | null): string => oid ? oid.slice(0, 7) : 'an unknown commit'

type CrossReference = Extract<PullTimelineItem, { kind: 'cross-referenced' }>['source']

/** What an event says after its actor's login. `onOpenSource` makes a cross-reference's name a link. */
function eventText(item: PullTimelineItem, onOpenSource?: (source: CrossReference) => void): React.ReactNode {
  switch (item.kind) {
    case 'commit': return <>added <code>{short(item.oid)}</code> {item.headline}</>
    case 'force-push': return <>force-pushed from <code>{short(item.before)}</code> to <code>{short(item.after)}</code></>
    case 'labeled': return <>added the <LabelChip {...item.label} /> label</>
    case 'unlabeled': return <>removed the <LabelChip {...item.label} /> label</>
    case 'review-requested': return <>{item.reviewer ? <>requested a review from <strong>{item.reviewer}</strong></> : 'requested a review'}</>
    case 'assigned': return <>assigned <strong>{item.assignee?.login ?? 'ghost'}</strong></>
    case 'unassigned': return <>unassigned <strong>{item.assignee?.login ?? 'ghost'}</strong></>
    case 'closed': return 'closed this'
    case 'reopened': return 'reopened this'
    case 'merged': return <>merged commit <code>{short(item.oid)}</code> into <code>{item.base}</code></>
    case 'ready-for-review': return 'marked this as ready for review'
    case 'converted-to-draft': return 'marked this as a draft'
    case 'cross-referenced': {
      const name = `${item.source.repository}#${item.source.number}`
      return <>mentioned this in {item.source.pull ? 'pull request' : 'issue'} {onOpenSource
        ? <button className="pull-convo__ref" onClick={() => onOpenSource(item.source)}>{name}</button>
        : <strong>{name}</strong>} {item.source.title}</>
    }
    default: return null
  }
}

/** One entry. `children` render under a comment or review body (a review's line comments). */
export function TimelineItem({ item, avatars, children, onOpenSource }: {
  item: PullTimelineItem; avatars?: PullAvatarDataUrls; children?: React.ReactNode
  /** Opens a cross-reference's source (the issues node: a PR here as a node, else on GitHub). */
  onOpenSource?: (source: CrossReference) => void
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
      {item.kind !== 'comment' && item.kind !== 'review' && <span className="pull-convo__event-text">{eventText(item, onOpenSource)}</span>}
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

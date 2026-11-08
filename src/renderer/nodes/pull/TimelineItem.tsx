// One GitHub timeline entry (a comment, a review, a commit or an event) with its avatar, actor and
// time. Takes no pull-only props, so the issues node can render its own timeline with it.
import type { PullAvatarDataUrls, PullReviewVerdict } from '@shared/github-pull-detail'
import type { PullTimelineItem } from '@shared/github-pull-timeline'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { Avatar } from './Avatar'
import { Icon, type IconName } from './Icon'
import { LabelChip } from './LabelChip'

const VERDICT_TEXT: Record<PullReviewVerdict, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'
}

const short = (oid: string | null): string => oid ? oid.slice(0, 7) : 'an unknown commit'

/** The F1 icon dot of each event in the card layout. */
const EVENT_ICON: Record<Exclude<PullTimelineItem['kind'], 'comment' | 'review'>, IconName> = {
  commit: 'commit', 'force-push': 'sync', labeled: 'tag', unlabeled: 'tag', 'review-requested': 'eye', assigned: 'note',
  unassigned: 'note', closed: 'closed', reopened: 'pr', merged: 'merged', 'ready-for-review': 'eye', 'converted-to-draft': 'draft',
  'cross-referenced': 'link'
}

/** "Oct 31" this year, "Oct 31, 2025" before; the full time is the tooltip. */
export function shortDate(at: string): string {
  const date = new Date(at)
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' })
  })
}

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

/** One entry. `children` render under a comment or review body (a review's line comments).
 *  `card` (the pull node, F1): a comment or review is a card beside a 32 px avatar, an event a
 *  compact row behind a 24 px icon dot. Without it the entry keeps the issues node's look. */
export function TimelineItem({ item, avatars, children, onOpenSource, card, badge }: {
  item: PullTimelineItem; avatars?: PullAvatarDataUrls; children?: React.ReactNode
  /** Opens a cross-reference's source (the issues node: a PR here as a node, else on GitHub). */
  onOpenSource?: (source: CrossReference) => void
  card?: boolean
  /** Card layout: shown at the right of a comment or review head (a review's open thread count). */
  badge?: React.ReactNode
}): React.JSX.Element {
  const isEvent = item.kind !== 'comment' && item.kind !== 'review'
  const head = (
    <div className="pull-convo__head">
      {card && !isEvent
        ? <span className="pull-node__author">{item.actor?.login ?? 'ghost'}</span>
        : (
          <span className="pull-person">
            <Avatar user={item.actor} avatars={avatars} size={card ? 16 : 20} />
            <span className="pull-node__author">{item.actor?.login ?? 'ghost'}</span>
          </span>
        )}
      {item.kind === 'review' && (
        <span className={`pull-convo__verdict pull-convo__verdict--${item.verdict}`}>{VERDICT_TEXT[item.verdict]}</span>
      )}
      {card && item.kind === 'comment' && <span className="pull-convo__event-text">commented</span>}
      {isEvent && <span className="pull-convo__event-text">{eventText(item, onOpenSource)}</span>}
      <time className="pull-convo__time" dateTime={item.at} title={card ? new Date(item.at).toLocaleString() : undefined}>
        {card ? shortDate(item.at) : new Date(item.at).toLocaleString()}
      </time>
      {card && badge}
    </div>
  )
  if (item.kind !== 'comment' && item.kind !== 'review') {
    return (
      <li className={`pull-convo__event pull-convo__item--${item.kind}`}>
        {card && <span className={`pr-tl__dot pr-tl__dot--${item.kind}`}><Icon name={EVENT_ICON[item.kind]} size={14} /></span>}
        {head}
      </li>
    )
  }
  const body = item.body.trim() && <NoteMarkdown text={item.body} className="sticky-node__md pull-node__md" />
  if (card) {
    return (
      <li className={`pull-convo__item pull-convo__item--${item.kind} pr-tl__entry`}>
        <Avatar user={item.actor} avatars={avatars} size={32} />
        <div className="pr-card">{head}{body}{children}</div>
      </li>
    )
  }
  return (
    <li className={`pull-convo__item pull-convo__item--${item.kind}`}>
      {head}
      {body}
      {children}
    </li>
  )
}

import type { GitHubPullConversationResult, PullReviewVerdict } from '@shared/github-pull-detail'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { readState, STALE_TEXT, type Read } from './shared'

const VERDICT_TEXT: Record<PullReviewVerdict, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'
}

/** The Conversation tab's timeline: comments and reviews, oldest first, each review with its line
 *  comments. Ticket 04 grows it into the full GitHub timeline. */
export function PullTimeline({ result, repository }: {
  result: Read<GitHubPullConversationResult>; repository: string
}): React.JSX.Element {
  if (result === 'loading' || result.status !== 'ok') return readState(result, repository)
  return (
    <>
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {result.truncated && <p className="pull-node__empty">Showing the first items only. Open on GitHub for the rest.</p>}
      {result.items.length === 0
        ? <p className="pull-node__empty">No comments or reviews yet.</p>
        : (
          <ol className="pull-convo">
            {result.items.map((item) => (
              <li key={`${item.kind}-${item.id}`} className={`pull-convo__item pull-convo__item--${item.kind}`}>
                <div className="pull-convo__head">
                  <span className="pull-node__author">{item.author?.login ?? 'ghost'}</span>
                  {item.kind === 'review' && (
                    <span className={`pull-convo__verdict pull-convo__verdict--${item.verdict}`}>{VERDICT_TEXT[item.verdict]}</span>
                  )}
                  <time className="pull-convo__time" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
                </div>
                {item.body.trim() && <NoteMarkdown text={item.body} className="sticky-node__md pull-node__md" />}
                {item.kind === 'review' && (
                  <ul className="pull-convo__lines">
                    {result.lineComments.filter((line) => line.reviewId === item.id).map((line) => (
                      <li key={line.id}>
                        <code>{line.path}{line.line !== null && `:${line.line}`}</code>
                        {line.outdated && <span className="pull-line__outdated">Outdated</span>}
                        <NoteMarkdown text={line.body} className="sticky-node__md pull-node__md" />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
    </>
  )
}

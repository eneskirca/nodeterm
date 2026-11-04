import { useEffect, useRef, useState } from 'react'
import type { GitHubPullDetail, PullAvatarDataUrls, PullLineComment } from '@shared/github-pull-detail'
import type { GitHubPullTimelineResult, PullTimelineItem } from '@shared/github-pull-timeline'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { pullLineThreads, type PullLineThread } from '../../lib/pullLineThreads'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { useSendTo } from './SendTo'
import { shortDate, TimelineItem } from './TimelineItem'
import { FAILURE_TEXT, readState, STALE_TEXT, usePullRead, useWrite, WRITE_TEXT, type ViewProps } from './shared'

/** The pages read after the first, tied to the first page they continue (a refresh starts over). */
type More = {
  base: GitHubPullTimelineResult; items: PullTimelineItem[]; next?: string; avatars?: PullAvatarDataUrls
  busy: boolean; failed?: string
}

type Entry = { kind: 'item'; item: PullTimelineItem } | { kind: 'commits'; commits: Extract<PullTimelineItem, { kind: 'commit' }>[] }

type Thread = PullLineThread & { path: string }

/** Every line comment thread, keyed by the review its first comment was posted in. */
function threadsByReview(lines: readonly PullLineComment[]): Map<number | null, Thread[]> {
  const byReview = new Map<number | null, Thread[]>()
  for (const path of [...new Set(lines.map((line) => line.path))].sort()) {
    for (const thread of pullLineThreads(lines, path)) {
      const review = (thread.comments.find((c) => c.id === thread.id) ?? thread.comments[0]).reviewId
      byReview.set(review, [...(byReview.get(review) ?? []), { ...thread, path }])
    }
  }
  return byReview
}

/** Commits pushed one after another read as one entry, as on GitHub. */
function group(items: readonly PullTimelineItem[]): Entry[] {
  const entries: Entry[] = []
  for (const item of items) {
    const last = entries[entries.length - 1]
    if (item.kind === 'commit' && last?.kind === 'commits') last.commits.push(item)
    else entries.push(item.kind === 'commit' ? { kind: 'commits', commits: [item] } : { kind: 'item', item })
  }
  return entries
}

/** The Conversation tab's timeline (F1): the description card first, then every GitHub timeline entry
 *  oldest first: comments and reviews as cards, events as compact rows, each review with its line
 *  comment threads (Reply, Resolve, Send to…). More pages load when the end of the list scrolls into view. */
export function PullTimeline({ detail, detailAvatars, lineComments, resolvedThreads, ...props }: ViewProps & {
  detail: GitHubPullDetail; detailAvatars?: PullAvatarDataUrls; lineComments: readonly PullLineComment[]
  /** First comment ids of resolved threads; undefined = unknown (no Resolve, no open count). */
  resolvedThreads?: readonly number[]
}): React.JSX.Element {
  const { api, projectId, pull } = props
  const first = usePullRead(api.pullTimeline, props)
  const [more, setMore] = useState<More | null>(null)
  const ok = first !== 'loading' && first.status === 'ok' ? first : undefined
  const extra = ok && more?.base === ok ? more : undefined
  const cursor = extra ? extra.next : ok?.next
  const busy = extra?.busy === true
  const sentinel = useRef<HTMLButtonElement>(null)
  const loadMore = () => {
    if (!ok || !cursor || busy) return
    const before: More = extra ?? { base: ok, items: [], busy: false }
    const stop = (failed = FAILURE_TEXT.unreachable) => setMore({ ...before, next: cursor, busy: false, failed })
    setMore({ ...before, next: cursor, busy: true, failed: undefined })
    api.pullTimeline(projectId, pull.repository, pull.pullNumber, cursor).then((page) => {
      if (page.status === 'failed') return stop(FAILURE_TEXT[page.reason])
      if (page.status !== 'ok') return stop()
      setMore({
        base: ok, items: [...before.items, ...page.items], next: page.next,
        avatars: { ...before.avatars, ...page.avatarDataUrls }, busy: false
      })
    }, () => stop())
  }
  // The end of the list in view reads the next page; a new cursor re-arms it, so a short page chains on.
  useEffect(() => {
    const element = sentinel.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((seen) => { if (seen.some((entry) => entry.isIntersecting)) element.click() })
    observer.observe(element)
    return () => observer.disconnect()
  }, [cursor, busy])
  const avatars = { ...detailAvatars, ...ok?.avatarDataUrls, ...extra?.avatars }
  const items = ok ? [...ok.items, ...(extra?.items ?? [])] : []
  const threads = threadsByReview(lineComments)
  const resolved = resolvedThreads && new Set(resolvedThreads)
  return (
    <>
      <ol className="pull-convo">
        <li className="pull-convo__item pull-convo__item--description pr-tl__entry">
          <Avatar user={detail.author} avatars={avatars} size={32} />
          <div className="pr-card">
            <div className="pull-convo__head">
              <span className="pull-node__author">{detail.author?.login ?? 'ghost'}</span>
              <span className="pull-convo__event-text">opened this pull request</span>
              {ok && <time className="pull-convo__time" dateTime={ok.openedAt} title={new Date(ok.openedAt).toLocaleString()}>{shortDate(ok.openedAt)}</time>}
              <span className="pr-tl__badge">Author</span>
            </div>
            {detail.body.trim()
              ? <NoteMarkdown text={detail.body} className="sticky-node__md pull-node__md" />
              : <p className="pull-node__empty">No description provided.</p>}
          </div>
        </li>
        {group(items).map((entry) => {
          if (entry.kind === 'commits') {
            const { commits } = entry
            return (
              <li key={commits[0].id} className="pull-convo__event pull-convo__item--commits">
                <span className="pr-tl__dot"><Icon name="commit" size={14} /></span>
                <div className="pr-tl__body">
                  <div className="pull-convo__head">
                    {/* ponytail: the first commit's actor names the push; GitHub's own entry does the same. */}
                    <span className="pull-person">
                      <Avatar user={commits[0].actor} avatars={avatars} size={16} />
                      <span className="pull-node__author">{commits[0].actor?.login ?? 'ghost'}</span>
                    </span>
                    <span className="pull-convo__event-text">
                      {commits.length === 1 ? '1 commit' : `${commits.length} commits`} pushed
                    </span>
                    <time className="pull-convo__time" dateTime={commits.at(-1)!.at} title={new Date(commits.at(-1)!.at).toLocaleString()}>
                      {shortDate(commits.at(-1)!.at)}
                    </time>
                  </div>
                  <ul className="pull-convo__commits">
                    {commits.map((commit) => (
                      <li key={commit.id} className="pull-person">
                        <Avatar user={commit.actor} avatars={avatars} size={16} />
                        <span className="pull-convo__headline">{commit.headline}</span>
                        <code>{commit.oid.slice(0, 7)}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            )
          }
          const { item } = entry
          const mine = item.kind === 'review' ? threads.get(item.databaseId) ?? [] : []
          const open = resolved ? mine.filter((thread) => !resolved.has(thread.id)).length : 0
          return (
            <TimelineItem key={item.id} item={item} avatars={avatars} card
              badge={open > 0 && <span className="pr-tl__open"><Icon name="thread" size={14} />{open} open</span>}>
              {mine.length > 0 && (
                <ul className="pull-convo__lines">
                  {mine.map((thread) => (
                    <ThreadCard key={thread.id} {...props} thread={thread} avatars={avatars}
                      resolved={resolved && resolved.has(thread.id)} />
                  ))}
                </ul>
              )}
            </TimelineItem>
          )
        })}
      </ol>
      {first !== 'loading' && first.status !== 'ok' && readState(first, pull.repository)}
      {first === 'loading' && <p className="pull-node__state">Loading the timeline…</p>}
      {ok?.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[ok.stale]}</p>}
      {ok && items.length === 0 && <p className="pull-node__empty">No comments or reviews yet.</p>}
      {extra?.failed && <p className="pull-node__stale" role="status">{extra.failed}</p>}
      {cursor && (
        <button ref={sentinel} className="pull-node__web" disabled={busy} onClick={loadMore}>
          {busy ? 'Loading more…' : 'Load more'}
        </button>
      )}
    </>
  )
}

/** One line comment thread inside its review card (F1): file:line, the comments, then Reply (a box
 *  under it), Resolve / Unresolve (when the read said which threads are resolved) and Send to….
 *  A resolved thread shows its head only. */
function ThreadCard(props: ViewProps & { thread: Thread; avatars: PullAvatarDataUrls; resolved: boolean | undefined }): React.JSX.Element {
  const { api, projectId, pull, thread, avatars, resolved, onWritten } = props
  const { sendTo, why } = useSendTo()
  const [reply, setReply] = useState<string | null>(null)
  const replyWrite = useWrite(() => { setReply(null); onWritten() })
  const resolveWrite = useWrite(onWritten)
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const refusal = replyWrite.refusal ?? resolveWrite.refusal
  return (
    <li className={`pr-thread${resolved ? ' pr-thread--resolved' : ''}`}>
      <div className="pr-thread__head">
        <code>{thread.path}{thread.line !== null && `:${thread.line}`}</code>
        {thread.outdated && <span className="pull-line__outdated">Outdated</span>}
        {resolved && <span className="pull-line__outdated pull-line__resolved">Resolved</span>}
      </div>
      {!resolved && thread.comments.map((comment) => (
        <div key={comment.id} className="pr-thread__comment">
          <span className="pull-person">
            <Avatar user={comment.author} avatars={avatars} size={16} />
            <span className="pull-node__author">{comment.author?.login ?? 'ghost'}</span>
          </span>
          <NoteMarkdown text={comment.body} className="sticky-node__md pull-node__md" />
        </div>
      ))}
      {reply !== null && (
        <textarea className="pull-compose__box pr-thread__box" aria-label="Reply" placeholder="Reply" autoFocus
          value={reply} onChange={(event) => setReply(event.target.value)} />
      )}
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pr-thread__actions">
        {reply === null
          ? !resolved && <button className="pr-btn pr-btn--sm" onClick={() => setReply('')}>Reply</button>
          : (
            <>
              <button className="pr-btn pr-btn--sm pr-btn--primary" disabled={replyWrite.busy || !reply.trim()}
                onClick={() => void replyWrite.run(() => api.commentOnPullLine({ ...at, inReplyTo: thread.id, body: reply }))}>Reply</button>
              <button className="pr-btn pr-btn--sm" disabled={replyWrite.busy} onClick={() => setReply(null)}>Cancel</button>
            </>
          )}
        {resolved !== undefined && (
          <button className="pr-btn pr-btn--sm" disabled={resolveWrite.busy}
            onClick={() => void resolveWrite.run(() => api.setReviewThreadResolved({ ...at, threadId: thread.id, resolved: !resolved }))}>
            {resolved ? 'Unresolve' : 'Resolve'}
          </button>
        )}
        {!resolved && (
          <button className="pr-btn pr-btn--sm pr-send-btn" disabled={!sendTo} title={why}
            onClick={() => sendTo?.({ kind: 'threads', threads: [{ id: thread.id, path: thread.path, line: thread.line }] })}>
            <Icon name="agent" size={14} />Send to…
          </button>
        )}
      </div>
    </li>
  )
}

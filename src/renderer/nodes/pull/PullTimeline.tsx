import { useEffect, useRef, useState } from 'react'
import type { GitHubPullDetail, PullAvatarDataUrls, PullLineComment } from '@shared/github-pull-detail'
import type { GitHubPullTimelineResult, PullTimelineItem } from '@shared/github-pull-timeline'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { Avatar } from './Avatar'
import { TimelineItem } from './TimelineItem'
import { FAILURE_TEXT, readState, STALE_TEXT, usePullRead, type ViewProps } from './shared'

/** The pages read after the first, tied to the first page they continue (a refresh starts over). */
type More = {
  base: GitHubPullTimelineResult; items: PullTimelineItem[]; next?: string; avatars?: PullAvatarDataUrls
  busy: boolean; failed?: string
}

type Entry = { kind: 'item'; item: PullTimelineItem } | { kind: 'commits'; commits: Extract<PullTimelineItem, { kind: 'commit' }>[] }

const linesOf = (lines: readonly PullLineComment[], reviewId: number) => lines.filter((line) => line.reviewId === reviewId)

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

/** The Conversation tab's timeline: the description first, then every GitHub timeline entry oldest
 *  first, each review with its line comments. More pages load when the end of the list scrolls into view. */
export function PullTimeline({ detail, detailAvatars, lineComments, ...props }: ViewProps & {
  detail: GitHubPullDetail; detailAvatars?: PullAvatarDataUrls; lineComments: readonly PullLineComment[]
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
  return (
    <>
      <ol className="pull-convo">
        <li className="pull-convo__item pull-convo__item--description">
          <div className="pull-convo__head">
            <span className="pull-person">
              <Avatar user={detail.author} avatars={avatars} />
              <span className="pull-node__author">{detail.author?.login ?? 'ghost'}</span>
            </span>
            <span className="pull-convo__event-text">opened this pull request</span>
            {ok && <time className="pull-convo__time" dateTime={ok.openedAt}>{new Date(ok.openedAt).toLocaleString()}</time>}
          </div>
          {detail.body.trim()
            ? <NoteMarkdown text={detail.body} className="sticky-node__md pull-node__md" />
            : <p className="pull-node__empty">No description provided.</p>}
        </li>
        {group(items).map((entry) => entry.kind === 'commits'
          ? (
            <li key={entry.commits[0].id} className="pull-convo__event pull-convo__item--commits">
              <div className="pull-convo__head">
                {/* ponytail: the first commit's actor names the push; GitHub's own entry does the same. */}
                <span className="pull-person">
                  <Avatar user={entry.commits[0].actor} avatars={avatars} />
                  <span className="pull-node__author">{entry.commits[0].actor?.login ?? 'ghost'}</span>
                </span>
                <span className="pull-convo__event-text">
                  {entry.commits.length === 1 ? '1 commit' : `${entry.commits.length} commits`} pushed
                </span>
                <time className="pull-convo__time" dateTime={entry.commits.at(-1)!.at}>
                  {new Date(entry.commits.at(-1)!.at).toLocaleString()}
                </time>
              </div>
              <ul className="pull-convo__commits">
                {entry.commits.map((commit) => (
                  <li key={commit.id} className="pull-person">
                    <Avatar user={commit.actor} avatars={avatars} size={16} />
                    <span className="pull-convo__headline">{commit.headline}</span>
                    <code>{commit.oid.slice(0, 7)}</code>
                  </li>
                ))}
              </ul>
            </li>
          )
          : (
            <TimelineItem key={entry.item.id} item={entry.item} avatars={avatars}>
              {entry.item.kind === 'review' && (
                <ul className="pull-convo__lines">
                  {linesOf(lineComments, entry.item.databaseId).map((line) => (
                    <li key={line.id}>
                      <span className="pull-person">
                        <Avatar user={line.author} avatars={avatars} size={16} />
                        <span className="pull-node__author">{line.author?.login ?? 'ghost'}</span>
                      </span>
                      <code>{line.path}{line.line !== null && `:${line.line}`}</code>
                      {line.outdated && <span className="pull-line__outdated">Outdated</span>}
                      <NoteMarkdown text={line.body} className="sticky-node__md pull-node__md" />
                    </li>
                  ))}
                </ul>
              )}
            </TimelineItem>
          ))}
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

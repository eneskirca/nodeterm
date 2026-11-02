import { useEffect, useState } from 'react'
import type { GitHubIssueCardView, GitHubIssuesApi } from '@shared/github-issues'
import type {
  GitHubIssueConversationResult, PullReadFailure, PullRefusal, PullWriteReason, PullWriteResult
} from '@shared/github-pull-detail'
import type { IssuesNodeRef } from '@shared/issues-node'
import { NoteMarkdown } from '../components/NoteMarkdown'

export type IssuesNodeApi = Pick<GitHubIssuesApi, 'refresh' | 'query' | 'issueConversation' | 'commentOnIssue'>

type Filter = 'open' | 'mine'

const WRITE_TEXT: Partial<Record<PullWriteReason, string>> = {
  forbidden: 'Your GitHub token may not write to this repository. Give it Issues write access, then try again.',
  throttled: 'GitHub is throttling requests. Try again in a minute.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.',
  'not-approved': 'This repository is not allowed on this machine. Add the Issues node again to allow it.',
  network: 'GitHub could not be reached. Check the connection, then try again.'
}
const WRITE_FALLBACK = 'GitHub refused the comment. Refresh, then try again.'

const READ_TEXT: Record<PullRefusal | PullReadFailure, string> = {
  throttled: 'GitHub is throttling requests. Refresh again in a minute.',
  unreachable: 'GitHub could not be reached. Check the connection, then refresh.',
  'signed-out': 'You are not signed in to GitHub. Sign in from the board\'s GitHub settings.',
  'not-approved': 'This repository is not allowed on this machine. Add the Issues node again to allow it.',
  'repository-mismatch': 'This node points at another repository than this project\'s. Add the Issues node again.',
  'not-configured': 'This project has no GitHub repository. Add an origin remote, then add the Issues node again.'
}

/** `key` names the filters a page was read with, so a late "Load more" never lands in another list. */
type ListState =
  | { status: 'loading' } | { status: 'failed' }
  | { status: 'ok'; key: string; items: GitHubIssueCardView[]; more?: string }

/**
 * The issues node's body (nodes/IssuesNode.tsx is the canvas frame). The list reads the board's
 * issue cache (refreshed on mount and on Refresh); the detail reads one issue's comments. Takes the
 * bridge as a prop so a test can hand it a fake. Writes only on a click here.
 */
export function IssuesNodeView(props: {
  api: IssuesNodeApi
  projectId: string
  issues: IssuesNodeRef
  refreshTick: number
  onSelect: (issueNumber: number) => void
  onWork: (issue: GitHubIssueCardView, worktree: boolean) => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const { api, projectId, issues, refreshTick, onSelect } = props
  const [filter, setFilter] = useState<Filter>('open')
  const [label, setLabel] = useState('')
  const [search, setSearch] = useState('')
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [labels, setLabels] = useState<string[]>([])

  const read = (cursor?: string) => api.query({
    projectId, repository: issues.repository, columnId: null, anyColumn: true, openOnly: true, pageSize: 50,
    ...(filter === 'mine' ? { assignedToMe: true } : {}),
    // ponytail: the core bounds the search and the label; the box only caps what is typed.
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(label ? { labelFilter: [label] } : {}),
    ...(cursor ? { cursor } : {})
  })

  // The refresh rides the core's 30 s floor, so a fast Refresh costs no request. The list is read
  // from the cache at once and again once the refresh has landed.
  const [synced, setSynced] = useState(0)
  useEffect(() => {
    let live = true
    void api.refresh(projectId).catch(() => undefined).then(() => { if (live) setSynced((n) => n + 1) })
    return () => { live = false }
  }, [api, projectId, refreshTick])

  useEffect(() => {
    let live = true
    const key = `${filter}\0${label}\0${search}`
    // A short wait so typing a search reads once, not per key.
    const timer = setTimeout(() => {
      read()
        .then((page) => {
          if (!live) return
          setList({ status: 'ok', key, items: page.items, more: page.nextCursor })
          // ponytail: the label choices are the labels seen on read pages, not the repository's list.
          setLabels((known) => [...new Set([...known, ...page.items.flatMap((item) => item.labels.map((l) => l.name))])].sort())
        })
        .catch(() => { if (live) setList({ status: 'failed' }) })
    }, 200)
    return () => { live = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is rebuilt each render from these
  }, [api, projectId, synced, filter, label, search])

  const items = list.status === 'ok' ? list.items : []
  const selected = items.find((item) => item.number === issues.issueNumber)

  return (
    <div className="issues-node__split">
      <div className="issues-node__list">
        <div className="issues-node__filters">
          <select aria-label="Filter" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
            <option value="open">Open</option>
            <option value="mine">Assigned to me</option>
          </select>
          <select aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)}>
            <option value="">Any label</option>
            {labels.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <input aria-label="Search" placeholder="Search" value={search} maxLength={200}
            onChange={(event) => setSearch(event.target.value)} />
        </div>
        {list.status === 'loading' && <p className="pull-node__state">Loading issues…</p>}
        {list.status === 'failed' && (
          <p className="pull-node__state" role="status">
            The issues could not be read. Check that this folder&apos;s GitHub repository is allowed and you are signed in, then refresh.
          </p>
        )}
        {list.status === 'ok' && items.length === 0 && <p className="pull-node__empty">No open issues match.</p>}
        <ul className="issues-node__rows">
          {items.map((item) => (
            <li key={item.number}>
              <button className="issues-node__row" aria-current={item.number === issues.issueNumber}
                onClick={() => onSelect(item.number)}>
                <span className="pull-node__number">#{item.number}</span> {item.title}
              </button>
            </li>
          ))}
        </ul>
        {list.status === 'ok' && list.more && (
          <button className="pull-compose__button" onClick={() => {
            const { key, more } = list
            void read(more).then((page) => setList((current) => current.status === 'ok' && current.key === key
              ? { ...current, items: [...current.items, ...page.items], more: page.nextCursor }
              : current)).catch(() => undefined)
          }}>Load more</button>
        )}
      </div>
      <div className="issues-node__detail">
        {selected
          ? <IssueDetail {...props} issue={selected} />
          : <p className="pull-node__empty">Pick an issue to see it here.</p>}
      </div>
    </div>
  )
}

function IssueDetail(props: {
  api: IssuesNodeApi
  projectId: string
  issues: IssuesNodeRef
  issue: GitHubIssueCardView
  refreshTick: number
  onWork: (issue: GitHubIssueCardView, worktree: boolean) => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const { api, projectId, issues, issue, refreshTick, onWork, onOpenExternal } = props
  const [comments, setComments] = useState<GitHubIssueConversationResult | 'loading'>('loading')
  const [written, setWritten] = useState(0)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)

  useEffect(() => {
    let live = true
    setComments('loading')
    api.issueConversation(projectId, issues.repository, issue.number)
      .then((result) => { if (live) setComments(result) })
      .catch(() => { if (live) setComments({ status: 'failed', reason: 'unreachable' }) })
    return () => { live = false }
  }, [api, projectId, issues.repository, issue.number, refreshTick, written])

  const comment = async () => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const outcome = await api.commentOnIssue({ projectId, repository: issues.repository, issueNumber: issue.number, body: draft })
      .catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) { setRefusal(outcome.reason); return }
    setDraft('')
    setWritten((n) => n + 1)
  }

  return (
    <div>
      <h3 className="pull-node__title">{issue.title} <span className="pull-node__number">#{issue.number}</span></h3>
      <div className="pull-node__meta">
        {issue.labels.map((l) => <span key={l.id} className="pull-node__lifecycle">{l.name}</span>)}
        {issue.assignees.length > 0 && <span>Assigned to {issue.assignees.map((a) => a.login).join(', ')}</span>}
      </div>
      <div className="pull-compose__actions issues-node__work">
        <button className="pull-compose__button" onClick={() => onWork(issue, false)}>Work on this</button>
        <button className="pull-compose__button" onClick={() => onWork(issue, true)}>Work on this in a new worktree</button>
        <button className="pull-compose__button" onClick={() => onOpenExternal(issue.htmlUrl)}>Open on GitHub</button>
      </div>
      {issue.body.trim()
        ? <NoteMarkdown text={issue.body} className="sticky-node__md pull-node__md" />
        : <p className="pull-node__empty">No description.</p>}
      {comments === 'loading' && <p className="pull-node__state">Loading comments…</p>}
      {comments !== 'loading' && comments.status !== 'ok' && (
        <p className="pull-node__state" role="status">{READ_TEXT[comments.reason]}</p>
      )}
      {comments !== 'loading' && comments.status === 'ok' && (
        <>
          {comments.stale && <p className="pull-node__stale" role="status">{READ_TEXT[comments.stale]} Showing the last loaded comments.</p>}
          {comments.truncated && <p className="pull-node__empty">Showing the first comments only. Open on GitHub for the rest.</p>}
          {comments.items.length === 0
            ? <p className="pull-node__empty">No comments yet.</p>
            : (
              <ol className="pull-convo">
                {comments.items.map((item) => (
                  <li key={item.id} className="pull-convo__item pull-convo__item--comment">
                    <div className="pull-convo__head">
                      <span className="pull-node__author">{item.author?.login ?? 'ghost'}</span>
                      <time className="pull-convo__time" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
                    </div>
                    {item.body.trim() && <NoteMarkdown text={item.body} className="sticky-node__md pull-node__md" />}
                  </li>
                ))}
              </ol>
            )}
        </>
      )}
      <div className="pull-compose">
        <textarea className="pull-compose__box" aria-label="Comment" placeholder="Write a comment"
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal] ?? WRITE_FALLBACK}</p>}
        <div className="pull-compose__actions">
          <button className="pull-compose__button" disabled={busy || !draft.trim()} onClick={() => void comment()}>Comment</button>
        </div>
      </div>
    </div>
  )
}

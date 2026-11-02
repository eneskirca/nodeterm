import { useEffect, useState } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type {
  GitHubPullConversationResult,
  GitHubPullDetailResult,
  PullReadFailure,
  PullRefusal,
  PullReviewEvent,
  PullReviewVerdict,
  PullWriteReason,
  PullWriteResult
} from '@shared/github-pull-detail'
import type { PullLifecycle } from '@shared/github-pull-status'
import { pullWebUrl, type PullNodeRef, type PullNodeTab } from '@shared/pull-node'
import { NoteMarkdown } from '../components/NoteMarkdown'
import { PullChecks, usePullChecks } from '../components/kanban/GitHubIssueSummaryModal'
import { mergeLabel } from '../components/kanban/PullStatusBadges'

export type PullNodeApi = Pick<
  GitHubIssuesApi, 'pullDetail' | 'pullChecks' | 'pullConversation' | 'commentOnPull' | 'reviewPull'
>

/** Each refusal names what is wrong and the one step that fixes it. No request was made. */
const REFUSAL_TEXT: Record<PullRefusal, (repository: string) => string> = {
  'not-approved': () =>
    'This repository is not approved on this machine. Open the board, then approve the repository in its GitHub settings.',
  'signed-out': () => 'You are not signed in to GitHub. Open the board, then sign in from its GitHub settings.',
  'repository-mismatch': (repository) =>
    `This node points at ${repository}, which is not this project's repository. Open the pull request again from this project's board.`,
  'not-configured': () =>
    "This project has no GitHub repository connected. Connect one in the board's GitHub settings."
}

const FAILURE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'GitHub is throttling requests. Refresh again in a minute.',
  unreachable: 'GitHub could not be reached. Check the connection, then refresh.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.'
}

const STALE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'Throttled by GitHub: showing the last loaded version.',
  unreachable: 'GitHub could not be reached: showing the last loaded version.',
  'signed-out': 'GitHub refused the token: showing the last loaded version.'
}

/** One sentence per write refusal. */
const WRITE_TEXT: Record<PullWriteReason, string> = {
  'head-moved': 'The pull request changed since you loaded it, so nothing was merged. It has been reloaded: check the new commits, then merge again.',
  'not-mergeable': 'GitHub says this pull request cannot be merged right now. Check its merge state on GitHub, then try again.',
  'own-pull': 'GitHub does not let you approve or request changes on your own pull request. Leave a comment instead.',
  forbidden: 'Your GitHub token may not write to this repository. Give it Pull requests write access, then try again.',
  throttled: 'GitHub is throttling requests. Try again in a minute.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.',
  'not-approved': 'This repository is not approved on this machine. Approve it in the board\'s GitHub settings.',
  validation: 'GitHub refused the request. Refresh the pull request, then try again.',
  network: 'GitHub could not be reached. Check the connection, then try again.'
}

const LIFECYCLE_TEXT: Record<PullLifecycle, string> = {
  open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed'
}

const VERDICT_TEXT: Record<PullReviewVerdict, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'
}

// ponytail: Files is ticket 03; until it lands a persisted 'files' tab shows Overview.
const TABS: ReadonlyArray<[PullNodeTab, string]> = [['overview', 'Overview'], ['conversation', 'Conversation']]

type ViewProps = {
  api: PullNodeApi
  projectId: string
  pull: PullNodeRef
  refreshTick: number
  onOpenExternal: (url: string) => void
  /** A write landed: the node reads again (the core dropped its held reads for this PR). */
  onWritten: () => void
}

/** A bridge call that rejected (a dropped socket) reads as unreachable. */
type Read<R> = R | { status: 'failed'; reason: 'unreachable' } | 'loading'

/** Reads when the tab first mounts and whenever `refreshTick` moves; the core answers from memory
 *  inside its 30 s floor, so a fast Refresh costs no request. */
function usePullRead<R>(
  read: (projectId: string, repository: string, pullNumber: number) => Promise<R>,
  { projectId, pull, refreshTick }: ViewProps
): Read<R> {
  const [result, setResult] = useState<Read<R>>('loading')
  const { repository, pullNumber } = pull
  useEffect(() => {
    let live = true
    read(projectId, repository, pullNumber)
      .then((value) => { if (live) setResult(value) })
      .catch(() => { if (live) setResult({ status: 'failed', reason: 'unreachable' }) })
    return () => { live = false }
  }, [read, projectId, repository, pullNumber, refreshTick])
  return result
}

/** The loading, refused and failed states every tab shows the same way. */
function readState(
  result: Read<Exclude<GitHubPullDetailResult | GitHubPullConversationResult, { status: 'ok' }>>,
  repository: string
): React.JSX.Element {
  if (result === 'loading') return <p className="pull-node__state">Loading pull request…</p>
  if (result.status === 'refused') {
    return <p className="pull-node__state" role="status">{REFUSAL_TEXT[result.reason](repository)}</p>
  }
  return <p className="pull-node__state" role="status">{FAILURE_TEXT[result.reason]}</p>
}

type TabsProps = ViewProps & { onTab: (tab: PullNodeTab) => void }

/**
 * The pull request node's body (nodes/PullNode.tsx is the canvas frame around it). Takes the bridge
 * as a prop so a test can hand it a fake.
 */
export function PullNodeView({
  pull,
  projectId,
  ...rest
}: Omit<TabsProps, 'pull' | 'projectId'> & {
  projectId: string | null
  pull: PullNodeRef | undefined
}): React.JSX.Element {
  if (!pull || !projectId) {
    return <p className="pull-node__state" role="status">This node has no valid pull request reference.</p>
  }
  return <PullTabs {...rest} pull={pull} projectId={projectId} />
}

/** A tab mounts the first time it is shown and then stays mounted (hidden when not shown), so a
 *  switch back costs no read and a draft typed in a tab survives the switch. */
function PullTabs({ onTab, ...props }: TabsProps): React.JSX.Element {
  const { pull, onOpenExternal } = props
  const shownTab: PullNodeTab = pull.tab === 'conversation' ? 'conversation' : 'overview'
  const [opened, setOpened] = useState<readonly PullNodeTab[]>([shownTab])
  if (!opened.includes(shownTab)) setOpened([...opened, shownTab])
  // The head commit the Overview last showed: the one a review is tied to.
  const [seenHead, setSeenHead] = useState<string | undefined>()
  return (
    <>
      <div className="pull-node__tabs" role="tablist">
        {TABS.map(([tab, label]) => (
          <button key={tab} role="tab" aria-selected={tab === shownTab} className="pull-node__tab"
            onClick={() => onTab(tab)}>{label}</button>
        ))}
        <span className="term-node__spacer" />
        <button className="pull-node__web" onClick={() => onOpenExternal(pullWebUrl(pull.repository, pull.pullNumber))}>
          Open on GitHub
        </button>
      </div>
      {opened.includes('overview') && (
        <div hidden={shownTab !== 'overview'}><PullOverview {...props} onHead={setSeenHead} /></div>
      )}
      {opened.includes('conversation') && (
        <div hidden={shownTab !== 'conversation'}><PullConversation {...props} seenHead={seenHead} /></div>
      )}
    </>
  )
}

function PullOverview(props: ViewProps & { onHead: (sha: string) => void }): React.JSX.Element {
  const { api, projectId, pull, onOpenExternal, onHead } = props
  const result = usePullRead(api.pullDetail, props)
  const detail = result !== 'loading' && result.status === 'ok' ? result.detail : undefined
  const head = detail?.head.sha
  useEffect(() => { if (head) onHead(head) }, [head, onHead])
  const readsChecks = detail && (detail.lifecycle === 'open' || detail.lifecycle === 'draft')
  const checks = usePullChecks(api, readsChecks ? projectId : undefined, pull.pullNumber, detail?.head.sha)

  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const { detail: d } = result
  const merge = d.lifecycle === 'open' || d.lifecycle === 'draft' ? mergeLabel(d.merge) : null
  return (
    <div className="pull-node__overview">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
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
      {d.body.trim()
        ? <NoteMarkdown text={d.body} className="sticky-node__md pull-node__md" />
        : <p className="pull-node__empty">No description provided.</p>}
      <PullChecks result={checks} expectedHead={d.head.sha} onOpen={onOpenExternal} />
    </div>
  )
}

/** The Conversation tab: comments and reviews, oldest first, then the composer. The draft lives here
 *  (the tab stays mounted), so it survives a tab switch; it is never persisted. */
function PullConversation(props: ViewProps & { seenHead: string | undefined }): React.JSX.Element {
  const { api, projectId, pull, onWritten, seenHead } = props
  const result = usePullRead(api.pullConversation, props)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }

  const run = async (write: () => Promise<PullWriteResult>) => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const outcome = await write().catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) { setRefusal(outcome.reason); return }
    setDraft('')
    onWritten()
  }
  // A review is tied to the head the Overview showed, so GitHub refuses it if the PR moved since.
  // ponytail: no head seen yet (Overview never opened) disables review rather than reading one here.
  const review = (event: PullReviewEvent) => seenHead && run(() =>
    api.reviewPull({ ...at, event, body: draft, headSha: seenHead }))

  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  return (
    <div className="pull-node__conversation">
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
              </li>
            ))}
          </ol>
        )}
      <div className="pull-compose">
        <textarea className="pull-compose__box" aria-label="Comment" placeholder="Write a comment or a review message"
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
        <div className="pull-compose__actions">
          <button className="pull-compose__button" disabled={busy || !draft.trim()}
            onClick={() => void run(() => api.commentOnPull({ ...at, body: draft }))}>Comment</button>
          <button className="pull-compose__button" disabled={busy || !seenHead}
            onClick={() => void review('APPROVE')}>Approve</button>
          <button className="pull-compose__button" disabled={busy || !seenHead || !draft.trim()}
            onClick={() => void review('REQUEST_CHANGES')}>Request changes</button>
        </div>
        {!seenHead && <p className="pull-node__empty">Open the Overview tab to review: a review is tied to the commit it shows.</p>}
      </div>
    </div>
  )
}

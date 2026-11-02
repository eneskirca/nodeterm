import { useEffect, useState } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type {
  GitHubPullConversationResult,
  GitHubPullDetailResult,
  PullReadFailure,
  PullRefusal,
  PullReviewVerdict
} from '@shared/github-pull-detail'
import type { PullLifecycle } from '@shared/github-pull-status'
import { pullWebUrl, type PullNodeRef, type PullNodeTab } from '@shared/pull-node'
import { NoteMarkdown } from '../components/NoteMarkdown'
import { PullChecks, usePullChecks } from '../components/kanban/GitHubIssueSummaryModal'
import { mergeLabel } from '../components/kanban/PullStatusBadges'

export type PullNodeApi = Pick<GitHubIssuesApi, 'pullDetail' | 'pullChecks' | 'pullConversation'>

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
}

type Read<R> = R | 'loading'

/** Reads on mount and whenever `refreshTick` moves; the core answers from memory inside its 30 s
 *  floor, so a fast Refresh or a tab switch costs no request. */
function usePullRead<R extends { status: string }>(
  read: (projectId: string, repository: string, pullNumber: number) => Promise<R>,
  { projectId, pull, refreshTick }: ViewProps
): Read<R> {
  const [result, setResult] = useState<Read<R>>('loading')
  const { repository, pullNumber } = pull
  useEffect(() => {
    let live = true
    read(projectId, repository, pullNumber)
      .then((value) => { if (live) setResult(value) })
      .catch(() => { if (live) setResult({ status: 'failed', reason: 'unreachable' } as unknown as R) })
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

/**
 * The pull request node's body (nodes/PullNode.tsx is the canvas frame around it). Takes the bridge
 * as a prop so a test can hand it a fake. Each tab reads its own data when it is shown.
 */
export function PullNodeView({
  pull,
  projectId,
  onTab,
  ...rest
}: Omit<ViewProps, 'pull' | 'projectId'> & {
  projectId: string | null
  pull: PullNodeRef | undefined
  onTab: (tab: PullNodeTab) => void
}): React.JSX.Element {
  if (!pull || !projectId) {
    return <p className="pull-node__state" role="status">This node has no valid pull request reference.</p>
  }
  const props = { ...rest, pull, projectId }
  return (
    <>
      <div className="pull-node__tabs" role="tablist">
        {TABS.map(([tab, label]) => (
          <button key={tab} role="tab" aria-selected={(pull.tab === 'conversation') === (tab === 'conversation')}
            className="pull-node__tab" onClick={() => onTab(tab)}>{label}</button>
        ))}
        <span className="term-node__spacer" />
        <button className="pull-node__web" onClick={() => rest.onOpenExternal(pullWebUrl(pull.repository, pull.pullNumber))}>
          Open on GitHub
        </button>
      </div>
      {pull.tab === 'conversation' ? <PullConversation {...props} /> : <PullOverview {...props} />}
    </>
  )
}

function PullOverview(props: ViewProps): React.JSX.Element {
  const { api, projectId, pull, onOpenExternal } = props
  const result = usePullRead(api.pullDetail, props)
  const detail = result !== 'loading' && result.status === 'ok' ? result.detail : undefined
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

/** The Conversation tab: comments and reviews, oldest first. Ticket 04's composer goes below the list. */
function PullConversation(props: ViewProps): React.JSX.Element {
  const result = usePullRead(props.api.pullConversation, props)
  if (result === 'loading' || result.status !== 'ok') return readState(result, props.pull.repository)
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
    </div>
  )
}

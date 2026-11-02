import { useEffect, useState } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type { GitHubPullDetailResult, PullReadFailure, PullRefusal } from '@shared/github-pull-detail'
import type { PullLifecycle } from '@shared/github-pull-status'
import type { PullNodeRef } from '@shared/pull-node'
import { NoteMarkdown } from '../components/NoteMarkdown'
import { PullChecks, usePullChecks } from '../components/kanban/GitHubIssueSummaryModal'
import { mergeLabel } from '../components/kanban/PullStatusBadges'

export type PullNodeApi = Pick<GitHubIssuesApi, 'pullDetail' | 'pullChecks'>

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

/**
 * The pull request node's body (nodes/PullNode.tsx is the canvas frame around it). Takes the bridge
 * as a prop so a test can hand it a fake. Reads on mount and whenever `refreshTick` moves; the core
 * answers from memory inside its 30 s floor, so a fast Refresh costs no request.
 */
export function PullNodeView({
  api,
  projectId,
  pull,
  refreshTick,
  onOpenExternal
}: {
  api: PullNodeApi
  projectId: string | null
  pull: PullNodeRef | undefined
  refreshTick: number
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const [result, setResult] = useState<GitHubPullDetailResult | 'loading'>('loading')
  const repository = pull?.repository
  const pullNumber = pull?.pullNumber
  useEffect(() => {
    if (!projectId || !repository || !pullNumber) return
    let live = true
    api.pullDetail(projectId, repository, pullNumber)
      .then((value) => { if (live) setResult(value) })
      .catch(() => { if (live) setResult({ status: 'failed', reason: 'unreachable' }) })
    return () => { live = false }
  }, [api, projectId, repository, pullNumber, refreshTick])

  const detail = result !== 'loading' && result.status === 'ok' ? result.detail : undefined
  const readsChecks = detail && (detail.lifecycle === 'open' || detail.lifecycle === 'draft')
  const checks = usePullChecks(api, readsChecks ? projectId ?? undefined : undefined, pullNumber ?? 0, detail?.head.sha)

  if (!pull || !projectId) {
    return <p className="pull-node__state" role="status">This node has no valid pull request reference.</p>
  }
  if (result === 'loading') return <p className="pull-node__state">Loading pull request…</p>
  if (result.status === 'refused') {
    return <p className="pull-node__state" role="status">{REFUSAL_TEXT[result.reason](pull.repository)}</p>
  }
  if (result.status === 'failed') {
    return <p className="pull-node__state" role="status">{FAILURE_TEXT[result.reason]}</p>
  }
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

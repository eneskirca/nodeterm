// What every part of the pull request node shares: the bridge slice it reads and writes through,
// the props every tab gets, the read and write hooks, and the sentences for refusals and failures.
import { createContext, useContext, useEffect, useState } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type {
  GitHubPullConversationResult,
  GitHubPullDetail,
  GitHubPullDetailResult,
  GitHubPullFileContentsResult,
  GitHubPullFilesResult,
  PullMergeMethod,
  PullReadFailure,
  PullRefusal,
  PullWriteReason,
  PullWriteResult
} from '@shared/github-pull-detail'
import type { GitHubPullTimelineResult } from '@shared/github-pull-timeline'
import type { PullNodeRef } from '@shared/pull-node'
import type { LinkedAgent } from '../../state/pullAgent'

export type PullNodeApi = Pick<
  GitHubIssuesApi,
  'pullDetail' | 'pullChecks' | 'pullConversation' | 'pullTimeline' | 'pullFiles' | 'pullFileContents' | 'commentOnPull' | 'reviewPull' | 'mergePull' | 'repoMergeMethods' |
  'repoCollaborators' | 'requestPullReviewer' | 'commentOnPullLine' | 'updatePullBranch' | 'enablePullAutoMerge' |
  'disablePullAutoMerge' | 'setFileViewed' | 'pullCommits' | 'pullCommitFiles' | 'pullCommitFileContents' |
  'setReviewThreadResolved' | 'applySuggestion'
>

/** Each refusal names what is wrong and the one step that fixes it. No request was made. */
export const REFUSAL_TEXT: Record<PullRefusal, (repository: string) => string> = {
  'not-approved': () =>
    'This repository is not approved on this machine. Open the board, then approve the repository in its GitHub settings.',
  'signed-out': () => 'You are not signed in to GitHub. Open the board, then sign in from its GitHub settings.',
  'repository-mismatch': (repository) =>
    `This node points at ${repository}, which is not this project's repository. Open the pull request again from this project's board.`,
  'not-configured': () =>
    "This project has no GitHub repository connected. Connect one in the board's GitHub settings."
}

export const FAILURE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'GitHub is throttling requests. Refresh again in a minute.',
  unreachable: 'GitHub could not be reached. Check the connection, then refresh.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.'
}

export const STALE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'Throttled by GitHub: showing the last loaded version.',
  unreachable: 'GitHub could not be reached: showing the last loaded version.',
  'signed-out': 'GitHub refused the token: showing the last loaded version.'
}

/** One sentence per write refusal. */
export const WRITE_TEXT: Record<PullWriteReason, string> = {
  'head-moved': 'The pull request changed since you loaded it, so nothing was merged. It has been reloaded: check the new commits, then merge again.',
  'not-mergeable': 'GitHub says this pull request cannot be merged right now. Check its merge state on GitHub, then try again.',
  'own-pull': 'GitHub does not let you approve or request changes on your own pull request. Leave a comment instead.',
  forbidden: 'Your GitHub token may not write to this repository. Give it Pull requests write access, then try again.',
  throttled: 'GitHub is throttling requests. Try again in a minute.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.',
  'not-approved': 'This repository is not approved on this machine. Approve it in the board\'s GitHub settings.',
  validation: 'GitHub refused the request. Refresh the pull request, then try again.',
  network: 'GitHub could not be reached. Check the connection, then try again.',
  'suggestion-stale': 'The file changed since this suggestion was made, so it was not applied. The pull request has been reloaded: check the new lines.',
  'from-fork': 'This pull request comes from a fork, so nodeterm cannot commit to its branch. Apply the suggestion on GitHub.'
}

export const METHOD_TEXT: Record<PullMergeMethod, string> = {
  merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge'
}

export type ViewProps = {
  api: PullNodeApi
  projectId: string
  pull: PullNodeRef
  refreshTick: number
  onOpenExternal: (url: string) => void
  /** A write landed: the node reads again (the core dropped its held reads for this PR). */
  onWritten: () => void
  /** "Work on this PR": the PR's head in a fresh worktree with the default agent (Canvas does it).
   *  `conflict`: "Resolve conflicts with agent", the same path with the merge-the-base task. */
  onWork?: (detail: GitHubPullDetail, conflict?: true) => void
  /** The agent nodes joined to this node: who "Send to agent" may send to. */
  agents?: readonly LinkedAgent[]
  /** Why "Send to agent" is off on this surface (a relay tab). */
  sendUnavailable?: string
  /** Sends the message to that agent; answers null when sent, else the sentence to show. */
  onSendToAgent?: (agentId: string, message: string) => Promise<string | null>
  /** Allows the node's repository on this computer (the add menu's approve); true when it landed. */
  onAllow?: () => Promise<boolean>
}

/** A bridge call that rejected (a dropped socket) reads as unreachable. */
export type Read<R> = R | { status: 'failed'; reason: 'unreachable' } | 'loading'

/** Reads when the tab first mounts and whenever `refreshTick` moves; the core answers from memory
 *  inside its 30 s floor, so a fast Refresh costs no request. */
export function usePullRead<R>(
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

export const AllowContext = createContext<(() => Promise<boolean>) | undefined>(undefined)

/** A repository not allowed yet: one click allows it, then the node reads again. */
function AllowRepo({ repository }: { repository: string }): React.JSX.Element {
  const onAllow = useContext(AllowContext)
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  if (!onAllow) return <p className="pull-node__state" role="status">{REFUSAL_TEXT['not-approved'](repository)}</p>
  return (
    <div className="pull-node__state" role="status">
      <p>{repository} is not allowed on this computer yet. Allowing it lets pull request and issues nodes and
        agents on this canvas read and act on its pull requests and issues.</p>
      <button className="pull-node__web" disabled={state === 'busy'}
        onClick={() => {
          setState('busy')
          void onAllow().catch(() => false).then((ok) => setState(ok ? 'idle' : 'failed'))
        }}>{`Allow ${repository}?`}</button>
      {state === 'failed' && <p className="pull-compose__error" role="alert">{`Could not allow ${repository}. Try again.`}</p>}
    </div>
  )
}

/** The loading, refused and failed states every tab shows the same way. */
export function readState(
  result: Read<Exclude<
    GitHubPullDetailResult | GitHubPullConversationResult | GitHubPullFilesResult | GitHubPullFileContentsResult |
    GitHubPullTimelineResult,
    { status: 'ok' }
  >>,
  repository: string
): React.JSX.Element {
  if (result === 'loading') return <p className="pull-node__state">Loading pull request…</p>
  if (result.status === 'refused') {
    if (result.reason === 'not-approved') return <AllowRepo repository={repository} />
    return <p className="pull-node__state" role="status">{REFUSAL_TEXT[result.reason](repository)}</p>
  }
  return <p className="pull-node__state" role="status">{FAILURE_TEXT[result.reason]}</p>
}

/** A write's busy flag and refusal sentence; `run` sends it and calls `done` when it landed. */
export function useWrite(done: () => void): {
  busy: boolean; refusal: PullWriteReason | null; run: (write: () => Promise<PullWriteResult>) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const run = async (write: () => Promise<PullWriteResult>) => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const outcome = await write().catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (outcome.ok) done()
    else setRefusal(outcome.reason)
  }
  return { busy, refusal, run }
}

export const OWN_PULL_TEXT = 'This is your own pull request, so you can comment but not approve or request changes.'

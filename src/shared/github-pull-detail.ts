// One pull request as the pull request node shows it (renderer/nodes/PullNode.tsx). Read on demand
// by core/github/service.ts `pullDetail`; never persisted (the node stores only the reference).
import type { GitHubIssueUser } from './github-issues'
import type { PullLifecycle, PullMergeState } from './github-pull-status'

export interface GitHubPullDetail {
  number: number
  title: string
  /** Markdown, as the author wrote it. Render it only through the sanitizing renderer. */
  body: string
  lifecycle: PullLifecycle
  author: GitHubIssueUser | null
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  /** From the shared pull-status rules (`mergeState`). Absent when the PR is not open. */
  merge?: PullMergeState
  additions: number
  deletions: number
  changedFiles: number
  /** https://github.com/… only. */
  url: string
}

/** Why a read produced no fresh answer. `signed-out` only for an answer GitHub gave about the token. */
export type PullReadFailure = 'throttled' | 'unreachable' | 'signed-out'

/** Why no request was made at all. Each has a named fix in the node. */
export type PullRefusal = 'not-approved' | 'signed-out' | 'repository-mismatch' | 'not-configured'

export type GitHubPullDetailResult =
  /** `stale` = the latest read failed; `detail` is the last one that succeeded, kept on purpose. */
  | { status: 'ok'; detail: GitHubPullDetail; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

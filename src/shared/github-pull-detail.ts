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

/** A review's verdict. GitHub's PENDING (an unsubmitted draft) is never shown. */
export type PullReviewVerdict = 'approved' | 'changes-requested' | 'commented' | 'dismissed'

/** One entry of the Conversation tab: an issue comment or a submitted review. */
export type PullConversationItem =
  | { kind: 'comment'; id: number; author: GitHubIssueUser | null; body: string; at: string; url: string }
  | { kind: 'review'; id: number; author: GitHubIssueUser | null; body: string; at: string; url: string; verdict: PullReviewVerdict }

/** One page of either list, as the client reads it. */
export interface PullConversationPage {
  items: PullConversationItem[]
  nextPage?: number
}

export type GitHubPullConversationResult =
  /** `items` oldest first. `truncated` = more pages than the node reads; the rest is on GitHub. */
  | { status: 'ok'; items: PullConversationItem[]; truncated: boolean; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** What a review from the node says. REQUEST_CHANGES and COMMENT need a message; APPROVE does not. */
export type PullReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/** Why a write from the node did not land. Each has one sentence in the node (PullNodeView). */
export type PullWriteReason =
  | 'head-moved' | 'not-mergeable' | 'own-pull' | 'forbidden' | 'throttled' | 'signed-out' | 'not-approved' | 'validation' | 'network'

/** How a merge from the node lands. The repository decides which ones it allows. */
export type PullMergeMethod = 'merge' | 'squash' | 'rebase'

/** The repository's allowed merge methods (`repoMergeMethods`), refused and failed as a pull read. */
export type GitHubRepoMergeMethodsResult =
  | { status: 'ok'; methods: PullMergeMethod[] }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** The one answer every pull node write gives (comment, review, merge). */
export type PullWriteResult = { ok: true } | { ok: false; reason: PullWriteReason }

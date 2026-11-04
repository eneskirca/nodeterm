// "Since my last review" (F-10): the viewer's latest submitted review on a PR (GraphQL) compared to
// the PR's head (REST compare, three-dot). Read on demand; never persisted.
import type { PullFile, PullReadFailure, PullRefusal } from './github-pull-detail'

/** The viewer's latest submitted review: when, and the commit it was on. */
export interface PullViewerReview {
  submittedAt: string
  commitOid: string
}

/** `GET /compare/{base}...{head}`: how `head` relates to `base`, the commits it is ahead by, and
 *  the files changed since the merge base. Null from the client = GitHub has no such comparison
 *  (404 or 422: the old commit is gone, or the two have no merge base). */
export interface PullCompare {
  status: 'ahead' | 'behind' | 'diverged' | 'identical'
  aheadBy: number
  files: PullFile[]
}

/** Why the diff since the last review cannot be shown: the reviewed commit is gone (`commit-gone`),
 *  or the branch no longer contains it (`history-rewritten`). Both follow a force-push. */
export type PullSinceReviewUnavailable = 'commit-gone' | 'history-rewritten'

export type PullSinceReview =
  /** The viewer never submitted a review on this PR. */
  | { kind: 'none' }
  /** The head is still the reviewed commit. */
  | ({ kind: 'current' } & PullViewerReview)
  /** `commits` new commits since the review; `files` changed since it (at most 300, then `truncated`). */
  | ({ kind: 'moved'; head: string; commits: number; files: PullFile[]; truncated: boolean } & PullViewerReview)
  | ({ kind: 'unavailable'; reason: PullSinceReviewUnavailable } & PullViewerReview)

export type GitHubPullSinceReviewResult =
  | { status: 'ok'; since: PullSinceReview; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** GitHub's compare answers at most 300 files. */
export const MAX_COMPARE_FILES = 300

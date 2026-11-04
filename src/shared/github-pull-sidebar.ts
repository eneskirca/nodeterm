// The pull request node's sidebar (renderer/nodes/pull/PullSidebar.tsx): reviewers with their state,
// assignees, labels, the issues the merge closes, and participants. One GraphQL read
// (core/github/graphql-pull-sidebar.ts) fills it, carried on `GitHubPullDetail.sidebar`.
// A field left out = that part could not be read: the sidebar hides it, never shows it as empty.
import type { GitHubIssueUser } from './github-issues'
import type { PullReviewVerdict } from './github-pull-detail'

/** A reviewer's latest word. `pending` = asked and not answered since (a re-request is pending again). */
export type PullReviewerState = PullReviewVerdict | 'pending'

export interface PullReviewer {
  user: GitHubIssueUser
  state: PullReviewerState
  /** Pending again after an earlier review: the verdict it replaces. */
  previous?: PullReviewVerdict
}

/** `color` is GitHub's 6-digit hex, no `#`. */
export interface PullLabel { name: string; color: string }

/** An issue the PR closes when it merges (`closingIssuesReferences`). */
export interface PullClosingIssue { repository: string; number: number; title: string; state: 'open' | 'closed' }

export interface PullSidebar {
  reviewers?: PullReviewer[]
  assignees?: GitHubIssueUser[]
  labels?: PullLabel[]
  closingIssues?: PullClosingIssue[]
  participants?: GitHubIssueUser[]
}

/** What the client's one read answers; the service merges `requested` and `reviews` into `reviewers`. */
export interface PullSidebarRead extends Omit<PullSidebar, 'reviewers'> {
  /** Both absent when either could not be read. */
  requested?: GitHubIssueUser[]
  /** Each reviewer's latest submitted review (`latestReviews`). */
  reviews?: Array<{ user: GitHubIssueUser; verdict: PullReviewVerdict }>
}

/** One row per person: a pending request wins over an earlier review (GitHub's re-request), and
 *  keeps that review as `previous`. Reviewers who answered come first, in review order. */
export function mergePullReviewers(
  requested: readonly GitHubIssueUser[], reviews: readonly { user: GitHubIssueUser; verdict: PullReviewVerdict }[]
): PullReviewer[] {
  const asked = new Set(requested.map((user) => user.id))
  const answered = reviews.filter((review) => !asked.has(review.user.id))
    .map(({ user, verdict }): PullReviewer => ({ user, state: verdict }))
  const pending = requested.map((user): PullReviewer => {
    const earlier = reviews.find((review) => review.user.id === user.id)
    return { user, state: 'pending', ...(earlier ? { previous: earlier.verdict } : {}) }
  })
  return [...answered, ...pending]
}

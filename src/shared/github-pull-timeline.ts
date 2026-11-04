// One pull request's Conversation timeline (core/github/service.ts `pullTimeline`, GraphQL
// `timelineItems`), oldest first, one page per read. Never persisted.
import type { GitHubIssueUser } from './github-issues'
import type { PullAvatarDataUrls, PullReadFailure, PullRefusal, PullReviewVerdict } from './github-pull-detail'

/** One timeline entry. `id` is GitHub's node id; `actor` null = a deleted account ("ghost") or one
 *  this build cannot name. Comment and review `databaseId` is the REST id (line comments' `reviewId`). */
export type PullTimelineItem = { id: string; actor: GitHubIssueUser | null; at: string } & (
  | { kind: 'comment'; databaseId: number; body: string; url: string }
  | { kind: 'review'; databaseId: number; body: string; url: string; verdict: PullReviewVerdict }
  | { kind: 'commit'; oid: string; headline: string }
  | { kind: 'force-push'; before: string | null; after: string | null }
  | { kind: 'labeled' | 'unlabeled'; label: { name: string; color: string } }
  /** A user's login or a team's name; null = GitHub no longer names it. */
  | { kind: 'review-requested'; reviewer: string | null }
  | { kind: 'assigned' | 'unassigned'; assignee: GitHubIssueUser | null }
  | { kind: 'closed' | 'reopened' | 'ready-for-review' | 'converted-to-draft' }
  | { kind: 'merged'; oid: string | null; base: string }
  | { kind: 'cross-referenced'; source: { pull: boolean; number: number; title: string; repository: string; url: string } }
)

/** One page as the client reads it. `next` = the cursor of the page after it; absent = the last page. */
export interface PullTimelinePage {
  items: PullTimelineItem[]
  openedAt: string
  next?: string
}

/** A GraphQL cursor as GitHub writes it (base64 with `=`, `_`, `-`). Checked at the boundary. */
export function isPullTimelineCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/=_-]{1,256}$/.test(value)
}

export type GitHubPullTimelineResult =
  /** `openedAt` = when the PR was opened (the description's entry). Same stale rules as `pullDetail`. */
  | {
    status: 'ok'; items: PullTimelineItem[]; openedAt: string; next?: string; observedAt: number
    stale?: PullReadFailure; retryAt?: number; avatarDataUrls?: PullAvatarDataUrls
  }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

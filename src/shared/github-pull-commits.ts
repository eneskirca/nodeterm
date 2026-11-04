// The pull node's Commits tab: the PR's commits (core `pullCommits`) and one commit's own diff
// (`pullCommitFiles`, then `pullCommitFileContents` with the commit's first parent and the commit as
// the two sides). Read on demand; never persisted.
import type { GitHubIssueUser } from './github-issues'
import type { PullAvatarDataUrls, PullFile, PullReadFailure, PullRefusal } from './github-pull-detail'

export interface PullCommit {
  oid: string
  /** The first line of the commit message. */
  headline: string
  /** The GitHub account the commit is linked to; null = none (only the git author name is known). */
  author: GitHubIssueUser | null
  /** The git author name, shown when no account is linked. */
  authorName: string
  committedAt: string
  /** GitHub reports a valid signature. */
  verified: boolean
  /** Co-authors after the first author (login, else git name). Absent when none. */
  coAuthors?: string[]
  /** The commit's check rollup. Absent when it has none, or the state is new to this build. */
  ci?: 'passed' | 'failed' | 'pending'
}

/** One page of the PR's commits, oldest first. `after` = the cursor of the next page. */
export interface PullCommitsPage {
  commits: PullCommit[]
  after?: string
}

export type GitHubPullCommitsResult =
  /** `truncated` = more commits than the node reads; the rest is on GitHub. */
  | {
    status: 'ok'; commits: PullCommit[]; truncated: boolean; observedAt: number
    stale?: PullReadFailure; retryAt?: number; avatarDataUrls?: PullAvatarDataUrls
  }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** One page of a commit's changed files (`GET /commits/{sha}`). `parent` absent = a root commit. */
export interface PullCommitFilesPage {
  files: PullFile[]
  parent?: string
  nextPage?: number
}

export type GitHubPullCommitFilesResult =
  | {
    status: 'ok'; files: PullFile[]; parent?: string; truncated: boolean; observedAt: number
    stale?: PullReadFailure; retryAt?: number
  }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** A full commit SHA. */
export const isCommitSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)

// One pull request as the pull request node shows it (renderer/nodes/PullNode.tsx). Read on demand
// by core/github/service.ts `pullDetail`; never persisted (the node stores only the reference).
import type { GitHubIssueUser } from './github-issues'
import type { PullLifecycle, PullMergeState } from './github-pull-status'
import type { PullSidebar } from './github-pull-sidebar'
import { isRecord } from './is-record'

export interface GitHubPullDetail {
  number: number
  title: string
  /** Markdown, as the author wrote it. Render it only through the sanitizing renderer. */
  body: string
  lifecycle: PullLifecycle
  author: GitHubIssueUser | null
  /** Who merged it. Absent = not merged, or GitHub hid it (a deleted account). */
  mergedBy?: GitHubIssueUser
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  /** From the shared pull-status rules (`mergeState`). Absent when the PR is not open. */
  merge?: PullMergeState
  additions: number
  deletions: number
  changedFiles: number
  /** https://github.com/… only. */
  url: string
  /** Users asked to review and who have not reviewed yet. Absent = none. Teams are not listed. */
  requestedReviewers?: GitHubIssueUser[]
  /** GitHub's auto-merge is on ("Merge when ready"), with this method. Absent = off. */
  autoMerge?: { method: PullMergeMethod }
  /** The head branch lives in another repository (a fork): origin has it only as `pull/<n>/head`. */
  fromFork?: true
  /** Reviewers with state, assignees, labels, closing issues, participants. Absent = not read. */
  sidebar?: PullSidebar
  /** How many commits the PR has (the Commits tab's count). Absent = not reported. */
  commits?: number
}

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** The repository's collaborators, the people a review can be requested from. Read like a pull read. */
export type GitHubRepoCollaboratorsResult =
  | { status: 'ok'; users: GitHubIssueUser[] }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** Avatar images as data URLs keyed by `String(user.id)`, the kanban cards' shape. Filled in main by
 *  the hardened avatar fetcher; the renderer never loads a remote image. A missing key = fallback letter. */
export type PullAvatarDataUrls = Record<string, string>

/** Why a read produced no fresh answer. `signed-out` only for an answer GitHub gave about the token. */
export type PullReadFailure = 'throttled' | 'unreachable' | 'signed-out'

/** Why no request was made at all. Each has a named fix in the node. */
export type PullRefusal = 'not-approved' | 'signed-out' | 'repository-mismatch' | 'not-configured'

export type GitHubPullDetailResult =
  /** `stale` = the latest read failed; `detail` is the last one that succeeded, kept on purpose. */
  /** `ownPull` = the signed-in user wrote it, so GitHub refuses Approve and Request changes. */
  | { status: 'ok'; detail: GitHubPullDetail; observedAt: number; ownPull?: true; stale?: PullReadFailure; retryAt?: number; avatarDataUrls?: PullAvatarDataUrls }
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

/** Which side of a diff a line comment is on: LEFT = the base, RIGHT = the head. */
export type PullDiffSide = 'LEFT' | 'RIGHT'

/** One review comment on a diff line (`GET /pulls/{n}/comments`). `line` null = not on a current
 *  line: `outdated` (its line left the diff) or a comment on the whole file. */
export interface PullLineComment {
  id: number
  /** The review it was posted in. GitHub wraps even a single line comment in one. */
  reviewId: number | null
  /** The comment this one answers. Absent on the first comment of a thread. */
  inReplyTo?: number
  author: GitHubIssueUser | null
  body: string
  at: string
  url: string
  path: string
  side: PullDiffSide
  line: number | null
  outdated: boolean
}

/** One page of `GET /pulls/{n}/comments`, as the client reads it. */
export interface PullLineCommentsPage {
  comments: PullLineComment[]
  nextPage?: number
}

/** A new line comment, before it is sent: on its own, or in the review the user submits next. */
export interface PullLineDraft {
  path: string
  line: number
  side: PullDiffSide
  body: string
}

/** GitHub's comment body limit is 65,536 characters; the node keeps under it, as for reviews. */
export const MAX_PULL_COMMENT_BODY = 60_000
/** Pending line comments one review may carry. */
export const MAX_PULL_REVIEW_COMMENTS = 50

/** A new pull request's title: not blank, at most this long (GitHub's own form caps it at 256). */
export const MAX_PULL_TITLE = 256

/** A branch name git would accept as a ref and no CLI could read as a flag (`git check-ref-format`
 *  rules: no leading `-`, space, control, `~^:?*[` or backslash, `..`, `@{`, `//`, or a component ending in `.` or `.lock`). */
export function isPullBranchName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.startsWith('-') &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.(\/|$)|\.lock(\/|$)|^@$|(^|\/)\./.test(value)
}

/** One pull request to open: the branch to merge, where into, and what it says. */
export interface PullCreateDraft { head: string; base: string; title: string; body: string; draft: boolean }

/** Checked at the main/core boundary and again in the client. */
export function isPullCreateDraft(value: unknown): value is PullCreateDraft {
  const d = value as Partial<PullCreateDraft>
  return isRecord(value) && isPullBranchName(d.head) && isPullBranchName(d.base) &&
    typeof d.title === 'string' && d.title.trim().length > 0 && d.title.length <= MAX_PULL_TITLE &&
    typeof d.body === 'string' && d.body.length <= MAX_PULL_COMMENT_BODY && typeof d.draft === 'boolean'
}

/** "New pull request": where the form starts (the default branch) and the branch's open PR, if any. */
export type GitHubPullForBranchResult =
  | { status: 'ok'; defaultBranch: string; existing?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** A created pull request's number, or why none was created. */
export type PullCreateResult = { ok: true; pullNumber: number } | { ok: false; reason: PullWriteReason }

/** A repository path as GitHub names it: no empty, `.` or `..` segment and no NUL. */
export function isPullPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\u0000') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** A non-empty comment body under the limit. */
export function isPullCommentBody(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PULL_COMMENT_BODY
}

/** Checked at the main/core boundary and again in the client: path, line, side and body. */
export function isPullLineDraft(value: unknown): value is PullLineDraft {
  const draft = value as Partial<PullLineDraft>
  return isRecord(value) && isPullPath(draft.path) &&
    Number.isSafeInteger(draft.line) && (draft.line as number) >= 1 && (draft.line as number) <= 1_000_000 &&
    (draft.side === 'LEFT' || draft.side === 'RIGHT') && isPullCommentBody(draft.body)
}

/** One line comment as the client sends it: a new thread on a commit, or a reply to a thread. */
export type PullLineCommentWrite = { commitId: string; draft: PullLineDraft } | { inReplyTo: number; body: string }

/** A line comment the node sends on its own: a new thread at the head the user saw, or a reply. */
export type PullLineCommentRequest =
  | { projectId: string; repository: string; pullNumber: number; headSha: string; comment: PullLineDraft }
  | { projectId: string; repository: string; pullNumber: number; inReplyTo: number; body: string }

export type GitHubPullConversationResult =
  /** `items` oldest first. `truncated` = more pages than the node reads; the rest is on GitHub.
   *  `lineComments` oldest first: the Files tab threads them, the Conversation tab lists them under
   *  their review. `resolvedThreads` = the first comment id of each resolved thread; absent = unknown. */
  | {
    status: 'ok'; items: PullConversationItem[]; lineComments: PullLineComment[]; truncated: boolean; observedAt: number
    resolvedThreads?: number[]
    stale?: PullReadFailure; retryAt?: number; avatarDataUrls?: PullAvatarDataUrls
  }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** One issue's comments for the issues node (core `issueConversation`), oldest first. */
export type GitHubIssueConversationResult =
  | { status: 'ok'; items: PullConversationItem[]; truncated: boolean; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** What a review from the node says. REQUEST_CHANGES and COMMENT need a message; APPROVE does not. */
export type PullReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/** Why a write from the node did not land. Each has one sentence in the node (PullNodeView). */
export type PullWriteReason =
  | 'head-moved' | 'not-mergeable' | 'own-pull' | 'forbidden' | 'throttled' | 'signed-out' | 'not-approved' | 'validation' | 'network'
  /** Apply suggestion: the file changed since the suggestion was made; a fork head is not ours to commit to. */
  | 'suggestion-stale' | 'from-fork'
  /** Delete head branch: GitHub refused the delete (a protected branch, or one already gone). */
  | 'branch-protected'

/** How a merge from the node lands. The repository decides which ones it allows. */
export type PullMergeMethod = 'merge' | 'squash' | 'rebase'

/** The repository's allowed merge methods (`repoMergeMethods`), refused and failed as a pull read. */
export type GitHubRepoMergeMethodsResult =
  /** `autoMerge` = the repository allows "Merge when ready" (GitHub's auto-merge). */
  | { status: 'ok'; methods: PullMergeMethod[]; autoMerge?: true }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** The one answer every pull node write gives (comment, review, merge). */
export type PullWriteResult = { ok: true } | { ok: false; reason: PullWriteReason }

/** How a file changed in a PR. GitHub's `copied` reads as added, `changed`/`unchanged` as modified. */
export type PullFileStatus = 'added' | 'modified' | 'removed' | 'renamed'

/** One entry of the Files tab. `previousPath` only for a rename (the base side's path). */
export interface PullFile {
  path: string
  previousPath?: string
  status: PullFileStatus
  additions: number
  deletions: number
  /** The signed-in user's GitHub "Viewed" mark (GraphQL `viewerViewedState`); `DISMISSED` = it was
   *  viewed, then the file changed. Absent when the read could not say. */
  viewerViewedState?: PullViewedState
}

export type PullViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED'

/** One page of `GET /pulls/{n}/files`, as the client reads it. */
export interface PullFilesPage {
  files: PullFile[]
  nextPage?: number
}

export type GitHubPullFilesResult =
  /** `truncated` = more than the node lists (300); the rest is on GitHub. */
  | { status: 'ok'; files: PullFile[]; truncated: boolean; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** Why the node shows "cannot show this file". `not-in-pull`: the PR no longer changes that path. */
export type PullFileUnavailable = 'binary' | 'too-large' | 'not-in-pull'

/** One side of a diff: the file's text, or `empty` for the missing side of an added or removed file. */
export type PullFileSide = { kind: 'text'; text: string } | { kind: 'empty' }

/** One file version as the client reads it (`GET /contents/{path}?ref=`). */
export type PullFileRead = { kind: 'text'; text: string } | { kind: 'unavailable'; reason: 'binary' | 'too-large' }

export type PullFileContents =
  | { kind: 'diff'; base: PullFileSide; head: PullFileSide }
  | { kind: 'unavailable'; reason: PullFileUnavailable }

export type GitHubPullFileContentsResult =
  | { status: 'ok'; contents: PullFileContents; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

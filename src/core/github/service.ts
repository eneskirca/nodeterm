import type { Project } from '../../shared/types'
import type {
  CreateIssueInput,
  CreateMappedLabelsResult,
  GitHubIssue,
  GitHubIssueCardView,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubMutationResult,
  GitHubCloseReason,
  GitHubRepositoryLabel,
  GitHubThrottle,
  IssueHeartbeatResult,
  IssuePageResult,
  LabelPageResult,
  ListIssueOptions,
  GitHubIssueUser,
  NormalisedProjectKanbanGitHub,
  UpdateIssueInput
} from '../../shared/github-issues'
import type { GitHubAvatarFetcher } from './avatar-fetcher'
import {
  GitHubCacheError,
  type GitHubCompleteSnapshot,
  type GitHubIssueCache
} from './cache'
import { classifyGitHubFailure } from './failure'
import type { GitHubRequestCoordinator } from './request-coordinator'
import type { PullStatusRead } from './graphql-pulls'
import { isPullTimelineCursor, type GitHubPullTimelineResult, type PullTimelinePage } from '../../shared/github-pull-timeline'
import { GitHubPullStatusTracker } from './pull-status-tracker'
import type { GitHubPullBoard, GitHubPullChecksResult, PullLifecycle } from '../../shared/github-pull-status'
import { actionsJobOf, type GitHubPullCheckLogResult } from '../../shared/github-pull-check-log'
import type {
  GitHubPullConversationResult,
  GitHubIssueConversationResult,
  GitHubPullDetail,
  GitHubPullDetailResult,
  GitHubPullFileContentsResult,
  GitHubPullFilesResult,
  PullFile,
  PullFileContents,
  PullFileRead,
  PullFileSide,
  PullFilesPage,
  PullConversationItem,
  PullConversationPage,
  PullLineComment,
  PullLineCommentRequest,
  PullLineCommentWrite,
  PullLineCommentsPage,
  PullLineDraft,
  PullReadFailure,
  GitHubRepoMergeMethodsResult,
  GitHubRepoCollaboratorsResult,
  GitHubPullForBranchResult,
  PullCreateDraft,
  PullCreateResult,
  PullMergeMethod,
  PullRefusal,
  PullReviewEvent,
  PullViewedState,
  PullWriteReason,
  PullWriteResult
} from '../../shared/github-pull-detail'
import {
  GITHUB_LOGIN, MAX_PULL_REVIEW_COMMENTS, isPullBranchName, isPullCommentBody, isPullCreateDraft, isPullLineDraft, isPullPath
} from '../../shared/github-pull-detail'
import { parseGitHubRepository } from './config'
import { mergePullReviewers, type GitHubRepoLabelsResult, type PullLabel, type PullSidebar, type PullSidebarRead } from '../../shared/github-pull-sidebar'
import {
  isCommitSha, type GitHubPullCommitFilesResult, type GitHubPullCommitsResult, type PullCommit, type PullCommitFilesPage,
  type PullCommitsPage
} from '../../shared/github-pull-commits'
import { suggestionOf, withSuggestion } from './pull-suggestion'
import {
  MAX_COMPARE_FILES, type GitHubPullSinceReviewResult, type PullCompare, type PullViewerReview
} from '../../shared/github-pull-since-review'
import type { GitHubHostError } from './host'

const MAX_ISSUES = 10_000
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const FULL_REFRESH_AGE = 24 * 60 * 60_000
const POLL_MS = 60_000
/** Where the heartbeat's validator lives inside the snapshot's (long-existing, previously always
 *  empty) `etags` map, so it is persisted with the issues it vouches for and survives a restart. */
export const HEARTBEAT_ETAG_KEY = 'heartbeat'

/** Floor between two caller-driven refreshes of one project, and the longer floor for a FULL
 *  reconciliation. `refresh` is reachable from the renderer AND — for a shared project — from a
 *  relay guest, and nothing else bounds it: `state.refresh` coalesces CONCURRENT calls but not
 *  sequential ones, so an unthrottled caller can restart a whole-repository scan as fast as the
 *  previous one completes and spend the host's entire hourly quota (which is the ACCOUNT's quota —
 *  it degrades the user's `gh` CLI and github.com session too, not just nodeterm). Both floors sit
 *  under POLL_MS so the background poll is never the thing they throttle. */
export const REFRESH_MIN_INTERVAL_MS = 30_000
export const FULL_REFRESH_MIN_INTERVAL_MS = 120_000

/** Check detail is read when a PR's modal opens — reachable from the renderer AND a relay guest,
 *  and each read is a GraphQL request plus a credential resolve. So: the same PR within this window
 *  shares one read, and a project gets at most `PULL_CHECKS_PER_MINUTE` reads a minute. Both are
 *  checked before anything is resolved or sent. */
export const PULL_CHECKS_REUSE_MS = 15_000
/** Query bounds, checked before anything is read. */
const MAX_QUERY_SEARCH = 200
const MAX_QUERY_LABELS = 50
const MAX_QUERY_LABEL = 100
export const PULL_CHECKS_PER_MINUTE = 10

/** One review comment as "Apply suggestion" needs it (`GET /pulls/comments/{id}`). `line` null =
 *  outdated; `startLine` null = a one-line comment; `startSide` = the side `startLine` counts on;
 *  `commitId` = the head its line refers to. */
export interface PullSuggestionComment {
  pullNumber: number; path: string; side: 'LEFT' | 'RIGHT'; startSide: 'LEFT' | 'RIGHT'; line: number | null; startLine: number | null
  commitId: string; body: string; author: string | null
}

export interface GitHubIssuesClientLike {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
  issuesHeartbeat(repository: string, etag?: string): Promise<IssueHeartbeatResult>
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>
  updateIssue(repository: string, issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue>
  listRepositoryLabels(
    repository: string,
    options: { page: number; perPage: number; etag?: string }
  ): Promise<LabelPageResult>
  createLabel(
    repository: string,
    input: { name: string; color: string; description?: string }
  ): Promise<GitHubRepositoryLabel>
  /** Agent-filed gap reports (@core/github/report-issue-service). Declared here rather than only
   *  on the concrete client so `contextForProject` hands one caller everything it needs — the
   *  report path must never build a second authenticated client of its own. */
  createIssue(repository: string, input: CreateIssueInput): Promise<GitHubIssue>
  createIssueComment(repository: string, issueNumber: number, body: string): Promise<{ id: number }>
  /** Pull request CI + mergeability (one GraphQL read). Optional so a client that cannot make
   *  GraphQL reads — and every test fake written before them — simply has no pull status: the board
   *  then shows none, which is the honest answer. */
  pullRequestStatuses?(repository: string): Promise<PullStatusRead>
  pullRequestChecks?(repository: string, pullNumber: number): Promise<GitHubPullChecksResult>
  /** One PR's overview for the pull request node. Optional for the same reason as the two above. */
  getPull?(repository: string, pullNumber: number): Promise<GitHubPullDetail>
  /** One page each of a PR's issue comments and reviews (the Conversation tab). Optional, as above. */
  listPullComments?(repository: string, pullNumber: number, page: number): Promise<PullConversationPage>
  listPullReviews?(repository: string, pullNumber: number, page: number): Promise<PullConversationPage>
  /** One page of a PR's changed files, and one file at one commit (the Files tab). Optional, as above. */
  listPullFiles?(repository: string, pullNumber: number, page: number): Promise<PullFilesPage>
  getFileAt?(repository: string, path: string, ref: string): Promise<PullFileRead>
  /** The merge base of two commits, the base side GitHub diffs a PR against. Optional, as above. */
  mergeBase?(repository: string, base: string, head: string): Promise<string>
  /** The repository's allowed merge methods, and a merge tied to the head `sha`. Optional, as above. */
  repoMergeMethods?(repository: string): Promise<{ methods: PullMergeMethod[]; autoMerge: boolean }>
  mergePull?(repository: string, pullNumber: number, merge: { method: PullMergeMethod; sha: string }): Promise<void>
  /** "Update branch": merge the base into the head, tied to the head `sha`. Optional, as above. */
  updatePullBranch?(repository: string, pullNumber: number, sha: string): Promise<void>
  /** "Merge when ready": GitHub's auto-merge on (tied to the head `sha`) and off. Optional, as above. */
  enablePullAutoMerge?(repository: string, pullNumber: number, merge: { method: PullMergeMethod; sha: string }): Promise<void>
  disablePullAutoMerge?(repository: string, pullNumber: number): Promise<void>
  pullViewedStates?(repository: string, pullNumber: number): Promise<Record<string, PullViewedState>>
  setFileViewed?(repository: string, pullNumber: number, path: string, viewed: boolean): Promise<void>
  /** Resolve or unresolve the review thread whose first comment is `threadId`. Optional, as above. */
  setReviewThreadResolved?(repository: string, pullNumber: number, threadId: number, resolved: boolean): Promise<void>
  /** "Apply suggestion": the comment, one file with its blob SHA, and a contents-API commit pinned
   *  to that SHA. Optional, as above. */
  pullSuggestionComment?(repository: string, commentId: number): Promise<PullSuggestionComment>
  fileBlobAt?(repository: string, path: string, ref: string): Promise<{ sha: string; text: string }>
  putFile?(repository: string, file: { path: string; branch: string; sha: string; text: string; message: string }): Promise<void>
  /** Submit one review on a PR (the node's Approve / Request changes). Optional, as above. */
  reviewPull?(
    repository: string, pullNumber: number,
    review: { event: PullReviewEvent; body: string; commitId: string; comments?: PullLineDraft[] }
  ): Promise<{ id: number }>
  /** The review comments on diff lines, one page, and one new line comment or reply. Optional, as above. */
  listPullLineComments?(repository: string, pullNumber: number, page: number): Promise<PullLineCommentsPage>
  pullResolvedThreads?(repository: string, pullNumber: number): Promise<number[]>
  /** The Commits tab: one page of a PR's commits, and one page of one commit's files. Optional, as above. */
  listPullCommits?(repository: string, pullNumber: number, after?: string): Promise<PullCommitsPage>
  getCommitFiles?(repository: string, sha: string, page: number): Promise<PullCommitFilesPage>
  createPullLineComment?(
    repository: string, pullNumber: number,
    comment: PullLineCommentWrite
  ): Promise<{ id: number }>
  /** The node's "Request review": the collaborators, and one reviewer request. Optional, as above. */
  listCollaborators?(repository: string): Promise<GitHubIssueUser[]>
  requestPullReviewer?(repository: string, pullNumber: number, login: string): Promise<void>
  /** The sidebar's label and assignee edits, one name per call. Optional, as above. */
  setPullLabel?(repository: string, pullNumber: number, label: string, add: boolean): Promise<void>
  setPullAssignee?(repository: string, pullNumber: number, login: string, add: boolean): Promise<void>
  /** The merge box's close / reopen, ready for review and delete head branch. Optional, as above. */
  setPullState?(repository: string, pullNumber: number, open: boolean): Promise<void>
  markPullReady?(repository: string, pullNumber: number): Promise<void>
  deleteBranchRef?(repository: string, branch: string): Promise<void>
  /** The Checks tab's Actions extras: a failed job's log tail, and re-run a run's failed jobs. Optional, as above. */
  jobLogTail?(repository: string, jobId: number): Promise<string[]>
  rerunFailedJobs?(repository: string, runId: number): Promise<void>
  /** "New pull request": the form's start, and the create. Optional, as above. */
  pullForBranch?(repository: string, head: string): Promise<{ defaultBranch: string; existing?: number }>
  createPull?(repository: string, pull: PullCreateDraft): Promise<{ number: number }>
  /** The pull node sidebar (one GraphQL read). Optional, as above. */
  pullSidebar?(repository: string, pullNumber: number): Promise<PullSidebarRead>
  /** One page of a PR's Conversation timeline (GraphQL `timelineItems`). Optional, as above. */
  pullTimeline?(repository: string, pullNumber: number, after?: string): Promise<PullTimelinePage>
  /** One page of an issue's timeline (GraphQL `timelineItems`). Optional, as above. */
  issueTimeline?(repository: string, issueNumber: number, after?: string): Promise<PullTimelinePage>
  /** "Since my last review" (F-10): the viewer's latest review, and a compare of two commits
   *  (null = no such comparison). Optional, as above. */
  viewerLatestReview?(repository: string, pullNumber: number): Promise<PullViewerReview | null>
  compareCommits?(repository: string, base: string, head: string): Promise<PullCompare | null>
}

export interface GitHubIssueProjectContext {
  localApprovalId: string
  projectId: string
  repository: string
  config: NormalisedProjectKanbanGitHub
  controlRevision: number
  columnColors: Record<string, string>
  /** This machine approved the column mapping now on disk (see `githubMappingDigest`). Without it
   *  the board reads but never writes: the mapping decides what a write DOES, and it arrives
   *  through the git-shared project file. */
  mappingApproved: boolean
  /** The project this context was resolved from (in-process only). The read-only control verbs use
   *  it so a call loads the workspace once, not a second time for the nodes and board. */
  project?: Project
}

/** What `controlSnapshot` answers: the cached board state of one project, no request made. */
export interface GitHubControlSnapshot {
  repository: string
  /** The project the snapshot was resolved for (nodes, board columns, pull-link tombstones). */
  project?: Project
  completionColumnId?: string
  mappingApproved: boolean
  /** Issues AND pull requests of the harvest, each with the column its labels map it to. */
  items: GitHubIssueCardView[]
  /** A complete harvest exists (from this run or the on-disk cache). */
  hasSnapshot: boolean
  /** Only a partial harvest exists (the repository is over the issue/byte bounds). */
  partial: boolean
  incomplete: boolean
  pullsTruncated: boolean
  /** Epoch ms of the last complete refresh — how old the list is. */
  lastSuccessfulRefreshAt?: number
  pullBoard: GitHubPullBoard
  throttle?: GitHubThrottle
}

export interface GitHubIssueServiceContext extends GitHubIssueProjectContext {
  credentialGeneration: number
  userId: string
  client: GitHubIssuesClientLike
}

type TimerId = ReturnType<typeof setInterval> | number
type ServiceOptions = {
  cache: GitHubIssueCache
  coordinator: GitHubRequestCoordinator
  contextForProject(projectId: string): Promise<GitHubIssueServiceContext>
  projectContextForCache?(projectId: string): Promise<GitHubIssueProjectContext>
  projectContextForCacheDeletion?(projectId: string): Promise<GitHubIssueProjectContext>
  avatarFetcher?: GitHubAvatarFetcher
  now?: () => number
  setInterval?: (fn: () => void, milliseconds: number) => TimerId
  clearInterval?: (timer: TimerId) => void
  onDelta?: (uiId: number, projectId: string, changedIssueNumbers: number[]) => void
}

type RepositoryState = {
  snapshot?: GitHubCompleteSnapshot
  partialIssues?: GitHubIssue[]
  incomplete: boolean
  subscribers: Map<string, Set<number>>
  timer?: TimerId
  refresh?: Promise<void>
  cacheGeneration: number
  /** The throttle deadline subscribers were last prompted about, so a held poll re-prompts them
   *  once per deadline instead of once a minute. */
  announcedThrottleUntil?: number
}

type RepositoryControl = {
  generation: number
  clearCutoff: number
  deletion?: Promise<void>
}

/** The host's coded refusals (host.ts `GitHubHostError`; read by shape at runtime, since host
 *  imports this module, but keyed by its code union so a renamed code fails to compile). */
const PULL_REFUSALS: Partial<Record<GitHubHostError['code'], PullRefusal>> = {
  'not-approved': 'not-approved',
  'not-authenticated': 'signed-out',
  'invalid-token': 'signed-out',
  'repository-mismatch': 'repository-mismatch',
  'project-not-found': 'not-configured',
  'invalid-configuration': 'not-configured',
  'repository-not-found': 'not-configured'
}

/** What a failed pull read means, decided only by `classifyGitHubFailure`. */
function pullReadFailure(error: unknown): { reason: PullReadFailure; retryAt?: number } {
  const failure = classifyGitHubFailure(error)
  if (failure.kind === 'unauthorized') return { reason: 'signed-out' }
  if (failure.kind === 'not-found') return { reason: 'not-found' }
  if (failure.kind === 'rate-limited') {
    return failure.retryAt !== undefined ? { reason: 'throttled', retryAt: failure.retryAt } : { reason: 'throttled' }
  }
  return { reason: 'unreachable' }
}

/** A host refusal (coded context error) as the node names it, else undefined. */
function pullRefusalOf(error: unknown): PullRefusal | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? PULL_REFUSALS[code as GitHubHostError['code']] : undefined
}

/** Why a pull write that reached GitHub (or the coordinator) did not land. A write has answers a
 *  read never gets (own-pull, a 403 that means "may not write", a 422); everything else is
 *  decided by `classifyGitHubFailure`, as for reads. */
function pullWriteFailure(error: unknown): PullWriteReason {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown }
  if (code === 'own-pull') return 'own-pull'
  if (code === 'suggestion-stale' || code === 'from-fork') return code
  // A write the token may not make: a 403 that is not a rate limit.
  if (code === 'insufficient-permission' || (code === 'request-failed' && status === 403)) {
    return 'forbidden'
  }
  if (code === 'request-failed' && status === 422) return 'validation'
  // A merge: 409 = the head is no longer the sha the node sent; 405 = GitHub will not merge it now.
  if (code === 'request-failed' && status === 409) return 'head-moved'
  if (code === 'request-failed' && status === 405) return 'not-mergeable'
  const failure = classifyGitHubFailure(error)
  if (failure.kind === 'unauthorized') return 'signed-out'
  if (failure.kind === 'not-found') return 'not-found'
  if (failure.kind === 'rate-limited') return 'throttled'
  return 'network'
}

/** Update branch and auto-merge are tied to a head like a merge, but GitHub answers a head that is
 *  no longer the one sent with 422 there (a merge gets 409). ponytail: any 422 reads as head-moved
 *  (for auto-merge also "the PR can merge now"); either way the node reloads and the user looks again. */
async function headMovedOn422<T>(write: Promise<T>): Promise<T> {
  try {
    return await write
  } catch (error) {
    const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown }
    if (code === 'request-failed' && status === 422) throw Object.assign(new Error('head-moved'), { code, status: 409 })
    throw error
  }
}

/** What every pull node read answers: fresh (or the last good answer, marked stale), a refusal
 *  made before any request, or a failure. `GitHubPullDetailResult` and the conversation's share it. */
type PullOk = { status: 'ok'; observedAt: number; stale?: PullReadFailure; retryAt?: number }
type PullResult<O extends PullOk> =
  | O
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** A read that produced no fresh answer: the last good answer marked stale, else the failure. */
function stalePull<O extends PullOk>(last: O | undefined, error: unknown): PullResult<O> {
  const failure = pullReadFailure(error)
  return last
    ? { ...last, stale: failure.reason, ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}) }
    : { status: 'failed', ...failure }
}

/** Pull read entries kept for the stale fallback and the refresh floor. Oldest go first. */
const MAX_PULL_READS = 100

/** Pages of 100 read per list for the Conversation tab; past it the node says the rest is on GitHub. */
const MAX_CONVERSATION_PAGES = 10

/** Files the Files tab lists (3 pages of 100); past it the node says the rest is on GitHub. */
const MAX_PULL_FILES = 300
/** Pages of 100 commits the Commits tab reads; GitHub lists at most 250 commits of a PR anyway. */
const MAX_COMMIT_PAGES = 3

function repositoryKey(context: GitHubIssueServiceContext): string {
  return `${context.userId}\0${context.repository}`
}

function epoch(context: GitHubIssueServiceContext): string {
  return JSON.stringify([
    context.localApprovalId,
    context.projectId,
    context.repository,
    context.config.revision,
    context.controlRevision,
    context.credentialGeneration,
    context.userId
  ])
}

function foldLabel(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function mapping(issue: GitHubIssue, config: NormalisedProjectKanbanGitHub): {
  columnId: string | null
  conflict: GitHubIssueCardView['conflict']
} {
  if (issue.state === 'closed') {
    return { columnId: config.completionColumnId ?? null, conflict: null }
  }
  const labelNames = new Set(issue.labels.map((label) => foldLabel(label.name)))
  const matches = config.columnMappings.filter((item) =>
    labelNames.has(foldLabel(item.label)))
  if (matches.length > 1) return { columnId: null, conflict: 'multiple-mapped-labels' }
  if (matches.length === 1 && matches[0].columnId === config.completionColumnId) {
    return { columnId: null, conflict: 'open-with-completion-label' }
  }
  return { columnId: matches[0]?.columnId ?? null, conflict: null }
}

/** Trims a harvest to a bound by dropping PULL REQUESTS first, oldest-updated first.
 *  Issues are never dropped to make room for a pull request: the issue lane shipped first and
 *  a repository big enough to overflow must degrade in the new half, not turn the board it
 *  already had read only. Returns null when the issues ALONE still miss the bound — that is the
 *  caller's existing incomplete path, unchanged. `fits` is a predicate so the same order serves
 *  the item count and the byte ceiling. */
export function evictPullsToFit(
  items: GitHubIssue[],
  fits: (candidate: GitHubIssue[]) => boolean
): { items: GitHubIssue[]; pullsTruncated: boolean } | null {
  if (fits(items)) return { items, pullsTruncated: false }
  const issues = items.filter((item) => !item.pull)
  if (!fits(issues)) return null
  const pulls = items.filter((item) => item.pull)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
  // Binary search the largest surviving prefix: `fits` may stringify the whole harvest, so
  // dropping one at a time would be O(n²) on a repository near the ceiling.
  let low = 0
  let high = pulls.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits([...issues, ...pulls.slice(0, middle)])) low = middle
    else high = middle - 1
  }
  return { items: [...issues, ...pulls.slice(0, low)], pullsTruncated: true }
}

function mutationChain<T>(
  chains: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  let resolveResult: (value: T) => void
  let rejectResult: (error: unknown) => void
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const next = previous.then(async () => {
    try { resolveResult(await operation()) } catch (error) { rejectResult(error) }
  })
  chains.set(key, next)
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key) })
  return result
}

export class GitHubIssueService {
  private readonly repositories = new Map<string, RepositoryState>()
  private readonly projectKeys = new Map<string, string>()
  private readonly issueChains = new Map<string, Promise<void>>()
  private readonly repositoryControls = new Map<string, RepositoryControl>()
  private readonly statePreparations = new Map<string, Set<Promise<RepositoryState>>>()
  private readonly refreshFloors = new Map<string, { any: number; full: number }>()
  /** Pull request CI/mergeability per repository key — see pull-status-tracker.ts. */
  private readonly pulls: GitHubPullStatusTracker
  private readonly checkReads = new Map<string, { at: number; result: Promise<GitHubPullChecksResult> }>()
  private readonly checkStarts = new Map<string, number[]>()
  /** Allowed merge methods per identity and repository, held for this core's run (GitHub's repo
   *  settings rarely change, and a merge GitHub refuses still says why). Successful reads only. */
  private readonly mergeMethods = new Map<string, { methods: PullMergeMethod[]; autoMerge: boolean }>()
  private readonly collaborators = new Map<string, GitHubIssueUser[]>()
  private readonly repoLabelLists = new Map<string, PullLabel[]>()
  /** Merge base per `base\0head` SHA pair. Commits are immutable, so an answer never ages. */
  private readonly mergeBases = new Map<string, string>()
  private readonly pullReads = new Map<string, {
    last?: PullOk
    floorUntil: number
    reading?: Promise<PullResult<PullOk>>
  }>()
  private operationSequence = 0
  private readonly now: () => number
  private readonly schedule: NonNullable<ServiceOptions['setInterval']>
  private readonly unschedule: NonNullable<ServiceOptions['clearInterval']>

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.setInterval ?? ((fn, milliseconds) => setInterval(fn, milliseconds))
    this.unschedule = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
    this.pulls = new GitHubPullStatusTracker({
      coordinator: options.coordinator,
      now: this.now,
      onChanged: (key, changed) => {
        const state = this.repositories.get(key)
        if (state) this.emitDelta(state, changed, true)
      },
      memory: {
        load: (userId, repository) => options.cache.loadPullMemory(userId, repository),
        save: (userId, repository, memory) => options.cache.savePullMemory(userId, repository, memory)
      },
      harvest: (key) => {
        const lifecycles = new Map<number, PullLifecycle>()
        for (const item of this.repositories.get(key)?.snapshot?.issues ?? []) {
          if (!item.pull) continue
          lifecycles.set(item.number, item.state === 'closed'
            ? item.pull.mergedAt ? 'merged' : 'closed'
            : item.pull.draft ? 'draft' : 'open')
        }
        return lifecycles
      }
    })
  }

  async subscribe(uiId: number, request: { projectId: string }): Promise<GitHubIssuePage> {
    const context = await this.cacheContext(request.projectId)
    const { key, state } = await this.cachedState(context)
    const firstSubscriber = this.subscriberCount(state) === 0
    let subscribers = state.subscribers.get(request.projectId)
    if (!subscribers) {
      subscribers = new Set()
      state.subscribers.set(request.projectId, subscribers)
    }
    subscribers.add(uiId)
    this.projectKeys.set(request.projectId, key)
    if (firstSubscriber) {
      if (!state.snapshot && !state.partialIssues) {
        try { await this.refresh({ projectId: request.projectId }) } catch { /* offline cache remains readable */ }
      } else {
        void this.refresh({ projectId: request.projectId }).catch(() => undefined)
      }
    }
    const activeKey = this.projectKeys.get(request.projectId)
    this.ensureTimer(activeKey ? this.repositories.get(activeKey) ?? state : state)
    return this.query({ projectId: request.projectId, columnId: null, pageSize: 50 })
  }

  unsubscribe(uiId: number, projectId: string): void {
    const key = this.projectKeys.get(projectId)
    const state = key ? this.repositories.get(key) : undefined
    if (!state) return
    const subscribers = state.subscribers.get(projectId)
    subscribers?.delete(uiId)
    if (subscribers?.size === 0) state.subscribers.delete(projectId)
    if (this.subscriberCount(state) === 0 && state.timer) {
      this.unschedule(state.timer)
      delete state.timer
    }
  }

  dropClient(uiId: number): void {
    for (const state of this.repositories.values()) {
      for (const [projectId, subscribers] of state.subscribers) {
        subscribers.delete(uiId)
        if (subscribers.size === 0) state.subscribers.delete(projectId)
      }
      if (this.subscriberCount(state) === 0 && state.timer) {
        this.unschedule(state.timer)
        delete state.timer
      }
    }
  }

  async refresh(request: { projectId: string; full?: boolean }): Promise<void> {
    // The floor is checked BEFORE contextForProject on purpose: resolving a context runs the whole
    // credential chain (gh subprocesses + a /user round trip), so a throttle placed after it would
    // still pay the expensive half of every call it rejects.
    const full = request.full === true
    const startedAt = this.now()
    const previousFloor = this.refreshFloors.get(request.projectId)
    if (previousFloor && startedAt < (full ? previousFloor.full : previousFloor.any)) return
    this.refreshFloors.set(request.projectId, {
      any: startedAt + REFRESH_MIN_INTERVAL_MS,
      // An incremental pass does not satisfy a full reconciliation, so it never moves that floor.
      full: full ? startedAt + FULL_REFRESH_MIN_INTERVAL_MS : previousFloor?.full ?? 0
    })
    try {
      // Reuse the clock read above as the refresh's own start stamp: one read per refresh keeps the
      // incremental watermark anchored to when the work actually began.
      // A foreground refresh is never held by the budget, so there is no throttle to hand back.
      await this.refreshWithinFloor(request, startedAt)
    } catch (error) {
      // A refresh that FAILED bought nothing, so it must not hold the floor — otherwise the first
      // network blip disables the board's own Retry button for the next 30 seconds.
      if (this.refreshFloors.get(request.projectId)?.any === startedAt + REFRESH_MIN_INTERVAL_MS) {
        if (previousFloor) this.refreshFloors.set(request.projectId, previousFloor)
        else this.refreshFloors.delete(request.projectId)
      }
      throw error
    }
  }

  /** Resolves to the throttle when a BACKGROUND refresh was held by the rate budget (nothing was
   *  sent), otherwise to nothing. */
  private async refreshWithinFloor(
    request: { projectId: string; full?: boolean },
    startedAt = this.now(),
    background = false
  ): Promise<GitHubThrottle | void> {
    const operationId = ++this.operationSequence
    const captured = await this.options.contextForProject(request.projectId)
    if (background) {
      // Checked after the context resolves because the budget belongs to an IDENTITY, and only the
      // context knows which one. Nothing below this line has spent a request yet.
      const throttle = this.options.coordinator.throttle(captured.userId)
      if (throttle) return throttle
    }
    const control = this.repositoryControl(captured.repository)
    if (control.deletion || operationId <= control.clearCutoff) return
    const repositoryGeneration = control.generation
    let state: RepositoryState
    try {
      state = await this.state(captured, operationId, repositoryGeneration)
    } catch (error) {
      if (error instanceof RepositoryClearedError) return
      throw error
    }
    if (state.refresh) return state.refresh
    const cacheGeneration = state.cacheGeneration
    const work = this.refreshRepository(
      captured, state, request.full === true, cacheGeneration, operationId, repositoryGeneration,
      startedAt, background
    )
    state.refresh = work
    try { await work } finally { if (state.refresh === work) delete state.refresh }
  }

  async query(request: GitHubIssueQuery): Promise<GitHubIssuePage> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 50) {
      throw new Error('invalid-query')
    }
    // Bounded before anything is read: both strings arrive from a renderer or a relay peer.
    if ((request.search !== undefined && (typeof request.search !== 'string' || request.search.length > MAX_QUERY_SEARCH)) ||
        (request.labelFilter !== undefined && (!Array.isArray(request.labelFilter) ||
          request.labelFilter.length > MAX_QUERY_LABELS ||
          request.labelFilter.some((label) => typeof label !== 'string' || label.length > MAX_QUERY_LABEL)))) {
      throw new Error('invalid-query')
    }
    const context = await this.cacheContext(request.projectId)
    if (request.repository !== undefined &&
        (typeof request.repository !== 'string' || request.repository.toLowerCase() !== context.repository.toLowerCase())) {
      throw new Error('repository-mismatch')
    }
    const { state, userId } = await this.cachedState(context)
    const throttle = userId ? this.options.coordinator.throttle(userId) : undefined
    // One snapshot holds both kinds (they arrive on the same endpoint), so the kind filter is
    // what keeps the issue lane's items and counts exactly what they were before pull requests
    // were harvested. An absent kind means issues.
    const wantPull = request.kind === 'pull'
    const source = (state.snapshot?.issues ?? state.partialIssues ?? [])
      .filter((item) => !!item.pull === wantPull)
    const mapped = source.map((issue): GitHubIssueCardView => ({ ...issue, ...mapping(issue, context.config) }))
    const search = request.search?.trim().toLocaleLowerCase('en-US') ?? ''
    const filters = new Set((request.labelFilter ?? []).map((item) =>
      foldLabel(item.replace(/^github:/, ''))))
    const filtered = mapped.filter((item) => !search || item.title.toLocaleLowerCase('en-US').includes(search) ||
        String(item.number).includes(search))
      .filter((item) => filters.size === 0 || item.labels.some((label) =>
        filters.has(foldLabel(label.name))))
    // The issues node lists every column at once, open only, optionally the signed-in user's.
    const visible = filtered.filter((item) => request.anyColumn === true || item.columnId === request.columnId)
      .filter((item) => request.openOnly !== true || item.state === 'open')
      .filter((item) => request.assignedToMe !== true ||
        (!!userId && item.assignees.some((user) => String(user.id) === userId)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
    const offset = request.cursor ? Number(request.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid-query')
    const page = visible.slice(offset, offset + request.pageSize)
    if (this.options.avatarFetcher) {
      const avatars = await this.options.avatarFetcher.forPage(page.flatMap((item) => item.assignees))
      for (const item of page) {
        const entries = item.assignees.flatMap((user) => {
          const data = avatars.dataUrls.get(user.id)
          return data ? [[String(user.id), data] as const] : []
        })
        if (entries.length) item.avatarDataUrls = Object.fromEntries(entries)
      }
    }
    const counts: Record<string, number> = {}
    for (const item of filtered) {
      counts[item.columnId ?? 'ungrouped'] = (counts[item.columnId ?? 'ungrouped'] ?? 0) + 1
    }
    return {
      items: page,
      counts,
      ...(offset + page.length < visible.length ? { nextCursor: String(offset + page.length) } : {}),
      partial: (!state.snapshot && !!state.partialIssues) ||
        (wantPull && !!state.snapshot?.pullsTruncated),
      // The board never writes a pull request, so its page says so on the wire rather than
      // relying on every consumer to remember.
      readOnly: wantPull || !context.mappingApproved ||
        state.incomplete || !state.snapshot || !context.config.completionColumnId,
      ...(context.mappingApproved ? {} : { mappingNotApproved: true as const }),
      ...(state.snapshot ? {
        lastSuccessfulRefreshAt: state.snapshot.lastSuccessfulRefreshAt,
        lastFullReconciliationAt: state.snapshot.lastFullReconciliationAt
      } : {}),
      ...(throttle ? { throttle } : {})
    }
  }

  moveIssue(request: {
    projectId: string
    issueNumber: number
    toColumnId: string | null
    expectedUpdatedAt: string
    closeReason?: GitHubCloseReason
  }): Promise<GitHubMutationResult> {
    // Reachable from the renderer and from a relay guest: an unknown reason is refused here, before
    // anything is read or written, rather than forwarded for GitHub to reject after a round trip.
    if (request.closeReason !== undefined &&
        request.closeReason !== 'completed' && request.closeReason !== 'not_planned') {
      return Promise.resolve({ status: 'invalid-target' })
    }
    const operationId = ++this.operationSequence
    return mutationChain(this.issueChains, `${request.projectId}:${request.issueNumber}`, async () => {
      const captured = await this.options.contextForProject(request.projectId)
      const capturedEpoch = epoch(captured)
      const repositoryGeneration = this.repositoryControl(captured.repository).generation
      let state: RepositoryState
      try {
        state = await this.state(captured, operationId, repositoryGeneration)
      } catch (error) {
        if (error instanceof RepositoryClearedError) return { status: 'read-only' }
        throw error
      }
      const cacheGeneration = state.cacheGeneration
      if (!captured.mappingApproved || state.incomplete || !state.snapshot ||
          !captured.config.completionColumnId) {
        return { status: 'read-only' }
      }
      const target = state.snapshot.issues.find((item) => item.number === request.issueNumber)
      // A pull request shares the issue number space and now lives in the same snapshot, so the
      // membership check alone would let one through to a write path that cannot serve it.
      if (!target || target.pull) return { status: 'invalid-target' }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const latest = await this.readWithEpoch(captured, () =>
        captured.client.getIssue(captured.repository, request.issueNumber))
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!latest) return { status: 'configuration-changed' }
      if (latest.updatedAt !== request.expectedUpdatedAt) {
        if (cacheGeneration !== state.cacheGeneration ||
            !this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration)) {
          return { status: 'stale', issue: latest }
        }
        state.snapshot = {
          ...state.snapshot,
          issues: state.snapshot.issues.map((item) => item.number === latest.number ? latest : item)
        }
        try {
          await this.options.cache.saveComplete(captured.userId, captured.repository, state.snapshot)
        } catch { /* the validated in-memory issue remains available for this process */ }
        this.emitDelta(state, [latest.number])
        return { status: 'stale', issue: latest }
      }
      const destination = request.toColumnId === null
        ? null
        : captured.config.columnMappings.find((item) => item.columnId === request.toColumnId)
      if (request.toColumnId !== null && !destination) return { status: 'invalid-target' }
      const mappedNames = new Set(captured.config.columnMappings.map((item) =>
        foldLabel(item.label)))
      const labels = latest.labels.map((label) => label.name)
        .filter((name) => !mappedNames.has(foldLabel(name)))
      if (destination) labels.push(destination.label)
      const desiredState = request.toColumnId === captured.config.completionColumnId
        ? 'closed'
        : 'open'
      const input: UpdateIssueInput = {
        // Send `state` ONLY when it actually changes. GitHub rewrites `state_reason` for any write
        // that carries `state`, so re-closing an already-closed issue turns a deliberate
        // 'not_planned' (wontfix) into 'completed'. Closed issues all map into the completion
        // column, so a drag that lands one back where it already sits is a no-op the user never
        // meant as a state change — and it must not be one on GitHub either.
        // When it DOES change, the reason travels with it: the one the user picked for a close
        // (GitHub's own default, `completed`, when none was given), and `reopened` for a reopen.
        ...(latest.state === desiredState ? {} : {
          state: desiredState,
          stateReason: desiredState === 'closed' ? request.closeReason ?? 'completed' : 'reopened'
        }),
        labels
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const updated = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
          throw new ConfigurationChangedError()
        }
        return captured.client.updateIssue(captured.repository, request.issueNumber, input)
      }).catch((error: unknown) => {
        if (error instanceof ConfigurationChangedError) return null
        throw error
      })
      if (!updated) return { status: 'configuration-changed' }
      const confirmedLabels = new Set(updated.labels.map((label) =>
        label.name.normalize('NFKC').toLocaleLowerCase('en-US')))
      const expectedLabels = new Set(labels.map((label) =>
        label.normalize('NFKC').toLocaleLowerCase('en-US')))
      if (updated.state !== desiredState ||
          (input.state === 'closed' && updated.stateReason !== input.stateReason) ||
          confirmedLabels.size !== expectedLabels.size ||
          [...expectedLabels].some((label) => !confirmedLabels.has(label))) {
        throw new Error('mutation-not-confirmed')
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'confirmed', issue: updated }
      }
      if (cacheGeneration !== state.cacheGeneration) {
        return { status: 'refresh-pending', issue: updated }
      }
      if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration)) {
        return { status: 'refresh-pending', issue: updated }
      }
      // The write folds ONE issue into the snapshot and leaves `lastSuccessfulRefreshAt` alone: that
      // is the incremental scan's `since` cursor, and only a completed scan has looked at everything
      // up to it. Advancing it here skipped any third party's change that landed between the last
      // scan and this write until the next daily full reconciliation.
      const snapshot = state.snapshot ?? {
        issues: [], etags: {}, lastSuccessfulRefreshAt: 0, lastFullReconciliationAt: 0
      }
      const issues = snapshot.issues.some((item) => item.number === updated.number)
        ? snapshot.issues.map((item) => item.number === updated.number ? updated : item)
        : [...snapshot.issues, updated]
      state.snapshot = { ...snapshot, issues }
      state.partialIssues = undefined
      try {
        await this.options.cache.saveComplete(captured.userId, captured.repository, state.snapshot)
      } catch {
        return { status: 'refresh-pending', issue: updated }
      }
      this.emitDelta(state, [updated.number])
      return { status: 'confirmed', issue: updated }
    })
  }

  async createMissingLabels(request: { projectId: string }): Promise<CreateMappedLabelsResult> {
    const operationId = ++this.operationSequence
    const captured = await this.options.contextForProject(request.projectId)
    const capturedEpoch = epoch(captured)
    const repositoryGeneration = this.repositoryControl(captured.repository).generation
    let state: RepositoryState
    try {
      state = await this.state(captured, operationId, repositoryGeneration)
    } catch (error) {
      if (error instanceof RepositoryClearedError) {
        return { status: 'read-only', created: [], remaining:
          captured.config.columnMappings.map((item) => item.label) }
      }
      throw error
    }
    // Label names come from the column mapping, so creating them is a write the mapping drives.
    if (!captured.mappingApproved || state.incomplete || !captured.config.completionColumnId) {
      return {
        status: 'read-only',
        created: [],
        remaining: captured.config.columnMappings.map((item) => item.label)
      }
    }
    const known = new Set<string>()
    let page = 1
    while (true) {
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return {
          status: 'configuration-changed',
          created: [],
          remaining: captured.config.columnMappings.map((item) => item.label)
        }
      }
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listRepositoryLabels(captured.repository, { page, perPage: 100 }))
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!result) {
        return { status: 'configuration-changed', created: [], remaining:
          captured.config.columnMappings.map((item) => item.label) }
      }
      for (const label of result.items) known.add(label.name.normalize('NFKC').toLocaleLowerCase('en-US'))
      if (!result.nextPage) break
      page = result.nextPage
    }
    const pending = captured.config.columnMappings.filter((item) =>
      !known.has(item.label.normalize('NFKC').toLocaleLowerCase('en-US')))
    const created: string[] = []
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index]
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return {
          status: 'configuration-changed',
          created,
          remaining: pending.filter((candidate) => !created.includes(candidate.label))
            .map((candidate) => candidate.label)
        }
      }
      const current = await this.repositoryLabelNames(captured).catch((error: unknown) =>
        error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!current) {
        return {
          status: 'configuration-changed', created,
          remaining: pending.slice(index).map((candidate) => candidate.label)
        }
      }
      const folded = item.label.normalize('NFKC').toLocaleLowerCase('en-US')
      if (current.has(folded)) continue
      const color = captured.columnColors[item.columnId]?.replace(/^#/, '')
      const result = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
          throw new ConfigurationChangedError()
        }
        return captured.client.createLabel(captured.repository, {
          name: item.label,
          color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '8b5cf6'
        })
      }).catch(async (error: unknown) => {
        if (error instanceof ConfigurationChangedError) return null
        const after = await this.repositoryLabelNames(captured).catch(() => null)
        if (after?.has(folded)) return { concurrent: true } as const
        return { failed: true } as const
      })
      if (!result) {
        return {
          status: 'configuration-changed',
          created,
          remaining: pending.filter((candidate) => !created.includes(candidate.label))
            .map((candidate) => candidate.label)
        }
      }
      if ('failed' in result) {
        return {
          status: 'partial', created,
          remaining: pending.slice(index).map((candidate) => candidate.label)
        }
      }
      if ('concurrent' in result) {
        known.add(folded)
      } else {
        known.add(result.name.normalize('NFKC').toLocaleLowerCase('en-US'))
        created.push(item.label)
      }
    }
    return { status: 'confirmed', created, remaining: [] }
  }

  async clearCache(request: { projectId: string }): Promise<void> {
    const clearOperationId = ++this.operationSequence
    const context = this.options.projectContextForCacheDeletion
      ? await this.options.projectContextForCacheDeletion(request.projectId)
      : await this.cacheContext(request.projectId)
    const control = this.repositoryControl(context.repository)
    if (control.deletion) await control.deletion
    let finishDeletion!: () => void
    const deletion = new Promise<void>((resolve) => { finishDeletion = resolve })
    control.clearCutoff = Math.max(control.clearCutoff, clearOperationId)
    control.generation += 1
    control.deletion = deletion
    try {
      const affected = this.repositoryStates(context.localApprovalId, context.repository)
      for (const state of affected) state.cacheGeneration += 1
      const mutations = [...this.issueChains.values()]
      await Promise.allSettled([
        ...this.statePreparations.get(context.repository) ?? [],
        ...affected.flatMap((state) => state.refresh ? [state.refresh] : []),
        ...mutations,
        // Forgotten BEFORE the files go, and waited for: a memory save already under way would
        // otherwise write the pull memory back after clearBound deleted it.
        this.pulls.forgetRepository(context.repository)
      ])
      await this.options.cache.clearBound(context.localApprovalId, context.projectId, context.repository)
      for (const state of this.repositoryStates(context.localApprovalId, context.repository)) {
        state.cacheGeneration += 1
        state.snapshot = undefined
        state.partialIssues = undefined
        state.incomplete = false
        this.emitDelta(state, [], true)
      }
    } finally {
      if (control.deletion === deletion) delete control.deletion
      finishDeletion()
    }
  }

  /** What the board knows about this project's pull requests beyond the issues harvest. Read from
   *  memory only — it never sends a request. */
  async pullStatus(request: { projectId: string }): Promise<GitHubPullBoard> {
    const context = await this.cacheContext(request.projectId)
    const { key } = await this.cachedState(context)
    const board = this.pulls.board(key)
    // The add menu's open PR list: avatars of open PR authors, from the hardened fetcher's cache.
    const avatarDataUrls = await this.pullAvatars(board.pulls
      .filter((pull) => pull.lifecycle === 'open' || pull.lifecycle === 'draft')
      .map((pull) => pull.authorUser ?? null))
    return avatarDataUrls ? { ...board, avatarDataUrls } : board
  }

  /**
   * Everything the read-only control verbs (`issues` / `prs`, core/github/control-read.ts) show, from
   * what this process ALREADY holds: the issue cache and the pull tracker's memory. It sends no
   * request, resolves no credential and starts no poll — an agent's read must never spend the
   * account's GitHub budget or wake a repository nobody has subscribed to. Throws the host's coded
   * errors (`not-approved`, `invalid-configuration`, …) exactly like `query`, so a caller can say
   * WHY there is nothing to show rather than "0 issues".
   */
  async controlSnapshot(projectId: string): Promise<GitHubControlSnapshot> {
    const context = await this.cacheContext(projectId)
    const { key, state, userId } = await this.cachedState(context)
    const source = state.snapshot?.issues ?? state.partialIssues ?? []
    const throttle = userId ? this.options.coordinator.throttle(userId) : undefined
    return {
      repository: context.repository,
      ...(context.project ? { project: context.project } : {}),
      completionColumnId: context.config.completionColumnId,
      mappingApproved: context.mappingApproved,
      items: source.map((issue): GitHubIssueCardView => ({ ...issue, ...mapping(issue, context.config) })),
      hasSnapshot: !!state.snapshot,
      partial: !state.snapshot && !!state.partialIssues,
      incomplete: state.incomplete,
      pullsTruncated: !!state.snapshot?.pullsTruncated,
      ...(state.snapshot ? { lastSuccessfulRefreshAt: state.snapshot.lastSuccessfulRefreshAt } : {}),
      pullBoard: this.pulls.board(key),
      ...(throttle ? { throttle } : {})
    }
  }

  /**
   * A VISIBLE board asks this while some PR is undecided. It answers false at the cost of a map
   * lookup unless a chase read is due, so a board may ask as often as it likes: the schedule and the
   * cap of 12 live here, and only a due read resolves a context (which runs the credential chain).
   */
  async chasePulls(request: { projectId: string }): Promise<boolean> {
    const key = this.projectKeys.get(request.projectId)
    if (!key || !this.pulls.claimChase(key)) return false
    let captured: GitHubIssueServiceContext
    try {
      captured = await this.options.contextForProject(request.projectId)
    } catch {
      return false
    }
    if (repositoryKey(captured) !== key || !captured.client.pullRequestStatuses) return false
    await this.pulls.read(key, captured.userId, 'chase', () =>
      this.readWithEpoch(captured, () => captured.client.pullRequestStatuses!(captured.repository)))
    return true
  }

  /**
   * The one-time permission for the board to move `cardId` because every PR in `pulls` merged. The
   * first ask wins across every window (two Server Edition tabs cannot both move it), and it is
   * remembered per PR, so a card the user dragged back is not moved again for the same merges — even
   * after one of them ages off the pull board. It sends no request and resolves no credential.
   */
  async claimPullAutoMove(request: { projectId: string; cardId: string; pulls: number[] }): Promise<boolean> {
    const key = this.validPullCardRequest(request)
    if (!key) return false
    const { projectId, cardId, pulls } = request
    return this.pulls.claimMove(key, projectId, cardId, pulls)
  }

  /**
   * A visible, armed board reports "this card is waiting on these still-open PRs". The host keeps a
   * note only for PRs it holds as open itself; `claimPullAutoMove` later requires one. Sends no
   * request and resolves no credential.
   */
  async notePullWaits(request: { projectId: string; cardId: string; pulls: number[] }): Promise<number> {
    const key = this.validPullCardRequest(request)
    if (!key) return 0
    return this.pulls.noteWaits(key, request.projectId, request.cardId, request.pulls)
  }

  /** The repository key for a well-formed card request on a bound project that is not being cleared. */
  private validPullCardRequest(
    request: { projectId: string; cardId: string; pulls: number[] } | null | undefined
  ): string | null {
    const { projectId, cardId, pulls } = request ?? {}
    if (typeof projectId !== 'string' || typeof cardId !== 'string' || !cardId || cardId.length > 256 ||
        /[\u0000-\u001f]/.test(cardId) || !Array.isArray(pulls) || pulls.length === 0 || pulls.length > 100 ||
        pulls.some((pull) => !Number.isSafeInteger(pull) || pull < 1)) return null
    const key = this.projectKeys.get(projectId)
    if (!key || key.startsWith('unbound:')) return null
    if (this.repositoryControl(key.slice(key.indexOf('\0') + 1)).deletion) return null
    return key
  }

  /** Per-check detail for one PR, read when its modal opens. Never throws: every failure is one of
   *  the result's own statuses, so a modal can always say what it knows. */
  async pullChecks(request: { projectId: string; pullNumber: number }): Promise<GitHubPullChecksResult> {
    if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber < 1) {
      return { status: 'unavailable' }
    }
    const now = this.now()
    const key = `${request.projectId}\0${request.pullNumber}`
    const recent = this.checkReads.get(key)
    if (recent && now - recent.at < PULL_CHECKS_REUSE_MS) return recent.result
    const starts = (this.checkStarts.get(request.projectId) ?? []).filter((at) => now - at < 60_000)
    if (starts.length >= PULL_CHECKS_PER_MINUTE) {
      this.checkStarts.set(request.projectId, starts)
      return { status: 'unavailable' }
    }
    this.checkStarts.set(request.projectId, [...starts, now])
    for (const [candidate, entry] of this.checkReads) {
      if (now - entry.at >= PULL_CHECKS_REUSE_MS) this.checkReads.delete(candidate)
    }
    const result = this.readPullChecks(request)
    this.checkReads.set(key, { at: now, result })
    return result
  }

  private async readPullChecks(request: { projectId: string; pullNumber: number }): Promise<GitHubPullChecksResult> {
    let captured: GitHubIssueServiceContext
    try {
      captured = await this.options.contextForProject(request.projectId)
    } catch {
      return { status: 'unavailable' }
    }
    if (!captured.client.pullRequestChecks) return { status: 'unavailable' }
    // A token already known to be unable to read checks is not asked again.
    if (!this.pulls.board(repositoryKey(captured)).access.ci) return { status: 'hidden' }
    const throttle = this.options.coordinator.throttle(captured.userId, this.now(), 'graphql')
    if (throttle?.kind === 'rate-limited') return { status: 'unavailable' }
    try {
      return await this.readWithEpoch(captured, () =>
        captured.client.pullRequestChecks!(captured.repository, request.pullNumber))
    } catch (error) {
      // A 403 that is not a rate limit: this token may not read the checks. Say nothing about them.
      return (error as { code?: unknown } | null)?.code === 'insufficient-permission'
        ? { status: 'hidden' }
        : { status: 'unavailable' }
    }
  }

  /** One PR's overview for the pull request node (`pullRead` holds the refusal, floor and stale rules).
   *  `background` (the Watch poller) is held by the rate budget below the floor, like the board poll
   *  (`refreshWithinFloor`): it asks `core` (the REST read) and `graphql` (the sidebar, and the
   *  checks Watch reads next) before anything is sent. A user-opened read never sets it. */
  async pullDetail(request: { projectId: string; repository: string; pullNumber: number; background?: boolean }): Promise<GitHubPullDetailResult> {
    if (request?.background === true) {
      let userId: string
      try {
        userId = (await this.options.contextForProject(request.projectId)).userId
      } catch (error) {
        return this.pullContextFailure(error)
      }
      const throttle = this.options.coordinator.throttle(userId) ??
        this.options.coordinator.throttle(userId, this.now(), 'graphql')
      if (throttle) return { status: 'failed', reason: 'throttled', retryAt: throttle.until }
    }
    return this.pullRead('detail', request, async (captured, repository, pullNumber) => {
      if (!captured.client.getPull) return null
      const [read, sidebar] = await Promise.all([
        this.readWithEpoch(captured, () => captured.client.getPull!(repository, pullNumber)),
        this.pullSidebar(captured, repository, pullNumber)
      ])
      const detail = sidebar ? { ...read, sidebar } : read
      // The numeric id, not the login: a login can be renamed.
      const ownPull = detail.author !== null && String(detail.author.id) === captured.userId
      const avatarDataUrls = await this.pullAvatars([
        detail.author, detail.mergedBy ?? null, ...(detail.requestedReviewers ?? []), ...(sidebar?.reviewers ?? []).map((reviewer) => reviewer.user),
        ...(sidebar?.assignees ?? []), ...(sidebar?.participants ?? [])
      ])
      return {
        status: 'ok', detail, observedAt: this.now(), ...(ownPull ? { ownPull: true as const } : {}),
        ...(avatarDataUrls ? { avatarDataUrls } : {})
      }
    })
  }

  /**
   * One PR's issue comments and submitted reviews, merged into one list oldest first, for the
   * Conversation tab. Same refusals, floor and stale rules as `pullDetail`. Each page is its own
   * coordinated read; at most `MAX_CONVERSATION_PAGES` per list, past which `truncated` is set.
   */
  async pullConversation(
    request: { projectId: string; repository: string; pullNumber: number }
  ): Promise<GitHubPullConversationResult> {
    return this.pullRead('conversation', request, async (captured, repository, pullNumber) => {
      const { client } = captured
      if (!client.listPullComments || !client.listPullReviews) return null
      const pages = async <T>(list: (page: number) => Promise<{ items: T[]; nextPage?: number }>) => {
        const items: T[] = []
        let page = 1
        for (let read = 0; read < MAX_CONVERSATION_PAGES; read += 1) {
          const result = await this.readWithEpoch(captured, () => list(page))
          items.push(...result.items)
          if (!result.nextPage) return { items, truncated: false }
          page = result.nextPage
        }
        return { items, truncated: true }
      }
      const listLines = client.listPullLineComments?.bind(client)
      const readResolved = client.pullResolvedThreads?.bind(client)
      const [comments, reviews, lines, resolvedThreads] = await Promise.all([
        pages<PullConversationItem>((page) => client.listPullComments!(repository, pullNumber, page)),
        pages<PullConversationItem>((page) => client.listPullReviews!(repository, pullNumber, page)),
        // ponytail: a client without line comments answers none; the real client always has them.
        listLines
          ? pages<PullLineComment>((page) => listLines(repository, pullNumber, page)
            .then(({ comments: items, nextPage }) => ({ items, nextPage })))
          : { items: [], truncated: false },
        // Only "Send to agent" uses it: a failed read leaves it unknown, never fails the tab.
        readResolved
          ? this.readWithEpoch(captured, () => readResolved(repository, pullNumber)).catch(() => undefined)
          : undefined
      ])
      const items = [...comments.items, ...reviews.items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      const avatarDataUrls = await this.pullAvatars([...items, ...lines.items].map((item) => item.author))
      return {
        status: 'ok', items, lineComments: lines.items, truncated: comments.truncated || reviews.truncated || lines.truncated,
        ...(resolvedThreads ? { resolvedThreads } : {}),
        ...(avatarDataUrls ? { avatarDataUrls } : {}),
        observedAt: this.now()
      }
    })
  }

  /**
   * One page of a PR's Conversation timeline, oldest first; `after` = the page's cursor (absent = the
   * first page). Each page is held apart under the same refusals, floor and stale rules as `pullDetail`.
   */
  async pullTimeline(
    request: { projectId: string; repository: string; pullNumber: number; after?: string }
  ): Promise<GitHubPullTimelineResult> {
    const after = request?.after
    if (after !== undefined && !isPullTimelineCursor(after)) return { status: 'refused', reason: 'not-configured' }
    return this.pullRead(after ? `timeline\0${after}` : 'timeline', request, async (captured, repository, pullNumber) => {
      const { client } = captured
      if (!client.pullTimeline) return null
      const page = await this.readWithEpoch(captured, () => client.pullTimeline!(repository, pullNumber, after))
      const avatarDataUrls = await this.pullAvatars([page.author ?? null, ...page.items.flatMap((item) =>
        item.kind === 'assigned' || item.kind === 'unassigned' ? [item.actor, item.assignee] : [item.actor])])
      return { status: 'ok', ...page, observedAt: this.now(), ...(avatarDataUrls ? { avatarDataUrls } : {}) }
    })
  }

  /**
   * One PR's changed files for the Files tab, 100 per page, at most `MAX_PULL_FILES`, past which
   * `truncated` is set. Same refusals, floor and stale rules as `pullDetail`.
   */
  async pullFiles(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullFilesResult> {
    return this.pullRead('files', request, async (captured, repository, pullNumber) => {
      const { client } = captured
      if (!client.listPullFiles) return null
      const files: PullFile[] = []
      let page: number | undefined = 1
      while (page && files.length < MAX_PULL_FILES) {
        const next: number = page
        const result = await this.readWithEpoch(captured, () => client.listPullFiles!(repository, pullNumber, next))
        files.push(...result.files)
        // An empty page ends the list even if it names a next one, or a bad answer loops forever.
        page = result.files.length ? result.nextPage : undefined
      }
      // Only the Viewed boxes use it: a failed read leaves them unknown, never fails the tab.
      const readViewed = client.pullViewedStates?.bind(client)
      const viewed = readViewed
        ? await this.readWithEpoch(captured, () => readViewed(repository, pullNumber)).catch(() => undefined)
        : undefined
      const listed = files.slice(0, MAX_PULL_FILES).map((file) => {
        const state = viewed && Object.hasOwn(viewed, file.path) ? viewed[file.path] : undefined
        return state ? { ...file, viewerViewedState: state } : file
      })
      return {
        status: 'ok', files: listed, truncated: !!page || files.length > MAX_PULL_FILES,
        observedAt: this.now()
      }
    })
  }

  /**
   * The base and head versions of one changed file: head at the latest `pullDetail` head, base at
   * the merge base of that base and head (what GitHub's diff is against). A rename's base is read
   * from its previous path; the missing side of an added or removed file is `empty` (no read). A
   * binary file or one over 1 MB answers `unavailable`. The SHAs are part of the key, so a moved
   * head reads again; the floor and stale rules are `pullRead`'s.
   */
  async pullFileContents(
    request: { projectId: string; repository: string; pullNumber: number; path: string }
  ): Promise<GitHubPullFileContentsResult> {
    if (typeof request?.path !== 'string') return { status: 'refused', reason: 'not-configured' }
    const detail = await this.pullDetail(request)
    if (detail.status !== 'ok') return detail
    const listed = await this.pullFiles(request)
    if (listed.status !== 'ok') return listed
    const file = listed.files.find((item) => item.path === request.path)
    const { base, head } = detail.detail
    const mergeBase = await this.pullMergeBase(request, base.sha, head.sha)
    if (mergeBase.status !== 'ok') return mergeBase
    return this.pullRead(`contents\0${base.sha}\0${head.sha}\0${request.path}`, request, async (captured, repository) => {
      const { client } = captured
      if (!client.getFileAt) return null
      if (!file) return { status: 'ok', contents: { kind: 'unavailable', reason: 'not-in-pull' }, observedAt: this.now() }
      return this.pullFileDiff(captured, repository, file, mergeBase.sha, head.sha)
    })
  }

  /**
   * One PR's commits, oldest first, for the Commits tab: GraphQL pages of 100 by cursor, at most
   * `MAX_COMMIT_PAGES`, past which `truncated` is set. Same refusals, floor and stale rules as `pullDetail`.
   */
  async pullCommits(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullCommitsResult> {
    return this.pullRead('commits', request, async (captured, repository, pullNumber) => {
      const { client } = captured
      if (!client.listPullCommits) return null
      const commits: PullCommit[] = []
      let after: string | undefined
      for (let read = 0; read < MAX_COMMIT_PAGES; read += 1) {
        const cursor = after
        const page = await this.readWithEpoch(captured, () => client.listPullCommits!(repository, pullNumber, cursor))
        commits.push(...page.commits)
        after = page.after
        if (!after) break
      }
      const avatarDataUrls = await this.pullAvatars(commits.map((commit) => commit.author))
      return {
        status: 'ok', commits, truncated: !!after, observedAt: this.now(), ...(avatarDataUrls ? { avatarDataUrls } : {})
      }
    })
  }

  /** The files one commit changed and its first parent, for that commit's own diff. Pages and cap
   *  as `pullFiles`; rules as `pullDetail`. A SHA that is not a full commit SHA, or not one of this
   *  PR's commits (the held `pullCommits` read), is refused with no commit request. */
  async pullCommitFiles(
    request: { projectId: string; repository: string; pullNumber: number; sha: string }
  ): Promise<GitHubPullCommitFilesResult> {
    if (!isCommitSha(request?.sha)) return { status: 'refused', reason: 'not-configured' }
    const { sha } = request
    const commits = await this.pullCommits(request)
    if (commits.status !== 'ok') return commits
    // ponytail: a commit past the `MAX_COMMIT_PAGES` cap is refused too; the Commits tab never lists it.
    if (!commits.commits.some((commit) => commit.oid === sha)) return { status: 'refused', reason: 'not-configured' }
    return this.pullRead(`commit-files\0${sha}`, request, async (captured, repository) => {
      const { client } = captured
      if (!client.getCommitFiles) return null
      const files: PullFile[] = []
      let parent: string | undefined
      let page: number | undefined = 1
      while (page && files.length < MAX_PULL_FILES) {
        const next: number = page
        const result = await this.readWithEpoch(captured, () => client.getCommitFiles!(repository, sha, next))
        files.push(...result.files)
        parent ??= result.parent
        page = result.nextPage
      }
      return {
        status: 'ok', files: files.slice(0, MAX_PULL_FILES), truncated: !!page || files.length > MAX_PULL_FILES,
        ...(parent ? { parent } : {}), observedAt: this.now()
      }
    })
  }

  /**
   * One file of one commit as a diff: its first parent against the commit, the Files tab's path and
   * answer (`pullFileContents`). A root commit's base side is `empty`; a path the commit did not
   * change answers `unavailable: not-in-pull`.
   */
  async pullCommitFileContents(
    request: { projectId: string; repository: string; pullNumber: number; sha: string; path: string }
  ): Promise<GitHubPullFileContentsResult> {
    if (typeof request?.path !== 'string') return { status: 'refused', reason: 'not-configured' }
    const listed = await this.pullCommitFiles(request)
    if (listed.status !== 'ok') return listed
    const { sha, path } = request
    const file = listed.files.find((item) => item.path === path)
    return this.pullRead(`commit-contents\0${sha}\0${path}`, request, async (captured, repository) => {
      const { client } = captured
      if (!client.getFileAt) return null
      if (!file) return { status: 'ok', contents: { kind: 'unavailable', reason: 'not-in-pull' }, observedAt: this.now() }
      return this.pullFileDiff(captured, repository, file, listed.parent, sha)
    })
  }

  /**
   * "Since my last review" (F-10): the viewer's latest submitted review, compared to the head of
   * the latest `pullDetail` (three-dot compare). The head is part of the key, so a push reads again.
   * A force-push answers `unavailable` (the reviewed commit is gone, or the head no longer contains
   * it), never a failure. Same refusals, floor and stale rules as `pullDetail`.
   */
  async pullSinceReview(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullSinceReviewResult> {
    const detail = await this.pullDetail(request)
    if (detail.status !== 'ok') return detail
    const head = detail.detail.head.sha
    return this.pullRead(`since-review\0${head}`, request, async (captured, repository, pullNumber) => {
      const { client } = captured
      if (!client.viewerLatestReview || !client.compareCommits) return null
      const review = await this.readWithEpoch(captured, () => client.viewerLatestReview!(repository, pullNumber))
      const ok = (since: Extract<GitHubPullSinceReviewResult, { status: 'ok' }>['since']) =>
        ({ status: 'ok' as const, since, observedAt: this.now() })
      if (!review) return ok({ kind: 'none' })
      if (review.commitOid === head) return ok({ kind: 'current', ...review })
      const compared = await this.readWithEpoch(captured, () => client.compareCommits!(repository, review.commitOid, head))
      if (!compared) return ok({ kind: 'unavailable', reason: 'commit-gone', ...review })
      if (compared.status === 'identical') return ok({ kind: 'current', ...review })
      if (compared.status !== 'ahead') return ok({ kind: 'unavailable', reason: 'history-rewritten', ...review })
      return ok({
        kind: 'moved', ...review, head, commits: compared.aheadBy, files: compared.files,
        truncated: compared.files.length >= MAX_COMPARE_FILES
      })
    })
  }

  /** One file of `pullSinceReview` as a diff: the reviewed commit against the head. With nothing to
   *  compare, or a path the comparison does not list, it answers `unavailable: not-in-pull`. */
  async pullSinceReviewFileContents(
    request: { projectId: string; repository: string; pullNumber: number; path: string }
  ): Promise<GitHubPullFileContentsResult> {
    if (typeof request?.path !== 'string') return { status: 'refused', reason: 'not-configured' }
    const since = await this.pullSinceReview(request)
    if (since.status !== 'ok') return since
    const { path } = request
    const notInPull = { status: 'ok' as const, contents: { kind: 'unavailable' as const, reason: 'not-in-pull' as const }, observedAt: this.now() }
    if (since.since.kind !== 'moved') return notInPull
    const { commitOid, head, files } = since.since
    const file = files.find((item) => item.path === path)
    if (!file) return notInPull
    return this.pullRead(`since-review-contents\0${commitOid}\0${head}\0${path}`, request, async (captured, repository) => {
      const { client } = captured
      if (!client.getFileAt) return null
      return this.pullFileDiff(captured, repository, file, commitOid, head)
    })
  }

  /**
   * Both sides of one changed file: the base at `baseRef`, the head at `headRef`. An added file,
   * or no `baseRef` (a root commit), reads an empty base; a removed file reads an empty head.
   * The caller has checked `client.getFileAt`.
   */
  private async pullFileDiff(
    captured: GitHubIssueServiceContext, repository: string,
    file: Pick<PullFile, 'path' | 'previousPath' | 'status'>, baseRef: string | undefined, headRef: string
  ): Promise<PullOk & { contents: PullFileContents }> {
    const side = async (at: string, ref: string): Promise<PullFileRead> =>
      this.readWithEpoch(captured, () => captured.client.getFileAt!(repository, at, ref))
    const [before, after] = await Promise.all([
      file.status === 'added' || !baseRef ? { kind: 'empty' as const } : side(file.previousPath ?? file.path, baseRef),
      file.status === 'removed' ? { kind: 'empty' as const } : side(file.path, headRef)
    ])
    const unavailable = [before, after].find((item) => item.kind === 'unavailable')
    return {
      status: 'ok',
      contents: unavailable?.kind === 'unavailable'
        ? { kind: 'unavailable', reason: unavailable.reason }
        : { kind: 'diff', base: before as PullFileSide, head: after as PullFileSide },
      observedAt: this.now()
    }
  }

  /** The merge base of `base` and `head`, read once per pair through `pullRead`. */
  private async pullMergeBase(
    request: { projectId: string; repository: string; pullNumber: number }, base: string, head: string
  ): Promise<PullResult<PullOk & { sha: string }>> {
    const key = `${base}\0${head}`
    return this.pullRead(`merge-base\0${key}`, request, async (captured, repository) => {
      const { client } = captured
      let sha = this.mergeBases.get(key)
      if (!sha) {
        if (!client.mergeBase) return null
        sha = await this.readWithEpoch(captured, () => client.mergeBase!(repository, base, head))
        this.mergeBases.set(key, sha)
        if (this.mergeBases.size > MAX_PULL_READS) this.mergeBases.delete(this.mergeBases.keys().next().value!)
      }
      return { status: 'ok', sha, observedAt: this.now() }
    })
  }

  /** Post a comment on a PR from its node: the issue-comment call (a PR is an issue to GitHub). */
  async commentOnPull(
    request: { projectId: string; repository: string; pullNumber: number; body: string }
  ): Promise<PullWriteResult> {
    if (typeof request?.body !== 'string' || !request.body.trim()) return { ok: false, reason: 'validation' }
    return this.pullWrite(request, (client, repository, pullNumber) =>
      client.createIssueComment(repository, pullNumber, request.body))
  }

  /**
   * One issue's comments, oldest first, for the issues node's detail. The PR conversation's read
   * without reviews or line comments (an issue has neither): same refusals, floor and stale rules.
   */
  async issueConversation(
    request: { projectId: string; repository: string; issueNumber: number }
  ): Promise<GitHubIssueConversationResult> {
    return this.pullRead('issue-conversation', { ...request, pullNumber: request?.issueNumber }, async (captured, repository, issueNumber) => {
      const { client } = captured
      if (!client.listPullComments) return null
      const items: PullConversationItem[] = []
      let page = 1
      for (let read = 0; read < MAX_CONVERSATION_PAGES; read += 1) {
        // `/issues/{n}/comments`: the same list for an issue as for a PR.
        const result = await this.readWithEpoch(captured, () => client.listPullComments!(repository, issueNumber, page))
        items.push(...result.items)
        if (!result.nextPage) return { status: 'ok', items, truncated: false, observedAt: this.now() }
        page = result.nextPage
      }
      return { status: 'ok', items, truncated: true, observedAt: this.now() }
    })
  }

  /**
   * One page of an issue's timeline for the issues node, oldest first; `after` = the page's cursor.
   * The pull timeline's read for an issue: same refusals, floor and stale rules, one entry per page.
   */
  async issueTimeline(
    request: { projectId: string; repository: string; issueNumber: number; after?: string }
  ): Promise<GitHubPullTimelineResult> {
    const after = request?.after
    if (after !== undefined && !isPullTimelineCursor(after)) return { status: 'refused', reason: 'not-configured' }
    const kind = after ? `issue-timeline\0${after}` as const : 'issue-timeline'
    return this.pullRead(kind, { ...request, pullNumber: request?.issueNumber }, async (captured, repository, issueNumber) => {
      const { client } = captured
      if (!client.issueTimeline) return null
      const page = await this.readWithEpoch(captured, () => client.issueTimeline!(repository, issueNumber, after))
      const avatarDataUrls = await this.pullAvatars(page.items.flatMap((item) =>
        item.kind === 'assigned' || item.kind === 'unassigned' ? [item.actor, item.assignee] : [item.actor]))
      return { status: 'ok', ...page, observedAt: this.now(), ...(avatarDataUrls ? { avatarDataUrls } : {}) }
    })
  }

  /** Post a comment on an issue from the issues node. A user click only; never an agent verb. */
  async commentOnIssue(
    request: { projectId: string; repository: string; issueNumber: number; body: string }
  ): Promise<PullWriteResult> {
    if (!isPullCommentBody(request?.body)) return { ok: false, reason: 'validation' }
    return this.pullWrite({ ...request, pullNumber: request.issueNumber }, (client, repository, issueNumber) =>
      client.createIssueComment(repository, issueNumber, request.body))
  }

  /** Post one line comment from the Files tab: a new thread tied to `headSha` (the head the node
   *  read), or a reply to `inReplyTo`. A user click only; never an agent verb. */
  async commentOnPullLine(request: PullLineCommentRequest): Promise<PullWriteResult> {
    let comment: PullLineCommentWrite
    if (request && 'inReplyTo' in request) {
      if (!Number.isSafeInteger(request.inReplyTo) || request.inReplyTo < 1 || !isPullCommentBody(request.body)) {
        return { ok: false, reason: 'validation' }
      }
      comment = { inReplyTo: request.inReplyTo, body: request.body }
    } else {
      if (typeof request?.headSha !== 'string' || !request.headSha || !isPullLineDraft(request.comment)) {
        return { ok: false, reason: 'validation' }
      }
      const { path, line, side, body } = request.comment
      comment = { commitId: request.headSha, draft: { path, line, side, body } }
    }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot comment on a line reads as network; the real client always can.
      if (!client.createPullLineComment) throw new Error('unsupported')
      return client.createPullLineComment(repository, pullNumber, comment)
    })
  }

  /**
   * Submit a review from the node, tied to `headSha` (the head the node last read), so GitHub
   * refuses it if that commit is no longer the PR's. REQUEST_CHANGES needs a message; COMMENT needs
   * a message or a line comment. `comments` = the pending line comments, sent in the same review.
   */
  async reviewPull(request: {
    projectId: string; repository: string; pullNumber: number; event: PullReviewEvent; body: string; headSha: string
    comments?: PullLineDraft[]
  }): Promise<PullWriteResult> {
    const { event, body, headSha, comments = [] } = request ?? {}
    if (typeof body !== 'string' || typeof headSha !== 'string' || !headSha ||
        (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') ||
        !Array.isArray(comments) || comments.length > MAX_PULL_REVIEW_COMMENTS || !comments.every(isPullLineDraft) ||
        (event === 'REQUEST_CHANGES' && !body.trim()) ||
        (event === 'COMMENT' && !body.trim() && !comments.length)) return { ok: false, reason: 'validation' }
    const drafts = comments.map(({ path, line, side, body: text }) => ({ path, line, side, body: text }))
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot review reads as network; the real client always can.
      if (!client.reviewPull) throw new Error('unsupported')
      return client.reviewPull(repository, pullNumber, { event, body, commitId: headSha, ...(drafts.length ? { comments: drafts } : {}) })
    })
  }

  /**
   * Merge from the node's confirmation, tied to `headSha` (the head the Overview showed), so GitHub
   * refuses it with 409 (`head-moved`) if the PR moved since.
   */
  async mergePull(request: {
    projectId: string; repository: string; pullNumber: number; method: PullMergeMethod; headSha: string
  }): Promise<PullWriteResult> {
    const { method, headSha } = request ?? {}
    if (typeof headSha !== 'string' || !headSha || (method !== 'merge' && method !== 'squash' && method !== 'rebase')) {
      return { ok: false, reason: 'validation' }
    }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot merge reads as network; the real client always can.
      if (!client.mergePull) throw new Error('unsupported')
      return client.mergePull(repository, pullNumber, { method, sha: headSha })
    })
  }

  /** "Update branch" from the node (a user click only): GitHub merges the base into the head, and
   *  refuses (422, reported as head-moved) if the head is no longer `headSha`, the commit the
   *  Overview showed. */
  async updatePullBranch(
    request: { projectId: string; repository: string; pullNumber: number; headSha: string }
  ): Promise<PullWriteResult> {
    const headSha = request?.headSha
    if (typeof headSha !== 'string' || !headSha) return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot update reads as network; the real client always can.
      if (!client.updatePullBranch) throw new Error('unsupported')
      return headMovedOn422(client.updatePullBranch(repository, pullNumber, headSha))
    })
  }

  /** "Merge when ready" from the node's confirmation (a user click only): GitHub's auto-merge with
   *  `method`, tied to `headSha` (the head the Overview showed), so GitHub refuses it if the PR moved. */
  async enablePullAutoMerge(request: {
    projectId: string; repository: string; pullNumber: number; method: PullMergeMethod; headSha: string
  }): Promise<PullWriteResult> {
    const { method, headSha } = request ?? {}
    if (typeof headSha !== 'string' || !headSha || (method !== 'merge' && method !== 'squash' && method !== 'rebase')) {
      return { ok: false, reason: 'validation' }
    }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot arm auto-merge reads as network; the real client always can.
      if (!client.enablePullAutoMerge) throw new Error('unsupported')
      return headMovedOn422(client.enablePullAutoMerge(repository, pullNumber, { method, sha: headSha }))
    })
  }

  /** Cancel "Merge when ready" from the node (a user click only). */
  async disablePullAutoMerge(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult> {
    if (!request) return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.disablePullAutoMerge) throw new Error('unsupported')
      return client.disablePullAutoMerge(repository, pullNumber)
    })
  }

  /** Tick or clear GitHub's own "Viewed" mark on one changed file (a user click only). */
  async setFileViewed(request: {
    projectId: string; repository: string; pullNumber: number; path: string; viewed: boolean
  }): Promise<PullWriteResult> {
    const { path, viewed } = request ?? {}
    if (!isPullPath(path) || typeof viewed !== 'boolean') return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.setFileViewed) throw new Error('unsupported')
      return client.setFileViewed(repository, pullNumber, path, viewed)
    })
  }

  /** Resolve or unresolve one review thread, named by its first comment's id (a user click only). */
  async setReviewThreadResolved(request: {
    projectId: string; repository: string; pullNumber: number; threadId: number; resolved: boolean
  }): Promise<PullWriteResult> {
    const { threadId, resolved } = request ?? {}
    if (!Number.isSafeInteger(threadId) || threadId < 1 || typeof resolved !== 'boolean') return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.setReviewThreadResolved) throw new Error('unsupported')
      return client.setReviewThreadResolved(repository, pullNumber, threadId, resolved)
    })
  }

  /**
   * "Apply suggestion" (a user click only): commit one comment's suggestion block to the head branch
   * through the contents API, pinned to the file's blob SHA at `headSha` (the head the user saw), so
   * GitHub refuses it (409, `suggestion-stale`) if the file changed since. A fork head is refused
   * (`from-fork`) before the comment is read.
   */
  async applySuggestion(request: {
    projectId: string; repository: string; pullNumber: number; headSha: string; commentId: number
  }): Promise<PullWriteResult> {
    const { headSha, commentId } = request ?? {}
    if (!isCommitSha(headSha) || !Number.isSafeInteger(commentId) || commentId < 1) {
      return { ok: false, reason: 'validation' }
    }
    const refuse = (code: string) => Object.assign(new Error(code), code === 'validation' ? { code: 'request-failed', status: 422 } : { code })
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.getPull || !client.pullSuggestionComment || !client.fileBlobAt || !client.putFile) throw new Error('unsupported')
      const pull = await client.getPull(repository, pullNumber)
      if (pull.fromFork) throw refuse('from-fork')
      const comment = await client.pullSuggestionComment(repository, commentId)
      const lines = suggestionOf(comment.body)
      if (comment.pullNumber !== pullNumber || comment.side !== 'RIGHT' || comment.line === null || !lines) throw refuse('validation')
      // The comment's line numbers are for its commit; on any other head they may point elsewhere.
      if (comment.commitId !== headSha) throw refuse('suggestion-stale')
      // A range that starts on the base side counts its first line in the old file, not this one.
      if (comment.startLine !== null && comment.startSide !== 'RIGHT') throw refuse('suggestion-stale')
      const file = await client.fileBlobAt(repository, comment.path, headSha)
      const text = withSuggestion(file.text, comment.startLine ?? comment.line, comment.line, lines)
      if (text === null) throw refuse('suggestion-stale')
      const message = comment.author ? `Apply suggestion from review by ${comment.author}` : 'Apply suggestion from review'
      try {
        await client.putFile(repository, { path: comment.path, branch: pull.head.ref, sha: file.sha, text, message })
      } catch (error) {
        const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown }
        if (code === 'request-failed' && status === 409) throw refuse('suggestion-stale')
        throw error
      }
    })
  }

  /**
   * The merge methods the project's repository allows, for the merge confirmation. Refused like a
   * pull read (another repository is refused before a credential is resolved). Held per repository.
   */
  async repoMergeMethods(request: { projectId: string; repository: string }): Promise<GitHubRepoMergeMethodsResult> {
    const result = await this.heldRepoRead(this.mergeMethods, request, (client) => client.repoMergeMethods?.bind(client))
    return result.status === 'ok'
      ? { status: 'ok', methods: result.value.methods, ...(result.value.autoMerge ? { autoMerge: true as const } : {}) }
      : result
  }

  /** The repository's collaborators, for the node's "Request review". Held per repository like the
   *  merge methods (ponytail: a new collaborator shows after an app restart). */
  async repoCollaborators(request: { projectId: string; repository: string }): Promise<GitHubRepoCollaboratorsResult> {
    const result = await this.heldRepoRead(this.collaborators, request, (client) => client.listCollaborators?.bind(client))
    return result.status === 'ok' ? { status: 'ok', users: result.value } : result
  }

  /** One read per (user, repository), held for the app run. `read` answers undefined when this
   *  client cannot make it at all. Never throws. */
  private async heldRepoRead<T>(
    held: Map<string, T> | null,
    request: { projectId: string; repository: string },
    read: (client: GitHubIssuesClientLike) => ((repository: string) => Promise<T>) | undefined
  ): Promise<{ status: 'ok'; value: T } | { status: 'refused'; reason: PullRefusal } | { status: 'failed'; reason: PullReadFailure; retryAt?: number }> {
    const repository = parseGitHubRepository(request?.repository)
    if (typeof request?.projectId !== 'string' || !repository) return { status: 'refused', reason: 'not-configured' }
    let captured: GitHubIssueServiceContext
    try {
      if ((await this.cacheContext(request.projectId)).repository.toLowerCase() !== repository.toLowerCase()) {
        return { status: 'refused', reason: 'repository-mismatch' }
      }
      captured = await this.options.contextForProject(request.projectId)
    } catch (error) {
      const refusal = pullRefusalOf(error)
      return refusal ? { status: 'refused', reason: refusal } : { status: 'failed', ...pullReadFailure(error) }
    }
    // The project's repository may have changed between the two awaits, as in readPull.
    if (captured.repository.toLowerCase() !== repository.toLowerCase()) return { status: 'refused', reason: 'repository-mismatch' }
    const key = `${captured.userId}\0${captured.repository.toLowerCase()}`
    const hit = held?.get(key)
    if (hit !== undefined) return { status: 'ok', value: hit }
    const readRepo = read(captured.client)
    if (!readRepo) return { status: 'failed', reason: 'unreachable' }
    try {
      const value = await this.readWithEpoch(captured, () => readRepo(captured.repository))
      held?.set(key, value)
      return { status: 'ok', value }
    } catch (error) {
      return { status: 'failed', ...pullReadFailure(error) }
    }
  }

  /** "New pull request"'s start for a branch: the default branch and the branch's open PR. Refused
   *  like a pull read; never held (a PR for the branch may have opened a moment ago). */
  async pullForBranch(
    request: { projectId: string; repository: string; head: string }
  ): Promise<GitHubPullForBranchResult> {
    if (!isPullBranchName(request?.head)) return { status: 'refused', reason: 'not-configured' }
    const result = await this.heldRepoRead(null, request, (client) =>
      client.pullForBranch ? (repository: string) => client.pullForBranch!(repository, request.head) : undefined)
    return result.status === 'ok' ? { status: 'ok', ...result.value } : result
  }

  /** Open a pull request from a branch, from the "New pull request" form (a user click only). */
  async createPull(request: { projectId: string; repository: string } & PullCreateDraft): Promise<PullCreateResult> {
    if (!isPullCreateDraft(request)) return { ok: false, reason: 'validation' }
    const { head, base, title, body, draft } = request
    const result = await this.repoWrite(request, async (client, repository) => {
      // ponytail: a client that cannot create reads as network; the real client always can.
      if (!client.createPull) throw new Error('unsupported')
      return client.createPull(repository, { head, base, title, body, draft })
    })
    if (!result.ok) return { ok: false, reason: result.reason }
    this.afterWrite(request.projectId)
    return { ok: true, pullNumber: result.value.number }
  }

  /** Ask one collaborator to review the PR, from the node's "Request review" (a user click only). */
  async requestPullReviewer(
    request: { projectId: string; repository: string; pullNumber: number; reviewer: string }
  ): Promise<PullWriteResult> {
    if (typeof request?.reviewer !== 'string' || !GITHUB_LOGIN.test(request.reviewer)) return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot request reads as network; the real client always can.
      if (!client.requestPullReviewer) throw new Error('unsupported')
      return client.requestPullReviewer(repository, pullNumber, request.reviewer)
    })
  }

  /** Add or remove one existing repository label on the PR, from the sidebar (a user click only). */
  async setPullLabels(
    request: { projectId: string; repository: string; pullNumber: number; label: string; add: boolean }
  ): Promise<PullWriteResult> {
    const { label, add } = request ?? {}
    if (typeof label !== 'string' || !label.trim() || label.length > 50 || typeof add !== 'boolean') return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot edit labels reads as network; the real client always can.
      if (!client.setPullLabel) throw new Error('unsupported')
      return client.setPullLabel(repository, pullNumber, label, add)
    })
  }

  /** Add or remove one assignee on the PR, from the sidebar (a user click only). */
  async setPullAssignees(
    request: { projectId: string; repository: string; pullNumber: number; login: string; add: boolean }
  ): Promise<PullWriteResult> {
    const { login, add } = request ?? {}
    if (typeof login !== 'string' || !GITHUB_LOGIN.test(login) || typeof add !== 'boolean') return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.setPullAssignee) throw new Error('unsupported')
      return client.setPullAssignee(repository, pullNumber, login, add)
    })
  }

  /** Close (`open` false) or reopen the PR, from the merge box (a user click only). */
  async setPullState(request: { projectId: string; repository: string; pullNumber: number; open: boolean }): Promise<PullWriteResult> {
    const { open } = request ?? {}
    if (typeof open !== 'boolean') return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: a client that cannot do it reads as network; the real client always can.
      if (!client.setPullState) throw new Error('unsupported')
      return client.setPullState(repository, pullNumber, open)
    })
  }

  /** Mark a draft PR ready for review, from the merge box (a user click only). */
  async markPullReady(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult> {
    return this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.markPullReady) throw new Error('unsupported')
      return client.markPullReady(repository, pullNumber)
    })
  }

  /**
   * "Delete branch" after a merge (a user click only). The PR is read again here, never taken from the
   * renderer: only a merged PR whose head lives in this repository and is not its default branch.
   * GitHub's 422 on the delete (a protected branch, or one already deleted) answers `branch-protected`.
   */
  async deleteHeadBranch(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult> {
    // ponytail: pullWriteFailure has no branch-protected code, so the 422 is flagged here and read after.
    let refusedDelete = false
    const result = await this.pullWrite(request, async (client, repository, pullNumber) => {
      // ponytail: as above.
      if (!client.getPull || !client.pullForBranch || !client.deleteBranchRef) throw new Error('unsupported')
      const pull = await client.getPull(repository, pullNumber)
      if (pull.fromFork) throw Object.assign(new Error('from-fork'), { code: 'from-fork' })
      const invalid = Object.assign(new Error('validation'), { code: 'request-failed', status: 422 })
      if (pull.lifecycle !== 'merged') throw invalid
      // ponytail: the default branch comes from "New pull request"'s read (one extra pulls query).
      if ((await client.pullForBranch(repository, pull.head.ref)).defaultBranch === pull.head.ref) throw invalid
      try {
        await client.deleteBranchRef(repository, pull.head.ref)
      } catch (error) {
        const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown }
        refusedDelete = code === 'request-failed' && status === 422
        throw error
      }
    })
    return !result.ok && refusedDelete ? { ok: false, reason: 'branch-protected' } : result
  }

  /** The head checks' Actions run and job ids (only checks of `repository`). */
  private async headActionsJobs(request: { projectId: string; repository: string; pullNumber: number }) {
    const checks = await this.pullChecks(request)
    if (checks.status !== 'ok') return []
    return checks.checks.flatMap((check) => {
      const job = actionsJobOf(check.url, request.repository)
      return job ? [{ ...job, failed: check.state === 'failed' }] : []
    })
  }

  /** The failing step's last lines of one Actions job, for the Checks tab's inline excerpt. A job that
   *  is not one of this PR's head checks is refused with no log request. Rules as `pullDetail`. */
  async pullCheckLog(
    request: { projectId: string; repository: string; pullNumber: number; jobId: number }
  ): Promise<GitHubPullCheckLogResult> {
    const jobId = request?.jobId
    if (!Number.isSafeInteger(jobId) || jobId < 1 || typeof request.repository !== 'string') {
      return { status: 'refused', reason: 'not-configured' }
    }
    if (!(await this.headActionsJobs(request)).some((job) => job.jobId === jobId)) {
      return { status: 'refused', reason: 'not-configured' }
    }
    return this.pullRead(`check-log\0${jobId}`, request, async (captured, repository) => {
      const { client } = captured
      if (!client.jobLogTail) return null
      const lines = await this.readWithEpoch(captured, () => client.jobLogTail!(repository, jobId))
      return { status: 'ok', lines, observedAt: this.now() }
    })
  }

  /** "Re-run failed" from the Checks tab (a user click only): GitHub re-runs the failed jobs of one
   *  Actions run, which must hold a failed check of this PR's head. */
  async rerunFailedJobs(
    request: { projectId: string; repository: string; pullNumber: number; runId: number }
  ): Promise<PullWriteResult> {
    const runId = request?.runId
    if (!Number.isSafeInteger(runId) || runId < 1) return { ok: false, reason: 'validation' }
    return this.pullWrite(request, async (client, repository) => {
      // ponytail: as above.
      if (!client.rerunFailedJobs) throw new Error('unsupported')
      if (!(await this.headActionsJobs(request)).some((job) => job.runId === runId && job.failed)) {
        throw Object.assign(new Error('validation'), { code: 'request-failed', status: 422 })
      }
      await client.rerunFailedJobs(repository, runId)
    })
  }

  /** The repository's labels for the sidebar's "Add label", name and color. Held per repository like
   *  the collaborators (ponytail: first 100 labels only; a label made on GitHub shows after a restart). */
  async repoLabels(request: { projectId: string; repository: string }): Promise<GitHubRepoLabelsResult> {
    const result = await this.heldRepoRead(this.repoLabelLists, request, (client) => async (repository: string) =>
      (await client.listRepositoryLabels(repository, { page: 1, perPage: 100 })).items.map(({ name, color }) => ({ name, color })))
    return result.status === 'ok' ? { status: 'ok', labels: result.value } : result
  }

  /**
   * The shared path of every pull node write (comment, review, merge). Only a user's click reaches it, so it
   * needs the approved repository but not the label-mapping approval. The node's repository must be
   * the project's; the write runs on the coordinator's mutation path. A landed write drops this PR's
   * held reads (so the node's next read is fresh) and refreshes the board. Never throws.
   */
  private async pullWrite(
    request: { projectId: string; repository: string; pullNumber: number },
    write: (client: GitHubIssuesClientLike, repository: string, pullNumber: number) => Promise<unknown>
  ): Promise<PullWriteResult> {
    const { projectId, pullNumber } = request
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) return { ok: false, reason: 'validation' }
    const result = await this.repoWrite(request, (client, repository) => write(client, repository, pullNumber))
    // The head moved: the node reloads, and that read must not answer from the held one.
    if (result.ok || result.reason === 'head-moved' || result.reason === 'suggestion-stale') this.dropPullReads(projectId, result.repository!, pullNumber)
    if (!result.ok) return { ok: false, reason: result.reason }
    this.afterWrite(projectId)
    return { ok: true }
  }

  /**
   * The shared path of every write a user's click makes (the pull node's, and "New pull request").
   * It needs the approved repository but not the label-mapping approval. The named repository must
   * be the project's, or nothing is sent. `repository` is the project's spelling, once resolved.
   */
  private async repoWrite<T>(
    request: { projectId: string; repository: string },
    write: (client: GitHubIssuesClientLike, repository: string) => Promise<T>
  ): Promise<{ ok: true; value: T; repository: string } | { ok: false; reason: PullWriteReason; repository?: string }> {
    const repository = parseGitHubRepository(request.repository)
    const { projectId } = request
    if (typeof projectId !== 'string' || !repository) return { ok: false, reason: 'validation' }
    let captured: GitHubIssueServiceContext
    try {
      captured = await this.options.contextForProject(projectId)
    } catch (error) {
      const refusal = pullRefusalOf(error)
      if (refusal) return { ok: false, reason: refusal === 'signed-out' ? 'signed-out' : 'not-approved' }
      return { ok: false, reason: pullWriteFailure(error) }
    }
    if (captured.repository.toLowerCase() !== repository.toLowerCase()) return { ok: false, reason: 'not-approved' }
    try {
      const value = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (epoch(captured) !== epoch(await this.options.contextForProject(projectId))) {
          throw new ConfigurationChangedError()
        }
        return write(captured.client, captured.repository)
      })
      return { ok: true, value, repository: captured.repository }
    } catch (error) {
      return { ok: false, reason: pullWriteFailure(error), repository: captured.repository }
    }
  }

  /** A write is a reason to look again: the board's incremental refresh skips its caller floor once
   *  (the full-reconcile floor stays). */
  private afterWrite(projectId: string): void {
    const floor = this.refreshFloors.get(projectId)
    if (floor) this.refreshFloors.set(projectId, { ...floor, any: 0 })
    void this.refresh({ projectId }).catch(() => undefined)
  }

  /**
   * An agent's own shell wrote to a pull request (@shared/pr-write-hook, a verified PostToolUse): its
   * held reads go, so the pull node's refresh reads GitHub instead of answering from the floor.
   * `repository` undefined (the agent's shell repo) matches every repository; `pullNumber` undefined
   * (gh's current-branch PR) every pull request.
   */
  forgetPull(repository: string | undefined, pullNumber: number | undefined): void {
    for (const key of [...this.pullReads.keys()]) {
      const [repo, num] = key.split('\0').slice(-2)
      if ((pullNumber === undefined || num === String(pullNumber)) &&
          (!repository || repo.toLowerCase() === repository.toLowerCase())) this.pullReads.delete(key)
    }
  }

  private dropPullReads(projectId: string, repository: string, pullNumber: number): void {
    const kinds = new Set(['detail', 'conversation', 'files', 'commits', 'issue-conversation', 'timeline', 'issue-timeline'])
    const suffix = `\0${projectId}\0${repository}\0${pullNumber}`
    // The checks read carries the review state the lead button reads (readiness.ts nextStep).
    this.checkReads.delete(`${projectId}\0${pullNumber}`)
    for (const key of [...this.pullReads.keys()]) {
      if (!key.endsWith(suffix)) continue
      const kind = key.slice(0, -suffix.length)
      // A timeline's later pages are held by cursor (`timeline\0<cursor>`): every one is dropped.
      if (kinds.has(kind) || kind.startsWith('timeline\0') || kind.startsWith('issue-timeline\0')) this.pullReads.delete(key)
    }
  }

  /** The sidebar part of `pullDetail`, reviewers merged. Undefined when this client has no such read
   *  or it failed. ponytail: a failed sidebar hides the sidebar parts and never fails the detail. */
  private async pullSidebar(captured: GitHubIssueServiceContext, repository: string, pullNumber: number): Promise<PullSidebar | undefined> {
    const read = captured.client.pullSidebar?.bind(captured.client)
    if (!read) return undefined
    const answer: PullSidebarRead | undefined = await this.readWithEpoch(captured, () => read(repository, pullNumber)).catch(() => undefined)
    if (!answer) return undefined
    const { requested, reviews, ...rest } = answer
    return { ...(requested && reviews ? { reviewers: mergePullReviewers(requested, reviews) } : {}), ...rest }
  }

  /** The avatars of a pull read's users as data URLs keyed by user id (the kanban cards' shape), or
   *  undefined when none loaded. Never throws: an avatar is decoration, never a reason a read fails. */
  private async pullAvatars(users: readonly (GitHubIssueUser | null)[]): Promise<Record<string, string> | undefined> {
    if (!this.options.avatarFetcher) return undefined
    const known = users.filter((user): user is GitHubIssueUser => user !== null)
    if (!known.length) return undefined
    const { dataUrls } = await this.options.avatarFetcher.forPage(known).catch(() => ({ dataUrls: new Map<number, string>() }))
    return dataUrls.size ? Object.fromEntries([...dataUrls].map(([id, url]) => [String(id), url])) : undefined
  }

  /**
   * The shared path of every pull node read, run on mount and on Refresh. The node names the
   * repository it was opened for; anything but the project's approved repository is refused before
   * a credential is resolved, so a shared project file cannot point this token at another repo. A
   * read inside `REFRESH_MIN_INTERVAL_MS` of the last good one answers from memory; a failed read
   * keeps the last good answer, marks it stale, and does not hold the floor. Never throws.
   * `read` answers null when this client cannot make the read at all.
   */
  private async pullRead<O extends PullOk>(
    // `contents\0…` carries the file and SHAs, so a held entry is one file at one head;
    // `merge-base\0…` carries the base and head SHAs.
    kind: 'detail' | 'conversation' | 'files' | 'issue-conversation' | `contents\0${string}` | `merge-base\0${string}`
      // `commit-…\0<sha>…`: one commit's files or one file of it (07).
      | 'commits' | `commit-files\0${string}` | `commit-contents\0${string}`
      | 'timeline' | `timeline\0${string}`
      | 'issue-timeline' | `issue-timeline\0${string}`
      | `check-log\0${string}`
      // `since-review…\0<head>…`: the comparison to the viewer's last review, and one file of it (F-10).
      | `since-review\0${string}` | `since-review-contents\0${string}`,
    request: { projectId: string; repository: string; pullNumber: number },
    read: (captured: GitHubIssueServiceContext, repository: string, pullNumber: number) => Promise<O | null>
  ): Promise<PullResult<O>> {
    const repository = parseGitHubRepository(request?.repository)
    if (typeof request?.projectId !== 'string' || !repository || !Number.isSafeInteger(request.pullNumber) ||
        request.pullNumber < 1) return { status: 'refused', reason: 'not-configured' }
    let projectRepository: string
    try {
      projectRepository = (await this.cacheContext(request.projectId)).repository
    } catch (error) {
      return this.pullContextFailure<O>(error)
    }
    if (repository.toLowerCase() !== projectRepository.toLowerCase()) {
      return { status: 'refused', reason: 'repository-mismatch' }
    }
    const key = `${kind}\0${request.projectId}\0${projectRepository}\0${request.pullNumber}`
    let entry = this.pullReads.get(key)
    if (!entry) {
      entry = { floorUntil: 0 }
      this.pullReads.set(key, entry)
      if (this.pullReads.size > MAX_PULL_READS) this.pullReads.delete(this.pullReads.keys().next().value!)
    }
    // ponytail: one map for every kind; the key carries the kind, so an entry only ever holds its own O.
    const held = entry as { last?: O; floorUntil: number; reading?: Promise<PullResult<O>> }
    if (held.reading) return held.reading
    const startedAt = this.now()
    if (held.last && startedAt < held.floorUntil) return held.last
    const reading = this.readPull(request.projectId, projectRepository, request.pullNumber, held.last, read)
      .then((result) => {
        if (result.status === 'ok' && !result.stale) {
          held.last = result
          held.floorUntil = startedAt + REFRESH_MIN_INTERVAL_MS
        }
        return result
      })
      .finally(() => { held.reading = undefined })
    held.reading = reading
    return reading
  }

  private async readPull<O extends PullOk>(
    projectId: string,
    repository: string,
    pullNumber: number,
    last: O | undefined,
    read: (captured: GitHubIssueServiceContext, repository: string, pullNumber: number) => Promise<O | null>
  ): Promise<PullResult<O>> {
    let captured: GitHubIssueServiceContext
    try {
      captured = await this.options.contextForProject(projectId)
    } catch (error) {
      return this.pullContextFailure(error, last)
    }
    if (captured.repository !== repository) return { status: 'refused', reason: 'repository-mismatch' }
    try {
      return await read(captured, repository, pullNumber) ?? { status: 'failed', reason: 'unreachable' }
    } catch (error) {
      return stalePull(last, error)
    }
  }

  /** A context that could not be resolved: a coded host refusal, else a failure to reach GitHub. */
  private pullContextFailure<O extends PullOk>(error: unknown, last?: O): PullResult<O> {
    const refusal = pullRefusalOf(error)
    if (refusal) return { status: 'refused', reason: refusal }
    return stalePull(last, error)
  }

  private readPullStatusAfterHeartbeat(
    captured: GitHubIssueServiceContext,
    changed: boolean,
    foreground: boolean
  ): void {
    const key = repositoryKey(captured)
    if (!captured.client.pullRequestStatuses) return
    if (!this.pulls.wantsReadAfterHeartbeat(key, { changed, foreground })) return
    void this.pulls.read(key, captured.userId, foreground ? 'foreground' : 'heartbeat', () =>
      this.readWithEpoch(captured, () => captured.client.pullRequestStatuses!(captured.repository)))
      .catch(() => undefined)
  }

  private state(
    context: GitHubIssueServiceContext,
    operationId: number,
    repositoryGeneration: number
  ): Promise<RepositoryState> {
    const work = this.prepareState(context, operationId, repositoryGeneration)
    let preparations = this.statePreparations.get(context.repository)
    if (!preparations) {
      preparations = new Set()
      this.statePreparations.set(context.repository, preparations)
    }
    preparations.add(work)
    void work.finally(() => {
      preparations!.delete(work)
      if (preparations!.size === 0) this.statePreparations.delete(context.repository)
    }).catch(() => undefined)
    return work
  }

  private async prepareState(
    context: GitHubIssueServiceContext,
    operationId: number,
    repositoryGeneration: number
  ): Promise<RepositoryState> {
    this.assertRepositoryWriteAllowed(context.repository, operationId, repositoryGeneration)
    await this.options.cache.bind(
      context.localApprovalId, context.projectId, context.repository, context.userId
    )
    this.assertRepositoryWriteAllowed(context.repository, operationId, repositoryGeneration)
    const key = repositoryKey(context)
    const unboundKey = `unbound:${context.localApprovalId}\0${context.repository}`
    const unbound = this.repositories.get(unboundKey)
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(context.userId, context.repository)
      this.assertRepositoryWriteAllowed(context.repository, operationId, repositoryGeneration)
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map(),
        cacheGeneration: 0
      }
      this.repositories.set(key, state)
    }
    if (unbound && unbound !== state) {
      for (const [projectId, subscribers] of unbound.subscribers) {
        let target = state.subscribers.get(projectId)
        if (!target) {
          target = new Set()
          state.subscribers.set(projectId, target)
        }
        for (const uiId of subscribers) target.add(uiId)
      }
      if (unbound.timer) {
        this.unschedule(unbound.timer)
        delete unbound.timer
      }
      this.repositories.delete(unboundKey)
      this.ensureTimer(state)
    }
    this.migrateProjectState(context.projectId, key, state)
    this.projectKeys.set(context.projectId, key)
    return state
  }

  private async cacheContext(projectId: string): Promise<GitHubIssueProjectContext> {
    if (this.options.projectContextForCache) return this.options.projectContextForCache(projectId)
    return this.options.contextForProject(projectId)
  }

  private async cachedState(context: GitHubIssueProjectContext): Promise<{
    key: string
    state: RepositoryState
    /** The identity the project's cache is bound to; null before its first authenticated refresh. */
    userId: string | null
  }> {
    await this.waitForRepositoryDeletion(context.repository)
    const repositoryGeneration = this.repositoryControl(context.repository).generation
    const userId = await this.options.cache.boundUserId(
      context.localApprovalId, context.projectId, context.repository
    )
    if (!userId) {
      if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
        return this.cachedState(context)
      }
      const key = `unbound:${context.localApprovalId}\0${context.repository}`
      let state = this.repositories.get(key)
      if (!state) {
        state = { incomplete: false, subscribers: new Map(), cacheGeneration: 0 }
        this.repositories.set(key, state)
      }
      this.projectKeys.set(context.projectId, key)
      if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
        return this.cachedState(context)
      }
      return { key, state, userId: null }
    }
    const key = `${userId}\0${context.repository}`
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(userId, context.repository)
      if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
        return this.cachedState(context)
      }
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map(),
        cacheGeneration: 0
      }
      this.repositories.set(key, state)
    }
    this.projectKeys.set(context.projectId, key)
    if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
      return this.cachedState(context)
    }
    return { key, state, userId }
  }

  private async refreshRepository(
    captured: GitHubIssueServiceContext,
    state: RepositoryState,
    forceFull: boolean,
    cacheGeneration: number,
    operationId: number,
    repositoryGeneration: number,
    refreshStartedAt: number,
    background = false
  ): Promise<void> {
    const full = forceFull || !state.snapshot ||
      this.now() - state.snapshot.lastFullReconciliationAt >= FULL_REFRESH_AGE
    const previous = state.snapshot
    const byNumber = new Map((full ? [] : previous?.issues ?? []).map((issue) => [issue.number, issue]))
    // An incremental pass starts from a set a previous eviction may already have thinned, and it
    // never re-fetches what was dropped — so the claim survives until a full reconciliation
    // re-reads the repository and can honestly clear it.
    let pullsTruncated = !full && !!previous?.pullsTruncated
    // The heartbeat runs BEFORE the scan, and it is its validator — not one read afterwards — that
    // gets stored: a change landing while the scan pages is then still "new" to the next heartbeat.
    // A 304 skips the scan outright. It never skips a full reconciliation (deletions and transfers
    // do not move the top item, so that pass is the only thing that can see them), and never an
    // incomplete repository, which a 304 would otherwise freeze read only.
    const storedEtag = previous?.etags[HEARTBEAT_ETAG_KEY]
    const beat = await this.readWithEpoch(captured, () =>
      captured.client.issuesHeartbeat(captured.repository, storedEtag))
      .catch((error: unknown) =>
        error instanceof ConfigurationChangedError ? null : Promise.reject(error))
    if (!beat) return
    // The heartbeat is also what decides whether pull request CI/mergeability is worth a GraphQL
    // read. It runs beside the issue scan, not after it: the board's issues never wait on it.
    this.readPullStatusAfterHeartbeat(captured, !beat.notModified, !background)
    if (beat.notModified && !full && previous && !state.incomplete) {
      // Nothing to fetch — but subscribers still re-read their pages, from the local cache, as every
      // successful refresh has always made them do. A page is not only issues: read only, the
      // mapping approval and the completion column are derived by the host at query time, and a
      // board never prompted keeps showing the old answer (e.g. read only after its approval).
      this.emitDelta(state, [], true)
      return
    }
    const heartbeatEtag = beat.etag
    const etags: Record<string, string> = heartbeatEtag ? { [HEARTBEAT_ETAG_KEY]: heartbeatEtag } : {}
    let page = 1
    while (true) {
      if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration) ||
          cacheGeneration !== state.cacheGeneration ||
          epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
      const since = !full && previous?.lastSuccessfulRefreshAt
        ? new Date(Math.max(0, previous.lastSuccessfulRefreshAt - 2_000)).toISOString()
        : undefined
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listIssues(captured.repository, {
          state: 'all', page, perPage: 100, ...(since ? { since } : {})
        })).catch((error: unknown) =>
          error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!result) return
      if (!result.notModified) {
        for (const item of result.items) {
          const old = byNumber.get(item.number)
          if (!old || item.updatedAt >= old.updatedAt) byNumber.set(item.number, item)
        }
      }
      if (byNumber.size > MAX_ISSUES) {
        const trimmed = evictPullsToFit(
          [...byNumber.values()], (candidate) => candidate.length <= MAX_ISSUES
        )
        if (!trimmed) {
          await this.incomplete(
            captured, state, 'issue-limit', [...byNumber.values()].slice(0, MAX_ISSUES),
            cacheGeneration, operationId, repositoryGeneration
          )
          return
        }
        // Paging continues on the trimmed set: each firing drops at least one item, so the scan
        // stays bounded, and a later page's issue still displaces a pull request rather than the
        // scan giving up.
        byNumber.clear()
        for (const item of trimmed.items) byNumber.set(item.number, item)
        pullsTruncated = pullsTruncated || trimmed.pullsTruncated
      }
      if (!result.nextPage) break
      page = result.nextPage
    }
    const harvest = [...byNumber.values()]
    const withinBytes = evictPullsToFit(harvest, (candidate) =>
      Buffer.byteLength(JSON.stringify(candidate), 'utf-8') <= MAX_CACHE_BYTES)
    if (!withinBytes) {
      await this.incomplete(
        captured, state, 'byte-limit', harvest, cacheGeneration, operationId, repositoryGeneration
      )
      return
    }
    const issues = withinBytes.items
    pullsTruncated = pullsTruncated || withinBytes.pullsTruncated
    if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration ||
        epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
    const snapshot: GitHubCompleteSnapshot = {
      issues,
      etags,
      lastSuccessfulRefreshAt: refreshStartedAt,
      lastFullReconciliationAt: full
        ? refreshStartedAt
        : previous?.lastFullReconciliationAt ?? refreshStartedAt,
      ...(pullsTruncated ? { pullsTruncated: true } : {})
    }
    if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration)) return
    await this.options.cache.saveComplete(captured.userId, captured.repository, snapshot)
    if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    const oldNumbers = new Map((previous?.issues ?? []).map((item) => [item.number, item.updatedAt]))
    const nextNumbers = new Set(issues.map((item) => item.number))
    const changed = [
      ...issues.filter((item) => oldNumbers.get(item.number) !== item.updatedAt)
        .map((item) => item.number),
      ...(previous?.issues ?? []).filter((item) => !nextNumbers.has(item.number))
        .map((item) => item.number)
    ]
    state.snapshot = snapshot
    state.partialIssues = undefined
    state.incomplete = false
    this.emitDelta(state, changed, true)
  }

  private subscriberCount(state: RepositoryState): number {
    let count = 0
    for (const subscribers of state.subscribers.values()) count += subscribers.size
    return count
  }

  private ensureTimer(state: RepositoryState): void {
    if (state.timer || this.subscriberCount(state) === 0) return
    state.timer = this.schedule(() => this.poll(state), POLL_MS)
  }

  private async poll(state: RepositoryState): Promise<void> {
    for (const projectId of [...state.subscribers.keys()]) {
      try {
        // Deliberately BELOW the caller floor: the floor bounds callers we don't control (the
        // renderer, and a relay guest on a shared project), while the poll is already paced by
        // POLL_MS. Routing it through the floor would also break this loop's fallback — a
        // throttled call returns without throwing, which reads here as "this project worked" and
        // would stop us ever trying the next subscriber's context.
        // It IS a background refresh, though, so the rate budget may hold it.
        const throttle = await this.refreshWithinFloor({ projectId }, undefined, true)
        // A refresh that ran prompted its subscribers itself (a 304 included), which is also what
        // clears a lifted "held until" line from the board.
        if (throttle) this.announceThrottle(state, throttle.until)
        return
      } catch (error) {
        const failure = classifyGitHubFailure(error)
        if (failure.kind === 'rate-limited' && failure.retryAt !== undefined) {
          this.announceThrottle(state, failure.retryAt)
        }
        // Another approved project may still provide a valid context for the shared repository.
      }
    }
  }

  /** A held poll changes nothing the board can see except WHY it is quiet. Prompt its subscribers
   *  to re-read (the page carries the throttle) — once per deadline, not once per skipped minute. */
  private announceThrottle(state: RepositoryState, until: number): void {
    if (state.announcedThrottleUntil === until) return
    state.announcedThrottleUntil = until
    this.emitDelta(state, [], true)
  }

  /** Prompts one project's subscribers to re-read their pages. For a change the host makes that
   *  no refresh would report — an approval given or withdrawn — so the board does not wait for the
   *  next poll (or, before polls re-prompted, for something to change on GitHub). */
  notifyProject(projectId: string): void {
    const key = this.projectKeys.get(projectId)
    const state = key ? this.repositories.get(key) : undefined
    for (const uiId of state?.subscribers.get(projectId) ?? []) {
      this.options.onDelta?.(uiId, projectId, [])
    }
  }

  private migrateProjectState(projectId: string, key: string, target: RepositoryState): void {
    const previousKey = this.projectKeys.get(projectId)
    if (!previousKey || previousKey === key) return
    const previous = this.repositories.get(previousKey)
    const subscribers = previous?.subscribers.get(projectId)
    if (!previous || !subscribers) return
    let destination = target.subscribers.get(projectId)
    if (!destination) {
      destination = new Set()
      target.subscribers.set(projectId, destination)
    }
    for (const uiId of subscribers) destination.add(uiId)
    previous.subscribers.delete(projectId)
    if (this.subscriberCount(previous) === 0 && previous.timer) {
      this.unschedule(previous.timer)
      delete previous.timer
    }
    this.ensureTimer(target)
  }

  private repositoryControl(repository: string): RepositoryControl {
    let control = this.repositoryControls.get(repository)
    if (!control) {
      control = { generation: 0, clearCutoff: 0 }
      this.repositoryControls.set(repository, control)
    }
    return control
  }

  private repositoryWriteAllowed(
    repository: string,
    operationId: number,
    repositoryGeneration: number
  ): boolean {
    const control = this.repositoryControl(repository)
    return !control.deletion && operationId > control.clearCutoff &&
      repositoryGeneration === control.generation
  }

  private assertRepositoryWriteAllowed(
    repository: string,
    operationId: number,
    repositoryGeneration: number
  ): void {
    if (!this.repositoryWriteAllowed(repository, operationId, repositoryGeneration)) {
      throw new RepositoryClearedError()
    }
  }

  private async waitForRepositoryDeletion(repository: string): Promise<void> {
    while (this.repositoryControl(repository).deletion) {
      await this.repositoryControl(repository).deletion
    }
  }

  private repositoryStates(localApprovalId: string, repository: string): RepositoryState[] {
    const states: RepositoryState[] = []
    for (const [key, state] of this.repositories) {
      if (key.endsWith(`\0${repository}`) || key === `unbound:${localApprovalId}\0${repository}`) {
        states.push(state)
      }
    }
    return states
  }

  private readWithEpoch<T>(captured: GitHubIssueServiceContext, operation: () => Promise<T>): Promise<T> {
    return this.options.coordinator.runRead(captured.userId, async () => {
      if (epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) {
        throw new ConfigurationChangedError()
      }
      return operation()
    })
  }

  private async repositoryLabelNames(captured: GitHubIssueServiceContext): Promise<Set<string>> {
    const names = new Set<string>()
    let page = 1
    while (true) {
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listRepositoryLabels(captured.repository, { page, perPage: 100 }))
      for (const label of result.items) {
        names.add(label.name.normalize('NFKC').toLocaleLowerCase('en-US'))
      }
      if (!result.nextPage) return names
      page = result.nextPage
    }
  }

  private emitDelta(
    state: RepositoryState,
    changedIssueNumbers: number[],
    includeEmpty = false
  ): void {
    if (!includeEmpty && changedIssueNumbers.length === 0) return
    for (const [projectId, subscribers] of state.subscribers) {
      for (const uiId of subscribers) this.options.onDelta?.(uiId, projectId, changedIssueNumbers)
    }
  }

  private async incomplete(
    context: GitHubIssueServiceContext,
    state: RepositoryState,
    reason: 'issue-limit' | 'byte-limit',
    issues: GitHubIssue[],
    cacheGeneration: number,
    operationId: number,
    repositoryGeneration: number
  ): Promise<void> {
    if (!this.repositoryWriteAllowed(context.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    await this.options.cache.saveIncompleteAttempt(context.userId, context.repository, {
      reason,
      observedAt: this.now(),
      ...(!state.snapshot ? { partialIssues: issues } : {})
    })
    if (!this.repositoryWriteAllowed(context.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    if (!state.snapshot) state.partialIssues = issues
    state.incomplete = true
    this.emitDelta(state, [], true)
  }
}

/** Carries a `code` like every other error the pull status tracker reads: a context that changed
 *  mid-read is not a failed read, and must not mark the board stale. */
class ConfigurationChangedError extends Error {
  readonly code = 'configuration-changed'
}
class RepositoryClearedError extends Error {}

import type {
  CreateIssueInput,
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueUser,
  GitHubPullMeta,
  GitHubRepositoryLabel,
  IssueHeartbeatResult,
  IssuePageResult,
  LabelPageResult,
  ListIssueOptions,
  UpdateIssueInput
} from '../../shared/github-issues'
import { parseGitHubRepository } from './config'
import { mergeState, type GitHubPullChecksResult, type PullLifecycle } from '../../shared/github-pull-status'
import type {
  GitHubPullDetail,
  PullConversationItem,
  PullConversationPage,
  PullCreateDraft,
  PullFile,
  PullFileRead,
  PullFilesPage,
  PullFileStatus,
  PullLineComment,
  PullLineCommentWrite,
  PullLineCommentsPage,
  PullLineDraft,
  PullMergeMethod,
  PullReviewEvent,
  PullReviewVerdict,
  PullViewedState
} from '../../shared/github-pull-detail'
import type { PullSuggestionComment } from './service'
import {
  GITHUB_LOGIN, MAX_PULL_REVIEW_COMMENTS, isPullBranchName, isPullCommentBody, isPullCreateDraft, isPullLineDraft, isPullPath
} from '../../shared/github-pull-detail'
import {
  GraphQLShapeError,
  PULL_CHECKS_QUERY,
  PULL_RESOLVED_THREADS_QUERY,
  PULL_STATUS_QUERY,
  graphQLErrors,
  parsePullChecksResponse,
  parsePullResolvedThreads,
  parsePullStatusResponse,
  rateLimitFrom,
  type PullStatusRead
} from './graphql-pulls'
import { PULL_SIDEBAR_QUERY, parsePullSidebar } from './graphql-pull-sidebar'
import type { PullSidebarRead } from '../../shared/github-pull-sidebar'
import { PULL_COMMITS_QUERY, parsePullCommits } from './graphql-pull-commits'
import { isCommitSha, type PullCommitFilesPage, type PullCommitsPage } from '../../shared/github-pull-commits'
import { PULL_TIMELINE_QUERY, parsePullTimelineResponse } from './graphql-pull-timeline'
import { isPullTimelineCursor, type PullTimelinePage } from '../../shared/github-pull-timeline'
import { ISSUE_TIMELINE_QUERY, parseIssueTimelineResponse } from './graphql-issue-timeline'
import { failingStepTail } from './check-log'
import { CHECK_LOG_LINES } from '../../shared/github-pull-check-log'
import { PULL_VIEWER_REVIEW_QUERY, parsePullViewerReview } from './graphql-pull-since-review'
import type { PullCompare, PullViewerReview } from '../../shared/github-pull-since-review'

const MAX_VIEWED_PAGES = 3
const PULL_VIEWED_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    files(first:100,after:$after){ nodes{ path viewerViewedState } pageInfo{ hasNextPage endCursor } }
  } }
}`

const PULL_THREAD_IDS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100){ nodes{ id comments(first:1){ nodes{ databaseId } } } }
  } }
}`

const API_ORIGIN = 'https://api.github.com'
const REVIEW_EVENTS: ReadonlySet<unknown> = new Set<PullReviewEvent>(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
const MERGE_METHODS: ReadonlyArray<[PullMergeMethod, string]> = [
  ['merge', 'allow_merge_commit'], ['squash', 'allow_squash_merge'], ['rebase', 'allow_rebase_merge']
]
const API_VERSION = '2022-11-28'
const DEFAULT_MAX_RESPONSE = 8 * 1024 * 1024
const MAX_ERROR_METADATA_BYTES = 4 * 1024
const MAX_JOB_LOG_TAIL = 512 * 1024

export class GitHubClientError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'malformed-response' | 'response-too-large' |
      'request-failed' | 'rate-limited' | 'insufficient-permission' | 'own-pull',
    readonly status?: number,
    readonly retryAt?: number,
    /** Which rate budget a PRIMARY limit belongs to (`x-ratelimit-resource`). `graphql` and `core`
     *  are separate budgets, so a spent `graphql` budget must not hold REST issue sync. Absent for a
     *  secondary limit, which GitHub applies to the whole account. */
    readonly resource?: string
  ) {
    super(code)
  }
}

type ClientOptions = {
  token: string
  fetch?: typeof fetch
  maxResponseBytes?: number
  timeoutMs?: number
  /** Called with the rate budget every response carries — 200, 304 and errors alike — so the
   *  request coordinator can pace work BEFORE GitHub has to refuse it. */
  onRateLimit?: (sample: GitHubRateSample) => void
}

/** One reading of `x-ratelimit-*`. `resetAt` is epoch milliseconds. */
export interface GitHubRateSample {
  resource: string
  limit: number
  remaining: number
  resetAt: number
}

/** Parses the rate headers, or null when any is absent or implausible. A missing header must never
 *  read as "zero left": that would pause sync on every response that simply does not carry one. */
export function rateSampleFrom(headers: Headers): GitHubRateSample | null {
  const limit = Number(headers.get('x-ratelimit-limit') ?? NaN)
  const remaining = Number(headers.get('x-ratelimit-remaining') ?? NaN)
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN)
  const resource = headers.get('x-ratelimit-resource') ?? 'core'
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(remaining) ||
      remaining < 0 || remaining > limit || !Number.isSafeInteger(reset) || reset <= 0 ||
      !/^[a-z_]{1,32}$/.test(resource)) return null
  return { resource, limit, remaining, resetAt: reset * 1_000 }
}

function safeRepository(repository: string): string {
  if (parseGitHubRepository(repository) !== repository) throw new GitHubClientError('invalid-request')
  return repository
}

function positiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function string(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function isoDate(value: unknown): value is string {
  return string(value, 64) && !Number.isNaN(Date.parse(value))
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function issueLabel(value: unknown): GitHubIssueLabel | null {
  const item = object(value)
  if (!item || !positiveInteger(Number(item.id), Number.MAX_SAFE_INTEGER) ||
      !string(item.name, 50) || !string(item.color, 6) || !/^[0-9a-fA-F]{6}$/.test(item.color)) {
    return null
  }
  return { id: Number(item.id), name: item.name, color: item.color.toLowerCase() }
}

function issueUser(value: unknown): GitHubIssueUser | null {
  const item = object(value)
  if (!item || !positiveInteger(Number(item.id), Number.MAX_SAFE_INTEGER) ||
      !string(item.login, 128) || !string(item.avatar_url, 2_048)) return null
  let avatar: URL
  try { avatar = new URL(item.avatar_url) } catch { return null }
  if (avatar.protocol !== 'https:' || avatar.hostname !== 'avatars.githubusercontent.com') return null
  return { id: Number(item.id), login: item.login, avatarUrl: avatar.toString() }
}

/** Decodes the pull-request half of an issues-endpoint item. Returns `undefined` for an issue
 *  (no `pull_request` object) and `null` for a malformed one, which the caller must reject —
 *  the two answers are different facts. */
function pullFrom(item: Record<string, unknown>): GitHubPullMeta | null | undefined {
  const pull = object(item.pull_request)
  if (item.pull_request === undefined) return undefined
  if (!pull) return null
  const mergedAt = pull.merged_at
  if (!(mergedAt === null || mergedAt === undefined || isoDate(mergedAt))) return null
  if (!(item.draft === undefined || typeof item.draft === 'boolean')) return null
  return { draft: item.draft === true, mergedAt: (mergedAt ?? null) as string | null }
}

const KNOWN_STATE_REASONS: ReadonlySet<string> = new Set(['completed', 'not_planned', 'reopened', 'duplicate'])

const SHA = /^[0-9a-f]{40}$/

function pullRef(value: unknown): { ref: string; sha: string } | null {
  const item = object(value)
  if (!item || !string(item.ref, 255) || !item.ref || !string(item.sha, 40) || !SHA.test(item.sha)) return null
  return { ref: item.ref, sha: item.sha }
}

/** Decodes `GET /pulls/{n}`. Merge state goes through the board's own rules (`mergeState`), with
 *  REST's boolean `mergeable` and lower-case `mergeable_state` spelled as GraphQL spells them. */
function pullDetailFrom(value: unknown): GitHubPullDetail | null {
  const item = object(value)
  if (!item || !positiveInteger(Number(item.number), 2_147_483_647) || !string(item.title, 1_024) ||
      !(item.body === null || item.body === undefined || string(item.body, 262_144)) ||
      (item.state !== 'open' && item.state !== 'closed') ||
      !(item.draft === undefined || typeof item.draft === 'boolean') || typeof item.merged !== 'boolean' ||
      !(item.mergeable === null || item.mergeable === undefined || typeof item.mergeable === 'boolean') ||
      !(item.mergeable_state === undefined || string(item.mergeable_state, 32)) ||
      !string(item.html_url, 2_048)) return null
  const counts = [item.additions, item.deletions, item.changed_files].map(Number)
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null
  let url: URL
  try { url = new URL(item.html_url) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  const base = pullRef(item.base)
  const head = pullRef(item.head)
  if (!base || !head) return null
  const author = item.user === null || item.user === undefined ? null : issueUser(item.user)
  if (item.user && !author) return null
  // ponytail: display only, so a malformed entry is skipped rather than failing the overview.
  const requested = Array.isArray(item.requested_reviewers)
    ? item.requested_reviewers.slice(0, 100).flatMap((user) => issueUser(user) ?? [])
    : []
  // ponytail: display only, as above; a method this build does not know claims nothing.
  const autoMethod = object(item.auto_merge)?.merge_method
  const autoMerge = MERGE_METHODS.find(([method]) => method === autoMethod)?.[0]
  // A head in another repository (or in a fork since deleted, `repo: null`) is only on origin as pull/<n>/head.
  const repoName = (side: unknown): unknown => {
    const repo = object(side)?.repo
    return repo === null ? null : object(repo)?.full_name
  }
  const headRepo = repoName(item.head)
  const baseRepo = repoName(item.base)
  const fromFork = headRepo === null ||
    (typeof headRepo === 'string' && typeof baseRepo === 'string' && headRepo.toLowerCase() !== baseRepo.toLowerCase())
  const lifecycle: PullLifecycle = item.state === 'closed'
    ? item.merged ? 'merged' : 'closed'
    : item.draft ? 'draft' : 'open'
  const merge = item.state === 'open'
    ? mergeState(
      item.mergeable === true ? 'MERGEABLE' : item.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
      typeof item.mergeable_state === 'string' ? item.mergeable_state.toUpperCase() : 'UNKNOWN')
    : undefined
  return {
    number: Number(item.number),
    title: item.title,
    body: item.body ?? '',
    lifecycle,
    author,
    base,
    head,
    ...(merge !== undefined ? { merge } : {}),
    additions: counts[0],
    deletions: counts[1],
    changedFiles: counts[2],
    url: url.toString(),
    ...(requested.length ? { requestedReviewers: requested } : {}),
    ...(autoMerge ? { autoMerge: { method: autoMerge } } : {}),
    ...(fromFork ? { fromFork: true as const } : {}),
    // ponytail: display only (the tab count), so an odd value is left out rather than failing the overview.
    ...(Number.isSafeInteger(item.commits) && (item.commits as number) >= 0 ? { commits: item.commits as number } : {})
  }
}

const REVIEW_VERDICTS: Record<string, PullReviewVerdict> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed'
}

/** An issue comment or a submitted review. `undefined` = a PENDING review (skipped), `null` = malformed. */
function conversationItemFrom(value: unknown, kind: 'comment' | 'review'): PullConversationItem | null | undefined {
  const item = object(value)
  if (!item) return null
  if (kind === 'review' && item.state === 'PENDING') return undefined
  const at = kind === 'comment' ? item.created_at : item.submitted_at
  if (!positiveInteger(Number(item.id), Number.MAX_SAFE_INTEGER) || !isoDate(at) ||
      !(item.body === null || item.body === undefined || string(item.body, 262_144)) ||
      !string(item.html_url, 2_048)) return null
  let url: URL
  try { url = new URL(item.html_url) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  const author = item.user === null || item.user === undefined ? null : issueUser(item.user)
  if (item.user && !author) return null
  const base = { id: Number(item.id), author, body: item.body ?? '', at, url: url.toString() }
  if (kind === 'comment') return { kind, ...base }
  const verdict = typeof item.state === 'string' ? REVIEW_VERDICTS[item.state] : undefined
  return verdict ? { kind, ...base, verdict } : null
}

/** One review comment on a diff line. GitHub sends `line: null` (and `position: null`) once the line
 *  left the diff (outdated); a whole-file comment has no line either. `null` = malformed. */
function lineCommentFrom(value: unknown): PullLineComment | null {
  const item = object(value)
  if (!item || !positiveInteger(Number(item.id), Number.MAX_SAFE_INTEGER) || !isoDate(item.created_at) ||
      !string(item.body, 262_144) || !string(item.html_url, 2_048) || !isPullPath(item.path)) return null
  let url: URL
  try { url = new URL(item.html_url) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  const author = item.user === null || item.user === undefined ? null : issueUser(item.user)
  if (item.user && !author) return null
  // null = absent, undefined = present but not a positive id (malformed).
  const optionalId = (key: string): number | null | undefined => item[key] === null || item[key] === undefined ? null
    : positiveInteger(Number(item[key]), Number.MAX_SAFE_INTEGER) ? Number(item[key]) : undefined
  const reviewId = optionalId('pull_request_review_id')
  const inReplyTo = optionalId('in_reply_to_id')
  const line = optionalId('line')
  if (reviewId === undefined || inReplyTo === undefined || line === undefined) return null
  // ponytail: a comment from before GitHub had `side` sits on the head side, as it did then.
  const side = item.side === 'LEFT' ? 'LEFT' : 'RIGHT'
  return {
    id: Number(item.id), reviewId, ...(inReplyTo !== null ? { inReplyTo } : {}), author, body: item.body, at: item.created_at,
    url: url.toString(), path: item.path, side, line, outdated: line === null && item.subject_type !== 'file'
  }
}

const FILE_STATUSES: Record<string, PullFileStatus> = {
  added: 'added', modified: 'modified', removed: 'removed', renamed: 'renamed',
  copied: 'added', changed: 'modified', unchanged: 'modified'
}

/** The Files tab shows a file up to this size; past it the node says "cannot show this file". */
const MAX_FILE_BYTES = 1_048_576

/** A repository path as `GET /pulls/{n}/files` names it. No empty, `.` or `..` segment, so the URL
 *  built from it cannot leave the contents endpoint. */
function repoPath(value: unknown): value is string {
  return string(value, 4_096) && value.length > 0 && !value.includes('\u0000') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** One changed file. `copied` keeps no previous path: it diffs against empty, like an add. */
function pullFileFrom(value: unknown): PullFile | null {
  const item = object(value)
  const status = item && typeof item.status === 'string' && Object.hasOwn(FILE_STATUSES, item.status)
    ? FILE_STATUSES[item.status] : undefined
  if (!item || !status || !repoPath(item.filename) ||
      !Number.isSafeInteger(item.additions) || (item.additions as number) < 0 ||
      !Number.isSafeInteger(item.deletions) || (item.deletions as number) < 0) return null
  if (status === 'renamed' && !repoPath(item.previous_filename)) return null
  return {
    path: item.filename,
    ...(status === 'renamed' ? { previousPath: item.previous_filename as string } : {}),
    status,
    additions: item.additions as number,
    deletions: item.deletions as number
  }
}

/** GitHub grows this enum (`duplicate` arrived after the decoder was written, and one such issue
 *  failed the WHOLE scan as malformed, so that repository never synced). A value we do not know
 *  yet is read as "no reason" — the issue itself is perfectly valid. */
function stateReasonFrom(value: unknown): GitHubIssue['stateReason'] {
  return typeof value === 'string' && KNOWN_STATE_REASONS.has(value)
    ? value as GitHubIssue['stateReason']
    : null
}

function issueFrom(value: unknown): GitHubIssue | null {
  const item = object(value)
  if (!item || !positiveInteger(Number(item.id), Number.MAX_SAFE_INTEGER) ||
      !positiveInteger(Number(item.number), Number.MAX_SAFE_INTEGER) ||
      !string(item.title, 1_024) || !(item.body === null || string(item.body, 1_000_000)) ||
      (item.state !== 'open' && item.state !== 'closed') ||
      !(item.state_reason === null || item.state_reason === undefined || string(item.state_reason, 64)) ||
      !string(item.html_url, 2_048) || !string(item.url, 2_048) ||
      !Array.isArray(item.labels) || item.labels.length > 100 ||
      !Array.isArray(item.assignees) || item.assignees.length > 100 ||
      !isoDate(item.created_at) || !isoDate(item.updated_at) ||
      typeof item.locked !== 'boolean') return null
  const pull = pullFrom(item)
  if (pull === null) return null
  const labels = item.labels.map(issueLabel)
  const assignees = item.assignees.map(issueUser)
  if (labels.some((entry) => !entry) || assignees.some((entry) => !entry)) return null
  let html: URL
  let api: URL
  try {
    html = new URL(item.html_url)
    api = new URL(item.url)
  } catch {
    return null
  }
  if (html.protocol !== 'https:' || html.hostname !== 'github.com' ||
      api.origin !== API_ORIGIN) return null
  return {
    id: Number(item.id),
    number: Number(item.number),
    title: item.title,
    body: item.body ?? '',
    state: item.state,
    stateReason: stateReasonFrom(item.state_reason),
    htmlUrl: html.toString(),
    apiUrl: api.toString(),
    labels: labels as GitHubIssueLabel[],
    assignees: assignees as GitHubIssueUser[],
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    locked: item.locked,
    ...(pull ? { pull } : {})
  }
}

/** A reason only rides a state change, and only one that fits it: GitHub rewrites `state_reason` on
 *  any write carrying `state`, so a reason sent without one — or the wrong kind — is a caller bug. */
function validStateReason(input: UpdateIssueInput): boolean {
  if (input.stateReason === undefined) return true
  if (input.state === 'closed') return input.stateReason === 'completed' || input.stateReason === 'not_planned'
  if (input.state === 'open') return input.stateReason === 'reopened'
  return false
}

function nextPage(link: string | null): number | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    if (!/;\s*rel="next"\s*$/.test(part)) continue
    const match = part.match(/^\s*<([^>]+)>/)
    if (!match) continue
    try {
      const url = new URL(match[1])
      if (url.origin !== API_ORIGIN) return undefined
      const page = Number(url.searchParams.get('page'))
      return positiveInteger(page, 100_000) ? page : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

async function boundedErrorMetadata(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_ERROR_METADATA_BYTES) return ''
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_ERROR_METADATA_BYTES) {
      await reader.cancel()
      return ''
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const value = object(JSON.parse(new TextDecoder().decode(bytes)))
    const message = value && string(value.message, 2_048) ? value.message : ''
    const documentation = value && string(value.documentation_url, 2_048)
      ? value.documentation_url
      : ''
    // A 422 names its cause in `errors` (strings, or objects with a `message`).
    const errors = value && Array.isArray(value.errors)
      ? value.errors.slice(0, 10).map((item) => typeof item === 'string' ? item : object(item)?.message)
        .filter((item): item is string => typeof item === 'string')
      : []
    return [message, documentation, ...errors].join('\n').toLocaleLowerCase('en-US')
  } catch {
    return ''
  }
}

export class GitHubIssuesClient {
  private readonly fetcher: typeof fetch
  private readonly maximum: number
  private readonly timeoutMs: number
  private secondaryBackoffMs = 1_000

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch
    this.maximum = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  /** `GET /user`, conditional on `etag`. A 304 means the identity behind this token is unchanged —
   *  and it is free; a token GitHub no longer accepts is still refused (401) whatever the condition. */
  async checkAuthenticatedUser(etag?: string): Promise<
    | { notModified: true }
    | { notModified: false; identity: { userId: string; login: string }; etag?: string }
  > {
    if (etag !== undefined && !string(etag, 512)) throw new GitHubClientError('invalid-request')
    const response = await this.request('/user', {
      method: 'GET', ...(etag ? { headers: { 'if-none-match': etag } } : {})
    })
    if (response.status === 304) return { notModified: true }
    const identity = await this.userFrom(response)
    const fresh = response.headers.get('etag')
    return { notModified: false, identity, ...(fresh && string(fresh, 512) ? { etag: fresh } : {}) }
  }

  private async userFrom(response: Response): Promise<{ userId: string; login: string }> {
    const value = object(await this.json(response))
    if (!value || !positiveInteger(Number(value.id), Number.MAX_SAFE_INTEGER) ||
        !string(value.login, 128) || !value.login) {
      throw new GitHubClientError('malformed-response')
    }
    return { userId: String(value.id), login: value.login }
  }

  async listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult> {
    safeRepository(repository)
    if (!positiveInteger(options.page, 100_000) || !positiveInteger(options.perPage, 100) ||
        !['open', 'closed', 'all'].includes(options.state)) throw new GitHubClientError('invalid-request')
    const query = new URLSearchParams({
      state: options.state,
      page: String(options.page),
      per_page: String(options.perPage)
    })
    if (options.since) {
      if (!isoDate(options.since)) throw new GitHubClientError('invalid-request')
      query.set('since', options.since)
    }
    if (options.labels !== undefined) {
      // Label names are `,`-joined by the API, so one containing a comma cannot be expressed here.
      // Refuse rather than silently query for two labels that do not exist and get an empty page —
      // which the dedupe lookup would read as "nothing upstream" and answer by filing a duplicate.
      if (!string(options.labels, 1_000) || !options.labels.trim()) {
        throw new GitHubClientError('invalid-request')
      }
      query.set('labels', options.labels)
    }
    const response = await this.request(`/repos/${repository}/issues?${query}`, {
      method: 'GET',
      ...(options.etag ? { headers: { 'if-none-match': options.etag } } : {})
    })
    if (response.status === 304) return { items: [], notModified: true, etag: options.etag }
    const value = await this.json(response)
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    const items: GitHubIssue[] = []
    // Pull requests arrive on this endpoint too, and they are kept: their bytes are already
    // fetched, and harvesting them here is what gives the board's pull lane the incremental
    // `since` watermark, ETags and cache the issue lane has. `/repos/{repo}/pulls` ignores
    // `since` entirely, so a separate scan could not reuse any of it.
    for (const candidate of value) {
      const decoded = issueFrom(candidate)
      if (!decoded) throw new GitHubClientError('malformed-response')
      items.push(decoded)
    }
    return {
      items,
      ...(nextPage(response.headers.get('link')) ? { nextPage: nextPage(response.headers.get('link')) } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {})
    }
  }

  /**
   * One conditional request that answers "did anything in this repository change since `etag`?".
   *
   * It asks for the single most recently updated item with `If-None-Match`. GitHub answers an
   * unchanged repository with 304, and a 304 does not count against the rate limit (measured
   * 2026-09-28: twenty 304s moved `x-ratelimit-used` by zero, one 200 moved it by one). The
   * incremental scan cannot do this on its own: its `since` moves every pass, so its URL — and
   * therefore any ETag it could present — never repeats.
   *
   * `state=all` + `sort=updated` is the same endpoint and the same `updated_at` the `since` scan
   * filters on, pull requests included, so any change the scan would pick up moves the top item
   * and with it this ETag. The body is drained but not decoded: only the validator matters.
   */
  async issuesHeartbeat(repository: string, etag?: string): Promise<IssueHeartbeatResult> {
    safeRepository(repository)
    if (etag !== undefined && !string(etag, 512)) throw new GitHubClientError('invalid-request')
    const response = await this.request(
      `/repos/${repository}/issues?state=all&sort=updated&direction=desc&per_page=1`,
      { method: 'GET', ...(etag ? { headers: { 'if-none-match': etag } } : {}) }
    )
    if (response.status === 304) return { notModified: true, ...(etag ? { etag } : {}) }
    await this.json(response)
    const fresh = response.headers.get('etag')
    return { notModified: false, ...(fresh && string(fresh, 512) ? { etag: fresh } : {}) }
  }

  async getIssue(repository: string, issueNumber: number): Promise<GitHubIssue> {
    safeRepository(repository)
    if (!positiveInteger(issueNumber, Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('invalid-request')
    const value = await this.json(await this.request(`/repos/${repository}/issues/${issueNumber}`, { method: 'GET' }))
    if (object(value)?.pull_request !== undefined) throw new GitHubClientError('invalid-request')
    const decoded = issueFrom(value)
    if (!decoded) throw new GitHubClientError('malformed-response')
    return decoded
  }

  async updateIssue(
    repository: string,
    issueNumber: number,
    input: UpdateIssueInput
  ): Promise<GitHubIssue> {
    safeRepository(repository)
    if (!positiveInteger(issueNumber, Number.MAX_SAFE_INTEGER) ||
        (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') ||
        !validStateReason(input) ||
        (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.length > 100 ||
          input.labels.some((label) => !string(label, 50) || !label.trim())))) {
      throw new GitHubClientError('invalid-request')
    }
    const body = {
      ...(input.state ? { state: input.state } : {}),
      ...(input.stateReason ? { state_reason: input.stateReason } : {}),
      ...(input.labels ? { labels: input.labels } : {})
    }
    const response = await this.request(`/repos/${repository}/issues/${issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
    const decoded = issueFrom(await this.json(response))
    if (!decoded) throw new GitHubClientError('malformed-response')
    return decoded
  }

  /**
   * Open a new issue. Bounds mirror GitHub's own: a 256-character title and a body the report
   * composer has already clamped far below the API's 65 536.
   *
   * A 403 here is the one a caller must not paper over: a token with `issues: read` lists and gets
   * issues perfectly and fails only at the write, so the feature looks configured right up to the
   * moment it matters. `request()` already classifies a non-rate-limit 403 as
   * `insufficient-permission`; the report service turns that code into the sentence naming the
   * missing scope.
   */
  async createIssue(repository: string, input: CreateIssueInput): Promise<GitHubIssue> {
    safeRepository(repository)
    if (!string(input.title, 256) || !input.title.trim() || !string(input.body, 60_000) ||
        (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.length > 100 ||
          input.labels.some((label) => !string(label, 50) || !label.trim())))) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        ...(input.labels?.length ? { labels: input.labels } : {})
      })
    })
    const decoded = issueFrom(await this.json(response))
    if (!decoded) throw new GitHubClientError('malformed-response')
    return decoded
  }

  /** Comment on an existing issue. Returns the comment id; the caller only needs "it landed". */
  async createIssueComment(
    repository: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number }> {
    safeRepository(repository)
    if (!positiveInteger(issueNumber, Number.MAX_SAFE_INTEGER) || !string(body, 60_000) ||
        !body.trim()) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body })
    })
    const value = object(await this.json(response))
    if (!value || !positiveInteger(Number(value.id), Number.MAX_SAFE_INTEGER)) {
      throw new GitHubClientError('malformed-response')
    }
    return { id: Number(value.id) }
  }

  /**
   * Every open pull request's head, CI rollup, mergeability and closing issues, plus the recently
   * merged/closed ones — one GraphQL read (see graphql-pulls.ts for the measured cost). A field the
   * token may not read comes back as `access: false`, not as an empty value.
   */
  async pullRequestStatuses(repository: string): Promise<PullStatusRead> {
    const [owner, name] = safeRepository(repository).split('/')
    const body = await this.graphql(PULL_STATUS_QUERY, { owner, name })
    try {
      return parsePullStatusResponse(body, repository)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** One pull request's overview (`GET /pulls/{n}`), read when its node mounts or refreshes. */
  async getPull(repository: string, pullNumber: number): Promise<GitHubPullDetail> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const value = await this.json(await this.request(`/repos/${repository}/pulls/${pullNumber}`, { method: 'GET' }))
    const decoded = pullDetailFrom(value)
    if (!decoded) throw new GitHubClientError('malformed-response')
    return decoded
  }

  /** Submit one review (`POST /pulls/{n}/reviews`) against `commitId`, the head the user saw, so
   *  GitHub ties it to that commit. An empty body is left out (an approval needs none). */
  async reviewPull(
    repository: string,
    pullNumber: number,
    review: { event: PullReviewEvent; body: string; commitId: string; comments?: PullLineDraft[] }
  ): Promise<{ id: number }> {
    safeRepository(repository)
    const comments = review?.comments ?? []
    if (!positiveInteger(pullNumber, 2_147_483_647) || !REVIEW_EVENTS.has(review?.event) ||
        typeof review.commitId !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(review.commitId) ||
        typeof review.body !== 'string' || review.body.length > 60_000 ||
        !Array.isArray(comments) || comments.length > MAX_PULL_REVIEW_COMMENTS || !comments.every(isPullLineDraft)) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        event: review.event, ...(review.body.trim() ? { body: review.body } : {}), commit_id: review.commitId,
        ...(comments.length
          ? { comments: comments.map(({ path, line, side, body }) => ({ path, line, side, body })) }
          : {})
      })
    })
    const value = object(await this.json(response))
    if (!value || !positiveInteger(Number(value.id), Number.MAX_SAFE_INTEGER)) {
      throw new GitHubClientError('malformed-response')
    }
    return { id: Number(value.id) }
  }

  /** The merge methods the repository allows, and whether it allows auto-merge (`GET /repos/{r}`).
   *  GitHub sends the `allow_*` flags only to a token that may push; without them nothing is offered. */
  async repoMergeMethods(repository: string): Promise<{ methods: PullMergeMethod[]; autoMerge: boolean }> {
    const value = object(await this.json(await this.request(`/repos/${safeRepository(repository)}`, { method: 'GET' })))
    if (!value) throw new GitHubClientError('malformed-response')
    return {
      methods: MERGE_METHODS.filter(([, flag]) => value[flag] === true).map(([method]) => method),
      autoMerge: value.allow_auto_merge === true
    }
  }

  /** The people with access to the repository (`GET /collaborators`), first page of 100. */
  async listCollaborators(repository: string): Promise<GitHubIssueUser[]> {
    const value = await this.json(await this.request(`/repos/${safeRepository(repository)}/collaborators?per_page=100`, { method: 'GET' }))
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    return value.flatMap((user) => issueUser(user) ?? [])
  }

  /** Ask one user to review a PR (`POST /pulls/{n}/requested_reviewers`). */
  async requestPullReviewer(repository: string, pullNumber: number, login: string): Promise<void> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || !GITHUB_LOGIN.test(login)) {
      throw new GitHubClientError('invalid-request')
    }
    await this.request(`/repos/${repository}/pulls/${pullNumber}/requested_reviewers`, {
      method: 'POST', body: JSON.stringify({ reviewers: [login] })
    })
  }

  /** Add or remove one label, by name, on the PR's issue (`POST` / `DELETE /issues/{n}/labels`). */
  async setPullLabel(repository: string, pullNumber: number, label: string, add: boolean): Promise<void> {
    safeRepository(repository)
    // `.` and `..` would resolve as path segments in the DELETE URL.
    if (!positiveInteger(pullNumber, 2_147_483_647) || !string(label, 50) || !label.trim() || /^\.{1,2}$/.test(label) ||
        typeof add !== 'boolean') {
      throw new GitHubClientError('invalid-request')
    }
    const path = `/repos/${repository}/issues/${pullNumber}/labels`
    await this.request(add ? path : `${path}/${encodeURIComponent(label)}`,
      add ? { method: 'POST', body: JSON.stringify({ labels: [label] }) } : { method: 'DELETE' })
  }

  /** Add or remove one assignee, by login, on the PR's issue (`POST` / `DELETE /issues/{n}/assignees`). */
  async setPullAssignee(repository: string, pullNumber: number, login: string, add: boolean): Promise<void> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || !GITHUB_LOGIN.test(login) || typeof add !== 'boolean') {
      throw new GitHubClientError('invalid-request')
    }
    await this.request(`/repos/${repository}/issues/${pullNumber}/assignees`, {
      method: add ? 'POST' : 'DELETE', body: JSON.stringify({ assignees: [login] })
    })
  }

  /** Close (`open` false) or reopen the PR (`PATCH /pulls/{n}`). */
  async setPullState(repository: string, pullNumber: number, open: boolean): Promise<void> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || typeof open !== 'boolean') throw new GitHubClientError('invalid-request')
    await this.request(`/repos/${repository}/pulls/${pullNumber}`, {
      method: 'PATCH', body: JSON.stringify({ state: open ? 'open' : 'closed' })
    })
  }

  /** Mark a draft PR ready for review (GraphQL `markPullRequestReadyForReview`). */
  async markPullReady(repository: string, pullNumber: number): Promise<void> {
    const id = await this.pullNodeId(repository, pullNumber)
    await this.graphqlWrite(
      'mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ clientMutationId } }', { id })
  }

  /** Delete one branch of this repository (`DELETE /git/refs/heads/{branch}`). The caller decides it may go. */
  async deleteBranchRef(repository: string, branch: string): Promise<void> {
    safeRepository(repository)
    if (!isPullBranchName(branch)) throw new GitHubClientError('invalid-request')
    await this.request(`/repos/${repository}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' })
  }

  /** Open a pull request (`POST /pulls`) from `head`, a branch of this repository, into `base`. */
  async createPull(repository: string, pull: PullCreateDraft): Promise<{ number: number }> {
    safeRepository(repository)
    if (!isPullCreateDraft(pull)) throw new GitHubClientError('invalid-request')
    const { head, base, title, body, draft } = pull
    const value = object(await this.json(await this.request(`/repos/${repository}/pulls`, {
      method: 'POST', body: JSON.stringify({ head, base, title, body, draft })
    })))
    if (!value || !positiveInteger(Number(value.number), 2_147_483_647)) throw new GitHubClientError('malformed-response')
    return { number: Number(value.number) }
  }

  /** "New pull request"'s start: the default branch (`GET /repos/{r}`) and the open PR whose head is
   *  `head` on this repository (`GET /pulls?head=owner:head`), if there is one. */
  async pullForBranch(repository: string, head: string): Promise<{ defaultBranch: string; existing?: number }> {
    const [owner] = safeRepository(repository).split('/')
    if (!isPullBranchName(head)) throw new GitHubClientError('invalid-request')
    const repo = object(await this.json(await this.request(`/repos/${repository}`, { method: 'GET' })))
    if (!repo || !isPullBranchName(repo.default_branch)) throw new GitHubClientError('malformed-response')
    const query = new URLSearchParams({ head: `${owner}:${head}`, state: 'open', per_page: '1' })
    const pulls = await this.json(await this.request(`/repos/${repository}/pulls?${query}`, { method: 'GET' }))
    if (!Array.isArray(pulls) || pulls.length > 1) throw new GitHubClientError('malformed-response')
    const existing = Number(object(pulls[0])?.number)
    return { defaultBranch: repo.default_branch, ...(positiveInteger(existing, 2_147_483_647) ? { existing } : {}) }
  }

  /** Merge a PR (`PUT /pulls/{n}/merge`) only if its head is still `sha`, the commit the user saw:
   *  GitHub answers 409 when the head moved and 405 when the PR cannot merge. */
  async mergePull(repository: string, pullNumber: number, merge: { method: PullMergeMethod; sha: string }): Promise<void> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || !MERGE_METHODS.some(([method]) => method === merge?.method) ||
        typeof merge.sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(merge.sha)) {
      throw new GitHubClientError('invalid-request')
    }
    // ponytail: a 2xx is the merge; its body (the merge commit) is not needed by anyone.
    await this.request(`/repos/${repository}/pulls/${pullNumber}/merge`, {
      method: 'PUT', body: JSON.stringify({ merge_method: merge.method, sha: merge.sha })
    })
  }

  /** "Update branch" (`PUT /pulls/{n}/update-branch`): merge the base into the head, only if the
   *  head is still `sha`, the commit the user saw. GitHub answers 202 and does it in the background. */
  async updatePullBranch(repository: string, pullNumber: number, sha: string): Promise<void> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || typeof sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new GitHubClientError('invalid-request')
    }
    await this.request(`/repos/${repository}/pulls/${pullNumber}/update-branch`, {
      method: 'PUT', body: JSON.stringify({ expected_head_sha: sha })
    })
  }

  /** "Merge when ready": GitHub's auto-merge (GraphQL `enablePullRequestAutoMerge`) with `method`,
   *  only if the head is still `sha` (`expectedHeadOid`), the commit the user saw. */
  async enablePullAutoMerge(repository: string, pullNumber: number, merge: { method: PullMergeMethod; sha: string }): Promise<void> {
    if (!MERGE_METHODS.some(([method]) => method === merge?.method) ||
        typeof merge.sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(merge.sha)) {
      throw new GitHubClientError('invalid-request')
    }
    const id = await this.pullNodeId(repository, pullNumber)
    await this.graphqlWrite(
      'mutation($id:ID!,$method:PullRequestMergeMethod!,$sha:GitObjectID!){ enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method,expectedHeadOid:$sha}){ clientMutationId } }',
      { id, method: merge.method.toUpperCase(), sha: merge.sha })
  }

  /** Cancel "Merge when ready" (GraphQL `disablePullRequestAutoMerge`). */
  async disablePullAutoMerge(repository: string, pullNumber: number): Promise<void> {
    const id = await this.pullNodeId(repository, pullNumber)
    await this.graphqlWrite(
      'mutation($id:ID!){ disablePullRequestAutoMerge(input:{pullRequestId:$id}){ clientMutationId } }', { id })
  }

  /** The signed-in user's "Viewed" mark per changed file (GraphQL `files.viewerViewedState`), at
   *  most `MAX_VIEWED_PAGES` pages of 100, the same 300 files the Files tab lists. */
  async pullViewedStates(repository: string, pullNumber: number): Promise<Record<string, PullViewedState>> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const states: Record<string, PullViewedState> = {}
    let after: string | undefined
    for (let read = 0; read < MAX_VIEWED_PAGES; read += 1) {
      const body = await this.graphql(PULL_VIEWED_QUERY, { owner, name, number: pullNumber, ...(after ? { after } : {}) })
      const files = object(object(object(object(object(body)?.data)?.repository)?.pullRequest)?.files)
      const nodes = files?.nodes
      const info = object(files?.pageInfo)
      if (!Array.isArray(nodes) || !info) throw new GitHubClientError('malformed-response')
      for (const node of nodes) {
        const { path, viewerViewedState: state } = object(node) ?? {}
        if (!isPullPath(path) || (state !== 'VIEWED' && state !== 'UNVIEWED' && state !== 'DISMISSED')) {
          throw new GitHubClientError('malformed-response')
        }
        states[path] = state
      }
      if (info.hasNextPage !== true) break
      if (!string(info.endCursor, 1_024) || !info.endCursor) throw new GitHubClientError('malformed-response')
      after = info.endCursor
    }
    return states
  }

  /** Tick or clear GitHub's own "Viewed" mark on one file (GraphQL `markFileAsViewed` /
   *  `unmarkFileAsViewed`), as the signed-in user. */
  async setFileViewed(repository: string, pullNumber: number, path: string, viewed: boolean): Promise<void> {
    if (!isPullPath(path) || typeof viewed !== 'boolean') throw new GitHubClientError('invalid-request')
    const id = await this.pullNodeId(repository, pullNumber)
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
    await this.graphqlWrite(
      `mutation($id:ID!,$path:String!){ ${mutation}(input:{pullRequestId:$id,path:$path}){ clientMutationId } }`, { id, path })
  }

  /** Resolve or unresolve the review thread whose first comment is `threadId` (GraphQL
   *  `resolveReviewThread` / `unresolveReviewThread`). The thread's GraphQL id is looked up here,
   *  never taken from a caller. ponytail: the first 100 threads, the same cap the resolved read has. */
  async setReviewThreadResolved(repository: string, pullNumber: number, threadId: number, resolved: boolean): Promise<void> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647) || !positiveInteger(threadId, Number.MAX_SAFE_INTEGER) ||
        typeof resolved !== 'boolean') throw new GitHubClientError('invalid-request')
    const body = await this.graphql(PULL_THREAD_IDS_QUERY, { owner, name, number: pullNumber })
    const nodes = object(object(object(object(object(body)?.data)?.repository)?.pullRequest)?.reviewThreads)?.nodes
    if (graphQLErrors(body).length || !Array.isArray(nodes)) throw new GitHubClientError('malformed-response')
    const thread = nodes.map(object).find((node) => {
      const comments = object(node?.comments)?.nodes
      return Array.isArray(comments) && object(comments[0])?.databaseId === threadId
    })
    const id = thread?.id
    // No such thread on this PR: GitHub would refuse it too.
    if (!string(id, 256) || !id) throw new GitHubClientError('request-failed', 422)
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
    await this.graphqlWrite(`mutation($id:ID!){ ${mutation}(input:{threadId:$id}){ thread{ id } } }`, { id })
  }

  /** One review comment as "Apply suggestion" needs it (`GET /pulls/comments/{id}`). */
  async pullSuggestionComment(repository: string, commentId: number): Promise<PullSuggestionComment> {
    safeRepository(repository)
    if (!positiveInteger(commentId, Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('invalid-request')
    const item = object(await this.json(await this.request(`/repos/${repository}/pulls/comments/${commentId}`, { method: 'GET' })))
    const pullNumber = Number(/\/pulls\/(\d+)$/.exec(string(item?.pull_request_url, 2_048) ? item!.pull_request_url as string : '')?.[1])
    const lineOf = (value: unknown): number | null | undefined =>
      value === null || value === undefined ? null : positiveInteger(Number(value), 1_000_000) ? Number(value) : undefined
    const line = lineOf(item?.line)
    const startLine = lineOf(item?.start_line)
    if (!item || !positiveInteger(pullNumber, 2_147_483_647) || !isPullPath(item.path) || !string(item.body, 262_144) ||
        !isCommitSha(item.commit_id) ||
        line === undefined || startLine === undefined) throw new GitHubClientError('malformed-response')
    const login = object(item.user)?.login
    return {
      pullNumber, path: item.path, side: item.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      startSide: item.start_side === 'LEFT' ? 'LEFT' : 'RIGHT',
      line, startLine, commitId: item.commit_id,
      body: item.body, author: typeof login === 'string' && GITHUB_LOGIN.test(login) ? login : null
    }
  }

  /** One text file at one commit with its blob SHA (`GET /contents/{path}?ref=`), for a commit
   *  pinned to that SHA. A file the contents API sends no text for (binary, over 1 MB) is refused. */
  async fileBlobAt(repository: string, path: string, ref: string): Promise<{ sha: string; text: string }> {
    safeRepository(repository)
    if (!repoPath(path) || !isCommitSha(ref)) throw new GitHubClientError('invalid-request')
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const item = object(await this.json(await this.request(`/repos/${repository}/contents/${encoded}?ref=${ref}`, { method: 'GET' })))
    if (!item || !isCommitSha(item.sha)) throw new GitHubClientError('malformed-response')
    if (item.type !== 'file' || item.encoding !== 'base64' || typeof item.content !== 'string') {
      throw new GitHubClientError('request-failed', 422)
    }
    try {
      return { sha: item.sha, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(item.content, 'base64')) }
    } catch {
      throw new GitHubClientError('request-failed', 422)
    }
  }

  /** Commit one file to `branch` (`PUT /contents/{path}`), only if its blob is still `sha`: GitHub
   *  answers 409 when the file changed. */
  async putFile(repository: string, file: { path: string; branch: string; sha: string; text: string; message: string }): Promise<void> {
    safeRepository(repository)
    if (!repoPath(file?.path) || !isPullBranchName(file.branch) || !isCommitSha(file.sha) ||
        typeof file.text !== 'string' || !string(file.message, 1_024) || !file.message) throw new GitHubClientError('invalid-request')
    const encoded = file.path.split('/').map(encodeURIComponent).join('/')
    // ponytail: a 2xx is the commit; its body (the new blob and commit) is not needed by anyone.
    await this.request(`/repos/${repository}/contents/${encoded}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: file.message, content: Buffer.from(file.text, 'utf8').toString('base64'), sha: file.sha, branch: file.branch
      })
    })
  }

  /** The PR's GraphQL id, looked up here from the repository and number (never taken from a caller). */
  private async pullNodeId(repository: string, pullNumber: number): Promise<string> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const body = await this.graphqlWrite(
      'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ id } } }',
      { owner, name, number: pullNumber })
    const id = object(object(object(object(body)?.data)?.repository)?.pullRequest)?.id
    if (!string(id, 256) || !id) throw new GitHubClientError('malformed-response')
    return id
  }

  /** A GraphQL call whose refusal arrives as `errors` in a 200: a permission refusal reads as a 403,
   *  a missing object as a 404 and anything else as a 422, so the write maps it like a REST one.
   *  ponytail: GitHub's message (auto-merge not allowed, PR already clean) is not kept. */
  private async graphqlWrite(query: string, variables: Record<string, string | number>): Promise<unknown> {
    const body = await this.graphql(query, variables)
    const errors = graphQLErrors(body)
    if (errors.some((error) => error.type === 'FORBIDDEN' || error.type === 'INSUFFICIENT_SCOPES')) {
      throw new GitHubClientError('request-failed', 403)
    }
    if (errors.some((error) => error.type === 'NOT_FOUND')) throw new GitHubClientError('request-failed', 404)
    if (errors.length) throw new GitHubClientError('request-failed', 422)
    return body
  }

  /** One page of a PR's changed files (`GET /pulls/{n}/files`), for the Files tab. */
  async listPullFiles(repository: string, pullNumber: number, page: number): Promise<PullFilesPage> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || !positiveInteger(page, 100_000)) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`, { method: 'GET' })
    const value = await this.json(response)
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    const files = value.map(pullFileFrom)
    if (files.some((file) => !file)) throw new GitHubClientError('malformed-response')
    const next = nextPage(response.headers.get('link'))
    return { files: files as PullFile[], ...(next ? { nextPage: next } : {}) }
  }

  /** The merge base of two commits (`GET /compare/{base}...{head}`, `merge_base_commit.sha`): the
   *  commit GitHub diffs a pull request against. */
  async mergeBase(repository: string, base: string, head: string): Promise<string> {
    safeRepository(repository)
    const commit = /^[0-9a-f]{40}([0-9a-f]{24})?$/
    if (typeof base !== 'string' || !commit.test(base) || typeof head !== 'string' || !commit.test(head)) {
      throw new GitHubClientError('invalid-request')
    }
    // ponytail: page 2 of 1 commit carries merge_base_commit but no file list (measured on cli/cli),
    // so a big comparison stays far under the response cap.
    const item = object(await this.json(await this.request(
      `/repos/${repository}/compare/${base}...${head}?per_page=1&page=2`, { method: 'GET' })))
    const sha = object(item?.merge_base_commit)?.sha
    if (typeof sha !== 'string' || !commit.test(sha)) throw new GitHubClientError('malformed-response')
    return sha
  }

  /** One file at one commit (`GET /contents/{path}?ref=`). Over 1 MB, or not UTF-8 text, answers
   *  `unavailable` instead of content. */
  async getFileAt(repository: string, path: string, ref: string): Promise<PullFileRead> {
    safeRepository(repository)
    if (!repoPath(path) || typeof ref !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(ref)) {
      throw new GitHubClientError('invalid-request')
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const item = object(await this.json(await this.request(`/repos/${repository}/contents/${encoded}?ref=${ref}`, { method: 'GET' })))
    if (!item || !Number.isSafeInteger(item.size) || (item.size as number) < 0) throw new GitHubClientError('malformed-response')
    if ((item.size as number) > MAX_FILE_BYTES) return { kind: 'unavailable', reason: 'too-large' }
    // ponytail: a symlink or submodule entry has no text to diff; it reads as binary.
    if (item.type !== 'file' || item.encoding !== 'base64' || typeof item.content !== 'string') {
      return { kind: 'unavailable', reason: 'binary' }
    }
    const bytes = Buffer.from(item.content, 'base64')
    if (bytes.length > MAX_FILE_BYTES) return { kind: 'unavailable', reason: 'too-large' }
    if (bytes.includes(0)) return { kind: 'unavailable', reason: 'binary' }
    try {
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return { kind: 'unavailable', reason: 'binary' }
    }
  }

  /** One page of a PR's review comments on diff lines (`GET /pulls/{n}/comments`), oldest first. */
  async listPullLineComments(repository: string, pullNumber: number, page: number): Promise<PullLineCommentsPage> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || !positiveInteger(page, 100_000)) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/pulls/${pullNumber}/comments?per_page=100&page=${page}`, { method: 'GET' })
    const value = await this.json(response)
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    const comments = value.map(lineCommentFrom)
    if (comments.includes(null)) throw new GitHubClientError('malformed-response')
    const next = nextPage(response.headers.get('link'))
    return { comments: comments as PullLineComment[], ...(next ? { nextPage: next } : {}) }
  }

  /** Post one line comment (`POST /pulls/{n}/comments`): a new thread on `commitId`, the head the
   *  user saw, or a reply (`in_reply_to`, where GitHub ignores every field but the body). */
  async createPullLineComment(
    repository: string,
    pullNumber: number,
    comment: PullLineCommentWrite
  ): Promise<{ id: number }> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    let body: Record<string, unknown>
    if ('inReplyTo' in comment) {
      if (!positiveInteger(comment.inReplyTo, Number.MAX_SAFE_INTEGER) || !isPullCommentBody(comment.body)) {
        throw new GitHubClientError('invalid-request')
      }
      body = { body: comment.body, in_reply_to: comment.inReplyTo }
    } else {
      if (typeof comment?.commitId !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(comment.commitId) ||
          !isPullLineDraft(comment.draft)) throw new GitHubClientError('invalid-request')
      const { path, line, side, body: text } = comment.draft
      body = { body: text, commit_id: comment.commitId, path, line, side }
    }
    const value = object(await this.json(await this.request(`/repos/${repository}/pulls/${pullNumber}/comments`, {
      method: 'POST', body: JSON.stringify(body)
    })))
    if (!value || !positiveInteger(Number(value.id), Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('malformed-response')
    return { id: Number(value.id) }
  }

  /** One page of a PR's issue comments (`GET /issues/{n}/comments`), for the Conversation tab. */
  async listPullComments(repository: string, pullNumber: number, page: number): Promise<PullConversationPage> {
    return this.conversationPage(`/repos/${safeRepository(repository)}/issues/${pullNumber}/comments`, pullNumber, page, 'comment')
  }

  /** One page of a PR's submitted reviews (`GET /pulls/{n}/reviews`), each with its verdict. */
  async listPullReviews(repository: string, pullNumber: number, page: number): Promise<PullConversationPage> {
    return this.conversationPage(`/repos/${safeRepository(repository)}/pulls/${pullNumber}/reviews`, pullNumber, page, 'review')
  }

  private async conversationPage(
    path: string, pullNumber: number, page: number, kind: 'comment' | 'review'
  ): Promise<PullConversationPage> {
    if (!positiveInteger(pullNumber, 2_147_483_647) || !positiveInteger(page, 100_000)) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`${path}?per_page=100&page=${page}`, { method: 'GET' })
    const value = await this.json(response)
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    const items: PullConversationItem[] = []
    for (const candidate of value) {
      const decoded = conversationItemFrom(candidate, kind)
      if (decoded === null) throw new GitHubClientError('malformed-response')
      if (decoded) items.push(decoded)
    }
    const next = nextPage(response.headers.get('link'))
    return { items, ...(next ? { nextPage: next } : {}) }
  }

  /** Per-check detail for one PR — read only when someone opens that PR. */
  async pullRequestChecks(repository: string, pullNumber: number): Promise<GitHubPullChecksResult> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const body = await this.graphql(PULL_CHECKS_QUERY, { owner, name, number: pullNumber })
    try {
      return parsePullChecksResponse(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** The first comment id of each resolved review thread of one PR (graphql-pulls.ts). */
  async pullResolvedThreads(repository: string, pullNumber: number): Promise<number[]> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const body = await this.graphql(PULL_RESOLVED_THREADS_QUERY, { owner, name, number: pullNumber })
    try {
      return parsePullResolvedThreads(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** The pull node sidebar's people, labels and closing issues: one GraphQL read (graphql-pull-sidebar.ts). */
  async pullSidebar(repository: string, pullNumber: number): Promise<PullSidebarRead> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const body = await this.graphql(PULL_SIDEBAR_QUERY, { owner, name, number: pullNumber })
    try {
      return parsePullSidebar(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** One page of a PR's commits, oldest first (graphql-pull-commits.ts). `after` = the cursor of the
   *  page before; absent = the first page. */
  async listPullCommits(repository: string, pullNumber: number, after?: string): Promise<PullCommitsPage> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647) || (after !== undefined && !string(after, 1_024))) {
      throw new GitHubClientError('invalid-request')
    }
    const body = await this.graphql(PULL_COMMITS_QUERY, { owner, name, number: pullNumber, ...(after ? { after } : {}) })
    try {
      return parsePullCommits(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** One page of a PR's Conversation timeline (graphql-pull-timeline.ts); `after` = the cursor. */
  async pullTimeline(repository: string, pullNumber: number, after?: string): Promise<PullTimelinePage> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647) || (after !== undefined && !isPullTimelineCursor(after))) {
      throw new GitHubClientError('invalid-request')
    }
    const body = await this.graphql(PULL_TIMELINE_QUERY, { owner, name, number: pullNumber, ...(after ? { after } : {}) })
    try {
      return parsePullTimelineResponse(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** One page of an issue's timeline (graphql-issue-timeline.ts); `after` = the cursor. */
  async issueTimeline(repository: string, issueNumber: number, after?: string): Promise<PullTimelinePage> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(issueNumber, 2_147_483_647) || (after !== undefined && !isPullTimelineCursor(after))) {
      throw new GitHubClientError('invalid-request')
    }
    const body = await this.graphql(ISSUE_TIMELINE_QUERY, { owner, name, number: issueNumber, ...(after ? { after } : {}) })
    try {
      return parseIssueTimelineResponse(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** One page of one commit's changed files and its first parent (`GET /commits/{sha}`), for a
   *  commit's own diff in the Commits tab. */
  async getCommitFiles(repository: string, sha: string, page: number): Promise<PullCommitFilesPage> {
    safeRepository(repository)
    if (!isCommitSha(sha) || !positiveInteger(page, 100_000)) throw new GitHubClientError('invalid-request')
    const response = await this.request(`/repos/${repository}/commits/${sha}?per_page=100&page=${page}`, { method: 'GET' })
    const item = object(await this.json(response))
    if (!item || !Array.isArray(item.files) || item.files.length > 100 || !Array.isArray(item.parents)) {
      throw new GitHubClientError('malformed-response')
    }
    const files = item.files.map(pullFileFrom)
    if (files.some((file) => !file)) throw new GitHubClientError('malformed-response')
    const parent = object(item.parents[0])?.sha
    if (item.parents.length && !isCommitSha(parent)) throw new GitHubClientError('malformed-response')
    const next = nextPage(response.headers.get('link'))
    return { files: files as PullFile[], ...(isCommitSha(parent) ? { parent } : {}), ...(next ? { nextPage: next } : {}) }
  }

  /** The failing step's last lines of one Actions job (`GET /actions/jobs/{id}/logs`, a 302 to a
   *  signed log URL that is fetched without the token). Only the log's last `MAX_JOB_LOG_TAIL` bytes are kept. */
  async jobLogTail(repository: string, jobId: number): Promise<string[]> {
    safeRepository(repository)
    if (!positiveInteger(jobId, Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('invalid-request')
    const redirect = await this.request(`/repos/${repository}/actions/jobs/${jobId}/logs`, { method: 'GET' }, true)
    const location = redirect.headers.get('location')
    let url: URL
    try { url = new URL(location ?? '') } catch { throw new GitHubClientError('malformed-response') }
    if (url.protocol !== 'https:') throw new GitHubClientError('malformed-response')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url, { redirect: 'error', signal: controller.signal })
      if (!response.ok || !response.body) throw new GitHubClientError('request-failed', response.status)
      // ponytail: a huge log is read to its end but only the tail is held; the cut may split the first line.
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let held = 0
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        chunks.push(next.value)
        held += next.value.byteLength
        while (held - chunks[0].byteLength >= MAX_JOB_LOG_TAIL) held -= chunks.shift()!.byteLength
      }
      return failingStepTail(new TextDecoder().decode(Buffer.concat(chunks)), CHECK_LOG_LINES)
    } catch (error) {
      throw error instanceof GitHubClientError ? error : new GitHubClientError('request-failed')
    } finally {
      clearTimeout(timer)
    }
  }

  /** "Re-run failed" (`POST /actions/runs/{id}/rerun-failed-jobs`): GitHub re-runs the run's failed jobs. */
  async rerunFailedJobs(repository: string, runId: number): Promise<void> {
    safeRepository(repository)
    if (!positiveInteger(runId, Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('invalid-request')
    await this.request(`/repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' })
  }

  /** The viewer's latest submitted review on a PR (graphql-pull-since-review.ts); null = none. */
  async viewerLatestReview(repository: string, pullNumber: number): Promise<PullViewerReview | null> {
    const [owner, name] = safeRepository(repository).split('/')
    if (!positiveInteger(pullNumber, 2_147_483_647)) throw new GitHubClientError('invalid-request')
    const body = await this.graphql(PULL_VIEWER_REVIEW_QUERY, { owner, name, number: pullNumber })
    try {
      return parsePullViewerReview(body)
    } catch (error) {
      if (error instanceof GraphQLShapeError) throw new GitHubClientError('malformed-response')
      throw error
    }
  }

  /** `GET /compare/{base}...{head}`: how head relates to base, the commits it is ahead by, and the
   *  files changed (page 1 carries every file, at most 300; one commit per page keeps it small).
   *  Null = GitHub has no such comparison: a 404 (the base commit is gone) or a 422 (no merge base),
   *  both what a force-push leaves. */
  async compareCommits(repository: string, base: string, head: string): Promise<PullCompare | null> {
    safeRepository(repository)
    if (!isCommitSha(base) || !isCommitSha(head)) throw new GitHubClientError('invalid-request')
    let response: Response
    try {
      response = await this.request(`/repos/${repository}/compare/${base}...${head}?per_page=1`, { method: 'GET' })
    } catch (error) {
      if (error instanceof GitHubClientError && error.code === 'request-failed' && (error.status === 404 || error.status === 422)) return null
      throw error
    }
    const item = object(await this.json(response))
    const status = item?.status
    if (!item || (status !== 'ahead' && status !== 'behind' && status !== 'diverged' && status !== 'identical') ||
        !Number.isSafeInteger(item.ahead_by) || (item.ahead_by as number) < 0 ||
        !Array.isArray(item.files) || item.files.length > 300) throw new GitHubClientError('malformed-response')
    const files = item.files.map(pullFileFrom)
    if (files.some((file) => !file)) throw new GitHubClientError('malformed-response')
    return { status, aheadBy: item.ahead_by as number, files: files as PullFile[] }
  }

  /**
   * One GraphQL request. It goes through the same `request()` as every REST call, so its
   * `x-ratelimit-*` headers (resource `graphql`) reach the coordinator's budget.
   *
   * GraphQL reports an exhausted budget as a 200 whose `errors[].type` is `RATE_LIMITED` — a body
   * that is otherwise shaped like an answer. It is turned into the same `rate-limited` error a REST
   * refusal produces, tagged with the `graphql` resource.
   */
  private async graphql(query: string, variables: Record<string, string | number>): Promise<unknown> {
    const response = await this.request('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables })
    })
    const body = await this.json(response)
    let errors: ReturnType<typeof graphQLErrors>
    try {
      errors = graphQLErrors(body)
    } catch {
      throw new GitHubClientError('malformed-response')
    }
    if (errors.some((error) => error.type === 'RATE_LIMITED')) {
      const header = Number(response.headers.get('x-ratelimit-reset')) * 1_000
      const retryAt = Number.isFinite(header) && header > 0
        ? header
        : rateLimitFrom(body)?.resetAt ?? Date.now() + 60_000
      throw new GitHubClientError('rate-limited', response.status, retryAt, 'graphql')
    }
    return body
  }

  async listRepositoryLabels(
    repository: string,
    options: { page: number; perPage: number; etag?: string }
  ): Promise<LabelPageResult> {
    safeRepository(repository)
    if (!positiveInteger(options.page, 100_000) || !positiveInteger(options.perPage, 100)) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(
      `/repos/${repository}/labels?page=${options.page}&per_page=${options.perPage}`,
      { method: 'GET', ...(options.etag ? { headers: { 'if-none-match': options.etag } } : {}) }
    )
    if (response.status === 304) return { items: [], notModified: true, etag: options.etag }
    const value = await this.json(response)
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    const items = value.map((candidate): GitHubRepositoryLabel | null => {
      const base = issueLabel(candidate)
      const item = object(candidate)
      if (!base || !item || !(item.description === null || string(item.description, 1_000))) return null
      return { ...base, description: item.description }
    })
    if (items.some((item) => !item)) throw new GitHubClientError('malformed-response')
    return {
      items: items as GitHubRepositoryLabel[],
      ...(nextPage(response.headers.get('link')) ? { nextPage: nextPage(response.headers.get('link')) } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {})
    }
  }

  async createLabel(
    repository: string,
    input: { name: string; color: string; description?: string }
  ): Promise<GitHubRepositoryLabel> {
    safeRepository(repository)
    if (!string(input.name, 50) || !input.name.trim() || !/^[0-9a-fA-F]{6}$/.test(input.color) ||
        (input.description !== undefined && !string(input.description, 100))) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/labels`, {
      method: 'POST', body: JSON.stringify(input)
    })
    const value = await this.json(response)
    const base = issueLabel(value)
    const item = object(value)
    if (!base || !item || !(item.description === null || string(item.description, 1_000))) {
      throw new GitHubClientError('malformed-response')
    }
    return { ...base, description: item.description }
  }

  private async request(path: string, init: RequestInit, acceptRedirect = false): Promise<Response> {
    const url = new URL(path, API_ORIGIN)
    if (url.origin !== API_ORIGIN) throw new GitHubClientError('invalid-request')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.options.token}`,
          'x-github-api-version': API_VERSION,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers
        }
      })
    } catch {
      throw new GitHubClientError('request-failed')
    } finally {
      clearTimeout(timer)
    }
    const sample = rateSampleFrom(response.headers)
    if (sample && this.options.onRateLimit) {
      try { this.options.onRateLimit(sample) } catch { /* an observer never breaks a request */ }
    }
    if (response.status === 304) return response
    if (acceptRedirect && response.status === 302) return response
    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1_000
      const remaining = response.headers.get('x-ratelimit-remaining')
      const metadata = response.status === 403 ? await boundedErrorMetadata(response) : ''
      const primary = response.status === 403 && remaining === '0'
      const secondaryEvidence = /secondary rate limit|abuse detection|secondary-rate-limits/.test(metadata)
      const secondary = response.status === 429 ||
        (response.status === 403 && !primary && (
          (Number.isFinite(retryAfter) && retryAfter > 0) || secondaryEvidence
        ))
      if (!primary && !secondary) {
        throw new GitHubClientError('insufficient-permission', response.status)
      }
      const retryAt = Number.isFinite(retryAfter) && retryAfter > 0
        ? Date.now() + retryAfter * 1_000
        : primary && Number.isFinite(reset) && reset > 0
          ? reset
          : Date.now() + this.secondaryBackoffMs
      if (secondary && !(Number.isFinite(retryAfter) && retryAfter > 0)) {
        this.secondaryBackoffMs = Math.min(this.secondaryBackoffMs * 2, 60_000)
      }
      const resource = primary ? response.headers.get('x-ratelimit-resource') ?? undefined : undefined
      throw new GitHubClientError('rate-limited', response.status, retryAt,
        resource && /^[a-z_]{1,32}$/.test(resource) ? resource : undefined)
    }
    // GitHub refuses a review of your own pull request with a 422 that says so (no status of its own).
    if (response.status === 422 && /your own pull request/.test(await boundedErrorMetadata(response))) {
      throw new GitHubClientError('own-pull', 422)
    }
    if (!response.ok) throw new GitHubClientError('request-failed', response.status)
    return response
  }

  private async json(response: Response): Promise<unknown> {
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > this.maximum) {
      throw new GitHubClientError('response-too-large')
    }
    if (!response.body) throw new GitHubClientError('malformed-response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > this.maximum) {
        await reader.cancel()
        throw new GitHubClientError('response-too-large')
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    } catch {
      throw new GitHubClientError('malformed-response')
    }
  }
}

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
  PullFile,
  PullFileRead,
  PullFilesPage,
  PullFileStatus,
  PullMergeMethod,
  PullReviewEvent,
  PullReviewVerdict
} from '../../shared/github-pull-detail'
import {
  GraphQLShapeError,
  PULL_CHECKS_QUERY,
  PULL_STATUS_QUERY,
  graphQLErrors,
  parsePullChecksResponse,
  parsePullStatusResponse,
  rateLimitFrom,
  type PullStatusRead
} from './graphql-pulls'

const API_ORIGIN = 'https://api.github.com'
const REVIEW_EVENTS: ReadonlySet<unknown> = new Set<PullReviewEvent>(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
const MERGE_METHODS: ReadonlyArray<[PullMergeMethod, string]> = [
  ['merge', 'allow_merge_commit'], ['squash', 'allow_squash_merge'], ['rebase', 'allow_rebase_merge']
]
const API_VERSION = '2022-11-28'
const DEFAULT_MAX_RESPONSE = 8 * 1024 * 1024
const MAX_ERROR_METADATA_BYTES = 4 * 1024

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
    url: url.toString()
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
    review: { event: PullReviewEvent; body: string; commitId: string }
  ): Promise<{ id: number }> {
    safeRepository(repository)
    if (!positiveInteger(pullNumber, 2_147_483_647) || !REVIEW_EVENTS.has(review?.event) ||
        typeof review.commitId !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(review.commitId) ||
        typeof review.body !== 'string' || review.body.length > 60_000) {
      throw new GitHubClientError('invalid-request')
    }
    const response = await this.request(`/repos/${repository}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        event: review.event, ...(review.body.trim() ? { body: review.body } : {}), commit_id: review.commitId
      })
    })
    const value = object(await this.json(response))
    if (!value || !positiveInteger(Number(value.id), Number.MAX_SAFE_INTEGER)) {
      throw new GitHubClientError('malformed-response')
    }
    return { id: Number(value.id) }
  }

  /** The merge methods the repository allows (`GET /repos/{r}`). GitHub sends the `allow_*` flags
   *  only to a token that may push; without them no method is offered. */
  async repoMergeMethods(repository: string): Promise<PullMergeMethod[]> {
    const value = object(await this.json(await this.request(`/repos/${safeRepository(repository)}`, { method: 'GET' })))
    if (!value) throw new GitHubClientError('malformed-response')
    return MERGE_METHODS.filter(([, flag]) => value[flag] === true).map(([method]) => method)
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

  private async request(path: string, init: RequestInit): Promise<Response> {
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

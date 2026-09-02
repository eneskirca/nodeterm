import type {
  GitHubBranchPull,
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueUser,
  GitHubPullMeta,
  GitHubRepositoryLabel,
  IssuePageResult,
  LabelPageResult,
  ListIssueOptions,
  UpdateIssueInput
} from '../../shared/github-issues'
import { parseGitHubRepository } from './config'

const API_ORIGIN = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const DEFAULT_MAX_RESPONSE = 8 * 1024 * 1024
const MAX_ERROR_METADATA_BYTES = 4 * 1024

export class GitHubClientError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'malformed-response' | 'response-too-large' |
      'request-failed' | 'rate-limited' | 'insufficient-permission' | 'not-found',
    readonly status?: number,
    readonly retryAt?: number
  ) {
    super(code)
  }
}

type ClientOptions = {
  token: string
  fetch?: typeof fetch
  maxResponseBytes?: number
  timeoutMs?: number
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

function issueFrom(value: unknown): GitHubIssue | null {
  const item = object(value)
  if (!item || !positiveInteger(Number(item.id), Number.MAX_SAFE_INTEGER) ||
      !positiveInteger(Number(item.number), Number.MAX_SAFE_INTEGER) ||
      !string(item.title, 1_024) || !(item.body === null || string(item.body, 1_000_000)) ||
      (item.state !== 'open' && item.state !== 'closed') ||
      !(item.state_reason === null || item.state_reason === undefined ||
        item.state_reason === 'completed' || item.state_reason === 'not_planned' ||
        item.state_reason === 'reopened') ||
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
    stateReason: (item.state_reason ?? null) as GitHubIssue['stateReason'],
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
    return `${message}\n${documentation}`.toLocaleLowerCase('en-US')
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

  async getAuthenticatedUser(): Promise<{ userId: string; login: string }> {
    const value = object(await this.json(await this.request('/user', { method: 'GET' })))
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

  async getIssue(repository: string, issueNumber: number): Promise<GitHubIssue> {
    safeRepository(repository)
    if (!positiveInteger(issueNumber, Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('invalid-request')
    const value = await this.json(await this.request(`/repos/${repository}/issues/${issueNumber}`, { method: 'GET' }))
    if (object(value)?.pull_request !== undefined) throw new GitHubClientError('invalid-request')
    const decoded = issueFrom(value)
    if (!decoded) throw new GitHubClientError('malformed-response')
    return decoded
  }

  /** The sibling of `getIssue` for a caller that WANTS either kind (a node's explicit link is to
   *  whatever the user picked). `getIssue`'s pull-request refusal is deliberate and stays — the
   *  write paths rely on it — so admitting one is opt-in, per call site. A number that exists in
   *  neither space is `not-found`, which the caller renders rather than treating as a failure. */
  async getIssueOrPull(repository: string, number: number): Promise<GitHubIssue> {
    safeRepository(repository)
    if (!positiveInteger(number, Number.MAX_SAFE_INTEGER)) throw new GitHubClientError('invalid-request')
    let value: unknown
    try {
      value = await this.json(await this.request(`/repos/${repository}/issues/${number}`, { method: 'GET' }))
    } catch (error) {
      if (error instanceof GitHubClientError && error.code === 'request-failed' && error.status === 404) {
        throw new GitHubClientError('not-found', 404)
      }
      throw error
    }
    const decoded = issueFrom(value)
    if (!decoded) throw new GitHubClientError('malformed-response')
    return decoded
  }

  /**
   * Open pull requests whose head is `<owner>:<branch>`.
   *
   * No `since` and no ETag: `/pulls` IGNORES `since` (measured — a day-old `since` returns the
   * same page as none), and this read is TTL-cached in the service instead, which is what bounds
   * it to one request per branch per window. `head` is composed host-side from the approved
   * repository's own owner, never from a caller-supplied slug.
   */
  async listPullsByHead(
    repository: string,
    head: string,
    options: { perPage: number }
  ): Promise<GitHubBranchPull[]> {
    safeRepository(repository)
    if (!string(head, 300) || !/^[^\s:]+:[^\s]+$/.test(head) ||
        !positiveInteger(options.perPage, 100)) {
      throw new GitHubClientError('invalid-request')
    }
    const query = new URLSearchParams({
      head, state: 'open', per_page: String(options.perPage)
    })
    const value = await this.json(await this.request(
      `/repos/${repository}/pulls?${query}`, { method: 'GET' }
    ))
    if (!Array.isArray(value) || value.length > 100) throw new GitHubClientError('malformed-response')
    return value.map((candidate) => {
      const item = object(candidate)
      const headRef = item ? object(item.head) : null
      if (!item || !headRef || !positiveInteger(Number(item.number), Number.MAX_SAFE_INTEGER) ||
          !string(item.title, 1_000) || !string(headRef.ref, 255) ||
          !(item.draft === undefined || typeof item.draft === 'boolean') ||
          !isoDate(item.updated_at) || !string(item.html_url, 2_048)) {
        throw new GitHubClientError('malformed-response')
      }
      let html: URL
      try { html = new URL(item.html_url) } catch { throw new GitHubClientError('malformed-response') }
      if (html.protocol !== 'https:' || html.hostname !== 'github.com') {
        throw new GitHubClientError('malformed-response')
      }
      return {
        number: Number(item.number),
        title: item.title,
        draft: item.draft === true,
        head: headRef.ref,
        updatedAt: item.updated_at,
        htmlUrl: html.toString(),
        state: 'open' as const
      }
    })
  }

  async updateIssue(
    repository: string,
    issueNumber: number,
    input: UpdateIssueInput
  ): Promise<GitHubIssue> {
    safeRepository(repository)
    if (!positiveInteger(issueNumber, Number.MAX_SAFE_INTEGER) ||
        (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') ||
        (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.length > 100 ||
          input.labels.some((label) => !string(label, 50) || !label.trim())))) {
      throw new GitHubClientError('invalid-request')
    }
    const body = {
      ...(input.state ? { state: input.state } : {}),
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
      throw new GitHubClientError('rate-limited', response.status, retryAt)
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

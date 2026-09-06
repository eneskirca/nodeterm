import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubIssue } from '../../shared/github-issues'
import { renameAtomic, tempNameFor } from '../fs-atomic'
import { parseGitHubRepository } from './config'

const DIRECTORY = 'github-issues-cache'
const BINDING_DIRECTORY = 'github-issues-bindings'
const DEFAULT_MAXIMUM = 64 * 1024 * 1024

export interface GitHubCompleteSnapshot {
  issues: GitHubIssue[]
  etags: Record<string, string>
  lastSuccessfulRefreshAt: number
  lastFullReconciliationAt: number
  /** Pull requests were dropped to stay inside the issue/byte bounds, so the pull lane is a
   *  subset. Issues are never dropped for a pull request — see the eviction order in
   *  `service.refreshRepository`. */
  pullsTruncated?: boolean
}

export interface GitHubIncompleteAttempt {
  reason: 'issue-limit' | 'byte-limit'
  observedAt: number
  partialIssues?: GitHubIssue[]
}

export interface GitHubCacheDocument {
  version: 1
  lastComplete?: GitHubCompleteSnapshot
  lastAttempt?: GitHubIncompleteAttempt
}

export class GitHubCacheError extends Error {
  constructor(readonly code: 'cache-too-large' | 'invalid-cache-key') {
    super(code)
  }
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validPull(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const pull = value as NonNullable<GitHubIssue['pull']>
  return typeof pull.draft === 'boolean' &&
    (pull.mergedAt === null || typeof pull.mergedAt === 'string') &&
    (pull.head === undefined || typeof pull.head === 'string')
}

function validIssue(value: unknown): value is GitHubIssue {
  if (!value || typeof value !== 'object') return false
  const issue = value as GitHubIssue
  return validPull(issue.pull) && safeInteger(issue.id) && issue.id > 0 && safeInteger(issue.number) && issue.number > 0 &&
    typeof issue.title === 'string' && typeof issue.body === 'string' &&
    (issue.state === 'open' || issue.state === 'closed') &&
    typeof issue.htmlUrl === 'string' && typeof issue.apiUrl === 'string' &&
    Array.isArray(issue.labels) && Array.isArray(issue.assignees) &&
    typeof issue.createdAt === 'string' && typeof issue.updatedAt === 'string' &&
    typeof issue.locked === 'boolean'
}

function validComplete(value: unknown): value is GitHubCompleteSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as GitHubCompleteSnapshot
  return Array.isArray(snapshot.issues) && snapshot.issues.length <= 10_000 &&
    snapshot.issues.every(validIssue) &&
    snapshot.etags !== null && typeof snapshot.etags === 'object' && !Array.isArray(snapshot.etags) &&
    Object.entries(snapshot.etags).every(([key, etag]) => key.length <= 2_048 && typeof etag === 'string' && etag.length <= 512) &&
    safeInteger(snapshot.lastSuccessfulRefreshAt) && safeInteger(snapshot.lastFullReconciliationAt) &&
    (snapshot.pullsTruncated === undefined || typeof snapshot.pullsTruncated === 'boolean')
}

function validAttempt(value: unknown): value is GitHubIncompleteAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as GitHubIncompleteAttempt
  return (attempt.reason === 'issue-limit' || attempt.reason === 'byte-limit') &&
    safeInteger(attempt.observedAt) &&
    (attempt.partialIssues === undefined ||
      (Array.isArray(attempt.partialIssues) && attempt.partialIssues.length <= 10_000 &&
        attempt.partialIssues.every(validIssue)))
}

function validDocument(value: unknown): value is GitHubCacheDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as GitHubCacheDocument
  return document.version === 1 &&
    (document.lastComplete === undefined || validComplete(document.lastComplete)) &&
    (document.lastAttempt === undefined || validAttempt(document.lastAttempt))
}

export class GitHubIssueCache {
  private readonly maximum: number

  constructor(
    private readonly userDataDir: string,
    options: { maximumBytes?: number } = {}
  ) {
    this.maximum = options.maximumBytes ?? DEFAULT_MAXIMUM
  }

  async load(userId: string, repository: string): Promise<GitHubCacheDocument> {
    const file = this.file(userId, repository)
    // Measure and read through ONE open handle. Doing it as stat(path) + readFile(path) leaves a
    // window between the size check and the read, and this cache races itself: `write` publishes
    // by renaming a fresh file over this path, so a save landing mid-load would hand us a file the
    // size guard never saw. A handle is bound to the inode it opened, so the bytes we read are the
    // bytes we measured.
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(file, 'r')
      const stat = await handle.stat()
      if (stat.size > this.maximum) return { version: 1 }
      const parsed: unknown = JSON.parse(await handle.readFile('utf-8'))
      return validDocument(parsed) ? structuredClone(parsed) : { version: 1 }
    } catch {
      return { version: 1 }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async saveComplete(
    userId: string,
    repository: string,
    snapshot: GitHubCompleteSnapshot
  ): Promise<void> {
    if (!validComplete(snapshot)) throw new GitHubCacheError('cache-too-large')
    await this.write(this.file(userId, repository), {
      version: 1,
      lastComplete: structuredClone(snapshot)
    })
  }

  async saveIncompleteAttempt(
    userId: string,
    repository: string,
    attempt: GitHubIncompleteAttempt
  ): Promise<void> {
    if (!validAttempt(attempt)) throw new GitHubCacheError('cache-too-large')
    const current = await this.load(userId, repository)
    const metadata: GitHubIncompleteAttempt = {
      reason: attempt.reason,
      observedAt: attempt.observedAt,
      ...(!current.lastComplete && attempt.partialIssues
        ? { partialIssues: structuredClone(attempt.partialIssues) }
        : {})
    }
    let next: GitHubCacheDocument = {
      version: 1,
      ...(current.lastComplete ? { lastComplete: current.lastComplete } : {}),
      lastAttempt: metadata
    }
    if (Buffer.byteLength(JSON.stringify(next), 'utf-8') > this.maximum && metadata.partialIssues) {
      next = {
        version: 1,
        lastAttempt: { reason: metadata.reason, observedAt: metadata.observedAt }
      }
    }
    await this.write(this.file(userId, repository), next)
  }

  async clear(userId: string, repository: string): Promise<void> {
    await fs.rm(this.file(userId, repository), { force: true })
  }

  async bind(
    localApprovalId: string,
    projectId: string,
    repository: string,
    userId: string
  ): Promise<void> {
    if (!userId || userId.length > 256) throw new GitHubCacheError('invalid-cache-key')
    const file = this.bindingFile(localApprovalId, projectId, repository)
    const existing = await this.readBinding(file)
    const userIds = [...new Set([...(existing?.userIds ?? []), userId])]
    await this.writePrivate(file, JSON.stringify({
      version: 1,
      activeUserId: userId,
      userIds
    }))
  }

  async boundUserId(
    localApprovalId: string,
    projectId: string,
    repository: string
  ): Promise<string | null> {
    const binding = await this.readBinding(this.bindingFile(localApprovalId, projectId, repository))
    return binding?.activeUserId ?? null
  }

  async clearBound(localApprovalId: string, projectId: string, repository: string): Promise<void> {
    const binding = this.bindingFile(localApprovalId, projectId, repository)
    const value = await this.readBinding(binding)
    for (const userId of value?.userIds ?? []) await this.clear(userId, repository)
    await fs.rm(binding, { force: true })
  }

  private file(userId: string, repository: string): string {
    if (!userId || userId.length > 256 || parseGitHubRepository(repository) !== repository) {
      throw new GitHubCacheError('invalid-cache-key')
    }
    const digest = createHash('sha256').update(`${userId}\0${repository}`).digest('hex')
    return path.join(this.userDataDir, DIRECTORY, `${digest}.json`)
  }

  private bindingFile(localApprovalId: string, projectId: string, repository: string): string {
    if (!localApprovalId || localApprovalId.length > 256 || !projectId || projectId.length > 256 ||
        parseGitHubRepository(repository) !== repository) {
      throw new GitHubCacheError('invalid-cache-key')
    }
    const digest = createHash('sha256')
      .update(`${localApprovalId}\0${projectId}\0${repository}`)
      .digest('hex')
    return path.join(this.userDataDir, BINDING_DIRECTORY, `${digest}.json`)
  }

  private async readBinding(file: string): Promise<{
    activeUserId: string
    userIds: string[]
  } | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
      if (!parsed || typeof parsed !== 'object') return null
      const value = parsed as {
        version?: unknown
        userId?: unknown
        activeUserId?: unknown
        userIds?: unknown
      }
      if (value.version !== 1) return null
      const legacy = typeof value.userId === 'string' ? value.userId : undefined
      const activeUserId = typeof value.activeUserId === 'string' ? value.activeUserId : legacy
      const candidates = Array.isArray(value.userIds) ? value.userIds : legacy ? [legacy] : []
      if (!activeUserId || activeUserId.length > 256 ||
          candidates.some((userId) => typeof userId !== 'string' || !userId || userId.length > 256)) {
        return null
      }
      const userIds = [...new Set(candidates as string[])]
      if (!userIds.includes(activeUserId)) userIds.push(activeUserId)
      return { activeUserId, userIds }
    } catch {
      return null
    }
  }

  private async write(file: string, document: GitHubCacheDocument): Promise<void> {
    const content = JSON.stringify(document)
    if (Buffer.byteLength(content, 'utf-8') > this.maximum) {
      throw new GitHubCacheError('cache-too-large')
    }
    await this.writePrivate(file, content)
  }

  private async writePrivate(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    // The temp name must be unique per call because two writers reach the same `<digest>.json` from
    // different serialization domains: src/core/github/service.ts serializes mutations per
    // `${projectId}:${issueNumber}` (mutationChain) but single-flights refreshes per repository, so
    // a mutation's `saveComplete` and a refresh's `saveComplete` for one (userId, repository) are
    // ordered by nothing at all. Binding writes are looser still — `prepareState` runs under
    // `statePreparations`, a Set that admits several at once, and they share a binding file.
    // tempNameFor + renameAtomic (core/fs-atomic.ts) carry both halves of the fix: a collision-proof
    // name, and the bounded retry for Windows sharing violations — see fs-atomic.ts for the account
    // this file's original write-up became.
    const temporary = tempNameFor(file)
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf-8', mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await renameAtomic(temporary, file)
    } catch (error) {
      // A unique name never self-heals the way the fixed one did (the next write just reused it),
      // so a failed write has to remove its own temp — the more so as the two mutation saves in
      // service.ts swallow this error whole, leaving nobody to notice the litter. The error still
      // propagates. There is deliberately no sweep of orphans from dead processes as the token
      // stores do: these are issue snapshots and binding records, not a credential that nothing
      // will ever overwrite.
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await fs.chmod(file, 0o600)
  }
}

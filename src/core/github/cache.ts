import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubIssue } from '../../shared/github-issues'
import { parseGitHubRepository } from './config'

const DIRECTORY = 'github-issues-cache'
const DEFAULT_MAXIMUM = 64 * 1024 * 1024

export interface GitHubCompleteSnapshot {
  issues: GitHubIssue[]
  etags: Record<string, string>
  lastSuccessfulRefreshAt: number
  lastFullReconciliationAt: number
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

function validIssue(value: unknown): value is GitHubIssue {
  if (!value || typeof value !== 'object') return false
  const issue = value as GitHubIssue
  return safeInteger(issue.id) && issue.id > 0 && safeInteger(issue.number) && issue.number > 0 &&
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
    safeInteger(snapshot.lastSuccessfulRefreshAt) && safeInteger(snapshot.lastFullReconciliationAt)
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
    try {
      const stat = await fs.stat(file)
      if (stat.size > this.maximum) return { version: 1 }
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
      return validDocument(parsed) ? structuredClone(parsed) : { version: 1 }
    } catch {
      return { version: 1 }
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

  private file(userId: string, repository: string): string {
    if (!userId || userId.length > 256 || parseGitHubRepository(repository) !== repository) {
      throw new GitHubCacheError('invalid-cache-key')
    }
    const digest = createHash('sha256').update(`${userId}\0${repository}`).digest('hex')
    return path.join(this.userDataDir, DIRECTORY, `${digest}.json`)
  }

  private async write(file: string, document: GitHubCacheDocument): Promise<void> {
    const content = JSON.stringify(document)
    if (Buffer.byteLength(content, 'utf-8') > this.maximum) {
      throw new GitHubCacheError('cache-too-large')
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    await fs.writeFile(temporary, content, { encoding: 'utf-8', mode: 0o600 })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600)
  }
}

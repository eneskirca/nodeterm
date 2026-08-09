import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubIssueCache, type GitHubCompleteSnapshot } from './cache'
import type { GitHubIssue } from '../../shared/github-issues'

let userDataDir: string

const issue = (number: number): GitHubIssue => ({
  id: 1_000 + number,
  number,
  title: `Issue ${number}`,
  body: '',
  state: 'open',
  stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`,
  apiUrl: `https://api.github.com/repos/o/r/issues/${number}`,
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z',
  locked: false
})

const complete = (issues: GitHubIssue[]): GitHubCompleteSnapshot => ({
  issues,
  etags: {},
  lastSuccessfulRefreshAt: 1_000,
  lastFullReconciliationAt: 1_000
})

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-github-cache-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('GitHubIssueCache', () => {
  it('writes a private hashed cache file atomically', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    const files = await fs.readdir(path.join(userDataDir, 'github-issues-cache'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/)
    expect((await fs.stat(path.join(userDataDir, 'github-issues-cache', files[0]))).mode & 0o777)
      .toBe(0o600)
    expect(await cache.load('user-1', 'o/r')).toMatchObject({
      lastComplete: { issues: [{ number: 1 }] }
    })
  })

  it('retains lastComplete when a later refresh is incomplete', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    await cache.saveIncompleteAttempt('user-1', 'o/r', {
      reason: 'issue-limit', observedAt: 2_000, partialIssues: [issue(2)]
    })
    const loaded = await cache.load('user-1', 'o/r')
    expect(loaded.lastComplete?.issues.map((item) => item.number)).toEqual([1])
    expect(loaded.lastAttempt).toEqual({ reason: 'issue-limit', observedAt: 2_000 })
  })

  it('keeps a bounded first-refresh partial snapshot visibly separate', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveIncompleteAttempt('user-1', 'o/r', {
      reason: 'byte-limit', observedAt: 2_000, partialIssues: [issue(1)]
    })
    const loaded = await cache.load('user-1', 'o/r')
    expect(loaded.lastComplete).toBeUndefined()
    expect(loaded).toMatchObject({
      lastAttempt: { reason: 'byte-limit', partialIssues: [{ number: 1 }] }
    })
  })

  it('rejects an oversized replacement and preserves the previous complete snapshot', async () => {
    const cache = new GitHubIssueCache(userDataDir, { maximumBytes: 2_000 })
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    await expect(cache.saveComplete('user-1', 'o/r', complete([
      { ...issue(2), body: 'x'.repeat(3_000) }
    ]))).rejects.toMatchObject({ code: 'cache-too-large' })
    expect((await cache.load('user-1', 'o/r')).lastComplete?.issues[0].number).toBe(1)
  })

  it('refuses to load a stored document larger than the maximum', async () => {
    // The write path caps size, but a document already on disk can exceed a LOWER cap — an older
    // build's cache, or a cap tightened later. Loading it anyway would pull the whole file into
    // memory, which is the reading half of the same budget saveComplete enforces.
    await new GitHubIssueCache(userDataDir).saveComplete('user-1', 'o/r', complete([
      { ...issue(1), body: 'x'.repeat(4_000) }
    ]))
    const tightened = new GitHubIssueCache(userDataDir, { maximumBytes: 500 })
    expect(await tightened.load('user-1', 'o/r')).toEqual({ version: 1 })
  })

  it('clears only the selected identity and repository cache', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    await cache.saveComplete('user-2', 'o/r', complete([issue(2)]))
    await cache.clear('user-1', 'o/r')
    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
    expect((await cache.load('user-2', 'o/r')).lastComplete?.issues[0].number).toBe(2)
  })

  it('persists a private approval binding so an offline session can locate and delete its cache', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    await cache.saveComplete('user-2', 'o/r', complete([issue(2)]))
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    expect(await cache.boundUserId('local-1', 'project-1', 'o/r')).toBe('user-1')
    await cache.bind('local-1', 'project-1', 'o/r', 'user-2')
    expect(await cache.boundUserId('local-1', 'project-1', 'o/r')).toBe('user-2')
    await cache.clearBound('local-1', 'project-1', 'o/r')
    expect(await cache.boundUserId('local-1', 'project-1', 'o/r')).toBeNull()
    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
    expect(await cache.load('user-2', 'o/r')).toEqual({ version: 1 })
  })
})

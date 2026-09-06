import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubIssueCache, type GitHubCacheDocument, type GitHubCompleteSnapshot } from './cache'
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
  vi.restoreAllMocks()
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

describe('GitHubIssueCache atomic write', () => {
  const cacheDir = (): string => path.join(userDataDir, 'github-issues-cache')

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(cacheDir())).filter((file) => file.endsWith('.tmp'))

  // Two writers reach the SAME `<digest>.json` from different serialization domains, so nothing
  // orders them: src/core/github/service.ts serializes mutations per `${projectId}:${issueNumber}`
  // (mutationChain) but single-flights refreshes per repository, and a mutation's saveComplete and
  // a refresh's saveComplete address the same (userId, repository) file. Binding writes are looser
  // still — prepareState runs under `statePreparations`, a Set that admits several at once. One
  // fixed `${file}.tmp` name means those writers share a single tmp file: one writer's rename
  // publishes the other's half-written snapshot, or moves the file out from under it entirely and
  // the loser's rename fails.
  it('two overlapping snapshot saves never share a tmp file (no torn write, no leftovers)', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    // Snapshots that differ in LENGTH by a wide margin: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const big = complete(Array.from({ length: 40 }, (_, index) => issue(index + 1)))
    const small = complete([issue(1)])
    // Hold every writer between its tmp write and its rename, so BOTH tmp files are on disk before
    // either rename runs — the overlap window a real crash tears open.
    const tmps: string[] = []
    let open!: () => void
    let timer!: ReturnType<typeof setTimeout>
    // If a future change serializes the writers, the second write never arrives and the barrier
    // would hang to an opaque 5s vitest timeout. Fail loudly, naming what this test pins.
    const bothWritten = Promise.race([
      new Promise<void>((r) => (open = r)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('second concurrent tmp write never arrived — writers appear ' +
            'serialized; this test pins the unique-tmp-name design')),
          2000
        )
      })
    ])
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      const out = await (realWriteFile as any)(p, ...rest)
      if (String(p).startsWith(cacheDir())) {
        tmps.push(String(p))
        if (tmps.length >= 2) {
          clearTimeout(timer)
          open()
        }
        await bothWritten
      }
      return out
    }) as any)

    // allSettled, not all: with a shared name the LOSER's rename fails (ENOENT — the winner already
    // moved the file away), and letting that reject here would report the symptom before the cause.
    const settled = await Promise.allSettled([
      cache.saveComplete('user-1', 'o/r', big),
      cache.saveComplete('user-1', 'o/r', small)
    ])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each writer owned its own tmp file
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']) // …so neither lost it
    const files = (await fs.readdir(cacheDir())).filter((file) => file.endsWith('.json'))
    expect(files).toHaveLength(1)
    // One COMPLETE document won — parsing at all proves it is not a prefix of the other.
    const document: GitHubCacheDocument =
      JSON.parse(await fs.readFile(path.join(cacheDir(), files[0]), 'utf-8'))
    expect([1, 40]).toContain(document.lastComplete?.issues.length)
    expect(await tmpsLeft()).toEqual([])
  })

  it('round-trips a pull request harvest and its truncation flag', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    const pull: GitHubIssue = { ...issue(9), pull: { draft: true, mergedAt: null } }
    await cache.saveComplete('user-1', 'o/r', { ...complete([issue(1), pull]), pullsTruncated: true })

    const document = await cache.load('user-1', 'o/r')
    expect(document.lastComplete?.pullsTruncated).toBe(true)
    expect(document.lastComplete?.issues[1].pull).toEqual({ draft: true, mergedAt: null })
  })

  it('drops a cached document whose pull metadata is malformed', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    const file = (await fs.readdir(path.join(userDataDir, 'github-issues-cache')))[0]
    const target = path.join(userDataDir, 'github-issues-cache', file)
    const document = JSON.parse(await fs.readFile(target, 'utf-8')) as GitHubCacheDocument
    // Cache content is hostile input: a hand-edited `pull` must not reach the board as a card.
    ;(document.lastComplete!.issues[0] as GitHubIssue).pull = { draft: 'yes' } as never
    await fs.writeFile(target, JSON.stringify(document))

    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
  })

  it('a failed rename removes its own temp, rejects, and leaves the previous snapshot', async () => {
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', complete([issue(1)]))
    // EXDEV is the realistic one: the userData dir on another filesystem than the temp.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(cache.saveComplete('user-1', 'o/r', complete([issue(2)])))
      .rejects.toThrow(/EXDEV/)
    // A unique tmp name is never reused, so the failed write has to have cleaned up after itself —
    // nothing else will ever overwrite that name, and callers in service.ts swallow this error.
    expect(await tmpsLeft()).toEqual([])
    expect((await cache.load('user-1', 'o/r')).lastComplete?.issues[0].number).toBe(1)
  })
})

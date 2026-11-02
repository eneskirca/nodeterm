import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail, PullFile, PullFileRead, PullFilesPage } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const BASE = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const MERGE_BASE = 'd'.repeat(40)

const detail = (): GitHubPullDetail => ({
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: BASE }, head: { ref: 'feat', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
})
const file = (path: string, over: Partial<PullFile> = {}): PullFile =>
  ({ path, status: 'modified', additions: 1, deletions: 1, ...over })

class Client implements GitHubIssuesClientLike {
  reads: string[] = []
  pages: (page: number) => Promise<PullFilesPage> = async () => ({
    files: [
      file('src/a.ts'),
      file('src/new.ts', { status: 'renamed', previousPath: 'src/old.ts' }),
      file('src/added.ts', { status: 'added' }),
      file('src/gone.ts', { status: 'removed' }),
      file('logo.png')
    ]
  })
  contents: (path: string, ref: string) => Promise<PullFileRead> = async (path, ref) =>
    path === 'logo.png' ? { kind: 'unavailable', reason: 'binary' } : { kind: 'text', text: `${path}@${ref[0]}` }
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async getPull(): Promise<GitHubPullDetail> { this.reads.push('detail'); return detail() }
  async listPullFiles(_r: string, _n: number, page: number): Promise<PullFilesPage> {
    this.reads.push(`files ${page}`); return this.pages(page)
  }
  base: () => Promise<string> = async () => MERGE_BASE
  async mergeBase(_r: string, base: string, head: string): Promise<string> {
    this.reads.push(`compare ${base[0]}...${head[0]}`); return this.base()
  }
  async getFileAt(_r: string, path: string, ref: string): Promise<PullFileRead> {
    this.reads.push(`file ${path}@${ref[0]}`); return this.contents(path, ref)
  }
}

function harness(contextError?: { code: string }) {
  let now = 1_000_000
  const client = new Client()
  const coordinator = new GitHubRequestCoordinator({ now: () => now })
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
  })
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator,
    contextForProject: async () => { if (contextError) throw contextError; return context() },
    now: () => now
  })
  return { client, coordinator, service, advance: (ms: number) => { now += ms }, now: () => now }
}

const request = { projectId: 'p', repository: 'o/r', pullNumber: 7 }
const contents = (path: string) => ({ ...request, path })

describe('GitHubIssueService.pullFiles', () => {
  it('lists the changed files of the approved repository', async () => {
    const { service } = harness()
    const result = await service.pullFiles(request)
    expect(result).toMatchObject({ status: 'ok', truncated: false, observedAt: 1_000_000 })
    expect(result.status === 'ok' && result.files.map((f) => f.path))
      .toEqual(['src/a.ts', 'src/new.ts', 'src/added.ts', 'src/gone.ts', 'logo.png'])
  })

  it('follows pages and caps the list at 300 files, then says truncated', async () => {
    const { client, service } = harness()
    client.pages = async (page) => ({
      files: Array.from({ length: 100 }, (_, i) => file(`f${page}-${i}`)), nextPage: page + 1
    })
    const result = await service.pullFiles(request)
    expect(result).toMatchObject({ status: 'ok', truncated: true })
    expect(result.status === 'ok' && result.files).toHaveLength(300)
    expect(client.reads).toEqual(['files 1', 'files 2', 'files 3'])
  })

  it('says not truncated when exactly the last page ends the list', async () => {
    const { client, service } = harness()
    client.pages = async (page) => ({
      files: Array.from({ length: page < 3 ? 100 : 40 }, (_, i) => file(`f${page}-${i}`)),
      ...(page < 3 ? { nextPage: page + 1 } : {})
    })
    expect(await service.pullFiles(request)).toMatchObject({ status: 'ok', truncated: false })
  })

  it('refuses another repository and a signed-out user with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullFiles({ ...request, repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toEqual([])
    const signedOut = harness({ code: 'not-authenticated' })
    expect(await signedOut.service.pullFiles(request)).toEqual({ status: 'refused', reason: 'signed-out' })
    expect(signedOut.client.reads).toEqual([])
  })

  it('keeps the last list and marks it stale when a later read is throttled', async () => {
    const { client, service, advance, now } = harness()
    const first = await service.pullFiles(request)
    advance(31_000)
    const retryAt = now() + 60_000
    client.pages = async () => { throw new GitHubClientError('rate-limited', 403, retryAt) }
    expect(await service.pullFiles(request)).toEqual({ ...first, stale: 'throttled', retryAt })
  })
})

describe('GitHubIssueService.pullFileContents', () => {
  it('reads the base side at the merge base of base and head, not at base.sha', async () => {
    const { client, service } = harness()
    expect(await service.pullFileContents(contents('src/a.ts'))).toEqual({
      status: 'ok', observedAt: 1_000_000,
      contents: { kind: 'diff', base: { kind: 'text', text: 'src/a.ts@d' }, head: { kind: 'text', text: 'src/a.ts@c' } }
    })
    expect(client.reads).toContain('compare b...c')
    expect(client.reads).not.toContain('file src/a.ts@b')
  })

  it('reads the merge base once per base and head, so a later file click does not re-read it', async () => {
    const { client, service, advance } = harness()
    await service.pullFileContents(contents('src/a.ts'))
    advance(60_000)
    await service.pullFileContents(contents('src/new.ts'))
    expect(client.reads.filter((read) => read.startsWith('compare '))).toEqual(['compare b...c'])
  })

  it('classifies a failed compare read like the other reads, and reads no file', async () => {
    const { client, service } = harness()
    client.base = async () => { throw new GitHubClientError('request-failed', 401) }
    expect(await service.pullFileContents(contents('src/a.ts'))).toEqual({ status: 'failed', reason: 'signed-out' })
    client.base = async () => { throw new GitHubClientError('rate-limited', 403, 2_000_000) }
    expect(await service.pullFileContents(contents('src/a.ts')))
      .toEqual({ status: 'failed', reason: 'throttled', retryAt: 2_000_000 })
    expect(client.reads.some((read) => read.startsWith('file '))).toBe(false)
  })

  it('reads the base side of a rename from its previous path', async () => {
    const { client, service } = harness()
    const result = await service.pullFileContents(contents('src/new.ts'))
    expect(result.status === 'ok' && result.contents).toEqual({
      kind: 'diff', base: { kind: 'text', text: 'src/old.ts@d' }, head: { kind: 'text', text: 'src/new.ts@c' }
    })
    expect(client.reads).toContain('file src/old.ts@d')
  })

  it('answers empty for the missing side of an added or removed file, with no read for it', async () => {
    const { client, service } = harness()
    const added = await service.pullFileContents(contents('src/added.ts'))
    expect(added.status === 'ok' && added.contents)
      .toEqual({ kind: 'diff', base: { kind: 'empty' }, head: { kind: 'text', text: 'src/added.ts@c' } })
    const removed = await service.pullFileContents(contents('src/gone.ts'))
    expect(removed.status === 'ok' && removed.contents)
      .toEqual({ kind: 'diff', base: { kind: 'text', text: 'src/gone.ts@d' }, head: { kind: 'empty' } })
    expect(client.reads.filter((read) => read.startsWith('file '))).toEqual(['file src/added.ts@c', 'file src/gone.ts@d'])
  })

  it('answers unavailable for a binary file and a file over 1 MB', async () => {
    const { client, service } = harness()
    const binary = await service.pullFileContents(contents('logo.png'))
    expect(binary.status === 'ok' && binary.contents).toEqual({ kind: 'unavailable', reason: 'binary' })
    client.contents = async (_path, ref) =>
      ref === HEAD ? { kind: 'unavailable', reason: 'too-large' } : { kind: 'text', text: 'small' }
    const large = await service.pullFileContents(contents('src/a.ts'))
    expect(large.status === 'ok' && large.contents).toEqual({ kind: 'unavailable', reason: 'too-large' })
  })

  it('answers not-in-pull for a path the pull request does not change, with no file read', async () => {
    const { client, service } = harness()
    const result = await service.pullFileContents(contents('README.md'))
    expect(result.status === 'ok' && result.contents).toEqual({ kind: 'unavailable', reason: 'not-in-pull' })
    expect(client.reads.some((read) => read.startsWith('file '))).toBe(false)
  })

  it('refuses another repository with no request, and answers from memory inside the 30 s floor', async () => {
    const { client, service, advance } = harness()
    expect(await service.pullFileContents({ ...contents('src/a.ts'), repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toEqual([])
    await service.pullFileContents(contents('src/a.ts'))
    advance(10_000)
    await service.pullFileContents(contents('src/a.ts'))
    expect(client.reads).toEqual(['detail', 'files 1', 'compare b...c', 'file src/a.ts@d', 'file src/a.ts@c'])
  })

  it('goes through the request coordinator: a held budget sends nothing and says throttled', async () => {
    const { client, coordinator, service, now } = harness()
    coordinator.noteRateLimit('user-1', { kind: 'primary', retryAt: now() + 120_000 })
    expect(await service.pullFileContents(contents('src/a.ts'))).toMatchObject({ status: 'failed', reason: 'throttled' })
    expect(client.reads).toEqual([])
  })
})

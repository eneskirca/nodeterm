import { describe, expect, it } from 'vitest'
import { GitHubAvatarFetcher } from './avatar-fetcher'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { GitHubIssueUser, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { PullFile, PullFileRead } from '../../shared/github-pull-detail'
import type { PullCommit, PullCommitFilesPage, PullCommitsPage } from '../../shared/github-pull-commits'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const SHA = 'c'.repeat(40)
const PARENT = 'd'.repeat(40)
const user = (id: number): GitHubIssueUser => ({ id, login: `u${id}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` })
const commit = (n: number, author: GitHubIssueUser | null = user(1)): PullCommit => ({
  oid: n.toString(16).padStart(40, '0'), headline: `c${n}`, author, authorName: 'A', committedAt: '2026-11-03T10:00:00Z', verified: false
})
const file = (path: string, over: Partial<PullFile> = {}): PullFile => ({ path, status: 'modified', additions: 1, deletions: 1, ...over })

class Client implements GitHubIssuesClientLike {
  reads: string[] = []
  commitPages: (after?: string) => Promise<PullCommitsPage> = async () => ({ commits: [commit(1), commit(2, null), { ...commit(3), oid: SHA }] })
  filePages: (page: number) => Promise<PullCommitFilesPage> = async () => ({
    files: [file('a.ts'), file('new.ts', { status: 'added' }), file('gone.ts', { status: 'removed' }),
      file('to.ts', { status: 'renamed', previousPath: 'from.ts' })],
    parent: PARENT
  })
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async listPullCommits(_r: string, _n: number, after?: string): Promise<PullCommitsPage> {
    this.reads.push(`commits ${after ?? 'first'}`); return this.commitPages(after)
  }
  async getCommitFiles(_r: string, sha: string, page: number): Promise<PullCommitFilesPage> {
    this.reads.push(`commit ${sha[0]} ${page}`); return this.filePages(page)
  }
  async getFileAt(_r: string, path: string, ref: string): Promise<PullFileRead> {
    this.reads.push(`file ${path}@${ref[0]}`); return { kind: 'text', text: `${path}@${ref[0]}` }
  }
}

function harness(options: { contextError?: { code: string }; avatars?: boolean } = {}) {
  let now = 1_000_000
  const client = new Client()
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
  })
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => now }),
    contextForProject: async () => { if (options.contextError) throw options.contextError; return context() },
    now: () => now,
    ...(options.avatars ? {
      avatarFetcher: new GitHubAvatarFetcher({
        fetch: async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } })
      })
    } : {})
  })
  return { client, service, advance: (ms: number) => { now += ms } }
}

const request = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService.pullCommits', () => {
  it('lists the PR commits oldest first', async () => {
    const { service } = harness()
    const result = await service.pullCommits(request)
    expect(result).toMatchObject({ status: 'ok', truncated: false, observedAt: 1_000_000 })
    expect(result.status === 'ok' && result.commits.map((c) => c.headline)).toEqual(['c1', 'c2', 'c3'])
  })

  it('follows the cursor and stops after three pages, then says truncated', async () => {
    const { client, service } = harness()
    client.commitPages = async (after) => ({ commits: [commit(Number(after ?? 0) + 1)], after: String(Number(after ?? 0) + 1) })
    const result = await service.pullCommits(request)
    expect(result).toMatchObject({ status: 'ok', truncated: true })
    expect(client.reads).toEqual(['commits first', 'commits 1', 'commits 2'])
  })

  it('carries the commit authors\' avatars as data URLs', async () => {
    const { service } = harness({ avatars: true })
    const result = await service.pullCommits(request)
    expect(result.status === 'ok' && Object.keys(result.avatarDataUrls ?? {})).toEqual(['1'])
  })

  it('refuses another repository and a signed-out user with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullCommits({ ...request, repository: 'evil/other' })).toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toEqual([])
    const signedOut = harness({ contextError: { code: 'not-authenticated' } })
    expect(await signedOut.service.pullCommits(request)).toEqual({ status: 'refused', reason: 'signed-out' })
    expect(signedOut.client.reads).toEqual([])
  })

  it('keeps the last list and marks it stale when a later read is throttled', async () => {
    const { client, service, advance } = harness()
    await service.pullCommits(request)
    advance(31_000)
    client.commitPages = async () => { throw new GitHubClientError('rate-limited', 403, 2_000_000) }
    expect(await service.pullCommits(request)).toMatchObject({ status: 'ok', stale: 'throttled', commits: [{ headline: 'c1' }, { headline: 'c2' }, { headline: 'c3' }] })
  })
})

describe('GitHubIssueService.pullCommitFiles', () => {
  it('lists one commit\'s files with its parent', async () => {
    const { client, service } = harness()
    const result = await service.pullCommitFiles({ ...request, sha: SHA })
    expect(result).toMatchObject({ status: 'ok', parent: PARENT, truncated: false })
    expect(client.reads).toEqual(['commits first', 'commit c 1'])
  })

  it('follows pages and caps at 300 files', async () => {
    const { client, service } = harness()
    client.filePages = async (page) => ({ files: Array.from({ length: 100 }, (_, i) => file(`f${page}-${i}`)), nextPage: page + 1 })
    const result = await service.pullCommitFiles({ ...request, sha: SHA })
    expect(result).toMatchObject({ status: 'ok', truncated: true })
    expect(result.status === 'ok' && result.files).toHaveLength(300)
    expect(client.reads).toEqual(['commits first', 'commit c 1', 'commit c 2', 'commit c 3'])
  })

  it('refuses a ref that is not a full commit SHA, and another repository, with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullCommitFiles({ ...request, sha: 'main' })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(await service.pullCommitFiles({ ...request, repository: 'evil/other', sha: SHA }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toEqual([])
  })

  it('refuses a SHA that is not one of this PR\'s commits, with no commit read', async () => {
    const { client, service } = harness()
    expect(await service.pullCommitFiles({ ...request, sha: 'e'.repeat(40) })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(client.reads).toEqual(['commits first'])
  })
})

describe('GitHubIssueService.pullCommitFileContents', () => {
  const contents = (path: string) => ({ ...request, sha: SHA, path })

  it('diffs the commit against its first parent, a rename from its previous path', async () => {
    const { client, service } = harness()
    expect(await service.pullCommitFileContents(contents('a.ts'))).toMatchObject({
      status: 'ok', contents: { kind: 'diff', base: { kind: 'text', text: 'a.ts@d' }, head: { kind: 'text', text: 'a.ts@c' } }
    })
    expect(await service.pullCommitFileContents(contents('to.ts'))).toMatchObject({
      contents: { base: { text: 'from.ts@d' }, head: { text: 'to.ts@c' } }
    })
    expect(client.reads.filter((read) => read.startsWith('commit '))).toEqual(['commit c 1'])
  })

  it('reads no missing side: added, removed, and a root commit', async () => {
    const { client, service } = harness()
    expect(await service.pullCommitFileContents(contents('new.ts'))).toMatchObject({ contents: { base: { kind: 'empty' } } })
    expect(await service.pullCommitFileContents(contents('gone.ts'))).toMatchObject({ contents: { head: { kind: 'empty' } } })
    expect(client.reads).not.toContain('file new.ts@d')
    expect(client.reads).not.toContain('file gone.ts@c')
    const root = harness()
    root.client.filePages = async () => ({ files: [file('a.ts')] })
    expect(await root.service.pullCommitFileContents(contents('a.ts'))).toMatchObject({ contents: { base: { kind: 'empty' } } })
  })

  it('answers not-in-pull for a path the commit did not change', async () => {
    const { service } = harness()
    expect(await service.pullCommitFileContents(contents('other.ts')))
      .toMatchObject({ status: 'ok', contents: { kind: 'unavailable', reason: 'not-in-pull' } })
  })

  it('refuses a SHA outside the PR before any file read', async () => {
    const { client, service } = harness()
    expect(await service.pullCommitFileContents({ ...contents('a.ts'), sha: 'e'.repeat(40) })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(client.reads.filter((read) => !read.startsWith('commits'))).toEqual([])
  })

  it('refuses a bad SHA or path with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullCommitFileContents({ ...contents('a.ts'), sha: 'HEAD' })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(await service.pullCommitFileContents({ ...request, sha: SHA } as never)).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(client.reads).toEqual([])
  })
})

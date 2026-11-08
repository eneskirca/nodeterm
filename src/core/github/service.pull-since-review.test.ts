import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail, PullFile, PullFileRead } from '../../shared/github-pull-detail'
import type { PullCompare, PullViewerReview } from '../../shared/github-pull-since-review'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const BASE = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const REVIEWED = 'e'.repeat(40)

const detail = (): GitHubPullDetail => ({
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: BASE }, head: { ref: 'feat', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
})
const file = (path: string, over: Partial<PullFile> = {}): PullFile => ({ path, status: 'modified', additions: 1, deletions: 1, ...over })
const SUBMITTED = '2026-11-01T10:00:00Z'

class Client implements GitHubIssuesClientLike {
  reads: string[] = []
  review: () => Promise<PullViewerReview | null> = async () => ({ submittedAt: SUBMITTED, commitOid: REVIEWED })
  compare: () => Promise<PullCompare | null> = async () => ({
    status: 'ahead', aheadBy: 2,
    files: [file('a.ts'), file('new.ts', { status: 'added' }), file('gone.ts', { status: 'removed' }),
      file('to.ts', { status: 'renamed', previousPath: 'from.ts' })]
  })
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async getPull(): Promise<GitHubPullDetail> { this.reads.push('detail'); return detail() }
  async viewerLatestReview(_r: string, n: number): Promise<PullViewerReview | null> { this.reads.push(`review ${n}`); return this.review() }
  async compareCommits(_r: string, base: string, head: string): Promise<PullCompare | null> {
    this.reads.push(`compare ${base[0]}...${head[0]}`); return this.compare()
  }
  async getFileAt(_r: string, path: string, ref: string): Promise<PullFileRead> {
    this.reads.push(`file ${path}@${ref[0]}`); return { kind: 'text', text: `${path}@${ref[0]}` }
  }
}

function harness() {
  let now = 1_000_000
  const client = new Client()
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
  })
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => now }),
    contextForProject: async () => context(),
    now: () => now
  })
  return { client, service, advance: (ms: number) => { now += ms } }
}

const request = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService.pullSinceReview', () => {
  it('compares the reviewed commit to the head: new commits and the files changed since', async () => {
    const { client, service } = harness()
    expect(await service.pullSinceReview(request)).toEqual({
      status: 'ok', observedAt: 1_000_000,
      since: {
        kind: 'moved', submittedAt: SUBMITTED, commitOid: REVIEWED, head: HEAD, commits: 2, truncated: false,
        files: [file('a.ts'), file('new.ts', { status: 'added' }), file('gone.ts', { status: 'removed' }),
          file('to.ts', { status: 'renamed', previousPath: 'from.ts' })]
      }
    })
    expect(client.reads).toEqual(['detail', 'review 7', 'compare e...c'])
  })

  it('answers none with no review, and current when the head is the reviewed commit, with no compare', async () => {
    const none = harness()
    none.client.review = async () => null
    expect(await none.service.pullSinceReview(request)).toMatchObject({ status: 'ok', since: { kind: 'none' } })
    const current = harness()
    current.client.review = async () => ({ submittedAt: SUBMITTED, commitOid: HEAD })
    expect(await current.service.pullSinceReview(request)).toMatchObject({ status: 'ok', since: { kind: 'current', commitOid: HEAD } })
    expect([...none.client.reads, ...current.client.reads].some((read) => read.startsWith('compare'))).toBe(false)
  })

  it('answers unavailable after a force-push and never throws: commit gone, or history rewritten', async () => {
    const gone = harness()
    gone.client.compare = async () => null
    expect(await gone.service.pullSinceReview(request)).toMatchObject({
      status: 'ok', since: { kind: 'unavailable', reason: 'commit-gone', submittedAt: SUBMITTED, commitOid: REVIEWED }
    })
    for (const status of ['diverged', 'behind'] as const) {
      const rewritten = harness()
      rewritten.client.compare = async () => ({ status, aheadBy: 1, files: [] })
      expect(await rewritten.service.pullSinceReview(request)).toMatchObject({
        status: 'ok', since: { kind: 'unavailable', reason: 'history-rewritten' }
      })
    }
  })

  it('marks 300 files truncated', async () => {
    const { client, service } = harness()
    client.compare = async () => ({ status: 'ahead', aheadBy: 1, files: Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`)) })
    expect(await service.pullSinceReview(request)).toMatchObject({ since: { kind: 'moved', truncated: true } })
  })

  it('holds the answer inside the floor, and keeps it stale on a failed read', async () => {
    const { client, service, advance } = harness()
    await service.pullSinceReview(request)
    await service.pullSinceReview(request)
    expect(client.reads.filter((read) => read.startsWith('review'))).toHaveLength(1)
    advance(60_000)
    client.review = async () => { throw new GitHubClientError('request-failed') }
    expect(await service.pullSinceReview(request)).toMatchObject({ status: 'ok', stale: 'unreachable', since: { kind: 'moved' } })
  })

  it('refuses another repository with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullSinceReview({ ...request, repository: 'x/y' })).toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toEqual([])
  })
})

describe('GitHubIssueService.pullSinceReviewFileContents', () => {
  const contents = (path: string) => ({ ...request, path })

  it('diffs one file between the reviewed commit and the head', async () => {
    const { service } = harness()
    expect(await service.pullSinceReviewFileContents(contents('a.ts'))).toMatchObject({
      status: 'ok', contents: { kind: 'diff', base: { kind: 'text', text: 'a.ts@e' }, head: { kind: 'text', text: 'a.ts@c' } }
    })
    expect(await service.pullSinceReviewFileContents(contents('to.ts'))).toMatchObject({
      contents: { base: { text: 'from.ts@e' }, head: { text: 'to.ts@c' } }
    })
    expect(await service.pullSinceReviewFileContents(contents('new.ts'))).toMatchObject({ contents: { base: { kind: 'empty' } } })
    expect(await service.pullSinceReviewFileContents(contents('gone.ts'))).toMatchObject({ contents: { head: { kind: 'empty' } } })
  })

  it('answers not-in-pull for a path the comparison does not list, or with nothing to compare', async () => {
    const { service } = harness()
    expect(await service.pullSinceReviewFileContents(contents('other.ts')))
      .toMatchObject({ status: 'ok', contents: { kind: 'unavailable', reason: 'not-in-pull' } })
    const gone = harness()
    gone.client.compare = async () => null
    expect(await gone.service.pullSinceReviewFileContents(contents('a.ts')))
      .toMatchObject({ status: 'ok', contents: { kind: 'unavailable', reason: 'not-in-pull' } })
    expect(gone.client.reads.some((read) => read.startsWith('file'))).toBe(false)
  })

  it('refuses a path that is not a string', async () => {
    const { service } = harness()
    expect(await service.pullSinceReviewFileContents(request as never)).toEqual({ status: 'refused', reason: 'not-configured' })
  })
})

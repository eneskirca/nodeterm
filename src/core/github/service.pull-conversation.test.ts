import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { PullConversationItem, PullConversationPage } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}

const comment = (id: number, at: string): PullConversationItem => ({
  kind: 'comment', id, author: null, body: `comment ${id}`, at, url: `https://github.com/o/r/pull/7#issuecomment-${id}`
})
const review = (id: number, at: string): PullConversationItem => ({
  kind: 'review', id, author: null, body: '', at, verdict: 'approved', url: `https://github.com/o/r/pull/7#pullrequestreview-${id}`
})

class Client implements GitHubIssuesClientLike {
  reads: string[] = []
  comments: (page: number) => Promise<PullConversationPage> = async () => ({
    items: [comment(1, '2026-10-01T10:00:00Z'), comment(3, '2026-10-01T12:00:00Z')]
  })
  reviews: (page: number) => Promise<PullConversationPage> = async () => ({ items: [review(2, '2026-10-01T11:00:00Z')] })
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async listPullComments(_r: string, _n: number, page: number): Promise<PullConversationPage> {
    this.reads.push(`comments ${page}`); return this.comments(page)
  }
  async listPullReviews(_r: string, _n: number, page: number): Promise<PullConversationPage> {
    this.reads.push(`reviews ${page}`); return this.reviews(page)
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

describe('GitHubIssueService.pullConversation', () => {
  it('merges issue comments and reviews into one list, oldest first', async () => {
    const { service } = harness()
    const result = await service.pullConversation(request)
    expect(result).toMatchObject({ status: 'ok', truncated: false, observedAt: 1_000_000 })
    expect(result.status === 'ok' && result.items.map((item) => `${item.kind} ${item.id}`))
      .toEqual(['comment 1', 'review 2', 'comment 3'])
  })

  it('follows next pages and says truncated past the page cap', async () => {
    const { client, service } = harness()
    client.comments = async (page) => ({ items: [comment(page, `2026-10-01T10:00:0${page % 10}Z`)], nextPage: page + 1 })
    const result = await service.pullConversation(request)
    expect(result).toMatchObject({ status: 'ok', truncated: true })
    expect(client.reads.filter((read) => read.startsWith('comments'))).toHaveLength(10)
  })

  it('refuses a repository other than the project repository, and a signed-out user, with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullConversation({ ...request, repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toEqual([])
    const signedOut = harness({ code: 'not-authenticated' })
    expect(await signedOut.service.pullConversation(request)).toEqual({ status: 'refused', reason: 'signed-out' })
    expect(signedOut.client.reads).toEqual([])
  })

  it('goes through the request coordinator: a held budget sends nothing and says throttled', async () => {
    const { client, coordinator, service, now } = harness()
    coordinator.noteRateLimit('user-1', { kind: 'primary', retryAt: now() + 120_000 })
    expect(await service.pullConversation(request)).toMatchObject({ status: 'failed', reason: 'throttled' })
    expect(client.reads).toEqual([])
  })

  it('keeps the last content and marks it stale when a later read is throttled', async () => {
    const { client, service, advance, now } = harness()
    const first = await service.pullConversation(request)
    advance(31_000)
    const retryAt = now() + 60_000
    client.reviews = async () => { throw new GitHubClientError('rate-limited', 403, retryAt) }
    expect(await service.pullConversation(request)).toEqual({ ...first, stale: 'throttled', retryAt })
  })

  it('answers from memory inside the 30 s floor', async () => {
    const { client, service, advance } = harness()
    await service.pullConversation(request)
    advance(10_000)
    await service.pullConversation(request)
    expect(client.reads).toEqual(['comments 1', 'reviews 1'])
  })
})

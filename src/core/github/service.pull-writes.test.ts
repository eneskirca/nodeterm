import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { PullConversationPage, PullReviewEvent } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const sha = 'c'.repeat(40)

class Client implements GitHubIssuesClientLike {
  writes: unknown[] = []
  reads = 0
  fail?: unknown
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(repository: string, issueNumber: number, body: string): Promise<{ id: number }> {
    this.writes.push(['comment', repository, issueNumber, body])
    if (this.fail) throw this.fail
    return { id: 1 }
  }
  async reviewPull(
    repository: string, pullNumber: number, review: { event: PullReviewEvent; body: string; commitId: string }
  ): Promise<{ id: number }> {
    this.writes.push(['review', repository, pullNumber, review])
    if (this.fail) throw this.fail
    return { id: 2 }
  }
  async listPullComments(): Promise<PullConversationPage> { this.reads += 1; return { items: [] } }
  async listPullReviews(): Promise<PullConversationPage> { return { items: [] } }
}

function harness(contextError?: { code: string }) {
  let now = 1_000_000
  const client = new Client()
  const coordinator = new GitHubRequestCoordinator({ now: () => now, sleep: async () => undefined })
  let contexts = 0
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator,
    contextForProject: async (): Promise<GitHubIssueServiceContext> => {
      contexts += 1
      if (contextError) throw contextError
      return {
        localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
        credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
      }
    },
    now: () => now
  })
  const refresh = vi.spyOn(service, 'refresh').mockResolvedValue(undefined)
  return { client, coordinator, service, refresh, contexts: () => contexts, now: () => now }
}

const at = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService pull writes', () => {
  it('comments through the issue-comment call without label-mapping approval', async () => {
    const { client, service } = harness()
    expect(await service.commentOnPull({ ...at, body: 'Looks good' })).toEqual({ ok: true })
    expect(client.writes).toEqual([['comment', 'o/r', 7, 'Looks good']])
  })

  it('reviews against the head commit the node saw', async () => {
    const { client, service } = harness()
    expect(await service.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: sha })).toEqual({ ok: true })
    expect(client.writes).toEqual([['review', 'o/r', 7, { event: 'APPROVE', body: '', commitId: sha }]])
  })

  it('refuses an empty body for request-changes, comment-review and a comment before anything is resolved', async () => {
    const { client, service, contexts } = harness()
    expect(await service.reviewPull({ ...at, event: 'REQUEST_CHANGES', body: '  ', headSha: sha }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(await service.reviewPull({ ...at, event: 'COMMENT', body: '', headSha: sha }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(await service.commentOnPull({ ...at, body: '\n' })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: '' }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(client.writes).toEqual([])
    expect(contexts()).toBe(0)
  })

  it('refuses an unapproved repository, a signed-out user and another repository with no request', async () => {
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.commentOnPull({ ...at, body: 'x' })).toEqual({ ok: false, reason: 'not-approved' })
    expect(unapproved.client.writes).toEqual([])
    const signedOut = harness({ code: 'not-authenticated' })
    expect(await signedOut.service.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: sha }))
      .toEqual({ ok: false, reason: 'signed-out' })
    const { client, service } = harness()
    expect(await service.commentOnPull({ ...at, repository: 'evil/other', body: 'x' }))
      .toEqual({ ok: false, reason: 'not-approved' })
    expect(client.writes).toEqual([])
  })

  it('goes through the coordinator mutation path: a held budget sends nothing and says throttled', async () => {
    const { client, coordinator, service, now } = harness()
    coordinator.noteRateLimit('user-1', { kind: 'primary', retryAt: now() + 3_600_000 })
    expect(await service.commentOnPull({ ...at, body: 'x' })).toEqual({ ok: false, reason: 'throttled' })
    expect(client.writes).toEqual([])
  })

  it.each([
    [new GitHubClientError('own-pull', 422), 'own-pull'],
    [new GitHubClientError('insufficient-permission', 403), 'forbidden'],
    [new GitHubClientError('request-failed', 404), 'forbidden'],
    [new GitHubClientError('request-failed', 401), 'signed-out'],
    [new GitHubClientError('request-failed', 422), 'validation'],
    [new GitHubClientError('rate-limited', 429, 2_000_000), 'throttled'],
    [new GitHubClientError('request-failed', 502), 'network'],
    [new GitHubClientError('request-failed'), 'network']
  ] as const)('maps %s to %s', async (error, reason) => {
    const { client, service, refresh } = harness()
    client.fail = error
    expect(await service.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: sha })).toEqual({ ok: false, reason })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a landed write refreshes the board and the node reads fresh past its 30 s floor', async () => {
    const { client, service, refresh } = harness()
    await service.pullConversation(at)
    await service.commentOnPull({ ...at, body: 'x' })
    expect(refresh).toHaveBeenCalledWith({ projectId: 'p' })
    await service.pullConversation(at)
    expect(client.reads).toBe(2)
  })
})

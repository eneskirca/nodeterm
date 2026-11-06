import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}

const detail = (title = 'Add the pull node'): GitHubPullDetail => ({
  number: 7, title, body: 'Body', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
})

class Client implements GitHubIssuesClientLike {
  reads = 0
  next: () => Promise<GitHubPullDetail> = async () => detail()
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async getPull(): Promise<GitHubPullDetail> { this.reads += 1; return this.next() }
}

function harness(contextError?: { code: string }, userId = 'user-1') {
  let now = 1_000_000
  const client = new Client()
  const coordinator = new GitHubRequestCoordinator({ now: () => now })
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId, client, columnColors: {}, mappingApproved: false
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

describe('GitHubIssueService.pullDetail', () => {
  it('reads the pull request of the approved repository', async () => {
    const { client, service } = harness()
    expect(await service.pullDetail(request)).toEqual({ status: 'ok', detail: detail(), observedAt: 1_000_000 })
    expect(client.reads).toBe(1)
  })

  it('marks the pull request as the viewer\'s own when the author is the signed-in user', async () => {
    const { client, service } = harness(undefined, '42')
    const mine = { ...detail(), author: { id: 42, login: 'me', avatarUrl: 'https://avatars.githubusercontent.com/u/42' } }
    client.next = async () => mine
    expect(await service.pullDetail(request)).toEqual({ status: 'ok', detail: mine, observedAt: 1_000_000, ownPull: true })
  })

  it('refuses an unapproved repository and a signed-out user with no request', async () => {
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.pullDetail(request)).toEqual({ status: 'refused', reason: 'not-approved' })
    expect(unapproved.client.reads).toBe(0)
    const signedOut = harness({ code: 'not-authenticated' })
    expect(await signedOut.service.pullDetail(request)).toEqual({ status: 'refused', reason: 'signed-out' })
    expect(signedOut.client.reads).toBe(0)
  })

  it('a background read (Watch) below the floor sends nothing; a foreground read still reads', async () => {
    for (const resource of ['core', 'graphql']) {
      const { client, coordinator, service, now } = harness()
      coordinator.noteRateSample('user-1', { resource, limit: 5_000, remaining: 10, resetAt: now() + 60_000 })
      expect(await service.pullDetail({ ...request, background: true }))
        .toEqual({ status: 'failed', reason: 'throttled', retryAt: now() + 60_000 })
      expect(client.reads).toBe(0)
      expect((await service.pullDetail(request)).status).toBe('ok')
      expect(client.reads).toBe(1)
    }
  })

  it('a background read above the floor reads as usual', async () => {
    const { client, coordinator, service, now } = harness()
    coordinator.noteRateSample('user-1', { resource: 'core', limit: 5_000, remaining: 4_000, resetAt: now() + 60_000 })
    expect((await service.pullDetail({ ...request, background: true })).status).toBe('ok')
    expect(client.reads).toBe(1)
  })

  it('refuses a node whose repository is not the project repository, with no request', async () => {
    const { client, service } = harness()
    expect(await service.pullDetail({ ...request, repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.reads).toBe(0)
  })

  it('goes through the request coordinator: a held budget sends nothing and says throttled', async () => {
    const { client, coordinator, service, now } = harness()
    coordinator.noteRateLimit('user-1', { kind: 'primary', retryAt: now() + 120_000 })
    expect(await service.pullDetail(request)).toMatchObject({ status: 'failed', reason: 'throttled' })
    expect(client.reads).toBe(0)
  })

  it('keeps the last content and marks it stale when a later read is throttled', async () => {
    const { client, service, advance, now } = harness()
    await service.pullDetail(request)
    advance(31_000)
    const retryAt = now() + 60_000
    client.next = async () => { throw new GitHubClientError('rate-limited', 403, retryAt) }
    expect(await service.pullDetail(request)).toEqual({
      status: 'ok', detail: detail(), observedAt: 1_000_000, stale: 'throttled', retryAt
    })
  })

  it('says signed out only for a 401, and unreachable for an outage', async () => {
    const { client, service, advance } = harness()
    client.next = async () => { throw new GitHubClientError('request-failed', 401) }
    expect(await service.pullDetail(request)).toEqual({ status: 'failed', reason: 'signed-out' })
    advance(1)
    client.next = async () => { throw new GitHubClientError('request-failed', 502) }
    expect(await service.pullDetail(request)).toEqual({ status: 'failed', reason: 'unreachable' })
  })

  it('answers from memory inside the 30 s floor; a failed read does not hold the floor', async () => {
    const { client, service, advance } = harness()
    await service.pullDetail(request)
    advance(10_000)
    client.next = async () => detail('Renamed')
    expect(await service.pullDetail(request)).toMatchObject({ detail: { title: 'Add the pull node' } })
    expect(client.reads).toBe(1)
    advance(21_000)
    expect(await service.pullDetail(request)).toMatchObject({ detail: { title: 'Renamed' } })
    expect(client.reads).toBe(2)

    advance(31_000)
    client.next = async () => { throw new GitHubClientError('request-failed', 502) }
    expect(await service.pullDetail(request)).toMatchObject({ stale: 'unreachable' })
    client.next = async () => detail('Back')
    expect(await service.pullDetail(request)).toMatchObject({ detail: { title: 'Back' } })
    expect(client.reads).toBe(4)
  })

  it('reads GitHub again inside the floor once an agent wrote to that pull request', async () => {
    const { client, service, advance } = harness()
    await service.pullDetail(request)
    advance(5_000)
    client.next = async () => ({ ...detail(), lifecycle: 'merged' })
    service.forgetPull('O/R', 8)
    service.forgetPull('other/repo', 7)
    expect(await service.pullDetail(request)).toMatchObject({ detail: { lifecycle: 'open' } })
    service.forgetPull('o/r', 7)
    expect(await service.pullDetail(request)).toMatchObject({ detail: { lifecycle: 'merged' } })
    service.forgetPull(undefined, 7)
    await service.pullDetail(request)
    service.forgetPull('o/r', undefined)
    await service.pullDetail(request)
    expect(client.reads).toBe(4)
  })
})

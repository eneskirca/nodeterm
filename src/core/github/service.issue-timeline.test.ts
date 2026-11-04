import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import type { GitHubAvatarFetcher } from './avatar-fetcher'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { GitHubIssueUser, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { PullTimelineItem, PullTimelinePage } from '../../shared/github-pull-timeline'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const ana: GitHubIssueUser = { id: 4, login: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/4' }
const bo: GitHubIssueUser = { id: 5, login: 'bo', avatarUrl: 'https://avatars.githubusercontent.com/u/5' }
const closed = (id: string): PullTimelineItem => ({ kind: 'closed', id, actor: ana, at: '2026-10-01T10:00:00Z' })

class Client implements GitHubIssuesClientLike {
  reads: Array<string | undefined> = []
  timeline: (after?: string) => Promise<PullTimelinePage> = async (after) => after
    ? { items: [closed('second')], openedAt: '2026-10-01T09:00:00Z' }
    : { items: [closed('first'), { kind: 'assigned', id: 'a', actor: null, at: '2026-10-01T10:00:00Z', assignee: bo }], openedAt: '2026-10-01T09:00:00Z', next: 'Y3Vyc29y' }
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<{ id: number }> { return { id: 1 } }
  async issueTimeline(_r: string, _n: number, after?: string): Promise<PullTimelinePage> {
    this.reads.push(after); return this.timeline(after)
  }
}

function harness(contextError?: { code: string }) {
  let now = 1_000_000
  const client = new Client()
  const coordinator = new GitHubRequestCoordinator({ now: () => now })
  const asked: number[][] = []
  const avatarFetcher = {
    forPage: async (users: readonly GitHubIssueUser[]) => {
      asked.push(users.map((user) => user.id))
      return { dataUrls: new Map([[4, 'data:image/png;base64,AA==']]), truncated: false }
    }
  } as unknown as GitHubAvatarFetcher
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
  })
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator,
    avatarFetcher,
    contextForProject: async () => { if (contextError) throw contextError; return context() },
    now: () => now
  })
  return { client, coordinator, service, asked, advance: (ms: number) => { now += ms }, now: () => now }
}

const request = { projectId: 'p', repository: 'o/r', issueNumber: 7 }

describe('GitHubIssueService.issueTimeline', () => {
  it('answers one page with its next cursor and the avatars of actors and assignees', async () => {
    const { service, asked } = harness()
    const result = await service.issueTimeline(request)
    expect(result).toMatchObject({
      status: 'ok', openedAt: '2026-10-01T09:00:00Z', next: 'Y3Vyc29y', avatarDataUrls: { 4: 'data:image/png;base64,AA==' }
    })
    expect(asked).toEqual([[4, 5]])
  })

  it('reads a later page by its cursor, held apart from the first page, and refuses a bad cursor', async () => {
    const { client, service } = harness()
    await service.issueTimeline(request)
    const later = await service.issueTimeline({ ...request, after: 'Y3Vyc29y' })
    expect(later.status === 'ok' && later.items.map((item) => item.id)).toEqual(['second'])
    expect(await service.issueTimeline({ ...request, after: '"}{' })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(client.reads).toEqual([undefined, 'Y3Vyc29y'])
  })

  it('refuses another repository and an unapproved one with no request', async () => {
    const { client, service } = harness()
    expect(await service.issueTimeline({ ...request, repository: 'evil/other' })).toEqual({ status: 'refused', reason: 'repository-mismatch' })
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.issueTimeline(request)).toEqual({ status: 'refused', reason: 'not-approved' })
    expect([...client.reads, ...unapproved.client.reads]).toEqual([])
  })

  it('answers from memory inside the floor, and reads again after a comment landed', async () => {
    const { client, service, advance } = harness()
    await service.issueTimeline(request)
    advance(10_000)
    await service.issueTimeline(request)
    expect(client.reads).toEqual([undefined])
    expect(await service.commentOnIssue({ ...request, body: 'On it' })).toEqual({ ok: true })
    await service.issueTimeline(request)
    expect(client.reads).toEqual([undefined, undefined])
  })
})

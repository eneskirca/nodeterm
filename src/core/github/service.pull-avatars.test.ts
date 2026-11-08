import { describe, expect, it } from 'vitest'
import { GitHubAvatarFetcher } from './avatar-fetcher'
import type { GitHubIssueCache } from './cache'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { GitHubIssueUser, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type {
  GitHubPullDetail, PullConversationPage, PullLineCommentsPage
} from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const user = (id: number): GitHubIssueUser => ({ id, login: `u${id}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` })
// u1, u2 and u4 load; u3 is refused by the avatar host.
const dataUrl = (id: number) => `data:image/png;base64,${Buffer.from(`png-${id}`).toString('base64')}`

const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: user(1),
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7',
  requestedReviewers: [user(2), user(3)]
}

class Client implements GitHubIssuesClientLike {
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async getPull(): Promise<GitHubPullDetail> { return detail }
  async listPullComments(): Promise<PullConversationPage> {
    return { items: [{ kind: 'comment', id: 1, author: user(1), body: 'hi', at: '2026-10-01T10:00:00Z', url: 'https://github.com/o/r/pull/7' }] }
  }
  async listPullReviews(): Promise<PullConversationPage> {
    return { items: [{ kind: 'review', id: 2, author: user(3), body: '', at: '2026-10-01T11:00:00Z', url: 'https://github.com/o/r/pull/7', verdict: 'approved' }] }
  }
  async listPullLineComments(): Promise<PullLineCommentsPage> {
    return { comments: [{ id: 5, reviewId: 2, author: user(4), body: 'nit', at: '2026-10-01T11:00:00Z', url: 'https://github.com/o/r/pull/7', path: 'a.ts', side: 'RIGHT', line: 1, outdated: false }] }
  }
}

function harness(withFetcher = true) {
  const avatarFetcher = new GitHubAvatarFetcher({
    fetch: async (input) => {
      const id = Number(new URL(String(input)).pathname.split('/').pop())
      return id === 3
        ? new Response('no', { status: 404 })
        : new Response(`png-${id}`, { headers: { 'content-type': 'image/png' } })
    }
  })
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client: new Client(), columnColors: {}, mappingApproved: false
  })
  return new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => 1_000_000 }),
    contextForProject: async () => context(),
    now: () => 1_000_000,
    ...(withFetcher ? { avatarFetcher } : {})
  })
}

const request = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService pull reads carry avatars', () => {
  it('attaches the author and reviewer avatars to the detail, keyed by user id, and leaves a refused one out', async () => {
    const result = await harness().pullDetail(request)
    expect(result.status === 'ok' && result.avatarDataUrls).toEqual({ 1: dataUrl(1), 2: dataUrl(2) })
  })

  it('attaches the avatar of who merged it', async () => {
    const service = harness()
    Client.prototype.getPull = async () => ({ ...detail, lifecycle: 'merged', merge: undefined, mergedBy: user(4) })
    try {
      const result = await service.pullDetail(request)
      expect(result.status === 'ok' && result.avatarDataUrls).toEqual({ 1: dataUrl(1), 2: dataUrl(2), 4: dataUrl(4) })
    } finally { Client.prototype.getPull = async () => detail }
  })

  it('attaches comment, review and line comment author avatars to the conversation', async () => {
    const result = await harness().pullConversation(request)
    expect(result.status === 'ok' && result.avatarDataUrls).toEqual({ 1: dataUrl(1), 4: dataUrl(4) })
  })

  it('carries no avatars without a fetcher', async () => {
    const result = await harness(false).pullDetail(request)
    expect(result.status === 'ok' && 'avatarDataUrls' in result).toBe(false)
  })
})

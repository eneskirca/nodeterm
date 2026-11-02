import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type {
  GitHubPullDetail, PullConversationPage, PullLineCommentWrite, PullLineDraft, PullMergeMethod, PullReviewEvent
} from '../../shared/github-pull-detail'

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
  async createPullLineComment(
    repository: string, pullNumber: number, comment: PullLineCommentWrite
  ): Promise<{ id: number }> {
    this.writes.push(['line', repository, pullNumber, comment])
    if (this.fail) throw this.fail
    return { id: 3 }
  }
  async reviewPull(
    repository: string, pullNumber: number,
    review: { event: PullReviewEvent; body: string; commitId: string; comments?: PullLineDraft[] }
  ): Promise<{ id: number }> {
    this.writes.push(['review', repository, pullNumber, review])
    if (this.fail) throw this.fail
    return { id: 2 }
  }
  async mergePull(repository: string, pullNumber: number, merge: { method: PullMergeMethod; sha: string }): Promise<void> {
    this.writes.push(['merge', repository, pullNumber, merge])
    if (this.fail) throw this.fail
  }
  methods: PullMergeMethod[] = ['squash']
  methodReads: string[] = []
  async repoMergeMethods(repository: string): Promise<PullMergeMethod[]> {
    this.methodReads.push(repository)
    if (this.fail) throw this.fail
    return this.methods
  }
  async requestPullReviewer(repository: string, pullNumber: number, login: string): Promise<void> {
    this.writes.push(['reviewer', repository, pullNumber, login])
    if (this.fail) throw this.fail
  }
  collaboratorReads: string[] = []
  async listCollaborators(repository: string) {
    this.collaboratorReads.push(repository)
    if (this.fail) throw this.fail
    return [{ id: 5, login: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/5' }]
  }
  detailReads = 0
  async getPull(): Promise<GitHubPullDetail> { this.detailReads += 1; return {} as GitHubPullDetail }
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

  it('posts a line comment at the head the node saw, and a reply by its thread id', async () => {
    const { client, service, refresh } = harness()
    const draft: PullLineDraft = { path: 'src/a.ts', line: 3, side: 'LEFT', body: 'Why?' }
    expect(await service.commentOnPullLine({ ...at, headSha: sha, comment: { ...draft, extra: 1 } as PullLineDraft }))
      .toEqual({ ok: true })
    expect(await service.commentOnPullLine({ ...at, inReplyTo: 44, body: 'Because.' })).toEqual({ ok: true })
    expect(client.writes).toEqual([
      ['line', 'o/r', 7, { commitId: sha, draft }],
      ['line', 'o/r', 7, { inReplyTo: 44, body: 'Because.' }]
    ])
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an empty body', { headSha: sha, comment: { path: 'a.ts', line: 1, side: 'RIGHT', body: ' ' } }],
    ['a body over the limit', { headSha: sha, comment: { path: 'a.ts', line: 1, side: 'RIGHT', body: 'x'.repeat(60_001) } }],
    ['a path that climbs', { headSha: sha, comment: { path: '../a.ts', line: 1, side: 'RIGHT', body: 'x' } }],
    ['line 0', { headSha: sha, comment: { path: 'a.ts', line: 0, side: 'RIGHT', body: 'x' } }],
    ['a fractional line', { headSha: sha, comment: { path: 'a.ts', line: 1.5, side: 'RIGHT', body: 'x' } }],
    ['an unknown side', { headSha: sha, comment: { path: 'a.ts', line: 1, side: 'BOTH', body: 'x' } }],
    ['no head', { headSha: '', comment: { path: 'a.ts', line: 1, side: 'RIGHT', body: 'x' } }],
    ['a reply id of 0', { inReplyTo: 0, body: 'x' }],
    ['a reply id that is text', { inReplyTo: '9', body: 'x' }],
    ['an empty reply', { inReplyTo: 9, body: '' }]
  ])('refuses a line comment with %s before anything is resolved', async (_, fields) => {
    const { client, service, contexts } = harness()
    expect(await service.commentOnPullLine({ ...at, ...fields } as never)).toEqual({ ok: false, reason: 'validation' })
    expect(client.writes).toEqual([])
    expect(contexts()).toBe(0)
  })

  it('sends the pending line comments with the review, and lets a comment-review carry only them', async () => {
    const { client, service } = harness()
    const comments: PullLineDraft[] = [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Rename this.' }]
    expect(await service.reviewPull({ ...at, event: 'COMMENT', body: '', headSha: sha, comments })).toEqual({ ok: true })
    expect(client.writes).toEqual([['review', 'o/r', 7, { event: 'COMMENT', body: '', commitId: sha, comments }]])
    expect(await service.reviewPull({ ...at, event: 'REQUEST_CHANGES', body: '', headSha: sha, comments }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(await service.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: sha, comments: [{ ...comments[0], line: -1 }] }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(await service.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: sha, comments: Array(51).fill(comments[0]) }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(client.writes).toHaveLength(1)
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
    expect(await service.commentOnPullLine({ ...at, repository: 'evil/other', inReplyTo: 9, body: 'x' }))
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

describe('GitHubIssueService merge', () => {
  it('merges with the chosen method and the head the node showed', async () => {
    const { client, service, refresh } = harness()
    expect(await service.mergePull({ ...at, method: 'squash', headSha: sha })).toEqual({ ok: true })
    expect(client.writes).toEqual([['merge', 'o/r', 7, { method: 'squash', sha }]])
    expect(refresh).toHaveBeenCalledWith({ projectId: 'p' })
  })

  it('refuses a missing head or an unknown method before anything is resolved', async () => {
    const { client, service, contexts } = harness()
    expect(await service.mergePull({ ...at, method: 'squash', headSha: '' })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.mergePull({ ...at, method: 'octopus' as PullMergeMethod, headSha: sha }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(client.writes).toEqual([])
    expect(contexts()).toBe(0)
  })

  it('refuses another repository with no request', async () => {
    const { client, service } = harness()
    expect(await service.mergePull({ ...at, repository: 'evil/other', method: 'merge', headSha: sha }))
      .toEqual({ ok: false, reason: 'not-approved' })
    expect(client.writes).toEqual([])
  })

  it('a 409 is head-moved, and the reload that follows reads fresh past the floor', async () => {
    const { client, service, refresh } = harness()
    await service.pullDetail(at)
    client.fail = new GitHubClientError('request-failed', 409)
    expect(await service.mergePull({ ...at, method: 'merge', headSha: sha })).toEqual({ ok: false, reason: 'head-moved' })
    expect(refresh).not.toHaveBeenCalled()
    await service.pullDetail(at)
    expect(client.detailReads).toBe(2)
  })

  it('a 405 is not-mergeable', async () => {
    const { client, service } = harness()
    client.fail = new GitHubClientError('request-failed', 405)
    expect(await service.mergePull({ ...at, method: 'merge', headSha: sha })).toEqual({ ok: false, reason: 'not-mergeable' })
  })

  it('reads the allowed methods of the project\'s repository only', async () => {
    const { client, service } = harness()
    expect(await service.repoMergeMethods({ projectId: 'p', repository: 'o/r' })).toEqual({ status: 'ok', methods: ['squash'] })
    expect(await service.repoMergeMethods({ projectId: 'p', repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.methodReads).toEqual(['o/r'])
  })

  it('holds the allowed methods per repository: a second node of the same repository reads nothing', async () => {
    const { client, service } = harness()
    await service.repoMergeMethods({ projectId: 'p', repository: 'o/r' })
    expect(await service.repoMergeMethods({ projectId: 'p', repository: 'O/R' })).toEqual({ status: 'ok', methods: ['squash'] })
    expect(client.methodReads).toEqual(['o/r'])
  })

  it('names a refusal and a failure of the methods read like a pull read', async () => {
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.repoMergeMethods({ projectId: 'p', repository: 'o/r' }))
      .toEqual({ status: 'refused', reason: 'not-approved' })
    const { client, service } = harness()
    client.fail = new GitHubClientError('request-failed', 502)
    expect(await service.repoMergeMethods({ projectId: 'p', repository: 'o/r' }))
      .toEqual({ status: 'failed', reason: 'unreachable' })
  })
})

describe('GitHubIssueService request reviewer', () => {
  it('requests a reviewer on the project\'s repository and refreshes', async () => {
    const { client, service, refresh } = harness()
    expect(await service.requestPullReviewer({ ...at, reviewer: 'ana' })).toEqual({ ok: true })
    expect(client.writes).toEqual([['reviewer', 'o/r', 7, 'ana']])
    expect(refresh).toHaveBeenCalledWith({ projectId: 'p' })
  })

  it('refuses a bad login before anything is resolved, and another repository with no request', async () => {
    const { client, service, contexts } = harness()
    expect(await service.requestPullReviewer({ ...at, reviewer: 'a/b' })).toEqual({ ok: false, reason: 'validation' })
    expect(contexts()).toBe(0)
    expect(await service.requestPullReviewer({ ...at, repository: 'evil/other', reviewer: 'ana' }))
      .toEqual({ ok: false, reason: 'not-approved' })
    expect(client.writes).toEqual([])
  })

  it('reads the collaborators of the project\'s repository once, refused like a pull read', async () => {
    const { client, service } = harness()
    const ok = await service.repoCollaborators({ projectId: 'p', repository: 'o/r' })
    expect(ok).toMatchObject({ status: 'ok', users: [{ login: 'ana' }] })
    await service.repoCollaborators({ projectId: 'p', repository: 'O/R' })
    expect(await service.repoCollaborators({ projectId: 'p', repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.collaboratorReads).toEqual(['o/r'])
  })
})

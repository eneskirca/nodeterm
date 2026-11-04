import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike, type PullSuggestionComment } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const head = 'c'.repeat(40)
const blob = 'f'.repeat(40)

class Client implements GitHubIssuesClientLike {
  calls: unknown[] = []
  fail?: unknown
  putFail?: unknown
  detail: Partial<GitHubPullDetail> = { head: { ref: 'feat/x', sha: head } }
  comment: PullSuggestionComment = {
    pullNumber: 7, path: 'src/a.ts', side: 'RIGHT', line: 3, startLine: 2, commitId: head,
    body: 'Nit:\n```suggestion\nconst b = 2\n```', author: 'ana'
  }
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async setReviewThreadResolved(repository: string, pullNumber: number, threadId: number, resolved: boolean): Promise<void> {
    this.calls.push(['resolve', repository, pullNumber, threadId, resolved])
    if (this.fail) throw this.fail
  }
  async getPull(): Promise<GitHubPullDetail> { this.calls.push('detail'); return this.detail as GitHubPullDetail }
  async pullSuggestionComment(repository: string, commentId: number): Promise<PullSuggestionComment> {
    this.calls.push(['comment', repository, commentId])
    return this.comment
  }
  async fileBlobAt(repository: string, path: string, ref: string): Promise<{ sha: string; text: string }> {
    this.calls.push(['blob', repository, path, ref])
    return { sha: blob, text: 'one\nconst a = 1\nconst a2 = 1\nfour\n' }
  }
  async putFile(repository: string, file: { path: string; branch: string; sha: string; text: string; message: string }): Promise<void> {
    this.calls.push(['put', repository, file])
    if (this.putFail) throw this.putFail
  }
}

function harness() {
  const client = new Client()
  const coordinator = new GitHubRequestCoordinator({ now: () => 1_000_000, sleep: async () => undefined })
  let contexts = 0
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator,
    contextForProject: async (): Promise<GitHubIssueServiceContext> => {
      contexts += 1
      return {
        localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
        credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
      }
    },
    now: () => 1_000_000
  })
  const refresh = vi.spyOn(service, 'refresh').mockResolvedValue(undefined)
  return { client, service, refresh, contexts: () => contexts }
}

const at = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService setReviewThreadResolved', () => {
  it('resolves and unresolves the thread named by its first comment, then refreshes', async () => {
    const { client, service, refresh } = harness()
    expect(await service.setReviewThreadResolved({ ...at, threadId: 44, resolved: true })).toEqual({ ok: true })
    expect(await service.setReviewThreadResolved({ ...at, threadId: 44, resolved: false })).toEqual({ ok: true })
    expect(client.calls).toEqual([['resolve', 'o/r', 7, 44, true], ['resolve', 'o/r', 7, 44, false]])
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('refuses a bad thread id, a non-boolean and another repository with no request', async () => {
    const { client, service, contexts } = harness()
    expect(await service.setReviewThreadResolved({ ...at, threadId: 0, resolved: true })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.setReviewThreadResolved({ ...at, threadId: 4, resolved: 'y' as unknown as boolean }))
      .toEqual({ ok: false, reason: 'validation' })
    expect(contexts()).toBe(0)
    expect(await service.setReviewThreadResolved({ ...at, repository: 'evil/x', threadId: 4, resolved: true }))
      .toEqual({ ok: false, reason: 'not-approved' })
    expect(client.calls).toEqual([])
  })

  it('maps a GitHub refusal like every pull write', async () => {
    const { client, service } = harness()
    client.fail = new GitHubClientError('request-failed', 403)
    expect(await service.setReviewThreadResolved({ ...at, threadId: 4, resolved: true })).toEqual({ ok: false, reason: 'forbidden' })
  })
})

describe('GitHubIssueService applySuggestion', () => {
  const apply = { ...at, headSha: head, commentId: 91 }

  it('commits the suggestion to the head branch, pinned to the blob SHA read at the head the user saw', async () => {
    const { client, service, refresh } = harness()
    expect(await service.applySuggestion(apply)).toEqual({ ok: true })
    expect(client.calls).toEqual([
      'detail',
      ['comment', 'o/r', 91],
      ['blob', 'o/r', 'src/a.ts', head],
      ['put', 'o/r', {
        path: 'src/a.ts', branch: 'feat/x', sha: blob, text: 'one\nconst b = 2\nfour\n',
        message: 'Apply suggestion from review by ana'
      }]
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refuses a fork head with from-fork before it reads the comment', async () => {
    const { client, service } = harness()
    client.detail = { ...client.detail, fromFork: true }
    expect(await service.applySuggestion(apply)).toEqual({ ok: false, reason: 'from-fork' })
    expect(client.calls).toEqual(['detail'])
  })

  it('answers suggestion-stale when GitHub refuses the blob SHA (409)', async () => {
    const { client, service } = harness()
    client.putFail = new GitHubClientError('request-failed', 409)
    expect(await service.applySuggestion(apply)).toEqual({ ok: false, reason: 'suggestion-stale' })
  })

  it('answers suggestion-stale when the comment sits on another head or its lines left the file', async () => {
    const { client, service } = harness()
    client.comment = { ...client.comment, commitId: 'd'.repeat(40) }
    expect(await service.applySuggestion(apply)).toEqual({ ok: false, reason: 'suggestion-stale' })
    client.comment = { ...client.comment, commitId: head, startLine: null, line: 9 }
    expect(await service.applySuggestion(apply)).toEqual({ ok: false, reason: 'suggestion-stale' })
    expect(client.calls.some((call) => Array.isArray(call) && call[0] === 'put')).toBe(false)
  })

  it('refuses a comment with no suggestion, on the base side, outdated or on another PR', async () => {
    const { client, service } = harness()
    for (const change of [{ body: 'no block' }, { side: 'LEFT' as const }, { line: null }, { pullNumber: 8 }]) {
      client.comment = { ...new Client().comment, ...change }
      expect(await service.applySuggestion(apply)).toEqual({ ok: false, reason: 'validation' })
    }
    expect(client.calls.some((call) => Array.isArray(call) && call[0] === 'put')).toBe(false)
  })

  it('refuses a bad head SHA or comment id with no request', async () => {
    const { service, contexts } = harness()
    expect(await service.applySuggestion({ ...apply, headSha: 'main' })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.applySuggestion({ ...apply, commentId: -1 })).toEqual({ ok: false, reason: 'validation' })
    expect(contexts()).toBe(0)
  })

  it('a commit message without an author says so plainly', async () => {
    const { client, service } = harness()
    client.comment = { ...client.comment, author: null }
    await service.applySuggestion(apply)
    expect(client.calls.at(-1)).toMatchObject(['put', 'o/r', { message: 'Apply suggestion from review' }])
  })
})

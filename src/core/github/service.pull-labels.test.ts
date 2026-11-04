// The sidebar's label and assignee writes, and the repository label list the "Add label" pick reads.
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}

class Client implements GitHubIssuesClientLike {
  writes: unknown[] = []
  labelReads: unknown[] = []
  fail?: unknown
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(repository: string, options: { page: number; perPage: number }) {
    this.labelReads.push([repository, options])
    if (this.fail) throw this.fail
    return { items: [{ id: 1, name: 'bug', color: 'd73a4a', description: null }] }
  }
  async setPullLabel(repository: string, pullNumber: number, label: string, add: boolean): Promise<void> {
    this.writes.push(['label', repository, pullNumber, label, add])
    if (this.fail) throw this.fail
  }
  async setPullAssignee(repository: string, pullNumber: number, login: string, add: boolean): Promise<void> {
    this.writes.push(['assignee', repository, pullNumber, login, add])
    if (this.fail) throw this.fail
  }
}

function harness(contextError?: { code: string }) {
  const client = new Client()
  let contexts = 0
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => 1_000_000, sleep: async () => undefined }),
    contextForProject: async (): Promise<GitHubIssueServiceContext> => {
      contexts += 1
      if (contextError) throw contextError
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

describe('GitHubIssueService pull labels and assignees', () => {
  it('adds and removes a label and an assignee on the project\'s repository, refreshing the board each time', async () => {
    const { client, service, refresh } = harness()
    expect(await service.setPullLabels({ ...at, label: 'bug', add: true })).toEqual({ ok: true })
    expect(await service.setPullLabels({ ...at, label: 'bug', add: false })).toEqual({ ok: true })
    expect(await service.setPullAssignees({ ...at, login: 'ana', add: true })).toEqual({ ok: true })
    expect(await service.setPullAssignees({ ...at, login: 'ana', add: false })).toEqual({ ok: true })
    expect(client.writes).toEqual([
      ['label', 'o/r', 7, 'bug', true], ['label', 'o/r', 7, 'bug', false],
      ['assignee', 'o/r', 7, 'ana', true], ['assignee', 'o/r', 7, 'ana', false]
    ])
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('refuses before any call when the repository is not approved, or is another one', async () => {
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.setPullLabels({ ...at, label: 'bug', add: true })).toEqual({ ok: false, reason: 'not-approved' })
    expect(await unapproved.service.setPullAssignees({ ...at, login: 'ana', add: true })).toEqual({ ok: false, reason: 'not-approved' })
    expect(unapproved.client.writes).toEqual([])
    const { client, service } = harness()
    expect(await service.setPullLabels({ ...at, repository: 'evil/other', label: 'bug', add: true }))
      .toEqual({ ok: false, reason: 'not-approved' })
    expect(client.writes).toEqual([])
  })

  it('refuses a bad label, login or flag before anything is resolved', async () => {
    const { client, service, contexts } = harness()
    expect(await service.setPullLabels({ ...at, label: ' ', add: true })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.setPullLabels({ ...at, label: 'bug', add: 1 as unknown as boolean })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.setPullAssignees({ ...at, login: 'a/b', add: true })).toEqual({ ok: false, reason: 'validation' })
    expect(contexts()).toBe(0)
    expect(client.writes).toEqual([])
  })

  it('maps a failed write to a reason the node has a sentence for, and does not refresh', async () => {
    const { client, service, refresh } = harness()
    for (const [fail, reason] of [
      [new GitHubClientError('insufficient-permission', 403), 'forbidden'],
      [new GitHubClientError('request-failed', 422), 'validation'],
      [new GitHubClientError('rate-limited', 429, Date.now() + 60_000), 'throttled']
    ] as const) {
      client.fail = fail
      expect(await service.setPullAssignees({ ...at, login: 'ana', add: true })).toEqual({ ok: false, reason })
    }
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reads the repository\'s labels once as name and color, refused like a pull read', async () => {
    const { client, service } = harness()
    expect(await service.repoLabels({ projectId: 'p', repository: 'o/r' }))
      .toEqual({ status: 'ok', labels: [{ name: 'bug', color: 'd73a4a' }] })
    await service.repoLabels({ projectId: 'p', repository: 'O/R' })
    expect(await service.repoLabels({ projectId: 'p', repository: 'evil/other' }))
      .toEqual({ status: 'refused', reason: 'repository-mismatch' })
    expect(client.labelReads).toEqual([['o/r', { page: 1, perPage: 100 }]])
  })
})

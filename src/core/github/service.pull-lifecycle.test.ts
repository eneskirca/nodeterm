// The merge box's lifecycle writes: close or reopen, mark a draft ready, and delete the head branch after merge.
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}

const merged: GitHubPullDetail = {
  number: 7, title: 't', body: '', lifecycle: 'merged', author: null,
  base: { ref: 'main', sha: 'a'.repeat(40) }, head: { ref: 'feat/x', sha: 'b'.repeat(40) },
  additions: 0, deletions: 0, changedFiles: 0, url: 'https://github.com/o/r/pull/7'
}

class Client implements GitHubIssuesClientLike {
  writes: unknown[] = []
  pull: GitHubPullDetail = merged
  defaultBranch = 'main'
  fail?: unknown
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async getPull() { return this.pull }
  async pullForBranch() { return { defaultBranch: this.defaultBranch } }
  async setPullState(repository: string, pullNumber: number, open: boolean): Promise<void> {
    this.writes.push(['state', repository, pullNumber, open])
    if (this.fail) throw this.fail
  }
  async markPullReady(repository: string, pullNumber: number): Promise<void> {
    this.writes.push(['ready', repository, pullNumber])
    if (this.fail) throw this.fail
  }
  async deleteBranchRef(repository: string, branch: string): Promise<void> {
    this.writes.push(['delete', repository, branch])
    if (this.fail) throw this.fail
  }
}

function harness(contextError?: { code: string }) {
  const client = new Client()
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => 1_000_000, sleep: async () => undefined }),
    contextForProject: async (): Promise<GitHubIssueServiceContext> => {
      if (contextError) throw contextError
      return {
        localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
        credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
      }
    },
    now: () => 1_000_000
  })
  const refresh = vi.spyOn(service, 'refresh').mockResolvedValue(undefined)
  return { client, service, refresh }
}

const at = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService pull lifecycle', () => {
  it('closes, reopens and marks ready on the project\'s repository, refreshing the board each time', async () => {
    const { client, service, refresh } = harness()
    expect(await service.setPullState({ ...at, open: false })).toEqual({ ok: true })
    expect(await service.setPullState({ ...at, open: true })).toEqual({ ok: true })
    expect(await service.markPullReady(at)).toEqual({ ok: true })
    expect(client.writes).toEqual([['state', 'o/r', 7, false], ['state', 'o/r', 7, true], ['ready', 'o/r', 7]])
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('deletes the head branch of a merged PR from this repository', async () => {
    const { client, service, refresh } = harness()
    expect(await service.deleteHeadBranch(at)).toEqual({ ok: true })
    expect(client.writes).toEqual([['delete', 'o/r', 'feat/x']])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('never deletes the head of an unmerged PR, a fork head or the default branch', async () => {
    for (const [pull, reason] of [
      [{ ...merged, lifecycle: 'open' }, 'validation'],
      [{ ...merged, lifecycle: 'closed' }, 'validation'],
      [{ ...merged, fromFork: true }, 'from-fork'],
      [{ ...merged, head: { ref: 'main', sha: 'b'.repeat(40) }, base: { ref: 'release', sha: 'a'.repeat(40) } }, 'validation']
    ] as const) {
      const { client, service } = harness()
      client.pull = pull as GitHubPullDetail
      expect(await service.deleteHeadBranch(at)).toEqual({ ok: false, reason })
      expect(client.writes).toEqual([])
    }
  })

  it('maps a branch GitHub will not delete (422) to branch-protected', async () => {
    const { client, service, refresh } = harness()
    client.fail = new GitHubClientError('request-failed', 422)
    expect(await service.deleteHeadBranch(at)).toEqual({ ok: false, reason: 'branch-protected' })
    client.fail = new GitHubClientError('insufficient-permission', 403)
    expect(await service.deleteHeadBranch(at)).toEqual({ ok: false, reason: 'forbidden' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refuses before any call when the repository is not approved, or is another one, or the flag is bad', async () => {
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.setPullState({ ...at, open: false })).toEqual({ ok: false, reason: 'not-approved' })
    expect(await unapproved.service.markPullReady(at)).toEqual({ ok: false, reason: 'not-approved' })
    expect(await unapproved.service.deleteHeadBranch(at)).toEqual({ ok: false, reason: 'not-approved' })
    expect(unapproved.client.writes).toEqual([])
    const { client, service } = harness()
    expect(await service.deleteHeadBranch({ ...at, repository: 'evil/other' })).toEqual({ ok: false, reason: 'not-approved' })
    expect(await service.setPullState({ ...at, open: 'yes' as unknown as boolean })).toEqual({ ok: false, reason: 'validation' })
    expect(client.writes).toEqual([])
  })

  it('maps a failed close to a reason the node has a sentence for', async () => {
    const { client, service } = harness()
    client.fail = new GitHubClientError('request-failed', 422)
    expect(await service.setPullState({ ...at, open: true })).toEqual({ ok: false, reason: 'validation' })
  })
})

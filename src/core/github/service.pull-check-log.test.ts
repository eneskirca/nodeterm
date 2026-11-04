// The Checks tab's Actions extras: a failed job's log tail (a read) and "Re-run failed" (a write).
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullChecksResult } from '../../shared/github-pull-status'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const checks: GitHubPullChecksResult = {
  status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, checks: [
    { name: 'test', state: 'failed', url: 'https://github.com/o/r/actions/runs/12/job/34' },
    { name: 'build', state: 'passed', url: 'https://github.com/o/r/actions/runs/12/job/35' },
    { name: 'external', state: 'failed', url: 'https://ci.example/o/r/1' }
  ]
}

class Client implements GitHubIssuesClientLike {
  calls: unknown[] = []
  fail?: unknown
  async listIssues(): Promise<never> { throw new Error('unused') }
  async issuesHeartbeat(): Promise<never> { throw new Error('unused') }
  async getIssue(): Promise<never> { throw new Error('unused') }
  async updateIssue(): Promise<never> { throw new Error('unused') }
  async createLabel(): Promise<never> { throw new Error('unused') }
  async createIssue(): Promise<never> { throw new Error('unused') }
  async createIssueComment(): Promise<never> { throw new Error('unused') }
  async listRepositoryLabels(): Promise<never> { throw new Error('unused') }
  async pullRequestChecks() { return checks }
  async jobLogTail(repository: string, jobId: number): Promise<string[]> {
    this.calls.push(['log', repository, jobId])
    if (this.fail) throw this.fail
    return ['✗ fails', '##[error]exit 1']
  }
  async rerunFailedJobs(repository: string, runId: number): Promise<void> {
    this.calls.push(['rerun', repository, runId])
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

describe('GitHubIssueService.pullCheckLog', () => {
  it('reads the log tail of a job that is one of the PR head checks', async () => {
    const { client, service } = harness()
    expect(await service.pullCheckLog({ ...at, jobId: 34 })).toEqual({
      status: 'ok', lines: ['✗ fails', '##[error]exit 1'], observedAt: 1_000_000
    })
    expect(client.calls).toEqual([['log', 'o/r', 34]])
  })

  it('refuses a job that is not one of this PR checks, another repository or a bad id, with no log read', async () => {
    const { client, service } = harness()
    expect(await service.pullCheckLog({ ...at, jobId: 99 })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(await service.pullCheckLog({ ...at, jobId: 'x' as unknown as number })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(await service.pullCheckLog({ ...at, repository: 'evil/other', jobId: 34 })).toEqual({ status: 'refused', reason: 'not-configured' })
    expect(client.calls).toEqual([])
  })

  it('answers a failed read as failed', async () => {
    const { client, service } = harness()
    client.fail = new GitHubClientError('request-failed', 404)
    expect(await service.pullCheckLog({ ...at, jobId: 34 })).toMatchObject({ status: 'failed' })
  })
})

describe('GitHubIssueService.rerunFailedJobs', () => {
  it('re-runs the failed jobs of a run that has a failed check on the head, and refreshes the board', async () => {
    const { client, service, refresh } = harness()
    expect(await service.rerunFailedJobs({ ...at, runId: 12 })).toEqual({ ok: true })
    expect(client.calls).toEqual([['rerun', 'o/r', 12]])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refuses a run with no failed check of this PR, a bad id, another repository or an unapproved one', async () => {
    const { client, service } = harness()
    expect(await service.rerunFailedJobs({ ...at, runId: 13 })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.rerunFailedJobs({ ...at, runId: 0 })).toEqual({ ok: false, reason: 'validation' })
    expect(await service.rerunFailedJobs({ ...at, repository: 'evil/other', runId: 12 })).toEqual({ ok: false, reason: 'not-approved' })
    expect(client.calls).toEqual([])
    const unapproved = harness({ code: 'not-approved' })
    expect(await unapproved.service.rerunFailedJobs({ ...at, runId: 12 })).toEqual({ ok: false, reason: 'not-approved' })
    expect(unapproved.client.calls).toEqual([])
  })

  it('maps a refused re-run to a reason the node has a sentence for', async () => {
    const { client, service } = harness()
    client.fail = new GitHubClientError('insufficient-permission', 403)
    expect(await service.rerunFailedJobs({ ...at, runId: 12 })).toEqual({ ok: false, reason: 'forbidden' })
  })
})

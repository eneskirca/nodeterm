// Edge cases of the pull node's service: a deleted PR, offline, an empty or runaway file list, and one
// failure table for every user-click write. Same fake-client style as service.pull-writes.test.ts.
import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubClientError } from './client'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail, PullFilesPage } from '../../shared/github-pull-detail'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const SHA = 'c'.repeat(40)
const detail = (): GitHubPullDetail => ({
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: SHA },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
})

// ponytail: a Proxy fake; every client method the test does not set throws `fail` (or 'unused').
function harness(methods: Record<string, (...args: never[]) => Promise<unknown>> = {}, fail?: unknown) {
  const calls: string[] = []
  const client = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' || name === 'then' ? undefined : async (...args: never[]) => {
      calls.push(name)
      if (methods[name]) return methods[name](...args)
      throw fail ?? new Error('unused')
    }
  }) as GitHubIssuesClientLike
  const now = 1_000_000
  const service = new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => now, sleep: async () => undefined }),
    contextForProject: async (): Promise<GitHubIssueServiceContext> => ({
      localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
      credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
    }),
    now: () => now
  })
  service.refresh = async () => undefined
  return { service, calls }
}

const at = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('reads', () => {
  it('offline: the read says unreachable, never signed out', async () => {
    const { service } = harness({}, new GitHubClientError('request-failed'))
    expect(await service.pullDetail(at)).toEqual({ status: 'failed', reason: 'unreachable' })
  })

  it('a 403 that is not a rate limit says signed out (the classifier\'s rule for a credential refusal)', async () => {
    const { service } = harness({}, new GitHubClientError('insufficient-permission', 403))
    expect(await service.pullDetail(at)).toEqual({ status: 'failed', reason: 'signed-out' })
  })

  // Bug: service.ts:299 pullReadFailure folds a 404 (PR deleted, or no access) into 'unreachable',
  // so the node tells the user to check the connection for a pull request that is gone.
  it.fails('a deleted pull request (404) is not reported as a connection problem', async () => {
    const { service } = harness({}, new GitHubClientError('request-failed', 404))
    const result = await service.pullDetail(at)
    expect(result.status === 'failed' && result.reason).not.toBe('unreachable')
  })

  it('an empty pull request (0 files) lists nothing and is not truncated', async () => {
    const { service } = harness({ listPullFiles: async () => ({ files: [] }) })
    expect(await service.pullFiles(at)).toMatchObject({ status: 'ok', files: [], truncated: false })
  })

  // Bug: service.ts:1239 pages files until 300 are held; a page that brings none but names a next page
  // (a buggy or hostile answer) never ends the loop. Pinned with a fake that gives up after 10 pages.
  it.fails('a file list that names a next page but brings no files stops by itself', async () => {
    let pages = 0
    const { service } = harness({
      listPullFiles: async (): Promise<PullFilesPage> => {
        pages += 1
        if (pages > 10) throw new Error('runaway pagination')
        return { files: [], nextPage: pages + 1 }
      }
    })
    expect(await service.pullFiles(at)).toMatchObject({ status: 'ok' })
    expect(pages).toBeLessThanOrEqual(4)
  })
})

/** Every write a user's click makes on the pull node, with a request the service accepts. */
const WRITES: Array<[string, (s: GitHubIssueService) => Promise<unknown>]> = [
  ['comment', (s) => s.commentOnPull({ ...at, body: 'x' })],
  ['line comment', (s) => s.commentOnPullLine({ ...at, inReplyTo: 9, body: 'x' })],
  ['approve', (s) => s.reviewPull({ ...at, event: 'APPROVE', body: '', headSha: SHA })],
  ['merge', (s) => s.mergePull({ ...at, method: 'squash', headSha: SHA })],
  ['update branch', (s) => s.updatePullBranch({ ...at, headSha: SHA })],
  ['auto-merge on', (s) => s.enablePullAutoMerge({ ...at, method: 'merge', headSha: SHA })],
  ['auto-merge off', (s) => s.disablePullAutoMerge(at)],
  ['viewed', (s) => s.setFileViewed({ ...at, path: 'a.ts', viewed: true })],
  ['resolve thread', (s) => s.setReviewThreadResolved({ ...at, threadId: 4, resolved: true })],
  ['apply suggestion', (s) => s.applySuggestion({ ...at, headSha: SHA, commentId: 4 })],
  ['request reviewer', (s) => s.requestPullReviewer({ ...at, reviewer: 'ana' })],
  ['label', (s) => s.setPullLabels({ ...at, label: 'bug', add: true })],
  ['assignee', (s) => s.setPullAssignees({ ...at, login: 'ana', add: true })],
  ['close', (s) => s.setPullState({ ...at, open: false })],
  ['ready', (s) => s.markPullReady(at)],
  ['delete branch', (s) => s.deleteHeadBranch(at)]
]

const FAILURES: Array<[string, unknown, string]> = [
  ['401', new GitHubClientError('request-failed', 401), 'signed-out'],
  ['403 no write access', new GitHubClientError('insufficient-permission', 403), 'forbidden'],
  ['404 PR gone or hidden', new GitHubClientError('request-failed', 404), 'forbidden'],
  ['429 rate limit', new GitHubClientError('rate-limited', 429, 2_000_000), 'throttled'],
  ['403 primary rate limit', new GitHubClientError('rate-limited', 403, 2_000_000, 'core'), 'throttled'],
  ['offline', new GitHubClientError('request-failed'), 'network'],
  ['502', new GitHubClientError('request-failed', 502), 'network']
]

describe('every pull write maps a GitHub failure the same way', () => {
  for (const [name, write] of WRITES) {
    it.each(FAILURES)(`${name}: %s`, async (_label, error, reason) => {
      const { service } = harness({}, error)
      expect(await write(service)).toEqual({ ok: false, reason })
    })
  }
})

describe('fork heads', () => {
  const fork = async () => ({ ...detail(), lifecycle: 'merged' as const, fromFork: true as const })

  it('apply suggestion on a fork head is from-fork, with no comment read and no commit', async () => {
    const { service, calls } = harness({ getPull: fork })
    expect(await service.applySuggestion({ ...at, headSha: SHA, commentId: 4 })).toEqual({ ok: false, reason: 'from-fork' })
    expect(calls).toEqual(['getPull'])
  })

  it('delete branch on a merged fork head is refused with no delete', async () => {
    const { service, calls } = harness({ getPull: fork })
    expect(await service.deleteHeadBranch(at)).toMatchObject({ ok: false })
    expect(calls).not.toContain('deleteBranchRef')
  })
})

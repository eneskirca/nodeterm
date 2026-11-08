import { describe, expect, it } from 'vitest'
import type { GitHubIssueCache } from './cache'
import { GitHubIssueService, type GitHubIssueServiceContext, type GitHubIssuesClientLike } from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { GitHubIssueUser, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'
import type { GitHubPullDetail } from '../../shared/github-pull-detail'
import type { PullSidebarRead } from '../../shared/github-pull-sidebar'

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r', columnMappings: [], completionColumnId: undefined, revision: 'mapping-1'
}
const user = (id: number): GitHubIssueUser => ({ id, login: `u${id}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` })
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: user(1),
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
}

function harness(sidebar?: () => Promise<PullSidebarRead>) {
  const client: GitHubIssuesClientLike = {
    listIssues: async () => { throw new Error('unused') },
    issuesHeartbeat: async () => { throw new Error('unused') },
    getIssue: async () => { throw new Error('unused') },
    updateIssue: async () => { throw new Error('unused') },
    listRepositoryLabels: async () => { throw new Error('unused') },
    createLabel: async () => { throw new Error('unused') },
    createIssue: async () => { throw new Error('unused') },
    createIssueComment: async () => { throw new Error('unused') },
    getPull: async () => detail,
    ...(sidebar ? { pullSidebar: sidebar } : {})
  }
  const context = (): GitHubIssueServiceContext => ({
    localApprovalId: 'local-1', projectId: 'p', repository: 'o/r', config, controlRevision: 1,
    credentialGeneration: 1, userId: 'user-1', client, columnColors: {}, mappingApproved: false
  })
  return new GitHubIssueService({
    cache: {} as GitHubIssueCache,
    coordinator: new GitHubRequestCoordinator({ now: () => 1_000_000 }),
    contextForProject: async () => context(),
    now: () => 1_000_000
  })
}

const request = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('GitHubIssueService pullDetail sidebar', () => {
  it('merges requested reviewers and latest reviews: a re-requested reviewer is pending, with the earlier verdict', async () => {
    const result = await harness(async () => ({
      requested: [user(2), user(4)],
      reviews: [{ user: user(2), verdict: 'changes-requested' }, { user: user(3), verdict: 'approved' }],
      labels: [{ name: 'bug', color: 'd73a4a' }]
    })).pullDetail(request)
    expect(result.status === 'ok' && result.detail.sidebar).toEqual({
      reviewers: [
        { user: user(3), state: 'approved' },
        { user: user(2), state: 'pending', previous: 'changes-requested' },
        { user: user(4), state: 'pending' }
      ],
      labels: [{ name: 'bug', color: 'd73a4a' }]
    })
  })

  it('keeps the detail when the sidebar read fails, without a sidebar', async () => {
    const result = await harness(async () => { throw new Error('boom') }).pullDetail(request)
    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.detail.sidebar).toBeUndefined()
  })

  it('reads no sidebar from a client without that read', async () => {
    const result = await harness().pullDetail(request)
    expect(result.status === 'ok' && 'sidebar' in result.detail).toBe(false)
  })
})

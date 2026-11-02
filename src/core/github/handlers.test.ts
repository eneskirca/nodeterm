import { describe, expect, it } from 'vitest'
import { fakePlatform } from '../platform-fake'
import { IPC } from '../../shared/ipc'
import { registerGitHubIssueHandlers } from './handlers'

describe('registerGitHubIssueHandlers', () => {
  it('attributes subscriptions to the sender and exposes only domain operations', async () => {
    const calls: unknown[][] = []
    const page = { items: [], counts: {}, partial: false, readOnly: false }
    const service = {
      subscribe: async (...args: unknown[]) => { calls.push(['subscribe', ...args]); return page },
      unsubscribe: (...args: unknown[]) => { calls.push(['unsubscribe', ...args]) },
      query: async (...args: unknown[]) => { calls.push(['query', ...args]); return page },
      refresh: async (...args: unknown[]) => { calls.push(['refresh', ...args]) },
      moveIssue: async (...args: unknown[]) => {
        calls.push(['move', ...args]); return { status: 'configuration-changed' as const }
      },
      createMissingLabels: async (...args: unknown[]) => {
        calls.push(['labels', ...args]); return { status: 'confirmed' as const, created: [], remaining: [] }
      },
      clearCache: async (...args: unknown[]) => { calls.push(['clear', ...args]) },
      pullStatus: async (...args: unknown[]) => {
        calls.push(['pullStatus', ...args])
        return { pulls: [], stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false }
      },
      chasePulls: async (...args: unknown[]) => { calls.push(['chase', ...args]); return false },
      pullChecks: async (...args: unknown[]) => {
        calls.push(['checks', ...args]); return { status: 'no-checks' as const }
      },
      pullDetail: async (...args: unknown[]) => {
        calls.push(['detail', ...args]); return { status: 'refused' as const, reason: 'not-approved' as const }
      },
      pullConversation: async (...args: unknown[]) => {
        calls.push(['conversation', ...args]); return { status: 'refused' as const, reason: 'not-approved' as const }
      },
      commentOnPull: async (...args: unknown[]) => { calls.push(['comment', ...args]); return { ok: true as const } },
      reviewPull: async (...args: unknown[]) => { calls.push(['review', ...args]); return { ok: true as const } },
      mergePull: async (...args: unknown[]) => { calls.push(['merge', ...args]); return { ok: true as const } },
      repoMergeMethods: async (...args: unknown[]) => {
        calls.push(['methods', ...args]); return { status: 'ok' as const, methods: [] }
      },
      claimPullAutoMove: async (...args: unknown[]) => { calls.push(['claim', ...args]); return true },
      notePullWaits: async (...args: unknown[]) => { calls.push(['wait', ...args]); return 1 }
    }
    const platform = fakePlatform()
    registerGitHubIssueHandlers(platform, service)

    await platform.handlers[IPC.githubIssuesSubscribe](7, { projectId: 'p1' })
    platform.senderListeners[IPC.githubIssuesUnsubscribe](7, 'p1')
    await platform.handlers[IPC.githubIssuesQuery]({ projectId: 'p1', columnId: null, pageSize: 50 })
    await platform.handlers[IPC.githubIssuesPullStatus]('p1')
    await platform.handlers[IPC.githubIssuesChasePulls]('p1')
    await platform.handlers[IPC.githubIssuesPullChecks]('p1', 12)
    await platform.handlers[IPC.githubIssuesPullDetail]('p1', 'o/r', 12)
    await platform.handlers[IPC.githubIssuesPullConversation]('p1', 'o/r', 12)
    await platform.handlers[IPC.githubIssuesPullComment]({ projectId: 'p1', repository: 'o/r', pullNumber: 12, body: 'b' })
    await platform.handlers[IPC.githubIssuesPullReview]({ projectId: 'p1', repository: 'o/r', pullNumber: 12, event: 'APPROVE', body: '', headSha: 'h' })
    await platform.handlers[IPC.githubIssuesPullMerge]({ projectId: 'p1', repository: 'o/r', pullNumber: 12, method: 'squash', headSha: 'h' })
    await platform.handlers[IPC.githubIssuesRepoMergeMethods]('p1', 'o/r')
    await platform.handlers[IPC.githubIssuesClaimPullAutoMove]({ projectId: 'p1', cardId: 'n', pulls: [3] })
    await platform.handlers[IPC.githubIssuesNotePullWaits]({ projectId: 'p1', cardId: 'n', pulls: [3] })
    expect(calls).toEqual([
      ['subscribe', 7, { projectId: 'p1' }],
      ['unsubscribe', 7, 'p1'],
      ['query', { projectId: 'p1', columnId: null, pageSize: 50 }],
      ['pullStatus', { projectId: 'p1' }],
      ['chase', { projectId: 'p1' }],
      ['checks', { projectId: 'p1', pullNumber: 12 }],
      ['detail', { projectId: 'p1', repository: 'o/r', pullNumber: 12 }],
      ['conversation', { projectId: 'p1', repository: 'o/r', pullNumber: 12 }],
      ['comment', { projectId: 'p1', repository: 'o/r', pullNumber: 12, body: 'b' }],
      ['review', { projectId: 'p1', repository: 'o/r', pullNumber: 12, event: 'APPROVE', body: '', headSha: 'h' }],
      ['merge', { projectId: 'p1', repository: 'o/r', pullNumber: 12, method: 'squash', headSha: 'h' }],
      ['methods', { projectId: 'p1', repository: 'o/r' }],
      ['claim', { projectId: 'p1', cardId: 'n', pulls: [3] }],
      ['wait', { projectId: 'p1', cardId: 'n', pulls: [3] }]
    ])
    expect(Object.keys(platform.handlers).some((channel) => channel.startsWith('githubControl:'))).toBe(false)
  })
})

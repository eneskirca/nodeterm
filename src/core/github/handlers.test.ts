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
      lookup: async (...args: unknown[]) => {
        calls.push(['lookup', ...args]); return { ok: false as const, reason: 'not-found' as const }
      },
      search: async (...args: unknown[]) => {
        calls.push(['search', ...args]); return { items: [], partial: false }
      },
      pullsForBranch: async (...args: unknown[]) => {
        calls.push(['pulls', ...args]); return { ok: false as const, reason: 'failed' as const }
      },
      refresh: async (...args: unknown[]) => { calls.push(['refresh', ...args]) },
      moveIssue: async (...args: unknown[]) => {
        calls.push(['move', ...args]); return { status: 'configuration-changed' as const }
      },
      createMissingLabels: async (...args: unknown[]) => {
        calls.push(['labels', ...args]); return { status: 'confirmed' as const, created: [], remaining: [] }
      },
      clearCache: async (...args: unknown[]) => { calls.push(['clear', ...args]) }
    }
    const platform = fakePlatform()
    registerGitHubIssueHandlers(platform, service)

    await platform.handlers[IPC.githubIssuesSubscribe](7, { projectId: 'p1' })
    platform.senderListeners[IPC.githubIssuesUnsubscribe](7, 'p1')
    await platform.handlers[IPC.githubIssuesQuery]({ projectId: 'p1', columnId: null, pageSize: 50 })
    await platform.handlers[IPC.githubIssuesLookup]({ projectId: 'p1', number: 12 })
    await platform.handlers[IPC.githubIssuesSearch]({ projectId: 'p1', search: 'x', limit: 20 })
    await platform.handlers[IPC.githubIssuesPullsForBranch]({ projectId: 'p1', branch: 'feat/x' })
    expect(calls).toEqual([
      ['subscribe', 7, { projectId: 'p1' }],
      ['unsubscribe', 7, 'p1'],
      ['query', { projectId: 'p1', columnId: null, pageSize: 50 }],
      ['lookup', { projectId: 'p1', number: 12 }],
      ['search', { projectId: 'p1', search: 'x', limit: 20 }],
      ['pulls', { projectId: 'p1', branch: 'feat/x' }]
    ])
    expect(Object.keys(platform.handlers).some((channel) => channel.startsWith('githubControl:'))).toBe(false)
  })
})

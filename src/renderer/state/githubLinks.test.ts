import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubIssueCardView,
  GitHubIssuesApi,
  GitHubLookupResult
} from '@shared/github-issues'
import { LINK_CARD_TTL_MS, LINK_RETRY_MS, linkCard, useGitHubLinks } from './githubLinks'

const card = (number: number, over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: number,
  number,
  title: `Item ${number}`,
  body: '',
  state: 'open',
  stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`,
  apiUrl: `https://api.github.com/repos/o/r/issues/${number}`,
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z',
  locked: false,
  columnId: null,
  conflict: null,
  ...over
})

function api(lookup: (number: number) => Promise<GitHubLookupResult>): {
  api: GitHubIssuesApi
  calls: number[]
} {
  const calls: number[] = []
  return {
    calls,
    api: {
      lookup: async ({ number }: { number: number }) => { calls.push(number); return lookup(number) }
    } as unknown as GitHubIssuesApi
  }
}

beforeEach(() => {
  vi.useRealTimers()
  useGitHubLinks.setState({ cards: {}, pending: {}, missing: {}, gate: {} })
})

describe('ensureCard', () => {
  it('resolves once and then serves the cache for the whole freshness window', async () => {
    const { api: client, calls } = api(async (number) => ({ ok: true, source: 'api', item: card(number) }))
    const link = { kind: 'issue' as const, number: 12 }
    await useGitHubLinks.getState().ensureCard(client, 'p1', link)
    await useGitHubLinks.getState().ensureCard(client, 'p1', link)
    expect(calls).toEqual([12])
    expect(linkCard('p1', link)?.title).toBe('Item 12')
  })

  it('coalesces concurrent asks for the same link', async () => {
    let release!: (value: GitHubLookupResult) => void
    const { api: client, calls } = api(() => new Promise<GitHubLookupResult>((resolve) => { release = resolve }))
    const link = { kind: 'issue' as const, number: 12 }
    const first = useGitHubLinks.getState().ensureCard(client, 'p1', link)
    const second = useGitHubLinks.getState().ensureCard(client, 'p1', link)
    release({ ok: true, source: 'api', item: card(12) })
    await Promise.all([first, second])
    expect(calls).toEqual([12])
  })

  it('caches the answer under the kind the ITEM reports, not the kind that was asked for', async () => {
    const { api: client } = api(async (number) => ({
      ok: true, source: 'api', item: card(number, { pull: { draft: false, mergedAt: null } })
    }))
    await useGitHubLinks.getState().ensureCard(client, 'p1', { kind: 'issue', number: 12 })
    expect(linkCard('p1', { kind: 'pull', number: 12 })?.number).toBe(12)
    expect(linkCard('p1', { kind: 'issue', number: 12 })).toBeUndefined()
  })

  it('remembers a miss for the retry window instead of re-asking per chip', async () => {
    const { api: client, calls } = api(async () => ({ ok: false, reason: 'not-found' }))
    const link = { kind: 'issue' as const, number: 77 }
    await useGitHubLinks.getState().ensureCard(client, 'p1', link)
    await useGitHubLinks.getState().ensureCard(client, 'p1', link)
    expect(calls).toEqual([77])
    expect(useGitHubLinks.getState().missing.p1['issue#77']).toBeGreaterThan(0)
  })

  it('a project-wide refusal gates every other link, and lapses after the retry window', async () => {
    const { api: client, calls } = api(async () => ({ ok: false, reason: 'not-approved' }))
    await useGitHubLinks.getState().ensureCard(client, 'p1', { kind: 'issue', number: 1 })
    await useGitHubLinks.getState().ensureCard(client, 'p1', { kind: 'issue', number: 2 })
    expect(calls).toEqual([1])
    expect(useGitHubLinks.getState().gate.p1.reason).toBe('not-approved')

    useGitHubLinks.setState((s) => ({
      gate: { ...s.gate, p1: { reason: 'not-approved', at: Date.now() - LINK_RETRY_MS - 1 } }
    }))
    await useGitHubLinks.getState().ensureCard(client, 'p1', { kind: 'issue', number: 2 })
    expect(calls).toEqual([1, 2])
  })

  it('re-asks a stale card once the freshness window has passed', async () => {
    const { api: client, calls } = api(async (number) => ({ ok: true, source: 'api', item: card(number) }))
    const link = { kind: 'issue' as const, number: 12 }
    await useGitHubLinks.getState().ensureCard(client, 'p1', link)
    useGitHubLinks.setState((s) => ({
      cards: { ...s.cards, p1: { 'issue#12': { card: card(12), at: Date.now() - LINK_CARD_TTL_MS - 1 } } }
    }))
    await useGitHubLinks.getState().ensureCard(client, 'p1', link)
    expect(calls).toEqual([12, 12])
  })

  it('leaves nothing pending when the lookup itself rejects', async () => {
    const { api: client } = api(async () => { throw new Error('offline') })
    await useGitHubLinks.getState().ensureCard(client, 'p1', { kind: 'issue', number: 12 })
    expect(useGitHubLinks.getState().pending.p1['issue#12']).toBeUndefined()
  })
})

describe('seedFromPages / invalidate', () => {
  it('warms cards from a board load', () => {
    useGitHubLinks.getState().seedFromPages('p1', [
      { items: [card(1), card(2, { pull: { draft: false, mergedAt: null } })], counts: {}, partial: false, readOnly: false }
    ])
    expect(linkCard('p1', { kind: 'issue', number: 1 })?.number).toBe(1)
    expect(linkCard('p1', { kind: 'pull', number: 2 })?.number).toBe(2)
  })

  it('drops only the numbers a delta named, and everything when it names none', () => {
    useGitHubLinks.getState().seedFromPages('p1', [
      { items: [card(1), card(2)], counts: {}, partial: false, readOnly: false }
    ])
    useGitHubLinks.getState().invalidate('p1', [1])
    expect(linkCard('p1', { kind: 'issue', number: 1 })).toBeUndefined()
    expect(linkCard('p1', { kind: 'issue', number: 2 })?.number).toBe(2)

    useGitHubLinks.setState((s) => ({ gate: { ...s.gate, p1: { reason: 'not-approved', at: Date.now() } } }))
    useGitHubLinks.getState().invalidate('p1')
    expect(linkCard('p1', { kind: 'issue', number: 2 })).toBeUndefined()
    expect(useGitHubLinks.getState().gate.p1).toBeUndefined()
  })
})

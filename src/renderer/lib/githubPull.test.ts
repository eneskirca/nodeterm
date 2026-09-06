import { describe, expect, it } from 'vitest'
import { pullCardState } from './githubPull'

describe('pullCardState', () => {
  it('separates merged from closed, which arrive as the same state', () => {
    expect(pullCardState({ state: 'closed', pull: { draft: false, mergedAt: '2026-08-30T20:35:03Z' } }))
      .toBe('merged')
    expect(pullCardState({ state: 'closed', pull: { draft: false, mergedAt: null } })).toBe('closed')
  })

  it('reports a draft as a draft, not as open', () => {
    expect(pullCardState({ state: 'open', pull: { draft: true, mergedAt: null } })).toBe('draft')
    expect(pullCardState({ state: 'open', pull: { draft: false, mergedAt: null } })).toBe('open')
  })

  it('degrades to the plain state when the pull metadata is missing', () => {
    expect(pullCardState({ state: 'open' })).toBe('open')
    expect(pullCardState({ state: 'closed' })).toBe('closed')
  })
})

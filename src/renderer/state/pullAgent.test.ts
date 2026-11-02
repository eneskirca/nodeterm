import { describe, expect, it } from 'vitest'
import { nodesJoined, usePullAgent } from './pullAgent'

describe('nodesJoined', () => {
  it('accepts a rope or link in either direction, and nothing else', () => {
    const edges = [{ source: 'agent', target: 'pull' }, { source: 'x', target: 'y' }]
    expect(nodesJoined(edges, 'agent', 'pull')).toBe(true)
    expect(nodesJoined(edges, 'pull', 'agent')).toBe(true)
    expect(nodesJoined(edges, 'other', 'pull')).toBe(false)
  })
})

describe('usePullAgent', () => {
  it('holds one proposal per node, replaced by a newer one, and drops it on dismiss', () => {
    const store = usePullAgent.getState()
    store.propose('n', { action: 'approve', message: '', from: 'a' })
    store.propose('n', { action: 'merge', method: 'squash', from: 'a' })
    expect(usePullAgent.getState().proposal.n).toEqual({ action: 'merge', method: 'squash', from: 'a' })
    usePullAgent.getState().dismiss('n')
    expect(usePullAgent.getState().proposal.n).toBeUndefined()
  })

  it('re-reveals a repeated show and clears a show without lines', () => {
    usePullAgent.getState().show('n', { file: 'a.ts', start: 1, end: 2 })
    const first = usePullAgent.getState().highlight.n.seq
    usePullAgent.getState().show('n', { file: 'a.ts', start: 1, end: 2 })
    expect(usePullAgent.getState().highlight.n.seq).toBeGreaterThan(first)
    usePullAgent.getState().show('n', null)
    expect(usePullAgent.getState().highlight.n).toBeUndefined()
  })
})

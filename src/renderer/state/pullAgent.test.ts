import { describe, expect, it } from 'vitest'
import { linkedAgents, nodesJoined, usePullAgent } from './pullAgent'

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
    store.propose('n', { action: 'approve', message: '' })
    const first = usePullAgent.getState().proposal.n.seq
    store.propose('n', { action: 'merge', method: 'squash' })
    expect(usePullAgent.getState().proposal.n).toMatchObject({ action: 'merge', method: 'squash' })
    expect(usePullAgent.getState().proposal.n.seq).toBeGreaterThan(first)
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

describe('linkedAgents', () => {
  const nodes = [
    { id: 'pull', type: 'pull', data: { title: 'PR #7' } },
    { id: 'a1', type: 'terminal', data: { title: 'Work on PR', agentId: 'claude' } },
    { id: 'a2', type: 'terminal', data: { title: '', agentId: 'codex' } },
    { id: 'shell', type: 'terminal', data: { title: 'zsh' } },
    { id: 'note', type: 'sticky', data: { title: 'n', agentId: 'claude' } },
    { id: 'far', type: 'terminal', data: { title: 'not linked', agentId: 'claude' } }
  ]
  it('answers the agent nodes joined to the pull node by a rope or a link, once each, never a shell or another kind', () => {
    const edges = [
      { source: 'pull', target: 'a1' }, { source: 'a1', target: 'pull' }, { source: 'a2', target: 'pull' },
      { source: 'pull', target: 'shell' }, { source: 'note', target: 'pull' }, { source: 'far', target: 'a1' }
    ]
    expect(linkedAgents(edges, nodes, 'pull')).toEqual([{ id: 'a1', title: 'Work on PR' }, { id: 'a2', title: 'a2' }])
  })
  it('answers none when nothing is joined', () => {
    expect(linkedAgents([{ source: 'far', target: 'a1' }], nodes, 'pull')).toEqual([])
  })
})

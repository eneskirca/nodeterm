// Issue #852: a context link may be one-way. These pin the pure "who reads whom" rule that both
// shells (desktop renderer, Server Edition) derive the read-authorization map from.
import { describe, it, expect } from 'vitest'
import { AGENT_TERMINAL_LINKS_DEFAULT, agentTerminalLinkVerdict, gainedReaders, linkReadPairs, planBridges, resolveAgentTerminalLinks, withLinkReader } from './canvas-link'

describe('linkReadPairs', () => {
  it('a link without a reader is bidirectional (every link persisted before #852)', () => {
    expect(linkReadPairs({ source: 'a', target: 'b' })).toEqual([
      { reader: 'a', read: 'b' },
      { reader: 'b', read: 'a' }
    ])
  })

  it('reader = source: only the source reads the target', () => {
    expect(linkReadPairs({ source: 'a', target: 'b', reader: 'a' })).toEqual([
      { reader: 'a', read: 'b' }
    ])
  })

  it('reader = target: only the target reads the source', () => {
    expect(linkReadPairs({ source: 'a', target: 'b', reader: 'b' })).toEqual([
      { reader: 'b', read: 'a' }
    ])
  })

  it('fails closed on a reader that is not an endpoint (hand-edited or corrupt project.json)', () => {
    expect(linkReadPairs({ source: 'a', target: 'b', reader: 'c' })).toEqual([])
    expect(linkReadPairs({ source: 'a', target: 'b', reader: '' })).toEqual([])
    expect(
      linkReadPairs({ source: 'a', target: 'b', reader: 42 as unknown as string })
    ).toEqual([])
  })
})

describe('withLinkReader', () => {
  const edge = { id: 'bridge-a-b', source: 'a', target: 'b' }

  it('sets a reader on a copy, never mutating the input', () => {
    const next = withLinkReader(edge, 'b')
    expect(next).toEqual({ id: 'bridge-a-b', source: 'a', target: 'b', reader: 'b' })
    expect(edge).toEqual({ id: 'bridge-a-b', source: 'a', target: 'b' })
  })

  it('null returns the link to bidirectional by dropping the field entirely', () => {
    const next = withLinkReader({ ...edge, reader: 'a' }, null)
    expect(next).toEqual(edge)
    expect('reader' in next).toBe(false)
  })

  it('ignores a reader that is not an endpoint', () => {
    expect(withLinkReader(edge, 'z')).toBe(edge)
  })
})

describe('gainedReaders', () => {
  it('flipping one-way hands read access to the other side only', () => {
    expect(
      gainedReaders({ source: 'a', target: 'b', reader: 'a' }, { source: 'a', target: 'b', reader: 'b' })
    ).toEqual(['b'])
  })

  it('both → one-way grants nobody anything new', () => {
    expect(
      gainedReaders({ source: 'a', target: 'b' }, { source: 'a', target: 'b', reader: 'a' })
    ).toEqual([])
  })

  it('one-way → both grants the former non-reader', () => {
    expect(
      gainedReaders({ source: 'a', target: 'b', reader: 'a' }, { source: 'a', target: 'b' })
    ).toEqual(['b'])
  })
})

describe('planBridges oneWay', () => {
  const lookup = (id: string) =>
    id === 's1' ? { kind: 'sticky', contextCapable: false } : { kind: 'terminal', contextCapable: true }

  it('a one-way context bridge makes --from the only reader', () => {
    const plan = planBridges('n1', ['n2'], lookup, [], { oneWay: true })
    expect(plan.edges).toEqual([{ id: 'bridge-n1-n2', source: 'n1', target: 'n2', reader: 'n1' }])
  })

  it('without the option the edge carries no reader (bidirectional, unchanged shape)', () => {
    const plan = planBridges('n1', ['n2'], lookup, [])
    expect(plan.edges).toEqual([{ id: 'bridge-n1-n2', source: 'n1', target: 'n2' }])
  })

  it('note links are one-way by nature and never carry a reader', () => {
    const plan = planBridges('n1', ['s1'], lookup, [], { oneWay: true })
    expect(plan.edges).toEqual([{ id: 'bridge-s1-n1', source: 's1', target: 'n1' }])
  })
})

describe('agentTerminalLinks: which terminals an agent may link itself to', () => {
  it('reads anything but a known value as the safe default, own', () => {
    expect(AGENT_TERMINAL_LINKS_DEFAULT).toBe('own')
    for (const v of ['own', 'confirm', 'any'] as const) expect(resolveAgentTerminalLinks(v)).toBe(v)
    for (const v of [undefined, null, '', 'ANY', 'all', 1, true, {}]) expect(resolveAgentTerminalLinks(v)).toBe('own')
  })

  it('own: only a terminal whose recorded opener is exactly the caller', () => {
    expect(agentTerminalLinkVerdict('own', 'agent-1', 'agent-1')).toBe('allow')
    expect(agentTerminalLinkVerdict('own', 'agent-1', 'agent-2')).toBe('refuse')
    expect(agentTerminalLinkVerdict('own', 'agent-1', undefined)).toBe('refuse')
    expect(agentTerminalLinkVerdict('own', 'agent-1', '')).toBe('refuse')
    expect(agentTerminalLinkVerdict('own', 'agent-1', ['agent-1'])).toBe('refuse')
  })

  it('confirm: its own terminal needs no question, any other asks', () => {
    expect(agentTerminalLinkVerdict('confirm', 'agent-1', 'agent-1')).toBe('allow')
    expect(agentTerminalLinkVerdict('confirm', 'agent-1', 'agent-2')).toBe('confirm')
    expect(agentTerminalLinkVerdict('confirm', 'agent-1', undefined)).toBe('confirm')
  })

  it('any: no limit', () => {
    expect(agentTerminalLinkVerdict('any', 'agent-1', 'agent-2')).toBe('allow')
    expect(agentTerminalLinkVerdict('any', 'agent-1', undefined)).toBe('allow')
  })
})

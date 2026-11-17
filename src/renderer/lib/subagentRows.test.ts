// The rows the sessions sidebar and the kanban card list draw for a node's subagents, the primitive
// they subscribe with, and the open a row asks the canvas for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentViz } from '../state/agentNodes'
import {
  openSubagentCard,
  requestOpenSubagent,
  subagentRowsFor,
  subagentRowsSig,
  type SubagentCardStore
} from './subagentRows'

const card = (parentNodeId: string, v: Partial<SubagentViz> = {}): SubagentViz => ({
  parentNodeId,
  state: 'working',
  startedAt: 0,
  ...v
})

describe('subagentRowsFor', () => {
  it("lists only the node's own cards, in the order they started", () => {
    const byId = {
      late: card('p1', { type: 'Explore', label: 'Map the repo', startedAt: 30 }),
      other: card('p2', { type: 'Plan', startedAt: 5 }),
      early: card('p1', { type: 'general-purpose', label: 'Find the bug', startedAt: 10, state: 'done' })
    }
    expect(subagentRowsFor(byId, 'p1')).toEqual([
      { id: 'early', type: 'general-purpose', label: 'Find the bug', state: 'done' },
      { id: 'late', type: 'Explore', label: 'Map the repo', state: 'working' }
    ])
  })

  it('a node with no cards has no rows', () => {
    expect(subagentRowsFor({ a: card('p2') }, 'p1')).toEqual([])
    expect(subagentRowsFor({}, 'p1')).toEqual([])
  })

  it('two cards started in the same millisecond keep the order they were drawn in', () => {
    const byId = { b: card('p1', { startedAt: 7 }), a: card('p1', { startedAt: 7 }) }
    expect(subagentRowsFor(byId, 'p1').map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('a card with no type reads as "subagent"; a task is drawn on one line, capped', () => {
    const long = `Investigate\nthe\tcache   ${'x'.repeat(400)}`
    const [row] = subagentRowsFor({ a: card('p1', { label: long }) }, 'p1')
    expect(row.type).toBe('subagent')
    expect(row.label.startsWith('Investigate the cache x')).toBe(true)
    expect(row.label).not.toMatch(/[\n\t]/)
    expect(row.label.length).toBe(200)
    expect(row.label.endsWith('…')).toBe(true)
    expect(subagentRowsFor({ a: card('p1') }, 'p1')[0].label).toBe('')
  })
})

describe('subagentRowsSig', () => {
  const base = { a: card('p1', { type: 'Explore', label: 'Map it', startedAt: 1 }) }

  it("is '' when the node has no cards", () => {
    expect(subagentRowsSig({}, 'p1')).toBe('')
    expect(subagentRowsSig({ a: card('p2') }, 'p1')).toBe('')
  })

  it('carries each card id and state, with what its row draws, one row per line in start order', () => {
    expect(subagentRowsSig(base, 'p1')).toBe('a\tworking\tExplore\tMap it')
    const two = { ...base, b: card('p1', { type: 'Plan', startedAt: 0, state: 'done' }) }
    expect(subagentRowsSig(two, 'p1')).toBe('b\tdone\tPlan\t\na\tworking\tExplore\tMap it')
  })

  it("does not change for another node's card, or for anything a row does not draw", () => {
    const sig = subagentRowsSig(base, 'p1')
    expect(subagentRowsSig({ ...base, b: card('p2', { state: 'done' }) }, 'p1')).toBe(sig)
    // Stats and a result arrive on finish; the row draws only the state (which this keeps).
    expect(subagentRowsSig({ a: { ...base.a, tokens: 900, result: 'x', durationMs: 4 } }, 'p1')).toBe(sig)
  })

  it('changes when a card starts, finishes or goes', () => {
    const sig = subagentRowsSig(base, 'p1')
    expect(subagentRowsSig({ ...base, b: card('p1', { startedAt: 2 }) }, 'p1')).not.toBe(sig)
    expect(subagentRowsSig({ a: { ...base.a, state: 'done' } }, 'p1')).not.toBe(sig)
    expect(subagentRowsSig({}, 'p1')).not.toBe(sig)
  })

  it('changes when a running card is relabelled under its own id (the lifecycle corrects a guess)', () => {
    const sig = subagentRowsSig(base, 'p1')
    expect(subagentRowsSig({ a: { ...base.a, label: 'Read the loader' } }, 'p1')).not.toBe(sig)
    expect(subagentRowsSig({ a: { ...base.a, type: 'Plan' } }, 'p1')).not.toBe(sig)
  })
})

describe('requestOpenSubagent', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("dispatches nodeterm:open-subagent with the parent's and the card's ids", () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    requestOpenSubagent('p1', 'a089017271138740d')
    const e = dispatchEvent.mock.calls[0][0] as CustomEvent
    expect(e.type).toBe('nodeterm:open-subagent')
    expect(e.detail).toEqual({ parentNodeId: 'p1', cardId: 'a089017271138740d' })
  })
})

describe('openSubagentCard', () => {
  function store(over: Partial<SubagentCardStore> = {}): SubagentCardStore & { toggles: string[]; selected: (string | null)[] } {
    const toggles: string[] = []
    const selected: (string | null)[] = []
    return {
      byId: { a: card('p1') },
      expanded: {},
      toggleExpanded: (id) => toggles.push(id),
      select: (id) => selected.push(id),
      toggles,
      selected,
      ...over
    }
  }

  it('opens a closed card and selects it', () => {
    const s = store()
    expect(openSubagentCard(s, 'p1', 'a')).toBe(true)
    expect(s.toggles).toEqual(['a'])
    expect(s.selected).toEqual(['a'])
  })

  it('never closes a card that is already open — it only selects it', () => {
    const s = store({ expanded: { a: true } })
    expect(openSubagentCard(s, 'p1', 'a')).toBe(true)
    expect(s.toggles).toEqual([])
    expect(s.selected).toEqual(['a'])
  })

  it('does nothing for a card that is gone, or that belongs to another node', () => {
    const gone = store({ byId: {} })
    expect(openSubagentCard(gone, 'p1', 'a')).toBe(false)
    const foreign = store({ byId: { a: card('p2') } })
    expect(openSubagentCard(foreign, 'p1', 'a')).toBe(false)
    for (const s of [gone, foreign]) {
      expect(s.toggles).toEqual([])
      expect(s.selected).toEqual([])
    }
  })
})

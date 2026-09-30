import { describe, expect, it } from 'vitest'
import type { AgentNodeStatus } from '../state/agentStatus'
import {
  STATUS_CHIPS,
  cardBadge,
  chipCounts,
  matchesStatusChips,
  parseStatusChipSig,
  statusChipSig,
  type StatusChipCard
} from './kanbanStatusChips'

const st = (s: Partial<AgentNodeStatus>): AgentNodeStatus => ({ unread: false, ...s })

describe('cardBadge — the ONE badge rule the card and the chips share', () => {
  it('ranks dropped > running > needs > paused > sleeping', () => {
    expect(cardBadge('terminal', st({ dropped: true, state: 'working' }))).toBe('dropped')
    expect(cardBadge('terminal', st({ state: 'working' }))).toBe('running')
    expect(cardBadge('terminal', st({ state: 'waiting' }))).toBe('needs')
    expect(cardBadge('terminal', st({ state: 'blocked' }))).toBe('needs')
    expect(cardBadge('terminal', st({ paused: true }))).toBe('paused')
    expect(cardBadge('terminal', st({ hibernated: true }))).toBe('sleeping')
    expect(cardBadge('terminal', st({ state: 'done' }))).toBeNull()
    expect(cardBadge('terminal', undefined)).toBeNull()
  })

  it('a sticky note never carries a status badge', () => {
    expect(cardBadge('sticky', st({ state: 'working' }))).toBeNull()
  })
})

describe('statusChipSig — a derived signature, never the whole byId map', () => {
  const cards: StatusChipCard[] = [
    { id: 'a', kind: 'terminal' },
    { id: 'b', kind: 'terminal' },
    { id: 'c', kind: 'sticky' }
  ]

  it('changes only when a chip-relevant fact changes', () => {
    const one = statusChipSig({ a: st({ state: 'working', stateAt: 1, lastEventAt: 1 }) }, cards)
    // Same facts, different freshness clocks and unrelated fields: the board must NOT re-render.
    const two = statusChipSig(
      { a: st({ state: 'working', stateAt: 99, lastEventAt: 42, session: 'renamed' }) },
      cards
    )
    expect(two).toBe(one)
    expect(statusChipSig({ a: st({ state: 'waiting' }) }, cards)).not.toBe(one)
  })

  it('ignores nodes that are not cards on this board', () => {
    expect(statusChipSig({ zzz: st({ state: 'working', unread: true }) }, cards)).toBe('')
  })

  it('round-trips through the parser', () => {
    const facts = parseStatusChipSig(
      statusChipSig(
        {
          a: st({ state: 'working' }),
          b: st({ state: 'blocked', unread: true }),
          c: st({ unread: true })
        },
        cards
      )
    )
    expect([...facts.running]).toEqual(['a'])
    expect([...facts.needs]).toEqual(['b'])
    expect([...facts.unread].sort()).toEqual(['b', 'c'])
  })

  it('a card id carrying the separators cannot forge another card\'s facts', () => {
    // Node ids come from a git-shared, hand-editable project file.
    const hostile: StatusChipCard[] = [
      { id: 'x|victim', kind: 'terminal' },
      { id: 'y:rnu|z', kind: 'terminal' },
      { id: 'victim', kind: 'terminal' },
      { id: 'z', kind: 'terminal' }
    ]
    const facts = parseStatusChipSig(statusChipSig({
      'x|victim': st({ unread: true }),
      'y:rnu|z': st({ state: 'working' })
    }, hostile))
    expect([...facts.unread]).toEqual(['x|victim'])
    expect([...facts.running]).toEqual(['y:rnu|z'])
    expect(facts.needs.size).toBe(0)
  })

  it('a dropped agent is not "running" even if its last state said so', () => {
    const facts = parseStatusChipSig(statusChipSig({ a: st({ state: 'working', dropped: true }) }, cards))
    expect(facts.running.size).toBe(0)
  })
})

describe('matchesStatusChips', () => {
  const facts = parseStatusChipSig(statusChipSig(
    { a: st({ state: 'working' }), b: st({ state: 'waiting', unread: true }) },
    [{ id: 'a', kind: 'terminal' }, { id: 'b', kind: 'terminal' }]
  ))

  it('no active chip matches everything', () => {
    expect(matchesStatusChips(facts, 'zzz', [])).toBe(true)
  })

  it('is an OR over the active chips', () => {
    expect(matchesStatusChips(facts, 'a', ['running'])).toBe(true)
    expect(matchesStatusChips(facts, 'b', ['running'])).toBe(false)
    expect(matchesStatusChips(facts, 'b', ['running', 'unread'])).toBe(true)
    expect(matchesStatusChips(facts, 'zzz', ['needs'])).toBe(false)
  })

  it('counts per chip', () => {
    expect(chipCounts(facts)).toEqual({ running: 1, needs: 1, unread: 1 })
  })

  it('names the three chips in order', () => {
    expect(STATUS_CHIPS.map((c) => c.label)).toEqual(['Running', 'Needs you', 'Unread'])
  })
})

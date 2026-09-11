import { describe, expect, it } from 'vitest'

import {
  CLOSE_BULK_MAX,
  CLOSE_LIST_PREVIEW,
  bulkCloseMessage,
  parseCloseTargets
} from './closeTargets'

const live = [
  { id: 'a', title: 'Backend tests' },
  { id: 'b', title: '' },
  { id: 'c', title: 'Docs' }
]

describe('parseCloseTargets — the single-node form is unchanged', () => {
  it('reads one id as one id', () => {
    expect(parseCloseTargets('a', live)).toEqual({ kind: 'single', id: 'a' })
  })

  it('does NOT existence-check a single id', () => {
    // Deliberate: `close --node <gone>` behaves exactly as it did before this change (dialog,
    // then `closed <id>`). Correcting that pre-existing lie is its own change; doing it here would
    // alter the form every agent already uses in the same commit that adds the new one.
    expect(parseCloseTargets('ghost', live)).toEqual({ kind: 'single', id: 'ghost' })
  })

  it('trims, and a trailing comma is still one id', () => {
    expect(parseCloseTargets('  a  ', live)).toEqual({ kind: 'single', id: 'a' })
    expect(parseCloseTargets('a,', live)).toEqual({ kind: 'single', id: 'a' })
  })

  it('refuses an empty flag', () => {
    for (const raw of [undefined, '', '   ', ',', ',,']) {
      const r = parseCloseTargets(raw, live)
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.error).toBe('close requires --node')
    }
  })
})

describe('parseCloseTargets — the bulk form', () => {
  it('splits a comma list and labels each id', () => {
    const r = parseCloseTargets('a,c', live)
    expect(r).toEqual({
      kind: 'bulk',
      ids: ['a', 'c'],
      labels: ['Backend tests (a)', 'Docs (c)']
    })
  })

  it('falls back to the bare id when a node has no title', () => {
    const r = parseCloseTargets('a,b', live)
    if (r.kind !== 'bulk') throw new Error('expected bulk')
    expect(r.labels).toEqual(['Backend tests (a)', 'b'])
  })

  it('de-duplicates, which can collapse a list back to the single form', () => {
    expect(parseCloseTargets('a,a', live)).toEqual({ kind: 'single', id: 'a' })
    const r = parseCloseTargets('a,c,a', live)
    if (r.kind !== 'bulk') throw new Error('expected bulk')
    expect(r.ids).toEqual(['a', 'c'])
  })

  it('preserves the caller order', () => {
    const r = parseCloseTargets('c,b,a', live)
    if (r.kind !== 'bulk') throw new Error('expected bulk')
    expect(r.ids).toEqual(['c', 'b', 'a'])
  })

  it('refuses the WHOLE request when any id is unknown, and names it', () => {
    const r = parseCloseTargets('a,ghost,c', live)
    expect(r.kind).toBe('error')
    if (r.kind !== 'error') return
    expect(r.error).toContain('ghost')
    expect(r.error).toContain('nothing was closed')
    // Not a partial success: the known ids must not appear as "closed".
    expect(r.error).not.toContain('closed a')
  })

  it('names at most the preview count of missing ids and counts the rest', () => {
    const many = Array.from({ length: CLOSE_LIST_PREVIEW + 3 }, (_, i) => `x${i}`)
    const r = parseCloseTargets(['a', ...many].join(','), live)
    if (r.kind !== 'error') throw new Error('expected error')
    expect(r.error).toContain('+3 more')
    expect(r.error).toContain('x0')
    expect(r.error).not.toContain(`x${CLOSE_LIST_PREVIEW + 2}`)
  })

  it('refuses a list longer than the cap without consulting the canvas', () => {
    const ids = Array.from({ length: CLOSE_BULK_MAX + 1 }, (_, i) => `n${i}`)
    const nodes = ids.map((id) => ({ id }))
    const r = parseCloseTargets(ids.join(','), nodes)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.error).toContain(String(CLOSE_BULK_MAX))
  })

  it('accepts a list exactly at the cap', () => {
    const ids = Array.from({ length: CLOSE_BULK_MAX }, (_, i) => `n${i}`)
    const r = parseCloseTargets(ids.join(','), ids.map((id) => ({ id })))
    expect(r.kind).toBe('bulk')
  })
})

describe('bulkCloseMessage', () => {
  it('names every node when they fit, and says what closing costs', () => {
    const msg = bulkCloseMessage('orchestrator', ['Backend tests (a)', 'Docs (c)'])
    expect(msg).toContain('close 2 nodes')
    expect(msg).toContain('Backend tests (a)')
    expect(msg).toContain('Docs (c)')
    expect(msg).toContain('terminal sessions end')
  })

  it('caps the list and counts the remainder — a name the user cannot see is not consent', () => {
    const labels = Array.from({ length: 14 }, (_, i) => `node ${i}`)
    const msg = bulkCloseMessage('orchestrator', labels)
    expect(msg).toContain('close 14 nodes')
    expect(msg.match(/•/g)?.length).toBe(CLOSE_LIST_PREVIEW)
    expect(msg).toContain(`and ${14 - CLOSE_LIST_PREVIEW} more`)
  })
})

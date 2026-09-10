import { describe, expect, it } from 'vitest'
import { callsignAt, callsignOf, ensureCallsigns, nextCallsign, parseCallsign } from './callsign'

describe('callsignAt', () => {
  it('walks A–Z then AA', () => {
    expect(callsignAt(0)).toBe('A')
    expect(callsignAt(25)).toBe('Z')
    expect(callsignAt(26)).toBe('AA')
    expect(callsignAt(27)).toBe('AB')
  })
})

describe('parseCallsign', () => {
  it('accepts letters only', () => {
    expect(parseCallsign('b')).toBe('B')
    expect(parseCallsign(' AA ')).toBe('AA')
    expect(parseCallsign('term-1')).toBeNull()
    expect(parseCallsign('')).toBeNull()
    expect(parseCallsign(3)).toBeNull()
  })
})

describe('nextCallsign', () => {
  it('skips taken letters', () => {
    expect(nextCallsign(['A', 'B'])).toBe('C')
    expect(nextCallsign(['A', 'C'])).toBe('B')
  })
})

describe('ensureCallsigns', () => {
  it('fills missing callsigns without clobbering existing ones', () => {
    const nodes = [
      { id: 't1', type: 'terminal', data: { callsign: 'B' } },
      { id: 't2', type: 'terminal', data: {} },
      { id: 'g', type: 'group', data: {} }
    ]
    const next = ensureCallsigns(nodes)
    expect(next[0].data.callsign).toBe('B')
    expect(next[1].data.callsign).toBe('A')
    expect(next[2]).toBe(nodes[2])
    expect(callsignOf(next[1])).toBe('A')
  })

  it('returns the same array when every terminal already has one', () => {
    const nodes = [{ id: 't1', type: 'terminal', data: { callsign: 'A' } }]
    expect(ensureCallsigns(nodes)).toBe(nodes)
  })
})

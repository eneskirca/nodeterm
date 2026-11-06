import { describe, expect, it } from 'vitest'
import { isTeammateMessage, messagesLabel, teammateColor, teammateRows, type TeammatePart } from './chatTeammate'

const msg = (from: string, extra: Partial<TeammatePart> = {}): TeammatePart => ({ kind: 'teammate', from, text: 'x', ...extra })

describe('teammateRows', () => {
  it('folds consecutive messages from one teammate, and gives each idle notification its own line', () => {
    const idle = msg('a', { text: undefined, idle: { reason: 'available' } })
    const parts = [msg('a'), msg('a'), idle, msg('a'), msg('b'), msg('b', { unverified: true })]

    const rows = teammateRows(parts)

    expect(rows.map((r) => (r.kind === 'idle' ? 'idle' : `${r.from}×${r.parts.length}${r.unverified ? '?' : ''}`))).toEqual([
      'a×2',
      'idle',
      'a×1',
      'b×1',
      'b×1?'
    ])
  })
})

describe('teammateColor', () => {
  it('maps the TUI color names and refuses anything else', () => {
    expect(teammateColor('green')).toBe('var(--sys-green)')
    expect(teammateColor('red; background: url(x)')).toBeUndefined()
    expect(teammateColor('constructor')).toBeUndefined()
    expect(teammateColor(undefined)).toBeUndefined()
  })
})

describe('isTeammateMessage', () => {
  it('is a message of teammate parts only', () => {
    expect(isTeammateMessage({ role: 'assistant', parts: [msg('a')] })).toBe(true)
    expect(isTeammateMessage({ role: 'assistant', parts: [msg('a'), { kind: 'text', text: 'y' }] })).toBe(false)
    expect(isTeammateMessage({ role: 'assistant', parts: [] })).toBe(false)
  })
})

describe('messagesLabel', () => {
  it('counts', () => {
    expect(messagesLabel(1)).toBe('Message from')
    expect(messagesLabel(3)).toBe('3 messages from')
  })
})

import { describe, expect, it } from 'vitest'
import {
  NODE_PROMPT_MAX_CHARS,
  NODE_PROMPT_MAX_ENTRIES,
  NODE_PROMPT_MAX_RESEND_CHARS,
  resendText,
  appendPrompt,
  isNodePrompt,
  rememberPrompt,
  removePrompt,
  type NodePrompt
} from './node-prompts'

const entry = (id: string, text: string, at = 1): NodePrompt => ({ id, text, at })

describe('rememberPrompt', () => {
  it('shows what the person typed on one line, and keeps the original to resend', () => {
    expect(rememberPrompt('  fix the\n  login   bug ')).toEqual({
      text: 'fix the login bug',
      full: 'fix the\n  login   bug'
    })
  })

  it('keeps short replies — deleting them is the person\'s call', () => {
    expect(rememberPrompt('proceed')).toEqual({ text: 'proceed' })
  })

  it.each([
    ['empty', ''],
    ['whitespace', '  \n '],
    ['a subagent notification', '<task-notification>\n<task-id>x</task-id>'],
    ['a system reminder', '<system-reminder>be careful</system-reminder>'],
    ['a command echo', '<command-name>/clear</command-name>'],
    ['a linked-context note', '[nodeterm] You are now linked to "api". Use the skill.'],
    ['an agent message frame', '--- NODETERM MESSAGE abc123 ---\nreply-to: n1'],
    ['nodeterm title sync', '/rename Fix login'],
    ['Branch conversation', '/branch'],
    ['an exit line', '/exit'],
    ['an upper-case housekeeping command', '/Compact now']
  ])('drops %s', (_label, text) => {
    expect(rememberPrompt(text)).toBeNull()
  })

  it.each([
    ['/loop 5m check the deploy'],
    ['/schedule nightly report'],
    ['/init'],
    ['/my-custom-skill do the thing']
  ])('keeps the slash command %s because it carries the work', (text) => {
    expect(rememberPrompt(text)).not.toBeNull()
  })

  it('keeps a prompt that merely starts with an angle bracket', () => {
    expect(rememberPrompt('<div> renders twice, why')).toEqual({ text: '<div> renders twice, why' })
  })

  it('rejects a non-string hook field', () => {
    expect(rememberPrompt(undefined)).toBeNull()
    expect(rememberPrompt({ text: 'x' })).toBeNull()
  })

  it('clips a long prompt for display, marking the cut, and keeps the whole thing to resend', () => {
    const typed = 'a'.repeat(NODE_PROMPT_MAX_CHARS + 50)
    const out = rememberPrompt(typed)!
    expect(out.text).toHaveLength(NODE_PROMPT_MAX_CHARS)
    expect(out.text.endsWith('…')).toBe(true)
    expect(out.full).toBe(typed)
    expect(out.partial).toBeUndefined()
  })

  it('past the resend cap keeps no verbatim copy and says so, rather than keeping a truncated one', () => {
    const out = rememberPrompt('b'.repeat(NODE_PROMPT_MAX_RESEND_CHARS + 1))!
    expect(out.full).toBeUndefined()
    expect(out.partial).toBe(true)
  })
})

describe('appendPrompt', () => {
  it('adds the newest entry last', () => {
    const next = appendPrompt([entry('a', 'one')], entry('b', 'two'))
    expect(next.map((p) => p.text)).toEqual(['one', 'two'])
  })

  it('returns the same list when the newest entry already says this', () => {
    const list = [entry('a', 'one')]
    expect(appendPrompt(list, entry('b', 'one'))).toBe(list)
  })

  it('allows a repeat that is not consecutive', () => {
    const next = appendPrompt([entry('a', 'one'), entry('b', 'two')], entry('c', 'one'))
    expect(next.map((p) => p.text)).toEqual(['one', 'two', 'one'])
  })

  it('drops the oldest past the cap', () => {
    const full = Array.from({ length: NODE_PROMPT_MAX_ENTRIES }, (_, i) => entry(`id${i}`, `p${i}`))
    const next = appendPrompt(full, entry('new', 'newest'))
    expect(next).toHaveLength(NODE_PROMPT_MAX_ENTRIES)
    expect(next[0].text).toBe('p1')
    expect(next[next.length - 1].text).toBe('newest')
  })
})

describe('resendText', () => {
  it('is the displayed line when nothing else was kept', () => {
    expect(resendText(entry('a', 'proceed'))).toBe('proceed')
  })

  it('is the original, with its line breaks, when one was kept', () => {
    expect(resendText({ ...entry('a', 'fix the login bug'), full: 'fix the\nlogin bug' })).toBe('fix the\nlogin bug')
  })

  it('is null for a prompt only a clipped copy of survives', () => {
    expect(resendText({ ...entry('a', 'aaa…'), partial: true })).toBeNull()
  })
})

describe('removePrompt', () => {
  it('removes only the named entry', () => {
    const next = removePrompt([entry('a', 'one'), entry('b', 'two')], 'a')
    expect(next.map((p) => p.id)).toEqual(['b'])
  })

  it('returns the same list for an unknown id', () => {
    const list = [entry('a', 'one')]
    expect(removePrompt(list, 'zzz')).toBe(list)
  })
})

describe('isNodePrompt', () => {
  it('accepts what this module writes and nothing malformed', () => {
    expect(isNodePrompt(entry('a', 'x'))).toBe(true)
    expect(isNodePrompt({ id: 'a', text: '', at: 1 })).toBe(false)
    expect(isNodePrompt({ id: 'a', text: 'x', at: NaN })).toBe(false)
    expect(isNodePrompt({ id: 1, text: 'x', at: 1 })).toBe(false)
    expect(isNodePrompt(null)).toBe(false)
    expect(isNodePrompt({ ...entry('a', 'x'), full: 'x\ny', partial: true })).toBe(true)
    expect(isNodePrompt({ ...entry('a', 'x'), full: 5 })).toBe(false)
    expect(isNodePrompt({ ...entry('a', 'x'), partial: false })).toBe(false)
  })
})

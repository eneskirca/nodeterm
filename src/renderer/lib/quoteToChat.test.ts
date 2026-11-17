import { describe, expect, it } from 'vitest'
import {
  QUOTE_MAX_CHARS,
  QUOTE_REFUSAL_TEXT,
  appendQuoteToDraft,
  buildQuote,
  planQuote,
  type QuoteRefusal
} from './quoteToChat'

describe('buildQuote', () => {
  it('prefixes every line and ends with a blank line', () => {
    expect(buildQuote('a\nb')).toEqual({ quote: '> a\n> b\n\n', truncated: false })
  })

  it('trims the selection before quoting it', () => {
    expect(buildQuote('\n  hello world  \n\n')).toEqual({ quote: '> hello world\n\n', truncated: false })
  })

  it('keeps an inner blank line as a quoted line', () => {
    expect(buildQuote('a\n\nb')?.quote).toBe('> a\n> \n> b\n\n')
  })

  it('caps at 4,000 characters and says so', () => {
    expect(QUOTE_MAX_CHARS).toBe(4000)
    expect(buildQuote('x'.repeat(4001))).toEqual({ quote: `> ${'x'.repeat(4000)}\n\n`, truncated: true })
  })

  it('does not call a selection of exactly the cap truncated', () => {
    expect(buildQuote('x'.repeat(4000))).toEqual({ quote: `> ${'x'.repeat(4000)}\n\n`, truncated: false })
  })

  it('counts the cap in code points, never splitting a surrogate pair', () => {
    const r = buildQuote('😀'.repeat(4001))
    expect(r?.truncated).toBe(true)
    expect(r?.quote).toBe(`> ${'😀'.repeat(4000)}\n\n`)
  })

  it('does not leave an empty quoted line where the cap cut after a line break', () => {
    const r = buildQuote(`${'x'.repeat(3999)}\nyz`)
    expect(r).toEqual({ quote: `> ${'x'.repeat(3999)}\n\n`, truncated: true })
  })

  it('is nothing when only an escape sequence and whitespace remain', () => {
    expect(buildQuote('\x1b[31m \n')).toBeNull()
  })

  it('is nothing for an empty or whitespace-only selection', () => {
    expect(buildQuote('')).toBeNull()
    expect(buildQuote(' \t\n ')).toBeNull()
  })

  it('removes terminal sequences and control characters but keeps tabs', () => {
    expect(buildQuote('\x1b[1mbold\x1b[0m\x07 a\tb\r\nc\x1b]0;title\x07')?.quote).toBe('> bold a\tb\n> c\n\n')
  })
})

describe('appendQuoteToDraft', () => {
  const q = '> a\n\n'

  it('is the quote alone for an empty or whitespace draft', () => {
    expect(appendQuoteToDraft('', q)).toBe(q)
    expect(appendQuoteToDraft(' \n\t', q)).toBe(q)
  })

  it('separates the quote from existing text by one blank line', () => {
    expect(appendQuoteToDraft('hi  ', q)).toBe(`hi\n\n${q}`)
    expect(appendQuoteToDraft('hi\n\n\n', q)).toBe(`hi\n\n${q}`)
  })
})

describe('planQuote', () => {
  const base = { chatOpen: false, isAgent: true, agentInPane: true, state: undefined, held: false } as const

  it('adds to the draft while the chat view is open, whatever the agent is doing', () => {
    expect(planQuote({ ...base, chatOpen: true, state: 'blocked' })).toEqual({ leg: 'draft' })
    expect(planQuote({ ...base, chatOpen: true, held: true })).toEqual({ leg: 'draft' })
    expect(planQuote({ ...base, chatOpen: true, agentInPane: false })).toEqual({ leg: 'draft' })
  })

  it('types at the prompt when the terminal is showing and the agent can take input', () => {
    expect(planQuote({ ...base, state: 'working' })).toEqual({ leg: 'pane' })
    expect(planQuote({ ...base, state: 'done' })).toEqual({ leg: 'pane' })
    expect(planQuote({ ...base, state: undefined })).toEqual({ leg: 'pane' })
  })

  it('refuses the pane while the agent waits for an answer', () => {
    expect(planQuote({ ...base, state: 'blocked' })).toEqual({ refuse: 'needs-answer' })
    expect(planQuote({ ...base, state: 'waiting' })).toEqual({ refuse: 'needs-answer' })
    expect(planQuote({ ...base, state: 'done', held: true })).toEqual({ refuse: 'needs-answer' })
  })

  it('refuses a node with no agent, even with a chat view open', () => {
    expect(planQuote({ ...base, isAgent: false })).toEqual({ refuse: 'not-agent' })
    expect(planQuote({ ...base, isAgent: false, chatOpen: true })).toEqual({ refuse: 'not-agent' })
  })

  it('refuses the pane when the agent is not running in it', () => {
    expect(planQuote({ ...base, agentInPane: false })).toEqual({ refuse: 'agent-gone' })
  })

  it('names the refusals in order: not-agent, agent-gone, needs-answer', () => {
    expect(planQuote({ ...base, isAgent: false, agentInPane: false, state: 'blocked' })).toEqual({ refuse: 'not-agent' })
    expect(planQuote({ ...base, agentInPane: false, state: 'blocked', held: true })).toEqual({ refuse: 'agent-gone' })
  })
})

describe('QUOTE_REFUSAL_TEXT', () => {
  it('says why for every refusal', () => {
    const expected: Record<QuoteRefusal, string> = {
      'not-agent': 'This terminal has no agent to quote to.',
      'agent-gone': 'The agent is not running in this terminal.',
      'needs-answer': 'The agent is waiting for an answer. Answer it first.',
      dialog: 'A dialog is open in the terminal. Close it first.'
    }
    expect(QUOTE_REFUSAL_TEXT).toEqual(expected)
  })
})

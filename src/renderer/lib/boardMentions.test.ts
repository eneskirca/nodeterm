import { describe, it, expect } from 'vitest'
import { parseMentions } from '@shared/board-comment'
import { insertMention, mentionCandidatesFrom, mentionOptions, mentionQueryAt } from './boardMentions'

describe('mentionCandidatesFrom', () => {
  it('offers the agent sessions on the board — not notes, browsers or plain shells', () => {
    expect(
      mentionCandidatesFrom([
        { id: 'a', title: 'Alpha', kind: 'terminal', agentId: 'claude' },
        { id: 's', title: 'Note', kind: 'sticky' },
        { id: 'w', title: 'Web', kind: 'browser' },
        { id: 't', title: 'Shell', kind: 'terminal' },
        { id: 'u', title: '', kind: 'terminal', agentId: 'codex' }
      ])
    ).toEqual([
      { id: 'a', title: 'Alpha' },
      { id: 'u', title: 'u' }
    ])
  })
})

describe('the @ trigger', () => {
  it('opens on an @ at a word start and reads the query up to the caret', () => {
    expect(mentionQueryAt('hi @be', 6)).toEqual({ start: 3, query: 'be' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
  })
  it('stays closed inside an e-mail address, after a space, or past a finished token', () => {
    expect(mentionQueryAt('me@host', 7)).toBeNull()
    expect(mentionQueryAt('@be ', 4)).toBeNull()
    expect(mentionQueryAt('@[Beta](node:b1)', 16)).toBeNull()
  })
  it('filters by title, case-insensitively, capped', () => {
    const c = [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
      { id: 'c', title: 'alphabet' }
    ]
    expect(mentionOptions(c, 'AL').map((x) => x.id)).toEqual(['a', 'c'])
    expect(mentionOptions(c, '').length).toBe(3)
    expect(mentionOptions(c, '', 2).length).toBe(2)
  })
})

describe('insertMention', () => {
  it('replaces the @query with a token and puts the caret after it', () => {
    const r = insertMention('ping @be now', 5, 8, { id: 'b1', title: 'Beta' })
    expect(r.text).toBe('ping @[Beta](node:b1)  now')
    expect(r.text.slice(0, r.caret)).toBe('ping @[Beta](node:b1) ')
    expect(parseMentions(r.text)).toEqual(['b1'])
  })
})

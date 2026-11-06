import { describe, expect, it } from 'vitest'
import { commandSegments, mentionsSlashToken } from './chatComposerHighlight'

const known = new Set(['explain', 'tools:tidy-up', 'compact'])

describe('commandSegments', () => {
  it('cuts out known commands at the start or after whitespace, as the TUI colors them', () => {
    const segs = commandSegments('/compact then /tools:tidy-up and /notaskill', known)

    expect(segs).toEqual([
      { text: '/compact', command: true },
      { text: ' then ', command: false },
      { text: '/tools:tidy-up', command: true },
      { text: ' and /notaskill', command: false }
    ])
  })

  it('needs the command to end the word, and to start one', () => {
    expect(commandSegments('/explainx', known)).toBeNull()
    expect(commandSegments('a/explain', known)).toBeNull()
    expect(commandSegments('/explain,', known)).toBeNull()
  })

  it('keeps every character, newlines included', () => {
    const text = 'one\n/explain\n\ntwo '

    const segs = commandSegments(text, known)

    expect(segs?.map((s) => s.text).join('')).toBe(text)
  })

  it('is null for a draft with no known command', () => {
    expect(commandSegments('plain text /nothing', known)).toBeNull()
    expect(commandSegments('', known)).toBeNull()
  })
})

describe('mentionsSlashToken', () => {
  it('spots a /name where the menu would open', () => {
    expect(mentionsSlashToken('use /explain')).toBe(true)
    expect(mentionsSlashToken('/x')).toBe(true)
    expect(mentionsSlashToken('src/x and /')).toBe(false)
  })
})

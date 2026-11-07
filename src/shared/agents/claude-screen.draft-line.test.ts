import { describe, expect, it } from 'vitest'
import capture from './__fixtures__/claude/draft-line-capture.json'
import older from './__fixtures__/claude/composer-capture.json'
import { readClaudeDraftLine } from './claude-screen'

const screen = (name: keyof typeof capture.screens): string => capture.screens[name]

describe('readClaudeDraftLine (Claude Code 2.1.319 captures)', () => {
  it('reads an empty box as empty, never its placeholder', () => {
    expect(readClaudeDraftLine(screen('empty'))).toEqual({ kind: 'empty' })
  })

  it('reads a one-row draft exactly, doubled spaces included', () => {
    expect(readClaudeDraftLine(screen('line'))).toEqual({ kind: 'line', text: 'fix the  login bug, then run tests' })
  })

  it('reads a half-typed command with its menu open', () => {
    expect(readClaudeDraftLine(screen('slash-partial'))).toEqual({ kind: 'line', text: '/he' })
  })

  it('refuses a line that wraps, since a wrap looks like a newline', () => {
    expect(readClaudeDraftLine(screen('wrapped'))).toEqual({ kind: 'refused', reason: 'multi-line' })
  })

  it('refuses real newlines', () => {
    expect(readClaudeDraftLine(screen('multiline'))).toEqual({ kind: 'refused', reason: 'multi-line' })
  })

  it('refuses a collapsed paste', () => {
    expect(readClaudeDraftLine(screen('pasted'))).toEqual({ kind: 'refused', reason: 'placeholder' })
  })

  it('refuses shell mode', () => {
    expect(readClaudeDraftLine(screen('shellmode'))).toEqual({ kind: 'refused', reason: 'not-prompt' })
  })

  it('has nothing to read without a screen', () => {
    expect(readClaudeDraftLine('')).toBeNull()
  })
})

describe('readClaudeDraftLine (Claude Code 2.1.301 captures)', () => {
  it('agrees with the older composer fixture', () => {
    expect(readClaudeDraftLine(older.screens.empty)).toEqual({ kind: 'empty' })
    expect(readClaudeDraftLine(older.screens.draft)?.kind).toBe('line')
    expect(readClaudeDraftLine(older.screens.multiline)).toEqual({ kind: 'refused', reason: 'multi-line' })
    expect(readClaudeDraftLine(older.screens.pasted)).toEqual({ kind: 'refused', reason: 'placeholder' })
    expect(readClaudeDraftLine(older.screens.shellmode)).toEqual({ kind: 'refused', reason: 'not-prompt' })
  })
})

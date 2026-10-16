import { describe, expect, it } from 'vitest'
import { readClaudeComposer } from './claude-screen'
import capture from './__fixtures__/claude/composer-capture.json'

// Real captures (Claude Code 2.1.301, `capture-pane -p -e`) — see the fixture's `_note`. Issue #1144.
const S = capture.screens as Record<string, string>

describe('readClaudeComposer (#1144)', () => {
  it('reads the dim placeholder as an EMPTY composer', () => {
    expect(readClaudeComposer(S.empty)).toBe('empty')
  })

  it('reads a typed draft as a draft — the reporter’s case', () => {
    expect(readClaudeComposer(S.draft)).toBe('draft')
  })

  it('reads a multi-line draft as a draft', () => {
    expect(readClaudeComposer(S.multiline)).toBe('draft')
  })

  it('reads a collapsed paste placeholder as a draft (it is the user’s pasted text)', () => {
    expect(readClaudeComposer(S.pasted)).toBe('draft')
  })

  it('reads shell mode as a draft even with a dim placeholder — text there runs as a command', () => {
    expect(readClaudeComposer(S.shellmode)).toBe('draft')
  })

  it('reads the placeholder words TYPED by the user (not dim) as a draft', () => {
    const typed = S.empty.replace('\x1b[2mTry "fix typecheck errors"\x1b[0m', 'Try "fix typecheck errors"')
    expect(typed).not.toBe(S.empty)
    expect(readClaudeComposer(typed)).toBe('draft')
  })

  it('a capture that lost its SGR fails closed (draft, never empty)', () => {
    // eslint-disable-next-line no-control-regex
    expect(readClaudeComposer(S.empty.replace(/\x1b\[[0-9;]*m/g, ''))).toBe('draft')
  })

  it('a bare prompt with nothing after it is empty', () => {
    const bare = S.empty.replace(' \x1b[2mTry "fix typecheck errors"\x1b[0m', ' ')
    expect(readClaudeComposer(bare)).toBe('empty')
  })

  it('does not read the 2 inside a 38;2;r;g;b colour as dim', () => {
    const coloured = S.empty.replace('\x1b[2mTry "fix typecheck errors"\x1b[0m', '\x1b[38;2;200;200;200mhello\x1b[0m')
    expect(readClaudeComposer(coloured)).toBe('draft')
  })

  it('a dialog or a missing input box is no-prompt; an empty capture is unknown', () => {
    const lines = S.empty.split('\n')
    const noBox = lines.filter((l) => !l.includes('─')).join('\n')
    expect(readClaudeComposer(noBox)).toBe('no-prompt')
    const dialog = S.empty.replace(/\n[^\n]*manual mode on[^\n]*/, '\n Enter to confirm · Esc to cancel')
    expect(readClaudeComposer(dialog)).toBe('no-prompt')
    expect(readClaudeComposer('')).toBe('unknown')
    expect(readClaudeComposer('\n\n')).toBe('unknown')
  })
})

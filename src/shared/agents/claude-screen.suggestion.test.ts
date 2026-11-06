// The prompt Claude Code suggests after a turn (`readClaudeSuggestion`). The screen shapes are the
// ones MEASURED on Claude Code 2.1.318 in a sandboxed tmux server: a suggestion is plain dim text on
// the prompt line; a fresh-session tip and the queued-message hint are dim there too and are not
// suggestions.
import { describe, expect, it } from 'vitest'
import { readClaudeSuggestion } from './claude-screen'

const RULE = '─'.repeat(80)
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const screen = (promptLine: string, below: string[] = []): string =>
  [RULE, promptLine, ...below, RULE, '  🧠 Haiku 5.5 | 6%', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')

describe('readClaudeSuggestion', () => {
  it('reads the dim suggestion on the prompt line', () => {
    const s = screen(`\x1b[39m❯ ${DIM}run it in the background${RESET}`)

    const result = readClaudeSuggestion(s)

    expect(result).toBe('run it in the background')
  })

  it('offers nothing for a fresh-session tip', () => {
    const s = screen(`\x1b[39m❯ ${DIM}Try "create a util logging.py that..."${RESET}`)

    expect(readClaudeSuggestion(s)).toBeNull()
  })

  it('offers nothing for the queued-message hint', () => {
    const s = screen(`\x1b[38;5;246m❯ ${DIM}\x1b[39mPress up to edit queued messages${RESET}`)

    expect(readClaudeSuggestion(s)).toBeNull()
  })

  it('offers nothing when the box holds a draft', () => {
    expect(readClaudeSuggestion(screen('\x1b[39m❯ draft text here'))).toBeNull()
    expect(readClaudeSuggestion(screen(`\x1b[39m❯ ${DIM}line one${RESET}`, ['  line two']))).toBeNull()
  })

  it('offers nothing for an empty box', () => {
    expect(readClaudeSuggestion(screen('\x1b[39m❯ '))).toBeNull()
  })

  it('offers nothing when a dialog owns the screen', () => {
    const trust = [RULE, ' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join(
      '\n'
    )

    expect(readClaudeSuggestion(trust)).toBeNull()
  })

  it('offers nothing from a capture that lost its styling (the text could be a draft)', () => {
    expect(readClaudeSuggestion(screen('❯ run it in the background'))).toBeNull()
  })

  it('offers nothing from an empty capture', () => {
    expect(readClaudeSuggestion('')).toBeNull()
  })
})

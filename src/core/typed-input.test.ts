import { describe, expect, it, vi } from 'vitest'
import {
  TYPED_TAB,
  chatPromptPlan,
  typeThenSubmitWhenSettled,
  typedInputScript,
  typedLines,
  typedStdin,
  type TypedSurface
} from './typed-input'

describe('typedLines', () => {
  it('splits on every line-ending style and keeps blank lines', () => {
    expect(typedLines('one\r\ntwo\rthree\n\nfive')).toEqual(['one', 'two', 'three', '', 'five'])
  })

  it('turns tabs into spaces, since a typed Tab is a composer shortcut', () => {
    expect(typedLines('a\tb')).toEqual([`a${TYPED_TAB}b`])
  })

  it('drops control characters, which would arrive as KEYS', () => {
    expect(typedLines('stop\x03 here\x1b[201~ and \x7f\x9b there')).toEqual(['stop here[201~ and  there'])
  })

  it('leaves printable text alone, including the characters tmux argv parsing mangles', () => {
    expect(typedLines('- dash; \\; é 日本')).toEqual(['- dash; \\; é 日本'])
  })
})

describe('typedStdin', () => {
  it('terminates every line, so the script reads the last one too', () => {
    expect(typedStdin(['a', '', 'b'])).toBe('a\n\nb\n')
  })
})

describe('typedInputScript', () => {
  it('refuses a target or socket it would splice unsafely', () => {
    expect(() => typedInputScript('tmux', 'nodeterm-rmt', 'nt-x; rm -rf /', 'nt-paste-abc')).toThrow()
    expect(() => typedInputScript('tmux', 'bad socket', 'nt-abc', 'nt-paste-abc')).toThrow()
  })
})

/** A pane whose screen gains `text` once typed, after `lag` captures. */
function fakeSurface(opts: {
  screen?: string
  lag?: number
  typeOk?: boolean
  submitOk?: boolean
  captureNull?: boolean
}): TypedSurface & { submit: ReturnType<typeof vi.fn>; typed: string[] } {
  let screen = opts.screen ?? '> '
  let pendingText: string | null = null
  let lag = opts.lag ?? 0
  const typed: string[] = []
  return {
    typed,
    capture: async () => {
      if (opts.captureNull === true) return null
      if (pendingText !== null) {
        if (lag === 0) {
          screen += pendingText
          pendingText = null
        } else lag--
      }
      return screen
    },
    type: async (stdin) => {
      typed.push(stdin)
      if (opts.typeOk === false) return false
      pendingText = stdin
      return true
    },
    submit: vi.fn(async () => opts.submitOk ?? true)
  }
}

const noWait = { wait: async () => {} }

describe('typeThenSubmitWhenSettled', () => {
  it('submits once the text is on screen on two polls in a row', async () => {
    const surface = fakeSurface({ lag: 2 })

    const result = await typeThenSubmitWhenSettled('hello there', surface, noWait)

    expect(result).toBe(true)
    expect(surface.typed).toEqual(['hello there\n'])
    expect(surface.submit).toHaveBeenCalledTimes(1)
  })

  it('does not count an identical message that was already on screen', async () => {
    const surface = fakeSurface({ screen: '> continue\n> ', lag: 99 })

    const result = await typeThenSubmitWhenSettled('continue', surface, noWait)

    expect(result).toBe('pasted-not-submitted')
    expect(surface.submit).not.toHaveBeenCalled()
  })

  it('types NOTHING when the pane cannot be read, and answers null so the caller delivers another way', async () => {
    const surface = fakeSurface({ captureNull: true })

    const result = await typeThenSubmitWhenSettled('hello', surface, noWait)

    expect(result).toBeNull()
    expect(surface.typed).toEqual([])
    expect(surface.submit).not.toHaveBeenCalled()
  })

  it('reports a failed or partial type as possibly pasted, never as delivered', async () => {
    const surface = fakeSurface({ typeOk: false })

    const result = await typeThenSubmitWhenSettled('hello', surface, noWait)

    expect(result).toBe('pasted-not-submitted')
    expect(surface.submit).not.toHaveBeenCalled()
  })

  it('reports a failed Enter as possibly pasted', async () => {
    const surface = fakeSurface({ submitOk: false })

    const result = await typeThenSubmitWhenSettled('hello', surface, noWait)

    expect(result).toBe('pasted-not-submitted')
  })

  it('types NOTHING when the gate refuses the screen before typing, and returns its refusal', async () => {
    const surface = fakeSurface({ screen: 'Select model\nEsc to cancel' })
    const refusal = { blocked: 'screen' as const, dialog: 'Select model' }

    const result = await typeThenSubmitWhenSettled('hello', surface, {
      ...noWait,
      gate: (screen) => (screen.includes('Esc to cancel') ? refusal : null)
    })

    expect(result).toEqual(refusal)
    expect(surface.typed).toEqual([])
    expect(surface.submit).not.toHaveBeenCalled()
  })

  it('withholds the Enter from a dialog that appeared after the text was typed', async () => {
    const surface = fakeSurface({ lag: 1 })
    let captures = 0

    const result = await typeThenSubmitWhenSettled('hello there', surface, {
      ...noWait,
      // Clean before typing; a dialog from the second read on.
      gate: () => (++captures > 1 ? { blocked: 'screen', dialog: null } : null)
    })

    expect(result).toBe('pasted-not-submitted')
    expect(surface.typed).toEqual(['hello there\n'])
    expect(surface.submit).not.toHaveBeenCalled()
  })

  it('submits normally when the gate passes every read', async () => {
    const surface = fakeSurface({ lag: 1 })

    const result = await typeThenSubmitWhenSettled('hello there', surface, { ...noWait, gate: () => null })

    expect(result).toBe(true)
    expect(surface.submit).toHaveBeenCalledTimes(1)
  })

  it('types nothing for a message with no visible characters', async () => {
    const surface = fakeSurface({})

    const result = await typeThenSubmitWhenSettled(' \n\t\x03 ', surface, noWait)

    expect(result).toBe(false)
    expect(surface.typed).toEqual([])
  })
})

describe('chatPromptPlan — how a chat-view prompt is delivered, by agent', () => {
  it('types and reads the screen for claude, the one agent both were measured on', () => {
    expect(chatPromptPlan('claude')).toEqual({ typed: true, readScreen: true })
  })

  it('pastes, with no screen check, for every other chat agent — upstream\'s path unchanged', () => {
    for (const id of ['codex', 'gemini', 'grok', 'copilot', 'opencode']) {
      expect(chatPromptPlan(id)).toEqual({ typed: false, readScreen: false })
    }
  })
})

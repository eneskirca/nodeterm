import { describe, expect, it, vi } from 'vitest'
import {
  TYPED_TAB,
  localTypedArgs,
  localTypedEnv,
  typeThenSubmitWhenSettled,
  typedInputScript,
  typedLines,
  typedStdin,
  type TypedSurface
} from './typed-input'
import { readClaudeDraft } from '../shared/agents/claude-screen'
import composer from '../shared/agents/__fixtures__/claude/composer-capture.json'

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

  it('leaves the text unsubmitted when the pane cannot be read', async () => {
    const surface = fakeSurface({ captureNull: true })

    const result = await typeThenSubmitWhenSettled('hello', surface, noWait)

    expect(result).toBe('pasted-not-submitted')
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

  it('withholds the Enter when canSubmit says something now owns the keyboard', async () => {
    const surface = { ...fakeSurface({ lag: 0 }), canSubmit: vi.fn(async () => false) }

    const result = await typeThenSubmitWhenSettled('hello', surface, noWait)

    expect(result).toBe('pasted-not-submitted')
    expect(surface.canSubmit).toHaveBeenCalledTimes(1)
    expect(surface.submit).not.toHaveBeenCalled()
  })

  it('asks canSubmit only once the text is on screen, then submits', async () => {
    const surface = { ...fakeSurface({ lag: 1 }), canSubmit: vi.fn(async () => true) }

    const result = await typeThenSubmitWhenSettled('hello', surface, noWait)

    expect(result).toBe(true)
    expect(surface.canSubmit).toHaveBeenCalledTimes(1)
    expect(surface.submit).toHaveBeenCalledTimes(1)
  })

  it('submits a one-letter answer whose letter typing also removes elsewhere on screen', async () => {
    // Real Claude Code captures: typing clears the placeholder and shortens the status line, which
    // loses the `a` in "← for agents". Counting `a` across the screen never rose, so the Enter was
    // withheld with the answer sitting in the box.
    const before = composer.screens.empty
    const after = composer.screens.draft.replace('heb ik getest', 'a')
    let captures = 0
    const submit = vi.fn(async () => true)

    const result = await typeThenSubmitWhenSettled('a', {
      capture: async () => (captures++ === 0 ? before : after),
      type: async () => true,
      submit,
      draftOf: readClaudeDraft
    }, noWait)

    expect(result).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('does not take a draft that already ended with the answer as the answer arriving', async () => {
    const leftover = composer.screens.draft.replace('heb ik getest', 'a')
    const submit = vi.fn(async () => true)

    const result = await typeThenSubmitWhenSettled('a', {
      capture: async () => leftover,
      type: async () => true,
      submit,
      draftOf: readClaudeDraft
    }, noWait)

    expect(result).toBe('pasted-not-submitted')
    expect(submit).not.toHaveBeenCalled()
  })

  it('falls back to counting on screen when the composer cannot be read', async () => {
    const surface = { ...fakeSurface({ lag: 1 }), draftOf: () => null }

    const result = await typeThenSubmitWhenSettled('hello there', surface, noWait)

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

describe('localTypedArgs / localTypedEnv', () => {
  it('keeps the tmux path out of the shell command: it rides the environment', () => {
    const args = localTypedArgs('node-terminal', 'nt-a', 'nt-paste-0123456789ab')

    const env = localTypedEnv("/opt/it's here/tmux", { HOME: '/h' })

    expect(args).toHaveLength(2)
    expect(args[1]).toContain('"$NT_TYPED_TMUX" -L node-terminal')
    expect(env).toEqual({ HOME: '/h', NT_TYPED_TMUX: "/opt/it's here/tmux" })
  })
})

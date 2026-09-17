import { describe, it, expect } from 'vitest'
import {
  localTmuxEnterArgs,
  localTmuxPasteArgs,
  runDelayedEnterDelivery,
  pasteBufferName,
  sessionName,
  isSessionName,
  TMUX_SOCKET
} from './tmux-naming'

describe('sessionName / isSessionName', () => {
  it('round-trips a plain node id', () => {
    expect(isSessionName(sessionName('abc-123'))).toBe(true)
  })
  it('refuses a target that did not come from sessionName', () => {
    expect(isSessionName('nt-a b')).toBe(false)
    expect(isSessionName('other')).toBe(false)
  })
})

describe('localTmuxEnterArgs', () => {
  // The bare submit, used only for `sendText('', { enter: true })` now that the ordinary path is
  // one atomic tmux command list. It carries no literal body, so it needs no `--`.
  it('is a plain Enter with no payload', () => {
    expect(localTmuxEnterArgs('sock', 'nt-x')).toEqual([
      '-L',
      'sock',
      'send-keys',
      '-t',
      'nt-x',
      'Enter'
    ])
    expect(localTmuxEnterArgs(TMUX_SOCKET, 'nt-x')).not.toContain('-l')
  })
})

/**
 * The delivery `sendText` actually uses. Structure only — `tmux-paste.realtmux.test.ts` is where
 * the same argv is handed to a real tmux driving a real application and the BYTES are judged.
 */
describe('localTmuxPasteArgs', () => {
  const BUF = 'nt-paste-deadbeef'

  it('is one invocation: stdin buffer, gated cancel, framed paste, Enter — in that order', () => {
    expect(localTmuxPasteArgs('sock', 'nt-x', BUF, true)).toEqual([
      '-L', 'sock',
      'load-buffer', '-b', BUF, '-',
      ';', 'if-shell', '-F', '-t', 'nt-x', '#{pane_in_mode}', 'send-keys -t nt-x -X cancel',
      ';', 'paste-buffer', '-d', '-p', '-r', '-b', BUF, '-t', 'nt-x',
      ';', 'send-keys', '-t', 'nt-x', 'Enter'
    ])
  })

  it('omits the Enter for a dictation insert', () => {
    expect(localTmuxPasteArgs('sock', 'nt-x', BUF, false)).not.toContain('Enter')
  })

  // The version floor this PR removes. `#{bracket_paste_flag}` first shipped in tmux 3.7; every
  // older tmux expanded it to '' and the delivery mangled the write. Nothing here may depend on it.
  it('never reads #{bracket_paste_flag} — `-p` asks the pane instead, and has since tmux 1.7', () => {
    const args = localTmuxPasteArgs('sock', 'nt-x', BUF, true)
    expect(args).not.toContain('#{bracket_paste_flag}')
    expect(args).not.toContain('display-message')
    expect(args).toContain('-p')
  })

  // Everything the payload could have been is absent: it goes down stdin, which is both the
  // MAX_ARG_STRLEN fix and the repo rule that no payload rides a command line.
  it('carries no payload of any kind', () => {
    const args = localTmuxPasteArgs('sock', 'nt-x', BUF, true)
    expect(args).not.toContain('set-buffer')
    expect(args).not.toContain('-l')
    expect(args.filter((a) => a === '-')).toHaveLength(1) // load-buffer's stdin marker
  })

  it('gives every call its own buffer, so two concurrent deliveries cannot overwrite each other', () => {
    const names = new Set(Array.from({ length: 200 }, () => pasteBufferName()))
    expect(names.size).toBe(200)
    for (const n of names) expect(n).toMatch(/^nt-paste-[0-9a-f]{12}$/)
  })

  it('refuses anything spliced unquoted that this app did not generate', () => {
    expect(() => localTmuxPasteArgs('sock', 'nt-x; kill-server', BUF, true)).toThrow(/paste target/)
    expect(() => localTmuxPasteArgs('sock', sessionName(''), BUF, true)).toThrow(/paste target/)
    expect(() => localTmuxPasteArgs('sock', 'nt-x', 'buffer0', true)).toThrow(/buffer name/)
    expect(() => localTmuxPasteArgs('sock', sessionName('term-mabc-3'), pasteBufferName(), true)).not.toThrow()
  })
})

// The `localFramedDelivery` suite that lived here is gone with the plan itself (issue #453):
// the messaging envelope now rides `localPasteDelivery` (enter=true) like every other write —
// tmux ≥ 3.7 passes paste-buffer content through vis(3), so a payload-carried frame cannot
// arrive as escapes. See the tombstone in tmux-naming.ts.

describe('runDelayedEnterDelivery', () => {
  const plan = { args: ['paste', 'args'], body: 'hello', cleanup: ['delete-buffer'] }

  it('sends the text, waits, then sends Enter as its own invocation', async () => {
    const calls: string[][] = []
    const slept: number[] = []
    const ok = await runDelayedEnterDelivery(
      plan,
      ['enter', 'args'],
      150,
      async (args) => {
        calls.push(args)
      },
      async (ms) => {
        // The wait must happen BETWEEN the two writes, which is the whole point: an Enter inside
        // the text's input burst is what devin and opencode absorb instead of submitting.
        slept.push(ms)
        expect(calls).toEqual([['paste', 'args']])
      }
    )
    expect(ok).toBe(true)
    expect(calls).toEqual([['paste', 'args'], ['enter', 'args']])
    expect(slept).toEqual([150])
  })

  // The ordering guarantee a single tmux command list gave for free: tmux abandons the rest of a
  // list when one of its commands fails, so the Enter could never fire after a failed text send.
  // Split across two invocations that has to be enforced here, or a submit would fire into a
  // composer holding whatever the USER had typed — worse than not delivering at all.
  it('never sends Enter when the text failed to land, and sweeps the buffer', async () => {
    const calls: string[][] = []
    const ok = await runDelayedEnterDelivery(
      plan,
      ['enter', 'args'],
      150,
      async (args) => {
        calls.push(args)
        if (args[0] === 'paste') throw new Error('cant find pane')
      },
      async () => {
        throw new Error('must not wait: there is nothing to submit')
      }
    )
    expect(ok).toBe(false)
    expect(calls).not.toContainEqual(['enter', 'args'])
    expect(calls).toContainEqual(['delete-buffer'])
  })

  it('reports false when the Enter itself fails, rather than a delivery it cannot stand behind', async () => {
    const ok = await runDelayedEnterDelivery(
      plan,
      ['enter', 'args'],
      1,
      async (args) => {
        if (args[0] === 'enter') throw new Error('session died between the two writes')
      },
      async () => {}
    )
    expect(ok).toBe(false)
  })
})

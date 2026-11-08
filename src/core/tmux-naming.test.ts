import { describe, it, expect } from 'vitest'
import {
  localTmuxEnterArgs,
  localTmuxPasteArgs,
  pasteBufferName,
  sessionName,
  isSessionName,
  exactPaneTarget,
  exactSessionTarget,
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
      '=nt-x:',
      'Enter'
    ])
    expect(localTmuxEnterArgs(TMUX_SOCKET, 'nt-x')).not.toContain('-l')
  })

  it('steps the cursor left first for a typed message ending in a backslash', () => {
    const args = localTmuxEnterArgs('sock', 'nt-x', { cursorLeftFirst: true })

    expect(args.slice(-2)).toEqual(['Left', 'Enter'])
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
      ';', 'if-shell', '-F', '-t', '=nt-x:', '#{pane_in_mode}', 'send-keys -t =nt-x: -X cancel',
      ';', 'paste-buffer', '-d', '-p', '-r', '-b', BUF, '-t', '=nt-x:',
      ';', 'send-keys', '-t', '=nt-x:', 'Enter'
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

/**
 * The exact targets every node-keyed tmux verb uses (security audit F1/F2). A bare `-t nt-x-1` whose
 * session is gone reaches a live `nt-x-12`; `pty-exact-target.realtmux.test.ts` measures that on a
 * real tmux. Here: the spelling, and the refusal of anything this app did not generate.
 */
describe('exactPaneTarget / exactSessionTarget', () => {
  it('spells the exact pane and session forms', () => {
    expect(exactPaneTarget('nt-term-abc-1')).toBe('=nt-term-abc-1:')
    expect(exactSessionTarget('nt-term-abc-1')).toBe('=nt-term-abc-1')
    expect(exactPaneTarget(sessionName('a.b'))).toBe('=nt-a_b:')
  })
  it('refuses a name that did not come from sessionName — it is spliced unquoted', () => {
    for (const bad of ['', 'nt-', 'x', 'nt-a b', 'nt-a;kill-server', 'nt-a\nx', '=nt-a:', 'nt-a:0']) {
      expect(() => exactPaneTarget(bad), JSON.stringify(bad)).toThrow()
      expect(() => exactSessionTarget(bad), JSON.stringify(bad)).toThrow()
    }
  })
  it('every builder that names a pane uses the exact form', () => {
    expect(localTmuxEnterArgs('sock', 'nt-x')).not.toContain('nt-x')
    expect(localTmuxPasteArgs('sock', 'nt-x', 'nt-paste-ab', true).filter((a) => a === 'nt-x')).toEqual([])
  })
})

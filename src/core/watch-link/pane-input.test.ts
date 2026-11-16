// The pure builders behind a live link controller's input. What they MEAN on a real tmux (bytes
// exact, the prefix inert, a mode cancelled first, the exact session only) is proven in
// `pane-input.realtmux.test.ts`; this file pins their shape and their refusals.
import { describe, expect, it } from 'vitest'
import {
  KEYS_PER_COMMAND,
  controlInputPlan,
  exactPaneTarget,
  keysCommandText,
  localKeysArgs,
  localPasteArgs,
  remoteControlInputPlan,
  remoteKeysArgs,
  remotePasteArgs
} from './pane-input'
import { SESSION_SOCKET_REF, sessionSocketProbe } from '../remote-ssh/control-master'
import { remoteTmuxPathPrologue } from '../../shared/ssh'

const CONN = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }
const CM = '/cm/p1'

describe('pane input builders', () => {
  it('targets the session exactly, never a prefix', () => {
    expect(exactPaneTarget('nt-abc')).toBe('=nt-abc:')
    for (const bad of ['', 'nt abc', 'nt-a;b', "nt-a'b", '=nt-a', 'nt-a:', 's', 'nt-a\nkill-server'])
      expect(() => exactPaneTarget(bad)).toThrow()
  })

  it('cancels any mode first, then types every byte as hex', () => {
    expect(keysCommandText('nt-a', '\x1b[A')).toBe(
      "if-shell -F -t =nt-a: '#{pane_in_mode}' 'copy-mode -q -t =nt-a:'\n" + 'send-keys -t =nt-a: -H 1b 5b 41\n'
    )
  })

  it('encodes UTF-8 bytes, not code points', () => {
    expect(keysCommandText('nt-s', 'ç🙂').split('\n')[1]).toBe('send-keys -t =nt-s: -H c3 a7 f0 9f 99 82')
  })

  it('splits long input into lines of KEYS_PER_COMMAND bytes, in order', () => {
    const data = 'x'.repeat(KEYS_PER_COMMAND * 2 + 3)
    const lines = keysCommandText('nt-s', data).trimEnd().split('\n').slice(1)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.split(' -H ')[1].split(' ').length)).toEqual([KEYS_PER_COMMAND, KEYS_PER_COMMAND, 3])
    // Order: a byte that changes per position must come back in the same sequence.
    const seq = Array.from({ length: KEYS_PER_COMMAND + 2 }, (_, i) => String.fromCharCode(0x41 + (i % 26))).join('')
    const hex = keysCommandText('nt-s', seq)
      .trimEnd()
      .split('\n')
      .slice(1)
      .flatMap((l) => l.split(' -H ')[1].split(' '))
    expect(hex.map((h) => String.fromCharCode(parseInt(h, 16))).join('')).toBe(seq)
  })

  it('every byte value is typed as exactly one two-digit hex token', () => {
    const all = String.fromCharCode(...Array.from({ length: 128 }, (_, i) => i))
    const tokens = keysCommandText('nt-s', all).split('\n')[1].split(' -H ')[1].split(' ')
    expect(tokens).toHaveLength(128)
    expect(tokens.every((t) => /^[0-9a-f]{2}$/.test(t))).toBe(true)
  })

  it('keeps every typed byte off the command line', () => {
    expect(localKeysArgs('sock')).toEqual(['-L', 'sock', 'source-file', '-'])
    const args = localPasteArgs('sock', 'nt-a', 'nt-paste-0a1b2c3d4e5f')
    expect(args.join(' ')).toBe(
      '-L sock load-buffer -b nt-paste-0a1b2c3d4e5f - ; if-shell -F -t =nt-a: #{pane_in_mode} copy-mode -q -t =nt-a: ; paste-buffer -d -p -r -b nt-paste-0a1b2c3d4e5f -t =nt-a:'
    )
  })

  it('a paste never presses Enter and never names a target that is not exact', () => {
    const args = localPasteArgs('sock', 'nt-a', 'nt-paste-0a')
    expect(args).not.toContain('Enter')
    expect(args).not.toContain('send-keys')
    expect(() => localPasteArgs('sock', 'nt-a', 'nt-paste-0a; kill-server')).toThrow()
    expect(() => localPasteArgs('sock', 'a', 'nt-paste-0a')).toThrow()
  })

  it('refuses an empty key chunk rather than build a send-keys with no bytes', () => {
    expect(() => keysCommandText('nt-s', '')).toThrow(/no bytes/)
  })
})

describe('the plan one chunk runs (local)', () => {
  it('keys: source-file - with the command text on stdin, nothing to sweep', () => {
    const plan = controlInputPlan('sock', 'nt-a', { kind: 'keys', data: 'ls\r' })
    expect(plan).toEqual({ args: ['-L', 'sock', 'source-file', '-'], body: keysCommandText('nt-a', 'ls\r'), cleanup: null })
  })

  it('paste: the sanitized text rides stdin, framed by tmux (-p), and a failed paste sweeps its own buffer', () => {
    const plan = controlInputPlan('sock', 'nt-a', { kind: 'paste', text: 'a\x1b[201~b\u009bc\nd' })!
    expect(plan.body).toBe('a[201~bc\nd')
    const buffer = plan.args[plan.args.indexOf('-b') + 1]
    expect(buffer).toMatch(/^nt-paste-[a-z0-9]+$/)
    expect(plan.args).toEqual(localPasteArgs('sock', 'nt-a', buffer))
    expect(plan.cleanup).toEqual(['-L', 'sock', 'delete-buffer', '-b', buffer])
    expect(plan.args.join(' ')).not.toContain('a[201~b')
  })

  it('paste: two plans never share a buffer', () => {
    const a = controlInputPlan('sock', 'nt-a', { kind: 'paste', text: 'x' })!
    const b = controlInputPlan('sock', 'nt-a', { kind: 'paste', text: 'x' })!
    expect(a.cleanup).not.toEqual(b.cleanup)
  })

  it('paste: text that sanitizes to nothing has nothing to run', () => {
    expect(controlInputPlan('sock', 'nt-a', { kind: 'paste', text: '\x1b\u009b' })).toBeNull()
    expect(controlInputPlan('sock', 'nt-a', { kind: 'paste', text: '' })).toBeNull()
  })

  it('refuses a session name it did not generate, for both kinds', () => {
    expect(() => controlInputPlan('sock', 'nt-a b', { kind: 'keys', data: 'x' })).toThrow()
    expect(() => controlInputPlan('sock', 'nt-a b', { kind: 'paste', text: 'x' })).toThrow()
  })
})

describe('the remote twins (over the ControlMaster)', () => {
  it('keys: ssh runs `tmux source-file -` on the socket HOLDING the session; the command text rides stdin', () => {
    const args = remoteKeysArgs(CONN, CM, 'nt-a')
    expect(args).toContain(`ControlPath=${CM}`)
    expect(args.at(-1)).toBe(`${remoteTmuxPathPrologue()}${sessionSocketProbe('nt-a')}tmux -L ${SESSION_SOCKET_REF} source-file -`)
    expect(args.at(-2)).toBe('deploy@h.example.com')
  })

  it('paste: exact quoted target, mode cancel, -p, no Enter, and the text is not in argv', () => {
    const cmd = remotePasteArgs(CONN, CM, 'nt-a', 'nt-paste-0a').at(-1)!
    expect(cmd).toBe(
      `${remoteTmuxPathPrologue()}${sessionSocketProbe('nt-a')}tmux -L ${SESSION_SOCKET_REF} load-buffer -b nt-paste-0a - ';' ` +
        `if-shell -F -t '=nt-a:' '#{pane_in_mode}' 'copy-mode -q -t =nt-a:' ';' ` +
        `paste-buffer -d -p -r -b nt-paste-0a -t '=nt-a:'`
    )
    expect(cmd).not.toContain('Enter')
    expect(() => remotePasteArgs(CONN, CM, "nt-a'", 'nt-paste-0a')).toThrow()
    expect(() => remotePasteArgs(CONN, CM, 'nt-a', 'nt-paste-0a;x')).toThrow()
  })

  it('a remote plan carries the same body as the local one and sweeps on the host', () => {
    const keys = remoteControlInputPlan(CONN, CM, 'nt-a', { kind: 'keys', data: '\x02s' })
    expect(keys).toEqual({ args: remoteKeysArgs(CONN, CM, 'nt-a'), body: keysCommandText('nt-a', '\x02s'), cleanup: null })
    const paste = remoteControlInputPlan(CONN, CM, 'nt-a', { kind: 'paste', text: 'p\x1bq' })!
    expect(paste.body).toBe('pq')
    const buffer = /load-buffer -b (nt-paste-[a-z0-9]+) -/.exec(paste.args.at(-1)!)![1]
    expect(paste.args).toEqual(remotePasteArgs(CONN, CM, 'nt-a', buffer))
    expect(paste.cleanup!.at(-1)).toContain(`delete-buffer -b ${buffer}`)
    expect(remoteControlInputPlan(CONN, CM, 'nt-a', { kind: 'paste', text: '\x1b' })).toBeNull()
  })

  it('no payload byte ever reaches the ssh argv', () => {
    const secret = 'hunter2-PASSWORD'
    const keys = remoteControlInputPlan(CONN, CM, 'nt-a', { kind: 'keys', data: secret })!
    const paste = remoteControlInputPlan(CONN, CM, 'nt-a', { kind: 'paste', text: secret })!
    for (const p of [keys, paste]) expect(p.args.join('\u0000')).not.toContain('hunter2')
    const local = controlInputPlan('sock', 'nt-a', { kind: 'keys', data: secret })!
    expect(local.args.join('\u0000')).not.toContain('hunter2')
  })
})

// The socket probe is generated shell that no compiler checks, and it decides which tmux SERVER a
// node's commands reach — so it is run for real, under /bin/sh (and zsh, where installed: a remote
// login shell is the user's), against a fake tmux with one state dir per socket.
//
// What it pins is the upgrade incident in control-master.ts `sessionSocketProbe`: a session an
// older build left on `nodeterm-rmt` must be ATTACHED where it is, never shadowed by a fresh
// `nt-<id>` on `node-terminal`.
import { execFile, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SshConnection } from '../../shared/ssh'
import {
  SESSION_SOCKET_REF,
  remoteCapturePaneArgs,
  remoteListSessionsArgs,
  remoteTmuxKillArgs,
  remoteTmuxPasteArgs,
  remoteTmuxPtyArgs,
  remoteTypedArgs,
  sessionSocketProbe
} from './control-master'
import { TYPED_SOCKET_ENV_REF } from '../typed-input'

const conn = { host: 'h.example.com', user: 'deploy' } as SshConnection
const posix = process.platform !== 'win32'
const zsh = posix
  ? ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'].find((p) => fs.existsSync(p))
  : undefined

let dir: string, bin: string, log: string, stdinLog: string
const stateOf = (socket: string): string => path.join(dir, `state-${socket}`)
const add = (socket: string, session: string): void => {
  fs.mkdirSync(stateOf(socket), { recursive: true })
  fs.writeFileSync(path.join(stateOf(socket), session), '')
}
const calls = (): string[] =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []

beforeAll(() => {
  if (!posix) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-adopt-'))
  bin = path.join(dir, 'bin')
  log = path.join(dir, 'calls.log')
  stdinLog = path.join(dir, 'stdin.log')
  fs.mkdirSync(bin)
  // Sessions are files in `state-<socket>`; a socket with no state dir has no server. Every call
  // is logged as `<socket> <command> <target>`. `load-buffer` records what it read from stdin, so
  // a probe that swallowed the payload shows up as an empty record.
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    [
      '#!/bin/sh',
      `D=${JSON.stringify(dir)}`,
      'sock=""; cmd=""; target=""',
      'while [ $# -gt 0 ]; do case "$1" in',
      '  -L) shift; sock="$1";;',
      '  -t) shift; [ -n "$target" ] || target="$1";;',
      '  -s) shift; target="=$1";;',
      '  has-session|new-session|capture-pane|kill-session|list-sessions|load-buffer|send-keys|if-shell|paste-buffer|attach-session|display-message|delete-buffer) [ -n "$cmd" ] || cmd="$1";;',
      'esac; shift; done',
      'S="$D/state-$sock"',
      'echo "$sock $cmd $target" >> "$D/calls.log"',
      'if [ "$FAKE_TMUX_BROKEN" = "$sock" ]; then echo "fake: cannot run" >&2; exit 127; fi',
      'name="${target#=}"; name="${name%:}"',
      'if [ ! -d "$S" ]; then echo "no server running on /tmp/tmux-1000/$sock" >&2; exit 1; fi',
      'case "$cmd" in',
      '  list-sessions) ls "$S"; exit 0;;',
      '  load-buffer) cat >> "$D/stdin.log"; exit 0;;',
      '  new-session) : > "$S/$name"; exit 0;;',
      '  kill-session) [ -e "$S/$name" ] || { echo "can\'t find session: $name" >&2; exit 1; }; rm -f "$S/$name"; exit 0;;',
      '  *) [ -e "$S/$name" ] || { echo "can\'t find session: $name" >&2; exit 1; }; exit 0;;',
      'esac'
    ].join('\n'),
    { mode: 0o755 }
  )
})
afterAll(() => {
  if (posix) fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  if (!posix) return
  for (const f of fs.readdirSync(dir)) if (f !== 'bin') fs.rmSync(path.join(dir, f), { recursive: true, force: true })
})

/** Run a remote command line the way sshd would: `<login shell> -c <line>`. */
const run = (
  shell: string,
  line: string,
  opts: { stdin?: string; env?: Record<string, string> } = {}
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(
      shell,
      ['-c', line],
      { env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, ...opts.env } },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr })
      }
    )
    child.stdin?.end(opts.stdin ?? '')
  })

const last = (args: string[]): string => args[args.length - 1]

describe.skipIf(!posix)('the session socket probe (real shell, fake tmux)', () => {
  const shells = ['/bin/sh', ...(zsh ? [zsh] : [])]

  for (const shell of shells) {
    describe(shell, () => {
      const resolved = async (session: string): Promise<string> =>
        (await run(shell, `${sessionSocketProbe(session)}printf %s ${SESSION_SOCKET_REF}`)).stdout

      it('a session only the legacy socket holds resolves to the legacy socket', async () => {
        add('nodeterm-rmt', 'nt-a')
        expect(await resolved('nt-a')).toBe('nodeterm-rmt')
      })

      it('a session the unified socket holds resolves there, without asking the legacy one', async () => {
        add('node-terminal', 'nt-a')
        add('nodeterm-rmt', 'nt-a')
        expect(await resolved('nt-a')).toBe('node-terminal')
        expect(calls()).toEqual(['node-terminal has-session =nt-a'])
      })

      it('a session NEITHER holds resolves to the unified socket: nothing is created on the legacy one', async () => {
        add('nodeterm-rmt', 'nt-other')
        expect(await resolved('nt-a')).toBe('node-terminal')
      })

      it('the target is exact: a longer legacy name does not adopt a shorter node', async () => {
        add('nodeterm-rmt', 'nt-a-12')
        expect(await resolved('nt-a-1')).toBe('node-terminal')
      })

      it('a host where tmux cannot run still resolves (to the unified socket) and the body runs', async () => {
        const r = await run(shell, `${sessionSocketProbe('nt-a')}printf %s ${SESSION_SOCKET_REF}`, {
          env: { FAKE_TMUX_BROKEN: 'node-terminal' }
        })
        expect(r.stdout).toBe('node-terminal')
      })

      it('SPAWN: attaches the legacy session instead of creating a twin on the unified socket', async () => {
        add('nodeterm-rmt', 'nt-a')
        const r = await run(shell, last(remoteTmuxPtyArgs(conn, '/s.sock', 'nt-a', '/srv/app')))
        expect(r.code).toBe(0)
        expect(calls().filter((c) => c.includes('new-session'))).toEqual(['nodeterm-rmt new-session =nt-a'])
        expect(fs.existsSync(path.join(stateOf('node-terminal'), 'nt-a'))).toBe(false)
      })

      it('SPAWN: a genuinely new node is created on the unified socket even while a legacy server lives', async () => {
        add('nodeterm-rmt', 'nt-other')
        fs.mkdirSync(stateOf('node-terminal'))
        await run(shell, last(remoteTmuxPtyArgs(conn, '/s.sock', 'nt-new', '/srv/app')))
        expect(calls().filter((c) => c.includes('new-session'))).toEqual(['node-terminal new-session =nt-new'])
        expect(fs.readdirSync(stateOf('nodeterm-rmt'))).toEqual(['nt-other'])
      })

      it('READ + KILL follow the session to the legacy socket, and the exit code is the body\'s', async () => {
        add('nodeterm-rmt', 'nt-a')
        expect((await run(shell, last(remoteCapturePaneArgs(conn, '/s.sock', 'nt-a', false)))).code).toBe(0)
        expect(calls().at(-1)).toBe('nodeterm-rmt capture-pane =nt-a:')
        expect((await run(shell, last(remoteTmuxKillArgs(conn, '/s.sock', 'nt-a')))).code).toBe(0)
        expect(fs.existsSync(path.join(stateOf('nodeterm-rmt'), 'nt-a'))).toBe(false)
        // Gone everywhere now: the kill answers tmux's own exit 1, which callers read as "already gone".
        expect((await run(shell, last(remoteTmuxKillArgs(conn, '/s.sock', 'nt-a')))).code).toBe(1)
      })

      it('WRITE: the stdin payload reaches load-buffer on the legacy socket — the probe never reads it', async () => {
        add('nodeterm-rmt', 'nt-a')
        const r = await run(shell, last(remoteTmuxPasteArgs(conn, '/s.sock', 'nt-a', 'nt-paste-deadbeef', true)), {
          stdin: 'hello adopted pane'
        })
        expect(r.code).toBe(0)
        expect(fs.readFileSync(stdinLog, 'utf8')).toBe('hello adopted pane')
        expect(calls().filter((c) => c.includes('load-buffer'))).toEqual(['nodeterm-rmt load-buffer =nt-a:'])
      })

      it('TYPED: the inner sh script inherits the probed socket through its environment', async () => {
        expect(TYPED_SOCKET_ENV_REF).toBe(SESSION_SOCKET_REF)
        add('nodeterm-rmt', 'nt-a')
        const r = await run(shell, last(remoteTypedArgs(conn, '/s.sock', 'nt-a', 'nt-paste-deadbeef')), {
          stdin: '\nhi\n'
        })
        expect(r.code).toBe(0)
        const after = calls().filter((c) => !c.includes('has-session'))
        expect(after.length).toBeGreaterThan(0)
        for (const c of after) expect(c.startsWith('nodeterm-rmt ')).toBe(true)
        expect(fs.readFileSync(stdinLog, 'utf8')).toBe('hi')
      })

      describe('the warm/cold list', () => {
        const list = (env?: Record<string, string>): ReturnType<typeof run> =>
          run(shell, last(remoteListSessionsArgs(conn, '/s.sock')), { env })
        const names = (stdout: string): string[] => stdout.split('\n').filter(Boolean).sort()

        it('legacy-only host: exit 0 and the legacy names — the node reads WARM, nothing is typed into it', async () => {
          add('nodeterm-rmt', 'nt-a')
          const r = await list()
          expect(r.code).toBe(0)
          expect(names(r.stdout)).toEqual(['nt-a'])
        })

        it('both sockets: the union', async () => {
          add('node-terminal', 'nt-b')
          add('nodeterm-rmt', 'nt-a')
          const r = await list()
          expect(r.code).toBe(0)
          expect(names(r.stdout)).toEqual(['nt-a', 'nt-b'])
        })

        it('no server on either: tmux\'s own exit 1, the only evidence of absence', async () => {
          const r = await list()
          expect(r.code).toBe(1)
          expect(names(r.stdout)).toEqual([])
        })

        it('a FAILED read of the unified socket stays a failed read, whatever the legacy one lists', async () => {
          add('nodeterm-rmt', 'nt-a')
          const r = await list({ FAKE_TMUX_BROKEN: 'node-terminal' })
          expect(r.code).toBe(127)
        })
      })
    })
  }

  it('the fake tmux is on PATH for these runs (a self-check: a silent miss would pass every "unified" case)', () => {
    expect(execFileSync('/bin/sh', ['-c', 'command -v tmux'], { env: { PATH: `${bin}:/usr/bin:/bin` } }).toString().trim()).toBe(
      path.join(bin, 'tmux')
    )
  })
})

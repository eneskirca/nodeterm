// The SSH visible capture, executed by a REAL /bin/sh — the remote shell is what reads this line.
//
// The command carries two things a remote shell would happily eat: tmux's command separator (a bare
// `;` there ENDS the tmux command and runs `display-message` as a shell command of its own) and the
// `#{…}` format (brace/`#` handling). Only execution proves they reach tmux verbatim, so:
//  1. a stub `tmux` on PATH dumps its argv NUL-separated — the exact argv the remote tmux gets;
//  2. a stub that delegates to the REAL tmux on a private socket proves the whole line end to end:
//     screen + cursor from one invocation, and an exact-target miss yields nothing.
// Private socket in a private TMUX_TMPDIR; the delegating stub re-points `-L nodeterm-rmt` at it, so
// the production socket name is never bound anywhere.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { remoteCaptureVisibleArgs, RMT_TMUX_SOCKET } from './control-master'
import { VISIBLE_CAPTURE_FORMAT, parseVisibleCapture } from '../watch-link/capture-route'
import { testTmpDir } from '../test-tmp'
import { makeTmuxTmpdir } from '../tmux-test-socket'

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }
const SOCKET = `nt-wlrsh-${process.pid}`
const REAL_TMUX = (() => {
  if (process.platform === 'win32') return null
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()

let recordDir: string
let delegateDir: string
let tmuxTmp = ''

/** The last argv element of an `ssh …` argv IS the remote command line. */
const remoteCommand = (sessionId: string): string => remoteCaptureVisibleArgs(conn, '/cm/p1', sessionId).at(-1)!

function runUnder(binDir: string, line: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('/bin/sh', ['-c', line], {
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: '/home/u', ...(tmuxTmp ? { TMUX_TMPDIR: tmuxTmp } : {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

beforeAll(() => {
  const root = testTmpDir('ntcvs-')
  recordDir = path.join(root, 'record')
  delegateDir = path.join(root, 'delegate')
  fs.mkdirSync(recordDir)
  fs.mkdirSync(delegateDir)
  fs.writeFileSync(path.join(recordDir, 'tmux'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done\n`, {
    mode: 0o755
  })
  if (!REAL_TMUX) return
  tmuxTmp = makeTmuxTmpdir('ntwr-', SOCKET)
  // Re-point the production socket name at the private one, and refuse anything else: this stub
  // must never forward a command that does not start `-L nodeterm-rmt`.
  fs.writeFileSync(
    path.join(delegateDir, 'tmux'),
    `#!/bin/sh\n[ "$1" = "-L" ] && [ "$2" = "${RMT_TMUX_SOCKET}" ] || exit 99\nshift 2\nexec '${REAL_TMUX}' -L '${SOCKET}' "$@"\n`,
    { mode: 0o755 }
  )
  execFileSync(REAL_TMUX, ['-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'nt-r-12', '-x', '30', '-y', '4', "printf 'REMOTE-12\\n'; sleep 60"], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
    stdio: 'ignore'
  })
  for (let i = 0; i < 100; i++) {
    const out = execFileSync(REAL_TMUX, ['-L', SOCKET, 'capture-pane', '-p', '-t', '=nt-r-12:'], {
      env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
      encoding: 'utf8'
    })
    if (out.includes('REMOTE-12')) break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
})

afterAll(() => {
  if (!REAL_TMUX || !tmuxTmp) return
  try {
    execFileSync(REAL_TMUX, ['-L', SOCKET, 'kill-session', '-t', '=nt-r-12'], {
      env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
      stdio: 'ignore'
    })
  } catch {
    /* already gone */
  }
  fs.rmSync(tmuxTmp, { recursive: true, force: true })
})

describe('remoteCaptureVisibleArgs (real /bin/sh)', () => {
  it('the separator and the format reach the remote tmux as their own argv elements', () => {
    const { status, stdout } = runUnder(recordDir, remoteCommand('nt-abc'))
    expect(status).toBe(0)
    const argv = stdout.split('\0')
    expect(argv.pop()).toBe('')
    expect(argv).toEqual([
      '-L',
      RMT_TMUX_SOCKET,
      'capture-pane',
      '-p',
      '-e',
      '-t',
      '=nt-abc:',
      ';',
      'display-message',
      '-p',
      '-t',
      '=nt-abc:',
      VISIBLE_CAPTURE_FORMAT
    ])
  })

  it.skipIf(!REAL_TMUX)('end to end through a real tmux: the screen, then the cursor, from one invocation', () => {
    // Skipped without a tmux binary: the second half of the proof is tmux's own reply.
    const { status, stdout } = runUnder(delegateDir, remoteCommand('nt-r-12'))
    expect(status).toBe(0)
    const got = parseVisibleCapture(stdout)
    expect(got.screen).toContain('REMOTE-12')
    expect(got.cursor).toEqual({ x: 0, y: 1 })
    expect(got.screen).not.toMatch(/(^|\n)\d+ \d+\n?$/)
  })

  it.skipIf(!REAL_TMUX)('an exact-target miss prints nothing and fails — never the longer-named session', () => {
    const { status, stdout } = runUnder(delegateDir, remoteCommand('nt-r-1'))
    expect(status).not.toBe(0)
    expect(stdout).toBe('')
  })
})

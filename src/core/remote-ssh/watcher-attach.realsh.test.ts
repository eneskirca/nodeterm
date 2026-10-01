// A live link watcher's REMOTE tmux client, and the remote window-size read, executed by a real
// /bin/sh — the remote shell is what reads these lines.
//
// What only execution can prove:
//  - the client flags (`-f ignore-size,read-only`) and the exact target reach tmux as their own argv
//    elements;
//  - an OLD remote tmux that rejects the flags (< 3.2) ends the command with a failure and nothing
//    else: no retry with other flags, no create, and above all NO plain-shell fallback (the owner's
//    interactive command execs a login shell when tmux is missing; a watcher must never get one);
//  - the window-size read answers through a real tmux, and an exact-target miss answers nothing.
// Private socket in a private TMUX_TMPDIR; the delegating stub re-points `-L nodeterm-rmt` at it.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { remoteTmuxWatcherArgs, remoteWindowSizeArgs, RMT_TMUX_SOCKET } from './control-master'
import { WINDOW_SIZE_FORMAT, parseWindowSize } from '../watch-link/watcher-client'
import { testTmpDir } from '../test-tmp'
import { makeTmuxTmpdir } from '../tmux-test-socket'

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }
const SOCKET = `nt-wlwa-${process.pid}`
const REAL_TMUX = (() => {
  if (process.platform === 'win32') return null
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()

let root: string
let recordDir: string
let oldDir: string
let emptyDir: string
let delegateDir: string
let markerDir: string
let tmuxTmp = ''

const watcherLine = (id: string): string => remoteTmuxWatcherArgs(conn, '/cm/p1', id).at(-1)!
const sizeLine = (id: string): string => remoteWindowSizeArgs(conn, '/cm/p1', id).at(-1)!

function runUnder(binDir: string, line: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('/bin/sh', ['-c', line], {
      env: {
        PATH: binDir,
        HOME: '/home/u',
        // A watcher that fell back to a shell would exec $SHELL: make that a canary.
        SHELL: path.join(root, 'shell-canary'),
        ...(tmuxTmp ? { TMUX_TMPDIR: tmuxTmp } : {})
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

const markers = (): string[] => fs.readdirSync(markerDir).sort()

beforeAll(() => {
  root = testTmpDir('ntwas-')
  recordDir = path.join(root, 'record')
  oldDir = path.join(root, 'old')
  emptyDir = path.join(root, 'empty')
  delegateDir = path.join(root, 'delegate')
  markerDir = path.join(root, 'markers')
  for (const d of [recordDir, oldDir, emptyDir, delegateDir, markerDir]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(root, 'shell-canary'), `#!/bin/sh\n: > '${markerDir}/shell'\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(recordDir, 'tmux'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done\n`, {
    mode: 0o755
  })
  // tmux 3.1c's own answer to `attach-session -f …`: a usage line and exit 1. Every call is counted.
  fs.writeFileSync(
    path.join(oldDir, 'tmux'),
    `#!/bin/sh\n: > "${markerDir}/old-tmux-$$"\necho 'usage: attach-session [-dErx] [-c working-directory] [-t target-session]' >&2\nexit 1\n`,
    { mode: 0o755 }
  )
  if (!REAL_TMUX) return
  tmuxTmp = makeTmuxTmpdir('ntwa-', SOCKET)
  fs.writeFileSync(
    path.join(delegateDir, 'tmux'),
    `#!/bin/sh\n[ "$1" = "-L" ] && [ "$2" = "${RMT_TMUX_SOCKET}" ] || exit 99\nshift 2\nexec '${REAL_TMUX}' -L '${SOCKET}' "$@"\n`,
    { mode: 0o755 }
  )
  execFileSync(REAL_TMUX, ['-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'nt-w-12', '-x', '100', '-y', '30', 'sleep 60'], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
    stdio: 'ignore'
  })
})

afterAll(() => {
  if (!REAL_TMUX || !tmuxTmp) return
  try {
    execFileSync(REAL_TMUX, ['-L', SOCKET, 'kill-session', '-t', '=nt-w-12'], {
      env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
      stdio: 'ignore'
    })
  } catch {
    /* already gone */
  }
  fs.rmSync(tmuxTmp, { recursive: true, force: true })
})

describe('remoteTmuxWatcherArgs (real /bin/sh)', () => {
  it('the client flags and the exact target reach the remote tmux as their own argv elements', () => {
    const { status, stdout } = runUnder(recordDir, watcherLine('nt-abc'))
    expect(status).toBe(0)
    const argv = stdout.split('\0')
    expect(argv.pop()).toBe('')
    expect(argv).toEqual(['-L', RMT_TMUX_SOCKET, 'attach-session', '-E', '-f', 'ignore-size,read-only', '-t', '=nt-abc:'])
  })

  it('an OLD remote tmux (< 3.2) rejects the flags: the command fails, once, and no shell runs', () => {
    fs.readdirSync(markerDir).forEach((f) => fs.unlinkSync(path.join(markerDir, f)))
    const { status, stderr } = runUnder(oldDir, watcherLine('nt-abc'))
    expect(status).not.toBe(0)
    expect(stderr).toContain('usage: attach-session')
    const calls = markers().filter((m) => m.startsWith('old-tmux-'))
    expect(calls).toHaveLength(1)
    expect(markers()).not.toContain('shell')
  })

  it('a host with no tmux at all: the command fails and no shell runs', () => {
    fs.readdirSync(markerDir).forEach((f) => fs.unlinkSync(path.join(markerDir, f)))
    const { status } = runUnder(emptyDir, watcherLine('nt-abc'))
    expect(status).not.toBe(0)
    expect(markers()).toEqual([])
  })
})

describe('remoteWindowSizeArgs (real /bin/sh)', () => {
  it('the target and the format reach the remote tmux intact', () => {
    const { status, stdout } = runUnder(recordDir, sizeLine('nt-abc'))
    expect(status).toBe(0)
    const argv = stdout.split('\0')
    expect(argv.pop()).toBe('')
    expect(argv).toEqual(['-L', RMT_TMUX_SOCKET, 'display-message', '-p', '-t', '=nt-abc:', WINDOW_SIZE_FORMAT])
  })

  it.skipIf(!REAL_TMUX)('end to end through a real tmux: the window size of exactly this session', () => {
    // Skipped without a tmux binary: the proof is tmux's own reply.
    const hit = runUnder(delegateDir, sizeLine('nt-w-12'))
    expect(hit.status).toBe(0)
    // `-f /dev/null` = tmux defaults, status on: the client size for a 100x30 window is 100x31.
    expect(parseWindowSize(hit.stdout)).toEqual({ cols: 100, rows: 31 })
    // A prefix of a live session's name: exit 0 with every format empty — no size, never 12's.
    const miss = runUnder(delegateDir, sizeLine('nt-w-1'))
    expect(parseWindowSize(miss.stdout)).toBeUndefined()
  })
})

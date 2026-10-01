// A LIVE LINK'S KEYFRAME, CAPTURED FROM A REAL TMUX (R10 + R17, amended by R18: no alt-screen flag).
//
// What is measured here is a property of tmux, not of our code, so it cannot be unit-tested:
//  - the one invocation `capture-pane … ; display-message …` really does print the visible screen
//    and THEN the cursor line, and only the visible rows (never the history above them);
//  - the target spelling is EXACT. Node ids end in a counter, so `nt-x-1` is a prefix of `nt-x-12`,
//    and tmux falls back to prefix matching on a miss: a bare target would capture ANOTHER node's
//    screen and send it to this link's viewers. `=name:` is the spelling that is exact AND resolves
//    for a target-pane (measured on tmux 3.4: `=name` alone is "can't find pane").
//
// Private socket in a private TMUX_TMPDIR (`makeTmuxTmpdir`), never `node-terminal`/`nodeterm-rmt`;
// each session is killed by exact target.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import {
  localCaptureVisibleArgs,
  parseVisibleCapture,
  unavailableCapture,
  type VisibleCapture
} from './capture-route'
import { makeTmuxTmpdir } from '../tmux-test-socket'

const SOCKET = `nt-wlcap-${process.pid}`
const HAS_TMUX = (() => {
  if (process.platform === 'win32') return false
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
// Skipped where there is no tmux binary (Windows, a bare CI image): the measurement is of tmux.
const itTmux = it.skipIf(!HAS_TMUX)

let tmp = ''
const sessions: string[] = []

function tmux(args: string[]): string {
  return execFileSync('tmux', args, {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
}

/** Exactly what `PtyManager.captureVisible` does with the argv: parse on success, unavailable on
 *  any failure (tmux's non-zero exit included). */
function captureVisible(sessionName: string): VisibleCapture {
  try {
    return parseVisibleCapture(tmux(localCaptureVisibleArgs(SOCKET, sessionName)))
  } catch {
    return unavailableCapture()
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Start a session running `script`, and wait until its screen shows `ready`. */
function start(name: string, script: string, ready: string, cols = 30, rows = 4): void {
  // `-f /dev/null` on the call that boots the private server: a contributor's ~/.tmux.conf must not
  // join the measurement.
  tmux(['-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), script])
  sessions.push(name)
  for (let i = 0; i < 100; i++) {
    // Polled with the literal spelling, not `exactPaneTarget`: a broken target must fail the test
    // that is about it, not this setup.
    if (tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', `=${name}:`]).includes(ready)) return
    sleepMs(20)
  }
  throw new Error(`session ${name} never printed ${ready}`)
}

beforeAll(() => {
  if (!HAS_TMUX) return
  tmp = makeTmuxTmpdir('ntwl-', SOCKET)
  start('nt-x-12', "printf 'SCREEN-OF-12\\n'; sleep 60", 'SCREEN-OF-12')
  start('nt-hist', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo L$i; done; sleep 60', 'L10')
  start('nt-alt', "printf 'MAIN\\n'; printf '\\033[?1049h\\033[2;3HALT'; sleep 60", 'ALT')
})

afterAll(() => {
  if (!HAS_TMUX) return
  for (const name of sessions) {
    try {
      tmux(['-L', SOCKET, 'kill-session', '-t', `=${name}`])
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('visible capture against a real tmux', () => {
  itTmux('the trap is real on this tmux: a BARE target captures the longer-named session', () => {
    // The control for the next test. If tmux ever stops prefix-matching, this goes red and says so,
    // rather than the exact-target test passing for a reason that no longer holds.
    expect(tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', 'nt-x-1'])).toContain('SCREEN-OF-12')
  })

  itTmux('capturing nt-x-1 while only nt-x-12 is alive is UNAVAILABLE, never 12’s screen', () => {
    const got = captureVisible('nt-x-1')
    expect(got).toEqual(unavailableCapture())
    expect(got.screen).not.toContain('SCREEN-OF-12')
  })

  itTmux('the exact target captures its own session, with the cursor from the same invocation', () => {
    const got = captureVisible('nt-x-12')
    expect(got.screen).toContain('SCREEN-OF-12')
    expect(got.cursor).toEqual({ x: 0, y: 1 })
    // The cursor line is not left in the screen.
    expect(got.screen).not.toMatch(/(^|\n)\d+ \d+\n?$/)
  })

  itTmux('only the visible rows — the history above them is never in the keyframe', () => {
    const got = captureVisible('nt-hist')
    expect(got.screen).toContain('L10')
    expect(got.screen).not.toMatch(/^L1$/m)
    expect(got.screen).not.toContain('L6')
    expect(got.screen.split('\n').filter(Boolean)).toEqual(['L8', 'L9', 'L10'])
  })

  itTmux('a pane on the alternate screen: the grid on screen, with its cursor — and no flag (R18)', () => {
    const got = captureVisible('nt-alt')
    expect(got.screen).toContain('ALT')
    expect(got.screen).not.toContain('MAIN')
    expect(got.cursor).toEqual({ x: 5, y: 1 })
    // The keyframe's altScreen is the caller's, from the join — the capture reports none.
    expect(Object.keys(got).sort()).toEqual(['cursor', 'screen'])
  })
})

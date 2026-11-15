// COLD-RESTORE SEEDING, PROVEN AGAINST A REAL TMUX.
//
// The bug this pins: after a reboot the renderer replayed the persisted scrollback into xterm's
// NORMAL screen, and the fresh tmux client's attach (`\e[?1049h` + clear) hid it an instant later
// — with the wheel scrolling tmux's (empty) history, so it could not be scrolled back to either.
// Nobody ever saw "session restored". The decision tests stayed green throughout, because they
// only assert that a replay is CHOSEN, not that the text ends up anywhere a user can see.
//
// The fix writes the snapshot into the new PANE (scrollback-store.ts). Whether a `run-shell`
// chained onto `new-session` really lands in that pane's history, expands `#{pane_tty}`, survives
// a hostile path and leaves a live pane alone is a property of tmux — so it is measured here, with
// the EXACT conf `tmuxConf()` ships and the EXACT argv `scrollbackSeedTmuxArgs` builds.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxConf } from './pty-manager'
import {
  buildScrollbackSeed,
  scrollbackSeedTmuxArgs,
  SESSION_RESTORED_LINE
} from './scrollback-store'
import { makeTmuxTmpdir } from './tmux-test-socket'

// Only `tmuxConf()` (a string builder) is needed from pty-manager; nothing here spawns a pty. Stub
// the native module so this suite measures tmux even on a checkout whose node-pty is not built.
vi.mock('node-pty', () => ({}))

const SOCKET = `nt-seedtest-${process.pid}`

let tmp: string
let conf: string
let tmuxOk = false

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

beforeAll(() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntseed-', SOCKET)
  conf = path.join(tmp, 'tmux.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
})

afterAll(() => {
  if (!tmuxOk) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The whole pane — history included — as text. */
const pane = (session: string): string => tmux(['capture-pane', '-p', '-t', session, '-S', '-'])

const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const SEPARATOR_TEXT = 'session restored (process ended by a restart)'
// What `capture-pane -p -e` hands the snapshot store: LF-separated, SGR inside, blank rows below
// the cursor.
const SNAPSHOT = '$ ls\n\x1b[34mfile-a\x1b[0m  file-b\n$ \n\n\n\n'

/** Stage a seed file and create a session the way the local spawn branch does (minus the client:
 *  `-d`, since a test has no tty to attach). `cat` is the pane program so nothing else prints. */
function coldStart(session: string, seedFile: string): void {
  fs.writeFileSync(seedFile, buildScrollbackSeed(SNAPSHOT))
  tmux([
    '-f', conf, 'new-session', '-d', '-x', '80', '-y', '24', '-s', session, 'cat',
    ...scrollbackSeedTmuxArgs(seedFile, session)
  ])
}

describe('buildScrollbackSeed', () => {
  it('ends every line with CRLF, drops the trailing blank rows and appends the separator', () => {
    const seed = buildScrollbackSeed(SNAPSHOT)
    expect(seed).toBe(
      '\r\x1b[2K$ ls\r\n\x1b[34mfile-a\x1b[0m  file-b\r\n$\x1b[0m\r\n' + SESSION_RESTORED_LINE + '\r\n'
    )
    expect(seed.replace(/\r\n/g, '')).not.toContain('\n') // no bare LF left to staircase
  })

  it('is empty when there is nothing to restore — no lone separator over an empty pane', () => {
    expect(buildScrollbackSeed('')).toBe('')
    expect(buildScrollbackSeed('\n\n  \n')).toBe('')
  })
})

describe('cold-restore seed lands in the tmux pane (real tmux)', () => {
  it('the restored text and the separator are in the new pane, where tmux paints and scrolls them', async () => {
    if (!tmuxOk) return
    const seedFile = path.join(tmp, 'a.seed')
    coldStart('nt-cold', seedFile)
    await until(() => pane('nt-cold').includes(SEPARATOR_TEXT))
    const lines = pane('nt-cold').split('\n')
    expect(lines.slice(0, 4)).toEqual(['$ ls', 'file-a  file-b', '$', `── ${SEPARATOR_TEXT} ──`])
    // …and it is HISTORY, not just a painted screen: scroll it off and it is still there.
    tmux(['send-keys', '-t', 'nt-cold', ...Array.from({ length: 40 }, () => 'Enter')])
    await until(() => Number(tmux(['display-message', '-p', '-t', 'nt-cold', '#{history_size}'])) > 0)
    expect(pane('nt-cold')).toContain(SEPARATOR_TEXT)
    // The staged file is one-shot.
    await until(() => !fs.existsSync(seedFile))
  })

  it("a user-data path with a space, a quote and a '#' still seeds (shell quoting + format escaping)", async () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, "App Support's #1 dir")
    fs.mkdirSync(dir)
    const seedFile = path.join(dir, 'b.seed')
    coldStart('nt-path', seedFile)
    await until(() => pane('nt-path').includes(SEPARATOR_TEXT))
    await until(() => !fs.existsSync(seedFile))
  })

  it('a pane that already has history is left alone — `-A` may have attached to a LIVE session', async () => {
    if (!tmuxOk) return
    tmux(['-f', conf, 'new-session', '-d', '-x', '80', '-y', '24', '-s', 'nt-live', 'seq 1 200; cat'])
    await until(() => Number(tmux(['display-message', '-p', '-t', 'nt-live', '#{history_size}'])) > 0)
    const seedFile = path.join(tmp, 'c.seed')
    fs.writeFileSync(seedFile, buildScrollbackSeed(SNAPSHOT))
    // The chained command on its own (drop the leading `;`), aimed at the live session.
    tmux(scrollbackSeedTmuxArgs(seedFile, 'nt-live').slice(1))
    await until(() => !fs.existsSync(seedFile)) // consumed…
    expect(pane('nt-live')).not.toContain(SEPARATOR_TEXT) // …but never written
    // A refused seed must not flip the pane into view mode to report a failure.
    expect(tmux(['display-message', '-p', '-t', 'nt-live', '#{pane_in_mode}']).trim()).toBe('0')
  })
})

// A RELAY PHONE'S QUICK ANSWER INTO A NODE OF AN SSH PROJECT, PROVEN AGAINST A REAL TMUX.
//
// The subject is `remoteTmuxSendKeysArgs` — the line `PtyManager.backgroundWriteOver` runs over a
// project's ControlMaster when the phone answers a question (a digit) or a legacy approval (`1`, or
// a lone ESC for Deny) on a node whose tmux lives on another host (`node.sendKeys`, the follow-up to
// audit A12). It is generated shell that no compiler checks, so the line is run for real: its last
// argv element (the remote command) goes through a real /bin/sh, with a `tmux` shim on PATH that
// swaps the production socket for this file's private one, into a real tmux whose pane runs a
// program recording the raw bytes it receives.
//
// WHAT JUDGES. The bytes on the application's stdin — not tmux's exit status, which is exactly the
// thing that lies in two of the cases below (a key eaten by copy mode, a key typed into another
// session by prefix matching: both exit 0).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { remoteTmuxSendKeysArgs } from './remote-ssh/control-master'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { makeTmuxTmpdir } from './tmux-test-socket'
import { sendBackgroundTmuxKeys } from './pty-manager'

// The local delivery is exported from the manager so it can be judged on a real interpreter,
// without loading node-pty's Electron native binding or spawning an attached painter.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('quick answers must not spawn a PTY') } }))
vi.mock('./native-windows-pane', () => ({ NativeWindowsPane: class {} }))

/** A private socket — never `TMUX_SOCKET`/`nodeterm-rmt`, which carry live user sessions. */
const SOCKET = `nt-rsk-test-${process.pid}`
const CONN = { host: 'h.example.com', user: 'deploy', port: 2222 }

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}
const TMUX = findTmux()

let work: string
let binDir: string

function env(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: work }
}

function tmux(args: string[]): string {
  // stderr piped, not inherited: the `has-session` probes below fail by design.
  return execFileSync(TMUX as string, args, { encoding: 'utf8', env: env(), stdio: 'pipe' })
}

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('ntrsk-', SOCKET)
  binDir = path.join(work, 'bin')
  fs.mkdirSync(binDir)
  // The SSH path's shim: the remote line hard-codes `-L nodeterm-rmt` (on a real host, the socket a
  // remote nodeterm owns); the first two arguments are dropped and the real tmux is re-invoked on
  // this file's private socket.
  fs.writeFileSync(
    path.join(binDir, 'tmux'),
    `#!/bin/sh\nexport TMUX_TMPDIR=${work}\nshift 2\nexec ${TMUX} -L ${SOCKET} "$@"\n`,
    { mode: 0o755 }
  )
  // A pane program that records the RAW bytes its stdin receives (`stty raw`: no CR→NL rewrite, and
  // a lone ESC passes as one byte).
  fs.writeFileSync(
    path.join(binDir, 'recorder'),
    ['#!/bin/sh', 'stty raw -echo', 'touch "$1.ready"', 'exec cat > "$1"'].join('\n') + '\n',
    { mode: 0o755 }
  )
})

afterAll(() => {
  if (TMUX) {
    try {
      tmux(['-L', SOCKET, 'kill-server'])
    } catch {
      // already gone
    }
  }
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

function waitFor(predicate: () => boolean, what: string, ms = 10_000): void {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    execFileSync('sleep', ['0.03'])
  }
}

function sessionExists(session: string): boolean {
  try {
    tmux(['-L', SOCKET, 'has-session', '-t', `=${session}`])
    return true
  } catch {
    return false
  }
}

/** A fresh single-pane session running the byte recorder. Returns the file it writes to. */
function recorderPane(session: string): string {
  const out = path.join(work, `${session}.bytes`)
  if (sessionExists(session)) tmux(['-L', SOCKET, 'kill-session', '-t', `=${session}`])
  tmux(['-L', SOCKET, 'new-session', '-d', '-s', session, '-x', '120', '-y', '30', '-c', work,
    `${binDir}/recorder ${out}`])
  waitFor(() => fs.existsSync(`${out}.ready`), `${session} recorder to come up`)
  return out
}

/**
 * Everything sent before this call has reached the application. A sentinel delivered by a
 * DIFFERENT mechanism (a plain literal send-keys, exact target), so a subject that delivered nothing
 * still yields an answer — an empty one — instead of a hang.
 */
const MARK = '<<NTEND>>'
function drain(session: string, out: string, pane = `=${session}:`): string {
  tmux(['-L', SOCKET, 'send-keys', '-t', pane, '-l', '--', MARK])
  waitFor(() => fs.readFileSync(out, 'utf8').includes(MARK), `${session} to receive the marker`)
  const all = fs.readFileSync(out, 'utf8')
  return all.slice(0, all.lastIndexOf(MARK))
}

/** Run a remote line the way ssh would hand it to the host's shell. Throws on a non-zero exit. */
function runRemote(line: string): void {
  execFileSync('/bin/sh', ['-c', line], {
    env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: work },
    stdio: 'pipe'
  })
}

/** Exactly what `PtyManager.backgroundWriteOver` runs: the builder's line, true iff it exited 0. */
function sendOver(session: string, keys: string): boolean {
  const args = remoteTmuxSendKeysArgs(CONN, '/cm.sock', session, keys)
  try {
    runRemote(args[args.length - 1])
    return true
  } catch {
    return false
  }
}

const suite = TMUX && process.platform !== 'win32' ? describe : describe.skip

suite('REAL tmux: a quick answer typed over the master reaches the remote pane', () => {
  it('delivers a question digit as that one byte', () => {
    const out = recorderPane('nt-rsk-digit')
    expect(sendOver('nt-rsk-digit', '2')).toBe(true)
    expect(drain('nt-rsk-digit', out)).toBe('2')
  })

  it('delivers a lone ESC (Deny) and an Enter as the raw bytes a key press is', () => {
    const out = recorderPane('nt-rsk-keys')
    expect(sendOver('nt-rsk-keys', '\u001b')).toBe(true)
    expect(sendOver('nt-rsk-keys', '\r')).toBe(true)
    expect(sendOver('nt-rsk-keys', '1\r')).toBe(true)
    expect(drain('nt-rsk-keys', out)).toBe('\u001b\r1\r')
  })

  it('an answer full of shell and tmux syntax arrives as text — nothing is parsed out of it', () => {
    const out = recorderPane('nt-rsk-text')
    const hostile = `-R ';$(id)\\`
    expect(sendOver('nt-rsk-text', hostile)).toBe(true)
    expect(drain('nt-rsk-text', out)).toBe(hostile)
  })

  it.each(['emacs', 'vi'])(
    'a pane in copy mode (%s keys) is brought back first — the key reaches the app, not the copy-mode table',
    (keys) => {
      const session = `nt-rsk-copy-${keys}`
      const out = recorderPane(session)
      tmux(['-L', SOCKET, 'set-option', '-w', '-t', `=${session}:`, 'mode-keys', keys])
      tmux(['-L', SOCKET, 'copy-mode', '-t', `=${session}:`])
      const inMode = (): string =>
        tmux(['-L', SOCKET, 'display-message', '-p', '-t', `=${session}:`, '#{pane_in_mode}']).trim()
      expect(inMode()).toBe('1')
      expect(sendOver(session, '3')).toBe(true)
      expect(drain(session, out)).toBe('3')
      expect(inMode()).toBe('0')
    }
  )

  it('CONTROL: without the cancel, copy mode EATS the key — and with emacs keys tmux still exits 0', () => {
    // Why the cancel is in the line at all: a delivery reported that never happened. (With vi keys
    // the digit opens a repeat-count prompt instead, which fails with no client attached and opens
    // on the desktop's client when there is one; the app never sees the key either way.)
    const out = recorderPane('nt-rsk-eaten')
    tmux(['-L', SOCKET, 'set-option', '-w', '-t', '=nt-rsk-eaten:', 'mode-keys', 'emacs'])
    tmux(['-L', SOCKET, 'copy-mode', '-t', '=nt-rsk-eaten:'])
    tmux(['-L', SOCKET, 'send-keys', '-t', '=nt-rsk-eaten:', '-H', '33']) // exits 0: it would throw otherwise
    tmux(['-L', SOCKET, 'send-keys', '-t', '=nt-rsk-eaten:', '-X', 'cancel'])
    expect(drain('nt-rsk-eaten', out)).toBe('')
  })

  it('a session the host does not have is a failure — never created, never another node’s pane', () => {
    // `nt-rsk-miss` does not exist; `nt-rsk-missing` does, and its name EXTENDS the target's.
    const neighbour = recorderPane('nt-rsk-missing')
    expect(sendOver('nt-rsk-miss', '1')).toBe(false)
    expect(sessionExists('nt-rsk-miss')).toBe(false)
    expect(drain('nt-rsk-missing', neighbour)).toBe('')
  })

  it('CONTROL: a target that is not exact PREFIX-matches the neighbour and exits 0', () => {
    // Why the target is `'=<name>:'`: the answer would land in another node's agent, reported sent.
    const neighbour = recorderPane('nt-rsk-prefixed')
    tmux(['-L', SOCKET, 'send-keys', '-t', 'nt-rsk-prefix', '-H', '31'])
    expect(drain('nt-rsk-prefixed', neighbour)).toBe('1')
  })
})

/** The local manager's SAME delivery, using the private server rather than a desktop socket. */
async function sendLocal(session: string, keys: string): Promise<boolean> {
  return sendBackgroundTmuxKeys(session, keys, async (args) => {
    try {
      const stdout = tmux(['-L', SOCKET, ...args])
      return { ok: true, body: stdout.trimEnd().split('\n') }
    } catch {
      return { ok: false, body: [] }
    }
  })
}

suite('REAL tmux: a local quick answer reaches the app rather than copy mode or another node', () => {
  it('delivers digits, ESC and Enter byte for byte', async () => {
    const session = 'nt-local-answer'
    const out = recorderPane(session)
    expect(await sendLocal(session, '2\u001b\r')).toBe(true)
    expect(drain(session, out)).toBe('2\u001b\r')
  })

  it.each(['emacs', 'vi'])('leaves %s copy mode before typing an answer', async (keys) => {
    const session = `nt-local-copy-${keys}`
    const out = recorderPane(session)
    tmux(['-L', SOCKET, 'set-option', '-w', '-t', `=${session}:`, 'mode-keys', keys])
    tmux(['-L', SOCKET, 'copy-mode', '-t', `=${session}:`])
    expect(await sendLocal(session, '3')).toBe(true)
    expect(drain(session, out)).toBe('3')
    expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', `=${session}:`, '#{pane_in_mode}']).trim())
      .toBe('0')
  })

  it('refuses a missing session whose name is a prefix of a real neighbour', async () => {
    const out = recorderPane('nt-local-neighbour')
    expect(await sendLocal('nt-local-neigh', '1')).toBe(false)
    expect(drain('nt-local-neighbour', out)).toBe('')
  })

  it('keeps the original pane when desktop selection changes after its probe', async () => {
    const session = 'nt-local-switch'
    const out = recorderPane(session)
    const original = tmux(['-L', SOCKET, 'display-message', '-p', '-t', `=${session}:`, '#{pane_id}']).trim()
    const otherOut = path.join(work, `${session}.other.bytes`)
    const other = tmux([
      '-L', SOCKET, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', original,
      `${binDir}/recorder ${otherOut}`
    ]).trim()
    waitFor(() => fs.existsSync(`${otherOut}.ready`), 'the other pane recorder')
    tmux(['-L', SOCKET, 'copy-mode', '-t', original])

    expect(await sendBackgroundTmuxKeys(session, '2', async (args) => {
      const stdout = tmux(['-L', SOCKET, ...args])
      if (args[0] === 'display-message') tmux(['-L', SOCKET, 'select-pane', '-t', other])
      return { ok: true, body: stdout.trimEnd().split('\n') }
    })).toBe(true)
    expect(drain(session, out, original)).toBe('2')
    expect(drain(session, otherOut, other)).toBe('')
  })
})


suite('REAL tmux: offscreen wake keeps the previously verified pane identity', () => {
  function identity(session: string): PaneOwner {
    const [paneId, pid, command] = tmux(['-L', SOCKET, 'display-message', '-p', '-t', `=${session}:`, '#{pane_id} #{pane_pid} #{pane_current_command}']).trim().split(' ')
    return { paneId, panePid: Number(pid), command, tty: '/dev/pts/1', argv: [] }
  }
  async function local(session: string, expected: PaneOwner): Promise<boolean> {
    return sendBackgroundTmuxKeys(session, 'wake', async (args) => {
      try { return { ok: true, body: tmux(['-L', SOCKET, ...args]).trimEnd().split('\n') } }
      catch { return { ok: false, body: [] } }
    }, undefined, expected)
  }
  it('remote delivery succeeds for the same tuple and refuses changed pid, command or pane', () => {
    const session = 'nt-wake-remote'; const out = recorderPane(session)
    const owner = identity(session)
    const run = (expected: PaneOwner): boolean => {
      try { runRemote(remoteTmuxSendKeysArgs(CONN, '/cm.sock', session, 'wake', expected).at(-1)!); return true }
      catch { return false }
    }
    expect(run(owner)).toBe(true)
    for (const changed of [{ ...owner, panePid: owner.panePid + 1 }, { ...owner, command: 'stale' }, { ...owner, paneId: '%999999' }]) expect(run(changed)).toBe(false)
    expect(drain(session, out)).toBe('wake')
  })
  it('local delivery refuses the wrong final pid or command and sends nothing into that pane', async () => {
    const session = 'nt-wake-local'; const out = recorderPane(session)
    const owner = identity(session)
    expect(await local(session, { ...owner, panePid: owner.panePid + 1 })).toBe(false)
    expect(await local(session, { ...owner, command: 'stale' })).toBe(false)
    expect(await local(session, { ...owner, paneId: '%999999' })).toBe(false)
    expect(await local(session, owner)).toBe(true)
    expect(drain(session, out)).toBe('wake')
  })
})

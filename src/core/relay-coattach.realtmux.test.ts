// A13 against real tmux. Ordinary attach-only control clients represent the external SSH phone
// at the actual tmux-client boundary; app painters use the production attach flags and tracker.
// No native node-pty/SSH/device proof is claimed here. The legacy -D control proves the harness
// observes detachment, while current claims run the actual server-side identity format gate.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxAttachFlags, tmuxConf } from './pty-manager'
import { trackTmuxPainter, painterDetachArgs } from './tmux-painter'
import { makeTmuxTmpdir } from './tmux-test-socket'

// Only two PURE exports of pty-manager are used here; the module still imports node-pty at load,
// and a checkout whose native build was skipped (`npm ci --ignore-scripts`) has no binary for it.
// Nothing below spawns through it — the clients are plain `child_process` children.
vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('node-pty is not used by this suite')
  }
}))

/** A private socket, never the app's — this must not touch a running nodeterm's tmux server. */
const SOCKET = `nt-relayco-${process.pid}`

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const TMUX = process.platform === 'win32' ? null : findTmux()
let work: string
let conf: string
const children: ChildProcess[] = []
const trackers: Array<ReturnType<typeof trackTmuxPainter>> = []

/** The sandbox dir LAST: a caller never chooses which server it reaches. */
function tmuxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: work }
  delete env.TMUX
  delete env.TMUX_PANE
  return env
}

function tmux(args: string[]): string {
  return execFileSync(TMUX as string, ['-L', SOCKET, ...args], {
    encoding: 'utf8',
    env: tmuxEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** A tmux client attaching the way `spawnSession` attaches a node: `new-session <flags> -s <name>`. */
function attach(session: string, flags: string[]): ChildProcess {
  const child = spawn(
    TMUX as string,
    ['-L', SOCKET, '-f', conf, '-C', 'new-session', ...flags, '-s', session, 'sleep', '300'],
    // stdin stays OPEN: a control client exits on EOF, which would read as a detach.
    { env: tmuxEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
  )
  child.stdout?.resume()
  child.stderr?.resume()
  children.push(child)
  return child
}

/** The pids of the clients attached to `session` — the tmux client processes themselves. */
function clientPids(session: string): number[] {
  try {
    return tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_pid}'])
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

function phoneAttach(session: string): ChildProcess {
  const child = spawn(TMUX as string, ['-L', SOCKET, '-C', 'attach-session', '-t', `=${session}`],
    { env: tmuxEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout?.resume(); child.stderr?.resume(); children.push(child)
  return child
}

function own(child: ChildProcess, session: string, userData = work) {
  const handle = trackTmuxPainter({ userData, tmux: TMUX as string, socket: SOCKET, session,
    pid: child.pid as number, current: () => child.exitCode === null && child.signalCode === null,
    run: async (args) => tmux(args.slice(2)) })
  trackers.push(handle)
  return handle
}

function identity(session: string, child: ChildProcess) {
  const lines = tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_pid}|#{client_created}|#{client_name}|#{pid}']).trim().split('\n')
  const line = lines.find((row) => row.startsWith(`${child.pid}|`))
  if (!line) throw new Error('Owned test client is missing')
  const [pid, created, name, server] = line.split('|')
  return { pid: Number(pid), created, name, server: Number(server), session }
}

function setGrid(session: string, child: ChildProcess, width: number, height: number): void {
  const c = identity(session, child)
  tmux(['refresh-client', '-t', c.name, '-C', `${width}x${height}`])
}

function widths(session: string): string[] {
  return tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_pid}:#{client_width}']).trim().split('\n').sort()
}

function paneGrid(session: string): string {
  // tmux 3.7c leaves client_height empty for control clients, even in its default listing.
  // Actual pane geometry still measures both axes; do not reduce the unequal-grid proof to widths.
  return tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_width}x#{pane_height}']).trim()
}

async function waitUntil(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Resolve with the exit code, or `'still-attached'` if the client is alive after `ms`. */
function exitWithin(child: ChildProcess, ms: number): Promise<number | null | 'still-attached'> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still-attached'), ms)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('ntrelayco-', SOCKET)
  conf = path.join(work, 'tmux.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
})

afterAll(() => {
  if (!TMUX) return
  for (const tracker of trackers) tracker.close()
  for (const c of children) if (c.exitCode === null) c.kill()
  try {
    tmux(['kill-server']) // our PRIVATE socket — nothing else can be on it
  } catch {
    /* already gone */
  }
  fs.rmSync(work, { recursive: true, force: true })
})

describe('a relay-served client beside the app client on a real tmux (audit A13)', () => {
  it.skipIf(!TMUX)('control: the app attaching with -A -D detaches the phone, which exits 0', async () => {
    const session = 'nt-a13-kick'
    const phone = attach(session, tmuxAttachFlags(true)) // the relay-served pty (attachDetached)
    await waitUntil(() => clientPids(session).includes(phone.pid as number))

    // The pre-A13 app client: no relay client known, or not asked.
    const app = attach(session, ['-A', '-D'])
    await waitUntil(() => clientPids(session).includes(app.pid as number))

    expect(await exitWithin(phone, 3000)).toBe(0)
    expect(clientPids(session)).toEqual([app.pid])
  })

  it.skipIf(!TMUX)('the fix: the app attaching beside a live relay client leaves the phone attached', async () => {
    const session = 'nt-a13-beside'
    const phone = attach(session, tmuxAttachFlags(true))
    await waitUntil(() => clientPids(session).includes(phone.pid as number))

    // What `spawnSession` now builds while a relay-served client of the node is attached.
    const app = attach(session, tmuxAttachFlags(false, true))
    await waitUntil(() => clientPids(session).includes(app.pid as number))

    // A `-D` detach happens while tmux processes the attach, before the new client is listed, so
    // the control above exits well inside this window.
    expect(await exitWithin(phone, 750)).toBe('still-attached')
    expect(clientPids(session).sort()).toEqual([phone.pid, app.pid].sort())
  })

  it.skipIf(!TMUX)('direct SSH first: remount retires only an owned app painter and keeps unequal phone grids', async () => {
    const session = 'nt-a13-ssh-first'
    tmux(['new-session', '-d', '-s', session, 'sleep', '300'])
    const phone = phoneAttach(session)
    await waitUntil(() => clientPids(session).includes(phone.pid as number))
    setGrid(session, phone, 56, 48)
    await waitUntil(() => paneGrid(session) === '56x48')
    const first = attach(session, tmuxAttachFlags(false))
    await own(first, session).settled
    setGrid(session, first, 120, 30)
    await waitUntil(() => paneGrid(session) === '120x30')
    expect(widths(session)).toEqual([`${phone.pid}:56`, `${first.pid}:120`].sort())

    const next = attach(session, tmuxAttachFlags(false))
    const replacement = own(next, session)
    await replacement.settled
    await waitUntil(() => first.exitCode !== null)
    setGrid(session, next, 100, 40)
    await waitUntil(() => paneGrid(session) === '100x40')
    expect(first.exitCode).toBe(0)
    expect(await exitWithin(phone, 150)).toBe('still-attached')
    expect(clientPids(session).sort()).toEqual([phone.pid, next.pid].sort())
    expect(widths(session)).toEqual([`${phone.pid}:56`, `${next.pid}:100`].sort())
    replacement.close(); next.kill()
    await waitUntil(() => clientPids(session).length === 1 && paneGrid(session) === '56x48')
    expect(clientPids(session)).toEqual([phone.pid])
    expect(await exitWithin(phone, 150)).toBe('still-attached')
  })

  it.skipIf(!TMUX)('app first: a direct SSH phone stays through later app takeover and release', async () => {
    const session = 'nt-a13-app-first'
    const first = attach(session, tmuxAttachFlags(false))
    const initial = own(first, session)
    await initial.settled
    const phone = phoneAttach(session)
    await waitUntil(() => clientPids(session).includes(phone.pid as number))
    const next = attach(session, tmuxAttachFlags(false))
    const replacement = own(next, session)
    await replacement.settled
    await waitUntil(() => first.exitCode !== null)
    expect(clientPids(session).sort()).toEqual([phone.pid, next.pid].sort())
    replacement.close(); next.kill()
    await waitUntil(() => next.exitCode !== null || next.signalCode !== null)
    expect(clientPids(session)).toEqual([phone.pid])
    expect(await exitWithin(phone, 150)).toBe('still-attached')
  })

  it.skipIf(!TMUX)('does not claim another profile or an unmarked legacy app client', async () => {
    const session = 'nt-a13-other-profile'
    const old = attach(session, tmuxAttachFlags(false))
    const otherProfile = fs.mkdtempSync(path.join(work, 'other-profile-'))
    await own(old, session, otherProfile).settled
    const unmarked = attach(session, tmuxAttachFlags(false))
    await waitUntil(() => clientPids(session).includes(unmarked.pid as number))
    const next = attach(session, tmuxAttachFlags(false))
    await own(next, session).settled
    expect(clientPids(session).sort()).toEqual([old.pid, unmarked.pid, next.pid].sort())
    expect(await exitWithin(old, 150)).toBe('still-attached')
    expect(await exitWithin(unmarked, 150)).toBe('still-attached')
  })

  it.skipIf(!TMUX)('the server-side gate preserves the old client when the incoming painter disappears', async () => {
    const session = 'nt-a13-new-gone'
    const old = attach(session, ['-A'])
    const incoming = attach(session, ['-A'])
    await waitUntil(() => clientPids(session).length === 2)
    const args = painterDetachArgs(SOCKET, identity(session, old), identity(session, incoming))
    incoming.kill()
    await waitUntil(() => !clientPids(session).includes(incoming.pid as number))
    tmux(args.slice(2))
    expect(await exitWithin(old, 150)).toBe('still-attached')
    expect(clientPids(session)).toEqual([old.pid])
  })

  it.skipIf(!TMUX)('the server-side gate refuses an old client that switched to another session', async () => {
    const session = 'nt-a13-old-switched'
    const old = attach(session, ['-A'])
    const incoming = attach(session, ['-A'])
    await waitUntil(() => clientPids(session).length === 2)
    const oldIdentity = identity(session, old)
    const args = painterDetachArgs(SOCKET, oldIdentity, identity(session, incoming))
    const other = 'nt-a13-different'
    tmux(['new-session', '-d', '-s', other, 'sleep', '300'])
    tmux(['switch-client', '-c', oldIdentity.name, '-t', `=${other}`])
    tmux(args.slice(2))
    expect(await exitWithin(old, 150)).toBe('still-attached')
    expect(clientPids(other)).toEqual([old.pid])
    expect(clientPids(session)).toEqual([incoming.pid])
  })
})

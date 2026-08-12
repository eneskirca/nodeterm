import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'
import { REAP_IDLE_MS, REAP_SWEEP_MS } from './pty-reap'

/**
 * IDLE REAP (2026-08-11: the machine hit `kern.tty.ptmx_max` with 62 live PTYs in this manager).
 *
 * The sweep exists to return pty devices held by sessions NOBODY is attached to any more — the
 * residue of a release hook that was never wired or never ran (a destroyed window, a vanished relay
 * peer). What it must never do is take a device back at the cost of somebody's work, so each
 * refusal below is as much the subject as the reap itself.
 */

/** One fake pty per spawn. `killed` is what a released client pty looks like from here. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  killed: boolean
  paused: boolean
}
const spawned: FakePty[] = []
const spawnArgs: Array<{ file: string; args: string[] }> = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    const p: FakePty = { killed: false, paused: false }
    spawned.push(p)
    spawnArgs.push({ file, args })
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: () => {},
      resize: () => {},
      pause: () => {
        p.paused = true
      },
      resume: () => {
        p.paused = false
      },
      kill: () => {
        p.killed = true
      },
      pid: 1
    }
  }
}))

/** Every tmux side-call goes through child_process, so this both answers `has-session` and lets a
 *  test PROVE the reap never issues `kill-session` (the tmux session is the work). */
const execCalls: Array<{ file: string; args: string[] }> = []
const liveTmuxSessions = new Set<string>()

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    execCalls.push({ file, args })
    const ok = (stdout: string): void => cb?.(null, { stdout, stderr: '' })
    if (args.includes('has-session')) {
      const target = args[args.indexOf('-t') + 1]
      if (liveTmuxSessions.has(target)) ok('')
      else cb?.(Object.assign(new Error('no such session'), { code: 1 }))
    } else if (args[0] === '-ilc') {
      ok('__NT_PATH_START__/usr/bin:/bin__NT_PATH_END__')
    } else {
      ok('')
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

const ALICE = 1

/**
 * A machine with pty devices to spare, always.
 *
 * Without this the real probe runs a `readdir('/dev')` against the DEVELOPER's host, and
 * `spawnSession`'s pre-flight refuses every create once that host is within `PTY_DEVICE_HEADROOM`
 * of its own `kern.tty.ptmx_max` — which a machine running this app all day genuinely reaches (511
 * on macOS; this one sits in the 480s). Nothing below is about device pressure, so it is pinned
 * healthy rather than left to depend on who is running the suite and how many terminals they have
 * open. The pressure behaviour itself is tested in pty-spawn-preflight.test.ts.
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe('idle reap of unwatched client PTYs', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(() => {
    spawned.length = 0
    spawnArgs.length = 0
    execCalls.length = 0
    liveTmuxSessions.clear()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-reap-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetPlatformForTests()
    // Best effort, exactly as in pty-single-user.test.ts: a fired-and-forgotten scrollback snapshot
    // can still be landing here, and a cleanup that fails the suite is worse than a leftover dir.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })

  /** A manager WITH init(): tmux-backed, which is what a real user always gets. */
  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    return m
  }
  /** A manager WITHOUT init(): no tmux, so a session's work lives ONLY in its pty client. */
  async function plainManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols: 80, rows: 24, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  /** Run the sweep past the idle threshold (it only decides on its own ticks). */
  const idle = (ms = REAP_IDLE_MS + REAP_SWEEP_MS) => vi.advanceTimersByTime(ms)

  it('releases the client pty of a tmux-backed session nobody is attached to any more', async () => {
    await tmuxManager()
    await create(ALICE) // …and Alice's window is then destroyed without a pty:kill ever arriving

    idle()

    expect(spawned[0].killed).toBe(true)
    // The tmux session is the WORK. Detaching its client is the whole point; killing it is the one
    // thing this sweep may never do.
    expect(execCalls.some((c) => c.args.includes('kill-session'))).toBe(false)
  })

  it('never reaps a session whose subscriber is still attached', async () => {
    fake.clients.push(ALICE) // her window is alive, terminal open (or parked, still subscribed)
    await tmuxManager()
    await create(ALICE)

    idle(REAP_IDLE_MS * 10)

    expect(spawned[0].killed).toBe(false)
  })

  it('never reaps before the threshold — it must not race the renderer 5-minute park', async () => {
    await tmuxManager()
    await create(ALICE)

    idle(6 * 60 * 1000) // one minute past TERM_PARK_MS

    expect(spawned[0].killed).toBe(false)
  })

  it('never reaps a session with no tmux underneath (an ssh-direct terminal dies with its client)', async () => {
    await plainManager()
    await create(ALICE)

    idle(REAP_IDLE_MS * 10)

    expect(spawned[0].killed).toBe(false)
  })

  it('never reaps a relay-served (detached) pty — its sink IS the watcher', async () => {
    const m = await tmuxManager()
    m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })

    idle(REAP_IDLE_MS * 10)

    expect(spawned[0].killed).toBe(false)
  })

  it('reattaches transparently after a reap: the node reopens onto its live tmux session', async () => {
    await tmuxManager()
    const first = await create(ALICE)
    liveTmuxSessions.add(sessionName('node-1')) // tmux kept it running, as it does across a detach

    idle()
    expect(spawned[0].killed).toBe(true)

    const again = await create(ALICE)
    expect(again.sessionId).not.toBe(first.sessionId)
    expect(spawned).toHaveLength(2)
    // A WARM reattach: `fresh:false` is what suppresses the cold-restore scrollback replay, i.e.
    // the user gets the session that kept running, not a new shell.
    expect(again.fresh).toBe(false)
    expect(spawnArgs[1].args).toContain('new-session')
    expect(spawnArgs[1].args.slice(-2)).toEqual(['-s', sessionName('node-1')])
  })

  it('sweeps the same way off darwin — the pty ceiling is macOS, running out of them is not', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    await tmuxManager()
    await create(ALICE)

    idle()

    expect(spawned[0].killed).toBe(true)
  })
})

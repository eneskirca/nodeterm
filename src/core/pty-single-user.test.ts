import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { TMUX_SOCKET, sessionName } from './tmux-naming'

/**
 * SINGLE-USER REGRESSION.
 *
 * The co-attach machinery (subscriber set, smallest-subscriber-wins size negotiation, per-client
 * flow-control ledger, in-flight create guard) exists for a SECOND person. For the person working
 * ALONE — which is everybody, most of the time — it must be INVISIBLE: one spawn with the same
 * tmux args / env / cwd, the same `fresh` flag (it drives scrollback replay + agent resume), the
 * same coalesced output, the same resize ioctl, the same pause/resume, and a `kill` that detaches
 * the tmux client WITHOUT killing the tmux session (that is the whole continuity story).
 *
 * min(one element) == your own size. Everything below pins that.
 */

/** One fake pty per spawn, recording exactly what the manager did to it. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  resizes: Array<{ cols: number; rows: number }>
  paused: boolean
  killed: boolean
}
const spawned: FakePty[] = []
const spawnArgs: Array<{
  file: string
  args: string[]
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}> = []

vi.mock('node-pty', () => ({
  spawn: (
    file: string,
    args: string[],
    opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }
  ) => {
    const p: FakePty = { resizes: [], paused: false, killed: false }
    spawned.push(p)
    spawnArgs.push({ file, args, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env })
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: () => {},
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
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

/**
 * Every tmux side-call the manager makes (has-session / capture-pane / kill-session) goes through
 * child_process, so mocking it lets us (a) decide whether a tmux session already exists — which is
 * exactly what the `fresh` flag is computed from — and (b) SEE which tmux commands ran, so we can
 * prove `kill` never issues `kill-session` while `destroy` does.
 */
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
      // Real execFile carries tmux's exit status on err.code — 1 is what probeSaysAbsent
      // reads as genuine absence (vs a spawn failure, which has a string/no code).
      else cb?.(Object.assign(new Error('no such session'), { code: 1 }))
    } else if (args[0] === '-ilc') {
      // The login-shell PATH probe (`resolveShellPath`).
      ok('__NT_PATH_START__/usr/bin:/bin__NT_PATH_END__')
    } else if (args.includes('capture-pane')) {
      ok('PANE SNAPSHOT')
    } else {
      ok('')
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

const SOLO = 42

describe('SINGLE-USER REGRESSION: co-attach must not change the solo path', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(() => {
    spawned.length = 0
    spawnArgs.length = 0
    execCalls.length = 0
    liveTmuxSessions.clear()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-solo-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
    // BEST EFFORT, and it must stay that way. This races a write it cannot wait for: the scrollback
    // snapshot is fired and forgotten by design (`snapshotScrollback` is best-effort and nothing
    // awaits it), so a test that triggered one can reach here while the file is still landing and
    // the rmdir fails with ENOTEMPTY. Measured at roughly one full-suite run in six.
    //
    // `maxRetries` alone was not enough — it only narrows the window, and the write can land after
    // the last retry. The catch is what actually fixes it, and it is safe precisely because this
    // line is HOUSEKEEPING: the directory is per-test (`mkdtemp`) and lives in the OS temp dir, so
    // failing to remove it cannot indicate a defect in anything under test. A cleanup that can fail
    // the suite is worse than a leftover directory.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })

  /** A manager WITHOUT init(): no tmux (plain-shell fallback), as the co-attach suite runs it. */
  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }

  /** A manager WITH init(): tmux-backed, which is what a real user always gets. */
  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    return m
  }

  const create = (cols: number, rows: number, persistKey = 'solo-1', extra = {}) =>
    fake.handlers[IPC.ptyCreate](SOLO, { cols, rows, persistKey, ...extra }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  const resize = (sessionId: string, cols: number | null, rows: number | null) =>
    fake.senderListeners[IPC.ptyResize](SOLO, sessionId, cols, rows)
  const flow = (sessionId: string, resume: boolean) =>
    fake.senderListeners[IPC.ptyFlow](SOLO, sessionId, resume)
  const kill = (sessionId: string) => fake.senderListeners[IPC.ptyKill](SOLO, sessionId)
  const tmuxCalls = (verb: string) => execCalls.filter((c) => c.args.includes(verb))

  // ── One create → exactly one spawn, at the caller's own size ──────────────────────────────
  it('one create → one spawn, fresh:true, spawned at the caller s own size', async () => {
    await manager()
    const r = await create(100, 30)
    expect(spawned).toHaveLength(1)
    expect(spawnArgs[0].cols).toBe(100)
    expect(spawnArgs[0].rows).toBe(30)
    expect(r.fresh).toBe(true)
  })

  // ── The spawn itself: same tmux args, same cwd, same env ──────────────────────────────────
  it('spawns ONE tmux client with the unchanged attach flags, cwd and session name', async () => {
    const m = await tmuxManager()
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cwd-'))
    await create(80, 24, 'solo-1', { cwd })

    expect(spawned).toHaveLength(1)
    const { file, args, env } = spawnArgs[0]
    expect(file).toBe(m.getTmuxBin())
    // The dedicated socket + generated conf, then attach-or-create with -D: the app has exactly
    // ONE tmux client per session, so tmux's own multi-client size negotiation never engages.
    expect(args.slice(0, 7)).toEqual([
      '-L',
      TMUX_SOCKET,
      '-f',
      path.join(userDataDir, 'tmux.conf'),
      'new-session',
      '-A',
      '-D'
    ])
    expect(args.filter((a) => a === 'new-session')).toHaveLength(1)
    expect(args[args.indexOf('-c') + 1]).toBe(cwd)
    expect(args.slice(-2)).toEqual(['-s', sessionName('solo-1')])
    // The spawned process env is the pre-co-attach env: forced TERM, no inherited TMUX nesting,
    // and the real login-shell PATH.
    expect(spawnArgs[0].cwd).toBe(cwd)
    expect(env.TERM).toBe('xterm-256color')
    expect(env.TMUX).toBeUndefined()
    expect(env.TMUX_PANE).toBeUndefined()
    // The login-shell PATH probe (stubbed above to answer `/usr/bin:/bin`) is a POSIX notion:
    // `resolveShellPath` short-circuits to null on Windows, where there is no profile to source
    // and a GUI process already inherits the user's full PATH. So the contract differs by
    // platform and the assertion has to as well — asserting the POSIX string on Windows was
    // testing the stub, not the manager.
    expect(env.PATH).toBe(os.platform() === 'win32' ? process.env.PATH : '/usr/bin:/bin')
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  // ── `fresh` drives scrollback replay + agent resume: it must still be computed from tmux ──
  it('fresh:false on a WARM reattach (tmux session already exists) — no cold restore', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName('solo-1')) // the app restarted; tmux kept the session
    const r = await create(80, 24)
    expect(r.fresh).toBe(false)
    expect(tmuxCalls('has-session')).toHaveLength(1)
  })

  it('fresh:true after a reboot killed the tmux server (cold restore + agent resume)', async () => {
    await tmuxManager()
    const r = await create(80, 24) // no live tmux session → cold start
    expect(r.fresh).toBe(true)
  })

  // ── Output: one subscriber, one coalesced message, never a broadcast ──────────────────────
  it('output goes to exactly one client, never broadcast', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    spawned[0].onDataCb?.('out')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data).toHaveLength(1)
    expect(data[0].to).toBe(SOLO)
    expect(data[0].args[0]).toBe('out')
    expect(fake.sent.some((s) => s.to === 'broadcast')).toBe(false)
  })

  it('many chunks in one flush window still collapse into ONE IPC message (unchanged coalescing)', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    spawned[0].onDataCb?.('a')
    spawned[0].onDataCb?.('b')
    spawned[0].onDataCb?.('c')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data).toHaveLength(1)
    expect(data[0].args[0]).toBe('abc')
  })

  it('exit reaches the one subscriber (and only it)', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    spawned[0].onExitCb?.({ exitCode: 3 })
    const exits = fake.sent.filter((s) => s.channel === IPC.ptyExit(sessionId))
    expect(exits).toHaveLength(1)
    expect(exits[0].to).toBe(SOLO)
    expect(exits[0].args[0]).toBe(3)
  })

  // ── Size: min(one) is your own size, and you are never told what you already render ───────
  it('a resize applies the caller s OWN size verbatim (min of one) — no clamping', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    resize(sessionId, 132, 50)
    expect(spawned[0].resizes).toEqual([{ cols: 132, rows: 50 }])
    // …and the same-size fit that the ResizeObserver fires right after mount is a no-op:
    // no second pty.resize, so tmux does not redraw the pane twice on a bulk project load.
    // This is the ONE intended delta from the pre-co-attach behavior (which re-ioctl'd), and it
    // is pinned here so it stays a decision rather than an accident.
    resize(sessionId, 132, 50)
    expect(spawned[0].resizes).toHaveLength(1)
  })

  it('a SOLO user receives ZERO pty:size broadcasts — he already renders his own fit', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    fake.sent.length = 0
    resize(sessionId, 100, 30)
    resize(sessionId, 61, 17)
    expect(spawned[0].resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 61, rows: 17 }
    ])
    expect(fake.sent.filter((s) => s.channel === IPC.ptySize(sessionId))).toEqual([])
  })

  // ── Flow control: his pause, his resume, nobody else's ────────────────────────────────────
  it('the solo client s pause pauses the pty and his resume resumes it', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    flow(sessionId, false)
    expect(spawned[0].paused).toBe(true)
    flow(sessionId, true)
    expect(spawned[0].paused).toBe(false)
  })

  it('nothing else can cancel the solo client s pause (a second node s traffic does not touch it)', async () => {
    await manager()
    const { sessionId } = await create(80, 24, 'solo-1')
    const other = await create(80, 24, 'solo-2')
    flow(sessionId, false)
    expect(spawned[0].paused).toBe(true)

    // Activity on an unrelated session (resize, flow, kill) must not resume the paused one.
    resize(other.sessionId, 100, 30)
    flow(other.sessionId, false)
    flow(other.sessionId, true)
    kill(other.sessionId)
    expect(spawned[0].paused).toBe(true)

    flow(sessionId, true)
    expect(spawned[0].paused).toBe(false)
  })

  // ── kill = detach (continuity!), destroy = end the tmux session ───────────────────────────
  it('kill by the only subscriber releases the pty and frees the persistKey for a respawn', async () => {
    await manager()
    const { sessionId } = await create(80, 24)
    kill(sessionId)
    expect(spawned[0].killed).toBe(true)
    const again = await create(80, 24)
    expect(spawned).toHaveLength(2) // no stale index entry handed back
    expect(again.sessionId).not.toBe(sessionId)
  })

  it('kill detaches the tmux CLIENT and never kills the tmux session (this is the continuity)', async () => {
    await tmuxManager()
    const { sessionId } = await create(80, 24)
    kill(sessionId)
    expect(spawned[0].killed).toBe(true) // the pty (tmux client) is released
    expect(tmuxCalls('kill-session')).toEqual([]) // the session keeps running
  })

  it('the detach path still snapshots the scrollback (cold restore after a reboot)', async () => {
    await tmuxManager()
    const { sessionId } = await create(80, 24)
    spawned[0].onDataCb?.('some output') // marks the session dirty
    vi.advanceTimersByTime(20)
    execCalls.length = 0
    kill(sessionId)
    const captures = tmuxCalls('capture-pane')
    expect(captures).toHaveLength(1)
    expect(captures[0].args[captures[0].args.indexOf('-t') + 1]).toBe(sessionName('solo-1'))
  })

  it('killAll (app quit) detaches the client but never kills the tmux session', async () => {
    const m = await tmuxManager()
    await create(80, 24)
    spawned[0].onDataCb?.('output')
    vi.advanceTimersByTime(20)
    await m.killAll()
    expect(spawned[0].killed).toBe(true)
    expect(tmuxCalls('kill-session')).toEqual([])
  })

  it('destroy (the × button) DOES kill the tmux session', async () => {
    const m = await tmuxManager()
    await create(80, 24)
    await m.destroySession(SOLO, 'solo-1')
    const kills = tmuxCalls('kill-session')
    expect(kills).toHaveLength(1)
    expect(kills[0].args[kills[0].args.indexOf('-t') + 1]).toBe(sessionName('solo-1'))
  })

  // ── recycle (move into worktree) = destroy, minus the "someone closed it" fan-out ─────────
  // The solo user's node keeps its id and respawns in the new cwd: the tmux session must die
  // exactly as the × kills it (otherwise `new-session -A` reattaches the OLD working directory),
  // and — with nobody else watching — not a single extra message may go out.
  it('recycle (move into worktree) kills the tmux session exactly like the × does', async () => {
    await tmuxManager()
    const { sessionId } = await create(80, 24)
    fake.sent.length = 0
    await (fake.senderListeners[IPC.ptyRecycle](SOLO, 'solo-1') as unknown as Promise<void>)

    const kills = tmuxCalls('kill-session')
    expect(kills).toHaveLength(1)
    expect(kills[0].args[kills[0].args.indexOf('-t') + 1]).toBe(sessionName('solo-1'))
    expect(spawned[0].killed).toBe(true) // the old pty client is released
    expect(fake.sent).toEqual([]) // solo: nobody to tell, so nothing is sent

    // …and the respawn under the same node id gets a BRAND-NEW session (it never joins the dead one).
    const again = await create(80, 24)
    expect(spawned).toHaveLength(2)
    expect(again.sessionId).not.toBe(sessionId)
    expect(again.fresh).toBe(true)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * A live link's viewer joins a node's RUNNING session: `joinAsWatcher` must never spawn one and never
 * vote on its size, whatever the caller hands it, and `watchSizeFor` names the size the link reports.
 * Harness copied from pty-join-only.test.ts (a mocked `node-pty` that records each spawn and each
 * resize, so "spawned nothing" is `spawned.length === 0` and "kept its size" is "no resize pushed").
 */

interface FakePty {
  file: string
  args: string[]
  cols: number
  rows: number
  writes: string[]
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
}
const spawned: FakePty[] = []

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { cols: number; rows: number }) => {
    const p: FakePty = {
      file,
      args: [...(args ?? [])],
      cols: opts.cols,
      rows: opts.rows,
      writes: [],
      resizes: [],
      killed: false
    }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: (d: string) => p.writes.push(d),
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {},
      resume: () => {},
      kill: () => {
        p.killed = true
      },
      pid: 1234
    }
  }
}))

vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

// `ssh` is found or not per test (`findSsh` memoizes per module, hence `vi.resetModules` below).
const ssh = vi.hoisted(() => ({ path: '/usr/bin/ssh' as string | null }))
vi.mock('./exec-path', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-path')>()
  return {
    ...real,
    findExecutableSync: (bin: string, fallbacks?: string[]) =>
      bin === 'ssh' ? ssh.path : real.findExecutableSync(bin, fallbacks)
  }
})
vi.mock('./remote-ssh/agent-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./remote-ssh/agent-probe')>()),
  probeAgentSockToPin: async () => undefined
}))

const OWNER = 1
const WATCHER = 7
const VIEWER = 2
const REFUSED: PtyCreateResult = { sessionId: '', fresh: false, unavailable: 'join-only' }

let fake: FakePlatform

let platformModule: typeof import('./platform')

beforeEach(async () => {
  spawned.length = 0
  ssh.path = '/usr/bin/ssh'
  // A fresh module graph per test (`findSsh` memoizes per module), so the platform the manager
  // reads is the one initialised here — imported AFTER the reset, never the static copy.
  vi.resetModules()
  platformModule = await import('./platform')
  fake = fakePlatform()
  platformModule.initPlatform(fake)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  platformModule.resetPlatformForTests()
})

type ConfirmedProcessRun = (file: string, args: readonly string[], opts?: object) => Promise<unknown>

async function manager(deps: { confirmedProcessRun?: ConfirmedProcessRun } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager(deps)
  m.registerIpc()
  return m
}

/** `has-session` as tmux 3.4 resolves it: `=name` is exact, a bare name prefix-matches a miss. */
function hasSession(live: string[], args: readonly string[]): boolean {
  const target = args[args.indexOf('-t') + 1] ?? ''
  if (target.startsWith('=')) return live.includes(target.slice(1))
  return live.some((s) => s === target || s.startsWith(target))
}

/** Every `tmux -V` the manager asked (the watcher client's version probe). */
const versionAsks: string[] = []

/** A `tmux -V` that could not run at all (spawn error, timeout) — not an answer. */
const PROBE_FAILS = 'PROBE_FAILS'

/** A tmux-backed manager whose probes answer from `live` without touching a tmux socket. `version`
 *  is what `tmux -V` answers (a list is consumed in order, the last answer repeating); `window` what
 *  the window-size read answers, `null` = unreadable. */
async function tmuxManager(
  live: string[],
  {
    version = 'tmux 3.4\n',
    window = { cols: 120, rows: 39 }
  }: { version?: string | string[]; window?: { cols: number; rows: number } | null } = {}
) {
  versionAsks.length = 0
  const answers = Array.isArray(version) ? [...version] : [version]
  const confirmedProcessRun: ConfirmedProcessRun = async (_file, args) => {
    if (args[0] === '-V') {
      const answer = answers.length > 1 ? answers.shift()! : answers[0]
      versionAsks.push(answer)
      if (answer === PROBE_FAILS) throw Object.assign(new Error('spawn tmux ETIMEDOUT'), { code: 'ETIMEDOUT' })
      return { stdout: answer, stderr: '' }
    }
    if (hasSession(live, args)) return { stdout: '', stderr: '' }
    throw Object.assign(new Error("can't find session"), { code: 1 })
  }
  const m = await manager({ confirmedProcessRun })
  vi.spyOn(
    m as unknown as { readWindowSize: (k: string) => Promise<unknown> },
    'readWindowSize'
  ).mockResolvedValue(window ?? undefined)
  ;(m as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
  vi.spyOn(
    m as unknown as { tmuxSessionExists: (k: string) => Promise<boolean> },
    'tmuxSessionExists'
  ).mockImplementation(async (k: string) => hasSession(live, ['-t', `nt-${k}`]))
  vi.spyOn(
    m as unknown as { paneCwdStale: (k: string) => Promise<boolean> },
    'paneCwdStale'
  ).mockResolvedValue(false)
  return m
}

const create = (clientId: number, options: Partial<PtyCreateOptions>) =>
  fake.handlers[IPC.ptyCreate](clientId, {
    cols: 80,
    rows: 24,
    persistKey: 'n1',
    ...options
  }) as Promise<PtyCreateResult>
const kill = (clientId: number, sessionId: string) =>
  fake.senderListeners[IPC.ptyKill](clientId, sessionId)
const WATCH = { persistKey: 'n1', viewerId: 'watch-s1', cols: 40, rows: 10 }

describe('joinAsWatcher', () => {
  it('never starts a session: no live session is a join-only refusal, and nothing spawns', async () => {
    const m = await manager()
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses when only a session whose name EXTENDS this node id is alive', async () => {
    const m = await tmuxManager(['nt-n12'])
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it("joins the owner's live session and never shrinks it", async () => {
    const m = await manager()
    const a = await create(OWNER, { cols: 120, rows: 40 })
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.sessionId).toBe(a.sessionId)
    expect(w.fresh).toBe(false)
    expect(w.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].resizes).toEqual([])
    // Still a subscriber: told the authoritative size to render.
    const sizes = fake.sent.filter((s) => s.channel === IPC.ptySize(a.sessionId))
    expect(sizes.map((s) => s.to)).toEqual([WATCHER])
    expect(sizes[0].args[0]).toEqual({ cols: 120, rows: 40 })
  })

  it('with no Session held, spawns its OWN client: attach-session -E -f ignore-size,read-only, exact target', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.unavailable).toBeUndefined()
    expect(w.fresh).toBe(false)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('/usr/bin/tmux')
    expect(spawned[0].args).toEqual([
      '-L',
      'node-terminal',
      'attach-session',
      '-E',
      '-f',
      'ignore-size,read-only',
      '-t',
      '=nt-n1:'
    ])
  })

  it('control: a hosted Viewer (joinOnly, not a watcher) keeps its new-session -A mirror, byte-identical', async () => {
    await tmuxManager(['nt-n1'])
    await create(VIEWER, { joinOnly: true, sizeVote: false })
    expect(spawned[0].args).toContain('new-session')
    expect(spawned[0].args).toContain('-A')
    expect(spawned[0].args).not.toContain('attach-session')
    expect(versionAsks).toEqual([]) // no version probe on that path either
  })

  it('spawns its client at the window CURRENT size, not the caller-reported one', async () => {
    const m = await tmuxManager(['nt-n1'], { window: { cols: 132, rows: 43 } })
    await m.joinAsWatcher(WATCHER, WATCH)
    expect([spawned[0].cols, spawned[0].rows]).toEqual([132, 43])
  })

  it('an unreadable window size REFUSES the spawn — never a guessed size (caller, remembered, default)', async () => {
    const m = await tmuxManager(['nt-n1'], { window: null })
    // The caller's size is not used...
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    // ...nor the default...
    expect(await m.joinAsWatcher(WATCHER, { persistKey: 'n1', viewerId: 'watch-s1' })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
    // ...nor a remembered (released) size.
    const own = await create(OWNER, { cols: 132, rows: 43 })
    kill(OWNER, own.sessionId)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 132, rows: 43 })
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(1) // the owner's own client, nothing for the watcher
  })

  it('the refusal is "not now": once the window can be read, the next join spawns', async () => {
    const m = await tmuxManager(['nt-n1'], { window: null })
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    ;(m as unknown as { readWindowSize: ReturnType<typeof vi.fn> }).readWindowSize.mockResolvedValue({
      cols: 150,
      rows: 45
    })
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.unavailable).toBeUndefined()
    expect([spawned[0].cols, spawned[0].rows]).toEqual([150, 45])
  })

  // R64/M4: joining a HELD session reads nothing from tmux — the session's own size is the answer.
  // The read used to take the CALLER's sshRemote, which is absent for a remote node whose master is
  // down, and so asked the LOCAL tmux about a remote node's name.
  it('reads the window size only to SPAWN a client — never to join a held session', async () => {
    const m = await tmuxManager(['nt-n1'], { window: { cols: 132, rows: 43 } })
    const read = (m as unknown as { readWindowSize: ReturnType<typeof vi.fn> }).readWindowSize
    const a = await create(OWNER, { cols: 120, rows: 40 })
    await m.joinAsWatcher(WATCHER, WATCH) // a live Session is held and the caller gave a size
    await m.joinAsWatcher(WATCHER + 1, { persistKey: 'n1', viewerId: 'watch-s2', requireRemote: true }) // no size
    expect(read).not.toHaveBeenCalled()
    // The view is shown the held session's own size (nothing to correct, so nothing more is sent).
    expect(fake.sent.filter((x) => x.channel === IPC.ptySize(a.sessionId) && x.to === WATCHER + 1)).toEqual([])
    // With nothing held, the spawn reads it — once, by the node's exact target.
    const m2 = await tmuxManager(['nt-n2'], { window: { cols: 132, rows: 43 } })
    const read2 = (m2 as unknown as { readWindowSize: ReturnType<typeof vi.fn> }).readWindowSize
    await m2.joinAsWatcher(WATCHER, { persistKey: 'n2', viewerId: 'watch-s3' })
    expect(read2).toHaveBeenCalledTimes(1)
    expect(read2.mock.calls[0][0]).toBe('n2')
  })

  // R64/M4: a watcher never paints from the co-attach screen (its keyframe is a visible-only capture),
  // so a join captures nothing for it. On SSH that was a `-S -200` history capture per viewer join.
  it("a watcher's join takes no co-attach capture; a second owner view still does (control)", async () => {
    const m = await tmuxManager(['nt-n1'])
    const spies = m as unknown as { captureForResync: (s: string) => Promise<string>; paneCursor: (s: string) => Promise<unknown> }
    const capture = vi.spyOn(spies, 'captureForResync').mockResolvedValue('SCREEN')
    const cursor = vi.spyOn(spies, 'paneCursor').mockResolvedValue(undefined)
    await create(OWNER, { cols: 120, rows: 40 })
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.unavailable).toBeUndefined()
    expect(w.screen).toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
    expect(cursor).not.toHaveBeenCalled()
    const second = await create(VIEWER, { cols: 120, rows: 40 })
    expect(second.screen).toBe('SCREEN')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('local tmux < 3.2 has no client flags: FAIL CLOSED, nothing spawned, logged once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = await tmuxManager(['nt-n1'], { version: 'tmux 3.1c\n' })
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
    expect(versionAsks).toHaveLength(1) // memoized
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('live link'))
    expect(lines).toHaveLength(1)
    expect(String(lines[0][0])).toContain('3.2')
    warn.mockRestore()
  })

  it('an unreadable local tmux version fails closed too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = await tmuxManager(['nt-n1'], { version: 'tmux master\n' })
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
    warn.mockRestore()
  })

  it('a FAILED version probe is not an answer: not memoized, the next join asks again', async () => {
    const m = await tmuxManager(['nt-n1'], { version: [PROBE_FAILS, 'tmux 3.4\n'] })
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(versionAsks).toEqual([PROBE_FAILS, 'tmux 3.4\n'])
    // A definite answer IS kept.
    await m.joinAsWatcher(WATCHER + 1, { ...WATCH, persistKey: 'n1', viewerId: 'watch-s2' })
    expect(versionAsks).toHaveLength(2)
  })

  it('a definite OLD answer is kept (no re-probe per viewer)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = await tmuxManager(['nt-n1'], { version: ['tmux 3.1c\n', 'tmux 3.4\n'] })
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(await m.joinAsWatcher(WATCHER, WATCH)).toEqual(REFUSED)
    expect(versionAsks).toEqual(['tmux 3.1c\n'])
    warn.mockRestore()
  })

  it('the version is probed once, however many watchers spawn', async () => {
    const m = await tmuxManager(['nt-n1', 'nt-n2'])
    await m.joinAsWatcher(WATCHER, WATCH)
    await m.joinAsWatcher(WATCHER + 1, { ...WATCH, persistKey: 'n2', viewerId: 'watch-s2' })
    expect(spawned).toHaveLength(2)
    expect(versionAsks).toHaveLength(1)
  })

  it("a second viewer of the same node shares the first viewer's client instead of opening another", async () => {
    const m = await tmuxManager(['nt-n1'])
    const a = await m.joinAsWatcher(WATCHER, WATCH)
    const b = await m.joinAsWatcher(WATCHER + 1, { ...WATCH, viewerId: 'watch-s2' })
    expect(b.sessionId).toBe(a.sessionId)
    expect(spawned).toHaveLength(1)
  })

  it("a watcher client's release never overwrites the owner's released size (a shadow would push it)", async () => {
    const m = await tmuxManager(['nt-n1'])
    const own = await create(OWNER, { cols: 132, rows: 43 })
    kill(OWNER, own.sessionId)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 132, rows: 43 })
    const w = await m.joinAsWatcher(WATCHER, WATCH) // no Session held → its own client, at the window (120x39)
    expect([spawned.at(-1)!.cols, spawned.at(-1)!.rows]).toEqual([120, 39])
    m.kill(WATCHER, w.sessionId, 'watch-s1') // the watcher's own view: its client is released
    expect(spawned.at(-1)!.killed).toBe(true)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 132, rows: 43 })
  })

  it("the watcher's client is never the node's Session for anyone else: the owner spawns its own", async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    const a = await create(OWNER, { cols: 120, rows: 40 })
    expect(a.sessionId).not.toBe(w.sessionId)
    expect(spawned).toHaveLength(2)
    expect(spawned[1].args).toContain('new-session')
    expect(spawned[1].args).toContain('-D')
  })

  it("a watcher's client is not a painter: it does not retire the node's background-write clients", async () => {
    const m = await tmuxManager(['nt-n1'])
    const shadow = vi.spyOn(m as unknown as { shadowDispose: (k: string) => void }, 'shadowDispose')
    const shared = vi.spyOn(m as unknown as { sharedDisposeOn: (k: string) => void }, 'sharedDisposeOn')
    await m.joinAsWatcher(WATCHER, WATCH)
    expect(shadow).not.toHaveBeenCalled()
    expect(shared).not.toHaveBeenCalled()
    // Control: an owner's painter does retire them.
    await create(OWNER, { cols: 120, rows: 40 })
    expect(shadow).toHaveBeenCalledWith('n1')
  })

  it("a background write never goes into the watcher's read-only client", async () => {
    const m = await tmuxManager(['nt-n1'])
    await m.joinAsWatcher(WATCHER, WATCH)
    await m.backgroundWrite('n1', 'echo hi\r')
    expect(spawned[0].writes).toEqual([])
  })

  it('forwards only the named fields — nothing else a caller passes reaches create()', async () => {
    const m = await tmuxManager(['nt-n1'])
    const spy = vi.spyOn(m as unknown as { create: (...a: unknown[]) => Promise<unknown> }, 'create')
    await m.joinAsWatcher(WATCHER, { ...WATCH, shell: 'sh', agentId: 'claude', accountId: 'a1' } as never)
    const passed = spy.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(passed).sort()).toEqual(['cols', 'joinOnly', 'persistKey', 'rows', 'sizeVote', 'viewerId'])
    expect(passed.joinOnly).toBe(true)
    expect(passed.sizeVote).toBe(false)
  })
})

describe('joinAsWatcher over SSH', () => {
  const SSH_REMOTE = { controlPath: '/tmp/nt-test-cm', conn: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }

  async function sshManager(verdict: 'present' | 'absent' | 'unknown') {
    const m = await tmuxManager([])
    vi.spyOn(
      m as unknown as { remoteSessionVerdict: () => Promise<string> },
      'remoteSessionVerdict'
    ).mockResolvedValue(verdict)
    return m
  }

  it('spawns a tty-allocating ssh child that ATTACHES with the watcher flags, no local version probe', async () => {
    const m = await sshManager('present')
    const w = await m.joinAsWatcher(WATCHER, { ...WATCH, sshRemote: SSH_REMOTE })
    expect(w.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('/usr/bin/ssh')
    expect(spawned[0].args[0]).toBe('-t')
    const remote = spawned[0].args.at(-1)!
    expect(remote).toContain("attach-session -E -f 'ignore-size,read-only' -t '=nt-n1:'")
    expect(remote).not.toContain('new-session')
    expect(versionAsks).toEqual([])
  })

  it('a remote window size that cannot be read: refused, nothing spawned', async () => {
    const m = await sshManager('present')
    ;(m as unknown as { readWindowSize: ReturnType<typeof vi.fn> }).readWindowSize.mockResolvedValue(undefined)
    expect(await m.joinAsWatcher(WATCHER, { ...WATCH, sshRemote: SSH_REMOTE })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('a remote session the host says is gone: refused, nothing spawned', async () => {
    const m = await sshManager('absent')
    expect(await m.joinAsWatcher(WATCHER, { ...WATCH, sshRemote: SSH_REMOTE })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('a remote node with no ssh binary is NEVER watched through the local tmux', async () => {
    ssh.path = null
    const m = await sshManager('present')
    const w = await m.joinAsWatcher(WATCHER, { ...WATCH, sshRemote: SSH_REMOTE })
    expect(w.sessionId).toBe('')
    expect(w.unavailable).toBe('ssh')
    expect(spawned).toHaveLength(0)
  })
})

describe('joinAsWatcher (continued)', () => {
  it('the join-only, non-voting rules are FORCED — a caller cannot turn them off', async () => {
    const m = await manager()
    const smuggled = { ...WATCH, joinOnly: false, sizeVote: true } as never
    expect(await m.joinAsWatcher(WATCHER, smuggled)).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)

    await create(OWNER, { cols: 120, rows: 40 })
    await m.joinAsWatcher(WATCHER, smuggled)
    expect(spawned[0].resizes).toEqual([])
  })
})

describe('syncWatcherClientSize', () => {
  type Read = ReturnType<typeof vi.fn>
  const readOf = (m: object): Read => (m as unknown as { readWindowSize: Read }).readWindowSize
  const sessionOf = (m: object, id: string) =>
    (m as unknown as { sessions: Map<string, { sizes: Map<unknown, unknown>; appliedSize?: unknown }> }).sessions.get(id)!

  it("resizes the watcher's OWN client to exactly the window size read now, and tells its viewers", async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH) // spawned at the window, 120x39
    readOf(m).mockResolvedValue({ cols: 200, rows: 50 }) // the owner (elsewhere) resized the window
    fake.sent.length = 0
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(true)
    expect(spawned[0].resizes).toEqual([{ cols: 200, rows: 50 }])
    const sizes = fake.sent.filter((x) => x.channel === IPC.ptySize(w.sessionId))
    expect(sizes.map((x) => x.to)).toEqual([WATCHER])
    expect(sizes[0].args[0]).toEqual({ cols: 200, rows: 50 })
  })

  it('is never a size vote, and never a viewer-supplied size', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    await m.joinAsWatcher(WATCHER + 1, { persistKey: 'n1', viewerId: 'watch-s2', cols: 33, rows: 7 })
    readOf(m).mockResolvedValue({ cols: 200, rows: 50 })
    await m.syncWatcherClientSize(w.sessionId)
    expect(spawned[0].resizes).toEqual([{ cols: 200, rows: 50 }])
    expect(sessionOf(m, w.sessionId).sizes.size).toBe(0)
  })

  it('an unchanged window resizes nothing (a full redraw is not free)', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(true)
    expect(spawned[0].resizes).toEqual([])
  })

  it('an unreadable size changes nothing', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    readOf(m).mockResolvedValue(undefined)
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(false)
    expect(spawned[0].resizes).toEqual([])
  })

  it("never touches a session that is not a watcher's own client (the owner's pty is never resized)", async () => {
    const m = await tmuxManager(['nt-n1'])
    const own = await create(OWNER, { cols: 120, rows: 40 })
    await m.joinAsWatcher(WATCHER, WATCH) // co-attaches to the owner's Session
    readOf(m).mockClear()
    readOf(m).mockResolvedValue({ cols: 200, rows: 50 })
    expect(await m.syncWatcherClientSize(own.sessionId)).toBe(false)
    expect(readOf(m)).not.toHaveBeenCalled()
    expect(spawned[0].resizes).toEqual([])
    expect(await m.syncWatcherClientSize('no-such-session')).toBe(false)
  })

  it('a client that went away during the read is left alone', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    let answer: (v: unknown) => void = () => {}
    readOf(m).mockImplementation(() => new Promise((r) => (answer = r)))
    const pending = m.syncWatcherClientSize(w.sessionId)
    m.kill(WATCHER, w.sessionId, 'watch-s1')
    answer({ cols: 200, rows: 50 })
    expect(await pending).toBe(false)
    expect(spawned[0].resizes).toEqual([])
  })

  // Controller ruling R24: the link host syncs on every keyframe AND on a 10 s timer, and two links can
  // watch one node, so calls overlap. Two reads racing each other could land out of order and leave the
  // client at the OLDER size. So one read is in flight per session, and callers that arrive meanwhile
  // share ONE queued rerun, which reads after it (the latest read is applied last).
  it('serializes per session: one read in flight, callers meanwhile share ONE rerun, the later read applied last', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH) // spawned at the window, 120x39
    const answers: Array<(v: unknown) => void> = []
    readOf(m).mockClear()
    readOf(m).mockImplementation(() => new Promise((r) => answers.push(r)))
    const first = m.syncWatcherClientSize(w.sessionId)
    const second = m.syncWatcherClientSize(w.sessionId)
    const third = m.syncWatcherClientSize(w.sessionId)
    expect(second).toBe(third) // one queued rerun, shared
    await vi.advanceTimersByTimeAsync(0)
    expect(readOf(m)).toHaveBeenCalledTimes(1) // nothing reads beside the one in flight
    answers[0]({ cols: 100, rows: 30 })
    expect(await first).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(readOf(m)).toHaveBeenCalledTimes(2) // the rerun reads only once the first settled
    answers[1]({ cols: 200, rows: 50 })
    expect(await second).toBe(true)
    expect(spawned[0].resizes).toEqual([{ cols: 100, rows: 30 }, { cols: 200, rows: 50 }])
    // Settled: the next call starts a fresh read at once.
    readOf(m).mockResolvedValue({ cols: 200, rows: 50 })
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(true)
    expect(readOf(m)).toHaveBeenCalledTimes(3)
  })

  it('serialization is per session: another session reads at the same time', async () => {
    const m = await tmuxManager(['nt-n1', 'nt-n2'])
    const a = await m.joinAsWatcher(WATCHER, WATCH)
    const b = await m.joinAsWatcher(WATCHER, { persistKey: 'n2', viewerId: 'watch-s2' })
    readOf(m).mockClear()
    readOf(m).mockImplementation(() => new Promise(() => {}))
    void m.syncWatcherClientSize(a.sessionId)
    void m.syncWatcherClientSize(b.sessionId)
    await vi.advanceTimersByTimeAsync(0)
    expect(readOf(m).mock.calls.map((c) => c[0])).toEqual(['n1', 'n2'])
  })

  it('a read that throws settles the slot: the next call reads again', async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    readOf(m).mockRejectedValueOnce(new Error('boom'))
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(false)
    readOf(m).mockResolvedValue({ cols: 130, rows: 40 })
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(true)
    expect(spawned[0].resizes).toEqual([{ cols: 130, rows: 40 }])
  })

  it('an SSH watcher client is synced from the HOST read', async () => {
    const m = await tmuxManager([])
    vi.spyOn(
      m as unknown as { remoteSessionVerdict: () => Promise<string> },
      'remoteSessionVerdict'
    ).mockResolvedValue('present')
    const SSH_REMOTE = { controlPath: '/tmp/nt-test-cm', conn: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    const w = await m.joinAsWatcher(WATCHER, { ...WATCH, sshRemote: SSH_REMOTE })
    readOf(m).mockClear()
    readOf(m).mockResolvedValue({ cols: 210, rows: 55 })
    expect(await m.syncWatcherClientSize(w.sessionId)).toBe(true)
    expect(readOf(m)).toHaveBeenCalledWith('n1', expect.objectContaining({ controlPath: '/tmp/nt-test-cm' }))
    expect(spawned[0].resizes).toEqual([{ cols: 210, rows: 55 }])
  })
})

// Controller ruling R25: the size a live link's `watch:meta` reports is the JOINED session's current
// size. For a watcher's own client that is the size it runs at (the window's, read at spawn and kept by
// the sync) — `watchSizeFor` cannot see that client (it is invisible to every persistKey lookup) and
// would answer a stale released size or nothing.
describe('sessionSize', () => {
  it("is the owner's pty size for a co-attached watcher, and follows the owner's resize", async () => {
    const m = await manager()
    const own = await create(OWNER, { cols: 120, rows: 40 })
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(w.sessionId).toBe(own.sessionId)
    expect(m.sessionSize(w.sessionId)).toEqual({ cols: 120, rows: 40 })
    fake.senderListeners[IPC.ptyResize](OWNER, own.sessionId, 100, 30)
    expect(m.sessionSize(w.sessionId)).toEqual({ cols: 100, rows: 30 })
  })

  it("is a watcher's OWN client's size — the window's, read at spawn and kept by the sync", async () => {
    const m = await tmuxManager(['nt-n1'])
    const w = await m.joinAsWatcher(WATCHER, WATCH) // caller said 40x10; spawned at the window, 120x39
    expect(m.sessionSize(w.sessionId)).toEqual({ cols: 120, rows: 39 })
    expect(m.watchSizeFor('n1')).toBeUndefined() // what the old wiring would have reported: nothing
    ;(m as unknown as { readWindowSize: ReturnType<typeof vi.fn> }).readWindowSize.mockResolvedValue({ cols: 200, rows: 50 })
    await m.syncWatcherClientSize(w.sessionId)
    expect(m.sessionSize(w.sessionId)).toEqual({ cols: 200, rows: 50 })
  })

  it('is null for a session this manager does not know', async () => {
    const m = await manager()
    expect(m.sessionSize('no-such-session')).toBeNull()
  })

  it('hands back a copy, not the live size record', async () => {
    const m = await manager()
    const own = await create(OWNER, { cols: 120, rows: 40 })
    const size = m.sessionSize(own.sessionId)!
    size.cols = 1
    expect(m.sessionSize(own.sessionId)).toEqual({ cols: 120, rows: 40 })
  })
})

// Controller ruling R38: a live link asks "is the session I joined still there?" after the join and
// after every capture (an exit can race either — R30). An explicit accessor, not `nodeOfSession(sid)
// !== undefined`, which would lean on every watched session having been created with a persistKey.
describe('hasSession', () => {
  it('is true for a live session, owner or watcher, and false once it ended', async () => {
    const m = await manager()
    const own = await create(OWNER, { cols: 120, rows: 40 })
    const w = await m.joinAsWatcher(WATCHER, WATCH)
    expect(m.hasSession(own.sessionId)).toBe(true)
    expect(m.hasSession(w.sessionId)).toBe(true)
    spawned[spawned.length - 1].onExitCb!({ exitCode: 0 })
    expect(m.hasSession(own.sessionId)).toBe(false)
  })

  it('is false for a session this manager never created', async () => {
    const m = await manager()
    expect(m.hasSession('no-such-session')).toBe(false)
    expect(m.hasSession('')).toBe(false)
  })
})

describe('watchSizeFor', () => {
  it('is the size the live pty runs at, whatever the watcher reported', async () => {
    const m = await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    await m.joinAsWatcher(WATCHER, WATCH)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 120, rows: 40 })
  })

  it('follows the pty when the owner resizes it', async () => {
    const m = await manager()
    const { sessionId } = await create(OWNER, { cols: 120, rows: 40 })
    fake.senderListeners[IPC.ptyResize](OWNER, sessionId, 100, 30)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 100, rows: 30 })
  })

  it('is the size the pty had when its last client was released', async () => {
    const m = await tmuxManager(['nt-n1'])
    const { sessionId } = await create(OWNER, { cols: 132, rows: 43 })
    kill(OWNER, sessionId)
    expect(spawned[0].killed).toBe(true)
    expect(m.watchSizeFor('n1')).toEqual({ cols: 132, rows: 43 })
  })

  it('is undefined for a node this process never ran', async () => {
    const m = await manager()
    expect(m.watchSizeFor('n1')).toBeUndefined()
  })

  it('hands back a copy, not the live size record', async () => {
    const m = await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    const size = m.watchSizeFor('n1')!
    size.cols = 1
    expect(m.watchSizeFor('n1')).toEqual({ cols: 120, rows: 40 })
  })
})

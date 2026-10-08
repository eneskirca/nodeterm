import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'

/** A13: every local painter co-attaches; only privately attested app painters can be retired.
 * The native process/tmux boundary is exercised in relay-coattach.realtmux.test.ts. */

interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  killed: boolean
}
const spawned: FakePty[] = []
const spawnArgs: Array<{ file: string; args: string[] }> = []
const painterTracks = vi.hoisted(() => [] as Array<{
  options: { userData: string; session: string; pid: number; current(): boolean }
  close: ReturnType<typeof vi.fn>
}>)
vi.mock('./tmux-painter', () => ({
  trackTmuxPainter: (options: typeof painterTracks[number]['options']) => {
    const close = vi.fn()
    painterTracks.push({ options, close })
    return { close, settled: Promise.resolve() }
  }
}))

// Pin the persistence backend (see src/core/__fixtures__/no-session-host.ts): whether this suite
// exercised tmux or a real session-host shim must not depend on whether anyone ran a build.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    const p: FakePty = { killed: false }
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
      pause: () => {},
      resume: () => {},
      kill: () => {
        p.killed = true
      },
      pid: 1
    }
  }
}))

/** Every tmux/ssh side-call goes through child_process; `has-session` answers from the set. */
const liveTmuxSessions = new Set<string>()

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: string | { stdout: string; stderr: string }, stderr?: string) => void
  const execFile = (_file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    const ok = (stdout: string): void => cb?.(null, { stdout, stderr: '' })
    if (args.includes('has-session')) {
      const target = args[args.indexOf('-t') + 1]
      if (liveTmuxSessions.has(target)) ok('')
      else cb?.(Object.assign(new Error('no such session'), { code: 1 }))
    } else if (args[0] === '-ilc') {
      cb?.(null, '__NT_PATH_START__/usr/bin:/bin__NT_PATH_END__', '')
    } else {
      ok('')
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

// Hermetic tmux resolution (issue #160 — see pty-single-user.test.ts): the tmux-backed manager is
// what is under test, so it must not silently become the plain-shell fallback on a host without one.
vi.mock('./tmux-hint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux-hint')>()),
  findFixedTmux: () => '/usr/bin/tmux'
}))

// Hermetic ssh resolution for the SSH-project leg: `findSsh()` walks the real PATH, and a host
// without an ssh client (this sandbox has none) would silently fall through to the LOCAL tmux
// branch — i.e. test a spawn that never happens for a remote node.
vi.mock('./exec-path', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-path')>()
  return {
    ...real,
    findExecutableSync: (bin: string, fallbacks?: string[]) =>
      bin === 'ssh' ? '/usr/bin/ssh' : real.findExecutableSync(bin, fallbacks)
  }
})

// A machine with pty devices to spare (see pty-single-user.test.ts for why this is pinned).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1
const REMOTE = { conn: { host: 'h1', user: 'u' }, controlPath: '/tmp/cm', remoteCwd: '/srv/app' }

/** The attach flags of a LOCAL tmux spawn: everything between `new-session` and the first `-e`/`-c`. */
function localAttachFlags(args: string[]): string[] {
  const at = args.indexOf('new-session')
  expect(at).toBeGreaterThan(-1)
  const out: string[] = []
  for (const a of args.slice(at + 1)) {
    if (a !== '-A' && a !== '-D') break
    out.push(a)
  }
  return out
}

/** The tokens of the REMOTE tmux command between `new-session` and `-s` (the ssh argv carries the
 *  whole remote shell line as one string; every token there is posix-quoted). */
function remoteAttachTokens(args: string[]): string[] {
  const line = args.join(' ')
  const at = line.indexOf('new-session')
  expect(at).toBeGreaterThan(-1)
  const end = line.indexOf(' -s ', at)
  return line
    .slice(at + 'new-session'.length, end)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^'|'$/g, ''))
}

describe("the app's tmux client beside a relay-served (phone) client — audit A13", () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(() => {
    spawned.length = 0
    spawnArgs.length = 0
    painterTracks.length = 0
    liveTmuxSessions.clear()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-relayco-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetPlatformForTests()
    // Best effort, as in pty-single-user.test.ts: a fire-and-forget scrollback snapshot may still
    // be landing, and a cleanup that fails the suite is worse than a leftover temp dir.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })

  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    return m
  }
  const create = (persistKey = 'node-1', extra: Record<string, unknown> = {}) =>
    fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24, persistKey, ...extra }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  const sinks = () => ({ onData: vi.fn(), onExit: vi.fn() })

  it('tracks only the local app painter after creation; relay sinks are never takeover candidates', async () => {
    const m = await tmuxManager()
    m.attachDetached('node-1', sinks())
    expect(painterTracks).toHaveLength(0)
    await create()
    expect(painterTracks).toHaveLength(1)
    expect(painterTracks[0].options).toMatchObject({ userData: userDataDir, session: 'nt-node-1', pid: 1 })
    expect(painterTracks[0].options.current()).toBe(true)
  })

  it('joins one painter across app viewers, then retires its receipt only on final release', async () => {
    const m = await tmuxManager()
    const first = await create()
    await fake.handlers[IPC.ptyCreate](2, { cols: 100, rows: 40, persistKey: 'node-1' })
    expect(painterTracks).toHaveLength(1)
    expect(spawnArgs).toHaveLength(1)
    m.kill(ALICE, first.sessionId)
    expect(painterTracks[0].close).not.toHaveBeenCalled()
    expect(painterTracks[0].options.current()).toBe(true)
    m.kill(2, first.sessionId)
    expect(painterTracks[0].close).toHaveBeenCalledOnce()
    expect(painterTracks[0].options.current()).toBe(false)
  })

  it('retires painter tracking on both process exit and normal app shutdown', async () => {
    const m = await tmuxManager()
    await create()
    spawned[0].onExitCb?.({ exitCode: 0 })
    expect(painterTracks[0].close).toHaveBeenCalledOnce()
    expect(painterTracks[0].options.current()).toBe(false)
    await create('node-2')
    await m.killAll()
    expect(painterTracks[1].close).toHaveBeenCalledOnce()
    expect(painterTracks[1].options.current()).toBe(false)
  })

  it('co-attaches even when no in-process relay client is known', async () => {
    await tmuxManager()
    await create()
    expect(spawnArgs).toHaveLength(1)
    expect(localAttachFlags(spawnArgs[0].args)).toEqual(['-A'])
  })

  it('co-attaches WITHOUT -D while a relay client of the same node is attached', async () => {
    const m = await tmuxManager()
    liveTmuxSessions.add(sessionName('node-1'))
    const phone = sinks()
    m.attachDetached('node-1', phone) // the phone, attached first (it started the session)

    await create() // the desktop mounts the node the phone just registered

    expect(spawnArgs).toHaveLength(2)
    // The relay's own client never detached anyone…
    expect(localAttachFlags(spawnArgs[0].args)).toEqual(['-A'])
    // …and the app's client now does not detach the phone either.
    expect(localAttachFlags(spawnArgs[1].args)).toEqual(['-A'])
    expect(spawnArgs[1].args.slice(-2)).toEqual(['-s', sessionName('node-1')])
    // The phone's pty is untouched and told nothing.
    expect(spawned[0].killed).toBe(false)
    expect(phone.onExit).not.toHaveBeenCalled()
  })

  it('decides at SPAWN time: a phone that attaches while the app create is in flight is spared', async () => {
    const m = await tmuxManager()
    liveTmuxSessions.add(sessionName('node-1'))
    // create() awaits has-session (a subprocess) before it spawns anything…
    const pending = create()
    expect(spawnArgs).toHaveLength(0)
    // …and the relay attach lands in that window.
    m.attachDetached('node-1', sinks())
    await pending

    expect(spawnArgs).toHaveLength(2)
    expect(localAttachFlags(spawnArgs[1].args)).toEqual(['-A'])
  })

  it('a relay client of another node does not change safe local attachment', async () => {
    const m = await tmuxManager()
    m.attachDetached('node-2', sinks())
    await create('node-1')
    expect(localAttachFlags(spawnArgs[1].args)).toEqual(['-A'])
  })

  it('preserves unknown external viewers after an in-process relay stream closes', async () => {
    const m = await tmuxManager()
    const relayId = m.attachDetached('node-1', sinks())
    m.kill(null, relayId) // the phone detached right before the desktop mounted the node
    await create()
    expect(localAttachFlags(spawnArgs[1].args)).toEqual(['-A'])
  })

  it("preserves unknown external viewers after a relay pty exits", async () => {
    const m = await tmuxManager()
    m.attachDetached('node-1', sinks())
    spawned[0].onExitCb?.({ exitCode: 0 })
    await create()
    expect(localAttachFlags(spawnArgs[1].args)).toEqual(['-A'])
  })

  it('the next remount (park expiry, offscreen revive) still spares a phone that stayed', async () => {
    const m = await tmuxManager()
    liveTmuxSessions.add(sessionName('node-1'))
    m.attachDetached('node-1', sinks())
    const first = await create()
    m.kill(ALICE, first.sessionId) // the desktop node unmounts; the phone keeps watching
    await create()

    expect(spawnArgs).toHaveLength(3)
    expect(localAttachFlags(spawnArgs[2].args)).toEqual(['-A'])
    expect(spawned[0].killed).toBe(false)
  })

  it('an SSH-project node never passes -D on the remote host, with or without a relay client', async () => {
    const m = await tmuxManager()
    const relayOpts = { cols: 80, rows: 24, sshRemote: REMOTE, requireRemote: true }
    // The renderer's remote attach with no phone attached, then the phone joining it…
    await create('node-r', { sshRemote: REMOTE, requireRemote: true })
    m.attachDetached('node-r', sinks(), relayOpts)
    // …and the reverse order: the phone attached over the same ControlMaster first (audit A09's
    // relay path), then the desktop mounts the node.
    m.attachDetached('node-r2', sinks(), relayOpts)
    await create('node-r2', { sshRemote: REMOTE, requireRemote: true })

    expect(m.sshRemoteForNode('node-r')).toBeDefined() // the remote branch really ran
    const remoteSpawns = spawnArgs.filter((s) => s.file === '/usr/bin/ssh')
    expect(remoteSpawns).toHaveLength(4)
    for (const s of remoteSpawns) {
      const tokens = remoteAttachTokens(s.args)
      expect(tokens[0]).toBe('-A')
      expect(tokens).not.toContain('-D')
    }
  })

  it('a relay client over an SSH master leaves local external viewers untouched', async () => {
    // Not a state the app reaches (a remote node refuses a local spawn — `requireRemote`), but the
    // predicate must ask about the tmux server the spawn attaches to, not about the node id alone.
    const m = await tmuxManager()
    m.attachDetached('node-1', sinks(), { cols: 80, rows: 24, sshRemote: REMOTE, requireRemote: true })
    await create('node-1')
    const local = spawnArgs.filter((s) => s.file !== '/usr/bin/ssh')
    expect(local).toHaveLength(1)
    expect(localAttachFlags(local[0].args)).toEqual(['-A'])
  })
})

describe('tmuxAttachFlags (A13)', () => {
  it('drops -D for a relay-served pty and for the app client beside one, and only then', async () => {
    const { tmuxAttachFlags } = await import('./pty-manager')
    expect(tmuxAttachFlags(false)).toEqual(['-A'])
    expect(tmuxAttachFlags(false, false)).toEqual(['-A'])
    expect(tmuxAttachFlags(false, true)).toEqual(['-A'])
    expect(tmuxAttachFlags(true)).toEqual(['-A'])
    expect(tmuxAttachFlags(true, true)).toEqual(['-A'])
  })
})

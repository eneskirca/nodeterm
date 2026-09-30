import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * A hosted-relay VIEWER may watch a terminal but never start one, and never constrains the shared
 * pty's size. The relay access policy expresses both as create options (`joinOnly`, `sizeVote:
 * false`); this suite pins what `PtyManager` does with them. Harness copied from
 * pty-coattach.test.ts: a mocked `node-pty` that records each spawn and each resize, so "spawned
 * nothing" is `spawned.length === 0` and "the pty kept its size" is "no resize was pushed".
 */

/** One fake pty per spawn, recorded so a test can assert "exactly one spawn" and push output. */
interface FakePty {
  /** The argv the pty was spawned with — the tmux attach flags are asserted from it. */
  args: string[]
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
}
const spawned: FakePty[] = []

// Pin the persistence backend (see src/core/__fixtures__/no-session-host.ts): without this, a
// checkout that ran `npm run build` would take the session-host branch instead of the mock below.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[], _opts: unknown) => {
    const p: FakePty = { args: [...(args ?? [])], writes: [], resizes: [], killed: false }
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

// A machine with pty devices to spare, always (same reason as pty-coattach.test.ts).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

// The SSH cases never run a real `ssh`: with no ssh executable the only thing a create that gets
// PAST the join-only gate can do is spawn (a local plain shell here), which is exactly what those
// tests must not see. Every other executable lookup is the real one.
vi.mock('./exec-path', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-path')>()
  return {
    ...real,
    findExecutableSync: (bin: string, fallbacks?: string[]) =>
      bin === 'ssh' ? null : real.findExecutableSync(bin, fallbacks)
  }
})
vi.mock('./remote-ssh/agent-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./remote-ssh/agent-probe')>()),
  probeAgentSockToPin: async () => undefined
}))

const OWNER = 1
const VIEWER = 2

let fake: FakePlatform

beforeEach(() => {
  spawned.length = 0
  fake = fakePlatform()
  initPlatform(fake)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  resetPlatformForTests()
})

type ConfirmedProcessRun = (file: string, args: readonly string[], opts?: object) => Promise<unknown>

/** The default manager: no tmux (init() never runs in unit tests), so a session is a plain shell. */
async function manager(deps: { confirmedProcessRun?: ConfirmedProcessRun } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager(deps)
  m.registerIpc()
  return m
}

/**
 * What `tmux has-session` does for this node: the session is there, tmux says it is not (its own
 * exit 1), or the probe could not run at all (EAGAIN under a bulk load, a timeout).
 */
type Probe = 'present' | 'absent' | 'error'

/**
 * `tmux has-session -t <target>` against a set of live session names, the way tmux 3.4 resolves
 * the target (measured): `=name` matches exactly; a bare name falls through to PREFIX matching on
 * a miss, so `nt-n1` "exists" while only `nt-n12` is alive.
 */
function hasSession(live: string[], args: readonly string[]): boolean {
  const target = args[args.indexOf('-t') + 1] ?? ''
  if (target.startsWith('=')) return live.includes(target.slice(1))
  return live.some((s) => s === target || s.startsWith(target))
}

/**
 * A manager whose sessions are tmux-BACKED. The tmux path is forced (as pty-coattach.test.ts does)
 * and both existence probes answer from `probe` without touching a tmux socket:
 *  - the STRICT one through the injected process runner, which emulates `has-session` (above) and
 *    rejects the way `execFile` does — `code: 1` for tmux's own "no session", `code: 'EAGAIN'` for
 *    a probe that could not run;
 *  - the FOLDED warm/cold one (`tmuxSessionExists`, a bare target) stubbed to what the real one
 *    answers: only tmux's own exit 1 is absence, so a failed probe reads as "exists".
 */
async function tmuxManager(probe: Probe, live: string[] = probe === 'present' ? ['nt-n1'] : []) {
  const confirmedProcessRun: ConfirmedProcessRun = async (_file, args) => {
    if (probe === 'error')
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })
    if (hasSession(live, args)) return { stdout: '', stderr: '' }
    throw Object.assign(new Error("can't find session"), { code: 1 })
  }
  const m = await manager({ confirmedProcessRun })
  ;(m as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
  vi.spyOn(
    m as unknown as { tmuxSessionExists: (k: string) => Promise<boolean> },
    'tmuxSessionExists'
  ).mockImplementation(async (k: string) =>
    probe === 'error' ? true : hasSession(live, ['-t', `nt-${k}`])
  )
  // The warm-reattach stale-cwd probe runs `tmux display-message`; answer "not stale".
  vi.spyOn(
    m as unknown as { paneCwdStale: (k: string) => Promise<boolean> },
    'paneCwdStale'
  ).mockResolvedValue(false)
  return m
}

const SSH_REMOTE = { controlPath: '/tmp/nt-test-cm', conn: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }

/** A manager whose REMOTE freshness read answers `verdict` (see remote-session-index.ts). */
async function sshManager(verdict: 'present' | 'absent' | 'unknown') {
  const m = await manager()
  vi.spyOn(
    m as unknown as { remoteSessionVerdict: () => Promise<string> },
    'remoteSessionVerdict'
  ).mockResolvedValue(verdict)
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
const sizesSent = (sessionId: string) =>
  fake.sent.filter((s) => s.channel === IPC.ptySize(sessionId))

const REFUSED: PtyCreateResult = { sessionId: '', fresh: false, unavailable: 'join-only' }

describe('joinOnly: a viewer may watch a terminal but never start one', () => {
  it('refuses when no session exists and spawns nothing', async () => {
    await manager()
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses when tmux says the session is gone, and spawns no tmux client', async () => {
    await tmuxManager('absent')
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses a create with no persistKey (there is nothing it could ever reattach to)', async () => {
    await manager()
    expect(await create(VIEWER, { joinOnly: true, persistKey: undefined })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('joins a live session (co-attach)', async () => {
    await manager()
    const a = await create(OWNER, {})
    const b = await create(VIEWER, { joinOnly: true })
    expect(b.sessionId).toBe(a.sessionId)
    expect(b.fresh).toBe(false)
    expect(b.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1) // the owner's pty — the viewer subscribed to it
  })

  it("joins the owner's spawn when it races it (the in-flight barrier, not a refusal)", async () => {
    await manager()
    const [a, b] = await Promise.all([create(OWNER, {}), create(VIEWER, { joinOnly: true })])
    expect(b.sessionId).toBe(a.sessionId)
    expect(b.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
  })

  it('warm-reattaches a tmux session that is still running', async () => {
    await tmuxManager('present')
    const res = await create(VIEWER, { joinOnly: true })
    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).not.toBe('')
    expect(res.fresh).toBe(false)
    expect(spawned).toHaveLength(1) // a tmux CLIENT onto the existing session, not a new session
  })

  it('a refusal leaves nothing behind: the owner still opens the node normally afterwards', async () => {
    await manager()
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    const a = await create(OWNER, {})
    expect(a.sessionId).not.toBe('')
    expect(a.fresh).toBe(true)
    expect(spawned).toHaveLength(1)
  })

  // The folded warm/cold probe answers "exists" when tmux could not be asked, because for the
  // OWNER that is the safe fold (never type a resume into a live pane). For a viewer it is the
  // unsafe one: "exists" sends it on to `new-session -A`, which CREATES the session if it was
  // really gone — and then the owner's next open reads `fresh:false` and skips its cold restore.
  it('refuses when the tmux probe could not run (EAGAIN), and spawns nothing', async () => {
    await tmuxManager('error')
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses when there is no tmux to ask at all (the binary cannot be executed)', async () => {
    // No stubs: both probes run for real against a path that does not exist (spawn ENOENT).
    const m = await manager()
    ;(m as unknown as { tmuxPath: string }).tmuxPath = '/nonexistent/nodeterm-test/tmux'
    expect(await create(VIEWER, { joinOnly: true })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  // App-minted node ids share a prefix and differ in a trailing counter (`term-abc-1`,
  // `term-abc-12`). tmux resolves a BARE target by prefix on a miss, while `new-session -A -s`
  // matches exactly — so a bare probe would read `nt-n1` as alive and the attach would create it.
  it('refuses when only a session whose name EXTENDS this one is alive (exact-target probe)', async () => {
    await tmuxManager('absent', ['nt-n12'])
    expect(await create(VIEWER, { joinOnly: true, persistKey: 'n1' })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses an SSH node whose host could not be read (verdict unknown)', async () => {
    await sshManager('unknown')
    expect(await create(VIEWER, { joinOnly: true, sshRemote: SSH_REMOTE })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  it('refuses an SSH node whose host says the session is gone', async () => {
    await sshManager('absent')
    expect(await create(VIEWER, { joinOnly: true, sshRemote: SSH_REMOTE })).toEqual(REFUSED)
    expect(spawned).toHaveLength(0)
  })

  // `-D` detaches every OTHER tmux client of the session on attach: the user's own
  // `tmux -L node-terminal attach`, another app on the same socket. A watch-only view must mirror
  // them, the way a relay-served pty does (`tmuxAttachFlags`), never kick them off.
  it('a join-only warm reattach does not detach other tmux clients (no -D)', async () => {
    await tmuxManager('present')
    await create(VIEWER, { joinOnly: true })
    expect(spawned).toHaveLength(1)
    const argv = spawned[0].args
    expect(argv).toContain('new-session')
    expect(argv).toContain('-A')
    expect(argv).not.toContain('-D')
  })

  it('control: the owner\'s warm reattach still takes the session over (-D)', async () => {
    await tmuxManager('present')
    await create(OWNER, {})
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toContain('-D')
  })

  it('an absent joinOnly still spawns (the non-viewer path is unchanged)', async () => {
    await manager()
    const a = await create(OWNER, {})
    expect(a.sessionId).not.toBe('')
    expect(a.fresh).toBe(true)
    expect(a.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
  })
})

describe('sizeVote: false — a viewer never constrains the shared pty size', () => {
  it('never shrinks the shared pty', async () => {
    await manager()
    const a = await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 40, rows: 10, sizeVote: false })
    // The pty was spawned at 120x40 and nothing was pushed since: it still runs at the owner's size.
    expect(spawned[0].resizes).toEqual([])
    expect(a.sessionId).not.toBe('')
  })

  it('control: the same join WITHOUT sizeVote:false does shrink it (smallest subscriber wins)', async () => {
    await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 40, rows: 10 })
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 40, rows: 10 })
  })

  it('is still a subscriber: it is told the authoritative size and receives output', async () => {
    await manager()
    const { sessionId } = await create(OWNER, { cols: 120, rows: 40 })
    fake.sent.length = 0
    await create(VIEWER, { cols: 40, rows: 10, sizeVote: false })

    const sent = sizesSent(sessionId)
    expect(sent.map((s) => s.to)).toEqual([VIEWER]) // the owner already renders 120x40
    expect(sent[0].args[0]).toEqual({ cols: 120, rows: 40 })

    spawned[0].onDataCb?.('hello')
    vi.advanceTimersByTime(20) // FLUSH_MS coalescing window
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to).sort()).toEqual([OWNER, VIEWER])
  })

  it('when the only voter leaves, the pty keeps its size rather than taking the viewer’s', async () => {
    await manager()
    const { sessionId } = await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 40, rows: 10, sizeVote: false })
    kill(OWNER, sessionId)
    expect(spawned[0].killed).toBe(false) // the viewer still watches
    expect(spawned[0].resizes).toEqual([])
  })

  // The same subscriber key can join twice: a renderer reload re-joins under the same ClientId,
  // and so does a client whose role changed from editor to viewer. Its earlier vote must not
  // survive the re-join that says it no longer votes.
  it('a re-join as a non-voter withdraws the vote the same view held before', async () => {
    await manager()
    await create(OWNER, { cols: 120, rows: 40 })
    await create(VIEWER, { cols: 60, rows: 20 }) // an editor: votes, the pty shrinks
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 60, rows: 20 })
    await create(VIEWER, { cols: 60, rows: 20, sizeVote: false }) // same view, now watch-only
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 })
  })

  it('a viewer that warm-reattached holds no vote once the owner joins', async () => {
    // The viewer's create is the first in this process, so it SPAWNS the tmux client (at its own
    // grid — the pty needs some size). That must not seed a vote: when the owner then co-attaches,
    // the pty takes the owner's size instead of staying pinned at the viewer's small window.
    await tmuxManager('present')
    const v = await create(VIEWER, { cols: 40, rows: 10, joinOnly: true, sizeVote: false })
    expect(v.fresh).toBe(false)
    const a = await create(OWNER, { cols: 120, rows: 40 })
    expect(a.sessionId).toBe(v.sessionId)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 })
  })
})

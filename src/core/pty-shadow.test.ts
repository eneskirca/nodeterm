import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { REAP_IDLE_MS, REAP_SWEEP_MS } from './pty-reap'
import type { ControlSpawn } from './tmux-control-client'
import type { PtyDevices } from './pty-devices'

/**
 * SHADOW CLIENTS: a tmux control-mode (`-C`) client over plain pipes, attached to the tmux session
 * of a node whose PAINTER pty client has already been released — the idle reap's stranded ones, and
 * the ones a plain `pty:kill` (last subscriber out, offscreen dispose) let go immediately. It holds
 * ZERO pty devices, which is what lets a background feature reach a node nobody is watching without
 * respawning a terminal (a pty device, a tmux client, an ssh child and a full redraw).
 *
 * Two invariants carry the whole design, and most of what follows asserts one of them:
 *  - a node never has a live painter AND a live shadow at the same time;
 *  - a shadow is INVISIBLE to everything that asks "is somebody watching" — the reap sweep (which
 *    decides against `platform().clientIds()`), the renderer's 5-minute park and the 10-minute
 *    offscreen dispose. It is not a subscriber, not a `Session`, and not a renderer client id.
 */

/** One fake pty per spawn. `killed` is what a released client pty looks like from here. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  killed: boolean
}
const spawned: FakePty[] = []
/** Spawn/dispose events across BOTH child kinds, so a test can assert their relative ORDER. */
const log: string[] = []

vi.mock('node-pty', () => ({
  spawn: () => {
    const p: FakePty = { killed: false }
    spawned.push(p)
    log.push('pty-spawn')
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

/** Every tmux side-call goes through child_process; `liveTmuxSessions` answers `has-session`. */
const liveTmuxSessions = new Set<string>()

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
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

/** One fake control-mode child per shadow: what was written to it, and whether it was killed. */
interface FakeControlChild {
  writes: string[]
  killed: number
  exit(code: number | null): void
  feed(latin1: string): void
}

/**
 * The injected `ControlSpawn`. It answers commands like a healthy tmux does — ASYNCHRONOUSLY (a
 * reply delivered inside the `write` call would arrive before the client had queued its resolver,
 * which is not a thing the real protocol can do) — and `autoReply = false` plays the wedged tmux
 * that takes a command and never answers.
 */
class FakeControlSpawn implements ControlSpawn {
  calls: Array<{ bin: string; args: string[] }> = []
  children: FakeControlChild[] = []
  autoReply = true
  /** `child_process.spawn` throws SYNCHRONOUSLY (EMFILE, a bad cwd) — this plays that. */
  throwOnSpawn = false
  private num = 0
  spawn(bin: string, args: string[]) {
    if (this.throwOnSpawn) throw new Error('spawn EMFILE')
    this.calls.push({ bin, args })
    log.push('control-spawn')
    let onData: ((b: Buffer) => void) | undefined
    let onExit: ((code: number | null) => void) | undefined
    const child: FakeControlChild = {
      writes: [],
      killed: 0,
      exit: (code) => onExit?.(code),
      feed: (s) => onData?.(Buffer.from(s, 'latin1'))
    }
    this.children.push(child)
    return {
      stdin: {
        write: (s: string) => {
          child.writes.push(s)
          // `detach-client` is the disposal handshake, not a command with a reply.
          if (!this.autoReply || s.startsWith('detach-client')) return
          const n = ++this.num
          // A real microtask (not a timer): tests run under fake timers.
          void Promise.resolve().then(() =>
            child.feed(`%begin 1700 ${n} 0\n%end 1700 ${n} 0\n`)
          )
        }
      },
      stdout: {
        on: (_ev: 'data', cb: (b: Buffer) => void) => {
          onData = cb
        }
      },
      on: (_ev: 'exit', cb: (code: number | null) => void) => {
        onExit = cb
      },
      kill: () => {
        child.killed++
        log.push('control-kill')
      }
    }
  }
  get only(): FakeControlChild {
    return this.children[0]
  }
}

/**
 * A machine with pty devices to spare by default.
 *
 * Without this the real probe runs a `readdir('/dev')` against the DEVELOPER's host, and
 * `spawnSession`'s pre-flight refuses every create once that host is within `PTY_DEVICE_HEADROOM`
 * of its own `kern.tty.ptmx_max` — which a machine running this app all day genuinely reaches (511
 * on macOS; this one sits in the 480s). Settable, because one test below is about what a REFUSED
 * create does to a shadow.
 */
const devices = vi.hoisted(() => ({ current: { ceiling: 511, inUse: 8 } as PtyDevices }))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => devices.current
}))

const ALICE = 1
const BOB = 2

describe('control-mode shadow clients for released sessions', () => {
  let fake: FakePlatform
  let userDataDir: string
  let control: FakeControlSpawn

  beforeEach(() => {
    spawned.length = 0
    log.length = 0
    devices.current = { ceiling: 511, inUse: 8 }
    liveTmuxSessions.clear()
    control = new FakeControlSpawn()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-shadow-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetPlatformForTests()
    // Best effort, as in pty-idle-reap.test.ts: a fired-and-forgotten scrollback snapshot can still
    // be landing here, and a cleanup that fails the suite is worse than a leftover dir.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })

  /** A manager WITH init(): tmux-backed, which is what a real user always gets. */
  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    return m
  }
  /** A manager WITHOUT init(): no tmux, so there is no tmux session to shadow. */
  async function plainManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.registerIpc()
    return m
  }
  const create = (clientId: number, persistKey = 'node-1', cols = 80, rows = 24) =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  /** pty:kill is sender-aware: it unsubscribes ONE view, and the last one out releases the pty. */
  const kill = (clientId: number, sessionId: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId)
  /** Run the sweep past the idle threshold (it only decides on its own ticks). */
  const idle = (ms = REAP_IDLE_MS + REAP_SWEEP_MS) => vi.advanceTimersByTime(ms)
  const attachArgs = (key: string) => ['-L', TMUX_SOCKET, '-C', 'attach-session', '-t', sessionName(key)]

  it('shadows a session the reap stranded — over pipes, taking no pty device', async () => {
    const m = await tmuxManager()
    await create(ALICE) // …and Alice's window is then destroyed without a pty:kill ever arriving
    idle()
    expect(spawned[0].killed).toBe(true) // the sweep released her client pty

    const shadow = await m.shadowAttach('node-1')

    expect(shadow).not.toBeNull()
    expect(control.calls).toEqual([{ bin: m.getTmuxBin(), args: attachArgs('node-1') }])
    // The whole point: reaching the session cost no second pty.
    expect(spawned).toHaveLength(1)
  })

  it('shadows a session released the instant its last subscriber left (the offscreen path)', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId) // offscreen dispose / node unmount: zero subscribers, released at once

    expect(spawned[0].killed).toBe(true)
    expect(await m.shadowAttach('node-1')).not.toBeNull()
    expect(control.calls).toHaveLength(1)
  })

  it('refuses while the painter pty client is attached — never both at once', async () => {
    const m = await tmuxManager()
    await create(ALICE)

    expect(await m.shadowAttach('node-1')).toBeNull()
    expect(control.calls).toHaveLength(0)
  })

  it('leaves the shadow ALIVE when the create is refused for want of pty devices', async () => {
    // The swap-out below retires the shadow to make way for an arriving painter. If a create that
    // never spawns anything still ran it, a machine at its pty ceiling would silently kill the
    // background client of every node it refused — and nothing re-attaches one (`shadowAttach` is
    // driven by release/reap, not by a failed create), so the node would go dark until the user
    // reopened it. Hence the pre-flight runs BEFORE the swap-out, not next to `pty.spawn`.
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)
    const shadow = await m.shadowAttach('node-1')
    expect(shadow).not.toBeNull()

    devices.current = { ceiling: 511, inUse: 515 } // the machine fills up
    await expect(create(ALICE)).rejects.toThrow(/out of pty devices/)

    expect(control.only.killed).toBe(0) // not retired…
    expect(await m.shadowAttach('node-1')).toBe(shadow) // …and still the live one, re-used
    expect(control.calls).toHaveLength(1) // no second control client either
    expect(spawned).toHaveLength(1) // and, of course, no second pty
  })

  it('re-uses a live shadow instead of spawning a second control client', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    const first = await m.shadowAttach('node-1')
    const second = await m.shadowAttach('node-1')

    expect(second).toBe(first)
    expect(control.calls).toHaveLength(1)
  })

  it('re-asserts the size the painter last enforced — a control client sizes the pane', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE, 'node-1', 100, 30)
    kill(ALICE, sessionId)

    await m.shadowAttach('node-1')

    // With only a control client attached the pane follows `refresh-client -C`; without this push
    // the user would come back to a pane reflowed to somebody else's default.
    expect(control.only.writes).toContain('refresh-client -C 100x30\n')
  })

  it('pushes no size when the released session never recorded one', async () => {
    const m = await tmuxManager()
    // A relay-served (detached) pty: its sink reports no size at create time, so this manager never
    // enforced one. Pushing an invented size would reflow a pane that is perfectly fine.
    const sessionId = m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })
    m.kill(null, sessionId)

    await m.shadowAttach('node-1')

    expect(control.only.writes.some((w) => w.startsWith('refresh-client'))).toBe(false)
  })

  it('is invisible to the reaper: not a watcher, and never swept up itself', async () => {
    const m = await tmuxManager()
    await create(ALICE, 'node-1')
    idle()
    await m.shadowAttach('node-1')

    // A second node is opened and abandoned the same way. If the shadow had registered anywhere the
    // sweep looks — a client id, a subscriber, a Session — it would show here: as a session that
    // never becomes reapable, or as a shadow the sweep tore down.
    await create(BOB, 'node-2')
    idle()

    expect(spawned[1].killed).toBe(true) // node-2 still reaps ⇒ clientIds() is unpolluted
    expect(control.only.killed).toBe(0) // the sweep does not touch a shadow…
    expect(control.calls).toHaveLength(1) // …and never attaches one either
  })

  it('disposes the shadow BEFORE spawning the painter when the node comes back', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)
    await m.shadowAttach('node-1')
    liveTmuxSessions.add(sessionName('node-1')) // tmux kept it running, as it does across a detach
    log.length = 0

    await create(ALICE) // the node scrolls back into view / the user reopens the project

    // Order is the assertion: the painter attaches with `-D` and would kick the shadow off anyway,
    // but only after tmux has processed both attaches — so the shadow goes first, and exactly one
    // client of ours is ever negotiating the pane.
    expect(log).toEqual(['control-kill', 'pty-spawn'])
    expect(control.only.writes).toContain('detach-client\n') // detached politely, then killed
    expect(spawned[1].killed).toBe(false) // the painter is live and untouched
  })

  it('leaves the session alone when its shadow dies, and re-attaches lazily on the next ask', async () => {
    const m = await tmuxManager()
    await create(ALICE)
    idle()
    await m.shadowAttach('node-1')

    control.children[0].exit(1) // the control client died on its own (tmux restart, OOM kill)

    // Nothing is resurrected on its behalf — no pty, no session, no eager re-attach.
    expect(spawned).toHaveLength(1)
    expect(control.calls).toHaveLength(1)

    const again = await m.shadowAttach('node-1')

    expect(again).not.toBeNull()
    expect(control.calls).toEqual([
      { bin: m.getTmuxBin(), args: attachArgs('node-1') },
      { bin: m.getTmuxBin(), args: attachArgs('node-1') }
    ])
  })

  it('disposes a shadow whose reply never comes — a lost reply desyncs the FIFO forever', async () => {
    const { SHADOW_CMD_TIMEOUT_MS } = await import('./pty-manager')
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE, 'node-1', 100, 30)
    kill(ALICE, sessionId)
    control.autoReply = false // tmux takes the command and never answers

    const attaching = m.shadowAttach('node-1')
    await vi.advanceTimersByTimeAsync(SHADOW_CMD_TIMEOUT_MS)

    expect(await attaching).toBeNull()
    expect(control.only.killed).toBe(1)
    // …and the entry is gone, so the next ask gets a fresh client rather than a desynced one.
    control.autoReply = true
    expect(await m.shadowAttach('node-1')).not.toBeNull()
    expect(control.calls).toHaveLength(2)
  })

  it('destroying a node takes its shadow with it — the tmux session is going away', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)
    await m.shadowAttach('node-1')

    await m.destroySession(ALICE, 'node-1')

    expect(control.only.killed).toBe(1)
  })

  it('app quit disposes every shadow', async () => {
    const m = await tmuxManager()
    const a = await create(ALICE, 'node-1')
    const b = await create(BOB, 'node-2')
    kill(ALICE, a.sessionId)
    kill(BOB, b.sessionId)
    await m.shadowAttach('node-1')
    await m.shadowAttach('node-2')

    await m.killAll()

    expect(control.children.map((c) => c.killed)).toEqual([1, 1])
    expect(control.children.every((c) => c.writes.includes('detach-client\n'))).toBe(true)
  })

  it('stays reapable by the SESSION BUDGET, which reads tmux’s own attached flag', async () => {
    // The one attachment check a shadow really is visible to: `session-budget.ts` culls idle
    // DETACHED `nt-*` sessions under memory pressure, and a held `-C attach` flips
    // `#{session_attached}` to 1 — so a shadowed session would be permanently exempt from the
    // memory-pressure safety valve. It runs in production from BOTH shells against this socket.
    const { createSessionReaper } = await import('./session-budget')
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)
    await m.shadowAttach('node-1')

    const NOW = 1_000_000
    const OLD = NOW - 100_000 // well past the 6h grace window
    const listings: Record<string, string> = {
      // `nt-node-1` reads as attached because our shadow IS a real tmux client; `nt-node-9` is a
      // genuinely attached session (somebody is looking at it) and must survive.
      'node-terminal': `nt-node-1|1|${OLD}\nnt-node-9|1|${OLD}`,
      // The SAME NAME on the SSH-remote socket, attached for real. Shadows only ever live on the
      // local socket, so the exclusion must not follow the name across sockets.
      'nodeterm-rmt': `nt-node-1|1|${OLD}`
    }
    const killed: Array<{ socket: string; target: string }> = []
    const reaper = createSessionReaper({
      tmuxBin: () => m.getTmuxBin(),
      shadowed: (socket) => m.shadowedTmuxSessions(socket),
      exec: async (_bin: string, args: string[]) => {
        const socket = args[args.indexOf('-L') + 1]
        if (args.includes('kill-session')) {
          killed.push({ socket, target: args[args.indexOf('-t') + 1] })
          return ''
        }
        return listings[socket] ?? ''
      },
      readMem: () => ({ availableMb: 100, totalMb: 8000 }), // under the watermark: real pressure
      env: {},
      nowSec: () => NOW
    })

    expect(await reaper.sweep()).toBe(1)
    expect(killed).toEqual([{ socket: 'node-terminal', target: '=nt-node-1' }])
  })

  it('leaves a session somebody is really watching alone — the attached flag is a client COUNT', async () => {
    // `#{session_attached}` counts clients. Subtracting our shadow by forcing the flag to false
    // would report a session that has our shadow PLUS a real client — the user's own
    // `tmux -L node-terminal attach`, or a second nodeterm process on the same socket — as
    // detached, and the budget would then kill a session out from under a live user, inverting its
    // one hard rule in the state-destroying direction. The shadow comes off the COUNT.
    const { createSessionReaper } = await import('./session-budget')
    const m = await tmuxManager()
    const a = await create(ALICE, 'node-1')
    const b = await create(BOB, 'node-2')
    kill(ALICE, a.sessionId)
    kill(BOB, b.sessionId)
    await m.shadowAttach('node-1')
    await m.shadowAttach('node-2')

    const NOW = 1_000_000
    const OLD = NOW - 100_000
    const killed: string[] = []
    let listings = 0
    const reaper = createSessionReaper({
      tmuxBin: () => m.getTmuxBin(),
      sockets: ['node-terminal'],
      shadowed: (socket) => m.shadowedTmuxSessions(socket),
      exec: async (_bin: string, args: string[]) => {
        if (args.includes('kill-session')) {
          killed.push(args[args.indexOf('-t') + 1])
          return ''
        }
        // nt-node-1 carries the user's own client the whole time (2 = theirs + ours), so the PLAN
        // must never name it. nt-node-2 is shadow-only when the plan is made and gains a real
        // client before the kill — precisely what the kill-time re-verify exists for.
        const nodeTwo = listings++ === 0 ? 1 : 2
        return `nt-node-1|2|${OLD}\nnt-node-2|${nodeTwo}|${OLD}`
      },
      readMem: () => ({ availableMb: 100, totalMb: 8000 }), // under the watermark: real pressure
      env: {},
      nowSec: () => NOW
    })

    expect(await reaper.sweep()).toBe(0)
    expect(killed).toEqual([])
  })

  it('refuses a released REMOTE node — its tmux lives on the far host, not on our socket', async () => {
    const m = await tmuxManager()
    const res = (await fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-r',
      sshRemote: { conn: { host: 'h1', user: 'u' }, controlPath: '/tmp/cm', remoteCwd: '/srv/app' }
    })) as { sessionId: string }
    expect(m.sshRemoteForNode('node-r')).toBeDefined() // the spawn really did take the remote branch
    kill(ALICE, res.sessionId)

    // `nt-node-r` on OUR socket is either nothing at all or — worse — the local orphan a create
    // issued with the master down once left behind. Neither is this node's session.
    expect(await m.shadowAttach('node-r')).toBeNull()
    expect(control.calls).toHaveLength(0)
  })

  it('returns null (never rejects) when the control client cannot even be spawned', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)
    control.throwOnSpawn = true

    expect(await m.shadowAttach('node-1')).toBeNull()

    // …and no half-attached entry is left behind: the next ask spawns a real one.
    control.throwOnSpawn = false
    expect(await m.shadowAttach('node-1')).not.toBeNull()
    expect(control.calls).toHaveLength(1)
  })

  it('keeps a shadow whose command was refused before anything was written', async () => {
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)
    const shadow = await m.shadowAttach('node-1')

    // A malformed line is refused CLIENT-side, before a byte is written, so the FIFO cannot have
    // desynced — tearing the shadow (and its tmux client) down over it would be pure collateral.
    expect(await m.shadowCommand('node-1', 'display-message -p x\nkill-server')).toBeNull()

    expect(control.only.killed).toBe(0)
    expect(await m.shadowAttach('node-1')).toBe(shadow)
  })

  it('does nothing with tmux switched off in settings — no session is tmux-backed', async () => {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: false }))
    m.registerIpc()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    // The binary is right there, so `tmuxPath` alone would say yes — but nothing spawned a tmux
    // session, so a shadow would attach to a name that does not exist and die on arrival.
    expect(await m.shadowAttach('node-1')).toBeNull()
    expect(control.calls).toHaveLength(0)
  })

  it('spawns nothing with ptyShadowClients switched off — the kill switch', async () => {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.init(() => ({ ...DEFAULT_SETTINGS, ptyShadowClients: false }))
    m.registerIpc()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    // Everything else about this session is exactly as it is with the flag on: tmux is there, the
    // session is released, the record is ours. The flag is the ONE reason nothing attaches, which
    // is what makes "switch it off" a truthful instruction in a field report.
    expect(await m.shadowAttach('node-1')).toBeNull()
    expect(control.calls).toHaveLength(0)
  })

  it('logs one greppable line per swap direction', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const m = await tmuxManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    await m.shadowAttach('node-1')
    await m.shadowAttach('node-1') // re-used, not re-attached — so no second line

    expect(lines.filter((l) => l === `[pty] shadow attach ${sessionName('node-1')}`)).toHaveLength(1)

    liveTmuxSessions.add(sessionName('node-1')) // tmux kept the session across the detach
    await create(ALICE)

    // The other direction. "My terminal came back blank" is answerable from these two lines alone:
    // they name the session, the direction, and (by their order) which client held it when.
    expect(lines.filter((l) => l === `[pty] painter attach ${sessionName('node-1')}`)).toHaveLength(
      1
    )
  })

  it('says nothing when a painter spawns with no control client to retire', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const m = await tmuxManager()

    await create(ALICE) // the ordinary case: opening a terminal retires nothing

    // One line per SWAP, not per terminal anyone ever opens: a log nobody can read is a log that
    // answers no field report.
    expect(lines.some((l) => l.startsWith('[pty] painter attach'))).toBe(false)
  })

  it('does nothing without tmux — there is no tmux session to shadow', async () => {
    const m = await plainManager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    expect(await m.shadowAttach('node-1')).toBeNull()
    expect(control.calls).toHaveLength(0)
  })
})

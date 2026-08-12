import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { TMUX_SOCKET, sessionName, isSessionName } from './tmux-naming'
import type { ControlSpawn } from './tmux-control-client'

/**
 * BACKGROUND WRITES: typing into a node whose PAINTER pty client has been released, without
 * respawning one. `send-keys` is server-wide in control mode, so the fallthrough is
 * painter → the node's own shadow (if one is already up) → ONE shared control client for the whole
 * tmux server, started lazily on the first background write and disposed after a short linger.
 *
 * The harness is `pty-shadow.test.ts`'s, with one addition: the fake pty records what was written
 * into it, because "the painter got the bytes" is half of what this file asserts.
 */

/** One fake pty per spawn. `killed` is what a released client pty looks like from here. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  killed: boolean
  /** node-pty throws on a write to a process that has already gone (as `resize` does). */
  throwOnWrite: boolean
}
const spawned: FakePty[] = []
/** Spawn/dispose events across BOTH child kinds, so a test can assert their relative ORDER. */
const log: string[] = []

vi.mock('node-pty', () => ({
  spawn: () => {
    const p: FakePty = { writes: [], killed: false, throwOnWrite: false }
    spawned.push(p)
    log.push('pty-spawn')
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: (d: string) => {
        if (p.throwOnWrite) throw new Error('write EIO')
        p.writes.push(d)
      },
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

/** One fake control-mode child per client: what was written to it, and whether it was killed. */
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
  private num = 0
  spawn(bin: string, args: string[]) {
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
          void Promise.resolve().then(() => child.feed(`%begin 1700 ${n} 0\n%end 1700 ${n} 0\n`))
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

const ALICE = 1
const BOB = 2

/** `ls\n` as the wire sees it: hex bytes, because a control-mode command is one text line. */
const LS_KEYS = (target: string): string => `send-keys -t ${target} -H 6c 73 0a\n`

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

describe('background writes into released sessions', () => {
  let fake: FakePlatform
  let userDataDir: string
  let control: FakeControlSpawn

  beforeEach(() => {
    spawned.length = 0
    log.length = 0
    liveTmuxSessions.clear()
    control = new FakeControlSpawn()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-bgwrite-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetPlatformForTests()
    // Best effort, as in pty-shadow.test.ts: a fired-and-forgotten scrollback snapshot can still be
    // landing here, and a cleanup that fails the suite is worse than a leftover dir.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })

  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    return m
  }
  /** The same manager with one setting flipped — tmux is still installed and still enabled. */
  async function managerWith(patch: Partial<typeof DEFAULT_SETTINGS>) {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.init(() => ({ ...DEFAULT_SETTINGS, ...patch }))
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
  /** Open a node and let it go — the state every background write in this file starts from. */
  const release = async (clientId: number, persistKey: string) => {
    const { sessionId } = await create(clientId, persistKey)
    kill(clientId, sessionId)
    return sessionId
  }
  const attachArgs = (key: string) => [
    '-L',
    TMUX_SOCKET,
    '-C',
    'attach-session',
    '-t',
    sessionName(key)
  ]

  it('types into a released session over a control client — no pty, exact send-keys line', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')

    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(true)

    expect(control.calls).toEqual([{ bin: m.getTmuxBin(), args: attachArgs('node-1') }])
    expect(control.only.writes).toContain(LS_KEYS('nt-node-1'))
    // The whole point: reaching the session cost no second pty device.
    expect(spawned).toHaveLength(1)
    expect(spawned[0].killed).toBe(true)
  })

  it('writes straight into the painter while the node is on screen — control clients untouched', async () => {
    const m = await tmuxManager()
    await create(ALICE, 'node-1')

    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(true)

    expect(spawned[0].writes).toEqual(['ls\n'])
    expect(control.calls).toHaveLength(0)
  })

  it('reports a failure rather than rejecting when the painter’s pty is already gone', async () => {
    const m = await tmuxManager()
    await create(ALICE, 'node-1')
    spawned[0].throwOnWrite = true // node-pty throws on a write to a process that has exited

    // `write()` fires this path and forgets it, so a rejection here would surface as an UNHANDLED
    // rejection in the main process — a crash risk, from a pty that merely died first.
    await expect(m.backgroundWrite('node-1', 'ls\n')).resolves.toBe(false)
  })

  it('prefers the node’s own shadow to the shared client', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.shadowAttach('node-1')

    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(true)

    // One client, and it is the shadow that was already up: a second attach to the same session
    // would put two clients of ours on one pane for nothing.
    expect(control.calls).toHaveLength(1)
    expect(control.only.writes).toContain(LS_KEYS('nt-node-1'))
  })

  it('starts ONE shared client for a burst of writes to different nodes', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await release(BOB, 'node-2')
    await release(BOB, 'node-3')

    await m.backgroundWrite('node-1', 'ls\n')
    await m.backgroundWrite('node-2', 'ls\n')
    await m.backgroundWrite('node-3', 'ls\n')

    // `send-keys` is SERVER-wide: one attached client can target every session on the socket, so a
    // burst costs one process, not one per node.
    expect(control.calls).toHaveLength(1)
    expect(control.only.writes).toEqual([
      LS_KEYS('nt-node-1'),
      LS_KEYS('nt-node-2'),
      LS_KEYS('nt-node-3')
    ])
  })

  it('disposes the shared client after the linger, and starts a fresh one for a later write', async () => {
    const { BACKGROUND_WRITE_LINGER_MS } = await import('./pty-manager')
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.backgroundWrite('node-1', 'ls\n')

    expect(control.only.killed).toBe(0)
    vi.advanceTimersByTime(BACKGROUND_WRITE_LINGER_MS)

    expect(control.only.writes).toContain('detach-client\n') // detached politely, then killed
    expect(control.only.killed).toBe(1)

    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(true)
    expect(control.calls).toHaveLength(2)
  })

  it('pushes the linger out on every background write', async () => {
    const { BACKGROUND_WRITE_LINGER_MS } = await import('./pty-manager')
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    const almost = BACKGROUND_WRITE_LINGER_MS - 1

    await m.backgroundWrite('node-1', 'ls\n')
    vi.advanceTimersByTime(almost)
    await m.backgroundWrite('node-1', 'ls\n')
    vi.advanceTimersByTime(almost)

    // A steady trickle of background writes keeps ONE client instead of churning a process per
    // write — which is the entire reason the linger exists.
    expect(control.only.killed).toBe(0)
    expect(control.calls).toHaveLength(1)
    vi.advanceTimersByTime(BACKGROUND_WRITE_LINGER_MS)
    expect(control.only.killed).toBe(1)
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
    // issued with the master down once left behind. Typing into that is typing into the wrong box.
    expect(await m.backgroundWrite('node-r', 'ls\n')).toBe(false)
    expect(control.calls).toHaveLength(0)
  })

  it('refuses a node it has no released record for — it cannot prove that session is ours', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')

    // No record means this process never opened the node: `nt-<id>` on our socket could be a remote
    // node's local orphan, or another machine's idea of it. Blind-writing it is the one thing a
    // background feature must never do.
    expect(await m.backgroundWrite('node-nobody-opened', 'ls\n')).toBe(false)
    expect(control.calls).toHaveLength(0)
  })

  it('never retries a timed-out send-keys on another client — tmux may already have run it', async () => {
    const { SHADOW_CMD_TIMEOUT_MS } = await import('./pty-manager')
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.shadowAttach('node-1')
    control.autoReply = false // tmux takes the command and never answers

    const writing = m.backgroundWrite('node-1', 'ls\n')
    await vi.advanceTimersByTimeAsync(SHADOW_CMD_TIMEOUT_MS)

    expect(await writing).toBe(false)
    expect(control.only.killed).toBe(1) // the desynced client is gone…
    expect(control.calls).toHaveLength(1) // …and nothing re-sent the keys anywhere else
  })

  it('falls through from a released session id — a stale write lands instead of vanishing', async () => {
    const m = await tmuxManager()
    const sessionId = await release(ALICE, 'node-1')

    // The session id a caller was holding when the pty client went away (the relay host keeps one
    // per stream). It resolves to no `Session` at all, and used to drop the bytes on the floor.
    m.write(ALICE, sessionId, 'ls\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(control.only.writes).toContain(LS_KEYS('nt-node-1'))
  })

  it('retires the shared client BEFORE the painter spawns when the node comes back', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.backgroundWrite('node-1', 'ls\n')
    liveTmuxSessions.add(sessionName('node-1')) // tmux kept it running, as it does across a detach
    log.length = 0

    await create(ALICE, 'node-1')

    // Same rule as a per-session shadow: exactly one client of ours is ever negotiating the pane.
    expect(log).toEqual(['control-kill', 'pty-spawn'])
    expect(control.only.writes).toContain('detach-client\n')
  })

  it('yields to a shadow of the session it is attached to — one client of ours per session', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.backgroundWrite('node-1', 'ls\n')

    await m.shadowAttach('node-1')

    // Two of our clients on one session would break the session budget's "subtract one" arithmetic
    // and put two grids on one pane. The shared client is the one that goes: it is re-startable
    // anywhere, the shadow is not.
    expect(control.only.killed).toBe(1)
    expect(m.shadowedTmuxSessions(TMUX_SOCKET)).toEqual([sessionName('node-1')])
  })

  it('app quit disposes the shared client', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.backgroundWrite('node-1', 'ls\n')

    await m.killAll()

    expect(control.only.killed).toBe(1)
    expect(control.only.writes).toContain('detach-client\n')
  })

  it('is subtracted from the session budget, exactly like a shadow', async () => {
    // A shared client is a real tmux client on whatever session it attached to, so it flips that
    // session's `#{session_attached}` — and an attached session is never culled. Without the
    // subtraction, one background write would exempt a session from the memory-pressure valve for
    // as long as the client lingered.
    const { createSessionReaper } = await import('./session-budget')
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.backgroundWrite('node-1', 'ls\n')

    const NOW = 1_000_000
    const OLD = NOW - 100_000 // well past the 6h grace window
    const killed: Array<{ socket: string; target: string }> = []
    const reaper = createSessionReaper({
      tmuxBin: () => m.getTmuxBin(),
      sockets: [TMUX_SOCKET],
      shadowed: (socket) => m.shadowedTmuxSessions(socket),
      exec: async (_bin: string, args: string[]) => {
        if (args.includes('kill-session')) {
          killed.push({
            socket: args[args.indexOf('-L') + 1],
            target: args[args.indexOf('-t') + 1]
          })
          return ''
        }
        // `nt-node-1` reads as attached because our shared client IS one; `nt-node-9` is genuinely
        // attached (somebody is looking at it) and must survive.
        return `nt-node-1|1|${OLD}\nnt-node-9|1|${OLD}`
      },
      readMem: () => ({ availableMb: 100, totalMb: 8000 }), // under the watermark: real pressure
      env: {},
      nowSec: () => NOW
    })

    expect(await reaper.sweep()).toBe(1)
    expect(killed).toEqual([{ socket: TMUX_SOCKET, target: '=nt-node-1' }])
  })

  it('does nothing with tmux switched off in settings', async () => {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ controlSpawn: control })
    m.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: false }))
    m.registerIpc()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    // The binary is right there, so `tmuxPath` alone would say yes — but nothing spawned a tmux
    // session, so the keys would go to a name that does not exist.
    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(false)
    expect(control.calls).toHaveLength(0)
  })

  it('refuses the control-client tiers with ptyShadowClients switched off', async () => {
    const m = await managerWith({ ptyShadowClients: false })
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    // The kill switch means what it says: with it off, this process never spawns a `tmux -C` child,
    // so a released node is simply unreachable again — the behavior of the release this mechanism
    // shipped in.
    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(false)
    expect(control.calls).toHaveLength(0)
  })

  it('still writes into the painter with ptyShadowClients switched off — tier 1 is not a shadow', async () => {
    const m = await managerWith({ ptyShadowClients: false })
    await create(ALICE, 'node-1')

    // Tier 1 is the session's own pty, which exists with or without this feature. Gating it would
    // turn the kill switch into "background writes stop working", which is a different setting.
    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(true)
    expect(spawned[0].writes).toEqual(['ls\n'])
    expect(control.calls).toHaveLength(0)
  })

  it('falls through to the shared client when the node’s shadow is dead but still indexed', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    const shadow = await m.shadowAttach('node-1')
    // A holder retiring the client it was handed. `dispose()` is SILENT by design (it fires no
    // `onExit`), so nothing evicted the map entry — the shadow is dead and still indexed.
    shadow?.dispose()

    expect(await m.backgroundWrite('node-1', 'ls\n')).toBe(true)

    // Tier 2 asks whether the shadow is ALIVE, not whether an entry exists. And falling through is
    // safe for exactly the reason the never-retry rule needs: a client that is not running rejects
    // `command()` BEFORE writing a byte (tmux-control-client.ts), so no send-keys can have reached
    // tmux twice.
    expect(control.calls).toHaveLength(2)
    expect(control.children[1].writes).toContain(LS_KEYS('nt-node-1'))
    expect(control.children[0].writes).not.toContain(LS_KEYS('nt-node-1'))
  })

  it('clears the linger when the shared client dies mid-command', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    const before = vi.getTimerCount()

    const writing = m.backgroundWrite('node-1', 'ls\n') // arms the linger
    control.only.exit(1) // …and the client dies under it: its own onExit clears `shared`

    expect(await writing).toBe(false)
    // With nothing attached, the linger is a timer armed for a client that no longer exists — and
    // the dispose it will run is aimed at whatever IS attached when it fires. It goes with the
    // client, whether or not there was still an entry to dispose.
    expect(vi.getTimerCount()).toBe(before)
  })

  it('logs the shared client’s attach with the same line a shadow logs', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const m = await tmuxManager()
    await release(ALICE, 'node-1')

    await m.backgroundWrite('node-1', 'ls\n')
    await m.backgroundWrite('node-1', 'ls\n') // served by the SAME client — so no second line

    // From the outside the shared client and a per-session shadow are the same event: a control
    // client of ours became that session's attached client. Somebody reading `list-clients` after a
    // field report should not have to know which of the two kinds they are looking at.
    expect(lines.filter((l) => l === `[pty] shadow attach ${sessionName('node-1')}`)).toHaveLength(1)
  })

  it('a relay-served session is never reaped, so a phone’s keystrokes reach its painter', async () => {
    // The relay host holds `stream.sessionId` for the lifetime of a stream and calls
    // `pty.write(clientId, stream.sessionId, …)` directly (host-service.ts), BYPASSING the
    // `subscribes()` gate the renderer's `pty:write` goes through — so it genuinely can reach
    // `write()`'s miss path. What it cannot reach is a RELEASED record: a relay sink counts as a
    // watcher (`reapTick`), and `kill()` only releases once that sink is gone — by which time the
    // host has dropped the stream and `onFrame` no longer routes input for it. This pins the
    // reasoning that "the mechanism has no production caller" rests on; if a future change stops
    // the sink counting as a watcher, this test is the one that says so.
    const { REAP_IDLE_MS, REAP_SWEEP_MS } = await import('./pty-reap')
    const m = await tmuxManager()
    const sessionId = m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })

    vi.advanceTimersByTime(REAP_IDLE_MS + REAP_SWEEP_MS * 3)
    m.write(null, sessionId, 'ls\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(spawned[0].killed).toBe(false) // the sweep left the phone's pty alone…
    expect(spawned[0].writes).toEqual(['ls\n']) // …and tier 1 answered the write
    expect(control.calls).toHaveLength(0) // no control client was needed, or started
  })

  it('destroying a node disposes the shared client attached to its session', async () => {
    const m = await tmuxManager()
    await release(ALICE, 'node-1')
    await m.backgroundWrite('node-1', 'ls\n')

    await m.destroySession(ALICE, 'node-1')

    // The tmux session is about to be killed: a client of ours attached to it would linger until
    // tmux dropped it, and would meanwhile be subtracted from the session budget for a name that no
    // longer exists.
    expect(control.only.killed).toBe(1)
    expect(m.shadowedTmuxSessions(TMUX_SOCKET)).toEqual([])
  })
})

describe('isSessionName', () => {
  // `encodeSendKeysHex` interpolates the target UNQUOTED into the command line, so anything that is
  // not a name this app generated is refused before it is interpolated (Task 2 handoff note 12).
  it('accepts the names sessionName generates', () => {
    expect(isSessionName(sessionName('node-1'))).toBe(true)
    expect(isSessionName(sessionName('Node_9-x'))).toBe(true)
  })
  it('rejects a name this app did not generate', () => {
    expect(isSessionName('scratch')).toBe(false) // no nt- prefix: somebody else's session
    expect(isSessionName('nt-')).toBe(false) // the empty node id
    expect(isSessionName('nt-a b')).toBe(false) // a space splits the command line
    expect(isSessionName('nt-a;kill-server')).toBe(false)
    expect(isSessionName('nt-a\nkill-server')).toBe(false)
  })
})

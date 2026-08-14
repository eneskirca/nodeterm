import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { encodeArgs, parseRpcMessage } from '../shared/rpc'

/** One fake pty per spawn, recorded so a test can assert "exactly one spawn" and push output. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  paused: boolean
  killed: boolean
}
const spawned: FakePty[] = []
/** When set, the NEXT pty.spawn throws (simulates posix_spawn failing). */
let failNextSpawn = false

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], _opts: unknown) => {
    if (failNextSpawn) {
      failNextSpawn = false
      throw new Error('posix_spawnp failed.')
    }
    const p: FakePty = { writes: [], resizes: [], paused: false, killed: false }
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
      pause: () => {
        p.paused = true
      },
      resume: () => {
        p.paused = false
      },
      kill: () => {
        p.killed = true
      },
      pid: 1234
    }
  }
}))

const ALICE = 1
const BOB = 2
const CAROL = 3

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

describe('terminal co-attach: one PTY, N subscribers', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, cols = 80, rows = 24, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
      closed?: { by: number | null }
    }>
  // pty:kill is sender-aware (it unsubscribes ONE client), so it lands in senderListeners.
  const kill = (clientId: number, sessionId: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId)
  // pty:flow is sender-aware too: a pause is OWED by the client whose xterm backlog overflowed,
  // so it can only be returned by that client (or by its departure).
  const flow = (clientId: number, sessionId: string, resume: boolean) =>
    fake.senderListeners[IPC.ptyFlow](clientId, sessionId, resume)
  // pty:write is sender-aware as well: with one pty and N subscribers, a keystroke has to carry WHO
  // typed it — that is what badges the node as "X is typing" (see pty-typing.test.ts).
  const write = (clientId: number, sessionId: string, data: string) =>
    fake.senderListeners[IPC.ptyWrite](clientId, sessionId, data)
  // pty:resize is sender-aware: the pty runs at the smallest SUBSCRIBER's grid.
  const resize = (clientId: number, sessionId: string, cols: number | null, rows: number | null) =>
    fake.senderListeners[IPC.ptyResize](clientId, sessionId, cols, rows)

  it('a second client on the same persistKey subscribes instead of spawning', async () => {
    await manager()
    const a = await create(ALICE)
    const b = await create(BOB)

    expect(spawned).toHaveLength(1) // ONE pty, ONE tmux client
    expect(b.sessionId).toBe(a.sessionId)
    expect(a.fresh).toBe(true) // Alice created it
    expect(b.fresh).toBe(false) // Bob joined a live session — no cold-restore replay
  })

  it('output fans out to every subscriber', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    spawned[0].onDataCb?.('hello')
    vi.advanceTimersByTime(20) // FLUSH_MS coalescing window

    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to).sort()).toEqual([ALICE, BOB])
    expect(data.every((s) => s.args[0] === 'hello')).toBe(true)
  })

  it('exit fans out to every subscriber and clears the persistKey index', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    spawned[0].onExitCb?.({ exitCode: 7 })
    const exits = fake.sent.filter((s) => s.channel === IPC.ptyExit(sessionId))
    expect(exits.map((s) => s.to).sort()).toEqual([ALICE, BOB])
    expect(exits.every((s) => s.args[0] === 7)).toBe(true)

    // The session is gone, so a fresh create must spawn again (not hand out a dead sessionId).
    await create(ALICE)
    expect(spawned).toHaveLength(2)
  })

  it('kill unsubscribes ONE client; the pty survives while others watch', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    kill(ALICE, sessionId) // Alice closes her tab
    fake.sent.length = 0
    spawned[0].onDataCb?.('still here')
    vi.advanceTimersByTime(20)

    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to)).toEqual([BOB]) // Bob still gets output
    expect(spawned[0].killed).toBe(false) // pty untouched

    // Bob leaves too → last subscriber out releases the pty.
    kill(BOB, sessionId)
    expect(spawned[0].killed).toBe(true)
  })

  it('the last subscriber leaving un-indexes the node, so the next create spawns', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    const again = await create(ALICE)
    expect(spawned).toHaveLength(2)
    expect(again.sessionId).not.toBe(sessionId)
  })

  it('writes from any subscriber reach the one pty (no locking — they interleave)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    write(ALICE, sessionId, 'a')
    write(BOB, sessionId, 'b')
    expect(spawned[0].writes).toEqual(['a', 'b'])
  })

  it('a destroyed node is never co-attached to, and never respawned (the × path un-indexes + tombstones it)', async () => {
    const m = await manager()
    await create(ALICE)
    await m.destroySession(ALICE, 'node-1') // user clicked ×: the tmux session is gone for good

    const second = await create(BOB)
    expect(second.sessionId).toBe('') // neither the dead session…
    expect(second.closed).toEqual({ by: ALICE }) // …nor a fresh one: the node is gone
    expect(spawned).toHaveLength(1)
  })

  it('a relay-served (detached) pty is NOT indexed: it keeps its own session', async () => {
    const m = await manager()
    const chunks: string[] = []
    const detachedId = m.attachDetached('node-1', {
      onData: (d) => chunks.push(d),
      onExit: () => {}
    })
    // The host's detached pty must not be handed to a UI client asking for the same node.
    const ui = await create(ALICE)
    expect(ui.sessionId).not.toBe(detachedId)
    expect(spawned).toHaveLength(2)

    // The detached sink still receives its own session's output (relay path unchanged).
    spawned[0].onDataCb?.('host output')
    vi.advanceTimersByTime(20)
    expect(chunks).toEqual(['host output'])
  })

  it('the relay releases its detached pty via kill(null, …) even with no subscribers', async () => {
    const m = await manager()
    const id = m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })
    m.kill(null, id)
    expect(spawned[0].killed).toBe(true)
  })

  // ── Flow control is OWED PER CLIENT (`pausedBy`) ─────────────────────────────────────────
  // Two invariants, and a single `paused` boolean per session can only ever satisfy one of them:
  //  (a) a pause owed by a client that LEFT is always returned  → nobody is frozen forever;
  //  (b) a pause owed by a client that is STILL HERE is never silently cancelled → its renderer's
  //      write queue cannot grow without bound (its flow control is EDGE-latched: once it has
  //      pumped `setFlow(false)` it will not re-pause, so a resume behind its back is permanent).
  it('a solo client pauses and resumes its own pty (single-user path unchanged)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)

    flow(ALICE, sessionId, false)
    expect(spawned[0].paused).toBe(true)
    flow(ALICE, sessionId, true)
    expect(spawned[0].paused).toBe(false)
  })

  it('a client joining a session PAUSED by a client that left resumes the pty', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    flow(ALICE, sessionId, false) // Alice's xterm backlog crossed the high water mark
    expect(spawned[0].paused).toBe(true)

    // Alice's tab is gone; her renderer reloads (same client id) and re-creates the node. Her new
    // page has an empty backlog, so it will never send the resume her old page owed us.
    const again = await create(ALICE)
    expect(again.sessionId).toBe(sessionId)
    expect(spawned[0].paused).toBe(false)
  })

  it('a departing client cannot leave the pty paused for the subscribers that stay', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)
    expect(spawned[0].paused).toBe(true)

    kill(ALICE, sessionId) // the client that paused it leaves
    expect(spawned[0].paused).toBe(false) // Bob's terminal keeps streaming
  })

  it('a DIFFERENT client joining does NOT cancel a pause the drowning client still owes', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    flow(ALICE, sessionId, false) // Alice is 1 MB behind a `yes`-grade flood
    expect(spawned[0].paused).toBe(true)

    await create(BOB) // Bob opens the same node — Alice is still drowning
    expect(spawned[0].paused).toBe(true) // resuming here would grow Alice's queue without bound

    flow(ALICE, sessionId, true) // Alice drains → the last owed resume lands
    expect(spawned[0].paused).toBe(false)
  })

  it('a DIFFERENT client leaving does NOT cancel a pause the drowning client still owes', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)

    kill(BOB, sessionId) // Bob closes his tab; Alice is still behind
    expect(spawned[0].paused).toBe(true)
    expect(spawned[0].killed).toBe(false)
  })

  it('the pty resumes only when the LAST owed resume lands', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)
    flow(BOB, sessionId, false)
    expect(spawned[0].paused).toBe(true)

    flow(ALICE, sessionId, true)
    expect(spawned[0].paused).toBe(true) // Bob is still behind
    flow(BOB, sessionId, true)
    expect(spawned[0].paused).toBe(false)
  })

  // ── One client, TWO pause owners (Server Edition) ────────────────────────────────────────
  // On the Server Edition a single uiId has two INDEPENDENT reasons to pause the same session:
  // its browser's own xterm backlog (`pty:flow` cast → owner 'renderer') and the server's WS
  // send-buffer backpressure (ServerPlatform → owner 'socket'). They drain at different times
  // (the socket empties as fast as the browser reads bytes; xterm parses them far slower), so a
  // ledger keyed by ClientId alone would let one hand back the other's pause — and the renderer's
  // flow control is EDGE-latched, so a resume behind its back is permanent (invariant (b)).
  it('a socket drain does NOT release the pause that client\'s RENDERER still owes', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)

    flow(ALICE, sessionId, false) // Alice's xterm is 1 MB behind the flood
    m.setFlow(ALICE, sessionId, false, 'socket') // ...and her WS socket is backed up too
    expect(spawned[0].paused).toBe(true)

    m.setFlow(ALICE, sessionId, true, 'socket') // the socket drains into her browser
    expect(spawned[0].paused).toBe(true) // her xterm is STILL drowning — must stay paused

    flow(ALICE, sessionId, true) // her renderer finally drains
    expect(spawned[0].paused).toBe(false)
  })

  it('a socket-owed pause IS released when only the socket owed it', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)

    m.setFlow(ALICE, sessionId, false, 'socket') // her renderer never paused (slow link, small xterm backlog)
    expect(spawned[0].paused).toBe(true)

    m.setFlow(ALICE, sessionId, true, 'socket')
    expect(spawned[0].paused).toBe(false)
  })

  it('a renderer resume does NOT release the pause that client\'s SOCKET still owes', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)

    m.setFlow(ALICE, sessionId, false, 'socket')
    flow(ALICE, sessionId, true) // a stray/late renderer resume — the socket is still jammed
    expect(spawned[0].paused).toBe(true)
  })

  it('a client that disconnects owing BOTH kinds of pause returns both', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB) // Bob stays: the pty must keep streaming for him

    flow(ALICE, sessionId, false)
    m.setFlow(ALICE, sessionId, false, 'socket')
    expect(spawned[0].paused).toBe(true)

    m.dropClient(ALICE) // her tab vanished — neither pause can ever be returned by her
    expect(spawned[0].paused).toBe(false) // invariant (a): nobody is frozen forever
    expect(spawned[0].killed).toBe(false)
  })

  it('a client that KILLS a session while owing BOTH kinds of pause returns both', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    flow(ALICE, sessionId, false)
    m.setFlow(ALICE, sessionId, false, 'socket')
    kill(ALICE, sessionId) // Alice unmounts the node; she gets no more output for it
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].killed).toBe(false)
  })

  it('one client\'s socket drain leaves ANOTHER client\'s socket pause in place', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    m.setFlow(ALICE, sessionId, false, 'socket')
    m.setFlow(BOB, sessionId, false, 'socket')
    m.setFlow(ALICE, sessionId, true, 'socket')
    expect(spawned[0].paused).toBe(true) // Bob's socket is still jammed
    m.setFlow(BOB, sessionId, true, 'socket')
    expect(spawned[0].paused).toBe(false)
  })

  // ── Finding 2: a client that vanishes (WS close / destroyed webContents) is dropped ──────
  it('dropClient unsubscribes the client from EVERY session and releases the empty ones', async () => {
    const m = await manager()
    const shared = await create(ALICE, 80, 24, 'node-1')
    await create(BOB, 80, 24, 'node-1')
    const solo = await create(ALICE, 80, 24, 'node-2')

    m.dropClient(ALICE) // Alice's browser tab closed — no pty:kill ever arrives

    // node-1 still has Bob: the pty survives and keeps fanning out to him only.
    fake.sent.length = 0
    spawned[0].onDataCb?.('still here')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(shared.sessionId))
    expect(data.map((s) => s.to)).toEqual([BOB])
    expect(spawned[0].killed).toBe(false)

    // node-2 fell to zero subscribers: the pty client is released (the tmux session survives).
    expect(spawned[1].killed).toBe(true)
    const again = await create(BOB, 80, 24, 'node-2')
    expect(again.sessionId).not.toBe(solo.sessionId)
    expect(spawned).toHaveLength(3)
  })

  it('dropClient resumes a session the vanished client had paused', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)

    m.dropClient(ALICE)
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].killed).toBe(false)
  })

  it('dropClient leaves a pause another (still present) client owes in place', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)

    m.dropClient(BOB) // Bob's tab vanished; Alice is still drowning
    expect(spawned[0].paused).toBe(true)
  })

  it('dropClient leaves a relay-served (detached) pty alone', async () => {
    const m = await manager()
    const id = m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })
    m.dropClient(ALICE)
    expect(spawned[0].killed).toBe(false)
    m.kill(null, id)
    expect(spawned[0].killed).toBe(true)
  })

  // ── Only a SUBSCRIBER may steer a shared session ─────────────────────────────────────────
  // Session ids are sequential and guessable (`pty-1`, `pty-2`, …) and every one of these casts
  // takes the id straight off the wire. Without a membership check, any authenticated client could
  // pause, clamp or type into a terminal it never opened — and since `dropClient` only ever swept
  // sessions the client was subscribed to, the pause/size it planted would outlive its tab and
  // freeze (or pin at 1x1) the shared pty for every real viewer, permanently.
  it('a non-subscriber cannot pause the shared pty', async () => {
    await manager()
    const { sessionId } = await create(ALICE)

    flow(BOB, sessionId, false) // Bob never opened this node
    expect(spawned[0].paused).toBe(false)
  })

  it('a non-subscriber cannot clamp the shared grid', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0

    resize(BOB, sessionId, 1, 1)
    expect(spawned[0].resizes).toEqual([]) // Alice's terminal keeps its size
    expect(fake.sent.filter((s) => s.channel === IPC.ptySize(sessionId))).toEqual([])
  })

  it('a non-subscriber cannot type into the shared pty', async () => {
    await manager()
    const { sessionId } = await create(ALICE)

    write(BOB, sessionId, 'rm -rf /\n')
    expect(spawned[0].writes).toEqual([])
  })

  it('a client that unsubscribed cannot keep steering the session it left', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    kill(BOB, sessionId)

    flow(BOB, sessionId, false)
    write(BOB, sessionId, 'x')
    resize(BOB, sessionId, 1, 1)
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].writes).toEqual([])
    expect(spawned[0].resizes).toEqual([])
  })

  // Belt and braces for the invariant the check above establishes: NOTHING a client left behind may
  // outlive it. dropClient sweeps every session, not just the ones it subscribes to, so even a
  // pause/size planted by some other (internal) path is returned when the client goes away.
  it('dropClient sweeps a pause the client owes on a session it never subscribed to', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    m.setFlow(BOB, sessionId, false) // planted through the internal API, not the wire
    expect(spawned[0].paused).toBe(true)

    m.dropClient(BOB)
    expect(spawned[0].paused).toBe(false) // Alice's terminal is not frozen forever
  })

  it('dropClient sweeps a size the client owes on a session it never subscribed to', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    m.resize(BOB, sessionId, 1, 1)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 1, rows: 1 })

    m.dropClient(BOB)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 24 }) // back to the real viewer
  })

  // ── Finding 3: the same-tick create race ────────────────────────────────────────────────
  // create() awaits a `tmux has-session` subprocess + the shell-PATH probe between the index
  // lookup and spawnSession's synchronous registration, so two clients opening the same node
  // in that window both used to spawn — and the second `tmux -A -D` kicked the first viewer off.
  it('two overlapping creates for the same node resolve to ONE spawn', async () => {
    await manager()
    const [a, b] = await Promise.all([create(ALICE), create(BOB)])

    expect(spawned).toHaveLength(1)
    expect(b.sessionId).toBe(a.sessionId)
    expect(a.fresh).toBe(true) // Alice's call did the spawn
    expect(b.fresh).toBe(false) // Bob joined it — no cold-restore replay
  })

  it('a failed spawn clears the in-flight entry, so the node stays openable', async () => {
    await manager()
    failNextSpawn = true
    await expect(create(ALICE)).rejects.toThrow(/Failed to spawn terminal/)

    const ok = await create(ALICE)
    expect(ok.sessionId).toBeTruthy()
    expect(spawned).toHaveLength(1)
  })

  it('a create racing a failed spawn still gets a live session', async () => {
    await manager()
    failNextSpawn = true
    const [a, b] = await Promise.allSettled([create(ALICE), create(BOB)])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('fulfilled')
    expect(spawned).toHaveLength(1) // Bob's create spawned after the failure cleared the entry
  })

  // TWO racers behind ONE failed spawn: the first survivor re-spawns, and the second must see
  // THAT spawn in `inflight` (the entry it awaited is long gone) instead of spawning again — a
  // second `tmux -A -D` would detach the first survivor's client, which is the very race the
  // in-flight guard exists to prevent.
  it('two creates racing a failed spawn resolve to ONE session, not two', async () => {
    await manager()
    failNextSpawn = true
    const [a, b, c] = await Promise.allSettled([create(ALICE), create(BOB), create(CAROL)])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('fulfilled')
    expect(c.status).toBe('fulfilled')
    expect(spawned).toHaveLength(1)
    const bId = b.status === 'fulfilled' ? b.value.sessionId : 'b'
    const cId = c.status === 'fulfilled' ? c.value.sessionId : 'c'
    expect(cId).toBe(bId)
  })
})

describe('size negotiation: smallest subscriber wins', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, cols: number, rows: number, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  // pty:resize is sender-aware now (a size must be attributed to the client that reported it).
  const resize = (
    clientId: number,
    sessionId: string,
    cols: number | null,
    rows: number | null
  ) => fake.senderListeners[IPC.ptyResize](clientId, sessionId, cols, rows)
  const kill = (clientId: number, sessionId: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId)
  const sizes = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptySize(sessionId))

  it('runs the pty at min(cols) x min(rows) and broadcasts it to every subscriber', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 120, 40)
    fake.sent.length = 0
    await create(BOB, 80, 60) // narrower but taller

    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 40 })
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to).sort()).toEqual([ALICE, BOB])
    expect(sent.every((s) => s.args[0].cols === 80 && s.args[0].rows === 40)).toBe(true)
  })

  it('a joiner bigger than the pty is told the authoritative size (nothing is resized)', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0
    await create(BOB, 120, 40)

    // The pty already runs at 80x24 (Alice spawned it there) — do not make tmux redraw for nothing.
    expect(spawned[0].resizes).toEqual([])
    // Bob's xterm fitted itself to 120x40, so he MUST be told to render 80x24 and letterbox.
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to)).toEqual([BOB]) // Alice already renders 80x24 — no message for her
    expect(sent[0].args[0]).toEqual({ cols: 80, rows: 24 })
  })

  it('a subscriber growing its window does not grow the pty past the smaller peer', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)
    fake.sent.length = 0
    resize(BOB, sessionId, 200, 80) // Bob maximizes

    expect(spawned[0].resizes.every((r) => r.cols <= 80 && r.rows <= 24)).toBe(true)
    // Bob's own fit is not authoritative: he is told (again) to render Alice's size.
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to)).toEqual([BOB])
    expect(sent[0].args[0]).toEqual({ cols: 80, rows: 24 })
  })

  it('when the smallest subscriber leaves, the pty grows back to the remaining one', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)

    fake.sent.length = 0
    kill(ALICE, sessionId)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 })
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to)).toEqual([BOB])
    expect(sent[0].args[0]).toEqual({ cols: 120, rows: 40 })
  })

  // ── The single-user path must stay bit-for-bit identical ─────────────────────────────────
  it('a solo subscriber resizes the pty to its own size, with no pty:size traffic at all', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0

    resize(ALICE, sessionId, 100, 30)
    expect(spawned[0].resizes).toEqual([{ cols: 100, rows: 30 }]) // min(one) is Alice's own size
    // Alice already renders what she asked for: telling her would be pure round-trip noise.
    expect(sizes(sessionId)).toEqual([])

    // Same fit reported twice (a ResizeObserver tick that changed nothing) → no second ioctl.
    resize(ALICE, sessionId, 100, 30)
    expect(spawned[0].resizes).toHaveLength(1)
  })

  // ── A PARKED terminal is subscribed but not looking ──────────────────────────────────────
  // The renderer keeps a node's xterm+PTY alive for 5 minutes after unmount (TERM_PARK_MS), so a
  // parked client stays a subscriber. Its (possibly tiny) last fit must NOT shrink the terminal
  // for the people still watching — it reports a null size instead: "listening, not viewing".
  it('a parked subscriber (null size) stops constraining the shared pty but keeps its output', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)
    fake.sent.length = 0

    resize(ALICE, sessionId, null, null) // Alice's node unmounted → parked
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 }) // Bob gets his full size back
    expect(sizes(sessionId).map((s) => s.to).sort()).toEqual([ALICE, BOB])

    // Parked ≠ gone: the parked xterm keeps consuming output (that is what makes re-adoption exact).
    fake.sent.length = 0
    spawned[0].onDataCb?.('still streaming')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to).sort()).toEqual([ALICE, BOB])

    // Un-parking (re-adopt → fresh fit) makes her constrain again.
    resize(ALICE, sessionId, 80, 24)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 24 })
  })

  it('a parked SOLO subscriber leaves the pty size alone (nobody is left to size it)', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0

    resize(ALICE, sessionId, null, null)
    expect(spawned[0].resizes).toEqual([]) // no viewers → keep the last size, never resize to 1x1
    expect(sizes(sessionId)).toEqual([])
  })

  // In the Server Edition the park signal does not arrive as a function call: the browser
  // JSON-serialises it, the server parses it with `parseRpcMessage` and dispatches it into THIS
  // handler. A decoder that rewrote every top-level `null` to `undefined` made the strict park
  // check miss, so `normalizeSize(undefined, undefined)` clamped to {1,1}: the parked client stayed
  // in the ledger claiming a 1×1 grid, and the min over subscribers collapsed the shared pty (and
  // its tmux pane) to 1 column × 1 row for EVERY co-attached viewer — permanently, because a parked
  // client never re-reports. So the wire itself is part of the contract.
  it('parks (never 1x1) when the park signal comes over the WS-RPC wire', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)

    const frame = JSON.stringify({
      t: 'cast',
      method: IPC.ptyResize,
      ...encodeArgs([sessionId, null, null])
    })
    const m = parseRpcMessage(frame) as { method: string; args: unknown[] }
    expect(m.args).toEqual([sessionId, null, null]) // the nulls MEAN something — they survive
    fake.senderListeners[m.method](ALICE, ...m.args)

    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 }) // Bob's own size, not 1×1
    expect(spawned[0].resizes.some((r) => r.cols === 1 || r.rows === 1)).toBe(false)
  })

  // Belt and braces: should any future encoding path lose the `null` again, the park check is loose
  // (`== null`), so an `undefined` size degrades to PARK — the safe direction — instead of 1×1.
  it('treats an undefined size as park, not as a 1x1 grid', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)

    m.resize(ALICE, sessionId, undefined as unknown as null, undefined as unknown as null)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 })
    expect(spawned[0].resizes.some((r) => r.cols === 1 || r.rows === 1)).toBe(false)
  })
})

// ── A node DELETED while somebody else is watching it ─────────────────────────────────────────
// The × button means "this terminal is gone for good" (tmux kill-session). With co-attach the
// node may have other viewers, and the one thing they must NOT do is quietly reopen it: a respawn
// would resurrect a session its owner deliberately destroyed — in a fresh shell, with none of the
// state, and leaving a stray tmux session behind. They are told WHO closed it instead, and land in
// a closed state (the renderer paints "closed by <name>" from the presence table — Tasks 9-10).
describe('node destroyed while co-viewed', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols: 80, rows: 24, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
      closed?: { by: number | null }
    }>
  // pty:destroy is sender-aware: the closed event has to name WHO pressed ×.
  const destroy = (clientId: number, persistKey = 'node-1') =>
    fake.senderListeners[IPC.ptyDestroy](clientId, persistKey) as unknown as Promise<void>
  const flow = (clientId: number, sessionId: string, resume: boolean) =>
    fake.senderListeners[IPC.ptyFlow](clientId, sessionId, resume)
  const closed = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptyClosed(sessionId))

  it('tells the OTHER subscribers who closed it, and does not respawn', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await destroy(ALICE) // Alice hits the × on the node

    expect(closed(sessionId).map((s) => s.to)).toEqual([BOB]) // the closer does not need telling
    expect(closed(sessionId)[0].args[0]).toEqual({ by: ALICE })
    expect(spawned[0].killed).toBe(true) // the pty client is released with the session
    expect(spawned).toHaveLength(1) // …and nothing respawned it
  })

  // The `pty:closed` event only reaches SUBSCRIBERS. A co-viewer whose project is inactive/closed
  // has no mounted terminal, is not subscribed, and hears nothing — its canvas still has the node,
  // so opening that project later would `create` it and RESURRECT a terminal its owner deliberately
  // deleted, in a fresh shell. The tombstone is what makes that create refuse instead of spawn.
  it('a create by ANOTHER client after the destroy is refused — it never resurrects the node', async () => {
    await manager()
    await create(ALICE)
    await create(BOB)
    await destroy(ALICE)

    const again = await create(BOB)
    expect(again.closed).toEqual({ by: ALICE }) // "closed by Alice", not a brand-new shell
    expect(again.sessionId).toBe('')
    expect(spawned).toHaveLength(1) // …and nothing was spawned
  })

  it('a create by a client that never saw the destroy is refused too (unsubscribed co-viewer)', async () => {
    await manager()
    await create(ALICE)
    await destroy(ALICE) // Carol was not watching — she got no pty:closed

    const carol = await create(CAROL)
    expect(carol.closed).toEqual({ by: ALICE })
    expect(spawned).toHaveLength(1)
  })

  it('the client that DELETED the node may still respawn it (undo) — and that clears the tombstone', async () => {
    await manager()
    await create(ALICE)
    await destroy(ALICE)

    // ⌘Z restores the node on Alice's canvas: her own re-create must spawn, exactly as it always
    // did (the single-user delete→undo path is untouched by the tombstone).
    const undone = await create(ALICE)
    expect(undone.closed).toBeUndefined()
    expect(undone.fresh).toBe(true)
    expect(spawned).toHaveLength(2)
    // The node is alive again, so a co-viewer must be able to join it rather than stay tombstoned.
    const bob = await create(BOB)
    expect(bob.sessionId).toBe(undone.sessionId)
  })

  it('a RECYCLE (worktree move) leaves no tombstone — the node is not deleted', async () => {
    await manager()
    await create(ALICE)
    await create(BOB)
    await (fake.senderListeners[IPC.ptyRecycle](ALICE, 'node-1') as unknown as Promise<void>)

    const again = await create(ALICE) // the mover respawns in the new cwd
    expect(again.closed).toBeUndefined()
    const bob = await create(BOB) // and the co-viewer joins it
    expect(bob.sessionId).toBe(again.sessionId)
    expect(spawned).toHaveLength(2)
  })

  it('the destroyed session stops fanning out: no data, and no exit after the close', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    await destroy(ALICE)

    fake.sent.length = 0
    spawned[0].onDataCb?.('ghost output') // the pty client is being torn down
    vi.advanceTimersByTime(20)
    spawned[0].onExitCb?.({ exitCode: 1 }) // …and its exit lands after the close event
    expect(fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))).toEqual([])
    // "[process exited with code 1]" on top of "closed by Alice" would be noise at best: the
    // subscribers were told the truth already, and the session is off the books.
    expect(fake.sent.filter((s) => s.channel === IPC.ptyExit(sessionId))).toEqual([])
  })

  it('releases a session a subscriber had PAUSED (a dying pty must not keep its fd)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(BOB, sessionId, false) // Bob's xterm is drowning — the pty is paused for everyone
    expect(spawned[0].paused).toBe(true)

    await destroy(ALICE)
    // releasePty resumes before destroying: a paused pty never reads EOF, so it would otherwise
    // leak its master fd (see pty-release.ts). Bob owes a resume that will never come — the
    // session is gone, so the ledger goes with it.
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].killed).toBe(true)
    expect(closed(sessionId).map((s) => s.to)).toEqual([BOB])
  })

  it('a destroy with no live session still tells nobody and kills the tmux session', async () => {
    await manager()
    // Nothing was ever created for node-9 in this process (e.g. it is only running in tmux).
    await destroy(ALICE, 'node-9')
    expect(fake.sent).toEqual([])
    expect(spawned).toHaveLength(0)
  })
})

// ── The destroy path takes a node id straight off the wire ────────────────────────────────────
// `endSession('delete')` records a tombstone EVEN WHEN NO LIVE SESSION EXISTS, keyed by a string
// the client chose, in a map nothing ever prunes — and it runs an fs.rm + a `tmux kill-session`
// subprocess per call, on channels that (unlike the presence casts) had no rate limit at all.
describe('destroy/recycle: bounded, validated, rate-limited', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, persistKey: string) =>
    fake.handlers[IPC.ptyCreate](clientId, { cols: 80, rows: 24, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
      closed?: { by: number | null }
    }>
  const destroy = (clientId: number, persistKey: string) =>
    fake.senderListeners[IPC.ptyDestroy](clientId, persistKey) as unknown as Promise<void>

  it('refuses a persistKey longer than REF_MAX_LEN (no tombstone, no subprocess)', async () => {
    const { REF_MAX_LEN } = await import('../shared/presence')
    const m = await manager()
    const huge = 'x'.repeat(REF_MAX_LEN + 1)

    await destroy(ALICE, huge)
    // Nothing was recorded, so this is not a node anyone can be locked out of. Read the map
    // DIRECTLY rather than probing with `create`: an over-long id is now refused at the create
    // choke point too (the node-id guard, added with the remote-injection fix), so a create's
    // outcome no longer distinguishes "no tombstone" from "refused for another reason".
    expect((m as unknown as { tombstones: Map<string, unknown> }).tombstones.size).toBe(0)
    // And the second layer, on the same value: it can never be spent on a spawn either.
    await expect(create(BOB, huge)).rejects.toThrow(/node id/i)
  })

  it('bounds the tombstone map: the oldest entries are evicted, the newest still refuse', async () => {
    const { TOMBSTONE_MAX } = await import('./pty-manager')
    const m = await manager()
    // Straight through the internal API: the bound must hold on its own, not because the rate limit
    // happens to run out first (the two are independent defences and their numbers may diverge).
    for (let i = 0; i < TOMBSTONE_MAX + 1; i++) await m.destroySession(ALICE, `node-${i}`)

    // The first delete has been evicted — the map is bounded, it cannot grow with client input.
    const evicted = await create(BOB, 'node-0')
    expect(evicted.closed).toBeUndefined()
    // …and the guard still does its job for everything still in it.
    const kept = await create(BOB, `node-${TOMBSTONE_MAX}`)
    expect(kept.closed).toEqual({ by: ALICE })
  })

  it('expires a tombstone after its TTL (the map cannot hold entries for the life of the core)', async () => {
    const { TOMBSTONE_TTL_MS } = await import('./pty-manager')
    await manager()
    await create(ALICE, 'node-1')
    await destroy(ALICE, 'node-1')
    expect((await create(BOB, 'node-1')).closed).toEqual({ by: ALICE })

    vi.advanceTimersByTime(TOMBSTONE_TTL_MS + 1)
    expect((await create(CAROL, 'node-1')).closed).toBeUndefined()
  })

  it('rate-limits the destroy cast, and the burst still covers a bulk delete', async () => {
    const { PTY_END_BUDGET } = await import('./pty-manager')
    await manager()
    // A real bulk delete (select N nodes → Delete) fires one cast per node in a single tick: every
    // one of them must land, or a solo user silently leaks tmux sessions.
    for (let i = 0; i < PTY_END_BUDGET.burst; i++) await destroy(ALICE, `node-${i}`)
    expect((await create(BOB, 'node-0')).closed).toEqual({ by: ALICE })

    // Past the burst the flood is dropped: no tombstone entry, no fs.rm, no tmux subprocess.
    await destroy(ALICE, 'flood-1')
    expect((await create(BOB, 'flood-1')).closed).toBeUndefined()
  })

  it('the SOLO delete → undo path is untouched', async () => {
    await manager()
    await create(ALICE, 'node-1')
    await destroy(ALICE, 'node-1')

    const undone = await create(ALICE, 'node-1') // ⌘Z
    expect(undone.closed).toBeUndefined()
    expect(undone.fresh).toBe(true)
  })
})

// ── A node RECYCLED (moved into a worktree) while somebody else is watching it ────────────────
// "Move into worktree" ends the node's tmux session so the SAME node id respawns in the new cwd.
// The node never leaves anybody's canvas and it keeps working — so a co-viewer must NOT be told
// "closed by <name>" (which is permanent and un-respawnable). They are told the session RESTARTED,
// and only once the replacement session exists: notify them any earlier and their own re-create
// could win the race and spawn the tmux session in their STALE cwd, silently undoing the move.
describe('node recycled (worktree move) while co-viewed', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
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
  // pty:recycle is sender-aware: the client that recycled drives its OWN respawn, so it must be
  // excluded from the restart notice (it would otherwise respawn twice).
  const recycle = (clientId: number, persistKey = 'node-1') =>
    fake.senderListeners[IPC.ptyRecycle](clientId, persistKey) as unknown as Promise<void>
  const closed = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptyClosed(sessionId))
  const recycled = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptyRecycled(sessionId))

  it('never tells a co-viewer the node was CLOSED — it is still on their canvas', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await recycle(ALICE)
    expect(closed(sessionId)).toEqual([]) // the un-respawnable "closed by <name>" state must NOT fire
    expect(spawned[0].killed).toBe(true) // the old pty is still released with its session
  })

  it('holds the restart notice until the replacement session exists, then joins the co-viewer to it', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await recycle(ALICE)
    // Nothing yet: notifying Bob here would let his re-create spawn `nt-node-1` in his stale cwd.
    expect(recycled(sessionId)).toEqual([])

    const fresh = await create(ALICE) // Alice respawns the node in the worktree cwd
    expect(spawned).toHaveLength(2)
    expect(fresh.sessionId).not.toBe(sessionId)
    expect(recycled(sessionId).map((s) => s.to)).toEqual([BOB]) // only now is Bob told
    // `ready` is what makes Bob's restart safe: there IS a session to co-attach to.
    expect(recycled(sessionId)[0].args[0]).toEqual({ ready: true })

    const bob = await create(BOB) // Bob's terminal restarts…
    expect(bob.sessionId).toBe(fresh.sessionId) // …onto the LIVE new session
    expect(bob.fresh).toBe(false) // a co-attach, not a resurrection
    expect(spawned).toHaveLength(2) // and nothing extra was spawned
  })

  it('never sends the restart notice to the client that recycled', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    await recycle(ALICE)
    await create(ALICE)
    expect(recycled(sessionId).map((s) => s.to)).not.toContain(ALICE)
  })

  it('a co-viewer is never left on a dead pty: the notice fires even if nobody respawns', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await recycle(ALICE)
    expect(recycled(sessionId)).toEqual([])
    // Alice's app quit / crashed mid-move: no replacement session is ever registered. Bob still
    // has to be released from the dead session, so the notice fires on a timeout.
    vi.advanceTimersByTime(15_000)
    expect(recycled(sessionId).map((s) => s.to)).toEqual([BOB])
    // …but it says there is NOTHING to restart onto. Bob must not spawn `nt-node-1` himself: his
    // options still carry the node's OLD cwd, so his session would silently undo the move (and
    // Alice's app, on its return, would `new-session -A` straight back into that stale-cwd
    // session). He shows "session ended — reopen to restart" instead.
    expect(recycled(sessionId)[0].args[0]).toEqual({ ready: false })
  })

  it('a recycle with no other subscriber notifies nobody (the solo path is untouched)', async () => {
    await manager()
    await create(ALICE)
    fake.sent.length = 0
    await recycle(ALICE)
    await create(ALICE)
    vi.advanceTimersByTime(15_000)
    expect(fake.sent.filter((s) => s.channel.startsWith('pty:recycled:'))).toEqual([])
    expect(fake.sent.filter((s) => s.channel.startsWith('pty:closed:'))).toEqual([])
  })
})

// ── A joiner's screen has to be PAINTED ───────────────────────────────────────────────────────
// A co-attaching client gets `fresh:false` (no cold-restore replay) and joins an existing tmux
// client, so the ONLY thing that could paint its empty xterm is a tmux redraw — and tmux only
// redraws on SIGWINCH, i.e. when the join actually RESIZES the pty. A joiner whose grid is EQUAL
// (the expected case: same persisted node geometry, same font) or LARGER resizes nothing, so it
// would stare at a blank-but-live terminal until the next byte of output. The join therefore
// carries the CURRENT SCREEN, captured from tmux — the same bytes the drop-and-redraw path uses.
describe('a joiner is painted from the current screen', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, cols = 80, rows = 24, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
      screen?: string
    }>

  it('paints a joiner whose grid EQUALS the pty (nothing is resized, so tmux never redraws)', async () => {
    const m = await manager()
    const capture = vi.spyOn(m, 'captureForResync').mockResolvedValue('$ ls\r\nREADME.md')
    const a = await create(ALICE, 80, 24)

    const b = await create(BOB, 80, 24)
    expect(b.sessionId).toBe(a.sessionId)
    expect(spawned[0].resizes).toEqual([]) // equal grids → no SIGWINCH → no tmux redraw
    expect(capture).toHaveBeenCalledWith(a.sessionId)
    expect(b.screen).toBe('$ ls\r\nREADME.md') // …so the screen rides the create result instead
  })

  it('paints a joiner BIGGER than the pty (it letterboxes; the pty is not resized)', async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    await create(ALICE, 80, 24)

    const b = await create(BOB, 120, 40)
    expect(spawned[0].resizes).toEqual([])
    expect(b.screen).toBe('current screen')
  })

  it('does NOT paint a joiner that shrinks the pty — tmux redraws it, and two paints would splice', async () => {
    const m = await manager()
    const capture = vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    await create(ALICE, 120, 40)

    const b = await create(BOB, 80, 24) // strictly smaller → the pty resizes → tmux redraws
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 24 })
    expect(capture).not.toHaveBeenCalled()
    expect(b.screen).toBeUndefined()
  })

  it('never paints a SOLO user: a fresh spawn has nothing to paint, and a reattach gets tmux own redraw', async () => {
    const m = await manager()
    const capture = vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    const a = await create(ALICE, 80, 24)
    expect(a.screen).toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
  })

  it('omits the screen when the capture comes back empty (plain shell / tmux unavailable)', async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('')
    await create(ALICE, 80, 24)

    const b = await create(BOB, 80, 24)
    expect(b.screen).toBeUndefined() // never an empty payload — the renderer would reset for nothing
    expect(b.fresh).toBe(false)
  })
})

// ── A joiner must be told tmux's mouse tracking is ON ─────────────────────────────────────────
// tmux emits the mouse-enable DECSET sequences (?1000h/?1002h/?1006h) to a client ONLY at its own
// attach. A co-attach subscriber (kanban card modal, second window) joins mid-stream and never
// sees them; neither the `screen` capture (capture-pane carries no private modes) nor a SIGWINCH
// redraw re-emits them. So the joiner's xterm reports no mouse events and the wheel can't scroll
// tmux history until a keystroke wakes it. `coAttachMouse` tells the renderer to enable it — set on
// EVERY tmux-backed join (both the screen-painted and the resized branch), never on a plain-shell
// join (no tmux ⇒ no tmux mouse) nor on the solo spawn.
describe('a tmux-backed joiner is told to enable mouse tracking', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  // A manager whose sessions are tmux-BACKED: force the tmux path (init()/tmuxStatus() aren't run
  // in unit tests) and stub the has-session probe so no real tmux socket is touched.
  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    ;(m as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
    vi.spyOn(m as unknown as { tmuxSessionExists: (k: string) => Promise<boolean> }, 'tmuxSessionExists').mockResolvedValue(false)
    return m
  }
  const create = (clientId: number, cols = 80, rows = 24, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
      screen?: string
      coAttachMouse?: boolean
    }>

  it('sets coAttachMouse on a joiner whose grid EQUALS the pty (the screen-painted branch)', async () => {
    const m = await tmuxManager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    await create(ALICE, 80, 24)

    const b = await create(BOB, 80, 24)
    expect(b.screen).toBe('current screen') // equal grid → painted from the capture…
    expect(b.coAttachMouse).toBe(true) // …which carries no mouse modes, so enable them explicitly
  })

  it('sets coAttachMouse on a joiner that SHRINKS the pty too (a SIGWINCH redraw re-emits no mouse modes)', async () => {
    const m = await tmuxManager()
    const capture = vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    await create(ALICE, 120, 40)

    const b = await create(BOB, 80, 24) // strictly smaller → the pty resizes, tmux redraws
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 24 })
    expect(capture).not.toHaveBeenCalled() // tmux paints it; no screen rides the result…
    expect(b.screen).toBeUndefined()
    expect(b.coAttachMouse).toBe(true) // …but the redraw does NOT re-send mouse modes, so still enable
  })

  it('never sets coAttachMouse on the SOLO spawn (that client got its modes from its own tmux attach)', async () => {
    await tmuxManager()
    const a = await create(ALICE, 80, 24)
    expect(a.coAttachMouse).toBeUndefined()
  })

  it('never sets coAttachMouse on a PLAIN-SHELL join (no tmux ⇒ no tmux mouse to enable)', async () => {
    // The default manager has no tmux path, so the session is not persisted (persistKey unset).
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    await create(ALICE, 80, 24)

    const b = await create(BOB, 80, 24)
    expect(b.fresh).toBe(false) // it did join the live session…
    expect(b.coAttachMouse).toBeUndefined() // …but a plain shell has no tmux mouse to turn on
  })
})

describe('tmuxAttachFlags', () => {
  it("keeps -D for the app's own client: exactly ONE tmux client per session", async () => {
    const { tmuxAttachFlags } = await import('./pty-manager')
    // Co-attach adds subscribers to OUR session — it never adds a tmux client, so -D stays.
    expect(tmuxAttachFlags(false)).toEqual(['-A', '-D'])
    // A relay-served (detached) pty mirrors the host's own client → must NOT detach it.
    expect(tmuxAttachFlags(true)).toEqual(['-A'])
  })
})

// ── Viewer identity: one connection holds MANY independently-detachable views ──────────────────
// The kanban card modal opens a SECOND terminal view of a node's tmux session INSIDE the same
// desktop renderer. Both views present the SAME ClientId (one webContents), so the subscriber
// ledger keys on the composite (ClientId, viewerId ?? PRIMARY): the modal is a real second
// subscriber, its size votes independently, and closing it detaches ONLY it — the canvas node's
// client (and everyone else's) is untouched. An absent viewerId is the PRIMARY view (the canvas
// node), and every legacy call omits it, so it maps bit-for-bit to today's single-subscriber path.
describe('viewer identity: multiple views per connection', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  // create carries an optional viewerId in its options; kill/resize carry it as a TRAILING arg.
  const createV = (
    clientId: number,
    viewerId: string | undefined,
    cols = 80,
    rows = 24,
    persistKey = 'node-1'
  ) =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey, viewerId }) as Promise<{
      sessionId: string
      fresh: boolean
      screen?: string
    }>
  const killV = (clientId: number, sessionId: string, viewerId?: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId, viewerId)
  const resizeV = (
    clientId: number,
    sessionId: string,
    cols: number | null,
    rows: number | null,
    viewerId?: string
  ) => fake.senderListeners[IPC.ptyResize](clientId, sessionId, cols, rows, viewerId)
  const write = (clientId: number, sessionId: string, data: string) =>
    fake.senderListeners[IPC.ptyWrite](clientId, sessionId, data)

  it('a second VIEW in the same client joins the session (same id, painted, both subscribed)', async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('current screen')
    const a = await createV(ALICE, undefined) // the canvas node (PRIMARY)
    const b = await createV(ALICE, 'modal') // the kanban card modal, SAME renderer

    expect(spawned).toHaveLength(1) // ONE pty, ONE tmux client
    expect(b.sessionId).toBe(a.sessionId) // the modal JOINED the live session
    expect(b.fresh).toBe(false) // …so no cold-restore replay
    expect(b.screen).toBe('current screen') // …and its empty xterm is painted from the screen

    // Data fans out to the shared renderer ONCE — both views listen on the same per-client channel,
    // so a second send would double every byte in both xterms.
    spawned[0].onDataCb?.('hi')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(a.sessionId))
    expect(data.map((s) => s.to)).toEqual([ALICE])

    // Two independent subscribers now share the client: the pty is released only when BOTH leave.
    killV(ALICE, a.sessionId, 'modal')
    expect(spawned[0].killed).toBe(false)
    killV(ALICE, a.sessionId) // the PRIMARY view (no viewerId)
    expect(spawned[0].killed).toBe(true)
  })

  it('killing the modal view detaches ONLY it — the primary keeps the session and still steers it', async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('x')
    const { sessionId } = await createV(ALICE, undefined)
    await createV(ALICE, 'modal')

    killV(ALICE, sessionId, 'modal') // close the card modal
    expect(spawned[0].killed).toBe(false) // pty untouched — the canvas node still watches

    write(ALICE, sessionId, 'ls\n') // the client still has a view, so it may still write
    expect(spawned[0].writes).toEqual(['ls\n'])
  })

  it('a modal view resizing smaller shrinks the shared pty; closing it restores the primary size', async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('x')
    const { sessionId } = await createV(ALICE, undefined, 120, 40) // primary 120x40
    await createV(ALICE, 'modal', 120, 40) // modal joins at the same grid

    resizeV(ALICE, sessionId, 80, 24, 'modal') // the card modal is a smaller pane
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 24 }) // min shrinks the pty

    killV(ALICE, sessionId, 'modal') // close the modal → its size vote is withdrawn
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 }) // back to the primary's size
    expect(spawned[0].killed).toBe(false) // …and the pty stays alive for the canvas node
  })

  it('killing the PRIMARY (no viewerId) leaves the modal view holding the session alive', async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('x')
    const { sessionId } = await createV(ALICE, undefined)
    await createV(ALICE, 'modal')

    killV(ALICE, sessionId) // the canvas node unmounts (PRIMARY) — but the modal is still open
    expect(spawned[0].killed).toBe(false) // the modal keeps the session alive: NO releasePty

    write(ALICE, sessionId, 'x') // the client is still a subscriber (via the modal), so it may steer
    expect(spawned[0].writes).toEqual(['x'])

    killV(ALICE, sessionId, 'modal') // the last view closes
    expect(spawned[0].killed).toBe(true) // …only now is the pty released
  })

  // ── The Server Edition's per-CONNECTION socket pause outlives a single view's departure ──────
  // A browser's WS send-buffer backpressure (`setFlow(uiId, …, 'socket')`) is owned by the whole
  // CONNECTION, not by one xterm — it rides the PRIMARY view by convention (the socket forwards no
  // viewerId). So when the canvas node (PRIMARY) unmounts while the kanban modal is still open on the
  // SAME connection, that one shared socket may still be jammed: a `kill` that returned EVERY owner's
  // ticket for the departing view — as a full departure does — would hand back the socket's pause too
  // and permanently un-pause a drowning connection, because the renderer's flow control is
  // edge-latched and will never re-pause (invariant (b) on `pausedBy`). The socket ticket must
  // survive until the client's LAST view leaves; only THIS view's own renderer pause is unreturnable.
  it("a PRIMARY-view kill keeps the client's per-connection SOCKET pause while a modal view stays", async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('x')
    const { sessionId } = await createV(ALICE, undefined) // the canvas node (PRIMARY)
    await createV(ALICE, 'modal') // the kanban card modal, SAME connection

    m.setFlow(ALICE, sessionId, false, 'socket') // ALICE's WS socket is backed up (per-connection)
    expect(spawned[0].paused).toBe(true)

    killV(ALICE, sessionId) // the canvas node unmounts (PRIMARY) — the modal stays open
    expect(spawned[0].paused).toBe(true) // the connection is still jammed; the pty must STAY paused
    expect(spawned[0].killed).toBe(false) // …and the modal keeps it alive

    m.setFlow(ALICE, sessionId, true, 'socket') // the socket finally drains into the browser
    expect(spawned[0].paused).toBe(false) // only now does the pty resume

    killV(ALICE, sessionId, 'modal') // the last view closes → the pty is released
    expect(spawned[0].killed).toBe(true)
  })

  // Belt-and-braces: if the socket is STILL jammed when the client's last view leaves, the departure
  // sweep must return the socket ticket (which rides the PRIMARY view, not the departing modal's
  // key), or a released pty would be left holding an un-returnable pause on a session that is gone.
  it("the client's last view leaving sweeps a still-held socket pause (no leaked ticket)", async () => {
    const m = await manager()
    vi.spyOn(m, 'captureForResync').mockResolvedValue('x')
    const { sessionId } = await createV(ALICE, undefined)
    await createV(ALICE, 'modal')
    await createV(BOB, undefined) // a second CONNECTION keeps the pty alive after ALICE fully leaves

    m.setFlow(ALICE, sessionId, false, 'socket')
    killV(ALICE, sessionId) // PRIMARY view goes; ALICE's socket pause stays (modal still open)
    expect(spawned[0].paused).toBe(true)

    killV(ALICE, sessionId, 'modal') // ALICE's LAST view leaves without ever resuming the socket
    expect(spawned[0].paused).toBe(false) // the departure sweep returns the leftover socket ticket
    expect(spawned[0].killed).toBe(false) // BOB still watches, so the pty is not released
  })
})

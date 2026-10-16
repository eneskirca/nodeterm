// The link host against the REAL relay host, the REAL hosted scheduler and the REAL browser client
// (src/shared/watch-link/client.ts) over an in-process transport. Only the pty and the clients registry
// are fakes, and they record every call, so "nothing a viewer sent reached the pty" is checkable.
//
// Timing-sensitive cases run on a MANUAL clock injected as the link host's (and so the scheduler's)
// setTimeout/now; the handshake itself is real async crypto, awaited with vi.waitFor on real time.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import nacl from 'tweetnacl'
import { transportPair } from '../relay/transport-pair'
import { connectRelay, type RelayTransport } from '../relay/relay-socket'
import { publicKeyToB64 } from '../relay/e2ee'
import { encodePtyData, parseRpcMessage } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import { isHostOnlyChannel } from '../../shared/host-control'
import { connectWatchClient } from '../../shared/watch-link/client'
import { deriveWatchLinkKeys } from '../../shared/watch-link/keys'
import {
  INPUT_MAX,
  TYPING_NAMES_MAX,
  WATCH_EVENT,
  WATCH_INPUT_CAST,
  WATCH_RELEASE_CAST,
  WATCH_UNLOCK_CAST,
  type WatchControlEvent,
  type WatchKeyframe,
  type WatchLinkRole,
  type WatchMeta
} from '../../shared/watch-link/protocol'
import {
  createLinkHost,
  CONFIRM_DEADLINE_MS,
  DROPPED_NOTICE_MIN_MS,
  INPUT_BATCH_MS,
  INPUT_BURST,
  INPUT_CHUNKS_MAX,
  INPUT_DELIVERY_TIMEOUT_MS,
  INPUT_GRACE_MS,
  INPUT_RATE,
  TYPING_EVENT_MIN_MS,
  FULL_STATUS_POLL_MS,
  MAX_VIEWERS_PER_LINK,
  REJOIN_BACKOFF_MS,
  REJOIN_STABLE_MS,
  SETTLE_BOUND_MS,
  UNLOCK_MIN_INTERVAL_MS,
  WATCHER_SIZE_SYNC_MS,
  WRONG_PER_CONN,
  WRONG_PER_LINK,
  type LinkHost,
  type WatchJoin,
  type WatchPty
} from './link-host'
import type { HostTokenResult } from './api'
import { unavailableCapture, type VisibleCapture } from './capture-route'
import { hashControlPassword, verifyControlPassword, type ControlPasswordHash } from './password'
import type { WatchLinkControlRecord, WatchLinkRecord } from './store'
import type { UiSink } from '../ui-sink-registry'
import type { ControlInputChunk, WatcherInputRoute } from './pane-input'
import { PASTE_END, PASTE_START, TYPING_WINDOW_MS } from './control-input'

const ESC = '\x1b'
const TRUST_CONFIRM = '{"t":"cast","method":"trust:confirm","args":[]}'

const hosts: LinkHost[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.stop('revoked')
  vi.restoreAllMocks()
})

/** A clock and timer queue owned by the test. Firing a timer lets the event loop turn once, so the
 *  async work it starts (a join, a capture) settles before the next one fires. */
function manualClock() {
  let t = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = nextId++
      timers.set(id, { at: t + Math.max(0, ms), fn })
      return id
    },
    clearTimeout: (h: unknown) => {
      timers.delete(h as number)
    },
    /** How many timers are armed and not yet fired or cleared. */
    pending: (): number => timers.size,
    async advance(ms: number): Promise<void> {
      const end = t + ms
      for (;;) {
        let best: [number, { at: number; fn: () => void }] | null = null
        for (const e of timers) if (e[1].at <= end && (!best || e[1].at < best[1].at)) best = e
        if (!best) break
        timers.delete(best[0])
        t = best[1].at
        best[1].fn()
        await flush()
        await flush()
      }
      t = end
      await flush()
      await flush()
    },
    flush
  }
}
type ManualClock = ReturnType<typeof manualClock>

/** A join answer as a custom `join` writes it: the input route may be left to `SetupOpts.route`. */
type JoinAnswer = Omit<WatchJoin, 'input'> & { input?: WatchJoin['input'] }

interface SetupOpts {
  role?: WatchLinkRole
  /** A Control link's record state (the test mutates it the way the service does). */
  control?: WatchLinkControlRecord
  /** Default: the real `verifyControlPassword` against `record.control`, read at call time (as the
   *  service does). */
  verifyPassword?: (pw: string) => Promise<boolean>
  /** Replaces the service's lock (which sets `record.control.locked`); still counted in `locks()`. */
  onControlLocked?: () => void
  /** Replaces the service's record of the link-wide wrong count; still recorded in `wrongs`. */
  onWrongAttempt?: (count: number) => void
  join?: (clientId: number, nodeId: string, viewerId: string) => Promise<JoinAnswer | null> | JoinAnswer | null
  capture?: (sid: string) => Promise<VisibleCapture> | VisibleCapture
  alive?: (sid: string) => boolean
  /** The host side's socket backlog, per listener (in the order listeners were opened). */
  buffered?: (listener: number) => number
  clock?: ManualClock
  /** The pane delivery (`WatchPty.input`). Default: resolves true. Every call is recorded first. */
  input?: (sid: string, chunk: ControlInputChunk) => Promise<boolean> | boolean
  /** The input route the default join answers, and the one added to a custom join's answer that has
   *  none. 'missing': leave the field out (the host must read that as 'none'). Default 'tmux'. */
  route?: WatcherInputRoute | 'missing'
  mint?: () => Promise<HostTokenResult>
  status?: () => Promise<'live' | 'revoked' | 'expired' | 'unknown'>
}

function setup(o: SetupOpts = {}) {
  const secret = nacl.randomBytes(32)
  const record: WatchLinkRecord = {
    linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'node-1', role: o.role ?? 'viewer', label: 'Ada', title: 'build',
    createdAt: 0, expiresAt: Date.now() + 3600_000, secret, ...(o.control ? { control: o.control } : {})
  }
  const peers: RelayTransport[] = []
  const sinks = new Map<number, UiSink>()
  let nextId = 1_000_000
  const left: string[] = []
  /** Every pty call, in order: 'join', 'sync:<sid>', 'capture:<sid>'. */
  const calls: string[] = []
  const joinArgs: [number, string, string][] = []
  const joinTimes: number[] = []
  /** Every `pty.input` call, in order: [sessionId, chunk]. */
  const inputs: [string, ControlInputChunk][] = []
  /** Every `pty.input` call's `isCurrent` predicate, in the same order. */
  const currents: ((() => boolean) | undefined)[] = []
  /** Every link-wide wrong count the host reported (`onWrongAttempt`), in order. */
  const wrongs: number[] = []
  let mints = 0
  let changes = 0
  let verifies = 0
  let locks = 0
  const taken: string[] = []
  const clock = o.clock
  const now = clock ? clock.now : () => Date.now()
  const pty: WatchPty = {
    join: async (clientId, nodeId, viewerId) => {
      calls.push('join')
      joinArgs.push([clientId, nodeId, viewerId])
      joinTimes.push(now())
      const route = o.route ?? 'tmux'
      const r = o.join ? await o.join(clientId, nodeId, viewerId) : { sessionId: 's1', cols: 100, rows: 30, altScreen: true }
      // 'missing' hands the host an answer with no route, as a wiring slip would.
      if (!r || 'input' in r || route === 'missing') return r as WatchJoin | null
      return { ...r, input: route }
    },
    leave: (_c, sid, vid) => {
      left.push(`${sid}/${vid}`)
    },
    captureVisible: async (sid) => {
      calls.push(`capture:${sid}`)
      return o.capture ? o.capture(sid) : { screen: 'SCREEN', cursor: null }
    },
    syncSize: async (sid) => {
      calls.push(`sync:${sid}`)
      return true
    },
    alive: (sid) => (o.alive ? o.alive(sid) : true),
    input: async (sid, chunk, isCurrent) => {
      inputs.push([sid, chunk])
      currents.push(isCurrent)
      return o.input ? o.input(sid, chunk) : true
    }
  }
  const chats: unknown[] = []
  const joined: number[] = []
  const gone: string[] = []
  const host = createLinkHost(record, {
    relayUrl: 'wss://relay.test',
    mint: async () => {
      mints++
      return o.mint ? o.mint() : { ok: true, pairingToken: 'tok', hostId: '', ttlMs: 120_000 }
    },
    status: o.status ?? (async () => 'live'),
    clients: {
      attach: (s) => {
        const id = nextId++
        sinks.set(id, s)
        return id
      },
      detach: (id) => {
        sinks.delete(id)
      }
    },
    pty,
    transport: () => {
      const i = peers.length
      const { hostT, peerT } = transportPair({ hostBuffered: () => o.buffered?.(i) ?? 0 })
      peers.push(peerT)
      return hostT
    },
    now,
    setTimeout: clock ? clock.setTimeout : (fn, ms) => setTimeout(fn, ms),
    clearTimeout: clock ? clock.clearTimeout : (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onChange: () => {
      changes++
    },
    onChat: (m) => chats.push(m),
    onViewerJoined: (n) => joined.push(n),
    onGone: (r) => gone.push(r),
    verifyPassword: (pw) => {
      verifies++
      if (o.verifyPassword) return o.verifyPassword(pw)
      return record.control ? verifyControlPassword(pw, record.control) : Promise.resolve(false)
    },
    onControlTaken: (name) => {
      taken.push(name)
    },
    // What the service does, synchronously, before returning (the host reads the record live).
    onControlLocked: () => {
      locks++
      if (o.onControlLocked) o.onControlLocked()
      else if (record.control) record.control.locked = true
    },
    // What the service does: the count goes on the record (and to disk).
    onWrongAttempt: (count) => {
      wrongs.push(count)
      if (o.onWrongAttempt) o.onWrongAttempt(count)
      else if (record.control) record.control.wrong = count
    }
  })
  hosts.push(host)
  return {
    record, host, peers, sinks, left, calls, joinArgs, joinTimes, inputs, currents, wrongs, chats, joined, gone,
    keys: deriveWatchLinkKeys(secret),
    mints: () => mints,
    /** How many times the host reported a change to the registry (`onChange`). */
    changes: () => changes,
    /** How many times the host asked to verify a password, and the names that took control. */
    verifies: () => verifies,
    taken,
    locks: () => locks,
    /** The n-th attached viewer's sink (attach order). */
    sink: (n = 0) => [...sinks.values()][n]
  }
}
type Setup = ReturnType<typeof setup>

function viewer(peer: RelayTransport, keys: ReturnType<typeof deriveWatchLinkKeys>) {
  const log = { open: 0, events: [] as [string, unknown[]][], pty: [] as string[], denied: [] as string[], closed: 0 }
  const c = connectWatchClient({
    socket: peer,
    keys,
    events: {
      onOpen: () => { log.open++ },
      onEvent: (ch, a) => { log.events.push([ch, a]) },
      onPtyData: (_s, d) => { log.pty.push(d) },
      onDenied: (r) => { log.denied.push(r) },
      onClose: () => { log.closed++ }
    }
  })
  const named = (ch: string) => log.events.filter((e) => e[0] === ch).map((e) => e[1][0])
  return { c, log, named, keyframes: () => named(WATCH_EVENT.keyframe) as WatchKeyframe[] }
}
type Viewer = ReturnType<typeof viewer>

/** Open the n-th listener's viewer and wait for its first keyframe. */
async function openViewer(t: Setup, n = 0): Promise<Viewer> {
  await vi.waitFor(() => expect(t.peers.length).toBeGreaterThan(n))
  const v = viewer(t.peers[n], t.keys)
  await vi.waitFor(() => expect(v.keyframes().length).toBeGreaterThanOrEqual(1))
  return v
}
/** Open the n-th listener's viewer and wait for its meta (a no-capture backend sends no keyframe). */
async function openViewerMeta(t: Setup, n = 0): Promise<Viewer> {
  await vi.waitFor(() => expect(t.peers.length).toBeGreaterThan(n))
  const v = viewer(t.peers[n], t.keys)
  await vi.waitFor(() => expect(v.named(WATCH_EVENT.meta).length).toBeGreaterThanOrEqual(1))
  return v
}
const pty = (sink: UiSink, sid: string, data: string): void => sink.sendBinary(encodePtyData(sid, data))
const ptyEvent = (sink: UiSink, channel: string, ...args: unknown[]): void =>
  sink.sendText(JSON.stringify({ t: 'ev', channel, args }))

describe('createLinkHost — a viewer session', () => {
  it('opens a viewer, sends meta then the visible keyframe, then the filtered stream', async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toEqual([WATCH_EVENT.meta, WATCH_EVENT.keyframe]))
    expect(v.log.events[0][1][0]).toMatchObject({ v: 1, role: 'viewer', label: 'Ada', title: 'build', cols: 100, rows: 30 })
    // No cursor was read, so the keyframe carries none (not `cursor: null`).
    expect(v.log.events[1][1][0]).toEqual({ sessionId: 's1', screen: 'SCREEN', altScreen: true })
    const [id, sink] = [...t.sinks.entries()][0]
    expect(id).toBeGreaterThanOrEqual(1_000_000)
    // The join is MID-STREAM (R12): nothing is shown until the first escape, then OSC 52 is removed.
    pty(sink, 's1', 'lost')
    pty(sink, 's1', `${ESC}[Ha${ESC}]52;c;c2VjcmV0\x07b`)
    expect(v.log.pty).toEqual([`${ESC}[Hab`])
    expect(t.joined).toEqual([1])
    expect(t.host.viewers()).toHaveLength(1)
    // The host built every join argument itself: its client id, the record's node, a fresh viewer id.
    expect(t.joinArgs).toEqual([[id, 'node-1', t.host.viewers()[0].viewerId]])
    expect(t.host.viewers()[0].viewerId).toMatch(/^v-[0-9a-f]{8}$/)
    // A replacement listener opened for the next viewer.
    await vi.waitFor(() => expect(t.peers).toHaveLength(2))
  })

  it("a keyframe carries the host's cursor, and its screen passes a FRESH filter (R9, R10)", async () => {
    const screen =
      `${ESC}[1mhi${ESC}[m ${ESC}]8;;https://evil.test/${ESC}\\link${ESC}]8;;${ESC}\\ ` +
      `${ESC}]52;c;c2VjcmV0\x07end${ESC}P1$r0m${ESC}\\\n`
    const t = setup({ capture: () => ({ screen, cursor: { x: 3, y: 1 } }) })
    t.host.start()
    const v = await openViewer(t)
    expect(v.keyframes()[0]).toEqual({
      sessionId: 's1',
      screen: `${ESC}[1mhi${ESC}[m link end\n`,
      altScreen: true,
      cursor: { x: 3, y: 1 }
    })
  })

  it("a REAL capture of an empty screen still sends a keyframe with screen '' (R36), and altScreen follows the join", async () => {
    const t = setup({
      join: () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: false }),
      capture: () => ({ screen: '', cursor: null })
    })
    t.host.start()
    const v = await openViewer(t)
    expect(v.keyframes()[0]).toEqual({ sessionId: 's1', screen: '', altScreen: false })
  })

  it("a session-host capture states its own altScreen, which wins over the join's (no tmux client between)", async () => {
    const t = setup({
      join: () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: false }),
      capture: () => ({ screen: 'vim\n', cursor: { x: 0, y: 0 }, altScreen: true })
    })
    t.host.start()
    const v = await openViewer(t)
    expect(v.keyframes()[0]).toEqual({ sessionId: 's1', screen: 'vim\n', altScreen: true, cursor: { x: 0, y: 0 } })
  })

  it("denies a peer whose key is not the link's viewer key, and reopens a listener", async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const stranger = deriveWatchLinkKeys(nacl.randomBytes(32))
    const v = viewer(t.peers[0], { ...t.keys, viewer: stranger.viewer })
    await vi.waitFor(() => expect(v.log.denied).toEqual(['denied']))
    expect(v.log.open).toBe(0)
    expect(t.sinks.size).toBe(0)
    expect(t.calls).toEqual([])
    await vi.waitFor(() => expect(t.peers.length).toBeGreaterThanOrEqual(2))
  })
})

describe('createLinkHost — read-only, both directions', () => {
  it('sends a raw peer nothing but the trust confirm before its own confirm; then refuses every request and drops every cast', async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const replies = new Map<number, { ok: boolean; error?: { code: string } }>()
    const frames: { kind: 'text' | 'binary'; json: string | null; beforeOurConfirm: boolean }[] = []
    let confirmed = false
    let rawClosed = 0
    const raw = connectRelay({
      url: 'x', token: 'x', role: 'client', theirPubB64: publicKeyToB64(t.keys.host.publicKey),
      ourKeys: { publicKey: t.keys.viewer.publicKey, secretKey: t.keys.viewer.secretKey },
      transport: t.peers[0], onReady: () => {}, onRpc: () => {}, onFrame: () => {},
      onClose: () => { rawClosed++ },
      onTunnel: (kind, p) => {
        const json = kind === 'text' ? new TextDecoder().decode(p) : null
        frames.push({ kind, json, beforeOurConfirm: !confirmed })
        const m = json ? parseRpcMessage(json) : null
        if (m?.t === 'res') replies.set(m.id, m as { ok: boolean; error?: { code: string } })
      }
    })
    // The host confirms its own half at once (the key is the link's), and then must send NOTHING more:
    // no meta, no keyframe, no pty frame, while the fake pty would happily serve a session (F20).
    await vi.waitFor(() => expect(frames.some((f) => f.json?.includes('trust:confirm'))).toBe(true))
    await new Promise((r) => setTimeout(r, 30))
    expect(t.sinks.size).toBe(0)
    expect(t.calls).toEqual([])
    for (const f of frames) {
      expect(f.kind).toBe('text')
      expect(parseRpcMessage(f.json!)).toEqual({ t: 'cast', method: 'trust:confirm', args: [] })
    }
    confirmed = true
    raw.sendTunnelText(TRUST_CONFIRM)
    await vi.waitFor(() => expect(t.sinks.size).toBe(1))
    await vi.waitFor(() => expect(frames.some((f) => f.json?.includes(WATCH_EVENT.keyframe))).toBe(true))

    // One request for every channel IPC names (and every per-session channel), and the same as a cast.
    const methods = [
      ...(Object.values(IPC) as unknown[]).filter((v): v is string => typeof v === 'string'),
      ...(Object.values(IPC) as unknown[])
        .filter((v): v is (id: string) => string => typeof v === 'function')
        .map((f) => f('s1'))
    ]
    methods.forEach((method, i) => {
      raw.sendTunnelText(JSON.stringify({ t: 'req', id: i + 1, method, args: ['s1', 'rm -rf ~\r', 1, 1] }))
      raw.sendTunnelText(JSON.stringify({ t: 'cast', method, args: ['s1', 'rm -rf ~\r', 1, 1] }))
    })
    await vi.waitFor(() => expect(replies.size).toBe(methods.length))
    methods.forEach((method, i) => {
      const r = replies.get(i + 1)!
      expect(r.ok, method).toBe(false)
      // Host-only channels are refused by relay-host before any policy; everything else by the watcher's.
      expect(r.error?.code, method).toBe(isHostOnlyChannel(method) ? 'E_FORBIDDEN' : 'E_ROLE')
    })
    // Refused by the ACCESS policy: a request or cast that reached the link host's own PeerAttach would
    // have closed this viewer (fail closed). It is still here, and the pty saw only the host's calls.
    expect(t.host.viewers()).toHaveLength(1)
    expect(rawClosed).toBe(0)
    expect(new Set(t.calls)).toEqual(new Set(['join', 'sync:s1', 'capture:s1']))
    expect(t.joinArgs).toHaveLength(1)
    expect(t.chats).toEqual([])
  })

  it('a viewer link drops chat casts; the viewer stays connected', async () => {
    const t = setup({ role: 'viewer' })
    t.host.start()
    const v = await openViewer(t)
    expect(v.c.sendChat('Ada', 'hello')).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.chats).toEqual([])
    expect(t.host.chatHistory()).toEqual([])
    expect(t.host.viewers()).toHaveLength(1)
  })

  it('a pty event for the watched session is consumed (never forwarded), and another session is invisible', async () => {
    const t = setup()
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    pty(sink, 's1', `${ESC}[H`)
    pty(sink, 's2', `${ESC}[Hother`)
    ptyEvent(sink, IPC.ptyResync('s1'), 'history')
    ptyEvent(sink, IPC.ptySize('s1'), { cols: 90, rows: 20 })
    ptyEvent(sink, IPC.ptySize('s2'), { cols: 1, rows: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(v.log.pty).toEqual([`${ESC}[H`])
    expect(v.log.events.map((e) => e[0])).toEqual([WATCH_EVENT.meta, WATCH_EVENT.keyframe, IPC.ptySize('s1')])
  })
})

describe('createLinkHost — joining, waiting, rejoining', () => {
  it('waits (once), then streams when the session appears', async () => {
    const clock = manualClock()
    let running = false
    const t = setup({ clock, join: () => (running ? { sessionId: 's9', cols: 80, rows: 24, altScreen: false } : null) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toEqual([WATCH_EVENT.waiting]))
    await clock.advance(REJOIN_BACKOFF_MS[0])
    expect(t.joinArgs).toHaveLength(2)
    expect(v.log.events.map((e) => e[0])).toEqual([WATCH_EVENT.waiting]) // not repeated per retry
    running = true
    await clock.advance(REJOIN_BACKOFF_MS[1])
    await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toEqual([WATCH_EVENT.waiting, WATCH_EVENT.meta, WATCH_EVENT.keyframe]))
    expect(v.named(WATCH_EVENT.meta)[0]).toMatchObject({ cols: 80, rows: 24 })
  })

  // R63: the OWNER is told a viewer has no session to watch — on a backend with no watcher client of
  // its own (Windows' session host, no local tmux, Zellij) only a terminal open in the app can be
  // watched. Reported by a REFUSED join, once per episode, and cleared by a join that lands.
  it("a refused join marks the viewer waiting in the owner's view, once; a join that lands clears it", async () => {
    const clock = manualClock()
    let running = false
    const t = setup({ clock, join: () => (running ? { sessionId: 's9', cols: 80, rows: 24, altScreen: false } : null) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(t.host.viewers().map((x) => x.waiting)).toEqual([true]))
    const changesAfterFirst = t.changes()
    await clock.advance(REJOIN_BACKOFF_MS[0])
    await clock.advance(REJOIN_BACKOFF_MS[1])
    expect(t.joinArgs.length).toBeGreaterThanOrEqual(3)
    expect(t.changes()).toBe(changesAfterFirst) // a failing rejoin loop reports nothing new
    running = true
    await clock.advance(REJOIN_BACKOFF_MS[2])
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.meta)).toHaveLength(1))
    expect(t.host.viewers().map((x) => x.waiting)).toEqual([false])
    expect(t.changes()).toBeGreaterThan(changesAfterFirst)
  })

  it('a session that ENDS is not "waiting" for the owner until a rejoin is refused (a quick rejoin is no news)', async () => {
    const clock = manualClock()
    let n = 0
    let up = true
    const t = setup({ clock, join: () => (up ? { sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true } : null) })
    t.host.start()
    const v = await openViewer(t)
    ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
    await clock.flush()
    expect(v.named(WATCH_EVENT.waiting)).toHaveLength(1) // the VIEWER is told at once
    expect(t.host.viewers().map((x) => x.waiting)).toEqual([false]) // the owner is not, yet
    up = false
    await clock.advance(REJOIN_BACKOFF_MS[0])
    expect(t.host.viewers().map((x) => x.waiting)).toEqual([true]) // the rejoin was refused
  })

  it('every join starts the filter mid-stream: the first join AND a rejoin after the session ended', async () => {
    const clock = manualClock()
    let n = 0
    const t = setup({ clock, join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    pty(sink, 's1', 'x')
    pty(sink, 's1', `${ESC}[Hy`)
    expect(v.log.pty).toEqual([`${ESC}[Hy`])
    ptyEvent(sink, IPC.ptyExit('s1'), 0)
    await clock.flush()
    expect(v.named(WATCH_EVENT.waiting)).toHaveLength(1)
    expect(t.left).toEqual([`s1/${t.host.viewers()[0].viewerId}`])
    await clock.advance(REJOIN_BACKOFF_MS[0])
    await vi.waitFor(() => expect(v.keyframes().map((k) => k.sessionId)).toContain('s2'))
    // A second meta (R14), and the rejoined session's filter is mid-stream again.
    expect(v.named(WATCH_EVENT.meta)).toHaveLength(2)
    pty(sink, 's2', 'z')
    pty(sink, 's1', `${ESC}[Hdead`)
    pty(sink, 's2', `${ESC}[Hw`)
    expect(v.log.pty).toEqual([`${ESC}[Hy`, `${ESC}[Hw`])
    // The lifecycle event itself never reached the viewer.
    expect(v.log.events.map((e) => e[0]).filter((c) => c.startsWith('pty:'))).toEqual([])
  })

  it('the rejoin backoff grows for sessions that exit at once, and resets only after one stayed up 30 s (R26)', async () => {
    const clock = manualClock()
    let n = 0
    const t = setup({ clock, join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    const exitCurrent = async (): Promise<void> => {
      await vi.waitFor(() => expect(v.keyframes().map((k) => k.sessionId)).toContain(`s${n}`))
      ptyEvent(sink, IPC.ptyExit(`s${n}`), 0)
      await clock.flush()
    }
    await exitCurrent()
    const expected = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000]
    for (const d of expected) {
      await clock.advance(d)
      await exitCurrent()
    }
    const deltas = t.joinTimes.slice(1).map((x, i) => x - t.joinTimes[i])
    expect(deltas).toEqual(expected)
    // This one stays up for REJOIN_STABLE_MS from its join keyframe: the backoff resets.
    await clock.advance(15_000)
    await vi.waitFor(() => expect(v.keyframes().map((k) => k.sessionId)).toContain(`s${n}`))
    await clock.advance(REJOIN_STABLE_MS)
    ptyEvent(sink, IPC.ptyExit(`s${n}`), 0)
    await clock.flush()
    const before = t.joinTimes.length
    await clock.advance(REJOIN_BACKOFF_MS[0])
    expect(t.joinTimes).toHaveLength(before + 1)
  })

  it('a join that throws is "waiting" and backs off; a capture that throws sends NO keyframe and the viewer streams (R36)', async () => {
    const clock = manualClock()
    let fail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({
      clock,
      join: () => {
        if (fail) throw new Error('spawn failed')
        return { sessionId: 's1', cols: 80, rows: 24, altScreen: true }
      },
      capture: () => {
        throw new Error('capture failed')
      }
    })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.waiting)).toHaveLength(1))
    fail = false
    await clock.advance(REJOIN_BACKOFF_MS[0])
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.meta)).toHaveLength(1))
    await clock.flush()
    expect(v.keyframes()).toEqual([])
    pty(t.sink(), 's1', `${ESC}[Hstreams`)
    expect(v.log.pty).toEqual([`${ESC}[Hstreams`])
    expect(warn).toHaveBeenCalled()
  })

  it('a join answering no valid size is REFUSED — left, waiting, retried — never given a guessed size', async () => {
    const clock = manualClock()
    let size = { cols: 0, rows: 24 }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ clock, join: () => ({ sessionId: 's1', ...size, altScreen: true }) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.waiting)).toHaveLength(1))
    expect(v.named(WATCH_EVENT.meta)).toEqual([])
    expect(t.left).toEqual([`s1/${t.host.viewers()[0].viewerId}`])
    expect(t.calls).not.toContain('capture:s1')
    for (const bad of [{ cols: 80, rows: Number.NaN }, { cols: 80.5, rows: 24 }, { cols: -1, rows: 24 }]) {
      size = bad
      await clock.advance(60_000)
    }
    expect(v.named(WATCH_EVENT.meta)).toEqual([])
    size = { cols: 132, rows: 40 }
    await clock.advance(60_000)
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.meta)).toHaveLength(1))
    expect(v.named(WATCH_EVENT.meta)[0]).toMatchObject({ cols: 132, rows: 40 })
    expect(warn).toHaveBeenCalled()
  })

  it('an exit that raced the join (the session is already gone) is waiting + rejoin, not a dead stream (R30)', async () => {
    const clock = manualClock()
    const dead = new Set(['s1'])
    let n = 0
    const t = setup({ clock, join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }), alive: (s) => !dead.has(s) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.waiting)).toHaveLength(1))
    expect(v.keyframes()).toEqual([])
    expect(t.left).toEqual([`s1/${t.host.viewers()[0].viewerId}`])
    expect(t.calls).not.toContain('capture:s1')
    await clock.advance(REJOIN_BACKOFF_MS[0])
    await vi.waitFor(() => expect(v.keyframes().map((k) => k.sessionId)).toEqual(['s2']))
  })

  it('a session gone by the time its capture returns gets no keyframe: waiting + rejoin (R30)', async () => {
    const clock = manualClock()
    const dead = new Set<string>()
    let n = 0
    const t = setup({
      clock,
      join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }),
      capture: (sid) => {
        if (sid === 's1') dead.add('s1') // exits while being captured
        return { screen: 'SCREEN', cursor: null }
      },
      alive: (s) => !dead.has(s)
    })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.waiting)).toHaveLength(1))
    expect(v.keyframes()).toEqual([])
    await clock.advance(REJOIN_BACKOFF_MS[0])
    await vi.waitFor(() => expect(v.keyframes().map((k) => k.sessionId)).toEqual(['s2']))
  })
})

describe('createLinkHost — keyframes and the stream', () => {
  it('sync runs after a join (before its keyframe capture), before every keyframe capture, and every 10 s while watched', async () => {
    const clock = manualClock()
    const t = setup({ clock })
    t.host.start()
    const v = await openViewer(t)
    expect(t.calls).toEqual(['join', 'sync:s1', 'capture:s1'])
    pty(t.sink(), 's1', `${ESC}[H`) // settles the filter: one follow-up keyframe at the min interval
    await clock.advance(1_000)
    expect(t.calls.slice(3)).toEqual(['sync:s1', 'capture:s1'])
    expect(v.keyframes()).toHaveLength(2)
    await clock.advance(WATCHER_SIZE_SYNC_MS - 1_000)
    expect(t.calls.slice(5)).toEqual(['sync:s1'])
    await clock.advance(WATCHER_SIZE_SYNC_MS)
    expect(t.calls.slice(6)).toEqual(['sync:s1'])
    // No joined viewer: no more syncs.
    t.host.kick(t.host.viewers()[0].viewerId)
    await clock.advance(3 * WATCHER_SIZE_SYNC_MS)
    expect(t.calls.slice(7)).toEqual([])
  })

  it('onOverBudget stops the stream NOW even while a keyframe timer is armed (F10)', async () => {
    const clock = manualClock()
    let buffered = 0
    const t = setup({ clock, buffered: () => buffered })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    // Settling arms the follow-up keyframe timer while the stream keeps flowing.
    pty(sink, 's1', `${ESC}[H`)
    expect(v.log.pty).toEqual([`${ESC}[H`])
    buffered = 600 * 1024
    pty(sink, 's1', 'a') // dropped: over the buffer limit
    buffered = 0
    pty(sink, 's1', 'b') // must NOT follow the dropped frame without a repaint between
    expect(v.log.pty).toEqual([`${ESC}[H`])
    await clock.advance(1_000)
    expect(v.keyframes()).toHaveLength(2)
    pty(sink, 's1', 'c')
    expect(v.log.pty).toEqual([`${ESC}[H`, 'c'])
  })

  it('a stalled viewer is throttled to keyframes, painted only once its socket drained', async () => {
    const clock = manualClock()
    let buffered = 0
    const t = setup({ clock, buffered: () => buffered })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    pty(sink, 's1', `${ESC}[H`)
    await clock.advance(1_000) // the settle follow-up
    expect(v.keyframes()).toHaveLength(2)
    buffered = 1_000_000
    for (let i = 0; i < 50; i++) pty(sink, 's1', 'y\r\n')
    expect(v.log.pty).toEqual([`${ESC}[H`])
    await clock.advance(3_000) // still backed up: no keyframe on top of the backlog
    expect(v.keyframes()).toHaveLength(2)
    buffered = 0
    await clock.advance(1_000)
    expect(v.keyframes()).toHaveLength(3)
    pty(sink, 's1', 'after')
    expect(v.log.pty).toEqual([`${ESC}[H`, 'after'])
  })

  it('the token bucket throttles a flood to at most one keyframe a second', async () => {
    const clock = manualClock()
    const t = setup({ clock })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    pty(sink, 's1', `${ESC}[H`)
    await clock.advance(1_000)
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 40; i++) pty(sink, 's1', chunk) // 2.5 MB at one instant: past the 1 MB burst
    const forwarded = v.log.pty.join('').length
    expect(forwarded).toBeLessThanOrEqual(1024 * 1024)
    await clock.advance(1_000)
    expect(v.keyframes()).toHaveLength(3)
  })

  it('a follow-up keyframe when the filter settles after the join keyframe; one at 2 s if it has not (R23)', async () => {
    const clock = manualClock()
    const t = setup({ clock })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    // Settles half a second in: the follow-up comes at the min interval, and the 2 s bound adds none.
    await clock.advance(500)
    pty(sink, 's1', `${ESC}[H`)
    await clock.advance(499)
    expect(v.keyframes()).toHaveLength(1)
    await clock.advance(1)
    expect(v.keyframes()).toHaveLength(2)
    await clock.advance(5_000)
    expect(v.keyframes()).toHaveLength(2)
  })

  it('an unsettled filter gets a keyframe at the 2 s bound, and one more when it settles later (R23)', async () => {
    const clock = manualClock()
    const t = setup({ clock })
    t.host.start()
    const v = await openViewer(t)
    await clock.advance(SETTLE_BOUND_MS - 1)
    expect(v.keyframes()).toHaveLength(1)
    await clock.advance(1)
    expect(v.keyframes()).toHaveLength(2)
    await clock.advance(3_000)
    expect(v.keyframes()).toHaveLength(2)
    pty(t.sink(), 's1', `${ESC}[H`)
    await clock.advance(0)
    expect(v.keyframes()).toHaveLength(3)
    await clock.advance(10_000)
    expect(v.keyframes()).toHaveLength(3)
  })

  it('a filter that settled before the join keyframe was painted takes no follow-up', async () => {
    const clock = manualClock()
    let release: (c: VisibleCapture) => void = () => {}
    const t = setup({ clock, capture: () => new Promise<VisibleCapture>((r) => (release = r)) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(t.calls).toContain('capture:s1'))
    pty(t.sink(), 's1', `${ESC}[Hx`) // not forwarded (no keyframe yet), but the filter settles
    release({ screen: 'SCREEN', cursor: null })
    await vi.waitFor(() => expect(v.keyframes()).toHaveLength(1))
    await clock.advance(10_000)
    expect(v.keyframes()).toHaveLength(1)
    expect(v.log.pty).toEqual([])
  })

  it('a backend with NO visible capture never gets a watch:keyframe — join, 2 s bound, settle follow-up, throttle — and keeps streaming (R36)', async () => {
    const clock = manualClock()
    let buffered = 0
    const t = setup({ clock, capture: () => unavailableCapture(), buffered: () => buffered })
    t.host.start()
    const v = await openViewerMeta(t)
    await clock.flush()
    const captures = () => t.calls.filter((c) => c === 'capture:s1').length
    expect(captures()).toBe(1)
    expect(v.keyframes()).toEqual([])
    const sink = t.sink()
    pty(sink, 's1', 'lost') // mid-stream: swallowed until the first escape
    await clock.advance(SETTLE_BOUND_MS) // the 2 s bound: a capture, nothing sent
    expect(captures()).toBe(2)
    expect(v.keyframes()).toEqual([])
    pty(sink, 's1', `${ESC}[Ha`) // settles; streaming, with no keyframe ever sent
    expect(v.log.pty).toEqual([`${ESC}[Ha`])
    await clock.advance(1_000) // the settle follow-up: a capture, nothing sent, still streaming
    expect(captures()).toBe(3)
    pty(sink, 's1', 'b')
    // Throttled: dropped while over budget, then streaming RESUMES without a keyframe.
    buffered = 600 * 1024
    pty(sink, 's1', 'dropped')
    buffered = 0
    pty(sink, 's1', 'still-dropped')
    await clock.advance(1_000)
    expect(captures()).toBe(4)
    pty(sink, 's1', 'resumed')
    expect(v.log.pty).toEqual([`${ESC}[Ha`, 'b', 'resumed'])
    expect(v.keyframes()).toEqual([])
    expect(v.log.events.map((e) => e[0]).filter((c) => c === WATCH_EVENT.keyframe)).toEqual([])
  })

  it('a FAILED capture on a capture-capable backend sends no keyframe, and the stream resumes (R36)', async () => {
    const clock = manualClock()
    let buffered = 0
    let fail = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({
      clock,
      buffered: () => buffered,
      capture: () => {
        if (fail) throw new Error('ssh: master gone')
        return { screen: 'SCREEN', cursor: null }
      }
    })
    t.host.start()
    const v = await openViewer(t)
    const sink = t.sink()
    fail = true
    pty(sink, 's1', `${ESC}[H`) // settles: the follow-up capture fails
    await clock.advance(1_000)
    expect(v.keyframes()).toHaveLength(1)
    pty(sink, 's1', 'a')
    buffered = 600 * 1024
    pty(sink, 's1', 'dropped') // throttled; its repaint capture fails too
    buffered = 0
    await clock.advance(1_000)
    pty(sink, 's1', 'b')
    expect(v.keyframes()).toHaveLength(1)
    expect(v.log.pty).toEqual([`${ESC}[H`, 'a', 'b'])
  })

  it("one capture per session is shared by the link's viewers joining it together (R27)", async () => {
    const clock = manualClock()
    const releases: ((c: VisibleCapture) => void)[] = []
    const t = setup({ clock, capture: () => new Promise<VisibleCapture>((r) => releases.push(r)) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const a = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(t.calls).toContain('capture:s1'))
    await vi.waitFor(() => expect(t.peers).toHaveLength(2))
    const b = viewer(t.peers[1], t.keys)
    await vi.waitFor(() => expect(t.joinArgs).toHaveLength(2))
    await clock.flush()
    expect(t.calls.filter((c) => c === 'capture:s1')).toHaveLength(1)
    releases[0]({ screen: 'ONE', cursor: null })
    await vi.waitFor(() => expect(b.keyframes()).toHaveLength(1))
    expect(a.keyframes().map((k) => k.screen)).toEqual(['ONE'])
    expect(b.keyframes().map((k) => k.screen)).toEqual(['ONE'])
  })

  it('a keyframe asked for while a capture runs waits for a NEWER one; the stream resumes only on it', async () => {
    const clock = manualClock()
    const releases: ((c: VisibleCapture) => void)[] = []
    const t = setup({ clock, capture: () => new Promise<VisibleCapture>((r) => releases.push(r)) })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    // The 2 s bound asks for a keyframe while the join keyframe's capture is still running.
    await clock.advance(SETTLE_BOUND_MS)
    expect(releases).toHaveLength(1) // one capture in flight per session: the second is queued
    releases[0]({ screen: 'OLD', cursor: null })
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(v.keyframes().map((k) => k.screen)).toEqual(['OLD'])
    pty(t.sink(), 's1', `${ESC}[Hbetween`) // after the OLD paint, before the newer one: not forwarded
    expect(v.log.pty).toEqual([])
    releases[1]({ screen: 'NEW', cursor: null })
    await vi.waitFor(() => expect(v.keyframes().map((k) => k.screen)).toEqual(['OLD', 'NEW']))
    pty(t.sink(), 's1', 'after')
    expect(v.log.pty).toEqual(['after'])
  })
})

describe('createLinkHost — chat', () => {
  it('relays commenter chat, rate-limited and sanitized, to viewers and the owner', async () => {
    const t = setup({ role: 'commenter' })
    t.host.start()
    const v = await openViewer(t)
    expect(v.c.sendChat('Ada', 'hello\u0007')).toBe(true)
    expect(v.c.sendChat('Ada', 'again')).toBe(true) // inside 2 s: dropped by the host
    await vi.waitFor(() => expect(t.chats).toHaveLength(1))
    expect(t.chats[0]).toMatchObject({ name: 'Ada', text: 'hello', from: 'viewer' })
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.chat)).toHaveLength(1))
    expect(t.host.viewers()[0].name).toBe('Ada')
    expect(t.host.postSharerChat('hi back')).toMatchObject({ from: 'sharer', name: 'Ada', text: 'hi back' })
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.chat)).toHaveLength(2))
    expect(t.host.chatHistory()).toHaveLength(2)
  })

  it('a sharer cannot chat on a viewer link', async () => {
    const t = setup({ role: 'viewer' })
    expect(t.host.postSharerChat('hi')).toBeNull()
  })

  it('skips chat for a viewer over 512 KB behind, and closes one over 8 MB behind — no end, not a revoke (R28)', async () => {
    const buffered = [0, 0]
    const t = setup({ role: 'commenter', buffered: (i) => buffered[i] ?? 0 })
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    expect(t.host.viewers()).toHaveLength(2)
    const aId = t.host.viewers()[0].viewerId
    buffered[0] = 600 * 1024
    t.host.postSharerChat('one')
    await vi.waitFor(() => expect(b.named(WATCH_EVENT.chat)).toHaveLength(1))
    expect(a.named(WATCH_EVENT.chat)).toHaveLength(0)
    buffered[0] = 9 * 1024 * 1024
    t.host.postSharerChat('two')
    await vi.waitFor(() => expect(b.named(WATCH_EVENT.chat)).toHaveLength(2))
    await vi.waitFor(() => expect(a.log.closed).toBe(1))
    expect(a.named(WATCH_EVENT.end)).toEqual([])
    expect(t.host.viewers().map((x) => x.viewerId)).not.toContain(aId)
    expect(t.left).toContain(`s1/${aId}`)
    expect(t.gone).toEqual([])
  })
})

describe('createLinkHost — ending', () => {
  it('kick ends one viewer with a reason; stop ends everyone, leaves the pty and mints nothing (F1)', async () => {
    const t = setup()
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    await vi.waitFor(() => expect(t.host.viewers()).toHaveLength(2))
    await vi.waitFor(() => expect(t.peers).toHaveLength(3))
    expect(t.host.kick(t.host.viewers()[0].viewerId)).toBe(true)
    expect(t.host.kick('v-nobody0')).toBe(false)
    await vi.waitFor(() => expect(a.named(WATCH_EVENT.end)).toEqual([{ reason: 'kicked' }]))
    await new Promise((r) => setTimeout(r, 10))
    const minted = t.mints()
    t.host.stop('revoked')
    await vi.waitFor(() => expect(b.named(WATCH_EVENT.end)).toEqual([{ reason: 'revoked' }]))
    await new Promise((r) => setTimeout(r, 20))
    expect(t.mints()).toBe(minted)
    expect(t.left).toHaveLength(2)
    expect(t.sinks.size).toBe(0)
    expect(t.host.viewers()).toEqual([])
  })

  it('start after stop is a no-op (F26)', async () => {
    const t = setup()
    t.host.stop('revoked')
    t.host.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.mints()).toBe(0)
    expect(t.peers).toHaveLength(0)
  })

  it('a 410 from the host-token route ends the link as gone', async () => {
    const t = setup({ mint: async () => ({ ok: false, kind: 'gone', reason: 'expired' }) })
    t.host.start()
    await vi.waitFor(() => expect(t.gone).toEqual(['expired']))
  })

  it('a peer that never confirms is closed at the confirm deadline, freeing its slot (R31)', async () => {
    const clock = manualClock()
    const t = setup({ clock })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    let closed = 0
    connectRelay({
      url: 'x', token: 'x', role: 'client', theirPubB64: publicKeyToB64(t.keys.host.publicKey),
      ourKeys: { publicKey: t.keys.viewer.publicKey, secretKey: t.keys.viewer.secretKey },
      transport: t.peers[0], onReady: () => {}, onRpc: () => {}, onFrame: () => {},
      onClose: () => { closed++ }
    })
    await vi.waitFor(() => expect(t.peers).toHaveLength(2)) // bridged: a replacement opened
    await clock.advance(CONFIRM_DEADLINE_MS - 1)
    expect(closed).toBe(0)
    await clock.advance(1)
    expect(closed).toBe(1)
    expect(t.sinks.size).toBe(0)
    // A confirming viewer on the replacement is not affected by that deadline.
    const v = viewer(t.peers[1], t.keys)
    await vi.waitFor(() => expect(v.keyframes()).toHaveLength(1))
    await clock.advance(CONFIRM_DEADLINE_MS)
    expect(t.host.viewers()).toHaveLength(1)
  })

  it('a full link opens no 11th listener and polls status; a server-side revoke ends it', async () => {
    const clock = manualClock()
    let state: 'live' | 'revoked' = 'live'
    const status = vi.fn(async () => state)
    const t = setup({ clock, status })
    t.host.start()
    const vs: Viewer[] = []
    for (let i = 0; i < MAX_VIEWERS_PER_LINK; i++) vs.push(await openViewer(t, i))
    await clock.flush()
    expect(t.peers).toHaveLength(MAX_VIEWERS_PER_LINK) // no idle listener while full
    await clock.advance(FULL_STATUS_POLL_MS)
    expect(status).toHaveBeenCalledTimes(1)
    expect(t.gone).toEqual([])
    state = 'revoked'
    // On a FULL link any viewer ending while the scheduler still runs would re-mint a listener: the
    // revoke's stop must end them only after the scheduler stopped (F1, R37).
    const minted = t.mints()
    await clock.advance(FULL_STATUS_POLL_MS)
    expect(status).toHaveBeenCalledTimes(2)
    expect(t.gone).toEqual(['revoked'])
    for (const v of vs) expect(v.named(WATCH_EVENT.end)).toEqual([{ reason: 'revoked' }])
    await clock.advance(60_000)
    expect(t.mints()).toBe(minted)
    expect(t.peers).toHaveLength(MAX_VIEWERS_PER_LINK)
  })

  it('stop on a full link with a viewer over 8 MiB behind mints nothing; that viewer is closed without an end (R37)', async () => {
    const clock = manualClock()
    const buffered: number[] = []
    const t = setup({ clock, buffered: (i) => buffered[i] ?? 0 })
    t.host.start()
    const vs: Viewer[] = []
    for (let i = 0; i < MAX_VIEWERS_PER_LINK; i++) vs.push(await openViewer(t, i))
    await clock.flush()
    const minted = t.mints()
    buffered[3] = 9 * 1024 * 1024
    t.host.stop('revoked')
    await clock.advance(60_000)
    expect(t.mints()).toBe(minted)
    expect(vs[3].named(WATCH_EVENT.end)).toEqual([])
    await vi.waitFor(() => expect(vs[3].log.closed).toBe(1))
    vs.forEach((v, i) => {
      if (i !== 3) expect(v.named(WATCH_EVENT.end)).toEqual([{ reason: 'revoked' }])
    })
    expect(t.sinks.size).toBe(0)
    expect(t.left).toHaveLength(MAX_VIEWERS_PER_LINK)
  })
})

/** A raw relay client with the link's viewer key: it sends whatever casts the test chooses (the real
 *  client cannot send a malformed one), and records every event the host sends it. */
function rawPeer(t: Setup, n = 0) {
  const events: [string, unknown[]][] = []
  let hostConfirmed = false
  let closed = 0
  const raw = connectRelay({
    url: 'x', token: 'x', role: 'client', theirPubB64: publicKeyToB64(t.keys.host.publicKey),
    ourKeys: { publicKey: t.keys.viewer.publicKey, secretKey: t.keys.viewer.secretKey },
    transport: t.peers[n], onReady: () => {}, onRpc: () => {}, onFrame: () => {},
    onClose: () => { closed++ },
    onTunnel: (kind, p) => {
      if (kind !== 'text') return
      const m = parseRpcMessage(new TextDecoder().decode(p))
      if (m?.t === 'cast' && m.method === 'trust:confirm') hostConfirmed = true
      if (m?.t === 'ev') events.push([m.channel, m.args])
    }
  })
  return {
    hostConfirmed: () => hostConfirmed,
    closed: () => closed,
    confirm: () => raw.sendTunnelText(TRUST_CONFIRM),
    cast: (method: string, args: unknown[]) => raw.sendTunnelText(JSON.stringify({ t: 'cast', method, args })),
    named: (ch: string) => events.filter((e) => e[0] === ch).map((e) => e[1][0])
  }
}
type RawPeer = ReturnType<typeof rawPeer>
/** Open the n-th listener with a raw peer, confirm, and wait for its first keyframe. */
async function openRaw(t: Setup, n = 0): Promise<RawPeer> {
  await vi.waitFor(() => expect(t.peers.length).toBeGreaterThan(n))
  const p = rawPeer(t, n)
  await vi.waitFor(() => expect(p.hostConfirmed()).toBe(true))
  p.confirm()
  await vi.waitFor(() => expect(p.named(WATCH_EVENT.keyframe).length).toBeGreaterThanOrEqual(1))
  return p
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const settleReal = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** A pane delivery whose FIRST call waits for `release()` (true); every later call answers true. */
function holdFirst() {
  const held = deferred<boolean>()
  let first = true
  return {
    input: (): Promise<boolean> | boolean => {
      if (!first) return true
      first = false
      return held.promise
    },
    release: () => held.resolve(true)
  }
}

// A Control link: unlocking with the link's password, the host-side throttles and the lock. The
// password check is the real scrypt one (`verifyControlPassword` against `record.control`, read at
// call time, as the service does), so a wait for an answer is a wait on real time.
const PW = 'hunter2hunter2'
const WRONG = 'not-the-password'

describe('createLinkHost — control', () => {
  let HASH: ControlPasswordHash
  beforeAll(async () => {
    HASH = await hashControlPassword(PW)
  })
  const ctl = (over: Partial<WatchLinkControlRecord> = {}): WatchLinkControlRecord => ({ enabled: true, locked: false, wrong: 0, ...HASH, ...over })
  const controlOf = (v: Viewer | RawPeer): WatchControlEvent[] => v.named(WATCH_EVENT.control) as WatchControlEvent[]
  const metaOf = (v: Viewer, n = 0): WatchMeta => v.named(WATCH_EVENT.meta)[n] as WatchMeta
  /** Send one cast and wait for the `watch:control` that answers it. */
  async function ask(v: Viewer | RawPeer, send: () => unknown): Promise<WatchControlEvent> {
    const before = controlOf(v).length
    const sent = send()
    if (typeof sent === 'boolean') expect(sent).toBe(true)
    await vi.waitFor(() => expect(controlOf(v).length).toBeGreaterThan(before), { timeout: 5_000 })
    return controlOf(v)[before]
  }
  const unlock = (v: Viewer, name: string, pw: unknown): Promise<WatchControlEvent> =>
    ask(v, () => v.c.unlock(name, pw as string))
  const rawUnlock = (p: RawPeer, args: unknown[]): Promise<WatchControlEvent> => ask(p, () => p.cast(WATCH_UNLOCK_CAST, args))
  const controller = (o: SetupOpts = {}): Setup => setup({ role: 'controller', control: ctl(), ...o })

  // --- meta -------------------------------------------------------------------------------------------

  it('meta.control is available on a Control link with typing on, and absent on viewer and commenter links', async () => {
    const t = controller()
    t.host.start()
    const v = await openViewer(t)
    expect(metaOf(v)).toMatchObject({ role: 'controller' })
    expect(metaOf(v).control).toEqual({ state: 'available' })
    for (const role of ['viewer', 'commenter'] as const) {
      const o = setup({ role })
      o.host.start()
      const w = await openViewer(o)
      expect(metaOf(w)).toMatchObject({ role })
      expect('control' in metaOf(w)).toBe(false)
    }
  })

  it('meta.control is off when typing is off and locked when the link is locked; locked wins over off', async () => {
    const cases: { control: WatchLinkControlRecord; want: WatchControlEvent }[] = [
      { control: ctl({ enabled: false }), want: { state: 'off' } },
      { control: ctl({ locked: true }), want: { state: 'locked' } },
      { control: ctl({ enabled: false, locked: true }), want: { state: 'locked' } }
    ]
    for (const c of cases) {
      const t = controller({ control: c.control })
      t.host.start()
      const v = await openViewer(t)
      expect(metaOf(v).control).toEqual(c.want)
    }
  })

  it('meta.control says controlling on a rejoin while this viewer controls: control is per connection, not per session', async () => {
    const clock = manualClock()
    let n = 0
    const t = controller({ clock, join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
    t.host.start()
    const v = await openViewer(t)
    expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'controlling' })
    ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
    await clock.flush()
    await clock.advance(REJOIN_BACKOFF_MS[0])
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.meta)).toHaveLength(2))
    expect(metaOf(v, 1).control).toEqual({ state: 'controlling' })
    // A viewer that never unlocked joins the same link as `available`.
    const w = await openViewer(t, 1)
    expect(metaOf(w).control).toEqual({ state: 'available' })
  })

  // --- watch:unlock -----------------------------------------------------------------------------------

  it('an unlock sent before the viewer joined is ignored, even with the right password: no answer, no verification', async () => {
    const t = controller()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const p = rawPeer(t, 0)
    await vi.waitFor(() => expect(p.hostConfirmed()).toBe(true))
    p.cast(WATCH_UNLOCK_CAST, [{ name: 'Ada', password: PW }]) // before our own confirm: not joined
    p.confirm()
    await vi.waitFor(() => expect(p.named(WATCH_EVENT.keyframe)).toHaveLength(1))
    await settleReal()
    expect(controlOf(p)).toEqual([])
    expect(t.verifies()).toBe(0)
    expect(t.host.viewers().map((x) => x.controlling)).toEqual([false])
  })

  it('a malformed unlock is answered wrong and COUNTED, with no verification — a 129-code-point password included', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    // Through the real client: a name that does not survive sanitizing, a password that is not a
    // string, a password one code point too long. Three of them end the connection.
    const v = await openViewer(t, 0)
    expect(await unlock(v, '\u202e', PW)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', 12345678)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', 'a'.repeat(129))).toEqual({ state: 'available', reason: 'wrong' })
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.end)).toEqual([{ reason: 'attempts' }]))
    expect(t.verifies()).toBe(0)
    // Through a raw peer: no payload object at all, and 129 code points spelled as surrogate pairs.
    const p = await openRaw(t, 1)
    expect(await rawUnlock(p, [5])).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await rawUnlock(p, [{ name: 'Ada', password: '\u{1F600}'.repeat(129) }])).toEqual({ state: 'available', reason: 'wrong' })
    expect(t.verifies()).toBe(0)
    // 128 code points is a password (256 UTF-16 units): it is verified, and is wrong.
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await rawUnlock(p, [{ name: 'Ada', password: '\u{1F600}'.repeat(128) }])).toEqual({ state: 'available', reason: 'wrong' })
    expect(t.verifies()).toBe(1)
    await vi.waitFor(() => expect(p.named(WATCH_EVENT.end)).toEqual([{ reason: 'attempts' }]))
    expect(t.taken).toEqual([])
  })

  it("an attempt within 2 s of this viewer's previous one is too-soon and NOT counted", async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const v = await openViewer(t)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS - 1)
    expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'available', reason: 'too-soon' })
    expect(t.verifies()).toBe(1)
    await clock.advance(1)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    // Two counted wrong attempts: still connected (the too-soon one did not count).
    await settleReal()
    expect(t.host.viewers()).toHaveLength(1)
    expect(v.named(WATCH_EVENT.end)).toEqual([])
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.end)).toEqual([{ reason: 'attempts' }]))
  })

  it("an attempt while another verification for this link is in flight is too-soon, and not verified", async () => {
    const held = deferred<boolean>()
    let calls = 0
    const t = controller({
      verifyPassword: (pw) => (++calls === 1 ? held.promise : verifyControlPassword(pw, HASH))
    })
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    expect(a.c.unlock('Ada', PW)).toBe(true)
    await vi.waitFor(() => expect(t.verifies()).toBe(1))
    expect(await unlock(b, 'Bob', PW)).toEqual({ state: 'available', reason: 'too-soon' })
    expect(t.verifies()).toBe(1)
    held.resolve(false)
    await vi.waitFor(() => expect(controlOf(a)).toEqual([{ state: 'available', reason: 'wrong' }]))
    // The flight is over: Bob's next attempt (his previous was not stamped) is verified.
    expect(await unlock(b, 'Bob', PW)).toEqual({ state: 'controlling' })
    expect(t.verifies()).toBe(2)
  })

  it('a locked link answers locked and an off link answers off, without verifying or counting', async () => {
    const clock = manualClock()
    for (const c of [{ control: ctl({ locked: true }), want: { state: 'locked', reason: 'locked' } }, { control: ctl({ enabled: false }), want: { state: 'off', reason: 'off' } }]) {
      const t = controller({ clock, control: c.control })
      t.host.start()
      const v = await openViewer(t)
      for (let i = 0; i < WRONG_PER_CONN + 1; i++) {
        expect(await unlock(v, 'Ada', i % 2 ? PW : WRONG)).toEqual(c.want)
        await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      }
      expect(t.verifies()).toBe(0)
      expect(v.named(WATCH_EVENT.end)).toEqual([])
      expect(t.host.viewers()).toHaveLength(1)
      t.host.stop('revoked')
    }
  })

  it('an unlock from a viewer already controlling answers controlling and does nothing else', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const v = await openViewer(t)
    expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'controlling' })
    const changes = t.changes()
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Eve', WRONG)).toEqual({ state: 'controlling' })
    expect(t.verifies()).toBe(1)
    expect(t.taken).toEqual(['Ada'])
    expect(t.changes()).toBe(changes)
    expect(t.host.viewers()[0]).toMatchObject({ name: 'Ada', controlling: true })
  })

  it('a wrong password answers available/wrong; the third on one connection ends it with `attempts`', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const v = await openViewer(t)
    for (let i = 0; i < WRONG_PER_CONN; i++) {
      if (i > 0) await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    }
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.end)).toEqual([{ reason: 'attempts' }]))
    await vi.waitFor(() => expect(v.log.closed).toBe(1))
    expect(t.host.viewers()).toEqual([])
    expect(t.verifies()).toBe(WRONG_PER_CONN)
    expect(t.taken).toEqual([])
    expect(t.locks()).toBe(0)
  })

  it('the right password makes this viewer controlling under its sanitized name, tells the owner, and resets its own wrong count', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const v = await openViewer(t)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    const changes = t.changes()
    expect(await unlock(v, '  Ada\u202e  Lovelace\t', PW)).toEqual({ state: 'controlling' })
    expect(t.taken).toEqual(['Ada Lovelace'])
    expect(t.changes()).toBeGreaterThan(changes)
    expect(t.host.viewers()).toEqual([
      expect.objectContaining({ name: 'Ada Lovelace', controlling: true, typing: false })
    ])
    // Two wrong before the success; after it (and a release) two more do not end the connection.
    expect(await ask(v, () => v.c.release())).toEqual({ state: 'available' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await settleReal()
    expect(v.named(WATCH_EVENT.end)).toEqual([])
    expect(t.host.viewers()).toHaveLength(1)
  })

  it('a verification is re-checked after its await: control turned off meanwhile is no success', async () => {
    const held = deferred<boolean>()
    const t = controller({ verifyPassword: () => held.promise })
    t.host.start()
    const v = await openViewer(t)
    expect(v.c.unlock('Ada', PW)).toBe(true)
    await vi.waitFor(() => expect(t.verifies()).toBe(1))
    t.record.control!.enabled = false
    t.host.controlChanged()
    await vi.waitFor(() => expect(controlOf(v)).toEqual([{ state: 'off' }]))
    held.resolve(true)
    await vi.waitFor(() => expect(controlOf(v)).toEqual([{ state: 'off' }, { state: 'off', reason: 'off' }]))
    expect(t.taken).toEqual([])
    expect(t.host.viewers()[0].controlling).toBe(false)
  })

  it('a verification is re-checked after its await: a password change, a kicked viewer or a stopped host meanwhile is no success', async () => {
    // The password changed while the old one was being checked: the old one must not open it.
    {
      const held = deferred<boolean>()
      const t = controller({ verifyPassword: () => held.promise })
      t.host.start()
      const v = await openViewer(t)
      expect(v.c.unlock('Ada', PW)).toBe(true)
      await vi.waitFor(() => expect(t.verifies()).toBe(1))
      t.host.passwordChanged()
      held.resolve(true)
      // A verification that raced a change is void, not wrong: not counted, and the viewer may retry.
      await vi.waitFor(() => expect(controlOf(v)).toEqual([{ state: 'available', reason: 'too-soon' }]))
      expect(t.taken).toEqual([])
      expect(t.host.viewers()[0].controlling).toBe(false)
    }
    for (const end of ['kick', 'stop'] as const) {
      const held = deferred<boolean>()
      const t = controller({ verifyPassword: () => held.promise })
      t.host.start()
      const v = await openViewer(t)
      expect(v.c.unlock('Ada', PW)).toBe(true)
      await vi.waitFor(() => expect(t.verifies()).toBe(1))
      if (end === 'kick') t.host.kick(t.host.viewers()[0].viewerId)
      else t.host.stop('revoked')
      held.resolve(true)
      await settleReal()
      expect(t.taken).toEqual([])
      expect(controlOf(v)).toEqual([])
    }
  })

  // --- the link-wide lock -----------------------------------------------------------------------------

  it('the 10th wrong attempt across the link locks it once: every viewer is told, controllers are demoted, the 11th is not verified', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const ada = await openViewer(t, 0)
    let n = 1
    /** A fresh viewer for each three wrong attempts (three end a connection). */
    const attacker = async (attempts: number): Promise<Viewer> => {
      const v = await openViewer(t, n++)
      for (let i = 0; i < attempts; i++) {
        await clock.advance(UNLOCK_MIN_INTERVAL_MS)
        expect(await unlock(v, 'Eve', `${WRONG}-${i}`)).toEqual({ state: 'available', reason: 'wrong' })
      }
      return v
    }
    await attacker(3)
    // Ada unlocks after three wrong attempts: a success does not reset the LINK's count.
    expect(await unlock(ada, 'Ada', PW)).toEqual({ state: 'controlling' })
    await attacker(3)
    await attacker(3)
    expect(t.locks()).toBe(0)
    const eve = await openViewer(t, n++)
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    const before = controlOf(eve).length
    expect(eve.c.unlock('Eve', WRONG)).toBe(true)
    await vi.waitFor(() => expect(controlOf(eve).slice(before)).toEqual([
      { state: 'available', reason: 'wrong' },
      { state: 'locked', reason: 'locked' }
    ]))
    expect(t.locks()).toBe(1)
    expect(t.record.control!.locked).toBe(true)
    await vi.waitFor(() => expect(controlOf(ada).at(-1)).toEqual({ state: 'locked', reason: 'locked' }))
    expect(t.host.viewers().find((x) => x.name === 'Ada')!.controlling).toBe(false)
    // The 11th attempt — the right password, even — is answered locked and never verified.
    const verified = t.verifies()
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(eve, 'Eve', PW)).toEqual({ state: 'locked', reason: 'locked' })
    expect(t.verifies()).toBe(verified)
    expect(t.locks()).toBe(1)
    expect(t.taken).toEqual(['Ada'])
  }, 20_000) // eleven real scrypt checks

  it('allowControl resets the link count and tells every viewer it is available again', async () => {
    const clock = manualClock()
    const t = controller({ clock, verifyPassword: async (pw) => pw === PW })
    t.host.start()
    const watcher = await openViewer(t, 0)
    let n = 1
    for (let wrong = 0; wrong < WRONG_PER_LINK; ) {
      const v = await openViewer(t, n++)
      for (let i = 0; i < WRONG_PER_CONN && wrong < WRONG_PER_LINK; i++, wrong++) {
        await clock.advance(UNLOCK_MIN_INTERVAL_MS)
        await unlock(v, 'Eve', WRONG)
      }
    }
    expect(t.locks()).toBe(1)
    await vi.waitFor(() => expect(controlOf(watcher).at(-1)).toEqual({ state: 'locked', reason: 'locked' }))
    // The service clears the lock, then tells the host.
    t.record.control!.locked = false
    const changes = t.changes()
    t.host.allowControl()
    await vi.waitFor(() => expect(controlOf(watcher).at(-1)).toEqual({ state: 'available' }))
    expect(t.changes()).toBeGreaterThan(changes)
    // The count was reset: one more wrong attempt does not lock again.
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(watcher, 'Eve', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    expect(t.locks()).toBe(1)
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(watcher, 'Ada', PW)).toEqual({ state: 'controlling' })
  })

  // Final review, Minor 2: the link-wide wrong count is the service's to keep (persisted beside
  // `locked`), so an app restart no longer hands out nine fresh guesses. The host starts from the
  // record's count and reports every new one.
  it('the link-wide count starts from the record: a host built from a record at 9 (a restart) locks on its next wrong attempt', async () => {
    const clock = manualClock()
    const t = controller({ clock, control: ctl({ wrong: WRONG_PER_LINK - 1 }), verifyPassword: async (pw) => pw === PW })
    t.host.start()
    const v = await openViewer(t, 0)
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    const before = controlOf(v).length
    expect(v.c.unlock('Eve', WRONG)).toBe(true)
    await vi.waitFor(() => expect(controlOf(v).slice(before)).toEqual([
      { state: 'available', reason: 'wrong' },
      { state: 'locked', reason: 'locked' }
    ]))
    expect(t.locks()).toBe(1)
    expect(t.wrongs).toEqual([WRONG_PER_LINK])
  })

  it('every wrong attempt reports the new link-wide count, from the one the record holds', async () => {
    const clock = manualClock()
    const t = controller({ clock, control: ctl({ wrong: 4 }), verifyPassword: async (pw) => pw === PW })
    t.host.start()
    const v = await openViewer(t, 0)
    for (let i = 0; i < 2; i++) {
      await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      expect(await unlock(v, 'Eve', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    }
    // A malformed attempt counts too.
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Eve', '')).toEqual({ state: 'available', reason: 'wrong' })
    expect(t.wrongs).toEqual([5, 6, 7])
    expect(t.record.control!.wrong).toBe(7)
    expect(t.locks()).toBe(0)
  })

  it('a password change resets the link-wide count: a host at 9 does not lock on the next wrong attempt', async () => {
    const clock = manualClock()
    const t = controller({ clock, control: ctl({ wrong: WRONG_PER_LINK - 1 }), verifyPassword: async (pw) => pw === PW })
    t.host.start()
    const v = await openViewer(t, 0)
    t.record.control!.wrong = 0 // what the service does with the new hash
    t.host.passwordChanged()
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Eve', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    expect(t.locks()).toBe(0)
    expect(t.wrongs).toEqual([1])
  })

  it('a record count outside 0..10 (a hand edit) is read as the nearest bound, never as more guesses', async () => {
    for (const [wrong, next] of [[-5, 1], [Number.NaN, 1], [1.5, 2], [99, WRONG_PER_LINK]] as const) {
      const clock = manualClock()
      const t = controller({ clock, control: ctl({ wrong }), verifyPassword: async (pw) => pw === PW })
      t.host.start()
      const v = await openViewer(t, 0)
      await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      await unlock(v, 'Eve', WRONG)
      expect(t.wrongs, String(wrong)).toEqual([next])
      t.host.stop('revoked')
    }
  })

  // --- release and the owner's changes ----------------------------------------------------------------

  it('release drops a controller back to available; from anyone else it is ignored', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    expect(await unlock(a, 'Ada', PW)).toEqual({ state: 'controlling' })
    const changes = t.changes()
    expect(await ask(a, () => a.c.release())).toEqual({ state: 'available' })
    expect(t.changes()).toBeGreaterThan(changes)
    expect(t.host.viewers().map((x) => x.controlling)).toEqual([false, false])
    const after = t.changes()
    expect(b.c.release()).toBe(true)
    expect(a.c.release()).toBe(true) // released already
    await settleReal()
    expect(controlOf(b)).toEqual([])
    expect(controlOf(a)).toHaveLength(2)
    expect(t.changes()).toBe(after)
    expect(t.host.viewers()).toHaveLength(2)
  })

  it('controlChanged: turned off demotes every controller and tells every viewer off; turned on, available', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    expect(await unlock(a, 'Ada', PW)).toEqual({ state: 'controlling' })
    let changes = t.changes()
    t.record.control!.enabled = false
    t.host.controlChanged()
    await vi.waitFor(() => expect(controlOf(b)).toEqual([{ state: 'off' }]))
    expect(controlOf(a).at(-1)).toEqual({ state: 'off' })
    expect(t.host.viewers().map((x) => x.controlling)).toEqual([false, false])
    expect(t.changes()).toBeGreaterThan(changes)
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(a, 'Ada', PW)).toEqual({ state: 'off', reason: 'off' })
    changes = t.changes()
    t.record.control!.enabled = true
    t.host.controlChanged()
    await vi.waitFor(() => expect(controlOf(b)).toEqual([{ state: 'off' }, { state: 'available' }]))
    expect(controlOf(a).at(-1)).toEqual({ state: 'available' })
    expect(t.changes()).toBeGreaterThan(changes)
  })

  it('passwordChanged demotes every controller and tells each one available; the old password no longer opens it', async () => {
    const clock = manualClock()
    const t = controller({ clock })
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    expect(await unlock(a, 'Ada', PW)).toEqual({ state: 'controlling' })
    // What the service does: swap the hash, then tell the host.
    Object.assign(t.record.control!, await hashControlPassword('a-new-password'))
    const changes = t.changes()
    t.host.passwordChanged()
    await vi.waitFor(() => expect(controlOf(a).at(-1)).toEqual({ state: 'available' }))
    expect(t.host.viewers().map((x) => x.controlling)).toEqual([false, false])
    expect(t.changes()).toBeGreaterThan(changes)
    await settleReal()
    expect(controlOf(b)).toEqual([]) // never controlling: nothing to tell it
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(a, 'Ada', PW)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(a, 'Ada', 'a-new-password')).toEqual({ state: 'controlling' })
  })

  // --- chat and input ----------------------------------------------------------------------------------

  it('chat works on a Control link as on a Commenter link, both ways', async () => {
    const t = controller()
    t.host.start()
    const v = await openViewer(t)
    expect(v.c.sendChat('Ada', 'hello')).toBe(true)
    await vi.waitFor(() => expect(t.chats).toHaveLength(1))
    expect(t.chats[0]).toMatchObject({ name: 'Ada', text: 'hello', from: 'viewer' })
    expect(t.host.postSharerChat('hi back')).toMatchObject({ from: 'sharer', text: 'hi back' })
    await vi.waitFor(() => expect(v.named(WATCH_EVENT.chat)).toHaveLength(2))
    expect(t.host.viewers()).toHaveLength(1)
  })

  it('input from a viewer that is not controlling closes it; from a controller it reaches the pane; after a release it is dropped for 5 s, then a breach', async () => {
    const clock = manualClock()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = controller({ clock })
    t.host.start()
    const a = await openViewer(t, 0)
    const b = await openViewer(t, 1)
    expect(b.c.sendInput('ls\r')).toBe(true)
    await vi.waitFor(() => expect(b.log.closed).toBe(1))
    expect(t.host.viewers()).toHaveLength(1)
    expect(await unlock(a, 'Ada', PW)).toEqual({ state: 'controlling' })
    expect(a.c.sendInput('ls\r')).toBe(true)
    await clock.advance(INPUT_BATCH_MS)
    await vi.waitFor(() => expect(t.inputs).toEqual([['s1', { kind: 'keys', data: 'ls\r' }]]))
    expect(a.log.closed).toBe(0)
    // Released: a keystroke still in flight is dropped, and the connection stays.
    expect(await ask(a, () => a.c.release())).toEqual({ state: 'available' })
    expect(a.c.sendInput('x')).toBe(true)
    await clock.advance(INPUT_GRACE_MS)
    expect(a.log.closed).toBe(0)
    expect(t.inputs).toHaveLength(1)
    // Past the grace it is a breach.
    await clock.advance(100)
    expect(a.c.sendInput('x')).toBe(true)
    await vi.waitFor(() => expect(a.log.closed).toBe(1))
    expect(t.host.viewers()).toEqual([])
    expect(t.inputs).toHaveLength(1)
  })

  it('on a Commenter link, unlock, input and release casts from a raw peer are refused before the host: nothing comes back, nothing is verified', async () => {
    const t = setup({ role: 'commenter' })
    t.host.start()
    const p = await openRaw(t, 0)
    p.cast(WATCH_UNLOCK_CAST, [{ name: 'Ada', password: PW }])
    p.cast(WATCH_INPUT_CAST, [{ data: 'ls\r' }])
    p.cast(WATCH_RELEASE_CAST, [])
    await settleReal(60)
    expect(controlOf(p)).toEqual([])
    expect(t.verifies()).toBe(0)
    // An input that reached the link host would have closed this viewer (a policy breach).
    expect(p.closed()).toBe(0)
    expect(t.host.viewers()).toHaveLength(1)
  })

  // --- hardening -----------------------------------------------------------------------------------

  it('a connection that ends on the success answer (backlog over 8 MiB) did not take control: no onControlTaken', async () => {
    const clock = manualClock()
    const held = deferred<boolean>()
    let buffered = 0
    const t = controller({ clock, verifyPassword: () => held.promise, buffered: () => buffered })
    t.host.start()
    const v = await openViewer(t)
    expect(v.c.unlock('Ada', PW)).toBe(true)
    await vi.waitFor(() => expect(t.verifies()).toBe(1))
    buffered = 9 * 1024 * 1024
    held.resolve(true)
    await vi.waitFor(() => expect(v.log.closed).toBe(1))
    expect(t.taken).toEqual([])
    expect(t.host.viewers()).toEqual([])
  })

  it('a lock the service failed to record is logged loudly once, and every viewer is still told and demoted', async () => {
    const clock = manualClock()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = controller({
      clock,
      verifyPassword: async (pw) => pw === PW,
      onControlLocked: () => {
        throw new Error('disk on fire')
      }
    })
    t.host.start()
    const ada = await openViewer(t, 0)
    expect(await unlock(ada, 'Ada', PW)).toEqual({ state: 'controlling' })
    let n = 1
    for (let wrong = 0; wrong < WRONG_PER_LINK; ) {
      const v = await openViewer(t, n++)
      for (let i = 0; i < WRONG_PER_CONN && wrong < WRONG_PER_LINK; i++, wrong++) {
        await clock.advance(UNLOCK_MIN_INTERVAL_MS)
        await unlock(v, 'Eve', WRONG)
      }
    }
    expect(t.locks()).toBe(1)
    expect(t.record.control!.locked).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toMatch(/onControlLocked did not lock the link/)
    // Nothing the viewers chose is in it: no name, no password.
    for (const arg of error.mock.calls[0]) {
      expect(String(arg)).not.toContain('Eve')
      expect(String(arg)).not.toContain(WRONG)
    }
    await vi.waitFor(() => expect(controlOf(ada).at(-1)).toEqual({ state: 'locked', reason: 'locked' }))
    expect(t.host.viewers().find((x) => x.name === 'Ada')!.controlling).toBe(false)
    expect(warn).toHaveBeenCalled() // the throw itself, through safe()
  })

  it('a password check that rejects is void: too-soon, not counted, and the next attempt after 2 s is verified', async () => {
    const clock = manualClock()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const t = controller({
      clock,
      verifyPassword: (pw) => (++calls === 1 ? Promise.reject(new Error('pool gone')) : verifyControlPassword(pw, HASH))
    })
    t.host.start()
    const v = await openViewer(t)
    expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'available', reason: 'too-soon' })
    expect(t.verifies()).toBe(1)
    // Two counted wrong attempts after it: still connected, so the rejected one was not counted.
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', WRONG)).toEqual({ state: 'available', reason: 'wrong' })
    await settleReal()
    expect(v.named(WATCH_EVENT.end)).toEqual([])
    // The flight was released: the next attempt is verified, and opens it.
    await clock.advance(UNLOCK_MIN_INTERVAL_MS)
    expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'controlling' })
    expect(t.verifies()).toBe(4)
  })

  it('viewers() reports the effective state: a controller of a link whose control went off is not controlling', async () => {
    const t = controller()
    t.host.start()
    const v = await openViewer(t)
    expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'controlling' })
    expect(t.host.viewers()[0].controlling).toBe(true)
    // The record changed, and the host has not been told yet.
    t.record.control!.enabled = false
    expect(t.host.viewers()[0].controlling).toBe(false)
    t.record.control!.enabled = true
    expect(t.host.viewers()[0].controlling).toBe(true)
  })

  // --- typing: the input path and the typing set ------------------------------------------------------

  describe('control typing', () => {
    /** A Control link whose password check is instant (the scrypt one is tested above). */
    const typist = (o: SetupOpts = {}): Setup => controller({ clock: manualClock(), verifyPassword: async (pw) => pw === PW, ...o })
    const dropped = (v: Viewer): WatchControlEvent[] => controlOf(v).filter((e) => e.reason === 'dropped')
    const typingOf = (v: Viewer): string[][] => (v.named(WATCH_EVENT.typing) as { names: string[] }[]).map((e) => e.names)
    /** Cast one input and let the host take it (the in-process transport delivers synchronously). */
    async function type(v: Viewer, data: string, clock: ManualClock): Promise<void> {
      expect(v.c.sendInput(data)).toBe(true)
      await clock.flush()
    }
    /** A typist link with one or more controllers, already unlocked. */
    async function controllers(names: string[], o: SetupOpts = {}) {
      const clock = o.clock ?? manualClock()
      const t = typist({ ...o, clock })
      t.host.start()
      const vs: Viewer[] = []
      for (let i = 0; i < names.length; i++) {
        const v = await openViewer(t, i)
        expect(await unlock(v, names[i], PW)).toEqual({ state: 'controlling' })
        vs.push(v)
      }
      return { t, clock, vs }
    }
    const delivered = (t: Setup): string[] =>
      t.inputs.map(([sid, c]) => `${sid}:${c.kind}:${c.kind === 'keys' ? c.data : c.text}`)

    it('a controller types `ls\\r`: one keys chunk to the joined session, after INPUT_BATCH_MS', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], 'l', clock)
      await type(vs[0], 's', clock)
      await type(vs[0], '\r', clock)
      await clock.advance(INPUT_BATCH_MS - 1)
      expect(t.inputs).toEqual([])
      await clock.advance(1)
      await vi.waitFor(() => expect(t.inputs).toEqual([['s1', { kind: 'keys', data: 'ls\r' }]]))
      expect(t.host.viewers()[0]).toMatchObject({ controlling: true, typing: true })
      expect(dropped(vs[0])).toEqual([])
    })

    it('a paste arrives as one paste chunk between the keys around it', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], `a${PASTE_START}echo 1\necho 2${PASTE_END}b`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:paste:echo 1\necho 2', 's1:keys:b']))
    })

    it('a lone Esc reaches the pane within one batch (it is held as a marker prefix, then drained)', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], ESC, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual([`s1:keys:${ESC}`]))
    })

    it("a non-controlling viewer's input closes it and delivers nothing", async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const b = await openViewer(t, 1)
      await type(b, 'rm -rf ~\r', clock)
      await vi.waitFor(() => expect(b.log.closed).toBe(1))
      await clock.advance(INPUT_BATCH_MS)
      expect(t.inputs).toEqual([])
      expect(vs[0].log.closed).toBe(0)
    })

    it('malformed input from a controller is a breach: not a string, empty, or over INPUT_MAX', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      for (const args of [[{ data: 5 }], [{ data: '' }], [{ data: 'x'.repeat(INPUT_MAX + 1) }], [null], []]) {
        const clock = manualClock()
        const t = typist({ clock })
        t.host.start()
        const p = await openRaw(t, 0)
        p.cast(WATCH_UNLOCK_CAST, [{ name: 'Ada', password: PW }])
        await vi.waitFor(() => expect(controlOf(p)).toEqual([{ state: 'controlling' }]))
        p.cast(WATCH_INPUT_CAST, args)
        await vi.waitFor(() => expect(p.closed()).toBe(1))
        await clock.advance(INPUT_BATCH_MS)
        expect(t.inputs).toEqual([])
        t.host.stop('revoked')
      }
    })

    it("a terminal's own answer (DA) is dropped, never counted against the budget, and is not typing", async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], `${ESC}[?1;2c`, clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(t.inputs).toEqual([])
      expect(t.host.viewers()[0].typing).toBe(false)
      // Well past the burst in answers, and a keystroke still goes through.
      const answers = `${ESC}[?1;2c`.repeat(INPUT_MAX / 8)
      for (let i = 0; i < 20; i++) await type(vs[0], answers, clock)
      await type(vs[0], 'x', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:x']))
      expect(dropped(vs[0])).toEqual([])
    })

    it('bucket: 300 KiB in one burst delivers INPUT_BURST, and sends ONE dropped notice', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      const total = 300 * 1024
      for (let sent = 0; sent < total; sent += INPUT_MAX) await type(vs[0], 'a'.repeat(Math.min(INPUT_MAX, total - sent)), clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs.reduce((n, [, c]) => n + (c.kind === 'keys' ? c.data.length : 0), 0)).toBe(INPUT_BURST))
      expect(dropped(vs[0])).toEqual([{ state: 'controlling', reason: 'dropped' }])
      expect(vs[0].log.closed).toBe(0)
      // The bucket refills at INPUT_RATE: a second's worth goes through again.
      await clock.advance(1000)
      await type(vs[0], 'b'.repeat(INPUT_RATE / 4), clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t).some((d) => d.startsWith('s1:keys:b'))).toBe(true))
    })

    it('a 1 MB paste over the budget is discarded whole (never typed as keys), and typing after it works', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      const body = `${PASTE_START}${'echo pwned\n'.repeat(96 * 1024)}${PASTE_END}`
      for (let i = 0; i < body.length; i += INPUT_MAX) await type(vs[0], body.slice(i, i + INPUT_MAX), clock)
      await clock.advance(INPUT_BATCH_MS)
      await clock.advance(1000)
      await type(vs[0], 'x', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:x']))
      expect(dropped(vs[0])).toHaveLength(1)
    })

    it("two controllers' batches arrive whole and in flush order", async () => {
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada', 'Bob'], {
        input: held.input
      })
      await type(vs[0], `a${PASTE_START}P${PASTE_END}b`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      await type(vs[1], 'z', clock)
      await clock.advance(INPUT_BATCH_MS)
      // Bob's batch waits behind Ada's, whose first chunk is still in the pane.
      expect(delivered(t)).toEqual(['s1:keys:a'])
      held.release()
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:paste:P', 's1:keys:b', 's1:keys:z']))
    })

    it('one controller types on while its previous batch is still in the pane: its input waits, then goes as one batch', async () => {
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada'], {
        input: held.input
      })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      for (const k of ['b', 'c', 'd']) {
        await type(vs[0], k, clock)
        await clock.advance(INPUT_BATCH_MS)
      }
      expect(delivered(t)).toEqual(['s1:keys:a'])
      held.release()
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:bcd']))
    })

    it('control turned off while a batch is pending: nothing delivered; a keystroke in flight is dropped and the viewer stays', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], 'x', clock)
      t.record.control!.enabled = false
      t.host.controlChanged()
      await type(vs[0], 'y', clock) // in flight when control went off
      await clock.advance(INPUT_BATCH_MS)
      await clock.advance(1000)
      expect(t.inputs).toEqual([])
      expect(vs[0].log.closed).toBe(0)
      expect(t.host.viewers()[0]).toMatchObject({ controlling: false, typing: false })
      expect(dropped(vs[0])).toEqual([])
    })

    it('a batch already queued behind another is not delivered once its sender lost control', async () => {
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada', 'Bob'], {
        input: held.input
      })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      await type(vs[1], 'z', clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(await ask(vs[1], () => vs[1].c.release())).toEqual({ state: 'available' })
      held.release()
      await clock.flush()
      await settleReal()
      expect(delivered(t)).toEqual(['s1:keys:a'])
    })

    it('every chunk re-reads the record: typing turned off in the record mid-batch stops the rest, even before the host is told', async () => {
      // The control period (`controlGen`) does not move until the host is told; the record is read
      // live. A chunk must not go out on the strength of the period alone.
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada'], { input: held.input })
      await type(vs[0], `a${PASTE_START}P${PASTE_END}b`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      t.record.control!.enabled = false // no controlChanged(): the host has not been told yet
      held.release()
      await clock.flush()
      await settleReal()
      expect(delivered(t)).toEqual(['s1:keys:a'])
    })

    it('the bucket holds across batches: after a whole burst was delivered, more input in the same second is dropped until it refills', async () => {
      // The pending-batch cap alone bounds ONE batch; only the bucket bounds the rate across batches.
      const { t, clock, vs } = await controllers(['Ada'])
      for (let sent = 0; sent < INPUT_BURST; sent += INPUT_MAX) await type(vs[0], 'a'.repeat(INPUT_MAX), clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs.reduce((n, [, c]) => n + (c.kind === 'keys' ? c.data.length : 0), 0)).toBe(INPUT_BURST))
      expect(dropped(vs[0])).toEqual([])
      // INPUT_BATCH_MS later the bucket holds ~1.3 KiB: 16 KiB more is over budget.
      await type(vs[0], 'b'.repeat(INPUT_MAX), clock)
      await clock.advance(INPUT_BATCH_MS)
      await settleReal()
      expect(delivered(t).some((d) => d.startsWith('s1:keys:b'))).toBe(false)
      expect(dropped(vs[0])).toEqual([{ state: 'controlling', reason: 'dropped' }])
      expect(vs[0].log.closed).toBe(0)
    })

    it('a batch queued from before a release is not delivered after the same viewer unlocks again', async () => {
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada', 'Bob'], {
        input: held.input
      })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      await type(vs[1], 'old', clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(await ask(vs[1], () => vs[1].c.release())).toEqual({ state: 'available' })
      await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      expect(await unlock(vs[1], 'Bob', PW)).toEqual({ state: 'controlling' })
      held.release()
      await type(vs[1], 'new', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:new']))
      // Voided by the release it was told about: no "dropped" on top.
      expect(dropped(vs[1])).toEqual([])
    })

    it('a batch already in the chain whose session ended is not typed into the next session', async () => {
      const held = holdFirst()
      let n = 0
      const { t, clock, vs } = await controllers(['Ada'], {
        join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }),
        input: held.input
      })
      await type(vs[0], `a${PASTE_START}P${PASTE_END}b`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      held.release()
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      expect(delivered(t)).toEqual(['s1:keys:a'])
    })

    it('a paste open when its session ended is discarded whole, even when its end arrives at the next session', async () => {
      let n = 0
      const { t, clock, vs } = await controllers(['Ada'], { join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
      await type(vs[0], `${PASTE_START}first half `, clock)
      ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      await type(vs[0], `second half${PASTE_END}ok`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s2:keys:ok']))
      // The pending batch was empty (the paste had not ended), and the paste was still lost: told.
      expect(dropped(vs[0])).toHaveLength(1)
    })

    it('in-flight input after a release is dropped silently; 5.1 s later it is a breach', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { t, clock, vs } = await controllers(['Ada'])
      expect(await ask(vs[0], () => vs[0].c.release())).toEqual({ state: 'available' })
      await type(vs[0], 'x', clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(vs[0].log.closed).toBe(0)
      expect(t.inputs).toEqual([])
      expect(dropped(vs[0])).toEqual([])
      await clock.advance(INPUT_GRACE_MS + 100)
      await type(vs[0], 'x', clock)
      await vi.waitFor(() => expect(vs[0].log.closed).toBe(1))
      expect(t.inputs).toEqual([])
    })

    it('the session changes (exit, then a rejoin to s2): the next input goes to s2', async () => {
      let n = 0
      const { t, clock, vs } = await controllers(['Ada'], { join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
      ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      expect(metaOf(vs[0], 1).control).toEqual({ state: 'controlling' })
      await type(vs[0], 'pwd\r', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s2:keys:pwd\r']))
    })

    it('no session (waiting): dropped with a notice, and nothing is delivered after a later join', async () => {
      let n = 0
      let refuse = false
      const { t, clock, vs } = await controllers(['Ada'], {
        join: () => (refuse ? null : { sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true })
      })
      refuse = true
      ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.waiting)).toHaveLength(1))
      await type(vs[0], 'held?\r', clock)
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      refuse = false
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      await clock.advance(INPUT_BATCH_MS * 10)
      expect(t.inputs).toEqual([])
    })

    it('a pending batch for a session that ended is dropped with a notice, never typed into the next one', async () => {
      let n = 0
      const { t, clock, vs } = await controllers(['Ada'], { join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
      await type(vs[0], 'x', clock)
      ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      await clock.advance(INPUT_BATCH_MS)
      expect(t.inputs).toEqual([])
    })

    it('a pane delivery answering false stops the batch and sends a dropped notice, at most one per DROPPED_NOTICE_MIN_MS', async () => {
      const { t, clock, vs } = await controllers(['Ada'], { input: () => false })
      await type(vs[0], `a${PASTE_START}P${PASTE_END}b`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      expect(delivered(t)).toEqual(['s1:keys:a'])
      await type(vs[0], 'c', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(2))
      expect(dropped(vs[0])).toHaveLength(1)
      await clock.advance(DROPPED_NOTICE_MIN_MS)
      await type(vs[0], 'd', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(2))
      expect(vs[0].log.closed).toBe(0)
    })

    it('a pane delivery that rejects counts as false, and nothing typed is logged', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { t, clock, vs } = await controllers(['Ada'], {
        input: () => Promise.reject(new Error('pane gone while typing hunter2-secret'))
      })
      await type(vs[0], 'hunter2-secret\r', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      expect(t.inputs).toHaveLength(1)
      for (const call of [...warn.mock.calls, ...error.mock.calls]) {
        for (const arg of call) expect(String(arg)).not.toContain('hunter2')
      }
    })

    it('typing: two controllers type, every viewer gets watch:typing names, at most once a second; after 4 s of silence, names []', async () => {
      const { t, clock, vs } = await controllers(['Ada', 'Bob'])
      const watcher = await openViewer(t, 2)
      const changes = t.changes()
      await type(vs[0], 'a', clock)
      await vi.waitFor(() => expect(typingOf(watcher)).toEqual([['Ada']]))
      expect(t.changes()).toBeGreaterThan(changes)
      // A burst inside one second is one event.
      for (let i = 0; i < 5; i++) {
        await clock.advance(100)
        await type(vs[1], 'b', clock)
        await type(vs[0], 'a', clock)
      }
      expect(typingOf(watcher)).toEqual([['Ada']])
      await clock.advance(TYPING_EVENT_MIN_MS)
      await vi.waitFor(() => expect(typingOf(watcher)).toHaveLength(2))
      expect([...typingOf(watcher)[1]].sort()).toEqual(['Ada', 'Bob'])
      for (const v of [...vs, watcher]) expect(typingOf(v).at(-1)!.sort()).toEqual(['Ada', 'Bob'])
      expect(t.host.viewers().map((x) => x.typing)).toEqual([true, true, false])
      // Silence: cleared within the window plus one tick, then no more timer work for typing.
      await clock.advance(TYPING_WINDOW_MS + TYPING_EVENT_MIN_MS)
      expect(typingOf(watcher).at(-1)).toEqual([])
      expect(t.host.viewers().map((x) => x.typing)).toEqual([false, false, false])
      const n = typingOf(watcher).length
      await clock.advance(10 * TYPING_EVENT_MIN_MS)
      expect(typingOf(watcher)).toHaveLength(n)
    })

    it('a controller that releases leaves the typing set at the next tick', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      const watcher = await openViewer(t, 1)
      await type(vs[0], 'a', clock)
      await vi.waitFor(() => expect(typingOf(watcher)).toEqual([['Ada']]))
      expect(await ask(vs[0], () => vs[0].c.release())).toEqual({ state: 'available' })
      expect(t.host.viewers()[0].typing).toBe(false)
      await clock.advance(TYPING_EVENT_MIN_MS)
      expect(typingOf(watcher)).toEqual([['Ada'], []])
    })

    it('a viewer that joins (or rejoins) while someone types gets the typing set right after its meta', async () => {
      let n = 0
      const { t, clock, vs } = await controllers(['Ada'], { join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true }) })
      await type(vs[0], 'a', clock)
      await vi.waitFor(() => expect(typingOf(vs[0])).toEqual([['Ada']]))
      const late = await openViewer(t, 1)
      const names = late.log.events.map((e) => e[0])
      const meta = names.indexOf(WATCH_EVENT.meta)
      expect(names[meta + 1]).toBe(WATCH_EVENT.typing)
      expect(typingOf(late)).toEqual([['Ada']])
      // A rejoin of the typist itself: the set rides its new meta too.
      ptyEvent(t.sink(0), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      const ev = vs[0].log.events.map((e) => e[0])
      expect(ev[ev.lastIndexOf(WATCH_EVENT.meta) + 1]).toBe(WATCH_EVENT.typing)
      // Nobody typing: no typing event after a meta.
      const quiet = typist()
      quiet.host.start()
      const q = await openViewer(quiet)
      expect(q.named(WATCH_EVENT.typing)).toEqual([])
    })

    it('ten typists at once (the most a link holds) are all named, within TYPING_NAMES_MAX', async () => {
      const names = Array.from({ length: TYPING_NAMES_MAX }, (_, i) => `N${i}`)
      const { clock, vs } = await controllers(names)
      for (const v of vs) await type(v, 'a', clock)
      await clock.advance(TYPING_EVENT_MIN_MS)
      expect(typingOf(vs[0]).at(-1)).toHaveLength(TYPING_NAMES_MAX)
    })

    it("an input route of 'none' (or none, or an unknown one, answered): meta says off/unsupported, and an unlock is refused with it, never counted", async () => {
      const cases: SetupOpts[] = [
        { route: 'none' },
        { route: 'missing' },
        { join: () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: true, input: 'zellij' as never }) }
      ]
      for (const o of cases) {
        const t = typist(o)
        t.host.start()
        const v = await openViewer(t)
        expect(metaOf(v).control).toEqual({ state: 'off', reason: 'unsupported' })
        // Answered as it stands: no throttle, no count, no verification.
        for (let i = 0; i < WRONG_PER_CONN + 1; i++) {
          expect(await unlock(v, 'Ada', PW)).toEqual({ state: 'off', reason: 'unsupported' })
        }
        expect(t.verifies()).toBe(0)
        expect(v.log.closed).toBe(0)
        expect(t.host.viewers()[0].controlling).toBe(false)
      }
    })

    it("a controller whose rejoin answers 'none' is demoted: its meta says unsupported, and input in flight is dropped", async () => {
      let n = 0
      const { t, clock, vs } = await controllers(['Ada'], {
        join: () => ({ sessionId: `s${++n}`, cols: 80, rows: 24, altScreen: true, input: n === 1 ? 'tmux' : 'none' })
      })
      ptyEvent(t.sink(), IPC.ptyExit('s1'), 0)
      await clock.flush()
      await clock.advance(REJOIN_BACKOFF_MS[0])
      await vi.waitFor(() => expect(vs[0].named(WATCH_EVENT.meta)).toHaveLength(2))
      expect(metaOf(vs[0], 1).control).toEqual({ state: 'off', reason: 'unsupported' })
      expect(t.host.viewers()[0].controlling).toBe(false)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await type(vs[0], 'x', clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(vs[0].log.closed).toBe(0)
      expect(t.inputs).toEqual([])
      // It stopped controlling at that join: past the grace, input is the breach it is from anyone.
      await clock.advance(INPUT_GRACE_MS + 100)
      await type(vs[0], 'x', clock)
      await vi.waitFor(() => expect(vs[0].log.closed).toBe(1))
      expect(t.inputs).toEqual([])
    })

    it('while the panes have not taken its last batch, a controller collects at most INPUT_BURST more; past it, dropped', async () => {
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada'], {
        input: held.input
      })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      // Inside the bucket (1 byte spent): 15 full casts.
      for (let i = 0; i < 15; i++) await type(vs[0], 'b'.repeat(INPUT_MAX), clock)
      expect(dropped(vs[0])).toEqual([])
      // A second later the bucket has room again, but the batch waiting for the pane is full.
      await clock.advance(1000)
      await type(vs[0], 'c'.repeat(INPUT_MAX), clock) // fills the batch to INPUT_BURST exactly
      await type(vs[0], 'd'.repeat(INPUT_MAX), clock) // over: dropped
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      held.release()
      await clock.advance(INPUT_BATCH_MS) // the batch's own timer, armed by the last accepted cast
      const size = (): number => t.inputs.reduce((n, [, c]) => n + (c.kind === 'keys' ? c.data.length : 0), 0)
      await vi.waitFor(() => expect(size()).toBe(1 + INPUT_BURST))
      await settleReal()
      expect(size()).toBe(1 + INPUT_BURST)
      expect(delivered(t).some((d) => d.includes('d'))).toBe(false)
    })

    // --- losing control: a password change and the lock take the same path as every other --------------

    it('a password change: the pending batch is not delivered, a keystroke in flight is dropped, the viewer stays and leaves the typing set; 5 s later input is a breach', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { t, clock, vs } = await controllers(['Ada'])
      const watcher = await openViewer(t, 1)
      await type(vs[0], 'a', clock)
      await vi.waitFor(() => expect(typingOf(watcher)).toEqual([['Ada']]))
      t.host.passwordChanged()
      await vi.waitFor(() => expect(controlOf(vs[0]).at(-1)).toEqual({ state: 'available' }))
      expect(t.host.viewers()[0]).toMatchObject({ controlling: false, typing: false })
      await type(vs[0], 'b', clock) // in flight when the password changed
      await clock.advance(INPUT_BATCH_MS)
      expect(t.inputs).toEqual([])
      expect(vs[0].log.closed).toBe(0)
      await clock.advance(TYPING_EVENT_MIN_MS)
      expect(typingOf(watcher).at(-1)).toEqual([])
      await clock.advance(INPUT_GRACE_MS)
      await type(vs[0], 'c', clock)
      await vi.waitFor(() => expect(vs[0].log.closed).toBe(1))
      expect(t.inputs).toEqual([])
    })

    it('a password change voids a batch queued in the chain, even after its sender unlocks with the new password', async () => {
      const held = holdFirst()
      let password = PW
      const { t, clock, vs } = await controllers(['Ada', 'Bob'], { input: held.input, verifyPassword: async (pw) => pw === password })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      await type(vs[1], 'old', clock)
      await clock.advance(INPUT_BATCH_MS)
      password = 'a-new-password'
      t.host.passwordChanged()
      await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      expect(await unlock(vs[1], 'Bob', 'a-new-password')).toEqual({ state: 'controlling' })
      held.release()
      await type(vs[1], 'new', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:new']))
      await settleReal()
      expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:new'])
    })

    it('the lock: a keystroke in flight is dropped and the controller stays; 5 s later input is a breach', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], 'a', clock)
      let n = 1
      for (let wrong = 0; wrong < WRONG_PER_LINK; ) {
        const v = await openViewer(t, n++)
        for (let i = 0; i < WRONG_PER_CONN && wrong < WRONG_PER_LINK; i++, wrong++) {
          await clock.advance(UNLOCK_MIN_INTERVAL_MS)
          await unlock(v, 'Eve', WRONG)
        }
      }
      expect(t.locks()).toBe(1)
      await vi.waitFor(() => expect(controlOf(vs[0]).at(-1)).toEqual({ state: 'locked', reason: 'locked' }))
      await type(vs[0], 'b', clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(vs[0].log.closed).toBe(0)
      await clock.advance(INPUT_GRACE_MS + 100)
      await type(vs[0], 'c', clock)
      await vi.waitFor(() => expect(vs[0].log.closed).toBe(1))
      // 'a' flushed (still controlling) during the first throttle wait; nothing after the lock did.
      expect(delivered(t)).toEqual(['s1:keys:a'])
    })

    it('malformed input inside the grace window is a silent drop too, not a breach', async () => {
      const clock = manualClock()
      const t = typist({ clock })
      t.host.start()
      const p = await openRaw(t, 0)
      p.cast(WATCH_UNLOCK_CAST, [{ name: 'Ada', password: PW }])
      await vi.waitFor(() => expect(controlOf(p)).toEqual([{ state: 'controlling' }]))
      p.cast(WATCH_RELEASE_CAST, [])
      await vi.waitFor(() => expect(controlOf(p)).toHaveLength(2))
      p.cast(WATCH_INPUT_CAST, [{ data: 5 }])
      p.cast(WATCH_INPUT_CAST, [{ data: 'x'.repeat(INPUT_MAX + 1) }])
      await clock.advance(INPUT_BATCH_MS)
      await settleReal()
      expect(p.closed()).toBe(0)
      expect(t.inputs).toEqual([])
    })

    // --- the splitter across batches and drops ---------------------------------------------------------

    it('a start marker split across two casts with a batch in between is still a paste', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], `a${ESC}[20`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a']))
      await type(vs[0], `0~line 1\nline 2${PASTE_END}`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:paste:line 1\nline 2']))
    })

    it('a dropped cast that ends in a start-marker prefix: the paste it begins is discarded, never typed as keys', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      for (let i = 0; i < INPUT_BURST / INPUT_MAX; i++) await type(vs[0], 'a'.repeat(INPUT_MAX), clock)
      await type(vs[0], `b${ESC}[20`, clock) // over budget: dropped
      await vi.waitFor(() => expect(dropped(vs[0])).toHaveLength(1))
      await clock.advance(INPUT_BATCH_MS)
      await clock.advance(1000)
      await type(vs[0], `0~rm -rf ~\n${PASTE_END}ok`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t).at(-1)).toBe('s1:keys:ok'))
      expect(delivered(t).filter((d) => !d.startsWith('s1:keys:a'))).toEqual(['s1:keys:ok'])
    })

    // --- a pane that never answers --------------------------------------------------------------------

    it('a pane delivery that never settles times out after INPUT_DELIVERY_TIMEOUT_MS: dropped notice, the chain moves on, a late answer is ignored', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const late = deferred<boolean>()
      let calls = 0
      const { t, clock, vs } = await controllers(['Ada', 'Bob'], { input: () => (++calls === 1 ? late.promise : true) })
      await type(vs[0], `a${PASTE_START}P${PASTE_END}`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      await type(vs[1], 'z', clock)
      await clock.advance(INPUT_BATCH_MS)
      // Ada's chunk went to the pane one batch interval ago: its deadline is that far closer.
      await clock.advance(INPUT_DELIVERY_TIMEOUT_MS - INPUT_BATCH_MS - 1)
      expect(delivered(t)).toEqual(['s1:keys:a'])
      await clock.advance(1)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:z']))
      expect(dropped(vs[0])).toHaveLength(1)
      expect(dropped(vs[1])).toEqual([])
      // The answer arrives after all: nothing more is delivered, nobody is told twice.
      late.resolve(true)
      await settleReal()
      expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:z'])
      expect(dropped(vs[0])).toHaveLength(1)
    })

    it('a connection that ends while its delivery hangs releases the chain at once; stop() leaves no delivery timer', async () => {
      const { t, clock, vs } = await controllers(['Ada', 'Bob'], { input: (_s, c) => (c.kind === 'keys' && c.data === 'a' ? new Promise<boolean>(() => {}) : true) })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(1))
      await type(vs[1], 'z', clock)
      await clock.advance(INPUT_BATCH_MS)
      expect(t.host.kick(t.host.viewers()[0].viewerId)).toBe(true)
      await vi.waitFor(() => expect(delivered(t)).toEqual(['s1:keys:a', 's1:keys:z']))
      // A hung delivery when the link stops: its timer goes with it.
      await type(vs[1], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(3))
      t.host.stop('revoked')
      await clock.flush()
      expect(clock.pending()).toBe(0)
    })

    // --- the typing name -------------------------------------------------------------------------------

    it('the typing set names the name control was taken under, not a later chat name', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      const watcher = await openViewer(t, 1)
      expect(vs[0].c.sendChat('Bob', 'hi')).toBe(true)
      await vi.waitFor(() => expect(t.chats).toHaveLength(1))
      await type(vs[0], 'a', clock)
      await vi.waitFor(() => expect(typingOf(watcher)).toEqual([['Ada']]))
    })

    // The owner must never read "Bob · typing" beside an "Ada took control" notice: while a viewer
    // controls, the owner's list names it as the typing set does. Once it stops, its chat name again.
    it("the owner's viewer list names a controller by its unlock name, and by its chat name once it stops", async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      expect(vs[0].c.sendChat('Bob', 'hi')).toBe(true)
      await vi.waitFor(() => expect(t.chats).toHaveLength(1))
      await type(vs[0], 'a', clock)
      expect(t.host.viewers()[0]).toMatchObject({ name: 'Ada', controlling: true, typing: true })
      expect(await ask(vs[0], () => vs[0].c.release())).toEqual({ state: 'available' })
      expect(t.host.viewers()[0]).toMatchObject({ name: 'Bob', controlling: false })
    })

    it('stop() with a pending batch and a live typing set leaves no timer behind', async () => {
      const { t, clock, vs } = await controllers(['Ada', 'Bob'])
      await type(vs[0], 'a', clock)
      await type(vs[1], 'b', clock)
      expect(clock.pending()).toBeGreaterThan(0)
      t.host.stop('revoked')
      await clock.flush()
      expect(clock.pending()).toBe(0)
      await clock.advance(60_000)
      expect(t.inputs).toEqual([])
    })

    it('a viewer that ends with a pending batch: its timer is cleared and nothing is delivered', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      await type(vs[0], 'a', clock)
      const before = clock.pending()
      expect(t.host.kick(t.host.viewers()[0].viewerId)).toBe(true)
      expect(clock.pending()).toBeLessThan(before)
      await clock.advance(INPUT_BATCH_MS * 10)
      expect(t.inputs).toEqual([])
    })

    // Final review, Minor 3: a chunk already handed to PtyManager waits in its per-session chain (a
    // slow step of another link, say). The host gives it a predicate PtyManager asks right before it
    // spawns: false from the moment its sender stops controlling, so it never lands after control ended.
    it('every chunk handed to the pane carries a predicate that turns false the moment control ends', async () => {
      for (const end of ['record-off', 'off', 'release', 'password', 'lock', 'kick', 'stop'] as const) {
        const held = holdFirst()
        const { t, clock, vs } = await controllers(['Ada'], { input: held.input })
        await type(vs[0], 'a', clock)
        await clock.advance(INPUT_BATCH_MS)
        await vi.waitFor(() => expect(t.currents).toHaveLength(1))
        const isCurrent = t.currents[0]
        expect(typeof isCurrent, end).toBe('function')
        expect(isCurrent!(), end).toBe(true)
        if (end === 'record-off') t.record.control!.enabled = false // read live, before the host is told
        else if (end === 'off') {
          t.record.control!.enabled = false
          t.host.controlChanged()
        } else if (end === 'release') expect(await ask(vs[0], () => vs[0].c.release())).toEqual({ state: 'available' })
        else if (end === 'password') t.host.passwordChanged()
        else if (end === 'lock') {
          t.record.control!.locked = true
          t.host.controlChanged()
        } else if (end === 'kick') expect(t.host.kick(t.host.viewers()[0].viewerId)).toBe(true)
        else t.host.stop('revoked')
        expect(isCurrent!(), end).toBe(false)
        held.release()
        t.host.stop('revoked')
      }
    })

    it('a predicate never answers true for a sender that unlocked AGAIN: the period it was typed in is over', async () => {
      const held = holdFirst()
      const { t, clock, vs } = await controllers(['Ada'], { input: held.input })
      await type(vs[0], 'a', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.currents).toHaveLength(1))
      const isCurrent = t.currents[0]!
      expect(await ask(vs[0], () => vs[0].c.release())).toEqual({ state: 'available' })
      await clock.advance(UNLOCK_MIN_INTERVAL_MS)
      expect(await unlock(vs[0], 'Ada', PW)).toEqual({ state: 'controlling' })
      expect(isCurrent()).toBe(false)
      held.release()
    })

    // Final review, Minor 8: a paste/keys alternation costs one pane delivery (one tmux spawn) per
    // chunk. A batch holds at most INPUT_CHUNKS_MAX; the rest of THAT batch is dropped in whole chunks
    // (a paste is never cut), with the rate-limited dropped notice, and the next batch works.
    it(`a batch holds at most INPUT_CHUNKS_MAX (${INPUT_CHUNKS_MAX}) chunks: the rest of it is dropped whole, with one notice`, async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      const pair = (i: number): string => `k${i}${PASTE_START}p${i}${PASTE_END}`
      const flood = Array.from({ length: INPUT_CHUNKS_MAX }, (_, i) => pair(i)).join('')
      expect(flood.length).toBeLessThanOrEqual(INPUT_MAX)
      await type(vs[0], flood, clock) // 2 × INPUT_CHUNKS_MAX chunks in one cast
      // More of the same batch, before it flushes: a paste opened here and closed in the next cast…
      await type(vs[0], `late${PASTE_START}half`, clock)
      await type(vs[0], `-of-a-paste${PASTE_END}tail`, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(INPUT_CHUNKS_MAX))
      await clock.flush()
      await settleReal()
      const want = Array.from({ length: INPUT_CHUNKS_MAX / 2 }, (_, i) => [`s1:keys:k${i}`, `s1:paste:p${i}`]).flat()
      expect(delivered(t)).toEqual(want)
      // …is dropped whole: no part of the late paste, nothing typed after it in that batch.
      expect(delivered(t).some((d) => /late|half|tail/.test(d))).toBe(false)
      expect(dropped(vs[0])).toEqual([{ state: 'controlling', reason: 'dropped' }])
      expect(vs[0].log.closed).toBe(0)
      // The next batch is a new one.
      await type(vs[0], 'x', clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(delivered(t).at(-1)).toBe('s1:keys:x'))
    })

    it('a batch of exactly INPUT_CHUNKS_MAX chunks is delivered whole, with no notice', async () => {
      const { t, clock, vs } = await controllers(['Ada'])
      const flood = Array.from({ length: INPUT_CHUNKS_MAX / 2 }, (_, i) => `k${i}${PASTE_START}p${i}${PASTE_END}`).join('')
      await type(vs[0], flood, clock)
      await clock.advance(INPUT_BATCH_MS)
      await vi.waitFor(() => expect(t.inputs).toHaveLength(INPUT_CHUNKS_MAX))
      await settleReal()
      expect(dropped(vs[0])).toEqual([])
    })
  })
})

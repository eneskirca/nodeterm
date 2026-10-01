// The link host against the REAL relay host, the REAL hosted scheduler and the REAL browser client
// (src/shared/watch-link/client.ts) over an in-process transport. Only the pty and the clients registry
// are fakes, and they record every call, so "nothing a viewer sent reached the pty" is checkable.
//
// Timing-sensitive cases run on a MANUAL clock injected as the link host's (and so the scheduler's)
// setTimeout/now; the handshake itself is real async crypto, awaited with vi.waitFor on real time.
import { describe, it, expect, vi, afterEach } from 'vitest'
import nacl from 'tweetnacl'
import { transportPair } from '../relay/transport-pair'
import { connectRelay, type RelayTransport } from '../relay/relay-socket'
import { publicKeyToB64 } from '../relay/e2ee'
import { encodePtyData, parseRpcMessage } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import { isHostOnlyChannel } from '../../shared/host-control'
import { connectWatchClient } from '../../shared/watch-link/client'
import { deriveWatchLinkKeys } from '../../shared/watch-link/keys'
import { WATCH_EVENT, type WatchKeyframe } from '../../shared/watch-link/protocol'
import {
  createLinkHost,
  CONFIRM_DEADLINE_MS,
  FULL_STATUS_POLL_MS,
  MAX_VIEWERS_PER_LINK,
  REJOIN_BACKOFF_MS,
  REJOIN_STABLE_MS,
  SETTLE_BOUND_MS,
  WATCHER_SIZE_SYNC_MS,
  type LinkHost,
  type WatchJoin,
  type WatchPty
} from './link-host'
import type { HostTokenResult } from './api'
import { unavailableCapture, type VisibleCapture } from './capture-route'
import type { WatchLinkRecord } from './store'
import type { UiSink } from '../ui-sink-registry'

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

interface SetupOpts {
  role?: 'viewer' | 'commenter'
  join?: (clientId: number, nodeId: string, viewerId: string) => Promise<WatchJoin | null> | WatchJoin | null
  capture?: (sid: string) => Promise<VisibleCapture> | VisibleCapture
  alive?: (sid: string) => boolean
  /** The host side's socket backlog, per listener (in the order listeners were opened). */
  buffered?: (listener: number) => number
  clock?: ManualClock
  mint?: () => Promise<HostTokenResult>
  status?: () => Promise<'live' | 'revoked' | 'expired' | 'unknown'>
}

function setup(o: SetupOpts = {}) {
  const secret = nacl.randomBytes(32)
  const record: WatchLinkRecord = {
    linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'node-1', role: o.role ?? 'viewer', label: 'Ada', title: 'build',
    createdAt: 0, expiresAt: Date.now() + 3600_000, secret
  }
  const peers: RelayTransport[] = []
  const sinks = new Map<number, UiSink>()
  let nextId = 1_000_000
  const left: string[] = []
  /** Every pty call, in order: 'join', 'sync:<sid>', 'capture:<sid>'. */
  const calls: string[] = []
  const joinArgs: [number, string, string][] = []
  const joinTimes: number[] = []
  let mints = 0
  let changes = 0
  const clock = o.clock
  const now = clock ? clock.now : () => Date.now()
  const pty: WatchPty = {
    join: async (clientId, nodeId, viewerId) => {
      calls.push('join')
      joinArgs.push([clientId, nodeId, viewerId])
      joinTimes.push(now())
      return o.join ? o.join(clientId, nodeId, viewerId) : { sessionId: 's1', cols: 100, rows: 30, altScreen: true }
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
    alive: (sid) => (o.alive ? o.alive(sid) : true)
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
    onGone: (r) => gone.push(r)
  })
  hosts.push(host)
  return {
    record, host, peers, sinks, left, calls, joinArgs, joinTimes, chats, joined, gone,
    keys: deriveWatchLinkKeys(secret),
    mints: () => mints,
    /** How many times the host reported a change to the registry (`onChange`). */
    changes: () => changes,
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

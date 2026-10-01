// One live link at runtime: its standing relay listeners (one hosted-scheduler, capped at
// MAX_VIEWERS_PER_LINK bridged), and for every connected viewer a relay-host session whose peer key
// must be the one derived from the link secret. The viewer is attached as a QUIET, SELF-PACED core
// client; the host joins the node's RUNNING session on its behalf (join-only, never a size vote,
// every argument built from the host's own records — nothing comes from the viewer), sends meta and a
// visible-screen keyframe, then streams through the watcher sink (watcher-policy.ts).
//
// READ-ONLY IS ENFORCED HERE, on the host. The relay-host `access` hook refuses every request and
// every cast but a Commenter's chat (watcherAccess), and this module's own `PeerAttach` is the second
// layer: it forwards nothing to any platform, and a request or a non-chat cast that reaches it anyway
// means the access policy failed, so the session is CLOSED (fail closed, as relay-host does for a
// throwing wrapSink). No viewer byte, size or resize reaches a pty: the join, the size sync and the
// capture take only ids the host chose. No `interceptReq` is ever supplied (it would bypass `access`).
//
// relay-host never tells us about ends it caused itself (`deny`, `close`): every such path goes
// through `ended()`, which reports to the scheduler exactly once (the hosted-service pattern).
//
// THE STREAM. The watcher's filter (stream-filter.ts) starts MID-STREAM on every join: a viewer
// co-attaches to a running session and its first byte may fall inside an OSC 52. Frames that arrive
// before `c.sessionId` is known never reach the filter at all (the wrapper needs the session id), so
// a join can never start in text mode. A mid-stream filter swallows text until the first escape; the
// join keyframe is sent at once, and if the filter had not settled by then ONE follow-up keyframe is
// taken when it does (`onSettled`), plus one at SETTLE_BOUND_MS after the join if it still has not
// (controller ruling R23). The filter is never reset to text mode to "unstick" it: inside a string
// that would print the string's payload.
//
// KEYFRAMES are a visible-only capture (never history) passed through a FRESH text-mode filter (a
// capture starts in ground state, and `capture-pane -e` emits OSC 8 verbatim — R9), with the host's
// cursor when it was read (R10) and `altScreen` from the join (a tmux client paints on the alternate
// screen — R18). One capture per session is in flight at a time, shared by this link's viewers of
// that session (R27): a JOIN keyframe may share a capture already running (that viewer has forwarded
// nothing of this session, so an earlier screen cannot paint over newer output it showed), any other
// keyframe needs a capture STARTED after it asked. A per-viewer sequence makes sure an older result
// is never painted after a newer one, and streaming resumes only on the newest.
//
// NO CAPTURE IS NOT AN EMPTY SCREEN (R36). A backend with no visible-only capture (the Windows session
// host, a direct Windows pty, a plain shell) and a capture that failed answer `unavailable`, and then
// NO keyframe is sent: the viewer paints a keyframe as reset + clear, so an empty one would erase what
// the stream had drawn. The viewer follows the stream instead (at the join it still gets meta), and a
// throttled viewer resumes streaming without a repaint. Residual: on such a backend a throttled
// viewer shows gaps until the application repaints them.
//
// SIZE. A viewer never sizes anything. Its meta carries the joined session's CURRENT size (R25). A
// watcher's OWN tmux client (spawned when no owner Session is held) attaches with `ignore-size`, but
// tmux honours that only while some client WITHOUT the flag is attached to the server (measured,
// tmux 3.4): when the watcher is the only client, tmux's `window-size latest` sizes the window to it.
// So `syncSize` (PtyManager.syncWatcherClientSize, serialized per session there — R24) keeps that
// client at the window's size: before every keyframe capture (the screen then matches the size) and
// every WATCHER_SIZE_SYNC_MS while this link has a joined viewer. Residual: when the watcher becomes the
// only client, the window stays at the last-synced size until another client sizes it (an owner resize
// in the last interval before leaving is not caught).
//
// SPLIT PANES: a keyframe captures the session's ACTIVE pane only (`=nt-<id>:`); the stream, which is
// the tmux client's own output, repairs the rest as tmux redraws it.
//
// BACKLOG. A watcher is self-paced (the registry never pauses or drops for it), so it bounds its own
// backlog: pty frames stop at WATCHER_BUFFER_LIMIT (watcher-policy), chat is skipped for a viewer that
// far behind, and past VIEWER_BACKLOG_CLOSE the viewer's session is closed (R28): a socket that never
// drains must not grow the host's memory. meta, keyframe, waiting and end are small and rare.
//
// REJOIN. A session that ends (exit, closed, recycled, or found gone after a join or a capture — R30)
// sends the viewer `watch:waiting` and rejoins on a backoff. A join that is REFUSED (no session it may
// join) also marks the viewer `waiting` for the OWNER (`LinkViewer.waiting`, R63): on a backend with no
// watcher client of its own (Windows' session host, no local tmux, Zellij) only a terminal this app has
// open can be watched, and the owner is the one who can open it — a LIVE chip alone would say nothing. The backoff is reset only once a joined
// session stayed up for REJOIN_STABLE_MS from its join keyframe (R26), never on a join or a lifecycle
// event: an old remote tmux that rejects the client flags, or an owner's repeated `-D`, attaches then
// exits at once, and resetting on success turned that into a spawn + read + capture every 2 s forever.
//
// Nothing here throws out of a callback or a void promise: relay-host calls into this module from a
// socket's message emit and from the trust gate's async settle, where a throw is lost or unhandled.
import nacl from 'tweetnacl'
import { connectRelayHost, type PeerAttach, type RelayHostSession } from '../relay/relay-host'
import type { RelayTransport } from '../relay/relay-socket'
import { createHostedScheduler, type Listener, type SchedulerStatus } from '../relay/hosted-scheduler'
import type { MintResult } from '../relay/host-token'
import type { UiSink } from '../ui-sink-registry'
import type { RpcErr } from '../../shared/rpc'
import { bytesToB64, bytesToHex } from '../../shared/watch-link/bytes'
import { deriveWatchLinkKeys } from '../../shared/watch-link/keys'
import {
  WATCH_CHAT_CAST,
  WATCH_EVENT,
  WATCH_PROTOCOL_VERSION,
  sanitizeChatName,
  sanitizeChatText,
  type WatchChatMessage,
  type WatchKeyframe,
  type WatchLinkEndReason,
  type WatchMeta
} from '../../shared/watch-link/protocol'
import type { HostTokenResult } from './api'
import { unavailableCapture, type VisibleCapture } from './capture-route'
import { createStreamFilter, type StreamFilter } from './stream-filter'
import { createTokenBucket, type TokenBucket } from './token-bucket'
import {
  WATCHER_BUFFER_LIMIT,
  WATCHER_REFUSAL,
  WATCHER_RESUME_BELOW,
  watcherAccess,
  wrapWatcherSink
} from './watcher-policy'
import type { WatchLinkRecord } from './store'

export const MAX_VIEWERS_PER_LINK = 10
/** While the link is full (no idle listener, so no mint), how often the API is asked whether the link
 *  was revoked or expired server-side. */
export const FULL_STATUS_POLL_MS = 5 * 60_000
export const CHAT_MIN_INTERVAL_MS = 2_000
export const CHAT_HISTORY_MAX = 200
export const KEYFRAME_MIN_INTERVAL_MS = 1_000
/** Rejoin delays, by attempt. The last repeats: an instant-exit loop climbs to 15 s (R26, R35), and a
 *  viewer waiting for a terminal to start sees it within 15 s. */
export const REJOIN_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000]
/** A joined session that stayed up this long (from its join keyframe) resets the rejoin backoff. */
export const REJOIN_STABLE_MS = 30_000
/** An unsettled mid-stream filter gets one more keyframe this long after the join (R23). */
export const SETTLE_BOUND_MS = 2_000
/** How often a watcher's own tmux client is re-synced to the window size while the link has viewers. */
export const WATCHER_SIZE_SYNC_MS = 10_000
/** A peer that completed the handshake with the right key but has not confirmed by now is closed: it
 *  would hold one of the link's viewer slots until its socket drops (R31). */
export const CONFIRM_DEADLINE_MS = 30_000
/** A viewer whose socket backlog passes this is closed (viewer gone, not a revoke) — R28. */
export const VIEWER_BACKLOG_CLOSE = 8 * 1024 * 1024
const RATE = 256 * 1024
const BURST = 1024 * 1024

/** What `WatchPty.join` answers for a session the viewer now watches. */
export interface WatchJoin {
  sessionId: string
  /** The joined session's CURRENT size (`PtyManager.sessionSize`), never a viewer's (R25). */
  cols: number
  rows: number
  /** The stream is a tmux client's output (`PtyCreateResult.tmuxClient`), which tmux paints on the
   *  alternate screen whatever the pane's application does (R18). */
  altScreen: boolean
}

/**
 * The pty seam (wired to PtyManager by the shells). Every argument is the HOST's: a node id from the
 * link record, a viewer id this module minted, a session id `join` answered. Nothing from a viewer.
 */
export interface WatchPty {
  /**
   * Join the node's RUNNING session for this viewer (`joinAsWatcher`: join-only, no size vote, remote
   * fields from the host's own records). null for every refusal — no running session, any
   * `unavailable` (`join-only`, `ssh`, `codex-account`), a spawn refused because the window size could
   * not be read — and the caller may also throw; both mean "waiting, try again later".
   */
  join(clientId: number, nodeId: string, viewerId: string): Promise<WatchJoin | null>
  leave(clientId: number, sessionId: string, viewerId: string): void
  /** The visible screen and cursor, never history (`PtyManager.captureVisible`). */
  captureVisible(sessionId: string): Promise<VisibleCapture>
  /** Keep a watcher's OWN tmux client at the window's size (`PtyManager.syncWatcherClientSize`, which
   *  serializes per session). Takes no size: nothing a viewer says can size anything. */
  syncSize(sessionId: string): Promise<boolean>
  /** The session is still known to the pty layer (an exit can race the join or a capture — R30). */
  alive(sessionId: string): boolean
}
export interface QuietClients {
  attach(sink: UiSink): number
  detach(id: number): void
}
export interface LinkHostDeps {
  relayUrl: string
  mint(): Promise<HostTokenResult>
  status(): Promise<'live' | 'revoked' | 'expired' | 'unknown'>
  clients: QuietClients
  pty: WatchPty
  transport?: () => RelayTransport
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  onChange(): void
  onChat(msg: WatchChatMessage): void
  onViewerJoined(count: number): void
  onGone(reason: 'revoked' | 'expired'): void
}
export type LinkRuntimeStatus = 'live' | 'reconnecting' | 'refused'
export interface LinkViewer {
  viewerId: string
  name: string | null
  joinedAt: number
  /** Connected, but its last join found no session to watch (R63): what the owner must be told,
   *  because only the owner can fix it — on a backend with no watcher client (Windows' session host,
   *  no local tmux, Zellij) a viewer can co-attach only to a terminal this app has OPEN. Set by a
   *  REFUSED join, never by a session merely ending: that rejoins in seconds, usually successfully. */
  waiting: boolean
}
export interface LinkHost {
  start(): void
  stop(reason: WatchLinkEndReason): void
  kick(viewerId: string): boolean
  postSharerChat(text: string): WatchChatMessage | null
  chatHistory(): WatchChatMessage[]
  status(): LinkRuntimeStatus
  viewers(): LinkViewer[]
}

interface Conn {
  viewerId: string
  ev: { onBridged(): void; onClose(): void }
  session: RelayHostSession | null
  clientId: number | null
  /** The WRAPPED watcher sink relay-host attached (every event we send passes its outbound filter). */
  sink: UiSink | null
  attachFailed: boolean
  bridged: boolean
  ended: boolean
  confirmTimer: unknown
  /** When both ends confirmed and the viewer became a client; null before. */
  joinedAt: number | null
  name: string | null
  lastChatAt: number
  // The watched session (null while waiting).
  sessionId: string | null
  altScreen: boolean
  joining: boolean
  waiting: boolean
  /** The last join answered no session (LinkViewer.waiting). Cleared by a join that lands. */
  joinRefused: boolean
  streaming: boolean
  filter: StreamFilter
  bucket: TokenBucket
  /** The current session's mid-stream filter has left its unknown start state. */
  settled: boolean
  /** Take one more keyframe when it does (it had not when the join keyframe was delivered). */
  followUpOnSettle: boolean
  /** The current session's first keyframe step is done: painted, or skipped because there was no
   *  capture (R36). From here the viewer streams. */
  joinKeyframeDone: boolean
  kfSeq: number
  kfDelivered: number
  /** When the last keyframe step was done (painted or skipped): keyframes and resumes are ≤ 1/s. */
  lastKeyframeAt: number
  keyframeTimer: unknown
  settleTimer: unknown
  stableTimer: unknown
  rejoinAttempt: number
  rejoinTimer: unknown
  warned: Set<string>
}

interface CaptureSlot {
  current: { epoch: number; result: Promise<VisibleCapture> } | null
  /** The one rerun queued behind `current`, shared by every keyframe that needs a newer capture. */
  next: { result: Promise<VisibleCapture>; start(): void } | null
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The session a join attached to, if it answered one (a refused join may still have attached). */
function joinedSessionId(r: unknown): string | null {
  const sid = r && typeof r === 'object' ? (r as { sessionId?: unknown }).sessionId : undefined
  return typeof sid === 'string' && sid ? sid : null
}

/** A usable join, or null. A join without a valid size is REFUSED, never given a guessed one (R20, R37):
 *  a wiring slip then shows as "waiting", loudly, instead of a viewer laid out at a wrong size for the
 *  rest of the session (its join-time `pty:size` was already recorded as shown and is not resent). */
function normalizeJoin(r: unknown): WatchJoin | null {
  const sessionId = joinedSessionId(r)
  if (sessionId === null) return null
  const o = r as Partial<WatchJoin>
  const dim = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0
  if (!dim(o.cols) || !dim(o.rows)) return null
  return { sessionId, cols: o.cols as number, rows: o.rows as number, altScreen: o.altScreen === true }
}

function normalizeCapture(c: unknown): VisibleCapture {
  if (!c || typeof c !== 'object' || typeof (c as VisibleCapture).screen !== 'string') return unavailableCapture()
  if ((c as VisibleCapture).unavailable === true) return unavailableCapture()
  const cur = (c as VisibleCapture).cursor
  const ok = !!cur && Number.isInteger(cur.x) && Number.isInteger(cur.y) && cur.x >= 0 && cur.y >= 0
  return { screen: (c as VisibleCapture).screen, cursor: ok ? { x: cur!.x, y: cur!.y } : null }
}

export function createLinkHost(record: WatchLinkRecord, deps: LinkHostDeps): LinkHost {
  const keys = deriveWatchLinkKeys(record.secret)
  const hostKeys = { publicKey: keys.host.publicKey, secretKey: keys.host.secretKey }
  const expectedViewerKey = bytesToB64(keys.viewer.publicKey)
  const conns = new Set<Conn>()
  const chat: WatchChatMessage[] = []
  const captures = new Map<string, CaptureSlot>()
  let captureEpoch = 0
  let sched: SchedulerStatus | null = null
  let pollTimer: unknown = null
  let syncTimer: unknown = null
  let stopped = false
  const warnedHost = new Set<string>()

  const clearTimer = (h: unknown): void => {
    if (h !== null) deps.clearTimeout(h)
  }
  /** One line per kind per viewer (or per link): a failure that repeats every rejoin must not flood. */
  const warn = (c: Conn | null, kind: string, detail: string): void => {
    const seen = c ? c.warned : warnedHost
    if (seen.has(kind)) return
    seen.add(kind)
    console.warn(`[watch-link] ${kind}: ${detail}`)
  }
  /** A callback the registry owns must not throw into relay-host's emit or the trust gate's settle. */
  const safe = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      console.warn(`[watch-link] ${label} threw: ${errorText(err)}`)
    }
  }
  const bufferedOf = (c: Conn): number => {
    try {
      return c.sink?.bufferedAmount?.() ?? 0
    } catch {
      return 0
    }
  }

  /** Send one `watch:*` event through the viewer's own (filtered) sink. False when not sent. */
  function send(c: Conn, channel: string, payload: unknown, opts: { chat?: boolean } = {}): boolean {
    if (c.ended || !c.sink) return false
    const buffered = bufferedOf(c)
    if (buffered > VIEWER_BACKLOG_CLOSE) {
      dropStalled(c)
      return false
    }
    if (opts.chat && buffered > WATCHER_BUFFER_LIMIT) return false
    try {
      c.sink.sendText(JSON.stringify({ t: 'ev', channel, args: [payload] }))
    } catch {
      // A dead socket: relay-host's own close tears the session down.
    }
    return true
  }
  function dropStalled(c: Conn): void {
    // While stopping, the scheduler may still be running (the end notices go out first): closing now
    // would re-mint a listener on a full link. `stop` closes every viewer a moment later anyway (R37).
    if (stopped) return
    warn(null, 'a viewer stopped draining its socket; closed it', `backlog over ${VIEWER_BACKLOG_CLOSE} bytes`)
    c.session?.close()
    ended(c)
  }
  function leave(clientId: number | null, sessionId: string, viewerId: string, c: Conn | null): void {
    if (clientId === null || clientId < 0) return
    try {
      deps.pty.leave(clientId, sessionId, viewerId)
    } catch (err) {
      warn(c, 'leaving a watched session failed', errorText(err))
    }
  }
  const aliveOf = (c: Conn, sessionId: string): boolean => {
    try {
      return deps.pty.alive(sessionId) === true
    } catch (err) {
      warn(c, 'the session liveness check failed', errorText(err))
      return false
    }
  }

  function ended(c: Conn): void {
    if (c.ended) return
    c.ended = true
    conns.delete(c)
    for (const h of [c.confirmTimer, c.rejoinTimer, c.keyframeTimer, c.settleTimer, c.stableTimer]) clearTimer(h)
    c.confirmTimer = c.rejoinTimer = c.keyframeTimer = c.settleTimer = c.stableTimer = null
    const sid = c.sessionId
    c.sessionId = null
    c.streaming = false
    if (sid !== null) leave(c.clientId, sid, c.viewerId, c)
    safe('the scheduler', () => c.ev.onClose())
    updateSyncTimer()
    if (c.joinedAt !== null && !stopped) safe('onChange', deps.onChange)
  }
  function endConn(c: Conn, reason: WatchLinkEndReason): void {
    send(c, WATCH_EVENT.end, { reason })
    c.session?.close()
    ended(c)
  }
  /** The access policy let something through: fail closed. */
  function policyBreach(c: Conn, what: string): void {
    // `what` names a peer-chosen method: quoted and capped, so it cannot forge a log line.
    console.warn(`[watch-link] a viewer's ${JSON.stringify(what.slice(0, 80))} got past the watcher policy; closing that viewer`)
    c.session?.close()
    ended(c)
  }

  // --- captures: one in flight per session, shared by this link's viewers (R27) ---------------------

  async function runCapture(sessionId: string): Promise<VisibleCapture> {
    // Size first, so the screen is captured at the size the viewer is about to be told.
    try {
      await deps.pty.syncSize(sessionId)
    } catch (err) {
      warn(null, 'the watcher size sync failed', errorText(err))
    }
    try {
      return normalizeCapture(await deps.pty.captureVisible(sessionId))
    } catch (err) {
      warn(null, 'a keyframe capture failed', errorText(err))
      return unavailableCapture()
    }
  }
  function startCapture(sessionId: string, slot: CaptureSlot): Promise<VisibleCapture> {
    const result = runCapture(sessionId)
    slot.current = { epoch: ++captureEpoch, result }
    void result.then(() => {
      slot.current = null
      const next = slot.next
      slot.next = null
      if (next) next.start()
      else if (captures.get(sessionId) === slot) captures.delete(sessionId)
    })
    return result
  }
  /** A capture of `sessionId` that started after epoch `needAfter` (-1: any, even one running now). */
  function captureFor(sessionId: string, needAfter: number): Promise<VisibleCapture> {
    let slot = captures.get(sessionId)
    if (!slot) {
      slot = { current: null, next: null }
      captures.set(sessionId, slot)
    }
    if (!slot.current) return startCapture(sessionId, slot)
    if (slot.current.epoch > needAfter) return slot.current.result
    if (slot.next) return slot.next.result
    const s = slot
    let resolve: (v: VisibleCapture | Promise<VisibleCapture>) => void = () => {}
    const result = new Promise<VisibleCapture>((r) => (resolve = r))
    s.next = { result, start: () => resolve(stopped ? unavailableCapture() : startCapture(sessionId, s)) }
    return result
  }

  // --- keyframes ------------------------------------------------------------------------------------

  function requestKeyframe(c: Conn, join: boolean): void {
    const sid = c.sessionId
    if (sid === null || c.ended || stopped) return
    // Nothing is forwarded from here until the newest keyframe is painted: a frame sent now could be
    // painted over by an older screen.
    c.streaming = false
    const seq = ++c.kfSeq
    void captureFor(sid, join ? -1 : captureEpoch).then((cap) => {
      try {
        deliverKeyframe(c, sid, seq, cap)
      } catch (err) {
        warn(c, 'painting a keyframe failed', errorText(err))
      }
    })
  }
  function deliverKeyframe(c: Conn, sid: string, seq: number, cap: VisibleCapture): void {
    if (c.ended || stopped || c.sessionId !== sid || seq <= c.kfDelivered) return
    if (!aliveOf(c, sid)) {
      sessionOver(c)
      return
    }
    // No capture (R36): nothing is painted — an empty keyframe would erase what the stream drew — but
    // the step still counts as done, so the viewer streams (it must not wait for a keyframe that never
    // comes) and the next request waits out the minimum interval like a painted one.
    if (!cap.unavailable) {
      const kf: WatchKeyframe = {
        sessionId: sid,
        // A FRESH filter: the capture starts in ground state, and carries OSC 8 links verbatim (R9).
        screen: createStreamFilter().push(cap.screen),
        altScreen: c.altScreen,
        ...(cap.cursor ? { cursor: { x: cap.cursor.x, y: cap.cursor.y } } : {})
      }
      if (!send(c, WATCH_EVENT.keyframe, kf)) return
    }
    c.kfDelivered = seq
    c.lastKeyframeAt = deps.now()
    if (seq === c.kfSeq) c.streaming = true
    if (!c.joinKeyframeDone) {
      c.joinKeyframeDone = true
      c.followUpOnSettle = !c.settled
      clearTimer(c.stableTimer)
      c.stableTimer = deps.setTimeout(() => {
        c.stableTimer = null
        c.rejoinAttempt = 0
      }, REJOIN_STABLE_MS)
    }
  }
  /** A keyframe at most KEYFRAME_MIN_INTERVAL_MS after the last one, once the socket has drained. */
  function scheduleKeyframe(c: Conn): void {
    if (c.ended || stopped || c.sessionId === null || c.keyframeTimer !== null) return
    const tick = (): void => {
      c.keyframeTimer = null
      if (c.ended || stopped || c.sessionId === null) return
      const buffered = bufferedOf(c)
      if (buffered > VIEWER_BACKLOG_CLOSE) {
        dropStalled(c)
        return
      }
      // Wait for the socket to drain before painting over it.
      if (buffered > WATCHER_RESUME_BELOW) {
        c.keyframeTimer = deps.setTimeout(tick, KEYFRAME_MIN_INTERVAL_MS)
        return
      }
      requestKeyframe(c, false)
    }
    c.keyframeTimer = deps.setTimeout(tick, Math.max(0, KEYFRAME_MIN_INTERVAL_MS - (deps.now() - c.lastKeyframeAt)))
  }
  /** WatcherSinkDeps.onOverBudget: stop forwarding NOW, whatever is armed (F10), then repaint. */
  function throttle(c: Conn): void {
    c.streaming = false
    scheduleKeyframe(c)
  }
  function onSettled(c: Conn, sid: string): void {
    if (c.ended || c.sessionId !== sid) return
    c.settled = true
    clearTimer(c.settleTimer)
    c.settleTimer = null
    if (c.followUpOnSettle) {
      c.followUpOnSettle = false
      scheduleKeyframe(c)
    }
  }

  // --- joining the node's session -------------------------------------------------------------------

  function enterWaiting(c: Conn): void {
    if (c.waiting) return
    c.waiting = true
    send(c, WATCH_EVENT.waiting, {})
  }
  /** The owner's view of a viewer with nothing to watch (LinkViewer.waiting): reported on a change only,
   *  so a rejoin loop that keeps failing costs one push, not one per attempt. */
  function setJoinRefused(c: Conn, refused: boolean): void {
    if (c.joinRefused === refused) return
    c.joinRefused = refused
    if (c.joinedAt !== null && !c.ended) safe('onChange', deps.onChange)
  }
  function scheduleRejoin(c: Conn): void {
    if (c.ended || stopped || c.rejoinTimer !== null) return
    const delay = REJOIN_BACKOFF_MS[Math.min(c.rejoinAttempt, REJOIN_BACKOFF_MS.length - 1)]
    c.rejoinAttempt++
    c.rejoinTimer = deps.setTimeout(() => {
      c.rejoinTimer = null
      runJoin(c)
    }, delay)
  }
  const runJoin = (c: Conn): void => {
    join(c).catch((err) => warn(c, 'a join failed', errorText(err)))
  }
  async function join(c: Conn): Promise<void> {
    if (c.ended || stopped || c.clientId === null || c.clientId < 0 || c.joining || c.sessionId !== null) return
    c.joining = true
    const clientId = c.clientId
    let res: WatchJoin | null = null
    let attached: string | null = null
    try {
      const raw = await deps.pty.join(clientId, record.nodeId, c.viewerId)
      attached = joinedSessionId(raw)
      res = normalizeJoin(raw)
      if (!res && attached !== null) warn(c, 'a join answered no valid size; refused', `session ${attached}`)
    } catch (err) {
      warn(c, 'joining the node session failed', errorText(err))
    } finally {
      c.joining = false
    }
    // Refused, or this viewer went away meanwhile: never stay subscribed to what the join attached.
    if (attached !== null && (!res || c.ended || stopped)) leave(clientId, attached, c.viewerId, c)
    if (c.ended || stopped) return
    // An exit that raced the join was delivered before this viewer knew its session id, and dropped.
    if (res && !aliveOf(c, res.sessionId)) {
      leave(clientId, res.sessionId, c.viewerId, c)
      res = null
    }
    if (!res) {
      enterWaiting(c)
      setJoinRefused(c, true)
      scheduleRejoin(c)
      return
    }
    setJoinRefused(c, false)
    const sid = res.sessionId
    // EVERY join restarts the filter mid-stream (R12): this is a running session.
    c.filter.reset({ midStream: true, onSettled: () => onSettled(c, sid) })
    c.sessionId = sid
    c.altScreen = res.altScreen
    c.streaming = false
    c.joinKeyframeDone = false
    c.settled = false
    c.followUpOnSettle = false
    c.waiting = false
    // Meta after EVERY (re)attach: the viewer leaves `waiting` on it (R14).
    const meta: WatchMeta = {
      v: WATCH_PROTOCOL_VERSION,
      role: record.role,
      label: record.label,
      title: record.title,
      expiresAt: record.expiresAt,
      cols: res.cols,
      rows: res.rows
    }
    if (!send(c, WATCH_EVENT.meta, meta)) return
    clearTimer(c.settleTimer)
    c.settleTimer = deps.setTimeout(() => {
      c.settleTimer = null
      if (c.sessionId === sid && !c.settled) scheduleKeyframe(c)
    }, SETTLE_BOUND_MS)
    requestKeyframe(c, true)
    updateSyncTimer()
  }
  /** The watched session is over: leave it, say so, look for the next one. */
  function sessionOver(c: Conn): void {
    const sid = c.sessionId
    if (sid === null || c.ended) return
    c.sessionId = null
    c.streaming = false
    c.followUpOnSettle = false
    for (const h of [c.keyframeTimer, c.settleTimer, c.stableTimer]) clearTimer(h)
    c.keyframeTimer = c.settleTimer = c.stableTimer = null
    const clientId = c.clientId
    // Deferred: a lifecycle event arrives from inside PtyManager's own delivery loop for that session.
    queueMicrotask(() => leave(clientId, sid, c.viewerId, c))
    enterWaiting(c)
    scheduleRejoin(c)
    updateSyncTimer()
  }

  // --- size sync ------------------------------------------------------------------------------------

  function activeSessions(): Set<string> {
    const out = new Set<string>()
    for (const c of conns) if (!c.ended && c.sessionId !== null) out.add(c.sessionId)
    return out
  }
  function syncSize(sessionId: string): void {
    try {
      void deps.pty.syncSize(sessionId).catch((err) => warn(null, 'the watcher size sync failed', errorText(err)))
    } catch (err) {
      warn(null, 'the watcher size sync failed', errorText(err))
    }
  }
  function updateSyncTimer(): void {
    if (stopped || activeSessions().size === 0) {
      clearTimer(syncTimer)
      syncTimer = null
      return
    }
    if (syncTimer !== null) return
    syncTimer = deps.setTimeout(() => {
      syncTimer = null
      if (stopped) return
      for (const sid of activeSessions()) syncSize(sid)
      updateSyncTimer()
    }, WATCHER_SIZE_SYNC_MS)
  }

  // --- chat -----------------------------------------------------------------------------------------

  function publish(msg: WatchChatMessage): void {
    chat.push(msg)
    if (chat.length > CHAT_HISTORY_MAX) chat.splice(0, chat.length - CHAT_HISTORY_MAX)
    for (const c of [...conns]) if (c.joinedAt !== null && !c.ended) send(c, WATCH_EVENT.chat, msg, { chat: true })
    safe('onChat', () => deps.onChat(msg))
    safe('onChange', deps.onChange)
  }
  function onViewerCast(c: Conn, method: string, args: unknown[]): void {
    // relay-host's access hook admits a Commenter's chat cast and nothing else.
    if (method !== WATCH_CHAT_CAST || record.role !== 'commenter') {
      policyBreach(c, `cast ${method}`)
      return
    }
    if (c.ended || c.joinedAt === null) return
    const now = deps.now()
    if (now - c.lastChatAt < CHAT_MIN_INTERVAL_MS) return
    const p = args[0]
    if (!p || typeof p !== 'object') return
    const name = sanitizeChatName((p as { name?: unknown }).name)
    const text = sanitizeChatText((p as { text?: unknown }).text)
    if (!name || !text) return
    c.lastChatAt = now
    c.name = name
    publish({ id: bytesToHex(nacl.randomBytes(8)), name, text, at: now, from: 'viewer' })
  }

  // --- listeners and viewer sessions ----------------------------------------------------------------

  const bridged = (c: Conn): void => {
    if (c.bridged) return
    c.bridged = true
    safe('the scheduler', () => c.ev.onBridged())
  }

  function openListener(token: string, ev: { onBridged(): void; onClose(): void }): Listener {
    const c: Conn = {
      viewerId: `v-${bytesToHex(nacl.randomBytes(4))}`,
      ev,
      session: null,
      clientId: null,
      sink: null,
      attachFailed: false,
      bridged: false,
      ended: false,
      confirmTimer: null,
      joinedAt: null,
      name: null,
      lastChatAt: -Infinity,
      sessionId: null,
      altScreen: false,
      joining: false,
      waiting: false,
      joinRefused: false,
      streaming: false,
      filter: createStreamFilter({ midStream: true }),
      bucket: createTokenBucket({ ratePerSec: RATE, burst: BURST, now: deps.now }),
      settled: false,
      followUpOnSettle: false,
      joinKeyframeDone: false,
      kfSeq: 0,
      kfDelivered: 0,
      lastKeyframeAt: -Infinity,
      keyframeTimer: null,
      settleTimer: null,
      stableTimer: null,
      rejoinAttempt: 0,
      rejoinTimer: null,
      warned: new Set()
    }
    conns.add(c)
    const attach: PeerAttach = {
      attach: (sink) => {
        c.sink = sink
        try {
          c.clientId = deps.clients.attach(sink)
        } catch (err) {
          // Answered with an id nothing owns; onOpen then closes the session.
          warn(c, 'registering a viewer failed', errorText(err))
          c.attachFailed = true
          c.clientId = -1
        }
        return c.clientId
      },
      detach: (id) => {
        if (id < 0) return
        try {
          deps.clients.detach(id)
        } catch (err) {
          warn(c, 'unregistering a viewer failed', errorText(err))
        }
      },
      // Never reached: the access hook refuses every request first. If one arrives, the policy failed.
      dispatch: async (_id, req): Promise<RpcErr> => {
        policyBreach(c, `request ${req.method}`)
        return { t: 'res', id: req.id, ok: false, error: { code: 'E_ROLE', message: WATCHER_REFUSAL } }
      },
      cast: (_id, method, args) => {
        try {
          onViewerCast(c, method, args)
        } catch (err) {
          warn(c, 'a viewer cast failed', errorText(err))
        }
      }
    }
    try {
      c.session = connectRelayHost({
        url: deps.relayUrl,
        token,
        ourKeys: hostKeys,
        attach,
        transport: deps.transport?.(),
        // Answered from our OWN record, never from anything the peer sent: the handshake key must be
        // the one only a holder of the link secret can derive.
        autoApprove: (peerKeyB64) => {
          bridged(c) // a completed handshake proves the relay leg; the scheduler opens a replacement
          if (peerKeyB64 !== expectedViewerKey) return false
          clearTimer(c.confirmTimer)
          c.confirmTimer = deps.setTimeout(() => {
            c.confirmTimer = null
            if (c.ended || c.joinedAt !== null) return
            c.session?.close()
            ended(c)
          }, CONFIRM_DEADLINE_MS)
          return true
        },
        hooks: {
          access: (_s, kind, method) => watcherAccess(kind, method, record.role),
          wrapSink: (_s, base) =>
            wrapWatcherSink(base, {
              sessionId: () => c.sessionId,
              streaming: () => c.streaming,
              filter: c.filter,
              bucket: c.bucket,
              onOverBudget: () => throttle(c),
              onLifecycle: () => sessionOver(c)
            })
        },
        // A peer with any other key: refused at once, never an approval dialog.
        onPeerPending: (s) => {
          c.session ??= s
          s.deny('denied')
          ended(c)
        },
        onOpen: (s) => {
          c.session ??= s
          clearTimer(c.confirmTimer)
          c.confirmTimer = null
          if (c.ended || stopped || c.attachFailed) {
            s.close()
            ended(c)
            return
          }
          c.joinedAt = deps.now()
          safe('onViewerJoined', () => deps.onViewerJoined(viewers().length))
          safe('onChange', deps.onChange)
          runJoin(c)
        },
        onClose: () => ended(c)
      })
    } catch (err) {
      conns.delete(c)
      throw err
    }
    return {
      bridged: false,
      close: () => {
        c.session?.close()
        ended(c)
      }
    }
  }

  function viewers(): LinkViewer[] {
    const out: LinkViewer[] = []
    for (const c of conns) {
      if (c.joinedAt === null || c.ended) continue
      out.push({ viewerId: c.viewerId, name: c.name, joinedAt: c.joinedAt, waiting: c.joinRefused && c.sessionId === null })
    }
    return out
  }
  function gone(reason: 'revoked' | 'expired'): void {
    if (stopped) return
    stop(reason)
    safe('onGone', () => deps.onGone(reason))
  }
  function armFullPoll(s: SchedulerStatus): void {
    const full = s.state === 'running' && s.idle === 0 && s.bridged >= MAX_VIEWERS_PER_LINK
    if (!full || stopped) {
      clearTimer(pollTimer)
      pollTimer = null
      return
    }
    if (pollTimer !== null) return
    pollTimer = deps.setTimeout(() => {
      pollTimer = null
      void (async () => {
        let st: 'live' | 'revoked' | 'expired' | 'unknown' = 'unknown'
        try {
          st = await deps.status()
        } catch (err) {
          warn(null, 'the link status poll failed', errorText(err))
        }
        if (stopped) return
        if (st === 'revoked' || st === 'expired') gone(st)
        else if (sched) armFullPoll(sched)
      })()
    }, FULL_STATUS_POLL_MS)
  }

  const scheduler = createHostedScheduler(
    {
      mint: async (): Promise<MintResult> => {
        const r = await deps.mint()
        if (!r.ok && r.kind === 'gone') {
          const reason = r.reason
          queueMicrotask(() => gone(reason))
          return { ok: false, kind: 'refused', status: 410 }
        }
        return r
      },
      open: openListener,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
      onStatus: (s) => {
        sched = s
        armFullPoll(s)
        safe('onChange', deps.onChange)
      },
      maxBridged: MAX_VIEWERS_PER_LINK
    },
    deps.now
  )

  function stop(reason: WatchLinkEndReason): void {
    if (stopped) return
    stopped = true
    // Tell every viewer first: the scheduler's stop closes every listener, bridged ones included, and
    // a closed session can no longer be told anything (F1).
    for (const c of [...conns]) if (c.joinedAt !== null && !c.ended) send(c, WATCH_EVENT.end, { reason })
    // `stopped` before the listeners close, so no ended() re-mints a listener.
    scheduler.stop()
    clearTimer(pollTimer)
    pollTimer = null
    clearTimer(syncTimer)
    syncTimer = null
    for (const c of [...conns]) {
      c.session?.close()
      ended(c)
    }
    safe('onChange', deps.onChange)
  }

  return {
    start: () => {
      if (!stopped) scheduler.start()
    },
    stop,
    kick(viewerId) {
      for (const c of conns) {
        if (c.viewerId === viewerId && c.joinedAt !== null && !c.ended) {
          endConn(c, 'kicked')
          return true
        }
      }
      return false
    },
    postSharerChat(text) {
      const clean = sanitizeChatText(text)
      if (!clean || record.role !== 'commenter' || stopped) return null
      const msg: WatchChatMessage = { id: bytesToHex(nacl.randomBytes(8)), name: record.label, text: clean, at: deps.now(), from: 'sharer' }
      publish(msg)
      return msg
    },
    chatHistory: () => [...chat],
    status() {
      if (!sched) return 'reconnecting'
      if (sched.state === 'backend-refused') return 'refused'
      if (sched.idle > 0 || sched.bridged >= MAX_VIEWERS_PER_LINK) return 'live'
      return sched.lastError ? 'reconnecting' : 'live'
    },
    viewers
  }
}

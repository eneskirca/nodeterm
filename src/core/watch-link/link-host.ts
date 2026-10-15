// One live link at runtime: its standing relay listeners (one hosted-scheduler, capped at
// MAX_VIEWERS_PER_LINK bridged), and for every connected viewer a relay-host session whose peer key
// must be the one derived from the link secret. The viewer is attached as a QUIET, SELF-PACED core
// client; the host joins the node's RUNNING session on its behalf (join-only, never a size vote,
// every argument built from the host's own records — nothing comes from the viewer), sends meta and a
// visible-screen keyframe, then streams through the watcher sink (watcher-policy.ts).
//
// THE VIEWER'S INBOUND SURFACE IS ENFORCED HERE, on the host. The relay-host `access` hook
// (watcherAccess) refuses every request and every cast but chat (Commenter and Control links) and
// unlock / input / release (Control links), and this module's own `PeerAttach` is the second layer:
// it forwards nothing to any platform, and a request, or a cast the link's role does not admit, that
// reaches it anyway means the access policy failed, so the session is CLOSED (fail closed, as
// relay-host does for a throwing wrapSink). Input from a viewer that is not controlling is the same
// breach (but for the GRACE below). No viewer size or resize reaches a pty; the only viewer bytes that
// reach anything are a controller's input, into the pane of the session the host joined (TYPING
// below). The join, the size sync, the capture and the input take only ids the host chose. No
// `interceptReq` is ever supplied (it would bypass `access`).
//
// CONTROL (a Control link, role 'controller') is per CONNECTION: a viewer that unlocks with the link's
// password (`watch:unlock`) is `controlling` until it releases, disconnects or is kicked, or until the
// owner turns control off or changes the password, or the link locks; a reconnect unlocks again. The
// record is the service's: the host READS `record.control` live and never writes it (the service sets
// `locked` inside `onControlLocked`, before it returns). An unlock is answered to that viewer alone
// (`watch:control`), and every throttle is here: one attempt per UNLOCK_MIN_INTERVAL_MS per viewer and
// one verification in flight per link (both `too-soon`, not counted); a malformed attempt counts as
// wrong and is never verified, so an over-long password never reaches scrypt; WRONG_PER_CONN wrong
// attempts end that connection (`attempts`), WRONG_PER_LINK across the link lock it. The link count is
// the record's: the host starts from `record.control.wrong` and reports every new count to the service
// (`onWrongAttempt`), which writes it — an app restart does not reset it. `allowControl` and a password
// change reset it. A verification is re-checked after its await: an
// ended viewer, a stopped host, or any change to control meanwhile (off, locked, a new password — the
// control epoch) voids it, uncounted. A join whose input route is `none` (Zellij, an unknown session;
// also what a missing or unknown route reads as) makes that viewer's state `off`/`unsupported`: its
// meta says so, an unlock is answered so (uncounted), and a controller is demoted.
//
// TYPING (`watch:input` from a controller). A cast whose data is not a string of 1..INPUT_MAX units is a
// breach. A terminal's own answer to the pane's query (`isTerminalReport`: DA, CPR, a colour — every
// controller's emulator answers every query) is dropped, uncounted. Then the connection's own token
// bucket (INPUT_RATE / INPUT_BURST, UTF-8 bytes), a session to type into, and a batch the panes have
// not taken yet holding at most INPUT_BURST decide; dropped input still goes through the splitter's
// `discard` (a paste any part of which was dropped is discarded whole), and the viewer is told
// `{controlling, dropped}` at most once per DROPPED_NOTICE_MIN_MS. A batch holds at most
// INPUT_CHUNKS_MAX chunks (each chunk is one pane delivery — a tmux spawn — and a paste/keys alternation
// would otherwise cost one per chunk): past it, the rest of THAT batch is dropped in whole chunks, the
// same way and with the same notice. Accepted data goes through the
// connection's SPLITTER (control-input.ts: keys vs a bracketed paste) into its BATCH; the batch flushes
// INPUT_BATCH_MS after its first input into ONE flush CHAIN per link host, through `pty.input`
// (PtyManager's pane delivery, never a tmux client's key table). A connection has at most one batch in
// the chain: while it waits there, new input keeps collecting, so a slow pane coalesces input instead
// of piling up deliveries. ORDER: a connection's input reaches the pane in the order it was typed, and
// every batch arrives whole (no other controller's chunk inside it); ACROSS controllers it is roughly
// flush order — a connection whose previous batch is still in the chain re-enters only when that batch
// finishes, behind whatever other controllers flushed meanwhile. Each chunk is re-checked before it
// goes — same control period (`controlGen`, bumped by every loss of control), still controlling,
// still the session it was typed at. The same check rides the chunk as a predicate (`isCurrent`), which
// PtyManager asks right before the step spawns: a chunk handed over and still waiting in its per-session
// chain (behind a slow step) never lands after its sender stopped controlling. A false, a rejection, or
// no answer within
// INPUT_DELIVERY_TIMEOUT_MS stops the batch with the `dropped` notice (an SSH host without tmux answers
// false on every chunk: never silence) and the chain moves on. Input is never held for a later
// session: a session that ends drops the pending batch and discards an open paste (told either way).
// The typing set names a controller by the name it unlocked under, not a later chat name. Nothing
// typed is ever logged.
//
// GRACE. Keystrokes are in flight when control ends (a release, the owner turning typing off, a new
// password, the lock, a join whose terminal cannot take input — every one of them goes through
// `loseControl`): input from a connection that stopped
// controlling within INPUT_GRACE_MS is dropped silently — not delivered, not counted, not a breach.
// From a connection that never controlled, or later than that, it is a breach as before.
//
// THE TYPING SET: the names with accepted input in the last TYPING_WINDOW_MS. It is recomputed at
// most once per TYPING_EVENT_MIN_MS while anyone is in it (which is also what clears it), sent as
// `watch:typing` to every joined viewer when the SET changes (a new order alone is no news), and to a
// viewer right after its meta on every (re)join while it is not empty — otherwise a viewer that
// reconnects mid-typing would never learn it. A connection that loses control or ends leaves it at
// once (the event follows within a tick).
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
// NO CAPTURE IS NOT AN EMPTY SCREEN (R36). A backend with no visible-only capture (a session host from
// a build before `captureVisible`, a direct Windows pty, a plain shell) and a capture that failed answer
// `unavailable`, and then NO keyframe is sent: the viewer paints a keyframe as reset + clear, so an empty one would erase what
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
  INPUT_MAX,
  PASSWORD_MAX,
  TYPING_NAMES_MAX,
  WATCH_CHAT_CAST,
  WATCH_EVENT,
  WATCH_INPUT_CAST,
  WATCH_PROTOCOL_VERSION,
  WATCH_RELEASE_CAST,
  WATCH_UNLOCK_CAST,
  sanitizeChatName,
  sanitizeChatText,
  type WatchChatMessage,
  type WatchControlEvent,
  type WatchKeyframe,
  type WatchLinkEndReason,
  type WatchMeta
} from '../../shared/watch-link/protocol'
import type { HostTokenResult } from './api'
import { unavailableCapture, type VisibleCapture } from './capture-route'
import { createInputSplitter, createTypingTracker, type InputSplitter } from './control-input'
import { PANE_INPUT_DEADLINE_MS, WATCHER_INPUT_ROUTES, type ControlInputChunk, type WatcherInputRoute } from './pane-input'
import { isTerminalReport } from '../terminal-reports'
import { createStreamFilter, type StreamFilter } from './stream-filter'
import { createTokenBucket, type TokenBucket } from './token-bucket'
import {
  WATCHER_BUFFER_LIMIT,
  WATCHER_REFUSAL,
  WATCHER_RESUME_BELOW,
  watcherAccess,
  wrapWatcherSink
} from './watcher-policy'
import { CONTROL_WRONG_MAX, type WatchLinkRecord } from './store'

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
/** A Control link's unlock throttles: one attempt per viewer per 2 s; 3 wrong end that connection;
 *  10 wrong across the link lock control until the owner allows it again. */
export const UNLOCK_MIN_INTERVAL_MS = 2_000
export const WRONG_PER_CONN = 3
export const WRONG_PER_LINK = CONTROL_WRONG_MAX
/** A controller's input budget (UTF-8 bytes): its own token bucket, separate from the stream's. */
export const INPUT_RATE = 64 * 1024
export const INPUT_BURST = 256 * 1024
/** Input is collected this long per connection, then delivered as one batch. */
export const INPUT_BATCH_MS = 20
/** At most this many chunks in one batch: each is a pane delivery (a tmux spawn). Past it, the rest of
 *  that batch is dropped (whole chunks: a paste is never cut) with the `dropped` notice. */
export const INPUT_CHUNKS_MAX = 64
/** The typing set is recomputed (and sent, when it changed) at most this often. */
export const TYPING_EVENT_MIN_MS = 1000
/** A viewer is told its input was dropped at most this often. */
export const DROPPED_NOTICE_MIN_MS = 10_000
/** Input from a connection that stopped controlling this recently is dropped silently: keystrokes in
 *  flight when control ended are not a breach. Later than this, they are. */
export const INPUT_GRACE_MS = 5000
/** A pane delivery that has not answered by now counts as failed: the batch stops (`dropped`) and the
 *  link's chain moves on. A late answer is ignored. */
export const INPUT_DELIVERY_TIMEOUT_MS = PANE_INPUT_DEADLINE_MS
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
  /** How a controller's input reaches this session's pane (`PtyManager.watcherInputRoute`). `none`
   *  (Zellij, an unknown session; also what a missing or unknown answer reads as) refuses control. */
  input: WatcherInputRoute
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
  /** Deliver one chunk of a controller's input to the session's PANE (`PtyManager.controlInput`, never
   *  a tmux client's key table). Whether it was delivered; a rejection counts as false. `isCurrent` is
   *  asked right before the delivery runs (the chunk may wait behind a slow one): false — its sender no
   *  longer controls, in the period it typed in — and it is never delivered. */
  input(sessionId: string, chunk: ControlInputChunk, isCurrent?: () => boolean): Promise<boolean>
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
  /** A Control link's password check, against `record.control` as it is when called. Never asked
   *  about a malformed or over-long password, and at most one check is in flight per link. */
  verifyPassword(pw: string): Promise<boolean>
  /** A viewer unlocked control, under this sanitized, self-chosen name. */
  onControlTaken(name: string): void
  /** WRONG_PER_LINK wrong attempts across the link. The service sets `record.control.locked = true`
   *  before it returns (the host reads the record live and never writes it). */
  onControlLocked(): void
  /** A wrong unlock attempt: the link-wide count is now `count` (1..WRONG_PER_LINK). The service puts it
   *  on `record.control.wrong` and writes it (the 10th rides the lock's own write), so a restart does
   *  not reset it. Called before `onControlLocked`. */
  onWrongAttempt(count: number): void
}
export type LinkRuntimeStatus = 'live' | 'reconnecting' | 'refused'
export interface LinkViewer {
  viewerId: string
  /** While controlling, the name it unlocked under; otherwise its chat name (null before it chats). */
  name: string | null
  joinedAt: number
  /** Connected, but its last join found no session to watch (R63): what the owner must be told,
   *  because only the owner can fix it — on a backend with no watcher client (Windows' session host,
   *  no local tmux, Zellij) a viewer can co-attach only to a terminal this app has OPEN. Set by a
   *  REFUSED join, never by a session merely ending: that rejoins in seconds, usually successfully. */
  waiting: boolean
  /** Unlocked this Control link with its password and has not lost control since. */
  controlling: boolean
  /** Gave accepted input in the last TYPING_WINDOW_MS, while controlling. */
  typing: boolean
}
export interface LinkHost {
  start(): void
  stop(reason: WatchLinkEndReason): void
  kick(viewerId: string): boolean
  postSharerChat(text: string): WatchChatMessage | null
  chatHistory(): WatchChatMessage[]
  status(): LinkRuntimeStatus
  viewers(): LinkViewer[]
  /** The service changed `record.control.enabled` (or cleared `locked`): off or locked demotes every
   *  controller, and every joined viewer is told its state. */
  controlChanged(): void
  /** The password was replaced: every controller is demoted and must unlock with the new one, and the
   *  link-wide wrong count starts over (the service resets the record's). */
  passwordChanged(): void
  /** The owner cleared the lock: the link-wide wrong count starts over, then as `controlChanged`. */
  allowControl(): void
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
  /** Unlocked this Control link (per connection: a reconnect unlocks again). */
  controlling: boolean
  /** Wrong unlock attempts on this connection since its last success. */
  wrong: number
  /** When this viewer's last unlock attempt was taken (a too-soon one is not). */
  lastUnlockAt: number
  /** When this connection last stopped controlling (INPUT_GRACE_MS); null while it never did. */
  controlStoppedAt: number | null
  /** Bumped every time this connection loses control: a batch from before is never delivered. */
  controlGen: number
  /** The last landed join's input route; null before the first one. */
  input: WatcherInputRoute | null
  splitter: InputSplitter
  inputBucket: TokenBucket
  /** Input collected since the last flush: its chunks, the session it was typed at, its UTF-8 bytes. */
  batch: ControlInputChunk[]
  /** The batch reached INPUT_CHUNKS_MAX: the rest of it is dropped until it is flushed. */
  batchFull: boolean
  batchSession: string | null
  batchBytes: number
  batchTimer: unknown
  /** A batch of this connection is in the host-wide flush chain and has not finished. */
  inChain: boolean
  /** The chunk being delivered now: its deadline timer, and how to settle it early (end, stop). */
  delivery: { timer: unknown; settle(ok: boolean): void } | null
  lastDroppedAt: number
  /** The name control was taken under (the unlock's); a later chat name does not change who typed. */
  controlName: string | null
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

/** One connection's batch in the flush chain: its chunks, the session typed at, the control period. */
interface Batch {
  chunks: ControlInputChunk[]
  session: string
  gen: number
}

interface CaptureSlot {
  current: { epoch: number; result: Promise<VisibleCapture> } | null
  /** The one rerun queued behind `current`, shared by every keyframe that needs a newer capture. */
  next: { result: Promise<VisibleCapture>; start(): void } | null
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** The same members, in any order (the typing set is a set: a new order alone is no news). */
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((x) => set.has(x))
}

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
  // A missing or unknown route refuses control: typing must never be guessed onto a backend.
  const input = (WATCHER_INPUT_ROUTES as readonly unknown[]).includes(o.input) ? (o.input as WatcherInputRoute) : 'none'
  return { sessionId, cols: o.cols as number, rows: o.rows as number, altScreen: o.altScreen === true, input }
}

/** A well-formed unlock payload, or null. The password is bounded before anything else reads it: over
 *  PASSWORD_MAX code points is malformed, and the cheap UTF-16 test first means a huge string is never
 *  split into an array. An empty one cannot match any stored password and is not worth a scrypt. */
function readUnlock(p: unknown): { name: string; password: string } | null {
  if (!p || typeof p !== 'object') return null
  const name = sanitizeChatName((p as { name?: unknown }).name)
  const password = (p as { password?: unknown }).password
  if (!name || typeof password !== 'string' || password.length === 0) return null
  if (password.length > PASSWORD_MAX * 2 || Array.from(password).length > PASSWORD_MAX) return null
  return { name, password }
}

/** The link-wide wrong count a record holds, as an integer 0..WRONG_PER_LINK: a hand edit cannot buy
 *  guesses (the store refuses anything else on load; this is the host's own belt). */
function storedWrong(r: WatchLinkRecord): number {
  const n = r.control?.wrong
  if (typeof n !== 'number' || Number.isNaN(n)) return 0
  return Math.min(WRONG_PER_LINK, Math.max(0, Math.floor(n)))
}

function normalizeCapture(c: unknown): VisibleCapture {
  if (!c || typeof c !== 'object' || typeof (c as VisibleCapture).screen !== 'string') return unavailableCapture()
  if ((c as VisibleCapture).unavailable === true) return unavailableCapture()
  const cur = (c as VisibleCapture).cursor
  const ok = !!cur && Number.isInteger(cur.x) && Number.isInteger(cur.y) && cur.x >= 0 && cur.y >= 0
  const alt = (c as VisibleCapture).altScreen
  return {
    screen: (c as VisibleCapture).screen,
    cursor: ok ? { x: cur!.x, y: cur!.y } : null,
    ...(typeof alt === 'boolean' ? { altScreen: alt } : {})
  }
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
  /** Wrong unlock attempts across the link, starting from the record's (the service persists every new
   *  count, so an app restart does not reset it). */
  let linkWrong = storedWrong(record)
  /** A password check is in flight: one per link. */
  let verifying = false
  /** Bumped by every change to control (off/on, a new password, the lock, allowControl): a check that
   *  started under an older epoch is void when it returns. */
  let controlEpoch = 0
  /** One delivery at a time across the link: every controller's batch reaches the pane whole, in
   *  flush order. Never rejects (each link is caught), so a failure cannot stall the chain. */
  let inputChain: Promise<void> = Promise.resolve()
  const tracker = createTypingTracker()
  /** The typing set as last sent (names) and the viewers in it (for the owner's view). */
  let typingNames: string[] = []
  let typingIds: string[] = []
  let typingTimer: unknown = null
  let lastTypingAt = -Infinity

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
    c.controlling = false
    clearInput(c)
    c.splitter.reset()
    // A delivery still waiting for the pane must not hold every other controller's batch.
    c.delivery?.settle(false)
    forgetTyping(c)
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
        // The join's answer (R18), unless the capture knows the stream's buffer itself (session host).
        altScreen: cap.altScreen ?? c.altScreen,
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
    c.input = res.input
    // A terminal that cannot take input: whoever controls it stops (its keystrokes in flight get the
    // grace), and the meta below says `unsupported`.
    const demoted = res.input === 'none' && c.controlling
    if (demoted) loseControl(c)
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
    // A Control link's state for THIS viewer rides every (re)join; absent on every other role.
    if (record.role === 'controller') meta.control = controlStateFor(c)
    if (!send(c, WATCH_EVENT.meta, meta)) return
    // The typing set is otherwise sent only when it changes: a viewer (re)joining mid-typing would
    // never learn it.
    if (typingNames.length > 0) send(c, WATCH_EVENT.typing, { names: typingNames })
    if (demoted) safe('onChange', deps.onChange)
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
    // Input typed at this session's screen never reaches the next session.
    abandonInput(c)
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
    // relay-host's access hook admits exactly these (watcherAccess); anything else got past it.
    if (method === WATCH_CHAT_CAST && (record.role === 'commenter' || record.role === 'controller')) {
      onChat(c, args)
      return
    }
    if (record.role === 'controller') {
      if (method === WATCH_UNLOCK_CAST) {
        // Never the error's text: nothing that might carry the password is logged.
        onUnlock(c, args).catch((err) => warn(c, 'an unlock failed', err instanceof Error ? err.name : 'not an Error'))
        return
      }
      if (method === WATCH_INPUT_CAST) {
        onInput(c, args)
        return
      }
      if (method === WATCH_RELEASE_CAST) {
        onRelease(c)
        return
      }
    }
    policyBreach(c, `cast ${method}`)
  }
  function onChat(c: Conn, args: unknown[]): void {
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

  // --- control (a Control link) -----------------------------------------------------------------------

  /** This viewer's control state, as meta and every unprompted `watch:control` carry it. */
  function controlStateFor(c: Conn): WatchControlEvent {
    const ctl = record.control
    // The watched terminal cannot take input (Zellij, an unknown session): no password changes that.
    if (c.input === 'none') return { state: 'off', reason: 'unsupported' }
    if (c.controlling && ctl && ctl.enabled && !ctl.locked) return { state: 'controlling' }
    if (ctl?.locked) return { state: 'locked' }
    if (!ctl || !ctl.enabled) return { state: 'off' }
    return { state: 'available' }
  }
  function sendControl(c: Conn, ev: WatchControlEvent): void {
    send(c, WATCH_EVENT.control, ev)
  }
  const joinedConns = (): Conn[] => [...conns].filter((c) => c.joinedAt !== null && !c.ended)

  async function onUnlock(c: Conn, args: unknown[]): Promise<void> {
    if (c.ended || c.joinedAt === null || stopped) return
    const state = controlStateFor(c)
    // Already controlling, locked or off: answered as it stands, never counted, never throttled.
    if (state.state === 'controlling') {
      sendControl(c, state)
      return
    }
    if (state.state === 'locked' || state.state === 'off') {
      sendControl(c, { state: state.state, reason: state.reason ?? state.state })
      return
    }
    const now = deps.now()
    if (verifying || now - c.lastUnlockAt < UNLOCK_MIN_INTERVAL_MS) {
      sendControl(c, { state: state.state, reason: 'too-soon' })
      return
    }
    c.lastUnlockAt = now
    const attempt = readUnlock(args[0])
    // A malformed attempt is still an attempt.
    if (!attempt) {
      wrongAttempt(c)
      return
    }
    verifying = true
    const epoch = controlEpoch
    let right: boolean | null = null
    try {
      right = (await deps.verifyPassword(attempt.password)) === true
    } catch (err) {
      warn(c, 'a control password check failed', err instanceof Error ? err.name : 'not an Error')
    } finally {
      verifying = false
    }
    if (c.ended || stopped) return
    if (right === null || epoch !== controlEpoch || controlStateFor(c).state !== 'available') {
      refuseVoid(c)
      return
    }
    if (!right) {
      wrongAttempt(c)
      return
    }
    c.controlling = true
    c.wrong = 0
    c.name = attempt.name
    c.controlName = attempt.name
    sendControl(c, { state: 'controlling' })
    // That send can end the connection (a backlog past VIEWER_BACKLOG_CLOSE): then nobody took control.
    if (c.ended) return
    safe('onControlTaken', () => deps.onControlTaken(attempt.name))
    safe('onChange', deps.onChange)
  }
  /** A check whose answer no longer applies (control changed under it, or it failed): void, not
   *  wrong. Nothing is counted, and the viewer may try again. */
  function refuseVoid(c: Conn): void {
    const state = controlStateFor(c)
    if (state.state === 'locked' || state.state === 'off') sendControl(c, { state: state.state, reason: state.reason ?? state.state })
    else sendControl(c, { state: state.state, reason: 'too-soon' })
  }
  function wrongAttempt(c: Conn): void {
    c.wrong++
    linkWrong++
    // The service records (and writes) the link-wide count before any lock below.
    const count = Math.min(linkWrong, WRONG_PER_LINK)
    safe('onWrongAttempt', () => deps.onWrongAttempt(count))
    sendControl(c, { state: controlStateFor(c).state, reason: 'wrong' })
    if (linkWrong >= WRONG_PER_LINK) lockLink()
    if (c.wrong >= WRONG_PER_CONN) endConn(c, 'attempts')
  }
  /** Locked: the service records it (synchronously, in `onControlLocked`), every viewer is told, and
   *  every controller drops back to watching. */
  function lockLink(): void {
    controlEpoch++
    safe('onControlLocked', () => deps.onControlLocked())
    // The lock rests on the service recording it before it returns. If it did not (it threw, or a
    // wiring slip), the next attempt would be verified again: say so loudly, and still demote and tell.
    if (record.control?.locked !== true) console.error('[watch-link] onControlLocked did not lock the link')
    for (const c of joinedConns()) {
      loseControl(c)
      sendControl(c, { state: 'locked', reason: 'locked' })
    }
    safe('onChange', deps.onChange)
  }
  /** Control changed under every viewer: off or locked demotes the controllers; each is told. */
  function broadcastControl(): void {
    controlEpoch++
    const ctl = record.control
    const usable = !!ctl && ctl.enabled && !ctl.locked
    for (const c of joinedConns()) {
      if (!usable) loseControl(c)
      sendControl(c, controlStateFor(c))
    }
    safe('onChange', deps.onChange)
  }
  function onRelease(c: Conn): void {
    if (c.ended || c.joinedAt === null || !c.controlling) return
    loseControl(c)
    sendControl(c, controlStateFor(c))
    safe('onChange', deps.onChange)
  }

  // --- typing: the input path ---------------------------------------------------------------------------

  /** This connection stops controlling: its pending input is discarded, an open paste forgotten, it
   *  leaves the typing set, and its keystrokes still in flight get INPUT_GRACE_MS of silence. */
  function loseControl(c: Conn): void {
    if (!c.controlling) return
    c.controlling = false
    c.controlStoppedAt = deps.now()
    c.controlGen++
    clearInput(c)
    c.splitter.reset()
    forgetTyping(c)
  }
  function clearInput(c: Conn): void {
    clearTimer(c.batchTimer)
    c.batchTimer = null
    c.batch = []
    c.batchFull = false
    c.batchBytes = 0
    c.batchSession = null
  }
  /** The watched session ended: pending input is dropped (and the controller told), and an open paste
   *  is discarded whole when its end arrives. */
  function abandonInput(c: Conn): void {
    const had = c.batch.length > 0 || c.splitter.pasteOpen()
    clearInput(c)
    c.splitter.discard('')
    if (had) noteDropped(c)
  }
  /** "Some of your input did not reach the terminal", at most once per DROPPED_NOTICE_MIN_MS, and only
   *  to a connection that is still controlling (one that lost control was told its new state). */
  function noteDropped(c: Conn): void {
    if (c.ended || controlStateFor(c).state !== 'controlling') return
    const now = deps.now()
    if (now - c.lastDroppedAt < DROPPED_NOTICE_MIN_MS) return
    c.lastDroppedAt = now
    sendControl(c, { state: 'controlling', reason: 'dropped' })
  }
  const withinGrace = (c: Conn): boolean => c.controlStoppedAt !== null && deps.now() - c.controlStoppedAt <= INPUT_GRACE_MS

  function onInput(c: Conn, args: unknown[]): void {
    if (c.ended) return
    if (controlStateFor(c).state !== 'controlling') {
      // Keystrokes in flight when control ended (released, demoted, or the record changed and the
      // host has not been told yet) are dropped silently. From anyone else, or later, a breach.
      if (c.controlling || withinGrace(c)) return
      policyBreach(c, `cast ${WATCH_INPUT_CAST}`)
      return
    }
    const p = args[0]
    const data = p && typeof p === 'object' ? (p as { data?: unknown }).data : undefined
    if (typeof data !== 'string' || data.length === 0 || data.length > INPUT_MAX) {
      policyBreach(c, `malformed ${WATCH_INPUT_CAST}`)
      return
    }
    // The viewer's emulator answering the pane's own queries (DA, CPR, a colour) is not typing: every
    // controller would answer every query again into the pane. Not counted against the budget.
    if (isTerminalReport(data)) return
    const bytes = Buffer.byteLength(data, 'utf8')
    const sid = c.sessionId
    // No session to type into (waiting), or over budget — a batch already holding INPUT_CHUNKS_MAX
    // chunks, the bucket, or a batch the panes have not taken yet already holding a burst: dropped, and
    // the viewer told. Input is never held for a later session. The splitter still sees it, so a paste
    // it belonged to is discarded whole.
    if (sid === null || c.batchFull || c.batchBytes + bytes > INPUT_BURST || !c.inputBucket.take(bytes)) {
      c.splitter.discard(data)
      noteDropped(c)
      return
    }
    if (c.batchSession !== null && c.batchSession !== sid) abandonInput(c)
    c.batchSession = sid
    c.batchBytes += bytes
    appendChunks(c, c.splitter.push(data))
    if (c.controlName) tracker.note(c.viewerId, c.controlName, deps.now())
    scheduleTyping()
    if (c.batchTimer === null) {
      c.batchTimer = deps.setTimeout(() => {
        c.batchTimer = null
        flushBatch(c)
      }, INPUT_BATCH_MS)
    }
  }
  /** Adjacent keys merge (up to INPUT_MAX units): one pane delivery per run of typing, not per cast. A
   *  batch holds at most INPUT_CHUNKS_MAX chunks: the first chunk past it ends the batch's intake. */
  function appendChunks(c: Conn, chunks: ControlInputChunk[]): void {
    for (const ch of chunks) {
      if (c.batchFull) return
      const last = c.batch[c.batch.length - 1]
      if (ch.kind === 'keys' && last?.kind === 'keys' && last.data.length + ch.data.length <= INPUT_MAX) {
        c.batch[c.batch.length - 1] = { kind: 'keys', data: last.data + ch.data }
      } else if (c.batch.length >= INPUT_CHUNKS_MAX) {
        batchFilled(c)
        return
      } else c.batch.push(ch)
    }
  }
  /** The batch is full: this chunk and the rest of the batch are dropped, in whole chunks — what the
   *  splitter still holds belongs to that rest (an open paste is discarded whole, a held prefix is never
   *  keys), and later input is dropped until the batch is flushed. The viewer is told. */
  function batchFilled(c: Conn): void {
    c.batchFull = true
    c.splitter.discard('')
    noteDropped(c)
  }
  /** Hand the connection's batch to the host-wide chain. While its previous batch is still there, this
   *  one waits (and keeps collecting) and follows it the moment it finishes: one batch per connection
   *  in the chain at most, so a slow pane cannot pile up deliveries. */
  function flushBatch(c: Conn): void {
    if (c.ended || stopped || c.inChain) return
    // A held Esc or Alt+[ is a key press by now; a longer marker prefix keeps waiting (control-input.ts).
    appendChunks(c, c.splitter.drain())
    const chunks = c.batch
    const session = c.batchSession
    c.batch = []
    c.batchFull = false
    c.batchBytes = 0
    c.batchSession = null
    if (chunks.length === 0 || session === null) return
    const batch = { chunks, session, gen: c.controlGen }
    c.inChain = true
    // A rejection here would skip every later batch of every controller: caught, by name only.
    inputChain = inputChain
      .then(() => deliverBatch(c, batch))
      .catch((err) => warn(null, 'the input chain failed', err instanceof Error ? err.name : 'not an Error'))
  }
  /** The batch's sender still controls, in the control period it typed in. */
  const stillControls = (c: Conn, b: Batch): boolean =>
    !stopped && !c.ended && c.controlGen === b.gen && controlStateFor(c).state === 'controlling'
  /** Deliver one batch whole, chunk by chunk, re-checking before each that its sender still controls,
   *  under the same control period, the session it typed at. A false (or a rejection) stops it. */
  async function deliverBatch(c: Conn, b: Batch): Promise<void> {
    try {
      for (const chunk of b.chunks) {
        // Control ended since it was typed (and the viewer was told its new state): void, silently.
        if (!stillControls(c, b)) return
        // The session it was typed at is gone: what is left did not reach the terminal.
        if (c.sessionId !== b.session) {
          noteDropped(c)
          return
        }
        const ok = await deliverChunk(c, b, chunk)
        if (!ok) {
          noteDropped(c)
          return
        }
      }
    } finally {
      c.inChain = false
      // What it collected meanwhile, when its own timer has already fired.
      if (c.batchTimer === null) safe('an input flush', () => flushBatch(c))
    }
  }

  /** One chunk to the pane, answered within INPUT_DELIVERY_TIMEOUT_MS. A rejection, a throw, or no
   *  answer in time is false; an answer after that is ignored. `ended` settles it at once (false), so a
   *  pane that never answers cannot hold the link's chain beyond its deadline. */
  function deliverChunk(c: Conn, b: Batch, chunk: ControlInputChunk): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const slot: { timer: unknown; settle(ok: boolean): void } = {
        timer: null,
        settle(ok) {
          if (settled) return
          settled = true
          clearTimer(slot.timer)
          slot.timer = null
          if (c.delivery === slot) c.delivery = null
          resolve(ok)
        }
      }
      c.delivery = slot
      slot.timer = deps.setTimeout(() => {
        slot.timer = null
        warn(c, 'a pane delivery timed out', `no answer in ${INPUT_DELIVERY_TIMEOUT_MS} ms`)
        slot.settle(false)
      }, INPUT_DELIVERY_TIMEOUT_MS)
      const failed = (err: unknown): void => {
        // Never the error's text: what failed to type may be in it.
        warn(c, 'delivering input failed', err instanceof Error ? err.name : 'not an Error')
        slot.settle(false)
      }
      // The same check as before this chunk, asked again by PtyManager right before it runs: a chunk
      // still waiting in its per-session chain when its sender stops controlling never lands.
      const isCurrent = (): boolean => stillControls(c, b) && c.sessionId === b.session
      try {
        void Promise.resolve(deps.pty.input(b.session, chunk, isCurrent)).then((ok) => slot.settle(ok === true), failed)
      } catch (err) {
        failed(err)
      }
    })
  }

  // --- typing: who is typing --------------------------------------------------------------------------

  function forgetTyping(c: Conn): void {
    tracker.drop(c.viewerId)
    scheduleTyping()
  }
  /** Recompute the typing set now, or at most TYPING_EVENT_MIN_MS after the last time. */
  function scheduleTyping(): void {
    if (stopped || typingTimer !== null) return
    const wait = TYPING_EVENT_MIN_MS - (deps.now() - lastTypingAt)
    if (wait <= 0) evaluateTyping()
    else typingTimer = deps.setTimeout(evaluateTyping, wait)
  }
  function evaluateTyping(): void {
    typingTimer = null
    if (stopped) return
    const now = deps.now()
    lastTypingAt = now
    const names = tracker.names(now).slice(0, TYPING_NAMES_MAX)
    const ids = joinedConns()
      .filter((c) => tracker.typing(c.viewerId, now))
      .map((c) => c.viewerId)
    const namesChanged = !sameMembers(names, typingNames)
    const idsChanged = !sameMembers(ids, typingIds)
    typingNames = names
    typingIds = ids
    if (namesChanged) for (const c of joinedConns()) send(c, WATCH_EVENT.typing, { names })
    if (namesChanged || idsChanged) safe('onChange', deps.onChange)
    // While anyone is in the set, look again in a second (that is also what clears it).
    if (names.length > 0 && typingTimer === null && !stopped) typingTimer = deps.setTimeout(evaluateTyping, TYPING_EVENT_MIN_MS)
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
      controlling: false,
      wrong: 0,
      lastUnlockAt: -Infinity,
      controlStoppedAt: null,
      controlGen: 0,
      input: null,
      splitter: createInputSplitter(),
      inputBucket: createTokenBucket({ ratePerSec: INPUT_RATE, burst: INPUT_BURST, now: deps.now }),
      batch: [],
      batchFull: false,
      batchSession: null,
      batchBytes: 0,
      batchTimer: null,
      inChain: false,
      delivery: null,
      lastDroppedAt: -Infinity,
      controlName: null,
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
    const now = deps.now()
    for (const c of conns) {
      if (c.joinedAt === null || c.ended) continue
      // The effective state: a flag the host has not yet been told to clear never reads as control.
      const controlling = controlStateFor(c).state === 'controlling'
      out.push({
        viewerId: c.viewerId,
        // While it controls, the name it unlocked under — the one the typing set and the owner's
        // "took control" notice use — never a later chat name beside them.
        name: controlling ? (c.controlName ?? c.name) : c.name,
        joinedAt: c.joinedAt,
        waiting: c.joinRefused && c.sessionId === null,
        controlling,
        typing: tracker.typing(c.viewerId, now)
      })
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
    clearTimer(typingTimer)
    typingTimer = null
    typingNames = []
    typingIds = []
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
      if (!clean || (record.role !== 'commenter' && record.role !== 'controller') || stopped) return null
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
    viewers,
    controlChanged() {
      if (stopped || record.role !== 'controller') return
      broadcastControl()
    },
    passwordChanged() {
      if (stopped || record.role !== 'controller') return
      // A new password starts the link-wide count over (the service resets the record's too).
      linkWrong = 0
      controlEpoch++
      for (const c of joinedConns()) {
        if (!c.controlling) continue
        loseControl(c)
        sendControl(c, controlStateFor(c))
      }
      safe('onChange', deps.onChange)
    },
    allowControl() {
      if (stopped || record.role !== 'controller') return
      linkWrong = 0
      broadcastControl()
    }
  }
}

// Wire protocol between the standalone session-host process and its Node clients (today: the
// desktop main process — see src/core/session-host-client.ts). Newline-delimited JSON over a
// local named pipe (Windows) or unix domain socket (POSIX/WSL/etc).
//
// This module is pure TypeScript with no Electron/Node-native imports so it can be bundled into
// BOTH the standalone host process (out/session-host/host.cjs, built with esbuild — see
// scripts nothing, just the `host:build` npm script) and the Electron main process bundle
// (electron-vite). See docs/windows-session-host.md for the architecture this implements.

/** Bumped whenever a request/response/event SHAPE changes. Carried in the host's state file and
 * enforced by the client before hello, so a newly packaged client cannot reuse a long-lived host
 * whose attach/flow contract predates its own. */
export const SESSION_HOST_PROTOCOL_VERSION = 2

// Independently versioned, additive messaging extension. The v1/v2 terminal/attach contract is
// unchanged: an older live host rejects these unknown commands but is NEVER replaced to enable
// them. A future incompatible messaging shape gets new command names, not a forced host restart.
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'

/** Concrete parser owned by the live terminal generation. Kept in the host so a new renderer/main
 * process can safely encode a delayed launch without re-guessing from a stale profile id. */
export type SessionHostShellDialect = 'posix' | 'pwsh' | 'windows-powershell' | 'cmd'

/** Exactly what node-pty needs to spawn — passed on `attach` so the host never has to compute cwd
 *  resolution, PATH, hook env, etc. itself. The CLIENT (pty-manager.ts, which already resolves all
 *  of this for the tmux/plain-shell paths) is the one source of truth for that logic. */
export interface SessionHostSpawnOptions {
  cwd: string
  shell: string
  args: string[]
  env: Record<string, string>
  cols: number
  rows: number
  /** Required for trusted v2 profile launches; omitted only by legacy/test callers that will not
   * execute an opaque launch intent on this generation. */
  launchDialect?: SessionHostShellDialect
  /** Optional trusted cold-start launch. The host inserts this id into the new generation's
   * exactly-once ledger before typing any input and completes it before acknowledging attach. */
  initialLaunch?: {
    launchId: string
    command: string
    stdinAfterStart?: string
  }
}

/** Client → host requests. Every request carries a monotonic `id`; the host echoes it on the
 *  matching response so replies can be correlated over one shared, long-lived connection — the
 *  same idiom `ControlModeClient` uses for tmux control-mode, minus the positional-FIFO fragility
 *  (JSON here carries its own id, so an out-of-order reply is still recoverable). */
export type SessionHostRequest =
  | {
      id: number
      cmd: 'hello'
      token: string
      protocolVersion: number
      /** Additive capabilities this CLIENT understands, independent of the protocol version (which
       * a long-lived host can only change by being replaced). The host answers with the subset it
       * also speaks in `HelloResult.features`, and must never push a frame a connection did not
       * opt into here: an older client reads ANY push frame that is not `data` as an exit. */
      features?: SessionHostFeature[]
    }
  | {
      id: number
      cmd: 'attach'
      name: string
      spawn: SessionHostSpawnOptions
      /** Cap on both the emulator's live scrollback buffer and how much `capture`'s `full: true`
       *  returns. Clients send `xtermScrollback(settings.tmuxScrollback)` (≤ 10k — the renderer's
       *  own cap, NOT tmux's history-limit); the host clamps again (`clampEmulatorScrollback`) so
       *  an older client's raw 50,000 cannot allocate history nobody can scroll to. */
      scrollback: number
      /** Capability established by a confirmed kill. Required to cold-create that reserved name;
       * other authenticated app clients cannot steal the replacement window. */
      replacementToken?: string
      /** The reconnecting connection already owes an explicit flow pause. Restored before the
       * screen barrier and live subscriber activation, so no output leaks through reconnect. */
      paused?: boolean
    }
  /** Warm attach that is atomic with the host's existence check. It deliberately carries no
   * spawn plan: absence/exit is an error and can never recreate a session with stale settings. */
  | {
      id: number
      cmd: 'attachExisting'
      name: string
      /** When known, prevents a same-name replacement from satisfying a stale warm attach. */
      expectedGeneration?: string
      /** Optional aggregate reconnect state. Older v2 clients omit it; the host then reuses the
       * generation's current geometry while retaining the no-spawn/expected-generation guard. */
      cols?: number
      rows?: number
      paused?: boolean
      /** `watch-attach` feature only: subscribe this connection WITHOUT a geometry claim (a live
       * link viewer / relay viewer's read-only view). Carries no cols/rows; never spawns. On a
       * connection already attached it WITHDRAWS that connection's claim (its last voting
       * subscriber left). A later claim-carrying attach upgrades it again. */
      watch?: boolean
    }
  | { id: number; cmd: 'hasSession'; name: string }
  | { id: number; cmd: 'write'; name: string; data: string }
  | { id: number; cmd: 'resize'; name: string; cols: number; rows: number }
  | { id: number; cmd: 'pause'; name: string }
  | { id: number; cmd: 'resume'; name: string }
  | { id: number; cmd: 'sendKeys' | 'sendKeysV2'; name: string; text: string; enter: boolean }
  | { id: number; cmd: 'paneCommand'; name: string }
  | { id: number; cmd: 'messageOwnerV1'; name: string }
  | { id: number; cmd: 'messagePasteReadyV1'; name: string }
  | { id: number; cmd: 'messageEnvelopeV1'; name: string; envelope: string; expected: PaneOwner }
  /** End the proven agent process tree (`expected`, from `messageOwnerV1`) without touching the
   *  console root. Result: `TerminateOwnerResult`. Additive like the messaging extension: an older
   *  live host answers `unknown command`, which the client reports as unsupported. */
  | { id: number; cmd: 'terminateOwnerV1'; name: string; expected: PaneOwner }
  /** Raw, verbatim keystroke bytes into a session this connection need NOT be attached to — the
   *  `tmux send-keys -H` of a released node. No framing, no sanitizing, no Enter. An older host
   *  answers `unknown command`; the client then fails closed and never falls back to sendKeys. */
  | { id: number; cmd: 'writeDetachedV1'; name: string; data: string }
  | { id: number; cmd: 'capture'; name: string; full: boolean }
  /** `captureVisible` feature only: the VISIBLE rows (no history) plus cursor + active buffer — a
   *  live link's keyframe. Never sent to a host that did not advertise it. */
  | { id: number; cmd: 'captureVisible'; name: string }
  /** `paneCwd` feature only: the last cwd the pane REPORTED (OSC 7 / 9;9 / 633), never the spawn
   *  cwd. */
  | { id: number; cmd: 'paneCwd'; name: string }
  /** Additive (the `messageOwnerV1` idiom): an older live host answers `unknown command`, which the
   *  client reads as "unknown", never as a reason to replace the host. Result: `PaneModesResult`. */
  | { id: number; cmd: 'paneModesV1'; name: string }
  | {
      id: number
      cmd: 'executeLaunch'
      name: string
      /** Exact host process generation returned by attach/attachExisting. */
      generation: string
      /** Machine-local UUID v4. Host deduplication is scoped to this generation. */
      launchId: string
      /** Core-private, already validated and rendered input. Never returned on the wire. */
      command: string
      stdinAfterStart?: string
    }
  | {
      id: number
      cmd: 'killSession'
      name: string
      /** Stable across client reconnect/retry. The host caches completed operations so a lost
       * acknowledgement can never kill a newer same-name generation (multi-client ABA). */
      operationId: string
      /** Exact process generation observed by attach/hasSession. A different current generation
       * proves the requested target is already gone and must not be killed. */
      expectedGeneration?: string
      /** Confirmed recycle reserves the now-empty name for the same client operation. Generic
       * deletion leaves no token and does not block a later ordinary create/undo. */
      reserveReplacement: boolean
    }
  | { id: number; cmd: 'detach'; name: string }
  | { id: number; cmd: 'listSessions' }
  | { id: number; cmd: 'ping' }
  /** Prepare-for-update (issue #829): end EVERY session's process tree through the ordinary kill
   *  path, reply, then exit the host process. Accepted only from a connection that negotiated the
   *  `shutdown` feature at hello — an older client never sends it, and an older host answers
   *  `unknown command` without the app ever asking. Persisted node metadata is the APP's and is
   *  never touched here: nodes stay on the canvas and cold-restore on the next launch. */
  | { id: number; cmd: 'shutdown' }

/** Host → client response to a request, correlated by `id`. */
export type SessionHostResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string }

/** Host → client PUSH frames — not correlated to any request id; delivered for as long as this
 *  connection is a subscriber of `name` (see `attach` / `detach`). */
export type SessionHostEvent =
  | { type: 'data'; name: string; data: string; generation?: string }
  | {
      type: 'exit'
      name: string
      exitCode: number
      generation?: string
    }
  /** The size the host's pty now runs at, pushed whenever it changes (issue #914) — ONLY to a
   *  connection that negotiated the `geometry` feature at hello. That gate is not a nicety: an
   *  older client treats every non-`data` push frame as an exit and would retire a live session
   *  on the first resize. */
  | { type: 'geometry'; name: string; cols: number; rows: number; generation?: string }

export type SessionHostFrame = SessionHostResponse | SessionHostEvent

/**
 * `SessionHostRequest` minus `id`, DISTRIBUTED over the union rather than collapsed by a plain
 * `Omit<SessionHostRequest, 'id'>` — a bare `Omit` on a discriminated union only keeps properties
 * common to every member (here, just `cmd`), silently dropping every command-specific field like
 * `name`/`data`/`token`. The client builds requests against this type before assigning a real id.
 */
export type SessionHostRequestBody = SessionHostRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never

export function isEventFrame(f: SessionHostFrame): f is SessionHostEvent {
  const type = (f as SessionHostEvent).type
  return type === 'data' || type === 'exit' || type === 'geometry'
}

/** Result payload shapes, `result` on a successful response — documented here rather than typed
 *  as a discriminated union on `SessionHostResponse` itself, so the response type stays simple to
 *  parse off the wire; callers cast `result` to the shape their own command implies. */
export interface AttachResult {
  /** True when no session existed for this name and one was spawned just now — a cold start
   *  (first open, or a fresh host after the previous one died / the machine rebooted). False =
   *  warm reattach to a session that was already running (in THIS host process, which may have
   *  outlived several app restarts already). */
  fresh: boolean
  /**
   * The reconstructed screen — an xterm.js `SerializeAddon` dump (colors/attributes, private-mode
   * restore, alt-buffer switch and cursor placement all included — see terminal-emulator.ts).
   * Present on an ordinary warm attach, or on an idempotent replay of a consumed replacement token,
   * when the session has painted anything since it started; absent (never an empty string)
   * otherwise, mirroring `PtyCreateResult.screen`'s own contract ("guaranteed non-empty when
   * present").
   */
  screen?: string
  /** Opaque identity for the exact host-owned process behind this attachment. */
  /** Required by protocol v2; absent only while interoperating with a live legacy v1 host. */
  generation?: string
  /** Exact live parser. Required for generation-safe opaque launch execution. */
  launchDialect?: SessionHostShellDialect
  /** Sanitized outcome for an atomic cold-start launch; no rendered input is reflected. */
  initialLaunchStatus?: 'executed' | 'already-executed'
  /** The pty's size once this attach's own claim was applied. Present only for a connection that
   *  negotiated the `geometry` feature (issue #914). */
  geometry?: { cols: number; rows: number }
}
/** Additive, independently negotiated capabilities (see the `hello` request). */
export type SessionHostFeature =
  | 'geometry'
  | 'shutdown'
  | 'sessionDetails'
  | 'watch-attach'
  | 'captureVisible'
  | 'paneCwd'
export const SESSION_HOST_FEATURES: readonly SessionHostFeature[] = [
  'geometry',
  'shutdown',
  'sessionDetails',
  'watch-attach',
  'captureVisible',
  'paneCwd'
]

/** `result` of a successful `shutdown`: the session names whose process trees were ended. The
 *  host exits right after this reply is flushed. A shutdown that could not confirm every kill
 *  answers `ok: false` naming the sessions it could not end, and the host STAYS UP (accepting
 *  attaches again) — a partial shutdown must never be reported as done. */
export interface ShutdownResult {
  ended: string[]
}

/** `result` of a v2 `hello`. `features` is absent from a host that predates feature negotiation. */
export interface HelloResult {
  protocolVersion: number
  features?: SessionHostFeature[]
}

export interface HasSessionResult {
  exists: boolean
  /** Required with exists:true in v2; legacy v1 hosts do not provide it. */
  generation?: string
}
export interface KillSessionResult {
  /** Present only for a reserveReplacement operation that currently owns the name reservation. */
  replacementToken?: string
}
export interface ExecuteLaunchResult {
  /** No private command/input details are ever reflected to callers. */
  status: 'executed' | 'already-executed'
}
export interface PaneCommandResult {
  command: string | null
}
export interface TerminateOwnerResult {
  terminated: boolean
}
/** `result` of `paneModesV1`; `null` result = no such live session. */
export interface PaneModesResult {
  mouseTracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
}
export interface CaptureResult {
  text: string
}
/** `result` of `captureVisible`. `screen` is one `\n`-terminated line per visible row with SGR (the
 *  shape `capture-pane -p -e` prints), '' for a session that never painted; `cursor` is 0-based and
 *  viewport-relative; `altScreen` is the emulator's ACTIVE buffer. A missing session is an error. */
export interface CaptureVisibleResult {
  screen: string
  cursor: { x: number; y: number } | null
  altScreen: boolean
}
export interface PaneCwdResult {
  cwd: string | null
}
export interface ListSessionsResult {
  names: string[]
  /** One row per LIVE generation — present only for a connection that negotiated the
   *  `sessionDetails` feature, so an older client keeps reading `{names}` byte-for-byte. A name in
   *  `names` with no row here (a generation already retiring) is simply not described; a consumer
   *  must never read that absence as "detached" or "no processes". */
  sessions?: SessionHostSessionDetail[]
}

/** What the observability surfaces (session reaper, session-memory panel, dev-server ports) need
 *  to know about one host session — the session host's answer to tmux's `list-windows`/`list-panes`
 *  formats. All stamps are epoch MILLISECONDS on the host's clock. */
export interface SessionHostSessionDetail {
  name: string
  /** The pty's own child (the pane's shell) — the root of the session's process tree. */
  pid: number
  /** Connections subscribed to this generation's output right now (tmux's `session_attached`). */
  subscribers: number
  /** When the pty last produced OUTPUT — the reaper's idleness clock (tmux's `window_activity`).
   *  Starts at `createdMs`; nothing that only LOOKS at the session (attach, capture) moves it. */
  lastOutputMs: number
  createdMs: number
  /** Exact process generation, so a kill planned from this row cannot hit a same-name successor. */
  generation: string
}

/**
 * Splits a byte stream on `\n` into complete JSON lines, buffering a line that arrived split
 * across TCP/pipe chunks — the whole reason a delimiter-based framing needs a stateful parser
 * instead of `JSON.parse(chunk)`. Shared by both ends so the framing rule is written exactly once.
 */
/** Hard cap on a single un-terminated line. This framer runs BEFORE the `hello` auth check on
 *  the host, and on the client against whatever is bound to the endpoint, so an unbounded buffer
 *  is a pre-auth memory-exhaustion DoS: a peer that streams bytes with no `\n` would grow `buf`
 *  without limit. No legitimate frame is anywhere near this — the largest is a full-scrollback
 *  capture, comfortably under a few MB — so a line past the cap is a hostile or broken peer and
 *  the connection is abandoned rather than buffered. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Thrown when a single line exceeds `MAX_FRAME_BYTES`; both ends destroy the socket on it. */
export class FrameTooLargeError extends Error {
  constructor() {
    super('session-host frame exceeded the maximum size')
    this.name = 'FrameTooLargeError'
  }
}

export class LineFramer {
  private buf = ''
  /** Feed a raw chunk; returns every complete frame it now contains, in arrival order. A
   *  malformed line is DROPPED rather than thrown — one corrupt frame must never wedge every
   *  frame that follows it on the same connection. A line that grows past `MAX_FRAME_BYTES`
   *  without terminating throws `FrameTooLargeError`; the caller destroys the connection. */
  push<T>(chunk: string): T[] {
    this.buf += chunk
    // Only an un-terminated tail can grow unbounded — a chunk full of `\n` splits fine however
    // large. Check before split so a peer cannot force a huge allocation one byte at a time.
    if (this.buf.length > MAX_FRAME_BYTES && !this.buf.includes('\n')) {
      this.buf = ''
      throw new FrameTooLargeError()
    }
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    const out: T[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as T)
      } catch {
        // one corrupt line — drop it and keep reading the rest of the stream
      }
    }
    return out
  }
}

export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + '\n'
}

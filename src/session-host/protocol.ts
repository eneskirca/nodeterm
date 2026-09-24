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
       *  returns — mirrors `settings.tmuxScrollback` / tmux's own `history-limit`. */
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
  | { id: number; cmd: 'capture'; name: string; full: boolean }
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
export type SessionHostFeature = 'geometry'
export const SESSION_HOST_FEATURES: readonly SessionHostFeature[] = ['geometry']

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
export interface CaptureResult {
  text: string
}
export interface ListSessionsResult {
  names: string[]
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

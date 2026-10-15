import type { TextDeliveryResult } from '../shared/text-delivery'
// The Electron-main-side client for the session host: one long-lived connection per app process,
// auto-spawning the host on first use and restoring every live local attachment before allowing
// ordinary traffic through a replacement connection.

import net from 'net'
import fs from 'fs'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { randomUUID } from 'crypto'
// The REAL scheduler, immune to vi.useFakeTimers (which patches the global, not this module's
// exports): requestOnSocket defers each frame's write by one genuine event-loop turn so queued
// socket 'close' events dispatch first, even inside fake-timer tests.
import { setImmediate as realSetImmediate } from 'timers'
import { sessionHostPaths } from '../session-host/paths'
import { WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS } from '../session-host/windows-process-tree'
import {
  EMPTY_LOCK_STALE_MS,
  LISTEN_RETRY_BUDGET_MS,
  readExistingSessionHostIdentity,
  startupLockState
} from '../session-host/existing-host-state'
import {
  SESSION_HOST_PROTOCOL_VERSION,
  SESSION_HOST_FEATURES,
  LineFramer,
  encodeFrame,
  type SessionHostRequest,
  type SessionHostRequestBody,
  type SessionHostFrame,
  type SessionHostSpawnOptions,
  type AttachResult,
  type HelloResult,
  type HasSessionResult,
  type PaneCommandResult,
  type CaptureResult,
  type CaptureVisibleResult,
  type PaneCwdResult,
  type SessionHostFeature,
  type PaneModesResult,
  type KillSessionResult,
  type ExecuteLaunchResult,
  type ListSessionsResult,
  type SessionHostSessionDetail,
  type ShutdownResult
} from '../session-host/protocol'
import { resolveSessionHostScript, spawnSessionHost } from './session-host-launcher'

/** How long a host launch waits for the first staging of a new version (copy + hash + smoke run)
 *  before launching from the installed binary instead. */
export const STAGED_RUNTIME_WAIT_MS = 45_000
import { latestClaimSize, type SizeClaim } from './pty-size'
import { isTerminalReport } from './terminal-reports'
import type { PreparedAgentLaunch } from './agent-launch'
import type { HostImageStaging } from './session-host-runtime'

export interface SessionSubscriber {
  onData(data: string): void
  onExit(exitCode: number): void
  /** The size the shared pty actually runs at, which may not be this subscriber's own claim: the
   *  session follows its most recently active viewer (issue #914). Called whenever that may have
   *  changed for this subscriber — including after its own resize, even when the answer is the
   *  same, because its renderer has just fitted itself to its own size. Deduplicate downstream. */
  onSize?(size: { cols: number; rows: number }): void
  /** A previously confirmed attachment failed to restore. This is not an exit: the host's
   * rejection is retained so the owning manager can retire only the affected generation. */
  onAttachError?(error: Error): void
}

export const SESSION_HOST_REQUEST_TIMEOUT_MS = 10_000
/** A `shutdown` ends every session (each kill confirmed by the host within its own 20 s bound),
 *  so it gets a longer deadline than an ordinary request. */
export const SHUTDOWN_REQUEST_TIMEOUT_MS = 45_000
/** `terminateOwnerV1` runs the host's owner probe (`readWindowsConsoleOwner`, a PowerShell
 *  execFile bounded at 4 s) and then `taskkill /T /F` plus the root-absence poll (bounded at
 *  `WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS`, 8 s). The ordinary 10 s deadline is shorter than
 *  that sum, and its expiry is not a plain `false`: the agent may already be dead (the caller then
 *  skips the recycle and strands a bare shell) AND the deadline retires the whole socket, dropping
 *  every other session's stream on this connection. So the kill gets the full budget plus slack. */
export const TERMINATE_OWNER_REQUEST_TIMEOUT_MS =
  4_000 + WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS + 6_000

export type HostUpdateInspection =
  | { running: false }
  | {
      running: true
      sessions: string[]
      shutdown: boolean
      /** Where the running host's executable lives (`classifyHostImage`). Only `staged` means a
       *  plain quit lets the installer run; `unknown` is never read as staged. */
      staging: HostImageStaging
    }

/**
 * What the running host holds, for the observability surfaces (session reaper, session-memory
 * panel, dev-server ports). `null` from `listSessionsDetailed` is the FAILED read — never this
 * shape with no sessions, because a failed read is never evidence of absence.
 *  - `running: false` — no host is published, so there are no sessions. An ANSWER.
 *  - `sessions: null` — a host that predates `sessionDetails` can name its sessions but not
 *    describe them; consumers must treat every name as unmeasured / not reapable.
 *  - otherwise `sessions` holds a validated row per live generation; a name without a row is not
 *    described (retiring, or a malformed row dropped here) and is treated the same way.
 */
export interface SessionHostListing {
  running: boolean
  names: string[]
  sessions: SessionHostSessionDetail[] | null
  /**
   * The host process's pid, from the state file the connection was verified against (every host
   * version writes it, so this needs no protocol change). Absent when unknown or not a safe
   * positive integer. Only the memory panel reads it, to report the host's own cost.
   */
  hostPid?: number
}

const GENERATION_RE = /^[A-Za-z0-9_-]{8,128}$/

/** Keep only rows whose every field is the type the consumers rely on. A malformed row is dropped
 *  — its session then reads as undescribed, never as detached or empty. */
function validSessionDetails(raw: unknown): SessionHostSessionDetail[] {
  if (!Array.isArray(raw)) return []
  const out: SessionHostSessionDetail[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (
      typeof o.name !== 'string' ||
      !Number.isSafeInteger(o.pid) ||
      (o.pid as number) <= 0 ||
      !Number.isSafeInteger(o.subscribers) ||
      (o.subscribers as number) < 0 ||
      !Number.isFinite(o.lastOutputMs) ||
      !Number.isFinite(o.createdMs) ||
      typeof o.generation !== 'string' ||
      !GENERATION_RE.test(o.generation)
    ) {
      continue
    }
    out.push({
      name: o.name,
      pid: o.pid as number,
      subscribers: o.subscribers as number,
      lastOutputMs: o.lastOutputMs as number,
      createdMs: o.createdMs as number,
      generation: o.generation
    })
  }
  return out
}

export type HostShutdownOutcome =
  | { kind: 'no-host' }
  | { kind: 'unsupported' }
  | { kind: 'shut-down'; ended: string[] }
  | { kind: 'failed'; error: string }
  | { kind: 'unconfirmed'; error: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else — still alive as far as a lock goes.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Bounded wait for a host that answered `shutdown` to be gone: its state file removed (it deletes
 *  it on the way out) AND, when its pid is known, that pid no longer running. */
async function waitForHostExit(
  statePath: string,
  pid: number | null,
  waitMs: number
): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    let stateGone = false
    try {
      fs.statSync(statePath)
    } catch (error) {
      stateGone = (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (stateGone && (pid === null || !pidAlive(pid))) return true
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

const RECONNECT_DELAYS_MS = [50, 100, 250, 500, 1_000, 2_000] as const
const RECONNECT_REPAINT_PREFIX = '\x1b[3J\x1b[2J\x1b[H'
const HANDSHAKE_TIMEOUT_MS = 2_000
const KILL_CONFIRMATION_ATTEMPTS = 2

type PendingEntry = {
  socket: net.Socket
  timer: ReturnType<typeof setTimeout> | null
  /** True once the frame has been handed to socket.write. Until then the frame provably never
   * left this process, so a transport drop rejects the entry as resendable (see dropSocket). */
  sent: boolean
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type SubscriberEntry = {
  sub: SessionSubscriber
  /** Present only on a cold create request. Warm reconnect and attachExisting deliberately carry
   * no spawn plan, so a stale profile can never recreate an exited generation. */
  spawn?: SessionHostSpawnOptions
  scrollback: number
  phase: 'attaching' | 'attached'
  /** A `watch-attach` viewer (live link / relay viewer): it never holds a size claim or a pause
   *  ticket, and its writes are dropped here — the host refuses them too. */
  watch?: boolean
}

type BufferedFrame = {
  data: string
  /** Entry identity, not merely the callback object: an unsubscribe/re-attach using the same
   * object must not inherit bytes that belonged to its retired registration. */
  recipients: Set<SubscriberEntry>
}

type TerminalSize = { cols: number; rows: number }

/** Identity of one in-flight/retried `killSession` operation, keyed by name in `killOperations`.
 *  `prepared` marks the point past which a failure must preserve (never roll back) the barrier
 *  and identity, because a destructive frame may already be in flight or answered. */
type KillOperationIdentity = {
  operationId: string
  expectedGeneration?: string
  reserveReplacement: boolean
  requireV2: boolean
  expectedAbsent: boolean
  prepared?: boolean
  /** The generation came from the CALLER's observation (a `listSessionsDetailed` row), not from
   *  this client's own attachment. Such a kill never tears down local attachment state that is
   *  not provably the generation it ended (see `killSession`). */
  observed?: boolean
}

type ClientSessionState = {
  name: string
  generation?: string
  protocolVersion?: 1 | 2
  entries: Map<SessionSubscriber, SubscriberEntry>
  pauseOwners: Set<SessionSubscriber>
  /** Each subscriber's vote, with when it was last active and whether it can adapt to a grid
   *  that is not its own (see `latestClaimSize`). */
  sizeClaims: Map<SessionSubscriber, SizeClaim>
  /** What the HOST last said the pty runs at, on a connection that negotiated `geometry`. Null
   *  until it has answered; never consulted on a connection that did not negotiate it. */
  hostGeometry: TerminalSize | null
  bufferedData: BufferedFrame[]
  /** Attaches that have actually reached their request phase. Only these may own data arriving
   * before the correlated attach response; a merely queued replacement must not absorb bytes
   * from the generation whose detach/kill still precedes it in the name lane. */
  preAckEntries: Set<SubscriberEntry>
  /** An exit can race the correlated attach response in the same socket turn. Remember it so the
   * response cannot promote a process generation the host has already retired. */
  preAckExit: boolean
  /** True after the last local pause owner leaves, until a host acknowledgement makes flowing
   *  certain again. Data that raced the acknowledgement is retained behind this gate. */
  releasePending: boolean
  appliedSocket: net.Socket | null
  appliedAttached: boolean
  appliedPaused: boolean
  appliedSize: TerminalSize | null
  /** The host holds this connection's attachment in WATCH mode (no geometry claim): true while
   *  every local subscriber is a watcher. A resize is never sent in this mode (the host refuses
   *  it); the next claim-carrying attach upgrades it, `reconcileOnSocket` downgrades it. */
  appliedWatch?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Explicit host refusal: unlike a lost response, the host answered this request. */
class SessionHostRequestRejectedError extends Error {}

function isTransportUncertainty(value: unknown): boolean {
  const error = asError(value) as NodeJS.ErrnoException
  if (
    error.code === 'ECONNRESET' ||
    error.code === 'EPIPE' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ERR_STREAM_DESTROYED'
  ) {
    return true
  }
  return (
    error.message.includes('session-host connection lost') ||
    error.message.includes('session-host request timed out') ||
    error.message.includes('socket')
  )
}

/** Protocol-v1 hosts stay alive for warm terminal continuity. Operations that need atomic
 * generation or replacement semantics fail closed without replacing that live host. */
/** `attachWatch` against a host that did not advertise `watch-attach`: the viewer is refused. */
export class SessionHostWatchUnsupportedError extends Error {
  constructor(name: string) {
    super(`session-host does not support read-only watch attach for '${name}'`)
    this.name = 'SessionHostWatchUnsupportedError'
  }
}

export class SessionHostProtocolCompatibilityError extends Error {
  readonly code = 'SESSION_HOST_PROTOCOL_INCOMPATIBLE'

  constructor(operation: string) {
    super(
      `The persistent terminal host is from an older nodeterm version and cannot ${operation}. ` +
        'Existing terminals remain attachable; close them and let the legacy host exit before ' +
        'starting or restarting a Windows terminal.'
    )
    this.name = 'SessionHostProtocolCompatibilityError'
  }
}

/** A request frame that provably never left this process: the tracked socket was already gone
 * when the write was attempted, or the write callback itself reported the failure. Unlike a
 * timeout or a mid-flight connection drop — where the host may have received and acted on the
 * frame — resending this exact request on a fresh connection cannot double-apply anything.
 * `code` carries the underlying errno so `isTransportUncertainty` classification is unchanged
 * for any caller the bounded resend in `request()` re-throws to. */
class SessionHostRequestNotDeliveredError extends Error {
  code?: string
  /** The raw transport failure. `request()` surfaces THIS when a resend cannot happen (reconnect
   * refused, attempts exhausted), so callers keep the exact error object shape they always got. */
  readonly original: Error

  constructor(original: Error) {
    super(original.message)
    this.original = original
    const code = (original as NodeJS.ErrnoException).code
    if (code) this.code = code
  }
}

/** How many times `request()` re-runs connect + send for a frame that provably never left the
 * process. Purely a spin bound: each retry only happens after a successful fresh hello, so a
 * host that dies right after every accept cannot loop this forever. */
const SESSION_HOST_RESEND_ATTEMPTS = 3

function requireAttachResult(
  result: AttachResult | undefined,
  name: string,
  protocolVersion: 1 | 2
): AttachResult {
  if (!result || typeof result.fresh !== 'boolean') {
    throw new Error(`session-host returned an invalid attachment result for '${name}'`)
  }
  if (
    protocolVersion === 2 &&
    (typeof result.generation !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(result.generation))
  ) {
    throw new Error(`session-host returned no generation for attachment '${name}'`)
  }
  return result
}

function legacyWarmOnlySentinel(userDataDir: string): SessionHostSpawnOptions {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  return {
    cwd: userDataDir,
    shell: process.execPath,
    args: ['-e', 'process.stdout.write("nodeterm legacy warm-only sentinel\\n")'],
    env,
    cols: 1,
    rows: 1
  }
}

function sameSize(left: TerminalSize | null, right: TerminalSize): boolean {
  return left?.cols === right.cols && left.rows === right.rows
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

export class SessionHostClient {
  private socket: net.Socket | null = null
  private negotiatedProtocolVersion: 1 | 2 | null = null
  /** The current connection negotiated the `geometry` feature, so the host pushes the pty's real
   *  size. On a host that predates it, the size this client last requested IS the pty's size as
   *  long as this is the host's only connection — the common case, and the one issue #914 is. */
  private hostGeometryEvents = false
  /** The current connection negotiated `shutdown` (issue #829): only then may prepare-for-update
   *  ask the host to end every session and exit. An older host lacks it, and the app then falls
   *  back to the manual steps — never to killing the host itself. */
  private hostShutdownFeature = false
  /** Every additive feature the CURRENT connection negotiated (cleared with the socket). Newer
   *  features are read from here rather than given one boolean each. */
  private hostFeatures = new Set<SessionHostFeature>()
  /** The pid the host published in its state file for the current connection. Read only to
   *  confirm a shutdown actually ended the process. */
  private hostPid: number | null = null
  /** Latched once a `shutdown` was sent: the app is about to quit for an update, and a reconnect
   *  must not LAUNCH a fresh host (which would re-lock the install directory). Cleared again only
   *  when the host answered that it could not end everything and is still serving. */
  private shutDownForUpdate = false
  /** Monotonic activity clock for `SizeClaim.recency`. */
  private claimClock = 0
  private nextId = 1
  private readonly pending = new Map<number, PendingEntry>()
  private readonly sessions = new Map<string, ClientSessionState>()
  /** Survives state replacement. Cleanup invoked for an old generation always stays ahead of a
   * later same-name attach, even after the old state has left `sessions`. */
  private readonly nameTails = new Map<string, Promise<void>>()
  private readonly sessionGenerations = new Map<string, string>()
  /** Installed before the first destructive write so reconnect restoration cannot resurrect an
   * old generation whose kill reply may have been lost. */
  private readonly killReplayBarriers = new Set<string>()
  private readonly killsInFlight = new Map<string, Promise<void>>()
  private readonly killOperations = new Map<string, KillOperationIdentity>()
  private readonly replacementTokens = new Map<string, string>()
  private connecting: Promise<void> | null = null
  /** The in-flight `connecting` attempt was started with `launch: false` (see `ensureConnected`). */
  private connectingWithoutLaunch = false
  private everConnected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  constructor(
    private readonly deps: {
      userDataDir: string
      resourcesPath?: string | null
      appPath?: string | null
      repoRoot?: string | null
      /** Stage (or reuse) a host runtime outside the install directory. Absent = legacy launch. */
      stageRuntime?: (script: string) => Promise<{ exe: string; script: string } | null>
      /** Classify the running host's image for prepare-for-update (`resolveHostStaging`). Absent
       *  (every non-Windows or unpackaged client) ⇒ `unknown`. */
      hostStaging?: (host: { exe?: string; pid: number | null }) => Promise<HostImageStaging>
    }
  ) {}

  /** A staged host crashed on start this app run: launch from the installed binary from now on. */
  private stagedRuntimeDisabled = false

  /** The relocated runtime to launch the host from (Windows; `session-host-runtime.ts`), or null
   *  for the legacy launch. Bounded: a staging that has not finished in time is not waited for —
   *  it keeps running and serves the next launch. */
  private async stagedRuntimeFor(script: string): Promise<{ exe: string; script: string } | null> {
    const stage = this.deps.stageRuntime
    if (!stage || this.stagedRuntimeDisabled) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        stage(script).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), STAGED_RUNTIME_WAIT_MS)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  bundleAvailable(): boolean {
    return (
      resolveSessionHostScript({
        resourcesPath: this.deps.resourcesPath,
        appPath: this.deps.appPath,
        repoRoot: this.deps.repoRoot
      }) !== null
    )
  }

  private newState(name: string): ClientSessionState {
    return {
      name,
      entries: new Map(),
      pauseOwners: new Set(),
      sizeClaims: new Map(),
      hostGeometry: null,
      bufferedData: [],
      preAckEntries: new Set(),
      preAckExit: false,
      releasePending: false,
      appliedSocket: null,
      appliedAttached: false,
      appliedPaused: false,
      appliedSize: null
    }
  }

  private enqueueState<T>(state: ClientSessionState, task: () => Promise<T>): Promise<T> {
    return this.enqueueName(state.name, task)
  }

  private enqueueName<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = this.nameTails.get(name) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.nameTails.set(name, settled)
    void settled.then(() => {
      if (this.nameTails.get(name) === settled) this.nameTails.delete(name)
    })
    return run
  }

  private hasAttachedEntry(state: ClientSessionState): boolean {
    for (const entry of state.entries.values()) {
      if (entry.phase === 'attached') return true
    }
    return false
  }

  /** Every local subscriber of `state` is a watcher, and the host can hold that without a claim. */
  private watchOnly(state: ClientSessionState): boolean {
    return (
      state.sizeClaims.size === 0 &&
      state.entries.size > 0 &&
      this.negotiatedProtocolVersion === 2 &&
      this.hostFeatures.has('watch-attach')
    )
  }

  private hasDesiredAttachments(): boolean {
    for (const state of this.sessions.values()) {
      if (this.hasAttachedEntry(state)) return true
    }
    return false
  }

  /** The size this client asks the host for: its most recently active subscriber's, clamped to any
   *  subscriber that cannot adapt (issue #914 — see `latestClaimSize`). */
  private effectiveSize(state: ClientSessionState): TerminalSize {
    // Every entry receives a claim before it enters the map. This fallback only protects a
    // teardown race from ever putting non-finite geometry on the wire.
    return latestClaimSize(state.sizeClaims.values()) ?? { cols: 80, rows: 24 }
  }

  /** Mark `sub` as the most recently active viewer and re-negotiate if that moves the size. */
  private touchClaim(state: ClientSessionState, sub: SessionSubscriber): void {
    const claim = state.sizeClaims.get(sub)
    if (!claim) return
    const before = this.effectiveSize(state)
    claim.recency = ++this.claimClock
    if (!sameSize(before, this.effectiveSize(state))) this.queueReconcile(state)
  }

  /** Tell every attached subscriber the size the pty runs at. On a geometry-aware connection that
   *  is the host's own answer; otherwise it is what this client last applied. */
  private notifySize(state: ClientSessionState): void {
    const size = this.hostGeometryEvents ? state.hostGeometry : state.appliedSize
    if (!size) return
    for (const entry of state.entries.values()) {
      if (entry.phase !== 'attached') continue
      try {
        entry.sub.onSize?.({ cols: size.cols, rows: size.rows })
      } catch {
        // One subscriber must not stop its co-attached neighbours from learning the size.
      }
    }
  }

  /** Record a host-reported size, ignoring anything that is not a positive integer grid. */
  private recordHostGeometry(state: ClientSessionState, geometry: unknown): boolean {
    if (!this.hostGeometryEvents || !geometry || typeof geometry !== 'object') return false
    const { cols, rows } = geometry as { cols?: unknown; rows?: unknown }
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false
    if ((cols as number) <= 0 || (rows as number) <= 0) return false
    state.hostGeometry = { cols: cols as number, rows: rows as number }
    return true
  }

  /**
   * `launch: false` connects only to a host that is ALREADY answering — a read-only observer (the
   * session reaper, the memory panel, the ports chip) must never start the process it is asking
   * about. A published-but-stale state file (the host was killed, or the machine rebooted) would
   * otherwise make every such poll spawn a fresh host. A launching caller that arrives while such
   * a no-launch attempt is in flight waits for it and, if it found nothing, connects normally.
   */
  private async ensureConnected(options: { launch?: boolean } = {}): Promise<void> {
    const launch = options.launch !== false
    if (this.shutDownForUpdate) {
      throw new Error('session-host was shut down to prepare for an update; restart nodeterm')
    }
    // A newly authenticated socket is visible while its reconnect restoration is still running.
    // The barrier wins over the raw socket check so no later request can overtake replay.
    if (this.connecting) {
      if (launch && this.connectingWithoutLaunch) {
        return this.connecting.catch(() => this.ensureConnected())
      }
      return this.connecting
    }
    if (this.socket && !this.socket.destroyed) return
    const attempt = this.doConnect(launch)
    this.connecting = attempt
    this.connectingWithoutLaunch = !launch
    void attempt.then(
      () => {
        if (this.connecting === attempt) this.connecting = null
        this.reconnectAttempt = 0
      },
      () => {
        if (this.connecting === attempt) this.connecting = null
        this.scheduleAutoReconnect()
      }
    )
    return attempt
  }

  private async doConnect(launch = true): Promise<void> {
    const wasConnectedBefore = this.everConnected
    if (await this.tryConnectBeforeLaunch()) {
      const socket = this.socket
      if (wasConnectedBefore && socket) await this.restoreSocket(socket)
      return
    }
    if (!launch) throw new Error('session-host: no running host answered (not launching one)')

    const script = resolveSessionHostScript({
      resourcesPath: this.deps.resourcesPath,
      appPath: this.deps.appPath,
      repoRoot: this.deps.repoRoot
    })
    if (!script) {
      throw new Error(
        'session-host bundle not found (out/session-host/host.cjs is missing — run `npm run host:build`, ' +
          'or `npm run build` which now runs it too)'
      )
    }
    // A host that is ALREADY starting needs no second one. Spawning anyway is not harmful (it
    // exits on the exclusive-create lock), but it is a process per create during the window this
    // wait exists for — see `hostIsStarting`.
    if (!this.hostIsStarting()) {
      const staged = await this.stagedRuntimeFor(script)
      // Staging can take seconds on the first launch of a new version; re-ask so a host another
      // process started meanwhile is not doubled.
      if (!staged || !this.hostIsStarting()) {
        spawnSessionHost(script, this.deps.userDataDir, staged, () => {
          this.stagedRuntimeDisabled = true
        })
      }
    }
    let lastPublicationError: Error | null = null
    const waitStartedAt = Date.now()
    for (let attempt = 0; ; attempt++) {
      await sleep(150)
      try {
        if (await this.tryConnectOnce()) {
          const socket = this.socket
          if (wasConnectedBefore && socket) await this.restoreSocket(socket)
          return
        }
        lastPublicationError = null
      } catch (error) {
        const typed = asError(error)
        if (!this.isTransientPublicationLock(typed)) throw typed
        lastPublicationError = typed
      }
      if (attempt < 29) continue
      // Past the ordinary 4.5 s budget. Keep waiting ONLY while a host is demonstrably still
      // starting — an empty startup lock whose mtime it keeps moving. That is a host waiting out
      // an endpoint someone else still holds (issue #783: a Windows named pipe stayed busy for
      // ~1.5 min after its owner was killed), and erroring here left every node that mounted in
      // that window on a permanent "could not be started" until the user clicked Try again.
      // A lock that stops being touched is abandoned, so this can never wait forever.
      if (!this.hostIsStarting()) break
      if (Date.now() - waitStartedAt > LISTEN_RETRY_BUDGET_MS + EMPTY_LOCK_STALE_MS) break
    }
    if (lastPublicationError) throw lastPublicationError
    throw new Error('session-host did not come up in time')
  }

  private isTransientPublicationLock(error: Error): boolean {
    return error.message === 'invalid session-host state: file is empty'
  }

  /** Is a host process between its exclusive-create lock and publication right now? True only for
   *  an EMPTY lock it is still touching; a lock nobody moves is abandoned (see startupLockState). */
  private hostIsStarting(): boolean {
    return startupLockState(sessionHostPaths(this.deps.userDataDir).statePath) === 'starting'
  }

  /** An exclusive-create startup lock is briefly empty before atomic state publication. Retry
   * only that exact state within a small bound; every other unreadable or malformed observation
   * remains an immediate integrity failure and never reaches the launcher. */
  private async tryConnectBeforeLaunch(): Promise<boolean> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.tryConnectOnce()
      } catch (error) {
        const typed = asError(error)
        if (!this.isTransientPublicationLock(typed)) throw typed
        lastError = typed
        // Still empty after the small bound — but a host that is heartbeating that lock is simply
        // still starting, so the launch path's own wait owns it rather than failing this create.
        if (this.hostIsStarting()) return false
        await sleep(50)
      }
    }
    throw lastError ?? new Error('session-host state publication did not complete')
  }

  private async tryConnectOnce(): Promise<boolean> {
    const paths = sessionHostPaths(this.deps.userDataDir)
    const identity = readExistingSessionHostIdentity(paths.statePath, {
      expectedEndpoint: paths.endpoint,
      expectedTokenPath: paths.tokenPath
    })
    if (identity.kind === 'absent') return false
    if (
      identity.state.protocolVersion !== 1 &&
      identity.state.protocolVersion !== SESSION_HOST_PROTOCOL_VERSION
    ) {
      throw new Error(
        `incompatible session-host protocol: host=${identity.state.protocolVersion}, ` +
          `client=${SESSION_HOST_PROTOCOL_VERSION}`
      )
    }
    const token = identity.token
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new Error('invalid session-host token: expected 64 hexadecimal characters')
    }
    const endpoint = identity.state.endpoint
    return new Promise((resolve, reject) => {
      let settled = false
      let connected = false
      const socket = net.connect(endpoint)
      socket.unref?.()
      const framer = new LineFramer()
      const helloId = this.nextId++
      let protocolVersion: 1 | 2 | null = null
      let geometryEvents = false
      let shutdownFeature = false
      let negotiatedFeatures: SessionHostFeature[] = []
      const finish = (ok: boolean, trailing: SessionHostFrame[] = []): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener('connect', onHandshakeConnect)
        socket.removeListener('data', onHandshakeData)
        socket.removeListener('error', onHandshakeError)
        socket.removeListener('close', onHandshakeClose)
        if (ok) {
          if (!protocolVersion) {
            failHandshake(new Error('session-host hello did not negotiate a protocol version'))
            return
          }
          this.hostShutdownFeature = shutdownFeature
          this.hostFeatures = new Set(negotiatedFeatures)
          this.hostPid = Number.isInteger(identity.state.pid) ? identity.state.pid : null
          this.attachSocket(socket, protocolVersion, geometryEvents)
          for (const frame of trailing) this.handleFrame(socket, frame)
        } else {
          try {
            socket.destroy()
          } catch {
            /* already gone */
          }
        }
        resolve(ok)
      }
      const failHandshake = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener('connect', onHandshakeConnect)
        socket.removeListener('data', onHandshakeData)
        socket.removeListener('error', onHandshakeError)
        socket.removeListener('close', onHandshakeClose)
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
        reject(error)
      }
      const onHandshakeError = (error: Error): void => {
        if (connected) failHandshake(error)
        else finish(false)
      }
      const onHandshakeClose = (): void => {
        if (connected) failHandshake(new Error('session-host closed during hello'))
        else finish(false)
      }
      const onHandshakeConnect = (): void => {
        connected = true
        try {
          socket.write(
            encodeFrame({
              id: helloId,
              cmd: 'hello',
              token,
              protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
              features: [...SESSION_HOST_FEATURES]
            }),
            (error) => {
              if (error) failHandshake(asError(error))
            }
          )
        } catch (error) {
          failHandshake(asError(error))
        }
      }
      const onHandshakeData = (chunk: Buffer): void => {
        let frames: SessionHostFrame[]
        try {
          frames = framer.push<SessionHostFrame>(chunk.toString('utf8'))
        } catch (error) {
          // Whatever is bound to the endpoint streamed an oversized un-terminated line — a broken
          // or impostor host. Fail the handshake rather than buffer it unbounded.
          failHandshake(asError(error))
          return
        }
        for (let index = 0; index < frames.length; index++) {
          const frame = frames[index]
          if ('type' in frame || frame.id !== helloId) continue
          if (frame.ok) {
            const advertised = (frame.result as { protocolVersion?: unknown } | undefined)
              ?.protocolVersion
            const negotiated =
              advertised === undefined
                ? 1
                : advertised === SESSION_HOST_PROTOCOL_VERSION
                  ? 2
                  : null
            if (!negotiated) {
              failHandshake(
                new Error(
                  `session-host protocol is incompatible: expected version ` +
                    `${SESSION_HOST_PROTOCOL_VERSION}, received ${String(advertised ?? 'none')}`
                )
              )
              return
            }
            if (identity.state.protocolVersion !== negotiated) {
              failHandshake(
                new Error(
                  `session-host protocol publication disagrees with hello: state=` +
                    `${identity.state.protocolVersion}, hello=${negotiated}`
                )
              )
              return
            }
            protocolVersion = negotiated
            const features = (frame.result as HelloResult | undefined)?.features
            geometryEvents = Array.isArray(features) && features.includes('geometry')
            shutdownFeature = Array.isArray(features) && features.includes('shutdown')
            negotiatedFeatures = Array.isArray(features)
              ? SESSION_HOST_FEATURES.filter((feature) => features.includes(feature))
              : []
            finish(true, frames.slice(index + 1))
          } else {
            failHandshake(new Error(`session-host hello rejected: ${frame.error}`))
          }
          return
        }
      }
      const timer = setTimeout(() => {
        if (connected) failHandshake(new Error('session-host hello timed out'))
        else finish(false)
      }, HANDSHAKE_TIMEOUT_MS)
      timer.unref?.()
      socket.once('error', onHandshakeError)
      socket.once('close', onHandshakeClose)
      socket.once('connect', onHandshakeConnect)
      socket.on('data', onHandshakeData)
    })
  }

  private attachSocket(socket: net.Socket, protocolVersion: 1 | 2, geometryEvents: boolean): void {
    this.socket = socket
    this.negotiatedProtocolVersion = protocolVersion
    this.hostGeometryEvents = geometryEvents
    this.everConnected = true
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      let frames: SessionHostFrame[]
      try {
        frames = framer.push<SessionHostFrame>(chunk.toString('utf8'))
      } catch (error) {
        // Oversized un-terminated line from the host — drop and destroy so a broken/impostor peer
        // cannot grow this process's buffer without limit.
        this.dropSocket(socket, asError(error), true)
        return
      }
      for (const frame of frames) {
        this.handleFrame(socket, frame)
      }
    })
    const onError = (error: Error): void => this.dropSocket(socket, error)
    const onClose = (): void => this.dropSocket(socket, new Error('session-host connection lost'))
    socket.on('error', onError)
    socket.once('close', onClose)
  }

  private dropSocket(socket: net.Socket, error: Error, destroy = false): void {
    const wasCurrent = this.socket === socket
    if (wasCurrent) {
      this.socket = null
      this.negotiatedProtocolVersion = null
      this.hostGeometryEvents = false
      this.hostFeatures = new Set()
      for (const state of this.sessions.values()) {
        // The next connection re-learns the size from its own attach replies.
        state.hostGeometry = null
        if (state.appliedSocket !== socket) continue
        state.appliedSocket = null
        state.appliedAttached = false
        state.appliedPaused = false
        state.appliedSize = null
        state.appliedWatch = false
      }
    }
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      // A frame never handed to socket.write is CERTAINLY undelivered — reject it as resendable
      // so request() can replay it on a fresh connection. A written frame stays uncertainty.
      entry.reject(entry.sent ? error : new SessionHostRequestNotDeliveredError(error))
    }
    if (destroy && !socket.destroyed) {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    if (wasCurrent) this.scheduleAutoReconnect()
  }

  private scheduleAutoReconnect(): void {
    if (this.socket || this.connecting || this.reconnectTimer || !this.hasDesiredAttachments()) {
      return
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.hasDesiredAttachments()) return
      void this.ensureConnected().catch(() => {
        // ensureConnected's rejection handler schedules the next bounded-backoff attempt.
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private stopReconnectIfIdle(): void {
    if (this.hasDesiredAttachments()) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAttempt = 0
  }

  private handleFrame(socket: net.Socket, frame: SessionHostFrame): void {
    if (this.socket !== socket) return
    if ('type' in frame) {
      const state = this.sessions.get(frame.name)
      if (!state) return
      const protocolVersion = this.negotiatedProtocolVersion
      if (protocolVersion === 2) {
        if (
          typeof frame.generation !== 'string' ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(frame.generation)
        ) {
          return
        }
        const expected = state.generation ?? this.sessionGenerations.get(frame.name)
        if (expected && expected !== frame.generation) return
        if (!expected && state.preAckEntries.size > 0) {
          state.generation = frame.generation
          this.sessionGenerations.set(frame.name, frame.generation)
        } else if (!expected) {
          return
        }
      } else if (state.protocolVersion === 2) {
        return
      }
      if (frame.type === 'data') {
        this.deliverData(state, frame.data)
      } else if (frame.type === 'geometry') {
        if (this.recordHostGeometry(state, frame)) this.notifySize(state)
      } else {
        this.handleExit(state, frame.exitCode)
      }
      return
    }

    const entry = this.pending.get(frame.id)
    if (!entry || entry.socket !== socket) return
    this.pending.delete(frame.id)
    if (entry.timer) clearTimeout(entry.timer)
    if (frame.ok) entry.resolve(frame.result)
    else entry.reject(new SessionHostRequestRejectedError(frame.error))
  }

  private deliverData(state: ClientSessionState, data: string): void {
    if (state.preAckExit) return
    const attached = [...state.entries.values()].filter((entry) => entry.phase === 'attached')
    if (attached.length === 0) {
      // A cold process can write between host-side subscriber activation and the attach response.
      // Retain those bytes for the attaching owner; the correlated response promotes it before
      // this queue is flushed. An old-generation exit clears the queue instead.
      if (state.preAckEntries.size > 0) {
        state.bufferedData.push({ data, recipients: new Set(state.preAckEntries) })
      }
      return
    }
    if (state.pauseOwners.size > 0 || state.releasePending) {
      state.bufferedData.push({ data, recipients: new Set(attached) })
      return
    }
    this.deliverToEntries(attached, data)
  }

  private deliverToEntries(entries: Iterable<SubscriberEntry>, data: string): void {
    for (const entry of entries) {
      try {
        entry.sub.onData(data)
      } catch {
        // One renderer subscriber must not starve its co-attached neighbors.
      }
    }
  }

  private flushData(state: ClientSessionState): void {
    if (state.pauseOwners.size > 0 || state.releasePending || state.bufferedData.length === 0) return
    const queued = state.bufferedData
    state.bufferedData = []
    for (const frame of queued) {
      const liveRecipients = [...frame.recipients].filter(
        (entry) =>
          entry.phase === 'attached' && state.entries.get(entry.sub) === entry
      )
      this.deliverToEntries(liveRecipients, frame.data)
    }
  }

  private handleExit(state: ClientSessionState, exitCode: number): void {
    const retired = [...state.entries.values()].filter((entry) => entry.phase === 'attached')
    if (retired.length === 0 && state.preAckEntries.size > 0) state.preAckExit = true
    // Retire the old generation before callbacks. An onExit callback may synchronously attach the
    // same name; post-callback deletion would otherwise erase that replacement generation.
    for (const entry of retired) {
      state.entries.delete(entry.sub)
      state.preAckEntries.delete(entry)
      state.pauseOwners.delete(entry.sub)
      state.sizeClaims.delete(entry.sub)
    }
    state.bufferedData = []
    state.releasePending = false
    state.appliedSocket = null
    state.appliedAttached = false
    state.appliedPaused = false
    state.appliedSize = null
    state.appliedWatch = false
    if (state.entries.size === 0 && this.sessions.get(state.name) === state) {
      this.sessions.delete(state.name)
    }
    if (retired.length > 0) {
      this.sessionGenerations.delete(state.name)
      state.generation = undefined
    }
    this.stopReconnectIfIdle()
    for (const entry of retired) {
      try {
        entry.sub.onExit(exitCode)
      } catch {
        // Exit delivery is isolated for the same reason as data delivery.
      }
    }
  }

  private async request<T>(
    request: SessionHostRequestBody,
    onSuccess?: (result: T, socket: net.Socket) => void,
    onSent?: () => void,
    timeoutMs = SESSION_HOST_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    // A peer-initiated close races the client's own 'close' event: a cached socket can look live
    // here while the peer already hung up, and a frame written into that gap fails (EPIPE) for
    // work the host never saw. requestOnSocket defers the actual write by one REAL event-loop
    // turn, so a raced hangup is discovered before any bytes are committed; such a frame is the
    // one provably-undelivered case and the only one resent here on a fresh connection. A failure
    // discovered by the write itself stays a plain rejection: by then the frame's delivery is the
    // transport's business and other requests may already ride on it.
    let undelivered: SessionHostRequestNotDeliveredError | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureConnected()
      } catch (connectError) {
        // A resend that cannot even reconnect reports the transport failure the caller actually
        // hit, not the follow-up connect refusal; a cold first connect keeps its own error.
        throw undelivered?.original ?? connectError
      }
      const socket = this.socket
      if (!socket) throw new Error('session-host: not connected')
      try {
        return await this.requestOnSocket(socket, request, onSuccess, onSent, timeoutMs)
      } catch (error) {
        if (!(error instanceof SessionHostRequestNotDeliveredError)) throw error
        if (attempt + 1 >= SESSION_HOST_RESEND_ATTEMPTS) throw error.original
        undelivered = error
      }
    }
  }

  /** Request on an already-authenticated socket. Reconnect restoration uses this directly because
   * calling ensureConnected from inside the connection barrier would recursively await itself. */
  private requestOnSocket<T>(
    socket: net.Socket,
    request: SessionHostRequestBody,
    onSuccess?: (result: T, socket: net.Socket) => void,
    onSent?: () => void,
    timeoutMs = SESSION_HOST_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (this.socket !== socket || socket.destroyed) {
      return Promise.reject(
        new SessionHostRequestNotDeliveredError(new Error('session-host connection lost'))
      )
    }
    const id = this.nextId++
    const full = { id, ...request } as SessionHostRequest
    return new Promise<T>((resolve, reject) => {
      const pending: PendingEntry = {
        socket,
        timer: null,
        sent: false,
        resolve: (result) => {
          try {
            const typed = result as T
            onSuccess?.(typed, socket)
            resolve(typed)
          } catch (error) {
            reject(asError(error))
          }
        },
        reject
      }
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return
        const deadline = new Error(`session-host request timed out: ${request.cmd}`)
        // The deadline is uncertainty even for a frame still queued behind the send turn below:
        // reject THIS entry directly (never as resendable), then retire the socket for the rest.
        this.pending.delete(id)
        pending.reject(deadline)
        this.dropSocket(socket, deadline, true)
      }, timeoutMs)
      pending.timer.unref?.()
      this.pending.set(id, pending)
      // The send is deferred one REAL event-loop turn (immune to fake timers — the deadline above
      // is already armed). A peer hangup that has reached this process marks the socket destroyed
      // during the poll phase, BEFORE immediates run, so the recheck sees the loss while the frame
      // is still provably unwritten and dropSocket can reject it as resendable; writes stay FIFO
      // because immediates run in scheduling order.
      realSetImmediate(() => {
        if (this.pending.get(id) !== pending) return
        if (this.socket !== socket || socket.destroyed) {
          this.dropSocket(socket, new Error('session-host connection lost'), true)
          return
        }
        pending.sent = true
        onSent?.()
        try {
          socket.write(encodeFrame(full), (error) => {
            // A response may beat a late write callback. Identity-check this exact pending entry so
            // that callback can neither settle nor delete a newer request that reused surrounding state.
            if (!error || this.pending.get(id) !== pending) return
            this.dropSocket(socket, asError(error), true)
          })
        } catch (error) {
          if (this.pending.get(id) === pending) this.dropSocket(socket, asError(error), true)
        }
      })
    })
  }

  private applyAttachment(
    state: ClientSessionState,
    socket: net.Socket,
    paused: boolean,
    /** Null: the host attached this connection in WATCH mode (no claim, never paused). */
    size: TerminalSize | null
  ): void {
    if (this.sessions.get(state.name) !== state || !this.hasAttachedEntry(state)) return
    state.appliedSocket = socket
    state.appliedAttached = true
    state.appliedPaused = paused
    state.appliedSize = size
    state.appliedWatch = size === null
    if (!paused && state.pauseOwners.size === 0) {
      state.releasePending = false
      this.flushData(state)
    }
  }

  private async restoreSocket(socket: net.Socket): Promise<void> {
    try {
      for (const state of [...this.sessions.values()]) {
        if (this.sessions.get(state.name) !== state) continue
        if (this.killReplayBarriers.has(state.name)) continue
        const anchor = [...state.entries.values()].find((entry) => entry.phase === 'attached')
        if (!anchor) continue
        const size = this.effectiveSize(state)
        const paused = state.pauseOwners.size > 0
        const protocolVersion = this.negotiatedProtocolVersion
        if (!protocolVersion) throw new Error('session-host: not connected')
        // Only watchers here: re-attach WITHOUT a claim, or not at all — a replacement host that
        // lost the feature must not be handed the 80x24 fallback as a viewer's size vote.
        const watchRestore = state.sizeClaims.size === 0
        try {
          if (watchRestore && !this.watchOnly(state)) {
            throw new Error(`session-host no longer supports watch attach for '${state.name}'`)
          }
          if (state.protocolVersion && state.protocolVersion !== protocolVersion) {
            throw new Error(
              `session-host protocol changed while '${state.name}' was detached; warm replay is unsafe`
            )
          }
          const expectedGeneration = state.generation ?? this.sessionGenerations.get(state.name)
          // Validation and repaint delivery run SYNCHRONOUSLY inside the response frame's parse
          // pass (requestOnSocket's onSuccess), not in the awaited continuation below. On a unix
          // socket the host's next raw 'data' frame can share one read chunk with this response;
          // deferring the repaint to the microtask behind `await` would let that live frame reach
          // deliverData first and reverse the repaint-then-live order subscribers depend on.
          let staleAttachment = false
          const applyReplay = (response: AttachResult, replaySocket: net.Socket): void => {
            const result = requireAttachResult(response, state.name, protocolVersion)
            if (result.fresh) {
              throw new Error(
                protocolVersion === 1
                  ? `legacy session-host lost '${state.name}' before warm replay; no requested shell was spawned`
                  : `session-host protocol violation: attachExisting '${state.name}' reported a fresh session`
              )
            }
            if (
              protocolVersion === 2 &&
              expectedGeneration &&
              result.generation !== expectedGeneration
            ) {
              throw new Error(
                `session-host generation changed while '${state.name}' was detached; warm replay is unsafe`
              )
            }
            if (this.sessions.get(state.name) !== state || !this.hasAttachedEntry(state)) {
              staleAttachment = true
              return
            }
            state.protocolVersion = protocolVersion
            state.generation = result.generation ?? expectedGeneration
            if (state.generation) this.sessionGenerations.set(state.name, state.generation)
            this.recordHostGeometry(state, result.geometry)
            this.applyAttachment(state, replaySocket, watchRestore ? false : paused, watchRestore ? null : size)
            if (result.screen && state.appliedSocket === replaySocket) {
              this.deliverData(state, RECONNECT_REPAINT_PREFIX + result.screen)
            }
          }
          if (protocolVersion === 1) {
            await this.requestOnSocket<AttachResult>(
              socket,
              {
                cmd: 'attach',
                name: state.name,
                spawn: legacyWarmOnlySentinel(this.deps.userDataDir),
                scrollback: 1,
                paused
              },
              applyReplay
            )
          } else {
            await this.requestOnSocket<AttachResult>(
              socket,
              watchRestore
                ? { cmd: 'attachExisting', name: state.name, expectedGeneration, watch: true }
                : {
                    cmd: 'attachExisting',
                    name: state.name,
                    expectedGeneration,
                    cols: size.cols,
                    rows: size.rows,
                    paused
                  },
              applyReplay
            )
          }
          if (staleAttachment) {
            await this.requestOnSocket(socket, { cmd: 'detach', name: state.name })
            continue
          }
          await this.reconcileOnSocket(state, socket)
        } catch (error) {
          if (this.socket !== socket || socket.destroyed || isTransportUncertainty(error)) throw error
          // A correlated warm-attach rejection retires exactly this generation. It must not keep
          // retrying forever or be translated into a process exit that the host never reported.
          if (this.sessions.get(state.name) === state) this.sessions.delete(state.name)
          this.sessionGenerations.delete(state.name)
          state.generation = undefined
          state.bufferedData = []
          state.preAckEntries.clear()
          state.appliedSocket = null
          state.appliedAttached = false
          state.appliedPaused = false
          state.appliedSize = null
          state.appliedWatch = false
          const failure = asError(error)
          for (const entry of state.entries.values()) {
            try {
              entry.sub.onAttachError?.(failure)
            } catch {
              /* one owner callback must not hide the same failure from its co-attached neighbors */
            }
          }
          state.entries.clear()
          this.stopReconnectIfIdle()
        }
      }
    } catch (error) {
      this.dropSocket(socket, asError(error), true)
      throw error
    }
  }

  private async reconcileOnSocket(state: ClientSessionState, socket: net.Socket): Promise<void> {
    if (
      this.sessions.get(state.name) !== state ||
      !this.hasAttachedEntry(state) ||
      state.appliedSocket !== socket ||
      !state.appliedAttached
    ) {
      return
    }
    const desiredPaused = state.pauseOwners.size > 0
    if (desiredPaused && !state.appliedPaused) {
      await this.requestOnSocket(socket, { cmd: 'pause', name: state.name })
      if (this.socket !== socket) return
      // Record a confirmed host ticket even if the final local owner retired while the request
      // was in flight. Its teardown lane then knows it owes the matching resume before detach.
      state.appliedPaused = true
      if (this.sessions.get(state.name) !== state) return
    }

    // The last voting subscriber left a watcher behind: withdraw this connection's claim, so a
    // viewer never keeps the owner's old size pinned (the host keeps the pty at the size it has).
    // A claim-carrying attach is the only way back up, so a watch-mode attachment never resizes.
    if (this.watchOnly(state) && !state.appliedWatch) {
      await this.requestOnSocket(socket, {
        cmd: 'attachExisting',
        name: state.name,
        expectedGeneration: state.generation ?? this.sessionGenerations.get(state.name),
        watch: true
      })
      if (this.socket !== socket) return
      // The host returned any pause this connection held along with the claim.
      state.appliedWatch = true
      state.appliedSize = null
      state.appliedPaused = false
      if (this.sessions.get(state.name) !== state) return
    }
    const desiredSize = this.effectiveSize(state)
    if (!state.appliedWatch && !sameSize(state.appliedSize, desiredSize)) {
      await this.requestOnSocket(socket, {
        cmd: 'resize',
        name: state.name,
        cols: desiredSize.cols,
        rows: desiredSize.rows
      })
      if (this.socket !== socket) return
      state.appliedSize = desiredSize
      if (this.sessions.get(state.name) !== state) return
    }

    if (!desiredPaused && state.appliedPaused) {
      await this.requestOnSocket(socket, { cmd: 'resume', name: state.name })
      if (this.socket !== socket) return
      state.appliedPaused = false
      if (this.sessions.get(state.name) !== state) return
    }
    if (state.pauseOwners.size === 0 && !state.appliedPaused) {
      state.releasePending = false
      this.flushData(state)
    }
    this.notifySize(state)
  }

  private async reconcileState(state: ClientSessionState): Promise<void> {
    if (this.sessions.get(state.name) !== state || !this.hasAttachedEntry(state)) return
    await this.ensureConnected()
    const socket = this.socket
    if (!socket) throw new Error('session-host: not connected')
    await this.reconcileOnSocket(state, socket)
  }

  private queueReconcile(state: ClientSessionState): void {
    void this.enqueueState(state, () => this.reconcileState(state)).catch((error) => {
      const socket = this.socket
      if (socket) this.dropSocket(socket, asError(error), true)
    })
  }

  private async teardownRetiredState(state: ClientSessionState): Promise<void> {
    const socket = state.appliedSocket
    if (!socket || this.socket !== socket || socket.destroyed || !state.appliedAttached) return
    try {
      // `releasePending` covers the conservative edge where the last owner retired while its
      // pause acknowledgement was still crossing the wire. Resume is idempotent on the host.
      if (state.appliedPaused || state.releasePending) {
        await this.requestOnSocket(socket, { cmd: 'resume', name: state.name })
        state.appliedPaused = false
        state.releasePending = false
      }
      await this.requestOnSocket(socket, { cmd: 'detach', name: state.name })
      state.appliedAttached = false
    } catch (error) {
      // A failed detach is unknown membership. Closing the socket makes the host release every
      // ticket and subscriber deterministically, with no ghost to replay.
      this.dropSocket(socket, asError(error), true)
    }
  }

  async attach(
    name: string,
    spawn: SessionHostSpawnOptions,
    scrollback: number,
    sub: SessionSubscriber
  ): Promise<AttachResult> {
    const normalizedSpawn = {
      ...spawn,
      cols: normalizeDimension(spawn.cols, 80),
      rows: normalizeDimension(spawn.rows, 24)
    }
    return this.attachSubscriber(
      name,
      sub,
      { kind: 'create', spawn: normalizedSpawn, scrollback },
      { cols: normalizedSpawn.cols, rows: normalizedSpawn.rows }
    )
  }

  /** Warm-only attach. The request carries the generation confirmed by hasSession/attach and no
   * spawn plan, so an exit racing the attach cannot recreate a shell with stale options. */
  async attachExisting(name: string, sub: SessionSubscriber): Promise<AttachResult> {
    return this.attachSubscriber(
      name,
      sub,
      { kind: 'existing', scrollback: 1 },
      { cols: 80, rows: 24 }
    )
  }

  /**
   * A live link / relay viewer's READ-ONLY attach (`watch-attach`): never spawns, never claims a size,
   * never pauses, never types. Rejects with `SessionHostWatchUnsupportedError` — before anything is
   * registered — when the connected host did not advertise the feature (a long-lived host from an
   * older build), so the caller can refuse the viewer instead of casting a size vote for it.
   */
  async attachWatch(name: string, sub: SessionSubscriber): Promise<AttachResult> {
    await this.ensureConnected()
    if (this.negotiatedProtocolVersion !== 2 || !this.hostFeatures.has('watch-attach')) {
      throw new SessionHostWatchUnsupportedError(name)
    }
    return this.attachSubscriber(name, sub, { kind: 'existing', scrollback: 1 }, null)
  }

  /** Does the CURRENT connection speak `feature`? Connects first (a probe of a host that is not
   *  running yet would otherwise answer from a stale, empty set). False on any connect failure. */
  async supportsFeature(feature: SessionHostFeature): Promise<boolean> {
    try {
      await this.ensureConnected()
    } catch {
      return false
    }
    return this.hostFeatures.has(feature)
  }

  /** The negotiated answer for `feature` WITHOUT connecting: undefined while there is no connection. */
  connectedFeature(feature: SessionHostFeature): boolean | undefined {
    return this.socket ? this.hostFeatures.has(feature) : undefined
  }

  private async attachSubscriber(
    name: string,
    sub: SessionSubscriber,
    requestKind:
      | { kind: 'create'; spawn: SessionHostSpawnOptions; scrollback: number }
      | { kind: 'existing'; scrollback: number },
    /** Null: a watcher (`attachWatch`), which casts no size claim at all. */
    initialSize: TerminalSize | null
  ): Promise<AttachResult> {
    if (this.killReplayBarriers.has(name)) {
      throw new Error(
        `session-host: cannot attach '${name}' while its kill result is unconfirmed; ` +
          'retry the kill before creating or attaching a replacement'
      )
    }
    let state = this.sessions.get(name)
    if (!state) {
      state = this.newState(name)
      this.sessions.set(name, state)
    }
    const previous = state.entries.get(sub)
    if (previous) throw new Error(`session-host subscriber is already attached: ${name}`)
    const entry: SubscriberEntry = {
      sub,
      ...(requestKind.kind === 'create' ? { spawn: requestKind.spawn } : {}),
      scrollback: requestKind.scrollback,
      phase: 'attaching',
      ...(initialSize === null ? { watch: true } : {})
    }
    state.entries.set(sub, entry)
    // A new viewer is the most recently active one, exactly as a freshly attached tmux client is.
    // A watcher is not a viewer in that sense: it never votes.
    if (initialSize) state.sizeClaims.set(sub, { ...initialSize, recency: ++this.claimClock })

    return this.enqueueState(state, async () => {
      if (this.sessions.get(name) !== state || state.entries.get(sub) !== entry) {
        throw new Error(`session-host attachment was canceled: ${name}`)
      }
      const size = this.effectiveSize(state)
      const paused = state.pauseOwners.size > 0
      try {
        await this.ensureConnected()
        const protocolVersion = this.negotiatedProtocolVersion
        if (!protocolVersion) throw new Error('session-host: not connected')
        const alreadyAttached = this.hasAttachedEntry(state)
        const useWarmOnly = requestKind.kind === 'existing' || alreadyAttached
        if (!useWarmOnly && protocolVersion === 1) {
          throw new SessionHostProtocolCompatibilityError(`create terminal '${name}'`)
        }
        if (state.protocolVersion && state.protocolVersion !== protocolVersion) {
          throw new Error(
            `session-host protocol changed while '${name}' was attached; co-attach is unsafe`
          )
        }
        const expectedGeneration = state.generation ?? this.sessionGenerations.get(name)
        const replacementToken = useWarmOnly ? undefined : this.replacementTokens.get(name)
        // Nobody local votes (a watcher alone, or a watcher joining other watchers): attach without
        // a claim. A watcher joining an owner rides the owner's claim like any co-attach.
        const watchAttach = useWarmOnly && this.watchOnly(state)
        if (entry.watch && !watchAttach && !this.hasAttachedEntry(state) && state.sizeClaims.size === 0) {
          throw new SessionHostWatchUnsupportedError(name)
        }
        state.preAckEntries.add(entry)
        let response: AttachResult | undefined
        const attempts = replacementToken ? 2 : 1
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            response = useWarmOnly
              ? protocolVersion === 1
                ? await this.request<AttachResult>({
                    cmd: 'attach',
                    name,
                    spawn: legacyWarmOnlySentinel(this.deps.userDataDir),
                    scrollback: 1,
                    paused
                  })
                : watchAttach
                  ? await this.request<AttachResult>({
                      cmd: 'attachExisting',
                      name,
                      expectedGeneration,
                      watch: true
                    })
                  : await this.request<AttachResult>({
                      cmd: 'attachExisting',
                      name,
                      expectedGeneration,
                      cols: size.cols,
                      rows: size.rows,
                      paused
                    })
              : await this.request<AttachResult>({
                  cmd: 'attach',
                  name,
                  spawn: {
                    ...(requestKind.kind === 'create'
                      ? requestKind.spawn
                      : legacyWarmOnlySentinel(this.deps.userDataDir)),
                    cols: size.cols,
                    rows: size.rows
                  },
                  scrollback: requestKind.scrollback,
                  replacementToken,
                  paused
                })
            break
          } catch (error) {
            if (!replacementToken || attempt + 1 >= attempts || !isTransportUncertainty(error)) {
              throw error
            }
          }
        }
        const result = requireAttachResult(response, name, protocolVersion)
        if (state.preAckExit) {
          throw new Error(`session-host session exited before its attach completed: ${name}`)
        }
        if (useWarmOnly && result.fresh) {
          throw new Error(
            protocolVersion === 1
              ? `legacy session-host lost '${name}' before warm attach; no requested shell was spawned`
              : `session-host protocol violation: attachExisting '${name}' reported a fresh session`
          )
        }
        if (
          useWarmOnly &&
          protocolVersion === 2 &&
          expectedGeneration &&
          result.generation !== expectedGeneration
        ) {
          throw new Error(
            `session-host generation changed before warm attach '${name}' completed`
          )
        }
        if (replacementToken && !result.fresh) {
          throw new Error(`session-host protocol violation: reserved replacement '${name}' was not fresh`)
        }
        state.preAckEntries.delete(entry)
        state.protocolVersion = protocolVersion
        state.generation = result.generation ?? expectedGeneration
        if (state.generation) this.sessionGenerations.set(name, state.generation)
        this.recordHostGeometry(state, result.geometry)
        if (replacementToken && result.fresh) {
          if (this.replacementTokens.get(name) === replacementToken) {
            this.replacementTokens.delete(name)
          }
          if (this.killOperations.get(name)?.operationId === replacementToken) {
            this.killOperations.delete(name)
          }
        }
        const socket = this.socket
        if (!socket) throw new Error('session-host: not connected')
        if (this.sessions.get(name) === state && state.entries.get(sub) === entry) {
          entry.phase = 'attached'
          this.applyAttachment(state, socket, watchAttach ? false : paused, watchAttach ? null : size)
        } else {
          // The attach reached the host before its owner retired. Remember the confirmed
          // membership on the retired state so its ordered teardown can return pause + detach.
          state.appliedSocket = socket
          state.appliedAttached = true
          state.appliedPaused = watchAttach ? false : paused
          state.appliedSize = watchAttach ? null : size
          state.appliedWatch = watchAttach
        }
        if (this.sessions.get(name) !== state || state.entries.get(sub) !== entry) {
          // If another local subscriber remains, this attach also restored its socket membership;
          // detaching here would evict that neighbor. Only compensate when nobody still owns it.
          if (this.sessions.get(name) !== state || !this.hasAttachedEntry(state)) {
            await this.teardownRetiredState(state)
          } else {
            await this.reconcileState(state)
          }
          throw new Error(`session-host attachment was canceled: ${name}`)
        }
        await this.reconcileState(state)
        return result
      } catch (error) {
        state.preAckEntries.delete(entry)
        if (state.entries.get(sub) === entry) {
          state.entries.delete(sub)
          const releasedPause = state.pauseOwners.delete(sub)
          state.sizeClaims.delete(sub)
          if (releasedPause && state.pauseOwners.size === 0) state.releasePending = true
        }
        if (state.entries.size === 0 && this.sessions.get(name) === state) {
          this.sessions.delete(name)
          if (!state.generation || this.sessionGenerations.get(name) === state.generation) {
            this.sessionGenerations.delete(name)
          }
          state.bufferedData = []
          this.stopReconnectIfIdle()
          await this.teardownRetiredState(state)
        } else if (this.sessions.get(name) === state && this.hasAttachedEntry(state)) {
          if (
            state.pauseOwners.size === 0 &&
            state.appliedSocket === this.socket &&
            !state.appliedPaused
          ) {
            state.releasePending = false
            this.flushData(state)
          }
          this.queueReconcile(state)
        }
        throw error
      }
    })
  }

  unsubscribe(name: string, sub: SessionSubscriber): void {
    const state = this.sessions.get(name)
    const entry = state?.entries.get(sub)
    if (!state || !entry) return
    state.entries.delete(sub)
    state.preAckEntries.delete(entry)
    const releasedPause = state.pauseOwners.delete(sub)
    state.sizeClaims.delete(sub)
    if (!this.hasAttachedEntry(state)) state.bufferedData = []
    if (releasedPause && state.pauseOwners.size === 0) state.releasePending = true

    if (state.entries.size > 0) {
      this.queueReconcile(state)
      return
    }
    if (this.sessions.get(name) === state) this.sessions.delete(name)
    state.bufferedData = []
    this.stopReconnectIfIdle()
    void this.enqueueState(state, () => this.teardownRetiredState(state))
  }

  /**
   * Probe for a live session AND remember the generation it reports.
   *
   * The bookkeeping is not incidental. `attachExisting` sends
   * `state.generation ?? this.sessionGenerations.get(name)` as its `expectedGeneration`, and the
   * Windows warm-reattach path in pty-manager reaches it through exactly this sequence: probe with
   * `sessionHostHasSession(name)`, then `attachExisting(name, sub)` with no generation of its own.
   * With nothing recorded here that attach carries no expectation, and the ABA protection the kill
   * machinery treats as load-bearing elsewhere is silently absent — a replacement process created
   * under the same name between the probe and the attach would be adopted as the original.
   *
   * This was dropped in the ownership rewrite (`12a1f9ac`) while `attachExisting`'s own doc comment
   * continued to promise it, and is restored here from `a4e3b13d`. A v2 host must supply a
   * well-formed generation; v1 has none, so the entry is cleared rather than left stale.
   */
  async hasSession(name: string): Promise<boolean> {
    const result = await this.request<HasSessionResult>({ cmd: 'hasSession', name })
    // Read the negotiated version AFTER the request: `request()` is what establishes the
    // connection on a cold client, so reading it first sees `null` on the very first probe — the
    // exact call the warm-reattach path makes — and would silently take the "no generation" branch.
    const protocolVersion = this.negotiatedProtocolVersion
    if (!result || typeof result.exists !== 'boolean') {
      throw new Error(`session-host returned an invalid existence result for '${name}'`)
    }
    if (result.exists && protocolVersion === 2) {
      const generation = result.generation
      if (typeof generation !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(generation)) {
        throw new Error(`session-host returned no generation for existing session '${name}'`)
      }
      this.sessionGenerations.set(name, generation)
    } else {
      // Absent, or a v1 host that cannot name a generation: never leave a stale one behind, or a
      // later attach would assert an expectation about a process this probe did not observe.
      this.sessionGenerations.delete(name)
    }
    return result.exists
  }

  write(name: string, sub: SessionSubscriber, data: string): void {
    const state = this.sessions.get(name)
    const entry = state?.entries.get(sub)
    if (!state || !entry) return
    // A watcher is read-only: its xterm's automatic answers (and anything else) never reach the pane.
    if (entry.watch) return
    // Typing makes a viewer the active one, as it does a tmux client. An emulator's automatic
    // answer to a query does not: every attached xterm answers, and counting those would hand the
    // session to whichever viewer answered last.
    if (!isTerminalReport(data)) this.touchClaim(state, sub)
    void this.enqueueState(state, async () => {
      if (this.sessions.get(name) !== state || state.entries.get(sub) !== entry) return
      try {
        await this.request({ cmd: 'write', name, data })
      } catch (error) {
        const socket = this.socket
        if (socket) this.dropSocket(socket, asError(error), true)
      }
    })
  }

  /**
   * Update `sub`'s claim. A claim that actually CHANGES makes `sub` the most recently active viewer
   * (a phone dismissing its keyboard is the case issue #914 is about); re-reporting the same size
   * does not, or every re-fit would steal the session. `bounding` marks a viewer that cannot adapt
   * to any grid but its own, which caps the size for everyone (see `latestClaimSize`).
   */
  resize(
    name: string,
    sub: SessionSubscriber,
    cols: number,
    rows: number,
    bounding = false
  ): void {
    const state = this.sessions.get(name)
    if (!state || !state.entries.has(sub)) return
    // A watcher never votes; it is only told the size the pty runs at.
    if (state.entries.get(sub)?.watch) {
      this.notifySize(state)
      return
    }
    const previous = state.sizeClaims.get(sub) ?? { cols: 80, rows: 24, recency: 0 }
    const next: SizeClaim = {
      cols: normalizeDimension(cols, previous.cols),
      rows: normalizeDimension(rows, previous.rows),
      recency: previous.recency,
      bounding
    }
    if (next.cols !== previous.cols || next.rows !== previous.rows) {
      next.recency = ++this.claimClock
    }
    state.sizeClaims.set(sub, next)
    // Always reconcile, even for an unchanged claim: it ends in `notifySize`, which is how a view
    // that just fitted itself to its own size learns the pty is running at someone else's.
    this.queueReconcile(state)
  }

  pause(name: string, sub: SessionSubscriber): void {
    const state = this.sessions.get(name)
    if (!state || !state.entries.has(sub) || state.pauseOwners.has(sub)) return
    // A viewer never holds a pause ticket on the shared pty: the owner must not slow down for it.
    if (state.entries.get(sub)?.watch) return
    const wasFlowing = state.pauseOwners.size === 0
    state.pauseOwners.add(sub)
    if (wasFlowing) this.queueReconcile(state)
  }

  resume(name: string, sub: SessionSubscriber): void {
    const state = this.sessions.get(name)
    if (!state || !state.entries.has(sub) || !state.pauseOwners.delete(sub)) return
    if (state.pauseOwners.size === 0) {
      state.releasePending = true
      this.queueReconcile(state)
    }
  }

  async sendKeys(name: string, text: string, enter: boolean): Promise<TextDeliveryResult> {
    let sent = false
    try {
      const result = await this.request<{ delivery?: TextDeliveryResult } | undefined>({ cmd: 'sendKeysV2', name, text, enter }, undefined, () => { sent = true })
      // A malformed success cannot prove submission; never retry a possibly accepted paste.
      return result?.delivery === true || result?.delivery === false ? result.delivery : 'pasted-not-submitted'
    } catch (error) {
      // A frame handed to the socket may already have pasted. A lost reply is not a
      // pre-input refusal: surface uncertainty and never invite an automatic resend.
      return sent && !(error instanceof SessionHostRequestRejectedError) ? 'pasted-not-submitted' : false
    }
  }

  async paneCommand(name: string): Promise<string | null> {
    try {
      const result = await this.request<PaneCommandResult>({ cmd: 'paneCommand', name })
      return result.command
    } catch {
      return null
    }
  }

  async messageOwner(name: string): Promise<PaneOwner | null> {
    try {
      return await this.request<PaneOwner | null>({ cmd: 'messageOwnerV1', name })
    } catch { return null } // Older live hosts refuse; never replace them or use name-only input.
  }

  async messagePasteReady(name: string): Promise<boolean> {
    try {
      return await this.request<boolean>({ cmd: 'messagePasteReadyV1', name }) === true
    } catch { return false }
  }

  async messageEnvelope(name: string, envelope: string, expected: PaneOwner): Promise<boolean> {
    try {
      return await this.request<boolean>({ cmd: 'messageEnvelopeV1', name, envelope, expected }) === true
    } catch { return false }
  }

  /** `terminateOwnerV1`. `'unsupported'` = the live host predates the verb (it answered `unknown
   *  command`) — distinct from `false`, so the UI can say "restart the app" instead of "busy". Any
   *  other failure, a lost reply included, is `false`: the caller then refuses to recycle. Never
   *  retried — a second kill aimed at a re-proven owner is the host's job, not a resend's. */
  async terminateOwner(name: string, expected: PaneOwner): Promise<boolean | 'unsupported'> {
    try {
      const result = await this.request<{ terminated?: unknown } | undefined>(
        { cmd: 'terminateOwnerV1', name, expected },
        undefined,
        undefined,
        TERMINATE_OWNER_REQUEST_TIMEOUT_MS
      )
      return result?.terminated === true
    } catch (error) {
      return error instanceof SessionHostRequestRejectedError && error.message === 'unknown command'
        ? 'unsupported'
        : false
    }
  }

  /** `writeDetachedV1`: raw bytes into a session this process holds no attachment on. True only on
   *  the host's acknowledgement. NEVER retried and never re-routed through `sendKeys`: a lost reply
   *  may still have been typed, and an older host's refusal never reached the pty at all — either
   *  way a second attempt risks typing the input twice or in a different shape. */
  async writeDetached(name: string, data: string): Promise<boolean> {
    try {
      await this.request<unknown>({ cmd: 'writeDetachedV1', name, data })
      return true
    } catch {
      return false
    }
  }

  /** The pane app's mouse-tracking protocol, or null when unknown: no such session, or an older
   *  live host that predates `paneModesV1` (never replaced to learn it). Callers treat null as
   *  "the app did not ask for the mouse". */
  async mouseTrackingMode(name: string): Promise<PaneModesResult['mouseTracking'] | null> {
    try {
      const r = await this.request<PaneModesResult | null>({ cmd: 'paneModesV1', name })
      const m = r?.mouseTracking
      return m === 'none' || m === 'x10' || m === 'vt200' || m === 'drag' || m === 'any' ? m : null
    } catch {
      return null
    }
  }

  async capture(name: string, full: boolean): Promise<string> {
    const result = await this.request<CaptureResult>({ cmd: 'capture', name, full })
    return result.text
  }

  /** A live link's keyframe (`captureVisible` feature). Null when the host did not advertise the
   *  feature (never sent then), the session is gone, or anything failed — a keyframe is an
   *  optimisation, and "no capture" must stay distinguishable from an empty screen. */
  async captureVisible(name: string): Promise<CaptureVisibleResult | null> {
    try {
      if (!(await this.supportsFeature('captureVisible'))) return null
      const r = await this.request<CaptureVisibleResult>({ cmd: 'captureVisible', name })
      if (!r || typeof r.screen !== 'string' || typeof r.altScreen !== 'boolean') return null
      const c = r.cursor
      const cursor =
        c && Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0
          ? { x: c.x, y: c.y }
          : null
      return { screen: r.screen, cursor, altScreen: r.altScreen }
    } catch {
      return null
    }
  }

  /** The cwd the pane last REPORTED (`paneCwd` feature); null without the feature, before any
   *  report, or on any failure. */
  async paneCwd(name: string): Promise<string | null> {
    try {
      if (!(await this.supportsFeature('paneCwd'))) return null
      const r = await this.request<PaneCwdResult>({ cmd: 'paneCwd', name })
      return typeof r?.cwd === 'string' && r.cwd ? r.cwd : null
    } catch {
      return null
    }
  }

  /** Execute already-rendered trusted input through the persistent generation's exactly-once
   *  launch ledger. Retrying with the SAME `launchId` after a lost reply is safe: the host answers
   *  `already-executed` rather than typing the command a second time. Never retries internally —
   *  the caller (session-host-backend.ts's `sessionHostExecuteLaunch`) owns that decision, exactly
   *  as it owns the `launchId` that makes a retry idempotent. */
  async executeLaunch(
    name: string,
    launchId: string,
    plan: PreparedAgentLaunch
  ): Promise<ExecuteLaunchResult> {
    await this.ensureConnected()
    const protocolVersion = this.negotiatedProtocolVersion
    if (protocolVersion !== 2) {
      throw new SessionHostProtocolCompatibilityError(`launch an agent in terminal '${name}'`)
    }
    const state = this.sessions.get(name)
    const generation = state?.generation ?? this.sessionGenerations.get(name)
    if (!generation) throw new Error(`session-host has no confirmed generation for '${name}'`)
    const result = await this.request<ExecuteLaunchResult>({
      cmd: 'executeLaunch',
      name,
      generation,
      launchId,
      command: plan.command,
      ...(plan.stdinAfterStart !== undefined ? { stdinAfterStart: plan.stdinAfterStart } : {})
    })
    if (!result || (result.status !== 'executed' && result.status !== 'already-executed')) {
      throw new Error(`session-host returned an invalid launch result for '${name}'`)
    }
    return result
  }

  /** The one call that actually ENDS a session. `reserveReplacement` atomically reserves the
   *  now-vacated name for THIS operation (`replacementTokens`) so only the client that confirmed
   *  the kill can spawn the replacement — other authenticated app clients cannot steal it.
   *  `expectedAbsent` skips the generation probe entirely for a lease acquired before any local
   *  attach ever observed a generation (e.g. "restart a session I never attached"), so the lease
   *  can never silently adopt a generation created by someone else after this call started.
   *  `requireV2` demands the same atomic guarantees on a legacy (v1) host, which cannot provide
   *  them — protocol-incompatible rather than silently degraded.
   *
   *  Retrying with the SAME options reuses the SAME `operationId` (`killOperations`), so a lost
   *  reply can be retried without risking a second, different destructive operation (host-side
   *  ABA safety). A confirmed kill installs `killReplayBarriers` for `name` BEFORE the first
   *  destructive write and only clears it on confirmation — see `attachSubscriber`'s barrier
   *  check and `restoreSocket`'s reconnect-replay skip, both of which already depend on this. */
  async killSession(
    name: string,
    options: {
      reserveReplacement?: boolean
      requireV2?: boolean
      expectedAbsent?: boolean
      /** The generation the caller OBSERVED (a `listSessionsDetailed` row). Wins over anything
       *  this client remembers, so a kill planned from a listing can never end a same-name
       *  successor created after it — the host answers "already gone" instead. */
      expectedGeneration?: string
    } = {}
  ): Promise<void> {
    const reserveReplacement = options.reserveReplacement === true
    const requireV2 = options.requireV2 === true
    const expectedAbsent = options.expectedAbsent === true
    if (expectedAbsent && !reserveReplacement) {
      throw new Error('session-host expected-absent mode requires a replacement reservation')
    }
    const knownIdentity = this.killOperations.get(name)
    if (
      knownIdentity &&
      (knownIdentity.reserveReplacement !== reserveReplacement ||
        knownIdentity.requireV2 !== requireV2 ||
        knownIdentity.expectedAbsent !== expectedAbsent)
    ) {
      throw new Error(
        `session-host: kill retry mode changed for '${name}'; retry with ` +
          `reserveReplacement=${String(knownIdentity.reserveReplacement)} and ` +
          `requireV2=${String(knownIdentity.requireV2)} and ` +
          `expectedAbsent=${String(knownIdentity.expectedAbsent)}`
      )
    }
    // A kill planned from a LISTING (the session reaper) is for a session nobody in this process is
    // watching. If this client holds attachments for the name now, the plan is stale: refuse rather
    // than end — or, for a same-name successor, silently strand — a terminal someone just opened.
    if (options.expectedGeneration !== undefined && !knownIdentity) {
      const local = this.sessions.get(name)
      if (local && (local.entries.size > 0 || local.preAckEntries.size > 0)) {
        throw new Error(`session-host: '${name}' is attached in this process; observed-generation kill refused`)
      }
    }
    const active = this.killsInFlight.get(name)
    if (active) return active

    // Install the barrier before the first write. The host may complete the kill and lose its
    // reply; without this ordering, reconnect's attach-or-create replay resurrects the old shell.
    this.killReplayBarriers.add(name)
    const state = this.sessions.get(name)
    const identity: KillOperationIdentity = knownIdentity ?? {
      operationId: randomUUID(),
      expectedGeneration:
        options.expectedGeneration ?? state?.generation ?? this.sessionGenerations.get(name),
      reserveReplacement,
      requireV2,
      expectedAbsent,
      observed: options.expectedGeneration !== undefined
    }
    this.killOperations.set(name, identity)
    let operation!: Promise<void>
    operation = this.prepareAndConfirmKillSession(name, identity)
      .catch((error) => {
        // Compatibility/probe failures happen before a destructive frame exists. Roll the local
        // barrier back so a live attachment is not stranded behind an operation the host never
        // saw. Once confirmKillSession starts, it deliberately retains identity/barrier on doubt.
        if (this.killOperations.get(name) === identity && identity.prepared !== true) {
          this.killOperations.delete(name)
          this.killReplayBarriers.delete(name)
        }
        throw error
      })
      .finally(() => {
        if (this.killsInFlight.get(name) === operation) this.killsInFlight.delete(name)
      })
    this.killsInFlight.set(name, operation)
    return operation
  }

  private async prepareAndConfirmKillSession(
    name: string,
    identity: KillOperationIdentity
  ): Promise<void> {
    await this.ensureConnected()
    const protocolVersion = this.negotiatedProtocolVersion
    if (!protocolVersion) throw new Error('session-host: not connected')
    if (protocolVersion === 1 && (identity.reserveReplacement || identity.requireV2)) {
      throw new SessionHostProtocolCompatibilityError(`restart terminal '${name}'`)
    }

    // With no live authoritative attachment, determine the exact current generation immediately
    // before creating this destructive operation. An uncertain prior operation skips this probe
    // because its original operationId/generation is precisely what makes retry ABA-safe.
    if (protocolVersion === 2 && !identity.expectedGeneration && !identity.expectedAbsent) {
      const result = await this.request<HasSessionResult>({ cmd: 'hasSession', name })
      if (!result || typeof result.exists !== 'boolean') {
        throw new Error(`session-host returned an invalid existence result for '${name}'`)
      }
      if (result.exists) {
        const generation = result.generation
        if (typeof generation !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(generation)) {
          throw new Error(`session-host returned no generation for existing session '${name}'`)
        }
        identity.expectedGeneration = generation
        this.sessionGenerations.set(name, generation)
      }
    }

    identity.prepared = true
    await this.confirmKillSession(
      name,
      identity.operationId,
      identity.expectedGeneration,
      identity.reserveReplacement,
      identity.requireV2,
      identity.observed === true
    )
  }

  private async confirmKillSession(
    name: string,
    operationId: string,
    expectedGeneration: string | undefined,
    reserveReplacement: boolean,
    requireV2: boolean,
    observed = false
  ): Promise<void> {
    let lastError = new Error('session-host kill did not run')
    for (let attempt = 0; attempt < KILL_CONFIRMATION_ATTEMPTS; attempt++) {
      try {
        await this.ensureConnected()
        const protocolVersion = this.negotiatedProtocolVersion
        if (!protocolVersion) throw new Error('session-host: not connected')
        if (protocolVersion === 1 && (reserveReplacement || requireV2)) {
          throw new SessionHostProtocolCompatibilityError(`restart terminal '${name}'`)
        }
        // The host defines missing as success and coalesces an in-progress kill by name. Resending
        // after reconnect is therefore the confirmation operation for both "reply lost after
        // kill" and "first write never reached the host".
        const result = await this.request<KillSessionResult>({
          cmd: 'killSession',
          name,
          operationId,
          expectedGeneration,
          reserveReplacement
        })
        if (protocolVersion === 2 && (!result || typeof result !== 'object')) {
          throw new Error(`session-host returned an invalid kill result for '${name}'`)
        }
        if (reserveReplacement) {
          if (result?.replacementToken !== operationId) {
            throw new Error(
              `session-host did not confirm the replacement reservation for '${name}'`
            )
          }
          this.replacementTokens.set(name, result.replacementToken)
        } else {
          if (result?.replacementToken) {
            throw new Error(
              `session-host returned an unexpected replacement reservation for '${name}'`
            )
          }
          this.replacementTokens.delete(name)
        }
        // An observed-generation kill whose name gained a local attachment meanwhile must not
        // clear it: the host answers success for a generation that is already gone, so the live
        // attachment may be a same-name SUCCESSOR. If it really was the generation just ended,
        // the host's exit frame retires it through the ordinary exit path instead.
        const local = this.sessions.get(name)
        const raced =
          observed && !!local && (local.entries.size > 0 || local.preAckEntries.size > 0)
        if (!raced) {
          this.clearLocalSessionState(name)
          this.sessionGenerations.delete(name)
        }
        this.killReplayBarriers.delete(name)
        if (!reserveReplacement && this.killOperations.get(name)?.operationId === operationId) {
          this.killOperations.delete(name)
        }
        return
      } catch (error) {
        lastError = asError(error)
        if (attempt + 1 < KILL_CONFIRMATION_ATTEMPTS) {
          // A timeout or explicit error can leave an apparently-live socket behind. Force the
          // retry through a fresh authenticated connection; target replay remains barred while
          // unrelated attachments are eligible for ordinary reconnect replay.
          const socket = this.socket
          if (socket) {
            this.dropSocket(
              socket,
              new Error(`session-host connection reset to retry kill '${name}'`),
              true
            )
          }
        }
      }
    }

    // Preserve subscribers/memory as evidence of the uncertain generation, but never replay it.
    // A later explicit killSession(name) starts a fresh bounded confirmation pass and can clear
    // this barrier once the idempotent host operation answers.
    throw new Error(
      `session-host: kill of '${name}' remains unconfirmed after ` +
        `${KILL_CONFIRMATION_ATTEMPTS} attempts; attach replay is suspended to prevent recreating ` +
        `the old process. Retry the kill before starting a replacement. Last error: ${lastError.message}`
    )
  }

  /** Drop every locally attached subscriber for a confirmed-killed `name` without notifying them
   *  (the caller of `killSession` already knows the session ended; an explicit kill is not a
   *  surprise `onExit`, exactly as the pre-recovery implementation this replaces never fired one
   *  either). Mirrors `unsubscribe`'s teardown fields so no stale flow-control/applied-state
   *  survives into whatever reuses this name next. */
  private clearLocalSessionState(name: string): void {
    const state = this.sessions.get(name)
    if (!state) return
    if (this.sessions.get(name) === state) this.sessions.delete(name)
    state.entries.clear()
    state.preAckEntries.clear()
    state.pauseOwners.clear()
    state.sizeClaims.clear()
    state.bufferedData = []
    state.releasePending = false
    state.appliedSocket = null
    state.appliedAttached = false
    state.appliedPaused = false
    state.appliedSize = null
    state.appliedWatch = false
    this.stopReconnectIfIdle()
  }

  /**
   * Prepare-for-update, step 1 (issue #829): is a host running, which sessions does it hold, and
   * can it shut itself down? NEVER launches a host: with no published state file there is nothing
   * to ask, and starting one just to answer would re-lock the very directory the update needs.
   */
  async inspectForUpdate(): Promise<HostUpdateInspection> {
    const paths = sessionHostPaths(this.deps.userDataDir)
    const identity = readExistingSessionHostIdentity(paths.statePath, {
      expectedEndpoint: paths.endpoint,
      expectedTokenPath: paths.tokenPath
    })
    if (identity.kind === 'absent') return { running: false }
    await this.ensureConnected()
    const result = await this.request<ListSessionsResult>({ cmd: 'listSessions' })
    return {
      running: true,
      sessions: result.names,
      shutdown: this.hostShutdownFeature,
      staging: await this.hostStagingFor(identity.state)
    }
  }

  /** The published state names a pid and (newer hosts) an image. Classified only when that pid is
   *  the host this client is connected to: a host replaced between the read and the connect is
   *  `unknown`, never someone else's answer. Any failure is `unknown`. */
  private async hostStagingFor(state: { pid: number; exe?: string }): Promise<HostImageStaging> {
    const classify = this.deps.hostStaging
    if (!classify || this.hostPid === null || state.pid !== this.hostPid) return 'unknown'
    try {
      return await classify({ exe: state.exe, pid: this.hostPid })
    } catch {
      return 'unknown'
    }
  }

  /**
   * Prepare-for-update, final step (issue #829): ask the host to end every session's process tree
   * and exit, then confirm the process is actually gone. Every answer short of `shut-down` leaves
   * the caller with a host that may still hold the install directory, so it must not quit and
   * claim the update can proceed. There is deliberately no fallback that kills the host process:
   * a host without the feature answers `unsupported`, and the caller shows the manual steps.
   */
  async shutdownForUpdate(options: { timeoutMs?: number; exitWaitMs?: number } = {}): Promise<
    HostShutdownOutcome
  > {
    const paths = sessionHostPaths(this.deps.userDataDir)
    const identity = readExistingSessionHostIdentity(paths.statePath, {
      expectedEndpoint: paths.endpoint,
      expectedTokenPath: paths.tokenPath
    })
    if (identity.kind === 'absent') return { kind: 'no-host' }
    await this.ensureConnected()
    if (!this.hostShutdownFeature) return { kind: 'unsupported' }
    const socket = this.socket
    if (!socket) return { kind: 'unconfirmed', error: 'session-host connection lost' }
    const pid = this.hostPid
    // Latched BEFORE the request leaves, so a connection that drops mid-shutdown cannot reconnect
    // into a freshly launched host. The request itself goes on the socket already in hand (never
    // through `request`, whose reconnect path the latch now refuses) and is never resent.
    this.shutDownForUpdate = true
    let result: ShutdownResult
    try {
      result = await this.requestOnSocket<ShutdownResult>(
        socket,
        { cmd: 'shutdown' },
        undefined,
        undefined,
        options.timeoutMs ?? SHUTDOWN_REQUEST_TIMEOUT_MS
      )
    } catch (error) {
      const message =
        error instanceof SessionHostRequestNotDeliveredError
          ? error.original.message
          : asError(error).message
      // The host's own refusal: it said which sessions it could not end, and it is still serving.
      if (/could not end|already shutting down|shutdown requires/.test(message)) {
        this.shutDownForUpdate = false
        return { kind: 'failed', error: message }
      }
      // The frame provably never left: nothing was asked, the host is untouched and still usable.
      if (error instanceof SessionHostRequestNotDeliveredError) {
        this.shutDownForUpdate = false
        return { kind: 'unconfirmed', error: message }
      }
      // A lost reply or a timeout says nothing about whether the host is still up. The latch STAYS
      // set: if it did exit, a reconnect must not launch a replacement that re-locks the install
      // directory. The caller tells the user to quit and check; a restart clears the latch.
      return { kind: 'unconfirmed', error: message }
    }
    const gone = await waitForHostExit(paths.statePath, pid, options.exitWaitMs ?? 10_000)
    if (!gone) {
      return {
        kind: 'unconfirmed',
        error: 'the session host reported its sessions ended but has not exited yet'
      }
    }
    return { kind: 'shut-down', ended: result.ended }
  }

  async listSessions(): Promise<string[]> {
    const result = await this.request<ListSessionsResult>({ cmd: 'listSessions' })
    return result.names
  }

  /**
   * The observability read (see `SessionHostListing`). Like `inspectForUpdate` it never launches a
   * host when nothing is published — a session reaper, a memory panel or a ports chip asking a
   * question must not start the process whose sessions it is asking about. Every failure (a
   * request that threw, a reply without `names`) is `null`, never an empty listing.
   */
  async listSessionsDetailed(): Promise<SessionHostListing | null> {
    try {
      const connected = !!this.socket && !this.socket.destroyed
      if (!connected) {
        const paths = sessionHostPaths(this.deps.userDataDir)
        const identity = readExistingSessionHostIdentity(paths.statePath, {
          expectedEndpoint: paths.endpoint,
          expectedTokenPath: paths.tokenPath
        })
        if (identity.kind === 'absent') return { running: false, names: [], sessions: [] }
        // Published state is not proof of a live host (a killed host, a reboot): connect only to
        // one that answers. Nothing answering is a FAILED read (null) — never a launch.
        await this.ensureConnected({ launch: false })
      }
      const result = await this.request<ListSessionsResult>({ cmd: 'listSessions' })
      if (!result || !Array.isArray(result.names) || !result.names.every((n) => typeof n === 'string')) {
        return null
      }
      // Read AFTER the request: `request()` is what establishes the connection on a cold client.
      const sessions = this.hostFeatures.has('sessionDetails') && Array.isArray(result.sessions)
        ? validSessionDetails(result.sessions).filter((row) => result.names.includes(row.name))
        : null
      const hostPid = this.hostPid
      return Number.isSafeInteger(hostPid) && (hostPid as number) > 0
        ? { running: true, names: result.names, sessions, hostPid: hostPid as number }
        : { running: true, names: result.names, sessions }
    } catch {
      return null
    }
  }
}

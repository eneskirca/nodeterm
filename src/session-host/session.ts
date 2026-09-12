import type { Socket } from 'net'
import { createHash, randomUUID } from 'crypto'
import * as pty from 'node-pty'
import { TerminalEmulator } from './terminal-emulator'
import type {
  ExecuteLaunchResult,
  SessionHostShellDialect,
  SessionHostSpawnOptions
} from './protocol'

const MAX_LAUNCH_LEDGER_ENTRIES = 256
const SHELL_QUIET_MS = 200
const SHELL_QUIET_CAP_MS = 1_500
const POST_LAUNCH_READY_CAP_MS = 5_000
const LAUNCH_READINESS_POLL_MS = 100
const VERIFY_TIMEOUT_MS = 2_000
const ECHO_EDGE_CHARS = 24
const DELIVERY_ATTEMPTS = 3
import {
  KILL_LINE,
  WINDOWS_KILL_LINE,
  shellKillLineSequence
} from '../shared/shell-kill-line'

export { KILL_LINE, WINDOWS_KILL_LINE, shellKillLineSequence }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

function cleanEcho(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(ESC_SEQ, '').replace(/[\r\n]/g, '')
}

interface LaunchLedgerEntry {
  fingerprint: string
  outcome: Promise<{ ok: true } | { ok: false }>
}

interface HostSessionOverrides {
  proc?: pty.IPty
  term?: TerminalEmulator
}

function launchFingerprint(command: string, stdinAfterStart: string | undefined): string {
  const hash = createHash('sha256')
  hash.update(command, 'utf8')
  hash.update('\0', 'utf8')
  if (stdinAfterStart !== undefined) hash.update(stdinAfterStart, 'utf8')
  return hash.digest('hex')
}

function replacementAttachFingerprint(
  spawn: SessionHostSpawnOptions,
  scrollback: number
): string {
  const canonical = {
    cwd: spawn.cwd,
    shell: spawn.shell,
    args: [...spawn.args],
    env: Object.fromEntries(Object.entries(spawn.env).sort(([a], [b]) => a.localeCompare(b))),
    cols: spawn.cols,
    rows: spawn.rows,
    launchDialect: spawn.launchDialect ?? null,
    initialLaunch: spawn.initialLaunch ?? null,
    scrollback
  }
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

/** Pause before the asynchronous headless terminal retains more than this many queued UTF-8
 * bytes. node-pty can still have a bounded amount already in flight, but it cannot keep feeding an
 * unbounded promise chain while xterm is behind. */
export const SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES = 4 * 1024 * 1024
/** Resume only after the queued emulator tail drains this far, leaving hysteresis so a producer
 * hovering around the high-water boundary cannot chatter node-pty's global pause actuator. */
export const SESSION_EMULATOR_OUTPUT_LOW_WATER_BYTES = 1 * 1024 * 1024

interface Geometry {
  cols: number
  rows: number
}

interface HostSessionOverrides {
  proc?: pty.IPty
  term?: TerminalEmulator
}

interface AttachmentState {
  geometry?: Geometry
  explicitPaused: boolean
  subscribed: boolean
}

/** A warm attach must temporarily claim geometry and (on reconnect) restore its explicit pause
 * before reading a screen. The transaction makes a failed/retried attach restore only its own
 * prior socket state instead of leaking a claim or erasing an already-live duplicate attach. */
export interface PreparedHostAttachment {
  isCurrent(): boolean
  /** False means a concurrent detach/close cancelled this exact socket+name transaction. */
  commit(): boolean
  rollback(): Promise<void>
}

function normalizedGeometry(cols: number, rows: number): Geometry {
  if (
    !Number.isInteger(cols) ||
    !Number.isFinite(cols) ||
    cols <= 0 ||
    !Number.isInteger(rows) ||
    !Number.isFinite(rows) ||
    rows <= 0
  ) {
    throw new Error('terminal geometry must use finite positive integer cols and rows')
  }
  return { cols, rows }
}

/**
 * One persisted session, owned by the host process for as long as it lives — this is the
 * Windows-and-anywhere-else-tmux-is-missing analogue of a tmux session: it survives every
 * connecting client detaching, and outlives the app that spawned it.
 */
export class HostSession {
  readonly name: string
  /** Opaque identity for this exact process generation. Same-name replacement gets a new value. */
  readonly generation = randomUUID()
  readonly launchDialect?: SessionHostShellDialect
  readonly shellExecutableName: string
  /** Operation that created this generation after consuming a replacement lease. Retained only
   * with the live generation so a lost attach reply can be replayed idempotently with that token. */
  readonly createdByReplacementToken?: string
  private readonly replacementFingerprint: string
  readonly proc: pty.IPty
  private readonly term: TerminalEmulator
  /** The tail of every emulator mutation accepted so far. `@xterm/headless` applies writes
   * asynchronously, so warm attach/capture/resize/exit all cross this barrier. Rejections heal the
   * shared tail while the individual recordOutput caller still observes its own failure. */
  private outputTail: Promise<void> = Promise.resolve()
  private queuedOutputBytes = 0
  /** Explicit protocol flow and named-pipe transport flow drain independently. Collapsing them by
   * socket lets a `drain` event cancel a renderer pause that is still owed. */
  private readonly explicitPauseOwners = new Set<Socket>()
  private readonly transportPauseOwners = new Set<Socket>()
  /** The emulator queue is session-global, not owned by a connection. */
  private emulatorPauseOwner = false
  /** Each app connection contributes one componentwise geometry claim. The effective PTY size is
   * the minimum across live claims so every viewer fits; removing the smallest claim grows it. */
  private readonly geometryClaims = new Map<Socket, Geometry>()
  /** A detach/close increments the socket epoch before clearing state. A delayed prepare/rollback
   * from the prior epoch can then observe cancellation instead of resurrecting a ghost socket. */
  private readonly attachmentEpochs = new WeakMap<Socket, number>()
  private appliedGeometry: Geometry
  /** Consecutive callers asking for the same effective target share one acknowledgement. If that
   * actuator attempt fails, every waiter sees the failure; a later exact retry starts a new one. */
  private pendingGeometry: { key: string; promise: Promise<void> } | null = null
  /** Sockets currently receiving `data`/`exit` push frames for this session — the same "N
   * subscribers, one underlying process" shape `pty-manager.ts` already implements for tmux
   * co-attach, one level further down the stack. */
  readonly subscribers = new Set<Socket>()
  readonly createdAt = Date.now()
  /** Set once, by whichever path (natural pty exit or an explicit `killSession`) ends this
   * session first — guards against double-dispose/double-broadcast when both could race. */
  exited = false
  /** Generation-local exactly-once ledger. Promise insertion happens before command delivery, so
   * another app process repeating a launch whose first reply was lost observes the same result. */
  private readonly launchLedger = new Map<string, LaunchLedgerEntry>()
  /** Different launch ids must not type over one another in the same interactive prompt. */
  private launchQueue: Promise<void> = Promise.resolve()
  /** While trusted private input is being echo-verified, host.ts must neither broadcast it nor
   * write it into the reconstructable emulator screen. */
  private privateLaunchOutput = false

  get suppressingPrivateLaunchOutput(): boolean {
    return this.privateLaunchOutput
  }

  get killLineSequence(): string {
    return shellKillLineSequence(this.launchDialect, this.shellExecutableName)
  }

  /** True once a successful explicit kill has claimed the name but before node-pty proves process
   * death with onExit. Same-name attach waits behind `ending` instead of joining this generation. */
  retiring = false
  /** Shared completion for the natural-exit / explicit-kill race. A second caller waits for the
   * first caller's output drain instead of acknowledging while teardown is still in flight. */
  ending: Promise<void> | null = null
  private processExitCode: number | null = null
  private readonly processExit: Promise<number>
  private resolveProcessExit!: (exitCode: number) => void
  constructor(
    name: string,
    spawn: SessionHostSpawnOptions,
    scrollback: number,
    createdByReplacementTokenOrOverrides?: string | HostSessionOverrides,
    maybeOverrides?: HostSessionOverrides
  ) {
    const createdByReplacementToken =
      typeof createdByReplacementTokenOrOverrides === 'string'
        ? createdByReplacementTokenOrOverrides
        : undefined
    const overrides =
      typeof createdByReplacementTokenOrOverrides === 'object'
        ? createdByReplacementTokenOrOverrides
        : maybeOverrides
    this.name = name
    this.launchDialect = spawn.launchDialect
    this.shellExecutableName = (spawn.shell.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase()
    this.createdByReplacementToken = createdByReplacementToken
    this.replacementFingerprint = replacementAttachFingerprint(spawn, scrollback)
    this.processExit = new Promise<number>((resolve) => {
      this.resolveProcessExit = resolve
    })
    this.appliedGeometry = normalizedGeometry(spawn.cols, spawn.rows)
    this.proc =
      overrides?.proc ??
      pty.spawn(spawn.shell, spawn.args, {
        name: 'xterm-256color',
        cols: this.appliedGeometry.cols,
        rows: this.appliedGeometry.rows,
        cwd: spawn.cwd,
        env: spawn.env
      })
    this.term =
      overrides?.term ??
      new TerminalEmulator({
        cols: this.appliedGeometry.cols,
        rows: this.appliedGeometry.rows,
        scrollback
      })
  }

  /** Queue one PTY-output chunk into the headless emulator, preserving arrival order and bounding
   * the retained byte tail. Accounting happens before chaining because promises not yet started
   * still retain their chunk strings and therefore count against the memory bound. */
  recordOutput(data: string): Promise<void> {
    const bytes = Buffer.byteLength(data, 'utf8')
    this.queuedOutputBytes += bytes
    if (this.queuedOutputBytes >= SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES) {
      this.setEmulatorPause(true)
    }

    const applied = this.outputTail.then(() => this.term.write(data))
    const settled = applied.finally(() => {
      this.queuedOutputBytes = Math.max(0, this.queuedOutputBytes - bytes)
      if (this.queuedOutputBytes <= SESSION_EMULATOR_OUTPUT_LOW_WATER_BYTES) {
        this.setEmulatorPause(false)
      }
    })
    this.outputTail = settled.catch(() => {})
    return settled
  }

  /** Wait until every PTY-output chunk observed before this call has reached xterm. */
  settleOutput(): Promise<void> {
    return this.outputTail
  }

  /** Record the one authoritative process-death observation. A kill syscall returning is not this
   * event; only node-pty's onExit resolves the barrier and permits retirement acknowledgement. */
  observeProcessExit(exitCode: number): void {
    if (this.processExitCode !== null) return
    this.processExitCode = exitCode
    this.exited = true
    this.resolveProcessExit(exitCode)
  }

  waitForProcessExit(): Promise<number> {
    return this.processExit
  }

  /** Serialize only after prior asynchronous writes and geometry changes have landed. */
  async serialize(scrollback?: number): Promise<string> {
    await this.outputTail
    return this.term.serialize(scrollback)
  }

  /** Stage an attach's explicit flow state and per-socket geometry before the warm screen barrier.
   * The returned commit is the only operation that activates live delivery. */
  async prepareAttachment(
    socket: Socket,
    cols: number,
    rows: number,
    paused: boolean
  ): Promise<PreparedHostAttachment> {
    const epoch = (this.attachmentEpochs.get(socket) ?? 0) + 1
    this.attachmentEpochs.set(socket, epoch)
    const previous: AttachmentState = {
      geometry: this.geometryClaims.get(socket),
      explicitPaused: this.explicitPauseOwners.has(socket),
      subscribed: this.subscribers.has(socket)
    }
    this.setSocketPauseOwner(this.explicitPauseOwners, socket, paused)
    try {
      await this.setGeometryClaim(socket, cols, rows)
    } catch (error) {
      await this.restoreAttachment(socket, previous, epoch)
      throw error
    }

    let finished = false
    return {
      isCurrent: () => this.attachmentEpochs.get(socket) === epoch && !socket.destroyed,
      commit: () => {
        if (finished) return false
        finished = true
        if (this.attachmentEpochs.get(socket) !== epoch || socket.destroyed) return false
        this.subscribers.add(socket)
        // A response written before this attach may already have filled the socket. The new
        // session must inherit that socket-wide transport ticket before any live frame can add to
        // the same queue.
        if (socket.writableNeedDrain) this.setSocketPauseOwner(this.transportPauseOwners, socket, true)
        return true
      },
      rollback: async () => {
        if (finished) return
        finished = true
        await this.restoreAttachment(socket, previous, epoch)
      }
    }
  }

  /** Warm no-spawn attach used by a generation-checked reconnect. New clients carry their current
   * aggregate geometry; older v2 clients safely reuse the generation's last applied size. */
  prepareExistingAttachment(
    socket: Socket,
    paused: boolean,
    cols?: number,
    rows?: number
  ): Promise<PreparedHostAttachment> {
    if ((cols === undefined) !== (rows === undefined)) {
      throw new Error('existing attachment geometry requires both cols and rows')
    }
    const geometry =
      cols === undefined || rows === undefined ? this.appliedGeometry : normalizedGeometry(cols, rows)
    return this.prepareAttachment(socket, geometry.cols, geometry.rows, paused)
  }

  /** Update only the requesting subscriber's geometry claim. */
  async resizeFor(socket: Socket, cols: number, rows: number): Promise<void> {
    if (!this.subscribers.has(socket)) return
    await this.setGeometryClaim(socket, cols, rows)
  }

  pauseFor(socket: Socket): void {
    if (!this.subscribers.has(socket)) return
    this.setSocketPauseOwner(this.explicitPauseOwners, socket, true)
  }

  resumeFor(socket: Socket): void {
    if (!this.subscribers.has(socket)) return
    this.setSocketPauseOwner(this.explicitPauseOwners, socket, false)
  }

  pauseTransportFor(socket: Socket): void {
    if (!this.subscribers.has(socket)) return
    this.setSocketPauseOwner(this.transportPauseOwners, socket, true)
  }

  resumeTransportFor(socket: Socket): void {
    this.setSocketPauseOwner(this.transportPauseOwners, socket, false)
  }

  /** A protocol detach and a transport close mean the same thing for ownership: this socket can
   * never return either flow ticket or its geometry claim, so release all three unconditionally. */
  async detach(socket: Socket): Promise<void> {
    this.attachmentEpochs.set(socket, (this.attachmentEpochs.get(socket) ?? 0) + 1)
    const wasPaused = this.hasPauseOwner()
    this.subscribers.delete(socket)
    this.explicitPauseOwners.delete(socket)
    this.transportPauseOwners.delete(socket)
    this.reconcileProcFlow(wasPaused)
    if (!this.geometryClaims.delete(socket)) return
    await this.applyEffectiveGeometry()
  }

  async executeInitialLaunch(
    spawn: SessionHostSpawnOptions,
    readinessProbe?: () => Promise<boolean>
  ): Promise<ExecuteLaunchResult | undefined> {
    const initial = spawn.initialLaunch
    if (!initial) return undefined
    return this.executeLaunch(
      initial.launchId,
      initial.command,
      initial.stdinAfterStart,
      readinessProbe
    )
  }

  matchesReplacementReplay(spawn: SessionHostSpawnOptions, scrollback: number): boolean {
    return this.replacementFingerprint === replacementAttachFingerprint(spawn, scrollback)
  }

  dispose(): void {
    this.explicitPauseOwners.clear()
    this.transportPauseOwners.clear()
    this.emulatorPauseOwner = false
    this.geometryClaims.clear()
    this.term.dispose()
  }

  async executeLaunch(
    launchId: string,
    command: string,
    stdinAfterStart?: string,
    readinessProbe?: () => Promise<boolean>
  ): Promise<ExecuteLaunchResult> {
    if (!this.launchDialect) {
      throw new Error('session-host terminal has no trusted launch dialect')
    }
    if (!UUID_V4.test(launchId)) throw new Error('session-host launch id is invalid')
    if (!command || command.length > 128 * 1024 || command.includes('\0')) {
      throw new Error('session-host launch input is invalid')
    }
    if (
      stdinAfterStart !== undefined &&
      (stdinAfterStart.length > 1024 * 1024 || stdinAfterStart.includes('\0'))
    ) {
      throw new Error('session-host launch follow-up input is invalid')
    }
    const fingerprint = launchFingerprint(command, stdinAfterStart)
    const existing = this.launchLedger.get(launchId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('session-host launch id was reused with different input')
      }
      const outcome = await existing.outcome
      if (!outcome.ok) throw new Error('session-host launch delivery previously failed')
      return { status: 'already-executed' }
    }

    // Never evict within a live generation. Eviction would make an old lost-reply retry execute a
    // second time; at the bounded cap, fail new ids closed until this generation ends.
    if (this.launchLedger.size >= MAX_LAUNCH_LEDGER_ENTRIES) {
      throw new Error('session-host launch ledger is full for this terminal generation')
    }

    const execution = this.launchQueue
      .catch(() => {
        // A failed older launch must not poison the serialization queue for a distinct id.
      })
      .then(() => this.deliverLaunch(command, stdinAfterStart, readinessProbe))
    const outcome = execution.then(
      () => ({ ok: true }) as const,
      () => ({ ok: false }) as const
    )
    const entry: LaunchLedgerEntry = { fingerprint, outcome }
    // Insert before the queued work can begin. This is the exactly-once commit point.
    this.launchLedger.set(launchId, entry)
    this.launchQueue = execution.catch(() => {})
    const result = await outcome
    if (!result.ok) throw new Error('session-host launch delivery failed')
    return { status: 'executed' }
  }

  private async deliverLaunch(
    command: string,
    stdinAfterStart?: string,
    readinessProbe?: () => Promise<boolean>
  ): Promise<void> {
    await this.waitForOutputQuiet(SHELL_QUIET_CAP_MS)
    await this.deliverVerifiedCommand(command)
    if (stdinAfterStart !== undefined) {
      // Time/quiet alone is not readiness: a short-lived failed agent can already have returned to
      // the shell prompt. Require the host's process-tree probe to observe a non-shell descendant
      // before literal follow-up input is allowed anywhere near the terminal.
      if (!readinessProbe) throw new Error('session-host has no launch readiness probe')
      await this.waitForLaunchReadiness(readinessProbe)
      await this.waitForOutputQuiet(SHELL_QUIET_MS)
      if (this.exited) throw new Error('session-host terminal exited during launch delivery')
      try {
        this.privateLaunchOutput = true
        this.proc.write(stdinAfterStart)
        this.proc.write('\r')
        // Keep any asynchronous terminal echo private through one bounded settle window.
        await this.waitForOutputQuiet(SHELL_QUIET_CAP_MS)
      } catch {
        throw new Error('session-host could not deliver launch follow-up input')
      } finally {
        this.privateLaunchOutput = false
      }
    }
  }

  private async waitForLaunchReadiness(probe: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + POST_LAUNCH_READY_CAP_MS
    while (!this.exited && Date.now() < deadline) {
      try {
        if (await probe()) return
      } catch {
        // A failed read is uncertainty, never readiness. Keep polling within the fixed bound.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, LAUNCH_READINESS_POLL_MS)
        timer.unref?.()
      })
    }
    if (this.exited) throw new Error('session-host terminal exited during launch delivery')
    throw new Error('session-host could not confirm launched agent readiness')
  }

  private waitForOutputQuiet(capMs: number): Promise<void> {
    if (this.exited) return Promise.reject(new Error('session-host terminal exited during launch delivery'))
    return new Promise<void>((resolve, reject) => {
      let done = false
      let quietTimer: ReturnType<typeof setTimeout> | undefined
      let dataSub: { dispose(): void } | undefined
      let exitSub: { dispose(): void } | undefined
      const capTimer = setTimeout(() => finish(), capMs)
      capTimer.unref?.()
      const cleanup = (): void => {
        clearTimeout(capTimer)
        if (quietTimer) clearTimeout(quietTimer)
        dataSub?.dispose()
        exitSub?.dispose()
      }
      const finish = (error?: Error): void => {
        if (done) return
        done = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      dataSub = this.proc.onData(() => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => finish(), SHELL_QUIET_MS)
        quietTimer.unref?.()
      })
      exitSub = this.proc.onExit(() =>
        finish(new Error('session-host terminal exited during launch delivery'))
      )
    })
  }

  private deliverVerifiedCommand(command: string): Promise<void> {
    if (this.exited) return Promise.reject(new Error('session-host terminal exited during launch delivery'))
    return new Promise<void>((resolve, reject) => {
      this.privateLaunchOutput = true
      let done = false
      let attempt = 0
      let echoed = ''
      // The head is STICKY, because `echoed` below is a bounded window. A tail match is safe under
      // that truncation by construction — the tail is what the window keeps — but a head is not:
      // once a window's worth of bytes has arrived after it, the head is evicted and the two
      // substrings need never coexist in the buffer even though both were genuinely echoed. This
      // leg REFUSES on exhausted retries rather than failing open, so an evicted head would not
      // merely retry, it would stop the node from starting.
      let sawHead = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let dataSub: { dispose(): void } | undefined
      let exitSub: { dispose(): void } | undefined
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        dataSub?.dispose()
        exitSub?.dispose()
      }
      const finish = (error?: Error): void => {
        if (done) return
        done = true
        this.privateLaunchOutput = false
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const write = (data: string): boolean => {
        try {
          this.proc.write(data)
          return true
        } catch {
          finish(new Error('session-host could not deliver launch input'))
          return false
        }
      }
      const submit = (): void => {
        if (!write('\r')) return
        finish()
      }
      const tryOnce = (): void => {
        if (done) return
        attempt++
        echoed = ''
        sawHead = false
        timer = setTimeout(() => {
          if (done) return
          if (attempt >= DELIVERY_ATTEMPTS) {
            // Never submit an unverified/mangled command. Clear it so the terminal remains
            // recoverable, cache the fixed failure, and let explicit user action decide next.
            write(this.killLineSequence)
            finish(new Error('session-host could not verify launch command delivery'))
            return
          }
          if (!write(this.killLineSequence)) return
          tryOnce()
        }, VERIFY_TIMEOUT_MS)
        timer.unref?.()
        write(command)
      }
      dataSub = this.proc.onData((chunk) => {
        if (done) return
        // BOTH ends, not just the tail — see echoedIntact in the renderer's command-delivery for
        // why a tail match let a head-truncated command through (#556), and why requiring the
        // whole command contiguously would be too strict on this leg in particular: the retry
        // exhaustion below REFUSES the launch rather than failing open.
        const merged = echoed + cleanEcho(chunk)
        // Tested BEFORE the window is trimmed, so a head that arrived in an earlier chunk still
        // counts once it has scrolled out. Same memory bound as before.
        sawHead ||= merged.includes(command.slice(0, ECHO_EDGE_CHARS))
        echoed = merged.slice(-Math.max(command.length + 256, 512))
        if (sawHead && echoed.includes(command.slice(-ECHO_EDGE_CHARS))) submit()
      })
      exitSub = this.proc.onExit(() =>
        finish(new Error('session-host terminal exited during launch delivery'))
      )
      tryOnce()
    })
  }

  /** Release node-pty's Windows ConPTY handle after the independently verified `/T /F` process
   * tree termination. `WindowsTerminal.kill()` cannot be used here: node-pty defers that public
   * method until the first output byte, so a valid silent process would keep its host-parented
   * conhost alive forever. The internal agent call is the narrow upstream-compatible primitive
   * that closes the ConPTY handle; the host still waits for this pty's real `onExit` before ack. */
  releaseWindowsPtyAfterExternalTreeKill(): void {
    if (process.platform !== 'win32') {
      throw new Error('external ConPTY release is Windows-only')
    }
    const internal = this.proc as unknown as {
      _close?: () => void
      _agent?: { kill?: () => void }
    }
    if (typeof internal._close !== 'function' || typeof internal._agent?.kill !== 'function') {
      throw new Error('installed node-pty does not expose the required ConPTY release primitive')
    }
    internal._close()
    internal._agent.kill()
  }

  private async restoreAttachment(
    socket: Socket,
    previous: AttachmentState,
    epoch: number
  ): Promise<void> {
    if (this.attachmentEpochs.get(socket) !== epoch) return
    const wasPaused = this.hasPauseOwner()
    if (previous.explicitPaused) this.explicitPauseOwners.add(socket)
    else this.explicitPauseOwners.delete(socket)
    if (previous.subscribed) this.subscribers.add(socket)
    else this.subscribers.delete(socket)
    this.reconcileProcFlow(wasPaused)

    if (previous.geometry) this.geometryClaims.set(socket, previous.geometry)
    else this.geometryClaims.delete(socket)
    await this.applyEffectiveGeometry()
  }

  private setGeometryClaim(socket: Socket, cols: number, rows: number): Promise<void> {
    this.geometryClaims.set(socket, normalizedGeometry(cols, rows))
    return this.applyEffectiveGeometry()
  }

  private applyEffectiveGeometry(): Promise<void> {
    const requested = this.effectiveGeometry()
    const key = requested ? `${requested.cols}x${requested.rows}` : 'unclaimed'
    if (this.pendingGeometry?.key === key) return this.pendingGeometry.promise
    // Recompute inside the serialized emulator tail, not when the request arrives. Concurrent
    // resize/detach calls can change the claim ledger while an earlier xterm write is pending; a
    // captured target would land stale after the newer operation. `appliedGeometry` advances only
    // after both real actuators succeed, so identical waiters share a real failure and a later
    // exact retry cannot false-no-op on a marker that never reached the terminal.
    const reconciled = this.outputTail.then(() => {
      const target = this.effectiveGeometry()
      if (!target) return
      if (
        target.cols === this.appliedGeometry.cols &&
        target.rows === this.appliedGeometry.rows
      ) {
        return
      }
      this.proc.resize(target.cols, target.rows)
      this.term.resize(target.cols, target.rows)
      this.appliedGeometry = target
    })
    const pending = { key, promise: reconciled }
    this.pendingGeometry = pending
    void reconciled.then(
      () => {
        if (this.pendingGeometry === pending) this.pendingGeometry = null
      },
      () => {
        if (this.pendingGeometry === pending) this.pendingGeometry = null
      }
    )
    this.outputTail = reconciled.catch(() => {})
    return reconciled
  }

  private effectiveGeometry(): Geometry | null {
    if (this.geometryClaims.size === 0) return null
    let cols = Number.MAX_SAFE_INTEGER
    let rows = Number.MAX_SAFE_INTEGER
    for (const claim of this.geometryClaims.values()) {
      cols = Math.min(cols, claim.cols)
      rows = Math.min(rows, claim.rows)
    }
    return { cols, rows }
  }

  private hasPauseOwner(): boolean {
    return (
      this.emulatorPauseOwner ||
      this.explicitPauseOwners.size > 0 ||
      this.transportPauseOwners.size > 0
    )
  }

  private setSocketPauseOwner(owners: Set<Socket>, socket: Socket, held: boolean): void {
    const wasPaused = this.hasPauseOwner()
    if (held) owners.add(socket)
    else owners.delete(socket)
    this.reconcileProcFlow(wasPaused)
  }

  private setEmulatorPause(held: boolean): void {
    const wasPaused = this.hasPauseOwner()
    this.emulatorPauseOwner = held
    this.reconcileProcFlow(wasPaused)
  }

  private reconcileProcFlow(wasPaused: boolean): void {
    const isPaused = this.hasPauseOwner()
    if (wasPaused === isPaused) return
    try {
      if (isPaused) this.proc.pause()
      else this.proc.resume()
    } catch {
      /* pty may have exited between the session lookup and the actuator call */
    }
  }
}

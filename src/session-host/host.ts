// The standalone session-host process: a plain Node entry point (NOT Electron-dependent — it is
// launched with ELECTRON_RUN_AS_NODE=1 when process.execPath is the Electron binary, see
// src/core/session-host-launcher.ts) that owns PTYs and outlives the app that spawned it. This is
// the Windows-and-anywhere-tmux-is-missing analogue of a tmux server.
//
// Bundled by esbuild (`npm run host:build`) to out/session-host/host.cjs, mirroring the existing
// `server:build` script's shape — node-pty stays external (native module). See
// docs/windows-session-host.md for the full architecture, lifetime rules, protocol and the
// warm-attach seeding trap this file's `handleAttach` exists to avoid.
//
// Invocation: `node host.cjs <userDataDir>`. Everything the host needs — where to bind, where to
// write its token/state — is DERIVED from userDataDir alone (see paths.ts); nothing else is ever
// passed on argv, so nothing sensitive ever appears in this process's command line.

import fs from 'fs'
import net from 'net'
import { hostMessagePane } from './message-pane'
import path from 'path'
import crypto from 'crypto'
import { sessionHostPaths, currentProtocolVersion, type SessionHostState } from './paths'
import {
  LineFramer,
  encodeFrame,
  type SessionHostRequest,
  type SessionHostFrame,
  type AttachResult,
  type HelloResult,
  SESSION_HOST_FEATURES,
  type HasSessionResult,
  type PaneCommandResult,
  type CaptureResult,
  type KillSessionResult,
  type ListSessionsResult
} from './protocol'
import { HostSession } from './session'
import { sendTextWhenSettled } from '../core/settled-text'
import { paneCommand as readPaneCommand } from './process-tree'
import { terminateWindowsProcessTree } from './windows-process-tree'
import { publishSessionHostState } from './state-file'
import {
  EMPTY_LOCK_STALE_MS,
  LISTEN_RETRY_BUDGET_MS,
  LISTEN_RETRY_MAX_DELAY_MS,
  readExistingSessionHostIdentity,
  startupLockState
} from './existing-host-state'
import {
  RETRY_SESSION_GENERATION,
  SessionGenerationCoordinator,
  retireSessionGeneration
} from './generation-barrier'
import { drainSessionHostTransport, writeSessionHostFrame } from './socket-flow'
import { SessionHostSocketRequestQueue } from './socket-request-queue'
import { trySessionHostHello } from './hello-probe'
import { killHostSession } from './kill-session'

/** How long a session-less host lingers before exiting — mirrors tmux's own server lifetime rule
 *  ("the server exits when its last session dies"), plus a grace window so an app restart that
 *  briefly drops to zero sessions (closing every node, or a launcher racing a real create) does
 *  not tear down a host that is about to be handed a fresh session moments later. */
const GRACE_EXIT_MS = 30_000

/** Constant-time bearer-token comparison. The token is 256 bits of hex, so a timing side-channel
 *  over noisy local IPC is not practically exploitable — but the check is trivial to get right,
 *  and a non-string `req.token` (a hostile client can send any JSON) must compare false without
 *  throwing. Unequal lengths short-circuit false; equal lengths go through `timingSafeEqual`. */
function tokenMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const COMPLETED_KILL_TTL_MS = 10 * 60_000
const MAX_COMPLETED_KILLS = 1_024
const REPLACEMENT_RESERVATION_TTL_MS = 30_000

/** Bounded log file — this is a headless daemon with `stdio: 'ignore'`, so this is the only way
 *  to see what it did after the fact. Best-effort: a failure to write here must never affect a
 *  session. Capped by truncating rather than rotating — simplicity over completeness for a file
 *  nobody reads except when diagnosing a report. */
let logPath = ''
const LOG_CAP_BYTES = 512 * 1024
function log(line: string): void {
  if (!logPath) return
  try {
    // Stat directly and treat "not there" as size 0 — an existsSync-then-statSync pair is both a
    // TOCTOU race and redundant here. Diagnostics only, single daemon process, so a truncation that
    // races an append at worst drops a log line.
    let size = 0
    try {
      size = fs.statSync(logPath).size
    } catch {
      /* no log file yet — size stays 0 */
    }
    if (size > LOG_CAP_BYTES) fs.writeFileSync(logPath, '')
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* diagnostics only */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll for a WINNER of the startup race to finish writing its state file and come up — the state
 *  file can legitimately exist-but-be-incomplete for a brief window between this process losing
 *  the exclusive-create race and the winner actually binding + writing token + state. */
async function probeExisting(
  statePath: string,
  expectedEndpoint: string,
  expectedTokenPath: string
): Promise<boolean> {
  let lastFailure: unknown = null
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const identity = readExistingSessionHostIdentity(statePath, {
        expectedEndpoint,
        expectedTokenPath
      })
      // ENOENT is the only observation that can prove absence. It also supersedes an earlier
      // partial-publication read failure: the final bounded observation is what owns reclaim.
      lastFailure = null
      if (
        identity.kind === 'ready' &&
        (await trySessionHostHello(identity.state.endpoint, identity.token, 1000))
      ) {
        return true
      }
    } catch (error) {
      // A winner can be between exclusive-create and atomic publication, so retry within the
      // existing bound. If the final observation is still unreadable/invalid, propagate it: that
      // is evidence of possible ownership, never permission to unlink and steal the state path.
      lastFailure = error
    }
    await sleep(150)
  }
  if (lastFailure) throw lastFailure
  return false
}

async function main(): Promise<void> {
  const userDataDir = process.argv[2]
  if (!userDataDir) {
    process.stderr.write('session-host: missing userDataDir argument\n')
    process.exit(1)
  }
  const paths = sessionHostPaths(userDataDir)
  logPath = path.join(userDataDir, 'session-host.log')
  log(`starting pid=${process.pid} endpoint=${paths.endpoint}`)

  // 1) Exclusive-create race gate. Two app instances launched at once will both spawn a host;
  // exactly one of them may proceed past this point on the first try.
  let haveLock = false
  try {
    fs.closeSync(fs.openSync(paths.statePath, 'wx'))
    haveLock = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      log(`fatal: could not create state file: ${String(e)}`)
      process.exit(1)
    }
  }
  if (!haveLock) {
    let alive: boolean
    try {
      alive = await probeExisting(paths.statePath, paths.endpoint, paths.tokenPath)
    } catch (error) {
      // An EMPTY lock is the one unreadable state with a second, independent witness: a live
      // starter heartbeats it (see startupLockState). One that has stopped moving belonged to a
      // process that died between the exclusive create and publication — before issue #783 that
      // deadlocked every later launch, since the fail-closed reader can only ever say "unreadable"
      // about it. Anything else unreadable still refuses, as it must.
      if (startupLockState(paths.statePath) !== 'abandoned') {
        log(`fatal: existing host ownership state is unreadable: ${String(error)}`)
        process.exit(1)
        return
      }
      log(`abandoned empty startup lock (untouched for >${EMPTY_LOCK_STALE_MS}ms) — reclaiming`)
      alive = false
    }
    if (alive) {
      log('another host is already running and answered hello — exiting quietly')
      process.exit(0)
    }
    // Stale lock: a previous host crashed before cleaning up, or lost the race and left a
    // half-written file. Steal it — we already waited out the whole probe window above.
    log('stale state file with no live host behind it — reclaiming')
    try {
      fs.unlinkSync(paths.statePath)
    } catch {
      /* already gone */
    }
    try {
      fs.closeSync(fs.openSync(paths.statePath, 'wx'))
    } catch (e) {
      log(`fatal: could not reclaim state file: ${String(e)}`)
      process.exit(1)
    }
  }

  // POSIX: a stale socket FILE left by an unclean shutdown makes bind() fail EADDRINUSE even
  // though nothing is listening. Safe to clear now — we hold the state-file lock, so nothing
  // legitimate can be bound here without having just re-won that same lock.
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(paths.endpoint)
    } catch {
      /* nothing to remove */
    }
  }

  const sessions = new Map<string, HostSession>()
  type EndingOperation = {
    session: HostSession
    promise: Promise<KillSessionResult>
    resolve: (result: KillSessionResult) => void
    reject: (error: Error) => void
    operationIds: Set<string>
    reserveReplacement: boolean
    expectedGeneration?: string
  }
  const ending = new Map<string, EndingOperation>()
  const inProgressKillIds = new Map<string, { name: string; operation: EndingOperation }>()
  const completedKillIds = new Map<
    string,
    {
      name: string
      completedAt: number
      reserveReplacement: boolean
      expectedGeneration?: string
    }
  >()
  const replacementReservations = new Map<
    string,
    { token: string; expiresAt: number }
  >()
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  function pruneCompletedKills(now = Date.now()): void {
    for (const [operationId, entry] of completedKillIds) {
      if (now - entry.completedAt <= COMPLETED_KILL_TTL_MS) continue
      completedKillIds.delete(operationId)
    }
    while (completedKillIds.size > MAX_COMPLETED_KILLS) {
      const oldest = completedKillIds.keys().next().value as string | undefined
      if (!oldest) break
      completedKillIds.delete(oldest)
    }
  }

  function rememberCompletedKill(
    operationId: string,
    name: string,
    reserveReplacement: boolean,
    expectedGeneration?: string
  ): void {
    completedKillIds.delete(operationId)
    completedKillIds.set(operationId, {
      name,
      completedAt: Date.now(),
      reserveReplacement,
      expectedGeneration
    })
    pruneCompletedKills()
  }

  function validateKillOperationId(operationId: string): void {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) {
      throw new Error('invalid kill operation id')
    }
  }

  function activeReplacementReservation(
    name: string
  ): { token: string; expiresAt: number } | undefined {
    const reservation = replacementReservations.get(name)
    if (reservation && reservation.expiresAt <= Date.now()) {
      replacementReservations.delete(name)
      return undefined
    }
    return reservation
  }

  function setReplacementReservation(name: string, token: string): void {
    replacementReservations.set(name, {
      token,
      expiresAt: Date.now() + REPLACEMENT_RESERVATION_TTL_MS
    })
    // A zero-session host is now carrying a live cross-client replacement lease. Restart its
    // grace window so it cannot exit underneath the owner before the equally-bounded lease does.
    cancelGraceExit()
    scheduleGraceExitIfEmpty()
  }

  function cancelGraceExit(): void {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }
  function scheduleGraceExitIfEmpty(): void {
    if (sessions.size > 0) return
    cancelGraceExit()
    graceTimer = setTimeout(() => {
      if (sessions.size > 0) return
      log('no sessions left — exiting')
      cleanupFiles()
      process.exit(0)
    }, GRACE_EXIT_MS)
    graceTimer.unref?.()
  }
  function cleanupFiles(): void {
    for (const p of [paths.statePath, paths.tokenPath]) {
      try {
        fs.unlinkSync(p)
      } catch {
        /* best-effort */
      }
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(paths.endpoint)
      } catch {
        /* best-effort */
      }
    }
  }
  const generationCoordinator = new SessionGenerationCoordinator(sessions, cancelGraceExit)

  /** Connections that negotiated the `geometry` feature at hello. Only these may ever receive a
   *  `geometry` push: an older client reads any non-`data` push frame as an exit (issue #914). */
  const geometrySockets = new WeakSet<net.Socket>()

  /** Tell every geometry-aware subscriber the size the pty now actually runs at. */
  function publishGeometry(session: HostSession, geometry: { cols: number; rows: number }): void {
    const line = encodeFrame({
      type: 'geometry',
      name: session.name,
      cols: geometry.cols,
      rows: geometry.rows,
      generation: session.generation
    } satisfies SessionHostFrame)
    for (const sub of session.subscribers) {
      if (geometrySockets.has(sub)) writeSessionHostFrame(sub, line, sessions.values())
    }
  }

  /** The attach reply, plus the pty's current size for a geometry-aware connection — the answer
   *  that `geometry` pushes then keep current. */
  function withGeometry(name: string, socket: net.Socket, result: AttachResult): AttachResult {
    if (!geometrySockets.has(socket)) return result
    const session = sessions.get(name)
    if (!session || session.exited) return result
    return { ...result, geometry: session.geometry }
  }

  /** A v2 hello's reply. Features are the intersection of what the client asked for and what this
   *  host speaks; a client that asked for nothing gets nothing and is never sent a frame it did not
   *  opt into. Only a v2 connection reaches here — a v1 hello's reply carries no result at all. */
  function negotiateHello(req: SessionHostRequest, socket: net.Socket): HelloResult {
    const requested = (req as { features?: unknown }).features
    const features = Array.isArray(requested)
      ? SESSION_HOST_FEATURES.filter((feature) => requested.includes(feature))
      : []
    if (features.includes('geometry')) geometrySockets.add(socket)
    return features.length > 0
      ? { protocolVersion: currentProtocolVersion(), features }
      : { protocolVersion: currentProtocolVersion() }
  }

  function broadcast(session: HostSession, frame: SessionHostFrame): void {
    const line = encodeFrame(frame)
    for (const sub of session.subscribers) {
      writeSessionHostFrame(sub, line, sessions.values())
    }
  }

  /** Publish and remove a generation only after node-pty has authoritatively observed process
   * exit. A successful `proc.kill()` call merely dispatched a signal and cannot enter here. */
  async function publishSessionEnd(session: HostSession, exitCode: number): Promise<void> {
    const kill = ending.get(session.name)
    const ownedKill = kill?.session === session ? kill : undefined
    const ownerToken = ownedKill?.operationIds.values().next().value as string | undefined
    const killResult: KillSessionResult | undefined = ownedKill
      ? { replacementToken: ownedKill.reserveReplacement ? ownerToken : undefined }
      : undefined
    const released = await retireSessionGeneration(
      sessions,
      session.name,
      session,
      async () => {
        await session.settleOutput()
        if (ownerToken && ownedKill?.reserveReplacement) {
          // The reservation is the confirmed-replacement commit. Publish the generation exit only
          // after it exists so a lost correlated reply can reclaim the same operation id safely.
          // Start its bounded TTL after the output drain, not while teardown is still pending.
          setReplacementReservation(session.name, ownerToken)
        }
        broadcast(session, {
          type: 'exit',
          name: session.name,
          exitCode,
          generation: session.generation
        })
        session.dispose()
      }
    )
    if (released) scheduleGraceExitIfEmpty()
    log(`session ended name=${session.name} exitCode=${exitCode}`)
    if (ownedKill && killResult) {
      if (ending.get(session.name) === ownedKill) ending.delete(session.name)
      for (const operationId of ownedKill.operationIds) {
        rememberCompletedKill(
          operationId,
          session.name,
          ownedKill.reserveReplacement,
          ownedKill.expectedGeneration
        )
        inProgressKillIds.delete(operationId)
      }
      ownedKill.resolve(killResult)
    }
  }

  function endSession(session: HostSession, exitCode: number): Promise<void> {
    if (session.ending) return session.ending
    session.retiring = true
    session.ending = publishSessionEnd(session, exitCode)
    return session.ending
  }

  /** Claim the name immediately after a kill signal succeeds, then wait for onExit. The generation
   * coordinator sees `retiring` and blocks same-name attach until the real exit frame, output drain
   * and disposal have all completed. */
  function beginKillRetirement(session: HostSession): Promise<void> {
    if (session.ending) return session.ending
    session.retiring = true
    session.ending = (async () => {
      const exitCode = await session.waitForProcessExit()
      await publishSessionEnd(session, exitCode)
    })()
    return session.ending
  }

  function wireSession(session: HostSession): void {
    session.onGeometryApplied = (geometry) => publishGeometry(session, geometry)
    session.proc.onData((data) => {
      // node-pty may flush a queued data callback after its exit callback. Once endSession has
      // disposed the emulator and broadcast exit, no data may touch or appear after that boundary.
      if (session.exited) return
      // Trusted launch input is typed through the same ConPTY and therefore echoed by the shell.
      // While HostSession verifies that echo, keep the entire chunk out of both renderer push
      // frames and the reconstructable screen so executable/argv/prompt material stays core-only.
      if (session.suppressingPrivateLaunchOutput) return
      void session.recordOutput(data).then(
        () =>
          broadcast(session, {
            type: 'data',
            name: session.name,
            data,
            generation: session.generation
          }),
        (e) => {
          // Delivery is still preferable to silently losing real PTY bytes if the screen mirror
          // itself ever rejects. The queue recovers for later writes; a capture may omit this one.
          log(`terminal mirror write failed name=${session.name}: ${String(e)}`)
          broadcast(session, {
            type: 'data',
            name: session.name,
            data,
            generation: session.generation
          })
        }
      )
    })
    session.proc.onExit(({ exitCode }) => {
      session.observeProcessExit(exitCode)
      void endSession(session, exitCode)
    })
  }

  async function launchProcessReady(session: HostSession): Promise<boolean> {
    const command = await readPaneCommand(session.proc.pid)
    if (!command) return false
    const liveName = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
    return Boolean(liveName && liveName !== session.shellExecutableName)
  }

  async function handleAttach(
    req: Extract<SessionHostRequest, { cmd: 'attach' }>,
    socket: net.Socket
  ): Promise<AttachResult> {
    return generationCoordinator.run<AttachResult>(req.name, async (existing) => {
      if (ending.has(req.name)) {
        throw new Error(`session '${req.name}' is ending and cannot be attached`)
      }
      if (existing && !existing.exited) {
        if (req.replacementToken) {
          if (existing.createdByReplacementToken !== req.replacementToken) {
            throw new Error(
              `reserved replacement '${req.name}' cannot attach a different live generation`
            )
          }
          if (!existing.matchesReplacementReplay(req.spawn, req.scrollback)) {
            throw new Error(
              `reserved replacement '${req.name}' replay changed its trusted launch plan`
            )
          }
        }
        // Restore this connection's flow + geometry before taking the screen. A reconnect carrying
        // `paused` must never receive bytes in the gap before its explicit ticket is reasserted.
        // Live delivery still starts only AFTER the barrier+snapshot, so a pending chunk cannot be
        // delivered to this socket and then appear again in the warm screen.
        const attachment = await existing.prepareAttachment(
          socket,
          req.spawn.cols,
          req.spawn.rows,
          req.paused === true
        )
        try {
          const screen = await existing.serialize()
          if (!attachment.isCurrent()) {
            await attachment.rollback()
            throw new Error('attach cancelled before activation')
          }
          // The process can exit while the async emulator drains. Retain this name claim and cross
          // its retirement barrier again; recursive attach would deadlock or race another waiter.
          if (existing.exited || sessions.get(req.name) !== existing) {
            await attachment.rollback()
            if (!attachment.isCurrent()) throw new Error('attach cancelled during retry')
            return RETRY_SESSION_GENERATION
          }
          if (!attachment.commit()) throw new Error('attach cancelled before activation')
          const initialLaunch = req.replacementToken
            ? await existing.executeInitialLaunch(req.spawn, () => launchProcessReady(existing))
            : undefined
          log(`attach (warm) name=${req.name} subscribers=${existing.subscribers.size}`)
          return {
            // A replay of the same consumed replacement token replays the original cold result;
            // this is not an ordinary warm attach even though the generation now exists.
            fresh: Boolean(req.replacementToken),
            screen: screen || undefined,
            generation: existing.generation,
            launchDialect: existing.launchDialect,
            initialLaunchStatus: initialLaunch?.status
          }
        } catch (error) {
          await attachment.rollback()
          throw error
        }
      }

      const reservation = activeReplacementReservation(req.name)
      if (reservation && req.replacementToken !== reservation.token) {
        scheduleGraceExitIfEmpty()
        throw new Error(`session '${req.name}' is reserved for confirmed replacement`)
      }
      if (!reservation && req.replacementToken) {
        scheduleGraceExitIfEmpty()
        throw new Error(`replacement reservation for session '${req.name}' is no longer valid`)
      }
      // Consume before construction: a resolver/spawn failure releases the name for recovery.
      if (reservation) replacementReservations.delete(req.name)
      let session: HostSession
      try {
        session = new HostSession(req.name, req.spawn, req.scrollback, reservation?.token)
      } catch (error) {
        scheduleGraceExitIfEmpty()
        log(`spawn failed name=${req.name} category=profile-start-failed detail=${String(error)}`)
        // Executable, argv, cwd and native process details are trusted-core/private state. The wire
        // carries only a stable actionable category; full diagnostics stay in the host-local log.
        throw new Error('session-host could not start the requested terminal profile')
      }
      // prepareAttachment books `paused` synchronously before its first await. Do that before the
      // process is wired for output so a reconnect cannot leak initial bytes before the ticket.
      const preparing = session.prepareAttachment(
        socket,
        req.spawn.cols,
        req.spawn.rows,
        req.paused === true
      )
      sessions.set(req.name, session)
      wireSession(session)
      try {
        const attachment = await preparing
        if (
          session.exited ||
          sessions.get(req.name) !== session ||
          !attachment.isCurrent() ||
          !attachment.commit()
        ) {
          await attachment.rollback()
          throw new Error('attach cancelled before activation')
        }
      } catch (error) {
        if (session.exited) {
          await session.ending
        } else if (sessions.get(req.name) === session) {
          await killHostSession(session, beginKillRetirement)
        }
        throw error
      }
      log(`attach (cold) name=${req.name} pid=${session.proc.pid}`)
      const initialLaunch = await session.executeInitialLaunch(req.spawn, () =>
        launchProcessReady(session)
      )
      return {
        fresh: true,
        generation: session.generation,
        launchDialect: session.launchDialect,
        initialLaunchStatus: initialLaunch?.status
      }
    })
  }

  async function handleAttachExisting(
    req: Extract<SessionHostRequest, { cmd: 'attachExisting' }>,
    socket: net.Socket
  ): Promise<AttachResult> {
    return generationCoordinator.run<AttachResult>(req.name, async (existing) => {
      if (ending.has(req.name)) {
        throw new Error(`session '${req.name}' is ending and cannot be attached`)
      }
      if (!existing || existing.exited) {
        scheduleGraceExitIfEmpty()
        throw new Error(`no existing session '${req.name}'`)
      }
      if (req.expectedGeneration && req.expectedGeneration !== existing.generation) {
        throw new Error(`session '${req.name}' was replaced by a different generation`)
      }
      const attachment = await existing.prepareExistingAttachment(
        socket,
        req.paused === true,
        req.cols,
        req.rows
      )
      try {
        const screen = await existing.serialize()
        if (!attachment.isCurrent()) {
          await attachment.rollback()
          throw new Error('attachExisting cancelled before activation')
        }
        if (existing.exited || sessions.get(req.name) !== existing) {
          await attachment.rollback()
          if (!attachment.isCurrent()) throw new Error('attachExisting cancelled during retry')
          return RETRY_SESSION_GENERATION
        }
        if (!attachment.commit()) throw new Error('attachExisting cancelled before activation')
        log(`attach-existing name=${req.name} subscribers=${existing.subscribers.size}`)
        return {
          fresh: false,
          screen: screen || undefined,
          generation: existing.generation,
          launchDialect: existing.launchDialect
        }
      } catch (error) {
        await attachment.rollback()
        throw error
      }
    })
  }

  async function handleKill(
    name: string,
    operationId: string,
    expectedGeneration: string | undefined,
    reserveReplacement: boolean
  ): Promise<KillSessionResult> {
    validateKillOperationId(operationId)
    pruneCompletedKills()
    const completed = completedKillIds.get(operationId)
    if (completed) {
      if (completed.name !== name) throw new Error('kill operation id belongs to another session')
      if (completed.reserveReplacement !== reserveReplacement) {
        throw new Error('kill operation retry changed replacement mode')
      }
      if (completed.expectedGeneration !== expectedGeneration) {
        throw new Error('kill operation retry changed expected generation')
      }
      if (!reserveReplacement) return {}
      const current = sessions.get(name)
      if (current && !current.exited) {
        throw new Error(`session '${name}' was replaced by a different generation`)
      }
      const reservation = activeReplacementReservation(name)
      if (reservation && reservation.token !== operationId) {
        throw new Error(`session '${name}' is already restarting`)
      }
      // Refresh a same-operation reservation that expired while the client was uncertain.
      setReplacementReservation(name, operationId)
      return { replacementToken: operationId }
    }
    const byId = inProgressKillIds.get(operationId)
    if (byId) {
      if (byId.name !== name) throw new Error('kill operation id belongs to another session')
      if (byId.operation.reserveReplacement !== reserveReplacement) {
        throw new Error('kill operation retry changed replacement mode')
      }
      if (byId.operation.expectedGeneration !== expectedGeneration) {
        throw new Error('kill operation retry changed expected generation')
      }
      return byId.operation.promise
    }

    const alreadyEnding = ending.get(name)
    if (alreadyEnding) {
      // Only the same operation id is a retry. A second client must not join the destructive
      // operation and then falsely believe its own id owns the single replacement reservation.
      throw new Error(`session '${name}' is already restarting`)
    }

    let session = sessions.get(name)
    if (session && (session.exited || session.retiring)) {
      // Natural exit keeps the generation registered through its output/exit publication barrier.
      // Absence is not authoritative until that exact generation has finished retiring.
      if (!session.ending) throw new Error(`ending session '${name}' has no retirement barrier`)
      await session.ending
      session = sessions.get(name)
    }
    if (!session || session.exited) {
      const reservation = activeReplacementReservation(name)
      if (reserveReplacement && reservation && reservation.token !== operationId) {
        throw new Error(`session '${name}' is already restarting`)
      }
      if (reserveReplacement) setReplacementReservation(name, operationId)
      rememberCompletedKill(operationId, name, reserveReplacement, expectedGeneration)
      return { replacementToken: reserveReplacement ? operationId : undefined }
    }
    if (expectedGeneration === undefined) {
      // In v2, undefined after the client's immediate probe is an explicit expected-absence
      // observation, not name-only permission. A later generation is outside this operation even
      // after the completed-op cache expires: generic delete confirms its observed target was
      // already absent; a requested lease rejects because another app won the name.
      if (reserveReplacement) {
        throw new Error(`session '${name}' became live before its replacement lease was acquired`)
      }
      rememberCompletedKill(operationId, name, false, undefined)
      return {}
    }
    if (expectedGeneration !== undefined && expectedGeneration !== session.generation) {
      // A different opaque generation confirms the requested process is already gone, but that
      // live replacement belongs to somebody else and must not be reserved or terminated.
      if (reserveReplacement) {
        throw new Error(`session '${name}' was replaced by a different generation`)
      }
      rememberCompletedKill(operationId, name, false, expectedGeneration)
      return {}
    }

    let resolve!: (result: KillSessionResult) => void
    let reject!: (error: Error) => void
    const promise = new Promise<KillSessionResult>((done, fail) => {
      resolve = done
      reject = fail
    })
    const operation: EndingOperation = {
      session,
      promise,
      resolve,
      reject,
      operationIds: new Set([operationId]),
      reserveReplacement,
      expectedGeneration
    }
    // Store before either termination mechanism: node-pty may emit onExit synchronously.
    ending.set(name, operation)
    inProgressKillIds.set(operationId, { name, operation })

    const failOperation = (error: unknown): void => {
      if (ending.get(name) !== operation) return // real exit already confirmed and resolved it
      ending.delete(name)
      for (const id of operation.operationIds) inProgressKillIds.delete(id)
      operation.reject(error instanceof Error ? error : new Error(String(error)))
    }

    if (process.platform === 'win32') {
      // node-pty defers WindowsTerminal.kill() until first output. taskkill owns the process tree
      // independently, then endSession acknowledges only after the PID is confirmed absent.
      void terminateWindowsProcessTree(session.proc.pid).then(
        () => {
          if (sessions.get(name) !== session || session.exited) return
          try {
            session.releaseWindowsPtyAfterExternalTreeKill()
            // No manual endSession here. Closing the ConPTY handle must produce node-pty's real
            // onExit, which is the proof that shell descendants *and* host-parented conhost are
            // gone. If it never arrives, the client times out uncertain instead of receiving a
            // false destructive acknowledgement.
            void beginKillRetirement(session).catch(failOperation)
          } catch (error) {
            log(`ConPTY release failed name=${name}: ${String(error)}`)
            failOperation(new Error('session-host could not confirm terminal process termination'))
          }
        },
        (error) => {
          log(`process-tree termination failed name=${name}: ${String(error)}`)
          failOperation(new Error('session-host could not confirm terminal process termination'))
        }
      )
    } else {
      try {
        session.proc.kill()
        void beginKillRetirement(session).catch(failOperation)
      } catch (error) {
        failOperation(error)
      }
    }
    return promise
  }

  async function dispatch(
    req: SessionHostRequest,
    socket: net.Socket,
    clientProtocolVersion: 1 | 2
  ): Promise<{ ok: true; result?: unknown } | { ok: false; error: string }> {
    switch (req.cmd) {
      case 'attach':
        return { ok: true, result: withGeometry(req.name, socket, await handleAttach(req, socket)) }
      case 'attachExisting':
        if (clientProtocolVersion === 1) {
          return { ok: false, error: 'attachExisting requires session-host protocol v2' }
        }
        return {
          ok: true,
          result: withGeometry(req.name, socket, await handleAttachExisting(req, socket))
        }
      case 'hasSession':
        {
          const session = sessions.get(req.name)
          const result: HasSessionResult =
            session && !session.exited
              ? { exists: true, generation: session.generation }
              : { exists: false }
          return {
            ok: true,
            result
          }
        }
      case 'write': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: false, error: 'no such session' }
        if (!s.subscribers.has(socket)) return { ok: false, error: 'not attached to session' }
        s.proc.write(req.data)
        return { ok: true }
      }
      case 'resize': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: false, error: 'no such session' }
        if (!s.subscribers.has(socket)) return { ok: false, error: 'not attached to session' }
        await s.resizeFor(socket, req.cols, req.rows)
        return { ok: true }
      }
      case 'pause': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: false, error: 'no such session' }
        if (!s.subscribers.has(socket)) return { ok: false, error: 'not attached to session' }
        s.pauseFor(socket)
        return { ok: true }
      }
      case 'resume': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: false, error: 'no such session' }
        if (!s.subscribers.has(socket)) return { ok: false, error: 'not attached to session' }
        s.resumeFor(socket)
        return { ok: true }
      }
      case 'sendKeys':
      case 'sendKeysV2': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: false, error: 'no such session' }
        const ok = await sendTextWhenSettled(s, req.text, req.enter, {
          current: () => !s.exited && sessions.get(req.name) === s,
          bracketed: () => s.bracketedPasteRequested(),
          capture: () => s.serialize(200),
          write: (chunk) => s.proc.write(chunk)
        })
        return ok !== false ? { ok: true, result: { delivery: ok } } : { ok: false, error: 'session unavailable or delivery busy' }
      }
      case 'paneCommand': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: true, result: { command: null } satisfies PaneCommandResult }
        const command = await readPaneCommand(s.proc.pid)
        return { ok: true, result: { command } satisfies PaneCommandResult }
      }
      case 'messageOwnerV1':
        return { ok: true, result: await hostMessagePane(() => sessions.get(req.name)).owner() }
      case 'messagePasteReadyV1':
        return { ok: true, result: await hostMessagePane(() => sessions.get(req.name)).pasteReady() }
      case 'messageEnvelopeV1':
        return {
          ok: true,
          result: await hostMessagePane(() => sessions.get(req.name)).send(req.envelope, req.expected)
        }
      case 'capture': {
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: true, result: { text: '' } satisfies CaptureResult }
        const text = await s.serialize(req.full ? undefined : 200)
        if (s.exited || sessions.get(req.name) !== s) {
          return { ok: true, result: { text: '' } satisfies CaptureResult }
        }
        return { ok: true, result: { text } satisfies CaptureResult }
      }
      case 'executeLaunch': {
        if (clientProtocolVersion === 1) {
          return { ok: false, error: 'opaque launch requires session-host protocol v2' }
        }
        const s = sessions.get(req.name)
        if (!s || s.exited) return { ok: false, error: 'no such session' }
        if (req.generation !== s.generation) {
          return { ok: false, error: `session '${req.name}' was replaced by another generation` }
        }
        const result = await s.executeLaunch(
          req.launchId,
          req.command,
          req.stdinAfterStart,
          () => launchProcessReady(s)
        )
        return { ok: true, result }
      }
      case 'killSession': {
        // Do not acknowledge merely because kill() was requested. The per-name promise resolves
        // only when the real node-pty onExit path has removed/disposed the generation. A retry on
        // another socket coalesces here, and a retry after completion sees absence as success.
        const raw = req as Extract<SessionHostRequest, { cmd: 'killSession' }> & {
          operationId?: unknown
          expectedGeneration?: unknown
          reserveReplacement?: unknown
        }
        if (clientProtocolVersion === 1 && raw.reserveReplacement === true) {
          return { ok: false, error: 'replacement reservation requires session-host protocol v2' }
        }
        const operationId =
          clientProtocolVersion === 2 && typeof raw.operationId === 'string'
            ? raw.operationId
            : crypto.randomUUID()
        const expectedGeneration =
          clientProtocolVersion === 2 && typeof raw.expectedGeneration === 'string'
            ? raw.expectedGeneration
            : sessions.get(req.name)?.generation
        const reserveReplacement =
          clientProtocolVersion === 2 && raw.reserveReplacement === true
        const result = await handleKill(
          req.name,
          operationId,
          expectedGeneration,
          reserveReplacement
        )
        return { ok: true, result }
      }
      case 'detach': {
        await sessions.get(req.name)?.detach(socket)
        return { ok: true }
      }
      case 'listSessions':
        return { ok: true, result: { names: [...sessions.keys()] } satisfies ListSessionsResult }
      case 'ping':
        return { ok: true }
      default:
        return { ok: false, error: `unknown command` }
    }
  }

  const liveSockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    liveSockets.add(socket)
    let authed = false
    let clientProtocolVersion: 1 | 2 | null = null
    const framer = new LineFramer()
    const requestQueue = new SessionHostSocketRequestQueue()
    const dispatchAndRespond = async (req: SessionHostRequest): Promise<void> => {
      if (socket.destroyed) return
      try {
        const res = await dispatch(req, socket, clientProtocolVersion ?? 1)
        writeSessionHostFrame(
          socket,
          encodeFrame({ id: req.id, ...res }),
          sessions.values()
        )
      } catch (e) {
        writeSessionHostFrame(
          socket,
          encodeFrame({
            id: req.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e)
          }),
          sessions.values()
        )
      }
    }
    socket.on('data', (chunk: Buffer) => {
      let frames: SessionHostRequest[]
      try {
        frames = framer.push<SessionHostRequest>(chunk.toString('utf8'))
      } catch {
        // A single line past MAX_FRAME_BYTES with no terminator: a hostile or broken peer, pre- or
        // post-auth. Drop the connection rather than keep buffering it.
        socket.destroy()
        return
      }
      for (const req of frames) {
        if (!authed) {
          const requestedVersion =
            req.cmd === 'hello'
              ? (req as { protocolVersion?: unknown }).protocolVersion
              : undefined
          if (
            req.cmd === 'hello' &&
            tokenMatches(req.token, token) &&
            (requestedVersion === undefined ||
              requestedVersion === 1 ||
              requestedVersion === currentProtocolVersion())
          ) {
            authed = true
            clientProtocolVersion =
              requestedVersion === undefined || requestedVersion === 1 ? 1 : 2
            writeSessionHostFrame(
              socket,
              encodeFrame(
                clientProtocolVersion === 1
                  ? { id: req.id, ok: true }
                  : { id: req.id, ok: true, result: negotiateHello(req, socket) }
              ),
              sessions.values()
            )
          } else {
            const error =
              req.cmd === 'hello' && tokenMatches(req.token, token)
                ? `incompatible session-host protocol: expected ${currentProtocolVersion()}`
                : 'unauthorized'
            writeSessionHostFrame(
              socket,
              encodeFrame({ id: req.id, ok: false, error }),
              sessions.values()
            )
            socket.destroy()
          }
          continue
        }
        if (req.cmd === 'hello') {
          writeSessionHostFrame(
            socket,
            encodeFrame(
              clientProtocolVersion === 1
                ? { id: req.id, ok: true }
                : { id: req.id, ok: true, result: negotiateHello(req, socket) }
            ),
            sessions.values()
          )
          continue
        }
        // A JSON primitive/null that parsed cleanly (e.g. `5`) is not a request: `'name' in req`
        // would throw `TypeError` here — post-auth, inside the data handler, caught only by the
        // process-level logger, silently dropping the rest of this chunk's frames. Skip it.
        if (typeof req !== 'object' || req === null) continue
        if ('name' in req) void requestQueue.enqueue(req.name, () => dispatchAndRespond(req))
        else void dispatchAndRespond(req)
      }
    })
    socket.on('drain', () => drainSessionHostTransport(socket, sessions.values()))
    socket.on('close', () => {
      liveSockets.delete(socket)
      // A connection dropping is a DETACH, never a kill — sessions belong to the host, not to
      // any one connection. Mirrors tmux: closing a client's terminal only ends that client.
      // `detach` also returns this socket's pause ticket; without that second half, a crashed
      // viewer can leave the global node-pty actuator paused forever for every healthy viewer.
      for (const session of sessions.values()) {
        void session.detach(socket).catch((e) =>
          log(`detach cleanup failed name=${session.name}: ${String(e)}`)
        )
      }
    })
    socket.on('error', () => {
      /* the 'close' handler above still runs and does the real cleanup */
    })
  })

  let abortingStartup = false
  function abortListeningStartup(reason: string, error: unknown): void {
    if (abortingStartup) return
    abortingStartup = true
    log(`fatal: ${reason}: ${String(error)}`)
    // `listen` has already succeeded when token/state publication runs. Stop accepting first and
    // destroy anything that reached the tiny pre-publication window, then remove every artifact
    // owned behind our exclusive startup lock. The uncaughtException logger below deliberately
    // keeps the process alive, so startup failures must terminate through this explicit path.
    for (const socket of liveSockets) socket.destroy()
    const finish = (): void => {
      cleanupFiles()
      process.exit(1)
    }
    try {
      server.close(finish)
    } catch {
      finish()
    }
  }

  // EADDRINUSE retry state. The endpoint can stay busy for a while after its owner dies — issue
  // #783 measured ~1.5 minutes on a Windows named pipe — so we WAIT for it instead of giving up.
  const listenDeadline = Date.now() + LISTEN_RETRY_BUDGET_MS
  let listenDelay = 250
  let lastRetryLogAt = 0

  /** Keep the empty startup lock's mtime moving, so other launches can tell this retry apart from
   *  a host that died mid-startup (startupLockState). Best effort: a lock a scanner holds open for
   *  a moment is not a reason to abandon the retry. */
  function touchStartupLock(): void {
    try {
      const now = new Date()
      fs.utimesSync(paths.statePath, now, now)
    } catch {
      /* best effort */
    }
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    // We hold the state-file lock, so a genuine EADDRINUSE here means a PRIOR host (from before
    // this file existed, or one that crashed after binding but before this run started) is still
    // bound to the endpoint.
    //
    // Do NOT probe our own state file here: it is the EMPTY lock this process just created, so
    // every read of it says "file is empty" and the probe can never answer alive or absent. That
    // was issue #783 — the "one more honest look" was structurally a no-op, and the exit deleted
    // the lock, so the next launch repeated it from scratch. Nothing here can identify whoever
    // holds the endpoint, so the honest move is to keep the lock and wait for it to free up.
    if (err.code === 'EADDRINUSE' && Date.now() < listenDeadline) {
      const now = Date.now()
      if (now - lastRetryLogAt > 10_000) {
        lastRetryLogAt = now
        log(
          `listen error: EADDRINUSE — endpoint still held; retrying for ` +
            `${Math.round((listenDeadline - now) / 1000)}s more`
        )
      }
      touchStartupLock()
      // Deliberately NOT unref'd: while `listen` has failed the server holds no handle, so an
      // unref'd timer leaves an empty event loop and the process exits 0 — a host that silently
      // stops retrying while its log says it is waiting. (Caught by the Windows job below; the
      // Linux one cannot reach this path at all.)
      setTimeout(() => {
        touchStartupLock()
        server.listen(paths.endpoint)
      }, listenDelay)
      listenDelay = Math.min(listenDelay * 2, LISTEN_RETRY_MAX_DELAY_MS)
      return
    }
    log(`listen error: ${err.code ?? err.message}`)
    cleanupFiles()
    process.exit(1)
  })

  const token = crypto.randomBytes(32).toString('hex')
  // `once`, and the listen calls below carry no callback: a retry would otherwise register this
  // again and run the whole publication block once per attempt when the endpoint finally frees.
  server.once('listening', () => {
    // Defence in depth: the 0600 token already gates every command, but a process running under a
    // permissive umask would otherwise publish the AF_UNIX socket world-writable, letting a co-user
    // at least connect() (and reach the pre-auth framer). Pin it to owner-only. Windows named pipes
    // have their own default ACL and no fs mode, so this is POSIX-only; a failure here is not fatal
    // — the token still protects the endpoint — so it is best-effort and logged, not aborted.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(paths.endpoint, 0o700)
      } catch (e) {
        log(`warning: could not restrict socket permissions: ${String(e)}`)
      }
    }
    try {
      fs.writeFileSync(paths.tokenPath, token, { mode: 0o600 })
    } catch (e) {
      abortListeningStartup('could not write token file', e)
      return
    }
    const state: SessionHostState = {
      pid: process.pid,
      endpoint: paths.endpoint,
      tokenPath: paths.tokenPath,
      startedAt: Date.now(),
      protocolVersion: currentProtocolVersion()
    }
    // Replace the empty startup-lock file atomically from a temp owned by THIS process. A fixed
    // `.tmp` lets racing/stale-reclaim hosts publish or remove one another's bytes; a bare rename
    // also loses the boot on Windows when a scanner briefly holds the state file open.
    try {
      publishSessionHostState(paths.statePath, JSON.stringify(state))
    } catch (e) {
      abortListeningStartup('could not publish state file', e)
      return
    }
    log(`listening pid=${process.pid} endpoint=${paths.endpoint}`)
    scheduleGraceExitIfEmpty() // a host with zero sessions ever attached still exits eventually
  })
  server.listen(paths.endpoint)

  // Detaching every client (app quit) is not a lifecycle event here at all — there is no
  // "client" concept at the process level, only sockets, and their 'close' handler above already
  // does the right thing. Nothing to hook for that case.

  process.on('uncaughtException', (e) => log(`uncaughtException: ${String(e)}`))
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${String(e)}`))
}

void main()

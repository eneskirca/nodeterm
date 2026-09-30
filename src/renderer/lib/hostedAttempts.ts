// The one owner of a hosted team's connection attempts in the renderer: AT MOST ONE attempt and one
// live connection per team (hostId), shared by the boot reconnect, a dropped tab's reconnect and a
// manual "join with code" (R38/R39).
//
// Why one: a second connect for a team whose first is still in flight opens a second pending request
// at the host, which REPLACES the first and closes its socket — the user would see a refusal for an
// attempt nobody declined. Main refuses a duplicate while it is minting and joining
// (`[E_JOIN_BUSY]`), but its lock releases once the relay client exists, which is before the SAS
// dialog and the owner's approval. This owner holds the team through all of it: connecting → the
// approval wait / tab mount → live, until that connection closes.
//
// Why only network failures retry (R35): every other code needs a person (a fresh code, an unlocked
// keyring, an owner) or a new day, and a loop on one of them spends the team's damped device mints.
// The service's per-network limiter (E_JOIN_THROTTLED, a 429 that clears within a minute) retries
// too, but never sooner than a minute (or its Retry-After), on the 60 s tail, announced once per
// streak (R41). A connection that drops before the host answered (a host restarting) is the other
// retry, and it is BOUNDED (R40): the 1/2/4/8/15 s steps, then it stops and says so once — every
// try mints a join token and opens a relay socket. A reconnect after a LIVE connection dropped
// starts on the first rung, never at once (R41). And no attempt outlives its tab: `wanted` is asked
// before every retry and before every mount, and closing the tab cancels the attempt in any phase.
// Pure orchestration over injected deps, so every rule is testable without React or a relay.
// See docs/hosted-team-relay.md.
import type { RelayClosedReason } from '@shared/types'
import { classifyJoinFailure, DROP_RETRY_MAX, reconnectDelayMs, throttleDelayMs, type JoinFailure } from './hostedTeam'

/** The ladder rung of the 60 s tail (1/2/4/8/15 s come before it). */
const TAIL_RUNG = 5

export interface HostedAttemptRequest {
  hostId: string
  /** The team's join code (a bookmark's, or the one the user pasted). */
  code: string
  /** The team's name, for what the user is told. */
  label: string
  /** The user asked for this now: it cancels a pending backoff wait and runs at once. */
  manual: boolean
  /** A network failure backs off and tries again (an unattended reconnect, a tab click); off for
   *  a pasted code, whose user is watching and is told instead. */
  retry: boolean
  /** Reconnect onto this existing tab instead of opening a new one. */
  reconnectProjectId?: string
  /** This reconnect follows a live connection's drop: it waits the first rung (1 s) before its
   *  first try, which counts against the drop budget — a host that approves and then drops must
   *  never make a tight loop (R41). */
  afterDrop?: boolean
  /** A bookmarked reconnect: this side confirms on its own (no SAS prompt is expected). */
  autoConfirm?: boolean
}

export type HostedAttemptPhase = 'connecting' | 'waiting' | 'mounting' | 'live'

/** How a mount ended: a live tab, or not — and then whether trying again could help. `retry` is for
 *  a connection that dropped before the host answered (a host restarting, a relay blip): the relay
 *  client exists before the host is reached, so that failure arrives here rather than as a code. */
export type HostedMountResult = { projectId: string } | { retry: boolean }

export interface HostedAttemptDeps {
  /** `relayClient.connect(code)` → a connection id; rejects with main's `[E_JOIN_…]` message. */
  connect(code: string): Promise<string>
  /** Turn a fresh connection into a tab (the SAS, the owner's approval, the load). A failure it
   *  resolves with is one it has already handled; `retry` asks for another attempt. Never rejects
   *  (a rejection is read as `{ retry: false }`). */
  mount(connectionId: string, req: HostedAttemptRequest): Promise<HostedMountResult>
  onClosed(connectionId: string, listener: (reason?: RelayClosedReason) => void): () => void
  disconnect(connectionId: string): void
  /** A connect failed and this team's attempts stopped. Called once per stop, BUSY included (the
   *  caller decides what, if anything, to say — see `joinStopMessage`). */
  stopped(req: HostedAttemptRequest, failure: JoinFailure): void
  /** A live connection ended; `reason` is set only when the host refused this device. */
  ended(req: HostedAttemptRequest, projectId: string, reason?: RelayClosedReason): void
  /** An unattended attempt used up its retries for a drop the host did not explain (R40). Called
   *  once; the team is released, and the next try is the user's. */
  exhausted(req: HostedAttemptRequest): void
  /** An unattended attempt is being held back by the service's per-network limiter and will retry
   *  in a minute. Called once per streak of throttles (R41). */
  throttled(req: HostedAttemptRequest): void
  /** Is this attempt still wanted? Asked before every retry and before every mount — an attempt
   *  reconnecting a tab that has since been closed or deleted must stop (R40). Default: yes. */
  wanted?(req: HostedAttemptRequest): boolean
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface HostedAttempts {
  /** Start (or, for a manual request, hurry) this team's attempt. `busy` = this team already has
   *  an attempt connecting, waiting for approval or live, and nothing was started. */
  run(req: HostedAttemptRequest): 'started' | 'busy'
  phase(hostId: string): HostedAttemptPhase | null
  /** Stop a pending backoff or an in-flight connect for good. A connection already past its
   *  connect (approval wait, live tab) is the user's and is left alone. */
  cancel(hostId: string): void
  /** The tab `projectId` was closed or deleted: every attempt for it stops in whatever phase it is
   *  in, and its team's slot is free at once. A connection waiting for approval is closed; a live
   *  one is the tab's own to close (its session teardown does), and is not reported as a drop. */
  cancelProject(projectId: string): void
  /** Stop everything (the canvas is going away). */
  dispose(): void
}

interface Entry {
  req: HostedAttemptRequest
  phase: HostedAttemptPhase
  attempt: number
  /** Retries spent on drops the host did not explain (bounded by DROP_RETRY_MAX). */
  drops: number
  /** This streak of throttles has been announced. Ends when the service lets a connect through. */
  throttleSaid: boolean
  timer: unknown
  connectionId: string | null
  projectId: string | null
  unClose: (() => void) | null
  /** The connection closed while its tab was still mounting: set to the close's reason holder. */
  closedEarly: { reason?: RelayClosedReason } | null
}

export function createHostedAttempts(deps: HostedAttemptDeps): HostedAttempts {
  const entries = new Map<string, Entry>()
  let disposed = false

  /** The entry for `hostId` is still `e` — async continuations of a cancelled or replaced attempt
   *  must do nothing. */
  const current = (e: Entry): boolean => !disposed && entries.get(e.req.hostId) === e

  const release = (e: Entry): void => {
    e.unClose?.()
    e.unClose = null
    if (entries.get(e.req.hostId) === e) entries.delete(e.req.hostId)
  }

  const endLive = (e: Entry, reason?: RelayClosedReason): void => {
    const projectId = e.projectId
    release(e)
    if (projectId) deps.ended(e.req, projectId, reason)
  }

  const wanted = (e: Entry): boolean => (deps.wanted ? deps.wanted(e.req) : true)

  /** Wait `ms`, then try again — unless the attempt was cancelled or is no longer wanted. */
  const retryAfter = (e: Entry, ms: number): void => {
    e.phase = 'waiting'
    e.timer = deps.setTimer(() => {
      e.timer = null
      if (!current(e)) return
      if (!wanted(e)) {
        release(e)
        return
      }
      attempt(e)
    }, ms)
  }

  /** A network failure: the 1/2/4/8/15 s steps, then every 60 s (R35). */
  const backOff = (e: Entry): void => {
    retryAfter(e, reconnectDelayMs(e.attempt))
    e.attempt += 1
  }

  const attempt = (e: Entry): void => {
    e.phase = 'connecting'
    let connection: Promise<string>
    try {
      connection = deps.connect(e.req.code)
    } catch (err) {
      connection = Promise.reject(err)
    }
    connection.then(
      (connectionId) => {
        if (!current(e)) {
          // Cancelled (or disposed) while connecting: nobody wants this connection.
          deps.disconnect(connectionId)
          return
        }
        e.throttleSaid = false // the service let this one through
        if (!wanted(e)) {
          // Its tab went away while it connected: never bind this connection to it.
          deps.disconnect(connectionId)
          release(e)
          return
        }
        e.phase = 'mounting'
        e.connectionId = connectionId
        e.unClose = deps.onClosed(connectionId, (reason) => {
          if (!current(e)) return
          if (e.phase === 'live') endLive(e, reason)
          else e.closedEarly = { reason } // the mount rejects on it too; its settle decides
        })
        let mounted: Promise<HostedMountResult>
        try {
          mounted = deps.mount(connectionId, e.req)
        } catch (err) {
          mounted = Promise.reject(err)
        }
        mounted
          .catch((): HostedMountResult => ({ retry: false }))
          .then((result) => {
            if (!current(e)) return
            if (!('projectId' in result) || !result.projectId) {
              e.unClose?.()
              e.unClose = null
              e.connectionId = null
              e.closedEarly = null
              if (!('retry' in result && result.retry && e.req.retry)) {
                release(e)
                return
              }
              // A drop before the host answered: worth a few quick tries (a host restarting), never
              // an open-ended loop — each try mints a join token and opens a socket (R40).
              if (e.drops >= DROP_RETRY_MAX) {
                release(e)
                deps.exhausted(e.req)
                return
              }
              retryAfter(e, reconnectDelayMs(e.drops))
              e.drops += 1
              return
            }
            // Live. This entry ends when this connection does (released, reported as `ended`); a later
            // attempt for the team is a fresh entry, with a fresh ladder and a fresh drop budget.
            const projectId = result.projectId
            e.projectId = projectId
            if (e.closedEarly) {
              endLive(e, e.closedEarly.reason)
              return
            }
            e.phase = 'live'
          })
      },
      (err) => {
        if (!current(e)) return
        const failure = classifyJoinFailure(err instanceof Error ? err.message : String(err))
        if (failure.throttled && e.req.retry) {
          // The per-network limiter clears within a minute: wait at least that long (or its
          // Retry-After, never more than ten minutes), and stay on the 60 s tail after it — never a
          // burst back down to 1 s.
          if (!e.throttleSaid) {
            e.throttleSaid = true
            deps.throttled(e.req)
          }
          e.attempt = Math.max(e.attempt, TAIL_RUNG)
          retryAfter(e, throttleDelayMs(failure.retryAfterMs))
          return
        }
        if (failure.retry && e.req.retry) {
          backOff(e)
          return
        }
        release(e)
        deps.stopped(e.req, failure)
      }
    )
  }

  return {
    run(req) {
      if (disposed) return 'busy'
      const existing = entries.get(req.hostId)
      if (existing) {
        if (existing.phase !== 'waiting' || !req.manual) return 'busy'
        // A manual attempt hurries a waiting loop: its backoff timer goes, and the ONE attempt runs
        // now, with the manual request's terms (it may name the tab to reconnect in place).
        deps.clearTimer(existing.timer)
        existing.timer = null
        // A request that names no tab keeps the tab the loop was reconnecting: a pasted code must
        // not drop a greyed tab's binding and open a second one.
        existing.req =
          req.reconnectProjectId || !existing.req.reconnectProjectId
            ? req
            : { ...req, reconnectProjectId: existing.req.reconnectProjectId }
        attempt(existing)
        return 'started'
      }
      const e: Entry = { req, phase: 'connecting', attempt: 0, drops: 0, throttleSaid: false, timer: null, connectionId: null, projectId: null, unClose: null, closedEarly: null }
      entries.set(req.hostId, e)
      if (req.afterDrop) {
        // Never straight back after a drop: the first rung, and it is the drop budget's first retry.
        e.drops = 1
        retryAfter(e, reconnectDelayMs(0))
      } else {
        attempt(e)
      }
      return 'started'
    },
    phase(hostId) {
      return entries.get(hostId)?.phase ?? null
    },
    cancel(hostId) {
      const e = entries.get(hostId)
      if (!e || e.phase === 'mounting' || e.phase === 'live') return
      if (e.timer !== null) deps.clearTimer(e.timer)
      e.timer = null
      release(e)
    },
    cancelProject(projectId) {
      for (const e of [...entries.values()]) {
        if (e.req.reconnectProjectId !== projectId && e.projectId !== projectId) continue
        if (e.timer !== null) deps.clearTimer(e.timer)
        e.timer = null
        // Waiting for approval: nobody will ever look at that tab, so the connection goes too.
        if (e.phase === 'mounting' && e.connectionId) deps.disconnect(e.connectionId)
        release(e)
      }
    },
    dispose() {
      disposed = true
      for (const e of entries.values()) {
        if (e.timer !== null) deps.clearTimer(e.timer)
        e.unClose?.()
      }
      entries.clear()
    }
  }
}

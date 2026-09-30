// The standing listener lifecycle for a hosted team: keep ONE idle relay listener registered under
// the host's room, refresh it before its token expires, replace it the moment it bridges a peer,
// and back off on failure. A port of the desktop's rules in src/main/remote/standing-host.ts, made
// pure over injected deps so the measured incidents those rules encode are unit-tested here:
//  - the backoff resets only on PROOF THE RELAY LEG WORKS (an IDLE listener holds its registration
//    to its refresh, or a peer bridges) — never on a successful mint. When the API is up and the
//    relay is down every mint succeeds and every socket dies at once, and a reset on mint re-minted
//    at round-trip speed until the API's per-IP limit answered 429 (relay log, 2026-09-27);
//  - a BRIDGED listener's refresh is not proof: that socket registered long ago, so it says nothing
//    about whether a NEW registration works. The desktop counts it, and with one long-lived session
//    beside a relay refusing new registrations that restarted the idle backoff at 1 s every 90 s;
//  - at most MINT_BUDGET_PER_HOUR successful mints in any rolling hour, whatever asks for them. The
//    backend's free limit is 240/h, the 15 s backoff ceiling alone reaches exactly 240/h, and a peer
//    joining and leaving every 10 s asks for 360/h — so no per-path rule can hold the line on its own;
//  - a 429 waits at least 60 s (longer if Retry-After says so); a 402/403 stops minting (a refused
//    key proof names itself in `lastError`; a 403 host-token.ts judges transient arrives as
//    `network` and backs off);
//  - a key-proof refusal stops minting only on the SECOND in a row: a POP_SECRET rotation, or a
//    secret mismatch between backend instances, inside ONE challenge→mint pair refuses an honest
//    host once. The first is backed off like a transient 403 (the retry fetches a fresh challenge);
//    only a successful mint or start() resets the count — a transient failure in between does not,
//    or a backend refusing every proof behind a flaky challenge would retry forever. Both refusals
//    are logged with their kind (warn, then error), so an operator can tell the two apart;
//  - while a backoff timer is armed it owns the next mint: nothing else may mint early.
// Everything the injected deps can throw is caught: a scheduler that swallowed an exception would sit
// in 'running' with no listener and no timer, i.e. hosting silently dead until a restart.
import type { MintResult } from './host-token'
import { POP_REFUSED_MESSAGE, type PopRefusal } from './relay-pop'
export type { MintResult } from './host-token'

const REFRESH_LEAD_MS = 30_000
// Floored so a bogus or already-expired exp can't spin us.
const MIN_REFRESH_MS = 15_000
const DEFAULT_TTL_MS = 120_000
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000]
const RATE_LIMIT_MIN_MS = 60_000
const HOUR_MS = 3_600_000
// Ceiling for every delay we arm: setTimeout's own limit. Node fires a timer after ~1 ms for any
// delay above 2^31-1 ms, so an unclamped Retry-After or token lifetime would become a tight re-mint
// loop. Nothing lower: a shorter cap would re-mint before a long Retry-After has elapsed.
const MAX_DELAY_MS = 2_147_483_647
// Stay clear of the backend's 240/h free limit. The count is per scheduler instance, so the headroom
// is also what absorbs a restart, whose new instance cannot see the mints the old one made.
const MINT_BUDGET_PER_HOUR = 200

export interface Listener {
  bridged: boolean
  close(): void
}
export interface SchedulerStatus {
  state: 'stopped' | 'running' | 'backend-refused'
  /** The most recent failure since the relay leg was last proven to work; null once it has been. */
  lastError: string | null
  /** Tokens minted in the last hour (successful mints). The scheduler holds it at 200 (MINT_BUDGET_PER_HOUR). */
  mintsLastHour: number
  idle: number
  bridged: number
}
export interface SchedulerDeps {
  mint(): Promise<MintResult>
  /**
   * Open a relay listener with a fresh token. `onBridged` fires when a peer completes the handshake
   * on it (it may fire more than once); `onClose` when the relay socket drops ON ITS OWN. A listener
   * the scheduler closes itself (refresh, stop) may or may not fire `onClose` — both are handled.
   */
  open(token: string, events: { onBridged(): void; onClose(): void }): Listener
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  onStatus?(s: SchedulerStatus): void
}

interface Entry {
  listener: Listener | null
  bridged: boolean
  /** The refresh timer's handle, or null. Compared with null, never by truthiness: 0 is a handle. */
  refresh: unknown
}

const clampDelay = (ms: number): number => Math.min(MAX_DELAY_MS, ms)
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createHostedScheduler(deps: SchedulerDeps, now: () => number) {
  let state: SchedulerStatus['state'] = 'stopped'
  let lastError: string | null = null
  let opening = false
  let attempt = 0
  let retry: unknown = null
  /** Key-proof refusals since the last successful mint or start(); the second in a row is terminal. */
  let popRefusals = 0
  const mints: number[] = []
  const live = new Set<Entry>()

  const status = (): SchedulerStatus => {
    const cutoff = now() - HOUR_MS
    while (mints.length && mints[0] < cutoff) mints.shift()
    let idle = 0
    let bridged = 0
    for (const e of live) {
      if (e.bridged) bridged++
      else idle++
    }
    return { state, lastError, mintsLastHour: mints.length, idle, bridged }
  }
  const emit = (): void => {
    if (!deps.onStatus) return
    try {
      deps.onStatus(status())
    } catch {
      // An observer's bug must not wedge the lifecycle it is observing.
    }
  }

  // The relay leg demonstrably works: the backoff has done its job and the last failure is history.
  const proven = (): void => {
    attempt = 0
    lastError = null
  }

  // The ONE retry slot. Whoever arms it — backoff, 429 or the mint budget — owns the next mint.
  const armRetry = (ms: number): void => {
    retry = deps.setTimeout(() => {
      retry = null
      void top()
    }, clampDelay(ms))
  }
  const scheduleRetry = (minMs = 0): void => {
    if (state !== 'running' || retry !== null) return
    armRetry(Math.max(minMs, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]))
    attempt++
  }

  const drop = (e: Entry): void => {
    if (e.refresh !== null) deps.clearTimeout(e.refresh)
    e.refresh = null
    live.delete(e)
  }
  const closeQuietly = (l: Listener | null): void => {
    try {
      l?.close()
    } catch {
      // Already dead or half-built: there is nothing left to close.
    }
  }

  const armRefresh = (e: Entry, ttlMs: number): void => {
    if (e.refresh !== null) deps.clearTimeout(e.refresh)
    const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS
    e.refresh = deps.setTimeout(() => {
      e.refresh = null
      // A bridged listener has no refresh (its timer is cleared on bridging); this is only defence.
      // It is never cut for a refresh: nodeterm-server's relay broker never expires or evicts a
      // bridged socket (it closes only an UNBRIDGED listener, at its token's exp + 30 s), and if one
      // closes anyway, onClose takes it from there. It is never re-armed either: a bridged refresh
      // would prove nothing (see the header), so a timer for it would be a timer per session that
      // does nothing, forever for one whose close is lost.
      if (state !== 'running' || !live.has(e) || e.bridged) return
      // This IDLE listener held its registration for a whole token lifetime: new registrations work.
      proven()
      drop(e)
      closeQuietly(e.listener)
      emit()
      void top()
    }, clampDelay(Math.max(MIN_REFRESH_MS, ttl - REFRESH_LEAD_MS)))
  }

  const idleCount = (): number => {
    let n = 0
    for (const e of live) if (!e.bridged) n++
    return n
  }

  // Keep one idle listener registered. Never two mints at once, and never ahead of an armed backoff.
  async function top(): Promise<void> {
    if (state !== 'running' || opening || retry !== null || idleCount() >= 1) return
    if (status().mintsLastHour >= MINT_BUDGET_PER_HOUR) {
      // Out of budget: wait until the oldest mint in the window ages out (+1 ms, because the window
      // keeps a mint exactly an hour old). The retry slot makes every other path defer to this.
      lastError = 'mint budget'
      armRetry(Math.max(1, mints[0] + HOUR_MS - now() + 1))
      emit()
      return
    }
    opening = true
    try {
      let r: MintResult
      let threw: string | null = null
      /** Set when this mint is the FIRST key-proof refusal in a row, which is retried, not terminal. */
      let refusedOnce: PopRefusal | null = null
      try {
        r = await deps.mint()
      } catch (err) {
        r = { ok: false, kind: 'network' }
        threw = `mint failed: ${errorText(err)}`
      }
      if (r.ok) {
        mints.push(now()) // counted even if we were stopped meanwhile: the backend counted it
        popRefusals = 0
      } else if (r.kind === 'refused' && r.reason && ++popRefusals < 2) {
        // The first key-proof refusal in a row is transient (see the header): back off, re-challenge.
        refusedOnce = r.reason
        r = { ok: false, kind: 'network', status: 403 }
      }
      if (state !== 'running') return
      if (!r.ok) {
        // A key-proof refusal says what to do about it (update, or `team rotate-key`); `refused (403)` would not.
        lastError =
          threw ??
          (refusedOnce
            ? `key proof refused once (${refusedOnce}) — retrying with a fresh challenge`
            : r.reason
              ? POP_REFUSED_MESSAGE
              : r.kind + (r.status ? ` (${r.status})` : ''))
        // Only the refusal KIND is logged: nothing here holds key material, and nothing may.
        if (refusedOnce) console.warn(`[hosted-team] the relay refused this host's key proof once (${refusedOnce}); retrying with a fresh challenge`)
        if (r.kind === 'refused') {
          if (r.reason) console.error(`[hosted-team] the relay refused this host's key proof twice in a row (${r.reason}); hosting stopped`)
          state = 'backend-refused'
          emit()
          return
        }
        scheduleRetry(r.kind === 'rate-limited' ? Math.max(RATE_LIMIT_MIN_MS, r.retryAfterMs ?? 0) : 0)
        emit()
        return
      }
      // NOT proven() here: a mint proves only that the API answered, and the relay is another host.
      const e: Entry = { listener: null, bridged: false, refresh: null }
      live.add(e) // before open(), so an event fired synchronously from inside it is not lost
      let listener: Listener
      try {
        listener = deps.open(r.pairingToken, {
          onBridged: () => {
            if (!live.has(e) || e.bridged) return // a stale listener, or the second report of one peer
            e.bridged = true
            if (e.listener) e.listener.bridged = true
            if (e.refresh !== null) deps.clearTimeout(e.refresh) // a bridged listener is never refreshed
            e.refresh = null
            proven() // a completed handshake proves the relay leg end to end
            emit()
            void top() // this listener now serves a peer: restore a warm one
          },
          onClose: () => {
            if (!live.has(e)) return // we closed it ourselves (refresh / stop / replaced)
            drop(e)
            if (e.bridged) {
              // A peer's session ended. Its replacement was opened on bridging, so this is normally a
              // no-op — and a teammate leaving is not a relay failure, so it never advances the backoff.
              emit()
              void top()
              return
            }
            // An idle listener dropping on its own is the relay refusing or unreachable.
            lastError = 'relay closed the idle listener'
            scheduleRetry()
            emit()
          }
        })
      } catch (err) {
        live.delete(e)
        lastError = `open failed: ${errorText(err)}`
        scheduleRetry()
        emit()
        return
      }
      e.listener = listener
      if (e.bridged) listener.bridged = true
      if (!live.has(e)) {
        // It closed (or was stopped) during open(): its onClose already decided what comes next.
        closeQuietly(listener)
        return
      }
      if (!e.bridged) armRefresh(e, r.ttlMs)
      emit()
    } finally {
      opening = false
      // Still short — the new listener bridged during open(), or bridged AND closed there (whose own
      // top() calls were refused while we were opening). Unconditional on purpose: every path that
      // must NOT mint again has already armed the retry slot or left 'running', and top() checks both.
      if (state === 'running' && idleCount() < 1) queueMicrotask(() => void top())
    }
  }

  return {
    start(): void {
      if (state === 'running') return
      state = 'running'
      attempt = 0
      popRefusals = 0
      emit()
      void top()
    },
    stop(): void {
      state = 'stopped'
      if (retry !== null) {
        deps.clearTimeout(retry)
        retry = null
      }
      for (const e of [...live]) {
        drop(e)
        closeQuietly(e.listener)
      }
      emit()
    },
    status
  }
}

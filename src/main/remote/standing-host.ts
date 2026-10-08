// Standing (always-on) phone host — the desktop side of the iOS relay-client "reach my Mac from
// anywhere" flow.
//
// When Settings → phoneAccessEnabled is on, this keeps a HOST relay
// connection registered under the host's stable id (base64url(sha256(hostPublicKey)).slice(0,22)),
// so a previously-paired phone can join over the relay at any time and attach to the host's tmux
// sessions after approval. Unlike the interactive host (a single-use offer you hand out), the
// standing host:
//   - mints its token from `POST /v1/relay/host-token` (role:'host', hostId as the broker room);
//   - AUTO-REFRESHES: relay tokens are short-lived (~120s TTL) and single-use, so we re-mint + a
//     reconnect before expiry, and reconnect with bounded backoff on socket close;
//   - uses PIN-ONCE approval: the first connect from a given phone (its box public key) prompts
//     the host human via the shared SAS dialog; on approval the pubkey is pinned, so later
//     connects auto-approve silently. A paired phone needs no dialog: its key is pinned at the scan
//     when the pairing minted a relay leg (audit A07), and otherwise on its first handshake here while
//     its pairing, which recorded the key, is still listed (`pinPairedPhone`, A07-late);
//   - is cut on REVOCATION: forgetting a phone unpins its key and then closes the sessions it has
//     open (`killStandingHostSessionsByPeerKey`, called by peer-revoker.ts). For the rest of the app
//     run the forgotten phone's reconnects are then refused the way a Deny refuses them, with no
//     dialog (`REVOKED_PHONE_DENY_MS`), unless pairing it again pinned or recorded its key.
//
// The heavy lifting (relay wiring, RPC/frame handlers, fs jail, canvas mirror, approval gate) is
// shared with the interactive host via `connectHostSession`. Pin/lookup logic is the pure,
// unit-tested `approved-devices-core`; the pins live in the PHONE store (`phonePins`) and nowhere
// else — the desktop relay roles have their own stores, which this module never reads.

import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation, Settings } from '../../shared/types'
import { PtyManager } from '../../core/pty-manager'
import { getStoredEntitlement } from '../../core/license'
import { getDeviceId } from '../../core/device-id'
import { createPhonePresence, type PhonePresence } from './phone-presence'
import { publicKeyToB64, type KeyPair } from './e2ee'
import {
  API_BASE,
  RELAY_URL,
  connectHostSession,
  loadOrCreateKeyPair,
  relayAllowed,
  type HostBridgeDeps,
  type HostSession
} from './host-service'
import type { LegacyRelayPairings } from './relay-pairing-proof'
import { currentCanvas, initHostCanvasHub, subscribeCanvas } from './host-canvas-hub'
import { hostIdFromPublicKeyB64 } from './relay-id'
import { removeRelayAdvertisement, writeRelayAdvertisement } from './relay-advertise'
import { isPinned, pinDevice } from './approved-devices-core'
import { phonePins } from './approved-devices'
import { registerPeerSessionKiller } from './peer-revoke'
import { createPhoneApprovals } from '../../core/phone-approval'
import {
  POP_REFUSED_MESSAGE_DESKTOP,
  computePopProof,
  fetchPopChallenge,
  popRefusalOf,
  type PopRefusal
} from '../../core/relay/relay-pop'

// Re-mint the token this long before its expiry (TTL is ~120s). Floored so a bogus/short exp can't
// spin us.
const REFRESH_LEAD_MS = 30_000
const MIN_REFRESH_MS = 15_000
const DEFAULT_TTL_MS = 120_000
// Bounded backoff for reconnect after a socket close / mint failure.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000]
/**
 * How long a phone revoked during this run is left unapproved before its session is closed (see
 * `revokedThisRun`). Until then every request it makes is answered "Awaiting host approval.", and
 * the close after that is what a human's Deny looks like to a phone: the Android client reads a
 * close after it was told it awaits approval as a refusal and stops dialing on its own
 * (RelayConnector → RelayApprovalGate). Closed at once, the phone may not have heard that yet and
 * would read an ordinary failure, which it retries every few seconds. Long enough for its first
 * request over a slow relay, short enough that the approval code it shows meanwhile is a flash.
 */
export const REVOKED_PHONE_DENY_MS = 3_000

interface HostTokenResponse {
  pairingToken: string
  hostId: string
  exp: number
  /** How long the token has left, measured on the SERVER's clock at mint time (see tokenTtlMs). */
  ttlMs: number
}

/**
 * How long a freshly minted token has left, in ms.
 *
 * `exp` is an absolute instant on the SERVER's clock. Subtracting the LOCAL `Date.now()` from it
 * folds this machine's clock error into the answer: a clock 75 s fast leaves 120 − 75 = 45 s, minus
 * the 30 s lead = the 15 s floor, so the host re-mints four times per TTL. Relay log, 2026-09-27: one
 * host refreshing every 15 s, 238 mints/hour against a free limit of 240 — one stray mint from
 * locking itself out for the rest of the hour. The response's own `Date` header is the server's
 * clock at the same instant it computed `exp`, so the difference is clock-independent. It falls
 * back to the local clock only when the header is missing or unparseable (a proxy that strips it).
 */
export function tokenTtlMs(exp: number, serverDate: string | null, localNowMs: number): number {
  if (!(exp > 0)) return DEFAULT_TTL_MS
  const serverNowMs = serverDate ? Date.parse(serverDate) : NaN
  return exp * 1000 - (Number.isFinite(serverNowMs) ? serverNowMs : localNowMs)
}

/**
 * Mint a standing host token from the API. Pro proves entitlement; the free tier sends
 * its deviceId instead (backend admits it against the server-side free-tier policy —
 * until that ships, the mint fails and free hosting simply stays down, i.e. today's
 * behavior).
 *
 * When the backend supports it, the mint also carries a proof that this process holds the host's
 * secret key (relay-pop.ts), so a join code alone can no longer mint this host's tokens. Only a
 * challenge answered 404/405 means "this backend predates the proof" and gets the legacy mint; any
 * other challenge failure is transient and mints NOTHING: to a host the backend has seen prove
 * before, an unproven mint is a 403, which would stop hosting over a blip.
 *
 * Returns `{ refused }` for a key-proof refusal and null for every other failure (the caller backs
 * off and retries). This function stays stateless: the caller counts refusals and stops hosting
 * only on the second in a row (see `popRefusals` in initStandingHost). One 403 is not a refusal at
 * all: `pop_required` for a mint sent WITHOUT a proof because the challenge said 404/405. A
 * reverse proxy answers 404 while the backend redeploys, and the unproven mint that follows can land
 * on the fresh backend; stopping there would end hosting for good over a redeploy, so it backs off
 * and the next attempt asks for a challenge again.
 */
async function mintHostToken(
  entitlement: string | null,
  keys: KeyPair
): Promise<HostTokenResponse | { refused: PopRefusal } | null> {
  const hostPublicKeyB64 = publicKeyToB64(keys.publicKey)
  // Read ONCE: the proof's subject must be the exact id the body sends. On a first launch
  // getDeviceId() mints a uuid and writes it asynchronously, so a second call before that write
  // lands mints another one, and the backend would refuse the pair as pop_invalid (a key-proof
  // refusal, which stops phone access when it repeats).
  const deviceId = entitlement ? null : getDeviceId()
  const base = entitlement ? { entitlement, hostPublicKeyB64 } : { deviceId, hostPublicKeyB64 }
  const ctrl = new AbortController()
  // One timer for the whole mint: the challenge, the host-token request and its body read.
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const ch = await fetchPopChallenge({
      apiBase: API_BASE,
      hostPublicKeyB64,
      purpose: 'host-token',
      signal: ctrl.signal
    })
    if (!ch.ok && !ch.unsupported) return null // transient: back off, never mint unproven
    // True only when the challenge said 404/405: the one case this mint goes out unproven although
    // we hold the key (see the header on what a pop_required then means).
    const sentUnproven = !ch.ok && ch.unsupported
    let proof: { popChallenge: string; popProof: string } | null = null
    if (ch.ok) {
      try {
        proof = {
          popChallenge: ch.challenge,
          popProof: computePopProof({
            hostSecretKey: keys.secretKey,
            hostPublicKeyB64,
            challenge: ch.challenge,
            serverPublicKeyB64: ch.serverPublicKeyB64,
            purpose: 'host-token',
            // The backend proves host-token against `body.deviceId ?? ''`: '' on the Pro path.
            subject: deviceId ?? ''
          })
        }
      } catch {
        // A server key the proof cannot use (malformed, or low-order): back off, never mint.
        return null
      }
    }
    const res = await fetch(`${API_BASE}/v1/relay/host-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // popChallenge and popProof travel together or not at all: the backend treats a half-present
      // proof as pop_invalid, which would repeat on every retry and so stop phone access.
      body: JSON.stringify({ ...base, ...(proof ?? {}) }),
      signal: ctrl.signal
    })
    if (res.status === 403) {
      const refused = popRefusalOf(403, await res.json().catch(() => null))
      // A backend that came back mid-redeploy (see the header): transient, not a refusal.
      if (refused === 'pop_required' && sentUnproven) return null
      if (refused) return { refused }
    }
    if (!res.ok) return null
    const json = (await res.json().catch(() => ({}))) as Partial<HostTokenResponse>
    if (!json.pairingToken) return null
    const exp = json.exp ?? 0
    return {
      pairingToken: json.pairingToken,
      hostId: json.hostId ?? '',
      exp,
      ttlMs: tokenTtlMs(exp, res.headers?.get?.('date') ?? null, Date.now())
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The stored host identity is encrypted and the keyring is locked/unavailable right now (see
 * host-identity.ts). Matched by `code`, not `instanceof`: the error crosses a module re-export and
 * the code is the stable contract.
 */
function isHostKeyLocked(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'E_HOST_KEY_LOCKED'
}

/**
 * A locked keyring is a LOUD, recoverable failure: the key on disk is intact, hosting simply
 * cannot start until the OS can decrypt it. The standing host runs with no UI of its own, so
 * without this the user would just find phone access mysteriously dead.
 */
function reportKeyLocked(err: Error): void {
  try {
    dialog.showErrorBox(
      'Remote access could not start',
      `${err.message}\n\nPhone access is off until then. Turn it back on in Settings → Phone once your keyring is unlocked.`
    )
  } catch {
    // No dialog available (headless / very early boot): the console line is the fallback.
  }
  console.error('[standing-host] host identity is locked:', err.message)
}

/**
 * The relay refused this host's key proof twice in a row, each time on a fresh challenge
 * (`pop_invalid`, or `pop_required` on a proven mint). It will keep refusing, so hosting stops and
 * the human is told, once, what to do — instead of phone access going quietly dead, or a retry
 * loop spending the host's mints. The kind goes to the log only; the dialog text is fixed.
 */
function reportPopRefused(kind: PopRefusal): void {
  try {
    dialog.showErrorBox(
      'Remote access stopped',
      `${POP_REFUSED_MESSAGE_DESKTOP}\n\nPhone access is off. Turn it back on in Settings → Phone after updating.`
    )
  } catch {
    // No dialog available (headless / very early boot): the console line is the fallback.
  }
  console.error(`[standing-host] the relay refused this host key proof twice in a row (${kind})`)
}

export interface StandingHost {
  /** Explicit toggle (from the Settings switch). Reconciles the connection immediately. */
  setEnabled(enabled: boolean): void
  /** Read the desired state from settings (launch / external change) and reconcile. */
  syncFromSettings(): void
  /** Tear everything down (e.g. app quit). */
  stop(): void
}

// The revoke hook of every RUNNING standing host (in production there is one). Module-level, like
// relay-host.ts's `live` set, so the peer revoker (peer-revoker.ts) reaches it without depending on
// the order index.ts constructs the two in.
const runningHosts = new Set<(peerKeyB64: string) => number>()

// The phone keys revoked during this app run (review of A07-revoke). Cutting a phone's session makes
// it redial (the Android client does so about 1.5 s after a drop while its screen is open), and with
// its key unpinned and its pairing gone, that handshake used to raise the SAS dialog for the phone
// the user had just removed, where approving it would pin the key again. Such a handshake is now
// refused without a dialog (`REVOKED_PHONE_DENY_MS`). Module-level, so a revoke while remote access
// is off counts too. Checked only after the pin and the paired-phone check, so pairing the phone
// again (which pins or records its key) lets it in. In memory on purpose: after a restart the phone
// gets the dialog again, as any unpinned phone does, and a desktop that cannot write the unpin keeps
// the device listed instead (pairing-service.ts `revokeDevice`).
const revokedThisRun = new Set<string>()

/** Remember an exact phone revoke even with hosting off; session teardown belongs to the caller. */
export function rememberRevokedStandingPhone(peerKeyB64: string): void {
  if (peerKeyB64) revokedThisRun.add(peerKeyB64)
}

/**
 * Close every standing-host relay session whose phone is `peerKeyB64`, and withdraw any approval
 * dialog still pending for it. The kill half of revoking a phone: unpinning its key only refuses
 * the NEXT handshake, while a session already open keeps serving terminals, files and the canvas
 * (see revocation.ts). Sessions of every other key are untouched. Returns how many were closed.
 * The key is remembered for the rest of the run (`revokedThisRun`), whether or not a host runs now.
 */
export function killStandingHostSessionsByPeerKey(peerKeyB64: string): number {
  rememberRevokedStandingPhone(peerKeyB64)
  let closed = 0
  for (const revokePeer of [...runningHosts]) closed += revokePeer(peerKeyB64)
  return closed
}

/** Test seam: forget every key revoked so far (the set otherwise lives as long as the process). */
export function resetRevokedPhonesForTests(): void {
  revokedThisRun.clear()
}

export interface StandingHostOptions {
  legacyRelayPairings?: LegacyRelayPairings
  /**
   * An unpinned phone completed the handshake: pin its key and answer true when a listed pairing
   * recorded it (pairing-service.ts `approvePairedRelayKey`, A07-late), so the handshake is approved
   * without the SAS dialog. False or a rejection ⇒ the dialog, as before. Absent ⇒ always the dialog.
   */
  pinPairedPhone?(boxPublicKeyB64: string): Promise<boolean>
}

/**
 * Wire the standing phone host. Idempotent to construct once; `setEnabled` / `syncFromSettings`
 * reconcile the live connection against (enabled && relay-allowed).
 */
export function initStandingHost(
  win: BrowserWindow,
  ptyManager: PtyManager,
  getSettings: () => Settings,
  listProjects: () => Promise<string> = async () => '',
  bridge: HostBridgeDeps = {},
  options: StandingHostOptions = {}
): StandingHost {
  initHostCanvasHub()

  // Warm-standby POOL: keep this many un-bridged listener sockets registered at the relay, so a
  // client (browse OR session) always finds a host waiting and multiple clients can connect
  // concurrently — no churn gap. When a client bridges to a listener, that listener becomes
  // "bridged" and we open a replacement to keep the pool full.
  const TARGET_PENDING = 1

  interface Pooled {
    session: HostSession
    /** True once a client completed the handshake on this listener (it now serves that client). */
    bridged: boolean
    /** This session's presence slot: joined when a phone bridges, left on EVERY end path. */
    presence: PhonePresence
    /** Per-session pending approval (unknown device awaiting the human's SAS decision). */
    approvalPub: string | null
    approvalId: string | null
    refreshTimer: ReturnType<typeof setTimeout> | null
    /** A phone revoked during this run: the close that refuses it (see `REVOKED_PHONE_DENY_MS`). */
    denyTimer: ReturnType<typeof setTimeout> | null
  }

  let enabled = false
  let running = false
  let opening = false // guards against overlapping connectOne() calls
  const pool = new Set<Pooled>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  // Key-proof refusals since the last successful mint or start(). Only the SECOND in a row is
  // terminal: a POP_SECRET rotation, or a secret mismatch between backend instances, inside one
  // challenge→mint pair refuses an honest host once, and stopping there would leave every host that
  // was mid-mint at that moment off until someone turned phone access back on by hand.
  let popRefusals = 0

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function pendingCount(): number {
    let n = 0
    for (const p of pool) if (!p.bridged) n++
    return n
  }

  // Presence is dropped from BOTH end paths, because they are genuinely different: `onClose` fires
  // when the relay socket drops on its own (client gone, relay dropped us), while an INTENTIONAL
  // `session.close()` (reject / idle-token refresh / stop()) is final in relay-socket and
  // deliberately does NOT fire onClose. `PhonePresence.leave()` (shared with the interactive host)
  // is exactly-once, so a peer never leaves twice (its color is never freed for someone else).

  const approvals = createPhoneApprovals({
    persist: (pub) => phonePins.update((store) => pinDevice(store, pub)),
    cleared: (id) => send(IPC.remoteHostPeerPendingCleared, { id })
  })

  function clearDenyTimer(p: Pooled): void {
    if (p.denyTimer) {
      clearTimeout(p.denyTimer)
      p.denyTimer = null
    }
  }

  function removeFromPool(p: Pooled): void {
    if (p.approvalId) approvals.clear(p.approvalId)
    p.presence.leave()
    if (p.refreshTimer) {
      clearTimeout(p.refreshTimer)
      p.refreshTimer = null
    }
    clearDenyTimer(p)
    pool.delete(p)
    p.session.close()
  }

  // A paired phone was revoked on this desktop (audit A07-revoke). Every pooled session with its
  // key ends through removeFromPool, the path the human's "Deny" takes: presence leaves, the pending
  // dialog clears, the served PTYs are killed and the socket closes. A session that bridged before
  // the unpin landed is still waiting on its disk read or serving the phone, and either way it must
  // go. A consent record that outlived its browse socket (#819) is withdrawn too.
  function revokePeer(peerKeyB64: string): number {
    if (!peerKeyB64) return 0
    approvals.forget(peerKeyB64)
    let closed = 0
    let failure: unknown = null
    for (const p of [...pool]) {
      if (p.session.peerPublicKeyB64() !== peerKeyB64 && p.approvalPub !== peerKeyB64) continue
      closed++
      try {
        removeFromPool(p) // leaves the pool before the close, so a throwing close strands nothing
      } catch (err) {
        failure ??= err // keep cutting the phone's other sessions; report the failure after
      }
    }
    if (closed) ensurePool()
    if (failure) throw failure
    return closed
  }

  /** Keep the pool topped up with TARGET_PENDING un-bridged listeners. */
  function ensurePool(): void {
    if (running && pendingCount() < TARGET_PENDING) void connectOne()
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer) return
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      ensurePool()
    }, delay)
    reconnectTimer.unref?.()
  }

  function scheduleRefreshFor(p: Pooled, ttlMs: number): void {
    if (p.refreshTimer) clearTimeout(p.refreshTimer)
    const delay = Math.max(MIN_REFRESH_MS, ttlMs - REFRESH_LEAD_MS)
    p.refreshTimer = setTimeout(() => {
      p.refreshTimer = null
      if (!running || !pool.has(p)) return
      // This listener held its relay registration for a whole token lifetime: the relay is
      // reachable, so the reconnect backoff has done its job. This — not a successful mint — is
      // what resets it (see connectOne).
      reconnectAttempt = 0
      // A listener serving a client (bridged) is left alone — never cut an active session for a
      // token refresh. nodeterm-server's relay broker never expires or evicts a bridged socket: it
      // closes only an UNBRIDGED listener, at its token's exp + 30 s (and evicts the oldest past 8
      // pending per host). If a bridged socket closes anyway, onClose replaces it. Only an IDLE
      // listener is re-minted with a fresh token by dropping it and topping the pool back up. That
      // refresh fires 30 s before exp, so it has 60 s of slack: a timer that runs later than that
      // (sleep, App Nap) finds the relay already closed the listener, and onClose's reconnect backoff
      // brings a new one up.
      if (p.bridged) {
        scheduleRefreshFor(p, DEFAULT_TTL_MS)
        return
      }
      removeFromPool(p)
      ensurePool()
    }, delay)
    p.refreshTimer.unref?.()
  }

  // A phone completed the E2EE handshake on `pooled`'s listener. Mark it bridged (→ open a
  // replacement listener), then approve: pinned device → silent; unknown → prompt the human.
  // Settles once that is decided (approved, handed to the human, refused, or torn down), which is
  // when connectHostSession answers the requests the phone sent meanwhile.
  async function onPeerReady(pooled: Pooled): Promise<void> {
    if (!pooled.bridged) {
      pooled.bridged = true
      reconnectAttempt = 0 // a completed handshake proves the relay leg end to end
      // Team presence: a bridged relay client is a peer. It has no mouse, so it stays cursorless
      // and appears in the facepile only — see docs/team-presence.md ("Peers may have no cursor").
      pooled.presence.join()
      ensurePool() // this listener now serves a client → restore a warm one
    }
    const s = pooled.session
    const pub = s.peerPublicKeyB64()
    let store
    try {
      store = await phonePins.load()
    } catch {
      store = { pubkeys: [] as string[] }
    }
    if (!pool.has(pooled)) return // torn down while the disk read was in flight
    if (pub && isPinned(store, pub)) {
      s.approve() // pinned device → auto-approve silently
      return
    }
    if (!pub || !s.sas()) return // never offer consent without a verified handshake identity
    // A paired phone whose key its pairing recorded but did not pin (remote access was off at the
    // scan and the phone adopted the relay later over SSH, or the pin at the scan failed): the scan
    // was the approval, so pin it now instead of asking a desk that is usually empty (A07-late).
    // The check runs inside the pin store's queue, so a revoke racing it cannot be undone by it.
    if (options.pinPairedPhone) {
      const pinned = await options.pinPairedPhone(pub).catch((err) => {
        console.warn('[standing-host] could not check the paired phone keys:', err)
        return false
      })
      if (!pool.has(pooled)) return // torn down (revoked, stopped) while that was in flight
      if (pinned) {
        s.approve()
        return
      }
    }
    // The user forgot this phone during this run, and this is it redialing (its session was cut by
    // the revoke). No dialog for it: leave it unapproved, so it hears "Awaiting host approval.", and
    // then close it as a Deny would, which the phone reads as a refusal (review of A07-revoke).
    if (revokedThisRun.has(pub)) {
      console.info('[standing-host] refused a phone revoked during this run')
      clearDenyTimer(pooled)
      pooled.denyTimer = setTimeout(() => {
        pooled.denyTimer = null
        if (!pool.has(pooled)) return
        removeFromPool(pooled)
        ensurePool()
      }, REVOKED_PHONE_DENY_MS)
      pooled.denyTimer.unref?.()
      return
    }
    // Keep the handshake-bound consent record after a browse socket closes (#819). The
    // human may still compare its SAS and pin this exact identity until the bounded deadline.
    pooled.approvalPub = pub
    pooled.approvalId = approvals.add(pub)
    send(IPC.remoteHostPeerPending, {
      sas: s.sas(), id: pooled.approvalId, pub, standing: true
    })
  }

  async function connectOne(): Promise<void> {
    if (!running || opening || pendingCount() >= TARGET_PENDING) return
    opening = true
    // Only a SUCCESSFUL attempt may chain straight into the next one. A failed one has armed
    // scheduleReconnect()'s backoff, and chaining anyway made that backoff dead code: a host whose
    // mint was refused re-minted at its own round-trip time (~175 ms, 35k 429s/day in the relay
    // API log, 2026-09-25) instead of waiting 1 s → 15 s.
    let opened = false
    try {
      const entitlement = getStoredEntitlement() // null on free tier → mint by deviceId
      // The host key is the identity every paired phone PINNED. If the OS keyring is locked we
      // cannot READ it (host-identity refuses to regenerate over it — that would rotate the
      // identity and force every phone to re-approve). There is nothing to advertise, so stop:
      // retrying would spin a dead listener and swallow the reason. Tell the human instead.
      let keys: KeyPair
      try {
        keys = await loadOrCreateKeyPair()
      } catch (err) {
        if (isHostKeyLocked(err)) {
          stop()
          reportKeyLocked(err as Error)
          return
        }
        scheduleReconnect() // transient disk error: back off and try again
        return
      }
      const token = await mintHostToken(entitlement, keys)
      if (!running) return
      if (token && 'refused' in token) {
        popRefusals += 1
        if (popRefusals >= 2) {
          // Terminal: every retry would be refused the same way. stop() clears any armed reconnect.
          stop()
          reportPopRefused(token.refused)
          return
        }
        console.warn(`[standing-host] the relay refused this host key proof (${token.refused}); retrying with a fresh challenge`)
        scheduleReconnect()
        return
      }
      if (!token) {
        scheduleReconnect()
        return
      }
      popRefusals = 0 // a successful mint: the key proof is accepted
      // NOT `reconnectAttempt = 0` here. A mint proves only that the API answered — the relay is a
      // different host, and when it is unreachable from this machine (relay log, 2026-09-27: a host
      // on the fixed build, API fine, relay WS failing for 2½ minutes) every mint succeeds, every
      // socket dies at once, and a reset here made each death re-mint at round-trip speed until the
      // API's per-IP limit answered 429. The backoff resets on proof the relay leg works instead:
      // a listener surviving to its refresh, or a completed phone handshake.
      const pooled: Pooled = {
        session: null as unknown as HostSession,
        bridged: false,
        presence: createPhonePresence(),
        approvalPub: null,
        approvalId: null,
        refreshTimer: null,
        denyTimer: null
      }
      pooled.session = connectHostSession({
        legacyRelayPairings: options.legacyRelayPairings,
        url: RELAY_URL,
        token: token.pairingToken,
        ourKeys: keys,
        pty: ptyManager,
        getLatestCanvas: currentCanvas,
        subscribeCanvas,
        applyMutation: (mutation: CanvasMutation) => send(IPC.remoteHostApplyMutation, mutation),
        listProjects,
        git: bridge.git,
        registerNode: bridge.registerNode,
        destroyNode: bridge.destroyNode,
        remoteViewer: bridge.remoteViewer,
        nodeActions: bridge.nodeActions,
        kanban: bridge.kanban,
        inbox: bridge.inbox,
        remoteNodes: bridge.remoteNodes,
        newSessions: bridge.newSessions,
        chat: bridge.chat,
        extraRoots: bridge.workspaceRoots,
        lanReport: bridge.lanReport,
        // Typing attribution: this pooled session's input frames are ITS phone's keystrokes.
        getClientId: () => pooled.presence.id(),
        // Returned, not voided: connectHostSession holds the phone's requests until this settles,
        // so a phone this host approves without the human is never told it is awaiting approval
        // while the disk reads and the late pin are still running (review of A07-late).
        onPeerReady: () =>
          onPeerReady(pooled).catch((err) => {
            console.warn('[standing-host] the approval decision failed:', err)
          }),
        onClose: () => {
          console.info('[phone-approval] socket-closed', { pending: !!pooled.approvalId })
          pooled.presence.leave()
          if (pooled.refreshTimer) {
            clearTimeout(pooled.refreshTimer)
            pooled.refreshTimer = null
          }
          clearDenyTimer(pooled)
          pool.delete(pooled)
          // A session a phone was using ended: its replacement listener was already opened in
          // onPeerReady, so topping up is normally a no-op. An IDLE listener dropping on its own is
          // different — our refresh closes intentionally (no onClose), so this is the relay
          // refusing or unreachable, and re-minting at once is the tight loop the backoff exists
          // to prevent.
          if (pooled.bridged) ensurePool()
          else scheduleReconnect()
        }
      })
      pool.add(pooled)
      opened = true
      scheduleRefreshFor(pooled, token.ttlMs)
      // A listener is registered at the relay → advertise the identity for LATE ADOPTION
      // (~/.nodeterm/relay.json — see relay-advertise.ts): a phone whose pairing predates the
      // toggle reads it over its SSH bootstrap and gains a relay leg without re-pairing.
      // Written here (not in start()) so it only exists while the host is genuinely reachable.
      const pub = publicKeyToB64(keys.publicKey)
      void writeRelayAdvertisement({
        v: 1,
        hostId: hostIdFromPublicKeyB64(pub),
        hostPublicKeyB64: pub,
        relayEndpoint: RELAY_URL,
        hostDeviceId: getDeviceId()
      })
    } finally {
      opening = false
      // If we're still short (e.g. TARGET_PENDING > 1, or one was consumed while minting), continue.
      if (opened && running && pendingCount() < TARGET_PENDING) queueMicrotask(() => void connectOne())
    }
  }

  // Revocation (peer-revoke.ts): cut every pooled session held by a matching key — bridged or still
  // awaiting SAS — and drop any pending consent for it, including one whose socket already closed
  // (#819 keeps those alive for the SAS deadline). Otherwise a phone "Remove" would leave the removed
  // phone in its shell until the socket dropped, or let an open dialog re-pin it afterwards.
  registerPeerSessionKiller('phone', (match) => {
    const keys = new Set<string>()
    approvals.clearWhere((key) => {
      if (!match(key)) return false
      keys.add(key) // consent may outlive its browse socket, but never the revoke
      return true
    })
    for (const p of pool) {
      const key = p.session.peerPublicKeyB64() ?? p.approvalPub
      if (key && match(key)) keys.add(key)
    }
    let failure: unknown = null
    for (const key of keys) {
      rememberRevokedStandingPhone(key)
      try { revokePeer(key) }
      catch (err) { failure ??= err }
    }
    if (failure) throw failure
  })

  function start(): void {
    if (running) return
    running = true
    runningHosts.add(revokePeer)
    reconnectAttempt = 0
    popRefusals = 0
    ensurePool()
  }

  function stop(): void {
    running = false
    runningHosts.delete(revokePeer)
    approvals.stop()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    for (const p of [...pool]) removeFromPool(p)
    // Host gone from the relay → stop advertising, so phones don't mint tokens against a
    // host that will never answer.
    void removeRelayAdvertisement()
  }

  function reconcile(): void {
    const want = enabled && relayAllowed()
    if (want && !running) start()
    else if (!want && running) stop()
  }

  // Dedicated request/reply channel: a missing IPC handler rejects instead of silently
  // discarding consent. Never expose this host-security operation through the relay RPC bridge.
  ipcMain.handle(IPC.remotePhoneApprove, async (event, msg: { id?: string; pub?: string }) => {
    if (event.sender !== win.webContents) return { status: 'stale' as const }
    console.info('[phone-approval] received')
    const result = await approvals.approve(msg)
    console.info('[phone-approval] result', result.status)
    if (result.status !== 'persisted') return result
    let connected = false
    for (const p of pool) {
      if (p.bridged && p.session.peerPublicKeyB64() === msg.pub) {
        if (p.approvalId) approvals.clear(p.approvalId)
        p.approvalId = null
        p.approvalPub = null
        p.session.approve()
        connected = true
      }
    }
    return { status: connected ? 'approved' as const : 'saved-disconnected' as const }
  })
  ipcMain.on(IPC.remoteHostReject, (event, msg: { id?: string; pub?: string } = {}) => {
    if (event.sender !== win.webContents || !approvals.reject(msg)) return
    for (const p of [...pool]) {
      if (p.approvalPub === msg.pub) removeFromPool(p)
    }
    ensurePool()
  })

  return {
    setEnabled(next) {
      enabled = next
      reconcile()
    },
    syncFromSettings() {
      enabled = !!getSettings().phoneAccessEnabled
      reconcile()
    },
    stop
  }
}

// ---------------------------------------------------------------------------------------------
// MANUAL SMOKE TEST (documented here, NOT automated — the live round-trip needs the deployed or a
// local relay + the iOS client, like test/remote/relay-e2e.test.ts's block):
//
//   Prereqs: a Pro-entitled desktop build (or NODETERM_RELAY_URL + NODETERM_API_BASE pointing at a
//   local relay/API), the nodeterm iOS app, and a phone already paired over the LAN.
//     1. Desktop: Settings → Phone → toggle "Remote access from your phone" ON. Main mints a
//        host-token (POST /v1/relay/host-token) and registers as role:'host' under hostId =
//        base64url(sha256(hostPublicKey)).slice(0,22).
//     2. Re-pair (or pair) the phone: the /pair response + QR now carry `relay {hostId,
//        hostPublicKeyB64, relayEndpoint}` + `relayDeviceToken`. Confirm the phone stored them.
//     3. Put the phone on cellular (OFF the LAN). It joins the relay (POST /v1/relay/join →
//        role:'client' under the same hostId) and bridges to the standing host.
//     4. FIRST connect: the desktop shows the SAS approval dialog. Approve → the phone attaches to
//        a tmux session (pty.attach) and the terminal streams. The device pubkey is pinned.
//     5. Disconnect + reconnect the phone: it now auto-approves (no dialog) — pin-once verified.
//     6. Leave it idle ~2 min: the host re-mints its token + reconnects (watch it stay reachable).
//     7. Toggle the setting OFF (or deactivate Pro): the standing host tears down; the phone can
//        no longer reach the Mac over the relay (LAN pairing still works).
//   Throughout, the relay only forwards opaque E2EE boxes — it never sees plaintext.
// ---------------------------------------------------------------------------------------------

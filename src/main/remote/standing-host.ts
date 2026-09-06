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
//     connects auto-approve silently.
//
// The heavy lifting (relay wiring, RPC/frame handlers, fs jail, canvas mirror, approval gate) is
// shared with the interactive host via `connectHostSession`. Pin/lookup logic is the pure,
// unit-tested `approved-devices-core`.

import { randomUUID } from 'crypto'
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
import { currentCanvas, initHostCanvasHub, subscribeCanvas } from './host-canvas-hub'
import { hostIdFromPublicKeyB64 } from './relay-id'
import { removeRelayAdvertisement, writeRelayAdvertisement } from './relay-advertise'
import { isPinned, pinDevice } from './approved-devices-core'
import { loadApprovedDevices, saveApprovedDevices } from './approved-devices'

// Re-mint the token this long before its expiry (TTL is ~120s). Floored so a bogus/short exp can't
// spin us.
const REFRESH_LEAD_MS = 30_000
const MIN_REFRESH_MS = 15_000
const DEFAULT_TTL_MS = 120_000
// Bounded backoff for reconnect after a socket close / mint failure.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000]

interface HostTokenResponse {
  pairingToken: string
  hostId: string
  exp: number
}

/**
 * Mint a standing host token from the API. Pro proves entitlement; the free tier sends
 * its deviceId instead (backend admits it against the server-side free-tier policy —
 * until that ships, the mint fails and free hosting simply stays down, i.e. today's
 * behavior). Returns null on any failure.
 */
async function mintHostToken(
  entitlement: string | null,
  hostPublicKeyB64: string
): Promise<HostTokenResponse | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${API_BASE}/v1/relay/host-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        entitlement ? { entitlement, hostPublicKeyB64 } : { deviceId: getDeviceId(), hostPublicKeyB64 }
      ),
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => ({}))) as Partial<HostTokenResponse>
    if (!json.pairingToken) return null
    return { pairingToken: json.pairingToken, hostId: json.hostId ?? '', exp: json.exp ?? 0 }
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

export interface StandingHost {
  /** Explicit toggle (from the Settings switch). Reconciles the connection immediately. */
  setEnabled(enabled: boolean): void
  /** Read the desired state from settings (launch / external change) and reconcile. */
  syncFromSettings(): void
  /** Tear everything down (e.g. app quit). */
  stop(): void
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
  bridge: HostBridgeDeps = {}
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
    approvalTimer: ReturnType<typeof setTimeout> | null
    refreshTimer: ReturnType<typeof setTimeout> | null
  }

  let enabled = false
  let running = false
  let opening = false // guards against overlapping connectOne() calls
  const pool = new Set<Pooled>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

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

  function clearApproval(p: Pooled): void {
    if (p.approvalTimer) {
      clearTimeout(p.approvalTimer)
      p.approvalTimer = null
    }
    p.approvalPub = null
    p.approvalId = null
  }

  function removeFromPool(p: Pooled): void {
    clearApproval(p)
    p.presence.leave()
    if (p.refreshTimer) {
      clearTimeout(p.refreshTimer)
      p.refreshTimer = null
    }
    pool.delete(p)
    p.session.close()
  }

  // The peer's box key is STABLE across the phone's reconnect churn while the per-attach id
  // dies with each socket, so an Approve clicked mid-retry still lands when matched by pub
  // (issue #372's race note). The id stays as the exact-match fallback.
  function findPending(msg: { id?: string; pub?: string }): Pooled | null {
    if (msg.pub) for (const p of pool) if (p.approvalPub && p.approvalPub === msg.pub) return p
    if (msg.id) for (const p of pool) if (p.approvalId && p.approvalId === msg.id) return p
    return null
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

  function scheduleRefreshFor(p: Pooled, exp: number): void {
    if (p.refreshTimer) clearTimeout(p.refreshTimer)
    const untilExpMs = exp > 0 ? exp * 1000 - Date.now() : DEFAULT_TTL_MS
    const delay = Math.max(MIN_REFRESH_MS, untilExpMs - REFRESH_LEAD_MS)
    p.refreshTimer = setTimeout(() => {
      p.refreshTimer = null
      if (!running || !pool.has(p)) return
      // A listener serving a client (bridged) is left alone — never cut an active session for a
      // token refresh; the relay drops it at TTL and onClose replaces it. Only an IDLE listener is
      // re-minted with a fresh token by dropping it and topping the pool back up.
      if (p.bridged) {
        scheduleRefreshFor(p, 0)
        return
      }
      removeFromPool(p)
      ensurePool()
    }, delay)
    p.refreshTimer.unref?.()
  }

  // A phone completed the E2EE handshake on `pooled`'s listener. Mark it bridged (→ open a
  // replacement listener), then approve: pinned device → silent; unknown → prompt the human.
  async function onPeerReady(pooled: Pooled): Promise<void> {
    if (!pooled.bridged) {
      pooled.bridged = true
      // Team presence: a bridged relay client is a peer. It has no mouse, so it stays cursorless
      // and appears in the facepile only — see docs/team-presence.md ("Peers may have no cursor").
      pooled.presence.join()
      ensurePool() // this listener now serves a client → restore a warm one
    }
    const s = pooled.session
    const pub = s.peerPublicKeyB64()
    let store
    try {
      store = await loadApprovedDevices()
    } catch {
      store = { pubkeys: [] as string[] }
    }
    if (!pool.has(pooled)) return // torn down while the disk read was in flight
    if (pub && isPinned(store, pub)) {
      s.approve() // pinned device → auto-approve silently
      return
    }
    // Unknown device → require the host human's approval (shared SAS dialog). Remember the pubkey +
    // a fresh id on THIS pooled session, so approval pins it even if the phone's browse socket
    // closes first, and only the matching approve id acts on it.
    pooled.approvalPub = pub
    pooled.approvalId = randomUUID()
    if (pooled.approvalTimer) clearTimeout(pooled.approvalTimer)
    pooled.approvalTimer = setTimeout(() => {
      const expiredId = pooled.approvalId
      pooled.approvalPub = null
      pooled.approvalId = null
      pooled.approvalTimer = null
      // Tell the renderer the prompt died — without this the dialog outlives the id and
      // Approve becomes a silent no-op (issue #372).
      send(IPC.remoteHostPeerPendingCleared, { id: expiredId, pub })
    }, 120_000)
    pooled.approvalTimer.unref?.()
    // `pub` rides along so the renderer can key the dialog on the STABLE device identity: a
    // retry-churning phone re-raises this event with a fresh id but the same pub + SAS, and
    // the open dialog just updates in place instead of flashing.
    send(IPC.remoteHostPeerPending, { sas: s.sas(), id: pooled.approvalId, pub })
  }

  async function connectOne(): Promise<void> {
    if (!running || opening || pendingCount() >= TARGET_PENDING) return
    opening = true
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
      const token = await mintHostToken(entitlement, publicKeyToB64(keys.publicKey))
      if (!running) return
      if (!token) {
        scheduleReconnect()
        return
      }
      reconnectAttempt = 0
      const pooled: Pooled = {
        session: null as unknown as HostSession,
        bridged: false,
        presence: createPhonePresence(),
        approvalPub: null,
        approvalId: null,
        approvalTimer: null,
        refreshTimer: null
      }
      pooled.session = connectHostSession({
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
        extraRoots: bridge.workspaceRoots,
        // Typing attribution: this pooled session's input frames are ITS phone's keystrokes.
        getClientId: () => pooled.presence.id(),
        onPeerReady: () => void onPeerReady(pooled),
        onClose: () => {
          clearApproval(pooled)
          pooled.presence.leave()
          if (pooled.refreshTimer) {
            clearTimeout(pooled.refreshTimer)
            pooled.refreshTimer = null
          }
          pool.delete(pooled)
          ensurePool() // a listener/session dropped → top the pool back up
        }
      })
      pool.add(pooled)
      scheduleRefreshFor(pooled, token.exp)
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
      if (running && pendingCount() < TARGET_PENDING) queueMicrotask(() => void connectOne())
    }
  }

  function start(): void {
    if (running) return
    running = true
    reconnectAttempt = 0
    ensurePool()
  }

  function stop(): void {
    running = false
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

  // Host human approved / rejected a pending phone (by its pending id). Shared with the interactive
  // host; the id scoping means each acts only on its own pending session.
  ipcMain.on(IPC.remoteHostApprove, (_e, msg: { id?: string; pub?: string } = {}) => {
    const p = findPending(msg ?? {})
    if (!p) return
    // Pin the DEVICE (its stable box key), whether or not its session is still live — the phone's
    // browse socket may have already closed. Prefer the live peer's key, else the remembered one.
    const pub = p.session.peerPublicKeyB64() ?? p.approvalPub
    clearApproval(p)
    if (pub) {
      void loadApprovedDevices()
        .then((store) => saveApprovedDevices(pinDevice(store, pub)))
        .catch(() => {
          // A failed pin is non-fatal: the device re-prompts next connect. Never block on the write.
        })
    }
    p.session.approve()
  })
  ipcMain.on(IPC.remoteHostReject, (_e, msg: { id?: string; pub?: string } = {}) => {
    const p = findPending(msg ?? {})
    if (!p) return
    removeFromPool(p) // drop this rejected session
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

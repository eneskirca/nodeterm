// The interactive-host DRIVER (docs/remote-sessions.md 4c; Team Access, docs/superpowers/specs
// 2026-07-15-team-access-design.md): give the reviewed `connectRelayHost` machinery an IPC surface.
// `initRelayHost` is the Stage-4 twin of the legacy `initRemoteHost` (host-service.ts) — it runs
// BESIDE it (the phone still uses the old flow; that is deleted with the dialect in Task 10). It
// shares the same offer format and pairing-token mint, but everything a bridged peer does afterwards
// flows through `connectRelayHost` (→ `platform.dispatch`/`cast`), not the legacy phone RPC vocabulary.
//
// TEAM ACCESS — a POOL, not one listener. A paying host shares this Mac with up to `seats` devices
// (one seat per connected device). This module manages a POOL of independent `RelayHostSession`s;
// each seat still goes through the UNCHANGED per-session mutual-SAS + ConsentNotice gate in
// relay-host.ts. `relay:host:invite` (and the legacy `relay:host:start`) ADD a seat (cap-checked, no
// supersede); `relay:host:revoke` cuts ONE; `stop()` closes ALL.
//
// SECURITY — nothing is served before MUTUAL approval. This file only FORWARDS the reviewed gate:
//   - `onPeerPending` (the E2EE handshake completed, the SAS is known) → send `relay:host:peer-pending`
//     to the renderer and WAIT. The peer is NOT a client yet: connectRelayHost registers no sink and
//     joins no presence until its trust gate's `onOpen` fires (BOTH humans confirmed the same SAS).
//   - the human's `relay:host:confirm` → `session.confirm()` (this file's only local-confirm call
//     site; src/core/relay/relay-trust.ts lists every one).
//   - `onOpen` (mutual) → `relay:host:open`; `onClose` (socket gone) → `relay:host:closed`.
// This module never dispatches peer traffic, never registers a sink, never touches a handler — it
// cannot serve a peer early even by accident, because it holds none of the machinery that serves.
//
// REVOCATION reaches sessions started here for free: `connectRelayHost` adds every session to its own
// module-level `live` set, and relay-host.ts registers a killer over THAT set with the one revoke
// primitive (peer-revoke.ts) — independent of the bookkeeping below. `relay:host:revoke` here uses
// the same primitive, and also unpins the guest's key.
import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ElectronPlatform } from '../platform-electron'
import { connectRelayHost, killRelayHostsByPeerKey, type RelayHostSession } from './relay-host'
import type { RelayTransport } from './relay-socket'
import { publicKeyToB64, type KeyPair } from './e2ee'
import { encodeOffer } from './pairing'
import { loadOrCreatePeerKeyPair } from './peer-identity'
import { isPremium as licenseIsPremium, getStoredEntitlement, licensedSeats as licenseSeats } from '../../core/license'
import { RELAY_URL, relayAllowed as hostRelayAllowed, mintPairingToken } from './host-service'
import { canAcceptSeat } from './seat-cap'
import type { ScopedGuestDeps } from '../../core/relay/scoped-guest-policy'
import { revokePeerKey } from './peer-revoke'

/** Thrown (as an Error message) when a new invite would exceed the licensed seat cap. The renderer
 *  maps it to "All seats in use — add a seat." Host-side/UX enforcement only (see below). */
export const E_SEATS_FULL = 'E_SEATS_FULL'

/** Injectable seams — production defaults hit the real license gate / API / OS keyring; tests pass
 *  an in-process transport, a fake mint, and a fixed keypair so nothing touches the network. */
export interface RelayHostDeps {
  /** Relay wss URL (defaults to RELAY_URL). */
  url?: string
  /** TEST ONLY: an in-process RelayTransport forwarded into `connectRelayHost`. */
  transport?: RelayTransport
  /** The long-lived peer identity this desktop presents (defaults to loadOrCreatePeerKeyPair). */
  loadKeys?: () => Promise<KeyPair>
  /** Mint the single-use pairing token (defaults to the shared `mintPairingToken`). */
  mintToken?: (entitlement: string) => Promise<{ pairingToken: string }>
  isPremium?: () => boolean
  relayAllowed?: () => boolean
  getEntitlement?: () => string | null
  /** The licensed seat cap (Team Access). Defaults to the real `licensedSeats()` (core/license.ts). */
  licensedSeats?: () => number
  /** TEST ONLY: override the wire-up (defaults to `connectRelayHost`). */
  connect?: typeof connectRelayHost
  /** What a project-scoped seat's policy reads from this core (scoped-guest-policy.ts). A scoped
   *  invite without it is refused (connectRelayHost throws before any socket opens). */
  scope?: ScopedGuestDeps
}

/** Metadata options for a new seat. `email` is a DISPLAY label only (never trust/identity — the SAS
 *  is the gate); it tags the pending/live seat in the Team Access list. */
export interface AddSeatOptions {
  projectId?: string
  email?: string
}

export interface RelayHost {
  /** Tear down EVERY listener / bridged peer in the pool (app quit). Idempotent. */
  stop(): void
}

/**
 * Wire the interactive relay-host IPC. `relay:host:invite` (and legacy `relay:host:start`) gate on
 * Pro + a free seat, mint a pairing token, open a NEW relay host listener via `connectRelayHost`, and
 * return the offer to hand to a peer — ADDING it to the pool (no supersede). `relay:host:confirm`
 * approves a pending peer; `relay:host:revoke` cuts one; `relay:host:stop` tears the whole pool down.
 */
export function initRelayHost(
  win: BrowserWindow,
  platform: ElectronPlatform,
  deps: RelayHostDeps = {}
): RelayHost {
  const url = deps.url ?? RELAY_URL
  const connect = deps.connect ?? connectRelayHost
  const loadKeys = deps.loadKeys ?? loadOrCreatePeerKeyPair
  const mintToken = deps.mintToken ?? mintPairingToken
  const isPremium = deps.isPremium ?? licenseIsPremium
  const relayAllowed = deps.relayAllowed ?? hostRelayAllowed
  const getEntitlement = deps.getEntitlement ?? getStoredEntitlement
  const licensedSeats = deps.licensedSeats ?? licenseSeats

  // The POOL, keyed by renderer id (Team Access). One entry per SEAT — inserted SYNCHRONOUSLY when the
  // seat is minted (reserve-before-await; see addSeat) and removed on close/revoke/stop. `byId.size` is
  // the reserved+pending+live seat count the cap compares against `licensedSeats()`. `session` is
  // `null` while the seat is reserved but its listener has not been wired yet (the brief window across
  // the token mint), then the live `RelayHostSession`; `email` is the invite label (display only) that
  // rides this seat's peer-pending/open events. The renderer id is the SAME token from mint through
  // peer-pending/open/close and revoke, so a stray IPC event can only ever act on the seat it names,
  // and a pending-never-connected seat is revocable from the moment it is minted. Replaces the old
  // dual `byId`/`pool` bookkeeping — one map keyed by the id the UI and revoke already use.
  const byId = new Map<string, { session: RelayHostSession | null; email?: string }>()

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  /**
   * Mint ONE pairing + open ONE relay host listener, ADDING it to the pool (no supersede). Cap-checked
   * against the licensed seats. The seat is RESERVED synchronously (with its revocable id) before any
   * await, then filled in once the listener is wired. Returns the offer to hand to the invited device
   * plus the seat's renderer `id`.
   */
  async function addSeat({ projectId, email }: AddSeatOptions): Promise<{ offer: string; id: string }> {
    if (!isPremium()) {
      throw new Error('Remote access requires nodeterm Pro.')
    }
    if (!relayAllowed()) {
      throw new Error('Remote access is unavailable in development builds (set NODETERM_RELAY_URL).')
    }
    const entitlement = getEntitlement()
    if (!entitlement) {
      throw new Error('No entitlement found — please re-activate nodeterm Pro.')
    }

    // SEAT CAP + RESERVATION — atomic (no await between reading the count and reserving). The count is
    // minted (reserved + pending + live) seats. This is HOST-SIDE / UX enforcement, NOT a
    // server-guaranteed limit: a host that patched it out only cheats itself (it is paying for the
    // seats). Real, un-bypassable enforcement is v2, server-side (the relay refuses the (seats+1)th
    // bridge per account). Do NOT close others here — Team Access is ADDITIVE.
    if (!canAcceptSeat(byId.size, licensedSeats())) {
      throw new Error(E_SEATS_FULL)
    }
    // Reserve the seat SYNCHRONOUSLY — with a revocable id — before any await, so two concurrent
    // invites can't both pass the cap across the token-mint latency (Finding 1), and so a
    // pending-never-connected seat is revocable from the moment it's minted (Finding 2). `session` is
    // filled in once `connect()` wires the listener below.
    const rendererId = randomUUID()
    byId.set(rendererId, { session: null, email })

    try {
      // A locked keyring surfaces here as a rejected invite (PeerKeyLockedError / E_PEER_KEY_LOCKED):
      // the identity on disk is intact and must not be rotated — the renderer tells the human to unlock.
      const keys = await loadKeys()
      const { pairingToken } = await mintToken(entitlement)

      const session = connect({
        url,
        token: pairingToken,
        ourKeys: keys,
        platform,
        transport: deps.transport,
        // The single project this hosting session shares with the peer. Absent → unscoped, as before.
        // Present → every peer message is judged by the scoped-guest policy over `deps.scope`.
        sharedProjectId: projectId,
        scope: deps.scope,
        // The SAS is known — ask the human to compare it. NOTHING is served yet. Reuse the reserved
        // id (do NOT mint a fresh one) so onOpen/onClose/revoke all name the same seat.
        onPeerPending: (s) => {
          const entry = byId.get(rendererId)
          if (entry) entry.session = s
          send(IPC.relayHostPeerPending, {
            id: rendererId,
            sas: s.sas(),
            peerKeyB64: s.peerKeyB64() ?? '',
            email
          })
        },
        // Both humans confirmed: the peer is a live CorePlatform client now.
        onOpen: () => {
          send(IPC.relayHostOpen, { id: rendererId, email })
        },
        // The relay socket dropped (the peer is already torn down when this fires). Free the seat.
        onClose: () => {
          byId.delete(rendererId)
          send(IPC.relayHostClosed, { id: rendererId })
        }
      })

      // Fill the reserved slot with the live session. If it was revoked during the await window the
      // entry is gone — don't leak a live listener; close it.
      const entry = byId.get(rendererId)
      if (entry) entry.session = session
      else session.close()

      return {
        offer: encodeOffer({
          relayEndpoint: url,
          pairingToken,
          hostPublicKeyB64: publicKeyToB64(keys.publicKey)
        }),
        id: rendererId
      }
    } catch (err) {
      // Mint/keyring/connect failed after we reserved the slot — roll the reservation back so a failed
      // invite doesn't leak a seat.
      byId.delete(rendererId)
      throw err
    }
  }

  // Legacy entry point (RemoteAccessDialog / RemoteSection). Now ADDITIVE + cap-checked (no supersede)
  // — with cap 1 this is bit-for-bit today's single-peer behavior (a 2nd start is refused until the
  // first drops), and with cap N it adds a seat. Returns `{ offer, id }`; the legacy dialogs
  // destructure `{ offer }` and ignore `id` (additive, non-breaking).
  ipcMain.handle(IPC.relayHostStart, (_e, projectId?: string): Promise<{ offer: string; id: string }> =>
    addSeat({ projectId })
  )

  // Team Access entry point (Settings → Team Access, Task 4): add a seat tagged with the invitee email.
  // Returns `{ offer, id }` — the settings UI uses `id` to show the pending row immediately and revoke it.
  ipcMain.handle(
    IPC.relayHostInvite,
    (_e, opts: AddSeatOptions = {}): Promise<{ offer: string; id: string }> =>
      addSeat({ projectId: opts?.projectId, email: opts?.email })
  )

  // The human compared the SAS and pressed Confirm → advance the trust gate for THAT peer. Only the
  // session named by the id is touched; an unknown id (stale event) or a reserved-not-yet-open seat is
  // a no-op.
  ipcMain.on(IPC.relayHostConfirm, (_e, msg: { id?: string } = {}) => {
    const entry = msg?.id ? byId.get(msg.id) : undefined
    entry?.session?.confirm()
  })

  // Per-peer revoke (Team Access, closes the 4c follow-up): cut ONE bridged peer's LIVE socket
  // immediately and free its seat. Works for BOTH a live peer AND a reserved-but-never-connected seat
  // (the id exists from mint). Only the seat named by the id is touched; an unknown/stale id is a no-op.
  ipcMain.on(IPC.relayHostRevoke, (_e, msg: { id?: string } = {}) => {
    const entry = msg?.id ? byId.get(msg.id) : undefined
    if (!entry) return
    // A reserved-but-not-yet-open seat has no live socket to cut (`session` null, or a session with no
    // peer key yet) — freeing the reservation is all that's owed. A live peer is cut by IDENTITY:
    // `killRelayHostsByPeerKey` closes every live session holding that key, synchronously, before any
    // await. Then the revoke primitive (peer-revoke.ts) unpins the key from the GUEST store and runs
    // the cut again across every host surface (idempotent). The unpin matters even though a desktop
    // guest pin never auto-admits: it used to share a file with the phone pins, which the standing
    // host DID auto-admit from, so a revoked guest stayed a silently-admitted "phone". The stores are
    // split now (approved-devices.ts), and a revoked seat leaves no pin behind in any of them.
    // Host-side revoke + the seat cap are UX/host enforcement, NOT a server-guaranteed limit
    // (v2 = server-side).
    const peerKeyB64 = entry.session?.peerKeyB64()
    // killRelayHostsByPeerKey → session.close() does NOT fire our `onClose` (that runs only on a wire
    // drop, not a local close), so free the seat and notify the renderer here.
    if (peerKeyB64) {
      killRelayHostsByPeerKey(peerKeyB64)
      void revokePeerKey(peerKeyB64, ['guest']).then((r) => {
        if (!r.persisted || !r.killed) console.warn('[relay-host] seat revoke incomplete', r)
      })
    }
    byId.delete(msg.id!)
    send(IPC.relayHostClosed, { id: msg.id })
  })

  const stop = (): void => {
    for (const { session } of byId.values()) session?.close()
    byId.clear()
  }

  ipcMain.handle(IPC.relayHostStop, () => {
    stop()
  })

  return { stop }
}

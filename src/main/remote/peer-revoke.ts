// THE revoke primitive for relay peers: unpin a box public key AND close every live session that
// key authenticated. Every revoke path goes through `revokePeerKey` — phone "Remove"
// (pairing-service.ts), the Team Access seat revoke (relay-host-service.ts) and the
// `remote:revoke-peer` control channel (index.ts) — so none of them can do half of it.
//
// Why both halves (revocation.ts states it in full): unpinning refuses only the NEXT handshake; an
// open relay socket keeps its shell until it drops on its own. And why a REGISTRY of killers: the
// sessions a key can hold live in three unrelated places — the standing phone host's pool
// (standing-host.ts), the interactive phone host's single session (host-service.ts
// `initRemoteHost`) and the desktop relay host's `live` set (relay-host.ts). A revoke that knows
// only one of them (the old `onRevoke: killRelayHostsByPeerKey`) leaves the other two serving.
// Each host registers its killer when it is wired; `killPeerSessionsByKey` runs them all.
import { createRevoker, type RevokeResult } from './revocation'
import { pinStore, type PinRole } from './approved-devices'

/** Which kind of peer a host serves: the phone vocabulary (standing + interactive phone hosts) or
 *  the desktop Team Access vocabulary (relay-host.ts). */
export type PeerSurface = 'phone' | 'desktop'

/**
 * Close every live session this host holds whose peer key satisfies `match` — bridged, approved,
 * or still awaiting its SAS decision (a pending consent must not outlive the revoke either).
 */
export type PeerSessionKiller = (match: (peerKeyB64: string) => boolean) => void

const killers = new Map<PeerSessionKiller, PeerSurface>()

/** Register a host's killer. Returns the unregister function. */
export function registerPeerSessionKiller(surface: PeerSurface, kill: PeerSessionKiller): () => void {
  killers.set(kill, surface)
  return () => {
    killers.delete(kill)
  }
}

/**
 * Run the registered killers (of the given surfaces). One killer throwing must not spare the
 * sessions the others hold, so all run first; then the first error is rethrown so the caller
 * (createRevoker) reports `killed:false` rather than a cut that did not fully happen.
 */
export function killPeerSessions(
  match: (peerKeyB64: string) => boolean,
  surfaces: readonly PeerSurface[] = ['phone', 'desktop']
): void {
  let failure: unknown = null
  for (const [kill, surface] of [...killers]) {
    if (!surfaces.includes(surface)) continue
    try {
      kill(match)
    } catch (err) {
      failure ??= err
    }
  }
  if (failure) throw failure
}

/** Close every live session, on every surface, authenticated by exactly this key. */
export function killPeerSessionsByKey(peerKeyB64: string): void {
  if (!peerKeyB64) return
  killPeerSessions((k) => k === peerKeyB64)
}

/**
 * Unpin `peerKeyB64` from each named role store, then close every live session it holds. The kill
 * fires even when the unpin failed (a persistence error must never leave a revoked peer connected);
 * the result reports both legs, per revocation.ts's contract.
 */
export function revokePeerKey(peerKeyB64: string, roles: readonly PinRole[]): Promise<RevokeResult> {
  const stores = roles.map(pinStore)
  return createRevoker({
    // Unused: `update` is always provided, and createRevoker prefers it.
    load: () => Promise.reject(new Error('unused')),
    save: () => Promise.reject(new Error('unused')),
    async update(change) {
      // Every store is attempted; the first failure is rethrown afterwards (persisted:false).
      let failure: unknown = null
      for (const store of stores) {
        try {
          await store.update(change)
        } catch (err) {
          failure ??= err
        }
      }
      if (failure) throw failure
    },
    onRevoke: killPeerSessionsByKey
  }).revoke(peerKeyB64)
}

/**
 * What a phone "Remove" does: unpin EVERY phone the standing host has pinned and close EVERY live
 * phone relay session (standing and interactive hosts, approved or awaiting SAS). Desktop Team
 * Access sessions are not touched.
 *
 * Legacy fallback only: older pairing records have no relay box key, so the removed phone cannot
 * be identified precisely. A phone approved on the interactive host may not be pinned at all.
 * Cutting a guessed key could leave the removed phone connected; this fallback costs every OTHER
 * phone a reconnect and one SAS comparison. Pairings that recorded the key use exact-key revoke.
 */
export async function revokeAllPhones(): Promise<RevokeResult> {
  let persisted = true
  try {
    await pinStore('phone').update(() => ({ pubkeys: [] }))
  } catch {
    // The old file is left intact on a failed write (writeFileAtomic): the pins may survive, so
    // the caller must keep the device listed and let the owner retry.
    persisted = false
  }
  let killed = true
  try {
    killPeerSessions(() => true, ['phone'])
  } catch {
    killed = false
  }
  return { persisted, killed }
}

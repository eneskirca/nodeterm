// Peer revocation for the relay trust layer.
//
// THE CRITICAL PROPERTY: unpinning a peer's key is NOT enough. Unpinning only refuses the NEXT
// handshake; the currently-open relay socket keeps full shell access (an interactive shell, files,
// canvas) until it drops on its own — i.e. "the person I just removed is still sitting in my
// terminal, typing". So revocation MUST also cut the live session. Anyone tempted to "simplify" this
// module into a pin-store delete would silently reintroduce exactly that hole.
//
// 4d ships the pure unpin + the hook contract; 4c implements the teardown body:
//     onRevoke(peerId) = close the peer's relay connection
//                      → PtyManager.dropClient(clientId)   (drop its pty subscriptions)
//                      → presenceHub.leave(clientId)       (remove it from the facepile)
// which is the same teardown `peer-registry.ts` runs when a peer sink unregisters.
//
// (peerId is the peer's stable box public key, base64 — the same identity the pin store and 4c's
// live-session registry key on.)
import { unpinDevice, type ApprovedDevices } from './approved-devices-core'

/** Pure: return a store with the peer's pin removed. Idempotent. */
export function revoke(store: ApprovedDevices, peerKeyB64: string): ApprovedDevices {
  return unpinDevice(store, peerKeyB64)
}

/**
 * 4c implements this to KILL the live session (see file header). The teardown is async in 4c
 * (close relay conn → PtyManager.dropClient → presenceHub.leave), so the hook may return a Promise;
 * `createRevoker` awaits it so `revoke()` only resolves once the cut is real and a teardown
 * rejection is observable rather than an unhandled rejection. A plain sync `void` impl still fits.
 */
export type OnRevoke = (peerId: string) => void | Promise<void>

export interface RevocationDeps {
  load(): Promise<ApprovedDevices>
  save(store: ApprovedDevices): Promise<void>
  update?(change: (store: ApprovedDevices) => ApprovedDevices): Promise<void>
  onRevoke: OnRevoke
}

/**
 * Outcome of a revoke. Both steps are reported independently so the caller (4c's trust UI) can
 * always know the session was cut AND whether it must retry the unpin.
 */
export interface RevokeResult {
  /**
   * `true` iff the unpin was loaded and written to disk. `false` means the pin may SURVIVE — the
   * real adapter's `saveApprovedDevices` does temp+rename, so a failed write leaves the OLD still-
   * pinned file byte-for-byte intact — so the revoked peer could reconnect and auto-approve with no
   * SAS. The caller MUST retry and MUST NOT show a "Removed" success.
   */
  persisted: boolean
  /**
   * `true` iff `onRevoke` (the live-session teardown) completed without throwing. `false` means the
   * socket may be half-torn-down and the cut is not confirmed.
   */
  killed: boolean
}

/**
 * Build the revoke controller. `revoke(peerKeyB64)` unpins the device on disk FIRST (so a crash
 * between the two steps, or a reconnect racing the teardown, still leaves the peer refused by the
 * pin check), THEN fires `onRevoke` to cut the open socket. The kill hook fires even when the key
 * was not pinned — a live, never-pinned session must still be killable — and even when the disk
 * write failed: a persistence error must never leave a revoked peer connected.
 *
 * Neither failure is swallowed. A persistence failure surfaces as `persisted:false` and a teardown
 * rejection as `killed:false`, so the trust UI can never report a false "Removed" while the pin
 * survives on disk (the security hole this module exists to prevent). A status object (rather than a
 * reject) is used because the kill genuinely DID fire even when persistence fails — the caller must
 * be able to distinguish "session cut, retry the unpin" from a total failure, which a single reject
 * cannot express.
 */
export function createRevoker(deps: RevocationDeps): {
  revoke(peerKeyB64: string): Promise<RevokeResult>
} {
  return {
    async revoke(peerKeyB64) {
      let persisted = false
      try {
        if (deps.update) await deps.update((store) => revoke(store, peerKeyB64))
        else await deps.save(revoke(await deps.load(), peerKeyB64))
        persisted = true
      } catch {
        // load() or save() threw. Do NOT swallow silently: the on-disk pin may be intact, so the
        // revoked peer could reconnect and auto-approve. Report persisted:false so the caller retries
        // and the UI cannot show "Removed". We STILL fire the kill below — the live socket must drop
        // regardless of the disk.
        persisted = false
      }

      let killed = false
      try {
        await deps.onRevoke(peerKeyB64)
        killed = true
      } catch {
        // The async teardown rejected. Surface it as killed:false instead of leaking an unhandled
        // rejection: the socket may be half-closed and the caller must know the cut is unconfirmed.
        killed = false
      }

      return { persisted, killed }
    }
  }
}

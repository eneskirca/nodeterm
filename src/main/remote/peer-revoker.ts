// The one revoker for a relay peer's box key, used by BOTH ways this desktop forgets someone:
// `remote:revoke-peer` (a peer desktop) and Settings → Phone → Revoke (a paired phone, through
// pairing-service's `revokeRelayKey`).
//
// revocation.ts holds the rule: persist the unpin FIRST, so a reconnect racing the teardown is
// already refused by the pin check, and THEN cut every live session of that key, even when the
// write failed. This module only names the sessions there are to cut. A phone's relay session lives
// in the standing host's pool and a peer desktop's in relay-host's live set, and a key is cut from
// both: unpinning alone left a forgotten phone that was connected at that moment serving terminals,
// files and the canvas until its socket dropped on its own (audit A07-revoke).
import { createRevoker, type RevokeResult } from './revocation'
import { loadApprovedDevices, saveApprovedDevices, updateApprovedDevices } from './approved-devices'
import { killRelayHostsByPeerKey } from './relay-host'
import { killStandingHostSessionsByPeerKey } from './standing-host'

export function createPeerRevoker(): { revoke(peerKeyB64: string): Promise<RevokeResult> } {
  return createRevoker({
    load: loadApprovedDevices,
    save: saveApprovedDevices,
    update: updateApprovedDevices,
    onRevoke: (peerKeyB64) => {
      // Both, even when one throws: a failure in one host must not leave the other's session open.
      // The first error is rethrown so the revoke reports `killed: false`.
      const errors: unknown[] = []
      for (const kill of [killRelayHostsByPeerKey, killStandingHostSessionsByPeerKey]) {
        try {
          kill(peerKeyB64)
        } catch (err) {
          errors.push(err)
        }
      }
      if (errors.length) throw errors[0]
    }
  })
}

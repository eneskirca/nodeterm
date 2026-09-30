// Pure state for SYMMETRIC pairing approval: both ends verify the same 6-digit SAS out of band and
// both pin the other's key. Today approval is one-way (only the host pins the client). This adds the
// second confirmation direction + the pin-both-ends bookkeeping as pure logic — no sockets, no
// Electron — so it unit-tests directly and 4c can wire it into either end's handshake.
//
// The SAS digits themselves are already identical on both ends (both derive from the same ECDH shared
// key via sasFromSharedKey); "mutual" means BOTH humans must confirm before the session opens, and
// EACH end independently pins the other's stable box public key. A man-in-the-middle on the relay
// terminates two DIFFERENT ECDH exchanges, so the two humans read out different digits and refuse —
// which is exactly why neither confirmation alone may unlock the session.
//
// SECURITY — this module is a correct latch ONLY if 4c (host-service / client-service) honours two
// obligations it cannot express in this pure file. Both are security-FATAL if broken, because pinning
// a key grants the peer SHELL ACCESS on this machine:
//
//   (a) `confirmRemote` MUST be driven ONLY by a frame received over the ENCRYPTED, session-keyed
//       channel (the box under deriveSessionKey), never from a plaintext/relay-visible message. The
//       relay is untrusted: if the peer's "I confirmed" signal can be forged or replayed by a relay
//       MITM, mutual approval silently degrades back to ONE-WAY — the attacker supplies the remote
//       confirmation the second human never gave, and a single local confirm then pins the attacker.
//       Only a frame that decrypts under THIS session's key proves the real peer sent it.
//
//   (b) There must be EXACTLY ONE `MutualApproval` per pairing attempt, created via
//       `emptyMutualApproval(peerKeyB64, sessionId)` from THIS session's ECDH peer key (the same key
//       whose shared secret produced the SAS the humans compared). Reusing a state across attempts,
//       or seeding it with a key other than this session's, re-opens the "confirm-for-a-different-
//       session" / "pin-the-wrong-key" holes this module's binding was built to close.
//
// This file makes the SAFE usage the ONLY compilable usage — the peer key + session identity are
// bound INTO the state at construction and the branded type has no other constructor — but it cannot
// reach across the seam to enforce (a) and (b). 4c owns those.
import { sasFromSharedKey } from './e2ee'
import { pinDevice, type ApprovedDevices } from './approved-devices-core'

/**
 * Approval state for ONE pairing attempt, BOUND at creation to the peer + session it approves.
 *
 * Opaque/branded: the `__brand` field has no runtime value and cannot be written by hand, so the
 * ONLY way to obtain a `MutualApproval` is `emptyMutualApproval()`, and the only way to mutate one is
 * `confirmLocal`/`confirmRemote`. A hand-forged `{ localConfirmed: true, remoteConfirmed: true, … }`
 * is a COMPILE ERROR. This turns "safe if every caller is disciplined" into "safe by construction":
 * you cannot fabricate an already-approved state, nor move a confirmation onto a different pairing,
 * because every state carries the one peer key + session it belongs to.
 */
export type MutualApproval = {
  /** This human confirmed the SAS on THIS device. */
  readonly localConfirmed: boolean
  /** The peer signalled (over the ENCRYPTED, session-keyed channel — see obligation (a)) that its human confirmed too. */
  readonly remoteConfirmed: boolean
  /** The peer's stable box public key (base64) from THIS session's ECDH — the ONLY key this state can ever pin. */
  readonly peerKeyB64: string
  /** Identity of the pairing attempt (session id or shared-key fingerprint) this state is bound to. */
  readonly sessionId: string
} & { readonly __brand: unique symbol }

/**
 * The sole constructor. Binds the peer's box public key + the session identity INTO the state, so a
 * confirmation can never be moved to a different pairing and `recordApproval` can only ever pin THIS
 * peer's key. Starts unconfirmed on both sides.
 */
export function emptyMutualApproval(peerKeyB64: string, sessionId: string): MutualApproval {
  return { localConfirmed: false, remoteConfirmed: false, peerKeyB64, sessionId } as MutualApproval
}

export function confirmLocal(s: MutualApproval): MutualApproval {
  return s.localConfirmed ? s : ({ ...s, localConfirmed: true } as MutualApproval)
}

export function confirmRemote(s: MutualApproval): MutualApproval {
  return s.remoteConfirmed ? s : ({ ...s, remoteConfirmed: true } as MutualApproval)
}

/**
 * Approved only when BOTH ends have confirmed the SAS. There is deliberately no other way to reach
 * this state: the two confirmations live on separate fields, each set by its own one-way transition,
 * so re-playing one side's confirmation (calling confirmLocal/confirmRemote twice) can never stand in
 * for the other's.
 */
export function isMutuallyApproved(s: MutualApproval): boolean {
  return s.localConfirmed && s.remoteConfirmed
}

/** The 6-digit code ("NNN NNN") BOTH ends compute + confirm. Thin alias so 4c reads clearly. */
export function mutualSas(shared: Uint8Array): string {
  return sasFromSharedKey(shared)
}

/**
 * Pin the peer's stable box public key locally — but ONLY once the SAS is mutually confirmed, so a
 * half-finished handshake never leaves a pinned identity. The key pinned is the one CARRIED BY the
 * state (`s.peerKeyB64`, bound at construction): there is no separate key argument, so a caller cannot
 * pin a key different from the one the two humans confirmed. Idempotent (pinDevice is). Each end calls
 * this against its OWN store; the state each end holds carries the OTHER end's key, so both ends pin.
 */
export function recordApproval(store: ApprovedDevices, s: MutualApproval): ApprovedDevices {
  if (!isMutuallyApproved(s)) return store
  return pinDevice(store, s.peerKeyB64)
}

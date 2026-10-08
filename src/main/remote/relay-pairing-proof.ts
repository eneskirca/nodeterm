import { createPublicKey, randomBytes, randomUUID, verify } from 'crypto'
import { performance } from 'perf_hooks'
import {
  RELAY_PAIRING_KEY, RELAY_PAIRING_SIGNATURE, RELAY_PAIRING_UUID, RELAY_PAIRING_PROOF_TTL_MS,
  relayPairingChallengeText, type RelayPairingChallenge, type RelayPairingChallengeResult,
  type RelayPairingProofResult, type RelayPairingStatus
} from '../../shared/relay-pairing-proof'

export interface LegacyRelayPairingTarget { pairingId: string; sshPublicKeyB64: string; entryVersion: string }
export type LegacyRelayPairingInspection = { status: RelayPairingStatus } | { status: 'eligible'; target: LegacyRelayPairingTarget }
/** Local pairing mutations only; neither method changes the approved-key store. */
export interface LegacyRelayPairings {
  inspect(pairingId: string, peerKey: string): Promise<LegacyRelayPairingInspection>
  associate(target: LegacyRelayPairingTarget, peerKey: string, current: () => boolean): Promise<RelayPairingProofResult>
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** One ephemeral, single-use proof belongs to one immutable approved relay connection. */
export function createRelayPairingProof(options: {
  hostKey: string; peerKey(): string | null; current(): boolean; pairings: LegacyRelayPairings
  now?: () => number; monotonicNow?: () => number
}) {
  const now = options.now ?? Date.now
  const monotonic = options.monotonicNow ?? (() => performance.now())
  let closed = false
  let generation = 0
  let inspecting = false
  let pending: { challenge: RelayPairingChallenge; target: LegacyRelayPairingTarget; deadline: number } | null = null
  const live = () => !closed && options.current()
  return {
    close(): void { closed = true; generation++; pending = null },
    async challenge(params: unknown): Promise<RelayPairingChallengeResult> {
      if (inspecting) return { status: 'unprovable' } // no unbounded queued disk inspections
      const request = record(params)
      const own = ++generation
      pending = null
      const peerKey = options.peerKey()
      if (!request || Object.keys(request).length !== 1 || typeof request.pairingId !== 'string' ||
          !RELAY_PAIRING_UUID.test(request.pairingId) || !live() || !peerKey ||
          !RELAY_PAIRING_KEY.test(peerKey) || !RELAY_PAIRING_KEY.test(options.hostKey)) return { status: 'unprovable' }
      let found: LegacyRelayPairingInspection
      inspecting = true
      try { found = await options.pairings.inspect(request.pairingId, peerKey) }
      finally { inspecting = false }
      if (!live() || own !== generation || options.peerKey() !== peerKey) return { status: 'expired' }
      if (found.status !== 'eligible') return found
      const challenge: RelayPairingChallenge = {
        version: 1, challengeId: randomUUID(), pairingId: request.pairingId, hostPublicKeyB64: options.hostKey,
        peerPublicKeyB64: peerKey, sshPublicKeyB64: found.target.sshPublicKeyB64,
        nonceB64: randomBytes(32).toString('base64'), expiresAtMs: now() + RELAY_PAIRING_PROOF_TTL_MS
      }
      relayPairingChallengeText(challenge)
      Object.freeze(challenge)
      pending = { challenge, target: { ...found.target }, deadline: monotonic() + RELAY_PAIRING_PROOF_TTL_MS }
      return { status: 'challenge', challenge }
    },
    async proof(params: unknown): Promise<RelayPairingProofResult> {
      const held = pending
      pending = null // malformed/failed/concurrent attempts consume before ANY await
      const request = record(params)
      if (!held || !request || Object.keys(request).length !== 2 || request.challengeId !== held.challenge.challengeId ||
          typeof request.signatureB64 !== 'string' || !RELAY_PAIRING_SIGNATURE.test(request.signatureB64)) return { status: 'unprovable' }
      const own = generation
      const current = () => live() && generation === own && options.peerKey() === held.challenge.peerPublicKeyB64 &&
        now() < held.challenge.expiresAtMs && monotonic() < held.deadline
      if (!current()) return { status: 'expired' }
      const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(held.challenge.sshPublicKeyB64, 'base64')
      ]) })
      if (!verify(null, Buffer.from(relayPairingChallengeText(held.challenge), 'utf8'), key,
        Buffer.from(request.signatureB64, 'base64'))) return { status: 'unprovable' }
      return options.pairings.associate(held.target, held.challenge.peerPublicKeyB64, current)
    }
  }
}

/** An approved relay binds an old pairing only by proving its retained SSH identity. */
export const RELAY_PAIRING_CHALLENGE_METHOD = 'pairing.relayKeyChallengeV1'
export const RELAY_PAIRING_PROOF_METHOD = 'pairing.relayKeyProofV1'
export const RELAY_PAIRING_PROOF_DOMAIN = 'nodeterm-relay-pairing-v1'
export const RELAY_PAIRING_PROOF_TTL_MS = 60_000
export const RELAY_PAIRING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Standard padded base64, including canonical final padding bits. */
export const RELAY_PAIRING_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
export const RELAY_PAIRING_SIGNATURE = /^[A-Za-z0-9+/]{85}[AQgw]==$/

export interface RelayPairingChallenge {
  version: 1
  challengeId: string
  pairingId: string
  hostPublicKeyB64: string
  peerPublicKeyB64: string
  sshPublicKeyB64: string
  nonceB64: string
  expiresAtMs: number
}
export type RelayPairingStatus = 'associated' | 'unprovable' | 'gone' | 'conflict' | 'expired'
export type RelayPairingChallengeResult = { status: RelayPairingStatus } |
  { status: 'challenge'; challenge: RelayPairingChallenge }
export interface RelayPairingProofResult { status: RelayPairingStatus }

export function relayPairingChallengeText(c: RelayPairingChallenge): string {
  if (c.version !== 1 || !RELAY_PAIRING_UUID.test(c.challengeId) || !RELAY_PAIRING_UUID.test(c.pairingId) ||
      ![c.hostPublicKeyB64, c.peerPublicKeyB64, c.sshPublicKeyB64, c.nonceB64].every(k => RELAY_PAIRING_KEY.test(k)) ||
      !Number.isSafeInteger(c.expiresAtMs) || c.expiresAtMs <= 0) throw new Error('Invalid relay pairing challenge.')
  return [RELAY_PAIRING_PROOF_DOMAIN, '1', c.challengeId, c.pairingId, c.hostPublicKeyB64,
    c.peerPublicKeyB64, c.sshPublicKeyB64, c.nonceB64, String(c.expiresAtMs), ''].join('\n')
}

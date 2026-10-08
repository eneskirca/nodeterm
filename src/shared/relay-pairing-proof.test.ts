import { describe, expect, it } from 'vitest'
import { relayPairingChallengeText, RELAY_PAIRING_KEY, RELAY_PAIRING_SIGNATURE, type RelayPairingChallenge } from './relay-pairing-proof'

const challenge: RelayPairingChallenge = { version: 1, challengeId: '11111111-1111-4111-8111-111111111111',
  pairingId: '22222222-2222-4222-8222-222222222222', hostPublicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  peerPublicKeyB64: Buffer.alloc(32, 2).toString('base64'), sshPublicKeyB64: Buffer.alloc(32, 3).toString('base64'),
  nonceB64: Buffer.alloc(32, 4).toString('base64'), expiresAtMs: 1_800_000_000_000 }

describe('relay pairing signed bytes', () => {
  it('fixes every field position, domain, decimal expiry and final newline independently', () => {
    expect(relayPairingChallengeText(challenge)).toBe('nodeterm-relay-pairing-v1\n1\n11111111-1111-4111-8111-111111111111\n' +
      '22222222-2222-4222-8222-222222222222\nAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\n' +
      'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\nAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=\n' +
      'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=\n1800000000000\n')
  })
  it.each(['challengeId', 'pairingId', 'hostPublicKeyB64', 'peerPublicKeyB64', 'sshPublicKeyB64', 'nonceB64'] as const)(
    'rejects malformed %s before signing', field => expect(() => relayPairingChallengeText({ ...challenge, [field]: 'bad\nfield' })).toThrow())
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects expiry %s', expiresAtMs =>
    expect(() => relayPairingChallengeText({ ...challenge, expiresAtMs })).toThrow())
  it('rejects aliases with noncanonical padding bits and wrong byte lengths', () => {
    expect(RELAY_PAIRING_KEY.test(Buffer.alloc(32).toString('base64'))).toBe(true)
    expect(RELAY_PAIRING_KEY.test('A'.repeat(42) + 'B=')).toBe(false)
    expect(RELAY_PAIRING_KEY.test(Buffer.alloc(31).toString('base64'))).toBe(false)
    expect(RELAY_PAIRING_SIGNATURE.test(Buffer.alloc(64).toString('base64'))).toBe(true)
    expect(RELAY_PAIRING_SIGNATURE.test('A'.repeat(85) + 'B==')).toBe(false)
    expect(RELAY_PAIRING_SIGNATURE.test(Buffer.alloc(63).toString('base64'))).toBe(false)
  })
})

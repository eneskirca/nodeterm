import { generateKeyPairSync, sign } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import { createRelayPairingProof, type LegacyRelayPairings } from './relay-pairing-proof'
import { relayPairingChallengeText, type RelayPairingChallenge, type RelayPairingChallengeResult } from '../../shared/relay-pairing-proof'
const id = '11111111-1111-4111-8111-111111111111'
function setup() {
  const keys = generateKeyPairSync('ed25519')
  const publicRaw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  let wall = 1_800_000_000_000, mono = 0, active = true, peer = Buffer.alloc(32, 2).toString('base64')
  const pairings: LegacyRelayPairings = {
    inspect: vi.fn<LegacyRelayPairings['inspect']>(async () => ({ status: 'eligible', target: { pairingId: id, sshPublicKeyB64: publicRaw, entryVersion: 'private-version' } })),
    associate: vi.fn<LegacyRelayPairings['associate']>(async (_target, _peer, current) => ({ status: current() ? 'associated' : 'expired' }))
  }
  const proof = createRelayPairingProof({ hostKey: Buffer.alloc(32, 1).toString('base64'), peerKey: () => peer,
    current: () => active, pairings, now: () => wall, monotonicNow: () => mono })
  const signature = (c: RelayPairingChallenge) => sign(null, Buffer.from(relayPairingChallengeText(c)), keys.privateKey).toString('base64')
  const request = (c: RelayPairingChallenge) => ({ challengeId: c.challengeId, signatureB64: signature(c) })
  const challenge = async () => {
    const result = await proof.challenge({ pairingId: id }); expect(result.status).toBe('challenge')
    return (result as Extract<RelayPairingChallengeResult, { status: 'challenge' }>).challenge
  }
  return { proof, pairings, challenge, request, signature, setActive: () => { active = false },
    changePeer: () => { peer = Buffer.alloc(32, 5).toString('base64') },
    age: (ms: number, clock: 'both' | 'wall' | 'mono' = 'both') => { if (clock !== 'mono') wall += ms; if (clock !== 'wall') mono += ms } }
}
describe('single approved-session relay pairing proof', () => {
  it('verifies the actual SSH signature and private captured target, without changing pins', async () => {
    const s = setup(), c = await s.challenge()
    expect(await s.proof.proof(s.request(c))).toEqual({ status: 'associated' })
    expect(s.pairings.associate).toHaveBeenCalledWith(expect.objectContaining({ pairingId: id, entryVersion: 'private-version' }), c.peerPublicKeyB64, expect.any(Function))
    expect(await s.proof.proof(s.request(c))).toEqual({ status: 'unprovable' })
    expect(s.pairings.associate).toHaveBeenCalledTimes(1)
  })
  it.each(['challengeId', 'pairingId', 'hostPublicKeyB64', 'peerPublicKeyB64', 'sshPublicKeyB64', 'nonceB64', 'expiresAtMs'] as const)(
    'rejects a signature over altered %s', async field => {
      const s = setup(), c = await s.challenge()
      const value = field === 'expiresAtMs' ? c.expiresAtMs + 1 : field.endsWith('Id') ? '22222222-2222-4222-8222-222222222222' : Buffer.alloc(32, 8).toString('base64')
      expect(await s.proof.proof({ challengeId: c.challengeId, signatureB64: s.signature({ ...c, [field]: value }) })).toEqual({ status: 'unprovable' })
      expect(s.pairings.associate).not.toHaveBeenCalled()
    })
  it('consumes malformed proof and refuses wrong SSH signers', async () => {
    const s = setup(), c = await s.challenge()
    expect(await s.proof.proof({ challengeId: c.challengeId, signatureB64: 'bad' })).toEqual({ status: 'unprovable' })
    expect(await s.proof.proof(s.request(c))).toEqual({ status: 'unprovable' })
    const next = await s.challenge()
    const key = generateKeyPairSync('ed25519').privateKey
    expect(await s.proof.proof({ challengeId: next.challengeId, signatureB64: sign(null, Buffer.from(relayPairingChallengeText(next)), key).toString('base64') })).toEqual({ status: 'unprovable' })
    expect(s.pairings.associate).not.toHaveBeenCalled()
  })
  it.each(['both', 'wall', 'mono'] as const)('expires at the exact bound using %s time', async clock => {
    const s = setup(), c = await s.challenge(); s.age(60_000, clock)
    expect(await s.proof.proof(s.request(c))).toEqual({ status: 'expired' }); expect(s.pairings.associate).not.toHaveBeenCalled()
  })
  it('replacement creates fresh randomness and retires the old challenge', async () => {
    const s = setup(), old = await s.challenge(), next = await s.challenge()
    expect(next.challengeId).not.toBe(old.challengeId); expect(next.nonceB64).not.toBe(old.nonceB64)
    expect(await s.proof.proof(s.request(old))).toEqual({ status: 'unprovable' })
    expect(await s.proof.proof(s.request(next))).toEqual({ status: 'unprovable' }) // failed old proof consumed newest
  })
  it('close is permanent and rejects a proof from another exact session', async () => {
    const s = setup(), c = await s.challenge(), other = setup()
    expect(await other.proof.proof(s.request(c))).toEqual({ status: 'unprovable' })
    s.proof.close(); expect(await s.proof.proof(s.request(c))).toEqual({ status: 'unprovable' })
    expect((await s.proof.challenge({ pairingId: id })).status).toBe('unprovable')
  })
  it.each(['setActive', 'changePeer'] as const)('refuses changed approval/identity: %s', async effect => {
    const s = setup(), c = await s.challenge(); s[effect]()
    expect(await s.proof.proof(s.request(c))).toEqual({ status: 'expired' }); expect(s.pairings.associate).not.toHaveBeenCalled()
  })
  it('bounds suspended inspection and cannot allocate after it outlives the connection', async () => {
    const s = setup(); let resolve!: (v: Awaited<ReturnType<LegacyRelayPairings['inspect']>>) => void
    vi.mocked(s.pairings.inspect).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const old = s.proof.challenge({ pairingId: id })
    const overlapping = s.proof.challenge({ pairingId: id })
    expect(s.pairings.inspect).toHaveBeenCalledTimes(1)
    expect(await overlapping).toEqual({ status: 'unprovable' })
    s.proof.close()
    resolve({ status: 'eligible', target: { pairingId: id, sshPublicKeyB64: Buffer.alloc(32).toString('base64'), entryVersion: 'old' } })
    expect(await old).toEqual({ status: 'expired' })
  })
  it('consumes before a suspended publication and fences its late completion', async () => {
    const s = setup(), c = await s.challenge(); let release!: () => void
    vi.mocked(s.pairings.associate).mockImplementationOnce(async (_t, _p, current) => {
      await new Promise<void>(r => { release = r }); return { status: current() ? 'associated' : 'expired' }
    })
    const first = s.proof.proof(s.request(c)); expect(await s.proof.proof(s.request(c))).toEqual({ status: 'unprovable' })
    s.proof.close(); release(); expect(await first).toEqual({ status: 'expired' })
  })
  it('a replacement challenge cancels an older in-flight publication', async () => {
    const s = setup(), c = await s.challenge(); let release!: () => void
    vi.mocked(s.pairings.associate).mockImplementationOnce(async (_t, _p, current) => {
      await new Promise<void>(r => { release = r }); return { status: current() ? 'associated' : 'expired' }
    })
    const old = s.proof.proof(s.request(c)); const next = await s.challenge(); release()
    expect(await old).toEqual({ status: 'expired' })
    expect(await s.proof.proof(s.request(next))).toEqual({ status: 'associated' })
  })
  it('rejects extra caller identity/key fields before inspection', async () => {
    const s = setup(); expect(await s.proof.challenge({ pairingId: id, key: 'override' })).toEqual({ status: 'unprovable' })
    expect(s.pairings.inspect).not.toHaveBeenCalled()
  })
})

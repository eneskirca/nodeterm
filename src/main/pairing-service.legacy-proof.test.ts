import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, symlinkSync } from 'fs'
import path from 'path'
import { generateKeyPairSync, sign } from 'crypto'
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>()
  const { mkdtempSync } = await import('fs'), { join } = await import('path')
  const home = mkdtempSync(join(actual.tmpdir(), 'nt-legacy-pairing-'))
  const base = (actual as unknown as { default?: typeof actual }).default ?? actual
  return { ...actual, homedir: () => home, default: { ...base, homedir: () => home } }
})
vi.mock('../core/device-id', () => ({ getDeviceId: () => 'test-host' }))
import os from 'os'
import { createPairingService } from './pairing-service'
import { createRelayPairingProof } from './remote/relay-pairing-proof'
import { relayPairingChallengeText, type RelayPairingChallengeResult } from '../shared/relay-pairing-proof'
import { type DeviceEntry } from './pairing-core'

const scratch = os.homedir()
if (!path.basename(scratch).startsWith('nt-legacy-pairing-')) throw new Error('Refusing a non-fixture pairing home.')
const agentFile = path.join(scratch, '.nodeterm/agent.json'), publicFile = path.join(scratch, '.ssh/authorized_keys')
const id = '11111111-1111-4111-8111-111111111111', otherId = '22222222-2222-4222-8222-222222222222'
const keys = generateKeyPairSync('ed25519'), raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const blob = Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw]).toString('base64')
const peer = Buffer.alloc(32, 5).toString('base64')
const entry = (deviceId = id): DeviceEntry => ({ id: deviceId, name: 'Test phone', token: `inert-private-${deviceId}`, pairedAt: 123, lastSeenAt: 0 })
const state = () => JSON.parse(readFileSync(agentFile, 'utf8')) as { keep: string; devices: DeviceEntry[] }
const save = (devices: DeviceEntry[]) => writeFileSync(agentFile, JSON.stringify({ keep: 'untouched', devices }) + '\n', { mode: 0o600 })
const publicLine = (keyBlob = blob) => `ssh-ed25519 ${keyBlob} nodeterm-ios-${id}\n`
beforeEach(() => {
  mkdirSync(path.dirname(agentFile), { recursive: true, mode: 0o700 }); mkdirSync(path.dirname(publicFile), { recursive: true, mode: 0o700 })
  save([entry(), entry(otherId)]); writeFileSync(publicFile, publicLine() + 'ssh-rsa AAAA unrelated\n', { mode: 0o600 })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(path.dirname(agentFile), { recursive: true, force: true }); rmSync(path.dirname(publicFile), { recursive: true, force: true }) })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
async function prepared() {
  const service = createPairingService()
  const inspected = await service.legacyRelayPairings.inspect(id, peer)
  expect(inspected.status).toBe('eligible')
  if (inspected.status !== 'eligible') throw new Error('fixture key missing')
  return { service, target: inspected.target }
}
async function stagingBarrier() {
  const original = fs.chmod.bind(fs)
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(fs, 'chmod').mockImplementation(async (file, mode) => {
    await original(file, mode)
    if (String(file).includes('agent.json.') && String(file).endsWith('.tmp')) { entered(); await resume }
  })
  return { paused, release }
}
describe('legacy pairing association publication', () => {
  it('repairs exactly one legacy entry and its next revoke uses only the proven relay key', async () => {
    const revoked: string[] = []
    const service = createPairingService({ getSettings: () => ({}) as never, getEntitlement: () => null,
      loadHostKeyPair: async () => { throw new Error('not used') }, relayEndpoint: 'wss://fixture', apiBase: '',
      relayAllowed: () => false, revokeRelayKey: async key => { revoked.push(key); return { persisted: true, killed: true } } })
    const found = await service.legacyRelayPairings.inspect(id, peer)
    if (found.status !== 'eligible') throw new Error('fixture')
    expect(await service.legacyRelayPairings.associate(found.target, peer, () => true)).toEqual({ status: 'associated' })
    expect(state()).toEqual({ keep: 'untouched', devices: [{ ...entry(), relayBoxKey: peer }, entry(otherId)] })
    expect(readFileSync(publicFile, 'utf8')).toBe(publicLine() + 'ssh-rsa AAAA unrelated\n')
    expect(revoked).toEqual([])
    expect((await service.revokeDevice(id)).relay).toBe('ok'); expect(revoked).toEqual([peer])
    expect(state().devices).toEqual([entry(otherId)])
  })
  it('leaves a same-key sibling authorization retained on revoke', async () => {
    const { service, target } = await prepared()
    save([entry(), { ...entry(otherId), relayBoxKey: peer }])
    expect(await service.legacyRelayPairings.associate(target, peer, () => true)).toEqual({ status: 'associated' })
    expect((await service.revokeDevice(id)).relay).toBe('retained')
    expect(state().devices[0].relayBoxKey).toBe(peer)
  })
  it('refuses gone, duplicate, non-SSH, conflicting and malformed identities', async () => {
    const service = createPairingService()
    expect(await service.legacyRelayPairings.inspect(otherId, peer)).toEqual({ status: 'unprovable' })
    expect(await service.legacyRelayPairings.inspect('bad-id', peer)).toEqual({ status: 'unprovable' })
    save([]); expect(await service.legacyRelayPairings.inspect(id, peer)).toEqual({ status: 'gone' })
    save([entry(), entry()]); expect(await service.legacyRelayPairings.inspect(id, peer)).toEqual({ status: 'unprovable' })
    save([{ ...entry(), ssh: false }]); expect(await service.legacyRelayPairings.inspect(id, peer)).toEqual({ status: 'unprovable' })
    save([{ ...entry(), relayBoxKey: Buffer.alloc(32, 8).toString('base64') }]); expect(await service.legacyRelayPairings.inspect(id, peer)).toEqual({ status: 'conflict' })
    save([{ ...entry(), relayBoxKey: peer }]); expect(await service.legacyRelayPairings.inspect(id, peer)).toEqual({ status: 'associated' })
  })
  it('cannot restore a pairing revoked after challenge inspection', async () => {
    const { service, target } = await prepared(); await service.revokeDevice(id)
    expect(await service.legacyRelayPairings.associate(target, peer, () => true)).toEqual({ status: 'gone' })
    expect(state().devices).toEqual([entry(otherId)])
  })
  it('refuses replaced private entry facts and current attributed keys', async () => {
    const { service, target } = await prepared(); save([{ ...entry(), token: 'different-inert-token' }, entry(otherId)])
    const staged = vi.spyOn(fs, 'writeFile')
    expect(await service.legacyRelayPairings.associate(target, peer, () => true)).toEqual({ status: 'unprovable' })
    expect(staged).not.toHaveBeenCalled()
    save([entry(), entry(otherId)]); writeFileSync(publicFile, publicLine(Buffer.concat([
      Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), Buffer.alloc(32, 9)]).toString('base64')))
    expect(await service.legacyRelayPairings.associate(target, peer, () => true)).toEqual({ status: 'unprovable' })
    expect(staged).not.toHaveBeenCalled()
    expect(state().devices[0].relayBoxKey).toBeUndefined()
  })
  it('does not publish if the exact session stops while its private temp is staged', async () => {
    const { service, target } = await prepared(), barrier = await stagingBarrier(); let live = true
    const before = readFileSync(agentFile, 'utf8')
    const operation = service.legacyRelayPairings.associate(target, peer, () => live)
    await barrier.paused; live = false; barrier.release()
    expect(await operation).toEqual({ status: 'expired' }); expect(readFileSync(agentFile, 'utf8')).toBe(before)
    expect(readdirSync(path.dirname(agentFile))).toEqual(['agent.json'])
  })
  it('refuses file/key replacement during staging without overwriting unrelated new state', async () => {
    const { service, target } = await prepared(), barrier = await stagingBarrier()
    const operation = service.legacyRelayPairings.associate(target, peer, () => true)
    await barrier.paused; save([entry(), { ...entry(otherId), name: 'new unrelated name' }]); barrier.release()
    expect(await operation).toEqual({ status: 'unprovable' }); expect(state().devices[1].name).toBe('new unrelated name')
    expect(state().devices[0].relayBoxKey).toBeUndefined()
  })
  it('refuses attributed-key replacement during staging', async () => {
    const { service, target } = await prepared(), barrier = await stagingBarrier()
    const operation = service.legacyRelayPairings.associate(target, peer, () => true)
    await barrier.paused; writeFileSync(publicFile, publicLine(Buffer.concat([
      Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), Buffer.alloc(32, 9)]).toString('base64'))); barrier.release()
    expect(await operation).toEqual({ status: 'unprovable' }); expect(state().devices[0].relayBoxKey).toBeUndefined()
  })
  it('refuses a replaced private registry symlink during staging', async () => {
    const { service, target } = await prepared(), barrier = await stagingBarrier()
    const operation = service.legacyRelayPairings.associate(target, peer, () => true)
    await barrier.paused
    const replacement = agentFile + '.replacement'; writeFileSync(replacement, readFileSync(agentFile), { mode: 0o600 })
    rmSync(agentFile); symlinkSync(replacement, agentFile); barrier.release()
    expect(await operation).toEqual({ status: 'unprovable' }); expect(state().devices[0].relayBoxKey).toBeUndefined()
  })
  it('checks proof expiry again after actual asynchronous staging', async () => {
    const service = createPairingService(); let now = 1_800_000_000_000, mono = 0
    const proof = createRelayPairingProof({ hostKey: Buffer.alloc(32, 1).toString('base64'), peerKey: () => peer,
      current: () => true, pairings: service.legacyRelayPairings, now: () => now, monotonicNow: () => mono })
    const result = await proof.challenge({ pairingId: id })
    const c = (result as Extract<RelayPairingChallengeResult, { status: 'challenge' }>).challenge
    const barrier = await stagingBarrier()
    const operation = proof.proof({ challengeId: c.challengeId, signatureB64: sign(null,
      Buffer.from(relayPairingChallengeText(c)), keys.privateKey).toString('base64') })
    await barrier.paused; mono = 60_000; now -= 10_000; barrier.release()
    expect(await operation).toEqual({ status: 'expired' }); expect(state().devices[0].relayBoxKey).toBeUndefined()
  })
  it('preserves the registry and removes its temp if staging fails', async () => {
    const { service, target } = await prepared(); const before = readFileSync(agentFile, 'utf8')
    vi.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('fixture chmod failure'))
    await expect(service.legacyRelayPairings.associate(target, peer, () => true)).rejects.toThrow('fixture chmod failure')
    expect(readFileSync(agentFile, 'utf8')).toBe(before); expect(readdirSync(path.dirname(agentFile))).toEqual(['agent.json'])
  })
})

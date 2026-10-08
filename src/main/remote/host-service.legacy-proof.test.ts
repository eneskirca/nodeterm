import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelaySocket, RpcRequest } from './relay-socket'
import type { LegacyRelayPairings } from './relay-pairing-proof'
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp/unused-legacy-fixture' }, ipcMain: { on() {}, handle() {} } }))
vi.mock('../../core/pty-manager', () => ({ PtyManager: class {} }))
vi.mock('../../core/license', () => ({ isPremium: () => true, getStoredEntitlement: () => null }))
vi.mock('./host-canvas-hub', () => ({ initHostCanvasHub() {}, currentCanvas: () => null, subscribeCanvas: () => () => {} }))
let relay: { onReady(): void; onRpc(req: RpcRequest): void; onClose(): void }
const answers: { id: string; ok: boolean; body: unknown }[] = []
vi.mock('./relay-socket', () => ({ connectRelay: (opts: typeof relay) => {
  relay = opts; return { respond: (id, ok, body) => answers.push({ id, ok, body }), notify: () => true,
    sendFrame: () => true, sas: () => '12345', peerPublicKeyB64: () => Buffer.alloc(32, 2).toString('base64'), close() {},
    rpc: async () => null, sendTunnelText: () => false, sendTunnelBinary: () => false, bufferedAmount: () => 0 } satisfies RelaySocket
} }))
import { connectHostSession, type HostSessionOptions } from './host-service'
const id = '11111111-1111-4111-8111-111111111111'
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
function open(pairings?: LegacyRelayPairings) {
  return connectHostSession({ url: 'wss://fixture', token: 'inert', ourKeys: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    pty: {} as HostSessionOptions['pty'], getLatestCanvas: () => null, subscribeCanvas: () => () => {}, applyMutation() {},
    onPeerReady() {}, onClose() {}, legacyRelayPairings: pairings })
}
const ask = (requestId: string, method = 'pairing.relayKeyChallengeV1') => relay.onRpc({ id: requestId, method, params: { pairingId: id } })
const store = (): LegacyRelayPairings => ({ inspect: vi.fn<LegacyRelayPairings['inspect']>(async () => ({ status: 'unprovable' })),
  associate: vi.fn<LegacyRelayPairings['associate']>(async () => ({ status: 'associated' })) })
beforeEach(() => { answers.length = 0 })
describe('approved-only pairing proof wiring', () => {
  it('rejects both verbs before approval without consulting pairing credentials', async () => {
    const pairings = store(); open(pairings); relay.onReady(); ask('challenge'); ask('proof', 'pairing.relayKeyProofV1'); await settle()
    expect(answers).toEqual([{ id: 'challenge', ok: false, body: { message: 'Awaiting host approval.' } }, { id: 'proof', ok: false, body: { message: 'Awaiting host approval.' } }])
    expect(pairings.inspect).not.toHaveBeenCalled(); expect(pairings.associate).not.toHaveBeenCalled()
  })
  it('serves only the exact approved session and ignores allocation notifications', async () => {
    const pairings = store(), session = open(pairings); relay.onReady(); session.approve()
    ask(''); ask('read'); await settle()
    expect(pairings.inspect).toHaveBeenCalledTimes(1); expect(answers).toEqual([{ id: 'read', ok: true, body: { status: 'unprovable' } }])
  })
  it('cannot be reapproved after socket closure or intentional teardown', async () => {
    for (const path of ['socket', 'intentional']) {
      const pairings = store(), session = open(pairings); relay.onReady(); session.approve()
      if (path === 'socket') relay.onClose(); else session.close()
      session.approve(); ask(path); await settle(); expect(pairings.inspect).not.toHaveBeenCalled(); expect(session.isApproved()).toBe(false)
    }
  })
  it('drops a late result rather than answering on a retired connection', async () => {
    const pairings = store(); let release!: () => void
    vi.mocked(pairings.inspect).mockImplementationOnce(async () => { await new Promise<void>(r => { release = r }); return { status: 'unprovable' } })
    const session = open(pairings); relay.onReady(); session.approve(); ask('late'); session.close(); release(); await settle()
    expect(answers).toEqual([])
  })
  it('older and non-standing host contexts return unsupported after approval', async () => {
    const session = open(); relay.onReady(); session.approve(); ask('missing'); await settle()
    expect(answers[0]).toEqual({ id: 'missing', ok: false, body: { message: 'Relay pairing proof is not served on this host.' } })
  })
})

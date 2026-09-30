import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SOURCE-LEVEL pins for the desktop's host-mode push proof (relay-pop.ts, the hostAuth session in
 * core/push-notify.ts). `PushHostIdentity.prove` is OPTIONAL, so a `getHostIdentity` literal that
 * leaves it out is well-typed and passes every unit test — and ships a desktop whose pushes stop
 * the day the backend latches its key. Both senders build their own identity literal, so each is
 * pinned. The behaviour is proven against real code in `core/push-notify.test.ts`.
 */
const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The argument block of the first `name({` call: up to the line that closes it at 2 spaces. */
function callBlock(name: string): string {
  const at = main.indexOf(`  ${name}({`)
  expect(at).toBeGreaterThan(-1)
  return main.slice(at, main.indexOf('\n  })\n', at))
}

describe('desktop push proves possession of the host key', () => {
  it.each(['createPushNotify', 'createLiveUpdatePush'])('%s hands a prover over the host key pair', (name) => {
    const block = callBlock(name)
    const identity = block.slice(block.indexOf('getHostIdentity:'), block.indexOf(': null,'))
    expect(identity).toContain('hostPublicKeyB64: pushHostKeyB64,')
    expect(identity).toContain('prove: pushHostKeys ? popProverFor(pushHostKeys) : undefined')
  })

  it('keeps the key pair beside its public key, and clears both together', () => {
    const at = main.indexOf('const refreshPushIdentity = async')
    const refresh = main.slice(at, main.indexOf('void refreshPushIdentity()', at))
    expect(refresh).toMatch(/pushHostKeyB64 = null\n\s+pushHostKeys = null/)
    expect(refresh).toMatch(/const kp = await loadOrCreateKeyPair\(\)\n\s+pushHostKeys = kp\n\s+pushHostKeyB64 = publicKeyToB64\(kp\.publicKey\)/)
  })
})

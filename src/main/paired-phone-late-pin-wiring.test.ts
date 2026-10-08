// A paired phone that adopts the relay after the scan is approved by its pairing record on its first
// relay handshake (audit A07-late), and two optional deps in this file's shell make that true
// together:
//
//   - `PairingRelayDeps.pinRelayKeyIfPaired`: with it, the `/pair` answer promises `relayApproved`
//     for a key the pairing only recorded, and the phone then lets its background check use the
//     relay. It must run the check inside the pin store's queue (`pinApprovedDeviceIf`), or a revoke
//     racing it can be undone (approved-devices.test.ts).
//   - `StandingHostOptions.pinPairedPhone`: the standing host's question on an unpinned handshake.
//
// Both are optional and well-typed when absent, so dropping the second leaves every unit test green
// while the answer promises an approval the host never gives: the background check then dials with
// `requireApproved` and raises the SAS dialog on an empty desk, the failure A05 exists to prevent.
// Pinned at source level, like peer-revoke-wiring.test.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const SRC = readFileSync(path.join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The text of a call starting at `head`, up to its closing `})` at two-space indentation. */
function call(head: string): string {
  const start = SRC.indexOf(head)
  expect(start, `${head} is not called; this guard is looking at the wrong file`).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  })', start)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('main wires both halves of the late pin of a paired phone', () => {
  it('the pairing service checks inside the pin store queue', () => {
    expect(call('createPairingService({')).toContain(
      'pinRelayKeyIfPaired: (pub, stillPaired) => pinApprovedDeviceIf(pub, stillPaired)'
    )
  })

  it('the standing host asks the pairing service on an unpinned handshake', () => {
    expect(call('const standingHost = initStandingHost(')).toContain(
      'pinPairedPhone: (pub) => pairingService.approvePairedRelayKey(pub)'
    )
    // The service it asks is the one pairing records the keys in, created before the host.
    expect(SRC.indexOf('const pairingService = createPairingService(')).toBeLessThan(
      SRC.indexOf('const standingHost = initStandingHost(')
    )
  })
})

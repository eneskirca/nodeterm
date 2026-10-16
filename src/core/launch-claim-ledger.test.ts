import { describe, expect, it } from 'vitest'
import { createLaunchClaimLedger } from './launch-claim-ledger'

describe('launch claim ledger (#1173)', () => {
  it('the first automatic claim of a launch wins; every later one is told another viewer owns it', () => {
    const ledger = createLaunchClaimLedger()
    expect(ledger.claim('n1', 'claude --session-id a', false, 1)).toBe('claimed')
    expect(ledger.claim('n1', 'claude --session-id a', false, 2)).toBe('elsewhere')
    expect(ledger.claim('n1', 'claude --session-id a', false, 3)).toBe('elsewhere')
  })

  it('the owner asking again is still the owner (a deferred viewer must not strand its own launch)', () => {
    const ledger = createLaunchClaimLedger()
    expect(ledger.claim('n1', 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('n1', 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('n1', 'a', false, 2)).toBe('elsewhere')
  })

  it('a different node or a different command is a different launch', () => {
    const ledger = createLaunchClaimLedger()
    expect(ledger.claim('n1', 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('n2', 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('n1', 'b', false, 1)).toBe('claimed')
  })

  it('an explicit Run now is never refused, and it records the launch for automatic claimers', () => {
    const ledger = createLaunchClaimLedger()
    expect(ledger.claim('n1', 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('n1', 'a', true, 2)).toBe('claimed')
    expect(ledger.claim('n1', 'a', false, 1)).toBe('elsewhere')
    const fresh = createLaunchClaimLedger()
    expect(fresh.claim('n1', 'a', true, 1)).toBe('claimed')
    expect(fresh.claim('n1', 'a', false, 2)).toBe('elsewhere')
  })

  it('is bounded: the oldest entry is forgotten past the cap', () => {
    const ledger = createLaunchClaimLedger(2)
    ledger.claim('n1', 'a', false, 1)
    ledger.claim('n2', 'a', false, 1)
    ledger.claim('n3', 'a', false, 1)
    expect(ledger.claim('n1', 'a', false, 2)).toBe('claimed')
    expect(ledger.claim('n3', 'a', false, 2)).toBe('elsewhere')
  })

  it('malformed input is never recorded and never refused (the local barrier still applies)', () => {
    const ledger = createLaunchClaimLedger()
    expect(ledger.claim(5 as unknown as string, 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('', 'a', false, 1)).toBe('claimed')
    expect(ledger.claim('n', 'x'.repeat(300_000), false, 1)).toBe('claimed')
    expect(ledger.claim('n', 'x'.repeat(300_000), false, 2)).toBe('claimed')
  })
})

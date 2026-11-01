import { describe, expect, it } from 'vitest'
import type { SessionSource } from '../session/session'
import { relayStatusGates } from './relay-status-gates'

// A team tab's node now reads its host's status: a blocked node carries `pendingId`, and its session
// id is known. These four readers act on THIS machine (or write the host's canvas), so a node whose
// core lives elsewhere must not run them.
describe('relayStatusGates', () => {
  it('relayStatusGates switches every local-only reader off for a relay session', () => {
    expect(relayStatusGates('relay')).toEqual({ approvalButtons: false, titleSync: false, transcriptSearch: false, chatView: false })
  })

  it('a local session keeps them all', () => {
    expect(Object.values(relayStatusGates('local')).every(Boolean)).toBe(true)
  })

  it('a remote-server session is refused like a relay one: its core is elsewhere too', () => {
    expect(relayStatusGates('server')).toEqual(relayStatusGates('relay'))
  })

  it('a source the table does not know fails closed', () => {
    expect(relayStatusGates('future' as SessionSource)).toEqual(relayStatusGates('relay'))
    expect(relayStatusGates('constructor' as SessionSource)).toEqual(relayStatusGates('relay'))
  })
})

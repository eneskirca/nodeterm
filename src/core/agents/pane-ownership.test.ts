import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordFreshSpawnOwner,
  paneOwnerProject,
  forgetPaneOwner,
  resetPaneOwnershipForTests,
  shouldRecordOwnership,
  setHumanPaneAdoptionReader,
  freshPaneOwnerProject
} from './pane-ownership'

beforeEach(() => resetPaneOwnershipForTests())

describe('pane-ownership ledger', () => {
  it('keeps explicit human provenance separate and never lets it override a fresh owner', () => {
    setHumanPaneAdoptionReader(id => id === 'n1' ? 'human-project' : undefined)
    expect(paneOwnerProject('n1')).toBe('human-project')
    expect(freshPaneOwnerProject('n1')).toBeUndefined()
    expect(shouldRecordOwnership(false, 'n1', 'human-project')).toBe(false)
    recordFreshSpawnOwner('n1', 'actual-spawn-project')
    expect(paneOwnerProject('n1')).toBe('actual-spawn-project')
    expect(freshPaneOwnerProject('n1')).toBe('actual-spawn-project')
    setHumanPaneAdoptionReader(() => { throw new Error('unknown') })
    expect(paneOwnerProject('unproven')).toBeUndefined()
  })
  it('records and returns the project that freshly spawned a node', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    expect(paneOwnerProject('n1')).toBe('proj-a')
  })

  it('an unrecorded node is UNPROVEN (undefined) — the fail-closed default after a restart', () => {
    // The whole cold-state contract: nothing recorded ⇒ the delivery gate must refuse. This is the
    // state every node is in immediately after an app restart (re-attach records nothing).
    expect(paneOwnerProject('never-spawned')).toBeUndefined()
  })

  it('a genuine respawn OVERWRITES — the live pane is the one that just came into being', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    recordFreshSpawnOwner('n1', 'proj-b')
    expect(paneOwnerProject('n1')).toBe('proj-b')
  })

  it('a missing owner is a no-op — an old caller passing none leaves the pane unproven, not owned', () => {
    recordFreshSpawnOwner('n1', undefined)
    expect(paneOwnerProject('n1')).toBeUndefined()
    recordFreshSpawnOwner('', 'proj-a')
    expect(paneOwnerProject('')).toBeUndefined()
  })

  it('forget drops ownership back to unproven — a deleted/recycled session is no longer owned', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    forgetPaneOwner('n1')
    expect(paneOwnerProject('n1')).toBeUndefined()
  })

  it('nodes are independent — forgetting one leaves the others', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    recordFreshSpawnOwner('n2', 'proj-a')
    forgetPaneOwner('n1')
    expect(paneOwnerProject('n1')).toBeUndefined()
    expect(paneOwnerProject('n2')).toBe('proj-a')
  })
})

describe('shouldRecordOwnership — the load-bearing fresh-gate, pure', () => {
  it('records ONLY a genuine fresh spawn with a persistKey and a known owner', () => {
    expect(shouldRecordOwnership(true, 'n1', 'proj-a')).toBe(true)
  })
  it('an ATTACH (fresh=false) never records — the confused-deputy hole this gate closes', () => {
    // Recording on attach would let a project claim a pane it merely re-opened after a restart.
    expect(shouldRecordOwnership(false, 'n1', 'proj-a')).toBe(false)
  })
  it('a spawn with no persistKey (a plain, non-persistent pty) does not record', () => {
    expect(shouldRecordOwnership(true, undefined, 'proj-a')).toBe(false)
    expect(shouldRecordOwnership(true, '', 'proj-a')).toBe(false)
  })
  it('a spawn with no known owner (old caller / relay) does not record — stays unproven, fails closed', () => {
    expect(shouldRecordOwnership(true, 'n1', undefined)).toBe(false)
    expect(shouldRecordOwnership(true, 'n1', '')).toBe(false)
  })
})

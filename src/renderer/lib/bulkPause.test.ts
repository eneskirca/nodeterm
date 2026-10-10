import { describe, it, expect } from 'vitest'
import { planBulkPause, isBusyForPause, bulkPauseSummary, type BulkPauseTarget } from './bulkPause'

const t = (nodeId: string, agentId: string | undefined = 'claude', relay = false): BulkPauseTarget =>
  ({ nodeId, agentId, relay, hostKey: 'local' })
const SID = '11111111-2222-3333-4444-555555555555'

describe('planBulkPause', () => {
  it('a node whose CLI announced its exit is skipped as ended', () => {
    const p = planBulkPause([t('a')], () => ({ state: undefined, sessionId: SID, sessionEnded: true }) as never)
    expect(p.skip.map((x) => x.reason)).toEqual(['ended'])
    expect(p.now).toHaveLength(0)
  })
  it('idle done agent → now', () => {
    const p = planBulkPause([t('a')], () => ({ state: 'done', sessionId: SID }) as never)
    expect(p.now.map((x) => x.nodeId)).toEqual(['a'])
  })
  it.each(['working', 'waiting', 'blocked'] as const)('%s → whenDone', (state) => {
    const p = planBulkPause([t('a')], () => ({ state, sessionId: SID }) as never)
    expect(p.whenDone.map((x) => x.nodeId)).toEqual(['a'])
  })
  it('a held ticket on a done node is busy', () => {
    const p = planBulkPause([t('a')], () => ({ state: 'done', sessionId: SID, held: { pendingId: 'x' } }) as never)
    expect(p.whenDone).toHaveLength(1)
  })
  it('hibernated → alreadyExited, never now', () => {
    const p = planBulkPause([t('a')], () => ({ state: 'done', sessionId: SID, hibernated: true }) as never)
    expect(p.alreadyExited).toHaveLength(1)
    expect(p.now).toHaveLength(0)
  })
  it('skip reasons', () => {
    const p = planBulkPause(
      [{ ...t('plain'), agentId: undefined }, t('nosid'), t('paused'), t('relay', 'claude', true), t('dropped')],
      (id) => ({
        plain: undefined,
        nosid: { state: 'done' },
        paused: { state: 'done', sessionId: SID, paused: true },
        relay: { state: 'done', sessionId: SID },
        dropped: { state: 'done', sessionId: SID, dropped: true }
      })[id] as never
    )
    expect(Object.fromEntries(p.skip.map((s) => [s.target.nodeId, s.reason]))).toEqual({
      plain: 'not-agent', nosid: 'no-session-id', paused: 'already-paused', relay: 'relay', dropped: 'dropped'
    })
  })
  it('an agent that cannot be resumed is skipped', () => {
    const p = planBulkPause([t('x', 'some-unknown-agent')], () => ({ state: 'done', sessionId: SID }) as never)
    expect(p.skip[0].reason).toBe('not-resumable')
  })
})

describe('isBusyForPause', () => {
  it('unknown state is not busy', () => expect(isBusyForPause({} as never)).toBe(false))
})

describe('bulkPauseSummary', () => {
  it('names each non-empty bucket', () => {
    const p = planBulkPause([t('a'), t('b')], (id) => (id === 'a'
      ? { state: 'done', sessionId: SID } : { state: 'working', sessionId: SID }) as never)
    expect(bulkPauseSummary(p)).toBe('Pause 1 now, 1 after its current turn')
  })
})

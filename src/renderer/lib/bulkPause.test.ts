import { describe, it, expect } from 'vitest'
import {
  planBulkPause, isBusyForPause, bulkPauseSummary, describeSkips, bulkPauseResultText, bulkPauseConfirmText,
  paneRouteProjectId, type BulkPauseTarget
} from './bulkPause'

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

describe('planBulkPause: no exit sequence', () => {
  it('an agent we can resume but cannot quit (antigravity) is skipped as not-resumable', () => {
    const p = planBulkPause([t('x', 'antigravity')], () => ({ state: 'done', sessionId: SID }) as never)
    expect(p.skip.map((s) => s.reason)).toEqual(['not-resumable'])
    expect(p.now).toHaveLength(0)
  })
})

describe('planBulkPause: unknown state (after a restart)', () => {
  it('unknown + lastSeen done → now', () => {
    const p = planBulkPause([t('a')], () => ({ sessionId: SID, lastSeen: { at: 1, state: 'done' } }) as never)
    expect(p.now.map((x) => x.nodeId)).toEqual(['a'])
  })
  it('unknown + lastSeen working → skip state-unknown', () => {
    const p = planBulkPause([t('a')], () => ({ sessionId: SID, lastSeen: { at: 1, state: 'working' } }) as never)
    expect(p.skip.map((s) => s.reason)).toEqual(['state-unknown'])
  })
  it('unknown + no lastSeen → skip state-unknown', () => {
    const p = planBulkPause([t('a')], () => ({ sessionId: SID }) as never)
    expect(p.skip.map((s) => s.reason)).toEqual(['state-unknown'])
    expect(describeSkips(p.skip)).toBe('1 state unknown since restart')
  })
})

describe('planBulkPause: session binding', () => {
  it('records the session id a target was planned against', () => {
    const p = planBulkPause([t('a'), t('b')], (id) => (id === 'a'
      ? { state: 'done', sessionId: SID } : { state: 'working', sessionId: 'sid-b' }) as never)
    expect(p.now[0].sessionId).toBe(SID)
    expect(p.whenDone[0].sessionId).toBe('sid-b')
  })
})

describe('bulkPauseConfirmText', () => {
  it('names the skipped count once', () => {
    const p = planBulkPause([t('a'), { ...t('b'), agentId: undefined }, { ...t('c'), agentId: undefined }],
      () => ({ state: 'done', sessionId: SID }) as never)
    const text = bulkPauseConfirmText('project "x"', p)
    expect(text).toContain('Skipped: 2 not an agent.')
    expect(text).not.toMatch(/skip 2/)
  })
})

describe('bulkPauseResultText', () => {
  const zero = { paused: 0, pending: 0, unreachable: 0, unverified: 0, notEligible: 0, timeout: 0, failed: 0, skipped: 0 }
  it('all paused is info', () =>
    expect(bulkPauseResultText({ ...zero, paused: 3 })).toEqual({ kind: 'info', text: 'Paused 3' }))
  it('pending and skipped stay info', () =>
    expect(bulkPauseResultText({ ...zero, paused: 1, pending: 2, skipped: 1 })).toEqual({
      kind: 'info', text: 'Paused 1 · 2 after their current turn · 1 skipped'
    }))
  it('every outcome is counted, and any failure is an error', () =>
    expect(bulkPauseResultText({ paused: 3, pending: 2, unreachable: 1, unverified: 2, notEligible: 1, timeout: 1, failed: 1, skipped: 4 })).toEqual({
      kind: 'error',
      text:
        "Paused 3 · 2 after their current turn · 2 unreachable · 2 couldn't verify the agent in its pane · " +
        '1 not eligible · 1 still running (nothing killed — check the pane) · 4 skipped'
    }))
  it('a disconnected-only batch is not "Paused 0" silently', () => {
    const r = bulkPauseResultText({ ...zero, unverified: 2 })
    expect(r.kind).toBe('error')
    expect(r.text).toContain("2 couldn't verify the agent in its pane")
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

describe('describeSkips', () => {
  const t = (nodeId: string): BulkPauseTarget => ({ nodeId, agentId: 'claude', relay: false, hostKey: 'local' })
  it('groups by reason, in first-seen order', () =>
    expect(
      describeSkips([
        { target: t('a'), reason: 'not-agent' },
        { target: t('b'), reason: 'already-paused' },
        { target: t('c'), reason: 'not-agent' },
        { target: t('d'), reason: 'ended' }
      ])
    ).toBe('2 not an agent, 1 already paused, 1 CLI already exited'))
  it('empty → empty string', () => expect(describeSkips([])).toBe(''))
})

describe('paneRouteProjectId', () => {
  it('routes through the owning local or SSH project', () => {
    expect(paneRouteProjectId({ id: 'p1' })).toBe('p1')
    expect(paneRouteProjectId({ id: 'p2', remote: false })).toBe('p2')
  })
  it('refuses a node with no known owner — never the active project as a guess', () => {
    expect(paneRouteProjectId(undefined)).toBeNull()
  })
  it('refuses a relay-owned node — its pane is on another machine', () => {
    expect(paneRouteProjectId({ id: 'r1', remote: true })).toBeNull()
  })
})

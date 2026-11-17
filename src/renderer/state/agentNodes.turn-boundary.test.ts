// Issue #547 — the turn boundary must not take a subagent that is still running with it.
//
// `clearForParent` ran on every new turn on the assumption that the previous fan-out is stale by
// definition. That is true of a FINISHED card and false of a working one: Claude launches subagents
// async, and "waiting for N background agents to finish" is exactly the state in which the next
// prompt gets typed. Nothing rehydrates `byId` afterwards — `start()` fires only from a live
// `PreToolUse` and a subagent past that emits no second one — so the card was gone for the rest of
// the run while the agent kept working.
//
// The more expensive half is the Eco consequence, which is why `buildHibernationCandidates` is
// exercised here rather than left to the store test above it: the guard's evidence ("any card that
// has not finished pins its parent") is derived from this same store, so the wipe let a parent with
// live background agents read as idle and get its CLI `/exit`ed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentNodes } from './agentNodes'
import { buildHibernationCandidates } from '../lib/hibernationCandidates'
import { WORKING_STALE_MS } from '@shared/agents/stale'

const reset = (): void => {
  useAgentNodes.setState({
    byId: {},
    activityById: {},
    lastActivityAt: {},
    positions: {},
    sizes: {},
    expanded: {},
    selectedId: null,
    autoHideFinished: false
  })
}

describe('clearFinishedForParent — the turn boundary (issue #547)', () => {
  beforeEach(reset)

  it('keeps a card whose subagent is still working', () => {
    const s = useAgentNodes.getState()
    s.start('tu-running', { parentNodeId: 'n1', label: 'audit the parser' })
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu-running']?.state).toBe('working')
  })

  it('drops the finished ones in the same pass', () => {
    const s = useAgentNodes.getState()
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    s.finish('tu-done', { tokens: 10 })
    s.clearFinishedForParent('n1')
    const { byId } = useAgentNodes.getState()
    expect(Object.keys(byId)).toEqual(['tu-running'])
  })

  it('takes the dropped card’s overrides and leaves the kept card’s alone', () => {
    const s = useAgentNodes.getState()
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    s.finish('tu-done', {})
    s.setPosition('tu-done', { x: 1, y: 1 })
    s.setPosition('tu-running', { x: 2, y: 2 })
    s.appendActivity('tu-running', 'still going')
    s.clearFinishedForParent('n1')
    const st = useAgentNodes.getState()
    expect(st.positions['tu-done']).toBeUndefined()
    expect(st.positions['tu-running']).toEqual({ x: 2, y: 2 })
    expect(st.activityById['tu-running']).toBe('still going')
  })

  it('touches no other parent', () => {
    const s = useAgentNodes.getState()
    s.start('tu-a', { parentNodeId: 'n1' })
    s.start('tu-b', { parentNodeId: 'n2' })
    s.finish('tu-b', {})
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu-b']).toBeDefined()
  })

  it('a kept card still accepts its late finish()', () => {
    // The #402 property this rests on: `finish()` must land on an entry that was KEPT rather than
    // cleared. If the card had been dropped, the end event would have nothing to write to.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.clearFinishedForParent('n1')
    useAgentNodes.getState().finish('tu1', { tokens: 42 })
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ state: 'done', tokens: 42 })
  })

  it('clearForParent is still unconditional — the removal paths lose nothing', () => {
    // deleteNodes / deleteProject / the cross-project close / the orphan kill / SessionEnd: the node
    // is gone, so there is no work left to represent.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.clearForParent('n1')
    expect(useAgentNodes.getState().byId['tu1']).toBeUndefined()
  })

  it('the selection follows the card that was actually dropped', () => {
    const s = useAgentNodes.getState()
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    s.finish('tu-done', {})
    s.select('tu-running')
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().selectedId).toBe('tu-running')
    useAgentNodes.getState().finish('tu-running', {})
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().selectedId).toBeNull()
  })
})

describe('sweepStaleWorking — the decay a kept card owes', () => {
  beforeEach(reset)

  it('marks a card working past WORKING_STALE_MS as done', () => {
    // Required, not optional: a subagent whose end never arrives (crashed CLI, killed pane, slept
    // machine) would otherwise pin its card — and its parent, against Eco — forever, which is worse
    // than the bug being fixed.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    const card = useAgentNodes.getState().byId['tu1']
    expect(card.state).toBe('done')
    expect(card.durationMs).toBeGreaterThan(WORKING_STALE_MS)
  })

  it('leaves a card that is merely young alone', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS - 1)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('working')
  })

  it('does not overwrite a real finish', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.finish('tu1', { durationMs: 500, result: 'ok' })
    s.sweepStaleWorking(Date.now() + WORKING_STALE_MS * 10)
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ durationMs: 500, result: 'ok' })
  })

  it('a decayed card is then taken by the next turn boundary', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu1']).toBeUndefined()
  })
})

describe('sweepStaleWorking counts from the LAST activity, not from the start', () => {
  // WORKING_STALE_MS means "this long without any sign of life". Counting it from `startedAt`
  // declared every subagent that ran longer than the window dead while its transcript was still
  // streaming, and the next turn boundary then removed the card for good.
  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('keeps a long-running card working while its transcript keeps streaming', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    vi.setSystemTime(1_000_000 + WORKING_STALE_MS * 3)
    s.appendActivity('tu1', '$ Read file.ts\n')
    s.sweepStaleWorking(1_000_000 + WORKING_STALE_MS * 3 + 60_000)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('working')
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu1']).toBeDefined()
  })

  it('still decays a card whose last activity is older than the window', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    vi.setSystemTime(1_000_000 + 60_000)
    s.appendActivity('tu1', 'last words\n')
    s.sweepStaleWorking(1_000_000 + 60_000 + WORKING_STALE_MS + 1)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('done')
  })

  it('does not touch byId on activity, so the canvas does not re-render per chunk', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const before = useAgentNodes.getState().byId
    s.appendActivity('tu1', 'chunk\n')
    expect(useAgentNodes.getState().byId).toBe(before)
  })

  it('a replayed card keeps the host-reported last activity, so the first sweep after a reload spares it', () => {
    const s = useAgentNodes.getState()
    const now = 1_000_000 + WORKING_STALE_MS * 3
    vi.setSystemTime(now)
    s.start('tu1', { parentNodeId: 'n1', startedAt: 1_000_000, lastActivityAt: now - 30_000 })
    expect(useAgentNodes.getState().byId['tu1']).not.toHaveProperty('lastActivityAt')
    s.sweepStaleWorking(now + 60_000)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('working')
  })

  it('an activity time left in the future by a clock step back is clamped, so the card still decays', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1', startedAt: 1_000_000, lastActivityAt: 50_000_000 })
    s.sweepStaleWorking(2_000_000)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('working')
    expect(useAgentNodes.getState().lastActivityAt['tu1']).toBe(2_000_000)
    s.sweepStaleWorking(2_000_000 + WORKING_STALE_MS + 1)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('done')
  })

  it('forgets the activity time when the card is dropped', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.appendActivity('tu1', 'chunk\n')
    useAgentNodes.getState().clearForParent('n1')
    expect(useAgentNodes.getState().lastActivityAt['tu1']).toBeUndefined()
  })
})

describe('autoHideFinished: dropping a card the moment its subagent finishes', () => {
  beforeEach(reset)

  it('keeps the finished card until the turn boundary while the setting is off', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.finish('tu1', { tokens: 7 })
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ state: 'done', tokens: 7 })
  })

  it('drops the card on finish while the setting is on', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu1', { parentNodeId: 'n1' })
    useAgentNodes.getState().finish('tu1', { tokens: 7 })
    expect(useAgentNodes.getState().byId['tu1']).toBeUndefined()
  })

  it('takes the dropped card’s overrides, selection and activity with it', () => {
    // Not expanded: an OPEN card is pinned and survives its finish (see the pin-rule tests).
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu1', { parentNodeId: 'n1' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setSize('tu1', { width: 400, height: 300 })
    s.appendActivity('tu1', 'ran')
    s.select('tu1')
    useAgentNodes.getState().finish('tu1', {})
    const st = useAgentNodes.getState()
    expect(st.byId['tu1']).toBeUndefined()
    expect(st.positions['tu1']).toBeUndefined()
    expect(st.sizes['tu1']).toBeUndefined()
    expect(st.activityById['tu1']).toBeUndefined()
    expect(st.selectedId).toBeNull()
  })

  it('leaves a sibling that is still working, so #547 is unaffected', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    useAgentNodes.getState().finish('tu-done', {})
    expect(Object.keys(useAgentNodes.getState().byId)).toEqual(['tu-running'])
  })

  it('marks the stale sweep done while the setting is off', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('done')
  })

  it('does NOT drop the stale sweep’s cards, even while the setting is on', () => {
    // The sweep fires because the end never ARRIVED, which is the opposite of what this setting
    // promises. It is also the case where a visible card carries the most information: drop it and
    // a fan-out whose subagents died silently leaves nothing behind saying one was ever launched.
    // So the decay keeps marking `done` and the turn boundary takes the card, as it always did.
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu-stale', { parentNodeId: 'n1' })
    s.start('tu-young', { parentNodeId: 'n1' })
    const now = Date.now()
    useAgentNodes.setState((st) => ({
      byId: {
        ...st.byId,
        'tu-stale': { ...st.byId['tu-stale'], startedAt: now - WORKING_STALE_MS - 1 }
      }
    }))
    useAgentNodes.getState().sweepStaleWorking(now)
    const { byId } = useAgentNodes.getState()
    expect(byId['tu-stale'].state).toBe('done')
    expect(byId['tu-young'].state).toBe('working')
  })

  it('and the turn boundary then takes that decayed card, as it does with the setting off', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu-stale', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu-stale'].startedAt
    useAgentNodes.getState().sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu-stale']).toBeUndefined()
  })

  it('a late finish on a dropped card is a no-op', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu1', { parentNodeId: 'n1' })
    useAgentNodes.getState().finish('tu1', {})
    useAgentNodes.getState().finish('tu1', { tokens: 9 })
    expect(useAgentNodes.getState().byId['tu1']).toBeUndefined()
  })
})

describe('Eco still sees the live subagent after a new turn (issue #547)', () => {
  beforeEach(reset)

  const candidates = () =>
    buildHibernationCandidates({
      nodes: [{ id: 'n1', agentId: 'claude' }],
      statusById: { n1: { state: 'done' } },
      subagents: Object.values(useAgentNodes.getState().byId).map((v) => ({
        parentNodeId: v.parentNodeId,
        status: v.state
      })),
      isOffscreen: () => true,
      isRemote: () => false,
      isWired: () => true
    })

  it('pins the parent while a background agent is still running', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.clearFinishedForParent('n1') // the new turn
    expect(candidates()[0].liveSubagents).toBe(true)
  })

  it('stops pinning once the card finishes and the turn boundary takes it', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.finish('tu1', {})
    s.clearFinishedForParent('n1')
    expect(candidates()[0].liveSubagents).toBe(false)
  })

  it('an opened (pinned) finished card survives the boundary but does not pin its parent', () => {
    // The card stays because the user is reading it; it is `done`, so Eco and the bulk restart
    // must still see the parent as free of live subagents.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.toggleExpanded('tu1')
    s.finish('tu1', {})
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu1']?.state).toBe('done')
    expect(candidates()[0].liveSubagents).toBe(false)
  })

  it('stops pinning after the decay, so a lost end cannot block Eco forever', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    expect(candidates()[0].liveSubagents).toBe(false)
  })
})

it('replayed starts retain host timing when a buffered live duplicate follows', () => {
  const store = useAgentNodes.getState()
  store.start('reload-child', { parentNodeId: 'reload-parent', startedAt: 123 })
  store.start('reload-child', { parentNodeId: 'reload-parent' })
  expect(useAgentNodes.getState().byId['reload-child'].startedAt).toBe(123)
  store.clearForParent('reload-parent')
})

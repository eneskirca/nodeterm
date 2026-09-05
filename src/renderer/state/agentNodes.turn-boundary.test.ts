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
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentNodes } from './agentNodes'
import { buildHibernationCandidates } from '../lib/hibernationCandidates'
import { WORKING_STALE_MS } from '@shared/agents/stale'

const reset = (): void => {
  useAgentNodes.setState({
    byId: {},
    activityById: {},
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
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('tu1', { parentNodeId: 'n1' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setSize('tu1', { width: 400, height: 300 })
    s.toggleExpanded('tu1')
    s.appendActivity('tu1', 'ran')
    s.select('tu1')
    useAgentNodes.getState().finish('tu1', {})
    const st = useAgentNodes.getState()
    expect(st.positions['tu1']).toBeUndefined()
    expect(st.sizes['tu1']).toBeUndefined()
    expect(st.expanded['tu1']).toBeUndefined()
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

  it('drops the stale sweep’s cards while the setting is on', () => {
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
    expect(byId['tu-stale']).toBeUndefined()
    expect(byId['tu-young']).toBeDefined()
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

  it('stops pinning after the decay, so a lost end cannot block Eco forever', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    expect(candidates()[0].liveSubagents).toBe(false)
  })
})

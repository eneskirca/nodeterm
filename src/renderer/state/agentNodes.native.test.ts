// The two store rules Claude's native subagent hooks need (core/claude-subagent-lifecycle.ts):
// a card drawn from a tool call is REPLACED by the native card (`supersedes`), and a late tool-path
// end still brings its stats to a card the native stop already ended.
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentNodes } from './agentNodes'

const reset = (): void =>
  useAgentNodes.setState({
    byId: {},
    activityById: {},
    positions: {},
    sizes: {},
    expanded: {},
    selectedId: null,
    autoHideFinished: false
  })

describe('start(…, supersedes) — a native card replacing the card its tool call drew', () => {
  beforeEach(reset)

  it('moves the card to the new key: one card, its start time, place and selection kept', () => {
    const s = useAgentNodes.getState()
    s.start('toolu_1', { parentNodeId: 'n1', label: 'Read a.txt', type: 'general-purpose', startedAt: 1000 })
    s.setPosition('toolu_1', { x: 3, y: 4 })
    s.setSize('toolu_1', { width: 500, height: 300 })
    s.toggleExpanded('toolu_1')
    s.select('toolu_1')
    s.start('a123', { parentNodeId: 'n1', label: 'Read a.txt', type: 'general-purpose' }, 'toolu_1')
    const st = useAgentNodes.getState()
    expect(Object.keys(st.byId)).toEqual(['a123'])
    expect(st.byId.a123).toMatchObject({ state: 'working', startedAt: 1000, label: 'Read a.txt' })
    expect(st.positions).toEqual({ a123: { x: 3, y: 4 } })
    expect(st.sizes).toEqual({ a123: { width: 500, height: 300 } })
    expect(st.expanded).toEqual({ a123: true })
    expect(st.selectedId).toBe('a123')
  })

  it("drops the old card's streamed activity: the native tail re-reads the same file from its start", () => {
    const s = useAgentNodes.getState()
    s.start('toolu_1', { parentNodeId: 'n1' })
    s.appendActivity('toolu_1', 'first line\n')
    s.start('a123', { parentNodeId: 'n1' }, 'toolu_1')
    expect(useAgentNodes.getState().activityById).toEqual({})
  })

  it('when the new key already has a card, the old one is simply dropped (never two cards)', () => {
    const s = useAgentNodes.getState()
    s.start('toolu_1', { parentNodeId: 'n1', startedAt: 1 })
    s.start('a123', { parentNodeId: 'n1', startedAt: 2 })
    s.start('a123', { parentNodeId: 'n1', label: 'fixed' }, 'toolu_1')
    const st = useAgentNodes.getState()
    expect(Object.keys(st.byId)).toEqual(['a123'])
    expect(st.byId.a123).toMatchObject({ startedAt: 2, label: 'fixed' })
  })

  it('an unknown superseded key is a plain start', () => {
    useAgentNodes.getState().start('a123', { parentNodeId: 'n1', startedAt: 7 }, 'gone')
    expect(useAgentNodes.getState().byId.a123).toMatchObject({ state: 'working', startedAt: 7 })
  })
})

describe('finish() on a card already ended', () => {
  beforeEach(reset)

  it('fills in the stats a later tool-path end brings, without re-opening or losing the result', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1', startedAt: 1000 })
    s.finish('a1', { result: 'from the native stop' })
    s.finish('a1', { durationMs: 4371, tokens: 19742, toolUses: 1, result: 'tool text' })
    expect(useAgentNodes.getState().byId.a1).toMatchObject({
      state: 'done',
      result: 'from the native stop',
      durationMs: 4371,
      tokens: 19742,
      toolUses: 1
    })
  })

  it('a late end with no stats changes nothing (the idempotence the async path relies on)', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1', startedAt: 1000 })
    s.finish('a1', { result: 'r', durationMs: 5 })
    const before = useAgentNodes.getState().byId.a1
    s.finish('a1', { result: 'other' })
    expect(useAgentNodes.getState().byId.a1).toBe(before)
  })
})

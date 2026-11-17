import { beforeEach, describe, expect, it } from 'vitest'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import { setCustomAgentBaseResolver } from '@shared/agents/config'
import { chatReadable, useAgentNodes, type SubagentViz } from './agentNodes'

describe('loop node overrides vs per-turn fan-out', () => {
  beforeEach(() => {
    useAgentNodes.setState({ byId: {}, activityById: {}, positions: {}, sizes: {}, expanded: {} })
  })

  // A loop/cron card outlives turns: a new prompt clears the subagent fan-out but must NOT
  // reset where the user dragged the loop card.
  it('clearForParent drops subagent overrides but keeps the loop card position', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setPosition('loop-n1', { x: 5, y: 6 })
    s.clearForParent('n1')
    expect(useAgentNodes.getState().positions['tu1']).toBeUndefined()
    expect(useAgentNodes.getState().positions['loop-n1']).toEqual({ x: 5, y: 6 })
  })

  it('tidyFanout drops only the given parent\'s subagent overrides, keeping the loop card and other parents', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.start('tu2', { parentNodeId: 'n1' })
    s.start('tu3', { parentNodeId: 'n2' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setSize('tu2', { width: 400, height: 300 })
    s.toggleExpanded('tu2')
    s.setPosition('tu3', { x: 9, y: 9 })
    s.setPosition('loop-n1', { x: 5, y: 6 })
    s.tidyFanout('n1')
    const st = useAgentNodes.getState()
    expect(st.positions['tu1']).toBeUndefined()
    expect(st.sizes['tu2']).toBeUndefined()
    expect(st.expanded['tu2']).toBeUndefined()
    expect(st.positions['tu3']).toEqual({ x: 9, y: 9 })
    expect(st.positions['loop-n1']).toEqual({ x: 5, y: 6 })
    // The cards themselves survive — only their placement overrides are dropped.
    expect(st.byId['tu1']).toBeDefined()
    expect(st.byId['tu2']).toBeDefined()
  })

  it('tidyFanout is a no-op for a parent with no subagents', () => {
    const before = useAgentNodes.getState()
    useAgentNodes.getState().tidyFanout('nobody')
    expect(useAgentNodes.getState()).toBe(before)
  })

  it('clearLoop drops only the loop card overrides', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setPosition('loop-n1', { x: 5, y: 6 })
    s.setSize('loop-n1', { width: 300, height: 200 })
    s.clearLoop('n1')
    const st = useAgentNodes.getState()
    expect(st.positions['loop-n1']).toBeUndefined()
    expect(st.sizes['loop-n1']).toBeUndefined()
    expect(st.positions['tu1']).toEqual({ x: 1, y: 2 })
    expect(st.byId['tu1']).toBeDefined()
  })
})

describe('ephemeral card selection', () => {
  beforeEach(() => {
    useAgentNodes.setState({
      byId: {},
      activityById: {},
      positions: {},
      sizes: {},
      expanded: {},
      selectedId: null
    })
  })

  // Cards are `selectable: false` in React Flow (a rubber band must never sweep a fan-out into
  // the selection and hand those ids to Group / Duplicate / Delete), so selection lives here —
  // and it is single: one card at a time.
  it('selects one card at a time', () => {
    useAgentNodes.getState().select('tu1')
    expect(useAgentNodes.getState().selectedId).toBe('tu1')
    useAgentNodes.getState().select('tu2')
    expect(useAgentNodes.getState().selectedId).toBe('tu2')
    useAgentNodes.getState().select(null)
    expect(useAgentNodes.getState().selectedId).toBeNull()
  })

  it('drops the selection when the selected card disappears', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.select('tu1')
    s.clearForParent('n1')
    expect(useAgentNodes.getState().selectedId).toBeNull()
  })

  it('keeps the selection when a DIFFERENT parent’s fan-out is cleared', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.start('tu2', { parentNodeId: 'n2' })
    s.select('tu1')
    s.clearForParent('n2')
    expect(useAgentNodes.getState().selectedId).toBe('tu1')
  })

  it('resetPlacement drops the dragged offset and the resized size', () => {
    const s = useAgentNodes.getState()
    s.setPosition('tu1', { x: 120, y: 40 })
    s.setSize('tu1', { width: 400, height: 300 })
    s.setPosition('tu2', { x: 1, y: 1 })
    s.resetPlacement('tu1')
    const st = useAgentNodes.getState()
    expect(st.positions['tu1']).toBeUndefined()
    expect(st.sizes['tu1']).toBeUndefined()
    expect(st.positions['tu2']).toEqual({ x: 1, y: 1 })
  })
})

describe('useAgentNodes.finish', () => {
  beforeEach(() => {
    useAgentNodes.setState({ byId: {}, activityById: {}, positions: {}, sizes: {}, expanded: {} })
  })

  it('keeps an explicit durationMs from the hook stats', () => {
    useAgentNodes.getState().start('tu1', { parentNodeId: 'n1' })
    useAgentNodes.getState().finish('tu1', { durationMs: 4200, tokens: 10 })
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ state: 'done', durationMs: 4200, tokens: 10 })
  })

  // Async subagents end via a <task-notification> that carries no timing stats — the card
  // should still show a duration, computed from its own startedAt.
  it('falls back to elapsed-since-start when the end event has no durationMs', () => {
    useAgentNodes.getState().start('tu2', { parentNodeId: 'n1' })
    useAgentNodes.setState((s) => ({
      byId: { ...s.byId, tu2: { ...s.byId.tu2, startedAt: Date.now() - 5000 } }
    }))
    useAgentNodes.getState().finish('tu2', { result: 'done via notification' })
    const v = useAgentNodes.getState().byId['tu2']
    expect(v.state).toBe('done')
    expect(v.durationMs).toBeGreaterThanOrEqual(4500)
    expect(v.durationMs).toBeLessThan(20000)
  })
})

describe('loop card override persistence', () => {
  // Cron/schedule cards survive restarts (agentStatus.loop is persisted) — where the user
  // dragged the card must survive with them, or every launch teleports it back to the
  // default spot. Only loop-* overrides persist; subagent cards are per-turn anyway.
  it('persists loop-* position/size and drops them via clearLoop', async () => {
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    const { vi } = await import('vitest')
    vi.stubGlobal('localStorage', store)
    vi.resetModules()
    const { useAgentNodes: fresh } = await import('./agentNodes')
    fresh.getState().setPosition('loop-n1', { x: 42, y: 43 })
    fresh.getState().setSize('loop-n1', { width: 300, height: 120 })
    fresh.getState().setPosition('tu-sub', { x: 1, y: 2 }) // subagent — must NOT persist
    const saved = JSON.parse(mem.get('nodeterm.loopCards.v2')!)
    expect(saved.positions['loop-n1']).toEqual({ x: 42, y: 43 })
    expect(saved.sizes['loop-n1']).toEqual({ width: 300, height: 120 })
    expect(saved.positions['tu-sub']).toBeUndefined()
    fresh.getState().clearLoop('n1')
    const after = JSON.parse(mem.get('nodeterm.loopCards.v2') ?? '{}')
    expect(after.positions?.['loop-n1']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('ignores the v1 key, whose positions meant something else', async () => {
    // v1 stored a canvas POSITION; v2 stores an offset from the parent agent. Reading a v1 entry
    // as an offset would fling the card across the canvas, so the old key is simply not read.
    const mem = new Map<string, string>([
      [
        'nodeterm.loopCards',
        JSON.stringify({ positions: { 'loop-n3': { x: 4000, y: 3000 } }, sizes: {}, expanded: {} })
      ]
    ])
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    const { vi } = await import('vitest')
    vi.stubGlobal('localStorage', store)
    vi.resetModules()
    const { useAgentNodes: fresh } = await import('./agentNodes')
    expect(fresh.getState().positions['loop-n3']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('hydrates persisted loop-* overrides on load', async () => {
    const mem = new Map<string, string>([
      [
        'nodeterm.loopCards.v2',
        JSON.stringify({ positions: { 'loop-n2': { x: 9, y: 8 } }, sizes: {}, expanded: { 'loop-n2': true } })
      ]
    ])
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    const { vi } = await import('vitest')
    vi.stubGlobal('localStorage', store)
    vi.resetModules()
    const { useAgentNodes: fresh } = await import('./agentNodes')
    expect(fresh.getState().positions['loop-n2']).toEqual({ x: 9, y: 8 })
    expect(fresh.getState().expanded['loop-n2']).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('an opened card stays: the pin rule', () => {
  // A card the user expanded is reading material (its chat). The turn boundary and the
  // `autoHideFinished` drop both skip it; only "the parent is gone" (`clearForParent`) or the
  // user's own collapse takes it.
  beforeEach(() => {
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
  })

  it('an expanded done card survives the turn boundary; a collapsed one is removed', () => {
    const s = useAgentNodes.getState()
    s.start('a-open', { parentNodeId: 'n1' })
    s.start('a-closed', { parentNodeId: 'n1' })
    s.finish('a-open', {})
    s.finish('a-closed', {})
    s.toggleExpanded('a-open')
    s.clearFinishedForParent('n1')
    const st = useAgentNodes.getState()
    expect(Object.keys(st.byId)).toEqual(['a-open'])
    expect(st.expanded['a-open']).toBe(true)
  })

  it('collapsing a pinned done card leaves it for the NEXT boundary, not an immediate delete', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    s.finish('a1', {})
    s.clearFinishedForParent('n1') // a turn boundary while it is open
    useAgentNodes.getState().toggleExpanded('a1') // the user closes it
    expect(useAgentNodes.getState().byId['a1']?.state).toBe('done')
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['a1']).toBeUndefined()
  })

  it('with autoHideFinished on, an expanded card survives its finish() with its result', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    useAgentNodes.getState().finish('a1', { tokens: 5, result: 'ok' })
    expect(useAgentNodes.getState().byId['a1']).toMatchObject({ state: 'done', tokens: 5, result: 'ok' })
  })

  it('with autoHideFinished on, collapsing a done card removes it at once', () => {
    // That setting's promise is "finished cards do not linger"; the pin only lasted while open.
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    useAgentNodes.getState().finish('a1', {})
    s.select('a1')
    useAgentNodes.getState().toggleExpanded('a1')
    const st = useAgentNodes.getState()
    expect(st.byId['a1']).toBeUndefined()
    expect(st.expanded['a1']).toBeUndefined()
    expect(st.selectedId).toBeNull()
  })

  it('with autoHideFinished on, collapsing a WORKING card keeps it', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    useAgentNodes.getState().toggleExpanded('a1')
    expect(useAgentNodes.getState().byId['a1']?.state).toBe('working')
  })

  it('with autoHideFinished on, Tidy drops the finished cards it un-pins at once, as a collapse does', () => {
    const s = useAgentNodes.getState()
    s.setAutoHideFinished(true)
    s.start('a-done', { parentNodeId: 'n1' })
    s.start('a-working', { parentNodeId: 'n1' })
    s.start('a-other', { parentNodeId: 'n2' })
    s.toggleExpanded('a-done')
    s.toggleExpanded('a-working')
    s.toggleExpanded('a-other')
    useAgentNodes.getState().finish('a-done', {})
    useAgentNodes.getState().finish('a-other', {})
    s.setSize('a-working', { width: 400, height: 300 })
    s.select('a-done')
    useAgentNodes.getState().tidyFanout('n1')
    const st = useAgentNodes.getState()
    expect(st.byId['a-done']).toBeUndefined()
    expect(st.selectedId).toBeNull()
    // A working card only loses its overrides; another parent's open card is not touched.
    expect(st.byId['a-working']?.state).toBe('working')
    expect(st.expanded['a-working']).toBeUndefined()
    expect(st.sizes['a-working']).toBeUndefined()
    expect(st.expanded['a-other']).toBe(true)
  })

  it('with autoHideFinished off, Tidy un-pins a finished card but keeps it until the boundary', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    s.finish('a1', {})
    useAgentNodes.getState().tidyFanout('n1')
    expect(useAgentNodes.getState().byId['a1']?.state).toBe('done')
    expect(useAgentNodes.getState().expanded['a1']).toBeUndefined()
  })

  it('with autoHideFinished off, collapsing a done card keeps it until the boundary', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    s.finish('a1', {})
    useAgentNodes.getState().toggleExpanded('a1')
    expect(useAgentNodes.getState().byId['a1']?.state).toBe('done')
  })

  it('clearForParent removes pinned and unpinned cards alike', () => {
    const s = useAgentNodes.getState()
    s.start('a-open', { parentNodeId: 'n1' })
    s.start('a-closed', { parentNodeId: 'n1' })
    s.finish('a-open', {})
    s.toggleExpanded('a-open')
    s.clearForParent('n1')
    const st = useAgentNodes.getState()
    expect(st.byId).toEqual({})
    expect(st.expanded['a-open']).toBeUndefined()
  })

  it('the stale decay still only marks a pinned card done, and the boundary then keeps it', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1' })
    s.toggleExpanded('a1')
    const startedAt = useAgentNodes.getState().byId['a1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    expect(useAgentNodes.getState().byId['a1'].state).toBe('done')
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['a1']).toBeDefined()
  })
})

describe('card identity: what a card was started under', () => {
  beforeEach(() => {
    useAgentNodes.setState({ byId: {}, activityById: {}, lastActivityAt: {}, positions: {}, sizes: {}, expanded: {} })
  })

  it('start stores the parent session, account, agent and native flag', () => {
    useAgentNodes.getState().start('a1', {
      parentNodeId: 'n1',
      sessionId: 'sess-1',
      accountId: 'acct-1',
      agent: 'claude',
      native: true
    })
    expect(useAgentNodes.getState().byId['a1']).toMatchObject({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      agent: 'claude',
      native: true
    })
  })

  it('a repeated start that names no session or account keeps the ones it started under', () => {
    const s = useAgentNodes.getState()
    s.start('a1', { parentNodeId: 'n1', sessionId: 'sess-1', accountId: 'acct-1', agent: 'claude', native: true })
    s.start('a1', { parentNodeId: 'n1', agent: 'claude', native: true })
    expect(useAgentNodes.getState().byId['a1']).toMatchObject({ sessionId: 'sess-1', accountId: 'acct-1' })
  })

  it('a superseding native start is native and keeps the replaced card’s session', () => {
    const s = useAgentNodes.getState()
    s.start('toolu_1', { parentNodeId: 'n1', sessionId: 'sess-1', agent: 'claude', native: false })
    s.toggleExpanded('toolu_1')
    s.start('a1', { parentNodeId: 'n1', agent: 'claude', native: true }, 'toolu_1')
    const st = useAgentNodes.getState()
    expect(st.byId['a1']).toMatchObject({ native: true, sessionId: 'sess-1' })
    expect(st.expanded).toEqual({ a1: true })
  })
})

describe('chatReadable', () => {
  const card = (over: Partial<SubagentViz> = {}): SubagentViz => ({
    parentNodeId: 'n1',
    state: 'working',
    startedAt: 1,
    agent: 'claude',
    native: true,
    sessionId: 'sess-1',
    ...over
  })

  it('a native Claude card with a session and a safe id is readable', () => {
    expect(chatReadable(card(), 'a4809888b14b29608')).toBe(true)
  })

  it('refuses a tool-path card, another agent, a missing session or an unsafe id', () => {
    expect(chatReadable(card({ native: false }), 'a1')).toBe(false)
    expect(chatReadable(card({ native: undefined }), 'a1')).toBe(false)
    expect(chatReadable(card({ agent: 'codex' }), 'a1')).toBe(false)
    expect(chatReadable(card({ agent: undefined }), 'a1')).toBe(false)
    expect(chatReadable(card({ sessionId: undefined }), 'a1')).toBe(false)
    expect(chatReadable(card({ sessionId: '' }), 'a1')).toBe(false)
    expect(chatReadable(card(), '../a1')).toBe(false)
    expect(chatReadable(card(), '')).toBe(false)
  })

  it('a custom agent built on claude is readable', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:x' ? 'claude' : undefined))
    try {
      expect(chatReadable(card({ agent: 'custom:x' }), 'a1')).toBe(true)
      expect(chatReadable(card({ agent: 'custom:y' }), 'a1')).toBe(false)
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })
})

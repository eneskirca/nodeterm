import { describe, it, expect } from 'vitest'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { NodeStateChange, NodeNowChange, MirrorFile } from '../core/agent-status-mirror'
import { PROMPT_MAX, firstLine } from '../core/agent-status-mirror'
import {
  createHudModel,
  bucketState,
  firstPromptLine,
  hudRowRank,
  HUD_STALE_DROP_MS,
  type HudRow,
  WORKING_STALE_MS
} from './notch-hud-model'

const T0 = 1_000_000

function stateChange(p: Partial<NodeStateChange> & { nodeId: string; state: NodeStateChange['state'] }): NodeStateChange {
  return { event: 'update', ts: T0, ...p }
}
function nowChange(p: Partial<NodeNowChange> & { nodeId: string }): NodeNowChange {
  return { ts: T0, ...p }
}
function titleOf(id: string): string {
  return `title-${id}`
}
function rowFor(rows: HudRow[], nodeId: string): HudRow | undefined {
  return rows.find((r) => r.nodeId === nodeId)
}

describe('bucketState', () => {
  it('collapses waiting/blocked to needsYou, keeps working/done', () => {
    expect(bucketState('working')).toBe('working')
    expect(bucketState('done')).toBe('done')
    expect(bucketState('waiting')).toBe('needsYou')
    expect(bucketState('blocked')).toBe('needsYou')
  })
})

describe('firstPromptLine', () => {
  it('returns the first non-empty trimmed line and clips long ones', () => {
    expect(firstPromptLine('\n\n  hello world  \nsecond')).toBe('hello world')
    expect(firstPromptLine(undefined)).toBeUndefined()
    expect(firstPromptLine('   ')).toBeUndefined()
    const long = 'x'.repeat(300)
    const clipped = firstPromptLine(long, 10)!
    expect(clipped.length).toBe(10)
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('clips at the mirror’s PROMPT_MAX by default, so both surfaces say the same sentence', () => {
    // The HUD row and the phone's Live Activity line are fed by the same seams and must not show
    // one prompt at two lengths (the HUD used to clip at 140 while the mirror clipped at 120).
    const clipped = firstPromptLine('y'.repeat(300))!
    expect(clipped.length).toBe(PROMPT_MAX)
    expect(clipped).toBe(firstLine('y'.repeat(300), PROMPT_MAX))
  })
})

describe('createHudModel — state → bucket', () => {
  it('maps working/needsYou/done edges into rows and drops idle', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude' }))
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'needsYou', agentId: 'codex' }))
    let rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'a')?.state).toBe('working')
    expect(rowFor(rows, 'a')?.title).toBe('title-a')
    expect(rowFor(rows, 'b')?.state).toBe('needsYou')

    // done then acknowledged → demotes to idle → drops out of the row list
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done' }))
    rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'a')?.state).toBe('done')
    m.noteFocus('a')
    rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'a')).toBeUndefined()
  })

  it('mirror flush maps waiting/blocked to needsYou and seeds unseen nodes', () => {
    const m = createHudModel()
    const doc: MirrorFile = {
      v: 1,
      updatedAt: T0,
      nodes: {
        w: { state: 'working', agentId: 'claude', updatedAt: T0 },
        q: { state: 'waiting', agentId: 'gemini', updatedAt: T0 },
        x: { state: 'blocked', agentId: 'codex', updatedAt: T0 }
      }
    }
    m.applyMirrorFlush(doc)
    const rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'w')?.state).toBe('working')
    expect(rowFor(rows, 'q')?.state).toBe('needsYou')
    expect(rowFor(rows, 'x')?.state).toBe('needsYou')
  })
})

describe('done latch', () => {
  it('is cleared PER ROW by noteFocus, leaving the others unread', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done' }))
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'done' }))
    m.applyStateChange(stateChange({ nodeId: 'c', state: 'done' }))
    expect(rowFor(m.buildRows(T0, titleOf), 'a')?.state).toBe('done')
    m.noteFocus('a')
    expect(rowFor(m.buildRows(T0, titleOf), 'a')).toBeUndefined()
    // Reading one finished session must not swallow the two the user hasn't looked at yet.
    expect(rowFor(m.buildRows(T0, titleOf), 'b')?.state).toBe('done')
    expect(rowFor(m.buildRows(T0, titleOf), 'c')?.state).toBe('done')
    m.noteFocus('b')
    expect(rowFor(m.buildRows(T0, titleOf), 'b')).toBeUndefined()
    expect(rowFor(m.buildRows(T0, titleOf), 'c')?.state).toBe('done')
  })

  it('an explicit read-ack end does not raise the highlight', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done', ack: true }))
    // already-seen done → idle → not shown
    expect(rowFor(m.buildRows(T0, titleOf), 'a')).toBeUndefined()
  })

  it('a fresh working edge re-arms a previously seen done', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done' }))
    m.noteFocus('a')
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working' }))
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done', ts: T0 + 1 }))
    expect(rowFor(m.buildRows(T0 + 1, titleOf), 'a')?.state).toBe('done')
  })
})

describe('subagent grouping', () => {
  const evt = (p: Partial<NormalizedAgentEvent> & { nodeId: string; kind: NormalizedAgentEvent['kind'] }): NormalizedAgentEvent =>
    ({ agentId: 'claude', ...p } as NormalizedAgentEvent)

  it('groups subagent start/end under the node and marks done', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't1', taskLabel: 'do-x' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't2', subagentType: 'general' }))
    let row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.subagents).toHaveLength(2)
    expect(row.subagents.find((s) => s.id === 't1')?.label).toBe('do-x')
    expect(row.subagents.find((s) => s.id === 't2')?.label).toBe('general')

    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-end', toolUseId: 't1' }))
    row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.subagents.find((s) => s.id === 't1')?.state).toBe('done')
    expect(row.subagents.find((s) => s.id === 't2')?.state).toBe('working')
  })

  it('clears fan-out on a new turn and captures the prompt', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't1' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'state', newTurn: true, task: 'refactor the parser\nmore' }))
    const row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.subagents).toHaveLength(0)
    expect(row.prompt).toBe('refactor the parser')
  })

  it('clears fan-out on session end', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't1' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'session', sessionPhase: 'end' }))
    expect(rowFor(m.buildRows(T0, titleOf), 'a')!.subagents).toHaveLength(0)
  })
})

describe('prompt / model / context join', () => {
  it('keeps copied SSH thread ids isolated from each other and legacy local observations', () => {
    const m = createHudModel()
    for (const nodeId of ['local', 'a', 'b']) {
      m.applyStateChange(stateChange({ nodeId, state: 'working', agentId: 'codex', sessionId: 'copied' }))
    }
    m.applyContextUpdate({ nodeId: 'a', sessionId: 'copied', cleared: true })
    m.applyContextUpdate({ nodeId: 'b', sessionId: 'copied', model: 'remote-b', usedPercent: 75 })
    m.applyContextUpdate({ sessionId: 'copied', model: 'local-model', usedPercent: 10 })
    let rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'local')).toMatchObject({ model: 'local-model', contextPercent: 10 })
    expect(rowFor(rows, 'a')?.model).toBeUndefined()
    expect(rowFor(rows, 'a')?.contextPercent).toBeUndefined()
    expect(rowFor(rows, 'b')).toMatchObject({ model: 'remote-b', contextPercent: 75 })
    m.applyContextUpdate({ nodeId: 'b', sessionId: 'copied', cleared: true })
    rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'b')?.model).toBeUndefined()
    expect(rowFor(rows, 'b')?.contextPercent).toBeUndefined()
    m.applyContextUpdate({ nodeId: 'b', sessionId: 'new', model: 'next-model', usedPercent: 25 })
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'working', sessionId: 'new' }))
    m.applyContextUpdate({ nodeId: 'b', sessionId: 'copied', cleared: true })
    expect(rowFor(m.buildRows(T0, titleOf), 'b')).toMatchObject({ model: 'next-model', contextPercent: 25 })
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'working', sessionId: 'another' }))
    expect(rowFor(m.buildRows(T0, titleOf), 'b')?.model).toBeUndefined()
  })
  it('joins model by sessionId and context% by now-change', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude', sessionId: 's1' }))
    m.applyContextUpdate({ sessionId: 's1', model: 'claude-opus-4', usedPercent: 42 })
    m.applyNowChange(nowChange({ nodeId: 'a', activity: 'Editing file.ts' }))
    const row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.model).toBe('claude-opus-4')
    expect(row.contextPercent).toBe(42)
    expect(row.activity).toBe('Editing file.ts')
  })
})

describe('6h drop', () => {
  it('drops a gone + idle node after 6h, keeps a present or recent one', () => {
    const m = createHudModel()
    // present in mirror → never dropped, even if stale
    m.applyMirrorFlush({ v: 1, updatedAt: T0, nodes: { present: { state: 'done', updatedAt: T0 } } })
    // A done restored from the mirror is pre-seen (see "mirror restore"), so give this one a LIVE
    // finish too — the subject here is what prune keeps, not what the restore highlights.
    m.applyStateChange(stateChange({ nodeId: 'present', state: 'done', ts: T0 }))
    // gone node, recently done
    m.applyStateChange(stateChange({ nodeId: 'gone', state: 'done', ts: T0 }))
    // it's not in the mirror flush above → presentInMirror stays false

    expect(m.prune(T0 + HUD_STALE_DROP_MS - 1)).toBe(false)
    // still around, seen check: build after prune
    // now push past 6h
    expect(m.prune(T0 + HUD_STALE_DROP_MS + 1)).toBe(true)
    const rows = m.buildRows(T0 + HUD_STALE_DROP_MS + 1, titleOf)
    expect(rowFor(rows, 'gone')).toBeUndefined()
    // present node still tracked (done, unseen)
    expect(rowFor(rows, 'present')?.state).toBe('done')
  })

  it('never drops a LIVE working node', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'w', state: 'working', ts: T0 }))
    // Keep it alive across the 6h mark — a node still reporting activity is never dropped.
    m.applyNowChange({ nodeId: 'w', ts: T0 + HUD_STALE_DROP_MS, activity: 'still going' } as never)
    expect(m.prune(T0 + HUD_STALE_DROP_MS + 1)).toBe(false)
    expect(rowFor(m.buildRows(T0 + HUD_STALE_DROP_MS + 1, titleOf), 'w')?.state).toBe('working')
  })
})

// The collapsed-indicator aggregation is NOT here: it is the renderer's pure `buildIndicator`
// (src/renderer/hud/indicator.ts + indicator.test.ts), the only side that draws it.
describe('row ordering — state priority, never recency', () => {
  it('ranks needsYou → unread done → working → idle (the sidebar’s section order)', () => {
    expect(hudRowRank({ state: 'needsYou', unread: false })).toBeLessThan(
      hudRowRank({ state: 'done', unread: true })
    )
    expect(hudRowRank({ state: 'done', unread: true })).toBeLessThan(
      hudRowRank({ state: 'working', unread: false })
    )
    expect(hudRowRank({ state: 'working', unread: false })).toBeLessThan(
      hudRowRank({ state: 'idle', unread: false })
    )
    // A `done` that is no longer unread is not a "new for you" row — it ranks with idle, never
    // above a session that is still running.
    expect(hudRowRank({ state: 'done', unread: false })).toBe(hudRowRank({ state: 'idle', unread: false }))
  })

  it('orders the built rows by tier, regardless of how recently each moved', () => {
    const m = createHudModel()
    // Deliberately created oldest-tier-first and with recency running the OTHER way: under the old
    // `updatedAt` sort this came out exactly reversed.
    m.applyStateChange(stateChange({ nodeId: 'w1', state: 'working', agentId: 'claude', ts: T0 + 1 }))
    m.applyStateChange(stateChange({ nodeId: 'd1', state: 'done', agentId: 'gemini', ts: T0 + 2 }))
    m.applyStateChange(stateChange({ nodeId: 'w2', state: 'working', agentId: 'codex', ts: T0 + 3 }))
    m.applyStateChange(stateChange({ nodeId: 'n1', state: 'needsYou', agentId: 'claude', ts: T0 + 4 }))
    const rows = m.buildRows(T0 + 10, titleOf)
    expect(rows.map((r) => r.nodeId)).toEqual(['n1', 'd1', 'w1', 'w2'])
    expect(rows.map((r) => r.state)).toEqual(['needsYou', 'done', 'working', 'working'])
  })

  it('an activity tick does NOT move a row (the reshuffle regression)', () => {
    const m = createHudModel()
    for (const id of ['a', 'b', 'c']) {
      m.applyStateChange(stateChange({ nodeId: id, state: 'working', agentId: 'claude', ts: T0 }))
    }
    const before = m.buildRows(T0, titleOf).map((r) => r.nodeId)
    expect(before).toEqual(['a', 'b', 'c'])
    // Every tool call pushes one of these. `updatedAt` moves (it still drives reltime + the
    // watchdog) — the ROW must not.
    m.applyNowChange(nowChange({ nodeId: 'c', ts: T0 + 5_000, activity: 'Editing a.ts' }))
    m.applyNowChange(nowChange({ nodeId: 'b', ts: T0 + 9_000, contextPercent: 12 }))
    expect(m.buildRows(T0 + 10_000, titleOf).map((r) => r.nodeId)).toEqual(['a', 'b', 'c'])
    expect(rowFor(m.buildRows(T0 + 10_000, titleOf), 'c')?.updatedAt).toBe(T0 + 5_000)
  })

  it('breaks ties by first appearance, which no feed event can change', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'first', state: 'working', ts: T0 + 100 }))
    m.applyStateChange(stateChange({ nodeId: 'second', state: 'working', ts: T0 + 50 }))
    m.applyStateChange(stateChange({ nodeId: 'third', state: 'working', ts: T0 + 75 }))
    // Timestamps are shuffled; appearance order is not.
    expect(m.buildRows(T0 + 200, titleOf).map((r) => r.nodeId)).toEqual(['first', 'second', 'third'])
    // A subagent burst + a new turn on the youngest row still doesn't hoist it.
    m.applyAgentEvent({ nodeId: 'third', agentId: 'claude', kind: 'subagent-start', toolUseId: 't1' } as never)
    m.applyAgentEvent({ nodeId: 'third', agentId: 'claude', kind: 'state', newTurn: true, task: 'go' } as never)
    expect(m.buildRows(T0 + 300, titleOf).map((r) => r.nodeId)).toEqual(['first', 'second', 'third'])
    // Only a real STATE move relocates a row — and then only to its new tier.
    m.applyStateChange(stateChange({ nodeId: 'third', state: 'needsYou', ts: T0 + 400 }))
    expect(m.buildRows(T0 + 400, titleOf).map((r) => r.nodeId)).toEqual(['third', 'first', 'second'])
  })

  it('keeps the panel’s first 6 rows STABLE across ticks (what the cap used to churn)', () => {
    const m = createHudModel()
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
    for (const id of ids) {
      m.applyStateChange(stateChange({ nodeId: id, state: 'working', agentId: 'claude', ts: T0 }))
    }
    const window = (): string[] => m.buildRows(T0 + 60_000, titleOf).slice(0, 6).map((r) => r.nodeId)
    const first = window()
    expect(first).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    // The 7th session ticking away is exactly what used to evict the 6th row and then hand it back.
    for (let i = 1; i <= 5; i++) {
      m.applyNowChange(nowChange({ nodeId: 'n7', ts: T0 + i * 1_000, activity: `step ${i}` }))
      expect(window()).toEqual(first)
    }
  })
})

describe('unread', () => {
  it('marks a finished-and-unlooked-at row, and nothing else', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'done', state: 'done' }))
    m.applyStateChange(stateChange({ nodeId: 'busy', state: 'working' }))
    m.applyStateChange(stateChange({ nodeId: 'ask', state: 'needsYou' }))
    const rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'done')?.unread).toBe(true)
    expect(rowFor(rows, 'busy')?.unread).toBe(false)
    expect(rowFor(rows, 'ask')?.unread).toBe(false)
  })
})

describe('dismiss', () => {
  it('hides a stuck row until its state genuinely changes', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'stuck', state: 'working', agentId: 'claude', ts: T0 }))
    expect(rowFor(m.buildRows(T0 + 1, titleOf), 'stuck')?.state).toBe('working')

    m.dismiss('stuck')
    expect(rowFor(m.buildRows(T0 + 2, titleOf), 'stuck')).toBeUndefined()
    // Still hidden on a repeat build and on a mirror flush that keeps it working.
    m.applyMirrorFlush({ nodes: { stuck: { state: 'working', agentId: 'claude', updatedAt: T0 } } } as never)
    expect(rowFor(m.buildRows(T0 + 3, titleOf), 'stuck')).toBeUndefined()

    // A real state change earns the row back.
    m.applyStateChange(stateChange({ nodeId: 'stuck', state: 'done', ts: T0 + 4 }))
    expect(rowFor(m.buildRows(T0 + 5, titleOf), 'stuck')?.state).toBe('done')
  })

  it('ignores an unknown node', () => {
    const m = createHudModel()
    expect(() => m.dismiss('nope')).not.toThrow()
  })
})

describe('mirror restore', () => {
  it('does not resurrect already-finished sessions on first sight', () => {
    const m = createHudModel()
    // Fresh process: the mirror file is read and it remembers hours of finished turns.
    m.applyMirrorFlush({
      nodes: {
        old1: { state: 'done', agentId: 'claude', updatedAt: T0 },
        old2: { state: 'done', agentId: 'codex', updatedAt: T0 }
      }
    } as never)
    expect(m.buildRows(T0 + 1, titleOf)).toHaveLength(0)

    // A turn that finishes while we ARE watching still lights up...
    m.applyStateChange(stateChange({ nodeId: 'old1', state: 'working', ts: T0 + 2 }))
    m.applyStateChange(stateChange({ nodeId: 'old1', state: 'done', ts: T0 + 3 }))
    expect(rowFor(m.buildRows(T0 + 4, titleOf), 'old1')?.state).toBe('done')
    // ...and a later flush repeating the same done doesn't clear it (only first sight is pre-seen).
    m.applyMirrorFlush({ nodes: { old1: { state: 'done', updatedAt: T0 + 3 } } } as never)
    expect(rowFor(m.buildRows(T0 + 5, titleOf), 'old1')?.state).toBe('done')
  })

  it('still surfaces a needs-you restored from the mirror', () => {
    const m = createHudModel()
    m.applyMirrorFlush({ nodes: { a: { state: 'waiting', updatedAt: T0 } } } as never)
    expect(rowFor(m.buildRows(T0 + 1, titleOf), 'a')?.state).toBe('needsYou')
  })
})

describe('working watchdog', () => {
  it('stops showing a working node nobody has heard from, and restores it on any event', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'w', state: 'working', agentId: 'claude', ts: T0 }))
    // A long turn is still working — the gap has to be big before we presume anything.
    expect(rowFor(m.buildRows(T0 + WORKING_STALE_MS - 1, titleOf), 'w')?.state).toBe('working')
    // Past the window (Esc during a tool call, killed CLI, slept machine): the row goes quiet.
    expect(rowFor(m.buildRows(T0 + WORKING_STALE_MS + 1, titleOf), 'w')).toBeUndefined()
    // DISPLAY-only: one live event and it's back, no state was destroyed.
    m.applyNowChange({ nodeId: 'w', ts: T0 + WORKING_STALE_MS + 2, activity: 'Running tests' } as never)
    expect(rowFor(m.buildRows(T0 + WORKING_STALE_MS + 3, titleOf), 'w')?.state).toBe('working')
  })

  it('lets a stale working node be pruned once it is gone from the mirror', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'w', state: 'working', ts: T0 }))
    expect(m.prune(T0 + WORKING_STALE_MS + 1)).toBe(false) // stale, but not yet past the 6h drop
    expect(m.prune(T0 + HUD_STALE_DROP_MS + 1)).toBe(true)
  })
})

describe('interrupted turns', () => {
  it('an Esc-interrupted done never lights the finished highlight', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', ts: T0 }))
    m.applyStateChange({ ...stateChange({ nodeId: 'a', state: 'done', ts: T0 + 1 }), interrupted: true })
    expect(rowFor(m.buildRows(T0 + 2, titleOf), 'a')).toBeUndefined()
  })
})

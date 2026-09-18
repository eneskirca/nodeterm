import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createCanvasPublisher,
  isEphemeralNodeId,
  publishableStates,
  PUBLISH_INTERVAL_MS
} from './canvas-publish'
import type { CanvasMutation, CanvasNodeState } from './types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

function collect() {
  const sent: CanvasMutation[] = []
  return {
    sent,
    send: (m: CanvasMutation): void => void sent.push(m) // void: `send` returning false means REFUSED
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createCanvasPublisher', () => {
  it('publishes the diff against the last snapshot (add, move, remove)', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    p.publish([node('a', 5)])
    p.publish([])
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a') },
      { op: 'upsert', node: node('a', 5) },
      { op: 'remove', id: 'a' }
    ])
  })

  it('publishes nothing when the snapshot is unchanged', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    p.publish([node('a')])
    expect(c.sent).toHaveLength(1)
  })

  it('throttles drag frames to ~20 Hz: leading send, one trailing send per interval', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    // 5 drag frames inside one interval → 1 leading send, the rest coalesced.
    for (let x = 1; x <= 5; x++) p.publish([node('a', x)], { throttle: true })
    expect(c.sent).toEqual([{ op: 'upsert', node: node('a', 1) }])
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS)
    // The trailing send carries the LATEST position, not the intermediate ones.
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 5) }
    ])
  })

  it('an unthrottled publish (drag settle) sends immediately and cancels the pending frame', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.publish([node('a', 9)]) // settle
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 9) }
    ])
  })

  it('flush() sends a coalesced drag frame right away', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.flush()
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 2) }
    ])
  })

  // THE LOOP GUARD: a snapshot that arrived FROM a peer is adopted, never re-published.
  it('adopt() takes a snapshot as baseline without sending — no infinite echo', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    c.sent.length = 0
    // A peer's mutation lands: Canvas applies it and adopts the result.
    const afterPeer = [node('a'), node('b', 3)]
    p.adopt(afterPeer)
    expect(c.sent).toEqual([])
    // The React effect then fires with exactly that snapshot → the diff is empty → nothing is sent.
    p.publish(afterPeer)
    expect(c.sent).toEqual([])
    // A genuinely local change afterwards still publishes (and only the delta).
    p.publish([node('a'), node('b', 8)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 8) }])
  })

  it('dispose() drops a pending drag frame', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.dispose()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([{ op: 'upsert', node: node('a', 1) }])
  })
})

// A cast the reflector would REFUSE (an oversized sticky; a cast with no project active) must not
// be counted as published: it never reaches a peer, and nothing else would ever re-emit it.
describe('a refused cast (send → false)', () => {
  /** Refuses every mutation touching `bad`, records everything it was asked to send. */
  function gate(bad: string) {
    const tried: CanvasMutation[] = []
    const sent: CanvasMutation[] = []
    const send = (m: CanvasMutation): boolean => {
      tried.push(m)
      const id = m.op === 'remove' ? m.id : m.node.id
      if (id === bad) return false
      sent.push(m)
      return true
    }
    return { tried, sent, send }
  }

  it('is retried on the next publish (the baseline does not advance over it)', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 5)]) // refused: the peers never see it
    expect(c.sent).toEqual([])
    p.publish([node('a', 5)]) // the same snapshot again → still owed, so it is re-emitted
    expect(c.tried).toHaveLength(2)
  })

  it('syncs the moment the edit becomes castable again (the user trims the sticky)', () => {
    let bad = 'a'
    const sent: CanvasMutation[] = []
    const p = createCanvasPublisher((m) => {
      const id = m.op === 'remove' ? m.id : m.node.id
      if (id === bad) return false
      sent.push(m)
      return true
    })
    p.adopt([node('a')])
    p.publish([node('a', 5)]) // oversized → refused
    expect(sent).toEqual([])
    bad = '' // trimmed: it fits now
    p.publish([node('a', 6)])
    expect(sent).toEqual([{ op: 'upsert', node: node('a', 6) }]) // …and it carries the LIVE value
  })

  it('does not hold up the other nodes in the same snapshot', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a'), node('b')])
    p.publish([node('a', 5), node('b', 5)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 5) }])
    p.publish([node('a', 5), node('b', 5)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 5) }]) // b was cast: not re-sent
  })

  it('re-emits a refused ADD as an add, and a refused REMOVE as a remove', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')]) // an ADD, refused → not in the baseline
    p.publish([node('a')])
    expect(c.tried).toEqual([
      { op: 'upsert', node: node('a') },
      { op: 'upsert', node: node('a') }
    ])

    const d = gate('z')
    const q = createCanvasPublisher(d.send)
    q.adopt([node('z')])
    q.publish([]) // a REMOVE, refused → the node stays in the baseline
    q.publish([])
    expect(d.tried).toEqual([
      { op: 'remove', id: 'z' },
      { op: 'remove', id: 'z' }
    ])
  })
})

describe('src (the sender tag)', () => {
  // The reflector echoes a mutation back to its sender too — that echo is the ack that carries the
  // total order. `src` is how the sender recognizes it as its own rather than re-applying it.
  it('stamps every emitted mutation with the publisher tag', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { src: 'cv-1' })
    p.publish([node('a')])
    p.publish([])
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a'), src: 'cv-1' },
      { op: 'remove', id: 'a', src: 'cv-1' }
    ])
  })
})

// A solo user must not pay for team sync: diffing stableStringifies every node twice (~1.4 ms at
// 100 nodes) and the `nodes` array changes at 60 Hz during a drag, all to cast into a void.
describe('shouldPublish (the solo gate)', () => {
  it('publishes nothing while no peer is attached', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish([node('a')])
    p.publish([node('a', 5)], { throttle: true })
    p.flush()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([])
  })

  it('does not even arm the drag throttle timer while solo', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish([node('a')], { throttle: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the baseline still tracks the canvas: the first edit after a peer joins diffs correctly', () => {
    const c = collect()
    let peers = false
    const p = createCanvasPublisher(c.send, { shouldPublish: () => peers })
    p.publish([node('a'), node('b')]) // solo: nothing sent…
    p.publish([node('a', 7), node('b')]) // …and edits keep updating the baseline
    expect(c.sent).toEqual([])

    peers = true // a teammate opens the canvas
    p.publish([node('a', 7), node('b', 3)])
    // ONLY the node that actually changed — no whole-canvas replay, no stale re-send of `a`.
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 3) }])
  })
})

// The gate above only skips the DIFF; serializing the canvas to hand it over is the other half of
// the cost, and it happens in a React effect keyed on the nodes array — once per drag frame. A
// thunk snapshot moves that cost behind the gate too.
describe('lazy snapshots', () => {
  it('never resolves the snapshot while solo — not even to keep the baseline', () => {
    const c = collect()
    const snapshot = vi.fn(() => [node('a')])
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish(snapshot)
    p.publish(snapshot, { throttle: true })
    p.adopt(snapshot)
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(snapshot).not.toHaveBeenCalled()
    expect(c.sent).toEqual([])
  })

  it('resolves a deferred baseline once when a peer arrives, and diffs against it', () => {
    const c = collect()
    let peers = false
    const p = createCanvasPublisher(c.send, { shouldPublish: () => peers })
    const solo = vi.fn(() => [node('a'), node('b')])
    p.publish(solo)
    expect(solo).not.toHaveBeenCalled()

    peers = true
    p.publish(() => [node('a'), node('b', 3)])
    // The deferred baseline was resolved exactly once, and only the changed node was cast — the
    // same result the eager path produced.
    expect(solo).toHaveBeenCalledTimes(1)
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 3) }])

    // …and it is not resolved again on the next edit (the baseline is now the resolved snapshot).
    p.publish(() => [node('a'), node('b', 3)])
    expect(solo).toHaveBeenCalledTimes(1)
  })

  it('resolves a coalesced drag frame once, at the trailing edge', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    const frames = [1, 2, 3].map((x) => vi.fn(() => [node('a', x)]))
    for (const f of frames) p.publish(f, { throttle: true })
    // Leading edge took the first frame; the other two coalesced into one trailing send, so the
    // frame in the middle is never serialized at all.
    expect(frames[0]).toHaveBeenCalledTimes(1)
    expect(frames[1]).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS)
    expect(frames[1]).not.toHaveBeenCalled()
    expect(frames[2]).toHaveBeenCalledTimes(1)
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a') }, // the initial publish, before the drag
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 3) }
    ])
  })

  it('an adopted thunk is a real baseline: the next identical snapshot diffs to nothing', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt(() => [node('a'), node('b')]) // a peer's mutation applied locally
    p.publish(() => [node('a'), node('b')])
    expect(c.sent).toEqual([])
  })
})

describe('ephemeral nodes are never published', () => {
  it('isEphemeralNodeId matches subagent cards (by id set) and loop/xproj cards (by prefix)', () => {
    const eph = new Set(['sub-123'])
    expect(isEphemeralNodeId('sub-123', eph)).toBe(true)
    expect(isEphemeralNodeId('loop-n1', eph)).toBe(true)
    // A cross-project projection (`xproj-<B>-<node>`, ticket 05) is ephemeral by prefix too — it is
    // DERIVED from a persisted lineage link + B's nodes, so publishing it would render the card
    // twice on a peer and persist a node that should never round-trip through flowToNodeStates.
    expect(isEphemeralNodeId('xproj-projB-n1', eph)).toBe(true)
    expect(isEphemeralNodeId('n1', eph)).toBe(false)
  })

  it('publishableStates strips them, so no mutation is ever emitted for one', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    const eph = new Set(['sub-123'])
    const states = [node('n1'), node('sub-123'), node('loop-n1'), node('xproj-projB-n1')]
    expect(publishableStates(states, eph).map((n) => n.id)).toEqual(['n1'])
    p.publish(publishableStates(states, eph))
    expect(c.sent).toEqual([{ op: 'upsert', node: node('n1') }])
    // Moving an ephemeral card produces NO mutation at all.
    const moved = [
      node('n1'),
      node('sub-123', 99),
      node('loop-n1', 99),
      node('xproj-projB-n1', 99)
    ]
    p.publish(publishableStates(moved, eph))
    expect(c.sent).toHaveLength(1)
  })
})

describe('a projectRef group publishes (ticket 09 meta-canvas)', () => {
  // A meta-canvas group that references another project is an ordinary `kind:'group'` node carrying
  // `data.projectRef`. It is NOT ephemeral (no sub-/loop-/xproj- prefix; it is persisted and
  // draggable), so it MUST go on the wire to peers — otherwise a peer's meta-canvas would silently
  // lose the reference frame. The `projectRef` field is harmless extra data that rides along.
  const projectRefGroup = (id: string, x = 0): CanvasNodeState =>
    ({
      id,
      kind: 'group',
      title: 'References Project A',
      color: '#0a84ff',
      position: { x, y: 0 },
      size: { width: 520, height: 360 },
      projectRef: { projectId: 'proj-a' }
    }) as CanvasNodeState

  it('is not classified ephemeral', () => {
    expect(isEphemeralNodeId('g-ref-1', new Set())).toBe(false)
  })

  it('publishableStates keeps it and it round-trips as an upsert', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    const states = [projectRefGroup('g-ref-1')]
    expect(publishableStates(states, new Set()).map((n) => n.id)).toEqual(['g-ref-1'])
    p.publish(publishableStates(states, new Set()))
    expect(c.sent).toEqual([{ op: 'upsert', node: projectRefGroup('g-ref-1') }])
  })
})

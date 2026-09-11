import { describe, it, expect } from 'vitest'
import { planServerChange, type EdgeRef } from './serverChange'
import type { CanvasNodeState, Project } from '@shared/types'

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x: 100, y: 100 },
  size: { width: 900, height: 560 },
  title: id,
  color: '#7aa2f7',
  group: null,
  ...over
})

const project = (nodes: CanvasNodeState[], over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Project',
  color: '#0a84ff',
  cwd: '/work/p1',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  ...over
})

const rope = (id: string, source: string, target: string): EdgeRef => ({ id, source, target })

/** The shape the real defect arrives in: the canvas already holds the caller and one earlier
 *  spawn, and the server has just written a second spawn plus its `ctrl-…` rope. */
const caller = node('term-caller')
const first = node('term-first')

describe('planServerChange', () => {
  it('installs a rope the server added, and adopts the node it points at', () => {
    // The whole reason this path exists: `open-agent` appends BOTH a node and a rope, and the old
    // external-change classifier saw the changed `ropes` array as a conflict.
    const spawned = node('term-spawned')
    const base = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })
    const incoming = project([caller, first, spawned], {
      ropes: [rope('ctrl-1', caller.id, first.id), rope('ctrl-2', caller.id, spawned.id)]
    })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id, first.id],
      liveRopes: [rope('ctrl-1', caller.id, first.id)],
      liveBridges: []
    })

    expect(plan.added.map((n) => n.id)).toEqual([spawned.id])
    expect(plan.ropesChanged).toBe(true)
    expect(plan.ropes.map((r) => r.id)).toEqual(['ctrl-1', 'ctrl-2'])
    // Pruning runs against the canvas as it will be AFTER the adoption, or the rope the server
    // wrote alongside its new node would be dropped on the very payload that introduced both.
    expect(plan.ropes.at(-1)).toEqual(rope('ctrl-2', caller.id, spawned.id))
  })

  it('drops a rope the server removed', () => {
    const base = project([caller, first], {
      ropes: [rope('ctrl-1', caller.id, first.id), rope('ctrl-2', caller.id, first.id)]
    })
    const incoming = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id, first.id],
      liveRopes: [rope('ctrl-1', caller.id, first.id), rope('ctrl-2', caller.id, first.id)],
      liveBridges: []
    })

    expect(plan.ropesChanged).toBe(true)
    expect(plan.ropes.map((r) => r.id)).toEqual(['ctrl-1'])
  })

  it('keeps a rope the canvas added and has not saved yet', () => {
    // Not in base ⇒ nobody but this canvas has ever seen it ⇒ the server's file cannot be evidence
    // that it is gone. Dropping it would delete an edge the user just drew.
    const base = project([caller, first], { ropes: [] })
    const incoming = project([caller, first], { ropes: [] })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id, first.id],
      liveRopes: [rope('local-1', caller.id, first.id)],
      liveBridges: []
    })

    expect(plan.ropes.map((r) => r.id)).toEqual(['local-1'])
    expect(plan.ropesChanged).toBe(false)
  })

  it('leaves a locally deleted rope deleted even though the incoming file still lists it', () => {
    // In base AND in incoming, absent from the canvas ⇒ the user deleted it since the last save.
    // Re-adding it here would undo that edit silently.
    const base = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })
    const incoming = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id, first.id],
      liveRopes: [],
      liveBridges: []
    })

    expect(plan.ropes).toEqual([])
    expect(plan.ropesChanged).toBe(false)
  })

  it('prunes an incoming edge whose endpoint is not on the canvas', () => {
    // The cross case: the server added a rope to a node this canvas deleted (and has not saved).
    // React Flow would drop it at render anyway — but the next autosave would write it out.
    const base = project([caller, first], { ropes: [] })
    const incoming = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id],
      liveRopes: [],
      liveBridges: []
    })

    expect(plan.ropes).toEqual([])
    expect(plan.ropesChanged).toBe(false)
  })

  it('does not resurrect a node the canvas deleted but the file still lists', () => {
    // Same base check `decideExternalChange` uses: "added" means neither the canvas nor our
    // last-known disk state has the id.
    const base = project([caller, first])
    const incoming = project([caller, first])

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id],
      liveRopes: [],
      liveBridges: []
    })

    expect(plan.added).toEqual([])
  })

  it('treats an unknown project (no base) as empty: everything incoming is new', () => {
    const spawned = node('term-spawned')
    const incoming = project([caller, spawned], {
      ropes: [rope('ctrl-1', caller.id, spawned.id)],
      bridges: [{ id: 'bridge-1', source: caller.id, target: spawned.id }]
    })

    const plan = planServerChange({
      base: undefined,
      incoming,
      liveNodeIds: [caller.id],
      liveRopes: [],
      liveBridges: []
    })

    expect(plan.added.map((n) => n.id)).toEqual([spawned.id])
    expect(plan.ropes.map((r) => r.id)).toEqual(['ctrl-1'])
    expect(plan.bridges.map((b) => b.id)).toEqual(['bridge-1'])
    expect(plan.ropesChanged).toBe(true)
    expect(plan.bridgesChanged).toBe(true)
  })

  it('reports no change when the merge lands on exactly what the canvas already holds', () => {
    // `setControlEdges` on an identical set is a whole-canvas edge re-render (displayEdges
    // recomputes colour and the waiting look per edge) for nothing, and these arrive in bursts.
    const base = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })
    const incoming = project([caller, first], { ropes: [rope('ctrl-1', caller.id, first.id)] })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id, first.id],
      liveRopes: [rope('ctrl-1', caller.id, first.id)],
      liveBridges: []
    })

    expect(plan.ropesChanged).toBe(false)
    expect(plan.bridgesChanged).toBe(false)
    expect(plan.added).toEqual([])
  })

  it('applies the same rules to context bridges', () => {
    // `link` writes bridges the same way `open-agent` writes ropes, so one drifting copy of these
    // rules is exactly the bug class this merge exists to close.
    const base = project([caller, first], {
      bridges: [{ id: 'bridge-old', source: caller.id, target: first.id }]
    })
    const incoming = project([caller, first], {
      bridges: [{ id: 'bridge-new', source: caller.id, target: first.id }]
    })

    const plan = planServerChange({
      base,
      incoming,
      liveNodeIds: [caller.id, first.id],
      liveRopes: [],
      liveBridges: [
        { id: 'bridge-old', source: caller.id, target: first.id },
        { id: 'bridge-local', source: first.id, target: caller.id }
      ]
    })

    // server-removed drops, local-unsaved survives, server-added lands — in that order.
    expect(plan.bridges.map((b) => b.id)).toEqual(['bridge-local', 'bridge-new'])
    expect(plan.bridgesChanged).toBe(true)
  })
})

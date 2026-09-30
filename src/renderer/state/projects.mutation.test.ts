import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setKanbanPublishHook, useProjects } from './projects'
import type { CanvasMutation, CanvasNodeState, ProjectKanban } from '@shared/types'
import { defaultKanbanFor } from '@shared/kanban-default-board'

const node = (id: string, x = 0): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 0 },
  size: { width: 480, height: 320 },
  title: id,
  color: '#fff',
  group: ''
})

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

/** A peer's mutation for a project that is loaded but NOT the active canvas. React Flow only
 *  holds the ACTIVE project's nodes, so the mutation has to land in the serialized copy the
 *  projects store keeps — otherwise the next whole-file workspace.save writes back a stale
 *  canvas (resurrecting a node the peer deleted), which is the exact bug Stage 3 exists to kill. */
describe('applyNodeMutation', () => {
  it('upserts a node into a background project and reports it applied', () => {
    const p = useProjects.getState().addProject('p', '/tmp/p')
    useProjects.getState().commitCanvas(p.id, [node('a')], { x: 0, y: 0, zoom: 1 })

    const applied = useProjects.getState().applyNodeMutation(p.id, {
      op: 'upsert',
      node: node('b', 100)
    })

    expect(applied).toBe(true)
    expect(useProjects.getState().getProject(p.id)?.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('replaces an existing node (a peer moved / renamed it)', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })

    useProjects.getState().applyNodeMutation(p.id, { op: 'upsert', node: node('a', 999) })

    const nodes = useProjects.getState().getProject(p.id)?.nodes ?? []
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(nodes[0].position.x).toBe(999)
  })

  it('removes a node a peer deleted, so the next whole-file save cannot resurrect it', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })

    useProjects.getState().applyNodeMutation(p.id, { op: 'remove', id: 'a' })

    expect(useProjects.getState().getProject(p.id)?.nodes.map((n) => n.id)).toEqual(['b'])
    expect(useProjects.getState().toWorkspace().projects[0].nodes.map((n) => n.id)).toEqual(['b'])
  })

  it('leaves other projects untouched', () => {
    const a = useProjects.getState().addProject('a')
    const b = useProjects.getState().addProject('b')
    useProjects.getState().commitCanvas(a.id, [node('n1')], { x: 0, y: 0, zoom: 1 })
    useProjects.getState().commitCanvas(b.id, [node('n2')], { x: 0, y: 0, zoom: 1 })

    useProjects.getState().applyNodeMutation(a.id, { op: 'remove', id: 'n1' })

    expect(useProjects.getState().getProject(b.id)?.nodes.map((n) => n.id)).toEqual(['n2'])
  })

  // A mutation for a project this client does not have (a peer opened a folder we never did):
  // nothing to apply, and we must NOT invent a project — report it so the caller can skip the
  // dirty flag rather than scheduling a pointless save.
  it('reports false for an unknown project and creates nothing', () => {
    const applied = useProjects.getState().applyNodeMutation('nope', { op: 'remove', id: 'x' })
    expect(applied).toBe(false)
    expect(useProjects.getState().projects).toHaveLength(0)
  })
})

/** The edge twin of applyNodeMutation: a background project's serialized edges are what our next
 *  whole-file save writes, so a peer's edge op for it must land there. */
describe('applyEdgeMutation', () => {
  const link = (id: string, source = 'a', target = 'b') => ({ id, source, target })

  it('reports false for an unknown project and creates nothing', () => {
    expect(useProjects.getState().applyEdgeMutation('nope', { op: 'edge-remove', kind: 'bridge', id: 'x' })).toBe(false)
    expect(useProjects.getState().projects).toHaveLength(0)
  })

  it('adds a peer edge to a background project', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })
    expect(
      useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'bridge', edge: link('x') })
    ).toBe(true)
    expect(useProjects.getState().getProject(p.id)?.bridges).toEqual([link('x')])
  })

  // A project that never had a list must not have `"bridges": []` materialized into its file by a
  // ROPE op (or by a remove of an edge it does not hold).
  it('leaves an absent list absent and the untouched kind by reference', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })
    expect(useProjects.getState().getProject(p.id)?.bridges).toBeUndefined()
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'rope', edge: link('ctrl-1') })
    const after = useProjects.getState().getProject(p.id)
    expect(after?.bridges).toBeUndefined()
    expect(after?.ropes).toEqual([link('ctrl-1')])

    const ropes = after?.ropes
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'bridge', edge: link('x') })
    expect(useProjects.getState().getProject(p.id)?.ropes).toBe(ropes)
  })

  it('an edge id lives in one list', () => {
    const p = useProjects.getState().addProject('p')
    useProjects
      .getState()
      .commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 }, [link('x')], [])
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-upsert', kind: 'rope', edge: link('x') })
    expect(useProjects.getState().getProject(p.id)?.bridges).toEqual([])
    expect(useProjects.getState().getProject(p.id)?.ropes).toEqual([link('x')])
    useProjects.getState().applyEdgeMutation(p.id, { op: 'edge-remove', kind: 'bridge', id: 'x' })
    expect(useProjects.getState().getProject(p.id)?.ropes).toEqual([])
  })
})

/**
 * The store's ONE apply path (`applyCanvasOp`, over @shared/canvas-content's reducer): node, edge
 * and board ops for a project React Flow does not hold. `applyNodeMutation` / `applyEdgeMutation`
 * delegate to it. `false` means only "no such project here".
 */
describe('applyCanvasOp', () => {
  const link = (id: string, source = 'a', target = 'b') => ({ id, source, target })
  const setup = () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitCanvas(p.id, [node('a'), node('b')], { x: 0, y: 0, zoom: 1 })
    return p.id
  }

  it('applies a node op', () => {
    const id = setup()
    expect(useProjects.getState().applyCanvasOp(id, { op: 'upsert', node: node('c', 7) })).toBe(true)
    expect(useProjects.getState().getProject(id)?.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('applies an edge op', () => {
    const id = setup()
    expect(
      useProjects.getState().applyCanvasOp(id, { op: 'edge-upsert', kind: 'bridge', edge: link('x') })
    ).toBe(true)
    expect(useProjects.getState().getProject(id)?.bridges).toEqual([link('x')])
  })

  it('applies a board op, materializing the lazy default board', () => {
    const id = setup()
    expect(useProjects.getState().getProject(id)?.kanban).toBeUndefined()
    const col = defaultKanbanFor(id).columns[1].id
    expect(
      useProjects.getState().applyCanvasOp(id, { op: 'kb-card', assignment: { nodeId: 'a', columnId: col } })
    ).toBe(true)
    const board = useProjects.getState().getProject(id)?.kanban
    expect(board?.columns).toEqual(defaultKanbanFor(id).columns)
    expect(board?.assignments).toEqual([{ nodeId: 'a', columnId: col }])
  })

  it('reports false for an unknown project and creates nothing', () => {
    expect(useProjects.getState().applyCanvasOp('nope', { op: 'kb-card-remove', nodeId: 'a' })).toBe(false)
    expect(useProjects.getState().projects).toHaveLength(0)
  })

  // A duplicate op (every Server Edition tab re-casts what it receives) must not rebuild `projects`:
  // every subscriber to the store re-runs on a new array, and the caller would schedule a save of a
  // canvas that did not change.
  it('an op that changes nothing is applied (true) without touching the store', () => {
    const id = setup()
    useProjects.getState().applyCanvasOp(id, { op: 'edge-upsert', kind: 'rope', edge: link('r') })
    const projects = useProjects.getState().projects
    const dup: CanvasMutation[] = [
      { op: 'upsert', node: node('a') },
      { op: 'remove', id: 'ghost' },
      { op: 'edge-upsert', kind: 'rope', edge: link('r') },
      { op: 'edge-remove', kind: 'bridge', id: 'ghost' },
      { op: 'kb-card-remove', nodeId: 'a' }
    ]
    for (const m of dup) {
      expect(useProjects.getState().applyCanvasOp(id, m)).toBe(true)
      expect(useProjects.getState().projects, JSON.stringify(m)).toBe(projects)
    }
    // The two legacy entry points keep the same contract.
    expect(useProjects.getState().applyNodeMutation(id, { op: 'upsert', node: node('b') })).toBe(true)
    expect(useProjects.getState().applyEdgeMutation(id, { op: 'edge-upsert', kind: 'rope', edge: link('r') })).toBe(true)
    expect(useProjects.getState().projects).toBe(projects)
  })

  it('writes back only what changed — an absent list or board stays absent', () => {
    const id = setup()
    useProjects.getState().applyCanvasOp(id, { op: 'upsert', node: node('c') })
    const p = useProjects.getState().getProject(id)
    expect(p?.bridges).toBeUndefined()
    expect(p?.ropes).toBeUndefined()
    expect(p?.kanban).toBeUndefined()
    expect(p && 'kanban' in p).toBe(false)
  })

  it('the node and edge entry points route a board op too (one reducer)', () => {
    const id = setup()
    const col = defaultKanbanFor(id).columns[0].id
    useProjects.getState().applyNodeMutation(id, { op: 'kb-card', assignment: { nodeId: 'b', columnId: col } })
    expect(useProjects.getState().getProject(id)?.kanban?.assignments).toEqual([{ nodeId: 'b', columnId: col }])
  })

  it('never lets a peer set our shell', () => {
    const id = setup()
    useProjects.getState().applyCanvasOp(id, { op: 'upsert', node: { ...node('evil'), shell: '/bin/evil' } })
    expect(useProjects.getState().getProject(id)?.nodes.find((n) => n.id === 'evil')?.shell).toBeUndefined()
  })
})

/**
 * The kanban publish hook (spec §11.3): every board write goes through `setProjectKanban`, so that is
 * where a board change is published — once, after the store write, with the board read BEFORE it.
 * A peer's op arrives through `applyCanvasOp`, which must never reach the hook: publishing it would
 * re-cast someone else's edit as ours.
 */
describe('setKanbanPublishHook', () => {
  let calls: Array<[string, ProjectKanban | undefined, ProjectKanban | undefined]>
  beforeEach(() => {
    calls = []
    setKanbanPublishHook((id, prev, next) => {
      // AFTER the write: the store already holds `next` when the hook runs.
      expect(useProjects.getState().getProject(id)?.kanban).toBe(next)
      calls.push([id, prev, next])
    })
  })
  afterEach(() => setKanbanPublishHook(null))

  it('setProjectKanban calls it once with (id, prev, next), prev read before the write', () => {
    const p = useProjects.getState().addProject('p')
    const first = defaultKanbanFor(p.id)
    useProjects.getState().setProjectKanban(p.id, first)
    expect(calls).toEqual([[p.id, undefined, first]])
    const second: ProjectKanban = { ...first, assignments: [{ nodeId: 'a', columnId: first.columns[0].id }] }
    useProjects.getState().setProjectKanban(p.id, second)
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toBe(first)
    expect(calls[1][2]).toBe(second)
  })

  it('applyCanvasOp with a board op does not call it (a peer op is never re-published)', () => {
    const p = useProjects.getState().addProject('p')
    const col = defaultKanbanFor(p.id).columns[0].id
    expect(useProjects.getState().applyCanvasOp(p.id, { op: 'kb-card', assignment: { nodeId: 'a', columnId: col } })).toBe(true)
    expect(useProjects.getState().getProject(p.id)?.kanban?.assignments).toEqual([{ nodeId: 'a', columnId: col }])
    expect(calls).toEqual([])
  })

  it('a cleared hook is not called', () => {
    setKanbanPublishHook(null)
    const p = useProjects.getState().addProject('p')
    useProjects.getState().setProjectKanban(p.id, defaultKanbanFor(p.id))
    expect(calls).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { applyCanvasOp, contentOf, diffContent, type CanvasContent } from './canvas-content'
import { MUTATION_MAX_BYTES } from './canvas-mutations'
import { defaultKanbanFor } from './kanban-default-board'
import type { CanvasMutation, CanvasNodeState, ProjectKanban } from './types'

const node = (id: string, x = 0) => ({ id, kind: 'terminal', position: { x, y: 0 } }) as any
const empty: CanvasContent = { nodes: [], bridges: [], ropes: [] }

describe('applyCanvasOp', () => {
  it('routes each family to its applier', () => {
    let c = applyCanvasOp(empty, { op: 'upsert', node: node('n1') }, 'p')
    c = applyCanvasOp(c, { op: 'edge-upsert', kind: 'bridge', edge: { id: 'b', source: 'n1', target: 'n1' } }, 'p')
    c = applyCanvasOp(c, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c' } }, 'p')
    expect(c.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(c.bridges.map((b) => b.id)).toEqual(['b'])
    expect(c.kanban?.assignments).toEqual([{ nodeId: 'n1', columnId: 'c' }])
  })
  it('strips exec fields from an inbound node (a peer may not set our shell)', () => {
    const c = applyCanvasOp(empty, { op: 'upsert', node: { ...node('n1'), shell: '/bin/evil' } }, 'p')
    expect((c.nodes[0] as { shell?: string }).shell).toBeUndefined()
  })
  it('refuses an edge op with a bad endpoint id', () => {
    const c = applyCanvasOp(empty, { op: 'edge-upsert', kind: 'rope', edge: { id: 'r', source: '', target: 'x' } } as any, 'p')
    expect(c.ropes).toEqual([])
  })
  it('an unchanged content is the same object (no spurious flush)', () => {
    const c = applyCanvasOp(empty, { op: 'remove', id: 'ghost' }, 'p')
    expect(c).toBe(empty)
  })
})

/**
 * "Nothing changed" is the SAME object, for every family — the authority skips a flush on it and
 * the projects store skips a setState (and the save it would schedule). A duplicate op is the
 * common case, not a corner: every Server Edition tab re-casts what it received, the authority's
 * own published diff echoes back to it, and a reconnect replays.
 */
describe('applyCanvasOp — identity when nothing changed', () => {
  const held: CanvasContent = {
    nodes: [
      { id: 'a', kind: 'terminal', position: { x: 1, y: 2 }, size: { width: 10, height: 20 }, title: 'A', tags: ['x'] } as CanvasNodeState,
      node('b')
    ],
    bridges: [{ id: 'e1', source: 'a', target: 'b' }],
    ropes: []
  }

  it('a duplicate node upsert (a fresh object of the same value) is a no-op', () => {
    const copy = JSON.parse(JSON.stringify(held.nodes[0])) as CanvasNodeState
    expect(applyCanvasOp(held, { op: 'upsert', node: copy }, 'p')).toBe(held)
  })

  it('a key order difference is still the same value', () => {
    const n = held.nodes[0]
    const reordered = { tags: n.tags, title: n.title, size: { height: 20, width: 10 }, position: { y: 2, x: 1 }, kind: n.kind, id: n.id } as CanvasNodeState
    expect(applyCanvasOp(held, { op: 'upsert', node: reordered }, 'p')).toBe(held)
  })

  it('an upsert that changes one field is a change, and only that node is replaced', () => {
    const out = applyCanvasOp(held, { op: 'upsert', node: { ...held.nodes[0], tags: ['y'] } }, 'p')
    expect(out).not.toBe(held)
    expect(out.nodes[0].tags).toEqual(['y'])
    expect(out.nodes[1]).toBe(held.nodes[1])
    expect(out.bridges).toBe(held.bridges)
  })

  it('a peer upsert without OUR exec field is a no-op when nothing else differs (we keep our shell)', () => {
    const mine: CanvasContent = { ...held, nodes: [{ ...node('s'), shell: '/bin/zsh' }] }
    const out = applyCanvasOp(mine, { op: 'upsert', node: node('s') }, 'p')
    expect(out).toBe(mine)
    const moved = applyCanvasOp(mine, { op: 'upsert', node: node('s', 50) }, 'p')
    expect(moved.nodes[0]).toMatchObject({ shell: '/bin/zsh', position: { x: 50, y: 0 } })
  })

  // `carryLocalNodeExec` re-attaches our `ssh.extraArgs` together with `execTrusted: undefined`
  // when we never had one — a key JSON drops. Counting it as a difference would make every peer
  // drag of an ssh terminal with jump-host args a "change" even when nothing moved.
  it('a duplicate upsert of our ssh node (extraArgs carried back) is a no-op', () => {
    const ssh = { host: 'h', user: 'u', extraArgs: '-J jump' }
    const mine: CanvasContent = { ...held, nodes: [{ ...node('s'), ssh }] }
    expect(applyCanvasOp(mine, { op: 'upsert', node: { ...node('s'), ssh: { host: 'h', user: 'u' } } }, 'p')).toBe(mine)
  })

  it('a duplicate edge upsert, and a remove of an edge we lack, are no-ops', () => {
    expect(applyCanvasOp(held, { op: 'edge-upsert', kind: 'bridge', edge: { id: 'e1', source: 'a', target: 'b' } }, 'p')).toBe(held)
    expect(applyCanvasOp(held, { op: 'edge-remove', kind: 'rope', id: 'nope' }, 'p')).toBe(held)
  })

  it('a board op that changes nothing on a held board is a no-op', () => {
    const board: ProjectKanban = { columns: [{ id: 'k1', title: 'T', color: '#000' }], assignments: [{ nodeId: 'a', columnId: 'k1' }] }
    const c: CanvasContent = { ...held, kanban: board }
    expect(applyCanvasOp(c, { op: 'kb-card', assignment: { nodeId: 'a', columnId: 'k1' } }, 'p')).toBe(c)
    expect(applyCanvasOp(c, { op: 'kb-card-remove', nodeId: 'zz' }, 'p')).toBe(c)
    expect(applyCanvasOp(c, { op: 'kb-column', column: { id: 'k1', title: 'T', color: '#000' } }, 'p')).toBe(c)
    // No `meta` / `labels` / `views` list at all reads exactly like an empty one — writing `[]`
    // into the file for a remove of something that was never there is not a change.
    expect(applyCanvasOp(c, { op: 'kb-meta-remove', nodeId: 'a' }, 'p')).toBe(c)
    expect(applyCanvasOp(c, { op: 'kb-label-remove', id: 'l1' }, 'p')).toBe(c)
    expect(applyCanvasOp(c, { op: 'kb-view-remove', id: 'v1' }, 'p')).toBe(c)
  })

  it('a board op that leaves the LAZY default as it was keeps the board absent', () => {
    const def = defaultKanbanFor('p')
    const out1 = applyCanvasOp(held, { op: 'kb-card-remove', nodeId: 'a' }, 'p')
    expect(out1).toBe(held)
    const out2 = applyCanvasOp(held, { op: 'kb-column-order', ids: def.columns.map((c) => c.id) }, 'p')
    expect(out2).toBe(held)
    expect(applyCanvasOp(held, { op: 'kb-column', column: def.columns[0] }, 'p')).toBe(held)
  })

  it('a board op that DOES change the lazy default materializes the board', () => {
    const out = applyCanvasOp(held, { op: 'kb-card', assignment: { nodeId: 'a', columnId: defaultKanbanFor('p').columns[0].id } }, 'p')
    expect(out).not.toBe(held)
    expect(out.kanban?.columns).toEqual(defaultKanbanFor('p').columns)
    expect(out.nodes).toBe(held.nodes)
  })
})

describe('applyCanvasOp — refusals', () => {
  const c: CanvasContent = { nodes: [node('a')], bridges: [], ropes: [] }
  const refused: unknown[] = [
    null,
    { op: 'nope' },
    { op: 'upsert', node: { id: '', position: { x: 0, y: 0 } } },
    { op: 'upsert', node: { id: 'b', position: { x: Number.NaN, y: 0 } } },
    { op: 'remove', id: '' },
    { op: 'edge-upsert', kind: 'bridges', edge: { id: 'x', source: 'a', target: 'a' } },
    { op: 'edge-remove', kind: 'rope', id: 'r'.repeat(200) },
    { op: 'kb-card', assignment: { nodeId: '', columnId: 'k' } },
    { op: 'kb-nope' }
  ]
  for (const m of refused) {
    it(`leaves the content untouched for ${JSON.stringify(m)?.slice(0, 60)}`, () => {
      expect(applyCanvasOp(c, m as CanvasMutation, 'p')).toBe(c)
    })
  }

  it('a board op is applied in its sanitized form (an off-palette label colour is repaired)', () => {
    const out = applyCanvasOp(c, { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'hotpink' as never } }, 'p')
    expect(out.kanban?.labels).toEqual([{ id: 'l1', name: 'Bug', color: 'default' }])
  })

  // The byte cap is the TRANSPORT's (the reflector refuses, the publisher never casts): an op that
  // reached a reducer has already passed it or never travelled at all. The projects store also
  // takes this client's OWN writes to a background project through here (cold open, a canvas-control
  // sticky write), and silently dropping one of those would lose the user's edit.
  it('does not re-apply the wire byte cap', () => {
    const big = { ...node('big'), kind: 'sticky', text: 'x'.repeat(MUTATION_MAX_BYTES) }
    const out = applyCanvasOp(c, { op: 'upsert', node: big }, 'p')
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'big'])
  })

  it('a node remove leaves its card on the board (placements are pruned lazily, spec §2)', () => {
    const board: ProjectKanban = { columns: [{ id: 'k1', title: 'T', color: '#000' }], assignments: [{ nodeId: 'a', columnId: 'k1' }] }
    const out = applyCanvasOp({ ...c, kanban: board }, { op: 'remove', id: 'a' }, 'p')
    expect(out.nodes).toEqual([])
    expect(out.kanban).toBe(board)
  })

  it('never mutates its input', () => {
    const frozen: CanvasContent = Object.freeze({
      nodes: Object.freeze([Object.freeze(node('a'))]) as CanvasNodeState[],
      bridges: Object.freeze([]) as never,
      ropes: Object.freeze([]) as never
    })
    expect(() => {
      applyCanvasOp(frozen, { op: 'upsert', node: node('a', 9) }, 'p')
      applyCanvasOp(frozen, { op: 'edge-upsert', kind: 'rope', edge: { id: 'r', source: 'a', target: 'a' } }, 'p')
      applyCanvasOp(frozen, { op: 'kb-card', assignment: { nodeId: 'a', columnId: 'k' } }, 'p')
    }).not.toThrow()
  })
})

describe('contentOf', () => {
  it('reads absent edge lists as empty and carries the board only when present', () => {
    const nodes = [node('a')]
    expect(contentOf({ nodes })).toEqual({ nodes, bridges: [], ropes: [] })
    expect('kanban' in contentOf({ nodes })).toBe(false)
    const kanban = defaultKanbanFor('p')
    expect(contentOf({ nodes, kanban }).kanban).toBe(kanban)
  })
})

describe('diffContent', () => {
  it('replaying the diff reproduces next', () => {
    const prev: CanvasContent = { nodes: [node('a'), node('b')], bridges: [], ropes: [] }
    const next: CanvasContent = {
      nodes: [node('a', 5), node('c')],
      bridges: [{ id: 'x', source: 'a', target: 'c' }],
      ropes: [],
      kanban: { columns: [{ id: 'k1', title: 'T', color: '#000' }], assignments: [{ nodeId: 'a', columnId: 'k1' }] }
    }
    const replayed = diffContent(prev, next, 'p').reduce((c, m) => applyCanvasOp(c, m, 'p'), prev)
    expect(replayed.nodes).toEqual(next.nodes)
    expect(replayed.bridges).toEqual(next.bridges)
    expect(replayed.kanban?.assignments).toEqual(next.kanban?.assignments)
  })

  it('an identical content diffs to nothing', () => {
    const c: CanvasContent = { nodes: [node('a')], bridges: [{ id: 'x', source: 'a', target: 'a' }], ropes: [], kanban: defaultKanbanFor('p') }
    expect(diffContent(c, { ...c, nodes: [node('a')] }, 'p')).toEqual([])
  })

  it('orders the batch: node adds, then edges and board, then node removes', () => {
    const prev: CanvasContent = { nodes: [node('a'), node('gone')], bridges: [{ id: 'old', source: 'a', target: 'gone' }], ropes: [] }
    const next: CanvasContent = {
      nodes: [node('a'), node('new')],
      bridges: [],
      ropes: [{ id: 'r', source: 'a', target: 'new' }],
      kanban: { ...defaultKanbanFor('p'), assignments: [{ nodeId: 'new', columnId: defaultKanbanFor('p').columns[0].id }] }
    }
    const ops = diffContent(prev, next, 'p').map((m) => m.op)
    expect(ops).toEqual(['upsert', 'edge-upsert', 'edge-remove', 'kb-card', 'remove'])
  })

  // An outside edit (git pull, a hand edit) is not a lazy prune: a placement whose node is gone in
  // the NEW file was removed by someone, so the removal is cast — unlike a client's publisher, which
  // must not cast the prune of a card whose node op may simply not have arrived yet.
  it('casts the removal of a card whose node is gone (every removal is real)', () => {
    const k1 = { id: 'k1', title: 'T', color: '#000' }
    const prev: CanvasContent = {
      nodes: [node('a')],
      bridges: [],
      ropes: [],
      kanban: { columns: [k1], assignments: [{ nodeId: 'a', columnId: 'k1' }], meta: [{ nodeId: 'a', priority: 'high' }] }
    }
    const next: CanvasContent = { nodes: [], bridges: [], ropes: [], kanban: { columns: [k1], assignments: [], meta: [] } }
    const ops = diffContent(prev, next, 'p')
    expect(ops).toContainEqual({ op: 'kb-card-remove', nodeId: 'a' })
    expect(ops).toContainEqual({ op: 'kb-meta-remove', nodeId: 'a' })
    const replayed = ops.reduce((c, m) => applyCanvasOp(c, m, 'p'), prev)
    expect(replayed.kanban?.assignments).toEqual([])
    expect(replayed.kanban?.meta).toEqual([])
  })

  // A file with no `kanban` block renders as the project's lazy default on every client — so an
  // outside edit that REMOVED the block (a checkout from before the board was first edited) turns
  // every replica's board back into that default, instead of casting nothing and leaving each
  // client's old board in place over a file that no longer has one.
  it('a removed board diffs to the lazy default: every item list, not only columns and cards', () => {
    const prev: CanvasContent = {
      nodes: [node('a')],
      bridges: [],
      ropes: [],
      kanban: {
        columns: [{ id: 'k1', title: 'T', color: '#000' }],
        assignments: [{ nodeId: 'a', columnId: 'k1' }],
        meta: [{ nodeId: 'a', priority: 'high', labels: ['l1'] }],
        labels: [{ id: 'l1', name: 'Bug', color: 'red' }],
        views: [{ id: 'v1', name: 'Mine', query: {} } as never]
      }
    }
    const next: CanvasContent = { nodes: [node('a')], bridges: [], ropes: [] }
    const replayed = diffContent(prev, next, 'p').reduce((c, m) => applyCanvasOp(c, m, 'p'), prev)
    const fresh = defaultKanbanFor('p')
    expect(replayed.kanban?.columns).toEqual(fresh.columns)
    expect(replayed.kanban?.assignments).toEqual([])
    expect(replayed.kanban?.meta ?? []).toEqual([])
    expect(replayed.kanban?.labels ?? []).toEqual([])
    expect(replayed.kanban?.views ?? []).toEqual([])
    // …and a project that never had a board still casts nothing for it.
    expect(diffContent(next, { ...next }, 'p')).toEqual([])
  })

  // D12: the placement of a card whose node is gone on BOTH sides (a dead card the file still
  // carried) is removed when the outside edit drops it; before, `prev ∪ next` node ids were the only
  // live set, so every replica kept it.
  it('drops a dead card placement and its meta when the edit drops them', () => {
    const board = (withCard: boolean): ProjectKanban => ({
      ...defaultKanbanFor('p'),
      assignments: withCard ? [{ nodeId: 'gone', columnId: defaultKanbanFor('p').columns[0].id }] : [],
      ...(withCard ? { meta: [{ nodeId: 'gone', priority: 'low' as const }] } : {})
    })
    const prev: CanvasContent = { nodes: [node('a')], bridges: [], ropes: [], kanban: board(true) }
    const next: CanvasContent = { nodes: [node('a')], bridges: [], ropes: [], kanban: board(false) }
    const ops = diffContent(prev, next, 'p')
    expect(ops).toContainEqual({ op: 'kb-card-remove', nodeId: 'gone' })
    expect(ops).toContainEqual({ op: 'kb-meta-remove', nodeId: 'gone' })
  })
})

// Board convergence under concurrency: two clients and the authority, each applying the reflector's
// stream through the SAME order (`createCanvasOrder`) and the SAME reducer (`applyKanbanOp`), with
// every client publishing through `diffKanbanOps`. A column list is a LIST, and an item op
// (`kb-column`) only says the column exists — its place comes from the order op (ruling R3). Two
// people adding a column at once used to leave A at …,X,Y and B at …,Y,X for good.

import { describe, expect, it } from 'vitest'
import { applyKanbanOp, diffKanbanOps } from './kanban-ops'
import { createCanvasOrder } from './canvas-order'
import { defaultKanbanFor } from './kanban-default-board'
import type { CanvasMutation, KanbanOp, ProjectKanban } from './types'

const P = 'project-1'

interface Replica {
  name: string
  order: ReturnType<typeof createCanvasOrder>
  board: ProjectKanban
}

/** A bus with the reflector's contract: one total order (`seq`), delivered to every replica — the
 *  sender included (its copy is its ack) — and to the authority, in that order. */
function world(names: string[]) {
  let seq = 0
  let authority: ProjectKanban = defaultKanbanFor(P)
  const wire: CanvasMutation[] = []
  const replicas: Replica[] = names.map((name) => ({
    name,
    order: createCanvasOrder(name),
    board: defaultKanbanFor(P)
  }))
  const byName = new Map(replicas.map((r) => [r.name, r]))
  return {
    replicas,
    authority: () => authority,
    /** A local edit on one replica: take the new board, cast its diff (what the publisher does). */
    edit(name: string, next: (b: ProjectKanban) => ProjectKanban) {
      const r = byName.get(name)!
      const after = next(r.board)
      for (const op of diffKanbanOps(r.board, after, P, new Set())) {
        const m = r.order.stamp({ ...op, src: r.name } as CanvasMutation)
        r.order.onLocal(m, P)
        wire.push(m)
      }
      r.board = after
    },
    /** The reflector stamps what arrived, in arrival order, and fans it out. */
    reflect() {
      for (const m of wire.splice(0).map((x) => ({ ...x, seq: ++seq }))) {
        authority = applyKanbanOp(authority, m as unknown as KanbanOp, P)
        for (const r of replicas) {
          if (r.order.accept(m, P)) r.board = applyKanbanOp(r.board, m as unknown as KanbanOp, P)
        }
      }
    }
  }
}

const ids = (k: ProjectKanban) => k.columns.map((c) => c.id)
const add = (id: string, title: string) => (b: ProjectKanban): ProjectKanban => ({
  ...b,
  columns: [...b.columns, { id, title, color: '#123456' }]
})

describe('board convergence (ruling R3)', () => {
  it('two clients adding a column at once converge on every replica and the authority', () => {
    const w = world(['A', 'B'])
    w.edit('A', add('kcol-X', 'X'))
    w.edit('B', add('kcol-Y', 'Y'))
    w.reflect()
    const [a, b] = w.replicas
    expect(ids(a.board)).toEqual(ids(b.board))
    expect(ids(a.board)).toEqual(ids(w.authority()))
    // …on the LATER order op's list: B cast after A, so B's order (…, Y) leads and X follows
    expect(ids(a.board).slice(-2)).toEqual(['kcol-Y', 'kcol-X'])
  })

  it('a column inserted mid-list lands mid-list on the peer (add + move in one edit)', () => {
    const w = world(['A', 'B'])
    w.edit('A', (b) => {
      const [c0, ...rest] = b.columns
      return { ...b, columns: [c0, { id: 'kcol-new', title: 'New', color: '#123456' }, ...rest] }
    })
    w.reflect()
    const [a, b] = w.replicas
    expect(ids(b.board)).toEqual(ids(a.board))
    expect(ids(b.board)[1]).toBe('kcol-new')
    expect(ids(w.authority())).toEqual(ids(a.board))
  })

  it('two clients adding a label at once converge too (kb-label-order)', () => {
    const w = world(['A', 'B'])
    w.edit('A', (b) => ({ ...b, labels: [...(b.labels ?? []), { id: 'l-x', name: 'x', color: 'red' }] }))
    w.edit('B', (b) => ({ ...b, labels: [...(b.labels ?? []), { id: 'l-y', name: 'y', color: 'blue' }] }))
    w.reflect()
    const [a, b] = w.replicas
    const labels = (k: ProjectKanban) => (k.labels ?? []).map((l) => l.id)
    expect(labels(a.board)).toEqual(labels(b.board))
    expect(labels(a.board)).toEqual(labels(w.authority()))
  })
})

// D5: THREE clients. An order op lists the ids its sender knew, so with three concurrent adds the
// winning order op names neither of the other two new ids, and each replica used to leave them in its
// own local (arrival) order — 30 of the 90 reflector interleavings converged. Every interleaving is
// enumerated below, twice: every client edits before anything is reflected (the reflector may take
// the three clients' ops in any order that keeps each client's own order: 90), and edits interleaved
// with the reflection itself (a client may edit after it has already received some ops).
describe('board convergence with three clients (D5)', () => {
  type Edit = (b: ProjectKanban) => ProjectKanban
  const labelIds = (k: ProjectKanban) => (k.labels ?? []).map((l) => l.id)
  const addLabel = (id: string): Edit => (b) => ({ ...b, labels: [...(b.labels ?? []), { id, name: id, color: 'red' }] })

  /** Run one schedule: `E:<c>` = client c edits and casts; `R:<c>` = the reflector takes c's next op. */
  function run(schedule: string[], edits: Record<string, Edit>) {
    let seq = 0
    let authority: ProjectKanban = defaultKanbanFor(P)
    const names = Object.keys(edits)
    const replicas = names.map((name) => ({ name, order: createCanvasOrder(name), board: defaultKanbanFor(P) }))
    const outbox = new Map<string, CanvasMutation[]>(names.map((n) => [n, []]))
    for (const step of schedule) {
      const [kind, who] = step.split(':')
      const r = replicas.find((x) => x.name === who)!
      if (kind === 'E') {
        const after = edits[who](r.board)
        for (const op of diffKanbanOps(r.board, after, P, new Set())) {
          const m = r.order.stamp({ ...op, src: r.name } as CanvasMutation)
          r.order.onLocal(m, P)
          outbox.get(who)!.push(m)
        }
        r.board = after
        continue
      }
      const m = { ...outbox.get(who)!.shift()!, seq: ++seq }
      authority = applyKanbanOp(authority, m as unknown as KanbanOp, P)
      for (const x of replicas) if (x.order.accept(m, P)) x.board = applyKanbanOp(x.board, m as unknown as KanbanOp, P)
    }
    return { replicas, authority }
  }

  /** Every schedule: each client edits once, then the reflector takes its `opsPer` ops, in any
   *  interleaving that keeps a client's own edit before its own ops. `editsFirst` = all edits happen
   *  before any op is reflected. */
  function schedules(names: string[], opsPer: number, editsFirst: boolean): string[][] {
    const out: string[][] = []
    const walk = (acc: string[], edited: Set<string>, sent: Map<string, number>): void => {
      const done = names.every((n) => edited.has(n) && sent.get(n) === opsPer)
      if (done) return void out.push(acc)
      for (const n of names) {
        if (!edited.has(n)) walk([...acc, `E:${n}`], new Set([...edited, n]), sent)
        else if ((sent.get(n) ?? 0) < opsPer && (!editsFirst || edited.size === names.length))
          walk([...acc, `R:${n}`], edited, new Map([...sent, [n, (sent.get(n) ?? 0) + 1]]))
      }
    }
    walk([], new Set(), new Map())
    // With every edit first, the order of the edits themselves does not matter: keep one.
    return editsFirst ? out.filter((s) => s.slice(0, names.length).join() === names.map((n) => `E:${n}`).join()) : out
  }

  const converged = (w: ReturnType<typeof run>, read: (k: ProjectKanban) => string[]): boolean =>
    w.replicas.every((r) => same(read(r.board), read(w.authority)))
  const same = (a: string[], b: string[]) => a.join() === b.join()

  for (const [what, edits, read] of [
    ['a column', { A: add('kcol-X', 'X'), B: add('kcol-Y', 'Y'), C: add('kcol-Z', 'Z') }, ids],
    ['a label', { A: addLabel('l-x'), B: addLabel('l-y'), C: addLabel('l-z') }, labelIds]
  ] as const) {
    it(`three clients adding ${what} at once converge in EVERY reflector interleaving (90 of 90)`, () => {
      const all = schedules(['A', 'B', 'C'], 2, true)
      expect(all).toHaveLength(90)
      const bad = all.filter((s) => !converged(run(s, edits), read))
      expect(bad.length, `diverged: ${bad[0]?.join(' ')}`).toBe(0)
    })

    it(`three clients adding ${what}, edits interleaved with the reflection, always converge`, () => {
      const all = schedules(['A', 'B', 'C'], 2, false)
      expect(all.length).toBeGreaterThan(90)
      const bad = all.filter((s) => !converged(run(s, edits), read))
      expect(bad.length, `diverged: ${bad[0]?.join(' ')} (${bad.length} of ${all.length})`).toBe(0)
      // Every new item is on every board.
      const w = run(all[0], edits)
      for (const r of w.replicas) expect(read(r.board)).toHaveLength(read(defaultKanbanFor(P)).length + 3)
    })
  }
})

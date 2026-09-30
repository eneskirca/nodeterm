// The board reducer and diff (@shared/kanban-ops) run on whatever board a project holds, and a
// board reaches a project through the load seam, `sanitizeKanban`. That seam deliberately admits a
// malformed `meta` and `labels` (types.ts: "tolerated as absent/malformed by every reader") — so the
// reducer and the diff are readers too, and neither may throw on anything the seam lets through.
// A throw here is not a refused op: it is a dead board sync for that project, on every edit.

import { describe, expect, it } from 'vitest'
import { sanitizeKanban } from './workspace-files'
import { applyKanbanOp, diffKanbanOps } from '../shared/kanban-ops'
import { createLabel, setCardLabels, setCardPriority } from '../shared/kanban-labels'
import type { KanbanOp, ProjectKanban } from '../shared/types'

const P = 'project-1'
const col = { id: 'c1', title: 'A', color: '#fff' }

/** Raw file shapes the load seam ADMITS (each is asserted to pass `sanitizeKanban` below). */
const SHAPES: Record<string, unknown> = {
  'meta: {}': { columns: [col], assignments: [], meta: {} },
  'meta: [null]': { columns: [col], assignments: [], meta: [null] },
  'meta: [7, "x", { no nodeId }]': { columns: [col], assignments: [], meta: [7, 'x', { priority: 'high' }] },
  'meta entry with labels: {}': { columns: [col], assignments: [], meta: [{ nodeId: 'n1', labels: { a: 1 } }] },
  'labels: [null]': { columns: [col], assignments: [], labels: [null] },
  'labels: {}': { columns: [col], assignments: [], labels: { a: 1 } },
  'labels: [7, { no id }]': { columns: [col], assignments: [], labels: [7, { name: 'x', color: 'red' }] },
  'views: 5': { columns: [col], assignments: [], views: 5 }
}

const OPS: KanbanOp[] = [
  { op: 'kb-meta', meta: { nodeId: 'n1', priority: 'high' } },
  { op: 'kb-meta-remove', nodeId: 'n1' },
  { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' } },
  { op: 'kb-label-remove', id: 'l1' },
  { op: 'kb-label-order', ids: ['l1'] },
  { op: 'kb-view', view: { id: 'v1', name: 'Mine', query: {} } },
  { op: 'kb-view-remove', id: 'v1' },
  { op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1' } },
  { op: 'kb-card-remove', nodeId: 'n1' },
  { op: 'kb-column', column: { id: 'c2', title: 'B', color: '#000' } },
  { op: 'kb-column-order', ids: ['c2', 'c1'] },
  { op: 'kb-column-remove', id: 'c1' }
]

const admitted = (raw: unknown): ProjectKanban => {
  const b = sanitizeKanban(JSON.parse(JSON.stringify(raw)))
  expect(b, 'the load seam admits this shape').toBeDefined()
  return b as ProjectKanban
}

describe('applyKanbanOp / diffKanbanOps on boards the load seam admits', () => {
  for (const [name, raw] of Object.entries(SHAPES)) {
    it(`${name}: every op applies without throwing`, () => {
      const b = admitted(raw)
      for (const op of OPS) expect(() => applyKanbanOp(b, op, P), op.op).not.toThrow()
    })

    it(`${name}: the diff after any edit does not throw`, () => {
      const b = admitted(raw)
      const created = createLabel(b, 'Bug', 'red')
      const edits: ProjectKanban[] = [
        ...OPS.map((op) => applyKanbanOp(b, op, P)),
        setCardPriority(b, 'n1', 'high'),
        created.k,
        // setCardLabels, not toggleCardLabel: the latter reads a card's `labels` raw and throws on
        // the malformed shape itself (pre-existing, reported) — this suite is about the reducer/diff.
        setCardLabels(created.k, 'n1', [created.id])
      ]
      for (const next of edits) {
        expect(() => diffKanbanOps(b, next, P, new Set(['n1']))).not.toThrow()
        expect(() => diffKanbanOps(next, b, P, new Set(['n1']))).not.toThrow()
      }
    })
  }

  it('a malformed meta is read as the valid entries it holds (none), and a write repairs it', () => {
    const b = admitted(SHAPES['meta: {}'])
    const next = applyKanbanOp(b, { op: 'kb-meta', meta: { nodeId: 'n1', priority: 'high' } }, P)
    expect(next.meta).toEqual([{ nodeId: 'n1', priority: 'high' }])
    const nulls = admitted(SHAPES['meta: [null]'])
    expect(applyKanbanOp(nulls, { op: 'kb-meta-remove', nodeId: 'n1' }, P).meta).toEqual([])
  })

  it('a malformed labels list is read as its valid entries, and a label op writes a clean list', () => {
    const b = admitted(SHAPES['labels: [null]'])
    expect(applyKanbanOp(b, { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' } }, P).labels)
      .toEqual([{ id: 'l1', name: 'Bug', color: 'red' }])
    expect(applyKanbanOp(b, { op: 'kb-label-remove', id: 'l1' }, P).labels).toEqual([])
  })

  it('an edit to a malformed board diffs to the ops for what actually changed', () => {
    const b = admitted(SHAPES['meta: {}'])
    expect(diffKanbanOps(b, setCardPriority(b, 'n1', 'high'), P, new Set(['n1']))).toEqual([
      { op: 'kb-meta', meta: { nodeId: 'n1', priority: 'high' } }
    ])
  })
})

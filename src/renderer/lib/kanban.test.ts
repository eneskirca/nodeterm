import { describe, it, expect } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import {
  addColumn, assignNode, assignedTo, defaultKanban, deleteColumn, moveColumn,
  cardMeta, columnForNode, nextColumnColor, pruneAssignments, recolorColumn, renameColumn,
  setCardDue, setCardPriority, toggleAssignee, unassigned,
  boardLabels, cardMatchesLabelFilter, createLabel, deleteLabel, labelColor, labelsForCard,
  recolorLabel, renameLabel, reorderLabels, toggleCardLabel,
  autoLabelColor, migrateProjectTags, migrateTagsToLabels, setCardLabels
} from './kanban'
import type { Project } from '@shared/types'

const board = (): ProjectKanban => ({
  columns: [
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Doing', color: '#ffd60a' }
  ],
  assignments: [
    { nodeId: 'n1', columnId: 'a' },
    { nodeId: 'n2', columnId: 'b' },
    { nodeId: 'n3', columnId: 'a' }
  ]
})

describe('defaultKanban', () => {
  it('makes To Do / In Progress / Done with unique ids and no assignments', () => {
    const k = defaultKanban()
    expect(k.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(new Set(k.columns.map((c) => c.id)).size).toBe(3)
    expect(k.assignments).toEqual([])
  })
})

describe('columns', () => {
  it('addColumn appends; nextColumnColor cycles the palette', () => {
    const k = addColumn(board(), 'Review', nextColumnColor(board()))
    expect(k.columns).toHaveLength(3)
    expect(k.columns[2].title).toBe('Review')
  })
  it('renameColumn / recolorColumn touch only the target', () => {
    const k = recolorColumn(renameColumn(board(), 'b', 'WIP'), 'b', '#fff')
    expect(k.columns[1]).toMatchObject({ id: 'b', title: 'WIP', color: '#fff' })
    expect(k.columns[0]).toEqual(board().columns[0])
  })
  it('moveColumn before a target and to the end (null)', () => {
    expect(moveColumn(board(), 'b', 'a').columns.map((c) => c.id)).toEqual(['b', 'a'])
    expect(moveColumn(board(), 'a', null).columns.map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('deleteColumn drops the column AND its assignments (cards return to Ungrouped); unknown id no-op', () => {
    const configured: ProjectKanban = {
      ...board(),
      github: {
        repository: 'nodeterm/nodeterm',
        columnMappings: [{ columnId: 'b', label: 'status:doing' }]
      }
    }
    const k = deleteColumn(configured, 'a')
    expect(k.columns.map((c) => c.id)).toEqual(['b'])
    expect(k.assignments).toEqual([{ nodeId: 'n2', columnId: 'b' }])
    expect(k.github).toEqual(configured.github)
    expect(deleteColumn(board(), 'nope')).toEqual(board())
  })
  it('deleting every user column is allowed (Ungrouped always remains)', () => {
    const k = deleteColumn(deleteColumn(board(), 'a'), 'b')
    expect(k.columns).toEqual([])
    expect(k.assignments).toEqual([])
  })
  it('deleteColumn removes that column from GitHub mappings and clears it as completion', () => {
    const configured: ProjectKanban = {
      ...board(),
      github: {
        repository: 'nodeterm/nodeterm',
        columnMappings: [
          { columnId: 'a', label: 'status:todo' },
          { columnId: 'b', label: 'status:doing' }
        ],
        completionColumnId: 'a'
      }
    }
    expect(deleteColumn(configured, 'a').github).toEqual({
      repository: 'nodeterm/nodeterm',
      columnMappings: [{ columnId: 'b', label: 'status:doing' }]
    })
  })
})

describe('assignments', () => {
  it('assignedTo returns a column in array order; unassigned follows sessionIds order', () => {
    expect(assignedTo(board(), 'a')).toEqual(['n1', 'n3'])
    expect(unassigned(board(), ['n4', 'n1', 'n5'])).toEqual(['n4', 'n5'])
  })
  it('a dangling assignment (missing column) counts as unassigned', () => {
    const k: ProjectKanban = { ...board(), assignments: [{ nodeId: 'n1', columnId: 'gone' }] }
    expect(unassigned(k, ['n1', 'n2'])).toEqual(['n1', 'n2'])
    expect(assignedTo(k, 'a')).toEqual([])
  })
  it('assignNode into a column at the end (null) and before a target', () => {
    const atEnd = assignNode(board(), 'n9', 'b', null)
    expect(assignedTo(atEnd, 'b')).toEqual(['n2', 'n9'])
    const before = assignNode(board(), 'n2', 'a', 'n3')
    expect(assignedTo(before, 'a')).toEqual(['n1', 'n2', 'n3'])
    expect(assignedTo(before, 'b')).toEqual([])
  })
  it('assignNode with columnId null removes the assignment (back to Ungrouped)', () => {
    const k = assignNode(board(), 'n1', null, null)
    expect(k.assignments.map((a) => a.nodeId)).toEqual(['n2', 'n3'])
  })
  it('assignNode: beforeNode in a different column ⇒ end; unknown column ⇒ no-op; self-before ⇒ no-op', () => {
    const k = assignNode(board(), 'n1', 'b', 'n3')
    expect(assignedTo(k, 'b')).toEqual(['n2', 'n1'])
    expect(assignNode(board(), 'n1', 'nope', null)).toEqual(board())
    expect(assignNode(board(), 'n1', 'a', 'n1')).toEqual(board())
  })
  it('pruneAssignments drops dead nodes, returns the same object when nothing changes', () => {
    const k = pruneAssignments(board(), ['n1', 'n3'])
    expect(k.assignments.map((a) => a.nodeId)).toEqual(['n1', 'n3'])
    const same = board()
    expect(pruneAssignments(same, ['n1', 'n2', 'n3'])).toBe(same)
  })
})

describe('columnForNode', () => {
  it('resolves the assigned column; undefined for unassigned, dangling, or no board', () => {
    expect(columnForNode(board(), 'n1')).toMatchObject({ id: 'a', title: 'To Do' })
    expect(columnForNode(board(), 'n9')).toBeUndefined()
    const dangling: ProjectKanban = { ...board(), assignments: [{ nodeId: 'n1', columnId: 'gone' }] }
    expect(columnForNode(dangling, 'n1')).toBeUndefined()
    expect(columnForNode(undefined, 'n1')).toBeUndefined()
  })
})

describe('card meta', () => {
  const enes = { name: 'enes', color: '#0a84ff' }
  const mehmet = { name: 'mehmet', color: '#bf5af2' }
  it('cardMeta tolerates absent/malformed meta', () => {
    expect(cardMeta(board(), 'n1')).toBeUndefined()
    const bad = { ...board(), meta: 42 } as unknown as ProjectKanban
    expect(cardMeta(bad, 'n1')).toBeUndefined()
  })
  it('toggleAssignee adds then removes by name; empty meta entries are dropped', () => {
    const k1 = toggleAssignee(board(), 'n1', enes)
    expect(cardMeta(k1, 'n1')?.assignees).toEqual([enes])
    const k2 = toggleAssignee(k1, 'n1', mehmet)
    expect(cardMeta(k2, 'n1')?.assignees).toEqual([enes, mehmet])
    const k3 = toggleAssignee(k2, 'n1', { ...enes, color: '#fff' }) // match by NAME
    expect(cardMeta(k3, 'n1')?.assignees).toEqual([mehmet])
    const k4 = toggleAssignee(toggleAssignee(k3, 'n1', mehmet), 'n1', enes)
    expect(cardMeta(k4, 'n1')?.assignees).toEqual([enes])
    const k5 = toggleAssignee(k4, 'n1', enes)
    expect(cardMeta(k5, 'n1')).toBeUndefined() // nothing left → entry dropped
  })
  it('setCardDue sets and clears; clearing the only field drops the entry', () => {
    const k1 = setCardDue(board(), 'n2', 1784500000000)
    expect(cardMeta(k1, 'n2')?.dueAt).toBe(1784500000000)
    const k2 = setCardDue(k1, 'n2', null)
    expect(cardMeta(k2, 'n2')).toBeUndefined()
  })
  it('pruneAssignments also drops dead nodes\' meta, and stays identity-stable on no-op', () => {
    const k = setCardDue(toggleAssignee(board(), 'n1', enes), 'n9', 5)
    const pruned = pruneAssignments(k, ['n1', 'n2', 'n3'])
    expect(cardMeta(pruned, 'n1')?.assignees).toEqual([enes])
    expect(cardMeta(pruned, 'n9')).toBeUndefined()
    const same = setCardDue(board(), 'n1', 7)
    expect(pruneAssignments(same, ['n1', 'n2', 'n3'])).toBe(same)
  })
})

describe('card priority', () => {
  const enes = { name: 'enes', color: '#0a84ff' }
  it('setCardPriority sets, changes and clears; clearing the only field drops the entry', () => {
    const k1 = setCardPriority(board(), 'n1', 'high')
    expect(cardMeta(k1, 'n1')?.priority).toBe('high')
    const k2 = setCardPriority(k1, 'n1', 'urgent')
    expect(cardMeta(k2, 'n1')?.priority).toBe('urgent')
    expect(cardMeta(setCardPriority(k2, 'n1', null), 'n1')).toBeUndefined()
  })
  it('priority survives assignee/due edits (and vice versa)', () => {
    const k = setCardDue(toggleAssignee(setCardPriority(board(), 'n1', 'low'), 'n1', enes), 'n1', 9)
    expect(cardMeta(k, 'n1')).toMatchObject({ priority: 'low', dueAt: 9, assignees: [enes] })
    const cleared = setCardDue(k, 'n1', null)
    expect(cardMeta(cleared, 'n1')).toMatchObject({ priority: 'low', assignees: [enes] })
    expect(cardMeta(cleared, 'n1')?.dueAt).toBeUndefined()
  })
})

describe('board labels', () => {
  it('createLabel adds to the palette and returns the new id; labelColor normalizes garbage', () => {
    const { k, id } = createLabel(board(), '  Bug ', 'red')
    expect(boardLabels(k)).toHaveLength(1)
    expect(boardLabels(k)[0]).toMatchObject({ id, name: 'Bug', color: 'red' })
    expect(labelColor('nonsense')).toBe('default')
    // a garbage color at create time is coerced to 'default'
    const { k: k2 } = createLabel(board(), 'x', 'chartreuse' as never)
    expect(boardLabels(k2)[0].color).toBe('default')
  })

  it('rename / recolor touch only the target label', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const idA = boardLabels(k)[0].id
    k = createLabel(k, 'B', 'green').k
    const idB = boardLabels(k)[1].id
    k = recolorLabel(renameLabel(k, idA, 'Acil'), idA, 'orange')
    expect(boardLabels(k)[0]).toMatchObject({ id: idA, name: 'Acil', color: 'orange' })
    expect(boardLabels(k)[1]).toMatchObject({ id: idB, name: 'B', color: 'green' })
  })

  it('toggleCardLabel adds then removes; labelsForCard resolves in palette order and drops dangling', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const a = boardLabels(k)[0].id
    k = createLabel(k, 'B', 'green').k
    const b = boardLabels(k)[1].id
    k = toggleCardLabel(toggleCardLabel(k, 'n1', b), 'n1', a) // apply b then a
    // resolved in PALETTE order (a before b), not application order
    expect(labelsForCard(k, 'n1').map((l) => l.name)).toEqual(['A', 'B'])
    // a card carrying a since-deleted id resolves to nothing for it
    k = { ...k, meta: [{ nodeId: 'n1', labels: [a, 'ghost'] }] }
    expect(labelsForCard(k, 'n1').map((l) => l.name)).toEqual(['A'])
    // toggling a on again removes it
    k = toggleCardLabel({ ...k, meta: [{ nodeId: 'n1', labels: [a] }] }, 'n1', a)
    expect(cardMeta(k, 'n1')).toBeUndefined() // emptied meta entry is dropped
  })

  it('deleteLabel removes the label AND strips its id from every card', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const a = boardLabels(k)[0].id
    k = createLabel(k, 'B', 'green').k
    const b = boardLabels(k)[1].id
    k = toggleCardLabel(toggleCardLabel(k, 'n1', a), 'n1', b)
    k = toggleCardLabel(k, 'n2', a)
    k = deleteLabel(k, a)
    expect(boardLabels(k).map((l) => l.name)).toEqual(['B'])
    expect(cardMeta(k, 'n1')?.labels).toEqual([b]) // a stripped, b kept
    expect(cardMeta(k, 'n2')).toBeUndefined() // n2 had only a → meta entry dropped
  })

  it('deleteLabel preserves a card entry that still has OTHER meta', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const a = boardLabels(k)[0].id
    k = setCardPriority(toggleCardLabel(k, 'n1', a), 'n1', 'high')
    k = deleteLabel(k, a)
    expect(cardMeta(k, 'n1')).toMatchObject({ priority: 'high' })
    expect(cardMeta(k, 'n1')?.labels ?? []).toEqual([])
  })

  it('reorderLabels moves a label before another (null = end)', () => {
    let k = createLabel(createLabel(createLabel(board(), 'A', 'blue').k, 'B', 'green').k, 'C', 'red').k
    const [a, b, c] = boardLabels(k).map((l) => l.id)
    expect(boardLabels(reorderLabels(k, c, a)).map((l) => l.name)).toEqual(['C', 'A', 'B'])
    expect(boardLabels(reorderLabels(k, a, null)).map((l) => l.name)).toEqual(['B', 'C', 'A'])
  })

  it('cardMatchesLabelFilter: empty filter matches all; otherwise OR over the card labels', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const a = boardLabels(k)[0].id
    k = createLabel(k, 'B', 'green').k
    const b = boardLabels(k)[1].id
    k = toggleCardLabel(k, 'n1', a) // n1 has A only
    expect(cardMatchesLabelFilter(k, 'n1', [])).toBe(true)
    expect(cardMatchesLabelFilter(k, 'n1', [a])).toBe(true)
    expect(cardMatchesLabelFilter(k, 'n1', [b])).toBe(false)
    expect(cardMatchesLabelFilter(k, 'n1', [a, b])).toBe(true) // OR
    expect(cardMatchesLabelFilter(k, 'n2', [a])).toBe(false) // n2 unlabelled
  })

  it('boardLabels tolerates a missing/garbage labels array', () => {
    expect(boardLabels({ columns: [], assignments: [] })).toEqual([])
    expect(boardLabels({ columns: [], assignments: [], labels: 'x' as never })).toEqual([])
    expect(boardLabels({ columns: [], assignments: [], labels: [null, { id: 'z', name: 'Z', color: 'blue' }] as never })).toHaveLength(1)
  })

  it('setCardDue / toggleAssignee preserve existing labels', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const a = boardLabels(k)[0].id
    k = toggleCardLabel(k, 'n1', a)
    k = setCardDue(k, 'n1', 123)
    expect(cardMeta(k, 'n1')).toMatchObject({ dueAt: 123, labels: [a] })
    k = toggleAssignee(k, 'n1', { name: 'enes', color: '#fff' })
    expect(cardMeta(k, 'n1')?.labels).toEqual([a])
  })
})

describe('tag → label migration', () => {
  const proj = (nodes: Array<Partial<Project['nodes'][number]> & { id: string }>, kanban?: Project['kanban']): Project => ({
    id: 'p', name: 'P', color: '#888', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map((n) => ({
      kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
      title: n.id, color: '#888', group: null, ...n
    })) as Project['nodes'],
    ...(kanban ? { kanban } : {})
  })

  it('setCardLabels sets the exact list; empty drops the entry', () => {
    let k = createLabel(board(), 'A', 'blue').k
    const a = boardLabels(k)[0].id
    k = setCardLabels(k, 'n1', [a, a]) // dedup
    expect(cardMeta(k, 'n1')?.labels).toEqual([a])
    expect(cardMeta(setCardLabels(k, 'n1', []), 'n1')).toBeUndefined()
  })

  it('autoLabelColor rotates the palette skipping default', () => {
    let k = board()
    expect(autoLabelColor(k)).toBe('gray')
    k = createLabel(k, 'A', 'gray').k
    expect(autoLabelColor(k)).toBe('brown')
  })

  it('migrateTagsToLabels creates a label per unique tag, reuses by name (case-insensitive)', () => {
    let k = migrateTagsToLabels(board(), [{ nodeId: 'n1', tags: ['bug', 'bug', 'ui'] }])
    expect(boardLabels(k).map((l) => l.name)).toEqual(['bug', 'ui'])
    expect(labelsForCard(k, 'n1').map((l) => l.name)).toEqual(['bug', 'ui'])
    // a second node with the SAME tag name (different case) reuses the label
    k = migrateTagsToLabels(k, [{ nodeId: 'n2', tags: ['BUG'] }])
    expect(boardLabels(k)).toHaveLength(2) // no dup created
    expect(labelsForCard(k, 'n2').map((l) => l.name)).toEqual(['bug'])
  })

  it('migrateProjectTags: tags → labels, node.tags cleared, unchanged when no tags', () => {
    const p = proj([{ id: 'n1', tags: ['bug', 'backend'] }, { id: 'n2' }])
    const m = migrateProjectTags(p)
    expect(boardLabels(m.kanban!).map((l) => l.name)).toEqual(['bug', 'backend'])
    expect(labelsForCard(m.kanban!, 'n1').map((l) => l.name)).toEqual(['bug', 'backend'])
    expect((m.nodes[0] as { tags?: unknown }).tags).toBeUndefined() // cleared
    // a project with NO tagged nodes is returned by identity (idempotent no-op)
    const clean = proj([{ id: 'n1' }])
    expect(migrateProjectTags(clean)).toBe(clean)
    // running twice is a no-op (the second run finds no tags)
    expect(migrateProjectTags(m)).toBe(m)
  })

  it("migrateProjectTags honors the legacy ['claude'] marker: agentId set, NOT a label", () => {
    const p = proj([{ id: 'n1', tags: ['claude'] }, { id: 'n2', tags: ['claude', 'wip'] }])
    const m = migrateProjectTags(p)
    // 'claude' becomes agentId, never a label
    expect(m.nodes.find((n) => n.id === 'n1')!.agentId).toBe('claude')
    expect(boardLabels(m.kanban!).map((l) => l.name)).toEqual(['wip']) // only the non-claude tag
    expect(labelsForCard(m.kanban!, 'n1')).toEqual([]) // claude-only node gets no label
    expect(labelsForCard(m.kanban!, 'n2').map((l) => l.name)).toEqual(['wip'])
    // a node that ALREADY has agentId is not overwritten
    const withAgent = proj([{ id: 'n1', tags: ['claude'], agentId: 'codex' }])
    expect(migrateProjectTags(withAgent).nodes[0].agentId).toBe('codex')
  })

  it('migrateProjectTags reuses an existing board label and seeds a default board when absent', () => {
    // no kanban → a default board (3 columns) is seeded so the board is never column-less
    const m = migrateProjectTags(proj([{ id: 'n1', tags: ['x'] }]))
    expect(m.kanban!.columns).toHaveLength(3)
    // an existing label of the same name is reused, not duplicated
    const existing = createLabel(defaultKanban(), 'x', 'red').k
    const m2 = migrateProjectTags(proj([{ id: 'n1', tags: ['x'] }], existing))
    expect(boardLabels(m2.kanban!)).toHaveLength(1)
    expect(labelsForCard(m2.kanban!, 'n1')[0]).toMatchObject({ name: 'x', color: 'red' })
  })
})

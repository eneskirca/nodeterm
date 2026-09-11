import { describe, expect, it } from 'vitest'
import { ensureProjectBoard, setProjectCardColumn } from './project-kanban-write'
import { DEFAULT_BOARD_COLUMNS } from '../shared/kanban-default-board'

const NOW = new Date('2026-09-10T12:00:00.000Z')

function file(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    rev: 7,
    savedAt: '2026-01-01T00:00:00.000Z',
    name: 'p',
    color: '#0a84ff',
    nodes: [{ id: 'term-a-1', kind: 'terminal' }],
    ...extra
  })
}

const parse = (s: string | null): Record<string, any> => JSON.parse(s ?? 'null')

describe('ensureProjectBoard', () => {
  it('seeds the shared default columns, in order, on a project with no board', () => {
    const out = parse(ensureProjectBoard(file(), NOW, () => 'kcol-fixed'))
    expect(out.kanban.columns.map((c: { title: string }) => c.title)).toEqual(
      DEFAULT_BOARD_COLUMNS.map((c) => c.title)
    )
    expect(out.kanban.columns.map((c: { color: string }) => c.color)).toEqual(
      DEFAULT_BOARD_COLUMNS.map((c) => c.color)
    )
    expect(out.kanban.assignments).toEqual([])
    expect(out.rev).toBe(8)
    expect(out.savedAt).toBe(NOW.toISOString())
  })

  it('mints a distinct id per column, in the desktop shape', () => {
    const out = parse(ensureProjectBoard(file(), NOW))
    const ids: string[] = out.kanban.columns.map((c: { id: string }) => c.id)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^kcol-[a-z0-9]{1,8}$/)
  })

  it('is idempotent: a board that already has a column is not touched', () => {
    const raw = file({ kanban: { columns: [{ id: 'kcol-x', title: 'Mine', color: '#fff' }], assignments: [] } })
    expect(ensureProjectBoard(raw, NOW)).toBeNull()
  })

  it('seeds over an EMPTY columns array (a board block with nothing in it is no board)', () => {
    const out = parse(ensureProjectBoard(file({ kanban: { columns: [], assignments: [] } }), NOW))
    expect(out.kanban.columns).toHaveLength(3)
  })

  it('keeps board metadata the phone has no UI for', () => {
    const raw = file({ kanban: { columns: [], meta: [{ nodeId: 'term-a-1', priority: 'high' }], labels: [{ id: 'l1' }] } })
    const out = parse(ensureProjectBoard(raw, NOW))
    expect(out.kanban.meta).toEqual([{ nodeId: 'term-a-1', priority: 'high' }])
    expect(out.kanban.labels).toEqual([{ id: 'l1' }])
  })

  it('round-trips every field this version does not know', () => {
    const out = parse(ensureProjectBoard(file({ bridges: [{ id: 'b' }], somethingFuture: 42 }), NOW))
    expect(out.bridges).toEqual([{ id: 'b' }])
    expect(out.somethingFuture).toBe(42)
  })

  it('refuses a file it could not parse, or one of another shape', () => {
    expect(ensureProjectBoard('{not json', NOW)).toBeNull()
    expect(ensureProjectBoard('[]', NOW)).toBeNull()
    expect(ensureProjectBoard(JSON.stringify({ version: 2, rev: 1, nodes: [] }), NOW)).toBeNull()
    expect(ensureProjectBoard(JSON.stringify({ version: 1, nodes: [] }), NOW)).toBeNull()
  })

  it('refuses a `kanban` that is not an object rather than replacing it', () => {
    expect(ensureProjectBoard(file({ kanban: 'nope' }), NOW)).toBeNull()
    expect(ensureProjectBoard(file({ kanban: [] }), NOW)).toBeNull()
  })
})

describe('setProjectCardColumn', () => {
  const board = (assignments: unknown[] = []): string =>
    file({
      kanban: {
        columns: [
          { id: 'kcol-a', title: 'To Do', color: '#0a84ff' },
          { id: 'kcol-b', title: 'Done', color: '#32d74b' }
        ],
        assignments,
        meta: [{ nodeId: 'term-a-1', priority: 'high' }]
      }
    })

  it('assigns an unassigned card and bumps rev', () => {
    const out = parse(setProjectCardColumn(board(), 'term-a-1', 'kcol-a', NOW))
    expect(out.kanban.assignments).toEqual([{ nodeId: 'term-a-1', columnId: 'kcol-a' }])
    expect(out.rev).toBe(8)
  })

  it('re-points an existing assignment instead of adding a second one', () => {
    const out = parse(
      setProjectCardColumn(board([{ nodeId: 'term-a-1', columnId: 'kcol-a' }]), 'term-a-1', 'kcol-b', NOW)
    )
    expect(out.kanban.assignments).toEqual([{ nodeId: 'term-a-1', columnId: 'kcol-b' }])
  })

  it('columnId null drops the assignment (the virtual Ungrouped column)', () => {
    const out = parse(
      setProjectCardColumn(board([{ nodeId: 'term-a-1', columnId: 'kcol-a' }]), 'term-a-1', null, NOW)
    )
    expect(out.kanban.assignments).toEqual([])
  })

  it('leaves other cards, and the card metadata, alone', () => {
    const out = parse(
      setProjectCardColumn(board([{ nodeId: 'term-z-9', columnId: 'kcol-b' }]), 'term-a-1', 'kcol-a', NOW)
    )
    expect(out.kanban.assignments).toEqual([
      { nodeId: 'term-z-9', columnId: 'kcol-b' },
      { nodeId: 'term-a-1', columnId: 'kcol-a' }
    ])
    expect(out.kanban.meta).toEqual([{ nodeId: 'term-a-1', priority: 'high' }])
  })

  it('refuses a column this board does not have', () => {
    expect(setProjectCardColumn(board(), 'term-a-1', 'kcol-gone', NOW)).toBeNull()
  })

  it('refuses a no-op move (a retry must not churn rev)', () => {
    expect(
      setProjectCardColumn(board([{ nodeId: 'term-a-1', columnId: 'kcol-a' }]), 'term-a-1', 'kcol-a', NOW)
    ).toBeNull()
    expect(setProjectCardColumn(board(), 'term-a-1', null, NOW)).toBeNull()
  })

  it('accepts a node id the canvas does not list yet (it may have just been registered)', () => {
    const out = parse(setProjectCardColumn(board(), 'term-new-1', 'kcol-a', NOW))
    expect(out.kanban.assignments).toEqual([{ nodeId: 'term-new-1', columnId: 'kcol-a' }])
  })

  it('refuses a project with no board at all — the caller seeds one first', () => {
    expect(setProjectCardColumn(file(), 'term-a-1', 'kcol-a', NOW)).toBeNull()
    expect(setProjectCardColumn(file(), 'term-a-1', null, NOW)).toBeNull()
  })

  it('refuses an empty node id and an unparsable file', () => {
    expect(setProjectCardColumn(board(), '', 'kcol-a', NOW)).toBeNull()
    expect(setProjectCardColumn('{not json', 'term-a-1', 'kcol-a', NOW)).toBeNull()
  })
})

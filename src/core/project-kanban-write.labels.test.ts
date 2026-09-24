// The phone's label verb (`projects.editCardLabels`) against the ONE label model the desktop edits.
// What these pin:
//   - Round trip: a label the phone adds is the label the canvas node's "+ Label" row and the kanban
//     card render (`labelsForCard`), and a label the desktop picker created is one the phone can
//     apply/remove by id — both directions through the same `@shared/kanban-labels` transforms.
//   - Adding the first label seeds the default board, exactly like the desktop's first "+ Label".
//   - Write-site validation of hostile input: ids, names, colours, contradictory edits.
//   - Nothing else in the file moves: columns, assignments, other cards' meta, this card's other meta.
import { describe, expect, it } from 'vitest'
import {
  LABEL_NAME_MAX,
  editProjectCardLabels,
  parseCardLabelEdit,
  type CardLabelEdit
} from './project-kanban-write'
import { DEFAULT_BOARD_COLUMNS } from '../shared/kanban-default-board'
import { createLabel, labelsForCard, toggleCardLabel } from '../shared/kanban-labels'
import type { ProjectKanban } from '../shared/types'

const NOW = new Date('2026-09-23T12:00:00.000Z')

function file(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    rev: 3,
    savedAt: '2026-01-01T00:00:00.000Z',
    name: 'p',
    color: '#0a84ff',
    nodes: [{ id: 'term-a', kind: 'terminal' }, { id: 'term-b', kind: 'terminal' }],
    ...extra
  })
}
const parse = (s: string | null): Record<string, any> => JSON.parse(s ?? 'null')

const BOARD: ProjectKanban = {
  columns: [{ id: 'kcol-1', title: 'Doing', color: '#fff' }],
  assignments: [{ nodeId: 'term-a', columnId: 'kcol-1' }],
  labels: [
    { id: 'klbl-bug', name: 'bug', color: 'red' },
    { id: 'klbl-ui', name: 'UI', color: 'blue' }
  ],
  meta: [
    { nodeId: 'term-a', priority: 'high', labels: ['klbl-bug'] },
    { nodeId: 'term-b', labels: ['klbl-ui'] }
  ]
}
const edit = (e: CardLabelEdit): CardLabelEdit => parseCardLabelEdit(e)!

describe('editProjectCardLabels — round trip with the desktop label model', () => {
  it('an id the phone adds is what the canvas node / kanban card then render', () => {
    const out = parse(editProjectCardLabels(file({ kanban: BOARD }), 'term-a', edit({ add: ['klbl-ui'] }), NOW))
    expect(labelsForCard(out.kanban, 'term-a').map((l) => l.name)).toEqual(['bug', 'UI'])
    expect(out.rev).toBe(4)
    expect(out.savedAt).toBe(NOW.toISOString())
  })

  it('produces the SAME board the desktop picker (toggleCardLabel) produces for the same edit', () => {
    const phone = parse(editProjectCardLabels(file({ kanban: BOARD }), 'term-a', edit({ add: ['klbl-ui'] }), NOW))
    const desktop = toggleCardLabel(BOARD, 'term-a', 'klbl-ui')
    expect(phone.kanban).toEqual(desktop)
  })

  it('removes a label the desktop created, and drops the meta entry when nothing is left', () => {
    const out = parse(editProjectCardLabels(file({ kanban: BOARD }), 'term-b', edit({ remove: ['klbl-ui'] }), NOW))
    expect(out.kanban.meta.find((m: { nodeId: string }) => m.nodeId === 'term-b')).toBeUndefined()
    // the palette entry itself survives — "remove from this session" is not "delete the label"
    expect(out.kanban.labels.map((l: { id: string }) => l.id)).toEqual(['klbl-bug', 'klbl-ui'])
  })

  it('a created label joins the palette with a desktop-shaped id and is applied to the card', () => {
    const out = parse(
      editProjectCardLabels(file({ kanban: BOARD }), 'term-b', edit({ create: [{ name: '  ship it ', color: 'green' }] }), NOW)
    )
    const created = out.kanban.labels.at(-1)
    expect(created).toMatchObject({ name: 'ship it', color: 'green' })
    expect(created.id).toMatch(/^klbl-[a-z0-9]{1,8}$/)
    expect(labelsForCard(out.kanban, 'term-b').map((l) => l.name)).toEqual(['UI', 'ship it'])
    // …and the desktop can toggle it off again by that id
    expect(labelsForCard(toggleCardLabel(out.kanban, 'term-b', created.id), 'term-b').map((l) => l.name)).toEqual(['UI'])
  })

  it('a label the desktop picker just created is immediately addable from the phone', () => {
    const { k, id } = createLabel(BOARD, 'docs', 'yellow')
    const out = parse(editProjectCardLabels(file({ kanban: k }), 'term-b', edit({ add: [id] }), NOW))
    expect(labelsForCard(out.kanban, 'term-b').map((l) => l.name)).toEqual(['UI', 'docs'])
  })

  it('creating a name that already exists (case-insensitive) REUSES it instead of minting a duplicate', () => {
    const out = parse(editProjectCardLabels(file({ kanban: BOARD }), 'term-b', edit({ create: [{ name: 'BUG', color: 'gray' }] }), NOW))
    expect(out.kanban.labels).toHaveLength(2)
    expect(out.kanban.meta.find((m: { nodeId: string }) => m.nodeId === 'term-b').labels).toEqual(['klbl-ui', 'klbl-bug'])
  })

  it('keeps columns, assignments, other cards and this card\'s other meta exactly as they were', () => {
    const out = parse(editProjectCardLabels(file({ kanban: BOARD, bridges: [{ id: 'x' }] }), 'term-a', edit({ add: ['klbl-ui'] }), NOW))
    expect(out.kanban.columns).toEqual(BOARD.columns)
    expect(out.kanban.assignments).toEqual(BOARD.assignments)
    expect(out.kanban.meta.find((m: { nodeId: string }) => m.nodeId === 'term-b')).toEqual({ nodeId: 'term-b', labels: ['klbl-ui'] })
    expect(out.kanban.meta.find((m: { nodeId: string }) => m.nodeId === 'term-a').priority).toBe('high')
    expect(out.bridges).toEqual([{ id: 'x' }])
  })

  it('keeps a GitHub mapping block it has no UI for', () => {
    const github = { columnMappings: [{ columnId: 'kcol-1', label: 'doing' }] }
    const out = parse(editProjectCardLabels(file({ kanban: { ...BOARD, github } }), 'term-a', edit({ add: ['klbl-ui'] }), NOW))
    expect(out.kanban.github).toEqual(github)
  })
})

describe('editProjectCardLabels — the first label seeds the board', () => {
  it('a project with no board gets the default columns plus the label', () => {
    const out = parse(
      editProjectCardLabels(file(), 'term-a', edit({ create: [{ name: 'bug', color: 'red' }] }), NOW, () => 'kcol-x')
    )
    expect(out.kanban.columns.map((c: { title: string }) => c.title)).toEqual(DEFAULT_BOARD_COLUMNS.map((c) => c.title))
    expect(out.kanban.assignments).toEqual([])
    expect(labelsForCard(out.kanban, 'term-a').map((l) => l.name)).toEqual(['bug'])
  })

  it('a no-op on a project with no board writes nothing (no board nobody asked for)', () => {
    expect(editProjectCardLabels(file(), 'term-a', edit({ remove: ['klbl-bug'] }), NOW)).toBeNull()
  })
})

describe('editProjectCardLabels — refusals (null, nothing written)', () => {
  it('refuses an add naming a label this palette does not have (stale phone copy)', () => {
    expect(editProjectCardLabels(file({ kanban: BOARD }), 'term-a', edit({ add: ['klbl-gone'] }), NOW)).toBeNull()
  })

  it('writes nothing for an edit that is already satisfied — a retry must not churn rev', () => {
    expect(editProjectCardLabels(file({ kanban: BOARD }), 'term-a', edit({ add: ['klbl-bug'] }), NOW)).toBeNull()
  })

  it('refuses a kanban block of a shape it must not replace', () => {
    expect(editProjectCardLabels(file({ kanban: [1, 2] }), 'term-a', edit({ add: ['klbl-bug'] }), NOW)).toBeNull()
    expect(editProjectCardLabels(file({ kanban: 'x' }), 'term-a', edit({ add: ['klbl-bug'] }), NOW)).toBeNull()
  })

  it('refuses a file that is not the project shape', () => {
    expect(editProjectCardLabels('not json', 'term-a', edit({ add: ['klbl-bug'] }), NOW)).toBeNull()
    expect(editProjectCardLabels(JSON.stringify({ version: 2, rev: 1, nodes: [] }), 'term-a', edit({ add: ['a'] }), NOW)).toBeNull()
  })

  it('refuses an empty or control-bearing nodeId', () => {
    expect(editProjectCardLabels(file({ kanban: BOARD }), '', edit({ add: ['klbl-ui'] }), NOW)).toBeNull()
    expect(editProjectCardLabels(file({ kanban: BOARD }), 'term-a\n', edit({ add: ['klbl-ui'] }), NOW)).toBeNull()
  })
})

describe('parseCardLabelEdit — write-site validation of client-sent params', () => {
  it('accepts the three lists and dedupes ids', () => {
    expect(parseCardLabelEdit({ add: ['a', 'a'], remove: ['b'], create: [{ name: 'x', color: 'pink' }] })).toEqual({
      add: ['a'], remove: ['b'], create: [{ name: 'x', color: 'pink' }]
    })
  })

  it('trims names and collapses duplicate creations by the picker\'s name identity', () => {
    expect(parseCardLabelEdit({ create: [{ name: ' Bug ', color: 'red' }, { name: 'bug', color: 'blue' }] })?.create).toEqual([
      { name: 'Bug', color: 'red' }
    ])
  })

  it.each([
    ['nothing at all', {}],
    ['empty lists', { add: [], remove: [], create: [] }],
    ['not an object', 'add'],
    ['an array', [1]],
    ['a non-string id', { add: [7] }],
    ['an empty id', { add: [''] }],
    ['an over-long id', { add: ['x'.repeat(129)] }],
    ['a control char in an id', { remove: ['a\u001b[2J'] }],
    ['an id both added and removed', { add: ['a'], remove: ['a'] }],
    ['an empty name', { create: [{ name: '   ', color: 'red' }] }],
    ['an over-long name', { create: [{ name: 'x'.repeat(LABEL_NAME_MAX + 1), color: 'red' }] }],
    ['a newline in a name', { create: [{ name: 'a\nb', color: 'red' }] }],
    ['an ESC in a name', { create: [{ name: 'a\u001b]52;c;x\u0007', color: 'red' }] }],
    ['a colour outside the palette', { create: [{ name: 'a', color: '#ff0000' }] }],
    ['a prototype-name colour', { create: [{ name: 'a', color: 'constructor' }] }],
    ['a missing colour', { create: [{ name: 'a' }] }],
    ['too many ids', { add: Array.from({ length: 33 }, (_, i) => `l${i}`) }]
  ])('refuses %s', (_label, raw) => {
    expect(parseCardLabelEdit(raw)).toBeNull()
  })

  it('counts the name cap in characters, not UTF-16 units', () => {
    // 🏷️ is U+1F3F7 U+FE0F: 3 UTF-16 units, 2 code points. 25 of them = 75 units (over the cap if
    // measured in units) but 50 code points (under it).
    const name = '🏷️'.repeat(25)
    expect(name.length).toBeGreaterThan(LABEL_NAME_MAX)
    expect(parseCardLabelEdit({ create: [{ name, color: 'red' }] })).not.toBeNull()
  })
})

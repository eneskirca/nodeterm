// The starting board is a CROSS-SURFACE contract, and one of the surfaces cannot import this file:
// nodeterm-ios's `KanbanDefaults` copies these three titles, in this order, with these colors, so
// that a board created on the phone and a board created on the desktop are the same board. This
// test is the pin on the desktop half — change it and the iOS twin (KanbanDefaultsTests) must move
// in the same PR.
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOARD_COLUMNS, defaultKanbanFor, makeColumnId, seededColumnId } from './kanban-default-board'
import { SYSTEM_NODE_COLORS } from './node-colors'

describe('DEFAULT_BOARD_COLUMNS', () => {
  it('is To Do / In Progress / Done, in that order', () => {
    expect(DEFAULT_BOARD_COLUMNS.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
  })

  it('paints them from the node palette: blue, yellow, green', () => {
    expect(DEFAULT_BOARD_COLUMNS.map((c) => c.color)).toEqual([
      SYSTEM_NODE_COLORS[0],
      SYSTEM_NODE_COLORS[2],
      SYSTEM_NODE_COLORS[1]
    ])
    expect(DEFAULT_BOARD_COLUMNS.map((c) => c.color)).toEqual(['#0a84ff', '#ffd60a', '#32d74b'])
  })

  // The lifecycle category is ADDITIVE to the cross-surface contract: the phone's copy may lack it
  // (a board it seeds simply has uncategorized columns, which every reader tolerates), but a board
  // born on the desktop or through the relay knows which column holds finished work.
  it('maps them onto the lifecycle: unstarted / started / done', () => {
    expect(DEFAULT_BOARD_COLUMNS.map((c) => c.category)).toEqual(['unstarted', 'started', 'done'])
  })
})

describe('makeColumnId', () => {
  // The VALUE is random and deliberately so (a board is created once, by whichever surface got
  // there first). The SHAPE is what every project file on disk already carries.
  it('mints the desktop shape, distinctly each time', () => {
    const ids = Array.from({ length: 50 }, () => makeColumnId())
    for (const id of ids) expect(id).toMatch(/^kcol-[a-z0-9]{1,8}$/)
    expect(new Set(ids).size).toBeGreaterThan(45)
  })
})

// The LAZY default board (a project whose file has no `kanban` yet) is what every client renders
// until the first edit. Its column ids must be the same on every client for one project, or two
// people's first-ever board edits land on six columns instead of three (spec §11 amendment 5).
describe('deterministic default board', () => {
  it('same project → same ids on every client; different projects → different ids', () => {
    expect(defaultKanbanFor('project-1')).toEqual(defaultKanbanFor('project-1'))
    expect(defaultKanbanFor('project-1').columns[0].id).not.toBe(defaultKanbanFor('project-2').columns[0].id)
  })
  it('keeps the desktop id shape kcol-<8 base36>', () => {
    for (let i = 0; i < 3; i++) expect(seededColumnId('project-1', i)).toMatch(/^kcol-[0-9a-z]{8}$/)
  })
  it('titles, order, colours and categories are the shared defaults', () => {
    const b = defaultKanbanFor('p')
    expect(b.columns.map((c) => [c.title, c.color, c.category])).toEqual(
      DEFAULT_BOARD_COLUMNS.map((c) => [c.title, c.color, c.category]))
    expect(b.assignments).toEqual([])
  })
  it('the three columns of one board have three distinct ids', () => {
    expect(new Set(defaultKanbanFor('project-1').columns.map((c) => c.id)).size).toBe(3)
  })
})

// The starting board is a CROSS-SURFACE contract, and one of the surfaces cannot import this file:
// nodeterm-ios's `KanbanDefaults` copies these three titles, in this order, with these colors, so
// that a board created on the phone and a board created on the desktop are the same board. This
// test is the pin on the desktop half — change it and the iOS twin (KanbanDefaultsTests) must move
// in the same PR.
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOARD_COLUMNS, makeColumnId } from './kanban-default-board'
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

import { describe, it, expect } from 'vitest'
import {
  CONTENT_ADD_ITEMS,
  contentAddItemsToMenuItems,
  contentAddItemsToDockRows,
  type AddItem,
  type AddHandlers
} from './addMenuSpec'

const noop = () => {}
const handlers = (overrides: Partial<AddHandlers> = {}): AddHandlers => ({
  terminal: noop,
  remote: noop,
  browser: noop,
  web: noop,
  sticky: noop,
  dino: noop,
  openFile: noop,
  newFile: noop,
  worktree: noop,
  ...overrides
})

const allKinds: AddItem['kind'][] = [
  'terminal',
  'remote',
  'browser',
  'web',
  'sticky',
  'dino',
  'open-file',
  'new-file',
  'worktree'
]

describe('CONTENT_ADD_ITEMS', () => {
  it('lists every content kind in the canonical order', () => {
    expect(CONTENT_ADD_ITEMS.map((i) => i.kind)).toEqual(allKinds)
  })
})

describe('contentAddItemsToMenuItems', () => {
  it('emits a MenuItem for every kind that should show (cwd + non-ssh)', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    const labels = items.map((i) => ('label' in i ? i.label : null))
    // "New file…" shows because hasCwd; worktree is enabled (not ssh).
    expect(labels).toEqual([
      'New terminal',
      'New remote…',
      'New browser',
      'New web view…',
      'New sticky note',
      'New dino game',
      'Open file…',
      'New file…',
      'New worktree…'
    ])
  })

  it('hides "New file…" when the project has no cwd', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    expect(items.some((i) => 'label' in i && i.label === 'New file…')).toBe(false)
  })

  it('disables "New worktree…" on an SSH project and surfaces the hint', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: true
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree).toBeDefined()
    expect(worktree && 'disabled' in worktree && worktree.disabled).toBe(true)
    expect(worktree && 'hint' in worktree && worktree.hint).toBeTruthy()
  })

  it('wires each handler to its item', () => {
    const calls: string[] = []
    const h = handlers({
      terminal: () => calls.push('terminal'),
      browser: () => calls.push('browser'),
      web: () => calls.push('web'),
      sticky: () => calls.push('sticky'),
      dino: () => calls.push('dino'),
      worktree: () => calls.push('worktree')
    })
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, h, {
      hasCwd: true,
      isSshProject: false
    })
    for (const item of items) {
      if ('onClick' in item) item.onClick()
    }
    expect(calls.sort()).toEqual(['browser', 'dino', 'sticky', 'terminal', 'web', 'worktree'])
  })
})

describe('contentAddItemsToDockRows', () => {
  it('omits the remote picker (the Dock has its own remote-connection flow) but keeps the rest', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    expect(rows.map((r) => r.kind)).toEqual([
      'terminal',
      'browser',
      'web',
      'sticky',
      'dino',
      'open-file',
      'new-file',
      'worktree'
    ])
    expect(rows.some((r) => r.kind === 'remote')).toBe(false)
  })

  it('hides "new-file" when there is no cwd', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    expect(rows.some((r) => r.kind === 'new-file')).toBe(false)
  })
})

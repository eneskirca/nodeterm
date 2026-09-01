import { describe, expect, it } from 'vitest'
import { HIDEABLE_HEADER_BUTTONS, HIDEABLE_MENU_ITEMS, isHidden } from './ui-visibility'

describe('isHidden', () => {
  it('hides a hideable id that is listed', () => {
    expect(isHidden('duplicate', ['duplicate'])).toBe(true)
    expect(isHidden('mic', ['mic', 'comments'])).toBe(true)
  })
  it('shows everything when nothing is listed', () => {
    for (const { id } of [...HIDEABLE_MENU_ITEMS, ...HIDEABLE_HEADER_BUTTONS])
      expect(isHidden(id, [])).toBe(false)
  })
  it('never hides an id outside the hideable inventory, however the list got there', () => {
    for (const id of ['delete', 'restart-agent', 'search', 'close', 'branch'])
      expect(isHidden(id, [id])).toBe(false)
  })
  it('ignores unknown ids in the list', () => {
    expect(isHidden('duplicate', ['nonsense', 'duplicate'])).toBe(true)
    expect(isHidden('nonsense', ['nonsense'])).toBe(false)
  })
})

describe('hideable inventories', () => {
  it('list the agreed ids and nothing destructive', () => {
    expect(HIDEABLE_MENU_ITEMS.map((r) => r.id)).toEqual([
      'group', 'remove-from-group', 'colors', 'duplicate', 'snap-zone', 'collapse',
      'markdown-view', 'refresh-terminal', 'vanilla-restart'
    ])
    expect(HIDEABLE_HEADER_BUTTONS.map((r) => r.id)).toEqual([
      'maximize', 'refresh', 'mic', 'ai-name', 'comments', 'hide-fanout', 'tidy-fanout'
    ])
  })
  it('gives every entry a user-facing label', () => {
    for (const { label } of [...HIDEABLE_MENU_ITEMS, ...HIDEABLE_HEADER_BUTTONS])
      expect(label.length).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { NO_SELECTION, clickSelection, dragGroup, inBoardOrder, pruneSelection, type SelectionState } from './cardSelection'

const order = ['u1', 'a1', 'a2', 'a3', 'b1']
const plain = { toggle: false, range: false }
const cmd = { toggle: true, range: false }
const shift = { toggle: false, range: true }
const sel = (ids: string[], anchor: string | null = ids.at(-1) ?? null): SelectionState => ({ ids, anchor })

describe('clickSelection', () => {
  it('a plain click with nothing selected is NOT a selection gesture (the card opens)', () => {
    expect(clickSelection(NO_SELECTION, order, 'a1', plain)).toBeNull()
  })

  it('⌘/Ctrl-click selects a card, and again deselects it', () => {
    const one = clickSelection(NO_SELECTION, order, 'a1', cmd)!
    expect(one).toEqual({ ids: ['a1'], anchor: 'a1' })
    expect(clickSelection(one, order, 'a1', cmd)).toEqual({ ids: [], anchor: 'a1' })
  })

  it('once something is selected, a plain click keeps picking instead of opening', () => {
    const next = clickSelection(sel(['a1']), order, 'b1', plain)!
    expect(next.ids).toEqual(['a1', 'b1'])
    expect(clickSelection(next, order, 'a1', plain)!.ids).toEqual(['b1'])
  })

  it('Shift-click adds the span between the anchor and the card, in either direction', () => {
    expect(clickSelection(sel(['a1']), order, 'a3', shift)!.ids).toEqual(['a1', 'a2', 'a3'])
    expect(clickSelection(sel(['a3']), order, 'u1', shift)!.ids).toEqual(['a3', 'u1', 'a1', 'a2'])
  })

  it('Shift-click keeps what was already selected outside the span, and keeps the anchor', () => {
    const next = clickSelection({ ids: ['b1', 'a1'], anchor: 'a1' }, order, 'a2', shift)!
    expect(next).toEqual({ ids: ['b1', 'a1', 'a2'], anchor: 'a1' })
  })

  it('Shift-click with no usable anchor just selects the card', () => {
    expect(clickSelection(NO_SELECTION, order, 'a2', shift)).toEqual({ ids: ['a2'], anchor: 'a2' })
    expect(clickSelection({ ids: ['a1'], anchor: 'gone' }, order, 'a3', shift)!.ids).toEqual(['a1', 'a3'])
  })

  it('a card that is not on the board is never selected', () => {
    expect(clickSelection(sel(['a1']), order, 'ghost', cmd)).toBeNull()
  })
})

describe('pruneSelection', () => {
  it('returns the SAME state when every selected card is still on the board', () => {
    const state = sel(['a1', 'b1'])
    expect(pruneSelection(state, order)).toBe(state)
  })

  it('drops cards (and an anchor) that left the board — a filter, a delete', () => {
    expect(pruneSelection({ ids: ['a1', 'b1'], anchor: 'b1' }, ['u1', 'a1'])).toEqual({ ids: ['a1'], anchor: null })
    expect(pruneSelection(sel(['b1']), ['u1'])).toBe(NO_SELECTION)
  })
})

describe('inBoardOrder / dragGroup', () => {
  it('orders the selection as the board shows it, whatever order it was picked in', () => {
    expect(inBoardOrder(order, ['b1', 'u1', 'a2'])).toEqual(['u1', 'a2', 'b1'])
  })

  it('dragging a selected card carries the whole selection, in board order', () => {
    expect(dragGroup(order, ['b1', 'a1'], 'b1')).toEqual(['a1', 'b1'])
  })

  it('dragging an UNSELECTED card carries only that card', () => {
    expect(dragGroup(order, ['b1', 'a1'], 'a3')).toEqual(['a3'])
    expect(dragGroup(order, ['a1'], 'a1')).toEqual(['a1'])
  })
})

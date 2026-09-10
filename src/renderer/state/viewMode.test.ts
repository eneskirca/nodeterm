import { describe, it, expect, beforeEach } from 'vitest'
import { parseViewMap, useViewMode, isCanvasCovered, isKanbanOpen, isTableOpen, viewFor } from './viewMode'

describe('parseViewMap', () => {
  it('keeps canvas/kanban/table entries, tolerates garbage', () => {
    expect(parseViewMap(null)).toEqual({})
    expect(parseViewMap('not json')).toEqual({})
    expect(parseViewMap('[1,2]')).toEqual({})
    expect(parseViewMap(JSON.stringify({ p1: 'kanban', p2: 'canvas', p3: 42, p4: 'table' }))).toEqual({
      p1: 'kanban',
      p2: 'canvas',
      p4: 'table'
    })
  })
})

describe('toggle + default', () => {
  beforeEach(() => useViewMode.setState({ viewByProject: {}, defaultView: 'canvas' }))
  it('flips a project explicitly (stores canvas/kanban, overriding the default)', () => {
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('canvas') // explicit, not deleted
  })
  it('an unset project follows the default; toggling flips FROM the resolved default', () => {
    const s = useViewMode.getState()
    expect(viewFor(s, 'x')).toBe('canvas')
    expect(isKanbanOpen('x')).toBe(false)
    useViewMode.setState({ defaultView: 'kanban' })
    expect(isKanbanOpen('x')).toBe(true) // now follows the kanban default
    // toggling an unset project flips off the resolved default → explicit 'canvas'
    useViewMode.getState().toggle('x')
    expect(useViewMode.getState().viewByProject.x).toBe('canvas')
    expect(isKanbanOpen('x')).toBe(false) // explicit choice beats the kanban default
  })
  it('cycle walks mesa → canvas → kanban → mesa', () => {
    useViewMode.setState({ viewByProject: {}, defaultView: 'table' })
    useViewMode.getState().cycle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('canvas')
    useViewMode.getState().cycle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
    useViewMode.getState().cycle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('table')
  })

  it('toggle from Mesa is not the leave-for-canvas path (that is setView)', () => {
    useViewMode.setState({ viewByProject: { p1: 'table' }, defaultView: 'table' })
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
    useViewMode.setState({ viewByProject: { p1: 'table' }, defaultView: 'table' })
    useViewMode.getState().setView('p1', 'canvas')
    expect(useViewMode.getState().viewByProject.p1).toBe('canvas')
  })

  it('treats Mesa as a covered canvas, not as the kanban board', () => {
    useViewMode.setState({ viewByProject: { p1: 'table' }, defaultView: 'table', globalKanban: false })
    expect(isTableOpen('p1')).toBe(true)
    expect(isKanbanOpen('p1')).toBe(false)
    expect(isCanvasCovered('p1')).toBe(true)
    useViewMode.getState().setView('p1', 'canvas')
    expect(isTableOpen('p1')).toBe(false)
    expect(isCanvasCovered('p1')).toBe(false)
  })
})

describe('card requests (board-aware "go to node")', () => {
  it('carries a one-shot request the board consumes', () => {
    useViewMode.setState({ requestedCardNodeId: null })
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
    useViewMode.getState().clearCardRequest()
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
    // Re-requesting the SAME node must work — it is a fresh "go to", not a state to dedupe.
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
  })

  it('a view toggle drops an unconsumed request', () => {
    useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', requestedCardNodeId: null })
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(true)
    useViewMode.getState().requestCard('term-2')
    // Leaving the board: the request belonged to the view we just left; firing it later would
    // pop a card open out of nowhere.
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(false)
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
  })
})

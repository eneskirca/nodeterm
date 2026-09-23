import { describe, expect, it } from 'vitest'
import { alertsHere, isTabTearOff, nextActiveAfterDetach, popoutRefusal } from './popout'

const ctx = (over: Partial<Parameters<typeof popoutRefusal>[1]> = {}) => ({
  browser: false,
  popout: false,
  detached: new Set<string>(),
  ...over
})

describe('popoutRefusal', () => {
  it('an ordinary open local project may be torn off', () => {
    expect(popoutRefusal({ id: 'a' }, ctx())).toBeNull()
  })
  it('names each reason it cannot, most structural first', () => {
    expect(popoutRefusal({ id: 'a' }, ctx({ browser: true }))).toBe('browser')
    expect(popoutRefusal({ id: 'a' }, ctx({ popout: true }))).toBe('popout')
    expect(popoutRefusal({ id: 'a' }, ctx({ detached: new Set(['a']) }))).toBe('detached')
    expect(popoutRefusal({ id: 'a', remote: true }, ctx())).toBe('relay')
    expect(popoutRefusal({ id: 'a', unavailable: true }, ctx())).toBe('unavailable')
    expect(popoutRefusal({ id: 'a', closed: true }, ctx())).toBe('closed')
  })
})

describe('nextActiveAfterDetach', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c', closed: true }, { id: 'd' }]
  it('leaves the active project alone when another tab is torn off', () => {
    expect(nextActiveAfterDetach(projects, 'a', 'b', new Set())).toBe('a')
  })
  it('moves to the nearest open, not-detached neighbour', () => {
    expect(nextActiveAfterDetach(projects, 'b', 'b', new Set())).toBe('a')
    expect(nextActiveAfterDetach(projects, 'b', 'b', new Set(['a']))).toBe('d') // c is closed
    expect(nextActiveAfterDetach(projects, 'd', 'd', new Set())).toBe('b') // c is closed, b next
  })
  it('falls back to the start screen when nothing else is showable', () => {
    expect(nextActiveAfterDetach(projects, 'b', 'b', new Set(['a', 'd']))).toBe('')
    expect(nextActiveAfterDetach([{ id: 'only' }], 'only', 'only', new Set())).toBe('')
  })
})

describe('isTabTearOff', () => {
  const base = { handledByStrip: false, stripBottom: 40, innerWidth: 1200, innerHeight: 800 }
  it('a pointer that left the window tears off even when dragend reports (0, 0) (Linux)', () => {
    expect(isTabTearOff({ ...base, clientX: 0, clientY: 0, leftWindow: true })).toBe(true)
  })
  it('(0, 0) falls back to the last position seen inside the window', () => {
    expect(isTabTearOff({ ...base, clientX: 0, clientY: 0, lastInside: { x: 400, y: 500 } })).toBe(true)
    expect(isTabTearOff({ ...base, clientX: 0, clientY: 0, lastInside: { x: 400, y: 20 } })).toBe(false)
  })
  it('leaving the window never overrides a drop the strip handled', () => {
    expect(isTabTearOff({ ...base, clientX: 0, clientY: 0, leftWindow: true, handledByStrip: true })).toBe(false)
  })
  it('a drop the strip handled is a reorder, never a tear-off', () => {
    expect(isTabTearOff({ ...base, handledByStrip: true, clientX: 300, clientY: 500 })).toBe(false)
  })
  it('a release on the canvas below the strip tears the tab off', () => {
    expect(isTabTearOff({ ...base, clientX: 300, clientY: 41 })).toBe(true)
    expect(isTabTearOff({ ...base, clientX: 300, clientY: 500 })).toBe(true)
  })
  it('a release outside the window tears the tab off, whichever edge it left by', () => {
    expect(isTabTearOff({ ...base, clientX: -20, clientY: 10 })).toBe(true)
    expect(isTabTearOff({ ...base, clientX: 300, clientY: -5 })).toBe(true)
    expect(isTabTearOff({ ...base, clientX: 1300, clientY: 10 })).toBe(true)
    expect(isTabTearOff({ ...base, clientX: 300, clientY: 900 })).toBe(true)
  })
  it('a release inside the strip that no target claimed is a cancelled drag', () => {
    expect(isTabTearOff({ ...base, clientX: 300, clientY: 20 })).toBe(false)
    expect(isTabTearOff({ ...base, clientX: 300, clientY: 40 })).toBe(false)
  })
  it('an unmeasurable pointer is never a tear-off', () => {
    expect(isTabTearOff({ ...base, clientX: NaN, clientY: 500 })).toBe(false)
  })
})

describe('alertsHere', () => {
  const projects = [
    { id: 'a', nodes: [{ id: 'a1' }] },
    { id: 'b', nodes: [{ id: 'b1' }] }
  ] as never
  it('only the window owning the node\'s project alerts', () => {
    const mainOwns = (id: string) => id !== 'b'
    expect(alertsHere(projects, 'a1', mainOwns)).toBe(true)
    expect(alertsHere(projects, 'b1', mainOwns)).toBe(false)
    const popoutOwns = (id: string) => id === 'b'
    expect(alertsHere(projects, 'b1', popoutOwns)).toBe(true)
  })
  it('a node no project knows yet alerts here', () => {
    expect(alertsHere(projects, 'fresh', () => false)).toBe(true)
  })
})

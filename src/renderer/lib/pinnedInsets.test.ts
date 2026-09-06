import { describe, it, expect } from 'vitest'
import { NO_INSETS, insetsForPanels, type RectLike } from './pinnedInsets'

// The canvas wrapper as the placement verbs see it: a 1200×800 box at the window origin.
const WRAP: RectLike = { left: 0, right: 1200, top: 0, bottom: 800 }
const rect = (left: number, right: number, top = 54, bottom = 700): RectLike => ({
  left,
  right,
  top,
  bottom
})

describe('insetsForPanels', () => {
  it('is empty for no panels', () => {
    expect(insetsForPanels(WRAP, [])).toEqual(NO_INSETS)
    expect(insetsForPanels(WRAP, [null, undefined])).toEqual(NO_INSETS)
  })

  it('attributes a left-hugging panel to the left edge, up to its far side', () => {
    // The sessions sidebar: left: 14px, width 300 → clear everything up to x=314.
    expect(insetsForPanels(WRAP, [rect(14, 314)])).toEqual({ left: 314, right: 0 })
  })

  it('attributes a right-hugging panel to the right edge', () => {
    // The explorer drawer: a 360px card against the right edge.
    expect(insetsForPanels(WRAP, [rect(826, 1186)])).toEqual({ left: 0, right: 374 })
  })

  it('takes both edges when both panels are pinned', () => {
    expect(insetsForPanels(WRAP, [rect(14, 314), rect(826, 1186)])).toEqual({
      left: 314,
      right: 374
    })
  })

  it('keeps the widest panel per edge rather than summing them', () => {
    expect(insetsForPanels(WRAP, [rect(14, 314), rect(14, 474)])).toEqual({ left: 474, right: 0 })
  })

  it('ignores a panel that does not overlap the wrapper', () => {
    // Entirely left of the canvas (a wrapper that does not start at the window edge)…
    const offset: RectLike = { left: 400, right: 1200, top: 0, bottom: 800 }
    expect(insetsForPanels(offset, [rect(14, 314)])).toEqual(NO_INSETS)
    // …and a panel with no vertical overlap at all.
    expect(insetsForPanels(WRAP, [rect(14, 314, 900, 1200)])).toEqual(NO_INSETS)
  })

  it('measures from the wrapper edge, not the window, when the wrapper is offset', () => {
    const offset: RectLike = { left: 100, right: 1200, top: 0, bottom: 800 }
    // A panel spanning x 14→314 leaves 214px of it over a wrapper that starts at 100.
    expect(insetsForPanels(offset, [rect(14, 314)])).toEqual({ left: 214, right: 0 })
  })

  it('never reports more than the wrapper is wide', () => {
    const wide = insetsForPanels(WRAP, [rect(-500, 5000)])
    expect(wide.left).toBeLessThanOrEqual(1200)
    expect(wide.left).toBeGreaterThanOrEqual(0)
  })
})

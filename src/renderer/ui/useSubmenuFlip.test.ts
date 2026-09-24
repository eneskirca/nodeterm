import { describe, expect, it } from 'vitest'
import { submenuLift, submenuSide, SUBMENU_OVERLAP_PX } from './useSubmenuFlip'

/** A 200px-wide submenu row, placed by its left edge in a 1000px viewport. */
const row = (left: number): { rowLeft: number; rowRight: number } => ({
  rowLeft: left,
  rowRight: left + 200
})
const W = 1000

describe('submenuSide', () => {
  it('opens to the right when the flyout fits there', () => {
    expect(submenuSide({ ...row(100), width: 240, viewportWidth: W })).toBe('right')
  })

  it('opens to the LEFT when the right edge would clip it', () => {
    // Row ends at 900; a 240px flyout would reach 1136 in a 1000px viewport.
    expect(submenuSide({ ...row(700), width: 240, viewportWidth: W })).toBe('left')
  })

  it('counts the overlap, so a flyout that fits only because of it stays right', () => {
    // Right edge lands exactly on the margin: 800 - 4 + 190 = 986 = 1000 - 6 - 8… one px either
    // way is what this pins, hence the exact arithmetic rather than a round number.
    const width = W - 6 - (900 - SUBMENU_OVERLAP_PX)
    expect(submenuSide({ ...row(700), width, viewportWidth: W })).toBe('right')
    expect(submenuSide({ ...row(700), width: width + 1, viewportWidth: W })).toBe('left')
  })

  it('takes the roomier side when neither fits, rather than refusing', () => {
    // Row hugs the right edge: left has 700px of room, right has ~100.
    expect(submenuSide({ ...row(700), width: 900, viewportWidth: W })).toBe('left')
    // Row hugs the left edge: the roomier side is now the right one.
    expect(submenuSide({ ...row(0), width: 900, viewportWidth: W })).toBe('right')
  })

  it('never opens left into the viewport edge', () => {
    // A row at the very left: opening left would start at a negative x, so right wins.
    expect(submenuSide({ ...row(10), width: 240, viewportWidth: W })).toBe('right')
  })
})

describe('submenuLift', () => {
  const H = 700
  it('does not move a flyout that fits below its row', () => {
    expect(submenuLift({ rowTop: 100, height: 200, viewportHeight: H })).toBe(0)
  })

  it('lifts a flyout exactly as far as its bottom overflows the margin', () => {
    // top = 566 - 6 = 560; bottom 560 + 180 = 740 vs 700 - 6 = 694 → lift 46.
    expect(submenuLift({ rowTop: 566, height: 180, viewportHeight: H })).toBe(46)
  })

  it('never lifts a flyout past the top margin', () => {
    // Taller than the viewport: it stops at the margin and scrolls via its own max-height.
    expect(submenuLift({ rowTop: 400, height: 2000, viewportHeight: H })).toBe(400 - 6 - 6)
  })
})

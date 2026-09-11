import { describe, it, expect } from 'vitest'
import { tooltipAnchor, tooltipClass, type TooltipPlacement } from './Tooltip'

/**
 * The anchor and the `.tooltip--*` transform are two halves of one position: the anchor says which
 * point the bubble is pinned to, the CSS says which corner of the bubble lands on it. Change one
 * without the other and the bubble drifts by its own width or height, which renders fine and looks
 * merely misaligned. These pin which edge each placement reads, so that pairing stays deliberate.
 */

const RECT = { top: 100, right: 50, left: 20, width: 30, height: 30 }

describe('tooltipAnchor', () => {
  it('pins a horizontal center above the trigger for top', () => {
    expect(tooltipAnchor(RECT, 'top')).toEqual({ x: 35, y: 94 })
  })

  it('pins a horizontal center below the trigger for bottom', () => {
    expect(tooltipAnchor(RECT, 'bottom')).toEqual({ x: 35, y: 136 })
  })

  it('pins the left edge beside the trigger, vertically centered, for right', () => {
    expect(tooltipAnchor(RECT, 'right')).toEqual({ x: 56, y: 115 })
  })

  it('offsets away from the trigger on the axis it opens along, and only that axis', () => {
    expect(tooltipAnchor(RECT, 'top').x).toBe(tooltipAnchor(RECT, 'bottom').x)
    expect(tooltipAnchor(RECT, 'right').y).toBe(RECT.top + RECT.height / 2)
  })
})

describe('tooltipClass', () => {
  it('leaves bottom on the base rule, since that is what the base rule already does', () => {
    expect(tooltipClass('bottom')).toBe('tooltip')
  })

  it('adds one modifier per other placement', () => {
    const placements: TooltipPlacement[] = ['top', 'right']
    for (const placement of placements) {
      expect(tooltipClass(placement)).toBe(`tooltip tooltip--${placement}`)
    }
  })
})

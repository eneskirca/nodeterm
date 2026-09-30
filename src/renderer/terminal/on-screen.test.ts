import { describe, it, expect } from 'vitest'
import { rectOnScreen } from './on-screen'

const pane = { left: 0, top: 0, right: 1000, bottom: 800 }
const r = (left: number, top: number, w = 100, h = 100) => ({ left, top, right: left + w, bottom: top + h })

describe('rectOnScreen', () => {
  it('is true for a node inside or overlapping the pane', () => {
    expect(rectOnScreen(r(10, 10), pane)).toBe(true)
    expect(rectOnScreen(r(-50, -50), pane)).toBe(true)
    expect(rectOnScreen(r(950, 750), pane)).toBe(true)
  })
  it('is false only for a measured node entirely outside', () => {
    expect(rectOnScreen(r(1000, 10), pane)).toBe(false)
    expect(rectOnScreen(r(10, -100), pane)).toBe(false)
    expect(rectOnScreen(r(-5000, 3000), pane)).toBe(false)
  })
  it('fails toward on-screen (the old FIFO position) when it cannot tell', () => {
    expect(rectOnScreen(null, pane)).toBe(true)
    expect(rectOnScreen(r(5000, 5000), null)).toBe(true)
    expect(rectOnScreen({ left: 0, top: 0, right: 0, bottom: 0 }, pane)).toBe(true)
  })
})

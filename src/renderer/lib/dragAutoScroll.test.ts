// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EDGE_BELT_PX,
  MAX_SCROLL_STEP_PX,
  edgeScrollStep,
  startDragAutoScroll
} from './dragAutoScroll'

describe('edgeScrollStep', () => {
  // A 400px scroller spanning 100..500 on its axis.
  const step = (pos: number): number => edgeScrollStep(pos, 100, 500)

  it('does not scroll while the pointer is in the middle', () => {
    expect(step(300)).toBe(0)
    expect(step(100 + EDGE_BELT_PX + 1)).toBe(0)
    expect(step(500 - EDGE_BELT_PX - 1)).toBe(0)
  })

  it('scrolls back near the start edge and forward near the end edge', () => {
    expect(step(100 + EDGE_BELT_PX / 2)).toBeLessThan(0)
    expect(step(500 - EDGE_BELT_PX / 2)).toBeGreaterThan(0)
  })

  it('keeps scrolling — faster — when the pointer overshoots past the edge', () => {
    // The point of the feature: you should not have to aim at a thin strip.
    const atEdge = Math.abs(step(100))
    const past = Math.abs(step(40))
    const farPast = Math.abs(step(-400))
    expect(atEdge).toBeGreaterThan(0)
    expect(past).toBeGreaterThan(atEdge)
    expect(farPast).toBe(MAX_SCROLL_STEP_PX)
    expect(step(5000)).toBe(MAX_SCROLL_STEP_PX)
  })

  it('narrows the belt on a scroller too small to have a quiet middle otherwise', () => {
    // 60px scroller: two full belts would cover it entirely.
    expect(edgeScrollStep(130, 100, 160)).toBe(0)
  })
})

describe('startDragAutoScroll', () => {
  let el: HTMLDivElement
  let frames: FrameRequestCallback[]
  let clock = 0

  const flush = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      const due = frames
      frames = []
      due.forEach((f) => f((clock += 1000 / 60)))
    }
  }
  const dragOver = (clientX: number, clientY: number): void => {
    const e = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperties(e, { clientX: { value: clientX }, clientY: { value: clientY } })
    document.body.dispatchEvent(e)
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = []
    })
    el = document.createElement('div')
    document.body.appendChild(el)
    el.getBoundingClientRect = () =>
      ({ left: 200, right: 600, top: 100, bottom: 500, width: 400, height: 400 }) as DOMRect
  })

  afterEach(() => {
    el.remove()
    vi.unstubAllGlobals()
  })

  it('scrolls a horizontal strip left while the pointer is far left of it, even over another element', () => {
    el.scrollLeft = 1000
    const stop = startDragAutoScroll(el, 'x')
    dragOver(10, 800) // over the brand, below the strip: only the x axis counts
    flush(3)
    expect(el.scrollLeft).toBe(1000 - 3 * MAX_SCROLL_STEP_PX)
    stop()
  })

  it('scrolls a vertical list down while the pointer is below it', () => {
    const stop = startDragAutoScroll(el, 'y')
    dragOver(400, 900)
    flush(2)
    expect(el.scrollTop).toBe(2 * MAX_SCROLL_STEP_PX)
    stop()
  })

  it('scrolls at the same speed on a 120 Hz display as on a 60 Hz one', () => {
    el.scrollLeft = 1000
    const stop = startDragAutoScroll(el, 'x')
    dragOver(10, 10)
    // Two 120 Hz frames cover one 60 Hz frame's time: together they move one 60 Hz step.
    flush(1) // first frame counts as one 60 Hz frame
    const afterFirst = el.scrollLeft
    const run = frames
    frames = []
    run.forEach((f) => f((clock += 1000 / 120)))
    const run2 = frames
    frames = []
    run2.forEach((f) => f((clock += 1000 / 120)))
    expect(afterFirst - el.scrollLeft).toBe(MAX_SCROLL_STEP_PX)
    stop()
  })

  it('does nothing until the first dragover reports a position', () => {
    el.scrollLeft = 50
    const stop = startDragAutoScroll(el, 'x')
    flush(3)
    expect(el.scrollLeft).toBe(50)
    stop()
  })

  it('ignores a (0, 0) dragover, which Chromium can send at the window boundary', () => {
    el.scrollLeft = 1000
    const stop = startDragAutoScroll(el, 'x')
    dragOver(5000, 300) // overshooting to the right
    dragOver(0, 0)
    flush(1)
    expect(el.scrollLeft).toBe(1000 + MAX_SCROLL_STEP_PX)
    stop()
  })

  it('stops by itself once the container is removed from the DOM', () => {
    const stop = startDragAutoScroll(el, 'x')
    dragOver(10, 10)
    el.remove()
    flush(1)
    expect(frames).toHaveLength(0)
    stop()
  })

  it('stops scrolling and listening once stopped', () => {
    el.scrollLeft = 1000
    const stop = startDragAutoScroll(el, 'x')
    dragOver(10, 10)
    flush(1)
    stop()
    flush(3)
    dragOver(10, 10)
    flush(3)
    expect(el.scrollLeft).toBe(1000 - MAX_SCROLL_STEP_PX)
  })
})

import { useEffect, type RefObject } from 'react'

// Auto-scroll a scroll container while an HTML5 drag is in flight. Two lists reorder by drag and
// both scroll: the project tab strip (horizontally, without a visible scrollbar) and the sessions
// sidebar (vertically). During a native drag the wheel does not reach the page, so with 20–30
// projects a tab could only travel as far as the strip showed: drop, scroll, drag again.
//
// Chromium has a built-in drag autoscroll, but it only reacts inside a thin band along the
// container's own edge — you have to aim at it. Here the edge band is generous AND everything
// past the edge counts: dragging over the brand, the +, the canvas or out of the window keeps the
// list scrolling, faster the further you overshoot. Only the scroll axis is read, so a drag that
// drifts down onto the canvas while far to the left still scrolls the tab strip left.

export type DragScrollAxis = 'x' | 'y'

/** Width of the band inside each edge where scrolling starts. */
export const EDGE_BELT_PX = 40
/** Extra distance past the edge over which the speed ramps up to its maximum. */
export const OVERSHOOT_RAMP_PX = 120
export const MIN_SCROLL_STEP_PX = 2
/** Per 60 Hz frame (~1400 px/s), a 30-tab strip end to end in ~3 s. The loop scales it by the
 *  real frame time, so a 120 Hz display scrolls at the same speed, not twice as fast. */
export const MAX_SCROLL_STEP_PX = 24
const FRAME_MS = 1000 / 60
/** A frame time longer than this (a stalled tab, a debugger pause) counts as this, not as a jump. */
const MAX_FRAME_MS = 50

function stepFor(depth: number, belt: number): number {
  const t = Math.min(1, depth / (belt + OVERSHOOT_RAMP_PX))
  return Math.round(MIN_SCROLL_STEP_PX + (MAX_SCROLL_STEP_PX - MIN_SCROLL_STEP_PX) * t)
}

/**
 * Signed scroll step (px per frame) for a pointer at `pos` against a scroller spanning
 * `[start, end]` on one axis: negative = towards the start, 0 = leave it alone. A pointer before
 * the start or after the end still scrolls, at a speed that grows with the overshoot.
 */
export function edgeScrollStep(pos: number, start: number, end: number): number {
  // A scroller narrower than two full belts keeps a quiet middle half.
  const belt = Math.min(EDGE_BELT_PX, Math.max(0, end - start) / 4)
  const intoStart = start + belt - pos
  if (intoStart > 0) return -stepFor(intoStart, belt)
  const intoEnd = pos - (end - belt)
  if (intoEnd > 0) return stepFor(intoEnd, belt)
  return 0
}

/**
 * Scroll `el` along `axis` from the pointer position every `dragover` reports, anywhere in the
 * window, until the returned stop function runs (or the drag ends). The last position is kept
 * while no dragover arrives — a pointer that left the window past the edge keeps scrolling.
 */
export function startDragAutoScroll(el: HTMLElement, axis: DragScrollAxis): () => void {
  let pos: number | null = null
  let frame = 0
  let lastTime: number | null = null
  let stopped = false

  const onDragOver = (e: DragEvent): void => {
    // Chromium can report (0, 0) for a drag event at the window boundary; taken at face value it
    // would flip a drag that overshot the right/bottom edge into scrolling the other way.
    if (e.clientX === 0 && e.clientY === 0) return
    pos = axis === 'x' ? e.clientX : e.clientY
  }
  const tick = (time: number): void => {
    if (stopped) return
    const elapsed = lastTime === null ? FRAME_MS : Math.min(MAX_FRAME_MS, Math.max(0, time - lastTime))
    lastTime = time
    // The container left the DOM mid-drag (its panel closed): nothing left to scroll.
    if (!el.isConnected) {
      stop()
      return
    }
    if (pos !== null) {
      const r = el.getBoundingClientRect()
      const perFrame = axis === 'x' ? edgeScrollStep(pos, r.left, r.right) : edgeScrollStep(pos, r.top, r.bottom)
      const step = Math.round((perFrame * elapsed) / FRAME_MS)
      if (step !== 0) {
        if (axis === 'x') el.scrollLeft += step
        else el.scrollTop += step
      }
    }
    frame = requestAnimationFrame(tick)
  }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    window.removeEventListener('dragover', onDragOver, true)
    window.removeEventListener('drop', stop, true)
    window.removeEventListener('dragend', stop, true)
  }

  // Capture phase: the per-item handlers stopPropagation, and those positions count too.
  window.addEventListener('dragover', onDragOver, true)
  window.addEventListener('drop', stop, true)
  window.addEventListener('dragend', stop, true)
  frame = requestAnimationFrame(tick)
  return stop
}

/** Runs {@link startDragAutoScroll} on `ref`'s element for as long as `active` is true. */
export function useDragAutoScroll(
  ref: RefObject<HTMLElement | null>,
  axis: DragScrollAxis,
  active: boolean
): void {
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    return startDragAutoScroll(el, axis)
  }, [ref, axis, active])
}

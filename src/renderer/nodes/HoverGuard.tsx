import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * How far the pointer may travel between press and release and still count as a CLICK on the hover
 * guard, in screen px. Above it the gesture moved the node and the terminal keeps waiting; below
 * it, the click focuses immediately (issue #87).
 *
 * Generous rather than tight: a few pixels of travel is a hand, not an intent, and the cost of
 * being wrong is asymmetric — a missed focus makes the user click again (and, before this, made
 * that click count against them), while an over-eager focus costs one Escape.
 */
export const GUARD_CLICK_SLOP = 4

export interface HoverGuardProps {
  /** A primary press landed on the guard (it may still become a drag). */
  onPress: () => void
  /** The press was released within `GUARD_CLICK_SLOP` of where it started: a click. */
  onClick: () => void
  /** The press was released after the node moved (or its start was never seen): a drag. */
  onDragEnd: () => void
}

/**
 * The transparent overlay over a terminal body that makes a quick drag move the node and a wheel
 * pan the canvas until the terminal takes the keyboard (see TerminalNode's hover dwell / #757).
 *
 * **It listens to POINTER events, and that is the whole point of this component.** The guard sits
 * inside a React Flow node wrapper carrying a d3-drag instance: a terminal node has no `dragHandle`
 * and the guard is not `.nodrag`, so React Flow's drag filter accepts a left press on it. d3-drag
 * then calls `stopImmediatePropagation` on the `mousedown` AT THE WRAPPER — so it never bubbles to
 * React's root listener — and consumes the `mouseup` with `stopImmediatePropagation` in a WINDOW
 * capture listener, which runs before React's root sees it at all (d3-drag 3.0.0 `mousedowned` /
 * `mouseupped`). The guard used `onMouseDown`/`onMouseUp` until this was measured: the #87 "a click
 * focuses at once" path never ran for a left click, masked by the hover dwell, and with click to
 * focus (#757) there was no dwell left to mask it. d3-drag does not touch pointer events, which
 * fire before the mouse events and bubble normally, so the drag layer still moves the node and the
 * guard still sees both halves of the gesture. `HoverGuard.test.tsx` pins this under the real
 * d3-drag with React Flow's filter.
 *
 * Only the PRIMARY button counts: a right click opens the context menu and must not take the
 * keyboard (with mouse events it did, because React Flow's filter lets a right press through
 * untouched — the one click that ever reached the old handlers).
 */
export function HoverGuard({ onPress, onClick, onDragEnd }: HoverGuardProps) {
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    downAt.current = { x: e.clientX, y: e.clientY }
    onPress()
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const from = downAt.current
    downAt.current = null
    const moved = from ? Math.hypot(e.clientX - from.x, e.clientY - from.y) : Infinity
    if (from && moved <= GUARD_CLICK_SLOP) onClick()
    else onDragEnd()
  }
  return (
    <div
      className="term-hover-guard"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      title="Click to type · drag to move · scroll to pan"
    />
  )
}

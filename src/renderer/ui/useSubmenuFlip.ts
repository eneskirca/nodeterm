import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Which side of its row a submenu flyout opens towards. */
export type SubmenuSide = 'right' | 'left'

/** How far the flyout overlaps its row, so the cursor crosses no gap (the `- 4px` in the CSS). */
export const SUBMENU_OVERLAP_PX = 4
/** Viewport margin, the same one `useMenuFlip` keeps. */
const M = 6

/**
 * Which side a submenu should open towards, given where its row sits and how wide the flyout is.
 *
 * Native menus (and the root menu here, via `useMenuFlip`) never let a menu run off screen; the
 * submenu flyout was the one surface that did — it was pinned to `left: calc(100% - 4px)` with no
 * measurement at all, so a context menu opened near the right edge of the window pushed its
 * flyout off-screen entirely. A submenu cannot use `useMenuFlip`'s clamp because it is positioned
 * against its ROW, not the viewport: the fix is a side, not an offset.
 *
 * When neither side fits (a narrow window, a wide flyout) the roomier side wins rather than a
 * refusal — the flyout's own `max-width` then bounds it, so part of it stays reachable either way.
 * Pure so the decision is testable without a DOM.
 */
export function submenuSide(input: {
  /** The submenu ROW's viewport rect edges. */
  rowLeft: number
  rowRight: number
  /** Measured flyout width. */
  width: number
  viewportWidth: number
  margin?: number
}): SubmenuSide {
  const margin = input.margin ?? M
  const rightEdge = input.rowRight - SUBMENU_OVERLAP_PX + input.width
  if (rightEdge <= input.viewportWidth - margin) return 'right'
  const leftEdge = input.rowLeft + SUBMENU_OVERLAP_PX - input.width
  if (leftEdge >= margin) return 'left'
  const roomRight = input.viewportWidth - margin - (input.rowRight - SUBMENU_OVERLAP_PX)
  const roomLeft = input.rowLeft + SUBMENU_OVERLAP_PX - margin
  return roomLeft > roomRight ? 'left' : 'right'
}

/** The flyout's resting offset above its row's top edge (the CSS `top: -6px`). */
export const SUBMENU_TOP_PX = -6

/**
 * How far to lift a flyout so its bottom stays inside the viewport. The side flip only fixes the
 * horizontal axis; a flyout opened from a row near the bottom (typically a nested one — a model
 * list three levels down) otherwise runs off-screen. Never lifts it above the top margin: a flyout
 * taller than the viewport is capped by its own `max-height` and scrolls instead. Pure.
 */
export function submenuLift(input: {
  /** The submenu ROW's viewport top. */
  rowTop: number
  /** Measured flyout height. */
  height: number
  viewportHeight: number
  margin?: number
}): number {
  const margin = input.margin ?? M
  const top = input.rowTop + SUBMENU_TOP_PX
  const overflow = top + input.height - (input.viewportHeight - margin)
  if (overflow <= 0) return 0
  return Math.max(0, Math.min(overflow, top - margin))
}

/**
 * Measure an open submenu flyout and answer which side it should open towards, and how far to
 * lift it so it stays on screen vertically.
 *
 * Measured after render but BEFORE paint (`useLayoutEffect`), so a flyout never appears on the
 * wrong side first and jumps. Re-measured on size changes for the same reason `useMenuFlip` is: a
 * flyout that grows must be able to change its mind.
 *
 * The rect read is the flyout's OFFSET PARENT — the submenu row — because the flyout's own rect
 * already carries the side we are deciding.
 */
export function useSubmenuFlip(): {
  ref: RefObject<HTMLDivElement>
  side: SubmenuSide
  lift: number
} {
  const ref = useRef<HTMLDivElement>(null)
  const [side, setSide] = useState<SubmenuSide>('right')
  const [lift, setLift] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    const row = el?.offsetParent as HTMLElement | null
    if (!el || !row) return
    const measure = (): void => {
      const r = row.getBoundingClientRect()
      const next = submenuSide({
        rowLeft: r.left,
        rowRight: r.right,
        width: el.offsetWidth,
        viewportWidth: window.innerWidth
      })
      setSide((cur) => (cur === next ? cur : next))
      const up = submenuLift({
        rowTop: r.top,
        height: el.offsetHeight,
        viewportHeight: window.innerHeight
      })
      setLift((cur) => (cur === up ? cur : up))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, side, lift }
}

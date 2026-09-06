// Screen-px that PINNED side panels carve out of the canvas wrapper, for the placement verbs
// (maximize — issue #399; zone snap — issue #394) that would otherwise lay a node out underneath
// one of them.
//
// Only pinned panels count. Unpinned, both the sessions sidebar and the explorer drawer are
// hover peeks that get out of the way on their own, so a node briefly under one is fine and
// insetting for it would shrink the canvas for a panel that is about to disappear. Pinning is
// the user saying "this one stays".
//
// Measured rather than derived from the CSS widths: the panels are plain DOM, their widths vary
// per panel (and per variant), and `uiScale` can change what those widths render as.

/** The parts of a DOMRect this module needs — so callers can pass a real rect or a plain object. */
export interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
}

/** Screen-px to keep clear on each horizontal edge of the canvas wrapper. */
export interface ScreenInsets {
  left: number
  right: number
}

export const NO_INSETS: ScreenInsets = { left: 0, right: 0 }

/**
 * How much of `wrap` the given panels cover, per edge. A panel that does not overlap `wrap` at
 * all contributes nothing; one that does is attributed to whichever edge it hugs, and the whole
 * edge is inset by it.
 *
 * The whole edge, deliberately: both panels are floating cards that cover only part of the
 * height, but a node is a rectangle. Insetting just the covered band is not expressible, and a
 * node that starts beside the panel reads as intentional where one sliding under it reads as a
 * bug.
 */
export function insetsForPanels(
  wrap: RectLike,
  panels: readonly (RectLike | null | undefined)[]
): ScreenInsets {
  let left = 0
  let right = 0
  for (const panel of panels) {
    if (!panel) continue
    // No overlap on either axis → the panel is not over this wrapper (a different monitor area,
    // a collapsed 0×0 node, a panel scrolled out of the way).
    if (panel.right <= wrap.left || panel.left >= wrap.right) continue
    if (panel.bottom <= wrap.top || panel.top >= wrap.bottom) continue
    // Attribute to the nearer edge. Both known panels hug one side (sessions left, explorer
    // right); a panel dead-centre would be a new shape this module should be taught about.
    const fromLeft = panel.left - wrap.left
    const fromRight = wrap.right - panel.right
    if (fromLeft <= fromRight) {
      left = Math.max(left, Math.min(panel.right - wrap.left, wrap.right - wrap.left))
    } else {
      right = Math.max(right, Math.min(wrap.right - panel.left, wrap.right - wrap.left))
    }
  }
  return { left: Math.max(0, left), right: Math.max(0, right) }
}

/** The panels that dock OVER the canvas while pinned. Both carry a `--pinned` modifier, so the
 *  document alone answers "is it docked right now?" — a hover peek has no such class. */
const PINNED_PANEL_SELECTOR = '.sessions-sidebar--pinned, .drawer--pinned'

/** `insetsForPanels` against whatever pinned panels are in the document right now. */
export function measurePinnedInsets(wrap: RectLike): ScreenInsets {
  if (typeof document === 'undefined') return NO_INSETS
  const panels = Array.from(document.querySelectorAll(PINNED_PANEL_SELECTOR)).map((el) =>
    el.getBoundingClientRect()
  )
  return insetsForPanels(wrap, panels)
}

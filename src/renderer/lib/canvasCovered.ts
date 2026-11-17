/**
 * Is the canvas currently hidden behind a full-page surface?
 *
 * The canvas stays MOUNTED under the kanban board on purpose — `display: none` would resize every
 * terminal to 0x0 and fire a tmux SIGWINCH (see the kanban section of CLAUDE.md) — so every node
 * glow, status pulse and minimap dot on it keeps animating under an opaque overlay nobody can see
 * through. Chromium culls most of that work but not all of it: MEASURED on the Server Edition with
 * twenty pulsing nodes, covering the canvas with an opaque full-screen div took total browser CPU
 * from 101 % to 12.8 %, against an idle floor of 1.5 %. Pausing the canvas's animations underneath
 * takes it the rest of the way, to 1.5 %.
 *
 * This is the same gate as `windowActivity.ts` and deliberately a SEPARATE attribute rather than a
 * second writer of that one: the two facts are independent (a board can be open on a focused
 * window, and a window can be unfocused with no board), and one attribute written by two owners is
 * a race over who clears it.
 *
 * **Mount is the signal, not a derived boolean.** Both board views are conditionally rendered, so
 * "this component exists" already means "the canvas is covered" — it cannot drift from the view
 * state the way a `kanbanOpen` flag recomputed somewhere else can, and it needs nothing from
 * Canvas.
 */

/** The attribute this module writes on the document element. */
export const CANVAS_COVERED_ATTR = 'data-nt-canvas'

/** Minimal surface of the element the attribute lives on, so the unit test needs no DOM. */
export interface CoveredRoot {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

let depth = 0

/**
 * Declare the canvas covered, and return the release.
 *
 * Refcounted because a view switch can legitimately overlap: React may mount the incoming surface
 * before it unmounts the outgoing one, and a plain set/clear pair would then have the outgoing
 * unmount erase the incoming mount's claim — leaving the canvas animating under a board that is
 * very much on screen. Releasing twice is a no-op, so a double-invoked cleanup cannot drive the
 * count negative and strand the attribute.
 */
export function markCanvasCovered(root: CoveredRoot): () => void {
  depth += 1
  if (depth === 1) root.setAttribute(CANVAS_COVERED_ATTR, 'covered')
  let released = false
  return () => {
    if (released) return
    released = true
    depth -= 1
    if (depth === 0) root.removeAttribute(CANVAS_COVERED_ATTR)
  }
}

/** The slice of a DOM element `coveredByBoard` reads, so the unit test needs no DOM. */
export interface CanvasElement {
  readonly ownerDocument: { readonly documentElement: { getAttribute(name: string): string | null } }
  closest(selector: string): unknown
}

/**
 * Is `el` part of the canvas while a board covers it — mounted, laid out, and under an opaque
 * surface nobody can see through? Nothing about the element itself says so (`checkVisibility()`
 * answers true for it), so a surface that must act only on what the person can see asks this.
 * A focus-mode node is reparented OUT of React Flow onto a surface above the board, and the card
 * modal is portaled outside it, so neither counts as covered.
 */
export function coveredByBoard(el: CanvasElement): boolean {
  return (
    el.ownerDocument.documentElement.getAttribute(CANVAS_COVERED_ATTR) === 'covered' &&
    el.closest('.react-flow') !== null
  )
}

/** Test seam: the module-level count is a singleton, so a suite has to be able to reset it. */
export function resetCanvasCoveredForTest(): void {
  depth = 0
}

/** How many surfaces currently claim the canvas is covered. Test seam. */
export function canvasCoveredDepth(): number {
  return depth
}

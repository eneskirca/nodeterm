/**
 * Node-focus handler bridge (ticket 10 — F11 focus / maximize).
 *
 * React Flow instantiates custom nodes itself, so Canvas can't pass the `openNodeAsCanvas` callback
 * through props. Canvas registers it here; node headers (TerminalNode, and any other node kind that
 * opts in) call `focusNode(id)` from their maximize button. Same indirection pattern GroupNode uses
 * for its drill/worktree handlers.
 *
 * The handler is set to `null` on Canvas unmount so a stale registration from a previous mount can
 * never focus into a canvas that no longer exists.
 */
let focusHandler: ((nodeId: string) => void) | null = null

/** Canvas registers `openNodeAsCanvas` here on mount. */
export function setFocusNodeHandler(fn: ((nodeId: string) => void) | null): void {
  focusHandler = fn
}

/**
 * Focus (maximize) the node `id` into a single-node sub-canvas. A no-op when no handler is
 * registered (e.g. the node is rendered outside Canvas — a Storybook or a test harness).
 */
export function focusNode(nodeId: string): void {
  focusHandler?.(nodeId)
}

/** Whether a focus handler is currently registered (drives the maximize button's enabled state). */
export function hasFocusHandler(): boolean {
  return focusHandler !== null
}

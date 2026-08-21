/**
 * Node-travel handler bridge (ticket 05 — cross-project projection `↗`).
 *
 * React Flow instantiates custom nodes itself, so Canvas can't pass `travelToNode` (the cross-
 * project switch + focus routine a notification click uses) through props. Canvas registers it
 * here; a projection's `↗` button calls `travelToNode(id)` to switch to the foreign project that
 * owns the node and frame it there. Same indirection pattern `focus-handler.ts` uses for the
 * single-node maximize — kept in its own module because the two handlers do different things
 * (maximize-into-sub-canvas vs. switch-project-and-focus) and a node opt-in must not conflate them.
 *
 * The handler is set to `null` on Canvas unmount so a stale registration from a previous mount can
 * never travel into a canvas that no longer exists.
 */
let travelHandler: ((nodeId: string) => void) | null = null

/** Canvas registers `travelToNode` here on mount. */
export function setTravelNodeHandler(fn: ((nodeId: string) => void) | null): void {
  travelHandler = fn
}

/**
 * Switch to the project that owns `id` and focus the node there. A no-op when no handler is
 * registered (e.g. the node is rendered outside Canvas — a test harness), so a projection's `↗`
 * degrades to nothing rather than throwing.
 */
export function travelToNode(nodeId: string): void {
  travelHandler?.(nodeId)
}

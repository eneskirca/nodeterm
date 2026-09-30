// Whether a terminal node is on screen right now, for ordering remote spawns
// (PtyCreateOptions.onScreen → core/remote-ssh/pty-spawn-gate.ts: on-screen spawns go first).
//
// A hint, never a gate: it only decides who queues behind whom on a project switch. So every
// uncertain case answers TRUE (= the old plain-FIFO position), and only a measured miss answers
// false.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** True unless `node` is measured and lies entirely outside `pane`. */
export function rectOnScreen(node: Rect | null, pane: Rect | null): boolean {
  if (!node || !pane) return true
  // An unmeasured element (display:none, not laid out yet) reports an all-zero rect.
  if (node.right - node.left <= 0 && node.bottom - node.top <= 0) return true
  return node.right > pane.left && node.left < pane.right && node.bottom > pane.top && node.top < pane.bottom
}

/** DOM glue: the element against the React Flow pane it sits in (the whole canvas viewport). */
export function elementOnScreen(el: Element | null): boolean {
  if (!el) return true
  const pane = el.closest('.react-flow')
  return rectOnScreen(el.getBoundingClientRect(), pane ? pane.getBoundingClientRect() : null)
}

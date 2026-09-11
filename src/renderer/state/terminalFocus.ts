import { create } from 'zustand'

/**
 * A one-shot "please take the keyboard" request for a node, keyed by node id with a monotonic
 * nonce so the SAME node can be re-requested (the nonce is what a subscriber effect watches).
 *
 * Why it exists: the "go to node" paths (a sidebar session click, a notification tap) select and
 * zoom to a node but do NOT move keyboard focus into it — a terminal's xterm only takes focus on a
 * deliberate hover-dwell or click (the pan/hover guard). So after a sidebar click the canvas framed
 * the session beautifully but the first keystroke went nowhere until the user clicked or hovered the
 * terminal. This store lets the canvas hand focus straight to the target so typing works
 * immediately. A terminal that is not mounted (off-screen/virtualized) simply misses the request —
 * fail-open, never an error.
 */
export const useTerminalFocus = create<{
  /** The node whose terminal should take the keyboard, or null. */
  nodeId: string | null
  /** Bumped on every request so re-requesting the same node still fires a subscriber effect. */
  nonce: number
  /**
   * Whether consuming the pending request should also ACK the node's finish. See `request`.
   *
   * Carried on the request rather than decided by the consumer, because only the CALLER knows
   * whether a human aimed at this node.
   */
  ack: boolean
  /**
   * The last terminal that actually took the keyboard, kept AFTER it lost focus again.
   *
   * This is the memory the window-activation restore reads (`lib/focusRestore.ts`). It must
   * deliberately survive a blur: the case it exists for is a pointer that left the node (a second
   * display, issue #557), which blurs the terminal through `onBodyLeave`, followed by a Cmd+Tab
   * out and back, where no pointer event is left to hand the keyboard over again. Clearing it on
   * blur would forget exactly the terminal we want back. It is never cleared explicitly: a node
   * that is gone or unmounted simply misses the request, the same fail-open as `request`.
   *
   * It therefore also survives a PROJECT SWITCH, so the remembered node can belong to another
   * project. That does NOT fail open: a request for an unmounted node stays LATENT rather than
   * being dropped. `nodeId` is cleared only by the consumer, and `TerminalNode`'s `lastFocusReqRef`
   * starts at 0, so the node consumes the request the moment it mounts. The cross-project
   * `pendingFocusRef` path in `Canvas` relies on exactly that, requesting right after a project
   * loads and before the node exists.
   *
   * So the restore, not this field, is where the staleness is refused: `nodeToRefocus` takes the
   * live nodes of the project on screen and returns null for an id that is not among them. Without
   * it, leaving project A with a terminal focused, switching to B and Cmd+Tabbing back would park a
   * request that fires on the next switch to A, handing a node the keyboard minutes after the
   * activation nobody aimed at it.
   */
  lastNodeId: string | null
  /**
   * Ask a node's terminal to take the keyboard now.
   *
   * `ack` (default true) also marks the node's finish read, everywhere: `clearUnread` calls
   * `ackDone`, which resolves the notch capsule's blob and the paired phone's DONE Live Activity
   * and Inbox card. That is right for a request a human aimed at a node (a sidebar click, a
   * notification tap, ⌘K) and wrong for one the app raised on its own, so the window-activation
   * restore passes `{ ack: false }`.
   */
  request(nodeId: string, opts?: { ack?: boolean }): void
  /** Record that this node's terminal has the keyboard (called where it takes focus). */
  remember(nodeId: string): void
}>((set) => ({
  nodeId: null,
  nonce: 0,
  ack: true,
  lastNodeId: null,
  request: (nodeId, opts) => set((s) => ({ nodeId, nonce: s.nonce + 1, ack: opts?.ack !== false })),
  remember: (nodeId) => set({ lastNodeId: nodeId })
}))

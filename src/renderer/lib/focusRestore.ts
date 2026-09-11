/**
 * Which terminal (if any) should take the keyboard back when the window is activated again.
 *
 * Issue #557. Terminal focus in this app is pointer-driven: `TerminalNode`'s hover guard focuses
 * xterm on a dwell or a click and BLURS it again on `mouseleave`. On a multi-monitor desk the
 * pointer routinely leaves the node on its way to another display, so by the time the user
 * Cmd+Tabs away the terminal has already lost focus, and coming back there is no pointer event
 * left to hand it over. `document.activeElement` is `<body>`, the guard is armed again, and the
 * next keystroke goes to the global dispatcher, where a bare Backspace is `canvas.deleteSelection`
 * and opens the delete-node confirm over a terminal the user believed they were typing into.
 *
 * The decision is pure so the interesting refusals are testable without a window that can be
 * activated: this runs on window activation, where reading the DOM by hand proves very little.
 */
import { isTerminalTarget, isTypingTarget, type ContextElement } from './keyContext'

export interface FocusRestoreState {
  /** The last terminal that held the keyboard (`useTerminalFocus.lastNodeId`). */
  lastNodeId: string | null
  /** Who holds focus at the moment the window came back. */
  activeElement: ContextElement | null
  /** How many modals are open (`openDialogCount()`). */
  openDialogs: number
  /**
   * The kanban board is up for the active project (`isKanbanOpen`).
   *
   * The board is NOT in the dialog stack, so `openDialogs` cannot see it. A full-page surface
   * that covers the canvas without registering there owes a field of its own here.
   */
  boardOpen: boolean
  /** The settings page is up. Also outside the dialog stack, for the same reason as `boardOpen`. */
  settingsOpen: boolean
  /**
   * The nodes of the project currently on screen, by id.
   *
   * Empty means "we cannot tell which project's nodes we are holding", which refuses rather than
   * guesses: `nodesRef` is only trustworthy while its epoch tag still matches the active project.
   */
  liveIds: ReadonlySet<string>
}

/**
 * The node to hand the keyboard to, or `null` to leave focus exactly where the browser put it.
 *
 * Every refusal is "something else is already owning, or about to own, the keyboard":
 * - **A modal is open**: a confirm, the card modal (whose own terminal focuses itself), a prompt.
 *   Stealing focus out from under one is worse than the bug this fixes, and `openDialogCount`
 *   already answers it for every modal in the app (they all register in the dialog stack).
 * - **A full-page surface is up**: the kanban board and the settings page both paint an OPAQUE
 *   layer over a still-mounted canvas, and neither registers in the dialog stack. Restoring under
 *   one aims the keyboard at a terminal the user cannot see, which is the same hazard the modal
 *   refusal exists for and worse than the bug: they are looking at the board and typing into a
 *   pane somewhere behind it.
 * - **A typing surface has focus**: a settings field, a sticky's textarea, Monaco. Chromium
 *   restores the previously focused element on activation, so this is the ordinary case of the
 *   user having left the app from a text field; it is not ours to override.
 * - **A terminal already has focus**: the pointer never left, so nothing was lost. Restoring
 *   would be a no-op at best and could move focus to a DIFFERENT node at worst.
 * - **The remembered node is not on the canvas we are looking at**: `lastNodeId` deliberately
 *   survives a project switch, and a request for an unmounted node is not dropped, it stays
 *   LATENT until that node mounts (`TerminalNode`'s `lastFocusReqRef` starts at 0, and only the
 *   consumer clears the store). So restoring a node that belongs to another project queues a
 *   focus that fires minutes later, the next time the user switches back to it. Refusing here is
 *   what keeps the restore bound to the canvas the activation actually returned to.
 */
export function nodeToRefocus(state: FocusRestoreState): string | null {
  const { lastNodeId, activeElement, openDialogs, boardOpen, settingsOpen, liveIds } = state
  if (!lastNodeId || openDialogs > 0) {
    return null
  }
  if (!liveIds.has(lastNodeId)) {
    return null
  }
  if (boardOpen || settingsOpen) {
    return null
  }
  if (isTerminalTarget(activeElement) || isTypingTarget(activeElement)) {
    return null
  }
  return lastNodeId
}

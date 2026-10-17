/**
 * Who decides which terminal node holds the keyboard: the POINTER, or a CLICK.
 *
 * Issue #757 — "option to disable X Window focus-follows-pointer (Mac-style click to select what
 * UI element has the input focus)". `TerminalNode`'s hover guard has always tied the keyboard to
 * the pointer: dwelling `settings.panHoverDelay` over a terminal focuses its xterm, and
 * `mouseleave` blurs it again and drops the node's agent-status active flag and presence focus. On
 * a crowded canvas that is the X11 "focus follows mouse" model, and a user who reaches for another
 * card, a second display or the sidebar while an agent is mid-prompt loses the keyboard every time.
 *
 * `settings.terminalFocusFollowsPointer` (default ON — the long-standing behaviour) picks the model:
 *
 * - **ON — focus follows the pointer, sloppily.** A hover dwell takes the keyboard, and the
 *   terminal KEEPS it after the pointer leaves — until another node takes it (its own dwell, a
 *   click) or the user clicks elsewhere. This used to be strict X11 focus-follows-mouse, where
 *   `mouseleave` blurred the xterm and dropped the active flag and presence focus: typing into a
 *   terminal while the mouse rested on the canvas silently went nowhere, and so did every reach for
 *   the sidebar mid-prompt. Only the hover GUARD still follows the pointer here (leaving re-arms
 *   it, so a pass-over scroll pans the canvas until the next dwell).
 * - **OFF — click to focus.** The pointer decides nothing. A click on the terminal (the guard's
 *   `onGuardClick` → `enterNow`, issue #87) or a "go to node" request takes the keyboard, and the
 *   terminal KEEPS it until focus really goes somewhere else: another node, the empty canvas
 *   (whose `onPaneClick` blurs the xterm textarea, issue #86), a text field. The guard follows
 *   DOM focus too.
 *
 * In BOTH modes the node's active flag and presence focus follow DOM focus, through
 * `useClickToFocus` (named for #757, where it was born) — see `focusLossOutcome`. The modes differ
 * only in how the keyboard is TAKEN (dwell or click) and in who owns the guard.
 *
 * Pure so the decisions are testable without a mounted xterm; `TerminalNode` owns the effects.
 */

/**
 * The setting as read from a hand-editable settings.json: only a literal `false` switches to click
 * to focus. Anything else (absent, a string, null) keeps the long-standing default, so a mangled
 * file can never silently change how every terminal takes the keyboard.
 */
export function resolveFocusFollowsPointer(value: unknown): boolean {
  return value !== false
}

/** Does a hover dwell over the body hand the keyboard to the terminal? */
export function hoverTakesKeyboard(focusFollowsPointer: boolean): boolean {
  return focusFollowsPointer
}

/**
 * Does the pointer leaving the body re-arm the hover guard? Only while focus follows the pointer,
 * where the guard is a pointer contract. It never takes the keyboard away, in either mode: the
 * keyboard, the active flag and presence focus are released by `focusLossOutcome`, which follows
 * where the KEYBOARD goes rather than where the mouse goes.
 */
export function pointerLeaveRearmsGuard(focusFollowsPointer: boolean): boolean {
  return focusFollowsPointer
}

/**
 * Do DOM focus changes arm and disarm the hover guard (`useClickToFocus`'s `setArmed`)?
 *
 * Only in click to focus, where the guard has no other owner. While focus follows the pointer the
 * dwell, a click and `mouseleave` own it, and focus moving would get it wrong both ways: a release
 * while the pointer rests on the body (⌘K, a sidebar jump) would re-arm it with no `mouseenter`
 * coming to restart the dwell, and a reclaim after a header drag would drop it while the pointer is
 * elsewhere, so the next pass-over scroll would reach tmux instead of panning the canvas.
 */
export function focusDrivesGuard(focusFollowsPointer: boolean): boolean {
  return !focusFollowsPointer
}

/**
 * Should a hover dwell that has just made this node active blur the element holding the keyboard?
 *
 * With sloppy focus the dwell onto the NEXT node is what moves the keyboard: focusing its xterm
 * takes it from the terminal the user came from. A node whose ⌘M view covers its xterm cannot take
 * it (`focusXtermUnlessCovered`), so the previous terminal would keep receiving keystrokes while
 * this node reads as the active one — typing into a pane nobody is looking at. Only ANOTHER
 * terminal's xterm is blurred: a sticky, an editor or a text field keeps its caret, exactly as it
 * did when `mouseleave` was what released a terminal.
 */
export function dwellBlursForeignTerminal(p: { covered: boolean; activeIsForeignXterm: boolean }): boolean {
  return p.covered && p.activeIsForeignXterm
}

/** The slice of a node's root element this module reads. */
export interface NodeRootLike {
  contains(other: unknown): boolean
}

export interface FocusLossEvent {
  /** The node's root (`.term-node`), or null if it is gone. */
  nodeRoot: NodeRootLike | null
  /** The element that lost focus (`focusout`'s target). */
  lost: unknown
  /** Where focus went (`focusout`'s `relatedTarget`); null for "nowhere" AND for a window blur. */
  gained: unknown
  /** `document.activeElement` at the time of the event. */
  activeElement: unknown
  /** `document.hasFocus()` at the time of the event. */
  windowFocused: boolean
  /** A press landed on THIS node (its React Flow wrapper, header included) in the same task — the
   *  focus change is that press's default action, not a click somewhere else. */
  pressedInOwnNode: boolean
  /** That press landed on text the user READS and may select — the ⌘M chat's message list. The
   *  press is the start of a drag-selection, and handing focus back to the composer in the same
   *  moment moves the document selection into the textarea and cancels the drag. */
  pressedInReadableText: boolean
  /** The element that lost focus is this node's xterm while its ⌘M view is open: the only way that
   *  happens is `useMdModeFocus` blurring it as the view opens (every other "take the keyboard"
   *  path goes through `focusXtermUnlessCovered`, which never focuses a covered xterm). */
  lostIsCoveredXterm: boolean
}

/** What a `focusout` inside the node means (both modes since sloppy focus). */
export type FocusLossOutcome =
  /** Nothing changed that the node must act on. */
  | 'keep'
  /** The user clicked this node's own chrome: hand the keyboard straight back to its terminal. */
  | 'reclaim'
  /** The user pressed text they may be selecting: hand the keyboard back only when the press
   *  ends WITHOUT a selection (a plain click), so a drag-selection survives to be copied. */
  | 'reclaim-on-release'
  /** The keyboard really went somewhere else: release the node. */
  | 'release'

/**
 * What did a `focusout` inside this node mean? (Born for click to focus; both modes use it now.)
 *
 * The one place the node's "I hold the keyboard" state is released in that mode, so it must tell
 * a real move from its look-alikes:
 *
 * - **Focus stayed inside the node** (the header's rename field, a header button, the ⌘M view's
 *   composer). The user is still working HERE → `keep`.
 * - **The window lost focus** (Cmd+Tab, a click on another app). Chromium fires `blur`/`focusout`
 *   on the focused element, but that element remains `document.activeElement` and is focused
 *   again on return — the terminal never stopped owning the keyboard → `keep`.
 * - **The node's own ⌘M view opening** (`lostIsCoveredXterm`). `useMdModeFocus` blurs the xterm and
 *   focuses nothing, so this focusout has no destination and no press — the same shape as a click
 *   on the empty canvas — yet the user is still looking at this node → `keep`. If they then click
 *   elsewhere, focus is already on `<body>` and `outsidePressReleases` ends it.
 * - **A press on this node's own chrome** (dragging it by the header, clicking its border). The
 *   browser moves focus to the React Flow wrapper (it is focusable) or to `<body>`, and either
 *   way the keystroke after it would land on the canvas — where a bare Backspace is
 *   `canvas.deleteSelection`. #757 asks that the terminal keep the keyboard until the user clicks a
 *   DIFFERENT card, so this hands it back → `reclaim`.
 * - **A press on text the user may select** (`pressedInReadableText`, the ⌘M chat's messages). The
 *   same press as above, but reclaiming NOW moves the selection into the composer and kills the
 *   drag — nothing could be highlighted or copied. So the reclaim waits for the press to end, and
 *   only happens if it ended without a selection → `reclaim-on-release` (see `reclaimOnRelease`).
 *
 * Everything else — focus on another node's xterm or a text field, or on `<body>` because a click
 * landed on the empty canvas — is the user clicking elsewhere, which is exactly what #757 wants to
 * be the ONLY way to leave → `release`. A node that is gone answers `keep` rather than guessing.
 */
export function focusLossOutcome(e: FocusLossEvent): FocusLossOutcome {
  if (!e.nodeRoot) return 'keep'
  if (!e.windowFocused) return 'keep'
  if (e.lostIsCoveredXterm) return 'keep'
  if (e.activeElement === e.lost) return 'keep'
  if (e.gained && e.nodeRoot.contains(e.gained)) return 'keep'
  if (e.pressedInOwnNode) return e.pressedInReadableText ? 'reclaim-on-release' : 'reclaim'
  return 'release'
}

export interface OutsidePress {
  /** This node is the agent-status `activeId` (the one whose finishes are "being watched"). */
  isActive: boolean
  /** The press landed on this node (its React Flow wrapper, header included). */
  pressInsideNode: boolean
  /** `document.activeElement` is inside this node's root at the time of the press. */
  focusInsideNode: boolean
}

/**
 * Does a press ANYWHERE ELSE release a node that holds no DOM focus? (Both modes.)
 *
 * `focusLossOutcome` can only answer for a node that had focus to lose. Activity is also claimed
 * without it: a "go to node" while the ⌘M view covers the xterm (`enterNow` reports activity, but
 * `focusXtermUnlessCovered` deliberately leaves the hidden terminal unfocused) and Canvas's own
 * `setActive` on a sidebar or notification jump. Strict focus-follows-pointer had `mouseleave`
 * clean that up; with click to focus, and now sloppy focus, nothing else does, and a stale active
 * flag makes Canvas treat the node as watched — its next finish never gets an unread dot — and
 * leaves presence saying "working here".
 *
 * So a press outside such a node is the user clicking elsewhere, which is the release #757 names.
 * A node that DOES hold focus is left to its own `focusout` (the press may not move focus at all —
 * a pane drag, a scroll — and then it rightly keeps the keyboard).
 */
export function outsidePressReleases(p: OutsidePress): boolean {
  return p.isActive && !p.pressInsideNode && !p.focusInsideNode
}

/**
 * `reclaim`: which element gets the keyboard back after a press on the node's own
 * chrome? The one that lost it, when it is still inside the node and is not the xterm (the ⌘M
 * composer — the covered xterm cannot take focus, so falling back to it strands the keyboard on the
 * React Flow wrapper); otherwise the xterm, through `focusXtermUnlessCovered`.
 */
export function reclaimTarget(p: { lostIsXterm: boolean; lostStillInNode: boolean }): 'lost' | 'xterm' {
  return !p.lostIsXterm && p.lostStillInNode ? 'lost' : 'xterm'
}

/**
 * Does this press ACKNOWLEDGE the node (the `enterNow` routine — active flag, `clearUnread`,
 * presence, remember, and the xterm focused unless the ⌘M view covers it)?
 *
 * Focus-follows-pointer acknowledges on every dwell, and a body press there is a dwell's worth of
 * intent anyway (the guard is already down). Click to focus has no dwell, so a deliberate
 * primary press anywhere in the node BODY is the acknowledgement: on the xterm even when the guard is
 * already down (Codex round 3 — a finish that turned unread while the window was inactive could not
 * be cleared by clicking the terminal it belongs to), on the open ⌘M view, on its composer. Three
 * exclusions: the guard itself, because a press there may start a node drag and `HoverGuard` owns
 * that decision on release; the header chrome; and non-primary buttons (the context menu). A focus
 * restore with no press (window activation) is never an acknowledgement — only presses reach this.
 */
export function bodyPressAcknowledges(p: { primary: boolean; inBody: boolean; onGuard: boolean }): boolean {
  return p.primary && p.inBody && !p.onGuard
}

/**
 * `reclaim-on-release`, decided when the press ends: give the keyboard back to the element that
 * lost it only for a plain click (nothing selected) and only if that element is still in the node.
 * A press that selected text keeps the selection — and the keyboard off the composer, so Cmd/Ctrl+C
 * copies it; clicking the composer (or anywhere) afterwards behaves as usual.
 */
export function reclaimOnRelease(p: { selectionEmpty: boolean; lostStillInNode: boolean }): boolean {
  return p.selectionEmpty && p.lostStillInNode
}

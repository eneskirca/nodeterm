import { useEffect, useRef } from 'react'

/** The slice of an xterm `Terminal` this hook touches (its helper textarea holds DOM focus). */
export interface FocusableTerm {
  readonly textarea?: HTMLTextAreaElement
  blur(): void
  focus(): void
}

/**
 * Focus hand-off for a terminal node's ⌘M face (the output view AND the ChatPanel).
 *
 * Opening the view covers the xterm but used to leave it focused, so every keystroke kept flowing
 * into a pane the user could no longer see — into an agent's composer or a shell prompt. On entry
 * the terminal is blurred and, when the face is the ChatPanel, its composer takes the keyboard
 * (`takeComposerFocusRequest`); on exit focus goes back ONLY if the terminal had it when the view
 * opened. Restoring unconditionally would pull focus out of whatever the user moved to meanwhile
 * (another node, a text field) the moment they toggle the view off from the menu.
 *
 * Entry state alone is not enough to restore: the view can stay open for minutes, and the user may
 * have moved on to a text field elsewhere (the view is toggled from the context menu or ⌘K, not
 * only by ⌘M over the node). So exit also asks where focus IS (`mayRestoreFocus`).
 *
 * `getTerm` is read at transition time, not captured: the node's xterm can be released, parked or
 * respawned while the view is open, and a stale instance must never be focused.
 */
/**
 * Node ids whose NEXT ⌘M exit must focus the terminal whatever the entry state was. Set by an
 * action that is itself an explicit "go to the terminal": the ⌘M composer's model / effort label,
 * which types `/model` / `/effort` into the pane and flips the view so the user can drive the
 * picker it opened — with the keyboard, which is useless if the xterm does not have it. Entry was
 * very often NOT from a focused terminal (context menu, ⌘K, the kanban card), which is exactly
 * when the restore rule above would leave the picker unreachable.
 *
 * Module-level and keyed by node id because the request is made by the panel, which unmounts in
 * the same flip, and consumed by the terminal's hook, which lives on. Consumed once: the hook that
 * takes it deletes it, so a later unrelated exit is back on the ordinary rule.
 */
const focusOnExit = new Set<string>()

/** Ask the next ⌘M exit of `nodeId` to focus its terminal. Call BEFORE the state change. */
export function requestTerminalFocusOnExit(nodeId: string): void {
  focusOnExit.add(nodeId)
}

/**
 * Entries of a ⌘M view whose chat composer has not mounted yet, keyed by node id. Opening the
 * view moves the keyboard to the composer (the reason to open the chat face is usually to type
 * into it), but the ChatPanel is code-split: on the first open it suspends, so the composer
 * mounts a commit or more AFTER this hook's entry effect ran. The composer takes the request on
 * mount (`takeComposerFocusRequest`). The root is kept so the composer can tell whether it is
 * the one the request was made for (the canvas node and the kanban card modal share a node id)
 * and whether the user moved on to something else while it loaded. Cleared on exit, so a
 * composer that appears later — the session id arrived while the output view was up — does not
 * grab the keyboard out of nowhere.
 */
const composerFocusPending = new Map<string, () => Element | null | undefined>()

/** The selector of a mounted, usable chat composer textarea (ChatComposer's box carries the id). */
const COMPOSER_TEXTAREA = '[data-chat-composer-id] textarea:not(:disabled)'

/**
 * Whether opening the ⌘M view may move the keyboard into its composer: focus is nowhere, already
 * inside this node, or in a terminal (this one was just blurred; another terminal under a
 * click-to-focus pointer is a pane, not a field the user is typing a form into). A text field
 * elsewhere — a rename box, the sessions filter, another node's composer — keeps it.
 */
export function mayFocusComposer(
  active: Element | null,
  nodeRoot: Element | null | undefined,
  body: Element | null
): boolean {
  if (mayRestoreFocus(active, nodeRoot, body)) return true
  return active !== null && active.classList.contains('xterm-helper-textarea')
}

function focusComposerIn(root: Element | null | undefined): boolean {
  const ta = root?.querySelector<HTMLTextAreaElement>(COMPOSER_TEXTAREA)
  if (ta === null || ta === undefined) return false
  ta.focus()
  return true
}

/**
 * Called by a chat composer on mount: if the ⌘M view of `nodeId` was just opened and its
 * composer had not mounted yet, take the keyboard now. `el` is the composer's textarea.
 */
export function takeComposerFocusRequest(nodeId: string, el: HTMLTextAreaElement | null): void {
  const getRoot = composerFocusPending.get(nodeId)
  if (getRoot === undefined || el === null || el.disabled) return
  const root = getRoot()
  if (root === null || root === undefined || !root.contains(el)) return // another mount of the same session (card modal vs node)
  composerFocusPending.delete(nodeId)
  if (mayFocusComposer(document.activeElement, root, document.body)) el.focus()
}

export function useMdModeFocus(
  mdMode: boolean,
  getTerm: () => FocusableTerm | null | undefined,
  getRoot: () => Element | null | undefined,
  /** Whose `requestTerminalFocusOnExit` this hook answers. Absent = never forced. */
  nodeId?: string
): void {
  const restoreRef = useRef(false)
  const prevRef = useRef(mdMode)
  const getTermRef = useRef(getTerm)
  getTermRef.current = getTerm
  const getRootRef = useRef(getRoot)
  getRootRef.current = getRoot
  const nodeIdRef = useRef(nodeId)
  nodeIdRef.current = nodeId

  useEffect(() => {
    if (prevRef.current === mdMode) return
    prevRef.current = mdMode
    const term = getTermRef.current()
    if (mdMode) {
      const ta = term?.textarea
      restoreRef.current = !!ta && document.activeElement === ta
      term?.blur()
      // Hand the keyboard to the chat composer (when this face has one). Mounted already — the
      // ChatPanel chunk was loaded and the composer's own mount effect ran before this parent
      // effect — focus it here; otherwise leave a request for its mount.
      const id = nodeIdRef.current
      const root = getRootRef.current()
      if (id !== undefined && mayFocusComposer(document.activeElement, root, document.body)) {
        if (!focusComposerIn(root)) composerFocusPending.set(id, () => getRootRef.current())
      }
      return
    }
    if (nodeIdRef.current !== undefined) composerFocusPending.delete(nodeIdRef.current)
    if (nodeIdRef.current !== undefined && focusOnExit.delete(nodeIdRef.current)) {
      // An explicit "go to the terminal" (see `requestTerminalFocusOnExit`): the user just clicked
      // inside this node to get here, so nothing they chose elsewhere is being overridden.
      restoreRef.current = false
      term?.focus()
    } else if (restoreRef.current) {
      restoreRef.current = false
      if (mayRestoreFocus(document.activeElement, getRootRef.current(), document.body)) term?.focus()
    }
  }, [mdMode])
}

/**
 * Whether exiting the ⌘M view may hand focus back to the xterm: only when focus is nowhere
 * (null / `<body>` — typically because the view's own ↻ button just unmounted with it) or still
 * inside this node. Focus anywhere else belongs to something the user chose meanwhile.
 */
export function mayRestoreFocus(
  active: Element | null,
  nodeRoot: Element | null | undefined,
  body: Element | null
): boolean {
  if (!active || active === body) return true
  return !!nodeRoot && nodeRoot.contains(active)
}

/**
 * The xterm focus call for every "take the keyboard" path in TerminalNode (hover dwell, click,
 * sidebar / notification jump, window-activation restore). While the ⌘M view covers the terminal
 * it must NOT focus: the overlay sits inside the node body, so a dwell over it — or a sidebar jump
 * to the node — used to route keystrokes into a pane nobody could see.
 */
export function focusXtermUnlessCovered(term: FocusableTerm | null | undefined, covered: boolean): void {
  if (!covered) term?.focus()
}

/**
 * Whether a file DROP or PASTE on the node body belongs to the terminal. The file handlers sit on
 * `.term-node__body`, which also hosts the ⌘M face — so while the view covers the xterm, a
 * screenshot pasted into the ChatPanel composer (or a file dropped on the output view) was caught
 * in the capture phase, written as a path into the hidden pane, and the xterm focused to match.
 * Covered, the handlers stand aside and the event behaves natively for whatever is under the
 * pointer / caret: a paste lands in the composer, a drop falls to the window-level guard.
 *
 * Keyed on the same cover flag as `focusXtermUnlessCovered`, not on the event target: the overlay
 * spans the whole body, so "covered" already answers "is this event aimed at the view", and one
 * flag cannot drift from the focus rule the way a second list of overlay selectors could.
 */
export function terminalOwnsFileInput(covered: boolean): boolean {
  return !covered
}

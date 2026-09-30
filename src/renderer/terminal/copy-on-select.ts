import type { Terminal } from '@xterm/xterm'
import { isMacPlatform } from '@shared/platform-utils'

/**
 * Copy-on-select (issue #759): when the `copyOnSelect` setting is on, a COMPLETED MOUSE selection
 * that xterm owns lands on the system clipboard.
 *
 * A sibling of `terminal-config.ts`, not part of it: that module is pure appearance decisions that
 * flow into xterm OPTIONS, and this is behaviour attached to a live `Terminal` with the clipboard
 * bridge injected. It exists as one helper so the canvas node (`TerminalNode`) and the kanban modal
 * (`ModalTerminal`) cannot drift apart; the settings preview (`TerminalPreview`) deliberately does
 * NOT call it — it is a sample, not a session, and `disableStdin` does not stop a mouse selection.
 *
 * WHERE THIS ACTUALLY APPLIES. On macOS/Linux every session runs under tmux with its mouse ON, so a
 * plain drag is tmux copy-mode, which already reaches the clipboard through OSC 52 (the handler in
 * TerminalNode) — xterm owns the selection there only for a FORCED selection (Option-drag on macOS,
 * see below). On Windows there is no tmux (the session-host backend, `pty-manager.ts`), so a plain
 * drag IS an xterm selection unless the running app enabled mouse tracking — that is the case the
 * issue was filed for. Either way this cannot copy a selection an app draws itself (a TUI that
 * captures the mouse and highlights its own text), and it does not touch OSC 52 copies, which
 * arrive independently of this setting.
 *
 * WHICH SELECTIONS COUNT — and why this is not an `onSelectionChange` subscription. That event
 * also fires for PROGRAMMATIC selections (the search addon calls `Terminal.select()` for every hit
 * the user steps through) and on a clear. So the trigger is the gesture instead: a primary-button
 * press inside `term.element` that xterm's own SelectionService takes (`xtermOwnsMouseDown`),
 * followed by a release ANYWHERE in the window — a drag very often overshoots the node, and xterm
 * itself listens for that release on the document. Double/triple-click word/line selection is the
 * same gesture with `detail` 2/3 and is covered for free. xterm 5.5.0 has no public
 * "selection finished" event and no `copyOnSelect` option, hence the DOM listeners.
 *
 * ORDERING, verified against xterm 5.5.0 `SelectionService`: on mousedown it adds a DOCUMENT
 * bubble-phase `mouseup` listener and finalises the selection there (`_handleMouseUp` →
 * `_fireEventIfSelectionChanged`). Our release listener is on the WINDOW in the CAPTURE phase (so
 * nothing below can stop it), i.e. it runs BEFORE xterm's. The read is therefore deferred with a
 * macrotask (`setTimeout 0`) — NOT `queueMicrotask`: for a real user event the microtask
 * checkpoint runs between listener callbacks, which would still be before xterm's document
 * listener.
 *
 * FORCED SELECTIONS COPY — intentionally. Inside an app that tracks the mouse, xterm still selects
 * when the gesture is forced (`macOptionClickForcesSelection` + Option on macOS, Shift elsewhere);
 * that selection is exactly as deliberate as a plain drag in a shell, so it copies too. The
 * flip side is equally deliberate: a plain press while an app tracks the mouse is NOT ours, so a
 * stale xterm selection still on screen is never re-copied over the top of what tmux just put on
 * the clipboard through OSC 52.
 *
 * NEVER AN EMPTY WRITE: a plain click clears the selection; writing `''` would wipe the clipboard.
 *
 * `enabled` is read LIVE at press AND at read time, so toggling the setting applies to the next
 * gesture on every open terminal without recreating any of them.
 */

/** The slice of an xterm `Terminal` this helper reads — narrow, so tests need no real xterm. */
export interface CopyOnSelectTerminal {
  readonly element: HTMLElement | undefined
  readonly modes: { readonly mouseTrackingMode: Terminal['modes']['mouseTrackingMode'] }
  readonly options: { readonly macOptionClickForcesSelection?: boolean }
  hasSelection(): boolean
  getSelection(): string
}

export interface CopyOnSelectDeps {
  /** The live setting. Read at event time, never captured. */
  enabled: () => boolean
  /** Writes the system clipboard. Callers pass the bridge's QUIET path (no failure toast per drag). */
  write: (text: string) => void
  /** Defaults to `isMacPlatform()` — the same navigator test xterm's own `Browser.isMac` makes. */
  isMac?: boolean
}

/**
 * Does xterm's SelectionService take this mousedown? Mirrors xterm 5.5.0 `handleMouseDown` +
 * `shouldForceSelection`: primary button only; always when no app tracks the mouse (the service is
 * enabled); otherwise only when forced — Option (with `macOptionClickForcesSelection`) on macOS,
 * Shift everywhere else.
 */
export function xtermOwnsMouseDown(
  e: MouseEvent,
  mouseTrackingMode: CopyOnSelectTerminal['modes']['mouseTrackingMode'],
  platform: { isMac: boolean; optionForces: boolean }
): boolean {
  if (e.button !== 0) return false
  if (mouseTrackingMode === 'none') return true
  return platform.isMac ? e.altKey && platform.optionForces : e.shiftKey
}

/**
 * Attach copy-on-select to an OPENED terminal. Returns the disposer.
 *
 * Only ONE listener persists — the capture-phase `mousedown` on `term.element`, which travels with
 * the xterm instance across a park/adopt exactly like `installLinkClickFallback`. Capture phase
 * because xterm calls `stopPropagation` on a forced mousedown (so the press never reaches the pty)
 * from its bubble listener on that same element. The window `mouseup` listener exists only while
 * a gesture is in flight (one-shot, together with the `blur` / `mousedown` listeners that cancel a
 * gesture whose release was lost — see `disarm`), so nothing window-level outlives its gesture.
 */
export function attachCopyOnSelect(term: CopyOnSelectTerminal, deps: CopyOnSelectDeps): () => void {
  const element = term.element
  if (!element) return () => {}
  const win = element.ownerDocument.defaultView ?? window
  const isMac = deps.isMac ?? isMacPlatform()
  let pendingUp: ((e: MouseEvent) => void) | null = null
  let readTimer: ReturnType<typeof setTimeout> | null = null

  // Ends an armed gesture WITHOUT a write. Three ways a gesture can lose its release, and each is a
  // trigger here, because an armed listener that outlives its gesture would copy whatever is
  // selected when some LATER release arrives — a stale highlight or a search hit:
  //  - `blur`: button held, released in another app;
  //  - any later `mousedown` in the window: the previous release was lost somewhere else (a new
  //    owned press here re-arms right after, since the window capture listener runs before the
  //    element's);
  //  - dispose.
  const disarm = (): void => {
    if (pendingUp) win.removeEventListener('mouseup', pendingUp, true)
    pendingUp = null
    win.removeEventListener('blur', disarm)
    win.removeEventListener('mousedown', disarm, true)
  }

  const clearPending = (): void => {
    disarm()
    if (readTimer !== null) clearTimeout(readTimer)
    readTimer = null
  }

  const onDown = (e: MouseEvent): void => {
    if (!deps.enabled()) return
    const owned = xtermOwnsMouseDown(e, term.modes.mouseTrackingMode, {
      isMac,
      optionForces: term.options.macOptionClickForcesSelection === true
    })
    if (!owned) return
    clearPending()
    const onUp = (up: MouseEvent): void => {
      // Only the PRIMARY release completes the gesture: a right/middle release mid-drag would copy
      // the partial selection and drop the real one.
      if (up.button !== 0) return
      disarm()
      readTimer = setTimeout(() => {
        readTimer = null
        if (!deps.enabled() || !term.hasSelection()) return
        const text = term.getSelection()
        if (text) deps.write(text)
      }, 0)
    }
    pendingUp = onUp
    win.addEventListener('mouseup', onUp, true)
    win.addEventListener('blur', disarm)
    // Added during THIS press's element-capture phase, so it cannot fire for this press: the
    // window's capture phase has already passed.
    win.addEventListener('mousedown', disarm, true)
  }

  element.addEventListener('mousedown', onDown, true)
  return () => {
    element.removeEventListener('mousedown', onDown, true)
    clearPending()
  }
}

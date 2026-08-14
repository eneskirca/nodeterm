import { useProjects } from '../state/projects'
import { isKanbanOpen } from '../state/viewMode'

/**
 * The two canvas ZOOM chords as ONE pure decision:
 *
 * - **⌘/Ctrl+0 → back to 100%.** The universal "actual size" key. Every browser means it, and so
 *   does Electron's own default View menu (`resetZoom`), so binding the canvas's `zoomTo100` to it
 *   is the app agreeing with its two shells rather than fighting them. `Digit0` is deliberately
 *   excluded from the ⌘/Ctrl+1-9 project-jump chord (`projectJump.ts`), so the two can never
 *   collide — `zoomShortcut.test.ts` pins that from this side too.
 * - **Shift+1 → fit everything.** The Figma / tldraw / Excalidraw convention for "zoom to fit".
 *   No modifier chord in this app claims a bare Shift+digit, and no menu accelerator can (menus
 *   need a primary modifier), so the only thing Shift+1 competes with is *typing* `!` — which is
 *   exactly what the `textFocus` refusal below is for.
 *
 * Matching is on `e.code` (the physical key), not `e.key`: on AZERTY the unshifted digit row
 * prints letters and `Shift+1` prints `1`, and both shortcuts are positional. Same reasoning, and
 * the same reason `@shared/shortcut` does not fit, as `projectJump.ts` — see its header.
 *
 * The refusals are the whole point of the module. Both chords move the camera, and a camera move
 * on this canvas is not a read-only act: `onMove` → `markDirty` persists the viewport and casts it
 * to everyone in the team-sync session. So the decision has to be made in one place that every
 * entry point asks, rather than re-derived per call site.
 */

export type ZoomShortcutAction = 'zoom-100' | 'fit-all'

/** The subset of `KeyboardEvent` the chord is decided from (so tests need no DOM). */
export interface ZoomShortcutEvent {
  type: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** OS auto-repeat: true on every keydown after the first while the chord is HELD. */
  repeat: boolean
}

export interface ZoomShortcutContext {
  /** The kanban board is up — an OPAQUE overlay over a still-mounted canvas. */
  boardOpen: boolean
  /** Focus is in a text surface (input / textarea / contenteditable / Monaco / xterm). */
  textFocus: boolean
}

/**
 * PURE, key-shape only: which zoom chord this keydown is, or null when it is not one.
 *
 * Alt is excluded on both because AltGr reports as ctrl+alt and must keep typing a real character
 * on non-US layouts. Auto-repeat is excluded because both actions are ANIMATED (300ms fitView /
 * 200ms setViewport): holding the chord would restart the tween on every repeat, which reads as a
 * stutter rather than a zoom.
 */
export function zoomShortcutChord(e: ZoomShortcutEvent): ZoomShortcutAction | null {
  if (e.type !== 'keydown' || e.repeat) return null
  if (e.altKey) return null
  const primary = e.metaKey || e.ctrlKey
  if (primary && !e.shiftKey && e.code === 'Digit0') return 'zoom-100'
  if (!primary && e.shiftKey && e.code === 'Digit1') return 'fit-all'
  return null
}

/**
 * PURE. Whether a zoom chord may act at all, given where the user is.
 *
 * Split out from `zoomShortcutAction` because the desktop ⌘0 arrives WITHOUT an event: Electron's
 * default View menu owns the accelerator, so `main/index.ts` intercepts it and forwards a bare
 * signal. That path has to ask the same two questions this one does.
 */
export function zoomShortcutAllowed(ctx: ZoomShortcutContext): boolean {
  // The board covers the canvas completely, so a camera move there is invisible AND persisted —
  // the user comes back to a canvas that jumped for no reason they saw. Same early-return
  // discipline as undo/redo, dictation and Delete (`isKanbanOpen`).
  if (ctx.boardOpen) return false
  // In a text surface these are ordinary keystrokes: Shift+1 types `!`, and ⌘0 belongs to the
  // editor/terminal. Stealing them would make the canvas jump mid-sentence.
  if (ctx.textFocus) return false
  return true
}

/** PURE. The action this keydown should run, or null to leave the key alone (no preventDefault). */
export function zoomShortcutAction(
  e: ZoomShortcutEvent,
  ctx: ZoomShortcutContext
): ZoomShortcutAction | null {
  const chord = zoomShortcutChord(e)
  if (chord === null) return null
  return zoomShortcutAllowed(ctx) ? chord : null
}

/** Text surfaces the canvas must never steal a printable chord from. Mirrors the ⌘C branch. */
const TEXT_SURFACE_SELECTOR = '.monaco-editor, .xterm'

/** PURE over the element: is `active` somewhere the user is typing? */
export function hasTextFocus(active: Element | null): boolean {
  if (!active) return false
  const tag = active.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if (active.getAttribute('contenteditable') === 'true') return true
  // xterm focuses its own helper <textarea> (caught above), but the terminal's other focusable
  // bits and Monaco's inner widgets are plain elements — ask the ancestor chain like ⌘C does.
  return !!active.closest(TEXT_SURFACE_SELECTOR)
}

/** The live shell state the refusals are decided against. */
export function liveZoomShortcutContext(): ZoomShortcutContext {
  return {
    boardOpen: isKanbanOpen(useProjects.getState().activeProjectId),
    textFocus: hasTextFocus(typeof document === 'undefined' ? null : document.activeElement)
  }
}

/**
 * `zoomShortcutAction` bound to the live board/focus state. The cheap key-shape test runs first so
 * an ordinary keystroke never reaches into the store or walks the DOM.
 */
export function liveZoomShortcutAction(e: ZoomShortcutEvent): ZoomShortcutAction | null {
  if (zoomShortcutChord(e) === null) return null
  return zoomShortcutAction(e, liveZoomShortcutContext())
}

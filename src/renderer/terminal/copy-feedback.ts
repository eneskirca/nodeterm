// What a terminal says right after a copy — and, once per installation, what to do when a drag
// produced nothing at all.
//
// Measured background (spec: docs/superpowers/specs/2026-08-09-terminal-copy-feedback-design.md):
// a codex pane leaves the mouse to tmux, so a drag is a copy-mode selection that `copy-pipe-and-
// cancel` copies via OSC 52 on RELEASE — clearing the highlight at the same instant, which reads
// as "the copy failed". A claude pane captures the mouse, so a plain drag produces nothing at all
// and only ⌥/Shift (xterm's own selection) works. Neither state had any on-screen evidence.
//
// This module is the decision alone: no DOM, no React, no storage. `useCopyFeedback` is the glue.

/** What the header pill is showing. */
export type CopyFeedback = { kind: 'copied' | 'hint'; label: string } | null

/** A click is not a drag. Same intent as `GUARD_CLICK_SLOP` in TerminalNode: a few pixels of
 *  travel between press and release is a hand, not an intent — and a plain click inside a
 *  mouse-capturing pane is the single most common interaction there, so it must stay silent. */
export const DRAG_MIN_PX = 8
/** How long after mouse-up an OSC 52 still counts as THIS drag's copy. tmux copies on release, so
 *  the sequence is always in flight at decision time. Sized for an SSH round-trip; a local tmux
 *  answers in well under 50 ms. */
export const OSC52_GRACE_MS = 600
export const COPIED_DWELL_MS = 1600
export const HINT_DWELL_MS = 5000
/** How long a clipboard-failure toast keeps the `copied` pill from being raised at all. It only has
 *  to cover a SYNCHRONOUS dispatch: over plain http the browser shim has no Clipboard API, so its
 *  execCommand fallback runs — and dispatches its error toast — inside `writeText`, i.e. before the
 *  OSC 52 handler calls `notifyCopy`. Retracting after the fact cannot catch that ordering. */
export const ERROR_TOAST_SUPPRESS_MS = 50
/** Once per installation, and personal rather than shared config — so it is a `localStorage` key,
 *  like `nodeterm.sessionsPinned` and `nodeterm.explorerExpanded`, not a setting in `settings.json`. */
export const HINT_STORAGE_KEY = 'nodeterm.seenSelectHint'

/**
 * The `copied` pill's label. Lines for multi-line text, characters for one line — the two numbers
 * a user checks when unsure the right thing was copied. ONE trailing newline is stripped before
 * BOTH counts (a copy-mode selection of a whole line, and every `vim "+y` of one line, carries it;
 * counting it as a character made the headline number off by one in the most common case). Text
 * with nothing left after that strip — `''` or a bare `'\n'` — yields null: nothing worth naming
 * was copied, so nothing is claimed.
 */
export function copiedLabel(text: string): string | null {
  const body = text.replace(/\n$/, '')
  if (!body) return null
  const lines = body.split('\n').length
  if (lines > 1) return `Copied ${lines} lines`
  return `Copied ${body.length} char${body.length === 1 ? '' : 's'}`
}

/**
 * The drag's ONLY possible contribution: the one-time hint, or nothing. The `copied` pill has a
 * different owner (the OSC 52 handler), so it is deliberately not returned here — one pill, one
 * owner, no race for the header slot.
 */
export function decideDragOutcome(input: {
  movedPx: number
  sawOsc52: boolean
  hasXtermSelection: boolean
  hintSeen: boolean
  isMac: boolean
}): { kind: 'hint'; label: string } | null {
  const { movedPx, sawOsc52, hasXtermSelection, hintSeen, isMac } = input
  if (movedPx < DRAG_MIN_PX) return null
  // A copy happened (tmux copy-mode) or the user already knows the modifier — nothing to teach.
  if (sawOsc52 || hasXtermSelection || hintSeen) return null
  return { kind: 'hint', label: `Hold ${isMac ? '⌥' : 'Shift'} to select text` }
}

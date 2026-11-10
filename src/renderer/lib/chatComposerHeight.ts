import { readLocal, writeLocal } from './localStore'

// The ⌘M composer's textarea height. Two modes:
// - AUTO (no stored height): the box grows with the draft, from its two-row minimum until the
//   composer (box and toolbar) fills half the INNER space, then scrolls.
// - SET (the user dragged the grip on the box's top edge): the box keeps that height whatever the
//   draft holds. A double-click on the grip goes back to auto.
// Either way the box never takes so much of the panel that the thread disappears.
//
// INNER space = the thread plus the composer: the panel minus its header bar (and the fallback note
// when there is one). The `/` and `@` menu opens above the composer, over the thread, and is sized
// against the same space so the two together never run past it (`completeMenuMax`).
//
// PERSONAL: one height for every composer, in localStorage (the view-state tier, like the canvas
// lock), never settings.json or the git-shared project file. Heights are LAYOUT pixels (unscaled by
// the canvas zoom).

export const CHAT_COMPOSER_HEIGHT_KEY = 'nodeterm.chatComposerHeight'

/** Share of the inner space the composer may grow to by itself, and the menu may take. */
export const INNER_SHARE = 0.5
/** Inner height kept for the thread however tall the box is set. */
export const THREAD_RESERVE_PX = 96
/** The completion menu's own ceiling (it was a fixed max-height before it followed the space). */
export const COMPLETE_MENU_MAX_PX = 240
/** How far the menu overlaps the composer's top edge (`.term-chat__complete`'s `bottom`). */
export const COMPLETE_MENU_OVERLAP_PX = 4
/** One step of the grip's arrow keys. */
export const KEYBOARD_STEP_PX = 24

/** A stored height: a positive whole number, else none (auto). */
export function parseComposerHeight(raw: string | null): number | null {
  if (raw === null || !/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

export function readComposerHeight(): number | null {
  return parseComposerHeight(readLocal(CHAT_COMPOSER_HEIGHT_KEY))
}

export function writeComposerHeight(height: number | null): void {
  writeLocal(CHAT_COMPOSER_HEIGHT_KEY, height === null ? '' : String(Math.round(height)))
}

export interface ComposerHeightInput {
  /** The textarea's height for its draft (its scrollHeight). */
  content: number
  /** The textarea's two-row height. */
  min: number
  /** The inner space (thread + composer); 0 or less while the panel has no box (a collapsed node). */
  inner: number
  /** The composer's height outside the textarea (toolbar, padding). */
  chrome: number
  /** The height the user set, or null for auto. */
  set: number | null
}

/** The textarea's height. */
export function composerHeight({ content, min, inner, chrome, set }: ComposerHeightInput): number {
  // No box to measure against: no upper bound, so the draft is not squeezed to nothing.
  const room = inner > 0 ? Math.max(min, inner - chrome - THREAD_RESERVE_PX) : Number.POSITIVE_INFINITY
  if (set !== null) return Math.round(Math.min(room, Math.max(min, set)))
  const autoMax = inner > 0 ? Math.max(min, inner * INNER_SHARE - chrome) : Number.POSITIVE_INFINITY
  return Math.round(Math.min(room, autoMax, Math.max(min, content)))
}

/**
 * The completion menu's max-height: its own ceiling, half the inner space, and never more than the
 * room above the composer — a box set taller than half would otherwise push the menu's top under the
 * panel's header. Null while the panel has no box (the stylesheet's ceiling applies).
 */
export function completeMenuMax({ inner, composer }: { inner: number; composer: number }): number | null {
  if (inner <= 0) return null
  const above = inner - composer + COMPLETE_MENU_OVERLAP_PX
  return Math.max(0, Math.floor(Math.min(COMPLETE_MENU_MAX_PX, inner * INNER_SHARE, above)))
}

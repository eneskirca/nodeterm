import { readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { renameAtomicSync, tempNameFor } from '../core/fs-atomic'

/**
 * Remember the main window's size, position and maximized state across launches.
 *
 * The window was created at a hard-coded 1400x900 on every launch, so a user who works maximized
 * re-maximized it every single time. Electron persists nothing on its own — there is no platform
 * that does this for us (macOS's NSWindow frame autosave is not wired up by Electron either), so
 * it is ours to store.
 *
 * Everything here is Electron-free on purpose, in the same shape as `keydown-intercept.ts`: the
 * decisions are pure functions over plain rectangles and the glue takes a structural window, so the
 * refusals below can be pressed by a test instead of only by a person with two monitors. The one
 * `electron` call this feature needs — `screen.getAllDisplays()` — is made at the call site in
 * `index.ts` and passed in as work areas.
 *
 * DESKTOP ONLY, and genuinely so: the Server Edition renders into a browser tab whose geometry is
 * the browser's business, and the mobile companion has no window concept. Nothing here belongs in
 * `src/core`.
 */

/** A plain rectangle — a `BrowserWindow` bounds object and an Electron display work area both fit. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  width: number
  height: number
  /** Absent when the position was never known, or was dropped as unreachable (see below). */
  x?: number
  y?: number
  maximized: boolean
}

export const WINDOW_STATE_FILE = 'window-state.json'

/** Floor for a restored size. A stored 1x1 is not a window the user can do anything with. */
export const MIN_WIDTH = 480
export const MIN_HEIGHT = 360

/**
 * How much of the window must land on some display's work area for the saved position to be
 * reusable. The height matters more than the width: a title bar the user cannot reach is a window
 * they cannot move, and on a stored position from a monitor that is now gone there is no gesture
 * left that rescues it.
 */
export const MIN_VISIBLE_WIDTH = 120
export const MIN_VISIBLE_HEIGHT = 80

/** The debounce on save. `resize`/`move` fire continuously through a drag. */
export const SAVE_DEBOUNCE_MS = 400

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Parse the stored file. `window-state.json` sits in userData, which is hand-editable, and its
 * numbers go straight into a `BrowserWindow` constructor — a NaN width there throws before the app
 * has a window to report the failure in. So every field is re-validated as a number here rather
 * than trusted from its type, the same rule the permission-mode table follows.
 *
 * A partial record is refused whole rather than half-adopted: the pair `x`/`y` is meaningless
 * alone, and a size without both dimensions is not a size.
 */
export function parseWindowState(raw: string): WindowState | null {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  const width = finite(o.width)
  const height = finite(o.height)
  if (width === null || height === null || width <= 0 || height <= 0) return null
  const x = finite(o.x)
  const y = finite(o.y)
  const state: WindowState = { width, height, maximized: o.maximized === true }
  if (x !== null && y !== null) {
    state.x = x
    state.y = y
  }
  return state
}

/** Visible overlap between a window rect and one display's work area. */
function reachableOn(r: Rect, area: Rect): boolean {
  const w = Math.min(r.x + r.width, area.x + area.width) - Math.max(r.x, area.x)
  const h = Math.min(r.y + r.height, area.y + area.height) - Math.max(r.y, area.y)
  return w >= MIN_VISIBLE_WIDTH && h >= MIN_VISIBLE_HEIGHT
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * Turn a saved record into the constructor options to open with.
 *
 * The rule that matters is the one about POSITION: a saved `x`/`y` is only reused when the window
 * would land somewhere the user can actually reach it. A laptop undocked from the monitor its
 * window was on would otherwise reopen off-screen, with the app running, focusable from the dock,
 * and not visible anywhere — and with no way back short of deleting the file. When the position
 * fails that test it is DROPPED rather than clamped into the nearest display: the size is still
 * the user's, and letting the platform place a window it knows how to place beats inventing a
 * corner for it.
 *
 * Size is clamped to the largest work area, so a record written on a 5K display does not open a
 * window taller than the laptop screen reading it. With no display information at all (an empty
 * list — not a state Electron produces, but the parameter permits it) only the floor applies:
 * inventing a ceiling from nothing would be a guess, and the floor is the half that protects
 * against a degenerate stored value.
 */
export function resolveWindowBounds(
  saved: WindowState | null,
  workAreas: ReadonlyArray<Rect>,
  defaults: { width: number; height: number }
): { bounds: { width: number; height: number; x?: number; y?: number }; maximize: boolean } {
  if (!saved) return { bounds: { ...defaults }, maximize: false }

  const widest = workAreas.reduce((m, a) => Math.max(m, a.width), 0)
  const tallest = workAreas.reduce((m, a) => Math.max(m, a.height), 0)
  const width = clamp(saved.width, MIN_WIDTH, widest > 0 ? Math.max(widest, MIN_WIDTH) : Infinity)
  const height = clamp(
    saved.height,
    MIN_HEIGHT,
    tallest > 0 ? Math.max(tallest, MIN_HEIGHT) : Infinity
  )

  const placed =
    saved.x !== undefined &&
    saved.y !== undefined &&
    workAreas.some((a) => reachableOn({ x: saved.x!, y: saved.y!, width, height }, a))

  return {
    bounds: placed ? { x: saved.x, y: saved.y, width, height } : { width, height },
    maximize: saved.maximized
  }
}

/** The window facts a capture needs. Structural so a test can supply a plain object. */
export interface WindowStateSource {
  isDestroyed(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  isMaximized(): boolean
  /** The RESTORED bounds — see the note in `captureWindowState`. */
  getNormalBounds(): Rect
}

/**
 * Read the current state, or `null` when the window cannot answer for it.
 *
 * Two refusals, and both of them protect the value the user actually set:
 *
 * - **Minimized.** A minimized window's geometry is the platform's business, not the user's
 *   choice, and on some window managers it is not the restored rectangle at all.
 * - **Fullscreen.** `isMaximized()` is FALSE while a macOS window is fullscreen, so capturing here
 *   would record `maximized: false` and quietly forget that the user works maximized — the exact
 *   complaint this feature exists to answer. Skipping keeps the last non-fullscreen state, which
 *   also means the app never reopens into fullscreen; that is deliberate, not an oversight. A
 *   fullscreen window is usually a temporary mode, and restoring one is much harder to escape from
 *   on first launch than restoring a maximized one.
 *
 * In both cases the previously saved record stands, which is the honest outcome: "we could not
 * observe a new preference", never "the preference is gone".
 *
 * The bounds come from `getNormalBounds()`, never `getBounds()`. While maximized the latter returns
 * the MAXIMIZED rectangle, so saving it would make the next un-maximize restore to a window the
 * size of the screen — the state would look right and behave wrong, and only for the users who
 * maximize.
 */
export function captureWindowState(win: WindowStateSource): WindowState | null {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return null
  const b = win.getNormalBounds()
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height) || b.width <= 0 || b.height <= 0) {
    return null
  }
  const state: WindowState = {
    width: Math.round(b.width),
    height: Math.round(b.height),
    maximized: win.isMaximized()
  }
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    state.x = Math.round(b.x)
    state.y = Math.round(b.y)
  }
  return state
}

/** Read the saved record. Any failure — missing, unreadable, corrupt — is "no record". */
export function readWindowState(userDataDir: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(path.join(userDataDir, WINDOW_STATE_FILE), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Publish the record. Synchronous because the last and most important write happens on `close`,
 * where an awaited one races the process exit and loses.
 *
 * Atomic through `renameAtomicSync` with a per-call unique temp, like every other store here — the
 * file is tiny and rewritten often, which is exactly the shape that loses data to a bare rename on
 * Windows (see docs/atomic-writes.md). Returns whether it landed; a caller cannot do anything
 * useful with a failure except not crash, so nothing throws out of here.
 */
export function writeWindowState(userDataDir: string, state: WindowState): boolean {
  const file = path.join(userDataDir, WINDOW_STATE_FILE)
  const tmp = tempNameFor(file)
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameAtomicSync(tmp, file)
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* already renamed into place */
    }
  }
}

/** The window events a tracker subscribes to. Structural, so a test needs no BrowserWindow. */
export interface TrackableWindow extends WindowStateSource {
  on(
    event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close',
    listener: () => void
  ): unknown
}

export interface TrackWindowStateOptions {
  /** Test seam; production uses `SAVE_DEBOUNCE_MS`. */
  debounceMs?: number
  /** Test seam for the timer pair. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Save the window's state as the user changes it, and once more as it closes.
 *
 * `close` is the load-bearing subscription: it is the only moment guaranteed to see the final
 * state, and it fires on every exit path — the native ×, ⌘Q, and the macOS hide-instead-of-close
 * branch, which preventDefaults the event but still emits it. The debounced saves during ordinary
 * use are what make a crash or a `SIGKILL` cost at most one gesture rather than the whole session.
 *
 * Returns a disposer that cancels a pending save. It does NOT unsubscribe: the listeners live as
 * long as the window does, and a window that is closing has already had its final `close` save.
 */
export function trackWindowState(
  win: TrackableWindow,
  save: (state: WindowState) => void,
  opts: TrackWindowStateOptions = {}
): () => void {
  const delay = opts.debounceMs ?? SAVE_DEBOUNCE_MS
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms)
      // A pending save must never be the reason the process is still alive at quit.
      ;(t as { unref?: () => void }).unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((h: unknown): void => clearTimeout(h as NodeJS.Timeout))

  let pending: unknown = null
  const cancel = (): void => {
    if (pending !== null) {
      clearTimer(pending)
      pending = null
    }
  }
  const flush = (): void => {
    cancel()
    const state = captureWindowState(win)
    if (state) save(state)
  }
  const schedule = (): void => {
    cancel()
    pending = setTimer(flush, delay)
  }

  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(event, schedule)
  win.on('close', flush)
  return cancel
}

/**
 * Per-terminal font size from the keyboard (issue #915): ⌘+ / ⌘− grow and shrink the FOCUSED
 * terminal's font, ⌘0 puts it back on the global size — what every terminal emulator (iTerm2,
 * Terminal.app, Windows Terminal, VS Code's integrated terminal) means by those keys.
 *
 * **Opt-in** (`settings.terminalFontZoomKeys`, Settings → Terminal, default OFF), and only ever
 * while a terminal has keyboard focus. With it off — or outside a terminal — every key here keeps
 * doing exactly what it did before: ⌘0 zooms the canvas to 100% (`lib/zoomShortcut.ts`), ⌘+ / ⌘−
 * reach whatever has focus. Opt-in rather than default because off-mac the chord is Ctrl+− /
 * Ctrl+=, and Ctrl+− is a real shell key (readline's `undo`, ^_) that a focused terminal passes to
 * the pty today; taking it away from existing users uninvited is the #383 mistake again.
 *
 * **The override lives on the NODE** (`data.terminalFontSize`, persisted in project.json like any
 * other node field) and is layered over the global size in ONE place — `useXtermVisualSettings`'s
 * optional override, via `withTerminalFontSize` below — so the canvas TerminalNode and the kanban
 * card modal's second view of the SAME session read one value through one options path
 * (`applyLiveOptions`) and cannot drift. The settings preview passes no override, so it keeps
 * showing the global size being edited.
 *
 * Font size is CELL GEOMETRY: a change reports `metricsChanged` from `applyLiveOptions`, and both
 * surfaces already route that through their re-fit + pty resize, exactly like a live global
 * font-size edit — so the pty is told the new cols/rows with no new code on that path. Canvas zoom
 * is untouched by all of this: it is a CSS transform over the node, independent of the font.
 *
 * ONE WRITER. Every entry point (the canvas terminal's xterm key handler, the card modal's, and the
 * desktop ⌘0 that main forwards without an event) asks Canvas to apply the step through
 * `requestTerminalFontZoom`, so the read-modify-write of node data, `markDirty` and the clamp all
 * happen in one handler instead of three.
 */

/** The same range the Settings → Terminal font-size field advertises (its min/max). */
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 28

export type TerminalFontZoomAction = 'increase' | 'decrease' | 'reset'

/** The subset of `KeyboardEvent` the chord is decided from (so tests need no DOM). */
export interface TerminalFontZoomEvent {
  type: string
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/**
 * PURE, key-shape only.
 *
 * - **Primary modifier per platform, exactly one of them**: ⌘ on macOS, Ctrl elsewhere. Unlike the
 *   canvas zoom chord (which accepts either everywhere), this one fires while the user is TYPING in
 *   a shell, and on macOS Ctrl+− / Ctrl+= are terminal keys (^_ is readline's undo) that must keep
 *   reaching the pty.
 * - **+ and − match on the CHARACTER** (`e.key`), with the numpad codes as a fallback: the key a
 *   user presses for "bigger" is the one labelled +, which on a German layout is its own key
 *   (`BracketRight`) and on US is ⇧= — so Shift is not constrained for these two.
 * - **0 matches on the physical key** (`e.code`), like the canvas ⌘0 and main's intercept, so the
 *   two agree about which key is "0" on AZERTY; ⌘⇧0 is a different chord. Keypad 0 counts only
 *   when it types a zero (Num Lock on), because with Num Lock off it is Insert — a copy chord.
 * - Alt is refused (AltGr reports as ctrl+alt off-mac and must keep typing its character).
 * - Auto-repeat is ACCEPTED: nothing here animates, and holding ⌘+ to keep growing is expected.
 */
export function terminalFontZoomChord(
  e: TerminalFontZoomEvent,
  isMac: boolean
): TerminalFontZoomAction | null {
  if (e.type !== 'keydown' || e.altKey) return null
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) return null
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 'increase'
  if (e.key === '-' || e.code === 'NumpadSubtract') return 'decrease'
  // Keypad 0 only as a real zero: with Num Lock OFF it reports `key: 'Insert'`, and Ctrl+Insert is
  // the Windows/Linux COPY chord (`isCopyShortcut`) — claiming it here cleared the font instead of
  // copying (review round 2 of #915). The digit row stays positional, like the canvas ⌘0.
  if (!e.shiftKey && (e.code === 'Digit0' || (e.code === 'Numpad0' && e.key === '0'))) return 'reset'
  return null
}

export interface TerminalFontZoomContext {
  /** `settings.terminalFontZoomKeys`. */
  enabled: boolean
  isMac: boolean
}

/** PURE. The action a keydown in a focused terminal should run, or null to leave the key alone. */
export function terminalFontZoomAction(
  e: TerminalFontZoomEvent,
  ctx: TerminalFontZoomContext
): TerminalFontZoomAction | null {
  if (!ctx.enabled) return null
  return terminalFontZoomChord(e, ctx.isMac)
}

/**
 * PURE. A stored override as a usable size, or `undefined`. The value comes out of a git-shared,
 * hand-editable project.json (and off a team-sync peer), so anything that is not a finite number
 * inside the Settings range is treated as "no override" rather than handed to xterm.
 */
export function normalizeTerminalFontSize(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  if (v < TERMINAL_FONT_SIZE_MIN || v > TERMINAL_FONT_SIZE_MAX) return undefined
  return v
}

/** PURE. The size a terminal renders at: its own override, else the global setting. */
export function effectiveTerminalFontSize(global: number, override: unknown): number {
  return normalizeTerminalFontSize(override) ?? global
}

/**
 * PURE. The node's NEW override after `action` (`undefined` = no override, follow the global).
 *
 * - Steps by 1 from the EFFECTIVE size.
 * - Landing back on the global size clears the override instead of storing a copy of it, so a node
 *   the user nudged up and back down follows later global changes again.
 * - The result is clamped to the Settings range, but the clamp may only move the size in the
 *   direction asked for: at a bound the step is a no-op (the current override comes back
 *   unchanged), and ⌘+ can never SHRINK a terminal whose global size was hand-edited above the
 *   maximum (⌘− there lands it on the maximum).
 * - `reset` always clears.
 */
export function nextTerminalFontSizeOverride(
  action: TerminalFontZoomAction,
  override: unknown,
  global: number
): number | undefined {
  const current = normalizeTerminalFontSize(override)
  if (action === 'reset') return undefined
  const base = current ?? global
  const grow = action === 'increase'
  const target = Math.min(
    TERMINAL_FONT_SIZE_MAX,
    Math.max(TERMINAL_FONT_SIZE_MIN, base + (grow ? 1 : -1))
  )
  // The clamp may only ever move the size in the direction asked for; otherwise it is a no-op.
  if (grow ? target <= base : target >= base) return current
  return target === global ? undefined : target
}

/**
 * PURE. The one-line notice a font-size step earns, or null when there is nothing to say (a reset
 * that changes nothing). A step that the clamp refuses is the case this exists for: before it, ⌘+ at
 * the maximum did nothing at all, which read as a broken chord.
 */
export function fontZoomNoticeText(
  action: TerminalFontZoomAction,
  prev: number | undefined,
  next: number | undefined,
  global: number
): string | null {
  const now = next ?? global
  if (action === 'reset') {
    return prev === undefined ? null : `Terminal font size reset to default (${now})`
  }
  if (next === prev) {
    const before = prev ?? global
    if (action === 'increase' && before >= TERMINAL_FONT_SIZE_MAX) {
      return `Terminal font size ${before} (maximum)`
    }
    if (action === 'decrease' && before <= TERMINAL_FONT_SIZE_MIN) {
      return `Terminal font size ${before} (minimum)`
    }
    return null
  }
  return `Terminal font size ${now}`
}

/**
 * PURE. `visual` with the node's override applied — returned BY IDENTITY when there is nothing to
 * override, because the result is the dependency the terminals' live re-option effects hang off
 * (same rule as `mergeProjectVisuals`).
 */
export function withTerminalFontSize<T extends { fontSize: number }>(visual: T, override: unknown): T {
  const size = effectiveTerminalFontSize(visual.fontSize, override)
  return size === visual.fontSize ? visual : { ...visual, fontSize: size }
}

/**
 * PURE. Is a FORWARDED desktop ⌘/Ctrl+0 the terminal-font reset chord? Main claims `Digit0` with
 * `meta || control` (either, or both) for canvas zoom-to-100%, so it forwards the modifiers and this
 * applies `terminalFontZoomChord`'s own primary rule to them — exactly ⌘ on macOS, exactly Ctrl
 * elsewhere. Without it a mac Ctrl+0 cleared the override on the desktop while the browser path
 * (`terminalFontZoomChord`) refused it. Absent modifiers are "not a reset": the caller falls back
 * to the pre-#915 behaviour.
 */
export function forwardedResetMatches(
  mods: { meta: boolean; control: boolean } | undefined,
  isMac: boolean
): boolean {
  if (!mods) return false
  return isMac ? mods.meta && !mods.control : mods.control && !mods.meta
}

/**
 * PURE. Does this terminal's effective font size leave the SHARED glyph atlas? The shared renderer
 * (`terminalGpuRendering: 'shared'`, canvas/SharedGlyphLayer.tsx) rasterizes ONE atlas for the
 * GLOBAL font and fixes its cell geometry for the context's lifetime; a grid cannot change its cell
 * after `register`. A node rendering at its own size therefore cannot draw there at all — it is
 * held off the shared canvas and paints its own pixels (the same "must be opaque" path a stacked or
 * dragged node takes), and rejoins once the override is cleared.
 */
export function leavesSharedGlyphAtlas(effectiveFontSize: number, globalFontSize: number): boolean {
  return effectiveFontSize !== globalFontSize
}

/**
 * PURE. `nodes` with one node's stored `terminalFontSize` replaced — the SAME array when the node is
 * absent or already holds that value, so a no-op step costs no store update. Used to mirror a step
 * into the projects store for the ACTIVE project: the Omni (all-projects) board derives its card
 * modal's `spawn` from the store, which otherwise only catches up on the next autosave commit
 * (~800 ms, or never while a workspace conflict suspends autosave). The mirror is idempotent with
 * that commit, which serializes the same value from the live canvas.
 */
export function patchStoredFontSize<T extends { id: string; terminalFontSize?: number }>(
  nodes: T[],
  nodeId: string,
  next: number | undefined
): T[] {
  const i = nodes.findIndex((n) => n.id === nodeId)
  if (i < 0 || nodes[i].terminalFontSize === next) return nodes
  const out = nodes.slice()
  out[i] = { ...nodes[i], terminalFontSize: next }
  return out
}

/**
 * PURE: `patchStoredFontSize` lifted to the projects list — only `projectId` is touched, and a
 * no-op step (node missing, value unchanged, project unknown) returns the SAME array, so the
 * store's `setState` sees no change and notifies nobody (review: a fresh `projects.map` on every
 * clamped or repeated step re-rendered the Omni board for nothing).
 */
export function patchProjectFontSize<
  N extends { id: string; terminalFontSize?: number },
  P extends { id: string; nodes: N[] }
>(projects: P[], projectId: string, nodeId: string, next: number | undefined): P[] {
  const i = projects.findIndex((p) => p.id === projectId)
  if (i < 0) return projects
  const nodes = patchStoredFontSize(projects[i].nodes, nodeId, next)
  if (nodes === projects[i].nodes) return projects
  const out = projects.slice()
  out[i] = { ...projects[i], nodes }
  return out
}

/** Stamped on each terminal's xterm host (canvas node and card modal) with the node id. */
export const FONT_ZOOM_NODE_ATTR = 'data-font-zoom-node'

/**
 * PURE over the element: the node id of the terminal `active` sits in, or null. The desktop ⌘0
 * reaches Canvas WITHOUT an event (main's `before-input-event` claims it — see
 * `main/keydown-intercept.ts`), so "which terminal?" has to be answered from the focus.
 */
export function fontZoomTargetNodeId(active: Element | null): string | null {
  if (!active) return null
  return active.closest(`[${FONT_ZOOM_NODE_ATTR}]`)?.getAttribute(FONT_ZOOM_NODE_ATTR) ?? null
}

/** The window event Canvas applies (the single writer, see the header). */
export const TERMINAL_FONT_ZOOM_EVENT = 'nodeterm:terminal-font-zoom'

export interface TerminalFontZoomRequest {
  nodeId: string
  action: TerminalFontZoomAction
}

/** Ask Canvas to step `nodeId`'s font. Same no-direct-line-to-the-canvas pattern as open-file. */
export function requestTerminalFontZoom(nodeId: string, action: TerminalFontZoomAction): void {
  window.dispatchEvent(
    new CustomEvent<TerminalFontZoomRequest>(TERMINAL_FONT_ZOOM_EVENT, { detail: { nodeId, action } })
  )
}

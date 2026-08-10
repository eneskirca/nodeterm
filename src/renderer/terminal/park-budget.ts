/**
 * Count cap for parked terminals (see TerminalNode's parkedTerminals). The park window
 * (TERM_PARK_MS) bounds each entry in TIME but nothing bounded the COUNT: switching through N
 * projects inside the window parked every terminal of each — each holding a full xterm buffer
 * with a live PTY subscription. Evicting the oldest park is invisible to the user: a disposed
 * park just means the next remount is a warm tmux reattach (tmux redraws), the same path every
 * remount after the 5-minute window already takes.
 *
 * 12 ≈ one busy project's worth of terminals; the same order of magnitude as WEBGL_BUDGET.
 */
export const PARK_MAX = 12

/** Keys to dispose so the park stays within `max`, oldest first. Caller passes keys in park
 *  order (Map insertion order — TerminalNode always deletes before re-inserting on re-park). */
export function planParkEviction(keysInParkOrder: string[], max: number): string[] {
  if (keysInParkOrder.length <= max) return []
  return keysInParkOrder.slice(0, keysInParkOrder.length - max)
}

/**
 * Scrollback bounds for every xterm-shaped buffer this app holds: the renderer's xterm AND the
 * Windows session host's `@xterm/headless` emulator (plus the main-process `NativeWindowsPane`
 * mirror). One module so the two ends of a session-host attach cannot disagree: anything the host
 * keeps above the renderer's cap is serialized, shipped and then thrown away on every warm attach.
 *
 * tmux's own `history-limit` is NOT bounded here — it keeps the raw `settings.tmuxScrollback`.
 * tmux stores only the cells a line actually uses, in C; xterm allocates `cols × 12 B` for EVERY
 * buffered line (`BufferLine` = `Uint32Array(cols * 3)`), so 50,000 lines at 120 cols is ~72 MB per
 * session in xterm and a few MB in tmux. See docs/windows-session-host.md ("Memory bound").
 */

/** Hard cap on an xterm buffer's scrollback: the cost is per node and one canvas holds many. */
export const XTERM_SCROLLBACK_MAX = 10000

/**
 * Floor, mirroring the tmux conf's own `history-limit ${Math.max(1000, scrollback)}`, so the two
 * buffers never disagree at the low end.
 */
export const XTERM_SCROLLBACK_MIN = 1000

/**
 * How many scrollback lines an xterm buffer keeps for a given `settings.tmuxScrollback`: floored
 * and capped. The renderer's xterm and the session host's emulator both use this, so the host
 * never holds history the renderer could not show.
 */
export function xtermScrollback(tmuxScrollback: number): number {
  return Math.min(Math.max(XTERM_SCROLLBACK_MIN, tmuxScrollback), XTERM_SCROLLBACK_MAX)
}

/**
 * The emulator-side bound, applied INSIDE the session host (and `TerminalEmulator`) to whatever a
 * client asked for — an older client still sends the raw 50,000. Deliberately no floor: the
 * protocol-v1 warm-only sentinel sends `1`, and a host must not reinterpret a request it did not
 * get. A non-finite value (hand-built frame) falls to the cap rather than reaching xterm as NaN.
 */
export function clampEmulatorScrollback(scrollback: number): number {
  if (!Number.isFinite(scrollback)) return XTERM_SCROLLBACK_MAX
  return Math.min(Math.max(0, Math.floor(scrollback)), XTERM_SCROLLBACK_MAX)
}

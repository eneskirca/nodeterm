/**
 * IDLE REAP: give pty devices back to the OS without killing anybody's work.
 *
 * macOS caps pty devices system-wide (`kern.tty.ptmx_max`, 511 by default) and on 2026-08-11 this
 * app was a large part of a machine that hit it: 62 live PTYs in PtyManager, 18 tmux sessions, ~19
 * ssh children. Every terminal after that spawned black (see pty-devices.ts, which now says so).
 *
 * The normal release paths — the last subscriber's `pty:kill`, `dropClient` when a window/tab
 * vanishes, the renderer's 5-minute park expiry — already return the pty client for anything the
 * user actually closed. This sweep is the SAFETY NET underneath them: every one of those paths is a
 * hook that has to be wired (window 'closed', 'render-process-gone', the relay's socket teardown,
 * the peer registry's gone-hook), and a hook that is missed leaves a session subscribed to a client
 * that no longer exists — holding a pty device, a tmux client and an ssh child, for the life of the
 * process, with nothing left that could ever detach it.
 *
 * WHAT IT MAY TOUCH, and why each half of the rule is load-bearing:
 *  - TMUX-BACKED only (local `nt-<id>` or the remote tmux an SSH project attaches to). The tmux
 *    session, its processes and its scrollback all live SERVER-side and survive the client
 *    detaching; the next `pty:create` re-attaches with `new-session -A` and the user sees their
 *    work redrawn. A session with no tmux underneath — an ssh-direct terminal, or any shell spawned
 *    with tmux off — has no such copy: releasing its pty client ends the shell and everything in
 *    it. That is data loss, so it is never reaped.
 *  - UNWATCHED only: no subscriber whose client is still attached, and no relay sink. A sink is a
 *    watcher (somebody's phone is mirroring the session), and a parked terminal is still a
 *    subscriber — the renderer holds its subscription for the whole park window precisely so a
 *    remount is instant.
 * And it NEVER kills a tmux session. Sessions in closed projects run forever by design; the reclaim
 * path for those is the user's own "Recently closed → delete", not a timer.
 */

/**
 * How long a session must have been unwatched before its client pty is released.
 *
 * Comfortably longer than the renderer's park window (`TERM_PARK_MS`, 5 minutes in
 * renderer/nodes/TerminalNode.tsx), and deliberately not just longer: a parked terminal keeps its
 * subscription, so the sweep already skips it on the `watched` test — the margin is so that the two
 * mechanisms cannot come to depend on each other's timing. Ten minutes with nobody attached is also
 * far past any human "I'll be right back": the cost of reaping is one tmux redraw on return, the
 * cost of not reaping is a pty device held forever.
 */
export const REAP_IDLE_MS = 10 * 60 * 1000

/**
 * How often the sweep runs. A minute is fine granularity against a ten-minute threshold and costs a
 * walk of a map with tens of entries — nothing is spawned, and a session that IS watched is decided
 * by a set lookup.
 */
export const REAP_SWEEP_MS = 60_000

/** One session as the reap decision sees it. */
export interface ReapCandidate {
  /** A tmux session (local or remote) is holding this work, so the client pty is expendable. */
  tmuxBacked: boolean
  /** Any subscriber whose client is still attached, or a relay sink. */
  watched: boolean
  /** When the sweep first saw it with no watcher; `null` = never (it has always had one). */
  unwatchedSince: number | null
}

/** Pure: may this session's client pty be released now? */
export function shouldReap(c: ReapCandidate, now: number, idleMs = REAP_IDLE_MS): boolean {
  if (!c.tmuxBacked || c.watched || c.unwatchedSince === null) return false
  return now - c.unwatchedSince >= idleMs
}

// A live link watcher's OWN tmux client — the one it spawns when no Session is held for the node
// (after an app restart, for a closed project, for a released node). Pure: argv builders and parsers.
//
// The owner's spelling for a client, `new-session -A`, is wrong here in three ways, each measured on
// tmux 3.4 (watcher-client.realtty.test.ts):
//  - SIZE. Under tmux's default `window-size latest` the newest client sets the window size: a watcher
//    at 40x10 shrank the owner's 120x39 window to 40x9 — a SIGWINCH to the agent running there, because
//    somebody opened a link. With `-f ignore-size` the window stayed at 120x39 and the owner's client as
//    it was — BUT only because the owner was attached: tmux 3.4 honours `ignore-size` only while at least
//    one client WITHOUT the flag is attached to some session on the same server. A watcher that is the
//    only client sizes the window like any other (measured: spawned at 40x10 alone → window 40x10; spawned
//    at 120x40, an owner joins at 200x50 and leaves → the window snaps back to 120x40). So the client is
//    spawned at the window's CURRENT size, read just before the spawn, and refused when that read fails
//    (`PtyManager.spawnNew`); `PtyManager.syncWatcherClientSize` keeps it at the window's size while the
//    link has viewers. Residual: drift for up to one sync interval, and a read racing an owner's resize
//    or departure (the window then keeps the size read a moment before).
//  - ENVIRONMENT. Attaching runs `update-environment`, which copies every listed name from the attaching
//    client's env into the session and STRIPS the ones that client lacks — the account scope
//    (CLAUDE_CONFIG_DIR, …, CLAUDE.md #419) included. `-E` skips it; the session env is untouched.
//  - CREATION. `new-session -A` creates when the session is gone, so a session that died between the
//    strict existence verdict and the spawn would be re-created bare, by a viewer. `attach-session`
//    never creates: it exits 1 ("can't find session") and nothing appears.
// `read-only` is a belt: nothing is ever written into a watcher's pty, and if something were, tmux
// drops input from a read-only client.
//
// The target is exact, `=nt-<id>:` (a bare name prefix-matches another node's session; measured, see
// capture-route.ts). For attach-session both `=name` and `=name:` are exact; `=name:` is kept so every
// watch-link target is spelled one way.
//
// Client flags (`-f`) need tmux 3.2. Locally the version is probed (`supportsWatcherClient`) and an
// older or unreadable one refuses the watcher; over SSH the remote tmux rejects the flags itself.
import { exactPaneTarget } from './capture-route'

export const WATCHER_CLIENT_FLAGS = 'ignore-size,read-only'

/** The local tmux argv (after the binary) for a watcher's own client. */
export function localWatcherAttachArgs(socket: string, sessionName: string): string[] {
  return ['-L', socket, 'attach-session', '-E', '-f', WATCHER_CLIENT_FLAGS, '-t', exactPaneTarget(sessionName)]
}

/**
 * What a watcher's client must be sized to so it leaves the window exactly where it is: the window's
 * width and height, plus the status lines tmux draws under it on that session (`#{status}`: `off`,
 * `on` = 1, or `2`–`5`). With the production conf (`set -g status off`) that is the window size itself;
 * a host whose server runs tmux's defaults (status on — a remote conf that was never sourced) would
 * otherwise lose one row to the status line every time the watcher, as the only client, set the size.
 */
export const WINDOW_SIZE_FORMAT = '#{window_width} #{window_height} #{status}'

export function localWindowSizeArgs(socket: string, sessionName: string): string[] {
  return ['-L', socket, 'display-message', '-p', '-t', exactPaneTarget(sessionName), WINDOW_SIZE_FORMAT]
}

/** `"<width> <height> <status>"` → the client size for that window (see `WINDOW_SIZE_FORMAT`), both
 *  positive. An exact-target miss answers exit 0 with every format EMPTY, so anything else is no size,
 *  never 0x0; an unknown status value is no size too. */
export function parseWindowSize(stdout: string): { cols: number; rows: number } | undefined {
  const m = /^(\d+) (\d+) (off|on|[0-5])$/.exec(stdout.replace(/\r?\n$/, ''))
  if (!m) return undefined
  const cols = Number(m[1])
  const height = Number(m[2])
  const statusLines = m[3] === 'off' ? 0 : m[3] === 'on' ? 1 : Number(m[3])
  return cols > 0 && height > 0 ? { cols, rows: height + statusLines } : undefined
}

export interface TmuxVersion {
  major: number
  minor: number
}

/** `tmux -V` → `{major, minor}`: `tmux 3.4`, `tmux 3.2a`, `tmux next-3.6`. null when unreadable
 *  (`tmux master`, a failed probe). */
export function parseTmuxVersion(stdout: string): TmuxVersion | null {
  const m = /(\d+)\.(\d+)/.exec(stdout)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

/** Client flags (`attach-session -f`) first shipped in tmux 3.2. An unknown version fails closed. */
export function supportsWatcherClient(v: TmuxVersion | null): boolean {
  return !!v && (v.major > 3 || (v.major === 3 && v.minor >= 2))
}

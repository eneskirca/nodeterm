// A live link's KEYFRAME: the visible screen of a node's session, never the history above it.
//
// Pure: no tmux, no ssh, no PtyManager. `PtyManager.captureVisible` runs the argv built here (locally,
// or over the ControlMaster through `remoteCaptureVisibleArgs`) and parses the reply here.
//
// Which backend gets one (`visibleCaptureRoute`): the session host's capture is ~200 lines of
// scrollback and a direct Windows pane has no visible-only read, so both get NO keyframe (the viewer
// starts from the live stream) rather than history. A plain shell has no tmux to ask, and neither has
// a Zellij session (the optional local backend, zellij-backend.ts).
//
// The screen and the cursor are read in ONE tmux invocation (`capture-pane … ; display-message …`), so
// both describe the same instant: a cursor read in a second round trip could describe a screen that has
// since scrolled.
//
// The target is EXACT (`exactPaneTarget`). Node ids end in a counter, so `nt-x-1` is a prefix of
// `nt-x-12`, and tmux resolves a bare target by fnmatch then PREFIX on a miss: a bare target would
// capture ANOTHER node's screen and send it to this link's viewers. Measured on tmux 3.4, with only
// `nt-x-12` alive:
//   capture-pane -t nt-x-1     → 12's screen, exit 0          (the trap)
//   capture-pane -t =nt-x-1    → "can't find pane", exit 1    (also for =nt-x-12: `=name` alone never
//                                                             resolves a target-PANE)
//   capture-pane -t =nt-x-1:   → "can't find session", exit 1
//   capture-pane -t =nt-x-12:  → 12's screen, exit 0          (exact AND resolves)
//   display-message -t =nt-x-1: → exit 0, every format EMPTY
// and the combined `capture-pane -t =nt-x-1: ; display-message …` stops at the failed capture: exit 1,
// nothing on stdout. So an exact miss is a failed command, which the caller reads as unavailable.

/**
 * What a visible-only capture returns: the screen and the cursor, read at one instant.
 *
 * Deliberately NO alternate-screen flag (controller ruling R18). A keyframe's `altScreen` is decided
 * by the CALLER from the join (a tmux-backed client ⇒ `true`), not from the capture: a watcher
 * co-attaches to the tmux CLIENT's output, and tmux paints its client on the alternate screen
 * whatever the pane's application does, so every `tmux`/`ssh`-route join means `altScreen: true`.
 * The pane's own `#{alternate_on}` (vim, a TUI) describes a different screen — a shell pane reads 0
 * while the stream is on the alternate screen — and mapping it into the keyframe would scroll every
 * tmux redraw into the viewer's history.
 */
export interface VisibleCapture {
  /** The visible screen with SGR, byte-identical to what `capture-pane -p -e` prints on its own
   *  (one `\n`-terminated line per row); '' when there is none. Never history. */
  screen: string
  /** The pane's cursor at capture time, 0-based (`#{cursor_x}`, `#{cursor_y}`); null when unread. */
  cursor: { x: number; y: number } | null
  /**
   * There is NO capture: the backend has no visible-only one, or the capture failed. Set only by
   * `unavailableCapture()`; a real capture of an empty pane never carries it. The difference matters
   * (controller ruling R36): a viewer paints a keyframe as reset + clear, so an empty keyframe sent for
   * "no capture" would erase everything the stream had drawn. The link host sends no keyframe for it.
   */
  unavailable?: true
}

/** A session with no visible-only capture, or one that failed: nothing to paint, nothing known. */
export function unavailableCapture(): VisibleCapture {
  return { screen: '', cursor: null, unavailable: true }
}

export function visibleCaptureRoute(
  s: { sessionHost?: unknown; nativeWindowsPane?: unknown; sshRemote?: unknown; tmuxBacked?: boolean; zellij?: boolean },
  tmuxAvailable: boolean
): 'none' | 'ssh' | 'tmux' {
  // A Zellij session is `tmuxBacked` too (that field means "releasing a client destroys nothing"),
  // but there is no tmux session to capture: never aim the tmux socket at it (pty-manager's rule
  // for every path that would talk to tmux). No keyframe — the viewer starts from the live stream.
  if (s.sessionHost || s.nativeWindowsPane || s.zellij) return 'none'
  if (s.sshRemote) return 'ssh'
  return tmuxAvailable && s.tmuxBacked ? 'tmux' : 'none'
}

/** The tmux format read beside the screen: cursor column and cursor row, 0-based. */
export const VISIBLE_CAPTURE_FORMAT = '#{cursor_x} #{cursor_y}'

/** "Exactly this session, its active pane" — the only spelling that is exact AND resolves for a
 *  target-pane command (see the measurement at the top of this file). */
export function exactPaneTarget(sessionName: string): string {
  return `=${sessionName}:`
}

/**
 * The local tmux argv (after the binary): visible screen with SGR, then the cursor line, in one
 * invocation. The `;` is tmux's own command separator, passed as its own argv element (no shell).
 * No `-S`: capture-pane without it starts at the first VISIBLE row.
 */
export function localCaptureVisibleArgs(socket: string, sessionName: string): string[] {
  const target = exactPaneTarget(sessionName)
  return [
    '-L',
    socket,
    'capture-pane',
    '-p',
    '-e',
    '-t',
    target,
    ';',
    'display-message',
    '-p',
    '-t',
    target,
    VISIBLE_CAPTURE_FORMAT
  ]
}

const CURSOR_LINE = /^(\d+) (\d+)$/

/**
 * Split the combined reply: the LAST line is the cursor line when it has exactly the format's shape,
 * and everything before it is the screen. Anything else (no such line, an older tmux that printed
 * something different) leaves the whole output as the screen and the cursor unknown.
 */
export function parseVisibleCapture(stdout: string): VisibleCapture {
  const body = stdout.replace(/\r?\n$/, '')
  const cut = body.lastIndexOf('\n')
  const last = cut === -1 ? body : body.slice(cut + 1)
  const m = CURSOR_LINE.exec(last)
  if (!m) return { screen: stdout, cursor: null }
  return {
    screen: cut === -1 ? '' : body.slice(0, cut + 1),
    cursor: { x: Number(m[1]), y: Number(m[2]) }
  }
}

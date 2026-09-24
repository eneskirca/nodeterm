/**
 * Is this pty write an automatic TERMINAL REPORT rather than something a person did?
 *
 * The session-host backend sizes a shared session to its most recently ACTIVE viewer (tmux's
 * `window-size latest`, see `latestClaimSize` in pty-size.ts), and typing is one of the things that
 * makes a viewer active. But xterm.js also writes to the pty on its own: when the app in the pane
 * asks a question (device attributes, cursor position, a colour, a mode), EVERY attached emulator
 * answers it. Counting those answers as activity would hand the session to whichever viewer happened
 * to answer last — and an app that re-queries after SIGWINCH could then flip the size back and forth
 * between viewers forever. tmux never has this problem because tmux itself answers those queries,
 * not its clients.
 *
 * The match is on the WHOLE write: a chunk that is nothing but reports is a report; anything else
 * (a keystroke, a paste, a mouse event) is activity. Deliberately conservative in one direction
 * only: an ambiguous sequence that looks like a report (CSI 1;2R is both a cursor-position report
 * and Shift+F3 on some keyboards) is treated as a report, because missing one activity bump costs
 * nothing — the next keystroke bumps — while a false bump can move the whole session's size.
 */
const REPORT = new RegExp(
  '^(?:' +
    [
      // Device attributes (primary / secondary / tertiary): CSI ? … c, CSI > … c, CSI = … c
      '\\x1b\\[[?>=][0-9;]*c',
      // Cursor position (CPR / DECXCPR): CSI r ; c R, CSI ? r ; c R
      '\\x1b\\[\\??[0-9]+;[0-9]+(?:;[0-9]+)?R',
      // Device status: CSI n n (e.g. CSI 0 n)
      '\\x1b\\[\\??[0-9]+n',
      // Mode reports (DECRPM): CSI [?] Pa ; Ps $ y
      '\\x1b\\[\\??[0-9;]*\\$y',
      // Focus in / out
      '\\x1b\\[[IO]',
      // Window / cell size reports: CSI 4|6|8 ; h ; w t
      '\\x1b\\[[0-9]+;[0-9]+;[0-9]+t',
      // Kitty keyboard flags report: CSI ? flags u (a key event has no `?`)
      '\\x1b\\[\\?[0-9]*u',
      // OSC replies (colour queries etc.), BEL- or ST-terminated
      '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
      // DCS replies (DECRQSS, XTGETTCAP), ST-terminated
      '\\x1bP[^\\x1b]*\\x1b\\\\'
    ].join('|') +
    ')+$'
)

export function isTerminalReport(data: string): boolean {
  return data.length > 0 && REPORT.test(data)
}

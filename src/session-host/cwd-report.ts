// The session host's answer to tmux's `#{pane_current_path}`: the working directory the pane's own
// shell (or agent CLI) REPORTED in its output, parsed from the three escape sequences that carry one.
//
//   OSC 7 ; file://<host>/<percent-encoded path> ST     — the de-facto standard (VTE, iTerm2, WezTerm,
//                                                         fish/zsh integrations, many agent CLIs)
//   OSC 9 ; 9 ; "<path>" ST                              — ConEmu / Windows Terminal's convention
//   OSC 633 ; P ; Cwd=<escaped path> ST                  — VS Code shell integration
//
// ST is BEL or ESC \. Pure, no Node imports: the host bundle and the unit tests share it.
//
// Why a reported cwd and not the process's: Windows has no portable way to read another process's
// current directory (it lives in the target's PEB), and a pty's foreground process is not tracked by
// the host the way a tmux pane's is. A shell that reports nothing leaves the answer null — the caller
// already tried the node's LAUNCH cwd first, so null degrades to exactly the pre-feature behavior.
// The spawn cwd is deliberately never used as a fallback answer for the same reason.

const OSC_START = '\x1b]'
/** Longest unterminated OSC carried to the next chunk. A real cwd report is a path plus a few bytes;
 *  anything longer is some other OSC (a 64 KB OSC 52 copy, a title) whose bytes we must not hoard. */
export const CWD_REPORT_MAX_CARRY = 4096

/** Decode `%XX` escapes as UTF-8. A malformed escape leaves the input as is (never throws). */
function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `/C:/Users/x` (how a Windows path rides in a file URL) → `C:\Users\x`; anything else untouched. */
function fromUrlPath(p: string): string {
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(p)
  if (!drive) return p
  return `${drive[1]}:${(drive[2] ?? '/').replace(/\//g, '\\')}`
}

/** VS Code's 633 value escaping: `\\` is a backslash, `\xHH` a byte (it escapes `;` as `\x3b`). */
function decode633(v: string): string {
  return v.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, all: string, hex?: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : all
  )
}

/** A path we accept as a cwd: non-empty, single-line, no NUL. Anything else is ignored. */
function plausible(p: string): string | null {
  const t = p.trim()
  // eslint-disable-next-line no-control-regex
  if (!t || /[\x00-\x1f]/.test(t)) return null
  return t
}

/** Parse ONE OSC payload (between `ESC ]` and its terminator). Null when it is not a cwd report. */
export function parseCwdOsc(payload: string): string | null {
  if (payload.startsWith('7;')) {
    const url = payload.slice(2)
    const m = /^file:\/\/[^/]*(\/.*)$/i.exec(url)
    if (!m) return null
    return plausible(fromUrlPath(percentDecode(m[1])))
  }
  if (payload.startsWith('9;9;')) {
    let v = payload.slice(4)
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    return plausible(v)
  }
  if (payload.startsWith('633;P;Cwd=')) {
    return plausible(decode633(payload.slice('633;P;Cwd='.length)))
  }
  return null
}

/**
 * Stateful scanner over a pty's output. `push` returns the LAST cwd reported inside everything seen
 * so far that completed in this chunk, or undefined when none did. An OSC split across chunks is
 * carried (bounded by `CWD_REPORT_MAX_CARRY`) and parsed once its terminator arrives.
 */
export class CwdReportScanner {
  private carry = ''

  push(chunk: string): string | undefined {
    // Fast path: nothing pending and no OSC (nor a trailing lone ESC that may start one) in sight.
    if (!this.carry && !chunk.includes('\x1b')) return undefined
    const data = this.carry + chunk
    this.carry = ''
    let found: string | undefined
    let pos = 0
    for (;;) {
      const start = data.indexOf(OSC_START, pos)
      if (start === -1) {
        // A chunk can end exactly between ESC and `]`.
        if (data.endsWith('\x1b')) this.carry = '\x1b'
        return found
      }
      const body = start + OSC_START.length
      const bel = data.indexOf('\x07', body)
      const st = data.indexOf('\x1b\\', body)
      // The earliest terminator wins; a NEW `ESC ]` before either means this OSC was abandoned.
      let end = -1
      let termLen = 0
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel
        termLen = 1
      } else if (st !== -1) {
        end = st
        termLen = 2
      }
      const next = data.indexOf(OSC_START, body)
      if (end === -1 || (next !== -1 && next < end)) {
        if (next !== -1) {
          pos = next
          continue
        }
        const tail = data.slice(start)
        if (tail.length <= CWD_REPORT_MAX_CARRY) this.carry = tail
        return found
      }
      const cwd = parseCwdOsc(data.slice(body, end))
      if (cwd !== null) found = cwd
      pos = end + termLen
    }
  }
}

// Removes every STRING-type escape sequence (OSC, DCS, SOS, PM, APC; 7- and 8-bit introducers)
// from a live link's pty stream. They carry what is not text on the screen: the clipboard (OSC 52,
// which tmux emits on every copy with `set-clipboard on`), window titles, hyperlink targets, file
// transfers, palette changes. Everything else (CSI, other ESC sequences, text) passes unchanged.
//
// Stateful across chunks, and it must see EVERY byte of the stream even while nothing is being
// forwarded: a frame that skipped the parser would leave it mid-sequence and print the tail of an
// OSC 52 (the clipboard) as text. That is also why it is reset only for a new pty session.
// A string is swallowed until its terminator, however long. There is no length cap: xterm has none
// (it stays in a string until ESC, ST, BEL for an OSC, CAN or SUB), so a cap could only ever show a
// viewer bytes the owner's screen does not. Measured: past the 1 MiB cap an earlier version had, a
// 900 KB tmux copy (one 1.2 MB OSC 52) put 151,428 chars of the clipboard's base64 on the viewer's
// screen. And the filter keeps no buffer, so there is nothing for a cap to bound.
//
// Where a string starts and ends follows xterm.js 5.5's VT500 table (EscapeSequenceParser.ts), which
// renders the owner's node, the session host's emulator and the viewer page. Every rule below that
// goes past "ESC + ] P X ^ _" closes a way the viewer would receive bytes the owner's terminal
// treats as string payload:
// - BEL ends an OSC only. Inside DCS it is data, inside SOS/PM/APC it is ignored, so the owner never
//   sees what follows it.
// - In ESCAPE, xterm executes C0 controls and ignores DEL without leaving it, restarts it on a second
//   ESC, and takes an 8-bit introducer as a string start: `ESC \n ]52;…` is still an OSC 52.
// - An 8-bit introducer inside a string starts a new string of ITS kind (an OSC turned DCS no longer
//   ends at BEL).
// Where xterm ENDS a string on something this parser does not (CAN, SUB, other C1 controls, and a
// non-ASCII char, U+00A0 and up, inside SOS/PM/APC or a DCS before its final byte: ERROR → GROUND),
// the viewer misses a little text until the next terminator; it never sees more than the owner.
//
// A viewer that joins a RUNNING session (`midStream`) cannot know where in the stream its first byte
// falls: inside an OSC 52, or right after an ESC the previous read ended on (`]52;c;…` would then
// read as text, the whole clipboard). So it starts as if an unknown string had just begun: nothing
// is shown until the next ESC, ST or 8-bit introducer, where xterm's state is known again whatever
// it was (ESCAPE, GROUND, a new string). The cost is the text between the join and the first
// escape: the viewer misses it until those cells are painted again.
//
// The output guarantee the caller relies on: no push emits an 8-bit introducer or ends on ESC, and
// every ESC it emits is followed by a char that leaves ESCAPE without starting a string. So the
// viewer's parser can never be put into a string state, even by output that is dropped in part
// (drop-and-redraw) or starts on a keyframe.
//
// It runs on the owner's process for every byte, once per viewer, so text is copied, and a string's
// payload skipped, by searching for the next char that matters rather than char by char: about 3x
// faster on a captured tmux stream of colored output (an ESC every ~8 bytes) on a loaded host,
// 22-39 MB/s char by char, 64-130 MB/s by slice. Such a flood reaches a tmux 3.4 client at
// ~2.7 MB/s. One tmux copy of a large clipboard is a single OSC 52 of over a megabyte, whose
// payload is skipped at ~390 MB/s (~53 MB/s char by char).

const ESC = '\x1b'
// Fast path: a chunk with none of these, read in text mode, is returned as it is.
const TEXT_SPECIAL = /[\x1b\x90\x98\x9d-\x9f]/
const INTRO_8_ANY = /[\x90\x98\x9d-\x9f]/
// What can end a string: ESC, ST, an 8-bit introducer, and BEL for an OSC only.
const STRING_STOP = /[\x1b\x90\x98\x9c-\x9f]/g
const OSC_STOP = /[\x07\x1b\x90\x98\x9c-\x9f]/g

// OSC, DCS, SOS, PM, APC: `ESC ] P X ^ _` and their 8-bit forms.
function isIntro7(c: number): boolean {
  return c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f
}
function isIntro8(c: number): boolean {
  return c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f
}
// The C0 controls xterm executes while staying in ESCAPE: all but CAN, SUB and ESC itself.
function isC0Executable(c: number): boolean {
  return c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f)
}

export interface StreamFilterOptions {
  /**
   * The first byte may fall anywhere in the stream. Every viewer that co-attaches to a running
   * session must set it, and so must every `reset()` onto a session that is already running;
   * without it a join inside a string, or right after an ESC, sends the string's payload as text.
   * Starts exactly as if an 8-bit DCS introducer had just been read: nothing is shown until the
   * next ESC (an `ESC \` ST is dropped), ST or 8-bit introducer; BEL does not end it (the unknown
   * string may be a DCS or APC, where BEL is data). Like every string, it has no length limit.
   */
  midStream?: boolean
  /**
   * With `midStream`: called ONCE, when that unknown start state is first left (the first ESC, ST or
   * 8-bit introducer), after the chunk that left it has been parsed. From then on text flows again, so
   * the link host takes one more keyframe to repaint the text it swallowed before (controller ruling
   * R23). Ignored without `midStream`; replaced or dropped by every `reset`. A throw is logged, never
   * propagated: the parse it follows is complete, and the chunk's output must not be lost with it.
   */
  onSettled?: () => void
}

export interface StreamFilter {
  push(chunk: string): string
  /** Forget the current sequence, for a new pty session; `midStream` as for `createStreamFilter`. */
  reset(opts?: StreamFilterOptions): void
}

/**
 * A string sequence is swallowed until its terminator however long it is: xterm has no length
 * limit, so a cap would only show a viewer what the owner's screen does not, and nothing is
 * buffered, so there is no memory for one to bound.
 */
export function createStreamFilter(opts?: StreamFilterOptions): StreamFilter {
  // 'esc' is ESCAPE after a plain ESC; 'stringEsc' is ESCAPE after the ESC that ended a string,
  // where `ESC \` is that string's ST and is dropped with it.
  let mode: 'text' | 'esc' | 'string' | 'stringEsc' = 'text'
  let osc = false
  // Armed while a midStream start has not been left: the start state is the only string state it is
  // set in, so the first stop char read while it is set is the one that leaves that state.
  let settle: (() => void) | null = null
  const enterString = (introducer: number): void => {
    mode = 'string'
    osc = introducer === 0x5d || introducer === 0x9d
  }
  const start = (o: StreamFilterOptions | undefined): void => {
    settle = null
    if (o?.midStream) {
      enterString(0x90)
      settle = o.onSettled ?? null
    } else {
      mode = 'text'
      osc = false
    }
  }
  const fire = (cb: () => void): void => {
    try {
      cb()
    } catch (err) {
      console.warn(`[watch-link] onSettled threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  start(opts)
  return {
    reset(o) {
      start(o)
    },
    push(chunk) {
      if (mode === 'text' && !TEXT_SPECIAL.test(chunk)) return chunk
      // An 8-bit introducer is rare (a decoded stream carries one only if a program wrote the
      // two-byte UTF-8 form), so in most chunks ESC is the only char text mode stops at.
      const has8 = INTRO_8_ANY.test(chunk)
      const n = chunk.length
      let out = ''
      let i = 0
      let settled: (() => void) | null = null
      while (i < n) {
        if (mode === 'text') {
          let j = chunk.indexOf(ESC, i)
          if (j === -1) j = n
          if (has8) {
            for (let k = i; k < j; k++) {
              if (isIntro8(chunk.charCodeAt(k))) {
                j = k
                break
              }
            }
          }
          out += chunk.slice(i, j)
          if (j === n) break
          const c = chunk.charCodeAt(j)
          if (c === 0x1b) mode = 'esc'
          else enterString(c)
          i = j + 1
        } else if (mode === 'string') {
          const stop = osc ? OSC_STOP : STRING_STOP
          stop.lastIndex = i
          const m = stop.exec(chunk)
          // No terminator in this chunk: all of the rest is payload.
          if (m === null) break
          const c = chunk.charCodeAt(m.index)
          i = m.index + 1
          if (settle) {
            settled = settle
            settle = null
          }
          if (c === 0x1b) mode = 'stringEsc'
          else if (c === 0x9c || c === 0x07) mode = 'text'
          else enterString(c)
        } else {
          // ESCAPE. The ESC is held until the char that decides what it starts arrives.
          const c = chunk.charCodeAt(i)
          if (isIntro7(c) || isIntro8(c)) enterString(c)
          else if (c === 0x1b) mode = 'esc'
          else if (isC0Executable(c)) out += chunk[i]
          else if (c === 0x7f) {
            // DEL: ignored in ESCAPE.
          } else if (c === 0x5c && mode === 'stringEsc') mode = 'text'
          else {
            out += ESC + chunk[i]
            mode = 'text'
          }
          i++
        }
      }
      if (settled) fire(settled)
      return out
    }
  }
}

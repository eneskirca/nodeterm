// Terminal output made safe to hand to an agent as text.
//
// A captured screen carries the control sequences its programs printed: colours (CSI), titles,
// hyperlinks and clipboard writes (OSC), device strings (DCS/APC/PM/SOS). None of them is text,
// and an agent that passes them on to a terminal of its own would have them executed there (an
// OSC 52 clipboard write, for one). So everything that is not printable text, a line feed or a
// tab is removed, along with the bidi controls that can make text read differently from what it
// says.
//
// A single linear scan, never a backtracking regex: the input is whatever a program printed, and
// a screen full of unterminated sequences must not make this quadratic.

const ESC = 0x1b
const BEL = 0x07

/** True for the format characters that reorder or hide text (bidi embeddings, overrides, isolates). */
function isBidiControl(c: number): boolean {
  return (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c
}

/** Skip a string-type sequence (OSC, DCS, SOS, PM, APC) whose body starts at `i`; it ends at BEL, ST
 *  (ESC \) or the C1 ST (0x9c). An unterminated one runs to the end of the input. */
function skipString(s: string, i: number): number {
  const n = s.length
  while (i < n) {
    const d = s.charCodeAt(i)
    if (d === BEL || d === 0x9c) return i + 1
    if (d === ESC && s.charCodeAt(i + 1) === 0x5c) return i + 2
    i++
  }
  return n
}

/** Skip CSI parameters and intermediates from `i`, then its final byte if there is one. */
function skipCsi(s: string, i: number): number {
  const n = s.length
  while (i < n) {
    const d = s.charCodeAt(i)
    if (d < 0x20 || d > 0x3f) break
    i++
  }
  if (i < n) {
    const d = s.charCodeAt(i)
    if (d >= 0x40 && d <= 0x7e) return i + 1
  }
  return i
}

export function stripTerminalControls(s: string): string {
  let out = ''
  const n = s.length
  let i = 0
  while (i < n) {
    const c = s.charCodeAt(i)
    if (c === ESC) {
      const next = s.charCodeAt(i + 1)
      if (next === 0x5b) i = skipCsi(s, i + 2) // ESC [  CSI
      else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = skipString(s, i + 2) // ESC ] OSC, ESC P DCS, ESC X SOS, ESC ^ PM, ESC _ APC
      } else i += i + 1 < n ? 2 : 1 // any other two-byte escape, or a lone ESC at the end
      continue
    }
    if (c === 0x9b) {
      i = skipCsi(s, i + 1) // C1 CSI
      continue
    }
    if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
      i = skipString(s, i + 1) // C1 OSC, DCS, SOS, PM, APC
      continue
    }
    if (c === 0x0d) {
      // CR LF is a line break; a lone CR (a redraw) is dropped rather than turned into a new line.
      i++
      continue
    }
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f || (c >= 0x80 && c <= 0x9f) || isBidiControl(c)) {
      i++
      continue
    }
    out += s[i]
    i++
  }
  return out
}

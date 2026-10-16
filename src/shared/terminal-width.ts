import { Unicode11Addon } from '@xterm/addon-unicode11'

/**
 * The character-width table every xterm instance in the stack uses: the renderer's terminals AND
 * the Windows session host's headless emulator. One definition, because the whole point is that
 * they agree with each other and with the program writing to the pane.
 *
 * It is Unicode 11 (`@xterm/addon-unicode11`, see `renderer/terminal/unicode-width.ts` for why)
 * plus ONE rule xterm's tables do not have: **an emoji followed by VARIATION SELECTOR-16 (U+FE0F)
 * is two cells wide.**
 *
 * Many emoji have TEXT presentation by default (`⏱ U+23F1`, `⚠ U+26A0`, `✔ U+2714`, `© U+00A9`)
 * and are one cell in every wcwidth table. Appending VS16 asks for the emoji presentation, and
 * everyone else the bytes pass through then counts the pair as two cells:
 *
 *  - the agent CLIs measure with `string-width`, which gives every RGI emoji sequence width 2 —
 *    and `⏱️` (U+23F1 U+FE0F) is one;
 *  - tmux treats VS16 as wide by default (server option `variation-selector-always-wide`, on).
 *
 * xterm's tables read VS16 as a zero-width combining mark and keep the pair at ONE cell. The writer
 * then repaints by ABSOLUTE cursor position one column further right than xterm believes the text
 * ends, so a shorter value painted over a longer one leaves the old tail behind. That is the
 * claude-hud status line reading `113` for `11%` and `2h 327` for `2h 32m` in a nodeterm pane: the
 * line starts with `⏱️`, and every character after it was one column off.
 *
 * Measured on the claude-hud line through real ConPTY on Windows 11 (ConPTY passes the bytes
 * through; the shift is xterm's). Only VS16 is widened. VS15 (U+FE0E, "text please") is left
 * alone: `string-width` still sizes a `⭐︎` by the base character's East Asian Width, which is
 * what xterm already does.
 *
 * Keycaps are the one sequence whose base is ASCII: `1️⃣` (`1` U+FE0F U+20E3) is an RGI emoji and
 * two cells for the CLIs and for tmux, while `1` U+FE0F alone is not an RGI emoji and stays one
 * cell. So an ASCII base is NOT widened by VS16, and the keycap mark U+20E3 widens a `[0-9#*]` +
 * VS16 pair instead. The unqualified keycap `1⃣` (no VS16) stays one cell, as it is for tmux; some
 * `string-width` releases (4.x, and 8.2+) count it as two, so a CLI on one of those still
 * disagrees about that one form — it is rare in practice, and a POSIX pane is painted by tmux.
 *
 * Known limitation, inherited from xterm: in insert mode (IRM, `CSI 4 h`) xterm places a widened
 * join without shifting the rest of the line, so the cell the second column lands on is
 * overwritten. Before this table that case was already a column out of step with the writer; no
 * agent CLI or tmux repaint that we know of prints emoji in insert mode.
 */
export const TERMINAL_WIDTH_VERSION = '11-vs16'

/** The provider shape xterm's `Terminal.unicode.register` takes (5.5 and headless 6 alike). */
export interface WidthProvider {
  readonly version: string
  wcwidth(codepoint: number): 0 | 1 | 2
  charProperties(codepoint: number, preceding: number): number
}

/** The part of a Terminal (browser or headless) this needs. */
export interface UnicodeTerminal {
  unicode: { register(provider: WidthProvider): void; activeVersion: string }
}

const VS16 = 0xfe0f
const KEYCAP = 0x20e3

// xterm's packed char-properties value (`UnicodeService.createPropertyValue`): bit 0 = joins the
// preceding cell, bits 1-2 = width, bits 3+ = a provider-defined state. The state is how this
// provider remembers what the preceding character was; xterm hands it back unchanged as
// `preceding`, across write chunks too (`parser.precedingJoinState`).
const pack = (state: number, width: number, join: boolean): number =>
  ((state & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0)
const widthOf = (v: number): number => (v >> 1) & 3
const stateOf = (v: number): number => v >> 3

/** A one-cell emoji that VS16 turns into a two-cell one. */
const STATE_EMOJI_BASE = 1
/** `[0-9#*]`: not widened by VS16, but a keycap base. */
const STATE_KEYCAP_BASE = 2
/** `[0-9#*]` + VS16: the keycap mark that follows makes it two cells. */
const STATE_KEYCAP_VS16 = 3

// Below U+00A9 the only Emoji-property characters are the keycap bases, handled before this is asked.
const EMOJI = /^\p{Emoji}$/u
const isKeycapBase = (cp: number): boolean => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a

/** Wrap a width table with the VS16 rule above. Every other answer is the base table's. */
export function withEmojiPresentation(base: WidthProvider): WidthProvider {
  return {
    version: TERMINAL_WIDTH_VERSION,
    wcwidth: (cp) => base.wcwidth(cp),
    charProperties(cp, preceding) {
      const prev = stateOf(preceding)
      if (cp === VS16 && widthOf(preceding) === 1) {
        if (prev === STATE_EMOJI_BASE) return pack(0, 2, true)
        if (prev === STATE_KEYCAP_BASE) return pack(STATE_KEYCAP_VS16, 1, true)
      }
      if (cp === KEYCAP && prev === STATE_KEYCAP_VS16 && widthOf(preceding) === 1) return pack(0, 2, true)
      const value = base.charProperties(cp, preceding)
      // Only a fresh one-cell character can start a sequence; a join keeps the base's answer.
      if ((value & 1) !== 0 || widthOf(value) !== 1) return value
      if (isKeycapBase(cp)) return pack(STATE_KEYCAP_BASE, 1, false)
      // Hot path: this runs per printed character. No code point below © (U+00A9) other than the
      // keycap bases has the Emoji property, so plain text never pays for the regex below.
      if (cp < 0xa9) return value
      if (EMOJI.test(String.fromCodePoint(cp))) return pack(STATE_EMOJI_BASE, 1, false)
      return value
    }
  }
}

/** The Unicode 11 table, taken from the addon that owns it (its only export is the addon). */
function unicode11(): WidthProvider {
  let provider: WidthProvider | null = null
  new Unicode11Addon().activate({
    unicode: { register: (p: WidthProvider) => (provider = p) }
  } as unknown as Parameters<Unicode11Addon['activate']>[0])
  if (!provider) throw new Error('@xterm/addon-unicode11 registered no width provider')
  return provider
}

/** Put a terminal on the shared width table. Throws if it cannot; callers decide how to degrade. */
export function activateTerminalWidths(term: UnicodeTerminal): void {
  term.unicode.register(withEmojiPresentation(unicode11()))
  term.unicode.activeVersion = TERMINAL_WIDTH_VERSION
}

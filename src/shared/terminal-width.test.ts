/**
 * The VS16 rule, asserted on a REAL xterm (the headless build the session host runs), never on the
 * provider's return values alone: what matters is where the cursor lands and what a repaint by
 * absolute position leaves on screen, because that is what the user saw go wrong.
 *
 * Code points are written as escapes on purpose: U+FE0F is invisible, and a literal one in this
 * file cannot be told apart from its absence.
 *
 * MUTATION: make `withEmojiPresentation` return `base.charProperties(cp, preceding)` unchanged →
 * the claude-hud repaint, the cursor and the chunk-split cases redden. Drop the keycap branch →
 * the keycap case reddens. Drop the `isKeycapBase` branch → the ASCII + VS16 case reddens (an
 * ASCII digit would then count as an emoji base).
 */
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  activateTerminalWidths,
  TERMINAL_WIDTH_VERSION,
  withEmojiPresentation,
  type WidthProvider
} from './terminal-width'

const VS16 = '\u{fe0f}'
const VS15 = '\u{fe0e}'
const KEYCAP = '\u{20e3}'
const STOPWATCH = '\u{23f1}'

function terminal(): Terminal {
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
  activateTerminalWidths(term)
  return term
}

const write = (term: Terminal, ...chunks: string[]): Promise<void> =>
  chunks.reduce<Promise<void>>((p, c) => p.then(() => new Promise((r) => term.write(c, r))), Promise.resolve())

const line = (term: Terminal, y = 0): string =>
  term.buffer.active.getLine(y)!.translateToString(true)

/** Columns the cursor advanced after writing `text` at the start of an empty line. */
async function cells(text: string): Promise<number> {
  const term = terminal()
  await write(term, text)
  return term.buffer.active.cursorX
}

describe('the shared terminal width table', () => {
  it('is the active table once activated', () => {
    expect(terminal().unicode.activeVersion).toBe(TERMINAL_WIDTH_VERSION)
  })

  it('repaints the claude-hud status line without leaving a stale digit behind', async () => {
    // The writer believes the stopwatch + VS16 spans columns 1-2, so the value starts at column 4.
    // It paints 100%, then repaints 11% at the SAME absolute column and erases to the end of the
    // line. On a table that sizes the pair as one cell the repaint lands one column short and the
    // screen reads "111%" (the field report: `113` for `11%`).
    const term = terminal()
    await write(term, `${STOPWATCH}${VS16} 100%`, '\x1b[1;4H11%\x1b[K')
    expect(line(term)).toBe(`${STOPWATCH}${VS16} 11%`)
  })

  it('gives a text-default emoji followed by VS16 two cells', async () => {
    // stopwatch, warning sign, heavy check mark, copyright sign
    for (const emoji of [STOPWATCH, '\u{26a0}', '\u{2714}', '\u{a9}']) {
      expect([emoji, await cells(`${emoji}${VS16}`)]).toEqual([emoji, 2])
    }
  })

  it('still widens it when VS16 arrives in a later write than its base', async () => {
    const term = terminal()
    await write(term, STOPWATCH, VS16, 'x')
    expect(term.buffer.active.cursorX).toBe(3)
  })

  it('leaves every other width as it was', async () => {
    const STAR = '\u{2b50}'
    expect(await cells(STOPWATCH)).toBe(1) // the same emoji without VS16
    expect(await cells(STAR)).toBe(2) // already wide; VS16 adds nothing
    expect(await cells(`${STAR}${VS16}`)).toBe(2)
    expect(await cells(`${STAR}${VS15}`)).toBe(2) // VS15 is not this rule's business
    expect(await cells(`A${VS16}`)).toBe(1) // not an emoji
    expect(await cells(`1${VS16}`)).toBe(1) // an ASCII base with VS16 alone is not an RGI emoji
    expect(await cells('\u{65e5}')).toBe(2) // CJK
    expect(await cells('abc')).toBe(3)
  })

  it('gives a keycap sequence two cells', async () => {
    expect(await cells(`1${VS16}${KEYCAP}`)).toBe(2)
    expect(await cells(`#${VS16}${KEYCAP}`)).toBe(2)
    expect(await cells(`1${KEYCAP}`)).toBe(1) // unqualified: one cell, as tmux sizes it
  })
})

// charProperties runs once per printed character, so plain ASCII must never pay for the emoji
// regex: on ~20 MB of ASCII the regex alone slowed parsing by ~75%. MUTATION: drop the
// `cp < 0xa9` fast path → the spy below is called and this test reddens.
describe('the width wrapper on plain text', () => {
  // A base table that answers "one fresh cell" for everything, so every code point reaches the
  // part of the wrapper that would ask the regex.
  const base: WidthProvider = {
    version: 'stub',
    wcwidth: () => 1,
    charProperties: () => 1 << 1
  }

  it('never runs the emoji regex for a character below U+00A9', () => {
    const provider = withEmojiPresentation(base)
    const spy = vi.spyOn(RegExp.prototype, 'test')
    try {
      for (let cp = 0x20; cp < 0xa9; cp++) {
        if (cp >= 0x7f && cp < 0xa0) continue
        provider.charProperties(cp, 0)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('still marks U+00A9 as an emoji base, so the fast path stops short of it', async () => {
    expect(await cells(`\u{a9}${VS16}`)).toBe(2)
  })
})


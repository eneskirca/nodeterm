import type { Terminal } from '@xterm/xterm'
import { activateTerminalWidths, type UnicodeTerminal } from '@shared/terminal-width'

/**
 * Put xterm on the SAME character-width table as everything else in the stack.
 *
 * xterm.js ships Unicode **6** widths and makes them the default, and nothing here ever changed
 * that. Everyone else the bytes pass through is on a modern table: tmux measures with utf8proc,
 * and the agent CLIs measure with `string-width`/`wcwidth` built from current Unicode. The two
 * disagree about a whole class of characters — every emoji, and the symbols that gained Emoji
 * Presentation along the way:
 *
 *      ⭐ U+2B50   👍 U+1F44D   😄 U+1F604   🎉 U+1F389      xterm V6: 1     tmux/CLI: 2
 *      日 U+65E5   中 U+4E2D                                 xterm V6: 2     tmux/CLI: 2
 *
 * That single disagreement is what the 2026-08-05 device round reported, from both ends at once:
 *
 *  - **Overlap** (GPU / DOM renderers). xterm advances ONE cell for an emoji whose ink is nearly
 *    two, and those renderers let ink overhang, so the glyph lands on top of whatever the next
 *    cell holds.
 *  - **A fragment** (shared renderer). The same one-cell advance, but glyphgrid clips every glyph
 *    to its own cell — deliberately, since ink in the gutter would ghost into a neighbour's mip —
 *    so the overflow is cut instead of overlapping. ⭐ arrived as a sliver.
 *
 * Same cause, two symptoms, and NEITHER is a renderer bug: a renderer cannot draw a two-cell
 * character correctly while the buffer insists it is one cell wide. The glyphgrid fix that draws a
 * wide character across both of its cells (`GlyphAtlas.glyphFor`'s `half`) is the other half of
 * this one — it is what makes the second cell this table grants actually get painted.
 *
 * THE DEEPER SYMPTOM IS COLUMN ACCOUNTING, not looks. tmux keeps its own screen model and repaints
 * xterm by ABSOLUTE cursor position, so when tmux believes an emoji spans columns 12–13 and xterm
 * believes it spans 12 alone, the two models are shifted against each other for the rest of the
 * line. A partial repaint then writes at coordinates that mean different things on the two sides,
 * which can leave a column blank or doubled well away from the emoji that caused it. That is a
 * live candidate for the "a letter goes missing mid-word" report of the same device round — a
 * defect the blank-cell probe in `glyphgrid/feed.ts` stayed SILENT on, which is exactly what it
 * would do if the buffer cell were genuinely empty rather than mis-drawn.
 *
 * WHAT TO WATCH, because this cuts both ways. Agreement is the goal, not the number 11: if a host's
 * tmux were built WITHOUT utf8proc it would use a width-1 table and this would introduce the same
 * mismatch in the opposite direction. Homebrew and Debian both build tmux with utf8proc, so the
 * realistic case is the one this fixes; a host that misaligns AFTER this change is the case to
 * report, and the fix there is that host's tmux, not a return to Unicode 6.
 *
 * The table is Unicode 11 plus one rule for emoji followed by VS16 (`@shared/terminal-width`, where
 * the reasoning lives); the Windows session host's emulator loads the same table.
 *
 * Applies to every renderer, so it is loaded at terminal construction rather than anywhere near
 * glyphgrid. Failure is non-fatal by design: a terminal on the old table renders as it did
 * yesterday, which is far better than a terminal that does not open.
 */
export function activateUnicode11(term: Terminal): void {
  try {
    activateTerminalWidths(term as unknown as UnicodeTerminal)
  } catch (err) {
    console.warn('[terminal] could not activate Unicode 11 widths; staying on xterm’s default', err)
  }
}

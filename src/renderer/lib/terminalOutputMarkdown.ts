import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { stripTerminalControls } from './terminalControls'

/**
 * Render a terminal's captured output (the ⌘M "markdown of output" view) to sanitized HTML.
 *
 * `renderMarkdown` is the wrong tool for this, for three measured reasons:
 * - With `breaks: false`, consecutive output lines join into ONE paragraph — `ls -l` rendered as a
 *   single run-on line. Terminal output is line-oriented, so every newline is kept (`breaks: true`).
 * - Anything that LOOKS like a tag is parsed as raw HTML, and DOMPurify then strips it:
 *   `echo <stdin>` showed as `echo `. Output is text a program printed, never markup the user
 *   meant, so raw-HTML tokens are rendered as escaped TEXT. This is done on the `html` token only —
 *   NOT by pre-escaping `<` in the source, which would double-escape inside code spans/fences
 *   (marked already escapes those, so `a < b` in backticks would print as `a &lt; b`).
 * - `tmux capture-pane` pads the capture with trailing blank lines (and lines with trailing
 *   spaces), which rendered as a tall empty tail under the real output.
 *
 * A private `Marked` instance, so the global `marked` config that `renderMarkdown`'s callers
 * (sticky notes, editor preview, ChatPanel) share is never touched. The result still goes through
 * DOMPurify: escaping raw HTML is about readability, sanitizing is about safety — markdown links
 * (`[x](javascript:…)`) still produce real elements that need it.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const terminalMarked = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  renderer: {
    // Positional `(html, block)` is marked 12's Renderer signature; marked 13+ passes ONE token
    // object instead, so an upgrade must rewrite this hook (the tests would go red, not silent).
    html(html: string, block?: boolean): string {
      if (!block) return escapeHtml(html)
      // A block-level html token swallows every line up to the next blank line; show it as the
      // paragraph of text it was printed as, its line structure kept like everything else.
      return `<p>${escapeHtml(html.replace(/\n+$/, '')).replace(/\n/g, '<br>\n')}</p>\n`
    }
  }
})

// The escape-sequence rule lives in a leaf module (the quote builder uses it without marked and
// DOMPurify); re-exported here so this module's callers are unchanged.
export { stripTerminalControls }

/** Strip control sequences, then trailing whitespace (and a CRLF capture's `\r` — explicit, though
 *  JS's /m `$` and marked's own CRLF normalization already cover it) from every line, then
 *  capture-pane's blank-line pad. */
function trimCapture(text: string): string {
  return stripTerminalControls(text).replace(/[ \t\r]+$/gm, '').replace(/\s+$/, '')
}

export function renderTerminalOutput(text: string): string {
  const src = trimCapture(text || '')
  if (!src) return ''
  const html = terminalMarked.parse(src) as string
  return DOMPurify.sanitize(html)
}

/**
 * How many lines of captured output the ⌘M view renders. The capture is the FULL scrollback — up
 * to the tmux `history-limit` (50k lines), possibly over SSH — and marked + DOMPurify + layout of
 * all of it runs synchronously on the renderer thread. The newest output is what the view is for
 * (it opens scrolled to the bottom), so the oldest lines are the ones dropped.
 */
export const MD_OUTPUT_MAX_LINES = 5000

/** The last `max` lines of a capture (after dropping capture-pane's trailing blank padding, so the
 *  padding cannot spend the budget), and how many older lines were cut. A cut can land inside a
 *  fenced block, which then renders from that point as the other side of the fence — accepted:
 *  the cut is announced, and the tail is what the reader came for. */
export function tailOutputLines(
  text: string,
  max: number = MD_OUTPUT_MAX_LINES
): { text: string; dropped: number } {
  const trimmed = trimCapture(text || '')
  if (!trimmed) return { text: '', dropped: 0 }
  const lines = trimmed.split('\n')
  if (lines.length <= max) return { text: trimmed, dropped: 0 }
  return { text: lines.slice(lines.length - max).join('\n'), dropped: lines.length - max }
}

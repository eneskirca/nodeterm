/**
 * Does Claude Code's own UI own the keyboard right now? Read from the pane's SCREEN, because the
 * dialogs that matter here fire no hook: the folder-trust prompt, `/model`, one-time setup questions.
 * The agent state keeps reading idle (or working) while one is up, so the ⌘M chat view would type into
 * it — the text is swallowed and the Enter answers the dialog. On the trust prompt the highlighted
 * default is "No, exit".
 *
 * MEASURED on Claude Code 2.1.283 (fullscreen TUI, which nodeterm enables):
 * - At its prompt — idle, or working with the queue open — the bottom of the screen is the input
 *   box: a `────` rule, a line starting `❯ ` at column 0 (continuation lines under it), another rule,
 *   then the status lines. In shell mode (a draft starting `!`) the prompt character is `!` instead
 *   (2.1.284; `#`, `&` and `@` drafts keep `❯`).
 * - The trust prompt and the `/model` picker REPLACE that box, and end in a key-hint footer
 *   ("Enter to confirm · Esc to cancel", "… · s to use this session only · Esc to cancel").
 * - A setup dialog seen in the field took the Enter while the typed text landed in the input box, so
 *   a dialog can also sit ABOVE a visible box. The footer alone is therefore enough to say "dialog".
 *
 * Only the BOTTOM of the capture is read: callers capture ~200 lines, history included, and a CLI
 * not in fullscreen mode leaves old dialogs and old input boxes in that history. The live box must
 * end within `BOX_TAIL_LINES` of the bottom, and a footer counts only in the last `FOOTER_TAIL_LINES`
 * lines, or at most `FOOTER_ABOVE_BOX_LINES` above the box — never further up the history.
 *
 * Only `prompt` means "safe to type". `unknown` (nothing readable) is left to the caller; a screen
 * with text but no input box and no footer is `no-prompt` — not necessarily a dialog (the CLI may be
 * starting, or gone and a shell owns the pane), but still no place to type a prompt.
 */
export type ClaudeScreen =
  | { kind: 'prompt' }
  | { kind: 'dialog'; text: string }
  | { kind: 'no-prompt' }
  | { kind: 'unknown' }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** A full-width rule of the input box (`─`, U+2500). */
const isRule = (line: string): boolean => /^─{20,}/.test(line.trim())
/** Any border a dialog is drawn under: the rule, or the `▔` top edge the `/model` picker uses. A
 *  label or notice can be painted over part of it (measured: "● high · /effort", a tmux notice),
 *  so it only has to START or END with the border characters. */
const isBorder = (line: string): boolean => /^\s*[─▔]{3,}/.test(line) || /[─▔]$/.test(line)
/** A key-hint footer. Capitalized on purpose: the working spinner says "esc to interrupt". */
const isFooter = (line: string): boolean => {
  const t = line.trim()
  return /^Enter to confirm\b/.test(t) || /(?:^|\s·\s)Esc to (?:cancel|exit|go back)$/.test(t)
}

/** Non-blank lines allowed under the box's bottom rule — the status lines (a custom statusline can
 *  take several). */
const BOX_TAIL_LINES = 8
/** A footer with no box: a dialog's key hints are its last line (measured: trust prompt, /model). */
const FOOTER_TAIL_LINES = 3
/** A footer above a live box: a dialog drawn right on top of the input box. */
const FOOTER_ABOVE_BOX_LINES = 4

/** The input box's first line: the `❯` prompt, or `!` in shell mode — followed by a NO-BREAK SPACE
 *  (U+00A0) there, measured, which `\s` covers. */
const isPromptLine = (line: string | undefined): boolean =>
  line !== undefined && (line.startsWith('❯') || /^!(\s|$)/.test(line))

/** Indexes of the non-blank lines, bottom first. */
const nonBlankFromBottom = (lines: readonly string[]): number[] =>
  lines.flatMap((l, i) => (l.trim() === '' ? [] : [i])).reverse()

/** The live input box: `[top rule, bottom rule]` line indexes, or null. */
function inputBox(lines: readonly string[]): [number, number] | null {
  const tail = nonBlankFromBottom(lines).slice(0, BOX_TAIL_LINES + 1)
  for (const bottom of tail) {
    if (bottom === 0 || !isRule(lines[bottom])) continue
    for (let top = bottom - 1; top >= 0 && bottom - top <= 40; top--) {
      if (!isRule(lines[top])) continue
      return isPromptLine(lines[top + 1]) && top + 1 < bottom ? [top, bottom] : null
    }
    return null
  }
  return null
}

/** The dialog's own lines: from the border above the footer down to the footer, dedented. */
function dialogText(lines: readonly string[], footer: number): string {
  let start = footer
  while (start > 0 && footer - start < 30 && !isBorder(lines[start - 1])) start--
  const body = lines.slice(start, footer + 1).filter((l) => l.trim() !== '')
  const indent = Math.min(...body.map((l) => l.length - l.trimStart().length))
  return body.map((l) => l.slice(indent)).join('\n')
}

export function readClaudeScreen(screen: string): ClaudeScreen {
  const lines = screen.replace(ANSI, '').split(/\r?\n/).map((l) => l.trimEnd())
  if (lines.every((l) => l === '')) return { kind: 'unknown' }
  const box = inputBox(lines)
  const bottom = nonBlankFromBottom(lines)
  // Where a footer may be: under the box (or at the very bottom when there is no box), and right
  // above the box. Never inside it — a footer there is the user's own draft.
  const candidates = box
    ? [
        ...bottom.filter((i) => i > box[1]),
        ...bottom.filter((i) => i < box[0]).slice(0, FOOTER_ABOVE_BOX_LINES)
      ]
    : bottom.slice(0, FOOTER_TAIL_LINES)
  const footer = candidates.find((i) => isFooter(lines[i]))
  if (footer !== undefined) return { kind: 'dialog', text: dialogText(lines, footer) }
  return box ? { kind: 'prompt' } : { kind: 'no-prompt' }
}

/** Refuse to type: anything but a visible input box, except a screen we could not read at all. */
export function claudeScreenBlocksInput(s: ClaudeScreen): boolean {
  return s.kind === 'dialog' || s.kind === 'no-prompt'
}

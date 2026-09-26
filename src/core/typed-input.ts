import type { TextDeliveryResult } from '../shared/text-delivery'
import { posixQuote } from '../shared/ssh'
import { assertPasteTarget } from './tmux-naming'
import { ENVELOPE_SETTLE_POLLS, ENVELOPE_SETTLE_POLL_MS, type SettleOptions } from './settled-submit'

/**
 * ── TYPED DELIVERY: a prompt that arrives as TYPING, not as a paste ─────────────────────────────
 *
 * Why it exists. `sendText` delivers through a bracketed paste, and Claude Code records a
 * multi-line paste wrapped as `<pasted_content id="…">…</pasted_content id="…">` — content its own
 * instructions tell the model to treat as possibly not written by the user. For the ⌘M chat view,
 * where the text IS the user's prompt, that demoted every multi-line message. Measured against
 * claude 2.1.281 (2026-09-23): text typed as keystrokes, lines joined by M-Enter (ESC CR, the key
 * Shift+Enter sends in the terminal), is recorded as plain user text — idle, queued mid-turn, and
 * at 30 lines / 2.7 KB arriving in one burst.
 *
 * How, and the traps each choice avoids (all measured on tmux 3.6a):
 *  - The text NEVER rides argv. It goes over stdin to a fixed shell script (no user bytes in it),
 *    which pastes it one line at a time — out of the process list on a shared host, and immune to
 *    `send-keys -l` argv parsing, where a trailing `;` is a command separator, `\;` loses its
 *    backslash and a leading `-` is an option.
 *  - Each line is pasted WITHOUT `-p`: raw bytes, no bracketed-paste markers, i.e. typing.
 *  - Line breaks are the tmux KEY `M-Enter`, never an ESC byte in a buffer: tmux ≥ 3.7 passes
 *    paste-buffer content through vis(3), which rewrites ESC into the literal text `^[` (the
 *    tombstone in tmux-naming.ts has the measurement).
 *  - Enter is a SEPARATE write, sent only once the pane shows the text. An Enter arriving in the
 *    same burst as the text is read by Claude Code as a line break, and the message sits unsent.
 *  - Tabs become spaces: a Tab keystroke is a shortcut to Claude Code's composer and the character
 *    vanishes (measured).
 *
 * tmux backends only (local, SSH, Server Edition). The Windows backends keep the paste path: how
 * Claude Code on Windows reads M-Enter has not been measured.
 */

/** Tab width used when a typed prompt contains tabs (see above: a typed Tab is a shortcut). */
export const TYPED_TAB = '    '

/**
 * The lines to type. CR/CRLF become LF; tabs become spaces; every other control character (C0
 * except LF, DEL, C1 — ESC and the 8-bit CSI included) is dropped, because a typed control byte
 * is a KEY — a stray ^C in a chat message would interrupt the agent. Printable text is untouched.
 */
export function typedLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, TYPED_TAB)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
    .split('\n')
}

/**
 * The script that types stdin into the pane. `tmux` is a shell word that runs tmux (a quoted
 * absolute path locally, `tmux` on an SSH host); `target` and `buffer` are validated here, since
 * they are spliced in. Every failure exits non-zero, and a paste that fails after its load drops
 * the buffer rather than leaving the user's line in the server's buffer stack (see PasteDelivery).
 */
export function typedInputScript(tmux: string, socket: string, target: string, buffer: string): string {
  assertPasteTarget(target, buffer)
  if (!/^[A-Za-z0-9._-]+$/.test(socket)) throw new Error(`unsafe tmux socket: ${JSON.stringify(socket)}`)
  const t = `${tmux} -L ${socket}`
  return [
    // Leave copy mode first, like the paste path: keys typed into copy mode drive IT, not the app.
    `${t} if-shell -F -t ${target} '#{pane_in_mode}' 'send-keys -t ${target} -X cancel' || exit 1`,
    'first=1',
    'while IFS= read -r line; do',
    `  if [ "$first" = 1 ]; then first=0; else ${t} send-keys -t ${target} M-Enter || exit 1; fi`,
    '  if [ -n "$line" ]; then',
    `    printf '%s' "$line" | ${t} load-buffer -b ${buffer} - || exit 1`,
    `    ${t} paste-buffer -d -r -b ${buffer} -t ${target} || { ${t} delete-buffer -b ${buffer} 2>/dev/null; exit 1; }`,
    '  fi',
    'done'
  ].join('\n')
}

/** The same script, as `sh -c` argv for a local run (stdin carries the text). */
export function localTypedArgs(tmuxPath: string, socket: string, target: string, buffer: string): string[] {
  return ['-c', typedInputScript(posixQuote(tmuxPath), socket, target, buffer)]
}

/** What stdin the script reads: one line per line, each LF-terminated so the last is read too. */
export function typedStdin(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

export interface TypedSurface {
  /** The pane's text now, or null when it cannot be read. Never throws. */
  capture(): Promise<string | null>
  /** Type the stdin into the pane WITHOUT submitting. False: it failed, possibly part-way. */
  type(stdin: string): Promise<boolean>
  /** Submit, in its own write. False: the Enter could not be sent. */
  submit(): Promise<boolean>
}

// eslint-disable-next-line no-control-regex
const visible = (s: string): string => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '')

/** Non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** How many trailing visible characters identify the message on screen. */
export const TYPED_NEEDLE_CHARS = 24

/**
 * Type `text`, then submit it once the pane shows it.
 *
 * "Shows it" is NOT "the screen stopped changing" (the envelope path's rule): while an agent works,
 * its spinner and token counter repaint constantly, so a stable screen never comes and a QUEUED
 * prompt would never be submitted. It is: the message's tail is on screen MORE times than before
 * the typing, on two polls in a row — more, so an identical earlier message already visible does
 * not count; twice, so the composer has finished taking the burst in.
 *
 * `pasted-not-submitted` whenever the text may be in the composer unsent — a failed or partial
 * type, an unconfirmed settle, a failed Enter. Callers surface it and never resend.
 */
export async function typeThenSubmitWhenSettled(
  text: string,
  surface: TypedSurface,
  options: SettleOptions = {}
): Promise<TextDeliveryResult> {
  const lines = typedLines(text)
  const joined = visible(lines.join(''))
  if (joined === '') return false
  const needle = joined.slice(-TYPED_NEEDLE_CHARS)
  const before = await surface.capture()
  if (!(await surface.type(typedStdin(lines)))) return 'pasted-not-submitted'
  if (before === null) return 'pasted-not-submitted'
  const baseline = occurrences(visible(before), needle)

  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const polls = Math.max(1, options.polls ?? ENVELOPE_SETTLE_POLLS)
  let seenOnce = false
  for (let i = 0; i < polls; i++) {
    await wait(ENVELOPE_SETTLE_POLL_MS)
    const now = await surface.capture()
    const shown = now !== null && occurrences(visible(now), needle) > baseline
    if (shown && seenOnce) return (await surface.submit()) ? true : 'pasted-not-submitted'
    seenOnce = shown
  }
  return 'pasted-not-submitted'
}

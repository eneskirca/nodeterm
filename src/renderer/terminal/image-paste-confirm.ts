// Did the agent actually take the image we pasted into its pane?
//
// A dropped or pasted screenshot becomes a FILE PATH typed into the terminal (file-drop.ts). What
// happens next is the pane app's business, and until now nothing looked: the upload overlay went
// away and the paste was presented as done, whether the agent attached an image or just received a
// line of text.
//
// MEASURED on Claude Code 2.1.285 (2026-09-30, a private tmux, bracketed paste exactly as
// `term.paste` sends it — fixture lines in `image-paste-confirm.test.ts`):
//   - a path to an existing .png/.jpg/.jpeg/.gif/.webp (any case) is replaced in the composer by
//     `[Image #N]` within ~60 ms; two paths in one paste become two placeholders;
//   - .bmp, .svg, .heic, .tiff and a path that does not exist stay as plain text;
//   - N counts up for the life of the session and does NOT restart when the composer is cleared
//     (`[Image #4]` after four earlier pastes), so "new" means a number the screen did not show
//     before the paste — never a fixed `#1`;
//   - a backslash-escaped space (`pasted\ 2.png`, what `escapeDroppedPath` writes) still attaches.
//
// So for claude the pane itself says whether the image was taken, and we read it from OUR emulator
// (the xterm buffer), not from tmux — the pane app's output already arrives here. Other agents
// were not measured: they get no receipt either way, exactly as before, and nothing claims success
// on their behalf.
import type { Terminal } from '@xterm/xterm'
import { capabilityAgentId } from '@shared/agents/config'

/** Extensions claude 2.1.285 turned into `[Image #N]` (compared lower-cased). Closed set. */
export const CLAUDE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

/** How many `[Image #N]` placeholders a paste of `paths` should produce in this pane, or 0 when we
 *  have no measured expectation (another agent, no agent, or no image among the paths). */
export function expectedImagePlaceholders(agentId: string | undefined, paths: string[]): number {
  if (!agentId || capabilityAgentId(agentId) !== 'claude') return 0
  let n = 0
  for (const p of paths) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p)
    if (m && (CLAUDE_IMAGE_EXTENSIONS as readonly string[]).includes(m[1].toLowerCase())) n++
  }
  return n
}

const PLACEHOLDER = /\[Image #(\d+)\]/g

/** The placeholder numbers visible in `screen`. */
export function imagePlaceholderNumbers(screen: string): Set<number> {
  const out = new Set<number>()
  for (const m of screen.matchAll(PLACEHOLDER)) out.add(Number(m[1]))
  return out
}

/** The visible screen of an xterm, soft-wrapped rows joined so a placeholder split by the wrap is
 *  still one token. */
export function xtermScreenText(term: Pick<Terminal, 'buffer' | 'rows'>): string {
  const buf = term.buffer.active
  const top = buf.viewportY
  let out = ''
  for (let y = top; y < top + term.rows; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    if (y > top && !line.isWrapped) out += '\n'
    out += line.translateToString(true)
  }
  return out
}

export type ImagePasteOutcome = 'confirmed' | 'unconfirmed'

/** Long enough for an SSH round trip; a local claude answered in ~60 ms. */
export const IMAGE_PASTE_CONFIRM_MS = 3000
export const IMAGE_PASTE_POLL_MS = 50

/**
 * Wait until the screen shows `expected` placeholder numbers above every one on it before the paste.
 * `before` must be read BEFORE the paste is sent.
 */
export async function confirmImagePaste(opts: {
  before: Set<number>
  expected: number
  read: () => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollMs?: number
}): Promise<ImagePasteOutcome> {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + (opts.timeoutMs ?? IMAGE_PASTE_CONFIRM_MS)
  // Claude's counter only goes up, so this paste's placeholders are numbered ABOVE every one
  // already on screen. Counting "any number not seen before" would let an older placeholder that
  // scrolls into view confirm this paste. Residual: with nothing on screen before the paste, the
  // floor is 0, and two pastes within the ~60 ms claude takes to answer can still confirm each
  // other — a receipt is per paste, not per image.
  let floor = 0
  for (const n of opts.before) floor = Math.max(floor, n)
  for (;;) {
    let fresh = 0
    for (const n of imagePlaceholderNumbers(opts.read())) if (n > floor) fresh++
    if (fresh >= opts.expected) return 'confirmed'
    if (now() >= deadline) return 'unconfirmed'
    await sleep(opts.pollMs ?? IMAGE_PASTE_POLL_MS)
  }
}

/** The receipt shown on the terminal. The unconfirmed one says what we KNOW: the path went in. */
export function imagePasteNotice(outcome: ImagePasteOutcome, expected: number): { text: string; ok: boolean } {
  if (outcome === 'confirmed')
    return { text: expected === 1 ? 'Image attached' : `${expected} images attached`, ok: true }
  return {
    text:
      expected === 1
        ? 'Pasted the path — not confirmed as an image'
        : 'Pasted the paths — not confirmed as images',
    ok: false
  }
}

export const IMAGE_PASTE_NOTICE_MS = { ok: 1600, warn: 5000 } as const

/**
 * Paste `text` (the escaped path list) into `term`, and — when the pane's agent is one whose image
 * handling we measured — report whether it attached the images. `before` is taken from the screen
 * BEFORE the paste leaves, so a placeholder already on screen can never confirm this paste.
 * A terminal disposed mid-wait (parked, released) reports nothing: there is no screen to read.
 */
export function pasteWithImageReceipt(
  term: Pick<Terminal, 'buffer' | 'rows' | 'paste'>,
  text: string,
  paths: string[],
  agentId: string | undefined,
  report: (notice: { text: string; ok: boolean }) => void
): void {
  const expected = expectedImagePlaceholders(agentId, paths)
  let before: Set<number> | null = null
  if (expected) {
    try {
      before = imagePlaceholderNumbers(xtermScreenText(term))
    } catch {
      before = null
    }
  }
  term.paste(text)
  if (!expected || !before) return
  void confirmImagePaste({ before, expected, read: () => xtermScreenText(term) }).then(
    (outcome) => report(imagePasteNotice(outcome, expected)),
    () => {}
  )
}

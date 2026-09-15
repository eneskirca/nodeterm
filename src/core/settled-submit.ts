/**
 * Paste an agent-message envelope, then submit it in a SECOND write once the pane has visibly
 * settled. One algorithm for every backend that delivers one: the Server Edition's tmux path, the
 * Windows session host and the direct Windows PTY.
 *
 * Why the Enter cannot ride the paste. A composer can accept a bracketed paste asynchronously: the
 * close marker has been written, but an Enter queued right behind it is consumed before the TUI has
 * installed the pasted block, so the next key submits both messages together (measured on a fresh
 * Claude pane, Server Edition). On Windows the same shape leaves the message unsubmitted: Codex
 * 0.154 under the session host rendered the whole envelope in its composer and treated the trailing
 * `\r` of the same write as part of the paste, so the delivery reported `stalled` with the text
 * sitting unsent; a bare Enter sent moments later submitted it and the agent answered (measured
 * 2026-09-14). Both are the same fix: paste, observe the envelope footer (or a stable change), then
 * submit separately.
 *
 * The boolean means "the envelope reached the pane", not "Enter was observed". Once the paste
 * succeeds, a capture or submit failure still returns true so the receipt watcher can report
 * `stalled`; false would misreport a partially delivered message as `targetGone`.
 */

export const ENVELOPE_SETTLE_POLL_MS = 40
export const ENVELOPE_SETTLE_POLLS = 15

export interface SettleSurface {
  /** The pane's visible text now, or null when it cannot be read. Never throws. */
  capture(): Promise<string | null>
  /** Write the envelope WITHOUT submitting. False means nothing reached the pane. Never throws. */
  paste(): Promise<boolean>
  /** Submit, in its own write. Called only after the pane settled. Never throws. */
  submit(): Promise<void>
}

export interface SettleOptions {
  wait?: (ms: number) => Promise<void>
  polls?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function visibleSnapshot(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd()
}

/**
 * Whitespace goes, and so do Braille pattern cells (U+2800–U+28FF): Codex paints an idle
 * animation of Braille dots over the composer area, and a dot landing between two characters of
 * the footer would otherwise hide it (observed on the same 2026-09-14 pane). The footer itself is
 * ASCII, so dropping those cells cannot create a match that is not there.
 */
function compact(value: string): string {
  return value.replace(/[\s⠀-⣿]+/g, '')
}

export async function pasteThenSubmitWhenSettled(
  envelope: string,
  surface: SettleSurface,
  options: SettleOptions = {}
): Promise<boolean> {
  if (!envelope) return false
  const snapshot = async (): Promise<string | null> => {
    const text = await surface.capture()
    return text === null ? null : visibleSnapshot(text)
  }
  const before = await snapshot()
  if (!(await surface.paste())) return false

  const footer = compact(envelope.split('\n').at(-1) ?? '')
  const wait = options.wait ?? delay
  const polls = Math.max(1, options.polls ?? ENVELOPE_SETTLE_POLLS)
  let priorChanged: string | null = null
  let settled = false

  for (let i = 0; i < polls; i++) {
    if (i > 0) await wait(ENVELOPE_SETTLE_POLL_MS)
    const current = await snapshot()
    if (current === null) continue
    if (footer && compact(current).includes(footer)) {
      settled = true
      break
    }
    if (current && current !== before) {
      if (current === priorChanged) {
        settled = true
        break
      }
      priorChanged = current
    } else {
      priorChanged = null
    }
  }

  // Unsettled: no Enter. A premature one is exactly the double-submit this exists to prevent; the
  // receipt watcher reports the non-retryable `stalled` instead.
  if (settled) await surface.submit()
  return true
}

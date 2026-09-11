// Two-act delivery of a node's one-shot launch command (initialCommand / cold-restore
// resume) into a freshly spawned shell. Writing line+Enter blind races shell init: zsh's
// rc/ZLE setup resets the tty with a FLUSH that can eat part of the queued line, and a
// mangled line submitted anyway strands the shell at `quote>` (field report: 3 spawned
// team agents, none started, each needed a manual `'` + Enter). So: write WITHOUT Enter,
// wait until the shell has echoed both ENDS of the line back, THEN submit. A verify timeout
// kills the pending line (Ctrl-U) and rewrites; the LAST attempt submits unverified —
// fail-open, a terminal whose echo we can't recognize must never block the launch (that
// worst case is exactly the pre-fix behavior).
//
// The ONE exception to failing open is a line the tty could not physically have taken: a
// canonical-mode buffer silently drops everything past its cap (1024 bytes on macOS), so an
// over-cap command is truncated mid-quote and Enter would strand the shell at `quote>` with the
// agent never launched (#706). That case is refused, not submitted — see `DeliveryOutcome` and
// @shared/canonical-line.

import { fitsLaunchLine } from '@shared/canonical-line'

export const VERIFY_TIMEOUT_MS = 2000
export const DELIVERY_ATTEMPTS = 3
/** Ctrl-U — clear the pending input line before a rewrite. Exported because the in-place restart
 *  choreography clears the line the same way before typing its exit command (agent-restart.ts). */
export const KILL_LINE = '\x15'

// CSI (\x1b[...X), OSC (\x1b]...BEL|ST) and single-char ESC sequences.
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** Echo stream → comparable text: drop escape sequences and line breaks (ZLE re-wraps a
 *  long line with explicit \r\n at the terminal width). */
export function cleanEcho(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(ESC_SEQ, '').replace(/[\r\n]/g, '')
}

/** Long enough to be unambiguous in the echo stream, short enough that a ZLE wrap/redraw
 *  sequence interleaved mid-line rarely lands inside either matched window. */
export const ECHO_EDGE_CHARS = 24

/**
 * Has the shell echoed the line? BOTH ENDS must appear, each as its own substring match.
 *
 * Tail-only (the original) was blind to a lost HEAD: an rc file that reads the same tty during
 * startup swallows leading characters — oh-my-zsh's update prompt does exactly this — and the
 * shell then echoes a line whose tail is fully intact, so verification passed and Enter
 * submitted a mangled command the shell ran as garbage (#556).
 *
 * Requiring the WHOLE command contiguously would catch that, but it is too strict: a ZLE
 * redraw can interleave printable prompt text inside the echoed line, so the cleaned stream
 * need not contain the command in one piece. That matters asymmetrically — the renderer would
 * merely stall and fail open, but the session-host leg clears the line and REFUSES the launch,
 * turning a cosmetic false negative into a node that never starts.
 *
 * Two edge windows keep both properties: a truncated head or tail fails, while junk in the
 * middle (or before the line) is tolerated. Commands shorter than 2×ECHO_EDGE_CHARS simply
 * compare as a whole, which is the strictest form and safe at that length.
 */
export function echoedIntact(cleanedSoFar: string, cmd: string): boolean {
  return (
    cleanedSoFar.includes(cmd.slice(0, ECHO_EDGE_CHARS)) &&
    cleanedSoFar.includes(cmd.slice(-ECHO_EDGE_CHARS))
  )
}

/**
 * How a delivery ended, for the callers that must tell the difference.
 *
 *  - `submitted` — Enter was written. Either the echo verified, or the last attempt failed OPEN
 *    (the historical behaviour: a terminal whose echo we cannot recognise must never block a
 *    launch). Every pre-existing caller treated a settle as exactly this.
 *  - `line-too-long` — the echo never verified AND the command is longer than a canonical-mode
 *    tty can carry (`MAX_LAUNCH_LINE_BYTES`), so the pane is holding a KNOWN-truncated line.
 *    Enter is NOT written; the pending line is killed instead. This is the one case where
 *    failing open is not a fail-open at all: submitting a line whose closing quote the kernel
 *    dropped strands the shell at `quote>` and the agent never starts (#706). A refusal the
 *    caller can show beats a pane that merely looks idle.
 *  - `cancelled` — the caller tore the delivery down (node unmount), or the transport threw.
 */
export type DeliveryOutcome = 'submitted' | 'line-too-long' | 'cancelled'

export interface DeliveryIo {
  write(data: string): void
  /** Subscribe to session output; returns unsubscribe. */
  onData(cb: (chunk: string) => void): () => void
}

/** Deliver `cmd` + Enter, echo-verified with bounded retries. Returns a cancel function
 *  (call on node teardown). `onSettled` fires exactly once when the delivery is over and reports
 *  whether the final Enter write succeeded, the line was too long, or delivery was cancelled.
 *  Callers can use this to know when the LINE has left the pane, not merely when it was started:
 *  the retries run for up to
 *  DELIVERY_ATTEMPTS × VERIFY_TIMEOUT_MS, and anything typed into the pane during that window
 *  lands inside the un-submitted line. The outcome argument is optional to read: every caller
 *  that only needs "the line has left the pane" keeps working unchanged. */
export function deliverCommand(
  io: DeliveryIo,
  cmd: string,
  onSettled?: (outcome: DeliveryOutcome) => void
): () => void {
  let done = false
  let attempt = 0
  let echoed = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsub: (() => void) | undefined

  const finish = (outcome: DeliveryOutcome = 'cancelled'): void => {
    if (done) return // a cancel after the submit must not re-announce the delivery
    done = true
    if (timer) clearTimeout(timer)
    unsub?.()
    onSettled?.(outcome)
  }
  /**
   * Every write goes through here. `io.write` is unguarded all the way down to the relay client's
   * `ws.send`, which throws InvalidStateError while the socket is still CONNECTING — and a throw
   * used to STRAND the delivery: it killed the retry callback before `submit()`, so `done` stayed
   * false, `onSettled` never fired, and whoever awaited it (the in-place restart) waited forever —
   * that node locked out of restarts for the rest of the app's run and the bulk loop hung with no
   * summary. A transport that cannot be written to ENDS the delivery instead: `finish()` first
   * (clearing the retry chain, so no rewrite lands in the pane seconds later, spliced under
   * whatever the user typed meanwhile), then report.
   *
   * `propagate` is for the FIRST write only, the one still on the caller's stack: there the throw
   * is the caller's answer — the restart counts it as a failure and tells the user to check the
   * pane. Later writes happen on timers and inside the PTY data callback, where a throw has
   * nowhere to go but the transport itself, so they are contained.
   */
  const write = (data: string, propagate = false): boolean => {
    try {
      io.write(data)
      return true
    } catch (e) {
      finish()
      if (propagate) throw e
      return false
    }
  }
  // Mark closed BEFORE writing Enter: an io whose write echoes back synchronously (the in-place
  // restart choreography feeds one) would otherwise re-enter the listener below while the tail
  // still matches, and submit forever. Announce success only AFTER that final write returns: the
  // old ordering let a rejected Enter auto-dismiss a restart as successful.
  const submit = (): void => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    unsub?.()
    let outcome: DeliveryOutcome = 'cancelled'
    try {
      io.write('\r')
      outcome = 'submitted'
    } catch {
      // The transport rejected Enter. Report the failed submission below.
    }
    // Deliberately outside the transport try/catch: a caller callback that throws must still be
    // invoked exactly once, and its own exception keeps propagating to that caller.
    onSettled?.(outcome)
  }
  const tryOnce = (): void => {
    if (done) return
    attempt += 1
    echoed = ''
    // Arm the verify timer BEFORE the write, for the same synchronous-echo io: an echo landing
    // inside write() finishes the delivery, and a timer armed after that would outlive it.
    timer = setTimeout(() => {
      if (done) return
      if (attempt >= DELIVERY_ATTEMPTS) {
        // Fail-open — UNLESS the tty provably could not have taken the line. An unverified echo
        // is usually our own blindness (an exotic prompt, a redraw we cannot parse) and submitting
        // is then the right bet. An over-cap line is different in kind: the kernel discarded its
        // tail while the pane was in canonical mode, so Enter would submit a command we KNOW is
        // cut in half. Kill the pending line and report instead. See @shared/canonical-line.
        if (!fitsLaunchLine(cmd)) {
          write(KILL_LINE)
          finish('line-too-long')
          return
        }
        submit() // fail-open: unverified submit beats a never-launched agent
        return
      }
      if (!write(KILL_LINE)) return // transport gone — the delivery is over, not stuck
      tryOnce()
    }, VERIFY_TIMEOUT_MS)
    write(cmd, attempt === 1)
  }

  unsub = io.onData((chunk) => {
    if (done) return
    echoed += cleanEcho(chunk)
    if (echoedIntact(echoed, cmd)) {
      if (timer) clearTimeout(timer)
      submit()
    }
  })
  tryOnce()
  return () => finish()
}

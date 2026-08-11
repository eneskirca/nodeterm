// Two-act delivery of a node's one-shot launch command (initialCommand / cold-restore
// resume) into a freshly spawned shell. Writing line+Enter blind races shell init: zsh's
// rc/ZLE setup resets the tty with a FLUSH that can eat part of the queued line, and a
// mangled line submitted anyway strands the shell at `quote>` (field report: 3 spawned
// team agents, none started, each needed a manual `'` + Enter). So: write WITHOUT Enter,
// wait until the shell has echoed the tail of the line back, THEN submit. A verify timeout
// aborts the pending line (Ctrl-C) and rewrites; the LAST attempt submits unverified —
// fail-open, a terminal whose echo we can't recognize must never block the launch (that
// worst case is exactly the pre-fix behavior).

export const VERIFY_TIMEOUT_MS = 2000
export const DELIVERY_ATTEMPTS = 3
/** Long enough to be unambiguous in the echo stream, short enough that a ZLE wrap/redraw
 *  sequence interleaved mid-line rarely lands inside the matched window. */
export const ECHO_TAIL_CHARS = 24
/** Ctrl-U — clear the pending input line before a rewrite. Exported because the in-place restart
 *  choreography clears the line the same way before typing its exit command (agent-restart.ts),
 *  where the pane is owned by an agent TUI reading raw stdin — its own kill-line binding, not the
 *  host shell's line editor. Do NOT use it against a SHELL prompt; see ABORT_LINE. */
export const KILL_LINE = '\x15'
/**
 * Ctrl-C — abandon whatever the previous attempt left in the SHELL's line editor, so the rewrite
 * below starts from a clean prompt.
 *
 * This is deliberately not Ctrl-U, which is what a POSIX-only reading of "clear the line" asks
 * for. PSReadLine — the line editor every Windows PowerShell pane runs — ships `EditMode=Windows`,
 * and in that mode Ctrl-U is simply UNBOUND: it self-inserts and renders as a literal `^U`. The
 * retry meant to repair a half-eaten line was therefore CREATING one, and the fail-open submit at
 * the end of the attempts ran `^Uclaude` — an unknown command, the agent never launched. Measured
 * on a psmux/PowerShell pane: `PS …> claude^Uclaude`.
 *
 * Ctrl-C is the one abort every line editor in scope honors — PSReadLine binds it to
 * CopyOrCancelLine (cancels, with nothing selected), and POSIX shells discard the line on SIGINT.
 * Keying this off the platform instead would be wrong twice over: the behavior belongs to the
 * SHELL, not the OS, so a `win32` branch would hand ESC to a Git Bash pane on Windows (where ESC
 * is readline's Meta prefix and would mangle the command's first character), and nothing the
 * renderer can see at delivery time names the shell anyway.
 *
 * Safe on an already-empty prompt, which is the common case here — the attempt that timed out
 * usually never reached the line editor at all: it prints a bare `^C` and redraws the prompt.
 */
export const ABORT_LINE = '\x03'

// CSI (\x1b[...X), OSC (\x1b]...BEL|ST) and single-char ESC sequences.
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** Echo stream → comparable text: drop escape sequences and line breaks (ZLE re-wraps a
 *  long line with explicit \r\n at the terminal width). */
export function cleanEcho(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(ESC_SEQ, '').replace(/[\r\n]/g, '')
}

/** Has the shell echoed the full line? Tail-match: the head is polluted by the prompt. */
export function echoedIntact(cleanedSoFar: string, cmd: string): boolean {
  return cleanedSoFar.includes(cmd.slice(-ECHO_TAIL_CHARS))
}

export interface DeliveryIo {
  write(data: string): void
  /** Subscribe to session output; returns unsubscribe. */
  onData(cb: (chunk: string) => void): () => void
}

/** Deliver `cmd` + Enter, echo-verified with bounded retries. Returns a cancel function
 *  (call on node teardown). `onSettled` fires exactly once when the delivery is over — submitted
 *  (verified or fail-open) or cancelled — for callers that must know when the LINE has left the
 *  pane, not merely when it was started: the retries run for up to
 *  DELIVERY_ATTEMPTS × VERIFY_TIMEOUT_MS, and anything typed into the pane during that window
 *  lands inside the un-submitted line. */
export function deliverCommand(io: DeliveryIo, cmd: string, onSettled?: () => void): () => void {
  let done = false
  let attempt = 0
  let echoed = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsub: (() => void) | undefined

  const finish = (): void => {
    if (done) return // a cancel after the submit must not re-announce the delivery
    done = true
    if (timer) clearTimeout(timer)
    unsub?.()
    onSettled?.()
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
  // Close the delivery BEFORE writing Enter: an io whose write echoes back synchronously (the
  // in-place restart choreography feeds one) would otherwise re-enter the listener below while
  // the tail still matches, and submit forever.
  const submit = (): void => {
    finish()
    write('\r')
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
        submit() // fail-open: unverified submit beats a never-launched agent
        return
      }
      if (!write(ABORT_LINE)) return // transport gone — the delivery is over, not stuck
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
  return finish
}

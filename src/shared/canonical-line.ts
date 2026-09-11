/**
 * HOW LONG A LINE TYPED INTO A PANE MAY BE — the tty's limit, not ours.
 *
 * A launch command is delivered by typing it into the pane's tty and then pressing Enter. While
 * that tty is in CANONICAL mode the kernel buffers the line itself, and a line longer than the
 * driver's canonical buffer is **silently truncated**: the tail is dropped, no error is raised,
 * and the Enter that follows submits whatever survived. For a launch line that ends in a quoted
 * prompt the survivor is an unterminated quote, so the shell sits at `quote>` and the agent never
 * starts — a pane that merely looks idle (issue #706).
 *
 * MEASURED, on a real pty whose slave was left in canonical mode:
 *  - Linux (N_TTY, `N_TTY_BUF_SIZE`): 4000 bytes + `\n` arrived whole; 5000 bytes came back as
 *    4096 with the newline gone.
 *  - macOS (`MAX_CANON`, `<sys/syslimits.h>`): 1024. Reported and measured by #706 on 25.5.0.
 *
 * Two consequences the code depends on:
 *
 *  1. **Chunking the WRITE does not help.** The cap is on the assembled LINE, not on any single
 *     `write()`. Measured: 5000 bytes delivered as one write, as 512-byte writes and as 100-byte
 *     writes all arrived as the same truncated 4096. So "write it in pieces" is not a fix, and
 *     nothing here should be refactored into one.
 *  2. **The budget must be the SMALLEST cap of any machine a pane can be on**, not this machine's.
 *     The renderer types into panes that live on an SSH host, a relay peer or the Server Edition's
 *     own box, and it cannot know their platform — a Linux desktop driving a macOS host would
 *     otherwise compute a 4096-byte budget for a 1024-byte tty. 1024 it is.
 *
 * The cap only bites while the tty is CANONICAL — an interactive shell's line editor (readline,
 * ZLE) puts it in raw mode, where no such limit applies. That is why a long line usually works:
 * delivery normally lands after the prompt is up. It is not something we may rely on. Measured on
 * this box: `bash -i` leaves canonical mode within 50 ms, but `sh -i` (dash — no line editor)
 * stays canonical for the whole life of the pane, so on an editor-less shell EVERY over-cap line
 * truncates, always. Startup is the other window: an rc file that reads the same tty (oh-my-zsh's
 * update prompt is the documented example — see `echoedIntact`) holds the pane canonical for as
 * long as it waits.
 */

/** macOS `MAX_CANON`. The smallest canonical-mode line buffer across the platforms we ship to. */
export const MAX_CANON_BYTES = 1024

/**
 * The longest command we will type into a pane, in bytes. One byte under `MAX_CANON_BYTES`
 * because the CR that submits the line is buffered with it — measured above: a 4000-byte payload
 * plus its newline fit a 4096-byte buffer, 5000 did not.
 */
export const MAX_LAUNCH_LINE_BYTES = MAX_CANON_BYTES - 1

/** Byte length, not character length: the tty buffers bytes, and a prompt is rarely pure ASCII. */
export function lineBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Can this command be typed into a pane whole? */
export function fitsLaunchLine(command: string): boolean {
  return lineBytes(command) <= MAX_LAUNCH_LINE_BYTES
}

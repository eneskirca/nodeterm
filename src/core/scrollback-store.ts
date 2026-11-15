import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { renameAtomic, tempNameFor } from './fs-atomic'
import { platform } from './platform'
import { shellSingleQuote } from '../shared/shell-quote'

// On a machine reboot the tmux server dies, so the live scrollback is lost. We persist a
// byte-capped snapshot of each terminal's recent output to disk while it's running and replay
// it into xterm on a cold restart, so the user sees where they left off (a cold
// restore). Warm reattach (app restart, tmux alive) ignores the snapshot — tmux redraws.

const DIR_NAME = 'terminal-scrollback'
// Trailing bytes we keep / replay. Enough for a few screens of context without bloating disk
// or stalling the renderer on replay.
const MAX_BYTES = 256 * 1024

function dir(): string {
  return path.join(platform().userDataDir, DIR_NAME)
}

// persistKey is a node id (uuid-ish) but may contain arbitrary characters; hash it to a safe,
// fixed-length filename.
function snapshotPath(persistKey: string): string {
  const hash = createHash('sha256').update(persistKey).digest('hex').slice(0, 32)
  return path.join(dir(), `${hash}.bin`)
}

/** Keep only the trailing `MAX_BYTES`, not splitting a UTF-8 sequence at the cut point. */
function trailing(data: string): Buffer {
  const bytes = Buffer.from(data, 'utf-8')
  if (bytes.length <= MAX_BYTES) return bytes
  let start = bytes.length - MAX_BYTES
  // advance past any continuation bytes (0b10xxxxxx) so we start on a code-point boundary
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start)
}

// All async (fs.promises): snapshots fire per session on a 15s timer and in bursts when many
// nodes detach at once (project switch / quit) — sync writes here blocked the main event loop,
// which stalls PTY streaming and all IPC.
/** Never throws. Resolves true only when the snapshot actually landed on disk — a caller that
 *  remembers what it wrote (pty-manager's digest skip) must not remember a failed write. */
export async function writeScrollback(persistKey: string, data: string): Promise<boolean> {
  if (!data) return false
  const file = snapshotPath(persistKey)
  // Unique tmp per call: overlapping writes for the same key (timer tick + detach snapshot)
  // must not interleave into one tmp file and rename a torn write into place.
  const tmp = tempNameFor(file)
  try {
    await fs.promises.mkdir(dir(), { recursive: true })
    await fs.promises.writeFile(tmp, trailing(data))
    await renameAtomic(tmp, file)
    return true
  } catch {
    // best-effort: a failed snapshot just means no cold-restore replay for this node
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

export async function readScrollback(persistKey: string): Promise<string> {
  try {
    return await fs.promises.readFile(snapshotPath(persistKey), 'utf-8')
  } catch {
    return ''
  }
}

export async function deleteScrollback(persistKey: string): Promise<void> {
  try {
    await fs.promises.rm(snapshotPath(persistKey), { force: true })
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------------------------
// Cold-restore SEEDING: put the snapshot into the new tmux pane, not into the emulator.
//
// tmux owns the client's screen: on attach it switches the emulator to the ALTERNATE screen
// (`\e[?1049h`) and clears it, and the wheel scrolls tmux's own history. A snapshot the renderer
// writes into xterm therefore lands on the normal screen and is hidden an instant later, with no
// way to scroll back to it — measured: after "snapshot, then a fresh attach's bytes" the active
// buffer is `alternate` and empty. That was the whole cold-restore feature silently doing nothing
// on every tmux-backed terminal.
//
// So for a tmux-backed cold start the snapshot is written to the new PANE's tty instead. It becomes
// ordinary pane output: tmux paints it, keeps it in its history, and the wheel scrolls it. The
// write is chained onto the same `new-session` invocation (`run-shell`), so it needs no polling
// and does not change how the user's shell is started.
//
// Known limit, measured (tmux 3.4, attached client): the write races the shell's first prompt. A
// shell that reads startup files loses to it — a login bash: snapshot first, prompt after, 15/15.
// A shell with nothing to read (`bash --norc`, dash) prompts within ~2 ms and wins, 14/15; so the
// seed opens by erasing the current line, and in that case the restored text is followed by no
// prompt until the user presses Enter. Cosmetic — the content is restored either way.
// ---------------------------------------------------------------------------------------------

/** The separator printed under restored scrollback — the same wording the renderer prints when
 *  it replays a snapshot itself (the non-tmux backends; TerminalNode.tsx). */
export const SESSION_RESTORED_LINE =
  '\x1b[90m── session restored (process ended by a restart) ──\x1b[0m'

/**
 * The bytes written to a fresh pane's tty: the snapshot (CRLF line ends — it comes from
 * `capture-pane -p`, LF only, and must not depend on the tty still having `onlcr`), trailing blank
 * rows dropped (a capture includes the empty rows below the cursor), then the separator.
 * '' when there is nothing worth restoring.
 */
export function buildScrollbackSeed(snapshot: string): string {
  const body = snapshot.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (!body) return ''
  return (
    '\r\x1b[2K' + body.replace(/\n/g, '\r\n') + '\x1b[0m\r\n' + SESSION_RESTORED_LINE + '\r\n'
  )
}

function seedPath(persistKey: string): string {
  return snapshotPath(persistKey).replace(/\.bin$/, '.seed')
}

/**
 * Stage the seed file for `persistKey`'s cold start. Returns its path, or null when there is no
 * snapshot (or it could not be staged) — in which case nothing is seeded and nothing breaks.
 */
export async function prepareScrollbackSeed(persistKey: string): Promise<string | null> {
  const seed = buildScrollbackSeed(await readScrollback(persistKey))
  if (!seed) return null
  const file = seedPath(persistKey)
  try {
    await fs.promises.mkdir(dir(), { recursive: true })
    await fs.promises.writeFile(file, seed, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

/**
 * tmux arguments to APPEND to a `new-session` invocation so the staged seed is written into the
 * pane that invocation creates. Each element is one argv entry (the lone `;` is tmux's command
 * separator), so nothing here is parsed by a shell on our side; the `run-shell` body is, and the
 * seed path is single-quoted for it — with `#` doubled first, because `run-shell` format-expands
 * its command and a `#` in the user-data path would otherwise be read as a format.
 *
 * `#{history_size}` is the guard for the one case `-A` leaves open: if the session turned out to
 * exist after all (it was created between our `has-session` probe and this spawn), the pane is
 * live and must not have an old snapshot dumped into it. A pane this invocation created has no
 * history yet. The seed file is removed either way, and the body always exits 0 — a non-zero
 * `run-shell` makes tmux put the pane into view mode to show the failure.
 */
export function scrollbackSeedTmuxArgs(seedFile: string, session: string): string[] {
  const file = shellSingleQuote(seedFile).replace(/#/g, '##')
  return [
    ';',
    'run-shell',
    '-b',
    '-t',
    session,
    `{ [ '#{history_size}' = 0 ] && cat ${file} > '#{pane_tty}'; rm -f ${file}; } 2>/dev/null; :`
  ]
}

// The SSH leg of session memory: an SSH project's sessions live on the HOST, so the sweep must
// happen there. Core generates one POSIX sh line, the shell runs it over the project's
// ControlMaster, and only the printed sections come back — the same division of labour as
// remote-claude-usage.ts (core owns the command AND the parsing; the shell owns the master).
//
// One round trip carries all three facts, because each extra `ssh` exec is a login on someone
// else's machine.

import {
  buildReport,
  isNoServerError,
  parsePaneList,
  parseProcessTable,
  PANE_FMT,
  type MemInfo,
  type PaneRef,
  type SessionMemoryReport
} from './session-memory'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

const MEM = '##MEM'
const PANES = '##PANES'
const PROCS = '##PROCS'
/** Per-socket fence inside the `##PANES` section: `##SOCK <name>` opens it, `##SOCKRC <n>` closes
 *  it with that socket's tmux exit status. See `parsePanesSection` for why it exists. */
const SOCK = '##SOCK'
const SOCKRC = '##SOCKRC'

/** The sockets the remote sweep lists, in the order it lists them (the local leg's default order —
 *  `bySession` is first-wins, so the order decides which socket a duplicate name is attributed to). */
const SWEEP_SOCKETS: readonly string[] = [TMUX_SOCKET, RMT_TMUX_SOCKET]

/**
 * The generated command. Notes that are load-bearing:
 *  - Every section header is printed unconditionally, so a MISSING one means the read was cut
 *    short (dead master, killed mid-stream) rather than "the host had nothing".
 *  - The headers are QUOTED. `echo ##MEM` prints an EMPTY LINE: an unquoted `#` at the start of a
 *    word begins a comment in POSIX sh, so the marker is eaten by the shell and every report comes
 *    back `ok:false`. Measured under dash. Do not drop the quotes. (`"${SOCKRC} $?"` is
 *    double-quoted for the same reason AND so `$?` still expands.)
 *  - Each socket gets its OWN fence, and its tmux stderr is folded into the fence (`2>&1`) rather
 *    than thrown away. This is the remote counterpart of the local leg's `isNoServerError`: the
 *    exit status alone cannot tell "there is no tmux server on this socket" (an ANSWER, and the
 *    normal state of a socket nobody has used) from "the tmux client is broken / the socket dir
 *    belongs to another uid / the server hung" (NOT an answer). The previous form —
 *    `{ tmux …; tmux …; } || true` with stderr discarded — collapsed both into an empty section,
 *    so a host running thirty sessions with a broken tmux reported `{ok:true, rows:[]}` and the
 *    panel said "No sessions are running here."
 *  - Nothing after a socket's own line can fail the script: `$?` is consumed by the very next
 *    `echo`, so the command still exits 0 for the shell's exit-code gate.
 *  - The socket names and the `-F` format come from the shared constants, so the remote sweep can
 *    never look at a different socket, or ask for different fields, than the local one.
 *  - `ps -eo pid,ppid,rss` is used even on Linux hosts: it is one process instead of thousands of
 *    /proc reads over a link we do not control, and its output is what we already parse.
 */
export function remoteSessionMemoryCommand(): string {
  const listPanes = (socket: string): string =>
    [
      `echo '${SOCK} ${socket}'`,
      `tmux -L ${socket} list-panes -a -F '${PANE_FMT}' 2>&1`,
      `echo "${SOCKRC} $?"`
    ].join('\n')
  return [
    `echo '${MEM}'`,
    `cat /proc/meminfo 2>/dev/null | grep -E '^(MemAvailable|MemTotal):' 2>/dev/null || true`,
    `echo '${PANES}'`,
    ...SWEEP_SOCKETS.map(listPanes),
    `echo '${PROCS}'`,
    `ps -eo pid,ppid,rss 2>/dev/null || true`
  ].join('\n')
}

function parseMem(lines: string[]): MemInfo | null {
  let availableMb: number | null = null
  let totalMb: number | null = null
  for (const l of lines) {
    const a = /MemAvailable:\s+(\d+)\s*kB/.exec(l)
    if (a) availableMb = Math.round(Number(a[1]) / 1024)
    const t = /MemTotal:\s+(\d+)\s*kB/.exec(l)
    if (t) totalMb = Math.round(Number(t[1]) / 1024)
  }
  return availableMb !== null && totalMb !== null ? { availableMb, totalMb } : null
}

/**
 * The `##PANES` section, one fenced block per socket. Returns how many sockets ANSWERED and the
 * panes they reported.
 *
 * "Answered" is the same distinction the local leg draws with `isNoServerError`, applied to the
 * SAME classifier (a second copy would drift — this branch's ledger records three such drifts):
 *  - exit 0 → the socket answered, and its lines are panes;
 *  - non-zero with tmux's own "no server running" / "error connecting to … (no such file or
 *    directory)" → the socket answered "there is nothing here", which is the normal state of a
 *    socket nobody has used;
 *  - any other failure (a tmux client missing a shared library exits 127 on EVERY socket, a
 *    socket dir owned by another uid, a hung server timing out) → NOT an answer.
 *  - a block with no `##SOCKRC` line at all → the stream was cut mid-socket; NOT an answer.
 *
 * The block header is matched against the sockets we actually asked for, and the closer against
 * `##SOCKRC <digits>`, so neither can be forged by a pane whose session name or foreground command
 * happens to start with the marker text.
 */
function parsePanesSection(lines: readonly string[]): { answered: number; panes: PaneRef[] } {
  const headers = new Map(SWEEP_SOCKETS.map((s) => [`${SOCK} ${s}`, s]))
  let answered = 0
  const panes: PaneRef[] = []
  let buf: string[] | null = null
  for (const line of lines) {
    if (headers.has(line)) {
      // A new fence with the previous one still open means the previous socket's status never
      // arrived. It did not answer, and its buffered lines are not trustworthy panes.
      buf = []
      continue
    }
    const rc = /^##SOCKRC (\d+)$/.exec(line)
    if (rc && buf !== null) {
      if (rc[1] === '0') {
        answered++
        panes.push(...parsePaneList(buf.join('\n')))
      } else if (isNoServerError(buf.join('\n'))) {
        answered++
      }
      buf = null
      continue
    }
    if (buf !== null) buf.push(line)
  }
  return { answered, panes }
}

/** Split the fenced sections and reuse the LOCAL assembly, so both legs cannot drift. */
export function parseRemoteSessionMemory(stdout: string): SessionMemoryReport {
  // Tolerant of a CR-terminated stream (an ssh channel that ended up on a pty): the section
  // markers are matched whole-line, so a stray \r would hide every one of them.
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''))
  const iMem = lines.indexOf(MEM)
  const iPanes = lines.indexOf(PANES)
  const iProcs = lines.indexOf(PROCS)
  // Two distinct failures, both of which must read as "we could not look", never as "nothing here":
  //  - a MISSING header (a `-1`) means the stream was cut short — a master that died mid-read;
  //  - headers OUT OF ORDER mean the stream is not ours to trust. An ssh exec channel is not a
  //    clean pipe: a login shell's rc file writing to stdout is a documented hazard in this repo
  //    (it is why the remote `claude --version` probe goes through a login shell deliberately), so
  //    a `.profile` that echoes `##PROCS` is enough to put a marker ahead of `##MEM`. Unchecked,
  //    the panes slice would come out empty while `ps` still parsed from the tail, and the report
  //    would be a confident `{ok:true, rows:[]}` — "this host has nothing" over live sessions.
  // The ordering test subsumes the `-1` check (a -1 can never sit below a found index), but both
  // are spelled out because they are different diagnoses of a broken read.
  if (iMem < 0 || iPanes < 0 || iProcs < 0) return { ok: false, rows: [], mem: null }
  if (!(iMem < iPanes && iPanes < iProcs)) return { ok: false, rows: [], mem: null }

  const mem = parseMem(lines.slice(iMem + 1, iPanes))
  const { answered, panes } = parsePanesSection(lines.slice(iPanes + 1, iProcs))
  const table = parseProcessTable(lines.slice(iProcs + 1).join('\n'))
  // A host always has processes, so an empty table means `ps` never ran (or its output was lost).
  if (table.length === 0) return { ok: false, rows: [], mem }
  // Nobody answered: a broken tmux client, a socket dir owned by another uid, a hung server. We did
  // not look, so we cannot claim the host has nothing — that would print "No sessions are running
  // here." over thirty live ones. Exactly the local leg's rule (`collectSessionMemory`), and the
  // reason a blunt "any error ⇒ ok:false" is wrong: on a host with no tmux server at all EVERY
  // socket fails, and there the honest answer is "there are no sessions".
  if (answered === 0) return { ok: false, rows: [], mem }

  // Both sockets print into the SAME section (each behind its own fence) and `list-panes -a` emits
  // a line per PANE, so a session can appear several times. First pane of a session wins — one
  // session is one row, exactly as the local leg's `bySession` map guarantees.
  const bySession = new Map<string, PaneRef>()
  for (const p of panes) if (!bySession.has(p.session)) bySession.set(p.session, p)
  return buildReport([...bySession.values()], table, mem)
}

/** Runs a POSIX sh command on the project's host; resolves stdout, or null if it could not run. */
export type RemoteSessionMemoryRunner = (
  projectId: string,
  command: string
) => Promise<string | null>

export async function fetchRemoteSessionMemory(
  projectId: string,
  run: RemoteSessionMemoryRunner
): Promise<SessionMemoryReport> {
  let stdout: string | null = null
  try {
    stdout = await run(projectId, remoteSessionMemoryCommand())
  } catch {
    return { ok: false, rows: [], mem: null }
  }
  // A dead master says nothing about what the host is running.
  if (stdout === null) return { ok: false, rows: [], mem: null }
  return parseRemoteSessionMemory(stdout)
}

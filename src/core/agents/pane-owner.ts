/**
 * WHO OWNS A PANE — read from the kernel, not from a name allowlist.
 *
 * The question this module answers is not `#{pane_current_command}`. That is one name, tmux's own
 * shallow reading of the pane's process, and it is wrong in both directions for a safety gate:
 *
 *  - measured on this host, a pane running the fake agent `…/fakebin/claude --resume x` (a
 *    `#!/usr/bin/env node` script) reports `#{pane_current_command}` = `node`. Every npm-installed
 *    agent CLI has that shape, so a name gate cannot tell claude from any other node process.
 *  - `isShellCommand` (`src/shared/agents/pane.ts`) was then a SEVEN-name allowlist, so `!isShellCommand`
 *    — the old "this pane is an agent" gate — is true for `nu`, `pwsh`, `xonsh`, `elvish`, `ssh`
 *    and `python`. Text delivered there executes, because `sendText` appends Enter.
 *
 * The kernel already tracks the right thing: every terminal has a FOREGROUND PROCESS GROUP
 * (`tcgetpgrp`), and only that group can read the tty. Whatever is in it is what will receive the
 * bytes we are about to write. So: `#{pane_tty}` from tmux, then one `ps` on that tty, then the
 * argv of the group the kernel marks as the foreground one. Nothing here is spoofable by a
 * persisted field going stale.
 *
 * ── THE MEASUREMENT (Global Constraint: measure the shape, do not assume it) ────────────────────
 *
 * Run on this host, Linux 6.8, procps-ng 4.0.4, against a tmux session on a private socket
 * (2026-08-15):
 *
 *   $ tmux -L probe display-message -p -t owner-probe '#{pane_pid}|#{pane_tty}|#{pane_current_command}'
 *   2485382|/dev/pts/0|sh
 *   $ ps -ww -o pid=,pgid=,stat=,args= -t /dev/pts/0
 *   2485382 2485382 Ss   -bash                        <- the pane's own shell, NOT foreground
 *   2489089 2489089 S+   /bin/sh -c sleep 200 | cat   <- the foreground group, three members
 *   2489091 2489089 S+   sleep 200
 *   2489092 2489089 S+   cat
 *
 * Two facts the plan's sketch got wrong here, both measured rather than reasoned:
 *
 *  1. `ps -g <pgid>` does NOT select a process group on this procps. `-g` selects by SESSION or by
 *     effective group NAME, and the GNU long option `--pgid` does not exist (`error: unknown gnu
 *     long option`). So the Linux-specific "read `tpgid`, then `ps -g` that pgid" route does not
 *     work here at all, and a second round-trip would have bought nothing.
 *  2. Selecting by TTY works identically on Linux and BSD — `-t /dev/pts/0` and `-t pts/0` are both
 *     accepted — and `stat`'s `+` flag marks foreground-group membership on BOTH (procps STAT and
 *     BSD STAT define `+` the same way: "in the foreground process group of its controlling
 *     terminal"). `tpgid` is a procps-only column, so asking for it is what would have forced a
 *     `process.platform === 'darwin'` branch.
 *
 * Hence ONE invocation for both platforms — `ps -ww -o pid=,pgid=,stat=,args= -t <tty>` — and the
 * foreground group derived from the `+` flag rather than from a column only Linux has. `-ww` is
 * load-bearing on BSD, where `ps` truncates the command to the terminal width by default; a
 * truncated argv would hide the script path that names the agent.
 *
 * macOS was NOT reachable from the host this was measured on, so the darwin leg is unverified —
 * but it is unverified for a shape whose every piece is POSIX/BSD-documented, rather than for a
 * `tpgid` column BSD is documented not to have. **Mac verification owed.** If `ps` fails on some
 * platform, `parseForegroundArgv` answers `[]`, `PtyManager.paneOwner` answers `null`, and gate 1
 * refuses there — a refusal, never a guess.
 *
 * No credential is involved anywhere in this module — a tty path and a pid are the only inputs — so
 * Global Constraint 6 ("no credential on any argv") is trivially satisfied. Do not add one: if this
 * read ever needs to authenticate, it needs a stdin channel, not a flag.
 */
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'

/** What one `display-message` round-trip yields: everything but the per-process facts (`argv` and
 *  `pids`), which only `ps` can answer. Spelled out rather than `Omit<PaneOwner, 'argv'>` so a new
 *  field on `PaneOwner` cannot silently become something tmux is expected to have answered. */
export interface PaneIdentity {
  panePid: number
  tty: string
  command: string
  paneId?: string
}

/**
 * One round-trip for the three fields the read needs. Same `|` separator as `session-memory.ts`'s
 * `PANE_FMT`, for the same reason: one string, one parser, no second copy to drift.
 */
export const PANE_OWNER_FMT = '#{pane_pid}|#{pane_tty}|#{pane_current_command}|#{pane_id}'

/**
 * Parse `display-message -p '<PANE_OWNER_FMT>'`.
 *
 * Same failure contract as `PtyManager.paneCommand`, copied deliberately: unknown is never evidence
 * of a particular command, so anything malformed answers null rather than a partial object. A pid
 * of 0 is rejected the way `parsePaneList` rejects it — an empty field parses as 0 and would
 * produce a phantom pane.
 */
export function parsePaneOwner(stdout: string | null | undefined): PaneIdentity | null {
  if (!stdout) return null
  const line = stdout.trim().split('\n')[0]?.trim()
  if (!line) return null
  const parts = line.split('|')
  if (parts.length < 3) return null
  const panePid = Number(parts[0])
  if (!Number.isInteger(panePid) || panePid <= 0) return null
  const tty = parts[1].trim()
  const command = parts[2].trim()
  if (!tty || !command) return null
  // `#{pane_id}` is APPENDED rather than placed first so a three-field read — an older format
  // string, or a tmux that expanded the name to nothing — still parses into the same three fields
  // it always did. Validated to tmux's own shape (`%<digits>`) because a field that is sometimes
  // absent and sometimes garbage is worse than one that is simply absent: `samePane` treats an
  // absent id as "cannot confirm", and that must mean what it says.
  const rawId = parts[3]?.trim()
  const paneId = rawId && /^%\d+$/.test(rawId) ? rawId : undefined
  return { panePid, tty, command, ...(paneId ? { paneId } : {}) }
}

/**
 * Is this a pty path safe to carry into a command line?
 *
 * `#{pane_tty}` is kernel-supplied (`/dev/pts/N`, `/dev/ttys00N`) and not user-controllable, so
 * this is the second layer, applied where the value ENTERS a command line — the same posture as
 * `remote-safety.ts`'s `isSafeNodeId`. It matters most on the SSH leg, where the value is spliced
 * into a string a REMOTE shell parses.
 */
export function isSafeTty(tty: string | null | undefined): boolean {
  if (!tty || tty.length > 128) return false
  return /^\/?(dev\/)?[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(tty) && !tty.includes('..')
}

/**
 * The `ps` invocation that lists every process on a pane's tty, with the columns
 * `parseForegroundArgv` reads. Returns null for a tty that fails `isSafeTty` — the caller then
 * answers null, i.e. "unknown", rather than running something it did not fully construct.
 *
 * `panePid` is deliberately NOT a parameter: the measurement above showed the pid-based selectors
 * (`-g <pgid>`, `--pgid`) do not do what the sketch assumed on this procps, and the tty is the
 * handle the kernel actually keys the foreground group on.
 */
export function foregroundArgvArgs(tty: string): { bin: string; args: string[] } | null {
  if (!isSafeTty(tty)) return null
  // -ww: BSD ps truncates `args` to the terminal width without it, which would cut off exactly the
  // script path that names the agent. Harmless (and also "unlimited") on procps.
  //
  // ONE `-o` PER KEYWORD, and it is not style. `-o pid=,pgid=,stat=,args=` is a single column on
  // the BSDs: FreeBSD's `bin/ps/keyword.c` `parsefmt()` treats an item containing `=` as "a column
  // header, may contain embedded separator characters and is always the last item" — it sets
  // `tempstr = NULL` and the header swallows the rest, so the whole string parses as the keyword
  // `pid` with the header `,pgid=,stat=,args=`. `ps` then exits 0 with one column and the read
  // silently never works. macOS is NOT affected — Apple's adv_cmds wraps that branch in
  // `#ifndef __APPLE__` and always `strsep`s on " \t,\n" — but FreeBSD/TrueNAS/pfSense is an
  // ordinary SSH target and this call runs on the REMOTE host.
  //
  // The multi-`-o` form is sanctioned by FreeBSD's own ps(1) ("Multiple keywords may also be given
  // in the form of more than one -o option… If all keywords have empty header texts, no header line
  // is written") and is byte-identical on procps-ng 4.0.4 — diffed against the single-`-o` form on
  // a real pane running `sleep 300 | cat`.
  return {
    bin: 'ps',
    args: [...PS_FOREGROUND_FLAGS, '-t', tty]
  }
}

/**
 * The `ps` flags of the foreground read, shared by the local argv builder above and the REMOTE
 * combined script (`remotePaneOwnerCombinedArgs`) so the two legs cannot drift — the same
 * anti-drift rule the session-memory sweep applies to its socket list. Flag-only (no tty), and
 * none of them contains a shell metacharacter, so joining them with spaces into an sh line is
 * byte-identical to passing them as argv.
 */
export const PS_FOREGROUND_FLAGS = [
  '-ww',
  '-o',
  'pid=',
  '-o',
  'pgid=',
  '-o',
  'stat=',
  '-o',
  'args=',
] as const

/** One parsed `ps` row. Internal — only the argv leaves this module. */
interface PsRow {
  pid: number
  pgid: number
  stat: string
  args: string
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/

function parsePsRows(stdout: string | null | undefined): PsRow[] {
  if (!stdout) return []
  const rows: PsRow[] = []
  for (const line of stdout.split('\n')) {
    const m = PS_ROW.exec(line)
    if (!m) continue // a header, an error message, a blank — skipped, never guessed at
    const pid = Number(m[1])
    const pgid = Number(m[2])
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid) || pgid <= 0) continue
    rows.push({ pid, pgid, stat: m[3], args: m[4] })
  }
  return rows
}

/**
 * Which process group owns the tty right now, from `stat`'s `+` flag.
 *
 * Null when no row is marked — an empty `ps`, a `ps` that errored, or a pane whose foreground group
 * exited between the two round-trips. Null means "unknown", and the caller must not fall back to
 * "the pane's own shell, probably": that guess is precisely the failure this module exists to end.
 */
export function foregroundPgid(stdout: string | null | undefined): number | null {
  for (const row of parsePsRows(stdout)) {
    if (row.stat.includes('+')) return row.pgid
  }
  return null
}

/**
 * Every command line in one process group, in the order `ps` listed them — pid order on both
 * platforms, which puts the group leader (the longest-lived member, e.g. the `sh -c` wrapper)
 * first.
 *
 * Rows from any other pgid are ignored: other panes never share a tty, but a job that was
 * backgrounded on this one does share the tty and must not be read as the owner.
 *
 * Garbage answers `[]` — never throws, never partially guesses.
 */
export function parseForegroundArgv(stdout: string | null | undefined, pgid: number): string[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return []
  return parsePsRows(stdout)
    .filter((row) => row.pgid === pgid)
    .map((row) => row.args)
}

/**
 * The pids of the same rows `parseForegroundArgv` returns, in the same order.
 *
 * A sibling rather than a change to `parseForegroundArgv`'s return type: that function has callers
 * and tests that want the argv alone, and a tuple return would make every one of them destructure
 * something they do not use. `ps` already prints the column, so this is free.
 */
export function parseForegroundPids(stdout: string | null | undefined, pgid: number): number[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return []
  return parsePsRows(stdout)
    .filter((row) => row.pgid === pgid)
    .map((row) => row.pid)
}

/**
 * The two round-trips joined: a parsed pane identity plus the `ps` output for its tty.
 *
 * Null — never a `PaneOwner` with an empty `argv` — when `ps` said nothing usable, so the caller
 * cannot mistake "nothing owns this" for "we could not see". Shared by the local and the SSH leg of
 * `PtyManager.paneOwner` so the two cannot drift into different readings of the same output.
 */
export function paneOwnerFrom(
  identity: PaneIdentity | null,
  psStdout: string | null | undefined
): PaneOwner | null {
  if (!identity) return null
  const pgid = foregroundPgid(psStdout)
  const argv = pgid === null ? [] : parseForegroundArgv(psStdout, pgid)
  const pids = pgid === null ? [] : parseForegroundPids(psStdout, pgid)
  // The ONE null-vs-owner decision, deliberately not two: "no foreground group marked" and "no rows
  // in it" are the same fact — we could not see who owns the pane — and a second guard for the
  // second phrasing would be a line no test can reach.
  if (argv.length === 0) return null
  // `argv` and `pids` line up row-for-row BY CONSTRUCTION: both are the same `parsePsRows` output,
  // filtered by the same pgid, mapped to different columns. A length guard here was written and
  // then removed — no input can reach it, and this file already says why that matters ("a second
  // guard for the second phrasing would be a line no test can reach"). The correspondence is
  // asserted on real `ps` output instead, which is where it could actually break.
  return { ...identity, argv, pids }
}


/**
 * The line that fences the pane identity inside the COMBINED remote read's reply (issue #460).
 * Everything after it on that line is `PANE_OWNER_FMT` output; every line below it is the `ps`
 * read. The marker is emitted through a quoted printf format, so the leading `##` can never be
 * eaten as a word-initial sh comment — the exact trap `session-memory-remote` measured.
 */
export const COMBINED_PANE_MARKER = '##NTPANE '

/**
 * Parse the ONE-round-trip remote pane read (issue #460): the marker line carries the identity,
 * the tail carries the `ps` rows, and both go through the exact parsers the two-trip read used —
 * this function adds routing, never a second grammar.
 *
 * `isSafeTty` stays even though the tty no longer crosses into OUR command line (it is expanded
 * inside the remote script as a quoted variable): a tty the remote printed back that this predicate
 * refuses is a reply we do not trust enough to name a pane with, and the fail direction is the
 * same null-means-unknown every sibling reader has.
 */
export function parseCombinedPaneOwner(stdout: string | null | undefined): PaneOwner | null {
  if (!stdout) return null
  const lines = stdout.split('\n')
  const at = lines.findIndex((l) => l.startsWith(COMBINED_PANE_MARKER))
  if (at === -1) return null
  const identity = parsePaneOwner(lines[at].slice(COMBINED_PANE_MARKER.length))
  if (!identity || !isSafeTty(identity.tty)) return null
  return paneOwnerFrom(identity, lines.slice(at + 1).join('\n'))
}

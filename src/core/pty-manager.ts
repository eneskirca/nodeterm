import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { platform } from './platform'
import * as pty from 'node-pty'
import { IPC } from '../shared/ipc'
import { safeSessionProgram } from '../shared/node-exec'
import { REF_MAX_LEN } from '../shared/presence'
import {
  DEFAULT_SETTINGS,
  type PaneCursor,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type TmuxStatus
} from '../shared/types'
import { findCommand, tmuxInstall } from './tmux-hint'
import { hookServer, PERM_WAIT_SECS_DEFAULT } from './agents/hook-server'
import {
  probeSaysAbsent,
  remoteHookEnvArgs,
  remoteTmuxHasSessionArgs,
  remoteTmuxKillArgs,
  remoteTmuxPtyArgs,
  remoteTmuxSendKeysArgs,
  remoteCapturePaneArgs,
  remotePaneCommandArgs,
  remotePaneCursorArgs
} from './remote-ssh/control-master'
import { parsePaneCursor } from './pane-cursor'
import { readSpawnResources, spawnResourceNote } from './spawn-resources'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { bracketedInjection } from './paste-injection'
import { releasePty, type ReleasablePty } from './pty-release'
import { effectiveSize, type PtySize } from './pty-size'
import { machOArch, archMismatch } from './macho-arch'
import { writeScrollback, readScrollback, deleteScrollback } from './scrollback-store'
import { claudeConfigDirFor } from './claude-config-dir'
import { findExecutableSync, findInPathString, resolveShellPath, shellPathNow } from './exec-path'
import { AUTH_ENV_STRIP, accountTmuxEnvArgs, remoteAccountConfigDirAbs } from './claude-accounts-core'
import { presenceHub } from './presence/hub'

// How often we snapshot a live tmux session's scrollback to disk, so a machine reboot (which
// kills the tmux server) can still replay recent output on cold restart. A final snapshot also
// runs on detach; the interval covers an ungraceful power loss between detaches.
const SCROLLBACK_SNAPSHOT_MS = 15_000

// Async exec for tmux side-calls (capture / send-keys / kill-session) so they never block
// the main event loop — a synchronous capture-pane of a large scrollback would stall every
// other session's PTY streaming and all IPC for its duration.
const execFileAsync = promisify(execFile)

/**
 * How long any subprocess this manager runs may take before it is killed.
 *
 * `execFile` defaults to NO timeout, and every remote call here goes out over an SSH
 * ControlMaster — where the failure that matters is not a slow answer but a socket whose far end
 * is GONE. After a machine restart or a network flap the control socket FILE is still on disk, so
 * `ssh -S <controlpath> …` connects to it and then waits forever on a multiplexed channel nobody
 * is serving.
 *
 * That is what wedged a terminal (reported 2026-08-09, after a restart, on a reconnected SSH
 * project): the create path probes the remote for an existing tmux session, that probe never
 * returned, so `pty:create` never resolved — and the renderer wires `term.onData`, the KEYBOARD
 * INPUT path, in the continuation that never ran. The node sat showing "[connecting to …]",
 * accepted nothing, and came back only on Refresh, which re-runs the effect. One or two nodes,
 * unpredictably: only the ones whose create raced the half-dead master.
 *
 * Generous, because a live-but-slow link must not be cut off — a `capture-pane` of a long
 * scrollback over a distant host is legitimately slow. The point is a ceiling, not a deadline.
 */
const PROC_TIMEOUT_MS = 15_000

/**
 * Shorter for the probes an interactive spawn WAITS ON. `hasRemoteSession` only decides warm vs
 * cold attach, and its timeout already degrades to the safe answer ("cannot probe" is not evidence
 * of absence — see `probeSaysAbsent`), so a long stall buys nothing and costs the user a terminal
 * that appears frozen for that whole time.
 */
const PROBE_TIMEOUT_MS = 6_000

/**
 * `execFile`, bounded. Wrapped HERE rather than at the call sites so a new one cannot forget: the
 * bug this exists for was one unbounded call out of twenty, and the next unbounded call would be
 * just as invisible. Callers may still pass their own `timeout` for the rare op that needs longer.
 */
const runAsync = ((file: string, args: readonly string[], opts?: object) =>
  execFileAsync(file, args as string[], {
    timeout: PROC_TIMEOUT_MS,
    ...(opts ?? {})
  } as never)) as unknown as typeof execFileAsync

// Minimal tmux config so the user's ~/.tmux.conf never interferes. The tmux server
// (under our socket) keeps sessions alive while no client is attached, which is what
// gives us continuity across node remounts and full app restarts.
//
// The mouse is ON, i.e. TMUX owns scrolling and selection — this is the native behavior, and the
// capabilities are deliberately NOT blanked, so the client uses the ALTERNATE screen (\e[?1049h).
// A previous design took scrolling away from tmux (mouse off + `smcup@:rmcup@:indn@`, normal
// screen, output flowing into the emulator's own scrollback, hydrated from `capture-pane` on
// reattach) and it failed structurally: tmux is a screen PAINTER, not a stream — every redraw
// (attach, resize, refresh) erases and repaints, so blank and duplicated rows leaked into the
// emulator's scrollback (black bands, duplicated screens) and a full-screen TUI's input box
// scrolled away with the text instead of staying put. Do not re-derive that: with the mouse on,
// the wheel scrolls tmux's OWN history, the pane stays sticky, and there is nothing to hydrate.
//
// COPY: selection is tmux copy-mode, and the clipboard is reached via OSC 52 — `set-clipboard on`
// plus `terminal-features ",*:clipboard"`. The `terminal-features` entry is the load-bearing one:
// on tmux 3.2+ the old `terminal-overrides ',xterm*:Ms=\E]52;...'` route does NOT work (measured:
// a copy emitted ZERO OSC 52 to the attached client with the `Ms=` override, and the correct
// payload with `terminal-features`). The renderer's OSC 52 handler writes the system clipboard, so
// this is the copy path on EVERY platform and over SSH — no `pbcopy` pipe (that was macOS-only,
// and half of why copying was broken).
export function tmuxConf(scrollback: number): string {
  return `# auto-generated by node-terminal — do not edit
set -g status off
set -g mouse on
set -g history-limit ${Math.max(1000, scrollback)}
set -g default-terminal "xterm-256color"
set -sg escape-time 10
set -g destroy-unattached off
setw -g aggressive-resize on
# Copy to the SYSTEM clipboard via OSC 52 (the client's terminal writes it). BOTH lines are needed
# on tmux 3.2+ — see tmuxConf's doc comment before touching either.
# MIGRATION — do not remove. Older versions of this file blanked smcup/rmcup/indn via
# terminal-overrides, and a long-lived tmux server keeps every entry ever sourced into it (the
# array only grows; -f is read once at server start). With those stale entries present the client
# never returns to the alternate screen and scrolling stays broken NO MATTER what this file sets
# below. Unset both arrays back to defaults, then re-add the one feature we actually want.
set -su terminal-overrides
set -su terminal-features
set -g set-clipboard on
set -as terminal-features ",*:clipboard"
# Mouse copy: on release tmux copies to its buffer AND (thanks to the two lines above) emits OSC 52,
# which the client writes to the system clipboard. No pipe-to-a-local-command here, deliberately.
bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel
bind -T copy-mode    DoubleClick1Pane send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi DoubleClick1Pane send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode    TripleClick1Pane send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi TripleClick1Pane send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel
`
}

/** Resolve an absolute tmux path (GUI apps don't inherit the shell PATH). Subprocess-free:
 *  the old fallback here was a SYNC login-shell `command -v tmux` — sourcing the profile
 *  (nvm/conda: 100-800ms) on the main thread, re-triggered every 3s by the tmux-missing
 *  banner's install poll, freezing all windows and IPC each time. Now it walks the cached
 *  login-shell PATH instead; before that async probe settles a nonstandard location can be
 *  missed, which init()'s post-probe ensureTmux() re-run and tmuxStatus()'s re-probe cover. */
function findTmux(): string | null {
  for (const c of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux']) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return findInPathString('tmux', shellPathNow() ?? process.env.PATH)
}

/** Resolve an absolute ssh path (GUI apps don't inherit the shell PATH). */
let cachedSsh: string | null | undefined
/**
 * macOS-only diagnostic for the recurring release-clobber incident: `electron-builder --x64`
 * rebuilds node-pty IN PLACE in node_modules, leaving an x86_64 spawn-helper that an arm64 app
 * cannot posix_spawn — every terminal then fails with an opaque "posix_spawnp failed.". Returns
 * the precise message (with the `npm run rebuild` remedy) when the helper's arch mismatches this
 * process, else null. Fail-open: any read/parse problem returns null (diagnostics only).
 */
function spawnHelperArchMismatch(): string | null {
  if (os.platform() !== 'darwin') return null
  try {
    const helper = path.join(
      path.dirname(require.resolve('node-pty/package.json')),
      'build',
      'Release',
      'spawn-helper'
    )
    const fd = fs.openSync(helper, 'r')
    const buf = Buffer.alloc(8)
    fs.readSync(fd, buf, 0, 8, 0)
    fs.closeSync(fd)
    const arch = machOArch(buf)
    if (archMismatch(arch, process.arch)) {
      return (
        `node-pty's spawn-helper is ${arch} but this app is ${process.arch} — a cross-arch ` +
        `release build clobbered node_modules. Fix: run \`npm run rebuild\`, then restart the app.`
      )
    }
  } catch {
    /* diagnostics only — never mask the real spawn error */
  }
  return null
}

function findSsh(): string | null {
  if (cachedSsh !== undefined) return cachedSsh
  // Subprocess-free (was a sync login-shell `command -v ssh` + an `ssh -V` spawn per fallback,
  // all blocking the main thread). A MISS is only memoized once the async login-shell PATH
  // probe has settled — before that a custom-location ssh would be cached away forever.
  const found = findExecutableSync('ssh', ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'])
  if (found || shellPathNow() !== undefined) cachedSsh = found
  return found
}

// resolveShellPath (the one async login-shell PATH probe) lives in exec-path.ts now, shared by
// every module that used to spawn its own sync login shell. Prewarmed from init(); create()
// awaits it, so terminals still always get the real PATH.

/**
 * A UTF-8 locale for spawned terminals, or null to leave the inherited locale untouched.
 *
 * A GUI app launched from Finder/Dock inherits NO locale env (no LANG/LC_*), so `locale` falls
 * back to "C" (non-UTF-8). TUIs that probe for UTF-8 support (Claude Code and other Ink/ncurses
 * apps) then render ASCII box-drawing — rounded borders come out as `_`/`|`. Same root cause as
 * the missing-PATH problem: the GUI process never sourced the shell environment. If the inherited
 * env already declares a UTF-8 locale (e.g. the app was launched from a terminal), keep it;
 * otherwise force `en_US.UTF-8`, which is always installed on macOS and guarantees UTF-8 handling.
 */
function resolveLocaleLang(): string | null {
  const cur = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || ''
  return /utf-?8/i.test(cur) ? null : 'en_US.UTF-8'
}

/**
 * Resolve an executable against the user's real login-shell PATH (reusing the cached probe),
 * returning its absolute path or null. GUI apps inherit only a minimal PATH, so a bare
 * `execFile('claude', …)` would fail even when the tool is installed.
 */
export async function findInLoginPath(bin: string): Promise<string | null> {
  const shellPath = (await resolveShellPath()) ?? process.env.PATH ?? ''
  return findInPathString(bin, shellPath)
}

/** A UI client: an Electron webContents id or a ServerPlatform uiId. */
type ClientId = number

/** A viewer id: which VIEW within one client. `PRIMARY_VIEWER` is the default view — the canvas
 *  node, and every legacy call that omits a viewerId. A second view in the SAME renderer (the
 *  kanban card modal) passes its own id, so one connection can hold several independently-
 *  detachable views of the same session. */
type ViewerId = string
const PRIMARY_VIEWER: ViewerId = ''

/**
 * The composite subscriber key: one (client, view) pair. The subscriber ledger keys on this, so a
 * ClientId can hold many subscribers — the canvas node (PRIMARY) and the modal — each subscribing,
 * sizing, pausing and detaching on its own. A `null` client (the relay host's detached sink) is
 * NOT a composite subscriber; it keys the `sizes`/flow ledgers by literal `null`, exactly as before.
 *
 * Encoding: `<clientId>\x00<viewerId>` (a literal NUL byte). clientId is always a number (no space), so
 * `subClient` recovers the client from the FIRST space regardless of what the viewerId
 * (which arrives off the wire) contains. Absent viewerId ⇒ PRIMARY ⇒ `<clientId>\x00`, i.e. one
 * entry per client — bit-for-bit the pre-viewer ledger for every existing caller.
 */
type SubKey = string
function subKey(clientId: ClientId, viewerId: ViewerId): SubKey {
  return `${clientId}\x00${viewerId}`
}
/** The ClientId behind a composite subscriber key — the collapse to "which person", for the
 *  per-ClientId data/exit/size channels and the closed-by/recycled fan-out (viewers are invisible
 *  to peers). */
function subClient(sub: SubKey): ClientId {
  return Number(sub.slice(0, sub.indexOf('\x00')))
}
/** The viewer id within a composite subscriber key (PRIMARY for a default view). */
function subViewer(sub: SubKey): ViewerId {
  return sub.slice(sub.indexOf('\x00') + 1)
}

/**
 * WHO, within one client, owes us a resume (see `Session.pausedBy`).
 *
 * One client can be behind in TWO independent places, and only on the Server Edition does the
 * second one exist:
 *  - `renderer` — its xterm write-backlog crossed the high-water mark and it cast `pty:flow`.
 *    This is the ONLY owner on the desktop, and it is EDGE-latched (TerminalNode: `if (!paused &&
 *    pending > HIGH_WATER)`) — once it has pumped its pause it will not re-pause.
 *  - `socket` — the server's own WS send buffer for that connection crossed WS_HIGH_WATER
 *    (`ServerPlatform.sendTo`), which is a different queue with a different drain time: the socket
 *    empties as fast as the browser READS bytes, while the renderer's backlog empties only as fast
 *    as xterm PARSES them.
 * They must be separate ledger entries: keyed by ClientId alone they collapse into one, and the
 * socket's drain (the sweep) would hand back the pause the renderer still owes — permanently,
 * because the renderer cannot re-pause. That is invariant (b) on `pausedBy`.
 */
export type FlowOwner = 'renderer' | 'socket'
/** All the owners one client can owe a pause under — the sweep on any leave path. */
const FLOW_OWNERS: readonly FlowOwner[] = ['renderer', 'socket']

/** The ledger key for one (view, owner) pause. The `sub` is a composite subscriber key, so a
 *  client's two views (canvas node + modal) pause the shared pty on their OWN tickets — each xterm
 *  is edge-latched independently, so collapsing them by ClientId would let one hand back the pause
 *  the other still owes (the same bug the `owner` dimension prevents for the socket). `null` is the
 *  relay host's detached sink, which has no ClientId; it pauses as a `renderer`-side owner. */
function flowTicket(sub: SubKey | null, owner: FlowOwner): string {
  return `${owner}#${sub ?? 'relay'}`
}

/** One client's reported fit, run through the same floor/clamp the pty itself gets, so a size we
 *  record for a client is comparable with the effective size we compute from all of them. */
function normalizeSize(cols: number, rows: number): PtySize {
  return effectiveSize([{ cols, rows }]) as PtySize // one entry in ⇒ never null out
}

interface Session {
  proc: pty.IPty
  /** Every VIEW watching this session, keyed by the composite `(ClientId, viewerId)` (`SubKey`).
   *  Co-attach: ONE pty and ONE tmux client, N subscribers — a second client on the same persistKey
   *  (or the SAME client's second view, e.g. the kanban card modal) joins this set instead of
   *  spawning a second tmux client (whose `-D` would then kick the first one off). Empty for a
   *  purely detached (relay-served) session. */
  subscribers: Set<SubKey>
  /** Each VIEWING subscriber's last reported cols/rows — the pty runs at the min of these
   *  (`effectiveSize`). A subscriber that is subscribed but NOT looking is ABSENT from this map:
   *  it still gets output, it just doesn't constrain the size (see `resize`). Keyed by the composite
   *  `SubKey` so two views in one client vote independently; `null` keys the relay host's detached
   *  sink, which has no ClientId but does report a size. */
  sizes: Map<SubKey | null, PtySize>
  /** The size each subscriber's xterm is believed to be rendering: the last authoritative size we
   *  sent it, or — if it has reported a fit since — its own fit (the renderer applies its own fit
   *  locally, exactly as it always has). Keyed by the composite `SubKey`. We only send `pty:size` to
   *  a subscriber whose view differs from the effective size, which is what keeps a SOLO user's
   *  resize free of any extra IPC. */
  shown: Map<SubKey, PtySize>
  /** The size currently pushed into the pty (seeded from the spawn's cols/rows). Guards against
   *  re-resizing the tmux client to the size it already has — that is a full-pane redraw. */
  appliedSize?: PtySize
  /**
   * The node id (persistKey) this session was created for — set WHENEVER the caller supplied one,
   * with no further conditions. It is not an index and it is not a persistence flag; it is just
   * "which canvas node is this", which is exactly what a typing badge needs to point at (`write`).
   *
   * It exists because the two ids below are each conditional, and their conditions leave a hole:
   * `indexKey` is unset for a DETACHED (relay-served) pty — a phone — and `persistKey` is unset
   * when the session isn't persisted, which for a local session means tmux is off. Turn tmux off
   * and a phone's session has NEITHER, so a phone's typing would be silently unbadgeable while a
   * co-attached desktop peer's still lit up — a degenerate config, but a confusing, invisible
   * degrade rather than an honest one. This field is unconditional, so it has no such hole.
   */
  nodeId?: string
  /** The node id this session is CO-ATTACH-INDEXED under (`byPersistKey`) — set only for a session
   *  a second client may join, i.e. NOT for a relay-served (detached) pty, which is deliberately
   *  not indexed. See `nodeId` above for the plain "which node is this". */
  indexKey?: string
  /** Detached sinks: when set, output/exit ALSO go to these callbacks (relay host). */
  onData?: (data: string) => void
  onExit?: (exitCode: number) => void
  /** Pending output chunks, coalesced into one IPC message per flush. */
  buf: string[]
  bufBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Node id this session PERSISTS under (only when tmux-backed / remote) — it gates scrollback
   *  snapshots and tmux kill/capture, so it must stay conditional. See `nodeId` above. */
  persistKey?: string
  /** When set, the session runs on a remote host via ssh; kill/capture target the REMOTE tmux. */
  sshRemote?: NonNullable<PtyCreateOptions['sshRemote']>
  /** Output arrived since the last scrollback snapshot — idle sessions skip the capture. */
  outputSinceSnapshot: boolean
  /**
   * The (client, owner) pairs that currently OWE us a resume — a ledger of FLOW TICKETS
   * (`flowTicket`), not of clients. The pty is paused while this set is non-empty and resumes only
   * when it becomes empty (`setFlow` / `releaseFlow`).
   *
   * It has to be a SET, not a boolean, because both of these must hold at once:
   *  (a) a pause owed by a client that LEFT is always returned (its renderer is gone and will
   *      never send the matching resume — the co-attaching or remaining clients would stare at a
   *      frozen, blank terminal forever). `kill` / `dropClient` / `join` return it — and `kill` /
   *      `dropClient` return EVERY owner's ticket for that client, not just the renderer's.
   *  (b) a pause owed by a client that is STILL HERE is never silently cancelled. That client's
   *      flow control is EDGE-latched (`if (!paused && pending > HIGH_WATER)` in TerminalNode) —
   *      once it has pumped the pause it will NOT re-pause, so resuming the pty behind its back is
   *      permanent and its write queue then grows without bound for the rest of the flood.
   * A single boolean can only ever satisfy one of the two (it cannot tell the cases apart).
   *
   * And the tickets are keyed by (client, OWNER), not by client, because a Server-Edition client
   * has two independent pause owners with two different drain times (see `FlowOwner`): keyed by
   * ClientId alone, the socket's drain would silently cancel the renderer's pause and break (b) —
   * deterministically, for the whole rest of a flood.
   */
  pausedBy: Set<string>
  /** True when this node had an `accountId` but its config dir was gone at spawn, so we fell back
   *  to the system account. `create()` surfaces it to the renderer (warning chip). */
  accountFallback?: boolean
}

/** Sinks for a detached session whose output is served somewhere other than the renderer
 * (the relay host). The PTY is otherwise identical to a normal session. */
export interface DetachedSinks {
  onData(data: string): void
  onExit(exitCode: number): void
}

/**
 * tmux attach flags. `-A` = attach-or-create. `-D` = detach OTHER clients on attach.
 *
 * `-D` STAYS for the app's own client, and co-attach does not change that: a second viewer
 * subscribes to the existing `Session` in this process — it does NOT start a second tmux client.
 * The app therefore always has exactly ONE tmux client per session, so tmux's own multi-client
 * size negotiation never engages and "smallest subscriber wins" is decided by us (pty-size.ts).
 * A relay-served (detached) pty is the one exception: the host's local client is already attached
 * to the same session and must be mirrored, not kicked off.
 */
export function tmuxAttachFlags(detached: boolean): string[] {
  return detached ? ['-A'] : ['-A', '-D']
}

// Output coalescing: a fast producer (e.g. `yes`, a verbose build, tmux full-screen
// redraws) emits many small chunks. Buffering them for one short window collapses N
// IPC messages + N xterm writes into one, which is the single hottest path in the app.
const FLUSH_MS = 8
const MAX_BUF_BYTES = 256 * 1024

/**
 * How long a recycled node's co-viewers wait for the replacement session before they are told the
 * session restarted anyway (see `recycleSession`). The notice normally fires the instant the new
 * session is registered — milliseconds later. This is only the escape hatch for a recycler that
 * never respawns (its app quit / crashed between the kill and the create): the co-viewers are
 * still holding a dead pty, and being released late beats being frozen forever.
 */
const RECYCLE_NOTIFY_TIMEOUT_MS = 10_000

/** Why a session is being ended — the ONE thing `destroySession` could not tell apart. Both kill
 *  the tmux session; they differ entirely in what the OTHER viewers are told.
 *  - `delete`: the × / node deletion. The node leaves the canvas: co-viewers get `pty:closed`
 *    ("closed by <name>") and must never respawn it (that would resurrect a terminal its owner
 *    deliberately killed, in a fresh shell, stranding a tmux session).
 *  - `recycle`: "move into worktree". The node STAYS on the canvas under the same id and respawns
 *    in the new cwd. Co-viewers get `pty:recycled` (restart + re-attach), never the closed state. */
type EndIntent = 'delete' | 'recycle'

/**
 * How many deleted node ids we remember (see `tombstones`), and for how long.
 *
 * The map is keyed by a persistKey that comes VERBATIM off the wire, and `endSession('delete')`
 * records one even when no live session exists — so without a bound, a client looping
 * `pty:destroy(<random string>)` grows it forever. It is in-memory bookkeeping, not a promise: an
 * LRU of the most recent deletions is exactly as much as the respawn guard actually needs (a
 * co-viewer opens the deleted node's project minutes later, not next month). Stage 3's canvas-delete
 * mutation covers the attached clients; this map still covers the ones it cannot reach (see
 * `tombstones`). Eviction degrades to the pre-tombstone behavior (the co-viewer may respawn the
 * node), never to something worse.
 */
export const TOMBSTONE_MAX = 200
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Token budget for the session-ENDING casts (`pty:destroy` / `pty:recycle`), per client.
 *
 * These are the only pty casts that cost real resources per call — an `fs.rm` of the scrollback
 * snapshot, a `tmux kill-session` subprocess, and a tombstone entry — and they were the only ones
 * with no limit at all (the presence casts are all bucketed). The burst is sized to the loudest
 * HONEST caller by a wide margin: a bulk delete (select N nodes → Delete) fires one cast per node
 * in a single tick, and dropping one of those would silently leak a tmux session, so the bucket
 * must never be the thing that fails a real user.
 */
export const PTY_END_BUDGET = { perSec: 20, burst: 200 }

/**
 * Manages all live PTY processes and bridges them to the renderer over IPC.
 *
 * On macOS/Linux with tmux available, each terminal node attaches to a persistent
 * tmux session named after its node id (`tmux new-session -A`). Closing a node's
 * window only detaches the client — the tmux session (and everything running in it)
 * survives, so reopening the node or restarting the app reattaches and continues
 * where it left off. Without tmux, it falls back to a plain shell (no persistence).
 */
export class PtyManager {
  private sessions = new Map<string, Session>()
  /** persistKey (node id) → live sessionId. The index that makes `pty:create` idempotent:
   *  a second client asking for the same node subscribes to the running session. */
  private byPersistKey = new Map<string, string>()
  /** persistKey (node id) → the create() currently spawning it. Makes `pty:create` idempotent
   *  ACROSS the awaits inside a spawn (see create()), not just after them. Entries are removed
   *  as soon as the spawn settles, success or failure. */
  private inflight = new Map<string, Promise<PtyCreateResult>>()
  /** persistKey (node id) → the co-viewers of a session that was RECYCLED (moved into a worktree),
   *  waiting to be told to restart onto the replacement session. Held — not sent — until that
   *  session is registered (`spawnSession`), so a co-viewer's restart can never win the race and
   *  spawn the node in its own stale cwd. See `recycleSession`. */
  private pendingRecycle = new Map<
    string,
    { sessionId: string; clients: Set<ClientId>; timer: ReturnType<typeof setTimeout> }
  >()
  /**
   * persistKey (node id) → the client that DELETED it. The respawn guard for clients the
   * `pty:closed` event cannot reach.
   *
   * `pty:closed` fans out to the dying session's SUBSCRIBERS. A co-viewer whose project is
   * inactive or closed has no mounted terminal, is not a subscriber, and is told nothing — yet the
   * node is still on its canvas. When it opens that project, its `create` finds no session, `tmux
   * has-session` fails, and it would SPAWN A BRAND-NEW `nt-<id>`: a terminal its owner deliberately
   * deleted, resurrected as a fresh shell, plus a stray tmux session nobody asked for. The
   * tombstone makes that create refuse (`PtyCreateResult.closed`) instead.
   *
   * Deliberate limits, because this is the smallest honest fix and not the real one:
   *  - it is IN-MEMORY, so it dies with the core process. Co-attach means one core with N clients
   *    (Server Edition / relay), so it covers every co-viewer for as long as that core lives — but
   *    after a server restart the resurrection is back.
   *  - it is BOUNDED, in size and in time (TOMBSTONE_MAX / TOMBSTONE_TTL_MS): the key comes verbatim
   *    off the wire and an entry is recorded even when no live session exists, so an unbounded map
   *    would grow with client input alone. Eviction degrades to the pre-tombstone behavior, never
   *    worse.
   *  - it is keyed by the DESTROYER, who is exempt: their own ⌘Z (undo of a delete) must still
   *    restore the node, and a solo user is always the destroyer, so their path is untouched.
   *  - a `recycle` (worktree move) explicitly CLEARS it: nothing was deleted there.
   * Stage 3's canvas-delete mutation now removes the node from every ATTACHED client's canvas, so
   * that client never asks to re-create it — but it did not retire this map. Two paths still reach
   * `create` for a deleted node: a whole PROJECT deleted by one client is not synced (project
   * lifecycle is not in the mutation vocabulary), and a client that was disconnected when the delete
   * landed never receives it (no join snapshot, no replay). See docs/team-presence.md
   * ("What Stage 3 changed", item 4).
   */
  private tombstones = new Map<string, { by: ClientId | null; at: number }>()
  /** `${clientId}:${channel}` → token bucket for the session-ending casts (see PTY_END_BUDGET). */
  private endBuckets = new Map<string, { tokens: number; at: number }>()
  private counter = 0
  private tmuxPath: string | null = null
  private confPath = ''
  private getSettings: () => Settings = () => DEFAULT_SETTINGS
  /** ONE shared snapshot interval for all persisted sessions — a per-session interval spawned
   *  one tmux/ssh capture subprocess per session per tick, forever, even for idle terminals. */
  private snapshotTimer: ReturnType<typeof setInterval> | null = null

  private ensureSnapshotTimer(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setInterval(() => this.snapshotTick(), SCROLLBACK_SNAPSHOT_MS)
  }

  private snapshotTick(): void {
    let anyPersisted = false
    for (const session of this.sessions.values()) {
      if (!session.persistKey) continue
      anyPersisted = true
      if (!session.outputSinceSnapshot) continue // idle since the last capture — skip the spawn
      session.outputSinceSnapshot = false
      void this.snapshotScrollback(session.persistKey, session.sshRemote).then((ok) => {
        // Transient capture failure (ssh blip, tmux busy): put the dirty bit back so the next
        // tick retries — otherwise a quiet session would never be snapshotted again.
        if (!ok) session.outputSinceSnapshot = true
      })
    }
    if (!anyPersisted && this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
  }

  /** Must run after app is ready (needs userData path). */
  init(getSettings: () => Settings): void {
    this.getSettings = getSettings
    // Prewarm the login-shell PATH probe now so the first terminal spawn doesn't wait on it —
    // and re-run the tmux probe once it lands: findTmux no longer spawns a login shell of its
    // own, so a tmux living only on the user's shell PATH is invisible until this resolves.
    void resolveShellPath().then(() => this.ensureTmux())
    this.ensureTmux()
  }

  /** Probe tmux and write/push the generated config. Idempotent and safe to re-run: a later
   *  successful probe (e.g. right after the banner's install command finishes) brings tmux
   *  up for NEW sessions without an app restart — existing plain-shell sessions are left
   *  alone. No-op while tmux is already resolved or before init() provided settings. */
  ensureTmux(): void {
    if (this.tmuxPath || !this.getSettings) return
    const found = findTmux()
    if (!found) return
    this.confPath = path.join(platform().userDataDir, 'tmux.conf')
    try {
      fs.writeFileSync(this.confPath, tmuxConf(this.getSettings().tmuxScrollback))
    } catch {
      // If we can't write the config, stay on the plain-shell fallback.
      return
    }
    this.tmuxPath = found
    // The tmux server outlives the app, so it won't re-read `-f` on relaunch. Push the
    // (possibly updated) config into a running server now so new bindings apply immediately;
    // a no-op error when no server exists yet (the next session loads it fresh via `-f`).
    try {
      execFileSync(this.tmuxPath, ['-L', TMUX_SOCKET, 'source-file', this.confPath], {
        stdio: 'ignore'
      })
    } catch {
      // no server running yet — ignore
    }
  }

  /** Absolute tmux path (or null if tmux is unavailable). Used by the context-link backend. */
  getTmuxBin(): string | null {
    return this.tmuxPath
  }

  registerIpc(): void {
    platform().handleWithSender(
      IPC.ptyCreate,
      (senderId, options: PtyCreateOptions): Promise<PtyCreateResult> =>
        this.create(senderId, options)
    )
    // Sender-aware: with co-attach, a keystroke arriving here is no longer self-evidently "the one
    // user's" — WHO typed it is what lights the "X is typing" ring on everyone else's canvas (see
    // `write`). Registered ONLY here: `on` and `onWithSender` compose on the same channel, so
    // leaving the old plain listener in place would write every keystroke into the pty TWICE.
    platform().onWithSender(IPC.ptyWrite, (senderId: number, sessionId: string, data: string) => {
      if (!this.subscribes(senderId, sessionId)) return
      this.write(senderId, sessionId, data)
    })
    // Sender-aware: a size is only meaningful with the client it belongs to — the pty runs at the
    // smallest one (`resize`). Registered ONLY here: `on` and `onWithSender` compose on the same
    // channel, so leaving the old plain listener in place would run the resize twice.
    platform().onWithSender(
      IPC.ptyResize,
      (
        senderId: number,
        sessionId: string,
        cols: number | null,
        rows: number | null,
        // Optional TRAILING viewerId: a client's second view (the kanban card modal) sizes on its
        // own vote. Absent (every legacy caller) ⇒ the PRIMARY view.
        viewerId?: string
      ) => {
        if (!this.subscribes(senderId, sessionId)) return
        this.resize(senderId, sessionId, cols, rows, viewerId)
      }
    )
    // Sender-aware: a pause belongs to the client whose xterm backlog overflowed, and only that
    // client (or its departure) can return it — see `Session.pausedBy`. Registered ONLY here:
    // `on` and `onWithSender` compose on the same channel, so a leftover plain listener would
    // run the flow change twice (and, with an unattributed sessionId, wrongly).
    platform().onWithSender(
      IPC.ptyFlow,
      // Optional TRAILING viewerId: a client's second view (the modal) is an independently
      // edge-latched xterm, so its pause is owed on its own ticket. The `owner` is always
      // 'renderer' off the wire (the Server Edition's 'socket' owner uses the direct setFlow call).
      (senderId: number, sessionId: string, resume: boolean, viewerId?: string) => {
        if (!this.subscribes(senderId, sessionId)) return
        this.setFlow(senderId, sessionId, resume, 'renderer', viewerId)
      }
    )
    // Sender-aware: with co-attach a kill detaches just THAT client, and the pty (and the tmux
    // session behind it) survives while any other subscriber is still watching.
    platform().onWithSender(
      IPC.ptyKill,
      // Optional TRAILING viewerId: closing the kanban card modal detaches ONLY that view; the
      // canvas node's client (PRIMARY, or any other view) keeps the session alive. Absent ⇒ PRIMARY.
      (senderId: number, sessionId: string, viewerId?: string) => {
        if (!this.subscribes(senderId, sessionId)) return
        this.kill(senderId, sessionId, viewerId)
      }
    )
    // Sender-aware: the × permanently ends a session OTHER people may be watching, so the close
    // event they get has to name WHO did it ("closed by <name>" — see `destroySession`).
    // Registered ONLY here: `on` and `onWithSender` compose on the same channel, so a leftover
    // plain listener would run the destroy — and its `tmux kill-session` — twice.
    platform().onWithSender(IPC.ptyDestroy, (senderId: number, persistKey: string) =>
      this.endFromClient(senderId, IPC.ptyDestroy, persistKey, 'delete')
    )
    // Sender-aware for the opposite reason: the client that RECYCLED the node drives its own
    // respawn, so it is the one client that must NOT be sent the restart notice.
    platform().onWithSender(IPC.ptyRecycle, (senderId: number, persistKey: string) =>
      this.endFromClient(senderId, IPC.ptyRecycle, persistKey, 'recycle')
    )
    platform().handle(IPC.ptyReadScrollback, (persistKey: string) =>
      readScrollback(persistKey)
    )
    platform().handle(IPC.ptySendText, (persistKey: string, text: string, enter?: boolean) =>
      this.sendText(persistKey, text, enter === undefined ? undefined : { enter })
    )
    platform().handle(IPC.ptyTmuxStatus, () => this.tmuxStatus())
    platform().handle(IPC.ptyPaneCommand, (persistKey: string) => this.paneCommand(persistKey))
  }

  /** Feeds the renderer's "tmux not found" banner. Without tmux the app silently degrades to a
   *  plain shell (no cross-restart continuity, no mobile attach) — users never discover that on
   *  their own, so the banner surfaces it with a one-click install command when a known package
   *  manager is present (run in a terminal node, gh-sign-in style). */
  tmuxStatus(): TmuxStatus {
    // Re-probe when unavailable: the banner polls this while its install command runs, and a
    // successful probe here is what makes new sessions tmux-backed without a restart.
    if (!this.tmuxPath) this.ensureTmux()
    const available = !!this.tmuxPath
    const hint = available
      ? null
      : tmuxInstall(process.platform, (cmd) => findCommand(cmd, process.env, fs.existsSync))
    return {
      available,
      installCommand: hint?.command ?? null,
      installLabel: hint?.label ?? null,
      platform: process.platform
    }
  }

  /**
   * Does this client actually WATCH this session? The membership check every wire-facing pty cast
   * (write / resize / flow / kill) is gated on.
   *
   * Session ids are sequential and guessable (`pty-1`, `pty-2`, …) and each of those casts takes the
   * id straight off the wire. Ungated, ANY authenticated client could steer a terminal it never
   * opened: `pty:flow(pty-3, false)` pauses the shared pty (the producing process then blocks on a
   * full pipe and every real viewer's terminal freezes), `pty:resize(pty-3, 1, 1)` pins everyone's
   * grid at 1x1, `pty:write` types into someone else's shell. The invariant this establishes —
   * EVERYTHING IN `pausedBy` / `sizes` BELONGS TO A SUBSCRIBER — is what makes `dropClient` a
   * complete cleanup: a client can only ever owe what it subscribed for.
   *
   * The gate lives HERE, at the IPC seam, not inside the methods: the relay host calls
   * `write`/`resize`/`kill`/`setFlow` directly for its DETACHED (sink-served) ptys, which have no
   * subscribers by design, and that path is not off the wire.
   */
  private subscribes(clientId: ClientId, sessionId: string): boolean {
    const subs = this.sessions.get(sessionId)?.subscribers
    if (!subs) return false
    // Client-scoped, not view-scoped: a client that opened this node in ANY view (canvas node or
    // modal) may steer it. A kill/resize naming a viewer this client doesn't hold is then a
    // harmless no-op delete, not a security hole — the gate's job is "is this the right person".
    for (const sub of subs) if (subClient(sub) === clientId) return true
    return false
  }

  /** The distinct ClientIds watching this session — the collapse of the composite ledger for the
   *  per-ClientId data/exit channels: a client's two views share one `pty:data:<id>` channel, so a
   *  chunk must be sent to each client ONCE (a second send would double every byte in both xterms). */
  private clientsOf(session: Session): ClientId[] {
    const clients = new Set<ClientId>()
    for (const sub of session.subscribers) clients.add(subClient(sub))
    return [...clients]
  }

  /**
   * The wire-facing half of `destroySession` / `recycleSession`: validate the node id, spend a
   * token, and only then end the session. Everything here is about the fact that `persistKey`
   * arrives VERBATIM from a client and that a destroy costs real resources on every call (an
   * `fs.rm`, a `tmux kill-session` subprocess, a tombstone entry) — including when the node has no
   * live session in this process, which is precisely the call an attacker can make in a loop.
   *
   * The cap is the same one presence uses for every client-supplied reference (REF_MAX_LEN); a node
   * id is a short generated string, so anything longer is not a node. It REFUSES rather than
   * truncating — a truncated key would name a DIFFERENT node, and this call kills things.
   *
   * Internal callers (main's node-delete path, the worktree move) go straight to
   * `destroySession`/`recycleSession` and are neither capped nor bucketed: they are not off the wire.
   */
  private endFromClient(
    clientId: ClientId,
    channel: string,
    persistKey: string,
    intent: EndIntent
  ): Promise<void> {
    if (typeof persistKey !== 'string' || !persistKey || persistKey.length > REF_MAX_LEN)
      return Promise.resolve()
    if (!this.allowEnd(clientId, channel)) return Promise.resolve()
    return this.endSession(clientId, persistKey, intent)
  }

  /** Take one token from this client's bucket for a session-ending channel (see PTY_END_BUDGET).
   *  Excess casts are dropped silently — never an error, never a disconnect. */
  private allowEnd(clientId: ClientId, channel: string): boolean {
    const key = `${clientId}:${channel}`
    const now = Date.now()
    const prev = this.endBuckets.get(key)
    // A client starts with a full bucket and refills at `perSec`, capped at `burst`.
    const tokens = prev
      ? Math.min(
          PTY_END_BUDGET.burst,
          prev.tokens + ((now - prev.at) / 1000) * PTY_END_BUDGET.perSec
        )
      : PTY_END_BUDGET.burst
    if (tokens < 1) {
      this.endBuckets.set(key, { tokens, at: now })
      return false
    }
    this.endBuckets.set(key, { tokens: tokens - 1, at: now })
    return true
  }

  /** Remember that this node was DELETED, bounded in both size and time (see TOMBSTONE_MAX). The
   *  Map is insertion-ordered, so re-inserting makes it a plain LRU. */
  private tombstone(persistKey: string, by: ClientId | null): void {
    this.tombstones.delete(persistKey)
    this.tombstones.set(persistKey, { by, at: Date.now() })
    while (this.tombstones.size > TOMBSTONE_MAX) {
      const oldest = this.tombstones.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  /** The tombstone for this node, if one is still in force (expired entries are dropped on read). */
  private liveTombstone(persistKey: string): { by: ClientId | null } | undefined {
    const tomb = this.tombstones.get(persistKey)
    if (!tomb) return undefined
    if (Date.now() - tomb.at > TOMBSTONE_TTL_MS) {
      this.tombstones.delete(persistKey)
      return undefined
    }
    return tomb
  }

  private async create(clientId: ClientId, options: PtyCreateOptions): Promise<PtyCreateResult> {
    const key = options.persistKey
    if (!key) return this.spawnNew(clientId, options)
    // Co-attach: a live session for this node id already exists in THIS process (another client,
    // or this client's own second view). Subscribe to it instead of spawning a second tmux client
    // — `-D` would otherwise kick the first viewer off.
    const joined = this.join(clientId, options, key)
    if (joined) return joined
    // Same-tick race: spawnNew() awaits a `tmux has-session` SUBPROCESS (tens of ms, not a
    // microtask) before spawnSession registers the session in `byPersistKey`, so two clients
    // opening the same node in that window would BOTH miss the index and both spawn — and the
    // second `tmux -A -D` detaches the first client, killing that user's terminal. So the spawn
    // is published as an in-flight promise from the TOP of create(): a racing create awaits it
    // and then takes the subscribe branch. (No locking primitive: the promise IS the barrier —
    // the single-user path never sees an in-flight entry and behaves exactly as before.)
    const inflight = this.inflight.get(key)
    if (inflight) {
      await inflight.catch(() => undefined) // the other spawn failed → fall through and try ourselves
      const late = this.join(clientId, options, key)
      if (late) return late
      // The spawn we awaited REJECTED, so there is no session to join. With two clients queued
      // behind that one failure, the first of them re-spawns — and the second must see THAT spawn
      // (published below, synchronously) rather than fall through and spawn a second tmux client,
      // whose `-D` would detach the first. Recurse: the in-flight guard is the barrier, so waiting
      // on a *new* in-flight entry is exactly the same wait as the one we just did.
      if (this.inflight.get(key)) return this.create(clientId, options)
    }
    // Another client DELETED this node (and there is no live session for it — `join` above already
    // covers a resurrection by its owner). Refuse rather than spawn: see `tombstones`. Checked
    // AFTER the in-flight barrier so a create racing the owner's own respawn joins it instead.
    const tomb = this.liveTombstone(key)
    if (tomb && tomb.by !== clientId) return { sessionId: '', fresh: false, closed: { by: tomb.by } }
    const spawn = this.spawnNew(clientId, options)
    this.inflight.set(key, spawn)
    // Clear on settle — INCLUDING on failure, or a single failed spawn would leave a rejected
    // promise in the map and make the node permanently unopenable.
    const clear = (): void => {
      if (this.inflight.get(key) === spawn) this.inflight.delete(key)
    }
    spawn.then(clear, clear)
    return spawn
  }

  /**
   * Subscribe `clientId` to the live session for this node id, if there is one. Returns the
   * create() result (`fresh:false` — the renderer joined a live session: no cold-restore
   * scrollback replay, no agent resume), or undefined if none exists.
   *
   * WHAT PAINTS THE JOINER'S SCREEN. Its xterm is brand-new and empty, and `fresh:false` has just
   * told it to skip the scrollback replay. The only other thing that could paint it is a tmux
   * redraw — and tmux redraws on SIGWINCH, i.e. only when `applySize` below actually RESIZES the
   * pty, which happens only for a joiner strictly SMALLER than the current grid. Equal is the
   * EXPECTED case (the node's persisted geometry and the font settings are the same on both
   * clients, and canvas zoom is a CSS transform that doesn't change `clientWidth`), and equal or
   * larger resizes nothing — so the headline path of the whole feature, "open the same terminal in
   * a second client", would land on a blank-but-live terminal until the next byte of output.
   *
   * So a join that did NOT resize carries the current screen (`PtyCreateResult.screen`), captured
   * from tmux with the same `captureForResync` the drop-and-redraw path already uses. It rides the
   * create RESULT rather than a `pty:resync` event on purpose: the renderer only subscribes to this
   * session's channels AFTER create() resolves, so an event pushed here would land on no listener.
   * A join that DID resize gets nothing — tmux paints it, and two paints would splice two different
   * points in time onto one screen.
   *
   * The capture is skipped entirely (not just discarded) when the pty resized, so the solo paths
   * pay nothing: a solo user never reaches `join` at all (a fresh spawn has nothing to paint, and a
   * warm reattach spawns a tmux client, which redraws by itself).
   */
  private join(
    clientId: ClientId,
    options: PtyCreateOptions,
    persistKey: string
  ): Promise<PtyCreateResult> | undefined {
    const existingId = this.byPersistKey.get(persistKey)
    const existing = existingId ? this.sessions.get(existingId) : undefined
    if (!existingId || !existing) return undefined
    // The joining VIEW's composite key: a second client, OR the SAME client's second view (the
    // kanban card modal). Either way it is a distinct subscriber of the one shared session/pty.
    const sub = subKey(clientId, options.viewerId ?? PRIMARY_VIEWER)
    existing.subscribers.add(sub)
    // The joiner's xterm has fitted itself to its own window; that is what it renders until we
    // tell it otherwise. applySize() then either shrinks the pty to it (it is the new smallest) or
    // sends it the authoritative size to render + letterbox.
    const size = normalizeSize(options.cols, options.rows)
    existing.sizes.set(sub, size)
    existing.shown.set(sub, size)
    const before = existing.appliedSize
    this.applySize(existingId, existing)
    const resized =
      before?.cols !== existing.appliedSize?.cols || before?.rows !== existing.appliedSize?.rows
    // A (re)joining client's backlog is empty by definition, so its fresh page will never issue a
    // resume its PREVIOUS page owed us — a renderer reload keeps the same ClientId, so without this
    // the reloaded terminal would stay frozen forever with no data arriving to unstick it. Return
    // only THIS client's RENDERER pause: a pause owed by a DIFFERENT client that is still here and
    // still drowning stays in place, and so does this client's own SOCKET pause — a fresh page says
    // nothing about the state of the WS send buffer under it (invariant (b) on `pausedBy`), and the
    // server returns that one itself when the socket drains. Scoped to THIS view: the other view's
    // (e.g. the still-open modal's) renderer pause is untouched.
    this.releaseFlow(existing, sub, 'renderer')
    // A tmux-backed join needs the mouse-tracking mode-enable sequences tmux only emits at its own
    // attach — a mid-stream subscriber missed them, and neither the `screen` capture nor a SIGWINCH
    // redraw re-sends them, so without this the joiner can't wheel-scroll tmux history until a
    // keystroke. `persistKey` is set iff tmux-backed (local or remote), which is exactly the gate:
    // our tmux always runs `mouse on`, so enabling these unconditionally matches its client state.
    // Rides `base` so it reaches the renderer on BOTH the resized and screen-painted branches.
    const coAttachMouse = existing.persistKey ? true : undefined
    const base: PtyCreateResult = existing.accountFallback
      ? { sessionId: existingId, fresh: false, accountFallback: true, coAttachMouse }
      : { sessionId: existingId, fresh: false, coAttachMouse }
    if (resized) return Promise.resolve(base) // tmux is redrawing this client — do not paint twice
    // An empty capture (plain shell — no tmux to capture; a tmux/ssh blip) is OMITTED, never sent
    // as '': the renderer must not reset a terminal for nothing. A plain-shell joiner therefore
    // still lands on a blank-but-live screen — there is no source of truth for its past output,
    // which is exactly what "no tmux = no continuity" already means everywhere else here.
    // The cursor rides ALONGSIDE the screen, never appended to it: the renderer strips exactly one
    // trailing newline off the capture before painting (`stripTrailingNewline`, which stops that
    // last LF scrolling the top row into scrollback), and a control sequence tacked on the end
    // would leave that regex nothing to match. Asked for in PARALLEL — it is a second tmux round
    // trip on the create path, and serialising it would add its latency to every join.
    return Promise.all([
      this.captureForResync(existingId).catch(() => ''),
      this.paneCursor(existingId).catch(() => undefined)
    ]).then(([screen, cursor]) =>
      screen ? { ...base, screen, ...(cursor ? { cursor } : {}) } : base
    )
  }

  /** Spawn a brand-new session for this client (the non-co-attach path). */
  private async spawnNew(clientId: ClientId, options: PtyCreateOptions): Promise<PtyCreateResult> {
    // This node runs on a remote host and we cannot reach it: spawn NOTHING. Everything below
    // (and `spawnSession`'s program resolution) falls through to the LOCAL tmux/plain branches
    // when `sshRemote` is absent or `ssh` is missing — a silent local shell wearing a remote
    // node's identity, which is the one outcome a remote node must never have (see
    // `PtyCreateOptions.requireRemote`). Refuse instead; the renderer waits for the master.
    //
    // Deliberately here in `spawnNew` and not in `create`: a co-attach JOIN to a live session for
    // this node id is still correct (that session already runs wherever it runs), so only the
    // branch that would have created a new local session is refused. `findSsh()` is checked for
    // the same reason `spawnSession` checks it — without the executable the remote branch there
    // is skipped and the local one runs.
    if (options.requireRemote && !(options.sshRemote && options.persistKey && findSsh())) {
      return { sessionId: '', fresh: false, unavailable: 'ssh' }
    }
    // A tmux-backed session is "fresh" (cold start) when no live session exists to reattach to
    // — i.e. first open, or after a machine reboot killed the tmux server. Plain (non-tmux)
    // sessions are always fresh: they have no cross-restart continuity. The renderer uses this
    // to decide whether to replay the persisted scrollback and re-launch a resumable agent.
    const tmuxBacked =
      !!this.tmuxPath && this.getSettings().tmuxEnabled && !!options.persistKey
    // For an SSH-project node, "fresh" is decided by the REMOTE tmux server (over the project's
    // ControlMaster), not the local one. The remote `has-session` is a full network round-trip,
    // so it MUST be async (`runAsync`) — a synchronous probe here would freeze every window/IPC
    // for its duration. Falls through to the local tmux/plain logic otherwise (also async: a
    // bulk project load fires one create() per node, and even cheap probes add up serialized).
    const fresh = options.sshRemote
      ? !(await this.remoteSessionExists(
          options.sshRemote,
          sessionName(options.persistKey as string)
        ))
      : tmuxBacked
        ? !(await this.tmuxSessionExists(options.persistKey as string))
        : true
    // Ensure the login-shell PATH is resolved (prewarmed in init(); usually already settled)
    // so the session env below picks it up — awaiting keeps the event loop free either way.
    await resolveShellPath()
    const sessionId = this.spawnSession(options, clientId, undefined)
    // Surface a missing-account-dir fallback so the renderer can flag the node's account chip.
    const accountFallback = this.sessions.get(sessionId)?.accountFallback
    return accountFallback ? { sessionId, fresh, accountFallback } : { sessionId, fresh }
  }

  /** Does the node's remote tmux session exist (over the project's ControlMaster)? Async so the
   *  network round-trip never blocks the main event loop. A probe that FAILED for transport
   *  reasons answers "exists": only tmux's own exit 1 is evidence of absence (probeSaysAbsent) —
   *  a dead/reconnecting master read as "cold" typed a resume command into a live agent session. */
  private async remoteSessionExists(
    sshRemote: NonNullable<PtyCreateOptions['sshRemote']>,
    sessionId: string
  ): Promise<boolean> {
    const ssh = findSsh()
    if (!ssh) return true // can't probe → not evidence of absence; warm attach types nothing
    try {
      await runAsync(ssh, remoteTmuxHasSessionArgs(sshRemote.conn, sshRemote.controlPath, sessionId), {
        timeout: PROBE_TIMEOUT_MS
      })
      return true
    } catch (e) {
      return !probeSaysAbsent(e)
    }
  }

  /** Find the live session registered under a node id (persistKey), if any. */
  private sessionByPersistKey(persistKey: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.persistKey === persistKey) return session
    }
    return undefined
  }

  /**
   * The live SSH-remote handle for a node id, if its session is running on a remote host.
   * Used by the remote context/subagent tails to read the node's transcript over the same
   * ControlMaster. Returns undefined for local sessions or unknown nodes.
   */
  sshRemoteForNode(
    nodeId: string
  ): { controlPath: string; conn: import('../shared/ssh').SshConnection } | undefined {
    const s = this.sessionByPersistKey(nodeId)
    if (!s?.sshRemote) return undefined
    return { controlPath: s.sshRemote.controlPath, conn: s.sshRemote.conn }
  }

  /** Whether a tmux session for this node id currently exists (server alive + session present).
   *  Async like the remote probe: a bulk project load fires one `create()` per terminal node,
   *  and a synchronous subprocess per probe would serialize on the main event loop. */
  private async tmuxSessionExists(persistKey: string): Promise<boolean> {
    if (!this.tmuxPath) return false
    try {
      await runAsync(this.tmuxPath, ['-L', TMUX_SOCKET, 'has-session', '-t', sessionName(persistKey)], {
        timeout: PROBE_TIMEOUT_MS
      })
      return true
    } catch (e) {
      // Same discrimination as the remote probe: tmux's exit 1 (no session / no server —
      // the reboot case) is absence; a spawn failure (EAGAIN under a bulk project load) is
      // not, and cold-restoring on it would type into a live session.
      return !probeSaysAbsent(e)
    }
  }

  /**
   * Spawn a PTY whose output/exit are delivered to `sinks` instead of the renderer. Used by
   * the relay host (Task 6) to serve PTYs over the E2EE transport: the host pipes `onData`
   * into `OP.Output` frames and maps client RPC/frames back to `write`/`resize`/`kill`. The
   * spawn (tmux session, hook env, shell selection) is identical to a normal renderer session.
   */
  createDetached(options: PtyCreateOptions, sinks: DetachedSinks): string {
    return this.spawnSession(options, null, sinks)
  }

  /**
   * Attach a detached (relay-served) PTY to the EXISTING tmux session for a node id, rather
   * than always creating a fresh one. Because `spawnSession` uses `tmux new-session -A`, passing
   * the node id as the `persistKey` reattaches the existing `nt-<nodeId>` session if it exists,
   * or creates it otherwise (graceful fallback). Used by the relay host so a mirrored terminal
   * resumes the host's live session instead of opening a blank shell. Pair with `captureSnapshot`
   * to paint the current screen before live output starts streaming. Because `sinks` is set here,
   * `spawnSession` attaches WITHOUT `-D` (co-attach), so the host's own local tmux client stays
   * attached and both the host and the mirroring client view the same session simultaneously.
   */
  attachDetached(
    persistKey: string,
    sinks: DetachedSinks,
    options: Omit<PtyCreateOptions, 'persistKey'> = { cols: 80, rows: 24 }
  ): string {
    return this.spawnSession({ ...options, persistKey }, null, sinks)
  }

  /**
   * Capture the CURRENT visible pane of a node's tmux session (with colors, via `-e`). Returns
   * the screen text so the relay host can send it as a snapshot the mirrored client paints before
   * live output. Empty string if tmux is unavailable or the session doesn't exist yet.
   */
  async captureSnapshot(persistKey: string): Promise<string> {
    if (!this.tmuxPath) return ''
    try {
      const { stdout } = await runAsync(
        this.tmuxPath,
        ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-t', sessionName(persistKey)],
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      )
      return stdout
    } catch {
      return ''
    }
  }

  private spawnSession(
    options: PtyCreateOptions,
    /** The client this session is spawned for, or null for a relay-served (detached) pty. */
    clientId: ClientId | null,
    sinks: DetachedSinks | undefined
  ): string {
    const sessionId = `pty-${++this.counter}`
    // For a remote (ssh-project) node the local PTY just holds the ssh client, so its local cwd
    // must be a real LOCAL directory (options.cwd is a REMOTE path that wouldn't exist locally and
    // would make pty.spawn throw). The remote working dir is passed to tmux via sshRemote.remoteCwd.
    let cwd = options.sshRemote ? os.homedir() : options.cwd || os.homedir()
    // `|| os.homedir()` only catches an EMPTY cwd. A cwd that is set but STALE — a project folder
    // the user deleted/unmounted — still reaches pty.spawn and makes posix_spawn fail. Verify the
    // directory actually exists and fall back to home if not, so a dead folder never kills the node.
    if (!options.sshRemote) {
      try {
        if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir()
      } catch {
        cwd = os.homedir()
      }
    }

    // Strip TMUX so tmux doesn't refuse to nest if the app itself was launched
    // from inside a tmux session.
    const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    delete env.TMUX
    delete env.TMUX_PANE

    // A GUI app launched from Finder/Dock inherits only a minimal PATH, so spawned terminals
    // couldn't find tools in /usr/local/bin, Homebrew, ~/.local/bin, nvm, bun, etc. (the classic
    // `command not found: claude`). Replace PATH with the user's real login-shell PATH so every
    // terminal — and any agent CLI it launches — resolves exactly what a normal terminal would.
    // Reads the cache filled by the async probe: create() awaits it, and the detached/host
    // paths spawn late enough that the init()-time prewarm has long since settled.
    const shellPath = shellPathNow() ?? null
    if (shellPath) env.PATH = shellPath

    // Same GUI-launch gap for the locale: with no LANG/LC_* the shell's `locale` is "C" (non-UTF-8),
    // so Claude Code and other TUIs fall back to ASCII box-drawing (rounded borders render as `_`/`|`).
    // Force a UTF-8 locale when the inherited env doesn't already declare one.
    const localeLang = resolveLocaleLang()
    if (localeLang) env.LANG = localeLang

    // Agent hooks: each session carries the hook-server coordinates + its node/agent id.
    // Our managed hook (installed globally in each agent's config, but a no-op without these
    // vars) then posts state back to us for any agent run in this session.
    // A REMOTE (ssh-project) session must NOT get the LOCAL hook env: it points at
    // 127.0.0.1:<localPort>, which is useless (and misleading) on the remote host. The remote
    // session's hook env is injected via the remote tmux `-e` below (from the reverse-tunnel
    // endpoint file), so leave the local hook env out entirely here.
    // Deterministic hook-reply approvals (docs/hook-reply-approvals.md): arm the permission hook's
    // wait-branch for claude sessions when the setting is on. `permWaitSecs > 0` injects
    // NODETERM_PERM_WAIT_SECS; off / non-claude ⇒ 0 ⇒ absent ⇒ legacy behavior.
    const permWaitSecs =
      this.getSettings().hookReplyApprovals && (options.agentId ?? 'claude') === 'claude'
        ? PERM_WAIT_SECS_DEFAULT
        : 0
    const hookEnv =
      options.persistKey && !options.sshRemote
        ? hookServer.buildPtyEnv(options.persistKey, options.agentId ?? 'claude', permWaitSecs)
        : {}
    for (const [k, v] of Object.entries(hookEnv)) env[k] = v

    // Managed Claude account: the whole session runs under the account's private config
    // dir. The claude CLI then reads/writes credentials + transcripts there. Also strip
    // env auth vars that would silently shadow the account's OAuth login (an inherited
    // ANTHROPIC_API_KEY wins over CLAUDE_CONFIG_DIR credentials). System-default nodes
    // (no accountId) are untouched. Remote (ssh) sessions get their account env via the
    // remote tmux `-e` list instead (the local ssh client process doesn't need it).
    let accountDir =
      options.accountId && !options.sshRemote ? claudeConfigDirFor(options.accountId) : null
    // Missing/deleted account dir (spec: error handling) → fall back to system default
    // instead of pointing claude at a dead dir; the node then behaves like an unbound one.
    // `accountFallback` is surfaced to the renderer (warning chip) via the create() result.
    let accountFallback = false
    if (accountDir && !fs.existsSync(accountDir)) {
      console.warn(`[accounts] config dir missing for ${options.accountId}, using system default`)
      accountDir = null
      accountFallback = true
    }
    if (accountDir) {
      env.CLAUDE_CONFIG_DIR = accountDir
      for (const k of AUTH_ENV_STRIP) delete env[k]
    }

    const settings = this.getSettings()
    let file: string
    let args: string[]

    // Resolve the session program. A bare 'ssh' is resolved to an absolute path because GUI
    // apps don't inherit the shell PATH; its args come from options.shellArgs.
    //
    // SECURITY — validate at the point the value becomes a command (same idiom as
    // `permissionModeFlag`): a lone tmux `new-session` command argument is run THROUGH A SHELL, so
    // a program string carrying shell metacharacters is command injection. The caller's provenance
    // is not visible from here (a node's `shell` may have come from a project file, a peer canvas
    // mutation, or the user), so an unsafe value degrades to `undefined` = the default shell —
    // never to execution. @shared/node-exec keeps foreign values out of `options.shell` in the
    // first place; this is the second layer.
    const reqShell = safeSessionProgram(options.shell)
    const program = reqShell === 'ssh' ? findSsh() ?? 'ssh' : reqShell
    const programArgs = options.shellArgs ?? []

    // SSH project node: run `ssh -t '<remote tmux attach-or-create>'` as the PTY program. The
    // REMOTE tmux provides persistence (over the project's ControlMaster); the local PTY just
    // holds the ssh client. Only when BOTH sshRemote and persistKey are set and ssh resolves —
    // otherwise this falls through to the unchanged local-tmux / plain-shell branches below.
    const remoteSsh = options.sshRemote && options.persistKey ? findSsh() : null
    if (options.sshRemote && options.persistKey && remoteSsh) {
      file = remoteSsh
      // Route this ssh child's agent lookups at the APP-PRIVATE ssh-agent when main is running one
      // (published via env because core cannot import main's ssh-agent.ts). Matters when the
      // ControlMaster is down: `childArgs` uses `ControlMaster=auto`, so this child authenticates
      // for real, and inheriting the ambient SSH_AUTH_SOCK would prompt in the pane and - for a
      // user with `AddKeysToAgent yes` in their own ~/.ssh/config - load the key into their LOGIN
      // agent permanently, the leak the app agent exists to close. Scoped to the remote branch:
      // local terminals keep the user's own agent.
      if (process.env.NODETERM_APP_AGENT_SOCK) env.SSH_AUTH_SOCK = process.env.NODETERM_APP_AGENT_SOCK
      // When the project's reverse tunnel + remote endpoint file are set up (Task 2), inject the
      // remote hook env into the remote tmux session so the installed hook script POSTs state back
      // over the unix-socket tunnel. Fail-open: no hookEndpointPath → no hook env (Phase-1 status).
      //
      // NODETERM_NODE_ID MUST be the RAW persistKey (the React Flow node id), NOT the tmux
      // session name (`nt-<id>`). The local path's hookServer.buildPtyEnv(persistKey, …) sets
      // NODETERM_NODE_ID = persistKey, and Canvas.tsx onAgentStatus keys agentStatus.byId /
      // selection off that raw id with no `nt-` stripping. Passing the session name here would
      // emit events under `nt-<id>` that match no node → no badge/notification/session/loop.
      const hookExtraEnv = options.sshRemote.hookEndpointPath
        ? [
            ...remoteHookEnvArgs(
              options.sshRemote.hookEndpointPath,
              options.persistKey,
              hookServer.getVersion(),
              // Same default the local path applies (`hookServer.buildPtyEnv(persistKey, agentId ??
              // 'claude', …)`) so a remote node's agent env matches its local twin exactly.
              options.agentId ?? 'claude'
            ),
            // Arm the remote permission hook's wait-branch too (deterministic approvals over SSH):
            // the request/answer files live on the REMOTE host; the desktop answers over the
            // ControlMaster. Only when the hook endpoint is set (else no POST → nothing learns the id).
            ...(permWaitSecs > 0 ? ['-e', `NODETERM_PERM_WAIT_SECS=${permWaitSecs}`] : [])
          ]
        : []
      // Managed REMOTE Claude account (Task 12): inject CLAUDE_CONFIG_DIR into the remote tmux
      // session via `-e`, pointing at the account's config dir on the remote host. The path must be
      // ABSOLUTE — tmux copies `-e` values verbatim (no `$HOME`/`~` expansion) — so we build it from
      // the connection's resolved remote $HOME. Fail-open: an unknown remoteHome (home resolution
      // failed on connect) skips the account env and the session runs under the remote `~/.claude`.
      const remoteAccountEnv =
        options.accountId && options.sshRemote.remoteHome
          ? accountTmuxEnvArgs(remoteAccountConfigDirAbs(options.sshRemote.remoteHome, options.accountId))
          : []
      args = remoteTmuxPtyArgs(
        options.sshRemote.conn,
        options.sshRemote.controlPath,
        sessionName(options.persistKey),
        options.sshRemote.remoteCwd,
        // An agent preset may pass a remote program to run inside the remote tmux; usually
        // undefined. The VALIDATED program (see `reqShell`): the remote tmux runs it the same way
        // the local one does, and an SSH project's project.json lives on the remote HOST — the one
        // place a foreign value is most at home.
        reqShell,
        options.shellArgs,
        [...hookExtraEnv, ...remoteAccountEnv],
        // Source nodeterm's remote tmux.conf via `-f` (written on connect, Task 2) so a cold-start
        // session gets mouse/clipboard/scrollback. Fail-open: undefined → remote tmux host defaults.
        options.sshRemote.tmuxConfPath
      )
    } else if (this.tmuxPath && settings.tmuxEnabled && options.persistKey) {
      // attach-or-create the persistent session for this node.
      // `-A` = attach-or-create. `-D` = detach OTHER clients on attach. We use `-D` ONLY for the
      // local renderer client (a remount should take sole ownership of its session). A host-served
      // PTY (sinks set) MUST NOT detach others: the host's own local client is attached to the same
      // `nt-<id>` session, and a connecting client should MIRROR it (tmux co-attach), not kick it
      // off — `-D` there is exactly what showed "[detached]" in every host window on connect.
      // (tmux sizes a co-attached session to the smallest client — the accepted mirroring tradeoff.)
      // `-e` sets the session environment explicitly (the tmux server is shared, so relying
      // on the client's inherited env would leak the first session's values into later ones).
      file = this.tmuxPath
      // The hook-server env (port/token/node id/agent id) is passed explicitly via `-e`
      // (one `-e KEY=VALUE` per key) since the shared tmux server can't rely on inherited env.
      const hookEnvArgs = Object.entries(hookEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      // Set the session PATH explicitly too: the tmux server is shared and long-lived (it outlives
      // the app), so a session created after an app update must NOT inherit a stale minimal PATH
      // baked into the server env at first launch — `-e` overrides it per new session at creation.
      const pathEnvArgs = env.PATH ? ['-e', `PATH=${env.PATH}`] : []
      // Same reasoning for LANG: force the UTF-8 locale per new session so a session created on a
      // shared/stale tmux server (started before this fix) still gets UTF-8 box-drawing.
      const langEnvArgs = env.LANG ? ['-e', `LANG=${env.LANG}`] : []
      // The account config dir must ride `-e` like the hook env: the tmux server is shared
      // and long-lived, so session env comes from creation args, not client inheritance.
      const accountEnvArgs = accountDir ? accountTmuxEnvArgs(accountDir) : []
      const attachFlags = tmuxAttachFlags(!!sinks)
      args = [
        '-L',
        TMUX_SOCKET,
        '-f',
        this.confPath,
        'new-session',
        ...attachFlags,
        ...hookEnvArgs,
        ...pathEnvArgs,
        ...langEnvArgs,
        ...accountEnvArgs,
        '-c',
        cwd,
        '-s',
        sessionName(options.persistKey)
      ]
      // Honor a custom session program at creation (ignored on reattach).
      const shell = program || settings.defaultShell
      if (shell) {
        args.push(shell)
        args.push(...programArgs)
      }
    } else {
      file =
        program ||
        settings.defaultShell ||
        process.env.SHELL ||
        (os.platform() === 'win32' ? 'powershell.exe' : 'bash')
      args = program ? programArgs : []
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd,
        env
      })
    } catch (err) {
      // node-pty surfaces the underlying failure as a bare "posix_spawnp failed." with no errno.
      // The recurring field cause is a cross-arch `electron-builder --x64` run clobbering
      // node-pty's spawn-helper in node_modules (arm64 app can't exec an x86_64 helper), so
      // check the helper's Mach-O arch first and name the exact remedy when it mismatches.
      const openPtys = this.sessions.size
      const reason = err instanceof Error ? err.message : String(err)
      const archNote = spawnHelperArchMismatch()
      // MEASURED, not guessed. node-pty discards the errno, so the old message ended every failure
      // with the same advice — restart, or rebuild node-pty for the wrong architecture. Both are
      // real causes and both are rare, and reading as authoritative sent at least one field report
      // (2026-08-06) chasing an architecture that was fine. `spawnResourceNote` states what it
      // actually counted and only names a remedy the numbers support.
      const resources = spawnResourceNote(readSpawnResources(), openPtys)
      throw new Error(
        `Failed to spawn terminal (${reason}). Program: ${file}, cwd: ${cwd}, ${resources} ` +
          (archNote ??
            `If this persists, restart the app (tmux sessions survive a restart) or run ` +
              `\`npm run rebuild\` in the repo — a release build may have rebuilt node-pty ` +
              `for the wrong architecture.`)
      )
    }

    // tmux-backed sessions snapshot their scrollback to disk periodically so a machine reboot
    // (which kills the tmux server) can still replay recent output on cold restart. A remote
    // (ssh-project) node is persisted too — the snapshot is captured from the REMOTE tmux.
    // Mark the session remote ONLY when the remote branch above actually ran (`remoteSsh` resolved).
    // If ssh is missing, the node fell through to a LOCAL tmux/plain spawn, so it must NOT be
    // marked remote — otherwise destroy/capture would target a remote tmux that was never spawned
    // and silently leak the local session.
    const remote = options.sshRemote && options.persistKey && remoteSsh ? options.sshRemote : undefined
    const tmuxBacked = !!(this.tmuxPath && settings.tmuxEnabled && options.persistKey)
    const persisted = !!options.persistKey && (remote ? true : tmuxBacked)
    const spawnSize = normalizeSize(options.cols, options.rows)
    // The spawning view's composite key. Usually the canvas node (PRIMARY), but a modal that opens
    // a node whose canvas terminal is closed spawns it too — under its own viewerId, correctly.
    const spawnSub = clientId === null ? null : subKey(clientId, options.viewerId ?? PRIMARY_VIEWER)
    const session: Session = {
      proc,
      subscribers: spawnSub === null ? new Set<SubKey>() : new Set<SubKey>([spawnSub]),
      sizes:
        spawnSub === null
          ? new Map<SubKey | null, PtySize>()
          : new Map<SubKey | null, PtySize>([[spawnSub, spawnSize]]),
      shown:
        spawnSub === null
          ? new Map<SubKey, PtySize>()
          : new Map<SubKey, PtySize>([[spawnSub, spawnSize]]),
      // node-pty was just spawned with these cols/rows, so the pty ALREADY has this size — record
      // it so a co-attach (or a fit that reports the same numbers) doesn't ioctl it needlessly.
      // A detached (relay-served) pty is left unseeded: its first `resize` must reach the pty,
      // exactly as before, because its sink never reports a size at create time.
      appliedSize: clientId === null ? undefined : spawnSize,
      nodeId: options.persistKey,
      indexKey: options.persistKey && !sinks ? options.persistKey : undefined,
      onData: sinks?.onData,
      onExit: sinks?.onExit,
      buf: [],
      bufBytes: 0,
      flushTimer: null,
      persistKey: persisted ? options.persistKey : undefined,
      sshRemote: remote,
      outputSinceSnapshot: true, // capture the initial screen on the first tick
      pausedBy: new Set<string>(),
      accountFallback
    }
    if (persisted) this.ensureSnapshotTimer()
    this.sessions.set(sessionId, session)
    // Index by node id even when the session is NOT tmux-persisted (`persisted` only governs
    // scrollback snapshots): co-attach must work for a plain-shell session too. Detached
    // (relay-served) ptys are deliberately NOT indexed — the relay path keeps its own session,
    // exactly as before, so this change cannot regress it.
    if (session.indexKey) this.byPersistKey.set(session.indexKey, sessionId)
    // This node has a live session again, so it is no longer deleted: drop any tombstone. Only the
    // destroyer can even reach a spawn for a tombstoned node (create() refuses everyone else), so
    // this is exactly "the owner brought the node back" (⌘Z) — and its co-viewers must be able to
    // join the new session rather than stay refused.
    if (session.indexKey) this.tombstones.delete(session.indexKey)
    // The replacement session for a RECYCLED node (worktree move) is now live and indexed, so its
    // co-viewers can safely be told to restart: their create() will `join` THIS session instead of
    // spawning `nt-<nodeId>` from their own (stale) cwd. This is the whole reason the notice waits.
    if (session.indexKey && this.pendingRecycle.has(session.indexKey))
      this.fireRecycled(session.indexKey, true)

    proc.onData((data) => this.queueData(sessionId, session, data))

    proc.onExit(({ exitCode }) => {
      this.flush(sessionId, session) // deliver any buffered output before the exit signal
      session.onExit?.(exitCode) // relay host sink (unchanged)
      for (const client of this.clientsOf(session))
        this.send(client, IPC.ptyExit(sessionId), exitCode)
      this.forget(sessionId, session)
    })

    return sessionId
  }

  /** Park a recycled session's co-viewers until the replacement session shows up (or the timeout
   *  fires). One entry per node: a second recycle before the first resolved supersedes it — the
   *  earlier waiters are folded in, since their session is just as dead. */
  private armRecycle(persistKey: string, sessionId: string, clients: ClientId[]): void {
    const prev = this.pendingRecycle.get(persistKey)
    if (prev) {
      clearTimeout(prev.timer)
      for (const c of prev.clients) clients.push(c)
    }
    this.pendingRecycle.set(persistKey, {
      sessionId,
      clients: new Set(clients),
      timer: setTimeout(() => this.fireRecycled(persistKey, false), RECYCLE_NOTIFY_TIMEOUT_MS)
    })
  }

  /**
   * Release a recycled node's co-viewers from the dead session. The event is keyed by the OLD
   * session id — that is the one their listeners are subscribed to — and carries the ONE thing they
   * cannot know and must not guess: whether there is a replacement session to restart onto.
   *
   * `ready` (fired the moment the replacement is registered) → restart: their create() joins it and
   * they follow the node into its new cwd.
   *
   * `!ready` (the escape-hatch timeout: the recycler's app died between the kill and its create) →
   * the terminal ENDS and offers a manual reopen. It must NOT auto-respawn: a co-viewer's create
   * options still carry the node's OLD cwd (a cwd change is not broadcast to other clients on this
   * branch), so it would spawn `nt-<id>` in the stale directory — and when the mover's app comes
   * back, its own `new-session -A` REATTACHES that stale-cwd session (the cwd option is ignored on
   * attach). Everyone's node would then claim the worktree path while the shell sits in the old
   * folder: exactly the silent failure the withheld notice exists to prevent, just 10 s later. An
   * ended terminal is honest, recoverable, and cannot lose the move.
   */
  private fireRecycled(persistKey: string, ready: boolean): void {
    const entry = this.pendingRecycle.get(persistKey)
    if (!entry) return
    this.pendingRecycle.delete(persistKey)
    clearTimeout(entry.timer)
    const channel = IPC.ptyRecycled(entry.sessionId)
    for (const client of entry.clients) this.send(client, channel, { ready })
  }

  /** Drop a dead/released session from both indexes. Keyed off `indexKey` (not `persistKey`,
   *  which is only set for tmux-PERSISTED sessions) so a plain-shell node is un-indexed too. */
  private forget(sessionId: string, session: Session): void {
    this.sessions.delete(sessionId)
    if (session.indexKey && this.byPersistKey.get(session.indexKey) === sessionId)
      this.byPersistKey.delete(session.indexKey)
  }

  /**
   * Push the effective (smallest-subscriber) size into the pty, then tell every subscriber whose
   * xterm is NOT already rendering that grid what it actually is, so each one renders exactly the
   * pty's grid (and letterboxes the leftover space) instead of its own `fit()` guess.
   *
   * Two separate idempotence guards, both load-bearing:
   *  - the pty is only resized when the effective size CHANGED (a same-size ioctl makes the tmux
   *    client redraw the whole pane for nothing);
   *  - a subscriber is only messaged when the size differs from what it is showing. With exactly
   *    one (viewing) subscriber the min of a one-element set is that subscriber's own fit, so a
   *    solo user is never sent a `pty:size` at all — the single-user path is unchanged.
   */
  private applySize(sessionId: string, session: Session): void {
    const size = effectiveSize(session.sizes.values())
    // Nobody is looking (every subscriber is parked, or none has reported a fit yet): leave the
    // pty at whatever size it has. Resizing it to a default here would garble the parked xterms'
    // buffers and the tmux pane behind them for no viewer's benefit.
    if (!size) return
    if (session.appliedSize?.cols !== size.cols || session.appliedSize?.rows !== size.rows) {
      session.appliedSize = size
      try {
        session.proc.resize(size.cols, size.rows)
      } catch {
        // resize can throw if the proc already exited; ignore.
      }
    }
    const channel = IPC.ptySize(sessionId)
    for (const sub of session.subscribers) {
      const shown = session.shown.get(sub)
      if (shown && shown.cols === size.cols && shown.rows === size.rows) continue
      session.shown.set(sub, size)
      // Collapse to the ClientId: `pty:size:<id>` is a per-client channel. Two views in one client
      // share it, so both xterms receive one send and each renders the authoritative size (and
      // letterboxes) — exactly the co-attach contract. (A solo user, min(one), is never sent at all.)
      this.send(subClient(sub), channel, size)
    }
  }

  /** Buffer a chunk; flush immediately past the byte cap, otherwise on a short timer. */
  private queueData(sessionId: string, session: Session, data: string): void {
    session.outputSinceSnapshot = true
    session.buf.push(data)
    session.bufBytes += data.length
    if (session.bufBytes >= MAX_BUF_BYTES) {
      this.flush(sessionId, session)
    } else if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(sessionId, session), FLUSH_MS)
    }
  }

  /** Send all buffered output for a session to every subscriber as a single IPC message. */
  private flush(sessionId: string, session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.buf.length === 0) return
    const data = session.buf.join('')
    session.buf = []
    session.bufBytes = 0
    session.onData?.(data) // relay host sink (unchanged)
    const channel = IPC.ptyData(sessionId)
    // One send per distinct client — a client's views share the per-client `pty:data:<id>` channel.
    for (const client of this.clientsOf(session)) this.send(client, channel, data)
  }

  /**
   * Flow control: a client pauses us when ITS xterm write backlog grows past a high watermark and
   * resumes once it drains, so a flood can't grow that renderer's buffer without bound. node-pty
   * pause()/resume() stops/starts reading the pty fd; the OS pipe applies backpressure to the
   * producing process.
   *
   * Co-attach makes this per-client: there is ONE pty behind N subscribers, so it must be paused
   * while ANY subscriber is behind (the slowest viewer sets the pace — the alternative, dropping
   * output for the laggard, needs a per-client backlog and a redraw, which is Task 5) and resumed
   * only when the LAST owed resume lands. `pausedBy` is that ledger.
   *
   * `clientId` is null for the relay host's detached pty, whose sink pauses on relay backpressure
   * and returns the resume on drain — one more owner in the same ledger, no special casing.
   *
   * `owner` says WHICH of the client's two queues is behind (see `FlowOwner`). It defaults to
   * `renderer` — the only owner that exists on the desktop and over the relay — so the Server
   * Edition's socket backpressure is the one caller that passes anything (`src/server/index.ts`).
   * A socket drain then returns the SOCKET's ticket only, never the pause the browser's own xterm
   * still owes.
   *
   * `viewerId` scopes the RENDERER pause to one VIEW: a client's canvas node and its kanban modal
   * are two separate xterms, each edge-latched, so they pause on their own tickets — same reasoning
   * as `owner`, one dimension over. Absent ⇒ PRIMARY. The `socket` owner is per-connection, so it
   * rides the PRIMARY key by convention; the two owners never collide (different `owner`).
   *
   * Single user: the set holds exactly his one renderer ticket while paused and is empty when he
   * resumes, so the actuator sees exactly the pause/resume pair it always saw.
   */
  setFlow(
    clientId: ClientId | null,
    sessionId: string,
    resume: boolean,
    owner: FlowOwner = 'renderer',
    viewerId?: string
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const sub = clientId === null ? null : subKey(clientId, viewerId ?? PRIMARY_VIEWER)
    if (resume) {
      this.releaseFlow(session, sub, owner)
      return
    }
    const wasPaused = session.pausedBy.size > 0
    session.pausedBy.add(flowTicket(sub, owner))
    if (wasPaused) return // already paused by someone — pause() again would be a no-op
    try {
      session.proc.pause()
    } catch {
      // pause can throw if the proc already exited; ignore.
    }
  }

  /**
   * Return a pause a VIEW (`sub`) owed us — because it resumed, or because it LEFT (kill /
   * dropClient) or reloaded (join). The pty resumes only when the ledger empties: a pause still
   * owed by a view that is here and behind must survive every other view's comings and goings,
   * or that renderer's queue grows without bound (its flow control is edge-latched and will
   * never re-pause). No-op when this view owed nothing — the single-user resume path is then
   * exactly the old `paused=false; proc.resume()`.
   *
   * `owner` scopes WHICH of that view's tickets is returned:
   *  - a drain returns exactly the one that drained (invariant (b)): the socket emptying says
   *    nothing about the browser's xterm backlog, and vice versa;
   *  - omitting it returns ALL of them, which is what a view's DEPARTURE means (invariant (a)):
   *    it receives nothing more on this session, so no owner of its can ever resume us again.
   */
  private releaseFlow(session: Session, sub: SubKey | null, owner?: FlowOwner): void {
    const owners = owner ? [owner] : FLOW_OWNERS
    let released = false
    for (const o of owners) {
      if (session.pausedBy.delete(flowTicket(sub, o))) released = true
    }
    if (!released) return
    if (session.pausedBy.size > 0) return
    try {
      session.proc.resume()
    } catch {
      // resume can throw if the proc already exited; ignore.
    }
  }

  /**
   * Return EVERY pause a whole CLIENT owed us, across all of its views and owners — the departure
   * sweep for `dropClient`. A vanished webContents takes all its views (canvas node + modal) with
   * it, so each of their tickets is unreturnable and must go, or the pty freezes for every co-viewer
   * (invariant (a)). Scans `pausedBy` because a client's tickets are spread over an unknown set of
   * viewer ids. Returns whether anything was released (the caller re-negotiates size iff so).
   */
  private releaseFlowForClient(session: Session, clientId: ClientId): boolean {
    let released = false
    for (const ticket of [...session.pausedBy]) {
      // A ticket is `${owner}#${sub}`; the sub follows the first '#'. 'relay' (the null sink) never
      // belongs to a client, so it is skipped.
      const sub = ticket.slice(ticket.indexOf('#') + 1)
      if (sub === 'relay') continue
      if (subClient(sub) === clientId && session.pausedBy.delete(ticket)) released = true
    }
    if (released && session.pausedBy.size === 0) {
      try {
        session.proc.resume()
      } catch {
        // resume can throw if the proc already exited; ignore.
      }
    }
    return released
  }

  /**
   * Input from ONE client into the (possibly shared) session.
   *
   * ATTRIBUTION IS SERVER-SIDE, never client-declared: the sender is already identified by the
   * transport (Electron's webContents id, the Server Edition's uiId, the relay HostSession's
   * peer ClientId), so nobody can type as somebody else — and a phone typing over the relay lights
   * up the "X is typing" badge on every canvas with no client-side change at all. `clientId` is
   * `null` for a client the transport cannot name (a relay-served pty whose session has no presence
   * peer): its input still reaches the pty, it is just not badged.
   *
   * The badge is reported per NODE — the node id, which is what the canvas draws — never per
   * sessionId. `session.nodeId` is that id, and it is unconditional (see the field): the two
   * conditional ids next to it, `indexKey` and `persistKey`, each go missing in a case the other
   * covers — but with tmux OFF a relay-served (phone) session has NEITHER, and reading them here
   * would leave a phone's typing silently unbadgeable while a co-attached desktop peer's still lit.
   * A session created with no persistKey (a scratch pty) has no node id at all, and so nothing to
   * badge.
   *
   * The hub throttles the broadcast (1 per 500 ms per client+node), so PtyManager does no
   * throttling of its own — but it does skip presence entirely when the user is ALONE: with one
   * peer in the table the only recipient would be the typist, whose own badge is never drawn, so a
   * solo keystroke burst must not cost a presence fan-out. The single-user path stays exactly the
   * old `sessions.get(id)?.proc.write(data)`.
   *
   * No locking — concurrent writers interleave characters in the one tmux session. That is the
   * documented v1 behavior (docs/team-presence.md, "No locking"); the badge IS the warning.
   */
  write(clientId: ClientId | null, sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (clientId !== null && session.nodeId && presenceHub.peerCount() > 1)
      presenceHub.noteTyping(clientId, session.nodeId)
    session.proc.write(data)
  }

  /**
   * A subscriber reports the size IT can render. The pty runs at the smallest of them, so nobody
   * is ever sent more columns than their xterm can draw (a subscriber with room to spare
   * letterboxes the remainder). With exactly one subscriber, min(one) is that subscriber's own
   * size — the single-user path resizes the pty to exactly what it asked for, as it always did.
   *
   * A `null` cols/rows means **"subscribed, but not looking"**: the client stays in the fan-out
   * (it keeps consuming output) but drops out of the min. This is what a PARKED terminal reports —
   * the renderer keeps an unmounted node's xterm+PTY alive for 5 minutes so a remount re-adopts
   * them exactly, and without this a window somebody parked small would keep every other viewer's
   * terminal shrunk for those 5 minutes even though nobody is looking at it. `null` (not 0) carries
   * that meaning because 0 already has one: `effectiveSize` clamps a not-yet-measured VIEWING
   * client's 0 up to 1 rather than letting it zero the pty.
   *
   * `clientId` is null for the relay host's detached pty (its sink reports the mirrored client's
   * size); it constrains the size like any other viewer but is not in `subscribers`, so it gets no
   * `pty:size` message — the relay has its own size channel.
   */
  resize(
    clientId: ClientId | null,
    sessionId: string,
    cols: number | null,
    rows: number | null,
    viewerId?: string
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // The reporting VIEW's key (null = the relay sink, keyed by literal null as before). A client's
    // canvas node and modal vote separately, so the pty runs at the min over both.
    const sub = clientId === null ? null : subKey(clientId, viewerId ?? PRIMARY_VIEWER)
    // Loose `== null` on purpose (belt and braces): the sizes arrive over IPC on the desktop and
    // over a JSON wire in the Server Edition, and JSON has no `undefined`. If any encoding path
    // ever loses the distinction again, "no size" must degrade to PARK — dropping the view from
    // the ledger — and never to `normalizeSize(undefined, undefined)`, which clamps to a 1×1 grid
    // and would shrink the shared pty to one cell for every co-attached viewer.
    if (cols == null || rows == null) {
      session.sizes.delete(sub)
    } else {
      const size = normalizeSize(cols, rows)
      session.sizes.set(sub, size)
      // The view's own xterm fits itself locally (as it always has), so its fit — not the last
      // authoritative size we sent it — is what it is rendering right now. If that fit isn't the
      // effective size, applySize() below corrects it straight back.
      if (sub !== null) session.shown.set(sub, size)
    }
    this.applySize(sessionId, session)
  }

  /**
   * One client detaches (node unmount / tab close). With co-attach this is per-CLIENT: the pty
   * (and the tmux session behind it) survives while anyone else is still watching. Only when the
   * last subscriber leaves — and no relay sink is attached — do we release the pty client. With
   * tmux the tmux session itself keeps running either way, as always.
   *
   * `clientId` is null for the relay host releasing its own detached (sink-served) pty: it drops
   * the sinks, which are that session's only "subscriber".
   */
  kill(clientId: ClientId | null, sessionId: string, viewerId?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // The departing VIEW's key (null = the relay sink). Closing the kanban modal names its viewerId
    // and detaches ONLY it; the canvas node's PRIMARY view stays subscribed and the pty lives on.
    const sub = clientId === null ? null : subKey(clientId, viewerId ?? PRIMARY_VIEWER)
    if (clientId === null) {
      session.onData = undefined
      session.onExit = undefined
      session.sizes.delete(null)
    } else {
      session.subscribers.delete(sub as SubKey)
      session.sizes.delete(sub)
      session.shown.delete(sub as SubKey)
    }
    // The departing view (or sink) may have been one of the ones that paused us, and it will
    // never send the matching resume now — leaving that pause in place would freeze the terminal
    // for everyone who stayed. But WHICH tickets are unreturnable depends on whether the CLIENT is
    // wholly gone or just this one VIEW:
    //  - the relay sink (clientId null) departs entirely → return every owner it owed.
    //  - the client still has ANOTHER view (e.g. the canvas node closed but the kanban modal is
    //    still open on the SAME connection): only THIS view's RENDERER pause is unreturnable — its
    //    own xterm is gone. The SOCKET pause is per-CONNECTION (it rides the PRIMARY view and is
    //    shared by every view of this client), so it must survive; handing it back here would
    //    permanently un-pause a still-jammed connection whose renderer flow control is edge-latched.
    //  - this was the client's LAST view → the whole connection is gone. Sweep every ticket it owes
    //    across all its views and owners (its socket ticket rides the PRIMARY view, so it is not
    //    necessarily keyed on `sub`) — the same departure sweep `dropClient` uses.
    // A pause owed by a DIFFERENT client that is still here is untouched either way (the pty stays
    // paused until IT drains — its renderer cannot re-pause; see `Session.pausedBy`).
    if (clientId === null) this.releaseFlow(session, sub)
    else if ([...session.subscribers].some((s) => subClient(s) === clientId))
      this.releaseFlow(session, sub, 'renderer')
    else this.releaseFlowForClient(session, clientId)
    if (session.subscribers.size > 0 || session.onData) {
      // Somebody is still watching: the departing client's size no longer constrains the pty.
      this.applySize(sessionId, session)
      return
    }
    if (session.flushTimer) clearTimeout(session.flushTimer)
    // Final snapshot on detach (node unmount / app quit) so the very latest scrollback survives
    // a reboot. The tmux session itself keeps running, so this only races a same-instant capture.
    // Skipped when nothing arrived since the last periodic capture (pane content is unchanged).
    if (session.persistKey && session.outputSinceSnapshot)
      void this.snapshotScrollback(session.persistKey, session.sshRemote)
    // releasePty (not proc.kill()): a paused pty never reads EOF, so kill() alone leaks the
    // master fd on every detach until the process runs out of descriptors (see pty-release.ts).
    releasePty(session.proc as ReleasablePty)
    this.forget(sessionId, session)
  }

  /**
   * A client VANISHED (browser tab closed — the normal way to leave the Server Edition — or a
   * destroyed/crashed renderer): unsubscribe it from every session it was watching, exactly as a
   * `pty:kill` per session would. Sessions that fall to zero subscribers are released (final
   * scrollback snapshot + pty client released). tmux sessions are NOT killed — releasing the pty
   * client is the whole point: the terminal keeps running and the next open reattaches.
   *
   * Without this, a vanished client stays in `subscribers` forever: the pty is never released,
   * its detach-time snapshot never taken, and — worse — a pty that client had PAUSED could never
   * be resumed (the leave path is what returns the owed resume).
   */
  dropClient(clientId: ClientId): void {
    // Snapshot the entries: kill() mutates `sessions` when a session falls to zero subscribers.
    for (const [sessionId, session] of [...this.sessions]) {
      // A vanished webContents takes ALL its views with it (canvas node + any modal), so kill each
      // of this client's composite subscriptions. The last one released takes the pty down — exactly
      // as the per-view `pty:kill`s would have, had the tab closed cleanly. (The outer snapshot holds
      // the session ref even after the final kill `forget`s it.)
      const views = [...session.subscribers].filter((s) => subClient(s) === clientId)
      if (views.length > 0) {
        for (const sub of views) this.kill(clientId, sessionId, subViewer(sub))
        continue
      }
      // NOT a subscriber — and yet it may still hold state here. Sweeping only the sessions a client
      // subscribes to made the departure an INCOMPLETE cleanup: anything it owed elsewhere (a pause,
      // a size) could never be returned, so a single entry left behind froze or clamped a shared pty
      // for every real viewer, for the life of the core process. The wire casts are now gated on
      // membership (`subscribes`), so this should find nothing; sweep unconditionally anyway — the
      // invariant "nothing outlives its client" must not depend on every future caller remembering
      // the gate. Sweep by CLIENT (every view/owner it might have planted), not by a single key.
      let changed = false
      for (const key of [...session.sizes.keys()])
        if (key !== null && subClient(key) === clientId && session.sizes.delete(key)) changed = true
      for (const key of [...session.shown.keys()])
        if (subClient(key) === clientId) session.shown.delete(key)
      // Every owner's ticket, not just the renderer's: a vanished client's SOCKET pause is as
      // unreturnable as its renderer's (invariant (a) — the pty would freeze for every co-viewer).
      if (this.releaseFlowForClient(session, clientId)) changed = true
      if (changed) this.applySize(sessionId, session)
    }
  }

  /**
   * Capture a session's output. `full` grabs the entire scrollback (`-S -`, for the
   * markdown view); otherwise the recent ~200 lines (AI naming, palette search).
   */
  async captureSession(persistKey: string, full = false): Promise<string> {
    // Remote (ssh-project) node: there is no local tmux session — capture from the REMOTE tmux
    // over the project's ControlMaster (mirrors snapshotScrollback / destroySession).
    const sshRemote = this.sessionByPersistKey(persistKey)?.sshRemote
    if (sshRemote) {
      const ssh = findSsh()
      if (!ssh) return ''
      try {
        const { stdout } = await runAsync(
          ssh,
          remoteCapturePaneArgs(sshRemote.conn, sshRemote.controlPath, sessionName(persistKey), full),
          { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
        )
        return stdout
      } catch {
        return ''
      }
    }
    if (!this.tmuxPath) return ''
    try {
      const { stdout } = await runAsync(
        this.tmuxPath,
        ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-t', sessionName(persistKey), '-S', full ? '-' : '-200'],
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      )
      return stdout
    } catch {
      return ''
    }
  }

  /**
   * The CURRENT screen of a live session, by sessionId — the redraw sent to a client that fell so
   * far behind that its socket backlog was discarded (see ServerPlatform's WS_DROP_WATER). Reuses
   * the existing `tmux capture-pane -e` paths (`captureSnapshot`, which the relay host already
   * paints a joining mirror with; `captureSession` for an ssh-project node, whose tmux lives on the
   * remote host) rather than adding a second capture. '' when the session or tmux is unavailable —
   * the client then just clears and resumes streaming.
   */
  async captureForResync(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) return ''
    const key = session.persistKey ?? session.indexKey
    if (!key) return ''
    if (session.sshRemote) return this.captureSession(key)
    return this.captureSnapshot(key)
  }

  /**
   * Where the pane's cursor is, for a client about to PAINT a captured screen.
   *
   * `capture-pane` returns the pane's text and nothing else, so a client painted from it ends up
   * with its cursor after the last character written rather than where the application put it —
   * the 2026-08-05 report (refresh an agent CLI, and the block sits at the end of the status line
   * until the first keystroke repaints). This is the missing half, asked of tmux directly.
   *
   * `undefined` on every failure — no tmux, no session, an unparseable reply, a dead ControlMaster.
   * The renderer's answer to that is to leave the cursor alone, which is exactly the behaviour this
   * fix replaces, so a failure here costs nothing that was not already lost.
   */
  async paneCursor(sessionId: string): Promise<PaneCursor | undefined> {
    const session = this.sessions.get(sessionId)
    const key = session?.persistKey ?? session?.indexKey
    if (!session || !key) return undefined
    const target = sessionName(key)
    try {
      if (session.sshRemote) {
        const ssh = findSsh()
        if (!ssh) return undefined
        const { stdout } = await runAsync(
          ssh,
          remotePaneCursorArgs(session.sshRemote.conn, session.sshRemote.controlPath, target)
        )
        return parsePaneCursor(stdout)
      }
      if (!this.tmuxPath) return undefined
      const { stdout } = await runAsync(this.tmuxPath, [
        '-L',
        TMUX_SOCKET,
        'display-message',
        '-p',
        '-t',
        target,
        '#{cursor_x} #{cursor_y} #{cursor_flag}'
      ])
      return parsePaneCursor(stdout)
    } catch {
      return undefined
    }
  }

  /**
   * Snapshot a node's recent scrollback (with colors, `-e`) to disk for cold-restart replay.
   * Best-effort: a missing session / unavailable tmux just leaves the prior snapshot in place.
   * Returns false when the capture failed, so the periodic tick can re-mark the session dirty
   * and retry (the dirty bit is cleared optimistically before the capture starts).
   */
  private async snapshotScrollback(
    persistKey: string,
    sshRemote?: NonNullable<PtyCreateOptions['sshRemote']>
  ): Promise<boolean> {
    if (sshRemote) {
      // Remote (ssh-project) node: capture from the REMOTE tmux over the project's ControlMaster.
      const ssh = findSsh()
      if (!ssh) return false
      try {
        const { stdout } = await runAsync(
          ssh,
          remoteCapturePaneArgs(sshRemote.conn, sshRemote.controlPath, sessionName(persistKey), false),
          { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
        )
        if (stdout) await writeScrollback(persistKey, stdout)
        return true
      } catch {
        // remote session gone / master down — keep the last good snapshot
        return false
      }
    }
    if (!this.tmuxPath) return false
    try {
      const { stdout } = await runAsync(
        this.tmuxPath,
        ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-t', sessionName(persistKey), '-S', '-1500'],
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      )
      if (stdout) await writeScrollback(persistKey, stdout)
      return true
    } catch {
      // session gone / tmux unavailable — keep the last good snapshot
      return false
    }
  }

  /**
   * Send literal text, by default followed by Enter, into a node's tmux session (e.g. a slash
   * command). Works whether or not a client is attached. Returns false if tmux is unavailable or
   * the session doesn't exist yet.
   *
   * `opts.enter` defaults to `true` — every existing caller (slash commands, /rename, /branch,
   * note pushes) relies on the Enter being sent, so this stays bit-for-bit unless a caller opts
   * out. `enter: false` is for dictation's Insert action: it writes text into the terminal
   * WITHOUT submitting it, so the user can edit/append before running it themselves.
   *
   * An SSH-project node has no LOCAL tmux session to target (its pty program is `ssh -t '<remote
   * attach>'`) — so if the node's LIVE session is registered with `sshRemote`, this runs the
   * remote counterpart instead (`remoteTmuxSendKeysArgs`, over the project's ControlMaster),
   * mirroring how `remoteSessionExists` reuses `findSsh()` + `runAsync`. A node with no live
   * session at all (nothing mounted right now) still falls through to the local path and returns
   * false there, same as before this change — reaching a currently-unmounted SSH node's remote
   * session is not supported.
   */
  async sendText(persistKey: string, text: string, opts?: { enter?: boolean }): Promise<boolean> {
    const enter = opts?.enter ?? true
    const target = sessionName(persistKey)
    const sshRemote = this.sessionByPersistKey(persistKey)?.sshRemote
    if (sshRemote) {
      const ssh = findSsh()
      if (!ssh) return false
      try {
        await runAsync(ssh, remoteTmuxSendKeysArgs(sshRemote.conn, sshRemote.controlPath, target, text, enter))
        return true
      } catch {
        return false
      }
    }
    if (!this.tmuxPath) return false
    try {
      if (await this.bracketPasteRequested(target)) {
        // Paste-aware target (agent TUIs, multiplexers like herdr): one atomic write — the
        // text framed in paste markers plus the Enter — so the composer sees a definitive
        // paste boundary and the Enter can never be re-chunked into the paste (issue #47).
        await runAsync(this.tmuxPath, [
          '-L',
          TMUX_SOCKET,
          'send-keys',
          '-t',
          target,
          '-l',
          bracketedInjection(text, enter)
        ])
        return true
      }
      // The literal text and the Enter (when sent) must go in order, so await sequentially.
      await runAsync(this.tmuxPath, ['-L', TMUX_SOCKET, 'send-keys', '-t', target, '-l', text])
      if (enter) {
        await runAsync(this.tmuxPath, ['-L', TMUX_SOCKET, 'send-keys', '-t', target, 'Enter'])
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * The command currently in the foreground of a node's tmux pane (e.g. 'claude', 'zsh') — how
   * the in-place agent restart observes that the CLI has exited and a shell owns the pane again.
   * null when it is unknown: no live session, tmux unavailable, or the query failed. Unknown is
   * never evidence of a particular command, so every failure path answers null rather than
   * throwing — the caller polls this behind its own deadline.
   *
   * Mirrors `sendText`'s dispatch: an SSH-project node has no LOCAL tmux session to target, so a
   * session registered with `sshRemote` is queried on the REMOTE tmux over the project's
   * ControlMaster (`remotePaneCommandArgs`); everything else asks the local socket.
   */
  async paneCommand(persistKey: string): Promise<string | null> {
    const target = sessionName(persistKey)
    const sshRemote = this.sessionByPersistKey(persistKey)?.sshRemote
    if (sshRemote) {
      const ssh = findSsh()
      if (!ssh) return null
      try {
        const { stdout } = await runAsync(
          ssh,
          remotePaneCommandArgs(sshRemote.conn, sshRemote.controlPath, target)
        )
        return stdout.trim() || null
      } catch {
        return null
      }
    }
    if (!this.tmuxPath) return null
    try {
      const { stdout } = await runAsync(this.tmuxPath, [
        '-L',
        TMUX_SOCKET,
        'display-message',
        '-p',
        '-t',
        target,
        '#{pane_current_command}'
      ])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  /**
   * Did the application in this pane request bracketed-paste mode? tmux tracks the DECSET
   * 2004 state per pane and exposes it as `bracket_paste_flag`. Unknown — query fails, old
   * tmux without the format — reads as false, so delivery degrades to the legacy two-step
   * path rather than sending paste markers an unaware app would render as garbage input.
   */
  private async bracketPasteRequested(target: string): Promise<boolean> {
    if (!this.tmuxPath) return false
    try {
      const { stdout } = await runAsync(this.tmuxPath, [
        '-L',
        TMUX_SOCKET,
        'display-message',
        '-p',
        '-t',
        target,
        '#{bracket_paste_flag}'
      ])
      return stdout.trim() === '1'
    } catch {
      return false
    }
  }

  /**
   * List the names of all live nodeterm tmux sessions (on our dedicated socket). Used by the
   * relay host's `projects.list` RPC so a paired phone can enumerate the host's sessions the same
   * way the SSH browse path does (`tmux -L node-terminal list-sessions`). Returns the trimmed,
   * non-empty session names; `[]` on any error (tmux unavailable / no server / no sessions) so it
   * never throws.
   */
  async listNodetermSessions(): Promise<string[]> {
    if (!this.tmuxPath) return []
    try {
      const { stdout } = await runAsync(this.tmuxPath, [
        '-L',
        TMUX_SOCKET,
        'list-sessions',
        '-F',
        '#{session_name}'
      ])
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    } catch {
      return []
    }
  }

  /**
   * Permanently end a node's persistent session — the user clicked ×, and that means "this
   * terminal is gone, for everyone" (`tmux kill-session`), which is the whole meaning of the
   * button. With co-attach the node may have OTHER viewers, and they must be told: each one gets
   * `pty:closed:<sessionId>` carrying `{ by: <the ClientId that pressed ×> }`, so their terminal
   * lands in a "closed by <name>" state.
   *
   * The payload names the CLIENT, not the person: names are unverified presence data and live in
   * the renderer's presence table, so PtyManager needs no dependency on the peer table (and cannot
   * be made to lie about a name it never sees).
   *
   * The close event is what STOPS the other viewers from quietly reopening the node: a respawn
   * would resurrect a session its owner deliberately deleted — a fresh shell with none of the
   * state, plus a stray tmux session nobody asked for. It only reaches SUBSCRIBERS, though, so the
   * destroy also leaves a `tombstone`: a client that was never subscribed (its project is closed /
   * inactive, so it has no mounted terminal) is refused at `create` time instead.
   *
   * `clientId` is null when nothing/no-one attributable did it (an internal caller).
   */
  destroySession(clientId: ClientId | null, persistKey: string): Promise<void> {
    return this.endSession(clientId, persistKey, 'delete')
  }

  /**
   * End a node's persistent session so the SAME node id can immediately respawn in a NEW cwd —
   * "move into worktree". The tmux kill is identical to `destroySession` (without it, the respawn's
   * `tmux new-session -A` would just reattach the old session, keeping the old working directory);
   * the INTENT is the opposite: nothing was deleted. The node is still on every canvas and still
   * works, so a co-viewer must not be pushed into the permanent, un-respawnable "closed by <name>"
   * state — that used to strand them on a live node until they deleted and re-added it.
   *
   * What a co-viewer gets instead is `pty:recycled:<oldSessionId>`: restart your terminal, the node
   * moved. Their re-create then CO-ATTACHES to the replacement session (`join`), so they follow the
   * node into its new cwd and are never left holding the dead pty.
   *
   * The notice is deliberately WITHHELD until the replacement session is registered (see
   * `spawnSession`). Sent any earlier, a co-viewer's restart could beat the recycler's own create
   * and spawn `nt-<nodeId>` from ITS options — i.e. in the node's STALE cwd — silently undoing the
   * move for everyone. `RECYCLE_NOTIFY_TIMEOUT_MS` is the escape hatch when no respawn ever comes.
   *
   * `clientId` is the recycler: it drives its own respawn (`respawnNonce`), so it is excluded from
   * the notice. Solo user: there is no one else, so nothing is sent and nothing is armed — the path
   * is the old destroy, minus a fan-out to an empty set.
   */
  recycleSession(clientId: ClientId | null, persistKey: string): Promise<void> {
    return this.endSession(clientId, persistKey, 'recycle')
  }

  /**
   * The shared teardown behind `destroySession` / `recycleSession`: drop the session (and its
   * co-attach index entry, in-flight create, buffered output, flow-control ledger), drop the
   * cold-restore snapshot, and `tmux kill-session`. Everything the two intents disagree about is
   * the ONE branch below — what the other subscribers are told (see `EndIntent`).
   */
  private async endSession(
    clientId: ClientId | null,
    persistKey: string,
    intent: EndIntent
  ): Promise<void> {
    // Both callers run while the session is still live, so its sshRemote is known. Capture it
    // synchronously before any await. The index is the co-attach one (UI sessions); the scan is
    // the fallback for a session that is live but not indexed.
    const dyingId = this.byPersistKey.get(persistKey)
    const dying = dyingId ? this.sessions.get(dyingId) : undefined
    const sshRemote = dying?.sshRemote ?? this.sessionByPersistKey(persistKey)?.sshRemote
    // Un-index NOW (synchronously): this session is finished either way, so a create() that races
    // the kill-session below — the worktree-move respawn does exactly that — must spawn a fresh
    // session instead of co-attaching to the one we are about to end.
    // Also drop any in-flight create for this node: a create racing the kill-session below must
    // spawn a fresh session, not await (and then join) the one we are ending.
    this.inflight.delete(persistKey)
    // A DELETE is remembered (the respawn guard for clients `pty:closed` cannot reach — see
    // `tombstones`); a RECYCLE explicitly forgets, because the node is not going anywhere and its
    // replacement session must be spawnable. Recorded even when no live session exists in this
    // process: the node may be deleted from a canvas whose terminal was never opened here.
    if (intent === 'delete') this.tombstone(persistKey, clientId)
    else this.tombstones.delete(persistKey)
    if (dyingId && dying) {
      this.byPersistKey.delete(persistKey)
      dying.indexKey = undefined
      // Collapse the composite subscribers to DISTINCT clients, minus the destroyer: closed/recycled
      // are per-ClientId events (a client's two views share one channel and hear it once), and
      // viewer granularity is invisible to peers. The destroyer is excluded whether it watched via
      // the canvas node, the modal, or both.
      const others = [...new Set([...dying.subscribers].map(subClient))].filter(
        (c) => c !== clientId
      )
      if (intent === 'delete') {
        const channel = IPC.ptyClosed(dyingId)
        for (const client of others) this.send(client, channel, { by: clientId })
      } else if (others.length > 0) {
        this.armRecycle(persistKey, dyingId, others)
      }
      // Tear the session down HERE rather than leaving it to the client's own `kill` / the pty's
      // onExit: with N subscribers there is no single kill to wait for, and every one of them may
      // be mid-anything — parked, paused (its owed resume will never come now), desynced past the
      // drop ceiling. The Session object holds all of that state, so dropping it drops the lot: no
      // leaked pause, no stray subscriber still in the fan-out, no timer. (The per-client
      // backpressure bookkeeping on the Server Edition shell is pruned by the `pty:closed:` /
      // `pty:recycled:` event itself — see ServerPlatform.forgetFlowState.)
      if (dying.flushTimer) clearTimeout(dying.flushTimer)
      dying.subscribers.clear()
      dying.sizes.clear()
      dying.shown.clear()
      dying.pausedBy.clear()
      // releasePty (not proc.kill()): a paused pty never reads EOF, so kill() alone would leak the
      // master fd — and a session destroyed while a drowning viewer had it paused is exactly that
      // case (see pty-release.ts). It resumes the pty first, so the fd actually closes.
      releasePty(dying.proc as ReleasablePty)
      this.forget(dyingId, dying)
    }
    // This session is gone for good — drop its cold-restore snapshot too. A recycle drops it as
    // well (and always did, when the worktree move went through `destroy`): the snapshot is of the
    // OLD cwd's session, and the respawn is a cold start (`fresh`), so replaying it would paint the
    // pre-move terminal into the new one.
    await deleteScrollback(persistKey)
    if (sshRemote) {
      // Remote (ssh-project) node: end the REMOTE session.
      const ssh = findSsh()
      if (ssh) {
        try {
          await runAsync(ssh, remoteTmuxKillArgs(sshRemote.conn, sshRemote.controlPath, sessionName(persistKey)))
        } catch {
          // remote session may not exist / master down; ignore
        }
      }
      // ...and then fall through to the LOCAL kill below rather than returning. A remote node
      // normally has no local session — but it may have one from before `requireRemote`, when a
      // create issued with the master down spawned a local shell under this exact name. That
      // orphan outlived everything (this branch used to return here, so the delete never reached
      // it) with whatever the node had launched still running in it. The node is being deleted:
      // anything wearing its name goes with it. Costs one `kill-session` that usually says "no
      // such session", which is already the ignored case below.
    }
    if (!this.tmuxPath) return
    try {
      await runAsync(this.tmuxPath, ['-L', TMUX_SOCKET, 'kill-session', '-t', sessionName(persistKey)])
    } catch {
      // session may not exist; ignore
    }
  }

  /**
   * On quit, detach all clients (do NOT kill tmux sessions — that's the whole point
   * of persistence). The tmux server keeps the sessions alive for next launch.
   */
  /** Returns a promise of the final scrollback snapshots: the capture + write are async, so
   *  the quit path must hold `before-quit` briefly (see index.ts) or the process exits before
   *  they land and the last ≤15s of output is missing from a post-reboot cold restore. */
  killAll(): Promise<void> {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
    const finals: Promise<unknown>[] = []
    for (const session of this.sessions.values()) {
      if (session.flushTimer) clearTimeout(session.flushTimer)
      // Final scrollback snapshot on quit so a reboot can replay it. Skipped for sessions with
      // no output since the last periodic capture (unchanged pane content).
      if (session.persistKey && session.outputSinceSnapshot)
        finals.push(this.snapshotScrollback(session.persistKey, session.sshRemote))
      releasePty(session.proc as ReleasablePty)
    }
    this.sessions.clear()
    this.byPersistKey.clear()
    // Pending recycle notices die with the sessions they were waiting on (their timers would
    // otherwise fire into a manager that has released everything).
    for (const entry of this.pendingRecycle.values()) clearTimeout(entry.timer)
    this.pendingRecycle.clear()
    // Clear the in-flight index with the other two, or a create still spawning at quit would leave
    // a promise (and the session it resolves to) reachable from a manager that has released
    // everything else — a later create would then co-attach to a session we already let go.
    this.inflight.clear()
    return Promise.all(finals).then(() => undefined)
  }

  /** Variadic so a payload-less event (`pty:recycled`) sends no argument at all, rather than an
   *  explicit `undefined` the shells would have to serialize and the renderer ignore. */
  private send(clientId: ClientId, channel: string, ...args: unknown[]): void {
    platform().sendTo(clientId, channel, ...args)
  }
}

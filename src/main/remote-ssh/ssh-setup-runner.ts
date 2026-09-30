import { nativeMux, useNativeSsh } from '../../core/remote-ssh/native/native-runtime'
import { spawnSshArgvStream } from '../../core/remote-ssh/native/native-invoke'
import { spawn } from 'node:child_process'
import { childArgs } from '../../core/remote-ssh/control-master'
import { findExecutableSync } from '../../core/exec-path'
import type { ProjectSetupRunner, ProjectSetupTarget } from '../../core/project-setup-service'
import { SETUP_TIMEOUT_MS, createSetupOutputStream } from '../../core/setup-output-stream'
import { posixQuote, quoteRemotePath, type SshConnection } from '../../shared/ssh'
import { appSshAgent } from './ssh-agent'

/** What the runner needs to reach a host: the connection it belongs to plus its ControlMaster
 *  socket — exactly `SshProjectManager.refForRemoteCwd`'s return shape. */
export interface SshSetupRef {
  conn: SshConnection
  controlPath: string
}

/**
 * The FULL identity a setup run must be resolved against. Not just the remote cwd: the default
 * remoteCwd is `~`, so cwd alone collides across every project that never picked a directory, and
 * host+user alone collides across ports (containers / hosts behind one NAT are routinely the same
 * `user@host` on different ports). Resolving on anything less either runs the script on the wrong
 * machine or permanently refuses one of two legitimate projects. `port` absent = ssh's default 22.
 */
export interface SshSetupEndpoint {
  host: string
  user: string
  port?: number
  remoteCwd: string
}

type SshTarget = NonNullable<ProjectSetupTarget['ssh']>

/** `user@host` for a message, with the port only when it is not the default (a `:22` in every
 *  refusal would be noise; a non-default port is exactly the detail that explains the refusal). */
function endpointLabel(e: { host: string; user: string; port?: number }): string {
  return e.port !== undefined && e.port !== 22 ? `${e.user}@${e.host}:${e.port}` : `${e.user}@${e.host}`
}

/** Same endpoint? Ports compare by EFFECTIVE value, so `undefined` and `22` are one host. */
function sameEndpoint(a: { host: string; user: string; port?: number }, b: { host: string; user: string; port?: number }): boolean {
  return a.host === b.host && a.user === b.user && (a.port ?? 22) === (b.port ?? 22)
}

/** `ssh` itself uses 255 for "could not run the command at all" (auth failure, dead link, unknown
 *  host). Every refusal below reports the same code deliberately: to the UI, "the remote never ran
 *  your script" is one fact, whether it was ssh or this file that decided so. */
const SSH_FAILURE_CODE = 255

/** A shell only accepts `NAME=value` for a NAME that is a valid identifier. A key outside this set
 *  cannot be expressed as an assignment at all — it is dropped rather than emitted, because the
 *  only alternatives are `env 'weird key'=v` (still refused by most shells) or splicing something
 *  the remote shell would reparse. Values need no such rule: `posixQuote` can represent any byte
 *  sequence except NUL, and NUL cannot survive argv anyway, so a NUL-bearing value is dropped too. */
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

let cachedSsh: string | null | undefined
/** Absolute `ssh`, resolved the way `ssh-project.ts`'s private `sshBin()` does — a GUI process does
 *  not inherit the login shell's PATH. Same memoization rule: only cache a MISS once the async PATH
 *  probe has settled, so an early call cannot pin `ssh` to the bare name forever. */
function defaultSshPath(): string {
  if (cachedSsh !== undefined) return cachedSsh ?? 'ssh'
  const found = findExecutableSync('ssh', ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'])
  cachedSsh = found
  return found ?? 'ssh'
}

/**
 * The remote one-liner a setup run executes.
 *
 * ```
 * cd <cwd> && NAME=<v> … sh -lc <script>
 * ```
 *
 * `ssh` forwards NO local environment (`SendEnv` needs matching `AcceptEnv` on the host, which we
 * do not control), so the three `NODETERM_*` values the service hands us must ride inline as
 * assignments prefixing the command — that form exports them into `sh` without touching the
 * caller's own environment.
 *
 * EVERY interpolated value is one quoted token: the script is attacker-controlled by construction
 * (it arrives through a git-shared `project.json`, and the trust gate approves it for EXECUTION —
 * not for rewriting the command around it), and a project name or remote cwd is no better. The one
 * deliberate exception is a LEADING `~` in the cwd (`quoteRemotePath`): single quotes suppress
 * tilde expansion, so `'~/app'` would `cd` into a literal directory named `~`. Only the tilde is
 * left bare; the remainder of the path stays quoted, so a directory name still cannot inject.
 */
export function buildSetupRemoteCommand(cwd: string, env: Record<string, string>, script: string): string {
  const assignments: string[] = []
  for (const [key, value] of Object.entries(env)) {
    // Cannot be represented safely → omit the assignment. The script then sees the variable unset,
    // which a `${NODETERM_ROOT_PATH:-}` can handle; a spliced command it could not.
    if (!SHELL_IDENTIFIER.test(key)) continue
    if (value.includes('\0')) continue
    assignments.push(`${key}=${posixQuote(value)}`)
  }
  const prefix = assignments.length ? `${assignments.join(' ')} ` : ''
  return `cd ${quoteRemotePath(cwd)} && ${prefix}sh -lc ${posixQuote(script)}`
}

/**
 * The SSH half of `ProjectSetupRunner` — the first STREAMING remote exec in the tree.
 *
 * `sshRun`/`execFile` (ssh-project.ts) is deliberately not reused: it buffers, drops stderr, and
 * reaps at 15s, none of which a `npm install` that prints for four minutes survives. This spawns
 * the child itself and pipes both streams through the same capped+debounced discipline as the
 * local runner (`setup-output-stream.ts`), so a run reports identically wherever it executes.
 *
 * ── EXACTLY ONE CHILD, EVER ─────────────────────────────────────────────────────────────────────
 * `childArgs` carries `ControlMaster=auto`: when the master socket is dead each child does NOT
 * multiplex, it opens a full connection — a real login. A retry loop here would be the 72k-logins/day
 * shape this repo already lived through once (see pane-probe.ts's warning, and the ssh-controlmaster
 * memory). So a dead master is a FAILURE of the run — 255 plus ssh's own stderr as the explanation —
 * never something to retry. The manager's watchdog is what repairs masters; this file only reports.
 */
export function makeSshSetupRunner(
  resolveRef: (endpoint: SshSetupEndpoint) => SshSetupRef | null | undefined,
  opts?: { timeoutMs?: number; sshPath?: () => string; agentEnv?: () => Record<string, string> }
): ProjectSetupRunner {
  const timeoutMs = opts?.timeoutMs ?? SETUP_TIMEOUT_MS
  const sshPath = opts?.sshPath ?? defaultSshPath
  // The app-private agent holds the unlocked key for this app run; a tty-less child has no askpass
  // wiring of its own, so without it a run against an encrypted key fails auth (ssh-project.ts:1662
  // passes the same env for the same reason).
  const agentEnv = opts?.agentEnv ?? (() => appSshAgent.env())

  return ({ script, cwd, env, onChunk, signal, ssh }) =>
    new Promise((resolve) => {
      const { append, flush } = createSetupOutputStream(onChunk)
      // A refusal is reported exactly like a failed script: a chunk the user can read plus a
      // non-zero exit. The service layer has one failure shape, never two.
      const refuse = (message: string): void => {
        append(`${message}\n`)
        flush()
        resolve({ exitCode: SSH_FAILURE_CODE })
      }

      // Already aborted before we ever spawned (a cancel raced the consent gate) — starting an ssh
      // child now would leak a connection nobody is waiting for.
      if (signal.aborted) {
        resolve({ exitCode: 143 })
        return
      }
      if (!ssh) {
        refuse('Cannot run: this project has no SSH target.')
        return
      }
      const target: SshTarget = ssh
      // The whole endpoint goes to the resolver, never the cwd alone — see `SshSetupEndpoint`.
      const endpoint: SshSetupEndpoint = {
        host: target.server.host,
        user: target.server.user,
        port: target.server.port,
        remoteCwd: target.remoteCwd
      }
      let ref: SshSetupRef | null | undefined
      try {
        ref = resolveRef(endpoint)
      } catch (e) {
        // The injected resolver reaches into the ssh-project manager; a throw there must degrade to
        // a reported failure, never to a rejected runner promise (`ProjectSetupRunner` NEVER
        // rejects — the service would report it as `failed` with no exit code and no explanation).
        refuse(`Cannot run: ${(e as Error).message}`)
        return
      }
      if (!ref) {
        // "No live connection for THIS endpoint" — which covers both a disconnected project and one
        // whose only matching-cwd connection belongs to a different machine. Never a reason to dial:
        // connecting is the manager's job, and doing it here would be a login per failed run.
        refuse(`Cannot run: not connected to ${endpointLabel(endpoint)} (${endpoint.remoteCwd}).`)
        return
      }
      // Defense in depth, not the primary check (the resolver owns matching): a resolver that ever
      // answered with a connection to a machine the target never named would execute the project's
      // script there. Cheap to verify, and the failure it prevents is unrecoverable.
      if (!sameEndpoint(ref.conn, target.server)) {
        refuse(
          `Cannot run: the resolved connection for ${endpoint.remoteCwd} is ` +
            `${endpointLabel(ref.conn)}, not ${endpointLabel(endpoint)}.`
        )
        return
      }

      const remote = buildSetupRemoteCommand(cwd, env, script)
      let child: ReturnType<typeof spawn>
      try {
        const argv = childArgs(ref.conn, ref.controlPath, remote)
        // Native transport (Windows): a channel on the project's one connection, shaped like the
        // child this code already drives (pipes, close, error, kill).
        child = useNativeSsh()
          ? (spawnSshArgvStream(nativeMux(), argv) as unknown as ReturnType<typeof spawn>)
          : spawn(sshPath(), argv, {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
              env: { ...process.env, ...agentEnv() }
            })
      } catch (e) {
        // `spawn` throws SYNCHRONOUSLY for a malformed invocation (a NUL byte in an argument, a bad
        // option object) — only ENOENT & co. arrive as an `error` event. Same reported shape either way.
        refuse(`Cannot run: ${(e as Error).message}`)
        return
      }

      // SIGKILL the LOCAL ssh client, and no process group — unlike the local runner, which needs
      // `detached` + `kill(-pid)` because the script's children are on THIS machine holding OUR
      // pipes. Here the only local process is the mux client: killing it closes the channel, our
      // pipes close with it, and the run finishes promptly. That prompt finish is what cancel and
      // timeout actually owe the user.
      //
      // ── WHAT THIS DOES NOT DO: END THE REMOTE COMMAND ───────────────────────────────────────────
      // There is no `-t` here (a setup script must not be handed a tty), so the remote session has
      // no controlling terminal and sshd delivers NO SIGHUP when the channel closes — it just closes
      // the command's pipes. The remote `sh -lc …` therefore keeps running until it next writes to a
      // closed stdout and takes SIGPIPE, which for a quiet or output-buffered script may be a long
      // time, or never. Killing a local process group cannot change this: the work is on another
      // machine. (`detached` would additionally be its own liability — an orphaned mux client
      // outliving the app.)
      //
      // The consequence to know before trusting cancel: single-flight is enforced LOCALLY (the
      // service's runKey map, which this kill releases), so a re-run started right after a cancel
      // can race a still-live remote command — two `npm install`s in one checkout. Ending the remote
      // side for real would need a wrapper that records a remote pid and a second connection to kill
      // it; that is deliberately not in this task. The user is told instead (chunk below).
      const kill = (): void => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone between our check and this call — nothing left to kill.
        }
      }

      // Say the true thing at the moment it becomes relevant, rather than letting "cancelled" imply
      // a stop that did not happen. (Swallowed if the run already blew the output cap — in which
      // case the truncation note has already told the user the transcript is incomplete.)
      const REMOTE_MAY_SURVIVE = 'the remote command may still be running on the host'
      const timeoutTimer = setTimeout(() => {
        append(`\n[timed out — killed the local ssh client; ${REMOTE_MAY_SURVIVE}]\n`)
        kill()
      }, timeoutMs)
      timeoutTimer.unref?.()
      const onAbort = (): void => {
        append(`\n[cancelled — killed the local ssh client; ${REMOTE_MAY_SURVIVE}]\n`)
        kill()
      }
      signal.addEventListener('abort', onAbort)

      const finish = (exitCode: number): void => {
        clearTimeout(timeoutTimer)
        signal.removeEventListener('abort', onAbort)
        flush() // final flush — whatever the debounce timer hadn't fired yet
        resolve({ exitCode })
      }

      child.stdout?.on('data', (d: Buffer) => append(d.toString('utf-8')))
      // stderr is STREAMED, not dropped (`sshRun` drops it): for a setup script it carries the
      // compiler/installer diagnostics, and for a broken link it carries ssh's own explanation —
      // which is the only thing that distinguishes "your script failed" from "the host is gone".
      child.stderr?.on('data', (d: Buffer) => append(d.toString('utf-8')))
      // Never reject: a spawn failure (ssh binary missing, EACCES) reports like any other run.
      child.on('error', (e) => {
        append(`${(e as Error).message}\n`)
        finish(SSH_FAILURE_CODE)
      })
      child.on('close', (code) => finish(code ?? 1))
    })
}

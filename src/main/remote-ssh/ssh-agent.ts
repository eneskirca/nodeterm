// An ssh-agent owned by THIS app run, so an unlocked key is forgotten when nodeterm quits.
//
// `AddKeysToAgent=yes` (control-master.ts) makes the first successful unlock load the key into
// whatever `SSH_AUTH_SOCK` names, and every later master then authenticates with no prompt at all.
// Pointed at the user's LOGIN agent that unlock outlives the app entirely: the key stays usable by
// every process on the machine until logout or reboot, which makes the passphrase on the key file
// nearly decorative once it has been typed. Pointing the masters at an agent this app spawns and
// kills scopes the unlock to the app's lifetime instead: quit nodeterm and the next launch asks
// again, while a single run keeps its single prompt (reconnects, watchdog respawns, closing and
// reopening a project all reuse it).
//
// What this does and does not buy, precisely: it scopes the key's LIFETIME, not its reachability.
// The socket is 0600, but any process running as this user can still point `SSH_AUTH_SOCK` at it
// and use the key while the app is up, exactly as with the login agent.
//
// Deliberate tradeoffs:
//  - A key ALREADY loaded in the user's login agent no longer authenticates a nodeterm master, so
//    those users now see one prompt per app run where they previously saw none. That is the price
//    of "forgotten on quit"; `SSH_AUTH_SOCK` names exactly one socket, so there is no both.
//  - Nothing is ever added to the user's own agent, and their shell/git never see ours.
//  - A credential that lives ONLY in an agent (1Password, Secretive, a smartcard) has no key file
//    to unlock, so overriding the socket would lock those users out. Most are unaffected because
//    `IdentityAgent` in ~/.ssh/config overrides `SSH_AUTH_SOCK` and is the documented setup for
//    them; ssh-project.ts surfaces an error hint naming IdentityAgent for the rest (a hint, not
//    a retry - see connectOnce's failure tail for why retrying on the ambient agent is wrong).
//    CAVEAT (issue #427): the ENV-REFERENCE spellings — `IdentityAgent SSH_AUTH_SOCK` and
//    friends — resolve through the very variable this file overrides, so "config overrides env"
//    is false for exactly those users. They are honored anyway: an `ssh -G` probe
//    (core/remote-ssh/agent-probe.ts) detects them per host and the argv builders pin the
//    ambient socket with `-o IdentityAgent=…`, which beats both the config line and this
//    override. This env override itself stays unconditional — read that file before touching it.
//
// The agent runs in the FOREGROUND (`-D`) as a direct child, so `kill()` really ends it (the
// default double-forks away and would survive us), and with a default identity lifetime (`-t`)
// because `stop()` is not guaranteed to run: `app.exit()`, a SIGKILL or a crash leaves the agent
// reparented to init, holding the key, with its socket unlinked by the next run's `start()` — an
// unreachable process that lives until reboot. The lifetime is what bounds that case.
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

/** How core's own ssh spawners (remote PTYs in pty-manager, remote git) find this agent: core
 *  cannot import a main-process module, so the socket path is published in process.env under this
 *  name while the agent is up. NOT `SSH_AUTH_SOCK` itself - that would leak into every LOCAL
 *  terminal the app spawns and quietly repoint the user's own shell at our agent. */
const APP_AGENT_ENV = 'NODETERM_APP_AGENT_SOCK'

/** Absolute ssh-agent binary. A GUI Electron app does not inherit the shell PATH (the exact
 *  reason sshBin()/findSsh() exist), and a bare `spawn('ssh-agent')` miss is only a console.error
 *  whose visible symptom is "a passphrase prompt on every connect this run" with no diagnostic. */
function findSshAgent(): string {
  for (const p of ['/usr/bin/ssh-agent', '/opt/homebrew/bin/ssh-agent', '/usr/local/bin/ssh-agent']) {
    if (existsSync(p)) return p
  }
  return 'ssh-agent' // PATH as a last resort; a miss fails into env()'s fail-closed posture
}

/** Backstop for an agent orphaned by a crash (a clean quit kills it outright), and the ceiling on
 *  how long one app run can stay unlocked — hence generous rather than tight. */
const KEY_LIFETIME = '12h'
/** How long the agent survives the last SSH connection going away. A grace, not a policy: the
 *  connect dialog tears down its throwaway `ssh-browse-*` master a few hundred ms BEFORE the real
 *  project connects, and killing the agent in that gap would charge the user a second passphrase
 *  prompt to add one server. */
const IDLE_GRACE_MS = 10_000

interface AgentChild {
  pid?: number
  kill(): void
  on(event: string, cb: (...args: unknown[]) => void): void
}

/** NT_MULTI sandboxes carry their identity in NT_USER_DATA; every other instance derives it from
 *  its real userData dir. The second half matters because a bare `npm run dev` (userData
 *  `<appData>/node-terminal`) and another instance with its own userData (an NT_MULTI sandbox, a
 *  Server Edition data dir) have different userData dirs, so the
 *  single-instance lock does not stop them running side by side - under one fixed key the second
 *  instance's start() rmSync's the first one's LIVE socket and its quit unlinks it again, leaving
 *  that app silently agentless (a prompt per reconnect) for the rest of its run. Guarded require:
 *  under plain node (vitest) the electron module is only a binary-path string with no `app`. */
function defaultDataDirKey(): string {
  if (process.env.NT_USER_DATA) return process.env.NT_USER_DATA
  try {
    const { app } = require('electron') as { app?: { getPath(name: string): string } }
    if (app) return app.getPath('userData')
  } catch {
    // plain node (tests): no electron runtime
  }
  return 'default'
}

/** The socket lives in the same short, space-free home dir as the ControlMaster sockets: a unix
 *  socket path is capped near 104 bytes, which userData (~/Library/Application Support/…) eats.
 *  Keyed by data dir like `controlPathFor` is keyed by project id, so a second instance
 *  (`NT_MULTI=1`, ./dev-test.sh, a dev build next to the installed app) binds its own socket
 *  instead of unlinking the first one's and silently leaving that app agentless when it quits. */
export function agentSockPath(dataDirKey = defaultDataDirKey()): string {
  return path.join(os.homedir(), '.nodeterm', `agent-${instanceSockId(dataDirKey)}.sock`)
}

/** The per-instance hash shared by every socket this app run binds under ~/.nodeterm (the agent
 *  above, the askpass relay), so NT_MULTI instances never unlink each other's sockets. */
export function instanceSockId(dataDirKey = defaultDataDirKey()): string {
  return createHash('sha256').update(dataDirKey).digest('hex').slice(0, 8)
}

export class AppSshAgent {
  private child: AgentChild | null = null
  /** In-flight `start()`, so concurrent connects share one spawn AND one wait. Returning early on
   *  `if (this.child)` while the socket is still binding would hand the second connect an agent
   *  that cannot answer yet, and its key would go nowhere. */
  private starting: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private spawnAgent: (args: string[]) => AgentChild = (args) =>
      spawn(findSshAgent(), args, { stdio: 'ignore' }),
    private sockPath: string = agentSockPath()
  ) {}

  /**
   * Start the agent if it is not already running, resolving once its socket is listening. Called
   * before a master is spawned rather than at boot, so an app run that never opens an SSH project
   * never pays for an agent process. Never rejects: a failed start costs a passphrase prompt per
   * connect (the pre-agent behavior), which is the safe direction — see `env()`.
   */
  start(): Promise<void> {
    this.cancelScheduledStop()
    return (this.starting ??= this.spawnAndWait())
  }

  private async spawnAndWait(): Promise<void> {
    // Publish the socket for the CORE ssh spawners that cannot import this file: remote PTYs
    // (pty-manager) and remote git (remote-git) shell out to ssh themselves, and `childArgs` uses
    // `ControlMaster=auto`, so with the master down one of them authenticates for real. Left
    // inheriting the ambient socket, a remote PTY (which HAS a tty) prompts for the passphrase in
    // the pane and, for anyone with `AddKeysToAgent yes` in their own ~/.ssh/config, loads the key
    // into their login agent permanently. Published BEFORE anything that can fail, for the same
    // fail-closed reason as `env()`: a sync throw below must degrade to prompting, never to the
    // ambient agent.
    process.env[APP_AGENT_ENV] = this.sockPath
    try {
      mkdirSync(path.dirname(this.sockPath), { recursive: true, mode: 0o700 })
      // `ssh-agent -a` refuses to bind over an existing file, and a crash leaves one behind.
      rmSync(this.sockPath, { force: true })
      const child = this.spawnAgent(['-D', '-t', KEY_LIFETIME, '-a', this.sockPath])
      const forget = (): void => {
        if (this.child === child) {
          this.child = null
          this.starting = null // a later connect restarts the agent instead of joining a dead one
        }
      }
      child.on('exit', forget)
      // Without this an ENOENT (no ssh-agent on PATH) is an unhandled 'error' event on the child.
      child.on('error', forget)
      this.child = child
    } catch (e) {
      console.error('[ssh-agent] could not start an app-private agent', e)
      this.child = null
      return
    }
    // The socket appears a few ms after exec. Bounded: past this we simply proceed, and ssh prompts.
    const deadline = Date.now() + 1_000
    while (this.child && !existsSync(this.sockPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /**
   * Env for anything that may AUTHENTICATE (the ControlMaster spawn, and the child ssh/scp that
   * re-auth when the master is down).
   *
   * Deliberately unconditional, even before the agent is up or after a failed start: falling back
   * to `{}` would let ssh inherit the ambient `SSH_AUTH_SOCK`, and `AddKeysToAgent=yes` would then
   * quietly load the key into the user's login agent forever — the exact leak this exists to close,
   * reached by the silent path. Pointing at a socket that is not listening costs one prompt; ssh
   * warns and carries on. Fail closed.
   */
  env(): Record<string, string> {
    return { SSH_AUTH_SOCK: this.sockPath }
  }

  /** Kill the agent after `delayMs` unless something starts it again first (see IDLE_GRACE_MS).
   *  Unref'd: a pending forget must never hold the process open. */
  scheduleStop(delayMs: number = IDLE_GRACE_MS): void {
    this.cancelScheduledStop()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop()
    }, delayMs)
    this.idleTimer.unref?.()
  }

  private cancelScheduledStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Kill the agent and drop its socket. MUST stay synchronous for the same reason as
   * `disconnectAll()`: it runs from Electron's sync `before-quit`, and anything awaited there can
   * lose the race with process exit — precisely the case where the key must not survive.
   */
  stop(): void {
    this.cancelScheduledStop()
    this.child?.kill()
    this.child = null
    this.starting = null
    delete process.env[APP_AGENT_ENV]
    try {
      rmSync(this.sockPath, { force: true })
    } catch {
      // best effort: a leftover socket file is unlinked by the next start()
    }
  }

  /** Is an agent process live right now? Only for tests and diagnostics. */
  isRunning(): boolean {
    return this.child !== null
  }
}

export const appSshAgent = new AppSshAgent()

/**
 * "Can a node on THIS machine get a managed Codex identity?" — the construction-time half of the
 * fallback.
 *
 * Modelled on `core/claude-cli.ts`: one answer behind one CorePlatform RPC channel, registered by
 * BOTH shells, whose unknown answer is the conservative one. The renderer asks it before it writes
 * a launch line, and a `false` means the line stays the bare `codex` it has always been — never a
 * launcher path that might not resolve, which would be a dead node.
 *
 * It differs from claude's in WHERE the work happens: claude's probe is lazy and self-starting
 * (`claude --version` can run whenever someone first asks), while this one cannot compute anything
 * until the shell has handed the hook server its node-auth secret. So the shell PUSHES the answer
 * in (`refreshCodexIdentityCaps`) and a caller that arrives first WAITS for it — see
 * `codexIdentityCaps` below for why waiting, rather than answering "no", is the only safe default
 * here.
 *
 * FOUR things have to be true, and none is knowable from the renderer:
 *  1. the hook server holds the per-node auth secret (no secret ⇒ no capability token ⇒ the
 *     launcher would fall back anyway, one process later),
 *  2. the generated launcher could actually be written (a read-only or full data dir is a real
 *     failure mode, and it is the one the renderer cannot see at all),
 *  3. this INSTALL of codex can run a shared app-server at all — see
 *     `codexManagedRuntimeInstalled`. This is the precondition the first cut got wrong: it asked
 *     `--help` for a `--remote` flag, which an npm-installed codex 0.146.0 advertises perfectly
 *     happily while `codex app-server daemon start` answers
 *
 *       Error: managed standalone Codex install not found at
 *       ~/.codex/packages/standalone/current/codex
 *
 *     So on the mainstream install channel we wrote `nodeterm-codex` into the launch line and only
 *     discovered at runtime that it could never work: a wasted curl round trip, a `plain codex`
 *     chip, and a warning banner on the first fallback of EVERY node, forever, for a feature that
 *     cannot function on that install. Noisily inert. Answered here it is genuinely inert, and
 *  4. the installed `codex` accepts `--remote` — see `codexCliSupportsRemote`. This is the only
 *     one that cannot be recovered from at runtime: the launcher's preflight proves that
 *     `codex app-server daemon start` exits 0, and then EXECS. A CLI with an app-server but no
 *     `--remote` dies on a clap usage error after that exec, where there is no fallback left. So
 *     it is answered here, once per app run, entirely off the launch path.
 *
 * SERVER EDITION: `src/server` registers the same async answer after arming its raw-0600 node
 * secret. The shared identity is core-owned and local on that host; no Electron primitive is
 * required.
 */
import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import path from 'path'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { type CodexIdentityCaps } from '../shared/types'
import { installCodexLauncher, codexThreadIdentityAvailable } from './codex-identity-proxy'
import { codexHome } from './usage/codex-usage'
import { findInLoginPath } from './pty-manager'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

/**
 * The fixed path `codex app-server daemon start` requires, under the CLI's own `CODEX_HOME`.
 *
 * Not a guess: the CLI names this exact path in the error it refuses with, and reports it as
 * `managedCodexPath` in `codex app-server daemon stop`'s JSON. Its own words are "the daemon starts
 * and updates app-server from that fixed path".
 */
export function codexManagedRuntimePath(home = codexHome()): string {
  return path.join(home, 'packages', 'standalone', 'current', 'codex')
}

/**
 * Can this install run a shared app-server? A STAT, and deliberately not `codex app-server daemon
 * start`.
 *
 * The three candidates, and why this one:
 *  - `codex app-server daemon start` is the authoritative answer, and it STARTS A DAEMON. This
 *    probe runs once per app run at boot, on every machine with codex installed, including the
 *    runs where no Codex node is ever opened. A capability probe must not create the very process
 *    the feature exists to create lazily.
 *  - `codex app-server daemon version` is read-only but connects to the control socket, so it
 *    fails on a perfectly capable install whose daemon merely is not running yet — i.e. after
 *    every boot. Fail-closed, but uselessly so: the probe runs ONCE, so it would pin the feature
 *    off for the session on the machines it is meant to be on.
 *  - `codex app-server daemon stop` prints the authoritative JSON (`managedCodexPath`,
 *    `managedCodexVersion`) and exits 0 even when nothing is running — but it stops a RUNNING
 *    daemon, which is the shared app-server every other node is attached to. Refused outright.
 *
 * So: the same fact, read the cheapest conclusive way, with no side effect and no spawn. Anything
 * we cannot establish — a relocated home, a permission error, a layout we do not recognise —
 * throws or misses and answers `false`, which is the bare `codex` this feature degrades to
 * everywhere else. A wrong "no" costs only the shared app-server; a wrong "yes" costs a round trip
 * and a banner on every node.
 */
export function codexManagedRuntimeInstalled(home = codexHome()): boolean {
  try {
    accessSync(codexManagedRuntimePath(home), constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Pure: help text → does this CLI accept `--remote`?
 *
 * FEATURE-detected from `--help`, never version-compared, for the same reason claude's
 * `--session-id` is: the release it appeared in is not documented anywhere this repo can check,
 * and an unrecognised flag does not degrade — it makes the CLI exit. Anchored on a word boundary
 * so `--remote-auth-token-env`, or prose mentioning the flag inside another option's description,
 * cannot answer yes for it.
 *
 * Absent help output ⇒ false ⇒ no shared identity ⇒ the bare `codex` command, exactly as before
 * this feature. That is the same direction every other unknown in this file degrades in: a wrong
 * "yes" here costs the node, a wrong "no" costs only the shared app-server.
 */
export function codexCliSupportsRemote(...helpOutputs: Array<string | null | undefined>): boolean {
  return helpOutputs.some((h) => /(^|\s)--remote(\s|=|$)/m.test(h ?? ''))
}

async function probeRemoteFlag(): Promise<boolean> {
  try {
    // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
    // CLI lookup in the app (pty-manager, claude-cli, commit-message).
    const bin = await findInLoginPath('codex')
    if (!bin) return false
    const help = await execFileP(bin, ['--help'], { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.stdout)
      .catch(() => null)
    if (codexCliSupportsRemote(help)) return true
    // Some CLIs list a global flag only under the subcommand that takes it. One extra spawn, paid
    // once per app run and only when the top-level help did not already answer yes.
    const resumeHelp = await execFileP(bin, ['resume', '--help'], { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.stdout)
      .catch(() => null)
    return codexCliSupportsRemote(resumeHelp)
  } catch {
    // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "no shared identity".
    return false
  }
}

let latest: CodexIdentityCaps | null = null
let ready: Promise<CodexIdentityCaps> | null = null
let announce: ((c: CodexIdentityCaps) => void) | null = null

/**
 * Compute the answer and publish it. Called once by the shell, AFTER the node-auth secret has been
 * set (or has definitively failed), because the secret is one quarter of what "shared" means.
 *
 * Async because of the `--remote` probe, which is a login-shell lookup plus up to two `--help`
 * spawns. That cost is paid HERE — once, during boot, with nothing waiting on it but the first
 * Codex launch line — and never on the launch path itself, where it would be visible latency in
 * the pane every single time, to answer a question whose answer cannot change while the app runs.
 *
 * The install check runs FIRST and short-circuits the spawns: on an npm install it is a single
 * failed stat, and there is nothing to learn from a help page about a flag we will never reach.
 */
export async function refreshCodexIdentityCaps(
  probeRemote: () => Promise<boolean> = probeRemoteFlag,
  probeAppServer: () => boolean | Promise<boolean> = codexManagedRuntimeInstalled
): Promise<CodexIdentityCaps> {
  const appServer = await Promise.resolve()
    .then(() => probeAppServer())
    .catch(() => false)
  const remoteFlag = appServer ? await probeRemote() : false
  const launcher =
    appServer && remoteFlag && codexThreadIdentityAvailable() ? installCodexLauncher() : null
  latest = { shared: !!launcher, launcherPath: launcher, remoteFlag, appServer }
  if (announce) {
    announce(latest)
    announce = null
  } else if (!ready) {
    ready = Promise.resolve(latest)
  }
  return latest
}

/**
 * The answer, ASYNC — like `claudeCliCaps()`, and for the same reason.
 *
 * An early caller must WAIT rather than be told "no". A sync getter would answer `false` to
 * anything that asked before `refreshCodexIdentityCaps()` ran, and since a `false` means no
 * launcher ever runs, it would pin the feature off for the whole session with no chip, no toast
 * and no log line to say so — one reordering of the boot chain away, invisibly. Waiting makes the
 * ordering a latency question instead of a correctness one. The renderer races this against its
 * own bounded timeout, so a shell that never refreshes costs a plain-codex session, not a hang.
 */
export function codexIdentityCaps(): Promise<CodexIdentityCaps> {
  if (latest) return Promise.resolve(latest)
  if (!ready) ready = new Promise((resolve) => (announce = resolve))
  return ready
}

/** Wire the answer onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerCodexIdentityIpc(
  answer: () => CodexIdentityCaps | Promise<CodexIdentityCaps> = codexIdentityCaps
): void {
  platform().handle(IPC.codexIdentityCaps, () => answer())
}

export function resetCodexIdentityCapsForTests(): void {
  latest = null
  ready = null
  announce = null
}

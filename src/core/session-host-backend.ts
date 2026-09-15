// The thin facade `pty-manager.ts` talks to — owns the ONE process-wide `SessionHostClient` (one
// long-lived connection per app process, matching how `PtyManager` itself keeps one `tmuxPath`
// for the whole process) and exposes exactly the operations pty-manager's existing tmux/ssh call
// sites need a session-host equivalent for. Nothing here is tmux-specific or Electron-specific;
// see docs/windows-session-host.md for how each of these maps onto the underlying protocol.

import { platform } from './platform'
import {
  SessionHostClient,
  SessionHostProtocolCompatibilityError
} from './session-host-client'
import { SessionHostPty } from './session-host-pty'
import type { ExecuteLaunchResult, SessionHostSpawnOptions } from '../session-host/protocol'
import type { PreparedAgentLaunch } from './agent-launch'

let client: SessionHostClient | null = null

function getClient(): SessionHostClient {
  if (!client) {
    client = new SessionHostClient({
      userDataDir: platform().userDataDir,
      resourcesPath: platform().resourcesPath,
      // The one that actually answers in a packaged build: `app.getAppPath()` is the asar, where
      // `build.files` already carries `out/session-host/host.cjs`. In dev it is the repo root, so
      // the same candidate covers both.
      appPath: platform().appPath,
      // Dev-mode fallback, mirroring `findTmux`'s own `process.cwd()` use: under `electron-vite
      // dev` the cwd is the repo root, which is where `npm run host:build` writes its bundle.
      repoRoot: process.cwd()
    })
  }
  return client
}

/**
 * Is the session-host bundle actually present on this machine? False only in a dev checkout that
 * never ran `npm run host:build` (or `npm run build`, which runs it too) — unlike tmux, this
 * backend has no external binary to be "missing"; the only way it can be unavailable is an
 * incomplete build. `pty-manager.ts` combines this with "no local tmux was found" and the
 * `tmuxEnabled` setting to decide whether to actually select this backend for a given session.
 */
export function sessionHostSupported(): boolean {
  try {
    return getClient().bundleAvailable()
  } catch {
    // platform() throws before initPlatform() runs at boot — no real caller reaches this before
    // then, but fail closed (never select an unusable backend) rather than throw from a probe.
    return false
  }
}

/** Construct a (lazily-attaching) session-host-backed pty for `name`. Cast at the call site to
 *  `pty.IPty` — see `SessionHostPty`'s own doc comment for exactly what subset it implements. */
export function createSessionHostPty(
  name: string,
  spawn: SessionHostSpawnOptions,
  scrollback: number
): SessionHostPty {
  return new SessionHostPty(getClient(), name, spawn, scrollback)
}

/** Atomically attach to an already-running host session without resolving or transmitting any
 * spawn profile. If the session exits before this reaches the host, `ready` rejects and no shell
 * is created. This is the warm cross-process path used before profile/cwd resolution. */
export function attachExistingSessionHostPty(name: string): SessionHostPty {
  return new SessionHostPty(getClient(), name, null, 0)
}

/** Background write — works whether or not this process currently has a live client for `name`,
 *  exactly like `sendText`'s tmux `send-keys -t <name>` needs no attached client. */
export async function sessionHostSendKeys(name: string, text: string, enter: boolean): Promise<boolean> {
  return getClient().sendKeys(name, text, enter)
}

/** `#{pane_current_command}`'s equivalent — see `process-tree.ts`'s doc comment for the
 *  imprecision this carries versus tmux's real foreground-process-group tracking. */
export async function sessionHostPaneCommand(name: string): Promise<string | null> {
  return getClient().paneCommand(name)
}

/** `capture-pane` equivalent. `full`  mirrors `captureSession`'s own `full` parameter: false asks
 *  for the recent ~200 lines only (AI naming / palette search), true asks for everything the
 *  emulator is holding (bounded by `settings.tmuxScrollback`, exactly like tmux's own
 *  `history-limit`). Includes full SGR/mode restoration — see `TerminalEmulator.serialize`. */
export async function sessionHostCapture(name: string, full: boolean): Promise<string> {
  return getClient().capture(name, full)
}

/** Execute already-rendered trusted input through the persistent generation's exactly-once
 * launch ledger. The plan never crosses preload/renderer/relay boundaries. */
export async function sessionHostExecuteLaunch(
  name: string,
  launchId: string,
  plan: PreparedAgentLaunch
): Promise<ExecuteLaunchResult> {
  return getClient().executeLaunch(name, launchId, plan)
}

/** The one call that actually ENDS a session (as opposed to `SessionHostPty.kill()`, which only
 *  detaches). Mirrors `tmux kill-session -t <name>` exactly, and is called from the same place
 *  (`destroySession`'s final kill block). */
export async function sessionHostKillSession(
  name: string,
  options: {
    reserveReplacement?: boolean
    requireV2?: boolean
    expectedAbsent?: boolean
  } = {}
): Promise<void> {
  return getClient().killSession(name, options)
}

export { SessionHostProtocolCompatibilityError }

/** `tmux has-session`'s equivalent — currently unused by the create path (which gets `fresh`
 *  straight from the real attach-or-create round trip instead, via `SessionHostPty.ready`) but
 *  kept for parity/diagnostics and any future caller that wants a cheap existence check without
 *  actually attaching. */
export async function sessionHostHasSession(name: string): Promise<boolean> {
  return getClient().hasSession(name)
}

/** `tmux -L <socket> list-sessions`'s equivalent, for the same class of caller
 *  (`listNodetermSessions` — the relay host's session browser). */
export async function sessionHostListSessions(): Promise<string[]> {
  return getClient().listSessions()
}

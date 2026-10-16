import type { TextDeliveryResult } from '../shared/text-delivery'
// The thin facade `pty-manager.ts` talks to — owns the ONE process-wide `SessionHostClient` (one
// long-lived connection per app process, matching how `PtyManager` itself keeps one `tmuxPath`
// for the whole process) and exposes exactly the operations pty-manager's existing tmux/ssh call
// sites need a session-host equivalent for. Nothing here is tmux-specific or Electron-specific;
// see docs/windows-session-host.md for how each of these maps onto the underlying protocol.

import fs from 'fs'
import path from 'path'
import { platform } from './platform'
import {
  SessionHostClient,
  SessionHostProtocolCompatibilityError,
  SessionHostWatchUnsupportedError,
  type HostShutdownOutcome,
  type HostUpdateInspection,
  type SessionHostListing
} from './session-host-client'
import { SessionHostPty } from './session-host-pty'
import {
  ensureStagedHostRuntime,
  resolveHostStaging,
  stagedRuntimeRoot
} from './session-host-runtime'
import type {
  CaptureVisibleResult,
  ExecuteLaunchResult,
  SessionHostSpawnOptions
} from '../session-host/protocol'
import type { PreparedAgentLaunch } from './agent-launch'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'

export async function sessionHostMessageOwner(name: string): Promise<PaneOwner | null> {
  return getClient().messageOwner(name)
}

export async function sessionHostMessagePasteReady(name: string): Promise<boolean> {
  return getClient().messagePasteReady(name)
}

export async function sessionHostMessageEnvelope(
  name: string, envelope: string, expected: PaneOwner
): Promise<boolean> {
  return getClient().messageEnvelope(name, envelope, expected)
}

/** End the proven agent tree on a session-host pane (never the shell). See `terminateOwner`. */
export async function sessionHostTerminateOwner(
  name: string, expected: PaneOwner
): Promise<boolean | 'unsupported'> {
  return getClient().terminateOwner(name, expected)
}

/** Raw verbatim write into a released (unattached) session. False = not delivered or unknown. */
export async function sessionHostWriteDetached(name: string, data: string): Promise<boolean> {
  return getClient().writeDetached(name, data)
}

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
      repoRoot: process.cwd(),
      // Windows: run the host from a private copy of its runtime under %LOCALAPPDATA%, so the
      // installer can replace the install directory while sessions keep running (issue #829).
      // Packaged builds only — a dev checkout's host runs from the repo as before.
      stageRuntime:
        process.platform === 'win32' && platform().isPackaged
          ? (script) =>
              ensureStagedHostRuntime({
                platform: process.platform,
                execPath: process.execPath,
                resourcesPath: platform().resourcesPath,
                script,
                appVersion: platform().appVersion,
                localAppData: process.env.LOCALAPPDATA,
                // Into the host's own log, so a device report carries why a host ran from where.
                log: (line) => {
                  void fs.promises
                    .appendFile(
                      path.join(platform().userDataDir, 'session-host.log'),
                      `${new Date().toISOString()} [app] ${line}\n`
                    )
                    .catch(() => undefined)
                }
              })
          : undefined,
      // Prepare-for-update (U3): a host running from its staged copy does not block the
      // installer, so the dialog can offer a plain quit. Install dir = where this app's own
      // executable lives; a host older than the state file's `exe` falls back to a process query.
      hostStaging:
        process.platform === 'win32'
          ? (host) =>
              resolveHostStaging({
                exe: host.exe,
                pid: host.pid,
                installDir: path.dirname(process.execPath),
                stagedRoot: process.env.LOCALAPPDATA
                  ? stagedRuntimeRoot(process.env.LOCALAPPDATA)
                  : null
              })
          : undefined
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

/** A live link / relay viewer's READ-ONLY attachment to an already-running session: never spawns,
 * casts no size claim, takes no pause ticket, cannot type. `ready` rejects with
 * `SessionHostWatchUnsupportedError` when the running host predates the `watch-attach` feature. */
export function watchExistingSessionHostPty(name: string): SessionHostPty {
  return new SessionHostPty(getClient(), name, null, 0, 'watch')
}

/** Does the running host speak `watch-attach`? Connects to ask (only called where the session-host
 *  backend is already the selected one). */
export async function sessionHostSupportsWatch(): Promise<boolean> {
  return getClient().supportsFeature('watch-attach')
}

/** The same answer WITHOUT connecting — undefined while this process has no connection (nothing
 *  session-host-backed has been opened yet). Synchronous, for `tmuxStatus`. */
export function sessionHostWatchKnown(): boolean | undefined {
  return client?.connectedFeature('watch-attach')
}

/** A live link's keyframe: the visible screen, cursor and active buffer. Null = no capture (an
 *  older host, a gone session, any failure) — never history in its place. */
export async function sessionHostCaptureVisible(name: string): Promise<CaptureVisibleResult | null> {
  return getClient().captureVisible(name)
}

/** `#{pane_current_path}`'s equivalent: the cwd the pane last REPORTED (OSC 7 / 9;9 / 633), or null. */
export async function sessionHostPaneCwd(name: string): Promise<string | null> {
  return getClient().paneCwd(name)
}

/** Background write — works whether or not this process currently has a live client for `name`,
 *  exactly like `sendText`'s tmux `send-keys -t <name>` needs no attached client. */
export async function sessionHostSendKeys(name: string, text: string, enter: boolean): Promise<TextDeliveryResult> {
  return getClient().sendKeys(name, text, enter)
}

/** `#{pane_current_command}`'s equivalent — see `process-tree.ts`'s doc comment for the
 *  imprecision this carries versus tmux's real foreground-process-group tracking. */
export async function sessionHostPaneCommand(name: string): Promise<string | null> {
  return getClient().paneCommand(name)
}

/** `capture-pane` equivalent. `full`  mirrors `captureSession`'s own `full` parameter: false asks
 *  for the recent ~200 lines only (AI naming / palette search), true asks for everything the
 *  emulator is holding (bounded by `xtermScrollback(settings.tmuxScrollback)` — at most 10k
 *  lines, the renderer's own cap, NOT tmux's `history-limit`; see shared/scrollback). Includes full SGR/mode restoration — see `TerminalEmulator.serialize`. */
export async function sessionHostCapture(name: string, full: boolean): Promise<string> {
  return getClient().capture(name, full)
}

/** The pane app's mouse-tracking protocol (`paneModesV1`), null = unknown / older host. */
export async function sessionHostMouseTracking(
  name: string
): Promise<'none' | 'x10' | 'vt200' | 'drag' | 'any' | null> {
  return getClient().mouseTrackingMode(name)
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
    expectedGeneration?: string
  } = {}
): Promise<void> {
  return getClient().killSession(name, options)
}

export { SessionHostProtocolCompatibilityError, SessionHostWatchUnsupportedError }
export type { SessionHostListing }

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

/** The observability read — pid, subscribers, output clock and generation per session — for the
 *  session reaper, the session-memory panel and dev-server ports. Never launches a host; `null` is
 *  a FAILED read, never "no sessions" (see `SessionHostListing`). */
export async function sessionHostListSessionsDetailed(): Promise<SessionHostListing | null> {
  return getClient().listSessionsDetailed()
}

/** Prepare-for-update (issue #829): what the running host holds, without ever launching one. */
export async function sessionHostInspectForUpdate(): Promise<HostUpdateInspection> {
  return getClient().inspectForUpdate()
}

/** Prepare-for-update (issue #829): ask the running host to end every session and exit. */
export async function sessionHostShutdownForUpdate(): Promise<HostShutdownOutcome> {
  return getClient().shutdownForUpdate()
}

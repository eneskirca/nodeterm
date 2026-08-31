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
  type PtyRecycleTarget,
  type Settings,
  type TmuxStatus
} from '../shared/types'
import { bundledTmuxPath, findCommand, findFixedTmux, tmuxInstall } from './tmux-hint'
import { hookServer, PERM_WAIT_SECS_DEFAULT } from './agents/hook-server'
import {
  probeSaysAbsent,
  remoteHookEnvArgs,
  remoteTmuxHasSessionArgs,
  remoteTmuxKillArgs,
  localKillSockets,
  localTmuxKillArgs,
  remoteTmuxPtyArgs,
  type RemoteSessionEnv,
  remotePasteDelivery,
  remoteCapturePaneArgs,
  remotePaneCommandArgs,
  remotePaneOwnerCombinedArgs,
  remotePaneProcessArgs,
  remoteTerminateForegroundArgs,
  remotePaneCursorArgs
} from './remote-ssh/control-master'
import { probeAgentSockToPin } from './remote-ssh/agent-probe'
import { parsePaneCursor } from './pane-cursor'
import { classifyPaneCwd } from './pane-cwd'
import {
  recordFreshSpawnOwner,
  forgetPaneOwner,
  shouldRecordOwnership
} from './agents/pane-ownership'
import { PANE_OWNER_FMT, foregroundArgvArgs, paneOwnerFrom, parseCombinedPaneOwner, parsePaneOwner } from './agents/pane-owner'
import { binariesFor, isAgentPane, type PaneOwner } from '../shared/agents/pane-owner-predicate'
import { readSpawnResources, spawnResourceNote } from './spawn-resources'
import {
  primePtyCeiling,
  ptyDevicesExhausted,
  readPtyDevices,
  spawnFailureHint,
  type PtyDevices
} from './pty-devices'
import { REAP_SWEEP_MS, shouldReap } from './pty-reap'
import { ControlModeClient, type ControlSpawn } from './tmux-control-client'
import {
  TMUX_SOCKET,
  sessionName,
  isSessionName,
  localPasteDelivery,
  runPasteDelivery
} from './tmux-naming'
import { encodeSendKeysHex } from './tmux-control'
import { releasePty, type ReleasablePty } from './pty-release'
import { terminateWindowsProcessTree } from '../session-host/windows-process-tree'
import { effectiveSize, type PtySize } from './pty-size'
import { machOArch, archMismatch } from './macho-arch'
import { writeScrollback, readScrollback, deleteScrollback } from './scrollback-store'
import { claudeConfigDirFor } from './claude-config-dir'
import { findExecutableSync, findInPathString, resolveShellPath, shellPathNow } from './exec-path'
import {
  AUTH_ENV_STRIP,
  accountTmuxEnvArgs,
  isReservedSpawnEnvKey,
  remoteAccountConfigDirAbs
} from './claude-accounts-core'
import {
  AUTH_ENV_STRIP as CODEX_AUTH_ENV_STRIP,
  codexSessionEnv,
  isCodexScopeRefusal,
  needsCodexAccountScope,
  resolveCodexSessionScope
} from './codex-accounts-core'
import { NODE_ID_MAX, isSafeNodeId } from './remote-safety'
import { presenceHub } from './presence/hub'
import {
  codexLauncherDir,
  forgetCodexThreadIdentitiesForNode,
  installCodexLauncher
} from './codex-identity-proxy'
import { ensureNodeToken, ensureRemoteNodeToken, sweepNodeToken } from './agents/node-token-service'
import { clearNode as clearNodeAgentStatus } from './agent-status-mirror'
import { hasPermissionMode, hasSharedIdentity, setCustomAgentBaseResolver, type AgentId } from '../shared/agents/config'
import { findCustomAgent } from '../shared/agents/custom-agent'
import { applyCustomAgentEnv, customAgentEnvArgs } from './custom-agent-env'
import {
  MODEL_GATEWAY_ENV_KEYS,
  modelGatewayEnv,
  tmuxUpdateEnvironmentLine
} from '../shared/agents/model-gateway'
import { leadPaneHookLines } from '../shared/tmux-lead-pane'
import {
  remoteSessionEnvAvailable,
  remoteSessionEnvPath,
  sessionEnvFileContent,
  stageRemoteSessionEnv
} from './remote-ssh/session-env'
import { foregroundProcessGroup, parsePaneProcess } from './pane-process'
import { isShellCommand } from '../shared/agents/pane'
// Third persistence backend, selected when no local tmux was found (primarily Windows, where
// tmux does not exist at all) — see docs/windows-session-host.md. Deliberately a thin, separate
// module rather than inline here: this is the one narrow seam this file needed to grow for a
// whole standalone process + protocol living under src/session-host/.
import {
  attachExistingSessionHostPty,
  createSessionHostPty,
  sessionHostCapture,
  sessionHostHasSession,
  sessionHostKillSession,
  sessionHostListSessions,
  sessionHostPaneCommand,
  sessionHostSendKeys,
  sessionHostSupported,
  SessionHostProtocolCompatibilityError
} from './session-host-backend'
import type { SessionHostPty } from './session-host-pty'
import type { ProjectSpawnOverrides, ProjectSpawnOverridesReader } from './project-spawn-overrides'

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
 * How long a spawn may wait on the project's settings before it goes ahead WITHOUT them.
 *
 * The reader is cheap on the local leg (an in-process store read), but the SSH leg's
 * `readProjectSettings` reconciles the host's `settings.json` over the ControlMaster — the same
 * half-dead-socket hazard that wedged `pty:create` once already (see PROC_TIMEOUT_MS). A terminal
 * must never hang on a settings read, and the failure direction is the same one everything else
 * here takes: no overrides, spawn anyway.
 */
const PROJECT_OVERRIDES_TIMEOUT_MS = 2_000

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

/** Narrow child-process seam for strict tmux probes/confirmed teardown. Production delegates to
 * the same bounded runner above; focused tests inject a stateful fake so hidden dual-backend
 * generations can be proven ended without source-scanning or platform-specific helper scripts. */
type ConfirmedProcessRun = (
  file: string,
  args: readonly string[],
  opts?: object
) => Promise<unknown>

/**
 * `runAsync`, with a payload written to the child's STDIN.
 *
 * The delivery path (`sendText`) puts the text in `tmux load-buffer -`'s stdin rather than in an
 * argument — no payload on a command line, and no MAX_ARG_STRLEN ceiling (measured: 300 KB in one
 * argument is "Argument list too long"; the same over stdin lands intact).
 *
 * `execFile`'s promise carries the ChildProcess as `.child`, so this stays inside the one bounded
 * wrapper every other side-call uses instead of hand-rolling a spawn: same `PROC_TIMEOUT_MS`, same
 * rejection on a non-zero exit. An EPIPE on the write (the child died before reading) is swallowed
 * here on purpose — the process result is the authority, and an unhandled 'error' on the stream
 * would take the main process down instead of failing this one call.
 */
function runWithStdin(file: string, args: readonly string[], input: string): Promise<unknown> {
  const p = execFileAsync(file, args as string[], { timeout: PROC_TIMEOUT_MS } as never)
  const child = (p as unknown as { child: import('child_process').ChildProcess }).child
  const stdin = child.stdin
  if (stdin) {
    stdin.on('error', () => {
      /* child gone; the exit code below is what decides success */
    })
    stdin.end(input)
  }
  return p as unknown as Promise<unknown>
}

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
/**
 * Session-identity env names the LOCAL conf's `update-environment` carries on top of the stock +
 * gateway list (issue #419). The point is the REMOVAL half of update-environment's contract: the
 * shared tmux server inherits the env of whichever client STARTS it, so a server started by a
 * managed-account node's client held that account's `CLAUDE_CONFIG_DIR` in its GLOBAL env — and
 * every later session created withOUT a `-e` override (system-account nodes, plain terminals, and
 * the missing-dir fallback) inherited it and silently ran as that account ("the system account is
 * entangled with the next account in the list"). With the names listed, tmux copies each one from
 * the creating CLIENT's env — set for the node that owns it, and STRIPPED from the session when
 * the client lacks it (measured in session-env.realtmux.test.ts, seeded-server case included).
 * The auth-strip names ride along for the same reason: deleting them from the client env alone
 * never touched a seeded server's global copy, so a managed-OAuth node could still run on an
 * inherited API key. LOCAL conf only — see `tmuxUpdateEnvironmentLine` for why the remote conf
 * must not get these.
 */
export const ACCOUNT_SCOPE_UPDATE_ENV: readonly string[] = [
  'CLAUDE_CONFIG_DIR',
  ...AUTH_ENV_STRIP,
  'CODEX_HOME',
  'NODETERM_CODEX_ACCOUNT_ID',
  ...CODEX_AUTH_ENV_STRIP
]

// LEAD-PANE WIDTH (issue #119): `leadPaneWidth` (settings.tmuxLeadPaneWidth) is OPT-IN and 0 by
// default — `leadPaneHookLines` returns '' then, so the default conf is byte-identical to the
// pre-feature output (pinned in tmux-conf.test.ts). See shared/tmux-lead-pane.ts for the story.
export function tmuxConf(scrollback: number, leadPaneWidth: number = 0): string {
  return `# auto-generated by node-terminal — do not edit
set -g status off
set -g mouse on
set -g history-limit ${Math.max(1000, scrollback)}
set -g default-terminal "xterm-256color"
set -sg escape-time 10
set -g destroy-unattached off
setw -g aggressive-resize on
# Credentials travel HERE, not on argv: gateway env vars ride the tmux client's process
# environment and update-environment copies them into the session at create/attach. The old
# '-e KEY=VALUE' route parked the API key on the long-lived attached client's command line —
# world-readable in /proc/<pid>/cmdline on any multi-user host (the PR #195 leak class).
# The account-scope names (CLAUDE_CONFIG_DIR et al.) are listed for their REMOVAL semantics:
# a client that lacks one strips it from the session, so a server whose global env was seeded
# by a managed-account client can no longer leak that account into unbound sessions (#419).
${tmuxUpdateEnvironmentLine(ACCOUNT_SCOPE_UPDATE_ENV)}
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
# Truecolor passthrough: tmux clamps 24-bit SGR to the 256 palette unless the OUTER terminal is
# known to speak RGB. xterm.js does, so declare it — via terminal-features like the clipboard
# entry above, never terminal-overrides (see the MIGRATION note). Issue #78.
set -as terminal-features ",*:RGB"
# OSC 8 hyperlink passthrough — tmux strips the escape unless the outer terminal declares it.
set -as terminal-features ",*:hyperlinks"
# Mouse copy: on release tmux copies to its buffer AND (thanks to the two lines above) emits OSC 52,
# which the client writes to the system clipboard. No pipe-to-a-local-command here, deliberately.
bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel
bind -T copy-mode    DoubleClick1Pane send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi DoubleClick1Pane send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode    TripleClick1Pane send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi TripleClick1Pane send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel
${leadPaneHookLines(leadPaneWidth)}`
}

/**
 * Resolve an absolute tmux path (GUI apps don't inherit the shell PATH). Subprocess-free: the old
 * fallback here was a SYNC login-shell `command -v tmux` — sourcing the profile (nvm/conda:
 * 100-800ms) on the main thread, re-triggered every 3s by the tmux-missing banner's install poll,
 * freezing all windows and IPC each time. Now it walks a fixed candidate list
 * (`tmuxCandidatePaths` — Homebrew, MacPorts, Nix, Linuxbrew, the distro paths), then the
 * cached login-shell PATH, and only THEN the tmux the macOS app bundles.
 *
 * THE BUNDLED COPY IS DELIBERATELY LAST. A tmux client attaches to a tmux SERVER that outlives the
 * app and was started by whatever tmux the user has installed; preferring our binary could pair a
 * new client with their old running server, which upstream refuses ("server version is too old").
 * System-first means every user who already has tmux sees zero change, and the bundle only rescues
 * the population that had none — where there is no server to be incompatible with. See
 * `bundledTmuxPath` in tmux-hint.ts and scripts/build-tmux.mjs.
 *
 * BEFORE THAT ASYNC PATH PROBE SETTLES, a tmux living ONLY on the user's shell PATH is still
 * invisible, and a session spawned in that window silently becomes a plain shell with no
 * persistence — the window this candidate list narrows, and the reason issue #126 could bite a
 * machine that has tmux installed. Two things close it after the fact: init()'s post-probe
 * `ensureTmux()` re-run and `tmuxStatus()`'s re-probe, both of which upgrade NEW sessions without
 * a restart. A session already spawned plain is NOT migrated (there is no way to move a running
 * process into a tmux pane); its recovery is the node's own Refresh/respawn, which re-creates it
 * through the now-resolved tmux.
 */
function findTmux(resourcesPath?: string): string | null {
  // Windows has none of `tmuxCandidatePaths`' targets (Homebrew, MacPorts, Nix, the distro
  // `/usr/bin` family — all POSIX filesystem layouts) and no bundled tmux (macOS-only, see
  // `bundledTmuxPath`'s doc comment; `scripts/build-tmux.mjs` never runs for a Windows package).
  // Walking either list would just be `existsSync` calls against paths that can never resolve on
  // this platform — skip straight to the PATH probe, the one route that can find a real tmux a
  // Windows user installed themselves (WSL's own tmux is a different filesystem entirely and is
  // never on the Windows PATH; MSYS2/Cygwin tmux, if the user put it there, is).
  if (os.platform() === 'win32') {
    return findInPathString('tmux', shellPathNow() ?? process.env.PATH)
  }
  // BOTH lookups inside the guard: `os.homedir()` throws the same SystemError as `userInfo()` when
  // there is no passwd entry and no $HOME (some containers), and a thrown probe here would take
  // out tmux discovery entirely — degrading a machine that HAS tmux to the plain-shell fallback,
  // which is the failure this whole function is being hardened against. Unknown home/user simply
  // drops the candidates derived from them.
  let home: string | null = null
  let user: string | null = null
  try {
    home = os.homedir()
    user = os.userInfo().username
  } catch {
    // no home / no passwd entry — the fixed system paths below are still checked
  }
  const fixed = findFixedTmux((p) => fs.existsSync(p), home, user)
  if (fixed) return fixed
  const onPath = findInPathString('tmux', shellPathNow() ?? process.env.PATH)
  if (onPath) return onPath
  // Last: the binary the macOS app ships. `process.cwd()` is the repo root under
  // `electron-vite dev`, which is where scripts/build-tmux.mjs writes its artifact; in a packaged
  // app it is meaningless and simply misses.
  return bundledTmuxPath({
    resourcesPath,
    repoRoot: process.cwd(),
    exists: (p) => fs.existsSync(p)
  })
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

/** Windows PowerShell always ships at this exact path (part of the OS since Vista) — the one
 *  fallback that is always available, even when the PATH probe misses it. */
const WIN_POWERSHELL_FALLBACK = (): string =>
  `${process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** PowerShell 7+'s default per-machine install location — a fallback for the case where the
 *  installer's PATH update hasn't reached this (GUI-launched) process's inherited environment. */
const WIN_PWSH_FALLBACK = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

/**
 * The Windows session program when nothing else picked one (no explicit program, no
 * `settings.defaultShell`): prefer PowerShell 7+ (`pwsh.exe` — the shell most developers actually
 * want once they've installed it), then the Windows PowerShell every machine ships
 * (`powershell.exe`), then whatever the environment itself calls its command processor
 * (`COMSPEC` — normally `cmd.exe`, but respecting it rather than hardcoding keeps this correct on
 * an environment that deliberately points it elsewhere), and only then a bare `cmd.exe` — the one
 * binary guaranteed to exist on every Windows install, so this function can never return nothing.
 */
function resolveWindowsShell(): string {
  const pathStr = shellPathNow() ?? process.env.PATH
  const pwsh = findInPathString('pwsh', pathStr) ?? (fs.existsSync(WIN_PWSH_FALLBACK) ? WIN_PWSH_FALLBACK : null)
  if (pwsh) return pwsh
  const winPsFallback = WIN_POWERSHELL_FALLBACK()
  const powershell = findInPathString('powershell', pathStr) ?? (fs.existsSync(winPsFallback) ? winPsFallback : null)
  if (powershell) return powershell
  return process.env.COMSPEC || 'cmd.exe'
}

/**
 * One legacy local-shell resolver for BOTH direct node-pty and the persistent session-host
 * backend. Windows desktop profile launches bypass this helper with a trusted resolved plan, but
 * Server Edition and older callers without the optional profile service keep the same fallback.
 * Keeping the fallback here prevents the two paths from drifting: the session host previously
 * hardcoded `bash` even on Windows, while the direct path already knew how to find PowerShell or
 * COMSPEC. Injectable platform leaves make that compatibility behavior testable on every CI host.
 */
export function resolveLocalSessionShell(
  program: string | undefined,
  defaultShell: string | undefined,
  deps: {
    platform?: NodeJS.Platform
    windowsShell?: () => string
    posixShell?: string
  } = {}
): string {
  if (program) return program
  if (defaultShell) return defaultShell
  if ((deps.platform ?? os.platform()) === 'win32') {
    return (deps.windowsShell ?? resolveWindowsShell)()
  }
  const posixShell = deps.posixShell !== undefined ? deps.posixShell : process.env.SHELL
  return posixShell || 'bash'
}

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
  /** A tmux session (local `nt-<id>`, or the remote one an SSH project attaches to) is holding this
   *  session's work, so the pty client here is expendable: detaching it loses nothing and the next
   *  create re-attaches with `new-session -A`. It is the precondition for the idle reap — see
   *  pty-reap.ts — and it is exactly the condition `persisted` is computed from at spawn. */
  tmuxBacked: boolean
  /** When the reap sweep first saw this session with nobody attached (no live subscriber, no relay
   *  sink); `null` while somebody is. See `reapTick`. */
  unwatchedSince: number | null
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
  /**
   * This session is backed by the session-host process (docs/windows-session-host.md), not a
   * local tmux — selected only when no local tmux was found (primarily Windows). `session.proc`
   * is then a `SessionHostPty`, not a real node-pty `IPty` (see `createSessionHostPty`). Every
   * call site that reaches past `session.proc` to run a tmux CLI command directly (`sendText`,
   * `paneCommand`, `captureSession`, `captureSnapshot`, `snapshotScrollback`,
   * `captureForResync`, the final kill in `destroySession`) branches on this the same way it
   * already branches on `sshRemote`.
   */
  sessionHost?: boolean
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

/** A non-Windows plain PTY has no taskkill-style process-absence proof, so confirmed recycle waits
 * for this exact generation's exit event. Bound that wait: a broken native binding must reject the
 * restart rather than leave its awaited IPC (and the renderer's destructive-action UI) hanging
 * forever. Windows uses `terminateWindowsProcessTree` as the stronger absence proof when a valid
 * PID is available. */
export const CONFIRMED_PLAIN_EXIT_TIMEOUT_MS = 5_000

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
 * How long a command issued to a SHADOW may go unanswered before that shadow is torn down.
 *
 * `ControlModeClient` has no timers of its own, deliberately (tmux-control-client.ts): it pairs
 * replies with commands POSITIONALLY, so a reply that never arrives does not merely stall one
 * caller — every later reply pairs with the wrong command, permanently, and there is no recovery
 * short of a new client. That is why the timeout disposes rather than retries.
 *
 * Five seconds is orders of magnitude past what it bounds: the only command a shadow issues today
 * is a local `refresh-client -C` over a pipe to a tmux server on this machine (sub-millisecond).
 * Hitting it means the server is wedged or the pipe is dead, not that it is busy.
 */
export const SHADOW_CMD_TIMEOUT_MS = 5_000

/**
 * How long the SHARED background-write control client stays attached after the last background
 * write (see `backgroundWrite`).
 *
 * It exists so a BURST — an agent pushing a multi-line prompt, a run of slash commands — costs one
 * `tmux -C` child instead of one per keystroke batch, and nothing more. Ten seconds is past any
 * plausible gap inside one such burst and far short of every lifecycle it must not interfere with:
 * the renderer's 5-minute park (`TERM_PARK_MS`), the 10-minute offscreen dispose
 * (`offscreen-policy.ts`) and the 10-minute idle reap (`REAP_IDLE_MS`). That ordering is the point
 * of picking a number this small: an idle client is a real tmux client on some session, and the
 * shorter it lives the smaller the window in which anything has to reason about it at all.
 */
export const BACKGROUND_WRITE_LINGER_MS = 10_000

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
  /** sessionId → exact generation whose persistent backend is being ended by the awaited profile
   * switch path. A backend can emit exit before its kill response arrives; callbacks for this
   * generation are deferred so no local state changes before acknowledgement. */
  private confirmedBackendEnds = new Map<
    string,
    { session: Session; exitCode?: number; resolveExit?: () => void }
  >()
  /** One awaited profile-switch teardown per node. Without this guard two invocations can both
   * install an exit barrier for the same generation and the second can report success after the
   * first already removed the backend. */
  private confirmedRecycles = new Map<string, Promise<void>>()
  /** One in-flight end per node. Creates wait behind this barrier so a session-host exit that
   *  arrives before its kill response cannot be mistaken for permission to respawn the node. */
  private ending = new Map<
    string,
    {
      intent: EndIntent
      everySocket: boolean
      backendAlreadyEnded: boolean
      replacementTarget: PtyRecycleTarget | undefined
      promise: Promise<void>
    }
  >()
  /** A session-host kill request failed after dispatch, so absence is not proven. Keep creates
   * fenced until an idempotent retry acknowledges the end; an exit event alone is not that proof. */
  private unknownEnds = new Set<string>()
  /** Shell-owned cleanup runs after end processing and, for session host, its kill acknowledgement. */
  private sessionEndedListeners = new Set<(persistKey: string) => void>()
  /** persistKey (node id) → the co-viewers of a session that was RECYCLED (moved into a worktree),
   *  waiting to be told to restart onto the replacement session. Held — not sent — until that
   *  session is registered (`spawnSession`), so a co-viewer's restart can never win the race and
   *  spawn the node in its own stale cwd. See `recycleSession`. */
  private pendingRecycle = new Map<
    string,
    {
      sessionId: string
      clients: Set<ClientId>
      /** The exact view allowed to cold-create the replacement. A Kanban modal shares its
       * renderer's ClientId, but it is still a co-viewer: letting it win would return `fresh:true`
       * to a surface that deliberately performs no cold agent relaunch, while the primary canvas
       * view subsequently joins `fresh:false`. */
      owner: SubKey | null
      /** Trusted target preflighted by confirmed recycle. The primary view is still parked if it
       * races back with stale React props; only a create carrying this exact profile/cwd may spend
       * the replacement reservation and establish the new generation. */
      target?: PtyRecycleTarget
      waiters: Array<{
        clientId: ClientId
        options: PtyCreateOptions
        resolve: (result: PtyCreateResult) => void
        reject: (error: unknown) => void
      }>
      timer: ReturnType<typeof setTimeout>
    }
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

  /**
   * Is this account id one of the managed CODEX accounts? Asked instead of guessing from the id's
   * shape: `codexAccounts` and `claudeAccounts` share an id alphabet, so only the list can tell
   * them apart (issue #345). Reads LIVE settings, so an account added after init is seen.
   */
  private isCodexAccount(accountId: string): boolean {
    return this.getSettings().codexAccounts.some((a) => a.id === accountId)
  }
  /** Literal model-gateway key loaded by the shell's secret service during startup. */
  private getModelGatewaySecret: () => string | null = () => null
  /**
   * What the OWNING project contributes to a session's env + shell, or null when it contributes
   * nothing. Injected (not constructed) for the same reason `getSettings` is: core cannot see the
   * workspace store or the trust store, and both shells wire the SAME core factory
   * (`makeProjectSpawnOverrides`). Unset ⇒ the feature is simply absent — every spawn behaves
   * exactly as it did before it existed.
   */
  private readProjectSpawnOverrides: ProjectSpawnOverridesReader | null = null
  /** ONE shared snapshot interval for all persisted sessions — a per-session interval spawned
   *  one tmux/ssh capture subprocess per session per tick, forever, even for idle terminals. */
  private snapshotTimer: ReturnType<typeof setInterval> | null = null
  /** ONE shared sweep for the idle reap (see `reapTick` / pty-reap.ts), armed by the first
   *  tmux-backed session and cleared once no session is left. */
  private reapTimer: ReturnType<typeof setInterval> | null = null
  /**
   * persistKey (node id) → the control-mode SHADOW attached to that node's tmux session.
   *
   * Keyed by persistKey rather than held on `Session`, because the nodes a shadow exists for are
   * exactly the ones that HAVE no `Session`: `releaseClient` → `forget` drops the entry from
   * `sessions` and `byPersistKey` the moment the pty client is released, and what survives is the
   * tmux session — which is the thing a shadow attaches to.
   *
   * This map IS the invariant. An entry here means no painter pty client of ours is attached for
   * that node: `shadowAttach` refuses while one is, and `spawnSession` disposes the entry before
   * spawning one. Nothing else may put a client in here.
   */
  private shadows = new Map<string, ControlModeClient>()
  /**
   * persistKey (node id) → what a shadow needs to know about a session whose pty client this
   * manager has RELEASED. Written by `releaseClient`, because `forget` then drops the `Session` and
   * with it the only other record of any of these facts:
   *  - `sessionId`: the id that session answered to. A caller can still be holding it — the relay
   *    host keeps one per stream — and `write()` resolves it back to this node instead of dropping
   *    the bytes, which is the only route a released session has left to an existing write path.
   *  - `size`: the effective grid the painter last enforced. With only a control client attached
   *    the pane follows `refresh-client -C <cols>x<rows>`, so this is what a shadow re-asserts.
   *  - `remote`: this node's tmux ran on a REMOTE host (an SSH project) — over that project's
   *    ControlMaster, on the `nodeterm-rmt` socket THERE. Our local socket holds no session for it;
   *    at best nothing, at worst the local orphan a create issued with the master down once left
   *    under the same name. Never shadow it locally.
   *
   * It deliberately outlives the `Session` (the tmux session outlives it too) and is dropped when
   * the node is destroyed. The write is unconditional for every PERSISTED session released — local
   * tmux-backed and remote alike, with or without a recorded size — so the map also holds records
   * whose only content is "remote, do not shadow". Growth is therefore one small record per
   * persisted node this process has ever released: the same order as the session map itself, and
   * rewritten rather than appended on every subsequent release of the same node.
   */
  private released = new Map<string, { sessionId: string; size?: PtySize; remote: boolean }>()
  /**
   * The ONE control-mode client this manager keeps for background WRITES, plus the node whose tmux
   * session it is attached to (see `backgroundWrite` / `sharedClientFor`).
   *
   * Shared rather than per-session because control-mode COMMANDS are server-wide: `send-keys -t X`
   * reaches every session on the socket from whatever session the client happens to be attached to.
   * Only `%output` streaming is scoped to the attachment, and this client streams nothing.
   *
   * `persistKey` is kept because the attachment is the one thing about it that is NOT server-wide:
   * it makes this a real tmux client of THAT session, so it has to be subtracted from the session
   * budget (`shadowedTmuxSessions`) and retired whenever something else wants to be that session's
   * only client of ours — a painter spawning, or a per-session shadow attaching.
   */
  private shared: { client: ControlModeClient; persistKey: string } | null = null
  /** Disposes `shared` once no background write has needed it for `BACKGROUND_WRITE_LINGER_MS`. */
  private sharedLinger: ReturnType<typeof setTimeout> | null = null
  /** The child-process seam for shadow clients. Undefined in production, where `ControlModeClient`
   *  uses `child_process` (see tmux-control-client.ts); tests inject a fake spawner. */
  private readonly controlSpawn: ControlSpawn | undefined
  private readonly confirmedProcessRun: ConfirmedProcessRun
  /** Injectable only so Windows-only routing stays behavior-testable on every CI host. */
  private readonly runtimePlatform: NodeJS.Platform

  constructor(
    deps: {
      controlSpawn?: ControlSpawn
      confirmedProcessRun?: ConfirmedProcessRun
      runtimePlatform?: NodeJS.Platform
    } = {}
  ) {
    this.controlSpawn = deps.controlSpawn
    this.confirmedProcessRun = deps.confirmedProcessRun ?? runAsync
    this.runtimePlatform = deps.runtimePlatform ?? os.platform()
  }

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
      void this.snapshotScrollback(session.persistKey, session.sshRemote, !!session.sessionHost).then((ok) => {
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

  private ensureReapTimer(): void {
    if (this.reapTimer) return
    this.reapTimer = setInterval(() => this.reapTick(), REAP_SWEEP_MS)
    // Node keeps the process alive for a pending interval, and this one would otherwise outlive the
    // work it sweeps (the snapshot timer clears itself the same way, in its own tick).
    this.reapTimer.unref?.()
  }

  /**
   * Release the client pty of every tmux-backed session nobody has been attached to for
   * `REAP_IDLE_MS` — the safety net under the normal release paths. The tmux session, its processes
   * and its scrollback are untouched: this is the SAME detach the last subscriber's departure does,
   * and the next `pty:create` re-attaches to it. Read pty-reap.ts before changing any of it.
   *
   * "Attached" is decided against `platform().clientIds()`, not against the subscriber set: the
   * whole point is the subscriber whose window/tab/peer is GONE and which therefore can never send
   * the `pty:kill` that would release the pty. A client id is never reused (Electron webContents
   * ids and the server's `nextUiId` both only go up), so a client that comes back comes back as a
   * new id and creates its sessions afresh — there is no returning client to strand.
   */
  private reapTick(): void {
    const live = new Set(platform().clientIds())
    const now = Date.now()
    for (const [sessionId, session] of [...this.sessions]) {
      // A relay sink is a watcher (somebody's phone is mirroring this session); a parked terminal
      // is still a subscriber, and its client is still attached.
      const watched =
        !!session.onData || [...session.subscribers].some((sub) => live.has(subClient(sub)))
      if (watched) session.unwatchedSince = null
      else session.unwatchedSince ??= now
      const reap = shouldReap(
        { tmuxBacked: session.tmuxBacked, watched, unwatchedSince: session.unwatchedSince },
        now
      )
      if (reap) this.releaseClient(sessionId, session)
    }
    if (this.sessions.size === 0 && this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
  }

  /**
   * Detach this process's pty CLIENT from a session and forget it: the final scrollback snapshot,
   * `releasePty` (never a bare `proc.kill()` — a paused pty never reads EOF, so kill alone leaks
   * the master fd; see pty-release.ts), and the index cleanup. Shared by the last subscriber's
   * departure and the idle reap, which differ only in what made the session unwatched. A tmux
   * session is NOT killed here, in either case — that is `destroySession`.
   */
  private releaseClient(sessionId: string, session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer)
    // Final snapshot on detach (node unmount / app quit) so the very latest scrollback survives
    // a reboot. The tmux session itself keeps running, so this only races a same-instant capture.
    // Skipped when nothing arrived since the last periodic capture (pane content is unchanged).
    if (session.persistKey && session.outputSinceSnapshot)
      void this.snapshotScrollback(session.persistKey, session.sshRemote, !!session.sessionHost)
    // Remember what a later shadow would have no other way to learn — the grid the painter last
    // enforced (so the pane is not left to reflow), and whether this node's tmux was REMOTE (so it
    // is never shadowed against our local socket). The `Session` holding both goes with `forget`
    // below; this is the record that survives it.
    if (session.persistKey)
      this.released.set(session.persistKey, {
        sessionId,
        size: session.appliedSize,
        remote: !!session.sshRemote
      })
    releasePty(session.proc as ReleasablePty)
    this.forget(sessionId, session)
  }

  /**
   * Attach a control-mode SHADOW to the tmux session of a node whose painter pty client has been
   * released — `tmux -C attach-session` over plain pipes, holding ZERO pty devices — so a
   * background feature can reach a session nobody is watching without respawning the terminal (a
   * pty device, a tmux client, an ssh child, and a full redraw the user never asked for).
   *
   * Attach-or-reuse; returns the live client, or null when there is nothing to shadow or nothing to
   * shadow it with:
   *  - tmux is unavailable or switched off: there is no tmux session to attach to, and a non-tmux
   *    session's work lives in the pty client that is already gone.
   *  - `ptyShadowClients` is off: the kill switch (see the setting's doc). This is ONE of the two
   *    places it is read — the other is `backgroundWrite` — because these are the only two entry
   *    points that can start a control client of ours.
   *  - a PAINTER pty client is still attached for this node. A session never has both: the painter
   *    attaches with `-D` (it would kick the shadow off a moment later anyway), and two clients of
   *    ours on one pane would hand tmux the size negotiation that pty-size.ts exists to keep.
   *  - the node is REMOTE (an SSH project): its tmux runs on the far host, not on our socket.
   *  - the control client could not be spawned, or was torn down while its opening size push was
   *    outstanding (see `shadowCommand`). This method never rejects; failure is always null.
   *
   * WHAT A SHADOW IS NOT: not a subscriber, not a `Session`, not a renderer client id. Nothing in
   * this process that decides "is somebody watching" can see it — the reap sweep asks
   * `platform().clientIds()` and walks `this.sessions`, and the renderer's park and offscreen
   * dispose are per-node renderer state.
   *
   * It IS a real tmux client, so anything that asks TMUX "is this session attached" does see it,
   * and must subtract it. There is one such consumer: the session budget (session-budget.ts) culls
   * idle DETACHED sessions under memory pressure, and it takes `shadowedTmuxSessions` for exactly
   * this reason. Any future `list-clients`/`session_attached` reader owes the same subtraction.
   */
  async shadowAttach(persistKey: string): Promise<ControlModeClient | null> {
    // Both halves of "is there a tmux session at all": the binary, and the setting that decides
    // whether sessions are spawned under it. With tmux switched OFF, `tmuxPath` is still set (the
    // binary is installed) but every session is a plain shell — so a shadow would attach to a name
    // nothing ever created and die on arrival, and its caller would read that as "reached it".
    const settings = this.getSettings()
    if (!this.tmuxPath || !settings.tmuxEnabled) return null
    // The kill switch, read here rather than at each of the three places a shadow is USED: a caller
    // that cannot get a client cannot use one, and a flag scattered over the tier guards would be a
    // flag with three chances to be forgotten.
    if (!settings.ptyShadowClients) return null
    const live = this.shadows.get(persistKey)
    if (live?.alive) return live
    // Died since it was attached (its `onExit` normally clears the entry; this covers a caller that
    // gets here first). Re-attaching is LAZY on purpose: nothing re-shadows a session nobody asked
    // about, so a node that is never wanted again costs nothing.
    if (live) this.shadows.delete(persistKey)
    if (this.sessionByPersistKey(persistKey)) return null
    const known = this.released.get(persistKey)
    // A remote (SSH-project) node's tmux server is on the FAR host, reached over that project's
    // ControlMaster on the `nodeterm-rmt` socket. A local `-C attach -t nt-<id>` here would find
    // nothing — or, if a create once ran with the master down, the LOCAL orphan wearing this node's
    // name, which is a different machine's idea of the node and must never be typed into. Routing
    // control mode over ssh is a separate job; refusing is the honest answer until it exists.
    if (known?.remote) return null
    // At most ONE client of ours per tmux session. The shared background-write client may already
    // be attached to this one (it attaches to whatever session first needed a background write);
    // it is the one that yields, because it can be re-started against any session and a shadow
    // cannot. Two of ours here would also break the session budget's "subtract one client per
    // shadowed name" arithmetic, which has no way to know it should subtract two.
    this.sharedDisposeOn(persistKey)
    const client = new ControlModeClient({
      tmuxBin: this.tmuxPath,
      socket: TMUX_SOCKET,
      sessionName: sessionName(persistKey),
      // Nothing consumes a shadowed session's output yet (the first consumer, Task 4's background
      // write path, only WRITES). This drops the bytes; it does NOT avoid their cost — an attached
      // `-C` client is sent every `%output` line regardless, and the client octal-decodes then
      // UTF-8-decodes each one on the main thread before this callback throws it away. All the drop
      // buys is not forwarding it any further. STANDING OBLIGATION: before any first production
      // caller, either run the wire-cost probe (measure that traffic on a busy session) or issue
      // `refresh-client -fno-output` for write-only clients so tmux stops sending it at all
      // (tmux >= 3.2 — the floor this feature would then require).
      onOutput: () => {},
      // An UNEXPECTED death only — `dispose()` is silent by design, so this can never fire for a
      // swap-out we asked for. Forget the entry and stop there: the tmux session, its processes and
      // its scrollback are untouched, and the next `shadowAttach` re-attaches.
      onExit: () => {
        if (this.shadows.get(persistKey) === client) this.shadows.delete(persistKey)
      },
      spawner: this.controlSpawn
    })
    this.shadows.set(persistKey, client)
    try {
      client.start()
    } catch {
      // `child_process.spawn` throws SYNCHRONOUSLY on EMFILE and friends — and a machine short of
      // file descriptors is exactly the machine a background feature reaches for a shadow on. The
      // contract is "null, never a rejection", so swallow it and leave no half-attached entry.
      this.shadows.delete(persistKey)
      return null
    }
    // One line per swap direction, in the field-report vocabulary of this feature ("shadow attach" /
    // "painter attach", see `spawnSession`). Only when a client is actually STARTED: a re-used
    // shadow swapped nothing, and a line per caller would say nothing about the session's state.
    console.log(`[pty] shadow attach ${sessionName(persistKey)}`)
    const size = this.released.get(persistKey)?.size
    if (size) {
      const line = `refresh-client -C ${size.cols}x${size.rows}`
      const reply = await this.shadowCommand(persistKey, line)
      // Only a torn-down shadow (timeout, or death under us) fails the attach. tmux REFUSING the
      // size (`%error`) leaves a perfectly usable client and a pane at its standing size, which is
      // the same outcome as having no size to push.
      if (reply === null) return null
    }
    // NO recorded size pushes nothing, deliberately: the pane keeps the standing size it has had
    // since its last painter, and inventing one here would reflow a pane that is perfectly fine.
    // (A relay-served pty released without ever reporting a size is exactly that case.)
    //
    // Re-read the map rather than returning `client`: a `create()` may have swapped this shadow out
    // for a painter across the await above, and handing back a disposed client would look live.
    return this.shadows.get(persistKey) ?? null
  }

  /**
   * The tmux sessions this manager currently shadows on `socket` — the subtraction the session
   * budget needs (session-budget.ts): a held `-C attach` flips `#{session_attached}` to 1, and an
   * attached session is never culled, so without this a shadowed session would be permanently
   * exempt from the memory-pressure safety valve. A shadow is not a watcher; the budget may kill
   * the session under it, and the shadow dies with it.
   *
   * Socket-scoped because `nt-<node>` is only unique within a socket: shadows are attached on the
   * LOCAL socket only, and a genuinely attached session of the same name on `nodeterm-rmt` (an SSH
   * host's own sessions) keeps its exemption.
   */
  shadowedTmuxSessions(socket: string): string[] {
    if (socket !== TMUX_SOCKET) return []
    const names: string[] = []
    for (const [persistKey, client] of this.shadows)
      if (client.alive) names.push(sessionName(persistKey))
    // The shared background-write client is a tmux client of the session it attached to, exactly
    // like a shadow, and is subtracted the same way. It can never DOUBLE with a shadow of that same
    // session — `shadowAttach` retires it first — which is what keeps the budget's "minus one
    // client per name" arithmetic (session-budget.ts) honest.
    if (this.shared?.client.alive) names.push(sessionName(this.shared.persistKey))
    return names
  }

  /** Retire a node's shadow, if it has one. Idempotent. The entry is dropped HERE because
   *  `dispose()` is silent (it does not fire `onExit`) — a deliberate swap-out is not a death. */
  shadowDispose(persistKey: string): void {
    const client = this.shadows.get(persistKey)
    if (!client) return
    this.shadows.delete(persistKey)
    client.dispose()
  }

  /**
   * Run ONE control-mode command on a node's shadow, bounded by `SHADOW_CMD_TIMEOUT_MS`. EVERY
   * command issued to a shadow must go through here: the client owns no timers, and a reply that
   * never comes desyncs its positional FIFO for good — so the timeout is a teardown, not a retry.
   *
   * Returns the reply (`ok` is tmux's own verdict), or null when there is no shadow, when the line
   * is not a single command, or when the command timed out / the client died — in the last case the
   * shadow is gone and a caller that still wants one asks `shadowAttach` for a fresh client.
   *
   * Public because it is the sanctioned way to talk to a shadow: a caller reaching past it to
   * `client.command()` would be issuing an unbounded command, which is the one thing this whole
   * mechanism cannot survive.
   */
  async shadowCommand(
    persistKey: string,
    line: string
  ): Promise<{ ok: boolean; body: string[] } | null> {
    const client = this.shadows.get(persistKey)
    if (!client) return null
    return this.controlCommand(client, line, () => {
      // Only if it is still OUR client: a shadow replaced across the await was already disposed by
      // whoever replaced it, and disposing again would take down a healthy successor.
      if (this.shadows.get(persistKey) === client) this.shadowDispose(persistKey)
    })
  }

  /**
   * The timeout that every control-mode command in this manager is issued under — the shared body
   * of `shadowCommand` and of the shared background-write client's commands. `onBroken` is how the
   * caller retires ITS client; this method never decides which registry a client lives in.
   */
  private async controlCommand(
    client: ControlModeClient,
    line: string,
    onBroken: () => void
  ): Promise<{ ok: boolean; body: string[] } | null> {
    // Refuse a multi-line command HERE rather than letting the client refuse it below. Both answer
    // null, but the difference is what happens to the shadow: the catch treats a rejection as
    // evidence the channel is unusable and DISPOSES, which is right for a timeout or a death and
    // pure collateral damage for a line that was never written (the FIFO cannot have desynced —
    // see the same guard in tmux-control-client.ts). Screening it out up front is what makes the
    // catch's blanket teardown safe: everything that can reject past this point has either reached
    // the wire or lost the client.
    if (/[\r\n]/.test(line)) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        client.command(line),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`tmux control-mode command timed out: ${line}`)),
            SHADOW_CMD_TIMEOUT_MS
          )
          timer.unref?.()
        })
      ])
    } catch {
      onBroken()
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Type `data` into a node whose PAINTER pty client is gone, without spawning one.
   *
   * The fallthrough, in order:
   *  1. **the painter**, if the node is on screen after all — the session's own pty, exactly as a
   *     keystroke from its terminal. (A caller holding a stale session id can land here; it is the
   *     same NODE either way, which is what the caller asked for.)
   *  2. **the node's own shadow**, if one is already up. Never attaches one: a shadow exists to be
   *     re-used by whoever attached it, and a write does not need a session-scoped client.
   *  3. **the shared control client** (`sharedClientFor`) — one `tmux -C` child for the whole
   *     server, because `send-keys -t <session>` is a server-wide command.
   *
   * Returns whether the keys were delivered. **A false is never retried on another client**: a
   * timed-out `send-keys` may well have run — control mode loses the REPLY, not necessarily the
   * command — so re-sending it elsewhere risks typing the input twice, which is worse than not
   * typing it at all.
   *
   * REFUSALS, both of them the same rule — never write into a session this process cannot prove is
   * the node's own local one:
   *  - a node with no `released` record: this process never released it, so `nt-<id>` on our socket
   *    is a name we have no claim to (a remote node's local orphan, another machine's idea of it, a
   *    session someone else made). An unknown key is not evidence of a session.
   *  - a node whose record says `remote`: its tmux is on the far host. Reaching it means the
   *    project's ControlMaster (`remoteTmuxPasteArgs`), not this channel; refusing is the honest
   *    answer until that exists.
   */
  async backgroundWrite(persistKey: string, data: string): Promise<boolean> {
    // Nothing to type — and `encodeSendKeysHex` would build a `send-keys -H ` with no bytes after
    // it, which is a command line worth not sending.
    if (!data) return false
    const live = this.sessionByPersistKey(persistKey)
    if (live) {
      try {
        live.proc.write(data)
      } catch {
        // node-pty throws on a write to a process that has already exited (the same hazard
        // `applySize` guards on resize). This method is called fire-and-forget from `write()`, so a
        // throw would surface as an UNHANDLED rejection in the main process — the crash risk Task
        // 2's handoff note 2 names. A dead painter is a delivery failure, not an exception.
        return false
      }
      return true
    }
    const settings = this.getSettings()
    if (!this.tmuxPath || !settings.tmuxEnabled) return false
    // The kill switch, and the reason it sits BELOW tier 1: the painter is the session's own pty,
    // which exists with or without this feature — gating it would turn "no control clients" into
    // "background writes stop working", which is a different setting. Below here, every tier needs
    // a `tmux -C` child, so this one check covers both of them (`shadowAttach` carries the other).
    if (!settings.ptyShadowClients) return false
    const known = this.released.get(persistKey)
    if (!known || known.remote) return false
    const target = sessionName(persistKey)
    // Belt and braces: `encodeSendKeysHex` interpolates the target UNQUOTED (Task 2 handoff note
    // 12), and this line reaches a tmux server holding every session on the socket. `sessionName`
    // cannot produce anything else today — which is exactly why this stays cheap.
    if (!isSessionName(target)) return false
    const line = encodeSendKeysHex(target, data)
    const shadow = this.shadows.get(persistKey)
    // ALIVE, not merely present: `dispose()` is silent (it fires no `onExit`), so a shadow retired
    // by whoever was handed it leaves its entry behind, and a dead client can deliver nothing.
    // Falling through to tier 3 does not violate the never-retry rule either — a client that is not
    // running rejects `command()` BEFORE writing a byte (tmux-control-client.ts), so the keys it
    // refused cannot also have reached tmux.
    if (shadow?.alive) return (await this.shadowCommand(persistKey, line))?.ok ?? false
    const client = this.sharedClientFor(persistKey)
    if (!client) return false
    return (await this.controlCommand(client, line, () => this.sharedDispose(client)))?.ok ?? false
  }

  /**
   * The shared background-write client, started on demand and attached to `persistKey`'s session.
   *
   * WHICH session it attaches to is deterministic and deliberately the least interesting choice
   * available: the session of the background write that needed it. That session was just proved to
   * be local, released and ours — so the attach cannot land on a foreign session, and cannot put a
   * second client of ours on a pane a painter is already drawing. Every command it then issues
   * carries its own explicit `-t`, so the attachment never decides where the keys go.
   *
   * It pushes NO size, unlike a per-session shadow: it displays nothing, and `refresh-client -C`
   * would resize the pane for whoever IS watching that session (their own `tmux attach`). The pane
   * keeps the standing size its last painter left it at.
   *
   * Null when tmux is unavailable or the child could not be spawned (`child_process.spawn` throws
   * synchronously on EMFILE and friends — the machine a background feature reaches for a client on).
   */
  private sharedClientFor(persistKey: string): ControlModeClient | null {
    // BOTH halves of "is there a tmux session at all", as `shadowAttach` carries them: with tmux
    // switched off `tmuxPath` is still set (the binary is installed) but nothing ever created a
    // session, so this would attach to a name that does not exist. Its only caller checks the same
    // thing three lines earlier — this is here so a second caller cannot arrive without it.
    if (!this.tmuxPath || !this.getSettings().tmuxEnabled) return null
    this.armSharedLinger()
    const live = this.shared
    if (live?.client.alive) return live.client
    if (live) this.shared = null // died since it was started; its onExit normally clears this
    const client = new ControlModeClient({
      tmuxBin: this.tmuxPath,
      socket: TMUX_SOCKET,
      sessionName: sessionName(persistKey),
      // This client writes; it never reads — but dropping `%output` here saves none of its cost.
      // While attached, tmux sends this client the pane output of the session it landed on, and it
      // octal-decodes then UTF-8-decodes all of it on the main thread before this callback discards
      // it; the drop
      // only stops it going further. The linger bounds how long that is paid for. STANDING
      // OBLIGATION (same as the per-session shadow above): before any first production caller,
      // either run the wire-cost probe or issue `refresh-client -fno-output` for these write-only
      // clients (tmux >= 3.2) so the bytes are never sent.
      onOutput: () => {},
      onExit: () => {
        if (this.shared?.client === client) this.shared = null
      },
      spawner: this.controlSpawn
    })
    this.shared = { client, persistKey }
    try {
      client.start()
    } catch {
      this.shared = null
      return null
    }
    // Same line as a per-session shadow, deliberately: from the outside these are the same event —
    // a control client of ours became this session's attached client — and a field report should
    // not have to know which of the two kinds it is looking at. The linger keeps it rare.
    console.log(`[pty] shadow attach ${sessionName(persistKey)}`)
    return client
  }

  /** (Re)arm the linger: the client goes `BACKGROUND_WRITE_LINGER_MS` after the LAST write wanted
   *  it, so a burst keeps one child and a trickle does not churn one per write. */
  private armSharedLinger(): void {
    if (this.sharedLinger) clearTimeout(this.sharedLinger)
    this.sharedLinger = setTimeout(() => this.sharedDispose(), BACKGROUND_WRITE_LINGER_MS)
    // Node keeps the process alive for a pending timer, and this one must never be the reason a
    // quitting app lingers (the other manager timers unref for the same reason).
    this.sharedLinger.unref?.()
  }

  /** Retire the shared client AND its linger. Idempotent. `only` makes it a no-op while a DIFFERENT
   *  client is the current one — a caller reacting to its own client's failure must take down
   *  neither the successor nor the successor's timer. With nothing attached at all there is no
   *  successor to protect, and the timer goes either way. */
  private sharedDispose(only?: ControlModeClient): void {
    const live = this.shared
    // A SUCCESSOR is left entirely alone, linger included: `only` is passed by a caller reacting to
    // its own client's failure, and by then a later write may already have started a new one.
    if (only && live && live.client !== only) return
    // Cleared even when nothing is attached — `onExit` clears `shared` on its own (a client that
    // died under us), and the linger armed for it would otherwise stay pending, aimed at whatever
    // is attached when it fires.
    if (this.sharedLinger) {
      clearTimeout(this.sharedLinger)
      this.sharedLinger = null
    }
    if (!live) return
    this.shared = null
    live.client.dispose()
  }

  /** Retire the shared client if it is attached to THIS node's session — for the two events that
   *  claim that session for another client of ours (a painter spawning, a shadow attaching) and for
   *  the one that ends it (`endSession`). Elsewhere it keeps lingering; the attachment is
   *  incidental, and it can be re-started against any session. */
  private sharedDisposeOn(persistKey: string): void {
    if (this.shared?.persistKey === persistKey) this.sharedDispose()
  }

  /** Must run after app is ready (needs userData path). */
  init(
    getSettings: () => Settings,
    getModelGatewaySecret: () => string | null = () => null
  ): void {
    this.getSettings = getSettings
    this.getModelGatewaySecret = getModelGatewaySecret
    // Register the custom-id → baseAgent resolver so the capability predicates in
    // shared/agents/config (hasHooks, canResume, mintsSessionId, hasPermissionMode,
    // canControlCanvas, …) resolve a custom agent's INHERITED harness. config.ts takes only an id
    // (it cannot import the settings store without a cycle/platform split), so the lookup is
    // injected here: the closure reads LIVE settings, so registering once at init is enough — a
    // settings update is reflected on the next predicate call.
    setCustomAgentBaseResolver((id) => findCustomAgent(this.getSettings().customAgents, id)?.baseAgent)
    // Prewarm the login-shell PATH probe now so the first terminal spawn doesn't wait on it —
    // and re-run the tmux probe once it lands: findTmux no longer spawns a login shell of its
    // own, so a tmux living only on the user's shell PATH is invisible until this resolves.
    void resolveShellPath().then(() => this.ensureTmux())
    this.ensureTmux()
    // Read the system pty-device ceiling now, while nothing is wrong. The spawn path that needs it
    // is synchronous and already one failed spawn deep — it cannot await a `sysctl` there, and a
    // machine at its device limit is exactly a machine where spawning one more process is a bad
    // idea. See pty-devices.ts.
    primePtyCeiling()
  }

  /**
   * Wire the project settings → spawn overrides reader (SDD: project-settings consumption, Task 4).
   *
   * A SEPARATE setter rather than a third `init` argument: the Server Edition constructs its
   * workspace/trust stores AFTER `ptyManager.init(...)`, so an init parameter could only ever be
   * wired on one of the two shells.
   */
  setProjectSpawnOverrides(read: ProjectSpawnOverridesReader | null): void {
    this.readProjectSpawnOverrides = read
  }

  /**
   * The project's contribution to THIS spawn — bounded and fail-open on every path.
   *
   *  - no reader wired, or no `ownerProjectId` (the pane is UNPROVEN — see PtyCreateOptions) ⇒ no
   *    overrides, and the reader is not even asked,
   *  - a reader that rejects ⇒ no overrides,
   *  - a reader that HANGS ⇒ no overrides after PROJECT_OVERRIDES_TIMEOUT_MS. The read still
   *    settles on its own afterwards (nothing is cancelled); this spawn just stops waiting.
   */
  private async projectSpawnOverrides(
    options: PtyCreateOptions
  ): Promise<ProjectSpawnOverrides | null> {
    const read = this.readProjectSpawnOverrides
    if (!read || !options.ownerProjectId) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(options.ownerProjectId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROJECT_OVERRIDES_TIMEOUT_MS)
          // Never hold the process open for a settings read nobody is waiting on any more.
          timer.unref?.()
        })
      ])
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Probe tmux and write/push the generated config. Idempotent and safe to re-run: a later
   *  successful probe (the banner's install command finishing, or init()'s post-PATH-probe re-run
   *  finding a tmux only the login shell knew about) brings tmux up for NEW sessions without an
   *  app restart — existing plain-shell sessions are left alone. There is deliberately no
   *  migration: a process already running under a bare pty cannot be moved into a tmux pane, so
   *  the recovery for one of those is the node's own refresh/respawn, which re-creates the session
   *  through the now-resolved tmux (at the cost of that shell's state, as any respawn is).
   *  No-op while tmux is already resolved or before init() provided settings. */
  ensureTmux(): void {
    if (this.tmuxPath || !this.getSettings) return
    // platform() is safe past the guard above: getSettings is only set by init(), which the shell
    // calls after initPlatform(). resourcesPath is undefined on the Server Edition, so the bundled
    // candidate is simply absent there (Linux keeps system-tmux-only).
    const found = findTmux(platform().resourcesPath)
    if (!found) return
    this.confPath = path.join(platform().userDataDir, 'tmux.conf')
    try {
      const s = this.getSettings()
      fs.writeFileSync(this.confPath, tmuxConf(s.tmuxScrollback, s.tmuxLeadPaneWidth))
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

  /** `update-environment` names already pushed to the running server this app-run (plus the
   *  conf-baked set), so a custom agent's spawn costs at most one `set-option` per NEW key. */
  private updateEnvKeys: Set<string> | null = null

  /** Make the shared tmux server copy these client-env names into new sessions. The conf bakes
   *  the fixed gateway list; a CUSTOM agent's env keys are user-defined and can only be appended
   *  at runtime. Names ride the `set-option` argv — names only, values never (values reach tmux
   *  through the client's process environment; that is the point of this whole path). Failure is
   *  fail-open twice over: with NO server running, the session about to spawn starts the server
   *  itself and its panes inherit the client env directly; a name that cannot be appended costs
   *  that var on a shared server, never the terminal. */
  private ensureUpdateEnvKeys(names: string[]): void {
    if (!this.tmuxPath) return
    const wanted = names.filter(
      (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n !== 'PATH' && n !== 'LANG'
    )
    if (!wanted.length) return
    if (!this.updateEnvKeys) {
      this.updateEnvKeys = new Set(MODEL_GATEWAY_ENV_KEYS)
      try {
        const out = execFileSync(
          this.tmuxPath,
          ['-L', TMUX_SOCKET, 'show-options', '-g', 'update-environment'],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString()
        for (const m of out.matchAll(/update-environment\[\d+\]\s+(\S+)/g)) {
          this.updateEnvKeys.add(m[1])
        }
      } catch {
        /* no server yet — the conf list is what a fresh server will have */
      }
    }
    for (const name of wanted) {
      if (this.updateEnvKeys.has(name)) continue
      try {
        execFileSync(
          this.tmuxPath,
          ['-L', TMUX_SOCKET, 'set-option', '-ga', 'update-environment', name],
          { stdio: 'ignore' }
        )
        this.updateEnvKeys.add(name)
      } catch {
        /* no server yet — fresh-server sessions inherit the client env directly */
      }
    }
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
    // Optional TRAILING `everySocket`: only the session-memory panel's SPECULATIVE kill sets it,
    // and only for a row it holds no session for (see `localKillSockets`). `=== true` because the
    // value arrives verbatim off the wire; absent ⇒ the narrow, historical single-socket kill.
    platform().handleWithSender(
      IPC.ptyDestroy,
      (senderId: number, persistKey: string, everySocket?: unknown) =>
        this.endFromClient(senderId, IPC.ptyDestroy, persistKey, 'delete', everySocket === true)
    )
    // Version skew: older desktop/mobile/relay clients still cast this channel. Keep that path
    // functional, but contain its Promise — a failed host kill must neither tear down local state
    // nor become an unhandled rejection in the shell that cannot receive an acknowledgement.
    platform().onWithSender(
      IPC.ptyDestroy,
      (senderId: number, persistKey: string, everySocket?: unknown) => {
        void this.endFromClient(
          senderId,
          IPC.ptyDestroy,
          persistKey,
          'delete',
          everySocket === true,
          false
        ).catch((error) =>
          console.warn(
            `[pty] legacy destroy for ${persistKey} was not confirmed`,
            error instanceof Error ? error.message : String(error)
          )
        )
      }
    )
    // Sender-aware for the opposite reason: the client that RECYCLED the node drives its own
    // respawn, so it is the one client that must NOT be sent the restart notice.
    platform().handleWithSender(IPC.ptyRecycle, (senderId: number, persistKey: string) =>
      this.endFromClient(senderId, IPC.ptyRecycle, persistKey, 'recycle')
    )
    // Same compatibility bridge as destroy above. New clients await the handler; old casts keep
    // working, with rejection contained because their protocol has nowhere to return it.
    platform().onWithSender(IPC.ptyRecycle, (senderId: number, persistKey: string) => {
      void this.endFromClient(senderId, IPC.ptyRecycle, persistKey, 'recycle', false, false).catch((error) =>
        console.warn(
          `[pty] legacy recycle for ${persistKey} was not confirmed`,
          error instanceof Error ? error.message : String(error)
        )
      )
    })
    platform().handle(IPC.ptyReadScrollback, (persistKey: string) =>
      readScrollback(persistKey)
    )
    platform().handle(IPC.ptySendText, (persistKey: string, text: string, enter?: boolean) =>
      this.sendText(persistKey, text, enter === undefined ? undefined : { enter })
    )
    platform().handle(IPC.ptyTmuxStatus, () => this.tmuxStatus())
    platform().handle(IPC.ptyPaneCommand, (persistKey: string) => this.paneCommand(persistKey))
    platform().handle(IPC.ptyTerminateForeground, (persistKey: string, expectedAgentId?: string) =>
      this.terminateForeground(persistKey, expectedAgentId)
    )
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
    intent: EndIntent,
    everySocket = false,
    acknowledged = true
  ): Promise<void> {
    if (typeof persistKey !== 'string' || !persistKey || persistKey.length > REF_MAX_LEN)
      return this.refuseClientEnd(channel, acknowledged, 'invalid node id')
    if (!this.allowEnd(clientId, channel))
      return this.refuseClientEnd(channel, acknowledged, 'rate limit exceeded; retry later')
    return this.endSession(clientId, persistKey, intent, everySocket)
  }

  /** New end requests must reject on refusal or their renderer will treat a no-op as success.
   * Legacy casts have no response carrier, so they keep their historical silent drop. */
  private refuseClientEnd(channel: string, acknowledged: boolean, reason: string): Promise<void> {
    if (!acknowledged) return Promise.resolve()
    const operation = channel === IPC.ptyRecycle ? 'recycle' : 'destroy'
    return Promise.reject(new Error(`pty ${operation} refused: ${reason}`))
  }

  /** Take one token from this client's bucket for a session-ending channel (see PTY_END_BUDGET).
   *  A request rejects on exhaustion; a legacy cast is dropped silently. */
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

  /**
   * Create or attach a node session without a renderer initiating the request.
   *
   * Client id 0 is reserved by both shells (ServerPlatform starts real websocket clients at 1;
   * Electron webContents ids are positive). Keeping the synthetic subscriber in the ordinary
   * ledger means a browser that opens later takes the proven co-attach path, while output sent to
   * id 0 is simply dropped by a platform with no such UI. All spawn policy, node-auth env,
   * account scoping, project env and ownership recording still run through `create` unchanged.
   */
  createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    return this.create(0, options)
  }

  private async create(clientId: ClientId, options: PtyCreateOptions): Promise<PtyCreateResult> {
    const key = options.persistKey
    if (!key) return this.spawnNew(clientId, options)
    // SECURITY — the choke point for the node id. Every session spawn (local tmux, plain shell,
    // SSH remote) goes through here, `pty:create` validates its payload nowhere, and node ids come
    // from `.nodeterm/project.json` — a file that travels in a cloned/shared repo and is written on
    // remote hosts. The id reaches a REMOTE SHELL verbatim as `NODETERM_NODE_ID=<key>`; quoting at
    // that splice (`remoteTmuxPtyArgs`) is the primary fix and this is the second layer, so a
    // future splice that forgets to quote is not instantly exploitable.
    //
    // FAILURE DIRECTION — refuse, don't sanitise. Nothing legitimate is refused: every id the app
    // mints comes from `nextId()` (`<prefix>-<base36>-<counter>`) or `uuid()`, both inside
    // `[A-Za-z0-9._-]`. And sanitising would be worse than a refusal here rather than merely
    // safer-looking: `NODETERM_NODE_ID` is a CROSS-BOUNDARY CONTRACT — Canvas.tsx keys
    // `agentStatus.byId` off the raw node id — so a silently rewritten id would report status for a
    // node that does not exist, i.e. a terminal that looks fine and is permanently dark. A thrown
    // error surfaces in the pane where someone can read it.
    if (!isSafeNodeId(key))
      throw new Error(
        `Refusing to open this terminal: its node id is not a safe id (allowed: letters, digits, ` +
          `dot, dash, underscore; max ${NODE_ID_MAX}). A project file with an id like this cannot be ` +
          `trusted — it is how a shared or cloned repo would smuggle a command onto a remote host.`
      )
    // A generic end and an awaited profile recycle are separate transactions, but both reserve this
    // node name while their backend outcome is pending. Wait before consulting either the live index
    // or a replacement reservation so an early host exit cannot authorize a competing generation.
    const ending = this.ending.get(key)
    if (ending) {
      await ending.promise.catch(() => undefined)
      return this.create(clientId, options)
    }
    const confirmedRecycle = this.confirmedRecycles.get(key)
    if (confirmedRecycle) {
      await confirmedRecycle.catch(() => undefined)
      return this.create(clientId, options)
    }
    if (this.unknownEnds.has(key))
      throw new Error('session end outcome unknown; retry the close before reopening this node')

    // A recycle reserves the replacement generation for the client that chose its new profile/cwd.
    // A co-viewer's create still carries stale machine-local options; let it wait for the owner's
    // exact replacement and then join, never race to become the new backend creator itself.
    const pendingRecycle = this.pendingRecycle.get(key)
    const requestingView = subKey(clientId, options.viewerId ?? PRIMARY_VIEWER)
    // Profile-switch targets arrive with the windows-terminal-profiles phase; until then no
    // pendingRecycle entry carries one, so an absent target always matches.
    const matchesRecycleTarget = !pendingRecycle?.target
    if (
      pendingRecycle &&
      (pendingRecycle.owner !== requestingView || !matchesRecycleTarget)
    ) {
      return new Promise<PtyCreateResult>((resolve, reject) => {
        // Recheck after allocating the promise: `fireRecycled` is synchronous, but keeping the
        // exact entry check makes a future awaited boundary here unable to strand this waiter.
        if (this.pendingRecycle.get(key) !== pendingRecycle) {
          void this.create(clientId, options).then(resolve, reject)
          return
        }
        pendingRecycle.waiters.push({ clientId, options, resolve, reject })
      })
    }
    // Same-tick race: spawnNew() awaits a `tmux has-session` SUBPROCESS (tens of ms, not a
    // microtask) before spawnSession registers the session in `byPersistKey`, so two clients
    // opening the same node in that window would BOTH miss the index and both spawn — and the
    // second `tmux -A -D` detaches the first client, killing that user's terminal. So the spawn
    // is published as an in-flight promise from the TOP of create(): a racing create awaits it
    // and then takes the subscribe branch. (No locking primitive: the promise IS the barrier —
    // the single-user path never sees an in-flight entry and behaves exactly as before.)
    // Check the barrier BEFORE the live-session index. A session-host shim is registered while
    // its asynchronous attach is still pending; treating that provisional entry as joinable lets
    // a racing client receive a live-looking id even if `ready` rejects a moment later.
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
    // Co-attach: a live session for this node id already exists in THIS process (another client,
    // or this client's own second view). Subscribe to it instead of spawning a second tmux client
    // — `-D` would otherwise kick the first viewer off. This runs after the in-flight barrier, so
    // every session visible here has completed its asynchronous session-host attach.
    const joined = this.join(clientId, options, key)
    if (joined) return joined
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
    spawn.then(clear, (error) => {
      clear()
      // The reserved owner failed to establish the replacement (resolver failure, spawn throw,
      // rejected attach, or exit-before-ready). Release co-viewers immediately with ready:false;
      // the timeout exists only for an owner that never attempts the create at all.
      if (this.pendingRecycle.get(key)?.owner === requestingView) this.fireRecycled(key, false)
      return error
    })
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
    // Same source, different question (and different consumer): a joiner needs to know whether the
    // session it landed on survives losing a client, because its own unmount may park it.
    const persistent = !!existing.persistKey
    const base: PtyCreateResult = existing.accountFallback
      ? { sessionId: existingId, fresh: false, accountFallback: true, coAttachMouse, persistent }
      : { sessionId: existingId, fresh: false, coAttachMouse, persistent }
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
    // FAIL-CLOSED Codex account scope (S6 §5 property 4 / Decision 2, the carried PR-1 obligation).
    // A LOCAL Codex spawn that EXPLICITLY selected a managed account whose home is missing REFUSES
    // here — it must never fall through and spawn against the SYSTEM `~/.codex` (silently acting as
    // the wrong login is a worse failure for an explicit switch than for a first spawn). This is
    // deliberately STRICTER than the Claude account path below, which falls back with a warning
    // chip. `resolveCodexSessionScope` returns `{ unavailable: 'codex-account' }` for exactly that
    // case; we map it straight through to a real refusal and spawn NOTHING. The system account (no
    // id) always resolves. Remote (ssh) Codex sessions carry their account env via tmux `-e`.
    if (needsCodexAccountScope(options.agentId, options.accountId, (id) => this.isCodexAccount(id)) && !options.sshRemote) {
      const scope = resolveCodexSessionScope(platform().userDataDir, options.accountId)
      if (isCodexScopeRefusal(scope)) {
        return { sessionId: '', fresh: false, unavailable: 'codex-account' }
      }
    }
    // A tmux-backed session is "fresh" (cold start) when no live session exists to reattach to
    // — i.e. first open, or after a machine reboot killed the tmux server. Plain (non-tmux)
    // sessions are always fresh: they have no cross-restart continuity. The renderer uses this
    // to decide whether to replay the persisted scrollback and re-launch a resumable agent.
    // The Windows-profile warm-backend probe (attach-only reattach of a proven session-host or
    // tmux generation, decided ahead of trusted profile resolution) lands with the
    // windows-terminal-profiles phase; until then nothing assigns this and every create takes the
    // ordinary attach-or-create path below.
    let warmWindowsBackend: 'session-host' | 'tmux' | undefined
    const tmuxBacked = !!this.tmuxPath && this.getSettings().tmuxEnabled && !!options.persistKey
    // For an SSH-project node, "fresh" is decided by the REMOTE tmux server (over the project's
    // ControlMaster), not the local one. The remote `has-session` is a full network round-trip,
    // so it MUST be async (`runAsync`) — a synchronous probe here would freeze every window/IPC
    // for its duration. Falls through to the local tmux/plain logic otherwise (also async: a
    // bulk project load fires one create() per node, and even cheap probes add up serialized).
    //
    // `true` here for a node that ends up SESSION-HOST-backed is only a PLACEHOLDER: unlike tmux
    // (a cheap name-only `has-session` probe, decided before spawning anything) the session-host
    // backend's attach-or-create IS the probe — see the `spawned?.sessionHost` branch below, which
    // overwrites both `fresh` and `screen` from that same round trip once `spawnSession` returns.
    let fresh = options.sshRemote
      ? !(await this.remoteSessionExists(
          options.sshRemote,
          sessionName(options.persistKey as string)
        ))
      : warmWindowsBackend
        ? false
        : tmuxBacked
        ? !(await this.tmuxSessionExists(options.persistKey as string))
        : true
    // Ensure the login-shell PATH is resolved (prewarmed in init(); usually already settled)
    // so the session env below picks it up — awaiting keeps the event loop free either way.
    await resolveShellPath()
    // Rewrite the launcher on every create: it is generated, so an app upgrade must not leave an
    // old copy behind. Failure is not fatal — `installCodexLauncher` answers null, the caps probe
    // says "no shared identity", and the launch line the renderer already chose is the bare CLI.
    if (options.agentId && hasSharedIdentity(options.agentId as AgentId) && !options.sshRemote) {
      installCodexLauncher()
    }
    // Resolved HERE rather than inside `spawnSession` because that function is synchronous and two
    // of its three callers (`createDetached`/`attachDetached`, the relay host's attach path) are
    // synchronous public API.
    //
    // Those two are NOT merely attaches — `attachDetached` goes through `tmux new-session -A`, which
    // CREATES when the host's session died (that is exactly what `sessionExists` is asked ahead of,
    // and what `fresh` reports). What makes them override-less is narrower and true either way: the
    // relay host passes only `{cols, rows}` (host-service.ts), so those spawns carry no
    // `ownerProjectId` — and no cwd, agent, account or hook env either. A mirrored client that
    // lands on a re-created session gets the same bare login shell it got before this feature.
    const projectOverrides = await this.projectSpawnOverrides(options)
    // Resolved HERE for the same synchronous-spawnSession reason as projectOverrides — and the
    // relay host's detached callers pass no `sshRemote` at all, so this is the one path that needs
    // it. Re-derive the login-agent pin for the endpoint (issue #427): same memoized `ssh -G`
    // probe the ControlMaster's connect uses, and it OVERWRITES any inbound value — `sshRemote` is
    // renderer-built and its conn can descend from a shareable project file, so only the local
    // probe may decide which agent socket the argv builders pin. The annotated conn is what the
    // session stores, so every later remote op (capture, sendText, remote git) rides the same
    // answer. Fail-open: a failed probe ⇒ undefined ⇒ the pre-#427 command lines.
    if (options.sshRemote) {
      options = {
        ...options,
        sshRemote: {
          ...options.sshRemote,
          conn: {
            ...options.sshRemote.conn,
            identityAgentSock: await probeAgentSockToPin(options.sshRemote.conn).catch(
              () => undefined
            )
          }
        }
      }
    }
    const sessionId = this.spawnSession(
      options,
      clientId,
      undefined,
      warmWindowsBackend,
      projectOverrides
    )
    const spawned = this.sessions.get(sessionId)
    // PANE OWNERSHIP (agent messaging, PR #237 fix round 2): record the OWNING project of a pane
    // this process just GENUINELY spawned. Gated on `fresh` — an attach/co-attach to a session
    // someone else spawned (incl. an app-restart re-attach) leaves the pane UNPROVEN, so a second
    // project that merely opens another's node id cannot claim it. The owner is the renderer's
    // machine-local project id, never the git-shared file id. See `agents/pane-ownership.ts`.
    if (shouldRecordOwnership(fresh, options.persistKey, options.ownerProjectId))
      recordFreshSpawnOwner(options.persistKey as string, options.ownerProjectId)
    if (warmWindowsBackend === 'tmux') {
      // The first strict probe deliberately preceded profile resolution. Recheck after launching
      // attach-only: if the named session disappeared in that window, never return the transient
      // tmux client as a usable generation. `attach-session` itself cannot cold-create.
      const stillExists = await this.confirmedTmuxSessionExists(options.persistKey as string)
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!stillExists || !spawned || this.sessions.get(sessionId) !== spawned) {
        if (spawned && this.sessions.get(sessionId) === spawned)
          this.discardFailedSpawn(sessionId, spawned)
        throw new Error('The existing terminal session disappeared before it could be reattached.')
      }
    }
    // The session-host backend is NOT a painter (see docs/windows-session-host.md, "The seeding
    // trap"): a warm attach there gets no free redraw the way a real tmux client provides, so
    // this create must carry the screen to seed itself — exactly the same field a same-process
    // co-attach JOIN already populates via `join()` below. `SessionHostPty.ready` is the SAME
    // attach-or-create round trip `spawnSession` just kicked off; awaiting it here costs nothing
    // extra (the socket write already happened) and is the only way to learn its real `fresh`.
    let screen: string | undefined
    if (spawned?.sessionHost) {
      try {
        const info = await (spawned.proc as unknown as SessionHostPty).ready
        // `ready` and the pty's natural exit are independent host messages. If exit won the race,
        // its handler already retired this exact generation; returning the captured Session object
        // here would hand the renderer a plausible persistent id that no longer accepts writes.
        if (this.sessions.get(sessionId) !== spawned) {
          throw new Error('The terminal session exited before it became ready.')
        }
        fresh = info.fresh
        screen = info.screen
        // Session-host registration is provisional until the exact ready barrier above succeeds.
        // Only now is an owner's resurrection real enough to remove a prior deletion tombstone.
        if (spawned.indexKey) this.tombstones.delete(spawned.indexKey)
        // A recycle notice must describe a usable replacement, not merely a provisional local
        // Session record. Session-host registration precedes this async barrier, so publish now.
        if (spawned.indexKey && this.pendingRecycle.has(spawned.indexKey))
          this.fireRecycled(spawned.indexKey, true)
      } catch (error) {
        // The shim is registered synchronously so output callbacks have somewhere to land, but a
        // rejected attach means no usable pty ever existed. Retire every local claim and detach
        // the shim before propagating the real failure; returning its id creates a terminal that
        // looks alive while every write disappears.
        if (this.sessions.get(sessionId) === spawned) this.discardFailedSpawn(sessionId, spawned)
        if (error instanceof SessionHostProtocolCompatibilityError) throw error
        throw error
      }
    }
    // Surface a missing-account-dir fallback so the renderer can flag the node's account chip.
    const accountFallback = spawned?.accountFallback
    // The session's `persistKey` is set iff the spawn actually landed on a tmux, local or remote
    // (`persisted` in spawnSession) — i.e. exactly "this session survives losing its client",
    // which is what the renderer's cache-dispose levers must not assume. See PtyCreateResult.
    const persistent = !!spawned?.persistKey
    // Stale-cwd probe (issue #464), WARM local-tmux reattach only: `new-session -A` reattached a
    // session whose shell may sit on a DELETED directory inode (a re-created same-named folder is
    // a different inode, so the getcwd errors never self-heal). A fresh spawn already validated
    // its cwd above; a plain shell has no session that outlived anything; an SSH-remote session's
    // cwd lives on the host (its probe would need a remote round trip — deliberately out of v1).
    // Failure/unknowable ⇒ absent ⇒ no banner: the flag is only ever raised on tmux's own answer.
    const staleCwd =
      !fresh && tmuxBacked && !options.sshRemote && !spawned?.sessionHost && options.persistKey
        ? await this.paneCwdStale(options.persistKey)
        : false
    return {
      sessionId,
      fresh,
      persistent,
      ...(accountFallback ? { accountFallback } : {}),
      ...(staleCwd ? { staleCwd: true as const } : {}),
      ...(screen ? { screen } : {})
    }
  }

  /**
   * Is the live tmux session's working directory GONE (deleted, or deleted and re-created at the
   * same path — issue #464)? Asks tmux for `#{pane_current_path}` — a format present since 1.7,
   * so no version hazard — and classifies through the pure `classifyPaneCwd` (see pane-cwd.ts for
   * the per-platform signals, one measured and one inferred). Exact-match target: `=name:` —
   * the trailing colon matters, and is MEASURED (tmux 3.4): for a target-PANE a bare `=name`
   * resolves NOTHING silently (exit 0, every format empty), while `=name:` is "exactly this
   * session, its active pane". Without `=`, tmux falls back to fnmatch-then-prefix matching and
   * could answer about a DIFFERENT node whose id extends this one (the same trap the kill path
   * documents). Any failure answers `false` — no banner on a guess.
   */
  private async paneCwdStale(persistKey: string): Promise<boolean> {
    if (!this.tmuxPath) return false
    try {
      const { stdout } = await runAsync(
        this.tmuxPath,
        [
          '-L',
          TMUX_SOCKET,
          'display-message',
          '-p',
          '-t',
          `=${sessionName(persistKey)}:`,
          '#{pane_current_path}'
        ],
        { timeout: PROBE_TIMEOUT_MS }
      )
      // Strip ONLY the transport's trailing newline — a path may legally end in spaces, and the
      // Linux " (deleted)" suffix must survive untouched for the classifier to see it.
      const reported = stdout.replace(/\r?\n$/, '')
      const dirExists = (p: string): boolean => {
        try {
          return fs.statSync(p).isDirectory()
        } catch {
          return false
        }
      }
      return classifyPaneCwd(reported, dirExists) === 'stale'
    } catch {
      return false
    }
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

  /** The exact live generation for a node id, including a non-persistent indexed plain shell. */
  private liveSessionForPersistKey(persistKey: string): Session | undefined {
    const indexedId = this.byPersistKey.get(persistKey)
    return (indexedId ? this.sessions.get(indexedId) : undefined) ?? this.sessionByPersistKey(persistKey)
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

  /**
   * Public read of the probe below, for callers that attach WITHOUT going through `create()` and
   * so never receive its `fresh` flag — today the relay host's `pty.attach` (`host-service.ts`).
   * `attachDetached` spawns through `tmux new-session -A`, which CREATES when the session is
   * gone, so without asking first a mirrored client cannot tell "I joined your live agent" from
   * "I just made you an empty login shell". That is what showed a phone a bare `~ %` prompt
   * under a Claude node's title after the host's tmux server died.
   *
   * Same fail-safe direction as everywhere else here: an unprobeable tmux answers "exists", so
   * the caller treats it as a warm join and types nothing into it.
   */
  async sessionExists(persistKey: string): Promise<boolean> {
    if (this.liveSessionForPersistKey(persistKey)) return true
    const probes: Promise<boolean>[] = []
    if (this.tmuxPath) probes.push(this.tmuxSessionExists(persistKey))
    if (this.getSettings().tmuxEnabled && sessionHostSupported()) {
      // A failed host read is not evidence of absence. This mirrors tmuxSessionExists' fail-safe
      // direction and prevents a reconnect blip from being mistaken for a cold generation.
      probes.push(sessionHostHasSession(sessionName(persistKey)).catch(() => true))
    }
    if (probes.length === 0) return false
    return (await Promise.all(probes)).some(Boolean)
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

  /** Destructive-confirmation variant of the warm-attach probe. Warm attach treats an unavailable
   * probe as "possibly exists" to avoid typing into a live session; an awaited restart must not
   * report success on uncertainty, because its caller mutates profile state only after this says
   * the old generation ended. */
  private async confirmedTmuxSessionExists(persistKey: string): Promise<boolean> {
    if (!this.tmuxPath) return false
    try {
      await this.confirmedProcessRun(
        this.tmuxPath,
        ['-L', TMUX_SOCKET, 'has-session', '-t', sessionName(persistKey)],
        { timeout: PROBE_TIMEOUT_MS }
      )
      return true
    } catch (error) {
      if (probeSaysAbsent(error)) return false
      throw new Error(
        `Could not confirm the terminal session before restarting it: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
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
    const live = this.liveSessionForPersistKey(persistKey)
    if (live?.sessionHost) {
      try {
        return await sessionHostCapture(sessionName(persistKey), false)
      } catch {
        return ''
      }
    }
    if (!this.tmuxPath) {
      if (!this.getSettings().tmuxEnabled || !sessionHostSupported()) return ''
      try {
        return await sessionHostCapture(sessionName(persistKey), false)
      } catch {
        return ''
      }
    }
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

  /**
   * The sentence a caller sees when no terminal came back.
   *
   * One function because TWO paths now produce it: the spawn that failed (node-pty threw), and the
   * spawn that was never attempted (the pre-flight in `spawnSession`). Both must say the same thing
   * about the same machine — a user who is out of pty devices should not be able to tell which of
   * the two refused them, and the exhaustion copy must exist exactly once (it lives in
   * `spawnFailureHint`, and this is the only place that supplies its generic fallback).
   *
   * `archNote` is a parameter rather than a lookup because it is only ever true of a spawn that
   * actually tried to exec the helper — see the call sites.
   */
  private spawnFailureError(
    reason: string,
    file: string,
    cwd: string,
    archNote: string | null,
    devices: PtyDevices
  ): Error {
    // MEASURED, not guessed. node-pty discards the errno, so the old message ended every failure
    // with the same advice — restart, or rebuild node-pty for the wrong architecture. Both are
    // real causes and both are rare, and reading as authoritative sent at least one field report
    // (2026-08-06) chasing an architecture that was fine. `spawnResourceNote` states what it
    // actually counted and only names a remedy the numbers support.
    const resources = spawnResourceNote(readSpawnResources(), this.sessions.size)
    // ONE closing hint, picked by what was measured (`spawnFailureHint`): arch, else the system
    // pty-device limit, else the generic guess of last resort.
    const hint = spawnFailureHint(
      archNote,
      devices,
      `If this persists, restart the app (tmux sessions survive a restart) or run ` +
        `\`npm run rebuild\` in the repo — a release build may have rebuilt node-pty ` +
        `for the wrong architecture.`
    )
    return new Error(
      `Failed to spawn terminal (${reason}). Program: ${file}, cwd: ${cwd}, ${resources} ${hint}`
    )
  }

  private spawnSession(
    options: PtyCreateOptions,
    /** The client this session is spawned for, or null for a relay-served (detached) pty. */
    clientId: ClientId | null,
    sinks: DetachedSinks | undefined,
    /** A persistent generation proven before profile/cwd resolution; attach-only, never create. */
    warmWindowsBackend?: 'session-host' | 'tmux',
    /** What the OWNING project contributes (see `projectSpawnOverrides`) — already resolved,
     *  because this function is synchronous. Null on every path with no proven project owner. */
    overrides?: ProjectSpawnOverrides | null
  ): string {
    // PRE-FLIGHT — refuse before node-pty is touched, not after it fails.
    //
    // node-pty's darwin spawn path LEAKS the pty it opened when `posix_spawn` fails:
    // `pty_posix_spawn` (node_modules/node-pty/src/unix/pty.cc) opens the master with
    // `posix_openpt` and the slave with `open()`, and the error branch in `PtyFork` throws without
    // closing either — measured at 2 `/dev/ptmx` fds + 1 `/dev/ttys*` fd, i.e. 2 pty DEVICES, per
    // failed spawn (there is a third, smaller leak of one device per SUCCESSFUL spawn from the
    // `low_fds` cleanup loop's off-by-one). That makes exhaustion self-amplifying: at the ceiling
    // every spawn fails, every failure eats two more devices, and each retry pushes the ceiling
    // further away — a 31-minute-old main held 479 masters against 28 tmux panes and dozens of
    // consecutive failed creates. The leak is node-pty's to fix; ours is to stop feeding it.
    //
    // FIRST STATEMENT IN THE FUNCTION, ahead of the swap-out below, because a refusal must leave
    // the node exactly as it found it. Retiring the shadow first would trade a live background
    // client for nothing at all: the painter it was making way for never arrives, and nothing
    // re-attaches a shadow (`shadowAttach` is driven by release/reap, not by a failed create), so
    // a node nobody is watching would go quietly dark on a machine that is merely full. Nothing
    // between here and `pty.spawn` is needed to decide this — the reading is machine-wide.
    //
    // FAIL-OPEN is the rule here: `ptyDevicesExhausted` is false for anything unmeasured
    // (non-darwin, a `sysctl` that failed, or a ceiling whose async prime — kicked in `init` — has
    // not landed yet), so an unknown machine spawns exactly as it always did. Refusing a terminal
    // on a machine that had room would be a worse bug than the leak this avoids.
    //
    // AND THAT IS THE WHOLE FIX — no backoff, no circuit breaker, deliberately. The bursts of
    // consecutive failed creates in the field log are not a retry storm: NOTHING re-attempts a
    // create that failed. The renderer's create rejection lands in one `.catch` that only records
    // `spawnError` for the node's overlay (TerminalNode.tsx) — no timer, no respawn bump, and no
    // `reportSshDrop`, so a failure cannot even feed the SSH reconnect coordinator (whose own loop
    // is bounded anyway: 1→2→4→8→15s, then parked until a `connected` event, plus a 10s re-drop
    // refusal). A burst is therefore N DISTINCT nodes each trying exactly once, fanned out by one
    // moment — app boot, a project tab switch past the park window, an agent's bulk
    // `open-terminal --count N`, or one reconnect flush. Rate-limiting that would only stagger
    // failures the user asked for. What made it look like a storm was the amplification: 40
    // one-shot creates used to cost 80 devices, and now cost none.
    const devices = readPtyDevices()
    if (ptyDevicesExhausted(devices)) {
      // The REQUESTED program and cwd, not the resolved ones — resolution happens further down and
      // deliberately has not run. Nothing was chosen, so nothing is claimed to have been.
      //
      // `archNote` is deliberately not consulted: it outranks the device note in
      // `spawnFailureHint`, and no helper was exec'd here, so its architecture cannot be the
      // reason. Saying "rebuild node-pty" to a machine that is simply full is the 2026-08-06
      // mistake with a new cause.
      throw this.spawnFailureError(
        'not attempted',
        options.shell ?? '(default shell)',
        options.cwd ?? os.homedir(),
        null,
        devices
      )
    }

    // SWAP-OUT, before anything at all is spawned: a painter pty client is arriving for this node,
    // and a session never has both. The painter attaches with `-D` and would kick the shadow off by
    // itself — but only once tmux has processed both attaches, leaving a window where two clients
    // of ours negotiate one pane. Retiring it first (politely: `dispose()` sends `detach-client`)
    // means exactly one client is ever attached, and because `dispose()` is silent this can never
    // be mistaken for a shadow that died and wants re-attaching.
    //
    // Here rather than in `create()` so EVERY path to a painter is covered — the warm reattach, the
    // relay host's `attachDetached`, and whatever spawns next — and so the ordering is provable:
    // nothing between here and `pty.spawn` can fail, in the same synchronous function. (The
    // pre-flight above is the one thing that CAN, which is exactly why it runs before this.)
    // The shared background-write client goes too, for the same reason, when it is this node's
    // session it happens to be attached to.
    if (options.persistKey) {
      // The other half of the swap log (see `shadowAttach`), and only when there is really
      // something to retire: a painter arriving at a session no control client held swapped
      // nothing, and a line per terminal anyone opens is noise in the report it exists for.
      const held =
        this.shadows.get(options.persistKey)?.alive ||
        (this.shared?.persistKey === options.persistKey && this.shared.client.alive)
      if (held) console.log(`[pty] painter attach ${sessionName(options.persistKey)}`)
      this.shadowDispose(options.persistKey)
      this.sharedDisposeOn(options.persistKey)
    }
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
    // COLORTERM is the truecolor handshake half the ecosystem checks before emitting 24-bit
    // SGR (the other half asks tmux/terminfo). xterm.js renders truecolor natively, so
    // advertise it — without this, zsh themes and TUIs quietly clamp to the 256 palette and
    // the canvas terminals never match the user's real terminal colors (issue #78).
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    // The Server Edition may receive a first-boot password through its own environment. That
    // bootstrap credential belongs to the server process, never to the interactive shells and
    // agent CLIs it launches; inheriting it here would expose it to every terminal node.
    delete env.NODETERM_SERVER_PASSWORD
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
    // wait-branch for permission-mode-capable sessions when the setting is on. `permWaitSecs > 0`
    // injects NODETERM_PERM_WAIT_SECS; off / non-capable ⇒ 0 ⇒ absent ⇒ legacy behavior.
    const permWaitSecs =
      this.getSettings().hookReplyApprovals && hasPermissionMode(options.agentId ?? 'claude')
        ? PERM_WAIT_SECS_DEFAULT
        : 0
    // Materialise this node's token BEFORE the session exists, so the very first hook event the
    // agent fires can already read it. Local sessions only: a remote node's token is written on the
    // HOST (see remote-hooks), because the host is where its hook script runs.
    if (options.persistKey && !options.sshRemote) ensureNodeToken(options.persistKey)
    const hookEnv =
      options.persistKey && !options.sshRemote
        ? hookServer.buildPtyEnv(options.persistKey, options.agentId, permWaitSecs)
        : {}
    for (const [k, v] of Object.entries(hookEnv)) env[k] = v

    // Shared-identity agents (SHARED_IDENTITY_CAPABLE — never `agentId === 'codex'`) reach their
    // managed launcher by NAME, so its directory goes first on THIS session's PATH only. A plain
    // terminal, and every other agent, sees the PATH it always saw. The launcher itself falls back
    // to the bare CLI, so a session that gets the PATH but no identity is still a working session.
    if (options.agentId && hasSharedIdentity(options.agentId as AgentId) && !options.sshRemote) {
      env.PATH = `${codexLauncherDir()}${path.delimiter}${env.PATH ?? ''}`
    }

    // Managed Claude account: the whole session runs under the account's private config
    // dir. The claude CLI then reads/writes credentials + transcripts there. Also strip
    // env auth vars that would silently shadow the account's OAuth login (an inherited
    // ANTHROPIC_API_KEY wins over CLAUDE_CONFIG_DIR credentials). System-default nodes
    // (no accountId) set nothing HERE — but they are not "untouched" on the tmux leg:
    // CLAUDE_CONFIG_DIR is in ACCOUNT_SCOPE_UPDATE_ENV, so a client whose env lacks it makes
    // tmux STRIP it from the new session, which is what keeps a server seeded by a managed
    // account's client from leaking that account into every unbound session (#419). The
    // missing-dir fallback below rides the same rule: accountDir nulled ⇒ no env var ⇒ the
    // session genuinely lands on `~/.claude`, not on whatever the server global env held.
    // Remote (ssh) sessions get their account env via the remote tmux `-e` list instead
    // (the local ssh client process doesn't need it).
    let accountFallback = false
    let accountDir =
      options.accountId && !options.sshRemote ? claudeConfigDirFor(options.accountId) : null
    // Missing/deleted account dir (spec: error handling) → fall back to system default
    // instead of pointing claude at a dead dir; the node then behaves like an unbound one.
    // `accountFallback` is surfaced to the renderer (warning chip) via the create() result.
    if (accountDir && !fs.existsSync(accountDir)) {
      console.warn(`[accounts] config dir missing for ${options.accountId}, using system default`)
      accountDir = null
      accountFallback = true
    }
    if (accountDir) {
      env.CLAUDE_CONFIG_DIR = accountDir
      for (const k of AUTH_ENV_STRIP) delete env[k]
    }

    // Managed/system Codex account scope (S6 §2.1). A LOCAL Codex session runs under an EXPLICIT
    // CODEX_HOME + NODETERM_CODEX_ACCOUNT_ID: a managed id points at that account's private home
    // (its own auth.json + thread DB); the SYSTEM account (no id) is written EXPLICITLY so it
    // overwrites any managed scope a parent tmux server leaked in, rather than silently acting as
    // the wrong login. Note this write lands on the CLIENT env — on a shared tmux server it only
    // reaches the session because both names are in ACCOUNT_SCOPE_UPDATE_ENV (before that, the
    // overwrite-the-leak promise held only for the client that happened to START the server; #419).
    // The missing-explicit-account case already refused in spawnNew (fail-closed,
    // property 4), so `codexSessionEnv` here never resolves an explicit id to the system home. Also
    // strip env vars that would shadow the account's OAuth login with API-key auth.
    if (needsCodexAccountScope(options.agentId, options.accountId, (id) => this.isCodexAccount(id)) && !options.sshRemote) {
      const codexScope = codexSessionEnv(platform().userDataDir, options.accountId)
      env.CODEX_HOME = codexScope.CODEX_HOME
      env.NODETERM_CODEX_ACCOUNT_ID = codexScope.NODETERM_CODEX_ACCOUNT_ID
      for (const k of CODEX_AUTH_ENV_STRIP) delete env[k]
    }

    // Shared model gateway: resolve through the node's BASE harness in one shared mapping, then
    // apply it before custom-agent env. That precedence is intentional: an inheriting custom agent
    // benefits from the one-click gateway by default, but env values it explicitly declares still
    // win exactly as they did before this feature. Remote values travel through tmux `-e` below;
    // do not leak them into the local ssh client process environment.
    // A plain terminal has no agentId and must never receive provider credentials. The hook env's
    // historical Claude fallback does not apply here: gateway access is an explicit agent
    // capability, not a terminal default.
    const gatewayEnv = options.agentId
      ? modelGatewayEnv(
          this.getSettings().modelGateway,
          options.agentId,
          options.agentModel,
          process.env as Record<string, string | undefined>,
          this.getModelGatewaySecret()
        )
      : {}
    if (!options.sshRemote) {
      for (const [k, v] of Object.entries(gatewayEnv)) env[k] = v
    }

    // The OWNING project's env (`.nodeterm/settings.json`, local overlay + TRUSTED shared half —
    // the gate is in `makeProjectSpawnOverrides`, never here). Placed between the gateway and the
    // custom agent on purpose: a project may point its terminals at its own tooling, and a
    // per-agent config the user wrote for THIS agent still beats it on a key collision.
    //
    // LITERAL values only: no `${env:VAR}` expansion. That is a custom-agent feature and a
    // settings.json is git-shared hostile input — expanding it would turn an approved-looking
    // literal into a read of this machine's process environment. The keys/values are already
    // bounded and identifier-shaped by the settings sanitizer.
    // RESERVED KEYS are dropped here, before either leg reads `projectEnv` — one filter, applied
    // once, so the local merge below and the ssh `remoteEnvPairs` join further down cannot drift
    // apart. Consent is not the gate for these: it proves a human saw the pairs, not that they
    // understood a git-shared file was out-ranking the auth-strip / account / hook layers that
    // exist to control exactly those names. See `isReservedSpawnEnvKey`.
    const projectEnv = overrides?.env
      ? Object.fromEntries(
          Object.entries(overrides.env).filter(([k]) => !isReservedSpawnEnvKey(k))
        )
      : undefined
    if (!options.sshRemote && projectEnv) {
      for (const [k, v] of Object.entries(projectEnv)) env[k] = v
    }

    // Custom-agent env: merged LAST so it wins over hook + account + PATH/LANG env (required for
    // the proxy use case — the user's ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL must beat whatever
    // the account path set). ${env:VAR} is expanded against the live process env. Only the LOCAL
    // path merges into `env` here; the remote (ssh) path threads the same vars into the tmux `-e`
    // list below (the local ssh client's env does not propagate to the remote tmux session).
    let customEnvMerged: Record<string, string> = {}
    if (!options.sshRemote) {
      const custom = findCustomAgent(this.getSettings().customAgents, options.agentId ?? '')
      const merged = applyCustomAgentEnv(env, custom, process.env as Record<string, string | undefined>)
      for (const [k, v] of Object.entries(merged.env)) env[k] = v
      for (const w of merged.warnings) console.warn(w)
      customEnvMerged = merged.env
    }

    const settings = this.getSettings()
    let file: string
    let args: string[]
    // Set true only by the session-host branch below. Decides which of the two `proc =` paths
    // runs further down — see there for why this can't just be "no local tmux was found" (a
    // remote/ssh node must never fall into it, and neither may a node with no persistKey at all).
    let useSessionHost = false
    let attachExistingHost = false
    // Unlike the installed-binary probe, this records the backend selected for THIS generation.
    // A Windows profile may coexist with an MSYS/Cygwin tmux on PATH and must not inherit it.
    let useLocalTmux = false

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
    //
    // PRECEDENCE: the NODE's own `options.shell` wins outright — it is the exec-trusted value
    // @shared/node-exec already vouched for, and a node that names its program means it. Only when
    // it names none does the owning project's shell apply (local overlay, or a shared value the
    // trust gate admitted). `??` deliberately reads the node's value BEFORE validation, so an
    // unsafe node shell degrades to the default shell rather than silently falling through to the
    // project's — the caller asked for a specific program and did not get the project's instead.
    // Validation covers both sources: a project settings.json is git-shared (and on an SSH project
    // it lives on the remote HOST), i.e. exactly the foreign provenance this check exists for.
    const reqShell = safeSessionProgram(options.shell ?? overrides?.shell)
    const program = reqShell === 'ssh' ? findSsh() ?? 'ssh' : reqShell
    const programArgs = options.shellArgs ?? []
    // One resolver for BOTH direct node-pty and the persistent session-host backend, so the two
    // paths cannot drift on "which shell" (see resolveLocalSessionShell).
    const localSessionShell = resolveLocalSessionShell(program, settings.defaultShell)
    const localSessionArgs = program ? programArgs : []

    // SSH project node: run `ssh -t '<remote tmux attach-or-create>'` as the PTY program. The
    // REMOTE tmux provides persistence (over the project's ControlMaster); the local PTY just
    // holds the ssh client. Only when BOTH sshRemote and persistKey are set and ssh resolves —
    // otherwise this falls through to the unchanged local-tmux / plain-shell branches below.
    const remoteSsh = options.sshRemote && options.persistKey ? findSsh() : null
    if (options.sshRemote && options.persistKey && remoteSsh) {
      file = remoteSsh
      // The remote twin of the local `ensureNodeToken` above: materialise THIS node's token on the
      // host before the attach. The connect path writes one for every node the canvas had AT
      // CONNECT; a node created afterwards would otherwise wait for the next reconnect — for a
      // long-lived SSH project, forever — and spend that whole time on `legacy`.
      // Fire-and-forget and fail-open by construction (see ensureRemoteNodeToken): the hook script
      // re-reads the file at every event, so a token that lands a moment after the attach is in
      // time for everything that matters, and one that never lands costs only the verified label.
      ensureRemoteNodeToken(options.sshRemote.controlPath, options.persistKey)
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
              // Plain terminals carry no agent identity or control grant. An explicit agent node
              // matches the local `buildPtyEnv` path exactly.
              options.agentId
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
      // Custom-agent env for a REMOTE node: expand ${env:VAR} against the LOCAL process env (the
      // key stays local; only the resolved VALUE travels over SSH). PATH is skipped — the local
      // machine can't see the remote box's PATH, so a locally-resolved PATH would break CLI
      // resolution on the host (recovering it is out of scope). Applied AFTER the account env so
      // custom env still wins, mirroring the local path.
      const remoteCustom = findCustomAgent(this.getSettings().customAgents, options.agentId ?? '')
      const remoteCustomEnv = customAgentEnvArgs(
        remoteCustom,
        process.env as Record<string, string | undefined>,
        { skipPath: true }
      )
      for (const w of remoteCustomEnv.warnings) console.warn(w)
      // Gateway + custom env VALUES never touch an argv (the old `-e KEY=VALUE` route parked the
      // gateway API key on the local ssh client's command line for the whole session — the PR #195
      // leak class, on the machine AND on the remote process table at creation). They ride a 0600
      // per-session file staged over the ControlMaster; the remote command sources + deletes it,
      // and the remote conf's `update-environment` copies the names into the session env. Gated on
      // the validated remote $HOME and on a wired uploader — absent either, the vars are simply
      // not delivered and the agent fails loudly in its pane (fail-open, never a fallback to argv).
      // The project's env joins that same 0600 file — same reason, same ordering as the local leg
      // (gateway, then project, then the custom agent's own values on top).
      const remoteEnvPairs: Record<string, string> = { ...gatewayEnv, ...(projectEnv ?? {}) }
      for (const kv of remoteCustomEnv.args) {
        const eq = kv.indexOf('=')
        if (eq > 0) remoteEnvPairs[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
      let remoteSessionEnv: RemoteSessionEnv | undefined
      if (
        Object.keys(remoteEnvPairs).length &&
        options.sshRemote.remoteHome &&
        remoteSessionEnvAvailable()
      ) {
        const envFile = remoteSessionEnvPath(
          options.sshRemote.remoteHome,
          sessionName(options.persistKey)
        )
        stageRemoteSessionEnv(
          options.sshRemote.controlPath,
          envFile,
          sessionEnvFileContent(remoteEnvPairs)
        )
        const baked = new Set<string>(MODEL_GATEWAY_ENV_KEYS)
        remoteSessionEnv = {
          file: envFile,
          extraKeys: Object.keys(remoteEnvPairs).filter((k) => !baked.has(k))
        }
      } else if (Object.keys(remoteEnvPairs).length) {
        console.warn(
          '[pty] remote session env skipped (no remote home or no uploader) — agent will launch without gateway/custom env'
        )
      }
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
        options.sshRemote.tmuxConfPath,
        remoteSessionEnv
      )
    } else if (warmWindowsBackend === 'session-host') {
      useSessionHost = true
      attachExistingHost = true
      file = ''
      args = []
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
      useLocalTmux = true
      if (warmWindowsBackend === 'tmux') {
        // Attach-only is the critical distinction from `new-session -A`: if the proven warm
        // generation disappears in this window, tmux rejects instead of cold-spawning a shell
        // from options that deliberately skipped trusted profile resolution.
        args = [
          '-L',
          TMUX_SOCKET,
          '-f',
          this.confPath,
          'attach-session',
          ...(sinks ? [] : ['-d']),
          '-t',
          sessionName(options.persistKey)
        ]
      } else {
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
      // And for COLORTERM: panes read the SESSION env, not the client's, so the truecolor
      // handshake must ride `-e` to reach programs on a shared/stale server (issue #78).
      const colortermEnvArgs = ['-e', 'COLORTERM=truecolor']
      // The account config dir must ride `-e` like the hook env: the tmux server is shared
      // and long-lived, so session env comes from creation args, not client inheritance.
      const accountEnvArgs = accountDir ? accountTmuxEnvArgs(accountDir) : []
      // Gateway env deliberately has NO `-e` pairs: the values are in this tmux CLIENT's process
      // environment (merged above) and the conf's `update-environment` list copies them into the
      // session at create/attach — measured on tmux 3.4, including the removal case (a plain
      // terminal's client lacks the vars, so tmux strips them from its session even on a server
      // another node's env seeded). `-e KEY=VALUE` parked the API key on the long-lived attached
      // client's argv — world-readable in /proc/<pid>/cmdline on a multi-user host, the exact
      // PR #195 leak class. Custom-agent env keys OUTSIDE the baked gateway list still need the
      // option appended at runtime on a shared server (the conf assignment cannot know them):
      // The project's keys need the same treatment for the same reason: their VALUES are in this
      // tmux client's process env (merged above) and must reach the session without ever appearing
      // on the long-lived client's argv.
      // The account-scope names lead the list for the LONG-LIVED server case (#419): the conf is
      // read once at server start, so a server started by a pre-fix app keeps its old
      // update-environment array forever — these appends are what retrofit it before this
      // session is created. A fresh server already has them from the conf (the append dedupes).
      this.ensureUpdateEnvKeys([
        ...ACCOUNT_SCOPE_UPDATE_ENV,
        ...Object.keys(customEnvMerged),
        ...Object.keys(projectEnv ?? {})
      ])
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
        ...colortermEnvArgs,
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
      }
    } else if (
      !options.sshRemote &&
      options.persistKey &&
      settings.tmuxEnabled &&
      sessionHostSupported()
    ) {
      // `file`/`args` are left unused: the real spawn happens INSIDE the session-host process, driven by
      // the `SessionHostPty` constructed below, not by a `pty.spawn()` in this one.
      useSessionHost = true
      file = ''
      args = []
    } else {
      // `process.env.SHELL` is a POSIX-only convention (unset on Windows outside a POSIX
      // subsystem), so it never wins the win32 branch anyway — the ordering below just says so
      // explicitly instead of relying on it being empty there.
      file = localSessionShell
      args = localSessionArgs
    }

    let proc: pty.IPty
    if (useSessionHost) {
      // Cast to the small `IPty` subset this file actually touches — see `SessionHostPty`'s own
      // doc comment for exactly what it implements and why that is enough. Its constructor kicks
      // off the attach-or-create round trip asynchronously and never throws synchronously (a
      // rejection surfaces on `.ready`, awaited by `spawnNew` — see there for how a failure
      // degrades rather than blocking the create).
      // `resolveLocalSessionShell`, NOT a bare `|| 'bash'`.
      //
      // This branch exists BECAUSE the platform has no tmux — which in practice means Windows —
      // and it was defaulting to a POSIX shell that does not exist there. The host dutifully tried
      // to spawn `bash`, node-pty answered `File not found:`, and the attach rejected. Everything
      // downstream then hid it: the rejection was swallowed by a bare catch, `persistent` was
      // derived from the path chosen rather than the outcome, and the renderer fell back to a
      // plain shell. So every terminal on Windows looked fine and silently did not survive a
      // restart — the one thing this whole backend is for.
      //
      // The non-session-host branch above already resolves this correctly. Sharing that logic is
      // the fix; two places deciding "which shell" is what let them disagree.
      proc = (attachExistingHost
        ? attachExistingSessionHostPty(sessionName(options.persistKey as string))
        : createSessionHostPty(
            sessionName(options.persistKey as string),
            {
              cwd,
              shell: localSessionShell,
              args: localSessionArgs,
              env,
              cols: options.cols,
              rows: options.rows
            },
            settings.tmuxScrollback
          )) as unknown as pty.IPty
    } else {
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
        // Two different field causes wear that same message, so BOTH are measured before anything is
        // said: a cross-arch `electron-builder --x64` run clobbering node-pty's spawn-helper (arm64
        // app can't exec an x86_64 helper), and the machine being out of pty DEVICES
        // (`kern.tty.ptmx_max`, 2026-08-11 — 515 `/dev/ttys*` against a ceiling of 511).
        const reason = err instanceof Error ? err.message : String(err)
        // Re-read the devices rather than reusing the pre-flight's reading: this spawn just consumed
        // (and, per the leak above, kept) devices of its own, so the number the user is shown should
        // be the one that was true when the failure happened.
        throw this.spawnFailureError(reason, file, cwd, spawnHelperArchMismatch(), readPtyDevices())
      }
    }

    // tmux-backed sessions snapshot their scrollback to disk periodically so a machine reboot
    // (which kills the tmux server) can still replay recent output on cold restart. A remote
    // (ssh-project) node is persisted too — the snapshot is captured from the REMOTE tmux.
    // Mark the session remote ONLY when the remote branch above actually ran (`remoteSsh` resolved).
    // If ssh is missing, the node fell through to a LOCAL tmux/plain spawn, so it must NOT be
    // marked remote — otherwise destroy/capture would target a remote tmux that was never spawned
    // and silently leak the local session.
    const remote = options.sshRemote && options.persistKey && remoteSsh ? options.sshRemote : undefined
    const tmuxBacked = useLocalTmux
    // `useSessionHost` is exactly "did the branch selection above pick the session-host backend",
    // so it needs no re-derivation here — session-host-backed sessions survive losing their
    // client exactly like tmux-backed ones do, for the same reason: the underlying pty lives in a
    // separate process (the session host), not in this one.
    const persisted = !!options.persistKey && (remote ? true : tmuxBacked || useSessionHost)
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
      // `persisted` IS "a tmux session (local or remote) is holding this work" — the same condition
      // that gates the scrollback snapshots. Recorded under its own name because the reap decision
      // asks a different question of it: not "is it worth snapshotting" but "would releasing this
      // pty client destroy anything" (pty-reap.ts).
      tmuxBacked: persisted,
      unwatchedSince: null,
      pausedBy: new Set<string>(),
      accountFallback,
      sessionHost: useSessionHost
    }
    // Both shared timers are armed by the first session that needs them: the scrollback snapshots
    // and the idle reap are both about tmux-backed sessions and nothing else.
    if (persisted) {
      this.ensureSnapshotTimer()
      this.ensureReapTimer()
    }
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
    // A session-host record is provisional until its async attach succeeds. spawnNew() clears the
    // tombstone after ready so a failed resurrection cannot silently remove deletion protection.
    if (session.indexKey && !session.sessionHost) this.tombstones.delete(session.indexKey)
    // The replacement session for a RECYCLED node (worktree move) is now live and indexed, so its
    // co-viewers can safely be told to restart: their create() will `join` THIS session instead of
    // spawning `nt-<nodeId>` from their own (stale) cwd. This is the whole reason the notice waits.
    // A session-host shim is only provisional until its asynchronous `ready` settles. spawnNew()
    // fires this notice after that barrier; publishing here would wake co-viewers onto a dead id.
    if (session.indexKey && !session.sessionHost && this.pendingRecycle.has(session.indexKey))
      this.fireRecycled(session.indexKey, true)

    proc.onData((data) => {
      // A session-host attach can fail after the shim has already delivered startup bytes. Once
      // rollback removes this exact generation, late callbacks must not recreate its flush timer
      // or leak bytes into a replacement that happens to reuse the same node id.
      if (this.sessions.get(sessionId) !== session) return
      this.queueData(sessionId, session, data)
    })

    proc.onExit(({ exitCode }) => {
      // The persistent host broadcasts exit before it answers killSession. The confirmed profile
      // switch must await that acknowledgement before mutating the local index/subscribers, so the
      // exact in-flight generation's early exit is consumed by the transaction instead of racing
      // cleanup ahead of the response. Success cleans it below; rejection leaves it untouched.
      const confirmedEnd = this.confirmedBackendEnds.get(sessionId)
      if (confirmedEnd?.session === session) {
        confirmedEnd.exitCode = exitCode
        confirmedEnd.resolveExit?.()
        return
      }
      this.handleSessionExit(sessionId, session, exitCode)
    })

    if (useSessionHost) {
      ;(proc as unknown as SessionHostPty).onAttachError((error) => {
        // Reconnect replay can be rejected after this generation was already returned to the
        // renderer. Retire only the exact remembered generation; a late callback from an older
        // shim must never take down its replacement.
        if (this.sessions.get(sessionId) !== session) return
        const safeReason = /^(?:no existing session|session '[A-Za-z0-9._-]+' is ending|unauthorized|no such session)/i.test(
          error.message
        )
          ? error.message
          : 'the persistent session host rejected the reattach'
        this.queueData(
          sessionId,
          session,
          `\r\n[nodeterm] Persistent terminal reattach failed: ${safeReason}\r\n`
        )
        this.handleSessionExit(sessionId, session, 1)
      })
    }

    // Detached relay callers cannot await SessionHostPty.ready because their long-standing API
    // returns a session id synchronously. They still must not retain a zombie Session: retire it
    // and surface an ordinary non-zero exit to the sink if the asynchronous attach fails.
    if (useSessionHost && sinks) {
      void (proc as unknown as SessionHostPty).ready.catch(() => {
        if (this.sessions.get(sessionId) !== session) return
        this.discardFailedSpawn(sessionId, session)
        try {
          sinks.onExit(1)
        } catch {
          // A consumer callback cannot resurrect the already-retired provisional Session, and a
          // throw here must not become an unhandled rejection from this deliberately detached task.
        }
      })
    }

    return sessionId
  }

  /** Park a recycled session's co-viewers until the replacement session shows up (or the timeout
   *  fires). One entry per node: a second recycle before the first resolved supersedes it — the
   *  earlier waiters are folded in, since their session is just as dead. */
  private armRecycle(
    persistKey: string,
    sessionId: string,
    clients: ClientId[],
    owner: ClientId | null,
    target?: PtyRecycleTarget
  ): void {
    const prev = this.pendingRecycle.get(persistKey)
    const waiters = prev?.waiters ?? []
    if (prev) {
      clearTimeout(prev.timer)
      for (const c of prev.clients) clients.push(c)
    }
    this.pendingRecycle.set(persistKey, {
      sessionId,
      clients: new Set(clients),
      owner: owner === null ? null : subKey(owner, PRIMARY_VIEWER),
      ...(target ? { target } : {}),
      waiters,
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
    if (ready) {
      // The exact replacement is registered and ready; replay each parked create through the
      // ordinary path so it co-attaches and gets the same screen/size semantics as any joiner.
      for (const waiter of entry.waiters)
        void this.create(waiter.clientId, waiter.options).then(waiter.resolve, waiter.reject)
    } else {
      const error = new Error('The replacement terminal did not become ready. Reopen it to try again.')
      for (const waiter of entry.waiters) waiter.reject(error)
    }
  }

  /** Drop a dead/released session from both indexes. Keyed off `indexKey` (not `persistKey`,
   *  which is only set for tmux-PERSISTED sessions) so a plain-shell node is un-indexed too. */
  private forget(sessionId: string, session: Session): void {
    this.sessions.delete(sessionId)
    if (session.indexKey && this.byPersistKey.get(session.indexKey) === sessionId)
      this.byPersistKey.delete(session.indexKey)
  }

  /** Apply an ordinary process exit for one exact session generation. Kept separate so a
   * confirmed backend kill whose response is lost can replay the exit it deferred: in that case
   * the process really ended, but the profile switch still rejects and never respawns/applies. */
  private handleSessionExit(sessionId: string, session: Session, exitCode: number): void {
    if (this.sessions.get(sessionId) !== session) return
    this.flush(sessionId, session) // deliver any buffered output before the exit signal
    session.onExit?.(exitCode) // relay host sink (unchanged)
    for (const client of this.clientsOf(session))
      this.send(client, IPC.ptyExit(sessionId), exitCode)
    this.forget(sessionId, session)
  }

  /** Roll back the provisional Session installed before a session-host attach settles. Unlike a
   * normal release, this records no shadow/released-session metadata and takes no snapshot: there
   * was never a confirmed live session to preserve. */
  private discardFailedSpawn(sessionId: string, session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    session.buf = []
    session.bufBytes = 0
    session.subscribers.clear()
    session.sizes.clear()
    session.shown.clear()
    session.pausedBy.clear()
    // Do not use releasePty here: its defensive resume would issue a fresh host request from a
    // shim whose attach just failed. SessionHostPty.destroy() is the exact detach/unsubscribe.
    const hostPty = session.proc as unknown as SessionHostPty
    hostPty.destroy()
    this.forget(sessionId, session)
    const remaining = [...this.sessions.values()]
    if (!remaining.some((candidate) => candidate.persistKey) && this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
    if (!remaining.some((candidate) => candidate.tmuxBacked) && this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
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
    if (!session) return this.backgroundWriteBySessionId(sessionId, data)
    if (clientId !== null && session.nodeId && presenceHub.peerCount() > 1)
      presenceHub.noteTyping(clientId, session.nodeId)
    session.proc.write(data)
  }

  /**
   * The `write()` miss: no live session answers to this id. It may still be a session THIS process
   * released — the pty client detached, the tmux session (and everything running in it) untouched —
   * whose id a caller is still holding, which is what the relay host does for the lifetime of a
   * stream. Those bytes used to go on the floor; now they take the background path, which reaches
   * the node without respawning a pty client for it.
   *
   * A linear scan rather than a second index: the `released` map is one small record per node this
   * process has released, this is the cold path (a stray write, not a keystroke stream), and two
   * maps that have to agree about the same fact is precisely the shape of bug the session-budget
   * subtraction already had to be fixed for once.
   *
   * Fire-and-forget, because `write()` is: `backgroundWrite` never rejects, and there is nobody to
   * report a delivery failure to on this path. No typing badge either — a released session is one
   * nobody is watching, so the badge would light up on a terminal that is not on anybody's screen.
   */
  private backgroundWriteBySessionId(sessionId: string, data: string): void {
    for (const [persistKey, rec] of this.released) {
      if (rec.sessionId !== sessionId) continue
      void this.backgroundWrite(persistKey, data)
      return
    }
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
    // Nobody is left: detach this process's pty client (the tmux session keeps running, as always).
    // Shared with the idle reap — see `releaseClient`.
    this.releaseClient(sessionId, session)
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
    const live = this.liveSessionForPersistKey(persistKey)
    // Remote (ssh-project) node: there is no local tmux session — capture from the REMOTE tmux
    // over the project's ControlMaster (mirrors snapshotScrollback / destroySession).
    const sshRemote = live?.sshRemote
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
    // Backend choice belongs to the live generation, not to whichever binaries happen to be on
    // PATH. A native Windows profile remains session-host-backed beside an MSYS/Cygwin tmux.
    if (live?.sessionHost || !this.tmuxPath) {
      return this.getSettings().tmuxEnabled && sessionHostSupported()
        ? sessionHostCapture(sessionName(persistKey), full)
        : ''
    }
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
    // `true` (full scrollback, same cap the emulator was built with): unlike tmux's plain-pane
    // capture, this backend has no separate mechanism for the user to scroll a live session's
    // history (there is no tmux underneath to own the wheel — see docs/windows-session-host.md),
    // so a joiner is seeded generously rather than with just the visible rows.
    if (session.sessionHost) return sessionHostCapture(sessionName(key), true)
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
      if (session.sessionHost) return undefined
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
    sshRemote?: NonNullable<PtyCreateOptions['sshRemote']>,
    sessionHost = false
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
    // No local tmux: this is a session-host-backed session (only that backend reaches this
    // periodic snapshot loop at all — see `snapshotTick`'s `session.persistKey` gate). Same
    // "cold-restore across a machine reboot" purpose as the tmux capture below; see
    // docs/windows-session-host.md §7 for the honest limitation this snapshot exists to soften
    // (the session-host process itself does NOT survive a reboot, unlike a real tmux server).
    if (sessionHost || !this.tmuxPath) {
      if (!this.getSettings().tmuxEnabled || !sessionHostSupported()) return false
      try {
        const text = await sessionHostCapture(sessionName(persistKey), true)
        if (text) await writeScrollback(persistKey, text)
        return true
      } catch {
        return false
      }
    }
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
   * remote counterpart instead (`remoteTmuxPasteArgs`, over the project's ControlMaster),
   * mirroring how `remoteSessionExists` reuses `findSsh()` + `runAsync`. A node with no live
   * session at all (nothing mounted right now) still falls through to the local path and returns
   * false there, same as before this change — reaching a currently-unmounted SSH node's remote
   * session is not supported.
   *
   * ── DELIVERY: TMUX FRAMES THE PASTE, WE DO NOT ─────────────────────────────────────────────────
   *
   * Both paths are now one `tmux load-buffer - ; … ; paste-buffer -d -p -r ; send-keys Enter`
   * invocation with the payload on STDIN. `localTmuxPasteArgs` carries the whole measurement: the
   * old `#{bracket_paste_flag}` probe needed tmux 3.7 and, on every older tmux, quietly delivered
   * raw newlines into the app instead of a paste; `paste-buffer -p` asks the pane itself and has
   * done since tmux 1.7.
   *
   * ── WHY THIS METHOD IS ONLY A DISPATCHER ───────────────────────────────────────────────────────
   *
   * Everything decided per write — `sanitizePasteText`, the empty-body case, the per-call buffer
   * name, and the buffer sweep when the paste fails — lives in `localPasteDelivery` /
   * `remotePasteDelivery` / `runPasteDelivery`, which a real-tmux test drives DIRECTLY.
   *
   * That is a correction, not a preference. The first version of this change inlined those
   * decisions here and let the test rebuild them in its own helper. Both sides were green and two
   * mutations survived a full run: deleting the empty-body branch, and deleting the sanitize call.
   * A test that re-implements what it is testing cannot notice the original being removed. So the
   * composition is exported, both callers use it, and the only thing left in this method is which
   * transport runs it.
   */
  async sendText(persistKey: string, text: string, opts?: { enter?: boolean }): Promise<boolean> {
    const enter = opts?.enter ?? true
    const target = sessionName(persistKey)
    const live = this.liveSessionForPersistKey(persistKey)
    const sshRemote = live?.sshRemote
    try {
      if (sshRemote) {
        const ssh = findSsh()
        if (!ssh) return false
        const plan = remotePasteDelivery(sshRemote.conn, sshRemote.controlPath, target, text, enter)
        if (!plan) return true
        return await runPasteDelivery(plan, (args, input) => runWithStdin(ssh, args, input))
      }
      // No local tmux: this machine persists sessions via the session-host backend instead (see
      // docs/windows-session-host.md). Its `sendKeys` needs no attached client, exactly like
      // tmux's own `send-keys -t <name>` — the host looks the session up by NAME.
      if (live?.sessionHost || !this.tmuxPath) {
        return this.getSettings().tmuxEnabled && sessionHostSupported()
          ? sessionHostSendKeys(target, text, enter)
          : false
      }
      const tmuxPath = this.tmuxPath
      const plan = localPasteDelivery(TMUX_SOCKET, target, text, enter)
      if (!plan) return true
      return await runPasteDelivery(plan, (args, input) => runWithStdin(tmuxPath, args, input))
    } catch {
      // Only a builder throwing (an unsafe target) reaches here — `runPasteDelivery` answers false
      // rather than throwing, precisely so the sweep cannot be skipped by an early exit.
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
    const live = this.liveSessionForPersistKey(persistKey)
    const sshRemote = live?.sshRemote
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
    // No local tmux: ask the session-host backend's own `#{pane_current_command}` equivalent (a
    // descendant-process walk — see process-tree.ts for the imprecision that carries).
    if (live?.sessionHost || !this.tmuxPath) {
      return this.getSettings().tmuxEnabled && sessionHostSupported()
        ? sessionHostPaneCommand(target)
        : null
    }
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
   * Terminate the foreground agent process group in a node's tmux pane without writing anything
   * into the terminal. This is intentionally narrower than recycling the session: model switching
   * first stops the harness by PID, then uses the existing recycle path to rebuild the shell with
   * current gateway environment.
   *
   * `expectedAgentId` is the IDENTITY GATE. Refusing a shell (the old contract) is not enough: a
   * model switch fires from a possibly-stale menu, and hours after the agent exited the pane may
   * belong to vim, a build, or an ssh the user started — none of which should be SIGTERM'd. When an
   * expected id is given, the foreground group's full argv is read (`paneOwner`) and the kill
   * happens ONLY when `isAgentPane` confirms the expected harness owns the group; `not-agent` and
   * `unknown` both refuse (fail-closed — we are about to send a signal). Omitting the id preserves
   * the legacy shell-only guard for any caller that has no agent to assert.
   */
  async terminateForeground(persistKey: string, expectedAgentId?: string): Promise<boolean> {
    if (typeof persistKey !== 'string' || !persistKey || persistKey.length > REF_MAX_LEN) return false
    // Identity gate: prove the expected harness owns the foreground group before signalling it.
    // `paneOwner` reads the full argv (local or over the project's ControlMaster) and is null on
    // any uncertainty, which `isAgentPane` maps to `unknown` → refuse.
    if (expectedAgentId) {
      const owner = await this.paneOwner(persistKey)
      // Pass the custom-agent list so a `custom:<uuid>` harness is verifiable by its launchCmd
      // binary instead of collapsing to `unknown` (which would fail-closed on every model switch).
      const binaries = binariesFor(expectedAgentId, this.getSettings().customAgents)
      if (isAgentPane(owner, expectedAgentId, binaries) !== 'agent') return false
    }
    const target = sessionName(persistKey)
    const sshRemote = this.sessionByPersistKey(persistKey)?.sshRemote
    try {
      if (sshRemote) {
        const ssh = findSsh()
        if (!ssh) return false
        const { stdout } = await runAsync(
          ssh,
          remotePaneProcessArgs(sshRemote.conn, sshRemote.controlPath, target)
        )
        const pane = parsePaneProcess(stdout)
        if (!pane || isShellCommand(pane.command)) return false
        await runAsync(
          ssh,
          remoteTerminateForegroundArgs(sshRemote.conn, sshRemote.controlPath, pane.panePid)
        )
        return true
      }
      if (!this.tmuxPath) return false
      const { stdout } = await runAsync(this.tmuxPath, [
        '-L',
        TMUX_SOCKET,
        'display-message',
        '-p',
        '-t',
        target,
        '#{pane_pid}|#{pane_current_command}'
      ])
      const pane = parsePaneProcess(stdout)
      if (!pane) return false
      const processTable = await runAsync('ps', ['-o', 'tpgid=', '-p', String(pane.panePid)])
      const processGroup = foregroundProcessGroup(pane, processTable.stdout)
      if (!processGroup) return false
      process.kill(-processGroup, 'SIGTERM')
      // Grace: give the harness a window to flush session state (transcript, --resume id) before
      // the caller recycles the session (tmux kill-session). Poll the group with signal 0 —
      // ESRCH means it is gone — up to ~1.5s, then return regardless (the recycle is a kill either
      // way; this only improves resume fidelity for an agent that exits promptly on SIGTERM).
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(-processGroup, 0)
        } catch {
          break // ESRCH: the group has exited
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * WHO owns a node's pane right now, read from the kernel: the pane's pid and tty from tmux, then
   * the full argv of the tty's FOREGROUND PROCESS GROUP. `paneCommand` above answers one name —
   * `node`, for every npm-installed agent CLI — which is not enough to decide whether a message may
   * be delivered into a pane. This is (see `src/core/agents/pane-owner.ts` for the measurement).
   *
   * Mirrors `paneCommand`'s dispatch exactly, including the SSH branch over the project's
   * ControlMaster, and its failure contract exactly: no live session, no tmux, no ssh, a throw, an
   * empty read, a `ps` that lists nothing, an unsafe tty — every one of them answers `null` rather
   * than throwing or returning a partial object, because unknown is never evidence of a particular
   * command. Deliberately has NO deadline of its own: the caller bounds it (`probeWithin`), the
   * same way the restart poll bounds `paneCommand`.
   *
   * LOCALLY two round-trips, not one: tmux does not know the foreground process group
   * (`#{pane_pid}` is the shell it forked, which is usually NOT in it), so the tty has to come
   * back before `ps` can be asked about it — and two local execFiles cost nothing. The SSH leg is
   * ONE round-trip (`remotePaneOwnerCombinedArgs`, issue #460): there each exec is an `ssh` child
   * that outlives the caller's 2s deadline (reaped at `PROC_TIMEOUT_MS`) and becomes a full LOGIN
   * whenever the master cannot serve a channel, so a caller that retries `unknown` on a short
   * timer stacks them. See `agents/pane-probe.ts` for why that needs a circuit breaker rather
   * than a shorter timeout.
   *
   * `remotePaneOwnerCombinedArgs` splices the session id unquoted (`-t ${sessionId}`), exactly as every
   * sibling builder does. That is safe only because `sessionName()` sanitises to `[A-Za-z0-9_-]`
   * before it ever gets here — the guarantee lives THERE, not in this call.
   */
  async paneOwner(persistKey: string): Promise<PaneOwner | null> {
    const target = sessionName(persistKey)
    const live = this.liveSessionForPersistKey(persistKey)
    const sshRemote = live?.sshRemote
    try {
      if (sshRemote) {
        // ONE round-trip, not two (issue #460): under a saturated or dead ControlMaster every
        // exec silently falls back to a FULL ssh login, and two sequential fallback logins do not
        // fit the caller's 2s probe budget — a live agent pane then read as `unknown`,
        // persistently. The combined script carries both halves; the parser applies the same
        // grammars the two-trip read used. See `remotePaneOwnerCombinedArgs` for the measurement.
        const ssh = findSsh()
        if (!ssh) return null
        const out = await runAsync(
          ssh,
          remotePaneOwnerCombinedArgs(sshRemote.conn, sshRemote.controlPath, target)
        )
        return parseCombinedPaneOwner(out.stdout)
      }
      // The session host has no tty/tmux identity surface. Do not query an unrelated POSIX tmux
      // merely because one is installed beside this native Windows generation.
      if (live?.sessionHost || !this.tmuxPath) return null
      const first = await runAsync(this.tmuxPath, [
        '-L',
        TMUX_SOCKET,
        'display-message',
        '-p',
        '-t',
        target,
        PANE_OWNER_FMT
      ])
      const identity = parsePaneOwner(first.stdout)
      if (!identity) return null
      const call = foregroundArgvArgs(identity.tty)
      if (!call) return null
      const second = await runAsync(call.bin, call.args)
      return paneOwnerFrom(identity, second.stdout)
    } catch {
      return null
    }
  }

  /**
   * DELETED: `bracketPasteRequested`.
   *
   * It read `#{bracket_paste_flag}`, a format that first shipped in TMUX 3.7 (2026-06-26). On
   * every earlier tmux — Ubuntu 24.04's 3.4, 22.04's 3.2a, Debian 12/13's 3.3a/3.5a, Ubuntu
   * 26.04's 3.6a, and whatever an SSH target happens to run — it expanded to the empty string,
   * so the probe answered "not paste-aware" for every pane on earth and the delivery mangled
   * every multi-line write. `paste-buffer -p` asks the pane's real state, inside tmux, with no
   * version floor; there is nothing left for this method to be right about. Do not reintroduce
   * it as a "capability check": on a pre-3.7 tmux it cannot distinguish "the app did not ask"
   * from "I cannot ask", which is exactly the confusion that shipped the bug.
   */

  /**
   * Deliver the agent-messaging envelope — PLAIN text from `deliverAgentMessage` — into a node's
   * pane, local or SSH, through the SAME plans as `sendText` with the Enter always on: tmux frames
   * the paste from the pane's real bracketed-paste state (`paste-buffer -p`) and the submit is a
   * separate `send-keys Enter` in the same tmux command list.
   *
   * This replaced `sendFramedPayload`, which pushed a JS-composed `ESC[200~…ESC[201~\r` payload
   * through `paste-buffer` with no `-p`: tmux ≥ 3.7 passes paste-buffer content through vis(3),
   * which rendered that frame as literal `^[[200~` text in the composer and swallowed the submit
   * (issue #453 — see the tombstones in tmux-naming.ts and paste-injection.ts). The plans
   * sanitize the payload structurally (`sanitizePasteText` inside `localPasteDelivery` /
   * `remotePasteDelivery`), which is now correct for this caller too: the envelope carries no ESC
   * byte on purpose, and one smuggled in by a body must never reach a paste buffer.
   *
   * NOT `sendText` itself, because of the empty-payload contract: `sendText('', {enter:true})`
   * means "submit whatever is composed", and a lone Enter into an agent's composer is exactly the
   * accidental submit a messaging delivery must never perform — an empty envelope refuses here.
   * (`buildEnvelope` can never return '', so this is a guard against a future caller, not a path.)
   */
  async sendEnvelope(persistKey: string, envelope: string): Promise<boolean> {
    if (envelope.length === 0) return false
    const target = sessionName(persistKey)
    const sshRemote = this.sessionByPersistKey(persistKey)?.sshRemote
    try {
      if (sshRemote) {
        const ssh = findSsh()
        if (!ssh) return false
        const plan = remotePasteDelivery(sshRemote.conn, sshRemote.controlPath, target, envelope, true)
        if (!plan) return false
        return await runPasteDelivery(plan, (args, input) => runWithStdin(ssh, args, input))
      }
      if (!this.tmuxPath) return false
      const tmuxPath = this.tmuxPath
      const plan = localPasteDelivery(TMUX_SOCKET, target, envelope, true)
      if (!plan) return false
      return await runPasteDelivery(plan, (args, input) => runWithStdin(tmuxPath, args, input))
    } catch {
      // A builder throwing (an unsafe target) lands here; `runPasteDelivery` itself answers false
      // rather than throwing, so the buffer sweep is never skipped.
      return false
    }
  }

  /**
   * Does a live session exist for this node in THIS process right now? The messaging delivery's
   * `targetLive` fact — deliberately not derived from an unreadable pane (see `DeliveryRequest`):
   * only "no session is registered" may be reported as "the node is gone".
   */
  hasLiveSession(persistKey: string): boolean {
    return !!this.sessionByPersistKey(persistKey)
  }

  /**
   * List the names of all live nodeterm tmux sessions (on our dedicated socket). Used by the
   * relay host's `projects.list` RPC so a paired phone can enumerate the host's sessions the same
   * way the SSH browse path does (`tmux -L node-terminal list-sessions`). Returns the trimmed,
   * non-empty session names; `[]` on any error (tmux unavailable / no server / no sessions) so it
   * never throws.
   */
  async listNodetermSessions(): Promise<string[]> {
    // The two persistence backends can legitimately coexist on Windows (native profiles in the
    // session host, legacy/MSYS terminals in tmux). Query each independently so one unavailable
    // backend cannot hide the other's sessions, then de-duplicate a migrated name.
    const tmuxSessions = this.tmuxPath
      ? runAsync(this.tmuxPath, [
          '-L',
          TMUX_SOCKET,
          'list-sessions',
          '-F',
          '#{session_name}'
        ])
          .then(({ stdout }) =>
            stdout
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          )
          .catch(() => [] as string[])
      : Promise.resolve([] as string[])
    const hostSessions =
      this.getSettings().tmuxEnabled && sessionHostSupported()
        ? sessionHostListSessions().catch(() => [] as string[])
        : Promise.resolve([] as string[])
    const [tmux, host] = await Promise.all([tmuxSessions, hostSessions])
    return [...new Set([...tmux, ...host])]
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
  destroySession(
    clientId: ClientId | null,
    persistKey: string,
    opts?: { everySocket?: boolean }
  ): Promise<void> {
    return this.endSession(clientId, persistKey, 'delete', opts?.everySocket === true)
  }

  /** Register shell cleanup after end processing (and the session-host acknowledgement). Failures are
   *  isolated from the acknowledgement: a dead transcript tail must not turn a successful kill
   *  into an outcome the renderer is told is unknown. */
  onSessionEnded(listener: (persistKey: string) => void): () => void {
    this.sessionEndedListeners.add(listener)
    return () => this.sessionEndedListeners.delete(listener)
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

  /** Awaited desktop profile-switch variant of recycle. Main registers the invoke handler itself
   * so it can release agent-tail ownership after this teardown succeeds. Keep the client-facing
   * validation and rate budget identical to the existing fire-and-forget recycle channel. */
  recycleSessionFromClient(
    clientId: ClientId,
    persistKey: string,
    target?: PtyRecycleTarget
  ): Promise<void> {
    if (typeof persistKey !== 'string' || !persistKey || persistKey.length > REF_MAX_LEN) {
      return Promise.reject(new Error('Refusing to restart terminal: invalid node id.'))
    }
    if (this.confirmedRecycles.has(persistKey)) {
      return Promise.reject(
        new Error('This terminal is already restarting. Wait for that restart to finish.')
      )
    }
    if (!this.allowEnd(clientId, IPC.ptyRecycleConfirmed)) {
      return Promise.reject(
        new Error('Too many terminal restart requests. Wait a moment and try again.')
      )
    }
    const operation = this.confirmAndRecycleSession(clientId, persistKey, target)
    this.confirmedRecycles.set(persistKey, operation)
    return operation.finally(() => {
      if (this.confirmedRecycles.get(persistKey) === operation)
        this.confirmedRecycles.delete(persistKey)
    })
  }

  /** Confirm the target profile is spawnable before ending the old generation, then tear down the
   * backend transactionally. Actual spawn resolves the stable id again at point of use: preflight
   * prevents a knowingly destructive switch, but never turns executable/argv into persisted state. */
  private async confirmAndRecycleSession(
    clientId: ClientId,
    persistKey: string,
    target?: PtyRecycleTarget
  ): Promise<void> {
    let trustedTarget: PtyRecycleTarget | undefined
    if (target) {
      // Profile-switch replacement targets land with the windows-terminal-profiles phase; until
      // then a target can only be refused (the same copy the fork uses without a resolver).
      throw new Error('Windows terminal profiles are unavailable on this host.')
    }
    const liveId = this.byPersistKey.get(persistKey)
    const live = this.liveSessionForPersistKey(persistKey)
    if (live?.sshRemote) {
      throw new Error('Remote terminals cannot be restarted with a local Windows profile.')
    }
    const liveSessionId = live
      ? liveId ?? [...this.sessions.entries()].find(([, session]) => session === live)?.[0]
      : undefined
    let resolveExit: (() => void) | undefined
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const deferred:
      | { session: Session; exitCode?: number; resolveExit?: () => void }
      | undefined = liveSessionId && live ? { session: live, resolveExit } : undefined
    // Install the exact-generation barrier before any awaited backend probe. A silent plain
    // process can exit while has-session is in flight; if that natural exit were published first,
    // the rest of this transaction would retain a stale pid and could reject after trying to kill
    // a generation that is already gone. The barrier records that exit as proof without allowing a
    // replacement generation to be confused with this one.
    if (liveSessionId && deferred) this.confirmedBackendEnds.set(liveSessionId, deferred)
    const clearExactBarrier = (): void => {
      if (liveSessionId && this.confirmedBackendEnds.get(liveSessionId) === deferred)
        this.confirmedBackendEnds.delete(liveSessionId)
    }
    const abandonConfirmedRecycle = (error: unknown): never => {
      clearExactBarrier()
      // A failed transaction may still have observed the exact local painter exit. Retire that
      // dead generation honestly, but do not apply/spawn the selected profile without every
      // persistent-backend proof (and, for a hosted replacement, its host-granted lease).
      if (liveSessionId && deferred?.exitCode !== undefined)
        this.handleSessionExit(liveSessionId, deferred.session, deferred.exitCode)
      throw error
    }
    let confirmedSessionHost = false
    let confirmedTmux = false
    const settings = this.getSettings()
    const hostAvailable = sessionHostSupported()
    // A local index identifies one painter, not every persistent backend that may still own this
    // node name. Migration and setting changes can leave a same-name host + tmux generation, so
    // probe both independently even while one local generation is indexed. Failed reads remain
    // uncertainty and reject before any destructive action. Old tmux discovery intentionally does
    // not respect today's tmuxEnabled value: disabling persistence cannot make yesterday's live
    // process disappear.
    try {
      if (hostAvailable) {
        confirmedSessionHost = await sessionHostHasSession(sessionName(persistKey))
      }
      if (this.tmuxPath) confirmedTmux = await this.confirmedTmuxSessionExists(persistKey)
    } catch (error) {
      abandonConfirmedRecycle(
        error instanceof SessionHostProtocolCompatibilityError
          ? error
          : new Error(
              `Could not confirm the terminal session before restarting it: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
      )
    }

    // The confirmed path is transactional at the app boundary: acknowledge the persistent
    // backend kill before dropping the local index/subscribers or publishing recycle state. If the
    // kill rejects, every local mapping remains untouched and main cannot release agent tails or
    // let the renderer apply the new profile. Legacy fire-and-forget recycle keeps its historical
    // cleanup-first behavior through endSession's default parameter.
    const sourceSessionHost = !!live?.sessionHost || confirmedSessionHost
    const sourceTmux =
      confirmedTmux || (!!live?.tmuxBacked && !live.sessionHost && !live.sshRemote)
    // These flags describe independent old backends, not one preferred winner. In particular, a
    // discovered hidden host/tmux generation must not make an indexed direct PTY stop being plain:
    // dropping that local mapping without taskkill/onExit proof leaks the silent process.
    const sourcePlain = !!live && !live.sessionHost && !live.tmuxBacked && !live.sshRemote
    // This is a TARGET lease, not an old-backend property. Acquire it before touching tmux/plain
    // so another app cannot create the name in the gap, and take it exactly when the REPLACEMENT
    // generation will be host-backed — the same predicate spawnSession's backend selection uses:
    // on Windows whenever persistence is on and the host bundle exists, elsewhere only when no
    // local tmux is installed (with a tmux present, the replacement lands on tmux and holds no
    // host lease). A direct replacement deliberately holds no host lease, while old host/tmux
    // duplicates are still ended below.
    const reserveHostReplacement =
      (this.runtimePlatform === 'win32' || !this.tmuxPath) &&
      settings.tmuxEnabled &&
      hostAvailable
    const hostName = sessionName(persistKey)
    const expectHostAbsent =
      reserveHostReplacement && !live?.sessionHost && !confirmedSessionHost
    const confirmedHostKillOptions = {
      reserveReplacement: reserveHostReplacement,
      requireV2: true,
      ...(expectHostAbsent ? { expectedAbsent: true } : {})
    }

    // Host FIRST. The target lease protects the name across app processes before any old
    // tmux/plain teardown begins. Every confirmed profile recycle requires protocol-v2 exact
    // generation semantics, even when the selected replacement is deliberately direct and needs
    // no lease. Generic delete remains the separate, legacy-compatible path in endSession().
    if (reserveHostReplacement || sourceSessionHost) {
      try {
        await sessionHostKillSession(hostName, confirmedHostKillOptions)
      } catch (error) {
        if (error instanceof SessionHostProtocolCompatibilityError)
          abandonConfirmedRecycle(error)

        const exactHostExit = !!live?.sessionHost && deferred?.exitCode !== undefined
        if (reserveHostReplacement) {
          // An exact v2 exit proves teardown, not lease ownership. Retry the SAME retained client
          // operation and require a host-returned token. For an unindexed host whose response was
          // lost, a strict absence probe permits the same retry; a competing client still cannot
          // synthesize ownership because its operation id is different and the host rejects it.
          let mayRetryRetainedOperation = exactHostExit
          if (!mayRetryRetainedOperation) {
            try {
              mayRetryRetainedOperation = !(await sessionHostHasSession(hostName))
            } catch (probeError) {
              abandonConfirmedRecycle(probeError)
            }
          }
          if (mayRetryRetainedOperation) {
            try {
              await sessionHostKillSession(hostName, {
                reserveReplacement: true,
                requireV2: true,
                ...(expectHostAbsent ? { expectedAbsent: true } : {})
              })
            } catch (leaseError) {
              abandonConfirmedRecycle(leaseError)
            }
          } else {
            abandonConfirmedRecycle(error)
          }
        } else {
          // Direct targets hold no replacement lease, but they still require the correlated v2
          // operation result so the client can retire its reconnect/kill barrier. Exact local exit
          // proves backend death; for an unindexed host, first require strict named absence. Then
          // retry the SAME retained non-reserve operation and wait for its idempotent result.
          if (!exactHostExit) {
            let hostStillExists = true
            try {
              hostStillExists = await sessionHostHasSession(hostName)
            } catch (probeError) {
              abandonConfirmedRecycle(probeError)
            }
            if (hostStillExists) abandonConfirmedRecycle(error)
          }
          try {
            await sessionHostKillSession(hostName, confirmedHostKillOptions)
          } catch (retryError) {
            abandonConfirmedRecycle(retryError)
          }
        }
      }
    }

    // Tmux SECOND and independently. A tmux client exit is not pane/session death proof; only the
    // named-session kill acknowledgement or a strict absent re-probe lets this stage commit.
    if (sourceTmux && this.tmuxPath) {
      try {
        await this.confirmedProcessRun(
          this.tmuxPath,
          localTmuxKillArgs(TMUX_SOCKET, hostName)
        )
      } catch (error) {
        let tmuxStillExists = true
        try {
          tmuxStillExists = await this.confirmedTmuxSessionExists(persistKey)
        } catch (probeError) {
          abandonConfirmedRecycle(probeError)
        }
        if (tmuxStillExists) abandonConfirmedRecycle(error)
      }
    }

    // Plain LAST and independently from hidden persistent backends. A natural exact exit recorded
    // during the earlier probes is already proof, so never taskkill its stale pid. On Windows a
    // successful process-tree termination is stronger than node-pty's sometimes-missed callback;
    // elsewhere/no pid, bound the wait for this exact generation's exit.
    if (sourcePlain && live && deferred?.exitCode === undefined) {
      try {
        releasePty(live.proc as ReleasablePty)
        const pid = (live.proc as pty.IPty & { pid?: number }).pid
        if (this.runtimePlatform === 'win32' && Number.isSafeInteger(pid) && (pid as number) > 0) {
          await terminateWindowsProcessTree(pid as number)
        } else if (deferred?.exitCode === undefined) {
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              exited,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        'The terminal process did not confirm that it exited. Try the restart again.'
                      )
                    ),
                  CONFIRMED_PLAIN_EXIT_TIMEOUT_MS
                )
              })
            ])
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        }
      } catch (error) {
        // For a plain generation, this exact callback is destructive commit proof even when the
        // release/taskkill acknowledgement failed. Suppress ordinary ptyExit only if all hidden
        // host/tmux stages above also committed; otherwise abandonConfirmedRecycle handled it.
        if (deferred?.exitCode === undefined) abandonConfirmedRecycle(error)
      }
    }

    clearExactBarrier()
    // Every applicable backend was either ended above or strictly probed absent. Do not fall back
    // to endSession's legacy best-effort kill (which swallows ambiguity and carries no lease).
    await this.endSession(clientId, persistKey, 'recycle', false, true, trustedTarget)
  }

  /**
   * The shared teardown behind `destroySession` / `recycleSession`: drop the session (and its
   * co-attach index entry, in-flight create, buffered output, flow-control ledger), drop the
   * cold-restore snapshot, and `tmux kill-session`. Everything the two intents disagree about is
   * the ONE branch below — what the other subscribers are told (see `EndIntent`).
   */
  private endSession(
    clientId: ClientId | null,
    persistKey: string,
    intent: EndIntent,
    everySocket = false,
    /** The awaited confirmed-recycle path already received every backend acknowledgement. */
    backendAlreadyEnded = false,
    /** Trusted replacement identity; present only after confirmed profile preflight. */
    replacementTarget?: PtyRecycleTarget
  ): Promise<void> {
    const current = this.ending.get(persistKey)
    if (current) {
      // Identical repeats share one acknowledgement only when the in-flight target scope covers
      // this caller. An every-socket request, a pre-confirmed backend outcome, and an exact profile
      // reservation are each stronger than their generic counterpart, so a stronger request waits
      // for the narrow pass and then performs its own cleanup/reservation before it may resolve.
      const targetCovered =
        !replacementTarget ||
        (current.replacementTarget?.profileId === replacementTarget.profileId &&
          current.replacementTarget.cwd === replacementTarget.cwd)
      const covered =
        current.intent === intent &&
        (!everySocket || current.everySocket) &&
        (!backendAlreadyEnded || current.backendAlreadyEnded) &&
        targetCovered
      return covered
        ? current.promise
        : current.promise.then(() =>
            this.endSession(
              clientId,
              persistKey,
              intent,
              everySocket,
              backendAlreadyEnded,
              replacementTarget
            )
          )
    }
    const promise = this.runEndSession(
      clientId,
      persistKey,
      intent,
      everySocket,
      backendAlreadyEnded,
      replacementTarget
    )
    const entry = { intent, everySocket, backendAlreadyEnded, replacementTarget, promise }
    this.ending.set(persistKey, entry)
    const clear = (): void => {
      if (this.ending.get(persistKey) === entry) this.ending.delete(persistKey)
    }
    promise.then(clear, clear)
    return promise
  }

  private async runEndSession(
    clientId: ClientId | null,
    persistKey: string,
    intent: EndIntent,
    everySocket = false,
    /** The awaited confirmed-recycle path already received a backend kill acknowledgement. */
    backendAlreadyEnded = false,
    /** Trusted replacement identity; present only after confirmed profile preflight. */
    replacementTarget?: PtyRecycleTarget
  ): Promise<void> {
    // Both callers run while the session is still live, so its sshRemote is known. Capture it
    // synchronously before any await. The index is the co-attach one (UI sessions); the scan is
    // the fallback for a session that is live but not indexed.
    const indexedId = this.byPersistKey.get(persistKey)
    const indexed = indexedId ? this.sessions.get(indexedId) : undefined
    const fallback = indexed ?? this.sessionByPersistKey(persistKey)
    const dyingId =
      indexedId ??
      (fallback
        ? [...this.sessions.entries()].find(([, candidate]) => candidate === fallback)?.[0]
        : undefined)
    const dying = fallback
    const sshRemote = dying?.sshRemote
    // SessionHostClient has a real request/response acknowledgement. Await it BEFORE any local
    // deletion claim: on transport failure the node, tombstone, subscribers and transcript tails
    // remain available, because the host outcome is unknown and the user must be able to retry.
    // A live session records its backend directly; the second branch preserves the old unheld-row
    // behavior, where the enabled host may own a session this manager is not attached to.
    if (backendAlreadyEnded) {
      // The confirmed profile-switch transaction proved every applicable backend ended (or was
      // strictly absent), so it also resolves any older generic request whose response was lost.
      this.unknownEnds.delete(persistKey)
    } else {
      const sessionHostKill =
        dying?.sessionHost === true ||
        this.unknownEnds.has(persistKey) ||
        (!dying &&
          !this.tmuxPath &&
          this.getSettings().tmuxEnabled &&
          sessionHostSupported())
      if (sessionHostKill) {
        try {
          await sessionHostKillSession(sessionName(persistKey))
          this.unknownEnds.delete(persistKey)
        } catch (error) {
          this.unknownEnds.add(persistKey)
          throw error
        }
      }
    }
    // Un-index NOW (synchronously): this session is finished either way, so a create() that races
    // the kill-session below — the worktree-move respawn does exactly that — must spawn a fresh
    // session instead of co-attaching to the one we are about to end.
    // Also drop any in-flight create for this node: a create racing the kill-session below must
    // spawn a fresh session, not await (and then join) the one we are ending.
    this.inflight.delete(persistKey)
    // The session is ending (delete or recycle), so its pane ownership no longer holds — a later
    // genuine respawn re-records it; until then the id is unproven, which fails closed for
    // messaging (agents/pane-ownership.ts). Safe on either intent: recycle's respawn overwrites.
    forgetPaneOwner(persistKey)
    // The tmux session is about to be killed, so everything attached to it goes now: a shadow would
    // otherwise linger until tmux dropped its client, and what we remembered about the released
    // session describes a pane that is about to stop existing.
    this.shadowDispose(persistKey)
    this.sharedDisposeOn(persistKey)
    this.released.delete(persistKey)
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
      } else {
        this.armRecycle(persistKey, dyingId, others, clientId, replacementTarget)
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
    // Confirmed absence and a solo live session still need an owner reservation: an inactive
    // co-viewer can issue create during kill → settings-apply even when there were no subscribers
    // to notify. It waits on this entry and can never establish a stale replacement generation.
    if (intent === 'recycle' && (!dyingId || !dying))
      this.armRecycle(persistKey, '', [], clientId, replacementTarget)
    // This session is gone for good — drop its cold-restore snapshot too. A recycle drops it as
    // well (and always did, when the worktree move went through `destroy`): the snapshot is of the
    // OLD cwd's session, and the respawn is a cold start (`fresh`), so replaying it would paint the
    // pre-move terminal into the new one.
    await deleteScrollback(persistKey)
    // Same hook, same reason as the snapshot above: this node's Codex thread records go with the
    // session. Left behind they accumulate one file per thread forever, and the hook prelude keeps
    // re-exporting a DELETED node's id into any tool shell that still carries that thread id.
    //
    // Like the snapshot, this also runs for a RECYCLE (the worktree move), where the node lives on
    // — and that is fine rather than intended: a recycle respawns cold, so the next launch mints or
    // re-binds a record immediately. Worth stating because the two intents share this line: only
    // `delete` means "gone for good".
    forgetCodexThreadIdentitiesForNode(persistKey)
    // The node's per-node capability goes with it — but ONLY on a delete, unlike the two above.
    // The token is derived from the NODE id, and a recycle keeps the node: the file on disk stays
    // exactly correct across a worktree move, so sweeping it would delete a valid credential and
    // open a window (kill → respawn → first hook event) in which the node cannot prove itself.
    // Under the trust-on-first-proof latch that window is not merely a downgrade to `legacy` — a
    // node that has already proven itself and then presents nothing is refused. Re-minting right
    // after the sweep would close most of it, but it depends on respawn ordering and still leaves a
    // gap; not sweeping leaves none, and there is nothing stale to clean up.
    if (intent === 'delete') sweepNodeToken(persistKey)
    // The node's agent-status goes with it — and, like the token, ONLY on a delete: a RECYCLE keeps
    // the node (the worktree move replaces this session, and the respawned agent re-asserts state
    // onto the SAME entry), so clearing there would blank a live badge and end a Live Activity for
    // a node that is still on the canvas.
    //
    // Deleting a node used to tell the mirror nothing at all — `clearNode` had no production caller
    // — so the surfaces the mirror feeds kept rendering a node that no longer exists: the notch HUD
    // held its needs-you/done row until the 6 h prune (its title collapsing to the literal
    // 'Session' once the entry behind it aged out), the phone's Inbox cards for it were never
    // resolved, and its Live Activity was never ended.
    //
    // Wired HERE rather than in each shell's `pty:destroy` listener because this is the one core
    // chokepoint every permanent delete funnels through (wire handler → endFromClient → endSession,
    // plus the internal `destroySession`), and both shells register it via `registerIpc()`. The
    // shells' own listeners are the wrong seam twice over: they are registered for `pty:recycle`
    // too, and there are two of them to keep in step.
    if (intent === 'delete') clearNodeAgentStatus(persistKey)
    if (!backendAlreadyEnded) {
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
      if (this.tmuxPath) {
        // Which socket(s) to aim at. Holding the session ourselves means we KNOW: it is the local one,
        // one kill, unchanged. Holding nothing means the name is all we have — and then the fan-out
        // is the CALLER's to ask for, because on this machine a `nt-<id>` we hold nothing for can
        // also be living on the `nodeterm-rmt` socket, where ANOTHER machine's nodeterm puts the
        // sessions it SSHes in to spawn. Only the session-memory panel's speculative kill sets
        // `everySocket`: it sweeps both sockets and offers to end what it found, so a kill that only
        // tried `node-terminal` showed a confirm saying "this stops its tmux session" and did
        // nothing. An ordinary node-× on a node never mounted in this process takes the same unheld
        // branch and must NOT inherit that blast radius.
        for (const socket of localKillSockets(dying ? TMUX_SOCKET : null, everySocket)) {
          try {
            await runAsync(this.tmuxPath, localTmuxKillArgs(socket, sessionName(persistKey)))
          } catch {
            // session may not exist on this socket; ignore
          }
        }
      }
    }
    for (const listener of this.sessionEndedListeners) {
      try {
        listener(persistKey)
      } catch (error) {
        console.warn(
          `[pty] confirmed ${intent} cleanup for ${persistKey} failed`,
          error instanceof Error ? error.message : String(error)
        )
      }
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
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    const finals: Promise<unknown>[] = []
    for (const session of this.sessions.values()) {
      if (session.flushTimer) clearTimeout(session.flushTimer)
      // Final scrollback snapshot on quit so a reboot can replay it. Skipped for sessions with
      // no output since the last periodic capture (unchanged pane content).
      if (session.persistKey && session.outputSinceSnapshot)
        finals.push(
          this.snapshotScrollback(session.persistKey, session.sshRemote, !!session.sessionHost)
        )
      releasePty(session.proc as ReleasablePty)
    }
    // Shadows are child processes of OURS, so quitting takes them with us — the tmux sessions they
    // were attached to keep running with no client at all, which is exactly what persistence means.
    for (const persistKey of [...this.shadows.keys()]) this.shadowDispose(persistKey)
    // …and so does the shared background-write client, along with its linger timer.
    this.sharedDispose()
    this.released.clear()
    this.sessions.clear()
    this.byPersistKey.clear()
    // Pending recycle notices die with the sessions they were waiting on (their timers would
    // otherwise fire into a manager that has released everything).
    for (const entry of this.pendingRecycle.values()) {
      clearTimeout(entry.timer)
      const error = new Error('Terminal manager shut down before the replacement became ready.')
      for (const waiter of entry.waiters) waiter.reject(error)
    }
    this.pendingRecycle.clear()
    // Clear the in-flight index with the other two, or a create still spawning at quit would leave
    // a promise (and the session it resolves to) reachable from a manager that has released
    // everything else — a later create would then co-attach to a session we already let go.
    this.inflight.clear()
    this.confirmedBackendEnds.clear()
    this.confirmedRecycles.clear()
    this.ending.clear()
    this.unknownEnds.clear()
    return Promise.all(finals).then(() => undefined)
  }

  /** Variadic so a payload-less event (`pty:recycled`) sends no argument at all, rather than an
   *  explicit `undefined` the shells would have to serialize and the renderer ignore. */
  private send(clientId: ClientId, channel: string, ...args: unknown[]): void {
    platform().sendTo(clientId, channel, ...args)
  }
}

import { grokHomeDir, grokSessionDir, grokSessionsDir } from '../core/agents/grok-paths'
import { join, resolve, posix } from 'path'
import { startSessionNameSweep, displayNodeTitle } from '../core/session-name-sweep'
import { startTriggerService } from '../core/trigger-service'
import { readAgentSessionName, type AgentSessionNameDeps } from '../core/agent-session-name'
import { readFile, realpath as fsRealpath, lstat as fsLstat, writeFile as fsWriteFile } from 'fs/promises'
import { existsSync, statSync, openSync, fstatSync, readFileSync, closeSync } from 'fs'
import { homedir, hostname } from 'os'
import { randomUUID } from 'crypto'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, safeStorage, shell, systemPreferences, webContents } from 'electron'
import { IPC } from '../shared/ipc'

// Debug log ring (issue #78): capture the process console from the first line — a packaged app
// swallows it entirely, and the boot path is where the interesting warnings are. The ring is
// in-memory and redacted at its push boundary; the panel/IPC side is gated on the setting.
const logBuffer = new LogBuffer()
installLogSink(logBuffer)
import { writeFilesToClipboard } from './clipboard-files'
import { pickProjectIcon } from './project-icon-upload'
import { allowGuestNavigation } from './webview-nav'
import { hostOsFromPlatform, sshServerCopy } from '../shared/ssh-server'
import { macTitleBarOptions } from './window-chrome'
import { guestContextMenuTemplate } from './webview-context-menu'
import { BrowserControlLedger } from './browser-control-ledger'
import {
  recordOpenProjectGrant,
  isGranted as projectGrantedTo,
  atCap as projectGrantsAtCap,
  clearCaller as clearProjectGrants,
  gateProjectTarget,
  gateOpenProject,
  PROJECT_TARGETABLE_VERBS,
  OPEN_PROJECT_GRANT_CAP
} from '../core/project-grants'
import { BrowserLeaseManager, BrowserSession } from './browser-lease'
import { CdpEventBus, type Sendable } from './browser-actions'
import { RefTable } from './browser-refs'
import {
  driveBrowser,
  resolveBrowserTarget,
  type BrowserResolve,
  type LiveGuest
} from './browser-drive'
import { parseBrowserArgs } from '../core/browser-verb'
import { STRICT_CONTROL_REFUSAL } from '../core/agents/node-identity-policy'
import {
  revokeBrowserNode,
  revokeBrowserByOwner,
  revokeBrowserByProject,
  revokeAllBrowser,
  type RevocationTargets
} from './browser-revocation'
import { registerFsHandlers } from '../core/fs-handlers'
import { TrackpadGestureLedger } from './trackpad-gesture'
import { LogBuffer } from '../core/log-buffer'
import { installLogSink, splitTag } from '../core/log-sink'
import { registerLogHandlers } from '../core/log-handlers'
import {
  registerBrowserGuest,
  type BrowserGuest,
  type BrowserSurfaceKind
} from './browser-guest-registry'
import { appendBoardLogVia, registerBoardLogHandlers, type BoardLogRoute } from '../core/board-log-handlers'
import {
  createDeliveryQueue,
  deliverFromControl,
  isDeliverRequest,
  messagingEnabledVia,
  onMessagingAgentEvent,
  setDeliveryQueue,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import type { RemoteLogExec } from '../core/board-log'
import { boardLogRemotePath } from '../core/board-log'
import { PtyManager } from '../core/pty-manager'
import { WorkspaceStore } from '../core/workspace-store'
import { WorkspaceWatcher } from '../core/workspace-watcher'
import { SettingsStore } from '../core/settings-store'
import { registerAgentEnvIpc } from '../core/agent-env-ipc'
import { presenceHub } from '../core/presence/hub'
import { SshStore } from './ssh-store'
import { GitService } from '../core/git-service'
import { ProjectTrustStore } from '../core/project-trust-store'
import { ProjectSetupService } from '../core/project-setup-service'
import {
  makeProjectTrustRequester,
  registerProjectSetupHandlers,
  type ProjectSetupHandlerDeps
} from '../core/project-setup-handlers'
import { registerProjectLaunchInfoHandlers } from '../core/project-launch-info-handlers'
import { registerWorktreeSharedPathsHandlers } from '../core/worktree-shared-paths-handlers'
import { makeProjectSpawnOverrides } from '../core/project-spawn-overrides'
import { makeLocalSetupRunner } from '../core/project-setup-runner-local'
import { makeSshSetupRunner } from './remote-ssh/ssh-setup-runner'
import { registerGitHubIntegration } from '../core/github/integration'
import { runGitHubCliCommand } from '../core/github/credentials'
import {
  ElectronGitHubSecretStore,
  ElectronSecretStore,
  registerElectronGitHubControl
} from './github-control'
import {
  migrateLegacyModelGatewayKey,
  MODEL_GATEWAY_SECRET_FILE,
  ModelGatewayCredentialService
} from '../core/model-gateway-credentials'
import { generateCommitMessage, generateGroupName, generateTerminalName } from '../core/commit-message'
import { initUpdater } from './updater'
import { fetchCheck } from '../core/check'
import { hookServer, OPEN_PROJECT_CONTROL_REFUSAL } from '../core/agents/hook-server'
import { askpassServer, ensureAskpassScript } from './remote-ssh/ssh-askpass'
import { appSshAgent } from './remote-ssh/ssh-agent'
import {
  writePendingAnswerLocal,
  startPendingSweep,
  isValidPendingId,
  syntheticAnsweredEvent
} from '../core/agents/pending-approvals'
import { setMainWindow, getMainWindow, sendToMain, closeAction, createCrashReloadPolicy } from './main-window'
import {
  MENU_ITEM_ID_CLOSE,
  MENU_ITEM_ID_KANBAN,
  MENU_ITEM_ID_MINIMIZE,
  MENU_ITEM_ID_SETTINGS,
  closeStandsDownInTerminal,
  installKeydownIntercepts,
  menuItemIdsToSuspend,
  menuStandsDown,
  navigationClearsRecording,
  policyStandsDown,
  resolveInterceptBindings,
  type KeydownInterceptBindings
} from './keydown-intercept'
import {
  normalizeTerminalShortcutPolicy,
  type TerminalShortcutPolicy
} from '../shared/keybindings'
import {
  initNotchHud,
  applyNotchHudSettings,
  type NotchHudTunables,
  destroyNotchHud,
  notchHudOnAgentEvent,
  notchHudOnContextUpdate,
  assertRegularDockPresence
} from './notch-hud'
import {
  initAgentStatusMirror,
  onMirrorFlush,
  flush as flushAgentStatusMirror,
  recordAgentEvent,
  ackDone,
  recordRawToolEvent,
  recordContextUsage,
  setMirrorSettingsProvider,
  setMirrorUsageProvider,
  buildMirrorUsage,
  onInboxActionable,
  onNodeStateChange,
  onNodeNowChange,
  isEventUnresolved,
  type MirrorSettings,
  setNodeSessionName,
  setNodeHibernated,
  sessionNameSweepEntries,
  nodeState,
  nodeSessionName,
  workingNodes
} from '../core/agent-status-mirror'
import { paneOwnerProject } from '../core/agents/pane-ownership'
import { createPushNotify, createLiveUpdatePush } from '../core/push-notify'
import { createGrantsAccessor, type PushGrant } from '../core/push-grants'
import { createRemoteGrantsCache } from '../core/remote-push-grants'
import { createAckSweeper } from '../core/ack-sweep'
import { createSessionReaper } from '../core/session-budget'
import { initKeepAwake } from './keep-awake'
import type { KeepAwakeTracker } from '../core/keep-awake'
import { startSessionMemoryService, sshScopePredicate } from '../core/session-memory-service'
import { createMemoryPressureMonitor } from '../core/memory-pressure'
import { createPtyPressureMonitor } from '../core/pty-pressure'
import { registerPtmxLimitHandler } from './ptmx-limit'
import { getDeviceId } from '../core/device-id'
import { initRemoteStatusPush } from './remote-ssh/remote-status-push'
import { initCanvasSync } from '../core/canvas-sync'
import { retainUntilDismissed } from './notifications'
import { installManagedAgentHooks } from '../core/agents/hooks'
import { createSubagentTail } from '../core/subagent-tail'
import { createContextTail, type TaskNotification } from '../core/context-tail'
import { grokContextParse, GROK_SIGNALS_FILE } from '../core/grok-signals'
import { geminiContextParse } from '../core/gemini-session'
import { codexContextParse } from '../core/codex-session'
import { createCodexSubagentFormatter } from '../core/codex-subagent-format'
import { codexHome } from '../core/usage/codex-usage'
import { isAsyncSubagentLaunch, grokRawFields, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { applyGrokHookSession } from '../core/grok-hook-session'
import { agentAccountColor } from '../shared/agents/account-color'
import {
  setRemoteTranscriptReader,
  TITLE_TAIL_BYTES,
  SESSION_ID_RE
} from '../core/transcript-reader'
import {
  locateRemoteTranscriptCommand,
  parseLocatedTranscript,
  remoteTranscriptRoots
} from '../core/remote-transcript-locate'
import { registerTranscriptIpc, resolveTranscript } from '../core/transcript-ipc'
import { createRemoteContextTail } from './remote-context-tail'
import { createRemoteSubagentTail } from './remote-subagent-tail'
import { RemoteFile, type RemoteFileRef } from './remote-ssh/remote-file'
import {
  checkMasterArgs,
  childArgs,
  controlPathFor,
  parseRemoteSessionNames,
  remoteListSessionsArgs,
  remotePaneCommandArgs
} from '../core/remote-ssh/control-master'
import { planRemoteWorkspacePoll } from './remote-workspace-poll'
import { sessionName } from '../core/tmux-naming'
import { posixQuote, type SshConnection } from '../shared/ssh'
import { buildHandoff, type HandoffRemote } from './handoff'
import { initContextLink, setNodeTranscript } from '../core/context-link'
import { transcriptPathOf } from '../core/context-link-core'
import { initCanvasControl, installCanvasSkillInto } from './canvas-control'
import { DRY_RUN_VERBS, dryRunRequested, dryRunRefusal } from '../shared/control-verbs'
import { initTranscriptIndex, searchTranscripts } from '../core/transcript-index'
import { initTelemetry } from './telemetry'
import { initClaudeUsage } from './claude-usage'
import { remoteUsageTargets } from '../core/usage/remote-claude-usage'
import { initLicense, isPremium, getStoredEntitlement } from '../core/license'
import { WhisperModelStore } from '../core/speech/whisper-models'
import { SpeechService } from '../core/speech/speech-service'
import { registerSpeechIpc } from '../core/speech/register-ipc'
import { initClaudeAccounts } from './claude-accounts'
import { initCodexAccounts } from './codex-accounts'
import { claudeCliCaps, registerClaudeCliIpc, type ClaudeCliCaps } from '../core/claude-cli'
import { registerGrokCliIpc } from '../core/grok-cli'
import { refreshCodexIdentityCaps, registerCodexIdentityIpc } from '../core/codex-identity-caps'
import {
  bindCodexThreadIdentity,
  setCodexThreadIdentityAuthSecret,
  writeCodexThreadIdentity
} from '../core/codex-identity-proxy'
import { codexThreadExists, startCodexThread } from '../core/codex-session-name'
import { codexUsageAccounts } from '../core/codex-accounts-core'
import { codexHomeFor } from '../core/codex-config-dir'
import { loadOrCreateNodeAuthSecret } from '../core/agents/node-auth-secret'
import { initNodeTokens, refreshNodeTokens } from '../core/agents/node-token-service'
import {
  claudeConfigDirFor,
  linkedClaudeConfigDirs,
  registerClaudeAccountsSource
} from '../core/claude-config-dir'
import {
  isSafeLocalTranscriptPath,
  isSafeRemoteTranscriptPath,
  remoteAccountConfigDirAbs
} from '../core/claude-accounts-core'
import { installHooksIntoLocalAccounts } from '../core/claude-accounts-service'
import { createPairingService } from './pairing-service'
import {
  initRemoteHost,
  loadOrCreateKeyPair,
  relayAllowed,
  API_BASE as RELAY_API_BASE,
  RELAY_URL
} from './remote/host-service'
import { initStandingHost } from './remote/standing-host'
import { killRelayHostsByPeerKey } from './remote/relay-host'
import { initRelayHost } from './remote/relay-host-service'
import { createRevoker } from './remote/revocation'
import { loadApprovedDevices, saveApprovedDevices } from './remote/approved-devices'
import { publicKeyToB64 } from './remote/e2ee'
import { connectRelayClient, type RelayClientSession } from './remote/relay-client'
import { decodeOffer } from './remote/pairing'
import { loadOrCreatePeerKeyPair } from './remote/peer-identity'
import { initSshProject } from './remote-ssh/ssh-project'
import { resyncProjectAgents, RESYNC_TRANSCRIPT_TAIL_BYTES } from './remote-ssh/agent-resync'
import { setGitRemoteResolver, type GitRemoteRef } from '../core/remote-ssh/remote-git'
import { SshFs, sshAppendArgs, sshTailArgs, sshSizeArgs, sshWriteArgs } from './ssh-fs'
import { makeRemoteWorkspaceIO } from './remote-workspace-io'
import {
  registerMediaScheme,
  initMediaProtocol,
  allowMediaPath,
  writeAgentHtml
} from './media-protocol'
import { initPlatform, platform } from '../core/platform'
import { electronPlatform } from './platform-electron'
import { wirePeerRegistry } from './peer-registry'
import { WEBGL_CONTEXT_CAP_DESKTOP } from '../shared/webgl'

// Dev-only: NT_MULTI lets a SECOND instance run (host + client testing on one machine) with an
// isolated userData via NT_USER_DATA — its own device-id/session/license/workspace. Never active
// in packaged builds. Must run before the stores below resolve userData paths.
const NT_MULTI = !app.isPackaged && !!process.env.NT_MULTI
if (NT_MULTI && process.env.NT_USER_DATA) app.setPath('userData', process.env.NT_USER_DATA)

// Raise Chromium's per-page WebGL context cap (default ~16) — a busy canvas wants more
// GPU-rendered terminals than that. The renderer raises its own budget to match at boot
// (main.tsx → setWebglBudget); see src/shared/webgl.ts for the invariant. Must be appended
// before app 'ready' or the switch is silently ignored.
app.commandLine.appendSwitch('max-active-webgl-contexts', String(WEBGL_CONTEXT_CAP_DESKTOP))

// A throwaway NT_MULTI sandbox must not touch the real Keychain. The "node-terminal Safe Storage"
// entry is keyed by the app NAME, which a dev instance shares with the installed app, so every
// launch prompted for the login password and logged a scary os_crypt error when dismissed. The
// mock keychain keeps safeStorage available in-process (no prompt, no error) while storing
// nothing in the OS; the only consumer is the relay identity keypair, which already has a
// documented plaintext fallback. Never set this for a real build: it would silently downgrade
// at-rest encryption of that key.
if (NT_MULTI && process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')

// First thing in bootstrap: install the Electron CorePlatform so anything in src/core
// (wired in later tasks) can resolve platform() at boot. Placed after the NT_MULTI
// userData override so userDataDir reads the final path; nothing consumes it yet.
// Held: a relay peer's inbound RPC is answered from THIS instance's handler table (corePlatform
// .dispatch / .cast — see platform-electron.ts). `platform()` only exposes the CorePlatform half.
const corePlatform = electronPlatform()
initPlatform(corePlatform)

// Only hand the OS a URL with a vetted scheme. Blocks file://, smb://, and custom
// protocol-handler schemes that could be smuggled in via remote announcement feeds or
// rendered markdown links. Used by both the window-open handler and the IPC handler.
function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

const settingsStore = new SettingsStore()
// ⌘M / ⌘W are registry commands (`node.toggleMarkdown` / `node.close`), so what the window
// intercepts follows the user's settings. Resolved LAZILY (first keystroke, long after
// `settingsStore.init()` in `whenReady`) rather than at module load, where `get()` would still be
// DEFAULT_SETTINGS and every override would be missed until the next save; recomputed on
// `onChange`, which fires after a successful save. Never per keystroke — sanitize is real work.
const interceptIsMac = process.platform === 'darwin'
let interceptBindings: KeydownInterceptBindings | null = null
const currentInterceptBindings = (): KeydownInterceptBindings =>
  (interceptBindings ??= resolveInterceptBindings(settingsStore.get().keybindings, interceptIsMac))
// The user's terminal-shortcut policy, memoized on exactly the same terms and for exactly the same
// reason as `interceptBindings` above: lazily on first keystroke (module load is before
// `settingsStore.init()`, where every stored value still reads as DEFAULT_SETTINGS), recomputed on
// `onChange`, never per keystroke. Normalized through the shared helper so an unknown value from a
// hand-edited settings.json reads as the default `app-first` — i.e. as "keep intercepting", which
// is the direction that leaves the app working.
// FIRST-READ STALENESS IS BENIGN, and the ordering is what makes it so: `settingsStore.init()` runs
// in `whenReady` well before `createWindow` → `buildAppMenu`, whose trailing `syncMenuForStandDown`
// is the earliest possible read of this memo — so the value it latches is already the user's saved
// policy, never DEFAULT_SETTINGS, and every later change arrives on `onChange`. The memo can
// therefore only ever hold what settings.json says.
let interceptPolicy: TerminalShortcutPolicy | null = null
const currentInterceptPolicy = (): TerminalShortcutPolicy =>
  (interceptPolicy ??= normalizeTerminalShortcutPolicy(settingsStore.get().terminalShortcutPolicy))
settingsStore.onChange((s) => {
  interceptBindings = resolveInterceptBindings(s.keybindings, interceptIsMac)
  interceptPolicy = normalizeTerminalShortcutPolicy(s.terminalShortcutPolicy)
  // A policy flip changes the stood-down answer with no focus event behind it, so the menu leg
  // owes a sync here too. (`buildAppMenu` re-runs on this same hook and syncs at its end, so this
  // is belt-and-braces for the ordering between the two `onChange` subscribers — cheap, and not
  // something to leave to subscriber registration order.)
  syncMenuForStandDown()
})
// TWO bits the RENDERER owns and main only mirrors. Both are module-level `let`s read through a
// closure, exactly like `interceptBindings` above: the window is created later and can be recreated
// (macOS dock reopen), so nothing may capture a value.
//
// 1. `shortcutRecording` — Settings' shortcut recorder is armed: stand every intercept down so the
//    chord the user presses reaches the recorder. Without it, recording ⌘W CLOSES THE SELECTED
//    NODES — a claimed chord never reaches the page, so the recorder's own preventDefault cannot
//    save it. It ALSO drives the menu leg (`menuStandsDown` → `syncMenuForStandDown`, called from
//    this bit's IPC receiver), which is what lets a menu-owned chord — ⌘M, ⌘⇧B, ⌘,, off-mac
//    Ctrl+W — reach the recorder instead of the item that owns it.
// 2. `terminalFocused` — an xterm holds keyboard focus, which under the `terminal-first` policy
//    means the intercepts stand down so the terminal gets the chord. `before-input-event` fires
//    before any renderer handler could answer, so the answer has to be sitting here in advance;
//    `renderer/lib/terminalFocusMirror.ts` keeps it current and change-deduped.
//
// FAIL-SAFE DIRECTION, and it is the same one for both: every uncertainty resolves to `false`
// (intercepts ON — the app as it behaved before either feature). The alternative is ⌘W/⌘M/⌘0
// silently handed back to the application MENU app-wide, with no component left alive to release
// the bit. So EVERY way the page that set one can stop existing owes a clear, and `createWindow`
// wires three — window `closed`, `render-process-gone`, and a main-frame navigation (⌘R). That is
// three known paths, not a proof of exhaustiveness: a fourth would show up as "⌘W stopped working
// after I did X", so add its reset beside the others rather than assuming this list is closed.
// The two bits are cleared TOGETHER, by one function called at all three sites, because they die
// for the same reason (the page is gone) and a reset that remembered only one of them would be
// invisible until a user hit the policy path.
//
// ONE RULE FOR A FOURTH RESET, and it is specific to `terminalFocused`: only clear it where the
// renderer's DOCUMENT is ending. The mirror is change-deduped and never re-asserts — it holds its
// own `last` and reports only on a change — so clearing main's bit under a page that is still
// alive and still focused on its terminal strands the two out of sync (`last === true` there,
// `false` here) with no event that will ever reconcile them, and the policy is dead until the user
// happens to click away and back. The three below are safe precisely because each one means that
// page, and its mirror, are gone. `shortcutRecording` has no such constraint (the recorder
// re-arms), so do not reason about the two bits interchangeably.
let shortcutRecording = false
let terminalFocused = false
const clearRendererKeyState = (): void => {
  shortcutRecording = false
  terminalFocused = false
  // The menu leg follows the same state, so it must follow it here too — otherwise a crash or a
  // reload while stood down would leave Window ▸ Minimize disabled with nothing left to re-enable
  // it, i.e. ⌘M dead app-wide. Safe before any window exists: it no-ops without a menu.
  syncMenuForStandDown()
}
const sshStore = new SshStore()
const ptyManager = new PtyManager()
// Dictation: local whisper.cpp models live under userData, one dir per install (same convention
// as the tmux config / scrollback-store). onProgress pushes { id, pct } to the renderer the same
// way agent-status events do (sendToMain — resolves the live window at send time).
const whisperModels = new WhisperModelStore({
  dir: join(app.getPath('userData'), 'speech-models'),
  onProgress: (id, pct) => sendToMain(IPC.speechProgress, { id, pct })
})
const speechService = new SpeechService({ models: whisperModels, isPremium })

// Relay PEER sinks (docs/remote-sessions.md 4b) — the desktop mirror of src/server/index.ts's
// setFlowController / setResyncProvider / onClientGone. Wired at boot, BEFORE any peer can register
// (4c), because a peer that leaves must hand its pty subscriptions back: `unregisterPeerSink` calls
// `onPeerGone` → `dropClient`, and nothing else tells the pty layer that subscriber is gone (a
// vanished peer sends no `pty:kill`) — the pause it owed would freeze the shared terminal for every
// viewer. Inert with zero peers: the registry holds no sink, so none of this ever runs.
// Wired once here — do not double-wire (4b Task 4). A second wirePeerRegistry() call would silently
// overwrite these deps (last write wins), so keep this the sole call site in src/main.
let dropGitHubRelayClient: ((id: number) => void) | undefined
wirePeerRegistry({
  setFlow: (id, sid, resume, owner) => ptyManager.setFlow(id, sid, resume, owner),
  captureForResync: (sid) => ptyManager.captureForResync(sid),
  onPeerGone: (id) => {
    ptyManager.dropClient(id)
    dropGitHubRelayClient?.(id)
  }
})

// Set once the app window is ready; used by the quit hooks to tear down SSH-project masters and
// (via the closures below) to resolve a live SSH project's ControlMaster for remote workspace IO.
let sshProjectManager: ReturnType<typeof initSshProject> | undefined

// The standalone Codex relay bundle (`out/main/codex-relay.js`, built by scripts/build-codex-relay.mjs
// after electron-vite build), uploaded to a Linux host for managed Codex accounts. Read once, beside
// the main entry so the same `__dirname` resolves in dev and inside a packaged asar. Single-fd read
// (open→fstat→read the SAME descriptor) — no stat-then-read on the path. Empty string on any miss so
// the SSH manager degrades to "no managed Codex runtime" instead of throwing.
let codexRelayBundleCache: string | undefined
async function loadCodexRelayBundle(): Promise<string> {
  if (codexRelayBundleCache !== undefined) return codexRelayBundleCache
  try {
    const fd = openSync(join(__dirname, 'codex-relay.js'), 'r')
    try {
      // fstat the OPEN descriptor (not the path) and read the SAME fd — a regular-file check with no
      // stat-then-read window. A non-regular entry (fifo/dir/device) is treated as "no bundle".
      codexRelayBundleCache = fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : ''
    } finally {
      closeSync(fd)
    }
  } catch {
    codexRelayBundleCache = ''
  }
  return codexRelayBundleCache
}
// Remote SSH IO for the workspace store: mirrors each SSH project's <remoteCwd>/.nodeterm/project.json
// over that project's live master. Resolves the ref lazily — the manager is created after the window
// is ready — and fails open (no-op) while the project is disconnected.
const workspaceSshFs = new SshFs((args, stdin) =>
  sshProjectManager ? sshProjectManager.sshRun(args, stdin) : Promise.resolve({ code: 1, stdout: '' })
)
const remoteWorkspaceIO = makeRemoteWorkspaceIO(
  (projectId) => sshProjectManager?.refForProject(projectId) ?? null,
  workspaceSshFs,
  // A throttled trailing write that fails after its optimistic ack re-owes the mirror, so the
  // next save retries instead of believing the server file landed.
  (projectId) => workspaceStore.markUnmirrored(projectId)
)
const workspaceStore = new WorkspaceStore(remoteWorkspaceIO)
// Watch each local ref's project.json for outside edits (git pull, a teammate's commit).
// Self-writes match the store's last-written cache and are ignored. Re-synced after every
// store load/save via onPersist; disposed on quit next to ptyManager.killAll().
const workspaceWatcher = new WorkspaceWatcher({
  paths: () => workspaceStore.localRefPaths(),
  isSelfWrite: (p, c) => workspaceStore.isSelfWrite(p, c),
  onExternalChange: (filePath) => {
    void workspaceStore.readLocalRefByPath(filePath).then((changed) => {
      if (changed) sendToMain(IPC.workspaceExternalChange, changed)
    })
  }
})
workspaceStore.onPersist = () => {
  workspaceWatcher.sync()
  refreshNodeTokens()
}
const gitService = new GitService()

// Project setup/archive runner (SDD: 2026-08-19-project-settings-trust). The trust store is keyed
// by LOCATION, never project id (hostile-project-json), so one instance covers every project.
// `readSettings` reuses WorkspaceStore's own resolution instead of re-reading disk. `ProjectSetupService`
// already matches `ProjectSetupHandlerService`'s shape, so it is passed straight through — the
// TRUST boundary (deriving rootPath/ssh/projectName from THIS machine's own index by projectId,
// never the renderer, and re-validating `worktreePath` against the project's actual git worktrees)
// lives centrally in `registerProjectSetupHandlers` itself (project-setup-handlers.ts), shared with
// the Server Edition below instead of re-implemented per shell.
const projectTrustStore = new ProjectTrustStore()
const projectSetupService = new ProjectSetupService({
  trust: projectTrustStore,
  readSettings: (projectId) => workspaceStore.readProjectSettings(projectId),
  runLocal: makeLocalSetupRunner(),
  // The ssh leg streams over the project's LIVE ControlMaster, resolved lazily (the manager is
  // created only once the window is ready) on the FULL endpoint — host+user+port+remoteCwd, not the
  // cwd alone: the default remoteCwd is `~`, and one `user@host` can be several machines on
  // different ports. A project with no matching live connection resolves to null and the runner
  // reports that as a failed run rather than dialing a fresh connection. Server Edition has no
  // ssh-project manager at all, so it wires `runLocal` only and an ssh target there stays
  // `{status:'skipped', reason:'unavailable'}`.
  runSsh: makeSshSetupRunner((endpoint) => sshProjectManager?.refForEndpoint(endpoint) ?? null),
  // The trust prompt goes to THIS window only — never `platform().broadcast`, which also fans out
  // to every relay peer (a paired phone, another desktop). Broadcasting it would hand a guest the
  // shared script bodies (the exact bytes being approved) and put the host's own trust dialog on
  // their screen. Same main-window-only push the ssh passphrase prompt uses; with the window closed
  // (macOS) the prompt is simply not delivered and the run rides out its expiry as `unanswered`,
  // which is the fail-closed direction.
  sendConsent: (channel, payload) => sendToMain(channel, payload)
})
const projectSetupDeps: ProjectSetupHandlerDeps = {
  projectTargetInfo: (projectId) => workspaceStore.projectTargetInfo(projectId),
  worktreeList: (repoPath) => gitService.worktreeList(repoPath)
}
registerProjectSetupHandlers(corePlatform, projectSetupService, projectSetupDeps)
// `worktree:materialize-shared` — same sibling-registrar shape and the SAME trust boundary as the
// setup runner (rootPath/ssh derived from THIS process's index by projectId, `worktreePath`
// re-validated against the project's actual git worktrees); the sharedPaths LIST is read here by
// projectId, never taken off the wire. Reuses the very `projectTargetInfo`/`worktreeList` the setup
// deps already carry, plus the store's own settings resolution.
registerWorktreeSharedPathsHandlers(corePlatform, {
  readSettings: (projectId) => workspaceStore.readProjectSettings(projectId),
  targetInfo: projectSetupDeps.projectTargetInfo,
  worktreeList: projectSetupDeps.worktreeList
})
// `project-settings:launch-info` — a sibling registrar (not a widening of
// WorkspaceStore.registerIpc()) sharing the trust store constructed above.
registerProjectLaunchInfoHandlers(corePlatform, workspaceStore, projectTrustStore)
// The SAME settings + trust pieces, aimed at the SPAWN (consumption Task 4): a session opened for a
// project gets that project's env and terminal program, with the shared half admitted only by the
// trust verdict `launch-info` reports from. `requestTrust` reuses the very requester the
// `projectSetupRequestTrust` channel uses, so a spawn that refuses a shared value raises exactly the
// dialog the renderer's own ask would — single-flighted inside `ensureFamilyTrusted`, so five nodes
// launching at once raise one. Wired here (not in `ptyManager.init`) so both shells can call it
// wherever their stores happen to be constructed.
ptyManager.setProjectSpawnOverrides(
  makeProjectSpawnOverrides({
    readSettings: (projectId) => workspaceStore.readProjectSettings(projectId),
    targetInfo: (projectId) => workspaceStore.projectTargetInfo(projectId),
    trust: projectTrustStore,
    requestTrust: makeProjectTrustRequester(projectSetupService, projectSetupDeps)
  })
)

// Markers delimiting the `projects.list` relay blob. The iOS client splits on these exact
// strings to recover [workspace.json | newline-joined tmux session names | agent-status.json],
// matching the SSH browse pipeline it already uses — keep them in sync with NodetermProjects.swift.
const NT_PROJECTS_MARK = '--NT-PROJECTS-SPLIT--'
const NT_STATUS_MARK = '--NT-STATUS-SPLIT--'

/**
 * Build the marker-delimited projects blob served over the relay's `projects.list` RPC. Reads the
 * same files the SSH browse path reads locally on the host (no SSH): `workspace.json` +
 * `agent-status.json` under userData, plus the live nodeterm tmux session names. Every read is
 * best-effort (missing files degrade to an empty section) so this never throws.
 */
async function listProjectsOutput(): Promise<string> {
  const dir = app.getPath('userData')
  // Serve the ASSEMBLED v2-shaped workspace, never the raw workspace.json. Post-migration the file
  // is a v3 index ({version:3, entries:[…]}) whose local-ref entries hold no node data at all — the
  // paired iOS client decodes `{ projects: [Project] }`, so a raw v3 file lists zero projects.
  // load() re-reads each ref's .nodeterm/project.json and returns {version:2, projects:[…]}; it is
  // idempotent (and re-syncs the watcher via onPersist), so calling it here is safe.
  const workspace = await workspaceStore
    // Read-only: a phone listing projects mid git-merge must NOT sideline a conflict-marked
    // project.json to `.corrupt-<ts>` (the probe/watcher-path fix); sideline is boot/renderer-only.
    .load({ sideline: false })
    .then((w) => JSON.stringify(w))
    .catch(() => '')
  const status = await readFile(join(dir, 'agent-status.json'), 'utf8').catch(() => '')
  const sessions = (await ptyManager.listNodetermSessions().catch(() => [])).join('\n')
  return `${workspace}\n${NT_PROJECTS_MARK}\n${sessions}\n${NT_STATUS_MARK}\n${status}`
}

// Remote git routing is scoped to the ACTIVE project only (set via `git:set-active-remote`).
// A global cwd-keyed match would misroute when two SSH projects share a remote path, or when a
// LOCAL project's cwd equals a connected SSH project's remoteCwd. The renderer drives this on every
// project switch: the active SSH project's ref, or null for a local project (→ all git runs local).
let activeRemote: { cwd: string; ref: GitRemoteRef } | null = null

// The single app window is tracked in ./main-window (setMainWindow/getMainWindow) and
// resolved AT SEND TIME everywhere — a closure-captured window goes stale after the
// macOS close→dock-reopen cycle and silently swallows every send.
// True from the first before-quit on: lets window close-events through (see hide-on-close).
let quitting = false

// Confirm-before-quit gate. Set once the user has answered "Quit" in the dialog below, or when
// a quit is app-initiated rather than user-initiated (auto-update restart) and should not be
// interrupted by a prompt for a decision already made. `pending` dedupes concurrent triggers
// (shortcut + menu + window-close firing in the same tick) into a single dialog.
let quitConfirmed = false
let skipQuitConfirmation = false
let quitConfirmationPending = false

/** Resolves true once quitting may proceed. Shows a native confirm dialog (all platforms) on
 * first call; a Quit answer is remembered so the re-issued app.quit() below is not re-prompted.
 * Read at ASK TIME, not captured: the Settings toggle must apply to the very next ⌘Q. */
function confirmQuit(parentWin: BrowserWindow | null): Promise<boolean> {
  if (!settingsStore.get().confirmBeforeQuit) return Promise.resolve(true)
  if (quitConfirmed || skipQuitConfirmation) return Promise.resolve(true)
  if (quitConfirmationPending) return Promise.resolve(false)
  quitConfirmationPending = true
  const opts = {
    type: 'question' as const,
    buttons: ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    title: 'Quit nodeterm?',
    message: 'Quit nodeterm?',
    detail: 'Terminal sessions keep running in the background and will still be here next time you open nodeterm.'
  }
  const p =
    parentWin && !parentWin.isDestroyed() ? dialog.showMessageBox(parentWin, opts) : dialog.showMessageBox(opts)
  return p.then(({ response }) => {
    quitConfirmationPending = false
    const confirmed = response === 1
    if (confirmed) quitConfirmed = true
    return confirmed
  })
}

// Keep-awake tracker (created in whenReady next to the notch HUD, disposed in before-quit).
let keepAwake: KeepAwakeTracker | undefined

// Browser <webview> guest webContents id → the browser node (and which of its two surfaces) it
// belongs to. Used today for new-window capture; every entry is proven to BE a <webview> before it
// lands here — see `registerBrowserGuest`.
const browserGuests = new Map<number, BrowserGuest>()

// Node → live tail bookkeeping, so closing a node (× → pty:destroy) releases its file tailers.
// Without this, a node closed mid-run never emits SessionEnd/PostToolUse, so context-tail (1s
// poll) and subagent-tail (400ms poll) would keep stat/read-ing forever. Keyed by node id.
// nodeId → the agent session id of whichever hook-capable CLI runs in that node (claude's, and
// since the grok branch in the raw listener, grok's).
const nodeContextSession = new Map<string, string>()
const nodeSubagents = new Map<string, Set<string>>() // nodeId → active subagent tool_use_ids

// Enforce a single instance. A second instance would re-attach every node's tmux session
// (`new-session -A -D`), whose `-D` detaches the first instance's clients — leaving
// "[detached (from session ...)]" dead terminals. Bail out and focus the existing window
// instead. (This guards against a stray real GUI launch.)
const gotSingleInstanceLock = NT_MULTI || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

// Declare the nt-media:// scheme privileged BEFORE the app is ready (required by Electron).
// The actual request handler is installed post-ready via initMediaProtocol().
registerMediaScheme()

// Raise the soft file-descriptor limit (macOS/Linux; no-op elsewhere). macOS launches GUI apps
// with a soft limit of 256, which a canvas full of terminals genuinely needs to exceed: every
// attached PTY holds a master fd here, plus hook-server sockets and transcript tails. 256 was
// hit in the field (posix_spawnp failures with ~34 terminals in one project).
if (process.platform !== 'win32' && typeof process.setFdLimit === 'function') {
  try {
    process.setFdLimit(8192)
  } catch (e) {
    console.warn('[main] could not raise fd limit', e)
  }
}

/**
 * Build the native application menu. The View submenu is the home of the Snap-to-Grid mode
 * toggle (with a real native checkmark — `checked` reflects `settings.autoAlignGrid`), plus Fit
 * View and the Kanban / Canvas view toggle. Menu clicks send IPC to the renderer, which owns the
 * canvas state.
 *
 * Rebuilt on every settings change (see the `settingsStore.onChange` hook in `whenReady`) so the
 * Snap-to-Grid checkmark and the Kanban/Canvas label stay live — the renderer is the sole settings
 * writer, so a change persists through `settingsStore` and fires this rebuild. No reverse IPC.
 */
function buildAppMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin'
  const s = settingsStore.get()
  const send = (channel: string): void => {
    if (!win.isDestroyed()) win.webContents.send(channel)
  }
  // ONE object, placed into BOTH templates below (mac's app menu, off-mac's own `Settings` menu),
  // so `MENU_ITEM_ID_SETTINGS` resolves on every platform — which is why `menuItemIdsToSuspend`
  // lists it unconditionally. ⌘, is an ordinary registry command (`app.settings`), not an
  // intercepted chord: the menu just takes it above the page, and disabling this item under the
  // stand-down is the only way it can reach a focused terminal.
  const settingsItem: Electron.MenuItemConstructorOptions = {
    id: MENU_ITEM_ID_SETTINGS,
    label: isMac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => send(IPC.appOpenSettings)
  }
  // The kanban toggle's label depends on which view is active. The renderer owns that state; main
  // can't read it, so the label is generic and the renderer's handler decides direction. (A live
  // label would need a reverse-IPC the renderer drives on toggle — out of scope for this change.)
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    // Restored from Electron's default View menu, which the custom menu replaced. Reloading the
    // renderer is a real recovery lever and safe here: the tmux sessions live in the MAIN process,
    // so a reload only re-hydrates the canvas from the workspace store — it never drops a session
    // (same path the crash-reload policy uses). No interceptor claims ⌘R, so the accelerator is
    // honest (unlike ⌘0, which `installKeydownIntercepts` owns for zoom-to-100%).
    //
    // These two carry NO id and are the NAMED EXCEPTION to the stand-down (see
    // `menuItemIdsToSuspend`): ⌘R / ⌘⇧R keep working over a focused terminal under terminal-first,
    // because a renderer wedged badly enough to stop dispatching keys is exactly when the user
    // needs the lever — and the reload is also what resets `terminalFocused` / `shortcutRecording`
    // in main. Do not "complete" the suspend list with them.
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    {
      label: 'Snap to Grid',
      type: 'checkbox',
      checked: s.autoAlignGrid === true,
      click: () => send(IPC.appToggleAutoAlign)
    },
    {
      // No accelerator: `installKeydownIntercepts` already claims ⌘0 for zoom-to-100% before the
      // renderer sees it, so labelling this item "⌘0" would show a shortcut that does something
      // else. The item stays click-only; the renderer's own Shift+1 chord is the keyboard route to
      // Fit View.
      label: 'Fit View',
      click: () => send(IPC.appFitView)
    },
    {
      // `viewSubmenu` goes into BOTH templates, so this id resolves on every platform (the same
      // reason `menuItemIdsToSuspend` lists it unconditionally). ⌘⇧B is a registry command
      // (`view.kanbanToggle`) the menu happens to own above the page; suspending the item is what
      // lets a terminal-first user's ⌘⇧B reach the shell like every other chord.
      id: MENU_ITEM_ID_KANBAN,
      label: 'Toggle Kanban Board',
      accelerator: 'CmdOrCtrl+Shift+B',
      click: () => send(IPC.appToggleKanban)
    },
    { type: 'separator' },
    // Also restored from the default menu: Enter Full Screen (Ctrl+⌘F on mac, F11 on Linux).
    { role: 'togglefullscreen' }
  ]
  const template: Electron.MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            settingsItem,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' }
          ]
        },
        { label: 'View', submenu: viewSubmenu },
        {
          label: 'Window',
          // `id` on minimize: `syncMenuForStandDown` disables it while EITHER stand-down is in
          // effect — a terminal focused under terminal-first, or an armed shortcut recorder — so
          // ⌘M falls through to the terminal, or to the recorder, instead of minimizing the
          // window. mac has no `{role:'close'}` here at all — which is why the intercept is ⌘W's
          // only handler on mac.
          submenu: [
            { role: 'minimize', id: MENU_ITEM_ID_MINIMIZE },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' }
          ]
        }
      ]
    : [
        { label: 'File', submenu: [{ role: 'quit' }] },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'delete' },
            { role: 'selectAll' }
          ]
        },
        { label: 'View', submenu: viewSubmenu },
        { label: 'Settings', submenu: [settingsItem] },
        // Both ids matter off-mac: `{role:'close'}` owns Ctrl+W here, which is readline's kill-word
        // in a terminal — a stand-down that left it enabled would CLOSE the window on a keystroke
        // a terminal-first user meant for their shell.
        {
          label: 'Window',
          submenu: [
            { role: 'minimize', id: MENU_ITEM_ID_MINIMIZE },
            { role: 'close', id: MENU_ITEM_ID_CLOSE }
          ]
        }
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // A REBUILD resets every item to `enabled: true`, and this function runs on every settings
  // change — so without this line, a terminal-first user with a terminal focused would have ⌘M
  // silently start minimizing again the moment they toggled any unrelated setting. The sync is
  // idempotent and cheap; it belongs at the end of every path that installs a menu, not only at
  // the paths where the stand-down state changes.
  syncMenuForStandDown()
}

/**
 * Enable/disable the menu items whose ACCELERATORS would otherwise beat a stand-down.
 *
 * **Two stand-downs share this leg**, composed by `menuStandsDown(shortcutRecording, policy,
 * terminalFocused)`: the terminal-first policy (below) and an armed Settings shortcut RECORDER.
 * The recorder needs it for the same structural reason and a different destination — a menu
 * accelerator is handled above the page, so while it was armed ⌘M minimized the window, ⌘⇧B opened
 * the kanban board behind the dialog and ⌘, re-opened Settings, none of them recordable. With the
 * items suspended those chords reach the recorder. **Reload is still not among them** (see below),
 * so ⌘R / ⌘⇧R remain unrecordable by design. The two INTERCEPT thunks stay independent parameters
 * on `installKeydownIntercepts`; only this single `enabled` boolean ORs them.
 *
 * `installKeydownIntercepts` standing down means only that main stops calling `preventDefault` —
 * the key then reaches the page, and if the page ignores it, the MENU, which is handled above the
 * page either way. So under `terminal-first` with a terminal focused, ⌘M would still hit
 * `{role:'minimize'}` and (Windows/Linux) Ctrl+W would still hit `{role:'close'}` — the latter
 * closing the window on what a terminal user means as readline's kill-word, i.e. strictly worse
 * than not having the policy at all. Disabling the item suppresses its accelerator, so the chord
 * falls through: page → the renderer's dispatcher (terminal context under terminal-first, where
 * nothing matches) → xterm → the PTY. That is what makes "everything reaches the shell" true for
 * ⌘M and Ctrl+W too, not just for ⌘0 and mac's ⌘W.
 *
 * The list is `menuItemIdsToSuspend` and it also carries **Toggle Kanban Board (⌘⇧B)** and
 * **Settings (⌘,)** on every platform. Those two are not intercepted chords at all — they are
 * ordinary registry commands the menu simply takes above the page, which is why the dispatcher
 * never sees them and could not stand them down itself. **Reload (⌘R / ⌘⇧R) is the named
 * exception** and stays live while stood down; see `menuItemIdsToSuspend`'s comment for why.
 *
 * Called from every place the composed answer can change — the `ui:terminal-focus` receiver, the
 * `ui:shortcut-recording` receiver (the recorder arms and disarms once per chord the user records),
 * the policy recompute in `settingsStore.onChange`, `clearRendererKeyState` (which clears BOTH
 * bits), and the end of `buildAppMenu` (a rebuild resets `enabled`). NEVER per keystroke: this is a
 * menu mutation, and `before-input-event` is the one path in the app where work is measured in
 * keystrokes.
 *
 * FAIL-SAFE: a missing menu, or an item id that no longer resolves, does nothing at all. That
 * leaves the pre-feature behaviour (menu enabled, intercepts deciding), which is the direction
 * where the app still works — the cost is that a silent id drift is invisible, which is why both
 * sides of the lookup use the same exported constants rather than string literals.
 *
 * KNOWN COST, deliberate: while either stand-down holds, every suspended item — Window ▸ Minimize,
 * View ▸ Toggle Kanban Board, Settings, and off-mac Window ▸ Close — is greyed out to the MOUSE as
 * well. They re-enable the moment focus leaves the terminal, or the recorder disarms (and the
 * traffic-light button is unaffected), so this is a visible but self-healing trade. The alternative
 * — rebuilding the whole menu without those accelerators on every focus change — costs a menu
 * rebuild per click between the canvas and a terminal, and closes any menu the user has open. For
 * the recorder the trade is smaller still: the greyed items sit behind a modal dialog the user
 * opened to record a chord, and the alternative was four chords they could not bind at all.
 *
 * UNTESTED, and here is why: this is Electron menu mutation reached through the module-level
 * `Menu` singleton inside `src/main/index.ts`, which no test imports (the same gap the intercept
 * WIRING has — see `keydown-intercept.ts`'s header on why the decision lives in a pure module).
 * The testable parts were extracted: `menuStandsDown` (the composed state) over `policyStandsDown`
 * (the policy half) and `menuItemIdsToSuspend` (the list, including the mac/non-mac asymmetry), all
 * pinned in `keydown-intercept.test.ts`.
 */
function syncMenuForStandDown(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const enabled = !menuStandsDown(shortcutRecording, currentInterceptPolicy(), terminalFocused)
  for (const id of menuItemIdsToSuspend(interceptIsMac)) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = enabled
  }
  // The CLOSE item's extra, policy-independent stand-down (issue #383): off-mac its role owns the
  // Ctrl+W accelerator above the page, and while a terminal has focus that keystroke is readline's
  // kill-word. Applied ON TOP of the shared suspension — the item must never be MORE enabled than
  // the shared rule says. Mac has no close item in the template, so the lookup is null there and
  // this is a no-op by construction.
  if (closeStandsDownInTerminal(interceptIsMac, terminalFocused)) {
    const close = menu.getMenuItemById(MENU_ITEM_ID_CLOSE)
    if (close) close.enabled = false
  }
}

function createWindow(): BrowserWindow {
  // On Linux the window/taskbar icon is not supplied by an app bundle (unlike macOS),
  // so set it explicitly from the bundled png (extraResources). mac/win are untouched —
  // an icon there would do nothing useful and could clobber the bundled .icns.
  const linuxIcon =
    process.platform === 'linux'
      ? app.isPackaged
        ? join(process.resourcesPath, 'icon.png')
        : join(__dirname, '../../build/icon.png')
      : undefined
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#1e1e1e',
    // NT_MULTI instances are throwaway dev sandboxes: label the window so a second instance is
    // never mistaken for the real one (the dock already shows the Electron icon in dev).
    title: NT_MULTI ? 'node-terminal (test instance)' : 'node-terminal',
    icon: linuxIcon,
    // Integrate the macOS traffic lights into our top bar (modern Mac app look). Both options are
    // macOS-only in Electron, and the renderer's tab bar reserves its 86px of left padding for
    // exactly this window shape — so state the platform here rather than leaving it to Electron to
    // ignore the values elsewhere (issue #564). Windows/Linux keep their native frame, unchanged.
    ...macTitleBarOptions(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enables the <webview> tag used by WebNode (embedded content stays locked down —
      // no nodeintegration is set on the webview element itself).
      webviewTag: true,
      // Chromium's built-in PDF viewer is gated behind `plugins`, and without it an EditorNode
      // showing a .pdf renders nothing at all. This is not the old NPAPI/Flash surface (that is
      // long gone from Chromium) — in a current Electron the only thing it turns on is the PDF
      // viewer. The browser (Server Edition) needs no equivalent: it has the viewer already.
      plugins: true
    }
  })

  // Register as the live main window (send-time resolution via getMainWindow/sendToMain).
  setMainWindow(win)

  // Team presence: this window is one peer. With nobody else connected the renderer draws nothing
  // (≤1 peer = zero cost); it matters when a phone joins over the relay, or when this desktop
  // hosts. Its ClientId is the webContents id — the same id space sendTo/handleWithSender use.
  // `closed` (not `close` — which only hides the window on macOS) is the real departure.
  // (The id is captured up front: reading `win.webContents` after 'closed' throws — the window and
  // its webContents are destroyed by then.)
  const presenceId = win.webContents.id
  presenceHub.join(presenceId, 'desktop')
  win.on('closed', () => {
    presenceHub.leave(presenceId)
    // This webContents is a pty SUBSCRIBER (co-attach: one pty, N subscribers, keyed by the
    // webContents id). A destroyed window sends no `pty:kill`, so without this it would stay
    // subscribed forever: the pty client is never released, the detach-time scrollback snapshot
    // is skipped, and a session it had paused via flow control could never be resumed — the next
    // client to co-attach to that node would inherit a frozen terminal. The tmux sessions
    // themselves keep running, exactly as they do on quit (killAll).
    ptyManager.dropClient(presenceId)
    // The window that armed the recorder — or reported a focused terminal — is gone, so nothing
    // can ever release either bit. Leaving one set would suppress ⌘W/⌘M/⌘0 for the NEXT window too
    // (the flags outlive the window; a dock reopen builds a fresh one). Same shape as the
    // dropClient above: state this window owned, released where its departure is observed.
    clearRendererKeyState()
  })
  // A crashed/killed renderer is the same story, minus the window: drop its subscriptions so the
  // reloaded renderer reattaches to live sessions instead of inheriting the dead one's state.
  // And actually reload — a dead renderer otherwise leaves the window a permanent blank page
  // (both projects, every terminal). Bounded by the policy so a boot-path crash can't loop;
  // past the budget the user decides. The tmux sessions all live in this process, so a reload
  // costs nothing but the canvas re-hydrating from the workspace store.
  // Trackpad-vs-mouse ground truth for the canvas wheel router: macOS wraps trackpad scrolls and
  // pinches in gesture begin/end events a wheel mouse never emits, visible only here in main.
  // The ledger reduces the raw stream (which includes every ~120Hz pointer packet — observe() is
  // one prefix test on the hot path) to edge transitions, so the renderer hears a few messages per
  // physical gesture. See main/trackpad-gesture.ts and canvas/wheel-gesture.ts for the two halves
  // of the contract.
  //
  // Attached on macOS ONLY (issue #535). It used to be unconditional on the grounds that these
  // events never fire elsewhere — but Chromium synthesizes gesture scroll events for TOUCHSCREEN
  // scrolling on Windows and Linux too, so a touch-enabled non-mac machine paid per-gesture IPC
  // for a flag the renderer's router discards off macOS. Gating the attach makes the "desktop
  // macOS only" contract true by construction rather than by the consumer's good manners.
  if (process.platform === 'darwin') {
    const trackpadLedger = new TrackpadGestureLedger()
    const sendGesture = (active: boolean): void => {
      if (!win.isDestroyed()) win.webContents.send(IPC.canvasTrackpadGesture, active)
    }
    win.webContents.on('input-event', (_event, input) => {
      const active = trackpadLedger.observe(input.type)
      if (active !== null) sendGesture(active)
    })
    // A gesture cannot survive a focus loss, and an End that never arrives (⌘Tab / hide / minimize
    // mid-scroll) would otherwise leave the ledger stuck open for the life of the window — with
    // wheel zoom silently dead until restart. `reset()` reports whether anything was actually
    // open, so an ordinary blur between gestures sends nothing.
    win.on('blur', () => {
      if (trackpadLedger.reset()) sendGesture(false)
    })
  }
  const crashReload = createCrashReloadPolicy()
  win.webContents.on('render-process-gone', (_event, details) => {
    ptyManager.dropClient(presenceId)
    // A dead renderer sends no disarm and no focus-lost report. The reloaded page mounts no
    // recorder and no terminal, so without this the user would come back to an app where ⌘W does
    // nothing at all (recording) or minimizes the window (stood down).
    clearRendererKeyState()
    if (quitting || win.isDestroyed()) return
    const action = crashReload(details.reason, Date.now())
    if (action === 'reload') {
      win.webContents.reload()
    } else if (action === 'give-up') {
      void dialog
        .showMessageBox(win, {
          type: 'error',
          message: 'The window keeps crashing',
          detail: `The interface process died repeatedly (${details.reason}). Your terminal sessions are still running.`,
          buttons: ['Reload', 'Not Now'],
          defaultId: 0,
          cancelId: 1
        })
        .then(({ response }) => {
          if (response === 0 && !win.isDestroyed()) win.webContents.reload()
        })
    }
  })

  win.on('ready-to-show', () => win.show())
  // The main window is a regular app window; establishing its Dock presence explicitly means the
  // later focusable:false Notch HUD panel can never leave the app looking like an accessory.
  win.on('show', () => assertRegularDockPresence())

  // macOS: closing the window hides it instead of destroying it. The app deliberately
  // outlives its window (tmux sessions, hook server, updater); destroying the window
  // would leave every window-bound subsystem (agent-status forwarding, tails, updater,
  // license events) pointing at a dead webContents after a dock-reopen.
  // A fullscreen window must LEAVE fullscreen before it hides: hiding in place strands the
  // window's empty Space as a black screen (issue #78 / electron/electron#20263). The
  // transition is async, so the hide waits for `leave-full-screen`; `leavingFullScreen`
  // keeps a second ⌘W during the transition from stacking another listener.
  let leavingFullScreen = false
  win.on('close', (e) => {
    const action = closeAction(process.platform, quitting, win.isFullScreen())
    if (action === 'hide') {
      e.preventDefault()
      win.hide()
      return
    }
    if (action === 'leave-fullscreen-then-hide') {
      e.preventDefault()
      if (!leavingFullScreen) {
        leavingFullScreen = true
        win.once('leave-full-screen', () => {
          leavingFullScreen = false
          if (!win.isDestroyed() && !quitting) win.hide()
        })
        win.setFullScreen(false)
      }
      return
    }
    // action === 'default': the window is really closing. On Windows/Linux the native title-bar
    // × reaches this directly (no app.quit() first), so the confirm gate must sit here too, not
    // only in before-quit — otherwise the window (and with it the only place to show a dialog)
    // would already be gone by the time we asked.
    if (!quitConfirmed && !skipQuitConfirmation) {
      e.preventDefault()
      void confirmQuit(win).then((ok) => {
        if (ok) app.quit()
      })
    }
  })

  // Steal ⌘M / ⌘W / ⌘0 back from Electron's default application menu (minimize / close /
  // resetZoom) and forward each to the renderer instead. The decision — and, importantly, what it
  // must REFUSE — is in `keydown-intercept.ts`, where it can be pressed by a test. The first two
  // are the user's effective `node.toggleMarkdown` / `node.close` bindings (⌘0 is not remappable).
  // The two suspensions are separate thunks on purpose (see `installKeydownIntercepts`): the
  // recorder suspends ALWAYS, the policy only while the mirror says a terminal has focus. Both are
  // read per keystroke — the settings memo and the mirror both change under a live window.
  installKeydownIntercepts(
    win,
    currentInterceptBindings,
    interceptIsMac,
    () => shortcutRecording,
    () => policyStandsDown(currentInterceptPolicy(), terminalFocused),
    // The close leg's own, policy-independent stand-down (issue #383) — see the predicate's doc.
    () => closeStandsDownInTerminal(interceptIsMac, terminalFocused)
  )

  // The THIRD way the page that armed a recorder (or reported terminal focus) can go away: a
  // reload. The View menu above restores `{role:'reload'}` / `{role:'forceReload'}`, and ⌘R/⌘⇧R are
  // accelerators — handled above the page, so the recorder cannot preventDefault its way out of
  // one, and a same-process reload fires neither `closed` nor `render-process-gone`.
  // `navigationClearsRecording` is the (tested) filter: a same-document navigation is the SAME page
  // with the recorder still armed and the terminal still focused, and a subframe is not this page
  // at all.
  win.webContents.on('did-start-navigation', (details) => {
    if (navigationClearsRecording(details)) clearRendererKeyState()
  })

  // Open external links in the system browser — only safe schemes (no file://, no custom
  // protocol handlers). Reachable from remotely-fetched announcement URLs and rendered
  // markdown links, so the allowlist mirrors the shellOpenExternal IPC handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block any in-page top-level navigation away from the app origin (defense in depth).
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '\0')) {
      e.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })

  // Load the electron-vite dev server if present, otherwise the built file.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return // losing second instance — quitting; don't touch tmux

  // Harden every <webview> guest (WebNode runs its page in its own webContents, so the main
  // window's setWindowOpenHandler / will-navigate above don't cover it). Registered once at
  // startup for all current and future guests.
  app.on('web-contents-created', (_e, contents) => {
    // Mirror renderer consoles into the debug ring (issue #78) — a packaged app swallows them
    // too, and React error boundaries report through console.error. All webContents kinds:
    // the main window and webview guests alike.
    contents.on('console-message', (event) => {
      try {
        const level = event.level === 'error' ? 'error' : event.level === 'warning' ? 'warn' : 'info'
        // Keep the renderer's own [tag] prefixes — the deliberate field traces ([nodeterm]
        // healed-swap strands, [glyphgrid] attach/geometry warnings) are exactly what this panel
        // is for, and they triage by tag. Untagged lines fall back to 'renderer'.
        const { tag, rest } = splitTag(String(event.message ?? ''))
        logBuffer.push({ level, tag: tag || 'renderer', msg: rest })
      } catch {
        /* logging must never break a page */
      }
    })
    if (contents.getType() !== 'webview') return
    // Web nodes may only show http(s) pages, jailed nt-media:// content, or origin-gated
    // local file:// pages (policy + tests in webview-nav.ts).
    contents.on('will-navigate', (e, url) => {
      if (!allowGuestNavigation(contents.getURL(), url)) e.preventDefault()
    })
    // A browser node's guest requested a new window → open it as another browser node
    // (never a real popup). Only http(s); other schemes are dropped. The map is consulted
    // live at call time, so a guest registered later (on dom-ready) is seen when a popup fires.
    contents.setWindowOpenHandler(({ url }) => {
      const sourceNodeId = browserGuests.get(contents.id)?.nodeId
      if (sourceNodeId && /^https?:\/\//i.test(url)) {
        sendToMain(IPC.browserNewWindow, { url, sourceNodeId })
      }
      return { action: 'deny' }
    })
    // Electron ships no context menu for web content, so a right-click inside a guest page did
    // nothing at all. Passing `frame` is what turns on macOS's own AutoFill, Writing Tools and
    // Services submenus (off by default in Electron): that is the "AutoFill > Passwords..." row
    // on a password field. Template and its refusals: webview-context-menu.ts.
    contents.on('context-menu', (_e, params) => {
      const template = guestContextMenuTemplate(
        {
          linkURL: params.linkURL,
          srcURL: params.srcURL,
          mediaType: params.mediaType,
          hasImageContents: params.hasImageContents,
          isEditable: params.isEditable,
          selectionText: params.selectionText,
          misspelledWord: params.misspelledWord,
          dictionarySuggestions: params.dictionarySuggestions,
          editFlags: params.editFlags,
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward()
        },
        {
          back: () => contents.navigationHistory.goBack(),
          forward: () => contents.navigationHistory.goForward(),
          reload: () => contents.reload(),
          // Same route a popup takes: a new browser node, never a real window.
          openLinkInNode: (url) => {
            const sourceNodeId = browserGuests.get(contents.id)?.nodeId
            if (sourceNodeId) sendToMain(IPC.browserNewWindow, { url, sourceNodeId })
          },
          copyText: (text) => clipboard.writeText(text),
          copyImage: () => contents.copyImageAt(params.x, params.y),
          replaceMisspelling: (word) => contents.replaceMisspelling(word),
          inspect: () => contents.inspectElement(params.x, params.y)
        }
      )
      // `frame` is null once the frame navigated away or died; the menu still opens, just without
      // the AppKit additions.
      Menu.buildFromTemplate(template).popup(params.frame ? { frame: params.frame } : {})
    })
  })

  settingsStore.init()
  // The linked-account resolver's one source of truth on this shell. Registered as
  // soon as settings exist — not down beside `initTranscriptIndex`, where the other account wiring
  // sits — because EVERY config-dir resolution has to be able to see it, including the earliest:
  // the mirror settings provider is a lazy callback and an agent-status flush can fire from the
  // `claudeCliCaps()` probe before boot reaches that point. An unregistered source means "no
  // linked accounts", so such a flush would advertise a managed dir that does not exist for a
  // linked row, and the phone would launch under it. The Server Edition registers the identical
  // getter at the same point in its own boot.
  registerClaudeAccountsSource(() => settingsStore.get().claudeAccounts ?? [])
  const gatewayCredentials = new ModelGatewayCredentialService(
    new ElectronSecretStore(app.getPath('userData'), safeStorage, MODEL_GATEWAY_SECRET_FILE)
  )
  await gatewayCredentials.init()
  try {
    const migratedGateway = await migrateLegacyModelGatewayKey(
      settingsStore.get().modelGateway,
      gatewayCredentials
    )
    if (migratedGateway) {
      await settingsStore.save({ ...settingsStore.get(), modelGateway: migratedGateway })
    }
  } catch (error) {
    // Preserve the legacy literal in settings when the keyring/file write fails; migration can
    // retry next launch, and the user never loses their only copy of the credential.
    console.warn('[model-gateway] could not migrate the legacy API key to secret storage', error)
  }
  settingsStore.registerIpc()
  sshStore.registerIpc()
  // Gateway discovery/credential IPC (peer-reachable by design; the renderer never receives a
  // stored literal key, and discovery resolves key REFERENCES only for the saved gateway URL).
  registerAgentEnvIpc(() => settingsStore.get().modelGateway, gatewayCredentials)
  // The `${env:VAR}` snapshot for custom-agent expansion is DESKTOP-WINDOW-ONLY, so it is a raw
  // `ipcMain.handle` on purpose (see the handler-table comment in platform-electron.ts): a
  // `platform().handle` registration would answer relay peers too — a paired phone or remote tab
  // could read every API key in this process's environment. The browser/relay bridges hardcode
  // an empty snapshot instead, and expansion there degrades to the missing-env refusal.
  ipcMain.handle(IPC.envSnapshot, () => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  })
  ptyManager.init(
    () => settingsStore.get(),
    () => gatewayCredentials.readForHost()
  )
  ptyManager.registerIpc()
  workspaceStore.registerIpc()
  gitService.registerIpc()
  presenceHub.registerIpc()
  registerSpeechIpc({
    handle: (channel, fn) => corePlatform.handle(channel, fn),
    service: speechService,
    models: whisperModels,
    settings: () => settingsStore.get(),
    licenseToken: () => getStoredEntitlement(),
    apiBase: RELAY_API_BASE
  })
  // Electron-only mic consent: not core-bound (systemPreferences is main-process-only), so it's
  // a raw ipcMain handler like the other Electron-only surfaces (dialogs, shell, media) rather
  // than going through registerSpeechIpc/corePlatform.
  ipcMain.handle(IPC.speechMicConsent, async () =>
    process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true
  )
  registerClaudeCliIpc()
  // Invariant 11 for probes: registered in BOTH shells, or session-id minting silently works on
  // the desktop and not in the browser, with nothing to say which.
  registerGrokCliIpc()
  registerCodexIdentityIpc()
  // Warm the `claude --version` probe now (it spawns a login shell + node, ~sub-second) so the
  // renderer's first `claude.cliCaps()` — awaited on the launch path of a cold-restored agent
  // node — resolves from cache instead of racing the probe into a conservative "no auto".
  void claudeCliCaps()

  // REACHABILITY (4c): a handler registered through `corePlatform` serves BOTH the local window
  // (it is still `ipcMain.handle`, bit-for-bit) AND a relay peer (answered from the platform's
  // handler table — a peer has no webContents, so a raw `ipcMain.handle` is invisible to it).
  // Everything core-bound — it acts on THIS machine's state, which is exactly what a remote tab
  // is looking at — goes on the platform. The raw `ipcMain` registrations that remain further down
  // are deliberate: each one must act on the USER's machine (dialogs, shell, notifications,
  // updater) or is part of the host's own trust/relay control plane (pairing, remote:*, accounts).
  corePlatform.handle(IPC.commitGenerate, (cwd: string) =>
    generateCommitMessage(cwd, settingsStore.get())
  )

  ipcMain.handle(IPC.mediaAllow, (_e, absPath: string) => allowMediaPath(absPath))
  ipcMain.handle(IPC.mediaWriteHtml, (_e, html: string) => writeAgentHtml(html))

  ipcMain.on(
    IPC.browserRegister,
    (_e, webContentsId: number, nodeId: string, surface?: BrowserSurfaceKind) => {
      // `surface` is passed through UNCHANGED, including when it is absent. Both mount sites
      // (BrowserNode and the kanban CardModal) still send two arguments, so today it is always
      // absent — and defaulting it to 'canvas' here would record every modal guest as a canvas
      // guest, which is a false claim a later reverse lookup cannot detect. See `BrowserGuest`.
      if (
        !registerBrowserGuest(browserGuests, webContentsId, nodeId, surface, (id) =>
          webContents.fromId(id) ?? null
        )
      ) {
        // Loud, because the symptom otherwise is "popups from this node stopped opening" with
        // nothing anywhere to explain it.
        console.warn('[browser] refused guest registration', { webContentsId, nodeId, surface })
      }
    }
  )
  ipcMain.on(IPC.browserUnregister, (_e, webContentsId: number) => {
    // The browser node's guest is going away (node closed, project closed/switched, or a discard).
    // Revoke any control lease on it — LIFECYCLE, so no user-stop tombstone. Read the node id BEFORE
    // dropping the guest. A no-op for a node that was never driven.
    const nodeId = browserNodeIdForGuest(webContentsId)
    browserGuests.delete(webContentsId)
    if (nodeId) pushBrowserLeases(revokeBrowserNode(nodeId, browserRevocation, { userStopped: false }))
  })

  // The naming agent runs LOCALLY on captured output, so it needs a cwd that exists on THIS
  // machine. An SSH-project node's `data.cwd` is a path on the REMOTE host — spawning there fails
  // (ENOENT) and the ✦ button silently did nothing. The cwd carries no meaning for naming (the
  // terminal output is in the prompt), so a remote node falls back to '' → runAgent's os.homedir().
  const localNamingCwd = (keys: string[], cwd: string): string =>
    keys.some((k) => ptyManager.sshRemoteForNode(k)) ? '' : cwd

  corePlatform.handle(IPC.ptyGenerateName, async (persistKey: string, cwd: string) =>
    generateTerminalName(
      await ptyManager.captureSession(persistKey),
      localNamingCwd([persistKey], cwd),
      settingsStore.get()
    )
  )

  corePlatform.handle(IPC.ptyGenerateGroupName, async (memberKeys: string[], cwd: string) => {
    const contents = await Promise.all(memberKeys.map((k) => ptyManager.captureSession(k)))
    return generateGroupName(contents, localNamingCwd(memberKeys, cwd), settingsStore.get())
  })

  corePlatform.handle(IPC.ptyCapture, (persistKey: string, full?: boolean) =>
    ptyManager.captureSession(persistKey, full)
  )

  // Gemini's title read needs the transcript path its own context tail already tracks (nothing
  // scans for it). That tail is created ~600 lines below with the rest of the hook plumbing, while
  // this deps object is consumed by the ptyReadSessionName handler just under here and by the
  // session-name sweep further down — so the association is held in a `let` that the tail's
  // creation assigns, NOT closed over as a `const` declared later. The difference matters: closing
  // over the later `const` makes an early call a TDZ **ReferenceError**, and `TerminalNode`'s poll
  // does not catch its `readSessionName` rejection — one throw kills that node's poll chain for the
  // whole mount. A poll CAN fire early: `sessionId` is persisted in localStorage, so a cold
  // relaunch has one before any hook arrives. Undefined-until-assigned degrades instead: no path,
  // no name, next tick tries again. `pathFor` likewise answers undefined for a session no hook has
  // been seen for and for a remote (SSH) gemini node, which the tails deliberately never track —
  // all of which mean "no name", never a throw.
  let geminiTranscriptPathFor: ((sessionId: string) => string | undefined) | undefined
  const agentSessionNameDeps: AgentSessionNameDeps = {
    geminiPathFor: (sessionId) => geminiTranscriptPathFor?.(sessionId)
  }

  // The reader is selected by the NODE's agent (core/agent-session-name.ts — the one copy of that
  // rule, shared with the sweep below and with the Server Edition), so no reader ever searches
  // another's tree. `agentId` is a TRAILING optional argument, so every pre-grok caller resolves
  // through the claude reader unchanged.
  corePlatform.handle(
    IPC.ptyReadSessionName,
    (sessionId: string, accountId?: string, agentId?: string) =>
      readAgentSessionName(sessionId ?? '', accountId, agentId, agentSessionNameDeps)
  )

  ipcMain.on(IPC.appCloseWindow, () => BrowserWindow.getFocusedWindow()?.close())

  // Settings' shortcut recorder arming/disarming. Guarded on the sender being the live main window
  // (the same `getMainWindow()?.webContents.id !== event.sender.id` test `registerElectronGitHubControl`
  // uses): a <webview> guest — a browser node showing an arbitrary page — is a webContents in this
  // process too, and this bit disables the app's own keyboard shortcuts. Resolved at call time, not
  // captured, because the window can be closed and recreated on macOS.
  ipcMain.on(IPC.uiShortcutRecording, (event, active: boolean) => {
    if (getMainWindow()?.webContents.id !== event.sender.id) return
    shortcutRecording = active === true
    // The menu leg follows recording too (`menuStandsDown`), so an arm/disarm owes a sync — that is
    // what lets ⌘M, ⌘⇧B, ⌘, and off-mac Ctrl+W reach the recorder instead of the menu item that
    // owns them. A recorder arms and disarms once per chord the user records, which is the right
    // cadence for a menu mutation; NEVER per keystroke (same rule as the focus mirror below). It
    // must be INSIDE the guard for the same reason as there: a rejected sender must not move the
    // menu either.
    syncMenuForStandDown()
  })

  // The terminal-focus mirror, under the SAME sender guard and for a sharper version of the same
  // reason: a <webview> guest is a webContents in this process, and this bit decides whether the
  // window claims ⌘W/⌘M/⌘0 at all — an arbitrary page in a browser node could otherwise hand
  // itself the window's shortcuts by claiming a terminal is focused. `focused === true` so a
  // malformed payload reads as NOT focused, the fail-safe direction (intercepts on).
  ipcMain.on(IPC.uiTerminalFocus, (event, focused: boolean) => {
    if (getMainWindow()?.webContents.id !== event.sender.id) return
    terminalFocused = focused === true
    // The mirror is change-deduped, so this fires only on a real focus transition — the right
    // cadence for a menu mutation, and the reason the sync is here rather than on the keystroke
    // path. It must be INSIDE the guard: a rejected sender must not move the menu either.
    syncMenuForStandDown()
  })

  // Bring the window forward after a file is dropped into a terminal. On macOS a drag-drop from
  // another app does NOT activate the destination app, so without this the drag-source keeps OS
  // keyboard focus and the user types into the wrong application. `getMainWindow()` (not the
  // focused window — there may be none) restores + shows + focuses.
  ipcMain.on(IPC.appFocusWindow, () => {
    const w = getMainWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    // On macOS `win.focus()` alone won't pull us in front of the still-active drag-source app —
    // app-level focus with `steal` is what actually activates us across apps.
    if (process.platform === 'darwin') app.focus({ steal: true })
    w.focus()
  })

  // System-clipboard write from the MAIN process. Renderer/preload `clipboard` access is deprecated
  // in Electron (logs a warning per call); the renderer sends this instead. Text only, fire-and-forget.
  ipcMain.on(IPC.clipboardWrite, (_e, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.handle(IPC.clipboardWriteFiles, (_e, paths: unknown) =>
    writeFilesToClipboard(paths, {
      platform: process.platform,
      isFile: (path) => statSync(path).isFile(),
      writeBuffer: (format, buffer) => clipboard.writeBuffer(format, buffer)
    })
  )

  // Dock badge: number of Claude nodes with unread output (macOS only). '' clears it.
  ipcMain.on(IPC.appSetBadge, (_e, count: number) => {
    if (process.platform !== 'darwin' || !app.dock) return
    app.dock.setBadge(count > 0 ? String(count) : '')
  })

  // Show an OS notification — but only when the window is in the background. Clicking it
  // brings the app forward and asks the renderer to focus the originating node.
  // Resolves 'shown' | 'failed' | 'skipped' so the renderer can SEE a macOS permission
  // denial (UNErrorCodeNotificationsNotAllowed) instead of it dying silently — that broke
  // once already after an Electron upgrade invalidated the ncprefs signature record.
  ipcMain.handle(
    IPC.appNotify,
    async (_e, payload: { title: string; body: string; nodeId: string; force?: boolean }) => {
      const win = getMainWindow()
      if (!win || !Notification.isSupported()) return 'skipped'
      // `force` (permission request / confirmation) shows even when focused; normal
      // completion notifications only show when the window is in the background.
      if (!payload.force && win.isFocused()) return 'skipped'
      const n = new Notification({ title: payload.title, body: payload.body })
      n.on('click', () => {
        // Re-resolve at click time — the window may have been hidden/recreated since.
        const w = getMainWindow()
        if (!w) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        if (payload.nodeId) w.webContents.send(IPC.appFocusNode, payload.nodeId)
      })
      // Without a retained reference the wrapper gets GC'd and the click handler dies —
      // clicking would then only activate the app, never focus the originating node.
      retainUntilDismissed(n)
      return await new Promise<'shown' | 'failed'>((resolve) => {
        // macOS reports delivery async; if neither event lands quickly, assume shown
        // (Windows/Linux never emit 'failed').
        const timer = setTimeout(() => resolve('shown'), 1500)
        n.on('show', () => {
          clearTimeout(timer)
          resolve('shown')
        })
        n.on('failed', (_ev, error) => {
          clearTimeout(timer)
          console.warn('[notify] OS rejected the notification:', error)
          resolve('failed')
        })
        n.show()
      })
    }
  )

  // Deep-link to the OS notification settings so the user can re-grant a denied
  // permission (macOS never re-prompts once the app's record exists). The URL is a
  // main-side constant — deliberately NOT routed through shellOpenExternal's
  // http(s)-only allowlist, which must stay closed to renderer-supplied strings.
  ipcMain.handle(IPC.appOpenNotificationSettings, () => {
    if (process.platform !== 'darwin') return
    void shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
  })

  ipcMain.handle(IPC.announcementsFetch, async () => (await fetchCheck()).messages)
  ipcMain.handle(IPC.appUpdatePolicy, async () => (await fetchCheck()).update)

  // Writable base dir for app-managed files (e.g. default git worktree location). On the platform:
  // a remote tab derives the default worktree path from it, and the worktree lives on THIS host.
  corePlatform.handle(IPC.appUserDataDir, () => app.getPath('userData'))

  // Phone pairing (nodeterm iOS "scan a QR" flow): a one-shot LAN listener that installs the
  // phone's Ed25519 key into ~/.ssh/authorized_keys. The completion result is forwarded to the
  // window over `pairing:done` so the settings section can show the paired/timeout state.
  const pairingService = createPairingService({
    getSettings: () => settingsStore.get(),
    getEntitlement: getStoredEntitlement,
    loadHostKeyPair: loadOrCreateKeyPair,
    relayEndpoint: RELAY_URL,
    apiBase: RELAY_API_BASE,
    relayAllowed
  })
  ipcMain.handle(IPC.pairingStart, () =>
    pairingService.start((result) => {
      const w = getMainWindow()
      if (w && !w.isDestroyed()) w.webContents.send(IPC.pairingDone, result)
    })
  )
  ipcMain.handle(IPC.pairingStop, () => pairingService.stop())
  ipcMain.handle(IPC.pairingProbeSsh, () => pairingService.probeSsh())
  // Same pattern as appOpenNotificationSettings: a main-side constant deep link, NOT routed
  // through shellOpenExternal's http(s)-only allowlist (which silently drops non-http URLs —
  // the "Open System Settings" button did nothing when it sent the URL from the renderer).
  // The URL comes from `sshServerCopy`, the SAME table the renderer prints its copy from, so the
  // button can never appear on a platform this handler opens nothing for (issue #572: on Windows
  // it offered a macOS `x-apple.systempreferences:` link that is inert there).
  ipcMain.handle(IPC.pairingOpenRemoteLoginSettings, () => {
    const url = sshServerCopy(hostOsFromPlatform(process.platform)).settingsUrl
    if (url) void shell.openExternal(url)
  })
  ipcMain.handle(IPC.pairingListDevices, () => pairingService.listDevices())
  ipcMain.handle(IPC.pairingRevokeDevice, (_e, id: string) => pairingService.revokeDevice(id))

  // Revoking a bridged PEER must CUT THE LIVE SESSION, not just unpin it (revocation.ts): unpinning
  // refuses only the NEXT handshake, while the open relay socket keeps full shell access — "the
  // person I just removed is still sitting in my terminal, typing". `killByPeerKey` closes every
  // live session with that key, and each close runs the peer teardown (presence leave →
  // PtyManager.dropClient → sink prune). Host-security control plane, so it stays on raw ipcMain:
  // a remote peer must never be able to revoke anyone.
  const peerRevoker = createRevoker({
    load: loadApprovedDevices,
    save: saveApprovedDevices,
    onRevoke: (peerKeyB64) => killRelayHostsByPeerKey(peerKeyB64)
  })
  ipcMain.handle(IPC.remoteRevokePeer, (_e, peerKeyB64: string) =>
    peerRevoker.revoke(String(peerKeyB64))
  )

  ipcMain.on(IPC.shellReveal, (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })

  ipcMain.on(IPC.shellOpenPath, (_e, p: string) => {
    if (p) void shell.openPath(p)
  })

  ipcMain.on(IPC.shellOpenExternal, (_e, url: string) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  // Project-icon upload: open a file dialog and re-encode the pick to a bounded PNG data URL, main
  // side (never trust a user file straight onto Project.icon — see project-icon-upload.ts).
  ipcMain.handle(IPC.shellPickProjectIcon, (e) =>
    pickProjectIcon(BrowserWindow.fromWebContents(e.sender))
  )

  // The Explorer/Editor fs surface: ONE registrar (core/fs-handlers.ts) shared by this shell and
  // the Server Edition, over the same pure core/fs-ops — so local, browser and peer filesystem
  // behaviour cannot drift. Registered on the platform, so a remote tab's Explorer/editor works.
  // `localProjectCwd` is how a canvas image finds the project's own `.nodeterm/images/`. It
  // answers undefined for an SSH project (its cwd is on the host, and the image node reads
  // locally) and for a relay tab (not in this index at all) — both take the app-local fallback.
  registerFsHandlers(corePlatform, {
    localProjectCwd: (projectId: string) => workspaceStore.localCwdForProject(projectId)
  })

  const githubSecret = new ElectronGitHubSecretStore(app.getPath('userData'), safeStorage)
  const github = registerGitHubIntegration({
    platform: corePlatform,
    userDataDir: app.getPath('userData'),
    project: (projectId) => workspaceStore.githubProject(projectId),
    detectRepository: (project) =>
      gitService.originUrl(project.ssh?.remoteCwd ?? project.cwd ?? ''),
    secret: githubSecret,
    run: runGitHubCliCommand
  })
  dropGitHubRelayClient = (id) => github.service.dropClient(id)
  registerElectronGitHubControl(
    ipcMain,
    () => getMainWindow()?.webContents.id,
    github.controller
  )

  // SSH-project Explorer/Editor fs: the remote analog of the fs:* handlers above, scoped to a
  // project's ControlMaster. One SshFs bound to the SSH-project manager's own ssh runner (the SAME
  // runner RemoteFile reuses — just forwarding stdin so writes work), resolved lazily because
  // sshProjectManager is created below. The ref is looked up per call; a call before the manager
  // exists, or for an unconnected project, finds no ref and fails open ([]/''/false).
  const sshFs = new SshFs((args, stdin) =>
    sshProjectManager ? sshProjectManager.sshRun(args, stdin) : Promise.resolve({ code: 1, stdout: '' })
  )
  const sshFsRefFor = (projectId: string) => sshProjectManager?.refForProject(projectId)
  ipcMain.handle(IPC.sshFsList, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.listDir(ref, p) : Promise.resolve([])
  })
  ipcMain.handle(IPC.sshFsRead, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.readText(ref, p) : Promise.resolve('')
  })
  ipcMain.handle(IPC.sshFsReadBinary, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.readBinary(ref, p) : Promise.resolve('')
  })
  ipcMain.handle(IPC.sshFsWrite, (_e, projectId: string, p: string, content: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.writeText(ref, p, content) : Promise.resolve(false)
  })
  ipcMain.handle(IPC.sshFsMkdir, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.mkdir(ref, p) : Promise.resolve(false)
  })
  ipcMain.handle(IPC.sshFsExists, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.exists(ref, p) : Promise.resolve(false)
  })
  ipcMain.handle(IPC.sshFsQuickOpen, (_e, projectId: string, cwd: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.listQuickOpenFiles(ref, cwd) : Promise.resolve([])
  })

  // Board-log: same CorePlatform registrar as the Server Edition (core/board-log-handlers.ts), with
  // a desktop router that adds SSH routing on top of the local-cwd/unsupported the server also does.
  // A connected SSH project (refForProject → a ref with a remoteCwd) reads/writes/fingerprints over
  // its ControlMaster; anything else falls to the local folder cwd, then unsupported.
  // Extracted so the agent-messaging delivery trace can append THROUGH the same router the IPC
  // handler uses (appendBoardLogVia) instead of restating the local/remote/unsupported decision.
  const boardLogRouter = {
    route: (projectId: string): BoardLogRoute => {
      const ref = sshProjectManager?.refForProject(projectId)
      if (ref?.remoteCwd) {
        const run = (args: string[], stdin?: string) =>
          sshProjectManager!.sshRun(args, stdin)
        const exec: RemoteLogExec = {
          append: async (p, line) => {
            const { code } = await run(sshAppendArgs(ref.conn, ref.controlPath, p, line))
            if (code !== 0) throw new Error('board-log ssh append failed')
          },
          tail: async (p, lines) => {
            const { code, stdout } = await run(sshTailArgs(ref.conn, ref.controlPath, p, lines))
            return code === 0 ? stdout : ''
          }
        }
        const remotePath = boardLogRemotePath(ref.remoteCwd)
        const fingerprint = async (): Promise<string> => {
          const { code, stdout } = await run(sshSizeArgs(ref.conn, ref.controlPath, remotePath))
          if (code !== 0) throw new Error('board-log ssh fingerprint failed')
          return stdout.trim()
        }
        return { kind: 'remote', remoteCwd: ref.remoteCwd, exec, fingerprint }
      }
      const cwd = workspaceStore.localCwdForProject(projectId)
      if (cwd) return { kind: 'local', cwd }
      return { kind: 'unsupported' }
    }
  }
  const boardLog = registerBoardLogHandlers(corePlatform, boardLogRouter)
  registerLogHandlers(corePlatform, logBuffer, () => settingsStore.get().debugLogPanel)

  // Agent messaging (the `send`/`reply` control verbs). Canvas.tsx forwards the validated verb
  // here; everything that authorizes or performs the delivery reads MAIN's stores. See
  // src/core/agents/agent-messaging.ts for the whole map.
  const messagingDeps: AgentMessagingDeps = {
    paneOwner: (id) => ptyManager.paneOwner(id),
    sendEnvelope: (id, envelope) => ptyManager.sendEnvelope(id, envelope),
    hasLiveSession: (id) => ptyManager.hasLiveSession(id),
    projects: () => workspaceStore.persistedCanvases(),
    isRemoteNode: (id) => !!ptyManager.sshRemoteForNode(id),
    // GLOBAL CONSTRAINT 11: every delivery path is gated behind the per-project switch, OFF by
    // default. The switch is the `agentMessaging` capability GRANT: the strict `=== true` flag
    // in the hostile git-shared project.json AND this machine's recorded 'kept' answer to the
    // clone notice (projectCapabilityGrantedFor — never the raw file bit). Read per call off
    // the store's index, so a decline or an off-toggle refuses the very next delivery.
    messagingEnabled: messagingEnabledVia((id) => workspaceStore.capabilityProjectFor(id)),
    // Proven pane ownership: which project actually spawned the target's pane, restored across an
    // app restart only through a signed machine-local proof (core/agents/pane-ownership.ts). The
    // gate trusts this over the attacker-writable store; unproven ⇒ refused (PR #237 fix round 2).
    paneOwnerProject: (id) => paneOwnerProject(id),
    customAgents: () => settingsStore.get().customAgents,
    appendBoardLog: (projectId, entry) => appendBoardLogVia(boardLogRouter, projectId, entry)
  }
  // Deliver-on-idle (PR 7): the process-lifetime bounded queue, built by the service factory so its
  // trace + sender-facing legs are wired (and unit-tested) in one place. Its `deliver` is
  // `runDelivery` against these SAME deps, so a flush re-runs the whole gate chain (ownership, grant,
  // flow) against live state — the flush-time re-validation. The flush trigger is the target's own
  // `done` event, already fed to `onMessagingAgentEvent` below. A TTL expiry is board-logged to the
  // sender's project AND held in the trace ring (never a silent drop). `wake`/`isHibernated` are
  // RENDERER state (Eco lives in `useAgentStatus`, the wake registry in the renderer's
  // agent-restart) with no main-side signal today: the BUSY-target leg is fully wired here, and the
  // hibernated leg's renderer→main wake is an explicitly-recorded residual (see the PR body).
  messagingDeps.queue = createDeliveryQueue(messagingDeps)
  setDeliveryQueue(messagingDeps.queue)
  ipcMain.handle(IPC.agentMessageDeliver, async (_e, raw: unknown) => {
    if (!isDeliverRequest(raw))
      return { ok: false, error: 'malformed agent-message request. Do not retry.' }
    const { reply } = await deliverFromControl(raw, messagingDeps)
    return reply
  })

  ipcMain.handle(IPC.dialogSelectFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogSelectFile, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // The hook server starts BEFORE the window exists: an SSH project the renderer auto-reconnects
  // on load calls remoteHooks.setup with getHook()'s LIVE port/token, and a start racing behind
  // that connect hands it port 0 — setup then bails fail-open and, on a reused live-orphan
  // ControlMaster, the master keeps serving a PREVIOUS app run's `-R` hook forward: every remote
  // hook POST dies against a dead port with zero symptoms beyond "statuses stay idle". The
  // listeners (setListener/setRawListener/setControlHandler) attach later, which the server
  // tolerates — early hook POSTs are simply dropped, never mis-routed.
  await hookServer.start()
  // ---- Node identity (src/core/agents/node-auth-secret.ts) ------------------------------------
  // One secret does two jobs: it arms the hook server's per-node capability (closing the "shared
  // bearer can name any sibling node" hole) and it signs the codex thread → node records the hook
  // prelude reads back. On the desktop it is sealed via safeStorage; if secure storage is
  // unavailable the load rejects and we FAIL OPEN — identity stays unavailable (legacy mode),
  // `codexIdentityCaps()` answers `shared: false`, every launch line stays the bare `codex`, and
  // nothing is half-armed. Never throws up the boot path.
  // The escape hatch for per-route enforcement, read LIVE so flipping it in Settings takes effect
  // on the next request. Wired OUTSIDE the try: it is not part of arming the secret, and a machine
  // running in legacy mode is precisely one whose owner may need it.
  hookServer.setIdentityStrictOverride(() => settingsStore.get().hookIdentityStrict)
  try {
    const nodeAuthSecret = await loadOrCreateNodeAuthSecret()
    hookServer.setNodeAuthSecret(nodeAuthSecret)
    // Keep signing bound codex thread records with the same secret so they keep verifying.
    setCodexThreadIdentityAuthSecret(nodeAuthSecret)
    // Materialise a token file for every node in every persisted project. This is what makes the
    // upgrade invisible: an already-running session becomes verified at its next hook event, no
    // restart. Safe if the secret is absent — the service no-ops into legacy mode.
    initNodeTokens({ canvases: () => workspaceStore.persistedCanvases() })
  } catch (error) {
    console.warn('[node-identity] no secret — hook identity unavailable, running legacy', error)
  }
  // Probes the CLI for `--remote`, installs the launcher, and publishes the construction-time
  // answer. MUST stay after the secret above and before the window: it is what unblocks
  // `codexIdentityCaps()`, which the renderer's first Codex launch line waits on. NOT awaited —
  // the probe is a login-shell lookup plus up to two `--help` spawns, and nothing in the boot
  // chain should queue behind it; callers of `codexIdentityCaps()` wait for it instead of being
  // told "no". Reordering it later only delays that answer; leaving it out would stall those
  // callers until their own timeout, so it is not optional.
  void refreshCodexIdentityCaps()
  hookServer.setCodexIdentityListener((ev) => sendToMain(IPC.codexIdentity, ev))
  // A node still on a canvas is "live". A thread whose recorded owner is gone (node deleted, or a
  // workspace that no longer holds it) is free to be re-claimed; one whose owner is still there is
  // not, and the launcher then falls back rather than putting two clients on one conversation.
  const codexNodeIsLive = (nodeId: string): boolean => !!workspaceStore.getNode(nodeId)
  // `agent` is the pane's own label plus the grant the route derived from it; passing it is what
  // makes the record name its agent instead of leaving the sh prelude to guess `codex`. Omitting it
  // compiles perfectly — the destructure would just ignore the field — so the feature would ship
  // INERT on this shell with a green typecheck. `codex-identity-record-wiring.test.ts` pins it.
  hookServer.setCodexThreadStartHandler(async ({ nodeId, cwd, hookEndpoint, accountId, agent }) => {
    const threadId = await startCodexThread(cwd)
    writeCodexThreadIdentity(threadId, nodeId, hookEndpoint, undefined, accountId, agent)
    return threadId
  })
  hookServer.setCodexThreadBindHandler(async ({ nodeId, threadId, hookEndpoint, accountId, agent }) => {
    // Ask the app-server whether this conversation exists BEFORE recording that a node owns it.
    // The id reaching us is whatever the node persisted — it can be stale, or from a session that
    // ran under plain codex and the shared server has never heard of. Binding it anyway writes a
    // record and then execs `codex --remote unix:// resume <id>`, which dies with "no rollout
    // found" AFTER exec, where nothing can fall back any more. Refusing here IS the fallback.
    if (!(await codexThreadExists(threadId))) {
      throw new Error('Codex thread is unknown to the shared app-server')
    }
    bindCodexThreadIdentity(
      threadId,
      nodeId,
      hookEndpoint,
      codexNodeIsLive,
      undefined,
      accountId,
      agent
    )
  })
  // SSH_ASKPASS relay (ssh-project.ts): lets the ControlMaster, which has no tty, route a
  // passphrase-protected identity file's prompt back through the app instead of failing auth.
  // MUST NOT be fatal: binding a unix socket under ~/.nodeterm can fail for filesystem reasons
  // (bad ownership, a $HOME that cannot bind AF_UNIX), and this await sits in the boot chain
  // before createWindow with no catch above it. A failed relay costs passphrase prompts (envFor
  // then hands out no askpass env, the pre-feature behavior); it must never cost the window.
  await askpassServer.start().catch((e) => console.error('[ssh-askpass] relay disabled:', e))
  const askpassScriptPath = await ensureAskpassScript(app.getPath('userData')).catch((e) => {
    console.error('[ssh-askpass] script generation failed, relay disabled:', e)
    return undefined
  })
  const win = createWindow()
  // NT_MULTI instances are throwaway dev sandboxes. The dock badge is the one marker that is
  // always visible on macOS (the window title is hidden by titleBarStyle: 'hiddenInset', and the
  // dev dock icon/name are Electron's own), so a test instance can never be mistaken for the
  // real app.
  if (NT_MULTI && process.platform === 'darwin') app.dock?.setBadge('TEST')
  // Flip `quitting` before quitAndInstall so the window's close-event actually closes (not hides);
  // quitAndInstall closes all windows then calls app.quit(), which our hide-on-close would block.
  // Also skip the confirm dialog — this is a restart-to-update the user already asked for via the
  // "Restart to update" card, not an exit, and a modal here would just block the install.
  initUpdater(() => {
    quitting = true
    skipQuitConfirmation = true
  })
  // Mirror live agent status to <userData>/agent-status.json for the external mobile host agent.
  initAgentStatusMirror()

  /** The one display-title rule for everything the HOST sends out (push alerts, Live Activity
   *  updates, the notch capsule): the live session name unless the node was hand-renamed. */
  const displayTitleFor = (nodeId: string): string | undefined =>
    displayNodeTitle(nodeId, {
      sessionName: nodeSessionName,
      node: (id) => {
        const n = workspaceStore.getNode(id)
        return n ? { title: n.title, titleAuto: n.titleAuto } : undefined
      }
    })

  // Keep every agent node's session name fresh in the mirror — including nodes no canvas has
  // mounted (the phone lists them all; see core/session-name-sweep.ts).
  startSessionNameSweep({
    entries: sessionNameSweepEntries,
    node: (nodeId) => {
      const n = workspaceStore.getNode(nodeId)
      return n ? { accountId: n.accountId, titleAuto: n.titleAuto } : undefined
    },
    // Same router the IPC handler above uses — the sweep sees every TITLE_READ_CAPABLE agent, so
    // resolving a grok or gemini node through claude's reader would scan ~/.claude/projects once a
    // minute for an id that can never be there.
    resolve: (sessionId, accountId, agentId) =>
      readAgentSessionName(sessionId, accountId, agentId, agentSessionNameDeps),
    publish: setNodeSessionName
    // `supports` is deliberately NOT passed: the rule (TITLE_READ_CAPABLE, since the sweep only
    // READS a name) is core's default, `supportsTitleRead`. A copy here would be a second place to
    // get it wrong, and getting it wrong is invisible — the wrong list silently skips an agent's
    // nodes with every test still green.
  })
  // Trigger nodes (issue #493): the whole host-side machine — arm store, scheduler, delivery with
  // its deliver-on-idle queue, and the mirror's idle signal — composed ONCE in core
  // (`startTriggerService`); this shell only supplies its seams. Identical call in
  // src/server/index.ts. Arming still has no IPC/UI (phase 4), so nothing fires in production yet.
  startTriggerService({
    userDataDir: app.getPath('userData'),
    listCanvases: () => workspaceStore.persistedCanvases(),
    getNode: (nodeId) => workspaceStore.getNode(nodeId),
    sendText: (nodeId, text) => ptyManager.sendText(nodeId, text),
    paneCommand: (nodeId) => ptyManager.paneCommand(nodeId),
    handle: (channel, handler) => platform().handle(channel, handler)
  })
  // macOS Notch HUD (docs/notch-hud.md): walking agent mascots by the notch. darwin + setting only;
  // reads the same agent-status seams the mirror does. Live-toggled via settings below.
  //
  // Create the HUD only AFTER the main window is visible. The HUD is a focusable:false (non-
  // activating) panel; if it is shown while the main window is still loading (created with
  // show:false, shown on 'ready-to-show'), it can be the only orderFront-ed window on screen and
  // demote the app to accessory — the Dock icon then disappears. Gating on the main window's first
  // 'show' guarantees a regular window has established the app's Dock presence first.
  const notchTunables = (): NotchHudTunables => {
    const s = settingsStore.get()
    return {
      enabled: s.notchHud,
      notchWidth: s.notchWidth,
      hoverExpand: s.notchHoverExpand,
      percentMode: s.usagePercentMode
    }
  }
  const startNotchHud = (): void =>
    initNotchHud({ getNodeTitle: displayTitleFor }, notchTunables())
  if (win.isVisible()) startNotchHud()
  else win.once('show', startNotchHud)
  buildAppMenu(win)
  // Rebuild the native menu on every settings change so the View → Snap to Grid checkmark (and
  // any future live label) tracks the renderer's setting. The renderer is the sole settings
  // writer; a change persists through `settingsStore`, which fires this hook. No reverse IPC.
  // Keep-awake re-reads its enable flag on the same edge.
  settingsStore.onChange(() => {
    applyNotchHudSettings(notchTunables())
    buildAppMenu(win)
    keepAwake?.refresh()
  })
  // Keep awake while agents work (docs/superpowers/specs/2026-08-18-keep-awake-design.md): hold an
  // idle-sleep power assertion while a LOCAL agent node is working, released the moment the last
  // one stops. Folds the same mirror edges the notch does; the stale sweep's synthetic end
  // (WORKING_STALE_MS) is the leak backstop for exits that never send their own edge.
  keepAwake = initKeepAwake({
    enabled: () => settingsStore.get().keepAwakeWhileAgentsWork,
    // SSH-homed nodes work on the remote host — they must not pin THIS machine awake.
    isRemoteNode: (nodeId) => workspaceStore.sshProjectIdForNode(nodeId) !== undefined
  })
  onNodeStateChange((c) => keepAwake?.onChange(c))
  // Converge to the mirror on two occasions the edge stream cannot cover:
  //  - boot: an app relaunch (auto-update, crash) does not stop a tmux-backed run, and
  //    loadPersisted deliberately restores its `working` entry WITHOUT firing edges;
  //  - every mirror flush: a SessionStart mid-working resets the entry silently (upstream keeps
  //    that edge-free to protect the new turn's Live Activity), which also disarms the stale
  //    sweep — but the reset schedules a flush itself, so this sync releases moments later.
  keepAwake.sync(workingNodes().map((w) => w.nodeId))
  onMirrorFlush(() => keepAwake?.sync(workingNodes().map((w) => w.nodeId)))
  // Advertise launch settings to the mobile companion through the mirror. The provider is
  // consulted at every flush (heartbeat ≤60s), so a settings change propagates without extra
  // plumbing. Caps arrive async: re-flush once the memoized probe answers.
  let localClaudeCaps: ClaudeCliCaps | undefined
  void claudeCliCaps()
    .then((c) => {
      localClaudeCaps = c
      void flushAgentStatusMirror()
    })
    .catch(() => {})
  setMirrorSettingsProvider((): MirrorSettings => {
    const s = settingsStore.get()
    return {
      claudePermissionMode: s.claudePermissionMode,
      autoSupported: localClaudeCaps?.autoPermissionMode === true,
      claudeAccounts: (s.claudeAccounts ?? [])
        .filter((a) => !a.host && !a.pending)
        .map((a) => ({ id: a.id, dir: claudeConfigDirFor(a.id) }))
    }
  })
  // Desktop → paired-phone APNs push (spec: apns-push). Feeds off the SAME actionable-event seam
  // the mobile Inbox uses (`onInboxActionable`), so it fires exactly on approval/question (post-
  // dedup) + done (turn edge). The host public key (identity every paired phone pinned) + paired
  // flag load async and refresh on a cheap interval, so a mid-run pairing / keyring-unlock is
  // picked up without re-wiring; the getter is sync.
  //
  // GRANTED-MODE FALLBACK (spec: 2026-07-21-push-grants; owner-approved "B"). The desktop ALSO
  // wires the SSH-possession push grants the Server Edition uses (src/server/index.ts) — a phone
  // that reached this Mac by plain SSH drops a signed, device-scoped grant at
  // `~/.nodeterm/push-grants/<deviceId>.grant` on the Mac's own fs. `resolveSendTarget` sends BOTH
  // legs whenever both are live — host mode for the relay-paired phones, one Bearer POST per grant
  // for the SSH-only ones. It used to be either/or (host wins), which meant a SINGLE relay-paired
  // phone silenced every SSH-only phone on this Mac: host mode fans out over the backend's
  // `relay_devices` rows, where an SSH-only phone has no row at all. The per-device exclusion that
  // would prevent the reverse cost (a phone that is paired AND granted gets two pushes) is not
  // expressible here — a grant is keyed by the phone's deviceId, `loadApprovedDevices` stores only
  // NaCl box pubkeys, and nothing on this machine maps one to the other. See the long note on
  // `resolveSendTarget` in core/push-notify.ts.
  const pushGrants = createGrantsAccessor()
  // ...and the REMOTE half of the same idea. A Mac-driven SSH project's phone can only reach the
  // HOST, so its grant is dropped there, not here — without this sweep an SSH-only user got no
  // push at all (no paired phone, no local grant ⇒ `resolveTarget` silently returns null). Filled
  // by a timer below; `get()` is sync so it can sit behind `getGrants`. See
  // core/remote-push-grants.ts.
  const remoteGrants = createRemoteGrantsCache()
  /** Local grants first (this machine's own phone), then the hosts'. ORDER MATTERS: one phone that
   *  reached both this Mac and an SSH host dropped a different token on each, and push-notify's
   *  `dedupeGrantsByDevice` keeps the FIRST occurrence per deviceId — so the local token, the one
   *  that needs no host round-trip to stay fresh, is the survivor. */
  const allPushGrants = (): PushGrant[] => [...pushGrants.get(), ...remoteGrants.get()]
  /** A 401/403 could be on either side's token; neither accessor knows the other's. */
  const markPushGrantDead = (grant: string): void => {
    pushGrants.markDead(grant)
    remoteGrants.markDead(grant)
  }
  let pushHostKeyB64: string | null = null
  let pushHasPairedPhone = false
  const refreshPushIdentity = async (): Promise<void> => {
    try {
      pushHasPairedPhone = (await loadApprovedDevices()).pubkeys.length > 0
    } catch {
      pushHasPairedPhone = false
    }
    // No paired destination means no host-mode push can be sent. Avoid touching macOS
    // Safe Storage at boot in that state: locally signed development builds otherwise trigger
    // a Keychain ACL prompt even though there is nobody to notify.
    if (!pushHasPairedPhone) {
      pushHostKeyB64 = null
      return
    }
    try {
      pushHostKeyB64 = publicKeyToB64((await loadOrCreateKeyPair()).publicKey)
    } catch {
      // Keyring locked / transient read error: keep the last-known key (never clobber identity).
    }
  }
  void refreshPushIdentity()
  const pushIdentityTimer = setInterval(() => void refreshPushIdentity(), 60_000)
  pushIdentityTimer.unref?.()
  // Presence-aware alert deferral (spec: presence-aware-push; owner UX call). Hold phone ALERTS
  // while the user is actively at THIS Mac (noise); release them the moment they go idle or lock
  // the screen (exactly the right time). Presence = powerMonitor: idle < 180s AND not screen-locked.
  // A 15s poll detects the present→away idle edge; the lock event fires the flush immediately. Only
  // createPushNotify (alerts) is deferred — the live-update stream stays ambient. When the setting
  // is off, isUserPresent() is always false ⇒ nothing is ever held ⇒ exact legacy behavior.
  const PRESENCE_IDLE_AWAY_SECS = 180
  let screenLocked = false
  const presenceAwayListeners = new Set<() => void>()
  const isUserPresent = (): boolean => {
    if (settingsStore.get().mobilePushPresenceAware === false) return false
    if (screenLocked) return false
    try {
      return powerMonitor.getSystemIdleTime() < PRESENCE_IDLE_AWAY_SECS
    } catch {
      return false // powerMonitor unavailable (e.g. no session) ⇒ treat as away, send immediately
    }
  }
  const firePresenceAway = (): void => {
    for (const cb of presenceAwayListeners) {
      try {
        cb()
      } catch {
        // A held-flush subscriber must never break its siblings.
      }
    }
  }
  let wasPresent = isUserPresent()
  powerMonitor.on('lock-screen', () => {
    screenLocked = true
    wasPresent = false
    firePresenceAway()
  })
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false
    wasPresent = isUserPresent()
  })
  const presenceTimer = setInterval(() => {
    const present = isUserPresent()
    if (wasPresent && !present) firePresenceAway() // present → away: flush held alerts
    wasPresent = present
  }, 15_000)
  presenceTimer.unref?.()
  createPushNotify({
    subscribe: onInboxActionable,
    getHostIdentity: () =>
      pushHostKeyB64
        ? {
            hostDeviceId: getDeviceId(),
            hostPublicKeyB64: pushHostKeyB64,
            hostLabel: hostname(),
            hasPairedPhone: pushHasPairedPhone
          }
        : null,
    // Granted-mode fallback (unpaired / no relay identity → push to SSH-dropped grants; see the
    // block comment above). resolveTarget keeps a single sender: host wins when paired.
    getGrants: allPushGrants,
    markGrantDead: markPushGrantDead,
    hostLabel: () => hostname(),
    mobilePushEnabled: () => settingsStore.get().mobilePushEnabled !== false,
    mobilePushNeedsYou: () => settingsStore.get().mobilePushNeedsYou !== false,
    mobilePushDone: () => settingsStore.get().mobilePushDone !== false,
    isPackaged: () => app.isPackaged,
    // The node's canvas/sidebar display title, so the phone can title the alert
    // "<Needs you|Completed> — <nodeTitle>" (see workspace-store.getNodeTitle for the freshness note).
    getNodeTitle: displayTitleFor,
    // Presence-aware deferral wiring (alerts only).
    isUserPresent,
    subscribePresence: (cb) => {
      presenceAwayListeners.add(cb)
      return () => presenceAwayListeners.delete(cb)
    },
    isEventUnresolved: (nodeId, eventId) => isEventUnresolved(nodeId, eventId)
  })
  // Desktop → paired-phone Live Activity updates (spec: interactive-push-live-activities). Feeds off
  // the mirror's state-edge + activity/context seams, throttles activity ticks (≥20s/node), and
  // POSTs to /v1/push/live-update. Same host identity + granted-mode fallback as notify (a
  // plain-SSH phone's grants also drive Live Activities), plus its own `mobileLiveActivities`
  // sub-gate under the `mobilePushEnabled` master. Presence deferral does NOT apply here — the
  // live-update stream is ambient (activity/context ticks), so it is never held.
  createLiveUpdatePush({
    subscribeStateChange: onNodeStateChange,
    subscribeNowChange: onNodeNowChange,
    getHostIdentity: () =>
      pushHostKeyB64
        ? {
            hostDeviceId: getDeviceId(),
            hostPublicKeyB64: pushHostKeyB64,
            hostLabel: hostname(),
            hasPairedPhone: pushHasPairedPhone
          }
        : null,
    getGrants: allPushGrants,
    markGrantDead: markPushGrantDead,
    hostLabel: () => hostname(),
    mobilePushEnabled: () => settingsStore.get().mobilePushEnabled !== false,
    mobileLiveActivities: () => settingsStore.get().mobileLiveActivities !== false,
    isPackaged: () => app.isPackaged,
    getNodeTitle: displayTitleFor
  })
  // And push each connected SSH project's slice of it onto its host
  // (`~/.nodeterm/agent-status-<projectId>.json`): hook events tunnel from the host to THIS
  // process, so that file is the only agent-status source a phone browsing the host directly
  // can read. sshProjectManager is created below — the closures look it up per call.
  initRemoteStatusPush({
    onFlush: onMirrorFlush,
    flush: flushAgentStatusMirror,
    sshProjectIds: () => workspaceStore.sshProjectIds(),
    nodeIdsFor: (projectId) => workspaceStore.sshProjectNodeIds(projectId),
    push: (projectId, json) =>
      sshProjectManager ? sshProjectManager.pushAgentStatus(projectId, json) : Promise.resolve(),
    settingsFor: (projectId) => {
      const s = settingsStore.get()
      const home = sshProjectManager?.remoteHomeFor(projectId)
      const hostKey = sshProjectManager?.hostKeyFor(projectId)
      return {
        claudePermissionMode: s.claudePermissionMode,
        // The phone launches claude on the REMOTE host — its CLI is the gate, never the local one.
        autoSupported: sshProjectManager?.remoteAutoPermFor(projectId) === true,
        ...(home && hostKey
          ? {
              claudeAccounts: (s.claudeAccounts ?? [])
                .filter((a) => a.host === hostKey && !a.pending)
                .map((a) => ({ id: a.id, dir: remoteAccountConfigDirAbs(home, a.id) }))
            }
          : {}) // unresolved home ⇒ no accounts advertised (fail-open), autoSupported still ships
      }
    }
  })
  // Canvas sync: the same reflector the Server Edition boots. With a single window clientIds()
  // returns one id, so on the desktop today it is a no-op — wired for parity (and for the
  // relay-host / multi-window futures), not because Electron needs it right now.
  initCanvasSync()

  // Agent hooks: install the managed hook script into each agent's config, then start the
  // local HTTP server that receives hook posts and forwards normalized events to the renderer.
  // A raw listener drives the transcript-tailing features (context meter + subagent transcript),
  // which need the raw transcript_path the NormalizedAgentEvent intentionally drops.
  const subagentTail = createSubagentTail(({ toolUseId, chunk }) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentSubagentActivity, { toolUseId, chunk })
  })
  // Async subagents (Claude's default) end via a <task-notification> queued into the PARENT
  // transcript — their PostToolUse is only a launch ack (see the raw listener below). The
  // context tails already read that transcript, so they surface the notification here and we
  // emit the synthetic subagent-end the hooks never send, then release the transcript tail.
  /**
   * A tool RESULT landed in a tracked transcript. Only interesting while the node is still in
   * needs-you: an `AskUserQuestion` the user declined with Esc fires no PostToolUse and no Stop, so
   * nothing ever moved the node off NEEDS YOU — badge, notch capsule and phone card all stuck until
   * the next prompt. The result proves the ask settled; `working` is the honest next state (Claude
   * carries on with "User declined to answer questions"), and any real event corrects it anyway.
   */
  const onToolResult = (sessionId: string): void => {
    let nodeId: string | undefined
    for (const [nid, sid] of nodeContextSession) if (sid === sessionId) nodeId = nid
    if (!nodeId) return
    const st = nodeState(nodeId)
    if (st !== 'blocked' && st !== 'waiting') return
    const ev = {
      nodeId,
      agentId: 'claude',
      sessionId,
      kind: 'state',
      state: 'working'
    } satisfies NormalizedAgentEvent
    sendToMain(IPC.agentStatus, ev)
    recordAgentEvent(ev)
  }
  const onTaskNotification = (sessionId: string, n: TaskNotification): void => {
    let nodeId: string | undefined
    for (const [nid, sid] of nodeContextSession) if (sid === sessionId) nodeId = nid
    if (!nodeId) return
    const taskDoneEvent = {
      nodeId,
      agentId: 'claude',
      sessionId,
      kind: 'subagent-end',
      toolUseId: n.toolUseId,
      result: n.result
    } satisfies NormalizedAgentEvent
    sendToMain(IPC.agentStatus, taskDoneEvent)
    recordAgentEvent(taskDoneEvent)
    subagentTail.finish(n.toolUseId)
    remoteSubagentTail.untrack(n.toolUseId)
    nodeSubagents.get(nodeId)?.delete(n.toolUseId)
  }
  // Every context tail pushes through here, so an agent's meter reaches the renderer, the Notch HUD
  // and the phone's context ring identically whichever CLI produced the numbers.
  const pushContextUpdate = (payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.contextUpdate, payload)
    // Feed the macOS Notch HUD the model name (keyed by sessionId; no-op off/non-darwin).
    notchHudOnContextUpdate(payload as { sessionId?: string; model?: string; usedPercent?: number })
    // Feed the mirror's per-node context ring (mobile-usage-inbox). The context tail keys by
    // sessionId; map it back to the node via the raw-listener's nodeId↔sessionId association.
    const cw = payload as { sessionId?: string; usedPercent?: number }
    for (const [nid, sid] of nodeContextSession) {
      if (sid === cw.sessionId && typeof cw.usedPercent === 'number') {
        recordContextUsage(nid, cw.usedPercent)
        break
      }
    }
  }
  const contextTail = createContextTail(pushContextUpdate, { onTaskNotification, onToolResult })
  // ONE TAIL PER AGENT, each with its own parser — not one tail switching on an agent id, which
  // would mean changing `ContextTail.track(sessionId, path)` and the four call sites that depend on
  // it. The poller (offset reads, torn-line carry, change-gated push) is written once in
  // createContextTail; only the token keys differ, so only `parse` differs. Neither gets
  // onTaskNotification/onToolResult: both are claude transcript features (the task-notification
  // sniff exists because claude's hooks never send the async subagent's real end; codex's
  // SubagentStop hook IS the real end, so its subagent cards need no transcript sniffing —
  // and the declined-ask rescue is claude-only too).
  const geminiContextTail = createContextTail(pushContextUpdate, { parse: geminiContextParse })
  // Hand the gemini session-name reader its path authority (declared above the handlers that use
  // it, assigned here where the tail exists).
  geminiTranscriptPathFor = (sessionId) => geminiContextTail.pathFor(sessionId)
  const codexContextTail = createContextTail(pushContextUpdate, { parse: codexContextParse })
  // grok's third tail. `wholeFile` is not a tuning knob: signals.json is a whole JSON document
  // rewritten in place, so an offset read yields a fragment that never parses and the meter
  // would freeze after its first fill with nothing to say so. Invariant 11 — the Server
  // Edition creates the same tail the same way in src/server/agent-status.ts.
  const grokContextTail = createContextTail(pushContextUpdate, {
    parse: grokContextParse,
    wholeFile: true
  })
  // Remote (SSH-project) counterparts: a node whose pty runs on a remote host has its Claude
  // transcript on that host, so its meter / subagent transcript / search must read over the
  // project's ControlMaster. One RemoteFile bound to the SSH-project manager's own ssh runner
  // (so reads reuse the live master); resolved lazily — sshProjectManager is created below but
  // these are only invoked once a remote hook POST arrives, long after init. Fail-open: a read
  // before the manager exists returns a non-zero code (RemoteFile maps that to empty).
  const remoteFile = new RemoteFile((args) =>
    sshProjectManager ? sshProjectManager.sshRun(args) : Promise.resolve({ code: 1, stdout: '' })
  )
  const remoteContextTail = createRemoteContextTail(win, remoteFile, { onTaskNotification, onToolResult })
  const remoteSubagentTail = createRemoteSubagentTail(win, remoteFile)
  // Remote transcript ref learned from the hook raw-listener, keyed by sessionId — lets the
  // search/chat read handlers (which receive only sessionId + cwd) read remotely without a
  // nodeId. Only remote sessions are ever inserted, so local reads stay on the local reader.
  const remoteTranscriptBySession = new Map<string, RemoteFileRef>()
  // Subset of the above that WE located by asking the host (no hook event ever fed it). Tracked
  // separately so a stale entry can be dropped on a failed read without touching the hook-fed
  // ones — see `readRemoteTranscript`.
  const locatedTranscriptSessions = new Set<string>()
  // Route the session-name read (the node-title poll) through the same remote ref. An SSH
  // project's agent runs on the remote host, so its transcript is NOT under the local
  // `~/.claude/projects` — without this, `/rename` never reached the node title on remote nodes
  // (and the poll re-scanned the local root every 4s for nothing). Returning null for an unknown
  // sessionId keeps every local node on the local reader.
  setRemoteTranscriptReader(async (sessionId) => {
    const ref = remoteTranscriptBySession.get(sessionId)
    if (!ref) return null
    return { text: await remoteFile.readTail(ref, TITLE_TAIL_BYTES) }
  })
  // toolUseIds whose remote subagent file resolution was cancelled (PostToolUse / node close
  // arrived before the file appeared) — checked by the async resolver to avoid a late track.
  // Bounded by `remoteSubagentResolving`: a cancel flag is only added (and only matters) while a
  // resolver is in flight, and the resolver clears BOTH sets in its `finally` once it settles, so
  // neither set can accumulate dead ids over the app lifetime.
  const remoteSubagentCancel = new Set<string>()
  // toolUseIds with an in-flight `resolveRemoteSubagentFile` poll. PostToolUse / node-close only
  // raise a cancel flag while resolution is still running (otherwise the add would leak).
  const remoteSubagentResolving = new Set<string>()

  // Resolve a remote subagent's transcript FILE (`agent-<id>.jsonl`) by matching the spawning
  // toolUseId inside its sibling `.meta.json` — the remote analogue of the local subagent tail's
  // dir scan (the remote tail takes a resolved file path, so we resolve it here). The file
  // appears shortly after PreToolUse, so we poll briefly over the master. Fail-open throughout.
  const resolveRemoteSubagentFile = async (
    rt: { conn: import('../shared/ssh').SshConnection; controlPath: string },
    parentTranscript: string,
    toolUseId: string
  ): Promise<string | undefined> => {
    if (!sshProjectManager) return undefined
    const dir = parentTranscript.replace(/\.jsonl$/, '') + '/subagents'
    // grep -lF prints the matching meta path; `… /*.meta.json` glob is left unquoted to expand.
    const cmd = `grep -lF ${posixQuote(toolUseId)} ${posixQuote(dir)}/*.meta.json 2>/dev/null | head -1`
    for (let i = 0; i < 12; i++) {
      if (remoteSubagentCancel.has(toolUseId)) return undefined
      const { stdout } = await sshProjectManager.sshRun(childArgs(rt.conn, rt.controlPath, cmd))
      const meta = stdout.trim()
      if (meta) return meta.replace(/\.meta\.json$/, '.jsonl')
      await new Promise((r) => setTimeout(r, 600))
    }
    return undefined
  }
  // Read at most the last 5 MB of a transcript (mirrors transcript-reader's READ_CAP_BYTES) —
  // the remote read fetches the tail over ssh, then reuses the SAME pure parsers as local, so
  // the returned shape is byte-identical to the local reader.
  const REMOTE_TRANSCRIPT_CAP = 5 * 1024 * 1024

  /**
   * The remote ref for a session, resolving it on the HOST when no hook event has registered one.
   *
   * `remoteTranscriptBySession` is fed only by hook POSTs, and a tmux session outlives the app —
   * so after an app restart an IDLE remote agent node has no ref, and the local resolvers below
   * would search this machine's disk for a session that exists only on the host (finding nothing,
   * or another local session that happens to share the cwd). Asking the host directly is what the
   * node id buys us; a hit is cached under the sessionId so the title poll and the next read get
   * it for free. Fail-open at every step: no node id / not an SSH session / no resolved home /
   * a failed ssh call all mean "not remote", which is the pre-existing local path.
   *
   * `remote` overrides the live-pty lookup for callers that already know which host the node runs
   * on. `PtyManager.kill()` forgets a session on detach, so a backgrounded project's nodes are
   * absent from that map — and the reconnect resync runs on exactly those nodes. Absent ⇒ the
   * lookup, i.e. the pre-existing behavior byte for byte.
   */
  const remoteTranscriptRefFor = async (
    sessionId: string | undefined,
    cwd: string | undefined,
    accountId: string | undefined,
    nodeId: string | undefined,
    remote?: { conn: import('../shared/ssh').SshConnection; controlPath: string }
  ): Promise<RemoteFileRef | undefined> => {
    if (!sessionId) return undefined
    const cached = remoteTranscriptBySession.get(sessionId)
    if (cached) return cached
    if (!nodeId) return undefined
    const rt = remote ?? ptyManager.sshRemoteForNode(nodeId)
    if (!rt || !sshProjectManager) return undefined
    const remoteHome = sshProjectManager.remoteHomeForControlPath(rt.controlPath)
    if (!remoteHome) return undefined
    let accountDir: string | undefined
    if (accountId) {
      // A hand-edited project.json can carry any string; the helper validates and throws.
      try {
        accountDir = remoteAccountConfigDirAbs(remoteHome, accountId)
      } catch {
        accountDir = undefined
      }
    }
    const cmd = locateRemoteTranscriptCommand(
      remoteTranscriptRoots(remoteHome, accountDir),
      cwd,
      sessionId
    )
    if (!cmd) return undefined
    let located: string | undefined
    try {
      const { code, stdout } = await sshProjectManager.sshRun(
        childArgs(rt.conn, rt.controlPath, cmd)
      )
      located = code === 0 ? parseLocatedTranscript(stdout) : undefined
    } catch {
      return undefined
    }
    // Jailed exactly like a hook-supplied path: the command only ever emits paths under our own
    // roots, but the answer still crosses a machine boundary before we read it.
    if (!located || !isSafeRemoteTranscriptPath(located, remoteHome)) return undefined
    const ref: RemoteFileRef = { conn: rt.conn, controlPath: rt.controlPath, path: located }
    remoteTranscriptBySession.set(sessionId, ref)
    locatedTranscriptSessions.add(sessionId)
    return ref
  }

  /**
   * Read a remote transcript through a ref, forgetting refs WE located once they stop reading.
   * `cap` is the tail window in bytes; it defaults to the full reader's cap, so every caller that
   * wants a transcript to READ is unchanged. A caller that only wants to know how the last few
   * records look (the reconnect resync) passes a much smaller one — see
   * RESYNC_TRANSCRIPT_TAIL_BYTES.
   *
   * Without this the panel's Retry replays a dead path forever (the transcript was deleted, or the
   * session moved) because the cache lookup comes first. A hook-fed ref is deliberately left in
   * place on an empty read — that is usually a transient master hiccup, and dropping it would send
   * the next read down the LOCAL resolver, i.e. to the wrong machine.
   */
  const readRemoteTranscript = async (
    sessionId: string,
    ref: RemoteFileRef,
    cap: number = REMOTE_TRANSCRIPT_CAP
  ): Promise<string> => {
    const text = await remoteFile.readTail(ref, cap)
    if (!text && locatedTranscriptSessions.delete(sessionId)) {
      remoteTranscriptBySession.delete(sessionId)
    }
    return text
  }

  // Both read channels now live in core (the Server Edition serves the very same handlers); the
  // ONE thing this shell adds is the remote leg, which needs a ControlMaster. `null` means "not a
  // remote session", which is the signal for core to take its local path.
  registerTranscriptIpc({
    pathFor: (sessionId) => contextTail.pathFor(sessionId),
    readRemote: async ({ sessionId, cwd, accountId, nodeId }) => {
      const ref = await remoteTranscriptRefFor(sessionId, cwd, accountId, nodeId)
      return ref ? await readRemoteTranscript(sessionId!, ref) : null
    }
  })

  initTranscriptIndex(() => settingsStore.get().claudeAccounts ?? [])
  corePlatform.handle(IPC.transcriptSearch, (query: string) => searchTranscripts(query))
  // Populate the context meter without a live hook event: the renderer calls this on mount
  // (the continuing session may be idle after a restart). Track under the sessionId (the key
  // the meter looks up); cwd is only a path fallback. contextTail.track reads immediately and
  // the 1s interval keeps it fresh while tracked.
  // Shares core's `resolveTranscript` with the read channels — including its `accountId`-scoped
  // cwd fallback. This copy dropped the account, so a managed-account node could track (and then
  // meter, and then SERVE as the chat's first-choice path) an unrelated session's transcript.
  corePlatform.on(IPC.contextEnsure, async (sessionId?: string, cwd?: string, accountId?: string) => {
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return
    const p = await resolveTranscript({ sessionId, cwd, accountId }, (s) => contextTail.pathFor(s))
    if (p) contextTail.track(sessionId, p)
  })
  // The remote half of a handoff. Same three-line shape as the context-link deps above and for
  // the same reason: reading (and here also WRITING) on an SSH project's host is the one thing
  // the handoff builder cannot answer for itself. Absent deps ⇒ local-only, as before.
  const handoffRemote: HandoffRemote = {
    isRemoteNode: (nodeId) => !!ptyManager.sshRemoteForNode(nodeId),
    hookedTranscriptPath: (nodeId) => transcriptPathOf(nodeId),
    readRemoteFile: async (nodeId, filePath, maxBytes) => {
      const rt = ptyManager.sshRemoteForNode(nodeId)
      if (!rt) return null
      const text = await remoteFile.readTail(
        { conn: rt.conn, controlPath: rt.controlPath, path: filePath },
        maxBytes
      )
      return text || null
    },
    writeRemoteFile: async (nodeId, filePath, content) => {
      const rt = ptyManager.sshRemoteForNode(nodeId)
      if (!rt || !sshProjectManager) return false
      try {
        const { code } = await sshProjectManager.sshRun(
          sshWriteArgs(rt.conn, rt.controlPath, filePath),
          content
        )
        return code === 0
      } catch {
        return false
      }
    }
  }
  corePlatform.handle(
    IPC.handoffBuild,
    (
      sessionId: string,
      agentId: string,
      sourceNodeId: string,
      cwd: string | undefined,
      accountId: string | undefined
    ) => buildHandoff({ sessionId, agentId, sourceNodeId, cwd, accountId, remote: handoffRemote })
  )

  installManagedAgentHooks()
  // Managed accounts each carry their own settings.json AND skills/ (Claude Code resolves both
  // relative to CLAUDE_CONFIG_DIR) — re-install the hook + canvas skill there too (idempotent),
  // so an app update's new versions reach every account dir. The loop is shared with the Server
  // Edition's boot (src/core/claude-accounts-service.ts); each shell supplies its own canvas-skill
  // installer when that control surface is enabled.
  installHooksIntoLocalAccounts(settingsStore.get().claudeAccounts ?? [], installCanvasSkillInto)
  // Fan a normalized agent event to BOTH consumers: the renderer's agentStatus store (canvas badge)
  // and the mobile-facing mirror. Named so the deterministic-approval answer handler below can reuse
  // it for the optimistic flip.
  const emitAgentStatus = (e: NormalizedAgentEvent): void => {
    // Record FIRST: recordAgentEvent computes the stash-priority classification and returns the
    // event ENRICHED for a needs-you edge (a question strips its pendingId), so the canvas keys off
    // the same single source of truth as the mirror/phone. Then broadcast the enriched event.
    const enriched = recordAgentEvent(e) ?? e
    sendToMain(IPC.agentStatus, enriched)
    // Feed the macOS Notch HUD its prompt (ev.task on newTurn) + subagent grouping (no-op off/non-darwin).
    notchHudOnAgentEvent(enriched)
    // Agent messaging taps the SAME stream: the sender's newTurn resets its fan-out budget, and
    // an open delivery receipt watch is satisfied by the target's verified advance.
    onMessagingAgentEvent(enriched)
  }
  hookServer.setListener(emitAgentStatus)
  // Deterministic hook-reply approvals (docs/hook-reply-approvals.md): the canvas Approve/Deny
  // buttons (and any relay client) answer a held Claude permission hook here. Route by the node's
  // project: an SSH project's hook runs on the REMOTE host (write over its ControlMaster), a local
  // project's on THIS machine (write under os.homedir() — the hook uses $HOME, which may differ from
  // the project cwd). pendingId is validated before it is interpolated into any path/command.
  corePlatform.handle(
    IPC.agentAnswerPermission,
    async (payload: { nodeId: string; pendingId: string; decision: 'allow' | 'deny' }) => {
      const { nodeId, pendingId, decision } = payload ?? ({} as typeof payload)
      if (!isValidPendingId(pendingId)) return false
      if (decision !== 'allow' && decision !== 'deny') return false
      const sshProjectId = workspaceStore.sshProjectIdForNode(nodeId)
      const ok =
        sshProjectId && sshProjectManager
          ? await sshProjectManager.writePendingAnswer(sshProjectId, pendingId, decision)
          : await writePendingAnswerLocal(pendingId, decision, homedir())
      // Optimistic flip: on a successful write, emit the same synthetic "answered" transition the
      // held hook's second POST will produce, so the NEEDS YOU badge clears instantly instead of
      // waiting for that POST to round-trip. The later hook POST is an idempotent duplicate (a
      // same-state working re-assert is a no-op). See docs/hook-reply-approvals.md.
      if (ok) {
        const ev = syntheticAnsweredEvent(nodeId, pendingId, decision)
        if (ev) emitAgentStatus(ev)
      }
      return ok
    }
  )
  // Read-a-finished-session ack (this feature): the renderer's unread-clear funnel calls it when the
  // just-read node's latest state is `done`. The mirror resolves the node's done inbox event(s)
  // (phone Inbox archives the card) and re-sends an 'end' live-update so the paired phone dismisses
  // its lingering DONE Live Activity. Fire-and-forget; the mirror no-ops with no unresolved done.
  corePlatform.handle(IPC.agentAckDone, (nodeId: string) => {
    ackDone(nodeId)
  })
  // Phone→host read-acks (this feature, the other direction): the phone drops
  // `~/.nodeterm/acks/<nodeId>.seen` on the SESSION host when it READS a finished session. For each
  // ack: `ackDone` (mirror resolves the done event → phone Inbox archives it + the paired phone's
  // DONE Live Activity dismisses) AND `agent:unread-clear` so the desktop renderer drops the node's
  // unread flag WITHOUT re-acking (external clear — the ack already happened phone-side; a re-ack
  // would loop). ONE 15s cadence drives BOTH: the LOCAL fs sweep (cheap dir-mtime gate) for
  // local-project nodes, and a REMOTE sweep of each connected SSH project's host over its
  // ControlMaster (a Mac→SSH node's acks land on the REMOTE fs, invisible to the local sweep).
  // sshProjectManager is created below; the tick resolves it lazily.
  // Session budget: reap long-idle DETACHED nt- tmux sessions on THIS machine under memory
  // pressure or past a count cap (core/session-budget.ts — the tmux counterpart of the WebGL
  // budget). Attached sessions are never touched; a reaped node cold-restores on next open.
  // Local sockets only — a remote SSH host's sessions are reaped by that host's own
  // nodeterm-server, never across the wire. Timer is unref'd; no explicit stop needed.
  // `shadowed` subtracts our own control-mode shadows from tmux's attached flag: a shadow is a real
  // tmux client but NOT a watcher, so a shadowed session must stay exactly as cullable as an idle
  // detached one (see PtyManager.shadowedTmuxSessions).
  // `readMem: hostMemReader()` — the SAME platform-aware reader the memory-pressure monitor uses,
  // and for the same reason. On darwin it returns null, so `planReap` sees no pressure signal and
  // only the detached-count cap can trigger a cull.
  //
  // Available BYTES is not macOS's pressure signal. Measured on a 24 GB Mac (2026-08-12): 82% used,
  // 8.38 GB compressed, 1.77 GB swap in use — and macOS's own Memory Pressure graph GREEN. A
  // 10%-available watermark fires in states the OS itself calls healthy, so a byte trigger there
  // culls sessions on a machine macOS says is fine. Fixing readMemInfo made the bytes HONEST; it
  // did not make them the right instrument.
  //
  // This is not a regression of the reaper's purpose on macOS: the count cap still bounds
  // accumulation, the pty-pressure monitor covers the resource that actually ran out, and the
  // session-memory panel gives the user the visibility to cull deliberately.
  const sessionReaper = createSessionReaper({
    tmuxBin: () => ptyManager.getTmuxBin(),
    shadowed: (socket) => ptyManager.shadowedTmuxSessions(socket)
  })
  sessionReaper.start()
  // Memory pressure (core/memory-pressure.ts): the reaper's own 10-minute timer is the steady
  // state; this is the fast path. On a watermark crossing the renderer runs its reclaim levers
  // (hidden WebGL contexts, parked terminals) and a CRITICAL reading also sweeps the reaper NOW
  // rather than waiting out its timer. Both levers are idempotent and the monitor re-fires at most
  // once a minute. The send goes through `sendToMain`, which resolves the window AT SEND TIME and
  // no-ops while it is closed (macOS keeps the app alive without one) — the monitor's own
  // try/catch is the backstop, not the primary.
  createMemoryPressureMonitor({
    onPressure: (severity) => {
      sendToMain(IPC.appMemoryPressure, severity)
      if (severity === 'critical') void sessionReaper.sweep()
    }
  }).start()
  // Pty-device pressure (core/pty-pressure.ts): the OTHER way this machine runs out, and the one
  // that actually happened. The memory monitor above could not see it — during the 2026-08-11
  // incident RAM was plentiful while `/dev/ttys*` was full, so the reaper never woke and the user
  // got no warning at all, just terminals that stopped opening. Same shape as the memory leg: tell
  // the renderer (which raises a banner) on every band change, and sweep the reaper NOW on
  // critical — a reaped detached session returns its pty device, which is exactly the resource in
  // short supply. Transitions only, re-announced at most every five minutes.
  //
  // The sweep is passed `pressure: 'pty'` because a bare `sweep()` here would plan NOTHING: the
  // budget's own triggers are memory and a detached-count cap, and the incident profile clears
  // both (healthy RAM, under the cap). The reason grants the same batch allowance low memory
  // would and widens no exemption — attached and in-grace sessions stay untouchable.
  const ptyPressure = createPtyPressureMonitor({
    onLevel: (reading) => {
      sendToMain(IPC.ptyPressure, reading)
      if (reading.level === 'critical') void sessionReaper.sweep({ pressure: 'pty' })
    }
  })
  ptyPressure.start()
  // The banner's "Fix automatically…" button. Registered, never called on our own initiative: it
  // raises `kern.tty.ptmx_max` behind macOS's own admin-password dialog. Its success re-announces
  // through the monitor's funnel, so the banner clears without waiting out the next tick.
  registerPtmxLimitHandler(corePlatform, { announce: (reading) => ptyPressure.announce(reading) })
  // Session memory (docs/superpowers/specs/2026-08-10-session-memory-panel-design.md): the pill's
  // cheap RAM read plus the on-demand per-session breakdown. An SSH project's sessions live on ITS
  // host, so they are read THERE over the project's ControlMaster — the same injection Context Link
  // and remote usage use (core owns the command + the parsing, main owns the master).
  // `sshProjectManager` is assigned far below, so both closures resolve it lazily; they only ever
  // run after a project has connected.
  startSessionMemoryService({
    tmuxBin: () => ptyManager.getTmuxBin(),
    remote: {
      // Identity, not liveness: a DISCONNECTED SSH project is still someone else's machine, and
      // `connectedHosts()` alone would answer "local" for it — exactly the window the service's
      // refusal exists for. The workspace index is the connection-independent source; the live
      // masters are OR-ed in for a project the index has not (yet) listed. See sshScopePredicate.
      isRemoteProject: sshScopePredicate({
        sshProjectIds: () => workspaceStore.sshProjectIds(),
        connectedProjectIds: () =>
          (sshProjectManager?.connectedHosts() ?? []).map((h) => h.projectId)
      }),
      run: async (projectId, command) => {
        const mgr = sshProjectManager
        const ref = mgr?.refForProject(projectId)
        if (!mgr || !ref) return null
        try {
          const { code, stdout } = await mgr.sshRun(childArgs(ref.conn, ref.controlPath, command))
          // Gated on the exit code, unlike the usage runner: every command in the generated script
          // ends `|| true`, so a completed read exits 0 unconditionally. A non-zero code therefore
          // means ssh itself could not run it — a dead ControlMaster reports exactly that, with an
          // EMPTY stdout ("Control socket connect(…): No such file or directory" goes to stderr).
          // Passing that empty string on would leave "the host answered nothing" to be inferred
          // from a missing marker; `null` says "we could not look" outright.
          if (code !== 0) return null
          return stdout
        } catch {
          return null
        }
      }
    }
  })
  const ackSweeper = createAckSweeper({
    handlers: { ackDone, onUnreadClear: (id) => sendToMain(IPC.agentUnreadClear, id) }
  })
  let remoteAckSweepBusy = false
  const ackSweepTimer = setInterval(() => {
    ackSweeper.sweep()
    if (remoteAckSweepBusy || !sshProjectManager) return
    remoteAckSweepBusy = true
    void sshProjectManager
      .sweepRemoteAcks()
      .then((ids) => {
        for (const id of ids) {
          ackDone(id)
          sendToMain(IPC.agentUnreadClear, id)
        }
      })
      .catch(() => {})
      .finally(() => {
        remoteAckSweepBusy = false
      })
  }, 15_000)
  ackSweepTimer.unref?.()
  // Push grants on the connected SSH hosts (core/remote-push-grants.ts). Its own, slower cadence:
  // unlike an ack — which the phone waits on — a grant only has to be fresh by the time something
  // is actually pushed, and the phone re-drops it long before it expires. One ssh exec per
  // connected host per minute, and none at all with no SSH project open.
  let remoteGrantSweepBusy = false
  const grantSweepTimer = setInterval(() => {
    if (remoteGrantSweepBusy || !sshProjectManager) return
    remoteGrantSweepBusy = true
    void sshProjectManager
      .readRemoteGrants()
      .then((grants) => remoteGrants.set(grants))
      .catch(() => {})
      .finally(() => {
        remoteGrantSweepBusy = false
      })
  }, 60_000)
  grantSweepTimer.unref?.()
  // Sweep stale request/answer files (~/.nodeterm/pending) on boot + hourly — orphans from killed
  // sessions that never got an answer. Local only; a remote host runs its own sweep if it hosts
  // nodeterm, else the files age out harmlessly.
  startPendingSweep(homedir())
  // Security: hook POSTs now arrive over the remote reverse tunnel too (SSH Phase 2a), so a
  // forged/remote POST could set transcript_path to an arbitrary LOCAL path (e.g. ~/.ssh/id_rsa)
  // and have the app read it. The tails read the LOCAL filesystem; legitimate LOCAL transcripts
  // live under the system default `~/.claude/projects` OR a managed account's
  // `{userData}/claude-accounts/<id>/projects` (id-validated so a forged POST can't traverse out
  // — see isSafeLocalTranscriptPath). Phase 2a does NOT tail remote transcripts (that's 2b), so we
  // jail transcript_path to those roots and skip the read otherwise. Returns the path only when it
  // resolves under an allowed root.
  const safeTranscriptPath = (tp: string | undefined): string | undefined => {
    if (!tp) return undefined
    const abs = resolve(tp)
    // codexHome() honors $CODEX_HOME — a relocated codex (the snap-codex case this project has hit
    // before) would otherwise fail the jail and its meter would silently never fill.
    // grokHomeDir() honors $GROK_HOME for the same reason and with the same failure shape: closed,
    // so a relocated grok home would silently never resolve a context link. BOTH shells pass it
    // (invariant 11) — a jail widened in one shell only is a feature the Server Edition lacks with
    // nothing to say so.
    // Linked accounts' dirs come from SETTINGS, never from the POST — `<dir>/projects/**` only,
    // so `~/.claude-2/.ssh` is as refused as it ever was. Without them the meter and the subagent
    // cards silently never fill for a pane running the user's own CLAUDE_CONFIG_DIR.
    return isSafeLocalTranscriptPath(
      abs,
      homedir(),
      app.getPath('userData'),
      codexHome(),
      grokHomeDir(),
      linkedClaudeConfigDirs()
    )
      ? abs
      : undefined
  }
  // Remote analogue of safeTranscriptPath: a remote node's transcript_path is a remote absolute
  // path arriving over the reverse tunnel — a forged POST must not read an arbitrary remote file.
  // The jail (both allowed roots, incl. a managed remote account's) is pure + unit-tested in
  // claude-accounts-core.
  const safeRemoteTranscriptPath = (
    tp: string | undefined,
    remoteHome: string | undefined
  ): string | undefined => {
    if (!tp) return undefined
    const abs = posix.resolve(tp)
    return isSafeRemoteTranscriptPath(abs, remoteHome) ? abs : undefined
  }
  const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
  // `meta` carries the per-node `verified` flag and is deliberately UNUSED here: A13 moved
  // enforcement into the hook server, which refuses before a listener is ever called. This shell
  // used to keep a `nodeVerified` map written on every event and read by nothing. The parameter
  // stays because the flag is part of the listener contract and both shells must take it
  // (invariant 4, pinned by hook-verified-parity.test.ts); a second copy of the answer is not.
  hookServer.setRawListener((agentId, nodeId, payload, _meta) => {
    if (agentId === 'grok') {
      // This branch records two associations, neither of which grok's envelope states outright.
      // Everything the claude path does below hangs off `transcript_path`. Grok DOES send one --
      // `transcriptPath`, MEASURED on 1.0.13 in 14 of 15 captured payloads -- but it names
      // `updates.jsonl`, which holds no readable conversation, so this path deliberately ignores
      // the advertised value and derives the session directory instead. Core
      // owns the node/session/directory transition (`applyGrokHookSession`) so desktop and Server
      // Edition cannot implement different event branches. Written inline, that transition existed
      // in two copies and neither knew it. (An earlier version of this comment claimed PostCompact
      // mints a NEW session id and retires the prior one. Measured on 1.0.13: it does not —
      // `pre_compact` and `post_compact` carry the SAME id — and the branch that acted on the
      // belief is gone. SessionEnd is the only event that retires an id.)
      //
      // What stays HERE is what needs a shell to exist: the per-shell context tail and the phone
      // mirror. `plan` carries the decoded event/session/cwd, so the dialect is still decoded in
      // exactly one place.
      const plan = applyGrokHookSession(nodeId, payload, nodeContextSession)
      // Context meter: grok's numbers are NOT in the transcript, so the advertised `transcriptPath`
      // has nothing here to point at. They live in
      // `signals.json`, the sibling of `chat_history.jsonl`, which is why this tail is tracked from
      // the DERIVED directory rather than from a hook field — and why it is created with
      // `wholeFile` (that file is rewritten in place, not appended to).
      if (plan.sessionId && plan.cwd) {
        const dir = grokSessionDir({
          sessionsDir: grokSessionsDir(),
          cwd: plan.cwd,
          sessionId: plan.sessionId
        })
        if (dir) grokContextTail.track(plan.sessionId, join(dir, GROK_SIGNALS_FILE))
      }
      // node → what it is doing NOW (the phone's per-node activity line).
      //
      // §8.3 of docs/grok-agent.md said grok's file hooks "never send PreToolUse", so calling this
      // was a no-op and it was deleted. MEASURED on 1.0.13 (2026-09-02), that is wrong in wording
      // and right in effect: grok DOES publish the event, spelled `pre_tool_use` — its own
      // snake_case — and `recordRawToolEvent` gates on the exact string `PreToolUse`, so the gate
      // never matched. The blocker was a SPELLING, not an absence, which is why deleting the call
      // looked correct and closed the door on a working feature.
      //
      // Translated here rather than by loosening that gate: the mirror is claude-shaped on purpose.
      // `toolActivity` knows grok's fifteen tool names, so the line reads "Reading fichero.txt",
      // never a claude phrase.
      const g = grokRawFields(payload)
      if (nodeId && plan.event === 'pretooluse' && g.toolName) {
        recordRawToolEvent(nodeId, {
          hook_event_name: 'PreToolUse',
          tool_name: g.toolName,
          tool_input: g.toolInput
        })
      }
      // The turn is over: clear the activity line the same way the claude path does.
      if (nodeId && (plan.event === 'stop' || plan.event === 'sessionend')) {
        recordRawToolEvent(nodeId, { hook_event_name: 'Stop' })
      }
      // Forgetting the MAP entry and untracking the TAIL are two different things and neither
      // substitutes for the other: `applyGrokHookSession` did the first (and does it for PostCompact
      // too, which this call site cannot see). The tail is this shell's, so it is released here.
      if (plan.forgetSessionId) grokContextTail.untrack(plan.forgetSessionId)
      return
    }
    // gemini and codex both carry `transcript_path` in their hook envelope (gemini: the base input
    // schema of its bundled `docs/hooks/reference.md:48-58`; codex: the same claude-shaped envelope,
    // whose own hook wire structs name session_id/transcript_path/cwd/hook_event_name), so the
    // meter needs no path DERIVATION the way grok's does — only its own token reader. The path is
    // jailed by the same `safeTranscriptPath` claude uses (widened to those two agents' transcript
    // roots), because a forged POST could otherwise aim a file read at an arbitrary local path.
    if (agentId === 'gemini' || agentId === 'codex') {
      const p = payload as {
        session_id?: string
        transcript_path?: string
        hook_event_name?: string
        agent_id?: string
      }
      // A REMOTE (SSH) node's transcript lives on the HOST, and these tails read the LOCAL disk —
      // a host path like `~/.gemini/tmp/…` clears the local jail, so without this we would meter
      // whatever same-named file happens to exist on THIS machine. Remote meters for these agents
      // are out of scope (remote-context-tail.ts is that path), so skip rather than report the
      // wrong machine's numbers. The Server Edition needs no counterpart: it has no SSH projects,
      // which is why its copy of this branch is otherwise identical but lacks these two lines.
      // (A remote codex node's subagent CARDS still work — normalize is machine-agnostic — it is
      // only the live-activity tail that has no remote leg yet.)
      if (nodeId && ptyManager.sshRemoteForNode(nodeId)) return
      // Codex subagent events (spawn_agent), BEFORE the meter track: every agent_id-tagged event
      // carries the PARENT's session_id with the CHILD's rollout as transcript_path (measured,
      // codex-cli 0.146.0 — SubagentStart and the child's own tool events alike), so falling
      // through would re-point the parent's context meter at the child's rollout. The tail is the
      // shared subagentTail instance: releaseNodeTails/SessionEnd cleanup then covers codex ids
      // through the same nodeSubagents bookkeeping claude uses.
      if (agentId === 'codex' && p.agent_id) {
        if (p.hook_event_name === 'SubagentStart') {
          subagentTail.trackFile(
            p.agent_id,
            safeTranscriptPath(p.transcript_path),
            createCodexSubagentFormatter
          )
          if (nodeId) {
            const set = nodeSubagents.get(nodeId) ?? new Set<string>()
            set.add(p.agent_id)
            nodeSubagents.set(nodeId, set)
          }
        } else if (p.hook_event_name === 'SubagentStop') {
          subagentTail.finish(p.agent_id)
          if (nodeId) nodeSubagents.get(nodeId)?.delete(p.agent_id)
        }
        return
      }
      const transcriptPath = safeTranscriptPath(p.transcript_path)
      const tail = agentId === 'gemini' ? geminiContextTail : codexContextTail
      if (p.session_id && transcriptPath) tail.track(p.session_id, transcriptPath)
      if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
      // gemini subscribes SessionEnd (GEMINI_HOOK_EVENTS); codex does NOT today (CODEX_EVENTS stops
      // at Stop), so for codex the tail is released by `releaseNodeTails` on pty:destroy/recycle
      // instead. Handling it here regardless costs nothing and is correct the day codex's event
      // list grows.
      if (p.hook_event_name === 'SessionEnd' && p.session_id) tail.untrack(p.session_id)
      return
    }
    if (agentId !== 'claude') return
    // Mirror the per-node "what it's doing now" activity line for the phone (mobile-usage-inbox).
    // Runs BEFORE the local/remote split so it covers remote (SSH) nodes too — it needs only
    // tool_name/tool_input, never the transcript path the split routes on.
    recordRawToolEvent(nodeId, payload)
    const p = payload as {
      hook_event_name?: string
      session_id?: string
      transcript_path?: string
      tool_name?: string
      tool_use_id?: string
      tool_response?: { status?: string; isAsync?: boolean }
    }
    // An async subagent's PostToolUse is only the launch ack — keep tailing its transcript;
    // the real end (task-notification via the context tails) releases it.
    const asyncLaunch = p.hook_event_name === 'PostToolUse' && isAsyncSubagentLaunch(p.tool_response)
    // REMOTE node: route to the remote tails/search, jailing the path under the project's remote
    // ~/.claude/projects. Diverges from the local path ONLY when the node has a live ssh remote.
    const rt = nodeId ? ptyManager.sshRemoteForNode(nodeId) : undefined
    if (rt) {
      const remoteHome = sshProjectManager?.remoteHomeForControlPath(rt.controlPath)
      const transcriptPath = safeRemoteTranscriptPath(p.transcript_path, remoteHome)
      if (p.session_id && transcriptPath) {
        const ref: RemoteFileRef = { conn: rt.conn, controlPath: rt.controlPath, path: transcriptPath }
        remoteContextTail.track(p.session_id, ref)
        remoteTranscriptBySession.set(p.session_id, ref)
      }
      if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
      // Context Link: remember the node's transcript path for remote nodes too. This branch used
      // to `return` without it, which is why a remote node was never readable through a link —
      // the local locators are no substitute (they search the wrong machine's disk, so
      // resolveLinkTranscript deliberately refuses them for remote nodes). The path stored is the
      // JAILED one, so a forged POST cannot aim a link read at an arbitrary remote file.
      if (nodeId && p.session_id && transcriptPath) setNodeTranscript(nodeId, p.session_id, transcriptPath)
      if (p.hook_event_name === 'SessionEnd' && p.session_id) {
        remoteContextTail.untrack(p.session_id)
        remoteTranscriptBySession.delete(p.session_id)
        locatedTranscriptSessions.delete(p.session_id)
      }
      if (p.tool_use_id && p.tool_name && SUBAGENT_TOOLS.has(p.tool_name) && transcriptPath) {
        const toolUseId = p.tool_use_id
        if (p.hook_event_name === 'PreToolUse') {
          remoteSubagentCancel.delete(toolUseId)
          remoteSubagentResolving.add(toolUseId)
          // Resolve the remote subagent file asynchronously (it appears shortly after), then track.
          // The `finally` always clears both bookkeeping sets so they can't accumulate dead ids.
          void resolveRemoteSubagentFile(rt, transcriptPath, toolUseId)
            .then((file) => {
              if (file && !remoteSubagentCancel.has(toolUseId)) {
                remoteSubagentTail.track(toolUseId, { conn: rt.conn, controlPath: rt.controlPath, path: file })
              }
            })
            .finally(() => {
              remoteSubagentResolving.delete(toolUseId)
              remoteSubagentCancel.delete(toolUseId)
            })
          if (nodeId) {
            const set = nodeSubagents.get(nodeId) ?? new Set<string>()
            set.add(toolUseId)
            nodeSubagents.set(nodeId, set)
          }
        } else if (p.hook_event_name === 'PostToolUse' && !asyncLaunch) {
          // Only cancel an in-flight resolve; if it already settled, adding here would leak.
          if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
          remoteSubagentTail.untrack(toolUseId)
          if (nodeId) nodeSubagents.get(nodeId)?.delete(toolUseId)
        }
      }
      // Session over → release any still-tracked async subagent tails for this node.
      if (p.hook_event_name === 'SessionEnd' && nodeId) {
        for (const toolUseId of nodeSubagents.get(nodeId) ?? []) {
          if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
          remoteSubagentTail.untrack(toolUseId)
        }
        nodeSubagents.delete(nodeId)
      }
      return
    }
    const transcriptPath = safeTranscriptPath(p.transcript_path)
    // Context-window meter: tail the session transcript (any event carrying both fields).
    if (p.session_id && transcriptPath) contextTail.track(p.session_id, transcriptPath)
    if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
    if (nodeId && p.session_id && transcriptPath) setNodeTranscript(nodeId, p.session_id, transcriptPath)
    if (p.hook_event_name === 'SessionEnd' && p.session_id) contextTail.untrack(p.session_id)
    // Subagent live transcript: track on PreToolUse / finish on PostToolUse for subagent tools.
    if (p.tool_use_id && p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) {
      if (p.hook_event_name === 'PreToolUse') {
        subagentTail.track(p.tool_use_id, transcriptPath)
        if (nodeId) {
          const set = nodeSubagents.get(nodeId) ?? new Set<string>()
          set.add(p.tool_use_id)
          nodeSubagents.set(nodeId, set)
        }
      } else if (p.hook_event_name === 'PostToolUse' && !asyncLaunch) {
        subagentTail.finish(p.tool_use_id)
        if (nodeId) nodeSubagents.get(nodeId)?.delete(p.tool_use_id)
      }
    }
    // Session over → release any still-tracked async subagent tails for this node (their
    // task-notifications will never arrive once the session is gone).
    if (p.hook_event_name === 'SessionEnd' && nodeId) {
      for (const toolUseId of nodeSubagents.get(nodeId) ?? []) subagentTail.finish(toolUseId)
      nodeSubagents.delete(nodeId)
    }
  })

  // Releasing tails when a node's session ENDS — whichever way it ends. pty-manager handles the
  // same two channels to kill the tmux session; this extra listener tears down the per-node file
  // tailers so they stop polling a now-dead session:
  //  - pty:destroy — the user clicked × (the node is gone);
  //  - pty:recycle — "move into worktree" (the node stays, but its session is replaced, so the
  //    tails of the OLD session's transcript are just as dead; the respawned agent re-registers
  //    them under its new session id via the hook events).
  const releaseNodeTails = (nodeId: string): void => {
    const sessionId = nodeContextSession.get(nodeId)
    if (sessionId) {
      // Untrack both tails — untracking a non-tracked session is a no-op, so this is safe
      // regardless of whether the closed node was local or remote (avoids an ordering race
      // with pty-manager's own ptyDestroy handler clearing the ssh-remote registration).
      // Every agent's tail is untracked, not just claude's: `nodeContextSession` now holds gemini
      // and codex sessions too, and a tail nobody releases keeps polling a dead session's file
      // once a second forever. Only one of these can be tracking any given sessionId.
      contextTail.untrack(sessionId)
      geminiContextTail.untrack(sessionId)
      codexContextTail.untrack(sessionId)
      grokContextTail.untrack(sessionId)
      remoteContextTail.untrack(sessionId)
      remoteTranscriptBySession.delete(sessionId)
      locatedTranscriptSessions.delete(sessionId)
      nodeContextSession.delete(nodeId)
    }
    const subs = nodeSubagents.get(nodeId)
    if (subs) {
      for (const toolUseId of subs) {
        subagentTail.finish(toolUseId)
        // Only cancel an in-flight resolve; if it already settled, adding here would leak.
        if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
        remoteSubagentTail.untrack(toolUseId)
      }
      nodeSubagents.delete(nodeId)
    }
  }
  // A SECOND listener on these channels (PtyManager registers its own): both fire, in registration
  // order, on ipcMain AND in the platform's listener table — so a peer closing a node releases the
  // host's tails too, instead of leaking them.
  corePlatform.on(IPC.ptyDestroy, (nodeId: string) => releaseNodeTails(nodeId))
  corePlatform.on(IPC.ptyRecycle, (nodeId: string) => releaseNodeTails(nodeId))
  // Agent canvas control: the spawned agent's `nodeterm` CLI POSTs a verb to the hook server,
  // which we forward to the renderer and await a reply. A pending-request map (keyed by a random
  // requestId) bridges the two async hops; both the reply and the timeout below clear the entry.
  // The window is generous because a confirm-gated verb waits on a human, not on the renderer.
  const CONTROL_REQUEST_TIMEOUT_MS = 120_000
  const pendingControl = new Map<
    string,
    {
      resolve: (r: { ok: boolean; message?: string; result?: unknown; error?: string }) => void
      timer: NodeJS.Timeout
    }
  >()
  // Who owns which agent-opened browser node, THIS app run only. In-memory, never persisted, never
  // read from project.json (Task 4.3/4.4). Consumed by PR 5 (attach/lease), PR 6 (indicator/Stop).
  const browserLedger = new BrowserControlLedger()
  // Holds the debugger lease per driven browser node. Built and unit-tested in PR 5. PR 7 wires each
  // guest's `webContents.debugger` into a BrowserSession and starts the idle sweep; a driving verb
  // there will call `browserLedger.touchLease(...)` + `pushBrowserLeases()` so the chip lights up.
  // No verb attaches a guest yet, so nothing sets a live lease today — but revocation (Stop + the
  // automatic triggers) is fully live, because `release` is a no-op-safe detach for a node with no
  // session. Owned here so all the wiring has one home. See browser-lease.ts / browser-revocation.ts.
  const browserLeases = new BrowserLeaseManager()
  // @ref bookkeeping (Task 5.5), one table for every driven node; nav bumps a node's generation.
  const browserRefs = new RefTable()
  // Per-node event bus (fixed CDP event set → our own state) and the `debugger.on('message')`
  // listener we registered for it, kept so a teardown removes exactly that listener (a released and
  // re-created session must not leave a duplicate listener firing on the same debugger).
  const browserBuses = new Map<string, CdpEventBus>()
  const browserMsgListeners = new Map<
    string,
    { dbg: { removeListener(event: string, fn: (...a: unknown[]) => void): void }; fn: (...a: unknown[]) => void }
  >()
  // Tear down the driver-side state for one node (its lease/session is being released). Removes the
  // exact message listener and forgets the bus + refs, so nothing keeps driving a released node.
  const browserDriverTeardown = (nodeId: string): void => {
    const l = browserMsgListeners.get(nodeId)
    if (l) {
      try {
        l.dbg.removeListener('message', l.fn)
      } catch {
        /* a destroyed debugger throws; the map cleanup below is what matters */
      }
      browserMsgListeners.delete(nodeId)
    }
    browserBuses.delete(nodeId)
    browserRefs.forget(nodeId)
  }
  // Revocation releases the lease (detach + reject in-flight) AND tears down the driver state, in one
  // place, whatever triggered it — so a Stop can never leave a page still drivable.
  const browserRevocation: RevocationTargets = {
    leases: {
      release: (nodeId: string) => {
        browserLeases.release(nodeId)
        browserDriverTeardown(nodeId)
      }
    },
    ledger: browserLedger
  }
  // The live control session + event bus for a node's CANVAS <webview> guest (Task 2.2: the canvas
  // surface is the only drivable one — a modal guest is never driven). Attaching is LAZY inside the
  // session, so getting one costs no debugger attach; that is what keeps "ledger.get() before any
  // attach" literally true. Returns null when the guest's page is gone (the memory saver released
  // it), which the drive gate turns into the named discard refusal.
  const canvasGuestWcId = (browserNodeId: string): number | undefined => {
    let unknownSurface: number | undefined
    for (const [wcId, g] of browserGuests) {
      if (g.nodeId !== browserNodeId) continue
      if (g.surface === 'canvas') return wcId
      // `surface` is `undefined` until both mount sites are threaded (guest-registry): treat it as
      // the canvas fallback (the common case is one canvas guest), but NEVER drive a `'modal'` one.
      if (g.surface === undefined) unknownSurface = wcId
    }
    return unknownSurface
  }
  const browserSessionFor = (browserNodeId: string): LiveGuest | null => {
    const wcId = canvasGuestWcId(browserNodeId)
    if (wcId === undefined) return null
    const wc = webContents.fromId(wcId)
    if (!wc || wc.isDestroyed()) return null
    const existing = browserLeases.get(browserNodeId)
    const existingBus = browserBuses.get(browserNodeId)
    if (existing && existingBus) return { session: existing as unknown as Sendable, bus: existingBus }
    // Fresh driver: the bus bumps this node's ref generation on a main-frame navigation / context
    // clear (Task 5.5), the session pushes its lease to the ledger + renderer on every verb (which is
    // what lights the driving chip), and the message listener feeds the fixed CDP event set into the
    // bus — nothing is streamed to the agent.
    const bus = new CdpEventBus(() => browserRefs.bumpGeneration(browserNodeId))
    const session = new BrowserSession({
      nodeId: browserNodeId,
      debugger: wc.debugger,
      // A 0×0 placeholder: coordinates are unused by --nav/--read, and the pointer verbs (PR 8) call
      // BrowserSession.refreshViewport() from Page.getLayoutMetrics before every dispatch, which
      // OVERRIDES this at send time — so a bounded mouse event validates against the real page.
      viewport: () => ({ viewport: { width: 0, height: 0 } }),
      isDevToolsOpen: () => {
        try {
          return wc.isDevToolsOpened()
        } catch {
          return false
        }
      },
      onLeaseChange: (until) => {
        browserLedger.touchLease(browserNodeId, until)
        pushBrowserLeases()
      }
    })
    const fn = (_e: unknown, method: string, params: unknown): void => bus.emit(method, params)
    wc.debugger.on('message', fn)
    browserLeases.set(browserNodeId, session)
    browserBuses.set(browserNodeId, bus)
    browserMsgListeners.set(browserNodeId, {
      dbg: wc.debugger as unknown as { removeListener(e: string, f: (...a: unknown[]) => void): void },
      fn: fn as unknown as (...a: unknown[]) => void
    })
    return { session: session as unknown as Sendable, bus }
  }
  // The 60s idle detach (browser-lease.ts): drop the debugger attachment on nodes gone quiet, so an
  // attachment never outlives its usefulness. The session stays in the map and re-attaches on the
  // next verb; only the debugger handle is released. Unref'd so it never holds the process open.
  const browserIdleSweep = setInterval(() => browserLeases.sweepIdle(Date.now()), 30_000)
  browserIdleSweep.unref?.()
  // Push the current driven-lease set to the renderer (chip / rope / kill row). `stopped` ids drop
  // from the chip immediately, skipping the anti-flicker linger — that is how an explicit Stop hides
  // at once while a merely-idle lease fades.
  const pushBrowserLeases = (stopped: string[] = []): void => {
    const w = getMainWindow()
    if (!w || w.isDestroyed()) return
    w.webContents.send(IPC.browserLeaseChanged, {
      active: browserLedger.activeLeasesForPush(Date.now()),
      stopped
    })
  }
  // Reverse the guest map: which node id owns this <webview> guest? Used to revoke on a browser
  // node's teardown (its guest unregisters). Absent guest → no id → nothing to revoke.
  const browserNodeIdForGuest = (webContentsId: number): string | undefined =>
    browserGuests.get(webContentsId)?.nodeId
  // Stop agent control of ONE node — the chip button and the node context menu. USER-initiated, so
  // it leaves the tombstone: a later drive from that owner is refused by the named human act.
  ipcMain.on(IPC.browserStop, (_e, nodeId: string) => {
    pushBrowserLeases(revokeBrowserNode(nodeId, browserRevocation, { userStopped: true }))
  })
  // Stop-all — the Settings kill row. Also user-initiated.
  ipcMain.on(IPC.browserStopAll, () => {
    pushBrowserLeases(revokeAllBrowser(browserRevocation, { userStopped: true }))
  })
  // A project's browser-control switch went OFF (read live in the renderer, never cached at lease
  // start). User-initiated: a human turned it off.
  ipcMain.on(IPC.browserStopProject, (_e, projectId: string) => {
    pushBrowserLeases(revokeBrowserByProject(projectId, browserRevocation))
  })
  // The OWNER agent node closed or restarted (pty teardown/recycle) → its browser leases die with
  // its verified identity. A SECOND listener on these channels alongside releaseNodeTails above;
  // both fire. LIFECYCLE, so no user-stop tombstone. A restart mints a fresh identity that cannot
  // drive the old node anyway, so revoking is the honest state.
  corePlatform.on(IPC.ptyDestroy, (nodeId: string) =>
    pushBrowserLeases(revokeBrowserByOwner(nodeId, browserRevocation))
  )
  corePlatform.on(IPC.ptyRecycle, (nodeId: string) =>
    pushBrowserLeases(revokeBrowserByOwner(nodeId, browserRevocation))
  )
  // The caller's PROJECT GRANTS die with its node too (issue #338, spec P3) — same teardown
  // anchor, same reasoning as the browser leases above: a grant is consent given to a running
  // session, and a recycle mints a fresh identity that must re-earn its targeting rights via
  // open-project. App restart clears the whole in-memory ledger by construction.
  corePlatform.on(IPC.ptyDestroy, (nodeId: string) => clearProjectGrants(nodeId))
  corePlatform.on(IPC.ptyRecycle, (nodeId: string) => clearProjectGrants(nodeId))
  // App quit: detach every debugger lease. A second `before-quit` listener alongside the module-
  // level flush one (both fire); scoped here so it can reach `browserRevocation`. No push — the
  // window is going away. LIFECYCLE, so no tombstone (the in-memory ledger is gone on quit anyway).
  app.on('before-quit', () => {
    revokeAllBrowser(browserRevocation, { userStopped: false })
  })
  ipcMain.on(
    IPC.agentControlResult,
    (
      _e,
      payload: { requestId: string; ok: boolean; message?: string; result?: unknown; error?: string }
    ) => {
      const pending = pendingControl.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingControl.delete(payload.requestId)
      pending.resolve(payload)
    }
  )
  // The `browser` verb resolve round-trip (Task 7.2). Main asks the renderer to resolve a source
  // node's owning project, control-capability and the LIVE per-project capability value; the renderer
  // answers here. Modelled on `pendingControl`, but its own map with its own short (2s) timeout so a
  // slow canvas can NEVER consume the 120s pending-control budget.
  const pendingBrowserResolve = new Map<string, (r: BrowserResolve) => void>()
  ipcMain.on(
    IPC.browserControlResolveResult,
    (
      _e,
      payload: {
        requestId: string
        ok: boolean
        refusal?: string
        projectId?: string
        projectCwd?: string
        sourceControlCapable?: boolean
        capabilityOn?: boolean
        sourceTitle?: string
        browserTitle?: string
      }
    ) => {
      const resolve = pendingBrowserResolve.get(payload.requestId)
      if (!resolve) return
      pendingBrowserResolve.delete(payload.requestId)
      resolve(
        payload.ok
          ? {
              ok: true,
              projectId: payload.projectId ?? '',
              projectCwd: payload.projectCwd,
              sourceControlCapable: payload.sourceControlCapable === true,
              capabilityOn: payload.capabilityOn === true,
              sourceTitle: payload.sourceTitle,
              browserTitle: payload.browserTitle
            }
          : { ok: false, refusal: payload.refusal ?? 'source node is not on an open canvas' }
      )
    }
  )
  // Ask the renderer to resolve a source node — the `ask` closure `resolveBrowserTarget` races
  // against its own 2s timeout. The renderer NEVER runs a CDP command; it answers existence + project
  // + capability only.
  const askRendererResolve = (sourceNodeId: string, browserNodeId: string): Promise<BrowserResolve> => {
    const w = getMainWindow()
    if (!w || w.isDestroyed()) {
      return Promise.resolve({ ok: false, refusal: 'source node is not on an open canvas' })
    }
    const requestId = randomUUID()
    const answered = new Promise<BrowserResolve>((resolve) => {
      pendingBrowserResolve.set(requestId, resolve)
    })
    // `browserNodeId` rides along so the renderer can report the browser node's title for the cookie
    // trace; it is NOT part of the security decision (owner + capability + allowlist stay main-side).
    w.webContents.send(IPC.browserControlResolve, { requestId, sourceNodeId, browserNodeId })
    return answered.finally(() => pendingBrowserResolve.delete(requestId))
  }
  // The `browser` verb's whole main-side drive: parse (pure), identity belt, resolve round-trip, then
  // the gate + drive (owner + LIVE capability + CDP allowlist all decided here in MAIN). A capability
  // read that comes back OFF revokes as it refuses (detach + drop + tombstone). See browser-drive.ts.
  const handleBrowserVerb = async (
    nodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<{ ok: boolean; message?: string; error?: string }> => {
    const parsed = parseBrowserArgs(args)
    if ('error' in parsed) return { ok: false, error: parsed.error, message: parsed.error }
    // Identity is checked first (the belt to hook-server's verified-only gate for STRICT verbs): a
    // non-verified caller learns nothing, and no resolve round-trip is even made.
    if (!verified) return { ok: false, error: STRICT_CONTROL_REFUSAL, message: STRICT_CONTROL_REFUSAL }
    const resolve = await resolveBrowserTarget(parsed.node, () => askRendererResolve(nodeId, parsed.node))
    const result = await driveBrowser(
      { call: parsed, ownerNodeId: nodeId, verified, resolve },
      {
        ledger: browserLedger,
        refs: browserRefs,
        sessionFor: browserSessionFor,
        revoke: (id) => pushBrowserLeases(revokeBrowserNode(id, browserRevocation, { userStopped: true })),
        // The cookie-read trace (PR 9): appended in-process, BEFORE the read, through the same board-log
        // routing the IPC handler uses. A false return (no reachable log / write failed) refuses the read.
        appendBoardLog: (projectId, entry) => boardLog.append(projectId, entry),
        // The screenshot jail + write (PR 9). realpath/lstat canonicalize the project-dir jail; writeFile
        // lands the PNG. All node:fs — never a caller path reaching CDP.
        screenshotIO: {
          realpath: (p) => fsRealpath(p),
          lstat: (p) => fsLstat(p),
          writeFile: (p, d) => fsWriteFile(p, d)
        }
      }
    )
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.message, message: result.message }
  }
  // The caller's OWNING project, by node membership in main's own persisted store — the same
  // source `resolveDeliveryScope` trusts. `undefined` = not in any saved project (a brand-new
  // node inside the save debounce, or an id main never saved): the project gates fail closed.
  const projectIdOfNode = (id: string): string | undefined =>
    workspaceStore.persistedCanvases().find((c) => c.nodes.some((n) => n.id === id))?.id
  hookServer.setControlHandler(async ({ verb, nodeId, args, verified }) => {
    // `--dry-run` (issue #532) is honoured by the spawn verbs only, and this gate runs FIRST —
    // before the browser intercept, the open-project gates and the renderer forward — because a
    // verb that cannot dry-run must REFUSE rather than silently perform: a `close --dry-run`
    // that closes is worse than no flag at all. Supported verbs pass through with the flag
    // intact; their renderer dispatch case stops before the mutation.
    if (dryRunRequested(args) && !DRY_RUN_VERBS.has(verb)) {
      const msg = dryRunRefusal(verb)
      return { ok: false, error: msg, message: msg }
    }
    // `browser` is answered in MAIN and never forwarded to the renderer's agent-control dispatch:
    // the debugger handle and the CDP allowlist are main-side, and the renderer is the more
    // attackable half. Every other verb still round-trips to the renderer below.
    if (verb === 'browser') return handleBrowserVerb(nodeId, args, verified)
    // ── `open-project` + `--project` targeting, gated in MAIN before anything is forwarded
    // (issue #338 PR 1). The renderer never sees an invalid cwd or an unauthorized `--project`.
    // The verb itself is verified-only at the hook-server route (requiresVerified) — by the time
    // an open-project reaches this wrapper, `verified` is true; the gates below are main's own
    // belt plus everything identity cannot answer (SSH caller, cwd validity, the grant cap).
    if (verb === 'open-project') {
      const refuse = (error: string) => ({ ok: false, error, message: error })
      if (!verified) return refuse(OPEN_PROJECT_CONTROL_REFUSAL)
      // The rules themselves are the PURE gateOpenProject (project-grants.ts) — caller-unresolved
      // fail-closed, SSH-caller local-only, cap-before-consent, cwd resolved once — proven
      // red-capable branch by branch in project-grants.test.ts. This wrapper only feeds it main's
      // own stores and returns its refusals unforwarded.
      const callerProjectId = projectIdOfNode(nodeId)
      const gate = gateOpenProject({
        callerProjectId,
        callerIsSsh: callerProjectId
          ? workspaceStore.projectMetaFor(callerProjectId)?.ssh
          : undefined,
        atCap: projectGrantsAtCap(nodeId),
        rawCwd: args.cwd ?? '',
        statFn: (p) => statSync(p)
      })
      if ('refuse' in gate) return refuse(gate.refuse)
      // The RESOLVED path — never the raw argument — is what the renderer (PR 2's dialog, the
      // dedupe, the store) sees. Single resolution, in main, right here.
      args = { ...args, cwd: gate.resolvedCwd }
    } else if (PROJECT_TARGETABLE_VERBS.has(verb) && args.project !== undefined) {
      // Open verbs carrying `--project`: own-or-granted only (spec §3, P2), decided against
      // main's own store + ledger. Anything else is refused without forwarding.
      const meta = workspaceStore.projectMetaFor(args.project)
      const gate = gateProjectTarget({
        verified,
        verb,
        targetProjectId: args.project,
        callerProjectId: projectIdOfNode(nodeId),
        targetIsSsh: meta?.ssh,
        granted: projectGrantedTo(nodeId, args.project)
      })
      if (gate !== 'allow') return { ok: false, error: gate.refuse, message: gate.refuse }
    }
    const target = getMainWindow()
    if (!target) return { ok: false, error: 'window unavailable' }
    const requestId = randomUUID()
    const result = await new Promise<{ ok: boolean; message?: string; result?: unknown; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        pendingControl.delete(requestId)
        // Name the timeout and say it is retryable. A DENIAL is a different answer with different
        // guidance (`denied by user`, final, never retried), and the old wording — "no response /
        // not confirmed" — read as though it covered both, so a caller that had merely waited out
        // an unanswered dialog treated it as a refusal and gave up.
        resolve({
          ok: false,
          error: `no answer within ${CONTROL_REQUEST_TIMEOUT_MS / 1000}s — the confirmation dialog may still be open; safe to retry`
        })
      }, CONTROL_REQUEST_TIMEOUT_MS)
      pendingControl.set(requestId, { resolve, timer })
      target.webContents.send(IPC.agentControl, { requestId, sourceNodeId: nodeId, verb, args })
    })
    // Record browser ownership the moment an open-browser succeeds — and ONLY when the caller's
    // identity verdict for THIS request was `verified` (main's own verdict, not anything off the
    // wire or project.json). A `legacy`/warned caller may open a browser but owns nothing, so it
    // can drive nothing. The owner is the verified caller (`nodeId`); the project id + partition
    // ride along from the renderer's reply for release-by-project and the indicator. This is the
    // browser sibling of pane-ownership's record-at-fresh-spawn. See browser-control-ledger.ts and
    // browser-ownership-source.test.ts (ownership is NEVER read from Project.ropes).
    if (verb === 'open-browser' && verified && result.ok) {
      const opened = result.result as { id?: string; projectId?: string; partition?: string } | undefined
      // Refuse to record an entry with no owning project: `releaseByProject('')` would match it, and
      // a project-less ownership record is meaningless. Fail-closed against future reply-shape drift
      // — today `partition` is present only when agentBrowserPartition(projectId) succeeded, so a
      // non-empty safe projectId always rides with it.
      if (opened?.id && opened.partition && opened.projectId) {
        browserLedger.claim(opened.id, {
          ownerNodeId: nodeId,
          projectId: opened.projectId,
          partition: opened.partition,
          navGeneration: 0,
          leaseActiveUntil: 0,
          openedAt: Date.now()
        })
        // A claim carries no live lease (a verb sets that in PR 7), so this does not light the chip;
        // it keeps the renderer's view consistent from the moment ownership exists.
        pushBrowserLeases()
      }
    }
    // Record a project grant the moment an open-project succeeds — the open-browser ledger
    // pattern above, same conditions: ONLY when the caller's identity verdict for THIS request
    // was `verified` (main's own verdict, never anything off the wire) AND the renderer's reply
    // carries a non-empty projectId. Inert until PR 2: today the renderer's `default:` case
    // answers `unknown verb: open-project` with ok: false, so nothing is ever recorded — but the
    // record path ships fail-closed and finished, not stubbed.
    if (verb === 'open-project') {
      // The whole decision (verified && ok && string projectId → grant; cap race detection) is
      // the PURE recordOpenProjectGrant — proven branch by branch in project-grants.test.ts.
      // 'cap' = the pre-forward atCap() check passed but a concurrent open-project from the same
      // caller filled the last slot while this one was in flight (PR #362 review, M1): the
      // caller must NOT hear ok while holding no targeting right, so the named refusal replaces
      // the success reply. Nothing is lost — open-project is idempotent (B1), so a re-run once
      // grants have cleared returns the same project id and records the grant.
      if (recordOpenProjectGrant(nodeId, result, verified) === 'cap') {
        console.warn(
          `[project-grants] grant cap raced for caller ${nodeId}: open-project succeeded but ` +
            'the grant was not recorded; replying open-project-grant-cap'
        )
        return { ok: false, error: OPEN_PROJECT_GRANT_CAP, message: OPEN_PROJECT_GRANT_CAP }
      }
    }
    return result
  })
  initMediaProtocol()

  // Context Link reads happen HERE, on the desktop, which is what lets a remote (SSH-project)
  // node's transcript be read at all: it lives on the host, behind the project's ControlMaster.
  // These three deps are the whole of what `src/core` cannot answer for itself. Fail-open
  // throughout — a failed remote read renders as "no transcript yet", never as an error.
  initContextLink(ptyManager, {
    isRemoteNode: (nodeId) => !!ptyManager.sshRemoteForNode(nodeId),
    readRemoteFile: async (nodeId, filePath, maxBytes) => {
      const rt = ptyManager.sshRemoteForNode(nodeId)
      if (!rt) return null
      const text = await remoteFile.readTail(
        { conn: rt.conn, controlPath: rt.controlPath, path: filePath },
        maxBytes
      )
      return text || null
    },
    runRemoteCommand: async (nodeId, command) => {
      const rt = ptyManager.sshRemoteForNode(nodeId)
      if (!rt || !sshProjectManager) return null
      try {
        const { code, stdout } = await sshProjectManager.sshRun(childArgs(rt.conn, rt.controlPath, command))
        return code === 0 ? stdout : null
      } catch {
        return null
      }
    }
  }, {
    // The desktop app is the surface Context Link's discovery was designed for, so it installs
    // the skill + instruction blocks. Stated rather than defaulted: the flag is required so no
    // caller can reach the write by omission (see initContextLink, issue #490).
    installAgentIntegrations: true
  })
  initCanvasControl()
  // Usage service + the mobile `usage` mirror block (mobile-usage-inbox): poll all local managed
  // accounts alongside the system account, and re-flush the mirror on every cache update. The
  // provider pairs the service's cache with the settings account labels at flush time; SSH slices
  // drop it (filterMirrorForNodes) — a host answers only for its own local credentials.
  const localClaudeAccountIds = (): string[] =>
    (settingsStore.get().claudeAccounts ?? []).filter((a) => !a.host && !a.pending).map((a) => a.id)
  // Local managed Codex accounts, each paired with the isolated home its auth.json lives in, for
  // the per-account usage fan-out (S6 §4.3). Remote (`host`) accounts have no local home; pending
  // ones have no auth yet — both are excluded, exactly like the Claude list above.
  const localCodexAccounts = (): Array<{
    id: string
    home: string
    label: string
    email?: string | null
  }> =>
    codexUsageAccounts(
      (settingsStore.get().codexAccounts ?? []).filter((a) => !a.host && !a.pending),
      codexHomeFor
    )
  const usageService = initClaudeUsage(win, {
    localAccounts: localClaudeAccountIds,
    codexAccounts: localCodexAccounts,
    onCacheUpdate: () => {
      void flushAgentStatusMirror()
    },
    // A phone may be reading the mirror's `usage` block even with the window unfocused: relay-paired
    // (approved device) or SSH-with-a-push-grant. When so, keep polling on the background cadence so
    // the phone's bars/resets stay live instead of fossilizing at the last focused poll.
    mirrorMayBeRead: () => pushHasPairedPhone || allPushGrants().length > 0,
    // Remote (SSH host) Claude usage. Same shape as the Context Link remote deps: core owns the
    // command and the parsing, main owns the ControlMaster. `sshProjectManager` is assigned just
    // below, so both closures read it lazily — they only ever run after a project has connected.
    remote: {
      targets: () =>
        remoteUsageTargets(
          sshProjectManager?.connectedHosts() ?? [],
          settingsStore.get().claudeAccounts ?? []
        ),
      run: async (target, command) => {
        const mgr = sshProjectManager
        const ref = mgr?.refForProject(target.projectId)
        if (!mgr || !ref) return null
        try {
          const { stdout } = await mgr.sshRun(childArgs(ref.conn, ref.controlPath, command))
          // Deliberately not gated on the exit code: the remote script exits 0 on its own
          // short-circuits but curl's exit status rides through on a network failure, and the
          // marker block is what says whether the read completed.
          return stdout
        } catch {
          return null
        }
      }
    }
  })
  setMirrorUsageProvider(() =>
    buildMirrorUsage(usageService.snapshot(), settingsStore.get().claudeAccounts ?? [], Date.now())
  )
  initTelemetry(() => settingsStore.get())
  initLicense(() => {})
  // Lazy getter: sshProjectManager is created just below, so a remote account op (which only runs
  // after the user has connected an SSH project) always sees the live manager.
  initClaudeAccounts(() => sshProjectManager)
  // Machine-scoped managed Codex accounts (S6). Its synchronous boot migration of legacy long
  // CODEX_HOMEs runs here, before the renderer restores its PTYs — an already-persisted managed
  // Codex node must see its migrated (SUN_LEN-safe) home on its very first spawn. Same lazy SSH
  // getter for the local→SSH transfer source leg.
  initCodexAccounts(() => sshProjectManager)
  // The jailed core bridge both phone hosts serve: typed git verbs against the real GitService
  // (cwd-jailed to the shared canvas roots inside the handlers) and phone node registration
  // through the workspace store (written as an outside edit, so the watcher broadcasts it and
  // the canvas adopts the node live).
  const hostBridge = {
    git: gitService,
    // `accountId` = the managed Claude account the phone launched the session under. It has to be
    // declared here too, or the wire's honest shape stops at this boundary (see RemoteNodeInput).
    registerNode: (
      projectId: string,
      node: { id: string; title?: string; agentId?: string; accountId?: string }
    ) =>
      workspaceStore.appendRemoteNode(
        projectId,
        node,
        new Date(),
        // Host-derived, exactly as on the canvas: the account's default color beats the agent's,
        // so a phone-started session under a colored account is recognizable in the same way. The
        // agent decides WHICH account list answers (agentAccountColor) — the phone supplies both
        // ids, and the two lists are keyed independently. Resolved off the RAW account id: whether
        // this node is account-bound at all is `boundAccountId`'s call, made once inside the
        // registrar, which ignores this color when it refuses the binding. Re-deriving that rule
        // here would be the second copy that drifts.
        agentAccountColor(node.agentId, node.accountId, {
          claude: settingsStore.get().claudeAccounts ?? [],
          codex: settingsStore.get().codexAccounts ?? []
        })
      ),
    // "End session" from the phone (`pty.destroy`): the SAME two steps the desktop × performs —
    // kill the tmux session on every socket it could live on (the sweep may have seen it on either
    // — see the session-memory panel's kill rule), then take the node off its project's canvas
    // (written as an outside edit, so the watcher broadcasts it and the canvas drops the node
    // live). Node removal is best-effort by design: an unregistered phone session or an inline
    // project has no file entry to remove, and that must not fail a destroy that already landed.
    //
    // The kill is VERIFIED before the node comes off the canvas (issue #581): destroySession
    // swallows its per-step failures by design, so it can resolve having ended nothing — and
    // removing the node then would strand a live session with no canvas entry pointing at it.
    // The throw also rides back to the phone as the verb's honest error.
    destroyNode: async (nodeId: string) => {
      await ptyManager.destroySession(null, nodeId, { everySocket: true })
      if (await ptyManager.sessionExists(nodeId).catch(() => true)) {
        throw new Error('The session is still running — the host could not end it.')
      }
      await workspaceStore.removeRemoteNode(nodeId).catch(() => false)
    },
    // Relay-viewer presence (Eco × phone): a COUNT per node id, shared by the interactive host and
    // every standing-host pool session (several phones can watch at once, and one phone switching
    // sessions overlaps its old and new streams). Two consumers, both renderer-side:
    //  - `agent:remote-viewers` carries the full watched SET each change, so Eco's `isNodeWatched`
    //    stops hibernating a session someone is watching from a phone (the phone viewer used to be
    //    invisible to every attention predicate — the kanban-modal gap, one surface further out);
    //  - `agent:wake` fires on each attach, so a hibernated node someone just opened on their
    //    phone resumes its CLI — the same nudge contract as `wakeHibernatedNode` (re-reads the
    //    flag, no-ops when not hibernated or not mounted).
    remoteViewer: (() => {
      const counts = new Map<string, number>()
      const toRenderer = (channel: string, payload: unknown): void => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
      const broadcast = (): void => toRenderer(IPC.agentRemoteViewers, [...counts.keys()])
      return {
        attached(nodeId: string) {
          counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1)
          broadcast()
          toRenderer(IPC.agentWake, nodeId)
        },
        detached(nodeId: string) {
          const n = (counts.get(nodeId) ?? 0) - 1
          if (n <= 0) counts.delete(nodeId)
          else counts.set(nodeId, n)
          broadcast()
        }
      }
    })(),
    // Renderer-nudge node actions for the phone's session-LIST long-press menu (`node.wake` /
    // `node.refresh` / `node.rename`). Each returns whether it reached a LIVE window — the verb
    // answers ok only on delivery, never on outcome (nudge contract: the renderer re-reads its
    // own state and no-ops for a node it cannot resolve). `wake` reuses the exact `agent:wake`
    // channel the attach path fires, so the renderer needs no new wiring for it; `rename` rides
    // `agent:rename-node` into the renderer's `renameSession` funnel (titleAuto:false + `/rename`
    // push) — deliberately NOT canvas:mutate's raw title write, which the session-name poll would
    // overwrite on the next tick.
    nodeActions: (() => {
      const deliver = (channel: string, payload: unknown): boolean => {
        if (win.isDestroyed()) return false
        win.webContents.send(channel, payload)
        return true
      }
      return {
        wake: (nodeId: string) => deliver(IPC.agentWake, nodeId),
        refresh: (nodeId: string) => deliver(IPC.agentRefreshNode, nodeId),
        rename: (nodeId: string, title: string) => deliver(IPC.agentRenameNode, { nodeId, title })
      }
    })(),
    // Jail roots beyond the active canvas: the phone browses EVERY project (projects.list), so
    // its fs/git access spans every local project root — not just the tab the desktop happens
    // to have focused (that gap read as "cwd is outside the shared project roots" on the phone).
    workspaceRoots: () => workspaceStore.localProjectCwds()
  }
  // The renderer owns the Eco hibernation flag (persisted in ITS localStorage) and main only
  // mirrors it — same direction as `terminalFocused`. Feeds the agent-status mirror so the phone
  // renders SLEEPING (and re-fed at renderer boot from the persisted store, so a desktop restart
  // does not blank the phone's view of a still-hibernated session).
  ipcMain.on(IPC.agentHibernated, (_e, msg: { nodeId?: unknown; on?: unknown } = {}) => {
    if (typeof msg?.nodeId !== 'string' || !msg.nodeId) return
    setNodeHibernated(msg.nodeId, msg.on === true)
  })
  initRemoteHost(win, ptyManager, listProjectsOutput, hostBridge)
  // NEW interactive relay host (Stage 4): a connecting peer desktop becomes a first-class
  // CorePlatform client of this desktop after mutual SAS approval. Runs BESIDE initRemoteHost (the
  // phone still uses the legacy flow). Inert until `relay:host:start` — a solo user pays nothing.
  // Revocation reaches its sessions via `killRelayHostsByPeerKey` (peerRevoker, above).
  initRelayHost(win, corePlatform, {})
  // Standing (phone) relay host: keep a host connection registered so a paired phone can reach
  // this Mac from anywhere. Honors settings.phoneAccessEnabled internally.
  const standingHost = initStandingHost(win, ptyManager, () => settingsStore.get(), listProjectsOutput, hostBridge)
  ipcMain.on(IPC.remoteStandingHostSet, (_e, enabled: boolean) => standingHost.setEnabled(!!enabled))
  // Reconcile from persisted settings on launch (starts hosting if enabled).
  standingHost.syncFromSettings()
  // Interactive relay CLIENT (Stage 4): connect OUT to another desktop's host. `connectRelayClient`
  // runs the client half of mutual SAS approval and, once BOTH humans confirm, exposes the raw rpc.ts
  // frame pipe (`relay:client:send`/`relay:client:frame`) that Task 4's RpcClient drives. This is the
  // ONLY desktop client path now — the legacy `initRemoteClient` dialect was deleted in Task 10.
  // Inert until `relay:client:connect` — a solo user pays nothing.
  {
    const relayClients = new Map<string, RelayClientSession>()
    const sendTo = (channel: string, ...args: unknown[]): void => {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
    ipcMain.handle(IPC.relayClientConnect, async (_e, offerCode: string): Promise<string> => {
      // No Pro gate on the client: the paywall is the HOST minting the pairing token, so a valid offer
      // is the credential (the paywall is host-side). The dev/relay gate still applies.
      if (!relayAllowed()) {
        throw new Error('Remote access is unavailable in development builds (set NODETERM_RELAY_URL).')
      }
      const offer = decodeOffer(String(offerCode ?? ''))
      if (!offer) {
        throw new Error('That pairing code is invalid or incomplete.')
      }
      // Our persistent peer identity (4d: pinned on both ends). A locked keyring rejects here as
      // PeerKeyLockedError (E_PEER_KEY_LOCKED) — the identity on disk is intact and must NOT be rotated;
      // the renderer tells the human to unlock and reconnect.
      const keys = await loadOrCreatePeerKeyPair()
      const connectionId = randomUUID()
      const session = connectRelayClient({
        url: offer.relayEndpoint,
        token: offer.pairingToken,
        hostKeyB64: offer.hostPublicKeyB64,
        ourKeys: keys,
        // The SAS is known — push it so this human can compare it before the host approves.
        onSas: (s) => sendTo(IPC.relayClientSas(connectionId), s.sas()),
        // Mutually approved — the frame pipe is live.
        onApproved: () => sendTo(IPC.relayClientApproved(connectionId)),
        // An inbound rpc frame from the host (res/ev) → the renderer's RpcClient.
        onFrame: (json) => sendTo(IPC.relayClientFrame(connectionId), json),
        // pty output arrives on the SAME per-session channel a local pty uses (ws-bridge binary path).
        onPtyData: (sessionId, data) => sendTo(IPC.ptyData(sessionId), data),
        onClose: () => {
          relayClients.delete(connectionId)
          sendTo(IPC.relayClientClosed(connectionId))
        }
      })
      relayClients.set(connectionId, session)
      return connectionId
    })
    // This human compared the SAS and pressed Confirm → advance the trust gate (confirm rides the
    // ENCRYPTED tunnel). An unknown id (stale event) is a no-op.
    // Preload sends `{ id }` (matching the host side's relayHostConfirm), so read the object — a
    // positional `connectionId` here would stringify to "[object Object]" and match no session,
    // silently breaking the client's half of the mutual approval (never covered by vitest — this
    // send↔on boundary only runs under real Electron).
    ipcMain.on(IPC.relayClientConfirm, (_e, msg: { id?: string } = {}) => {
      if (msg?.id) relayClients.get(String(msg.id))?.confirm()
    })
    // The renderer casts an outbound rpc frame at the host (refused inside the session before approval).
    ipcMain.on(IPC.relayClientSend, (_e, connectionId: string, json: string) => {
      relayClients.get(String(connectionId))?.send(String(json))
    })
    // `on`, not `handle`: the preload calls this via `ipcRenderer.send` (fire-and-forget), which an
    // `ipcMain.handle` would never receive — the socket would never close and the host-side presence
    // leave would never fire (the peer lingers in the host facepile).
    ipcMain.on(IPC.relayClientDisconnect, (_e, connectionId: string) => {
      const id = String(connectionId)
      relayClients.get(id)?.close()
      relayClients.delete(id)
    })
  }
  sshProjectManager = initSshProject(
    (projectId) => {
      // On (re)connect, reconcile the server's .nodeterm/project.json with our offline cache by rev.
      // A non-null result means the remote won → adopt it in the renderer (Task 7's listener does the
      // silent replace / conflict bar). null means our cache was pushed up instead, so nothing to send.
      // The .catch is load-bearing: this fires on every successful SSH connect, sendToMain THROWS
      // when the render frame is disposed (reload, crash, quit, see ssh-project.ts), and an
      // unhandled rejection is a hard main-process crash, not a log line. Right after the user
      // answers a passphrase prompt is exactly when the renderer can be mid-churn.
      void workspaceStore
        .refreshSshProject(projectId)
        .then((adopted) => {
          if (adopted) sendToMain(IPC.workspaceExternalChange, adopted)
        })
        .catch(() => {})
    },
    askpassScriptPath,
    // The project's reverse hook tunnel is verified again on a freshly established master: every
    // hook event fired while it was down is gone (the POSTs are fire-and-forget and nothing queues
    // them on the host), so ask the host what is actually true for the nodes we still believe are
    // working. Fire-and-forget — this must never delay or fail the connect that has already
    // reported `connected`.
    (_projectId, controlPath, conn) => {
      void resyncProjectAgents({
        workingNodes,
        hostSessionNames: async () => {
          if (!sshProjectManager) return new Set<string>()
          const { code, stdout } = await sshProjectManager.sshRun(
            remoteListSessionsArgs(conn, controlPath)
          )
          // `list-sessions` exits non-zero when no tmux server is running — that is "no sessions",
          // not a failed read, and either way an empty set repairs nothing.
          return new Set(code === 0 ? parseRemoteSessionNames(stdout) : [])
        },
        paneCommand: async (nodeId) => {
          // The node's REMOTE pane, over this project's master. `PtyManager.paneCommand` would
          // read our live session map, which a backgrounded project has already been dropped from.
          if (!sshProjectManager) return null
          const { code, stdout } = await sshProjectManager.sshRun(
            remotePaneCommandArgs(conn, controlPath, sessionName(nodeId))
          )
          return code === 0 ? stdout.trim() || null : null
        },
        readTranscriptTail: async (nodeId, sessionId) => {
          // cwd/accountId are unknown here: with no accountId there is exactly ONE transcript root
          // (the system one), so a managed-account node without a hook-fed ref simply stays
          // undecided. A hook-fed ref (the common case) is already cached by session id. The
          // explicit `remote` is what keeps this working for a node with no live pty session.
          const ref = await remoteTranscriptRefFor(sessionId, undefined, undefined, nodeId, {
            conn,
            controlPath
          })
          // A small tail, NOT the read path's 5 MB cap: the verdict is about the last few records,
          // and a wider window only lets an ancient unmatched tool_use pin the node at `working`.
          return ref
            ? await readRemoteTranscript(sessionId, ref, RESYNC_TRANSCRIPT_TAIL_BYTES)
            : null
        },
        emit: emitAgentStatus
      }).catch(() => {
        // best-effort: a failed resync leaves the stale sweep as the backstop, exactly as today
      })
    },
    // The standalone relay bundle uploaded to a Linux host for managed Codex accounts (S6 PR 6).
    // Only executable code is ever uploaded — never a credential (Property 1). Reading it is
    // single-fd (openSync→fstatSync→readFileSync(fd)) so there is no stat-then-read TOCTOU on the
    // path, and the result is cached (the artifact never changes within an app run). A missing
    // artifact resolves to '' — `installRemoteCodexRuntime` treats an empty bundle as "no runtime"
    // and never fails a plain SSH connect over it.
    loadCodexRelayBundle,
    // Lead-pane width (issue #119) for the remote tmux conf, read at connect time so the host
    // carries the value the user last saved. 0 (the default) keeps the conf byte-identical.
    () => settingsStore.get().tmuxLeadPaneWidth
  )
  // Wake-from-sleep: re-validate every SSH master NOW instead of letting ServerAlive discover the
  // dead TCP ~60s later — until it does, every remote terminal looks alive and is dead (no echo,
  // no scroll). The small delay lets the network interface come back up first; connect() is
  // idempotent so a master that survived the nap is a cheap `-O check` no-op.
  powerMonitor.on('resume', () => {
    setTimeout(() => void sshProjectManager?.revalidateAll(), 2000)
  })
  // While connected, poll each SSH project's server file: the mobile companion appends the
  // sessions it starts to <remoteCwd>/.nodeterm/project.json, and this is how those nodes reach
  // the live canvas without a reconnect. Read-only unless a mirror write is owed
  // (pushIfStanding:false), one `cat` per project per tick over the ControlMaster. The in-flight
  // set keeps a hung read from stacking a second poll on the same project.
  //
  // A project only HAS a master because the renderer's active-project effect connected it, which
  // left every background / never-opened SSH tab permanently unpolled: a session the phone
  // registered into one of them showed up only when the user happened to click that tab. So each
  // tick also sweeps the unconnected ones — REUSE-ONLY (see remote-workspace-poll.ts): a master
  // that is already running is adopted, a host with no live socket is never dialed.
  {
    const REMOTE_WORKSPACE_POLL_MS = 15_000
    /** How long a cached ssh endpoint map may be reused before it is re-read from the index. */
    const SSH_ENDPOINT_TTL_MS = 5 * 60_000
    const inFlight = new Set<string>()
    let endpoints = new Map<string, { conn: SshConnection; remoteCwd: string }>()
    let endpointsAt = 0
    /** The project's connection spec, from the workspace index. Loaded lazily and only when an
     *  adoption candidate exists, so a workspace with no orphan sockets never pays for it. */
    const endpointFor = async (
      projectId: string
    ): Promise<{ conn: SshConnection; remoteCwd: string } | undefined> => {
      if (Date.now() - endpointsAt > SSH_ENDPOINT_TTL_MS) {
        try {
          // sideline:false — a read-only caller must never rename a mid-merge project.json.
          const workspace = await workspaceStore.load({ sideline: false })
          endpoints = new Map(
            workspace.projects
              .filter((p) => p.ssh)
              .map((p) => [p.id, { conn: p.ssh!.server, remoteCwd: p.ssh!.remoteCwd }] as const)
          )
          endpointsAt = Date.now()
        } catch { /* keep the previous map: a failed read is not evidence the endpoints changed */ }
      }
      return endpoints.get(projectId)
    }
    setInterval(() => {
      const mgr = sshProjectManager
      if (!mgr) return
      const plan = planRemoteWorkspacePoll({
        sshProjectIds: workspaceStore.sshProjectIds(),
        hasLiveRef: (projectId) => !!mgr.refForProject(projectId),
        busy: (projectId) => inFlight.has(projectId),
        // Reuse-only gate: no socket file ⇒ no master to adopt ⇒ this project is left alone.
        hasControlSocket: (projectId) => existsSync(controlPathFor(projectId))
      })
      for (const projectId of plan.poll) {
        inFlight.add(projectId)
        void workspaceStore
          .refreshSshProject(projectId, { pushIfStanding: false })
          .then((adopted) => {
            if (adopted) sendToMain(IPC.workspaceExternalChange, adopted)
          })
          .catch(() => { /* fail-open: the next tick retries */ })
          .finally(() => inFlight.delete(projectId))
      }
      for (const projectId of plan.adopt) {
        inFlight.add(projectId)
        void (async () => {
          const endpoint = await endpointFor(projectId)
          if (!endpoint) return
          // Ask the socket itself before touching connect(): a leftover file whose master is gone
          // would otherwise send connect() down the DIAL path — the one thing this sweep must not
          // do. `-O check` speaks to the local mux socket only; with no master it fails at once
          // without opening a connection.
          const { code } = await mgr.sshRun(checkMasterArgs(endpoint.conn, controlPathFor(projectId)))
          if (code !== 0) return
          // Live master → connect() takes its reuse branch (no new auth, no passphrase prompt) and
          // registers the ref, so the NEXT tick simply polls this project like any other.
          await mgr.connect(projectId, endpoint.conn, endpoint.remoteCwd)
        })()
          .catch(() => { /* fail-open: the next tick retries */ })
          .finally(() => inFlight.delete(projectId))
      }
    }, REMOTE_WORKSPACE_POLL_MS)
  }
  // Route git-service + commit-message git ops over the active SSH project's master only — and only
  // for that project's exact remoteCwd. Any other cwd (a local project, or a different connected
  // project) resolves to undefined, so the local path stays byte-identical.
  setGitRemoteResolver((cwd) => (activeRemote && activeRemote.cwd === cwd ? activeRemote.ref : undefined))
  // The renderer's active-project effect calls this on every switch: a non-null projectId of a
  // connected SSH project (whose ref carries a remoteCwd) arms remote routing; null/local disarms it.
  ipcMain.handle(IPC.gitSetActiveRemote, (_e, projectId: string | null) => {
    const ref = projectId ? sshProjectManager?.refForProject(projectId) : undefined
    activeRemote =
      ref && ref.remoteCwd
        ? { cwd: ref.remoteCwd, ref: { conn: ref.conn, controlPath: ref.controlPath } }
        : null
  })

  app.on('activate', () => {
    // With hide-on-close the window usually still exists — just re-show it. Only a truly
    // gone window (e.g. renderer crash) is recreated; createWindow re-registers it as the
    // main window, so send-time resolution keeps agent-status forwarding alive.
    const existing = getMainWindow()
    if (existing) {
      existing.show()
      existing.focus()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS the app stays alive, so the async final snapshots inside killAll can complete
  // in the background; on other platforms quitting goes through before-quit below.
  if (process.platform !== 'darwin') {
    app.quit()
  } else {
    void ptyManager.killAll()
    // Land any pending throttled .nodeterm mirror write BEFORE the masters die — killing a
    // master mid-write used to leave a truncated project.json on the server.
    void remoteWorkspaceIO.flush().finally(() => {
      sshProjectManager?.disconnectAll()
      // Every master is gone, so nothing can use the unlocked key; scheduled (not stop()) so a
      // quick window-reopen + reconnect inside the grace re-uses the agent instead of re-prompting.
      // Without this, a destroyed window left the key alive for the agent's full 12h backstop.
      appSshAgent.scheduleStop()
    })
  }
})

// The final scrollback snapshots are async (capture subprocess + fs.promises write) — hold
// the quit just long enough for them to land, capped so a hung tmux can never block quit.
let quitFlushed = false
app.on('before-quit', (e) => {
  // Menu Quit / Cmd+Q / Ctrl+Q reach here directly (no window-close event first), so the confirm
  // gate is repeated here for that path. quitConfirmed short-circuits this on the re-issued
  // app.quit() below once the user has answered, and on the win.close() gate's own re-issue.
  if (!quitConfirmed && !skipQuitConfirmation) {
    e.preventDefault()
    void confirmQuit(getMainWindow() as unknown as BrowserWindow | null).then((ok) => {
      if (ok) app.quit()
    })
    return
  }
  quitting = true // from here on, window close-events must NOT be turned into hide
  destroyNotchHud()
  // Electron releases power assertions at exit anyway; disposing keeps the hold/release log
  // honest. Clearing the ref too keeps a hook edge that lands during the quit flush (the pty
  // teardown window below) from re-holding an assertion nothing will ever release.
  keepAwake?.dispose()
  keepAwake = undefined
  workspaceWatcher.dispose()
  // A setup/archive run is a DETACHED process group (setsid, so cancel can SIGKILL the tree), which
  // means quitting without this leaves `npm ci` churning with no app left to report to — and the
  // hook/pty teardown below would never touch it. Idempotent, so the second before-quit pass (the
  // deferred app.quit()) costs nothing.
  projectSetupService.disposeAll()
  if (quitFlushed) {
    // Second pass (the deferred app.quit() below): the flush had its chance — drop the masters.
    sshProjectManager?.disconnectAll()
    // Then the app-private ssh-agent, which is the whole point of it existing: quitting nodeterm
    // forgets the unlocked key. AFTER disconnectAll so a throw here can never skip the master
    // teardown, and in this pass rather than the first, where the flush is still writing over
    // those masters. `.finally(app.quit())` above guarantees this pass runs.
    appSshAgent.stop()
    // And the askpass relay's socket file: close() is what unlinks a unix socket (process exit
    // does not), and a lingering file is one more thing the next start() has to clear.
    askpassServer.stop()
    // Hook server last among the closers, and on THIS pass so the flush window above could still
    // receive hook POSTs: stopping unlinks its socket AND its endpoint file (issue #445), so a
    // graceful quit never leaves an advertisement pointing at a dead port for the tmux sessions
    // that outlive the app. The next launch rewrites both; a crash skips this, which is what the
    // generated clients' endpoint failover exists for.
    hookServer.stop()
    // A SIGTERM quit (dev runners, `kill`, logout) arrives through Chromium's shutdown
    // detector, and this pass's re-issued app.quit() cannot resume the OS-initiated
    // termination the first pass preventDefault'ed: both passes run, but will-quit never
    // fires and the process lingers as a windowless shell. Everything that must land has
    // landed by this point, so give Electron a moment to finish on its own, then force the
    // exit. A normal Cmd+Q exits well inside the fuse and never reaches it.
    setTimeout(() => app.exit(0), 1500)
    return
  }
  quitFlushed = true
  e.preventDefault()
  // Pending throttled .nodeterm mirror writes must land BEFORE the ControlMasters die — killing
  // a master mid-write used to leave a truncated project.json on the server. The masters are
  // therefore kept up through the raced flush and dropped on the second before-quit pass.
  const flush = Promise.allSettled([remoteWorkspaceIO.flush(), ptyManager.killAll()])
  void Promise.race([flush, new Promise((r) => setTimeout(r, 1500))])
    // Then let whisper go. A dictation still transcribing when Electron tears down the main
    // process's node env aborts the WHOLE app from inside the native addon (SIGABRT in
    // Napi::ThreadSafeFunction::CallJS) — see SpeechService.shutdown. It needs its own budget
    // because the 1500ms cap above is shorter than a transcription, and it costs nothing at
    // all when dictation is idle, which is nearly always.
    .then(() => speechService.shutdown())
    .finally(() => app.quit())
})

import { join, resolve, posix } from 'path'
import { startSessionNameSweep, displayNodeTitle } from '../core/session-name-sweep'
import { readSessionName as readSessionNameForSweep } from '../core/transcript-reader'
import { canRename, type AgentId } from '@shared/agents/config'
import { readFile } from 'fs/promises'
import { homedir, hostname } from 'os'
import { randomUUID } from 'crypto'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, powerMonitor, safeStorage, shell, systemPreferences } from 'electron'
import { IPC } from '../shared/ipc'
import { registerFsHandlers } from '../core/fs-handlers'
import { registerBoardLogHandlers, type BoardLogRoute } from '../core/board-log-handlers'
import type { RemoteLogExec } from '../core/board-log'
import { boardLogRemotePath } from '../core/board-log'
import { PtyManager } from '../core/pty-manager'
import { WorkspaceStore } from '../core/workspace-store'
import { WorkspaceWatcher } from '../core/workspace-watcher'
import { SettingsStore } from '../core/settings-store'
import { presenceHub } from '../core/presence/hub'
import { SshStore } from './ssh-store'
import { GitService } from '../core/git-service'
import { registerGitHubIntegration } from '../core/github/integration'
import { runGitHubCliCommand } from '../core/github/credentials'
import { ElectronGitHubSecretStore, registerElectronGitHubControl } from './github-control'
import { generateCommitMessage, generateGroupName, generateTerminalName } from '../core/commit-message'
import { initUpdater } from './updater'
import { fetchCheck } from '../core/check'
import { hookServer } from '../core/agents/hook-server'
import { askpassServer, ensureAskpassScript } from './remote-ssh/ssh-askpass'
import { appSshAgent } from './remote-ssh/ssh-agent'
import {
  writePendingAnswerLocal,
  startPendingSweep,
  isValidPendingId,
  syntheticAnsweredEvent
} from '../core/agents/pending-approvals'
import { setMainWindow, getMainWindow, sendToMain, shouldHideOnClose } from './main-window'
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
  sessionNameSweepEntries,
  nodeState,
  nodeSessionName
} from '../core/agent-status-mirror'
import { createPushNotify, createLiveUpdatePush } from '../core/push-notify'
import { createGrantsAccessor } from '../core/push-grants'
import { createAckSweeper } from '../core/ack-sweep'
import { createSessionReaper } from '../core/session-budget'
import { getDeviceId } from '../core/device-id'
import { initRemoteStatusPush } from './remote-ssh/remote-status-push'
import { initCanvasSync } from '../core/canvas-sync'
import { retainUntilDismissed } from './notifications'
import { installManagedAgentHooks } from '../core/agents/hooks'
import { createSubagentTail } from '../core/subagent-tail'
import { createContextTail, type TaskNotification } from '../core/context-tail'
import { isAsyncSubagentLaunch, type NormalizedAgentEvent } from '../shared/agents/normalize'
import {
  readSessionName,
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
import { childArgs } from '../core/remote-ssh/control-master'
import { posixQuote } from '../shared/ssh'
import { buildHandoff, type HandoffRemote } from './handoff'
import { initContextLink, setNodeTranscript } from '../core/context-link'
import { transcriptPathOf } from '../core/context-link-core'
import { initCanvasControl, installCanvasSkillInto } from './canvas-control'
import { initTranscriptIndex, searchTranscripts } from '../core/transcript-index'
import { initTelemetry } from './telemetry'
import { initClaudeUsage } from './claude-usage'
import { remoteUsageTargets } from '../core/usage/remote-claude-usage'
import { initLicense, isPremium, getStoredEntitlement } from '../core/license'
import { WhisperModelStore } from '../core/speech/whisper-models'
import { SpeechService } from '../core/speech/speech-service'
import { registerSpeechIpc } from '../core/speech/register-ipc'
import { initClaudeAccounts } from './claude-accounts'
import { claudeCliCaps, registerClaudeCliIpc, type ClaudeCliCaps } from '../core/claude-cli'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import {
  isSafeLocalTranscriptPath,
  isSafeRemoteTranscriptPath,
  remoteAccountConfigDirAbs
} from '../core/claude-accounts-core'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from '../core/agents/hooks/claude'
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
import { setGitRemoteResolver, type GitRemoteRef } from '../core/remote-ssh/remote-git'
import { SshFs, sshAppendArgs, sshTailArgs, sshSizeArgs, sshWriteArgs } from './ssh-fs'
import { makeRemoteWorkspaceIO } from './remote-workspace-io'
import {
  registerMediaScheme,
  initMediaProtocol,
  allowMediaPath,
  writeAgentHtml
} from './media-protocol'
import { initPlatform } from '../core/platform'
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
wirePeerRegistry({
  setFlow: (id, sid, resume, owner) => ptyManager.setFlow(id, sid, resume, owner),
  captureForResync: (sid) => ptyManager.captureForResync(sid),
  onPeerGone: (id) => ptyManager.dropClient(id)
})

// Set once the app window is ready; used by the quit hooks to tear down SSH-project masters and
// (via the closures below) to resolve a live SSH project's ControlMaster for remote workspace IO.
let sshProjectManager: ReturnType<typeof initSshProject> | undefined
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
workspaceStore.onPersist = () => workspaceWatcher.sync()
const gitService = new GitService()

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

// Browser <webview> guest webContents id → its browser node id (for new-window capture).
const browserGuests = new Map<number, string>()

// Node → live tail bookkeeping, so closing a node (× → pty:destroy) releases its file tailers.
// Without this, a node closed mid-run never emits SessionEnd/PostToolUse, so context-tail (1s
// poll) and subagent-tail (400ms poll) would keep stat/read-ing forever. Keyed by node id.
const nodeContextSession = new Map<string, string>() // nodeId → claude sessionId
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
    // Integrate the macOS traffic lights into our top bar (modern Mac app look).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
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
  })
  // A crashed/killed renderer is the same story, minus the window: drop its subscriptions so the
  // reloaded renderer reattaches to live sessions instead of inheriting the dead one's state.
  win.webContents.on('render-process-gone', () => ptyManager.dropClient(presenceId))

  win.on('ready-to-show', () => win.show())
  // The main window is a regular app window; establishing its Dock presence explicitly means the
  // later focusable:false Notch HUD panel can never leave the app looking like an accessory.
  win.on('show', () => assertRegularDockPresence())

  // macOS: closing the window hides it instead of destroying it. The app deliberately
  // outlives its window (tmux sessions, hook server, updater); destroying the window
  // would leave every window-bound subsystem (agent-status forwarding, tails, updater,
  // license events) pointing at a dead webContents after a dock-reopen.
  win.on('close', (e) => {
    if (shouldHideOnClose(process.platform, quitting)) {
      e.preventDefault()
      win.hide()
    }
  })

  // Intercept Cmd/Ctrl+M (default = minimize) and route it to the renderer for the
  // markdown-view toggle instead.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return
    const key = input.key.toLowerCase()
    if (key === 'm') {
      event.preventDefault()
      win.webContents.send(IPC.appToggleMarkdown)
    } else if (key === 'w' && !input.shift) {
      // Repurpose Cmd/Ctrl+W: the renderer closes the selected node(s); if none are
      // selected it asks us to close the window (the standard behavior).
      event.preventDefault()
      win.webContents.send(IPC.appCloseNode)
    }
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
    if (contents.getType() !== 'webview') return
    // Web nodes may only show http(s) pages or local content we serve via the jailed
    // nt-media:// scheme.
    contents.on('will-navigate', (e, url) => {
      if (!/^https?:\/\//i.test(url) && !/^nt-media:\/\//i.test(url)) e.preventDefault()
    })
    // A browser node's guest requested a new window → open it as another browser node
    // (never a real popup). Only http(s); other schemes are dropped. The map is consulted
    // live at call time, so a guest registered later (on dom-ready) is seen when a popup fires.
    contents.setWindowOpenHandler(({ url }) => {
      const sourceNodeId = browserGuests.get(contents.id)
      if (sourceNodeId && /^https?:\/\//i.test(url)) {
        sendToMain(IPC.browserNewWindow, { url, sourceNodeId })
      }
      return { action: 'deny' }
    })
  })

  settingsStore.init()
  settingsStore.registerIpc()
  sshStore.registerIpc()
  ptyManager.init(() => settingsStore.get())
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

  ipcMain.on(IPC.browserRegister, (_e, webContentsId: number, nodeId: string) => {
    browserGuests.set(webContentsId, nodeId)
  })
  ipcMain.on(IPC.browserUnregister, (_e, webContentsId: number) => {
    browserGuests.delete(webContentsId)
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

  corePlatform.handle(IPC.ptyReadSessionName, (sessionId: string, accountId?: string) =>
    readSessionName(sessionId ?? '', accountId)
  )

  ipcMain.on(IPC.appCloseWindow, () => BrowserWindow.getFocusedWindow()?.close())

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
  // through shellOpenExternal's http(s)-only allowlist (which silently drops x-apple.* URLs —
  // the "Open System Settings" button did nothing when it sent the URL from the renderer).
  // The `Services_RemoteLogin` query selected the service in the pre-Ventura prefpane and is
  // harmless on newer macOS, which opens the Sharing pane either way.
  ipcMain.handle(IPC.pairingOpenRemoteLoginSettings, () => {
    if (process.platform !== 'darwin') return
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preferences.sharing?Services_RemoteLogin'
    )
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

  // The Explorer/Editor fs surface: ONE registrar (core/fs-handlers.ts) shared by this shell and
  // the Server Edition, over the same pure core/fs-ops — so local, browser and peer filesystem
  // behaviour cannot drift. Registered on the platform, so a remote tab's Explorer/editor works.
  registerFsHandlers(corePlatform)

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

  // Board-log: same CorePlatform registrar as the Server Edition (core/board-log-handlers.ts), with
  // a desktop router that adds SSH routing on top of the local-cwd/unsupported the server also does.
  // A connected SSH project (refForProject → a ref with a remoteCwd) reads/writes/fingerprints over
  // its ControlMaster; anything else falls to the local folder cwd, then unsupported.
  registerBoardLogHandlers(corePlatform, {
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
  initUpdater(() => {
    quitting = true
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
    resolve: (sessionId, accountId) => readSessionNameForSweep(sessionId, accountId),
    publish: setNodeSessionName,
    supports: (agentId) => !!agentId && canRename(agentId as AgentId)
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
    return { enabled: s.notchHud, notchWidth: s.notchWidth, hoverExpand: s.notchHoverExpand }
  }
  const startNotchHud = (): void =>
    initNotchHud({ getNodeTitle: displayTitleFor }, notchTunables())
  if (win.isVisible()) startNotchHud()
  else win.once('show', startNotchHud)
  settingsStore.onChange(() => applyNotchHudSettings(notchTunables()))
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
  // `~/.nodeterm/push-grants/<deviceId>.grant` on the Mac's own fs. `resolveTarget` keeps a SINGLE
  // sender: host-mode only when a relay identity is present AND a phone is paired; else (unpaired,
  // or no identity) it falls through to the grants. So a plain-SSH phone gets pushes for
  // Mac-tracked sessions with NO QR pairing, and QR-pairing later flips `hasPairedPhone` true →
  // host-mode automatically (grants suppressed — no double-push to the same phone).
  const pushGrants = createGrantsAccessor()
  let pushHostKeyB64: string | null = null
  let pushHasPairedPhone = false
  const refreshPushIdentity = async (): Promise<void> => {
    try {
      pushHostKeyB64 = publicKeyToB64((await loadOrCreateKeyPair()).publicKey)
    } catch {
      // Keyring locked / transient read error: keep the last-known key (never clobber identity).
    }
    try {
      pushHasPairedPhone = (await loadApprovedDevices()).pubkeys.length > 0
    } catch {
      pushHasPairedPhone = false
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
    getGrants: () => pushGrants.get(),
    markGrantDead: (grant) => pushGrants.markDead(grant),
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
    getGrants: () => pushGrants.get(),
    markGrantDead: (grant) => pushGrants.markDead(grant),
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
  const contextTail = createContextTail((payload) => {
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
  }, { onTaskNotification, onToolResult })
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
   */
  const remoteTranscriptRefFor = async (
    sessionId: string | undefined,
    cwd: string | undefined,
    accountId: string | undefined,
    nodeId: string | undefined
  ): Promise<RemoteFileRef | undefined> => {
    if (!sessionId) return undefined
    const cached = remoteTranscriptBySession.get(sessionId)
    if (cached) return cached
    if (!nodeId) return undefined
    const rt = ptyManager.sshRemoteForNode(nodeId)
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
   * Without this the panel's Retry replays a dead path forever (the transcript was deleted, or the
   * session moved) because the cache lookup comes first. A hook-fed ref is deliberately left in
   * place on an empty read — that is usually a transient master hiccup, and dropping it would send
   * the next read down the LOCAL resolver, i.e. to the wrong machine.
   */
  const readRemoteTranscript = async (sessionId: string, ref: RemoteFileRef): Promise<string> => {
    const text = await remoteFile.readTail(ref, REMOTE_TRANSCRIPT_CAP)
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
  // so an app update's new versions reach every account dir. Best-effort: one failing account
  // must never block launch (match installManagedAgentHooks' fail-open).
  for (const acct of settingsStore.get().claudeAccounts ?? []) {
    if (acct.host) continue // remote accounts live on another host; nothing to install locally
    try {
      installClaudeHooksInto(claudeConfigDirFor(acct.id))
      installCanvasSkillInto(claudeConfigDirFor(acct.id))
      // Ensure fullscreen TUI in this account dir (write-if-absent, version-gated). Off the
      // critical path: it awaits the memoized CLI probe, then writes fail-open. (The system
      // ~/.claude is handled by installManagedAgentHooks above, which covers Server Edition too.)
      void ensureClaudeFullscreenTuiInto(claudeConfigDirFor(acct.id))
    } catch (e) {
      console.warn(`[agent-hooks] account ${acct.id} hook install failed`, e)
    }
  }
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
  createSessionReaper({ tmuxBin: () => ptyManager.getTmuxBin() }).start()
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
    return isSafeLocalTranscriptPath(abs, homedir(), app.getPath('userData')) ? abs : undefined
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
  hookServer.setRawListener((agentId, nodeId, payload) => {
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
      contextTail.untrack(sessionId)
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
  // requestId) bridges the two async hops; both the reply and the 120s timeout clear the entry.
  const pendingControl = new Map<
    string,
    {
      resolve: (r: { ok: boolean; message?: string; result?: unknown; error?: string }) => void
      timer: NodeJS.Timeout
    }
  >()
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
  hookServer.setControlHandler(async ({ verb, nodeId, args }) => {
    const target = getMainWindow()
    if (!target) return { ok: false, error: 'window unavailable' }
    const requestId = randomUUID()
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingControl.delete(requestId)
        resolve({ ok: false, error: 'timed out (no response / not confirmed)' })
      }, 120_000)
      pendingControl.set(requestId, { resolve, timer })
      target.webContents.send(IPC.agentControl, { requestId, sourceNodeId: nodeId, verb, args })
    })
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
  })
  initCanvasControl()
  // Usage service + the mobile `usage` mirror block (mobile-usage-inbox): poll all local managed
  // accounts alongside the system account, and re-flush the mirror on every cache update. The
  // provider pairs the service's cache with the settings account labels at flush time; SSH slices
  // drop it (filterMirrorForNodes) — a host answers only for its own local credentials.
  const localClaudeAccountIds = (): string[] =>
    (settingsStore.get().claudeAccounts ?? []).filter((a) => !a.host && !a.pending).map((a) => a.id)
  const usageService = initClaudeUsage(win, {
    localAccounts: localClaudeAccountIds,
    onCacheUpdate: () => {
      void flushAgentStatusMirror()
    },
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
  // The jailed core bridge both phone hosts serve: typed git verbs against the real GitService
  // (cwd-jailed to the shared canvas roots inside the handlers) and phone node registration
  // through the workspace store (written as an outside edit, so the watcher broadcasts it and
  // the canvas adopts the node live).
  const hostBridge = {
    git: gitService,
    registerNode: (projectId: string, node: { id: string; title?: string; agentId?: string }) =>
      workspaceStore.appendRemoteNode(projectId, node),
    // Jail roots beyond the active canvas: the phone browses EVERY project (projects.list), so
    // its fs/git access spans every local project root — not just the tab the desktop happens
    // to have focused (that gap read as "cwd is outside the shared project roots" on the phone).
    workspaceRoots: () => workspaceStore.localProjectCwds()
  }
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
    askpassScriptPath
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
  {
    const REMOTE_WORKSPACE_POLL_MS = 15_000
    const inFlight = new Set<string>()
    setInterval(() => {
      for (const projectId of workspaceStore.sshProjectIds()) {
        if (inFlight.has(projectId) || !sshProjectManager?.refForProject(projectId)) continue
        inFlight.add(projectId)
        void workspaceStore
          .refreshSshProject(projectId, { pushIfStanding: false })
          .then((adopted) => {
            if (adopted) sendToMain(IPC.workspaceExternalChange, adopted)
          })
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
  quitting = true // from here on, window close-events must NOT be turned into hide
  destroyNotchHud()
  workspaceWatcher.dispose()
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
  void Promise.race([flush, new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit())
})

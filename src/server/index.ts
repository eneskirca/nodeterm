import { subagentReplay } from '../core/subagent-replay'
import fs from 'fs'
import { readAgentSessionName } from '../core/agent-session-name'
import { startSessionNameSweep, displayNodeTitle } from '../core/session-name-sweep'
import { startTriggerService } from '../core/trigger-service'
import path from 'path'
import http from 'http'

import { ServerPlatform } from './platform-server'
import { Auth } from './auth'
import { createHttpHandler } from './http'
import { attachWsServer } from './ws'
import { describeTrustedNets } from './proxy-trust'
import type { ServerConfig } from './config'

import { initPlatform } from '../core/platform'
import { SettingsStore } from '../core/settings-store'
import { WorkspaceStore } from '../core/workspace-store'
import { startSshActionsService } from '../core/ssh-actions'
import { ManagedTerminals } from '../core/managed-terminals'
import { createManagedTerminalPlanner } from '../core/managed-terminal-plan'
import { findInLoginPath } from '../core/exec-path'
import { codexIdentityCaps } from '../core/codex-identity-caps'
import { grokCliCaps } from '../core/grok-cli'
import { registerAgentEnvIpc } from '../core/agent-env-ipc'
import { PtyManager, resolveLocalSessionShell } from '../core/pty-manager'
import { registerCoreHandlers } from './handlers'
import { registerGitHubIntegration } from '../core/github/integration'
import { registerBoardDispatchReportIpc } from '../core/board-dispatch-report'
import { runGitHubCliCommand } from '../core/github/credentials'
import {
  registerServerGitHubControl,
  ServerGitHubSecretStore,
  ServerSecretStore
} from './github-control'
import {
  migrateLegacyModelGatewayKey,
  MODEL_GATEWAY_SECRET_FILE,
  ModelGatewayCredentialService
} from '../core/model-gateway-credentials'
import { DownloadTickets } from '../core/download-tickets'
import { registerBoardLogHandlers, type BoardLogRoute } from '../core/board-log-handlers'
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
import { LogBuffer } from '../core/log-buffer'
import { installLogSink } from '../core/log-sink'
import { registerLogHandlers } from '../core/log-handlers'
import os from 'os'
import { hookServer } from '../core/agents/hook-server'
import { serverEditionControlHandler } from './control-unsupported'
import { initServerCanvasControl, serverCanvasShimPath, type ServerCanvasControl } from './canvas-control'
import { registerStationNoticeIpc } from '../core/agents/station-notice'
import { registerStationOutcomeIpc } from '../core/station-outcome-store'
import { registerStationHandoverIpc } from '../core/station-handover'
import { refreshNodeTokens } from '../core/agents/node-token-service'
import { armServerNodeIdentity } from './node-identity-arm'
import { wireServerCodexSharedIdentity } from './codex-shared-identity'
import {
  writePendingAnswerLocal,
  answerPendingHookLocal,
  localHeldPermissionIo,
  startPendingSweep,
  isValidPendingId,
  syntheticAnsweredEvent
} from '../core/agents/pending-approvals'
import { answerHeldPermission } from '../core/agents/permission-decision'
import type { AnswerPermissionPayload } from '../shared/agents/permission-answer'
import {
  createIntegrationLifecycle,
  detectExistingIntegrations,
  registerIntegrationLifecycle,
  resolveIntegrationConsentAtBoot
} from '../core/agent-integrations'
import { registerIntegrationIpc } from '../core/agent-integrations-ipc'
import { contextLinkShimPath } from '../core/context-link'
import {
  initAgentStatusMirror,
  flush as flushAgentStatusMirror,
  recordAgentEvent,
  hookTicketStillOpen,
  ackDone,
  mirrorOwnsNode,
  setMirrorSettingsProvider,
  mirrorClaudeAccount,
  setMirrorLiveNodesProvider,
  setMirrorServerProvider,
  onInboxActionable,
  onNodeStateChange,
  onNodeNowChange,
  type MirrorSettings,
  type MirrorServer,
  setNodeSessionName,
  setNodeHibernated,
  seedNodeIdentities,
  sessionNameSweepEntries,
  nodeSessionName
} from '../core/agent-status-mirror'
import { mirrorCustomAgents } from '../core/mirror-custom-agents'
import { createPushNotify, createLiveUpdatePush } from '../core/push-notify'
import { createGrantsAccessor } from '../core/push-grants'
import { createAckSweeper } from '../core/ack-sweep'
import { createSessionReaper } from '../core/session-budget'
import { startSessionMemoryService, sshScopePredicate } from '../core/session-memory-service'
import { createMemoryPressureMonitor } from '../core/memory-pressure'
import { createPtyPressureMonitor } from '../core/pty-pressure'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { codexCliCaps } from '../core/codex-cli'
import type { CodexCliCaps } from '../shared/types'
import { UNKNOWN_CODEX_CLI_CAPS } from '../shared/types'
import { claudeConfigDirFor, registerClaudeAccountsSource } from '../core/claude-config-dir'
import { presenceHub } from '../core/presence/hub'
import { initCanvasSync, publishCanvasMutation, setReflectedListener } from '../core/canvas-sync'
import { createCanvasAuthority, type CanvasAuthority } from '../core/canvas-authority'
import { wireAgentStatus } from './agent-status'
import { initServerContextLink } from './context-link'
import { createServerWorkspaceWatcher, outsideEditPublisher } from './workspace-external-watch'
import { registerTranscriptIpc } from '../core/transcript-ipc'
import { registerChatCatalogIpc } from '../core/chat-catalog'
import { registerRecentConversationsIpc } from '../core/recent-conversations'
import { registerContextEnsureIpc } from '../core/context-ensure'
import { IPC } from '@shared/ipc'
import { WhisperModelStore } from '../core/speech/whisper-models'
import { SpeechService } from '../core/speech/speech-service'
import { registerSpeechIpc } from '../core/speech/register-ipc'
import { isPremium, getStoredEntitlement } from '../core/license'
import { getDeviceId } from '../core/device-id'
import { createHostedService } from '../core/relay/hosted-service'
import { startTeamAdmin } from '../core/relay/team-admin'
import { runResume } from '../core/relay/team-resume'
import { launchHeadless } from '../core/headless-launch'
import { HEADLESS_COLS, HEADLESS_ROWS, localNodePtyOptions } from '../shared/node-pty-options'
import { assembleResumeCommand } from '../shared/agents/launch'
import { gatePermissionMode, type AgentId, type BuiltinAgentId } from '../shared/agents/config'
import {
  createWatchLinkService,
  registerWatchLinkIpc,
  sendToOwners,
  shutdownWithin,
  workspaceNodeState,
  type WatchLinkService
} from '../core/watch-link/service'
import { createWatchLinkApi } from '../core/watch-link/api'
import { WatchLinkStore } from '../core/watch-link/store'
import { createWatchPty, watchRemoteFor, watchRemoteRecords, type WatchRemote } from '../core/watch-link/pty-seam'

// Same env-override + default as src/core/check.ts / license.ts / src/main/telemetry.ts — each
// shell derives it locally rather than sharing an import (src/server must not import src/main).
const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'
// The hosted team relay's wss endpoint. Same env override + default as the desktop's RELAY_URL
// (src/main/remote/host-service.ts), derived locally for the same reason as API_BASE.
const RELAY_URL = process.env.NODETERM_RELAY_URL || 'wss://relay.nodeterm.dev'
/** How long close() waits for the live-link service's last write (the desktop races 1.5 s). */
const WATCH_LINKS_STOP_MS = 2_000

/**
 * App version fed to ServerPlatform (surfaced to the renderer as the desktop app's
 * `app.getVersion()` equivalent). Read from package.json at boot; the esbuild bundle
 * lives at `out/server/main.cjs`, so `../../package.json` resolves to the repo root.
 * Falls back to '0.0.0' if the file can't be read (never fatal).
 */
function readAppVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../../package.json')
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Name the account this process runs as, for the canvas-control boot notice. `os.userInfo()`
 * THROWS a SystemError when the effective uid has no password-database entry — the normal case for
 * a container started with an arbitrary uid — so it is never called bare on a boot path: the log
 * line exists to inform the operator, and it must not be able to take the feature they enabled
 * down with it. Falls back to the numeric uid, and then to a plain phrase on a platform with none.
 */
function serverUserLabel(): string {
  try {
    return os.userInfo().username
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null ? 'the server user' : `uid ${uid}`
  }
}

/**
 * This host's Server-Edition install metadata (spec: server-update), surfaced to the phone via the
 * agent-status mirror's top-level `server` block. `scripts/install-server.sh` writes
 * `<dataDir>/install-meta.json` (`{version, commit, installedAt}`) after every successful install
 * or auto-update; the auto-update path restarts the service, so a boot-time read is always current.
 * Tolerant: a missing/corrupt file or a block with no usable fields yields `undefined` (no block).
 */
function readInstallMeta(dataDir: string): MirrorServer | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'install-meta.json'), 'utf8')
    const p = JSON.parse(raw) as { version?: unknown; commit?: unknown; installedAt?: unknown }
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
    const out: MirrorServer = {}
    const version = str(p.version)
    const commit = str(p.commit)
    const installedAt = str(p.installedAt)
    if (version) out.version = version
    if (commit) out.commit = commit
    if (installedAt) out.installedAt = installedAt
    return out.version || out.commit || out.installedAt ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Boot the headless server: wires the CorePlatform (ServerPlatform) to auth + HTTP +
 * WebSocket, then constructs and registers the same core services the desktop main
 * process uses (SettingsStore / PtyManager / WorkspaceStore), mirroring
 * `src/main/index.ts`'s construction + registration order.
 *
 * Returns the actually-bound port (so port 0 works in tests) and a `close()` that
 * detaches PTY clients (tmux sessions keep running — Phase 1 contract) and stops the server.
 */
export async function startServer(
  config: ServerConfig
): Promise<{ port: number; close(): Promise<void> }> {
  fs.mkdirSync(config.dataDir, { recursive: true })

  // Core platform boundary — must be initialized before any core service registers handlers.
  const platform = new ServerPlatform({
    userDataDir: config.dataDir,
    appVersion: readAppVersion()
  })
  initPlatform(platform)

  const auth = new Auth(config.dataDir)
  if (config.passwordSeed && !auth.isConfigured()) auth.setPassword(config.passwordSeed)
  if (config.trustProxy) {
    // Loud on purpose: this line is the operator's one chance to notice a trust
    // misconfiguration (wrong header name, or nets wider than the proxy's own subnet).
    console.log(
      `⚠️  Proxy header trust ENABLED: requests from [${describeTrustedNets(config.trustProxy.nets)}] ` +
        `carrying a non-empty "${config.trustProxy.header}" header are authenticated WITHOUT a ` +
        `password. Ensure ONLY your SSO reverse proxy can reach this server from those networks, ` +
        `and that it strips/overwrites this header on client requests.`
    )
  }
  if (!config.headless && !auth.isConfigured()) {
    // No password set yet: print the one-time setup URL so the operator can bootstrap.
    // (Headless binds no listener, so there is no setup page to point at.)
    console.log(`Setup: http://${config.host}:${config.port}/setup?token=${auth.setupToken()}`)
  }

  // Core services — same construction + registration order as src/main/index.ts.
  const settingsStore = new SettingsStore()
  const ptyManager = new PtyManager()
  const workspaceStore = new WorkspaceStore()

  settingsStore.init()
  // The linked-account resolver's one source of truth on this shell. Registered as
  // soon as settings exist and BEFORE anything that resolves a config dir — the mirror settings
  // provider, `installHooksIntoLocalAccounts`, the transcript jail — because an unregistered
  // source means "no linked accounts", i.e. a linked row would resolve to a managed dir that does
  // not exist. The desktop registers the identical getter next to `initTranscriptIndex`.
  registerClaudeAccountsSource(() => settingsStore.get().claudeAccounts ?? [])
  const gatewayCredentials = new ModelGatewayCredentialService(
    new ServerSecretStore(config.dataDir, MODEL_GATEWAY_SECRET_FILE)
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
    console.warn('[model-gateway] could not migrate the legacy API key to secret storage', error)
  }
  // Agent-integration consent (issue #744): grandfather an install from before this feature (our own
  // hook scripts / shims are on disk) as enabled, before any browser can load settings.
  if (config.installHooks !== false) {
    try {
      const grandfathered = resolveIntegrationConsentAtBoot(
        settingsStore.get(),
        detectExistingIntegrations(config.dataDir)
      )
      if (grandfathered) await settingsStore.save(grandfathered)
    } catch (error) {
      console.warn('[integrations] could not record the grandfathered consent', error)
    }
  }
  settingsStore.registerIpc()
  // Gateway discovery/credential IPC. NO env snapshot on the server: every registered handler
  // here is dispatchable by any authenticated WS client, and the server process environment is
  // exactly the secret store that must never cross that boundary. Browser clients hardcode an
  // empty snapshot and `${env:VAR}` expansion degrades to the missing-env refusal; discovery
  // resolves key REFERENCES only for the saved gateway URL (the exfil-oracle gate in core).
  registerAgentEnvIpc(() => settingsStore.get().modelGateway, gatewayCredentials)
  ptyManager.init(
    () => settingsStore.get(),
    () => gatewayCredentials.readForHost()
  )
  ptyManager.registerIpc()
  workspaceStore.registerIpc()
  // Dictation: same construction as src/main/index.ts, with the server's data dir. onProgress
  // broadcasts to every attached browser tab the same way wireAgentStatus pushes agent-status.
  const whisperModels = new WhisperModelStore({
    dir: path.join(config.dataDir, 'speech-models'),
    onProgress: (id, pct) => platform.broadcast(IPC.speechProgress, { id, pct })
  })
  const speechService = new SpeechService({ models: whisperModels, isPremium })
  registerSpeechIpc({
    handle: (channel, fn) => platform.handle(channel, fn),
    service: speechService,
    models: whisperModels,
    settings: () => settingsStore.get(),
    licenseToken: () => getStoredEntitlement(),
    apiBase: API_BASE
  })
  // Browser mic permission is the browser's own prompt (getUserMedia), not ours to gate —
  // unlike Electron's systemPreferences.askForMediaAccess, there is nothing server-side to ask.
  platform.handle(IPC.speechMicConsent, async () => true)
  // Canvas sync: reflect each browser tab's node mutations to the other attached tabs, so every
  // client converges on the same node set (and no tab writes back a node another tab deleted).
  initCanvasSync()
  // The canvas authority (docs/hosted-team-relay.md): the one writer of the content of every project
  // shared with a hosted team. Created further down, and only where this process owns the team (not
  // when another server holds this data dir); read late by everything below that needs it. Until
  // then — and forever on a server that does not own the team — nothing is governed.
  let canvasAuthority: CanvasAuthority | null = null
  // A client asks which projects are governed, to publish its ops for them even when it is alone.
  platform.handle(IPC.canvasAuthority, () => canvasAuthority?.governedIds() ?? [])
  // Team presence (hello / cursor / focus / chat). The hub itself is joined per WebSocket in
  // ws.ts; this only registers the RPC surface. Presence is transient — nothing is persisted.
  presenceHub.registerIpc()

  // WS backpressure: when a connection's socket send buffer fills while streaming pty
  // output, pause that tmux client so the OS pipe applies real backpressure (resumes below
  // the low-water mark). See platform-server.ts sendTo.
  //
  // The pause is attributed to the UI whose socket is backed up (`uiId`) — so PtyManager's ledger
  // (Session.pausedBy) returns it when that UI drains OR when it disconnects, and one backed-up
  // browser can no longer be un-paused by another browser's join/leave.
  //
  // It is booked under the 'socket' OWNER, not the same ticket as the pause that UI's own renderer
  // casts over `pty:flow`. The two queues are different and drain at different times — the socket
  // empties as fast as the browser reads bytes, the renderer's xterm backlog only as fast as it
  // parses them — so sharing one ticket would let the socket's drain (sweepPaused) hand back the
  // pause the renderer still owes. The renderer's flow control is edge-latched and would never
  // re-pause: its backlog would then grow at network speed for the rest of the flood.
  platform.setFlowController((uiId, sid, resume, owner) =>
    ptyManager.setFlow(uiId, sid, resume, owner)
  )

  // Bounded memory: a client whose socket backlog we discarded (WS_DROP_WATER) is REDRAWN from
  // tmux — the current screen — rather than replayed. See platform-server.ts dropOrDesync.
  platform.setResyncProvider((sid) => ptyManager.captureForResync(sid))

  // Desktop's src/main/index.ts registers a few pty handlers outside PtyManager. Of those,
  // ptyCapture delegates purely to core (ptyManager.captureSession), so it belongs here.
  // The others (ptyGenerateName / ptyGenerateGroupName → commit-message.ts; ptyReadSessionName
  // → transcript-reader.ts) depend on src/main-resident modules and are stubbed by the bridge
  // in Task 8. readScrollback + sendText + paneCommand are already registered inside
  // PtyManager.registerIpc().
  platform.handle(IPC.ptyCapture, (persistKey: string, full?: boolean) =>
    ptyManager.captureSession(persistKey, full)
  )
  // The late cold-start check (PtyCreateResult.freshUnverified). Pure core, and this shell runs on
  // the machine whose tmux it reads, so the answer is as good as the desktop's local one.
  platform.handle(IPC.ptySessionAge, (persistKey: string) => ptyManager.sessionAgeSeconds(persistKey))

  // fs + git + commit handlers (shared with desktop core services). The ticket store is shared
  // between the RPC side (which mints) and the HTTP side (which redeems) — one instance, so a
  // ticket minted over the socket is redeemable by the GET that follows it.
  const downloadTickets = new DownloadTickets()
  const { gitService } = registerCoreHandlers(platform, {
    getSettings: () => settingsStore.get(),
    onSettingsChange: (cb) => settingsStore.onChange(cb),
    downloadTickets,
    localProjectCwd: (projectId: string) => workspaceStore.localCwdForProject(projectId)
  })
  // Project setup/archive runner — same construction as src/main/index.ts, and the SAME
  // `registerProjectSetupHandlers` trust boundary (project-setup-handlers.ts): it derives rootPath/
  // ssh/projectName from THIS process's own workspace index by projectId, never the renderer, and
  // re-validates `worktreePath` against the project's actual git worktrees. No ssh leg here at all
  // (the Server Edition has no SSH projects, same reason board-log's router below never resolves
  // one) — `projectTargetInfo` never populates `ssh` on this shell, so an ssh-shaped target simply
  // never arises.
  const projectTrustStore = new ProjectTrustStore()
  const projectSetupService = new ProjectSetupService({
    trust: projectTrustStore,
    readSettings: (projectId) => workspaceStore.readProjectSettings(projectId),
    runLocal: makeLocalSetupRunner()
  })
  const projectSetupDeps: ProjectSetupHandlerDeps = {
    projectTargetInfo: (projectId) => workspaceStore.projectTargetInfo(projectId),
    worktreeList: (repoPath) => gitService.worktreeList(repoPath)
  }
  registerProjectSetupHandlers(platform, projectSetupService, projectSetupDeps)
  // `worktree:materialize-shared` — same sibling registrar and trust boundary as main/index.ts,
  // over this process's own stores. The Server Edition has no SSH projects, so an ssh-shaped target
  // never arises; the path validation and by-projectId list read are identical.
  registerWorktreeSharedPathsHandlers(platform, {
    readSettings: (projectId) => workspaceStore.readProjectSettings(projectId),
    targetInfo: projectSetupDeps.projectTargetInfo,
    worktreeList: projectSetupDeps.worktreeList
  })
  // `project-settings:launch-info` — same sibling registrar as main/index.ts, sharing this
  // process's own trust store.
  registerProjectLaunchInfoHandlers(platform, workspaceStore, projectTrustStore)
  // Project env + shell at the spawn — the same core factory main/index.ts wires, over this
  // shell's own stores. `requestTrust` is wired here too, and deliberately so: the Server Edition's
  // consent prompt goes to `platform.broadcast` (the service's default `sendConsent`), which is the
  // right delivery HERE — every attached client is an authenticated operator of this host — where
  // on the desktop it would also reach relay peers. A headless server with nobody attached simply
  // gets no answer, the prompt expires, and the shared value stays unused: fail closed on the
  // grant, fail open on the spawn.
  ptyManager.setProjectSpawnOverrides(
    makeProjectSpawnOverrides({
      readSettings: (projectId) => workspaceStore.readProjectSettings(projectId),
      targetInfo: (projectId) => workspaceStore.projectTargetInfo(projectId),
      trust: projectTrustStore,
      requestTrust: makeProjectTrustRequester(projectSetupService, projectSetupDeps)
    })
  )

  const github = registerGitHubIntegration({
    platform,
    userDataDir: config.dataDir,
    project: (projectId) => workspaceStore.githubProject(projectId),
    detectRepository: (project) => gitService.originUrl(project.cwd ?? ''),
    secret: new ServerGitHubSecretStore(config.dataDir),
    run: runGitHubCliCommand
  })
  registerServerGitHubControl(platform, github.controller)
  // A browser tab's board dispatch reports its queue here, for the `issues` control verb (display only).
  const boardDispatchReports = registerBoardDispatchReportIpc(platform)

  // Board-log: same CorePlatform registrar as desktop, but the Server Edition has no SSH projects
  // (terminals are local), so the router only ever resolves a local folder cwd or unsupported —
  // an SSH-ref project answers `{ entries: [], unsupported: true }` (v1: no remote board log here).
  const boardLog = registerBoardLogHandlers(platform, {
    route: (projectId: string): BoardLogRoute => {
      const cwd = workspaceStore.localCwdForProject(projectId)
      return cwd ? { kind: 'local', cwd } : { kind: 'unsupported' }
    }
  })

  // Debug log ring (issue #78) — same core registrar as desktop. Headless is where a swallowed
  // console hurts most; the browser-side panel reads this process's ring over the bridge.
  const logBuffer = new LogBuffer()
  installLogSink(logBuffer)
  registerLogHandlers(platform, logBuffer, () => settingsStore.get().debugLogPanel)

  // Agent status pipeline — mirrors the desktop boot order in src/main/index.ts:
  // mirror-init → wire the hook-server listeners onto the platform → install the managed hook
  // scripts → start the loopback hook server. The hook server binds its own port independent of
  // the main HTTP server below.
  initAgentStatusMirror()

  // Keep every agent node's session name fresh in the mirror — including nodes no canvas has
  // mounted (the phone lists them all; see core/session-name-sweep.ts).
  startSessionNameSweep({
    entries: sessionNameSweepEntries,
    node: (nodeId) => {
      const n = workspaceStore.getNode(nodeId)
      return n ? { accountId: n.accountId, titleAuto: n.titleAuto } : undefined
    },
    // The per-agent router (core/agent-session-name.ts), same as the desktop's sweep and its
    // ptyReadSessionName handler: a grok node's name is in its session metadata, and resolving it
    // through claude's reader would scan ~/.claude/projects once a minute for a guaranteed miss.
    // Gemini's leg needs the transcript path its context tail tracks; that tail is created by
    // `wireAgentStatus` below, so it is dereferenced lazily — the sweep's first pass is 5s after
    // boot, long after wiring.
    resolve: (sessionId, accountId, agentId) =>
      readAgentSessionName(sessionId, accountId, agentId, {
        geminiPathFor: (id) => geminiContextTail.pathFor(id)
      }),
    publish: setNodeSessionName
    // No `supports`: core's `supportsTitleRead` (TITLE_READ_CAPABLE) is the rule, and duplicating
    // it here is how the two shells drift — see the note in core/session-name-sweep.ts.
  })
  // Trigger nodes (issue #493): the whole host-side machine — arm store, scheduler, delivery with
  // its deliver-on-idle queue, and the mirror's idle signal — composed ONCE in core
  // (`startTriggerService`); the reason it lives in core is exactly this shell: a headless Server
  // Edition with no browser tab open must still fire. Identical call in src/main/index.ts. Arming
  // still has no IPC/UI (phase 4), so nothing fires in production yet.
  startTriggerService({
    userDataDir: config.dataDir,
    listCanvases: () => workspaceStore.persistedCanvases(),
    getNode: (nodeId) => workspaceStore.getNode(nodeId),
    sendText: (nodeId, text) => ptyManager.sendText(nodeId, text),
    paneCommand: (nodeId) => ptyManager.paneCommand(nodeId),
    // The shell's own CorePlatform instance (`platform` is this file's ServerPlatform local).
    handle: (channel, handler) => platform.handle(channel, handler)
  })
  // Advertise launch settings to the mobile companion through the mirror (same provider the
  // desktop wires in src/main/index.ts). No SSH push exists server-side, so only the local
  // provider applies. The provider is consulted at every flush (heartbeat ≤60s), so a settings
  // change propagates without extra plumbing. Caps arrive async: re-flush once the memoized
  // probe answers.
  let localClaudeCaps: ClaudeCliCaps | undefined
  void claudeCliCaps()
    .then((c) => {
      localClaudeCaps = c
      void flushAgentStatusMirror()
    })
    .catch(() => {})
  // Same, for codex — its `--ask-for-approval` vocabulary is its own and it changed between
  // releases (see MirrorSettings.codexApprovalValues). Registered in BOTH shells: a probe published
  // on the desktop and missing here would leave a phone paired to a Server Edition host building
  // Codex launch lines from a table instead of from the binary.
  let localCodexCaps: CodexCliCaps | undefined
  void codexCliCaps()
    .then((c) => {
      localCodexCaps = c
      void flushAgentStatusMirror()
    })
    .catch(() => {})
  // Lets the mirror drop an identity-only entry (a session id kept past the 6 h state expiry)
  // once its node is gone from every project. `undefined` = cannot know = keep, TTL-bounded.
  setMirrorLiveNodesProvider(() => workspaceStore.knownNodeIds())
  setMirrorSettingsProvider((): MirrorSettings => {
    const s = settingsStore.get()
    return {
      claudePermissionMode: s.claudePermissionMode,
      autoSupported: localClaudeCaps?.autoPermissionMode === true,
      ...(localCodexCaps?.approvalValues
        ? { codexApprovalValues: localCodexCaps.approvalValues }
        : {}), // unprobed ⇒ absent ⇒ the reader uses the baseline vocabulary
      // Only a SEEN `true`: a phone-launched plain Codex TUI must carry `--no-daemon` too, or it
      // joins the auto-started shared app-server and runs as another node (shared/agents/codex-daemon).
      ...(localCodexCaps?.noDaemon === true ? { codexNoDaemon: true } : {}),
      claudeAccounts: (s.claudeAccounts ?? [])
        .filter((a) => !a.host && !a.pending)
        .map((a) => mirrorClaudeAccount(a, claudeConfigDirFor(a.id))),
      // Derived binary names only — never the launch command/env (see core/mirror-custom-agents.ts).
      customAgents: mirrorCustomAgents(s.customAgents)
    }
  })
  // Advertise this install's version/commit/installedAt to the phone (spec: server-update). The
  // installer writes <dataDir>/install-meta.json after a successful install/update; read it once at
  // boot (the auto-update path restarts this service, so a boot-time read is always current) and
  // expose it as the mirror's `server` block. Desktop never sets this provider. Tolerant — a
  // missing/corrupt file simply yields no block.
  const installMeta = readInstallMeta(config.dataDir)
  setMirrorServerProvider(() => installMeta)
  // Set after the initial workspace load when the opt-in flag is on. The status listener is wired
  // now so the runtime, once present, consumes the exact same normalized stream as the UI/mirror.
  let canvasControl: ServerCanvasControl | null = null
  // Station-failure notices: registered whether or not canvas control comes up, so a browser tab's
  // `list` answers "none" rather than an unknown channel. Only the canvas-control runtime has a
  // creator ledger, so only it has stations to report.
  registerStationNoticeIpc(platform, () => canvasControl?.stationNotices ?? null)
  // Station task outcomes: registered for the same reason — a browser tab's `list` gets "none"
  // rather than an unknown channel when canvas control is off.
  registerStationOutcomeIpc(platform, () => canvasControl?.stationOutcomes ?? null)
  registerStationHandoverIpc(platform, () => canvasControl?.stationHandovers ?? null)
  const { contextTail, geminiContextTail, codexContextTail } = wireAgentStatus(platform, {
    onEvent: (event) => canvasControl?.onAgentEvent(event)
  })
  // The ⌘M chat view + the find-bar's transcript index. Registered HERE rather than with the rest
  // of the handlers because the hook-fed path authority is the tail created just above. No remote
  // leg: the Server Edition runs ON the host whose transcripts it reads, so local resolution is
  // the complete answer (an SSH-project node is a desktop-only concept here).
  registerTranscriptIpc({
    pathFor: (sessionId) => contextTail.pathFor(sessionId),
    // Codex's ⌘M reader takes ITS tail's hook path (claude's `pathFor` must never answer a codex id).
    codexPathFor: (sessionId) => codexContextTail.pathFor(sessionId)
  })
  // The ⌘M composer's `/` catalog. No remote leg, for the reason above: this process runs on the
  // host whose command and skill folders a node's agent reads. An SSH-project node in this store is
  // still someone ELSE's machine: named remote here, it answers built-ins + `partial`, never this
  // server's own ~/.claude.
  registerChatCatalogIpc({ isRemoteNode: (nodeId) => !!workspaceStore.sshProjectIdForNode(nodeId) })
  // "Open recent": the SERVER host's agent histories — the machine the browser's sessions run on.
  registerRecentConversationsIpc()
  // The context meter's mount-time rehydration, registered beside the read channels and for the
  // same reason: the tails it feeds are the ones created just above. Until this landed the Server
  // Edition had NO handler for `context:ensure` at all — the browser cast it and nothing received
  // it, so a browser agent node's meter filled only on its next turn, exactly the desktop bug
  // issue #813 reported for SSH nodes. No remote leg here (see registerTranscriptIpc above): this
  // process runs on the host whose transcripts it reads, so the local locators are complete.
  registerContextEnsureIpc({
    tailFor: (agentId) => {
      switch (agentId) {
        case undefined:
        case 'claude':
          return contextTail
        case 'codex':
          return codexContextTail
        case 'gemini':
          return geminiContextTail
        default:
          return undefined
      }
    }
  })
  // Deterministic hook-reply approvals (docs/hook-reply-approvals.md): the browser canvas answers a
  // held Claude permission hook here. The Server Edition runs ON the host, so a local project's
  // answer file is written right there (under os.homedir(), which the hook uses as $HOME). SSH
  // projects are v1-unsupported server-side (no ControlMaster manager here) → false, a documented
  // three-surfaces degrade. pendingId is validated before it becomes a path.
  platform.handle(IPC.agentAnswerPermission, async (payload: AnswerPermissionPayload) => {
    const { nodeId, pendingId } = payload ?? ({} as AnswerPermissionPayload)
    if (typeof nodeId !== 'string' || !isValidPendingId(pendingId)) return false
    // An SSH-project node has no reachable ControlMaster here (v1): answer only local nodes.
    if (workspaceStore.sshProjectIdForNode(nodeId)) return false
    if (payload.answer === undefined && payload.decision === 'allow-always') {
      return !!workspaceStore.getNode(nodeId) && hookTicketStillOpen(nodeId, pendingId, 'approval') &&
        await answerPendingHookLocal(nodeId, pendingId, { kind: 'allow-always', suggestionIndex: payload.suggestionIndex ?? -1 }, os.homedir()) === 'sent'
    }
    // Same shared body as the desktop (core/agents/permission-decision.ts), local fs only.
    const res = await answerHeldPermission(
      pendingId,
      { decision: payload.decision, answer: payload.answer },
      localHeldPermissionIo(pendingId, os.homedir())
    )
    // Optimistic flip (parity with desktop): emit the synthetic "answered" transition so the
    // browser canvas NEEDS YOU badge clears instantly, ahead of the held hook's second POST (an
    // idempotent duplicate). See docs/hook-reply-approvals.md.
    if (res.ok && res.decision) {
      const ev = syntheticAnsweredEvent(nodeId, pendingId, res.decision)
      if (ev) {
        platform.broadcast(IPC.agentStatus, ev)
        recordAgentEvent(ev)
      }
    }
    return res.ok
  })
  // Read-a-finished-session ack (parity with desktop): the browser canvas's unread-clear funnel
  // calls it when the just-read node's latest state is `done`. The mirror resolves the node's done
  // inbox event(s) + re-sends an 'end' live-update so the paired phone dismisses its lingering DONE
  // Live Activity. Fire-and-forget; no-op with no unresolved done.
  platform.handle(IPC.agentSubagentSnapshot, () => subagentReplay.snapshot())
  platform.handle(IPC.agentAckDone, (nodeId: string) => {
    ackDone(nodeId)
  })
  // Eco hibernation report (parity with desktop's ipcMain.on(IPC.agentHibernated)): the browser
  // renderer owns the flag; the mirror carries it so the phone's SSH browse renders SLEEPING.
  platform.handle(IPC.agentHibernated, (msg: { nodeId?: unknown; on?: unknown }) => {
    if (typeof msg?.nodeId !== 'string' || !msg.nodeId) return
    setNodeHibernated(msg.nodeId, msg.on === true)
  })
  // Identity seed (parity with desktop's ipcMain.on(IPC.agentSeedIdentity)): the browser renderer's
  // persisted agentStatus store fills session ids this server's mirror has none for, so a phone
  // browsing this host finds an idle node's transcript. Add-only and validated in core.
  platform.handle(IPC.agentSeedIdentity, (entries: unknown) => {
    seedNodeIdentities(entries)
  })
  // Phone→host read-acks: the phone drops `~/.nodeterm/acks/<nodeId>.seen` on this host when it READS
  // a finished session. Sweep it (15s cadence, cheap dir-mtime gate) and for each ack: `ackDone`
  // (mirror resolve + phone Live-Activity dismiss) + broadcast `agent:unread-clear` so the browser
  // canvas drops the node's unread flag WITHOUT re-acking. Local fs only — the Server Edition has no
  // SSH projects (v1); a host it hosts writes its own acks here. See core/ack-sweep.ts.
  createAckSweeper({
    handlers: {
      ownsNode: mirrorOwnsNode,
      ackDone,
      onUnreadClear: (nodeId) => platform.broadcast(IPC.agentUnreadClear, nodeId)
    }
  }).start()
  // Sweep stale ~/.nodeterm/pending files on boot + hourly (orphans from killed sessions).
  startPendingSweep(os.homedir())
  // Phone push via SSH-possession GRANTS (spec: nodeterm-server/docs/specs/2026-07-21-push-grants.md).
  // The Server Edition has no standing relay host identity (no host keypair / approved-devices store /
  // host-token mint — those live in src/main/remote/), so it cannot use the desktop's identity-signed
  // fan-out. This contract SUPERSEDES the old "deliberately unwired — no relay identity" decision:
  // a phone that reaches this host over SSH drops a signed, device-scoped grant at
  // `~/.nodeterm/push-grants/<deviceId>.grant`, and we push to that phone under it (Authorization:
  // Bearer <grant>, no host identity). Both senders run in GRANTED mode off one shared accessor (so a
  // 401/403 dead-mark from either is seen by both). All the usual gates still apply
  // (mobilePushEnabled / needsYou / done / mobileLiveActivities + DNT env guards). `isPackaged: true`
  // — the server is a deployment artifact; dev safety comes for free since granted mode is inert until
  // a phone actually drops a grant file. The DESKTOP keeps its relay-identity path and does NOT use
  // grants in v1 (a host that is both paired AND granted would double-push the same phone) — see
  // src/main/index.ts.
  const pushGrants = createGrantsAccessor()
  const grantedPushGates = {
    getHostIdentity: () => null, // no relay identity here — granted mode only
    getGrants: () => pushGrants.get(),
    markGrantDead: (grant: string) => pushGrants.markDead(grant),
    hostLabel: () => os.hostname(),
    isPackaged: () => true,
    // Same host-side display rule as the desktop: the live session name unless hand-renamed.
    getNodeTitle: (nodeId: string) =>
      displayNodeTitle(nodeId, {
        sessionName: nodeSessionName,
        node: (id) => {
          const n = workspaceStore.getNode(id)
          return n ? { title: n.title, titleAuto: n.titleAuto } : undefined
        }
      })
  }
  createPushNotify({
    subscribe: onInboxActionable,
    ...grantedPushGates,
    mobilePushEnabled: () => settingsStore.get().mobilePushEnabled !== false,
    mobilePushNeedsYou: () => settingsStore.get().mobilePushNeedsYou !== false,
    mobilePushDone: () => settingsStore.get().mobilePushDone !== false,
    // Presence-aware deferral (spec: presence-aware-push) is desktop-only: the Server Edition is
    // HEADLESS — nobody is sitting at it — so nothing is ever "present". Every alert sends
    // immediately, unchanged from before this feature. (No subscribePresence/isEventUnresolved
    // needed: with isUserPresent always false, the hold queue is never touched.)
    isUserPresent: () => false
  })
  createLiveUpdatePush({
    subscribeStateChange: onNodeStateChange,
    subscribeNowChange: onNodeNowChange,
    ...grantedPushGates,
    mobilePushEnabled: () => settingsStore.get().mobilePushEnabled !== false,
    mobileLiveActivities: () => settingsStore.get().mobileLiveActivities !== false
  })
  // Agent-integration consent (issue #744) — the same lifecycle the desktop boots: hooks + skills
  // only for the agents the user enabled, a declined one cleaned up, nothing for an undecided one.
  // `installHooks: false` (tests) is a hard veto that outranks every choice: the hook it would write
  // points into `dataDir`, which a test then deletes.
  const integrations = createIntegrationLifecycle({
    settings: () => settingsStore.get(),
    userDataDir: () => config.dataDir,
    shims: () => ({
      canvas: config.canvasControl === true ? serverCanvasShimPath() : undefined,
      context: contextLinkShimPath()
    }),
    veto: config.installHooks === false
  })
  registerIntegrationLifecycle(integrations)
  integrations.reconcile()
  settingsStore.onChange((s) => integrations.onSettingsChanged(s))
  registerIntegrationIpc(integrations)
  const hookStartupWarning = await hookServer.startForApp()
  if (hookStartupWarning) console.error('[nodeterm-server]', hookStartupWarning)
  // Safe default and rollback path. The opt-in runtime replaces this handler only after its
  // workspace-backed services are ready; a failed initialization therefore degrades to the same
  // named permanent refusal rather than a half-wired execution surface.
  hookServer.setControlHandler(serverEditionControlHandler)

  // ---- Node identity (src/core/agents/node-auth-secret.ts) ------------------------------------
  // First time the Server Edition arms node identity. Headless Linux has no OS keychain, so the
  // secret is stored as raw 0600 bytes (node-auth-key.bin); the loader handles the at-rest format.
  // FAIL OPEN and LOUD: if the secret can't be created/read, identity stays unavailable (legacy
  // mode) and the hook server keeps serving — a throw here must never block boot or the hooks.
  // Same escape hatch as the desktop, wired OUTSIDE the try for the same reason: it is not part of
  // arming the secret, and a headless host in legacy mode is where it is most likely to be needed.
  hookServer.setIdentityStrictOverride(() => settingsStore.get().hookIdentityStrict)
  try {
    // The whole node-identity arming (node secret + the S6 Codex record secret + node tokens) lives
    // in one REAL production function so the boot test can drive the shipped path rather than a
    // re-implementation of it (constraint 8). It arms `setCodexThreadIdentityAuthSecret` with the
    // same secret so a MANAGED Codex account on a headless host signs/verifies its ownership records
    // instead of throwing "identity authentication is unavailable" (Decision 1, both-shells).
    await armServerNodeIdentity(hookServer, () => workspaceStore.persistedCanvases())
  } catch (error) {
    console.warn('[node-identity] no secret — hook identity unavailable, running legacy', error)
    // Issue #1088: a verified-only refusal must be able to say the cause is this instance.
    hookServer.setNodeIdentityUnavailable(error)
  }

  // The Server Edition has the same local app-server, signed node tokens, and persistent canvas
  // store as Electron. Wire the shared-thread spine after those secrets exist, so its Codex panes
  // get the same daemon-reset supervisor instead of bypassing it through bare `codex`.
  void wireServerCodexSharedIdentity(
    hookServer,
    workspaceStore,
    (channel, event) => platform.broadcast(channel, event)
  ).catch((error) => console.warn('[codex-identity] shared identity unavailable:', error))

  // Context Link: core owns the whole feature (read handler, shim, skill, instruction blocks) and
  // writes everything under `dataDir`; what it needs from a shell is the link map. The desktop's
  // renderer pushes it from the live canvas — headless there may be no browser attached at all, so
  // we derive the same map from the persisted `bridges[]` of every canvas instead. See
  // src/server/context-link.ts.
  const contextLink = initServerContextLink({
    ptyManager,
    canvases: () => workspaceStore.persistedCanvases()
  })
  // A governed project's outside edit goes to the canvas authority, which publishes the difference
  // as canvas ops and then the persisted project on `workspace:server-change` (its non-content
  // fields); every other project keeps the whole-project `workspace:external-change`.
  const workspaceWatcher = createServerWorkspaceWatcher(workspaceStore, {
    publish: outsideEditPublisher(
      () => canvasAuthority,
      (project) => platform.broadcast(IPC.workspaceExternalChange, project),
      (project) => platform.broadcast(IPC.workspaceServerChange, project)
    )
  })
  // Live links (src/core/watch-link/service.ts). Assigned after the hosted-team block below; declared
  // here because the onPersist closure runs at the boot load just below (a later `const` would be a
  // TDZ throw inside that load, which it would then report as a failed load).
  let watchLinks: WatchLinkService | null = null
  // Every load()/save() is a canvas change as far as links are concerned: a browser drawing a
  // bridge edge reaches us as the workspace save it triggers. It also refreshes the local-ref
  // watcher set, so projects added or removed while the server runs get the same hand-edit path.
  workspaceStore.onPersist = () => {
    workspaceWatcher.sync()
    contextLink.refresh()
    refreshNodeTokens()
    watchLinks?.onWorkspaceChanged()
  }
  // Nothing has read the workspace index yet — the desktop gets its first load from the renderer,
  // and this shell may never have one. Read it once so links are live before any browser connects.
  // Read-only: boot must not sideline a conflict-marked project.json (that stays a renderer/probe
  // decision). The onPersist above turns this load into the initial refresh.
  await workspaceStore.load({ sideline: false }).catch((e) => {
    console.warn('[nodeterm-server] context-link initial workspace load failed', e)
  })

  if (config.canvasControl === true) {
    try {
      canvasControl = await initServerCanvasControl({
        workspaceStore,
        ptyManager,
        settings: () => settingsStore.get(),
        boardLog,
        // `open-agent --issue #N` means the repository this project's board syncs with — the same
        // answer the issue lane gets from the GitHub host controller.
        issueRepository: (projectId) =>
          github.controller.status(projectId).then((view) => view.project?.repository ?? null),
        // `issues` / `prs`: the board's GitHub lane from the service's cache (no GitHub request).
        githubRead: {
          snapshot: (projectId) => github.service.controlSnapshot(projectId),
          dispatch: (projectId) => boardDispatchReports.forProject(projectId)
        },
        // The durable orchestration facts follow hook-endpoint ownership, like the request ledger.
        ownsDurableState: hookStartupWarning === null
      })
      hookServer.setControlHandler(canvasControl.handler)
    } catch (error) {
      console.warn(
        '[nodeterm-server] Server Edition canvas control failed to initialize; keeping it disabled',
        error
      )
    }
    if (canvasControl) {
      // Loud on purpose, and in the same register as the proxy-trust line above: this is the
      // operator's one chance to notice that a flag reading as "canvas control" also hands agent
      // sessions the ability to run commands as this user. An operator who took "opt-in canvas
      // control" and "creator ownership" at face value could reasonably size the blast radius as
      // the canvas; it is the host. Printed only when the runtime actually came up, so a failed
      // init never announces a capability that is in fact disabled.
      console.log(
        `⚠️  Server canvas control ENABLED: agent sessions with verified node identity can run ` +
          `arbitrary commands on this host as ${serverUserLabel()} (open-terminal --cmd), with ` +
          `this user's environment, files and credentials. Creator ownership and the per-project ` +
          `capability gates decide which agent may ask, not what may be asked for. Unset ` +
          `NODETERM_SERVER_CANVAS_CONTROL / drop --canvas-control to turn it off.`
      )
    }
  }

  // Session budget (docs/SERVER.md): reap long-idle DETACHED nt- tmux sessions under memory
  // pressure (10%-of-RAM watermark) or past a count cap, on BOTH the local socket and the
  // SSH-remote socket (`nodeterm-rmt`) — a host serving SSH projects accumulates sessions there,
  // and this standing process is the natural owner of reaping them (field report: 95 sessions /
  // 34 GB idle claude). Attached sessions are never touched; a reaped node cold-restores on next
  // open. Kill switch + tuning via NODETERM_SESSION_* env (core/session-budget.ts).
  // `shadowed` subtracts our own control-mode shadows from tmux's attached flag: a shadow is a real
  // tmux client but NOT a watcher, so a shadowed session must stay exactly as cullable as an idle
  // detached one (see PtyManager.shadowedTmuxSessions).
  // `readMem: hostMemReader()` — same platform-aware reader as the memory-pressure monitor below.
  // A Server Edition host is normally Linux, where this IS `readMemInfo`; the darwin branch matters
  // for a Mac serving the browser UI, where available bytes are not the OS's pressure signal (see
  // hostMemReader). Kept identical to the desktop shell so the two cannot drift.
  const sessionReaper = createSessionReaper({
    tmuxBin: () => ptyManager.getTmuxBin(),
    shadowed: (socket) => ptyManager.shadowedTmuxSessions(socket)
  })
  sessionReaper.start()
  // Memory pressure (core/memory-pressure.ts): only the reaper leg on this shell. A CRITICAL
  // reading sweeps NOW instead of waiting out the reaper's 10-minute timer — that is the whole
  // responder chain here. The renderer levers the desktop also runs (hidden WebGL contexts,
  // parked terminals) are deliberately NOT pushed to attached browsers: a tab's own memory is the
  // browser's to manage, and it already discards on its own terms (see the documented no-op in
  // renderer/bridge/stubs.ts). Stopped on close beside the reaper — the timer is unref'd, but a
  // test that starts and closes several servers must not leave sweepers behind.
  const pressure = createMemoryPressureMonitor({
    onPressure: (severity) => {
      if (severity === 'critical') void sessionReaper.sweep()
    }
  })
  pressure.start()
  // Pty-device pressure (core/pty-pressure.ts): the reaper leg ONLY, and deliberately so.
  //
  // A standing host is exactly where the ceiling is reached first — it accumulates the sessions
  // (field report: 95) whose panes and ssh children hold the devices — so the sweep matters more
  // here than on the desktop. What is missing is the OTHER half: the desktop also raises a banner
  // whose one useful affordance is "Fix automatically…", and that button ends in macOS's own
  // admin-password dialog on the HOST's physical display. A browser tab (possibly on another
  // machine, possibly on a Linux host with no such limit at all) cannot answer that prompt, so a
  // banner there would name a problem it gives the reader no way to act on. The channel exists —
  // platform.broadcast reaches attached tabs — this is a choice, not a gap, and the same one
  // already documented for the memory-pressure levers in renderer/bridge/stubs.ts. Server hosts
  // hitting the wall are told by the spawn error (core/pty-devices.ts), which is the surface a
  // headless host actually has. Stopped on close beside the memory monitor.
  //
  // `pressure: 'pty'` for the same reason as the desktop: without an explicit reason the budget's
  // own triggers (memory watermark, detached cap) are both clear on a pty-starved host and the
  // sweep plans nothing. It buys an allowance, not an exemption — see planReap.
  const ptyPressure = createPtyPressureMonitor({
    onLevel: (reading) => {
      if (reading.level === 'critical') void sessionReaper.sweep({ pressure: 'pty' })
    }
  })
  ptyPressure.start()

  // Session memory: the pill's RAM read plus the on-demand per-session breakdown. The Server
  // Edition runs ON the host whose sessions it reports and has no SSH-project manager, so it passes
  // no `run` — an SSH scope is REFUSED (ok:false), never swept locally.
  //
  // It does supply `isRemoteProject`, because knowing which projects are somebody else's machine
  // and being able to READ them are different capabilities: the workspace index answers the first
  // right here (the same source as the SSH check in the agentAnswerPermission handler above).
  // Without it, an SSH query arriving WITHOUT the renderer's `remote` flag would fall through to
  // the local sweep and publish this server's own sessions under the remote host's name — the exact
  // misattribution the refusal exists to prevent. Registered here (not in handlers/index.ts)
  // because this is where `ptyManager` lives — the same call site as the reaper above, mirroring
  // src/main/index.ts.
  //
  // DEPENDENCY, and one that breaks silently: `sshProjectIds()` reads the IN-MEMORY index, which is
  // populated only by the `await workspaceStore.load(...)` above — a line documented there as being
  // for context-link. Drop it, or stop awaiting it before `server.listen()` below, and every SSH
  // project reads as local here: the refusal quietly degrades to renderer-flag-only routing, which
  // is the misattribution bug itself. `test/server/session-memory-e2e.test.ts` exists to fail if
  // that happens.
  //
  // What is NOT load-bearing is this boot's position relative to that load. `isRemoteProject` is a
  // closure evaluated per QUERY, and no query can arrive before `startServer` reaches `listen()`,
  // so reordering the two would change nothing. The requirement is that the load happens and is
  // complete before the server serves — not that it precedes this line.
  startSessionMemoryService({
    tmuxBin: () => ptyManager.getTmuxBin(),
    // Zellij-backed sessions are not in the tmux sweep; the panel says how many it did not measure.
    unmeasuredSessions: () => ptyManager.zellijSessionCount(),
    remote: {
      isRemoteProject: sshScopePredicate({ sshProjectIds: () => workspaceStore.sshProjectIds() })
    }
  })

  // Server Edition has no standing desktop renderer nudge consumer or SSH ControlMaster.
  // Serve local Board writes and host-owned tmux creation through the shared save chain;
  // leave renderer nudges and remote-project actions off.
  const managedPlanner = createManagedTerminalPlanner({ store: workspaceStore,
    userData: platform.userDataDir, settings: () => settingsStore.get(), trust: projectTrustStore,
    executable: findInLoginPath, sessionShell: resolveLocalSessionShell,
    claudeCaps: claudeCliCaps, codexCaps: codexCliCaps, grokCaps: grokCliCaps,
    codexIdentity: codexIdentityCaps })
  const managedTerminals = ptyManager.supportsManagedCreation() ? new ManagedTerminals(
    platform.userDataDir, workspaceStore, {
      supported: () => ptyManager.supportsManagedCreation(), ...managedPlanner,
      create: (options, creationId, current) => ptyManager.createManagedHeadless(options, creationId, current),
      verify: (receipt, current) => ptyManager.verifyManagedPane(receipt, current),
      deliver: (receipt, command, current) => ptyManager.deliverManagedLaunch(receipt, command, current)
    }) : undefined
  const sshActionsService = await startSshActionsService(platform.userDataDir, workspaceStore,
    undefined, false, managedTerminals)

  // Hosted team relay (docs/hosted-team-relay.md): this server as the relay host of a team. OFF
  // unless `team init` created <dataDir>/relay/team.json — with no team, start() answers 'no-team':
  // no relay listener is opened, and no host key, team.json or device id is written. What EVERY boot
  // does create is <dataDir>/relay/ (0700) and the listening admin socket in it, relay/admin.sock
  // (0600, removed again on close), which is how `team init` reaches a server that has no team yet
  // (hosted-boot.test.ts pins exactly that). Booted HERE: after every handler above is registered (a relay
  // peer's requests dispatch through them) and after the workspace index is loaded (the access
  // policy reads it to place a node in a project), and BEFORE the headless return, because a
  // headless host is exactly where a team is hosted.
  //
  // The per-client drops a disconnected client is owed, shared with ws.ts's closed-tab path below so
  // the two lists cannot drift: its pty subscriptions (a leaked one can strand a session it paused)
  // and its GitHub issue subscriptions.
  const dropUiClient = (uiId: number): void => {
    ptyManager.dropClient(uiId)
    github.service.dropClient(uiId)
  }
  // The ONE teardown for a relay peer, in the order ws.ts uses for a browser: leave presence, hand
  // back the per-client state, then detach the sink. Idempotent, like ws.ts's.
  const teardownClient = (uiId: number): void => {
    presenceHub.leave(uiId)
    dropUiClient(uiId)
    platform.detach(uiId)
  }
  // A relay peer whose sink proves dead (consecutive throwing sends) is torn down the same way. In
  // serving mode ws.ts replaces this with its own, equivalent teardown; in headless mode nothing else
  // would ever set it, and a dead peer would stay in presence and keep its pty subscriptions.
  platform.setSinkGoneHandler(teardownClient)
  let hostedDeviceId: string | undefined
  const hosted = createHostedService({
    dataDir: config.dataDir,
    apiBase: API_BASE,
    relayUrl: RELAY_URL,
    // Read on first use (a mint, `team info`), never at boot: getDeviceId CREATES <dataDir>/device-id
    // when absent, and a server with no team must not change on disk.
    get deviceId(): string {
      return (hostedDeviceId ??= getDeviceId())
    },
    hostLabel: os.hostname(),
    attach: {
      attach(sink) {
        const id = platform.attach(sink)
        // Join AFTER registering the sink, so the hub's `presence:sync` lands on a live sink (the
        // order ws.ts uses). A relay peer is a 'desktop' peer, as on the desktop's own relay host.
        presenceHub.join(id, 'desktop')
        return id
      },
      detach: teardownClient,
      dispatch: (id, req) => platform.dispatch(id, req),
      cast: (id, method, args) => platform.cast(id, method, args)
    },
    // Memoized in the store: asked once per access decision for every viewer, and a
    // persistedCanvases() scan re-parses every local project's file (measured 4.5 ms per call at
    // 20 projects x 100 nodes).
    projectsOfNode: (nodeId) => workspaceStore.projectIdsForNode(nodeId),
    // A viewer's terminal frames are judged by the session's node, per frame (`team unshare` must
    // stop a stream the viewer already joined). One map lookup.
    nodeOfSession: (sessionId) => ptyManager.nodeOfSession(sessionId),
    projectCwd: (projectId) => workspaceStore.localCwdForProject(projectId),
    // A share or unshare: the authority adopts what joined and writes + releases what left, then every
    // client hears the new governed set (a client alone on a newly shared canvas must start publishing).
    // RESIDUAL, the share-time window (docs/hosted-team-relay.md): an edit a client made just before
    // the share — not yet published (it was alone) or published but not yet saved — is not in what the
    // authority adopts from disk here, and that client's next save is overlaid with the authority's
    // content, so the edit can be lost from disk (it stays on that client's screen until a reload).
    // The save debounce is 800 ms and `team share` is an admin action; the client-side mount window
    // is closed separately (collab-sync `followGoverned`, Canvas.tsx `governedRef`).
    onSharedChange: () => {
      canvasAuthority?.sharedChanged()
      platform.broadcast(IPC.canvasAuthorityChanged, canvasAuthority?.governedIds() ?? [])
    },
    // TEST ONLY seams (see ServerConfig): never set by resolveConfig, so production dials the relay
    // and mints against API_BASE with the global fetch.
    ...(config.relayTestTransport ? { transport: config.relayTestTransport } : {}),
    ...(config.relayTestFetch ? { fetch: config.relayTestFetch } : {})
  })
  // The local admin channel for the `team` CLI, opened BEFORE hosting starts: it is also how this
  // server learns that another one already runs on this data dir (someone answers on its socket).
  // Two servers hosting one team would register relay listeners for the same host key and both write
  // team.json, so a busy socket skips hosting here. Otherwise never fatal: a data dir too long for a
  // unix socket, or Windows, disables administration — it must not take the rest of the Server
  // Edition down with it.
  let otherServerHere = false
  // One set for the whole process: the nodes a `team resume` is launching right now (runResume).
  const resumesInFlight = new Set<string>()
  const teamAdmin = await startTeamAdmin(config.dataDir, hosted, {
    // `team bootstrap`: adopt the folder into THIS core's workspace (saved before it is shared, so
    // the canvas authority can read it). The server runs as the SSH login user, so its home is the
    // one an SSH project's `~` cwds meant.
    adoptFolder: (cwd) => workspaceStore.adoptFolder(cwd, { home: os.homedir() }),
    // `team resume`: restart a handed-over agent on THIS core (its hook env reports to this core,
    // so every teammate sees its status). Same launch primitive and the same release rule as the
    // desktop's headless start: persistent tmux required, the synthetic client released after.
    resume: (req) =>
      runResume(
        {
          inFlight: resumesInFlight,
          loadProject: async (id) => (await workspaceStore.load({ sideline: false })).projects.find((p) => p.id === id) ?? null,
          sessionVerdict: (nodeId) => ptyManager.sessionVerdict(nodeId),
          command: async (entry, node) => {
            const settings = settingsStore.get()
            const permissionMode =
              entry.permissionMode && entry.agentId === 'claude'
                ? gatePermissionMode(entry.permissionMode, (await claudeCliCaps().catch(() => null))?.autoPermissionMode === true)
                : entry.permissionMode
            const codexCaps = entry.agentId === 'codex' ? await codexCliCaps().catch(() => UNKNOWN_CODEX_CLI_CAPS) : UNKNOWN_CODEX_CLI_CAPS
            const sharedIdentity = entry.agentId === 'codex' ? await codexIdentityCaps().then((c) => c.shared).catch(() => false) : false
            return assembleResumeCommand(
              {
                agentId: entry.agentId as AgentId,
                sessionId: entry.sessionId,
                permissionMode,
                model: node.agentModel,
                launchCmdOverride: settings.agentLaunchCommands?.[entry.agentId as BuiltinAgentId],
                sharedIdentity,
                approvalCaps: { codexApprovalValues: codexCaps.approvalValues, codexNoDaemon: codexCaps.noDaemon ?? null }
              },
              process.env
            ).command
          },
          launch: (project, node, command) =>
            launchHeadless(
              {
                persistentSpawnAvailable: () => ptyManager.persistentSpawnAvailable(),
                createHeadless: (o) => ptyManager.createHeadless(o),
                paneCommand: (k) => ptyManager.paneCommand(k),
                writeHeadless: (k, d) => ptyManager.writeHeadless(k, d),
                onOutput: (k, cb) => ptyManager.onOutput(k, cb),
                releaseHeadless: (k) => ptyManager.releaseHeadless(k)
              },
              { ptyOptions: localNodePtyOptions(project, node, { cols: HEADLESS_COLS, rows: HEADLESS_ROWS }), command, release: true, requirePersistent: true }
            )
        },
        req
      )
  }).catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code === 'E_ADMIN_SOCKET_BUSY') otherServerHere = true
    console.error(`[hosted-team] team admin socket disabled: ${err instanceof Error ? err.message : String(err)}`)
    return { close: async (): Promise<void> => {} }
  })
  if (otherServerHere) {
    console.error(
      'Hosted team relay: NOT started — another nodeterm server is already running on this data ' +
        `directory (${config.dataDir}). Stop it, or give this server its own --data-dir.`
    )
  } else {
    // This process owns the team, so it owns the shared projects' content. Wired BEFORE hosting
    // starts, so no relay peer's op can reach the reflector before the authority listens to it.
    // `sharedProjectIds` is read on every call (the team store is the one source).
    const authority = createCanvasAuthority({
      sharedProjectIds: () => hosted.sharedProjectIds(),
      readContent: (id) => workspaceStore.readProjectContent(id),
      writeContent: (id, content) => workspaceStore.writeProjectContent(id, content),
      // UNTRUSTED: the authority's state holds no launch, so its outside-edit diff must not speak
      // for one. Vouched, an owner tab would read each upsert's missing `pendingLaunch` as "the core
      // cleared it" and a git pull would cancel every queued `--after` it touched.
      publish: (id, m) => {
        publishCanvasMutation(id, m, { trusted: false })
      },
      log: (message) => console.warn(`[canvas-authority] ${message}`)
    })
    canvasAuthority = authority
    workspaceStore.setContentAuthority(authority)
    // Synchronous and in seq order (canvas-sync.ts): the authority's own published diff echoes back
    // through here while it is still publishing.
    setReflectedListener((id, m) => authority.onReflected(id, m))
    const hostedStart = await hosted.start().catch((err: unknown) => {
      console.error('[hosted-team] start failed:', err)
      return null
    })
    if (hostedStart === 'started') console.log('Hosted team relay: ON (see `team status`).')
    else if (hostedStart === 'host-key-unreadable') {
      console.error('Hosted team relay: OFF — the host key could not be read (see above; `team status`).')
    }
    // Adopt every shared project NOW, once: `start()` has loaded the team file (the shared set is not
    // known before it), and the index load above has run. An outside edit adopted lazily would read
    // the edited file as its own baseline and publish no difference at all, so every shared project
    // needs its baseline before the watcher can hand one over.
    authority.sharedChanged()
  }

  // Live links (docs/live-links.md): the SAME core service the desktop registers, over the real seams.
  // This edition has no license layer yet (`initLicense` is desktop-only), so the service is registered
  // UNSUPPORTED with no entitlement (controller ruling R43): create answers `unsupported` — the browser
  // shows "Live links need a Pro license on this server — not available in the Server Edition yet",
  // never an Upgrade button — list answers [], and nothing is loaded, hosted or revoked. A server
  // license layer (a named follow-up) changes `entitlement` and drops `unsupported`, nothing else.
  // Headless, no keychain: the links file is a 0600 file in the data dir (spec D8). The workspace
  // index was read above, so there is no load to wait for.
  const watchRemote = (nodeId: string): WatchRemote => watchRemoteFor(nodeId, watchRemoteRecords(workspaceStore, () => undefined))
  watchLinks = createWatchLinkService({
    api: createWatchLinkApi({ apiBase: API_BASE }),
    relayUrl: RELAY_URL,
    store: new WatchLinkStore({ file: path.join(config.dataDir, 'watch-links.json') }),
    entitlement: () => null,
    relayAllowed: () => true,
    nodeState: (nodeId) => workspaceNodeState(workspaceStore, nodeId),
    clients: {
      attach: (sink) => platform.attach(sink, { quiet: true, selfPaced: true }),
      // The per-client drops a departed client is owed (its pty subscriptions), then the sink.
      detach: (id) => {
        dropUiClient(id)
        platform.detach(id)
      }
    },
    // The desktop's rule (core's `watchRemoteFor`), with no SSH-project manager here (no master): a node
    // in a HOST's tmux — an SSH project's, or a remote-tmux node in a local project — is joinable only
    // while this core holds its session live (join-only never spawns), and never through the local tmux.
    pty: createWatchPty(ptyManager, watchRemote),
    // The same check as the desktop (links stay unsupported here, but the member answers): a node in a
    // host's tmux would run there, never in this core's Zellij.
    controlSupport: (nodeId) => (watchRemote(nodeId).requireRemote ? 'ok' : ptyManager.nodeControlSupport(nodeId)),
    emit: (channel, ...args) => sendToOwners(platform, channel, ...args),
    unsupported: true
  })
  registerWatchLinkIpc(platform, watchLinks)
  // Two servers on one data dir would host (and revoke) each other's links.
  if (otherServerHere) {
    console.error('Live links: NOT started — another nodeterm server owns this data directory.')
  } else void watchLinks.init()

  // Headless notification host: every core service above (incl. the loopback hook server, which
  // is its own listener and MUST run) is booted, but we bind NO public HTTP/WS listener — no
  // renderer serving, no auth surface, no open port. The granted push senders reach the phone over
  // outbound HTTPS, and platform.broadcast is a no-op with zero attached UIs. See docs/SERVER.md.
  if (config.headless) {
    console.log('nodeterm-server headless mode — UI disabled (no HTTP/WS listener bound)')
    return {
      port: 0, // nothing bound
      async close() {
        await sshActionsService?.stop()
        // Kill any in-flight setup/archive run: it is a detached process group, so nothing else in
        // this teardown reaches it. Same call, same reason, in the serving branch's close() below.
        projectSetupService.disposeAll()
        // Stop taking admin commands, then end hosting: every relay peer is torn down (presence,
        // pty subscriptions) while the pty layer is still up. Same two lines in the serving close().
        await teamAdmin.close()
        hosted.stop()
        // Stop the live-link hosts while the pty layer is still up (their viewers leave cleanly),
        // bounded: the links file's last write must not hold the close on a stalled disk.
        await shutdownWithin(watchLinks, WATCH_LINKS_STOP_MS)
        // Detach PTY clients — tmux sessions keep running (Phase 1 contract).
        sessionReaper.stop()
        pressure.stop()
        ptyPressure.stop()
        canvasControl?.stop()
        workspaceWatcher.dispose()
        await contextLink.stop()
        // Every save already queued lands while the authority still governs (see the serving close).
        await workspaceStore.idle()
        // Write what the canvas authority still owes, then detach it from the reflector and the store.
        await canvasAuthority?.stop()
        setReflectedListener(null)
        workspaceStore.setContentAuthority(null)
        await ptyManager.killAll()
        // Same native hazard as the desktop app: a whisper transcribe still running when the
        // node env is torn down aborts the process. See SpeechService.shutdown.
        await speechService.shutdown()
        hookServer.stop()
        // No WS teardown counterpart to the serving branch's below, and none is owed: this branch
        // returns BEFORE `http.createServer`/`attachWsServer`, so there is no listener and no
        // upgraded socket that could hold a close open. `startServer` has two returns and a
        // shutdown step usually belongs in both — this one belongs in exactly one.
      }
    }
  }

  const server = http.createServer(
    createHttpHandler({
      auth,
      rendererDir: config.rendererDir,
      trustProxy: config.trustProxy,
      downloadTickets
    })
  )
  // A closed browser tab is the NORMAL way to leave the Server Edition and sends no `pty:kill`,
  // so the WS close hook is what unsubscribes that client from the sessions it was watching.
  const wsServer = attachWsServer(server, {
    platform,
    auth,
    onClientGone: dropUiClient,
    trustProxy: config.trustProxy
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  }).catch(async (error) => { await sshActionsService?.stop(); throw error })

  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : config.port

  return {
    port,
    async close() {
      await sshActionsService?.stop()
      // Kill any in-flight setup/archive run first: it is a detached process group (setsid), so
      // neither the WS teardown nor ptyManager.killAll() below would ever reach it.
      projectSetupService.disposeAll()
      // Stop taking admin commands, then end hosting while the pty layer is still up (see the
      // headless close() above).
      await teamAdmin.close()
      hosted.stop()
      // Stop the live-link hosts while the pty layer is still up (see the headless close() above).
      await shutdownWithin(watchLinks, WATCH_LINKS_STOP_MS)
      // End the browser WebSockets next, BEFORE the canvas authority stops (N3). Once it has stopped
      // and been detached, a save from a still-attached tab is written un-overlaid, over its final
      // flush. Ending the sockets stops new saves; the `idle()` below lets the ones already queued
      // land while it still governs. (Upgraded WebSockets are not ordinary HTTP connections:
      // server.close() waits for them but does not end them, so this is also what keeps a client
      // close racing shutdown from hanging the Server Edition, or its tests.)
      for (const client of wsServer.clients) client.terminate()
      // Detach PTY clients — tmux sessions keep running (Phase 1 contract; never kill the server).
      sessionReaper.stop()
      pressure.stop()
      ptyPressure.stop()
      canvasControl?.stop()
      workspaceWatcher.dispose()
      await contextLink.stop()
      // Every save already queued lands while the authority still governs, then it writes what it owes.
      await workspaceStore.idle()
      // Write what the canvas authority still owes (see the headless close() above).
      await canvasAuthority?.stop()
      setReflectedListener(null)
      workspaceStore.setContentAuthority(null)
      await ptyManager.killAll()
      // Same native hazard as the desktop app: a whisper transcribe still running when the node
      // env is torn down aborts the process. See SpeechService.shutdown.
      await speechService.shutdown()
      // Close the loopback hook-server listener (it would otherwise die with the process anyway).
      hookServer.stop()
      // The WebSockets were ended at the top; close the WS server itself, then the HTTP server.
      await new Promise<void>((resolve) => wsServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

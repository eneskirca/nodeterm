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
import { registerAgentEnvIpc } from '../core/agent-env-ipc'
import { PtyManager } from '../core/pty-manager'
import { registerCoreHandlers } from './handlers'
import { registerGitHubIntegration } from '../core/github/integration'
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
import { refreshNodeTokens } from '../core/agents/node-token-service'
import { armServerNodeIdentity } from './node-identity-arm'
import {
  writePendingAnswerLocal,
  startPendingSweep,
  isValidPendingId,
  syntheticAnsweredEvent
} from '../core/agents/pending-approvals'
import { installManagedAgentHooks } from '../core/agents/hooks'
import { installHooksIntoLocalAccounts } from '../core/claude-accounts-service'
import {
  initAgentStatusMirror,
  flush as flushAgentStatusMirror,
  recordAgentEvent,
  ackDone,
  setMirrorSettingsProvider,
  setMirrorServerProvider,
  onInboxActionable,
  onNodeStateChange,
  onNodeNowChange,
  type MirrorSettings,
  type MirrorServer,
  setNodeSessionName,
  setNodeHibernated,
  sessionNameSweepEntries,
  nodeSessionName
} from '../core/agent-status-mirror'
import { createPushNotify, createLiveUpdatePush } from '../core/push-notify'
import { createGrantsAccessor } from '../core/push-grants'
import { createAckSweeper } from '../core/ack-sweep'
import { createSessionReaper } from '../core/session-budget'
import { startSessionMemoryService, sshScopePredicate } from '../core/session-memory-service'
import { createMemoryPressureMonitor } from '../core/memory-pressure'
import { createPtyPressureMonitor } from '../core/pty-pressure'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { presenceHub } from '../core/presence/hub'
import { initCanvasSync } from '../core/canvas-sync'
import { wireAgentStatus } from './agent-status'
import { initServerContextLink } from './context-link'
import { registerTranscriptIpc } from '../core/transcript-ipc'
import { IPC } from '@shared/ipc'
import { WhisperModelStore } from '../core/speech/whisper-models'
import { SpeechService } from '../core/speech/speech-service'
import { registerSpeechIpc } from '../core/speech/register-ipc'
import { isPremium, getStoredEntitlement } from '../core/license'

// Same env-override + default as src/core/check.ts / license.ts / src/main/telemetry.ts — each
// shell derives it locally rather than sharing an import (src/server must not import src/main).
const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

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

  // fs + git + commit handlers (shared with desktop core services). The ticket store is shared
  // between the RPC side (which mints) and the HTTP side (which redeems) — one instance, so a
  // ticket minted over the socket is redeemable by the GET that follows it.
  const downloadTickets = new DownloadTickets()
  const { gitService } = registerCoreHandlers(platform, {
    getSettings: () => settingsStore.get(),
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

  // Board-log: same CorePlatform registrar as desktop, but the Server Edition has no SSH projects
  // (terminals are local), so the router only ever resolves a local folder cwd or unsupported —
  // an SSH-ref project answers `{ entries: [], unsupported: true }` (v1: no remote board log here).
  registerBoardLogHandlers(platform, {
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
  // Advertise this install's version/commit/installedAt to the phone (spec: server-update). The
  // installer writes <dataDir>/install-meta.json after a successful install/update; read it once at
  // boot (the auto-update path restarts this service, so a boot-time read is always current) and
  // expose it as the mirror's `server` block. Desktop never sets this provider. Tolerant — a
  // missing/corrupt file simply yields no block.
  const installMeta = readInstallMeta(config.dataDir)
  setMirrorServerProvider(() => installMeta)
  const { contextTail, geminiContextTail } = wireAgentStatus(platform)
  // The ⌘M chat view + the find-bar's transcript index. Registered HERE rather than with the rest
  // of the handlers because the hook-fed path authority is the tail created just above. No remote
  // leg: the Server Edition runs ON the host whose transcripts it reads, so local resolution is
  // the complete answer (an SSH-project node is a desktop-only concept here).
  registerTranscriptIpc({ pathFor: (sessionId) => contextTail.pathFor(sessionId) })
  // Deterministic hook-reply approvals (docs/hook-reply-approvals.md): the browser canvas answers a
  // held Claude permission hook here. The Server Edition runs ON the host, so a local project's
  // answer file is written right there (under os.homedir(), which the hook uses as $HOME). SSH
  // projects are v1-unsupported server-side (no ControlMaster manager here) → false, a documented
  // three-surfaces degrade. pendingId is validated before it becomes a path.
  platform.handle(
    IPC.agentAnswerPermission,
    async (payload: { nodeId: string; pendingId: string; decision: 'allow' | 'deny' }) => {
      const { nodeId, pendingId, decision } = payload ?? ({} as typeof payload)
      if (!isValidPendingId(pendingId)) return false
      if (decision !== 'allow' && decision !== 'deny') return false
      // An SSH-project node has no reachable ControlMaster here (v1): answer only local nodes.
      if (workspaceStore.sshProjectIdForNode(nodeId)) return false
      const ok = await writePendingAnswerLocal(pendingId, decision, os.homedir())
      // Optimistic flip (parity with desktop): emit the synthetic "answered" transition so the
      // browser canvas NEEDS YOU badge clears instantly, ahead of the held hook's second POST (an
      // idempotent duplicate). See docs/hook-reply-approvals.md.
      if (ok) {
        const ev = syntheticAnsweredEvent(nodeId, pendingId, decision)
        if (ev) {
          platform.broadcast(IPC.agentStatus, ev)
          recordAgentEvent(ev)
        }
      }
      return ok
    }
  )
  // Read-a-finished-session ack (parity with desktop): the browser canvas's unread-clear funnel
  // calls it when the just-read node's latest state is `done`. The mirror resolves the node's done
  // inbox event(s) + re-sends an 'end' live-update so the paired phone dismisses its lingering DONE
  // Live Activity. Fire-and-forget; no-op with no unresolved done.
  platform.handle(IPC.agentAckDone, (nodeId: string) => {
    ackDone(nodeId)
  })
  // Eco hibernation report (parity with desktop's ipcMain.on(IPC.agentHibernated)): the browser
  // renderer owns the flag; the mirror carries it so the phone's SSH browse renders SLEEPING.
  platform.handle(IPC.agentHibernated, (msg: { nodeId?: unknown; on?: unknown }) => {
    if (typeof msg?.nodeId !== 'string' || !msg.nodeId) return
    setNodeHibernated(msg.nodeId, msg.on === true)
  })
  // Phone→host read-acks: the phone drops `~/.nodeterm/acks/<nodeId>.seen` on this host when it READS
  // a finished session. Sweep it (15s cadence, cheap dir-mtime gate) and for each ack: `ackDone`
  // (mirror resolve + phone Live-Activity dismiss) + broadcast `agent:unread-clear` so the browser
  // canvas drops the node's unread flag WITHOUT re-acking. Local fs only — the Server Edition has no
  // SSH projects (v1); a host it hosts writes its own acks here. See core/ack-sweep.ts.
  createAckSweeper({
    handlers: {
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
  // `installHooks: false` (tests) skips the merge into the user's real ~/.claude et al —
  // the hook it would write points into `dataDir`, which a test then deletes.
  if (config.installHooks !== false) {
    try {
      // Fail-open: installManagedAgentHooks is itself best-effort, but a throw must never block boot.
      installManagedAgentHooks()
    } catch (e) {
      console.warn('[nodeterm-server] managed hook install failed', e)
    }
    // Managed Claude accounts each carry their OWN settings.json (Claude Code resolves it relative
    // to CLAUDE_CONFIG_DIR), so the hook has to be re-installed there as well or a managed account
    // reports no agent status at all. Same loop the desktop runs, minus the canvas skill: canvas
    // control is not wired on this edition. Per-account fail-open lives inside the helper.
    installHooksIntoLocalAccounts(settingsStore.get().claudeAccounts ?? [])
  }
  await hookServer.start()
  // Canvas control does not exist on this edition, and saying so BY NAME is the whole point: the
  // null handler answered `control unavailable`, which reads to an agent like a transient outage,
  // and an agent retries an outage. See `control-unsupported.ts`.
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
  }

  // Context Link: core owns the whole feature (read handler, shim, skill, instruction blocks) and
  // writes everything under `dataDir`; what it needs from a shell is the link map. The desktop's
  // renderer pushes it from the live canvas — headless there may be no browser attached at all, so
  // we derive the same map from the persisted `bridges[]` of every canvas instead. See
  // src/server/context-link.ts.
  const contextLink = initServerContextLink({
    ptyManager,
    canvases: () => workspaceStore.persistedCanvases(),
    installAgentIntegrations: config.installHooks !== false
  })
  // Every load()/save() is a canvas change as far as links are concerned: a browser drawing a
  // bridge edge reaches us as the workspace save it triggers.
  workspaceStore.onPersist = () => {
    contextLink.refresh()
    refreshNodeTokens()
  }
  // Nothing has read the workspace index yet — the desktop gets its first load from the renderer,
  // and this shell may never have one. Read it once so links are live before any browser connects.
  // Read-only: boot must not sideline a conflict-marked project.json (that stays a renderer/probe
  // decision). The onPersist above turns this load into the initial refresh.
  await workspaceStore.load({ sideline: false }).catch((e) => {
    console.warn('[nodeterm-server] context-link initial workspace load failed', e)
  })

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
    remote: {
      isRemoteProject: sshScopePredicate({ sshProjectIds: () => workspaceStore.sshProjectIds() })
    }
  })

  // Headless notification host: every core service above (incl. the loopback hook server, which
  // is its own listener and MUST run) is booted, but we bind NO public HTTP/WS listener — no
  // renderer serving, no auth surface, no open port. The granted push senders reach the phone over
  // outbound HTTPS, and platform.broadcast is a no-op with zero attached UIs. See docs/SERVER.md.
  if (config.headless) {
    console.log('nodeterm-server headless mode — UI disabled (no HTTP/WS listener bound)')
    return {
      port: 0, // nothing bound
      async close() {
        // Kill any in-flight setup/archive run: it is a detached process group, so nothing else in
        // this teardown reaches it. Same call, same reason, in the serving branch's close() below.
        projectSetupService.disposeAll()
        // Detach PTY clients — tmux sessions keep running (Phase 1 contract).
        sessionReaper.stop()
        pressure.stop()
        ptyPressure.stop()
        await contextLink.stop()
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
    onClientGone: (uiId) => {
      ptyManager.dropClient(uiId)
      github.service.dropClient(uiId)
    },
    trustProxy: config.trustProxy
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : config.port

  return {
    port,
    async close() {
      // Kill any in-flight setup/archive run first: it is a detached process group (setsid), so
      // neither the WS teardown nor ptyManager.killAll() below would ever reach it.
      projectSetupService.disposeAll()
      // Detach PTY clients — tmux sessions keep running (Phase 1 contract; never kill the server).
      sessionReaper.stop()
      pressure.stop()
      ptyPressure.stop()
      await contextLink.stop()
      await ptyManager.killAll()
      // Same native hazard as the desktop app: a whisper transcribe still running when the node
      // env is torn down aborts the process. See SpeechService.shutdown.
      await speechService.shutdown()
      // Close the loopback hook-server listener (it would otherwise die with the process anyway).
      hookServer.stop()
      // Upgraded WebSockets are not ordinary HTTP connections: server.close() waits for them but
      // does not end them. Own the WS lifecycle explicitly so a client close racing shutdown
      // cannot hang the Server Edition (or its tests) forever.
      for (const client of wsServer.clients) client.terminate()
      await new Promise<void>((resolve) => wsServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

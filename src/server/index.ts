import fs from 'fs'
import { readSessionName } from '../core/transcript-reader'
import { startSessionNameSweep, displayNodeTitle } from '../core/session-name-sweep'
import { canRename, type AgentId } from '@shared/agents/config'
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
import { PtyManager } from '../core/pty-manager'
import { registerCoreHandlers } from './handlers'
import { registerGitHubIntegration } from '../core/github/integration'
import { runGitHubCliCommand } from '../core/github/credentials'
import { registerServerGitHubControl, ServerGitHubSecretStore } from './github-control'
import { DownloadTickets } from '../core/download-tickets'
import { registerBoardLogHandlers, type BoardLogRoute } from '../core/board-log-handlers'
import os from 'os'
import { hookServer } from '../core/agents/hook-server'
import {
  writePendingAnswerLocal,
  startPendingSweep,
  isValidPendingId,
  syntheticAnsweredEvent
} from '../core/agents/pending-approvals'
import { installManagedAgentHooks } from '../core/agents/hooks'
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
  sessionNameSweepEntries,
  nodeSessionName
} from '../core/agent-status-mirror'
import { createPushNotify, createLiveUpdatePush } from '../core/push-notify'
import { createGrantsAccessor } from '../core/push-grants'
import { createAckSweeper } from '../core/ack-sweep'
import { createSessionReaper } from '../core/session-budget'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { presenceHub } from '../core/presence/hub'
import { initCanvasSync } from '../core/canvas-sync'
import { wireAgentStatus } from './agent-status'
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
  settingsStore.registerIpc()
  ptyManager.init(() => settingsStore.get())
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
    downloadTickets
  })
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
    resolve: (sessionId, accountId) => readSessionName(sessionId, accountId),
    publish: setNodeSessionName,
    supports: (agentId) => !!agentId && canRename(agentId as AgentId)
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
  const { contextTail } = wireAgentStatus(platform)
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
  }
  await hookServer.start()

  // Session budget (docs/SERVER.md): reap long-idle DETACHED nt- tmux sessions under memory
  // pressure (10%-of-RAM watermark) or past a count cap, on BOTH the local socket and the
  // SSH-remote socket (`nodeterm-rmt`) — a host serving SSH projects accumulates sessions there,
  // and this standing process is the natural owner of reaping them (field report: 95 sessions /
  // 34 GB idle claude). Attached sessions are never touched; a reaped node cold-restores on next
  // open. Kill switch + tuning via NODETERM_SESSION_* env (core/session-budget.ts).
  const sessionReaper = createSessionReaper({ tmuxBin: () => ptyManager.getTmuxBin() })
  sessionReaper.start()

  // Headless notification host: every core service above (incl. the loopback hook server, which
  // is its own listener and MUST run) is booted, but we bind NO public HTTP/WS listener — no
  // renderer serving, no auth surface, no open port. The granted push senders reach the phone over
  // outbound HTTPS, and platform.broadcast is a no-op with zero attached UIs. See docs/SERVER.md.
  if (config.headless) {
    console.log('nodeterm-server headless mode — UI disabled (no HTTP/WS listener bound)')
    return {
      port: 0, // nothing bound
      async close() {
        // Detach PTY clients — tmux sessions keep running (Phase 1 contract).
        sessionReaper.stop()
        await ptyManager.killAll()
        hookServer.stop()
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
  attachWsServer(server, {
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
      // Detach PTY clients — tmux sessions keep running (Phase 1 contract; never kill the server).
      sessionReaper.stop()
      await ptyManager.killAll()
      // Close the loopback hook-server listener (it would otherwise die with the process anyway).
      hookServer.stop()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

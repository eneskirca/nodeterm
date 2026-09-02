// WebSocket bridge that reconstructs `window.nodeTerminal` in the browser (Server Edition).
//
// Under Electron the preload already defines `window.nodeTerminal`; this module only runs when
// it is absent (see main.tsx's bootstrap switch). It opens ONE WebSocket to `/ws`, speaks the
// Task-1 RPC protocol (`parseRpcMessage` / `decodePtyData`), and rebuilds the three real
// namespaces (`pty`, `workspace`, `settings`) over that socket. Every other namespace comes from
// `buildStubApi()` (Task 7) so the renderer boots without a full Electron preload.

import {
  parseRpcMessage,
  encodeArgs,
  decodePtyData,
  E_DISCONNECTED,
  type RpcMessage
} from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import type { GitHubControlApi, GitHubIssuesApi } from '../../shared/github-issues'
import {
  UNKNOWN_CLAUDE_CLI_CAPS,
  type BoardLogApi,
  type LogApi,
  type LogRecord,
  type BoardLogReadResult,
  type ChatTranscriptResult,
  type ClaudeApi,
  type ClaudeCliCaps,
  type CodexApi,
  type CodexIdentityCaps,
  UNKNOWN_CODEX_IDENTITY_CAPS,
  type ContextApi,
  type DownloadTicket,
  type FilesApi,
  type FsApi,
  type GitApi,
  type MemInfo,
  type NodeTerminalApi,
  type PresenceApi,
  type PtyApi,
  type PtyCreateOptions,
  type SettingsApi,
  type ClaudeUsage,
  type ProviderUsage,
  type RemoteAccountUsage,
  type RemoteUsageQuery,
  type SessionMemoryQuery,
  type SessionMemoryReport,
  type Settings,
  type SpeechApi,
  type SpeechModelInfo,
  type TmuxStatus,
  type TranscriptLine,
  type Workspace,
  type WorkspaceApi
} from '../../shared/types'
import type { PeerIdentity } from '../../shared/presence'
import { buildStubApi } from './stubs'
import { mountPickerRoot, openDirectoryPicker } from './dialog-picker'
import { encodePcmForWire } from './speech-encode'
import { type FrameTransport, WebSocketFrameTransport } from './frame-transport'

type Listener = (...args: unknown[]) => void

/**
 * A `FrameTransport`, a pending-request map keyed by an incrementing id, and a channel-listener
 * fan-out map. Exported for the unit tests (`ws-bridge.test.ts` / `frame-transport.test.ts`). Kept
 * free of any DOM/overlay concerns so the tests stay clean — reconnect UI lives in `installWsBridge`.
 *
 * `RpcClient` speaks the rpc.ts protocol but is carrier-agnostic: it depends only on a
 * `FrameTransport` (the WebSocket to the Server Edition server, or the relay tunnel to a remote
 * desktop). For back-compat a plain URL string is accepted and wrapped in a `WebSocketFrameTransport`
 * (so the WebSocket path — and its tests — are byte-identical to before the transport was extracted).
 */
export class RpcClient {
  private transport: FrameTransport
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private channels = new Map<string, Set<Listener>>()
  // Events that arrived before any subscriber existed for their channel. The server can push an
  // event in the same macrotask as `open`, so a subscriber registered one microtask later (via
  // `await ready()`) would otherwise miss it. Buffered here (capped) and flushed on subscribe.
  private early: Array<{ channel: string; args: unknown[] }> = []
  private closeCbs = new Set<() => void>()

  constructor(transport: FrameTransport | string) {
    this.transport =
      typeof transport === 'string' ? new WebSocketFrameTransport(transport) : transport
    this.transport.onMessage((data) => this.onMessage(data))
    this.transport.onClose(() => {
      // Fail the in-flight requests BEFORE the overlay hooks: a response can only arrive over the
      // carrier that carried the request, so once it is gone they are unanswerable.
      this.failPending()
      this.closeCbs.forEach((cb) => cb())
    })
  }

  /**
   * Reject every in-flight request, because the socket that could have answered them is gone.
   *
   * A promise that never settles is the worst of the three outcomes. The caller's cleanup —
   * `setBusy(false)`, a `finally`, an error banner — is all downstream of the `await`, so it simply
   * never runs: a dialog sits on "Creating…" with its own Cancel button disabled by `busy`, showing
   * no error and offering no way out but Escape; a Merge or Remove looks like a silent no-op. Every
   * caller that handles a rejection at all handles this correctly the moment we actually reject, so
   * failing closed here protects features that have not been written yet, not just this one.
   */
  private failPending(): void {
    if (this.pending.size === 0) return
    const waiting = [...this.pending.values()]
    this.pending.clear() // clear first: a reject handler that fires another request must not see stale ids
    const err = Object.assign(new Error('The connection to the server was lost.'), {
      code: E_DISCONNECTED
    })
    for (const p of waiting) p.reject(err)
  }

  /** Resolves once the carrier is open; rejects if it fails to open. */
  ready(): Promise<void> {
    return this.transport.ready()
  }

  /** Register a connection-loss hook (used by the reconnect overlay). */
  onClose(cb: () => void): void {
    this.closeCbs.add(cb)
  }

  private onMessage(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      const m = parseRpcMessage(data)
      if (!m) return
      this.handleJson(m)
      return
    }
    // Binary pty frame. The transport has already normalized the carrier's native binary shape
    // (ArrayBuffer in the browser, Buffer under the `ws` package in tests) to a Uint8Array.
    const decoded = decodePtyData(data)
    if (!decoded) return
    this.fanOut(IPC.ptyData(decoded.sessionId), [decoded.data])
  }

  private handleJson(m: RpcMessage): void {
    if (m.t === 'res') {
      const entry = this.pending.get(m.id)
      if (!entry) return
      this.pending.delete(m.id)
      if (m.ok) entry.resolve(m.result)
      else entry.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
    } else if (m.t === 'ev') {
      this.fanOut(m.channel, m.args)
    }
  }

  private fanOut(channel: string, args: unknown[]): void {
    const set = this.channels.get(channel)
    if (!set || set.size === 0) {
      // No subscriber yet — buffer for replay on the first subscribe (capped, drop oldest).
      this.early.push({ channel, args })
      if (this.early.length > 4096) this.early.shift()
      return
    }
    for (const fn of set) fn(...args)
  }

  /** Send a request and resolve with its result (or reject with the coded error). */
  request(method: string, ...args: unknown[]): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // encodeArgs: an OMITTED optional argument must reach the handler as `undefined` (so its
      // default fires) while a MEANINGFUL `null` (pty.resize park, presence clears) stays `null`.
      this.transport.send(JSON.stringify({ t: 'req', id, method, ...encodeArgs(args) }))
    })
  }

  /** Send a fire-and-forget cast (no response expected). */
  cast(method: string, ...args: unknown[]): void {
    this.transport.send(JSON.stringify({ t: 'cast', method, ...encodeArgs(args) }))
  }

  /** Subscribe to a channel; returns an unsubscribe function. */
  subscribe(channel: string, fn: Listener): () => void {
    let set = this.channels.get(channel)
    if (!set) {
      set = new Set()
      this.channels.set(channel, set)
    }
    set.add(fn)
    // Flush any events that arrived for this channel before it had a subscriber.
    if (this.early.length > 0) {
      const pending = this.early.filter((e) => e.channel === channel)
      if (pending.length > 0) {
        this.early = this.early.filter((e) => e.channel !== channel)
        for (const e of pending) fn(...e.args)
      }
    }
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.channels.delete(channel)
    }
  }
}

const AI_NAMING_UNAVAILABLE = {
  ok: false as const,
  message: 'AI naming is not available in the server edition yet'
}

/** Build the real `pty` / `workspace` / `projectSettings` / `settings` namespaces (plus the
 *  top-level `userDataDir`) over an RpcClient, mirroring the preload's
 *  invoke(→request)/send(→cast) split exactly. */
export function buildRealApi(
  client: RpcClient
): Pick<
  NodeTerminalApi,
  | 'pty'
  | 'workspace'
  | 'projectSettings'
  | 'projectSetup'
  | 'worktree'
  | 'settings'
  | 'agent'
  | 'userDataDir'
> {
  const pty: PtyApi = {
    create: (options: PtyCreateOptions) =>
      client.request(IPC.ptyCreate, options) as ReturnType<PtyApi['create']>,
    write: (sessionId, data) => client.cast(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows, viewerId) =>
      client.cast(IPC.ptyResize, sessionId, cols, rows, viewerId),
    setFlow: (sessionId, resume, viewerId) => client.cast(IPC.ptyFlow, sessionId, resume, viewerId),
    kill: (sessionId, viewerId) => client.cast(IPC.ptyKill, sessionId, viewerId),
    // The trailing flag rides as a plain boolean; the core handler re-checks `=== true`.
    destroy: (persistKey, opts) =>
      client.cast(IPC.ptyDestroy, persistKey, opts?.everySocket === true),
    recycle: (persistKey) => client.cast(IPC.ptyRecycle, persistKey),
    // No server handler — degrade gracefully (never reject the boot path).
    generateName: () => Promise.resolve(AI_NAMING_UNAVAILABLE),
    generateGroupName: () => Promise.resolve(AI_NAMING_UNAVAILABLE),
    capture: (persistKey, full) =>
      client.request(IPC.ptyCapture, persistKey, full).catch(() => '') as Promise<string>,
    readScrollback: (persistKey) =>
      client.request(IPC.ptyReadScrollback, persistKey) as Promise<string>,
    sendText: (persistKey, text, opts) =>
      client.request(IPC.ptySendText, persistKey, text, opts?.enter) as Promise<boolean>,
    // Fail-open: an errored status must not raise the banner in the browser.
    tmuxStatus: () =>
      client
        .request(IPC.ptyTmuxStatus)
        .catch(() => ({ available: true, installCommand: null, installLabel: null, platform: null })) as Promise<TmuxStatus>,
    // Unknown on failure (null), never a rejection: the restart poller reads null as "not a
    // shell yet" and gives up on its own deadline.
    paneCommand: (persistKey) =>
      client.request(IPC.ptyPaneCommand, persistKey).catch(() => null) as Promise<string | null>,
    terminateForeground: (persistKey, expectedAgentId) =>
      client.request(IPC.ptyTerminateForeground, persistKey, expectedAgentId).catch(() => false) as Promise<boolean>,
    // No server handler — the session-name poll degrades to no adopted name. A PRE-EXISTING gap,
    // and not any one agent's: `IPC.ptyReadSessionName` has never been registered server-side, so
    // claude's, grok's and gemini's read legs are equally stubbed here (the write leg works on both
    // surfaces — it goes through pty.sendText). The routing itself is already in core
    // (`core/agent-session-name.ts`) and the server already threads gemini's path association into
    // its session-name SWEEP, which is what keeps the phone's names correct; only this per-node poll
    // is missing. Fixing it means registering the channel from both shells, exactly as
    // `core/transcript-ipc.ts` did for the ⌘M transcript channels.
    readSessionName: () => Promise.resolve(''),
    onData: (sessionId, listener) =>
      client.subscribe(IPC.ptyData(sessionId), listener as Listener),
    onExit: (sessionId, listener) =>
      client.subscribe(IPC.ptyExit(sessionId), listener as Listener),
    // Co-attach channels: ordinary JSON `ev` frames (only pty:data is binary), so the frame
    // decoder is unchanged — they just fan out through the generic channel subscription.
    onSize: (sessionId, listener) => client.subscribe(IPC.ptySize(sessionId), listener as Listener),
    onClosed: (sessionId, listener) =>
      client.subscribe(IPC.ptyClosed(sessionId), listener as Listener),
    onRecycled: (sessionId, listener) =>
      client.subscribe(IPC.ptyRecycled(sessionId), listener as Listener),
    onResync: (sessionId, listener) =>
      client.subscribe(IPC.ptyResync(sessionId), listener as Listener)
  }

  const workspace: WorkspaceApi = {
    load: () => client.request(IPC.workspaceLoad) as Promise<Workspace>,
    save: (ws: Workspace) => client.request(IPC.workspaceSave, ws) as Promise<void>,
    // REAL: WorkspaceStore (core) registers IPC.workspaceProbeFolder, so the server serves it.
    // Stubbing it to `null` meant "Open folder…" on a repo that already carries a committed
    // .nodeterm/project.json concluded there was no project there, created an EMPTY one, and the
    // next writeDisk() overwrote the team's shared canvas. Data loss, not a degrade.
    probeFolder: (folder: string) =>
      client.request(IPC.workspaceProbeFolder, folder) as ReturnType<WorkspaceApi['probeFolder']>,
    // REAL for the same reason: core registers IPC.workspaceProjectFileState, and a stub would
    // have to answer 'unreadable' — which is the side that never recovers a deleted project file.
    projectFileState: (folder: string) =>
      client.request(IPC.workspaceProjectFileState, folder) as ReturnType<
        WorkspaceApi['projectFileState']
      >,
    // REAL: core broadcasts IPC.workspaceMigrated after a v2→v3 migration (workspace-store.ts).
    onMigrated: (cb) => client.subscribe(IPC.workspaceMigrated, cb as Listener),
    // REAL: core broadcasts IPC.workspaceCorruptRecovered from the load path (workspace-store.ts).
    onCorruptRecovered: (cb) => client.subscribe(IPC.workspaceCorruptRecovered, cb as Listener),
    // Deliberate degrade: the external-change WATCHER (core/workspace-watcher.ts) is only started
    // by the desktop shell (src/main/index.ts), so the server never broadcasts
    // IPC.workspaceExternalChange and there is nothing to subscribe to. Effect in the browser:
    // an outside edit (git pull / a teammate's push) is not picked up until reload — no silent
    // data loss (the store's own rev reconciliation still guards writes). Booting the watcher in
    // src/server is the follow-up.
    onExternalChange: () => () => {}
  }

  // REAL: WorkspaceStore (core) registers the project-settings:* channels too — same
  // registerIpc() call as workspace above — so the server serves this on both shells.
  const projectSettings: NodeTerminalApi['projectSettings'] = {
    read: (projectId) =>
      client.request(IPC.projectSettingsRead, projectId) as ReturnType<
        NodeTerminalApi['projectSettings']['read']
      >,
    writeShared: (projectId, doc) =>
      client.request(IPC.projectSettingsWriteShared, projectId, doc) as Promise<boolean>,
    updateLocal: (projectId, local) =>
      client.request(IPC.projectSettingsUpdateLocal, projectId, local) as Promise<boolean>,
    launchInfo: (projectId) =>
      client.request(IPC.projectSettingsLaunchInfo, projectId) as ReturnType<
        NodeTerminalApi['projectSettings']['launchInfo']
      >,
    // REAL: `ProjectSetupService.ensureFamilyTrusted` broadcasts IPC.projectTrustChanged on every
    // approval, for each project id that asked.
    onTrustChanged: (cb) => client.subscribe(IPC.projectTrustChanged, cb as Listener)
  }

  // REAL: registerProjectSetupHandlers (core) is wired on the same construction-order point as
  // src/main/index.ts. Wire carries exactly `(projectId, kind, worktreePath?)` — no rootPath/
  // projectName/ssh; the server derives those itself from its own workspace index, same as main.
  const projectSetup: NodeTerminalApi['projectSetup'] = {
    run: (projectId, kind, worktreePath) =>
      client.request(IPC.projectSetupRun, projectId, kind, worktreePath) as ReturnType<
        NodeTerminalApi['projectSetup']['run']
      >,
    cancel: (runKey) => client.request(IPC.projectSetupCancel, runKey) as Promise<boolean>,
    consent: async (requestId, answer) => {
      client.cast(IPC.projectSetupConsentSubmit, requestId, answer)
    },
    // Fails CLOSED on a rejection rather than throwing at the caller: over the relay this method is
    // host-only, so a guest's call comes back E_FORBIDDEN — and "not trusted" is exactly the right
    // answer for a client that may not raise the host's dialog.
    requestTrust: (projectId, family) =>
      client.request(IPC.projectSetupRequestTrust, projectId, family).then(
        (v) => v === true,
        () => false
      ),
    onConsentRequest: (cb) => client.subscribe(IPC.projectSetupConsentRequest, cb as Listener),
    onConsentDismiss: (cb) => client.subscribe(IPC.projectSetupConsentDismiss, cb as Listener),
    onEvent: (projectId, cb) => {
      const unsub = client.subscribe(IPC.projectSetupEvent(projectId), cb as Listener)
      client.cast(IPC.projectSetupSubscribe, projectId)
      return () => {
        unsub()
        client.cast(IPC.projectSetupUnsubscribe, projectId)
      }
    }
  }

  // REAL: registerWorktreeSharedPathsHandlers (core), same construction point as main/server. Wire
  // carries exactly `(projectId, worktreePath)`; the server reads the sharedPaths list itself.
  const worktree: NodeTerminalApi['worktree'] = {
    materializeShared: (projectId, worktreePath) =>
      client.request(IPC.worktreeMaterializeShared, projectId, worktreePath) as ReturnType<
        NodeTerminalApi['worktree']['materializeShared']
      >
  }

  const settings: SettingsApi = {
    load: () => client.request(IPC.settingsLoad) as Promise<Settings>,
    save: (s: Settings) => client.request(IPC.settingsSave, s) as Promise<void>
  }

  const agent: NodeTerminalApi['agent'] = {
    // Deliberately NOT a request: the server registers no env-snapshot handler (a full host-env
    // dump answerable by any authenticated WS client is the PR #195 leak class at the RPC layer).
    // An empty snapshot makes `${env:VAR}` expansion surface every referenced var as missing, and
    // the launch paths refuse rather than type a mangled line.
    envSnapshot: () => Promise.resolve({}),
    discoverModels: (gateway) =>
      client.request(IPC.agentDiscoverModels, gateway) as ReturnType<
        NodeTerminalApi['agent']['discoverModels']
      >,
    gatewayCredentialStatus: () =>
      client.request(IPC.agentGatewayCredentialStatus) as ReturnType<
        NodeTerminalApi['agent']['gatewayCredentialStatus']
      >,
    saveGatewayCredential: (apiKey) =>
      client.request(IPC.agentGatewayCredentialSave, apiKey) as ReturnType<
        NodeTerminalApi['agent']['saveGatewayCredential']
      >,
    clearGatewayCredential: () =>
      client.request(IPC.agentGatewayCredentialClear) as ReturnType<
        NodeTerminalApi['agent']['clearGatewayCredential']
      >
  }

  // The server's data dir, over the SAME channel the desktop preload uses. It is the writable base
  // the worktree dialog derives its default path from — a stub returning '' would suggest
  // `/worktrees/…` at the filesystem root (the server usually runs as root, and git would create it).
  const userDataDir = (): Promise<string> => client.request(IPC.appUserDataDir) as Promise<string>

  return { pty, workspace, projectSettings, projectSetup, worktree, settings, agent, userDataDir }
}

export function buildGitHubApi(
  client: RpcClient
): Pick<NodeTerminalApi, 'githubIssues' | 'githubControl'> {
  const githubIssues: GitHubIssuesApi = {
    subscribe: (projectId) =>
      client.request(IPC.githubIssuesSubscribe, { projectId }) as ReturnType<
        GitHubIssuesApi['subscribe']
      >,
    unsubscribe: async (projectId) => {
      client.cast(IPC.githubIssuesUnsubscribe, projectId)
    },
    query: (request) =>
      client.request(IPC.githubIssuesQuery, request) as ReturnType<GitHubIssuesApi['query']>,
    lookup: (request) =>
      client.request(IPC.githubIssuesLookup, request) as ReturnType<GitHubIssuesApi['lookup']>,
    search: (request) =>
      client.request(IPC.githubIssuesSearch, request) as ReturnType<GitHubIssuesApi['search']>,
    pullsForBranch: (request) =>
      client.request(IPC.githubIssuesPullsForBranch, request) as ReturnType<
        GitHubIssuesApi['pullsForBranch']
      >,
    refresh: (projectId, full) =>
      client.request(IPC.githubIssuesRefresh, projectId, full) as Promise<void>,
    moveIssue: (request) =>
      client.request(IPC.githubIssuesMove, request) as ReturnType<GitHubIssuesApi['moveIssue']>,
    createMissingLabels: (projectId) =>
      client.request(IPC.githubIssuesCreateLabels, projectId) as ReturnType<
        GitHubIssuesApi['createMissingLabels']
      >,
    clearCache: (projectId) =>
      client.request(IPC.githubIssuesClearCache, projectId) as Promise<void>,
    projectAvatar: (projectId) =>
      client.request(IPC.githubProjectAvatar, projectId) as ReturnType<
        GitHubIssuesApi['projectAvatar']
      >,
    onChanged: (projectId, listener) =>
      client.subscribe(IPC.githubIssuesChanged(projectId), listener as Listener)
  }

  const githubControl: GitHubControlApi = {
    status: (projectId) =>
      client.request(IPC.githubControlStatus, projectId) as ReturnType<GitHubControlApi['status']>,
    approve: (input) =>
      client.request(IPC.githubControlApprove, input) as ReturnType<GitHubControlApi['approve']>,
    revoke: (input) =>
      client.request(IPC.githubControlRevoke, input) as ReturnType<GitHubControlApi['revoke']>,
    selectProvider: (input) =>
      client.request(IPC.githubControlSelectProvider, input) as ReturnType<
        GitHubControlApi['selectProvider']
      >,
    saveToken: (token) =>
      client.request(IPC.githubControlSaveToken, token) as ReturnType<GitHubControlApi['saveToken']>,
    clearToken: () =>
      client.request(IPC.githubControlClearToken) as ReturnType<GitHubControlApi['clearToken']>
  }

  return { githubIssues, githubControl }
}

/**
 * Build the real `fs` / `git` / `files` / `context` namespaces over an RpcClient, mirroring the
 * preload's invoke(→request) / send(→cast) / on*(→subscribe) split member-for-member. Every
 * `fs.*`, `git.*`, `files.quickOpen` and `git.generateMessage` member is an `invoke` in the
 * preload → `client.request`; `context.ensure` is a `send` → `client.cast`; the event-shaped
 * `git.onCloneProgress` / `context.onUpdate` are `.on` → `client.subscribe`. `git.generateMessage`
 * routes over `IPC.commitGenerate` (not a git:* channel) exactly as the preload does. Each namespace
 * is declared against its `NodeTerminalApi` slice so `satisfies` makes the compiler the completeness
 * gate: a missing or misnamed member fails typecheck.
 */
export function buildFilesApi(
  client: RpcClient
): Pick<NodeTerminalApi, 'fs' | 'git' | 'files' | 'context' | 'boardLog' | 'logs'> {
  const fs: FsApi = {
    list: (dirPath) => client.request(IPC.fsList, dirPath) as ReturnType<FsApi['list']>,
    read: (filePath) => client.request(IPC.fsRead, filePath) as Promise<string>,
    readBinary: (filePath) => client.request(IPC.fsReadBinary, filePath) as Promise<string>,
    write: (filePath, content) => client.request(IPC.fsWrite, filePath, content) as Promise<boolean>,
    mkdir: (dirPath) => client.request(IPC.fsMkdir, dirPath) as Promise<boolean>,
    exists: (p) => client.request(IPC.fsExists, p) as Promise<boolean>
  }

  const git: GitApi = {
    status: (cwd) => client.request(IPC.gitStatus, cwd) as ReturnType<GitApi['status']>,
    init: (cwd) => client.request(IPC.gitInit, cwd) as ReturnType<GitApi['init']>,
    clone: (parentDir, url) =>
      client.request(IPC.gitClone, parentDir, url) as ReturnType<GitApi['clone']>,
    cloneAbort: () => client.request(IPC.gitCloneAbort) as Promise<void>,
    cloneDefaultParent: () => client.request(IPC.gitCloneDefaultParent) as Promise<string>,
    onCloneProgress: (listener) => client.subscribe(IPC.gitCloneProgress, listener as Listener),
    commit: (cwd, message) =>
      client.request(IPC.gitCommit, cwd, message) as ReturnType<GitApi['commit']>,
    push: (cwd) => client.request(IPC.gitPush, cwd) as ReturnType<GitApi['push']>,
    pull: (cwd) => client.request(IPC.gitPull, cwd) as ReturnType<GitApi['pull']>,
    sync: (cwd) => client.request(IPC.gitSync, cwd) as ReturnType<GitApi['sync']>,
    publish: (cwd, name, isPrivate) =>
      client.request(IPC.gitPublish, cwd, name, isPrivate) as ReturnType<GitApi['publish']>,
    stage: (cwd, paths) => client.request(IPC.gitStage, cwd, paths) as ReturnType<GitApi['stage']>,
    unstage: (cwd, paths) =>
      client.request(IPC.gitUnstage, cwd, paths) as ReturnType<GitApi['unstage']>,
    stageAll: (cwd) => client.request(IPC.gitStageAll, cwd) as ReturnType<GitApi['stageAll']>,
    unstageAll: (cwd) => client.request(IPC.gitUnstageAll, cwd) as ReturnType<GitApi['unstageAll']>,
    diff: (cwd, path, staged, untracked) =>
      client.request(IPC.gitDiff, cwd, path, staged, untracked) as Promise<string>,
    discard: (cwd, path, untracked) =>
      client.request(IPC.gitDiscard, cwd, path, untracked) as ReturnType<GitApi['discard']>,
    switchBranch: (cwd, name) =>
      client.request(IPC.gitSwitchBranch, cwd, name) as ReturnType<GitApi['switchBranch']>,
    createBranch: (cwd, name) =>
      client.request(IPC.gitCreateBranch, cwd, name) as ReturnType<GitApi['createBranch']>,
    showFile: (cwd, ref, path) =>
      client.request(IPC.gitShowFile, cwd, ref, path) as Promise<string>,
    generateMessage: (cwd) =>
      client.request(IPC.commitGenerate, cwd) as ReturnType<GitApi['generateMessage']>,
    history: (cwd, options) =>
      client.request(IPC.gitHistory, cwd, options) as ReturnType<GitApi['history']>,
    commitFiles: (cwd, oid) =>
      client.request(IPC.gitCommitFiles, cwd, oid) as ReturnType<GitApi['commitFiles']>,
    remoteCommitUrl: (cwd, sha) =>
      client.request(IPC.gitRemoteCommitUrl, cwd, sha) as Promise<string | null>,
    merge: (cwd, ref) => client.request(IPC.gitMerge, cwd, ref) as ReturnType<GitApi['merge']>,
    rebase: (cwd, onto) => client.request(IPC.gitRebase, cwd, onto) as ReturnType<GitApi['rebase']>,
    deleteBranch: (cwd, name, force) =>
      client.request(IPC.gitDeleteBranch, cwd, name, force) as ReturnType<GitApi['deleteBranch']>,
    renameBranch: (cwd, newName) =>
      client.request(IPC.gitRenameBranch, cwd, newName) as ReturnType<GitApi['renameBranch']>,
    fetch: (cwd) => client.request(IPC.gitFetch, cwd) as ReturnType<GitApi['fetch']>,
    forcePush: (cwd) => client.request(IPC.gitForcePush, cwd) as ReturnType<GitApi['forcePush']>,
    stashPush: (cwd) => client.request(IPC.gitStashPush, cwd) as ReturnType<GitApi['stashPush']>,
    stashPop: (cwd) => client.request(IPC.gitStashPop, cwd) as ReturnType<GitApi['stashPop']>,
    revert: (cwd, oid) => client.request(IPC.gitRevert, cwd, oid) as ReturnType<GitApi['revert']>,
    branchAt: (cwd, name, oid) =>
      client.request(IPC.gitBranchAt, cwd, name, oid) as ReturnType<GitApi['branchAt']>,
    checkoutCommit: (cwd, oid) =>
      client.request(IPC.gitCheckoutCommit, cwd, oid) as ReturnType<GitApi['checkoutCommit']>,
    repoRoot: (cwd) => client.request(IPC.gitRepoRoot, cwd) as Promise<string | null>,
    worktreeList: (repoPath) =>
      client.request(IPC.gitWorktreeList, repoPath) as ReturnType<GitApi['worktreeList']>,
    worktreeAdd: (repoPath, wtPath, branch, baseRef, isNew) =>
      client.request(
        IPC.gitWorktreeAdd,
        repoPath,
        wtPath,
        branch,
        baseRef,
        isNew
      ) as ReturnType<GitApi['worktreeAdd']>,
    worktreeMerge: (repoPath, branch, baseRef, push) =>
      client.request(
        IPC.gitWorktreeMerge,
        repoPath,
        branch,
        baseRef,
        push
      ) as ReturnType<GitApi['worktreeMerge']>,
    worktreeRemove: (repoPath, wtPath, deleteBranch, pruneOnly) =>
      client.request(
        IPC.gitWorktreeRemove,
        repoPath,
        wtPath,
        deleteBranch,
        pruneOnly
      ) as ReturnType<GitApi['worktreeRemove']>,
    setActiveRemote: (projectId) =>
      client.request(IPC.gitSetActiveRemote, projectId) as Promise<void>
  }

  const files: FilesApi = {
    quickOpen: (cwd) => client.request(IPC.filesQuickOpen, cwd) as Promise<string[]>,
    // A REAL implementation, not a stub: this is the browser's only way to get a file off the
    // server, and it deliberately does not stream through this socket — it mints a ticket the
    // browser redeems with a plain GET (src/server/download.ts).
    downloadTicket: (p) => client.request(IPC.filesDownloadTicket, p) as Promise<DownloadTicket | null>,
    // Also real, and the direction that matters here: the browser holds the bytes, the terminal
    // runs on the server, so a pasted image only becomes nameable once the server has written it.
    saveUpload: (name, dataBase64) =>
      client.request(IPC.filesSaveUpload, name, dataBase64) as Promise<string | null>,
    // Real too, and for the same reason: the browser holds the bytes and the project folder is on
    // the server, so only the server can put a canvas image where the canvas will find it again.
    saveCanvasImage: (projectId, name, dataBase64) =>
      client.request(IPC.filesSaveCanvasImage, projectId, name, dataBase64) as Promise<
        string | null
      >
  }

  const context: ContextApi = {
    onUpdate: (listener) => client.subscribe(IPC.contextUpdate, listener as Listener),
    ensure: (sessionId, cwd, accountId) =>
      client.cast(IPC.contextEnsure, sessionId, cwd, accountId)
  }

  // Board-log: REAL over the bridge for local projects (the server routes local; SSH projects on the
  // server answer `unsupported`). `onChanged` is `.on` → subscribe, plus the ref-counted cast pair the
  // preload sends so the server starts/stops watching this project's log.
  const boardLog: BoardLogApi = {
    append: (projectId, entry) =>
      client.request(IPC.boardLogAppend, projectId, entry) as Promise<boolean>,
    read: (projectId, opts) =>
      client.request(IPC.boardLogRead, projectId, opts) as Promise<BoardLogReadResult>,
    onChanged: (projectId, cb) => {
      const unsub = client.subscribe(IPC.boardLogChanged(projectId), cb as Listener)
      client.cast(IPC.boardLogSubscribe, projectId)
      return () => {
        unsub()
        client.cast(IPC.boardLogUnsubscribe, projectId)
      }
    }
  }

  // Same core on the server, so the log ring is real over the bridge — the panel debugs the
  // Server Edition process, which is exactly where a packaged-app console is least visible.
  const logs: LogApi = {
    snapshot: () => client.request(IPC.logSnapshot) as Promise<LogRecord[]>,
    clear: () => client.cast(IPC.logClear),
    onBatch: (cb) => {
      const unsub = client.subscribe(IPC.logBatch, cb as Listener)
      client.cast(IPC.logSubscribe)
      return () => {
        unsub()
        client.cast(IPC.logUnsubscribe)
      }
    }
  }

  return { fs, git, files, context, boardLog, logs }
}

/**
 * Build the top-level agent-event subscriptions (`onAgentStatus` / `onSubagentActivity`) over an
 * RpcClient. These mirror the preload's `.on(channel, …)` → `client.subscribe(channel, …)` split:
 * each takes a listener and returns an unsubscribe. Declared against its `NodeTerminalApi` slice so
 * `satisfies` keeps the compiler as the completeness gate.
 */
export function buildAgentApi(
  client: RpcClient
): Pick<
  NodeTerminalApi,
  | 'onAgentStatus'
  | 'onSubagentActivity'
  | 'onUnreadClear'
  | 'answerPermission'
  | 'ackDone'
  | 'reportHibernated'
  | 'onAgentWake'
  | 'onRemoteViewers'
  | 'onAgentRefreshNode'
  | 'onAgentRenameNode'
> {
  return {
    onAgentStatus: (listener) => client.subscribe(IPC.agentStatus, listener as Listener),
    // REAL forward: the Server Edition writes its own agent-status mirror, and the phone reads it
    // over its SSH browse path — a browser canvas hibernating a node must reach that file too.
    reportHibernated: (nodeId, on) => {
      void client.request(IPC.agentHibernated, { nodeId, on }).catch(() => undefined)
    },
    // Deliberate no-op subscriptions, not stubs-by-accident: both signals originate in the phone
    // RELAY host, which lives only in the desktop main process — the Server Edition serves no
    // relay, so there is nothing to subscribe to and nothing silently degrades.
    onAgentWake: () => () => undefined,
    onRemoteViewers: () => () => undefined,
    onAgentRefreshNode: () => () => undefined,
    onAgentRenameNode: () => () => undefined,
    // Host swept a phone read-ack → drop this browser canvas's unread flag (external clear, no re-ack).
    onUnreadClear: (listener) => client.subscribe(IPC.agentUnreadClear, listener as Listener),
    onSubagentActivity: (listener) =>
      client.subscribe(IPC.agentSubagentActivity, listener as Listener),
    // Deterministic hook-reply approvals: a real request over the bridge — the Server Edition runs
    // ON the host, so a local project's answer file is written right there (SSH-from-server is v1
    // unsupported and the handler returns false). See docs/hook-reply-approvals.md.
    answerPermission: (payload) =>
      client.request(IPC.agentAnswerPermission, payload) as Promise<boolean>,
    // Read-a-finished-session ack: a real fire-and-forget request over the bridge — the browser
    // canvas runs ON the host, so the server's mirror acks the done event + re-sends the 'end'
    // live-update to the paired phone, same as desktop. See agent-status-mirror `ackDone`.
    ackDone: (nodeId) => {
      void client.request(IPC.agentAckDone, nodeId)
    }
  }
}

/**
 * Build the `canvas` namespace over an RpcClient: a cast out (`canvas:mut`) and a subscription in on
 * the same channel. The server stamps each mutation with the total order (`seq`) and reflects it to
 * every client, us included — our own frame coming back is the ACK that carries our place in that
 * order (the renderer recognizes it by `src`; see src/shared/canvas-order.ts). This is a REAL
 * implementation, not a stub:
 * the Server Edition (two browsers on one workspace) is the surface that needs canvas sync most.
 */
export function buildCanvasApi(client: RpcClient): Pick<NodeTerminalApi, 'canvas'> {
  return {
    canvas: {
      mutate: (projectId, mutation) => client.cast(IPC.canvasMut, projectId, mutation),
      onMutation: (listener) => client.subscribe(IPC.canvasMut, listener as Listener)
    }
  }
}

/**
 * Build the `presence` namespace over an RpcClient, mirroring the preload's invoke(→request) /
 * send(→cast) / on(→subscribe) split member-for-member: `hello` is the only request (its response
 * is how a client learns its OWN clientId), cursor/focus/chat/project are casts, and the two event
 * channels are subscriptions. Declared against its `NodeTerminalApi` slice so `satisfies` keeps
 * the compiler as the completeness gate.
 */
export function buildPresenceApi(client: RpcClient): Pick<NodeTerminalApi, 'presence'> {
  const presence: PresenceApi = {
    hello: (identity: PeerIdentity) =>
      client.request(IPC.presenceHello, identity) as ReturnType<PresenceApi['hello']>,
    cursor: (cursor) => client.cast(IPC.presenceCursor, cursor),
    focus: (nodeId) => client.cast(IPC.presenceFocus, nodeId),
    chat: (text) => client.cast(IPC.presenceChat, text),
    dino: (payload) => client.cast(IPC.presenceDino, payload),
    project: (projectId) => client.cast(IPC.presenceProject, projectId),
    onSync: (listener) => client.subscribe(IPC.presenceSync, listener as Listener),
    onPeer: (listener) => client.subscribe(IPC.presencePeer, listener as Listener)
  }
  return { presence }
}

/**
 * Build the `speech` namespace over an RpcClient — a REAL implementation (the server registers
 * `registerSpeechIpc` too; see `src/core/speech/register-ipc.ts`), not a stub. The one wire
 * difference from Electron IPC: `decodePcmPayload` (src/core/speech/pcm.ts) accepts EITHER a raw
 * Float32 ArrayBuffer (what the preload sends over structured-clone IPC) OR a base64 string of
 * little-endian Int16 samples (half the bytes over JSON) — this is the string branch, encoded by
 * the pure `encodePcmForWire` helper. `micConsent` resolves `true` locally: the browser's own
 * `getUserMedia` prompt IS the consent gate, so there is nothing for the server to answer (the
 * server-side handler for this channel is stubbed the same way — see src/server/index.ts).
 */
export function buildSpeechApi(client: RpcClient): Pick<NodeTerminalApi, 'speech'> {
  const speech: SpeechApi = {
    transcribe: (pcm, language) =>
      client.request(IPC.speechTranscribe, { pcm: encodePcmForWire(pcm), language }) as Promise<{
        text: string
      }>,
    models: () => client.request(IPC.speechModels) as Promise<SpeechModelInfo[]>,
    downloadModel: (id) => client.request(IPC.speechModelDownload, { id }) as Promise<void>,
    deleteModel: (id) => client.request(IPC.speechModelDelete, { id }) as Promise<void>,
    onProgress: (cb) => client.subscribe(IPC.speechProgress, cb as Listener),
    micConsent: () => Promise.resolve(true)
  }
  return { speech }
}

/**
 * Build the `usage` namespace over an RpcClient. The server shell runs the same core usage
 * service the desktop does, so this is real end to end — including `onUpdate`, which subscribes
 * to the poll's broadcast rather than the stub's no-op.
 *
 * `fetch` deliberately does NOT catch: `UsageApi.fetch` is typed as `Promise<ClaudeUsage>`, so
 * swallowing a transport failure would mean inventing a snapshot. The one consumer
 * (UsageIndicator) leaves `usage` null until a real one arrives and renders nothing meanwhile,
 * which is the correct outcome for "we don't know".
 */
function buildUsageApi(client: RpcClient): Pick<NodeTerminalApi, 'usage'> {
  return {
    usage: {
      fetch: (accountId?: string) =>
        client.request(IPC.usageFetch, accountId) as Promise<ClaudeUsage>,
      refresh: (accountId?: string) =>
        client.request(IPC.usageRefresh, accountId) as Promise<ClaudeUsage>,
      providers: (force?: boolean) =>
        client.request(IPC.usageProviders, force) as Promise<ProviderUsage[]>,
      // Real, but structurally empty on the server: `usage:remote` is registered by the same core
      // service, and the server shell injects no SSH deps (it has no SSH projects), so it answers
      // `[]` rather than rejecting.
      remote: (query?: RemoteUsageQuery) =>
        client.request(IPC.usageRemote, query) as Promise<RemoteAccountUsage[]>,
      setProviderCookie: (provider: string, cookie: string) =>
        client.request(IPC.usageSetProviderCookie, provider, cookie) as Promise<boolean>,
      cookieProviders: () =>
        client.request(IPC.usageCookieProviders) as Promise<Record<string, boolean>>,
      onUpdate: (listener) => client.subscribe(IPC.usageUpdate, listener as Listener)
    }
  }
}

/**
 * Real, not a stub: the same core service (`startSessionMemoryService`) registers these channels in
 * the server shell, so the browser gets a genuine per-session breakdown of the machine it is served
 * from — the one it is actually looking at.
 *
 * The query is forwarded VERBATIM. `remote` is the renderer's own "this scope is an SSH host"
 * claim and is one of TWO independent sources the service ORs to decide which machine answers;
 * `projectId` is the only thing naming that machine. A layer that drops or rewrites either turns a
 * remote query into a local sweep, and this machine's sessions get published under the host's name.
 *
 * Neither member catches: a transport failure must not be laundered into `{ok:false}` / `null`,
 * which are the service's own words for "the sweep could not run" and "RAM unreadable". The panel
 * shows a failed request as a failed request.
 */
/**
 * The `triggers` namespace over an RpcClient — REAL on the Server Edition: the arm store, the
 * scheduler and the delivery all run in the server shell (`startTriggerService` registers these
 * handlers there exactly as desktop main does), so arming a trigger from the browser arms it on
 * the machine that will fire it. The relay deliberately keeps the refusing stub (stubs.ts):
 * another machine's arm store is not the guest's to write.
 */
export function buildTriggersApi(client: RpcClient): Pick<NodeTerminalApi, 'triggers'> {
  return {
    triggers: {
      arm: (projectId, nodeId, spec) =>
        client.request(IPC.triggersArm, { projectId, nodeId, spec }) as Promise<boolean>,
      disarm: (projectId, nodeId) =>
        client.request(IPC.triggersDisarm, { projectId, nodeId }) as Promise<void>,
      status: (projectId, nodeId) =>
        client.request(IPC.triggersStatus, { projectId, nodeId }) as Promise<
          import('@shared/trigger').TriggerNodeStatus
        >,
      runNow: (projectId, nodeId) =>
        client.request(IPC.triggersRunNow, { projectId, nodeId }) as Promise<{
          outcome: 'fired' | 'missed' | 'failed' | 'queued'
          detail?: string
        }>
    }
  }
}

export function buildSessionMemoryApi(client: RpcClient): Pick<NodeTerminalApi, 'sessionMemory'> {
  return {
    sessionMemory: {
      read: (q?: SessionMemoryQuery) =>
        client.request(IPC.sessionMemory, q) as Promise<SessionMemoryReport>,
      host: (q?: SessionMemoryQuery) =>
        client.request(IPC.sessionMemoryHost, q) as Promise<MemInfo | null>
    }
  }
}

/**
 * Build the `claude` namespace over an RpcClient. `cliCaps` is a REAL handler on the server
 * (`registerClaudeCliIpc` runs in the server shell too), so the browser resolves the very same
 * `--permission-mode auto` version gate as desktop instead of silently no-opping into "auto
 * unsupported" — which would strip the flag from every Claude launch in the Server Edition.
 * A failed request degrades to the fail-open caps (bare command), never a rejection: the launch
 * path awaits this.
 *
 * `readTranscript` stays STUBBED here on purpose. This builder is shared with the relay
 * (`relay-api.ts`), where the transcripts that matter live on the HOST while this namespace's
 * only real member is a capability probe — the Server Edition gets the real reader from
 * `buildTranscriptApi` below instead, which the relay does not use.
 */
/**
 * The `codex` namespace over an RpcClient — a REAL implementation, not a stub, because the answer
 * has to come from the machine the pty runs on. Today the Server Edition's handler deliberately
 * answers `{ shared: false }` (see server/handlers/index.ts); wiring that side later needs nothing
 * here. A failed request degrades to the same conservative answer: the launch path reads it.
 */
export function buildCodexApi(client: RpcClient): CodexApi {
  return {
    identityCaps: () =>
      (client.request(IPC.codexIdentityCaps) as Promise<CodexIdentityCaps>).catch(
        () => UNKNOWN_CODEX_IDENTITY_CAPS
      ),
    onIdentity: (listener) => client.subscribe(IPC.codexIdentity, listener as Listener)
  }
}

export function buildClaudeApi(client: RpcClient, stub: ClaudeApi): ClaudeApi {
  return {
    ...stub,
    cliCaps: () =>
      (client.request(IPC.claudeCliCaps) as Promise<ClaudeCliCaps>).catch(
        () => UNKNOWN_CLAUDE_CLI_CAPS
      )
  }
}

/**
 * The two transcript READ channels, now that `registerTranscriptIpc` serves them in the server
 * shell too. Before this the browser had no handler at all: the stub rejected, the ⌘M panel never
 * caught it, and every Server Edition session read as an empty conversation.
 *
 * Server Edition ONLY (see buildClaudeApi's note): the server runs on the machine whose
 * transcripts these are, so no `nodeId` remote leg is needed — the argument still rides along
 * because the channel is shared with desktop.
 */
export function buildTranscriptApi(
  client: RpcClient
): Pick<NodeTerminalApi, 'chat'> & { claudeReadTranscript: ClaudeApi['readTranscript'] } {
  return {
    chat: {
      readTranscript: (sessionId, cwd, accountId, nodeId) =>
        client.request(
          IPC.chatReadTranscript,
          sessionId,
          cwd,
          accountId,
          nodeId
        ) as Promise<ChatTranscriptResult>
    },
    claudeReadTranscript: (sessionId, cwd, accountId, nodeId) =>
      client.request(
        IPC.claudeReadTranscript,
        sessionId,
        cwd,
        accountId,
        nodeId
      ) as Promise<TranscriptLine[]>
  }
}

/**
 * Managed CLAUDE accounts over the WS bridge (issue #313). REAL, not a stub: the lifecycle moved
 * into `src/core/claude-accounts-service.ts`, so the server registers the same four channels the
 * desktop does and the browser can create, log into and remove accounts. Deliberately NOT added to
 * `relay-api.ts` — a relay tab drives someone else's machine, and minting an account there would
 * create it on the HOST while this renderer's settings.json records it as one of its own.
 *
 * `waitLogin` is a straight passthrough of a poll that runs up to 5 minutes. That is safe because
 * RpcClient has no request timeout: a pending request rejects only when the socket drops, which is
 * exactly the outcome the caller wants (the login row stays pending and offers Retry).
 *
 * The `codexAccounts` namespace stays STUBBED (E_UNSUPPORTED). Its switch verbs authorize the
 * owning window by Electron WebContents id, which has no meaning over a WS connection — porting it
 * needs a connection-identity design, not a builder.
 */
export function buildClaudeAccountsApi(client: RpcClient): Pick<NodeTerminalApi, 'claudeAccounts'> {
  return {
    claudeAccounts: {
      add: (ctx) =>
        client.request(IPC.claudeAccountsAdd, ctx) as Promise<{
          id: string
          configDir: string
          versionSupported: boolean
        }>,
      waitLogin: (id, ctx) =>
        client.request(IPC.claudeAccountsWaitLogin, id, ctx) as Promise<{ email: string } | null>,
      cancelWaitLogin: (id) =>
        client.request(IPC.claudeAccountsCancelWait, id) as Promise<void>,
      remove: (id, ctx) => client.request(IPC.claudeAccountsRemove, id, ctx) as Promise<void>
    }
  }
}

/** WS URL for the current page: same host, `/ws`, ws→http / wss→https. */
function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

// ── Reconnect overlay (kept out of RpcClient's unit-tested core) ────────────────────────────
const OVERLAY_ID = 'nt-reconnect-overlay'

/** Is the reconnect overlay currently mounted? Exported for the unit test. */
export function isOverlayMounted(): boolean {
  return typeof document !== 'undefined' && document.getElementById(OVERLAY_ID) !== null
}

/** Mount the full-screen "reconnecting" overlay (idempotent). Exported so both the initial-connect
 *  failure path and the later onClose path — and the unit test — mount the identical UI. */
export function showReconnectOverlay(): void {
  if (typeof document === 'undefined' || document.getElementById(OVERLAY_ID)) return
  const el = document.createElement('div')
  el.id = OVERLAY_ID
  el.setAttribute('data-nt-reconnect', '')
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,0.72);color:#fff;' +
    'font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px'
  el.textContent = 'Connection lost — reconnecting…'
  document.body.appendChild(el)
}

/** Retry the WS with backoff (1s→2s→4s→…→10s cap). On the first successful reopen, reload the
 *  page (the reloaded app re-runs `pty.create` per node with the same persistKey → tmux warm
 *  reattach). After 3 consecutive failed retries, bounce to `/login` (assume auth expired). */
function startReconnect(): void {
  showReconnectOverlay()
  let attempt = 0
  let failures = 0

  const tryOnce = (): void => {
    let probe: WebSocket
    try {
      probe = new WebSocket(wsUrl())
    } catch {
      scheduleRetry()
      return
    }
    probe.binaryType = 'arraybuffer'
    const cleanup = (): void => {
      probe.onopen = null
      probe.onerror = null
      probe.onclose = null
    }
    probe.onopen = () => {
      cleanup()
      try {
        probe.close()
      } catch {
        /* ignore */
      }
      location.reload()
    }
    probe.onerror = () => {
      // Let onclose drive the retry/failure counting (fires after error).
    }
    probe.onclose = () => {
      cleanup()
      failures++
      if (failures >= 3) {
        location.href = '/login'
        return
      }
      scheduleRetry()
    }
  }

  const scheduleRetry = (): void => {
    const delay = Math.min(1000 * 2 ** attempt, 10000)
    attempt++
    setTimeout(tryOnce, delay)
  }

  scheduleRetry()
}

/**
 * Connect the WS bridge and install `window.nodeTerminal`. Awaited by main.tsx's bootstrap
 * before the app boots, so the real namespaces are present on first render. Resolves `true` once
 * the socket is open and `window.nodeTerminal` is assigned; resolves `false` on the initial-connect
 * failure path (overlay shown, reconnect loop running) so bootstrap can skip loading the app.
 */
export async function installWsBridge(): Promise<boolean> {
  const client = new RpcClient(new WebSocketFrameTransport(wsUrl()))
  try {
    await client.ready()
  } catch {
    // First connection failed (server down at page load, or the socket errored before opening).
    // Show the SAME reconnect overlay + backoff loop as a later drop instead of rejecting — a
    // rejection here would bubble out of bootstrap() and leave a blank screen. `startReconnect`
    // reloads the page on the first successful reopen, which re-runs installWsBridge cleanly.
    // Return false so bootstrap skips `import('./boot')` — booting the app with an undefined
    // `window.nodeTerminal` throws under the (opaque) overlay.
    startReconnect()
    return false
  }
  client.onClose(() => startReconnect())
  const stubApi = buildStubApi()
  const api: NodeTerminalApi = {
    ...stubApi,
    ...buildRealApi(client),
    ...buildFilesApi(client),
    ...buildAgentApi(client),
    ...buildCanvasApi(client),
    ...buildPresenceApi(client),
    ...buildSpeechApi(client),
    ...buildUsageApi(client),
    ...buildSessionMemoryApi(client),
    ...buildTriggersApi(client),
    ...buildGitHubApi(client),
    ...buildClaudeAccountsApi(client),
    codex: buildCodexApi(client),
    // `claude` is assembled from two builders: `cliCaps` from the relay-shared one, and the
    // transcript reader from the Server-Edition-only one (which also supplies `chat`).
    ...(() => {
      const t = buildTranscriptApi(client)
      return {
        chat: t.chat,
        claude: { ...buildClaudeApi(client, stubApi.claude), readTranscript: t.claudeReadTranscript }
      }
    })(),
    // Web replacement for the Electron native dialog: an in-app server-directory browser over
    // fs.list (the stub's E_UNSUPPORTED reject is dropped in favor of this real picker).
    dialog: (() => {
      mountPickerRoot()
      const startDir = '/' // navigable up/down from root; the picker remembers nothing across calls in v1
      // `write` is what gives folder mode its "New folder" button — the native dialog has one and
      // the browser has no dialog at all, so without it a server folder had to exist already
      // before it could be opened as a project. Same `fs.mkdir`/`fs.exists` the Explorer writes
      // through, and therefore the same reach as everything else this picker already lists.
      // Lambdas, not `api.fs.mkdir` directly: this IIFE runs while `api` is still being built.
      const write = {
        mkdir: (p: string) => api.fs.mkdir(p),
        exists: (p: string) => api.fs.exists(p)
      }
      return {
        selectFolder: () =>
          openDirectoryPicker({ mode: 'folder', startDir, list: api.fs.list, write }),
        selectFile: () => openDirectoryPicker({ mode: 'file', startDir, list: api.fs.list })
      }
    })()
  }
  ;(window as unknown as { nodeTerminal: NodeTerminalApi }).nodeTerminal = api
  return true
}

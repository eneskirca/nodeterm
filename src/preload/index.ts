import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import { resolveUiScale } from '../shared/ui-scale'
import type {
  CanvasMutation,
  CanvasState,
  NodeTerminalApi,
  Project,
  PtyCreateOptions,
  PtyPressure,
  LogRecord,
  RecycledInfo,
  RelayPeerPending,
  RemoteUsageQuery,
  SessionMemoryQuery,
  UpdateInfo,
  UpdateProgress,
  Workspace,
  WorkspaceMigrationKind
} from '../shared/types'
import type { ClientId, PeerDiff, PeerIdentity, PeerState } from '../shared/presence'
import type { ProjectConsentRequest, ProjectSetupEvent } from '../shared/project-settings'

// Fan a single ipcRenderer listener per channel out to many renderer subscribers. Without
// this, every node that subscribes (e.g. Cmd+M markdown toggle on each terminal/editor) adds
// its own ipcRenderer listener, tripping Node's MaxListeners (>10) warning. Returns unsubscribe.
function subscribe<A extends unknown[] = []>(channel: string) {
  const listeners = new Set<(...args: A) => void>()
  let handler: ((e: unknown, ...args: A) => void) | null = null
  return (listener: (...args: A) => void): (() => void) => {
    if (!handler) {
      handler = (_e, ...args) => listeners.forEach((l) => l(...args))
      ipcRenderer.on(channel, handler)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && handler) {
        ipcRenderer.removeListener(channel, handler)
        handler = null
      }
    }
  }
}

// Fan-out subscriber for the host's inbound apply-mutation events (a single ipcRenderer
// listener shared by all renderer subscribers, like the other event channels).
const subscribeMutation = subscribe<[CanvasMutation]>(IPC.remoteHostApplyMutation)
// Fan-out subscriber for the connection-approval prompt (main → host renderer when a client
// finishes the handshake; carries the SAS to show in the approval dialog).
const subscribePeerPending = subscribe<[{ sas: string | null; id: string; pub?: string | null }]>(
  IPC.remoteHostPeerPending
)
const subscribePeerPendingCleared = subscribe<[{ id: string | null; pub?: string | null }]>(
  IPC.remoteHostPeerPendingCleared
)

// New relay tunnel (Stage 4). Non-per-id host events reuse the fan-out helper; per-connection
// client events (sas/approved/frame/closed) attach directly per connectionId.
const subscribeRelayPeerPending = subscribe<[RelayPeerPending]>(IPC.relayHostPeerPending)
const subscribeRelayHostOpen = subscribe<[{ id: string; email?: string }]>(IPC.relayHostOpen)
const subscribeRelayHostClosed = subscribe<[{ id: string }]>(IPC.relayHostClosed)

// Project setup/archive (SDD: 2026-08-19-project-settings-trust): global (not per-project) main →
// renderer prompts, fanned out the same way as the relay events above.
const subscribeProjectSetupConsentRequest = subscribe<[ProjectConsentRequest]>(
  IPC.projectSetupConsentRequest
)
const subscribeProjectSetupConsentDismiss = subscribe<[{ requestId: string }]>(
  IPC.projectSetupConsentDismiss
)
// Not per-project like githubIssuesChanged: `project-trust:changed` is one global channel whose
// payload carries the projectId, fanned out the same way — nobody broadcasts it yet (Task 2), but
// the renderer cache subscribes ahead of the emitter.
const subscribeProjectTrustChanged = subscribe<[{ projectId: string }]>(IPC.projectTrustChanged)

const api: NodeTerminalApi = {
  pty: {
    create: (options: PtyCreateOptions) => ipcRenderer.invoke(IPC.ptyCreate, options),
    write: (sessionId, data) => ipcRenderer.send(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows, viewerId) =>
      ipcRenderer.send(IPC.ptyResize, sessionId, cols, rows, viewerId),
    setFlow: (sessionId, resume, viewerId) =>
      ipcRenderer.send(IPC.ptyFlow, sessionId, resume, viewerId),
    kill: (sessionId, viewerId) => ipcRenderer.send(IPC.ptyKill, sessionId, viewerId),
    destroy: (persistKey, opts) =>
      ipcRenderer.send(IPC.ptyDestroy, persistKey, opts?.everySocket === true),
    recycle: (persistKey) => ipcRenderer.send(IPC.ptyRecycle, persistKey),
    generateName: (persistKey, cwd) => ipcRenderer.invoke(IPC.ptyGenerateName, persistKey, cwd),
    generateGroupName: (memberKeys, cwd) =>
      ipcRenderer.invoke(IPC.ptyGenerateGroupName, memberKeys, cwd),
    capture: (persistKey, full) => ipcRenderer.invoke(IPC.ptyCapture, persistKey, full),
    readScrollback: (persistKey) => ipcRenderer.invoke(IPC.ptyReadScrollback, persistKey),
    sendText: (persistKey, text, opts) =>
      ipcRenderer.invoke(IPC.ptySendText, persistKey, text, opts?.enter),
    tmuxStatus: () => ipcRenderer.invoke(IPC.ptyTmuxStatus),
    paneCommand: (persistKey) => ipcRenderer.invoke(IPC.ptyPaneCommand, persistKey),
    terminateForeground: (persistKey, expectedAgentId) =>
      ipcRenderer.invoke(IPC.ptyTerminateForeground, persistKey, expectedAgentId),
    readSessionName: (sessionId, accountId, agentId) =>
      ipcRenderer.invoke(IPC.ptyReadSessionName, sessionId, accountId, agentId),
    onData: (sessionId, listener) => {
      const channel = IPC.ptyData(sessionId)
      const handler = (_e: unknown, data: string) => listener(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (sessionId, listener) => {
      const channel = IPC.ptyExit(sessionId)
      const handler = (_e: unknown, code: number) => listener(code)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onSize: (sessionId, listener) => {
      const channel = IPC.ptySize(sessionId)
      const handler = (_e: unknown, size: { cols: number; rows: number }) => listener(size)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onClosed: (sessionId, listener) => {
      const channel = IPC.ptyClosed(sessionId)
      const handler = (_e: unknown, info: { by: ClientId | null }) => listener(info)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onRecycled: (sessionId, listener) => {
      const channel = IPC.ptyRecycled(sessionId)
      const handler = (_e: unknown, info: RecycledInfo): void => listener(info)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onResync: (sessionId, listener) => {
      const channel = IPC.ptyResync(sessionId)
      const handler = (_e: unknown, screen: string) => listener(screen)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  workspace: {
    load: () => ipcRenderer.invoke(IPC.workspaceLoad),
    save: (workspace: Workspace) => ipcRenderer.invoke(IPC.workspaceSave, workspace),
    probeFolder: (folder: string) => ipcRenderer.invoke(IPC.workspaceProbeFolder, folder),
    projectFileState: (folder: string) => ipcRenderer.invoke(IPC.workspaceProjectFileState, folder),
    onMigrated: (cb: (kind: WorkspaceMigrationKind) => void) => {
      // Older mains broadcast no payload; that was the v2→v3 migration.
      const h = (_e: unknown, kind?: WorkspaceMigrationKind) => cb(kind ?? 'v2')
      ipcRenderer.on(IPC.workspaceMigrated, h)
      return () => ipcRenderer.removeListener(IPC.workspaceMigrated, h)
    },
    onCorruptRecovered: (cb: (backupFile: string) => void) => {
      const h = (_e: unknown, backupFile: string) => cb(backupFile)
      ipcRenderer.on(IPC.workspaceCorruptRecovered, h)
      return () => ipcRenderer.removeListener(IPC.workspaceCorruptRecovered, h)
    },
    onExternalChange: (cb: (project: Project) => void) => {
      const h = (_e: unknown, p: Project) => cb(p)
      ipcRenderer.on(IPC.workspaceExternalChange, h)
      return () => ipcRenderer.removeListener(IPC.workspaceExternalChange, h)
    }
  },
  projectSettings: {
    read: (projectId: string) => ipcRenderer.invoke(IPC.projectSettingsRead, projectId),
    writeShared: (projectId: string, doc) =>
      ipcRenderer.invoke(IPC.projectSettingsWriteShared, projectId, doc),
    updateLocal: (projectId: string, local) =>
      ipcRenderer.invoke(IPC.projectSettingsUpdateLocal, projectId, local),
    launchInfo: (projectId: string) => ipcRenderer.invoke(IPC.projectSettingsLaunchInfo, projectId),
    onTrustChanged: subscribeProjectTrustChanged
  },
  projectSetup: {
    // Wire carries exactly `(projectId, kind, worktreePath?)` — no rootPath/projectName/ssh: main
    // derives those itself from its own workspace index by projectId and never trusts what crosses
    // this wire (project-setup-handlers.ts's `registerProjectSetupHandlers`, Task 1 review finding).
    run: (projectId, kind, worktreePath) =>
      ipcRenderer.invoke(IPC.projectSetupRun, projectId, kind, worktreePath),
    cancel: (runKey: string) => ipcRenderer.invoke(IPC.projectSetupCancel, runKey),
    consent: async (requestId, answer) => {
      ipcRenderer.send(IPC.projectSetupConsentSubmit, requestId, answer)
    },
    requestTrust: (projectId, family) =>
      ipcRenderer.invoke(IPC.projectSetupRequestTrust, projectId, family),
    onConsentRequest: subscribeProjectSetupConsentRequest,
    onConsentDismiss: subscribeProjectSetupConsentDismiss,
    onEvent: (projectId, cb) => {
      const ch = IPC.projectSetupEvent(projectId)
      const handler = (_e: unknown, ev: ProjectSetupEvent): void => cb(ev)
      ipcRenderer.on(ch, handler)
      ipcRenderer.send(IPC.projectSetupSubscribe, projectId)
      return () => {
        ipcRenderer.removeListener(ch, handler)
        ipcRenderer.send(IPC.projectSetupUnsubscribe, projectId)
      }
    }
  },
  worktree: {
    // Wire carries exactly `(projectId, worktreePath)` — never the sharedPaths list: main reads it
    // itself by projectId and validates the path against the project's own git worktrees
    // (worktree-shared-paths-handlers.ts).
    materializeShared: (projectId: string, worktreePath: string) =>
      ipcRenderer.invoke(IPC.worktreeMaterializeShared, projectId, worktreePath)
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke(IPC.dialogSelectFolder),
    selectFile: () => ipcRenderer.invoke(IPC.dialogSelectFile)
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC.settingsLoad),
    save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  githubIssues: {
    subscribe: (projectId) => ipcRenderer.invoke(IPC.githubIssuesSubscribe, { projectId }),
    unsubscribe: async (projectId) => {
      ipcRenderer.send(IPC.githubIssuesUnsubscribe, projectId)
    },
    query: (request) => ipcRenderer.invoke(IPC.githubIssuesQuery, request),
    refresh: (projectId, full) => ipcRenderer.invoke(IPC.githubIssuesRefresh, projectId, full),
    moveIssue: (request) => ipcRenderer.invoke(IPC.githubIssuesMove, request),
    createMissingLabels: (projectId) => ipcRenderer.invoke(IPC.githubIssuesCreateLabels, projectId),
    clearCache: (projectId) => ipcRenderer.invoke(IPC.githubIssuesClearCache, projectId),
    projectAvatar: (projectId) => ipcRenderer.invoke(IPC.githubProjectAvatar, projectId),
    onChanged: (projectId, listener) => {
      const channel = IPC.githubIssuesChanged(projectId)
      const handler = (_event: unknown, changed: number[]) => listener(changed)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  githubControl: {
    status: (projectId) => ipcRenderer.invoke(IPC.githubControlStatus, projectId),
    approve: (input) => ipcRenderer.invoke(IPC.githubControlApprove, input),
    revoke: (input) => ipcRenderer.invoke(IPC.githubControlRevoke, input),
    selectProvider: (input) => ipcRenderer.invoke(IPC.githubControlSelectProvider, input),
    saveToken: (token) => ipcRenderer.invoke(IPC.githubControlSaveToken, token),
    clearToken: () => ipcRenderer.invoke(IPC.githubControlClearToken)
  },
  speech: {
    // IPC carries the raw Float32 samples as an ArrayBuffer (structured clone; decodePcmPayload's
    // ArrayBuffer branch reads it directly, no re-encoding). A Float32Array view doesn't always
    // span its whole underlying buffer (e.g. a slice of a pooled/recycled buffer upstream), so a
    // non-spanning view is copied first — sending pcm.buffer as-is would leak neighboring bytes
    // (or the wrong region) into the transcription.
    transcribe: (pcm: Float32Array, language?: string) => {
      const spansBuffer = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
      const buffer = spansBuffer ? pcm.buffer : pcm.slice().buffer
      return ipcRenderer.invoke(IPC.speechTranscribe, { pcm: buffer, language })
    },
    models: () => ipcRenderer.invoke(IPC.speechModels),
    downloadModel: (id: string) => ipcRenderer.invoke(IPC.speechModelDownload, { id }),
    deleteModel: (id: string) => ipcRenderer.invoke(IPC.speechModelDelete, { id }),
    onProgress: (cb) => {
      const handler = (_e: unknown, p: { id: string; pct: number }) => cb(p)
      ipcRenderer.on(IPC.speechProgress, handler)
      return () => ipcRenderer.removeListener(IPC.speechProgress, handler)
    },
    micConsent: () => ipcRenderer.invoke(IPC.speechMicConsent)
  },
  ssh: {
    list: () => ipcRenderer.invoke(IPC.sshList),
    save: (server) => ipcRenderer.invoke(IPC.sshSave, server),
    remove: (id) => ipcRenderer.invoke(IPC.sshDelete, id),
    importCandidates: () => ipcRenderer.invoke(IPC.sshImport)
  },
  sshProject: {
    connect: (projectId, conn, remoteCwd) =>
      ipcRenderer.invoke(IPC.sshConnectProject, projectId, conn, remoteCwd),
    disconnect: (projectId) => ipcRenderer.invoke(IPC.sshDisconnectProject, projectId),
    killSessions: (projectId, nodeIds, opts) =>
      ipcRenderer.invoke(IPC.sshKillSessions, projectId, nodeIds, opts),
    listDir: (projectId, dir) => ipcRenderer.invoke(IPC.sshListDir, projectId, dir),
    mkdir: (projectId, dir) => ipcRenderer.invoke(IPC.sshMkdir, projectId, dir),
    uploadFile: (projectId, localPath, fileName) =>
      ipcRenderer.invoke(IPC.sshUploadFile, projectId, localPath, fileName),
    downloadFile: (projectId, remotePath, destDir) =>
      ipcRenderer.invoke(IPC.sshDownloadFile, projectId, remotePath, destDir),
    onStatus: (cb) => {
      const h = (_e: unknown, e: unknown) => cb(e as never)
      ipcRenderer.on(IPC.sshProjectStatus, h)
      return () => ipcRenderer.removeListener(IPC.sshProjectStatus, h)
    },
    submitPassphrase: (requestId, value) =>
      ipcRenderer.invoke(IPC.sshPassphraseSubmit, requestId, value),
    onPassphraseRequest: (cb) => {
      const h = (_e: unknown, e: unknown) => cb(e as never)
      ipcRenderer.on(IPC.sshPassphraseRequest, h)
      return () => ipcRenderer.removeListener(IPC.sshPassphraseRequest, h)
    },
    onPassphraseDismiss: (cb) => {
      const h = (_e: unknown, e: unknown) => cb(e as never)
      ipcRenderer.on(IPC.sshPassphraseDismiss, h)
      return () => ipcRenderer.removeListener(IPC.sshPassphraseDismiss, h)
    }
  },
  sshFs: {
    list: (projectId: string, path: string) => ipcRenderer.invoke(IPC.sshFsList, projectId, path),
    read: (projectId: string, path: string) => ipcRenderer.invoke(IPC.sshFsRead, projectId, path),
    readBinary: (projectId: string, path: string) =>
      ipcRenderer.invoke(IPC.sshFsReadBinary, projectId, path),
    write: (projectId: string, path: string, content: string) =>
      ipcRenderer.invoke(IPC.sshFsWrite, projectId, path, content),
    mkdir: (projectId: string, p: string) => ipcRenderer.invoke(IPC.sshFsMkdir, projectId, p),
    exists: (projectId: string, p: string) => ipcRenderer.invoke(IPC.sshFsExists, projectId, p),
    quickOpen: (projectId: string, cwd: string) =>
      ipcRenderer.invoke(IPC.sshFsQuickOpen, projectId, cwd)
  },
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd),
    init: (cwd) => ipcRenderer.invoke(IPC.gitInit, cwd),
    clone: (parentDir, url) => ipcRenderer.invoke(IPC.gitClone, parentDir, url),
    cloneAbort: () => ipcRenderer.invoke(IPC.gitCloneAbort),
    cloneDefaultParent: () => ipcRenderer.invoke(IPC.gitCloneDefaultParent),
    onCloneProgress: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.gitCloneProgress, handler)
      return () => ipcRenderer.removeListener(IPC.gitCloneProgress, handler)
    },
    commit: (cwd, message) => ipcRenderer.invoke(IPC.gitCommit, cwd, message),
    push: (cwd) => ipcRenderer.invoke(IPC.gitPush, cwd),
    pull: (cwd) => ipcRenderer.invoke(IPC.gitPull, cwd),
    sync: (cwd) => ipcRenderer.invoke(IPC.gitSync, cwd),
    publish: (cwd, name, isPrivate) => ipcRenderer.invoke(IPC.gitPublish, cwd, name, isPrivate),
    stage: (cwd, paths) => ipcRenderer.invoke(IPC.gitStage, cwd, paths),
    unstage: (cwd, paths) => ipcRenderer.invoke(IPC.gitUnstage, cwd, paths),
    stageAll: (cwd) => ipcRenderer.invoke(IPC.gitStageAll, cwd),
    unstageAll: (cwd) => ipcRenderer.invoke(IPC.gitUnstageAll, cwd),
    diff: (cwd, path, staged, untracked) =>
      ipcRenderer.invoke(IPC.gitDiff, cwd, path, staged, untracked),
    discard: (cwd, path, untracked) => ipcRenderer.invoke(IPC.gitDiscard, cwd, path, untracked),
    switchBranch: (cwd, name) => ipcRenderer.invoke(IPC.gitSwitchBranch, cwd, name),
    createBranch: (cwd, name) => ipcRenderer.invoke(IPC.gitCreateBranch, cwd, name),
    showFile: (cwd, ref, path) => ipcRenderer.invoke(IPC.gitShowFile, cwd, ref, path),
    generateMessage: (cwd) => ipcRenderer.invoke(IPC.commitGenerate, cwd),
    history: (cwd, options) => ipcRenderer.invoke(IPC.gitHistory, cwd, options),
    commitFiles: (cwd, oid) => ipcRenderer.invoke(IPC.gitCommitFiles, cwd, oid),
    remoteCommitUrl: (cwd, sha) => ipcRenderer.invoke(IPC.gitRemoteCommitUrl, cwd, sha),
    merge: (cwd, ref) => ipcRenderer.invoke(IPC.gitMerge, cwd, ref),
    rebase: (cwd, onto) => ipcRenderer.invoke(IPC.gitRebase, cwd, onto),
    deleteBranch: (cwd, name, force) => ipcRenderer.invoke(IPC.gitDeleteBranch, cwd, name, force),
    renameBranch: (cwd, newName) => ipcRenderer.invoke(IPC.gitRenameBranch, cwd, newName),
    fetch: (cwd) => ipcRenderer.invoke(IPC.gitFetch, cwd),
    forcePush: (cwd) => ipcRenderer.invoke(IPC.gitForcePush, cwd),
    stashPush: (cwd) => ipcRenderer.invoke(IPC.gitStashPush, cwd),
    stashPop: (cwd) => ipcRenderer.invoke(IPC.gitStashPop, cwd),
    revert: (cwd, oid) => ipcRenderer.invoke(IPC.gitRevert, cwd, oid),
    branchAt: (cwd, name, oid) => ipcRenderer.invoke(IPC.gitBranchAt, cwd, name, oid),
    checkoutCommit: (cwd, oid) => ipcRenderer.invoke(IPC.gitCheckoutCommit, cwd, oid),
    repoRoot: (cwd) => ipcRenderer.invoke(IPC.gitRepoRoot, cwd),
    worktreeList: (repoPath) => ipcRenderer.invoke(IPC.gitWorktreeList, repoPath),
    worktreeAdd: (repoPath, wtPath, branch, baseRef, isNew) =>
      ipcRenderer.invoke(IPC.gitWorktreeAdd, repoPath, wtPath, branch, baseRef, isNew),
    worktreeMerge: (repoPath, branch, baseRef, push) =>
      ipcRenderer.invoke(IPC.gitWorktreeMerge, repoPath, branch, baseRef, push),
    worktreeRemove: (repoPath, wtPath, deleteBranch, pruneOnly) =>
      ipcRenderer.invoke(IPC.gitWorktreeRemove, repoPath, wtPath, deleteBranch, pruneOnly),
    setActiveRemote: (projectId) => ipcRenderer.invoke(IPC.gitSetActiveRemote, projectId)
  },
  clipboard: {
    // Route to the MAIN process: renderer-side `clipboard` access is deprecated in Electron.
    writeText: (text: string) => ipcRenderer.send(IPC.clipboardWrite, text),
    writeFiles: (paths: string[]) => ipcRenderer.invoke(IPC.clipboardWriteFiles, paths)
  },
  shell: {
    reveal: (path: string) => ipcRenderer.send(IPC.shellReveal, path),
    openPath: (path: string) => ipcRenderer.send(IPC.shellOpenPath, path),
    openExternal: (url: string) => ipcRenderer.send(IPC.shellOpenExternal, url),
    pickProjectIcon: () => ipcRenderer.invoke(IPC.shellPickProjectIcon)
  },
  fs: {
    list: (dirPath: string) => ipcRenderer.invoke(IPC.fsList, dirPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.fsRead, filePath),
    readBinary: (filePath: string) => ipcRenderer.invoke(IPC.fsReadBinary, filePath),
    write: (filePath: string, content: string) => ipcRenderer.invoke(IPC.fsWrite, filePath, content),
    mkdir: (dirPath: string) => ipcRenderer.invoke(IPC.fsMkdir, dirPath),
    exists: (p: string) => ipcRenderer.invoke(IPC.fsExists, p)
  },
  media: {
    allow: (absPath: string) => ipcRenderer.invoke(IPC.mediaAllow, absPath),
    allowSsh: (projectId: string, remotePath: string) =>
      ipcRenderer.invoke(IPC.sshMediaAllow, projectId, remotePath),
    writeHtml: (html: string) => ipcRenderer.invoke(IPC.mediaWriteHtml, html)
  },
  browser: {
    register: (webContentsId: number, nodeId: string) =>
      ipcRenderer.send(IPC.browserRegister, webContentsId, nodeId),
    unregister: (webContentsId: number) => ipcRenderer.send(IPC.browserUnregister, webContentsId),
    onBrowserNewWindow: (listener) => {
      const handler = (_e: unknown, ev: { url: string; sourceNodeId: string }) => listener(ev)
      ipcRenderer.on(IPC.browserNewWindow, handler)
      return () => ipcRenderer.removeListener(IPC.browserNewWindow, handler)
    },
    onLeaseChanged: (listener) => {
      const handler = (_e: unknown, push: Parameters<typeof listener>[0]) => listener(push)
      ipcRenderer.on(IPC.browserLeaseChanged, handler)
      return () => ipcRenderer.removeListener(IPC.browserLeaseChanged, handler)
    },
    stop: (nodeId: string) => ipcRenderer.send(IPC.browserStop, nodeId),
    stopAll: () => ipcRenderer.send(IPC.browserStopAll),
    stopProject: (projectId: string) => ipcRenderer.send(IPC.browserStopProject, projectId)
  },
  files: {
    quickOpen: (cwd: string) => ipcRenderer.invoke(IPC.filesQuickOpen, cwd),
    // Desktop has no HTTP surface to redeem a ticket on — the core handler answers null here, and
    // the Explorer reads that as "this shell downloads over scp instead" (SSH) or "the file is
    // already on this machine" (local project).
    downloadTicket: (p: string) => ipcRenderer.invoke(IPC.filesDownloadTicket, p),
    saveUpload: (name: string, dataBase64: string) =>
      ipcRenderer.invoke(IPC.filesSaveUpload, name, dataBase64),
    saveCanvasImage: (projectId: string, name: string, dataBase64: string) =>
      ipcRenderer.invoke(IPC.filesSaveCanvasImage, projectId, name, dataBase64)
  },
  updates: {
    onAvailable: (listener) => {
      const handler = (_e: unknown, info: UpdateInfo) => listener(info)
      ipcRenderer.on(IPC.appUpdateAvailable, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateAvailable, handler)
    },
    onDownloaded: (listener) => {
      const handler = (_e: unknown, info: UpdateInfo) => listener(info)
      ipcRenderer.on(IPC.appUpdateDownloaded, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateDownloaded, handler)
    },
    onProgress: (listener) => {
      const handler = (_e: unknown, p: UpdateProgress) => listener(p)
      ipcRenderer.on(IPC.appUpdateProgress, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateProgress, handler)
    },
    onError: (listener) => {
      const handler = (_e: unknown, message: string) => listener(message)
      ipcRenderer.on(IPC.appUpdateError, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateError, handler)
    },
    onNotAvailable: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC.appUpdateNotAvailable, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateNotAvailable, handler)
    },
    check: () => ipcRenderer.send(IPC.appCheckForUpdates),
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion),
    getPolicy: () => ipcRenderer.invoke(IPC.appUpdatePolicy),
    restart: () => ipcRenderer.send(IPC.appRestartToUpdate)
  },
  license: {
    upgrade: (target?: 'pro' | 'seats') => ipcRenderer.invoke(IPC.licenseUpgrade, target),
    activate: (key: string) => ipcRenderer.invoke(IPC.licenseActivate, key),
    deactivate: () => ipcRenderer.invoke(IPC.licenseDeactivate),
    getStatus: () => ipcRenderer.invoke(IPC.licenseStatus),
    detail: () => ipcRenderer.invoke(IPC.licenseDetail),
    releaseOthers: () => ipcRenderer.invoke(IPC.licenseRelease),
    onChange: (listener) => {
      const handler = (_e: unknown, s: Parameters<typeof listener>[0]) => listener(s)
      ipcRenderer.on(IPC.licenseChanged, handler)
      return () => ipcRenderer.removeListener(IPC.licenseChanged, handler)
    }
  },
  announcements: {
    fetch: () => ipcRenderer.invoke(IPC.announcementsFetch)
  },
  usage: {
    fetch: (accountId?: string) => ipcRenderer.invoke(IPC.usageFetch, accountId),
    refresh: (accountId?: string) => ipcRenderer.invoke(IPC.usageRefresh, accountId),
    providers: (force?: boolean) => ipcRenderer.invoke(IPC.usageProviders, force),
    remote: (query?: RemoteUsageQuery) => ipcRenderer.invoke(IPC.usageRemote, query),
    setProviderCookie: (provider: string, cookie: string) =>
      ipcRenderer.invoke(IPC.usageSetProviderCookie, provider, cookie),
    cookieProviders: () => ipcRenderer.invoke(IPC.usageCookieProviders),
    onUpdate: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.usageUpdate, handler)
      return () => ipcRenderer.removeListener(IPC.usageUpdate, handler)
    }
  },
  // The query is forwarded VERBATIM: `remote` is the renderer's own "this scope is an SSH host"
  // claim, which the core service ORs with its own `isRemoteProject`. Normalizing it here (say,
  // dropping a `false`, or defaulting the object) would silently re-open the misattribution this
  // surface exists to prevent — one machine's sessions published under another's name.
  sessionMemory: {
    read: (q?: SessionMemoryQuery) => ipcRenderer.invoke(IPC.sessionMemory, q),
    host: (q?: SessionMemoryQuery) => ipcRenderer.invoke(IPC.sessionMemoryHost, q)
  },
  triggers: {
    arm: (projectId, nodeId, spec) => ipcRenderer.invoke(IPC.triggersArm, { projectId, nodeId, spec }),
    disarm: (projectId, nodeId) => ipcRenderer.invoke(IPC.triggersDisarm, { projectId, nodeId }),
    status: (projectId, nodeId) => ipcRenderer.invoke(IPC.triggersStatus, { projectId, nodeId }),
    runNow: (projectId, nodeId) => ipcRenderer.invoke(IPC.triggersRunNow, { projectId, nodeId })
  },
  context: {
    onUpdate: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.contextUpdate, handler)
      return () => ipcRenderer.removeListener(IPC.contextUpdate, handler)
    },
    ensure: (sessionId, cwd, accountId) =>
      ipcRenderer.send(IPC.contextEnsure, sessionId, cwd, accountId)
  },
  // Canvas sync: one channel in both directions. The cast goes to the reflector (src/core/canvas-sync),
  // which stamps it with the total order (`seq`) and fans it to every attached client — INCLUDING us.
  // Our own mutation coming back is the ACK that tells us where it landed in that order; the renderer
  // recognizes it by `src` and does not re-apply it (src/shared/canvas-order.ts).
  canvas: {
    mutate: (projectId, mutation) => ipcRenderer.send(IPC.canvasMut, projectId, mutation),
    onMutation: (listener) => {
      const handler = (
        _e: unknown,
        projectId: string,
        mutation: Parameters<typeof listener>[1]
      ): void => listener(projectId, mutation)
      ipcRenderer.on(IPC.canvasMut, handler)
      return () => ipcRenderer.removeListener(IPC.canvasMut, handler)
    }
  },
  codex: {
    identityCaps: () => ipcRenderer.invoke(IPC.codexIdentityCaps),
    onIdentity: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.codexIdentity, handler)
      return () => ipcRenderer.removeListener(IPC.codexIdentity, handler)
    }
  },
  claude: {
    cliCaps: () => ipcRenderer.invoke(IPC.claudeCliCaps),
    readTranscript: (sessionId, cwd, accountId, nodeId) =>
      ipcRenderer.invoke(IPC.claudeReadTranscript, sessionId, cwd, accountId, nodeId)
  },
  agent: {
    envSnapshot: () => ipcRenderer.invoke(IPC.envSnapshot),
    discoverModels: (settings) => ipcRenderer.invoke(IPC.agentDiscoverModels, settings),
    gatewayCredentialStatus: () => ipcRenderer.invoke(IPC.agentGatewayCredentialStatus),
    saveGatewayCredential: (apiKey) =>
      ipcRenderer.invoke(IPC.agentGatewayCredentialSave, apiKey),
    clearGatewayCredential: () => ipcRenderer.invoke(IPC.agentGatewayCredentialClear)
  },
  chat: {
    readTranscript: (sessionId, cwd, accountId, nodeId) =>
      ipcRenderer.invoke(IPC.chatReadTranscript, sessionId, cwd, accountId, nodeId)
  },
  claudeAccounts: {
    add: (ctx) => ipcRenderer.invoke(IPC.claudeAccountsAdd, ctx),
    waitLogin: (id, ctx) => ipcRenderer.invoke(IPC.claudeAccountsWaitLogin, id, ctx),
    cancelWaitLogin: (id) => ipcRenderer.invoke(IPC.claudeAccountsCancelWait, id),
    remove: (id, ctx) => ipcRenderer.invoke(IPC.claudeAccountsRemove, id, ctx)
  },
  codexAccounts: {
    add: () => ipcRenderer.invoke(IPC.codexAccountsAdd),
    waitLogin: (id) => ipcRenderer.invoke(IPC.codexAccountsWaitLogin, id),
    cancelWaitLogin: (id) => ipcRenderer.invoke(IPC.codexAccountsCancelWait, id),
    identity: (id) => ipcRenderer.invoke(IPC.codexAccountsIdentity, id),
    systemIdentity: (ctx) => ipcRenderer.invoke(IPC.codexAccountsSystemIdentity, ctx),
    remove: (id) => ipcRenderer.invoke(IPC.codexAccountsRemove, id),
    switchThread: (threadId, cwd, sourceAccountId, targetAccountId) =>
      ipcRenderer.invoke(
        IPC.codexAccountsSwitchThread,
        threadId,
        cwd,
        sourceAccountId,
        targetAccountId
      ),
    commitSwitch: (token) => ipcRenderer.invoke(IPC.codexAccountsCommitSwitch, token),
    finishSwitch: (token) => ipcRenderer.invoke(IPC.codexAccountsFinishSwitch, token),
    rollbackSwitch: (token) => ipcRenderer.invoke(IPC.codexAccountsRollbackSwitch, token),
    transferThreadToSsh: (threadId, cwd, projectId, targetAccountId, sourceAccountId) =>
      ipcRenderer.invoke(
        IPC.codexAccountsTransferThreadToSsh,
        threadId,
        cwd,
        projectId,
        targetAccountId,
        sourceAccountId
      )
  },
  transcripts: {
    search: (query: string) => ipcRenderer.invoke(IPC.transcriptSearch, query)
  },
  remoteHost: {
    start: () => ipcRenderer.invoke(IPC.remoteHostStart),
    stop: () => ipcRenderer.invoke(IPC.remoteHostStop),
    sendCanvasState: (state) => ipcRenderer.send(IPC.remoteHostCanvasState, state),
    onApplyMutation: subscribeMutation,
    onPeerPending: subscribePeerPending,
    onPeerPendingCleared: subscribePeerPendingCleared,
    approve: (id: string, pub?: string) => ipcRenderer.send(IPC.remoteHostApprove, { id, pub }),
    reject: (id: string, pub?: string) => ipcRenderer.send(IPC.remoteHostReject, { id, pub }),
    setPhoneAccess: (enabled) => ipcRenderer.send(IPC.remoteStandingHostSet, enabled)
  },
  relayHost: {
    start: (projectId?: string) => ipcRenderer.invoke(IPC.relayHostStart, projectId),
    invite: (opts?: { projectId?: string; email?: string }) =>
      ipcRenderer.invoke(IPC.relayHostInvite, opts ?? {}),
    stop: () => ipcRenderer.invoke(IPC.relayHostStop),
    revoke: (id: string) => ipcRenderer.send(IPC.relayHostRevoke, { id }),
    onPeerPending: subscribeRelayPeerPending,
    confirm: (id: string) => ipcRenderer.send(IPC.relayHostConfirm, { id }),
    onOpen: subscribeRelayHostOpen,
    onClosed: subscribeRelayHostClosed
  },
  relayClient: {
    connect: (offer) => ipcRenderer.invoke(IPC.relayClientConnect, offer),
    onSas: (connectionId, listener) => {
      const channel = IPC.relayClientSas(connectionId)
      const handler = (_e: unknown, sas: string | null) => listener(sas)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    confirm: (connectionId) => ipcRenderer.send(IPC.relayClientConfirm, { id: connectionId }),
    onApproved: (connectionId, listener) => {
      const channel = IPC.relayClientApproved(connectionId)
      const handler = () => listener()
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    send: (connectionId, frame) => ipcRenderer.send(IPC.relayClientSend, connectionId, frame),
    onFrame: (connectionId, listener) => {
      const channel = IPC.relayClientFrame(connectionId)
      const handler = (_e: unknown, frame: string) => listener(frame)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onClosed: (connectionId, listener) => {
      const channel = IPC.relayClientClosed(connectionId)
      const handler = () => listener()
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    disconnect: (connectionId) => ipcRenderer.send(IPC.relayClientDisconnect, connectionId)
  },
  handoff: {
    build: (sessionId, agentId, sourceNodeId, cwd, accountId) =>
      ipcRenderer.invoke(IPC.handoffBuild, sessionId, agentId, sourceNodeId, cwd, accountId)
  },
  pairing: {
    start: () => ipcRenderer.invoke(IPC.pairingStart),
    stop: () => ipcRenderer.invoke(IPC.pairingStop),
    onDone: (cb) => {
      const handler = (_e: unknown, result: { ok: boolean }) => cb(result)
      ipcRenderer.on(IPC.pairingDone, handler)
      return () => ipcRenderer.removeListener(IPC.pairingDone, handler)
    },
    probeSsh: () => ipcRenderer.invoke(IPC.pairingProbeSsh),
    openRemoteLoginSettings: () => ipcRenderer.invoke(IPC.pairingOpenRemoteLoginSettings),
    listDevices: () => ipcRenderer.invoke(IPC.pairingListDevices),
    revokeDevice: (id) => ipcRenderer.invoke(IPC.pairingRevokeDevice, id)
  },
  // Team presence. `hello` is the only request (its response is how this client learns its OWN
  // ClientId, without which it would draw its own cursor as a peer's); the publishers are
  // fire-and-forget sends, and the two event channels are subscriptions. Nothing is persisted.
  presence: {
    hello: (identity: PeerIdentity) => ipcRenderer.invoke(IPC.presenceHello, identity),
    cursor: (cursor) => ipcRenderer.send(IPC.presenceCursor, cursor),
    focus: (nodeId) => ipcRenderer.send(IPC.presenceFocus, nodeId),
    chat: (text) => ipcRenderer.send(IPC.presenceChat, text),
    dino: (payload) => ipcRenderer.send(IPC.presenceDino, payload),
    project: (projectId) => ipcRenderer.send(IPC.presenceProject, projectId),
    onSync: (listener) => {
      const handler = (_e: unknown, peers: PeerState[]) => listener(peers)
      ipcRenderer.on(IPC.presenceSync, handler)
      return () => ipcRenderer.removeListener(IPC.presenceSync, handler)
    },
    onPeer: (listener) => {
      const handler = (_e: unknown, diff: PeerDiff) => listener(diff)
      ipcRenderer.on(IPC.presencePeer, handler)
      return () => ipcRenderer.removeListener(IPC.presencePeer, handler)
    }
  },
  contextLink: {
    setLinks: (map) => ipcRenderer.invoke(IPC.contextLinkSetLinks, map),
    info: () => ipcRenderer.invoke(IPC.contextLinkInfo)
  },
  boardLog: {
    append: (projectId, entry) => ipcRenderer.invoke(IPC.boardLogAppend, projectId, entry),
    read: (projectId, opts) => ipcRenderer.invoke(IPC.boardLogRead, projectId, opts),
    onChanged: (projectId, cb) => {
      const ch = IPC.boardLogChanged(projectId)
      const handler = (): void => cb()
      ipcRenderer.on(ch, handler)
      ipcRenderer.send(IPC.boardLogSubscribe, projectId)
      return () => {
        ipcRenderer.removeListener(ch, handler)
        ipcRenderer.send(IPC.boardLogUnsubscribe, projectId)
      }
    }
  },
  logs: {
    snapshot: () => ipcRenderer.invoke(IPC.logSnapshot),
    clear: () => ipcRenderer.send(IPC.logClear),
    onBatch: (cb) => {
      const handler = (_e: unknown, batch: LogRecord[]): void => cb(batch)
      ipcRenderer.on(IPC.logBatch, handler)
      ipcRenderer.send(IPC.logSubscribe)
      return () => {
        ipcRenderer.removeListener(IPC.logBatch, handler)
        ipcRenderer.send(IPC.logUnsubscribe)
      }
    }
  },
  // Per-node subscriptions (each terminal/editor listens) — multiplexed so they don't pile up
  // ipcRenderer listeners and trip the MaxListeners warning.
  shortcuts: {
    // Fire-and-forget: nothing waits on the answer. Main clears the bit itself on the three ways
    // this page can stop existing — window closed, renderer died, main-frame navigation (⌘R) —
    // but those are a backstop for a page that VANISHED, not a general safety net: an ordinary
    // disarm that never sends leaves the shortcuts suppressed until one of them happens.
    setRecording: (active: boolean) => ipcRenderer.send(IPC.uiShortcutRecording, active),
    // The terminal-focus mirror, same fire-and-forget shape and the same fail-safe reading on the
    // far side: main starts at "not focused" and the three page-death resets return it there, so a
    // report that never arrives costs the terminal-first policy, not the app's shortcuts.
    setTerminalFocused: (focused: boolean) => ipcRenderer.send(IPC.uiTerminalFocus, focused)
  },
  onMarkdownToggle: subscribe(IPC.appToggleMarkdown),
  onCloseNode: subscribe(IPC.appCloseNode),
  onZoomActualSize: subscribe(IPC.appZoomActualSize),
  // Native View menu → renderer.
  onToggleAutoAlign: subscribe(IPC.appToggleAutoAlign),
  onFitView: subscribe(IPC.appFitView),
  onToggleKanban: subscribe(IPC.appToggleKanban),
  onOpenSettings: subscribe(IPC.appOpenSettings),
  closeWindow: () => ipcRenderer.send(IPC.appCloseWindow),
  focusWindow: () => ipcRenderer.send(IPC.appFocusWindow),
  setBadgeCount: (count) => ipcRenderer.send(IPC.appSetBadge, count),
  // Page zoom for the UI-scale setting (issue #299). Re-clamped here because the value originates
  // in hand-editable settings.json and this is the boundary; no IPC — webFrame acts on this window.
  setUiZoomFactor: (factor) => webFrame.setZoomFactor(resolveUiScale(factor)),
  // Absolute path of a dropped/picked File (File.path was removed in Electron 30+).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  userDataDir: () => ipcRenderer.invoke(IPC.appUserDataDir),
  notify: (payload) => ipcRenderer.invoke(IPC.appNotify, payload),
  openNotificationSettings: () => ipcRenderer.invoke(IPC.appOpenNotificationSettings),
  onFocusNode: (listener) => {
    const handler = (_e: unknown, nodeId: string) => listener(nodeId)
    ipcRenderer.on(IPC.appFocusNode, handler)
    return () => ipcRenderer.removeListener(IPC.appFocusNode, handler)
  },
  onMemoryPressure: (listener) => {
    const handler = (_e: unknown, severity: 'warning' | 'critical') => listener(severity)
    ipcRenderer.on(IPC.appMemoryPressure, handler)
    return () => ipcRenderer.removeListener(IPC.appMemoryPressure, handler)
  },
  onPtyPressure: (listener) => {
    const handler = (_e: unknown, reading: PtyPressure) => listener(reading)
    ipcRenderer.on(IPC.ptyPressure, handler)
    return () => ipcRenderer.removeListener(IPC.ptyPressure, handler)
  },
  onCanvasTrackpadGesture: (listener) => {
    const handler = (_e: unknown, active: boolean) => listener(active)
    ipcRenderer.on(IPC.canvasTrackpadGesture, handler)
    return () => ipcRenderer.removeListener(IPC.canvasTrackpadGesture, handler)
  },
  raisePtyDeviceLimit: () => ipcRenderer.invoke(IPC.ptyRaiseDeviceLimit),
  answerPermission: (payload) => ipcRenderer.invoke(IPC.agentAnswerPermission, payload),
  ackDone: (nodeId) => {
    void ipcRenderer.invoke(IPC.agentAckDone, nodeId)
  },
  onUnreadClear: (listener) => {
    const handler = (_e: unknown, nodeId: string) => listener(nodeId)
    ipcRenderer.on(IPC.agentUnreadClear, handler)
    return () => ipcRenderer.removeListener(IPC.agentUnreadClear, handler)
  },
  onAgentStatus: (listener) => {
    const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(IPC.agentStatus, handler)
    return () => ipcRenderer.removeListener(IPC.agentStatus, handler)
  },
  reportHibernated: (nodeId, on) => ipcRenderer.send(IPC.agentHibernated, { nodeId, on }),
  onAgentWake: (listener) => {
    const handler = (_e: unknown, nodeId: string) => listener(nodeId)
    ipcRenderer.on(IPC.agentWake, handler)
    return () => ipcRenderer.removeListener(IPC.agentWake, handler)
  },
  onRemoteViewers: (listener) => {
    const handler = (_e: unknown, nodeIds: string[]) => listener(nodeIds)
    ipcRenderer.on(IPC.agentRemoteViewers, handler)
    return () => ipcRenderer.removeListener(IPC.agentRemoteViewers, handler)
  },
  onSubagentActivity: (listener) => {
    const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(IPC.agentSubagentActivity, handler)
    return () => ipcRenderer.removeListener(IPC.agentSubagentActivity, handler)
  },
  onAgentControl: (listener) => {
    const handler = (_e: unknown, cmd: unknown) => listener(cmd as never)
    ipcRenderer.on(IPC.agentControl, handler)
    return () => ipcRenderer.removeListener(IPC.agentControl, handler)
  },
  sendAgentControlResult: (payload) => ipcRenderer.send(IPC.agentControlResult, payload),
  // The `browser` verb resolve round-trip (S8 PR 7): main asks the renderer which project owns the
  // source, whether it is control-capable, and whether the capability is on right now — the renderer
  // NEVER runs a CDP command.
  onBrowserControlResolve: (listener) => {
    const handler = (_e: unknown, req: unknown) => listener(req as never)
    ipcRenderer.on(IPC.browserControlResolve, handler)
    return () => ipcRenderer.removeListener(IPC.browserControlResolve, handler)
  },
  sendBrowserControlResolveResult: (payload) => ipcRenderer.send(IPC.browserControlResolveResult, payload),
  agentMessage: {
    deliver: (req) => ipcRenderer.invoke(IPC.agentMessageDeliver, req)
  }
}

contextBridge.exposeInMainWorld('nodeTerminal', api)

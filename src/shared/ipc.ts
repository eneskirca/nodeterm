// IPC channel names — single source of truth for both main and preload.

export const IPC = {
  ptyCreate: 'pty:create',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyFlow: 'pty:flow',
  ptyKill: 'pty:kill',
  ptyDestroy: 'pty:destroy',
  /** End a node's persistent session so the SAME node id can respawn in a new cwd ("move into
   *  worktree"). Same tmux kill-session as `ptyDestroy`, but it is NOT a deletion: the node stays
   *  on every canvas, so co-viewers get the restart notice (`ptyRecycled`) instead of the
   *  permanent, un-respawnable `ptyClosed`. */
  ptyRecycle: 'pty:recycle',
  ptyGenerateName: 'pty:generate-name',
  ptyGenerateGroupName: 'pty:generate-group-name',
  ptyCapture: 'pty:capture',
  ptyReadScrollback: 'pty:read-scrollback',
  ptySendText: 'pty:send-text',
  ptyTmuxStatus: 'pty:tmux-status',
  /** The foreground command of a node's tmux pane (`#{pane_current_command}`) — how the in-place
   *  agent restart sees that the CLI has exited and a shell owns the pane again. */
  ptyPaneCommand: 'pty:pane-command',
  ptyReadSessionName: 'pty:read-session-name',
  claudeReadTranscript: 'claude:read-transcript',
  chatReadTranscript: 'chat:read-transcript',
  claudeAccountsAdd: 'claude-accounts:add',
  claudeAccountsWaitLogin: 'claude-accounts:wait-login',
  claudeAccountsCancelWait: 'claude-accounts:cancel-wait',
  claudeAccountsRemove: 'claude-accounts:remove',
  claudeCliCaps: 'claude-cli:caps',
  transcriptSearch: 'transcript:search',
  appToggleMarkdown: 'app:toggle-markdown',
  appCloseNode: 'app:close-node',
  appCloseWindow: 'app:close-window',
  appFocusWindow: 'app:focus-window',
  /** Write text to the system clipboard from the MAIN process. Renderer-side `clipboard` access is
   *  deprecated in Electron; the renderer sends this instead (fire-and-forget). */
  clipboardWrite: 'clipboard:write',
  appNotify: 'app:notify',
  appOpenNotificationSettings: 'app:open-notification-settings',
  appFocusNode: 'app:focus-node',
  appSetBadge: 'app:set-badge',
  agentStatus: 'agent:status',
  /** Renderer → main/server: answer a held Claude permission hook (deterministic approvals).
   *  Payload: `{ nodeId, pendingId, decision: 'allow'|'deny' }`; resolves boolean. See
   *  docs/hook-reply-approvals.md. */
  agentAnswerPermission: 'agent:answer-permission',
  /** Renderer → main/server: the user READ a finished (done) session on this surface. Acks the
   *  node's done inbox event(s) + dismisses the paired phone's lingering DONE Live Activity. Arg:
   *  `nodeId: string`. Fire-and-forget. See agent-status-mirror `ackDone`. */
  agentAckDone: 'agent:ack-done',
  /** main/server → renderer: drop the unread flag for a node because the phone READ its finished
   *  session (a `~/.nodeterm/acks/<nodeId>.seen` the host swept). Arg: `nodeId: string`. The
   *  renderer clears unread WITHOUT re-acking (external clear — see agentStatus.clearUnread's
   *  `external` opt). See core/ack-sweep.ts. */
  agentUnreadClear: 'agent:unread-clear',
  agentSubagentActivity: 'agent:subagent-activity',
  /** macOS Notch HUD (docs/notch-hud.md). main → hud: push the current row array. */
  hudRows: 'hud:rows',
  /** hud → main: toggle window click-through on hotspot enter/leave. Arg: `ignore: boolean`. */
  hudSetIgnoreMouse: 'hud:set-ignore-mouse',
  /** hud → main: a HUD row was clicked — focus the node in nodeterm + clear its done latch.
   *  Arg: `nodeId: string`. Reuses the notification-click focus path. */
  hudFocusNode: 'hud:focus-node',
  /** hud → main: the panel expanded/collapsed. `true` clears every done latch (you looked). */
  hudExpanded: 'hud:expanded',
  /** hud → main: dismiss one HUD row by hand (a stuck session). Arg: `nodeId: string`. */
  hudDismiss: 'hud:dismiss',
  agentControl: 'agent:control',
  agentControlResult: 'agent:control-result',
  /** Canvas sync: a client casts its local node mutations here; the core reflector
   *  (src/core/canvas-sync.ts) stamps each with the total order (`seq`) and sends it back out on the
   *  SAME channel to EVERY attached client — the sender included, whose copy is its ack (see
   *  src/shared/canvas-order.ts). Args (both directions): [projectId: string, CanvasMutation]. */
  canvasMut: 'canvas:mut',
  contextLinkSetLinks: 'context-link:set-links',
  contextLinkInfo: 'context-link:info',
  /** Board-log (`.nodeterm/board-log.jsonl`): request/response append + read, routed per project
   *  (local cwd / desktop-ssh / unsupported) in core/board-log-handlers.ts. */
  boardLogAppend: 'board-log:append',
  boardLogRead: 'board-log:read',
  /** Fire-and-forget ref-counted subscribe/unsubscribe: the first subscriber for a project starts
   *  the local fs.watch (or the desktop-ssh 5s poll); the last one stops it. */
  boardLogSubscribe: 'board-log:subscribe',
  boardLogUnsubscribe: 'board-log:unsubscribe',
  /** Per-project push fired when a project's board log changes (mirrors the ptyData naming). */
  boardLogChanged: (projectId: string) => `board-log:changed:${projectId}`,
  appUpdateAvailable: 'app:update-available',
  appUpdateDownloaded: 'app:update-downloaded',
  appUpdateProgress: 'app:update-progress',
  appUpdateError: 'app:update-error',
  appUpdateNotAvailable: 'app:update-not-available',
  appCheckForUpdates: 'app:check-for-updates',
  appGetVersion: 'app:get-version',
  appUserDataDir: 'app:user-data-dir',
  appUpdatePolicy: 'app:update-policy',
  licenseActivate: 'license:activate',
  licenseDeactivate: 'license:deactivate',
  licenseStatus: 'license:status',
  licenseChanged: 'license:changed',
  licenseUpgrade: 'license:upgrade',
  appRestartToUpdate: 'app:restart-to-update',
  announcementsFetch: 'announcements:fetch',
  usageFetch: 'usage:fetch',
  usageRefresh: 'usage:refresh',
  usageUpdate: 'usage:update',
  /** Non-Claude providers (codex, …) as one list; Claude keeps its own account-aware channels. */
  usageProviders: 'usage:providers',
  /** Claude usage for the connected SSH hosts' accounts, read ON those hosts over their
   *  ControlMasters. Empty on a shell without SSH projects. */
  usageRemote: 'usage:remote',
  /** Store/clear a provider's browser cookie (minimax, opencode). Write-only: no channel reads
   *  it back. */
  usageSetProviderCookie: 'usage:set-provider-cookie',
  /** Which cookie providers have one stored — lets the UI show state without handling secrets. */
  usageCookieProviders: 'usage:cookie-providers',
  contextUpdate: 'context:update',
  contextEnsure: 'context:ensure',
  // Team presence (docs/team-presence.md). `presence:hello` is a REQUEST: its response tells the
  // client its own clientId, so it never draws its own cursor. The rest are casts (client→server)
  // and events (server→clients); the server is a dumb reflector and applies no policy.
  presenceHello: 'presence:hello',
  presenceCursor: 'presence:cursor',
  presenceFocus: 'presence:focus',
  presenceChat: 'presence:chat',
  // The authority's live dino game snapshot (a cast, ~20 Hz). Ephemeral, like chat: spectators on
  // the same project render it; the hub sanitizes/clamps it (sanitizeDinoPayload).
  presenceDino: 'presence:dino',
  // Which project (canvas) the client is looking at. Cursors/focus are only meaningful to a
  // viewer on the same project — each project has its own nodes and coordinate space.
  presenceProject: 'presence:project',
  presenceSync: 'presence:sync',
  presencePeer: 'presence:peer',
  // Events broadcast from main to the renderer (sessionId is appended to the channel name).
  ptyData: (sessionId: string) => `pty:data:${sessionId}`,
  ptyExit: (sessionId: string) => `pty:exit:${sessionId}`,
  /** Authoritative size of a co-attached session: min(cols) × min(rows) over all subscribers.
   *  Broadcast to every subscriber whenever the subscriber set or any reported size changes. */
  ptySize: (sessionId: string) => `pty:size:${sessionId}`,
  /** The node was permanently destroyed by another client (payload: { by: ClientId }). The
   *  remaining subscribers show a "closed by <name>" state instead of respawning the session. */
  ptyClosed: (sessionId: string) => `pty:closed:${sessionId}`,
  /** The node's session was RECYCLED by another client (moved into a worktree): this session id is
   *  dead, but a replacement is already live under the same node id — restart the terminal so it
   *  co-attaches to it. Deliberately emitted only AFTER the replacement session exists (see
   *  PtyManager.recycleSession), so a co-viewer's restart can never spawn the node in its own,
   *  stale cwd.
   *  Payload: `{ ready: boolean }`. `ready:true` = the replacement session is registered, restart
   *  onto it. `ready:false` = the escape-hatch timeout fired and NO replacement ever came (the
   *  recycler's app died mid-move): the terminal must NOT respawn — it would spawn `nt-<id>` in
   *  its own stale cwd and silently undo the move — it ends and offers a manual reopen. */
  ptyRecycled: (sessionId: string) => `pty:recycled:${sessionId}`,
  /** Redraw for a client that fell too far behind: the session's CURRENT screen, captured from
   *  tmux. Sent instead of the discarded backlog (payload: the capture text). The terminal clears
   *  and repaints from it — see ServerPlatform's WS_DROP_WATER.
   *  CONTRACT: the payload is guaranteed NON-EMPTY (a failed capture is retried, never sent — an
   *  empty redraw would wipe a live terminal). The renderer must still IGNORE an empty payload
   *  rather than reset on it. */
  ptyResync: (sessionId: string) => `pty:resync:${sessionId}`,
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  workspaceProbeFolder: 'workspace:probe-folder',
  // main → renderer events
  workspaceMigrated: 'workspace:migrated',
  workspaceExternalChange: 'workspace:external-change',
  githubIssuesSubscribe: 'githubIssues:subscribe',
  githubIssuesUnsubscribe: 'githubIssues:unsubscribe',
  githubIssuesQuery: 'githubIssues:query',
  githubIssuesRefresh: 'githubIssues:refresh',
  githubIssuesMove: 'githubIssues:move',
  githubIssuesCreateLabels: 'githubIssues:create-labels',
  githubIssuesClearCache: 'githubIssues:clear-cache',
  githubIssuesChanged: (projectId: string) => `githubIssues:changed:${projectId}`,
  githubControlStatus: 'githubControl:status',
  githubControlApprove: 'githubControl:approve',
  githubControlRevoke: 'githubControl:revoke',
  githubControlSelectProvider: 'githubControl:select-provider',
  githubControlSaveToken: 'githubControl:save-token',
  githubControlClearToken: 'githubControl:clear-token',
  dialogSelectFolder: 'dialog:select-folder',
  dialogSelectFile: 'dialog:select-file',
  shellReveal: 'shell:reveal',
  shellOpenPath: 'shell:open-path',
  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsReadBinary: 'fs:read-binary',
  fsWrite: 'fs:write',
  fsMkdir: 'fs:mkdir',
  fsExists: 'fs:exists',
  filesQuickOpen: 'files:quick-open',
  /** Mint a one-shot HTTP download ticket (Server Edition only; every other shell answers null). */
  filesDownloadTicket: 'files:download-ticket',
  /** Persist pasted/dropped bytes that have no path here, and answer their absolute path. */
  filesSaveUpload: 'files:save-upload',
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  sshList: 'ssh:list',
  sshSave: 'ssh:save',
  sshDelete: 'ssh:delete',
  sshImport: 'ssh:import-candidates',
  sshConnectProject: 'ssh:connect-project',
  sshDisconnectProject: 'ssh:disconnect-project',
  sshKillSessions: 'ssh:kill-sessions',
  sshListDir: 'ssh:list-dir',
  sshMkdir: 'ssh:mkdir',
  sshUploadFile: 'ssh:upload-file',
  sshDownloadFile: 'ssh:download-file',
  /** Cache a remote media file locally (scp over the ControlMaster) and allowlist it for
   *  nt-media:// playback — how a VideoNode plays a file that lives on an SSH project's host. */
  sshMediaAllow: 'ssh:media-allow',
  sshFsList: 'sshFs:list',
  sshFsRead: 'sshFs:read',
  sshFsReadBinary: 'sshFs:read-binary',
  sshFsWrite: 'sshFs:write',
  sshFsMkdir: 'sshFs:mkdir',
  sshFsExists: 'sshFs:exists',
  sshProjectStatus: 'ssh-project:status',
  /** main → renderer: an SSH project's identity file is passphrase-protected and the ssh-agent
   *  does not hold the key (or the last answer was wrong), so show a prompt.
   *  Payload: SshPassphraseRequest. */
  sshPassphraseRequest: 'ssh-project:passphrase-request',
  /** renderer → main: the user's answer to an sshPassphraseRequest. Args: (requestId, value),
   *  value null on cancel. */
  sshPassphraseSubmit: 'ssh-project:passphrase-submit',
  /** main → renderer: a passphrase request expired main-side (abandoned prompt timeout). The
   *  renderer closes the matching dialog so a late answer cannot land in a dead request.
   *  Payload: { requestId }. */
  sshPassphraseDismiss: 'ssh-project:passphrase-dismiss',
  gitStatus: 'git:status',
  gitInit: 'git:init',
  gitClone: 'git:clone',
  gitCloneAbort: 'git:clone-abort',
  gitCloneDefaultParent: 'git:clone-default-parent',
  /** main → renderer event: { phase, percent } while a clone runs. */
  gitCloneProgress: 'git:clone-progress',
  gitCommit: 'git:commit',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitSync: 'git:sync',
  gitPublish: 'git:publish',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitStageAll: 'git:stage-all',
  gitUnstageAll: 'git:unstage-all',
  gitDiff: 'git:diff',
  gitDiscard: 'git:discard',
  gitSwitchBranch: 'git:switch-branch',
  gitCreateBranch: 'git:create-branch',
  gitShowFile: 'git:show-file',
  gitHistory: 'git:history',
  gitCommitFiles: 'git:commit-files',
  gitRemoteCommitUrl: 'git:remote-commit-url',
  gitMerge: 'git:merge',
  gitRebase: 'git:rebase',
  gitDeleteBranch: 'git:delete-branch',
  gitRenameBranch: 'git:rename-branch',
  gitFetch: 'git:fetch',
  gitForcePush: 'git:force-push',
  gitStashPush: 'git:stash-push',
  gitStashPop: 'git:stash-pop',
  gitRevert: 'git:revert',
  gitBranchAt: 'git:branch-at',
  gitCheckoutCommit: 'git:checkout-commit',
  gitRepoRoot: 'git:repo-root',
  gitWorktreeList: 'git:worktree-list',
  gitWorktreeAdd: 'git:worktree-add',
  gitWorktreeMerge: 'git:worktree-merge',
  gitWorktreeRemove: 'git:worktree-remove',
  gitSetActiveRemote: 'git:set-active-remote',
  shellOpenExternal: 'shell:open-external',
  commitGenerate: 'commit:generate',
  mediaAllow: 'media:allow',
  mediaWriteHtml: 'media:write-html',
  browserRegister: 'browser:register',
  browserUnregister: 'browser:unregister',
  browserNewWindow: 'browser:new-window',
  remoteHostStart: 'remote:host:start',
  remoteHostStop: 'remote:host:stop',
  // Connection approval gate: main → renderer when a client finishes the handshake (carries the
  // SAS to display); renderer → main to approve/reject. Until approved, the host serves no
  // pty/fs RPCs or input frames, so a leaked offer cannot grant silent access.
  remoteHostPeerPending: 'remote:host:peer-pending',
  remoteHostApprove: 'remote:host:approve',
  remoteHostReject: 'remote:host:reject',
  // Host canvas mirror: renderer pushes its serialized active-project canvas to main;
  // main pushes a client's mutation back to the host renderer to apply.
  remoteHostCanvasState: 'remote:host:canvas-state',
  remoteHostApplyMutation: 'remote:host:apply-mutation',
  // Standing (phone) relay host: renderer toggles it on/off (settings.phoneAccessEnabled). Main
  // starts/stops the always-on host connection so a paired phone can reach this Mac over the relay.
  remoteStandingHostSet: 'remote:standing-host:set',
  // Revoke a paired PEER (by its stable box public key). Unpinning alone only refuses the NEXT
  // handshake — the open relay socket keeps full shell access — so this ALSO cuts the live session
  // (revocation.ts's whole point; see relay-host.ts's killRelayHostsByPeerKey).
  remoteRevokePeer: 'remote:revoke-peer',
  // ── New E2EE relay tunnel (Stage 4) ─────────────────────────────────────────────────────────
  // The successor to the legacy `remote:host:*` dialect above (the `remote:client:*` desktop-client
  // channels were deleted in Task 10; the desktop client is now the `relay:*` tunnel). The phone
  // still speaks `remote:host:*` until the iOS repo migrates (docs/ios-protocol-migration.md), so
  // these deliberately use a distinct `relay:*` namespace. A connected peer is a first-class
  // CorePlatform client: the client casts raw rpc.ts frames (JSON strings) at the host and receives
  // frames back, rather than a bespoke per-verb channel set.
  //
  // HOST side: enter/leave host mode, and the mutual-approval gate. `relayHostPeerPending` fires
  // main → renderer when a client finishes the encrypted handshake and is awaiting approval
  // (payload `{ id, sas, peerKeyB64 }` — the SAS both humans compare, the peer's box key to pin);
  // the host human answers with `relayHostConfirm` (id). `relayHostOpen` / `relayHostClosed` fire
  // main → renderer when a bridged peer becomes a live client / drops (payload `{ id }`).
  relayHostStart: 'relay:host:start',
  // Team Access (multi-seat): `relayHostInvite` ADDS a seat (invoke, `{ projectId?, email? }` →
  // `{ offer }`, cap-checked → rejects `E_SEATS_FULL`); `relayHostRevoke` (send, `{ id }`) cuts one
  // bridged peer's live session. `relayHostPeerPending`/`relayHostOpen` now also carry the seat
  // `email` label. Host-side cap/revoke are UX/host enforcement, not a server-guaranteed limit (v2).
  relayHostInvite: 'relay:host:invite',
  relayHostRevoke: 'relay:host:revoke',
  relayHostStop: 'relay:host:stop',
  relayHostPeerPending: 'relay:host:peer-pending',
  relayHostConfirm: 'relay:host:confirm',
  relayHostOpen: 'relay:host:open',
  relayHostClosed: 'relay:host:closed',
  // CLIENT side: connect to a host by its pairing offer (resolves a connectionId), the client half
  // of the same mutual-approval gate, and the raw frame pipe. `relayClientSas` pushes the channel
  // SAS main → renderer so the client human can compare it before the host approves;
  // `relayClientConfirm` (id) is this human's confirmation; `relayClientApproved` fires once the
  // host approves. `relayClientSend` casts an outbound rpc frame (JSON) at the host;
  // `relayClientFrame` delivers an inbound one. `relayClientClosed` fires when the socket drops.
  relayClientConnect: 'relay:client:connect',
  relayClientConfirm: 'relay:client:confirm',
  relayClientSend: 'relay:client:send',
  relayClientDisconnect: 'relay:client:disconnect',
  relayClientSas: (connectionId: string) => `relay:client:sas:${connectionId}`,
  relayClientApproved: (connectionId: string) => `relay:client:approved:${connectionId}`,
  relayClientFrame: (connectionId: string) => `relay:client:frame:${connectionId}`,
  relayClientClosed: (connectionId: string) => `relay:client:closed:${connectionId}`,
  handoffBuild: 'handoff:build',
  // Phone pairing (nodeterm iOS "scan a QR" flow): renderer starts/stops the one-shot LAN
  // listener; main pushes the completion result back over `pairing:done`. The per-device
  // registry (list/revoke) lives in ~/.nodeterm/agent.json.
  pairingStart: 'pairing:start',
  pairingStop: 'pairing:stop',
  pairingDone: 'pairing:done',
  pairingProbeSsh: 'pairing:probe-ssh',
  pairingOpenRemoteLoginSettings: 'pairing:open-remote-login-settings',
  pairingListDevices: 'pairing:listDevices',
  pairingRevokeDevice: 'pairing:revokeDevice',
  // Dictation (desktop/server). speechProgress is a main/server → renderer broadcast of
  // { id, pct } while a whisper model downloads (WhisperModelStore.onProgress).
  speechTranscribe: 'speech:transcribe',
  speechModels: 'speech:models',
  speechModelDownload: 'speech:model-download',
  speechModelDelete: 'speech:model-delete',
  speechProgress: 'speech:progress',
  // Electron-only: registered in src/main/index.ts (systemPreferences.askForMediaAccess) and
  // stubbed `async () => true` in src/server/index.ts (browser mic permission is the browser's
  // own prompt, not ours to gate).
  speechMicConsent: 'speech:mic-consent'
} as const

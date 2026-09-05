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
  /** Desktop-only awaited recycle path used after an explicit destructive-action confirmation. */
  ptyRecycleConfirmed: 'pty:recycle-confirmed',
  ptyGenerateName: 'pty:generate-name',
  ptyGenerateGroupName: 'pty:generate-group-name',
  ptyCapture: 'pty:capture',
  ptyReadScrollback: 'pty:read-scrollback',
  ptySendText: 'pty:send-text',
  ptyTmuxStatus: 'pty:tmux-status',
  /** The foreground command of a node's tmux pane (`#{pane_current_command}`) — how the in-place
   *  agent restart sees that the CLI has exited and a shell owns the pane again. */
  ptyPaneCommand: 'pty:pane-command',
  /** Renderer → core: SIGTERM the non-shell foreground process group in this node's pane.
   *  Model switching uses this instead of typing an exit slash-command into an agent composer. */
  ptyTerminateForeground: 'pty:terminate-foreground',
  ptyReadSessionName: 'pty:read-session-name',
  /** Shell → renderer: this MACHINE's pty-device pressure band changed (core/pty-pressure.ts).
   *  Payload: `PtyPressure` — `{ level, usage, ceiling }`. Sent on band CHANGES only, and re-sent
   *  for a held band at most once every five minutes; `level: 'none'` is what clears the banner.
   *  Desktop only — see the Server Edition note beside the monitor in src/server/index.ts. */
  ptyPressure: 'pty:pressure',
  /** Renderer → main: the user clicked "Fix automatically…" on the pty-pressure banner. Raises
   *  `kern.tty.ptmx_max` now AND installs a LaunchDaemon so it survives reboot, via ONE
   *  administrator-privileges osascript (macOS's own password dialog). Resolves
   *  `PtyLimitFixResult`. NEVER invoked on the app's own initiative — see main/ptmx-limit.ts. */
  ptyRaiseDeviceLimit: 'pty:raise-device-limit',
  claudeReadTranscript: 'claude:read-transcript',
  chatReadTranscript: 'chat:read-transcript',
  claudeAccountsAdd: 'claude-accounts:add',
  claudeAccountsWaitLogin: 'claude-accounts:wait-login',
  claudeAccountsCancelWait: 'claude-accounts:cancel-wait',
  claudeAccountsRemove: 'claude-accounts:remove',
  claudeAccountsLink: 'claude-accounts:link',
  // Machine-scoped managed Codex accounts (S6). Add/device-login/removal, plus the three-phase,
  // owner-authorized account switch (resume the SAME conversation id, never fork) and the
  // source-side leg of moving an idle conversation to an SSH account. See main/codex-accounts.ts.
  codexAccountsAdd: 'codex-accounts:add',
  codexAccountsWaitLogin: 'codex-accounts:wait-login',
  codexAccountsCancelWait: 'codex-accounts:cancel-wait',
  codexAccountsIdentity: 'codex-accounts:identity',
  codexAccountsSystemIdentity: 'codex-accounts:system-identity',
  codexAccountsRemove: 'codex-accounts:remove',
  codexAccountsSwitchThread: 'codex-accounts:switch-thread',
  codexAccountsCommitSwitch: 'codex-accounts:commit-switch',
  codexAccountsFinishSwitch: 'codex-accounts:finish-switch',
  codexAccountsRollbackSwitch: 'codex-accounts:rollback-switch',
  codexAccountsTransferThreadToSsh: 'codex-accounts:transfer-thread-to-ssh',
  claudeCliCaps: 'claude-cli:caps',
  grokCliCaps: 'grok-cli:caps',
  grokTakenSessionIds: 'grok-cli:taken-session-ids',
  /** Can a node on this machine get a managed Codex identity? See core/codex-identity-caps.ts. */
  codexIdentityCaps: 'codex-identity:caps',
  /** main/server → renderer: a Codex node's identity mode changed ('shared' | 'plain'). The
   *  'plain' events are what make the launcher's fallback visible instead of silent. */
  codexIdentity: 'codex-identity:event',
  /** Renderer → main: a snapshot of the main process's `process.env`, used to expand `${env:VAR}`
   *  tokens in custom-agent launch commands and the Settings preview (the renderer has no
   *  `process.env` of its own). Values are strings; undefined entries are omitted.
   *  DESKTOP-WINDOW-ONLY: registered via raw `ipcMain.handle`, never `platform().handle` — a
   *  peer-dispatchable full-env dump is the credential-leak class PR #195 closed. The
   *  browser/relay bridges answer `{}` locally and expansion degrades to the missing-env
   *  refusal. */
  envSnapshot: 'env:snapshot',
  /** Renderer → core: fetch an OpenAI-compatible model catalogue without browser CORS. */
  agentDiscoverModels: 'agent:discover-models',
  /** Renderer → core secret boundary for a literal model-gateway API key. The value is write-only;
   *  status returns only presence + storage protection. */
  agentGatewayCredentialStatus: 'agent:gateway-credential-status',
  agentGatewayCredentialSave: 'agent:gateway-credential-save',
  agentGatewayCredentialClear: 'agent:gateway-credential-clear',
  transcriptSearch: 'transcript:search',
  appToggleMarkdown: 'app:toggle-markdown',
  appCloseNode: 'app:close-node',
  /** main → renderer: ⌘/Ctrl+0 ("actual size"). Intercepted in `before-input-event` because
   *  Electron's default View menu binds that accelerator to `resetZoom`, which resets the WINDOW's
   *  page zoom rather than the canvas's. */
  appZoomActualSize: 'app:zoom-actual-size',
  /** Renderer → main: the Settings shortcut recorder is armed (`true`) or disarmed (`false`).
   *  While armed the main window's `before-input-event` intercepts above stand down entirely, so
   *  the chord the user is recording — ⌘W and ⌘M among them — reaches the recorder instead of
   *  closing their selected nodes. Fire-and-forget `send`; desktop-only (a browser tab has no
   *  application menu to steal a chord back from, so the Server Edition stubs it). */
  uiShortcutRecording: 'ui:shortcut-recording',
  /** Renderer → main: an xterm does (`true`) / does not (`false`) currently hold keyboard focus.
   *  A MIRROR, not a request: under the `terminal-first` shortcut policy the intercepts above must
   *  stand down while the user is typing in a terminal, and `before-input-event` fires before any
   *  renderer handler could tell main so — the answer has to already be there. Change-deduped by
   *  the sender, fire-and-forget `send`, and read fail-safe: main starts at `false` and every way
   *  the page can stop existing resets it there, so a stale mirror means intercepts ON (the
   *  pre-policy app), never a window whose ⌘W has silently gone back to the application menu.
   *  Desktop-only, for the same reason as the recording bit — the Server Edition stubs it. */
  uiTerminalFocus: 'ui:terminal-focus',
  appCloseWindow: 'app:close-window',
  /** Main → renderer: the native application menu's "Settings…" item (⌘,) was clicked. The
   *  renderer opens the settings page — same path as the in-canvas gear button / Cmd+, keydown. */
  appOpenSettings: 'app:open-settings',
  appFocusWindow: 'app:focus-window',
  /** Native View menu → renderer: toggle the Snap-to-Grid arrange mode. */
  appToggleAutoAlign: 'app:toggle-auto-align',
  /** Native View menu → renderer: fit the canvas to its nodes. */
  appFitView: 'app:fit-view',
  /** Native View menu → renderer: toggle the kanban / canvas view. */
  appToggleKanban: 'app:toggle-kanban',
  /** Write text to the system clipboard from the MAIN process. Renderer-side `clipboard` access is
   *  deprecated in Electron; the renderer sends this instead (fire-and-forget). */
  clipboardWrite: 'clipboard:write',
  /** Copy local files as file references (not bytes/text) to the macOS system clipboard. */
  clipboardWriteFiles: 'clipboard:write-files',
  appNotify: 'app:notify',
  appOpenNotificationSettings: 'app:open-notification-settings',
  appFocusNode: 'app:focus-node',
  appSetBadge: 'app:set-badge',
  /** Main → renderer: the host (or this process's own RSS) crossed a memory-pressure watermark,
   *  so the renderer should run its reclaim levers now (hidden WebGL contexts, parked terminals).
   *  Payload: `'warning' | 'critical'`. Re-fired at most once a minute — see core/memory-pressure. */
  appMemoryPressure: 'app:memory-pressure',
  /** Main → renderer: a macOS trackpad gesture (two-finger scroll or pinch) opened or closed on
   *  the main window — edge transitions from main/trackpad-gesture.ts, a handful per physical
   *  gesture. Payload: `boolean` (active). The canvas wheel router uses this as ground-truth
   *  device identity, replacing delta-shape guessing on the desktop. Desktop only — the Server
   *  Edition's browser tab has no raw input stream and keeps the heuristics. */
  canvasTrackpadGesture: 'canvas:trackpad-gesture',
  agentStatus: 'agent:status',
  agentSubagentSnapshot: 'agent:subagent-snapshot',
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
  /** Renderer → main/server: a node's Eco hibernation flag changed (the renderer owns the flag —
   *  `agentStatus.setHibernated` — and main only mirrors it, like `terminalFocused`). Arg:
   *  `{ nodeId: string, on: boolean }`. Fire-and-forget cast; feeds the agent-status mirror so the
   *  phone can render SLEEPING, and gives main the `isHibernated` signal the delivery queue's
   *  hibernated leg was recorded as missing (agent-messaging.ts). */
  agentHibernated: 'agent:hibernated',
  /** main → renderer: ask the renderer to wake a hibernated node NOW (a phone viewer attached to
   *  its session over the relay). A nudge, never an assertion: the renderer re-reads the flag and
   *  no-ops for a non-hibernated or unmounted node — same contract as `wakeHibernatedNode`. Arg:
   *  `nodeId: string`. */
  agentWake: 'agent:wake',
  /** main → renderer: ask the renderer to reload a terminal node's view in place NOW (bump its
   *  `respawnNonce` — fresh PTY attach to the SAME tmux session, nothing running is interrupted).
   *  Fired by the phone relay host's `node.refresh` verb (the session-list long-press menu's
   *  "Refresh on desktop"). Same nudge contract as `agent:wake`: the renderer no-ops for an
   *  unknown, non-terminal or unmounted (inactive project) node. Arg: `nodeId: string`. */
  agentRefreshNode: 'agent:refresh-node',
  /** main → renderer: rename a node on behalf of a phone (the relay host's `node.rename` verb).
   *  Routed through the renderer's `renameSession` funnel — the same one the node header uses —
   *  so `titleAuto` flips off and a rename-capable agent gets `/rename` pushed into its live
   *  session; a raw `data.title` write (canvas:mutate) would do neither and be overwritten by the
   *  next session-name poll. The title is sanitized host-side before this fires (control chars
   *  stripped, length-clamped). Arg: `{ nodeId: string, title: string }`. */
  agentRenameNode: 'agent:rename-node',
  /** main → renderer: the CURRENT set of node ids with a live relay viewer attached (a phone
   *  watching the session). Arg: `string[]` — the full set each change, so a dropped event cannot
   *  strand a stale entry. Feeds `isNodeWatched`: a session someone is watching from a phone must
   *  not be hibernated out from under them. */
  agentRemoteViewers: 'agent:remote-viewers',
  agentSubagentActivity: 'agent:subagent-activity',
  /** macOS Notch HUD (docs/notch-hud.md). main → hud: push the current row array. */
  hudRows: 'hud:rows',
  /** hud → main: toggle window click-through on hotspot enter/leave. Arg: `ignore: boolean`. */
  hudSetIgnoreMouse: 'hud:set-ignore-mouse',
  /** hud → main: a HUD row was clicked — focus the node in nodeterm + clear its done latch.
   *  Arg: `nodeId: string`. Reuses the notification-click focus path. */
  hudFocusNode: 'hud:focus-node',
  /** hud → main: the panel expanded/collapsed. Arg: `expanded: boolean`. Marks NOTHING as read —
   *  the handler is deliberately a no-op (notch-hud.ts `onExpanded`). It used to clear every done
   *  latch ("you looked"), which with three finished sessions waiting meant opening the panel and
   *  clicking one silently swallowed the other two. Read is strictly per row: `hudFocusNode` clears
   *  that row, `hudDismiss` hides one by hand. Still wired because the expand state may drive more
   *  main-side behavior later. */
  hudExpanded: 'hud:expanded',
  /** hud → main: dismiss one HUD row by hand (a stuck session). Arg: `nodeId: string`. */
  hudDismiss: 'hud:dismiss',
  agentControl: 'agent:control',
  agentControlResult: 'agent:control-result',
  agentMessageDeliver: 'agent:message-deliver',
  /** Canvas sync: a client casts its local node mutations here; the core reflector
   *  (src/core/canvas-sync.ts) stamps each with the total order (`seq`) and sends it back out on the
   *  SAME channel to EVERY attached client — the sender included, whose copy is its ack (see
   *  src/shared/canvas-order.ts). Args (both directions): [projectId: string, CanvasMutation]. */
  canvasMut: 'canvas:mut',
  contextLinkSetLinks: 'context-link:set-links',
  contextLinkInfo: 'context-link:info',
  /** Board-log (`.nodeterm/board-log.jsonl`): request/response append + read, routed per project
   *  (local cwd / desktop-ssh / unsupported) in core/board-log-handlers.ts. */
  /** Debug log panel (issue #78) — invoke: the whole ring (LogRecord[]) for the initial fill. */
  logSnapshot: 'log:snapshot',
  /** Fire-and-forget ref-counted subscribe/unsubscribe for the batched logBatch pushes. */
  logSubscribe: 'log:subscribe',
  logUnsubscribe: 'log:unsubscribe',
  /** main→renderer push: a LogRecord[] batch. Flows only while ≥1 panel is subscribed AND the
   *  debugLogPanel setting is on; the client dedupes by seq. */
  logBatch: 'log:batch',
  /** Fire-and-forget: empty the ring. */
  logClear: 'log:clear',
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
  licenseDetail: 'license:detail',
  licenseRelease: 'license:release',
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
  /** Per-session memory breakdown for the scoped machine. On demand only — never polled: the
   *  local sweep walks the whole process table, and the SSH one is an exec on someone else's
   *  host. */
  sessionMemory: 'session-memory:read',
  /** The scoped machine's RAM (available/total) — the cheap read behind the system-resource
   *  pill. Safe to poll locally; NOT polled for an SSH scope. */
  sessionMemoryHost: 'session-memory:host',
  // Trigger nodes (issue #493): machine-local arm/disarm + the card's status/run-now.
  triggersArm: 'triggers:arm',
  triggersDisarm: 'triggers:disarm',
  triggersStatus: 'triggers:status',
  triggersRunNow: 'triggers:run-now',
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
  /** Is a folder's .nodeterm/project.json present / absent / unreadable — the distinction
   *  `probeFolder`'s null collapses. Recovery of an `unavailable` project needs it (issue #385). */
  workspaceProjectFileState: 'workspace:project-file-state',
  projectSettingsRead: 'project-settings:read',
  projectSettingsWriteShared: 'project-settings:write-shared',
  projectSettingsUpdateLocal: 'project-settings:update-local',
  /** Resolved settings + per-family trust verdict for one project (`ProjectLaunchInfo`), the single
   *  read a launcher warms before it may consume a shared-sourced value — answers `null` for an
   *  unknown project id, same as projectSettingsRead. */
  projectSettingsLaunchInfo: 'project-settings:launch-info',
  /** main→renderer broadcast: `{projectId}` after ANY family approval changes for that project (a
   *  consent dialog answered, a trust record revoked). Emitted by
   *  `ProjectSetupService.ensureFamilyTrusted` on an approval — for EVERY project that asked, not
   *  just the one that raised the prompt (two canvas nodes can share one location). */
  projectTrustChanged: 'project-trust:changed',
  /** Run a project's setup/archive script. Args: (projectId, kind, worktreePath?) — NO rootPath/
   *  projectName/ssh: the handler derives those itself from its own workspace index by projectId,
   *  never the caller (project-setup-handlers.ts). Answers a ProjectSetupRunResult — `started` only
   *  means the run was admitted (gated + single-flight), not that it finished; progress arrives on
   *  projectSetupEvent. */
  projectSetupRun: 'project-setup:run',
  projectSetupCancel: 'project-setup:cancel',
  /** Ask for one project's `agents`/`shell` family to be trusted, prompting if it is not. Args:
   *  `(projectId, family)` — nothing path-shaped: the handler derives the location from its own
   *  workspace index, same as projectSetupRun. Answers `true` only when the family is trusted at
   *  that location (nothing shared to gate, an existing grant, or a fresh approval); `false` covers
   *  skip, expiry and every failure. HOST-ONLY (`shared/host-control.ts`): it raises the host's own
   *  dialog. `setup` is deliberately NOT accepted here — that family is gated by the runner. */
  projectSetupRequestTrust: 'project-setup:request-trust',
  /** Renderer's answer to a projectSetupConsentRequest ('approve' | 'skip'). A stale/unknown
   *  requestId is a silent no-op — an expired prompt can never be approved late. */
  projectSetupConsentSubmit: 'project-setup:consent-submit',
  /** main→renderer: raise the trust dialog (payload: ProjectConsentRequest — tagged by family, the
   *  `setup` arm being the script-runner's own request). */
  projectSetupConsentRequest: 'project-setup:consent-request',
  /** main→renderer: close a prompt nobody answered (payload: { requestId }). */
  projectSetupConsentDismiss: 'project-setup:consent-dismiss',
  /** Per-project push carrying a ProjectSetupEvent (mirrors the boardLogChanged naming). */
  projectSetupEvent: (projectId: string) => `project-setup:event:${projectId}`,
  projectSetupSubscribe: 'project-setup:subscribe',
  projectSetupUnsubscribe: 'project-setup:unsubscribe',
  /** Renderer → core: symlink a project's `sharedPaths` from its repo root into a freshly-created
   *  git worktree. Args carry ONLY `(projectId, worktreePath)` — NEVER the path list, which the
   *  handler reads itself by projectId (the list is untrusted from a renderer). The handler
   *  validates `worktreePath` is that project's rootPath or one of its actual git worktrees, and
   *  refuses an SSH project (local-only this PR); an unknown/invalid input answers `[]`. Resolves
   *  `SharedPathResult[]`. See core/worktree-shared-paths-handlers.ts. */
  worktreeMaterializeShared: 'worktree:materialize-shared',
  // main → renderer events
  workspaceMigrated: 'workspace:migrated',
  /** Payload: the `workspace.json.corrupt-<ts>` filename the unreadable index was preserved as. */
  workspaceCorruptRecovered: 'workspace:corrupt-recovered',
  workspaceExternalChange: 'workspace:external-change',
  githubIssuesSubscribe: 'githubIssues:subscribe',
  githubIssuesUnsubscribe: 'githubIssues:unsubscribe',
  githubIssuesQuery: 'githubIssues:query',
  githubIssuesRefresh: 'githubIssues:refresh',
  githubIssuesMove: 'githubIssues:move',
  githubIssuesCreateLabels: 'githubIssues:create-labels',
  githubIssuesClearCache: 'githubIssues:clear-cache',
  githubIssuesChanged: (projectId: string) => `githubIssues:changed:${projectId}`,
  githubProjectAvatar: 'github:projectAvatar',
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
  shellPickProjectIcon: 'shell:pick-project-icon',
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
  /** Write a canvas image into the project's own `.nodeterm/images/` (see core/canvas-images.ts). */
  filesSaveCanvasImage: 'files:save-canvas-image',
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
  sshFsQuickOpen: 'sshFs:quick-open',
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
  // Browser control indicator + Stop (S8 PR 6). Main pushes the current driven-lease set to the
  // renderer (the chip / rope / kill row); the renderer asks main to revoke — per node, all, or a
  // whole project's — and main detaches the debugger + drops the ledger entry for real.
  browserLeaseChanged: 'browser:lease-changed',
  browserStop: 'browser:stop-control',
  browserStopAll: 'browser:stop-control-all',
  browserStopProject: 'browser:stop-control-project',
  // The `browser` VERB resolve round-trip (S8 PR 7). Main intercepts `browser` and asks the renderer
  // the two things ONLY it knows — which project owns the source node, whether that source is a
  // control-capable agent, and whether the per-project capability is on RIGHT NOW — over the same
  // routing every verb uses. Main makes the security decision (owner + capability + CDP gate) and
  // does the CDP work itself; the renderer never runs a CDP command.
  browserControlResolve: 'browser:control-resolve',
  browserControlResolveResult: 'browser:control-resolve-result',
  remoteHostStart: 'remote:host:start',
  remoteHostStop: 'remote:host:stop',
  // Connection approval gate: main → renderer when a client finishes the handshake (carries the
  // SAS to display); renderer → main to approve/reject. Until approved, the host serves no
  // pty/fs RPCs or input frames, so a leaked offer cannot grant silent access.
  remoteHostPeerPending: 'remote:host:peer-pending',
  remoteHostPeerPendingCleared: 'remote:host:peer-pending-cleared',
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

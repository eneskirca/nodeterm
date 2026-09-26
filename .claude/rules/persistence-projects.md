---
paths:
  - "src/core/workspace-*.ts"
  - "src/core/settings-store.ts"
  - "src/core/trigger-*.ts"
  - "src/shared/types.ts"
  - "src/shared/trigger*.ts"
  - "src/shared/cron.ts"
  - "src/server/canvas-control.ts"
  - "src/renderer/state/projects.ts"
  - "src/renderer/state/settings.ts"
  - "src/renderer/state/workspace.ts"
  - "src/renderer/lib/canvasLock.ts"
  - "src/renderer/lib/externalChange.ts"
  - "src/renderer/lib/projectCloseSessions.ts"
  - "src/renderer/lib/projectOpen.ts"
  - "src/renderer/lib/serverChange.ts"
  - "src/renderer/lib/setProjectFolder.ts"
  - "src/renderer/components/ClosedTranscriptDialog.tsx"
  - "src/renderer/components/WelcomeScreen.tsx"
  - "src/renderer/components/TabBar.tsx"
  - "src/renderer/components/Sessions*.tsx"
  - "src/renderer/canvas/Canvas.tsx"
---

## State & persistence model

**React Flow is the single live source of truth** for nodes. There is intentionally no
separate store mirroring node state — earlier dual-source designs caused sync bugs.
`src/renderer/state/workspace.ts` holds only pure helpers: the color palette, the node
factories (`createTerminalNode`, `createSshTerminalNode`, `createAgentNode(agentId, …)`,
`createAccountLoginNode`, `createStickyNode`, `createGroupNode`, `createEditorNode`,
`createDiffNode`, `createVideoNode`, `createWebNode`, `createBrowserNode`, `createFilesNode`,
`createDinoNode`, `createTriggerNode`), the
group transforms (`groupSelectedNodes`, `ungroupNodes`, `duplicateNode`), and the
`nodeStatesToFlow` / `flowToNodeStates` serializers. Node kinds (`NodeKind` in
`src/shared/types.ts`): `terminal | sticky | group | editor | diff | video | web | browser |
files | subagent | loop | dino | trigger` — `subagent` and `loop` are render-only (ephemeral hook-driven
viz) and never persisted. `trigger` (issue #493, all four
phases landed) is a first-class PERSISTED kind. The whole host-side
machine is composed ONCE in `core/trigger-service.ts` (`startTriggerService`) and booted
identically by BOTH shells: `core/trigger-scheduler.ts` (sweep-service shape, no catch-up for
missed slots, cron via the dependency-free `@shared/cron` with the vixie dom/dow OR rule) decides
WHEN, and `core/trigger-delivery.ts` decides WHETHER — the `sendText` paste path, an agent target
only on a mirror-verified idle `done` (busy/blocked/unknown → the messaging `DeliveryQueue`, own
instance, flushed by the mirror's `done` edge via `onNodeStateChange`, with FULL flush-time
re-validation: a trigger disarmed or spec-edited while queued is dropped), a plain-terminal target
only into a SHELL pane and never queued, a dead target an honest `missed` and never a cold start.
Fire-time `TriggerArmStore.isArmed` re-ask everywhere; every rule test-pinned. The kind's spec: its spec (`CanvasNodeState.trigger`,
@shared/trigger) is git-shared CONTENT sanitized as hostile input on every load path
(`sanitizeNodeTriggers`), and the definition alone never fires — execution consent is the
machine-local, content-bound `core/trigger-arm-store.ts` (a spec that arrives or CHANGES via git
reads as disarmed until armed on this machine). A node's `data`
carries `title, color, group, tags, collapsed, expandedHeight, shell, cwd, text,
initialCommand, filePath, diffStaged`, `icon` (a user-chosen emoji or picture — see **Node icons**
in `.claude/rules/appearance.md`), `agentId` (which agent CLI a terminal node runs —
persisted), and `accountId` (which managed Claude account a terminal node runs under — resolved
at creation, changed ONLY by the explicit account-switch actions, persisted; see **Managed Claude accounts** in `.claude/rules/accounts-usage.md`). `nodeStatesToFlow` defaults a
missing `kind` to `terminal` for backward compat and migrates the legacy `tags:['claude']` marker
to `data.agentId = 'claude'`. The SDK **chat node** was removed (2026-07); `nodeStatesToFlow` also
migrates a persisted `chat` node into a **sticky tombstone** in place, reading its legacy
`chatSessionId` to print a `claude --resume <id>` hint (a chat is an ordinary resumable Claude
session).

Persistence has two layers:

- **Layout + config**: schema v3. `workspace.json` (in `app.getPath('userData')`) is now an
  **index**: local folder projects are refs to `<cwd>/.nodeterm/project.json` (the source of
  truth — git-shareable, machine-portable; pretty-printed, portable `./` node cwds, monotonic
  `rev`), SSH projects are refs to the same file on the server (offline `cache` in the index,
  reconciled by rev on connect, mirrored via `SshFs` with a 5 s write throttle), and cwd-less
  canvases are refs to `userData/inline-projects/<id>.json`. **Every entry is a ref — one shape,
  three kinds:**

  | kind | source of truth for the CONTENT | what the index entry carries |
  |---|---|---|
  | folder-ref | `<cwd>/.nodeterm/project.json` (git-shared) | `cwd` + header + machine-local half |
  | ssh-ref | the same file on the host | `ssh` + header + `cache` (offline copy, rev-reconciled) |
  | local-data-ref | `userData/inline-projects/<id>.json` | `dataFile` + header + `project` (cache) |

  In all three the file carries CONTENT and the entry carries the machine-local half — project
  `id`, `viewport`, `defaultAccountId`, `breadcrumbs`, `closedSessions`, `localApprovalId`,
  `localExec`, `localSettings` (the #510 rule). The renderer contract is untouched: `workspace.load()/save()` still
  speak an assembled v2-shaped `Workspace`; all fan-out lives in `core/workspace-store.ts` +
  pure `core/workspace-files.ts`. v2 files migrate on first save (backup `workspace.v2.bak`,
  one-time renderer note). Outside edits (git pull/sync) are detected by
  `core/workspace-watcher.ts` → silent reload, or a Reload/Keep-mine conflict bar when dirty; they
  ride `workspace:external-change`, and so do the phone's `appendRemoteNode` and the SSH
  reconcile, which really are "another device".
  **A write this core made ITSELF rides `workspace:server-change` instead** — today that is Server
  Edition headless canvas control (`server/canvas-control.ts`) — and the renderer three-way merges
  it against the store baseline (`renderer/lib/serverChange.ts`: incoming nodes adopted silently,
  ropes/bridges merged by id with server-added installed, server-removed dropped, local unsaved
  edits kept, dangling edges pruned), never a bar and never a reload. It used to share the
  outside-edit channel and that was a data-loss path, not a cosmetic one: `decideExternalChange`
  compares the project shell, `ropes` included, so the one `ctrl-…` rope an `open-agent` appends
  read as a conflict whenever the canvas was dirty — which it is throughout a spawn burst (the
  paired `canvas:mut` marks it, spawns land 60–140 ms apart inside the 800 ms autosave debounce,
  and **the bar itself suspends autosave**, so once raised it stayed raised). Answering "Keep my
  version" then wrote the browser's edge state over the file, dropping the ropes the server had
  just persisted and resurrecting cards it had removed.
  Unreadable refs render as greyed **unavailable** tabs (never dropped); corrupt project files
  are set aside as `project.json.corrupt-<ts>`. "Open folder…" adopts an existing
  `.nodeterm/project.json` — the probe MINTS the project id (node ids — tmux names — kept), and
  re-opening the folder is answered by the cwd lookup, not a second adoption.
  **A cwd-less canvas is a supported, first-class project, not a degraded one** — "New project" on
  the welcome screen creates exactly that, and it survives a restart intact. It is the correct
  fallback layer and `localStorage` is not: `userData` is backed up with the app's data,
  atomic-written, and one store for all three shells, while localStorage is renderer-origin state
  the Server Edition would shard per browser profile.
  **What it used to lack was a SECOND copy, and that is what `local-data-ref` fixes.** A folder
  project's canvas also lives in `<cwd>/.nodeterm/project.json`, so a corrupt or clobbered index
  costs it nothing; an inline canvas existed ONLY inside the index — one file, last-writer-wins, so
  a second instance sharing that `userData` erased canvases that existed nowhere else, and a corrupt
  index left them only inside the `workspace.json.corrupt-<ts>` sideline with no UI path back.
  Each now has its own atomically written file, and the entry's `project` field is kept beside it as
  a **cache** — the dual-write that (a) lets a build older than this one still read the canvas out
  of the index (the downgrade contract, ONE release; the iOS SSH-browse path cats `workspace.json`
  directly and depends on it too) and (b) answers when the data file is missing or corrupt.
  The file wins whenever it reads. Rules that make this safe, all in `WorkspaceStore.writeDataFile`:
  an unchanged candidate is not written at all; **a lower `rev` may not overwrite a higher one** (a
  second instance wrote it after we looked — its canvas stands, the next load here adopts it, and
  there is deliberately NO merge: the guarantee is "two instances cannot erase each other", not
  "two instances stay in sync"); an empty candidate never overwrites a populated file this store has
  not read. A corrupt data file is set aside as `.corrupt-<ts>` like any other project file, and the
  sweep that deletes a removed project's file only ever touches ids THIS store had loaded — a file
  belonging to another instance is never deleted, at the price of some litter after a re-key.
  `userData/inline-projects` is deliberately NOT watched (`workspace-watcher` covers folder refs
  only): nothing external edits it — no git pull, no teammate — and the rev rule is the whole
  concurrency story. The corrupt-index note still matters and must stay honest; it used to promise
  "No project data was lost — each project's canvas is still in its own folder", which was true for
  refs and false for exactly the projects that had just vanished.
  **Binding a folder to an existing project is a WRITE, so probe before you bind.** "Set folder…"
  (tab ⌄) promotes an inline canvas to a ref, and the next autosave writes that folder's
  `project.json` — over whatever was already there. It used to bind unconditionally, so pointing a
  scratch project at a repo whose canvas a teammate had committed replaced it (rev 40 → rev 1, their
  nodes gone, no sideline copy, nothing on screen). The two entrances to "attach a folder" now agree:
  `openOrAdoptFolder` probes and ADOPTS, and `setProjectFolder` runs the pure
  `renderer/lib/setProjectFolder.ts` — an occupied OR unreadable `project.json` refuses the bind with
  its reason (a failed read is never evidence of absence, #385), and a folder another project already
  owns routes to that project, REOPENING it when it is closed rather than switching to a hidden tab.
  The store's own "never blind-write" guard does not cover this: it only refuses an EMPTY candidate
  over a populated file, and this candidate has nodes.
  **Features that need a folder degrade explicitly, never silently.** Explorer, Source Control and
  Project Settings already say so in words; the add menus now do too — "New file…" and "New
  worktree…" stay in the list DISABLED with `NEW_FILE_NO_CWD_HINT` / `WORKTREE_NO_CWD_HINT`
  (`lib/addMenuSpec`) instead of vanishing, and `openWorktreeDialog` refuses a cwd-less project at
  the same choke point it refuses an SSH one (the palette has no disabled state). The worktree
  dialog's "This project is not a git repository." was the wrong cause for a project that has no
  folder to be a repository at all.
  **An `unavailable` placeholder used to be a DEAD END** (issue #385): a save deliberately emits a
  header-only ref for it and never a file, so a `project.json` the user deleted was never
  recreated, every later load re-minted the placeholder, and nothing cleared the flag for a LOCAL
  project (`reopenProject` clears only `closed`; the sole `setProjectUnavailable(id,false)` caller
  is the relay reconnect). The tab went inert (`tabClickAction` → `'ignore'`) while the sessions
  sidebar — which has no concept of `unavailable` — still switched to it. An explicit "Open
  folder…" now breaks the loop, but only on EVIDENCE: `WorkspaceStore.projectFileState` reports
  `present | absent | unreadable` and **only a definite ENOENT counts as absence**, because
  clearing the flag lets the next save write the placeholder's empty canvas over whatever is
  there. Absent ⇒ clear; present ⇒ re-probe and rehydrate under the EXISTING entry id (a corrupt
  file stats fine, so a null probe keeps the placeholder); unreadable ⇒ change nothing. The
  decision is the pure `unavailableRecovery` (`renderer/lib/projectOpen.ts`), and it refuses to
  judge a REMOTE project from a local stat.
  **The shared file carries content, not identity**: no project `id`, no `viewport`, no
  `defaultAccountId` — those are machine-local and ride the index entry (`IndexEntryV3`), beside
  `localApprovalId`/`localExec`. Two folders holding the same committed canvas (worktree, branch
  checkout) are two independent projects, and the committed file is byte-identical on every
  machine. The file still carries a machine-INDEPENDENT legacy `id` (`legacyFileId`, derived from
  the canvas name) for one release, because a pre-change build sidelines an id-less file to
  `.corrupt-<ts>` inside the user's repo; it is ignored on read. Residual: node ids are still
  shared, so two worktrees still attach the same tmux sessions.
  **SSH mirror safety** (the ".nodeterm reset itself" bug — 12 fresh project ids and 45 orphaned
  tmux sessions in one field report): remote writes are atomic (`cat > f.tmp && mv`, `sshWriteArgs`);
  a mirror is never blind-written before the entry has read-compared the server file once
  (`WorkspaceStore.reconcileSsh` — the single decider; a checked read's `error` ≠ `absent`, and on
  error it decides NOTHING); cross-lineage conflicts (re-added folder, second machine, git checkout:
  the server file carries a different project id) are settled by content, not rev alone — an empty
  side never beats a populated one, adoption re-keys the file to the local project id (node ids =
  tmux session names are kept so terminals reattach), and a push outbids the losing lineage's rev;
  a throttled trailing write that drops after its optimistic ack re-owes the mirror
  (`markUnmirrored`); pending mirrors are flushed before the ControlMasters die at quit; and the
  SSH dialog **dedupes by endpoint+remoteCwd** (`openSshProject`, same contract as
  `openFolderProject`) instead of minting a fresh empty project for a folder that already has one.
  **The reconciler also recognizes its own writes** (the SSH twin of the watcher's `isSelfWrite`):
  the 15 s poll and the connect-time refresh read the very file the mirror writes, so
  `recentMirrorHashes` remembers the last few payloads handed to `remoteIO.write` and a read that
  returns those exact bytes decides "nothing new" — never an adopt/broadcast (which raised the
  Reload/Keep-mine conflict bar over the store's own autosave), and never a rescue of an OLDER own
  write still sitting under the 5 s throttle (which resurrected just-deleted nodes). Exact bytes
  only, so a phone append or another machine's save still reads as external. And
  `refreshSshProject` runs ON `saveChain`: off the chain a poll snapshotting the pre-save entry
  could complete its slow ssh read after the save's mirror landed and "adopt" the store's own
  write on rev alone.
  **A write ACK is not evidence about the server's CONTENT — only a read is** (2026-09-06 field
  report: 16 terminals deleted on an SSH project came straight back, announced as sessions
  registered from a phone the reporter does not own). `clearedNodes` is the tombstone set that
  tells the mirror's re-read "we deleted this, do not rescue it back", and it used to be dropped
  the moment `remoteIO.write` returned true. That ack is **optimistic for the 5 s throttle's
  trailing write** (`makeRemoteWorkspaceIO` returns true and schedules the run) — so when the
  connection died inside the window, `markUnmirrored` re-owed the mirror (`unmirrored.add`) while
  the tombstones were already gone, and the retry's re-read found every just-deleted node still on
  the server with nothing left to filter with: `rescueRemoteNodes` merged all 16 back into the
  cache, bumped the rev and broadcast them as an external change. The asymmetry was in one place —
  `unmirrored` was restored, `clearedNodes` was not. A tombstone is now retired ONLY by
  `confirmClearedDeletions`: a read that no longer lists the id (taken from reads the store already
  makes — the mirror's own re-read and `reconcileSsh` — so it costs no round-trip), or an adopt,
  which overrules our deletions outright. **Both** read sites must call it; wiring one leaves the
  other's tombstones alive for the whole run. The cost is that GC lags a landed write by one read,
  which only prolongs the suppression of a rescue we do not want; the benefit is that the rule no
  longer depends on a dropped write being REPORTED. Symmetrically restoring the set inside
  `markUnmirrored` was the smaller diff and was rejected: it needs the same shadow state anyway,
  and it only closes the one failure path that happens to report back. The set is runtime-only,
  bounded by the ids deleted this run, and pruned for projects that leave the index.
  **Neither surface may name a device for an adopted node** (`adoptedClause`,
  `renderer/lib/externalChange.ts`): nothing at that layer knows the source — a stale own mirror
  and a phone append are indistinguishable there — so the copy names the project FILE and offers
  the possibilities without asserting one.
- **Live terminal sessions** (tmux): terminals continue where they left off across node
  remounts *and* full app restarts, including running processes. See `.claude/rules/tmux-sessions.md`.

`settings.json` is a separate store (`core/settings-store.ts`, `state/settings.ts`).

## Projects (tabs)

Each project is one canvas/page; terminals and notes belong to a project. The `projects`
zustand store (`renderer/state/projects.ts`) holds project metadata + the *serialized* nodes
of all projects. **React Flow remains the single live source of truth for the *active*
project's nodes only.** The contract:

- The active-project effect in `Canvas.tsx` (keyed on `activeProjectId`) loads that project's
  serialized nodes into React Flow. `loadingRef` suppresses dirty-marking during this load.
  A real switch applies the project's saved viewport; an **in-place reload**
  (`reloadActiveProject` — external file change / SSH reconcile) sets `preserveViewportRef` so
  the load **keeps the user's current camera** — the incoming file's viewport is wherever
  another machine last saved, and restoring it mid-work teleported the camera (most visibly
  right after a cross-project sidebar focus, when the connect-time SSH reconcile landed a
  second after fitView centered the node).
- **Project order = array order**, and it is ONE order shared by the tab bar and the sessions
  sidebar (the sidebar no longer hoists the active project to the top). Both surfaces reorder
  via drag-drop through `reorderProject(draggedId, beforeId|null)` (null = to the end; tab
  strip empty area and sidebar body are the end-drop zones), persisted like any node reorder.
  Sidebar disclosure is **persisted**, for group frames as well as projects:
  `settings.sidebarCollapsedItems` maps `project:<id>` / `project:<id>:group:<groupId>` → collapsed
  (`isGroupCollapsed`), and `settings.sidebarAutoCollapse` (default on) now only supplies the
  DEFAULT for a project row nobody has toggled (on = active expanded / others collapsed, off =
  everything expanded). **This deliberately replaced the old "a project switch resets every manual
  toggle" effect** (2026-08, with the nested sidebar tree): a tree the user shaped by hand should
  still be that shape after a restart, and one transient rule for projects plus a sticky one for
  frames would have been two contracts in one list. `projectHeadClickAction` is unchanged — an
  inactive project row switches, the active one toggles its own (now persisted) collapse — and
  every write **prunes** keys that no longer address a live project/frame (`pruneCollapsedItems` /
  `liveCollapseKeys`), because settings.json is forever and a canvas churns through group ids.
- The bottom-left **canvas lock** freezes the CAMERA only (pan/zoom): nodes stay draggable,
  resizable and connectable while locked — the point is "stop the map sliding", not "freeze
  the work". It is **transient by default and opt-in to remember**: a lock that survives a
  restart reads as "the app is frozen" to whoever opens the app next, and the lit button is a
  small thing to spot, so `settings.rememberCanvasLock` (Behavior, default OFF) is what turns it
  into a preference. The bit itself lives in localStorage (`nodeterm.canvasLocked`,
  `renderer/lib/canvasLock.ts`) beside the view mode and the explorer pin, never in settings.json
  and never in the git-shared `project.json`: the SETTING says whether to remember, the lock is
  one person's view state. Note the two tiers differ per surface: on Desktop both are
  machine-local, but in the **Server Edition** the setting rides that server's settings.json
  (shared by every browser hitting it) while the bit is per browser PROFILE, so two profiles can
  legitimately disagree about the lock. Desktop + Server Edition; **Mobile: N/A** (no canvas).
  It is one GLOBAL bit rather than per-project
  because `<Canvas />` is mounted once and is not keyed by project, so the lock always carried
  across project switches within a session. Restore is gated on settings HYDRATION (Canvas mounts
  first, so a `useState` initializer would read the default and the opt-in would silently never
  work) and latched to the first run, so switching the setting on mid-session never reaches into
  storage and locks a canvas somebody is working on.
- Before any project switch / add / delete, `commitActiveToStore()` serializes the live
  React Flow nodes back into the store, so nothing is lost. Then disk is written.
- Switching away unmounts the old project's `TerminalNode`s → their tmux clients detach but
  the sessions keep running; switching back reattaches. tmux session names are per-node-id
  (globally unique), so projects never collide.
- The tab caret menu's **Close project** (`closeProject`) is **non-destructive**: it sets
  `project.closed = true` (hidden from the tab bar, kept on disk with all nodes) and leaves the
  tmux sessions running, so closing just detaches like a project switch. Closed projects are
  reopenable from the **"Recently closed"** list on `WelcomeScreen` (`reopenProject` → restores
  nodes, which reattach warm or cold-restore). `hasProjects` counts only **open** projects, so
  closing the last open one shows the welcome screen. **Permanent** deletion (`deleteProject`:
  `transport.destroy(nodeId)` per terminal + drop agent status + SSH teardown) now only happens
  via the `×` on a "Recently closed" entry. **Closing now SAYS what it parks** (issue #442 —
  "close" read like cleanup while meaning "hide, and keep running"): a project with terminal
  nodes gets a confirm naming the count, with an opt-in **"end its sessions too"** checkbox
  (default OFF — parking stays the rule; checked flips the confirm to danger). The pure half is
  `renderer/lib/projectCloseSessions.ts`: **one definition of N** — the project's terminal-kind
  nodes, exactly the set the action addresses (`transport.destroy` is idempotent on a dead
  session), never a liveness-verified count that could disagree with the action; the END happens
  at confirm time against the re-resolved node set (agents spawn nodes on their own). A relay tab
  or a 0-terminal project closes silently (byte-identical old path). `endProjectSessions` mirrors
  `deleteProject`'s teardown EXCEPT it keeps agent status (the persisted sessionId is what lets a
  reopen cold-restore `--resume`) and never disconnects SSH masters (close never managed the
  connection). The `×` also confirms now, via `deleteConfirmCopy` — a relay tab gets "removes
  only this machine's view; reconnecting brings it back" with no danger styling (deleting the
  view is what turns the next connect into a first-connect re-adopt), local/SSH get the session
  count + "the folder (incl. .nodeterm/project.json) is not deleted". And "Recently closed" rows
  show a **live-session badge** (`closedSessionCounts` over ONE on-demand local
  `sessionMemory.read` per welcome-screen appearance — never a timer; `ok:false` ⇒ no badge,
  never "0"; an SSH project's host-side sessions are deliberately not claimed by the local
  count). Server Edition: all renderer-side; the ws-bridge `sessionMemory` is real, so badges
  describe the server machine; the `sshProject` legs only run for `project.ssh`, which that
  shell never has.
- **Closing a NODE keeps a pointer to its transcript** (issue #531). The per-project
  `closedSessions` ledger records the agent session id as `ClosedSessionEntry.sessionId`, captured
  at delete time from the live `agentStatus` entry — which that same delete drops, so this is the
  last instant it exists anywhere — falling back to the minted `node.agentSessionId`. It is a
  POINTER, never a copy: the `.jsonl` the agent CLI owns stays the only text, and a second store of
  transcript text would age, drift and need its own retention policy. The "Recently closed" row
  spends it on the **existing ⌘M reader** (`ChatPanel` in `readOnly` mode, hosted by
  `ClosedTranscriptDialog`), so resolution, the `{found}` vs empty distinction and Retry cannot
  drift from the live-node path. Two rules: it rides `IndexEntryV3.closedSessions` and is therefore
  **machine-local** — a session id is a `$HOME`-anchored fact about one person's machine, and
  `projectToFile` must never emit it — and it is **re-checked as a string** in
  `sanitizeLoadedClosedSessions`, because workspace.json is hand-editable and the value goes
  straight to a resolver. `closedTranscriptTarget` (pure) owns the refusals and NAMES each: a
  REMOTE session is refused (its transcript is on the host; locating it over the ControlMaster is
  separate work and must not hold the local fix hostage) and a pre-#531 entry says its id was never
  recorded. Only the "this was never an agent" refusal may render as nothing — for the others a
  vanished control would leave the user believing that closing destroyed the record, which is the
  belief this exists to correct.
- A project's `cwd` (folder picker, `dialog:select-folder`) is passed to terminal/Claude
  node factories so new terminals open there. **Folder ↔ project is deduped:** "Open folder…"
  reuses the existing project with that `cwd` (and its nodes) instead of creating a duplicate.

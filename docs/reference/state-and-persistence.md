# State & persistence model — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

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
files | subagent | loop | dino | trigger | simulator | whiteboard` — `subagent` and `loop` are render-only (ephemeral hook-driven
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
initialCommand, filePath, diffStaged`, `icon` (a user-chosen emoji, glyph or picture — see **Node icons**
below), `agentId` (which agent CLI a terminal node runs —
persisted), and `accountId` (which managed Claude account a terminal node runs under — resolved
at creation, changed ONLY by the explicit account-switch actions, persisted; see **Managed Claude accounts**). `nodeStatesToFlow` defaults a
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
  | folder-data-ref | `userData/inline-projects/<id>.json` | `cwd` + `dataFile` + header + `project` (cache, stored WITHOUT `cwd`) |

  **The folder-data-ref (issue #1145)** is a folder project whose canvas is kept in app data
  (`Project.storeInAppData`) so that nothing is written into the folder — for client repos and
  folders the user does not own. It is a local-data ref with a working directory: the file and the
  cache hold the project without `cwd` (node cwds stay absolute), so the inline load and write paths
  serve it unchanged and the entry adds the folder back. Three rules keep the promise:
  `folderFileCwd(e)`, not `e.cwd`, decides every read or write of `<cwd>/.nodeterm/project.json`
  (watcher, content authority, the phone writers, settings); a missing data file falls back to the
  cache and then to a grey placeholder, **never** to the folder branch (that would adopt a stale or
  a teammate's canvas); and the cache's missing `cwd` is the downgrade contract — an older build
  opens it as a plain inline canvas instead of writing a fresh file into the folder. Its side files
  follow it: settings.json and the board log under `userData/project-files/<id>/.nodeterm/`
  (`appDataProjectRoot`; settings still load as `'shared'`; removed with the project when it is
  deleted, kept when it moves back into its folder), whiteboards in the same root
  (`whiteboardLocationForProject`; the folder's boards, drawn before the move, are read after it and
  never written, and a move back copies the app-data boards over the folder's older files —
  `carryWhiteboards` in `prepareFolderStorage`; not the shared `userData/whiteboards`, which is
  keyed by node id, and two folders holding one committed canvas share node ids), canvas images to
  the existing `userData/canvas-images` fallback (`sideFilesFolderForProject`). `localCwdForProject` still answers
  the folder, because it means where terminals run and what a relay seat is jailed to. Moving
  between the two is the tab menu's "Store canvas in app data / in folder"
  (`lib/projectStorageMove.ts`): into app data = save, then `releaseFolderFiles` (refused until the
  data file holds the canvas; files git tracks are kept unless the user confirms); into the folder =
  `prepareFolderStorage` (refuses an occupied folder, like "Set folder…"), then save, then
  `projectStorage` (where the store has the canvas now). New folder projects follow
  `settings.newProjectStorage`; a folder that already has a project.json is adopted as it is, in its
  folder. Rules the moves rest on:
  - **The data file goes only when THIS save wrote the folder file** (`sweepRemovedDataFiles`'
    `folderFilesWritten`), never because `lastWritten` remembers one: a file can leave the folder
    behind the store's back (`git rm`, a branch checkout) while the record stays, an unchanged
    canvas then skipped the write as "unchanged", and the sweep deleted the only copy. For the same
    reason the record of a folder file is dropped when its project moves into app data (kept file
    or not) and when an entry takes a folder over from a data file ("Set folder…", a move back).
  - **A move into the folder whose folder write fails stays in app data, index included**: the
    folder leg swallows a failed write, so the save keeps that entry a folder-data-ref for that save
    (`appDataCanvas`, the one builder of its cache). The menu reads `projectStorage` after the save,
    puts the flag back and says the move failed; it never reads a landed save as a landed move.
  - The rev continues across a move (the sweep keeps it for an id that is still live).

  **Known limits:** an older build that opens a folder-data-ref while a folder `project.json` is
  still there (a tracked file the user kept) keys its watcher, its phone writer and `readLocalRef`
  on the entry's `cwd`, so until it next saves its index it can adopt that file as the project
  (after which the entry is a plain folder ref there and the data file is orphaned). Images and a
  board log stay on the side they were written on when a project moves, in either direction; so do
  a folder's whiteboard files after a move into app data (read, never removed). A board edited in
  app data replaces the folder's file on the move back, including a teammate's newer version of a
  tracked board pulled in the meantime (git still has it).
  Handoff files from Transfer still write `<node cwd>/.nodeterm/`. The iOS app does not know the
  kind: over direct SSH it reads the entry's `project` cache, which has no `cwd`, so it shows a
  project without a folder (it never reads or writes the folder file, and its board and label
  writers refuse with no write path; the relay verbs are handled here), and its repo scan finds no
  `project.json` in that folder, so it can offer the folder as a new project and write one there.
  SSH projects and Server `team bootstrap` cannot use the kind.

  In all three the file carries CONTENT and the entry carries the machine-local half — project
  `id`, `viewport`, `defaultAccountId`, `breadcrumbs`, `closedSessions`, `localApprovalId`,
  `localExec`, `localSettings` (the #510 rule). The renderer contract is untouched: `workspace.load()/save()` still
  speak an assembled v2-shaped `Workspace`; all fan-out lives in `core/workspace-store.ts` +
  pure `core/workspace-files.ts`. v2 files migrate on first save (backup `workspace.v2.bak`,
  one-time renderer note). Outside edits (git pull/sync) are detected by
  `core/workspace-watcher.ts` → silent reload, or a Reload/Keep-mine conflict bar when dirty; they
  ride `workspace:external-change`, and so do the phone's `appendRemoteNode` and the SSH
  reconcile, which really are "another device". The exception is a project a hosted Server Edition
  shares with its team: the canvas authority adopts that outside edit and publishes it as
  `canvas:mut` ops, with no `workspace:external-change`, then sends the persisted project on
  `workspace:server-change` so its non-content fields (name, permission default, capability flags…)
  reach the tabs too (see **Hosted team relay**).
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
  remounts *and* full app restarts, including running processes. See below.

**Autosave does no unchanged work** (`WorkspaceStore.save`): the parse of each `lastWritten` value is cached per raw string, and `workspace.json` is not rewritten when its bytes equal the store's last write AND the file still has the size+mtime+inode that write left — so another instance's rewrite is still answered (the inode catches a same-size rewrite on a coarse-mtime filesystem: every writer publishes by rename), a store's first save and a v2 migration always write, and every other index writer of ours clears the record.

`settings.json` is a separate store (`core/settings-store.ts`, `state/settings.ts`).

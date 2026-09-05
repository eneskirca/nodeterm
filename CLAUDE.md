# CLAUDE.md

This is the deep-reference for working in this repo: the invariants, why each exists, and the
measurements behind them. It is loaded automatically by Claude Code.

**Contributors: start with `CONTRIBUTING.md`** — the short version (setup, boundaries, house rules,
testing habits). This file is what you reach for when you need to know *why* a rule is the way it
is, or you are changing a subsystem it describes. A change that other developers must know about
belongs in BOTH (see Conventions).

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Node-based terminal manager** (BUSL-1.1, converts to MIT after 4 years — see `LICENSE`): multiple real terminals live on a single
pan/zoom canvas as draggable nodes. Target users are people with ADHD / disorganized
workflows who benefit from a spatial layout over stacked tabs. Long-term vision includes
remote access and paid features — the architecture is built so those slot in without a
UI rewrite (see Transport abstraction below).

## Platform support

macOS, Linux, and a browser Server Edition are the shipping targets; Windows is being brought up
as a first-class desktop target (extraction from external PR #276). The policy for what "supported"
means — and what you may assume when writing a feature — is three tiers, not "100% parity":

- **Core is first-class everywhere.** The terminal + agent + canvas + session-continuity
  experience must work on every desktop platform. Continuity is tmux on POSIX and, where there is
  no tmux (Windows), a standalone session-host process — the mechanism differs, the guarantee does
  not.
- **POSIX-bound edges degrade explicitly, never silently.** Some subsystems are structurally tied
  to POSIX (SSH ControlMaster, the unix-socket askpass transport, some tmux-only paths). On a
  platform where they cannot work they must either use a platform-appropriate mechanism or be
  clearly gated off — a feature that throws `EACCES`/`EPERM` on Windows because nobody checked is a
  bug, not an accepted limitation.
- **New code is platform-neutral by default.** Do not hardcode POSIX assumptions. Publish files
  through `renameAtomic`/`writeFileAtomic` (`src/core/fs-atomic.ts`), not a bare `fs.rename` — the
  guard test (`fs-atomic.guard.test.ts`) enforces this. Resolve path separators / absolute-path
  checks / file-link dialects against the filesystem-owning core's platform, not the viewer's, and
  never assume `/` or a unix socket. When a test can only run on one platform, gate it with
  `it.skipIf(process.platform === 'win32')` (or the inverse) and say why — never let it fail the
  cross-platform CI. The `windows-latest` CI job runs the platform-dependent suites on real Windows.
- **Line endings are decided by `.gitattributes` (`* text=auto eol=lf`), not by each contributor's
  git config.** Without it `text`/`eol` are unspecified and Git for Windows' default
  `core.autocrlf=true` gives every Windows clone CRLF working files — so a test that reads a
  checked-in file and slices on a `\n`-bearing literal (`CSS.indexOf('}\n}')`,
  `indexOf('\n}\n')`, `indexOf('\n}')`) matched nothing and failed on a checkout with ZERO local
  changes (issue #578). Two suites did; one reported 25 theme tokens missing that were all present,
  which reads like a regression rather than a broken slice. Attributes only apply on re-checkout
  (`git add --renormalize .` for a tree cloned earlier), so the readers ALSO normalize —
  `readFileSync(f, 'utf8').replace(/\r\n/g, '\n')` — and `src/shared/line-endings.guard.test.ts`
  fails on any such read that does not. `*.bat`/`*.cmd`/`*.ps1` are the deliberate exception and
  keep CRLF: cmd.exe is not reliably tolerant of LF, and those are the files a Windows contributor
  runs before anything else works.

## Commands

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc for both node (main/preload) and web (renderer) projects
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
```

**`rebuild` and `postinstall` both run `scripts/patch-node-pty.mjs` first, and that is not
optional.** It carries TWO version-pinned native patches for node-pty 1.1.0, one per platform leg:
- **darwin** — `pty_posix_spawn` leaks a ptmx device on every SUCCESSFUL spawn (an off-by-one in
  the low-fd cleanup) and master+slave on every FAILED one; on this app's spawn churn that
  exhausts `kern.tty.ptmx_max` within hours, and terminals then simply stop opening
  (microsoft/node-pty#950). Rewrites `node_modules/node-pty/src/unix/pty.cc`.
- **Windows** — the native exit thread deletes its `pty_baton` without closing the HPCON the baton
  owns, so the session host's taskkill-first kill path (src/session-host/host.ts) leaves a
  host-parented conhost alive for the life of the long-lived session-host process, one per killed
  session, and `conpty.kill(id)` reports nothing. The patch serializes baton access, closes the
  exact HPCON before every baton deletion, and makes `kill(id)` return `true` only as positive
  proof — the contract `src/session-host/windows-conpty.ts` was ALREADY written against (it
  shipped with #305 expecting a patched node-pty that did not exist until this patch; do not
  wire `closeExactWindowsConpty` into the ordinary kill path — after taskkill the exit thread
  usually wins the race, has already closed the HPCON itself under the patch, and the primitive
  would then report `false`; it exists for a pre-first-output teardown that bypasses the exit
  thread). Rewrites `node_modules/node-pty/src/win/conpty.cc` on every host — the file only
  compiles for the win32 native target, so patching on mac/Linux is harmless and keeps packaged
  rebuilds honest.

Both patches run before electron-rebuild compiles the module.

`src/main/node-pty-patch.test.ts` asserts both markers are present in those sources, so a node-pty
upgrade that silently drops either patch fails loudly. **If that test is red, your `node_modules`
is unpatched, not your code** — run `npm run rebuild`. It deliberately does not measure descriptors
or handles (that is environment-dependent); it checks the source the native module is built from.
Upstream: the darwin leg tracks microsoft/node-pty#950; the Windows leg has no upstream issue yet.
When a leg's fix lands upstream, delete that leg (and the whole script + test once both are gone).
```
```

`npm test` runs the vitest suite (unit + integration; the remote e2e suites skip when the
companion server repo isn't checked out). `npm run typecheck` is the fastest correctness gate.

## Process model (Electron, three contexts)

The codebase is split by Electron process boundary — keep code on the correct side:

- **`src/main/`** — Node/Electron main process. The **shell** around `src/core/`: owns
  Electron/window/IPC wiring, dialogs, and the `CorePlatform` implementation
  (`platform-electron.ts`). The renderer must never import these.
- **`src/core/`** — Electron-free service core (pty, workspace/settings stores, git,
  hook server + hooks cluster, context/subagent tails, transcripts,
  model-window, license, context-link, and the pure ssh leaves under `src/core/remote-ssh/`
  — control-master, remote-git). Talks to its shell ONLY via the `CorePlatform` interface
  (`src/core/platform.ts`); importing `electron` (or `../main/*`) inside `src/core` is
  forbidden and enforced by `src/core/no-electron.test.ts`. The Electron implementation is
  `src/main/platform-electron.ts`. This is the seam the Server Edition's `src/server/` shell
  plugs into.
- **`src/server/`** — Server Edition shell (Phase 2): plain `node:http` + `ws`
  serve the built renderer to a browser and speak a WS-RPC protocol
  (`src/shared/rpc.ts`) that a browser-side `window.nodeTerminal` shim
  (`src/renderer/bridge/`) consumes. Boots the same core services via
  `ServerPlatform` (`src/server/platform-server.ts`). Single-user auth
  (scrypt + httpOnly cookie + Origin check). `npm run server:dev` to try;
  docs/SERVER.md for details. `src/server` must not import electron or
  `src/main` (enforced by `src/server/no-electron.test.ts`). **Phase 3a** also
  serves fs/git/commit handlers (editor/diff/source-control now work in the
  browser) plus a web folder/file picker (in-app server-directory browser,
  replacing the native dialog) and WS backpressure; the renderer detects the
  bridge in `src/renderer/main.tsx` (desktop preload path is untouched).
  The picker's **folder** mode also creates directories (`createPickerFolder`,
  `renderer/bridge/dialog-picker.tsx`) — the native dialog it replaces has a New Folder
  button, so without one "Open folder…" in the browser could only ever adopt a directory
  that already existed on the server. It writes through the same `fs.mkdir`/`fs.exists`
  the Explorer's "New Folder…" uses and validates the typed name with the same envelope,
  `newEntryPath` (`renderer/lib/explorerCreate.ts`) — **do not add a second path
  validator here**; `..`, absolute and empty names are refused in exactly one place. The
  write deps are optional, so a caller with a read-only fs simply renders no button. File
  mode has none (nobody opens a file picker to make a folder). Relay tabs get the same
  button and it writes on the HOST, like every other `fs.*` the picker already uses. SSH
  projects are a separate flow (`SshProjectDialog` over `sshProject.mkdir`) and already
  had their own.
  **Phase 3b** boots the loopback **hook server** (`hookServer.start()`) + installs
  the managed hook scripts, and `wireAgentStatus` (`src/server/agent-status.ts`)
  broadcasts `agent:status` / `agent:subagent-activity` / `context:update` over the
  bridge, so agent-status badges, subagent cards, and the context meter now work in the
  browser (transcript-path jailed against forged POSTs). It also serves the two transcript READ
  channels (`registerTranscriptIpc` — the ⌘M chat view + the find-bar's transcript index; see the
  ⌘M bullet under Agent support). **Canvas control is opt-in**
  (`NODETERM_SERVER_CANVAS_CONTROL=1` / `--canvas-control`): the Server shell installs its own shim
  and runs a serialized `HeadlessNodeFactory`; disabled remains the default. (The SDK **chat node**
  — once listed here as deferred — was removed entirely, 2026-07; see the chat-node note in the
  node-kinds list.)
- **`src/preload/`** — the only bridge. `index.ts` uses `contextBridge` to expose a
  narrow API on `window.nodeTerminal` (typed in `index.d.ts`). `contextIsolation` is on,
  `nodeIntegration` off.
- **`src/renderer/`** — React UI. Talks to main *only* through `window.nodeTerminal`.
- **`src/shared/`** — types and IPC channel names imported by all three sides. `ipc.ts`
  is the single source of truth for channel strings; never hardcode a channel elsewhere.

PTY output flows main → renderer over per-session channels (`pty:data:<sessionId>`),
input flows renderer → main over `pty:write`. node-pty is kept **external** in the bundle
(`externalizeDepsPlugin` in `electron.vite.config.ts`) because it's a native module.

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

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
below), `agentId` (which agent CLI a terminal node runs —
persisted), and `accountId` (which managed Claude account a terminal node runs under — immutable,
resolved at creation, persisted; see **Managed Claude accounts**). `nodeStatesToFlow` defaults a
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
  `core/workspace-watcher.ts` → silent reload, or a Reload/Keep-mine conflict bar when dirty.
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
- **Live terminal sessions** (tmux): terminals continue where they left off across node
  remounts *and* full app restarts, including running processes. See below.

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
  the work".
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

## Terminal session continuity (tmux)

`src/core/pty-manager.ts` runs each terminal inside a persistent tmux session on a dedicated socket
(`-L node-terminal`). Ownership-sensitive local creates use a detached create-only command that
returns the tmux generation, then attach a painter client; warm opens use attach-only. Each side
recovers once if the session appears or disappears across the asynchronous probe. Other tmux paths
still use attach-or-create where no ownership proof is minted. All paths use
a generated config (`-f <userData>/tmux.conf`, so the user's `~/.tmux.conf` never
interferes; status bar off, **mouse on**, 50k history, `set-clipboard on` + `terminal-features
",*:clipboard"`, and the copy-mode mouse bindings). Because the tmux *server* outlives the app,
sessions survive when no client is attached. `src/shared/ssh.ts`'s `remoteTmuxConf` is the same
config for an SSH project's remote tmux.

**Every REMOTE tmux invocation starts with `remoteTmuxPathPrologue()`** (`shared/ssh.ts` — PATH
**append**: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `$HOME/.local/bin`): an ssh
exec channel gets a non-login shell, and on a macOS host Homebrew's `shellenv` lives in
`~/.zprofile`, so a host whose own terminal runs tmux fine answered
`zsh:1: command not found: tmux` to every command of ours (issue #449 — the same class as the
remote claude probe's login-shell + PATH fix). Append, never prepend: a PATH that already resolves
tmux keeps exactly that binary, so nothing re-pairs a long-lived tmux server with a different
client build. When tmux is genuinely absent the interactive spawn (`tmuxOrExplain`,
`control-master.ts`) prints what is missing, how to install it and what a tmux-less remote loses,
then degrades to a plain login shell — mirroring the local plain-shell fallback; the raw
`command not found` line must never be the user-facing error again.

**tmux owns the mouse — scrolling, selection, and the alternate screen are all its job.** This is
the native behavior, and it is deliberate:
- **The wheel scrolls tmux's own history** (`history-limit`), not the emulator's buffer.
- **The pane is on the alternate screen** (`\e[?1049h`) — capabilities are NOT blanked — which is
  what keeps a full-screen TUI's input box *put* instead of scrolling away with the text.
- **Selection is tmux copy-mode.** A drag copies; apps that request mouse tracking themselves
  (vim, htop) still get their own mouse events — tmux forwards those regardless.

**Do not take scrolling away from tmux again.** A previous design did exactly that (`mouse off` +
`terminal-overrides ',*:smcup@:rmcup@:indn@'` to keep tmux on the *normal* screen, so its output
flowed into xterm's scrollback, which was then hydrated from `tmux capture-pane` on reattach). It
failed structurally: **tmux is a screen PAINTER, not a stream.** Every redraw (attach, resize,
refresh) erases and repaints, so blank and duplicated rows leaked into the emulator's scrollback —
users saw black bands and duplicated screens when scrolling up — and the pane stopped behaving
natively. The hydration that design needed is gone (see the reattach seeding below).

**Copy → the system clipboard, via OSC 52.** `set-clipboard on` **plus** `set -as terminal-features
",*:clipboard"`: on copy, tmux emits OSC 52 to the attached client, and the renderer's OSC 52
handler (`parseOsc52` in `terminal/osc52.ts`, applied in `TerminalNode.tsx`) writes the system
clipboard. Two traps, both measured on
tmux 3.4:
- **The `terminal-overrides ',xterm*:Ms=…'` entry does NOT work on tmux 3.2+** — with it, a copy
  emitted **zero** OSC 52 to the client. `terminal-features` is what actually enables the sequence.
  Do not "fix" the `Ms=` override back; it is why copying from SSH sessions never worked.
- **No `pbcopy` pipe.** The copy-mode bindings are bare `copy-pipe-and-cancel` (no command): piping
  to `pbcopy` was macOS-only, and over SSH it would have copied on the *remote* host anyway. OSC 52
  is cross-platform and works over SSH.

**A tmux client is not necessarily a watcher.** `SessionInfo.clients` is a COUNT
(`#{session_attached}`), never a boolean, because one session can hold several: the app's painter,
the user's own `tmux -L node-terminal attach`, a second nodeterm on the same socket, and our own
**control-mode shadows** (`PtyManager.shadowAttach`, used for background writes without spawning a
painter). The session reaper subtracts ours via the `shadowed` seam — a shadow is a real client but
not a watcher, so a shadowed session must stay exactly as cullable as an idle detached one.

The count is carried numerically rather than collapsed at parse time **because the subtraction
needs it**: a session holding our shadow AND a real client must still read as attached, and a
boolean could only be forced to false — reaping the session out from under whoever that other
client belongs to. **Any future reader of `list-clients` / `session_attached` owes the same
subtraction.**

Lifecycle, by intent:
- **Offscreen release (in place, 2026-08-11)** → a mounted node fully offscreen past
  `settings.offscreenTerminalMinutes` detaches its PTY client and disposes its xterm without
  unmounting (plate shown; tmux keeps running; reattach-redraw on approach, measured <500 ms).
  See the Terminal node lifecycle section for the two invariants (mount-stable observer;
  `session.source` remote gate). Note the released node is a DETACHED tmux session — it joins
  the session reaper's candidate pool (6 h grace still protects it).
- **Every memory lever must ask whether the kill ends live work** (`terminal/live-work.ts`). The
  renderer reclaims terminal memory in FOUR places — park window expiry, the park's LRU cap, the
  memory-pressure drop (all three in `park-budget.ts`) and the offscreen viewer release
  (`offscreen-policy.ts`) — and all four were written as if dropping a PTY client were free,
  because "the tmux session keeps running and re-attach redraws". **That sentence is only true
  where tmux is actually underneath.** On the plain-shell fallback (no tmux installed, tmux
  switched off in settings, or an install path `findTmux` missed) the pty IS the shell, so the
  identical call kills it and everything under it — an agent CLI mid-turn included. Issue #126: a
  project switch terminated a working Claude agent, which then auto-resumed from wherever the kill
  landed. The predicate is deliberately the narrowest one that closes it — a tmux-backed session is
  never protected (the kill costs a redraw), and neither is a plain terminal, a finished agent or
  an unknown state (nothing is running to lose). **A fifth lever owes the same gate.**
  The fifth is the offscreen release of an ARMED node (`--after`, `shouldDeferReleaseForHeldLaunch`,
  2026-09-02): the held launch is delivered by session NAME, so with tmux underneath the release is
  harmless and the node stays `sessionReady` (the teardown keeps the flag for an offscreen release
  of a tmux-backed session); on the plain-shell fallback the release would destroy the very pane
  the launch is typed into, so it is deferred while armed. MEASURED before the fix: a released
  QUEUED node held its launch through its dependency going `done`, the badge claimed the terminal
  "has not started yet", and only a camera travel (revive) ever fired it — "the chain works when I
  look at it" was this.
- **Node unmount (project switch)** → the RENDERER **parks** the terminal (`TerminalNode.tsx`
  `parkedTerminals`): the xterm instance + its attached PTY stay alive with the `.xterm` element
  detached from the DOM, so a remount within `TERM_PARK_MS` (5 min) re-adopts them — instant, and
  exact (the tmux client never detaches, so mouse-tracking/alternate-screen modes and scrollback
  carry over; do NOT "optimize" this into a respawn+redraw — a fresh xterm on a reused client
  misses the attach-time mode sequences and breaks scrolling). The park timer then runs the real
  teardown: `kill()` detaches the PTY client; the tmux session keeps running. WebGL contexts are
  **viewport-scoped and budgeted** (browsers cap ~16 live contexts, and a canvas holds far more
  terminals). A per-terminal `IntersectionObserver` (`rootMargin` pre-announces approach) only
  REPORTS visibility to a **module-level budget coordinator** (`terminal/webgl-budget.ts`) that owns
  every grant decision and all timing: it keeps the contexts WE hold at/under the live budget
  (`WEBGL_BUDGET` 12 default — the browser Server Edition; on DESKTOP main raises Chromium's cap
  itself via `--max-active-webgl-contexts` = 32 and boot raises the budget to 24 via
  `setWebglBudget`, constants in `src/shared/webgl.ts`) so
  the browser never has to **force-evict** — which is the bug that flashed Chromium's dead
  "lost context" placeholder (white box + sad-face) on a visible terminal during a fast pan / zoom
  out, because the old per-node observers each acquired independently and momentarily overshot the
  cap. Rules: a client granted only after an **acquire debounce** (`WEBGL_ACQUIRE_DEBOUNCE_MS`, so a
  pan-through never grabs a context for a two-frame flash); if granting would exceed the budget,
  **reclaim on demand from the least-recently-visible HIDDEN holder** (`hiddenAt` LRU order);
  if every holder is currently visible (zoomed way out), the newcomer is NOT granted and **stays on
  the DOM renderer** — we never push past the budget. A hidden holder keeps its context
  **indefinitely** (warm for a pan-back of any length) — there is no time-based release; it is
  reclaimed strictly on demand, either by a visible newcomer that needs its slot or by
  `releaseAllHiddenGrants` (queued through the drain) under memory pressure. `acquire()`
  returning false (WebGL2 unavailable) doesn't burn a slot; an externally-lost context
  (`onContextLoss`) is reported via `handle.contextLost()`, drops from the accounting, and — for a
  still-VISIBLE client — schedules ONE delayed budget-gated re-grant (sleep/wake GPU resets lose
  every context at once with no visibility change; without this every woken terminal sat on the
  DOM renderer until panned out and back). The NODE still never re-acquires itself (that loop is
  the eviction fight the design fears): the retry goes through `tryGrant` — never exceeds the
  budget, never reclaims a visible holder — and stops after `WEBGL_LOSS_STREAK_MAX` consecutive
  losses (visibility transition resets). The node registers via `registerWebglClient` on mount
  and `handle.dispose()`s on unmount (which releases + cancels timers). A parked terminal is
  off-screen so it holds no context. Permanent-delete paths call `disposeTerminalOnUnmount(id)` so a
  deleted node disposes instead of parking.
  **A renderer released while the node is unmeasurable mismeasures its own row spacing**
  (`terminal/dom-renderer-spacing.ts`): `WebglAddon.dispose()` is also the back-to-DOM-renderer
  path, and it runs from the lifecycle effect's CLEANUP — after React detached the element — so the
  fresh DOM renderer derives `letter-spacing` from a width cache whose `offsetWidth` is **0** and
  bakes in a whole extra cell per character. That is the "letters drift apart for a split second
  after a project switch": the adopting mount paints wide until the WebGL grant lands 150 ms later.
  Focus mode's `display:none` wrapper is the same shape. xterm re-derives the spacing on a char-size
  / dpr / options change and **not on a resize**, so nothing in the reattach path heals it —
  `applyFit` calls the change-gated `resyncDomRendererSpacing(term)`, which bails while the
  measurement is still 0 rather than re-baking the wrong number.
  **Which renderer a terminal uses** is `settings.terminalGpuRendering`, resolved by the single
  resolver `resolveTerminalRenderer(value)` (`src/shared/webgl.ts`) to `dom | webgl | shared`:
  `'off'` = xterm's DOM renderer, `'on'` = one budgeted WebGL context per terminal (everything the
  paragraph above describes), `'shared'` = **glyphgrid**, ONE canvas-wide WebGL2 context every
  terminal paints into (`src/renderer/glyphgrid/`, reached through `terminal/glyphgrid-attach.ts`;
  the per-terminal budget is OFF in this mode). `'auto'` (the default, and what legacy/unknown values
  fall back to) = **`webgl` on EVERY platform**, macOS included. The macOS branch has moved twice:
  it was `dom`, then `shared` on 2026-08-05 (per-terminal WebGL composited terminals black after
  zoom-out bursts, blamed on the OS compositor), and is now `webgl` — the blackout was root-caused
  not to context count but to a dependency skew (addon-webgl 0.19's dispose crashed on the 5.5 core
  and aborted its own DOM-renderer restore; pinned + healed, see
  `renderer/terminal/webgl-addon-pair.test.ts`). What actually guards macOS is a lower budget,
  `WEBGL_BUDGET_DESKTOP_MAC` (16, vs 24 elsewhere), capping compositor pressure at every zoom. The
  four-way setting stays as the escape hatch: `'shared'` is now opt-in only (also where the macOS
  default points back if the one unconfirmed 2026-07-30 whole-window-flicker report recurs), and
  `'off'` drops GPU rendering entirely.
- **Window close / app quit** → clients detach (`PtyManager.killAll()`); the tmux session keeps
  running. `killAll()` deliberately does NOT kill sessions.
- **Node reopen / app relaunch** (nothing parked) → a new PTY attaches to the same
  `nt-<nodeId>` session and tmux redraws current state.
- **User clicks ×** → `destroy(persistKey)` runs `tmux kill-session`, permanently ending it. For a
  REMOTE node it kills the remote session **and then the local one of the same name** — normally a
  no-op, but it reaps the orphan the pre-`requireRemote` local fallback below could leave behind.
- **A remote node is NEVER spawned locally** (`PtyCreateOptions.requireRemote`). `sshRemote` says
  "here is the master to run over"; `requireRemote` says "and if there isn't one, spawn NOTHING".
  Without it, a create with no `sshRemote` falls through to core's local tmux/plain-shell branches
  — which is how an SSH project's terminal opened while the ControlMaster was down (no network,
  host unreachable, `ssh` missing) quietly became a LOCAL shell in the local `$HOME`: same node id,
  same `SSH user@host` header chip, the REMOTE session's scrollback snapshot replayed into it, and
  — for an agent node — a cold-restore `claude --resume <remote session id>` running on the wrong
  machine under the local account, leaving an orphaned local `nt-<id>` behind. Refused on both
  sides: the renderer never calls `create` when `resolveSshRemote` came back empty
  (`CoState.offline` + the node's Reconnect button), and core refuses in `spawnNew`
  (`PtyCreateResult.unavailable`) so a master that dies inside the round-trip can't sneak through.
  The refusal is **only** in `spawnNew` — a co-attach JOIN to a live session for that node id is
  still correct. An offline node reports itself to `SshReconnector`, so the canvas heals itself;
  `retryNow` (banner Reconnect / node Reconnect) skips the backoff and clears the refuse window.
- **"Restart agent (resume)"** → deliberately NOT a session lifecycle event: `terminal/
  agent-restart.ts` restarts the agent CLI *inside* the pane and leaves the PTY, the tmux session
  and its scrollback untouched. It exists for **new-model pickup** — a freshly released model only
  shows up in a CLI's model list on a fresh launch, and doing that by hand means closing and
  re-resuming every agent node on the canvas. Choreography: write the CLI's own exit line (`/exit`
  for claude, `/quit` for codex — that table is also the gate, an agent not in it can never be
  restarted in place), poll `pty:pane-command` (`#{pane_current_command}`, local tmux socket or the
  project's SSH ControlMaster; any failure reads as "not a shell yet") every `RESTART_POLL_MS`
  (250 ms) until a SHELL owns the pane, then echo-deliver `resumeCommand(...)` — the same
  `claude --resume` / `codex resume` the cold restore uses. **Nothing is ever killed**: if the CLI
  has not quit within `RESTART_EXIT_TIMEOUT_MS` (6 s) the run reports `exit-timeout` and leaves the
  session running. A `working` **or `blocked`** session is refused — `/exit` typed into a
  permission prompt would ANSWER it, not quit — and a node is held one-restart-at-a-time until the
  resume line has actually LEFT the pane (an un-submitted line is where a second `/exit` would be
  spliced in). The bulk action runs the same per-node closure sequentially over every idle agent
  node in canvas order and reports one summary line. `performRestartResume` is now a COMPOSITION of
  `performExitPhase` + `performResumePhase` (2026-08-12, behavior-pinned split) — hibernation
  drives the halves separately; each half refuses independently.
- **Agent hibernation ("Eco", 2026-08-12, OPT-IN default off)** → `settings.agentHibernationEnabled`
  (+ `agentHibernationIdleMinutes`, default 30; Settings → Agents): a 60 s renderer sweep
  (`Canvas`) exits the CLI of up to **2** agent nodes per pass that are hook-idle in state `done`,
  fully offscreen (`isNodeWatched` — an open kanban card modal counts as watched), local, idle ≥
  window, non-recurring, without live subagents (`planHibernation` +
  `lib/hibernationCandidates.ts`, both pure/tested). tmux + shell survive; node shows a clickable
  SLEEPING chip; wake (view / chip / modal open) verifies a SHELL owns the pane
  (`isShellCommand` OR the persisted `hibernatedPane` the exit settled on — nu/pwsh users) before
  the KILL_LINE'd, echo-verified `withPermissionMode(resumeCommand(...))`. Sweep/wake/menu-restart
  share ONE `guardConcurrentRestart` set. Load-bearing rules a refactor must not undo:
  (1) **recurring fact is durable** — both loop-card dismiss surfaces route through
  `lib/loopCard.ts`, which HIDES a cron/schedule card but retains `agentStatus.loop`
  (`dismissed: true`); clearing it would let Eco `/exit` a CLI whose cron wakeup lives in that
  process. (2) **Fire-time re-asks**: still-offscreen, remote, eligibility — a plan-time verdict
  is stale by seconds. (3) `hibernated` **self-heals** on live hook states + SessionStart (never
  on `done` — a late Stop POST must not undo a just-performed hibernate); cold restore (`fresh`)
  clears `hibernated` UNCONDITIONALLY and normally lets auto-resume own the node — **`paused` (see
  below) is what makes that auto-resume itself conditional**, the one deliberate exception: the
  flag it gates is still cleared, only the relaunch is skipped. (4) **Ordering with offscreen
  release**:
  Eco defers the Phase-2 viewer release until the node hibernates (hard cap idle+offscreen), but
  ONLY when the idle clock is known (`idleKnown` — `lastEventAt` is transient, so after an app
  restart nothing can hibernate and deferring would make Eco a memory regression). Eco is
  structurally inert for sessions with no turn in the current app run — documented follow-up.
  The deferral is also unaware of `paused`: a deep-paused node's freshly recycled shell keeps its
  xterm alive until the hard cap, waiting for a hibernation that (being already exited, or having
  no CLI to exit) can never come — a second documented follow-up.
  Device checklist (8 items) in PR #130 — owed before recommending Eco to anyone.
- **"Pause session"** (manual, or via Eco when `settings.agentHibernationPersistAcrossRestart` is
  on) → `agentStatus.paused`, a persisted flag alongside `hibernated` with ONE job: stop a node
  from coming back on its own. Two depths, chosen per node: shallow — identical to an Eco exit
  (`registerAgentPause`'s `pause` closure reuses `performExitPhase`), plus `paused` — or "pause &
  end session" — the same recycle `restartAgentNode(…, restartShell: true)` uses
  (`transport.recycle` + a `respawnNonce` bump), so the node comes back `fresh` next time, with no
  live tmux session to hold memory. Two pure predicates in `terminal/hibernation-policy.ts` pin the
  contract: `shouldColdResume` (a `fresh` mount must not auto-relaunch a paused node — see Cold
  restore above) and `shouldAutoWake` (the mount-timer, visibility-edge, and kanban-card-modal-open
  auto-wake triggers must not fire for a paused node, hibernated or not — only an explicit Resume,
  which reuses the SAME `wakeHibernatedNode` trigger the SLEEPING/PAUSED chip's click uses, so it
  gets the same `WakeInputBuffer` splice protection and retry budget). Pausing an already-hibernated
  node skips the exit phase entirely (`alreadyExited` in the closure) — asking an idle CLI-less
  shell to quit would type `/exit` into it as a real command. `paused` is ALSO excluded from Eco's
  own candidate plan and its exit closure's fire-time re-ask (`HibernationCandidate.paused`,
  `hibernationCandidates.ts`) — a deep-paused node has `hibernated` unset (its tmux was recycled,
  not exited), so `!hibernated` alone would still admit it to a sweep whose dropped SessionEnd hook
  POST left a stale `done` behind: the same `/exit`-into-a-bare-shell mistake `alreadyExited` closes
  on the manual path, closed here on the automatic one. Node menu only today (canvas right-click +
  the sessions sidebar row menu, which shares the same `selectionItems` builder, plus a read-only
  kanban card badge and a clickable one in the card modal); no command palette entry.

The node id is the `persistKey` (passed to `transport.create`), so it must stay stable.
If tmux is unavailable, `PtyManager` falls back to a plain shell (no cross-restart
continuity). `findTmux()` resolves an absolute path because GUI apps don't inherit the
shell PATH, and it tries three sources **in this order: fixed system paths → the shell's
PATH → the tmux the macOS app SHIPS** (`bundledTmuxPath`). System first is deliberate — a
machine that already has tmux keeps using its own, so the bundled copy is a floor, never an
override. `resourcesPath` is `undefined` on the **Server Edition**, so the bundled binary is
unreachable there by construction; a Linux host is expected to have its own. Under
`electron-vite dev` the last candidate resolves against `process.cwd()`, which is where
`scripts/build-tmux.mjs` writes its artifact. If tmux is unavailable from all three,
`PtyManager` still falls back to a plain shell; `TMUX`/`TMUX_PANE` are stripped from the child env to avoid nesting refusal.

### Cold restore (machine reboot)

tmux only survives an **app** restart — a **machine reboot kills the tmux server**, so every
`nt-<nodeId>` session is gone. To bridge that, `create()` returns `PtyCreateResult` with a
`fresh` flag: it runs `tmux has-session` *before* spawning, so `fresh=false` means a warm
reattach (tmux redraws) and `fresh=true` means a cold start (first open OR post-reboot). On a
cold start the renderer (`TerminalNode.tsx`) reconstructs state instead of relying on the dead
session (you can't keep a live OS process across a reboot):
- **Scrollback replay** — `core/scrollback-store.ts` keeps a byte-capped (`256 KB`) snapshot of
  each tmux session's recent output under `<userData>/terminal-scrollback/`, refreshed on a
  timer (`SCROLLBACK_SNAPSHOT_MS`) + on detach/quit (`tmux capture-pane -e`). On a cold start the
  renderer reads it via `pty.readScrollback` and writes it back into xterm (with a "session
  restored" separator). Warm reattach skips it (tmux already redraws). Deleted with the node in
  `destroySession`.
- **Agent resume** — on a cold start of a node whose `agentId` is in `RESUMABLE_AGENTS`, the
  renderer re-launches the agent CLI: `resumeCommand(agentId, sessionId)` (from the session id
  persisted in `agentStatus` localStorage — `claude --resume`, `codex resume`, `gemini
  --resume`) when known, else the bare `launchCmd`. The one-shot `data.initialCommand` still wins
  on the very first open, so the agent is never double-launched. **The one exception: a `paused`
  node** (see "Pause session" below) skips this auto-relaunch — that is the entire point of the
  flag — and instead records the pane its fresh shell settled on (`agentStatus.hibernatedPane`),
  so a later explicit Resume can recognize it even for a default shell outside the wake's
  `isShellCommand` allowlist.

### We have our own VT emulator — check it before asking tmux

xterm.js is not just a renderer. It parses the pane's output stream, so it **tracks DECSET modes
itself** and exposes them as public API (`term.modes`, `@xterm/xterm/typings/xterm.d.ts:1865`) —
bracketed paste, application-cursor, mouse tracking, origin mode, and the rest. We already read one
of them: `term.modes.mouseTrackingMode` decides whether a click means "follow this file link"
(`src/renderer/terminal/file-links.ts:341`).

We once did the opposite. `PtyManager.bracketPasteRequested` (now **deleted** — see the tombstone
in `pty-manager.ts`) asked **tmux** for the same class of fact, via `#{bracket_paste_flag}` — and
that format **first shipped in tmux 3.7** (2026-06-26). Ubuntu 24.04 LTS ships 3.4, Ubuntu 22.04 →
3.2a, Debian 12/13 → 3.3a/3.5a, Ubuntu 26.04 → 3.6a. On all of those it expanded to `''` exactly
like a bogus name, and the comparison against `'1'` answered **false for every pane**. The bundled
tmux did not rescue it: `extraResources` places it under `"mac"` only, and `bundledTmuxPath` is
deliberately the **last** candidate (see the comment at `pty-manager.ts:245-250` — preferring our
binary would pair a new client with the user's older running *server*, which upstream refuses). On
an **SSH project it was unfixable from our side entirely**: the remote's tmux is whatever the
user's server has.

**The rule this is an instance of: before asking tmux, ssh or `ps` something about a pane, check
whether the emulator already knows it.** Facts about *what the app in the pane is doing* (VT modes,
the alternate screen, the cursor shape it asked for) arrive as bytes we already parse. Facts about
*the session* (does it exist, what is the foreground process group, which panes are in it) are
genuinely tmux's and must be asked. Mixing the two up is how a feature acquires a dependency on a
tmux version we do not control. herdr has no version problem here for exactly this reason — it
reads `mode_get(MODE_BRACKETED_PASTE)` from its own state machine.

**Measured, and the emulator is NOT the answer here.** The `?2004h` a tmux *client* receives is
tmux's own paste-through on the outer terminal (`tty_start_tty`, gated on the outer terminfo
`BE`/`BD`), not the pane app's request: it arrives ~5 ms after attach and reads `true` even for a
pane running `sleep 30`. It never toggled across pane switches, window switches, re-attach or
co-attach. A constant is not a signal — so `term.modes.bracketedPasteMode` cannot stand in for the
pane's state, however tempting the symmetry with `mouseTrackingMode` looks.

**The actual fix is older than the problem: `paste-buffer -p`.** From tmux's own man page — *"If
`-p` is specified, paste bracket control codes are inserted around the buffer **if the application
has requested bracketed paste mode**."* Introduced 2012-03-03, shipped in **tmux 1.7**, so it is
present on every tmux in the field. We do not have to ask whether the app wants framing; we ask
tmux to do the framing, and it applies the pane's real state. Measured on 3.4: framed when the app
requested it, unframed when it did not, correct for a non-active pane, and the whole thing in one
round trip —
`tmux load-buffer -b nt - \; if-shell -F -t <target> '#{pane_in_mode}' 'send-keys -t <target> -X
cancel' \; paste-buffer -d -p -r -b nt -t <target> \; send-keys -t <target> Enter` (`-r` keeps
`\n` as `\n` instead of tmux's default `\n`→`\r` rewrite; see `tmux-naming.ts`).

Two hazards that come with it, both measured:
- **Copy mode silently unframes.** With `#{pane_in_mode}` = 1, `paste-buffer -p` delivers unframed
  (tmux checks the copy-mode screen, not the app), so a user who scrolled the wheel up gets the
  one-turn-per-line bug. The `if-shell` guard above runs `send-keys -X cancel` first — only when the
  pane is in copy mode — in the same invocation, restoring it.
- **`set-buffer -- "$text"` hits ARG_MAX** around 200 KB. Use `load-buffer -` over stdin — and on
  the SSH path that means piping into the remote command rather than putting the text in argv.

There is no longer a probe or a fallback to weigh: `sendText` delivers through `paste-buffer -p`
**unconditionally** (the plan builders live in `tmux-naming.ts`). The old two-step path — probe
`#{bracket_paste_flag}`, and on a false answer deliver `line1\nline2\nline3\r`, raw newlines into
the app that *mangled* every multi-line write on a pre-3.7 tmux — is gone with the probe.

### Seeding a fresh xterm (`attachReplay` / `seedPaint` in `terminal/terminal-config.ts`)

A newly mounted xterm is empty. Since tmux paints its own client, there is usually **nothing to
seed** — the cases are:
- **`none`** — the terminal was **parked** (its buffer is still live and correct), or it is a
  brand-new node with an `initialCommand`. Seeding either would duplicate content.
- **`cold-snapshot`** (`fresh` — reboot/first open) — the tmux session is genuinely gone, so replay
  the persisted `scrollback-store` snapshot, with a "session restored" separator.
- **`warm-attach`** (`!fresh` — app restart, tmux still alive) — **seed nothing.** tmux is attached
  to this client: it redraws the visible screen and owns the history under the wheel. This is where
  a `warm-history` hydration (`transport.captureHistory` → `tmux capture-pane`) used to run; it was
  **removed**, because writing into a buffer that tmux then repaints is what produced the black
  bands and duplicated screens. The single exception is a **co-attach joiner** (`seedPaint` →
  `create-screen`): tmux only repaints on SIGWINCH, so a joiner that did not resize never gets a
  redraw, and the screen captured server-side inside `create()` (`PtyCreateResult.screen`) is the
  only thing that paints it — see docs/team-presence.md. **A co-attach joiner also misses tmux's
  MOUSE-TRACKING modes** (`?1000h/?1002h/?1006h`): tmux emits them only at its OWN attach, and
  neither the `screen` capture (`capture-pane` carries no private modes) nor a SIGWINCH redraw
  re-sends them — so the joiner's wheel can't scroll tmux history until a keystroke makes the app
  re-request mouse. `join()` therefore sets `PtyCreateResult.coAttachMouse` for tmux-backed joins
  (gated on `persistKey`, on BOTH the screen and resize branches) and the renderer writes
  `CO_ATTACH_MOUSE_SEQ` into the fresh xterm (both `ModalTerminal` and `TerminalNode`). tmux is
  always `mouse on`, so this matches its invariant client state; the enable is idempotent. Was the
  "can't scroll the kanban card-modal terminal until you press a key" bug.

xterm's own `scrollback` (`xtermScrollback(settings.tmuxScrollback)`, floored at 1000, capped at
`XTERM_SCROLLBACK_MAX` = 10000) is kept for the sessions tmux does *not* back (a plain shell when
tmux is unavailable) and for the cold-snapshot replay — it is not what the user scrolls in a tmux
session.

## Terminal node lifecycle (gotchas)

`src/renderer/nodes/TerminalNode.tsx` is the trickiest file:

- The xterm instance + PTY session are created once in a `useEffect(…, [data.respawnNonce,
  offscreenEpoch])` and torn down on unmount. The component persists across re-renders because
  React Flow keys nodes by `id` — never change a node's id, or you'll respawn its terminal.
  **Third in-place state — "released" (2026-08-11, offscreen dispose):** a node fully offscreen
  in the canvas viewport for `settings.offscreenTerminalMinutes` (default 10, `0` = never;
  Settings → tmux) has its xterm + PTY client torn down IN PLACE — node stays mounted showing a
  plate, tmux session untouched — and revives (warm reattach) when it re-approaches the viewport.
  Pure policy: `terminal/offscreen-policy.ts`. Two load-bearing rules a refactor must not undo:
  (1) the **visibility IntersectionObserver lives in its own mount-stable `[termKey]` effect**,
  NOT the lifecycle effect — the down transition re-runs the lifecycle effect, and an observer
  owned there dies with it, making revive unreachable (permanent plate; caught in review). The
  lifecycle run publishes to it through refs (`visibilityReportRef`, `offscreenLiveRef`,
  identity-checked on clear). (2) The remote exclusion asks `offscreenCoreIsRemote(session.source)`
  (`'local'` only is eligible — relay/server tabs excluded), NOT `data.remote`, **a field nothing
  sets on node data** (a gate on it was constant false and type-invisible; pinned by tests).
  SSH-project nodes are also excluded; collapsed = hidden (same convention as the WebGL budget);
  a `respawnNonce` bump while released revives first. Agent-status/fan-out clears live in a
  dedicated unmount-only effect (a release or respawn must not blank a live badge).
- **React StrictMode is deliberately not used** (`main.tsx`) — double-mount would spawn
  two PTYs per node.
- The xterm container is `nodrag nowheel`; a transparent **hover-guard** overlay sits on top
  until you dwell `settings.panHoverDelay` (so quick drag = move node, scroll = pan). After
  the dwell the guard is removed and xterm takes input. The header stays draggable.
- A `ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS
  transform, so it does *not* change `clientWidth` — cols/rows stay stable across zoom.
  `scale-fix.ts` patches xterm's mouse coords so text selection stays aligned when zoomed.

## Node kinds (all rendered by React Flow custom nodes)

- **terminal** (`TerminalNode.tsx`) — xterm + tmux (see above). Header: collapse, color,
  click-to-rename title, ✦ AI-name, ×. Body has a **hover guard** overlay: dwell
  `settings.panHoverDelay` (default 600 ms) before the terminal takes focus — before that,
  drag = move node, scroll = pan canvas. **Cmd/Ctrl+M** (while hovered) toggles a markdown
  render of the captured output. Tag chips via `NodeTags`.
  **Selection + copy is tmux's** (its mouse is on — see the tmux section): drag to select, wheel to
  scroll tmux's history. A drag copies via copy-mode, and tmux emits **OSC 52** to the client, whose
  handler writes the **system clipboard** — the one copy path on every platform *and* over SSH (no
  `pbcopy`). OSC 52 writes an app emits itself (vim `"+y`, gh, yazi) reach the clipboard through the
  same handler (write-only — a read query is refused). The emulator's own copy chords stay for a
  selection xterm *does* own (`copyKeyAction`/`isCopyShortcut`): **Cmd+C** (mac), **Ctrl+Shift+C**
  and **Ctrl+Insert** (Linux/Windows) — matched on `e.key` *or* the physical `KeyC`, so non-Latin
  layouts still copy. A copy chord is **always swallowed**, selection or not: letting Ctrl+Shift+C
  fall through would reach the pty as `\x03` (SIGINT). Ctrl+Insert exists because Chromium reserves
  Ctrl+Shift+C for the inspector and a page cannot `preventDefault()` it — which is where Server
  Edition users land. Plain **Ctrl+C** is never intercepted.
  **PASTE is the platform's, never ours** (`isPasteShortcut` → the `'native'` action): we own no
  paste path — ⌘V on mac reaches the Edit menu's `{role:'paste'}`, whose `paste` event xterm frames
  as a bracketed paste. All the terminal does is stop CANCELLING the chord, and that is a
  **Windows-only** claim: xterm's keymap turns Ctrl+V into `\x16` with `cancel`, which suppressed
  Chromium's paste command *and* the Ctrl+V accelerator behind it, so Ctrl+V pasted nothing at all
  there (issue #562). Off Windows the chord stays `\x16` on purpose — mac pastes with ⌘V, Linux
  with Ctrl+Shift+V, and Ctrl+V is a key vim/readline users really send. Ctrl+Shift+V and
  Shift+Insert need no branch: measured against `evaluateKeyboardEvent`, xterm produces neither a
  key nor a cancel for them, so the platform already pastes. To select in **xterm** instead of tmux
  (or inside an app that grabs the mouse, like vim/htop), hold **Option** (mac —
  xterm's `macOptionClickForcesSelection`) or **Shift** (Linux/Windows) while dragging.
  **Copying now says so**: the OSC 52 handler floats a transient `Copied N lines` pill over the
  terminal's BOTTOM-RIGHT corner (`.term-copy-pill`, the same class on the canvas node and the
  kanban card modal — one session seen twice must not speak in two voices; bottom-right because
  every agent CLI writes its input line bottom-left, and `pointer-events: none` because it sits on
  the terminal and fires on every copy), because tmux's `copy-pipe-and-cancel`
  clears the highlight at the exact instant it copies — which read as "the copy failed" to a user
  whose other pane ran claude. And a drag that produced NEITHER an OSC 52 nor an xterm selection
  means the pane's app captured the mouse (claude does, codex does not), so a one-time
  `Hold ⌥ to select text` hint fires instead (`nodeterm.seenSelectHint`). **The whole layer is
  OFF for an agent in `SELF_REPORTS_COPY` (`reportsOwnCopy` — claude, which prints its own
  "copied N chars to tmux buffer" line): a second message for one gesture is noise, and a claude
  terminal is byte-identical to before the feature. **One owner per pill:**
  the `copied` receipt is raised ONLY by the OSC 52 path, the hint ONLY by the drag path — the two
  never race for the same slot. The emulator's own copy **chord** (Cmd+C / Ctrl+Shift+C) deliberately
  raises nothing: Claude Code prints its own copy line ("copied N chars to tmux buffer"), and a
  second message for one gesture is noise. Decision logic is the pure `terminal/copy-feedback.ts`;
  `useCopyFeedback` is the glue (it also yields to a clipboard-failure `nodeterm:toast`, so the
  Server Edition never shows a green receipt beside a red banner), and the node publishes its sink
  through the module-level `copySubs` map because the OSC handler survives a park.
  **Shift+Enter** is remapped to `\x1b\r` (ESC+CR / M-Enter) so agent CLIs insert a newline
  instead of submitting (`terminalKeyAction` / `SHIFT_ENTER_SEQ` in `terminal-config.ts`; sent in
  all terminals — harmless in a plain shell). **Cmd (mac) / Ctrl+click** opens links in the
  output: URLs → default browser (`@xterm/addon-web-links`), file paths → editor node and
  directories → Explorer reveal (`terminal/file-links.ts`, existence-verified against the project
  fs via cached parent-dir listings, with `path:line[:col]` compiler-output suffixes). The path
  dialect follows the FILESYSTEM-OWNING CORE, not the viewer: desktop-local may use its own
  platform, Server Edition and relay tabs use the core's reported `process.platform`, and SSH
  projects are POSIX. A failed host-platform read disables file links for that connection — it
  never guesses from the browser. Standalone `ssh` terminal nodes remain URL-only because they
  have no remote fs API with which to verify a token; relay tabs do have a core-bound, jailed fs
  API and therefore support file links. Windows existence matching is case-insensitive and accepts
  both separators; UNC tokens are refused whole before they can be reinterpreted as cwd-relative.
- **Agent** (`createAgentNode(agentId, …)`) — a terminal preset that runs an agent CLI as its
  `initialCommand` (runs once on open via `transport.write`, then cleared), with `data.agentId`
  set. Builtins (`claude`/`codex`/`gemini`) come from `AGENT_CONFIG` (clay color etc.).
  Agent nodes get extra behavior **gated by the
  agent's capabilities** (see **Agent support** below): a busy/working badge + unread dot +
  completion notification + session-name chip (hook-capable agents), content search, and the
  Claude-only **Branch conversation** action. Custom user-defined agents spawn + show
  process/terminal-title status only.
- **sticky** (`StickyNode.tsx`) — colored note, free text, collapsible. Has link handles:
  connect a sticky to any terminal node to attach the note as context (see Context Link).
- **group** (`GroupNode.tsx`) — real React Flow parent/child frame, and frames **nest** (2026-08):
  a group may contain other groups to any depth. `groupSelectedNodes` wraps objects that share ONE
  container — frames included — creating the wrapper inside that container; a mixed-container set,
  or an ancestor selected together with its own descendant, is **refused** rather than scrambled
  (positions are only comparable within one container, and the descendant would be torn out of the
  ancestor being wrapped). Box-selection routinely catches both, so structural actions normalize
  the selection to its subtree roots first (`selectedRootIds`). `ungroupNodes` promotes a frame's
  direct children into **its own parent** (not to the root — that would move them by the whole
  ancestor offset); `reparentNode` moves a node OR a whole frame subtree, keeps its **root-space**
  position fixed (`rootPosition`, not the old add-one-parent's-origin math) and refuses a cycle;
  `addSelectionToGroup` adds a selection to an existing frame; `reorderGroupWithinParent` reorders
  a frame among its siblings, carrying its subtree. `nodeStatesToFlow`/`groupsFirst` emit frames
  **depth-first from the root** — a flat "groups first" sort is not enough once two groups compare
  equal — and that persisted order is also the downgrade contract (a pre-nesting build's stable
  sort leaves it alone, so a nested tree still hydrates parent-first and renders there).
  **A frame that gains a child bigger than itself is re-fitted, ancestors included**
  (`fitGroupToChildren` up the chain): a wrapper created at `(minX-28, minY-62)` relative to its
  parent is routinely negative, and `extent:'parent'` would make React Flow clamp it into an
  inverted range — snapping the frame hundreds of px away and dragging the whole wrapped subtree
  with it. Visually: a dashed rounded frame in the group color with a floating label pill (color
  dot + editable name) on the top border and ungroup/× top-right (on hover/selected). **The pill
  is the frame's `dragHandle`** and the frame body is `pointer-events: none` — a frame is a
  background container, not a giant drag target, so its body passes clicks to the pane and an
  outer frame cannot swallow the clicks meant for a frame drawn inside it. The
  `NodeResizer` line is hidden (`lineStyle` transparent) so it can't draw a sharp-cornered
  box; the selection ring is a `box-shadow` instead, which follows the same `border-radius`.
- **editor** (`EditorNode.tsx`) — Monaco code editor for a `filePath`; reads/writes via
  `fs:read`/`fs:write`, auto-detects language from the path, ⌘S saves, dirty dot. A
  **Preview / Edit** toggle (or ⌘M while hovered) renders the live content as markdown.
  **Image files** (png/jpg/gif/webp/bmp/ico/svg/avif) skip Monaco and show an `<img>`
  preview instead — read as base64 via `fs:read-binary` into a `data:` URL (CSP allows
  `img-src data:`), on a checkerboard backdrop with the pixel dimensions in the header.
- **diff** (`DiffNode.tsx`) — Monaco diff editor; `diffStaged` chooses HEAD↔index (staged)
  vs index↔working (unstaged) via `git:show-file` + `fs:read`. Read-only.
- **video** (`VideoNode.tsx`) — a video player; a local file is served over the `nt-media://`
  protocol (allowlisted on mount via `media.allow`) with native controls; an SSH-project file
  (`data.sshFs`) is first pulled into the local media cache over the project's ControlMaster
  (`media.allowSsh`) then played the same way.
- **web** (`WebNode.tsx`) — an Electron `<webview>` (locked down, no `nodeintegration`) that loads
  a live `data.url`, or serves local html at `data.filePath` over `nt-media://`.
- **browser** (`BrowserNode.tsx`) — a navigable Chromium browser wrapping the shared
  `BrowserSurface` (webview + toolbar); the last top-level URL persists to `data.url`, and the same
  surface backs the kanban card modal's browser popup.
- **files** (`FilesNode.tsx`) — a file-manager node: ONE directory listing (`data.cwd`, persisted),
  pinned to the canvas beside the terminals working in it. Deliberately not a second Explorer: the
  drawer is a single tree rooted at the project cwd that covers the canvas, so it gives you one
  cursor and a lot of scrolling; several of these give you `src/renderer/nodes` next to the agent
  editing it and another on `docs/`. Navigate in place (breadcrumbs collapse deep paths but every
  crumb stays clickable), filter, create a file/folder, copy a path, reveal, and open a terminal in
  the folder shown (a `nodeterm:open-terminal` event, the sibling of `nodeterm:open-file`).
  - **It adds NO new IPC.** Everything runs on the existing `FsApi` (`list`/`mkdir`/`exists`/
    `write`) — which is why it works on Desktop, the Server Edition, an SSH project and a relay tab
    on day one; `mkdir`/`exists` are genuinely LIVE on a relay tab (see the Explorer bullet above —
    that line used to claim otherwise), so "New folder…" works there too. **Rename/move/delete are
    the deliberate v1 gap**: each needs a new leaf in `core/fs-ops`, an IPC channel, preload, the
    ws-bridge, `main/ssh-fs` (remote quoting) and the relay host-service, plus confirm dialogs and
    dangerous-path guards. That is a separate change with separate risk, not a corner to cut inside
    this one.
  - **Which filesystem** is `EditorNode`'s decision, read the same way: `data.sshFs` → the SSH
    project's host over the ControlMaster; otherwise the node's own SESSION api, which is the local
    core for a local project and the PEER's for a relay tab. Reading it off `useSession()` rather
    than `window.nodeTerminal` is the entire reason a relay tab browses the right machine.
  - **Opening is delegated, never reimplemented**: a file dispatches `nodeterm:open-file`, so
    editor-vs-video-vs-image routing stays in Canvas's one `openFile` and this node never grows a
    second opinion about what a `.png` is. `fileOpenTarget` decides only canvas-vs-OS, and a REMOTE
    listing never reaches the OS branch — `shell.openPath` opens a path on THIS machine. **The OS
    branch is now also gated on being ABLE to open locally**, not just on remoteness: `shell.openPath`
    is a documented `noop` in the Server Edition (`bridge/stubs.ts:180-186`), and a browser tab's own
    session `source` is `'local'` — `SessionSource` declares `'server'` but nothing ever constructs
    it (`session/session.ts:8`), so `source` alone can never tell you you're in a browser, only
    `isBrowserRuntime()` can. Opening a `.zip`/`.dmg` was therefore a silent dead click; closed by
    `canUseLocalShell` (`lib/download.ts`) — ONE predicate for every `shell.*` path action, with
    `canRevealLocally` kept as its older reveal-specific name so existing callers are untouched.
    Reveal was gated and openPath was not, and writing that rule twice is how they drifted.
  - **Two state bugs, both fixed.** (a) A directory a removed worktree took with it used to render
    as "This folder is empty." — not "Could not read this folder" — because `FsApi.list` is
    fail-open by contract (`core/fs-ops.listDir`/`SshFs.listDir` both end `catch { return [] }`, and
    the SSH IPC resolves `[]` even for a dead ControlMaster). `fs.exists` cannot disambiguate either:
    it's `stat`-based (true for a dir you can stat but not `readdir`), and on SSH its `false` can't
    separate "gone" from "the ControlMaster died" — the same conflation `SshFs.readTextChecked`
    (`main/ssh-fs.ts:164-176`) refuses, on the rule "a failed read is never evidence of absence". Now
    disambiguated by probing the PARENT's listing instead (`classifyEmptyListing`, pure,
    `lib/filesNode.ts` — the idiom `SshProjectDialog.tsx:112-125` and `file-links.ts`'s
    `makeDirListingLookup` already use), which answers `missing` / `empty` / `unreachable` /
    `unknown`. The parent CONTAINS the directory we are standing in, so it cannot legitimately be
    childless: an empty parent listing means we could not see it, which is `unreachable` and gets
    its own sentence naming both possible causes. That case used to answer `unknown` and render as
    "This folder is empty." over a dead ControlMaster, the commonest cause of an empty remote
    listing and the most reassuring possible lie. **`unknown` is reserved for the paths whose parent CANNOT answer** — a non-`/`-absolute cwd
    (an SSH project's `remoteCwd` defaults to **`~`**, where `parentDir` is `/` and `/` has no entry
    named `~`, so an empty remote HOME reported a deletion), a `.git` cwd (both listing legs strip
    it on purpose), and `.`/`..` segments; a case-folded match counts as present, for the
    case-insensitive filesystems where `readdir` answers with the on-disk spelling. `missing` must
    be the conclusion we are SURE of. Nothing is published until the verdict is in, so a deleted
    folder never flashes "empty" on its way to the error.
    (b) Nothing reset the list on navigation, so "Loading…" was reachable only on the very first
    mount — every later directory change showed the PREVIOUS directory's rows. Fixed by storing the
    listing WITH the cwd it belongs to, so a cwd change IS the loading state by construction; a
    re-list after a create deliberately keeps its rows (same directory, re-read).
  - The title tracks the folder only while `titleAuto` is unset — the same contract an agent node's
    session name uses, so navigating never overwrites a name the user typed.
  - A files node inside a REMOVED worktree is displaced like an editor, not like a terminal
    (`displacedByWorktree`): it has no session to disturb, so it is caught by path wherever it sits.
    The patch is the pure `displacedFilesPatch` (`lib/filesNode.ts`), where `null` means LEAVE IT
    ALONE on the dead path — the parent probe above then tells the truth — because
    `resetDisplacedCwd`'s fallback can be `undefined`, and writing that through would
    have cost the node the only thing it knows about itself. **The READ side is guarded too**: a
    files node with no `cwd` says so instead of falling back to `'/'` — `project.json` is
    git-shared, hand-editable input that nothing validates for this kind, so guarding only the
    writer left the silent root-browse reachable anyway. And `createFilesNode` places through
    `placeNode`, not `placeAt`, so snap-to-grid applies to its size as well as its position (React
    Flow resizes by adding a grid multiple to the START size, so an unsnapped box never lands on
    the grid later). The title
    rewrites alongside when `titleAuto` holds — the ONE cwd write that does not go through `navigate`.
  - **"New terminal here" was broken on BOTH remote kinds, and not by this node's own doing.**
    `addTerminal` resolves the project from `activeProjectId` and `createTerminalNode` does
    `cwd: ssh ? ssh.remoteCwd : cwd` (`state/workspace.ts`) — on an SSH project the folder on screen
    was silently DISCARDED and the terminal opened at the project root, a pre-existing hole in
    `addTerminal`'s `cwdOverride` contract affecting every caller, not just this one. Fixed by routing the call
    through the EXISTING `nodeSshFor`, which already carries this exact reasoning ("passing the
    project's ssh unchanged silently REPLACES the caller's cwd") and which `addTerminal` simply
    never used; it is handed `cwdOverride` and never the resolved `cwd`, because an SSH project can
    still carry a local `project.cwd` that `scmCwd` falls back to, and promoting that would root
    remote terminals at a path from the wrong machine. On a RELAY tab there is no `ssh` to
    rebind, so the row used to spawn a plain LOCAL terminal at the peer's remote path; it is now
    withheld there instead — spawning onto a peer's core is a real feature, not a one-liner.
  - Creation needs a project directory (`hasCwd`), and **the row degrades EXPLICITLY rather than
    vanishing** — disabled, carrying `FILES_NO_CWD_HINT` (an alias of `NEW_FILE_NO_CWD_HINT`), on
    the pane menu, the Dock and the sidebar "+". That is the rule #621 established for "New file…"
    and the SSH worktree row: a cwd-less project is a supported, persisted canvas, so a row that
    simply disappears takes its own reason with it while the fix ("Set folder…") sits one menu
    away. **⌘K is the deliberate exception** and hides the entry, exactly as main's "New file…"
    does — a disabled palette entry surfaces as a search result that does nothing, the same reason
    `sshAccountsHint` is omitted there. Inside a group frame it inherits a bound **worktree's** cwd
    via `cwdForNewNodeIn`, so a frame per branch also means a file tree per branch.
  - **A node kind not registered in `lib/reopenNode.ts` is a trap, and this one fell in it.** Every
    kind must sit in exactly one of `UNRESTORABLE` or a `buildBase` `case` — `files` was in neither,
    so ⇧⌘T recorded a snapshot (and a persisted `closedSessions` twin) that `buildBase`'s
    `default: return null` could never restore: a dead, clickable entry that compiles, typechecks and
    passes every test. `files` now has a `case` (it IS restorable — its whole state is the directory
    it shows), unlike `trigger`, excluded for the same missing-case reason
    (`reopenNode.ts:58-60`, the comment that made this findable). Two kinds have fallen in this trap
    now; treat registration as a checklist item for the next one.
  - **Kanban: deliberately not a card.** `canvas/toKanbanSession.ts` maps `browser`, `sticky` and
    `terminal` and returns `null` for everything else — cards do not "derive from terminal nodes",
    they derive from that explicit list. A files node has no session to co-attach and no text to
    edit; its value is spatial adjacency to the terminals working in the directory, which a column
    layout would discard.
  - `folderTitle` lives in `lib/explorerCreate.ts` (a zero-import leaf), not `lib/filesNode.ts`:
    `filesNode.ts` imports `isVideoFile` FROM `state/workspace`, so importing back would close a
    cycle. `filesNode.ts` re-exports it, so call sites are unchanged.
  - **The `/`-separator assumption is a KNOWN gap, shared with `explorerCreate`** (the Explorer
    drawer and canvas "New file…" already run on the same helpers) — `C:\x\y` reads as one segment.
    To be closed in ONE place for both, using the core-owns-the-dialect rule `terminal/file-links.ts`
    already implements. The TRAVERSAL half is closed: `newEntryPath` splits its `..` check on
    `[\\/]` and refuses a Windows-absolute name, because a guard that reads `\` as ordinary text is
    wrong about the machine that resolves the path. The construction half deliberately is not: on
    POSIX a backslash is legal filename text, so the join stays `/` and `weird\name.txt` is still
    one file. Guard on both dialects, construct in one.
  - **Mobile**: N/A — *nodeterm mobile* attaches to tmux sessions over the transport protocol and
    has no canvas or file-browsing concept; adding one means extending that protocol.
- **dino** (`DinoNode.tsx`) — a small self-contained T-Rex-style runner on a canvas (no PTY);
  high score persists via `data.highScore`.
- **trigger** (`TriggerNode.tsx`) — a canvas-owned schedule (cron / interval / once) that
  delivers a payload into a connected terminal/agent node when due (issue #493 — the inverse of
  the ephemeral loop/cron cards, which visualize AGENT-initiated recurrence). The card shows the
  schedule + next-run countdown, the target (a derived, never-persisted edge — the
  pending-launch dep edge is NO longer one: since the 2026-09-02 edge model it is a persisted rope,
  `ctrl-<dep>-<node>`, whose dashed ⏳ LOOK is what is derived), the payload, an honest
  ARMED/DISARMED/CHANGED/SET-UP chip with the
  "definitions travel with the repo, consent never does" narrative, Run-now, and the last runs
  (fired / delivered-late / queued / missed / failed / expired). Arming passes a ConfirmDialog
  showing the exact schedule+payload+target being consented to; all decisions are the pure,
  tested `lib/triggerCard.ts`, all state is host-side over `window.nodeTerminal.triggers`
  (arm/disarm/status/runNow — `startTriggerService` registers the handlers in BOTH shells;
  `runNow` deliberately takes no spec: a caller chooses WHEN, never WHAT). The relay stub
  refuses and the card says triggers are managed on the host. Mobile: N/A (no canvas).
- **subagent** / **loop** (`SubagentNode.tsx` / `LoopNode.tsx`) — render-only, hook-driven viz
  nodes, **never persisted**. `subagent` visualizes a subagent the Claude session spawned (type +
  task + live timer, expand for its live transcript — subagents have no PTY); `loop` shows a
  loop/schedule/cron kind + task + per-iteration summaries, Play re-issues the task into the parent
  terminal's tmux session.
- **chat** — **REMOVED 2026-07.** The SDK-driven Claude chat node (`ChatNode.tsx`, `main/chat-driver.ts`,
  the `@anthropic-ai/claude-agent-sdk` dependency, and the whole chat-events/chatSessions stack) is
  gone — dropping the bundled SDK also removed a ~240 MB native binary per platform. A persisted `chat`
  node is migrated by `nodeStatesToFlow` into a **sticky tombstone** in place, carrying a
  `claude --resume <chatSessionId>` hint so the conversation continues in any terminal (a chat was an
  ordinary resumable Claude session). `CHAT_CAPABLE` / `canChat` survive but now gate **only** the
  ⌘M **ChatPanel** transcript view on a Claude *terminal* node (see the terminal bullet's Cmd/Ctrl+M),
  not any SDK chat node.

Monaco is wired in `renderer/editor/monaco-setup.ts` (language workers bundled via Vite
`?worker` — no CDN; CSP `worker-src` allows them). Markdown rendering is shared in
`renderer/lib/markdown.ts` (`marked` + DOMPurify sanitize).

### Webview keep-alive across project switches (browser/web nodes)

Issue #301: a project switch used to reload every browser node's page — SPA state, forms, scroll,
websockets gone — because the load effect swaps the whole React Flow node array and an Electron
`<webview>`'s guest process dies on DOM detach (a webview cannot be parked like xterm). The fix
keeps the ELEMENT mounted instead of trying to preserve anything through a remount. The facts it
rests on are measured (Electron 42.x probes + in-app verification, 2026-08-26):

- A guest **survives** sibling insert/remove around its element (React reconciliation of kept,
  order-stable keyed children never touches them), and **survives `display:none`** of itself or an
  ancestor — state intact, viewport size and scroll kept (the guest is NOT resized to 0), repaint
  pixel-identical on reveal, timers running throttled like a background tab.
- A guest **dies** on any DOM *move* (`insertBefore`/`appendChild` of an attached element detaches
  first), taking a full page reload with it. React moves a kept child exactly when its RELATIVE
  ORDER among kept children changes (`lastPlacedIndex`), and React Flow renders nodes in
  prop-array order keyed by id (`adoptUserNodes` rebuilds `nodeLookup` in array order) — so the
  merged prop's order discipline IS the feature.

Mechanics (`renderer/lib/webviewKeepAlive.ts` pure + tested, `state/webviewKeepAlive.ts` store,
merged in Canvas exactly like the ephemeral subagent cards — Canvas state, persistence, undo and
the wire never see any of it):

- Every webview-hosting node (`browser`/`web`) renders in ONE stable **pool region** at the tail
  of the `<ReactFlow>` nodes prop, ordered by the pool's entries; entry order never changes while
  an entry lives (append/remove only — `webviewKeepAlive.test.ts` pins the order-stability
  invariant, `webview-keepalive-reconcile.test.tsx` pins the no-detach consequence against real
  React). Visible cost of the hoist: an unselected browser/web node paints above other unselected
  z-0 nodes it overlaps (selection's z 1000 still wins).
- On switch-away the outgoing project's pages become **ghosts**: same node id, `display:none`,
  non-interactive, parked at the origin, `data.ghost` telling the surfaces to route facts at the
  pool (`updateGhostData`) instead of `updateNodeData`. On return the SAME element goes live
  again; `overlayKeepAliveData` folds ghost-time navigations into the loaded nodes inside the one
  `setNodes`, so the `url` prop never moves under the surviving surface (which would navigate it).
- **The merge is keyed on the MOUNTED project (`keepAliveFromRef`), never `activeProjectId`, and a
  mounted entry whose node is missing falls back to its ghost.** Both exist because the pool store
  (zustand/useSyncExternalStore), the ref and `setNodes` do not land in one commit: a switch renders
  interleavings where the id would otherwise drop out of the merged list for one commit — and one
  absent commit is an unmount, i.e. a dead guest ([MEASURED]: the ghost→live direction remounted
  every returning page until the fallback; live→ghost never did). A genuinely deleted node's entry
  is dropped at the deletion funnels (handleNodesChange's `remove`, `deleteNodes`, the peer-mutation
  remove, project deletion/prune), with the next retire as backstop — never by the merge.
- **Memory bounds** (same posture as park/WebGL: a lever must not end live work): a ghost is
  hidden, so the existing Browser Memory Saver discards its guest after `BROWSER_DISCARD_MS`
  unless loading/audible/agent-driven — `onGuestDiscarded` then drops the entry (a husk would hold
  a cap slot). `BACKGROUND_WEBVIEW_MAX` (8) hard-caps live background guests, evicting
  longest-retired first; `activateProject` runs BEFORE `retireProject` on every switch so a
  returning page sheds its background clock before that eviction can pick it.
- E2E-verified under Xvfb (CDP): same webContents across Alpha→Beta→Alpha, typed form text + JS
  state + tick counter continuous, zero reloads; wrapper + webview DOM elements identity-stable in
  both directions. Server Edition: inert (no `<webview>` in a plain browser — ghosts are empty
  husks, nothing to preserve). Mobile: N/A (no canvas).

## Agent support (Claude / Codex / Gemini / Copilot / opencode / Grok / custom)

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts).

- **Agent registry + capabilities** — `src/shared/agents/config.ts` holds `AGENT_CONFIG`
  (claude/codex/gemini/copilot/opencode/grok: id, label, spawn command, color, `promptInjectionMode`, …) keyed
  by an **open** `AgentId`
  type (so custom ids fit). Capabilities are membership lists, not flags:
  `AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`, `SUBAGENT_CAPABLE`, `RECURRING_CAPABLE`,
  `BRANCH_CAPABLE`, `CONTEXT_LINK_CAPABLE`, `USAGE_CAPABLE`, `CHAT_CAPABLE`,
  `TRANSFER_SOURCE_CAPABLE`, `RENAME_CAPABLE`, `TITLE_READ_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `PERMISSION_MODE_CAPABLE`, `MODEL_SWITCH_CAPABLE`, with helpers (`hasHooks`,
  `canBranch`, `canContextLink`, `canChat`, `canRename`, `canReadTitle`, `hasPermissionMode`, …).
  Branch stays **Claude-only** purely by being in only `BRANCH_CAPABLE`. The ⌘M **ChatPanel**
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok** since 2026-09: grok's
  `chat_history.jsonl` gets its own reader, and `chat:read-transcript` routes by agent. That list had
  to be SPLIT to do it — `CHAT_CAPABLE` carried two facts that coincided while claude was its only
  member ("we can render this" and "claude's resolver can locate and parse this file"), and the
  second now lives in `CLAUDE_TRANSCRIPT_READABLE` (claude only). Merging them back is a
  cross-session read of someone else's transcript; `config.capabilities.test.ts` pins the pair.
  The other lists span more agents, and the memberships below are the ones to check before assuming
  "claude-only" (all verified against `config.ts`, 2026-09-02): the per-node **context meter** is
  `USAGE_CAPABLE = claude/codex/gemini/grok` — grok states BOTH numbers, and its own percentage, in
  `signals.json`;
  the **permission mode** is `PERMISSION_MODE_CAPABLE = claude/grok/gemini/codex`; the session-name
  sync is **split in two** — `TITLE_READ_CAPABLE = claude/codex/grok/gemini` (read) ⊇
  `RENAME_CAPABLE = claude/grok` (write), because gemini and codex name their own sessions but have
  no rename command (codex's read leg is `readCodexSessionName`);
  **Context Link** spans five builtins
  (`CONTEXT_LINK_CAPABLE = claude/codex/gemini/opencode/grok`; the one builtin outside it is
  copilot). UI gates
  on these helpers — no hardcoded `=== 'claude'`. **Custom agents** (user-defined in Settings,
  `customAgents`) inherit the declared `baseAgent` harness through `capabilityAgentId`; a custom
  agent with no base remains spawn + terminal-title + process status only. Per-agent write-ups:
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`** (there is none for codex — its approval mapping
  and every value's reasoning live in `src/shared/agents/approval-mode.ts`);
  the distilled rules are **Adding a new agent** at the end of this section.
- **Model gateway / switcher** — `settings.modelGateway` stores one gateway root + a NON-SECRET
  credential reference: `${env:VAR}` for environment mode or
  `${secret:model-gateway-api-key}` for a literal held by `ModelGatewayCredentialService`. Desktop
  literal keys reuse the GitHub token store's safeStorage encryption / 0600 fallback; Server
  Edition uses the same generic 0600 atomic store. Legacy plaintext settings migrate only after
  the secret write succeeds. `shared/agents/model-gateway.ts` is the ONE mapping from a base
  harness to derived routes, env vars, compatible models and safely quoted model flags. Env
  expansion reuses `shared/agents/expansion.ts` and happens only in core against the host process
  environment; an unset reference fails closed instead of sending a token or partial credential.
  Discovery at `/v1/models` is the **OpenAI Models API convention**, implemented by both LiteLLM
  and Bifrost; the current `/openai/v1` + `/anthropic` launch-route derivation is Bifrost's layout,
  not the source of the discovery convention. Discovery sends the standard bearer header plus
  Bifrost's `x-bf-vk` header (needed by legacy, non-`sk-bf-` virtual keys), and runs in core
  (`agent:discover-models`) so browser CORS cannot block the Server Edition and the key never
  enters a terminal command. Support is a
  capability (`MODEL_SWITCH_CAPABLE = claude/codex/copilot`) resolved through `capabilityAgentId`, so a
  custom agent with a supported `baseAgent` inherits it automatically — the settings UI and canvas
  menu carry no agent allowlist. A model switch SIGTERMs the pane's foreground non-shell process
  group (never types `/exit`) and RECYCLES the tmux session before cold-resume: an existing shell may
  predate the gateway setting, and tmux env changes do not retroactively change that shell's
  environment. Recreating it guarantees the current URL/key applies without typing a secret into
  the pane. Ordinary Restart stays in-place. Custom-agent env is still merged last and may override
  the shared mapping. Desktop and Server Edition use the same core handler; relay tabs deliberately
  do not apply this machine's gateway to another core. Mobile needs a settings/model-picker surface
  before it can expose the feature.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
  `RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE` and
  `SESSION_ID_CAPABLE`; NOT in `SUBAGENT_CAPABLE` — subagent cards still need the `spawn_subagent`
  PreToolUse/PostToolUse payload, which nobody has captured. The other four came off the blocked list
  in 2026-09, once a machine with a logged-in grok session produced real fixtures: context links and
  the ⌘M panel read `chat_history.jsonl` (NOT `updates.jsonl` — see below), and the meter reads
  `signals.json`. Its hook config is a **directory** (`$GROK_HOME/hooks/*.json`, all merged), so nodeterm
  **owns one file outright** (`nodeterm-status.json`) instead of merging into a shared settings file —
  which is also why a malformed copy of it is *healed* rather than preserved, locally and on an SSH
  host (`RemoteHooks.installGrokRemote`, under the host's own `$GROK_HOME`). Its dialect is
  **camelCase keys with snake_case event VALUES** (`{"hookEventName":"pre_tool_use"}`) — the SDK path
  flips the keys to snake_case, so `normalizeGrok` canonicalizes the event name and reads every field
  twice, and the shells share one decoder (`grokRawFields`). It carries **no `transcript_path`**, so a
  session directory is DERIVED from `cwd` + `sessionId` (`core/agents/grok-paths.ts`, the one
  `$GROK_HOME` rule — `core/usage/grok-usage.ts` delegates to it) and remembered in the shells' raw
  listener; the name read is `core/grok-session.ts` over `summary.json`, routed per agent by
  `core/agent-session-name.ts`. **The tool-event `matcher` is a regex: `.*`, never `*`** — a bare `*`
  is invalid and silently stops tool events firing (hence `ManagedHookEvent`). Grok also reads
  **`~/.claude/skills`** (Claude compat), which is why canvas control needed no new installer, and
  **`~/.claude/settings.json`**, so every grok event ALSO fires nodeterm's claude hook — an **inert**
  cross-fire (`normalizeClaude` finds neither grok's camelCase keys nor, in the SDK dialect, its
  lowercase event values), pinned by tests; canonicalizing claude's event-name compare would make it
  harmful. The `auto` permission-mode **version gate is claude's alone** (it is fed by a `claude
  --version` probe), and grok's mode flag must go **BEFORE** its `--` separator, which is
  end-of-options. Full picture, dialect traps and the device checklist: **`docs/grok-agent.md`**.
- **Gemini + codex parity** (2026-08-09) — brought both up to grok's level in the lists above. Unlike
  grok, **both CLIs are installed** and gemini **ships its own hook reference**
  (`/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md`), so almost every fact is
  measured. The load-bearing ones:
  - **Gemini's envelope IS claude-shaped** — `session_id`/`transcript_path`/`cwd`/`hook_event_name`
    (`reference.md:46-58`), the exact opposite of grok's missing `transcript_path`, so the shells just
    jail the path they are handed. The **event names** are gemini's own: eleven exist, `GEMINI_HOOK_EVENTS`
    subscribes **seven**. `AfterModel` is excluded because it fires **per streamed chunk**
    (`reference.md:236`) = one hook process per chunk; `BeforeModel` is **not** per-chunk (it fires once
    per request) and is excluded only because it reports nothing we render.
  - **`Notification` → `blocked`, matched as a CLOSED set** (`notification_type === 'ToolPermission'`).
    Before this, a gemini node sat on RUNNING while it waited for a permission answer. The closed match
    is measured, not cautious: gemini's `NotificationType` enum has exactly ONE member, and it fires
    only after `shouldConfirmExecute` returns details — i.e. only for a real dialog, so an
    auto-approved/`yolo` call fires nothing. **Grok's `includes('permission')` strobed on every tool
    call**; widening this "to be safe" is the unsafe direction.
  - **Context meter from each agent's own transcript** — one tail per agent, each with its own `parse`
    dep on `createContextTail` (`core/gemini-session.ts`, `core/codex-session.ts`), in **both** shells.
    Gemini: `tokens.input` and a window from `geminiWindowFor`, which mirrors the CLI's own
    `tokenLimit()` — a **family rule with a 1M catch-all default**, so an unknown model gets the right
    answer instead of a confident wrong denominator. Codex: `last_token_usage.input_tokens` and its own
    stated `model_context_window`. Two traps: `total_token_usage` is **CUMULATIVE** (would render a
    13%-full session at 79%), and `cached` is **INSIDE** `input` for both — while claude's input
    *excludes* cache reads, which is why claude sums them. **The formulas must not be unified.**
    The transcript jail is widened **per root** (`~/.gemini/tmp`, `<codexHome>/sessions`), never to
    `$HOME` — that predicate exists so a forged hook POST cannot aim a read at `~/.ssh/id_rsa`.
  - **`hasUsage` gated THREE features, not one.** Joining `USAGE_CAPABLE` also switched on
    `context.ensure` and the find bar's transcript index, both of which go through claude's
    `resolveTranscript` — whose **cwd fallback** then handed a codex node *the newest claude transcript
    for that cwd*: a stranger's session as its meter and its search hits. Now gated by the pure
    `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`), which reuses `CHAT_CAPABLE` rather than
    adding a fourth list. Non-claude agents lose only the mount-time head start.
  - **`TITLE_READ_CAPABLE` was created here**: gemini names its own sessions through its `update_topic`
    tool (the title is in that call's `args.title`, NOT a top-level field) but has no rename command, so
    the read and write legs split. Its read path is the transcript the context tail already tracks
    (injected as `AgentSessionNameDeps.geminiPathFor`, held in a `let` in `src/main/index.ts` to avoid a
    TDZ throw that would kill a node's whole poll chain).
  - **In-place restart** works for gemini: `EXIT_SEQUENCES.gemini = '/quit'` — and it must stay **bare**,
    because `/quit --delete` exits *and permanently deletes* the session history, i.e. exactly what the
    restart exists to resume (pinned by its own test).
  Full picture, measurements, gaps and a device checklist: **`docs/gemini-agent.md`**.
- **Permission mode** (agents in `PERMISSION_MODE_CAPABLE` — claude, grok, **gemini**, **codex**) —
  the mode a session **starts** in (`claude --permission-mode <mode>`; Shift+Tab still cycles it at
  runtime). Membership no longer implies claude's flag spelling: **the per-agent translation lives in
  `src/shared/agents/approval-mode.ts`** (`approvalFlags` / `modeSupported`), which is also where
  `withPermissionMode` now lives — it moved one layer up out of `config.ts` to break a cycle.
  gemini = `--approval-mode default|auto_edit|yolo|plan`, codex = `--ask-for-approval
  untrusted|on-request|never`. Two rules the mapping exists to enforce: a mode the CLI **cannot
  express emits NO flag**, never a substituted nearest match (codex has no `plan` and no
  edit-specific mode; **gemini has no `auto`** — nothing in its vocabulary means "approve most things
  but not edits", and since `auto` is the DEFAULT mode, mapping it to `auto_edit` would have switched
  auto-approve-edits on for every existing gemini node at upgrade time, silently), and "supports"
  must not be a lie either — codex's `manual` maps to
  `untrusted` because its built-in default is `OnRequest` (measured: `codex doctor`, no `approval`
  key in `~/.codex/config.toml`), so leaving it unflagged would deliver "the model decides when to
  ask" under an "Ask each time" label. **codex is the first agent where `manual` emits a flag.** The
  UI copy is DERIVED from the mapping (`permissionModeAgentIds` / `permissionModeAgentsLabel` /
  `unsupportedModesNote` / `bypassSandboxCaveat`) so a sentence cannot drift from what the table
  does — so the note now reads "Auto has no Gemini equivalent…" beside codex's two gaps, and the
  residual wart is only that `auto` and `manual` land on the same gemini policy (the *prompting* one).
  `--sandbox` is a separate axis and deliberately untouched (`--ask-for-approval never`
  still sandboxes).
  `settings.claudePermissionMode` (global, default **`auto`** — a behavior change for existing
  users, who previously got a prompt per action) is overridden per project by
  `project.defaultPermissionMode` (persisted to `.nodeterm/project.json`, so a `bypassPermissions`
  override travels to everyone who clones the repo — the tab menu warns). Modes are
  `manual | auto | acceptEdits | plan | bypassPermissions`, labelled once in
  `PERMISSION_MODE_LABELS` (from which `ALL_PERMISSION_MODES` is derived — the dropdown and the
  validator can't desync). `resolvePermissionMode(project, settings)` is the resolver
  (`renderer/state/permissionMode.ts` `activePermissionMode(agentId)` binds it to the live stores **and
  applies the version gate below — for `agentId === 'claude'` only**), and
  **`withPermissionMode(cmd, agentId, mode)` is the single
  funnel through which every agent-node launch site appends the flag** (new node, cold-restore
  resume, Branch, handoff/transfer, explain-commit, add-agent, canvas-control open-agent + team
  spawn). **WHERE the flag lands is decided at the composed layer** (`createAgentNode`), not in
  `withPermissionMode`: with no `argvPromptSeparator` (claude) it goes LAST, keeping the historical
  command byte-identical; with one (grok's `--`) it must go **BEFORE** the separator, because `--` is
  end-of-options and a flag after it is a positional — silently swallowed into the prompt or a clap
  usage error. Assert that at `createAgentNode`; a `withPermissionMode` test passes while the composed
  line is wrong. (gemini and codex declare no separator, so their flag goes last and their command
  lines stay byte-identical; grok is still the only agent taking the other branch.)
  UI: Settings → Agents, and the tab ⌄ menu for the per-project override.
  **Version gate (`auto` only) — CLAUDE's alone:** `--permission-mode auto` exists only in **Claude Code ≥ 2.1.71**;
  older CLIs validate the value against their own choices list and **exit 1** — and `auto` is the
  default, so an ungated flag would kill every Claude launch on an older CLI. So the CLI is probed
  (`core/claude-cli.ts` → `claude --version`, memoized, registered on `CorePlatform` so **both**
  shells serve it; reached from the renderer via `window.nodeTerminal.claude.cliCaps()`, with a
  **real** ws-bridge implementation) and `gatePermissionMode(mode, autoSupported)` degrades **only
  `auto`**, and only to `manual` = **no flag** = the bare pre-feature command. Everything **fails
  open**: unknown/unreadable version, a probe that failed or hasn't answered yet ⇒ bare command,
  never a blocked launch; the other four modes are never touched by the gate, and the user's
  *setting* stays `auto` (only the emitted command line changes). **SSH projects** are gated on the
  **remote** host's CLI, never the local one: `SshProjectManager.connect` probes `claude --version`
  on the host (through a login shell — an ssh exec channel's rc file usually bails out early — with
  `$HOME/.local/bin` + `$HOME/.claude/local` prepended to PATH: the official installer targets
  `~/.local/bin`, which a stock root `.profile` never adds, so a host whose interactive shells run
  claude fine still probed "not found" and silently degraded `auto` to manual) and
  caches the answer on the connection → `useSshConn`; not connected / not yet probed ⇒ no `auto`
  flag. A FAILED remote probe (claude not found — often a transient login-shell hiccup) **retries
  on a bounded backoff** (`PROBE_RETRY_DELAYS_MS`; every attempt pushes its answer immediately so
  launch waiters never block on the retry tail; a definite version — old or new — never retries),
  and the status event carries `remoteClaudeVersion` (`null` = probe failed) beside the boolean.
  The cold-restore relaunch `await`s the (shell-warmed) local probe because it fires on mount —
  and on an SSH project whose resolved mode is `auto` it also waits (`SSH_AUTO_PROBE_WAIT_MS`,
  bounded, fail-open) for the REMOTE probe's first answer, which races the same mount. Because
  the degrade is silent by design, the tab menu's Auto rows surface it: `sshAutoModeHint`
  (tri-state `useSshConn.autoPermAnswer` + probed version) puts a ⚠︎ + tooltip on "Auto" / "Use
  global (Auto)" for an SSH project whose remote CLI is too old / missing / not yet probed.
  **Security:** mode values come from hand-editable, git-shared JSON and end up interpolated into
  a shell command line (tmux `send-keys`), so `permissionModeFlag` **re-validates** the mode at the
  interpolation site (the type is compile-time only) — an unrecognized mode yields **no flag**, i.e.
  the bare, safe command. `'manual'` likewise yields no flag, reproducing the pre-feature command
  bit-for-bit. The setting and the per-project override apply to **terminal (CLI) agent nodes only**
  (the SDK **chat node**, which never honored it, was removed 2026-07). **No other agent inherits this
  gate:** grok has accepted every mode since 1.0.0 and gemini/codex accept theirs on the versions we
  measured, so gating any of them on a `claude --version` probe would
  downgrade their sessions on a machine whose claude is old or absent — `activePermissionMode` gates
  only `'claude'`, `ensureActivePermissionMode` awaits the probes only for `'claude'`, and
  `sshAutoModeHint`'s copy names Claude in every sentence for the same reason. An agent needing its
  own gate adds one beside claude's.
- **State via each agent's hooks → shared 4-state model** — detection uses the agent's own
  hooks, **not** output parsing. `src/shared/agents/normalize.ts` has per-agent normalizers
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status`, drives the `agentStatus` store, fires throttled
  (5s/node) background notifications, and records the session id. Header shows a pulsing
  **RUNNING** (working) / **NEEDS YOU** (waiting/blocked) badge.
- **DROPPED — the CLI died and nobody told us** (`renderer/terminal/agent-liveness.ts`, issue #616).
  Every ORDERLY exit announces itself: Eco's `/exit` sets `hibernated`, "Pause session" sets
  `paused`, and a user typing `/exit` fires the CLI's own SessionEnd, which `setState(id, undefined)`
  records. A KILL announces nothing — the process is gone before it can run a hook, and tmux's shell
  still owns the pane so the PTY never closes. The node therefore kept rendering its last badge over
  a dead conversation, with the CLI's parting `Resume this session with: claude --resume <uuid>` and
  a stray `^[%` in the pane as the only evidence. Not exotic: measured on the reporting host
  (2026-09-04) 62 GB RAM with swap fully consumed, kernel `oom_kill` at 187, 147 live `claude`
  processes holding 44 GB. The signal is `#{pane_current_command}` reading as a shell while the
  status table still believes an agent is parked there, and the four refusals are the feature:
  a `null` pane read is NEVER evidence (a downed ControlMaster must not make a canvas of healthy
  remote nodes claim they died); `hibernated`/`paused` are our own exits and already have chips;
  **only `done`**, never `working` — a turn in flight is exactly when a tool subprocess can own the
  pane's foreground, so the alarm would fire on a healthy agent running a shell command; and the
  agent must be in **`SESSION_END_CAPABLE`**. That last list is the false-positive gate and is
  DERIVED from `normalize.ts`, not chosen: exactly four normalizers map `sessionPhase: 'end'`
  (claude, gemini, copilot, grok) and **codex and opencode map none**, so on those two a deliberate
  `/quit` and an OOM kill leave byte-identical evidence and the chip would be a coin flip shown as a
  fact. Adding an id without first adding its normalizer branch puts a chip on every session its
  owner quit on purpose — `agent-liveness.test.ts` asserts the list against that source. The verdict
  (`agentStatus.dropped`) is TRANSIENT, a stronger call than the other clocks: it is a claim about a
  pane, panes are re-measurable in milliseconds, and a persisted one would strand a stale chip on a
  node someone resumed by hand. ANY hook event withdraws it — the one self-heal that deliberately
  does not gate on `alive`, since `done` disproves "there is no CLI in this pane" even though it must
  not clear `hibernated`. Cost is bounded by asking only for a node that is BOTH watched and already
  believed to be a parked agent. Resume reuses the hibernation wake closure unchanged, which
  re-reads the pane and refuses anything that is not a shell. Chip on the node header, the kanban
  card and the card modal; Desktop and Server Edition identical; relay tabs answer `null` and are
  never judged. **A second thing this catches, unplanned:** in the same sweep 9 of 149 panes sat at a
  bare shell because a cold-restore `--resume` had answered *"No conversation found with session
  ID"* — the persisted `sessionId` outlived its transcript. The chip surfaces those too, but the
  Resume it offers replays the same dead id; making cold restore fall back to a bare launch when the
  transcript is gone is a separate, unbuilt fix.
- **Hook server (loopback HTTP)** — `src/core/agents/hook-server.ts` is a main-process
  loopback HTTP server (per-session bearer token, fail-open) that the installed hook scripts
  POST to; it replaced the old `fs.watch` signal-log mechanism. `buildPtyEnv` injects the
  node id + endpoint/token into each spawned session's env; because tmux sessions **outlive
  the app**, the server also writes `<userData>/hook-endpoint.env` so a relaunched main
  process re-advertises the same endpoint (restart handoff). A `setRawListener` channel feeds
  the per-node context-window meter (`context-tail.ts` — **one tail per agent**, each with its own
  `parse` dep: claude's usage records, `codexContextParse`, `geminiContextParse`) and the subagent
  live-transcript (`subagent-tail.ts` — claude via meta-dir `track`, codex via `trackFile` with the
  stateful `codex-subagent-format.ts` formatter). The same events feed the **agent-status mirror**
  (`core/agent-status-mirror.ts`) the mobile companion reads; the mirror carries an optional
  `settings` block (`claudePermissionMode`/`autoSupported`/`claudeAccounts`) so the phone can
  launch agents with the desktop's permission mode + managed accounts, and SSH slices get their
  **per-host** settings (remote CLI caps + host-matched accounts) injected via
  `remote-status-push`'s `settingsFor` dep.
- **Hook installers** — `src/core/agents/hooks/` holds per-agent hook services + an installer
  registry `MANAGED_HOOK_INSTALLERS`. `managed-script.ts` builds the POSIX hook script that
  POSTs to the server (env-gated: a no-op in the user's normal terminals, active only in
  sessions nodeterm spawns; the `claude-signals` string is kept as the idempotency marker that
  migrates users off the old hook). claude → `~/.claude/settings.json` and gemini →
  `~/.gemini/settings.json` (shared `install-helper.ts`, merged/idempotent, preserving other
  tools' hooks); codex → `~/.codex/hooks.json` + `~/.codex/config.toml` trust entries
  (`codex-trust.ts` — the hash gates whether codex runs the hook); **grok → our OWN file
  `$GROK_HOME/hooks/nodeterm-status.json`** (its hook config is a directory whose files are all
  merged, so there is nothing of the user's inside ours — which is also why a malformed copy is
  *healed*, not preserved, on both the local and the SSH path). The per-event **`matcher`** the grok
  installer needs is why events are typed `ManagedHookEvent` (`string | {event, matcher}`): grok's
  tool matcher is a REGEX and must be `.*` — a bare `*` is invalid and silently stops tool events
  firing. Plain-string events keep their byte-identical output for every other agent.
  **Codex is the one agent whose hook command is NOT a POSIX one-liner on Windows** (issue #567):
  it builds the command as `cmd.exe /C <string>` (`codex-rs/hooks/src/engine/command_runner.rs`,
  rust-v0.151.0) unless the session has a shell configured, which a default Windows install has
  not — so `if [ -x '…' ]; then …; fi` answered `-x was unexpected at this time.` and **exit 1 on
  every event**, for the life of the node. Claude is fine there only because Claude Code runs its
  hooks through Git Bash. The fix is a batch entry point (`codex-hook.cmd`,
  `codex-windows-wrapper.ts`) written beside `codex.sh` and named by `buildManagedCommand`'s win32
  branch; it **locates a POSIX shell and runs the same script** — deliberately not a second
  implementation of the hook protocol, which would be two copies of the POST/failover/token/
  permission-poll to drift. Three rules it must keep: pass stdin through, DRAIN stdin on every bail
  (codex writes the payload there; #186/#187), and exit 0 when there is no shell or no script.
  Two traps around it: `buildManagedCommand`'s `platform` is the platform of the machine that will
  RUN codex, so `RemoteHooks.installCodexRemote` passes POSIX explicitly (a Windows desktop must not
  put a `.cmd` command on a Linux host); and `isManagedCommand` matches **both** leaves
  (`codex.sh` AND `codex-hook.cmd`) on every platform — matching only the local one would leave a
  pre-fix entry unrecognized, so the fresh one is appended beside it, which is #558 on a second
  file. Matching both is what REPAIRS an existing Windows install at the next launch. **Both
  sides of the managed-entry match go through `normalizeHookCommand`** — the marker used to be
  folded to `/` while the stored command was compared raw, so on Windows nodeterm never recognized
  its OWN entry and appended a fresh set every launch (#558: nine copies of nine events, nine
  `claude.sh` processes per Stop, nine 45 s `PermissionRequest` waits racing one prompt). Because
  `mergeManagedHook` drops every managed entry before pushing one fresh, the corrected match IS the
  repair for a file already ruined — it runs at boot via `installManagedAgentHooks` and, being the
  ONE shared merge, heals claude/gemini/grok, every managed Claude account dir and all three SSH
  remote installers at once; a second repair mechanism would be exactly the duplicated rule this
  file warns about. It strips only OUR handler out of a definition, so a hook a user hand-merged
  beside ours survives.
- **Per-node hook identity** (`src/core/agents/node-auth-*.ts`, `node-token-*.ts`,
  `node-identity-policy.ts` — full write-up in **`docs/node-identity.md`**) — the shared bearer proves
  "a session on this machine", never *which* session, so every node also gets a capability derived
  from one restart-stable secret (`kid.mac`, domain-separated HMAC over the node id), handed to the
  client as a 0600 file and verified three ways: `verified` / `legacy` / `forged`. `legacy` is "we
  cannot judge this", not a failure. Two invariants come out of this series and both cost real
  incidents to learn:
  - **A credential never rides argv — local or SSH.** Measured 2026-08-13: `buildPtyEnv` put the hook
    bearer in the tmux `-e` argv, which lands in a long-lived tmux client's `/proc/<pid>/cmdline`
    at **mode 444** on a stock Linux with no `hidepid`; combined with `open-terminal --cmd` not being
    in the confirm-gated `DESTRUCTIVE` set, that was arbitrary command execution as the victim from
    any account on the box. A remote command line is argv on **both** ends, so the same rule binds
    every `ssh`/`curl` we generate. Credentials travel by 0600 file or by **stdin**
    (`curl --config -`, already house style in `usage/remote-claude-usage.ts` and
    `codex-identity-proxy.ts`). Never add an argv fallback "for old curl" — that undoes the fix.
  - **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
    A new field on the hook event (the `verified` flag was one) that reaches only the desktop leaves
    the Server Edition silently without the feature; the boundary tests cannot tell you a field is
    *missing*. `hook-verified-parity.test.ts` asserts it at source level because this repo has
    shipped a one-shell hook-server change three times.
  - **Every generated sh client reads the token through ONE resolver** (`nt_read_node_token`,
    `core/agents/node-token-sh.ts`) — the managed hook script, `nodeterm.sh` and `context.sh`. The
    token dir is advertised only by the endpoint FILE, and a session is pinned for life to the
    endpoint PATH it got at tmux creation, so a client that reads only what that file advertises
    presents nothing forever when the file is pre-v2 (SSH hosts' shared `~/.nodeterm/hook-
    endpoint.env`, whose per-project socket path is re-bound on every connect, so it stays LIVE) or
    unreadable (a phone-spawned session). Issue #384: the hook script FAILS OVER and re-reads the
    token from the endpoint it adopts, the two shims did neither — so the same node proved itself
    through one client and was refused through the other by the trust-on-first-proof latch, for the
    life of the session. The resolver falls back to `<dir of the endpoint file>/node-tokens` (the
    layout by construction on all three surfaces) and then the well-known data dirs; it is monotone
    — advertised dir first, keyed by node-id filename in every candidate, and a foreign instance's
    dir yields a foreign `kid` = `legacy` = exactly what presenting nothing already gave.
  - **Every LOCAL generated sh client recovers shared-Codex identity before its env gate.** A tool
    shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
    `NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` therefore prepend
    `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
    `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL`. Before this was shared, status hooks recovered the
    node while both user-facing shims declared that same first-class Codex session outside
    nodeterm. The SSH constants remain machine-neutral: the local record root is not valid on a
    remote host and must never be baked into its copy — enforced by
    `main/remote-ssh/remote-shim-neutrality.guard.test.ts`, two legs (the exported neutral bodies
    carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a parameterised
    builder), because the failure is silent and one-sided: a remote shim carrying the prelude keeps
    working, and the only symptom is this machine's userData layout sitting in a file on someone
    else's server. **The prelude is shared; the RECORD it reads is desktop-only.** Those writers are
    the two hook-server handlers `src/main/index.ts` registers, and
    `src/server/handlers/index.ts` deliberately registers neither — so on the Server Edition the
    file is byte-identical, the signing secret is armed, and the resolver still finds nothing and
    takes its fallback. Coherent rather than missing: that shell answers `shared: false`
    (`UNKNOWN_CODEX_IDENTITY_CAPS`), so its Codex nodes run their own app-server and no tool shell
    needs recovering. It turns into a real gap only when that edition grows the shared app-server,
    and the fix is the two registrations.
  - **That prelude EXPORTS WHAT THE RECORD SAYS — it never decides.** `NODETERM_AGENT_ID` and
    `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are
    `buildPtyEnv`'s answers about the PANE, which labels a node with its OWN agent id
    (`custom:<uuid>` for a custom agent whose `baseAgent` is codex, not `codex`) and gates the grant
    on `canControlCanvas`. The constants therefore mislabelled every custom codex-based node and
    asserted a grant that agrees with the pane only because
    `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence that list's own comment
    invites the next shared-identity agent to break, and breaking it hands a tool shell a capability
    its pane was denied. So the record carries `agentId` + `canvasControl` INSIDE the 6-tuple HMAC,
    and the prelude reads them; the grant is exported only when the record grants it and is left
    UNSET otherwise (absent, never `0` — the shape both shims' `[ -z … ]` gates expect). The **pane
    echoes its own label** on `/codex-thread/{start,bind}` (a tmux session outlives the app, so
    after a restart nothing server-side still knows what agent a node runs), but the **grant is
    never echoed**: the route derives it with `canControlCanvas`, so there is ONE decider and a
    forged id cannot manufacture a grant the table refuses. The three preimage generations are
    **selected by the record's shape, never tried in turn** — a record naming an agent must not
    verify under a preimage that ignores one — and a pre-agent record's implied `codex` + grant is
    keyed on the LINE being absent, never on the value being empty, so nothing that names an agent
    falls back to the guess. The env vars were never a security boundary in any case (anyone who can
    run the shim can `export` them by hand); the per-node token is, and
    `docs/shared-codex-node-identity.md` states that argument in full.
  - **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
    destructures the request without `agent`, and a record write that omits its optional trailing
    argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route,
    the launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
    `main/codex-identity-record-wiring.test.ts` pins it at source level, the same remedy
    `hook-verified-parity.test.ts` uses for the same class of hole.
  - **Every generated sh client walks the SAME endpoint failover** (`nt_candidates`/`nt_adopt`,
    `core/agents/hook-endpoint-failover-sh.ts`) — issue #445, the endpoint-level twin of #384: a
    session is pinned for life to the endpoint PATH it got at tmux creation, so an app
    quit/restart (or a retired project id) leaves it POSTing at a dead port while a live endpoint
    file sits right next to it. The managed hook script had the bounded candidate walk (locals
    before tunnels, `nt_fallback_max` 3, token re-read from the ADOPTED endpoint's dir); the two
    shims did not, so hook events healed themselves while every canvas-control verb died with
    "control endpoint unreachable" — in the field, a reviewer launch silently dropped. Now shared,
    one definition. Two server-side halves in `hook-server.ts`: a FAILED `listen()` un-wedges the
    singleton (it used to leave `this.server` set, making every retry a silent no-op at port 0)
    and both `stop()` and the failed-start path delete `hook-endpoint.env` — publication reflects
    listener liveness; a crash skips that, which is exactly what the client walk exists for. An
    HTTP answer of any code is authoritative: only a dead transport (curl 000/'') fails over, so a
    403/400 is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` (#367 — the sandbox denies every connect, the hint is the
    right diagnosis) and the final error now distinguishes "no endpoint anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Fullscreen TUI (Claude)** — through the SAME `settings.json` seam the hook installer uses,
  nodeterm ensures Claude's `"tui": "fullscreen"` so a session takes the alternate screen + mouse
  and behaves natively in tmux (else a drag falls into copy-mode). Two guardrails: **write-if-absent**
  (any existing `tui` value — e.g. a user's `/tui default` — is never touched;
  `core/agents/hooks/claude-tui.ts` `ensureFullscreenTui`) and **version-gated** to CLI ≥ 2.1.89
  (`supportsFullscreenTui` / `claudeCliCaps().fullscreenTui`; unknown ⇒ don't write). Runs
  everywhere the hook seam does: local `~/.claude` + managed account dirs at launch/add-account
  (`ensureClaudeFullscreenTui{,Into}`), and the remote host + account dirs on SSH connect
  (`RemoteHooks.ensureFullscreenTui{,InAccountDir}`, gated on the connection's cached remote probe).
  **Grok has no analogue** — it runs full-screen by default, so there is nothing to write.
- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Selecting, focusing, dwelling into, or opening a session card
  clears `unread` and ACKs the finish across phone/notch surfaces — existing read-on-view behavior.
  This NEVER changes the workflow bucket: read state is independent from agent state.
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
- **Session name ⇄ node title** — **two lists, because the two directions are separate facts**:
  `TITLE_READ_CAPABLE` (`canReadTitle` — claude, **codex**, grok, **gemini**) is the READ leg,
  `RENAME_CAPABLE` (`canRename` — claude, grok) the WRITE leg, and **read ⊇ write** is an invariant
  pinned in `config.capabilities.test.ts`. Gemini and codex are the reason: they name their own
  sessions (codex via `readCodexSessionName`) but have **no rename command** (gemini's `/chat save
  <tag>` is a checkpoint, not a title), so one list for both legs would light the rename UI on a
  node where the write silently does nothing. The **write** is the same literal
  `/rename <name>` for claude and grok; the **read** legs are per-agent and none may ever
  search another's tree, so the routing lives in ONE place, `core/agent-session-name.ts`
  (`readAgentSessionName(sessionId, accountId?, agentId?, deps?)` — trailing/optional so every pre-grok
  caller is unchanged), serving the desktop IPC handler **and** both shells' session-name sweeps.
  Grok's read leg is `core/grok-session.ts` over `summary.json` in the session dir a hook told us
  about; gemini's is `pickGeminiTitle` (`core/gemini-session.ts`) over the transcript path its context
  tail already tracks — including the `$set` history a **resume** replays, which is exactly the case the
  read leg exists for. Routing is not cosmetic — claude's resolver *scans* `~/.claude/projects` on a
  cache miss, so an unrouted grok/gemini node paid that scan every 60 s for a guaranteed null.
  **The sweep's gate lives in core, not in the shells:** `startSessionNameSweep` defaults `supports` to
  `supportsTitleRead` (`core/session-name-sweep.ts`) and neither shell passes it — the duplicated copies
  drifted, and reverting both to `canRename` left the whole suite green while silently skipping every
  gemini node.
  - **session → title (read, claude):** the authoritative name lives in the transcript `.jsonl`, not the
    OSC terminal title (`/rename` does **not** update OSC — a known Claude gap — so reading the
    file is the only thing that works after a **resume**). `core/transcript-reader.ts`
    `readSessionName(sessionId)` resolves the session file **strictly by sessionId** (no cwd
    fallback — that would make every Claude node in one folder resolve to the same newest transcript
    and adopt each other's names) and `pickSessionName` returns the latest `custom-title`'s
    `customTitle` (the `/rename` name) else the latest `ai-title`'s `aiTitle` (auto name). Exposed
    over `pty.readSessionName`. `TerminalNode` polls it (~4 s) **only once this node's own sessionId
    is known** and **while the title still auto-tracks** (`data.titleAuto`, default true on agent
    nodes), and adopts it as the `title`. `term.onTitleChange` now feeds the `session` chip only.
  - **title → session (write):** the moment the user renames the node by hand (header rename box /
    ✦ AI-name / sidebar / command palette → all funnel through `applyManualTitle` or
    `renameSession`), `titleAuto` flips to **false** (polling stops overwriting) and the chosen name
    is pushed into the live session as `/rename <name>` via `pty.sendText` (tmux `send-keys`, same
    one-way bridge as Branch's `/branch`; works whether or not the node is mounted).
  - The launch command is left bare (no `-n`) — Claude's own name is canonical until the user
    overrides it; `titleAuto` is persisted so an overridden name survives reload/resume.
- **Search** — the command palette (⌘K) matches the session name + tags + `nt-<id>` in the
  hint, and substring-searches each terminal's **visible buffer** (captured via `pty.capture`
  on palette open, cached ~3s); content matches show "found in output".
- **⌘M transcript view (`ChatPanel`) — resolution is three-legged, and each leg fails differently.**
  `chat.readTranscript(sessionId, cwd, accountId, nodeId)` returns `ChatTranscriptResult
  {messages, found}`, NOT a bare array: an empty thread and an unresolvable transcript are
  different facts, and rendering both as "No conversation yet." is what made every failure below
  look like an empty session. (1) **Remote (SSH) nodes** — `remoteTranscriptBySession` is fed
  ONLY by hook POSTs, and a tmux session outlives the app, so after a restart an idle remote node
  has no ref and the local resolvers search the WRONG MACHINE. `remoteTranscriptRefFor` (main)
  therefore asks the host itself: the pure `core/remote-transcript-locate.ts` builds one `sh` line
  (exact `<root>/<encoded cwd>/<id>.jsonl` per root, then a glob; account root before the system
  one; `*` outside the quotes; **exits 0 on a clean miss** — "no transcript" is an answer, not a
  failed ssh), it runs over the ControlMaster, and the reply is jailed by
  `isSafeRemoteTranscriptPath` before it is read. A ref WE located is tracked in
  `locatedTranscriptSessions` so a dead one can be dropped on an empty read (the panel's Retry
  would otherwise replay it forever) — a HOOK-fed ref is never dropped that way, since an empty
  read there is usually a transient master hiccup and forgetting it sends the next read local.
  It is generated shell, so `remote-transcript-locate.test.ts` runs it for real under `/bin/sh`
  against a fake host tree — keep it that way. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events (from Claude's `PreToolUse`/`PostToolUse` on tool `Agent`/`Task`, correlated
  by `tool_use_id`) drive a transient `state/agentNodes.ts` store. Claude launches subagents
  **async by default**: that PostToolUse is only a launch ack (`status:'async_launched'`), NOT the
  end — normalize keeps the card working, the transcript tail keeps streaming, and the real end is
  the `<task-notification>` queued into the parent transcript (sniffed by the context tails →
  synthetic `subagent-end` in `index.ts`; the notification's `UserPromptSubmit` is also not a
  `newTurn`, so it doesn't clear the fan-out). Canvas renders each subagent
  as an **ephemeral** `SubagentNode` (display-only card: type + task + working/done) connected by
  an **edge** to its parent agent node. These ephemeral nodes/edges live outside the React Flow
  `nodes` state (merged only at the `<ReactFlow>` prop), so they're never persisted
  (`flowToNodeStates`) nor in undo/dirty. **Two different clears, and the difference is
  load-bearing (issue #547):** the removal paths (node delete, project delete, the cross-project
  close, the orphan-session kill, `SessionEnd`) call `clearForParent`, which drops everything —
  a node that is gone has no work left to represent. A **new turn** calls
  `clearFinishedForParent`, which drops only `state === 'done'`. "The previous fan-out is stale by
  definition" is true of a finished card and false of a working one: Claude launches subagents
  **async**, so *"waiting for N background agents to finish"* is exactly the state in which the
  next prompt gets typed, and nothing rehydrates `byId` afterwards (`start()` fires only from a
  live `PreToolUse`; a subagent past that emits no second one) — the card was gone for the rest of
  the run while the agent kept working. The expensive half is not the missing card: Eco's
  hibernation guard derives `liveSubagents` from this same store, so the wipe let a parent with
  live background agents read as idle and get its CLI `/exit`ed. Keeping an unfinished card then
  **owes a decay** — `useAgentNodes.sweepStaleWorking`, on the same 60 s tick and the same
  `WORKING_STALE_MS` as `agentStatus`'s (imported, never re-chosen: `shared/agents/stale.ts` exists
  because three surfaces each invented their own timeout) — or a subagent whose end never arrives
  pins its card, and its parent, forever. It marks the card **done** rather than deleting it, so a
  late `finish()` is the no-op it already was and the next turn boundary takes it.
  (Subagents share the parent's process — no PTY.) Each card shows
  duration/tokens/tool-uses and **expands** (click) to a **live transcript**:
  `core/subagent-tail.ts` resolves the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl`, matched by `tool_use_id` via the sibling
  `.meta.json`), tails it read-only, formats each line (assistant text + tool calls + results),
  and streams chunks over `agent:subagent-activity` into the store.
  **Codex** (2026-08-24, `spawn_agent` collaboration — issue #401) joined via its **native
  `SubagentStart`/`SubagentStop` hooks**, measured on codex-cli 0.146.0, keyed by `agent_id` (NOT
  `tool_use_id` — nothing correlates the spawn tool call with the Start it launches; agent_id is
  stable across the child's life, parallel + nested spawns included, and nested children fire
  through the same subscription so every card connects flat to the owning terminal node). Facts a
  refactor must not lose: **(1)** every agent_id-tagged codex event carries the PARENT's
  `session_id` with the CHILD's rollout as `transcript_path` — both raw listeners skip the
  context-meter track for them (else the parent's meter re-points at the child) and `normalizeCodex`
  returns null for child tool events (else a child Bash event flips a finished parent back to
  RUNNING after an async spawn); pinned by `hook-verified-parity.test.ts`. **(2)** the spawn task
  text is **encrypted end-to-end** (`tool_input.message` and the NEW_TASK payload are Fernet blobs)
  — there is no `taskLabel`; the readable `Task name:` header reaches the card via the activity
  stream instead. **(3)** the live tail is `subagentTail.trackFile` (the path is handed to us —
  no meta-dir matching) with the **stateful, per-entry** `createCodexSubagentFormatter`
  (`core/codex-subagent-format.ts`): a spawn child is a FORK of the parent thread, so its rollout
  opens with a replay of the parent's context, suppressed until the
  `inter_agent_communication_metadata` / NEW_TASK gate — per entry, because two concurrent
  subagents sharing one closure would gate each other. **(4)** codex's `SubagentStop` IS the real
  end (no async-launch-ack trap, no task-notification sniffing), carrying
  `last_assistant_message` as the card's result. Remote (SSH) codex nodes get cards but no live
  activity yet (the child rollout is on the host; claude's `remote-subagent-tail` has no codex
  counterpart — follow-up).
- **/loop, /schedule & /cron node** (agents in `RECURRING_CAPABLE`) — detected from the **tools**
  the agent invokes (robust; users often phrase it in natural language so the prompt rarely starts
  with the slash): `PreToolUse` for `Skill` (skill ∈ loop/schedule/cron), `CronCreate` (→ cron,
  label = cron expr · prompt), or `ScheduleWakeup` (→ loop) — plus a `UserPromptSubmit`
  `/loop|/schedule|/cron` prompt-prefix fallback, all surfaced as `recurring` normalized events.
  Sets `agentStatus.loop` ({count, prompt, items, kind}); for in-session `loop` each turn-done
  bumps the count + appends `lastMessage` (schedule/cron run in the background, so they aren't
  counted). Lifetime by kind: `loop` dies with its session; `cron`/`schedule` **outlive turns,
  sessions and app restarts** (`loop` is persisted in the agentStatus localStorage) and are
  cleared by a `CronDelete` `recurring`-end event or the card's own × (dismisses the card only).
  `clearForParent` (new turn) leaves the loop card's dragged position alone. Renders an ephemeral
  **LoopNode** labelled by kind, connected by an edge to the parent, plus a small header badge.
- **Branch conversation** — node action (`IconBranch`, Claude-only via `BRANCH_CAPABLE`): sends `/branch` into the
  existing terminal via `pty.sendText` (tmux `send-keys`) and opens a new Claude node that
  resumes the parked original with `claude --settings … -r <ORIGINAL_ID>`. The original id is
  the session id already known from hooks; `lib/claudeBranch.ts` is the fallback that parses
  `pty.capture` output when the id isn't known. The source node stays on the new branch.
- **Canvas control (manage-nodeterm-canvas)** — agents in `CANVAS_CONTROL_CAPABLE`
  (claude/codex/gemini/copilot/opencode/grok) can create/organize/control canvas nodes from inside their
  session: a POSIX **sh+curl** shim (`nodeterm.sh`, `CONTROL_SHIM_SCRIPT` in
  `main/canvas-control-core.ts` — the Electron-as-Node CLI is retired) POSTs
  **form-urlencoded** (`nodeId` + `arg.<flag>` fields; `curl --data-urlencode` is the only
  escaping sh can be trusted with — `parseControlBody` reads both this and the JSON dialect) to
  the hook server's `/control/<verb>` routes; `Accept: text/plain` makes the server render the
  reply (sh has no JSON parser). Env-gated on `NODETERM_CANVAS_CONTROL` (set by
  `buildPtyEnv`/`remoteHookEnvArgs` per `canControlCanvas`). Discovery: claude gets a
  `skills/manage-nodeterm-canvas/SKILL.md` (system `~/.claude` + each managed account dir);
  codex/gemini/opencode plus Copilot's `copilot-instructions.md` get a marker block
  (`<!-- nodeterm:manage-canvas:start/end -->`); **grok needs
  no installer at all** — it scans `~/.claude/skills` by default for Claude compat, so membership alone
  (which sets `NODETERM_CANVAS_CONTROL`) is the whole wiring. That premise rests on grok's shipped
  docs and is **unverified** (`grok inspect --json` never run); if it does not hold, grok takes the
  marker-block route instead — see docs/grok-agent.md.
  **Server creator ownership (2026-08 incident hardening):** enabled Server control accepts only
  verified node identity. `HeadlessNodeFactory` records which source node opened each new node in a
  process-local ledger; link/group/rename/color/sticky-update, message delivery, and close validate
  the whole target set as current-run creations before writing or killing anything. Queued messages
  revalidate creator ownership before flush. The ledger is intentionally empty after restart —
  project JSON, titles, hook history and tmux names are not creator proof — so
  boot neither attaches/creates backends nor sends persisted queued commands. A live backend with a
  durable arm remains untouched until an explicit owner action or browser view. `open-terminal` and
  `open-agent` are verified-only at the Server handler boundary. A plain terminal keeps generic
  node hook wiring but receives neither `NODETERM_AGENT_ID` nor `NODETERM_CANVAS_CONTROL`; missing
  identity never defaults to Claude.
  **SSH projects** (docs/ssh-agent-skills.md): the SAME shim + skill + blocks are installed on
  the remote host at connect (`RemoteHooks.installCanvasControl` + per-account
  `installCanvasSkillIntoAccountDir`), gated on the VERIFIED reverse hook tunnel — the shim
  carries no machine-specific paths and POSTs through the tunnel's unix socket, so remote agents
  control the desktop's canvas. The shim is generated source no compiler checks:
  `canvas-control-shim.test.ts` runs it for real (/bin/sh against a real hook server, port AND
  unix-socket transports) — keep it that way.
  **Keep the agent-facing text in sync with behaviour, in the SAME PR.** The verb help agents
  actually read is generated by `buildCanvasSkillBody` (the SKILL.md, rewritten into every config
  dir by `installCanvasSkillInto` on launch) and `buildCanvasControlInstructions` (the
  codex/gemini/copilot/opencode marker block) — both in `canvas-control-core.ts`. When you add or
  rename a verb, change a flag, or change what an outcome MEANS (e.g. PR 7 turned a busy target's
  `targetBusy` refusal into a deliver-on-idle queue), update those two functions in the same change,
  or the docs describe a product that no longer exists and an orchestrating agent acts on the stale
  contract. Derive from the code, never re-type: the retry guidance renders from `RETRYABLE`
  (`messagingGuidanceLines`) so a new outcome kind lands in the text the day it is added — prefer
  that shape over prose you have to remember to edit. `canvas-control-core.test.ts` walks both
  generated bodies and must red on the stale claim (it pins the queue wording and the RETRYABLE
  split); a doc line with no such test is a plan, not a fact — see the drift that shipped as #269.
  **Flag syntax**: `--flag value`, `--flag=value`, or a valueless flag anywhere on the line. The
  shim used to consume the next token after any `--flag` *unconditionally*, so `--read --node b1`
  became `arg.read=--node` with `b1` silently dropped and the server answering about the wrong
  flag; it now peeks. The trade: a value that itself starts with `--` must use the `=` form
  (`--cmd=--version`), which was previously unexpressible in either direction. Two parsers are in
  play and both are tested — the sh loop (`control-shim-parse.test.ts`, real `sh` + a fake `curl`
  that records argv) and `parseControlBody` reading what it built (`canvas-control-shim.test.ts`).
  **A new verb must not DEPEND on the fix**: the shim is rewritten locally every app boot but onto
  an SSH host only inside `RemoteHooks.setup()` (on connect), so an already-connected project keeps
  the old loop with no signal on the wire. Give every flag a value and both loops agree.
  **WHICH CANVAS ANSWERS, and why an open never moves the camera** (`renderer/lib/controlRouting.ts`
  + `renderer/lib/coldOpen.ts`). React Flow holds only the ACTIVE project's nodes, but every other
  open project's tmux sessions keep running, so a control call routinely arrives from a node the
  live canvas has never heard of. `routeControlSource` resolves the OWNING project
  (`active | switch | reopen | blocked | unknown`) — before that, every agent outside the project
  the app happened to come up on was rejected as *"source node is not a control-capable agent"*,
  which is a capability sentence for a routing failure. **That fix must not regress.** What it
  originally did with the answer was TRAVEL there (`travelToProjectRef`), and that was a screen
  hijack: the user looks at project B, an agent in project A runs `open-claude`, the tab switches
  and A's saved viewport is applied, so the camera appears to jump and zoom on a background agent's
  say-so. Two membership lists now decide, and their difference is the whole design:
  - `STORE_ANSWERED_VERBS` (`needsLiveCanvas` false) = **no canvas is needed at either end** —
    `list` reads names, `send`/`reply` deliver into a tmux PANE, `sticky` rewrites a note,
    `open-project` acts on the projects store.
  - `COLD_OPENABLE_VERBS` (`canColdOpen` — `open-terminal`/`open-claude`/`open-agent`) = **a canvas
    IS needed, but the serialized one will do.** `needsLiveCanvas` stays TRUE for them; they take
    the `--project` cold-open path (issue #338 §2.2) applied to their own project: the composed
    launch MOVES into `pendingLaunch` (`armForColdOpen` — `initialCommand` is never serialized), the
    node is upserted through `applyNodeMutation`, edges go through `appendCanvasLinks` (the edge
    counterpart, so the opener's rope and the fan-in bridge are not lost), `writeDisk` persists, and
    the reply is the ONE shared `coldOpenMessage` sentence with `queued: true`.
  Everything else keeps travelling **on purpose**: `write`/`close`/`group`/`move`/`arrange`/
  `align`/`verify`/`spawn-team`/`open-worktree`/`open-browser`/`show-*` read live canvas state the
  serialized copy does not carry (measured node sizes, worktree staleness, the React Flow edge
  arrays). Route `active` is byte-identical to before. Route **`reopen` (a CLOSED project) cold-writes
  too and does NOT reopen the tab** — closing is the user's explicit "park this, keep it running", so
  restoring the tab *and* activating it is the loudest form of the hijack; the reply names the closure
  so a caller does not report a session as started. On the cold path `--group`/`--after` ARE resolved
  (unlike with `--project`, where the ids would live in another project) against the serialized
  nodes, defaults come from the OWNING project (`projectPermissionMode(owner, …)`, its account,
  its `ssh`), and `--after`'s dep ropes are left to `missingDepRopes` at that project's next load.
  **Grouping verbs** (`group` / `ungroup` / `move` / `arrange` / `align`): `group` wraps **sibling**
  objects — nodes or frames — into a new frame in their shared container (a mixed-container set, or
  an ancestor plus its descendant, is refused with that reason); `ungroup --group <id>` dissolves a
  frame, promoting its direct children into the frame's own parent (nodes kept); `move
  --nodes <id,id> [--group <id>]` reparents nodes OR whole frame subtrees INTO a frame (or
  `top`/`none`/omit → out to top level) via `reparentNode` — the ONE way to move a node between
  frames, which `group` won't do; a cycle (a frame into itself or its own descendant) is refused.
  `arrange`/`align` now run in ONE coordinate space: all top-level, OR all children of one frame
  (`commonParentId` decides; a mixed set is refused, not silently subset-arranged — the old
  behavior). When the ids are a frame's children, the frame is shrunk to hug the tidied layout
  (`fitGroupToChildren`) — the fix for "grouping keeps scattered positions so the frame is too
  wide". `move` also re-fits the source + destination frames. All pure + tested in
  `state/workspace.test.ts` + `workspace.layout.test.ts`.
  **Fan-in (`link`, 2026-07):** a spawned fan-out was previously write-only — nodes an agent
  opened were joined to it by a **rope** (`project.ropes`, explicitly *"Display-only — never
  context links"*), so an orchestrator could not read back what its own team produced and the
  skill told it to have the USER relay results. Now `open-claude`/`open-agent`/`spawn-team` also
  draw a real **context bridge** (`project.bridges`) to each agent session they open, and the
  `link --to <id,id> [--from <id>]` verb links nodes the agent did not open (or two other nodes).
  The rope stays — the two edges mean different things (lineage vs readable context) and a
  non-context-capable target still gets only the rope. Deliberately **silent**: the manual
  `onConnect` path pushes a discovery note into both endpoints, but doing that per team member
  would inject a prompt into every session an agent just spawned — the exact intrusion that push
  was reverted for. Links are pull-based, so nothing is lost. The refusal matrix is the pure
  `planBridges` (`renderer/lib/noteLink.ts`, unit-tested); Canvas only wraps it in setState.
  Callers that create and link nodes **in the same tick** must pass their own `lookup` — `setNodes`
  is async, so resolving fresh nodes off `nodesRef` would skip every one as "no such node".
  **Dependency edges (`--after`, 2026-07):** `open-terminal`/`open-claude`/`open-agent` accept
  `--after <id,id>`, which opens the node **armed** — `data.pendingLaunch` ({after, command},
  `PendingLaunch` in shared/types) holds the launch the factory built, and Canvas fires it once
  every dep reports `done`. This is what makes the canvas a DAG instead of a fan-out. Load-bearing
  details: (1) **an unknown agent state is NOT "satisfied"** — right after a fan-out no upstream has
  emitted a hook event yet, and reading "no news" as "finished" would fire every dependent
  instantly; a **deleted** dep IS satisfied (it can never report); and a dep that is `done` with a
  live **`lastTurnError`** is NOT (issue #521, below). (2) Only `hasHooks` agents may be
  waited on — a plain terminal never reports done, so `resolveAfter` **refuses** it rather than
  letting `launchesToFire` (which cannot tell "never will" from "not yet") hang the node forever.
  (3) If the deps are **already satisfied at creation**, the node is NOT armed: the command stays
  `initialCommand` so the node's own mount path delivers it through `writeWhenShellReady` —
  arming would hand delivery to the canvas effect, which races the node's PTY into existence.
  (4) Delivery is **exactly-once via `launchInFlight`** (an id stays in the set forever once
  `sendText` resolved true — clearing `pendingLaunch` is a state update that can lag a re-render),
  and a **refused** `sendText` retries (`launchRetryDelay`'s backoff) instead of vanishing.
  (5) `pendingLaunch` **is persisted** (unlike `initialCommand`), but agent state is not — so after
  a restart nothing will ever report `done` and the node carries a manual ▶ **run-now** escape in
  its QUEUED badge (which disarms only on a delivery that LANDED — dropping it unconditionally
  threw the command away in exactly the state the button exists to rescue). (6) Canvas subscribes
  to `armedDepSig`, NOT `useAgentStatus(s => s.byId)` —
  the same discipline as `loopSig`; the full map re-renders the canvas on every hook event.
  Pure logic + refusal matrix in `renderer/lib/pendingLaunch.ts` (unit-tested);
  the dep→node edge is a **rope** (`ctrl-<dep>-<node>`, persisted in `project.ropes` like the
  opener's) whose LOOK is derived: dashed + ⏳ while the node's `pendingLaunch.after` still lists the
  dep, solid once it has launched (`lib/edgeModel.ts` `ropeVisual`, over the ONE `ropeInfoOf` lookup
  the render and BOTH delete paths ask — two builders would be two answers, and the label the user
  reads would stop describing what the delete does). The fan-in bridge `--after` also writes hides
  under that rope (`hiddenLinkIds`), so ONE edge per pair holds on the canvas. Deleting a WAITING
  rope drops that dep from `after` (`dropAfterDep`) and takes **nothing else** — the covered bridge
  survives, because "stop waiting for it" is not "stop being able to read its work"; an emptied
  list fires. Only the `open-*`/`verify` verbs write the rope, so `missingDepRopes` heals an armed
  node that has none at **project load**: `pendingLaunch` is persisted and the rope is not, so a node
  armed by any other path — or by a build older than this one — would otherwise hold a launch with
  no arrow saying what for. All edges route through the single `floating` edge type
  (`canvas/FloatingEdge.tsx`, a bezier between the MIDPOINTS of the two nodes' facing sides — one
  anchor per side, so a hub's arrows converge instead of fanning along its border; context and note
  links are restricted to the left/right sides, where the bridge handles sit; an unmeasured node
  draws nothing rather than a path to the origin) — no family sets a handle side;
  and a node whose eye is closed (`hideFanout`) hides every edge touching it as well as its cards
  (2026-09-02 edge model, spec in docs/superpowers/specs).
  **(7) Delivery waits for the node's PTY, and never fails silently** (issue #569 item 1, 2026-09).
  A satisfied dependency says nothing about whether there is a terminal to type into, and the
  original loop conflated the two: a flat 5 × 400 ms budget started when the CANVAS held the node
  and was spent on loading the canvas, mounting it and spawning tmux — so on a cold project switch
  the launch was abandoned before its session existed, in a `console.warn`, and the node read
  QUEUED forever with only the manual ▶ left. `TerminalNode` therefore publishes a **session-ready**
  signal (`isSessionReady` / `subscribeSessionReady`, module-level like `offscreenNodes`): true for
  an ADOPTED park (already typeable, and its create continuation ran on a previous mount) and, for
  a fresh spawn, at the SAME `whenShellSettled` moment `writeWhenShellReady` delivers an
  `initialCommand` — both write a CLI command line, and a line delivered across zsh's rc-file tty
  flush comes out mangled. A **park keeps it** (a parked tmux session is still addressable by name);
  only a real teardown clears it. The loop then WAITS instead of burning attempts, and the backoff
  (`launchRetryDelay`, ~12 s over five attempts) covers only the residual race after readiness.
  Because a wait with no end is the failure mode this replaces, both give-up states are **visible**
  in the transient `state/launchDelivery.ts` and rendered by the QUEUED badge's amber ⚠ + tooltip
  (`launchTooltip`, pure): `stalled` = gate open, no terminal yet, **still held** (raised by a
  `LAUNCH_STALL_MS` timer with a fire-time re-ask; the launch still fires whenever the session
  finally comes up — an SSH host reconnecting takes this path) and `failed` = the session came up
  and refused every attempt, so nothing will retry it. Neither is ever inferred from silence, and
  the tooltip names no cause it did not measure (the node's own overlay owns the diagnosis).
  The open verbs' replies carry the same fact for callers OUTSIDE the app: `result.queued` +
  `result.queuedIds` on `open-terminal`/`open-claude`/`open-agent`, always true for the
  `--project` cold-open branch — an orchestrator was previously told "opened" either way and
  routed work to a session that did not exist. Agent-facing copy is generated in
  `canvas-control-core.ts` and pinned in its test, per the sync rule above.
  **(8) An armed node must not cold-start its own agent** (found while fixing (7)). The mount-time
  cold-restore relaunch (`fresh && agentId && canResume(...)`) carries a second, independent
  refusal beside the `paused` one (`shouldColdResume`): `!data.pendingLaunch`. A first open is
  `fresh` by definition, so every `--after` / `verify` node
  was launching a bare CLI on mount — the session the hold exists to prevent — and the held launch
  then arrived as TEXT typed into it rather than as the command it is. The delivery race used to
  mask it; gating delivery on the shell settling would have made it deterministic.
  **(9) An ERRORED upstream does not release its dependents** (issue #521, 2026-09).
  `--after` fires on idle, and a station whose turn dies on an API/model error reaches idle
  **immediately** — so a malformed-prompt station looked healthy from every surface an
  orchestrator can read, and the whole chain armed behind it launched on what it had not
  produced. The signal was already there and was being thrown away: claude and grok both fire
  **`StopFailure`** instead of `Stop` on an errored turn (already in `CLAUDE_HOOK_EVENTS` /
  `GROK_HOOK_EVENTS` — without the subscription the badge sticks on RUNNING), and both
  normalizers collapsed it to a plain `done`. It now carries **`errored`** on
  `NormalizedAgentEvent`, which `agentStatus` keeps as **`lastTurnError: {at}`**.
  Three things about the shape, each deliberate: (a) it is an **annotation, not a fifth
  `AgentState`** — an errored station IS idle, the two facts coexist, and a fifth state would
  ripple through both raw listeners, the parity test and the mobile mirror for a fact that is
  not a state; (b) it is set in `src/shared`'s normalizers, so **both shells change by
  construction** — there is nothing to keep in parity; (c) it is **TRANSIENT** like `state`,
  because after a relaunch nothing armed can fire anyway and a restored verdict would describe
  another app run's turn. It is **cleared by the next genuine new turn** — not by any
  intermediate transition, which says nothing about whether that turn produced something — so
  the refusal ends by itself when the station answers successfully. Firing with a WARNING was
  considered and dropped: a dependent that has launched cannot un-launch. Surfaces: a
  **TURN FAILED** chip on the node (red, no pulse — a verdict on a turn that is over, not
  something being waited for), the QUEUED tooltip naming the errored upstream instead of
  promising a wait, and a **`LAST TURN ERRORED` marker on the `list` rows** — on the ROW
  because a seven-station fan-out should cost one call to learn this, not seven. **No error
  TEXT is claimed**: whether the hook payload carries the failure message has not been
  measured, and `last_assistant_message` is the previous assistant turn rather than the error,
  so reporting it as "the error" would be a confident wrong fact. Reading the text, and the
  *failed-to-start* watchdog (a station that never emits ANY hook event — the opposite failure,
  which hangs dependents honestly rather than firing them wrongly), stay open.
  **Review panel (`verify`, 2026-07):** `verify --node <id> [--lenses …] [--focus …] [--agent …]
  [--synthesis off]` opens one reviewer per LENS, each armed behind the target (`--after`) and
  bridged to it, wrapped in a `Verify: <title>` group, plus a judge armed behind the whole panel.
  It is **composition, not new machinery** — the two primitives above are the whole implementation.
  Prompt/lens logic is the pure, unit-tested `renderer/lib/verifyPanel.ts`; two wordings there are
  load-bearing and must not be "tightened away": reviewers are told **not to edit** (a panel is N
  agents pointed at ONE checkout — review and repair are different jobs, and only repair needs
  worktree isolation) and are explicitly **licensed to find nothing** (a reviewer under implicit
  pressure to produce findings invents them, and an invented finding costs someone else the time to
  disprove it). Unknown lens words are **kept** with a generic brief, not rejected — a table that
  only accepts what it already knows would be useless for the review nobody anticipated. Reviewers
  inherit the TARGET's `accountId` (its transcript resolves inside that account dir), not the
  caller's. The judge is armed on ids that exist only in that tick, which is why `armAfter` takes
  `extraLive` — without it the reviewers would look *deleted*, deletion counts as satisfied, and
  the judge would fire before a single review existed.
- **Context Link** — a node action gated by `CONTEXT_LINK_CAPABLE` (claude/codex/gemini/opencode/grok;
  custom agents + plain terminals excluded). **grok joined in 2026-09, and the file matters:** its
  readable conversation is `chat_history.jsonl`, NOT the `updates.jsonl` its own hook payloads
  advertise and this line used to name. Routing through the advertised path does not error — it opens
  a real file, parses nothing, and hands the linked agent an EMPTY transcript with no diagnostic, so
  a reader who trusts the old wording will build the silent failure this note exists to prevent
  (`core/handoff/locate.ts` pins it): drawing an edge between two builtin-agent nodes lets each
  READ the other's context on demand (pull, not push). Architecture (2026-07, SSH-capable — see
  docs/ssh-agent-skills.md): the **desktop does the reading AND the parsing**; the CLI the agent
  runs (`context.sh`) is a thin POSIX **sh+curl** shim that POSTs to the hook server's
  `/context-link/<verb>` route and prints the text/plain reply (the Electron-as-Node CLI is
  retired — its embedded-JS parser now lives as tested TS in `core/context-link-render.ts`:
  parsers for **all four** formats — claude JSONL / codex rollout / gemini event-sourced chat /
  opencode export — plus `renderContextLink` over injected fetchers). `src/core/context-link.ts`
  holds the link docs in memory (per-node files under `<userData>/context-links/` remain as a
  debug aid), carries per-entry `agentId`/`sessionId`/`accountId`, and answers the route;
  **authorization** = the doc is selected by the REQUESTER's node id, so a token-holding caller
  can only read nodes in its own (directional) link map. Codex/gemini paths resolve via the
  handoff locators (`locateCodex`/`locateGemini` by sessionId); claude keeps the hook-fed path +
  `locateClaude(sessionId, accountId)` fallback (cwd-newest is claude-only); Canvas rewrites link
  files when a linked node's sessionId appears (`linkSessionSig`). **SSH projects:** the shim +
  skill are installed on the remote host at connect (`RemoteHooks.installContextLink`, gated on
  the VERIFIED reverse hook tunnel; POSTs ride `--unix-socket` through it); a remote node's
  transcript is read over the ControlMaster (`initContextLink(ptyManager, deps)` — `src/main`
  injects `isRemoteNode`/`readRemoteFile`/`runRemoteCommand`, bounded tail reads), its hook-fed
  path is jailed at ingest (`isSafeRemoteTranscriptPath`), and `resolveLinkTranscript` REFUSES
  the local locators for remote nodes (they'd resolve a stranger's local transcript). Server
  Edition IS wired (`src/server/context-link.ts` calls `initContextLink(ptyManager, {})`) but
  passes no remote deps → **local-only**, which is the complete answer there: that shell runs ON the
  host whose transcripts and tmux it reads, and SSH projects are a desktop-only concept. Discovery is per-agent: claude installs a
  `get-linked-context` skill; codex/gemini get an idempotent marker block
  (`<!-- nodeterm:get-linked-context:start/end -->`) merged into `~/.codex/AGENTS.md` /
  `~/.gemini/GEMINI.md`. On connect an idle-gated one-line note is injected into each endpoint
  (claude → skill pointer; codex/gemini → inline CLI command via `contextLink.info()`).
  (Replaced the earlier MCP-based bridge.)
  **Note links:** a sticky note can be connected to ANY terminal node (one-way, sticky →
  terminal). On connect, agent sessions get a one-shot idle-gated push of the note text
  (`buildNotePushMessage`, single-line, truncated at 2000 chars); plain terminals get no
  push (sendText appends Enter — the text would execute). The note's live text also rides
  the link file (`ContextLinkInfo.note`), so Claude reads the current text via the
  get-linked-context CLI (`summary`/`transcript` print it; `list` marks `(note)`). Pure
  edge/push/map logic in `renderer/lib/noteLink.ts`.
- **Managed Claude accounts** (Claude-only) — run several logged-in Claude identities side by
  side by giving each its own config dir. `settings.claudeAccounts` is a list of `ClaudeAccount
  {id, label, email?, host?, pending?, createdAt}` (in `settings.json`; the account **list** is
  config, not credentials). Isolation is **config-dir**, not token storage: a local account's dir
  is `{userData}/claude-accounts/<id>` (`claudeConfigDirFor` / pure `accountConfigDir`),
  a **remote** account's is `~/.nodeterm/claude-accounts/<id>` on its `host` (keyed by
  `sshHostKey` = `user@host`; `remoteAccountConfigDir` is `~`-relative for ssh expansion,
  `remoteAccountConfigDirAbs` resolves it against the connection's `remoteHome`). The **claude
  CLI owns login, credential storage, and token refresh** inside that dir — the app NEVER writes
  credentials. On macOS this works because Claude Code **≥ 2.1** scopes its Keychain service per
  config dir (`Claude Code-credentials-<sha256(configDir)[:8]>`, `claudeKeychainService`); on
  < 2.1 one unscoped service is shared → accounts collide, so add-account **warns** (`claude
  --version`, `isSupportedClaudeVersion`).
  - **`data.accountId` (terminal nodes)** — resolved **once at node creation**
    (`resolveNewNodeAccount`: explicit submenu pick → `project.defaultAccountId` → system default
    `~/.claude`), then **immutable** and **persisted** (serializers). `undefined` = system default
    = **bit-for-bit legacy behavior** (no env touched). Inherited by **Branch** (the
    terminal→chat fork it also fed is gone — the SDK chat node was removed 2026-07). Two #419
    rules inside the resolver: the submenu's **System row passes `null`** (an EXPLICIT system
    pick that skips the project default — before that, the row wearing the system email launched
    the project-default account), and validation runs against `accountsForProject`, not the raw
    list, so a **pending** account or one **pinned to another machine's host** is never stamped
    onto a node it cannot run on (both used to reach the missing-dir fallback at spawn).
  - **`boundAccountId(accountId, agentId)` (`shared/agents/account-binding.ts`) is the ONE rule for
    whether a node is account-bound at all**, and it feeds `data.accountId` *and* the account color
    from a single decision — split them and a node carries an account it is not painted for, or is
    painted for one it does not carry. Two surfaces mint nodes and both ask it: `createAgentNode`
    (canvas) and `appendProjectNode` (the phone's `projects.registerNode`, which used to write
    whatever the wire sent, so a gemini node could come back bound to a Claude account). Managed
    accounts belong to the builtin **claude and codex** (S6); a **known** other agent — builtin or
    custom, since a custom agent inheriting one of those harnesses is still its own agent — never
    binds. **An UNSTATED agent keeps its binding** — the asymmetry is deliberate: the phone chooses
    `agentId` and `accountId` independently and is not known to always send the first
    (docs/ios-protocol-migration.md §6), dropping a real binding is the wrong-identity bug the
    field exists to prevent, while a stray one on an agent-less node only sets a config-home
    variable nothing reads. On the canvas `agentId` is always stated, so that path is bit-for-bit
    what it was. `main` resolves the color off the RAW id and lets the registrar refuse it, rather
    than re-deriving the gate at the call site.
  - **Account default node color (`ClaudeAccount.color` / `CodexAccount.color`, optional)** — a
    per-account default node color (Settings → Accounts) that beats the agent's own brand color in
    `createAgentNode`, so a second login is recognizable on the canvas. Read off the SAME
    `boundAccountId` that stamps `data.accountId`, so the color and the binding cannot drift.
    Applied **at creation** and baked into `data.color` like any other node color: a hand-picked
    node color is never overwritten and editing the account later repaints nothing. Unset / stale
    id / an agent that takes no managed account ⇒ the agent's color, unchanged.
    **Which list answers is `agentAccountColor`'s alone** (`shared/agents/account-color.ts`, one
    definition shared by `createAgentNode` and the phone-registered node path in `src/main`):
    claude reads `claudeAccounts`, codex reads `codexAccounts`, everything else reads nothing. The
    two lists are keyed **independently** — nothing stops the same id appearing in both — so a node
    colored from the other list would be repainted from a stranger's row; the swatch UI is one
    component (`AccountColorSwatches`) rendered by both row kinds for the same reason.
    The value is **re-validated as a string** at the read: the account lists come out of a
    hand-editable settings.json that nothing checks field-by-field on load, and a `"color": 123`
    would throw on `.trim()` INSIDE `createAgentNode` — stopping every new node under that account
    from opening, with nothing pointing back at the edited file.
  - **Env injection** — `pty-manager` sets `CLAUDE_CONFIG_DIR` in the spawn env AND as a tmux `-e`
    (local); for a remote node it emits an **absolute-path** remote tmux `-e` built from the
    connection-cached `remoteHome` (skipped **fail-open** if home is unresolved). `AUTH_ENV_STRIP`
    (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) is deleted from the
    child env so a stray env key can't shadow the account. A **missing** account dir → warn +
    silent system fallback. **The account-scope names ride the LOCAL conf's `update-environment`
    (`ACCOUNT_SCOPE_UPDATE_ENV`, issue #419)** — the shared tmux server inherits the env of the
    client that STARTS it, so a server started by a managed-account node used to leak that
    account's `CLAUDE_CONFIG_DIR` (and any un-stripped auth key) into every session created
    without a `-e` override: system nodes, plain terminals and the missing-dir fallback silently
    ran as that account ("the system account is entangled with the next account in the list").
    Listing the names makes tmux copy each from the creating client's env and **strip it when the
    client lacks it** (proven against a real tmux in `account-env.realtmux.test.ts`, seeded-server
    case included; `ensureUpdateEnvKeys` retrofits a long-lived pre-fix server). The same listing
    is what makes codex's explicit system-scope overwrite (`CODEX_HOME` /
    `NODETERM_CODEX_ACCOUNT_ID`) actually reach sessions on a shared server. **LOCAL conf only**
    — the remote conf must NOT get these names: a remote attach client's env is the login
    shell's, and the copy/strip would run against that wrong environment (pinned in
    `ssh.test.ts`).
  - **Login flow** — Settings → Accounts → **Add** creates a `pending` account and drops a canvas
    **login node** that runs `claude /login` under the account dir. Core polls the dir's
    `.claude.json` (`LOGIN_POLL_MS` 2 s, up to `LOGIN_TIMEOUT_MS` 5 min) for `oauthAccount.email`;
    on capture the account flips out of `pending` with its email as the default label. Account
    removal cancels any pending wait + `markDirty`. **Codex accounts have the same two halves** —
    `createCodexAccountLoginNode` (`codex login`, title "Codex login") behind the
    `nodeterm:add-codex-account-login` listener, with `codexAccounts.waitLogin` polling the managed
    home's `auth.json`. Both flows mint an **agent-less terminal** carrying only `accountId`, and
    that shape is why `needsCodexAccountScope` takes an `isCodexAccount` resolver rather than
    reading `!!accountId`: the two account lists share an id alphabet, so the id alone cannot say
    which provider it belongs to. Guessing "codex" refused every managed **Claude** node (#345);
    guessing "not codex" would let `codex login` write into the system `~/.codex`. A dispatch with
    no listener is a silent no-op, which is how the Codex half shipped inert (#346) — pinned now by
    `renderer/lib/nodeterm-events.test.ts`, which fails on any `nodeterm:*` event that is sent but
    never heard. **All THREE login factories take a `cwd`** (`createAccountLoginNode`,
    `createCodexAccountLoginNode`, `createSystemLoginNode`), and every call site passes the active
    project's — a login node with none starts in `$HOME`, and an agent CLI whose trust check is
    keyed on the cwd (Claude Code's is) then asks the user to trust their entire home directory,
    SSH keys and cloud credentials included, before an OAuth round trip that touches no files
    (issue #553; a persisted "yes" there grants that workspace for good). It is not a promise the
    prompt disappears — an untrusted project still prompts — it makes it the exception rather than
    the rule, without nodeterm writing another tool's trust config on the user's behalf. A
    **remote** login ignores the local path: `createTerminalNode` prefers `ssh.remoteCwd`, which is
    the only cwd that means anything for a session running on the host. An SSH project has no local
    `cwd`, so a LOCAL account added from one still opens in `$HOME` — the honest answer, since that
    project owns no local directory.
  - **The lifecycle is CORE, and both shells register it** (issue #313) —
    `core/claude-accounts-service.ts` owns the five `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove / link) behind `platform().handle`; `main/claude-accounts.ts` is a thin desktop
    wrapper and `registerCoreHandlers` calls the same `registerClaudeAccountsIpc()`. Two optional
    deps carry everything core cannot reach: `installSkill` (desktop passes `installCanvasSkillInto`;
    an enabled Server canvas-control runtime installs its Server-specific skill separately) and
    `remote`, a **thunk** resolving the SSH legs
    (desktop's manager is created after the registration, and the server has none — in both cases
    an `AccountCtx` carrying a `projectId` degrades to the LOCAL path, which is the pre-existing
    behavior this preserves). **Three surfaces:** Desktop unchanged (same channels, same shapes,
    same remote fallbacks); **Server Edition** now full — real `buildClaudeAccountsApi` over the
    ws-bridge (the 5-min `waitLogin` is a straight passthrough because RpcClient has no request
    timeout), minus SSH accounts and the canvas skill; **Mobile: N/A** — the phone launches with
    the accounts the agent-status mirror advertises and never mints one. **Managed CODEX accounts
    stay desktop-only** and their bridge namespace stays an `E_UNSUPPORTED` stub: the switch verbs
    authorize the owning window by Electron WebContents id, which has no meaning over a WS
    connection. The Settings section now *names* that refusal instead of leaving an unhandled
    promise rejection — a spinner that stops and says nothing reads as a dead button.
  - **Hook install** — the managed hook is merged into **each account dir's** `settings.json` at
    add-account **and** at app launch (local, shared `install-helper.ts`) / via
    `RemoteHooks.installIntoAccountDir` (remote), so every identity reports agent status. The
    launch-time loop is ONE function (`installHooksIntoLocalAccounts`, beside the service) that
    both shells call — the desktop passing the canvas skill as its `extra`. A second copy is the
    drift this file warns about elsewhere: the Server Edition shipped without the per-account leg
    entirely, so a managed account there reported no agent status at all.
  - **Account-aware readers** — transcript resolution is scoped per account (`transcriptRootFor`
    picks the account dir's `projects/`, composite cache key includes `accountId`); the same
    threading runs through the session-name poll, restart handoff, and `ChatPanel` (the ⌘M
    transcript view, `chat.readTranscript`). The **usage indicator** is per account (`claude-usage.ts`: scoped Keychain
    service first, legacy unscoped fallback; popover lists a row per account with **System**
    first). **Remote (SSH host) accounts are included** — see **Remote usage** below.
  - **Pickers** — New Claude exposes an account **submenu** (pane menu; flat entries in
    the dock; palette commands; TabBar sets the **per-project default**). A **local** project
    lists local accounts, an **SSH** project lists only accounts whose `host` matches its
    connection; both offer a **System account** option. An SSH project whose host has **no**
    matching accounts gets a disabled hint row instead of a bare System-only list
    (`sshAccountsHint` — pane submenu, dock, TabBar; the palette deliberately omits it: a
    disabled row would surface as a search result) saying accounts for this host are added in
    Settings → Accounts while the project is connected — local accounts being invisible there is
    correct (their credentials aren't on the host) but read as "multi-account is broken on SSH".
  - **Remote accounts** — selection + login + env injection, plus **usage** (below); no
    per-account transcript readers beyond env.
  - **Linked accounts** (`ClaudeAccount.configDir`) — a PRE-EXISTING local config
    dir the user already drives themselves (`export CLAUDE_CONFIG_DIR=~/.claude-2; claude …` in a
    plain terminal) adopted as a first-class account without a login node. Settings → Accounts →
    **Link existing config dir…** (or one click on a **Detected** dir) calls `claude-accounts:link`
    (core service): `~` expansion → `normalizeLinkedConfigDir` → string-only refusals (the system
    `~/.claude`, anything under `{userData}/claude-accounts`, an already-linked path) → `stat` →
    email from `<dir>/.claude.json` (missing = `email: null`, not an error) → managed hook install.
    `claudeConfigDirFor(id)` consults a **registered accounts source**
    (`registerClaudeAccountsSource`, both shells right after `settingsStore.init()` — BEFORE the
    mirror settings provider can flush, or the phone would be advertised a non-existent managed
    dir), so env injection, `transcriptRootFor`, the transcript index, usage rows and the pickers
    all resolve a linked id to the user's own dir with no per-caller branch. The transcript jails
    (`isSafeLocalTranscriptPath`, both raw listeners) accept `<linkedDir>/projects/**` for dirs
    **from settings only** — never a dir named by the POST. **Removing a linked account only
    forgets the record**: the `rm -rf` names `accountConfigDir(userData, id)` directly, so it is
    structurally incapable of reaching outside the managed root even if the settings row is gone
    before the IPC lands. The hook installer writes `settings.json` THROUGH a symlink
    (`writeFileSync`) — a profile whose `settings.json` symlinks to `~/.claude/settings.json` (the
    two-profile layout) stays a symlink; pinned by `claude-accounts-link-symlink.test.ts`, and
    switching that write to `renameAtomic` would be the regression (it replaces the link).
  - **Observed account** (`ObservedClaudeAccount`, `NormalizedAgentEvent.account`) — which account
    a session is ACTUALLY on, derived by the hook server from the payload's `transcript_path`
    (`<configDir>/projects/<slug>/<session>.jsonl`; `configDirFromTranscriptPath` walks up to the
    LAST `projects` segment, so `~/projects/.claude/projects/…` names `~/projects/.claude`, not
    `~`). `classifyClaudeConfigDir` is pure string matching, host-agnostic: managed local root →
    managed remote pattern (`…/.nodeterm/claude-accounts/<id>`) → linked (settings) → any
    `…/.claude` ⇒ system (`accountId: null`) → else `known: false`. It is a **LABEL** exactly like
    `verified`/`clientRevision`: attached to the normalized event in ONE place (the hook server),
    so both shells inherit it and neither raw listener changes; claude events only; never throws;
    **never reads the filesystem** (a forged POST naming `~/.ssh/projects/x` gets `known: false`
    and nothing is opened). Recorded by the mirror (`MirrorEntry.account`) and the renderer store
    (`agentStatus.account`, persisted like `agentId` — a hand-launched claude's identity exists
    nowhere else). **Effective account for READERS** = `data.accountId ?? observed.accountId`
    (`renderer/lib/accountChip.ts` `effectiveAccountId`): `readSessionName`, `context.ensure`, the
    transcript search and the ⌘M view use it; **spawn/env never does** (launch identity stays
    creation-time). The **account chip** (`components/AccountChip.tsx`, ONE component on the node
    header, kanban card, card modal and sidebar row) shows for any non-system account, and for
    system panes only when ≥ 2 distinct account keys (`sys` / `<id>` / `ext:<dir>`) are live on the
    core (`hasMultipleAccountKeys`, a primitive selector so headers don't re-render on every hook
    event). An unlinked dir is named by its last path segment (`.claude-2`, dashed chip) with a
    tooltip pointing at Settings → Accounts, where **Detected config dirs** lists it for one-click
    linking. Mobile: N/A (additive mirror fields).

- **The usage indicator is scoped to the ACTIVE project** (`renderer/lib/usageScope.ts`, pure +
  unit-tested) — it describes **the machine that project runs on**, and nothing else. A local
  project shows this machine (system + managed local accounts + the billing providers, whose
  credentials are all local); an **SSH project shows only that host's Claude accounts** — no local
  Claude, no local providers, no other host. Without this the panel showed every source at once:
  each addition was individually reasonable and the sum was unreadable, numbers from three
  machines sharing one line with nothing saying which was which. Deliberately NOT narrowed to the
  project's `defaultAccountId`: the local side lists every local identity, so the machine is the
  scope and the account is a row within it. The pill spells out the scoped machine's **system**
  account (falling back to the first identity with data, so a host used only through a managed
  login isn't blank), managed accounts stay popover-only — the rule the local side always had.
  `usageScopeKey`/`scopeFromKey` exist because the active project object is rebuilt on every node
  serialization: the zustand selector returns ONE primitive so the indicator doesn't re-render on
  every canvas edit. ⟳ refreshes only what is on screen, and `usage.remote({hostKey})` reads only
  that host (cache eviction still runs against the FULL target list, so switching between two SSH
  projects doesn't throw each host's cache away).

- **Remote usage** (SSH hosts, `src/core/usage/remote-claude-usage.ts`) — the source behind the
  SSH scope above. v1 excluded remote accounts, which left a user whose Claude only ever runs on a
  server staring at an empty indicator while the host had perfectly good numbers.
  **The token never leaves the host.** The desktop could `cat` the remote `.credentials.json` and
  call the API itself — it already reads remote transcripts over the same master — but a bearer
  token pulled off a (possibly shared) server into another machine's memory buys nothing: the host
  can make the request itself. So core generates a POSIX **sh+curl** command, the shell runs it
  over the project's ControlMaster, and only the JSON answer comes back. Three details are
  load-bearing:
  1. **The token is piped into `curl --config -`, never `-H` on the command line** — argv is
     world-readable via `ps` on a shared host.
  2. **`.credentials.json` holds more than one `accessToken`** — every MCP server the CLI has
     authorized keeps its own under `mcpOAuth`. The extraction narrows to the `claudeAiOauth`
     object first (exactly as the local `parseCreds` does), because grabbing the file's first match
     sends an MCP token to the endpoint, earns a 401, and reports a signed-in host as signed out.
     Caught only by running the command against a REAL credentials file — which is why
     `remote-claude-usage.test.ts` runs the generated script under a real `/bin/sh` against a fake
     `$HOME` + fake `curl`, the same discipline as the canvas-control shim.
  3. **A read that could not run is `error`, never `unavailable`** — a dead master says nothing
     about whether the account has a subscription, and 'unavailable' silently drops the row.
  Shape: `remoteUsageTargets` (pure) elects ONE connected project per host (several projects share
  a host's `$HOME`) and offers its system `~/.claude` plus every managed account pinned to that
  host. The service (`usage:remote`) caches per target under the usual debounce, evicts targets
  whose host disconnected, and coalesces concurrent reads. **On demand, never polled** — each row
  is an ssh exec plus an HTTPS request on someone else's machine; the renderer asks on mount, on
  popover open, on ⟳, and when the active project's connection comes up (an SSH project is opened
  before its master is ready). Deps are injected exactly like
  Context Link's (`src/main` supplies the ControlMaster; **Server Edition passes none** ⇒ `[]`, so
  the UI needs no capability check). Own Settings switch (`claude-remote`), because hiding local
  Claude usage must not silently take the hosts down with it. **Mobile: N/A** — the
  slice pushed to a host still drops `usage` (a host reading its own numbers back off us is
  pointless), and no keychain leg exists remotely (a headless macOS host would hang on the prompt,
  so a mac host reports nothing).

### Adding a new agent (or a new model) — what to watch out for

Every rule below is a mistake the grok branch or the codex/gemini-parity branch **actually made**, and
each one cost a review round or shipped a wrong number to the user. Read the concrete failure, not the
principle. Per-agent write-ups: `docs/grok-agent.md`, `docs/gemini-agent.md`.

**The mechanism**

1. **A capability is a membership list plus ONE leaf.** Add the id to the list in
   `src/shared/agents/config.ts`, write the one per-agent thing that list gates (a normalizer, a
   reader, a table row), and every consumer lights up — the whole point of the design. What you must
   never do is fork behavior at a call site with `=== 'claude'`; ask through the helper.
2. **Ask what ELSE the list gates before joining it.** `hasUsage` gated **three** features, not one.
   Joining `USAGE_CAPABLE` for the context meter also switched on `context.ensure` and the find bar's
   transcript index, both of which resolve through *claude's* `resolveTranscript` — whose **cwd
   fallback** then handed a codex node **the newest claude transcript for that cwd**: a stranger's
   session as its meter (wrong numerator *and* denominator, flapping against the correct tail) and that
   session's messages as its search hits. Preconditions were default-true, so it would have shipped.
   The fix was a new pure predicate (`readsClaudeTranscript`) reusing an existing list, not a fourth
   list meaning the same thing. **Grep every consumer of the helper before you add an id to its list.**
3. **A read leg and a write leg are different facts, and may need different lists.** Gemini names its
   own sessions but has **no rename command**, so `TITLE_READ_CAPABLE` (read) split from
   `RENAME_CAPABLE` (write), with `read ⊇ write` pinned as an invariant. One list would have lit the
   rename UI on a node where the write silently does nothing — the worst kind of feature, one that
   looks like it worked.
4. **State Desktop / Server Edition / Mobile for the capability, even when the answer is "N/A".**
   Put the logic in `src/core` behind `CorePlatform` or the Server Edition silently doesn't have it,
   and give `window.nodeTerminal` a REAL bridge implementation or a documented degrade — a `noop` stub
   compiles fine while doing nothing. (Live example: the session-title READ has no server handler at
   all, so it is stubbed for **claude too** — a pre-existing gap that keeps being rediscovered per
   agent.)

**Measuring the CLI**

5. **Measure the CLI; do not assume claude's shape.** Three real bugs, all from assuming:
   - grok's `--` is **end-of-options**, so a flag appended *after* the prompt separator is a
     positional — silently swallowed into the prompt, or a clap usage error that kills the launch.
     Where the flag lands is decided at the **composed** layer (`createAgentNode`); a
     `withPermissionMode` unit test passes while the composed line is wrong.
   - codex's `total_token_usage` is **CUMULATIVE**, not the live context: against its own window it
     rendered a 13%-full session at **79%** and would have crossed 100% two turns later. The right
     field is `last_token_usage`.
   - `cached` tokens are **INSIDE** `input` for codex and gemini, and **OUTSIDE** it for claude (whose
     reader therefore sums them). Copying claude's formula double-counts. **Do not unify the
     formulas.**
6. **Prefer the agent's own stated number over one you infer.** Codex prints
   `model_context_window` right beside its usage — use it. When there is none, mirror the CLI's own
   resolver rather than building a per-model allowlist: gemini's `tokenLimit()` is a family rule with
   a **1M catch-all default**, so an unreleased model gets the *right* answer where an allowlist would
   be confidently wrong, silently. **And if you cannot establish a trustworthy denominator, ship no
   meter** — a percentage over a guessed window is a wrong number presented as a fact. This used to
   cite grok as the example of having no meter; grok turned out to be the BEST case for this rule,
   stating `contextTokensUsed`, `contextWindowTokens` **and** the resulting `contextWindowUsage` in
   `signals.json` (all three present in 22 of 22 measured sessions, and the stated percentage agrees
   with the division in all 22 — an oracle pinned as a test). What was missing was never the number:
   it was a comment nobody could check, naming the wrong file.
7. **A closed set beats a substring, for notification/event types.** Grok's
   `type.includes('permission')` matched a notification grok fires before *every* tool call, so a
   working node strobed NEEDS YOU: unread dot + chime + OS notification + phone inbox card, per tool
   call. Gemini is matched `=== 'ToolPermission'` and stays quiet on an unknown type. A badge stuck on
   a finished node has no later hook to clear it, so widening "to be safe" is the unsafe direction.
8. **"Supports" can be as dishonest as "doesn't support."** Codex claimed `manual` / "Ask each time"
   while emitting **no flag** — but its built-in default is `OnRequest` ("the model decides when to
   ask"), so two dropdown entries collapsed onto one behavior under a label that promised otherwise.
   Rule: a mode the CLI cannot express emits **no flag** (never a substituted nearest match), and a
   mode it *can* express must actually emit it. Derive the UI copy from the mapping
   (`unsupportedModesNote`, `permissionModeAgentIds`) so a sentence cannot drift from the table.
   **The nearest match is most dangerous on the DEFAULT mode:** gemini has no value for `auto`, and
   `auto` is `DEFAULT_PERMISSION_MODE`, so translating it to `auto_edit` ("auto-approve edit tools")
   would have widened permissions for every existing gemini node at upgrade, with `modeSupported`
   answering `true` so the derived copy stayed silent. Check what an UNTOUCHED setting emits before
   you accept any mapping.
9. **A capability gate that is fed by a version probe belongs to the agent it probes.** Claude's
   `auto` gate is fed by `claude --version`; applying it to any other agent downgrades that agent's
   sessions on a machine whose *claude* is old or absent. `activePermissionMode` gates only
   `'claude'`, and every hint string names Claude for the same reason. An agent needing its own gate
   adds one beside claude's.

**Not writing the same rule twice**

10. **A duplicated rule drifts, and this branch was bitten three times.** The remote installer's hook
    event lists (it subscribed gemini to *claude's* event names, so remote gemini reported nothing at
    all), grok's raw-listener field decoding, and the two shells' session-name sweep gates (reverting
    both to `canRename` left the entire suite **green** while silently skipping every gemini node).
    The fix each time was **one definition in `src/core`** consumed by both shells — a default inside
    core beats an argument each shell passes correctly today.
11. **Both shells' raw hook listeners must stay in parity** (`src/main/index.ts`,
    `src/server/agent-status.ts`). If you add a branch to one, add it to the other or write down why
    not (the desktop's extra skip for remote SSH nodes is a legitimate asymmetry: the server has no
    SSH-project manager).
12. **Widen the transcript-path jail per ROOT, never to `$HOME`.** Hook POSTs can arrive over the
    remote reverse tunnel, and `isSafeLocalTranscriptPath` exists so a forged one cannot aim a read at
    `~/.ssh/id_rsa`. Add the narrowest directory that holds the transcripts (`~/.gemini/tmp`,
    `<codexHome>/sessions`) and honor the agent's own relocation env var — getting that wrong fails
    **closed** (the meter silently never fills), which is the quieter and therefore worse failure.
13. **Re-validate a hand-editable value at the interpolation site, not by its type.** Modes come from
    git-shared JSON and end up on a tmux `send-keys` line. A table lookup guarded only by
    `mode in table` accepted a forged `constructor` and returned a **Function** headed for that
    command line; `isPermissionMode` at the top of `approvalFlags` is what closes it. Same rule as
    `SAFE_SESSION_ID`. An unrecognized value must yield the **bare, safe** command.

**Degrading, and admitting what you did not measure**

14. **A guess must degrade to nothing, never to something wrong.** A title reader that cannot resolve
    returns `null` (the node keeps its own name); an unknown notification type is a no-op; a failed
    probe means the bare command, never a blocked launch. Say in the code which facts are *composed*
    rather than captured (gemini's resumed-transcript shape is) and what the wrong-guess cost is.
15. **Kill the "in place" actions carefully.** An exit sequence must be the CLI's documented primary
    and **bare**: gemini's `/quit` also takes `--delete`, which exits *and permanently deletes the
    session history* — the very conversation the restart exists to resume. It has its own test.
    Refuse the restart while the node is `working` **or** `blocked`: an exit line typed into a
    permission prompt **answers** it.
16. **Write the device checklist for what you could not run.** Every unverified claim becomes a
    numbered item; group the ones that fall out of a single capture run. `docs/grok-agent.md` §9 and
    `docs/gemini-agent.md` §9 are the format.
17. **Extend the base harness mapping, never a frontend allowlist.** Model support is
    `MODEL_SWITCH_CAPABLE` plus the protocol/env/flag leaf in `shared/agents/model-gateway.ts`.
    Frontends call `canSwitchModel` / `modelsForAgent`; they never spell Claude, Codex or a custom
    id themselves. This makes `baseAgent:'claude'` inherit discovery, filtering, environment and
    command grammar as one unit instead of four copies that drift.
18. **A model switch must refresh the shell environment without printing the key.** An already-live
    shell does not inherit a later `tmux set-environment`, and prefixing the resume line with
    `KEY=secret` leaks it into the pane/history. SIGTERM the pane's foreground non-shell process
    group (a typed `/exit` can land in the agent composer as prompt text), recycle the persistent
    session, and let cold restore resume with the new model under the newly injected environment.

## Session memory (the RAM pill + the per-session panel)

A bottom-left **RAM pill** (`components/SystemResourcePill.tsx`) beside the usage pill, and the
**session-memory panel** it opens (`components/SessionMemoryPanel.tsx`): used/total RAM of the
machine the **active project** runs on, and every `nt-*` tmux session on that machine sorted by the
memory its whole process TREE holds, each row travelable (`goToNode`) and killable. Scope is
`usageScopeKey` — the same helper the usage indicator uses, so the two pills can never disagree
about which machine they describe. Reading + parsing is `core/session-memory.ts` (this machine) and
`core/session-memory-remote.ts` (an SSH project's host), served over one RPC by
`core/session-memory-service.ts`, which BOTH shells boot. Full write-up + the device checklist:
**`docs/session-memory.md`**.

- **The memory is the agent CLI's own V8 heap — nodeterm does not allocate it, and it is not a
  leak.** Measured on the production host that prompted this (64 GB, 95 live `claude` processes): a
  `claude` process alone averages **335 MB** and peaked at **1159 MB**; 95 of them held **31.1 GB**;
  MCP children add 30–200 MB per session (playwright-mcp + Chrome ≈ 200 MB alone), so one "Claude
  terminal" tree is **440 MB – 1.2 GB**. `RssAnon` is essentially all of the RSS (1165 MB of 1187 MB
  on the largest process) and the repo sets no `NODE_OPTIONS`, so V8 sizes its heap off system RAM
  (`heap_size_limit` 4144 MB there). It is flat with process age — 0–24 h avg **340 MB** vs 7 day+
  avg **326 MB** — so each process takes a baseline and never returns it. **Write those numbers down
  rather than re-deriving them.** The user's number was right and their attribution was wrong; what
  the product was missing was not the allocation but the **blindness** — nothing told them 18
  sessions were live, that one was 1.2 GB, or that six belonged to a project they closed weeks ago.
- **The reaper is deliberately unchanged.** `core/session-budget.ts` reaps only **detached** sessions
  past a grace window, so on that host its kill list was **EMPTY** — 60 `nt-` sessions, 50 attached,
  0 eligible — while 31 GB sat there. An open canvas is attached, and attached is untouchable.
  Retargeting it is a separate change with separate risk; this feature adds **sight**, not policy.
- **`ok:false` is not `ok:true` with no rows** — the rule the whole feature exists to honour, and
  every layer preserves it. A sweep fails (no tmux, unreadable process table, **no socket answered**,
  a missing or out-of-order marker in the SSH reply, a rejected call) ⇒ `ok:false` and no rows; the
  panel then says "Could not measure sessions on this machine", and the grand total and the "*n*
  sessions" count are gated on a `measured` flag so a failure can never render as `0 B / 0 sessions`.
  "We looked and there is nothing" is its own sentence. A socket with **no tmux server** is an
  ANSWER, not a failure (`isNoServerError`), and that classifier is **anchored to tmux's own connect
  message**: `promisify(execFile)` folds stderr into `err.message`, and a bare `no such file or
  directory` also matches a tmux client missing a shared library (exit 127 on *every* socket) and a
  dead ssh ControlMaster — laundering either into "no sessions here" prints an empty panel over 20
  live ones. **The SSH leg applies the SAME classifier to the same rule**: each socket is fenced in
  the reply with its tmux exit status and its stderr (`##SOCK <name>` … `##SOCKRC <n>`, `2>&1`), and
  zero answers ⇒ `ok:false`. Its first form threw both away (`{ tmux …; tmux …; } || true`), so a
  host whose tmux client could not start emitted a stream byte-identical to an idle host's and the
  panel reported thirty live sessions as "No sessions are running here.". Do not "simplify" the
  fence back out — and do not replace the classifier with a blunt "any error ⇒ ok:false" either: on
  a host with no tmux server at all EVERY socket fails, and there "there are no sessions" is the
  honest answer.
- **`readMemInfo` has exactly one home** (`core/session-memory.ts`); `session-budget.ts` imports and
  re-exports it. The reaper's watermark and the pill must never disagree about how much RAM is free,
  and a second copy is exactly the drift this file warns about elsewhere. `null` = could not read,
  never zero.
- **The local reader reads `/proc/<pid>/status`, never `statm`.** `status` carries `PPid` and `VmRSS`
  in one file, already in kB; `statm` reports RSS in **pages**, forcing a page-size assumption — a
  hard-coded 4096 under-reports **4×** on a 16 KiB-page arm64 kernel and **16×** on the 64 KiB-page
  enterprise arm64 builds (40 MB printed for a 640 MB session). **Do not optimise this back to
  `statm`.** Non-Linux falls through to one `ps -eo pid,ppid,rss` call, through the same injectable
  seam as tmux.
- **`childCount` counts ALL descendants**, the agent CLI included: `pane_pid` is the pane's SHELL, so
  a claude session with two MCP servers reports **3**. The UI therefore says "**child processes**",
  never "MCP" — a plain `npm run dev` has children too.
- **The cadence split follows the cost.** A **local** scope polls the pill's number every 30 s
  (`HOST_POLL_MS`, one file read, free). An **SSH** scope is **never polled**: one read on scope
  entry, one when that project's ControlMaster comes up (an SSH project is opened before its master
  is ready, and with no timer behind it a first read against a dead master leaves the pill blank),
  and one per panel open / `⟳`. Same rule this file already sets for **Remote usage**, for the same
  reason: every remote read is an ssh exec plus a `ps` of somebody else's whole process table. The
  full sweep runs on the panel's MOUNT (it is unmounted while closed) and on `⟳` — never on a timer,
  never from the pill. One more consumer, same discipline: the welcome screen runs ONE **local**
  sweep per appearance (only while "Recently closed" is non-empty) for its per-project
  live-session badges (issue #442), bypassing the panel's store on purpose — it must not disturb
  `state/sessionMemory.ts`'s module-level scope stamp, and its scope is always THIS machine.
- **The pill is the single owner of the store's `startHostPoll` / `stopHostPoll`** — the timer and the
  active-scope stamp are MODULE SINGLETONS. The panel must never call them: a `stopHostPoll` on
  unmount would clear the pill's interval with nothing left to restart it, and the number would
  silently freeze until the next scope change.
- **A closed project is not an orphan.** `closeProject` keeps the project and its nodes on disk, so
  its sessions resolve to a real title and are labelled with their project; calling them orphans
  would invite the user to kill sessions they deliberately parked. `resolveSessionRows` is therefore
  fed EVERY project — filtering to the open tabs defeats the rule silently, from outside the file
  that states it. And **`orphan` is the distinguishing field, NOT `state === null`**: a plain
  terminal never enters the agent-status map, so deriving orphan-ness from a missing agent state
  would flag every one of them. Orphans are the point — they are what the reaper cannot see and no
  canvas can show.
- **On an SSH scope the kill routes over the ACTIVE project's master** (`lib/sessionKill.ts` →
  `sshProject.killSessions`), because `transport.destroy(nodeId)` reaches a remote session only
  through a LIVE local client carrying `sshRemote` — which an orphan has not, and neither has a node
  owned by a non-active project. Before this, every orphan row's `×` on an SSH project **promised a
  kill it could not perform**: the local socket was touched, the host's `nt-<id>` kept running, and
  the row came back on the next refresh unexplained. It is safe because it is a **round trip, not a
  lookup** — the row's `nodeId` is literally `session.slice('nt-')` from the sweep and `killSessions`
  maps it back through the same idempotent `sessionName()`, so the exact session name the sweep
  observed is killed on the host it observed it on (node ids are only per-launch unique, and nothing
  here rests on more). Ownership is re-resolved at click time, not taken from the row's stale
  `orphan` flag, so a node created since the sweep is not killed as an orphan.
- **The panel's second action is PAUSE, and it is the one that should usually be clicked.** The `×`
  was the only thing a row offered, which is the wrong tool for what the panel is mostly opened
  for. Measured on the reporting host (2026-09-04, 149 `nt-` sessions, 46 GB of tree RSS): the
  median session with a live `claude` holds **321 MB**, the median session whose CLI has already
  gone holds **5.6 MB** — so exiting the CLI returns **98.3%** of it, and killing the tmux session
  on top buys the remaining 1.7% at the price of the pane, its scrollback and the warm reattach.
  Population-wide the same split is 95% `claude`+`node` against 1.8% shell. **This is the number to
  quote when someone proposes making a memory lever destroy sessions**, and it is why issue #616's
  "end the tmux session too" was not built. The control is NOT a third depth: it calls
  `pauseAgentNode(id, false)` — the same "Pause session" the node menu offers, the same
  `performExitPhase`, the same PAUSED chip and the same Resume — because a panel-only "hibernate"
  would be a third concept for the user and a second exit path to keep in step with Eco's. Which
  rows may offer it is the pure `renderer/lib/sessionPause.ts`, and its two directions are
  deliberate: a row that could NEVER be paused (an orphan, a plain terminal, an agent we cannot
  quit-and-resume) renders **nothing** — a dead control on most rows of a machine-wide list is
  noise about something that was never possible — while a row that is merely refused right now
  (busy, no session id, or its terminal is not mounted on this canvas, which is the common case in
  a panel that spans every project) renders **disabled with the reason**. Canvas answers, because
  it is the only place that can see the node's agent, its registered pause closure and its
  `restartEligibility` at once; it asks on the same narrow `st?.sessionId` the node menu uses, so a
  row cannot promise what the closure would refuse.
- **The name and the host were never the hard part — the SOCKET was.** Two nodeterm tmux sockets
  live on one machine at once (`node-terminal` for a nodeterm running ON it, `nodeterm-rmt` for one
  SSH-ing INTO it) and the sweep lists **both**, while the kill targeted one — so every row off the
  other socket got "this stops its tmux session" and a kill that landed nowhere. Not exotic: a host
  running its own `nodeterm-server` while being SSH'd into is exactly that, and the local mirror
  (this machine's panel listing the `nodeterm-rmt` sessions another machine's nodeterm spawned here,
  all orphans locally) is the same shape. A kill that knows only a NAME therefore goes to **every
  socket that name could be on** (`KILL_TMUX_SOCKETS` → `remoteTmuxKillEverySocketArgs` /
  `localKillSockets`), which is safe because tmux's "can't find session" was already the ignored
  case, because the target is **exact** (`-t =nt-<id>`: without `=` tmux falls back to fnmatch then
  PREFIX matching on a miss, and `nt-…-1` is a prefix of `nt-…-12`, so a miss could kill a different
  session), and because the fan-out is **opt-in and asked for by exactly one caller**: it needs both
  "we do not know the socket" AND `everySocket` from the caller (`localKillSockets(live, everySocket)`,
  `sshProject.killSessions(…, {everySocket:true})`, `transport.destroy(id, {everySocket:true})` —
  the wire legs demand a literal `true`). A destroy for a session we HOLD still fires exactly one
  kill; and the unheld branch is not rare — an ordinary node-× on a node never mounted in this
  process takes it, which is the norm after an app restart — so project deletion and every ordinary
  × stay narrow rather than inheriting the panel's blast radius. The sweep and the reaper keep their own copies of
  the socket list **on purpose**: for them the ORDER decides first-wins de-duplication, for a kill
  it means nothing.
- **The generated SSH shell is tested under a real `/bin/sh`** (`session-memory-remote.test.ts`
  against a fake host tree, same discipline as `remote-claude-usage.test.ts` and
  `canvas-control-shim.test.ts`) — and it is not ceremony: the plan's own script said `echo ##MEM`,
  which prints an **EMPTY LINE** under POSIX sh (an unquoted `#` starts a word-initial comment) and
  would have made **every healthy host report `ok:false`**. The markers are quoted for that reason,
  every section header is printed unconditionally (a missing one means the stream was cut short, not
  that the host had nothing), and the socket names + `-F` format come from the shared constants so
  the two legs cannot look at different sockets.
- **Which machine answers** is decided in `session-memory-service.ts` by OR-ing two independent
  claims of remoteness — the renderer's `remote` flag and the shell's `isRemoteProject` — because a
  source that answers "no" while momentarily uninformed (index not loaded, master just dropped)
  would turn a remote query into a LOCAL sweep and publish this machine's sessions under the host's
  name. `sshScopePredicate` answers from **identity, not liveness** (`workspaceStore.sshProjectIds()`
  — a DISCONNECTED SSH project is still someone else's machine), OR-ed with the live masters. The
  `remote` option pair is deliberately asymmetric: `run` is optional, `isRemoteProject` is
  **required** — reading-without-knowing is a compile error.
- **Surfaces.** **Desktop**: full. **Server Edition**: the service runs and the ws-bridge has a REAL
  implementation, so the pill and panel describe the machine the server is served from; an SSH scope
  answers `ok:false` (no ControlMaster injected) and says so **by identity** via `sshScopePredicate`
  rather than trusting the renderer's flag — see docs/SERVER.md, including the silent dependency on
  the boot-time `workspaceStore.load()`. **Relay tabs**: the stub answers `ok:false` and the panel
  says session memory is not available there, which is a different story from a failure. **Kanban**:
  Canvas passes `overBoard={kanbanOpen}` (the same prop `UsageIndicator` takes), raising the pill to
  z 26 over the board's opaque 25, and an open panel to 60; with the board CLOSED the open panel
  still has to clear the sessions sidebar (z 12), which is the separate
  `.sysres-indicator:has(.sessmem-panel) { z-index: 13 }` — both `:has()` rules work only because
  the pill cluster is mounted OUTSIDE `<ReactFlow>`, whose wrapper's inline `z-index: 0` would trap
  any value inside it. **Mobile**: **N/A for v1** — *nodeterm
  mobile* attaches to tmux sessions over the transport protocol and has no per-session host-memory
  concept; adding one means extending that protocol (follow-up in the iOS repo).

**Offscreen release makes the macOS reaper bug far more visible, and the two shipped days apart.**
A node released while offscreen detaches its PTY client — so it becomes a DETACHED tmux session and
joins the reaper's candidate pool once past the 6 h grace. On a Mac reading `os.freemem()` the
watermark was permanently tripped, so those sessions were culled on the next sweep. More automatic
detaching + an always-true pressure signal is why the symptom read as "my sessions keep
disappearing" rather than as an occasional cull. The `vm_stat` reader is what makes the pool safe
again; the grace window was never the thing that was wrong.


## Node icons (emoji or picture)

A node may carry `data.icon` (`NodeIcon` in `@shared/node-icon`): `{type:'emoji', value}` or
`{type:'image', path}`. Absent = the node draws exactly as it did before the feature, which is the
degrade every failure path falls back to. Set from the node right-click menu ("Set icon…", hideable
like Colors — id `icon`), from the icon itself in the terminal node header, and from the kanban card
modal's header slot; drawn by the one `NodeIconView` on all four surfaces that list a node (canvas
header, kanban card, card modal, sessions sidebar row), because a session seen in four places must
not look like four sessions. **Terminal (session) nodes only in v1** — the menu row is gated on the
kind, deliberately: offering it on an editor or a group frame would persist a value nothing draws,
which is the "looks like it worked" failure this file warns about elsewhere. Extending it to sticky
or browser nodes means adding the draw and the set together, in one change.

- **`.nodeterm/project.json` is hostile input, so the icon is validated at BOTH serializer seams.**
  `normalizeNodeIcon` runs in `nodeStatesToFlow` (a cloned file becoming live state) *and* in
  `flowToNodeStates` (live state becoming the next reader's file — live node data is reachable by a
  peer canvas mutation, and whatever we write is what the next machine trusts). One-sided validation
  passes every round-trip test while leaving the other direction open; both seams are mutation-pinned
  in `workspace.test.ts`.
- **An emoji is ONE grapheme** (`Intl.Segmenter`, with a UTF-16 cap as the fallback, never as the
  primary rule — slicing units cuts a ZWJ sequence into a fragment). Uncapped, a shared file could
  put a 40 kB "emoji" into every header, card and sidebar row.
- **An image path must LOOK like an image** (extension → MIME). That gate is what stops a hand-edited
  project file from aiming `fs.readBinary` at `~/.ssh/id_rsa`. It is not a full jail — the path can
  still name any `*.png` on the machine, exactly as an editor node's `filePath` always could — but
  the bytes only ever become an `<img>` under a `'self'` CSP with no network, so the reachable
  outcome is "an icon fails to draw". A `./` path may not traverse (same rule as
  `isSafeQuickOpenRelPath`).
- **Two dialects in, one dialect out — and the traversal guard splits on BOTH separators, always.**
  The value is written by one machine and read by another, so `normalizeNodeIcon` ACCEPTS a Windows
  absolute (`C:\…`, `C:/…`) and a POSIX one wherever the check runs, while everything STORED is
  POSIX-separated. Both halves are load-bearing. Refuse `C:\…` on a mac and a mac user merely
  opening the shared canvas and saving it **silently strips a Windows teammate's icons** from
  `project.json` — such a path does not resolve on a mac, but not-drawing is a degrade and a degrade
  is not a reason to destroy the value on the way past. Store `.\a\b.png` and it means a file
  called `a\b.png` on POSIX and `b.png` inside `a` on Windows, so a relative path is canonicalized
  to `./` with forward slashes (the same way an emoji is canonicalized to its first grapheme).
  **`isSafeRelIconPath` splits on `[\\/]` on every platform**, because splitting on `/` alone made
  `./a\..\..\secret.png` ONE segment — neither `''`, `.` nor `..` — so it passed the guard
  everywhere and escaped the project root the moment a Windows reader resolved it; a segment may
  also not contain `:` (a drive qualifier, or an NTFS alternate data stream). **UNC is refused**,
  matching `renderer/terminal/file-links.ts`, which consumes UNC specifically so it can refuse it:
  reading one reaches another machine over SMB.
- **`localIconCwd` is the ONE definition of which cwd a `./` icon may resolve against**, asked by
  the picker's write side and by `useNodeIconSrc`'s read side. It was written twice and drifted: an
  SSH project's `cwd` is a path on the REMOTE host while the icon is read through the LOCAL `api.fs`
  (an SSH project runs on the local session — only a RELAY tab's api belongs to another machine), so
  the read side resolved a remote-rooted `./` path against this machine's filesystem and drew
  whatever happened to sit there. Undefined = the icon does not draw, which is the honest answer for
  a file on a filesystem this reader cannot see; absolute paths are unaffected, and absolute is what
  the write side stores for SSH.
- **A picked image is downscaled before it is written** (`lib/nodeIconThumbnail.ts`, 256 px long
  edge = 16× the drawn size). What lands in `.nodeterm/images/` is committed and cloned by everyone
  on the repo, and it draws at 13–16 px. SVG is passed through (rasterizing it would make it worse
  at every size, not merely smaller), as is anything already small in both dimensions and bytes (a
  canvas round-trip can make a hand-made 32 px PNG *bigger*) and any re-encode that came out larger.
  An animated GIF becomes a static PNG. The decision (`thumbnailPlan`) is pure so it tests under
  vitest's default `node` environment — jsdom has no canvas — and the browser half's decode/encode
  is injected. It **fails open in every direction**, including a decode that never settles
  (`DECODE_TIMEOUT_MS`): `chooseImage` awaits it before writing, so a hanging promise would leave
  the button stuck on "Copying…".
- **The extension is checked BEFORE the copy.** `dialog.selectFile` applies no filter, so an
  unsupported file is one click away — and validating after `saveCanvasImage` left an orphan file in
  the user's git-shared folder on every refusal, which nothing later removes.
- **The bytes are COPIED, not referenced.** The picker reads the chosen file and writes it through
  `files.saveCanvasImage` — the same seam canvas image nodes use — so it lands in the project's
  git-shared `.nodeterm/images/`. A path inside the project cwd is then stored `./`-relative
  (`portableIconPath`) and resolved on read (`resolveIconPath`), which is the convention
  `toPortableNodes` already set for node cwds. **This is the one place that convention is applied to
  a `filePath`-like field**: canvas image nodes still store theirs absolutely, so their file travels
  with the repo while the node naming it does not — an existing gap, not one this introduced.
  A cwd-less canvas, an SSH project (its cwd is on the host; the image is written app-locally) and
  the app-local fallback all keep an absolute path and simply do not travel. Not an error.
- **The picker owns Escape while it is the top dialog** (`useDialogStack()`'s answer, which was
  previously discarded). The gate is `isTop()` ALONE, matching `confirmKeyAction`, where `inDialog`
  guards Enter and never Escape: Enter is the affirmative key and must be aimed at the dialog, while
  requiring focus inside the box for Escape reproduces the original bug for a user whose focus sits
  on the body.
- **A relay tab is refused** (`canvasImportRefusal`, the same message and the same reason as canvas
  image import): the write is this machine's preload while the read is the peer's core, so the node
  would name a file only this machine has. Reads otherwise go through the PROJECT's session api, not
  `window.nodeTerminal` — which is what makes a peer-authored `./` icon resolve on the peer.
- Image reads are cached per `(projectId, absPath)` in `lib/nodeIconImage.ts`, because four surfaces
  mount independently and a thirty-card board would otherwise re-read the same bytes thirty times per
  open. Caching by path is safe: `saveCanvasImage` creates exclusively, so re-picking yields
  `logo (2).png` rather than overwriting.
- **Surfaces.** Desktop: full. **Server Edition**: full — every leg is already core (`fs.readBinary`,
  `files.saveCanvasImage`) or has a real browser implementation (`dialog.selectFile` → the web
  picker), so no new IPC was added and nothing is stubbed. **Mobile**: N/A for v1 — *nodeterm mobile*
  attaches to tmux sessions over the transport protocol and carries no per-node icon concept;
  surfacing one means extending that protocol (follow-up in the iOS repo).
## Keybindings (registry, overrides, dispatch)

Every user-facing chord is a registry command, and the whole engine is **one module**:
`src/shared/keybindings.ts` holds the command registry, per-command validation
(`normalizeBindingForCommand`), effective-binding resolution, conflict detection, override
sanitization and the pure event→command resolver. **Do not split it** — main, the renderer and the
Server Edition bridge all import it, and a second copy of any of those five is how the dispatcher,
the Settings section and ShortcutsPanel start disagreeing about what a chord means.

- **Overrides live in `settings.keybindings`** (hand-editable JSON): an absent id = the registry
  default, `[]` = **disabled**, a list = exactly those chords. It is **sanitized at READ**
  (`sanitizeKeybindingOverrides` → `renderer/lib/keybindingOverrides.ts`, memoized on the raw
  object's identity), which is what makes a hand-edited file safe; the Settings section refuses a
  bad candidate BEFORE saving (`commitCandidate`) so the user learns which chord was refused
  instead of watching it vanish on the next launch. The write path is raw and the gates read the
  sanitized map, so a dropped hand-edit is invisible in the UI but still on disk until a UI write
  or Reset replaces the map.
- **Dispatch has exactly two owners.** The renderer's is ONE window `keydown` listener in
  `Canvas.tsx`, on the **bubble** phase — the Settings recorder's `stopPropagation` on an armed
  capture depends on that, and moving it to capture would let a recorded chord fire the command it
  is being bound to. The main process's is `src/main/keydown-intercept.ts`, a **closed allowlist**
  of chords it must steal back from the application menu before the page ever sees them.
- **Invariants**
  - **Never read `settings.speech.shortcut`.** The dictation chord is `dictationBinding()` (the
    first effective `speech.dictation` binding); the legacy field is a **downgrade mirror only**,
    written by `setKeybindingOverride` so an older build still finds the user's chord.
  - **`isHoldChord('')` is TRUE** (an all-false parse has a null key), and `''` is what a DISABLED
    dictation binding reads as — so every caller owes an explicit `=== ''` check first. Without it
    a disabled binding arms a modifier-less hold chord that fires on any keydown.
  - **`MAIN_INTERCEPTED_COMMAND_IDS` must mirror the registry-backed commands `keydown-intercept.ts`
    actually resolves** (`keydown-intercept.test.ts` pins it). The Settings UI's app-wide shadow
    warning reads that list and cannot derive it — main is not importable from the renderer. Note
    what the pin cannot cover: a HARDCODED intercept (the `Digit0` branch) has no command id, so it
    swallows its chord app-wide with the recorder reporting no conflict.
  - **Dictation has its own conflict bucket** (`conflictBucket` — `speech.dictation` is never in
    `global`), because it never competes at dispatch: the resolver skips it and its own keyed
    listener claims the chord FIRST **in plain app focus only**, which is precedence, not ambiguity.
    Overlap policy is deliberately asymmetric — the LOAD path PERMITS a shared chord (legacy
    settings.json files contain them and `sanitizeKeybindingOverrides` would otherwise strip the
    user's own binding with the migrated one), while the Settings UI REFUSES to create one
    (`commitCandidate`'s two dictation gates, both keyed-only — a modifier-only hold chord renders
    as `…:(hold)` and can never match a keyed identity).
  - **The terminal-first stand-down is `policyStandsDown(policy, terminalFocused)`, and both halves
    are refusals.** `settings.terminalShortcutPolicy` (`app-first` default, Settings → Keyboard
    Shortcuts, read everywhere through `normalizeTerminalShortcutPolicy` because it is
    hand-editable) never stands anything down under `app-first`, whatever the mirror reports — that
    is the byte-identical guarantee for a user who never touched it. Under `terminal-first` with a
    focused terminal, main stops claiming its chords AND disables the command-style menu items in
    `menuItemIdsToSuspend` — Minimize, Toggle Kanban Board (⌘⇧B) and Settings (⌘,) everywhere, plus
    Close off-mac, with **Reload deliberately excluded** (see **Window chrome**): not calling
    `preventDefault` alone would hand ⌘M straight to `{role:'minimize'}`, which is strictly worse
    than having no policy. **The MENU's state is the composed
    `menuStandsDown(shortcutRecording, policy, terminalFocused)`** — an armed shortcut recorder
    suspends the same items, so ⌘M / ⌘⇧B / ⌘, / off-mac Ctrl+W reach the recorder instead of the
    menu item that owns them; `menuStandsDown(false, …)` is `policyStandsDown(…)` by construction.
    The two INTERCEPT thunks stay independent parameters — only the menu ORs them.
    **The CLOSE leg has one extra, policy-independent stand-down** (issue #383, off-mac only):
    `closeStandsDownInTerminal(isMac, terminalFocused)` — off-mac `node.close`'s default chord is
    Ctrl+W, readline's kill-word, so while a terminal has focus the close intercept lets the chord
    fall through UNTOUCHED and `syncMenuForStandDown` disables the Close menu item on top of the
    shared list. mac's ⌘W is deliberately unaffected (not a shell key), and ⌘/Ctrl+M and ⌘/Ctrl+0
    keep firing — this is one chord whose terminal meaning outranks its app meaning, not a policy
    change. Falling through main is not enough: xterm's custom key handler runs before the Canvas
    dispatcher, whose main-intercepted command cases deliberately have no renderer handlers.
    `terminalChordBubbles` must therefore refuse every `MAIN_INTERCEPTED_COMMAND_IDS` command; if
    it returned true for `node.close`, xterm would withhold `^W` while the unclaimed event bubbled
    to Canvas. One predicate, two main-process consumers are pinned in `keydown-intercept.test.ts`
    (including a source-level wiring pin, since the menu leg lives against a real Menu in index.ts),
    and `keybindingOverrides.test.ts` pins the renderer-to-xterm hand-off through
    `terminalKeyAction`.
  - **ShortcutsPanel is DERIVED from the registry, never a hand-written list.**
    `buildShortcutSections` iterates `COMMAND_DEFINITIONS` — one section per `CommandGroup` in
    registry source order, the label from `def.title`, and EVERY one of the command's EFFECTIVE
    chords — and a command with no effective binding (ships unbound, or the user disabled it) is
    OMITTED rather than shown chord-less. All chords, not just the first: off-mac
    `terminal.copySelection` holds Ctrl+Shift+C AND Ctrl+Insert, and in the **Server Edition**
    Chromium reserves Ctrl+Shift+C for the inspector un-preventably — so a first-chord-only row
    advertised the one that cannot work there. The panel it replaced enumerated 24 ids by hand against a
    45-command registry, so ⌘⇧T (reopen last closed), ⌘⇧↵ (maximize node), the ⌃⌥arrow zone snaps
    and Copy terminal selection were live chords it never mentioned, and no ships-unbound command
    could ever appear even after the user assigned one. `ShortcutsPanel.test.tsx` is the watchdog:
    it binds every registry command and asserts a row per `def.title`, so a new command that fails
    to surface reds it. Same stale-doc rule as the canvas-control skill body (#269) — derive the
    text, don't retype it.
    Rows the registry does NOT own (mouse gestures, the two `zoomShortcut.ts` chords, the ⌘1-9
    project jump, tmux/xterm terminal behaviors) are literal, and still read from settings where
    the behavior does: the hover dwell prints `panHoverDelay` and the drag rows follow
    `canvasDragMode`, because the old fixed text claimed 0.6 s and a right-drag pan React Flow
    (`panOnDrag={[1]}`, middle button only) has never done.
    **One honest exception to "the chord shown is the chord that fires":** `terminal.copySelection`
    is a registry row whose matcher is still the hardcoded `isCopyShortcut`
    (`terminalKeyAction` keeps the copy chords and Shift+Enter "whatever the registry says"). Its
    registry defaults match that matcher on both platforms, so the row is accurate as shipped; a
    REMAP of it would not be, on this panel or in Settings. Wiring `isCopyShortcut` to the registry
    is the fix.
  - **`terminalFocused` is a MIRROR, and its fail-safe direction is `false` = not focused =
    intercepts ON.** `renderer/lib/terminalFocusMirror.ts` reports focus changes to main and is
    change-deduped (it never re-asserts), so a page that died mid-report, a reload, or a window that
    never had one all resolve to intercepts on — never to "off with nothing alive to turn them back
    on". Consequence: clear the bit ONLY where the renderer's DOCUMENT is ending (window `closed`,
    `render-process-gone`, main-frame navigation). Clearing it under a live page that is still
    focused on its terminal strands mirror and main out of sync with no event that can reconcile
    them, and the policy is dead until the user clicks away and back.

## Canvas interaction & panels (`Canvas.tsx` is the hub)

- **Context menus** (`components/ContextMenu.tsx`, portal, icons from `components/icons.tsx`):
  pane right-click = add nodes at cursor (terminal / Claude / sticky / open file) + select
  all + fit + **Tidy canvas** (`arrangeAllNodes` — packs every top-level node, including group
  frames as rigid units, into a non-overlapping grid via `arrangeNodes`, sorted by current
  (y, x) so the pack roughly preserves reading order; mirrored in ⌘K as "Tidy canvas" and in the
  keybinding registry as `canvas.tidy` (default ⌘/Ctrl+Shift+A, remappable); both
  hidden below 2 top-level nodes, where it could only be a visual no-op that still writes
  `project.json`) + restart-idle-agents (the bulk in-place agent restart, mirrored in ⌘K; both
  hidden when the canvas holds no restartable agent node, where they could only report "0
  restarted");
  node/selection right-click = group, color, duplicate, align-to-grid, collapse,
  markdown-view (terminals), refresh-terminal (terminals — bumps `respawnNonce`: fresh PTY attach
  to the SAME tmux session; manual recovery for a stuck/unpainted terminal, and the same action
  sits in the node header as `term-node__refresh` since a dead view is a bad place to hunt for a
  right-click; nothing running is interrupted), restart-agent
  (single agent node — the in-place CLI restart above; absent for a CLI we cannot quit + resume,
  disabled with a hint while the session is busy or has no id yet), delete. Actions live
  in `Canvas.tsx`, operate on `targetIds`. The non-destructive rows are user-hideable from
  **Settings → Appearance** ("Node menu items" / "Terminal header buttons"), stored as HIDDEN
  lists in `settings.hiddenNodeMenuItems` / `settings.hiddenHeaderButtons` (empty = everything
  shows). `lib/ui-visibility.ts` owns the two inventories and `isHidden`, which only answers for
  ids it knows — so Delete, restart-agent, branch/transfer, terminal Search and Close can never
  be hidden, whatever settings.json says. The group-frame menu's colors strip answers to the same
  `colors` id; builders run through `tidySeparators` so a hidden row leaves no dangling rule.
- **Add menu** = bottom dock (`Dock.tsx`) `+`, mirrored by the pane menu and command palette.
- **Edges** are all one React Flow type, `floating` (`canvas/FloatingEdge.tsx` over the pure
  `lib/floatingEdge.ts`): every family — ropes, context bridges, note links, subagent/loop card
  edges, trigger edges — is drawn between the midpoints of the two nodes' facing sides instead of
  fixed handle sides, so an edge to a node placed left of or above its source takes the short way
  round rather than looping across the canvas, and every edge using a side meets the node at ONE
  point (2026-09-03: enes's first try showed a hub with entries fanned along its whole top edge).
  Context and note links are the exception in one respect: they anchor only on the left/right
  sides (`data.anchor: 'horizontal'`), where the `link-out`/`link-in` drag handles are drawn. A terminal node's **eye** (`hide-fanout`, "Hide cards &
  connections") hides its subagent/loop cards AND every edge touching that node — display only:
  the links still authorise reads and an `--after` still waits. See the `--after` bullet under
  Canvas control for the rope model the eye hides.
  **Surfaces:** Desktop + Server Edition are identical (pure renderer + React Flow internals — no
  new IPC or bridge member); the kanban board is N/A (it shows cards, never edges); mobile is N/A
  (the transport protocol carries no edges).
- **Undo/redo**: debounced snapshot of the nodes array on settle (drag/edit), `pastRef`/
  `futureRef` stacks, ⌘Z / ⌘⇧Z + dock buttons. History resets per project load; skipped
  while typing in inputs/terminals.
- **Selection/pan**: box-select on left-drag (`SelectionMode.Partial` — touch to select);
  pan = middle-drag or trackpad two-finger (`panOnScroll`, `zoomOnScroll:false`); pinch
  zoom. Right mouse is free for the context menu.
- **Delete** (Delete/Backspace) opens `ConfirmDialog` before removing selected nodes.
- **Zoom chords** (`renderer/lib/zoomShortcut.ts`): **⌘/Ctrl+0 → `zoomTo100`** (actual size — what
  the browser AND Electron's default View menu already mean by that key) and **Shift+1 → `fitAll`**
  (the Figma/tldraw/Excalidraw "zoom to fit"). Matched on `e.code`, like the project-jump chord,
  which excludes `Digit0` so the two can never collide. The module is a PURE decision because both
  chords move the camera and a camera move here is not read-only — `onMove` → `markDirty` persists
  the viewport and casts it to the team session — so it refuses while the kanban board is up and
  while focus is in a text surface (input/textarea/contenteditable/Monaco/xterm, where Shift+1 is
  just the `!` key), and on auto-repeat (both actions animate; a held chord would restart the tween).
  Desktop ⌘0 does NOT arrive as a keydown: the default menu's `resetZoom` accelerator wins, so
  `main/index.ts` intercepts it in `before-input-event` and forwards `app:zoom-actual-size`, which
  re-asks the same refusals. Server Edition needs no intercept (no menu; Chrome/Firefox hand ⌘0 to
  the page) and stubs the subscription.
- **"Go to node" (`goToNode` → `frameNode`)** — the one camera-travel path (notification click,
  sessions sidebar, ⌘K jump, presence travel, minimap double-click, double-click focus).
  **It computes the viewport itself and applies it with `setViewport`. It must never go through
  `fitView`.** React Flow's `fitView` frames nothing when you call it: it sets `fitViewQueued` and
  the fit is RESOLVED LATER — from a subsequent `setNodes` (and only once EVERY node is measured,
  `nodesInitialized`) or from the next `updateNodeInternals` — against whatever `nodeLookup` holds
  by then. Its fit set is also filtered by `measured` (no `width`/`height` fallback in
  `getFitViewNodes`), so a set that comes out EMPTY collapses the bounds to `{0,0,0,0}` and
  `getViewportForBounds` parks the canvas **ORIGIN** in the middle of the screen at max zoom. On a
  canvas whose nodes sit thousands of px out that is the field report verbatim: right project,
  empty stretch of canvas, *sometimes*. **Cross-project** focus lands in that window every time —
  switch project → load its nodes → frame the target, all before the mount-time measuring has
  settled — and the second click always works, which is what makes it read as intermittent.
  The geometry is `renderer/lib/nodeFocus.ts`: the node's rect from React Flow's own measurement
  when it has one (`getInternalNode` — `measured` reaches OUR node objects one render later via
  `onNodesChange`, and `internals.positionAbsolute` also accounts for `extent:'parent'` clamping),
  else `nodeFitRect` from the PERSISTED size, resolving the group-parent chain. Then
  `viewportForRect`: **centred in the pane, and nothing else.** Framing a single focused node
  against the chrome-free rectangle was tried twice and is wrong both ways — centred IN that rect
  ("too far right on an ultrawide, half off-screen on a laptop") and centred in the pane then
  nudged clear of it ("still not in the middle") — because `.sessions-sidebar` is a 300px absolute
  OVERLAY and it is open exactly when this feature is used, so either rule pushes the node right by
  most of its width. The couple of dozen pixels that end up behind the sidebar cost far less than
  losing the centre. The free-rect solve (`solveFitFrame` / `solveFitPadding`) stays where it earns
  its keep: `fitAll`, which fits EVERY node and would otherwise tuck them under the dock.
  Unknowable size or no pane ⇒ the camera **stands still**.
  `settings.focusZoomToNode` (Behavior, default ON) is the escape hatch for the rescale: off, the
  camera keeps the zoom `getZoom()` reports and only pans, and that zoom is passed through
  **unclamped** — it is one the canvas is already displaying, and re-clamping it to the framing
  range would rescale the view the option exists to leave alone. Two rules a refactor must not
  undo: framing goes through `frameNode` and nothing else (`canvas-wiring.test.tsx` pins that it
  contains no `fitView(`), and a "stands still" branch must never be "helpfully" replaced by a bare
  `fitView` — that IS the origin jump. `fitAll` still uses `fitView` deliberately: it is an
  explicit user gesture on a settled canvas and its fit set is every node, but it carries the same
  deferral, so do not reach for it from anything automatic.
- **Breadcrumb trail** (`renderer/lib/breadcrumbs.ts` — all the pure logic lives there) — every
  deliberate `goToNode` landing records a `NavStop` ({nodeId, at, note}) for the ACTIVE project, and
  **Cmd+[ / Cmd+]** (`canvas.goBack` / `canvas.goForward`, bound in `shared/keybindings.ts`) plus the
  two Dock buttons walk that trail; on a project activation a once-per-app-run **`ResumeCard`** offers
  the last few distinct stops ("resume where you left off") — **opt-in via
  `settings.showResumeCard` (Settings → Appearance, default OFF)**: while disabled the
  once-per-app-run slot is not spent, so enabling it later still shows the card on the next
  activation; the chords/Dock buttons work regardless. Load-bearing facts:
  - **The trail is MACHINE-LOCAL and rides `IndexEntryV3.breadcrumbs`, never `.nodeterm/project.json`** —
    the same tier as `viewport` / `defaultAccountId` / `capabilityAck`, for the same reason: a repo must
    not carry one person's camera history to everyone who clones it. `fileToProject` therefore ignores a
    `breadcrumbs` field found in the shared file (a forgery), and `projectToFile` never writes one.
  - **The cursor is not persisted either.** Only `list` rides the entry; `BreadcrumbState.index` is
    renderer-only and resets to the tip on activation. A step records no breadcrumb and rewrites no
    `project.json` — the only persistence it triggers is the ordinary `onMove` viewport persist
    (machine-local, same as any camera move; see the Zoom-chords bullet).
  - **Cap 20** (`BREADCRUMB_CAP`, oldest dropped) and a **3 s dedupe** (`BREADCRUMB_DEDUPE_MS`, so a
    re-triggered focus on the already-current node is a no-op — `recordBreadcrumb` returns the SAME
    object, which is the caller's skip test). Recording past a back-step drops the forward tail, exactly
    like a browser tab.
  - **`stepBreadcrumb` skips stops whose node is gone** (never lands on a dead entry; no reachable stop
    ⇒ `null` ⇒ the camera stands still), and `goToNode` **refuses to record ephemeral `subagent` / `loop`
    nodes**: they are merged into the `<ReactFlow nodes>` prop but never persisted (cleared on the next
    turn), so a breadcrumb for one is an id nothing can ever resolve, burning a slot forever.
  - The `note` is a **snapshot** taken at record time (agent nodes reuse the sessions sidebar's own
    `sessionStatusKind` + `STATE_LABEL` phrasing, preferring session name → node title → agent label), so
    a later state change never retroactively rewrites history.
  - **Surfaces:** Server Edition works as-is (shared renderer code + `WorkspaceStore`, which both
    shells boot — no new bridge member); mobile is N/A (no canvas, no camera); the kanban board is
    likewise N/A, and a project that activates ON the board neither shows nor spends its
    once-per-run resume card (it would sit invisible under the opaque overlay).
- **Command palette** (`CommandPalette.tsx`): ⌘/Ctrl+K; `Canvas.buildCommands` (create,
  switch project, jump to node by title/tag, open file…).
- **Explorer** (`ExplorerPanel.tsx`, 🗂 / ⌘⇧E): lazy file tree of the active project `cwd`
  (`fs:list`); click a file → opens an editor node; right-click → Copy Path / Reveal /
  **New File… / New Folder…** (empty-area right-click targets the root; SSH projects create on the
  host). Canvas pane right-click and ⌘K also expose **New file…** (creates under the project cwd,
  opens an editor node). These use `mkdir` + `exists` added to `FsApi`/`SshFsApi` across
  desktop/server/SSH (`core/fs-ops.ts`, `main/ssh-fs.ts`). **Relay tabs are NOT degraded**: a
  relay tab's `fs` routes through `bridge/relay-api.ts:86` (`fs: files.fs`) → `buildFilesApi`'s
  `IPC.fsMkdir`/`IPC.fsExists` (`bridge/ws-bridge.ts:474-475`) → `core/fs-handlers.ts:43-44` →
  the real `fsOps.makeDir`/`fsOps.pathExists` on the peer's core, so both verbs are live there.
  What genuinely still lacks them is the legacy PHONE vocabulary
  (`main/remote/host-service.ts`), whose `handleFs` switches on `fs.list`/`read`/`readBinary`/
  `write` and nothing else, so `fs.mkdir`/`fs.exists` fall through to the dispatcher's
  `Unknown method` **rejection** (line 695) rather than degrading to `false` — a different
  dispatch path (`relay-host.ts:22-24`) from the relay tab above.
  Expanded dirs **persist per project** across drawer close + app restart (`state/explorer.ts`
  zustand store, localStorage `nodeterm.explorerExpanded`). The header pin docks it like the
  sessions sidebar (`lib/explorerPin.ts`, `nodeterm.explorerPinned`, default off): overlay
  click-outside closes the modal only, and a pinned overlay is `pointer-events: none` so it
  cannot steal canvas clicks. × is a transient hide and does not clear the pin. Pinned z-index
  is 26 so the tree stays visible on the kanban board with the controls cluster. Desktop +
  Server Edition (personal `localStorage`). Mobile companion: N/A — no explorer there. Source
  Control stays a modal.
- **Source Control** (`main/git-service.ts` system `git` + `gh`, `SourceControlPanel.tsx`,
  ⎇): file-level **stage/unstage** (+/−), **discard**, click a file → **diff node**,
  **branch switch/create**, commit (message box at top) + push / sync / publish, **gh
  sign-in** banner (runs `gh auth login` in a new terminal via `initialCommand`), recent
  commits. **AI commit message** (✦ Generate) and **AI terminal naming** both use
  `main/commit-message.ts`: a BYO local agent CLI (claude/codex/custom) spawned read-only on
  the staged diff / captured terminal output (no built-in model); agent + extra prompt in
  Settings. The panel operates on a **selected scope**, not on the project cwd — see Worktrees.
  **Open latency + reopen**: `status()` must never await `gh auth status` — it hits the GitHub
  API (~700ms) and used to hold the panel's first paint hostage; `ghAuthedSwr()` returns the
  cached answer and refreshes in the background (the accurate `ghAuthed()` is still awaited on
  the publish flow). Status/history live in the per-cwd `state/scmCache.ts` store (same pattern
  as `scmDraft`), so the close→reopen cycle paints the last-known data instantly while the
  mount refresh replaces it silently — do not move them back into component `useState`.
- **Worktrees** (bound to **group frames**) — a git worktree binds to a group node
  (`data.worktree: GroupWorktree {repoPath, branch, baseRef, path, createdByApp}`, persisted), and
  every node created inside that frame inherits the worktree path as its `cwd`
  (`cwdForNewNodeIn`) — the frame *is* the binding, so an agent per branch is just a group per
  branch. Creation is **one step** — **"New worktree…"** from the pane menu / command palette /
  Source Control — with the repo resolved from the project cwd via `git.repoRoot()` and existing
  worktrees listed for adoption. (Both git IPCs existed before this feature and had **zero**
  renderer callers, which is why it was unusable: the dialog's repo field was always empty and had
  to be typed by hand. Don't re-strand them.)
  - **Default location** — `settings.worktreePathTemplate` is a machine-global Behavior setting,
    expanded only by `shared/worktree.computeWorktreePath` for both the dialog and canvas-control
    CLI. It is relative to the repo root and supports `$repoName` (`$reponame` /
    `$defaultFolderName` aliases) and `$branch` in bare or `${…}` form. If branch is omitted, its
    safe slug is appended automatically. The shipped `../${repoName}.worktrees/${branch}` keeps
    worktrees beside — not nested inside — the main checkout. There is no general project-settings
    surface today, so the setting is intentionally global rather than hidden in a one-off menu.
  - **One store, one poller** — `renderer/state/worktrees.ts` is the **only** caller of the worktree
    /status *read* IPCs (`git.repoRoot`, `git.worktreeList`, `git.status`); the group chip, the
    creation dialog and the Source Control panel all read that store. Three independent pollers would
    triple the `git` subprocess load and drift out of sync. It is **epoch-guarded** (a project switch
    bumps the epoch, so a stale in-flight refresh can never overwrite the newer project's
    `repoRoot`/orphans — worktrees are *created* under `repoRoot` and orphans are offered for
    *deletion*) and **fails open**. Exactly **two** direct `git.status` reads live outside it, both in
    `Canvas.tsx` and both deliberate: the one-shot probes on the **Remove** confirm (the dirty-file
    count in the warning) and on **↪ Move into worktree** (staleness only arrives by poll, so the
    directory is re-checked immediately before an irreversible session kill). Anything recurring
    belongs in the store.
  - **Scoped Source Control** — the panel operates on a selected `ScmScope` (the main checkout or a
    bound worktree). A worktree scope's **id is its group node id**, which is what lets the canvas
    selection preselect it. `scmScopes` / `defaultScmScope` / `selectedScmGroupId`
    (`shared/scm-scope.ts`) decide the list and the default. The panel derives its `cwd` **once** so
    its ~49 call sites follow — and every Canvas callback it invokes (`onOpenDiff`,
    `onOpenCommitDiff`, `onExplainCommit`, `onRunInTerminal`) must take the **scope's** cwd, never
    the project's.
  - **Reconciliation** (`shared/worktree-reconcile.ts`) — bindings are reconciled against `git
    worktree list`: a worktree deleted outside the app makes its group **stale** (chip reads
    "· missing", Merge/Remove hide, ↪ hides, and nothing spawns into the dead path — Unbind is the
    only action, and it takes the dead cwd off the children with it); a worktree bound to no group
    is an **orphan**, recoverable from the creation dialog.
  - **Two non-obvious facts the code depends on — do not "simplify" these away:**
    1. `git worktree list --porcelain` **keeps listing a worktree whose directory was deleted
       behind git's back**, tagging it `prunable` — and that tag only exists on **git ≥ 2.36**. So
       `worktreeList` additionally **stats** each path through an injected `pathExists` seam
       (`prunable: e.prunable || !pathExists(path)`; `git-service` wires `fs.existsSync`), or the
       whole stale/orphan story silently fails on the Server Edition's own target platform (Debian 11
       / Ubuntu 20.04 ship git 2.30).
    2. **A failed git read is never evidence of absence.** `listWorktrees` returns `{ok, entries}`
       so "git failed" (spawn EAGAIN, NFS hiccup, corrupt index) stays distinguishable from "git
       listed nothing" — a transient failure must never be read as "the worktree is gone", at any
       layer (`ok:false` changes no facts). Staleness from the status poll likewise needs **two
       consecutive** failed reads (`WORKTREE_STALE_STRIKES`), and the streak is scoped per project
       so a there-and-back tab switch cannot forget it.
  - **Destructive safety** — `createdByApp` gates removal: nodeterm deletes only worktrees it
    created; one the user merely **adopted** unbinds by default, and deleting its directory is an
    explicit opt-in that **defaults to off** (its branch is kept either way).
    `isDangerousWorktreeRemovalPath` refuses a path that is the repo, `$HOME`, `/`, or an ancestor
    of any of them, on **every** removal path. **Merge** always confirms — it merges into the base's
    *working tree* (`decideMergeStrategy`: merge in the base's checkout when it is clean, else a
    `fetch . branch:base` when the base is checked out nowhere, else blocked) — and its push to
    `origin/<base>` is disclosed in that dialog and **opt-in, default off**: a push to origin cannot
    be politely undone.
  - **Every path that drops a bound group goes through unbind** — Unbind, Remove, **Ungroup** and
    **Delete** all route through `releaseWorktreeBinding`, the one place that knows what a dropped
    binding owes: `displacedByWorktree`'s descendants (terminals whose cwd sits inside the
    worktree) get that cwd taken off them, and git's registration gets a `pruneOnly` prune. Ungroup
    and group-delete *keep* the children, so skipping this left a **dead cwd persisted in
    `project.json`** — invisible until a reboot cold-starts the terminal into a directory that is not
    there — and left a stale registration that makes a later `worktree add` at the same path fail.
  - **SSH projects: not supported in v1** — every affordance is shown **disabled with that reason**
    (a silently-missing row teaches nothing). The gate asks whether the node is a **remote session**
    (`data.ssh` / `data.sshRemoteTmux`) or the project is an SSH project — **not** `data.remote`,
    which only *relay* nodes carry: guarding the wrong field let a live remote tmux session be
    killed into a local path that does not exist on the host (`isRemoteSessionNode` asks about all
    three). The ops themselves **refuse** a remote repo (`git-service.isRemoteRepo`, via
    `resolveGitRemote`) rather than guess: the `git` executor routes over the project's ControlMaster
    while `pathExists` is a **local** `fs.existsSync`, so answering would stat the wrong machine and
    report *everything is gone* — a refusal is a plain failed op and, crucially, never `worktreeGone`,
    so nothing is destroyed on a bad guess. Real support needs the worktree path to derive from the
    connection's cached `remoteHome` and `pathExists` to stat the **remote** fs (a `test -e` over the
    ControlMaster).
  - **Mobile companion: not applicable in v1** (the three-surfaces call, made deliberately). A
    worktree binds to a **group frame** on the canvas, and *nodeterm mobile* (separate repo, `nodeterm-ios`)
    has no canvas — it attaches to tmux sessions over the `TerminalTransport` protocol, which carries
    no group/binding concept at all. So there is nothing to degrade gracefully: a worktree's terminals
    are ordinary tmux sessions and mobile already reaches them, it simply cannot see that they belong
    to a worktree. Surfacing the binding (a read-only "worktree: <branch>" label per session, say)
    would mean extending the transport protocol — a **follow-up in the iOS repo**, not this branch.
    Creation/merge/remove stay desktop+server only: they are destructive git operations, and a phone
    is the last place to confirm one.
  - **Known follow-up** — the Explorer tree and the ⌘K file index stay scoped to the **project cwd**,
    so a bound worktree's files are not browsable/searchable from them (its terminals and editor
    nodes work fine). Deliberately out of scope here: both index a single root, and making them
    scope-aware is the same "which checkout am I looking at?" question Source Control already answers
    with `ScmScope` — that is the seam to reuse when it is built.
- **Kanban view** (`components/kanban/KanbanView.tsx`; toggle is a Trello-style icon ON the
  **active project tab** (`.tab__board-toggle`, after the name, before the caret — the view
  belongs to the project; earlier homes were the tab-strip end, then the controls-cluster,
  both rejected in use) plus ⌘⇧B / ⌘K): per-project
  full-page board OVER the canvas. It is **dual-source** (PR #90): SESSION cards are the project's
  session nodes (React Flow type `terminal`), derived LIVE from the canvas nodes
  (title/color/kind/agentId), with RUNNING / NEEDS YOU badges + unread dot from the default
  `agentStatus` store (click = back to canvas + `focusNodeById`); GITHUB cards are the repo's
  issues (`GitHubIssueCardView` via `state/githubIssues.ts`, opened through
  `GitHubIssueSummaryModal`, a column move that closes/reopens the issue confirms first). A
  **source filter** (`KanbanSourceFilter`: All / Issues / Pull requests / Sessions) and a transient
  per-board **label filter** narrow what shows.
  **PULL REQUEST cards are harvested from the issue poll, not fetched** (2026-09-01, read-only):
  `/repos/{repo}/issues` returns pull requests too — `client.listIssues` used to `continue` past
  them — so keeping them costs ZERO extra requests and inherits the incremental `since` watermark,
  the ETags, the 60 s poll and the cache snapshot the issue lane already has. The alternative was
  measured and rejected: **`/repos/{repo}/pulls` IGNORES `since`** (a day-old `since` returned the
  same 100 items as none), each item is ~25 KB against ~7 KB, and it would be a second
  ETag/paging/cache lineage — for `head`/`base` and nothing else (mergeable, reviews and checks are
  per-PR legs either way). The harvest's fields are `draft` and `pull_request.merged_at` (**the only
  thing separating merged from closed** — both report `state: 'closed'`), plus the labels/assignees
  the issue shape already carries. There is **no `head`** in that payload: `GitHubPullMeta.head`
  stays undefined until something asks per branch (`/repos/{repo}/pulls?head=owner:branch`), which
  is one request per question rather than a field on every poll.
  Three rules the harvest brought with it: **(1)** one snapshot now holds both kinds, so
  `GitHubIssueQuery.kind` (absent = `'issue'`) is what keeps the issue lane's items and counts
  byte-identical to before — and `moveIssue` refuses a PR by number (`invalid-target`) because the
  two share a number space and its membership check alone would hand one to a write path that
  cannot serve it. **(2)** `MAX_ISSUES` / the 64 MB bound are shared, so an overflow **evicts pull
  requests first, oldest-updated first** (`evictPullsToFit`) and marks the snapshot
  `pullsTruncated`; the existing `incomplete` read-only path fires only if the issues ALONE still
  miss the bound. A repository large enough to overflow degrades in the new half, never in the
  board it already had. An incremental pass carries the flag forward — it never re-fetches what it
  dropped, so only a full reconciliation may clear it. **(3)** the `pulls` source is `readOnly` in
  the registry: no drag, no move control, and its page reports `readOnly: true` on the wire rather
  than trusting every consumer to remember.
  **Where a card comes from is a registry, not a branch per call site** (`renderer/lib/kanbanSources.ts`,
  2026-08-30 — the same membership-plus-one-leaf discipline `AGENT_CONFIG` uses): each entry declares
  its filter `label`, its `placement` (`assignment` = the board's own persisted assignments,
  reorderable within a column; `provider` = the provider reports the column, the board persists
  nothing and a move is the provider's write), its in-column `lane` order and whether it is
  `configured` for a given board. Two orders live there deliberately: **declaration order is the
  source filter's button order** (All · GitHub · Sessions), **`lane` is the in-column stacking order**
  (sessions above issues) — they genuinely differ, and pinning both is what stops either being
  re-spelled elsewhere. `KanbanColumn` therefore takes ONE `lanes` prop (`{sourceId, cards, footer?,
  count}`) instead of a `cards` + eight `github*` props, places them via `byLane` and names no source;
  the board builds each source's leaf, and the drag union branches on `placement` (`isProviderDrag`)
  rather than on the string `'github'`. A lane's `count` is passed rather than derived from
  `cards.length` because a provider reports a server-side total larger than the page fetched so far.
  What deliberately did NOT move into the registry: the virtual **Ungrouped** column (board
  semantics, not a source's concern) and `validKanban`, which stays the single shape gate on every
  load path — a registry entry must never grow its own parallel validation. **Labels** are a per-project palette (`ProjectKanban` labels,
  edited inline via the Notion-style `LabelPicker`: create/assign/rename/recolor/delete through the
  pure `lib/kanban.ts` transforms) plus each GitHub issue's own labels, both filterable. The canvas stays MOUNTED under the opaque overlay (agent-status
  listeners live in Canvas.tsx; `display:none` would 0×0-resize every terminal into a tmux
  SIGWINCH), and canvas-only shortcuts (undo, ⌘T/⌘⇧C, Delete) early-return via `isKanbanOpen`.
  Board data is `project.kanban` ({columns, assignments: [{nodeId, columnId}]}, order = array
  order) in `.nodeterm/project.json` — git-shared, rides rev/mirror/watcher; absent until the
  first edit (`defaultKanban` seeds To Do / In Progress / Done). The virtual **Ungrouped**
  column (never persisted, undeletable/unrenamable, always first) holds every session with no —
  or dangling — assignment, in canvas order, so the board never opens empty. **Assignment is
  board metadata only**: drags never move canvas nodes or change groups; dead nodes' assignments
  prune lazily on each board change (`pruneAssignments`). Column delete is confirm-free (cards
  return to Ungrouped; no last-column rule — Ungrouped remains). The one shape rule is
  `validKanban` (`core/workspace-files.ts`), applied on EVERY load path — `fileToProject` AND
  `loadV3`'s inline (cwd-less) branch, which bypasses fileToProject — so a v1 `{columns, cards}`
  or hand-mangled board drops to the fresh default instead of crashing the render (view choice
  persists in localStorage, so a render throw would boot-loop). Pure transforms in
  `renderer/lib/kanban.ts`; view choice is personal (`state/viewMode.ts`, localStorage
  `nodeterm.projectView`). The board opens with a **title strip** (`.kanban-header`: project
  dot + name) whose height clears the floating controls-cluster icons — columns never sit under
  them. **Cards collapse/expand on single click** (transient state); the expanded detail row
  reuses `ContextMeter` (model + % pill, per the node header) + session chip + an ↗
  open-on-canvas button; double-click opens the node directly. Z-order contract: overlay 25 <
  `.controls-cluster` 26 (Explorer/SC/Settings stay clickable ON the board) < `.top-banners` 27
  (a mandatory-update card must not hide behind the board) < tabbar 30. An assigned session
  node shows its column as a **half-pill flush on the node's TOP edge** — see the pill sentence
  below. A card's ↗ / double-click opens the **card modal** (`components/kanban/CardModal.tsx`, body
  portal on the dialog-stack, scrim z 55, scrim/Esc close — Esc in CAPTURE phase, and an Esc
  during a header rename only cancels the edit). Terminal cards get a LIVE second view of the
  tmux session (`ModalTerminal.tsx`): the pty subscriber ledger is keyed by the composite
  `(ClientId, viewerId ?? PRIMARY)` (`core/pty-manager.ts` — **viewer identity**; viewerId is an
  optional TRAILING arg through preload/ws-bridge/LocalTransport, absent = bit-for-bit legacy, and
  a client's per-connection socket pause survives a single view's departure). The modal viewer
  seed-paints from the joiner screen (`toXtermText` transforms — raw capture-pane staircases),
  handles fresh-cold via scrollback snapshot + hint (agent auto-resume stays canvas-only), has
  deliberately no park/WebGL/hover/flow-control, and kills ONLY its own viewer on close. Sticky
  cards edit their text in the modal (live both ways).
  The modal header carries the terminal node's actions (search via `useTerminalSearch`+
  `FindBar` on the modal xterm; dictate via the same `nodeterm:dictate` event — `.dictation`
  overlay z is 60, ABOVE the modal scrim; ✦ `pty.generateName` through the modal rename funnel).
  **The 💬 icon means COMMENTS on both surfaces** (repurposed from the markdown view — ⌘M still
  toggles markdown/chat on the canvas node): on a terminal node it opens a right-side comments
  flyout (`.term-node__comments`, a sibling of the overflow:hidden root, hosting BoardLogPanel
  with `card: Pick<KanbanSession,'id'>`); in the modal it collapses/reopens the panel, which is
  OPEN BY DEFAULT there. Under the modal header sits the **card metadata strip** (`CardMetaBar.tsx`): Members (assign) —
  colored initial avatars, picker pool = me + live presence peers + board-log authors (name-keyed,
  NO separate membership system) — and a Due date (`datetime-local`, red Overdue chip past due;
  cards show mini avatars + a due chip). Data = `kanban.meta [{nodeId, assignees, dueAt, priority}]` (priority low/medium/high/urgent, colored chips)
  (tolerant readers via `cardMeta`; pruned with dead nodes; empty entries dropped). Assign/due
  changes are logged through the SAME diff funnel (`member-assigned/unassigned`, `due-set/cleared`,
  `priority-set/cleared`; agent-to-agent message deliveries are logged as `agent-message` by
  `agent-message-trace.recordDelivery`, where `from`/`to` are node ids and `title` is the outcome;
  unknown future event types render neutrally — the `BoardLogEvent.type` union in `shared/types.ts`
  is the source of truth). Feed rows show ABSOLUTE Trello-style stamps
  (relative in the tooltip). The modal's right third is the **board log** panel (`BoardLogPanel.tsx`, `state/boardLog.ts`):
  per-person comments + card activity from `<cwd>/.nodeterm/board-log.jsonl` — append-only JSONL
  (`core/board-log.ts`: tolerant newest-first parse cap 500; text clamped `BOARD_LOG_TEXT_MAX`
  16KB — an SSH append is ONE printf arg, ARG_MAX would silently drop it), author = presence
  identity, registered via `core/board-log-handlers.ts` in BOTH shells (client sends only a
  projectId — the path always derives from the server's own registry, no jail needed). Events
  come from ONE pure funnel (`lib/boardLogDiff.ts` — binding invariant: its `cardTitle` arg
  returns '' for and ONLY for dead nodes; column deletion suppresses per-card moved-to-Ungrouped
  noise; prunes/reorders log nothing) + `createNodeInColumn`'s card-created. Local projects push
  changes via fs.watch; desktop SSH projects poll 5s while subscribed; inline projects show a
  hint. Relay tabs BRIDGE boardLog to the host (pre-dispatch `sharedProjectId` scope guard in the
  relay dispatch — an out-of-scope projectId is refused before any registry/path resolution; a
  connection drop replays its outstanding onChanged unsubscribes). Deliberate v1 gaps: column-level
  events are stored but no card feed shows them; canvas-born nodes get no card-created; no
  card-deleted type.
  Per-column "+ New session" menus create agents/terminal/sticky nodes assigned to the column
  (assignment written UN-pruned — the fresh node isn't in the derived list yet). The column
  half-pill itself: (`components/kanban/ColumnPill.tsx`, `columnForNode` in lib/kanban; rendered
  as a SIBLING of the node root — the roots are overflow:hidden — hidden for Ungrouped/dangling,
  click opens the board). Server Edition works as-is (pure renderer + workspace.save). Scope: no
  agent-driven card movement yet, no board undo, mobile N/A.
- **Omni Kanban (global swimlanes)** (`components/kanban/GlobalKanbanView.tsx`; one swimlane per open project; `state/viewMode.ts` `globalKanban` (localStorage `nodeterm.globalKanban`, machine-local, like `viewByProject`) + `settings.omniKanbanEnabled` (feature gate, default OFF, `settings.json`) / `omniKanbanAsDefault` (when true, `view.kanbanToggle` — Cmd+Shift+B — opens Omni; otherwise per-project; `view.globalKanbanToggle` registry command — unbound, remappable — always opens Omni when enabled); `TabBar` and the menu IPC `onToggleKanban` share one `performKanbanToggle` decision, and `isGlobalKanbanOpen()` is the single gate (fail-closed, static import of `useSettings` — the earlier `require` failed open in the packaged renderer). The active project's lane is derived from serialized `p.nodes` via `toKanbanSessionState` — the persisted-state counterpart to `toKanbanSession` — and is committed (`commitActiveToStore`) before the overlay mounts so live React Flow edits are not stale; `pendingLaunch` never becomes `initialCommand` in the modal (the DAG launch must fire only when dependencies report done, and the canvas `TerminalNode` already delivers `initialCommand` via `writeWhenShellReady` after the `nodeterm:create-node` project switch). Active-project edits (rename / sticky / browser nav) route through Canvas live nodes (`setNodes` + `markDirty`), non-active through the store + `writeDisk`; delete uses `ConfirmDialog` (not `confirm`) and SSH-aware teardown (`transport.destroy` locally vs `sshProject.killSessions` with `everySocket` for a remote owner, plus `agentStatus` / `agentNodes` / `webviewKeepAlive` cleanup). The top bar's project pills and Cmd/Ctrl+1..9 (`nodeterm:swimlane-jump`) jump to the lane; header hint shows the correct mod (`Cmd` on Mac, `Ctrl` elsewhere). Server Edition works as-is, Mobile N/A.
- **Settings** (`SettingsPage.tsx`, ⚙ / ⌘,): font/cursor (live to xterm + Monaco), default
  shell, grid + snap, **default node size** (`defaultNodeWidth`/`defaultNodeHeight` — new
  terminal/agent nodes only, clamped in `terminalNodeSize()` in `state/workspace.ts`),
  pan-hover delay, double-click focus, accent, tmux on/scrollback, commit agent,
  `seenShortcuts`.
- **Shortcuts** (`ShortcutsPanel.tsx`, ? / ⌘/): shown once on first launch (`seenShortcuts`).
  **Derived from the registry, never hand-listed** — see the Keybindings invariant below.
- **Welcome** (`WelcomeScreen.tsx`): shown when no projects exist.
- **Window chrome**: macOS integrated title bar (`titleBarStyle: 'hiddenInset'`); the tab
  bar (`TabBar.tsx`) is the drag region with the `nodeterm` logo + a rounded pill of project
  tabs. The New-project `+` is a **sibling** of `.tabbar__tabs`, not its last child — inside
  the scroller it vanished once the strip overflowed (no visible scrollbar to hint it was
  still there). The wrapping `.tabbar__projects` is `flex: 1` and stays a drag region (not
  `no-drag`); the pill itself must not be `flex: 1` or it inflates into an empty capsule.
  Cmd+M is intercepted in `main/keydown-intercept.ts` (`before-input-event`, installed from
  `main/index.ts` — else macOS minimizes) and forwarded to the renderer via `app:toggle-markdown`;
  Cmd+W (`app:close-node`) and Cmd+0 (`app:zoom-actual-size`) are taken back the same way. **The
  application menu is OURS**: `buildAppMenu` (`main/index.ts`) calls `Menu.setApplicationMenu` and
  re-runs on every settings change. (This bullet used to claim we never call it — false since that
  function landed; check the template, not Electron's defaults.) **COMMAND-style accelerators are
  handled ABOVE the page on every platform** — Minimize, Close, Toggle Kanban Board, Settings,
  Reload — so a chord one of those owns never reaches the renderer, which is why those three are
  stolen in `before-input-event`. **This is not a blanket claim about the whole menu:** the Edit
  submenu's standard `{role:'cut'|'copy'|'paste'|'selectAll'|…}` items behave differently — Chromium
  routes them into the focused element, so ⌘C in a terminal or a text field does the ordinary thing
  and does not need stealing. Ask which kind an item is before reasoning from this bullet.
  That difference is also why the **stand-down has a menu leg**: while a terminal
  owns the keys under `terminal-first` **or while a shortcut recorder is armed**
  (`menuStandsDown(shortcutRecording, policy, terminalFocused)`), `syncMenuForStandDown` disables
  the command-style items
  named in `menuItemIdsToSuspend` — Minimize (`MENU_ITEM_ID_MINIMIZE`), **Toggle Kanban Board
  (`MENU_ITEM_ID_KANBAN`, ⌘⇧B)** and **Settings (`MENU_ITEM_ID_SETTINGS`, ⌘,)** on every platform,
  plus Close (`MENU_ITEM_ID_CLOSE`) on Windows/Linux — because a disabled item suppresses its
  accelerator and only then do those chords fall through to the terminal, or to the recorder.
  Off-mac the Close item is ALSO disabled whenever a terminal has focus, policy or no policy
  (`closeStandsDownInTerminal`, issue #383): its role owns the Ctrl+W accelerator, and that
  keystroke in a shell is readline's kill-word. The
  recorder leg is why ⌘M is bindable at all, and it fixed a live misfire: ⌘⇧B pressed into an armed
  recorder used to open the kanban board behind the Settings dialog, and ⌘, to re-open Settings.
  Kanban and Settings are
  the ones a reader gets wrong: they are **not** intercepted chords at all but ordinary registry
  commands (`view.kanbanToggle` / `app.settings`), so the renderer's dispatcher could never stand
  them down itself — under app-first the menu takes them before the keydown exists, which is also
  why their capture NOTICE is raised at the IPC receivers in `Canvas.tsx` rather than by the
  dispatcher. **Reload (⌘R / ⌘⇧R) is the named exception and stays live while stood down**: it is
  the crash-recovery lever (a wedged renderer is exactly when it is needed) and a main-frame
  navigation is one of the three sites that reset `terminalFocused` / `shortcutRecording`. **Of the
  items main suspends, Reload is therefore the deliberate exception** — the one it holds back from a
  shortcut recorder — which is what the Keyboard Shortcuts section's description now says.
  **KNOWN GAP, pre-existing and accepted:** the suspend list only ever covered the command-style
  items the terminal-first policy needed, so the always-on app roles — `quit` (⌘Q), `hide` /
  `hideOthers` (⌘H / ⌘⌥H), `toggleDevTools`, `togglefullscreen` — still act while a recorder is
  armed (⌘Q pressed into one QUITS the app). They are deliberately NOT added: ONE list drives both
  stand-downs, and making ⌘Q/⌘H unreachable for a terminal-first user is the worse trade — quit and
  hide must never be policy-gated. Splitting the list per stand-down is the change that would close
  it, and it has not been made.
  `keydown-intercept.test.ts` pins both the stolen chords and the suspended item ids (including
  that the list does not silently grow) — `getMenuItemById` answers `null` for a typo and the
  fail-safe is to do nothing, which is indistinguishable from the feature working.
- **Theme**: macOS dark palette as CSS tokens in `styles.css` `:root` (`--accent` = systemBlue,
  label/separator opacities, SF font stack). Canvas background is black with dot grid.

## Remote access (phone relay) — free, not Pro

- Phone relay remote access ("Reach this Mac from anywhere") is a **Core (free) feature** as of
  2026-08-01 — the iOS app is itself paid, so a desktop Pro gate double-charged the same feature.
  The former Pro gate AND the free-tier monthly quota (`core/relay-quota.ts`, `RelayQuotaBanner`,
  the ProCompare meter, the `relayQuota` IPC/preload/bridge surface, docs/relay-quota.md) were all
  **removed**. The toggle (`settings.phoneAccessEnabled`, Settings → Phone + quick-pair popover)
  shows for everyone; the standing host reconciles on `enabled && relayAllowed()` alone, with no
  quota metering at `onPeerReady`. **Entitlement passthrough remains**: a stored Pro entitlement is
  sent on mints, else the `{deviceId,…}` body (host-token `{deviceId, hostPublicKeyB64}`, device
  mint `{deviceId, hostDeviceId, hostPublicKeyB64, label}`). **The backend is the real gate now**:
  `POST /v1/relay/host-token` / `/v1/relay/device` must admit deviceId (no-entitlement) mints, and
  the relay server may rate-limit free hosts independently — a client-side gate must NOT be
  reintroduced to work around a backend refusal (fix the backend policy instead).

## Speech / dictation (desktop + server)

Voice-to-text input captured via microphone, turned into terminal text via on-device Whisper. Works on desktop (Electron) and Server Edition (browser); iOS support is separate (`nodeterm-ios`, private — see the three-surfaces entry under Conventions).

- **Service seam** (`src/core/speech/`) — `SpeechService` (core) + `PlatformSpeechProvider` interface + shell implementations (`PlatformElectron` / `PlatformServer`). Models are stored under `${dataDir}/speech-models/`, with fenced downloads + orphan sweep (`removeUnusedModels`). Core validates license: **tiny** free (always); **base·small·large-v3-turbo** Pro (via `isPremium()`). One model loaded at a time (FIFO memory management), lazy smart-whisper import degrades to a friendly error if the native dep is unavailable (`"Local whisper is unavailable…"`).
- **Cloud contract (iOS parity)** — `/v1/transcribe` multipart endpoint (not built yet; SDK `transcribe()` call matches iOS byte-for-byte) for future remote transcription. IPC channels `speech:*` (in `src/shared/ipc.ts`) wired in **both** Electron and Server: `speech:transcribe` (returns `Promise<{text}>`), `speech:models`, `speech:model-download`, `speech:model-delete`, `speech:progress` (main/server → renderer download-progress broadcast), and `speech:mic-consent` (Electron mic-prompt only, server always true). There is no `speech:synthesize` / `speech:cancel` and no audio in the reply.
- **Renderer capture** — `PcmCapture` AudioWorklet (16kHz single-channel PCM, WebAudio or fallback SPN) + DictationOverlay (⌘⇧D dock mic / Cmd key; Settings → Speech section for model choice + progress). **Send** appends text + Enter to the terminal; **Insert** sends text-only via `sendText(…, {enter: false})`. **Nothing auto-submits** (user always decides when to send).
- **Language** — `SPEECH_LANGUAGES` (`src/shared/speech.ts`) is whisper's own `LANGUAGES` table
  (tokenizer.py) verbatim: 100 entries carrying the code, CLDR's English name, the endonym and the
  alternate spellings people type (whisper's own name where it differs, plus its documented alias
  table); Cantonese is flagged `sinceV3`, the one entry the pre-large-v3 models have no token for.
  It replaced a **7-entry array inside `SpeechSection`** which was the ONLY limit in the whole
  stack (issue #586): `SpeechSettings.language` is a free string nothing validates on the way to
  disk and whisper.cpp takes any code, so `"language": "pl"` hand-edited into settings.json
  transcribed Polish correctly while the dropdown rendered **blank** and overwrote it on the next
  click in the row. Three rules come out of that:
  - The control is the app's **searchable menu idiom** (`SpeechLanguageSelect` — `.bind-select`
    trigger + portaled `.tab-menu` with a pinned filter over a scrolling list, the Source Control
    branch quick-pick's shape), never a `<select>`: 101 rows with no search, unreachable by typing
    "polski", is not a picker. Rows are the pure `renderer/lib/speechLanguageRows.ts`.
  - **A code we cannot name is still the user's setting.** `speechLanguageLabel` returns an unknown
    code AS-IS (not `''`) and the picker gives it its own row, so a display gap can never become
    data loss the way the `<select>` made it.
  - **The cloud `locale` is passed through unchanged, `auto` included.** `register-ipc.ts` used to
    send `language === 'auto' ? 'en' : language`, so on the Cloud engine "Auto-detect" was a hard,
    silent English — on the one engine where a missing language could not be worked around at all.
    `/v1/transcribe` does not exist yet, so `auto` = detect is our contract to write.
  Deliberately NOT done here: seeding the initial value from the system locale (issue #586 §3) —
  the default is still `auto`. **Mobile** keeps its own list, tracked separately as issue #591.
- **Browser constraints** — `getUserMedia` requires HTTPS or `localhost`; mic permission prompt is the browser's own (not handled by nodeterm). Model downloads land on the **server's data dir** (accessible across sessions).
- **Electron + native dep** — smart-whisper is externalized + `asarUnpack`'d (not bundled); `postinstall` rebuilds it against Electron's ABI. Device verification of the ABI rebuild is not yet exercised on a dev machine — test paths exist but have not been run in CI.

## Packaging & auto-update

Built with **electron-builder** (config in the `package.json` `build` block: appId
`com.nodeterm.app`, productName `nodeterm`, mac dmg+zip for arm64 **and** x64, `asarUnpack`
node-pty, output `dist/`). The app icon is generated from the nodeterm mark by
`scripts/make-icon.mjs` (sharp → `build/icon.png` 1024² + multi-resolution `build/icon.ico`
for Windows, both gitignored — regenerated by `make-icon`, which every dist script runs first);
the same script hand-packs `build/icon.icns` (size-checked frames — issue #369) and `build/icon.ico`, which electron-builder embeds as-is. Scripts: `npm run make-icon`, `npm run dist`
(local **unsigned** arm64 `.dmg` smoke test), `npm run dist:win` (unsigned x64 NSIS installer +
zip, `--publish never`). Production release signing/notarization and the update-feed hosting are
handled outside this repo.

**Windows ships as an UNSIGNED BETA** (extracted from external PR #276; the session-host phase
#305 merged 2026-08-20, and the decision to release without signing is #454 — CI-green, but no
real-device daily-use verification yet, and that is a stated risk, not an oversight). Deliberate
decisions: the target
is **NSIS via electron-builder** — the fork switched to Squirrel.Windows
(`electron-builder-squirrel-windows` + an 800-line `windows-installer.mjs` wrapper + its own
update feed), but our pipeline is electron-builder end-to-end and NSIS is built in, needs no
extra dependency, and is what electron-updater's generic provider expects on Windows — so
Squirrel was not adopted. Builds are **unsigned** (no Windows cert; electron-builder skips
signing when no cert env is present; SmartScreen warns on install). Release wiring is
`release.yml`'s `release-win` job: on every version tag it uploads the NSIS installer + zip as
GitHub Release assets — **best-effort by design** (the `publish` promote gate does not wait on
it, so a Windows failure never strands the mac+linux release) and with **no update-feed leg**:
`dist:win` stamps `nodeTermUpdates=disabled`, so the shipped app's updater is cleanly off (no
latest.yml anywhere, no 404 polling; users update by downloading the next installer). Do not
add `*.yml`/`*.blockmap` to that job's upload globs — that IS the auto-update leg, and it waits
on signing. `bootstrap-windows.bat` (repo root) takes a fresh Windows
machine to a built checkout: it verifies Node ≥ 20 / VS Build Tools C++ / Python 3 with exact
winget hints (it never installs machine-wide tools itself, and the full bootstrap refuses to run
elevated) and runs `npm ci`. Its `--check-vs-build-tools` mode is the narrow exception used by
`quality-windows`: it branches before the elevation refusal, runs only the VS C++ probe, and exits
before the Node / Python / `npm ci` steps. Fixture injection additionally requires the explicit
`NODETERM_BOOTSTRAP_TESTING=1` sentinel. `.github/workflows/win-package-smoke.yml` is a
**workflow_dispatch-only** packaging smoke on windows-latest — build only, never publishes.
**Follow-ups, in order:** code signing, then Windows auto-update wiring (electron-updater NSIS leg
+ `latest.yml` on the nodeterm.dev feed — blocked on signing: an unsigned auto-update is a
downgrade in trust), and the fork's PE-identity polish (electron-builder leaves `OriginalFilename`
empty; the fork's
`resedit`-based afterSign hook fixes it — cosmetic for NSIS, load-bearing only for Squirrel).

**macOS permission prompts are declared in `build.mac.extendInfo`, and a missing one denies
SILENTLY.** On macOS 15+ a connection to the user's own subnet is gated by Local Network privacy,
and it is attributed to the **responsible process** — for everything nodeterm spawns (the tmux
server, the shell, an agent CLI, the `node` it runs) that is nodeterm.app, not the child. With no
`NSLocalNetworkUsageDescription` there is no string to prompt with, so the system never asks and
**no row appears** under System Settings → Privacy & Security → Local Network for the user to
grant: an agent gets `EHOSTUNREACH` on a LAN address while `/usr/bin/curl` (Apple-signed, exempt)
reaches the same host in the same second — a permission failure wearing a network outage's error
(issue #589). `NSBonjourServices` is the trap that travels with it: it is required only to *browse*
mDNS services, which this app does not do, and declaring service types we never browse is a false
claim to the user and to review — unicast LAN access needs the usage description alone. The key is
what makes the denial grantable; it is not itself proof anyone's access came back. Guarded as an
allowlist-with-reasons by `src/main/info-plist.test.ts`, the sibling of the entitlements guard.

Auto-update uses **electron-updater** (`src/main/updater.ts`, `initUpdater(onBeforeRestart?)` from `index.ts`):
runs **only when `app.isPackaged`** (dev = no-op), checks on launch + every 6h, auto-downloads,
forwards the lifecycle (`update-available` / `download-progress` / `update-downloaded` / errors)
to the renderer over IPC. `components/UpdateCard.tsx` shows the strip + **Restart to update** →
`updates.restart()` → `autoUpdater.quitAndInstall()`; on `update-downloaded` an OS notification
also fires when the window is unfocused. Exposed via `window.nodeTerminal.updates` (`UpdateApi`).
macOS *silent* self-install requires a signed+notarized build; unsigned builds still surface
the card for a manual download.

**Backend check feed** (`src/core/check.ts`, successor to the static `announcements.json`): the
**main process** calls `GET https://api.nodeterm.dev/v1/check?version=&os=&channel=stable` (so the
renderer CSP stays `'self'`) on launch + every 6h, cached 5 min, returning `{ messages, update }`.
Exposed split over two IPC handlers: `announcements.fetch()` → `messages`, `appUpdatePolicy` →
`update`. `components/AnnouncementBanner.tsx` (stacked above `UpdateCard` under the tab bar in a
`.top-banners` column) shows the newest message the user hasn't dismissed (dismissed `id`s persist
in `localStorage`); `update.mandatory`/`minSupported` flips `UpdateCard` into a blocking required-
update state. The call no-ops under `DO_NOT_TRACK`/`NODETERM_TELEMETRY_DISABLED` or in unpackaged
builds (unless `NODETERM_API_BASE` targets a local server). Schema example:
`docs/announcements.example.json`. **Telemetry** (`src/main/telemetry.ts`) is a separate opt-out
ping to `api.nodeterm.dev/v1/ping` (version/OS on launch + daily), gated on
`settings.telemetryEnabled` + the same build/DNT guards; toggle in Settings → Privacy.

## Atomic writes (never a bare `fs.rename`)

Every store persists temp-file-then-rename. That is correct on POSIX and **silently lossy on
Windows**: `MoveFileEx` fails with `EPERM` whenever the destination is open by anyone at that
instant, and what opens a file you just wrote is Defender's real-time scanner, the search indexer,
OneDrive over a synced profile, or two of our own concurrent writers racing one destination. The
save throws and the data is gone — intermittently, unreproducibly, and **more often on the machines
that are best protected**.

`renameAtomic` / `writeFileAtomic` (`src/core/fs-atomic.ts`) retry briefly. Each attempt is still
one indivisible rename, so a retry cannot tear a write. They deliberately do NOT retry forever
(several callers report a failed save as `persisted:false`, and that contract outranks a save that
eventually lands), do not retry `ENOENT`/`ENOSPC`, do not branch on platform (or the behaviour under
test on a Mac is not the behaviour shipped to Windows), and never swallow the final error.

**Nothing in the toolchain catches the bare version.** 28 files had it, across three spellings — the user's canvas, their
settings, their sealed credentials, their pinned devices — and every one of them reads as a correct
atomic write, because on the platform most of this was written on it is one. The only signal in a
6,000-test suite was one store's overlapping-saves test, red on Windows for that store's whole life.
So it is enforced by scan: `src/core/fs-atomic.guard.test.ts` fails on any bare `fs.rename` outside
the helper. Full write-up, including the separate shared-temp-name bug at the same sites:
**`docs/atomic-writes.md`**.

SSH/scp staging follows the same ownership rule outside direct `fs` calls. Atomic remote stdin
writes use `src/main/remote-atomic-write.ts`: a bounded `.nodeterm-<uuid>.tmp` leaf is placed beside
the target BEFORE both complete paths are quoted, then the shell preserves the write/move status
while cleaning that exact temp. The temp leaf must stay independent of the target leaf — appending
`.uuid.tmp` to a valid `NAME_MAX` target makes the write impossible. It currently protects
filesystem API writes, tmux.conf, the private hook endpoint, node
tokens, agent status and pending answers; generated hook scripts/config merges still use their
existing direct writes and must not be described as atomic. Upload directories use UUIDs across app
processes. Downloads and media-cache copies use hidden UUID `.part` names; user-visible downloads
also hold an exclusive candidate lock until the rename and cleanup finish. Never simplify any of
those back to `<target>.tmp` / `<target>.part` or a read-only "does the destination exist?" check —
the overlap tests exercise the resulting race.

## The test suite never touches a live tmux server

This repo is developed from inside nodeterm, so `tmux -L node-terminal` and `-L nodeterm-rmt` are
not fixture names on a contributor's machine — they are the servers holding every terminal they have
open. A test that binds one shares a process with the user's whole canvas, and the failure mode is
not a red test: it is every pane printing `[server exited unexpectedly]` (issue #629).

**Every vitest run gets a private `TMUX_TMPDIR`.** tmux resolves `-L <socket>` to
`$TMUX_TMPDIR/tmux-<uid>/<socket>` and falls back to `/tmp` when the variable is unset, so
re-pointing the variable re-points every socket name at once — including the real ones, including
in a suite nobody thought about. `test/setup/tmux-sandbox.ts` (`globalSetup`) creates the directory,
kills whatever is still bound inside it and removes it; `test/setup/tmux-worker-env.ts`
(`setupFiles`) re-asserts it inside each worker and **refuses to run** if it is missing, because
vitest's env inheritance into workers is an implementation detail and a silent fallback would put
every test back on the live server. `enterSandbox` also strips `TMUX`/`TMUX_PANE` — a suite run from
inside a nodeterm terminal inherits a live client's, and production strips both for the same reason.

Two suites deliberately name a real socket, and both are allowlisted with their reason in
`src/core/tmux-socket-isolation.guard.test.ts`: `agents/pane-owner.test.ts` (the production bytes
hardcode `-L nodeterm-rmt`; re-spelling it would judge different bytes) and
`main/remote/host-destroy-tmux.test.ts` (`PtyManager` binds `TMUX_SOCKET` itself). The latter was
the one file that reached the live server by construction — measured, not inferred — and it now
refuses to start unless the sandbox is in effect.

**What the sandbox does NOT do:** two suites naming the same socket inside it still share one tmux
server, so a `kill-server` there is still a shared-server kill — it has just been moved somewhere
harmless. Measured on CI the day this landed: the guard test's own `kill-server` on
`node-terminal` ended `host-destroy-tmux.test.ts`'s session mid-assertion. A suite kills its OWN
sessions by exact target (`-t =<name>`, since a miss falls through to prefix matching), or it owns
a socket name nothing else uses.

The guard has three legs on purpose, and the weakest one is the scan: a test can still escape by
handing a real tmux an `env` object it built from scratch with no `TMUX_TMPDIR` in it, which no
regex sees. So the structural leg is the sandbox, the behavioural leg actually **starts a server on
the real socket name and proves the socket file landed inside the sandbox** (asserting the env var
would only prove we set a variable — the resolution rule is a property of tmux), and the scan exists
to make a third allowlist entry a decision somebody signs for. Same shape as the `fs.rename` guard,
for the same reason: nobody reading one file can see this.

**What this does not claim.** #629's server death was not traced to a test — the reporter's evidence
points at tmux's `server_accept()` calling `fatal()` under the suite's process/fd burst on a
memory-starved machine, and two identical runs finished clean. Sharing a server with the user's live
sessions is a hazard whatever kills it; this removes the hazard, not a proven cause.

## Conventions

- **Two docs, two audiences — keep both.** This file holds the deep invariants with their
  reasoning and measurements; it is dense on purpose and is loaded automatically by coding agents.
  **`CONTRIBUTING.md` is the short human door**: setup, the process-boundary rules, the house rules
  that get a PR sent back, and the testing habits. When you change or discover something **other
  developers must know before touching the code** — a boundary that is now enforced, a trap that
  costs an hour to diagnose, a habit that catches a class of bug — **add it to `CONTRIBUTING.md`
  too, not only here.** An invariant that lives only in this file (or worse, only in a commit
  message) is one refactor away from being violated by a contributor who never opened it. Keep the
  split by audience, not by topic: the *why it must be this way* stays here, the *what you need to
  know before your first PR* goes there.


- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- **The local machine is not a Mac.** Every user-visible string naming it goes through
  `renderer/lib/machineName.ts` (`thisMachine()` / `thisMachineCap()` / `machineNoun()` →
  "this Mac" / "this PC" / "this computer"). A **browser tab always gets the neutral word**: the
  license, seats and sessions it describes belong to the SERVER, and the viewer's `navigator` says
  nothing about that machine's OS — a confident wrong noun is worse than a plain one. Issue #563
  found ~30 such strings, and the damage was not in Accounts but in the copy people must TRUST:
  "This Mac is not authorized on this license" and "a teammate on a seat can run commands on this
  Mac". `machineName.guard.test.ts` scans non-comment lines in `src/renderer` + `src/shared` and
  fails on a new one, with a named-and-reasoned exemption list (the ptmx-limit banner, whose
  `kern.tty.ptmx_max` really is macOS; the onboarding notch step, which only exists there).
  `@shared` code cannot ask the renderer, so it takes the machine word as a PARAMETER defaulting
  to the neutral one (`describeGrant(peer, machine)`) rather than hard-coding a brand.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
- **Subagent model:** when dispatching subagents (implementers, reviewers, etc. — e.g. in
  the subagent-driven-development workflow), use the latest model, **Opus 5**
  (`claude-opus-5`). This overrides any cheaper-model defaults in a skill's model-selection
  guidance.
- **Three surfaces — design every feature for all of them.** nodeterm now ships on three
  fronts, and a feature is not "done" until you've decided how it behaves on each (even if
  the decision is "not applicable here"):
  1. **Desktop** (Electron) — the primary app (`src/main` + `src/renderer` via the preload).
  2. **Server Edition** (Linux, browser) — `src/server` + the `src/renderer/bridge` shim (see
     the `src/server/` bullet above and docs/SERVER.md).
  3. **Mobile companion** — *nodeterm mobile*, a **separate PRIVATE repo** (`nodeterm-ios`)
     — outside contributors cannot see or PR it, so a mobile implication is raised in the
     desktop PR and **@eneskirca** is mentioned to carry it over
     (SwiftUI + SwiftTerm/Citadel, tmux-integrated, talks the `TerminalTransport`/RemoteTransport
     protocol).

  **The canvas and the kanban board are TWO VIEWS of the same nodes — treat the board as a
  first-class surface, not an afterthought.** Every session/node feature you add to a canvas node
  (a header action, a context-menu item, a status badge, file drop, dictation, …) should be
  considered for the kanban **card** and its **card modal** too, so we don't keep shipping a
  feature on one view and then bolting it onto the other in a follow-up. The board already mirrors
  most of the node's surface: the card modal co-attaches the same tmux session (`ModalTerminal`),
  carries the node's actions (search / dictate / AI-name / comments), accepts file drops
  (`terminal/file-drop.ts`), renders browser webviews (`BrowserSurface`), and its cards support
  right-click actions + `+ New`. When you touch a node's UI, ask "does the board need this too?"
  and wire it through `KanbanView`/`SessionCard`/`CardModal` in the SAME change. Kanban itself is
  desktop+Server-Edition (pure renderer + `workspace.save`); the iOS board is a separate read/move
  mirror (`nodeterm-ios`, `KanbanGrouping`/`ProjectBoardView`).

  Practical rules that keep the surfaces in sync:
  - **Put new service/main-process logic in `src/core` behind `CorePlatform`, never inline in
    `src/main`.** That is the seam the Server Edition boots from — logic left in `src/main`
    silently doesn't exist on the server (the `no-electron` tests enforce the boundary, but
    they can't tell you a feature is *missing* server-side).
  - **A feature that touches `window.nodeTerminal` needs a real `src/renderer/bridge`
    implementation, not just a stub** — or a deliberate, documented graceful degrade
    (`E_UNSUPPORTED` + the affordance hidden, like the Electron-only `shell.reveal`). The
    bridge's `satisfies NodeTerminalApi` gate forces you to *declare* every member, but a
    `noopUnsub`/`unsupported` stub compiles fine while doing nothing — decide per member.
  - **Consider whether the mobile companion should surface the feature** over its
    transport/protocol. It's a different repo and stack (Swift), so this is usually a
    follow-up note rather than same-PR work — but flag it so it isn't forgotten.
  When a change is genuinely desktop-only (native menus, auto-update, Keychain), say so; the
  point is to make the call consciously, not to leave the other surfaces to rot.

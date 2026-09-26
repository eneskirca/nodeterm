---
paths:
  - "src/renderer/components/kanban/**"
  - "src/renderer/lib/kanban*.ts"
  - "src/renderer/lib/boardLogDiff.ts"
  - "src/renderer/lib/markdownChord.ts"
  - "src/renderer/state/boardLog.ts"
  - "src/renderer/state/githubIssues.ts"
  - "src/renderer/state/viewMode.ts"
  - "src/renderer/state/worktrees.ts"
  - "src/core/board-log*.ts"
  - "src/core/project-kanban-write.ts"
  - "src/core/github/**"
  - "src/core/git-service.ts"
  - "src/main/remote/relay-project-scope.ts"
  - "src/shared/kanban-*.ts"
  - "src/shared/scm-scope.ts"
  - "src/shared/worktree*.ts"
---

## Worktrees and kanban (from "Canvas interaction & panels")

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
  overlay z is 60, ABOVE the modal scrim; ✦ `pty.generateName` through the modal rename funnel;
  and the **⌘M view** — a header toggle (`IconMarkdown`) plus the chord, which lays the SAME face
  the canvas node shows over the live viewer: `ChatPanel` when `canChat(created agent)` and the
  session id is known, else `TerminalMarkdownView`. Three rules: the state is MODAL-LOCAL and per OPENING
  (never `data.mdMode` — that would flip the canvas node under the board too); the viewer
  stays MOUNTED underneath (covered, not swapped, so its co-attach never detaches/re-attaches) and
  gets the same focus hand-off as the node (`ModalTerminal`'s `covered` → `useMdModeFocus`); and the
  chord reaches the modal through `window.nodeTerminal.onMarkdownToggle` only while it is the top
  dialog, while the canvas terminal AND editor nodes' own subscriptions refuse the chord whenever a
  board is up (`lib/markdownChord.ts` `canvasOwnsMarkdownChord` — a hover flag can go stale under
  the opaque board, so one press could otherwise flip both). The header also carries the node's
  pause chips — DROPPED, PAUSED and SLEEPING (Eco, with the refused-wake sentence) — each clicking
  through the same `wakeHibernatedNode` trigger as the canvas chip. The overlay sits at z 5 in the pane, BELOW the
  sheet's resize handles (z 6/7, issue #389) — pinned in `styles.kanban.test.ts`.
  **The 💬 icon means COMMENTS on both surfaces** (repurposed from the markdown view — ⌘M still
  toggles markdown/chat on the canvas node, and on the card modal): on a terminal node it opens a right-side comments
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
  connection drop replays its outstanding onChanged unsubscribes). **The relay-guest scope jail is
  keyed on channel CLASS, not a per-feature list** (`main/remote/relay-project-scope.ts`): every
  method whose name starts with `githubIssues:` / `board-log:` / `projects.` is project-scoped, and
  one the table cannot read a projectId out of is REFUSED on a scoped session. The switch it
  replaced had a `default: not project-scoped` arm, so a new verb in one of those namespaces reached
  another project's data with no refusal anywhere. A new channel in a scoped class therefore needs a
  table row to become reachable — and `relay-project-scope.test.ts` fails if a live IPC channel in a
  scoped class has none, so the fail-closed default cannot silently swallow a shipped verb. Deliberate v1 gaps: column-level
  events are stored but no card feed shows them; canvas-born nodes get no card-created; no
  card-deleted type.
  Per-column "+ New session" menus create agents/terminal/sticky nodes assigned to the column
  (assignment written UN-pruned — the fresh node isn't in the derived list yet). The column
  half-pill itself: (`components/kanban/ColumnPill.tsx`, `columnForNode` in lib/kanban; rendered
  as a SIBLING of the node root — the roots are overflow:hidden — hidden for Ungrouped/dangling,
  click opens the board). Server Edition works as-is (pure renderer + workspace.save). Scope: no
  agent-driven card movement yet, no board undo.
  **Mobile (nodeterm-ios) reaches the board through three relay verbs**, all landing in
  `WorkspaceStore.ensureRemoteBoard` / `setRemoteCardColumn` / `editRemoteCardLabels` (host-service
  `handleKanban`; wired in `main/index.ts`'s `hostBridge.kanban`; pure transforms in
  `core/project-kanban-write.ts`): `projects.ensureBoard` seeds the default columns on a project that
  has none, `projects.setCardColumn` moves one card, and `projects.editCardLabels` adds / removes /
  creates **board labels** on one card (the phone's long-press label sheet, 2026-09). There is ONE
  label model — the per-project palette in `kanban.labels` plus per-card ids in `kanban.meta[].labels`
  — and the label verb writes it through the SAME transforms the canvas node's "+ Label" row and the
  kanban card use: the card-meta + label half of `lib/kanban.ts` moved to `@shared/kanban-labels`
  (re-exported, renderer call sites unchanged) so core can apply it; a test pins that a phone edit
  produces the board `toggleCardLabel` produces. Params are validated at the write site
  (`parseCardLabelEdit`: bounded control-free ids, 1–60-char control-free names, colour from the closed
  palette, no id both added and removed) because they land in a git-shared, hand-editable file; a
  created name matching an existing label case-insensitively REUSES it (the picker offers no Create
  on an exact match); the first label on a board-less project seeds the default board, as the
  desktop's first "+ Label" does; a stale `add` answers `edited:false` with the CURRENT palette so the
  phone can redraw. Deleting/renaming palette entries is deliberately desktop-only (it touches every
  card). The iOS direct-SSH path has a Swift twin of the transform for projects on the host it dials. Three things make them necessary rather than convenient. (1) The desktop board is a
  LAZY default — `kanban` is not written until the user's first board edit — so most project files
  carry NO board and the phone, which knows a project only by its file, could not offer one
  (measured: 1 of 13 project files on the author's machine had a `kanban` block). The default columns
  therefore live in `@shared/kanban-default-board`, read by `defaultKanban()` AND by the core seeder,
  and copied verbatim (under a pinning test on both sides) by iOS `KanbanDefaults`. (2) An SSH
  project's file is on a THIRD machine the phone has no credentials for; the verb writes the entry's
  `cache` and lets the ordinary mirror push it, which is exactly what a desktop card drag does — so
  it needs nothing new from `reconcileSsh` (that decides by `rev` and unions only `nodes`). Its cache
  change IS persisted to workspace.json, because for an ssh entry the cache is the local record. (3)
  The phone's older direct-SSH write inlines the whole project.json into one argv string and so dies
  at Linux's `MAX_ARG_STRLEN` — this repo's own `.nodeterm/project.json` measured 114,695 bytes,
  ~15 KB under the 128 KB ceiling. **Both verbs announce their write on `workspaceExternalChange`
  and that is not optional**: the renderer holds its own board and the next whole-workspace save
  serializes THAT, so a change the renderer never heard about is one the next autosave reverts.
- **Omni Kanban (global swimlanes)** (`components/kanban/GlobalKanbanView.tsx`; one swimlane per open project; `state/viewMode.ts` `globalKanban` (localStorage `nodeterm.globalKanban`, machine-local, like `viewByProject`) + `settings.omniKanbanEnabled` (feature gate, default OFF, `settings.json`) / `omniKanbanAsDefault` (when true, `view.kanbanToggle` — Cmd+Shift+B — opens Omni; otherwise per-project; `view.globalKanbanToggle` registry command — unbound, remappable — always opens Omni when enabled); `TabBar` and the menu IPC `onToggleKanban` share one `performKanbanToggle` decision, and `isGlobalKanbanOpen()` is the single gate (fail-closed, static import of `useSettings` — the earlier `require` failed open in the packaged renderer). The active project's lane is derived from serialized `p.nodes` via `toKanbanSessionState` — the persisted-state counterpart to `toKanbanSession` — and is committed (`commitActiveToStore`) before the overlay mounts so live React Flow edits are not stale; `pendingLaunch` never becomes `initialCommand` in the modal (the DAG launch must fire only when dependencies report done, and the canvas `TerminalNode` already delivers `initialCommand` via `writeWhenShellReady` after the `nodeterm:create-node` project switch). Active-project edits (rename / sticky / browser nav) route through Canvas live nodes (`setNodes` + `markDirty`), non-active through the store + `writeDisk`; delete uses `ConfirmDialog` (not `confirm`) and SSH-aware teardown (`transport.destroy` locally vs `sshProject.killSessions` with `everySocket` for a remote owner, plus `agentStatus` / `agentNodes` / `webviewKeepAlive` cleanup). The top bar's project pills and Cmd/Ctrl+1..9 (`nodeterm:swimlane-jump`) jump to the lane; header hint shows the correct mod (`Cmd` on Mac, `Ctrl` elsewhere). Server Edition works as-is, Mobile N/A.

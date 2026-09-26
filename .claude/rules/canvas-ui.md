---
paths:
  - "src/renderer/canvas/**"
  - "src/renderer/components/*.tsx"
  - "src/renderer/components/settings/**"
  - "src/renderer/App.tsx"
  - "src/renderer/lib/addMenuSpec.tsx"
  - "src/renderer/lib/breadcrumbs.ts"
  - "src/renderer/lib/canvasLayout*.ts"
  - "src/renderer/lib/explorerPin.ts"
  - "src/renderer/lib/floatingEdge.ts"
  - "src/renderer/lib/nodeFocus.ts"
  - "src/renderer/lib/ui-visibility.ts"
  - "src/renderer/lib/zoomShortcut.ts"
  - "src/renderer/state/explorer.ts"
  - "src/renderer/state/gitBranches.ts"
  - "src/renderer/state/scmCache.ts"
  - "src/core/commit-message.ts"
  - "src/core/git-service.ts"
  - "src/main/window-state.ts"
  - "src/main/keydown-intercept.ts"
  - "src/main/index.ts"
  - "src/shared/canvas-layout.ts"
  - "src/shared/window-chrome-metrics.ts"
  - "src/main/window-raise.guard.test.ts"
  - "src/core/fs-ops.ts"
---

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
  in `Canvas.tsx`, operate on `targetIds`. **Conversation actions are grouped** so an agent node's
  menu fits on screen: **Transfer conversation ▸** holds one row per target (a model-capable target
  nests its gateway models one level further), and **Restart ▸** holds the restart variants —
  restart, restart + fresh shell, restart on subscription, then Reopen as. Switch model ▸ and Switch
  account ▸ stay first-level rows beside it (everyday choices, not recovery restarts).
  `ContextMenu` renders submenus to any depth (`MenuRows` is recursive); a flyout that hosts a
  submenu drops its scroll (`.ctx-submenu--host` — `overflow: auto` would clip the
  nested flyout) and `useSubmenuFlip` lifts a flyout that would run off the bottom. The non-destructive rows are user-hideable from
  **Settings → Appearance** ("Node menu items" / "Terminal header buttons"), stored as HIDDEN
  lists in `settings.hiddenNodeMenuItems` / `settings.hiddenHeaderButtons` (empty = everything
  shows). `lib/ui-visibility.ts` owns the two inventories and `isHidden`, which only answers for
  ids it knows — so Delete, restart-agent, branch/transfer, terminal Search and Close can never
  be hidden, whatever settings.json says. The group-frame menu's colors strip answers to the same
  `colors` id; builders run through `tidySeparators` so a hidden row leaves no dangling rule.
- **Add menu** = bottom dock (`Dock.tsx`) `+`, mirrored by the pane menu and command palette.
  `lib/addMenuSpec` is the one source for WHICH kinds are addable, and since 2026-09 also for how
  the two `ContextMenu` surfaces GROUP them: `New terminal` · `New remote…` · the account-capable
  agents · `New agent ▸` · `New view ▸` · `Files ▸` · `Orchestrate ▸`, then the canvas actions. It
  replaced a flat 18-row list, on the rationale that ⌘K already makes every one of these
  searchable and the keybinding registry already carries a remappable command per agent and per
  node kind (`node.new*`) — so this menu does not have to be EXHAUSTIVE, it has to be FAST.
  Four rules hold it together, and the first is the one that is easy to get wrong:
  - **The submenu depth cap is STRUCTURAL.** `ContextMenu` renders a submenu's children with
    `if (child.type === 'colors' || child.type === 'submenu') return null` — a third level is
    dropped with no error and nothing on screen. Claude's and Codex's **account pickers are already
    level-two submenus**, so nesting either row behind `New agent ▸` would silently delete the
    account picker for exactly the users who have managed accounts. MEASURED, not assumed, in
    `components/ContextMenu.submenu-depth.test.tsx`; teach the component a third level and that
    test goes red so the pin can be reconsidered deliberately.
  - **Which agent rows stay at the first level is DERIVED, never a spelled-out agent id**
    (`isPinnedAgentEntry`): a row that IS a submenu (structural, per above) **or** whose agent is in
    `ACCOUNT_CAPABLE_AGENT_IDS` (`shared/agents/account-binding.ts` — the same list `boundAccountId`
    reads, so a third agent gaining managed accounts cannot light up one and not the other). The
    second half exists because rule one alone would move Codex in and out of the submenu as the
    user adds or removes accounts, and a menu that rearranges itself is a menu nobody can learn.
    A new builtin agent joins `New agent ▸` by itself; one that gains accounts is promoted by itself.
  - **`ADD_ITEM_GROUP` is a total `Record` over the kind union on purpose** — a new `AddItem` kind
    is a compile error until somebody routes it, instead of silently landing in one bucket forever.
    `remote` stays top-level because it is not an agent: burying the one SSH-session entry point
    under a menu named "New agent" puts it where nobody would look.
  - **Grouping is a rearrangement, never a filter, and a nested row keeps its REASON.** The rows
    still come from `contentAddItemsToMenuItems`, so `New worktree…` is greyed with
    `WORKTREE_SSH_HINT` inside `Orchestrate ▸` exactly as it was at the top level (the cap drops
    nested submenus, never a leaf's `disabled`/`hint`). Tests pin that nothing becomes unreachable.
  **Per surface**: the pane right-click and the sessions-sidebar project-header "+" share the
  grouped tree (`buildGroupedAddMenu`); the **group-frame** menu shares the agent half
  (`agentEntriesToMenuItems`) and keeps its own three content rows; the **Dock stays FLAT** (its
  popup is opened deliberately, it already omits terminal + remote, and its agent flyouts are
  bespoke JSX — grouping it means a second submenu implementation for crowding nobody reported);
  the **kanban column "+ New session" is NOT a consumer of the spec and never was** — its
  `KanbanCreateChoice` is a closed union of the kinds that become a CARD, so feeding it this list
  would offer kinds the board can never show. `addMenuSpec.surfaces.test.ts` pins all four.
  None of the add rows are in `ui-visibility`'s hide inventory (it covers the NODE menu and the
  terminal header), so grouping does not interact with hiding today; a future hideable add row
  would need the group's own row to disappear when it empties, which `buildGroupedAddMenu` already
  does — it emits no submenu for an empty bucket.
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
  **ONE exception, and it is not a walk-back of that rule (issue #743): a MAXIMIZED node**
  (`isMaximized` — `data.premaxRect`, the flag `maximizeNodeToRect` writes and
  `restoreMaximizedNode` clears) is framed against the same rectangle `maximizeTargetRect` placed
  it in, through `viewportForNodeFocus`, which passes `measureMaximizeInsets(box)` to
  `viewportForRect` only for maximized nodes. `nodeFocus.policy.test.ts` exercises this shared
  Canvas decision for ordinary, maximized and restored nodes in both zoom modes.
  Maximize also measures `.controls-cluster` and `.dock` (#711): their screen rectangles reserve
  top/bottom space with an 8px gap, consuming the existing 24px margin first. Chrome outside the
  horizontally usable area contributes nothing. Menus and hover peeks never reserve a band. Both
  focus zoom branches use these same vertical insets; refitting observes the persistent chrome
  as well as pinned panels and compares all four insets. Zone snap retains its side-only policy. The trade-off above rests on
  ONE number — how much of the node ends up behind the panel — and for a maximized node that
  number is set by the PANEL rather than the node, **by construction**: maximize sized it to be
  *exactly* the free area, so centring it in the wider pane buries half the inset less the margin.
  Measured by the reporter on a signed v0.3.5 build with the sidebar pinned: an ordinary node lost
  33px, the maximized one 137px, and the camera drifted by `322 / 2 = 161` px on every "go to
  another node and back". Because the node is that rectangle minus two margins, centring it in the
  free area reproduces maximize's own origin (`marginPx + insets.left`) exactly — which is what
  makes this a fix rather than a second opinion about placement. It applies to BOTH zoom branches
  (the rectangle question is the same one; splitting it would be two rectangles again, which is
  the bug). With no pinned panels or overlapping persistent controls, `insets` is zero.
  A pane narrower than the panels over it falls back to the whole pane rather than solving against
  a negative width. `measureMaximizeInsets` reads the DOM only when framing a maximized node.
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
- **Canvas layouts** (`@shared/canvas-layout`, `renderer/lib/canvasLayout.ts` capture/apply +
  `renderer/lib/canvasLayoutView.ts` for the menu wording and the fallback camera; Dock button
  after "Fit view", mirrored in ⌘K) - a NAMED SNAPSHOT OF NODE GEOMETRY (position, size,
  collapse state) per project, so an arrangement built for the ultrawide can be restored after a
  day on the laptop screen. Load-bearing rules:
  - **Geometry only, and that is the whole safety story.** A restore never creates, deletes,
    renames, recolors, reparents or respawns a node, and never touches a tmux session - so the
    worst a bad layout can do is move things, which ⌘Z takes back (the debounced history effect
    picks up the `setNodes` like any other placement, which is why restore has no confirm and
    delete does).
  - **The two DESTRUCTIVE row actions confirm; restore does not, and the split is the undo stack.**
    ⌘Z replays node arrays, and a layout lives beside them rather than in them, so delete and
    "update to the arrangement on screen" are both unrecoverable the moment they run while a restore
    is one undo away. Update exists because the three-step alternative already worked (save, retype
    the name you are looking at, confirm the replace) and re-typing a name is friction, not a
    decision; it reuses `saveLayout`'s replace-by-id path, so `createdAt` survives, `updatedAt`
    moves, and the window size and camera are re-captured because you are updating FROM this screen.
    Both dialogs are built from `layoutIsShared` + `deleteLayoutMessage`/`updateLayoutMessage`
    (`canvasLayoutView.ts`), ONE definition of who else a destructive edit reaches: a folder project
    and an SSH project both keep their `project.json` where other people read it, and only a
    cwd-less canvas does not. Gating that on `cwd` alone (the first version) told an SSH project's
    user their edit was private when it was not. The layout is re-resolved AT CONFIRM TIME, never
    captured with the dialog: it is open for as long as the user looks at it, and a pull or a peer
    mutation can retire it underneath.
  - **The content half is git-shared, the camera half is machine-local.** `Project.layouts` rides
    `.nodeterm/project.json` beside `nodes` and `kanban`, because node geometry is already shared
    content in that file and a restore writes exactly those fields. `Project.layoutViewports` (this
    machine's camera per layout) rides `IndexEntryV3` in `workspace.json`. **The camera precedent
    (`viewport`, `breadcrumbs`) deliberately does NOT reach the geometry**: those are facts about
    where one person was looking, and nobody else's canvas moves when I pan - but where the nodes
    SIT is the canvas itself, and sharing an arrangement with the repo is the point.
  - **Restore rules** (`applyLayout`, pure + tested): a live node the layout does not mention is
    left exactly where it is, never tidied or stacked at the origin; an entry whose node is gone is
    skipped and counted, never resurrected; a frame the layout addresses gets the rect the user
    saved and is NOT re-fitted afterwards (the fit would overwrite it and the arrangement would
    drift a little on every restore), while a frame the layout does not mention but whose
    descendant just moved IS re-fitted, deepest first, so an out-of-layout child cannot be clamped
    by `extent:'parent'` into an inverted range. The whole layout lands in ONE transform as an
    explicit two-pass (resolve every target root origin, then emit) - a reduce over N placements
    re-fits an ancestor between two of them, so the second node is measured against a frame the
    first just moved and the result is differently wrong depending on array order. `collapsed` is
    restored with the CHROME height on the node and the real one in `expandedHeight` (the
    `flowToNodeStates` rule: the stored height is ALWAYS the expanded one, or a
    save-while-collapsed shrinks the node permanently). `premaxRect` and every non-geometry field
    ride the spread untouched - a restore is a placement, not a maximize.
  - **The camera is applied with `setViewport`, NEVER `fitView`** - the "Go to node" invariant
    above, and a canvas that has just been rearranged is exactly the unmeasured state where a
    queued fit collapses the bounds and flies to the origin. This machine's recorded camera wins;
    a layout restored here for the first time (a teammate's, or one saved on another machine) gets
    `layoutFramingViewport`, which is the core `framingViewport` rule rewritten locally because the
    renderer has no import path into `src/core` and because a layout's rects are ROOT-space, so
    unlike `CanvasNodeState` positions every entry anchors the camera.
  - **The window size is a LABEL, never a matcher.** `CanvasLayout.window` is the author's window
    at save time, shown in the menu so the user can tell the two arrangements apart. Nothing
    auto-applies a layout on a display change: the file travels, so matching on it would pick a
    stranger's monitor for this user's screen - and a canvas that rearranges itself when you plug
    in a projector is worse than one that does not.
  - **Cap 20** (`CANVAS_LAYOUTS_CAP`; a full node-geometry list in a file that is committed and
    cloned), name capped at 60, and **both sanitized on BOTH serializer seams** (`fileToProject`
    on the way in, `projectToFile` on the way out) - the same two-seam rule `normalizeNodeIcon`
    and `sanitizeNodeTriggers` follow, because live node data is reachable by a peer canvas
    mutation and whatever we write is what the next machine trusts. `sanitizeLayouts` DROPS a
    layout whole rather than repairing it: a repaired layout no longer describes the arrangement it
    is named after, and a non-finite coordinate is a white-screen crash (`adoptUserNodes`
    dereferences the position unguarded) that `JSON.stringify` then writes back as `null`.
  - **Downgrade note:** a build older than this one drops `layouts` on its first save, because
    `projectToFile` builds an explicit object and simply does not know the field. The layouts are
    gone from that checkout's file until someone on a current build saves again; nothing else
    breaks, and the machine-local cameras are pruned to match on the next load.
  - **Surfaces:** Desktop full; **Server Edition full with NO new IPC** (pure renderer plus
    `workspace.save`, which both shells already boot); **relay tabs REFUSED with the reason** -
    the Dock button is disabled with "Layouts are managed on the host" and the ⌘K entries are
    omitted (the palette has no disabled row), because a relay tab is a live connection to another
    machine and never a workspace on this disk; kanban N/A (a board shows cards, and geometry is
    what a column layout discards); mobile N/A - *nodeterm mobile* attaches to tmux sessions over
    the transport protocol and has no canvas, so surfacing a layout means extending that protocol
    (follow-up in the iOS repo).
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
  Settings. The panel operates on a **selected scope**, not on the project cwd — see **Worktrees** in `.claude/rules/kanban-worktrees.md`.
  **Open latency + reopen**: `status()` must never await `gh auth status` — it hits the GitHub
  API (~700ms) and used to hold the panel's first paint hostage; `ghAuthedSwr()` returns the
  cached answer and refreshes in the background (the accurate `ghAuthed()` is still awaited on
  the publish flow). Status/history live in the per-cwd `state/scmCache.ts` store (same pattern
  as `scmDraft`), so the close→reopen cycle paints the last-known data instantly while the
  mount refresh replaces it silently — do not move them back into component `useState`.
  **Branch observations** (`state/gitBranches.ts`) are shared by Source refreshes, Sessions project
  headers and existing worktree status polls. They are scoped by GitApi identity + exact cwd + SSH
  project id, never persisted, and latest-started reads win over late responses. Sessions resolves
  each project's owning session (including background projects); its header reads the project cwd,
  while a group header reads only its worktree path. No new timer: sidebar mount/reopen/cwd changes
  read local checkouts once, Source operations refresh as before, and worktrees keep their existing
  gated cadence.
  SSH headers only observe Source refreshes: background SSH connections are not git-routable.
  Local header probes also skip a cwd claimed by the active SSH route.
  The branch projection does not replace worktree staleness/ownership decisions or SCM history.

- **Settings** (`SettingsPage.tsx`, ⚙ / ⌘,): font/cursor (live to xterm + Monaco), default
  shell, grid + snap, **default node size** (`defaultNodeWidth`/`defaultNodeHeight` — new
  terminal/agent nodes only, clamped in `terminalNodeSize()` in `state/workspace.ts`),
  pan-hover delay, double-click focus, accent, tmux on/scrollback, commit agent,
  `seenShortcuts`.
- **Shortcuts** (`ShortcutsPanel.tsx`, ? / ⌘/): shown once on first launch (`seenShortcuts`).
  **Derived from the registry, never hand-listed** — see the ShortcutsPanel invariant in `.claude/rules/keybindings.md`.
- **Welcome** (`WelcomeScreen.tsx`): shown when no projects exist.
- **Nothing raises the window without a user action** (issue #737, the THIRD in this family —
  #665 and #702 were canvas-control moving the user's VIEW; this one is the OS window activating
  over another app). The cause was `win.on('ready-to-show', () => win.show())`: `ready-to-show`
  fires on the first paint of EVERY main-frame navigation, not once per window (MEASURED on
  Electron 42.9.1 — a `webContents.reload()` on a VISIBLE window emits it again with `isVisible()`
  already true), and the crash auto-reload (`render-process-gone` → `webContents.reload()`) is an
  unattended navigation. So a backgrounded renderer being killed — macOS jetsam on a machine
  running several agent CLIs at 335 MB–1.2 GB each — silently raised nodeterm over whatever the
  user had ⌘Tabbed to. It is `win.once` now. **The gate must be FIRST PAINT, not `isVisible()`**:
  after macOS hide-on-close the window is hidden but alive, and an `isVisible()` gate would `show()`
  it on a background reload — the same bug inverted.
  The permitted raises are all a CLICK, and they are enumerated with their triggering action in
  **`src/main/window-raise.guard.test.ts`**, an allowlist-with-reasons in the shape of
  `fs-atomic.guard.test.ts`: a notification tap (the one exception the rule names), a Notch HUD
  row, a Dock activate, a second launch, and a file dropped onto a terminal. Nothing an AGENT can
  do reaches any of them — canvas control, trigger nodes, hook POSTs, relay/pairing/push and
  browser-drive contain no show/focus/dialog call, and agent confirms are in-renderer
  `ConfirmDialog`s, never native. The drop IPC's `app.focus({steal:true})` is the only
  renderer-reachable cross-app activation and now carries the same sender guard its two neighbours
  (`uiShortcutRecording`, `uiTerminalFocus`) already had — a `<webview>` guest is a webContents in
  this process. **KNOWN GAP, listed in the guard rather than fixed**: `standing-host.ts`'s
  `dialog.showErrorBox` for a locked keyring is app-modal, unparented, and raised from the relay
  RECONNECT TIMER; the honest fix routes it to a non-modal in-app surface and owes a macOS check
  that a sheet on a background window does not activate.
- **Window geometry is REMEMBERED** (`main/window-state.ts`, `<userData>/window-state.json`) — size,
  position and maximized state, restored at the next launch. Before this the window opened at a
  hard-coded 1400x900 every time, on every platform, so a user who works maximized re-maximized it
  on every launch; Electron persists nothing on its own and no platform does it for us. The module
  is Electron-free in the `keydown-intercept.ts` shape (pure decisions over plain rectangles,
  structural window interfaces), so the refusals below can be pressed by a test instead of only by
  someone with two monitors — `screen.getAllDisplays()` is called at the seam in `index.ts` and its
  **work areas** (not full display bounds) are passed in. The refusals ARE the feature, because each
  is a way the naive version is worse than the fixed size it replaces:
  - **While MAXIMIZED the size comes from `getNormalBounds()`, never `getBounds()`.** The latter
    returns the MAXIMIZED rectangle, so saving it makes the next un-maximize hand back a
    screen-sized window — state that looks right and behaves wrong, and only for the users who
    maximize. **Un-maximized it is `getBounds()`**, which is the same rectangle wherever both work:
    Electron documents `getNormalBounds()` as supported only on some Linux desktop environments, and
    the common case must not depend on the window manager. The maximized case still does and cannot
    be helped from here, but it matters less, because that record restores by re-maximizing rather
    than by its size.
  - **A position that is no longer reachable is DROPPED, not clamped.** A laptop undocked from the
    monitor its window was on would otherwise reopen the app off-screen: running, focusable from the
    dock, visible nowhere, with no gesture that rescues it. Reachable means a real overlap with some
    work area (`MIN_VISIBLE_WIDTH`/`HEIGHT`), judged against the CLAMPED size — a few pixels on
    screen is not a title bar anyone can grab. **Overlap alone is not enough, because it is
    symmetric**: a monitor mounted ABOVE the laptop and then unplugged leaves a record whose BOTTOM
    edge clips the laptop's work area by enough to clear the height floor while the title bar sits
    hundreds of px above the screen — and under `titleBarStyle: 'hiddenInset'` the title bar is the
    whole drag region. So the window's TOP edge must also land on that work area, within
    `TOP_OVERHANG_SLACK` (24px, because window managers report decorations inconsistently and a few
    pixels of overhang must not cost the user their position every launch). The rule is per-display,
    like the overlap it joins. Dropping keeps the user's size and lets the platform place a window it
    knows how to place; inventing a corner for it is the guess.
  - **No capture while minimized or fullscreen.** `isMaximized()` is FALSE while a macOS window is
    fullscreen, so capturing there records `maximized: false` and erases exactly the preference this
    exists to remember. The last non-fullscreen state stands, which also means the app never reopens
    INTO fullscreen — deliberate: a fullscreen window is usually a temporary mode and is much harder
    to escape on first launch than a maximized one.
  - **Maximize before the first paint**, while the window is still `show: false`; maximizing after
    `show()` is a visible jump from the restored size on every launch.
  - Every field is **re-validated as a number on read** — the file is hand-editable and its values
    reach the `BrowserWindow` constructor before there is a window in which to report a failure.
  - Saves are debounced (`resize`/`move` fire continuously through a drag) and flushed
    **synchronously** on `close`: that is the only moment guaranteed to see the final state, and an
    awaited write there races the process exit. Published through `renameAtomicSync` with a
    per-call unique temp, like every other store.
  - **NT_MULTI is excluded**: a throwaway dev sandbox may share the real app's userData, and it must
    not move the window of the app being developed.
  - Desktop only, and genuinely so — a browser tab's geometry is the browser's, and the mobile
    companion has no window. Nothing here belongs in `src/core`. **Wayland caveat**: a native-Wayland
    client cannot set its own position (the compositor owns placement), so x/y is honoured under
    XWayland and quietly ignored otherwise. Size and maximized restore either way, which is what the
    drop-don't-clamp rule already degrades to.
- **Window chrome**: macOS integrated title bar (`titleBarStyle: 'hiddenInset'`); the tab
  strip's stationary viewport is the only `no-drag` region for its contents. Explicit regions on
  scrolled descendants escape the overflow clip in Electron's native hit test and subtract from
  the wordmark after scrolling (#847). Keep tab/button/input descendants at the initial `none`;
  the viewport already excludes dragging over them. `scripts/tabbar-drag.test.ts` uses real
  Electron and native XTest input on a disposable Xvfb display (CDP input bypasses this hit test).
  It checks 41 tabs at start/partial/middle/end/back, 28/40/64px heights and both padding modes;
  it does not verify macOS traffic lights, Windows, or movement under a real window manager. The
  bar (`TabBar.tsx`) is the drag region with the `nodeterm` logo + a **Chrome-style tab strip**
  (2026-09-16): inactive tabs are flat and separated by a 1px divider that drops on both sides of a
  hovered or active tab, hover is an inset pill, and the active tab is `--canvas-bg` with rounded
  top corners and two concave flares (`.tab.active::after`, radial gradients) so it merges into the
  surface below — which is also the kanban overlay's colour, so it merges under both views. In
  LIGHT the strip steps back to `--surface-deep` (`--tabbar-bg`), because `--panel` and
  `--canvas-bg` are one value apart there and a canvas-coloured tab would vanish.
  **A tab is as wide as its own NAME and never shrinks** (`max-width: var(--tab-max)` 260px,
  `flex: 0 0 auto`; the name is `flex: 0 1 auto; min-width: 0` with `text-overflow: ellipsis`): the
  strip SCROLLS when the tabs stop fitting, and nothing shortens a name except that cap. This is
  the deliberate departure from Chrome, which shrinks because it must keep every tab reachable
  without scrolling — here the sessions sidebar and ⌘1..9 both reach a project without touching
  the strip, so a readable name is worth more than a visible tab edge.
  **Two earlier rounds tried to ration the name between tabs and both spent the one thing the strip
  is for**, which is why the third does not: #789 gave every tab one flex basis (at 8 tabs / 1340px
  the ACTIVE name measured 24px — zero characters — because it carried the most furniture and hit
  its floor first), and #790 added a 60px floor plus a `tabDensity` level that shed furniture to
  pay for it — whose middle level hid the SSH chip, and 8 tabs in a 1340px window land on exactly
  that level, so every remote tab lost its `SSH` label at the width people work at.
  **`renderer/lib/tabDensity.ts` is deleted**: with full names there is no name budget to protect,
  so there is nothing for a density level to buy. Do not reintroduce one without first saying what
  it is buying. Measured on the third shape (headless Chrome, the real CSS, 86px traffic-light
  reservation): 8 tabs in 1340px — every name whole, every SSH chip present, the strip 14px past
  its width; 12 tabs — every name still whole, the strip scrolling 559px; a 60-character project
  name stops at the 260px cap and is the only thing that ellipsises.
  The fade mask went with the shrinking: a mask gradient is unconditional and would fade the tail
  of a name that fits perfectly, while `text-overflow` is self-conditioning. **The bar's height is ONE number in two places that cannot read each
  other**: `--tabbar-h` in styles.css (every top-anchored panel, the kanban overlay and the usage
  popover position against it) and `TABBAR_HEIGHT_PX` in `@shared/window-chrome-metrics`, from
  which main derives the traffic-light `y` (`trafficLightY`) — a literal 15 for a 44px bar was
  what made shrinking the bar hazardous. It is **40px** (36 for one release, which read as cramped
  once the tabs carried whole names) **by default — the height is a SETTING**
  (`settings.tabBarHeight`, Settings → Appearance, 28–64): `App.tsx` writes the resolved value to
  `--tabbar-h` on `<html>`, and main re-centres the macOS traffic lights on the same settings
  change (`win.setWindowButtonPosition(trafficLightPositionFor(h))`, change-gated), so the two
  cannot disagree. Every reader goes through `resolveTabBarHeight`, which answers the default for
  a non-number and clamps — the floor is what keeps the 12px lights inside the bar. The stylesheet
  token keeps the default LITERAL so an un-hydrated renderer draws the default bar, not none.
  `styles.tabbar.test.ts` pins the token to the constant and
  every dependant to the token. The New-project `+` is a **sibling** of `.tabbar__tabs`, not its last child — inside
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

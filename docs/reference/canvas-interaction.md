# Canvas interaction & panels (`Canvas.tsx` is the hub) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Canvas interaction & panels (`Canvas.tsx` is the hub)

- **Context menus** (`components/ContextMenu.tsx`, portal, icons from `components/icons.tsx`):
  pane right-click = add nodes at cursor (terminal / Claude / sticky / open file) + select
  all + fit + **Tidy canvas** (`arrangeAllNodes` → `tidyCanvas` — packs every top-level node,
  including group frames as rigid units, without overlap, keeping each ORCHESTRATOR legible; see
  the Tidy canvas bullet below; mirrored in ⌘K as "Tidy canvas" and in the
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
- **Tidy canvas keeps the orchestrator** (`tidyCanvas` in `state/workspace.ts`, 2026-10 — user
  feedback: *"I lose the sense who is orchestrator"*). The old Tidy packed every top-level unit
  into one reading-order grid, so an orchestrator landed wherever its (y, x) fell — routinely LAST,
  after the stations it opened and the loose notes between them. Now a unit that opened other units
  is placed first, at the top-left of its own cluster, with the units it opened packed in a ~square
  grid directly to its RIGHT, and a sub-orchestrator's own team clustered the same way inside that
  grid (recursive blocks, `flowBlocks` = `arrangeNodes`' row flow over rectangles). Clusters are
  packed in reading order of their orchestrators; every unit with NO lineage is packed after them,
  below, by the plain grid. Rules a refactor must keep:
  **(1) The relation is the OPENER only, and it is `openerByTarget`** (`lib/teamProgress.ts`) —
  the ONE definition team progress reads too (`data.openedBy` when recorded, else the first
  non-wait rope into the node; `stationsByOpener` now sits on it), so the ring and the layout
  cannot disagree about whose station a node is. Waits are NOT followed: a verify panel's
  reviewers wait on the reviewed node, but the orchestrator opened all of them — following waits
  would split its team under one of its own stations. And one opener per node makes the clusters
  a forest, so the layout has one answer.
  **(2) Ropes are lifted to the top-level unit** (the #1114 shape: a coordinator opens a lead
  INSIDE a frame, so the frame joins the coordinator's team). A frame whose contents were opened
  by different units belongs to the one that opened the MOST of them, ties to the earliest rope; a
  plain node's own opener always wins for it. A rope internal to one frame is dropped.
  **(3) A cycle never hangs** — lifting makes one easily (a in frame g opens b outside, b opens a2
  inside g); the cycle member that reads first loses its opener and leads.
  **(4) No lineage ⇒ exactly the old call**: `arrangeNodes(grid)` over the reading-order ids —
  pinned against that call verbatim, waits-only canvases included. (Not byte-identical to the
  pre-#836 *build*: `arrangeNodes` then placed in array order, ignoring the sort this action always
  documented — see Arrange by lineage below.)
  **(5) Same array when nothing moves**, so a second Tidy writes no undo entry and no
  `project.json` (it still fits the view). The layout is idempotent by construction: every block
  places its members in reading order, so a tidied canvas reads back in the order it was laid out.
  A dead opener (deleted; the rope pruned, or a stored file's unpruned rope) leads nothing — its
  stations fall loose. Desktop + Server Edition identical (pure renderer, no new IPC); kanban N/A
  (a board has no geometry); Mobile N/A (no canvas). Agents reach it as `arrange --group top`.
- **Arrange by lineage** (`arrangeByLineage` / `lineageLayers` in `state/workspace.ts`; pane menu
  beside Tidy canvas, ⌘K, and the registry command `canvas.tidyLineage`, which ships UNBOUND —
  ⌘⇧A is already the first tidy) — the second tidy: one row per LAYER of the lineage ropes
  (`project.ropes`, i.e. "opened by" and `--after`), growing downward, so a coordinator sits above
  the team it opened and that team above what IT opened. Four rules, each of which the naive
  version gets wrong: **(1)** a rope is LIFTED to its top-level ancestor before it counts — an
  agent opens a team INSIDE a frame, and the frame is the rigid unit that moves; a rope whose two
  ends lift to the SAME object is internal to that frame and dropped, or the frame would be its own
  opener. **(2)** a node's layer is its LONGEST path from a root, never its first — with `max`
  every rope points strictly downward, which is the whole reason the result reads as a flow; a
  reducer that keeps the LAST opener happens to be right in one edge order and wrong in the other,
  so the test asserts BOTH. **(3)** nodes no rope touches are NOT layer 0 — they are a final
  `loose` band, because a node with no lineage is not a root of anything and mixing the two puts
  every sticky note beside the coordinator. **(4)** a cycle never hangs and never throws (the edge
  that closes it contributes `0`): a rope cycle is not supposed to exist, but `--after` can be
  hand-built into one and `project.json` is editable. The refusal is the transform returning the
  SAME array — no usable rope, or under two top-level nodes — which is also what keeps a no-op out
  of the undo stack and out of `project.json`; **that verdict is taken from `nodesRef` BEFORE the
  write, never from a flag set inside the `setNodes` updater**, which runs when the state is
  processed and is therefore still false on the next line (it would cost every run its `markDirty`
  + `fitAll`). The pane row is then DISABLED with its reason while the palette OMITS it (no
  disabled state there). Built ON `arrangeNodes` — one `row` placement per band from a shared left
  origin — so packing, gap and the mixed-container refusal stay in ONE place. **That only holds
  because `arrangeNodes` fills its slots in the order of the ids it is handed**: it used to place
  in ARRAY order, which threw away the slot order `lineageLayers` computes (siblings under their
  opener) AND the reading-order sort `arrangeAllNodes` documents, with every existing test green
  because each asserted the layer LIST and never the positions. The interleaved case is now
  asserted on positions. **Bands read BOTH relations, slots read the opener first** (2026-10):
  layering follows openers AND waits (a wait is a flow edge too, and longest-path keeps it pointing
  down — a verify panel reads target → reviewers → judge), but a node's slot in its band follows
  its OPENER's slot when the opener is in the band above, else its earliest predecessor's, so a
  node opened by B that waits on A sits under B with the rest of B's team. Kept as its own command
  rather than folded into Tidy: bands answer "in what order does the work flow", Tidy answers
  "whose team is this", and on a pipeline the two disagree. Desktop + Server Edition identical
  (pure renderer, no new IPC); kanban N/A (a board shows cards, and geometry is exactly what a
  column layout discards); Mobile N/A (no canvas).
- **Arrange inside a group** (`arrangeGroupChildren` / `groupArrangeRefusal` in
  `state/workspace.ts`; the group-frame menu's **Tidy group** and **Arrange group by lineage**,
  ⌘K for the ONE selected frame, and the `arrange --group` control verb — one transform behind all
  three, pinned by `canvas/arrange-group.source.test.ts`) — the two canvas tidies one level down:
  organize a frame's own items, then size the frame to hold them. Four rules: **(1)** the members
  are the frame's DIRECT children, so a nested frame moves as one rigid unit with its own children
  untouched, exactly as Tidy canvas treats a top-level frame; `lineageLayers` /
  `arrangeByLineage` take a `containerId` for this, a rope is lifted to the MEMBER that holds its
  end, and a rope with an end outside the frame is dropped — the opener of a frame's whole team
  usually sits outside it and says nothing about the order inside. **(2)** the layout starts at
  the offset a fitted frame keeps its content at (`GROUP_PAD`, plus `GROUP_HEADER`), NOT at the
  children's bounding box: `fitGroupToChildren` re-anchors a frame to hug its children, so
  starting from the bounding box moves the frame to wherever its top-left child happened to sit,
  while starting from the content origin makes the fit re-derive the SAME origin and the frame
  only grows or shrinks to the right and downward (a frame that was off the grid still moves onto
  it, by under one cell, when snapping is on). That is also why the action calls no `fitAll` — the
  thing the user right-clicked must not slide out from under the cursor. **(3)** the fit walks UP
  the parent chain, innermost first (`fitAncestorChain`): fitting only the frame leaves a parent
  smaller than the child it holds, and `extent:'parent'` then clamps that child into an inverted
  range. **(4)** the refusal is the SAME array — a missing or empty frame, a lineage layout with no
  rope joining two of the children, or a frame whose contents already sit where the layout puts
  them (compared by geometry, so a second click writes no undo entry and no `project.json`); as
  with the canvas tidies the verdict is read off `nodesRef` BEFORE the write. The menu rows are
  DISABLED with the reason `groupArrangeRefusal` gives, the palette OMITS a refused entry, and the
  CLI replies that reason by name — one sentence, three surfaces. Desktop + Server Edition
  identical for the menu and palette (pure renderer, no new IPC); the control verb is desktop-only
  (see Grouping verbs); kanban N/A; Mobile N/A (no canvas).
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
- **Per-terminal font size** (`renderer/terminal/terminal-font-zoom.ts`, issue #915). Opt-in
  `settings.terminalFontZoomKeys` (Settings → Terminal, default OFF). On, with a terminal focused:
  ⌘+ / ⌘− (Ctrl off-mac — exactly one primary, since Ctrl+− on mac is readline undo) step THAT
  node's `data.terminalFontSize` by 1 within the global field's 8–28 range; ⌘0 clears it back to the
  global `fontSize`. + and − match on `e.key` (German `+` key), 0 on `e.code` like the canvas chord.
  Before #915 ⌘+ / ⌘− did NOTHING (no menu zoom roles, React Flow's key zoom is off; only
  webview guests zoom on them) and ⌘0 in a terminal was claimed by main and then refused. Off, or
  with no terminal focused, every key behaves as before. The override is persisted per node
  (`normalizeTerminalFontSize` on both sides of `nodeStatesToFlow`/`flowToNodeStates`) and layered
  by `useXtermVisualSettings(projectId, fontSizeOverride)` — the SAME path for the canvas node and
  the card modal (`ModalSpawn.terminalFontSize`); the settings preview passes none. Font size is
  cell geometry, so `applyLiveOptions` reports `metricsChanged` and both surfaces re-fit and report
  the new grid exactly as for a global font change. **One writer:** both xterm key handlers and the
  forwarded desktop ⌘0 (resolved from focus via `data-font-zoom-node` on the xterm host) dispatch
  `nodeterm:terminal-font-zoom`; Canvas applies it (`nextTerminalFontSizeOverride`, `markDirty`).
  The toolbar / dock +/− buttons stay CANVAS zoom (they have no focused terminal to act on).
  Two review fixes: main forwards ⌘0 WITH `{meta, control}` and the renderer resets only on the
  platform chord (`forwardedResetMatches` — a mac Ctrl+0 keeps its old meaning); and under
  `terminalGpuRendering: 'shared'` a node whose size differs from the global one is held OFF the
  shared glyph canvas (`leavesSharedGlyphAtlas` → `glyphOff`) and paints its own pixels, because the
  shared atlas is rasterized for the global font and a grid's cell is fixed at `register`.
  Round 2: every xterm is BUILT from the effective visual (`visualRef`, both surfaces) — a refresh
  or offscreen revive recreates it in the same mount, where the live-options effect does not re-run;
  and keypad 0 resets only when it types `0` (Num Lock off it is Insert, and Ctrl+Insert copies).
  Round 3: Canvas also mirrors the step into the projects store for the ACTIVE project
  (`patchStoredFontSize`, same epoch guard as `commitActiveToStore`), because the Omni board builds
  its card modal's spawn from the store and would otherwise lag until the next autosave commit.
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
  **A second, narrower exception: a PINNED side panel (issue #854).** An ordinary node is still
  centred in the pane, but if that lands part of it under a pinned sessions sidebar or explorer
  (`measurePinnedInsets` — pinned only, never the hover overlay), `clearOfPinnedPanels` moves it
  the least distance that uncovers it (plus a 12px gap when there is room). A node too wide for
  the free area stays centred at a caller's zoom (a shift only swaps which edge is covered) and is
  fitted into the free area when the zoom is ours. This is not the rejected nudge of 5e8abfe7:
  that cleared the sidebar as an OVERLAY, which is open whenever the click comes from it, so every
  jump moved; pinning is the user's statement that the panel stays. The reporter measured 36–47px
  of a large node under a pinned 321px sidebar on every jump.
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
- **Directional focus (⌘←/→/↑/↓, `node.focus*`)** — the multiplexer gesture (Ghostty `goto_split`,
  tmux `select-pane -L`) on a canvas with no split tree: `lib/directionalFocus.ts` ranks candidates
  by geometry (same-row/column overlap first, then diagonal with a sideways penalty; no wrap). The
  ONE decision — where to land AND how — is the pure `planDirectionalMove`, and the "how" has two
  answers that must not be merged: on the canvas the move **travels** (`focusNodeById`: frame +
  keyboard + read-ack), origin = the node the keyboard is in, else the selection, else the first
  press ADOPTS the node nearest the view center. In **focus mode** (⌘⇧F, issue #78) the move
  **swaps the focused node** (`useFocusNode.focus(next)`) — the flow pane is `display:none` there,
  so a travel would frame a node on a 0-sized pane (the origin-jump bug) while the user kept
  staring at the old terminal; before this, moving between two focused terminals was ⌘⇧F, ⌘→, ⌘⇧F.
  Three details carry it: the origin is the FOCUSED id (the reparent detaches the node root from
  its `.react-flow__node` wrapper, so the keyboard origin reads null there); candidates are
  TERMINALS only (the one kind focus mode can show — `focusTargetId`); and the keyboard is handed
  over explicitly (`useTerminalFocus.request`), because the reparent gives focus back to whichever
  xterm had it, i.e. the OLD node. Selection follows the swap so leaving focus mode lands on the
  node the user was in. An edge with nowhere to go is a CLAIMED no-op in both modes — declining
  would hand ⌘→ to the terminal, which is not "nothing".
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
  - **One create-and-bind** (`renderer/lib/worktreeCreate.ts`, `createBoundWorktree`) — the New
    worktree dialog, the `open-worktree` verb and the issue card's "Start with agent in a new
    worktree" all create through it: `git worktree add` (a REJECTED call becomes a failure, never a
    throw out of the caller), then `attachWorktree`. The frame's place is asked only once git
    succeeded. `projectId` opts in to the "the canvas moved on during the await" refusal: the dialog
    and the issue action pass it; `open-worktree` does not, and still binds to whatever is on screen
    when git returns (unchanged, and a known gap). `git worktree add` is reached from ONE place
    (`worktreeCreateDeps`), pinned by `canvas/issue-worktree.source.test.ts`. Three same-tick rules
    the issue action rests on: `attachWorktree` writes the new frame into `nodesRef` beside its
    `setNodes`, so a caller can open a node INTO a frame it just made; it closes the frame's setup
    gate from the bind (`markGroupPending` before the `sharedPaths` materialize, released in a
    `finally` once `startWorktreeSetup` took its own count), so a node opened into it at once holds
    its launch — the hold is ONE rule, `setupHoldGroup`, shared with the control opens' `armAfter`;
    and `addAgentNode` parents the node BEFORE `setNodes`, never inside the updater, because the
    updater runs at render time and a zustand-flushed SyncLane render may already have mirrored
    `nodesRef` back to a list without the fresh frame (the `nodesEpoch` lesson).
  - **Where a worktree may land** (`@shared/worktree-location`) — `worktree.basePath` can come from
    `.nodeterm/settings.json`, the git-SHARED project settings file, i.e. written by anyone who can
    commit to the repository, and `git worktree add` writes the whole tree there. Pointed at
    `../../.claude/skills`, the issue card's one click checked the repo out into
    `~/.claude/skills/issue-N-…/` and a root `SKILL.md` became a skill in every Claude session. Two
    layers, both for ALL create paths (dialog, `open-worktree`, issue card):
    `sharedWorktreeLocationRefusal` (renderer) refuses a location the SHARED file produced unless it
    stays inside the folder holding the repository — a sibling that is not hidden, or anywhere in
    the repository but its `.git` — and names the fix (a local override in Project Settings). It
    judges only the path that setting derives for the branch: a path the person typed in the dialog
    or passed as `--path` is theirs. `sharedBasePathOf` is the one reading of provenance (`source:
    'shared'`). `open-worktree` refuses before its dry run. The core backstop
    (`core/worktree-target.ts`, in `GitService.worktreeAdd`, so relay and browser clients pass it
    too) works on REAL paths, because a symlink committed into the repository defeats any lexical
    rule: never inside the repository's `.git`, and never REDIRECTED into a hidden folder directly
    under the home directory — a location that names such a folder outright (a person's own
    `/home/me/.worktrees`) is allowed, so the backstop is not a blanket refusal.
  - **A worktree per GitHub issue** (`@shared/issue-worktree`) — "Start with agent in a new
    worktree ▸" on an issue card and its summary modal: branch `issue-<N>-<slug>` at the templated
    path, off the SAME base the New worktree dialog defaults to (`effectiveWorktreeBaseRef`: the
    project's base-ref override, else the MAIN CHECKOUT's current branch — not `origin/HEAD`; a main
    checkout parked on a feature branch forks from it, so the success notice names the base), a
    frame titled `Issue #N`, and the agent opened inside it with the same ref-only prompt and
    `issueRef` as "Start with agent" (one `issueStartPrompt`, one `fileIssueSession` for both). The
    frame's binding is what links a pull request from that branch to the session card. Whatever
    `addAgentNode` would refuse (canvas not the active project's, an unusable Codex account) is asked
    BEFORE git runs (`agentCreateRefusal`, same functions and wording) — a refusal after it would
    leave a fresh worktree with no agent. The agent's launch rides `pendingLaunch` held on the
    frame's setup gate, so it shows QUEUED for the moment the setup ack takes even when the project
    has no setup script. **The title is attacker-controlled**: the slug is
    an allowlist `[a-z0-9-]` (lower-cased, NFKD with marks stripped so `café` → `cafe`; every other
    script, lookalike, bidi or zero-width character is dropped), capped at `ISSUE_BRANCH_SLUG_MAX`
    (40) and cut back to a word boundary, and `issue-<N>` alone when nothing survives; the name only
    ever reaches git as one argv element, and the tests run the real `git check-ref-format --branch`
    over the hostile set. **Nothing on disk is overwritten**: `planIssueWorktree` (filesystem only
    through an injected probe; a probe that REJECTS reads as "taken" — the app's `fs.exists` folds a
    stat error into `false`, and git refusing a non-empty folder is the backstop there) offers REUSE
    of what the issue already has — a frame on this canvas bound to `issue-<N>` / `issue-<N>-…` (open
    the agent in it), an unbound worktree of the issue (adopt it, `createdByApp: false`), or the exact
    branch existing but checked out nowhere (check it out, under the branch's OWN spelling — the
    match is case-insensitive, git's lookup is not; the new folder is the app's, so `createdByApp`
    is true exactly as the dialog's "Existing branch" mode sets it) — beside the next free `-2` …
    `-20`; a name or folder that is merely taken moves to the next suffix and the notice says why.
    Never the main checkout, never a prunable registration, and never a frame bound to ANOTHER
    repository (`issueWorktreeFrames` filters by `worktree.repoPath`, as the worktree store does — a
    foreign or hostile frame on an `issue-<N>-…` branch would otherwise be the preselected "Reuse").
    A branch that exists only on a REMOTE (`status.remoteBranches`, as fresh as the last fetch) is
    TAKEN, never checked out: a same-named local branch would diverge from it, its push would be
    rejected, and #1008's branch link could point at someone else's pull request. Reuse is
    re-checked at the dialog's click (a frame of this repo on that folder now, else a worktree git
    still lists), and one `runExclusive` key per issue covers the planning AND a dialog-confirmed
    create, so a second click cannot race the first for the same `-2`. The reuse-or-new dialog is a
    tracked confirm (`confirmFlags.issueWorktree`, read by `confirmBusy()`): it never opens over
    another confirm, and an agent's destructive verb is refused while it is up. Disabled WITH its reason on a relay tab, an SSH project, a cwd-less
    project and a folder with no repository (`issueWorktreeRefusal`). **There is no `--worktree`
    flag**: an agent composes `open-worktree --branch issue-<N>-<slug>` then `open-agent --group
    <groupId> --issue #N`, and both agent bodies render that convention from `issueWorktreeBranch`.
    A flag was judged not worth it: the two calls already reach the identical end state; the
    "worktree already exists" question needs a person's answer, which an agent gets from `list`
    instead; the slug needs the issue title, which the control dispatch does not hold reliably (only
    a subscribed board does), so the flag would name one issue's branch two ways; and a second copy
    of `open-worktree`'s surface (`--base`, `--path`, dry run, setup holds, refusals) inside
    `open-agent` is the drift this file warns about. Surfaces: Desktop and Server Edition (the
    whole path is renderer + the existing git/fs/worktree bridges); a relay tab is refused (above);
    the Omni board has no issue lanes; Mobile N/A like every worktree affordance.
  - **One store, one poller** — `renderer/state/worktrees.ts` is the **only** caller of the worktree
    /status *read* IPCs (`git.repoRoot`, `git.worktreeList`, `git.status`); the group chip, the
    creation dialog and the Source Control panel all read that store. Three independent pollers would
    triple the `git` subprocess load and drift out of sync. It is **epoch-guarded** (a project switch
    bumps the epoch, so a stale in-flight refresh can never overwrite the newer project's
    `repoRoot`/orphans — worktrees are *created* under `repoRoot` and orphans are offered for
    *deletion*) and **fails open**. Exactly **two** direct `git.status` reads live outside it, both in
    `Canvas.tsx` and both deliberate: the one-shot probes on the **Remove** confirm (the dirty-file
    count in the warning) and on **↪ Move into worktree** (staleness only arrives by poll, so the
    directory is re-checked immediately before an irreversible session kill). Two more one-shot
    reads take only the local BRANCH list: the New worktree dialog's dropdown and the issue action's
    planner (so a taken name is seen before git refuses it). Anything recurring belongs in the store.
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
  - **Path identity** — compare worktree/repo paths through `worktreePathKey` (`shared/worktree.ts`),
    never by string: git prints `C:/r/wt` on Windows while a typed binding says `C:\r\wt` or `c:/…`.
    The key folds separators + case only for a Windows-SHAPED path (backslash, drive letter, UNC);
    a POSIX path keeps exact case — keyed on shape because this module runs in the renderer, whose
    platform is not the core's. The removal guard also refuses a bare drive root.
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
  the heartbeat ETag (below), the 60 s poll and the cache snapshot the issue lane already has. The alternative was
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
  **Sync foundation: what a poll costs, what a failure means, what a write needs** (2026-09-28,
  `core/github/*`; Desktop and Server Edition identical — all of it is core). Seven rules:
  **(1) A poll that finds nothing spends nothing.** Before each pass, `client.issuesHeartbeat` asks
  for the single most recently updated item (`state=all&sort=updated&direction=desc&per_page=1`)
  with `If-None-Match`; a 304 skips the scan. MEASURED against this repo (read-only `gh api`):
  twenty 304s moved `x-ratelimit-used` by **0**, the next 200 by 1; five plain 200s by 5. The `since`
  scan could never do this itself — `since` moves every pass, so its URL (and any ETag) never
  repeats, and the snapshot's `etags` map was declared and always written empty. The validator is
  the one read BEFORE the scan (a change landing mid-scan stays "new"), it is persisted in
  `snapshot.etags.heartbeat` (a restart does not pay a full read), and a 304 NEVER skips a full
  reconciliation (a deletion or transfer does not move the top item) or an incomplete repository.
  It covers pull requests by construction: same endpoint, same `updated_at` the scan filters on.
  **Only a completed scan advances the incremental cursor** (`lastSuccessfulRefreshAt`, the next
  scan's `since`): a board write folds its one confirmed issue into the snapshot and leaves the
  cursor alone. It used to set it to the write's time, so a third party's change landing between the
  last scan and our write fell outside the next `since` window until the daily full pass.
  **A 304 still prompts the board to re-read** (an empty delta, served from the local cache, no
  GitHub cost) exactly as every successful refresh always did: a page is not only issues — read
  only, the mapping approval and the completion column are derived by the host at query time, and
  the first version, which emitted nothing on a 304, left a board read only after its user
  approved the mapping (review of #1001). Approve and revoke also notify the project's open boards
  at once (`service.notifyProject`). **Unknown `state_reason` values decode as no reason**: GitHub
  added `duplicate` (one of cli/cli's last 100 closed issues, measured 2026-09-29), and the strict
  decoder failed that repository's whole scan as malformed — it never synced.
  **The credential check is conditional too** (`createTokenValidator`): every poll re-resolves the
  credential (30 s memo, 60 s poll), and each resolve was an unconditional `GET /user` — one real
  request per poll even after the heartbeat. With `If-None-Match` an unchanged identity is a free
  304 (MEASURED: ten conditional reads, +0), and a bogus token presenting a valid validator still
  gets 401. Idle polling now costs zero quota. **(2) The budget is read from every response and
  acted on before GitHub refuses.** `client.onRateLimit` reports `x-ratelimit-*` from 200, 304 and
  errors alike to `GitHubRequestCoordinator.noteRateSample`, keyed by the credential's identity
  (the host builds the client from token + userId); within one window the LOWEST reading wins. A
  spent `core` budget blocks new requests at once. Below `backgroundFloor(limit)` = max(100, 10%)
  the BACKGROUND poll stops until the window resets — the budget is the whole account's (`gh`, the
  browser, other tools) — while a refresh the user asks for still runs within its own floors.
  **Every wait is capped** (`MAX_RATE_WAIT_MS`, 10 s in TOTAL): past it the request is refused at
  once with its retry time, instead of holding one of four read slots and an IPC call for up to an
  hour. The page and the Settings status carry the `throttle`; both say "held until HH:MM"
  (`lib/githubSyncStatus.ts`), and subscribers are prompted once per deadline, not per skipped
  minute. Do NOT add a `/rate_limit` probe: measured for the same token in the same second it
  answered 5000 left / used 0 with a different reset time than the response headers (4968 / 32) —
  the headers are the truth. **(3) Throttled is not signed out.** `classifyGitHubFailure`
  (`core/github/failure.ts`) is the ONE classifier: only a 401 or a non-rate-limit 403 is
  `unauthorized`; network, timeout, 5xx and malformed bodies are `unreachable`; limits are
  `rate-limited`. Token validation is tri-state (`TokenValidation`); the resolver keeps the last
  credential GitHub vouched for — SAME token only — through an unknown answer, and with none throws
  a `GitHubReachabilityError` rather than returning the null that every caller reads as "sign in".
  Auto does not fall through to the saved token when the CLI's token merely could not be checked
  (that would switch identities for the length of an outage). **`gh auth status` is never run**:
  measured on gh 2.45 with GitHub unreachable it printed "The token in hosts.yml is invalid";
  `gh auth token` only reads the local store and our own classified `/user` check decides.
  Settings says "GitHub could not be reached to check the sign-in" and keeps the last confirmed
  sign-in on screen; `saveToken` refuses an unchecked token without calling it invalid.
  **(4) A close carries its reason.** `UpdateIssueInput.stateReason`: the close confirm offers
  Completed / Not planned (Completed preselected — GitHub's default), a reopen sends `reopened`.
  It rides ONLY with a state change (the "send `state` only when it changes" rule stands), the
  client refuses a reason of the wrong kind, and a close GitHub recorded with a different reason is
  not reported as confirmed. **(5) Writes need an approval that covers the column mapping.** The
  mapping (which label a column applies, which column closes) is in the git-shared project.json,
  so a pulled commit could re-aim writes under an approval given for something else. An approval
  records `githubMappingDigest(repository, completionColumnId, columnMappings)` — column ORDER and
  titles excluded (they change nothing GitHub sees; `config.revision` includes order and would make
  every column drag revoke writes). Moves and "Create missing labels" require the digest to match
  (`context.mappingApproved`); READS stay on the repository approval, since the mapping only decides
  what a write does. A mismatch makes the board read only and says why (`page.mappingNotApproved`);
  Settings offers "Approve column labels". **Upgrade:** an approval from before this change has no
  digest — it keeps reading and must be approved once more before the board writes. Pinning the
  on-disk mapping at first load was rejected: it would silently trust whatever a `git pull`
  delivered between the upgrade and that load. **(6) Revoke deletes the cache.** The plaintext
  issue cache (bodies included) is removed by the same bounded path as "Clear cached data", AFTER
  the revoke is recorded — a failed delete is reported (`revoked-cache-kept`), never left approved.
  The cache file is per (identity, repository), so another project on this machine bound to the
  same repository re-fetches too. **(7) Every client that leaves releases its subscription.** The
  service polls every 60 s per subscribed repository; the desktop window now releases on `closed`,
  `render-process-gone` and `did-navigate` (`main/renderer-client-release.ts` — not
  `did-start-navigation`, which also fires for a navigation the guard blocks), beside the relay
  peers and Server Edition sockets that already did. **Mobile: N/A** — the phone's board carries
  session cards only (the `githubIssues:*` channels are served to relay TABS, never the phone
  dialect), so nothing there can read a throttle as signed out; surfacing GitHub cards on the phone
  would need this whole contract carried over the relay.
  **Pull request CI, mergeability and links** (2026-09-29; core `graphql-pulls.ts` +
  `pull-status-tracker.ts`, shared `github-pull-status.ts` + `kanban-pull-links.ts`, renderer
  `lib/pullLinks.ts` / `lib/pullAutoMove.ts` / `lib/pullChase.ts`). The issues harvest cannot say a
  PR's head, checks or mergeability, so ONE GraphQL read per repository adds them: every open PR's
  `headRefName`/`headRefOid`/`isCrossRepository`/`isDraft`/`mergeable`/`mergeStateStatus`, the head
  commit's `statusCheckRollup`, `closingIssuesReferences`, plus the 30 most recently merged/closed
  PRs (so a branch link survives the merge). MEASURED on this repository (60 open PRs): **1 point**
  of the separate `graphql` budget, ~18 KB; the per-PR checks read (modal open only) is also 1.
  **When it runs:** after a heartbeat that reported a change, on a user refresh, on the first
  heartbeat of an app run, when the last read failed or the budget skipped one (`owed`) — never on a
  304 otherwise. A finished check run does NOT move the heartbeat, so an UNDECIDED PR (mergeable
  UNKNOWN or rollup PENDING/EXPECTED — measured: 40 of 50 open PRs read UNKNOWN on a first read, all
  settled 20 s later, because the first read is what starts GitHub's computation) is CHASED at
  30 s / 1 min / 2 min / 5 min, at most 12 reads per episode, and only while a board is VISIBLE: the
  renderer asks (`githubIssues.chasePulls`) every 15 s while `document.visibilityState` is visible,
  and the host answers from a map — schedule, cap and the synchronous `claimChase` live in core, and
  no context (credential chain) is resolved unless a read is due. A new undecided PR or a new head
  starts a new episode; the same stuck PR does not restart the count. **Semantics, each a shipped
  bug somewhere:** a null rollup is "no checks" and renders NOTHING (never a tick); only
  `mergeStateStatus === 'CLEAN'` is "Ready to merge" (MERGEABLE+BLOCKED is real: 2 of 31 here);
  a rollup counts only at the current `headRefOid`, and a CI result is never carried from an older
  head; a failed read keeps the last snapshot marked stale (`pullStatusFreshness`, greyed after
  15 min); a FORBIDDEN/INSUFFICIENT_SCOPES answer for the rollup or mergeability HIDES that region
  (`access`), which is not the same as a null rollup. Enum values (`mergeable`, rollup `state`,
  `mergeStateStatus`) decode LENIENTLY: a value GitHub adds later claims nothing and is not chased,
  and an unrecognised rollup state is `UNRECOGNIZED`, never `null` ("no checks") — one new value
  must not fail every read of the repository (it happened with `state_reason: duplicate`). **Budget:** GitHub meters `graphql` apart from
  `core`, and so does the coordinator now — `throttle(identity, at, resource)`, a primary limit is
  tagged with its resource (`GitHubClientError.resource`, from `x-ratelimit-resource`, or GraphQL's
  200-with-`RATE_LIMITED`) and holds only that resource; an untagged (secondary) limit still holds
  the identity. A spent graphql budget (the user's own `gh pr list` spends it) must not stall REST
  issue sync. **Links:** PR → issue = GitHub's own `closingIssuesReferences` (same repository only),
  deliberately NOT unlinkable on the board — GitHub closes the issue at merge whatever the board
  shows. PR → session card = the PR's head equals `data.worktree.branch` of the card's nearest bound
  group (`worktreeBranchOf`, no git read; a stale binding still names the branch, which is exactly
  when its PR merges); a FORK PR never links (36 of 50 open PRs here are forks). Unlinking writes a
  git-shared tombstone in `ProjectKanban.pullLinks` — a BOARD-LEVEL field on purpose: every card-meta
  setter rebuilds `meta[]` entries from a fixed field list, so a field added there is erased by the
  next member/due/label edit. On an SSH project NO card carries a worktree branch
  (`kanbanSessionsFrom` leaves it off where the cards are built), so the card face, the move and
  the modal — which states the worktree reason — cannot disagree. PR → issue → session card: a session started on an issue (`data.issueRef`, below) links to
  every PR whose `closingIssuesReferences` name that issue, matched against the pull board's own
  `repository` (a `closes` number means nothing in another repository); here a FORK PR does count —
  GitHub's "Closes #N" is meaningful wherever it comes from. The host memory remembers what a PR
  closed while open, so the link survives the merge that should move the card; the same tombstones
  apply, and an issue-bound card on an SSH project still links this way (only the branch half needs
  a worktree group).
  **What this machine observed lives on the HOST** (`core/github/pull-memory.ts`, persisted beside
  the issue cache per identity + repository, deleted with it): every PR it has seen, its head, its
  lifecycle, whether it was seen open, and `mergedSeenAt` — the first time it was seen merged AFTER
  being seen open (an OBSERVED merge). The read lists only 50 open + 30 recent PRs, so without it a
  closed-unmerged PR's block would expire once 30 newer PRs closed; remembered PRs stay on the pull
  board (closed ones until unlinked, merges for 30 days) and an unlisted one takes its lifecycle
  from the REST harvest. The first version kept a per-card "seen" map in settings.json instead, and
  review found three failures in that shape: the planner's output exceeded the sanitizer's bounds so
  the hook rewrote settings in a loop until React threw; the block expired; and two Server Edition
  tabs both moved the card while a background tab's settings write reverted another tab's changes.
  **Merge-driven move — session cards only, OFF by default.** The switch, the target column and
  `armedAt` are MACHINE-LOCAL (`settings.kanbanPullAutoMove.projects[projectId]`, written ONLY by
  the user's own Settings action): it makes this machine write the shared board on its own, so a
  switch in the project file would make every clone move and commit cards nobody on that machine
  asked for. Per-card opt-out is board content (`pullLinks.noAutoMove`). Guards in order
  (`decidePullAutoMove`): opted out → never; any linked PR open/draft → wait; any closed unmerged →
  blocked until the user unlinks it; already in target → nothing; no linked merge with
  `mergedSeenAt >= armedAt` → no move (arming never sweeps old merges; `armedAt` is taken from the
  HOST's clock via the pull board's `now`, because `mergedSeenAt` is stamped there and a Server
  Edition browser's clock can be off). Each planned move must then win the host's one-time CLAIM
  (`githubIssues:claim-pull-auto-move`, persisted in the same memory) — the first ask across every
  window wins, and a card dragged back is not moved again for the same merges. **Claims are
  recorded PER PR (project + card + PR), never per PR set**: the linked set changes on its own (a
  merged PR ages off the pull board, another PR on the branch joins), and a set-keyed claim read
  every such change as a new transition and moved a dragged-back card again. A claim is granted only
  for a PR that has not moved this card yet; set keys an earlier build wrote are read as a claim on
  each PR they list. The board asks each (card, PR set) ONCE while it is in flight or after it was
  won, and re-asks a REFUSED one only after `REFUSED_CLAIM_RETRY_MS` (60 s: the host also refuses
  transiently, before it is bound to the project or while it clears its cache, and remembering that
  for the board's lifetime lost the move); a failed call is forgotten. It re-plans only when a field
  the planner reads changes — it used to send a claim per canvas change for a dragged-back card. **The claim is refused unless THIS card was
  noted waiting on one of those PRs while it was open** (`githubIssues:note-pull-waits`; the host records a note only for a PR it holds as open
  itself): `mergedSeenAt` is a fact about the PR, and without the per-card note a card that first
  appeared after the merge — a follow-up terminal in the same group, a teammate's card by git pull,
  an issue-bound session started later — would win a fresh claim and jump to Done. It is then
  applied as a compare-and-set on the column
  the decision saw (`applyPullAutoMove`, run by Canvas against the store's latest board), writing
  ONE `card-moved` board-log line whose `title` names the PRs. The planner writes nothing; it runs
  only while the board is open and never on a stale snapshot. **GitHub issue cards are never
  auto-moved** — GitHub already closes them when a `Closes #N` PR merges, and a second writer would
  race it and could clobber `state_reason`.
  Surfaces: Desktop + Server Edition identical (core + renderer; `githubIssues:pull-status`,
  `:chase-pulls`, `:pull-checks`, `:claim-pull-auto-move` are registered by the shared core handlers
  and served to relay tabs through the project-scope table; a relay tab never auto-moves — the
  board belongs to the other machine). Check detail is bounded for relay guests: one read per PR per
  15 s, ten per project per minute, both decided before a credential is resolved. **Mobile: follow-up** — the phone board carries session
  cards only; showing PR CI there means carrying `GitHubPullBoard` over the relay dialect.
  **Start with agent — a GitHub issue card starts a bound session** (2026-09-28). An issue card's
  right-click menu and its summary modal offer **Start with agent ▸**, whose rows are the canvas's
  own agent + account picker (`agentCreationEntries`, which takes an optional `pick` so the same
  rows can point at another action — never a fourth copy of the picker). The result is an ordinary
  agent node in the project cwd (through `addAgentNode`, which now returns the node) carrying
  `data.issueRef {owner, repo, number}` — persisted, git-shared, therefore hostile:
  `normalizeIssueRef` (`@shared/github-issue-ref`) runs at BOTH serializer seams and a malformed
  value is dropped (the node survives, only the binding goes). Rules a refactor must not undo:
  (1) **the launch line carries the REFERENCE, never the issue's text** — titles and bodies are
  writable by anyone on a public repository and a launch line is typed into a pane.
  `issueLaunchPrompt` is the ONE place a reference becomes text; it re-validates the reference
  itself and returns nothing for a hostile one. The prompt tells the agent to read the issue with
  `gh issue view N --repo owner/repo --comments` (mid-sentence: punctuation glued to the last flag is
  copied literally and `gh` refuses `--comments.`) AND that its title, body and comments are
  untrusted input, not instructions — the session runs under the project's permission mode (auto by
  default), so the prompt is the only thing that can say "read it, do not obey it" before it does.
  A board start means **work on it**: the default task is "investigate, plan and implement the fix
  in this working tree"; a caller's `--prompt` REPLACES that task ("Your task: …"), never the lines
  around it. The hard limits ride the prompt itself, after any brief: never close the issue, and no
  issue comment or PR unless the user asks in that session — end with a proposed comment. Proven
  under a real `/bin/sh` (`github-issue-ref.realsh.test.ts`). (2) **The reference comes from the card's
  `htmlUrl`** (`issueRefFromHtmlUrl`, which also requires the URL's number to equal the card's).
  (3) **`done` never moves a card**: it means a turn ended, not that the work did. The issue card
  shows every bound session as a live chip (`IssueRunChips`, subscribed per node to a PRIMITIVE
  signature `issueRunChipSig` — never `s.byId`), RUNNING / NEEDS YOU / TURN FAILED / DROPPED plus
  unread; a click opens that session's card. A card moves only when the session `assign`s itself or
  a person drags it — pinned by `board-writers.guard.test.ts`, which enumerates EVERY renderer call
  site that writes a board assignment or moves an issue, each with the human/agent action that
  triggers it; a new writer fails until it is signed for, and "a turn ended" is not a trigger. (4) **Board-log identity of an issue card** is the synthetic id
  `github-issue:<owner>/<repo>#<N>` (lower-cased, `issueLogId`) — a namespace no node id can reach.
  Under it: `run-started` (UI start, `--issue` open) and `run-ended` (written by EVERY node-removal
  funnel — `deleteNodes`, `closeStoredNodes`, the Omni delete, `deleteProject`, the Server `close` —
  before it drops the node's agent status, with the last observed state). `duplicateNode` drops
  `issueRef` (a copy is a new session nobody started on the issue; carrying the binding made a
  phantom run). Known gap: ⌘Z/⌘⇧Z replay node arrays and write no run history, so an undone delete
  revives a node whose run already ended. The summary modal shows it read-only as
  "Agent runs" (no composer: a comment box under an issue reads as "post to GitHub"). **No cost or
  token figure** is recorded: there is no cumulative per-session number, and a context-window
  reading is not one. (5) The new session card is filed under the issue card's column (the same
  unpruned direct write `createNodeInColumn` uses); the node header, the session card AND the card
  modal's header show a `#N` chip (`IssueRefChip`; the modal's closes itself and makes the same
  request) that opens the issue on the board (`openIssueOnBoard` →
  `viewMode.requestedIssue`) ONLY when that board has GitHub sync — otherwise straight to GitHub,
  rather than flipping the project's persisted view to a board that cannot show it — and the board
  itself falls back to GitHub when the issue is not on a fetched page. Never a dead click. **"Start
  with agent in a new worktree ▸"** sits beside it on the card menu and in the summary modal: a
  fresh `issue-<N>-<slug>` worktree frame with the agent inside, reuse offered when the issue
  already has one — see the Worktrees bullet ("A worktree per GitHub issue"). Surfaces: Desktop + Server Edition (renderer + core); Omni board shows no
  issue lanes; **Mobile does not render the binding** — `issueRef` reaches the phone inside the
  project file, and nodeterm-ios ignores the unknown field (follow-up there).
  **Board dispatch — a card THIS person moves into the dispatch column starts its own run**
  (2026-09-30; `@shared/board-dispatch` consent, `renderer/lib/boardDispatch.ts` decisions,
  `state/boardDispatch.ts` queue, wired in Canvas `dispatchOnUserMove` / `drainDispatchQueue`). The
  run is exactly "Start with agent" — `issueRef` binding, the reference-only `issueLaunchPrompt`,
  `fileIssueSession` (card filed + `run-started`) — only nobody clicked it. The hard question is WHO
  may trigger a run on this machine, and the answer shapes everything else:
  - **The trigger is the person's own move in this app**, never a fact that arrives from outside.
    `decideDispatch` answers `ignore` for every origin but `'user-move'`, and the only caller that
    says `'user-move'` is the board's move-result path (`KanbanView.moveIssueByUser` →
    `onIssueMoved`, reached only from `requestGitHubMove` and the close/reopen confirm). A label
    set on GitHub (by anyone — on a public repository, ANYONE) reaches this app only as a refreshed
    page, and a board change arriving by `git pull` only as a new project file; neither has a path
    in. A move GitHub did not CONFIRM (`stale`, `failed`, `read-only`, …) is not a dispatch.
    `lib/board-dispatch.guard.test.ts` pins the WHOLE chain: `decideDispatch`'s one caller,
    `onIssueMoved`'s one firing site, `dispatchStart`'s two callers (after `decideDispatch` in
    `dispatchOnUserMove`, after `recheckQueued` in the drain), and that a `'queued'` entry — which
    the drain starts without asking `decideDispatch` again — is created only in `dispatchOnUserMove`.
  - **Why not a label with an actor allowlist** (the other design considered): it works from a
    phone, but it needs one issue-events read per candidate issue (budget), compares an actor
    against a credential that can change under it, and today the poll runs only while a board is
    subscribed — a network-derived fact standing in for consent, and no run at all when nobody has
    the board open. That is the follow-up, not v1.
  - **Consent is machine-local** (`settings.boardDispatch`, the `kanbanPullAutoMove` / trigger arm
    store tier), never `.nodeterm/project.json`: a switch in the project file would let a pull
    request make every clone start agents. Per project: the column, the agent, an optional account
    (absent = the project default through the same funnel as "New <agent>"), a cap (1–8, **default
    1**: dispatched runs are told to implement the fix in the project's own working tree, so two at
    once are two agents editing one checkout), and a **binding**.
  - **The consent binds what the column MEANS, not just its id** (`dispatchBinding`: repository +
    column title + its GitHub label). Titles and labels live in the git-shared project file, and
    titles are deliberately outside `githubMappingDigest` — so without it a pulled commit swapping
    the titles of "Agent" and "In Progress" would turn the person's routine drag into "In Progress"
    into a dispatch, and re-pointing the board at another repository (which needs only a mapping
    re-approval) would carry the dispatch switch along. Any difference refuses (`consent-stale`, on
    the card and in Settings) until the person presses "Re-confirm this column". Choosing a column
    binds; changing the agent or the cap does not re-bind. An entry without a binding is OFF.
  - Read through `sanitizeBoardDispatch`: an unreadable entry is OFF, an unreadable cap is 1, the
    kill switch (`paused`) is on only for a literal `true`. `boardDispatch` is in
    `SETTINGS_VERB_FORBIDDEN` — an agent that could switch the dispatcher on would grant itself more
    agents, and the name pattern does not catch the key, so the set is its only fence. Model: the
    same gateway default `addAgentNode` applies; there is no per-project model.
  - **Only agents that report their state through hooks** (`dispatchableAgent` →
    `hasHooks(capabilityAgentId(…))`, the `--after` rule) are offered or accepted. The cap counts
    sessions by hook state; a hookless custom agent never reports, so after the startup grace its
    slot would free and the cap would admit one more run every two minutes.
  - **Bounds.** One run per issue: a bound session that still exists in ANY project, or a dispatch
    already queued/starting, refuses the next with a reason on the card. The cap counts this
    project's bound sessions that are `working`/`waiting`/`blocked`, hold a launch that will start
    BY ITSELF (a `manualOnly` one waiting for Run now does not), or were started by dispatch within
    `DISPATCH_STARTUP_GRACE_MS` (no hook yet) — `done` frees the slot (the cap limits concurrent
    WORK), and an unknown state from before a restart does not hold one, or the cap would stay
    pinned. Over the cap the dispatch QUEUES; the drain runs on a 5 s timer only while something is
    queued. **Every queued entry is re-asked before it starts** (`recheckQueued`): kill switch,
    still switched on, project still open/local/not closed, binding unchanged, agent still
    dispatchable, and the issue still OPEN and still in the dispatch column (read from the host's
    issue cache with `githubIssues.query` — no GitHub request; an unreadable answer waits, it is
    never evidence). A teammate closing or moving the issue while it waited drops it with its
    reason. Moving a queued card out of the column withdraws it. The kill switch refuses new
    dispatches and drops the queue; running sessions are not touched.
  - **No dispatched node is ever left armed to start on its own.** The off-screen path writes the
    node ALREADY CLAIMED (`claimForHeadless`: `manualOnly`, in the same tick as the node — no window
    in which opening the project would auto-start it beside the headless start), then runs the #925
    headless start. Whatever it answers, a node that did not start waits for Run now; a Pause or a
    restart can therefore never be outrun by a held launch that fires on view. The failure notice
    says exactly that (Run now, or close the node to dispatch the issue again — it keeps the issue's
    one run until then).
  - **The queue is in memory, on purpose**: a queue that survived a restart would start agents at
    boot with nobody there. A restart drops it silently, and the drag (or Start with agent) can be
    repeated. Each renderer keeps its own queue, so **two Server Edition tabs on one project can
    each run up to the cap** (known; one tab per project is the supported use).
  - **The card says what happened** (`DispatchChip`): "Queued for an agent (#2)", "Dispatching an
    agent…", or "Not dispatched: <reason>" (`DISPATCH_REFUSAL_TEXT`). A started run shows as the
    ordinary run chip.
  - **Where it runs: the renderer**, because the trigger is a UI gesture core never sees. On screen
    it is `addAgentNode`. Off screen — a queued run whose slot freed later, or a project switch
    during the move's GitHub round trip — it is a cold open into the stored project (the control
    verbs' path) plus the headless start, which raises its "Go there" notice. A CLOSED project's
    queued run is dropped, not started (the headless start would unhide its tab). **Server
    Edition**: the browser renderer's `pty.launchHeadless` is unsupported (the server's own
    headless launcher serves canvas control, not a browser tab), so a dispatch there starts only
    for the project ON SCREEN; an off-screen one stays queued (still subject to Pause) until that
    project is shown. **SSH projects: refused by name** (the headless launcher is local-only).
    **Relay tabs: refused** (the board is the host's). **Mobile: N/A** (the phone board carries no
    issue cards). Never auto-posts to GitHub, never closes an issue, never moves a card on a turn
    `done` — the existing rules; the dispatch column may not be the completion column.
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
  during a header rename only cancels the edit). The modal runs under the CARD project's session
  (`ProjectSessionScope` — the boards themselves sit under App's local provider; see "A remote
  project's node never starts on this core" under Projects). Terminal cards get a LIVE second
  view of the tmux session (`ModalTerminal.tsx`): the pty subscriber ledger is keyed by the composite
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
  scoped class has none, so the fail-closed default cannot silently swallow a shipped verb.
  **A comment can steer an agent**: its composer's @ picker (canvas flyout and card modal alike —
  both build the candidates through `lib/boardMentions`) mentions an agent session on this board,
  and on send that session receives the comment through agent messaging; the row shows each
  delivery's outcome. A comment that ARRIVES in the log is display-only, forever — see "A board
  comment that @mentions a session" under Agent support. Deliberate v1 gaps: column-level
  events are stored but no card feed shows them; canvas-born nodes get no card-created; no
  card-deleted type.
  Per-column "+ New session" menus create agents/terminal/sticky nodes assigned to the column
  (assignment written UN-pruned — the fresh node isn't in the derived list yet).
  **Multi-select** (2026-11, both boards): ⌘/Ctrl-click toggles a session card, Shift-click extends
  from the last picked card in BOARD order, and while anything is selected a plain click keeps
  picking instead of opening the modal (Esc / the bar's ✕ leave; the card menu's **Select** row is
  the way in without a modifier). The floating `CardSelectionBar` and the right-click menu of a card
  INSIDE a multi-card selection (`buildBulkCardMenuItems`) act on all of them — **Move to**
  (`assignNodes`, which lands the group together and in board order at every anchor; a loop of
  `assignNode` would reverse it at the top) and **Delete** (ONE canvas confirm: `onDeleteNodes`, or
  `nodeterm:global-delete` with `nodeIds` from an Omni lane) — and dragging a selected card carries
  the selection. Load-bearing: the selection is pruned against the cards ON SCREEN and callers read
  the pruned value in the same render (`useCardSelection`), so a bulk delete can never reach a card
  that a filter, a collapsed lane or a hidden closed column took out of sight; GitHub cards are
  never selectable (their column is the provider's); on the Omni board a selection lives in ONE
  lane (`selectionOwner` — two projects share no columns). Rules are pure in
  `lib/cardSelection.ts`. No keyboard chord yet (no `board.*` registry command selects or deletes). The column
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
  **Board model + UX (2026-09).** Three tiers, and a new board feature must pick one: a board
  FACT is shared content in `project.kanban` (optional, sanitized, ignored harmlessly by an older
  build); a DISPLAY preference is per-user localStorage (`state/kanbanDisplay.ts`,
  `nodeterm.kanbanDisplay`, per project); a filter on LIVE agent state is component state only.
  - **`sanitizeKanban` (`core/workspace-files.ts`) is the shape rule now**, applied on all three
    seams — `fileToProject`, the store's inline-project branch (which bypasses it) and
    `projectToFile` on the way OUT (the two-seam rule `sanitizeLayouts` follows). It is
    `validKanban` plus per-entry repairs, never inventions: a column that is not an object with
    string `id` + `title` is dropped (React cannot render an object title — a render throw
    boot-loops the app, the view choice persists), a non-string `category` is dropped, a malformed
    assignment is dropped, a card's `assignees` that is not a list is dropped (entries without a
    string name + colour filtered), every other field round-trips, and a clean board comes back BY
    IDENTITY so a well-formed file is never rewritten. **Readers do not trust the load path alone**:
    `cardAssignees` (`@shared/kanban-labels`) is the one reader of `meta[].assignees` — the board,
    the card, the member filter, the log diff and the handoff pings all go through it, because an
    `assignees: 5` iterated raw threw during render (a boot loop) and inside the `assign` verb.
  - **Lifecycle category** (`KanbanColumn.category?: unstarted|started|done|closed`,
    `@shared/kanban-category`). Every reader goes through `columnCategory`: an unknown STRING reads
    as absent but is KEPT in the file (dropping it would erase a newer build's value on an older
    teammate's save); a non-string never reaches a comparison. The default board carries
    unstarted/started/done on every seeding surface (`defaultBoardColumns`, shared by
    `defaultKanban` and the relay's `ensureProjectBoard`/label seeding). It drives the header
    progress (`boardProgress`: live cards in done+closed columns over EVERY live card, Ungrouped
    included; null when no column is done/closed — a number over an undefined "complete" would be
    invented), hides `closed` columns behind a per-user toggle (default hidden), and gives the GitHub
    completion column its default (`defaultCompletionColumnId`: first done, else first closed, else
    the last column — the pre-category default, so an uncategorized board is unchanged). **A
    category change on a column that holds cards is never silent**: it is a claim about every card
    in the column (they start counting as finished, or leave view when it becomes closed), so
    `categoryChangeImpact` gates a `ConfirmDialog` naming the count and the consequence; an empty
    column changes at once. Confirm rather than refuse: refusing would only make the user empty
    the column first, which is friction, not safety. Set from the column's ⋯ menu / header
    right-click on the per-project board; Omni shows no column menu.
  - **An unanchored card move lands at the TOP** (`assignNode`): no `before`, or a `before` naming
    a card outside the destination column. An agent's `assign` into a long Done column used to
    append at the bottom and read as "disappeared". A POSITIONAL drop still says where it landed —
    below the last card or on the column body passes `AT_COLUMN_END` explicitly (both board views).
    The relay's `projects.setCardColumn` follows the same rule; the `assign` help in BOTH agent
    bodies says so (`canvas-control-core.test.ts` pins it).
  - **Status chips** (Running / Needs you / Unread, `lib/kanbanStatusChips.ts`) read the store
    through a derived primitive signature (`statusChipSig`) — never `byId`, the `armedDepSig` rule —
    and are NEVER persisted (component state, reset on project switch): a filter on
    second-by-second state that survived a restart shows a wrong board. The card badge and the chips
    share ONE rule, `cardBadge`, so a chip cannot select cards whose badge says something else. They
    narrow session cards only (like local labels); they AND with the label filter and OR within
    themselves.
  - **Board-log folding is a VIEW** (`lib/boardLogCollapse.ts`, `BoardLogFeed`): consecutive events
    by the same author (name AND colour) of the same type within two minutes of the run's NEWEST row
    render as one "×N" row that expands in place; the jsonl is never rewritten. The window is
    anchored, not chained, so a ×N never spans more than two minutes. Comments never fold, and
    neither do `agent-message` / `agent-read-cookies` (audit rows) or an issue's `run-started` /
    `run-ended` history (each row names a different session) — `NEVER_COLLAPSE`.
  - **Keyboard**: registry scope `board` (group Board) — Space opens the focused/hovered card,
    J/K + ArrowDown/Up walk board order (the session cards on screen, column by column, Ungrouped
    first; GitHub cards excluded), ArrowLeft/Right jump to the same row of the neighbouring
    non-empty column; in the card modal J/K step the modal. `board` resolves only while a board is
    up and has no `allowWhileTyping`/`allowInTerminal`, which is the ONLY reason
    `normalizeBindingForCommand` lets it bind a bare letter or Space (the card modal's terminal,
    the comment box and the chat composer keep every key). Dispatch stays in Canvas's one
    listener; the mounted per-project board answers through `lib/boardKeys.ts` and DECLINES (the
    key falls through) when the focused control uses the key (`keyOwnedByControl`: Space on a
    button/link/checkbox, anything in a `<select>` or ARIA composite), when any dialog other than
    its own card modal is open, or when a card menu is up. Two pre-existing bugs this had to fix:
    the canvas's CAPTURE-phase space-to-pan `preventDefault`ed every non-typing Space even while a
    board covered the canvas (so no board button could be pressed with Space) — `spacePanKeydown`
    now takes `canvasCovered`; and a `Space` binding could never match because `e.key` is `' '`
    (`normalizeKey` maps it to `SPACE`). The Settings recorder captures a bare key only for a
    command that may have one (`board` scope or `allowBareKey`).
  - **Rank strings** (`KanbanAssignment.rank?`, `@shared/kanban-rank` + `@shared/kanban-order`).
    Order within a column = rank; an entry without a valid one (every pre-rank board, an older
    build's move — its `assignNode` rebuilds the moved entry without the field — a hand edit) sits
    right after the entry before it in the ARRAY, ties keep array order. Keys are base-62
    fractional-index strings with an integer head, so the board's DEFAULT (top insert) is a
    decrement: a thousand top inserts stay four characters (a digits-only midpoint scheme grows a
    character every few). **A move never throws**: ~1.3k inserts into ONE gap grow a key past
    `RANK_MAX_LENGTH` (256), and only then is the destination column re-keyed evenly as one
    contiguous block (`rebalanceColumn`) — the one rebalance this scheme does. A rank STRING readers
    cannot use is kept in the file (like an unknown category) and re-keyed by the next write into
    that column; a non-string is dropped. A card assigned twice (a clean git merge can do that)
    keeps its FIRST assignment everywhere — `sanitizeKanban`, `columnOrder` and `placeAssignment`
    (which removes every copy of the moved card, as the pre-rank `assignNode` did). **Every write goes
    through `placeAssignment`** (renderer `assignNode` AND the relay's `setProjectCardColumn`), which
    also keeps the array in rank order so a build that ignores `rank` shows the same column — the
    brief's two goals ("a move is a one-line diff" and "keep writing the array in rank order") pull
    against each other, and the resolution is to move as little as the second allows: a
    cross-column move whose array slot already sits between its new neighbours changes ONE entry in
    place (two lines: `columnId` + `rank`); otherwise its block moves next to its successor; a
    reorder WITHIN a column always moves a block (the array must change for an old build to see
    it). A destination column is repaired first when it must be — missing/invalid/colliding ranks
    re-keyed in the order it was already showing (only those entries change; a board's first write
    into an unranked column ranks it once), an array that disagrees re-slotted within the column's
    own positions. MEASURED with `git merge-file` (`core/kanban-rank-merge.test.ts`): two
    ADJACENT cards filed into Done concurrently conflict under array-only placement and merge
    cleanly with ranks; two NON-adjacent ones merged cleanly either way, so do not claim more than
    that. The file's own `rev`/`savedAt` header still conflicts on any concurrent save — untouched.
  - **Saved views** (`kanban.views: [{id, name, query}]`, `@shared/kanban-views`) are SHARED
    content: a query carries source, labels, members and columns (the member and column filters are
    board filters of their own). `viewQuery` is the ONLY builder and reads only those four, so the
    status chips can never enter a view. The ACTIVE view and "show closed" are per user
    (`kanbanDisplay`), restored on entering the board; a view a teammate deleted is ignored.
    Deleting a view confirms (it goes for everyone). `sanitizeViews` runs inside `sanitizeKanban`,
    keeps query fields it does not know, and `KANBAN_VIEW_SOURCES` is pinned to the renderer's
    source registry (the shared sanitizer cannot import it).
  - **Handoff pings** (`lib/handoffPings.ts`): the `assign` verb notifies a card's ASSIGNEE (this
    machine's presence name) when an agent files it into a `done` column or a `started` column past
    the board's first — never on routine moves, and not for needs-you (the existing agent-status
    alert already covers every agent node). Same consent, background-only rule and per-node
    cooldown as the turn-end alert, and a handoff ping arms a one-shot FOLD so the Stop hook that
    follows seconds later is not a second notification for the same moment. The fold lasts only
    while the user is away: a window focus in between drops it (`installHandoffFocusReset`), or the
    next chime — for a turn the user sat and watched — was swallowed. v1 is agent-driven
    moves only: a teammate's move arriving by git, or the phone's relay move, pings nobody.
  - **Team progress** (`lib/teamProgress.ts`, `components/TeamProgressChip.tsx`): a session that
    opened stations shows "N of M done" as a small ring on its board card, its card modal header
    AND its canvas node header — ONE component, so three views of one node cannot count
    differently; clicking it lists the stations and a row travels to that node. A station is a
    session node that is the target of an OPENER rope. Ropes carry two relations — "opened by"
    (`ctrl-<source>-<node>`) and a wait (`--after`, the verify panel), which is minted
    `ctrl-after-<dep>-<node>` (`waitRopeId`, `lib/edgeModel.ts`) and skipped. **The mark is what
    makes this hold, not rope order**: the canvas prunes every rope with an endpoint off the canvas,
    so deleting an orchestrator (or the user deleting its rope, or a `--project` open whose opener
    lives in another project) removed the opener's rope, and under the old "first rope is the
    opener" rule the first surviving wait read as the opener — a pipeline's upstream station showed
    the next one as its team, a verify panel's reviewed node showed its reviewers. Canvases saved
    before the mark are re-marked at LOAD by append order (`markLegacyWaitRopes`: every rope into a
    node after its first is a wait), which must run before the prune; one already pruned and saved
    has lost that evidence. **A node that records its opener (`data.openedBy`, the station-notice
    stamp) closes that residual**: only the recorded opener's rope may claim it, so a surviving
    wait is never promoted; the rope still has to exist (delete it and the station leaves the team,
    the same pair the station-failure notice reads). Nodes opened before the field keep the rope
    rule. Tests run the canvas's load → heal → prune steps before `stationsByOpener`. Rules the count keeps: **unknown is unknown, never done** (state is
    transient; after a restart a station reads `unknown` until it reports), paused/hibernated count
    as a finished turn (both come only from an exit that refuses a working or blocked session), a
    CLI that announced its exit (`sessionEnded`) reads `ended` and counts (it is not running and
    never will be on its own — `unknown` would hold the ring below complete forever), a held launch
    reads `queued`, `done` + `lastTurnError` reads `errored` (the `--after` verdict), a station that
    can never report (plain terminal, hook-less agent) is listed as "no status" and kept OUT of M
    (the line `--after` draws), and a deleted station is not a station.
    Subscriptions: each chip reads `teamProgressSig` — one character per station, no ids — never
    `byId`; the per-project board gets the teams as a prop from Canvas, the Omni lanes derive
    theirs from the stored `p.ropes`/`p.nodes`, and the canvas node header reads `useTeamStations`
    (`state/teamStations.ts`, a transient store Canvas publishes from its live control ropes). The
    previous map is threaded back into `stationsByOpener`, so an unchanged team keeps its array
    identity across drag frames and nothing re-renders. Desktop + Server Edition identical;
    Mobile: follow-up (the phone board would need the ropes).
  - **The card does not repeat what its place says** (`lib/cardRedundancy.ts`). The session-name
    chip is hidden when it is the card's title (agent titles auto-track it) — the same rule the
    canvas node header has always had, now one function for both — and a past due date in a
    done/closed column keeps its date but drops the overdue alarm. The card MODAL keeps both facts:
    its header names a session that differs from the title, and its Due strip still says
    "Overdue". Audited and NOT hidden (written in the module so the next audit does not re-derive
    it): the card never names its column or its project, and there is no badge that restates a
    column category — RUNNING / NEEDS YOU describe the agent's turn right now, which is exactly
    what an idle card in In Progress needs distinguished.
  - **`bridges` / `ropes` are admitted through `sanitizeLinks`** (`core/workspace-files.ts`) on the
    same seams as `sanitizeKanban` — `fileToProject`, `projectToFile`, the inline-project branch
    and the legacy v2 path of the store — and on `persistedCanvases`, which reads the RAW index entry
    and last-written file for the context-link map (`buildBackgroundLinkMaps` iterates every
    bridge). They are git-shared, hand-editable input that every reader
    maps as `BridgeLink[]`, and the canvas's rope restore threw on one `null` entry at project load.
    A non-list is dropped, an entry without non-empty string `id`/`source`/`target` is dropped, and a
    clean list comes back BY IDENTITY.
  **Phone** (nodeterm-ios): must at least not break on `category`, `rank` or `views` (extra JSON
  keys its board decoder ignores). The relay-served move now lands at the top with a rank, while
  the phone's direct-SSH writer (`KanbanBoardWriter`) still appends without one — the next desktop
  write into that column ranks it, and array order already shows it correctly. `KanbanDefaults`
  should gain the three categories. All three are the iOS follow-up, not desktop work.
- **Omni Kanban (global swimlanes)** (`components/kanban/GlobalKanbanView.tsx`; one swimlane per open project; `state/viewMode.ts` `globalKanban` (localStorage `nodeterm.globalKanban`, machine-local, like `viewByProject`) + `settings.omniKanbanEnabled` (feature gate, default OFF, `settings.json`) / `omniKanbanAsDefault` (when true, `view.kanbanToggle` — Cmd+Shift+B — opens Omni; otherwise per-project; `view.globalKanbanToggle` registry command — unbound, remappable — always opens Omni when enabled); **Omni is a SCOPE of the kanban side, not a third view**: the view toggle (tab icon, ⌘⇧B, the menu) flips canvas ⇄ board, and a board header's `KanbanScopeSwitch` ("This project" / "All projects", rendered only while the feature is on) moves between the two scopes — so leaving Omni through the switch lands on the project's board, and the view toggle from Omni lands on the canvas (it used to fall through to whatever the project's view happened to be, so "Canvas view" from Omni could land on a board). The decisions live once in `state/viewMode.ts` (`toggleBoardView` / `toggleAllProjectsBoard` / `showProjectBoard` / `showCanvas`), called by TabBar, the menu IPC and both registry commands; Omni has no close button. `globalKanban` deliberately stays independent of the active project, so a project switch made from a lane does not drop the user out of Omni. `isGlobalKanbanOpen()` is the single gate (fail-closed, static import of `useSettings` — the earlier `require` failed open in the packaged renderer). Non-active lanes are derived from serialized `p.nodes` via `toKanbanSessionState` (the persisted-state counterpart to `toKanbanSession`); the ACTIVE project's lane is fed LIVE by Canvas (`GlobalKanbanLive`: the same `kanbanSessionsFrom(nodes)` cards + live `teamStations` the per-project board uses), because its edits reach the store only at the next ~800 ms autosave — a store-fed lane reverted the card modal's controlled sticky textarea on every keystroke and pruned the assignment of a card created a moment earlier. The open card modal is ONE overview-level fact reported to Canvas's `setKanbanModalNode` (watched for Eco, wake-on-open, dictation target), never per-lane state; each lane's board write resolves ITS project's session (`sessionForProject`) for the hosted read-only refusal and the board-log api; `pendingLaunch` never becomes `initialCommand` in the modal (the DAG launch must fire only when dependencies report done, and the canvas `TerminalNode` already delivers `initialCommand` via `writeWhenShellReady` after the `nodeterm:create-node` project switch). Active-project edits (rename / sticky / browser nav) route through Canvas live nodes (`setNodes` + `markDirty`), non-active through the store + `writeDisk`; delete uses `ConfirmDialog` (not `confirm`) and then `deleteNodes` (active project) or `closeStoredNodes` (any other) — the existing cross-project teardown funnel, never a hand-rolled copy. The top bar's project pills and Cmd/Ctrl+1..9 (`nodeterm:swimlane-jump`) jump to the lane; header hint shows the correct mod (`Cmd` on Mac, `Ctrl` elsewhere). Server Edition works as-is, Mobile N/A.
- **Settings** (`SettingsPage.tsx`, ⚙ / ⌘,): font/cursor (live to xterm + Monaco), default
  shell, grid + snap, **default node size** (one row with a kind picker: terminal/agent is the
  `defaultNodeWidth`/`defaultNodeHeight` pair, clamped in `terminalNodeSize()`; every other kind
  the add menus create is an optional entry in `defaultNodeSizes`, resolved by `defaultNodeSize(kind)`
  in `state/workspace.ts` through `@shared/default-node-size`, which clamps hand edits to the kind's
  `NODE_MIN_SIZES` and 2400×1600 — new factories must place through `placeSized`, not a literal
  `*_SIZE`, or the setting silently stops applying to that kind; the agent `settings` verb exposes
  only the terminal pair),
  pan-hover delay, double-click focus, accent, tmux on/scrollback, commit agent,
  `seenShortcuts`. **Every section is MOUNTED whenever Settings is open** — an inactive one
  returns null from `SettingsSection`, but its hooks and the whole render body above that return
  still run. So a throw in a section the user never navigated to blanks the entire page: #1090
  (0.4.0) was `GitHubIssuesSection` calling `dispatchBindingFor` during render, a closure over a
  `const repository` declared ~140 lines lower (below the early returns) — a TDZ ReferenceError on
  every Settings open once dispatch was switched on for the active project. **tsc does not flag a
  closure that reads a later `const`**, only a direct read, so declare anything a render-time
  helper closes over ABOVE the helper. Each section is now wrapped in `SettingsSectionBoundary`,
  which contains a throw to that section (fallback shown only while it is the viewed one) — keep
  new sections inside one.
- **Shortcuts** (`ShortcutsPanel.tsx`, ? / ⌘/): shown once on first launch (`seenShortcuts`).
  **Derived from the registry, never hand-listed** — see the Keybindings invariant below.
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

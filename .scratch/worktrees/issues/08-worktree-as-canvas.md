# 08 — Worktree-as-canvas (coexist with group-binding)

Type: task
Status: resolved

## Question

Make a worktree openable as its own canvas via the isomorphism (ticket 07), **coexisting** with the existing `data.worktree` group-binding rather than replacing it (charter Q18=b: the maintainer keeps the node-group; the drill-down is a toggle, not a second representation — no dual-source drift).

Settled (from charter):
- A worktree group keeps its `data.worktree: GroupWorktree { repoPath, branch, baseRef, path, createdByApp }` binding AND can be `openNodeGroupAsCanvas()`'d — two views of the same worktree, toggled. The binding is the durable reference; the canvas view is derived.
- This is **not** a migration: existing group-bound worktrees keep working as-is; the drill-down is additive.
- The worktree-canvas's `cwd` is the worktree path (children created inside it inherit the worktree path as `cwd`, the same way group-children do today via `cwdForNewNodeIn`).

Resolve:
1. How `openNodeGroupAsCanvas` on a `data.worktree` group differs from a plain group: the worktree-canvas should carry the worktree's git context (branch, status) — reuse `src/renderer/state/worktrees.ts`'s status poll (`refreshStatus`) so the drilled worktree-canvas shows the same dirty/ahead/behind chips `GroupNode.tsx` shows today. Decide where the branch chip lives in the drilled-canvas view (a canvas header? the existing GroupNode chrome, repurposed?).
2. New terminals/agents created inside the drilled worktree-canvas inherit the worktree path as `cwd` — confirm `cwdForNewNodeIn` (the existing group→child cwd inheritance) serves this unchanged.
3. Unbound-worktree adoption (ticket 02): an unbound worktree's "bind" action creates the group node with the `data.worktree` binding; "open-as-canvas" on it then works via 07. Confirm the 02→08→07 ordering is coherent (bind first, then drill).
4. The sessions sidebar (ticket 02): a worktree row should drill into its canvas (via 07) when clicked, not just bind. Wire this once 07 lands.

Check `src/renderer/nodes/GroupNode.tsx` (branch chip, Merge/Unbind/Remove, status poll), `src/shared/worktree.ts` (`GroupWorktree`, `cwdForNewNodeIn`, `displacedByWorktree`), `src/renderer/state/worktrees.ts` (single store/poller invariant — reuse, don't add a poller).

Blocked by: 07

## Answer

### Coexistence confirmed (not a migration)

A worktree-bound group carries `data.worktree: GroupWorktree` (src/shared/worktree.ts:1-12) as its **durable reference**; `openNodeGroupAsCanvas(group)` (ticket 07) is a **transient derived view** of that same group's children, toggled by a `DrillContext = {kind:'group', groupId, projectId}` that is in-memory only and never persisted (07 Answer, "Persistence"). The two coexist without dual-source drift because there is exactly one source of truth — the group node with its `data.worktree` binding, persisted under the owning project's `project.nodes`. Drilling is a projection (children promoted to root-space via `rootPosition`, workspace.ts:918); exit restores `parentId`/`extent:'parent'` (07 reverse leg). No new `NodeKind`, no migration of existing bindings, no second representation. An existing group-bound worktree that never gets drilled behaves byte-identically to today.

### 1. Drilled-canvas header — where the worktree branch/status chrome moves

**The problem.** `GroupNode.tsx` renders the branch chip (`⎇ {status?.branch || wt.branch}`, dirty/ahead/behind emitters at GroupNode.tsx:190-212) and the Merge/Unbind/Remove buttons (214-243) inside the group frame's label pill. Ticket 07 establishes that when a group is drilled, **the group frame itself leaves the node-set** — only its direct children are shown at root-space — so `GroupNode`'s chrome is not rendered in the drilled view. The worktree's git context must move somewhere else.

**The design: a canvas-level header bar for the drilled worktree-canvas.** When `drill.kind === 'group'` AND the drilled group's `data.worktree` is set, Canvas renders a **drilled-canvas header strip** above the ReactFlow viewport (a sibling of the existing top-banners/controls-cluster, NOT inside the `<ReactFlow>` wrapper whose `z-index:0` would trap it — same discipline as the SystemResourcePill `:has()` rules). The header is transient: it mounts on drill entry and unmounts on exit, owned by the `DrillContext` effect, not by a node.

The header carries, left-to-right:
- A **back affordance** ("← <project name>") — the exit leg (07 reverse leg: `drill = {kind:'project'}` + rebuild). This is the breadcrumb 07 already needs; the worktree case just decorates it.
- The **worktree branch chip**, reusing the EXACT markup/logic GroupNode.tsx:178-212 renders today: `⎇ {status?.branch || wt.branch}`, the dirty/ahead/behind `<em>` chips, and the stale "· missing" variant. The `wt` binding is read from the drilled group's node in the full `project.nodes` (the group node is absent from `nodesRef.current` while drilled, but it IS in `useProjects.getState().getProject(projectId).nodes` — the DrillContext carries `groupId`/`projectId`, and the binding is durable there).
- The **Merge / Unbind / Remove** action buttons, wired through the SAME `worktreeActionHandler` bridge (GroupNode.tsx:16-21) — Canvas already registers it; the header calls `worktreeActionHandler?.(groupId, action)` with the drilled group's id. No new handler indirection.

**Status poll reuse — no new poller.** `GroupNode.tsx:78-109` owns a per-frame tick that pokes `useWorktrees.getState().refreshStatus(wtPath, id)` gated on page-visibility + an `IntersectionObserver` against the frame element. In the drilled view there is no frame element to observe, so the header runs the **same tick with a simpler gate**: page-visibility only (the drilled canvas IS the viewport, so the IntersectionObserver is trivially always-intersecting — drop it). The cadence stays `WORKTREE_STATUS_POLL_MS` (20s), the store's `WORKTREE_STATUS_THROTTLE_MS` (4s) floor still coalesces, and `refreshStatus(path, groupId)` (worktrees.ts:215-267) is the single status read — exactly the invariant the ticket cites. The status selector is the same: `useWorktrees((s) => s.statusByPath[wt.path])` and `s.staleGroupIds.includes(groupId)`. No second store, no second poller, no competing `git.status` call. On an SSH project the poll is OFF for the same reason GroupNode.tsx:42-48 states (`wtPath = sshProject ? undefined : wt?.path`); the header shows the branch chip with no live status, matching the SSH-worktree-unsupported v1 contract.

**Why not repurpose GroupNode chrome.** GroupNode's chrome is bound to a rendered node, and the drilled group is deliberately not rendered (07: "only the group's direct children are shown"). Rendering a hidden GroupNode just to host the chip would re-introduce a frame the drill was designed to remove, and the frame's `pointer-events:none` body / `dragHandle` pill semantics make no sense at canvas-header altitude. A dedicated header bar is the honest answer: it is chrome for a *canvas view*, not for a *node*.

### 2. cwd inheritance — `cwdForNewNodeIn` and the parentId-preservation hazard

**The 07 hazard, concretely.** `cwdForNewNodeIn(parentId)` (Canvas.tsx:2879-2897) walks `nodesRef.current` upward from `parentId` looking for the nearest ancestor with `data.worktree` (returns `wt.path` when healthy, non-stale, non-SSH) or `data.cwd`. **While drilled, the group frame is absent from `nodesRef.current`** (07: the group frame leaves the node-set; only its direct children, promoted to root-space, remain). So a naive `cwdForNewNodeIn(drilledGroupId)` hits `nodesRef.current.find(...)` at line 2888, finds nothing, and returns `undefined` — the new terminal would fall back to `project?.cwd` (the MAIN checkout), silently landing in the wrong directory and persisting that wrong cwd forever (the exact `cwdForNewNodeIn`-refuses-the-worktree-path failure the staleness streaks exist to prevent, worktrees.ts:44-49).

**The fix: the DrillContext supplies the worktree path directly while drilled.** `cwdForNewNodeIn` is the resolver for the *nested* (parent→child) view. In the drilled view, a new node is created at root-space inside the drilled canvas — it has no `parentId` yet (it will get one on exit, when the reverse leg re-nests). The creation site therefore cannot rely on walking `parentId`. Instead, the drilled-canvas new-node path reads the worktree path from the **DrillContext + the durable binding**: when `drill.kind === 'group'`, resolve the group node from the full `project.nodes` (not `nodesRef.current`), read its `data.worktree.path`, and pass that as the `cwdOverride` (the existing escape hatch at Canvas.tsx:2979, 2982, 3595) to `addTerminal`/`addAgent`. Concretely:

- `addTerminal(center?, initialCommand?, groupId?, cwdOverride?)` already accepts `cwdOverride` and prefers it (`cwdOverride ?? cwdForNewNodeIn(groupId) ?? project?.cwd`, Canvas.tsx:2982). The drilled-canvas "new terminal" action passes `cwdOverride = worktreePathFromDrill()`.
- `addAgent` (Canvas.tsx:3586-3618) has NO `cwdOverride` param today — it calls `cwdForNewNodeIn(groupId) ?? project?.cwd` (3595). **This is a gap 08 introduces**: add the same `cwdOverride` param to `addAgent` (and route the drilled-canvas "new agent" action through it), so the worktree path is honored while drilled. The change is additive and one line at the call site.
- The worktree-path resolver for the drill: `const wt = useProjects.getState().getProject(drill.projectId)?.nodes.find(n => n.id === drill.groupId)?.data?.worktree; return wt && !stale && !isSshProject ? wt.path : undefined` — the same staleness/SSH gates `cwdForNewNodeIn` applies (Canvas.tsx:2889-2890), so a stale or SSH drilled worktree falls back to `project?.cwd` identically.

**Why not make `cwdForNewNodeIn` drill-aware instead.** Tempting, but `cwdForNewNodeIn` walks `nodesRef.current` by `parentId`; the drilled group has no `parentId` relationship to a root-space child, and teaching the walker to consult the DrillContext would couple a pure-structural helper to transient navigation state. The `cwdOverride` funnel is the existing, intended escape hatch for "the structural walk can't answer this" (it already serves Source Control actions running in a worktree scope, Canvas.tsx:2978-2979). 08 uses it as designed.

**parentId preservation on commit-while-drilled (the 07 hazard, confirmed).** Ticket 07 flags the one genuine implementation hazard: `commitActiveToStore` (Canvas.tsx:1966-1982) serializes `flowToNodeStates(nodesRef.current)` — the **narrowed** drilled set — as the project's whole node array, which would DROP the group frame and every sibling. 07's clean answer is "a commit while drilled merges the drilled children back into the full `project.nodes` then serializes." For 08, the worktree-specific concern is: **a new child created while drilled has no `parentId` in `nodesRef.current`** (it was created at root-space). If a commit serialized the drilled set as-is, the new child would be persisted as a top-level node — orphaned from the worktree group — and on the next load it would render outside the frame, with `cwdForNewNodeIn` no longer resolving the worktree path for it (it has no worktree ancestor). 

The fix is the 07 merge path, and it **preserves parentId by construction**: before serializing, the drilled view's root-space children are merged back into the full `project.nodes` by (a) taking the full array as the base, (b) replacing each drilled group's direct children with their drilled-view versions, **re-nesting them** (restore `parentId: groupId`, `extent:'parent'`, and convert position back to group-relative via the inverse of `rootPosition` — subtract the group's root-space origin). A new child created while drilled is a drilled-group direct child, so it goes through this same re-nest: it gains `parentId = drill.groupId` and a group-relative position. The merge is a projection inverse, exactly symmetric to the `rootPosition` projection 07 uses on entry. After the merge, `flowToNodeStates(fullArray)` serializes the new child **nested under the worktree group**, so on exit/reload `cwdForNewNodeIn` walks `parentId → groupId → data.worktree.path` and the child inherits the worktree cwd as if it had been created in the nested view. **No special-casing for worktree groups** — the re-nest is the generic 07 mechanism; the worktree binding just makes the consequence of getting it wrong (wrong persisted cwd) more visible.

The simpler alternative 07 names — "exit the drill before any commit" — also works and is lower-risk: on any persist trigger while drilled, first flip `drill = {kind:'project'}` (running the reverse leg, which restores `parentId`/`extent`/nested-position for ALL drilled children including the new one), then `commitActiveToStore` serializes the restored full set unchanged. This needs no merge logic at all. **08 recommends the exit-before-commit strategy** as the implementation path: it is the 07 reverse leg (already built) reused as a commit preamble, it avoids a parallel merge code path that could drift from the reverse leg, and it guarantees `parentId` preservation because the reverse leg is the single, tested place that re-nests. The merge-then-serialize alternative remains available if a future async-commit needs to persist without a visible camera change.

### 3. Unbound-worktree adoption → 02→08→07 ordering (bind first, then drill)

Coherent and strictly ordered: an unbound worktree (one surfaced by `git worktree list` with no canvas group, ticket 02) has no node to drill into — `openNodeGroupAsCanvas` takes a group node. So:

1. **02 (bind)**: the adoptable row's "bind" action creates a group node with `data.worktree = worktreeFromEntry(entry, repoPath, baseRef)` (src/shared/worktree.ts:210-226, `createdByApp:false` for an adopted worktree) and re-runs `useWorktrees.getState().refresh()` so `reconcileWorktrees` sees the new binding. After bind, the worktree is a normal group-bound worktree — identical to one the app created.
2. **08 (drill)**: the now-bound group's header/chip offers "open as canvas" → `openNodeGroupAsCanvas(group)` (07). The DrillContext carries the `groupId` whose `data.worktree` the drilled-canvas header (section 1) reads. No 08-specific bind logic — 08 is the *drill* contract for a worktree-bound group, and binding is 02's job.
3. **07 (primitive)**: the isomorphism is the mechanism under both — `setNodes` with children at root-space, transient `DrillContext`, reverse leg restores `parentId`.

The ordering is a dependency chain, not a temporal one: 02 must *exist* for an unbound worktree to gain a group node; 08 must *exist* for that group to be drillable with worktree context; 07 is the primitive both lean on. An already-bound worktree (created via "New worktree…", `createdByApp:true`) skips 02 entirely and goes straight to 08's drill.

### 4. Sessions sidebar — worktree row drills via 07

Ticket 02 resolve-point 4: "a worktree row should drill into its canvas (via 07) when clicked, not just bind." The wiring:

- A **bound** worktree row (one with a canvas group) gets a click/affordance that calls `openNodeGroupAsCanvas(groupNode)` — the same entry point the canvas header's "open as canvas" uses. The sidebar resolves the group node from the project's nodes (it already knows the `groupId` — `buildSessionList` groups by worktree, and a bound worktree's bucket carries the group id). If the clicked worktree's project is not active, the click first switches projects (`setActiveProjectId`), waits for the load effect (Canvas.tsx:1746-1895) to install the project's nodes, then drills — the same cross-project-focus discipline `pendingFocusRef` uses (Canvas.tsx:1872-1891), but instead of `goToNode` it runs `openNodeGroupAsCanvas`. A `pendingDrillRef` alongside `pendingFocusRef` is the natural shape.
- An **unbound** worktree row's click is the 02 "bind" action (create group + `data.worktree`), after which the row becomes bound and the drill affordance appears — the 02→08 ordering from section 3.

This keeps 08 coherent with 02's adoptable-row contract: 02 owns discovery + bind, 08 owns the drill-through UX for bound rows. The sidebar does not get its own poller or status read — the drilled-canvas header (section 1) is what shows git status, and the sidebar row's own badge (if any) is the existing `useWorktrees` selector it already consumes.

### Summary of confirmations

- **Coexistence**: yes. `data.worktree` is the durable binding; the drill is a transient derived view. No migration, no dual-source drift, no new `NodeKind`.
- **Drilled-canvas header**: a canvas-level strip (outside `<ReactFlow>`'s z-trap), mounting on drill entry, carrying the back affordance + branch chip + Merge/Unbind/Remove, reusing `worktreeActionHandler` and `useWorktrees.refreshStatus` (visibility-gated, no IntersectionObserver, no new poller).
- **cwd inheritance**: `cwdForNewNodeIn` does NOT serve the drilled view unchanged (the group is absent from `nodesRef.current`); the drilled-canvas new-node path passes the worktree path as `cwdOverride` (existing funnel), reading `data.worktree.path` from the full `project.nodes` via the DrillContext. `addAgent` needs the same `cwdOverride` param added.
- **parentId preservation**: exit-before-commit (run the 07 reverse leg, which re-nests ALL drilled children including new ones with `parentId = groupId`, before `commitActiveToStore`) is the recommended path — no merge code, no drift, `parentId` preserved by construction.
- **02→08→07 ordering**: bind (02) creates the group node with `data.worktree`; drill (08) opens it as a canvas with worktree context; 07 is the isomorphism primitive. Strictly ordered, not temporal.
- **Sidebar drill**: bound worktree row → `openNodeGroupAsCanvas` (with a `pendingDrillRef` for the cross-project case); unbound row → 02 bind first.

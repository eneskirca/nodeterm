# 07 — Node-group ↔ canvas isomorphism (`openNodeGroupAsCanvas`)

Type: prototype
Status: resolved

## Question

Prototype the core primitive: a node-group and a canvas are two reversible views of the same thing. `openNodeGroupAsCanvas(group)` switches the active node-set to the group's children (reusing the existing fast canvas-switcher — the load effect at `Canvas.tsx:1743-1894`, which the feasibility assessment confirmed is "very close to a project-switch, just scoped to a group"); exit collapses back to the parent canvas where the group is seen as a node-group again. One mechanism, two directions.

This is the primitive that collapses several earlier decisions (per charter): worktree-as-canvas *coexists* with the `data.worktree` group-binding (ticket 08), project-as-node needs no new `NodeKind` (a project/worktree is a group carrying a reference — sidesteps the worst of the feasibility cost), and F11 focus is the degenerate single-node case (ticket 10).

Scope of the prototype (invoke `/prototype`):
1. The **group→canvas leg:** on `openNodeGroupAsCanvas(group)`, load the group's children as the active node-set (a sub-canvas with its own viewport/origin), reusing the canvas-switcher load path. Decide what "active node-set = a group's children" means in the single-active-project React Flow model — is the drilled group a transient active context, or a persisted navigable surface? The feasibility note: the project-switch load effect is the reusable mechanism, but scoping it to a group (not a project) is the new part.
2. The **canvas→group reverse leg (UNASSESSED — fog):** exiting the drilled canvas collapses back to the parent, showing the group as an in-place node-group again. This direction was never assessed by the feasibility study; the prototype must determine whether it's trivial (just switch back to the parent's node-set) or needs its own representation (e.g. a live embedded preview of the sub-canvas inside the group frame). Resolve it here.
3. **xterm/renderer continuity (fog):** a group containing terminal nodes, when opened-as-canvas, must keep those terminals alive across the switch. The parking primitive (`TerminalNode.tsx:2279-2283, 3439-3475`) proves an xterm element can move between hosts on unmount/remount — but a *live* canvas-switch reparent (where the terminal survives becoming the drilled canvas) is unverified. Determine whether the WebGL budget / glyphgrid renderer tolerates the host-size jump. **This is the load-bearing unknown**: if it can't, F11 (10) falls back to the overlay/co-attach path; the decision forks on this finding.
4. Decide whether the drilled sub-canvas gets its own viewport persisted (like a project does) or inherits/derives from the group's bounds.

Check `src/renderer/canvas/Canvas.tsx` (load effect 1743-1894, the single-active-project `useNodesState` at 721), `src/renderer/nodes/GroupNode.tsx`, `src/renderer/nodes/TerminalNode.tsx` (parking 2279-2283, 3439-3475; the mount-stable `useEffect` keyed on `[respawnNonce, offscreenEpoch]`; the WebGL budget coordinator + glyphgrid swap at 2265-2277), `src/renderer/lib/nodeFocus.ts` (viewport/fit, `absolutePosition`).

The prototype's findings graduate the fog (xterm continuity, reverse leg) and unblock 08, 09, 10.

Blocked by: —

## Answer

### The core finding (graduates the xterm-continuity fog — favorably)

A group→canvas switch is, at the React level, **a `setNodes` with a repositioned-but-same-id node-set for the group's children, minus the group's siblings**. It is NOT a project switch (which swaps every id). This is the fact the feasibility note was missing, and it makes the primitive *cheaper* than parking, not equal to it:

- **The group's own terminal children never unmount.** React Flow renders nodes through its internal node-types map keyed by `id`; updating a node's `position`/`parentId`/`extent` does not unmount the node component. The `TerminalNode` lifecycle effect is keyed on `[respawnNonce, offscreenEpoch]` (TerminalNode.tsx:~1210, ~1549) — **not** on position or parentId — so repositioning a child from nested-space to root-space re-runs no lifecycle effect. The xterm instance, its PTY subscription, its WebGL/glyphgrid grant, and its VT mode state all survive in place. No park, no re-adopt, no re-acquire, no host-size-jump risk to the renderer beyond what the existing `ResizeObserver`→`applyFit()` path already handles (a nested child going to root-space is just a resize).
- **Only the group's SIBLINGS (and the group frame itself) leave the node-set**, so only those unmount — and they park via the existing `TERM_PARK_MS` (5 min) primitive (TerminalNode.tsx:3439-3488). On exit they remount and adopt from park (TerminalNode.tsx:1545-1554). Siblings are usually not terminals-of-interest during a drill, so even a park miss (warm tmux reattach) is the well-trodden path.

So the fork the fog posed ("if xterm can't tolerate the live switch, F11 falls back to overlay/co-attach") **does not fork**: the live reparent is strictly easier than the already-shipped project switch, because the terminals you're drilling INTO stay mounted. F11 (10) inherits this — no overlay fallback is needed; F11 is just `openNodeAsCanvas(node)` where the node-set is `{node}∪nothing`, degenerate.

### Mechanism: `openNodeGroupAsCanvas(group)` — group→canvas leg

The existing load effect (Canvas.tsx:1746-1895) loads `nodeStatesToFlow(project.nodes)` into the single `useNodesState`. The isomorphism reuses that effect by changing **what `flow` is built from**, gated on a transient "drill context" — NOT a new project, NOT persisted:

```ts
// Transient navigable context (in-memory only — see "Persistence" below)
type DrillContext =
  | { kind: 'project' }                                   // the default today
  | { kind: 'group'; groupId: string; projectId: string } // openNodeGroupAsCanvas
```

- `openNodeGroupAsCanvas(group)` sets `drill = {kind:'group', groupId, projectId}` and rebuilds the flow as the group's direct children translated to **root-space** via the existing `rootPosition` helper (workspace.ts:918 — the exact function `ungroupNodes` uses to strip a node's parent offset; it walks the ancestor chain). Children keep their `id` (continuity) but lose `parentId`/`extent:'parent'` for the drilled view (they become top-level in the sub-canvas). Nested groups (a group inside the drilled group) stay nested — only the drilled group's *direct* children are promoted to the sub-canvas's top level, preserving the depth-first frame model.
- The load effect already handles the rest: `loadingRef.current = true` suppresses dirty-marking during the swap (Canvas.tsx:1814, 1911), `nodesRef`/`nodesProjectIdRef`/`committedRef` are reassigned atomically (Canvas.tsx:1821-1822, 1843), history resets (1844-1846), and the viewport restores/derives (below). `commitActiveToStore` (1966) and the commit guard `canCommitCanvas(nodesProjectIdRef.current, id)` (1972) still key on `projectId` — a drilled group writes back to its **owning project**, so persistence is unchanged (the group's children are already persisted under that project; drilling is a view, not a move).

### The reverse leg (canvas→group) — graduates this fog: trivial

Exiting the drilled canvas is `drill = {kind:'project'}` + rebuild the flow from the full `project.nodes` again. The group's children, which stayed mounted through the drill, get `parentId`/`extent:'parent'` restored and their positions re-nested (the inverse of `rootPosition` — apply the group's root-space origin as an offset, which the load path already does by reading persisted nested positions). They do not unmount. The siblings, which parked, remount and adopt. **No separate representation, no live embedded preview of the sub-canvas inside the group frame** — the group frame in the parent view is already the group node; the sub-canvas is just its children viewed at root-space. The reverse leg is the same `setNodes` mechanism, direction reversed.

This is the unassessed fog resolving trivially: the isomorphism is *one* `setNodes` call in each direction, distinguished only by whether children carry `parentId`. The "live embedded preview" alternative is explicitly rejected — it would re-introduce the dual-source drift the standing preference forbids (a preview is a second representation of the same children).

### Viewport for the drilled sub-canvas (resolves scope item 4)

**Derived, not persisted.** A group has no persisted viewport today, and adding one per-group would churn `project.json` for every drill. Instead: on `openNodeGroupAsCanvas`, `fitView({nodes: children})` frames the group's children (same `getFitViewNodes` measured-filter discipline as `goToNode` — Canvas.tsx / nodeFocus.ts). On exit, restore the **parent canvas's** last viewport (stashed in a ref when drilling, since the parent's `project.viewport` is only re-read on a real project load). The drilled view is a transient camera, like a `goToNode` framing that the user can then pan away from — it does not survive a restart, and that is correct (a drill is navigation, not a saved surface). If a per-group viewport is later wanted, it is a graduation off this, not a prerequisite.

### Persistence / navigability (resolves scope item 1)

The drill context is **transient and in-memory**, not a persisted navigable surface. Rationale: a drilled group is a *view* of children that are already persisted under their owning project; persisting a "current drill" would (a) add a field to `project.json` that churns on every navigation and (b) create the dual-source drift the standing preference forbids (the persisted drill vs. the live `useNodesState`). On restart / project reload, you land on the project's top-level canvas (the group seen as a frame), exactly as today. Drill is re-entered by re-invoking `openNodeGroupAsCanvas`. This also means `CanvasMutation`/`commitCanvas` need NO change for 07 — a drilled view commits to the same `projectId` it always did; the children's nested positions are what's persisted, and they are identical whether viewed nested or drilled (root-space is a projection of nested-space, computed on the fly by `rootPosition`).

### What still needs a real prototype (implementation, not design)

The design is resolved. The remaining work is build-time verification, not decision:
1. Confirm React Flow preserves the node component across a `parentId` removal+re-add with no intermediate unmount (core RF behavior, but the `extent:'parent'`→`undefined` transition is the one to actually run — it should not trigger a re-mount, but the prototype must show it, since RF's `extent` clamping could in principle re-measure).
2. Wire the `DrillContext` into the load effect's `flow` construction and a breadcrumb/exit affordance (Esc or a "← back to <project>" chip) — pure renderer, no core change.
3. Verify the atomic ref-reassignment (Canvas.tsx:1821-1822) holds when `projectId` is unchanged but the node-set narrows (the commit guard reads `nodesProjectIdRef`, which stays the same — confirm a drilled edit doesn't accidentally commit the *narrowed* set as the whole project; it must commit the full `project.nodes` with the edited child merged back, i.e. the drill is a projection for *viewing* but commits must merge against the full node array, not `nodesRef.current`). **This is the one genuine implementation hazard**: `commitActiveToStore` today serializes `nodesRef.current` as the project's nodes. A drilled view's `nodesRef.current` is the *subset*. The commit path must reconstruct the full array (replace the drilled group's children in the full set) before serializing — or, simpler, exit the drill before any commit. The prototype picks one; the clean answer is "drill is view-only for commits; a commit while drilled merges the drilled children back into the full `project.nodes` then serializes."

### Decisions locked

- **xterm continuity:** the group's own terminals stay mounted across the switch (no park, no re-acquire); only siblings park. F11 (10) needs no overlay fallback.
- **Reverse leg:** trivial — same `setNodes`, restore `parentId`. No embedded preview (rejects dual-source drift).
- **Viewport:** derived (`fitView` on entry, stashed parent viewport on exit), not persisted.
- **Persistence:** drill context is transient/in-memory; commits go to the owning project, merging drilled children back into the full node array. `CanvasMutation` unchanged.
- **Unblocks:** 08 (worktree-as-canvas coexists — the drilled view of a worktree-bound group IS the worktree's canvas, no migration), 09 (canvas-of-canvases drills via `xnode` endpoints), 10 (F11 = degenerate single-node drill).

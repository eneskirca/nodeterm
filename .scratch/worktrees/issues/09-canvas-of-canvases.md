# 09 — Canvas-of-canvases (fog-gated)

Type: grilling
Status: resolved
Fog-gated: ~~this ticket does not resolve until 01 (Link/Endpoint model) and 07 (isomorphism) settle; its endpoint shape and drill target inherit from them.~~ UNBLOCKED 2026-08-19 — 01 and 07 resolved; see Answer.

## Question

Design the cross-project application of the isomorphism: a top-level "canvas of canvases" where each node-group *references* another project's canvas (via a cross-project `Link`/`Endpoint` from ticket 01), drillable via `openNodeGroupAsCanvas` (ticket 07). Projects and worktrees appear as nodes on one canvas, linkable to each other; submodules auto-link.

Settled (from charter, Q19-final=a): this is **fog-gated**, not an upfront commitment. It genuinely hangs off two unresolved tickets — the `Link`/`Endpoint` model (01) and the isomorphism (07) — because its endpoint shape (how a group references another project's canvas) and its drill target (what `openNodeGroupAsCanvas` loads for a cross-project reference) both come from them. Designing it now means guessing those shapes.

Resolve (only once 01 and 07 are resolved):
1. The cross-project group reference: a group on the top canvas carries a reference to another project (via a cross-project `Endpoint` — `{projectId}` or `{projectId, nodeId}` per 01's settled shape). `openNodeGroupAsCanvas` on it loads that project's canvas (reusing 07's mechanism, crossing the project boundary — the canvas-switcher already switches projects, so this is "drill = switch project"). Confirm the single-active-project React Flow model tolerates a cross-project drill (it's the existing project switch, just triggered from a node).
2. **Project-as-node needs no new `NodeKind`** (charter consequence): a project/worktree is a group carrying a reference, not a new `kind:'project'` node. This sidesteps the feasibility study's "large schema change" verdict — confirm it holds once 01's endpoint shape is fixed.
3. **Submodule auto-link:** when a project's repo has git submodules, auto-create cross-project `Link`s to the submodule projects (if open). Git plumbing (`git submodule status`, `.gitmodules`) is reachable via the existing `GitExecutor` pattern (`worktree-ops.ts` `listWorktrees`/`repoRoot` is the template); project-lookup-by-`cwd` exists (`openFolderProject`). Decide the trigger (on project open) and the UX (auto-link open submodule projects; suggest, don't create nodes for unopened ones).
4. Whether the top canvas is a special "meta-project" (a real `Project` whose nodes are project-references) or a view derived from the workspace. The feasibility study flagged that a meta-project "breaks the invariant that everything is a Project" — decide which side of that line this lands once 01/07 are known.

Invoke `/grilling` and `/domain-modeling` when unblocked. Check `src/renderer/state/projects.ts` (`openFolderProject` cwd-dedupe — the submodule→project resolver), `src/shared/worktree-ops.ts` (template for `listSubmodules`), `src/renderer/canvas/Canvas.tsx` (project-switch load effect 1743-1894).

Blocked by: 01, 07

## Answer

Resolved after 01 (Link/Endpoint model) and 07 (isomorphism) landed. The fog-gate is lifted; the four points are decided concretely against the real code.

### 1. Cross-project drill IS the existing project switch (new `DrillContext` variant)

The single-active-project React Flow model in `Canvas.tsx` (the load effect at lines 1746–1895, keyed on `[activeProjectId, reloadNonce, …]`) already tolerates a cross-project drill because a cross-project drill **IS a project switch** — the same `setActive(id)` → load-effect path the tab bar and ⌘K use, just triggered from a node click instead of a tab. The load effect sets `nodesProjectIdRef.current = project.id` (line 1822) and `setNodes(nodeStatesToFlow(project.nodes))` (lines 1815–1816), so the target project's canvas replaces the current one exactly as a tab switch does. There is no second `useNodesState` and no dual-source hazard — the "single live source of truth for the active project's nodes" invariant from CLAUDE.md is preserved because the active project simply changes.

This needs a third `DrillContext` variant distinct from 07's in-project group drill:

```ts
type DrillContext =
  | { kind: 'project' }                              // 07: the owning project (no drill)
  | { kind: 'group'; groupId: string; projectId: string }  // 07/08: drill into a group's children within the current project
  | { kind: 'project-ref'; projectId: string }      // 09: drill into a REFERENCED project's whole canvas
```

`{kind:'project-ref'; projectId}` is the cross-project leg. It differs from `{kind:'group';…}` in two load-bearing ways:

- **No merge-back.** 07/08's in-project group drill keeps the drilled children inside the owning project's `project.nodes` and commits go to the owning project (the drilled view is a transient derived projection of the same `projectId`). A `project-ref` drill **switches the active project** — `useProjects.getState().setActive(targetId)` — so commits naturally land in the TARGET project via the existing `commitCanvas(id, …)` path (projects.ts line 387). There is nothing to merge back because the user is literally editing the other project's canvas. This is the simplification the ticket asks to confirm: the commit-while-drilled hazard from 07/08 **does not arise** for a cross-project drill. The back leg (returning to the originating canvas) is a plain project switch back to the source project id, recorded in the DrillContext's caller (a nav stack, not a persisted field — the drill is transient by 07's contract).
- **`cwdOverride` is not needed.** 08 passes `cwdOverride` from `project.nodes` because the drilled group is absent from `nodesRef` while drilled. A `project-ref` drill loads the target project's OWN `project.nodes` in full, so every group/terminal resolves its cwd from its own serialized state — no external lookup.

`openNodeGroupAsCanvas(group)` from 07 gains one branch: if the group carries a `data.projectRef` (point 2 below), the handler calls `useProjects.getState().setActive(ref.projectId)` instead of promoting the group's children. The load effect does the rest. The drilled group's own terminals (if any live on the source canvas) park per 07's `parkedTerminals` — the project switch unmounts `TerminalNode`s, which already parks rather than kills (CLAUDE.md terminal lifecycle).

### 2. Project-as-node = a `group` with `data.projectRef` (no new `NodeKind`)

Confirmed: the charter consequence holds now that 01's endpoint shape is fixed. A project/worktree is a **`kind: 'group'` node carrying `data.projectRef?: { projectId: string }`** on `CanvasNodeState` — NOT a `kind: 'project'` node. `NodeKind` (types.ts line 194) is unchanged. This sidesteps the feasibility study's "large schema change" verdict: the only schema delta is one optional field on the existing `CanvasNodeState` (beside the existing `worktree?: GroupWorktree` at line 294 — same shape, same opt-in).

**Recommendation: `data.projectRef` on the group node, NOT a standalone `xnode` link.** Justification:

- **Rendering needs the node.** A project-reference must render as a frame on the canvas (with a project badge — name, color, monogram from the referenced `Project`). A `Link` from 01 is an edge, not a node; an edge with an `xnode` target describes a *relation* between two existing nodes, not a visible object. To show "project A" as a thing on the meta-canvas you need a node, and the group node already renders a frame with a label pill and color (CLAUDE.md GroupNode). The `xnode` `Endpoint` from 01 (`{ref:'xnode'; projectId; nodeId}`) is the reference shape a LINK uses to point at a node in another project; it is not itself a renderable. Using it standalone would require inventing a phantom node anyway.
- **The group frame is the right visual.** A project-as-node is conceptually a container you can drill into — exactly what a group frame already is. `data.projectRef` upgrades a group from "frame around local children" to "frame that drills into another project," and the same `openNodeGroupAsCanvas` entry point handles both (branch on `data.projectRef`).
- **Links still use `xnode` for cross-project relations.** The `xnode` endpoint from 01 remains the way a LINK (context/lineage/dependency) points at a node inside another project. The project-reference NODE (`data.projectRef`) and the cross-project LINK endpoint (`xnode`) are complementary: the node is the visible frame; the link is a relation between two nodes, which may live in different projects. A submodule auto-link (point 3) is a `dependency` link whose source is a node in project A and whose target is an `xnode` in the submodule project B — it does not need the project-reference group at all, though the auto-linker may also create project-reference groups on a meta-canvas (point 4).
- **`data.projectRef` is validated at the interpolation site, like `worktree`.** A `projectId` is a hand-editable string from git-shared JSON; `openNodeGroupAsCanvas` and the render badge must treat an unresolvable ref as "unavailable" (point 4), never as a crash. Same discipline as `SAFE_SESSION_ID` / `isPermissionMode` (CLAUDE.md): re-validate, never trust the type.

The field is added to `CanvasNodeState` (types.ts ~line 294, beside `worktree?`):

```ts
/** group-only: when set, this frame REFERENCES another project's canvas (drill = switch project).
 *  The group may also hold local children (rendered on the source canvas); drilling loads the
 *  referenced project. Unresolvable → greyed "unavailable project" (lazy-prune, point 4). */
projectRef?: { projectId: string }
```

### 3. Submodule auto-link: `dependency` kind, trigger on meta-canvas open, suggest-for-unopened

**Git plumbing — `listSubmodules` (new, mirrors `listWorktrees`):** a new helper in `src/shared/worktree-ops.ts` (or a sibling `submodule-ops.ts`) using the same `GitExecutor` pattern (`worktree-ops.ts` lines 10–12, 94–109). It runs `git submodule status --recursive` (porcelain, one line per submodule: `<sha> <path> (<desc>)`) or parses `.gitmodules` as a fallback (same stat-the-path discipline as `listWorktrees`' `pathExists` — a submodule directory deleted behind git's back must read as `prunable`, not healthy). Returns `{ ok: boolean; entries: { path: string; url: string; sha: string }[] }` — `ok:false` is "git could not be read," never collapsed to `[]` (the exact rule `listWorktrees` enforces at line 99/101 and its docstring at lines 82–93). Exposed over the existing `GitApi` IPC surface beside `worktreeList` (types.ts line 1559) as `submoduleList(repoPath)`.

**Project lookup — `openFolderProject` (projects.ts line 260):** the cwd-dedupe is the submodule→project resolver. Each submodule's absolute path (repo root + submodule relative path) is resolved to a project via `useProjects.getState().projects.find(p => p.cwd === submoduleAbsPath)` — the same lookup `openFolderProject` does at line 261. A submodule whose cwd matches an OPEN project is a candidate for an auto-link; a submodule with no open project gets the suggest-don't-create treatment (below).

**Link kind — `dependency` (recommend, not a new meta):** A's repository *depends on* the submodule at that path — that is a build/resolve dependency, which is exactly what 01's `LinkKind = 'context' | 'lineage' | 'dependency'` models. A new submodule-specific kind would be a fourth `LinkKind` for one cause, and 01's charter already committed to three. `dependency` is the honest semantic: A cannot build without the submodule. (The alternative — `context` — would mean "A's agents read the submodule's transcript," which is a different feature and not what a submodule relationship asserts.) The auto-link's `source` is an `Endpoint` `{ref:'node'; nodeId:<a node in project A>}` (or the project-reference group itself) and its `target` is an `Endpoint` `{ref:'xnode'; projectId:<submodule project id>; nodeId:<a node in the submodule project>}` — the `xnode` endpoint from 01, crossing the project boundary.

**Trigger — on meta-canvas open (not on every project open):** running `listSubmodules` on every project open is wasted git churn for users who never use the meta-canvas. The auto-linker runs when the meta-canvas (point 4) becomes active AND one of its project-reference groups is for a repo with submodules. Concretely: the meta-canvas's load effect (the same `useEffect([activeProjectId, reloadNonce])` at Canvas.tsx 1746) calls `submoduleList(metaProjectRepoCwd)` for each project-referenced group whose project has a `cwd`, resolves submodules to open projects via `openFolderProject`'s lookup, and upserts `dependency` links into the meta-project's `project.bridges` (the existing `BridgeLink[]` that `commitCanvas` writes, projects.ts line 91). Upsert is idempotent (link id derived from `(sourceProjectId, submodulePath)`), so re-opening the meta-canvas does not duplicate.

**UX — auto-link open submodule projects; suggest (don't create) for unopened:**
- **Open submodule project → auto-create the `dependency` link** to it (and, if the meta-canvas has no project-reference group for it yet, auto-create one — a `kind:'group'` with `data.projectRef` — so the link has a visible endpoint). This is the "if open" clause from the ticket.
- **Unopened submodule → suggest, do not create.** A submodule whose cwd matches no open project gets a non-persistent hint on the meta-canvas (a ghost group or a banner row: "submodule `<path>` has no open project — Open folder?"). Clicking runs `openFolderProject(submoduleAbsPath)` (projects.ts line 260), which creates the project, then the auto-linker runs again and promotes the suggestion to a real link + group. The suggestion is DERIVED (runtime-only, never persisted into `project.nodes`), mirroring the `subagent`/`loop` ephemeral-node pattern (CLAUDE.md: "render-only, never persisted") — a suggestion is not a canvas edit and must not dirty the meta-project.

### 4. Meta-project IS a real `Project` (dangling refs lazy-prune + grey "unavailable")

**Decision: the top canvas is a real `Project` (a meta-project) whose group nodes carry `data.projectRef`.** The feasibility study's worry — "a meta-project breaks the invariant that everything is a Project" — is inverted: a meta-project IS a Project, so the invariant "everything is a Project" is **preserved**, not broken. The worry was about a non-Project surface (a derived view with its own render path), and this is not one.

Justification against the derived-view alternative:

- **No dual-source drift.** A derived view (computed from the workspace's project list) would need its own serialize/commit path — a second source of truth beside `project.nodes`, which CLAUDE.md explicitly rejects ("React Flow is the single live source of truth… earlier dual-source designs caused sync bugs"). A meta-project commits through the SAME `commitCanvas(id, nodes, viewport, bridges, ropes)` (projects.ts line 387) every other project uses, saves to the same `.nodeterm/project.json` via `workspace.save`, and hydrates through the same `nodeStatesToFlow` load. Zero new persistence plumbing.
- **The isomorphism + commit model keys everything on a `projectId`.** 07's drill, 08's `cwdOverride`, the load effect's `nodesProjectIdRef`, the worktree store's epoch guard, the presence `reportProject` — all take a `projectId`. A derived view has no `projectId` and would have to invent one (a pseudo-id that breaks every consumer that assumes a real `Project`), or fork each consumer. A meta-project has a real `id` and slots into all of them unchanged.
- **The meta-project is just a project whose nodes happen to be project-references.** Its `nodes` are ordinary `CanvasNodeState` (`kind:'group'` with `data.projectRef`), its `bridges` hold the `dependency` links from point 3, its `viewport` persists the user's camera on the meta-canvas. It is created with `addProject(name, cwd)` (projects.ts line 254) or, better, a dedicated factory that sets no `cwd` (the meta-canvas has no single working directory — its groups reference disparate repos). It appears as a tab, reorders with `reorderProject`, closes with `closeProject`, and is exportable/shareable like any project. A user can have zero or several meta-projects.

**Dangling reference handling (the hazard):** a meta-project's `data.projectRef.projectId` points at another project by id. Deleting or renaming (re-keying) the referenced project leaves a dangling ref. Handling mirrors two existing patterns:

- **Lazy-prune (01's unresolvable `xnode` targets):** when the meta-project loads, each `data.projectRef` is resolved against `useProjects.getState().projects`. A ref whose `projectId` matches no project is left in place but rendered as a greyed **"unavailable project"** node — the EXACT pattern CLAUDE.md's persistence section describes for unavailable tabs ("Unreadable refs render as greyed unavailable tabs (never dropped)"). The node is not auto-deleted: the user may re-open the referenced folder (`openFolderProject`), which restores the project under the SAME id (ids are cwd-derived and stable — `derivedProjectId`, projects.ts line 218), making the ref resolve again. Auto-deleting would lose the user's layout the moment a tab is closed.
- **Greyed node = the existing `setProjectUnavailable` idiom (projects.ts line 334), extended to nodes.** The node's `data.projectRef` resolves to `undefined` → the `GroupNode` renderer shows a grey frame with "unavailable project" and no drill action (the `openNodeGroupAsCanvas` handler refuses when `useProjects.getState().getProject(ref.projectId)` returns undefined — the same guard the load effect uses at line 1766). The ref is re-evaluated on every meta-project load (cheap — one `projects.find` per group), so reopening the referenced folder immediately un-greys it.
- **Renamed (re-keyed) projects.** A project id is derived from its cwd (`derivedProjectId`, used by `withUniqueIds` at line 218 and `adoptProject` at line 301), so a project does not get a new id unless its cwd changes — and a cwd change is a different project by design ("Two folders holding the same committed canvas are two independent projects," CLAUDE.md). So a "rename" of a project (its display name, `renameProject` line 316) does NOT re-key it; only a folder move does, and that is correctly a new project. The dangling case is therefore only true deletion (`deleteProject`, line 510), and lazy-prune + greyed-node is the honest UX for it.

### Summary of the four points

1. **Cross-project drill** = the existing project switch (load effect, `setActive`), triggered from a `data.projectRef` group via `openNodeGroupAsCanvas`. New `DrillContext` variant `{kind:'project-ref'; projectId}`. No merge-back (commits go to the target project); no `cwdOverride` (target's own `project.nodes` is loaded in full).
2. **Project-as-node** = `kind:'group'` + `data.projectRef?: {projectId}` on `CanvasNodeState` (beside `worktree?`). No new `NodeKind`. Chosen over a standalone `xnode` link because a project-reference must RENDER as a frame, and a link is an edge not a node; `xnode` links remain the way cross-project relations point at nodes.
3. **Submodule auto-link** = `dependency` kind (A depends on the submodule). New `listSubmodules` via the `GitExecutor` pattern (`worktree-ops.ts` template), exposed as `submoduleList` IPC. Trigger on meta-canvas open (not every project open). Open submodule project → auto-create `dependency` link (+ project-ref group if absent); unopened → derived ghost suggestion (never persisted), click runs `openFolderProject`.
4. **Meta-project is a real `Project`** — preserves "everything is a Project," reuses `commitCanvas`/`workspace.save`/load effect unchanged (no dual-source drift, no pseudo-id). Dangling `data.projectRef` (deleted project) → lazy-prune + greyed "unavailable project" node (mirrors unavailable-tab pattern + 01's unresolvable `xnode`); re-resolved on every load; not auto-deleted (reopening the folder restores the same id).

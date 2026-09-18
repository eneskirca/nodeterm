# 02 — Repo-root Session grouping with repo≡project collapse + worktree discovery

Type: task
Status: resolved

## Question

Rebuild the Sessions sidebar grouping (`src/renderer/lib/sessionList.ts` `buildSessionList`, `src/renderer/components/SessionsSidebar.tsx`) so that the grouping key is the **git repo root**, and all of a repo's worktrees are discovered — not only the ones bound to canvas group nodes.

Settled (from charter, Q4/Q7/Q8/Q9/Q21):
- **Grouping hierarchy:** `repo → group(worktree) → session`. The **repo and project levels collapse into one** when `cwd === repoRoot`; the project re-appears as a sub-bucket only when multiple projects share a repo (e.g. main + a worktree opened as its own folder). Sessions not in a worktree sit directly under the repo/project root level.
- **Worktree discovery:** run `git worktree list` (or `git.repoRoot` + `listWorktrees` in `src/shared/worktree-ops.ts`) against a project's repo; surface **all** worktrees, including those with no bound canvas group node. Bound worktrees show as the existing group buckets; **unbound worktrees show as adoptable rows** — click to **bind** (create a group node, reusing the WorktreeDialog `bind` intent) or **open** (jump to its path). No canvas node is auto-created for an unbound worktree (auto-creating would litter the canvas).
- **Subdirectory-`cwd` projects:** when a project's `cwd` is a subdirectory of a repo (not the root), it still nests under the repo root (Q7=a) — no fallback to project grouping.

Resolve:
1. The exact grouping function: when does repo≡project collapse vs. split? The rule is "`cwd === repoRoot` → one level; else repo → project." Implement and pin with tests (`sessionList.ts` has existing test coverage to extend).
2. How unbound-worktree discovery is triggered and kept fresh: the worktree store (`src/renderer/state/worktrees.ts`) already reconciles bound groups against `git worktree list` via `reconcileWorktrees` (`src/shared/worktree-reconcile.ts`) and has a status poll. Extend it to surface unbound entries; decide the refresh cadence (don't introduce a third independent poller — the worktree store is the single caller of worktree read IPCs by design).
3. The adoptable-row UI: reuse `WorktreeDialog`'s `bind` intent. Decide whether "open" (jump to path) is meaningful without a bound node — possibly it opens the folder in the OS explorer until bound, or is deferred until binding exists.
4. Interaction with the isomorphism (ticket 07): once worktree-groups can be opened-as-canvas, the sidebar's worktree row should drill into that canvas. Keep the grouping decision independent of the isomorphism landing; wire the drill-through when 07 resolves.

Check `src/renderer/lib/sessionList.ts` (the `buildSessionList` `Project → GroupBucket → session` shape), `src/shared/worktree-ops.ts` (`listWorktrees`, `repoRoot`), `src/shared/worktree-reconcile.ts`, `src/renderer/state/worktrees.ts` (single-store/single-poller invariant — do NOT add a competing poller).

Blocked by: —

## Answer

### 1. The grouping function: repo≡project collapse vs. split

The current `buildSessionList` (`src/renderer/lib/sessionList.ts:290-369`) returns `SessionGroup[]` — a flat array keyed one-per-`ProjectInput`. Each `SessionGroup` holds `groups: GroupBucket[]` (canvas group frames) and `ungrouped: SessionRowVM[]` (sessions not inside any frame). The hierarchy today is `project → group(frame) → session`.

The redesign introduces a **repo level above the project level**. The data returned by `buildSessionList` changes shape from `SessionGroup[]` to `RepoGroup[]`:

```ts
/** One repo's projects and their sessions, keyed by the resolved git repo root. */
export interface RepoGroup {
  /** Normalized repo root (the `repoRoot` git reports for every project that maps here), or
   *  the project cwd when the project is not a git repo (no repo → degenerate repo-of-one). */
  repoRoot: string | null
  /** Display label: the repo's folder name when there is one, else the single project's name. */
  repoName: string
  /** True when exactly one project maps to this repo AND that project's cwd === repoRoot.
   *  The sidebar renders the repo header and the project header as ONE row in this case.
   *  When false (multiple projects share the repo, or a project's cwd is a subdir of the repo),
   *  the project headers render as a second level under the repo header. */
  collapsedProject: boolean
  /** The projects that share this repo, in store order. When `collapsedProject` is true this
   *  is always length 1 and the sidebar skips the project-header row. */
  projects: SessionGroup[]
}
```

**The collapse rule, pinned precisely:**

- **Collapse** (`collapsedProject: true`): exactly one project maps to this repo root AND `normPath(project.cwd) === normPath(repoRoot)`. The sidebar renders a single header row (the repo name + branch chip + signals aggregated from the one project's sessions) and the project's `groups`/`ungrouped` hang directly under it. `SessionGroup.projectId`/`projectName`/`projectColor` are still carried for callbacks (`onFocusNode`, `onCloseSession`, etc.) — the collapse is purely visual, the project identity is not lost.

- **Split** (`collapsedProject: false`): either (a) two or more projects share the same repo root, or (b) the single project's `cwd` is a subdirectory of the repo root (`normPath(repoRoot) === prefix of normPath(cwd)` but not equal). The sidebar renders the repo header, then a project-header row for each `SessionGroup` under it. Case (b) is the Q7=a decision: a project whose cwd is `repoRoot/packages/foo` still nests under `repoRoot`, not as its own top-level repo.

- **Degenerate (no repo):** a project whose `cwd` is not a git repo (`repoRoot` resolves to `null`) forms its own `RepoGroup` with `repoRoot: null` and `collapsedProject: true`. The repo header shows the project name (there is no repo name to show). This is the fallback for cwd-less projects too.

**The grouping function signature:**

```ts
export function buildSessionList(
  projects: ProjectInput[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusById: Record<string, AgentNodeStatus>,
  filter: string,
  /** NEW: per-project resolved repo root, keyed by projectId. The caller (SessionsSidebar)
   *  obtains these from the worktree store — see point 2. Projects not in the map (a repoRoot
   *  not yet resolved, or a cwd-less project) get `null` and form a degenerate RepoGroup. */
  repoRootByProject: Record<string, string | null | undefined>
): RepoGroup[]
```

The function first partitions projects into `SessionGroup`s exactly as today (the existing per-project `buildBucket`/`ungrouped` logic is unchanged — lines 300-364), then groups those `SessionGroup`s by their `repoRootByProject[p.id]` (normalized via `normWorktreePath` from `worktree-reconcile.ts:24` — the same trailing-slash-normalizer the worktree store already uses, so `buildSessionList` and `useWorktrees` can never disagree about path identity). Within each `RepoGroup`, projects stay in store order. The filter (`needle`) applies across the whole `RepoGroup`; a `RepoGroup` is kept when any session in any of its projects matches (mirroring the existing `groups.filter` at line 368, lifted one level up).

**Tests to add** (extend `sessionList.test.ts`):
- One project, `cwd === repoRoot` → `collapsedProject: true`, one `RepoGroup`.
- Two projects, same `repoRoot` → one `RepoGroup`, `collapsedProject: false`, two `SessionGroup`s in store order.
- One project, `cwd` is a subdir of `repoRoot` → one `RepoGroup`, `collapsedProject: false` (the project is a sub-bucket under the repo, Q7=a).
- Project with no repo (`repoRoot: null`) → degenerate `RepoGroup`, `collapsedProject: true`, `repoName` = project name.
- Filtering keeps a `RepoGroup` when any session matches across its projects.

**Disclosure keys:** `repoCollapseKey(repoRoot)` = `repo:<repoRoot>` (or `repo:__norepo__:<projectId>` for the degenerate case, since two cwd-less projects must not share a key). `projectCollapseKey` and `groupCollapseKey` stay as-is — they nest under the repo key. `liveCollapseKeys` walks the new `RepoGroup[]` tree. `pruneCollapsedItems` prunes `repo:*` keys the same way it prunes `project:*` keys today.

### 2. Worktree discovery without a third poller

The worktree store (`src/renderer/state/worktrees.ts:125-279`) is the **single caller** of `git.repoRoot` / `git.worktreeList` by design (CLAUDE.md: "One store, one poller"). It already resolves `repoRoot` and `entries` (all worktrees from `git worktree list`) for the **active project** and reconciles them against bound groups via `reconcileWorktrees` (`worktree-reconcile.ts:37-55`), producing `orphans: WorktreeEntry[]` — worktrees on disk that no group is bound to.

The key insight: **the store already discovers unbound worktrees.** `reconcileWorktrees` returns `orph` exactly as `WorktreeEntry[]` (line 50-52: `present.filter(e => norm(e.path) !== norm(mainCheckout) && !boundPaths.has(norm(e.path)))`). These are the adoptable worktrees. The store exposes them as `useWorktrees(s => s.orphans)` (already consumed in `Canvas.tsx:968`).

**The extension seam** is narrow — the store already has the data, it just needs to reach `buildSessionList`:

1. **Per-project repo roots, not just the active one.** Today `useWorktrees` holds `repoRoot`/`entries`/`orphans` for the **active project only** (it is reset on every project switch, line 269-278, and `refresh` is called only for the active project's cwd, Canvas.tsx:1831). For the sidebar to group ALL open projects by repo, it needs the repo root for every open project, not just the active one. **Extend `useWorktrees` with a `repoRootByProject: Record<string, string | null>` map** that is populated alongside the active-project `refresh` and is **NOT reset on project switch** (only the active-project-specific fields — `entries`, `orphans`, `staleGroupIds`, `statusByPath` — are reset). The map is filled by a lightweight one-shot `git.repoRoot(p.cwd)` per project on first sight (and re-resolved on a `refresh` for the active project). This is a single `git rev-parse --show-toplevel` per project — cheap, no `worktree list` — and runs inside the existing `refresh` flow, not a new poller.

2. **Unbound-worktree surfacing for the active project.** The active project's `orphans` are already fresh (reconciled on every `refresh`, line 192). The sidebar reads `useWorktrees(s => s.orphans)` and maps each `WorktreeEntry` to an adoptable row under the active project's repo group. For **non-active projects**, orphans are not separately resolved (the store does not run `worktree list` for them). This is acceptable: the sidebar shows adoptable rows for the active project's repo (where the user is working), and non-active projects show their bound groups only. A non-active project's unbound worktrees appear when it becomes active — the `refresh` on load resolves them. This matches the existing cadence discipline (CLAUDE.md: ambient information gets an ambient cadence; the active project is where the user acts).

3. **Freshness.** The store's existing refresh triggers cover it: project load (Canvas.tsx:1831), node mutation (`refreshWorktreeStore`, Canvas.tsx:2856-2868), bind/unbind (Canvas.tsx:4199, 4331). No new timer. The `WORKTREE_STATUS_POLL_MS` (20s) poll for bound-group status does NOT touch orphans — and it should not: orphans are structural (a worktree appearing/disappearing), not status (dirty files), so they ride the `refresh` path only. Adding a timer for orphan discovery would violate the single-poller invariant.

**The store extension (concrete seam in `worktrees.ts`):**

```ts
// New field on WorktreesState (worktrees.ts:51-73):
repoRootByProject: Record<string, string | null>

// In refresh() (worktrees.ts:132-213), after `const root = await git.repoRoot(projectCwd)`:
//   set((s) => ({ repoRootByProject: { ...s.repoRootByProject, [activeProjectId]: root } }))
// The map survives reset() — reset() clears active-project fields only, not repoRootByProject.
// A separate one-shot resolver for non-active projects runs in SessionsSidebar's mount effect
// (fire-and-forget `git.repoRoot(p.cwd)` per project, writing into repoRootByProject).

// In reset() (worktrees.ts:269-278): do NOT clear repoRootByProject. Only clear
// repoRoot/entries/orphans/staleGroupIds/statusByPath (the active-project fields).
```

The one-shot non-active resolver is a **read IPC** (`git.repoRoot`), not a `worktree list`, so it does not compete with the worktree store's `listWorktrees` ownership — it is the same class of call the sidebar already makes for branch chips (SessionsSidebar.tsx:112-133, `api.git.status` per project). It writes into `useWorktrees.setState({ repoRootByProject })`, which is the store the sidebar already subscribes to.

### 3. The adoptable-row UI

Each unbound worktree (`WorktreeEntry` from `useWorktrees(s => s.orphans)`) renders as a row under its repo group, visually distinct from session rows (dashed border, a "branch" chip, no status badge — it has no session). Two actions:

- **Bind** (primary): reuses `WorktreeDialog`'s `bind` intent exactly. The dialog's `onBindExisting(entry)` (WorktreeDialog.tsx:31, 135) calls `bindExistingWorktree` (Canvas.tsx:4249-4271), which calls `worktreeFromEntry(e, repoRoot, resolveBaseRef(entries))` (worktree.ts:210-226 — `createdByApp: false`, so Remove will never delete a directory the user made) and `attachWorktree(target, wt)` (Canvas.tsx:4177-4205), which creates a group node (or binds to an existing one) and calls `refreshWorktreeStore({ bind })`. The adoptable row's "Bind" action opens `WorktreeDialog` with `intent: 'bind'` and the entry pre-selected, or — to skip the dialog entirely for a one-click bind — calls `bindExistingWorktree` directly (the dialog's existing-worktrees list is the discovery surface; the sidebar row is a shortcut to the same callback). The clean contract: the row's Bind button calls `attachWorktree({ groupId: null, at: <row position> }, worktreeFromEntry(entry, repoRoot, resolveBaseRef(entries)))` — the same `attachWorktree` Canvas already exports. No new Canvas method; the row just needs `attachWorktree` + the store's `repoRoot`/`entries` (for `resolveBaseRef`).

- **Open** (secondary): **deferred until bound.** "Open = jump to path" is not meaningful pre-binding because there is no canvas node to focus and no tmux session to attach. Opening the folder in the OS explorer (`shell.reveal` / `shell.openPath`) is the one useful pre-bind action, but it is desktop-only (Server Edition has no `shell.reveal` — it degrades to `E_UNSUPPORTED`). Decision: the adoptable row shows **only "Bind"** pre-binding; after binding, the row becomes a normal group-frame row (the bound `GroupBucket`) and inherits the existing click-to-focus behavior. An "Open in Finder" affordance can be added later as a non-load-bearing nicety, but it is not part of the v1 contract — the row's job is to surface the worktree and let the user bind it.

**The adoptable-row contract:**

```ts
/** A worktree on disk with no bound canvas group. Rendered under its RepoGroup. */
export interface AdoptableWorktreeRow {
  kind: 'adoptable-worktree'
  /** The WorktreeEntry from `useWorktrees(s => s.orphans)`. */
  entry: WorktreeEntry
  /** The repo root this worktree belongs to (for `worktreeFromEntry`). */
  repoRoot: string
  /** The base ref (main checkout's branch) for `worktreeFromEntry`. */
  baseRef: string
}
```

This row type is carried in `RepoGroup` alongside `projects` — either as a separate `adoptable: AdoptableWorktreeRow[]` field or interleaved into the repo group's children (rendered after the bound groups, before/after ungrouped sessions). Rendering it as a sibling of `GroupBucket` (under the repo header, when `collapsedProject` is true) or under the project header (when split) is a sidebar render choice; the data contract is the `AdoptableWorktreeRow` above.

**Filtering:** the adoptable row matches on `entry.branch` and `entry.path` (the same `filterWorktrees` in `worktree.ts:429` already does this for the dialog's search). The sidebar's `needle` filter applies.

### 4. Interaction with the isomorphism (ticket 07)

Ticket 07 resolved `openNodeGroupAsCanvas(group)` as a transient in-memory `DrillContext` (`{kind:'group', groupId, projectId}`) that reuses the canvas-switcher load effect by repositioning the group's children to root-space. The drill is view-only for commits; xterm instances stay mounted (no park); the reverse leg is `drill = {kind:'project'}` + rebuild.

**Where the drill-through wires in (02's sidebar → 07's canvas):**

The sidebar's worktree row (a bound `GroupBucket` or, after binding, the group frame's row) gains a **drill action** — a double-click or a dedicated "Open as canvas" affordance on the group header — that calls `openNodeGroupAsCanvas(groupNode)`. This is a new callback prop on `SessionsSidebarProps`:

```ts
/** Drill into a group's children as a sub-canvas (ticket 07's isomorphism). */
onDrillIntoGroup(projectId: string, groupId: string): void
```

Canvas wires this to the `DrillContext` setter: `setDrill({kind:'group', groupId, projectId})`. The grouping decision in 02 is **independent** of whether 07 has landed: the `RepoGroup`/`SessionGroup`/`GroupBucket` shape carries `groupId` and `projectId` on every bucket, so the drill callback can be a no-op until 07 ships (the prop is optional; the sidebar hides the affordance when it is absent). When 07 is live, the drill fires from the group row exactly as it would from a canvas double-click on the group frame — same mechanism, one extra entry point.

**The isomorphism does NOT change the grouping function.** The repo→project→group→session hierarchy is about *which sessions are where*, and the drill is about *how you view a group's children*. A drilled view replaces the canvas's node-set; the sidebar continues to show the full project tree (the drilled group is still a row in the sidebar, just marked "open" — the same way an active project is highlighted today). The sidebar is not a view of the drilled sub-canvas; it is a view of all projects. This keeps 02's contract clean: `buildSessionList` never knows about `DrillContext`.

### Implementation hazards

1. **Repo shared across an SSH-project and a local project — different machines.** A local project with `cwd: /home/user/repo` and an SSH project whose `cwd` is `~/repo` on `user@host` would resolve to the same *string* (`/home/user/repo` or `~/repo` — actually different strings, but even if normalized they are on different machines). `repoRootByProject` must be keyed by a **machine identity**, not just the path. The existing `usageScopeKey` pattern (CLAUDE.md: "the machine the project runs on") is the precedent: an SSH project's repo root is on the host, a local project's is here. **Rule: do not group an SSH project's sessions under the same `RepoGroup` as a local project's, even if the path strings match.** The `RepoGroup` key is `(machineKey, normalizedRepoRoot)`, where `machineKey` is `local` for local/relay projects and `user@host` for SSH projects (the same `sshHostKey` the managed-accounts system uses). SSH projects already cannot have worktrees (Canvas.tsx:4154 refuses; CLAUDE.md: "SSH projects: not supported in v1"), so their `RepoGroup` is degenerate (`collapsedProject: true`, no adoptable rows). The hazard is purely about not merging two machines' sessions under one header.

2. **`repoRootByProject` staleness.** The map is populated by a one-shot `git.repoRoot` per project and re-resolved on the active project's `refresh`. A project whose repo root changes (rare — `git worktree move`, or the user deletes `.git`) would show stale grouping until it becomes active. This is acceptable: repo roots are stable, and the active project is always fresh. Do not add a poller for this.

3. **Normalization consistency.** `buildSessionList` must use the SAME path normalizer as `useWorktrees` (`normWorktreePath` from `worktree-reconcile.ts:24`), or the sidebar and the store will disagree about whether `cwd === repoRoot`. Import `normWorktreePath` into `sessionList.ts` rather than re-implementing.

4. **The `liveActiveNodes` dedup window (sessionList.ts:405-456, the `buildStatusList` ownership guard).** The repo grouping does not change the dedup logic — `buildSessionList`'s per-project ownership (persisted `p.nodes` is the owner, live overlays the active project) is unchanged. The repo grouping is a post-partition step on the already-built `SessionGroup[]`. The cross-project-switch duplication window (a node appearing under two projects) is already handled per-project; lifting to repo level does not reopen it, because the dedup happens BEFORE the repo partition.

5. **Worktree dialog reuse vs. one-click bind.** The cleanest path is to call `attachWorktree` directly from the adoptable row's Bind button (bypassing the dialog), since `worktreeFromEntry` + `resolveBaseRef` are pure functions and the entry is already known. Opening the full `WorktreeDialog` for a one-click bind is heavier than needed — the dialog's existing-worktrees list IS the discovery surface, and the sidebar row replaces it. But `attachWorktree` is a Canvas-local `useCallback` (Canvas.tsx:4177); exposing it to the sidebar requires either lifting it to a shared hook or passing it as a prop (`onBindWorktree(entry: WorktreeEntry): void`). The prop is the cleaner seam — it matches the existing `onSwitchProject`/`onMoveToGroup` pattern (SessionsSidebarProps, SessionsSidebar.tsx:28-67).

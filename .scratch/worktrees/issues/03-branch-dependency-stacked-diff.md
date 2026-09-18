# 03 — Branch-dependency link + stacked-diff operations (same-repo)

Type: grilling
Status: resolved

## Question

Design the **same-repo** face of area 2: explicit branch→branch `dependency` links (a `Link` of `kind:'dependency'`, `Endpoint = {repoPath, branch}`) plus full stacked-diff operations driven by those links, leveraging an existing stack tool rather than building the stack logic from scratch.

Settled (from charter, Q5/Q10/Q11/Q14):
- **Link semantics:** the dependency is a property of **branches**, not worktrees (Q5=a) — it survives worktree creation/removal. The link is **explicit** (Q11=a): authored by the user or an agent (a canvas edge between two worktree group nodes that host the branches, or a canvas-control verb `link-branches --base X --branch Y`), stored as a `Link`. Inference from merge-base/branch-config may be a later *suggestion* ("looks stacked — link?") but is not the source of truth.
- **Operations (Q10=c):** full stacked-diff tooling — rebase a branch onto its base, merge base into branch, restack-on-merge, and PR-per-branch creation / auto-restack when a base merges. **Leverage an existing stack tool** (graphite / gh-stack / gitbutler) rather than reimplementing — the choice is a research question (ticket R01) feeding this design.

Resolve (after R01 reports which tool fits):
1. The exact operation set and which are first-class vs. deferred. The charter commits "full stacked-diff tooling" but the tool choice (R01) determines how much is native vs. delegated. Decide the minimum coherent set that satisfies "my branch depends on yours but merges independently."
2. How a branch→branch `dependency` link drives operations: the link identifies base↔branch; an operation reads the link's endpoints and invokes the chosen stack tool's CLI (or library) against the repo. Decide the execution seam — canvas-control verb (consistent with the agent seam), a sidebar/menu action, or both.
3. Rendering: the link renders as an edge between the two worktree group nodes that *currently host* the linked branches (Q5=a); if a branch has no hosting worktree node, the link is still visible at the repo level (ticket 02's grouping). Decide how a branch-level link maps to a canvas edge when the hosts exist and degrades gracefully when they don't.
4. The rebase/merge plumbing: `src/shared/worktree-ops.ts` (`worktreeMerge`) and `src/core/git-service.ts` already have worktree merge plumbing. Decide how much of the stack operations reuse it vs. the external tool.

Invoke `/grilling` and `/domain-modeling`. Depends on the `Link` model (01) and the stack-tool research (R01). Check `src/shared/worktree-ops.ts`, `src/core/git-service.ts`, `src/renderer/nodes/GroupNode.tsx` (existing Merge/Unbind/Remove buttons + status chips).

Blocked by: 01
<!-- R01 resolved: git-town is the leverage point (topology = `git-town-branch.<child>.parent` git config, drivable from the Link model). See .scratch/worktrees/research/stack-tools.md -->

## Answer

### 1. Operation set — first-class vs. deferred

The minimum coherent set satisfying "my branch depends on yours but merges independently" is **three first-class operations**, all delegated to git-town, plus the **config-write** and **link storage** that nodeterm owns natively.

| Operation | git-town command | First-class? | What nodeterm does natively |
|---|---|---|---|
| **Set/clear dependency** | `git config git-town-branch.<child>.parent <parent>` (config write — not a `git town` subcommand) | **First-class** | Writes the config from the `Link`; stores the `Link` in `project.links`; renders the edge |
| **Sync stack** (rebase child onto parent + merge parent into child + restack-on-merge) | `git town sync` (or `git town sync --stack` for the whole chain) | **First-class** | Identifies the owning worktree from link endpoints; runs the command in that worktree's cwd |
| **Propose** (PR-per-branch, correct base chaining) | `git town propose` (or `git town propose --branch <name>`) | **First-class** | Same worktree-routing; optional (needs forge auth — `gh` or forge CLI) |
| **Ship** (merge + cleanup branch + restack descendants) | `git town ship` | **First-class** | Same worktree-routing; the merge-to-base the existing ⤴ button does is the non-stacked special case |
| **Offline mode toggle** | `git town offline yes` / `no` | **Deferred** (auto-set) | nodeterm sets `offline yes` when no forge auth is detected, so `sync` never fails on network |
| **Restructure** (`set-parent`, `swap`, `prepend`, `append`, `detach`) | `git town set-parent`, etc. | **Deferred** | nodeterm's link authoring IS the topology edit; restructuring = delete one link + create another, which re-writes config. Direct `set-parent` exposure is a later convenience. |
| **Compress / squash / split** | `git town compress`, etc. | **Deferred** | History-rewriting operations are not part of "depends on but merges independently"; later. |
| **Inference suggestion** ("looks stacked — link?") | N/A | **Deferred** | Q11=a settled that inference is at most a later suggestion, not source of truth. |

**Why this set is complete:** "depends on yours but merges independently" requires (a) declaring the dependency (config write + link), (b) keeping the branch rebased onto its parent as the parent moves (`sync`), and (c) landing each branch independently — either as a PR (`propose`) or directly (`ship`). Everything else is a convenience on top.

**Why git-town owns the rebase/restack and nodeterm does not:** the rebase-onto-parent, merge-parent-into-child, and restack-on-merge logic is the entire reason to adopt a stack tool. Reimplementing it in `worktree-ops.ts` would duplicate `git rebase --onto` chains, conflict detection, and the restack cascade — the exact thing R01 was chartered to avoid. nodeterm's job is: own the topology declaration (links → config), own the link storage, own the rendering, and route the right command to the right worktree.

### 2. Link → operations: the execution seam

**Config-write mapping (nodeterm native, the one thing nodeterm does to git directly):**

A `dependency` link `{kind:'dependency', source: {ref:'branch', repoPath, branch: <child>}, target: {ref:'branch', repoPath, branch: <parent>}}` maps 1:1 to one git config entry:

```
git config git-town-branch.<child>.parent <parent>
```

This runs in the repo root (any worktree's cwd resolves the same `.git/config` — linked worktrees share it). The write happens **on link creation** and **on link deletion** (delete → `git config --unset git-town-branch.<child>.parent`). A link modification (re-pointing the parent) is a delete + create. This is the exact "nodeterm's links ARE the git-town lineage" relationship from R01: no reconciliation, no tool-owned metadata, no bidirectional sync. The `Link` in `project.links` is the source of truth; the config entry is a derived projection written at link-change time.

The config write goes through the existing `git()` executor in `src/core/git-service.ts` (line 103) — `git(repoPath, ['config', `git-town-branch.${child}.parent`, parent])` — which already routes over the ControlMaster for SSH projects via `resolveGitRemote`. For SSH, the config lands in the host's `.git/config` (shared across the host's linked worktrees, same as local).

**Execution seam — BOTH canvas-control verb AND user-facing menu action:**

The two surfaces mirror the existing worktree ops (which are reachable both from `GroupNode.tsx`'s header chip and from the `open-worktree` / `close-worktree` canvas-control verbs).

**(a) Canvas-control verbs (agent seam):** Add two verbs to `ControlVerb` and `VERBS` in `src/main/canvas-control-core.ts` (line 28 / 64), parse them in `parseControlRequest` (line 114), and dispatch them in the `onAgentControl` switch in `src/renderer/canvas/Canvas.tsx` (line 6406+):

- `link-branches --base <branch> --branch <child>` — creates a `dependency` link (writes config + stores link + renders edge). This is the branch-level analogue of the existing `link` verb (line 7129), which links node-to-node for context. `link-branches` operates on `branch` endpoints, not `node` endpoints.
- `sync-stack [--branch <name>]` — invokes `git town sync` in the owning worktree's cwd. `--branch` scopes to one branch; omitting it syncs the whole stack. The verb handler resolves the owning worktree from the link endpoints (see caveat below), calls a new `gitService.townSync(worktreeCwd, branch?)`, and replies with the result.

The shim POSTs these form-urlencoded (`curl --data-urlencode`), exactly like every other verb — `parseControlBody` in `src/core/agents/hook-server.ts` (line 111) already reads `arg.<name>` fields. The skill body (`buildCanvasSkillBody` in `canvas-control-core.ts`, line ~425) and the codex/gemini marker block (`buildCanvasControlInstructions`, line ~180) get the two new verbs documented in the same PR (the CLAUDE.md invariant: "Keep the agent-facing text in sync with behaviour, in the SAME PR").

**(b) User-facing menu action:** `GroupNode.tsx`'s worktree chip (line 178–243) gains a **↻ Sync** button beside the existing ⤴ Merge, Unbind, and ✕ Remove. The button calls `worktreeActionHandler` (line 16) with a new action type `'sync'` added to `WorktreeAction` (line 8). Canvas's handler resolves the group's worktree branch, finds any `dependency` links where this branch is the child, and runs `git town sync` in the group's worktree cwd. If no dependency link exists, the button is hidden (no stack to sync). The existing ⤴ Merge button stays for the non-stacked case (merge one branch to main, via `worktreeMerge`); when a dependency link IS present, ↻ Sync supersedes it (git-town's `sync` handles the rebase + restack that a plain merge does not).

**How an operation reads link endpoints and invokes git-town:**

1. The handler reads `project.links` (the `Link[]` on the project — ticket 01's model), filtered to `kind === 'dependency'` and `source.branch === <the branch to sync>`.
2. The child's `repoPath` + `branch` identify the owning worktree: `listWorktrees(git, repoPath)` → find the entry whose `branch === child`. Its `path` is the cwd for the git-town command. (This is the same `listWorktrees` call `worktreeMerge` already makes at `worktree-ops.ts:152`.)
3. Run `git town sync` via a new `GitService.townSync(cwd, branch?)` method that calls the existing `git()` executor with `['town', 'sync', ...(branch ? ['--branch', branch] : [])]`. The `git()` executor (line 103) already handles SSH routing and the `GIT_ENV` PATH (which includes `/opt/homebrew/bin` where `git-town` installs on macOS). If `git town` is not found (`!ok` + "git: 'town' is not a git command"), the result says so — the feature degrades to a message, not a crash.

### 3. Rendering

**Edge between hosting worktree group nodes:** A `dependency` link renders as a **dashed edge** between the two worktree group nodes that currently host the linked branches. The edge is distinct from context bridges (solid) and ropes (solid, thinner): dashed says "branch dependency" at a glance. The edge carries a small label pill showing `child → parent` (the dependency direction — the child depends ON the parent, so the arrow points child→parent, meaning "rebases onto").

The mapping from a `dependency` link (branch endpoints) to a canvas edge (node endpoints) is derived, not stored: Canvas scans the project's group nodes for ones whose `data.worktree.branch` matches the link's `source.branch` and `target.branch` respectively. This derivation runs in the same effect that builds `linkEdges` from `project.bridges` today (`Canvas.tsx:1833` — `setLinkEdges((project.bridges ?? []).map(...))`); the dependency edges are a second set derived from `project.links` (ticket 01's new field) the same way. The edges are **derived, never persisted as React Flow edges** — the `Link` in `project.links` is the persisted truth, and the edge is its projection, exactly as context-bridge edges are derived from `project.bridges`.

**Degrade when a branch has no hosting worktree node:** If one or both branches have no currently-hosting worktree group node (the worktree was removed, the branch is checked out in the main checkout, or the link was authored before any worktree existed), the edge **does not render on the canvas** — there is no node to attach it to. The link is still visible at the **repo level** in ticket 02's branch/repo grouping panel, which lists branches and their dependencies regardless of whether a worktree group hosts them. This is the same degrade the existing `project.bridges` edges would face if a linked node were deleted: the bridge persists, the edge disappears, and the relationship lives on in the data. The dependency link's `branch` endpoints carry `repoPath` + `branch` — enough to render it in any repo-level view without a node reference.

**Edge style summary:**
- Context bridge (`kind:'context'`): solid line, existing style.
- Rope (lineage): solid thin grey, existing style.
- **Dependency (`kind:'dependency'`): dashed, accent-colored, with a `child → parent` label pill.** Derived from `project.links`, never persisted as a React Flow edge. Hidden when either host is absent; the link survives in the repo-level view (ticket 02).

### 4. Rebase/merge plumbing: native reuse vs. external tool

**What reuses existing plumbing:**
- The **config write** (`git config git-town-branch.<child>.parent <parent>`) goes through the existing `git()` executor in `git-service.ts:103` — same seam, same SSH routing, same `GIT_ENV`. No new executor needed for this.
- The **worktree resolution** (finding the owning worktree's cwd from a branch name) reuses `listWorktrees` from `worktree-ops.ts:94` — the exact call `worktreeMerge` already makes.
- The **existing ⤴ Merge** (`worktreeMerge` in `worktree-ops.ts:143`) stays for the non-stacked case: a single branch merged into its base (`main`), with the `decideMergeStrategy` logic (fetch-update vs. merge-in-place vs. blocked) that already handles the "base checked out elsewhere" problem. This is NOT replaced by git-town — it is the simple, no-stack case.
- The `WorktreeAction` handler bridge in `GroupNode.tsx` (line 16) and Canvas's `worktreeActionHandler` registration are extended, not replaced.

**What is delegated to git-town (NOT reimplemented):**
- **Rebase child onto parent** — `git town sync` does `git rebase --onto <parent> <old-parent> <child>`. nodeterm does not call `git rebase` directly. The existing `GitService.rebase` (line 583) stays for the manual non-stacked rebase in Source Control; stacked rebase goes through git-town.
- **Merge parent into child** — `git town sync` pulls parent changes and merges them into the child. nodeterm does not call `git merge` for this.
- **Restack-on-merge** — when a parent branch is shipped (merged to trunk), `git town sync` rebases all descendants onto the new trunk. This is the cascade that `worktreeMerge` cannot do (it merges one branch into one base, period). nodeterm does not track "which children need restacking" — git-town reads its own lineage config (which nodeterm wrote) and walks the chain.
- **PR-per-branch with correct base chaining** — `git town propose` creates PRs with each branch's parent as its base. nodeterm does not call `gh pr create` for this.

**The new GitService method (one, thin):**

```ts
// In src/core/git-service.ts, beside worktreeMerge:
async townSync(cwd: string, branch?: string): Promise<GitResult> {
  const args = ['town', 'sync', ...(branch ? ['--branch', branch] : [])]
  const r = await git(cwd, args)
  return r.ok ? { ok: true, message: r.out || 'Stack synced.' } : fail(r)
}
async townPropose(cwd: string, branch?: string): Promise<GitResult> {
  const args = ['town', 'propose', ...(branch ? ['--branch', branch] : [])]
  const r = await git(cwd, args)
  return r.ok ? { ok: true, message: r.out || 'PR(s) proposed.' } : fail(r)
}
async townShip(cwd: string, branch?: string): Promise<GitResult> {
  const args = ['town', 'ship', ...(branch ? ['--branch', branch] : [])]
  const r = await git(cwd, args)
  return r.ok ? { ok: true, message: r.out || 'Branch shipped.' } : fail(r)
}
```

These are thin pass-throughs — the `git()` executor (line 103) handles cwd routing (local vs. SSH via `resolveGitRemote`) and PATH (`GIT_ENV` includes homebrew bin where `git-town` installs). Each returns a `GitResult` (the shape every existing git op returns), so the renderer's result handling is identical to `worktreeMerge`'s. No new IPC channel is strictly needed — these can ride a generic `git:town` channel or be added alongside the existing `git:worktree-*` channels in `GitService.registerIpc` (line 215).

### Worktree-rebase caveat (explicit handling)

**The problem (from R01 §4.6):** `git town sync` rebases by **checking out** the branch being synced. If that branch is checked out in another worktree, git refuses ("fatal: '<branch>' is already checked out at '<path>'"). Since nodeterm runs each branch in its own worktree, a branch IS always checked out somewhere — its owning worktree.

**The mitigation — sync from the OWNING worktree:** The operation handler resolves the owning worktree's cwd from the branch name (via `listWorktrees` → find entry with `branch === child`), and runs `git town sync` **in that worktree's directory**. When the cwd IS the branch's checkout, git-town's checkout is a no-op (the branch is already HEAD there) — no conflict. This is why the handler must run the command in the worktree cwd, not in `repoPath` (the main checkout, where a different branch is HEAD).

**The remaining edge case — the whole stack:** `git town sync --stack` syncs the entire chain, which means checking out each branch in the chain in sequence. Only the branch whose worktree you're IN is already checked out; the others are checked out in their own worktrees. git-town does not support "sync from one worktree for branches hosted in others." Two responses:

1. **Default to `--branch <child>`** (single-branch sync) unless the user explicitly asks for the whole stack. Single-branch sync rebases the child onto its parent — the parent does not need to be checked out here, because git-town reads the parent's ref without checking it out (it rebases `--onto <parent-ref>`). This covers the common case: "my feature branch is behind its base; update it."
2. **Whole-stack sync** runs `git town sync` (no `--branch`) per-branch in a loop, each in its own owning worktree's cwd. This is a Canvas orchestration: iterate the stack's branches, resolve each one's worktree, run `git town sync --branch <b>` in it. Sequential, not parallel (rebases can conflict on shared files). This is the bulk action, mirroring the existing "restart-idle-agents" bulk pattern.

**SSH projects:** `git town sync` runs over the ControlMaster via the existing `git()` executor's `resolveGitRemote` routing. The owning worktree's cwd is a remote path; `runRemoteGit` runs the command on the host. The same caveat applies on the host — the command must run in the remote worktree's directory, which `runRemoteGit` already handles (it takes a cwd parameter that becomes the remote `cd` target). Worktrees are unsupported in SSH projects in v1 (the existing `isRemoteRepo` gate in `git-service.ts:139` refuses worktree ops), so stacked-diff operations on SSH projects are **deferred behind the same gate** — the verbs and buttons are shown disabled with the same "not supported in SSH projects" reason.

### Summary table: op → git-town command → seam → precondition

| Op | git-town command | Seam | Precondition |
|---|---|---|---|
| Set dependency | `git config git-town-branch.<child>.parent <parent>` | Native config write via `git()` executor; link stored in `project.links` | Both branches exist in the repo; `git-town` not required for this step |
| Clear dependency | `git config --unset git-town-branch.<child>.parent` | Same; link removed from `project.links` | Link exists |
| Sync one branch | `git town sync --branch <child>` | Canvas-control verb `sync-stack --branch <name>` OR GroupNode ↻ button → `GitService.townSync(worktreeCwd, branch)` | `git-town` installed; run in the child's owning worktree cwd |
| Sync whole stack | `git town sync --branch <b>` per branch, each in its own worktree | Canvas bulk action (iterate stack branches) | Same, per branch; sequential |
| Propose (PR-per-branch) | `git town propose [--branch <name>]` | Canvas-control verb OR GroupNode menu → `GitService.townPropose` | `git-town` installed; forge auth (`gh` or forge CLI); network |
| Ship (merge + cleanup) | `git town ship [--branch <name>]` | GroupNode menu → `GitService.townShip` | `git-town` installed; run in the branch's owning worktree |

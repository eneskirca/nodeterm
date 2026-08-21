# R01 — Stack-tool leverage evaluation (graphite / gh-stack / gitbutler)

Type: research
Status: resolved

## Question

Which existing stacked-diff tool should nodeterm leverage for the same-repo branch-dependency operations (ticket 03), and how does it integrate? Evaluate **graphite**, **gh-stack**, and **gitbutler** (and any obvious peer) against the integration constraints of nodeterm's architecture, so ticket 03 can design its operation set against a concrete tool rather than reimplementing stack logic from scratch.

Research questions:
1. **What operations each tool exposes** and through what interface (CLI commands? a library/SDK? git config? a daemon?). Ticket 03 needs: rebase a branch onto its base, merge base into branch, restack-on-merge (auto-restack dependents when a base merges), and PR-per-branch creation. Map each tool's coverage of these.
2. **Where the stack state lives** for each tool — does it store the branch-dependency topology in git (refs/config), a local metadata file, a remote service (graphite's hosted API), or the gitbutler app? This matters: nodeterm's `dependency` link (ticket 01) is its own source of truth for the topology. Decide whether nodeterm's link *drives* the tool (nodeterm tells the tool the stack) or *mirrors* the tool (the tool owns topology, nodeterm renders it). The charter chose *explicit* links authored in nodeterm (Q11=a), so the tool should be drivable from nodeterm's link model — assess feasibility per tool.
3. **Offline / local-only viability.** nodeterm is a local-first desktop app; a tool requiring a hosted account/service (graphite's auth) is a heavier dependency than a pure-CLI local tool (gh-stack). Note which need network/auth.
4. **Per-repo vs. global.** Does the tool operate per-repo (good — matches nodeterm's per-project `cwd`) or does it impose its own workspace concept (gitbutler's virtual branches)?
5. **Coexistence with the existing worktree plumbing.** nodeterm already has `worktreeMerge` (`src/shared/worktree-ops.ts`) and git-service merge. Does the chosen tool's stack operations conflict with or subsume that?

Deliverable: a findings doc comparing the tools against the above, with a recommendation for ticket 03 (drivable-from-nodeterm's-link-model preferred; local-first preferred; minimal auth preferred). This is pure research — invoke `/research`, capture findings on a throwaway `research/stack-tools` branch with a context pointer back here.

Blocked by: —

## Answer

Findings doc: `.scratch/worktrees/research/stack-tools.md` (720 lines, primary-source-cited). Six tools evaluated: Graphite (`gt`), `gh-stack` (`gh stack`), ghstack (ezyang), GitButler (`but`), **git-town**, and stgit.

**Central axis — "drivable from nodeterm's link model (external topology)?" — split the field cleanly:**

- **git-town — RECOMMENDED.** Topology is plain git config: `git-town-branch.<child>.parent <parent>` in `.git/config`. nodeterm writes these directly from its `dependency` links — 1:1, no reconciliation, no tool-owned metadata. nodeterm's links *are* the git-town lineage. MIT, explicit `git town offline` mode (all stack ops offline; only `propose` needs network), per-repo, no virtual-branch/workspace concept (no conflict with nodeterm's worktree-per-branch), uses the user's existing `gh`/forge auth for PRs (no separate account). Operations map cleanly: `sync` = rebase+merge+restack-on-merge; `propose` = PR-per-branch; `ship` = merge+cleanup. Integration shape: on link change → `git config git-town-branch.<child>.parent <parent>`; on sync → `git town sync`; on PR → `git town propose`. One caveat: worktree coexistence is undocumented — `.git/config` is shared across linked worktrees (topology visible everywhere, fine) but `git town sync` rebases by checking out branches, which conflicts if a branch is checked out in another worktree (the same checkout-during-rebase issue every branch-based tool shares; mitigated since nodeterm runs each branch in its own worktree and can sync from the owning worktree).
- **gh-stack — secondary option** if GitHub-native Stacked PRs (the `Stack` object on github.com) are specifically wanted. `gh stack link --base main b1 b2 b3` accepts a declarative branch ordering computed from nodeterm's links and creates the chained PRs + GitHub Stack with no local tracking state. Trade-off vs. git-town: its restack (`rebase`) uses local `.git/gh-stack` tracking state that must be kept in sync via `gh stack init`, whereas git-town's topology *is* git config (no second store). Requires `gh` auth, no separate account.
- **Not recommended:** Graphite (private `.git/` metadata format; `branch track` requires history to match the declared parent = reconciliation burden; PR submit needs a Graphite account; worktree support experimental with known conflicts). ghstack/ezyang (commit-based not branch-based; no restack; always network — incompatible with the branch-link model). GitButler (imposes a workspace/virtual-branch model that *competes* with nodeterm's worktree-per-branch; topology in an internal SQLite DB with no external write API — the two tools have conflicting mental models). stgit (patch-stack within a branch, not branch-stack; no PR integration — incompatible).

**Bottom line:** git-town is the leverage point for ticket 03 — its config-key topology is the one that makes "nodeterm's link model is the source of truth" literally true (nodeterm writes the config; git-town reads it). The worktree-rebase caveat is a detail for 03 to handle (sync from the owning worktree), not a blocker.

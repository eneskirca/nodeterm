# Stacked-Diff Tool Research for nodeterm

## Context

nodeterm is an Electron desktop app managing git worktrees and AI-agent terminal sessions
on a canvas. It has its OWN concept of "dependency" links between branches (users author
explicit branch→branch links in nodeterm's UI). The research question: which stacked-diff
tool can nodeterm LEVERAGE for stack operations (rebase, merge, restack-on-merge,
PR-per-branch), where nodeterm's link model is the SOURCE OF TRUTH for topology and the
tool is DRIVEN by nodeterm — not the tool owning topology and nodeterm mirroring it.

Evaluation axes (from the task):
- **Drivable from external topology** (MOST IMPORTANT) — can nodeterm tell the tool
  "A→B→C are stacked" and have it operate, or does the tool infer/own the stack?
- **Local-first / no network or account** — pure-CLI/local preferred.
- **Per-repo operation** — matches nodeterm's per-project cwd. Flag workspace/virtual-branch concepts.
- **Coexistence with git worktrees** — per-worktree or assumes single working copy?

Operations to map:
1. Rebase a branch onto its base
2. Merge base into branch
3. Restack-on-merge: auto-restack dependents when a base merges
4. PR-per-branch creation (and PR status sync)

---

## 1. Graphite (graphite-cli / `gt`)

**Repo:** `withgraphite/graphite-cli-routes` (the CLI source itself is private/internal; the
public `graphite-cli-routes` repo contains only the API route type definitions). The docs
live at `withgraphite/docs` (GitBook, published to `docs.graphite.dev`).
**License:** not found in public repos [unverified]; Graphite is a commercial product with
a free CLI tier.

### 1. Operations exposed + interface

Graphite exposes a **CLI** (`gt`) with a rich command set. There is no documented library/SDK;
integration would be by shelling out to `gt` commands.

Key commands (from `docs.graphite.dev/guides/graphite-cli/command-reference.md`):

| Operation needed | Graphite command |
|---|---|
| Rebase branch onto base | `gt branch restack` (single), `gt upstack restack` (current + descendants), `gt stack restack` (whole stack), `gt downstack restack` (trunk to current) |
| Merge base into branch | `gt repo sync` pulls trunk and optionally `--restack`; `gt repo sync --restack` pulls + restacks. Merging is done via the Graphite dashboard or GitHub, not a CLI "merge" command. |
| Restack-on-merge | Semi-manual: after merging bottom PR, run `gt repo sync --restack` then `gt stack submit`. The CLI does NOT auto-restack on merge — the docs recommend the Graphite dashboard for automated merge+restack. |
| PR-per-branch | `gt branch submit` (single), `gt stack submit` (all), `gt upstack submit`, `gt downstack submit` — creates/updates PRs via GitHub API |

Other topology commands: `gt branch create` (stack on top of current), `gt branch track`
(adopt an existing git branch into the stack by selecting its parent), `gt branch untrack`,
`gt upstack onto` (rebase subtree onto a new parent), `gt downstack edit` (reorder),
`gt branch fold`, `gt branch split`, `gt branch squash`.

### 2. Where stack topology state lives

**Local git metadata inside `.git/`** — NOT a remote service and NOT a committed file.

Source: `docs.graphite.dev/guides/graphite-cli/mixing-gt-and-git.md` states:
> "Under the hood, `gt` uses native `git` commands and stores all of the metadata on your
> stacks in the `.git` folder in your repo."

Source: `docs.graphite.dev/guides/graphite-cli/initializing-gt-in-a-repo.md` states:
> "Graphite stores a small JSON configuration file in `.git/.graphite_repo_config` of your
> repository."

The per-branch parent relationships (the actual stack topology) are stored as additional
Graphite metadata in `.git/` — the exact ref/config format is in the private CLI source
[unverified on exact internal format, but confirmed to be local-only in `.git/`].

`gt branch track` is the mechanism to tell Graphite "this branch's parent is X" — it prompts
you to select a parent from the branch's git history. `gt branch track --force` chooses the
nearest tracked ancestor.

### 3. Offline / local-only viability

**Partially local.** Stack creation, tracking, restacking, and all git operations work
offline — they're local git metadata + `git rebase`.

**PR submission requires network + auth.** `gt stack submit` requires authentication with
the Graphite service (`gt auth --token <token>` from `app.graphite.dev/activate`). The
submit path goes through Graphite's API (`withgraphite/graphite-cli-routes/src/index.ts`
shows `submitPullRequests` POSTs to `/graphite/submit/pull-requests`, which proxies to
GitHub). There is a fallback using a GitHub PAT directly.

Source: `docs.graphite.dev/guides/graphite-cli/authenticating-the-cli/README.md`

The CLI also phones home for telemetry/upgrade checks (`graphite-cli-routes` shows
`logCommand`, `upgradePrompt`, `traces`, `feedback` API routes).

### 4. Per-repo vs. global workspace

**Per-repo.** Each repo is initialized with `gt repo init` which creates
`.git/.graphite_repo_config`. There is no global workspace or virtual-branch concept —
graphite works with real git branches in a real working copy.

### 5. Can it be driven from an EXTERNAL topology?

**Partially — with friction.** Graphite OWNS its topology metadata in `.git/`, but it
exposes `gt branch track` as the ingestion point for externally-created branches. The
workflow to drive it from nodeterm's links would be:

1. nodeterm creates git branches (via its existing worktree/git infrastructure).
2. For each branch, nodeterm shells out `gt branch track --force` (or `--parent <X>`) to
   register the parent relationship in Graphite's metadata.
3. nodeterm then uses `gt stack restack`, `gt stack submit`, etc.

**The problem:** `gt branch track` selects the parent from the branch's **git history**
(nearest tracked ancestor with `--force`). It does NOT accept an arbitrary parent that
isn't in the ancestry — the branch must actually be based on the parent in git terms. This
means nodeterm's links must match the actual git topology (branches must be rebased onto
their declared parent before tracking). nodeterm cannot declare an arbitrary A→B link that
contradicts git history and have Graphite accept it.

There is no documented JSON/API import for bulk topology setup. Each branch must be tracked
individually. `gt downstack track` can track a series at once but still walks the git
history.

**Verdict: drivable but with a reconciliation burden.** nodeterm must ensure git history
matches its link model before telling Graphite to track. Graphite does not accept a
declarative topology that disagrees with git ancestry.

### 6. Coexistence with git worktrees

**Experimental support.** Source: `docs.graphite.dev/guides/graphite-cli/multiple-checkout-experimental.md`
(CLI v0.18.7):

> "Previously, `gt` was not able to understand that it was in a linked worktree... Now, `gt`
> commands should largely work as expected in linked worktrees."

**Big gotcha:** since `gt` relies on rebasing and rebasing requires checking out the branch,
if a branch is checked out in another worktree, `gt` will fail. The docs recommend "only
using one worktree for each stack off your trunk branch."

This is a **significant conflict** with nodeterm's model, where each worktree IS a branch
group and multiple worktrees (and their branches) coexist simultaneously.

### Sources
- `docs.graphite.dev/guides/graphite-cli/command-reference.md` (via `withgraphite/docs` repo)
- `docs.graphite.dev/guides/graphite-cli/mixing-gt-and-git.md`
- `docs.graphite.dev/guides/graphite-cli/initializing-gt-in-a-repo.md`
- `docs.graphite.dev/guides/graphite-cli/authenticating-the-cli/README.md`
- `docs.graphite.dev/guides/graphite-cli/restacking-branches.md`
- `docs.graphite.dev/guides/graphite-cli/merging-a-stack.md`
- `docs.graphite.dev/guides/graphite-cli/multiple-checkout-experimental.md`
- `docs.graphite.dev/guides/graphite-cli/modifying-a-stack.md`
- `withgraphite/graphite-cli-routes/src/index.ts` (API route definitions)

---

## 2. gh-stack (GitHub official, `github/gh-stack`)

**Repo:** `github/gh-stack` — a GitHub CLI extension (`gh extension install github/gh-stack`).
**License:** MIT.

Note: there is also `ezyang/ghstack` (the original academic tool by Edward Yang) — covered
separately in section 2b.

### 1. Operations exposed + interface

**CLI** (`gh stack <subcommand>`), installed as a `gh` extension. No library/SDK.

Key commands (from `github/gh-stack` README):

| Operation needed | gh-stack command |
|---|---|
| Rebase branch onto base | `gh stack rebase` (cascading rebase across the stack); `--downstack`/`--upstack`/`--no-trunk` to scope |
| Merge base into branch | `gh stack sync` (fetch + reconcile + fast-forward trunk + cascade rebase + push + sync PRs) |
| Restack-on-merge | `gh stack rebase` auto-switches to `--onto` mode when a branch's PR has been merged, correctly replaying commits on top of the merge target. `gh stack sync --prune` cleans up merged branches. |
| PR-per-branch | `gh stack submit` (pushes branches + creates/updates PRs + creates Stack on GitHub); `gh stack link` (link existing branches/PRs into a stack without local tracking) |

Other commands: `gh stack init`, `gh stack add`, `gh stack checkout`, `gh stack modify`
(TUI for restructuring), `gh stack merge` (merge all PRs up to a point), `gh stack push`,
`gh stack view`, `gh stack unstack`, navigation (`up`/`down`/`top`/`bottom`/`trunk`).

### 2. Where stack topology state lives

**Local git metadata: `.git/gh-stack` (a JSON file, not committed).** Plus a GitHub-side
"Stack" object (created by `submit`/`sync`/`link`).

Source (README, "Local tracking" section):
> "Stack metadata is stored in `.git/gh-stack` (a JSON file, not committed to the repo).
> This tracks which branches belong to which stack and their ordering. Rebase state during
> interrupted rebases is stored separately in `.git/gh-stack-rebase-state`."

The topology is: a stack is "an ordered list of branches where each branch builds on the one
below it." The bottom is based on a trunk branch.

**Critically, `gh stack link` operates WITHOUT local tracking:**
> "This command does not store or modify any `gh stack` local tracking state. It is designed
> for users who manage branches with other tools locally (e.g., jj, Sapling, git-town) and
> want to simply open a stack of PRs."

`gh stack link feature-auth feature-api feature-ui` pushes branches, creates/looks-up PRs,
sets correct base-branch chaining, and creates the GitHub Stack — all from the **arguments
you pass** (stack order, bottom to top). It does not read or write `.git/gh-stack`.

### 3. Offline / local-only viability

**Local operations work offline:** `init`, `add`, `rebase`, `push` (to a remote, needs
network), `view`, navigation — these are local git operations.

**PR creation and Stack management require GitHub API access** (via `gh` CLI auth, which
uses GitHub OAuth or a PAT). `submit`, `sync`, `link`, `merge`, `checkout` (for remote
stacks) all hit the GitHub API.

**No separate hosted account/service.** It uses `gh` CLI's existing GitHub authentication.
There is no Graphite-style separate service — it talks directly to GitHub.

### 4. Per-repo vs. global workspace

**Per-repo.** Stack metadata is in `.git/gh-stack`. No global workspace or virtual-branch
concept. Works with real git branches.

### 5. Can it be driven from an EXTERNAL topology?

**YES — this is the strongest fit.** `gh stack link` is explicitly designed for this:

```sh
gh stack link feature-auth feature-api feature-ui
```

This accepts a **declarative stack ordering** as arguments (bottom to top), pushes the
branches, creates/updates PRs with correct base chaining, and creates the GitHub Stack —
**without reading or writing local tracking state**. nodeterm can compute the stack order
from its own link model and pass it directly.

For restacking, `gh stack rebase` operates on the local tracking state. To drive restacking
from nodeterm's topology, nodeterm would either:
- Use `gh stack init <branch1> <branch2> <branch3>` to (re)establish local tracking from
  nodeterm's link order (this "adopts existing branches into a stack" per the README), then
  run `gh stack rebase`.
- Or, since `gh stack init` accepts explicit branch names and `--base`, nodeterm can
  fully specify the topology at init time.

`gh stack init feature-auth feature-api feature-ui --base main` creates a stack from
explicit branch names — existing branches are adopted, missing ones are created.

**Verdict: directly drivable.** `gh stack link` and `gh stack init` both accept a declarative
branch ordering. nodeterm's link model maps directly to the argument list. This is the
explicitly designed external-integration point.

### 6. Coexistence with git worktrees

**Not addressed in docs** [unverified]. Since `gh stack` stores metadata in `.git/gh-stack`
and git worktrees share the same `.git` directory structure (linked worktrees have their
own `.git` file pointing to the main `.git`), there may be issues with stack metadata
visibility across worktrees. The `rebase` command checks out branches, which would conflict
if a branch is checked out in another worktree (same issue as Graphite).

However, `gh stack link` avoids this entirely — it doesn't use local tracking state, so it
can be run from any worktree (or even outside a worktree, as long as you can push branches).

### Sources
- `github/gh-stack` README (full command reference, fetched via `gh api`)

---

## 2b. ghstack (ezyang/ghstack — the original)

**Repo:** `ezyang/ghstack`. **License:** BSD-2-Clause (from `setup.py`/LICENSE [unverified
on exact license, but open source]).

### 1. Operations exposed + interface

**CLI** (`ghstack`), a Python tool (`uv tool install ghstack`). Commands: `submit` (default),
`land`, `checkout`, `pull`, `sync`, `unlink`, `status`, `log`, `config`.

| Operation needed | ghstack command |
|---|---|
| Rebase branch onto base | `git rebase origin/main` (vanilla git — ghstack does NOT manage rebasing) |
| Merge base into branch | N/A (ghstack doesn't merge; you use `ghstack land` to land a PR) |
| Restack-on-merge | N/A — ghstack has no restack concept. Each commit is a separate PR. |
| PR-per-branch | `ghstack` (submit) — pushes and creates PRs for each commit in the stack |

### 2. Where stack topology state lives

**In the commit history itself + GitHub PR metadata.** ghstack does NOT maintain a separate
topology file. The "stack" is simply a linear series of commits on top of `main`. Each commit
becomes a separate PR. The topology is inferred from `git log` (commits from merge-base to HEAD).

ghstack creates three branches per commit on the remote:
- `gh/username/N/base` — the base (never force-pushed; merge commits added when you rebase)
- `gh/username/N/head` — your change on top of base
- `gh/username/N/orig` — the actual local commit (for cross-machine work)

Source (README, "Structure of submitted pull requests"):
> "Every commit in your local commit stack gets submitted into a separate pull request and
> pushes commits onto three branches."

Local state: `.git/ghstack-repo-info.json` caches repository metadata (default branch name).
No topology file.

### 3. Offline / local-only viability

**Requires network + GitHub auth.** ghstack requires `~/.ghstackrc` with a GitHub OAuth token
(`public_repo` scope). Every `ghstack` submission hits the GitHub API. There is no offline
mode.

Source (README, "How to setup"):
> "Go to github.com Settings→Developer Settings→Personal Access Tokens and generate a token
> with `public_repo` access only. Create a `~/.ghstackrc`."

### 4. Per-repo vs. global workspace

**Per-repo** (operates on the current checkout). But the model is **commit-based, not
branch-based** — there is no "stack of branches," only a stack of commits on a single branch.

### 5. Can it be driven from an EXTERNAL topology?

**No — not in a meaningful way for nodeterm.** ghstack's topology is the commit graph itself.
There is no declarative "A→B→C" API. You create a stack by having a linear series of commits
and running `ghstack`. The tool infers everything from `git log`.

nodeterm's link model (branch→branch dependencies) does not map to ghstack's commit-based
model. ghstack doesn't understand branches as stack elements — it understands commits.

**Verdict: not drivable from an external branch-topology model.** Fundamentally incompatible
with nodeterm's link model.

### 6. Coexistence with git worktrees

Works in any worktree (it operates on the commit history of the current HEAD). But since it's
commit-based and doesn't manage branch checkout for rebasing, worktree conflicts are less of
an issue. However, the model (single branch with stacked commits) conflicts with nodeterm's
worktree-per-branch model.

### Sources
- `ezyang/ghstack` README
- `ezyang/ghstack/src/ghstack/cli.py` (command structure)

---

## 3. GitButler (`but` CLI / `gitbutlerapp/gitbutler`)

**Repo:** `gitbutlerapp/gitbutler` — Tauri-based desktop app + `but` CLI (Rust backend,
shared engine). **License:** Fair Source (becomes MIT after 2 years).

### 1. Operations exposed + interface

**CLI** (`but`) and **GUI** (Tauri desktop app). The CLI and GUI share the same Rust backend
engine.

Key commands (from docs.gitbutler.com and source crate structure):

| Operation needed | GitButler command |
|---|---|
| Rebase branch onto base | `but pull` (pulls upstream + rebases workspace branches); GitButler's "rebases always succeed" model marks conflicts rather than blocking |
| Merge base into branch | `but pull` (integrate upstream changes); `but rebase` (interactive rebase of workspace branches) |
| Restack-on-merge | Automatic: when you push again after merging, GitButler "updates the review bases to match the local branch order" (from stacked-branches docs). The workspace model auto-restacks. |
| PR-per-branch | `but pr new <branch>` (creates PRs from bottom up for the whole stack); `but push` (push without PR) |

Other commands: `but status`, `but commit`, `but diff`, `but move <branch> --above/--below <other>` (restructure stacks), `but resolve` (conflict resolution), `but undo` (operations log).

### 2. Where stack topology state lives

**GitButler's own database + workspace metadata, NOT standard git refs/config.**

Source: `crates/WORKSPACE_MODEL.md` (from the repo):
> "Workspace metadata is exposed through `but_core::RefMetadata` and `but_core::ref_metadata::Workspace`."

The state includes:
- A **project database** (`but-db` crate — SQLite-based, `crates/but-db/src/` includes
  `handle.rs`, `migration.rs`, `transaction.rs`, `worktrees.rs`).
- **Workspace metadata** (`but-core/src/ref_metadata.rs`) — target ref, target commit ID,
  workspace stacks (described as "legacy/presentation metadata" in `WORKSPACE_MODEL.md`).
- The **graph model** (`but-graph`) is the "current best graph-shaped model of
  repository/workspace state."

Critically, from `WORKSPACE_MODEL.md`:
> "GitButler is moving away from **stacks** as a primary internal abstraction... New logic
> should generally model behavior in terms of Git-representable concepts and graph
> relationships: commits, refs, graph relationships."

The topology is derived from the git graph + GitButler's metadata database, not from a
simple file that an external tool can write.

### 3. Offline / local-only viability

**Fully local-first.** All operations (commit, branch, stack, rebase, resolve) work offline.
Forge integration (GitHub/GitLab/Bitbucket for PRs) requires auth but is optional —
`but push` works with plain git remotes without forge auth.

`but config forge auth` is needed only for `but pr new` (PR creation via forge API).

### 4. Per-repo vs. global workspace

**Imposes its own WORKSPACE / VIRTUAL BRANCH concept.** This is the biggest conflict with
nodeterm.

From `docs.gitbutler.com/features/branch-management/virtual-branches`:
> "With normal Git branching, you can only work on one branch at a time. With parallel
> branches, you can have multiple branches applied to your working directory at the same
> time."

GitButler's workspace model applies multiple branches to a single working directory
simultaneously. Each branch is a "lane" with its own staging area. This is fundamentally
different from git's one-HEAD-one-index model and from nodeterm's worktree-per-branch model.

The workspace is initialized with `but init` / `gt repo init`-equivalent and tracked in
GitButler's own database. The target ref (usually `origin/main`) is the frame of reference.

### 5. Can it be driven from an EXTERNAL topology?

**No — GitButler owns its workspace topology in its own database.** There is no documented
mechanism to declaratively import a branch topology from outside.

`but move <branch> --above <other>` is the CLI command to restructure stacks, but it mutates
GitButler's internal workspace state, not a simple file that nodeterm can write.

The workspace database (`but-db`) is an internal implementation detail with no documented
external write API. The `but` CLI is the only interface, and it operates through the workspace
engine, not by writing raw topology.

From `WORKSPACE_MODEL.md`:
> "Do not conflate: local branch `foo` vs remote-tracking branch `origin/foo`... local branch
> `foo` relative to target ref `origin/main`."

GitButler's model is workspace-centric (multiple branches applied to one working directory
relative to a target ref), not branch-topology-centric (A depends on B). nodeterm's link model
(branch→branch dependencies across worktrees) does not map cleanly to GitButler's
workspace-applied-branches model.

**Verdict: not drivable from an external topology.** GitButler's workspace/virtual-branch model
is fundamentally its own. nodeterm would have to adopt GitButler's workspace concept entirely,
abandoning its own worktree-per-branch + link model. This is the opposite of the desired
integration shape.

### 6. Coexistence with git worktrees

**GitButler has its own worktree support** (`but-worktrees` crate, `crates/but-worktrees/src/`
with `new.rs`, `list.rs`, `destroy.rs`, `integrate.rs`, `db.rs`). Worktrees are managed through
GitButler's database (`but-db/src/worktrees.rs`).

However, GitButler's worktrees are GitButler-managed — they carry GitButler metadata and are
tracked in the GitButler database. They are not plain `git worktree add` worktrees that
GitButler happens to understand. nodeterm's existing worktree model (created via
`git worktree add` with nodeterm's own metadata in `project.json`) would conflict with
GitButler's worktree database.

From the virtual-branches docs: GitButler's parallel-branches model applies multiple branches
to ONE working directory. This is an alternative to worktrees, not a complement to them.

**Verdict: conflicts with nodeterm's worktree model.** GitButler's workspace concept is a
competitor to the worktree-per-branch approach, not a tool that operates within it.

### Sources
- `gitbutlerapp/gitbutler` README
- `docs.gitbutler.com/features/branch-management/stacked-branches`
- `docs.gitbutler.com/features/branch-management/virtual-branches`
- `docs.gitbutler.com/cli-guides/cli-tutorial/branching-and-commiting`
- `docs.gitbutler.com/cli-guides/cli-tutorial/conflict-resolution`
- `crates/WORKSPACE_MODEL.md` (repo source)
- `crates/but-worktrees/src/lib.rs`
- `crates/but-core/src/ref_metadata.rs` (file listing)
- `crates/but-db/src/` (file listing: `handle.rs`, `migration.rs`, `worktrees.rs`)

---

## 4. git-town (peer tool — included for comparison)

**Repo:** `git-town/git-town`. **License:** MIT. Go-based CLI.

### 1. Operations exposed + interface

**CLI** (`git town <subcommand>`). Extensive command set.

| Operation needed | git-town command |
|---|---|
| Rebase branch onto base | `git town sync` (updates branch from parent + tracking branch) |
| Merge base into branch | `git town sync` (pulls parent + tracking branch changes) |
| Restack-on-merge | `git town sync` removes shipped branches and rebases descendants; `git town ship` merges a branch and cleans up |
| PR-per-branch | `git town propose` (creates PR/MR via forge CLI or API) |

Stack commands: `append`, `prepend`, `set-parent`, `swap`, `combine`, `detach`,
`diff-parent`, `compress`, `rename`, `delete`, `hack`, `sync`, `propose`, `ship`.

### 2. Where stack topology state lives

**Git config keys: `git-town-branch.<branch>.parent`** — stored in `.git/config` (or a
`git-town.toml` file).

Source: `internal/config/configdomain/lineage_key.go`:
```go
const BranchSpecificKeyPrefix = "git-town-branch."
const LineageKeySuffix = ".parent"
```

Source: `internal/config/configdomain/lineage.go`:
```go
type LineageData map[gitdomain.LocalBranchName]gitdomain.LocalBranchName
```

The lineage is a map of branch→parent stored as git config entries. This is **standard git
config** — writable by `git config git-town-branch.feature-b.parent feature-a`.

From the docs (`www.git-town.com/configuration`):
> "If your repository already contains a git-town.toml, .git-town.toml, or .git-branches.toml
> file, you're all set."

`git town set-parent <branch>` is the CLI command to set a branch's parent. From the
`set-parent` docs:
> "The set-parent command moves a branch and all its children below another branch."

### 3. Offline / local-only viability

**Has an explicit offline mode.** From `www.git-town.com/commands/offline`:
> "Git Town skips all network operations in offline mode."

`git town offline yes` enables it. All local operations (sync without push, rebase, set-parent,
append, prepend, etc.) work offline. Only `propose` (PR creation) needs network.

### 4. Per-repo vs. global workspace

**Per-repo.** Config is in `.git/config` or a `git-town.toml` in the repo. No global workspace
or virtual-branch concept. Works with real git branches.

### 5. Can it be driven from an EXTERNAL topology?

**YES — and the most cleanly of any tool evaluated.** The topology is stored as standard git
config keys (`git-town-branch.<branch>.parent`), which nodeterm can write directly:

```sh
git config git-town-branch.feature-b.parent feature-a
git config git-town-branch.feature-c.parent feature-b
```

Then `git town sync` or `git town set-parent` operates on that topology. nodeterm's link model
maps 1:1 to git-town's lineage config — each nodeterm dependency link becomes one
`git-town-branch.<child>.parent <parent>` config entry.

`git town set-parent <branch>` is the CLI ingestion point, but writing the config directly is
also valid (the config IS the source of truth for lineage).

**Verdict: directly and cleanly drivable.** The topology is plain git config. nodeterm writes
config from its link model, then invokes `git town sync` / `git town propose`. No
reconciliation burden — nodeterm's links ARE the git-town lineage.

### 6. Coexistence with git worktrees

**Not explicitly documented** [unverified]. Since git-town stores lineage in `.git/config`
(which is shared across linked worktrees in the main `.git` directory), the topology would be
visible from any worktree. However, `git town sync` rebases branches (checking them out),
which would conflict if a branch is checked out in another worktree.

git-town does not impose a workspace/virtual-branch concept, so there's no fundamental model
conflict — just the practical checkout-during-rebase issue that all branch-based tools share.

### Sources
- `git-town/git-town` README
- `internal/config/configdomain/lineage_key.go` (source: `BranchSpecificKeyPrefix = "git-town-branch."`, `LineageKeySuffix = ".parent"`)
- `internal/config/configdomain/lineage.go` (source: `LineageData map[LocalBranchName]LocalBranchName`)
- `www.git-town.com/commands/set-parent` (docs)
- `www.git-town.com/commands/sync` (docs)
- `www.git-town.com/commands/offline` (docs)
- `www.git-town.com/configuration` (docs)

---

## 5. stgit / stacked-git (peer tool — included for comparison)

**Repo:** `stacked-git/stgit`. **License:** GPL-2.0. Rust-based CLI (`stg`).

### 1. Operations exposed + interface

**CLI** (`stg`). Patch-stack model (not branch-stack model).

| Operation needed | stg command |
|---|---|
| Rebase branch onto base | `stg rebase` (rebase a patch onto a new base) |
| Merge base into branch | N/A (stgit works with patches, not branch merges) |
| Restack-on-merge | `stg rebase` / `stg float` (reorder patches) |
| PR-per-branch | N/A (stgit has no PR integration) |

Commands: `stg new`, `stg push`/`stg pop` (push/pop patches on the stack), `stg rebase`,
`stg float`, `stg fold`, `stg pick`, `stg commit` (convert patch to real commit).

### 2. Where stack topology state lives

**In git refs + stgit's own patch metadata.** Patches are stored as git commits with stgit
metadata refs under `refs/heads/` and `refs/thin-pool/`. The patch stack is the series of
applied patches on a branch.

Source: README states "StGit is implemented in Rust" and "works within the context of a Git
repository and performs many operations by running subordinate `git` commands." Man pages at
`stacked-git.github.io/man`.

### 3. Offline / local-only viability

**Fully local/offline.** No network, no account, no forge integration at all. Pure local
patch management.

### 4. Per-repo vs. global workspace

**Per-repo, per-branch.** Each branch has its own patch stack. No global workspace.

### 5. Can it be driven from an EXTERNAL topology?

**No — fundamentally different model.** stgit manages a stack of **patches** (not branches).
A "stack" in stgit is a series of applied patches on a single branch, not a chain of
branches each with their own PR. nodeterm's link model is branch→branch dependencies, not
patch ordering within a branch.

There is no concept of "branch A depends on branch B" in stgit — it's "patch 1 is below
patch 2 on this branch."

**Verdict: incompatible model.** stgit is a patch-stack tool (like quilt on top of git), not
a branch-stack tool. nodeterm's link model has no mapping to it.

### 6. Coexistence with git worktrees

Works within a git repository (per-branch patch stacks). No documented worktree issues, but
the patch-stack model (modifying branch history via patch push/pop) would conflict with
worktrees that have the same branch checked out.

### Sources
- `stacked-git/stgit` README
- `stacked-git.github.io/man/stg` (man pages, referenced from README)

---

## Comparison Table

| Axis | Graphite (`gt`) | gh-stack (`gh stack`) | ghstack (ezyang) | GitButler (`but`) | git-town | stgit |
|---|---|---|---|---|---|---|
| **Topology state** | `.git/` metadata (private format) | `.git/gh-stack` JSON + GitHub Stack object | Commit history + GitHub PR metadata | Own DB + workspace metadata | **Git config** (`git-town-branch.<b>.parent`) | Patch refs in git |
| **Drivable from external topology?** | Partially — `gt branch track` ingests, but parent must match git history | **Yes — `gh stack link` / `init` accept declarative branch order** | No — infers from commit history | No — owns workspace in own DB | **Yes — write git config directly** | No — patch model, not branch model |
| **Offline/local-only?** | Partial (local ops yes; PR submit needs Graphite auth) | Partial (local ops yes; PR/Stack needs `gh` auth) | No (always needs GitHub API) | **Yes** (forge auth optional) | **Yes** (explicit `offline` mode) | **Yes** (no network at all) |
| **Per-repo vs. workspace** | Per-repo | Per-repo | Per-repo (commit-based) | **Workspace / virtual branches** (conflict) | Per-repo | Per-repo, per-branch |
| **Worktree coexistence** | Experimental; rebase conflicts if branch checked out elsewhere | Not documented; `link` avoids local state entirely | Works (commit-based) but model conflicts | Own worktree DB; conflicts with external worktrees | Not documented; shares `.git/config` across worktrees | Not documented |
| **Rebase onto base** | `gt branch/stack/upstack restack` | `gh stack rebase` | `git rebase` (manual) | `but pull` / `but rebase` | `git town sync` | `stg rebase` |
| **Merge base into branch** | `gt repo sync --restack` | `gh stack sync` | N/A | `but pull` | `git town sync` | N/A |
| **Restack-on-merge** | Semi-manual (`repo sync --restack` + `submit`) | Auto (`rebase` switches to `--onto` on merged PR) | N/A | Automatic (push updates review bases) | `git town sync` (removes shipped, rebases descendants) | N/A |
| **PR-per-branch** | `gt stack submit` (needs Graphite auth) | `gh stack submit` / `gh stack link` (needs `gh` auth) | `ghstack` (needs GitHub token) | `but pr new` (needs forge auth) | `git town propose` (needs forge auth) | N/A |
| **Network/account needed?** | Graphite account + GitHub | `gh` CLI auth (GitHub) | GitHub PAT | None for local; forge auth for PRs | None for local; forge auth for PRs | None |
| **License** | Commercial (free CLI tier) | MIT | Open source (BSD) | Fair Source (MIT after 2yr) | MIT | GPL-2.0 |

---

## Recommendation for nodeterm

### Primary recommendation: `git-town`

**git-town is the best fit for nodeterm's integration model.** Here's why:

1. **Topology is plain git config.** git-town stores branch parentage as
   `git-town-branch.<branch>.parent` in `.git/config`. nodeterm can write these config
   entries directly from its own link model — each nodeterm dependency link (A depends on B)
   becomes `git config git-town-branch.A.parent B`. No reconciliation, no "ensure history
   matches first" step, no tool-owned metadata to fight. nodeterm's links ARE the git-town
   lineage.

2. **Local-first with explicit offline mode.** `git town offline yes` disables all network
   operations. All stack operations (sync, rebase, set-parent, append, prepend) work
   offline. Only `git town propose` (PR creation) needs network — and that's optional.

3. **Per-repo, no workspace/virtual-branch concept.** git-town works with real git branches
   in a real repo. No conflict with nodeterm's worktree-per-branch model.

4. **No separate account or hosted service.** git-town is MIT-licensed, self-contained, and
   uses the user's existing `gh` CLI or forge token for PR creation. No Graphite-style
   intermediary service.

5. **Operations map cleanly:**
   - Rebase onto base → `git town sync` (or `git town sync --stack` for the whole stack)
   - Merge base into branch → `git town sync` (pulls parent + tracking changes)
   - Restack-on-merge → `git town sync` (removes shipped branches, rebases descendants)
   - PR-per-branch → `git town propose` (creates PR via forge API)

### Integration shape

```
nodeterm link model (source of truth)
        │
        ▼
  for each link (child → parent):
    git config git-town-branch.<child>.parent <parent>
        │
        ▼
  git town sync      ← rebase + merge base + restack-on-merge
  git town propose   ← PR-per-branch (optional, needs forge auth)
```

nodeterm would:
1. On link creation/modification: write the corresponding `git-town-branch.*.parent` config
   in the worktree's `.git/config`.
2. On "sync stack" action: shell out `git town sync` in the worktree's cwd.
3. On "create PRs" action: shell out `git town propose` (or `git town propose --branch <name>`).
4. On "ship branch" action: shell out `git town ship`.

### Secondary option: `gh-stack` (for GitHub-native PR stacks)

If nodeterm specifically wants GitHub-native Stacked PRs (the `Stack` object on GitHub.com
that links PRs visually), `gh stack link` is the cleanest external-topology entry point:

```sh
gh stack link --base main feature-auth feature-api feature-ui
```

This accepts a declarative branch ordering (which nodeterm computes from its links), pushes
branches, creates PRs with correct base chaining, and creates the GitHub Stack — all without
local tracking state. It requires `gh` CLI auth but no separate account.

**Trade-off vs. git-town:** gh-stack's `link` is better for PR creation on GitHub, but
gh-stack's restack (`rebase`) uses local tracking state (`.git/gh-stack`) which would need
to be kept in sync with nodeterm's links via `gh stack init <branches...>`. git-town's
config-based topology is simpler to keep in sync because it's just git config keys.

### Not recommended

- **Graphite:** requires a Graphite account for PR submission; topology metadata is in a
  private format in `.git/`; `branch track` requires git history to match the declared
  parent (reconciliation burden); worktree support is explicitly experimental with known
  conflicts.
- **ghstack (ezyang):** commit-based, not branch-based; no restack concept; always needs
  network; fundamentally incompatible with nodeterm's branch-link model.
- **GitButler:** imposes its own workspace/virtual-branch concept that competes with
  nodeterm's worktree model; topology is in an internal database with no external write API;
  the two tools have conflicting mental models of how branches relate to working directories.
- **stgit:** patch-stack model (patches within a branch), not branch-stack model; no PR
  integration; incompatible with nodeterm's link model.

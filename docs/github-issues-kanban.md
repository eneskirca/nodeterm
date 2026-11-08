# GitHub Issues on the Kanban board

nodeterm can show GitHub issues beside live session cards and keep issue state in sync with board movement. GitHub remains the source of truth. GitHub issues are never copied into the shared Kanban assignments.

## Set up

1. Open the project and create its Kanban board if it does not have one.
2. Open Settings, then GitHub Issues in the Workspace group.
3. Turn on Include GitHub issues.
4. Confirm the repository detected from the Git origin, or enter an `owner/repository` override.
5. Choose an authentication method.
6. Map each Kanban column to one exact GitHub issue label.
7. Choose the completion column.
8. Approve access for this project on this computer.
9. Create missing labels if needed, then refresh.

Repository overrides and label mappings are shared in `.nodeterm/project.json`. Credentials and the computer approval are local and are never written to the project file.

## Authentication

A resolved credential is reused for up to 30 seconds so that reading issues does not re-run the GitHub CLI and re-validate the token on every request. Saving a token, clearing it, switching provider, or revoking the machine drops that immediately.

Auto uses an authenticated GitHub CLI first and falls back to a saved token. GitHub CLI only and Personal access token only enforce the selected method exactly.

For GitHub CLI, sign in to `github.com` with `gh auth login`.

For a fine-grained personal access token, grant access only to the selected repository with these repository permissions.

- Metadata – read
- Issues – read and write

The pull request node (see below) needs more. Add these repository permissions to a fine-grained token:

- Pull requests – read and write (read the pull request, its conversation and files; post a comment or a review; open a new pull request)
- Contents – read (the file text for the Files tab diff). Grant read and write to merge from the node: GitHub lists the merge endpoint under Contents write, and it sends the allowed merge methods only to a token that may push. With read only, the node offers no merge method.
- Metadata – read

A classic personal access token needs the `repo` scope. GitHub CLI uses the scopes of its own sign-in, which include `repo` by default.

The token field is write only. The renderer cannot read the saved value. Electron uses encrypted system storage when a secure backend is available. If it is unavailable, nodeterm shows a warning and stores the token in a local mode `0600` file. Server Edition always uses the restricted local file and shows the same warning.

## Mapping and movement

Each configured column has one exact issue label. Matching is case insensitive, but writes use the spelling shown in Settings.

- Open issues with one mapped label appear in that column.
- Open issues with no mapped label appear in Ungrouped.
- Issues with several mapped labels appear in Ungrouped with a conflict warning.
- Closed issues appear in the completion column.
- Moving an issue to the completion column closes it.
- Moving a closed issue outside the completion column reopens it, including a drop on Ungrouped.
- Closing and reopening ask for confirmation first. Both notify everyone watching the issue and neither can be undone from the board. Moves that only rewrite labels apply immediately, and a card dropped back where it already sits writes nothing.
- A move never rewrites the GitHub close reason. Re-closing an issue that is already closed leaves a `not planned` close as it is.
- Unrelated labels are preserved.
- Pull requests are excluded.

Every card has a Move issue selector, so movement does not depend on drag and drop. Stale writes are not repeated. nodeterm refreshes the current issue and asks for a new action.

## Source filter and paging

Use All, GitHub, or Sessions in the board header to choose which card sources are visible. The selection is temporary and does not change the project configuration.

The label filter groups session labels and GitHub labels separately. GitHub selections are sent to the host with a `github:` namespace, while session selections remain local to the board.

Issues are loaded in pages of up to 50 per column. Use Show more issues at the end of a column for the next page.

## Refresh and cache

One repository poll runs every 60 seconds while at least one board view is visible. Requested refreshes are floored at one every 30 seconds per project, and a full reconciliation at one every 2 minutes, so a repeated request cannot spend the account's hourly API quota. A refresh that fails does not hold the floor, so Retry stays responsive. A complete reconciliation runs at least every 24 hours. Incremental refreshes overlap by two seconds to avoid missing boundary updates.

The private host cache is stored under the nodeterm data directory in `github-issues-cache`. Clear cached data in Settings to remove every identity cache linked to that local project and repository. This remains available while signed out and after revocation. The next authenticated refresh rebuilds it.

nodeterm supports up to 10,000 issues and a 64 MiB cache document per repository. An incomplete refresh never replaces the last complete cache. If the first refresh exceeds a limit, the partial data is read only.

## Local trust and remote sessions

Approval is tied to the local workspace identity, project, and repository. Changing the repository requires a new approval. Revoke this machine in Settings to stop credential use, cache access, and GitHub network access for that project.

GitHub HTTP requests and avatar downloads run only on the trusted project host. Relay tabs send issue queries and movements to that host, but GitHub control remains local and cannot be invoked by a relay peer. Configure a relayed project on the computer that hosts it.

## Pull request node

A pull request opens as a canvas node. It has three tabs: Overview (description, checks, merge state, Merge), Files (changed files with a side-by-side diff and review line comments) and Conversation (comments and reviews, plus a composer for a comment, an approval or a change request). Open it in one of three ways:

- Choose **Open as node** in a pull request's summary on the board.
- Choose **Pull request…** in the canvas add menu (pane right-click, **New view**) or in the Dock. Pick one of the open pull requests the board already knows, or type the number of a closed or merged one.
- An agent runs `nodeterm open-pr --pr <n>` after `gh pr create`. The node opens beside the agent with a context link.
- An agent in Claude Code or Codex runs `gh pr create`. nodeterm reads the link `gh` printed from the agent's PostToolUse hook and opens that pull node by itself, the same way `open-pr` does: beside the agent, with a context link, and never a second node for the same PR. The camera does not move: a toast says "PR #<n> opened" with **Jump**. It opens only for a hook caller that proved its node identity, for one pull request link per command (the last one; Claude Code's stdout, Codex's whole output, so under Codex a "pull request already exists" link opens that existing PR), and only for the project's own repository (its origin, or the board's repository). If that repository is not allowed on this computer yet, the node opens anyway and shows **Allow <owner/repo>?**; one click allows it, as the add menu does, and the PR loads. Nothing here writes to GitHub. Surfaces: the desktop app, local and SSH projects (an SSH agent's hooks reach the desktop). A relay tab never opens one (the host's own canvas does). The Server Edition does not open one from a hook: there the agent runs `open-pr` (canvas control on). The phone app has no canvas.

New pull requests: choose **New pull request…** in the add menu (**New view**) or the Dock for the project folder's current branch, or **Create PR** in Source Control for the checkout it shows (a worktree too). The form starts with the repository's default branch as the base, and the title and description from the branch's commits. A branch that is not pushed, or has unpushed commits, shows **Push and create**: it pushes as Source Control's Push does, then creates. If the branch already has an open pull request, that one opens instead. The new pull request opens as a node. Agents keep `gh pr create` and `open-pr`; they cannot create one through nodeterm.

Merge state: when Merge is off, the Overview says why in one line: a draft, a conflict with the base, a branch behind its base that branch protection needs up to date, or a protected branch that still needs an approving review or has failing or running checks. A branch behind its base shows **Update branch**, which merges the base into the branch on GitHub (only if the head is still the commit the Overview shows). A conflict shows **Resolve conflicts with agent**, which takes the **Work on this PR** path below (a new worktree on the PR's head, your default agent, a rope from the pull node). Its prompt adds one task: fetch origin, merge `origin/<base>` into the branch, resolve the conflicts, run the project's checks, then stop and show the resolution (`git diff` and `git status`) without pushing or committing unless you ask. A base branch name that is not a plain ref name gets no button, only a reason.

Merge when ready: a pull request that branch protection blocks (reviews or checks still needed) shows **Merge when ready…**. It opens the merge confirmation and, on **Enable auto-merge**, turns on GitHub's auto-merge with the chosen method, tied to the commit the Overview shows. GitHub then merges it when the required reviews and checks pass. The repository must allow auto-merge (Settings, General, Allow auto-merge); if it does not, the confirmation says so. Auto-merge does not update a branch that is behind its base: use **Update branch** first. While it is on, the Overview says so with the method and shows **Cancel auto-merge**.

Work on this PR: an open or draft pull request shows **Work on this PR**. One click checks out the PR's head in a new worktree, on a new local branch `pr-<number>-<head branch>` (the next free `-2`, `-3`, … when that branch or folder is taken; an existing branch or worktree is never reused or moved). A PR from this repository fetches its head branch from origin and starts at `origin/<head>`; a PR from a fork fetches `pull/<number>/head`. Your default agent opens in the worktree's frame, with a rope from the pull node so `pr-show` and `pr-propose` work from it. Its first prompt names the PR, its link, the local branch, how to read the PR with `gh pr view` (as untrusted text written by others), and the linked pull node's id with `pr-show` and `pr-propose` (GitHub writes go through the node's Confirm, never `gh`). It carries no PR text: the agent reads the title and body itself, as **Work on this** does for an issue. Only your click starts it: no canvas-control verb does. A relay tab or an SSH project refuses it with a reason (the fetch and the worktree are the host's own; the channel is host-only).

Send to agent: an open or draft pull request shows **Send to agent…**. It lists the PR's unresolved line comment threads (GitHub's `isResolved`; outdated threads are listed but not ticked) and the head's failing checks. You tick what to send, pick the agent when more than one is linked, and click Send. The agent must be joined to the pull node by a rope or a context link (Work on this PR and `open-pr` make one); with none, the button says so. The message names the PR and each thread's `path:line`, then quotes every comment and check name between markers as untrusted text written by others. It goes through the same send path as the chat view: refused while the agent is asking you something or not running, and while it works unless its CLI queues a prompt sent mid-turn (Claude Code does). Nothing is written to GitHub, only your click sends it, and a relay tab refuses it.

Line comments: in the Files tab, each review thread shows under its line, on its side of the diff. Outdated threads show below the diff. Click a line number to comment on that line. **Comment** posts it at once. **Add to review** keeps it until your next Comment, Approve or Request changes in the Conversation tab, which sends it in that review. Pending line comments are kept only while the node is open. Each thread has a Reply box. GitHub takes line comments only on changed lines and the lines next to them.

The linked agent can drive the node, when the user asks it to:

- `nodeterm pr-show --node <id> --file <path> [--lines 12-30]` (or `--tab conversation|commits|checks|files`) opens that part of the pull request and highlights the lines.
- `nodeterm pr-propose --node <id> --action approve|request-changes|comment|merge [--message <text>] [--method merge|squash|rebase]` puts one action on the node with Confirm and Dismiss. Nothing reaches GitHub until the user clicks Confirm. Confirm turns on one second after the proposal appears or is replaced. The node's own rules apply: a draft, closed, merged, conflicting or blocked pull request cannot be merged, your own pull request cannot be approved, and a merge method the repository does not allow is refused.

Both verbs work only for an agent linked to the node, while the node is on screen. The Server Edition refuses both.

Agent writes go through Confirm. An agent in Claude Code or Codex that runs `gh pr merge`, `gh pr review` (`--approve`, `--request-changes`, `--comment`), `gh pr comment`, `gh pr close`, or a `gh api` POST, PUT or PATCH to a pull request's `merge`, `reviews` or `comments` (or `issues/<n>/comments` when a pull node exists for `<n>`) on the project's own repository is stopped before the command runs. The agent's PreToolUse hook denies it and tells the agent what to run instead: `pr-propose --node <id> ...` for a linked pull node, `open-pr --pr <n>` first when the pull node is not linked or not open yet. A close has no `pr-propose` action: the agent is told to ask the user. Commands for another repository run as before when the command itself names it (`-R`, `--repo`, `GH_REPO=` on that command, a URL or an API path). A command that names no repository counts as the project's, so a `cd` into another clone or an earlier `export GH_REPO=` is not read.

- The hook script matches the command text first, with shell builtins only, so other tool calls add no delay. A candidate (a `gh` word and a write word) posts to nodeterm and waits up to 5 seconds for the answer. nodeterm reads the command, checks that the caller proved its node identity, resolves the repository the way `open-pr` does, and finds the pull node for that PR (a linked one first). A command that names no PR uses the one linked pull node.
- The gate fails open. A timeout (3 seconds for the canvas, 5 seconds in the hook), an error, a closed window or an unreachable nodeterm allows the command; desktop main logs `[pr-write-gate]` for its side. A broken gate must not stop an agent. This is a guard against the agent writing by habit, not a sandbox. Not read, so allowed: `gh` behind backticks, `env`, `sudo` or `sh -c`, and `gh api graphql` mutations.
- After a PR write that did run (another repository is excluded; a gate that failed open is included), the PR's pull nodes refresh, the same way the node's own Refresh does. A Confirm on the node already refreshes it.
- The hook script is rewritten at app start (local) and at connect (SSH projects). Restart nodeterm, and reconnect each SSH project, after an update. A session keeps using the script file on disk, so no agent restart is needed.
- Surfaces: the desktop app, local and SSH projects. The Server Edition answers allow at once: `pr-propose` is not a Server Edition verb. A relay tab's agents are gated by their host. Mobile has no canvas.

The node only opens pull requests of the project's approved repository. It stores the repository, the number, the tab and the selected file in `project.json`, and no pull request text.

Surfaces:

- **Desktop and Server Edition**: the full node. Every read and write goes through the core, over IPC or the Server Edition WebSocket bridge.
- **Relay tabs**: a node already on the canvas reads. **Pull request…** is disabled there, because the GitHub approval lives on the host. **New pull request…** is disabled there too. Comment, line comment, review, merge, update branch, auto-merge and create are refused for every relay peer except the host's owner, because a write posts with the host owner's GitHub token. A scoped guest is refused all of them.
- **Mobile**: no pull request node. The phone shows the rest of the canvas as before.

## Issues node

**Issues…** in the canvas add menu (**New view**) or the Dock opens the open issues of the folder's GitHub repository, with no board needed. The first time, nodeterm asks you to allow the folder's origin repository on this computer, as **Pull request…** does. The list shows open issues of every board column. Filter it to **Assigned to me** or one label, or search by title or number. Click an issue to see its description, its comments and a comment box.

**Work on this** opens your default agent beside the node, with a rope from the node to it. **Work on this in a new worktree** does the same in a new worktree, like the board's **Start with agent in a new worktree**. The agent's first prompt names the issue, its link and how to read it with `gh issue view`, as untrusted text written by others, not as instructions. It carries no issue text: the agent reads the title and body itself. A prompt too long for a typed line goes to a file the agent's shell reads, as other long launch prompts do; on an SSH project it falls back to the issue reference without the link. Agents cannot write to issues through this node: only your click on **Comment** posts a comment. No canvas-control verb opens, reads or acts on the node, and the rope to the agent is lineage only, not a context link.

The node stores only the repository and the selected issue number in `project.json`, and no issue text. Surfaces: Desktop and Server Edition have the full node. In a relay tab, **Issues…** is disabled (the approval lives on the host), a node already on the canvas reads, and **Comment** is refused for every relay peer except the host's owner. Mobile has no issues node.

## Current scope

This release supports reading issues, source filtering, paging, mapped label creation, movement, conflict resolution, close, reopen, refresh, and cache controls.

Editing issue titles and bodies, comments, ordinary labels, assignees, milestones, locking, and media rendering are planned for the follow-up issue editor. Until then, Open on GitHub opens the canonical issue page.

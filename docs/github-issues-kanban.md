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
- Pull requests appear as their own read-only lane. They carry no Move control and never drag: the board writes nothing to a pull request.

Every card has a Move issue selector, so movement does not depend on drag and drop. Stale writes are not repeated. nodeterm refreshes the current issue and asks for a new action.

## Source filter and paging

Use All, Issues, Pull requests, or Sessions in the board header to choose which card sources are visible. The selection is temporary and does not change the project configuration.

The label filter groups session labels and GitHub labels separately. GitHub selections are sent to the host with a `github:` namespace, while session selections remain local to the board.

Issues are loaded in pages of up to 50 per column. Use Show more issues at the end of a column for the next page.

## Linking sessions to issues and pull requests

A session, note, browser node, or group frame can be attached to one or more issues or pull requests. **A link only ever exists because you made it.** Nothing is inferred from terminal output, a transcript, or a branch name.

Attach from the node's right-click menu, a board card's right-click menu, or the GitHub row of the card modal's metadata strip. Type `#123`, part of a title, or a github.com link for this project's repository; a link for another repository is refused, because a link's repository is always the project's.

The node then wears a `#123` chip (with `+n` when it carries several) on the canvas, on its board card, and in the card modal. Its dot shows the item's state — open, closed, draft, merged — and clicking the chip opens the details, the item on GitHub, or a detach. Attaching and detaching are recorded in the board log.

Links are stored on the node in `.nodeterm/project.json`, so they travel with the repository like the rest of the canvas, and are normalized as untrusted input on every read and write. There is no reverse indicator on the GitHub card yet: an issue does not know which sessions point at it.

Canvas chips hold no host subscription. A chip's state is refreshed when it is first painted and then at most every 5 minutes, plus whenever the board is opened.

## Refresh and cache

One repository poll runs every 60 seconds while at least one board view is visible. Requested refreshes are floored at one every 30 seconds per project, and a full reconciliation at one every 2 minutes, so a repeated request cannot spend the account's hourly API quota. A refresh that fails does not hold the floor, so Retry stays responsive. A complete reconciliation runs at least every 24 hours. Incremental refreshes overlap by two seconds to avoid missing boundary updates.

The private host cache is stored under the nodeterm data directory in `github-issues-cache`. Clear cached data in Settings to remove every identity cache linked to that local project and repository. This remains available while signed out and after revocation. The next authenticated refresh rebuilds it.

nodeterm supports up to 10,000 issues and a 64 MiB cache document per repository. An incomplete refresh never replaces the last complete cache. If the first refresh exceeds a limit, the partial data is read only.

## Local trust and remote sessions

Approval is tied to the local workspace identity, project, and repository. Changing the repository requires a new approval. Revoke this machine in Settings to stop credential use, cache access, and GitHub network access for that project.

GitHub HTTP requests and avatar downloads run only on the trusted project host. Relay tabs send issue queries and movements to that host, but GitHub control remains local and cannot be invoked by a relay peer. Configure a relayed project on the computer that hosts it.

## Current scope

This release supports reading issues, source filtering, paging, mapped label creation, movement, conflict resolution, close, reopen, refresh, and cache controls.

Editing issue titles and bodies, comments, ordinary labels, assignees, milestones, locking, and media rendering are planned for the follow-up issue editor. Until then, Open on GitHub opens the canonical issue page.

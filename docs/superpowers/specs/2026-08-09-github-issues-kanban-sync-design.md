# GitHub Issues Kanban Sync

**Date** 9 August 2026

**Status** Amended after Sol architecture review, awaiting final written specification review

## Purpose

Add an optional, per-project GitHub Issues integration to nodeterm. Repository issues will appear beside native session cards in the existing Kanban. GitHub remains canonical, while nodeterm provides a fast board, a full issue editor, and controlled two-way changes.

The feature must feel native to nodeterm, work through the existing Electron and Server Edition platform seams, keep credentials outside shared project data, and never claim that an unconfirmed GitHub change has synchronised.

## Confirmed product decisions

### Source of truth

- GitHub is canonical for issue title, body, comments, state, state reason, labels, assignees, milestone, lock state, timestamps, and permissions.
- Nodeterm keeps a machine-local read cache for quick startup and offline reading.
- Offline writes are not supported.
- A local mutation is not shown as complete until GitHub confirms it.
- A newer upstream version produces a visible stale-data conflict instead of an automatic overwrite.
- GitHub has no atomic compare-and-swap operation for general issue edits. Conflict detection is therefore best effort and must not be described as stronger than the API permits.

### Repository scope

- One GitHub repository may be connected to each nodeterm project.
- The repository is detected from the project's Git remote.
- The user may override the detected value with an explicit `owner/repository` value.
- All repository issues are included, open and closed.
- Pull requests returned by GitHub's issues endpoint are excluded.
- Native nodeterm session cards and GitHub issue cards coexist on the same board.
- A board-wide source filter offers `All`, `GitHub`, and `Sessions`. `All` is the default.

### Authentication

- Reuse an existing authenticated GitHub CLI session when available.
- Offer a write-only fine-grained personal access token as a fallback.
- Prefer the GitHub CLI credential when both are available unless the user deliberately chooses the stored token.
- Store that provider choice as non-secret app configuration with `auto`, `gh`, and `token` values. `auto` is the default and prefers `gh`.
- Store provider choice in a dedicated machine-local GitHub control store and expose all three values in the GitHub Issues settings section.
- The token needs repository Metadata read and Issues read and write permissions. The UI must explain that repository permission is also required for labels, assignees, and milestones.
- A dedicated GitHub App device login is a future enhancement. GitHub recommends device flow for desktop applications [2].

### Column mapping

- Each Kanban column has one explicit GitHub label mapping.
- A new mapping defaults to the column title.
- One column is the completion column. The default is the existing `Done` column when present.
- Renaming a Kanban column does not silently rename a repository-wide GitHub label.
- A user may update the mapping deliberately in Settings.
- A confirmed `Create missing labels` action creates absent mapped labels. Routine sync never creates, renames, or deletes repository labels.
- Adding a Kanban column while this machine has approved the integration creates a suggested local mapping from its title. GitHub issue movement to that column remains disabled until its repository label exists.
- Deleting a Kanban column removes its mapping. Deleting the completion column marks configuration incomplete, places closed issues in `Ungrouped`, and disables GitHub mutations until another completion column is selected.
- Closing through nodeterm removes every other mapped label, applies the completion label, and closes the issue in one update.
- Closed state overrides mapped labels for placement. A closed issue always appears in the completion column.
- An externally reopened issue that retains the completion label appears in `Ungrouped` as a state-label conflict. Nodeterm does not mutate it automatically.
- Resolving a state-label conflict through `Move to` removes every mapped label, applies the chosen non-completion label, and keeps the issue open.

### Board placement

- An open issue with exactly one mapped non-completion label appears in that column.
- An open issue carrying the completion label appears in `Ungrouped` with a state-label conflict.
- An open issue with no mapped label appears in `Ungrouped`.
- An open issue with multiple mapped labels appears in `Ungrouped` with a conflict warning.
- A closed issue appears in the completion column.
- Moving an issue to a non-completion column removes other mapped labels, preserves unrelated labels, applies the destination label, and reopens the issue when necessary.
- Moving an issue to the completion column closes it and preserves unrelated labels.
- Native session ordering remains unchanged.
- GitHub issue cards sort by most recent `updated_at`, then descending issue number for a stable tie-break.
- Within a mixed column, native session cards render first in their existing stable assignment order. GitHub issue cards follow in the order above. Source filtering never changes either source's internal order.

## User experience

### Settings

Add `GitHub Issues` under the existing `Workspace` settings group. Build the section from the same `SettingsSection`, `SearchableRow`, `FieldRow`, `Switch`, `Input`, `Select`, and `Button` components used elsewhere.

The section shows

- connection status and authenticated GitHub login without exposing a credential
- a `Sign in with GitHub CLI` action using nodeterm's existing in-app terminal flow
- a write-only token field with Save and Clear actions
- the active project and this machine's approval state
- detected repository and manual override
- one label field per current Kanban column
- completion-column selection
- `Test connection`, `Create missing labels`, `Refresh now`, and `Clear cached GitHub data` actions
- a clear warning if OS-backed encryption is unavailable before storing a token in the restricted-file fallback

Configuration follows the active project. Switching project tabs and reopening Settings shows that project's mapping.

Shared configuration never authorises network access. The first enable action on each machine creates a machine-local approval keyed by the local workspace entry, project id, and normalised repository. A repository change invalidates that approval. Opening a cloned or collaborator-supplied `.nodeterm/project.json` may display its proposed mapping, but it cannot use local credentials, read a private repository, or start polling until the local user confirms access.

### Board header

When this machine has approved the GitHub integration, the board header adds

- `All`, `GitHub`, and `Sessions` source controls
- last successful GitHub refresh time
- a refresh action and progress state
- rate-limit, authentication, stale-cache, or configuration warnings when relevant

Column counts follow the active source filter. Existing label filtering continues to apply after source filtering.

Local and GitHub labels occupy separate namespaces. Filter keys use `local:<labelId>` and `github:<normalisedLabelName>`. The picker groups them by source and shows a GitHub mark for GitHub labels, so equal display names never merge implicitly.

### GitHub issue card

A distinct `GitHubIssueCard` uses the existing Kanban spacing, borders, colors, drag affordances, and focus treatment. It shows

- GitHub mark and issue number
- title
- mapped and ordinary labels, with overflow count
- assignee avatars when present
- milestone when present
- comment count
- open, closed, conflict, syncing, stale, or failed state
- relative update time

The card remains recognisably GitHub-backed without becoming a visually separate lane. Source filtering provides separation when wanted.

### Issue modal

Opening a GitHub card uses a purpose-built `GitHubIssueModal`. It does not reuse the terminal session modal.

The modal supports

- issue creation
- title and Markdown body editing
- rendered body preview
- comment listing and pagination
- comment creation
- editing and deleting comments when GitHub permits it
- label selection
- assignee selection
- milestone selection
- column and state movement
- supported close reason
- conversation lock and unlock
- opening the canonical GitHub page

The main pane holds body and discussion. A metadata sidebar holds status, labels, assignees, milestone, and conversation state. Destructive actions require confirmation. Each mutation has an explicit saving, confirmed, stale, or failed state.

### Large repositories and narrow layouts

- The host issue service retains the complete validated issue set up to a documented support limit of 10,000 issues and a 64 MiB cache document.
- Exceeding either limit produces an explicit `Repository too large` incomplete state. A failed refresh attempt never replaces or prunes the previous complete cache. That last complete snapshot remains readable, but mutations are disabled because its freshness can no longer be established. If the first refresh crosses a limit, its validated records may be exposed only as an explicitly partial, read-only snapshot and are stored separately from the complete-cache slot.
- The renderer requests issue cards by column, filter, search query, cursor, and bounded page size. It never receives all issue bodies in one snapshot.
- Each column initially requests 50 recent issues and offers `Show more`.
- Search, counts, and filters execute against the complete host cache, not only the rendered page.
- At 390px, columns retain the existing horizontally scrollable Kanban behaviour.
- The source filter, non-drag movement control, refresh state, and issue modal remain fully usable at 390px.
- Pointer drag is an enhancement. Every movement is also available through an accessible `Move to` control.

## Architecture

### Project configuration

Extend `ProjectKanban` with optional non-secret GitHub configuration.

```ts
export interface ProjectKanbanGitHub {
  repository?: string
  columnMappings: Array<{
    columnId: string
    label: string
  }>
  completionColumnId?: string
}

export interface ProjectKanban {
  columns: KanbanColumn[]
  assignments: KanbanAssignment[]
  meta?: KanbanCardMeta[]
  labels?: KanbanLabel[]
  github?: ProjectKanbanGitHub
}
```

This proposed mapping is shared through `.nodeterm/project.json`. Local authorisation is not. Add a stable machine-local `localApprovalId` to each `IndexEntryV3` and keep provider choice plus approvals in a dedicated GitHub control store.

```ts
export interface GitHubProjectApproval {
  localApprovalId: string
  projectId: string
  repository: string
  enabled: boolean
  approvedAt: number
}

export interface GitHubControlState {
  version: 1
  revision: number
  authProvider: 'auto' | 'gh' | 'token'
  approvals: GitHubProjectApproval[]
}

export interface IndexEntryV3 {
  localApprovalId?: string
}
```

The workspace store generates `localApprovalId` when an entry is created or first loaded without one and keeps it only in the machine-local workspace index. It preserves this value across every index save and migration. Approval and issue execution require a non-empty `localApprovalId`; they never substitute the shared project id or `IndexEntryV3.id`. The control store writes atomically, checks an expected revision on every update, and exposes dedicated transactional Approve, Revoke, Select provider, Save token, and Clear token handlers. A stale client receives a conflict and reloads instead of replacing the whole state or resurrecting a revoked approval.

Credentials, approvals for other machines, issue snapshots, comments, ETags, refresh metadata, provisional mutations, and safe errors never enter the shared project file or the general Settings save path.

One canonical `normaliseProjectKanbanGitHub` function validates every read and write. It

- trims and validates `owner/repository`
- bounds every label to GitHub's supported length and rejects empty names
- compares labels by trimmed Unicode-normalised case-folded name
- requires unique column ids and unique normalised labels
- removes mappings to unknown columns
- accepts a completion id only when it names a live mapped column
- returns explicit readiness errors rather than silently inventing a winner

Every board transform must preserve unrelated `ProjectKanban` properties with object spread. Column addition and deletion update mappings through the same normaliser. Round-trip tests cover old project files, malformed shared input, every board transform, duplicate mappings, case variants, unknown columns, and invalid completion ids.

Readers validate every field defensively. A malformed GitHub block disables the integration without dropping the rest of the Kanban. A missing mapping degrades that issue to `Ungrouped`. A repository change invalidates its machine-local approval before any request is made.

### Credential resolver

A focused credential resolver runs only in the trusted host process.

Resolution is exact.

| Selected provider | Behaviour |
|---|---|
| `auto` | Validate GitHub CLI authentication first. If unavailable or rejected, validate the stored token. Report authentication required only when neither is valid. |
| `gh` | Use only a valid GitHub CLI credential. Never fall back to the stored token. |
| `token` | Use only the stored token. Never fall back to GitHub CLI. |

The renderer may save, clear, select, and query credential presence. It may never read a token. The service must redact bearer values and token-like query parameters from every error before logging or returning it.

Electron stores a pasted token encrypted with `safeStorage` only when encryption is available and `safeStorage.getSelectedStorageBackend()` does not report `basic_text`. Electron documents `basic_text` as an unprotected Linux fallback [6]. If a supported OS keyring is temporarily locked, the intact encrypted value is not overwritten. Server Edition, `basic_text`, and systems without available encryption use an atomic `0600` restricted file after explicit warning. Clearing a token removes the credential file but does not change the GitHub CLI login.

### Execution locality

| Project surface | Repository detection | Credential, cache, and GitHub HTTP | Approval authority |
|---|---|---|---|
| Local Electron project | Local Git service | Electron host | Main local window only |
| Server Edition project | Server Git service | Server host | Authenticated server settings client |
| Relay-hosted project | Relay host core service | Relay host | Host owner's local settings only |
| Electron-managed SSH project | Existing remote Git executor reads the SSH repository remote | Electron host, using the desktop user's GitHub identity | Main local window only |
| Inline project without a working directory | Manual repository override | Owning Electron or Server host | Owning host's settings client |

The GitHub issue data namespace is core-bound, so a relay tab reads and mutates through the relay host. Credential Save, Clear, provider selection, and first-use approval remain host-control operations. Electron registers them through local-window handlers that verify the sender is the main window. Server Edition registers revision-checked handlers for its authenticated settings client. Relay dispatch maintains an explicit deny set for every `githubControl:*` channel before generic RPC dispatch, so an approved peer cannot invoke them by constructing a raw request. An already approved relay-hosted project may expose its bounded issue operations to authorised peers while its credential remains on the host. Electron-managed SSH support deliberately keeps the GitHub token off the SSH host. A future SSH-host credential mode would be a separate design.

### GitHub issues client

Create a focused REST client rather than a general arbitrary-URL proxy. It owns

- authentication headers
- the current GitHub REST API version header
- fixed `api.github.com` endpoint construction
- repository and issue-number validation
- request and overall-operation timeouts
- Link-header pagination
- conditional GET requests with ETags
- response-size and collection-count bounds
- runtime response validation
- rate-limit interpretation and backoff
- bounded manual redirect handling
- safe error conversion

Redirects are followed manually for at most three hops. Every target must remain HTTPS on `api.github.com`. The client refuses a cross-host or protocol-changing redirect and never forwards authorisation to another origin.

Its interface exposes issue-domain methods only.

```ts
interface GitHubIssuesClient {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>
  createIssue(repository: string, input: CreateIssueInput): Promise<GitHubIssue>
  updateIssue(repository: string, issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue>
  listComments(repository: string, issueNumber: number, page: PageRequest): Promise<CommentPageResult>
  getComment(repository: string, commentId: number): Promise<GitHubComment>
  createComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment>
  updateComment(repository: string, issueNumber: number, commentId: number, body: string): Promise<GitHubComment>
  deleteComment(repository: string, issueNumber: number, commentId: number): Promise<void>
  listRepositoryLabels(repository: string, page: PageRequest): Promise<LabelPageResult>
  createLabel(repository: string, input: CreateLabelInput): Promise<GitHubLabel>
  listAssignees(repository: string, page: PageRequest): Promise<UserPageResult>
  listMilestones(repository: string, page: PageRequest): Promise<MilestonePageResult>
  lockIssue(repository: string, issueNumber: number): Promise<void>
  unlockIssue(repository: string, issueNumber: number): Promise<void>
}
```

Comment updates and deletes carry project id, issue number, and `expectedCommentUpdatedAt` through the service boundary. Inside the mutation chain, the host calls `getComment` for the specific comment id, validates the response and confirms that its `issue_url` belongs to the expected repository and issue, then compares its `updated_at` with the version shown to the user. A mismatch returns the latest comment as a stale-data result and requires a deliberate retry. Comment id alone is never sufficient authority, and paginated discussion state is never used as proof that a comment is current [5].

GitHub's issue API supports the core issue, label, assignee, milestone, comment, and lock operations in scope [1].

### Issue service

The issue service owns

- per-repository cache loading and atomic persistence
- one in-flight refresh and one poll schedule per repository
- subscription reference counting across attached Electron, Server Edition, and relay clients
- one request coordinator per authenticated GitHub user id across every repository
- one serial mutation chain per issue
- full and incremental refresh scheduling
- mapping issues to Kanban columns
- provisional mutation state
- post-mutation verification
- paged card queries, full-cache search, and bounded change broadcasts through the platform seam

The service accepts injected credential, client, clock, and storage dependencies. Core tests therefore perform no network or keyring access.

The first visible subscriber starts the repository poll and the last unsubscribe stops it. Multiple clients share the same timer and in-flight refresh. Refresh completion broadcasts changed issue ids, totals, readiness, and timing only. Renderers requery affected visible pages rather than receiving the entire repository.

The identity-wide request coordinator permits at most four concurrent reads, serialises mutative requests, and spaces mutations by at least one second. Primary or secondary rate-limit backoff from any repository pauses polls and queued network work for every repository using that GitHub identity. A primary-limit pause lasts until reset. A secondary-limit pause follows `retry-after` or bounded exponential backoff. Identity changes cancel old queued work rather than moving it to a new credential.

### Renderer state

Renderer state is keyed by project id and contains

- bounded visible issue pages and per-column cursors
- complete counts and active query metadata returned by the host
- connection and configuration readiness
- last successful refresh
- last full reconciliation time
- current refresh and rate-limit state
- provisional mutations
- bounded safe error
- in-memory comments for the open issue only

Comments are fetched when a modal opens and are not persisted to disk. Closing the modal may keep them only for a short in-memory time-to-live.

### Remote media

The renderer never loads GitHub media directly. The host may fetch assignee avatars only from validated `https://avatars.githubusercontent.com` URLs returned in authenticated GitHub user objects. It fetches lazily for visible cards and the open modal, disables redirects, requests a small display size, accepts only supported image MIME types, enforces a 128 KiB response limit, and caches the result briefly in memory. Each renderer page response has a 512 KiB aggregate avatar-data budget. Users beyond that budget receive initials. The host exposes only bounded data URLs through issue view models, and every failure falls back to the existing initials avatar.

Markdown images in issue bodies and comments render as labelled links rather than remote images in this release. Ordinary links are sanitised, limited to safe schemes, and opened through the existing external-link boundary. This preserves the current renderer CSP and the host-only network rule.

### Components

- `GitHubIssuesSection` owns Settings presentation.
- `GitHubIssueCard` owns GitHub card presentation and accessible card actions.
- `GitHubIssueModal` owns the issue editor and discussion.
- `KanbanSourceFilter` owns `All`, `GitHub`, and `Sessions` selection.
- `KanbanColumn` renders a discriminated union of native and GitHub cards while keeping source-specific behaviours isolated.
- Pure mapping and filtering helpers stay outside React.

## Data flow

### Initial load and refresh

1. Opening the Kanban validates shared configuration and checks machine-local approval before reading even a private local cache.
2. An approved project reads the machine-local cache and renders the first bounded pages immediately.
3. If configuration and authentication are ready, the host service records a configuration epoch containing `localApprovalId`, project id, normalised repository, mapping revision, control-store revision, credential generation, and authenticated GitHub user id, then starts a refresh.
4. An empty cache or a cache whose separate `lastFullReconciliationAt` is older than 24 hours receives a complete `state=all` paginated refresh.
5. A recent full cache receives an incremental refresh using `since = lastSuccessfulRefreshAt - 2 seconds`. Results merge by issue number and `updated_at`, so the overlap is harmless and second-resolution boundary updates are not lost.
6. Conditional requests use stored ETags where the request identity is stable. The ETag key includes normalised repository, endpoint, API version, complete query, page, and authenticated GitHub user id. It never includes credential material. Correctly authenticated `304` responses do not count against the primary REST limit [3].
7. Valid issues merge by repository and issue number.
8. Pull-request records are discarded before reaching the cache or renderer.
9. Before applying results, the service compares the captured configuration epoch with the current epoch. A repository, mapping, approval, or identity change discards the stale result.
10. A complete result atomically replaces the complete-cache slot. An incomplete result records bounded attempt metadata separately and does not replace or prune the previous complete snapshot. The service then broadcasts bounded change metadata.

The first visible subscriber starts one host-owned 60-second poll per repository. Refresh also occurs when the owning window regains focus after the snapshot is stale. The last unsubscribe stops polling. A manual refresh forces a complete reconciliation. Only a complete successful fetch may remove cache entries no longer returned upstream, and only a complete successful fetch advances `lastFullReconciliationAt`.

### Mutation flow

1. Validate the project configuration, issue identity, requested fields, and input bounds, then capture the complete configuration epoch.
2. Enter the issue's local serial mutation chain.
3. Recompute the epoch inside the chain before any network request. Reject the work if approval, repository, mapping, provider, credential generation, or authenticated identity changed.
4. Fetch the latest issue through the identity-wide request coordinator.
5. Compare its `updated_at` with the version shown to the user.
6. Return a stale-data result when they differ. Refresh the card and require a deliberate retry.
7. Compute the smallest safe mutation from the fresh record.
8. Recompute and compare the epoch immediately before the write.
9. Submit the GitHub request through the identity-wide mutation queue.
10. Validate the confirmed response and compare fields that GitHub can silently ignore when repository permission is insufficient.
11. Update the in-memory snapshot as confirmed.
12. Revalidate the epoch before the post-write refresh. If it changed after GitHub confirmed the write, report the confirmed result without applying it to the new configuration.
13. Refresh the affected issue, persist the cache, and broadcast the result.

The UI may show a provisional location with a `Syncing` state. Failure restores the last confirmed position. A successful GitHub write followed by a cache failure returns the confirmed issue with `Refresh pending`, then heals on the next refresh without repeating the write.

Every issue, comment, label-setup, creation, lock, unlock, and movement operation follows this epoch protocol. An epoch change cancels queued work before its next request. Multi-request setup actions revalidate immediately before every request and report confirmed partial completion without continuing under a changed epoch.

### Column movement

For an open issue moved between non-completion columns

1. Fetch the current issue.
2. Preserve all labels not used by a column mapping.
3. Remove every mapped column label.
4. Add the destination label.
5. Send the resulting label set in one issue update.

Moving to completion performs the same preservation and mapped-label replacement, applies the completion label, and sets state to closed in one issue update. Moving out of completion sets state to open, removes the completion and every other mapped label, and applies the destination mapping. An externally reopened issue that still carries the completion label remains an `Ungrouped` conflict until a user chooses a non-completion destination. Closed state always wins placement, even when the issue has no completion label or has stale mapped labels.

### Issue creation and mapped-label setup

The board header offers `New GitHub issue`, defaulting to the first mapped non-completion column. Each non-completion column also offers `New GitHub issue here`. Creation in the completion column is disabled because GitHub's create endpoint creates an open issue and a second close request would introduce a partial-write state.

The create request sends title, body, destination mapped label, selected ordinary labels, assignees, and milestone in one GitHub operation. It is disabled until the destination label exists. If GitHub confirms creation but local cache persistence fails, the confirmed issue number is retained in memory as `Refresh pending` and the create request is never repeated automatically.

`Create missing labels` lists every exact pending label and colour in its confirmation. Each label colour derives from the mapped Kanban column's six-digit hex colour without `#`; an invalid or non-hex column colour uses the fixed fallback `8b5cf6`. The action relists repository labels before every create, compares names case-insensitively, and treats an already-created match as success. Partial completion reports exactly which labels were created and which remain.

## Cache and retention

- Store one cache document per repository under the host's nodeterm user-data directory, with separate `lastComplete` and `lastAttempt` sections.
- Derive filenames from a stable hash rather than raw repository text.
- Create and replace cache files atomically with mode `0600` because issue bodies may contain private project information.
- Store bounded issue fields, identity-scoped ETags, last incremental and full refresh times, and rate-limit metadata in `lastComplete`. An incomplete `lastAttempt` stores only its status, limit reason, timing, and a bounded first-refresh partial snapshot when no complete snapshot exists.
- Do not store comments, credentials, raw HTTP bodies, arbitrary response headers, provisional changes, or stack traces.
- `Clear cached GitHub data` removes the active repository cache after confirmation.
- Revoking this machine's approval stops network activity and cache reads for that project but retains the cache until the user clears it.

## Error handling

| Failure | Behaviour |
|---|---|
| Shared configuration lacks local approval | No cache read, credential use, or network request until explicit local confirmation |
| No GitHub authentication | Cached board remains read-only with a Settings action |
| Token rejected | Clear authentication guidance without returning token material |
| Repository unavailable or private without access | Cached board remains and configuration is marked unavailable |
| Insufficient write permission | Mutation fails, confirmed card remains, and required permission is explained |
| Network timeout | Cache remains with stale time and manual retry |
| Malformed or oversized response | Reject that response and preserve the last valid cache |
| Repository exceeds the 10,000 issue or 64 MiB support limit | Retain the previous complete cache without pruning, record the attempt as incomplete, and disable mutations. A first-refresh partial snapshot is labelled partial and remains read-only |
| Primary rate limit | Stop polling until `x-ratelimit-reset` |
| Secondary rate limit | Honour `retry-after` or exponential backoff and stop after a bounded retry count |
| Stale displayed issue | Refresh the card and require deliberate retry |
| Multiple mapped labels | Show an `Ungrouped` conflict card and block implicit movement |
| Open issue retains the completion label | Show an `Ungrouped` state-label conflict until an explicit non-completion move |
| GitHub write rejected | Restore provisional UI and show persistent actionable error |
| GitHub write confirmed but cache write fails | Show confirmed data with `Refresh pending` and do not repeat the mutation |
| Project mapping becomes invalid | Disable sync for that project without damaging native Kanban data |

GitHub warns that continued requests during a rate limit may lead to an integration ban. The service must stop and respect the supplied reset or retry time [4].

## Security and privacy

- All GitHub network requests run in the trusted host process.
- Shared project configuration is treated as untrusted input and cannot activate credentials, cache reads, or requests without the matching machine-local approval.
- The renderer receives domain objects, never bearer credentials or arbitrary GitHub responses.
- IPC validates project id, repository, issue number, comment id, collection sizes, text lengths, enum values, and URLs.
- Comment edit and delete requests bind project, repository, issue number, and comment id, verify the trusted comment's `issue_url`, and use the issue mutation chain.
- The client permits only `api.github.com` and validates canonical links against `github.com/<owner>/<repository>`.
- Redirects remain bounded to HTTPS on `api.github.com`; authorisation is never forwarded across origins.
- Repository configuration cannot become an arbitrary server-side request URL.
- HTML and Markdown originating on GitHub are sanitised through the existing renderer boundary before display.
- Issue titles, bodies, labels, comments, assignee names, and avatars render as untrusted data.
- Avatars pass through the bounded host fetcher. Markdown images never load remotely in the renderer.
- Logs may include repository, issue number, operation, HTTP status, and rate-limit timing. They may not include token values, request bodies, issue bodies, comments, authentication headers, or raw GitHub error payloads.
- Credential status reports presence and provider only.
- PAT input is cleared from component state immediately after Save.
- Electron's `basic_text` safeStorage backend is treated as unavailable and triggers the explicit restricted-file warning.
- The PAT is never written to `settings.json`, `.nodeterm/project.json`, the issue cache, tests, screenshots, recordings, or pull-request text.

## Testing strategy

### Unit tests

- repository parsing for HTTPS, SSH, missing, malformed, non-GitHub, and overridden remotes
- machine-local approval, repository-change invalidation, and a hostile cloned project that cannot activate cache or network access
- exact `Auto`, `GitHub CLI only`, and `Personal access token only` fallback behaviour, persisted provider choice, write-only behaviour, locked keyring handling, `basic_text`, restricted-file mode, migration, and redaction
- control-store revision conflicts, atomic writes, `localApprovalId` generation and preservation through index saves and migrations, rejection when it is absent, repository-change invalidation, and proof that a copied project id or stale client cannot restore a revoked approval
- canonical mapping normalisation, duplicate column ids, case-variant labels, empty labels, unknown columns, invalid completion id, and property preservation through every board transform
- issue, comment, label, assignee, and milestone response validation
- pagination, Link headers, pull-request filtering, periodic full reconciliation, overlapping incremental boundaries, identity-scoped ETags, `304`, epoch invalidation, timeouts, malformed JSON, and bounded responses
- bounded same-host redirects and rejection of cross-host or protocol-changing redirects
- identity-wide read concurrency, mutation spacing, primary and secondary rate-limit handling across repositories, identity changes, and queued-work cancellation
- status mapping for open, closed, unlabelled, single-labelled, mapped-label conflicts, and externally reopened completion-label conflicts
- unrelated-label preservation and exact mapped-label replacement
- completion-label close and reopen transitions
- stable mixed-source ordering and namespaced local and GitHub label filtering
- cache atomicity, mode, retention, corrupt-file recovery, last-complete preservation after an incomplete refresh, and an explicitly partial first refresh
- repository support-limit behaviour, paged queries, delta broadcasts, and one poll timer across multiple subscribers
- direct comment fetch validation, comment-to-issue association checks, comment-level `updated_at` conflicts, deliberate retry, and same-issue serialisation
- avatar host validation, disabled redirects, lazy loading, per-image and aggregate page limits, fallback initials, and blocked Markdown images
- issue creation placement, disabled completion creation, missing-label colours, idempotent setup, and partial setup recovery
- epoch revalidation before every queued network request, before every write, and before applying or persisting post-write data
- successful write followed by cache failure without duplicate mutation

### Renderer and DOM tests

- Settings navigation and search entry
- GitHub CLI, token-present, unauthenticated, keyring-warning, and insufficient-permission states
- explicit first-use approval and repository-change reapproval
- token field clears after Save and cannot read back a secret
- project repository override and per-column mapping
- label setup confirmation
- mixed card rendering and `All`, `GitHub`, and `Sessions` filtering
- grouped namespaced label filtering when local and GitHub labels share a display name
- filtered column counts
- cached, refreshing, stale, rate-limited, conflict, provisional, confirmed, and failed card states
- pointer drag and non-drag movement parity
- open-with-completion-label conflict resolution
- keyboard access and focus restoration after movement
- issue creation and editing
- comment create, edit, delete, and pagination
- assignee, label, milestone, state, and lock controls
- desktop and 390px layouts

### Platform and integration tests

- Electron preload contract
- WebSocket bridge contract
- Server Edition handler contract
- remote clients can invoke allowed issue operations while credentials remain host-only
- local Electron, Server Edition, relay-hosted, Electron-managed SSH, and inline-project locality follow the execution matrix
- relay peers cannot save credentials or grant first-use approval, including attempts through raw generic RPC dispatch
- settings and cache paths stay on the host that performs GitHub requests
- no token appears in serialised RPC results or safe errors

### Fresh verification

Run

```sh
npm test
npm run typecheck
npm run build
```

Then verify the running application with deterministic fixture data and, when a safe test repository is available, a real authenticated journey covering

- initial and manual refresh
- issue creation
- title and body editing
- comment creation and editing
- label, assignee, and milestone changes
- drag movement and `Move to`
- close and reopen
- source filtering
- stale-data conflict
- failed mutation rollback
- token clearing and cache clearing

Do not mutate the upstream nodeterm repository merely to obtain test evidence. If no authorised test repository is available, perform a live read-only refresh and keep write verification against the controlled HTTP fixture.

### Visual evidence

Capture screenshots of

- GitHub Settings
- mixed board and each source filter
- issue modal
- conflict, syncing, stale, rate-limited, and error states
- desktop and 390px widths
- dark and light application themes
- existing Kanban before and after the integration

Record a short pointer journey covering refresh, create, edit, comment, move, close, reopen, filtering, and failed-mutation rollback. Record or capture a keyboard-only journey for the essential actions.

Attach compressed screenshots and recordings to the relevant pull request or its test evidence. Do not commit large binary captures. These complement behavioural tests. A new cross-platform pixel-diff framework is outside this feature series because nodeterm has no current visual-regression harness and Electron font rendering would make an initial baseline noisy.

## Delivery

Deliver the approved design as two independently reviewable pull requests. Both remain opt-in through machine-local approval.

### Pull request 1

Build the complete Kanban sync foundation and the core two-way board journey.

1. shared configuration, canonical normalisation, and machine-local trust overlay
2. credential storage and resolution
3. GitHub client, cache, paging, reconciliation, and host-owned subscriptions
4. Electron, Server Edition, relay, and SSH locality contracts
5. GitHub Settings
6. read-only issue cards, counts, search, namespaced filters, and source filtering
7. mapped-label setup, drag and `Move to`, conflict resolution, close, and reopen
8. accessibility, responsive behaviour, documentation, screenshots, recording, and verification

This pull request satisfies the original two-way Kanban requirement without also asking reviewers to approve the full issue-discussion editor. Opening a card provides its safe summary, movement controls, and canonical GitHub link.

### Pull request 2

Build the full issue modal on the reviewed foundation.

1. issue creation in mapped non-completion columns
2. title and Markdown body editing
3. paged comments with create, edit, and delete
4. labels, assignees, milestone, state reason, and lock controls
5. remote avatar handling and Markdown media restrictions
6. complete modal accessibility, responsive behaviour, screenshots, recording, and live verification

Pull request 2 starts only after pull request 1 is reviewed and merged. Each description records authentication behaviour, required permissions, cache retention, best-effort conflict limits, automated checks, live verification boundary, and visual evidence.

## Out of scope

- hosted webhook infrastructure
- background sync while the Kanban is closed
- offline mutation queues
- more than one repository per nodeterm project
- GitHub Enterprise Server custom API hosts
- GitHub Projects v2 fields and ordering
- organisation-specific custom issue fields and issue types
- issue transfer, pinning, reactions, sub-issues, and dependencies
- deleting GitHub issues, which the ordinary issue API does not offer
- automatically renaming or deleting repository labels
- a dedicated nodeterm GitHub App and device login
- automated cross-platform pixel-diff infrastructure

## Completion evidence

Pull request 1 is complete only when

- every foundation, trust, cache, paging, sync, mapping, and movement check passes from a fresh run
- project configuration round-trips without damaging older project files
- credentials never cross into shared or renderer-readable storage
- a live GitHub read succeeds
- a mapped-label move, close, and reopen journey succeeds when an authorised test repository is available
- conflicts, rate limits, permission failures, network failures, and cache-write failures remain recoverable
- pointer, keyboard, desktop, 390px, dark-theme, and light-theme evidence for Settings and the board has been reviewed
- the pull-request diff contains no credentials, cache data, screenshots, recordings, or unrelated changes

The full feature series is complete only when

- every automated check passes from a fresh run
- all approved issue operations are verified with fixtures
- a live write journey succeeds when an authorised test repository is available
- issue-modal pointer, keyboard, desktop, 390px, dark-theme, and light-theme evidence has been reviewed
- both pull requests contain no credentials, cache data, screenshots, recordings, or unrelated changes

## References

1. GitHub. REST API endpoints for issues [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/issues
2. GitHub. Generating a user access token for a GitHub App [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
3. GitHub. Best practices for using the REST API [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
4. GitHub. Rate limits for the REST API [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10
5. GitHub. REST API endpoints for issue comments [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10
6. Electron. safeStorage [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://www.electronjs.org/docs/latest/api/safe-storage

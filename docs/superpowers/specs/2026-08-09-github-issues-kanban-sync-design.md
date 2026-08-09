# GitHub Issues Kanban Sync

**Date** 9 August 2026

**Status** Approved conversational design awaiting written specification review

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
- The token needs repository Metadata read and Issues read and write permissions. The UI must explain that repository permission is also required for labels, assignees, and milestones.
- A dedicated GitHub App device login is a future enhancement. GitHub recommends device flow for desktop applications [2].

### Column mapping

- Each Kanban column has one explicit GitHub label mapping.
- A new mapping defaults to the column title.
- One column is the completion column. The default is the existing `Done` column when present.
- Renaming a Kanban column does not silently rename a repository-wide GitHub label.
- A user may update the mapping deliberately in Settings.
- A confirmed `Create missing labels` action creates absent mapped labels. Routine sync never creates, renames, or deletes repository labels.
- Adding a Kanban column while integration is enabled creates a suggested local mapping from its title. GitHub issue movement to that column remains disabled until its repository label exists.
- Deleting a Kanban column removes its mapping. Deleting the completion column marks configuration incomplete, places closed issues in `Ungrouped`, and disables GitHub mutations until another completion column is selected.

### Board placement

- An open issue with exactly one mapped label appears in that column.
- An open issue with no mapped label appears in `Ungrouped`.
- An open issue with multiple mapped labels appears in `Ungrouped` with a conflict warning.
- A closed issue appears in the completion column.
- Moving an issue to a non-completion column removes other mapped labels, preserves unrelated labels, applies the destination label, and reopens the issue when necessary.
- Moving an issue to the completion column closes it and preserves unrelated labels.
- Native session ordering remains unchanged.
- GitHub issue cards sort by most recent `updated_at`, then descending issue number for a stable tie-break.

## User experience

### Settings

Add `GitHub Issues` under the existing `Workspace` settings group. Build the section from the same `SettingsSection`, `SearchableRow`, `FieldRow`, `Switch`, `Input`, `Select`, and `Button` components used elsewhere.

The section shows

- connection status and authenticated GitHub login without exposing a credential
- a `Sign in with GitHub CLI` action using nodeterm's existing in-app terminal flow
- a write-only token field with Save and Clear actions
- the active project and its enabled state
- detected repository and manual override
- one label field per current Kanban column
- completion-column selection
- `Test connection`, `Create missing labels`, `Refresh now`, and `Clear cached GitHub data` actions
- a clear warning if OS-backed encryption is unavailable before storing a token in the restricted-file fallback

Configuration follows the active project. Switching project tabs and reopening Settings shows that project's mapping.

### Board header

When GitHub integration is enabled, the board header adds

- `All`, `GitHub`, and `Sessions` source controls
- last successful GitHub refresh time
- a refresh action and progress state
- rate-limit, authentication, stale-cache, or configuration warnings when relevant

Column counts follow the active source filter. Existing label filtering continues to apply after source filtering.

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

- The issue service retains the complete validated issue set.
- Each column initially renders a bounded recent slice and offers `Show more` without changing search or filter results.
- Search and filters operate over the complete cached set.
- At 390px, columns retain the existing horizontally scrollable Kanban behaviour.
- The source filter, non-drag movement control, refresh state, and issue modal remain fully usable at 390px.
- Pointer drag is an enhancement. Every movement is also available through an accessible `Move to` control.

## Architecture

### Project configuration

Extend `ProjectKanban` with optional non-secret GitHub configuration.

```ts
export interface ProjectKanbanGitHub {
  enabled: boolean
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

This configuration is shared through `.nodeterm/project.json`. Credentials, issue snapshots, comments, ETags, refresh metadata, provisional mutations, and safe errors are not.

Readers validate every field defensively. A malformed GitHub block disables the integration without dropping the rest of the Kanban. A missing mapping degrades that issue to `Ungrouped`.

### Credential resolver

A focused credential resolver runs only in the trusted host process.

Resolution order

1. Use the explicitly selected stored token when present.
2. Otherwise use `gh auth token` from a validated GitHub CLI installation.
3. Otherwise report authentication required.

The renderer may save, clear, select, and query credential presence. It may never read a token. The service must redact bearer values and token-like query parameters from every error before logging or returning it.

Electron stores a pasted token encrypted with `safeStorage` when available. If a supported OS keyring is temporarily locked, the intact encrypted value is not overwritten. Server Edition and systems without available encryption use an atomic `0600` restricted file after explicit warning. Clearing a token removes the credential file but does not change the GitHub CLI login.

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
- safe error conversion

Its interface exposes issue-domain methods only.

```ts
interface GitHubIssuesClient {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>
  createIssue(repository: string, input: CreateIssueInput): Promise<GitHubIssue>
  updateIssue(repository: string, issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue>
  listComments(repository: string, issueNumber: number): Promise<GitHubComment[]>
  createComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment>
  updateComment(repository: string, commentId: number, body: string): Promise<GitHubComment>
  deleteComment(repository: string, commentId: number): Promise<void>
  listRepositoryLabels(repository: string): Promise<GitHubLabel[]>
  createLabel(repository: string, input: CreateLabelInput): Promise<GitHubLabel>
  listAssignees(repository: string): Promise<GitHubUser[]>
  listMilestones(repository: string): Promise<GitHubMilestone[]>
  lockIssue(repository: string, issueNumber: number): Promise<void>
  unlockIssue(repository: string, issueNumber: number): Promise<void>
}
```

GitHub's issue API supports the core issue, label, assignee, milestone, comment, and lock operations in scope [1].

### Issue service

The issue service owns

- per-repository cache loading and atomic persistence
- one in-flight refresh per repository
- one serial mutation chain per issue
- full and incremental refresh scheduling
- mapping issues to Kanban columns
- provisional mutation state
- post-mutation verification
- broadcasting bounded snapshots through the platform seam

The service accepts injected credential, client, clock, and storage dependencies. Core tests therefore perform no network or keyring access.

### Renderer state

Renderer state is keyed by project id and contains

- validated issue summaries
- connection and configuration readiness
- last successful refresh
- current refresh and rate-limit state
- provisional mutations
- bounded safe error
- in-memory comments for the open issue only

Comments are fetched when a modal opens and are not persisted to disk. Closing the modal may keep them only for a short in-memory time-to-live.

### Components

- `GitHubIssuesSection` owns Settings presentation.
- `GitHubIssueCard` owns GitHub card presentation and accessible card actions.
- `GitHubIssueModal` owns the issue editor and discussion.
- `KanbanSourceFilter` owns `All`, `GitHub`, and `Sessions` selection.
- `KanbanColumn` renders a discriminated union of native and GitHub cards while keeping source-specific behaviours isolated.
- Pure mapping and filtering helpers stay outside React.

## Data flow

### Initial load and refresh

1. Opening the Kanban reads the machine-local cache and renders it immediately.
2. If configuration and authentication are ready, the service starts a refresh.
3. An empty or older-than-24-hours cache receives a complete `state=all` paginated refresh.
4. A recent cache receives an incremental refresh from the last successful timestamp.
5. Conditional requests use stored ETags where the request identity is stable. Correctly authenticated `304` responses do not count against the primary REST limit [3].
6. Valid issues merge by repository and issue number.
7. Pull-request records are discarded before reaching the cache or renderer.
8. The service persists the validated cache atomically and broadcasts the new snapshot.

While the Kanban is visible, refresh every 60 seconds. Refresh when the window regains focus after the snapshot is stale. Closing the board stops polling. A manual refresh forces a complete reconciliation, but only a complete successful fetch may remove cache entries no longer returned upstream.

### Mutation flow

1. Validate the project configuration, issue identity, requested fields, and input bounds.
2. Enter the issue's local serial mutation chain.
3. Fetch the latest issue.
4. Compare its `updated_at` with the version shown to the user.
5. Return a stale-data result when they differ. Refresh the card and require a deliberate retry.
6. Compute the smallest safe mutation from the fresh record.
7. Submit the GitHub request.
8. Validate the confirmed response and compare fields that GitHub can silently ignore when repository permission is insufficient.
9. Update the in-memory snapshot as confirmed.
10. Refresh the affected issue.
11. Persist the cache and broadcast the result.

The UI may show a provisional location with a `Syncing` state. Failure restores the last confirmed position. A successful GitHub write followed by a cache failure returns the confirmed issue with `Refresh pending`, then heals on the next refresh without repeating the write.

### Column movement

For an open issue moved between non-completion columns

1. Fetch the current issue.
2. Preserve all labels not used by a column mapping.
3. Remove every mapped column label.
4. Add the destination label.
5. Send the resulting label set in one issue update.

Moving to completion also sets state to closed. Moving out of completion sets state to open and applies the destination mapping. An open conflict card may be resolved by choosing one destination, which removes all other mapped labels.

## Cache and retention

- Store one cache document per repository under the host's nodeterm user-data directory.
- Derive filenames from a stable hash rather than raw repository text.
- Create and replace cache files atomically with mode `0600` because issue bodies may contain private project information.
- Store bounded issue fields, ETags, last refresh time, and rate-limit metadata.
- Do not store comments, credentials, raw HTTP bodies, arbitrary response headers, provisional changes, or stack traces.
- `Clear cached GitHub data` removes the active repository cache after confirmation.
- Disabling the integration stops network activity but retains the cache until the user clears it.

## Error handling

| Failure | Behaviour |
|---|---|
| No GitHub authentication | Cached board remains read-only with a Settings action |
| Token rejected | Clear authentication guidance without returning token material |
| Repository unavailable or private without access | Cached board remains and configuration is marked unavailable |
| Insufficient write permission | Mutation fails, confirmed card remains, and required permission is explained |
| Network timeout | Cache remains with stale time and manual retry |
| Malformed or oversized response | Reject that response and preserve the last valid cache |
| Primary rate limit | Stop polling until `x-ratelimit-reset` |
| Secondary rate limit | Honour `retry-after` or exponential backoff and stop after a bounded retry count |
| Stale displayed issue | Refresh the card and require deliberate retry |
| Multiple mapped labels | Show an `Ungrouped` conflict card and block implicit movement |
| GitHub write rejected | Restore provisional UI and show persistent actionable error |
| GitHub write confirmed but cache write fails | Show confirmed data with `Refresh pending` and do not repeat the mutation |
| Project mapping becomes invalid | Disable sync for that project without damaging native Kanban data |

GitHub warns that continued requests during a rate limit may lead to an integration ban. The service must stop and respect the supplied reset or retry time [4].

## Security and privacy

- All GitHub network requests run in the trusted host process.
- The renderer receives domain objects, never bearer credentials or arbitrary GitHub responses.
- IPC validates project id, repository, issue number, comment id, collection sizes, text lengths, enum values, and URLs.
- The client permits only `api.github.com` and validates canonical links against `github.com/<owner>/<repository>`.
- Repository configuration cannot become an arbitrary server-side request URL.
- HTML and Markdown originating on GitHub are sanitised through the existing renderer boundary before display.
- Issue titles, bodies, labels, comments, assignee names, and avatars render as untrusted data.
- Logs may include repository, issue number, operation, HTTP status, and rate-limit timing. They may not include token values, request bodies, issue bodies, comments, authentication headers, or raw GitHub error payloads.
- Credential status reports presence and provider only.
- PAT input is cleared from component state immediately after Save.
- The PAT is never written to `settings.json`, `.nodeterm/project.json`, the issue cache, tests, screenshots, recordings, or pull-request text.

## Testing strategy

### Unit tests

- repository parsing for HTTPS, SSH, missing, malformed, non-GitHub, and overridden remotes
- credential selection, write-only behaviour, locked keyring handling, restricted-file mode, migration, and redaction
- issue, comment, label, assignee, and milestone response validation
- pagination, Link headers, pull-request filtering, full and incremental refresh, ETags, `304`, timeouts, malformed JSON, and bounded responses
- primary and secondary rate-limit handling
- status mapping for open, closed, unlabelled, single-labelled, and conflicting issues
- unrelated-label preservation and exact mapped-label replacement
- close and reopen transitions
- stable sorting and source filtering
- cache atomicity, mode, retention, and corrupt-file recovery
- successful write followed by cache failure without duplicate mutation

### Renderer and DOM tests

- Settings navigation and search entry
- GitHub CLI, token-present, unauthenticated, keyring-warning, and insufficient-permission states
- token field clears after Save and cannot read back a secret
- project repository override and per-column mapping
- label setup confirmation
- mixed card rendering and `All`, `GitHub`, and `Sessions` filtering
- filtered column counts
- cached, refreshing, stale, rate-limited, conflict, provisional, confirmed, and failed card states
- pointer drag and non-drag movement parity
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

Attach compressed screenshots and recordings to the pull request or its test evidence. Do not commit large binary captures. These complement behavioural tests. A new cross-platform pixel-diff framework is outside this pull request because nodeterm has no current visual-regression harness and Electron font rendering would make an initial baseline noisy.

## Delivery

Deliver one feature branch and one pull request with reviewable commits for

1. shared types and project configuration
2. credential storage and resolution
3. GitHub client and cache
4. issue service and platform bridges
5. Settings
6. board cards and source filtering
7. issue modal and mutations
8. accessibility, responsive behaviour, documentation, and verification

The per-project enable switch keeps the integration opt-in. The pull-request description records authentication behaviour, required permissions, cache retention, best-effort conflict limits, automated checks, live verification boundary, and visual evidence.

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

The feature is complete only when

- every automated check passes from a fresh run
- project configuration round-trips without damaging older project files
- credentials never cross into shared or renderer-readable storage
- all approved issue operations are verified with fixtures
- a live GitHub read succeeds
- a live write journey succeeds when an authorised test repository is available
- conflicts, rate limits, permission failures, network failures, and cache-write failures remain recoverable
- pointer, keyboard, desktop, 390px, dark-theme, and light-theme evidence has been reviewed
- the pull-request diff contains no credentials, cache data, screenshots, recordings, or unrelated changes

## References

1. GitHub. REST API endpoints for issues [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/issues
2. GitHub. Generating a user access token for a GitHub App [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
3. GitHub. Best practices for using the REST API [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
4. GitHub. Rate limits for the REST API [Internet]. 2026 [cited 2026 Aug 9]. Available from: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10

# GitHub Issues Kanban Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, two-way GitHub issue synchronisation to the nodeterm Kanban board with GitHub as the canonical store, exact issue-label column mapping, local trust approval, GitHub CLI or write-only token authentication, source filtering, and safe move, close, and reopen actions.

**Architecture:** Shared project files store only validated repository and column-label configuration. A host-owned GitHub service resolves machine-local approval and credentials, discovers the repository, performs bounded REST requests, maintains a private complete cache, and exposes paged domain objects through the existing Electron, Server Edition, and relay platform seam. The renderer combines paged GitHub cards with native session cards without copying GitHub issues into `ProjectKanban.assignments`.

**Tech Stack:** TypeScript, Electron 42, React 18, Zustand 4, Vitest 4, Node `fetch`, the existing `CorePlatform` RPC seam, Electron `safeStorage`, and existing nodeterm Settings and Kanban styles.

## Global Constraints

- This plan implements Pull Request 1 from the approved design. Full issue body editing, comments, ordinary label editing, assignees, milestones, locking, and the full issue modal remain Pull Request 2.
- GitHub is canonical for every GitHub-backed card. Never persist an issue as a native assignment.
- Store no secret or local approval in `.nodeterm/project.json`, `settings.json`, cache content exposed to renderers, logs, screenshots, recordings, or pull-request text.
- Require machine-local approval before credential access, cache read, or network access.
- Map columns by exact GitHub issue label names. Case-variant duplicate mappings are invalid.
- Exclude pull requests. Put unmatched open issues in `Ungrouped`. Put closed issues in the completion column.
- Close on movement into the completion column and reopen on movement out. Preserve unrelated labels.
- Run GitHub HTTP only in the trusted host. Allow only `api.github.com`; avatar delivery allows only redirect-free `https://avatars.githubusercontent.com` requests.
- Bound a complete repository to 10,000 issues and a 64 MiB cache document. Never replace the last complete cache with an incomplete refresh.
- Poll once per repository every 60 seconds while at least one visible subscriber exists. Perform a full reconciliation at least every 24 hours.
- Keep all UI actions available without pointer drag and usable at 390px in light and dark themes.
- Use no new runtime dependency.
- Every implementation task follows red, green, refactor. Observe the focused test fail before adding production code.
- Do not mutate the upstream nodeterm repository for evidence. Use deterministic fixtures and only an explicitly authorised test repository for live writes.

---

## File map

- `src/shared/github-issues.ts` owns all serialisable GitHub configuration, control, card, page, mutation, status, and API contracts.
- `src/core/github/config.ts` owns repository parsing and canonical Kanban mapping normalisation.
- `src/core/github/control-store.ts` owns revision-checked local approvals and provider selection.
- `src/core/github/credentials.ts` owns GitHub CLI and stored-token selection without returning secrets to the renderer.
- `src/core/github/client.ts` owns validated GitHub REST requests and response decoding.
- `src/core/github/avatar-fetcher.ts` owns lazy, redirect-free, bounded avatar delivery.
- `src/core/github/request-coordinator.ts` owns authenticated-identity concurrency, mutation spacing, and global rate backoff.
- `src/core/github/cache.ts` owns private atomic cache persistence and complete versus incomplete attempt retention.
- `src/core/github/service.ts` owns subscriptions, refresh, paging, mapping, and serial issue mutations.
- `src/core/github/handlers.ts` registers the core-bound issue surface.
- `src/main/github-control.ts` owns Electron-only credential and approval handlers plus `safeStorage` integration.
- `src/server/github-control.ts` owns authenticated Server Edition credential and approval handlers with restricted-file token storage.
- `src/renderer/state/githubIssues.ts` owns bounded renderer pages, subscription state, and mutation state.
- `src/renderer/components/settings/sections/GitHubIssuesSection.tsx` owns the settings experience.
- `src/renderer/components/kanban/GitHubIssueCard.tsx` owns issue card rendering and accessible actions.
- `src/renderer/components/kanban/GitHubIssueSummaryModal.tsx` owns the Pull Request 1 safe summary and canonical link.
- `src/renderer/components/kanban/KanbanSourceFilter.tsx` owns `All`, `GitHub`, and `Sessions` selection.
- Existing shared, preload, bridge, boot, Kanban, Settings, and style files connect those focused units.

### Task 1: Shared configuration and local workspace identity

**Files:**
- Create: `src/shared/github-issues.ts`
- Create: `src/core/github/config.ts`
- Create: `src/core/github/config.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/core/workspace-files.ts`
- Modify: `src/core/workspace-files.test.ts`
- Modify: `src/core/workspace-store.ts`
- Modify: `src/core/workspace-store.test.ts`
- Modify: `src/renderer/lib/kanban.ts`
- Modify: `src/renderer/lib/kanban.test.ts`

**Interfaces:**
- Produces: `normaliseProjectKanbanGitHub(value, columns)`, `parseGitHubRepository(value)`, `ProjectKanbanGitHub`, and a preserved `IndexEntryV3.localApprovalId`.
- Consumes: existing `ProjectKanban`, `KanbanColumn`, `splitWorkspace`, `validKanban`, and pure board transforms.

- [ ] **Step 1: Write failing configuration and identity tests**

```ts
it('rejects case-variant duplicate labels and unknown columns', () => {
  const columns = [{ id: 'todo', title: 'Todo', color: '#8b5cf6' }]
  expect(normaliseProjectKanbanGitHub({ columnMappings: [
    { columnId: 'todo', label: 'Status: Todo' },
    { columnId: 'missing', label: 'status: todo' }
  ] }, columns)).toEqual({ ok: false, reason: 'invalid-mapping' })
})

it('preserves localApprovalId through save and reload but never writes it to project.json', async () => {
  const first = await store.load()
  const approvalId = store.indexEntry(first.projects[0].id)?.localApprovalId
  await store.save(first)
  expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)
  expect(readSharedProjectFile()).not.toContain('localApprovalId')
  expect((await store.loadIndex()).entries[0].localApprovalId).toBe(approvalId)
})
```

- [ ] **Step 2: Run focused tests and observe the expected failures**

Run `npx vitest run src/core/github/config.test.ts src/core/workspace-files.test.ts src/core/workspace-store.test.ts src/renderer/lib/kanban.test.ts`

Expected result is failure because the new contracts and `localApprovalId` do not exist.

- [ ] **Step 3: Add the shared contracts and strict normaliser**

```ts
export interface ProjectKanbanGitHub {
  repository?: string
  columnMappings: Array<{ columnId: string; label: string }>
  completionColumnId?: string
}

export type NormalisedGitHubConfig = {
  repository?: string
  mappings: ReadonlyMap<string, string>
  completionColumnId?: string
  revision: string
}

export function normaliseProjectKanbanGitHub(
  value: unknown,
  columns: readonly KanbanColumn[]
): { ok: true; value: NormalisedGitHubConfig } | { ok: false; reason: 'invalid-mapping' } {
  // Trim strings, reject unknown or duplicate column ids, reject empty or case-duplicate labels,
  // validate the completion id, canonicalise the repository, and hash canonical JSON as revision.
}
```

Extend `ProjectKanban` with `github?: ProjectKanbanGitHub`. Make every board transform spread the existing board before replacing its own property so `github`, `meta`, and `labels` survive.

- [ ] **Step 4: Preserve the machine-local approval id**

Add `localApprovalId?: string` to `IndexEntryV3`. In `WorkspaceStore`, assign `randomUUID()` when an index entry is created or first loaded without one. When `splitWorkspace` creates replacement entries, merge the old entry's `localApprovalId` by project id inside `WorkspaceStore.save`. Do not add the field to `Project`, `ProjectFileV1`, or `projectToFile`.

- [ ] **Step 5: Run focused tests and commit**

Run `npx vitest run src/core/github/config.test.ts src/core/workspace-files.test.ts src/core/workspace-store.test.ts src/renderer/lib/kanban.test.ts src/renderer/state/projects.kanban.test.ts`

```bash
git add src/shared/github-issues.ts src/shared/types.ts src/core/github/config.ts src/core/github/config.test.ts src/core/workspace-files.ts src/core/workspace-files.test.ts src/core/workspace-store.ts src/core/workspace-store.test.ts src/renderer/lib/kanban.ts src/renderer/lib/kanban.test.ts
git commit -m "feat: add GitHub Kanban configuration"
```

### Task 2: Transactional local control and credentials

**Files:**
- Create: `src/core/github/control-store.ts`
- Create: `src/core/github/control-store.test.ts`
- Create: `src/core/github/credentials.ts`
- Create: `src/core/github/credentials.test.ts`
- Create: `src/main/github-control.ts`
- Create: `src/main/github-control.test.ts`
- Create: `src/server/github-control.ts`
- Create: `src/server/github-control.test.ts`
- Modify: `src/shared/github-issues.ts`

**Interfaces:**
- Produces: `GitHubControlStore`, `GitHubCredentialResolver`, `GitHubSecretCodec`, and status-only `GitHubAuthStatus`.
- Consumes: `localApprovalId`, normalised repository, host `userDataDir`, injected command runner, and Electron `safeStorage` only through the main adapter.

- [ ] **Step 1: Write failing trust, revision, and fallback tests**

```ts
it('does not let a stale client restore a revoked approval', async () => {
  const approved = await store.approve({ expectedRevision: 0, localApprovalId: 'local-a', projectId: 'p', repository: 'o/r' })
  await store.revoke({ expectedRevision: approved.revision, localApprovalId: 'local-a' })
  await expect(store.approve({ expectedRevision: approved.revision, localApprovalId: 'local-a', projectId: 'p', repository: 'o/r' }))
    .rejects.toMatchObject({ code: 'revision-conflict' })
})

it.each([
  ['auto', 'gh-ok', 'token-ok', 'gh'],
  ['auto', 'gh-bad', 'token-ok', 'token'],
  ['gh', 'gh-bad', 'token-ok', null],
  ['token', 'gh-ok', 'token-bad', null]
])('uses the exact provider truth table', async (provider, gh, token, expected) => {
  expect(await resolveFixture(provider, gh, token)).toBe(expected)
})
```

- [ ] **Step 2: Run focused tests and observe failures**

Run `npx vitest run src/core/github/control-store.test.ts src/core/github/credentials.test.ts src/main/github-control.test.ts src/server/github-control.test.ts`

Expected result is failure because the stores and adapters do not exist.

- [ ] **Step 3: Implement revision-checked control state**

```ts
export interface GitHubControlState {
  version: 1
  revision: number
  authProvider: 'auto' | 'gh' | 'token'
  approvals: GitHubProjectApproval[]
}

export class GitHubControlStore {
  load(): Promise<GitHubControlState>
  approve(input: ApprovalMutation): Promise<GitHubControlState>
  revoke(input: RevokeApproval): Promise<GitHubControlState>
  selectProvider(input: ProviderMutation): Promise<GitHubControlState>
}
```

Validate exact fields and bounds, compare `expectedRevision`, write a `0600` temporary file, rename atomically, and increment the revision once. Approval lookup must match `localApprovalId`, project id, and normalised repository.

- [ ] **Step 4: Implement write-only credential adapters and exact resolution**

```ts
export interface GitHubSecretCodec {
  availability(): 'encrypted' | 'restricted-file' | 'unavailable'
  save(token: string): Promise<void>
  clear(): Promise<void>
  readForHost(): Promise<string | null>
}

export class GitHubCredentialResolver {
  resolve(provider: GitHubAuthProvider): Promise<ResolvedCredential | null>
  status(provider: GitHubAuthProvider): Promise<GitHubAuthStatus>
}
```

Validate `gh auth status --hostname github.com` before `gh auth token --hostname github.com`. For Electron, use `safeStorage.isEncryptionAvailable()` and reject the `basic_text` backend. For Server Edition, use a dedicated mode `0600` file and return a visible restricted-storage warning. Never expose `ResolvedCredential.token` outside core.

- [ ] **Step 5: Run focused tests and commit**

Run `npx vitest run src/core/github/control-store.test.ts src/core/github/credentials.test.ts src/main/github-control.test.ts src/server/github-control.test.ts`

```bash
git add src/core/github src/main/github-control.ts src/main/github-control.test.ts src/server/github-control.ts src/server/github-control.test.ts src/shared/github-issues.ts
git commit -m "feat: secure GitHub credentials and approval"
```

### Task 3: Bounded REST client and identity-wide request coordination

**Files:**
- Create: `src/core/github/client.ts`
- Create: `src/core/github/client.test.ts`
- Create: `src/core/github/avatar-fetcher.ts`
- Create: `src/core/github/avatar-fetcher.test.ts`
- Create: `src/core/github/request-coordinator.ts`
- Create: `src/core/github/request-coordinator.test.ts`
- Modify: `src/shared/github-issues.ts`

**Interfaces:**
- Produces: `GitHubIssuesClient`, `GitHubRequestCoordinator`, validated `GitHubIssue`, `GitHubLabel`, and rate metadata.
- Consumes: a host-only bearer token, authenticated GitHub user id, injected `fetch`, clock, and scheduler.

- [ ] **Step 1: Write failing validation, pagination, and rate tests**

```ts
it('drops pull requests and rejects an oversized response', async () => {
  const client = fixtureClient([{ number: 1, pull_request: {} }, issueFixture(2)])
  expect((await client.listIssues('o/r', { state: 'all', page: 1 })).items.map((i) => i.number)).toEqual([2])
  await expect(oversizedClient().listIssues('o/r', { state: 'all', page: 1 }))
    .rejects.toMatchObject({ code: 'response-too-large' })
})

it('pauses every repository for the same identity after a secondary limit', async () => {
  const coordinator = fixtureCoordinator()
  coordinator.noteRateLimit('github-user-1', { kind: 'secondary', retryAt: 5_000 })
  expect(coordinator.canStart('github-user-1', 'other/repo', 4_999)).toBe(false)
})

it('blocks avatar redirects and stops at the page aggregate budget', async () => {
  const fetcher = fixtureAvatarFetcher({ bytesPerAvatar: 120 * 1024 })
  expect(await fetcher.forPage(userFixtures(6))).toMatchObject({ dataUrls: expect.any(Map), truncated: true })
  expect(fetcher.fetchOptions()).toEqual(expect.objectContaining({ redirect: 'manual' }))
})
```

- [ ] **Step 2: Run tests and observe failures**

Run `npx vitest run src/core/github/client.test.ts src/core/github/avatar-fetcher.test.ts src/core/github/request-coordinator.test.ts`

- [ ] **Step 3: Implement the strict REST surface**

Use `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `redirect: 'manual'`, a bounded timeout, and endpoint builders that accept only canonical `owner/repository`. Decode only required fields. Implement `listIssues`, `getIssue`, `updateIssue`, `listRepositoryLabels`, and `createLabel` for Pull Request 1. Keep the full contract type ready for Pull Request 2 without registering unused renderer actions.

```ts
export class GitHubIssuesClient {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>
  updateIssue(repository: string, issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue>
  listRepositoryLabels(repository: string, page: PageRequest): Promise<LabelPageResult>
  createLabel(repository: string, input: CreateLabelInput): Promise<GitHubLabel>
}
```

Implement `GitHubAvatarFetcher` separately. Accept only exact HTTPS `avatars.githubusercontent.com` URLs supplied by validated user records. Fetch only visible-page users, use `redirect: 'manual'`, accept PNG, JPEG, GIF, or WebP, stop each response at 128 KiB, stop a renderer page at 512 KiB, and return initials for every skipped or failed avatar. Keep only a short bounded memory cache.

- [ ] **Step 4: Implement identity-wide coordination**

Allow four reads per authenticated user id. Serialize writes and start them at least 1,000 ms apart. Apply primary reset and secondary `retry-after` to every repository using that identity. `cancelIdentity` rejects queued work with `configuration-changed`.

- [ ] **Step 5: Run focused tests and commit**

Run `npx vitest run src/core/github/client.test.ts src/core/github/avatar-fetcher.test.ts src/core/github/request-coordinator.test.ts`

```bash
git add src/core/github/client.ts src/core/github/client.test.ts src/core/github/avatar-fetcher.ts src/core/github/avatar-fetcher.test.ts src/core/github/request-coordinator.ts src/core/github/request-coordinator.test.ts src/shared/github-issues.ts
git commit -m "feat: add bounded GitHub issues client"
```

### Task 4: Private cache, reconciliation, and paged issue service

**Files:**
- Create: `src/core/github/cache.ts`
- Create: `src/core/github/cache.test.ts`
- Create: `src/core/github/service.ts`
- Create: `src/core/github/service.test.ts`
- Modify: `src/shared/github-issues.ts`

**Interfaces:**
- Produces: `GitHubIssueService.subscribe`, `unsubscribe`, `query`, `refresh`, `createMissingLabels`, and `moveIssue`.
- Consumes: approved configuration epoch, resolver, client, coordinator, workspace lookup, cache, clock, and platform broadcaster.

- [ ] **Step 1: Write failing cache and reconciliation tests**

```ts
it('retains lastComplete when the next refresh exceeds a limit', async () => {
  await cache.saveComplete('user:o/r', completeSnapshot([issueFixture(1)]))
  await cache.saveIncompleteAttempt('user:o/r', { reason: 'issue-limit', observedAt: 2 })
  expect((await cache.load('user:o/r')).lastComplete?.issues.map((i) => i.number)).toEqual([1])
})

it('shares one poll across visible subscribers', async () => {
  service.subscribe(1, request)
  service.subscribe(2, request)
  expect(clock.activeIntervals()).toHaveLength(1)
  service.unsubscribe(1, request.projectId)
  expect(clock.activeIntervals()).toHaveLength(1)
  service.unsubscribe(2, request.projectId)
  expect(clock.activeIntervals()).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests and observe failures**

Run `npx vitest run src/core/github/cache.test.ts src/core/github/service.test.ts`

- [ ] **Step 3: Implement atomic complete and incomplete cache slots**

Key cache files by a SHA-256 hash of authenticated user id and repository. Persist mode `0600` through temporary-file plus rename. Store bounded issue fields, identity-scoped ETags, rate metadata, `lastSuccessfulRefreshAt`, `lastFullReconciliationAt`, `lastComplete`, and `lastAttempt`. Reject malformed cache files and documents above 64 MiB.

- [ ] **Step 4: Implement refresh, mapping, paging, and deltas**

```ts
export class GitHubIssueService {
  subscribe(uiId: number, request: GitHubSubscribeRequest): Promise<GitHubRepositoryStatus>
  unsubscribe(uiId: number, projectId: string): void
  query(request: GitHubIssueQuery): Promise<GitHubIssuePage>
  refresh(request: GitHubRefreshRequest): Promise<GitHubRepositoryStatus>
  createMissingLabels(request: CreateMappedLabelsRequest): Promise<CreateMappedLabelsResult>
  moveIssue(request: MoveGitHubIssueRequest): Promise<GitHubMutationResult>
}
```

Use complete `state=all` pagination for empty or 24-hour-old full caches. Otherwise use `since = lastSuccessfulRefreshAt - 2 seconds`. Merge by issue number and `updated_at`. A complete refresh may remove absent issues; an incremental or incomplete refresh may not. Query by column, source label filter, search, cursor, and page size up to 50. Resolve avatars lazily only for users on the returned page and enforce the aggregate page budget. Broadcast changed ids, counts, readiness, and timing only.

- [ ] **Step 5: Implement epoch-safe mutations**

Capture `localApprovalId`, project id, repository, mapping revision, control revision, credential generation, and user id. Revalidate inside the issue chain before fetch, before write, and before applying or persisting the confirmed result. Fetch the latest issue and compare `expectedUpdatedAt`. Preserve unrelated labels. Replace all mapped labels with the destination label. Set `state: closed` in the completion column and `state: open` outside it. On a confirmed write followed by cache failure, return `refresh-pending` without repeating the write.

- [ ] **Step 6: Run focused tests and commit**

Run `npx vitest run src/core/github/cache.test.ts src/core/github/service.test.ts`

```bash
git add src/core/github/cache.ts src/core/github/cache.test.ts src/core/github/service.ts src/core/github/service.test.ts src/shared/github-issues.ts
git commit -m "feat: sync GitHub issues with Kanban state"
```

### Task 5: Electron, Server Edition, preload, and relay boundaries

**Files:**
- Create: `src/core/github/handlers.ts`
- Create: `src/core/github/handlers.test.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/preload/index.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/platform-electron.ts`
- Modify: `src/main/platform-electron.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/handlers/index.ts`
- Modify: `src/server/platform-server.test.ts`
- Modify: `src/renderer/bridge/ws-bridge.ts`
- Modify: `src/renderer/bridge/ws-bridge.test.ts`
- Modify: `src/renderer/bridge/relay-api.ts`
- Modify: `src/renderer/bridge/relay-api.test.ts`

**Interfaces:**
- Produces: `window.nodeTerminal.githubIssues` for core-bound issue operations and `window.nodeTerminal.githubControl` for host-only control operations.
- Consumes: `GitHubIssueService`, `GitHubControlStore`, credential adapters, workspace lookup, and existing RPC transport.

- [ ] **Step 1: Write failing bridge and security tests**

```ts
it('denies raw relay calls to githubControl channels', async () => {
  const result = await electron.dispatch(1_000_001, { t: 'req', id: 1, method: IPC.githubControlApprove, args: [] })
  expect(result).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } })
})

it('exposes domain data but never a credential', async () => {
  const status = await api.githubIssues.status('project-1')
  expect(JSON.stringify(status)).not.toMatch(/token|bearer|authorization/i)
})
```

- [ ] **Step 2: Run contract tests and observe failures**

Run `npx vitest run src/core/github/handlers.test.ts src/preload/index.test.ts src/main/platform-electron.test.ts src/server/platform-server.test.ts src/renderer/bridge/ws-bridge.test.ts src/renderer/bridge/relay-api.test.ts`

- [ ] **Step 3: Add IPC constants and typed APIs**

Register subscribe, unsubscribe, query, refresh, move, mapped-label setup, clear cache, and repository detection through `platform().handle` or `on`. Register control status, approve, revoke, provider select, token save, and token clear as raw local-window Electron handlers. Server Edition registers its control surface for its authenticated browser client.

- [ ] **Step 4: Enforce relay denial and locality**

```ts
export function isHostControlChannel(method: string): boolean {
  return method.startsWith('githubControl:')
}
```

Return `E_FORBIDDEN` before Electron generic handler lookup for every host-control method. `buildRelayApi` keeps `githubControl` local and routes `githubIssues` through the relay frame transport. Electron-managed SSH repository discovery uses the existing remote Git executor, while credentials, cache, and GitHub HTTP remain on Electron.

- [ ] **Step 5: Run contract tests and commit**

Run the Task 5 focused command again and require all tests to pass.

```bash
git add src/core/github/handlers.ts src/core/github/handlers.test.ts src/shared/ipc.ts src/shared/types.ts src/preload src/main/index.ts src/main/platform-electron.ts src/main/platform-electron.test.ts src/server src/renderer/bridge
git commit -m "feat: bridge GitHub issues safely"
```

### Task 6: Native Settings experience

**Files:**
- Create: `src/renderer/components/settings/sections/GitHubIssuesSection.tsx`
- Create: `src/renderer/components/settings/sections/GitHubIssuesSection.test.tsx`
- Modify: `src/renderer/components/settings/nav.ts`
- Modify: `src/renderer/components/settings/nav.test.ts`
- Modify: `src/renderer/components/settings/search.test.ts`
- Modify: `src/renderer/components/settings/SettingsPage.tsx`
- Modify: `src/renderer/components/settings/SettingsIcons.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Produces: project-aware GitHub setup, write-only token actions, approval, mapping, completion choice, label setup, refresh, and cache clear controls.
- Consumes: active project, `setProjectKanban`, `githubControl`, `githubIssues`, `SettingsSection`, `SearchableRow`, `FieldRow`, `Input`, `Select`, `Button`, and `ConfirmDialog`.

- [ ] **Step 1: Write failing Settings DOM tests**

```tsx
it('clears the token field after Save and never reads a stored token', async () => {
  renderGitHubSettings({ auth: { provider: 'token', tokenPresent: true } })
  await user.type(screen.getByLabelText('Personal access token'), 'github_pat_secret')
  await user.click(screen.getByRole('button', { name: 'Save token' }))
  expect(screen.getByLabelText('Personal access token')).toHaveValue('')
  expect(githubControl.saveToken).toHaveBeenCalledWith('github_pat_secret')
  expect(JSON.stringify(githubControl.status.mock.results)).not.toContain('github_pat_secret')
})
```

Add cases for CLI authenticated, unauthenticated, keyring warning, project approval, repository change reapproval, invalid mappings, permission errors, and label-setup confirmation.

- [ ] **Step 2: Run focused Settings tests and observe failures**

Run `npx vitest run src/renderer/components/settings/sections/GitHubIssuesSection.test.tsx src/renderer/components/settings/nav.test.ts src/renderer/components/settings/search.test.ts`

- [ ] **Step 3: Implement the section in the existing style**

Place `GitHub Issues` in the Workspace Settings group. Use the existing section shell and field rows. Show detected origin plus manual override, `Auto`, `GitHub CLI only`, and `Personal access token only`, write-only token entry, exact permission help, explicit local approval, one mapping row per current column, completion selector, readiness status, `Create missing labels`, `Refresh`, `Clear cached GitHub data`, and `Revoke this machine`.

- [ ] **Step 4: Run focused tests and commit**

```bash
npx vitest run src/renderer/components/settings/sections/GitHubIssuesSection.test.tsx src/renderer/components/settings/nav.test.ts src/renderer/components/settings/search.test.ts
git add src/renderer/components/settings src/renderer/styles.css
git commit -m "feat: add GitHub Issues settings"
```

### Task 7: Mixed board cards, paging, and source filter

**Files:**
- Create: `src/renderer/state/githubIssues.ts`
- Create: `src/renderer/state/githubIssues.test.ts`
- Create: `src/renderer/components/kanban/GitHubIssueCard.tsx`
- Create: `src/renderer/components/kanban/GitHubIssueCard.test.tsx`
- Create: `src/renderer/components/kanban/GitHubIssueSummaryModal.tsx`
- Create: `src/renderer/components/kanban/KanbanSourceFilter.tsx`
- Create: `src/renderer/components/kanban/KanbanSourceFilter.test.tsx`
- Modify: `src/renderer/components/kanban/KanbanView.tsx`
- Modify: `src/renderer/components/kanban/KanbanColumn.tsx`
- Modify: `src/renderer/components/kanban/LabelChips.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Produces: paged GitHub cards mixed into columns, namespaced GitHub label filtering, safe summary modal, `Show more`, and `All`, `GitHub`, `Sessions` filtering.
- Consumes: `GitHubIssuePage`, native sessions, board columns, source-neutral column counts, and the core API.

- [ ] **Step 1: Write failing renderer tests**

```tsx
it('filters sources without changing the board configuration', async () => {
  renderBoard({ sessions: [sessionCard()], github: [issueCard()] })
  await user.click(screen.getByRole('button', { name: 'GitHub' }))
  expect(screen.getByText('#42 Fix polling')).toBeVisible()
  expect(screen.queryByText('Local session')).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
})
```

Add cases for mixed stable order, closed completion placement, unmatched and conflicting issues in `Ungrouped`, namespaced same-name labels, accurate filtered counts, `Show more`, cached and stale states, modal focus restoration, and a 390px DOM layout class.

- [ ] **Step 2: Run renderer tests and observe failures**

Run `npx vitest run src/renderer/state/githubIssues.test.ts src/renderer/components/kanban/GitHubIssueCard.test.tsx src/renderer/components/kanban/KanbanSourceFilter.test.tsx`

- [ ] **Step 3: Implement bounded renderer state**

Subscribe only while the Kanban view is visible. Keep pages keyed by project, column, source, search, and namespaced label filter. Requery affected visible pages on bounded service deltas. Unsubscribe and clear provisional state when the project or configuration epoch changes.

- [ ] **Step 4: Render the approved source-filter design**

Use discriminated cards without changing the native `KanbanSession` contract. A GitHub card shows issue number, title, open or closed state, mapped and ordinary labels, up to three bounded avatars, update age, conflict or sync state, and a GitHub source mark. Opening it shows a safe summary, movement controls, and `Open on GitHub`. Markdown images are links, not images.

- [ ] **Step 5: Run focused tests and commit**

```bash
npx vitest run src/renderer/state/githubIssues.test.ts src/renderer/components/kanban/GitHubIssueCard.test.tsx src/renderer/components/kanban/KanbanSourceFilter.test.tsx
git add src/renderer/state/githubIssues.ts src/renderer/state/githubIssues.test.ts src/renderer/components/kanban src/renderer/styles.css
git commit -m "feat: show GitHub issues on Kanban"
```

### Task 8: Accessible two-way movement, conflict resolution, close, and reopen

**Files:**
- Modify: `src/core/github/service.test.ts`
- Modify: `src/renderer/state/githubIssues.ts`
- Modify: `src/renderer/state/githubIssues.test.ts`
- Modify: `src/renderer/components/kanban/GitHubIssueCard.tsx`
- Modify: `src/renderer/components/kanban/GitHubIssueCard.test.tsx`
- Modify: `src/renderer/components/kanban/KanbanColumn.tsx`
- Modify: `src/renderer/components/kanban/KanbanView.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Produces: pointer drag and `Move to` parity with provisional, confirmed, stale, conflict, failed, and refresh-pending states.
- Consumes: `GitHubIssueService.moveIssue`, `expectedUpdatedAt`, and mapped column definitions.

- [ ] **Step 1: Write failing end-to-end component and service tests**

```ts
it('reopens outside completion and preserves unrelated labels', async () => {
  client.getIssue.mockResolvedValue(issueFixture(42, { state: 'closed', labels: ['status:done', 'bug'] }))
  await service.moveIssue(moveRequest({ issueNumber: 42, toColumnId: 'todo', expectedUpdatedAt: '2026-08-09T10:00:00Z' }))
  expect(client.updateIssue).toHaveBeenCalledWith('o/r', 42, {
    state: 'open', labels: ['bug', 'status:todo']
  })
})
```

Add tests for close, mapped-label conflicts, open issue with completion label, stale data, approval revocation while queued, mapping change before write, failed rollback, successful write plus cache failure, pointer movement, keyboard `Move to`, and focus restoration.

- [ ] **Step 2: Run focused tests and observe failures**

Run `npx vitest run src/core/github/service.test.ts src/renderer/state/githubIssues.test.ts src/renderer/components/kanban/GitHubIssueCard.test.tsx`

- [ ] **Step 3: Implement provisional movement and conflict actions**

On movement, retain the last confirmed card and mark only that card `syncing`. A stale response installs the latest issue and requires a new user action. A failure restores the confirmed column and keeps an actionable error. Conflict cards expose explicit target choices and never silently select among multiple mapped labels.

- [ ] **Step 4: Run focused tests and commit**

```bash
npx vitest run src/core/github/service.test.ts src/renderer/state/githubIssues.test.ts src/renderer/components/kanban/GitHubIssueCard.test.tsx
git add src/core/github/service.test.ts src/renderer/state/githubIssues.ts src/renderer/state/githubIssues.test.ts src/renderer/components/kanban src/renderer/styles.css
git commit -m "feat: sync GitHub issue movement"
```

### Task 9: Platform integration, privacy regression, and documentation

**Files:**
- Create: `test/server/github-issues-e2e.test.ts`
- Create: `test/remote/github-issues-relay.test.ts`
- Create: `docs/github-issues-kanban.md`
- Modify: `README.md`
- Modify: `src/main/platform-electron.test.ts`
- Modify: `src/server/platform-server.test.ts`
- Modify: `src/renderer/bridge/ws-bridge.test.ts`

**Interfaces:**
- Produces: deterministic host fixtures covering Electron, Server Edition, relay, and documented setup and limits.
- Consumes: completed Pull Request 1 API and user interface.

- [ ] **Step 1: Add failing platform journeys**

Test local Electron handler registration, Server Edition authenticated query and move, relay issue operations with local control denial, Electron-managed SSH repository discovery with desktop credential use, no token in serialised errors, and one poll shared across clients.

- [ ] **Step 2: Run platform journeys and observe failures**

Run `npx vitest run test/server/github-issues-e2e.test.ts test/remote/github-issues-relay.test.ts src/main/platform-electron.test.ts src/server/platform-server.test.ts src/renderer/bridge/ws-bridge.test.ts`

- [ ] **Step 3: Close integration gaps and add user documentation**

Document CLI and token authentication, fine-grained token permissions, local approval, repository override, exact label mapping, completion behaviour, source filter, refresh cadence, cache location and clearing, support limits, conflict recovery, Server Edition restricted-file warning, and the deferred Pull Request 2 editor features.

- [ ] **Step 4: Run platform journeys and commit**

```bash
npx vitest run test/server/github-issues-e2e.test.ts test/remote/github-issues-relay.test.ts src/main/platform-electron.test.ts src/server/platform-server.test.ts src/renderer/bridge/ws-bridge.test.ts
git add test/server/github-issues-e2e.test.ts test/remote/github-issues-relay.test.ts docs/github-issues-kanban.md README.md src/main/platform-electron.test.ts src/server/platform-server.test.ts src/renderer/bridge/ws-bridge.test.ts
git commit -m "test: cover GitHub Kanban integration"
```

### Task 10: Full verification and visual acceptance evidence

**Files:**
- Modify only if verification finds a defect: the smallest owning production file and its focused test.
- Do not commit screenshots or recordings.

**Interfaces:**
- Produces: current full-suite evidence, live fixture evidence, screenshots, a short recording, and a review-ready branch.
- Consumes: completed Pull Request 1 implementation.

- [ ] **Step 1: Run static and full automated verification from a clean status**

```bash
git diff --check
npm test
npm run typecheck
npm run build
npm run server:build
```

Every command must exit zero in the current run. If one fails, use the systematic-debugging skill, add a focused regression test, fix the owning code, and rerun both the focused command and this complete block.

- [ ] **Step 2: Run the deterministic fixture journey in the built application**

Verify first approval, CLI and token-present states, repository override, mapped-label setup, initial and manual refresh, source filtering, paging, pointer drag, keyboard `Move to`, close, reopen, conflict resolution, stale response, rate-limited state, failed rollback, cache clearing, approval revocation, and app restart cache recovery.

- [ ] **Step 3: Capture visual evidence**

Capture Settings, mixed board, each source filter, summary modal, conflict, syncing, stale, rate-limited, and error states at desktop and 390px widths in dark and light themes. Record refresh, movement, close, reopen, filtering, failed rollback, and a keyboard-only essential journey. Compress and attach these to the pull request without adding them to Git.

- [ ] **Step 4: Perform a live GitHub check within explicit authority**

If an authorised test repository is available, verify create-missing-labels, read, move, close, and reopen against it and restore its intended final state. Otherwise perform only a live read-only refresh and retain write evidence from the controlled HTTP fixture.

- [ ] **Step 5: Review the final diff and commit any evidence-driven fix**

Run `git status --short`, `git diff --stat origin/main...HEAD`, and `git diff origin/main...HEAD`. Confirm `.superpowers/` and all media captures are untracked and excluded. Commit only source, tests, and documentation.

### Task 11: Sol review, publication, and pull-request checks

**Files:**
- No planned product changes. Any review fix must add or update the owning focused test.

**Interfaces:**
- Produces: pushed branch and a checked pull request.
- Consumes: clean verified branch and visual evidence links.

- [ ] **Step 1: Request a read-only Sol code review**

Ask Sol to review `origin/main...HEAD` for correctness, security, tests, accessibility, and design fidelity. Resolve every Critical and Important finding with a red and green focused test, then repeat full verification.

- [ ] **Step 2: Publish intentionally**

Use the `github:yeet` skill. Confirm the diff scope, push `feat/github-issues-kanban-sync`, and open a pull request against `main` with the approved design summary, security model, automated results, live or fixture limitation, screenshots, and recording.

- [ ] **Step 3: Wait for GitHub checks and address failures**

Use the `github:gh-fix-ci` skill for any failing GitHub Actions check. Do not merge in this task unless the user separately asks for merge.

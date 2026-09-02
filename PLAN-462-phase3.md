# Issue #462 phase 3: explicit GitHub attachment + canvas chip + worktree PR suggestion

## Context

Phases 1 (source registry, PR #513) and 2 (read-only PR cards, PR #584) are merged. Phase 3 is the
first phase that creates a session ↔ PR/issue RELATIONSHIP. Maintainer rules (issue thread):

- A relationship exists ONLY when the user made it explicitly (or nodeterm itself performed the
  create/modify op, which is phase 4). Nothing is ever inferred from terminal output or transcripts.
- Worktree frames: **suggest, never adopt.** A frame whose branch has an open PR offers
  "PR #n open, attach?"; one click makes an ordinary explicit link. A bad guess costs a dismissed
  prompt, not a wrong chip.
- Canvas presence via the existing card ↔ node linkage, not a new node kind.
- Polling with ETags, never webhooks. Each phase independently shippable + revertible.

Decisions taken with the user (do not reopen):
- Storage = **node data** `CanvasNodeState.github?: GitHubLink[]` (git-shared content in
  `.nodeterm/project.json`, rides the relay canvas mirror free, works on group frames).
- **Many** links per node. Chip shows first + `+n`.
- Reverse indicator on GitHub cards and an agent-facing canvas-control `attach` verb: **out of
  scope** (state in PR body; verb can land later on the same write funnel).
- Mobile: N/A. `core/agent-status-mirror.ts` carries no node data; iOS board mirrors kanban
  assignments only. FYI-mention @eneskirca in the PR.

Ship as **two PRs** (via fork `Temikus/nodeterm`, per memory): 3a data + core lookup/search +
picker + chips; 3b `pullsForBranch` + worktree suggestion. 3a is complete on its own (frames get
manual attach via their menu).

Phase-2 tail items still open on `main` (maintainer asked; user offered a separate PR): `readOnly`
declared but unconsumed, `issue-limit` slice dilutes issues with PRs (`service.ts:775`). Not part of
this plan; fix in their own PR if asked.

## Existing facts the plan rests on

- `pull.head` is declared (`shared/github-issues.ts:74`) and cache-validated (`core/github/cache.ts:44-51`)
  but never populated; no `/pulls` call exists. PR #584 body: "phase 3 asks about one branch, which
  `/pulls?head=owner:branch` answers in one request".
- `client.getIssue` (`core/github/client.ts:247`) THROWS `invalid-request` on a PR. `moveIssue`
  relies on that guard. Do not loosen; add a sibling.
- `service.query` (`core/github/service.ts:299`) filters ONE cached snapshot by
  `columnId === request.columnId`, so a picker cannot ask "all columns" today.
- `sanitizeNodeTriggers` (`core/workspace-files.ts:45`) is the both-directions sanitizer precedent;
  `sanitizeInboundNode` (`shared/node-exec.ts:103`) is the relay inbound hook.
- Serializers enumerate keys explicitly: `nodeStatesToFlow` (`renderer/state/workspace.ts:1744`,
  data literal ~:1788) and `flowToNodeStates` (:1828, ~:1862). Round-trip test precedent
  `workspace.trigger.test.ts`.
- `registerGitHubIntegration` (`core/github/integration.ts:69`) registers handlers for BOTH shells
  (`src/main/index.ts:1563`, `src/server/index.ts:328`); ws-bridge `buildGitHubApi`
  (`renderer/bridge/ws-bridge.ts:405`); relay jail switch `githubIssuesProject`
  (`main/remote/relay-host.ts:199`, test at `relay-host.test.ts:411+`); relay guest forwards the whole
  `githubIssues` namespace (`renderer/bridge/relay-api.ts:90`).
- Chip/menu precedents: `span.node-account-chip` and `span.term-node__status--x` before
  `.term-node__spacer` (`nodes/TerminalNode.tsx:4741-4920`); `HIDEABLE_MENU_ITEMS`
  (`renderer/lib/ui-visibility.ts:22`); `selectionItems` (`canvas/Canvas.tsx:7131`), `groupItems`
  (:7702), sidebar menu reuses `selectionItems` (:10713); `setWorktreeActionHandler` module bridge
  (`nodes/GroupNode.tsx:18-22`); searchable menu idiom `components/BranchSelect.tsx` /
  `settings/SpeechLanguageSelect.tsx` (`.tab-backdrop` + `.tab-menu` + pinned filter, `useMenuFlip`).
- Kanban: `toKanbanSession` (`canvas/toKanbanSession.ts`), `KanbanSession` (`kanban/KanbanView.tsx:37`),
  `SessionCard.tsx` `.kanban-card__metarow`, `CardModal.tsx` `.kanban-modal__column` (:257),
  `CardMetaBar.tsx` `.kanban-meta__group` sections, `GitHubIssueSummaryModal` (kind-aware,
  `readOnly`, footer Open on GitHub), `pullCardState` (`lib/githubPull.ts`).
- Board log: `BoardLogEvent.type` union (`shared/types.ts:556`, payload only `from/to/title`);
  `boardLogDiff.ts` diffs KANBAN only, so node-data changes emit at the write site (precedent:
  `createNodeInColumn`'s `card-created`); `eventBody` (`kanban/BoardLogPanel.tsx:19`) degrades unknown
  types.
- `docs/github-issues-kanban.md` is stale after phase 2 (":47 Pull requests are excluded.",
  ":53 All, GitHub, or Sessions").

---

## PR 3a: attach a node to a GitHub issue / PR

### 1. Data model + sanitizer

`src/shared/github-issues.ts`:
```ts
export type GitHubLinkKind = 'issue' | 'pull'
export interface GitHubLink { kind: GitHubLinkKind; number: number; title?: string }  // title = display snapshot only
export const GITHUB_LINK_TITLE_MAX = 200
export const GITHUB_LINKS_PER_NODE_MAX = 20
```
`src/shared/types.ts` `CanvasNodeState`: `github?: GitHubLink[]` after `worktree?` (:394). Repository
is implicit (`kanban.github.repository`); `htmlUrl` is DERIVED, never stored.

New `src/shared/github-link.ts` (pure):
- `sanitizeGitHubLinks(value: unknown): GitHubLink[] | undefined`: non-array ⇒ undefined; entry must
  be a plain object; `kind` ∈ set else dropped; `number` safe int > 0 else dropped; `title` kept only
  if string, trimmed, non-empty, ≤ 200 (else title dropped, link kept); dedupe by `kind#number`
  first-wins; cap 20; rebuild objects with only the three keys; empty ⇒ undefined.
- `sanitizeNodeGitHubLinks(nodes)`: mirror of `sanitizeNodeTriggers`, no kind gate.
- `githubLinkUrl(repository, link)`: `https://github.com/<repo>/<issues|pull>/<n>`; `''` when repo falsy.

Call sites: `projectToFile` and `fileToProject` (`core/workspace-files.ts:257/:370`, wrap the
existing trigger sanitizer), `sanitizeInboundNode` (`shared/node-exec.ts:103`).

Serializers `renderer/state/workspace.ts`: `NodeData.github?`, `nodeStatesToFlow` data literal
`github: n.github`, `flowToNodeStates` `github: n.data.github`.

### 2. Core API: `lookup` + `search` (one definition in `src/core`, both shells)

`src/shared/github-issues.ts`:
```ts
export interface GitHubLookupRequest { projectId: string; number: number }
export type GitHubLookupResult =
  | { ok: true; item: GitHubIssueCardView; source: 'cache' | 'api' }
  | { ok: false; reason: 'not-found' | 'not-approved' | 'not-authenticated' | 'configuration-changed' | 'invalid-request' | 'failed'; message?: string }
export interface GitHubSearchRequest { projectId: string; search: string; kind?: 'issue' | 'pull'; limit: number }
export interface GitHubSearchResult { items: GitHubIssueCardView[]; partial: boolean }
```
`GitHubIssuesApi` gains `lookup(req)`, `search(req)`. Errors as VALUES for `lookup` (Electron
`invoke` and `RpcErr` both lose the typed code; UI must render `not-approved` as a disabled row).
`search` keeps `query`'s throw semantics (never hits the network).

`core/github/client.ts`: add `getIssueOrPull(repository, number): Promise<GitHubIssue>` to the class
and to `GitHubIssuesClientLike` (`service.ts:39`). Same URL as `getIssue`, same decode, but PR items
return with `pull` set via `pullFrom`. 404 ⇒ `GitHubClientError('not-found')` (check what `request()`
does with 404 today and map).

`core/github/service.ts`:
- Refactor `query`: extract snapshot → mapped → text/label filter into
  `private candidates(context, state, {kind?, search?, labelFilter?})` WITHOUT the columnId gate.
  `query` applies columnId + sort + paging + avatars as before. Existing service tests must pass
  unchanged (byte-identical output).
- `search(req)`: validate `limit` 1..50, `search.length ≤ 200` (`invalid-query`); `kind` absent ⇒
  BOTH kinds (differs from `query`; JSDoc says why); exact-number match (`/^#?(\d+)$/`) first, then
  `updatedAt desc, number desc`; no avatars; `partial = !state.snapshot && !!state.partialIssues`.
  **New method, not a `columnId` sentinel**: a sentinel would collide with a real column id, leak into
  `counts` keys and the relay jail, and force every `query` caller to handle a third state.
- `lookup(req)`: `positiveInteger` else `invalid-request`; `cacheContext` + `cachedState` with
  `GitHubHostError` mapped to `reason`; snapshot hit by number ⇒ `{ok:true, source:'cache', item:
  {...issue, ...mapping(issue, config)}}`; else `contextForProject` (auth) + `coordinator.runRead` +
  `getIssueOrPull`, epoch/generation checked like `moveIssue` (:385). Never writes into the snapshot
  (poll owns watermark + eviction). 60 s negative memo per `(repositoryKey, number)`.

Wiring, same order every time: `shared/ipc.ts` (`githubIssuesLookup: 'githubIssues:lookup'`,
`githubIssuesSearch: 'githubIssues:search'`) → `core/github/handlers.ts` (interface + `platform.handle`,
object-arg style) → `preload/index.ts` → `renderer/bridge/ws-bridge.ts buildGitHubApi` →
`main/remote/relay-host.ts githubIssuesProject` object-arg case group (**same commit as the channel**,
else a guest reaches a non-shared project) → `relay-host.test.ts:411` suite. `relay-api.ts` needs
nothing; `stubs.ts` lists the namespace as real, confirm nothing enumerates keys by hand.

### 3. Renderer helpers + store

`renderer/lib/githubLinks.ts` (pure): `linkKey`, `hasLink`, `addLink` (dedupe, cap, same ref on
no-op), `removeLink` (undefined when empty), `linkChipLabel` (`#123` / `#123 +2`), `linkTooltip`,
`linkState(link, card?)` → `open|closed|draft|merged|unknown` (pulls via `pullCardState`),
`parseLinkInput(text, repository)` (`#123`, `123`, `https://github.com/<repo>/issues|pull/123`;
other repo ⇒ null; `#0` ⇒ null), `linkToBoardTitle`.

`renderer/state/githubLinks.ts` (new zustand store; separate from `githubIssues.ts` whose per-project
record is replaced wholesale on `connect`):
- `cards[projectId][linkKey] = {card, at}`, `pending`, `missing` (60 s negative cache),
  `gate[projectId]` (`not-approved`/`not-authenticated` stops a dozen chips re-asking; retry 60 s).
- `ensureCard(api, projectId, link)`: no-op if cached < 5 min / pending / negative-cached / gated.
- `seedFromPages(projectId, pages)`: called from `githubIssues.reload` after `pageColumns` (free warm-up).
- `invalidate(projectId, numbers?)`: from `githubIssues.connect`'s `onChanged` handler.
- Canvas chips have no host subscription (board's is ref-counted); freshness = last lookup ≤ 5 min or
  last board open. Acceptable for a status dot; document.

### 4. UI

**Write funnel** (Canvas): `setNodeGitHubLinks(nodeId, next, event?)` = `setNodes` map + `markDirty()`
+ `useBoardLog.getState().append(api, projectId, {kind:'event', nodeId, event})`. Exposed to nodes
via a module-level bridge `renderer/canvas/githubLinkActions.ts` (`setGitHubLinkHandler`,
`attachGitHubLink`, `detachGitHubLink`, `openGitHubLinkPicker`, `openGitHubLinkDetails`), registered
in the same effect as `setWorktreeActionHandler`. Canvas-level state renders the picker and a
read-only `GitHubIssueSummaryModal` (kind-aware; `readOnly`, moves stay a board affair).
`repository = parseGitHubRepository(kanban?.github?.repository)`; `githubConfigured = !!repository`.

**`components/github/GitHubLinkPicker.tsx`**: searchable `.tab-menu` idiom. Props `{projectId,
repository, existing, initialQuery?, kindFilter?, preset?: GitHubBranchPull[], anchor, onPick, onClose}`.
Debounced 150 ms: `parseLinkInput` hit ⇒ `lookup`; else `search({search, kind, limit: 20})`; empty ⇒
20 most recent, both kinds. Row: state dot, `#n`, title, PR badge; already-attached rows disabled.
States: not-approved / not-authenticated ⇒ one disabled row with reason; `partial` footer;
`not-found` row. Enter picks first, Esc closes. `useSession()` for `api` (relay/server aware).

**`components/github/GitHubLinkChip.tsx`** `{nodeId, links, variant: 'node'|'card'|'modal'|'group'}`:
`span.github-link-chip.nodrag` + `i.github-link-chip__dot--{state}` (first link) + `linkChipLabel`;
`title` tooltip; `useEffect` ⇒ `ensureCard` each link; nothing when empty or unconfigured. Click /
right-click (stopPropagation) ⇒ `ContextMenu`: per link `Open #n details` / `Open #n on GitHub`
(`api.shell.openExternal(githubLinkUrl(...))`) / `Detach #n` (flat ≤ 3 links, submenu per link
beyond), then `Attach another…`. Mount points: `TerminalNode` after the SSH chip, before
`.term-node__spacer`; `StickyNode` and `BrowserNode` header rows (cheap, same one-liner). CSS beside
`.node-account-chip`; `.term-node--collapsed .github-link-chip { max-width }` + ellipsis. Chip is
inside the node root, so the `SharedGlyphLayer` sibling-rect gap does not apply.

**Menus**: `ui-visibility.ts` `HIDEABLE_MENU_ITEMS` += `github-attach`. `selectionItems`: single
node of kind terminal/sticky/browser AND `githubConfigured` AND not hidden ⇒ `Attach GitHub issue /
PR…` (opens picker); existing links ⇒ `Detach` submenu. Hidden entirely (not disabled) when
unconfigured. Sidebar menu inherits. `groupItems`: same attach row after "Bind to worktree…";
`GroupNode` renders `GitHubLinkChip variant="group"` in its label bar.

**Kanban** (same nodes, so both views agree for free): `KanbanSession.github?` via
`toKanbanSession` for all three kinds; `KanbanViewProps` += `onChangeNodeLinks(nodeId, next, event?)`
+ `githubRepository?`; `SessionCard` chip first in `.kanban-card__metarow` and card right-click
"Attach…"; `CardModal` chip after `.kanban-modal__column`; `CardMetaBar` fifth group "GitHub" (only
when repository set): one row per link with `×` detach, `Attach…` button opening the SAME picker.

**Board log**: `BoardLogEvent.type` += `'github-attached' | 'github-detached'` (`title` = `#n Title`,
`to` = kind); `eventBody` renders "attached PR #n Title" / "detached …". `boardLogDiff.ts` untouched.

### 5. Docs (same PR, house rule)
- `docs/github-issues-kanban.md`: fix phase-2 staleness (:47, :53) and add "Linking sessions to
  issues and pull requests" (explicit-only rule, chip, kanban group, no reverse indicator yet).
- `CLAUDE.md` Kanban bullet: `CanvasNodeState.github`, sanitize-both-ways rule, why `search` is a
  method not a sentinel, `getIssue` PR guard kept + `getIssueOrPull` opt-in.
- `CONTRIBUTING.md` house rules: a new `githubIssues:*` channel must land in the relay-host jail
  switch in the same commit.

### 6. Tests (3a)
| File | Pins |
|---|---|
| `src/shared/github-link.test.ts` | every sanitizer rule; `githubLinkUrl` both kinds |
| `src/core/workspace-files.github-links.test.ts` | round-trip both directions; hostile file normalized on read AND write |
| `src/renderer/state/workspace.github-links.test.ts` | flow serializers round-trip on terminal/sticky/browser/group |
| `src/shared/node-exec.test.ts` (extend) | `sanitizeInboundNode` caps `github` |
| `src/core/github/client.test.ts` (extend) | `getIssueOrPull` returns PR with `pull`; `getIssue` still rejects it; 404 ⇒ `not-found` |
| `src/core/github/service.test.ts` (extend) | `lookup` cache-first (no client call), API fallback, typed errors not throws; `search` ignores columns, both kinds default, exact-number first, limit bounds; `query` byte-identical after refactor |
| `src/core/github/handlers.test.ts` (extend) | new channels dispatch |
| `src/main/remote/relay-host.test.ts` (extend) | `lookup`/`search` on `proj-2` ⇒ forbidden, handler never reached |
| `src/renderer/lib/githubLinks.test.ts` | add/remove/label/parse/linkState |
| `src/renderer/state/githubLinks.test.ts` | coalescing, negative cache, gate, invalidate |
| `src/renderer/components/github/GitHubLinkChip.test.tsx` (jsdom) | label `#12 +1`, dot from cached card, menu items, Detach calls handler, nothing without repository |
| `src/renderer/components/github/GitHubLinkPicker.test.tsx` (jsdom) | `#12` ⇒ lookup not search; foreign URL ⇒ no call; not-approved disabled row; attached row disabled; Enter picks first |
| `src/renderer/components/kanban/CardMetaBar.test.tsx` (new) | group hidden without repo; lists links; × emits `github-detached` |
| `BoardLogPanel` test (extend) | `eventBody` both types |
| `src/renderer/canvas/toKanbanSession.test.ts` (extend) | `github` copied for all kinds |

### 7. Commit order (3a)
1. shared types + `github-link.ts` + tests
2. workspace-files both directions + `sanitizeInboundNode` + tests
3. workspace serializers + round-trip test
4. core `getIssueOrPull`, `candidates` refactor, `lookup`, `search`; ipc/handlers/preload/ws-bridge/relay jail + tests
5. `lib/githubLinks.ts`, `state/githubLinks.ts`, seed from `githubIssues.reload`
6. picker, chip, Canvas funnel + modals, menus, kanban surfaces, board-log types + `eventBody`, CSS
7. docs

---

## PR 3b: worktree frames suggest their open PR (suggest, never adopt)

### 1. Core `pullsForBranch`

`shared/github-issues.ts`:
```ts
export interface GitHubBranchPull { number: number; title: string; draft: boolean; head: string; updatedAt: string; htmlUrl: string; state: 'open' }
export type GitHubPullsForBranchResult =
  | { ok: true; pulls: GitHubBranchPull[]; fetchedAt: number; fromCache: boolean }
  | { ok: false; reason: 'not-approved' | 'not-authenticated' | 'configuration-changed' | 'invalid-request' | 'rate-limited' | 'failed'; message?: string }
```
`GitHubIssuesApi.pullsForBranch({projectId, branch, force?})`.

`client.ts` `listPullsByHead(repository, head, {perPage})`: `safeRepository`; `head` matches
`/^[^\s:]+:[^\s]+$/`, ≤ 300; `GET /repos/{repo}/pulls?head=<owner>:<branch>&state=open&per_page=10`.
**No `since`, no etag** (endpoint ignores `since`; TTL cache replaces the etag). Decode number, title
(≤ 1000), draft, `head.ref`, `updated_at`, `html_url` (https github.com only); > 100 items ⇒
`malformed-response`.

`service.ts` `pullsForBranch`: validate branch (non-empty, ≤ 255, no whitespace/`:`); approval +
auth gates mapped to `reason` as in `lookup`; owner = `context.repository.split('/')[0]` (host-resolved,
never renderer-supplied); in-memory cache keyed `${repository}\0${branch}`, `BRANCH_PULLS_TTL_MS =
5 min`, max 200 entries LRU, in-flight coalescing, `force` skips TTL but still coalesces; fetch via
`coordinator.runRead`; return the lean `GitHubBranchPull[]` (the live card comes through `lookup`
once attached). `pull.head` is populated ONLY where `lookup` enriches a snapshot item from this
cache (one place; poll snapshot stays unpolluted). Invalidate on `clearCache` and in
`onCredentialBoundaryChange` (`integration.ts:54`).

Wiring: same chain + relay jail + tests as 3a.

### 2. Renderer
`state/githubLinks.ts` += `pullSuggestions[`${projectId}:${groupId}`] = {branch, pulls, at,
error?}`, `fetchPullsForBranch(api, projectId, groupId, branch, {force?})`, `dismissed: Set<string>`
(`${projectId}:${groupId}:${number}`) hydrated from localStorage `nodeterm.prSuggestDismissed`
(JSON array, cap 500). `lib/githubLinks.ts` += `suggestionFor(links, pulls, dismissed)` (open PRs
minus already-linked `pull` numbers minus dismissed, `updatedAt desc`).

### 3. GroupNode
- Effect keyed `[wtPath, branch, githubConfigured]`: `wtPath` is already `undefined` on SSH projects
  (`GroupNode.tsx:63`), so SSH frames fetch nothing. Fires when the frame is on screen + page visible
  (reuse the existing visibility/IntersectionObserver gating in the status-poll effect, expose the
  on-screen edge via a ref) on mount and on branch change (`status?.branch || wt.branch`). **Never a
  timer.** Skipped when unconfigured or `gate` set.
- Render `candidates.length ≥ 1` as `div.group-node__pr-suggest.nodrag`: label "PR #123 open" /
  "PR #123 draft" (`> 1` ⇒ "N open PRs"), `button.group-node__wt-btn` **Attach** ⇒
  `attachGitHubLink(id, {kind:'pull', number, title})` (ordinary explicit link + board-log event; for
  N > 1 opens the picker with `preset: candidates`), `×` ⇒ `dismiss(...)`.
- `ok:false` renders nothing on the frame; `not-approved` sets `gate`.
- `groupItems` (worktree, non-SSH): `Check for pull request` ⇒ `fetchPullsForBranch(..., {force:true})`.
- Two frames on one branch share the service cache; dismissal is per group id (intentional, note in docs).

### 4. Tests (3b)
| File | Pins |
|---|---|
| `client.test.ts` (extend) | URL `/repos/o/r/pulls?head=o%3Abranch&state=open&per_page=10`, no `since`, no `if-none-match`, head validation, malformed item |
| `service.test.ts` (extend) | TTL with fake `now`; two concurrent ⇒ one client call; owner from host repo; `force` bypasses TTL; `clearCache` + credential change drop cache; `rate-limited` mapping; `lookup` enriches `head` |
| `handlers.test.ts`, `relay-host.test.ts` (extend) | channel dispatch; jail |
| `lib/githubLinks.test.ts` (extend) | `suggestionFor` |
| `state/githubLinks.test.ts` (extend) | dismiss persists + survives fresh store |
| `src/renderer/nodes/GroupNode.github.test.tsx` (jsdom) | fetch once on mount-visible, again on branch change, fake timers +10 min ⇒ still 1 call; suggestion row renders; **no** node write without a click; Attach ⇒ handler `{kind:'pull', number}`; dismissed hidden after remount; already-linked hidden; SSH ⇒ 0 fetches; unconfigured ⇒ 0 fetches |

### 5. Docs
`docs/github-issues-kanban.md` suggestion section (suggest-never-adopt, dismissal is machine-local,
per-frame); CLAUDE.md Worktrees + Kanban bullets; PR body mentions the rate budget (≤ 1 request per
visible frame per 5 min).

---

## Risks / open points
- `query` → `candidates` refactor must keep order, `counts`, `partial` identical; run
  `service.test.ts` before writing `search`.
- Chip width in collapsed terminal nodes (header already holds title/session/account/SSH chips).
  Verify visually on a narrow node.
- Canvas chip freshness without a host subscription is bounded at 5 min; a later phase can
  `acquireHostSubscription` while any chip is visible.
- Relay guest attaching: node-data write rides the canvas mirror; confirm `useBoardLog.append` for
  `kind:'event'` is relay-routed like comments.
- Title snapshot in project.json goes stale after a GitHub rename; chip prefers the live card and
  only falls back. No refresh-on-save.
- `stubs.ts` github namespace: confirm nothing builds the API by hand-enumerated keys.

## Verification
1. `npm run typecheck` and `npm test` green (all new tests above; existing kanban/github tests
   unchanged).
2. Desktop, project with `kanban.github.repository` approved: right-click terminal node → Attach →
   type `#<n>` and a title fragment → pick → chip `#n` with correct state dot; chip menu Open details
   (modal, read-only) / Open on GitHub / Detach; board card + card modal show the same chip; CardMetaBar
   group lists + detaches; board log shows attached/detached rows; `.nodeterm/project.json` carries
   `github: [{kind, number, title}]`; hand-edit it to `kind:'commit'`, 500 entries, `number:-1` →
   reload drops/normalizes, no crash.
3. Unconfigured project: no Attach row anywhere, no chip.
4. 3b: bind a worktree frame on a branch with an open PR → frame shows "PR #n open · Attach · ×";
   nothing attaches until Attach is clicked; × hides it across restart; Attach makes the chip;
   network tab shows one `/pulls?head=` request per branch per 5 min, none on a timer; SSH project
   frame shows nothing.
5. Server Edition (`npm run server:dev`): attach flow works in the browser; relay guest: `lookup` on a
   non-shared project id is refused (unit test) and the shared project works.

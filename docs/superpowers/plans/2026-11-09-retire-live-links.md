# Retire Live links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Live links feature from nodeterm-server, nodeterm-web and nodeterm (desktop + Server Edition) for good, while old desktop apps end their links cleanly and every feature that borrowed a live-link seam keeps working.

**Architecture:** Three independent PRs, one per repo, released backend → web → desktop. The backend replaces its live-link routes with a stateless stub whose answers an old desktop already reads as "this link is over". The web page `/s/<id>` becomes a static 410 page. The desktop first moves the shared seams out of `src/core/watch-link/`, then deletes the feature from the outside in (renderer UI → API surface and both shells → core engine → dead options → docs), keeping typecheck and the suite green after every task.

**Tech Stack:** Hono + vitest + pglite (server); Astro 5 + vitest (web); Electron + React + TypeScript + vitest (desktop).

**Spec:** `docs/superpowers/specs/2026-11-07-retire-live-links-design.md` (nodeterm repo, branch `chore/retire-live-links`). Its **Appendix A** is the removal map for the desktop, with line numbers on `origin/main` `54ad85512`. Line numbers drift; the symbols do not. Every desktop task below names the Appendix A sections it covers; read them.

## Global Constraints

- Never push `main` in any repo. One feature branch per repo, `chore/retire-live-links`, and a PR; enes merges.
- Worktrees: desktop `/root/nodeterm/wtshare` (branch already exists, holds the spec); server `/root/nodeterm-server-retire-links`; web `/root/nodeterm-web-retire-links` (both created in their part's first task, from `origin/main`). Never edit `/root/nodeterm`, `/root/nodeterm-server` or `/root/nodeterm-web` directly. Never bare `git stash`.
- Desktop tests: `HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run <paths>` and `npm run typecheck`. The worktree has its own `node_modules`; if `package-lock.json` changed since it was installed, run `npm ci` in `/root/nodeterm/wtshare` (never in `/root/nodeterm`).
- Server tests: `npx vitest run` and `npm run typecheck`. Web: `npx vitest run`, `npm run check`, `npm run build`.
- Never touch tmux `-L node-terminal` / `-L nodeterm-rmt`. Kill processes by exact PID only.
- Code, comments, commits and PRs in English. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never take away anything under "Core — free forever" in `ProCompare.tsx`.
- No database migration. The `watchLinks` table definition stays in `schema.ts`.
- Backend stub answers (all POST), exactly:
  - `/v1/watch-links/:id/host-token` → `410 {"error":"gone","reason":"revoked"}`
  - `/v1/watch-links` → `410 {"error":"retired"}`
  - `/v1/watch-links/:id/status` → `200 {"state":"revoked"}`
  - `/v1/watch-links/:id/revoke` and `/v1/watch-links/revoke-all` → `204`, empty body
  - `/v1/watch-links/:id/join` → `410 {"error":"gone","reason":"revoked"}`
- CORS only on `/v1/watch-links/:id/join`, origin exactly `https://nodeterm.dev`. Per-IP limit 30 requests/minute. No DB access, no license lookup.
- Web retired page: status **410** for any id, no JS, no API or relay call, copy: "Live links were a nodeterm feature for sharing a terminal in the browser. It has been retired, so this link no longer works." plus a link to `https://nodeterm.dev`.
- Desktop: moves land in their own commit before any deletion. `types.ts`, preload and the three bridge files change in ONE commit (`satisfies NodeTerminalApi`).
- Desktop data cleanup removes, from the data dir's top level only: `watch-links.json`, `watch-links.json.corrupt-<digits>`, and `watch-links.json.tmp` / `watch-links.json.<pid>.<seq>[.<uuid>].tmp`. Nothing wider. localStorage keys removed: `nodeterm.liveLinkDefaults`, `nodeterm.liveChatPinned`, `nodeterm.liveChatLink`.
- `docs/superpowers/` is gitignored: stage files there with `git add -f`. Old specs/plans and release notes stay.

## Review Focus

1. **A request body an old client never sent, or none at all.** The stub must not read the body: no body, non-JSON, or a wrong shape gets the same answer as a real client's body, never a 400 (an old host maps 400 on host-token to "refused" and keeps the link up). Pinned in Task 1.
2. **The old viewer tab's CORS preflight.** `OPTIONS /v1/watch-links/<id>/join` from `https://nodeterm.dev` must succeed, or the tab reads a network error and retries every 30 s forever; another origin gets no `access-control-allow-origin`; no other route answers with CORS headers. Pinned in Task 1.
3. **Look-alike files in the data dir.** `watch-links.json.bak`, `my-watch-links.json`, `watch-links.jsonx`, and a DIRECTORY named `watch-links.json.corrupt-1` must survive the cleanup; a symlink named `watch-links.json` is removed as a link and its target is untouched. Pinned in Task 5.
4. **Odd ids on the web page.** A 22-character id, a short one, a 500-character one and a percent-encoded bidi/`..` id all get the 410 page, never a 500 or a 404. Pinned in Task 3.
5. **localStorage that throws** (private mode, quota, a blocked origin): renderer boot must not throw while removing the old keys, and each key is attempted even if an earlier one threw. Pinned in Task 5.

---

## Part A — nodeterm-server

### Task 1: The retired stub replaces the live-link routes

**Files:**
- Create: `src/routes/watch-links-retired.ts`, `test/watch-links-retired.test.ts`
- Modify: `src/app.ts` (import l.15, `resolveWatchLinkMaxTtl` 76–86, the `logApi` comment ~109, registration 156–162), `src/routes/admin.tsx` (imports l.10, l.28; the `?link=` lookup, `linkCols` and the `links` query 636–695; the "Live links" card ~1136–1212; `/admin/watch-links/:id/revoke` 1292–1299; the `form.lookup` CSS 323–324 if nothing else uses it), `test/admin.test.ts` (the live-link tests ~116–215, `watchLinks` in the l.5 import), `test/google-license.test.ts` (the `'watch-links liveness — a Google owner'` describe ~356–391 and the l.8 import)
- Delete: `src/routes/watch-links.ts`, `test/watch-links.test.ts`

**Interfaces:**
- Produces: `registerWatchLinksRetired(app: Hono, opts?: { ipLimitPerMinute?: number }): void` and `export const RETIRED_VIEWER_ORIGIN = 'https://nodeterm.dev'` in `src/routes/watch-links-retired.ts`. No `db` parameter, no import from `../db`.

- [ ] **Step 1: Create the worktree**

```bash
cd /root/nodeterm-server && git fetch origin && git worktree add -b chore/retire-live-links /root/nodeterm-server-retire-links origin/main
cd /root/nodeterm-server-retire-links && npm ci
```

- [ ] **Step 2: Write the failing tests** in `test/watch-links-retired.test.ts`. Build the app as `const app = new Hono(); registerWatchLinksRetired(app, { ipLimitPerMinute })`. Tests:
  - `each route answers what an old desktop reads as "over"` — for each route in Global Constraints, `status` and parsed body (or `''` for 204) equal exactly, sent with an old client's body `{ entitlement: 'x', joinKeyHash: 'f'.repeat(64), ttlSeconds: 3600 }` (create) / `{ entitlement: 'x' }` (owner routes) / `{ joinKey: 'A'.repeat(43) }` (join), with id `'A'.repeat(22)`.
  - `the answer does not depend on the body or the id` — each route again with no body, with `'not json'`, with `{}`; ids `'x'` and `'A'.repeat(22)`: same status and body as above (Review Focus 1).
  - `join admits the viewer origin and no other` — `OPTIONS /v1/watch-links/A/join` with `Origin: https://nodeterm.dev`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: content-type` → 2xx, `access-control-allow-origin` = `https://nodeterm.dev`; a POST from that origin carries the header; a POST from `https://evil.example` does not (Review Focus 2).
  - `no other route answers with CORS` — POST host-token, status, revoke, revoke-all and create with `Origin: https://nodeterm.dev`: no `access-control-allow-origin` header.
  - `per-IP limits: owner routes and join keep separate windows` — with `ipLimitPerMinute: 2`: two host-token POSTs answer 410, the third answers 429; then two join POSTs still answer 410.
  - `the stub never touches the database` — `readFileSync('src/routes/watch-links-retired.ts')` has no `from '../db` and `registerWatchLinksRetired.length <= 2`.
  - `createApp wiring: one [api] line per request` — `createApp(db)` from `makeTestDb()` with NO licensing config; spy `console.log`; POST `/v1/watch-links` and `/v1/watch-links/A/host-token`; the `[api]` lines are exactly `'[api] POST /v1/watch-links ip=local status=410'` and `'[api] POST /v1/watch-links/A/host-token ip=local status=410'`.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/watch-links-retired.test.ts`
Expected: FAIL (module `../src/routes/watch-links-retired` not found).

- [ ] **Step 4: Implement `registerWatchLinksRetired`.** Two `rateLimit({ windowMs: 60_000, max: opts.ipLimitPerMinute ?? 30 })` instances (owner routes, join). `app.use('/v1/watch-links/:id/join', cors({ origin: RETIRED_VIEWER_ORIGIN, allowMethods: ['POST'], allowHeaders: ['content-type'], exposeHeaders: ['Retry-After'], maxAge: 600 }))`. Handlers return the fixed answers without calling `c.req.json()`. A header comment says: retired 2026-11; each answer is the one an old desktop's `src/core/watch-link/api.ts` turns into a clean stop (host-token 410 → `gone`; status `revoked` ends a FULL link, which never calls host-token, within 60 s; revoke 204 = Stop succeeds), and CORS on join lets an old open viewer tab read its 410 and show "ended".

- [ ] **Step 5: Swap the registration in `src/app.ts`.** Remove `registerWatchLinks`, `resolveWatchLinkMaxTtl` and both env reads. Call `registerWatchLinksRetired(app)` right after `app.use('/v1/watch-links/*', logApi)`, outside `if (licensing)` (it needs nothing; my call). Keep the `logApi` registration; reword its comment to say the stub's traffic is logged so old clients dying off stays visible.

- [ ] **Step 6: Remove the admin live-links card and revoke route**, the old route, its test file and the Google-owner live-link describe. Drop every import that becomes unused (tsc names them).

- [ ] **Step 7: Run the suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, and `grep -rn "registerWatchLinks\b\|resolveWatchLinkMaxTtl\|isWatchLinkId\|/admin/watch-links" src test` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "feat(watch-links): retire live links — a stateless stub ends old clients cleanly"
```

### Task 2: Dead code, comments and operator docs

**Files:**
- Modify: `src/lib/google-entitlements.ts` (comment l.16; delete `liveByLicenseId` ~335–343), `test/google-entitlements.test.ts`, `src/db/schema.ts` (comments ~194–197, 404, 448), `src/relay/limits.ts` (comments 32, 45), `README.md` (`### Live links` 99–120, l.515), `.env.example` (29–39)

**Interfaces:**
- Consumes: Task 1 (no caller of `liveByLicenseId` remains in `src/`).

- [ ] **Step 1: Delete `liveByLicenseId`** and fix its tests in `test/google-entitlements.test.ts`: drop it from the l.13 import; delete the `liveByLicenseId` lines at ~109, 314, 315, 346 and 523 (each already has a `liveGoogleEntitlement` or `row()` assertion that pins the same fact); replace the one at ~327 with `expect((await liveGoogleEntitlement(db, DEV_A, NOW))?.licenseId).toBe('google:GPA.old')`.

- [ ] **Step 2: Reword the comments.** `google-entitlements.ts:16`: "every watch link keyed by it" → "everything keyed by it". `schema.ts` table comment: live links were retired 2026-11; nothing reads or writes `watch_links`; the definition is kept so drizzle generates no DROP until a separate drop migration. `schema.ts:404`: `git grep -n originalTransactionId src` — if nothing queries it, say the index is kept because dropping it is a migration (it once served live links); if something does, name it. `schema.ts:448`: drop "Live links and". `limits.ts:32`: drop "the live-link viewer" from the client list; `:45`: drop "a desktop holds one per live-link viewer,".

- [ ] **Step 3: Operator docs.** Replace README's `### Live links` section with a short `### Live links (retired)` paragraph: `/v1/watch-links/*` is a stub (the answers from Global Constraints, one line), CORS on join for `https://nodeterm.dev`, no env vars, and the one data step `UPDATE watch_links SET revoked_at = now() WHERE revoked_at IS NULL;`. README l.515: drop "live links" from the list. Delete the `.env.example` live-links block.

- [ ] **Step 4: Verify**

Run: `npx vitest run && npm run typecheck && git grep -niE "watch_link_|live.?link" -- src test README.md .env.example`
Expected: PASS; the grep shows only the schema comment, the README "(retired)" section and the stub's header.

- [ ] **Step 5: Commit**

```bash
git add -A src test README.md .env.example
git commit -m "chore: drop live-link liveness helper, env and docs; keep the table"
```

---

## Part B — nodeterm-web

### Task 3: `/s/<id>` becomes a static 410 page

**Files:**
- Modify: `src/pages/s/[id].astro` (rewrite), `package.json` + `package-lock.json`, `.gitattributes`
- Create: `vitest.config.ts`, `src/lib/retired-link-page.test.ts`
- Delete: `src/lib/watch-link/**`, `src/lib/watch-viewer/**`, `scripts/vendor-watch-link.mjs`, `src/lib/viewer-headers.ts`, `src/lib/viewer-headers.test.ts`

**Interfaces:**
- Produces: the default export of `src/pages/s/[id].astro`, rendered by `experimental_AstroContainer` from `astro/container`.

- [ ] **Step 1: Create the worktree**

```bash
cd /root/nodeterm-web && git fetch origin && git worktree add -b chore/retire-live-links /root/nodeterm-web-retire-links origin/main
cd /root/nodeterm-web-retire-links && npm ci
```

- [ ] **Step 2: Add `vitest.config.ts`** so tests can import `.astro` files:

```ts
/// <reference types="vitest" />
import { getViteConfig } from 'astro/config'
export default getViteConfig({ test: {} })
```

(Measured in a scratch worktree: the existing feedback and release-notes tests pass under it.)

- [ ] **Step 3: Write the failing test** `src/lib/retired-link-page.test.ts` (outside `src/pages`, so it never becomes a route): `const c = await AstroContainer.create()`, `c.renderToResponse(Page, { params: { id } })` for ids `'A'.repeat(22)`, `'not-a-link'`, `'x'.repeat(500)`, `'%E2%80%AE..%2F'` (Review Focus 4). Each: `status === 410`; text contains `It has been retired, so this link no longer works.` and `href="https://nodeterm.dev"`; text has no `<script`, no `watch-viewer`, no `relay.nodeterm.dev` and no `api.nodeterm.dev`.

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/lib/retired-link-page.test.ts`
Expected: FAIL (the current page answers 200/404 and ships a script).

- [ ] **Step 5: Rewrite `src/pages/s/[id].astro`.** Frontmatter sets `Astro.response.status = 410` unconditionally and imports only `../../styles/global.css` and `../../components/SocialMeta.astro`. Markup follows `src/pages/support.astro`'s shape (head with title "Live links retired — nodeterm", `<meta name="robots" content="noindex">`, the site nav and footer) with the spec's sentence and a link to `https://nodeterm.dev`. No `<script>`, no `viewerHeaders`.

- [ ] **Step 6: Delete the viewer.** The files listed above; the two `src/lib/watch-link` lines in `.gitattributes` (delete the file if it becomes empty). Confirm `git grep -nE "@xterm|tweetnacl|jsdom" -- src scripts` prints nothing, then `npm uninstall @xterm/xterm @xterm/addon-unicode11 tweetnacl jsdom`.

- [ ] **Step 7: Verify**

Run: `npx vitest run && npm run check && npm run build`
Expected: all PASS. Then `node ./dist/server/entry.mjs` on a free port (`PORT=4399 HOST=127.0.0.1`), `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4399/s/AAAAAAAAAAAAAAAAAAAAAA` → `410`, same for `/s/x`; stop the server by its exact PID.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: retire the live-link viewer — /s/<id> answers a static 410 page"
```

---

## Part C — nodeterm (desktop + Server Edition)

All tasks run in `/root/nodeterm/wtshare` on `chore/retire-live-links`.

### Task 4: Move the shared seams out of live links (no behaviour change)

**Files:**
- Move (`git mv`): `src/core/watch-link/pane-input{.ts,.test.ts,.realtmux.test.ts}` → `src/core/pane-input…`; `src/core/watch-link/capture-route{.ts,.test.ts,.realtmux.test.ts}` → `src/core/capture-route…`
- Create: `src/renderer/lib/projectSessionSource.ts`, `src/renderer/lib/chatLabels.ts`, `src/renderer/lib/chatLabels.test.ts`
- Modify: every importer — `core/pty-manager.ts`, `core/pty-manager.capture-visible.test.ts`, `core/pty-manager.control-input.test.ts`, `core/remote-ssh/control-master{.ts,.test.ts}`, `core/remote-ssh/capture-visible.realsh.test.ts`, `main/remote/host-service.ts:61`, the `core/watch-link/*` files that import them (`link-host.ts` and its test, and any other `grep` finds); for the renderer helpers `LiveLinkChip.tsx`, `SessionsSidebar.tsx`, `SessionRow.tsx`, `kanban/{KanbanView,ModalTerminal,GlobalKanbanView,CardModal,SessionCard}.tsx`, `settings/sections/LiveLinksSection.tsx`, `lib/live-link.guard.test.ts`, `LiveLinkChip.test.tsx`, `nodes/ChatPanel.tsx`, `LiveChatDrawer.tsx`, `lib/liveChatLook{.ts,.test.ts}`

**Interfaces:**
- Produces: `src/core/pane-input.ts` (same exports as before, `WatcherInputRoute` / `WATCHER_INPUT_ROUTES` included until Task 8), `src/core/capture-route.ts` (same exports), `projectSessionSource(projectId: string): SessionSource | null` in `renderer/lib/projectSessionSource.ts`, `newMessagesLabel(n: number): string` in `renderer/lib/chatLabels.ts`.

- [ ] **Step 1: Move the two core modules and their tests;** fix their own relative imports (`../paste-injection` → `./paste-injection`, `../remote-ssh/…` → `./remote-ssh/…`, `../../shared/…` → `../shared/…`, `../tmux-…` → `./tmux-…`) and every importer.

- [ ] **Step 2: Move the two renderer helpers,** bodies unchanged; move `newMessagesLabel`'s test case from `liveChatLook.test.ts` into `chatLabels.test.ts`; point every importer at the new modules.

- [ ] **Step 3: Verify the move is clean**

Run: `npm run typecheck && HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/core/pane-input src/core/capture-route src/core/pty-manager.capture-visible.test.ts src/core/remote-ssh/control-master.test.ts src/core/remote-ssh/capture-visible.realsh.test.ts src/renderer/lib/chatLabels.test.ts src/renderer/components/kanban src/renderer/nodes/ChatPanel`
Expected: PASS. `git diff --cached -M --stat` shows the six core files as renames with ~0 content change.

- [ ] **Step 4: Commit**

```bash
git add -A src
git commit -m "refactor: move pane input, visible capture and two renderer helpers out of live links"
```

### Task 5: The retired-data cleanup (modules only, wired in Tasks 6 and 7)

**Files:**
- Create: `src/core/retired-data-cleanup.ts`, `src/core/retired-data-cleanup.test.ts`, `src/renderer/lib/retiredStorage.ts`, `src/renderer/lib/retiredStorage.test.ts`

**Interfaces:**
- Produces: `isRetiredLiveLinkFile(name: string): boolean`; `removeRetiredLiveLinkData(dir: string, warn?: (message: string) => void): Promise<number>` (number of entries removed; never throws; `warn` defaults to `console.warn`); `RETIRED_STORAGE_KEYS: readonly ['nodeterm.liveLinkDefaults', 'nodeterm.liveChatPinned', 'nodeterm.liveChatLink']`; `removeRetiredStorageKeys(storage: Pick<Storage, 'removeItem'> | null | undefined): void`.

- [ ] **Step 1: Write the failing core tests** (dirs from `testTmpDir('retired-data-')`):
  - `isRetiredLiveLinkFile` is true for `watch-links.json`, `watch-links.json.corrupt-1767225600000`, `watch-links.json.tmp`, `watch-links.json.4242.7.tmp`, `watch-links.json.4242.7.0b9c8f2e-1d3a-4c5b-9e7f-0123456789ab.tmp`; false for `watch-links.json.bak`, `my-watch-links.json`, `watch-links.jsonx`, `watch-links.json.corrupt-`, `watch-links.json.corrupt-1.bak`, `watch-links.json.x.tmp`.
  - `removes the store, its sidelines and its temps` — create all five true names as files plus every false name → returns 5; the five are gone; every false name is still there (Review Focus 3).
  - `leaves a directory with a matching name alone` — `mkdir watch-links.json.corrupt-1` → still there.
  - `removes a symlink as a link` — `watch-links.json` → symlink to `target.json` outside the dir: link gone, target intact with its content.
  - `does not recurse` — `sub/watch-links.json` survives.
  - `an absent dir answers 0 and warns nothing`; `an unreadable dir answers 0, warns once, never throws` (`it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)` with `chmod 000`; say why in the skip).

- [ ] **Step 2: Write the failing renderer tests:** a fake storage records `removeItem` calls → exactly the three keys, in order; a storage whose `removeItem` throws on the first key → no throw and the other two still attempted (Review Focus 5); `null` and `undefined` → no throw.

- [ ] **Step 3: Run them to verify they fail**

Run: `HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/core/retired-data-cleanup.test.ts src/renderer/lib/retiredStorage.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement both.** The name test is one anchored regex: `/^watch-links\.json(?:\.corrupt-\d+|(?:\.\d+\.\d+(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)?\.tmp)?$/` (the temp shapes are `fs-atomic.ts` `tempNameFor`'s). The core function: `readdir` the dir (ENOENT → 0, silently; any other error → one `warn`, 0); for each matching name `lstat`, skip anything that is neither a file nor a symlink, `unlink`; ENOENT on unlink is ignored, other unlink errors are collected into ONE `warn` naming the count and the first error code (never file contents). A header comment says what the files held (sealed link secrets, password scrypt hashes) and that this runs once per boot in both shells. Each `removeItem` in the renderer helper sits in its own `try/catch`.

- [ ] **Step 5: Run them to verify they pass** (same command as Step 3). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/retired-data-cleanup.ts src/core/retired-data-cleanup.test.ts src/renderer/lib/retiredStorage.ts src/renderer/lib/retiredStorage.test.ts
git commit -m "feat: remove retired live-link data from the data dir and localStorage"
```

### Task 6: Remove the renderer surface

**Files:** Appendix A "Delete whole file → src/renderer (32)" and the renderer edit sites: `canvas/Canvas.tsx` (+ `node-action-ctx-for.source.test.ts:31`), `nodes/TerminalNode.tsx`, `kanban/{CardModal,SessionCard,KanbanView,GlobalKanbanView}.tsx`, `SessionRow.tsx`, `SessionsSidebar.tsx`, the `liveLinkSource` test sites, `KanbanView.accountMenu.test.tsx`, `cardMenu.test.tsx`, `lib/nodeActionItems.tsx` (+ tests), `lib/ui-visibility.ts` (+ test), `lib/nodeterm-events.test.ts`, settings `nav.ts` (+ test) / `SettingsPage.tsx` / `SettingsIcons.tsx`, `ProCompare.tsx` (+ test), `UpgradeDialog.tsx` (+ test), `state/upgradeGate.ts`, `AnnouncementPopup.tsx` (+ test), `ProjectLimitDialog.tsx:15` comment, `components/icons.tsx`, `lazyPanels.tsx`, `nodes/ChatPanel.tsx` comment, `styles.css` (+ `styles.liquid-glass.test.ts:150-157`), `boot.tsx`. NOT `src/renderer/bridge/*` (Task 7).

**Interfaces:**
- Consumes: Task 4's `projectSessionSource` (only `ModalTerminal` still needs it) and `newMessagesLabel`; Task 5's `removeRetiredStorageKeys`.

- [ ] **Step 1: Delete the renderer live-link files** listed in Appendix A, including `UpgradeDialog.tsx` + test and `state/upgradeGate.ts` (live links are `requireProOr`'s only caller — the spec's call).

- [ ] **Step 2: Remove the edit sites.** In Canvas: the live block 3895–4074 (keep `cardModalOpen` at ~3951 for `AnnouncementPopup blocked`), the three palette commands (`live-links-manage`, `live-chat`, `live-links-stop-all`), `<UpgradeDialog />`, the live-chat drawer and every `liveLinkSource` prop. The `liveLinkSource` plumbing goes from every card/row/sidebar component and its tests. `nodeActionItems` loses the share row; `ui-visibility` loses ids `live-link` and `share-link` (stale ids in settings.json stay ignored by `isHidden`). Settings loses the Live links nav entry and section. `ProCompare` loses the live-links row in the Pro section only. `AnnouncementPopup`: `held = blocked || !settingsKnown`; delete its "waits while the upgrade dialog is open" test (~134–139) and the `useUpgradeGate` reset. Delete `IconBroadcast`, `IconClock`, `IconUser` only if `grep -rw` finds no other user. In `styles.css` delete the live blocks and fix the selector list comma left at ~2559.

- [ ] **Step 3: Wire the storage cleanup** in `boot.tsx`: `removeRetiredStorageKeys(typeof localStorage === 'undefined' ? null : localStorage)` before the React root renders, wrapped so a getter that throws (blocked storage) is also caught.

- [ ] **Step 4: Pin what must not move.** In `ProCompare.test.tsx`: `expect(screen.queryByText(/live link/i)).toBeNull()`, and the existing Core-list assertions stay byte-identical (if the test does not already pin every Core row text, add one assertion listing them as rendered on `54ad85512`).

- [ ] **Step 5: Verify**

Run: `npm run typecheck && HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/renderer`
Expected: PASS, and `grep -rnE "watchLink|LiveLink|liveLink|LiveChat|liveChat|upgradeGate|requireProOr|watch-link" src/renderer --include=*.ts --include=*.tsx | grep -v "^src/renderer/bridge/"` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src/renderer
git commit -m "feat(renderer): remove the live links UI, its Pro row and the upgrade gate"
```

### Task 7: Remove the API surface and both shells' wiring

**Files:** Appendix A edit sites for `shared/ipc.ts`, `shared/types.ts`, `shared/host-control.ts` (+ test), `preload/index.ts`, bridge `ws-bridge.ts` / `stubs.ts` / `relay-api.ts` (+ `namespaces.test`, `relay-api.test`), `main/index.ts`, `main/project-limit-wiring.test.ts:47`, `main/station-outcome-wiring.test.ts:76` comment, `server/index.ts`, `server/auth.ts` (+ `auth.test.ts:38`), `core/pty-manager.ts` `watchJoin` in `tmuxStatus` (2423–2425) + `core/pty-persistence-status.test.ts:46-60`. Delete `main/watch-link-wiring.test.ts`, `main/watch-link-control-wiring.test.ts`. Create `src/main/retired-data-cleanup-wiring.test.ts`.

**Interfaces:**
- Consumes: Task 5's `removeRetiredLiveLinkData(dir, warn?)`.
- Produces: `NodeTerminalApi` with no `watchLink` member; `TmuxStatus.persistence` with no `watchJoin`; no `IPC.watchLink*` channel; `HOST_ONLY_CHANNEL_PREFIXES` without `'watchLink:'`.

- [ ] **Step 1: Write the failing wiring test** `src/main/retired-data-cleanup-wiring.test.ts` (source level, house style — a dropped call compiles): `src/main/index.ts` contains `removeRetiredLiveLinkData(corePlatform.userDataDir` and `src/server/index.ts` contains `removeRetiredLiveLinkData(config.dataDir`; neither contains `createWatchLinkService`, `WatchLinkStore` or `watch-links.json'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/main/retired-data-cleanup-wiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Remove the surface in ONE commit's worth of edits:** IPC channels, the `watchLink` API and `watchJoin` from `types.ts`, the preload namespace, the three bridge members and their test blocks, the `'watchLink:'` prefix with its comment, and the whole `it('every owner live-link channel is host-only…')` block in `host-control.test.ts` with its l.4 import (if another test enumerates the prefix list, drop `'watchLink:'` there). `tmuxStatus` stops reporting `watchJoin`; delete that test case.

- [ ] **Step 4: Remove the shells' wiring.** `main/index.ts`: the service boot (~3687–3747) becomes `void removeRetiredLiveLinkData(corePlatform.userDataDir)`; drop the IPC handlers, the quit/stop calls, `watchHistoryChat` (keep host-chat `page`), the `registerPeerSink(…, { quiet: true, selfPaced: true })` call, and every import tsc then reports unused (Appendix A names `allocateRelayClientId`, `canChat`, `HostChatOps`, `registerPeerSink`/`unregisterPeerSink` — confirm each is unused before removing). `server/index.ts`: the service (~1152–1190) becomes `void removeRetiredLiveLinkData(config.dataDir)`; drop `WATCH_LINKS_STOP_MS`, the shutdown calls, the `unsupported` IPC wiring and the `platform.attach(sink, { quiet: true, selfPaced: true })` call. `server/auth.ts` comments and `auth.test.ts:38`. `project-limit-wiring.test.ts:47` regex loses its live-link alternative.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/shared src/preload src/main src/server src/renderer/bridge src/core/pty-persistence-status.test.ts`
Expected: PASS, and `grep -rnE "watchLink|watchJoin|WatchLink" src/shared src/preload src/main src/server src/renderer --include=*.ts --include=*.tsx | grep -v "^src/shared/watch-link"` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat: remove the live links IPC, preload, bridge and shell wiring; clean retired data at boot"
```

### Task 8: Delete the core live-link engine

**Files:** Appendix A "Delete whole file → src/core (36)" and "src/shared (18)" (`ui-sink-registry.watcher.test.ts` waits for Task 9), and the core edit sites: `core/pty-manager.ts`, `core/pane-input.ts` (drop `WatcherInputRoute`, `WATCHER_INPUT_ROUTES`), `core/remote-ssh/control-master{.ts,.test.ts}`, `core/remote-ssh/native/native-pty-argv.guard.test.ts:24`, `core/workspace-store.ts` (+ test), `core/relay/relay-trust.ts:29-40`, `core/relay/scoped-guest-policy.test.ts:491-515`, `core/pty-session-host-watch.test.ts:157-166`, `core/pty-zellij-fold.test.ts:133-155`, `core/pty-manager.capture-visible.test.ts` (the `readWindowSize` describe ~209–260), the comment-only sites, `shared/session-backend.ts:36` + `docs/session-backends.md:106`, `shared/presence.ts:157-158`. Modify `core/pty-join-only.test.ts`; create `core/pty-spawn-refusal-ssh.test.ts`. Rename `core/session-host-client-live-links.test.ts` → `core/session-host-client-watch-attach.test.ts` and `session-host/live-links-host.test.ts` → `session-host/watch-attach-host.test.ts`.

**Interfaces:**
- Consumes: Tasks 4, 7 (nothing outside core imports the engine any more).

- [ ] **Step 1: Salvage the two blocks first, then delete `pty-watch-join.test.ts`.** Add to `pty-join-only.test.ts`: `it('a hosted Viewer (joinOnly, sizeVote:false) keeps its new-session -A mirror, never attach-session')` — `await tmuxManager('present'); await create(VIEWER, { joinOnly: true, sizeVote: false })`; argv contains `new-session` and `-A`, not `attach-session`. Create `pty-spawn-refusal-ssh.test.ts` with the `exec-path` `ssh` mock from `pty-watch-join.test.ts` (~67–75 and its reset) and the `describe('spawnRefusal with no ssh binary …')` block (~483–500), unchanged.

- [ ] **Step 2: Delete the engine files** (everything left under `src/core/watch-link/`, `src/shared/watch-link/`, `shared/watch-link-types.ts`, `shared/watch-link-password{.ts,.test.ts}`, `remote-ssh/watcher-attach.realsh.test.ts`, `pty-manager.control-input.test.ts`).

- [ ] **Step 3: Strip `pty-manager.ts`.** Delete: the watcher-client and `ControlSupport` imports, `WATCHER_CLIENT` / `isWatcherCreate` and every branch on it, `joinAsWatcher`, `watcherClientSessionId`, `readWindowSize`, `localTmuxSupportsWatcherClient`, `syncWatcherClientSize`, `sessionSize`, `watchSizeFor`, `watcherInputRoute`, `controlInput`, `deliverControlInput`, `nodeControlSupport`, the PtyManager `hasSession` (5916–5923), and imports tsc then reports unused. KEEP: `captureVisible`, `SESSION_HOST_WATCH` / `isSessionHostWatch` / `watchHost`, the `watcherClient` session field, `joinOnly`, `sizeVote`, `sendPaneKeys` with `controlInputPlan` / `remoteControlInputPlan`. The spread at ~5189 becomes `...(watchHost ? { watcherClient: true } : {})`; the reaper condition at ~5158 keeps `!watchHost`. Rewrite comments that cite live links to say what still sets the field (a session-host watch-attach for a joinOnly create).

- [ ] **Step 4: The other edit sites.** `control-master.ts`: `remoteTmuxWatcherArgs`, `remoteWindowSizeArgs` and their tests. `workspace-store.ts`: `knownNodeIdsStrict`, `indexRebuiltThisRun` and their setters/test (keep `knownNodeIds`). `relay-trust.ts`: drop the live-link `autoApprove` site from the list, "six" → "five". `ZELLIJ_BACKEND_GAPS` drops the live-link sentence and `docs/session-backends.md:106` drops the same line (`zellij-backend.test.ts` pins the pair). Renames via `git mv`, with titles/comments saying "watch-attach" instead of "live links".

- [ ] **Step 5: Verify the seams survived**

Run: `npm run typecheck && HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/core src/session-host src/shared`
Expected: PASS, including `pty-manager.capture-visible.test.ts`, `remote-ssh/capture-visible.realsh.test.ts`, `pane-input*`, `capture-route*`, `session-host-client-watch-attach.test.ts`, `session-host/watch-attach-host.test.ts`, `pty-join-only.test.ts`, `pty-spawn-refusal-ssh.test.ts`, the access-policy and scoped-guest-policy suites, `zellij-backend.test.ts`. And `grep -rnE "watch-link|watchLink|joinAsWatcher|isWatcherCreate|knownNodeIdsStrict|WatcherInputRoute" src --include=*.ts --include=*.tsx` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src docs/session-backends.md
git commit -m "feat(core): delete the live links engine; keep watch-attach, joinOnly and the visible capture"
```

### Task 9: Remove the options only live links used

**Files:** `core/ui-sink-registry.ts` (25–41, 184–195, 258–264), `core/platform.ts:46-49`, `core/platform-fake.ts:50,115`, `core/pty-reap.ts:62-71` (+ `pty-reap.test.ts:53-55`), `core/pty-idle-reap.test.ts:183-~214`, `core/pty-manager.ts:1499-1506` and the ~1582 comment, `main/platform-electron.ts:178-202` (+ test 240–280), `server/platform-server.ts:88-115` (+ test 178–196), `main/peer-registry.ts:41-43` (+ test 58, 195–196), `core/relay/hosted-scheduler.ts` (`maxBridged` 25–27, 74–78, 91–92, 193) + `hosted-scheduler.test.ts` (the `maxBridged` describe ~606 to its end and the harness option ~21, ~46–47). Delete `core/ui-sink-registry.watcher.test.ts`.

**Interfaces:**
- Produces: `UiSinkRegistry.register(id: number, sink: UiSink): void`; no `SinkOptions`, `quietIds`, `broadcastIds`, `CorePlatform.quietClientIds`, `liveClientIds`, `maxBridged`.

- [ ] **Step 1: Restore the pre-live-links lines.** Commit `8fdc952a6` introduced quiet/self-paced sinks (`git show 8fdc952a6`); the target for every line it touched is its parent's, adjusted only for later unrelated edits: the reaper reads `const live = new Set(platform().clientIds())`; both platforms broadcast over `registry.ids()` and report it as `clientIds()`; `registerPeerSink(id, sink)` and `ServerPlatform.attach(sink, { owner? })` take no sink options; the self-paced branch in pty frame delivery is gone. Delete the tests that exercised quiet/self-paced and `liveClientIds`; keep every test of the ordinary path.

- [ ] **Step 2: Remove `maxBridged`** from the hosted scheduler, its validation and its tests.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run src/core/ui-sink-registry src/core/pty-reap.test.ts src/core/pty-idle-reap.test.ts src/core/relay src/main/platform-electron src/main/peer-registry src/server/platform-server`
Expected: PASS; `pty-reap.test.ts` / `pty-idle-reap.test.ts` still pin that a session whose client is in `clientIds()` is not reaped and one whose client is gone is; `grep -rnE "quietClientIds|quietIds|selfPaced|SinkOptions|liveClientIds|maxBridged|broadcastIds" src` prints nothing.

- [ ] **Step 4: Commit**

```bash
git add -A src
git commit -m "refactor: drop quiet and self-paced sinks and maxBridged — live links were their only users"
```

### Task 10: Docs

**Files:** `CLAUDE.md`, `CONTRIBUTING.md`, `docs/windows-session-host.md`, `docs/project-limit.md`; delete `docs/live-links.md`.

- [ ] **Step 1: CLAUDE.md.** Delete the `## Live links (Pro browser link to one terminal: watch, chat, or type)` section (up to `## Dev-server ports`). In "LOCAL confirms have exactly four call sites", remove the live-link `autoApprove` item, "four" → "three", "lists all six" → "lists all five". In the drain-sweep sentence (~9997) drop "(whose self-paced sinks are never dropped at all)". Fix any other hit from `grep -niE "live.?link|watch-link|watchLink|quietClientIds|self-paced" CLAUDE.md`.

- [ ] **Step 2: The other docs.** `CONTRIBUTING.md` 749–760 (the Live links bullet); `docs/windows-session-host.md` 177–183 (drop the live-link mention, keep what the watch-attach attachment still does for hosted viewers); `docs/project-limit.md:390` drop "live links," from the Pro list; delete `docs/live-links.md`.

- [ ] **Step 3: Verify**

Run: `grep -rniE "live.?link|watch-link|watchLink|LiveChat" CLAUDE.md CONTRIBUTING.md docs --include=*.md | grep -v "^docs/superpowers/"`
Expected: no output (release notes, if any match, are listed and left as they are).

- [ ] **Step 4: Commit**

```bash
git add -A CLAUDE.md CONTRIBUTING.md docs
git commit -m "docs: retire live links"
```

### Task 11: Full verification and the three PRs

- [ ] **Step 1: Desktop, whole branch**

Run: `npm run typecheck && HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run`
Expected: PASS (if an unrelated known flake fails, re-run that file alone and say so in the PR). Then `grep -rniE "watch-?link|watchlink|live.?link|livechat|joinAsWatcher|quietClient" src` → only the retired-data cleanup files and comments that explain a kept seam's history.

- [ ] **Step 2: Push and open the PRs** (`gh pr create`, English, CLAUDE.md's `pr-writing` shape; if a body needs editing later use `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body=…`, not `gh pr edit`):
  - nodeterm-server: the stub table, why status answers 200 `revoked` and join keeps CORS, deploy first, and the post-deploy step for enes: `UPDATE watch_links SET revoked_at = now() WHERE revoked_at IS NULL;`.
  - nodeterm-web: the 410 page, the removed dependencies, deploy after the backend.
  - nodeterm: what moved, what was deleted, the boot cleanup, the three calls made (cleanup, quiet sinks, upgrade gate), and the spec's "Verification owed" list as a Mac checklist (not run on this Linux server).

- [ ] **Step 3: Confirm**

Run: `gh pr view --json url,headRefName,baseRefName -q '.url+" "+.headRefName+" -> "+.baseRefName'` in each worktree.
Expected: three PR URLs, each `chore/retire-live-links -> main`.

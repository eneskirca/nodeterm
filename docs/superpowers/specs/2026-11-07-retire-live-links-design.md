# Retire Live links — design

Date: 2026-11-07. Status: approved in conversation, awaiting review of this document.
Repos: nodeterm (desktop + Server Edition), nodeterm-server (backend), nodeterm-web (viewer page).
Line numbers below are for `origin/main` at nodeterm `54ad85512`; they drift, the symbols do not.

## Intent

Live links (Pro: share one terminal node to a plain browser at `nodeterm.dev/s/<id>`, watch /
chat / Control typing behind a password, Unlimited links, the Live chat drawer, read-back history)
is removed **permanently**. Nobody uses it, and it carries a standing maintenance cost: guard tests,
a ~100-line CLAUDE.md section, a byte-for-byte vendored protocol copy in nodeterm-web, a relay
`watcher` concept every relay change has to account for, and a quiet/self-paced sink mode in the
pty registry and reaper.

"Bringing it back" is git history: the specs, plans and code stay reachable there. Nothing is kept
dormant behind a flag.

## Goals

1. No live-link code, UI, IPC, settings section, Pro-list entry or docs remain in any of the three
   repos, except the parts other features use (moved, see "Shared parts").
2. Already-installed desktop apps (v0.5.x and older that have the feature) degrade cleanly: their
   live links stop, they do not loop, crash or hammer the backend.
3. A `nodeterm.dev/s/<id>` URL someone still has open or bookmarked shows a plain "this feature has
   been retired" page, never a 404 or a broken viewer.
4. Every feature that borrowed a live-links seam keeps working exactly as before (see "Shared
   parts", and the tests named there).

## Non-goals

- No database migration that drops `watch_links` (dropping is irreversible and buys nothing now; a
  later, separate change may drop it after a few releases).
- No announcement / check-feed popup to old versions: nobody used the feature, so a popup to
  everyone on an old version would be noise. Considered and rejected.
- No change to the mobile apps (iOS and Android carry nothing live-link related — verified).
- No change to hosted team relay viewers, the phone relay, or any Pro feature other than this one.

## Anti-goals (would make this a failure even if it "works")

- Removing a seam another feature uses: bulk pause / Esc / chat clear (`controlInputPlan`), the
  phone's resume repaint and relay-attach snapshot (`captureVisible`, `parseVisibleCapture`,
  `remoteCaptureVisibleArgs`), hosted-viewer `joinOnly` + `sizeVote:false`, session-host
  `watch-attach` for joinOnly creates, host-chat `page` (the phone's `chat.page`),
  `isTerminalReport`, `knownNodeIds()` (the mirror), the shared license helpers
  (`getStoredEntitlement`, `relayAllowed`, `useEntitlement`, `initLicense`).
- An old desktop app that, after the backend change, retries a refused request in a tight loop or
  surfaces an error dialog on every boot.
- Touching anything under "Core — free forever" in `ProCompare.tsx`.
- Pushing `main` in any repo. Feature branches + PRs only; enes merges.

## Order of release

1. **Backend first** (nodeterm-server PR, deployed by enes via Dokploy). Old apps then get a clean
   "gone" from every live-link call.
2. **Web** (nodeterm-web PR + deploy). `/s/<id>` becomes the retired page.
3. **Desktop** (nodeterm PR). Ships in the next desktop release.

The three PRs are independent in code (the desktop never calls the backend's live-link routes once
its code is gone; the web page no longer calls the backend), so they can be reviewed in parallel;
only the deploy order matters, and only mildly (an old app talking to a not-yet-stubbed backend is
today's behaviour).

## Backend (nodeterm-server)

Replace `src/routes/watch-links.ts` with a small stub (`registerWatchLinksRetired`, new file
`src/routes/watch-links-retired.ts`) registered where `registerWatchLinks` was in `src/app.ts`.
What the old desktop client does with each answer was read from its code
(`src/core/watch-link/api.ts` on 54ad85512) and drives the choice:

| Route (all POST) | Stub answers | What an old desktop does with it |
|---|---|---|
| `/v1/watch-links/:id/host-token` | `410 {"reason":"revoked"}` | `kind: 'gone'` → the host ends that link cleanly and stops minting for it. This is the one that matters: it is what a running old host calls on a timer. |
| `/v1/watch-links` (create) | `410 {"error":"retired"}` | falls through to its `'network'` error copy. Not ideal wording, but no status maps to a "retired" message in old clients, and 402/403 would tell a paying Pro user "needs Pro", which is worse. |
| `/v1/watch-links/:id/status` | `410 {"error":"retired"}` | any non-200 → `'unknown'`. |
| `/v1/watch-links/:id/revoke`, `/v1/watch-links/revoke-all` | `204` | treated as success, so "Stop" / "Stop all" in an old app succeed instead of erroring. Stopping a link that can no longer run is truthfully done. |
| `/v1/watch-links/:id/join` (viewer) | `410 {"error":"retired"}` | only an old, still-open viewer tab calls this; the new web page never does. |

- The stub keeps per-IP rate limiting at the same value the routes had (30/min) so it is not a
  free amplifier, does no DB access, no license lookup, and no CORS (the only cross-origin caller
  was the viewer page, which no longer calls it; an old open tab failing CORS is acceptable).
- Keep the `/v1/watch-links/*` `logApi` registration in `app.ts` so the stub's traffic is visible
  in logs (that is how we see old clients dying off).
- Remove: `resolveWatchLinkMaxTtl` and its env (`WATCH_LINK_MAX_TTL_SECONDS`,
  `WATCH_LINK_VIEWER_ORIGIN`) from `app.ts`, `.env.example`, README; the admin panel's links
  section and `/admin/watch-links/:id/revoke` route in `src/routes/admin.tsx` (+ the tests in
  `test/admin.test.ts`); `test/watch-links.test.ts`; comments in `src/lib/google-entitlements.ts:16`
  and `src/db/schema.ts:404` that cite live links (the `apple_entitlements` index itself stays —
  check whether anything else queries `originalTransactionId`; if nothing does, the index stays
  anyway: dropping it is a migration, out of scope).
- **Keep** the `watchLinks` table definition in `schema.ts` (so drizzle does not generate a DROP on
  the next migration), with a comment that it is retained only until a later drop migration.
- One data step, run by enes after deploy, written in the PR body (not a migration):
  `UPDATE watch_links SET revoked_at = now() WHERE revoked_at IS NULL;` — so no row reads as live.
- New test file `test/watch-links-retired.test.ts`: each route's status + body as in the table,
  and that no DB call is made.

## Web (nodeterm-web)

- `src/pages/s/[id].astro` becomes a static "Live links have been retired" page: one short
  sentence ("Live links were a nodeterm feature for sharing a terminal in the browser. It has been
  retired, so this link no longer works."), a link to `https://nodeterm.dev`, the site's normal
  layout. Answers **410** for any id (not 404: the URL was real; 410 also tells crawlers to drop
  it). No JS, no API/relay calls.
- Delete `src/lib/watch-link/**`, `src/lib/watch-viewer/**`, `scripts/vendor-watch-link.mjs`,
  `src/lib/viewer-headers.ts` + test, and the two `.gitattributes` lines for `src/lib/watch-link`.
  The retired page uses the site's default headers.
- Check `package.json` for dependencies only the viewer used (e.g. `@xterm/*`, `tweetnacl`) and
  drop them if nothing else imports them.
- Test: the page renders with status 410 for a valid-shaped and an invalid-shaped id.

## Desktop + Server Edition (nodeterm)

### Shared parts — move, do not delete

| Today | Used by (keeps working) | Move to |
|---|---|---|
| `src/core/watch-link/pane-input.ts` (+ `pane-input.test.ts`, `pane-input.realtmux.test.ts`) | `PtyManager.sendPaneKeys` (bulk pause, Esc, chat clear) via `controlInputPlan` / `remoteControlInputPlan` | `src/core/pane-input.ts` (+ tests). Drop only the link-only `WatcherInputRoute`, `WATCHER_INPUT_ROUTES`. |
| `src/core/watch-link/capture-route.ts` (+ `capture-route.test.ts`, `capture-route.realtmux.test.ts`) | phone resume repaint (`host-service.ts:61` imports `VisibleCapture`; `PtyManager.captureVisible`), relay-attach snapshot (`parseVisibleCapture`), `control-master.ts` `remoteCaptureVisibleArgs` | `src/core/capture-route.ts` (+ tests) |
| `projectSessionSource` in `renderer/components/LiveLinkChip.tsx` | `kanban/ModalTerminal.tsx` (cardFileLinkRoute) | a small renderer lib module (e.g. `renderer/lib/projectSessionSource.ts`) |
| `newMessagesLabel` in `renderer/lib/liveChatLook.ts` (+ its test case) | `nodes/ChatPanel.tsx` | e.g. `renderer/lib/chatLabels.ts` |
| `cardModalOpen` state inside Canvas's live block (Canvas.tsx ~3951) | `AnnouncementPopup blocked` | stays in Canvas, outside the deleted block |

Update CLAUDE.md:1367 if the `controlInputPlan` path changes. Moves land in their own commit, before
the deletion commit, with the moved tests green — so a reviewer can see "moved, unchanged".

### Delete

The full file list (≈102 files: 36 core, 18 shared, 2 main, 32 renderer, plus `docs/live-links.md`)
and every edit site are in **Appendix A** (the removal map). Summary of the edit sites:

- **Core:** pty-manager.ts (watcher client, `controlInput`/`deliverControlInput`,
  `nodeControlSupport`, `joinAsWatcher`, `watchJoin`, `isWatcherCreate` branches, link-only size
  helpers, `hasSession`); remote-ssh/control-master.ts (`remoteTmuxWatcherArgs`,
  `remoteWindowSizeArgs`); workspace-store.ts (`knownNodeIdsStrict`, `indexRebuiltThisRun`);
  relay-trust.ts comment (confirm-site count); hosted-scheduler.ts `maxBridged`.
- **Quiet / self-paced sinks — removed** (my call: nothing but live links passes these options, so
  they are dead code): `ui-sink-registry.ts` `SinkOptions`/`quietIds`/selfPaced branch,
  `platform.ts` `quietClientIds`, `platform-fake.ts`, `pty-reap.ts` `liveClientIds`,
  `main/platform-electron.ts`, `server/platform-server.ts`, `main/peer-registry.ts`, and their tests
  (incl. `ui-sink-registry.watcher.test.ts`). The reaper must then read `clientIds()` exactly as it
  did before live links — check `pty-reap.test.ts` / `pty-idle-reap.test.ts` still pin that.
- **Shared:** `ipc.ts` channels, `types.ts` (`watchJoin`, `watchLink` API), `host-control.ts`
  `'watchLink:'` HOST_ONLY prefix (+ test), `session-backend.ts:36` with `docs/session-backends.md:106`.
- **Main:** `index.ts` wiring (imports, service boot, IPC, `watchHistoryChat` — keep host-chat
  `page` itself), now-unused imports; `project-limit-wiring.test.ts` regex.
- **Server Edition:** `src/server/index.ts` `unsupported` wiring, `WATCH_LINKS_STOP_MS`, shutdown
  calls, the `attach({quiet, selfPaced})` call; comments in `server/auth.ts`.
- **Preload + bridge:** preload `watchLink` namespace; `ws-bridge.ts`, `stubs.ts`, `relay-api.ts`
  members — in the SAME commit as `types.ts`, or `satisfies NodeTerminalApi` fails.
- **Renderer:** Canvas live block + palette commands (`live-links-manage`, `live-chat`,
  `live-links-stop-all`); TerminalNode header share button + chip; CardModal / SessionCard /
  KanbanView / GlobalKanbanView / SessionRow / SessionsSidebar `liveLinkSource` plumbing;
  `nodeActionItems.tsx` menu row; `ui-visibility.ts` ids `live-link` and `share-link`; settings nav
  + `LiveLinksSection`; `nodeterm-events.test.ts` (`nodeterm:live-link` dispatch and listener go
  together); styles.css live blocks; icons used only by live links (`IconBroadcast`, `IconClock`,
  `IconUser` — verify no other user first); `lazyPanels.tsx`.
- **Pro / license:** remove the live-links row from `ProCompare.tsx` (Pro section only) and the
  live-links copy in `UpgradeDialog.tsx`. **`requireProOr` / `upgradeGate.show` / `UpgradeDialog`
  — removed** (my call): live links is their only caller, so they become unreachable. If removing
  `UpgradeDialog` would also remove something `AnnouncementPopup` needs (it reads `upgradeGate.open`),
  keep the minimal piece that reads `.open` working (it will simply always be false), or remove that
  read too.
- **Docs:** CLAUDE.md `## Live links …` section (7093–7192) and the confirm-site paragraph
  (10298–10304: drop the live-link `autoApprove` site, "four" → "three", "all six" → "five");
  CONTRIBUTING.md 749–760; `docs/windows-session-host.md` 177–183 and `docs/project-limit.md:390`
  rewordings; delete `docs/live-links.md`. The old specs/plans under `docs/superpowers/` stay
  (history). Release notes stay.

### Data on users' machines

- **Boot-time cleanup (my call):** on desktop boot, once, delete `<userData>/watch-links.json` and
  any `watch-links.json.corrupt-*` sidelines if present. They hold sealed link secrets and password
  scrypt hashes that nothing will read again. Fail silently (ENOENT is the normal case; any other
  error is logged once, never shown). Lives in `src/core` (e.g. `core/retired-data-cleanup.ts`) so
  the Server Edition runs it too against its data dir (where the file almost certainly never
  existed). Tested with a fake platform: file present → gone; absent → no error; unreadable dir →
  no throw.
- **localStorage** keys `nodeterm.liveLinkDefaults`, `nodeterm.liveChatPinned`,
  `nodeterm.liveChatLink`: removed once at renderer boot (`localStorage.removeItem`, wrapped in
  try/catch).
- **settings.json:** no live-link keys. Stale `'live-link'` / `'share-link'` entries in
  `hiddenNodeMenuItems` / `hiddenHeaderButtons` are already ignored by `isHidden`; leave them.

### Tests that must stay green (proof the shared seams survived)

`pty-manager.capture-visible.test.ts`, `capture-visible.realsh.test.ts`, the moved
`capture-route*` and `pane-input*` tests, `session-host-client-live-links.test.ts` and
`src/session-host/live-links-host.test.ts` (they test hosted-viewer `watch-attach`; rename to drop
"live-links" — builder's call), the hosted-Viewer control test and the `spawnRefusal with no ssh
binary` describe salvaged out of `pty-watch-join.test.ts` (~l.225, l.483–500) into a surviving
test file, `access-policy` and `scoped-guest-policy` suites, `host-control.test.ts` (with its
`toHaveLength(14)` count adjusted), the full renderer suite.

Run with `HOME=/var/tmp/nth-x TMPDIR=/var/tmp npx vitest run` plus `npm run typecheck`.

## What is left to the builder

- Exact commit split within each PR (constraint: moves before deletions; types/bridge together).
- Final file names for the moved modules and the renamed session-host tests.
- Whether a deleted icon is in fact still used (grep decides).
- Copy of the web retired page, within the one sentence above.

## Verification owed (cannot be done on this Linux server)

- Mac: the desktop builds, the header has no share button, Settings has no Live links section,
  ProCompare's Pro list has no live-links row, bulk pause / Esc / chat clear still work, a phone
  resume repaint still works, a hosted-team Viewer still joins without resizing anyone.
- An old desktop build with a live link running, pointed at the stubbed backend: the link ends
  cleanly, no error loop, "Stop all" succeeds.
- `nodeterm.dev/s/<any-id>` after the web deploy: the retired page, status 410.

## Appendix A — removal map (nodeterm, origin/main 54ad85512)

Produced by a read-only sweep of the repo; line numbers drift.

### Delete whole file

- **src/core (36):** `src/core/watch-link/` except the three moved modules and their tests
  (`__fixtures__/xterm-vt500.ts`; `api`, `control-input`, `history`, `link-host`, `pty-seam`,
  `store`, `token-bucket`, `watcher-policy` (.ts + .test.ts); `password` (.ts, .test.ts,
  .constant-time.test.ts); `service` (.ts, .test.ts, .workspace.test.ts); `stream-filter` (.ts,
  .test.ts, .xterm.test.ts); `watcher-client` (.ts, .test.ts, .realtty.test.ts);
  `chat-cast.guard.test.ts`, `client.test.ts`, `wire.test.ts`), `remote-ssh/watcher-attach.realsh.test.ts`,
  `pty-manager.control-input.test.ts`, `pty-watch-join.test.ts` (after salvaging the two blocks
  above), `ui-sink-registry.watcher.test.ts`.
- **src/shared (18):** all of `src/shared/watch-link/` (15), `watch-link-types.ts`,
  `watch-link-password.ts`, `watch-link-password.test.ts`.
- **src/main (2):** `watch-link-wiring.test.ts`, `watch-link-control-wiring.test.ts`.
- **src/renderer (32):** components `LiveLinkChip.tsx` (after moving `projectSessionSource`),
  `LiveLinkChip.test.tsx`, `LiveLinkChip.surfaces.test.tsx`, `LiveLinkControls.tsx`,
  `LiveLinkDialog.tsx`, `LiveLinkDialog.test.tsx`, `LiveLinkPassword.tsx`, `LiveLinkPopover.tsx`,
  `LiveChatDrawer.tsx`, `LiveChatDrawer.test.tsx`; kanban `CardModal.liveLink.test.tsx`,
  `CardModal.liveChatEscape.test.tsx`, `GlobalKanbanView.liveLink.test.tsx`; settings
  `sections/LiveLinksSection.tsx` + test; lib `liveLink.ts`(+test), `liveLinkDefaults.ts`(+test),
  `liveLinkEntry.tsx`(+test, +gate.test.ts), `live-link.guard.test.ts`, `liveChatPin.ts`(+test),
  `liveChatLook.ts`(+test, after moving `newMessagesLabel`); `state/watchLinks.ts`(+test),
  `canvas/live-link-wiring.test.ts`, `nodes/TerminalNode.share-link.test.ts`,
  `styles.live-chat.test.ts`.
- **docs:** `docs/live-links.md`.

### Edit sites (line ranges)

- `core/pty-manager.ts`: imports 100–114; `WATCHER_CLIENT` 822–832; `hasSession` 5916–5923;
  5993–~6381 (watcher input/control/join/size helpers); `isWatcherCreate` branches 2770–2776,
  2861–2864, 3069–3102, 4402–4404, 4741–4752, 4942–4945, 5158, 5189; `watchJoin` 2423–2425.
  KEEP `captureVisible` 5947–5992, `SESSION_HOST_WATCH` / `watchHost` / `watcherClient` field (set
  by any joinOnly session-host create), `joinOnly` / `sizeVote`.
- `core/remote-ssh/control-master.ts` 575–~612, import l.26, l.25 path, l.38 comment;
  `control-master.test.ts` 287–314, imports 12–13; `native/native-pty-argv.guard.test.ts:24`.
- `core/workspace-store.ts` 2521–2530, 361–378, setters 489/501/525/534; test ~2500–2550.
- Quiet/self-paced: `ui-sink-registry.ts` 25–41, 184–195, 258–264; `platform.ts:46-49`;
  `platform-fake.ts:50,115`; `pty-reap.ts:62-71`; `pty-manager.ts:1499-1506`;
  `pty-reap.test.ts:53-55`; `pty-idle-reap.test.ts:183-~214`; `main/platform-electron.ts:178-202`
  (+test 240–280); `server/platform-server.ts:88-115` (+test 178–196); `main/peer-registry.ts:41-43`
  (+test 58, 195–196).
- `core/relay/hosted-scheduler.ts` `maxBridged` 25–27, 74–78, 91–92, 193 (+test ~606);
  `relay-trust.ts:29-40`; `scoped-guest-policy.test.ts:491-515`.
- `pty-session-host-watch.test.ts:157-166`; `pty-zellij-fold.test.ts:133-155`; comment-only:
  `pty-require-remote-join.test.ts:169`, `pty-session-host-watch-zellij.test.ts:4`,
  session-host-backend.ts 151–175, session-host-client.ts 211/1466/1928, host.ts, protocol.ts 92/117.
- `shared/ipc.ts` 286–317; `shared/types.ts` 1300–1302, 4994–4998; `shared/host-control.ts` 34–36,
  73–76 (+test import l.4, block 86–114); `shared/session-backend.ts:36`; `shared/presence.ts:157-158`
  comment.
- `main/index.ts` imports 127–137 and now-unused `allocateRelayClientId` (126), `canChat` (312),
  `HostChatOps` (434), `registerPeerSink`/`unregisterPeerSink` (462); 608–611, 665, 2558 comment,
  3687–3747, 4926, 5150, 5658–5661, 5678. `remote/host-service.ts:61` import path.
  `project-limit-wiring.test.ts:47`, `station-outcome-wiring.test.ts:76` comment.
- `server/index.ts` imports 136–146, 154–155, 812–815, 823, 1152–1190, 1169, 1208–1210, 1277–1278;
  `server/auth.ts` 47, 66 (+auth.test.ts:38).
- `preload/index.ts` 31, 86–89, 1071–1087.
- Bridge: `ws-bridge.ts` 96–104, 1094–1136, 1494 (+namespaces.test 9, 244–298); `stubs.ts` 738–756;
  `relay-api.ts` 216–219 (+test 159–176).
- `canvas/Canvas.tsx` imports 154, 198, 299–313, 508–515; 3895–4074 (keep 3951–3952); 11189, 11216,
  11247–11274; 17210–17211, 17224; 18274–18290; 19360–19374, 19502; 20369–20380, 20649–20670;
  12986 comment; `node-action-ctx-for.source.test.ts:31`.
- `nodes/TerminalNode.tsx` 245, 290, 304–305, 1464–1472, 6372–6374, 6665–6686.
- `kanban/CardModal.tsx` 5, 28–30, 71, 160–170, 400, 555, 652–672; `SessionCard.tsx` 5, 7, 58, 78,
  118–127, 274; `KanbanView.tsx` 34, 312, 973; `GlobalKanbanView.tsx` 15, 157, 273; `SessionRow.tsx`
  3, 28, 47, 166; `SessionsSidebar.tsx` 24, 317, 513; `liveLinkSource` in `SessionRow.test`,
  `SessionCard.ports`/`.queued.test`, `session/agent-status-lookup.test.tsx:217`;
  `KanbanView.accountMenu.test.tsx` 118–132; `cardMenu.test.tsx` 22, 46.
- `lib/nodeActionItems.tsx` 87, 144, 211, 463–465, 935, 984 (+test 44, 219–245; offCanvas.test 41);
  `lib/ui-visibility.ts` 31–33, 48–50 (+test 31, 34); `lib/nodeterm-events.test.ts` 63–80.
- Settings `nav.ts` 26, 106 (+nav.test 31–37); `SettingsPage.tsx` 31, 177–178; `SettingsIcons.tsx`
  135–142.
- `ProCompare.tsx:18` (+test 38, 63–65, 79–84, 118); `UpgradeDialog.tsx:25-26` (+test);
  `state/upgradeGate.ts`.
- `components/icons.tsx` `IconBroadcast` 240–248, `IconClock`/`IconUser` 361–375; `lazyPanels.tsx`
  51–52; `nodes/ChatPanel.tsx` 35, 1365.
- `styles.css` 2517, 2547, 2560 (fix the 2559 comma), 3387 comment, block 12631–13293, 17857–17859,
  18155; `styles.liquid-glass.test.ts:150-157`.
- `CONTRIBUTING.md` 749–760; `docs/windows-session-host.md` 177–178, 183; `docs/project-limit.md:390`;
  `docs/session-backends.md:106`; CLAUDE.md 7093–7192, 10298–10304.

# Design: Live links — a read-only, expiring browser link to one terminal (Pro)

**Date:** 2026-09-28 (brainstorm finished 2026-09-30)
**Branch:** `feat/live-share-link` (worktree `/root/nodeterm/wtshare`, off `origin/main` @ `ce621e2d`)
**Status:** DESIGN — approved section by section in chat; this written spec awaits enes's review.
No product code exists yet.
**Repos:** nodeterm (desktop + Server Edition core), nodeterm-server (API), nodeterm-web (viewer page).
**Builds on:** `docs/hosted-team-relay.md` (roles, `access-policy.ts`, `relay-host.ts` hooks,
`hosted-scheduler.ts`), `docs/team-presence.md` (co-attach), `docs/remote-sessions.md` (relay).
**Prerequisite:** `feat/shared-canvas-authority` (local, unpushed at the time of writing) must land
on `main` first; see [Sequencing](#sequencing).

## Naming

In this codebase "share" already means *a project shared with a hosted team* (`team share`,
`sharedProjects`, `sharedProjectId`, `onSharedChange`). To keep the two apart:

- **UI:** "Live link".
- **Code:** `watchLink` (IPC prefix `watchLink:`, modules `watch-link/`), the relay role is
  **`watcher`**, a connected browser is a **viewer session**.

## Problem / goal

Desktop Pro sells almost nothing of its own (`ProCompare.tsx` lists two lines). The agreed direction
is server-backed Pro value: the repo is public under BUSL, so a local `isPremium()` is an honesty
gate, while a feature that runs through `api.nodeterm.dev` and the relay has a real cost to justify
and cannot be patched out.

A **live link** lets a nodeterm user hand anyone a URL. Opening it in a plain browser tab, with no
install, no account and no Team Access seat, shows **one terminal or agent node live, read-only**,
until the link expires or is stopped. Creating a link is Pro; viewing is free and needs nothing,
and every viewer lands on nodeterm.dev, so it is also a growth loop.

It is distinct from Team Access / the hosted team: those are seats, a whole canvas, SAS approval and
a nodeterm install on the other side. A live link is one node, a browser, a bearer capability, and a
time limit.

Success means:

- the owner's terminal is unaffected by viewers: no input, no resize, no pause, no slowdown;
- a leaked link exposes that node's live screen and nothing else, and only until it expires;
- the relay and the API never see terminal content;
- nothing in "Core — free forever" is taken away.

## Decisions (settled with enes, 2026-09-28 … 30)

| # | Question | Decision |
|---|---|---|
| D1 | Role of a link | **Viewer or Commenter**, chosen at creation. Viewer watches; Commenter watches and can chat. No "request control": control means joining a team with an invite code, a SAS and the Editor role. |
| D2 | Where Commenter messages go | **Live, ephemeral chat only.** Shown to the owner and to the link's other viewers, never written to any file. The owner can copy one message to the card's comments by hand. |
| D3 | Scope of a link | **One terminal/agent node.** The protocol leaves room for several nodes later; v1 is always one. |
| D4 | Viewer page host | **`https://nodeterm.dev/s/<linkId>#1.<S>`**, an Astro route in nodeterm-web. |
| D5 | What a viewer sees on join | **The visible screen only, never scrollback.** If the owner scrolls back (tmux copy-mode), viewers see that too, as it happens. No "include history" option. |
| D6 | Limits | Expiry choices 15 min / **1 h (default)** / 8 h / 24 h, **max 24 h**, no extension. **10** concurrent viewers per link, **5** active links per machine, **50** creations per license per 24 h (server). Per-viewer bandwidth ~256 KB/s sustained, then one keyframe per second at most. Commenter: 1 message / 2 s, 500 chars. |
| D7 | Lifetime buyers / Pro lapse | Lifetime ($299, Apple non-consumable surfaced to the desktop as an `apple:` license) is **included with no extra cap**: the limits are structural, not quotas. Creation checks the license is **live** (keygen validate / live Apple row; `free:` and companion tokens refused). A lapse lets open links **run out their term** (≤ 24 h); host re-mints check only the token and the link row. |
| D8 | App restart | Links **survive restarts**. Active links (secret included) are persisted, `safeStorage`-encrypted on the desktop and in a 0600 file on the Server Edition, and resume at launch. |
| D9 | Surfaces | **Desktop** creates links. The **Server Edition** registers the same core service, but it has no license layer yet (`initLicense` is desktop-only), so create answers `unsupported` with honest copy until a server license layer lands (follow-up); nothing is hosted there. **Mobile** opens links in Safari in v1; creating/revoking from the phone is a follow-up for nodeterm-ios. Kanban card, card modal and sessions sidebar carry the action and the indicator (mandatory, CLAUDE.md). |
| D10 | Architecture | **Approach 1** (below): the narrowest new relay role on the existing core relay host. |

## Non-goals (v1)

- Input of any kind from a viewer: keys, paste, mouse, resize, flow control.
- More than one node per link (groups, projects).
- Scrollback/history delivery.
- Persistent comments, or comments written to `board-log.jsonl`.
- Link extension, custom expiry values, per-viewer identity or accounts.
- Teammates (Team Access / hosted) seeing that a node is being broadcast: the LIVE state is
  machine-local.
- Creating/revoking links from the phone, and an in-app phone viewer.
- Canvas-control (agent) verbs for links: an agent must never be able to publish a terminal.
- Relay-side metering and a one-to-many relay room (see [Follow-ups](#follow-ups)).

## Approaches considered

1. **Chosen — a `watcher` role on the core relay host.** Reuse `relay-socket` (handshake unchanged),
   `relay-host` (session + hooks), `hosted-scheduler` (one per link), the deny-by-default
   `access-policy` framework, the pty viewer mode (`joinOnly`, `sizeVote: false`) and the
   UiSinkRegistry drop-and-redraw. New code is mostly glue plus a few narrow flags. Risk: a viewer
   is a core client, so every outbound path must stay closed to it; answered by two independent
   layers (no broadcast enumeration, plus a deny-by-default sink filter) and guard tests.
2. **A bespoke share protocol with a direct pty tap.** Smallest conceivable surface (never a core
   client), but new crypto code, and a second copy of seed/resync/sizing logic that drifts from the
   hosted Viewer path. Rejected.
3. **A broadcast room in the relay broker.** Host uploads once, the relay fans out. Needs a new broker
   primitive, a relay deploy, relay limits that do not exist today, and keyframe-on-join
   coordination. Unnecessary at 10 viewers; kept as the scale path.

## Architecture

```
 Owner (desktop / Server Edition)                 api.nodeterm.dev          Viewer (browser)
 ┌───────────────────────────────────────┐        ┌────────────────┐     nodeterm.dev/s/<id>#1.<S>
 │ renderer: Live link dialog, chip ×4   │        │ watch_links    │      ┌───────────────────┐
 │   │ host-only IPC (watchLink:*)       │  mint  │ create         │ join │ #S → keys         │
 │ core/watch-link/                      │───────▶│ host-token     │◀─────│ POST join{joinKey}│
 │   registry (≤5, persisted)            │        │ status         │      │                   │
 │   per link: hosted-scheduler (≤10)    │        │ join           │      │ relay client      │
 │     └ connectRelayHost(link keys,     │        │ revoke(-all)   │      │ (e2ee_hello as    │
 │        autoApprove = viewer key,      │        └────────────────┘      │  today)           │
 │        watcher hooks)                 │     relay.nodeterm.dev          │ xterm, read-only  │
 │   per viewer: no-broadcast client,    │◀══════ 1:1 E2E bridge ══════════▶ chat (Commenter)  │
 │     host-initiated pty join           │   (broker unchanged)            └───────────────────┘
 │     (joinOnly, sizeVote:false),       │
 │     string-sequence filter,           │
 │     drop-and-redraw, never pause      │
 └───────────────────────────────────────┘
```

### Units

| Unit | Where | One job |
|---|---|---|
| Protocol + keys + browser client | `src/shared/watch-link/` | Link encode/parse, key derivation from `S`, message types, and the browser relay client (tweetnacl + WebCrypto only, no Node APIs). Test vectors in `vectors.json`. nodeterm-web keeps a byte-identical copy. |
| Registry | `src/core/watch-link/registry.ts` | Active links, limits, lifecycle (create / revoke / revoke-all / expire / node gone), persistence, owner state events. |
| Link host | `src/core/watch-link/link-host.ts` | One `hosted-scheduler` per link; each listener runs `connectRelayHost`; attaches viewer sessions, sends keyframe + meta, relays chat. |
| Watcher policy | `src/core/watch-link/watcher-policy.ts` | The `RelayHostHooks` for a viewer session: `access` (refuse everything except a Commenter's chat cast) and `wrapSink` (deliver only this session's pty channels and `watch:*` events). |
| Output filter | `src/core/watch-link/stream-filter.ts` | Stateful per-session parser that removes string-type escape sequences from the watcher's pty stream. |
| Backend client | `src/core/watch-link/api.ts` | create / host-token / status / revoke / revoke-all calls. |
| Existing-code changes | `ui-sink-registry.ts`, both platforms, `pty-manager.ts`, `hosted-scheduler.ts`, `host-control.ts` | Registry client options `quiet` and `selfPaced`, `quietClientIds()` for the reaper, `captureVisible(sessionId)`, scheduler `maxBridged`, `watchLink:` host-only prefix. |
| Shell wiring | `src/main` and `src/server` | Register the same core service; desktop persists secrets with `safeStorage`, Server Edition with a 0600 file in its data dir. |
| API | nodeterm-server | `watch_links` table and six routes. |
| Viewer page | nodeterm-web | `/s/[id]` route and the vendored client. |
| Renderer | `src/renderer` | `watchLinks` transient store, `LiveLinkChip` (one component, four surfaces), create dialog, popover, Settings section, palette commands, `requireProOr`, ProCompare line. |

## Link, keys and handshake

### Link format

```
https://nodeterm.dev/s/<linkId>#1.<S>
```

- `linkId`: 16 random bytes chosen by the **server**, base64url (22 chars). It names a link and
  unlocks nothing.
- `S`: 32 random bytes chosen by the **host**, base64url (43 chars). In the fragment, so it never
  reaches an HTTP request, a server log or a referrer.
- `1.` versions the fragment format.

### Derivations from `S`

Hash-based and synchronous, using tweetnacl's SHA-512 only, so Node and the browser compute
identical bytes:

| Value | Derivation | Known to |
|---|---|---|
| Host key pair | `nacl.box.keyPair.fromSecretKey(SHA512("nodeterm-watch-link-v1/host" ‖ S)[0..32])` | host, anyone holding the link |
| Viewer key pair | same with `…/viewer` | host, anyone holding the link |
| `joinKey` | `SHA512("nodeterm-watch-link-v1/join" ‖ S)[0..32]` | + the API, which stores only `sha256(joinKey)` and sees `joinKey` only in a join request |

The API never sees `S` or either key pair; the domain-separated derivations make `joinKey` useless
for recovering them.

### Relay room

Pairing id **`wl.<linkId>`**. The broker does no format validation, so **the broker is not changed**.
The prefix makes watch-link traffic recognizable in the relay's join/close log lines, which print the
first 12 characters of the id.

### Handshake — `relay-socket.ts` is not changed

1. The viewer sends `e2ee_hello {publicKeyB64: viewerPub, nonceB64}`, exactly as a client does today.
2. The host derives the base and session keys (unchanged `e2ee.ts`), replies `e2ee_ready`; the
   encrypted `e2ee_auth` / `e2ee_authenticated` exchange runs as today.
3. The `relay-host` trust gate for a link session:
   - `autoApprove(peerKeyB64)` compares the handshake's peer key with the **expected viewer key from
     the host's own registry**, never with anything the peer sent.
   - Any other key reaches `onPeerPending`, which **denies immediately**. A link session never raises
     an approval dialog.
   - The viewer sends its own `trust:confirm` automatically: holding the link is its consent.
   - No SAS is shown and no pin store is passed.

The role (Viewer/Commenter) is **host-side registry state**, never in the link: a holder cannot
upgrade themselves. Different roles need different links.

### Messages inside the tunnel (`rpc.ts` framing)

The viewer protocol's namespace is **`watch:`**, never `watchLink:`: the owner's IPC is `watchLink:*`,
which `relay-host` refuses from every peer as host-only before any policy runs, so a viewer cast in
that namespace could never arrive.

Host → viewer:

- `ev watch:meta {v: 1, role, label, title, expiresAt, cols, rows}`
- pty output as binary `encodePtyData` frames; `ev pty:size:<sid>`
- `ev watch:keyframe {sessionId, screen, altScreen, cursor?}` — the visible screen, whether tmux paints on
  the alternate screen, and the host's cursor (`{x, y}`, 0-based). The cursor is needed because tmux's
  following stream moves the cursor relative to where it believes the tty cursor is, and a capture trims
  trailing blanks, so a keyframe without it offsets every typed character until a full redraw.
- `ev watch:chat {id, name, text, at, from: 'viewer' | 'sharer'}`
- `ev watch:end {reason}`, `reason ∈ revoked | expired | node-gone | session-ended |
  host-stopping | kicked`
- `ev watch:waiting {}` — the node has no running session right now

Viewer → host: `cast watch:chat {name, text}` (Commenter only), `trust:confirm`, keepalive.
Everything else is refused by the watcher policy. **There is no input, resize or flow message in the
protocol.**

## Host side

### Registry

- At most **5** active links per machine. A record is
  `{linkId, nodeId, role, label, createdAt, expiresAt, secret}`.
- **Persistence:** `<userData>/watch-links.json` through `writeFileAtomic`.
  - Through the platform's existing secret seam, `CorePlatform.sealSecret` / `unsealSecret`.
  - Desktop: the seam is Electron `safeStorage`. If sealing throws, links are **not persisted**
    (they work, and end at quit), and the user is told once. There is no plaintext fallback on the
    desktop.
  - Server Edition: the seam is absent by design (headless, no keychain), so the secret is stored
    raw in a 0600 file in its data dir, the same rule as its node secrets and hosted host key.
  - At launch, expired records are pruned and each remaining link's listeners reopen.
- **Clock:** the expiry timer is derived from the server's `expiresAt` and the response's `Date`
  header (`tokenTtlMs`'s rule), never from the local clock alone.
- **Create order:** generate `S` → `POST /v1/watch-links` → persist locally → start listeners. If the
  local write fails, the server row is revoked best-effort and the owner sees an error; no
  half-created link survives.
- **Revoke:** delete and write the record first, then end the sessions with `end{revoked}`, then a
  best-effort server revoke. Local revoke is complete even offline, because the host is the only
  listener.
- **Node gone:** on every workspace-store change and before every join, the registry asks whether
  the node is `present`, `absent` or `unknown`: present = some project holds it
  (`projectIdsForNode`); absent = the store has a complete read of every project
  (`knownNodeIdsStrict()` — unknown, too, for the rest of a run whose index was rebuilt from nothing;
  the agent-status mirror keeps `knownNodeIds()`, which does not read that flag) and the id is not in it; anything else is unknown. Only **absent** ends the link with `node-gone`
  and revokes it server-side — an empty answer during the launch-time workspace load, or for a node
  in an unreadable project, is not evidence the node is gone. Create requires `present`. This covers
  a node removed by the canvas authority on a peer's op, which the local renderer's delete funnel
  never sees.
- **Link state is never canvas content.** No field on `CanvasNodeState`, `ProjectKanban` or any
  `CanvasMutation`: canvas sync would carry it to teammates and the canvas authority would write it
  into the git-shared `project.json`. It lives in the registry and in a transient renderer store.

### Listener pool

- One `hosted-scheduler` instance per link, with a watch-link `mint()` (the host-token route) and a
  new **`maxBridged`** option: at 10 bridged sessions no replacement listener opens, so the broker
  closes extra clients ("no host waiting").
- The scheduler's existing rules apply unchanged: refresh 30 s before expiry, backoff reset only on
  proof the relay works, 429 waits ≥ 60 s, 402/403 stops minting, 200 mints per hour cap.
- While a link holds no idle listener (it is full), the host calls the **status** route every
  **5 min**, so a server-side revoke still reaches it.
- A 410 from host-token or status ends the link locally with the reason it names.

### Attaching a viewer session

1. `PeerAttach.attach(sink)` registers the watcher client **without joining presence** (no cursor or
   facepile on the owner's canvas) as a **quiet**, **self-paced** client (see Backpressure). Quiet means: absent
   from `broadcast()` and from `clientIds()` (so the canvas-sync fan-out and any future `clientIds()`
   consumer skip it by default), reachable only by `sendTo`. The pty reaper is the one consumer that
   must still count it as live — it decides "is anyone watching this session?" from `clientIds()`,
   and a session only a watcher holds would otherwise be released after 10 minutes with no event —
   so it reads a separate `quietClientIds()` as well.
2. The host makes the pty join itself:
   `ptyManager.create(watcherId, {persistKey: nodeId, joinOnly: true, sizeVote: false,
   cols/rows: the session's last applied size, sshRemote/requireRemote: from the host's own node
   records, viewerId: a fresh `v-<8 hex>` per viewer session})`. **No argument comes from the viewer.** (The hosted
   Viewer path strips `sshRemote` because a peer supplied it; here the host builds it.)
3. A keyframe from **`captureVisible(sessionId)`** (new; never history):
   - local tmux: `capture-pane -p -e` (the `captureSnapshot` path, which has no `-S`);
   - SSH: `capture-pane -p -e` over the ControlMaster, **without** `-S` (the existing remote builder
     always adds `-S -200`);
   - **session host (Windows) and the direct Windows pty: none in v1.** `sessionHostCapture(name,
     false)` returns the recent ~200 lines, not the visible screen, and a visible-only capture needs
     an additive, negotiated session-host command (a follow-up). Never history instead;
   - a plain shell with no tmux: none.

   With no keyframe the viewer starts from the live stream and the page says "Waiting for the
   terminal to redraw…" until output arrives.
4. `watch:meta`, then the live stream.

If the join answers `unavailable: 'join-only'`, or the session later sends `pty:exit` /
`pty:recycled`, the viewer gets `watch:waiting` and the host joins again when a session for that
node appears.

### Backpressure — a viewer never slows the owner

- A watcher is registered **self-paced**: the registry never takes a pause ticket for it (closing, for
  links, the residual `docs/hosted-team-relay.md` documents for hosted Viewers) and never drops or
  resyncs its output. The watcher's own sink does both, because only it can keep the stream filter
  (below) in step with the pty: a frame the registry dropped would never reach the parser, and a
  string sequence cut in half would leak its tail as text.
- Drop-and-redraw at **512 KB** buffered, decided by the watcher sink, with the redraw sent as a
  `watch:keyframe` from **`captureVisible`** once the socket drains below 256 KB (the registry's
  default resync provider returns history on the session-host and SSH paths; a watcher never uses it).
- A per-viewer token bucket (**256 KB/s sustained, 1 MB burst**). Past it the stream stops and at most
  one keyframe per second is sent. This bounds relay traffic during a flood (`yes`, a verbose build).
- Every pty byte passes the stream filter even while nothing is forwarded, so the parser's position
  is always the pty's.

### Output filter

The watcher's pty stream passes a per-session, stateful parser that **removes every string-type
sequence**: OSC, DCS, APC, PM and SOS. They carry clipboard contents (OSC 52 from tmux
`set-clipboard on`), titles, hyperlink targets, file transfers and palette changes, none of which is
text on the screen. CSI, other ESC sequences and text pass unchanged. Sequences split across chunks
are handled. A string sequence is swallowed until its terminator, **however long**: xterm itself
has no length limit (it stays in the string until ESC, ST, BEL for OSC, CAN or SUB), so a cap could
only ever show a viewer bytes the owner's screen does not show. An earlier draft resumed text
past 1 MiB; measured on tmux 3.4 with the app's clipboard settings, a 900 KB copy became a 1.2 MB
OSC 52 and 151,428 characters of the clipboard's base64 reached the viewer. The filter keeps no
buffer, so there is nothing for a cap to bound. A viewer that joins a running session starts its
filter inside an unknown string (`midStream`), so a join in the middle of an OSC 52 leaks nothing. The parser is reset only when the viewer moves to a new pty
session, never on a keyframe.

**Keyframes are filtered too.** `capture-pane -e` emits OSC 8 hyperlinks verbatim (measured, tmux 3.4),
so every keyframe's screen passes a FRESH filter before it is sent (fresh because the session's stream
filter is mid-stream state). The viewer also swallows OSC 8 at its own parser and uses an inert link
handler: xterm's default (`linkHandler: null`) still opens an OSC 8 link after a `confirm()`.

### Commenter chat

- Host validation per viewer session: 1 message / 2 s, text ≤ 500 chars, name ≤ 32 chars, control
  characters stripped. A viewer's name is always shown with "(link viewer)".
- Delivered to every session of that link and to the **local owner clients only**, never to relay
  peers or teammates.
- The last 200 messages per link are kept in memory and cleared on revoke or restart.
- The owner replies from the node popover (`from: 'sharer'`, name = the link's label). "Copy to card
  comments" writes one board-log comment **as the owner**, an explicit act; nothing is written
  automatically.

### Owner state and host-only IPC

- The registry emits `watchLink:state {linkId, nodeId, role, label, expiresAt,
  status: live | reconnecting | refused, viewers: [{viewerId, name?, joinedAt}]}` to local owner
  clients only.
- IPC: `watchLink:create | list | revoke | revoke-all | kick | chat-send | chat-history`, plus the
  `watchLink:state` / `watchLink:chat` events. **`watchLink:` joins `HOST_ONLY_CHANNEL_PREFIXES`**
  (`src/shared/host-control.ts`): no relay peer can reach them, hosted owners and editors included
  (an editor passes every access check, and a link consumes the host's Pro and publishes a host
  terminal to the world). A test proves the refusal on the hosted path as well as the Team Access
  path.
- **No canvas-control verb** creates, lists or revokes a link.

## Backend (nodeterm-server)

### Table `watch_links`

| Column | Notes |
|---|---|
| `id` text PK | 16 random bytes, base64url |
| `license_id` text not null | the license that created it |
| `join_key_hash` text not null | `sha256(joinKey)`, hex |
| `created_at`, `expires_at` | `expires_at` clamped server-side |
| `revoked_at` null | |

Indexes on `license_id` and `expires_at`. Rows more than 7 days past expiry are deleted
opportunistically on each create. Migration numbered after the latest on `main` (0013 at the time
of writing).

### Routes

All registered with the licensing routes, so they exist only when the licensing env is set.

| Route | Body | Rules | Answer |
|---|---|---|---|
| `POST /v1/watch-links` | `{entitlement, joinKeyHash, ttlSeconds}` | Token verifies; no `via` (companion) and no `free:` license. **Liveness:** keygen license → validate; `apple:` → a live purchase row. `ttlSeconds ∈ {900, 3600, 28800, 86400}` (max from env). Per license ≤ **15** active and ≤ **50** created per 24 h. Per IP 30/min. | `{linkId, expiresAt}`; 402 `not_entitled`, 400, 429 `{scope}` |
| `POST /v1/watch-links/:id/host-token` | `{entitlement}` | Token verifies, its `licenseId` equals the row's, row live. No keygen call (D7). Per link 120/h, per IP 30/min. | `{pairingToken (role host, pairingId wl.<id>, 120 s), exp}`; 410 `{reason}`, 402, 404, 429 |
| `POST /v1/watch-links/:id/status` | `{entitlement}` | Owner match. | `{state: live \| revoked \| expired}` |
| `POST /v1/watch-links/:id/join` | `{joinKey}` | Timing-safe compare of `sha256(joinKey)` with the row. Per IP 30/min, per link 300/h. **CORS for `https://nodeterm.dev` on this route only.** | `{pairingToken (role client, wl.<id>, 120 s), relayEndpoint, exp}`; **the same 404** for an unknown id and a wrong key; 410 `{revoked \| expired}` only when the key matches; 429 |
| `POST /v1/watch-links/:id/revoke` | `{entitlement}` | Owner match; idempotent. | 204 |
| `POST /v1/watch-links/revoke-all` | `{entitlement}` | All the license's live rows. | 204 |

- **The relay is not changed.** It checks a token only at join, so it cannot cut a bridge; the host
  does. A server-side revoke reaches the host through its next mint (≤ ~90 s) or status poll
  (≤ 5 min).
- **Admin:** `/admin` gains link lookup and revoke by `linkId`. The viewer page's "Report" is a
  `mailto:support@nodeterm.dev` carrying the `linkId`. Content is end-to-end encrypted; revoke is
  the moderation tool.
- **Logging:** the existing `[api] … ip= status=` lines. `joinKey`, request bodies and tokens are
  never logged.

## Viewer page (nodeterm-web)

### One source for the client

The browser client lives in the desktop repo (`src/shared/watch-link/`) and is exercised there
end-to-end against the real core host (see [Testing](#testing)). nodeterm-web vendors that module and
`vectors.json` **byte-identically** (the iOS `KanbanDefaults` pattern) and runs the same vectors in
its own test (vitest added as a dev dependency). A protocol change lands in the desktop repo first,
with new vectors, and is then copied.

### Route `src/pages/s/[id].astro`

- Validates the id's shape and returns the page shell. The server fetches nothing.
- Headers on this route only:
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'
    'unsafe-inline'; connect-src https://api.nodeterm.dev wss://relay.nodeterm.dev;
    img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none';
    form-action 'none'` (xterm injects `<style>` elements; scripts stay `'self'`)
  - `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`,
    `X-Content-Type-Options: nosniff`
- No remote fonts, analytics or third-party scripts. The page does not import site CSS that loads
  remote fonts.
- New dependencies: `@xterm/xterm` (the desktop's 5.5 line), `@xterm/addon-unicode11`, `tweetnacl`.

### Flow

Parse `id` and `1.<S>`; derive keys; `POST …/join`; open `wss://relay…?token=`; handshake;
`trust:confirm`; `meta`; paint the keyframe; stream. The fragment is never sent anywhere and is not
removed from the address bar (the link must stay copyable).

### xterm

- `disableStdin: true`; `onData` is not wired to anything.
- No web-links addon; OSC 8 never arrives (host filter). **No clickable links.**
- A CSI handler swallows a DECSET that only enables mouse tracking (9/1000/1002/1003, plus the
  1005/1006/1015 encodings), so a viewer can always select text. A DECSET that MIXES a mouse mode with
  another (`?1049;1000h`) is applied as written and tracking is switched straight back off
  (`?1000l` queued): swallowing it whole lost the alternate screen (measured against xterm 5.5). A
  DECRST is never swallowed: it can only turn tracking off.
- Fixed `cols`/`rows` from `meta`, no FitAddon; font size computed to fit the width, floor 7 px,
  horizontal scroll below that; pinch zoom allowed on mobile.
- Scrollback 1000 lines: what this viewer itself watched on a plain shell, never host history.

### Fixed chrome (outside the terminal area; terminal output cannot draw over it)

- Top bar: "● LIVE · Read-only terminal · shared with nodeterm", the node title, "by <label>",
  "ends in 42 min". Owner-supplied strings are set with `textContent` and marked "(set by the
  sharer)".
- Footer: "Get nodeterm" (growth loop) and "Report".
- Commenter links: a chat side panel (a bottom sheet on mobile). A name is required to chat,
  remembered in `localStorage` (try/catch). Messages carry "(link viewer)" / "(sharer)". Rate-limit
  feedback is visible.

### States

| State | Copy |
|---|---|
| Connecting | "Connecting…" |
| No running session | "The terminal isn't running right now — this page will pick it up when it starts." |
| Live | the terminal |
| Relay closed / cannot connect | "Can't reach the sharer right now — their nodeterm may be offline, or this link is at its 10-viewer limit. Retrying…" (1, 2, 4, 8, 15 s, then every 30 s). Both causes are named because the page cannot tell them apart. |
| 404 | "This link isn't valid." Final. |
| 410 / `end{revoked}` | "The sharer stopped this live link." Final. |
| 410 / `end{expired}` | "This live link has expired." Final. |
| `end{node-gone}` / `end{session-ended}` | "The shared terminal was closed." Final. |
| `end{kicked}` | "The sharer ended your connection." Final for this tab. |
| 429 | Waits for `Retry-After`. |
| Unsupported `meta.v` | "Reload to update this viewer." (`no-store` makes a reload fetch the current page.) |

## UX (renderer)

### Entry points

All go through `requireProOr('Sharing a live link', …)` (the UpgradeDialog appends "is a Pro feature"), after the availability
check below (a Server Edition tab or a relay tab never sees an Upgrade dialog). That is the UX; the
server is the gate.

- **Node context menu** (terminal and agent nodes): "Share live link…". The sessions sidebar row
  shares the `selectionItems` builder; the kanban card menu gets the same row from the same builder.
  Hideable from Settings → Appearance as `live-link` (`HIDEABLE_MENU_ITEMS`).
- **Card modal header:** a "Share live link" action on terminal cards.
- **Command palette:** "Manage live links" (opens the Settings section) and "Stop all live links
  (every machine on this license)". Stop all revokes every link of the license, other machines
  included, so both entry points (palette and Settings) confirm first. It is offered wherever the owner
  could have a link to stop — a link listed on this machine, OR a Pro license (links shared from another
  machine are invisible here, and Stop all is the only control that reaches them) — never in the Server
  Edition. The confirm names the timing ("Viewers on this machine are disconnected at once; links on
  other machines stop within a few minutes"), and what the server call reached is always reported:
  stopped, could not be asked (no entitlement here), or did not reach nodeterm.
- **Disabled with a reason, never hidden:**
  - relay-tab node: "Live links are created on the machine that runs this terminal."
  - Server Edition tab: the R43 sentence ("Live links need a Pro license on this server — not
    available in the Server Edition yet"), no Upgrade button.
  - unpackaged build (`relayAllowed()` false): "Live links need the installed app." — shown when
    Create is pressed (the renderer has no `relayAllowed` probe; a dev-build-only case).
  - 5 active links: "Stop a live link first — 5 can be active at once."
- Creating a link does not need the node on screen, so the Omni board's cards of other projects can
  create links too. Watching one does — on a machine whose local terminals are not tmux: with no Session
  held, a viewer spawns its own read-only TMUX client, which Windows' session host, a machine with tmux
  off or missing, and the Zellij backend do not have. There a viewer can co-attach only to a terminal
  the app has open, and the owner is told (below: the create dialog's note, the chip's waiting state).
  A session-host watcher join (an additive, negotiated attach-only subscribe with no size vote, beside
  the visible capture) is the follow-up.

### Create dialog

- "Share a live link to <node title>".
- Role: **Can watch** (default) / **Can watch and chat**.
- Expiry: 15 min / **1 hour** / 8 hours / 24 hours.
- "Shown to viewers as": prefilled with the presence name, ≤ 40 chars.
- An always-visible warning: "Anyone with the link sees everything this terminal shows: what's on
  screen now, anything printed later (tokens, env dumps), anything you scroll back to — and, if you
  open tmux's session chooser or switch sessions in it, those other sessions too. They can't type or
  resize it." (The stream is the terminal CLIENT's output, not the node's; see the residuals.)
- On a machine whose local terminals are not tmux, for a node that is not an SSH project's: "On this
  machine, viewers can watch this terminal only while it is open in nodeterm; otherwise they wait until
  you open it." An unread status claims nothing.
- "Create live link" → the URL with **Copy**, "Anyone with this link can watch until 15:42" ("until
  tomorrow 15:42", or the weekday and date, when it ends on another day), and **Stop sharing**.
- Errors: 402 → "Live links need an active Pro plan." + Upgrade; 429 → which limit; network →
  "Couldn't reach nodeterm's service. Nothing was shared."

### `LiveLinkChip` — one component, four surfaces

Node header (beside `PresenceChips`), kanban card, card modal header, sessions sidebar row.

- `● LIVE` (a link, no viewers), `● LIVE · 2` (watchers), amber `LIVE · offline` (reconnecting),
  amber `LIVE · 1 waiting` (a connected viewer whose join was refused — no session it may join; the
  title and the popover say "Viewers are waiting — open this terminal in nodeterm to let them watch"),
  muted `LIVE · refused` (the API refuses mints). A dot marks unread Commenter chat.
- **Not hideable.** It is the owner's signal that a terminal is being broadcast; it is not in
  `HIDEABLE_HEADER_BUTTONS`, pinned by a guard test.
- Click → popover, per link (a node may have several, e.g. one Viewer and one Commenter link):
  role, countdown, Copy link, Stop sharing; the viewer list (name or "Viewer 1", joined time, **Kick**
  with the note "Kick ends this connection; anyone with the link can rejoin. Stop sharing to end it
  for everyone."); for Commenter links the chat thread, a reply box, and "Copy to card comments" per
  message.
- **Join notice:** an info strip, "Someone started watching <title> (2 watching)." It is how an owner
  notices a leaked link. Not an OS notification.

### Settings → "Live links"

Every active link (node, project, role, viewers, remaining time, Copy, Stop) and "Stop all" (also for
a Pro owner with no link listed here — it reaches the other machines' links). Non-Pro users with no link
see a short pitch and Upgrade.

### ProCompare

One Pro line: "Live read-only links to a terminal — viewers need nothing installed". The Core list is
untouched. (`UpgradeDialog`'s outdated quota sentence is being fixed in a parallel PR; this feature
only calls `requireProOr`, which today has zero callers.)

### Surfaces

- **Desktop:** full.
- **Server Edition:** the same renderer; the ws-bridge gets a real `watchLink` API member (not a stub),
  backed by the same core service. Its browser clients are the host's own user, not relay peers, so
  the host-only prefix does not refuse them. Until the Server Edition has a license layer, create
  answers `unsupported` ("Live links need a Pro license on this server — not available in the Server
  Edition yet"), list answers `[]`, and the action shows that sentence instead of an Upgrade button.
- **Relay tab:** the API stub refuses; the menu row is disabled with its reason.
- **Mobile:** no UI in v1; links open in Safari. Follow-up for nodeterm-ios below.

## Error handling

| Situation | Behavior |
|---|---|
| API unreachable at create | Nothing is created locally. "Nothing was shared." |
| Server row created, local persist failed | Best-effort server revoke, visible error. |
| host-token 402/403 | Scheduler stops (existing rule); chip `refused`. No tight loop. |
| host-token or status 410 | Link ends locally with that reason. |
| 429, relay unreachable | Existing backoff rules; chip `offline`; viewers see "can't reach". |
| `safeStorage` unavailable (desktop) | Links not persisted; told once; they still work until quit. |
| Sleep / lid closed | Sockets drop; the scheduler reconnects on wake; viewer pages resume on their own. |
| Node deleted (locally or by the canvas authority) | `node-gone`, link ends, server revoke. |
| Terminal exited or recycled | Viewers wait; the host rejoins when a session appears. |
| Slow viewer | Drop-and-redraw; the pty is **never** paused. |
| Hostile viewer | Any request → `E_ROLE`; chat floods hit the rate limit; wrong key → immediate deny; a sink that throws twice in a row is evicted (existing rule). |
| Pro lapsed | Open links run out their term; new creation gets 402. |
| Two instances on one data dir | Desktop relies on its single-instance lock. A Server Edition that does not own its data dir (the hosted relay's admin-socket rule) does not host links, and logs it. |

## Security properties and residuals

- **Confidentiality:** the relay and the API never see plaintext; `S` never leaves the owner's
  machine and the viewer's browser.
- **Viewer authentication:** only holders of `S` complete the handshake. The API's `joinKey` gate also
  keeps anyone without `S` from spending the host's listener slots.
- **Host authenticity:** a link holder can derive the host key pair, but registering as host in
  `wl.<linkId>` needs a host token minted with the owner's entitlement for that link's license.
- **Replay:** per-session nonces (existing).
- **Read-only:** there is no input channel in the protocol; the watcher policy refuses every request
  (deny-by-default); the pty join is `joinOnly` + `sizeVote: false`; a watcher never takes a pause
  ticket.
- **Isolation from the canvas:** a watcher is a quiet client (absent from `broadcast()` and `clientIds()`), and its sink
  filter passes only its session's pty channels and `watch:*` events. Canvas ops, presence,
  agent status and context updates cannot reach it by either path.
- **Residual — no forward secrecy**, as for the relay today: a recorded session plus a later-leaked
  `S` is plaintext. `S` is deleted from the registry on revoke/expiry; lifetime ≤ 24 h.
- **Residual — all viewers of a link share one viewer key**, so they are cryptographically
  indistinguishable; identity is the session. Kick is per session; only Stop ends access.
- **Residual — the fragment lives in browser history** and can be synced by the browser to the
  viewer's other devices. Answered by the short default expiry and Stop.
- **Residual — the owner-supplied label and node title are shown to viewers.** They are rendered as
  text inside fixed nodeterm chrome, marked as sharer-set; terminal output cannot draw over the
  chrome and has no clickable links.
- **Residual — the stream follows the owner's tmux client, not the node.** A keyframe targets exactly
  `=nt-<id>:`, but a co-attached viewer receives what the owner's client draws: tmux's session chooser
  (`C-b s` / `C-b w`, a live preview of every `nt-*` session on the server) or a session switch shows
  other sessions to every viewer. It is the owner's own action, on the owner's screen too, and the
  create dialog's warning names it.

## Testing

- **Pure units:** key derivation against vectors; link encode/parse; the stream filter (chunk
  boundaries, no length cap (a 2 MiB OSC 52 swallowed whole), a mid-stream join, CSI untouched); the token bucket; the chat sanitizer; registry lifecycle
  on a fake clock; scheduler `maxBridged`.
- **Core integration** (in-process transport, the real `relay-host`, the real watcher policy, and the
  **browser client itself** from `src/shared/watch-link/`):
  - handshake; a wrong viewer key is denied;
  - **one request for every channel in `IPC`**: all refused — `E_FORBIDDEN` for the host-only channels
    (relay-host refuses those before any policy runs), `E_ROLE` for every other — except a Commenter's chat;
  - **one broadcast on every channel**: zero frames reach the watcher;
  - a watcher with a tiny window does not shrink the pty;
  - a watcher whose socket is stalled does not pause the pty;
  - resync returns the visible screen only on the SSH path, and nothing (never history) on the
    session-host path;
  - no OSC 52 in the delivered stream;
  - `node-gone` and expiry end sessions.
- **Guard tests:** `watchLink:*` is host-only and in no role table, refused on both the Team Access
  and the hosted paths; `CanvasNodeState`, `CanvasMutation` and `ProjectKanban` carry no link field;
  `LiveLinkChip` is not in any hideable list; the canvas-control verb table names no link verb.
- **Mutation checks:** break each load-bearing rule on purpose (host-only prefix, the quiet client option,
  self-pacing, `captureVisible`, the stream filter, `autoApprove`'s key comparison) and confirm
  a test turns red.
- **Backend:** every refusal path in the routes table, owner mismatch, TTL clamping, license limits,
  the timing-safe compare, the same 404 for unknown id and wrong key, no 410 leak on a wrong key,
  CORS on the join route only.
- **Web:** the vendored vectors.

### Device checklist (owed; this server cannot run Electron)

1. Create a link on a Mac; open it in Safari on a phone.
2. Typing in the viewer does nothing.
3. Narrowing the viewer's window does not resize the owner's terminal.
4. The owner scrolling back (tmux copy-mode) is visible to the viewer.
5. Stop sharing cuts viewers immediately.
6. Expiry ends the link with the expired message.
7. Quit and relaunch: the link resumes and the viewer page reconnects by itself.
8. Lid closed and reopened: the link recovers.
9. A non-Pro account gets the upgrade dialog; the server refuses a forged request.
10. The 11th concurrent viewer sees the "offline or at its limit" message.
11. `yes` in the shared terminal with a throttled viewer: the owner's terminal stays smooth.
12. Text copied in tmux does not appear in the viewer's decoded stream (debug flag).
13. A Server Edition browser tab offers the action and gets the honest `unsupported` answer (no dead Upgrade button).
14. The chip appears on all four surfaces; Kick and chat work both ways.
15. **A viewer stays connected for more than 2 minutes without a drop** — whether production ends a
    bridged socket at its token's lifetime is unverified (the same open question as hosted checklist
    item 8).

## Sequencing

1. **Backend:** table and routes. Inert without clients, so it can deploy first.
2. **Core:** `src/shared/watch-link` (protocol, keys, browser client, vectors), registry, link host,
   watcher policy, registry flags, `captureVisible`, stream filter, scheduler `maxBridged`, host-only
   prefix.
3. **Shells + IPC + renderer:** desktop and Server Edition wiring, bridge member, dialog, chip,
   popover, Settings, palette, ProCompare.
4. **nodeterm-web:** the route, headers and vendored client.

**Start implementation only after `feat/shared-canvas-authority` is on `main`**, and branch from it:
both change `Canvas.tsx`, the access-policy guard test, `hosted-service.ts` and `workspace-store.ts`,
and the node-gone rule relies on the authority's store being the source of node membership.

## Follow-ups

- **nodeterm-ios (for @eneskirca):** create/list/revoke links from the phone (needs `watchLink.*`
  verbs on the phone dialect of the desktop's host service); optionally open `nodeterm.dev/s/` links
  in an in-app viewer (universal links).
- **Terms of service:** a clause that the sharer is responsible for shared content (legal decision,
  owed by enes).
- **Relay metering:** per-bridge byte caps in the broker; today the relay has no limits at all.
- **Broadcast room** (approach 3) if links need audiences well beyond 10.
- **Teammates seeing LIVE:** whether Team Access / hosted peers should see that a node is broadcast.
- **Commenter → card:** a persistent, moderated comment path, if ephemeral chat proves too little.
- **Host-token proof of possession:** the existing `/v1/relay/host-token` gap (hosted-team threat
  notes) does not apply here, since watch-link host tokens require the owner's entitlement, but the
  general fix stays owed.

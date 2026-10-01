# Live links (a Pro, read-only, expiring browser link to one terminal)

**Status:** built on `feat/live-share-link` (2026-09/10). Everything below was checked against the code
on that branch. The design spec (`docs/superpowers/specs/2026-09-28-live-share-link-design.md`) is the
record of how the design was reached; where it and this file disagree, the code and this file win.

**Builds on:** `docs/hosted-team-relay.md` (the core relay host, `RelayHostHooks`, the hosted
scheduler), `docs/team-presence.md` (co-attach), `docs/remote-sessions.md` (the relay and its trust
gate).

## What it is

A **live link** is a URL, `https://nodeterm.dev/s/<linkId>#1.<S>`, that shows ONE terminal or agent
node live in a plain browser tab: no install, no account, no Team Access seat. The viewer cannot type,
paste, click, resize or pause anything. The link ends when it expires (15 min, 1 h (default), 8 h or
24 h, never extended), when the owner stops it, or when its node is deleted.

- **Creating one is Pro, and the backend is the gate** (`POST /v1/watch-links` checks a live license;
  a `free:` or companion token is refused). The renderer's `requireProOr('Sharing a live link', …)` is
  UX only. The repo is public, so a local `isPremium()` is an honesty gate; a feature that runs through
  `api.nodeterm.dev` and the relay cannot be patched out.
- **Viewing is free.** Every viewer lands on nodeterm.dev.
- **The owner's terminal is unaffected by viewers**: no input, no size vote, no pause ticket, no
  slowdown. A leaked link exposes that node's live screen and nothing else, and only until it expires.
  The relay and the API never see terminal content.
- **Viewer** links watch; **Commenter** links watch and chat (ephemeral, memory-only, never written to
  a file). The role is host-side record state, never in the URL, so a holder cannot upgrade themselves.

Names: in this codebase "share" means a project shared with a hosted team, so the UI says **"Live
link"**, the code says **`watchLink`** (owner IPC, `src/core/watch-link/`), the relay role is the
**watcher**, and a connected browser is a **viewer session**.

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Keys, URL, wire, protocol, browser client | `src/shared/watch-link/` (`keys.ts`, `link.ts`, `wire.ts`, `protocol.ts`, `client.ts`, `vectors.json`) | Isomorphic: tweetnacl + WebCrypto, no Node API. **nodeterm-web vendors it byte-identically** and runs the same vectors. A protocol change lands here first, with new vectors, then is copied. `isomorphism.guard.test.ts` fails on an import from outside the directory (only siblings and `tweetnacl`), a Node API, or a type imported without `type` (the web repo compiles with `verbatimModuleSyntax`). |
| Owner types | `src/shared/watch-link-types.ts` | NOT vendored. TTLs, `MAX_LINKS_PER_MACHINE` (5), `LABEL_MAX` (40) / `TITLE_MAX` (80, UTF-16 units), the renderer-facing `WatchLinkApi`, `stripBidiControls`. |
| Registry / service | `src/core/watch-link/service.ts` | Lifecycle, limits, persistence, node-gone, owner state, the seven owner request channels (`registerWatchLinkIpc`) and the three owner pushes (state, chat, notice). Both shells create it. |
| Link host | `src/core/watch-link/link-host.ts` | One hosted scheduler per link, a `connectRelayHost` session per viewer, joins, keyframes, throttling, chat, kick. |
| Watcher policy | `src/core/watch-link/watcher-policy.ts` | The `RelayHostHooks` of a viewer session: `watcherAccess` (inbound) and `wrapWatcherSink` (outbound). |
| Output filter | `src/core/watch-link/stream-filter.ts` | Strips string-type escape sequences from the viewer's stream. |
| Token bucket | `src/core/watch-link/token-bucket.ts` | Per viewer, 256 KB/s sustained, 1 MB burst. |
| Visible capture | `src/core/watch-link/capture-route.ts` + `PtyManager.captureVisible` | The keyframe. Never history. |
| Watcher's own tmux client | `src/core/watch-link/watcher-client.ts` + `PtyManager.joinAsWatcher` / `syncWatcherClientSize` | Only when no owner `Session` is held for the node. |
| Pty seam | `src/core/watch-link/pty-seam.ts` (`createWatchPty`) | ONE definition of the join rules, both shells wire it. |
| Store | `src/core/watch-link/store.ts` | `<userData>/watch-links.json`, sealed. |
| API client | `src/core/watch-link/api.ts` | create / host-token / status / revoke / revoke-all. |
| Existing-code seams | `ui-sink-registry.ts` (`quiet`, `selfPaced`), `pty-reap.ts` (`liveClientIds`), `hosted-scheduler.ts` (`maxBridged`), `host-control.ts` (`watchLink:`), `workspace-store.ts` (`knownNodeIdsStrict`, `indexRebuiltThisRun`) | The registry and scheduler options are inert for every caller that passes none; a `selfPaced` sink owes the registry a bound on its own backlog, and `maxBridged` must be an integer ≥ 1. Only `knownNodeIdsStrict()` (live links) answers unknown after a rebuilt index: the agent-status mirror keeps calling `knownNodeIds()`, unchanged from before live links (R64/M2; R54 had paused the mirror's pruning for the whole process). |
| Shell wiring | `src/main/index.ts`, `src/server/index.ts` (search "Live links") | Pinned at source level by `src/main/watch-link-wiring.test.ts`. |
| Renderer | `state/watchLinks.ts`, `lib/liveLink.ts`, `lib/liveLinkEntry.tsx`, `components/LiveLinkChip.tsx`, `LiveLinkPopover.tsx`, `LiveLinkDialog.tsx`, `settings/sections/LiveLinksSection.tsx` | One chip on four surfaces; availability before the Pro gate. |
| API | nodeterm-server `watch_links` table + six routes | Merged (server#8). |
| Viewer page | nodeterm-web `src/pages/s/[id].astro` + the vendored client | web#2. |

End-to-end coverage lives in `src/core/watch-link/link-host.test.ts` (the REAL relay host, the REAL
hosted scheduler and the REAL browser client `connectWatchClient` over an in-process transport) and
`src/core/watch-link/client.test.ts` (the browser client against the real host socket).

## The link and its keys

`linkId` is 16 random bytes chosen by the **server** (base64url, 22 chars): it names a link and
unlocks nothing. `S` is 32 random bytes chosen by the **host** (base64url, 43 chars), carried in the
**fragment**, so it never reaches an HTTP request, a server log or a referrer. `1.` versions the
fragment format. The fragment is not removed from the address bar (the link must stay copyable).

Everything is derived from `S` (`keys.ts`), hash-based and synchronous so Node and the browser compute
identical bytes:

| Value | Derivation | Known to |
|---|---|---|
| Host key pair | `nacl.box.keyPair.fromSecretKey(SHA512("nodeterm-watch-link-v1/host" ‖ S)[0..32])` | host, any link holder |
| Viewer key pair | the same with `…/viewer` | host, any link holder |
| `joinKey` | `SHA512("nodeterm-watch-link-v1/join" ‖ S)[0..32]` | + the API, which stores only `sha256(joinKey)` (hex) and sees `joinKey` only in a join request |

The three are domain-separated, so the API learning `joinKey` reveals nothing about the key pairs.
Test vectors: `src/shared/watch-link/vectors.json`.

**The relay handshake is unchanged, and so is the broker.** The viewer is an ordinary relay client
whose key pair happens to be derived: it sends `e2ee_hello` with the viewer public key, the host
answers from `e2ee.ts` as for any peer, and the encrypted auth exchange runs as today. Nothing in
`relay-socket.ts` or the broker changed. The pairing id is `wl.<linkId>` (the broker validates no
format; the prefix makes watch-link traffic recognisable in its 12-char log lines). What changed is
the trust gate's input:

- `autoApprove(peerKeyB64)` compares the handshake's key with the viewer key **derived from the host's
  own link record**, never with anything the peer sent. Any other key reaches `onPeerPending`, which
  **denies at once**: a link session never raises an approval dialog, shows no SAS and has no pin
  store. This is one of the six LOCAL confirm sites `src/core/relay/relay-trust.ts` enumerates.
- The viewer sends its own `trust:confirm` automatically: holding the link is its consent.
- Host authenticity: a link holder can derive the host key pair, but registering as host in
  `wl.<linkId>` needs a host token minted with the owner's entitlement for that link's license.

The viewer protocol's namespace is **`watch:`**, never `watchLink:`. The owner's IPC is `watchLink:*`,
which `relay-host` refuses from every peer as host-only BEFORE any policy runs, so a viewer cast in that
namespace could never arrive.

Host → viewer: `ev watch:meta {v, role, label, title, expiresAt, cols, rows}` (after EVERY join, not
only the first: the page leaves "waiting" on a meta), pty output as binary `encodePtyData` frames,
`ev pty:size:<sid>`, `ev watch:keyframe {sessionId, screen, altScreen, cursor?}`, `ev watch:chat`,
`ev watch:waiting {}`, `ev watch:end {reason}`. Viewer → host: `cast watch:chat {name, text}`
(Commenter only; `sanitizeChatText` / `sanitizeChatName` bound the raw value by code point before
cleaning, drop C0/C1 controls and the bidi controls, and cap at 500 / 32 UTF-16 units without splitting
a surrogate pair — the same functions the viewer page runs), `trust:confirm`, keepalives. **There is no input, resize or flow message in the
protocol.** `session-ended` is a defined end reason the host never sends in v1: a session that exits
answers `watch:waiting`, and the host rejoins when one appears.

## The watcher role

A viewer is a core client, so the risk of this design is that some existing outbound path reaches it.
Two independent layers close that, plus deny-by-default in both directions.

**Inbound** (`watcherAccess`): every request and every cast is refused, except a Commenter link's
`watch:chat` **cast** (never a request). Host-only channels are refused `E_FORBIDDEN` by relay-host
before the hook runs; everything else answers `E_ROLE`. The link host's own `PeerAttach` is a second
layer that FAILS CLOSED: a request or a non-chat cast that reaches it means the access hook let
something through, so the session is closed. No `interceptReq` is ever supplied (it would bypass
`access`). A `watch:chat` cast is accepted only from the link host's own viewer sessions:
`chat-cast.guard.test.ts` fails on any source outside a four-file allowlist that names it, so no
platform handler can let a hosted Editor or a Server Edition tab inject viewer chat.

**Outbound** (`wrapWatcherSink`, controller ruling R16): `watch:*` events, this viewer's own pty data
frames (filtered and paced) and its own session's `pty:size`, and nothing else.

- `pty:exit` / `pty:closed` / `pty:recycled` are CONSUMED (`onLifecycle` → `watch:waiting`) and never
  forwarded: `pty:closed` carries `{by: ClientId}`, which identifies another client of this core.
- `pty:resync` is refused: its payload is the registry's default capture, which is history on the SSH
  and session-host paths and carries OSC 8 verbatim. A watcher repaints only through `watch:keyframe`.
- Another session's binary frame is rejected on its header alone and never reaches this viewer's
  parser.

**Quiet** (layer two): a watcher is registered `{quiet: true, selfPaced: true}` (desktop
`registerPeerSink`, Server Edition `platform.attach`), with no presence join (no cursor or facepile on
the owner's canvas). Quiet means absent from
`broadcast()` and `clientIds()`, reachable only by `sendTo`. Canvas ops, presence, agent status and
context updates therefore cannot reach it by either path. **The pty reaper is the one consumer that must
still count it**: it decides "is anyone watching this session?" from the client list, and a session
only a watcher holds would be released after 10 minutes with no event. So the reaper reads
`liveClientIds()` = `clientIds()` ∪ `quietClientIds()` (`pty-reap.ts`).

**Why not `decideAccess`.** `access-policy.ts` evaluates any non-editor role against the whole VIEW
table (files, git, presence, board log, each with an argument check). A live link may reach none of it,
so it has its own two-line policy rather than a row in a table built for teammates.

**Why no argument comes from the viewer.** The host joins the node's session itself:
`joinAsWatcher(clientId, {persistKey: nodeId, viewerId: v-<8 hex>})` with `joinOnly: true` and
`sizeVote: false` forced after any spread, and for an SSH-project node `requireRemote: true` plus the
`sshRemote` of that project's own ControlMaster from THIS machine's records (a downed master must not
let the local strict probe attach a same-named local orphan). The hosted Viewer path strips a
peer-supplied `sshRemote`; here there is nothing to strip, because nothing is taken.

## Backpressure and the stream filter

**A viewer never slows the owner.** A watcher is **self-paced**: the sink registry hands it every pty
frame and never takes a pause ticket for it, never drops for it and never resyncs it
(`ui-sink-registry.ts` returns before `dropOrDesync`, the only way into a desync). The watcher's own
sink does the drop-and-redraw, because only it can keep the stream filter in step with the pty: a frame
the registry dropped would never reach the parser, and a string sequence cut in half would leak its tail
as text. (This closes, for links, the residual `docs/hosted-team-relay.md` documents for hosted Viewers,
whose backlog still pauses the shared pty.)

The watcher's bounds, since the registry no longer bounds it:

- pty frames stop at **512 KB** buffered (`WATCHER_BUFFER_LIMIT`); the viewer is repainted with a
  keyframe once its socket drains below **256 KB** (`WATCHER_RESUME_BELOW`);
- a per-viewer token bucket, **256 KB/s sustained, 1 MB burst**, counted in encoded bytes; past it the
  stream stops and at most one keyframe a second is sent (bounds relay traffic under `yes` or a verbose
  build). A frame larger than the burst can never pass, and goes over budget like any refusal;
- chat is skipped for a viewer past 512 KB, and a viewer past **8 MiB** is closed (viewer gone, not a
  revoke): a socket that never drains must not grow the host's memory.

**The filter sees every byte.** `stream-filter.ts` removes every string-type sequence (OSC, DCS, APC,
PM, SOS, 7- and 8-bit): clipboard contents (OSC 52 — tmux emits one on every copy with `set-clipboard
on`), titles, hyperlink targets, file transfers, palette changes. CSI, other ESC sequences and text pass
unchanged. It is stateful across chunks and must parse every byte **even while nothing is forwarded**
(throttled, over budget, before the keyframe): a frame that skipped the parser would leave it
mid-sequence and print the tail of an OSC 52 as text. It is reset only when the viewer joins a pty
session, never on a keyframe. Where a string starts and ends follows xterm 5.5's VT500 table (checked by
a differential test against the verbatim table in `__fixtures__/xterm-vt500.ts`); where xterm ends a
string on something this parser does not (CAN, SUB, other C1, non-ASCII inside SOS/PM/APC), the viewer
misses a little text, never sees more than the owner. Output guarantee: no push emits an 8-bit
introducer or ends on ESC, so the viewer's parser can never be put into a string state, even by
drop-and-redraw.

**There is no length cap** (controller ruling R15). A string is swallowed until its terminator, however
long. xterm has none (it stays in a string until ESC, ST, BEL for an OSC, CAN or SUB), so a cap could
only ever show a viewer bytes the owner's screen does not show. An earlier version resumed text past
1 MiB; measured on tmux 3.4 with the app's clipboard settings, a 900 KB copy became one 1.2 MB OSC 52
and 151,428 characters of the clipboard's base64 reached the viewer. The filter keeps no buffer, so
there is nothing for a cap to bound. Tests pin a 2 MiB and a 16 MiB OSC 52 swallowed whole (the latter
past xterm's own 10,000,000-char payload limit, the value most tempting to re-add).

**Every join starts mid-stream** (R12). A viewer co-attaches to a RUNNING session, so its first byte may
fall inside an OSC 52, or right after an ESC the previous read ended on (`]52;c;…` would then read as
text: the whole clipboard). Measured before the fix: 19,148 of 200,000 random joins leaked. So every
join does `reset({midStream: true})`: the filter starts as if an unknown DCS-kind string had just begun
(BEL does NOT end it, since the unknown string may be a DCS or APC where BEL is data) and shows nothing
until the next ESC, ST or 8-bit introducer. Frames that arrive before the session id is known never
reach the filter, so a join can never start in text mode. The filter is never reset to text mode to
"unstick" it: inside a string that prints the string's payload.

**`onSettled`** (R23): the filter reports once when it leaves that unknown start state. The join
keyframe is sent at once; if the filter had not settled by then, one follow-up keyframe is taken when it
does, plus one at `SETTLE_BOUND_MS` (2 s) after the join if it still has not.

## Keyframes

A keyframe is `PtyManager.captureVisible(sessionId)`: **the visible screen, never history**.

- **local tmux:** `capture-pane -p -e -t =nt-<id>: ; display-message -p -t =nt-<id>: '#{cursor_x}
  #{cursor_y}'` in ONE invocation, so screen and cursor describe the same instant (no `-S`, which is
  what makes it visible-only);
- **SSH:** the same over the project's ControlMaster (`remoteCaptureVisibleArgs`), again without the
  `-S -200` the existing remote builder always adds; proven under a real `/bin/sh`;
- **Windows session host and the direct Windows pty: none.** `sessionHostCapture` returns ~200 lines of
  scrollback, not the visible screen; a visible-only read needs an additive, negotiated session-host
  command (a follow-up). Never history instead. **A plain shell with no tmux: none.**
- **A Zellij node (the optional local backend, `settings.sessionBackend`): none.** Its Session is marked
  `tmuxBacked` like a tmux one, but there is no tmux session to capture, so `visibleCaptureRoute` routes
  it to none rather than aiming the tmux socket at it. A viewer still co-attaches to a Zellij painter
  this process holds; with none held it is refused (`join-only`) — a watcher's own client is a
  read-only TMUX client, and a Zellij attach would be a full, typing one. A visible-only Zellij capture
  (`zellijCapture … viewport`) exists but has no cursor read; wiring it is a follow-up.

**The target is exact, `=nt-<id>:`.** Node ids end in a counter, so `nt-x-1` is a prefix of `nt-x-12`,
and tmux resolves a bare target by fnmatch then PREFIX on a miss. Measured on tmux 3.4 with only
`nt-x-12` alive: `capture-pane -t nt-x-1` printed 12's screen, exit 0 — another node's terminal sent to
this link's viewers. `=nt-x-1` alone never resolves a pane target at all; `=name:` is exact AND
resolves, and a miss is a failed command with empty stdout.

**The cursor** (R10) rides the keyframe because tmux's following stream moves the cursor RELATIVE to
where it believes the tty cursor is, and a capture trims trailing blanks: without it every keyframe
offsets typed text until a full redraw. **`altScreen`** comes from the join (a tmux-backed client ⇒
`true`), never from `#{alternate_on}` (R18): a watcher co-attaches to the tmux CLIENT's output, which
tmux paints on the alternate screen whatever the pane's app does.

**Every keyframe passes a FRESH filter** (R9): `capture-pane -e` emits OSC 8 hyperlinks verbatim
(measured, tmux 3.4). Fresh, because the session's stream filter is mid-stream state. The viewer page
also swallows OSC 8 and uses an inert link handler.

**No capture is not an empty screen** (R36). A backend with no visible capture, or a capture that
failed, answers `unavailable`, and then NO keyframe is sent: the viewer paints a keyframe as reset +
clear, so an empty one would erase what the stream had drawn. At the join the viewer still gets meta and
follows the stream; a throttled viewer resumes without a repaint.

Captures are single-flight per session and shared by that link's viewers (R27): a JOIN keyframe may
share a capture already running, any other keyframe needs one started after it asked, and a per-viewer
sequence makes sure an older result is never painted after a newer one. A session found gone after a
join or a capture (`alive()`, R30) takes the lifecycle path, not a keyframe. Split panes: a keyframe
captures the ACTIVE pane only; the stream repairs the rest as tmux redraws.

## The watcher's own tmux client and sizing

When the owner's process holds a `Session` for the node, the watcher co-attaches to it (a subscriber of
the same client) and its size never votes. When it does not — after an app restart, for a closed
project, a released or park-expired node, which is exactly when resumed links reopen — the watcher
spawns its OWN tmux client (`watcher-client.ts`), and the owner's spelling, `new-session -A`, is wrong
three ways (measured, tmux 3.4, `watcher-client.realtty.test.ts`):

- **Size.** Under tmux's `window-size latest` the newest client sets the window size: a watcher at
  40x10 shrank the owner's 120x39 window to 40x9 — a SIGWINCH to the agent running there, because
  somebody opened a link. The watcher attaches with **`-f ignore-size,read-only`**.
- **Environment.** Attaching runs `update-environment`, which STRIPS every listed name the attaching
  client lacks — the account scope (`CLAUDE_CONFIG_DIR`, …) included. **`-E`** skips it.
- **Creation.** `new-session -A` re-creates a session that died between the existence verdict and the
  spawn, bare, on a viewer's behalf. **`attach-session`** never creates.

So: `attach-session -E -f ignore-size,read-only -t =nt-<id>:` (`R19`). Client flags need **tmux ≥ 3.2**:
locally the version is probed and an older or unreadable one refuses the watcher (only a definite
answer is memoised); over SSH the remote tmux rejects the flags itself. Either way the join fails
closed: the viewer sees "waiting", the host backs off. Ubuntu 22.04 (3.2a), Debian 12 (3.3a) and the
macOS bundled tmux are fine.

**`ignore-size` has a condition tmux does not document** (R20, measured): it is honoured only while at
least one client WITHOUT the flag is attached to some session on that server. A watcher that is the
only client sizes the window like any other (spawned at 40x10 alone → window 40x10; an owner joins at
200x50 and leaves → the window snaps back). Therefore:

- the client is spawned at the window's CURRENT size, read by exact target just before the spawn
  (`#{window_width} #{window_height} #{status}`, status lines included), and the spawn is **refused**
  when that read fails — never a guessed size (a join without a size is refused too, never 80×24);
- `syncWatcherClientSize` resizes the watcher CLIENT's own pty to exactly the window's size (never a
  vote, never a viewer's size) before every keyframe capture and every `WATCHER_SIZE_SYNC_MS` (10 s)
  while the link has a joined viewer; serialized per session in PtyManager (one read in flight, one
  shared rerun — R24), so two links on one node share it;
- **residual:** when the watcher becomes the sole client, the window stays at the last-synced size
  until another client sizes it (an owner resize in the last interval before the owner left is not
  caught), and a read racing an owner's resize or departure keeps the size read a moment before.

A second viewer shares the watcher client (refcounted by subscribers); the watcher client is unindexed,
so every persistKey lookup behaves as "no watcher". An owner attaching with `-D` detaches the watcher's
client once locally: viewers see one `watch:waiting` and a rejoin.

**Rejoin** (R26, R35): a session that ends sends `watch:waiting` once per waiting episode and rejoins on
`REJOIN_BACKOFF_MS` = 2, 4, 8, 15 s (the last repeats). The backoff resets only once a joined session
stayed up `REJOIN_STABLE_MS` (30 s) from its join keyframe — never on a join or a lifecycle event: an
old remote tmux that rejects the client flags, or an owner's repeated `-D`, attaches then exits at once,
and resetting on success turned that into a spawn + read + capture every 2 s forever.

The meta's size is the joined session's CURRENT size (`PtyManager.sessionSize`, R25), never a viewer's;
a later change arrives as `pty:size`. The viewer page has fixed cols/rows and no FitAddon.

## Lifecycle

**Create** (`service.create`, in order): `unsupported` shell → parse (`bad-request`) → a build that may
not relay (`relay-unavailable`) → wait for `init()` (bounded) → the node must be **present**
(`node-missing` otherwise; `unknown` answers node-missing too, so the dialog flushes the canvas save
first — R47) → 5 per machine (`limit-machine`, counting links being written and opaque entries) → an
entitlement (`not-entitled`) → `POST /v1/watch-links` (its refusals pass through: `not-entitled`,
`limit-active` (15 per license), `limit-daily` (50 per 24 h), `rate-limited`, `license-check`,
`network` — which covers timeouts, 5xx and a malformed reply, so the copy never says "offline") → the
record is written (bounded at `PERSIST_TIMEOUT_MS`, 10 s; on failure the server row is revoked and the
answer is `persist-failed`: no half-created link survives) → the node is checked AGAIN (absent → revoke,
`node-missing`) → the host starts. Label and title lose C0/C1, DEL and bidi controls and are capped by
UTF-16 units without splitting a pair.

**The clock.** The expiry timer is derived from the server's `expiresAt` and the response's `Date`
header (`tokenTtlMs`'s rule), never from the local clock alone; it is re-checked on every host change,
because a closed lid pauses timers.

**Persist.** `<userData>/watch-links.json` (the Server Edition: its data dir), through
`writeFileAtomic`, saves serialized in call order (two overlapping atomic writes can land out of order
and resurrect a revoked link at the next boot).

- What is sealed is the **base64 TEXT** of the secret (R21): the desktop seam is a string seam
  (`safeStorage.encryptString(b.toString('utf8'))`), so raw random bytes, almost never valid UTF-8, came
  back as different bytes — every link dropped at relaunch (0/200,000 round-tripped). The Server Edition
  has no seam and stores the base64 of the raw bytes in a 0600 file, like its node secrets. There is no
  plaintext fallback on the desktop, and a raw secret found on a desktop is refused.
- **The store never writes over a file it could not read** (R22): only ENOENT means "no links"; any
  other read error, a file over 1 MiB or an unknown version latches the store (every save answers
  `failed`, the file survives for the next boot or a newer build) and the run is memory-only, told on
  every create. JSON that does not parse is set aside as `.corrupt-<ts>`.
- **Opaque entries** (R42): a sealed secret the keychain REFUSES to unseal this run (locked at login,
  reset) is carried back verbatim on every write until its own `expiresAt`, never erased at boot.
- **A keychain that stops sealing mid-run** (R45): the store keeps a digest-keyed cache of every sealed
  form it read or wrote and never re-seals, so only a link that was never sealed (the one just created)
  is left out; the owner is told "This link wasn't saved on `thisMachine()` — it keeps working until
  you quit." (R59: the copy claims nothing about earlier links, because the renderer cannot tell the
  causes apart.)
- `init()` writes only when it actually pruned something, so a boot never rewrites the file.

**Resume** (`init()`, idempotent, never rejects): wait for the boot workspace load (bounded,
`WORKSPACE_READY_TIMEOUT_MS` 10 s), load, drop expired, revoke and drop ABSENT, KEEP unknown, cap at 5
(extras revoked: a hand-edited file of 200 entries must not start 200 schedulers), start hosts only when
`relayAllowed()` (an unpackaged dev build lists them `refused` and hosts nothing: a dev run must not host
the installed app's links).

**Node gone is tri-state** (R40, `workspaceNodeState`). Present = some project holds it; absent = the
store has a complete read of every project (`knownNodeIdsStrict()`) and the id is not in it; anything
else is unknown. **Only absent** ends a link (`node-gone`, server revoke). An empty answer during the launch-time
load, or for a node in a project whose file was not read, is not evidence, and a revoke cannot be
undone. The check runs on every workspace load/save (`onWorkspaceChanged`, which also covers a node
removed by the canvas authority on a peer's op) and before every join (R29). **An index rebuilt from
nothing is never a complete read** (R44, R54, R55): a `workspace.json` that is missing, unreadable,
corrupt, or parses but is no index this build recognises marks the run, and `knownNodeIdsStrict()`
answers unknown until the next launch — otherwise the renderer's empty boot save made every node absent
and every link was revoked a second after launch (probe-confirmed). A genuinely empty v2/v3 index is not
flagged. **The strict accessor is live links' alone** (R64/M2): the agent-status mirror prunes
identities with `knownNodeIds()`, which ignores the flag. A wrongly pruned identity costs one hook event
to restore, while the flag lasts the whole process: a Server Edition started on a fresh data dir runs
for weeks, and under R54's first version the phone kept listing deleted sessions there.

**End** (expiry, owner Stop, node gone, server 410): drop the record, ISSUE the write (never awaited
before the server revoke — a hung disk must not keep a revoked link's viewers connected or its row
alive), `watch:end` to every viewer, stop the scheduler, emit state, notify (expiry, 410, node-gone only;
the owner's own Stop raises nothing), then the best-effort server revoke. Local revoke is complete even
offline, because the host is the only listener. **Stop all** is `POST /v1/watch-links/revoke-all`:
every link of the LICENSE, other machines included, so both entry points (palette, Settings) confirm
first; it also discards opaque entries (else they would host again once the keychain unlocks). It is
**offered wherever the owner could have a link to stop** (`showsStopAll`, R62): a link listed here, OR a
Pro license — links shared from another machine are invisible on this one, and Stop all is the only
control that reaches them (a desktop left sharing at the office, a lost laptop whose links resume at
launch); never in the Server Edition. This machine's links stop at once; then the server call is
**awaited** and its answer reported (`RevokeAllOutcome`: `stopped`; `no-entitlement`, the server was not
asked; `failed`; `unsupported`), a success included. The confirm names the timing: this machine's
viewers at once, other machines' links within a few minutes (their next mint, ≤ ~90 s, or a full link's
status poll, ≤ 5 min).

**The listener pool.** One hosted scheduler per link with `maxBridged: 10`: at 10 bridged viewers no
replacement listener opens, so the broker closes an 11th client ("no host waiting"). The scheduler's
existing rules apply unchanged: refresh 30 s before expiry (120 s host tokens refresh at 90 s, before
the broker's exp + 30 s close of an unbridged listener), backoff reset only on proof the relay works,
429 waits ≥ 60 s, 402/403 stop minting, 200 mints/hour. A bridged peer that has not confirmed within
`CONFIRM_DEADLINE_MS` (30 s) is closed so it cannot hold a slot.

**Server 410.** The relay checks a token only at join and cannot cut a bridge; the host does. A
server-side revoke reaches the host through its next mint (≤ ~90 s) — or, while the link is FULL (no
idle listener, so no mint), through a status poll every 5 min (`FULL_STATUS_POLL_MS`). A 410 from either
ends the link locally with the reason it names and tells the owner.

**Entitlement re-arm** (R41). A host never mints with an empty entitlement (the API would answer 400,
which stops minting for good): it answers itself a local 402. A 402 also means the 7-day entitlement
token expired under a running link — the ordinary case — so `onEntitlementChanged()` (wired from
`initLicense`'s change callback) restarts every host whose status is `refused`; bridged viewers are
untouched. A Pro lapse lets open links run out their term (≤ 24 h): host tokens check the token and the
link row, not keygen.

**Hung-disk and quit rules.** Create waits for its write ≤ 10 s; revoke / revoke-all wait for `init()`
only boundedly, so Stop all still reaches the server on a hung disk (its wait for the server's answer
is the API client's 8 s timeout); `init()`'s own workspace bound fires
before any wait on it, so a slow workspace never reads as a failed write. Desktop: `shutdown()` runs on
the FIRST before-quit pass, before `ptyManager.killAll()`, inside the 1.5 s raced flush — viewers get
`host-stopping` while the sockets are up; the records stay on disk and resume at the next launch. Server
Edition: `shutdownWithin(watchLinks, 2 s)` after `hosted.stop()` in both close paths.

**Owner state.** `watchLink:state` (the FULL list, coalesced per tick), `watchLink:chat` and
`watchLink:notice` go to owner clients only (`sendToOwners`): every view carries the URL, and the URL
carries the secret. Chat history (200 per link) is memory-only, cleared on revoke or restart. Everything
a viewer wrote reaches the owner bidi-stripped and is rendered as text. **Link state is never canvas
content:** no field on `CanvasNodeState`, `ProjectKanban` or any `CanvasMutation` — canvas sync would
carry it to teammates and the canvas authority would write it into the git-shared `project.json`.

## Surfaces

- **Desktop:** full. Entry points: node right-click "Share live link…" (`selectionItems`, shared by the
  sessions-sidebar row; hideable as `live-link`), the kanban card menu (per-project board AND the Omni
  board's lanes, non-active projects included — a viewer of a node with no Session held spawns its own
  read-only tmux client, so on a machine whose local terminals are tmux the node need not be on screen),
  the card modal header action, the palette ("Manage live links", and "Stop all live links (every
  machine on this license)" for a Pro owner or while a link is listed), Settings → Live links (Remote &
  team). Each row is judged by its node's OWN project's session (`liveLinkMenuItemsFor`, D2/M1).
  ProCompare lists "Live read-only
  links to a terminal — viewers need nothing installed"; the Core list is untouched. **Availability is
  checked before the Pro gate** (`liveLinkUnavailable` then `requireProOr`), so a Server Edition or relay
  tab never sees an Upgrade dialog; an unavailable row is disabled with its reason, never hidden.
- **Desktop where local terminals are not tmux** (Windows' session host; tmux switched off or missing;
  the Zellij backend): there is no watcher client of its own, so a viewer can co-attach only to a
  terminal this app has OPEN (mounted, or parked) — after a restart, for a background project or an
  offscreen-released node, viewers wait. This is said, never silent (R63): the create dialog states it
  before the link exists (`watchableOnlyWhileOpen`, from the local core's `tmuxStatus().persistence`; an
  SSH project's node is served by the host's tmux and gets no note), and while a viewer's join is
  refused the chip turns amber (`LIVE · 1 waiting`) and its title and the popover say "Viewers are
  waiting — open this terminal in nodeterm to let them watch." The fix is a session-host watcher join
  (an additive, negotiated attach-only subscribe with no size vote, beside the visible capture): a
  follow-up.
- **The LIVE chip** (`LiveLinkChip`, one component): node header (beside `PresenceChips`), kanban card,
  card modal header, sessions-sidebar row. `● LIVE`, `● LIVE · 2`, amber `LIVE · offline`
  (reconnecting), amber `LIVE · 1 waiting` (a viewer's join was refused — R63), muted `LIVE · refused`;
  an unread dot for Commenter chat. A viewer is reported waiting only once a join is REFUSED: a session
  that merely ends rejoins in seconds and is no news. **Not hideable** — it is the
  owner's signal that a terminal is being broadcast. It shows only for a node viewed through a LOCAL
  session (R57): a relay tab's copy of a git-shared node with the same id must not show this machine's
  chip, and the boards and the sidebar sit outside the node's SessionProvider, so they resolve the
  session from the project id. The popover (per link): role, countdown, Copy, Stop, viewers with Kick,
  Commenter chat with reply and "Copy to card comments" (an explicit act, as the owner; mention tokens
  defused). A join raises an info strip, "Someone started watching <title> (2 watching)." — how an owner
  notices a leaked link.
- **Server Edition:** the same core service is registered, with `entitlement: () => null` and
  `unsupported: true` (R43), because that edition has no license layer yet (`initLicense` is
  desktop-only). Create answers `unsupported` and the renderer shows "Live links need a Pro license on
  this server — not available in the Server Edition yet", no Upgrade button; list answers `[]`; nothing
  is loaded or hosted. The ws-bridge has a REAL `watchLink` member (`buildWatchLinkApi`, spread only into
  the Server Edition's own api, never a relay-shared builder): its browser clients are the host's own
  user, not relay peers, so the host-only prefix does not refuse them. A server license layer is the
  follow-up. A Server Edition that does not own its data dir skips `init()` and logs it.
- **Relay tab:** the API is an inert stub (`stubs.ts`); the row is disabled with "Live links are created
  on the machine that runs this terminal."; the chip is not shown. On the peer, every `watchLink:`
  channel is host-only, refused `E_FORBIDDEN` to every relay peer — Team Access guests and hosted owners
  and editors included (an editor passes every access check, and a link spends the host's Pro and
  publishes a host terminal to the world). `scoped-guest-policy.test.ts` proves the refusal on the real
  relay host with and without hooks.
- **Kanban:** first-class, as above (card chip, card menu row, card modal chip + action — the action is
  disabled with its reason as its title, because the canvas notice strip sits under the modal scrim).
- **Mobile:** N/A in v1. Links open in Safari. **Follow-up for nodeterm-ios (@eneskirca):**
  create/list/revoke from the phone (needs `watchLink.*` verbs on the phone dialect of the desktop's host
  service), and optionally an in-app viewer for `nodeterm.dev/s/` universal links.
- **No canvas-control verb** creates, lists or revokes a link: an agent must never be able to publish a
  terminal (`live-link.guard.test.ts` reads both verb tables).

## Threat notes and residuals

From the spec, verbatim:

- **Residual — no forward secrecy**, as for the relay today: a recorded session plus a later-leaked
  `S` is plaintext. `S` is deleted from the registry on revoke/expiry; lifetime ≤ 24 h.
- **Residual — all viewers of a link share one viewer key**, so they are cryptographically
  indistinguishable; identity is the session. Kick is per session; only Stop ends access.
- **Residual — the fragment lives in browser history** and can be synced by the browser to the
  viewer's other devices. Answered by the short default expiry and Stop.
- **Residual — the owner-supplied label and node title are shown to viewers.** They are rendered as
  text inside fixed nodeterm chrome, marked as sharer-set; terminal output cannot draw over the
  chrome and has no clickable links.

Found while building it:

- **Filter CPU scales with viewers** during a flood (R13): the filter is per viewer, ~2.7 % of a core
  per viewer at a 2.7 MB/s flood (measured), ≤ 10 viewers per link.
- **Text typed with no escape after a co-attach join lags** until the next escape or the 2 s keyframe
  (R23): the mid-stream filter swallows it by design.
- **On a backend with no visible capture** (Windows session host, direct Windows pty, plain shell,
  Zellij) a throttled viewer shows gaps until the app repaints (R36). A Zellij node with no painter held
  in this process (a closed project, after a restart) cannot be watched at all until one is.
- **A single capture failure on a tmux/SSH backend is treated as "no capture"**: no repaint until the
  next keyframe or the app's redraw. Retrying there would stall the stream for good on the backends that
  genuinely have no capture, and the flag cannot tell the two apart.
- **Frames between a capture and its delivery are dropped for that viewer** (inherent to
  capture-then-stream; the next redraw repairs). A keyframe shows the active pane only.
- **Window size when the watcher becomes the sole client**: the window stays at the last-synced size
  until another client sizes it (above).
- **The stream follows the owner's tmux CLIENT, not the node** (R64/M3). A keyframe targets exactly
  `=nt-<id>:`, but the stream is what the owner's client draws: in a shared terminal, tmux's session
  chooser (`C-b s` / `C-b w`, a live preview of every `nt-*` session on the server, other projects'
  agents included) or a session switch (`C-b (` / `)`) reaches every viewer. It is the owner's own
  action, shown on the owner's own screen too, and the create dialog's warning says so. Following
  `#{client_session}` and treating a switch as a lifecycle event is a possible follow-up.
- **Windows, and any machine whose local terminals are not tmux:** a link to a terminal that is not
  open in the app cannot be watched until it is (Surfaces, above). Said, never silent; the session-host
  watcher join is the follow-up.
- **A tmux < 3.2 host cannot be watched** (fail closed, "waiting").
- **After a run whose index was missing, unreadable or corrupt, node-gone waits for the next launch**
  (R44/R54): a link to a node deleted in that run lives until its expiry (≤ 24 h) with nobody able to
  join it (its session is destroyed). The agent-status mirror is not affected (R64/M2).
  Likewise a link to a truly deleted node in an unread project lingers until the next complete read.
- **Opaque entries** (an unsealable secret) live in the file ≤ 24 h.
- **A node cold-opened into a background project** whose disk write has not landed answers
  `node-missing` (no flush for a non-active project, R47).
- **A create racing Stop all** finishes after the stop and its link lives (it was not a link when Stop
  all ran); the server's revoke-all may have raced the row, and then the host's next mint gets 410.
- **Relay bridge lifetime is unverified**: whether production ends a bridged socket at its token's
  lifetime is the same open question as hosted checklist item 8 (device item 15 below).
- **Idle viewers depend on the host's keepalive**: the page drops a leg after 75 s of silence, relying on
  the sealed 25 s keepalive `relay-socket` starts at handshake-ready. Viewer sessions run on
  `connectRelayHost` for exactly that reason.
- Pre-existing, not introduced here: `mintHostToken` (`src/core/relay/host-token.ts`) reads a reset
  mid-body as a bad response and parses Retry-After loosely (the watch-link API client does not);
  `UpgradeDialog` is not on the dialog stack, so opened over a card modal its Escape closes the modal
  underneath; Canvas's existing `session.source === 'relay'` checks in `selectionItems` read the app's
  local session for every tab.

## Device checklist (owed — this server cannot run Electron)

From the spec:

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
13. A Server Edition browser tab offers the action and gets the honest `unsupported` answer (no dead
    Upgrade button).
14. The chip appears on all four surfaces; Kick and chat work both ways.
15. **A viewer stays connected for more than 2 minutes without a drop** — whether production ends a
    bridged socket at its token's lifetime is unverified (the same open question as hosted checklist
    item 8).
16. **Windows:** create a link to a background project's node (or relaunch with a link resumed): the
    create dialog says "only while it is open", a viewer waits, the owner's chip reads `LIVE · 1
    waiting` with the waiting sentence; opening the terminal lets the viewer watch.
17. **`C-b s` / `C-b w` in a shared terminal:** the viewer sees the chooser's previews of other
    sessions, exactly as the owner does (the create dialog's warning names it).
18. **Stop all from a second machine with no link listed:** the palette and Settings offer it to a Pro
    owner; the first machine's links end within a few minutes; with the network cut, the stop says it
    did not reach nodeterm.

Added while building it:

19. An idle terminal for more than 3 minutes, with the viewer page visible AND hidden: 0 rejoins. Again
    with nodeterm hidden on macOS (App Nap).
20. A link on a node whose project is closed (or after a relaunch, no owner Session held): the watcher's
    own client attaches, the owner's window size does not change when the owner then opens the node,
    and the account environment of the session is intact.
21. The owner attaches the same session with `-D` elsewhere: viewers see one "waiting" and come back.
22. A link on an SSH-project node: keyframe and stream over the ControlMaster; a downed master shows
    "waiting", never a local shell.
23. Relaunch with the login keychain locked: links come back once it unlocks (opaque entries), none are
    erased.
24. A relay tab showing a git-shared node with the same id as a locally linked node shows no chip.

Visual checks (renderer, Mac and a Server Edition browser tab):

25. Node right-click: "Share live link…" right after Refresh terminal, the broadcast glyph at 16 px; a
    DISABLED row's tooltip (relay tab, 5 links).
26. Sessions sidebar row menu — active project and a non-active project (Duplicate · Share live link… ·
    End session).
27. Kanban card menu (per-project, after the account rows) and the Omni board lane card menu.
28. Card modal header: the broadcast action between ✦ and the comments button; disabled look + tooltip
    (Chromium shows `title` on disabled buttons — confirm on the packaged build).
29. The create dialog: 460 px `.confirm` shell, radios wrapping, the warning wash, the URL row with
    Copy/Copied!, "until HH:MM" in 12/24 h locales; long node titles; dark + light; Liquid Glass.
30. The dialog opened from the card modal (z 70 over 55), and the UpgradeDialog opened from the card
    modal / board.
31. Palette: "Manage live links" and "Stop all live links (every machine on this license)" with the
    glyph; the Stop-all confirm after the palette closes.
32. Settings → Live links: nav glyph, rows with long titles, Copy/Stop, the Stop-all confirm over the
    Settings overlay, the pitch; the Server Edition sentence in a browser tab.
33. The sticky `not-persistent` strip after a create, visible after closing a card modal.
34. The chip popover over a zoomed canvas node, near the bottom edge (flips above), over the card modal,
    and in the hover-peek sidebar (it must stay open); under Liquid Glass (opaque, `.live-pop`).

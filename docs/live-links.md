# Live links (a Pro browser link to one terminal: watch, chat, or type)

**Status:** built on `feat/live-share-link` (2026-09/10); the Control role, Unlimited links and the
Live chat drawer on `feat/live-link-control` (2026-10). Everything below was checked against the code
on those branches. The design specs (`docs/superpowers/specs/2026-09-28-live-share-link-design.md`
and `docs/superpowers/specs/2026-10-03-live-link-control-design.md`) are the record of how the design
was reached; where they and this file disagree, the code and this file win.

**Builds on:** `docs/hosted-team-relay.md` (the core relay host, `RelayHostHooks`, the hosted
scheduler), `docs/team-presence.md` (co-attach), `docs/remote-sessions.md` (the relay and its trust
gate).

## What it is

A **live link** is a URL, `https://nodeterm.dev/s/<linkId>#1.<S>`, that shows ONE terminal or agent
node live in a plain browser tab: no install, no account, no Team Access seat. On a Viewer or Commenter
link the viewer cannot type, paste, click, resize or pause anything. On a **Control** link, a viewer who
also has the link's password can type into that one terminal (see "The Control role"); nobody can
click, resize or pause anything on any link. The link ends when it expires (15 min, 1 h (default),
8 h or 24 h, never extended; an **Unlimited** link never expires), when the owner stops it, or when
its node is deleted.

- **Creating one is Pro, and the backend is the gate** (`POST /v1/watch-links` checks a live license;
  a `free:` or companion token is refused). The renderer's `requireProOr('Sharing a live link', …)` is
  UX only. The repo is public, so a local `isPremium()` is an honesty gate; a feature that runs through
  `api.nodeterm.dev` and the relay cannot be patched out.
- **Viewing is free.** Every viewer lands on nodeterm.dev.
- **The owner's terminal is unaffected by viewers**: no size vote, no pause ticket, no slowdown, and
  no input except a controller's typing on a Control link. A leaked Viewer or Commenter link exposes
  that node's live screen and nothing else, and only until the link ends. A leaked Control link
  together with its password is a remote shell as the owner, in that terminal (see "Threat notes").
  The relay and the API never see terminal content, and never see the password.
- **Viewer** links watch; **Commenter** links watch and chat (ephemeral, memory-only, never written to
  a file); **Control** links watch and chat, and a viewer who unlocks with the password can also type.
  The role is host-side record state, never in the URL, so a holder cannot upgrade themselves.

Names: in this codebase "share" means a project shared with a hosted team, so the UI says **"Live
link"**, the code says **`watchLink`** (owner IPC, `src/core/watch-link/`), the relay role is the
**watcher**, and a connected browser is a **viewer session**.

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Keys, URL, wire, protocol, browser client | `src/shared/watch-link/` (`keys.ts`, `link.ts`, `wire.ts`, `protocol.ts`, `client.ts`, `vectors.json`) | Isomorphic: tweetnacl + WebCrypto, no Node API. **nodeterm-web vendors it byte-identically** and runs the same vectors. A protocol change lands here first, with new vectors, then is copied. `isomorphism.guard.test.ts` fails on an import from outside the directory (only siblings and `tweetnacl`), a Node API, or a type imported without `type` (the web repo compiles with `verbatimModuleSyntax`). |
| Owner types | `src/shared/watch-link-types.ts` | NOT vendored. TTLs, `MAX_LINKS_PER_MACHINE` (5), `LABEL_MAX` (40) / `TITLE_MAX` (80, UTF-16 units), the renderer-facing `WatchLinkApi`, `stripBidiControls`. |
| Registry / service | `src/core/watch-link/service.ts` | Lifecycle, limits, persistence, node-gone, owner state, the eleven owner request channels (`registerWatchLinkIpc`) and the three owner pushes (state, chat, notice). The owner's control changes and the scrypt gate. Both shells create it. |
| Link host | `src/core/watch-link/link-host.ts` | One hosted scheduler per link, a `connectRelayHost` session per viewer, joins, keyframes, throttling, chat, kick, and on a Control link unlocking, the throttles and lock, the input path and the typing set. |
| Control password | `src/core/watch-link/password.ts`, `src/shared/watch-link-password.ts` | scrypt hash and constant-time check (core); the password rule and Generate (shared, NOT vendored, used by the dialog and core alike). |
| Input splitter, typing set | `src/core/watch-link/control-input.ts` | Pure: keys vs a framed paste, and who typed in the last 4 s. |
| Pane delivery | `src/core/watch-link/pane-input.ts` + `PtyManager.watcherInputRoute` / `controlInput` / `nodeControlSupport` | A controller's bytes to the node's PANE (`send-keys -H`, `paste-buffer -p`), never a tmux client. The measurement table is in the file header and below. |
| Watcher policy | `src/core/watch-link/watcher-policy.ts` | The `RelayHostHooks` of a viewer session: `watcherAccess` (inbound) and `wrapWatcherSink` (outbound). |
| Output filter | `src/core/watch-link/stream-filter.ts` | Strips string-type escape sequences from the viewer's stream. |
| Token bucket | `src/core/watch-link/token-bucket.ts` | Per viewer, 256 KB/s sustained, 1 MB burst, for the stream. A controller's input has its own: 64 KiB/s, 256 KiB burst. |
| Visible capture | `src/core/watch-link/capture-route.ts` + `PtyManager.captureVisible` | The keyframe. Never history. |
| Watcher's own tmux client | `src/core/watch-link/watcher-client.ts` + `PtyManager.joinAsWatcher` / `syncWatcherClientSize` | Only when no owner `Session` is held for the node. |
| Pty seam | `src/core/watch-link/pty-seam.ts` (`createWatchPty`) | ONE definition of the join rules, both shells wire it. |
| Store | `src/core/watch-link/store.ts` | `<userData>/watch-links.json`; the secret is sealed, a Control link's password hash is not. |
| API client | `src/core/watch-link/api.ts` | create / host-token / status / revoke / revoke-all. |
| Existing-code seams | `ui-sink-registry.ts` (`quiet`, `selfPaced`), `pty-reap.ts` (`liveClientIds`), `hosted-scheduler.ts` (`maxBridged`), `host-control.ts` (`watchLink:`), `workspace-store.ts` (`knownNodeIdsStrict`, `indexRebuiltThisRun`) | The registry and scheduler options are inert for every caller that passes none; a `selfPaced` sink owes the registry a bound on its own backlog, and `maxBridged` must be an integer ≥ 1. Only `knownNodeIdsStrict()` (live links) answers unknown after a rebuilt index: the agent-status mirror keeps calling `knownNodeIds()`, unchanged from before live links (R64/M2; R54 had paused the mirror's pruning for the whole process). |
| Shell wiring | `src/main/index.ts`, `src/server/index.ts` (search "Live links") | Pinned at source level by `src/main/watch-link-wiring.test.ts`. |
| Renderer | `state/watchLinks.ts`, `lib/liveLink.ts`, `lib/liveLinkEntry.tsx`, `lib/liveChatPin.ts`, `lib/liveChatLook.ts`, `components/LiveLinkChip.tsx`, `LiveLinkPopover.tsx`, `LiveLinkControls.tsx`, `LiveLinkPassword.tsx`, `LiveLinkDialog.tsx`, `LiveChatDrawer.tsx`, `settings/sections/LiveLinksSection.tsx` | One chip on four surfaces; availability before the Pro gate; one set of owner controls shared by the popover and the drawer. |
| API | nodeterm-server `watch_links` table + six routes | Merged (server#8). Unlimited links (nullable `expires_at`, the daily license check): `feat/watch-links-unlimited`. |
| Viewer page | nodeterm-web `src/pages/s/[id].astro` + the vendored client | web#2. Take control, typing and the typing line: `feat/live-link-control`. |

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

Host → viewer: `ev watch:meta {v, role, label, title, expiresAt, cols, rows, control?}` (after EVERY
join, not only the first: the page leaves "waiting" on a meta; `expiresAt` is `null` for an Unlimited
link; `control`, this viewer's control state, only on a Control link), pty output as binary
`encodePtyData` frames, `ev pty:size:<sid>`, `ev watch:keyframe {sessionId, screen, altScreen,
cursor?}`, `ev watch:chat`, `ev watch:waiting {}`, `ev watch:end {reason}`, and on a Control link
`ev watch:control {state, reason?}` (to ONE viewer: the answer to its unlock, or a change under it)
and `ev watch:typing {names}` (to every joined viewer). Viewer → host: `cast watch:chat {name, text}`
(Commenter and Control; `sanitizeChatText` / `sanitizeChatName` bound the raw value by code point
before cleaning, drop C0/C1 controls and the bidi controls, and cap at 500 / 32 UTF-16 units without
splitting a surrogate pair — the same functions the viewer page runs), and on a Control link only
`cast watch:unlock {name, password}`, `cast watch:input {data}` and `cast watch:release`, plus
`trust:confirm` and keepalives. **There is no resize, mouse or flow message in the protocol, and
input is accepted only from a viewer that unlocked a Control link** (the paste-framing contract is
written beside `WATCH_INPUT_CAST` in `protocol.ts`). Every addition is additive, so
`WATCH_PROTOCOL_VERSION` stays 1: an older cached viewer page on a Control link just cannot take
control. End reasons gained `attempts` (too many wrong passwords on one connection). `session-ended`
is a defined end reason the host never sends: a session that exits answers `watch:waiting`, and the
host rejoins when one appears.

## The watcher role

A viewer is a core client, so the risk of this design is that some existing outbound path reaches it.
Two independent layers close that, plus deny-by-default in both directions.

**Inbound** (`watcherAccess`): every request and every cast is refused, except these **casts** (never
requests): `watch:chat` on a Commenter or Control link, and `watch:unlock`, `watch:input` and
`watch:release` on a Control link. The policy knows only the role. Whether THIS viewer may type is
the link host's state for this connection (`controlling`, set by a right password), and the link host
treats input from a viewer that is not controlling as a breach (except within 5 s of losing control,
see "The Control role"). Host-only channels are refused `E_FORBIDDEN` by relay-host before the hook
runs; everything else answers `E_ROLE`. The link host's own `PeerAttach` is a second layer that FAILS
CLOSED: a request, or a cast the link's role does not admit, that reaches it means the access hook let
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

**Why no argument comes from the viewer.** The host joins the node's session itself, and a
controller's input goes to the session the HOST joined, through ids the host chose:
`joinAsWatcher(clientId, {persistKey: nodeId, viewerId: v-<8 hex>})` with `joinOnly: true` and
`sizeVote: false` forced after any spread, and for a node whose session lives in a HOST's tmux
`requireRemote: true` plus the `sshRemote` of the master THIS machine holds for it, from its own
records (a downed master must not let the local strict probe attach a same-named local orphan). Such a
node is every node of an SSH project (that project's own ControlMaster) AND a remote-tmux node in a
LOCAL project (`ssh` + `sshRemoteTmux` on the node, any persisted copy; its master is the one the canvas
spawns it over, `sshConnectionIdForProject` — the project's host attachment). One rule for both,
`watchRemoteFor` (`core/watch-link/pty-seam.ts`); with the master down the join is `requireRemote` with
no master, so an unheld such node never joins the LOCAL socket. Both shells build its records the same
way (`watchRemoteRecords`; the Server Edition has no masters, so such a node is joinable there only while
that core holds its session), and both shells' `controlSupport` asks the same rule (a node in a host's
tmux is not decided by this machine's Zellij choice). The hosted Viewer
path strips a peer-supplied `sshRemote`; here there is nothing to strip, because nothing is taken.

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
- **Windows session host:** the host's negotiated `captureVisible` (`sessionHostCaptureVisible`) — the
  visible rows of its headless emulator's ACTIVE buffer, the viewport cursor, and `altScreen` from that
  buffer (no tmux client sits between the pane and the stream, so the pane's buffer IS the stream's;
  this is the one route whose capture sets `VisibleCapture.altScreen`, and the link host prefers it over
  the join's). It keeps the private-mode tail (bracketed paste, application cursor keys, mouse) a
  mid-stream viewer never saw. A host from a build before the feature answers nothing, so `unavailable`;
  never the ~200-line scrollback `capture` in its place.
- **The direct Windows pty: none.** **A plain shell with no tmux: none.**
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

## The Control role

A **Control** link (role `controller`, UI "Control · Can watch, chat and type") is a Commenter link plus
typing for whoever unlocks it with the link's password. Until a viewer unlocks, it is a commenter: it
watches and may chat. Several viewers may unlock and type at once, each under a name they choose.
Control is per CONNECTION, never per session or per person: a reconnect unlocks again.

### The password

- **Required** for a Control link: 8 to 128 code points, no line breaks or control characters
  (`controlPasswordProblem`, `src/shared/watch-link-password.ts`, one rule for the dialog and core).
  **Generate** makes 16 symbols from Crockford's 32-symbol alphabet (10 digits + 22 letters, no
  lookalikes, ~80 bits, `crypto.getRandomValues`).
- **Shown once**, in the dialog's done step, with **Copy password**, beside the link and never in it.
  The dialog says to send the two separately. The plaintext lives in the dialog's state only and is
  cleared on every way out (Done, Escape, the scrim, Cancel); it is never logged and never written to
  localStorage, settings, a notice or an OS notification. There is no "show again": **Change
  password…** sets a new one.
- **Stored as a hash only**: scrypt (N = 2^15, r = 8, p = 1, a 16-byte random salt, a 32-byte key) of
  the password's NFC form, so the same letters typed as composed or decomposed characters unlock alike.
  The record carries `control: {enabled, locked, salt, hash}` and nothing else of it. The hash is not
  sealed by the keychain (it is already a hash, and the file is 0600 under userData).
- **The check is constant time** (`timingSafeEqual` on the derived key; `password.constant-time.test.ts`
  watches the call, because no behavioural test can tell it from `Buffer.equals`) and never throws: a
  malformed stored hash or a non-string password is a refused unlock.
- **Every scrypt run of the process goes through ONE FIFO gate of two slots** (`SCRYPT_SLOTS`): unlock
  checks from strangers, the owner's create and the owner's new passwords. One run is ~32 MiB and
  ~82 ms on libuv's 4-thread pool (Node's default `maxmem` refuses these parameters; it is raised to
  64 MiB). A run waits for a slot; it is never refused.
- **The password never leaves the E2E tunnel**: the relay and the API never see it.

### Unlocking

`cast watch:unlock {name, password}` is answered to that viewer alone with `watch:control {state,
reason?}`. In order:

1. A viewer that has not joined yet: ignored.
2. Already controlling: `{controlling}`. Locked, or typing off: `{locked|off, reason}`. None of these is
   counted or throttled.
3. Throttles, all host-side and not counted: an attempt within `UNLOCK_MIN_INTERVAL_MS` (2 s) of this
   viewer's previous one, or while another check for the link is in flight (one at a time per link),
   answers `{available, too-soon}`.
4. A malformed attempt (no name left after `sanitizeChatName`, a password that is not a string, empty,
   or over 128 code points) counts as wrong and is never verified: an over-long password never
   reaches scrypt.
5. A wrong password counts. **3 wrong on one connection end it** (`watch:end attempts`; it may
   reconnect through the link). **10 wrong across the link LOCK control.** Both the lock and the
   link-wide count are persisted in the record (`control.locked`, `control.wrong` 0–10): the host
   starts from the record's count and reports each new one (`onWrongAttempt`), which the service puts
   on the record and writes — at most 10 writes per link, the 10th riding the lock's own write — so an
   app restart resets neither (a file written before the count existed reads as 0). The lock demotes
   every controller and tells every viewer; the 11th attempt is answered `locked` unverified. The link
   keeps working as a Commenter link. Only the owner's **Allow control again** clears the lock, and it
   resets the count; a **new password** resets the count too.
6. A check is re-checked after its await. An ended viewer, a stopped host, or any change to control
   meanwhile (typing off, a new password, the lock: the control epoch) voids it, uncounted (`too-soon`,
   or the new state).
7. A right password: the viewer is controlling under the name it gave, `{controlling}` is sent, and the
   owner gets the `control-taken` notice ("Someone using the name “Mert” can now type in
   api-server.") and an OS notification. That is a SECURITY event, not an agent finishing, so the
   notification is gated on the notification consent alone (`notifyConsentAsked`: the one-time
   question was answered), never on the agent-done preference (`notifyOnClaudeDone`); at most one per
   link per 5 s, and only while the window is unfocused (main's rule). The name is a claim and is
   quoted as one.

**What ends control:** the viewer's Release (`watch:release`), its disconnect, a kick, the owner
turning typing off, a password change, the lock, or a rejoin whose terminal cannot take input. Every
one of them goes through `loseControl`: the pending batch is discarded, an open paste forgotten, the
viewer leaves the typing set. **A session restart does not end control**: the terminal exiting and
coming back is a rejoin of the same connection, and its meta says `controlling` again. The viewer page
then says "Control resumed. Click the terminal to type." and does NOT take the keyboard's focus (the
viewer may be typing in chat). Turning typing off, a password change and the lock demote every
controller at once; after a password change, legitimate controllers unlock again with the new one.

**The grace.** Keystrokes are in flight when control ends. Input from a connection that stopped
controlling within `INPUT_GRACE_MS` (5 s) is dropped silently: not delivered, not counted, not a
breach. Input from a connection that never controlled, or later than 5 s, is a policy breach and the
host closes the connection.

### Typing: the input path

`cast watch:input {data}`, from a controlling viewer only:

- `data` must be a string of 1 to `INPUT_MAX` (16384) UTF-16 units, or it is a breach.
- **An emulator's answer is dropped**, uncounted: every controller's xterm answers every query the pane
  makes (DA, CPR, an OSC colour), and those answers are not typing. `isTerminalReport`
  (`core/terminal-reports.ts`) matches a WHOLE cast only, so the viewer page sends each answer as a cast
  of its own, never merged with typed keys.
- **The budget**, per connection: a token bucket of `INPUT_RATE` 64 KiB/s with an `INPUT_BURST` of
  256 KiB (UTF-8 bytes), separate from the stream's. Input over it, input with no session to type into
  (the viewer is waiting), or input past a batch the pane has not taken yet holding a burst, is dropped.
  The viewer is told `{controlling, dropped}`, at most once per 10 s. **The notice is cause-neutral**:
  it covers the rate limit and a delivery to the pane that failed (an SSH host without tmux answers
  false on every chunk; a session that ended), and the page says "Some of your input didn't reach the
  terminal." Never silence.
- Accepted data goes through the connection's **splitter** into its **batch**, which is flushed
  `INPUT_BATCH_MS` (20 ms) after its first input into ONE delivery chain per link. A connection has at
  most one batch in the chain; while it waits there, new input keeps collecting, so a slow pane
  coalesces input instead of piling up deliveries. Adjacent keys merge, up to `INPUT_MAX`.
- **A batch holds at most `INPUT_CHUNKS_MAX` (64) chunks.** Every chunk is one pane delivery (one tmux
  spawn), and a paste/keys alternation would otherwise cost one per chunk. Past the cap the rest of
  THAT batch is dropped in whole chunks (a paste is never cut; what the splitter still holds — an open
  paste, a held prefix — is discarded with it), later input is dropped until the batch is flushed, and
  the viewer gets the rate-limited `dropped` notice. The next batch starts clean.
- **Order**: a connection's input reaches the pane in the order it was typed, and every batch arrives
  whole (no other controller's chunk inside it). Across controllers it is roughly flush order.
- **Every chunk is re-checked before it goes**: the same control period (`controlGen`, bumped by every
  loss of control), still controlling (the record is read live, so typing turned off reaches a batch
  mid-way even before the host is told), and still the session it was typed at. **The same check rides
  the chunk into PtyManager** as `isCurrent`, asked right before the step spawns (or writes), after any
  wait in the per-session chain: a chunk handed over while its sender controlled, still waiting behind a
  slow step (another link's, say) when control ends — Stop, typing off, a new password, the lock, a
  release, a kick — is never delivered (a throwing predicate reads as not current). A false, a
  rejection, or no answer within `PANE_INPUT_DEADLINE_MS` (20 s, counted from hand-over, the same
  constant in `PtyManager.controlInput`) stops the batch with the `dropped` notice, and the chain moves
  on.
- A session that ends drops the pending batch and discards an open paste (the viewer is told). Input is
  never held for a later session.
- Nothing typed is ever logged. The path's three warnings carry an error's name or a fixed sentence
  ("the input chain failed", "a pane delivery timed out", "delivering input failed"), and the flush
  guard (`safe('an input flush')`) logs the text of an error the host's own flush code threw, which
  carries no input.

### The splitter and paste framing

The viewer and the host share one contract (written in `protocol.ts` beside `WATCH_INPUT_CAST`):

- **The page frames every paste itself.** While typing, it keeps bracketed paste ON in its own xterm
  whatever the stream says: what the page renders is a tmux CLIENT's output, whose `?2004h` is
  constant, so the page's mode says nothing about the application in the pane. It removes both paste
  markers and every ESC from the pasted text (a marker inside would end the frame early and turn the
  rest into typed keys), turns line ends into CR as xterm would, and frames it `ESC[200~ … ESC[201~`.
- **The host splits on those frames alone** (`control-input.ts`). Everything outside a frame is KEYS,
  which is where every control byte belongs; the content of a frame is a PASTE. Markers and surrogate
  pairs split across casts are held until the next cast. A held lone Esc or Alt+[ is handed over as
  keys when the batch flushes, so Esc reaches the pane within one batch (an agent CLI's "Esc to
  interrupt" does not wait for another key). A paste is cut at `PASTE_MAX` (256 K UTF-16 units).
- **Dropped input is still parsed** (`discard`): a paste any part of which was dropped is discarded
  WHOLE. Otherwise a paste whose start was dropped would have its text typed as keys, each newline a
  command run in the shell.
- **The pane gets brackets only when its application asked**: the host delivers a paste with
  `paste-buffer -p`.

Residual: a start marker split right after `ESC` or `ESC[` whose second cast arrives more than one
batch interval later is typed as keys (the same bytes, unframed). The page sends both halves back to
back.

### Pane delivery, and why never a tmux client

A controller's bytes go to the node's PANE (`PtyManager.controlInput`), never into a tmux client's pty.
Written into a client (the owner's painter, or a watcher's own client), bytes are that client's
KEYBOARD: they go through its key tables, so the prefix reaches tmux. `C-b s` is the session chooser
over EVERY session on the socket (other projects' agents included), `C-b (` switches to the next one,
`C-b :` opens tmux's command prompt (`run-shell`, `kill-server`). A controller would reach every
terminal on the machine, not one. The prefix inside a client is the security boundary of the role. A
watcher's own client is also read-only and would drop every byte.

The two plans (`pane-input.ts`), every payload on stdin, never in argv (local or SSH; argv is readable
by every user through `ps`):

- **keys**: `tmux -L <socket> source-file -`, the command text on stdin: first a mode cancel
  (`if-shell -F -t =nt-<id>: '#{pane_in_mode}' 'copy-mode -q -t =nt-<id>:'`, because `send-keys` into a
  pane in copy mode or the tree chooser is eaten by that mode, and `j` + Enter in the chooser would
  switch the owner's client to another session), then `send-keys -t =nt-<id>: -H <hex>` lines of 1024
  bytes. tmux hands `send-keys -H` bytes to the pane as literal keys, with no client and no key table.
- **paste**: `load-buffer -b <unique> -` from stdin, the same mode cancel, then
  `paste-buffer -d -p -r -b <unique> -t =nt-<id>:`. The text is `sanitizePasteText`-ed (no ESC) and no
  Enter is sent. `-p` lets tmux frame it from the pane's real bracketed-paste state; `-r` keeps `\n`.
  A paste whose `paste-buffer` never ran has its buffer swept.
- **Why keys never ride a paste buffer**: tmux 3.7 passes paste buffer content through vis(3) (issue
  #453), so an arrow key arrives as the text `^[[A` and Ctrl-C as `^C`.
- **The target is exact**, `=nt-<id>:`, as for keyframes: `nt-x-1` is a prefix of `nt-x-12`.
- **SSH**: the same plans run on the host over the project's ControlMaster (the `nodeterm-rmt`
  socket), stdin piped through ssh, every piece the remote shell reads single-quoted.
- `PtyManager.controlInput` chains each session's chunks (a chunk starts only after the previous one
  settled), re-reads the Session inside each step, answers whether it was delivered, never rejects, and
  gives each chunk what is left of its 20 s deadline. A chunk with nothing left when its turn comes is
  dropped undelivered.

Measured 2026-10-04 on Linux, private socket and private `TMUX_TMPDIR`, conf `set -g prefix C-b`; tmux
3.4 (`/usr/bin/tmux`) and tmux 3.7b (the release the macOS app bundles, sha256-pinned, built from
source). The pane ran `stty raw -echo -iexten; cat > file`, so the file is exactly what the
application's stdin received:

| # | Check | tmux 3.4 | tmux 3.7b |
|---|---|---|---|
| 1 | Bytes exact: 0x00–0xff in 4 batches, `ESC[A`, `ESC O A`, CR, `^C`, DEL, `ç 漢 🙂 é` | 276/276 exact | 276/276 exact |
| 2 | Prefix inert: `02 73` through the keys plan, a real client attached | pane got `02 73`, `pane_in_mode` 0 | same |
| 2 (control) | The same bytes typed INTO the client | the tree chooser opened | same |
| 3 | Copy mode, then `61` | mode left, pane got `61` | same |
| 3 (control) | `send-keys -H` with NO cancel, in copy mode | eaten by copy mode | same |
| 3 | Tree chooser (`C-b s` on the client), then `j` Enter | chooser gone, pane got `6a 0d`, client stayed on its session | same |
| 4 | Paste `a\nb`, the app asked for `?2004h` | `ESC[200~ a \n b ESC[201~` | same |
| 4 | Paste `a\nb`, the app did not | `a \n b` | same |
| 4 | Paste into a pane in copy mode | mode left, framed | same |
| 4 (info) | Paste `p ^C q DEL r TAB z CR w` | bytes verbatim | `^C` → the text "^C", DEL → "^?", TAB and CR verbatim |
| 4 (info) | An ESC left in a paste | ESC verbatim | "^[" (vis(3)) |
| 5 | `=nt-a-1:` with `nt-a-12` alive | only `nt-a-1` got it | same |
| 5 | A missing or killed target, keys and paste | exit 1, nothing delivered, no prefix match | same |
| 6 | 16384 bytes in ONE `source-file -` (16 lines) | exact, 58 ms | exact, 96 ms |
| 7 | Latency, 50 single bytes (spawn → byte in the file) | median 3.1–3.3 ms, p95 4.0–5.9 ms | median 2.4 ms, p95 12.1 ms |
| 8 | SSH | not measured over a real ssh (no key on the measuring host) | — |
| x (info) | `ESC[A` through `paste-buffer -r` (the spec's first candidate) | `ESC[A` | the text `^[[A` |

Also measured: a guard command tmux cannot PARSE rejects the whole `source-file -` text before
anything runs (exit 1, nothing typed). Separate lines are separate command groups at run time, which is
harmless because every line names the same exact target. Version floors: `source-file -` needs tmux 3.1
(an older SSH host fails the keys plan closed, exit 1); `copy-mode -q` is taken as 3.2+, untested below
3.4. Read from tmux's source, not measured: `send-keys` honours a window's `synchronize-panes` and
silently drops input to a pane disabled with `select-pane -d`; nodeterm's conf sets neither. The SSH
command line is proven under a real `/bin/sh` with a stub `tmux` (`pane-input.realtmux.test.ts`), never
over a real sshd or ControlMaster (device checklist). Which route PtyManager picks is pinned by
`pty-manager.control-input.test.ts`; what each plan means on a real tmux by `pane-input.realtmux.test.ts`.

### Backends

| Node | Route (`watcherInputRoute`) | Keys | Paste |
|---|---|---|---|
| Local tmux (the owner's painter, or a watcher's own read-only client) | `tmux` | `send-keys -H` on the pane | `paste-buffer -p` |
| SSH-project node | `ssh` | the same, on the host | the same, on the host |
| Windows session host | `write` | PtyManager's ordinary write | the host's no-Enter `sendKeys`, framed only when the app asked |
| A direct Windows pane | `write` | ordinary write | the pane's no-Enter `sendText`, framed only when the app asked |
| Plain shell (no tmux) | `write` | ordinary write | sanitized and unframed (no emulator here knows what the app asked) |
| Zellij | `none` | refused | refused |

There is no tmux client between the viewer and the pane on the `write` routes, so there is no key table
to reach. The session host's paste answers false while another text delivery to the same session is in
flight, and on a host too old for `sendKeysV2`; it is never retried and never falls back to a raw write.
**An SSH host without tmux** (the plain login-shell fallback) still records the session as tmux-backed:
every chunk fails, and the controller sees the `dropped` notice.

**Zellij is refused.** Zellij's key bindings are session-wide and there is no pane delivery that
bypasses them. `nodeControlSupport` answers `unsupported` for a Zellij node, or for a node with no
session on a machine whose new sessions are Zellij (a node whose tmux session is warm but not held by
this process reads the same until it is mounted). The dialog then shows Control disabled with its
reason ("Control isn't available for this terminal: its Zellij session's key bindings would reach every
session."), a create answers `control-unsupported` before any request, and a join whose route is `none`
makes that viewer's state `off`/`unsupported`: its meta says so, an unlock is answered so (uncounted),
and a controller is demoted. An SSH-project node answers `ok` (it runs in the host's tmux; Zellij is
local only).

### Who is typing

The host keeps, per controller, the time of its last accepted input. **The typing set** is the names
(the name each one unlocked under, not a later chat name) with input in the last 4 s. It is recomputed
at most once a second while anyone is in it, sent as `watch:typing {names}` to every joined viewer when
the SET changes, and sent right after the meta on every (re)join while it is not empty, so a viewer that
reconnects mid-typing sees it. The page shows "Mert is typing…". The owner sees the same set in the
link's view: the chip reads `LIVE · 3 · 1 typing` with the quoted names in its title, and the popover
and the drawer put a typing dot on that viewer's row and "can type" on every controller.

### The owner's controls

Per link, in the chip's popover and in the Live chat drawer (one `ControlSection` for both):
**Typing** on/off, **Change password…**, and **Allow control again** while locked. Per viewer: Kick
(on a viewer who is controlling, its note adds "They can unlock again — change the password or turn
typing off to keep them out.": a kicked controller with the password rejoins and unlocks). Stop ends
everything.

- **A change that NARROWS access applies at once; one that WIDENS it applies only after the write.**
  Turning typing off and a new password reach the record and the link host immediately (a leaked
  password or an unwanted typist must not wait on the disk), then the record is written. Turning typing
  on and Allow control again are written first, from a copy of the record, and reach the record and
  the host only once that write has landed: nobody can unlock and type during a write the owner is then
  told failed. A later change to the same field supersedes one still being written.
- **A narrowing change is the owner's brake, and it never fails open.** It is NEVER undone by a write
  that fails or does not answer within 10 s: typing stays off, the new password stays in force (the old
  one is refused). The call answers `'unsaved'` (`ControlChangeResult`), and the popover and the drawer
  say "Applied, but couldn't be saved — it will undo when nodeterm restarts. Stop the link to end it for
  good." with **Stop sharing** right there (the drawer has no Stop of its own otherwise). A new password
  answered `'unsaved'` is shown once like a saved one. Every write carries the whole list as memory
  holds it, so the next write that lands — any change, a lock, another link — saves the narrowed state,
  and the notice goes with the next change the owner makes that is saved. A **widening** change whose
  write fails answers `false` and changes nothing ("That change didn't take — try again."). A new
  password `false` (refused by the rule, or its hash failed) says "The password wasn't changed — try
  again. The old one still works."
- The done step of a **Control** link's create dialog ignores a click on the scrim until **Copy
  password** was pressed (it holds the only copy of the password); Escape and Done still close it.
- A password save in flight holds the popover open (an outside click and Escape do nothing) for up to
  30 s; after that the owner sees "Couldn't confirm the new password. Check the link before sharing it."
- The lock is set on the record synchronously when the host asks for it, written, and never undone by
  a failed write. The owner gets the sticky `control-locked` notice ("Control of api-server was locked
  after 10 wrong passwords. Allow it again from the LIVE chip.").

### The create dialog

Figma's share-dialog shape (`LiveLinkDialog.tsx`, `MenuSelect.tsx`): a head with the node's title
and ✕, then one grouped list whose rows read as sentences, the warnings, and the actions.

- **Rows.** "Anyone with the link · can watch ▾" (the role menu), "Password · <field> ↻" (Control
  only), "Expires · in 1 hour ▾" (the expiry menu) and "Viewers see you as · <name>" (the label, an
  inline field that shows its box on hover and focus). The role menu's options read "can watch —
  Sees the terminal", "can chat — Watches and chats with you" and "can type — Also types, with a
  password" (`ROLE_CHOICE`). The expiry menu reads "in 15 minutes" … "in 24 hours", then "never —
  This link works until you stop it." `controlSupport(nodeId)` is asked once; only `unsupported`
  disables "can type", and the disabled option's hint is the reason.
- **The menus render inside their row**, absolutely positioned and opaque, never in a portal: the
  dialog is a backdrop root under Liquid Glass. Keyboard: ArrowDown/ArrowUp open a menu; the arrows,
  Home and End move over the options that can be picked; Enter/Space pick; Escape and Tab close it
  and give focus back to the trigger. The menu's Escape never reaches the dialog's, so it does not
  close the dialog. The role menu's trigger takes the focus when the dialog opens (D2/M3).
- **Picking "can type" fills a generated password** (16 symbols, the same generator as before) when
  the field is empty, so a Control link is two clicks; ↻ ("New password") replaces it, and the owner
  can still type their own. A password already there (typed, or kept from switching away and back) is
  left alone. The validation line sits under the row once something invalid is typed.
- **Warnings.** Control shows the typing warning, with "and" in bold, in a red wash: "With this link
  **and** the password, anyone can type here as you: run any command on <machine>, or instruct the
  agent in this terminal." Under it, for every role, one muted sentence of what watching exposes:
  "Viewers see everything this terminal shows: scrollback, anything printed later (tokens too), and
  other tmux sessions if you open the session chooser or switch sessions." Neither is behind a
  toggle.
- **The typing warning names the machine where the commands run**: `thisMachine()` ("this Mac", "this
  PC", "this computer") for a local node; `user@host` for an SSH-project node or a node attached to an
  SSH host. A remote tmux node on its own SSH project's host names the PROJECT's user, the one the
  shell runs as.
- **The dialog remembers the role and the expiry of the last link this person created**
  (`lib/liveLinkDefaults.ts`, localStorage `nodeterm.liveLinkDefaults`, saved only after a create
  succeeds). The first dialog opens on "can watch" for an hour. A remembered Control opens with a
  fresh generated password and its warning on screen, and on a terminal that cannot take input it
  falls back to "can watch". Never the password, never the label.
- Create stays disabled until the password passes the rule. The request carries `password` only for
  Control.
- **The done step**: a status line in the LIVE chip's red ("● Anyone with this link and the password
  can type until …"), the link with **Copy link**, then for Control the read-only password with
  **Copy password** and one note ("This is the only time the password is shown. Change it later
  from the LIVE chip. Send the password separately from the link."). **Stop sharing** is a red text
  button on the left, **Done** on the right.

### The viewer page (nodeterm-web)

A **Take control** button opens a small form: a name (prefilled from the chat name) and the password.
On a grant the terminal takes the keyboard, the header says "You can type" with **Release**, and input
goes out batched per animation frame. Errors say what happened (wrong password; too many wrong
passwords, the sharer has to allow control again; the sharer turned typing off; wait a moment and try
again; this terminal can't be typed in from a link). A password change shows "Control ended. Take
control again to type.". While typing:

- **The keyboard exit chord**: Ctrl+Shift+. (⇧⌘. on a Mac), matched on the physical Period key, moves
  focus from the terminal to Release. It is never sent to the pane. Without it, the terminal would be a
  keyboard trap.
- The wheel does nothing on the alternate screen (xterm would turn it into arrow keys, which would
  recall prompt history into the input line).
- Mouse tracking stays swallowed: no mouse input is ever sent, and selection stays local.
- On a phone, a grant after a script moved the focus opens no keyboard, so the page asks for a tap
  ("Tap the terminal to type.").
- When the page's connection drops while typing, it says "The connection dropped. Take control again to
  type." and clears the typing line.

## Unlimited links

The TTL choice has a fifth option, **Unlimited** (wire value `ttlSeconds: 0`), listed last; the
dialog's expiry menu calls it "never", with the hint "This link works until you stop it." The link has `expiresAt: null` and lives
until Stop, Stop all, a server 410, node-gone, or (for new joins) a lapse of the owner's Pro.

- **Backend** (nodeterm-server). `watch_links.expires_at` is nullable, and NULL means live everywhere:
  `linkState`, the per-license active count (an unlimited link counts toward the 15 for as long as it
  lives), revoke-all, status, host-token and join. The 7-day purge never deletes a NULL row.
  `ttlSeconds: 0` is granted only when no `WATCH_LINK_MAX_TTL_SECONDS` cap is configured; with a cap
  it is clamped to the largest allowed length, like any over-cap request, and the answer carries that
  expiry. An older backend answers `0` with `400 bad_ttl`, which the dialog shows as "Unlimited links
  need a newer server. Pick an end time." (`ttl-unsupported`).
- **The daily Pro check.** An entitlement token lives 7 days, so a host-token mint that checked only the
  token would let an unlimited link outlive a lapsed Pro by up to a week. For a link with no end time
  (and only for one: a finite link's mint never calls keygen), the host-token route asks the license's
  liveness (the create route's keygen check) at most once per 24 h per license, cached in the server's
  memory:
  - `live`: the mint goes ahead, and the answer stands for 24 h;
  - `dead`: `402 not_entitled`, never cached (a renewal is not locked out). The host stops minting and
    the link's view reads `refused`, the same as any refused mint; it is re-armed only when the license
    layer reports a change (`onEntitlementChanged`);
  - `unknown` (keygen unreachable, or no answer within 3 s): the mint goes ahead (an outage must not take
    a paying user's link down) and the question is asked again after 10 minutes;
  - an entitlement with no device id: 402.
- **Desktop.** `WatchLinkRecord.expiresAt: number | null`. No expiry timer is armed for null, a host
  change never ends it as expired, and `init()` never prunes it for time. The views say "No end time"
  where they say "ends in …", and the done step "until you stop it". The API client accepts a null
  expiry only for a `ttlSeconds: 0` request; a numeric answer to one (a capped server) is re-anchored
  like any other.
- **Opaque entries** (a secret the keychain refuses to unseal this run) carry `control` too, and an
  unlimited one is never dropped for time: it is carried verbatim until the keychain answers or the
  owner runs Stop all.
- **The viewer page** shows no "ends in" for `meta.expiresAt: null`.
- The 5-links-per-machine cap is unchanged.

**Downgrade.** A build older than this one drops Control and unlimited records when it loads the links
file (it knows neither the role nor a null expiry), and its next write removes them. A launch alone
writes nothing (`init()` writes only when it pruned something); the next create, Stop or prune does.
Their server rows stay live with no host: nobody can join them, a finite Control link until it expires,
an unlimited link until **Stop all** (from any machine on the license) reaches the server.

## Live chat drawer

A right-side drawer, **Live chat** (`components/LiveChatDrawer.tsx`), to follow and answer link chat.
It uses the Explorer's drawer shape and pin rules.

- **Opened from** a chip popover's **Open chat** (Commenter and Control links; the canvas node, kanban
  card, card modal and sidebar chips alike), and the palette's "Live chat" (section View, offered only
  while a link is live). `nodeterm:live-chat {linkId}` has exactly one listener, in Canvas, which
  validates the id, remembers it and opens the drawer on it.
- **Pinned or not.** Unpinned it is a modal drawer: a scrim (z 55), a click on the scrim closes it, it
  takes the keyboard's focus and gives it back on close, and it is on the dialog stack. Pinned
  (`nodeterm.liveChatPinned`) it docks as a 320 px card below the controls cluster (z 26), does not
  block the canvas, is not on the dialog stack, and maximize and zone snap clear it. Pinned beside a
  pinned Explorer, it docks to the Explorer's left, 8 px apart. **A pinned drawer is shown only while a
  link is live**; the pin is remembered and it comes back with the next link.
- **Over the board.** While a kanban card modal is open on an open board, the drawer is raised (z 57)
  above the modal, never above Settings; it then docks at the right edge, not beside the Explorer.
- **Escape.** Unpinned, Escape closes the drawer only when the drawer is the top dialog and the key
  was typed in the drawer (or with nothing focused). Pinned, Escape does nothing to it. The card modal
  ignores an Escape typed inside the drawer.
- **The link picker** shows when more than one link is live: "{title} · {role}", made unique when two
  read the same (by the label where labels differ, then "since HH:MM", then a counter). The pick is
  remembered (`nodeterm.liveChatLink`); when it is gone, the drawer falls back to the most recently
  created link.
- **The link head**: title and role, **Go to terminal** (an unpinned drawer closes first, since its
  scrim would cover the node; then the canvas travels to the node, opening its card on a board), and
  the popover's status line (reconnecting, refused, viewers waiting).
- **People**: for a Control link the same `ControlSection` the popover has (Typing, Change password…,
  Allow control again); each viewer with its name, a typing dot, "can type" or "watching", and Kick.
  **A Viewer link shows People only** (no chat on that role).
- **The thread** (Commenter and Control links) looks like the viewer page's chat: time, a Sharer badge
  on the owner's lines, the name in its colour (the page's own hash and palette, so one viewer has one
  colour on both; on the light theme mixed toward the ink), the text. Every name and text is rendered
  as text, bidi controls stripped. It stays at the newest message unless scrolled up, and then shows an
  "N new messages ↓" pill. The composer posts as the sharer.
- **Unread.** A new viewer message raises a count on that link's chip (`99+` past 99, summed over a
  node's links). A message counts as read only while someone can see it: the drawer or the popover is
  showing that link AND the window is visible and focused. While the window is unfocused the count keeps
  rising, and it clears when the window comes back.
- **Holds.** While a new password is being saved, the drawer cannot be closed or switched to another
  link, and an unpinned one cannot be left with Go to terminal. While a new password is on screen
  (until Done), it stays on that link: an Open chat on another link waits.
- **No OS notification per chat message**; `control-taken` is the only live-link notice that raises
  one.

## Lifecycle

**Create** (`service.create`, in order): `unsupported` shell → parse (`bad-request`; then, for a Control
link only, `bad-password` when the password breaks the rule — a password on a Viewer or Commenter
request is ignored) → a build that may not relay (`relay-unavailable`) → wait for `init()` (bounded) →
the node must be **present** (`node-missing` otherwise; `unknown` answers node-missing too, so the
dialog flushes the canvas save first — R47) → for Control, a node that refuses it
(`control-unsupported`, before any request) → 5 per machine (`limit-machine`, counting links being
written and opaque entries) → an entitlement (`not-entitled`) → for Control, the password hashed through
the scrypt gate (a hash that fails answers `unsupported`, "Live links can't be created here right now.",
and nothing is created anywhere) → `POST /v1/watch-links` (its refusals pass through: `not-entitled`,
`limit-active` (15 per license), `limit-daily` (50 per 24 h), `rate-limited`, `license-check`,
`ttl-unsupported` (Unlimited against an older backend), `network` — which covers timeouts, 5xx and a
malformed reply, so the copy never says "offline") → the record is written (bounded at
`PERSIST_TIMEOUT_MS`, 10 s; on failure the server row is revoked and the answer is `persist-failed`: no
half-created link survives) → the node is checked AGAIN (absent → revoke, `node-missing`) → the host
starts. Label and title lose C0/C1, DEL and bidi controls and are capped by UTF-16 units without
splitting a pair.

**The clock.** The expiry timer is derived from the server's `expiresAt` and the response's `Date`
header (`tokenTtlMs`'s rule), never from the local clock alone; it is re-checked on every host change,
because a closed lid pauses timers. An Unlimited link (`expiresAt: null`) has no timer and no check.

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
  reset) is carried back verbatim, `control` included, on every write until its own `expiresAt` (never,
  for an unlimited one), never erased at boot.
- **A Control record carries `control: {enabled, locked, salt, hash}`**, and only a Control record does.
  A load drops a record that breaks this (a controller without it, a viewer or commenter with it, or a
  malformed one: salt and hash must be canonical base64 of 16 and 32 bytes), and a save refuses
  (`failed`, the file untouched) a list holding such a record. Only those four fields are written.
  `expiresAt` must be a finite number or `null`.
- **A keychain that stops sealing mid-run** (R45): the store keeps a digest-keyed cache of every sealed
  form it read or wrote and never re-seals, so only a link that was never sealed (the one just created)
  is left out; the owner is told "This link wasn't saved on `thisMachine()` — it keeps working until
  you quit." (R59: the copy claims nothing about earlier links, because the renderer cannot tell the
  causes apart.)
- `init()` writes only when it actually pruned something, so a boot never rewrites the file.

**Resume** (`init()`, idempotent, never rejects): wait for the boot workspace load (bounded,
`WORKSPACE_READY_TIMEOUT_MS` 10 s), load, drop expired (never an unlimited link), revoke and drop
ABSENT, KEEP unknown, cap at 5 (extras revoked: a hand-edited file of 200 entries must not start 200
schedulers), start hosts only when `relayAllowed()` (an unpackaged dev build lists them `refused` and
hosts nothing: a dev run must not host the installed app's links).

**Node gone is tri-state** (R40, `workspaceNodeState`). Present = some project holds it; absent = the
store has a complete read of every project (`knownNodeIdsStrict()`) and the id is not in it; anything
else is unknown. **Only absent** ends a link (`node-gone`, server revoke). An empty answer during the
launch-time load, or for a node in a project whose file was not read, is not evidence, and a revoke
cannot be undone. The check runs on every workspace load/save (`onWorkspaceChanged`, which also covers a
node removed by the canvas authority on a peer's op) and before every join (R29). **An index rebuilt
from nothing is never a complete read** (R44, R54, R55): a `workspace.json` that is missing, unreadable,
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
untouched. A Pro lapse lets open finite links run out their term (≤ 24 h): their host tokens check the
token and the link row, not keygen. An unlimited link's host-token mint asks the license's liveness at
most once a day (see "Unlimited links"); a dead license answers 402, and the host stops minting.

**Hung-disk and quit rules.** Create waits for its write ≤ 10 s; revoke / revoke-all wait for `init()`
only boundedly, so Stop all still reaches the server on a hung disk (its wait for the server's answer
is the API client's 8 s timeout); `init()`'s own workspace bound fires
before any wait on it, so a slow workspace never reads as a failed write. Desktop: `shutdown()` runs on
the FIRST before-quit pass, before `ptyManager.killAll()`, inside the 1.5 s raced flush — viewers get
`host-stopping` while the sockets are up; the records stay on disk and resume at the next launch. Server
Edition: `shutdownWithin(watchLinks, 2 s)` after `hosted.stop()` in both close paths.

**Owner state.** `watchLink:state` (the FULL list, coalesced per tick), `watchLink:chat` and
`watchLink:notice` go to owner clients only (`sendToOwners`): every view carries the URL, and the URL
carries the secret. A view carries `expiresAt` (`null` for Unlimited), `control` (`{enabled, locked}`
for a Control link, else `null`) and each viewer's `controlling` and `typing`. The notices are
`joined`, `not-persistent`, `ended`, `control-taken` and `control-locked`; `not-persistent` and
`control-locked` stay on screen until dismissed, and only `control-taken` also raises an OS
notification. The four control requests (`set-control`, `set-password`, `allow-control`,
`control-support`) are owner-checked like the others, and like every `watchLink:` channel they are
host-only. Chat history (200 per link) is memory-only, cleared on revoke or restart. Everything
a viewer wrote reaches the owner bidi-stripped and is rendered as text. **Link state is never canvas
content:** no field on `CanvasNodeState`, `ProjectKanban` or any `CanvasMutation` — canvas sync would
carry it to teammates and the canvas authority would write it into the git-shared `project.json`.

## Surfaces

- **Desktop:** full. Entry points: node right-click "Share live link…" (`selectionItems`, shared by the
  sessions-sidebar row; hideable as `live-link`), the kanban card menu (per-project board AND the Omni
  board's lanes, non-active projects included — a viewer of a node with no Session held spawns its own
  read-only tmux client, so on a machine whose local terminals are tmux the node need not be on screen),
  the terminal node's header button (between Comments and the eye; hideable as `share-link` — the LIVE
  chip never is), the card modal header action, the palette ("Manage live links", and "Stop all live links (every
  machine on this license)" for a Pro owner or while a link is listed), Settings → Live links (Remote &
  team). Each row is judged by its node's OWN project's session (`liveLinkMenuItemsFor`, D2/M1).
  ProCompare lists "Live links to a
  terminal: watch, chat, or let people type — viewers need nothing installed"; the Core list is
  untouched. **Availability is
  checked before the Pro gate** (`liveLinkUnavailable` then `requireProOr`), so a Server Edition or relay
  tab never sees an Upgrade dialog; an unavailable row is disabled with its reason, never hidden.
- **Windows' session host** has its own read-only client: a join-only create (a watcher, or a hosted-relay
  viewer) for a node this app does not hold asks the host STRICTLY (`hasSession`; an unanswered probe
  refuses) and joins through `watch-attach` — an attachment with no geometry claim and no pause ticket,
  whose writes and resizes the host refuses and which never spawns. It is never indexed as the node's
  session, so an owner opening the node gets its own typing attachment. A host from an older build
  lacks the feature: refused (`join-only`), never an ordinary attach that would cast the viewer's size.
  The create dialog's note follows `tmuxStatus().persistence.watchJoin` (the CONNECTED host's answer).
  Control typing needs the node open WHEN THE VIEWER JOINS: a viewer that joined through `watch-attach`
  keeps that read-only attachment (its input route is decided at join, `none`) even after the owner
  opens the node, until it rejoins (the session ends, or the link reconnects).
- **Desktop where local terminals are neither tmux nor such a session host** (tmux switched off or
  missing; the Zellij backend; an older host): there is no watcher client of its own, so a viewer can
  co-attach only to a terminal this app has OPEN (mounted, or parked) — after a restart, for a background project or an
  offscreen-released node, viewers wait. This is said, never silent (R63): the create dialog states it
  before the link exists (`watchableOnlyWhileOpen`, from the local core's `tmuxStatus().persistence`; an
  SSH project's node is served by the host's tmux and gets no note), and while a viewer's join is
  refused the chip turns amber (`LIVE · 1 waiting`) and its title and the popover say "Viewers are
  waiting — open this terminal in nodeterm to let them watch."
- **The LIVE chip** (`LiveLinkChip`, one component): node header (beside `PresenceChips`), kanban card,
  card modal header, sessions-sidebar row. `● LIVE`, `● LIVE · 2`, `LIVE · 3 · 1 typing` (someone typed
  in the last 4 s; the title names who, quoted), amber `LIVE · offline` (reconnecting), amber `LIVE · 1
  waiting` (a viewer's join was refused — R63), muted `LIVE · refused`; an unread COUNT (`99+` past 99,
  summed over the node's links) for Commenter and Control chat. A viewer is reported waiting only once a
  join is REFUSED: a session that merely ends rejoins in seconds and is no news. **Not hideable** — it
  is the owner's signal that a terminal is being broadcast. It shows only for a node viewed through a
  LOCAL session (R57): a relay tab's copy of a git-shared node with the same id must not show this
  machine's chip, and the boards and the sidebar sit outside the node's SessionProvider, so they resolve
  the session from the project id. The popover (per link): the role name with its label, the countdown
  ("No end time" for Unlimited), Copy, **Open chat** (Commenter and Control: the Live chat drawer),
  Stop, the Control section for a Control link (see "The owner's controls"), viewers with Kick (a typing
  dot and "can type" on controllers), and the chat with reply and "Copy to card comments" (an explicit
  act, as the owner; mention tokens defused). A join raises an info strip, "Someone started watching
  <title> (2 watching)." — how an owner notices a leaked link.
- **Server Edition:** the same core service is registered, with `entitlement: () => null` and
  `unsupported: true` (R43), because that edition has no license layer yet (`initLicense` is
  desktop-only). Create answers `unsupported` and the renderer shows "Live links need a Pro license on
  this server — not available in the Server Edition yet", no Upgrade button; list answers `[]`; nothing
  is loaded or hosted. The ws-bridge has a REAL `watchLink` member (`buildWatchLinkApi`, spread only
  into the Server Edition's own api, never a relay-shared builder): its browser clients are the host's
  own user, not relay peers, so the host-only prefix does not refuse them. Its four control requests are
  real too: the three changes (`set-control`, `set-password`, `allow-control`) answer `false` there (no
  link exists), while `control-support` answers the node's real support (the server wires
  `controlSupport` like the desktop, and the service does not refuse it in `unsupported` mode). A server
  license layer is the follow-up. A Server Edition that does not own its data dir skips `init()` and
  logs it.
- **Relay tab:** the API is an inert stub (`stubs.ts`); the row is disabled with "Live links are created
  on the machine that runs this terminal."; the chip is not shown. On the peer, every `watchLink:`
  channel is host-only, refused `E_FORBIDDEN` to every relay peer — Team Access guests and hosted owners
  and editors included (an editor passes every access check, and a link spends the host's Pro and
  publishes a host terminal to the world). `scoped-guest-policy.test.ts` proves the refusal on the real
  relay host with and without hooks.
- **Kanban:** first-class, as above (card chip, card menu row, card modal chip + action — the action is
  disabled with its reason as its title, because the canvas notice strip sits under the modal scrim).
- **Mobile:** N/A in v1. Links open in Safari, and on a Control link a phone can take control there
  (the page asks for a tap to open the keyboard after the grant). **Follow-up for nodeterm-ios
  (@eneskirca):**
  create/list/revoke from the phone (needs `watchLink.*` verbs on the phone dialect of the desktop's host
  service), and optionally an in-app viewer for `nodeterm.dev/s/` universal links.
- **No canvas-control verb** creates, lists or revokes a link, or changes its control: an agent must never
  be able to publish a terminal or hand out typing (`live-link.guard.test.ts` reads both verb tables).
- **The Live chat drawer** works wherever a link exists. In the Server Edition none ever does, so the
  palette never offers "Live chat" there (it offers "Manage live links" alone).

## Threat notes and residuals

From the spec, verbatim:

- **Residual — no forward secrecy**, as for the relay today: a recorded session plus a later-leaked
  `S` is plaintext. `S` is deleted from the registry on revoke/expiry; lifetime ≤ 24 h for a finite
  link, until Stop for an Unlimited one.
- **Residual — all viewers of a link share one viewer key**, so they are cryptographically
  indistinguishable; identity is the session. Kick is per session; only Stop ends access. On a Control
  link a kicked controller can reconnect and unlock again: to take typing from a person, change the
  password or turn typing off.
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
- **On a backend with no visible capture** (a session host from an older build, direct Windows pty,
  plain shell, Zellij) a throttled viewer shows gaps until the app repaints (R36). A Zellij node with no painter held
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
- **Any machine whose local terminals are neither tmux nor a `watch-attach` session host:** a link to a
  terminal that is not open in the app cannot be watched until it is (Surfaces, above). Said, never
  silent. On the session host, Control typing still needs the node open at the moment the viewer joins (a
  viewer already riding a `watch-attach` attachment is not upgraded when the owner opens the node).
- **A tmux < 3.2 host cannot be watched** (fail closed, "waiting").
- **After a run whose index was missing, unreadable or corrupt, node-gone waits for the next launch**
  (R44/R54): a link to a node deleted in that run lives until its expiry (≤ 24 h) — an Unlimited link
  until the next complete read at a later launch, or Stop — with nobody able to join it (its session is
  destroyed). The agent-status mirror is not affected (R64/M2).
  Likewise a link to a truly deleted node in an unread project lingers until the next complete read.
- **Opaque entries** (an unsealable secret) live in the file ≤ 24 h, or until Stop all for an unlimited
  one.
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

### The Control role and Unlimited links

From the Control spec (§6), in substance:

- **What a leak costs.** A Control link plus its password is a remote shell as the owner, in that one
  terminal, for as long as the link lives, which with Unlimited is until Stop. The dialog says so, and
  names the machine. The password is the second factor: the link alone grants watching and chat.
- **Brute force needs the link first**, then runs into the host-side throttles: 1 attempt per 2 s per
  viewer, 3 wrong per connection, 10 wrong per link before control locks (persisted; only the owner
  clears it). The hash is scrypt, and only a person who can already read the owner's userData has it.
- **Named controllers are not authenticated.** A name is a claim, like a chat name, and is shown quoted
  as one. Everyone who unlocked holds the same password. Accountability is "who was connected and
  typing, by their own word", not identity.
- **What stays out of reach** (host-enforced): the canvas, other terminals and other sessions (pane
  delivery: the tmux prefix never reaches tmux), files and git; resizing; the owner's IPC
  (`watchLink:*`, host-only) and every other relay verb.
- **What the role does NOT protect against**: anything a shell can do — `cd` anywhere, `tmux attach -t
  <other>` typed as a COMMAND (a shell command, not a key binding: the shell runs as the owner's user,
  which is exactly the access the warning names) — and an agent's tools. The owner's own actions in
  their client (opening tmux's chooser, switching sessions) reach viewers as before.

Found while building them:

- **A Pro lapse stops new joins of an unlimited link within a day** (the daily check answers 402 and the
  host stops minting). A viewer already connected, a controller included, stays until it leaves, or
  until the broker ends the bridge at its token's lifetime (unverified, item 15). Stop ends it at once.
  A keygen outage fails open: a lapse during it is noticed once keygen answers again (re-asked every
  10 min).
- **The wrong-attempt count is persisted with the lock**, so an app restart no longer resets it (it used
  to: with Unlimited links, nine fresh guesses per restart). What remains: a write of the count that
  fails (logged) or a crash inside the write leaves the disk one count behind, and a new password starts
  the count over by design. Each connection is still held to 1 attempt per 2 s and 3 wrong.
- **The hash is not sealed by the keychain**: a person who can read userData can guess offline at scrypt
  speed. A generated password (~80 bits) is out of reach of that; a typed 8-character one may not be.
- **A narrowing change that could not be saved holds until a restart, not beyond it.** Typing off and a
  new password are applied at once and never undone by a failed or hung write (the owner is told
  `'unsaved'`), but if no later write lands before nodeterm restarts, the restart brings back the state
  on disk: typing on, or the OLD (possibly leaked) password. The notice says so and puts Stop at hand,
  which ends the link for good.
- **The grace**: a connection that lost control has 5 s in which its input is dropped silently rather
  than treated as a breach. A malicious ex-controller gets 5 s of discarded input instead of a
  disconnect.
- **Order across controllers is roughly flush order**; each connection's batches arrive whole and in
  order.
- **Paste**: the page strips every ESC from a paste, so a paste of literal ESC bytes loses them. A start
  marker split right after `ESC` or `ESC[` with more than one batch interval between the two casts is
  typed as keys (unframed).
- **Session host and native Windows panes**: a paste answers false while another text delivery to the
  same session is in flight (agent messaging), on a host too old for `sendKeysV2`, and when the host's
  reply is lost after the paste landed. It is never retried. On every route a chunk that timed out may
  still land late; it is never retried either.
- **Read from tmux's source, not measured**: `send-keys` copies keys to the other panes of a window with
  `synchronize-panes` on, and drops input to a pane disabled with `select-pane -d` while exiting 0.
  nodeterm's conf sets neither.
- **An SSH host with tmux older than 3.1** fails the keys plan closed (every chunk dropped, the
  controller told).
- **An older cached viewer page** on a Control link cannot take control (the protocol is additive).
- **A Zellij-selected machine**: a node whose tmux session is warm but not held by this process reads
  `unsupported` until it is mounted, so a Control link cannot be created from it before then.
- **Downgrade**: a build older than this one drops Control and unlimited records on load and its next
  write removes them; their server rows stay live with no host until they expire or Stop all reaches
  them ("Unlimited links").

## Device checklist (owed — this server cannot run Electron)

From the spec:

1. Create a link on a Mac; open it in Safari on a phone.
2. Typing in the viewer does nothing (on a Viewer or Commenter link, or on a Control link before
   unlocking).
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
28. Terminal node header: the broadcast button between Comments and the eye, 22 px like its
    neighbours; disabled look + tooltip on a relay tab, in a Server Edition tab and at 5 links; hidden
    from Settings → Appearance → Terminal header buttons.
    Card modal header: the broadcast action between ✦ and the comments button; disabled look + tooltip
    (Chromium shows `title` on disabled buttons — confirm on the packaged build).
29. The create dialog: 440 px `.confirm` shell, the grouped rows, the menus, the URL row with
    Copy link/Copied!, "until HH:MM" in 12/24 h locales; a long node title ellipsizes in the head (full
    title on hover); dark + light; Liquid Glass.
30. The dialog opened from the card modal (z 70 over 55), and the UpgradeDialog opened from the card
    modal / board.
31. Palette: "Manage live links" and "Stop all live links (every machine on this license)" with the
    glyph; the Stop-all confirm after the palette closes.
32. Settings → Live links: nav glyph, rows with long titles, Copy/Stop, the Stop-all confirm over the
    Settings overlay, the pitch; the Server Edition sentence in a browser tab.
33. The sticky `not-persistent` strip after a create, visible after closing a card modal.
34. The chip popover over a zoomed canvas node, near the bottom edge (flips above), over the card modal,
    and in the hover-peek sidebar (it must stay open); under Liquid Glass (opaque, `.live-pop`).

The Control role, Unlimited links and the Live chat drawer. From the spec (§9):

35. **Mac, a shell:** create a Control link to a shell node, open it in a browser on a second
    computer, Take control with the password, type `ls` and Enter. Expect: the command runs in the
    owner's terminal, every viewer sees the output, the owner gets the "can now type" strip and, once the
    one-time notification question has been answered (whatever the agent-done preference says) and with
    the window unfocused, an OS notification.
36. **Mac, a Claude session:** the same on a Claude node: type a prompt and Enter, then press Esc while
    it works. Expect: the prompt is submitted, Esc interrupts the turn within one batch (no second key
    needed).
37. **Windows (session host), a shell and a Claude session:** items 35 and 36 on a Windows desktop.
    Expect the same; keys arrive through the session host's write.
38. **Paste, arrows, Ctrl-C:** as a controller, paste three lines into zsh (or bash 5.1+), press Up, run
    `sleep 100` and press Ctrl-C. Expect: the paste arrives as one bracketed paste (shown, not run line
    by line, until Enter), Up recalls history, Ctrl-C interrupts the sleep.
39. **`C-b s` does nothing to tmux:** as a controller, type Ctrl-B then `s` into `cat -v`. Expect: the
    pane prints `^Bs`; no session chooser opens on the owner's screen or the viewer's stream.
40. **Lock after 10 wrong passwords:** from two or more browsers, send 10 wrong passwords (each browser
    is closed after 3). Expect: the owner's sticky strip "Control of … was locked after 10 wrong
    passwords. Allow it again from the LIVE chip.", the popover shows the locked line and **Allow
    control again**, every viewer page says "Too many wrong passwords. The sharer has to allow control
    again."; the lock survives an app restart; Allow control again then lets the right password in.
41. **An unlimited link survives an app restart and stops when Pro lapses:** create an Unlimited link,
    quit and relaunch. Expect: it resumes, "No end time" in the popover and in Settings, the viewer
    page reconnects. With a test license that lapses: within a day of the lapse the chip reads
    `LIVE · refused` and a new viewer cannot join; renewing the license brings it back. The backend
    keeps the liveness answer in memory for 24 h: to shorten the wait, restart the (test) backend after
    the lapse, and the next host-token mint (≤ ~90 s) asks keygen again.
42. **The drawer on the canvas and over the board:** Open chat from a node's chip, pinned and unpinned;
    then from a kanban card modal's chip (per-project board and Omni board). Expect: on the board the
    drawer sits ABOVE the card modal, pinned and unpinned.
43. **A phone taking control:** open a Control link in Safari on an iPhone (and Chrome on Android), Take
    control. Expect: the page does not zoom when the name or password field is focused; after the grant
    it says "Tap the terminal to type.", a tap opens the keyboard, typed text reaches the pane; Release
    gives the keyboard back.

From the build:

44. **tmux 3.7b over a real install:** on a Mac using the bundled tmux 3.7b (no system tmux), repeat
    item 38, then run `od -c`, type `ç 漢 🙂 é` and an arrow key, then Enter and Ctrl-D. Expect:
    every byte exact — the arrow's ESC printed as `033`, never as the two characters `^` `[` (what
    tmux 3.7 makes of an ESC inside a paste buffer); a paste into Claude Code arrives framed.
45. **SSH delivery and latency over a real sshd and ControlMaster** (never measured here): a Control link
    on an SSH-project node, from a host about 50 ms away. Expect: bytes exact (item 38 and 39 again,
    `C-b s` inert on the HOST's tmux), keys echo within about one round trip, a 16 KiB paste arrives
    whole.
46. **An SSH host without tmux** (the plain login-shell fallback): a Control link on such a node; type.
    Expect: nothing reaches the shell, and the viewer page says "Some of your input didn't reach the
    terminal." (never silence).
47. **Windows session-host paste framing:** as a controller, paste two lines into Claude Code (which asks
    for bracketed paste) and into cmd.exe (which does not). Expect: framed for Claude Code (one paste in
    its composer, not submitted), unframed for cmd.exe; neither gets an Enter from the paste. While an
    agent message is being delivered to the same session, a paste is dropped with the "didn't reach the
    terminal" note, never typed twice.
48. **Native Windows pane paste framing:** the same as item 47 on a non-persistent (direct pty) node.
49. **IME on real browsers:** as a controller, compose text with Firefox's IME, Chrome with a Korean
    2-set layout (a fast burst), and on Android with Gboard and Samsung Keyboard (the keyCode 229
    insertText path). Expect: every composed string reaches the pane exactly once, nothing is dropped,
    and no emulator answer (`ESC[?1;2c`) ever appears in the pane.
50. **The exit chord:** while typing, press Ctrl+Shift+. (⇧⌘. on a Mac). Expect: the focus moves to
    Release and nothing reaches the pane. Repeat on AZERTY and another non-US layout (the chord is
    matched on the physical Period key, so the label may not match the key face) and with an OS or IME
    shortcut on the same keys (Windows' emoji or IME switch, macOS input source switching). Pass: on
    every layout tried, the chord moves the focus to Release and nothing reaches the pane. A layout or
    an OS/IME shortcut that takes the chord before the page (the focus stays in the terminal, or a
    character reaches the pane) is a FAIL to report, naming the layout and the shortcut.
51. **Password manager prompts on the viewer's password field:** unlock in Chrome, Safari, Firefox and
    with 1Password installed. Expect: no save prompt, or one the viewer can decline; a password saved
    for one link is never filled into another link's form unasked.
52. **Focus after "Go to terminal" from an unpinned Live chat drawer:** open the drawer unpinned, click
    Go to terminal (canvas, then a node shown on a board). Expect: the drawer closes first, the canvas
    travels to the node (or opens its card), and the next keystrokes go to that terminal, not to the
    drawer or the page.
53. **A Server Edition browser tab:** create a link there. Expect: the Server Edition sentence (no
    Upgrade button), no chip anywhere, and the palette offers "Manage live links" only (never "Live
    chat", never Stop all).
54. **A session restart keeps control:** as a controller, type `exit` so the terminal's session ends,
    then have the owner open it again (Refresh terminal). Expect: the viewer page waits, then says
    "Control resumed. Click the terminal to type." without taking the focus from the chat box; clicking
    the terminal types again without the password.
55. **The owner's narrowing controls bite at once:** while a controller types, turn Typing off, then on;
    then Change password…. Expect: on off, the viewer page says "The sharer turned typing off." and its
    in-flight keys are dropped without a disconnect; on again, Take control is offered (the password is
    needed again); on a new password, "Control ended. Take control again to type.", the old password is
    refused, the new one works.
56. **The wheel while typing:** as a controller on a tmux node, scroll the wheel over the terminal.
    Expect: nothing is typed into the pane (no history recall into the prompt).
57. **Downgrade:** with a Control link and an Unlimited link live, run a build older than this one on
    the same userData. It lists neither link. Its launch alone writes nothing (`init()` writes only when
    it pruned something), so in the older build create or Stop another link (its next write), then
    quit and start this build again. Expect: both links are gone from the file and the list; both
    server rows stay live with nobody able to join; Stop all from this build ends them.

Visual checks (Mac, default look and Liquid Glass, dark and light) — the create dialog:

58. The form is one grouped list of rows (globe, lock, clock, person icons): "Anyone with the link ·
    can watch ▾", "Expires · in 1 hour ▾", "Viewers see you as · Enes" (no box until hover/focus).
    The role and expiry menus open under their trigger, right-aligned, opaque, over the rows and the
    warnings; a check marks the current choice; hints are muted, one line each. Under Liquid Glass
    the menu stays opaque (no see-through, no blur inside the dialog). Keyboard: ArrowDown opens a
    menu, Enter picks, Escape closes only the menu (the dialog stays).
59. On a Zellij node: "can type" in the role menu is muted and cannot be picked, its hint is the
    reason. A remembered Control opens on "can watch" there.
60. Picking "can type" adds the Password row with a generated monospace password and ↻; ↻ changes it;
    clearing it disables Create; the red validation line sits under the row only once something
    invalid is typed.
61. Control shows the typing warning in a red wash with a bold "and", naming this machine ("this Mac")
    for a local node and `user@host` for an SSH-project node, for a node attached to an SSH host in a
    local project, and for a standalone ssh terminal node; the muted exposure sentence sits under it.
    A long host wraps inside its box. Check the dialog's height on a small window: Create stays
    reachable, and the expiry menu is not cut off.
62. The expiry menu's last option is "never" with "This link works until you stop it."; picking it
    makes the row read "Expires · never".
63. The done step for Control: the red status dot and "Anyone with this link and the password can
    type until …", the URL row with **Copy link**, the read-only monospace password with **Copy
    password** ("Copied!" for 1.5 s, the buttons the same width), the one note, then Stop sharing
    (red text, left) and Done. Create a second link: the dialog opens on the role and expiry of the
    first; the very first dialog after a fresh install opens on "can watch" for an hour.
The chip and the popover:

64. The unread count pill (13 px, a `--state-unread` wash, `99+` cap) on the 18 px node chip and the
    16 px sidebar chip.
65. The longer label `LIVE · 3 · 1 typing` on the node header, in a sidebar row and on a kanban card:
    truncation looks right.
66. The popover head: the role name in bold with its muted label, and the time on the right ("No end
    time" for Unlimited).
67. The actions row: Copy link · Open chat · Stop sharing fits in 340 px.
68. The Control section: the locked wash with Allow control again; the Typing row (bold "Typing", a
    muted sentence, the switch on the right); Change password…; in edit mode the monospace field with
    Generate, the validation line, the muted note, Cancel and Save; after a save the read-only field
    with Copy password, the two notes and Done.
69. Viewer rows: the 6 px typing dot before a typing viewer's name (never animated), " · can type" on a
    controller.
70. The chat thread shows on a Control link as on a Commenter link.
71. During a password save Save reads "Saving…" and an outside click or Escape does nothing until it
    settles; after 30 s with no answer, "Couldn't confirm the new password. Check the link before
    sharing it." and the popover can be closed.
72. The Typing switch while a change is in flight: not greyed, `opacity-70` and a progress cursor, and it
    keeps its focus ring.
73. A keyboard walk through Change password…: the focus lands on the new field, then on Copy password
    after a save, then back on Change password… after Done or Cancel.
74. Settings → Live links: a Control row reads `Control · N watching · No end time`.

The Live chat drawer:

75. Unpinned: the scrim and a 360 px drawer sliding in from the right; Open chat from a popover opens it,
    a scrim click and Escape close it.
76. Pinned: a 320 px floating card below the controls cluster; the canvas around it stays usable, and a
    maximized node insets for it. With no live link it is absent (stop the last link: it disappears;
    create one: it comes back docked; relaunch with the pin on and no links: no drawer).
77. Pinned beside a pinned Explorer: both cards side by side, 8 px apart, the Explorer outside; maximize
    and zone snap clear both. With a card modal open, the drawer docks at the right edge instead.
78. Raised over a card modal (per-project and Omni boards): the drawer above the modal, pinned and
    unpinned; never above Settings. Escape typed in the drawer's reply box leaves the card modal open.
79. Pinned over the board with no card modal: above the board, docked BELOW the controls cluster.
80. Liquid Glass: the blur behind the drawer, its hairline, the pinned card on a wallpaper, dark and
    light; nothing inside paints a surface token.
81. The head: "Live chat", the Pin button (accent when pinned) and the Close ×.
82. The link picker (two or more links): its native select on glass, long titles at 320 px, options made
    unique ("· shown as …", "· since 14:05", "(2)"); disabled with "Finish the password change first."
    from Save until Done after a password change.
83. The link head: bold title, muted role, **Go to terminal** on the right (accent text, underline on
    hover), and the status wash under it when the link is reconnecting, refused or viewers are waiting.
84. People: the uppercase muted heading, the Control section fitting 320 px pinned (the Typing row with
    its switch, the password edit row with Generate), viewer rows with the typing dot, bold name, muted
    "can type" / "watching", and Kick on the right. People take at most 40 % of the drawer's height and
    scroll past it (many viewers). A Viewer link's People fill the whole body.
85. The thread: one line per message — muted time, the **Sharer** badge on the owner's lines, the name
    in the viewer's colour (the same colour as on the web viewer page; on the light theme mixed toward
    the ink), the owner's own name in `--success`, a muted ": ", the text wrapping. Readable on light,
    dark and Liquid Glass. An empty thread says "No messages yet. Viewers of this link can chat with you
    here."
86. The "N new messages ↓" pill: scroll up, have a viewer post, click the pill: the list goes to the
    bottom and the pill disappears.
87. The composer: "Reply to viewers…" and Send; its error line sits above the form.
88. During a password save in the drawer, ×, Escape and the scrim do nothing until Save settles; Open
    chat on another link's chip waits until Done (or moves at once if the save failed).
89. The chip's unread count keeps rising while another app is in front, even with the drawer pinned on
    that link, and clears when the window comes back.
90. The palette: "Live chat" in section View, with the chat icon, offered only while a link is live
    (stop the last link: the entry is gone).
91. An unpinned drawer open on the last link: stop that link. Expect: the drawer stays open and says "No
    live links." (only a PINNED drawer disappears with the last link), and × still closes it.

The final review's fixes:

92. **The brake holds on a failing disk:** make `watch-links.json`'s directory read-only (or the disk
    full), then, with a controller connected, turn Typing off and Change password…. Expect: the
    controller drops back to watching at once, the old password is refused and the new one opens, and
    the surface where the change was made (the popover, or the drawer) shows "Applied, but couldn't be
    saved — it will undo when nodeterm restarts. Stop the link to end it for good." with a Stop sharing
    button that stops the link. (The notice belongs to that one surface: closing it, or opening the
    other surface, does not show it again — a known gap, see the PR's follow-ups.) Make the directory
    writable again and save any change (on any link): that write carries the narrowed state, so a
    restart now keeps typing off and the new password. The notice itself clears on the next
    successful change made from the same surface.
93. **The count survives a restart:** from a viewer, 3 wrong passwords, reconnect, 3 more, reconnect, 3
    more (9), quit nodeterm and start it again. Expect: the 10th wrong attempt locks the link.
94. **A remote-tmux node in a local project:** in a LOCAL project attach a terminal to an SSH host
    (remote tmux), share it as a Viewer link, then switch the project away so the node is not held, and
    open the link. Expect: the viewer watches the HOST's session (over the attachment's master); with the
    master down the viewer waits, and no `nt-<id>` session appears on the local `node-terminal` socket.
95. **Kick a controller:** the Kick button's tooltip on a controlling viewer (popover and drawer) and the
    popover's note under the list read "… Stop sharing to end it for everyone. They can unlock again —
    change the password or turn typing off to keep them out."; a watcher's Kick reads the first part only.
96. **The done step of a Control link:** after Create, click outside the dialog. Expect: it stays open;
    after Copy password, a click outside closes it; Escape and Done close it at any time.
97. **A paste/keys flood:** as a controller, send a cast alternating 100 one-key presses and 100 short
    pastes in under 20 ms (a script on the viewer page). Expect: the first 64 chunks land, the rest of that
    batch does not, the viewer sees "Some of your input didn't reach the terminal.", and typing right after
    works.

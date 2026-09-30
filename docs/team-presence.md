# Team presence — design

**Date:** 2026-07-12
**Status:** **Stage 1, Stage 2 and Stage 3 landed.**
**Stage 1** — the `PresenceHub` (`src/core/presence/hub.ts`), both shells joining it (Server Edition
browsers, the Electron window, cursorless relay phones), a real `window.nodeTerminal.presence` on
**both** surfaces, and the three UI surfaces: project-scoped live cursors + cursor chat
(`PresenceLayer`), the `Facepile` (off-project peers included), and per-node focused-avatar chips.
**Stage 2** — terminal co-attach (the [Terminal co-attach](#terminal-co-attach) section): one pty,
N subscribers; idempotent `pty:create`; smallest-subscriber-wins sizing; per-client backpressure with
an 8 MB drop-and-redraw ceiling; typing attribution; and the delete/recycle split.
**Stage 3** — canvas mutation sync (the [Canvas sync](#canvas-sync) section): a `canvas:mut` reflector
that stamps one total order (`seq`) and fans each mutation to every client, a diff-based publisher
with an `adopt()` loop guard and a solo gate, per-node last-write-wins in that order
(`canvas-order.ts`) so concurrent edits **converge** instead of splitting the canvas in two, an
in-place apply into the live React Flow array, a real `window.nodeTerminal.canvas` on both surfaces,
and per-project apply (including into a loaded-but-inactive project's serialized nodes). Edges and
board items now travel on the same channel, ordered by the same rules
([Edge sync](#edge-sync-bridges--ropes), [Board sync](#board-sync-kanban)); on a Server Edition
hosting a team, a shared project's content is written from these ops by the canvas authority
(`docs/hosted-team-relay.md`). What it resolves and what it does not:
[Concurrent-edit resolution](#concurrent-edit-resolution-what-converges-and-what-does-not).
Deltas between this document and what actually shipped are recorded in
[What Stage 1 changed](#what-stage-1-changed-relative-to-this-spec),
[What Stage 2 changed](#what-stage-2-changed-relative-to-this-spec) and
[What Stage 3 changed](#what-stage-3-changed-relative-to-this-spec).
**Scope:** live cursors with names, ephemeral cursor chat, per-node "who is active here",
and the terminal co-attach that makes those indicators mean something.

## Goal

Turn nodeterm from a single-operator canvas into one a small team (~5–10 people) can inhabit
at the same time: you see where your teammates' cursors are, you can say something quickly
without leaving the canvas, and you can see who is sitting in — and typing into — a given
terminal. Two people can look at the same terminal at the same time.

This is deliberately a *presence* feature, not a permissions feature. Identity is weak,
there is no locking, and there are no roles. See Non-goals.

## Constraints discovered in the codebase

Three facts shaped every decision below:

1. **There is no notion of a user anywhere.** Server Edition auth is a single shared
   password (scrypt) with anonymous session tokens (`src/server/auth.ts`); the license layer
   identifies a *device*, not a human (`src/core/license.ts`). Identity is invented from scratch.
2. **Multi-client transport already exists.** `ServerPlatform.sinks` is a real client registry
   (`src/server/platform-server.ts:104`) and `broadcast()` (`:96`) already fans out
   `agent:status` and friends to every connected client. Presence needs no new transport.
3. **Terminals are not shareable today.** PTY output is unicast to the creating client
   (`Session.webContentsId`, `src/core/pty-manager.ts:251`, flushed at `:780`), and a second
   client attaching to the same node runs `tmux -A -D` (`:668`) — the `-D` *detaches the other
   client*. Two browsers on one node fight, and output follows whoever attached last.

## Architecture

### PresenceHub lives in core, not in a shell

New `src/core/presence/hub.ts`: a pure `PresenceHub` holding `Map<clientId, PeerState>`,
applying events and emitting diffs. No electron, no `ws`, no disk. **Presence is never
persisted** — it is as transient as the live half of `agentStatus`.

Both shells feed the same hub through the same interface:

- **Server Edition** — `ServerPlatform.attach()/detach()` (`platform-server.ts:104`) is already
  the client registry; `hub.join(uiId)` / `hub.leave(uiId)` hook in there, and fan-out uses the
  existing `broadcast()`.
- **Relay / desktop host** — a `HostSession` connecting calls the same `hub.join()`.
  `host-canvas-hub` already mirrors canvas state to N clients via its `subs` set; presence
  rides the same path.

One hub, two adapters — not two implementations.

### Identity: lightweight, unverified, deliberate

Auth is untouched (one shared password stays). On first connect the browser asks for a name;
`{name, color}` is kept in `localStorage` under `nodeterm.presence.me`, with a color
auto-assigned from a palette and user-changeable. The client announces itself with
`presence:hello {name, color}`; the server assigns a `clientId` (the existing `uiId`).

The server does not verify names. Anyone can claim to be anyone. This is sufficient for "who
is typing in this shell" and insufficient for audit or permissions — an accepted, documented
trade-off. Two tabs from one person show as two peers (as in Figma).

### Presence is scoped to a project

A project *is* a canvas, with its own node set and its own flow coordinate space. A peer's
cursor, chat bubble and node chips are therefore rendered **only for peers on the same
project** (`PeerState.projectId`, filtered through the single pure selector
`peersOnProject(peers, projectId)`). Without that filter, a teammate looking at project "api"
while you look at "web" would have their cursor drawn on your canvas at meaningless
coordinates.

The facepile deliberately does *not* filter: off-project peers appear dimmed, labelled with the
project they are in, and clicking one switches you to that project and centers on their focused
node. What would have been a bug becomes the "who is working where" view.

### Peers may have no cursor

`PeerState = { clientId, name, color, cursor: {x,y} | null, focus: nodeId | null, chat: string | null }`

**`cursor`, `focus` and `chat` are three independent signals**, and a cursorless peer is a
first-class citizen — not a peer with a fabricated position. The mobile companion has no
mouse; modelling presence as "everyone has an x/y" would have forced it to either invent a
cursor or vanish. Every UI surface degrades per signal.

### Wire protocol

New `presence:*` channels in `src/shared/ipc.ts`. The server is a dumb reflector: it holds the
peer table and fans out, and applies no policy.

| Direction | Channel | Payload |
|---|---|---|
| client→server (`cast`) | `presence:hello` | `{name, color}` |
| client→server | `presence:cursor` | `{x, y}` — **flow coordinates**, sampled on rAF, throttled to ~20 Hz |
| client→server | `presence:focus` | `{nodeId \| null}` |
| client→server | `presence:chat` | `{text \| null}` — live per-keystroke; `null` closes |
| client→server | `presence:project` | `{projectId \| null}` — which canvas we are looking at |
| server→clients (`ev`) | `presence:sync` | full snapshot on join |
| server→clients | `presence:peer` | single-peer diff (join / update / leave) |

Cursors travel in **flow coordinates** (`screenToFlowPosition`), never screen coordinates, so a
cursor lands on the correct node regardless of each viewer's zoom and pan. A `presence:project`
also **clears the cursor**: it belonged to the old canvas, and a keyboard-driven project switch
sends no new sample.

"Dumb reflector" is about *policy*, not about trust: everything the hub takes from one client it
fans out to all of them, so the ingest side is hardened. Every string off the wire goes through the
one truncation rule (`capCodePoints`: chat 200, name 32 — control/bidi characters stripped —
focus/project ids 128 code points), and every cast is rate-limited per (client, channel) by a token
bucket (`PRESENCE_RATE_BUDGETS`; the cursor budget is exactly the renderer's own 20 Hz, so an honest
client never loses a sample — excess is dropped silently, never disconnected). The Server Edition
socket additionally caps a single frame at `WS_MAX_PAYLOAD` (8 MiB), well above the largest
legitimate one (an `fs:write` of an editor file).

## Terminal co-attach

The enabling change: two people must be able to watch one terminal.

**One PTY, N subscribers** — *not* "drop tmux's `-D`". When a second client calls `pty.create`
with a live `persistKey`, we do not spawn a second tmux client; we subscribe it to the existing
`Session`. The app therefore still has exactly one tmux client per session, `-D` stays as it is,
and tmux's multi-client size negotiation never engages. The relay path already does exactly this
(`attachDetached`, `src/core/pty-manager.ts:485`) — we generalize that mechanism rather than
inventing a second one.

Changes:

1. **`Session.webContentsId: number | null` → `subscribers: Set<ClientId>`**
   (`pty-manager.ts:251`). `flush()` (`:780`) fans out to the subscriber set instead of
   unicasting. The relay's `onData`/`onExit` sinks are **not** in that set (they have no
   `ClientId`): a detached, relay-served pty keeps its own session and is deliberately left out of
   `subscribers` *and* out of the `byPersistKey` co-attach index, so the relay path is bit-for-bit
   what it was. `flush()` calls the sink and then fans out to the subscribers — two paths, kept
   apart on purpose.
2. **`pty:create` becomes idempotent.** A live session for that `persistKey` means subscribe +
   return `fresh:false` rather than spawn. Cold-restore and scrollback replay already branch on
   `fresh`, so they keep working.
3. **Size: smallest subscriber wins.** Two browsers at different zoom/DPI compute different
   cols/rows and would corrupt each other's rendering — the classic shared-terminal problem.
   PtyManager tracks each subscriber's requested size, sets the effective size to
   **min(cols) × min(rows)**, and broadcasts the authoritative size on `pty:size:<sessionId>`.
   Each xterm calls `term.resize()` from that broadcast instead of from its own `fit()`, and
   letterboxes the remainder. With one subscriber, `min` of one element is your own size — the
   **single-user path stays bit-for-bit identical to today**.
4. **Backpressure becomes per-client.** Today `paused` is keyed by session
   (`platform-server.ts:39`) and `detach()` clears the *entire* map on any disconnect — a bug
   already confessed in a "v1 is single-UI" comment (`:110`). Left alone, one slow phone would
   stall everyone's output. Rekey to `(clientId, sessionId)`; detach clears only that client's
   entries. The shared PTY is paused only when *every* client of that session is over
   high-water, so the slowest link no longer sets the pace for the team.

   That alone would let a slow client's send buffer grow without bound, so it is capped:
   at `WS_DROP_WATER` (8 MB buffered on one client's socket) we **drop that client's
   queued output** rather than pause the others, and when its buffer drains we **resynchronise
   it by redrawing the current screen from tmux** (reusing the existing `capture-pane` path)
   with a "reconnected — earlier output skipped" separator. For a terminal the current screen
   is what matters, not the 8 MB of scrollback a bad link missed; tmux is the authoritative
   source of that screen.

   Three properties of that ceiling, stated honestly:
   - **The bound is per SOCKET, not per session.** `bufferedAmount` is `ws.bufferedAmount` — one
     number for the whole connection, which is where the bytes actually sit. So a client that
     floods past the ceiling on one session desyncs on *every* session it is watching (each on its
     next chunk). Other **viewers** of those sessions are untouched — they have their own sockets.
   - **Recovery is per `(client, session)`:** the desync state is keyed that way, so each session
     gets its own capture and its own redraw.
   - **The drain is the trigger, not the next chunk.** The common case is a flood that *ends*
     (`npm run build` finishes; the socket drains; no further output ever arrives). A redraw hung
     off the next chunk would never fire, leaving the user on a screen truncated mid-flood. A
     250 ms sweep — armed on desync, cleared when the desynced set empties, so the healthy path
     pays nothing — watches the socket and redraws once it is back under the low-water mark.
   - **An empty capture is never sent.** `captureForResync` returns `''` on any tmux/ssh failure,
     and the renderer's resync handler resets the terminal; sending `''` would blank a live
     terminal. An empty/failed capture keeps the client desynced and is retried with backoff
     (250 ms → 10 s cap). `pty:resync` payloads are therefore guaranteed non-empty.

### Painting the joiner

A joining client gets `fresh:false`, which is what tells the renderer *not* to replay the persisted
scrollback (tmux is live; a replay would duplicate it). But co-attach adds **no tmux client** — the
session already has one — so nothing redraws for the joiner either, *unless* the join happens to
resize the pty: tmux repaints on SIGWINCH, and only a joiner strictly **smaller** than the current
grid causes one. **Equal is the expected case** (both clients render the node's persisted geometry
with the same font; canvas zoom is a CSS transform and does not change `clientWidth`), and equal or
larger resizes nothing. Left alone, the headline path of the feature — open the same terminal in a
second client — lands on a **blank but live** terminal until the next byte of output, nondeterministically
(a ±1-cell measurement difference between two machines silently hides the bug).

So a join that did **not** resize the pty carries the session's **current screen** on
`PtyCreateResult.screen`, captured with the same `captureForResync` (`tmux capture-pane -e`) the
drop-and-redraw path uses; the renderer writes it into its empty xterm before the live stream starts.
Three rules:

- It rides the **create result**, not a `pty:resync` event: the renderer only subscribes to a
  session's channels *after* `create()` resolves, so an event pushed at join time would land on no
  listener.
- A join that **did** resize gets nothing — tmux is already painting it, and two paints would splice
  two different points in time onto one screen.
- An **empty capture is omitted**, never sent as `''` (same contract as `pty:resync`). A solo user
  never reaches this path at all: a fresh spawn has nothing to paint, and a warm reattach starts a
  tmux client, which redraws by itself.

**`screen` is the joiner's paint — and the ONLY thing a warm attach seeds.** There was briefly a
second source: a `warm-history` seed that hydrated every `fresh:false` attach from tmux's own
scrollback (`transport.captureHistory`). That whole hydration is **gone** — tmux owns the mouse and
the scrollback again (see CLAUDE.md, "Terminal session continuity"), so it redraws the pane and its
history is scrollable in place; hydrating on top of a screen *painter* is what produced the black
bands and duplicated screens. A solo warm reattach therefore seeds **nothing**, and `seedPaint`'s
`create-screen` — this capture — is the one seed a `warm-attach` can still yield, for the one client
tmux does not repaint: a joiner that did not resize.

**A `pty:resync` supersedes the seed, and the queue behind it.** `main`'s attach path subscribes to
`pty:data` *before* awaiting its seed and holds the chunks in a `createDataGate`. A resync that lands
during that window is a redraw of the CURRENT screen, so everything the gate is holding *predates*
it: draining the queue would splice the stale flood back over the fresh screen, and the in-flight
history seed would then write an even older screen on top of that. The resync handler therefore
`gate.reset()`s (drops the queue, returning its bytes to the flow-control accounting, and switches to
pass-through) and marks the seed **superseded**, so the seed writes nothing when its capture returns.
Everything that arrives after the capture streams straight through, in order.

Two details that are easy to get wrong, and are pinned by tests in `terminal-config.test.ts`:

- **Superseded means "paint nothing", never "return".** The seed lives inside the spawn continuation,
  which still has to wire `onExit`, `term.onData` (**the keyboard input path**) and the
  `initialCommand` / cold-start agent resume *below* it. Returning early there yields a terminal that
  streams output and looks perfectly alive while silently accepting no input, forever. The decision
  is a pure helper — `seedPaint()` — whose result type has no abort member for exactly that reason.
- **The repaint's `reset()` is sequenced behind a write callback** (`repaintResync()`): `term.write()`
  is parsed asynchronously while `reset()` clears the buffer immediately, so an inline reset landing
  between the seed's (up to a megabyte of) history writes and xterm parsing them would clear an
  almost-empty buffer, let the stale history paint onto the cleared screen, and append the fresh
  capture *below* it.

### Typing attribution — and why it is server-side

`cast()` used to discard the sender (`void uiId`). `pty:write` is routed through the sender-aware
seam (`onWithSender`) instead, so the handler knows WHO typed: it calls `presenceHub.noteTyping(
clientId, session.nodeId)` directly — there is no `lastWriter` field on the session, because nothing
would read one (the badge is peer state, and it lives in the hub's peer table, not on the pty). The
hub throttles the broadcast to 1/500 ms per (client, node); the badge decays after ~2 s. `write`
skips the call entirely when there is only one peer, so a solo keystroke burst costs nothing.

A write is only accepted from a **subscriber** of that session (session ids are guessable), and the
same membership check gates `pty:resize` / `pty:flow` / `pty:kill` — everything in a session's
`pausedBy` / `sizes` therefore belongs to a client that is actually watching it, which is what makes
`dropClient` a complete cleanup.

Attribution is done **on the server rather than by client self-declaration** specifically
because of mobile: when the phone writes over the relay, the sender is already known as a
`HostSession`. So *typing from the phone lights up the "Enes is typing" badge on someone's
desktop canvas without a single line of Swift.*

### No locking (v1)

Two people can type into one shell simultaneously; both badges pulse and the characters
interleave in the single tmux session. This is accepted, not overlooked — it is the behavior
every tmux pair-programmer already knows, and the badge *is* the warning. Locking / handoff is
v2.

If a node is deleted while others are attached, `destroy(persistKey)` kills the tmux session and
the remaining subscribers enter a "closed by <name>" state rather than respawning it.

### Deletion vs recycling

Killing a node's tmux session is used for two opposite intents, and PtyManager keeps them apart:

- **Deletion** (× / delete node) → `destroy(persistKey)`. The node leaves the canvas. Co-viewers get
  `pty:closed:<sid> { by }` and must never respawn it — a respawn would resurrect a terminal its
  owner deliberately killed, in a fresh shell, and strand a tmux session.
- **Recycling** ("move into worktree") → `recycle(persistKey)`. Same `tmux kill-session` (otherwise
  `new-session -A` would just reattach the old working directory), but the node **stays** on every
  canvas and keeps working. Co-viewers get `pty:recycled:<sid> { ready }`: restart the terminal,
  the node moved. Their re-create **co-attaches** to the replacement session, so they follow the node
  into its new cwd and are never left holding the dead pty.

The recycled notice is **withheld until the replacement session is registered** (`ready:true`). Sent
any earlier, a co-viewer's restart could beat the mover's own `create()` and spawn `nt-<nodeId>` from
*its* options — i.e. in the node's stale cwd — silently undoing the move for everyone.

A recycler can die between the `kill-session` and its own `create()` (app quit / crash), so a 10 s
timeout releases the co-viewers anyway — with **`ready:false`**, which means *do not respawn*. This
is the one case where restarting is worse than not: a co-viewer's create options still carry the
node's **old cwd** (a cwd change is not broadcast on this branch), so its spawn would put
`nt-<nodeId>` back in the stale folder — and when the mover's app returns, its own `new-session -A`
**reattaches** that session (the cwd option is ignored on attach), so *everyone's* node would claim
the worktree path while the shell sits in the old directory. Silent, and exactly what the withheld
notice exists to prevent. So the terminal shows **"session ended — reopen to restart"** instead: the
move can be lost only by an explicit user click, never by a timeout.

### The respawn guard — and the tombstone that backs it

`pty:closed` only reaches a session's **subscribers**. A co-viewer whose project is *inactive or
closed* has no mounted terminal, so it is not one — yet the node is still on its canvas. Its next
`create` for that node (opening the project later) would find no session, fail `tmux has-session`,
and spawn a brand-new one: the deleted terminal, resurrected as a fresh shell.

`PtyManager.tombstones` closes that: a destroyed `persistKey` is remembered, and a later `create`
for it by **another** client is refused (`PtyCreateResult.closed = { by }`) instead of spawning —
the renderer lands in the same "closed by <name>" state. The destroying client is **exempt**, so its
own ⌘Z (undo of a delete) still restores the node, and the single-user path is untouched. A
`recycle` clears the tombstone (nothing was deleted).

Its limits are real (see Known risks): the tombstone is in-memory, so it lives exactly as long as
the core process. Stage 3's canvas-delete **mutation** is the structural fix — it removes the node
from every *attached* client's canvas, so nobody is left holding one to re-create. It did **not**
make the tombstone removable: the mutation covers the clients that were attached at the moment of
the delete, and the paths it does not cover still need the respawn guard. See
[What Stage 3 changed](#what-stage-3-changed-relative-to-this-spec) for the exact list.

The map is also **bounded in size and time** (`TOMBSTONE_MAX` / `TOMBSTONE_TTL_MS`, an LRU), and the
`pty:destroy` / `pty:recycle` casts are **length-capped** (`REF_MAX_LEN`, like every other
client-supplied reference) and **rate-limited** per client (`PTY_END_BUDGET`). They have to be: the
key comes verbatim off the wire, a tombstone is recorded even when no live session exists, and each
call costs an `fs.rm` plus a `tmux kill-session` subprocess. The burst is sized well past a bulk
delete (one cast per node in a single tick), so it can never fail a real user; eviction degrades to
the pre-tombstone behavior, never to something worse.

## Canvas sync

Node edits broadcast as mutations so cursors don't hover over stale geometry.

The vocabulary already exists — `CanvasMutation = {op:'upsert', node} | {op:'remove', id}`
(`src/shared/types.ts:119`) — and so does the receiving end: `applyCanvasMutation`
(`Canvas.tsx:917`), written for the relay. We add only the emitting side: `handleNodesChange`
publishes a mutation (position-only, throttled to 20 Hz, while dragging; a full upsert on
settle; an upsert on add / remove / color / title / collapse), and the server reflects it to
every client except the sender.

Convergence makes persistence safe for free: because all clients that saw the whole exchange
converge on the same node set, whichever of them calls `workspace.save` writes the same canvas,
which defuses today's last-writer-wins save. The exceptions (a client that loaded after a delete,
board bytes in two cases) are in the
[does-not-converge list](#concurrent-edit-resolution-what-converges-and-what-does-not). The existing rev-based conflict bar (`workspace-watcher`) stays as the
backstop. On a Server Edition hosting a team, a shared project's content does not come from these
saves at all: the canvas authority overlays each one with the content it applied from ops
(`docs/hosted-team-relay.md`).

Two things are deliberately **not** synced: ephemeral nodes (subagent / loop cards) are derived
independently on each client from the already-broadcast `agent:status` stream; and undo stays
**local per user** — you can in principle undo someone else's change (last-write-wins). No CRDT.

**Implemented (Stage 3).** `CanvasMutation` now travels on `canvas:mut` (`src/shared/ipc.ts`):

- **Publisher** (`src/shared/canvas-publish.ts`) — the renderer diffs each settled node snapshot
  against the last one it published (`diffToMutations`), so edits that never pass through
  `onNodesChange` (a rename, a color pick, a collapse, a direct `setNodes`) sync too. Position frames
  are throttled to ~20 Hz while dragging and flushed on drag-stop; everything else is a full upsert.
  Ephemeral subagent/loop cards are filtered out (`publishableStates`). Every mutation is stamped
  with `src`, this Canvas's publisher tag.
- **Solo gate** — `shouldPublish` (fed by the presence peer table, read through a ref so it can never
  re-render Canvas). With nobody else attached, `publish()` degrades to `adopt()`: it takes the
  snapshot as the baseline and does **no** diff, no `stableStringify` of every node, no IPC cast. A
  solo user pays nothing for team sync, and because the baseline still tracks the canvas, the first
  edit after a peer joins diffs correctly — no resync step, no missed mutation. **The exception is a
  governed project** (`shouldPublishCanvas`: peers OR governed). A canvas authority writes a project
  only from the ops it hears, so an edit the solo gate swallowed there would be erased by the next
  overlaid save. A Server Edition tab asks its core which projects are governed (`canvas:authority`),
  publishes for every project until the first answer, and asks again on reconnect; the desktop
  answers none, so its gate is unchanged. Only a cast from ANOTHER client proves a peer
  (`provesPeer`): our own echo and a core-published op (no `src`) do not.
- **Reflector** (`src/core/canvas-sync.ts`) — holds no canvas state and persists nothing, but it is
  **not** stateless: it stamps every mutation with a monotone **`seq`** and sends it to **every**
  attached client, the sender included (`CorePlatform.clientIds()` + `onWithSender`). `seq` is
  server-authoritative (a client-supplied one is overwritten at ingest).
- **Ordering** (`src/shared/canvas-order.ts`) — the client half, and the reason concurrent edits
  converge instead of splitting the canvas in two. Per node, the highest `seq` wins. Three rules: (1)
  our own echo is an **ack**, not an edit — it carries the `seq` our mutation was given, and is never
  re-applied (re-applying it would rubber-band a node we are still dragging); (2) while one of our
  own mutations for a node is unacked, we ignore peers' mutations for that node — FIFO delivery means
  ours is necessarily *later* in the total order, so it will win on every other client too; (3) rule
  1 is only sound **while our optimistic value is still on our canvas**. Rule 2's suppression is
  bounded by `PENDING_TTL_MS` (an ack can be late — the same socket carries pty output, and Stage 2
  tolerates an 8 MB backlog on it), and once it lapses a peer's mutation can overwrite the value we
  are still waiting to have acked. From that moment our echo is the **only** copy of a value that
  already won on every other client, so it is **applied** (a repair), not dropped. Without rule 3 a
  late ack left that client permanently on the losing value — and its whole-file `workspace.save`
  then wrote those losing bytes over everyone else's canvas, which is precisely the property this
  stage exists to guarantee. The pending entry's `since` is refreshed on every local mutation for
  that node, so a drag longer than the TTL cannot expire its own suppression mid-drag.
  `order.reset()` is called whenever our presence clientId changes (i.e. on every (re)connect): if
  the core restarted, its `seq` restarted at 0 while our `seen` map still held high values, and we
  would silently drop every new mutation as a straggler. Correctness no longer depends on the
  ws-bridge's `location.reload()`. The reset keeps one thing: our own causal position (`lastSeq`,
  what rule 4's `seen` stamps). A reconnect to the SAME core also resets, and a first cast stamped
  `seen: 0` there — ⌘Z of a node deleted before the drop — was a stale frame to every peer holding
  the tombstone. After a real restart the kept value is above every new `seq`, so our casts read as
  "never stale": the pre-rule-4 verdict, not a split. That window is bounded: the first stamped `seq`
  heard after a reset re-bases the position when it is at or below it (the core restarted and its
  counter began again), and leaves it alone when it is above it (the same core carried on). (The
  reflector clamps it to `seq - 1`, which changes no verdict here; see the note on the clamp under
  rule 4.)
- **A cast the reflector would refuse is never made** — the publisher validates with the **same**
  predicate the reflector's ingest uses (`isCanvasMutation`, moved to `src/shared/canvas-mutations.ts`
  so both ends share one verdict) *before* recording a pending entry and *before* casting. A refusal
  therefore costs neither a pending entry (which would have deafened that node to its peers for the
  whole TTL — a peer's `remove` landing in that window was dropped and never recovered, so the next
  whole-file save resurrected the node they deleted) nor the retry: the refused node keeps its
  **previous baseline entry**, so the very next publish re-emits it and it syncs the moment it becomes
  castable. The only thing that can legitimately exceed `MUTATION_MAX_BYTES` is free text — a sticky
  someone pasted a document into — so Canvas **tells the user** ("This note is too large to share with
  your teammates (over 250 KB)… they will not see it until you shorten it") instead of leaving them
  with a note the team silently never receives.
- **Loop guard** — a mutation applied from a peer is `adopt()`ed into the publisher's baseline before
  the next diff runs, so it can never be re-published (no A→B→C→A ping-pong).
- **Apply** — the vocabulary is single-sourced in `src/shared/canvas-mutations.ts` and used by both
  ends. In the renderer, an incoming mutation is patched into the **live React Flow array**
  (`applyMutationToFlow`, `src/renderer/state/workspace.ts`) — never round-tripped through the
  (lossy) serializers, which would wipe your selection, delete your relay-remote nodes and re-render
  every node component on every peer mutation. `window.nodeTerminal.canvas` is real on the preload
  **and** the ws-bridge.
- **Undo is rebased, not clobbered** — a peer's mutation is applied to the undo baseline
  (`committedRef`) rather than replacing it, so a local edit still inside the 300 ms undo debounce
  survives a peer's mutation landing on top of it.

## Edge sync (bridges + ropes)

Stage 3 addressed **nodes**. Edges — `bridges` (context links, which an agent actually reads
through) and `ropes` (display-only "spawned by" lineage) — were left out, and that was the worst
gap the stage shipped with, because they are **persisted in the same whole-file `workspace.save`**.
An edge you drew never reached your teammate, and their next save — of a canvas that never had it —
**deleted it**. Same in reverse.

They are in the vocabulary now, and everything around them is the node machinery unchanged:

- **Vocabulary** — `CanvasMutation` gains `edge-upsert` / `edge-remove`, each carrying a
  `kind: 'bridge' | 'rope'` (which persisted list to write) and the edge's three ids. **Only the ids
  travel.** A rope's colour and its waiting look are derived at render time from each client's own
  nodes (`displayEdges` / `ropeVisual`), so sending them would ship one client's palette to another.
- **Ordering** — the same `CanvasOrder`, keyed by `mutationKey`: `n:<id>` for nodes, `e:<id>` for
  edges, one key space with a prefix (a node id and an edge id are generated independently and could
  collide). The `kind` is deliberately **not** in the key: one id is one edge, and a bridge and a
  rope claiming the same id must be resolved to one thing rather than held as two. Rule 4 (the
  causal delete) therefore covers an edge exactly as it covers a node. The apply and the diff agree:
  `applyEdgeMutationToScene` takes an upserted id out of the other list and a remove drops it from
  both, and `diffToMutations` casts no remove for an id that only moved between the lists (a trailing
  remove would delete it from both).
- **Publisher** — the snapshot became a `CanvasScene` (`{nodes, bridges, ropes}`), so one diff, one
  throttle and one baseline cover both. The Canvas publish effect has the edge arrays in its deps:
  drawing a link never touches `nodes`, so without that the edit would never be published. React
  Flow rebuilds those arrays on a mere **selection** change too — that costs one diff yielding no
  mutation (the diff compares id/source/target only), and the solo gate means a solo user does not
  pay even that.
- **Batch order is load-bearing.** A peer applies mutations one at a time, so `diffToMutations`
  emits **node adds → edge adds → edge removes → node removes**: an edge naming a node that has not
  arrived yet would draw into nothing, and an edge whose node dies in the same batch has to be
  removed while it is still there.
- **Ephemeral endpoints are filtered** (`publishableScene`). An edge naming a subagent / loop card
  addresses a node the peer derives itself, with its own lifetime — it would be pruned there at a
  moment we do not control and re-published back at us.
- **Background projects** get `useProjects.applyEdgeMutation`, for the same reason nodes do: that
  project's serialized edges are what our next whole-file save writes.
- **The snapshot thunk captures the edge arrays when it is CREATED** (`publishableLater`). The
  publisher keeps an `adopt` baseline unresolved until the next publish, so a thunk that read the
  edge refs when it RAN saw the link the user had drawn since the last peer op or project load: the
  diff was empty, nothing was cast, and the teammate's next save deleted the link. Only the `.map`
  is deferred (React state arrays are never mutated in place), so the solo gate still skips the cost.
- **The edge refs move synchronously** with their setters on a project load and a server change,
  and the render-time mirror copies the state only when it CHANGED. A zustand write re-renders on
  the SyncLane and skips the pending DefaultLane setter (see `nodesEpoch.ts`), so an unconditional
  mirror put the previous project's edges back into the ref — and a peer's edge op arriving before
  the next render was applied to them and overwrote the load.
- **An edge whose endpoint the peer does not have is held, not cast.** A node the size guard refuses
  (an oversized sticky) never reaches the peer; an edge to it that did would be pruned there, and the
  peer's `edge-remove` would delete the link on our canvas too. The publisher holds such an
  `edge-upsert` inside the emit that refused the node (and on every later emit while the node's last
  cast stays refused — `refusedNodeIds()`), keeps it owed, and casts it in the same batch as the node,
  after it, on the first emit in which the node goes through. That holds across a peer's op too: the
  adopt that applies it takes the scene on screen, which already contains the refused node and the
  held edge, so the adopted baseline keeps the PREVIOUS baseline's entry for an owed node that scene
  still holds and for every edge in it touching one (`adoptBaseline`) — otherwise the node would
  re-diff only when it next changed, and the edge would never differ from the baseline again and
  never be cast. Only what the adopted scene still holds: one publisher serves every local project,
  so a project switch adopts ANOTHER project's scene, and re-emitting an owed node it lacks would
  cast a `remove` of the old project's node under the new project's id (and a peer's delete, which
  also arrives as an adopt, would be echoed back). The hold is in the publisher, not a filter on the
  scene: dropping an edge the baseline already holds would diff as an `edge-remove` — the same
  delete, cast by us. It is conservative: an edge to a node whose EARLIER version the peer has also
  waits. What it does not cover: (1) a baseline taken while the solo gate is closed (`shouldPublish`
  false) is not rebased, so an owed item swallowed there syncs only when it next changes — the gate
  closes on an open publisher only when a hosted role drops to read-only; (2) a round trip to
  another project (A → B → A), which in practice is almost ANY visit to B: an emit keeps owed only
  the nodes of the scene it diffs, and the publisher emits on every change to B's `nodes` state
  (React Flow's own measure and selection updates included, not only an edit), so the owed A node is
  forgotten there; the load that returns to A adopts A's whole scene, so a held edge is not cast
  after the node is trimmed until the edge itself changes; (3) a `remove` that was itself refused (no
  active project) and then adopted over is not retried. None of the three is a regression — the
  publisher behaved the same way before holds existed.
- **"This note is too large" is said only for a node upsert.** An edge op is refused only for a
  malformed or over-long id, so the sentence would name a cause nobody measured; the refusal is
  logged instead.

What this does **not** change: an edge is still pruned locally when an endpoint disappears, so a
peer's node delete can leave one drawn against nothing for a tick (see Known risks). Also still
open: a peer edge op applied in the same task as a local functional edge update overwrites that
update (the node path no longer does: its receive `setNodes` is functional, `rebaseOnLatest`); a
local node delete publishes its `remove` first and the
pruned edges' `edge-remove`s one render later, and every peer prunes the same dangling edge itself
(converges, with redundant casts); canvas-control writes into a project that is not on screen are
not cast as edge ops. The Server Edition's headless canvas control is cast now: it diffs every
project's whole content (nodes, edges, board) against what it last loaded or saved, and casts every
op before it saves (`castAndSave`, `src/server/headless-node-factory.ts`).

## Board sync (kanban)

The board (`project.kanban`) had the edges' problem: `canvas:mut` carried no board item, and the
board rode every whole-file save, so a teammate's card move never reached you and your next save
wrote your board over theirs. Board items are in the vocabulary now, one op per item
(`src/shared/kanban-ops.ts`), under a third key prefix:

| Item | Ops | Order key |
|---|---|---|
| Column | `kb-column` / `kb-column-remove` | `k:col:<id>` |
| Column order | `kb-column-order` | `k:colorder:<projectId>` |
| Card placement | `kb-card` / `kb-card-remove` | `k:card:<nodeId>` |
| Card metadata | `kb-meta` / `kb-meta-remove` | `k:meta:<nodeId>` |
| Label | `kb-label` / `kb-label-remove` | `k:label:<id>` |
| Label order | `kb-label-order` | `k:labelorder:<projectId>` |
| Saved view | `kb-view` / `kb-view-remove` | `k:view:<id>` |

- **Last writer wins per ITEM, not per board.** The node rules are unchanged: per key, the highest
  `seq` wins. Two people moving two different cards at once both land; two moves of the same card
  end on the later-ordered one. A card's placement and metadata key by its node id under their own
  sub-prefix, so a card move is not a node edit, and deleting a node does not tombstone its card.
- **The two order keys carry the project.** Each is a per-project singleton, and one `CanvasOrder`
  orders every loaded project: unscoped, our unacked reorder in one project held off (rule 2) a
  teammate's reorder in another.
- **Rule 4 is for deletions only.** `kb-column-remove`, `kb-label-remove` and `kb-view-remove` mean
  "this item is gone" and tombstone their key, exactly like `remove` and `edge-remove`.
  `kb-card-remove` ("back to Ungrouped") and `kb-meta-remove` ("no metadata") are VALUES and order
  like any other write (`isKanbanDeletion`): a card taken off the board and filed again is not a
  resurrection, and a tombstone would drop a teammate's concurrent move as a stale frame.
- **Order ops are cast on additions too.** An item op only says the item exists, and a peer that
  applies it alone appends it. So the publisher also casts the list's order op whenever the list
  gained an id or the relative order of the ids both sides share changed (`orderChanged`), and every
  replica lands on the later order op's list. An order op lists only the ids its sender knew, so
  ids other clients added in the same window are not in it: `reorder` puts those after the listed
  ones SORTED BY ID, and the op's own sender applies the echo of its last order op for that list
  instead of dropping it as an ack (`CanvasOrder.accept`). Without both, three concurrent adds
  converged in only 30 of the 90 reflector interleavings; with them, all do
  (`kanban-ops.convergence.test.ts` enumerates every interleaving for three clients).
- **Names are repaired, not refused.** A column title, label name or assignee name is trimmed,
  stripped of control and bidi-override characters and cut to its bound (`displayText`); only an
  empty result is refused. The UI puts no length cap on them, so a refusal would be a rename that
  silently never syncs. Ids are refused, never repaired. The sender casts the repaired form and keeps
  it locally too, because its own echo is only an ack (`renderer/canvas/kanban-sync.ts`).
- **Default columns are deterministic.** A project with no `kanban` block renders a lazy default
  board that is not written until the first edit, and with live sync two people can make that edit
  at once. Its column ids are a hash of the project id and the column's index (`seededColumnId`,
  `defaultKanbanFor` in `src/shared/kanban-default-board.ts`): the same on every client, so the two
  first edits land on the same three columns instead of six. A board created explicitly (the core's
  `ensureProjectBoard`, the phone's first board) keeps random ids.
- **The publisher hangs off the one store funnel.** Every board write goes through
  `useProjects.setProjectKanban`, whose hook diffs the board item by item and casts through the same
  send and the same publish gate as nodes: the board, the card modal, the Omni board, node labels and
  the `assign` verb all publish without a call site of their own. A peer's board op is applied
  through the store reducer (`applyCanvasOp`), never through `setProjectKanban`, so nothing received
  is published again, and it writes no board-log entry: only the client that made a change records
  it. The entries a board change writes go through the project's own session (a relay tab's to its
  host).
- **Prune removals are never cast.** Every board commit prunes the cards of nodes that are not live
  locally. A teammate whose node op has not arrived yet would otherwise cast the removal of a fresh
  card for everyone, so `diffKanbanOps` casts a card or metadata removal only for a node live in that
  project: React Flow's nodes for the project it holds, the stored nodes for any other. While the Omni
  board is open, React Flow ∩ the stored copy (`boardLiveNodeIds`): its lanes prune against the stored
  copy, which lags React Flow for the rendered project, and a smaller live set can only cast fewer
  removals. The cost: removing, on the Omni board, the card of a node created moments ago is not cast.
- **A board edit is cast only to the active tab's core** (`castFor`), as a node edit is: the order
  hears one core's echoes. A board edit to a lane on another core (the Omni board editing a relay
  lane while a local tab is active, or the reverse) is not cast.

## UI

`PresenceLayer` renders inside React Flow's `<ViewportPortal>`, so cursors sit in flow
coordinates and the CSS transform handles zoom/pan. Peers live in a transient zustand store
(`src/renderer/state/presence.ts`, never persisted) that **only `PresenceLayer` subscribes to** —
following the existing `viewportRef` + rAF pattern (`Canvas.tsx:162`). If cursor traffic were to
re-render `Canvas`, every mouse move would redraw a 4000-line component.

- **Cursor** — arrow in the peer's color with a name label. Incoming positions arrive at 20 Hz
  and are lerped between frames. Your own cursor is never drawn.
- **Cursor chat** — `/` opens an input beside your cursor, broadcasts on every keystroke, and
  fades ~5 s after Enter/Esc. **Gotcha:** `/` must not open chat while you are typing in a
  terminal — the key only fires when the event target is the canvas pane, not xterm / Monaco /
  an input, matching the command palette's existing guard.
- **Facepile** (top right) — who is connected, in their colors. Cursorless peers (phones) appear
  here with a phone icon, since this is their only surface. Clicking an avatar centers the
  viewport on that peer's focused node.
- **Node header** — avatar chips for peers focused on the node, with a pulsing ring while they
  type. Reuses the `agentStatus` badge machinery (per-node badges from a transient store).

## Surfaces

- **Server Edition** — the primary stage; full feature.
- **Desktop (Electron)** — presence is silent when alone (≤1 peer draws nothing, zero cost).
  Acting as a relay host, the desktop shows the full peer list.
- **Mobile (nodeterm-ios, separate repo)** — a phone joins over the relay as a `HostSession`, so
  `hub.join()` fires for it today; it appears as a cursorless peer named "Phone" until it sends
  `presence:hello`. Typing attribution already works for it (see above). **Follow-up task in
  that repo:** send `presence:hello` + `presence:focus`, and render received cursor chat as a
  banner (it has no cursor to anchor a bubble to). Mobile does not *send* cursor chat in v1.

## Live dino (spectator mode)

The dino node (a T-Rex runner easter-egg) is a live/shared game on a shared canvas: one authority
plays, everyone else on that project watches the SAME game live — like cursors. It rides presence,
adding NO new core channel.

- **Wire.** `PeerState` carries an ephemeral `dino: { nodeId; snap: DinoSnapshot } | null` (like
  `chat`), cast on `presence:dino` and cleared on leave. The hub `sanitizeDinoPayload`s every cast
  (clamps `DINO_MAX_OBSTACLES`, coerces every number finite, validates each obstacle `kind`, caps
  the nodeId) — a peer cannot inject unbounded/garbage state. The cast is rate-limited like the
  cursor; only the genuine `null` stop is exempt (a dropped stop would strand a spectator).
- **Engine** (`dino/dino-game.ts` + the pure `dino/dino-sync.ts`). The authority broadcasts
  `currentSnapshot()` at `DINO_BROADCAST_HZ = 20`, and exactly ONE `null` on the run→idle/stop edge.
  A spectator's `setRemote(snap)` suspends its own physics + input and renders the snapshot (the loop
  runs even unfocused); `setRemote(null)` returns to local idle and is idempotent (calling it every
  render while already local never resets a live game). A local key while spectating is a **take-over**:
  the engine seeds from the last snapshot (no teleport) and becomes the authority.
- **Node** (`DinoNode.tsx`). It's under the active-session provider, so `api.presence.dino` +
  `selectDino` follow the active session (a **relay tab's** dino is live over the tunnel for free).
  The lowest `clientId` wins the authority tiebreak (`dino/dino-authority.ts` `shouldSpectate`), so a
  two-player Space race converges deterministically; a "▷ &lt;name&gt; is playing" pill (peer color)
  marks a spectated node.
- **Free when alone** — like `reportFocus`, the ~20 Hz snapshot cast is skipped with no peers (the
  `null` stop always lands). A solo player's game is byte-identical to before this feature.
- **Surfaces:** desktop / relay tab / Server-Edition browser all work via the hub + bridge. **Mobile:**
  the phone is on the retained old dialect (no rpc presence) — it neither broadcasts nor watches dino;
  a graceful degrade that rides the phone's eventual rpc migration.

## What Stage 1 changed relative to this spec

The sections above are the design as approved. Stage 1 implemented them faithfully with three
deviations, recorded here so this document does not lie to the next reader:

1. **Presence is scoped to a project, and the facepile deliberately breaks that scope.** The peer
   table carries `PeerState.projectId`, fed by a `presence:project` channel that was not in the
   original wire table (it is now, above). Cursors, chat bubbles and node chips are filtered
   through the single pure selector `peersOnProject(peers, projectId)`; the facepile intentionally
   does *not* filter, showing off-project peers dimmed and labelled with the project they are in,
   clickable to travel there. This was designed in as the feature described under
   [Presence is scoped to a project](#presence-is-scoped-to-a-project) — it is called out again
   here because it is the one place where "presence is per-canvas" is deliberately violated.
2. **A WebSocket heartbeat was added.** Not in the original design: a browser tab that *vanished*
   (killed, laptop slept, network dropped) never triggered a WS `close`, so its peer stayed in the
   table forever — a permanent ghost cursor. The Server Edition now runs a 30 s ping/pong heartbeat
   and reaps sockets that miss a pong, so a vanished client leaves within ~60 s. A cleanly closed
   tab still leaves immediately, on `close`.
3. ~~**`PeerState.typing` exists but is always `null` in Stage 1.**~~ **Closed in Stage 2.** The
   sender-aware `pty:write` handler calls `noteTyping()`, and the renderer draws the pulsing ring on
   the typist's header chip (`src/renderer/lib/typingPeers.ts` + `components/PresenceChips.tsx`).
   Two rules worth knowing before you touch it: the ring decays against the **local receipt time**,
   not the host's `typing.at` (a viewer's clock can be minutes off), and it is fed **only** by live
   `presence:peer` diffs — never by a `presence:sync` snapshot, which can carry a ten-minute-old
   stamp because the hub never clears `typing`. It is also the one node-scoped signal that is
   **not** project-filtered: a phone has `projectId: null`, and typing from the phone is exactly
   what the ring exists to surface (node ids are globally unique, so this is safe).

## What Stage 2 changed relative to this spec

Stage 2 implemented [Terminal co-attach](#terminal-co-attach) as approved — one pty with N
subscribers, an idempotent `pty:create`, smallest-subscriber-wins sizing, per-client backpressure,
and server-side typing attribution. Four things are **not** in the spec as originally written and
were added during implementation; the sections above have been amended to match, and they are
collected here so the delta is legible.

1. **`pty:recycle` — a separate primitive from delete.** The spec had exactly one way to kill a tmux
   session (`destroy`), and co-viewers of a destroyed session are told "closed by <name>" and must
   never respawn it. But **"Move into worktree"** also kills the session (`new-session -A` would
   otherwise just reattach the *old* working directory) — and there the node is **not** going away:
   it stays on every canvas and must keep working. Routing a worktree move through `destroy` would
   have shown every co-viewer a false "closed by …" and bricked their node. So the two intents are
   now distinct primitives with distinct events — `destroy` → `pty:closed {by}` (do not respawn) and
   `recycle` → `pty:recycled {ready}` (restart and re-attach; the node moved). See
   [Deletion vs recycling](#deletion-vs-recycling) for the full contract, including why the recycled
   notice is **withheld** until the replacement session is registered and why the 10 s escape-hatch
   timeout sends `ready:false` (= *do not respawn*) rather than letting a co-viewer silently re-spawn
   the node in its stale cwd.

2. **The tombstone — and its limit, stated plainly.** `pty:closed` only reaches a session's
   **subscribers**. A co-viewer whose project is closed or inactive has no mounted terminal, so it is
   not one — yet the node is still on its canvas, and its next `create` would spawn a fresh
   `nt-<nodeId>`: the deleted terminal, resurrected as an empty shell. `PtyManager.tombstones`
   refuses that create (`PtyCreateResult.closed = {by}`), exempting the destroying client so its own
   ⌘Z still works.
   **The limit is real and is not papered over: the tombstone is in-memory.** It lives exactly as
   long as the core process. Restart the core — the Server Edition process, or the desktop app
   hosting the relay — and the tombstones are gone; a client whose canvas still carries the deleted
   node will spawn a fresh session for it the next time it opens that project. This is deliberately
   **not** fixed by persisting the tombstone, because persistence is not the missing piece: **the
   node should not be on that canvas at all.** The actual fix is **Stage 3's canvas-delete
   mutation**, which removes the node from every client so nobody is left holding one to re-create.
   Until Stage 3 lands this is a bounded, named gap (also listed under [Known risks](#known-risks)),
   not a promise.

3. **A parked node reports `null`, not a size.** The spec said the pty runs at
   `min(cols) × min(rows)` over its subscribers, which is only correct for subscribers that are
   actually *looking*. A **parked** node (project switched away — the xterm is detached from the DOM
   but the PTY client is still alive and subscribed) has no meaningful size, and a collapsed or
   zero-height node measures as `0×0`. Either would clamp everyone else's terminal to nothing. So
   `transport.resize(sid, cols, rows)` takes `number | null`, and `null` means **"subscribed but not
   viewing"**: the subscriber is *absent* from the size map and is excluded from the min entirely
   (`reportedSize` in `src/renderer/terminal/terminal-config.ts`; `effectiveSize` in
   `src/core/pty-size.ts`). Parking a node therefore stops it constraining the shared grid, and
   un-parking makes it constrain again.

4. **Drop-and-redraw is a two-sided contract.** The 8 MB `WS_DROP_WATER` ceiling drops a slow
   client's queued output and resynchronises it by redrawing the current screen from tmux — never by
   replaying the backlog. Two rules, one per side, and **both** are enforced:
   - **Sender:** an **empty capture is never sent.** `captureForResync` returns `''` on any tmux/ssh
     failure, and `pty:resync` payloads are guaranteed non-empty (`ServerPlatform.resync`); an empty
     capture keeps the client desynced and is retried with backoff (250 ms → 10 s cap).
   - **Receiver:** the renderer **must ignore an empty payload anyway** (`shouldApplyResync`). The
     resync handler `term.reset()`s before repainting, so acting on `''` would blank a live terminal
     and leave only the separator. The two guards are redundant on purpose: a wrongly cleared screen
     is unrecoverable, a skipped repaint is not.

## What Stage 3 changed relative to this spec

Stage 3 implemented [Canvas sync](#canvas-sync) as approved — a publisher, a reflector, echo
suppression, no CRDT, undo local per user. Five things differ from the spec as originally written, or
were decided during implementation; the sections above are amended to match, and they are collected
here so the delta is legible.

1. **The publisher diffs SNAPSHOTS, not React Flow change-lists.** The spec said "`handleNodesChange`
   publishes a mutation". That would have synced only the edits that flow through `onNodesChange` —
   drags, selections, resizes. A rename, a color pick, a collapse, an add and a delete all reach the
   nodes array through direct `setNodes(...)` calls that never touch it, so half the edits would have
   silently failed to sync. The publisher instead diffs the serialized snapshot against the last one
   it published (`src/shared/canvas-publish.ts`), which catches every edit whatever path produced it.

2. **The reflector is deliberately NOT rate-limited** (`src/core/canvas-sync.ts`). Every other client
   cast in this feature is bucketed (presence: `PRESENCE_RATE_BUDGETS`; session-ending pty casts:
   `PTY_END_BUDGET`). A mutation is different in kind. A presence cast is a **sampled** signal whose
   loss is self-correcting — the next cursor frame carries the current position. A mutation is an
   **edge**: nothing supersedes it and nothing re-announces it, so a dropped mutation is *lost state*
   — a node that never appears on a peer's canvas, or a delete that never lands and then gets written
   back to disk by that peer's next whole-file save, which is the exact bug this stage exists to kill.
   Legitimate traffic is also burstier than any bucket sized for it would survive: a drag emits at
   20 Hz and a bulk delete emits N mutations in one tick. What **is** bounded is the *payload*:
   `isCanvasMutation` refuses a malformed or oversized cast at ingest (`MUTATION_MAX_BYTES` = 256 KB,
   ids capped at `REF_MAX_LEN`), so a hostile cast cannot amplify into every peer's socket or wedge a
   peer's React Flow. If a budget is ever added here it must **queue**, never drop.

3. **Mutations are project-scoped, and a mutation for a loaded-but-INACTIVE project is applied, not
   dropped.** Each cast carries a `projectId` (React Flow only ever holds the *active* project's
   nodes). Dropping a mutation for a project the client is not looking at would have been the
   data-loss bug in a new costume: that project's nodes still sit in the `projects` store, and the
   next whole-file `workspace.save` from that client would resurrect a node a peer had deleted. So
   `Canvas` applies a peer's mutation for a non-active project straight into that project's
   **serialized** nodes (`useProjects.applyNodeMutation`, `src/renderer/state/projects.ts`) and marks
   the workspace dirty. An unknown project id is a no-op (nothing to apply). Clients therefore
   converge **per project**, and the workspace rev-conflict bar stays as the cross-project backstop.

4. **The tombstone stays. It could not honestly be removed.** Stage 2 said the tombstone
   (`PtyManager.tombstones`, `src/core/pty-manager.ts`) was a stopgap and that Stage 3's canvas-delete
   mutation was its real replacement. Stage 3 makes it *mostly* redundant — an attached client's
   canvas loses the node the moment a peer deletes it, so it never asks to `create` it again — but
   two live paths still reach `create` for a deleted node, and both would spawn a fresh `nt-<id>`
   (the terminal its owner deliberately killed, as an empty shell) if the tombstone were deleted:
   - **Project-level operations are not in the mutation vocabulary.** `CanvasMutation` addresses
     nodes, edges and board items, never a project. `deleteProject`
     (`src/renderer/canvas/Canvas.tsx`, the `×` on a "Recently closed" entry) ends every
     terminal's tmux session via `transport.destroy(nodeId)` and publishes
     **nothing** — the project itself, with all of its nodes, is still in every peer's `projects`
     store. A peer that reopens it from *its* "Recently closed" list mounts those nodes and creates
     their ptys. Only the tombstone refuses that.
   - **Delivery is best-effort with no catch-up.** The reflector casts to the clients attached *at
     that instant*; there is no join snapshot and no replay. A client whose socket was down when the
     delete landed never sees it. In the Server Edition the ws-bridge full-page-reloads on reconnect
     (so it re-reads the workspace from disk and self-heals) — but only once the deleting client's
     **debounced** save has flushed; inside that window the client is holding a node the file no
     longer has.
   Removing the tombstone would trade a bounded in-memory LRU for a resurrected terminal on those two
   paths, so it stays. It is unchanged by this stage: still in-memory, still an LRU
   (`TOMBSTONE_MAX` / `TOMBSTONE_TTL_MS`), still exempting the destroyer so their own ⌘Z works.

5. **What canvas sync does NOT cover** (all deliberate; none of it is fixed by this stage):
   - ~~**Edges are NOT in the mutation vocabulary**~~ — **closed; see
     [Edge sync](#edge-sync-bridges--ropes) below.** This was the worst of the gaps and not a
     cosmetic one: edges rode the whole-file `workspace.save` without being in the vocabulary, so an
     edge you drew never reached your peer **and their next save — of a canvas that never had it —
     DELETED it**.
   - **A peer's node removal unmounts the node and disposes its terminal co-state**
     (`disposeTerminalOnUnmount` — the module-level xterm/park/co-attach state), but it does **not**
     run the rest of the local delete path (`useAgentStatus.remove`, chat-driver dispose). The
     session itself is already dead (the *deleting* client's `transport.destroy` killed it), so
     nothing leaks server-side; what remains on the peer is a stale `agentStatus` entry for a node id
     that no longer exists. Disposing the co-state matters because the delete is undoable: if the
     owner hits ⌘Z, the node comes back **alive**, and a peer that had kept the stale co-state would
     be looking at a node stuck in "closed by another user" whose only obvious cure (clicking `×`)
     would kill the owner's live session for real.
   - **Project lifecycle** (create / rename / close / delete / folder change) is **not** synced.
   - **Viewport, selection and undo** are not synced. Undo is local per user, by design.
   - **No conflict resolution beyond per-item last-write-wins** (per node, edge or board item). See
     [Concurrent-edit resolution](#concurrent-edit-resolution-what-converges-and-what-does-not).
     No CRDT.

## Concurrent-edit resolution: what converges, and what does not

**Converges, on any interleaving, among the clients that saw the whole exchange.** Every such client
ends with the same **set** and the same **value** for every node and edge, and shows the same board,
because every mutation is ordered by the reflector's `seq` and the highest `seq` per item wins
everywhere (`src/shared/canvas-order.ts`). A client that loaded after a delete did not see it all; it
is the first entry in the list below, and the board's exceptions are listed there too. This is the
property persistence depends on: whichever client's whole-file `workspace.save` runs, it writes a
canvas the others agree with. Proven end-to-end against an **asynchronous** bus (queued casts + FIFO
deliveries, edits genuinely in flight) in `src/core/canvas-sync.convergence.test.ts`.

That guarantee does **not** rest on any timeout. The pending TTL is a bound on how long we *suppress*
peers, never on correctness: an ack that arrives after it **repairs** the node (rule 3 above), and a
cast the reflector would refuse is never made in the first place (the publisher shares the reflector's
predicate, records no pending entry, and keeps retrying the node until it is castable). Both cases are
in the convergence suite — a client whose socket is stalled past the TTL, and an oversized sticky cast
concurrently with a peer's delete.

**Does NOT converge — named, not hidden:**

- **A stale frame reaching a client that holds no tombstone.** Rule 4 (below) judges an upsert only
  against the removes a client has itself applied. A client that loaded the canvas after a delete, or
  reset its order on a reconnect (`reset()` clears the tombstones), has none for that node, so a stale
  frame for it arriving later (from a peer whose socket was stalled) is applied there and dropped by
  every other client. That client holds a node the others do not until its next load, and its next
  whole-file save can write it back. (A canvas authority that heard the delete drops the frame too,
  and overlays that save.)
- **Array order after a resurrection.** If a node is deleted and then legitimately re-created, the
  client that issued the delete removed it and re-appended it, so it can sit in a different **slot**
  in the array than on a client that never removed it. Node set, positions, sizes and data all agree;
  only the array order (which drives the sidebar listing) can differ, and the next load normalizes it.
- **Intent, on a contended node.** Two people dragging the same node fight: the node lands wherever
  the last-ordered frame put it. Two people typing a title get one title. That is last-write-wins,
  not a merge — by design (no CRDT).
- **Edge array ORDER**, for the same reason and with even less consequence: two clients that draw
  an edge at the same time each append the peer's to their own, so the two arrays hold the same
  edges in different slots. Nothing lists edges in order; they are rendered as a set.
- **Board column and label order, for ids two clients added in the same window**, until the next
  order op (see [Board sync](#board-sync-kanban)).
- **A card's stored placement when its column is deleted as it is filed there.** Depending on the
  order, one client can keep a placement naming the deleted column while another has none. Both show
  the card in Ungrouped, which holds every card with no placement or one naming no column
  (convergence case 5 in `src/core/canvas-sync.convergence.test.ts`).
- **Anything outside the node/edge/board vocabulary** — project lifecycle (see item 5 above).

### A delete beats a concurrent edit — CAUSALLY, not by a tiebreak (rule 4)

This used to be in the list above, as a named wart: A deletes a node while B is mid-drag, B's next
frame is ordered after A's remove, so the node **survived on every canvas** — but A's
`transport.destroy` had already run `tmux kill-session`, so what came back was a **shell around a
dead terminal**. Consistent, and nobody had asked for that node back.

The fix is not the "delete always wins" tiebreak this document previously rejected — that one buys
the opposite hazard, a stale drag frame from a disconnected peer erasing a node that was
legitimately re-created. The missing fact was **causality**, so every mutation now carries `seen`:
the highest `seq` its sender had applied when it cast. The rule is exact, with no timer:

> an upsert for a removed node is dropped **iff** `seen < the seq the remove was ordered at`.

B's drag frame was produced in ignorance of the delete and dies everywhere; a re-creation (⌘Z on
the delete, the node added again) necessarily carries `seen` at or past it and lands. Its mirror on
the receiving side: **a `remove` is never held off by rule 2's suppression** — rule 2 rests on "our
unacked mutation wins everywhere", which under rule 4 it no longer does, so suppressing the remove
would be the one way to disagree with our peers.

**A re-creation waits for our OWN remove's echo** (`CanvasOrder.hasPendingRemove`). Our remove enters
our `seen` only when its echo comes back, so a re-creation of the same id cast before that — a link
deleted and redrawn, a node deleted and ⌘Z'd, inside one round trip — carried a `seen` below the
remove: every peer dropped it as a stale frame while we kept showing it, and the next whole-file save
became last-writer-wins on disk. Canvas's send callback now refuses any non-remove op for a key with a
remove of ours in flight (counted per key, not TTL-bound — a late ack is exactly when it matters). A
LOST ack does not come with a reconnect: the ui sink drops a single message and keeps the connection
(`SINK_FAILURE_LIMIT`). Our echoes come back in the order we cast (FIFO), so the echo of a LATER cast
of ours proves an earlier one was lost, and releases that remove's gate too; Canvas compares the total
count of pending removes across each `accept` to see it. A reset still clears everything. The record
of our casts that FIFO match reads is capped (`LOCAL_CASTS_MAX`, 4096), which only matters while the
core answers nothing at all: a remove the cap forgets is released as it goes (the pre-gate degrade,
not a gate stuck until a reset), and a forgotten cast's own late echo releases nothing (matched to a
later cast of its key, it would release removes whose echoes are still in flight). The
refusal keeps the op owed in the
publisher, and an adopt in that window keeps an owed EDGE owed as well as an owed node (a teammate's
op is usually what arrives during that round trip). Nothing else would ever cast it — our echo is an
ack and changes no React state — so the echo that clears the gate re-publishes, after the handler and
only when the publisher `hasOwed()`.

`seen` is client-supplied. The reflector tidies it (`stampMutation`): a value at or past the order the
mutation is being given is clamped to just below it, and a non-integer or negative one is dropped.
**The clamp is hygiene, not a guard: it changes no verdict.** A remove ordered before this mutation
has a `seq` at most `seq - 1`, so a clamped `seen` still counts as having seen it, and a remove ordered
after it supersedes it by `seq` alone. A forged `seen` therefore resurrects a deleted node, clamp or no
clamp. What bounds that is who may cast at all: on a hosted team `canvas:mut` is Editor-only, and an
Editor has a shell on the host anyway. A mutation with **no** `seen` (an older peer, the relay mirror)
is judged exactly as before rule 4 existed — degrade, never break.

What this does **not** do: un-kill the process. If the delete wins, the terminal is gone, which is
what the human asked for. If the node is deliberately re-created later, it is still a fresh session
under the same `nt-<nodeId>` (a cold start).

## Non-goals (v1)

Roles/permissions, follow/spotlight mode, persistent chat history, comment threads, write
locking, CRDT, character-level cursors inside editor/diff nodes (node-level focus only),
read-only guests, per-user settings.

## Testing

- `PresenceHub` pure unit tests: join / leave / diff, cursorless peer.
- Server e2e with **two** WS clients: hello → snapshot, cursor fan-out, echo suppression, leave
  on disconnect.
- **Co-attach** (delivered): two clients, one `persistKey` → a single spawn; both receive output;
  min-size resize; the joiner is painted from the current screen when the join did not resize the
  pty (and is NOT painted when it did); only a subscriber may write/resize/pause/kill a session, and
  nothing it owed outlives it; the destroy path is capped, bounded and rate-limited; one client's
  backpressure does not stall the other; a client that falls 8 MB behind is dropped and redrawn from
  tmux rather than buffered forever; and a pause is released by the drain sweep even when no further
  output ever arrives. → `src/core/pty-coattach.test.ts` (60 tests), `src/core/pty-size.test.ts`,
  `src/server/backpressure.test.ts`, `src/server/platform-server.test.ts`
- **Typing attribution** (delivered): the sender-aware `pty:write` stamps the writer; the ring decays
  against local receipt time and is fed only by live diffs. → `src/core/pty-typing.test.ts`,
  `src/renderer/lib/typingPeers.test.ts`
- **Renderer co-attach logic** (delivered): reported-vs-effective size, letterboxing, resync-empty
  guard, recycle action, "closed by" label. → `src/renderer/terminal/terminal-config.test.ts`
- **Registration guard** (delivered): `pty:write` must stay routed through the *sender-aware* seam —
  the test fails if a merge resurrects the old sender-less `platform().on(IPC.ptyWrite, …)` beside
  it. → `src/core/pty-manager-platform.test.ts`
- **Single-client regression** (delivered): min-size equals your own size and the spawn path is
  unchanged. → `src/core/pty-single-user.test.ts` (17 tests)
- **Canvas sync** (delivered): the reflector stamps the total order (`seq`, monotone across senders
  and projects, never trusted from the client) and fans a mutation to every client *including* the
  sender, refuses a malformed/oversized cast, and registers exactly once per platform; the publisher
  diffs snapshots, stamps `src`, throttles drag frames, flushes on settle, `adopt()`s without
  emitting, and — while solo — emits and diffs **nothing** while still keeping its baseline current.
  → `src/core/canvas-sync.test.ts`, `src/shared/canvas-publish.test.ts`,
  `src/shared/canvas-mutations.test.ts`
- **Ordering** (delivered): an own echo is an ack and is never re-applied; a peer's edit loses to an
  unacked local edit of the same node (per node, counted per in-flight frame); a superseded straggler
  is dropped; an ack that never comes expires; a **late** ack repairs a node a peer overwrote after
  the TTL lapsed (and one that lost the total order is still just an ack); a fresh local edit re-arms
  the node; a continuous drag keeps its own suppression alive past the TTL.
  → `src/shared/canvas-order.test.ts` (15 tests)
- **Canvas convergence** (delivered): two clients running the **real** publisher and **real** ordering
  against the **real** reflector, over an **ASYNCHRONOUS** bus (casts and deliveries queued, FIFO per
  link — so several edits are genuinely in flight and the test chooses the interleaving). *The
  earlier synchronous bus could not express concurrency at all, and therefore "passed" a design that
  diverged permanently on the first concurrent drag.* Covered: a concurrent move of the same node
  converges on the ordered winner (both orderings); a concurrent delete-vs-drag converges (both ways
  round) — no split-brain save; 20 frames of two clients dragging one node converge; three clients
  editing one node converge; every interleaving × every settle point of a six-edit set converges; a
  peer's mutation is applied once and **re-published never** (one cast per local edit, no
  counter-cast, even for a bulk delete across three clients); ephemeral cards never go on the wire; a
  late joiner converges; a peer's delete is not resurrected by the surviving client's next save; a
  client whose **inbox is stalled past the TTL** (a backed-up socket) is repaired by its own late ack
  instead of being left on the losing value; and an **oversized** node the reflector would refuse
  neither deafens that node to a peer's concurrent delete nor is silently lost (it is retried, and
  syncs once trimmed). → `src/core/canvas-sync.convergence.test.ts`
- **Applying a peer's mutation** (delivered): patches the live React Flow array — keeps your
  selection, keeps relay-remote nodes, keeps local-only node data, keeps every untouched node's
  object identity, drops the stale `measured` size so a peer's resize is not fought back, and keeps
  group parents before their children. → `src/renderer/state/workspace.mutation.test.ts` (10 tests)
- **Board sync** (delivered): the reducer and sanitizers per op; two different cards moved at once
  both land; one card moved twice ends on the later op; two first-ever board edits make three
  columns, not six; a card whose node has not arrived survives a peer that prunes it; a column
  deleted while a card moves into it leaves the card in Ungrouped; concurrent column and label adds
  converge. → `src/shared/kanban-ops.test.ts`, `src/shared/kanban-ops.convergence.test.ts`,
  `src/shared/canvas-content.test.ts`, `src/renderer/canvas/kanban-sync.test.ts`, and the board cases
  in `src/core/canvas-sync.convergence.test.ts`. The Server Edition's canvas authority has its own
  suite (`src/core/canvas-authority.test.ts`) and an end-to-end run with no browser attached
  (`src/server/hosted-e2e.test.ts`).

### Manual smoke test (Stage 1)

Presence needs two clients, which no unit test gives you. The cheapest two-client rig is the Server
Edition in two browser tabs (see docs/SERVER.md):

```bash
npm run server:dev     # then open the printed URL in TWO browser windows
```

Use one **normal** window and one **private** window (or two profiles): a second tab in the *same*
profile shares `localStorage`, so it would not re-prompt for a name and both peers would carry the
same identity. Call them **A** and **B**; log both in with the shared password.

1. **Name prompt, once.** B prompts for a name on first connect. Enter one. It does **not** prompt
   again on reload (it is remembered in `localStorage` under `nodeterm.presence.me`). Do the same in
   A with a different name.
2. **Names propagate.** Each tab shows the other's avatar in the facepile (top right) in its color,
   with the name entered in step 1 — not "Someone".
3. **Cursors, in flow coordinates.** Move the mouse over A's canvas: B draws A's cursor with a name
   label, tracking it. Now **zoom and pan B** (trackpad pinch / two-finger scroll). A's cursor stays
   pinned to the same *canvas* point — the same node, the same corner of it — at every zoom level.
   Neither tab ever draws its own cursor.
4. **Cursor chat opens on `/`.** With the pointer over A's empty canvas, press `/`. An input opens
   beside A's cursor; type — the text streams into A's bubble in B *per keystroke*. Enter leaves the
   bubble up and it fades after ~5 s; Escape clears it at once.
5. **`/` inside a terminal does NOT open cursor chat.** (The most important negative case.) In A,
   hover into a terminal node until the hover guard releases and the terminal takes focus, then type
   `/`. The `/` must reach the **shell** — it appears at the prompt — and **no chat input opens**.
   Repeat inside an editor node (Monaco) and inside the rename box in a node header: same result.
6. **Node focus chips.** While A is focused in that terminal, B shows A's avatar chip in **that
   node's header**. Click A onto a different node → the chip moves. Click A onto empty canvas → the
   chip disappears.
7. **Off-project peers: dimmed, labelled, travelable.** In A, switch to (or create) a second project
   tab. In B: A's cursor and node chip vanish from the canvas **immediately**, and A's facepile
   avatar goes **dimmed**, labelled with the project A is in ("Ada · api"). Click that avatar in B →
   B switches to that project and centers on A's focused node. Switch A back → A's cursor reappears
   on B's canvas.
8. **Clean close leaves at once.** Close tab A normally → its cursor, chip and avatar disappear from
   B within a moment (the WS `close`).
9. **Vanished client leaves on the heartbeat.** Reopen A, then **kill** it without a clean close
   (kill the browser process, or pull the network). B keeps showing A briefly, then reaps it
   **within ~60 s** — this is the 30 s ping/pong, and is the expected worst case, not a bug.
10. **Desktop alone is silent.** Launch the Electron app with no other client: no facepile, no
    cursors, no name prompt — presence costs nothing when you are the only peer.

### Manual smoke test (Stage 2 — terminal co-attach)

Same two-client rig as Stage 1 above (`npm run server:dev`, one **normal** and one **private**
window, so the two peers have distinct identities in `localStorage`). Do the Stage 1 script first —
this one assumes **A** and **B** are logged in, named, and on the **same project**. Everything below
is about *one terminal node*, so create one in A and let it appear in B.

Co-attach is invisible when it works, so the checks are mostly *negative*: the last one (a solo user
sees no change) is the one that must never regress.

1. **One pty, two viewers.** Open the same terminal node in A and in B. Run `ls -la` in A. B shows
   the **same live output**, in the same shell — not a second prompt in a second shell. The server
   logs exactly **one** spawn: B's `create` subscribed to A's session (`fresh:false`) rather than
   spawning. `tmux -L node-terminal ls` on the server shows exactly one `nt-<nodeId>` session with
   exactly **one** client attached (co-attach does not add a tmux client; `-D` is untouched).
2. **Both can type; characters interleave.** Type `echo hello` in A — the characters appear in B as
   you type. Now type in **both at once**: the characters interleave in the one shell. This is
   expected, not a bug (see [No locking](#no-locking-v1)) — the typing ring is the warning, and
   there is no lock.
3. **The typing ring.** While A types, B's copy of that node shows a **pulsing ring on A's avatar
   chip** in the node header. It fades ~2 s after A stops. Type from B → A sees the ring on **B's**
   chip. (The ring decays against the *viewer's* local receipt time, so a skewed clock on either
   machine cannot leave a ring stuck on.)
4. **The smaller window wins; the bigger one letterboxes.** Make B's browser window **narrower**
   than A's. Both terminals reflow to **B's** (smaller) grid: the shell's own wrapping matches in
   both, with no wrapping artifacts. In **A** — the larger one — the leftover space is
   **letterboxed** (dead margin), because A is now rendering B's smaller grid. Run
   `tput cols; tput lines` in either: it reports the **min**, not A's own size. Widen B again → both
   grow back and A's letterbox disappears.
5. **Parking releases the size constraint.** With B still the narrower (constraining) client, in
   **B** switch to a different project tab. B's node unmounts and **parks** — it stays subscribed but
   reports `null` ("subscribed, not viewing"), so it drops out of the min. **A's terminal grows back
   to A's own size and stops letterboxing**, within a moment and without B closing anything. Switch
   B back → the node re-adopts, re-fits, and constrains A again. (This is the fix for the obvious
   bug: a teammate who wandered off to another tab must not hold everyone's terminal hostage at a
   grid they can't even see.)
6. **Delete shows "closed by", and does NOT respawn.** In **A**, delete the node (× / Delete). In
   **B**, that terminal enters the **"closed by <A's name>"** state — and **B does not respawn it**:
   no new shell appears, no new prompt, and `tmux -L node-terminal ls` shows the `nt-<nodeId>`
   session **gone** and not recreated. Now the harder half: in **B**, *before* deleting, switch to
   another project (so B has no mounted terminal for that node and cannot receive `pty:closed`), have
   **A** delete the node, then switch **B** back. B must **still** land in the closed state — the
   in-memory **tombstone** refuses the create — and must **not** spawn a fresh shell. **Known limit:**
   restart the server process and repeat this — the tombstone is gone and B *will* spawn a fresh
   session. That is the documented gap, fixed by Stage 3's canvas-delete mutation (see
   [Known risks](#known-risks)); it is not a smoke-test failure today.
7. **"Move into worktree" does NOT say "closed".** Restore/create a shared terminal node in a git
   project, open it in both. In **A**, use **Move into worktree**. **B must never show "closed by
   …"** — that would be a lie, the node is alive and on B's canvas too. Instead B's terminal
   **restarts in place** with a `── session restarted by another user (moved to a new folder) ──`
   separator, and it **follows the node into the new session**: `pwd` in **B** prints the
   **worktree** path, the same one A is in, in the *same* shared session (this is `pty:recycle`, not
   `destroy` — see [Deletion vs recycling](#deletion-vs-recycling)).
8. **A slow client is dropped, not buffered — and lands on the current screen.** Throttle **B**'s
   network (DevTools → Network → "Slow 3G") and run `yes | head -5000000` in the shared terminal.
   **A must keep streaming at full speed** (B's slow socket must not pace the team), and the server
   process's RSS must **plateau** — past 8 MB buffered, B's queued output is dropped rather than
   queued forever. Remove the throttle: B lands on the **current screen** with a single
   `── reconnected — earlier output skipped ──` separator. It must **not** grind through the backlog,
   and B's screen must **never** go blank (an empty capture is never sent, and is ignored if it were).
9. **One client leaving does not stall the other.** Close **B**'s browser entirely while output is
   streaming. **A keeps streaming** — no stall, no stale pause left behind by B's disconnect
   (`dropClient()`), no dead subscriber holding the grid at B's old size.
10. **A SOLO user sees no change whatsoever.** The regression that matters most. In the desktop app
    (`npm run dev`), alone, with no other client: open a terminal, run `yes | head -100000`, resize
    the node, switch projects and back (park → adopt), quit and relaunch (warm reattach). The min of
    a one-element set is your own size, so: **no letterbox ever appears**, the grid is exactly your
    own fit, no resync separator is ever printed, no typing ring, no facepile. Nothing may look or
    behave differently from `main`.

### Manual smoke test (Stage 3 — canvas sync)

Same two-client rig (`npm run server:dev`, one **normal** and one **private** window). **A** and **B**
logged in, named, and on the **same project**.

1. **A node created by A appears on B.** Add a terminal node in A. It appears on B's canvas at the
   same flow coordinates, with the same title and color, within a moment — and B's canvas shows
   **one** node, not two.
2. **Move, rename, recolor propagate.** Drag the node in A → it moves on B. Rename it (header
   click-to-rename) → the title updates on B. Change its color → the color updates on B. Now do the
   same three from **B** → they land on A. (Rename and color never pass through `onNodesChange`; if
   they fail to sync, the publisher has regressed to a change-list.)
3. **A drag is throttled, not per-frame.** Drag a node around A for a few seconds with B's DevTools
   Network → WS frames open. The `canvas:mut` frames arrive at roughly **20 Hz**, not one per
   animation frame, and the **last** frame lands on the settled position (the drag-stop flush) — B's
   node must end up exactly where A dropped it, never one frame short.
4. **Delete propagates, and does not come back.** Delete the node in A. It disappears from B's canvas
   (and B's terminal for it lands in the "closed by <A>" state — Stage 2). Now, in **B**, make an
   unrelated edit (move another node) so B's canvas saves. Reload **both** tabs: the deleted node is
   **gone** and stays gone. (Before Stage 3, B's whole-file save wrote the deleted node straight back
   — this is the data-loss bug the stage exists to kill.)
5. **A delete lands even on a project you are not looking at.** In **B**, switch to a *second* project
   tab. In **A**, delete a node from the **first** project. Switch B back → the node is **already
   gone** from B's first-project canvas (the mutation was applied to that project's serialized nodes
   while it was inactive). Reload B: still gone.
6. **Ephemeral subagent cards do not duplicate.** Run a prompt in a Claude node in A that spawns a
   subagent (e.g. "use a subagent to list this repo's files"). The subagent card appears **once** in
   A and **once** in B (each derives it from the `agent:status` stream) — never twice, and dragging
   the card in A does not move or duplicate anything in B. Same for a `/loop` card.
7. **No echo, no ping-pong.** With both tabs idle after an edit, watch the WS frames: `canvas:mut`
   traffic goes **silent**. A mutation applied from a peer must not be re-published (that would be an
   endless A→B→A loop); if you see mutation frames with nobody touching either canvas, the `adopt()`
   loop guard has regressed.
8. **A SOLO user sees no change whatsoever.** The regression that matters most. In the desktop app
   (`npm run dev`), alone: add, drag, rename, recolor, group, delete nodes; undo/redo; switch projects
   and back. With no peer attached the publisher does not even **diff** (the solo gate) — the canvas
   must look and behave exactly as on `main`, with no extra dirty marks, no undo-stack entries you did
   not create, and no node ever moving on its own.
9. **Both drag the same node.** A and B grab the **same** node and drag it in opposite directions for
   a few seconds, then both let go. It fights (expected — last write wins), but when the dust settles
   **both canvases show it in the same place**. Reload both: still the same place. (Before the
   ordering fix, A and B ended up holding the node at two different positions *permanently*, and
   whoever saved last silently moved it for the other.)
10. **Delete a node the other is dragging.** B drags a node; A deletes it mid-drag. Whatever happens
    (it survives on both, or it dies on both — the total order decides), **A and B agree**, and after
    a reload of both tabs the canvas is the same on each. What must never happen is one of them
    holding a node the other does not.
11. **Your selection survives a teammate's drag.** In B, box-select two nodes and hold the selection
    while A drags a *third* node around. B's selection must stay selected (before the in-place apply,
    each of A's ~20 Hz mutations wiped it). Likewise, B's relay-remote terminal nodes (if any) must
    not vanish while A edits.
12. **Your undo is not eaten.** In B, move a node, and within a moment have A move a *different* node
    (so a peer mutation lands during B's undo debounce). Now press ⌘Z in **B**: it must undo **B's**
    move — not skip past it to an older state (which would also revert A's edit).

## Known risks

- **Weak identity** — anyone can claim any name.
- **Concurrent typing garbles input** — accepted; the badge is the warning.
- **Cross-user undo** — last-write-wins, no CRDT.
- **Per-item last-write-wins is a resolution, not an arbitration.** Clients that saw the whole
  exchange converge (a client that loaded after a delete may not: see the does-not-converge list), but
  two people dragging one node fight over it and the last-ordered frame decides. (A delete no longer
  loses that race — see rule 4 under
  [Concurrent-edit resolution](#concurrent-edit-resolution-what-converges-and-what-does-not).)
- ~~**A peer's edge (context link / note link) is deleted by your next save.**~~ Closed — edges are
  in the vocabulary now ([Edge sync](#edge-sync-bridges--ropes)).
- **The publisher's solo gate reads the presence peer table.** If a client's presence handshake never
  completes, that client sees no peers and therefore publishes nothing (it still *applies* what it
  receives, and the first mutation from a peer flips the gate on for good). Presence and canvas sync
  ride the same transport, so a client that cannot say hello generally cannot cast either — but the
  coupling is real and is the price of a solo user paying zero. A project a canvas authority governs
  does not depend on it: its clients publish whether or not they see a peer.
- **Cursor traffic** is 20 Hz × peers: comfortable for a 5–10 person team, not for a public room.
- **Plain-shell (no tmux) co-attach shows a joiner a blank-but-live terminal** until the next output
  arrives (pressing Enter paints it). A joiner gets `fresh:false`, so it skips the cold-restore
  replay, and with no tmux there is nothing to capture its current screen from either. With tmux —
  i.e. every normal install — the joiner IS painted: the create result carries the screen (see
  [Painting the joiner](#painting-the-joiner)). A plain-shell session has no cross-client continuity
  to inherit anyway; that is what "no tmux = no persistence" already means everywhere else.
- **A deleted node can still be resurrected on the paths canvas sync does not cover.** Stage 3 closed
  the main one: an attached client's canvas loses the node the instant a peer deletes it (active
  project *and* loaded-but-inactive project), so it never asks to re-create it, and its next
  whole-file save cannot write it back. The respawn guard behind that is still three layers deep,
  because the mutation does not reach everywhere: the `pty:closed` event (subscribers only), the
  canvas-delete mutation (clients attached at that moment), and the in-memory `tombstones` map
  (everyone else, for as long as the core process lives). What is left:
  - **A whole project deleted by one client is not synced** (project lifecycle is not in the mutation
    vocabulary), so a peer can still reopen it from *its* "Recently closed" list and re-create its
    nodes' ptys. The tombstone is what refuses those creates.
  - **A client that was disconnected when the delete landed misses it** (no join snapshot, no replay).
    The browser self-heals on reconnect by reloading the page — but only after the deleting client's
    debounced save has flushed.
  - **The tombstone remains in-memory**, so it dies with the core process; across a core restart both
    of the above degrade to "the node comes back". Bounded and honestly named, not a promise. See
    [What Stage 3 changed](#what-stage-3-changed-relative-to-this-spec) (item 4).
- **A peer's node delete can still leave a dangling edge for a moment.** The delete and the edge
  removal are two mutations, and the peer that owns the edge prunes it on its next node change, so
  an edge whose endpoint a peer deleted can be drawn against nothing for a tick. It is dropped by
  the same prune that has always handled a locally-deleted endpoint — the durable half (your save
  erasing their edge) is what closed.

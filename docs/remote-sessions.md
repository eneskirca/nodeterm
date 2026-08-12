# Remote workspace sessions — design (team, Stage 4)

**Date:** 2026-07-13
**Status:** 4a + 4b + 4d + **4c landed** on `feat/relay-rpc-main` (full suite + typecheck green,
1690 tests). Two desktops are equal peers on one shared canvas over the E2EE relay: a remote host
opens as a **project tab** (bridged `NodeTerminalApi` over the tunnel), mutual-SAS consent is shown
at the grant moment, an offline tab greys + reconnects, and worktree/clone paths resolve on the
host. The desktop-**client** legacy dialect is deleted; the **phone** dialect is intentionally
retained until the iOS repo migrates to the tunnel (`docs/ios-protocol-migration.md`). Pending:
the two-instance manual acceptance run (below), then the whole-branch security review + merge to
`main`. See **"4c landed"** below for the shipped surface and the deferred follow-ups. 4e (Server
Edition as a tab) is future.
**Depends on:** Stages 1–3 (`docs/team-presence.md`), all merged.

## Goal

Any remote nodeterm core opens as a **project tab** in the desktop app, with the full
feature set — terminals, git, editor, presence, co-attach, canvas sync. The headline
case: two desktops (e.g. two Macs) as **equal peers** on one shared canvas over the
E2EE relay. The same abstraction also opens a Server Edition box as a tab.

Stages 1–3 built multiplayer for clients that share ONE core. Stage 4 does not change
that model — it extends *which clients can attach to a core*. A desktop joining another
desktop is a client of the host's core, exactly as a browser is a client of the Server
Edition's core.

## Decisions (each made explicitly)

1. **Single workspace, equal rights.** The canvas, files and processes live on the
   host's machine; the peer joins with full rights (create/delete nodes, open
   terminals, type). "Equal" means equal *rights*, not mixed homing — a canvas never
   holds nodes from two machines. The asymmetry is real and documented: if the host
   sleeps, the peer's world freezes (and resumes via co-attach on reconnect).
   Mixed-home canvases (a `home` field per node) were considered and rejected for v1.
2. **Full trust, explicitly granted.** Inviting a peer grants shell access — the
   invite UI says so in plain words ("<name> will be able to run commands on this
   Mac — the same as giving them SSH access"). No per-action approval, no directory
   jail: after the first shell both are theater. The boundary is *who you invite*.
3. **A remote session is a project tab**, not a separate window and not a full-app
   takeover. Your local projects stay in their tabs; "Ayşe's Mac" sits beside them.
4. **The abstraction is source-agnostic.** A session's source is `local` (today's
   preload), `relay` (E2EE relay to another desktop), or `server` (WS to a Server
   Edition box). One refactor buys all three.
5. **One protocol.** `src/shared/rpc.ts` — the Server Edition's WS-RPC — becomes the
   only client↔core protocol, tunneled over the relay's E2EE socket for remote
   desktops. The relay's private opcode dialect (`framing.ts` OP codes, `snapshot.ts`,
   `host-service.ts`'s hand-rolled RPC vocabulary, `host-canvas-hub`'s full-state
   mirror, `sanitizeClientMutation`) is **deleted**, not deprecated — the app is
   unpublished, so this is the one moment that costs nothing. iOS (separate repo)
   migrates to `rpc.ts`; the phone cannot connect until that Swift work lands, and in
   exchange gains git, presence, agent status and co-attach, none of which the old
   dialect carried.
6. **Sub-stages, each independently mergeable** (see Split below): 4a ∥ 4b ∥ 4d in
   parallel branches, then 4c (the join point), then 4e.

## Architecture

### The Session abstraction (renderer)

Today the renderer assumes one core: `window.nodeTerminal` is a global and the stores
are singletons. Stage 4 introduces **Session** = a connection to one core + that
core's API:

```ts
interface WorkspaceSession {
  id: string
  source: 'local' | 'relay' | 'server'
  label: string                    // "Ayşe's Mac", "prod-box"
  api: NodeTerminalApi             // preload (local) or a bridged RPC client
  status: 'connected' | 'connecting' | 'offline'
}
```

Every project tab belongs to a session. `SessionContext` + `useSession()` provide the
API; `Canvas`, `TerminalNode`, `EditorNode` and the panels read it from context
instead of the global.

**The API splits in two** (measured: 221 call sites in 46 files):
- **Core-bound** (~90 calls — `pty`, `git`, `fs`, `workspace`, `presence`, `chat`,
  `canvas`, `agent`): routed per session. In a remote tab these hit the remote core.
- **App-global** (~60 calls — `updates`, `license`, `clipboard`, `shell`, `dialog`,
  `media`, `settings`, `pairing`): always local. Your update banner shows *your*
  version, never the host's.

**Stores become session-scoped.** `presence` and `agentStatus` hold per-session
tables (two sessions = two peer tables). This is the riskiest part of the refactor:
the presence store's module-level state (`connectPresence` idempotence, `lastFocus`,
the ws-bridge "exactly one subscriber" early-buffer invariant) must become
per-instance. Stage 1's invariants hold *per session*.

`TerminalTransport` note: the interface stays for the local path, but `RemoteTransport`
is deleted — a remote tab talks through a bridged `NodeTerminalApi` (the ws-bridge
builders), the same way the browser does. The load-bearing seam moves one level up:
from "swap the transport" to "swap the API object".

### The host side (main process)

Stages 1–3 are written against `CorePlatform` (`clientIds()`, `sendTo(id)`,
`onWithSender`) and already run multi-client every day on the Server Edition. The only
Electron blocker is that `electronPlatform` resolves clients as webContents:
`clientIds()` returns the main window only; `sendTo` uses `webContents.fromId`.

Fix: a **client registry**. `clientIds() = [mainWindow, ...peerIds]`; `sendTo`
dispatches by id to a webContents *or* a registered peer sink (the relay connection).
With that one seam, `presenceHub`, the Stage 3 canvas reflector and terminal co-attach
flow to a remote peer with no further changes — they never knew what a webContents
was. `phone-presence.ts`'s half-join (host sees the phone; the phone is blind because
`sendTo` no-ops) is what this seam makes fixable — the fix itself lands in 4c, when the
phone gets a real sink (see below).

### 4b → 4c interface (landed)

4b is **merged**: `electronPlatform` is genuinely multi-client. A relay peer is now a
first-class `CorePlatform` client of the desktop's core, so `presenceHub`, the Stage 3
canvas reflector and terminal co-attach already reach it — 4c only has to supply the
socket. What 4c consumes:

```ts
// src/main/peer-registry.ts
export function registerPeerSink(id: number, sink: UiSink): void
export function unregisterPeerSink(id: number): void

// src/core/ui-sink-registry.ts (shared with the Server Edition, which registers browsers)
export interface UiSink {
  sendText(json: string): void        // RPC event frame: {t:'ev', channel, args}
  sendBinary(buf: Uint8Array): void   // pty:data, encodePtyData(sessionId, chunk)
  bufferedAmount?(): number           // bytes queued in the socket send buffer
}
```

- **Ids come from `allocateRelayClientId()`** (`src/core/presence/hub.ts`) — monotonic
  from `1_000_000`, so a peer id can never collide with a webContents id (those start
  small and count up). 4c mints one per connection and uses the *same* id for
  `presenceHub.join`, `registerPeerSink`, and every `sendTo`.
- **`bufferedAmount()` MUST report the relay socket's real buffered bytes.** This is the
  single most important contract in 4b. Stage 2's per-client backpressure *and* the 8 MB
  `WS_DROP_WATER` drop-and-redraw ceiling key on that one number. A sink that always
  returns `0` looks fine in every test and silently disables the ceiling: a slow peer
  then queues pty output without bound, nothing ever pauses the pty or drops its backlog,
  and the **host's memory grows until the host process dies**. If the relay carrier has no
  native `bufferedAmount`, 4c must compute one (bytes handed to the socket minus bytes
  flushed) — an honest number, not a placeholder.
- **`onPeerGone` is already wired at boot.** `src/main/index.ts` calls `wirePeerRegistry({
  setFlow, captureForResync, onPeerGone: ptyManager.dropClient })` exactly once. **4c must
  NOT call `wirePeerRegistry` a second time** — the deps are last-write-wins, so a second
  call silently overwrites them. Just call `unregisterPeerSink(id)` on socket close (or
  revoke, per 4d): it mirrors `src/server/ws.ts`'s close path exactly — `presenceHub.leave`
  → `PtyManager.dropClient` → registry prune (which also returns any pty pause that peer
  owed, so a shared terminal cannot freeze for the other viewers).
- **A sink that throws twice consecutively self-evicts** (`SINK_FAILURE_LIMIT` = 2; any
  successful send resets the count) and gets the full teardown above. So 4c's sink should
  **throw on a dead socket rather than swallow** (a write to a half-closed stream throwing
  `EPIPE` / `ERR_STREAM_WRITE_AFTER_END` is the signal), and must **not** throw transiently
  on a healthy one — two throws in a row will kick a live peer out of the session.

What 4b explicitly does **not** do:

- **No connection code.** There is no relay socket, no handshake, no framing — 4b is the
  registry seam and nothing else. 4c brings the carrier.
- **`phone-presence.ts`'s half-join is NOT retired.** It still only joins the hub; the
  bridged phone registers no sink, so it still receives nothing. Retiring it is 4c's job,
  when it makes the phone a real peer (register a sink under the id it already mints).
- **No inbound peer→core cast path** beyond what `onWithSender` already provides: 4b makes
  the core able to *talk to* a peer, not to *hear* one. Routing a peer's RPC calls into the
  core's `handle`/`on`/`onWithSender` handlers (with the peer's id as the sender) is 4c.

Proven end-to-end by `src/main/peer-integration.test.ts` against the REAL platform + hub +
canvas reflector: a registered peer receives `presence:sync` / `presence:peer` and seq-stamped
`canvas:mut`, and pty output fans out to its sink as `sendBinary` frames under the per-client
backpressure + drop-and-redraw ceiling (a slow peer is dropped and redrawn without stalling
the host window or a fast peer).

### The protocol path (4c)

`rpc.ts` frames tunnel through the relay's existing E2EE socket. On the peer's side,
the renderer boots the **ws-bridge builders** over a relay-backed frame source instead
of a WebSocket — everything above the socket is shared with the browser path.

Two carrier requirements the relay socket must meet (the WS gave them for free):
- a `bufferedAmount` equivalent — Stage 2's per-client backpressure and the 8 MB
  drop-and-redraw ceiling key on it;
- FIFO delivery per connection — Stage 3's `seq` total order assumes it (the relay's
  single E2EE stream already provides this; it must stay single-stream).

Deleted with the old dialect: `framing.ts` opcodes, `snapshot.ts` (replaced by
`PtyCreateResult.screen`, which solved join-painting generally in Stage 2),
`host-service.ts`'s RPC vocabulary, `host-canvas-hub.ts` + `canvas:state` full-state
push (replaced by the seq-stamped reflector), `sanitizeClientMutation` (superseded by
the trust decision), `RemoteTransport`, `RemoteSessionView` (replaced by the remote
tab).

### Trust (4d — scoped to the crypto/pairing layer)

- The peer's device key becomes **persistent** (today the client key is ephemeral)
  and is **pinned on both ends**; SAS (6-digit) is verified **mutually**.
- Revocation is a first-class action (facepile avatar → "Remove"): it unpins the key
  **and kills the live session** — closes the relay connection, drops the peer's pty
  subscriptions, leaves presence. Unpinning alone would leave the peer connected.
- 4d deliberately does NOT touch the `host-service`/`client-service` handshake code —
  4c rewrites those files; 4d ships the key/pin/SAS/consent layer (`pairing.ts`,
  `e2ee.ts`, `approved-devices*`, invite/consent UI) as a library 4c wires in.
- **4d delivered (library, wired by 4c):** persistent peer identity
  (`src/main/remote/peer-identity.ts` + pure `key-file-codec.ts`); mutual SAS + pin-both-ends
  (`src/main/remote/mutual-approval-core.ts`); revocation with the `onRevoke` kill hook
  (`src/main/remote/revocation.ts` — unpin persists, then the hook cuts the live session); consent
  copy (`src/shared/remote/consent.ts` `describeGrant` + `ConsentNotice.tsx`). The existing crypto
  tests (`e2ee`, `pairing`, `relay-id`, `approved-devices-core`) pass unchanged.
- **Open product decision — license:** Pro currently gates only the host's token
  mint. The peer-to-peer story (host pays? both? invitee free?) is undecided; the
  spec records it as open rather than guessing.

### 4d → 4c interface (the exact seam 4c wires)

4d is an **inert library** — no connection code, no IPC, no UI beyond the leaf
`ConsentNotice`. Nothing runs until 4c wires it into the rewritten handshake. The exact
surface 4c consumes, gathered from the six 4d tasks:

**Persistent peer identity** (`src/main/remote/peer-identity.ts`, I/O wrapper — the only
4d module that imports `electron`):

```ts
function loadOrCreatePeerKeyPair(): Promise<KeyPair>   // throws PeerKeyLockedError (code E_PEER_KEY_LOCKED)
function resetPeerKeyCache(): void                     // test seam only
class PeerKeyLockedError extends Error                 // encrypted key + keyring locked ⇒ do NOT regenerate
```

Replaces the ephemeral `genKeyPair()` at `client-service.ts:286`. The public key is the
stable identity a host pins across reconnects. `PeerKeyLockedError` must surface to the
user ("unlock the keyring and reconnect") — never regenerate over it.

**Mutual approval** (pure, `src/main/remote/mutual-approval-core.ts` — no electron):

```ts
type MutualApproval    // opaque/branded; only emptyMutualApproval can construct it
function emptyMutualApproval(peerKeyB64: string, sessionId: string): MutualApproval
function confirmLocal(s: MutualApproval): MutualApproval
function confirmRemote(s: MutualApproval): MutualApproval
function isMutuallyApproved(s: MutualApproval): boolean
function recordApproval(store: ApprovedDevices, s: MutualApproval): ApprovedDevices   // pins s.peerKeyB64 only when both confirmed
function mutualSas(shared: Uint8Array): string                                        // "NNN NNN"; alias of sasFromSharedKey
```

Flow: `emptyMutualApproval(peerKeyB64, sessionId)` → `confirmLocal` on this human's SAS
match → `confirmRemote` on the peer's confirm frame → `recordApproval(store, state)` pins
the peer's key (each end pins the other's; idempotent). One state per pairing attempt.

**Revocation** (pure core + hook, `src/main/remote/revocation.ts` — no electron):

```ts
function revoke(store: ApprovedDevices, peerKeyB64: string): ApprovedDevices   // pure unpin, idempotent
type OnRevoke = (peerId: string) => void | Promise<void>
interface RevocationDeps { load(): Promise<ApprovedDevices>; save(s: ApprovedDevices): Promise<void>; onRevoke: OnRevoke }
interface RevokeResult { persisted: boolean; killed: boolean }
function createRevoker(deps: RevocationDeps): { revoke(peerKeyB64: string): Promise<RevokeResult> }
```

4c implements `onRevoke(peerId)` = close the peer's relay connection →
`PtyManager.dropClient(clientId)` → `presenceHub.leave(clientId)` (the same teardown
`peer-registry.ts` runs on sink unregister). `revoke()` unpins on disk FIRST, then fires
the hook. `persisted:false` ⇒ pin may survive, the UI must NOT show "Removed" and must
retry; `killed:false` ⇒ the cut is unconfirmed. `peerId` is the peer's stable box public
key (base64).

**Key-file codec** (pure, `src/main/remote/key-file-codec.ts` — no electron; `safeStorage`
injected as `SafeStorageLike`):

```ts
function encodeKeyFile(keys: KeyPair, safe: SafeStorageLike): string
function decodeKeyFile(raw: string, safe: SafeStorageLike): { keys: KeyPair; migrate: boolean } | null | 'locked'
```

`e2ee.ts` gained `secretKeyFromB64(b64)` (strict 32-byte, mirrors `publicKeyFromB64`) —
the only edit to a pre-existing crypto file, additive.

**Consent copy** (`src/shared/remote/consent.ts` + `src/renderer/remote/ConsentNotice.tsx`):

```ts
const SHELL_ACCESS_CONSENT: string
function describeGrant(peerLabel: string): string       // "<name> will be able to run commands on this Mac — the same as giving them SSH access."
function ConsentNotice({ peerLabel }: { peerLabel: string }): JSX.Element
```

4c places `<ConsentNotice peerLabel={…} />` in the actual invite/approve dialog.

#### SECURITY-FATAL obligations 4c MUST honour

These are the whole point of the trust layer. The pure modules cannot enforce them across
the connection seam — 4c owns them, and breaking any one silently grants a MITM shell
access on this machine:

- **(a) `confirmRemote` may be driven ONLY by a frame received over the ENCRYPTED,
  session-keyed channel** (the box under `deriveSessionKey`) — never a plaintext or
  relay-visible message. A forgeable/replayable "I confirmed" signal degrades mutual
  approval back to one-way: the relay supplies the confirmation the second human never
  gave, and a single local confirm then pins the attacker.
- **(b) Exactly ONE `MutualApproval` per pairing attempt**, constructed via
  `emptyMutualApproval(peerKeyB64, sessionId)` from THIS session's ECDH peer key (the same
  key whose shared secret produced the SAS the humans compared). No reuse across attempts,
  no seeding with a different key.
- **(c) Revocation must call the kill hook, not just unpin.** Unpinning refuses only the
  NEXT handshake; the open socket keeps full shell access until it drops on its own. 4c's
  `onRevoke` must cut the live session.
- **(d) Adopt the codec in `host-service.ts` too.** Its existing `loadOrCreateKeyPair`
  (`host-service.ts:548`) has the SAME keyring-lock flaw `peer-identity` fixed: an encrypted
  `secretKeyEnc` key read while `isEncryptionAvailable()` is false at boot falls through both
  read branches and regenerates a fresh key (line 574), overwriting the good encrypted
  identity and forcing every host that pinned it to re-approve. 4d left `host-service.ts`
  untouched by design; 4c should route it through `key-file-codec` + the `'locked'` outcome.

### Persistence

A remote tab is a **connection bookmark**, never a workspace on the peer's disk — the
files live on the host; the peer cannot own them. Offline, the tab renders greyed
"unavailable" (reusing the workspace index's existing unavailable-ref rendering) and
reconnects on click. Host asleep ≠ data loss: processes keep running in the host's
tmux; reconnect re-enters via co-attach (Stage 2 already guarantees this).

**Documented limitation:** canvas edits made by the peer while disconnected are lost
(no offline queue in v1). Accepted, recorded here so nobody discovers it in the field.

## Split — branches and gates

| Sub-stage | Branch | Depends on | Merge gate |
|---|---|---|---|
| **4a** Session abstraction (renderer; local-only) | `feat/session-abstraction` | — | **Behavior-unchanged**: full suite + typecheck green, zero visible diff for a solo user |
| **4b** Client registry in `electronPlatform` | `feat/peer-registry` | — | **Landed** — peer sinks receive presence/canvas/pty through the real platform (`peer-integration.test.ts`); webContents path bit-identical; solo cost zero. Hand-off: "4b → 4c interface" above |
| **4d** Trust layer (keys, pins, mutual SAS, revoke) | `feat/peer-trust` | — | Crypto/pairing unit tests; revoke-kills-session hook tested against a fake connection |
| **4c** `rpc.ts` over relay; remote tab; delete old dialect | `feat/relay-rpc-main` | 4a+4b+4d | **Landed** — crypto/carrier gate (163 tests) + phone gate (77) pass **unchanged**; new-protocol `relay-tunnel.test.ts` (E2EE round-trip + pre-handshake refusal); full suite 1690 green. Manual two-instance acceptance pending (below) |
| **4e** Server Edition as a tab | `feat/server-tab` | 4a+4c | Same smoke script against a Server Edition box |

4a, 4b and 4d run in parallel worktrees. 4c is the join point and must not ship to
users before 4d is wired (it grants `pty.create` to peers).

## 4c landed — shipped surface, deletions, and deferred follow-ups

**What shipped (on `feat/relay-rpc-main`):**
- **Bridged api** (`src/renderer/bridge/relay-api.ts` `buildRelayApi`) — a full `NodeTerminalApi`
  over the E2EE relay `RelayFrameTransport`, reusing the ws-bridge builders. Core-bound namespaces
  (`pty`, `workspace`, `fs`, `git`, `files`, `context`, `canvas`, `presence`, `userDataDir`,
  `claude.cliCaps`) hit the **remote** core; app-global (`updates`/`clipboard`/`settings`/…) stay
  **local**. Two load-bearing exceptions: `pty.onData` reads the LOCAL per-session channel (relay
  pty output is re-emitted there by main), and `dialog.selectFolder/selectFile` are the in-app
  **host** directory browser (a remote tab's folder pick is a host pick — obligation d).
- **Remote session as a project tab** (`src/renderer/session/relay-tab.ts` `openRelayTab`,
  `Canvas.tsx`) — `createSession('relay', api, label)` bound to a projects tab; the Canvas subtree
  is keyed by `session.id` so an api swap remounts (4a obligation 3). Presence teardown held +
  disposed on disconnect (obligation 1); rename fans across all sessions via `setMeAll`
  (obligation 2). `LocalTransport(useSession().api)` IS the remote transport — one protocol, no
  separate `RemoteTransport`.
- **Offline + reconnect** — an involuntary drop greys the tab to "unavailable" and takes its
  session offline (kept + bound, presence left); a click reconnects in place with a fresh pairing
  code (the relay offer is single-use — no silent/pinned reconnect in v1). Edits while disconnected
  are lost (v1, no corruption). User-close fully disposes + removes; the two paths are distinct.
- **Consent at the grant moment** — the host approval dialog sources from `relayHost.onPeerPending`
  and shows `<ConsentNotice>` ("<peer> will be able to run commands on this Mac") above the SAS;
  confirm rides the encrypted tunnel; `enterConfirms={false}` so a stray Enter can't approve.
- **The desktop-client legacy dialect is deleted** (`RemoteSessionView`, `RemoteTransport`,
  `client-service`/`remoteClient` preload+channels, `data.remote`, `remote-fs.ts`, and the old
  client/relay e2e suites). The two settings dialogs were migrated to `relayClient`/`relayHost`.
- **Project-scoped sharing** (branch `feat/relay-project-scope`) — a relay tab now shows the host's
  ACTUAL project, not a blank canvas. **The host picks ONE project to share when it starts hosting**
  (`relayHost.start(projectId)`; default = active project; a chooser in both host UIs). The id is
  held on the host relay SESSION (`sharedProjectId`) — never in the pairing offer, so no project
  name leaks into a code that gets pasted around. The host **scopes the peer's `workspace:load`
  response** to just that project at the relay dispatch boundary (`scopeWorkspaceToProject`,
  `relay-host.ts`) — the core `workspace:load` handler is untouched, so a local window still gets the
  full workspace; the scope only ever NARROWS (a pure filter, verified it can't widen or leak the
  other projects' names/cwds/nodes). The client `openRelayTab` then `api.workspace.load()`s that one
  scoped project and **adopts** it (`useProjects.adoptProject({ ...hostProject, remote: true })` —
  fresh project id, host node ids kept so terminals co-attach to the host's tmux); Stage-3 mutation
  sync keeps it live. A relay tab is marked `project.remote` (runtime-only) and is **never persisted**
  to the peer's `workspace.json` (excluded in both `workspace-files.ts` and `toWorkspace`). Two
  bugs the integration surfaced and fixed: the renderer-global terminal maps
  (`parkedTerminals`/`coStates`/…) were bare-node-id-keyed, so a peer that had the SAME repo cloned
  locally could cross-wire a relay terminal onto its LOCAL pty on a tab switch — now keyed by
  `terminalKey(sessionId, nodeId)`; and a post-approval `workspace.load()` failure leaked the
  session — now disposed on the failure path. Sharing is **fixed per hosting session** (change the
  shared project = stop + restart hosting); re-fetching the host's current nodes on reconnect is a
  follow-up (the tab keeps its last-seen nodes until the next live mutation).
- **Live collaboration follows the active session** (branch `feat/relay-collab-session`) — with the
  tab populated, the LIVE layer now crosses the tunnel too: cursors, facepile, chat, focus chips, and
  canvas mutations (a node one side opens appears on the other). The root cause it fixed: Canvas's
  collaboration layer was bound to the LOCAL session — static `connectPresence`/`usePresence` imports
  plus `[]`/mount-bound effects that captured the mount-time (local) `api` — so on a relay tab presence
  never published/read over the tunnel and the canvas-mutation publisher cast to B's own core (and its
  publish gate saw no peers). The fix routes the whole layer through the ACTIVE session, re-bound on
  tab switch: a provider-independent `useActiveSessionPresence()` / `presenceForProject(activeProjectId)`
  (resolves the memoized per-core `PresenceSession`; unbound/local → `defaultPresence`, so LOCAL
  behavior is byte-identical); the presence components (Facepile/PresenceChips/PresenceLayer/
  PresenceNamePrompt) + the cursor/chat WRITE read/write the active session; Canvas's
  `connect`/`reportProject`/`reportFocus` and the `canvas:mut` publisher + `onMutation` re-key on the
  active session's **api object** (stable per core — so a local↔local tab switch does NOT reset the
  total-order/reconnect state, the documented invariant, while a local↔relay switch re-binds to the
  relay core). **Perf contract preserved:** Canvas reads presence IMPERATIVELY
  (`store.getState()`/`subscribe`), never a reactive `usePresence(selector)`, so a 20 Hz cursor frame
  never re-renders Canvas (`usePresence` was removed from Canvas entirely). Deferred: a background
  RELAY project (while a LOCAL tab is active) isn't live — only the active session's `onMutation` is
  subscribed; it re-syncs on reactivation.

**Retained on the OLD dialect (do NOT delete — a shipped feature):** the phone server path —
`host-service.ts`, `standing-host.ts`, `host-canvas-hub.ts`, `framing.ts`, `snapshot.ts`,
`src/main/remote/canvas-sync.ts` (`sanitizeClientMutation`), `phone-presence.ts`, the `remoteHost`
preload namespace, and `ssh-fs.ts` (live SSH). The renderer's phone canvas push is gated on
`settings.phoneAccessEnabled` (single-sourced — it used to hang off a separate `hosting` flag that
the dialect deletion orphaned, blanking the phone; that flag is gone).

**Deferred follow-ups (v1 scope calls — not bugs):**
- **iOS migration** — the phone stays on the old opcode dialect until *nodeterm mobile*
  (`~/projects/nodeterm-ios`) moves to the relay tunnel. The desktop-side rewire of `standing-host`
  onto the relay tunnel (so a migrated phone has a host to reach) is a **deliberate separate step**,
  NOT done in 4c — it breaks the shipped phone and needs an explicit go. Blueprint:
  `docs/ios-protocol-migration.md`.
- **`dialog` open-file / open-folder in a relay tab** — the worktree/clone pickers resolve on the
  host (obligation d), but the generic "open file"/"open folder" Canvas callers still use the
  global (LOCAL) dialog. Same `ScmScope`-style "which machine?" question; a scoped follow-up.
- **Relay tab persistence / bookmark** — a relay tab is deliberately NOT persisted (it is a live
  connection, not a workspace on the peer's disk — see project-scoped sharing below). A proper
  greyed-offline *bookmark* that survives an app restart (reconnect to a known host without a fresh
  pairing code) is not implemented; the tab simply vanishes on restart.
- **Reconnect re-fetch** — on a reconnect the tab keeps its last-seen nodes; it does not re-pull the
  host's *current* workspace, so nodes the host added while the peer was offline appear only on the
  next live mutation. Re-running `api.workspace.load()` into the bound project on reconnect closes it.
- **Change the shared project without dropping the session** — sharing is fixed per hosting session
  (change project = stop + restart hosting). A live "share a different project" control is a follow-up.
- **Agent status is not routed into the per-session stores** — `SessionStores.agentStatus`
  (`agentStatusForApi(api)`) is built for every session, but nothing writes the non-local
  instances: Canvas's `agent:status` subscription sits above the per-project session provider and
  writes the DEFAULT store, and `useSessionStores()` has no consumers. Cosmetic until #126's
  plain-shell protection landed, which reads a node's own session store to decide whether killing
  its terminal would end a running agent (`terminal/live-work.ts`) — so **relay parks/offscreen
  releases are unprotected**: a relay node always reads `undefined` there, and `persistent:false`
  can now legitimately arrive from a tmux-less relay HOST. The consumer side is already written
  against the seam and needs no change; what is missing is a subscription per session feeding
  `SessionStores.agentStatus`.
- **SDK chat node over relay** — refuses (`E_UNSUPPORTED`) in a relay tab, matching Server Edition.
- **The preload↔main relay IPC boundary is not covered by vitest** (it needs Electron). Two real
  send/handle + payload-shape bugs were found and fixed by inspection during 4c; the two-instance
  acceptance run is what exercises it live. A preload-shape unit guard would help.
- **Per-peer revoke UI** — LANDED with Team Access (below): each connected-device row's **Remove**
  calls `relayHost.revoke(id)` → `killRelayHostsByPeerKey` cuts that one live socket (the device
  must re-pair). Not a security gap either way — the desktop relay path never auto-approves from a
  pin (`isPinned` is phone/`standing-host` only), so every desktop reconnect needs a fresh mutual SAS.

## Team Access — multi-seat relay (paid, device-seat + email invite)

The single-peer relay host is now **Team Access**: the paying host shares this Mac with up to
`seats` teammates (one seat per connected device), $5/seat (Stripe, backend). The core
(`CorePlatform.clientIds()`, presence, canvas-sync, dino, cursor-chat) was already N-client; this
made the **host listener** multi-peer and packaged it.

- **Multi-peer pool.** `relay-host-service.ts` replaced the single `current` listener with a pool
  keyed by a renderer id: `byId: Map<id, { session|null, email? }>`. `relayHost.invite({projectId?,
  email?}) → { offer, id }` mints ONE pairing (one seat), ADDS to the pool (does not supersede), and
  is **cap-checked**; `relayHost.revoke(id)` cuts one; `stop()` closes all. The two legacy host
  dialogs route through the additive `invite` (via `start`). Each seat still goes through the full
  **mutual-SAS + ConsentNotice** — inviting N people is N deliberate shell-access grants.
- **Seat cap = the entitlement.** `core/license.ts` `Payload.seats?` (backend signs it; **absent →
  1** = today's single-peer; free → 0); the pure `canAcceptSeat(byId.size, licensedSeats())` refuses
  the (seats+1)th with `E_SEATS_FULL`. **The seat is reserved SYNCHRONOUSLY at mint (before the
  await) with a revocable id** — closes a cap race (concurrent invites) and makes an invited-but-
  never-connected seat reclaimable via `revoke(id)` (no ghost seat). Host-side enforcement is UX; a
  host bypassing its own cap only cheats itself — **v2 = server-side** (relay refuses per account).
- **Settings → Team Access** (`TeamAccessSection`) — not premium → the pitch + the shell-access
  disclosure ("a seat grants shell access, like SSH; every connection is SAS-verified") + a checkout
  CTA; premium → `Used X / N` (X = pending+connected, matching the cap), the connected-device list
  (email label + **Remove** → revoke), and **Invite** (email → `{offer, id}` → a pending row +
  Copy / Open-in-Mail share; the email is a display LABEL only, never trust). A renderer store
  (`state/teamAccess.ts`) tracks seats off the `relay:host:peer-pending/open/closed` events.
- **Backend contract (separate repo, api.nodeterm.dev):** the `seats` signer (Stripe per-seat
  subscription → webhook → the Ed25519 payload), optional real email delivery of invites (v1 the app
  generates + the user shares), and v2 server-side seat enforcement. Documented, not built here.
- **Follow-up:** a seat row shows the invite email + generic connected/pending state; joining a seat
  to its presence name/color (different id spaces — renderer UUID vs ClientId) is deferred.

## 4a → 4c interface (landed)

The session layer lives in `src/renderer/session/` (`session.ts` + `localSession.ts`).
These are the exact exported names 4c builds against — do not rename:

- **Types / context:** `WorkspaceSession` (`{id, source, label, api, status}`),
  `SessionSource` (`'local' | 'relay' | 'server'`), `SessionContext`, `SessionProvider`.
- **Hooks:** `useSession()` (the current session; components read `useSession().api`),
  `useSessionStores()` (that session's per-session store instances),
  `useProjectSession(projectId)` (the session a tab belongs to).
- **Registry:** `createSession(source, api, label)` (idempotent per id; builds the
  per-session stores once), `getSessionStores(sessionId)`, `setActiveSession(sessionId)`,
  `getActiveSession()`, `activeSessionApi()` (non-component code's api accessor),
  `sessionForProject(projectId)` (runtime-only tab → session resolver; returns the
  local session today), `sessionCount()` (gates multi-session-only UI, e.g. the tab
  session label), `resetSessionsForTest()`.
- **Per-session store factories:** `createPresenceSession(api)` (`state/presence.ts`)
  and `createAgentStatusSession(persistKey?)` / `agentStatusForApi(api)`
  (`state/agentStatus.ts`) — the api-keyed entry points are **memoized by API
  IDENTITY**, so the local api resolves to the historical singleton instances and a
  repeat api never builds a second subscriber; `SessionStores` is the pair the
  registry holds per session.

The project → session binding is **runtime-only**: `workspace.json` / `project.json`
gained no field, and `state/projects.test.ts` has a tripwire asserting `toWorkspace()`
never emits a session field. `session/grep-gate.test.ts` enforces that no production
renderer file outside the session layer / bridge reads a core-bound namespace
(`pty|fs|git|chat|workspace|presence|canvas` + the agent event streams) off
`window.nodeTerminal`.

**Obligations 4c inherits** (surfaced by the 4a reviews — read before wiring a remote
session):

1. **A remote session's presence instance has no disposal path.** `createSession`
   builds the presence store (with its live subscription) and nothing ever tears it
   down. Whoever mounts a remote canvas MUST hold the teardown returned by the
   presence session's `connect()` and call it on disconnect, or the store keeps
   subscriptions on a dead connection.
2. **`setMe` only re-helloes its own session.** Renaming yourself updates and
   re-broadcasts on the session it was called on; another live session keeps
   broadcasting the old name until reload. 4c needs a fan-out across sessions or a
   shared identity slice.
3. **Resource effects capture `api` in their closures — 4c must REMOUNT on api
   change.** This is deliberate in 4a: adding `api` to a `[]`-dep resource effect
   (TerminalNode's PTY, EditorNode's Monaco, ChatNode's driver) would create a SECOND
   PTY/Monaco/chat driver on any api change. The consequence: if a session's api is
   ever swapped IN PLACE (reconnect building a new RPC client under the same session),
   those nodes keep talking to the OLD core until remount — and `EditorNode` would
   LOAD from core A and SAVE to core B. **4c must key the session's subtree by session
   id / api identity so an api change remounts it.** This is the most important line
   in this hand-off.
4. **`CloneRepoDialog`'s folder picker is client-local.** The native directory picker
   chooses a path on the CLIENT machine while the clone runs on the SESSION's core —
   harmless today (same machine), wrong on a remote tab. 4c must route the picker per
   session (the Server Edition's in-app server-directory browser is the precedent).
5. **Deferred namespaces still read off the global:** `sshProject`, `contextLink`,
   `context`, `transcripts`, `handoff`, `files`. They live in files 4c rewrites; 4c
   must decide each one (core-bound → session, or app-global → stays on the client).

## Testing

- **Core tests are transport-agnostic** (~150 tests against the `CorePlatform` fake)
  and already cover presence/co-attach/convergence — they prove the core, unchanged.
- **4a's gate is the strongest**: a pure refactor proven by "nothing changed" — the
  entire existing suite, plus a grep gate (no `window.nodeTerminal.pty|git|fs|...`
  outside the session layer).
- **The new relay-carrier test (4c's core deliverable):** two cores in one test
  process joined by an in-memory relay, `rpc.ts` tunneled; asserts hello→presence
  sync, cross-tunnel co-attach (one spawn, both painted), `canvas:mut` seq stamping,
  and the backpressure signal (a slow peer trips the drop-and-redraw ceiling).
- **Blast radius of deleting the old dialect** — 18 test files, ~97 tests, three fates:
  - *deleted with the code* (~49): `framing`, `snapshot`, `host-handlers`,
    `client-handlers`, `host-canvas-sync`, relay `canvas-sync`,
    `client-canvas-router`, `remote-fs` — they test the dialect itself; the
    replacement path has its own net on the Server Edition side.
  - *must survive unchanged* (~24): `e2ee`, `pairing`, `relay-id`,
    `approved-devices-core`, `relay-socket` — the carrier + crypto layer. A 4c that
    breaks any of these has cut too deep; this is an explicit merge gate.
  - *rewritten* (~20 + 2 skipped e2e): `remote-security`, `standing-host`,
    `host-service.presence`, `relay-e2e`, `b5-e2e` — same concerns, new protocol.
- **Manual acceptance = the Stage 1–3 two-client smoke script, unchanged, over the
  relay** between two app instances (`NT_MULTI=1 NT_USER_DATA=...` — already
  supported), plus relay-specific steps: host sleep/wake (peer's terminal returns via
  co-attach), cable pull, revoke mid-session (peer is cut immediately), edits while
  disconnected (verify they are lost *and* nothing corrupts).
- **4c two-instance acceptance checklist (run before merge — the live gate the vitest
  suite can't reach, since the preload↔main relay IPC needs Electron):** on one Mac,
  launch two instances (`NT_MULTI=1 NT_USER_DATA=/tmp/nt-A npm run dev` and a second with
  `/tmp/nt-B`). Then:
  1. On A, start a remote host (New Remote Connection → host), **pick which project to share**
     (default = active), and copy the pairing offer.
  2. On B, paste the offer → both show the **same 6-digit SAS** → B sees the **ConsentNotice**
     on A's approval → confirm on both → the **shared project opens as a tab on B, already
     populated with A's nodes** (NOT a blank canvas — this is the project-scope check). B sees ONLY
     the shared project, not A's other projects.
  3. Type in a terminal on the tab → it runs on A (the host) and both painters show it
     (**co-attach**). Add/move a node on either side → it syncs to the other (Stage-3 mutations).
     **Live-collaboration check:** B sees A's **cursor** (Figma-style, with name) and A's **face**
     in the facepile, and vice-versa; a node opened/moved/deleted on EITHER side appears on the
     other; chat bubbles cross. (If the canvas populated but cursors/broadcast are missing, the
     active-session collab wiring regressed — see "Live collaboration follows the active session".)
  4. Sleep/wake A → the peer's terminal returns via co-attach (tmux still alive).
  5. Pull B's network → the tab **greys to "unavailable"**; restore + click → **reconnect**
     with a fresh code; disconnected edits are lost, nothing corrupts.
  6. **Cut a live peer** — today via **host-stop** (New Remote Connection → stop hosting, or
     `relay:host:stop`): B's session dies immediately (the open socket is torn down, not just the
     next handshake). Per-peer revoke (`killRelayHostsByPeerKey`) is built + tested + cut-wired but
     has no renderer trigger yet (see deferred follow-ups) — so v1 cuts *all* peers via host-stop.
  7. Confirm the **phone still works** on its own dialect (enable Settings → Phone on A,
     connect the iOS app) — the client-dialect deletion must not have touched it.

## iOS (separate repo — tracked, not same-PR)

**4c kept the phone dialect, so the phone still works today** — the deletion in Task 10 was
scoped to the desktop-**client** dialect only; the phone's `standing-host` + `host-canvas-hub` +
`framing`/`snapshot` path is intact and still boots. So the phone is NOT stranded by 4c.

The migration is a **future, deliberate** two-part step (NOT done in 4c because it breaks a shipped
feature without an explicit go):
1. **iOS repo** — the Swift client rewrites its wire layer against `rpc.ts` (it currently speaks the
   opcode dialect). Blueprint: `docs/ios-protocol-migration.md`. It then gains named presence
   (`presence:hello`), git, agent status, co-attach, and the typing badge it already half-had.
2. **Desktop** — `standing-host` is rewired onto the relay tunnel (`relay-host`) in lockstep, so a
   migrated phone has a host to reach, and the old dialect files are finally deleted. Only once
   both land does the phone move to the tunnel; until then it stays on the retained old dialect.
The nodeterm-desktop protocol work (the tunnel + bridged api) is complete at 4c; the iOS task
should be filed the day 4c merges.

## Out of scope (v1)

Mixed-home canvases; an offline edit queue; >LWW conflict semantics (Stage 3's
documented races carry over); voice/video; follow mode; guest/read-only roles;
license enforcement changes (open decision above).

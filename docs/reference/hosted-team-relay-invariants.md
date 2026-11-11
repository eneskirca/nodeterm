# Hosted team relay (Server Edition as a relay host) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Hosted team relay (Server Edition as a relay host)

A Server Edition core can host a team over the E2EE relay: a standing listener on the tunnel
dialect, owner approval, roles, a `team` admin CLI, and desktops joining with a
`nodeterm://join?code=…` code. Operator guide, roles table, join-error table, limitations and the
device checklist: **`docs/hosted-team-relay.md`**. The relay mechanism moved to `src/core/relay/`
(`src/main/remote/` keeps re-export shims), and Team Access and the hosted team run the SAME
`connectRelayHost`: a host that passes no `RelayHostHooks` (the desktop) takes the unhooked path.
The invariants, each with its reason:

- **Roles are enforced in core, deny-by-default in BOTH directions** (`core/relay/access-policy.ts`).
  A Viewer/Commenter reaches a method only if `VIEW`/`COMMENT` lists it, and receives an event only
  if `VIEW_EVENTS` does: the core broadcasts to every attached client (the debug log, whole project
  documents), so an allow-by-default filter would hand a viewer whatever nobody remembered to list.
  **"Read" is not "safe"**: relay peers were fully trusted, so every VIEW entry carries its own
  argument check. `fs:*` is realpath-jailed to a shared project's realpathed cwd; `git:diff` jails
  the FILE too (`--no-index` diffs any file on the host); a `git:show-file` ref starting with `-`
  is an option (`--output=` writes a file); **every git read also needs the shared root holding
  the cwd to be the top of its OWN repository** (a `.git` dir holding `HEAD`, or a worktree's
  `.git` file; git skips an empty `.git` dir): `git show <ref>:<p>` resolves `<p>` against the
  repository's top level and `git status`/`log` report the whole repository, so from a shared
  `repo/shared/` a Viewer read `repo/secret/key.txt` (measured, C1) — a monorepo subfolder gets no
  git panel; `pty:create` is cut down to a whitelist, because
  `sshRemote`'s args run `ssh` on the host during the existence probe. A non-editor's terminal
  frames (output, resync, size, exit) are judged per frame by the session's node
  (`PtyManager.nodeOfSession`), because a subscription outlives `team unshare`. Editors pass untouched
  (Editor is shell access). The UI mirror (`@shared/hosted-access.ts`, `bridge/hosted-gate.ts`) is
  convenience; `access-policy.guard.test.ts` pins it equal and fails on any relay-API channel
  nobody classified.
- **The role is read from `team.json` on every message, never cached on a session**, so a removal
  or promotion applies to the next message. A session with NO team entry is served nothing: that
  is the window between a removal's write and its kill. The one exception is `pinFailed` (both
  humans approved but the pin write failed), served as Viewer. The renderer, by contrast, reads the
  role once per connection; that is UX only.
- **A viewer's size never votes, and a viewer's create is join-only.** `sizeVote: false` (a
  non-voting re-join also WITHDRAWS an earlier vote under the same subscriber key) and `pty:resize`
  rewritten to `(null, null)`: a small window must not shrink everyone's terminal. `joinOnly`
  asks the STRICT exact-target probe (`has-session -t =nt-<id>`), refuses when it cannot tell, and
  reattaches without `-D`. The folded probe reads a tmux error as "exists", which is the safe answer
  for an owner and would let a viewer's `new-session -A` CREATE the session.
- **The host key is never silently regenerated** (`host-key.ts`). Its public key IS the team's
  address (`hostId`), so a new key orphans every bookmark and sends every teammate back through
  first-join approval. Unreadable ⇒ hosting stays off with `host-key-unreadable`; only
  `team rotate-key` replaces it.
- **`team.json` is not the phone's pin file.** Push's `hasPairedPhone` counts the entries of
  `remote-approved-phones.json`, so a teammate pinned there would read as a paired phone. The same
  rule on the joiner: `hosted-join.ts` runs the core relay client with NO pin store, and the
  joiner-side pin is the bookmark's `approvedAt` (valid only for the exact host key it was recorded
  with).
- **The admin channel is a 0600 unix socket in a 0700 directory, with no token**
  (`core/relay/team-admin.ts`). Filesystem permissions are the whole gate, so there is nothing to
  leak into a pane's environment. The root of trust is the core's unix user, which also means an
  Editor's shell can run `team add-owner`. With no team, the socket serves only
  `init`/`status`/`info`/`bootstrap` (`bootstrap` is `init` plus the rest). The `relay:hosted:*`
  verbs are intercepted inside the relay session and never registered on the platform, so a Server
  Edition browser client cannot call them. An interceptor bypasses `access` and every jail, so each
  one judges the CALLER's own session key.
- **LOCAL confirms have exactly four call sites on the host side:** the Team Access dialog
  (`relay:host:confirm`), `autoApprove` for a key `team.json` pins, an owner's
  `relay:hosted:approve`, and a live link's `autoApprove` for the ONE viewer key derived from that
  link's own secret, read from the host's own link record (any other key is denied at once, never
  asked — `docs/live-links.md`). The joiner side has two: the human's `relay:client:confirm`, and the
  bookmark auto-confirm. The one remote confirm still arrives only on the encrypted tunnel. A new
  local confirm is a design change; the comment in `relay-trust.ts` lists all six.
- **Nothing is served before mutual approval.** Frames that arrive between approval and open (while
  the pin is being written) are HELD, at most `HELD_FRAMES_MAX` (256), then served through the same
  checks. Refusing them would fail a new teammate's first `workspace:load`, which routinely lands
  inside the host's pin write. Pending join requests go to connected OWNERS only (never a
  broadcast), at most one per device key and 16 at once, and expire after 10 minutes. A deny or
  expiry that lands during the pin write wins.
- **The scheduler's backoff resets only on proof the relay leg works** (an idle listener held to
  its refresh, or a completed handshake) or on a fresh `start()`, never on a successful mint. With
  the API up and the relay down every mint succeeds and every socket dies, and a reset-on-mint
  re-minted at round-trip speed (relay log, 2026-09-27). Successful mints are also capped at 200
  per rolling hour, whatever asks for them (the backend's free limit is 240).
- **A host-token mint and host-mode push prove the caller holds the relay host key's secret half
  (R44)** — device mints and join slots still take no proof (see "Still open" below). A
  join code carries the host's device id and public key, which used to be all a host-token mint
  asked for, so a code holder could spend the host's hourly mints. Now the host-token mint (desktop
  phone relay and Server Edition hosted mint) and the desktop's host-mode push first take a
  challenge from `/v1/relay/challenge` and send a proof. Rules a refactor must not undo:
  - **`src/core/relay/relay-pop.ts` is the ONLY computation of the relay PoP proof** (the
    host-token mint and push host-auth), and it refuses an all-zero shared secret (a low-order
    server key gives every caller the same secret). Its bytes are pinned by `relay-pop-vector.json`,
    mirrored byte for byte in nodeterm-server: a protocol change changes both. The push webhook's
    management proof (`core/push-webhook.ts` `webhookProof`, § Push webhook) is a SEPARATE,
    independent proof of the same host key, with its own challenge route
    (`/v1/push/webhook/challenge`), its own context string and its own wire contract (nodeterm-server
    `src/lib/host-proof.ts`). Do not fold either one into the other; the all-zero refusal here does
    not cover it.
  - **A request goes out unproven ONLY when the challenge answered 404/405** (a backend that
    predates the proof). **One exception, push only:** a challenge answered 200 followed by
    `/v1/push/host-auth` answering 404 also posts unproven, and that verdict is cached 10 minutes like
    a 404/405 one (`push-notify.ts` `establish`). One backend registers both routes or neither, so
    this happens only in a redeploy window; push stops nothing, and the backend gates the unproven
    post regardless (a latched host's is refused, which forgets the verdict, and the host proves
    again). Never after a transient failure (5xx, 429, network, an unusable challenge):
    the backend LATCHES a host at its first valid proof and refuses an unproven request from it
    (`403 pop_required`; every host after `POP_REQUIRED_AFTER`, default 2027-01-01), so an
    unproven mint there would stop hosting. Conversely, a `pop_required` answer to a mint sent
    unproven after a 404/405 is TRANSIENT: a reverse proxy answers 404 while the backend redeploys.
  - **A key-proof refusal stops hosting only on the SECOND in a row**, with a fresh challenge in
    between, on both editions: a `POP_SECRET` rotation or an instance mismatch inside one
    challenge-then-mint pair refuses an honest host once. A transient failure between the two does
    not reset the count; only a successful mint or a restart does. The Server Edition says
    `POP_REFUSED_MESSAGE` (it names `team rotate-key`); the desktop shows ONE dialog with
    `POP_REFUSED_MESSAGE_DESKTOP`, which must never name `team rotate-key` (Server Edition only).
  - **Push uses a 15-minute `hostAuth` session from `/v1/push/host-auth`**, re-proven after 10
    minutes on the client's clock (at once if that clock has stepped back since: a negative age is
    expired), one per stream (`core/push-notify.ts` `createHostAuthCache`). An
    old-backend verdict is cached 10 minutes; failed proofs back off 0/5/15/60 s (a hold further out
    than 60 s is a backward clock step and is ignored); overlapping flushes share one proof; a proof
    that throws is a failure, never a rejection. A batch that cannot be proven is DROPPED, never sent
    unproven. An unproven post refused 403 under a verdict cached from an EARLIER batch means the
    host latched elsewhere: that batch re-proves and re-posts once.
  - **Still open**: the team's 10 daily device mints and the 16 pending join slots (those routes
    take no proof), and, before a host's first proof, a code holder's legacy listeners evicting its
    idle one through the relay's 8-per-host cap. Recovery is a fresh `<dataDir>/device-id` +
    `team rotate-key` + fresh codes. Full write-up and the rollout (backend first; `POP_SECRET` set,
    boot log without `DISABLED`): `docs/hosted-team-relay.md` § Host key proof of possession.
- **The joiner never mints a device token it cannot keep.** Device mints are damped per HOST device
  id, so one team shares 10 a day. It probes the bookmarks file before minting and sends a PER-TEAM
  device id (`<machine id>:<hostId>`), because the backend will not re-register one id for a second
  host. Every failure carries a stable `[E_JOIN_…]` code, which is the only part of an error that
  survives Electron IPC. Only `E_JOIN_NETWORK` and `E_JOIN_THROTTLED` (at least 60 s) retry
  unattended. A drop the host did not explain retries 5 times (1/2/4/8/15 s), then stops and says so.

**Shared canvas authority** (doc section of that name; ordering rules in `docs/team-presence.md`).
`canvas:mut` carries nodes, edges (`edge-*`) and board items (`kb-*`, `shared/kanban-ops.ts`).

- **On the Server Edition, only the canvas authority writes a shared project's content**
  (`core/canvas-authority.ts`: nodes, bridges, ropes, board items; only in the process that owns the
  team). A client's whole-workspace save is a stale copy of every canvas it holds, so saves AND
  loads pass through the authority's overlay (`WorkspaceStore.setContentAuthority`), and an outside
  edit (a `git pull`) is adopted and published as ops instead of `workspace:external-change`, whose
  conflict bar would offer "Keep mine" over it; the persisted project follows on
  `workspace:server-change` (silent merge), or a stale tab's autosave would revert the pulled
  non-content fields, `defaultPermissionMode` and the capability flags included. It writes 1 s
  after the last op, at most 5 s after the first. The consequence for code: **a content change that is not cast as an op is dropped by
  the next overlaid save.** That is why server canvas control casts a diff of the whole content
  before every save (`castAndSave`, never a per-verb list, which drifts), and why a hosted relay
  peer may not `workspace:save` at all (refused for every role). One exception: a node too large
  to travel as an op is taken from saves. **Exec fields never enter the authority's state** —
  `shell`, `ssh.extraArgs`, and `pendingLaunch`, which the reflector strips from what it hands the
  authority even on an owner's op: a save carries this machine's own values onto the overlaid nodes
  (`carryLocalNodeExec`), and that carry is how an armed `--after` node — and server canvas
  control's claim/clear of its launch (`savePatches` → `castAndSave`) — reaches the index's
  `localExec` on a governed project. For the same reason the authority's outside-edit diff is
  published UNTRUSTED (`publishCanvasMutation(id, m, { trusted: false })`): vouched as a core write,
  its launch-less upserts read as "cleared" on every owner tab, and a git pull cancelled queued
  `--after` launches. **Server canvas control delivers only what landed**: `open` and
  `run` launch nothing when their write-ahead `castAndSave` was refused (canvas control stopping),
  and `refreshArmed` types a held command only when `savePatches` says both that the save landed and
  that its claim applied to the fresh read (a teammate may have deleted, re-armed or claimed the node
  since the verb looked); `NodePatch.apply` answers whether it landed.
- **One reducer, `applyCanvasOp`** (`shared/canvas-content.ts`), applies an op to the authority's
  state and to every client's STORED copy of a project (background projects, and every board op).
  Two appliers is how an authority and its clients silently diverge. The only other applier OF A
  RECEIVED OP patches the active project's live React Flow array for node ops
  (`applyMutationToFlow`), because a trip through the serializers would wipe the selection; live
  edge ops go through the reducer's own edge applier, `applyEdgeMutationToScene`. THIS renderer's
  own node writes into a background project are not received ops and take `applyOwnNodeMutation`
  (unstripped: the held launch is ours to set or clear — see the `pendingLaunch` paragraph). **The
  node publisher never casts them** (it diffs React Flow, and a load is ADOPTED as its baseline), so
  every own writer of the projects store (`applyOwnNodeMutation`, `appendCanvasLinks`, and the
  sessions sidebar's `renameNode` / `recolorNode` / `removeNode` / `moveNodeToGroup` / …) runs
  through `ownWrite`, which hands a lazy diff of the project's nodes and edges to
  `setStoredCanvasPublishHook`; Canvas casts it only for a GOVERNED project that is not the one React
  Flow holds (`canvas/stored-publish.ts`). Without it a ⌘⇧T reopen or a cold open into an off-screen
  shared project was dropped from disk by the next overlaid save, and a sidebar close killed the
  session while the overlay put the node back. An ungoverned project casts nothing new.
- **The solo-gate trap.** The publisher casts nothing while no teammate is attached, and on a governed
  project that loses every edit. The gate is `shouldPublishFor` = `(hasPeers || governed) && sameCore
  && !readOnly`: a Server Edition tab publishes every project until its first `canvas:authority`
  answer and re-asks on reconnect, and neither our own echo nor a src-less core op proves a peer
  (`provesPeer`). The desktop answers `[]`, so it is unchanged.
- **Prune removals are never cast** (`diffKanbanOps`' `liveNodeIds`). Every board commit prunes the
  cards of nodes that are not live locally, and a client whose node op has not arrived yet would
  otherwise cast the removal of a fresh card for everyone. `liveNodeIds` is one project's nodes
  (React Flow's for the rendered project, the Omni board's live lane included). Card and meta
  removals are last-writer-wins VALUES; only node, edge, column, label and view removals are rule-4
  deletions.

**Share with team (SSH → hosted team)** (doc section "Share with team from the desktop"). A desktop
SSH project's "Share with team…" installs (or just probes) nodeterm-server on the host as the SSH
login user, runs `team bootstrap` (init + owner + adoption by real path + share, one idempotent
admin verb), hands the terminals over (`team resume`) and joins. The renderer sequences it
(`lib/shareSshTeam.ts`, pure, every effect injected), main runs each step as ONE generated command
over the ControlMaster (`main/remote-ssh/share-team.ts`; the server binary, `main.cjs`, data dir and
the adopted folder come from the cached, validated probe, never from the renderer), and every command
is built in `core/remote-ssh/share-team-remote.ts` and run under a real `/bin/sh` by its test. The
invariants:

- **Never a home directory, at three layers.** A new SSH project's folder is `~`, and every teammate,
  Viewers included, may `fs:read` anything under a shared folder (the jail is the shared root and
  nothing else), so sharing the home hands out `~/.ssh`, the agents' credentials and the hook
  tokens. The probe prints the home's real path (`homeReal`); `sharePlan` refuses the root, the home
  and any ancestor of it, segment-wise (`SHARE_REFUSAL.homeFolder` / `homeAncestor`), and a home it
  could not read refuses rather than guess (`homeUnknown`). Main re-reads the cached probe's plan
  before every step (install only for a plan that does not refuse, bootstrap and resume only for a
  ready one) and bootstrap adopts THAT probe's folder; `bootstrap(projectId)` takes no path. The
  server's `adoptFolderNow` refuses the same set on real paths (`E_BAD_CWD`, against
  `os.homedir()`), so a hand-run `team bootstrap --adopt ~` is refused too.

- **Handover ordering: nothing ends before `bootstrap` succeeded; nothing is resumed before its old
  session is VERIFIED gone.** The kill runs on the host's `node-terminal` ONLY (`RMT_TMUX_SOCKET`,
  which is the same socket the server core resumes on since the 2026-11 unification — the kill
  precedes the resume, which is what keeps one process per conversation), with the exact target
  `-t '=nt-<id>'` built only through `sessionName`, then a `has-session` per node.
  `gone` needs tmux's OWN absence message: exit 1 is also a client/server protocol mismatch or a
  socket it may not open, where the kill failed too, and reading those as gone starts a second agent
  on one conversation (two CLIs appending to one transcript). `alive`/`unknown` nodes are reported
  "still running on SSH" and never resumed. **Never the every-socket kill** (`KILL_TMUX_SOCKETS`):
  `node-terminal` on that host is where the server core starts the very sessions being handed over.
  Every failure after the mark and before a successful bootstrap undoes the mark and reopens the
  project (and says so when the undo itself fails); after it, the SSH project is NEVER reopened,
  even when the kill or the join fails, because that would be a second writer. `team resume` re-asks
  with the core's exact `sessionVerdict` (the folded `sessionExists` prefix-matches): present ⇒
  `already-running`, unknown ⇒ refused, and a node another request in this process is still
  launching is `already-running` too (`ResumeDeps.inFlight`, ONE set per server process, claimed
  before the first await): the desktop's call times out at 60 s while the server keeps draining, so
  a re-run never doubles an agent.
- **What may be handed over is read twice, and only what the user confirmed may change nothing.**
  Busy is `working`, `blocked` AND `waiting` (a Codex approval prompt and an open AskUserQuestion
  are `waiting`); an agent only the status store knows (launched by hand) counts as busy
  (`ShareNode.liveAgentId`) but is never resumed — resume stays on `node.agentId`, so a stale status
  agent cannot make the server type `claude --resume`. A terminal attached to another host
  (`otherHost`, `sshConnectionIdForProject`) refuses the share by title: its kill on the project's
  host would read "gone" and leave it running elsewhere. The orchestrator re-reads the canvas
  (`ShareDeps.canvas()`, which commits the live canvas first) right before the mark: a busy agent or
  a changed terminal SET refuses with nothing changed, and the handover then uses that read. The
  flush check compares EVERY node id of the project (notes, frames) with the host's file, read
  again at the flush, because the server adopts that file.
- **Single writer: `handedOffTo` (machine-local, index entry only, never in `project.json`).** The
  in-progress mark (`{at}`, no `hostId`) is set and SAVED before the mirror flush, not at the close:
  a save between the flush and the close would otherwise queue a throttled mirror write that lands
  after the server adopted the file. From then on `mirrorSshCache`, `reconcileSsh`, the 15 s poll
  (`pollableSshProjectIds`; `sshProjectIds` stays IDENTITY, a handed-off project is still somebody
  else's machine), `kanbanWriteNow` and `pushSshSettings` all skip the entry, and the field survives
  restarts (threaded through every `fileToProject` base; a file field of that name is ignored).
  Every reopen path (Recently closed, ⇧⌘T, `openSshProject`'s endpoint reuse) warns first, and only
  "Open here anyway" clears it. That answer also marks the project's terminal nodes to skip their
  automatic cold-resume ONCE (`terminal/handed-off-resume.ts`; the node raises `CoState.resumeSkipped`
  and says why): the share killed their SSH sessions, so each would otherwise type `--resume <id>`
  over SSH while the server runs the same conversation. The mark is TRANSIENT on purpose and taken
  by the node's first local mount (warm or cold; never by a relay node), unlike the persisted
  `agentStatus.paused`, which is keyed by a node id the team tab shares.
- **The SAS skip lives in ONE writer of `approvedAt`, and `source` gates nothing.** The client
  auto-confirm is `autoApprove: approvedAt !== null` (`hosted-join.ts`, for the bookmark recorded
  with the code's exact host key); `relay-bookmarks.ts` only validates `source`, it is a label.
  Normally `approvedAt` is set by a human's OK after a SAS comparison. `shareTeam.seedBookmark`
  (`main/remote-ssh/share-team.ts`) is the one writer that sets it WITHOUT one: a new bookmark
  labelled `source:'ssh'`, or, for an existing bookmark with the same hostId and host key,
  `approvedAt` set on it while it keeps its token and its `source` (often `'code'`). It rides the
  existing client bookmark auto-confirm, so it is NOT a seventh confirm site. That is sound only for
  its input: the join code `team bootstrap` returned over the project's own ssh channel (host key
  authenticated by `known_hosts`; `decodeJoinCode` checks hostId = hash(key) and `wss:`/loopback
  `ws:`). Main enforces that: it remembers the code each project's last SUCCESSFUL bootstrap
  returned (in memory) and refuses to seed any other, however valid. A failed seed degrades to the
  SAS prompt, never to a skip; any pasted code compares the SAS.
- **Hosted tabs are one per shared project, and the tab id IS the host project id.** relay-api
  translates no ids, so a tab under any other id asks the host about a project it does not know: a
  closed relay copy under that id is replaced, anything else holding it (an open tab, a local
  project) is skipped, never renamed. One relay connection serves all of a team's tabs. They follow
  `relay:hosted:shared-changed {projectIds}`, which goes to EVERY connection the host serves —
  `tellMembers` asks `standing`, so the `pinFailed` viewer fallback is included (`EDITOR_ONLY` as a
  call, always passed by `VIEW_EVENTS`), because `workspace:server-change` ignores unknown ids
  and viewers never receive `canvas:authority-changed`. A tab the user closes is dismissed until
  the project is unshared; nothing shared keeps one placeholder tab. A hosted tab never cold-resumes
  an agent (`canColdRestore` excludes `source === 'relay'`). A CLOSED team tab is NEVER reopened: once
  closed its relay session is disposed and `sessionForProject` falls back to the LOCAL session, so a
  reopen mounts the host's node ids on this core (local shells, agent cold-resume). The ONE reopen
  funnel, `reopenProjectUnchecked`, refuses any `remote` project with `CLOSED_TEAM_TAB_NOTICE`
  (so does every path through `reopenProject`); "Recently closed" lists neither the tab
  (`isReopenableClosedProject`) nor its closed sessions (`isClosedTeamTab`); `planReopen` answers
  `refuse` for ANY entry into a closed team tab BEFORE recreating a node into it (a `nodes` entry
  would otherwise be written into it and reopen it), and ⇧⌘T drops that entry (kept on top it
  would answer every later ⇧⌘T with the notice and hide every older entry);
  `performCloseProject` does not push a project entry for a relay tab. What brings the tab back is
  joining the team again with none of its tabs open, or an unshare + share (a reconnect keeps it
  dismissed, `lib/hostedTeamTabs.ts`).
- **One node id, two projects: owner lookups go through `nodeOwner`** (`lib/nodeOwner.ts`). After a
  share the closed, handed-off SSH project and the team tab hold the same node ids, and the SSH
  project comes FIRST in the list (a team tab is appended), so a bare
  `projects.find(p => p.nodes.some(...))` sent every "go to node" to the reopen warning. `nodeOwner`
  prefers an open project, then one without `handedOffTo`, then any, and skips a CLOSED team tab
  entirely (its reopen is refused; the shared node then falls back to the handed-off SSH project,
  whose reopen asks first); `focusNodeById`, the agent
  rename-node handler, `presenceTravel.nodeTravel` and the Omni board's rename use it. Deleting a
  project keeps the agent status of node ids another project still holds (`nodeIdsHeldElsewhere`).
  Deliberately NOT moved to it: `routeControlSource` (a control request comes from a LOCAL agent, so
  preferring an open relay tab would route it to another machine).
- **A relay session owns its agent status** (bug D: a team tab never showed RUNNING / NEEDS YOU /
  unread, because the joiner's only `agent:status` subscriber was Canvas's listener on the LOCAL
  api, which writes the DEFAULT store). `wireRelayAgentStatus` (`session/relay-agent-status.ts`,
  held as a session teardown in `openRelayTab` right after `createSession`, before any further
  await, so the RpcClient's early buffer flushes into it) subscribes the session's OWN api's `onAgentStatus` for the session's
  lifetime and feeds `applyAgentEvent` into that session's keyless store
  (`getSessionStores(id).agentStatus`). Routing is by api, never by a project lookup: two relay
  sessions may serve one project id. **A reader of a team tab's node must not ask the default
  store** (the known ones that still do are the doc's follow-ups): after Share with team the
  handed-off SSH project (local session, default store) and its team tab (relay session) hold the
  SAME node ids, so a reader that asked the default store, or the active project's, shows one
  project's status on the other's node, and a restart that read it would quit a host session the
  badge shows as RUNNING. Readers resolve per project
  (`agentStatusForProject`; `useAgentStatusLookup` / `useAgentStatusSig` re-subscribe inside the
  session-registry listener, so a reconnect that leaves the signature unchanged still moves them to
  the new store) or per node (`useSessionStores()`, render-safe for a session disposed a moment
  ago). **No ack**: a read on a team tab clears unread on this desktop only (`agentStatusForApi`
  builds the store with no `ackDone` callback), because an `agent:ack-done` would dismiss the
  OWNER's phone Live Activity for a session they never looked at; the tab subscribes neither
  `agent:unread-clear` nor `agent:subagent-activity`, and plays no sound and raises no notification.
  **Snapshot ordering**: subscribe FIRST, then ask `agent:status-snapshot` (served by both shells
  through `registerAgentStatusSnapshotIpc`, the newest 2000 mirror entries, narrowed for VIEW roles
  and scoped guests by `narrowResponseForRole` via `sharedNode`), and apply it only to nodes no live
  event touched in between (`liveSeen`; subagent events do not count, or the subscribe-time subagent
  replay would hold the busiest nodes blank). A restored or identity-only mirror entry travels with
  no `state`. A stateful one carries `ageMs` (an age, so no host clock crosses the wire) and sets
  ONLY `stateAt = now - ageMs`, never `lastEventAt` / `lastSeen`: the joiner saw no transition, and
  a fabricated one would claim it did. The teardown empties the store, so a dropped tab reads
  Unknown. The status-driven readers that act on THIS machine are off for a relay node
  (`relayStatusGates`: Approve/Deny, title sync, transcript search, the ⌘M chat view; the card
  modal's `ModalTerminal` gates its transcript search the same way); only `'local'` runs them, and
  `'relay'`, `'server'` and an unknown source fail closed. A desktop Team
  Access host's agent emits go through `corePlatform.broadcast` (its window plus every non-quiet
  peer); `agent:unread-clear` stays main-window only. Mobile: N/A (the phone speaks the legacy
  dialect and reads the mirror file). Follow-ups, including the Canvas-level readers still on the
  default store: docs/hosted-team-relay.md, "Agent status on a joined tab".
- **Admin errors are stable codes, and a `--json` refusal goes to STDOUT.** `E_BAD_KEY`,
  `E_BAD_CWD`, `E_HOSTING_OFF`, `E_ADOPT_FAILED`, `E_BAD_REQUEST`, `E_UNSUPPORTED`
  (`core/relay/admin-error.ts`); a remote caller branches on the code, never the sentence, and
  Node's own errno codes never pass as one (`adminErrorCode`). Under `team <verb> --json` a server
  failure (exit 1: a refusal, or no server reachable) prints `{"ok":false,"error","code"?}` on
  stdout beside the human line on stderr (`code` only when the server sent one), because the
  desktop's ssh exec reads stdout only: a refusal on stderr alone arrives as an empty, unparseable
  reply. The CLI's own argv/stdin refusals (`parseTeamArgv`, the resume stdin parse) exit 2 on
  stderr only. Bootstrap starts hosting and waits up to 15 s for the relay's first verdict BEFORE it
  writes an owner, a project or a share: a refusal (`E_HOSTING_OFF`) writes none of them, and no
  verdict yet (`hosting:'starting'`) is still a success.
- **`curl | bash` is a trap: download to a temp file first** (`SHARE_INSTALL_SCRIPT`). With no
  `pipefail`, a failed download pipes an EMPTY script into bash, which exits 0, so a failed install
  reads as a success; the temp file goes on every exit, HUP/INT/TERM included. Related: the probe
  never RUNS a server bundle it has not recognised (`BOOTSTRAP_MARKER` grepped from `main.cjs`),
  because a build from before the `team` CLI ignores `team` and boots a second server on the live
  data dir. And a value with `'` or `\` is refused, never nested-quoted: fish's single quotes treat
  both as escapes, so no nesting survives every login shell.

**Known gap (accepted for v1): two writers of the same agent files on a shared host.** The server
core and the desktop's `RemoteHooks` (for any SSH project still on that host) write the same files
under one `$HOME`, with different bytes; the last writer wins.
- **What collides.** The hook script `~/.nodeterm/agent-hooks/<agent>.sh` (same path, command and
  event lists; `mergeManagedHook` strips our entries first, so a config never doubles, and under a
  version skew the last writer's event set stays): only the server's copy carries the Codex
  thread-identity prelude (`REMOTE_IDENTITY_ROOT` is null). And the discovery files: by default the
  server writes the `get-linked-context` skill and the context-link blocks in `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md` and opencode's `AGENTS.md` (`src/server/index.ts` `initServerContextLink`),
  and with server canvas control on the `manage-nodeterm-canvas` skill and blocks
  (`src/server/canvas-control.ts`), all naming its own shims under `<dataDir>`, which bake the
  prelude; `RemoteHooks` writes the same files naming the neutral `~/.nodeterm/context.sh` /
  `nodeterm.sh`.
- **When each re-asserts.** The server at every start (the daily auto-update restarts it). The
  desktop: the hook script on connect and on every hook-tunnel repair (the reuse branch re-runs
  `setup()`); the discovery files through the agent-tools freshness check, which rewrites any that
  differ on connect, on every tunnel repair, and hourly while a project on that host is connected.
- **Who is affected.** Only shared-identity Codex tool shells on the server: they carry no
  `NODETERM_*` env and need the prelude to find their node, so against the desktop's copies their
  hooks report nothing. Every other pane carries its own endpoint env and works with either copy
  (and when a session's endpoint is dead, the script's failover can deliver its event to the other
  core's endpoint).

**Outbound to non-editors, since security audit (a)/(d)/F3/F4:** presence is rewritten per peer
(`createPresenceFilter`: only peers on a shared project, node references outside nulled, joins and
leaves synthesised as a peer moves), `context:update` needs a shared node behind its session (the
payload's `nodeId`, else the mirror's `nodesForAgentSession`; unattributable = dropped), a
Commenter's board comment is reduced to a comment's fields and rate-bounded per peer key
(`append-budget.ts`), and a shared folder that is the disk root, the home directory or an ancestor of
either or of the data dir is not a root at all (`share-root.ts`).

**Known limitations** (full list in the doc): a viewer's socket backlog over 1 MB still
pauses the shared pty through Stage 2 backpressure; the canvas authority's own limits (a project's
non-content fields stay last writer wins between tabs, the share-time window, oversized nodes, board
edits to another core, load-time repairs that are never cast) are under "Known limits" in the doc;
the GitHub issue summary modal reading its "Agent runs" log from this machine on a relay tab is under
"Limitations (v1)".

**Surfaces:** Desktop is full (joiner, plus approval and invite code in an owner's hosted tab, plus
Share with team from any desktop OS onto a Linux host). Server Edition is the host (the `team` CLI,
`team bootstrap`/`team resume` included; its browser clients cannot approve and are not hosted
peers, and its `shareTeam` rejects with `E_UNSUPPORTED`, having no SSH projects). Mobile is N/A for
v1: the phone still speaks the legacy dialect, and the host it would join now exists in core. The
iOS follow-up is the tunnel-dialect migration.

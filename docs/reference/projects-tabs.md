# Projects (tabs) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Projects (tabs)

Each project is one canvas/page; terminals and notes belong to a project. The `projects`
zustand store (`renderer/state/projects.ts`) holds project metadata + the *serialized* nodes
of all projects. **React Flow remains the single live source of truth for the *active*
project's nodes only.** The contract:

- The active-project effect in `Canvas.tsx` (keyed on `activeProjectId`) loads that project's
  serialized nodes into React Flow. `loadingRef` suppresses dirty-marking during this load.
  A real switch applies the project's saved viewport; an **in-place reload**
  (`reloadActiveProject` — external file change / SSH reconcile) sets `preserveViewportRef` so
  the load **keeps the user's current camera** — the incoming file's viewport is wherever
  another machine last saved, and restoring it mid-work teleported the camera (most visibly
  right after a cross-project sidebar focus, when the connect-time SSH reconcile landed a
  second after fitView centered the node).
- **Project order = array order**, and it is ONE order shared by the tab bar and the sessions
  sidebar (the sidebar no longer hoists the active project to the top). Both surfaces reorder
  via drag-drop through `reorderProject(draggedId, beforeId|null)` (null = to the end; tab
  strip empty area and sidebar body are the end-drop zones), persisted like any node reorder.
  Sidebar disclosure is **persisted**, for group frames as well as projects:
  `settings.sidebarCollapsedItems` maps `project:<id>` / `project:<id>:group:<groupId>` → collapsed
  (`isGroupCollapsed`), and `settings.sidebarAutoCollapse` (default on) now only supplies the
  DEFAULT for a project row nobody has toggled (on = active expanded / others collapsed, off =
  everything expanded). **This deliberately replaced the old "a project switch resets every manual
  toggle" effect** (2026-08, with the nested sidebar tree): a tree the user shaped by hand should
  still be that shape after a restart, and one transient rule for projects plus a sticky one for
  frames would have been two contracts in one list. `projectHeadClickAction` is unchanged — an
  inactive project row switches, the active one toggles its own (now persisted) collapse — and
  every write **prunes** keys that no longer address a live project/frame (`pruneCollapsedItems` /
  `liveCollapseKeys`), because settings.json is forever and a canvas churns through group ids.
- The bottom-left **canvas lock** freezes the CAMERA only (pan/zoom): nodes stay draggable,
  resizable and connectable while locked — the point is "stop the map sliding", not "freeze
  the work". It is **transient by default and opt-in to remember**: a lock that survives a
  restart reads as "the app is frozen" to whoever opens the app next, and the lit button is a
  small thing to spot, so `settings.rememberCanvasLock` (Behavior, default OFF) is what turns it
  into a preference. The bit itself lives in localStorage (`nodeterm.canvasLocked`,
  `renderer/lib/canvasLock.ts`) beside the view mode and the explorer pin, never in settings.json
  and never in the git-shared `project.json`: the SETTING says whether to remember, the lock is
  one person's view state. Note the two tiers differ per surface: on Desktop both are
  machine-local, but in the **Server Edition** the setting rides that server's settings.json
  (shared by every browser hitting it) while the bit is per browser PROFILE, so two profiles can
  legitimately disagree about the lock. Desktop + Server Edition; **Mobile: N/A** (no canvas).
  **The lock covers middle-drag on NODES too, and ⌘/Ctrl+middle-drag gets past it** (issue
  #1130, `renderer/lib/modifierPan.ts`). React Flow's zoom filter accepts a middle-button
  `mousedown` on a node / edge / selection before it reads `panOnDrag`, so turning `panOnDrag` off
  never stopped a middle-drag that started on a node header or a terminal's hover guard (the xterm
  itself was only safe by accident, via the #84 middle-click guard). While locked,
  `installLockedMiddleGuard` stops a middle `mousedown` in the BUBBLE phase on
  `.react-flow__viewport` — after the node (tmux, the middle-click paste setting) has seen it, before
  React Flow's listener on an ancestor. `installModifierPan` is the deliberate way past the lock:
  ⌘+middle-drag (Ctrl off-mac) pans anywhere, locked or not, by cancelling the pointerdown in the
  capture phase on the flow wrapper (so no `mousedown` reaches d3, d3-drag or xterm). The
  `canvas.toggleLock` command ships UNBOUND (⌘⇧L is the sessions sidebar's) and, like every canvas
  command, does not fire while a terminal has the keyboard.
  It is one GLOBAL bit rather than per-project
  because `<Canvas />` is mounted once and is not keyed by project, so the lock always carried
  across project switches within a session. Restore is gated on settings HYDRATION (Canvas mounts
  first, so a `useState` initializer would read the default and the opt-in would silently never
  work) and latched to the first run, so switching the setting on mid-session never reaches into
  storage and locks a canvas somebody is working on.
- Before any project switch / add / delete, `commitActiveToStore()` serializes the live
  React Flow nodes back into the store, so nothing is lost. Then disk is written. The commit is
  guarded by the epoch tag `nodesProjectIdRef` (`canCommitCanvas`), and **that tag must live in
  React STATE beside the nodes** (`canvas/nodesEpoch.ts`), never in a ref alone: the load effect's
  `setNodes(flow)` is a DefaultLane update, every zustand write after it is a SyncLane re-render
  that skips it, and the render-time `nodesRef` mirror then paired the PREVIOUS project's nodes
  with the NEW project's tag. A commit in that window wrote an SSH project's 7 nodes over a local
  project's 18 in its `.nodeterm/project.json` (2026-09-26). `nodesEpoch.test.tsx` reproduces the
  interleaving with real React (no `act`, which would flush both lanes together and hide it).
  **The refs are the LATEST pair, not the last rendered one**: the tag ref is written only by
  `installEpoch`, and a render copies its `nodes` into `nodesRef` only when that state CHANGED and
  the render belongs to the installed epoch. An unconditional mirror rewound both refs to the
  outgoing project in that window, and a peer's `canvas:mut` for the incoming (active) project was
  applied to the outgoing nodes and queued after the load — the canvas ended on A's nodes plus the
  op, tagged B, and the next commit wrote them into B. So the receive path routes by
  `liveCanvasHolds` (tag AND active id; otherwise the store) and queues a FUNCTIONAL update
  (`rebaseOnLatest`). Consequence for readers: code pairing the tag with the RENDERED `nodes`
  (a render-time publish, an effect keyed on `nodes`) reads `renderedProjectId`, never the ref.
- **The node subtree's session follows the project whose nodes React Flow's STORE holds**
  (`useFlowStoreOwner`, `canvas/flowStoreOwner.ts`), never `activeProjectId`. xyflow copies the
  `nodes` prop into its store in a PASSIVE effect and `ReactFlowProvider` sits above the keyed
  `SessionProvider`, so a key that flipped with the active id remounted the OUTGOING project's
  nodes under the INCOMING session for a commit: a team tab's terminals were created on this
  desktop's own core, and a local terminal on the relay host. Each array handed to
  `<ReactFlow nodes>` is recorded against `renderedProjectId` and the store's array is looked up
  (unknown ⇒ the last known owner); the same id feeds `OwningProjectContext`. A local → local
  switch keeps the key `'local'` (no remount). A session-changing remount now lands one commit
  AFTER the load applied the project's camera and builds a fresh pan/zoom, so `<ReactFlow>` gets
  `defaultViewport={viewportRef.current}`, or the switch resets the camera to the origin. For the
  same reason the load's settle timer must not frame or read the incoming nodes itself: the
  pending focus / "Open recent" resume / `nodeterm://` link it finishes run through
  `useFlowLanding` (`canvas/flowLanding.ts`) once the owner IS that project — React may run the
  store copy's passive effect after a due timer, which then framed the pan/zoom the remount
  destroys and read the outgoing copy of a shared node id. The rule holds for a local → local
  switch too (no remount, but the owner still flips). A caller that would create and frame AT ONCE
  (`resumeWhenLanded`, `runLinkOpen`) must also ask `flowLanding.holds(projectId)`, never the epoch
  tag alone: after "Open folder & resume" or a link that opens a new folder, the switch is the
  folder open's last synchronous step, so the `.then` runs after the load effect installed the tag
  and before the store copy — every time, not by chance. Otherwise it leaves the work in
  `pendingResumeRef` / `pendingLinkRef` for the landing. A throw inside a landing is logged, never
  rethrown: it runs in a passive effect and `<Canvas />` has no error boundary.
  `flowStoreOwner.test.tsx` replays the switches through real React Flow, the timer firing inside
  that window and the folder-open continuation included.
- **A remote project's node never starts on this core, whatever it is mounted under** (bug F: a
  team tab's terminals were created as LOCAL tmux sessions here). The node itself cannot say so: a
  project shared from SSH with a team is ADOPTED by the host (`localizeAdoptedNode` drops
  `sshRemoteTmux`/`ssh`/`sshFs`), so its nodes reach the tab as plain terminals. Do NOT re-stamp
  `sshRemoteTmux` onto them — the host's core would then refuse its own sessions (`requireRemote`
  with no master of its own: `held-elsewhere` for a live one, a refused spawn otherwise). Three
  layers besides the keying above:
  (1) `sessionForProject` resolves a REMOTE project (`remote` in the store; once the store no longer
  holds it, bound while remote in this run) with no live binding to the OFFLINE relay session
  (`OFFLINE_RELAY_SESSION_ID`, `session/offline-relay-session.ts`: `source 'relay'`, `status
  'offline'`), never the local one.
  Its core-bound calls (pty, fs, git, workspace, …) reject, so no terminal can be created here; it
  is not a wall around this machine, since its api spreads `...local` like a live relay tab's (the
  local namespaces — contextLink, transcripts, handoff, media — still act here, and its `boardLog`
  read answers `unsupported`). "Is this project remote?" is ONE predicate, `isRemoteProjectId`
  (session.ts), shared by this resolution and the spawn refusal in (3). Lifecycle code asking "which
  session is bound to this tab?" (dispose it, reconnect it) asks `boundSessionForProject`, which
  never answers the sentinel.
  (2) A surface that mounts a project's node OUTSIDE Canvas's node subtree runs under that project's
  session. Both kanban boards render under App's LOCAL provider, so each mounts its card modal
  through `ProjectSessionScope` (`session/owning-project.ts`: `sessionForProject(<card's project>)`,
  keyed by session id, plus `OwningProjectContext`). Before it, opening a team tab's terminal card
  created the host's node id on this desktop every time. The terminal, the comments, the metadata
  strip and the pull-request panel now act on the card's project (`useOwningProjectId() ??
  activeProjectId`): the terminal runs under the card project's session, the comments panel reads
  and writes that project's board log, the metadata strip's member pool reads it, and the
  pull-request panel reads that project's pull requests, SSH flag and auto-move target. On the Omni
  board a lane is not the active project: pairing the lane's api with the active id blanked a relay
  lane's comments and saved new ones nowhere, and on a local lane filed them into the ACTIVE
  project's board log. A relay card's file links are switched off (`cardFileLinkRoute`) and its ⌘M
  chat is refused (`stub.chat`, `E_UNSUPPORTED`). **Known exceptions (pre-existing, follow-up):** the
  icon picker (`NodeIconPicker.chooseImage` resolves the ACTIVE project, so a team lane's card
  opened while a local project is active copies the picked image into the local project's
  `.nodeterm/images/`), and dictation and file-drop uploads in a relay card, which act on this
  machine. The session is resolved at render, so a reconnect while a modal is open takes effect at
  the board's next render.
  (3) TerminalNode and ModalTerminal ask `spawnBelongsElsewhere(isRemoteProjectId(owner),
  session.source)` (`owner` from `OwningProjectContext`; the predicate is the one (1) uses, so a tab
  the store deleted still counts) before any SSH resolve or create: a remote project under a
  non-relay session starts nothing and writes a gray "belongs to a remote project that is not
  connected here" line. ModalTerminal mirrors TerminalNode's `dialsSsh` (a relay card's SSH-project
  node is joined by the HOST with `requireRemote`; this machine dials, refuses and reports nothing
  for it), and a non-dialing node's `ownerProjectId` is the owning project, else the active one.
  `components/kanban/cardModalSession.test.tsx` renders both boards with real sessions and a probe
  in place of CardModal, asserting which session and owning project each modal mount gets, plus
  source pins for the two terminals; `components/kanban/boardLogPanelSession.test.tsx` and
  `cardOwnerProject.test.tsx` render the real comments panel, metadata strip and pull-request panel
  under a lane's `ProjectSessionScope`; `session/offline-relay-session.test.ts` replays the switches.
- Switching away unmounts the old project's `TerminalNode`s → their tmux clients detach but
  the sessions keep running; switching back reattaches. tmux session names are per-node-id
  (globally unique), so projects never collide.
- The tab caret menu's **Close project** (`closeProject`) is **non-destructive**: it sets
  `project.closed = true` (hidden from the tab bar, kept on disk with all nodes) and leaves the
  tmux sessions running, so closing just detaches like a project switch. Closed projects are
  reopenable from the **"Recently closed"** list on `WelcomeScreen` (`reopenProject` → restores
  nodes, which reattach warm or cold-restore). `hasProjects` counts only **open** projects, so
  closing the last open one shows the welcome screen. **Permanent** deletion (`deleteProject`:
  `transport.destroy(nodeId)` per terminal + drop agent status + SSH teardown) now only happens
  via the `×` on a "Recently closed" entry. **Closing now SAYS what it parks** (issue #442 —
  "close" read like cleanup while meaning "hide, and keep running"): a project with terminal
  nodes gets a confirm naming the count, with an opt-in **"end its sessions too"** checkbox
  (default OFF — parking stays the rule; checked flips the confirm to danger). The pure half is
  `renderer/lib/projectCloseSessions.ts`: **one definition of N** — the project's terminal-kind
  nodes, exactly the set the action addresses (`transport.destroy` is idempotent on a dead
  session), never a liveness-verified count that could disagree with the action; the END happens
  at confirm time against the re-resolved node set (agents spawn nodes on their own). A relay tab
  or a 0-terminal project closes silently (byte-identical old path). `endProjectSessions` mirrors
  `deleteProject`'s teardown EXCEPT it keeps agent status (the persisted sessionId is what lets a
  reopen cold-restore `--resume`) and never disconnects SSH masters (close never managed the
  connection). The `×` also confirms now, via `deleteConfirmCopy` — a relay tab gets "removes
  only this machine's view; reconnecting brings it back" with no danger styling (deleting the
  view is what turns the next connect into a first-connect re-adopt), local/SSH get the session
  count + "the folder (incl. .nodeterm/project.json) is not deleted". And "Recently closed" rows
  show a **live-session badge** (`closedSessionCounts` over ONE on-demand local
  `sessionMemory.read` per welcome-screen appearance — never a timer; `ok:false` ⇒ no badge,
  never "0"; an SSH project's host-side sessions are deliberately not claimed by the local
  count). Server Edition: all renderer-side; the ws-bridge `sessionMemory` is real, so badges
  describe the server machine; the `sshProject` legs only run for `project.ssh`, which that
  shell never has.
- **Closing a NODE keeps a pointer to its transcript** (issue #531). The per-project
  `closedSessions` ledger records the agent session id as `ClosedSessionEntry.sessionId`, captured
  at delete time from the live `agentStatus` entry — which that same delete drops, so this is the
  last instant it exists anywhere — falling back to the minted `node.agentSessionId`. It is a
  POINTER, never a copy: the `.jsonl` the agent CLI owns stays the only text, and a second store of
  transcript text would age, drift and need its own retention policy. The "Recently closed" row
  spends it on the **existing ⌘M reader** (`ChatPanel` in `readOnly` mode, hosted by
  `ClosedTranscriptDialog`), so resolution, the `{found}` vs empty distinction and Retry cannot
  drift from the live-node path. Two rules: it rides `IndexEntryV3.closedSessions` and is therefore
  **machine-local** — a session id is a `$HOME`-anchored fact about one person's machine, and
  `projectToFile` must never emit it — and it is **re-checked as a string** in
  `sanitizeLoadedClosedSessions`, because workspace.json is hand-editable and the value goes
  straight to a resolver. `closedTranscriptTarget` (pure) owns the refusals and NAMES each: a
  REMOTE session is refused (its transcript is on the host; locating it over the ControlMaster is
  separate work and must not hold the local fix hostage) and a pre-#531 entry says its id was never
  recorded. Only the "this was never an agent" refusal may render as nothing — for the others a
  vanished control would leave the user believing that closing destroyed the record, which is the
  belief this exists to correct.
- A project's `cwd` (folder picker, `dialog:select-folder`) is passed to terminal/Claude
  node factories so new terminals open there. **Folder ↔ project is deduped:** "Open folder…"
  reuses the existing project with that `cwd` (and its nodes) instead of creating a duplicate.

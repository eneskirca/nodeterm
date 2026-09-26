---
paths:
  - "src/main/canvas-control*.ts"
  - "src/core/canvas-control*.ts"
  - "src/core/context-link*.ts"
  - "src/core/remote-end.ts"
  - "src/core/agents/pane-ownership.ts"
  - "src/server/canvas-control.ts"
  - "src/server/context-link.ts"
  - "src/server/headless-node-factory.ts"
  - "src/shared/control-*.ts"
  - "src/shared/settings-verb.ts"
  - "src/shared/project-capabilit*.ts"
  - "src/renderer/lib/closeTargets.ts"
  - "src/renderer/lib/coldOpen.ts"
  - "src/renderer/lib/controlRouting.ts"
  - "src/renderer/lib/edgeModel.ts"
  - "src/renderer/lib/noteLink.ts"
  - "src/renderer/lib/pendingLaunch.ts"
  - "src/renderer/lib/useExpiringDialog.ts"
  - "src/renderer/lib/verifyPanel.ts"
  - "src/renderer/lib/settingsVerb*.ts"
  - "src/renderer/state/controlConfirm.ts"
  - "src/renderer/state/launchDelivery.ts"
  - "src/renderer/terminal/launch-command.ts"
  - "src/renderer/canvas/Canvas.tsx"
  - "test/acceptance/**"
  - "docs/ssh-agent-skills.md"
  - "src/core/handoff/locate.ts"
---

## Canvas control and Context Link

- **Canvas control (manage-nodeterm-canvas)** — agents in `CANVAS_CONTROL_CAPABLE`
  (claude/codex/gemini/copilot/opencode/grok) can create/organize/control canvas nodes from inside their
  session: a POSIX **sh+curl** shim (`nodeterm.sh`, `CONTROL_SHIM_SCRIPT` in
  `main/canvas-control-core.ts` — the Electron-as-Node CLI is retired) POSTs
  **form-urlencoded** (`nodeId` + `arg.<flag>` fields; `curl --data-urlencode` is the only
  escaping sh can be trusted with — `parseControlBody` reads both this and the JSON dialect) to
  the hook server's `/control/<verb>` routes; `Accept: text/plain` makes the server render the
  reply (sh has no JSON parser). Env-gated on `NODETERM_CANVAS_CONTROL` (set by
  `buildPtyEnv`/`remoteHookEnvArgs` per `canControlCanvas`). Discovery: claude gets a
  `skills/manage-nodeterm-canvas/SKILL.md` (system `~/.claude` + each managed account dir);
  codex/gemini/opencode plus Copilot's `copilot-instructions.md` get a marker block
  (`<!-- nodeterm:manage-canvas:start/end -->`); **grok needs
  no installer at all** — it scans `~/.claude/skills` by default for Claude compat, so membership alone
  (which sets `NODETERM_CANVAS_CONTROL`) is the whole wiring. That premise rests on grok's shipped
  docs and is **unverified** (`grok inspect --json` never run); if it does not hold, grok takes the
  marker-block route instead — see docs/grok-agent.md.
  **Server creator ownership (2026-08 incident hardening):** enabled Server control accepts only
  verified node identity. `HeadlessNodeFactory` records which source node opened each new node in a
  process-local ledger; link/group/rename/color/sticky-update, message delivery, and close validate
  the whole target set as current-run creations before writing or killing anything. Queued messages
  revalidate creator ownership before flush. The ledger is intentionally empty after restart —
  project JSON, titles, hook history and tmux names are not creator proof — so
  boot neither attaches/creates backends nor sends persisted queued commands. A live backend with a
  durable arm remains untouched until an explicit owner action or browser view. `open-terminal` and
  `open-agent` are verified-only at the Server handler boundary. A plain terminal keeps generic
  node hook wiring but receives neither `NODETERM_AGENT_ID` nor `NODETERM_CANVAS_CONTROL`; missing
  identity never defaults to Claude.
  **SSH projects** (docs/ssh-agent-skills.md): the SAME shim + skill + blocks are installed on
  the remote host at connect (`RemoteHooks.installCanvasControl` + per-account
  `installCanvasSkillIntoAccountDir`), gated on the VERIFIED reverse hook tunnel — the shim
  carries no machine-specific paths and POSTs through the tunnel's unix socket, so remote agents
  control the desktop's canvas. The shim is generated source no compiler checks:
  `canvas-control-shim.test.ts` runs it for real (/bin/sh against a real hook server, port AND
  unix-socket transports) — keep it that way.
  **NO VERB MAY ACTIVATE A PROJECT TAB** (`src/shared/control-off-screen.ts`). Routing is by
  SOURCE — the request names the agent's own node, and the dispatch must find the canvas that owns
  it — so for years "that canvas is not on screen" was answered by `travelToProject`. The user was
  typing in project B; a background agent in project A issued a `close`; the tab switched and A's
  saved viewport was applied. Their focus, camera and typing context were taken by a call they did
  not make. Two carve-outs (the cold open for `open-*`, then the display verbs) were each written
  as if it were the last, because nothing walked the whole table — twenty-one verbs still
  travelled. Every verb now has a decided disposition and NONE of them is travel:
  `STORE_ANSWERED_VERBS` (no canvas at either end), `COLD_OPENABLE_VERBS` (a session node, armed
  and inert until shown), `OFF_CANVAS_VERBS` (a display node, complete when written),
  `STORED_NODE_VERBS` (`write`/`close`/`rename`/`color`/`link`/`board`/`assign` — each reaches a
  pane, a store writer or the board file), and `OFF_SCREEN_REFUSALS` (the eleven that genuinely
  need live React Flow, each with its own reason in the refusal the agent reads). A refusal an
  agent can act on is strictly better than hijacking someone's screen. Load-bearing details:
  (1) **`ctlNodes()` is the one name for "the node array this call acts on"** — on screen it is
  `nodesRef.current` verbatim, off canvas it is the owning project's serialized nodes hydrated by
  `nodeStatesToFlow`. A verb body that resolves `--node` against the live array while answering
  for another project does not throw and does not travel; it silently renames, closes or reports
  on whatever the human happens to be looking at. `control-stored-node.source.test.ts` pins that
  no stored-node case mentions `nodesRef.current`. (2) **`board`/`assign` read `ctlProject`, not
  `activeProjectId`** — a second bug that was hiding behind the first, invisible while the travel
  made the two projects the same. (3) **`closeStoredNodes` is the ONE cross-project teardown**,
  shared with the sessions sidebar's `closeSession`; it is `deleteNodes` minus the closed-session
  ledger and ⇧⌘T history, which `deleteNodes` files against the ACTIVE project. `close` still ends
  the session off canvas because `transport.destroy` resolves a REMOTE node's host from the
  persisted index with no live client (`core/remote-end.ts`). (4) **There is no
  `travelToProjectRef` and there must not be one again**; `travelToProject` survives only for the
  facepile, the user's own navigation. (5) **The regression guard is
  `test/acceptance/control-verb-disposition.test.ts`**, cross-layer on purpose: it walks MAIN's
  `VERBS_FOR_TEST` against the RENDERER's disposition, which is the only way "every verb" is a
  checked claim rather than a list kept by hand. That is what nobody had, and why two carve-outs
  could ship without anyone noticing the other twenty verbs.
  **Keep the agent-facing text in sync with behaviour, in the SAME PR.** The verb help agents
  actually read is generated by `buildCanvasSkillBody` (the SKILL.md, rewritten into every config
  dir by `installCanvasSkillInto` on launch) and `buildCanvasControlInstructions` (the
  codex/gemini/copilot/opencode marker block) — both in `canvas-control-core.ts`. When you add or
  rename a verb, change a flag, or change what an outcome MEANS (e.g. PR 7 turned a busy target's
  `targetBusy` refusal into a deliver-on-idle queue), update those two functions in the same change,
  or the docs describe a product that no longer exists and an orchestrating agent acts on the stale
  contract. Derive from the code, never re-type: the retry guidance renders from `RETRYABLE`
  (`messagingGuidanceLines`) so a new outcome kind lands in the text the day it is added, and the
  off-screen paragraph renders from the verb table itself (`offScreenGuidanceLines`, which is why
  that table lives in `src/shared` — core cannot import the renderer) — prefer that shape over
  prose you have to remember to edit. `canvas-control-core.test.ts` walks both
  generated bodies and must red on the stale claim (it pins the queue wording and the RETRYABLE
  split); a doc line with no such test is a plan, not a fact — see the drift that shipped as #269.
  **Flag syntax**: `--flag value`, `--flag=value`, or a valueless flag anywhere on the line. The
  shim used to consume the next token after any `--flag` *unconditionally*, so `--read --node b1`
  became `arg.read=--node` with `b1` silently dropped and the server answering about the wrong
  flag; it now peeks. The trade: a value that itself starts with `--` must use the `=` form
  (`--cmd=--version`), which was previously unexpressible in either direction. Two parsers are in
  play and both are tested — the sh loop (`control-shim-parse.test.ts`, real `sh` + a fake `curl`
  that records argv) and `parseControlBody` reading what it built (`canvas-control-shim.test.ts`).
  **A new verb must not DEPEND on the fix**: the shim is rewritten locally every app boot but onto
  an SSH host only inside `RemoteHooks.setup()` (on connect), so an already-connected project keeps
  the old loop with no signal on the wire. Give every flag a value and both loops agree.
  **WHICH CANVAS ANSWERS, and why an open never moves the camera** (`renderer/lib/controlRouting.ts`
  + `renderer/lib/coldOpen.ts`). React Flow holds only the ACTIVE project's nodes, but every other
  open project's tmux sessions keep running, so a control call routinely arrives from a node the
  live canvas has never heard of. `routeControlSource` resolves the OWNING project
  (`active | switch | reopen | blocked | unknown`) — before that, every agent outside the project
  the app happened to come up on was rejected as *"source node is not a control-capable agent"*,
  which is a capability sentence for a routing failure. **That fix must not regress.** What it
  originally did with the answer was TRAVEL there (`travelToProjectRef`) — the screen hijack
  described under **NO VERB MAY ACTIVATE A PROJECT TAB** above. THREE membership lists now decide, and their differences are the whole design:
  - `STORE_ANSWERED_VERBS` (`needsLiveCanvas` false) = **no canvas is needed at either end** —
    `list` reads names, `send`/`reply` deliver into a tmux PANE, `sticky` rewrites a note,
    `open-project` acts on the projects store.
  - `COLD_OPENABLE_VERBS` (`canColdOpen` — `open-terminal`/`open-claude`/`open-agent`) = **a canvas
    IS needed, but the serialized one will do.** `needsLiveCanvas` stays TRUE for them; they take
    the `--project` cold-open path (issue #338 §2.2) applied to their own project: the composed
    launch MOVES into `pendingLaunch` (`armForColdOpen` — `initialCommand` is never serialized), the
    node is upserted through `applyNodeMutation`, edges go through `appendCanvasLinks` (the edge
    counterpart, so the opener's rope and the fan-in bridge are not lost), `writeDisk` persists, and
    the reply is the ONE shared `coldOpenMessage` sentence with `queued: true`.
  - `OFF_CANVAS_VERBS` (`answersOffCanvas` — `show-image`/`show-video`/`show-web`/`open-browser`)
    = **a canvas is needed, the serialized one will do, and there is nothing to defer.** The node
    these make has no session behind it: a page, a video, an image, a browser node is inert
    wherever it sits, so writing it into the owning project's serialized nodes IS the whole effect
    and it is complete when `writeDisk` returns. That is why it is a third set and not four more
    entries in the second one — a cold open reports `queued: true`, and a caller told its
    screenshot is queued waits for something that already happened. It gets
    `offCanvasReplyClause` and `offCanvas: true` instead. **This was the half the cold-open fix
    left open, and it is the half an agent meets most often**: a skill that renders its report as
    HTML reaches for `show-web` every time it finishes, and every one of those calls used to yank
    the user out of the project they were typing in. The verb bodies are untouched; three things
    they read from the canvas are staged — the colour index (`nodeCount`), the placement source
    (the stored node, hydrated through `nodeStatesToFlow` so its shape cannot drift from a live
    one's) and the append, where `applyNodeMutation` + `appendCanvasLinks` + `writeDisk` replace
    `setNodes` + `connect` + `markDirty`. The opener's edge is a **rope** and only a rope: a
    display node has nothing to read, so a bridge there would grant a context link the live path
    never draws. **`ctlProject` resolves from the SOURCE's project**, not the active one — off
    canvas it decides the ssh flag, the browser session key and the media allowlist route; on
    every other path the travel has already made the two the same project. None of the four takes
    `--group`, which is why this set owes no worktree question; a verb joining it that does would,
    because `cwdForNewNodeIn` subtracts `staleGroupIds`, which is epoch-scoped to the ACTIVE
    project.
  Everything else keeps travelling **on purpose**: `write`/`close`/`group`/`move`/`arrange`/
  `align`/`verify`/`spawn-team`/`open-worktree` read live canvas state the serialized copy does not
  carry (measured node sizes, worktree staleness, the React Flow edge arrays). **`browser` is the
  pair worth stating beside `open-browser`**: it NAVIGATES a mounted `<webview>` guest, which
  exists only while its project is on screen, so it travels; `open-browser` merely places the node
  and its guest is created when that project is next shown, exactly as a cold-opened terminal's PTY
  is. Route `active` is byte-identical to before.
  **The human is told, once, in the other voice.** The reply goes to the agent; without a strip the
  person sees nothing at all, and the whole point of not travelling is that the choice to go and
  look stays theirs — a choice they can only make if they are told there is something to look at.
  `offCanvasNoticeText` names the project and the button is `travelToNode` (which reopens a closed
  project first and resolves off the SERIALIZED nodes the write has already made). It is **sticky**:
  every other info strip reports something the user just did and is watching, this one reports work
  that landed while they were busy elsewhere, and once it fades nothing anywhere says it happened. Route **`reopen` (a CLOSED project) cold-writes
  too and does NOT reopen the tab** — closing is the user's explicit "park this, keep it running", so
  restoring the tab *and* activating it is the loudest form of the hijack; the reply names the closure
  so a caller does not report a session as started. On the cold path `--group`/`--after` ARE resolved
  (unlike with `--project`, where the ids would live in another project) against the serialized
  nodes, defaults come from the OWNING project (`projectPermissionMode(owner, …)`, its account,
  its `ssh`), and `--after`'s dep ropes are left to `missingDepRopes` at that project's next load.
  **The destructive confirm, and who may waive it** (`@shared/control-confirm`, 2026-09). The
  dialog `write` / `close` / `open-project` raise is the ONLY place a human stands between a
  canvas-control agent and the workspace — per-node identity is not enforced until
  `NODE_IDENTITY_STRICT_AFTER`, so a `legacy` caller still reaches the dispatch — and it used to
  ask EVERY time with no way to say "yes, all of them". Closing 14 finished stations was 14
  dialogs, and the 15th request was refused with `a confirmation is already pending`. Three things
  changed, and the last one was the actual bug:
  - **`close --node a,b,c` is ONE dialog** (`lib/closeTargets.ts`, pure). The grammar is not new —
    the Server Edition's headless `close` has read a comma list since it shipped, including its
    "validate the whole list before killing anything" rule; the DESKTOP dispatch read the flag as
    one id, so a comma list called `deleteNodes(['a,b,c'])` (a no-op) and answered `closed a,b,c`.
    A destructive verb reporting success for work it did not do is worse than either doing or
    refusing it. The single-id form is bit-identical, **deliberately including its lack of an
    existence check**; the bulk form refuses the WHOLE list on an unknown id and names it, because
    with 14 ids the user cannot audit the list themselves. Capped at `CLOSE_BULK_MAX` (50) and the
    dialog spells out at most 12 names then counts the rest — a name the user cannot see is not
    consent.
  - **"Don't ask again" is bounded by SCOPE, not by permanence** (2026-09, revised). The checkbox
    offers two reaches and defaults to the narrower: **"while nodeterm is running"** — the
    transient `state/controlConfirm.ts`, memory only (not `settings.json`, not `localStorage`), per
    VERB, so quitting restores the gate — or **"always in <project name>"**, persisted in
    `settings.controlConfirmWaivers.projects` as `{ [projectId]: verbs }`. The machine-WIDE
    `always` is still reachable only from Settings → Agents, where the option says "permanently":
    a dialog that appeared under the user's hands must not switch a destructive gate off
    *everywhere* on one stray click. The per-project scope is what makes the offer honest — an
    app-run waiver is not what a user who ticks "don't ask again" means, and with only that and a
    machine-wide switch the real choices were "be asked forever" or "turn it off everywhere".
    Load-bearing details: (1) the waiver is keyed on the project the call **acts on**
    (`ctlProject`), not the active one — canvas control answers a background agent in its own
    project without moving the user's tab (@shared/control-off-screen), so reading the project on
    screen would grant, or honour, a waiver in the wrong repo; the same argument applies to the
    permission MODE the bypass lock weighs, which is why `controlConfirmDecision` takes a project
    id and resolves both from it. (2) It is **machine-local** — never `.nodeterm/project.json`,
    which is git-shared; the whole trap `bypassMode` needs two locks for. (3) It is **pruned** on
    every write (`pruneControlConfirmWaivers`, the rule `pruneCollapsedItems` states for
    `sidebarCollapsedItems`) against EVERY project including CLOSED ones — a closed project is
    parked, not gone — because settings.json is forever and a stale entry is a live security
    waiver keyed to an id nothing can name. The id being granted survives that prune because the
    merge happens after it, not by an exemption inside it; a safeguard no test can turn red is a
    comment, not a mechanism. (4) Precedence is narrowest-first among the persisted grants
    (session → project → always → bypass), so the notice names the waiver the user most likely
    wants back. (5) A waiver granted by a CANCEL must not exist at all (the grant hangs off
    `onConfirm`, pinned by `control-destructive.test.ts` and
    `control-confirm-scope.source.test.ts`), and a per-project grant that cannot be made (no
    project owns the call) falls back to the app-run waiver rather than silently to nothing.
    Waiving is not silence: every waived application raises the info strip through `waivedNotice`,
    which names the waiver that let it through — and, for the project scope, the PROJECT, since
    "this project" would point at whatever the user happens to be looking at — and every
    per-project waiver is listed with a Revoke in Settings → Agents.
  - **`bypassPermissions` needs TWO locks, and this is the trap to understand before touching it.**
    The permission mode is persisted to `.nodeterm/project.json`, which is **git-shared** — so
    keying the waiver on the mode alone would let a repository the user CLONED silently disable
    their destructive-action gate. It therefore requires a machine-local opt-in
    (`controlConfirmWaivers.bypassMode`, default off) **and** a mode that came from the user's own
    GLOBAL setting: `resolvePermissionModeWithSource` answers `project | global | default`, and
    only `global` can waive. `default` is its own answer rather than folded into `global` because
    nobody chose it, and reading an unset setting as a deliberate choice is reading consent into
    silence. The claude version gate is deliberately NOT applied here (it exists to degrade `auto`
    for an old CLI; a security decision must not hang on a `claude --version` probe).
  - **`open-project` can never be waived**, by table (`CONFIRM_WAIVABLE_VERBS`) rather than by a
    line somebody forgot at one of three call sites. It widens the app's blast radius (a new
    directory registered as a project, plus a grant the caller feeds to `--project`) instead of
    acting inside it, and it cannot produce the dialog storm the waiver exists to end —
    `recordAttachConsent` already dedupes it per (caller, project).
  **An agent-requested dialog knows its own request's lifetime** (`ConfirmState.expiresAt` /
  `onExpire`, `CONTROL_REQUEST_TIMEOUT_MS` now shared with main). Main abandons a control request
  after 120 s and tells the renderer NOTHING, so the dialog stayed on screen asking about work
  nobody was waiting for — and, worse, kept `confirmBusy()` true, which refused every later
  `write`/`close` with `a confirmation is already pending — try again` for the rest of the app run.
  **That is the "the same dialog keeps coming back" report**, and it is a single-canvas loop: the
  reply says retryable, the agent retries, every retry is refused by the orphan, and the moment the
  user finally answers it a queued retry raises a fresh dialog for the same node. The deadline is
  measured from the RENDERER's receipt, so it always fires a hair AFTER main gave up, never before
  (the other direction would abandon a dialog whose answer main would still accept); it replies
  `expired` rather than `denied by user` (nobody denied anything, and a reply main has already
  timed out is simply dropped); and the notice is a fading info strip, because raising an alert
  would keep `confirmBusy()` true — i.e. reproduce the bug with better wording.
  **`close-worktree --mode remove`'s dialog expires too** (2026-09-11), through the SAME
  `renderer/lib/useExpiringDialog.ts` the confirm uses — the rule was extracted rather than copied,
  because a second effect beside the first is how one gains a fix the other silently lacks. Three
  differences to keep in mind, all deliberate: it carries **no `onExpire`** (the verb replies
  "removal confirmation shown to the user — they decide" the instant the dialog opens, so nobody is
  waiting on an answer and an `onExpire` would be a reply to a call that finished minutes ago); its
  clear must also release **`removePendingRef`**, the guard covering the async `git.status` gap
  before `removeTarget` exists, which `confirmBusy()` reads directly — dropping the state while
  leaving that ref latched closes the dialog and keeps refusing every later destructive verb, i.e.
  the bug minus the only thing on screen that explained it; and the deadline is set **only when
  `requestedBy` is present**, because a removal the USER opened from the group menu must never
  vanish under them. It reuses `confirmExpiresAt` rather than inventing a second timeout: the fact
  is the same class ("an agent asked and the human is not at the machine"), and this is the most
  dangerous dialog to leave lying around — the one carrying a pre-ticked delete-from-disk choice on
  a worktree the human never asked about.
  **MEASURED, and the answer is no: two canvases cannot raise two dialogs for one request.** The
  suspicion was worth checking because the same project can be open on a desktop and in a Server
  Edition browser at once. Desktop main forwards each request to `getMainWindow()` — one
  BrowserWindow, so at most one dialog exists per request; the Server Edition raises none at all
  (its control is HEADLESS — `HeadlessNodeFactory.close` is gated by verified identity plus
  process-local creator ownership, and the browser bridge's `onAgentControl` is `noopUnsub`); and
  the shim's endpoint failover cannot duplicate a request either, because the control POST carries
  **no `--max-time`**, so a POST waiting on a human eventually gets an HTTP answer and
  `nt_reached()` is true — failover fires only on a dead transport (`000`/empty). If a future change
  gives that curl a timeout, this paragraph stops being true: a confirm-gated verb would then fail
  over mid-wait and a second instance WOULD open a second dialog for the same logical request.
  **Grouping verbs** (`group` / `ungroup` / `move` / `arrange` / `align`): `group` wraps **sibling**
  objects — nodes or frames — into a new frame in their shared container (a mixed-container set, or
  an ancestor plus its descendant, is refused with that reason); `ungroup --group <id>` dissolves a
  frame, promoting its direct children into the frame's own parent (nodes kept); `move
  --nodes <id,id> [--group <id>]` reparents nodes OR whole frame subtrees INTO a frame (or
  `top`/`none`/omit → out to top level) via `reparentNode` — the ONE way to move a node between
  frames, which `group` won't do; a cycle (a frame into itself or its own descendant) is refused.
  `arrange`/`align` now run in ONE coordinate space: all top-level, OR all children of one frame
  (`commonParentId` decides; a mixed set is refused, not silently subset-arranged — the old
  behavior). When the ids are a frame's children, the frame is shrunk to hug the tidied layout
  (`fitGroupToChildren`) — the fix for "grouping keeps scattered positions so the frame is too
  wide". `move` also re-fits the source + destination frames. All pure + tested in
  `state/workspace.test.ts` + `workspace.layout.test.ts`.
  **Fan-in (`link`, 2026-07):** a spawned fan-out was previously write-only — nodes an agent
  opened were joined to it by a **rope** (`project.ropes`, explicitly *"Display-only — never
  context links"*), so an orchestrator could not read back what its own team produced and the
  skill told it to have the USER relay results. Now `open-claude`/`open-agent`/`spawn-team` also
  draw a real **context bridge** (`project.bridges`) to each agent session they open, and the
  `link --to <id,id> [--from <id>]` verb links nodes the agent did not open (or two other nodes).
  The rope stays — the two edges mean different things (lineage vs readable context) and a
  non-context-capable target still gets only the rope. Deliberately **silent**: the manual
  `onConnect` path pushes a discovery note into both endpoints, but doing that per team member
  would inject a prompt into every session an agent just spawned — the exact intrusion that push
  was reverted for. Links are pull-based, so nothing is lost. The refusal matrix is the pure
  `planBridges` (`renderer/lib/noteLink.ts`, unit-tested); Canvas only wraps it in setState.
  A missing endpoint is only absent from the calling project: report that scope and the
  unsupported cross-project boundary, without probing other projects or exposing their metadata.
  Callers that create and link nodes **in the same tick** must pass their own `lookup` — `setNodes`
  is async, so resolving fresh nodes off `nodesRef` would skip every one as "no such node".
  **Dependency edges (`--after`, 2026-07):** `open-terminal`/`open-claude`/`open-agent` accept
  `--after <id,id>`, which opens the node **armed** — `data.pendingLaunch` ({after, command},
  `PendingLaunch` in shared/types) holds the launch the factory built, and Canvas fires it once
  every dep reports `done`. This is what makes the canvas a DAG instead of a fan-out. Load-bearing
  details: (1) **an unknown agent state is NOT "satisfied"** — right after a fan-out no upstream has
  emitted a hook event yet, and reading "no news" as "finished" would fire every dependent
  instantly; a **deleted** dep IS satisfied (it can never report); and a dep that is `done` with a
  live **`lastTurnError`** is NOT (issue #521, below). (2) Only `hasHooks` agents may be
  waited on — a plain terminal never reports done, so `resolveAfter` **refuses** it rather than
  letting `launchesToFire` (which cannot tell "never will" from "not yet") hang the node forever.
  (3) **Control opens always retain the command in `pendingLaunch` until delivery lands**
  (#827/#811). Even a visible node with no deps has not mounted its PTY when the open reply is
  sent. `queueControlLaunch` moves the command out of `initialCommand`; the PTY-ready gate below
  makes this safe. The open reply says `queued`, and project serialization retains the brief.
  (4) Desktop automatic and manual launch delivery share `terminal/launch-command.ts`, which
  uses `deliverCommand`: echo verification, bounded Ctrl-U repair, platform kill-line and overlong
  line refusal. The PTY-lifetime writer coalesces concurrent requests and remembers submission
  across parked views. Relay queued/restored delivery, including Run now, is refused until a scoped durable
  claim API exists: a relay workspace load can be project-scoped, while save replaces the host
  index. Never use that load/save pair for a launch. A new relay UI initialCommand may instead
  use the verified writer once on a fresh PTY without creating pendingLaunch or writing workspace
  data. Its transient claim is consumed before settle and survives view remounts; relay snapshots
  omit that initial command rather than converting it to durable intent. A parked-project deferral before any input
  retains never-attempted intent and can proceed on activation without a retry timer.
  New intent has `attempted:false`; the writer awaits a workspace save of
  `attempted:true, manualOnly:true` before input, then rechecks the shell after that save. That
  save is **`localOnly`** (`WorkspaceStore.save`): durable in this machine's index, with no SSH
  read/reconcile/mirror — a changed entry is marked `unmirrored` and the next ordinary save pushes
  it. Awaiting the mirror put two SSH round trips in front of every new agent on an SSH project.
  A node's own first-open delivery (live `initialCommand`, no deps, no failure record) shows NO
  QUEUED chip: its `pendingLaunch` is only the write-ahead record, and it carries `manualOnly`
  from the claim until Enter lands, which painted "⚠ QUEUED" on every freshly opened agent. A warm
  attach may automatically deliver never-attempted intent, preserving long-running `--after`
  graphs through project switches/park expiry. Attempted/legacy-unknown intent stays manual: its
  clearing autosave may have been lost after Enter. Explicit Run now rechecks the foreground shell and
  clears any incomplete line; a refused/throwing/cancelled launch stays held, `manualOnly`.
  (5) UI `initialCommand` stays until submission; serialization converts unsubmitted UI intent
  into a never-attempted `pendingLaunch`, including a project switch during shell settle. A live
  initialCommand alias on remount cannot reset an attempted marker. Server saves
  `attempted:true, manualOnly:true` BEFORE sending and only clears the command after acknowledgment. Failed
  independent/dependent launches are never retried by unrelated hooks. Boot remains inert.
  Server deferred delivery is deliberately one-shot: a transient probe/send failure needs Run now.
  Desktop keeps the attached echo-verification transport even for offscreen held nodes; a large
  long-waiting fan-out therefore keeps those xterm instances in memory until delivery/recovery.
  (6) Canvas subscribes to `armedDepSig`, NOT `useAgentStatus(s => s.byId)` —
  the same discipline as `loopSig`; the full map re-renders the canvas on every hook event.
  Pure logic + refusal matrix in `renderer/lib/pendingLaunch.ts` (unit-tested);
  the dep→node edge is a **rope** (`ctrl-<dep>-<node>`, persisted in `project.ropes` like the
  opener's) whose LOOK is derived: dashed + ⏳ while the node's `pendingLaunch.after` still lists the
  dep, solid once it has launched (`lib/edgeModel.ts` `ropeVisual`, over the ONE `ropeInfoOf` lookup
  the render and BOTH delete paths ask — two builders would be two answers, and the label the user
  reads would stop describing what the delete does). The fan-in bridge `--after` also writes hides
  under that rope (`hiddenLinkIds`), so ONE edge per pair holds on the canvas. Deleting a WAITING
  rope drops that dep from `after` (`dropAfterDep`) and takes **nothing else** — the covered bridge
  survives, because "stop waiting for it" is not "stop being able to read its work"; an emptied
  list fires. Only the `open-*`/`verify` verbs write the rope, so `missingDepRopes` heals an armed
  node that has none at **project load**: `pendingLaunch` is persisted and the rope is not, so a node
  armed by any other path — or by a build older than this one — would otherwise hold a launch with
  no arrow saying what for. All edges route through the single `floating` edge type
  (`canvas/FloatingEdge.tsx`, a bezier between the MIDPOINTS of the two nodes' facing sides — one
  anchor per side, so a hub's arrows converge instead of fanning along its border; context and note
  links are restricted to the left/right sides, where the bridge handles sit; an unmeasured node
  draws nothing rather than a path to the origin) — no family sets a handle side;
  and a node whose eye is closed (`hideFanout`) hides every edge touching it as well as its cards
  (2026-09-02 edge model, spec in docs/superpowers/specs).
  **(7) Delivery waits for the node's PTY, and never fails silently** (issue #569 item 1, 2026-09).
  A satisfied dependency says nothing about whether there is a terminal to type into, and the
  original loop conflated the two: a flat 5 × 400 ms budget started when the CANVAS held the node
  and was spent on loading the canvas, mounting it and spawning tmux — so on a cold project switch
  the launch was abandoned before its session existed, in a `console.warn`, and the node read
  QUEUED forever with only the manual ▶ left. `TerminalNode` therefore publishes a **session-ready**
  signal (`isSessionReady` / `subscribeSessionReady`, module-level like `offscreenNodes`): true for
  an ADOPTED park (already typeable, and its create continuation ran on a previous mount) and, for
  a fresh spawn, at the SAME `whenShellSettled` moment `writeWhenShellReady` delivers an
  `initialCommand` — both write a CLI command line, and a line delivered across zsh's rc-file tty
  flush comes out mangled. A **park keeps the writer and transport**; a real teardown removes
  the writer. The loop WAITS instead of burning attempts before readiness. Once attempted,
  only the verified writer's bounded echo repair runs; further recovery is explicit.
  Because a wait with no end is the failure mode this replaces, both give-up states are **visible**
  in the transient `state/launchDelivery.ts` and rendered by the QUEUED badge's amber ⚠ + tooltip
  (`launchTooltip`, pure): `stalled` = gate open, no terminal yet, **still held** (raised by a
  `LAUNCH_STALL_MS` timer with a fire-time re-ask; the launch still fires whenever the session
  finally comes up) and `failed` = submission is unconfirmed, so automatic retry is stopped.
  A persisted `manualOnly` record carries that warning after reload too. Neither is ever inferred from silence, and
  the tooltip names no cause it did not measure (the node's own overlay owns the diagnosis).
  The open verbs' replies carry the same fact for callers OUTSIDE the app: `result.queued` +
  `result.queuedIds` on `open-terminal`/`open-claude`/`open-agent`, always true for the
  `--project` cold-open branch — an orchestrator was previously told "opened" either way and
  routed work to a session that did not exist. Agent-facing copy is generated in
  `canvas-control-core.ts` and pinned in its test, per the sync rule above.
  `queued:false` is NOT proof of a running CLI: Server's `deliveredIds` acknowledges terminal
  delivery only. Its initial commands are persisted before attach/send and retained on failure;
  only acknowledged sends clear them. Boot ownership remains fail-closed. Desktop `list` (live
  and stored projects) names QUEUED / LAUNCH FAILED / DROPPED / AGENT STATUS UNCONFIRMED rather
  than treating absence of a hook as success. Server v1 still explicitly refuses `list`.
  **(8) An armed node must not cold-start its own agent** (found while fixing (7)). The mount-time
  cold-restore relaunch (`fresh && agentId && canResume(...)`) carries a second, independent
  refusal beside the `paused` one (`shouldColdResume`): `!data.pendingLaunch`. A first open is
  `fresh` by definition, so every `--after` / `verify` node
  was launching a bare CLI on mount — the session the hold exists to prevent — and the held launch
  then arrived as TEXT typed into it rather than as the command it is. The delivery race used to
  mask it; gating delivery on the shell settling would have made it deterministic.
  **(9) An ERRORED upstream does not release its dependents** (issue #521, 2026-09).
  `--after` fires on idle, and a station whose turn dies on an API/model error reaches idle
  **immediately** — so a malformed-prompt station looked healthy from every surface an
  orchestrator can read, and the whole chain armed behind it launched on what it had not
  produced. The signal was already there and was being thrown away: claude and grok both fire
  **`StopFailure`** instead of `Stop` on an errored turn (already in `CLAUDE_HOOK_EVENTS` /
  `GROK_HOOK_EVENTS` — without the subscription the badge sticks on RUNNING), and both
  normalizers collapsed it to a plain `done`. It now carries **`errored`** on
  `NormalizedAgentEvent`, which `agentStatus` keeps as **`lastTurnError: {at}`**.
  Three things about the shape, each deliberate: (a) it is an **annotation, not a fifth
  `AgentState`** — an errored station IS idle, the two facts coexist, and a fifth state would
  ripple through both raw listeners, the parity test and the mobile mirror for a fact that is
  not a state; (b) it is set in `src/shared`'s normalizers, so **both shells change by
  construction** — there is nothing to keep in parity; (c) it is **TRANSIENT** like `state`,
  because after a relaunch nothing armed can fire anyway and a restored verdict would describe
  another app run's turn. It is **cleared by the next genuine new turn** — not by any
  intermediate transition, which says nothing about whether that turn produced something — so
  the refusal ends by itself when the station answers successfully. Firing with a WARNING was
  considered and dropped: a dependent that has launched cannot un-launch. Surfaces: a
  **TURN FAILED** chip on the node (red, no pulse — a verdict on a turn that is over, not
  something being waited for), the QUEUED tooltip naming the errored upstream instead of
  promising a wait, and a **`LAST TURN ERRORED` marker on the `list` rows** — on the ROW
  because a seven-station fan-out should cost one call to learn this, not seven. **No error
  TEXT is claimed**: whether the hook payload carries the failure message has not been
  measured, and `last_assistant_message` is the previous assistant turn rather than the error,
  so reporting it as "the error" would be a confident wrong fact. Reading the text, and the
  *failed-to-start* watchdog (a station that never emits ANY hook event — the opposite failure,
  which hangs dependents honestly rather than firing them wrongly), stay open.
  **Settings (`settings`, 2026-09):** `settings [--project <id>]` lists, `settings --get <key>`
  reads, `settings --set <key> --value <v> [--project <id>]` asks to change — flags only, because the
  shim drops a positional sub-action for an unlisted verb and an SSH host keeps the shim it got at
  connect. The pure `@shared/settings-verb` is the whole rule set, shared by the desktop dispatch, the
  Server Edition and main's `parseControlRequest`: an **allowlist** (`agentMessaging` per project;
  `snapToGrid`/`gridSize`/`defaultNodeWidth`/`defaultNodeHeight` machine-wide, bounds = the UI's) with
  a required `why` per entry, and a **forbidden set + name pattern that outranks it** (permission
  modes incl. `bypassPermissions`, `hookIdentityStrict`, `agentBrowserControl`, accounts/credentials/
  gateway/launch commands, telemetry, keybindings, confirm waivers, `capabilityAck`) — the test walks
  the table against both. Four load-bearing rules: (1) **every `--set` confirms**, and `settings` is
  in `DESTRUCTIVE_VERBS` (one dialog at a time) but NOT in `CONFIRM_WAIVABLE_VERBS` — no waiver of any
  scope, bypass included, answers for the user (`control-destructive.test.ts` pins no `waiveVerb`/no
  `controlConfirmDecision` in its block, and the write only on the confirm leg). (2) A capability read
  is the **grant** (`projectCapabilityGrantedFor`), never the file bit, and a capability write goes
  through `applySettingsChange` → the UI's own `setProjectCapability` (flag + `'kept'`), pinned by
  `settingsVerb.test.ts` comparing the two resulting projects. (3) Verified-only (`requiresVerified`)
  and `--project` is own-or-granted via `PROJECT_TARGETABLE_VERBS`/`gateProjectTarget`. (4) **Server
  Edition refuses every `--set` by name** — its headless opt-in (#537) is not consent to grant
  capabilities, and there is no dialog; `--get` answers from `capabilityProjectFor`, own project only.
  Mobile: N/A (the phone issues no control verbs).
  **Agent messaging's MACHINE DEFAULT (`settings.agentMessagingDefault`, 2026-09, ships OFF).** A
  project whose `.nodeterm/project.json` carries NO `agentMessaging` value is answered by this
  machine's settings.json; the rule is ONE function, `projectCapabilityEffective`
  (`@shared/project-capability-consent`), and `projectCapabilityGrantedFor` now REQUIRES the
  defaults argument so a consumer that forgot it fails to compile instead of reading every
  unconfigured project as off while Settings reads it as on. Four rules: (1) an explicit `true` still
  needs this machine's `'kept'` — `needsCapabilityNotice` is untouched and stays keyed on an explicit
  `true`, so a cloned file still notices and a project on only by default never does; (2) OFF is now
  WRITTEN — `setProjectCapability(…, false)` stores a literal `false` for a capability in
  `CAPABILITY_MACHINE_DEFAULTS` (browser control has none and still deletes the field), because
  absence now means "use the default"; `readProjectCapabilities` carries that `false` through the
  file; (3) an ABSENT field with a recorded `'declined'` stays off — that is how every pre-default
  build wrote "off", and a user's explicit no must not be undone by a default switched on later;
  "Use this machine's default" (`resetProjectCapabilityToDefault`) therefore clears the field AND the
  answer; (4) the default is forbidden to the `settings` verb (a grant over every project, clones
  included). **This does not trip the `project-capabilities.ts` header's trigger**: the notice is not
  dropped, and what the default answers is absence, whose value lives in machine-local settings.json.
  **Why it ships OFF:** `core/agents/pane-ownership.ts` records a pane's owner only on a FRESH spawn,
  so after an app restart or update every surviving pane is `unproven-target-owner` and refused —
  "on by default" would be false after every restart. The flip is a separate one-line change that
  waits for a cross-restart ownership proof (#659's signed record is the candidate). Settings →
  Agents shows the machine switch, and the per-project row is a three-way choice (default / on /
  off) plus "On in <project> (this machine's default)" — a two-position switch cannot draw absence.
  Downgrade: a pre-default build writes `false` back as a deleted field, which this build then reads
  as "use the default". Server Edition reads the same grant from its own settings.json; Mobile: N/A
  (the phone has no capability switch).
  **Review panel (`verify`, 2026-07):** `verify --node <id> [--lenses …] [--focus …] [--agent …]
  [--synthesis off]` opens one reviewer per LENS, each armed behind the target (`--after`) and
  bridged to it, wrapped in a `Verify: <title>` group, plus a judge armed behind the whole panel.
  It is **composition, not new machinery** — the two primitives above are the whole implementation.
  Prompt/lens logic is the pure, unit-tested `renderer/lib/verifyPanel.ts`; two wordings there are
  load-bearing and must not be "tightened away": reviewers are told **not to edit** (a panel is N
  agents pointed at ONE checkout — review and repair are different jobs, and only repair needs
  worktree isolation) and are explicitly **licensed to find nothing** (a reviewer under implicit
  pressure to produce findings invents them, and an invented finding costs someone else the time to
  disprove it). Unknown lens words are **kept** with a generic brief, not rejected — a table that
  only accepts what it already knows would be useless for the review nobody anticipated. Reviewers
  inherit the TARGET's `accountId` (its transcript resolves inside that account dir), not the
  caller's. The judge is armed on ids that exist only in that tick, which is why `armAfter` takes
  `extraLive` — without it the reviewers would look *deleted*, deletion counts as satisfied, and
  the judge would fire before a single review existed.
- **Context Link** — a node action gated by `CONTEXT_LINK_CAPABLE` (claude/codex/gemini/opencode/grok;
  custom agents + plain terminals excluded). **grok joined in 2026-09, and the file matters:** its
  readable conversation is `chat_history.jsonl`, NOT the `updates.jsonl` its own hook payloads
  advertise and this line used to name. Routing through the advertised path does not error — it opens
  a real file, parses nothing, and hands the linked agent an EMPTY transcript with no diagnostic, so
  a reader who trusts the old wording will build the silent failure this note exists to prevent
  (`core/handoff/locate.ts` pins it): drawing an edge between two builtin-agent nodes lets each
  READ the other's context on demand (pull, not push). Architecture (2026-07, SSH-capable — see
  docs/ssh-agent-skills.md): the **desktop does the reading AND the parsing**; the CLI the agent
  runs (`context.sh`) is a thin POSIX **sh+curl** shim that POSTs to the hook server's
  `/context-link/<verb>` route and prints the text/plain reply (the Electron-as-Node CLI is
  retired — its embedded-JS parser now lives as tested TS in `core/context-link-render.ts`:
  parsers for **all four** formats — claude JSONL / codex rollout / gemini event-sourced chat /
  opencode export — plus `renderContextLink` over injected fetchers). `src/core/context-link.ts`
  coalesces renderer updates before workspace-map construction with a non-resetting task.
  Intermediate ACL publications retain previously resolved paths keyed by node, agent, session,
  account, cwd, remote/local placement and hook path. Ingest prunes changed/removed identities,
  so changing back during queued discovery cannot revive an invalidated path. Reinitialization
  clears the cache, and only current-revision discovery may refill it. The service
  holds the link docs in memory (per-node files under `<userData>/context-links/` remain as a
  debug aid), carries per-entry `agentId`/`sessionId`/`accountId`, and answers the route;
  **authorization** = the doc is selected by the REQUESTER's node id, so a token-holding caller
  can only read nodes in its own (directional) link map. Codex/gemini paths resolve via the
  handoff locators (`locateCodex`/`locateGemini` by sessionId); claude keeps the hook-fed path +
  `locateClaude(sessionId, accountId)` fallback (cwd-newest is claude-only).
  `useContextLinkSync` publishes semantic map changes from live edges and subscribes to
  background project/status changes. Geometry/status render churn cannot postpone publication;
  relay-bound projects never enter the local core's map. A render-captured project epoch prevents
  outgoing live nodes replacing the incoming project's persisted map during a tab switch. Core
  replaces the read authorization map synchronously, then enriches/writes debug documents through
  a recoverable serialized queue; revision checks prevent obsolete enrichment restoring a removed
  link. Transcript paths can be temporarily unavailable while the current snapshot is enriched.
  **SSH projects:** the shim +
  skill are installed on the remote host at connect (`RemoteHooks.installContextLink`, gated on
  the VERIFIED reverse hook tunnel; POSTs ride `--unix-socket` through it); a remote node's
  transcript is read over the ControlMaster (`initContextLink(ptyManager, deps)` — `src/main`
  injects `isRemoteNode`/`readRemoteFile`/`runRemoteCommand`, bounded tail reads), its hook-fed
  path is jailed at ingest (`isSafeRemoteTranscriptPath`), and `resolveLinkTranscript` REFUSES
  the local locators for remote nodes (they'd resolve a stranger's local transcript). Server
  Edition IS wired (`src/server/context-link.ts` calls `initContextLink(ptyManager, {})`) but
  passes no remote deps → **local-only**, which is the complete answer there: that shell runs ON the
  host whose transcripts and tmux it reads, and SSH projects are a desktop-only concept. Discovery is per-agent: claude installs a
  `get-linked-context` skill; codex/gemini get an idempotent marker block
  (`<!-- nodeterm:get-linked-context:start/end -->`) merged into `~/.codex/AGENTS.md` /
  `~/.gemini/GEMINI.md`. On connect an idle-gated one-line note is injected into each endpoint
  (claude → skill pointer; codex/gemini → inline CLI command via `contextLink.info()`).
  (Replaced the earlier MCP-based bridge.)
  **Note links:** a sticky note can be connected to ANY terminal node (one-way, sticky →
  terminal). On connect, agent sessions get a one-shot idle-gated push of the note text
  (`buildNotePushMessage`, single-line, truncated at 2000 chars); plain terminals get no
  push (sendText appends Enter — the text would execute). The note's live text also rides
  the link file (`ContextLinkInfo.note`), so Claude reads the current text via the
  get-linked-context CLI (`summary`/`transcript` print it; `list` marks `(note)`). Pure
  edge/push/map logic in `renderer/lib/noteLink.ts`.

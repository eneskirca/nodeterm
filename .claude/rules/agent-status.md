---
paths:
  - "src/shared/agents/normalize*.ts"
  - "src/shared/agents/stale.ts"
  - "src/core/agent-session-name.ts"
  - "src/core/context-*.ts"
  - "src/core/*-session.ts"
  - "src/core/*subagent*.ts"
  - "src/core/session-name-sweep.ts"
  - "src/core/transcript-*.ts"
  - "src/core/remote-transcript-locate.ts"
  - "src/core/remote-ssh/transcript-window.ts"
  - "src/core/agent-status-mirror.ts"
  - "src/renderer/state/agentStatus.ts"
  - "src/renderer/state/agentNodes.ts"
  - "src/renderer/terminal/agent-liveness.ts"
  - "src/renderer/terminal/live-work.ts"
  - "src/renderer/lib/chatSendGate.ts"
  - "src/renderer/lib/claudeBranch.ts"
  - "src/renderer/lib/completionAlert.ts"
  - "src/renderer/nodes/ChatPanel.tsx"
  - "src/renderer/lib/chatPanel.ts"
  - "src/renderer/components/ContextMeter.tsx"
  - "src/renderer/nodes/SubagentNode.tsx"
  - "src/renderer/nodes/LoopNode.tsx"
  - "src/server/agent-status.ts"
  - "src/main/context-ensure-wiring.test.ts"
---

## Agent status, context meter and session surfaces

- **Claude session context capacity (#818)** — the managed hook reports only
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from the effective Claude process environment (including
  `--settings` env), never the GUI/server process environment. HookServer validates decimal safe
  integers and verified node identity before passing optional `contextWindow` metadata to BOTH
  shells. Missing metadata means an older/unverified hook; explicit null means the current hook
  observed no valid override and clears the old observation. Local and SSH tails apply the exact
  per-session limit before the family estimate, including SMALLER limits; equal model ids do not
  share configuration. The renderer labels family fallbacks as estimates. Claude observations are
  not loaded from localStorage: `context.ensure` rehydrates usage, and until another verified hook
  observes the session env an idle Claude session has only an estimated window. No arbitrary
  endpoint fields, credentials, config-file reads or CLI commands are involved. A changed transcript
  starts fresh tracked state; unchanged hook observations never replay usage. Only `context.ensure`
  explicitly replays the live snapshot for a remounted consumer. Async reads from replaced/untracked
  entries cannot publish.
  Desktop and Server share validation; the SSH tail receives the remote hook's own env. Canvas and
  kanban share ContextMeter. Mobile's separate implementation needs the same provenance distinction.
  Gateway catalogue/accepted-launch work remains in #723/#725; this does not replace those PRs.
- **SSH context polling is a bounded byte protocol** (issue #816). The initial snapshot reads
  only the last 1 MiB and records the absolute end offset; subsequent polls process at most
  1 MiB. `core/remote-ssh/transcript-window.ts` measures size and uses block-aligned POSIX `dd`
  with base64, transferring less than 1.6 MiB including alignment/framing; idle replies contain
  only the size/range header. The encoded dd exit status must survive the shell pipeline:
  pipeline success alone can hide a failed read. Short/malformed replies and SSH failures throw,
  retain the cursor, and back off from 2s to 60s with payload-free diagnostics. Bootstrap and
  detected truncation restore usage without replaying historical task notifications/tool results,
  including a historical partial line completed later. A changed remote reference replaces its
  tracking generation so stale in-flight replies cannot publish. Server Edition uses the local
  core tail on its host (no SSH-project manager); mobile has its own direct-SSH implementation,
  so this desktop fix makes no claim about that separate path. Real `/bin/sh` fixtures cover
  >20 MiB idle files and a new notification split inside UTF-8; BSD/macOS SSH remains a device check.
- **Context-meter rehydration (`context:ensure`)** — the meter is fed by hook events, and a tmux
  session outlives the app, so a continuing session that is idle after a restart emits nothing and
  its meter stays blank until the user's next prompt. The mount-time read that exists to close that
  is `core/context-ensure.ts` (`registerContextEnsureIpc`), **in core so BOTH shells serve it** — it
  used to be inline in `src/main/index.ts` and the Server Edition had no handler at all, so a browser
  node's meter filled only on its next turn too (issue #813; the identical hole
  `core/transcript-ipc.ts` was moved to core to close). Three rules:
  - **It routes per agent; it does not widen a gate.** `agentId` picks that agent's OWN locator and
    tail — claude → `resolveTranscript`, codex → `locateCodex`, gemini → `locateGemini` (the last two
    keyed STRICTLY by session id, no cwd fallback, so neither can adopt a session that is not its
    own). A closed switch: an agent that is not in it gets **no meter**, never claude's resolver.
    That is what let the renderer gate move from `readsClaudeTranscript` to `showUsage` — the danger
    was never the meter, it was one resolver answering for four agents. **grok is deliberately
    absent**: its meter reads a `signals.json` whose directory is learned from a hook event, so after
    a restart there is nothing to rehydrate FROM (`locateGrok` resolves a different file, the
    conversation). Structural, not pending.
  - **A remote node is resolved on its HOST or not at all.** The desktop injects `ensureRemote`,
    which asks the host through `remoteTranscriptRefFor` — the ⌘M path's locator, jail
    (`isSafeRemoteTranscriptPath`) and cache, reused as a second consumer rather than copied. Its
    "could not resolve" is **terminal**: falling through to any local resolver would search THIS
    machine for a file that only ever existed on the other one, and claude's cwd fallback would
    happily meter an unrelated local session under the remote node's id. Remote Codex uses its own account-scoped locator and parser over the same bounded SSH
    reader. Its reported transcript window wins; Claude estimates must never supply a Codex
    denominator. Unresolved/disconnected remote nodes cannot fall through to local readers.
  - **Nothing negative is ever cached.** A clean miss and a failed ssh call are indistinguishable to
    the locator, so both cache NOTHING and the next mount retries in full — a momentarily dead
    ControlMaster must not be remembered as "this session has no transcript", or the meter stays
    blank until the next turn anyway, which is the bug arriving by another route. The only
    de-duplication is of **concurrent in-flight** calls (a canvas mounts dozens of remote nodes at
    once and each resolve is an ssh exec on someone else's machine); it releases on settle, so it is
    not a cache. **No timer** — one read at mount, the same rule Remote usage and session memory
    follow.
  Surfaces: Desktop full; **Server Edition** full and local-only (it runs ON the host whose
  transcripts it reads — the legitimate asymmetry, stated the way the SSH skip is); kanban card +
  card modal render the same `ContextMeter` from the same store and inherit it; mobile N/A (its own
  context display, separate path). Tests: `core/context-ensure.test.ts` (routing, remote
  fall-through, no negative cache) + `main/context-ensure-wiring.test.ts` (the shell's closure, at
  source level, because it closes over `ptyManager`/`sshProjectManager`).

- **State via each agent's hooks → shared 4-state model** — detection uses the agent's own
  hooks, **not** output parsing. `src/shared/agents/normalize.ts` has per-agent normalizers
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status`, drives the `agentStatus` store, fires throttled
  (5s/node) background notifications, and records the session id. Header shows a pulsing
  **RUNNING** (working) / **NEEDS YOU** (waiting/blocked) badge.
- **DROPPED — the CLI died and nobody told us** (`renderer/terminal/agent-liveness.ts`, issue #616).
  Every ORDERLY exit announces itself: Eco's `/exit` sets `hibernated`, "Pause session" sets
  `paused`, and a user typing `/exit` fires the CLI's own SessionEnd, which `setState(id, undefined)`
  records. A KILL announces nothing — the process is gone before it can run a hook, and tmux's shell
  still owns the pane so the PTY never closes. The node therefore kept rendering its last badge over
  a dead conversation, with the CLI's parting `Resume this session with: claude --resume <uuid>` and
  a stray `^[%` in the pane as the only evidence. Not exotic: measured on the reporting host
  (2026-09-04) 62 GB RAM with swap fully consumed, kernel `oom_kill` at 187, 147 live `claude`
  processes holding 44 GB. The signal is `#{pane_current_command}` reading as a shell while the
  status table still believes an agent is parked there, and the four refusals are the feature:
  a `null` pane read is NEVER evidence (a downed ControlMaster must not make a canvas of healthy
  remote nodes claim they died); `hibernated`/`paused` are our own exits and already have chips;
  **only `done`**, never `working` — a turn in flight is exactly when a tool subprocess can own the
  pane's foreground, so the alarm would fire on a healthy agent running a shell command; and the
  agent must be in **`SESSION_END_CAPABLE`**. That last list is the false-positive gate and is
  DERIVED from `normalize.ts`, not chosen: exactly four normalizers map `sessionPhase: 'end'`
  (claude, gemini, copilot, grok) and **codex and opencode map none**, so on those two a deliberate
  `/quit` and an OOM kill leave byte-identical evidence and the chip would be a coin flip shown as a
  fact. Adding an id without first adding its normalizer branch puts a chip on every session its
  owner quit on purpose — `agent-liveness.test.ts` asserts the list against that source. The verdict
  (`agentStatus.dropped`) is TRANSIENT, a stronger call than the other clocks: it is a claim about a
  pane, panes are re-measurable in milliseconds, and a persisted one would strand a stale chip on a
  node someone resumed by hand. ANY hook event withdraws it — the one self-heal that deliberately
  does not gate on `alive`, since `done` disproves "there is no CLI in this pane" even though it must
  not clear `hibernated`. Cost is bounded by asking only for a node that is BOTH watched and already
  believed to be a parked agent. Resume reuses the hibernation wake closure unchanged, which
  re-reads the pane and refuses anything that is not a shell. Chip on the node header, the kanban
  card and the card modal; Desktop and Server Edition identical; relay tabs answer `null` and are
  never judged. **A second thing this catches, unplanned:** in the same sweep 9 of 149 panes sat at a
  bare shell because a cold-restore `--resume` had answered *"No conversation found with session
  ID"* — the persisted `sessionId` outlived its transcript. The chip surfaces those too, but the
  Resume it offers still replays that dead id — but cold restore no longer creates the state: it
  probes `transcript:exists` first and launches bare on a positive `absent`, saying so on the node
  (see **Cold restore** in `.claude/rules/tmux-sessions.md`). Re-measured on the same host 2026-09-09: **20** of 108.

- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Selecting, focusing, dwelling into, or opening a session card
  clears `unread` and ACKs the finish across phone/notch surfaces — existing read-on-view behavior.
  This NEVER changes the workflow bucket: read state is independent from agent state.
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
- **Session name ⇄ node title** — **two lists, because the two directions are separate facts**:
  `TITLE_READ_CAPABLE` (`canReadTitle` — claude, **codex**, grok, **gemini**) is the READ leg,
  `RENAME_CAPABLE` (`canRename` — claude, grok) the WRITE leg, and **read ⊇ write** is an invariant
  pinned in `config.capabilities.test.ts`. Gemini and codex are the reason: they name their own
  sessions (codex via `readCodexSessionName`) but have **no rename command** (gemini's `/chat save
  <tag>` is a checkpoint, not a title), so one list for both legs would light the rename UI on a
  node where the write silently does nothing. The **write** is the same literal
  `/rename <name>` for claude and grok; the **read** legs are per-agent and none may ever
  search another's tree, so the routing lives in ONE place, `core/agent-session-name.ts`
  (`readAgentSessionName(sessionId, accountId?, agentId?, deps?)` — trailing/optional so every pre-grok
  caller is unchanged), serving the desktop IPC handler **and** both shells' session-name sweeps.
  Grok's read leg is `core/grok-session.ts` over `summary.json` in the session dir a hook told us
  about; gemini's is `pickGeminiTitle` (`core/gemini-session.ts`) over the transcript path its context
  tail already tracks — including the `$set` history a **resume** replays, which is exactly the case the
  read leg exists for. Routing is not cosmetic — claude's resolver *scans* `~/.claude/projects` on a
  cache miss, so an unrouted grok/gemini node paid that scan every 60 s for a guaranteed null.
  **The sweep's gate lives in core, not in the shells:** `startSessionNameSweep` defaults `supports` to
  `supportsTitleRead` (`core/session-name-sweep.ts`) and neither shell passes it — the duplicated copies
  drifted, and reverting both to `canRename` left the whole suite green while silently skipping every
  gemini node.
  - **session → title (read, claude):** the authoritative name lives in the transcript `.jsonl`, not the
    OSC terminal title (`/rename` does **not** update OSC — a known Claude gap — so reading the
    file is the only thing that works after a **resume**). `core/transcript-reader.ts`
    `readSessionName(sessionId)` resolves the session file **strictly by sessionId** (no cwd
    fallback — that would make every Claude node in one folder resolve to the same newest transcript
    and adopt each other's names) and `pickSessionName` returns the latest `custom-title`'s
    `customTitle` (the `/rename` name) else the latest `ai-title`'s `aiTitle` (auto name). Exposed
    over `pty.readSessionName`. `TerminalNode` polls it (~4 s) **only once this node's own sessionId
    is known** and **while the title still auto-tracks** (`data.titleAuto`, default true on agent
    nodes), and adopts it as the `title`. `term.onTitleChange` now feeds the `session` chip only.
  - **title → session (write):** the moment the user renames the node by hand (header rename box /
    ✦ AI-name / sidebar / command palette → all funnel through `applyManualTitle` or
    `renameSession`), `titleAuto` flips to **false** (polling stops overwriting) and the chosen name
    is pushed into the live session as `/rename <name>` via `pty.sendText` (tmux `send-keys`, same
    one-way bridge as Branch's `/branch`; works whether or not the node is mounted).
  - The launch command is left bare (no `-n`) — Claude's own name is canonical until the user
    overrides it; `titleAuto` is persisted so an overridden name survives reload/resume.
- **Search** — the command palette (⌘K) matches the session name + tags + `nt-<id>` in the
  hint, and substring-searches each terminal's **visible buffer** (captured via `pty.capture`
  on palette open, cached ~3s); content matches show "found in output".
- **⌘M transcript view (`ChatPanel`) — resolution is three-legged, and each leg fails differently.**
  `chat.readTranscript(sessionId, cwd, accountId, nodeId)` returns `ChatTranscriptResult
  {messages, found}`, NOT a bare array: an empty thread and an unresolvable transcript are
  different facts, and rendering both as "No conversation yet." is what made every failure below
  look like an empty session. (1) **Remote (SSH) nodes** — `remoteTranscriptBySession` is fed
  ONLY by hook POSTs, and a tmux session outlives the app, so after a restart an idle remote node
  has no ref and the local resolvers search the WRONG MACHINE. `remoteTranscriptRefFor` (main)
  therefore asks the host itself: the pure `core/remote-transcript-locate.ts` builds one `sh` line
  (exact `<root>/<encoded cwd>/<id>.jsonl` per root, then a glob; account root before the system
  one; `*` outside the quotes; **exits 0 on a clean miss** — "no transcript" is an answer, not a
  failed ssh), it runs over the ControlMaster, and the reply is jailed by
  `isSafeRemoteTranscriptPath` before it is read. A ref WE located is tracked in
  `locatedTranscriptSessions` so a dead one can be dropped on an empty read (the panel's Retry
  would otherwise replay it forever) — a HOOK-fed ref is never dropped that way, since an empty
  read there is usually a transient master hiccup and forgetting it sends the next read local.
  It is generated shell, so `remote-transcript-locate.test.ts` runs it for real under `/bin/sh`
  against a fake host tree — keep it that way. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
  **The composer sends only in `done` or an unknown state** (`canSendFromChat`,
  `renderer/lib/chatSendGate.ts`) — never in `waiting`/`blocked`, not just never in `working`:
  PermissionRequest and AskUserQuestion both normalize to `waiting`, the pane then holds a TUI
  select dialog this view does not show, and `sendText`'s Enter would ANSWER it ("Yes" is the
  default highlight). It also refuses any node whose CLI has left the pane — hibernated, paused,
  dropped, or **exited** (`/exit`/Ctrl+D: `state: undefined` + `sessionEnded`) — because a SHELL
  owns it and the message would run as a shell command. That test is `agentProcessInPane`
  (`terminal/live-work.ts`), the same single rule the memory levers use — never a second copy of
  the flag set — and it ranks above the state (`chatSendRefusal`). Everything is re-read from the
  store at send time, not only at render. Same trap as the in-place restart's `/exit`. The bar's ↻
  reloads on demand (beside the empty state's Retry), since a session whose hooks never report
  `working` never takes the turn-finish reload.
- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events (from Claude's `PreToolUse`/`PostToolUse` on tool `Agent`/`Task`, correlated
  by `tool_use_id`) drive a transient `state/agentNodes.ts` store. Claude launches subagents
  **async by default**: that PostToolUse is only a launch ack (`status:'async_launched'`), NOT the
  end — normalize keeps the card working, the transcript tail keeps streaming, and the real end is
  the `<task-notification>` queued into the parent transcript (sniffed by the context tails →
  synthetic `subagent-end` in `index.ts`; the notification's `UserPromptSubmit` is also not a
  `newTurn`, so it doesn't clear the fan-out). Canvas renders each subagent
  as an **ephemeral** `SubagentNode` (display-only card: type + task + working/done) connected by
  an **edge** to its parent agent node. These ephemeral nodes/edges live outside the React Flow
  `nodes` state (merged only at the `<ReactFlow>` prop), so they're never persisted
  (`flowToNodeStates`) nor in undo/dirty. **Two different clears, and the difference is
  load-bearing (issue #547):** the removal paths (node delete, project delete, the cross-project
  close, the orphan-session kill, `SessionEnd`) call `clearForParent`, which drops everything —
  a node that is gone has no work left to represent. A **new turn** calls
  `clearFinishedForParent`, which drops only `state === 'done'`. "The previous fan-out is stale by
  definition" is true of a finished card and false of a working one: Claude launches subagents
  **async**, so *"waiting for N background agents to finish"* is exactly the state in which the
  next prompt gets typed, and nothing rehydrates `byId` afterwards (`start()` fires only from a
  live `PreToolUse`; a subagent past that emits no second one) — the card was gone for the rest of
  the run while the agent kept working. The expensive half is not the missing card: Eco's
  hibernation guard derives `liveSubagents` from this same store, so the wipe let a parent with
  live background agents read as idle and get its CLI `/exit`ed. Keeping an unfinished card then
  **owes a decay** — `useAgentNodes.sweepStaleWorking`, on the same 60 s tick and the same
  `WORKING_STALE_MS` as `agentStatus`'s (imported, never re-chosen: `shared/agents/stale.ts` exists
  because three surfaces each invented their own timeout) — or a subagent whose end never arrives
  pins its card, and its parent, forever. It marks the card **done** rather than deleting it, so a
  late `finish()` is the no-op it already was and the next turn boundary takes it.
  **A third removal path is opt-in:** `settings.autoHideFinishedSubagentCards` (default OFF, and
  off reproduces the two paths above exactly) mirrors into the store as `autoHideFinished`, and
  with it on a card is dropped the moment its subagent REPORTS done, with no turn boundary. Only a
  DONE card is ever dropped, so #547's rule (a new turn keeps the cards of subagents still running)
  and Eco's `liveSubagents` are untouched. **The decay is deliberately NOT one of the paths it
  gates**: `sweepStaleWorking` fires precisely because the end never ARRIVED, which is the opposite
  of what the setting promises, and it is the one case where a visible card carries the most
  information — drop it and a fan-out whose subagents died silently leaves nothing on the canvas
  saying one was ever launched. It costs Eco nothing either way, since an absent card and a `done`
  card are the same answer to `liveSubagents`. Renderer only: Desktop and Server Edition identical,
  Mobile N/A.
  (Subagents share the parent's process — no PTY.) Each card shows
  duration/tokens/tool-uses and **expands** (click) to a **live transcript**:
  `core/subagent-tail.ts` resolves the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl`, matched by `tool_use_id` via the sibling
  `.meta.json`), tails it read-only, formats each line (assistant text + tool calls + results),
  and streams chunks over `agent:subagent-activity` into the store.
  **Codex** (2026-08-24, `spawn_agent` collaboration — issue #401) joined via its **native
  `SubagentStart`/`SubagentStop` hooks**, measured on codex-cli 0.146.0, keyed by `agent_id` (NOT
  `tool_use_id` — nothing correlates the spawn tool call with the Start it launches; agent_id is
  stable across the child's life, parallel + nested spawns included, and nested children fire
  through the same subscription so every card connects flat to the owning terminal node). Facts a
  refactor must not lose: **(1)** every agent_id-tagged codex event carries the PARENT's
  `session_id` with the CHILD's rollout as `transcript_path` — both raw listeners skip the
  context-meter track for them (else the parent's meter re-points at the child) and `normalizeCodex`
  returns null for child tool events (else a child Bash event flips a finished parent back to
  RUNNING after an async spawn); pinned by `hook-verified-parity.test.ts`. **(2)** the spawn task
  text is **encrypted end-to-end** (`tool_input.message` and the NEW_TASK payload are Fernet blobs)
  — there is no `taskLabel`; the readable `Task name:` header reaches the card via the activity
  stream instead. **(3)** the live tail is `subagentTail.trackFile` (the path is handed to us —
  no meta-dir matching) with the **stateful, per-entry** `createCodexSubagentFormatter`
  (`core/codex-subagent-format.ts`): a spawn child is a FORK of the parent thread, so its rollout
  opens with a replay of the parent's context, suppressed until the
  `inter_agent_communication_metadata` / NEW_TASK gate — per entry, because two concurrent
  subagents sharing one closure would gate each other. **(4)** codex's `SubagentStop` IS the real
  end (no async-launch-ack trap, no task-notification sniffing), carrying
  `last_assistant_message` as the card's result. Remote (SSH) codex nodes get cards but no live
  activity yet (the child rollout is on the host; claude's `remote-subagent-tail` has no codex
  counterpart — follow-up).
  **Grok** (2026-09) joined via its own native `SubagentStart`/`SubagentStop`, measured on
  grok 1.0.13 by launching two `explore` children in parallel. Keyed by `subagentId` occupying
  the same `toolUseId` slot the store already uses (claude correlates by `tool_use_id`,
  codex by `agent_id`; grok has no tool call behind a subagent). Facts a refactor must not
  lose: **(1)** the start's `sessionId` is the PARENT's and the stop's is the CHILD's own
  (equal to `subagentId`) — keying on it files start and stop under different cards and the
  started one never closes. **(2)** the child's transcript is DERIVED from `subagentId` as
  `chat_history.jsonl` (`core/grok-subagent-format.ts`); the start's `transcriptPath` is the
  PARENT's, and even the stop names `updates.jsonl`, which parses to nothing. **(3)** a
  `session_end` bearing `subagentType` returns early in both raw listeners — without that a
  child finishing tears down the PARENT's session state. **(4)** `description` arrives only
  on the start. The four captured payloads live in
  `src/shared/agents/__fixtures__/grok/hook-payloads.json`, pinned by
  `normalize.grok.capture.test.ts`. Remote (SSH) grok nodes get cards from the hook but no
  live tail yet (the child dir is on the host; same gap as codex).
- **/loop, /schedule & /cron node** (agents in `RECURRING_CAPABLE`) — detected from the **tools**
  the agent invokes (robust; users often phrase it in natural language so the prompt rarely starts
  with the slash): `PreToolUse` for `Skill` (skill ∈ loop/schedule/cron), `CronCreate` (→ cron,
  label = cron expr · prompt), or `ScheduleWakeup` (→ loop) — plus a `UserPromptSubmit`
  `/loop|/schedule|/cron` prompt-prefix fallback, all surfaced as `recurring` normalized events.
  Sets `agentStatus.loop` ({count, prompt, items, kind}); for in-session `loop` each turn-done
  bumps the count + appends `lastMessage` (schedule/cron run in the background, so they aren't
  counted). Lifetime by kind: `loop` dies with its session; `cron`/`schedule` **outlive turns,
  sessions and app restarts** (`loop` is persisted in the agentStatus localStorage) and are
  cleared by a `CronDelete` `recurring`-end event or the card's own × (dismisses the card only).
  `clearForParent` (new turn) leaves the loop card's dragged position alone. Renders an ephemeral
  **LoopNode** labelled by kind, connected by an edge to the parent, plus a small header badge.
- **Branch conversation** — node action (`IconBranch`, Claude-only via `BRANCH_CAPABLE`): sends `/branch` into the
  existing terminal via `pty.sendText` (tmux `send-keys`) and opens a new Claude node that
  resumes the parked original with `claude --settings … -r <ORIGINAL_ID>`. The original id is
  the session id already known from hooks; `lib/claudeBranch.ts` is the fallback that parses
  `pty.capture` output when the id isn't known. The source node stays on the new branch.

## Subagent reload replay (#680)

`core/subagent-replay.ts` retains at most 512 running starts for the existing WORKING_STALE_MS,
with original host timestamps. The shared mirror event path feeds it (including synthetic async
ends); session boundaries and clearNode discard it. Both shells expose the same read, and desktop
preload / browser / relay subscribe before requesting it. Only lifecycle events wait behind the
snapshot (bounded to 512 events / 3 seconds); live permission alerts are not delayed or replayed.
No disk restore, transcript backlog, completed-card replay, or authorization evidence is provided.
A host restart or a missed original start is still outside this recovery.

# Agent support — deep reference

Moved verbatim from `CLAUDE.md` (the "Agent support" section) so the always-loaded file stays
small. `CLAUDE.md` keeps a short summary of the rules below and links here. When a rule here
changes, update both.

## Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / custom)

**Message scope publication:** desktop `send`/`reply`/`notify` wait for pending active-canvas edits
to be saved when either endpoint is on that canvas (`renderer/lib/messageScopeSync.ts`). `list`
and context links can already see a newly opened node while main's `persistedCanvases()` cannot;
the scope resolver reports that absent target as `cross-project`. The publication barrier never
travels, never overrides an external-edit conflict, and does not authorize anything: main still
checks unique project membership, runtime ownership, consent, verified status and the native pane.
An unrelated active canvas is not saved for a background message. Server control already writes
its nodes through the authoritative store; the renderer barrier is a desktop concern. Mobile is
not an agent-message sender.

**A `send` to a node that has not STARTED yet is queued, not refused** (`targetNotStarted`,
`agent-messaging.ts`). A node opened into a project that is not on screen without `--run-now`
exists only as a held launch until the project is viewed, so no spawn has recorded its pane owner.
When the owner is unproven AND no session exists AND this machine holds a launch for it
(`WorkspaceStore.heldLaunch`, the machine-local `localExec` overlay), the outcome is
`targetNotStarted` and the deliver-on-idle queue holds it; the flush re-runs every gate against the
pane the spawn will have proven. A LIVE pane with no proven owner stays `unproven-target-owner` —
that refusal is the security property. Such a message waits up to 24 hours
(`NOT_STARTED_TTL_MS` = `QUEUE_PERSIST_TTL_MAX`): the start waits for a person to open the project,
and the ordinary 5-minute TTL lost the message in the field (queued 19:12, expired 19:17, project
opened 19:27). It is not carried across an app restart (no session was recorded to bind it to), and
a node deleted before it starts keeps it until the TTL. A `targetStatusStale` target — a station
started a moment ago (`--run-now`, `run`) that has not posted its first hook — is queued too, with the
ordinary TTL: a retry cannot help before that hook, and its first verified `done` flushes the queue.
Both shells wire `heldLaunch`.

**A board comment that @mentions a session is a message from a PERSON** (`@shared/board-comment`,
`deliverBoardCommentFromUi` in `core/agents/agent-messaging.ts`). The comment composer's @ picker
inserts an id-based token `@[label](node:<id>)` (the id is the authority, the label only a fallback
name); on send, each mentioned session gets its own delivery through the SAME `runDelivery` an
agent `send` takes — scope, runtime pane ownership, the per-project `agentMessaging` switch, flow
control, the pane probes, the nonce envelope, the receipt, the deliver-on-idle queue with its TTL.
What differs is only who it is from: the scope is "the target is on the comment's board"
(`resolveBoardCommentScope`); the PAIR window belongs to the board (`board:<projectId>` — one comment
per session per 10 s, whichever comment) while the FAN-OUT budget belongs to the comment itself
(`reserveFlow`'s `fanOutKey`, `board:<projectId>:<commentId>`), because a person's turn is one comment
and an earlier comment's in-flight holds or queued flush must never spend a newer one's (review
finding; both scenarios are tests); a comment mentions at most `BOARD_COMMENT_MENTION_MAX` =
`FANOUT_PER_TURN` sessions and is refused whole above it; a pair-limited board comment is QUEUED
rather than refused (`BOARD_QUEUE_ON` — an agent retries, a person could only post again; the
flush re-runs the limiter) AND re-offered on a timer when the window ends
(`DeliveryQueue.retryAfter`, armed at enqueue and at every `rateLimited` re-queue, one pending nudge
per target): the queue otherwise flushes only on the target's `done`, and a window ending emits
nothing — a session already idle, or whose `done` landed inside the window, left the comment to
expire at the TTL; and the envelope reads `from: board comment by <author>` with no node id
and `reply-to: none (…)` (`BOARD_COMMENT_REPLY_TO`; both agent-facing bodies render it from the
constants). An agent node TITLED like that is labelled `node titled "…"` in its own `from:` line, so
it cannot pass as a person. The body is the comment with each token turned into the `@<name>` its author saw
(`mentionNameForAgent`: the token's label reduced to letters, digits, spaces and `. _ - #`, capped at
40, else the node id — a node title is whatever the project file says, and it lands in another
agent's prompt), then `sanitizeChatText` (every C0/C1 control but `\n`/`\t` — the one shared rule)
and a cap. A comment's parallel mention deliveries share ONE `syncMessageScope` save (`coalesce`).
**Only the local user, typing in THIS app, can trigger it.** The log is a shared file — a git pull,
another instance, a relay peer or a team-presence guest can put a token in it — so NOTHING that
reads the log reaches a delivery: the one call site is `BoardLogPanel`'s send
(`board-comment-trigger.guard.test.ts`), the IPC (`agent:board-comment-deliver`) is a raw,
main-window-only `ipcMain` handler that no peer can dispatch into and is also `HOST_ONLY`, and the
renderer refuses a relay-bound project and a browser tab (`canDeliverBoardComments`). Around the IPC
Canvas takes the same two steps as `send`: the target's `guardConcurrentRestart` lock and
`syncMessageScope`. **No silent success**: every outcome is on the comment row — `sending…`, then
the reply's typed outcome (with the `notPermitted` reason) from this app run, else the latest
`agent-message` trace line in the log whose `from` is `board-comment:<commentId>` (the trace now
carries `reason` too, and the queue hands its trace leg the queued request, so a board comment's
`queued`/`expired` lines land on ITS board whoever owns the pane by then). Log lines are trusted
ONLY for comments this machine sent (`nodeterm.boardCommentsSent`, localStorage, bounded): the log
is shared, so a teammate's comment arrives with THEIR machine's trace lines and a forged line is one
append away — such a comment shows no status, and its lines stay ordinary feed rows. For our own:
a line dated in the future is ignored, a `queued` older than `BOARD_COMMENT_QUEUE_STALE_MS` (the
queue TTL + 1 min — a crash still never writes its end; a clean restart does, since the durable
queue expires a restored board comment at boot, see **Durable orchestration state**) says no outcome
was recorded, and a mention with no record at all says so too. A trace line is hidden as a row only
on the card whose comment row shows it; the mentioned session's own card keeps "routed a board
comment here: …". Text tables are read with `Object.hasOwn` (values come from the shared file).
The card modal's capture-phase Escape defers to the composer while its @ picker is open. Desktop: full. Server Edition and relay
tabs: display-only by design (the bridge answers `notPermitted: unsupported-edition`; the picker is
not offered) — a browser or a relay guest typing into this machine's panes is exactly the
cross-user injection this refuses. Mobile: N/A (the phone posts no board comments).

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts). That is the DEFAULT instance,
the local core's. A relay / team tab's session gets its own **keyless** store (`agentStatusForApi`):
it persists nothing, never acks a read (no `ackDone` callback), and is fed by `applyAgentEvent`
(`state/applyAgentEvent.ts`), the same reducer Canvas's listener uses — see "A relay session owns
its agent status" under Hosted team relay.

- **Agent registry + capabilities** — `src/shared/agents/config.ts` holds `AGENT_CONFIG`
  (claude/codex/gemini/copilot/opencode/grok: id, label, spawn command, color, `promptInjectionMode`, …) keyed
  by an **open** `AgentId`
  type (so custom ids fit). Capabilities are membership lists, not flags:
  `AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`, `SUBAGENT_CAPABLE`, `RECURRING_CAPABLE`,
  `BRANCH_CAPABLE`, `CONTEXT_LINK_CAPABLE`, `USAGE_CAPABLE`, `CHAT_CAPABLE`,
  `TRANSFER_SOURCE_CAPABLE`, `RENAME_CAPABLE`, `TITLE_READ_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `PERMISSION_MODE_CAPABLE`, `MODEL_SWITCH_CAPABLE`, with helpers (`hasHooks`,
  `canBranch`, `canContextLink`, `canChat`, `canRename`, `canReadTitle`, `hasPermissionMode`, …).
  Branch stays **Claude-only** purely by being in only `BRANCH_CAPABLE`. The ⌘M **ChatPanel**
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok + gemini + codex + copilot +
  opencode** since 2026-09: grok's `chat_history.jsonl`, gemini's session file, codex's rollout,
  copilot's `events.jsonl` and opencode's `opencode export` document each get their own reader, and
  `chat:read-transcript` routes by agent. That list had
  to be SPLIT to do it — `CHAT_CAPABLE` carried two facts that coincided while claude was its only
  member ("we can render this" and "claude's resolver can locate and parse this file"), and the
  second now lives in `CLAUDE_TRANSCRIPT_READABLE` (claude only). Merging them back is a
  cross-session read of someone else's transcript; `config.capabilities.test.ts` pins the pair.
  The other lists span more agents, and the memberships below are the ones to check before assuming
  "claude-only" (all verified against `config.ts`, 2026-09-02): the per-node **context meter** is
  `USAGE_CAPABLE = claude/codex/gemini/grok` — grok states BOTH numbers, and its own percentage, in
  `signals.json`;
  the **permission mode** is `PERMISSION_MODE_CAPABLE = claude/grok/gemini/codex`; the session-name
  sync is **split in two** — `TITLE_READ_CAPABLE = claude/codex/grok/gemini` (read) ⊇
  `RENAME_CAPABLE = claude/grok` (write), because gemini and codex name their own sessions but have
  no rename command (codex's read leg is `readCodexSessionName`);
  **Context Link** spans five builtins
  (`CONTEXT_LINK_CAPABLE = claude/codex/gemini/opencode/grok`; the one builtin outside it is
  copilot). UI gates
  on these helpers — no hardcoded `=== 'claude'`. **Custom agents** (user-defined in Settings,
  `customAgents`) inherit the declared `baseAgent` harness through `capabilityAgentId`; a custom
  agent with no base remains spawn + terminal-title + process status only. Per-agent write-ups:
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`**, **`docs/antigravity-agent.md`** (there is none for codex — its approval mapping
  and every value's reasoning live in `src/shared/agents/approval-mode.ts`);
  the distilled rules are **Adding a new agent** at the end of this section.
- **Model gateway / switcher** — `settings.modelGateway` stores one gateway root + a NON-SECRET
  credential reference: `${env:VAR}` for environment mode or
  `${secret:model-gateway-api-key}` for a literal held by `ModelGatewayCredentialService`. Desktop
  literal keys reuse the GitHub token store's safeStorage encryption / 0600 fallback; Server
  Edition uses the same generic 0600 atomic store. Legacy plaintext settings migrate only after
  the secret write succeeds. `shared/agents/model-gateway.ts` is the ONE mapping from a base
  harness to derived routes, env vars, compatible models and safely quoted model flags. Env
  expansion reuses `shared/agents/expansion.ts` and happens only in core against the host process
  environment; an unset reference fails closed instead of sending a token or partial credential.
  Discovery at `/v1/models` is the **OpenAI Models API convention**, implemented by both LiteLLM
  and Bifrost; the current `/openai/v1` + `/anthropic` launch-route derivation is Bifrost's layout,
  not the source of the discovery convention. Discovery sends the standard bearer header plus
  Bifrost's `x-bf-vk` header (needed by legacy, non-`sk-bf-` virtual keys), and runs in core
  (`agent:discover-models`) so browser CORS cannot block the Server Edition and the key never
  enters a terminal command. Support is a
  capability (`MODEL_SWITCH_CAPABLE = claude/codex/copilot`) resolved through `capabilityAgentId`, so a
  custom agent with a supported `baseAgent` inherits it automatically — the settings UI and canvas
  menu carry no agent allowlist. A model switch SIGTERMs the pane's foreground non-shell process
  group (never types `/exit`) and RECYCLES the tmux session before cold-resume: an existing shell may
  predate the gateway setting, and tmux env changes do not retroactively change that shell's
  environment. Recreating it guarantees the current URL/key applies without typing a secret into
  the pane. On Windows (session host / direct ConPTY — no process groups) the kill is `taskkill /T
  /F` on the re-proven agent pid only, never the console root, and requires the agent-identity gate
  (`session-host/terminate-owner.ts`; an older live host answers `'unsupported'`). Ordinary Restart stays in-place. Custom-agent env is still merged last and may override
  the shared mapping. Desktop and Server Edition use the same core handler; relay tabs deliberately
  do not apply this machine's gateway to another core. Mobile needs a settings/model-picker surface
  before it can expose the feature.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
  `RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE`,
  `SESSION_ID_CAPABLE` and `SUBAGENT_CAPABLE`. Subagent cards come from grok's native
  `SubagentStart`/`SubagentStop` hooks, keyed by `subagentId` — measured on 1.0.13 by launching two
  `explore` children in parallel (same type, different ids; the start's `sessionId` is the PARENT's,
  the stop's is the CHILD's own and equals `subagentId`, so that is the only id both events share).
  The spawn tool call is not the card key. The other four came off the blocked list
  in 2026-09, once a machine with a logged-in grok session produced real fixtures: context links and
  the ⌘M panel read `chat_history.jsonl` (NOT `updates.jsonl` — see below), and the meter reads
  `signals.json`. Its hook config is a **directory** (`$GROK_HOME/hooks/*.json`, all merged), so nodeterm
  **owns one file outright** (`nodeterm-status.json`) instead of merging into a shared settings file —
  which is also why a malformed copy of it is *healed* rather than preserved, locally and on an SSH
  host (`RemoteHooks.installGrokRemote`, under the host's own `$GROK_HOME`). Its dialect is
  **camelCase keys with snake_case event VALUES** (`{"hookEventName":"pre_tool_use"}`) — the SDK path
  flips the keys to snake_case, so `normalizeGrok` canonicalizes the event name and reads every field
  twice, and the shells share one decoder (`grokRawFields`). It carries **no `transcript_path`**, so a
  session directory is DERIVED from `cwd` + `sessionId` (`core/agents/grok-paths.ts`, the one
  `$GROK_HOME` rule — `core/usage/grok-usage.ts` delegates to it) and remembered in the shells' raw
  listener; the name read is `core/grok-session.ts` over `summary.json`, routed per agent by
  `core/agent-session-name.ts`. **The tool-event `matcher` is a regex: `.*`, never `*`** — a bare `*`
  is invalid and silently stops tool events firing (hence `ManagedHookEvent`). Grok also reads
  **`~/.claude/skills`** (Claude compat), which is why canvas control needed no new installer, and
  **`~/.claude/settings.json`**, so every grok event ALSO fires nodeterm's claude hook — an **inert**
  cross-fire (`normalizeClaude` finds neither grok's camelCase keys nor, in the SDK dialect, its
  lowercase event values), pinned by tests; canonicalizing claude's event-name compare would make it
  harmful. The `auto` permission-mode **version gate is claude's alone** (it is fed by a `claude
  --version` probe), and grok's mode flag must go **BEFORE** its `--` separator, which is
  end-of-options. Full picture, dialect traps and the device checklist: **`docs/grok-agent.md`**.
- **Grok NEEDS YOU is confirmed against grok's own event log** (`core/agents/grok-permission-gate.ts`,
  inside the hook server, so both shells get it from one place). MEASURED on grok 1.0.13
  (2026-09-30, interactive TUI against a local fake chat_completions model, fixture
  `shared/agents/__fixtures__/grok/permission-events.json`): the `permission_prompt` notification is
  genuine (fired 1–20 ms after grok writes `permission_requested` to `<session dir>/events.jsonl`),
  but grok is silent about the ANSWER — approve fires no hook until the approved tool FINISHES (the
  capture's 10 s command read NEEDS YOU for 10 s), a dismissed dialog (Ctrl+C) fires none at all
  (the only later hook is `idle_prompt` 60 s on, which the mirror deliberately never lets clear a
  `blocked` node — a stuck badge until the next prompt), and a rejection fires `permission_denied`
  then cancels the turn with no Stop (RUNNING for 60 s). `events.jsonl` records all three:
  `permission_resolved {decision: allow|deny|cancelled}` and `turn_ended {outcome: cancelled}`. The
  gate ties each notification to ONE `permission_requested` written within 5 s before it and
  publishes what the file says: still pending ⇒ `blocked` + a bounded 1 s watch (a `stat` per tick
  while nothing changes); answered ⇒ `working` (unverified — a file read is not a hook POST — including when the
  answer is already on disk as the hook is read); a
  cancelled turn ⇒ `done` + `interrupted`. **The trap it is shaped around**: a SUBAGENT's prompt
  fires with the PARENT's `sessionId` while its request is in the CHILD's `events.jsonl` — reading
  the parent's file alone would find the parent's older, already-approved request and publish
  "answered" over an open child dialog. Candidates are the sessions this node's hooks named
  (children post their own ids), zero or several matches publish the hook unchanged, and every new
  prompt ends the previous watch (the replay found that exact race: the parent's spawn approval
  landed 90 ms before the child's prompt). The candidate set CAN miss the real request — a child's
  prompt may reach us before any of the child's own hooks, or a second request's line may not be
  on disk yet — and the older request found instead is then already answered. **The load-bearing
  rule is therefore: a request answered BEFORE the notification fired is never taken as its
  answer** (`resolvedTs < notifiedAt` ⇒ the hook is published unchanged, nothing watched): a
  notification cannot be about a dialog that closed before it. Every capture resolves after its
  notification (fastest 216 ms). Review of #1065 found that hole; tests A/B pin it. Closed sets throughout; an unknown decision, unreadable
  file or unparsable timestamp is today's behaviour, never a guess. Per-node ordering is kept (a
  confirm read holds that node's later hooks, ≤ 500 ms; polls run off that chain and discard a read
  that straddled a newer hook). A listener that throws costs that ONE event (as it did inside the
  hook server's try/catch before), never the node's delivery chain. A remote (SSH) grok node's file is on its host, so it reads "cannot
  tell" and behaves exactly as before — a remote leg is a follow-up. Unmeasured: `events.jsonl`'s
  shape on other grok versions (a changed shape degrades to today's behaviour).
- **Codex NEEDS YOU is checked against the session rollout under its auto-reviewer**
  (`core/agents/codex-permission-gate.ts`, issue #1171, in the hook server, so both shells get it).
  With `approvals_reviewer = "auto_review"` codex fires `PermissionRequest`, then its own reviewer
  subagent approves or refuses with nobody asked; no hook fires until the approved command's
  `PostToolUse`, so the node read NEEDS YOU for the review plus the whole command. MEASURED
  (2026-10-16, private CODEX_HOME + fake Responses model, codex 0.156.1 `exec` and 0.163.0 TUI;
  fixture `shared/agents/__fixtures__/codex/auto-review-permission.json`): the hook payload has NO
  reviewer field; the rollout's per-turn `turn_context` carries `approvals_reviewer` and a `turn_id`
  equal to the hook's, already on disk when the hook runs; `guardian_subagent` is recorded as
  `auto_review`; a failed review rejects to the agent, never to a person. Rules: a closed match (the
  `turn_context` for THIS `turn_id`, value in `CODEX_AUTO_REVIEWERS`) suppresses the event, so the
  node keeps PreToolUse's `working`; everything else — no `turn_id`, unknown value, a path outside
  the codex sessions roots (system `$CODEX_HOME/sessions`, managed `~/.nodeterm/cx/<16hex>/sessions`),
  unreadable file (O_NOFOLLOW), no match within the 16 MB backward scan, a read over 500 ms — is
  published unchanged as `waiting`. The hook reply never waits on the read; later events of the
  node wait behind it. A remote (SSH) codex node's rollout is on its host, so it behaves as before.
- **Grok chat view (⌘M + phone `chat.page`)** — `parseGrokChat` (`core/grok-chat.ts`) reads
  `chat_history.jsonl` into claude's `ChatMessage`/`ChatPart` shapes (no new wire field): typed
  prompts, assistant text, tool calls (`arg` = the salient argument — `command`, `target_file`, …, in
  claude's `toolArg` order — else the raw JSON, 200 units) with results summarised like claude's,
  `web_search` backend calls, harness-injected `synthetic_reason` lines as assistant-side `[reason]`
  notes, and `model_id`/`reasoning_effort` of the NEWEST assistant record (never carried forward).
  `reasoning` is hidden. It does NOT page: measured on 1.0.13, the file is rewritten via
  `.sync.tmp` + rename and `/compact`/`/rewind`/history repair replace lines, so it is one capped
  whole-file read with no keys and no `at`. Routing is by `capabilityAgentId`, so a custom agent built
  on grok reaches grok's reader, never claude's cwd fallback. **A remote (SSH) grok node is read on its
  host** (`core/remote-grok-chat.ts`, one `sh -c` round trip: `$GROK_HOME` if absolute else
  `$HOME/.grok`, the session found by id across `sessions/*/<id>/`, two matches refused, the
  paged-transcript window at 5 MiB) — its failures are terminal, never this machine's disk (the
  hook-derived local map names a wrong-machine path for these nodes). The phone gets it for free:
  `chat.page` reads through the same deps. Golden fixtures + exact rules for the Swift port:
  `src/shared/chat-fixtures/grok/`. Not supported: the composer's model/effort labels (grok's `/model`
  and `/effort` pickers are unmeasured — the TUI needed a login here), plan/question answer cards
  (claude-only), pre-compaction history, and a local session whose map entry `SessionEnd` retired.
- **Copilot ⌘M chat view** (`core/copilot-chat.ts`, 2026-09; copilot 1.0.88 measured in BYOK mode
  against a local fake model, plus the CLI's own `schemas/session-events.schema.json`). Reads
  `<COPILOT_HOME>/session-state/<id>/events.jsonl` (then the snap package's
  `~/snap/copilot-cli/common/.copilot`), located STRICTLY by the node's session id and routed by
  `capabilityAgentId` before anything claude-shaped, so a missing journal is "not found", never
  claude's cwd-newest or another session. The journal is append-only JSONL (compaction appends), so it
  PAGES like claude's — `parseChatWindow`/`parseGrowingWindow` take copilot's record parser — and the
  phone gets the same pages over the relay (`page()` gates only on `canChat`). Shown: typed prompts
  (`content`, never `transformedContent`; the sources copilot's own timeline hides stay hidden),
  assistant text, tool calls with results (`Error: …` on failure), a user's `!` shell command as the
  `!` part, `Error:`/`Warning:`/`Info:` notices, and `model`. Never shown: the system prompt,
  reasoning, sub-agent events (envelope `agentId` / `data.agentId` / `data.parentToolCallId`). Not
  supported: remote (SSH) nodes (`unreadable`, "not supported yet" — never this machine's disk),
  `effort` (not recorded), plan/question answer cards (claude-only), composer model labels (claude's
  picker commands only). Golden fixtures: `src/shared/chat-fixtures/copilot/` (README "Copilot").
- **Antigravity** (`agy` 1.2.3 measured on Windows; the 1.2.12 Linux binary read; builtin since
  2026-09 — Google's replacement for Gemini CLI on personal accounts) — in `AGENT_HOOK_TARGETS`
  (badge, NEEDS YOU from `ask_question`, a closed set of one, `--after` and triggers) and
  `RESUMABLE_AGENTS` (`agy --conversation=<id>`, the spelling agy's own exit hint uses; a dead id
  is ignored by agy, which starts fresh — without it a reboot left a bare shell). Launch is
  `agy --prompt-interactive '<p>'` via the new optional `AgentConfig.promptFlag` (agy has no
  positional prompt). Its hooks live in the GLOBAL `~/.gemini/config/hooks.json` under our own
  `nodeterm-status` bundle, and **each one is a synchronous gate whose stdout agy reads as a
  decision** — we subscribe `PreToolUse`, so a wrong byte denies tools in every `agy` on the
  machine, inside nodeterm and outside it. Three rules for whoever touches it:
  - **The stdout table is written ONCE** (`core/agents/hooks/antigravity-decision.ts`): `PreToolUse`
    → `{"decision":"ask"}`, `Stop` → `{"decision":""}`, the rest → `{}`, an unknown/empty event →
    NOTHING. Measured on 1.2.3: silence runs the tool, while `{}`, `{"decision":""}`, any non-JSON
    byte and exit ≠ 0 DENY it. Never `allow`, never `force_ask`, never `"continue"` on `Stop`. The
    script answers first and then sends stdout/stderr to `/dev/null`, because hook stdout is also
    model input (`injectSteps`).
  - **No quotes in the Windows command.** agy passes it to `cmd /c` with inner `"` escaped as `\"`,
    which cmd.exe does not understand — the codex form (`cmd.exe /d /c call "…"`) exits 1 = DENY.
    The command is relative to the hooks.json directory (agy's hook cwd) and guarded:
    `if exist ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd (call … <Event>) & exit 0`. Test
    Windows dispatch WITHOUT `windowsVerbatimArguments` — Node's default escaping is agy's.
  - **AutoRun blocks the install.** agy's `cmd /c` has no `/d`, so a registry `AutoRun` runs first
    and its output would deny tools; the installer reads the three `Command Processor\AutoRun`
    values (`reg query`, absence decided by listing the parent key — reg's errors are localized)
    and installs NOTHING — and withdraws a bundle an earlier launch wrote — if one is set or the
    registry cannot be read.
  **The vendor-location fallback also owns launch reachability.** Measured on Windows 11 with agy
  1.2.7: the vendor installer wrote `%LOCALAPPDATA%\agy\bin` into the user PATH as `REG_SZ`, so the
  process inherited the percent expression literally and both `where agy` and `cmd /c agy` failed
  while `%LOCALAPPDATA%\agy\bin\agy.exe` existed and ran. `PtyManager` therefore APPENDS the
  directory returned by `findAgy()` to the PATH of a LOCAL Antigravity session, and only when no
  entry already names it (`pathWithAgyDir`) — prepending shadowed the user's own tools on
  macOS/Linux, where agy sits in a shared directory. The gate uses
  `capabilityAgentId`, so an Antigravity-based custom agent inherits it; plain terminals and SSH
  sessions do not. Detecting the binary only for hook installation recreates the original split:
  a configured badge for an agent the pane cannot launch.
  **Installed only where `agy` exists** (a file lookup — PATH, then the vendor's install dirs —
  never a spawn), in two passes per launch: the boot pass may only see the inherited PATH, so a miss
  there does NOTHING; after the login-shell PATH probe settles, a final pass repeats the lookup and
  only then withdraws a bundle of ours when agy is not found. An `agy` installed later gets the
  hook the next time nodeterm opens. **The opt-out is agy's own switch**: `"enabled": false` on our
  bundle is carried across every rewrite. hooks.json goes through the shared settings transaction
  (`updateSettingsFile`: a symlinked file keeps its link and mode, writers serialize, a file changed
  mid-update is not overwritten), and only entries under `.nodeterm/agent-hooks/` are swept as
  ours. The POSIX command forces exit 0 (`sh <script> || :`) — the answer is printed first, and a
  later failure (a broken endpoint file) must not turn into a non-zero status next to it. **No SSH
  hook installer yet** (`LOCAL_ONLY_HOOK_AGENTS` / `hasHooksOverSsh`): on an SSH project an agy node
  never reports, so `--after` refuses it as a dependency. The event name is not in agy's payloads:
  the command exports `NODETERM_AGY_EVENT`, the script POSTs `nodeterm_hook_event`, and the hook
  server merges it after `JSON.parse` — for antigravity ONLY, an empty field deleting a planted
  value. `newTurn` rides only the
  `PreInvocation` with `invocationNum === 0` (without it `lastTurnError` is never retired). Cost:
  on POSIX the POST already runs in the background and the part agy waits for measured 2–40 ms
  (pinned by a stalled-endpoint test, since a foreground POST plus the failover walk measured ~6 s
  against the 5 s handler timeout); the ~520 ms per event measured on Windows is Git Bash's fork
  cost before the backgrounding. Full picture,
  limits (permission prompt and ESC fire no hook) and the device checklist:
  **`docs/antigravity-agent.md`**.
  **No conversation view, and that is deliberate** (not in `CHAT_CAPABLE`): ⌘M shows the rendered
  terminal output, and the phone's Chat screen answers `unsupported`. The
  LOCATION is measured: every hook payload names `transcriptPath`, which is
  `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`,
  keyed by the id `normalizeAntigravity` already records as `sessionId`. The RECORD SHAPES were never
  captured; the 1.2.12 binary only describes them in prose. Four facts a parser needs are unknown:
  the `tool_calls` element keys, how a tool result links back to its call, the serialized enum
  spelling, and whether a line is rewritten when its step's status changes, which decides between
  claude's paged read and grok's single capped read. A parser built from that prose would be a rule-14
  wrong guess, so none ships, not even unwired. The capture recipe is §7.1 and §8.1 of the doc, using
  `scripts/agy-transcript-shape.mjs`, which dumps shapes and never text. When it lands: locate
  strictly by id (`brain/` holds every conversation on the machine), and have a remote node answer
  `remoteOnly` → unreadable like gemini.
- **Codex in the ⌘M chat view** (2026-09-28; the desktop panel, the kanban card modal, the phone's
  `chat.page`). `core/codex-chat.ts` reads the rollout with codex's own rules, never claude's
  resolver. It takes USER text from the UI stream only: `event_msg/user_message` (legacy, ≤ 0.146) or
  an `item_completed` `UserMessage` (paginated, ≥ 0.151). Model-side `role:user` messages also carry
  injected context (AGENTS.md, `<environment_context>`, image wrappers), so they are never read.
  Assistant text and tools come from `response_item`, correlated by `call_id`. The UI copies
  (`agent_message`, `AgentMessage`) and reasoning are skipped. Failed and interrupted turns become
  `[error] …` / `[turn aborted…]` notes. A tool result drops codex's `… Output:` preamble. The rollout
  is append-only, so it pages by byte offset like claude. The locator matches a WHOLE-uuid thread id
  (`CODEX_THREAD_ID_RE`), because a uuid's last group passes `SESSION_ID_RE` and suffix-matches
  another thread's file. It searches only the node's own account home, and uses the codex tail's hook
  path only as a checked hint. An SSH node is read on its host (`main/remote-codex-chat-page.ts`,
  through the same resolvers as its remote meter) or not at all. Because codex announces no session
  end, a chat send first asks the kernel (`renderer/lib/chatPaneGate.ts`, `isAgentPane`). After a
  `/quit` the store still reads `done`, and the message would otherwise run in the shell. **Not
  supported:** images in prompts, reasoning summaries, the composer's model/effort labels (the
  `/model` picker is measured for claude only), plan/question answer cards (codex never sets
  `held`), and a closed REMOTE session's transcript. Record rules and fixtures:
  `src/shared/chat-fixtures/codex/`.
- **opencode in the ⌘M chat view** (2026-09-28, opencode 1.18.25 measured) — opencode has NO
  transcript file (SQLite since 1.18; that database also holds its account tokens and is never
  opened), so `readChatTranscript` routes `capabilityAgentId(agentId) === 'opencode'` to
  `core/opencode-chat.ts`, which runs `opencode export <sessionId>` (argv only, no flag an older
  yargs-strict CLI might refuse) and parses the one JSON document into claude's `ChatMessage` shape:
  user/assistant text, tool chips (arg by an opencode key order, result = 3 lines / 500 units,
  `Error: …` on a failed call), `[name] message` for an errored turn, compaction/subtask chips,
  `at` from `time.created`, `model`/`effort` from the newest assistant's `modelID`/`variant`.
  Reasoning, `synthetic`/`ignored` text, file/agent parts and step bookkeeping are dropped;
  unmappable shapes are skipped and counted. **One page, always** (`olderCursor: null`): there are
  no byte offsets to page by. The page honours the caller's `maxBytes` (the phone asks 256 KB),
  grows ×4 up to 5 MB like claude's reader when it holds no whole message, and shows a newest
  message larger than 5 MB TRUNCATED (with a note) rather than as an empty conversation. Refusals: no/unsafe session id runs
  nothing (a bare `opencode export` opens a picker over the NEWEST sessions — someone else's); an
  export whose `info.id` is another session is `unreadable`; only `Session not found: <id>` with
  exit 1 and empty stdout is a clean miss. **Remote (SSH) nodes are refused** (`unreadable`, no
  export runs) — their sessions are in the host's database and there is no remote leg yet; the
  panel's copy names both causes an opencode `unreadable` can have. One export costs 1.0–1.7 s and
  ~320 MB, so `createOpencodeExportGate` runs at most one per session (a caller arriving mid-run
  gets a FRESH export) and two in total; the panel's hook-driven refreshes are marked
  `page.background` and spaced ≥ 5 s per session, while an open / ↻ / Retry is immediate (and wakes
  a sleeping background one). A **change gate** in front of it `stat`s (never opens) opencode's
  `opencode*.db` + `-wal` in `$XDG_DATA_HOME/opencode` (else `~/.local/share/opencode`, opencode's
  own xdg-basedir rule) BEFORE exporting, and an unchanged fingerprint answers from a 4-session LRU
  of parsed exports; no db file found, or `OPENCODE_DB` set, means no caching. The export runs with
  `cwd: os.tmpdir()` (from a repo cwd opencode writes `<repo>/.git/opencode`; sessions resolve by
  global id). **It inherits the APP's `process.env`, not the node's shell env**: a user who
  relocates opencode's data via `XDG_DATA_HOME` / `OPENCODE_*` only in their shell rc gets
  "Session not found" — an honest miss, not a bug in the reader. Plan/question answer
  cards stay claude-only (no `body`/`questions` on opencode's `question` tool). Desktop and Server
  Edition both serve it (core handler); the phone gets it over the relay `chat.page` for free.
  Fixtures + the exact rules for the iOS port: `src/shared/chat-fixtures/opencode/README.md`.
- **Gemini + codex parity** (2026-08-09) — brought both up to grok's level in the lists above. Unlike
  grok, **both CLIs are installed** and gemini **ships its own hook reference**
  (`/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md`), so almost every fact is
  measured. The load-bearing ones:
  - **Gemini's envelope IS claude-shaped** — `session_id`/`transcript_path`/`cwd`/`hook_event_name`
    (`reference.md:46-58`), the exact opposite of grok's missing `transcript_path`, so the shells just
    jail the path they are handed. The **event names** are gemini's own: eleven exist, `GEMINI_HOOK_EVENTS`
    subscribes **seven**. `AfterModel` is excluded because it fires **per streamed chunk**
    (`reference.md:236`) = one hook process per chunk; `BeforeModel` is **not** per-chunk (it fires once
    per request) and is excluded only because it reports nothing we render.
  - **`Notification` → `blocked`, matched as a CLOSED set** (`notification_type === 'ToolPermission'`).
    Before this, a gemini node sat on RUNNING while it waited for a permission answer. The closed match
    is measured, not cautious: gemini's `NotificationType` enum has exactly ONE member, and it fires
    only after `shouldConfirmExecute` returns details — i.e. only for a real dialog, so an
    auto-approved/`yolo` call fires nothing. **Grok's `includes('permission')` strobed on every tool
    call**; widening this "to be safe" is the unsafe direction.
  - **Context meter from each agent's own transcript** — one tail per agent, each with its own `parse`
    dep on `createContextTail` (`core/gemini-session.ts`, `core/codex-session.ts`), in **both** shells.
    Gemini: `tokens.input` and a window from `geminiWindowFor`, which mirrors the CLI's own
    `tokenLimit()` — a **family rule with a 1M catch-all default**, so an unknown model gets the right
    answer instead of a confident wrong denominator. Codex: `last_token_usage.input_tokens` and its own
    stated `model_context_window`. Two traps: `total_token_usage` is **CUMULATIVE** (would render a
    13%-full session at 79%), and `cached` is **INSIDE** `input` for both — while claude's input
    *excludes* cache reads, which is why claude sums them. **The formulas must not be unified.**
    The transcript jail is widened **per root** (`~/.gemini/tmp`, `<codexHome>/sessions`), never to
    `$HOME` — that predicate exists so a forged hook POST cannot aim a read at `~/.ssh/id_rsa`.
  - **`hasUsage` gated THREE features, not one.** Joining `USAGE_CAPABLE` also switched on
    `context.ensure` and the find bar's transcript index, both of which go through claude's
    `resolveTranscript` — whose **cwd fallback** then handed a codex node *the newest claude transcript
    for that cwd*: a stranger's session as its meter and its search hits. Gated by the pure
    `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`) rather than by a fourth list.
    `context.ensure` LEFT that gate in 2026-09 (issue #813) once its handler stopped *being* claude's
    resolver — see **Context-meter rehydration** below; the find bar's index still has no routing and
    so has not moved. The lasting rule is the one the episode taught: **grep every consumer of a
    helper before adding an id to its list**, and when two consumers need different answers, route
    the one that can be routed instead of widening the gate for both.
  - **`TITLE_READ_CAPABLE` was created here**: gemini names its own sessions through its `update_topic`
    tool (the title is in that call's `args.title`, NOT a top-level field) but has no rename command, so
    the read and write legs split. Its read path is the transcript the context tail already tracks
    (injected as `AgentSessionNameDeps.geminiPathFor`, held in a `let` in `src/main/index.ts` to avoid a
    TDZ throw that would kill a node's whole poll chain).
  - **In-place restart** works for gemini: `EXIT_SEQUENCES.gemini = '/quit'` — and it must stay **bare**,
    because `/quit --delete` exits *and permanently deletes* the session history, i.e. exactly what the
    restart exists to resume (pinned by its own test).
  Full picture, measurements, gaps and a device checklist: **`docs/gemini-agent.md`**.
- **Gemini CLI refuses personal Google accounts since 2026-06-18** (free / AI Pro / AI Ultra moved to
  Antigravity CLI — the `antigravity` agent above; Code Assist Standard/Enterprise, Vertex AI and paid
  API keys still work, so `gemini` stays a builtin). The refusal happens before any session, so no
  hook reports it: a gemini-harness node reads its own pane for the CLI's sentence
  (`renderer/terminal/gemini-retired.ts`, letters-and-digits match because the TUI wraps it in a
  box) and raises a slim banner — "Open Antigravity" (`nodeterm:open-agent`, an agy node beside it,
  in its frame) + Google's migration guide. It types and relaunches NOTHING, which is why a phrase
  match is enough here where `resume-fallback.ts` needs three refusals. `AgentConfig.notice` carries
  the one-line caveat to the menus/Dock tooltips; it is never read to decide behaviour.
- **Gemini ⌘M chat view** (2026-09, `core/gemini-chat.ts`) — gemini is in `CHAT_CAPABLE` with its own
  reader, routed in `readChatTranscript` via `capabilityAgentId` BEFORE anything claude-shaped and
  located only by the header session id (`locateGemini`, which now reads just the header and honours
  `GEMINI_CLI_HOME`). Its session file is an UPSERT log, not a message list: one id is rewritten in
  full as tool results/tokens land, `$rewindTo` truncates, and `$set.messages` replaces the MODEL's
  context at start, compression and rollback. The thread is the message records upserted by id with
  rewinds honoured and **`$set.messages` ignored** — honouring it erases the thread at every
  compression and shows the `<state_snapshot>` as the human's words. Not paged (a record depends on
  earlier ones): one read under the 5 MB cap, `olderCursor: null`, like grok. Shows typed prompts
  (`displayContent` over `@file` expansion; `<session_context>`/`<hook_context>` dropped per part),
  replies, tool calls with results, `[info]`/`[warning]`/`[error]` notes and (paged) the model;
  thinking is dropped. NOT supported: remote (SSH) nodes (`CHAT_LOCAL_ONLY` → "not supported yet"),
  plan/question answer cards, the composer's model/effort labels. The phone gets it over the relay
  unchanged; fixtures and exact rules: `src/shared/chat-fixtures/gemini/`, `docs/gemini-agent.md` §3.
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
  retain the cursor, and back off from 2s to 60s with payload-free diagnostics — logged when a
  streak starts, when it settles at 60 s and when it recovers, never per retry, and naming only the
  observed status (`exit 255`, `malformed reply`), never a guessed cause: the runner reports a
  timeout as status 1. **A transcript that does not exist is not a failure.** Claude creates it on
  the first prompt while SessionStart already hands over the path (measured on 2.1.283), so every
  unused remote Claude node used to walk the failure backoff and log a line a minute. The command
  answers `NODETERM_ABSENT` with status 0 and the tail polls it on the idle cadence; a file that
  appears after being seen missing is live from byte 0 when its bootstrap window covers all of it.
  A SEPARATE idle backoff (`idleDelayMs`) stretches the 1 s poll after three consecutive empty successful reads
  (2/4/8 s, capped at 10 s) and is reset by any data-bearing read and by every same-ref `track()`
  — i.e. every hook POST for the session, which is what keeps a `<task-notification>` (it rides
  a UserPromptSubmit hook) at ~1 s latency; never merge it with the failure backoff. That same
  `track()` also skips the rest of a pending failure wait (the host just reached us) but keeps the
  failure streak, so a read that fails again goes straight back to 60 s. Bootstrap and
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
- **Permission mode** (agents in `PERMISSION_MODE_CAPABLE` — claude, grok, **gemini**, **codex**) —
  the mode a session **starts** in (`claude --permission-mode <mode>`; Shift+Tab still cycles it at
  runtime). Membership no longer implies claude's flag spelling: **the per-agent translation lives in
  `src/shared/agents/approval-mode.ts`** (`approvalFlags` / `modeSupported`), which is also where
  `withPermissionMode` now lives — it moved one layer up out of `config.ts` to break a cycle.
  gemini = `--approval-mode default|auto_edit|yolo|plan`, codex = `--ask-for-approval
  on-request|never` (and `untrusted` too, but only on a codex that still has it — see the next
  paragraph). Two rules the mapping exists to enforce: a mode the CLI **cannot
  express emits NO flag**, never a substituted nearest match (codex has no `plan` and no
  edit-specific mode; **gemini has no `auto`** — nothing in its vocabulary means "approve most things
  but not edits", and since `auto` is the DEFAULT mode, mapping it to `auto_edit` would have switched
  auto-approve-edits on for every existing gemini node at upgrade time, silently), and "supports"
  must not be a lie either — codex's `manual` maps to
  `untrusted` because its built-in default is `OnRequest` (measured: `codex doctor`, no `approval`
  key in `~/.codex/config.toml`), so leaving it unflagged would deliver "the model decides when to
  ask" under an "Ask each time" label. **codex is the first agent where `manual` emits a flag.** The
  UI copy is DERIVED from the mapping (`permissionModeAgentIds` / `permissionModeAgentsLabel` /
  `unsupportedModesNote` / `bypassSandboxCaveat`) so a sentence cannot drift from what the table
  does — so the note now reads "Auto has no Gemini equivalent…" beside codex's gaps, and the
  residual wart is only that `auto` and `manual` land on the same gemini policy (the *prompting* one).
  `--sandbox` is a separate axis and deliberately untouched (`--ask-for-approval never`
  still sandboxes).
  **AN AGENT'S VOCABULARY IS NOT A CONSTANT — codex's moved, and the table is gated on a probe of
  the binary in front of us (#785).** Measured release by release on the published linux-x64
  binaries: 0.146.0 / 0.147.0 / 0.148.0 advertise `untrusted, on-request, never`; **0.149.0**
  through 0.154.0 advertise `on-request, never`. clap does not ignore a value it does not know, it
  prints `error: invalid value 'untrusted'` and **exits**, so a Manual-mode Codex node launched from
  the pinned table died at the prompt and left the pane at a bare shell. The gate is codex's OWN and
  sits beside claude's, never inside it (a gate fed by `claude --version` belongs to claude):
  **`core/codex-cli.ts`** reads `codex --help` once per app run — FEATURE-detected, not
  version-compared, because a floor guesses about builds that are not on npm — parses the option's
  own slice with `codexApprovalValuesFrom` (the neighbouring `-s, --sandbox` carries its own
  `[possible values: …]` two lines up, and a page-wide scan emits `--ask-for-approval read-only`),
  and publishes `CodexCliCaps` over `codex.cliCaps()`, registered by **both** shells. Every emitter
  threads it as `ApprovalCaps` — `approvalFlags` / `modeSupported` / `withPermissionMode` /
  `unsupportedModesNote` all take an optional trailing `caps`, and the **omitted** form resolves to
  the BASELINE `['on-request','never']`, the two values every measured codex accepts. That default
  is the design: a call site that forgets to thread its probe result loses a mode, never a launch.
  On 0.149.0+ `modeSupported('codex','manual')` is **false** and the derived note says so —
  measured before concluding it: `-a unless-trusted` is refused, `-c approval_policy=untrusted`
  fails config load, and `--approve-for-me` routes approvals through *automatic* review. **Remote is
  unknown, never guessed**: an SSH node runs the HOST's codex and there is no remote codex probe yet
  (claude has one, at connect), so `codexApprovalCaps(ssh)` and the mirror's SSH slice publish
  nothing and fall to the baseline. Same for a relay tab (the guest's machine) — its stub answers
  unknown on purpose. Three surfaces: **Desktop** and **Server Edition** both probe their own
  machine (the server's `registerCodexCliIpc` is REAL, unlike its deliberately-false
  `registerCodexIdentityIpc`); **Mobile** gets the vocabulary as `MirrorSettings.codexApprovalValues`
  — the desktop/server now publish it, the iOS reader is the follow-up. The app-server **usage
  tier** (`usage/codex-usage.ts`) carried the same dead `-a untrusted` and silently returned null on
  every current CLI; it is now `-a never` with **no probe**, because `never` is in both vocabularies
  (measured against 0.148.0 / 0.151.0 / 0.154.0) and `-s read-only` is what actually guards the
  user's files.
  `settings.claudePermissionMode` (global, default **`auto`** — a behavior change for existing
  users, who previously got a prompt per action) is overridden per project by
  `project.defaultPermissionMode` (persisted to `.nodeterm/project.json`, so a `bypassPermissions`
  override travels to everyone who clones the repo — the tab menu warns). Modes are
  `manual | auto | acceptEdits | plan | bypassPermissions`, labelled once in
  `PERMISSION_MODE_LABELS` (from which `ALL_PERMISSION_MODES` is derived — the dropdown and the
  validator can't desync). `resolvePermissionMode(project, settings)` is the resolver
  (`renderer/state/permissionMode.ts` `activePermissionMode(agentId)` binds it to the live stores **and
  applies the version gate below — for `agentId === 'claude'` only**), and
  **`withPermissionMode(cmd, agentId, mode)` is the single
  funnel through which every agent-node launch site appends the flag** (new node, cold-restore
  resume, Branch, handoff/transfer, explain-commit, add-agent, canvas-control open-agent + team
  spawn). **WHERE the flag lands is decided at the composed layer** (`createAgentNode`), not in
  `withPermissionMode`: with no `argvPromptSeparator` (claude) it goes LAST, keeping the historical
  command byte-identical; with one (grok's `--`) it must go **BEFORE** the separator, because `--` is
  end-of-options and a flag after it is a positional — silently swallowed into the prompt or a clap
  usage error. Assert that at `createAgentNode`; a `withPermissionMode` test passes while the composed
  line is wrong. (gemini and codex declare no separator, so their flag goes last and their command
  lines stay byte-identical; grok is still the only agent taking the other branch.)
  UI: Settings → Agents, and the tab ⌄ menu for the per-project override.
  **Version gate (`auto` only) — CLAUDE's alone:** `--permission-mode auto` exists only in **Claude Code ≥ 2.1.71**;
  older CLIs validate the value against their own choices list and **exit 1** — and `auto` is the
  default, so an ungated flag would kill every Claude launch on an older CLI. So the CLI is probed
  (`core/claude-cli.ts` → `claude --version`, memoized, registered on `CorePlatform` so **both**
  shells serve it; reached from the renderer via `window.nodeTerminal.claude.cliCaps()`, with a
  **real** ws-bridge implementation) and `gatePermissionMode(mode, autoSupported)` degrades **only
  `auto`**, and only to `manual` = **no flag** = the bare pre-feature command. Everything **fails
  open**: unknown/unreadable version, a probe that failed or hasn't answered yet ⇒ bare command,
  never a blocked launch; the other four modes are never touched by the gate, and the user's
  *setting* stays `auto` (only the emitted command line changes). **SSH projects** are gated on the
  **remote** host's CLI, never the local one: `SshProjectManager.connect` probes `claude --version`
  on the host (through a login shell — an ssh exec channel's rc file usually bails out early — with
  `$HOME/.local/bin` + `$HOME/.claude/local` prepended to PATH: the official installer targets
  `~/.local/bin`, which a stock root `.profile` never adds, so a host whose interactive shells run
  claude fine still probed "not found" and silently degraded `auto` to manual) and
  caches the answer on the connection → `useSshConn`; not connected / not yet probed ⇒ no `auto`
  flag. A FAILED remote probe (claude not found — often a transient login-shell hiccup) **retries
  on a bounded backoff** (`PROBE_RETRY_DELAYS_MS`; every attempt pushes its answer immediately so
  launch waiters never block on the retry tail; a definite version — old or new — never retries),
  and the status event carries `remoteClaudeVersion` (`null` = probe failed) beside the boolean.
  The cold-restore relaunch `await`s the (shell-warmed) local probe because it fires on mount —
  and on an SSH project whose resolved mode is `auto` it also waits (`SSH_AUTO_PROBE_WAIT_MS`,
  bounded, fail-open) for the REMOTE probe's first answer, which races the same mount. Because
  the degrade is silent by design, the tab menu's Auto rows surface it: `sshAutoModeHint`
  (tri-state `useSshConn.autoPermAnswer` + probed version) puts a ⚠︎ + tooltip on "Auto" / "Use
  global (Auto)" for an SSH project whose remote CLI is too old / missing / not yet probed.
  **Security:** mode values come from hand-editable, git-shared JSON and end up interpolated into
  a shell command line (tmux `send-keys`), so `permissionModeFlag` **re-validates** the mode at the
  interpolation site (the type is compile-time only) — an unrecognized mode yields **no flag**, i.e.
  the bare, safe command. `'manual'` likewise yields no flag, reproducing the pre-feature command
  bit-for-bit. The setting and the per-project override apply to **terminal (CLI) agent nodes only**
  (the SDK **chat node**, which never honored it, was removed 2026-07). **No other agent inherits this
  gate:** grok has accepted every mode since 1.0.0 and gemini/codex accept theirs on the versions we
  measured, so gating any of them on a `claude --version` probe would
  downgrade their sessions on a machine whose claude is old or absent — `activePermissionMode` gates
  only `'claude'`, `ensureActivePermissionMode` awaits the probes only for `'claude'`, and
  `sshAutoModeHint`'s copy names Claude in every sentence for the same reason. An agent needing its
  own gate adds one beside claude's.
- **State via each agent's hooks → shared 4-state model** — detection uses the agent's own
  hooks, **not** output parsing. `src/shared/agents/normalize.ts` has per-agent normalizers
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`/`normalizeAntigravity`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status` and hands it to `applyAgentEvent`, the pure reducer
  that does every store write (state, session id, account, loop, subagent cards) and reports which
  alert the event raised; the listener keeps what is a fact about THIS window — the unread mark and
  its ack, the sound, the throttled (5s/node) background notifications, the handoff fold. A relay
  session feeds the same reducer into its own keyless store (`wireRelayAgentStatus`), with no ack,
  sound, notification or subagent cards. Header shows a pulsing
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
  (see **Cold restore** above). Re-measured on the same host 2026-09-09: **20** of 108.
- **An interrupted Claude turn (Esc / Ctrl+C) fires NO hook — the transcript marker ends it**
  (`core/claude-turn-interrupt.test.ts`, fixture `shared/agents/__fixtures__/claude/interrupt-capture.json`).
  MEASURED on Claude Code **2.1.285**, interactive TUI in a private tmux server, capture hooks via
  `--settings`, every `NODETERM_*` unset: Esc while it streams, Esc during a foreground tool call,
  Esc on a permission dialog, and Ctrl+C once mid-stream each fire **nothing** — no `Stop`, no
  `StopFailure`, no `PostToolUse(Failure)`, and **no `idle_prompt` either**: that notification came
  60 s after a NORMAL `Stop` but not in 75 s / 80 s after an interrupt, so the `idle` rescue in
  `normalizeClaude` does not cover this case. Before this a node sat on RUNNING (or NEEDS YOU, for a
  dismissed permission dialog) until the 20-min stale sweep: `--after` dependents waited, Eco never
  saw it idle, the notch and the phone showed it working. What the interrupt DOES leave is a USER
  record, content `[{type:'text', text:'[Request interrupted by user]'}]` (`… for tool use]` when a
  tool call or its dialog was cancelled), whose **`promptId` equals the turn's `UserPromptSubmit`
  `prompt_id`** in every capture. Wiring, and the rules it rests on:
  - `normalizeClaude` puts `prompt_id` on the `UserPromptSubmit` event as **`turnId`**; the mirror
    keeps it (`MirrorEntry.turnId`, runtime-only, dropped at a session boundary).
  - The claude context tails (local, and the desktop's SSH one) scan COMPLETE lines with ONE
    stateful scanner per tracked transcript (`createTurnInterruptScanner`): a CLOSED set of the two
    texts, array content with exactly that one text part, non-sidechain (a typed prompt is a plain
    string, so typing the words matches nothing) — **and a marker counts for turn P only if P's
    OPENING prompt record was read BEFORE it** (bounded set of seen prompt ids, 256). The id alone
    is NOT enough, and this is not theoretical: in real transcripts on the dev host (2.1.209–2.1.283)
    34 of 114 accepted-shape markers carried the promptId of the prompt written AFTER them — "queue a
    message while Claude works, then Esc": the CLI tags the marker with the QUEUED prompt's id and
    writes that prompt ~36 ms later, and its `UserPromptSubmit` has already made it the node's
    current turn, so an id-only match ended the NEW live turn (fixture
    `__fixtures__/claude/interrupt-queued.json`). Measured on this host after the fix: all 26
    queued-shape markers rejected, no real interrupt lost. The one interrupt this drops is the one
    it cannot place; the interrupted turn really ended and the node is already in the next one. The
    remote tail's historical first read records prompts but never reports.
  - **Both shells** check the marker with `turnInterruptEvent` (a mirror PEEK) and push the result
    through their ONE hook-event path — desktop `emitAgentStatus` (mirror, broadcast, Notch HUD,
    agent messaging, station notices), Server Edition `emit` (mirror, broadcast, `opts.onEvent`:
    its delivery queue and `--after` scheduler). Pinned in `hook-verified-parity.test.ts`. It ends
    the turn ONLY when the marker names the node's CURRENT turn (same session, same `turnId`, state
    working/blocked/waiting): a marker read back from history, one from a finished turn or another
    session, one after a restart (no `turnId` then) changes nothing. A prompt event whose
    `prompt_id` is missing or not a plain token carries `turnId: ''`, which makes the mirror FORGET
    the previous id. The event is an ordinary `done` + `interrupted` (what a `Stop` with
    `is_interrupt` already produced), UNverified (a transcript read is not a hook POST), so no
    completion alert and the question/approval resets apply unchanged.
  - **`--after` does NOT release on an interrupted turn** (decision, 2026-09-30): the person
    stopped it, usually to redirect it, and the dependent would start on unfinished work — #521's
    reasoning for an errored turn. It is its OWN annotation, `agentStatus.lastTurnInterrupted`
    (transient; set by an interrupted `done`, cleared by a new turn or a `done` that is not
    interrupted), read by `depSatisfied`, the QUEUED tooltip (`interruptedDeps`), `list`
    (`LAST TURN INTERRUPTED`; an error outranks it), the canvas's `armedDepSig` (a verdict can clear
    under a steady `done` — a guessed interrupt then the real Stop — and the launch effect must
    re-run) and team progress (its own `interrupted` kind, NOT counted as done, so the ring never
    says "finished" beside a held dependent). It is deliberately NOT `lastTurnError`: the TURN
    FAILED chip, the station-failure notice and issue runs do not treat an interrupt as a failure.
    **The `idle_prompt` rescue does NOT set it** (`recordsTurnInterrupt`): it is flagged
    `interrupted` only to stay silent, and since `idle_prompt` follows a NORMAL Stop, a rescue means
    a lost Stop POST on a turn that finished — its dependents release as before. ▶ / `run` still
    start the dependent. The renderer's older keystroke
    guess (`inferInterruptAfterSettle`, 1.5 s after a lone Esc/Ctrl-C typed into THAT terminal)
    now records an interrupted `done` too, so a guess cannot release dependents before the marker
    lands; it stays because it is the only signal for the next case.
  - **Residual, measured:** Esc or Ctrl+C BEFORE the first token rewinds the prompt into the input
    box and writes NO marker (the transcript ends at the prompt record). Only the renderer guess
    (keystroke in that canvas terminal) sees it; the mirror — notch, phone, Eco's mirror reads, the
    Server Edition's headless `--after` — keeps `working` until the next hook or the stale sweep.
  - **Esc "during a subagent":** on 2.1.285 the Agent tool launched ASYNC even when asked for a
    foreground run, so the parent turn had already ended (`Stop`) — Esc at the prompt then fires
    nothing and does NOT stop the child, whose `SubagentStop` and `<task-notification>` arrive as
    usual. Nothing to fix there; a truly synchronous child being interrupted was not reproducible.
  - Server Edition: same core path (its tail + handler); its own headless `--after` still ignores
    both #521 and this annotation (pre-existing gap). Mobile: gets the `done` through the mirror.
  - **Device checklist:** (a) macOS desktop: Esc mid-stream / mid-tool / on a dialog → RUNNING
    clears within ~1 s, no chime, an armed `--after` dependent stays QUEUED with the interrupted
    tooltip; (b) SSH node: the same over the remote tail; (c) Server Edition browser tab; (d) a
    Claude older than 2.1.285 — whether the marker text and `promptId` match there is unmeasured
    (a changed text or a missing `promptId` matches nothing and degrades to the old behaviour); (e)
    queue a message while a turn runs, then Esc: the node must STAY working on the queued prompt;
    (f) the phone's Live
    Activity ends on the interrupt.
- **Hook server (loopback HTTP)** — `src/core/agents/hook-server.ts` is a main-process
  loopback HTTP server (per-session bearer token, fail-open) that the installed hook scripts
  POST to; it replaced the old `fs.watch` signal-log mechanism. `buildPtyEnv` injects the
  node id + endpoint/token into each spawned session's env; because tmux sessions **outlive
  the app**, the server also writes `<userData>/hook-endpoint.env` so a relaunched main
  process re-advertises the same endpoint (restart handoff). A `setRawListener` channel feeds
  the per-node context-window meter (`context-tail.ts` — **one tail per agent**, each with its own
  `parse` dep: claude's usage records, `codexContextParse`, `geminiContextParse`) and the subagent
  live-transcript (`subagent-tail.ts` — claude via meta-dir `track`, codex via `trackFile` with the
  stateful `codex-subagent-format.ts` formatter). The same events feed the **agent-status mirror**
  (`core/agent-status-mirror.ts`) the mobile companion reads; the mirror carries an optional
  `settings` block (`claudePermissionMode`/`autoSupported`/`claudeAccounts`) so the phone can
  launch agents with the desktop's permission mode + managed accounts, and SSH slices get their
  **per-host** settings (remote CLI caps + host-matched accounts) injected via
  `remote-status-push`'s `settingsFor` dep. **`settings.claudeSessionIdFlag`** (present only as
  `true`) is how a phone-started node gets the persisted conversation id every canvas-minted node
  has: the phone launches `claude --session-id <uuid>` only when the HOST's own `claude --help`
  advertised the flag (an unknown option makes claude exit), then hands that id over with the node
  it registers — `RemoteNodeInput.agentSessionId` on `projects.registerNode`, the same key in the
  node it writes over direct SSH — and `appendProjectNode` persists it as `data.agentSessionId`.
  Before this a phone node had ONE route to its session (a hook event reaching this desktop), so
  whenever none had arrived its ⌘M fell back to the markdown view, its title never adopted the
  session name and a cold restore relaunched blank. Three writers publish the block and each must
  answer with the probe for the machine its file describes — local claude caps in both shells, the
  host's own probe (`core/remote-ssh/claude-session-id-probe.ts`) for an SSH slice; all three go
  through `mirrorClaudeSessionIdFlag` and are pinned in `mirror-session-id-flag.test.ts`.
  `settings.customAgents` (`[{id, label, baseAgent?,
  binaries}]`) lets the phone chat with a custom agent: built ONLY by `core/mirror-custom-agents.ts`
  (one definition for all three providers — local file, which relay `projects.list` also serves,
  SSH slices, Server Edition), `binaries` = `binariesFor` from the pane-owner predicate, published
  only when every name fits the plain alphabet `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (else `[]`) —
  the builder enforces it because the tokenizer can "name" a slice of a secret (`oauth2:ghp_…` out
  of a git URL, a quoted env value, a `${env:…}` template). **Never put a custom agent's raw
  `launchCmd`/`args`/`env` in the mirror** — they carry API keys and the file lands on every SSH
  host. `binariesFor` resolves a BLANK launch command with a *builtin* `baseAgent` to the base's
  binaries (what `resolveAgentConfig` actually launches).
- **Agent-integration consent (#744)** — `core/agent-integrations.ts` (booted by BOTH shells) is the
  ONE writer of user-owned agent config; consent is `settings.agentIntegrations`
  (`@shared/agent-integrations`, sanitized on every read). Per agent: **enabled** = hook + both skills
  in the agent's own skills dir + strip older builds' AGENTS.md/GEMINI.md blocks (they were 17 KB of
  codex's 32 KiB `project_doc_max_bytes`); **declined** = remove exactly what we wrote (hooks by exact
  command, skills by exact-content receipt in `<userData>/integration-receipts.json` — a user-edited
  file is KEPT and listed in Settings, bounded at 20 — legacy blocks, our hook scripts);
  **undecided** = nothing either way. Server `installHooks: false` is a hard veto. Rules a refactor
  must not undo:
  - **Grandfathering is decided at boot from OUR files only** (a non-empty `~/.nodeterm/agent-hooks/`),
    before `settingsStore.registerIpc()` and before any install: an existing install gets every
    agent + `hostDefault` enabled and a one-time notice; a new install gets NO record and a banner
    (Enable all / Choose… / Not now — "Not now" declines all, so it asks once). **Evidence must be a
    file only a pre-consent build wrote** — the userData canvas/context shims are written on EVERY
    boot, consent or not, and counting them grandfathered every fresh install on its second boot
    (issue #1149: a systemd restart, the update timer, a desktop quit before the banner was
    answered — 11 hook entries in `~/.claude/settings.json`, Codex `trusted_hash` pre-approvals).
    And the decision is made ONCE: the first boot that finds no evidence writes
    `<userData>/integration-consent-fresh-install` (`FRESH_INSTALL_MARKER`), after which no boot of
    that install grandfathers — so a sibling install sharing `~/.nodeterm` (desktop + Server Edition)
    enabling ITS hooks cannot grandfather this one either. A marker FILE, not a settings key:
    `SettingsStore.init` reads an unreadable settings.json as the defaults, and a boot-time save of
    a "not answered yet" record would overwrite the user's file. Same function, same call, both
    shells.
  - **No caller reaches an installer by omission.** `installManagedAgentHooks(agents)` takes a
    REQUIRED set; `RemoteHooks` takes a REQUIRED plan (`NO_REMOTE_INTEGRATION` = fail-closed);
    account add/link asks `currentIntegrationLifecycle()` and writes nothing when none is registered.
    `agent-integrations-wiring.test.ts` pins every call site of the global installers.
  - **SSH consent is per HOST (`sshHostKey`, never identity file / port / args).** A host installs an
    agent only when the host AND the agent are enabled; an unanswered host is not touched at all
    (no clean-up, no ssh); removals run on connect and when the plan changes
    (`SshProjectManager.onIntegrationConsentChanged`). A removal never creates a missing config
    file (`stripRemoteSettingsFile`).
  - **`$CLAUDE_CONFIG_DIR` decides the system Claude dir** (`claudeSystemConfigDir`), never a
    hardcoded `~/.claude`; a decline also cleans the legacy `~/.claude` when they differ.
  - The fullscreen-TUI write is part of the claude integration and follows its consent.
  Measurements, the device checklist and the open product question: `docs/agent-integration-consent.md`.
- **Hook installers** — `src/core/agents/hooks/` holds per-agent hook services + an installer
  registry `MANAGED_HOOK_INSTALLERS`. `managed-script.ts` builds the POSIX hook script that
  POSTs to the server (env-gated: a no-op in the user's normal terminals, active only in
  sessions nodeterm spawns; the `claude-signals` string is kept as the idempotency marker that
  migrates users off the old hook). claude → `~/.claude/settings.json` and gemini →
  `~/.gemini/settings.json` (shared `install-helper.ts`, merged/idempotent, preserving other
  tools' hooks); codex → `~/.codex/hooks.json` + `~/.codex/config.toml` trust entries
  (`codex-trust.ts` — the hash gates whether codex runs the hook); **grok → our OWN file
  `$GROK_HOME/hooks/nodeterm-status.json`** (its hook config is a directory whose files are all
  merged, so there is nothing of the user's inside ours — which is also why a malformed copy is
  *healed*, not preserved, on both the local and the SSH path). The per-event **`matcher`** the grok
  installer needs is why events are typed `ManagedHookEvent` (`string | {event, matcher}`): grok's
  tool matcher is a REGEX and must be `.*` — a bare `*` is invalid and silently stops tool events
  firing. Plain-string events keep their byte-identical output for every other agent.
  **opencode gets TWO plugin files, because no single module loads on both of its generations**
  (issue #1136, `hooks/opencode.ts`, measured 2026-10-16 on @opencode/cli 2.0.30 and opencode-ai
  1.1.4 / 1.2.10 / 1.18.28 / 1.18.33). 2.x accepts only a default export OBJECT `{ id, setup }` (a
  function default is refused) and loads `plugins/*.js` and plugin DIRECTORIES; 1.x loads only
  `{plugin,plugins}/*.{ts,js}` files, and up to **1.2.10 calls every export as a function** — an
  object default there throws and kills every opencode command on the machine, inside nodeterm or
  not (bisected: 1.2.10 crashes, 1.2.11 does not). So `plugins/nodeterm-status.js` keeps ONLY the
  named 1.x export (2.x logs a harmless "failed to load plugin" WARN for it at every start) and 2.x
  gets `plugins/nodeterm-status-v2/index.js`, a directory no 1.x glob matches. **Never add a default
  export to the 1.x file**, and never "simplify" the pair back into one dual-shape file. A
  process-wide latch (`Symbol.for('nodeterm.opencode.status.api')`, keyed by API, not by call)
  keeps a process that runs both from posting twice. The 2.x plugin translates its event stream to
  the 1.x wire names (`session.execution.started` → user `message.updated`, `…succeeded|interrupted`
  → `session.idle`, `…failed` → `session.error`, `form.*` → `question.*`), so `normalizeOpencode` has
  one dialect, and it drops a subagent child session's turn events (forwarding its permission/form
  under the root session). **It refuses to run inside 2.x's shared background server**
  (`serve --service`, argv): by default every 2.x CLI talks to ONE server that keeps the env of
  whichever pane started it and outlives it — measured, a second pane's events carried the first
  pane's `NODETERM_NODE_ID` — so posting from it would paint one node's status on another (the
  codex `--no-daemon` problem). Only a `--standalone` server (the pane's own `serve --stdio` child)
  reports, so **2.x status needs `opencode --standalone`**; nodeterm does not pass it yet (1.x exits
  on the unknown flag, so it needs a codex-style `--help` probe — follow-up), and until then the
  Launch commands override (`opencode --standalone`) is the user's switch.
  **Codex is the one agent whose hook command is NOT a POSIX one-liner on Windows** (issue #567):
  it builds the command as `cmd.exe /C <string>` (`codex-rs/hooks/src/engine/command_runner.rs`,
  rust-v0.151.0) unless the session has a shell configured, which a default Windows install has
  not — so `if [ -x '…' ]; then …; fi` answered `-x was unexpected at this time.` and **exit 1 on
  every event**, for the life of the node. Claude is fine there only because Claude Code runs its
  hooks through Git Bash. The fix is a batch entry point (`codex-hook.cmd`,
  `codex-windows-wrapper.ts`) written beside `codex.sh` and named by `buildManagedCommand`'s win32
  branch; it **locates a POSIX shell and runs the same script** — deliberately not a second
  implementation of the hook protocol, which would be two copies of the POST/failover/token/
  permission-poll to drift. Three rules it must keep: pass stdin through, DRAIN stdin on every bail
  (codex writes the payload there; #186/#187), and exit 0 when there is no shell or no script.
  Two traps around it: `buildManagedCommand`'s `platform` is the platform of the machine that will
  RUN codex, so `RemoteHooks.installCodexRemote` passes POSIX explicitly (a Windows desktop must not
  put a `.cmd` command on a Linux host); and `isManagedCommand` matches **both** leaves
  (`codex.sh` AND `codex-hook.cmd`) on every platform — matching only the local one would leave a
  pre-fix entry unrecognized, so the fresh one is appended beside it, which is #558 on a second
  file. Matching both is what REPAIRS an existing Windows install at the next launch.
  **Codex hook trust is re-checked at every LOCAL Codex spawn, not only at boot, in the HOME that
  session runs under** (`ensureCodexHooksCurrent(home)` in `core/agents/hooks/codex.ts`, called
  from `PtyManager.spawnSession` inside the local codex-scope block with the same
  `codexScope.CODEX_HOME` it puts in the pane's env — a managed account's private home or the
  system one). Codex reads hooks.json and the config.toml `trusted_hash` blocks from its
  CODEX_HOME at SESSION START and silently skips an untrusted hook; boot was the only install, so a
  config.toml rewritten while the app ran (codex's own /hooks flow, another tool, a test run on the
  real home) left every Codex session started afterwards dark — measured on a Windows desktop:
  every message to those nodes queued as `targetStatusStale` and expired. `codexHookDrift(home)`
  is read-only (script + Windows wrapper bytes, our hooks.json entries via the same
  `buildCodexHooksAndTrust`, and each trust key's hash); only drift re-runs
  `installCodexHooks(home)`, with a warning naming the home and what was repaired, so a current
  install never rewrites config.toml (codex writes it too). It never throws into the spawn, never
  creates a missing home, and an `accountId` that is not a known Codex account gets no repair
  (never a fallback to `~/.codex`). **Both repairs are consent-gated (issue #744):** the spawn
  check is reached only through `currentIntegrationLifecycle()?.ensureCodexHooksForLaunch(home)`
  and the account-home pass only inside `reconcile()` — both in `core/agent-integrations.ts`, both
  a no-op unless codex is `enabled` (declined, undecided, the Server Edition veto, or no lifecycle
  registered ⇒ nothing is written). Calling `ensureCodexHooksCurrent` from anywhere else would
  re-install hooks for a user who declined them. **Managed account homes symlink hooks.json + config.toml to
  `~/.codex`** (`initializeAccountHome`), so every write goes through the link (`writeTarget`,
  realpath) — a temp+rename onto the link would replace it with a private copy no later system
  install reaches. A home whose links were never made or were replaced by real files is repaired in
  place; boot now covers those homes too (`ensureCodexHooksForAccounts`, from the lifecycle's reconcile in both shells), where before
  it installed only `~/.codex` and relied on the links. Not covered: SSH hosts (RemoteHooks owns
  those files) and an in-pane restart/resume that types `codex` without a new spawn.
  **A trust table is found by its DECODED key, never by spelling** (`tableHeaderPath`,
  `codex-trust.ts`): bare, `"basic"` (escapes, `\u`) and `'literal'` segments name the same TOML
  key. Measured live on a Windows desktop (2026-10-07): config.toml held our tables as
  `[hooks.state.'C:\…']`, the matcher only knew our `"C:\\…"` spelling, the repair APPENDED a second
  table per key, and Codex refused to start ("duplicate key") — every Codex node dead. The boot
  install had the same flaw before the launch repair existed; the launch repair just ran it more
  often. A repair now REWRITES the existing table whatever its quoting (keeping `enabled = false`),
  and **an edit that would leave any `[table]` defined twice is refused** (`assertTomlTablesUnique`,
  run inside `upsertHookTrustEntriesInContent` whenever it changed the text): the local installer
  computes the config.toml edit BEFORE writing hooks.json, so a refusal writes nothing and warns; the
  SSH installer throws inside its update and writes no config.toml. No TOML parser is in our deps, so
  the guard is the duplicate-table check, not full validation. **A managed hook command is matched
  only under our own directories** (`OWN_HOOK_DIRS`: `/.nodeterm`, `/node-terminal`,
  `/.nodeterm-server` + `/agent-hooks/<leaf>`), never a bare `agent-hooks/<leaf>` tail: another tool keeps
  `~/.other/agent-hooks/codex-hook.cmd` and the tail match stripped it on every repair (and that tool
  did the same to ours). A stale entry from a Server Edition run with a custom `--data-dir` is no
  longer swept — **by repair OR by a declined codex's cleanup** (`removeCodexHooks` shares the
  matcher). Decided, not overlooked: a decline removes exactly what we wrote, and a tail match cannot
  tell our legacy entry from another tool's live one, so the inert legacy entry is left. install-helper's matcher for the other agents still matches by tail (not changed here). **Both
  sides of the managed-entry match go through `normalizeHookCommand`** — the marker used to be
  folded to `/` while the stored command was compared raw, so on Windows nodeterm never recognized
  its OWN entry and appended a fresh set every launch (#558: nine copies of nine events, nine
  `claude.sh` processes per Stop, nine 45 s `PermissionRequest` waits racing one prompt). Because
  `mergeManagedHook` drops every managed entry before pushing one fresh, the corrected match IS the
  repair for a file already ruined — it runs at boot via `installManagedAgentHooks` and, being the
  ONE shared merge, heals claude/gemini/grok, every managed Claude account dir and all three SSH
  remote installers at once; a second repair mechanism would be exactly the duplicated rule this
  file warns about. It strips only OUR handler out of a definition, so a hook a user hand-merged
  beside ours survives.
  **Every agent except claude gets a Windows wrapper** (2026-10): gemini (PowerShell, its
  `getShellConfiguration`), grok (PowerShell per its docs — unmeasured) and copilot (its
  `powershell` key) cannot parse the POSIX line either, so `windows-hook-wrapper.ts` is the ONE
  template (`buildWindowsHookWrapper`, codex's bytes pinned) and `buildManagedHookCommand(sp, {},
  'win32')` names `<agent>-hook.cmd` through the codex invocation. Its `platform` defaults to POSIX,
  NOT `process.platform` — the SSH installers call it bare. `installHooksInto({windowsWrapper})`
  writes the wrapper BEFORE the config; the managed-entry matcher pairs `<agent>.sh` with
  `<agent>-hook.cmd` (`managedMarkersFor`) so an upgrade replaces the POSIX entry. Claude stays
  POSIX (Git Bash).
- **A reused ControlMaster is not evidence of a live hook tunnel** (issue #735 — remote sessions
  stuck on **Unknown**, no completion notifications, no unread dots). `connect()`'s reuse branch
  returned the cached `hookEndpointPath` whenever `ssh -O check` answered, on the written-down
  assumption that *"a master that answered `-O check` never lost its tunnel"*. That is false, and
  the mechanism is **our own self-heal**: `childArgs` uses `ControlMaster=auto` + `ControlPersist`
  precisely so a dead master is rebuilt by the next child command (a status poll, a mirror push, a
  remote git call) on the same ControlPath. The rebuilt master answers `-O check` — and carries no
  `-R`, because `RemoteHooks.setup()` is the only caller of `hookForwardArgs` and it runs only on
  the branch where a master has just come up. The 45 s watchdog then parks on the reuse branch
  forever. Nothing reports it: the project says `connected`, terminals work, the mirror pushes, and
  only the hook POSTs die — into a socket file that still EXISTS with nobody listening.
  **MEASURED on the host that prompted the fix**: 10 per-project hook sockets on disk, exactly ONE
  with a listener (`ss -lxp`); the dead project's socket answered `curl` exit 7 while that same
  project's status mirror was being written the same second; **107 of 128** live `nodeterm-rmt`
  tmux sessions were pinned to that dead endpoint. Sessions are pinned for life
  (`new-session -A -e …` — tmux ignores `-e` on an existing session), so every one of them stayed
  dark until the app restarted. The reuse branch now probes the tunnel (`RemoteHooks.tunnelAlive`,
  one `curl` over the already-multiplexed master) and re-runs the idempotent `setup()` when it does
  not answer, firing `onTunnelVerified` so the working agents resync. **The retry is backed off**
  (`tunnel-repair.ts`, pure + tested): the FIRST failure repairs immediately — that is the common
  case — while a host that can never forward (`AllowStreamLocalForwarding no`, no `curl`, a `$HOME`
  the validator refuses) settles at one attempt per 15 minutes instead of rewriting every agent's
  hook config every 45 s. A missing spec answers "not alive" rather than "unknown": nothing of ours
  is bound, which is a tunnel that cannot deliver.
- **An SSH host's agent tools are CHECKED, not assumed** (since #744 the plan holds only what the
  host's consent installs — shims + skills, no instruction blocks; an unanswered host is skipped)
  (`RemoteHooks.refreshAgentTools`,
  `main/remote-ssh/agent-tools-freshness.ts`). The canvas/context shims, both SKILL.md files and our
  blocks in the codex/gemini/copilot/opencode instruction files used to be written only by the
  establish path, blind, and never looked at again, so a host could keep another build's text for
  a whole run: a fire-and-forget install that failed open was never retried; a tunnel that failed
  verification at connect and was repaired later on the reuse branch (#735, above) never got them
  at all; and a managed account's skill was written ONCE, when the account was added, so after
  every update each remote account session read the verb docs of the build that created the
  account. (The obvious suspect is not one: an app update never lands on the reuse branch. `conns`
  is in memory, so the first connect after a relaunch adopts the ControlPersist orphan on the
  ESTABLISH path, which always wrote. `ssh-project.test.ts` pins that it checks there too.)
  - **The stamp is the bytes.** One generated probe (one round trip, a few hundred bytes back)
    runs POSIX `cksum` over every file the host holds and, for an instruction file, over exactly
    the span `merge*Block` would replace (awk under `LC_ALL=C`: the first start marker through the
    first end marker, only when the end follows the start). That is compared with `posixCksum` of
    the exact bytes this build would write (`core/remote-ssh/posix-cksum.ts`, pinned against the
    real binary), and only what differs is rewritten, through the same appliers as the install. A
    current host costs the probe and no write. Nothing is embedded in the artifacts: a stamp line
    would be noise in every agent's context, would need a migration for hosts written by older
    builds, and would trust a file's claim about itself. `cksum` because it is the one checksum POSIX
    requires; CRC-32 + length is not collision resistant and does not need to be, because this
    detects drift and is not a security check. Ubuntu's own BusyBox build omits `cksum`, so such a
    host exists: missing, unreadable and gated files are still told apart there, the files it can
    read are written without comparison (what every connect did before) and the blocks merged. An
    awk that fails on a block is reported (`X`, through fd 3 — `awk | cksum` exits with cksum's
    status) and that block is merged, which writes only on a change. Only files ACTUALLY written
    are logged as "rewrote" or make the outcome `refreshed`. The permanent suite runs the probe
    under every shell × awk the machine has (what the CI image has); a one-off manual run added
    BusyBox sh, zsh 5.9 and the one-true awk 20231127 (`NT_PROBE_EXTRA_AWK` / `_SH`). macOS's own
    awk (20200816) and BSD `cksum` have never been run — that is on the PR's Mac checklist.
  - **The end marker is searched AFTER the start marker** — in both `merge*Block` functions and in
    the probe's awk alike. Taking the first end marker anywhere read a hand-deleted block's leftover
    end line as "no block": the merge appended a fresh copy every time, and with an hourly check a
    host's AGENTS.md grew by one block an hour (measured in review: 41,693 → 81,279 → 120,865 →
    160,451 bytes). The same merges run at boot for the desktop's and the Server Edition's own local
    instruction files (`initCanvasControl`, `initContextLink`), which grew by one block per launch.
  - **Refusals.** A file that is not a readable regular file (a directory, a dangling dotfile link,
    no permission) is NEVER written over, and the host is not called confirmed. A managed account's
    skill is refreshed only when its dir ALREADY exists — checked by the probe and again on the host
    in the write itself (`remoteAtomicWrite`'s `requireDir`), so a dir removed in between is not
    brought back by the parent `mkdir -p`. A report that does not
    parse changes nothing. Account ids from settings are re-validated (`isSafeAccountId`) before
    they become paths. The copilot block is judged at the host's `$COPILOT_HOME` only when the
    installer's validator would accept that value.
  - **Cadence.** A connect (establish, including the post-relaunch orphan adoption) and a tunnel
    repair always check. The 45 s reuse branch costs nothing once this run has confirmed the host
    for the current expected set (content + account list). An unconfirmed host is retried there on
    the tunnel-repair backoff (1/5/15 min). A confirmed host is looked at again hourly
    (`AGENT_TOOLS_RECHECK_MS`), because within a run only a writer outside it (another desktop,
    possibly an older build, on the same host account; a hand edit) can change the files. One check
    per host at a time: projects sharing a host share it.
  - **A new agent-facing doc on a host goes into the artifact plan in `remote-hooks.ts`**
    (`canvasControlArtifacts` / `contextLinkArtifacts` / `accountSkillArtifacts`) — shims, skills,
    instruction blocks. The installers and the probe both read it, so a file added there is written
    AND kept current. NOT the rest of what connect writes: the hook scripts and the agents' hook
    config belong to `setup()`'s ordered chain (after the verified tunnel and the endpoint file),
    and the endpoint file and node tokens carry credentials — none of those may be rewritten on a
    freshness cadence.
  - **What a running agent sees.** The shim's `help` is answered by the shim itself (baked from the
    verb registry), so it is current the moment the file is. Claude reads a SKILL.md body when the
    skill is invoked; codex, gemini and opencode read their instruction files at session start, so
    a session started before a rewrite keeps the old text until it restarts. Nothing is typed into
    a pane to announce it.
  - Surfaces: Desktop only (SSH projects are a desktop concept). The Server Edition runs ON its host
    and rewrites its local shims at every boot. Mobile: N/A.
- **The per-agent hook installs run CONCURRENTLY, and the order that still matters is the one above
  them.** `RemoteHooks.setup()` is the chain `connectOnce` awaits before a project reports
  `connected`, so every terminal of a switched-to project waits through it. Its shape was: resolve
  `$HOME`, open + VERIFY the reverse tunnel, write the endpoint file — and then install five agents'
  hooks strictly one after another, ~16 more remote round trips in a row. MEASURED against a real
  sshd through a 25 ms one-way delay proxy (50 ms RTT), 5 runs each: **3281 ms serial → 1471 ms
  concurrent** over the same 22–24 ssh children. The installers are independent by construction —
  each writes its own script under `<remoteDir>/agent-hooks/` and merges its own agent's config; no
  two touch the same remote path, and the only shared statement is an idempotent `mkdir -p` — and
  the `SshChildGate` (cap 6 per ControlMaster) is what makes the fan-out safe against a stock host's
  `MaxSessions`, which is the whole reason it exists.
  - **The tunnel and the endpoint file stay strictly BEFORE the fan-out**: that file is what every
    hook this installs POSTs through, and it is written only once the tunnel has verified end to
    end. `remote-hooks.test.ts` pins that ordering AND the overlap (a gated fake runner, so
    concurrency is observed rather than inferred from wall-clock; the overlap test fails on the
    serial version, checked by mutation).
  - **`allSettled`, not `all`.** By the fan-out the tunnel is verified and the endpoint written, so
    one installer failing must cost that agent its hooks and nothing else — not discard a working
    setup for every other agent, which is what a rejection propagating to `setup`'s outer catch
    would do (`return null` ⇒ no hooks at all, and post-#735 a repair retried on backoff forever).
    Every installer catches its own errors today; this is the guard for the next one that forgets.
  - The claude/gemini loop body became `installJsonAgentRemote`, with the same fail-open try/catch
    its three siblings already had. Its three steps stay strictly ordered inside: the merge reads
    the file the write then replaces.

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

- **Hook-reply answers: plans and questions** (`core/agents/permission-decision.ts`, full write-up in
  **`docs/hook-reply-approvals.md`**) — the managed hook holds a Claude `PermissionRequest` and polls an
  answer file. For `ExitPlanMode` / `AskUserQuestion` (`requiresUserInteraction`) Claude **DROPS a bare
  allow**, so the answer must carry `updatedInput`: plan = `{}` (+ optional session `setMode
  acceptEdits|default`, never `auto`), question = the request's own `questions` + `answers`. Rules a
  refactor must not undo: (1) **only core builds decision JSON**, from the pending request file on the
  agent's host (never renderer-echoed questions), validating every field; (2) the script prints only the
  fixed words' decisions or a file that passes the strict prefix/size/one-line bound
  (`isBoundedAnswerContent` is the TS twin — both writers refuse anything the script would ignore);
  (3) answer content never rides an argv (the answered POST carries the decoded verb; SSH writes go on
  stdin); (4) a plain `allow` maps to `updatedInput:{}` for a plan and is swallowed (hook keeps
  holding) for a question — core refuses to write it and the header hides ✓ Approve for that ticket;
  (5) these two tools hold 540 s (`PERM_WAIT_SECS_INTERACTIVE`) under the explicit `timeout: 600` we
  write on the PermissionRequest handler — except a subagent's request (payload carries `agent_id`),
  whose dialog awaits the hook; (6) structured answers are gated on the SCRIPT REVISION: an old script on
  an SSH host (rewritten only at connect) silently ignores JSON while the write succeeds, so the hook
  server keeps `held` only for `clientRevision >= MIN_STRUCTURED_ANSWER_REVISION` and core refuses a
  structured answer (or a plain plan allow) for a ticket it did not record as capable — never a false
  "answered". The renderer gets `held: {pendingId, toolName, questions?}` on the event/store (kept while blocked
  OR waiting), separate from the approve/deny `pendingId` the mirror strips from a question;
  `questions` (a held AskUserQuestion's exact question texts, from the one `readQuestions`) is what
  the ⌘M answer controls match their card by — absent = unreadable input = no controls. Desktop local + SSH, Server Edition local;
  relay unchanged; phone keeps `allow`/`deny` (its plan approve now works via the script mapping).
- **A hook event's node id is INHERITED, so only the pane's foreground claude speaks for a node**
  (issues #1112, #1153; `core/agents/claude-pane-origin.ts`). `NODETERM_NODE_ID` (and the per-node
  token, looked up by that id) reaches every process the node's claude starts: a background script's
  `claude -p` took over the node's session id, model, meter and context-link transcript (#1112), and
  Claude's daemon (`claude daemon run` → `--bg-pty-host` → the `--fork-session` claude) posted a
  fork's hooks as the node that spawned it, so `/rename` retitled the wrong node (#1153). The rule is
  keyed on the PROCESS, not the session: the managed claude script runs one
  `ps -o stat= -o tty= -p $CLAUDE_PID` WHILE claude waits on the hook and posts
  `nodeterm_claude_{pid,fg,tty}`; the hook server sends every claude event through a per-node
  ordered gate BEFORE either listener, and drops it when the claude is not in the foreground group
  of any terminal, or is foreground on a tty that is not the node's pane tty (`PtyManager.paneOwner`,
  wired in BOTH shells by `wireClaudePaneOrigin`, cached 5 min, re-read on disagreement at most every
  10 s, forgotten on destroy/recycle). MEASURED on Claude Code 2.1.301 in a private tmux server:
  `CLAUDE_PID` is in every hook's env (and in the binary from at least 2.1.220, absent from 2.1.200);
  the pane's interactive claude has `+` on the pane tty; a `claude -p` run from claude's Bash tool
  (a setsid'd shell) has tty `?`; a `&` job of the pane shell has no `+`. Every legitimate change —
  `/clear`, `/resume`, `/compact`, Branch, cold-restore resume, in-place restart, a new `claude`
  after the old one quit — happens in the pane's foreground and needs no rule of its own; a claude
  that died without `SessionEnd` blocks nothing (there is no binding to release). Rejected:
  session-source allowlists (a detached `claude -p --resume` also says `resume`; a missing
  `SessionEnd` locks the next session out — both found in the #1112 prototype) and "first session
  wins until its pid dies" (needs a remote liveness probe, and a daemon fork outliving its spawner
  would take the node over). **Fails OPEN** wherever a fact is missing — no `CLAUDE_PID` (older
  claude), Git Bash / BusyBox `ps`, a pane tty this core cannot read (Zellij, plain-shell fallback,
  an SSH node with no live client here), a probe over 2 s — because dropping the pane's OWN events
  strands a node on RUNNING. The script also never arms the approval wait for a non-foreground
  claude. Known residuals: a claude wrapped in its own pty inside the pane (`script`, `unbuffer`) is
  foreground on that pty and reads as foreign; a node whose TUI attaches to a daemon-hosted session
  gets no hook events at all (they were never posted under its id). Mobile: N/A (the mirror simply
  stops receiving foreign events).
- **Per-node hook identity** (`src/core/agents/node-auth-*.ts`, `node-token-*.ts`,
  `node-identity-policy.ts` — full write-up in **`docs/node-identity.md`**) — the shared bearer proves
  "a session on this machine", never *which* session, so every node also gets a capability derived
  from one restart-stable secret (`kid.mac`, domain-separated HMAC over the node id), handed to the
  client as a 0600 file and verified three ways: `verified` / `legacy` / `forged`. `legacy` is "we
  cannot judge this", not a failure. Two invariants come out of this series and both cost real
  incidents to learn:
  - **A credential never rides argv — local or SSH.** Measured 2026-08-13: `buildPtyEnv` put the hook
    bearer in the tmux `-e` argv, which lands in a long-lived tmux client's `/proc/<pid>/cmdline`
    at **mode 444** on a stock Linux with no `hidepid`; combined with `open-terminal --cmd` not being
    in the confirm-gated `DESTRUCTIVE` set, that was arbitrary command execution as the victim from
    any account on the box. A remote command line is argv on **both** ends, so the same rule binds
    every `ssh`/`curl` we generate. Credentials travel by 0600 file or by **stdin**
    (`curl --config -`, already house style in `usage/remote-claude-usage.ts` and
    `codex-identity-proxy.ts`). Never add an argv fallback "for old curl" — that undoes the fix.
  - **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
    A new field on the hook event (the `verified` flag was one) that reaches only the desktop leaves
    the Server Edition silently without the feature; the boundary tests cannot tell you a field is
    *missing*. `hook-verified-parity.test.ts` asserts it at source level because this repo has
    shipped a one-shell hook-server change three times.
  - **Every generated sh client reads the token through ONE resolver** (`nt_read_node_token`,
    `core/agents/node-token-sh.ts`) — the managed hook script, `nodeterm.sh` and `context.sh`. The
    token dir is advertised only by the endpoint FILE, and a session is pinned for life to the
    endpoint PATH it got at tmux creation, so a client that reads only what that file advertises
    presents nothing forever when the file is pre-v2 (SSH hosts' shared `~/.nodeterm/hook-
    endpoint.env`, whose per-project socket path is re-bound on every connect, so it stays LIVE) or
    unreadable (a phone-spawned session). Issue #384: the hook script FAILS OVER and re-reads the
    token from the endpoint it adopts, the two shims did neither — so the same node proved itself
    through one client and was refused through the other by the trust-on-first-proof latch, for the
    life of the session. The resolver falls back to `<dir of the endpoint file>/node-tokens` (the
    layout by construction on all three surfaces) and then the well-known data dirs; it is monotone
    — advertised dir first, keyed by node-id filename in every candidate, and a foreign instance's
    dir yields a foreign `kid` = `legacy` = exactly what presenting nothing already gave.
  - **A Codex HOOK under the shared app-server is identified by its PAYLOAD, not its env** (#1150,
    #1175). MEASURED on codex-cli 0.162.0 (private CODEX_HOME + tmux socket, a hook dumping env and
    stdin): a hook process is the DAEMON's child, carries the daemon's env and NEVER
    `CODEX_THREAD_ID` (only tool shells get that), and its stdin starts `{"session_id":"<thread>"`.
    So a scrubbed daemon ran every managed node's hooks with no node id (silent exit, #1150), and a
    daemon a plain `codex` pane started ran them under THAT pane's long-gone `NODETERM_NODE_ID`
    (#1175). The codex managed script (local only — remote scripts carry no prelude) now reads stdin
    FIRST, takes the LEADING `session_id` with builtins (anchored, so a nested one in tool input
    never matches), and hands it to the prelude (`hookPayloadThread`), where a record for that thread
    wins over an INHERITED node id and the stale endpoint vars are unset before the record's
    endpoint file is sourced. The one exception is a pane our launcher ran in-process
    (`nt_exec_plain` exports `NODETERM_CODEX_PLAIN=1`; never on a `--remote` exit): its env is its
    own and stands. Tool shells and both shims keep the old rule (a set id is never touched). The
    event is still verified against the bound node's 0600 token, so a forged payload buys nothing a
    same-user process could not already do. Residuals: a node launched with a bare `codex` (shared
    identity off) whose thread has ANOTHER node's record reports as that node; and a codex typed
    inside a marked plain pane's tool shell starts a daemon that carries the marker.
  - **Every LOCAL generated sh client recovers shared-Codex identity before its env gate.** A tool
    shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
    `NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` therefore prepend
    `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
    `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL`. Before this was shared, status hooks recovered the
    node while both user-facing shims declared that same first-class Codex session outside
    nodeterm. The SSH constants remain machine-neutral: the local record root is not valid on a
    remote host and must never be baked into its copy — enforced by
    `main/remote-ssh/remote-shim-neutrality.guard.test.ts`, two legs (the exported neutral bodies
    carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a parameterised
    builder), because the failure is silent and one-sided: a remote shim carrying the prelude keeps
    working, and the only symptom is this machine's userData layout sitting in a file on someone
    else's server. **The prelude is shared; the RECORD it reads is desktop-only.** Those writers are
    the two hook-server handlers `src/main/index.ts` registers — and, since the daemon-reset work,
    the ones `wireServerCodexSharedIdentity` (`src/server/codex-shared-identity.ts`) registers at
    Server Edition boot as well. That shell used to answer a flat `shared: false`
    (`UNKNOWN_CODEX_IDENTITY_CAPS`) as a DELIBERATE degrade: its Codex nodes ran their own
    app-server, so no tool shell needed recovering. It no longer does. The Server Edition has the
    same local app-server, the same signed node tokens and the same persistent canvas store, so it
    wires the shared-thread spine **after** those secrets exist and its panes get the same
    supervisor. The registration is deliberately late for that reason, and `registerCodexIdentityIpc()`
    now answers from the live resolver instead of a constant — an early browser caller waits for the
    refresh rather than being pinned to a false "plain Codex" answer for the whole app run. What
    remains desktop-only is the record's REMOTE leg (SSH shims carry no record root or prelude, the
    paragraph above).
  - **That prelude EXPORTS WHAT THE RECORD SAYS — it never decides.** `NODETERM_AGENT_ID` and
    `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are
    `buildPtyEnv`'s answers about the PANE, which labels a node with its OWN agent id
    (`custom:<uuid>` for a custom agent whose `baseAgent` is codex, not `codex`) and gates the grant
    on `canControlCanvas`. The constants therefore mislabelled every custom codex-based node and
    asserted a grant that agrees with the pane only because
    `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence that list's own comment
    invites the next shared-identity agent to break, and breaking it hands a tool shell a capability
    its pane was denied. So the record carries `agentId` + `canvasControl` INSIDE the 6-tuple HMAC,
    and the prelude reads them; the grant is exported only when the record grants it and is left
    UNSET otherwise (absent, never `0` — the shape both shims' `[ -z … ]` gates expect). The **pane
    echoes its own label** on `/codex-thread/{start,bind}` (a tmux session outlives the app, so
    after a restart nothing server-side still knows what agent a node runs), but the **grant is
    never echoed**: the route derives it with `canControlCanvas`, so there is ONE decider and a
    forged id cannot manufacture a grant the table refuses. The three preimage generations are
    **selected by the record's shape, never tried in turn** — a record naming an agent must not
    verify under a preimage that ignores one — and a pre-agent record's implied `codex` + grant is
    keyed on the LINE being absent, never on the value being empty, so nothing that names an agent
    falls back to the guess. The env vars were never a security boundary in any case (anyone who can
    run the shim can `export` them by hand); the per-node token is, and
    `docs/shared-codex-node-identity.md` states that argument in full.
  - **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
    destructures the request without `agent`, and a record write that omits its optional trailing
    argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route,
    the launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
    `main/codex-identity-record-wiring.test.ts` pins it at source level, the same remedy
    `hook-verified-parity.test.ts` uses for the same class of hole.
  - Control/context endpoint discovery keeps a known node capability as a **routing rule, not an
    ownership proof**. A dead Desktop SSH tunnel must not redirect a command to a local Server
    Edition: its unsupported-edition response describes the wrong instance. The two shims use
    `nt_adopt_for_node` (`core/agents/hook-endpoint-failover-sh.ts`). The reference value is read
    from the PRIMARY endpoint's own token dir only — the one it advertises, else the adjacent
    `node-tokens` — never from the global search `nt_read_node_token` walks (that search exists to
    PRESENT a capability, #384; as a reference it let a Server Edition that opened the same
    project.json supply the "owner's" token whenever the desktop's token write had failed). Once
    that dir EXISTS, a candidate must hold the same value in its own dir — and when the reference
    is EMPTY (the write failed), a value proves nothing (a Server Edition that never heard of the
    node holds nothing too, and `"" = ""` relayed its permanent refusal, measured in review), so the
    candidate's token dir must be the same REAL directory (`pwd -P`) instead. Only a session with no
    such dir at all keeps legacy discovery. What a match shows is
    that the candidate reads the same token file for this node — on an SSH host that file is shared
    per unix ACCOUNT (`remote-hooks.ts`, KNOWN LIMITATION), so two desktops driving one account are
    indistinguishable here, and the receiving server still authorizes every request. Actual
    owning-endpoint refusals remain final. Skipped foreign candidates do not consume the
    three-attempt budget, and a skipped candidate restores the previous endpoint vars (the codex
    sandbox hint names `$NODETERM_HOOK_SOCK` as the socket to allow). Hook event delivery retains
    its existing independent failover policy.
    **Every FALLBACK candidate is probed before the real POST** (`nt_probe_endpoint`: `/hook/verify`,
    204 on the bearer alone on every server build, `--connect-timeout 0.5 --max-time 1.5`). A reverse
    tunnel whose sshd outlived the desktop's connection ACCEPTS and never answers, and once the
    foreign Server Edition stopped absorbing the walk, a call posted straight into such a socket
    hung. The bound is on the probe only: the primary is never probed and every real POST stays
    unbounded, because a confirm-gated verb waits for a human (see "two canvases cannot raise two
    dialogs" below). The probe writes into `$nt_out` like the POST would, so a 421 at the probe
    still prints its body (into /dev/null it left the control shim exiting 1 with an EMPTY stderr),
    and the control shim names a final 421 with `CONTROL_UNREACHABLE_MSG` as the context shim does.
    Consequence to know: while sshd still holds the session's OWN tunnel socket, the primary POST
    itself still hangs — unbounded by design, for the dialogs.
    **Measured on an SSH host (2026-09-28/29):** the desktop slept, the session's tunnel socket
    stayed on disk with no listener, and the walk reached an unrelated Server Edition whose
    `control-unsupported-on-this-edition … permanent … do not retry` (and, for context reads,
    "No linked nodes") was true about that server and false about the session; the tunnel came
    back minutes later. When a foreign candidate was skipped and no owner answered, the shims now
    print `FOREIGN_ENDPOINT_HINT` — the owning connection is unreachable, the state is temporary,
    the usual cause for an SSH project is the tunnel — INSTEAD OF `STALE_ENDPOINT_HINT`, so a failure
    carries one retry advice, not two. With nothing foreign skipped, a primary that is an SSH tunnel
    file (`~/.nodeterm/hook-endpoint*.env`, the only files the desktop writes there) gets
    `TUNNEL_DOWN_HINT` (reconnect) instead of the stale-endpoint advice (app restart); both hints
    open with the lead the bodies quote. All four agent-facing bodies quote its lead via
    `ownerUnreachableGuidanceLines`, because their other refusal lines rightly say "do not retry".
    `src/server/control-owner-tunnel-down.test.ts` rebuilds that host under real `/bin/sh` with the
    real Server Edition handlers as the foreign endpoint; `src/core/owned-endpoint-walk.test.ts`
    pins the probe (hanging sockets), the owner reference, the single advice and the restore, each
    mutation-checked.
  - **Every generated sh client walks the SAME endpoint failover** (`nt_candidates`/`nt_adopt`,
    `core/agents/hook-endpoint-failover-sh.ts`) — issue #445, the endpoint-level twin of #384: a
    session is pinned for life to the endpoint PATH it got at tmux creation, so an app
    quit/restart (or a retired project id) leaves it POSTing at a dead port while a live endpoint
    file sits right next to it. The managed hook script had the bounded candidate walk (locals
    before tunnels, `nt_fallback_max` 3, token re-read from the ADOPTED endpoint's dir); the two
    shims did not, so hook events healed themselves while every canvas-control verb died with
    "control endpoint unreachable" — in the field, a reviewer launch silently dropped. Now shared,
    one definition. Two server-side halves in `hook-server.ts`: a FAILED `listen()` un-wedges the
    singleton (it used to leave `this.server` set, making every retry a silent no-op at port 0)
    and `stop()` deletes only the endpoint contents this run published — a failed start cannot
    erase another owner's advertisement. A crash skips cleanup, which is why clients still walk
    the candidates.
    HTTP 421 means the bearer belongs to a different endpoint and is rejected BEFORE dispatch;
    it joins dead transport (curl 000/'') in the bounded discovery walk. A node-identity 403/400
    remains final and is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` for transport failures (#367); an explicit 421 proves
    transport worked and still permits discovery. The final error distinguishes "no endpoint
    anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  - **Hook endpoint ownership (#826):** startup first probes every transport in an existing
    endpoint advertisement and preserves a live or uncertain owner. The local Unix listener probes its socket before
    cleanup. Only `ECONNREFUSED` plus the same device/inode permits removal; a live listener,
    non-socket, symlink or uncertain probe disables hooks without replacing its endpoint.
    Both shells use `startForApp`: Desktop creates its window and then shows an actionable warning;
    Server Edition logs the same warning and continues boot. An authenticated owner must answer
    `/verify` with 204 for the advertised bearer AND reject a random bearer (403/421); unrelated
    HTTP responses are uncertain listeners, not authenticated nodeterm. Probes have a hard deadline.
    Endpoint writes are atomic and stop removes only the run's own advertised contents. SSH setup
    never removes a socket before binding: every forward gets a fresh random path, while discovery
    is stable per project + installation identity hash. Only a verified replacement is advertised;
    then this run cancels its previous forward. A legacy project endpoint is migrated only when its
    bearer matches the current run, the previous installation-qualified advertisement, or a stale
    conventional local advertisement retained at boot. Publication rechecks the snapshot digest,
    refuses symlinks, uses a migration lock and a private temp, and never places credentials in argv.
    Without ownership proof (including a first upgrade after the old local advertisement was deleted),
    it preserves the file and logs instructions to restart affected agent sessions; discovery still
    works but may incur the old dead-tunnel delay until then. No real-host upgrade is claimed by unit tests. A reused tunnel that loses bearer verification
    emits hook-only health updates: the desktop shows a warning and clears it after repair, without
    reconnecting terminals. These changes share the core listener in Desktop and Server Edition;
    the mobile wire protocol and node-identity rules are unchanged.

  - **A browser is refused before the bearer is looked at** (`core/agents/hook-browser-guard.ts`).
    The bearer stays the real gate; this is the belt beside it, against the one caller that can
    reach a loopback port without being a process of ours. A request carrying ANY `Origin` header,
    or a `Host` that is not `127.0.0.1` / `localhost` / `[::1]` (any port), gets 403 on both
    listeners, before the 403-vs-421 bearer distinction, so a DNS-rebound page learns nothing.
    MEASURED, every shipped client passes: curl over the socket sends `Host: localhost` (the codex
    launcher's socket URL sends `localhost:0`), curl over TCP `127.0.0.1:<port>` (the SSH TCP
    fallback arrives with the HOST's port — hence any port), Node's `http` over the socket
    `localhost`, Node's fetch no Origin (but `sec-fetch-mode: cors` — never refuse on that), Bun's
    fetch (opencode's runtime) no Origin. The SSH reverse tunnel forwards bytes, so a host-side
    curl's Host arrives unchanged. A request with no Host is let through (Node already 400s an
    HTTP/1.1 one; no browser sends one). **A new client must send no Origin and a loopback Host** —
    `hook-server.browser-guard.test.ts` drives the real transports and goes red otherwise.
  - **`~/.nodeterm` on an SSH host is 0700** (`privateRemoteDirCommand`, run by `setup()` on every
    connect and tunnel repair): created under `umask 077` and an existing one tightened, never
    through a symlink, never a directory the login user does not own (`-O`, which only a root login
    needs). The secrets inside were already 0600 one by one; the umbrella is so a future file written
    there without a mode is not born world-readable in a traversable directory.

  - **No keyring is not "no identity" (#1088).** Electron 42 on a Linux session without Secret
    Service/kwallet picks `basic_text` and `safeStorage.encryptString` THROWS (measured under xvfb).
    The desktop secret load used to reject on every boot ⇒ no node token was ever written ⇒ `send` /
    `settings` refused forever with no visible cause. The loader now falls back to the Server
    Edition's raw 0600 `node-auth-key.bin` when it cannot seal and no sealed key exists (a sealed key
    it merely cannot unseal still rejects — rotating it orphans codex thread records), and both shells
    record a failed arming via `hookServer.setNodeIdentityUnavailable`, which a verified-only refusal
    then names. A secret that cannot be stored must degrade to the weaker store, never to a feature
    that is silently off.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Shared Claude/Gemini settings are user data (issue #851).** The local hook install/remove
  and Claude fullscreen writers share `core/agents/hooks/settings-file.ts`; SSH system/account
  hook installs and fullscreen writes share `remote-settings-file.ts`. Only ENOENT / the remote
  explicit missing-file status or a successfully read empty/whitespace file starts from `{}`.
  Malformed/non-object/read-error settings are preserved. Each transaction stages the complete output, takes a `.nodeterm-lock` directory,
  compares its original bytes before rename, and preserves the file mode. Remote snapshots and
  replacements travel on stdin, with a byte-count check against truncated transport; the shell
  needs no Python/Node/jq. Local profiles resolve symlinks and lock/update the shared target,
  rechecking resolution before publication. SSH does the same with plain readlink + cd -P
  (macOS-compatible, no GNU -f), bounding cycles and refusing dangling links/newline paths.
  Grok's owned file heals malformed JSON and hook shapes by rebuilding its managed config.
  A held or crash-left lock skips the update with a diagnostic naming the lock and instructing
  the user to stop writers before inspecting/removing a stale lock; it never gets stolen. External editors need not honor our lock: the final comparison detects edits
  during merge/staging, but cannot eliminate an external write between comparison and rename.
  No claim that the reporter's historical wipe was proven to take this path: the catch-to-empty
  writer and its data loss were reproduced in fixture homes.
- **Fullscreen TUI (Claude)** — through the SAME `settings.json` seam the hook installer uses,
  nodeterm ensures Claude's `"tui": "fullscreen"` so a session takes the alternate screen + mouse
  and behaves natively in tmux (else a drag falls into copy-mode). Two guardrails: **write-if-absent**
  (any existing `tui` value — e.g. a user's `/tui default` — is never touched;
  `core/agents/hooks/claude-tui.ts` `ensureFullscreenTui`) and **version-gated** to CLI ≥ 2.1.89
  (`supportsFullscreenTui` / `claudeCliCaps().fullscreenTui`; unknown ⇒ don't write). Runs
  everywhere the hook seam does: local `~/.claude` + managed account dirs at launch/add-account
  (`ensureClaudeFullscreenTui{,Into}`), and the remote host + account dirs on SSH connect
  (`RemoteHooks.ensureFullscreenTui{,InAccountDir}`, gated on the connection's cached remote probe).
  **Grok has no analogue** — it runs full-screen by default, so there is nothing to write.
- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Selecting, focusing, dwelling into, or opening a session card
  clears `unread` and ACKs the finish across phone/notch surfaces — existing read-on-view behavior.
  This NEVER changes the workflow bucket: read state is independent from agent state.
  The unread COUNT is the macOS Dock badge (counted over nodes some project HOLDS, closed ones
  included — never over the raw status table, which outlives nodes deleted by paths that skip
  `remove`; an orphaned entry is swept at load once its 90-day `lastSeen` clock ages out, and the
  sweep is skipped whenever the load is incomplete, `lib/unreadBadge.ts`), and on **Windows** a
  taskbar overlay icon (pure `planBadge` + BGRA rasterizer `rasterizeBadge`, "9+" above nine,
  `main/taskbar-badge.ts`) plus a `flashFrame` when the count RISES while unfocused (cleared on
  focus); Linux shows nothing. Windows toasts need `app.setAppUserModelId` set before ready to the
  package.json `build.appId` the NSIS shortcut carries (`main/app-identity.ts`, pinned by test;
  `execPath` in dev) — without it toasts are dropped or mis-attributed silently (Windows never
  emits Notification `failed`).
- **Sound alerts + custom sounds** (issue #289) — the `done` / `needsYou` alert (`SfxKind`) is a
  synthesized WebAudio chime (`renderer/lib/sfx.ts`, fired from Canvas's `alert` closure, gated by
  `soundEffects`, 5 s/node cooldown). Settings → Notifications lets the user replace either with their
  own file. The picked file's BYTES (never its path) go to `files.saveAlertSound`, a core handler in
  `registerFsHandlers` (both shells), which validates kind / extension allow-list / 5 MB cap / magic
  bytes and writes ONE format-independent name `<userData>/sounds/<kind>.sound` (`core/alert-sounds.ts`;
  a name per format needed a delete-the-others step, and two tabs saving different formats at once
  deleted each other's file — do not reintroduce per-format names); reads and Reset take only the
  kind (no path from the renderer, symlinks refused). Settings keep only
  `customAlertSounds[kind] = {name, stamp}`. Playback decodes the bytes with `decodeAudioData` — no
  `<audio>`, so CSP `media-src` is untouched on both surfaces — and **any failure (missing file,
  refused read, decode/playback error) falls back to the chime without throwing** (`lib/customSfx.ts`,
  read failures and a missing/closed audio context are retried on the next alert; a DECODE failure
  is cached for that `stamp`, so a new pick is tried afresh). Every `playSfx` caller must pass `customAlertSounds` (source-pinned in
  `customSfx.wiring.test.ts`). Server Edition: full — the browser's `<input type=file>` bytes are
  stored in the SERVER's data dir. Mobile: N/A (own notification sounds).
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
  **The clock survives an app restart as "last seen", never as a state** (`agentStatus.lastSeen`,
  `{at, state}`). `lastEventAt`/`stateAt`/`state` are transient, so before this every row after a
  restart sorted as "no clock" and lost its age. `lastSeen` is the time of the LAST hook event (a
  same-state one included) and the state it asserted, persisted beside the agentStatus record under
  its OWN small key (`nodeterm.agentStatus.lastSeen`) — chosen over the core mirror because the
  sidebar already reads this store,
  the mirror expires state after 6 h and identity later, and reading it would need a new IPC leg for
  a display fact. Rules a refactor must not undo:
  - **Restored as a clock only.** Load fills `lastSeen` and nothing else: `state` stays unknown (the
    hook server was down with the app, so a turn may have started or ended in between), and
    `lastEventAt` stays unset. Load marks the clock `restored` (transient, never written); the row
    reads `lastEventAt ?? lastSeen.at` and its `statusClock` is `transition` / `seen` (a hook event
    this run but no transition yet) / `restored`. Only `restored` says "before nodeterm restarted"
    (`seen 3h ago`, tooltip naming the state it was last seen in). **The first event after a restart
    is usually a SAME-state one** (a cold-restore `--resume` fires SessionStart = `state: undefined`
    on an entry whose state is already unknown), so the store's in-place fast path must not take it:
    it replaces the entry (the row loses `restored` and re-sorts at once) without stamping
    `lastEventAt` (an unknown state is not an idle clock).
  - **Eco never reads it** (so `idleKnown` and `planHibernation` are unchanged). Even a proven-idle
    prompt after boot would not be enough: the background-task stamp and the subagent cards Eco
    also needs are transient and cannot be rebuilt after a restart, and `/exit` kills both
    silently. A session becomes a candidate again from its next live `done`.
  - **Bulk pause is the ONE reader that acts on it** (`idleForPause`, `lib/bulkPause.ts`): an
    unknown-state session is pausable only when `lastSeen.state === 'done'`. The difference from Eco
    is consent and proof, not the clock: a person confirmed the pause, the runner still proves the
    agent owns its pane before typing, and without it every session after a restart would be
    unpausable exactly when memory is tightest. The residual is stated there: a session last seen
    idle that started a turn while the app was closed (cron, loop, task notification) can be
    interrupted. Nothing automatic may read it.
  - **Its own key, so the main table's write cadence is unchanged.** State events still write
    nothing to `nodeterm.agentStatus`. That matters twice: the main table carries `loop.items` (up to
    100 × 4000 chars per loop node — 428 KB and ~2.1 ms per stringify with one full loop, measured in
    review), and on the Server Edition every tab rewrites its whole in-memory table, so a periodic
    rewrite would let tab B undo tab A's `clearUnread`/`hibernated` within seconds. A first version
    stored the clock inside that table on a 2 s THROTTLE and rewrote it every 2 s while any agent
    worked. The clock key is saved on a real TRAILING debounce (5 s quiet, `LAST_SEEN_SAVE_MAX_WAIT_MS`
    30 s at most while never quiet) plus `pagehide`: 2 Hz hook events for 10 s = ONE write. Measured:
    ~59 bytes per clock, 1000 clocks = 59 KB and 0.7 ms per `JSON.stringify` on this dev host. Two
    Server Edition tabs still race on the CLOCK key (last writer wins), which costs only display.
  - **Bounded.** At most `LAST_SEEN_MAX` (1000) newest clocks are written; a clock older than 90 days
    or more than 5 min in the future is refused on load (hand-editable input — a future stamp would
    pin a row to the top); an unknown `state` keeps the time and drops the state; an unreadable clock
    key costs the clocks, never the table.
  - **It cannot create a row**: rows come from canvas nodes, never from the status table.
    `remove(id)` writes the clock key at once, a pending debounced save included; a deletion path
    that bypasses `remove` (e.g. `reloadActiveProject` dropping nodes) leaves a clock that simply
    ages out. Tests: `state/agentStatus.lastSeen.test.ts`.
  - Surfaces: Desktop full; Server Edition per browser profile (localStorage, like `unread`); relay
    tabs keep a keyless store and persist nothing; kanban has no clock-ordered view, so nothing to
    wire there; Mobile N/A (its own state).
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
    **A poll of an unchanged transcript reads no bytes**: the local read is gated on the resolved
    path's (size, mtime) (`titleCache`, bounded at 500, a failed tail read never cached), and the
    remote one (`main/remote-title-reader.ts`) on the remote context tail's `offsetFor` for the SAME
    path — that offset is the file size at the tail's last read, so a remote `/rename` lands within
    the tail's idle backoff (real gaps between idle reads ≈3/5/9/11 s) PLUS one title poll
    (4–15 s); an untracked session (offset unknown) always reads.
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
  against a fake host tree — keep it that way.
  **A remote node never falls through to this machine** (2026-09-28): the handler decides
  remoteness from the SHELL's records (`isRemoteNode` dep — live remote pty or
  `workspaceStore.sshProjectIdForNode`, never a renderer flag) and applies `remoteOnly` to the
  paged ⌘M read, the legacy read, the find-bar index (`[]`) and `transcriptExists` (`unknown`).
  The host locate is tri-state (`locateRemoteTranscriptRef`): a CLEAN MISS is `found:false`, a
  failure to ask is `unreadable` ("Couldn't read the transcript.") — the phone's `chat.page` shares
  the same deps and the same distinction. Before this, a mounted SSH node whose locate missed (or
  whose master was down) read THIS machine's resolver, cwd-newest fallback included. `transcriptExists` shares the same locate
  (`remotePresenceFromLocate`: ref/absent/unreadable → present/absent/unknown, a malformed id
  `unknown`), so it also works for a node with no live pty. A remote grok node is read on its host
  by its own leg (`readRemoteGrok`, see the grok chat bullet), with the same absent/unreadable split. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Which session id is read is ONE rule, `transcriptSessionFor`** (`renderer/lib/transcriptSession.ts`,
  2026-10): the hook-confirmed `agentStatus.sessionId`, else the id the node was LAUNCHED with
  (`data.agentSessionId` — minted with `--session-id`, or the id "Open recent" resumed). The canvas
  node, the ⌘M hint, the kanban card, the card modal and its viewer all ask it. Before, Chat (and
  the meter) were gated on the hook id alone, so a node whose hook events never reached this app —
  an SSH session pinned for life to a dead hook endpoint, the 107-of-128 case in "A reused
  ControlMaster…" — opened "Markdown view" and showed no meter while its transcript sat on disk
  under an id the node itself had on record; others in the same project opened Chat. The fallback
  is HONEST, because the persisted id can be stale (`/clear` / `/resume` in the CLI moves to
  another session; nothing rewrites `agentSessionId` from hooks): (1) ChatPanel's
  `sessionFallback` prints one quiet line saying so, and the meter's popover says "From the session
  this node was started with"; (2) the read carries **no cwd** (`transcriptReadCwd`), because
  claude's resolver answers a missing id with the newest transcript in the folder — under a
  fallback id that would be a stranger's conversation; the remote locator globs by id without a
  cwd, so SSH nodes are still read on their host; (3) plan/question answer controls are never
  offered on a fallback thread (an answer is a WRITE bound to the live `held` ticket). The composer
  still sends (it types into the pane, which is right whatever the transcript). The persisted id is
  the CREATED agent's, which is exactly the agent both mount sites pick the reader by, and it is
  re-validated against `SAFE_SESSION_ID` (hand-editable project.json). The find bar's transcript
  index still uses the hook id only (it has claude's cwd fallback and no `remoteOnly` here).
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
  **System-injected user records are not the user's words** — a `<task-notification>`, a peer
  `<agent-message>`/`<cross-session-message>`, an auto-continuation/coordinator prompt — so
  `parseChatRecords` (and the find-bar index) renders each as ONE assistant tool part
  (`classifySystemRecord`: "Background task" / "Agent message" / "System", no wire change; each is
  a turn boundary in `assistantTurnEnds`) and fences a human paste's `<pasted_content>` span (the
  CLI's own 4-hex-id grammar only; titles keep the raw text) — all `indexOf` scans, never a
  backtracking regex (quadratic on unclosed tags); exact rules in `src/shared/chat-fixtures/README.md`.
  **An agent team's teammate writing to the lead is one more of these** (`core/chat-teammate.ts`,
  README rule 2b): a user record with NO `origin`, `promptSource` or `isMeta` (measured on CLI
  2.1.285–2.1.316), the "Another Claude session sent a message:" line, one or more
  `<teammate-message teammate_id="…">` elements (a markdown body, or an `idle_notification` JSON
  object) and a fixed trailer. On the wire it is one `Agent message` chip; the desktop's `rich` read
  draws a `teammate` part per element instead, as Claude Code's TUI does: an idle notification is a
  status line ("✓ Teammate @pc-02 finished") with a one-line preview, and consecutive plain
  messages from one teammate fold into one "N messages from @x" row (`nodes/ChatTeammate.tsx`). The
  missing `origin` is the human guard: a person who types or pastes the same text is recorded with
  `origin.kind:"human"` / `promptSource:"typed"` and keeps their bubble.
  **Paged reads (2026-09).** `chat.readTranscript` takes a trailing optional `page`
  (`{before?, maxBytes?}`, `shared/chat-page.ts`). Absent = the legacy 5 MB-tail read, byte for byte
  (result is exactly `{messages, found}`). Present = ONE window of at most `maxBytes` (clamped
  64 KB…5 MB — it is untrusted IPC/WS input; an invalid `before` REJECTS rather than being coerced
  to "end of file") ending at byte `before`, and the result adds `olderCursor` (where the window's
  first complete line starts — the next page's `before`; `null` = reached the start), a per-message
  `key` (the line's ABSOLUTE byte offset — stable across prepends and appends), `id` on tool parts,
  and `unmatchedResults` (tool results whose `tool_use` sits in an OLDER window: the newer page is
  read first, so the renderer holds them until that page arrives). Parsing is the pure
  `parseChatWindow` over BYTES (a multi-byte char cut by the window edge only lands in the dropped
  partial line), and every window is read with **one byte of lookbehind** — the only way to know a
  line begins exactly on the edge; without it that line is dropped as "partial" and lost. A window
  with **no complete line** (one record bigger than the window — in practice a `type:user` line
  carrying a pasted screenshot or an image tool_result; 181 lines over 512 KB in 30 days on one
  host) is flagged `noCompleteLine` and **re-read at the same `before` with ×4 the bytes, up to the 5 MB cap**
  (`parseGrowingWindow` in `core/transcript-ipc.ts` — local AND SSH leg; a failed re-read is
  not-found, never the skip). Only a line **longer than 5 MB** is skipped (`olderCursor = window
  start`, never the window end, which would re-request the identical window forever) — before this,
  every line bigger than the page vanished, a regression against the legacy 5 MB read. The **SSH leg** is a ranged read
  (`transcriptPageCommand`, `core/remote-ssh/transcript-window.ts` — size + window in ONE round
  trip, dd status inside the base64 like the context-tail's window command) instead of pulling the
  5 MB tail on every open and every turn-end reload; its `{ok:false}` is terminal (never the local
  disk), and it is tested under a real `/bin/sh` (`transcript-page.realsh.test.ts`). **Grok does not
  page** (its file is rewritten in place, so offsets are no identity): a paged request gets its whole
  capped read with `olderCursor: null`, no keys, and the newest record's `model`/`effort`.
  Server Edition passes `page` through ws-bridge to the same core handler; relay still refuses.
  **ChatPanel consumes it progressively** (pure state in `renderer/lib/chatPaging.ts`): the first
  read is a 256 KB tail (`CHAT_TAIL_PAGE_BYTES`, with a "Loading conversation…" row), older 512 KB
  pages load when the user scrolls within 200 px of the top (or by themselves while the thread is
  shorter than the viewport — it cannot scroll), one at a time behind their own token, prepended
  with the scroll position ANCHORED on the scrollHeight delta (the loading row's own appearance
  included). A turn-end reload / ↻ re-reads only the tail and **merges by key**, keeping the older
  pages already loaded — unless no rendered message reaches into the new window (the turn wrote
  more than a whole window, so the bytes in between were never read): then it RESETS to the tail
  rather than stitch over a hole. Carried tool results are held until their tool's page arrives and
  dropped at the start of the file. `found:false` on an OLDER page is a failed page load (retry row,
  thread kept), not a missing transcript; a reload that fails to resolve never blanks a rendered
  thread — only a read with nothing on screen says "No transcript found". The remote leg's
  forget-a-located-ref rule lives in `main/remote-transcript-page.ts` (a hook-fed ref is never
  dropped on a failed read, and a hook event re-marks a located ref as hook-fed). Grok: one
  unkeyed read, no older pages, no "Beginning of conversation" marker (a capped read cannot know).
  **Loading surfaces (2026-09).** The lazy ChatPanel chunk suspends into `ChatPanelFallback` at
  ALL THREE mount sites (canvas node, kanban card modal, closed-transcript dialog — it replaced a
  `fallback={null}` that left the ⌘M face blank over the terminal): the panel's own shell plus
  `ChatLoadingStatus`, which ChatPanel's initial "Loading conversation…" row renders too, so the
  handover is identical DOM (a second row swapped rings and re-announced its `role=status`). Its
  spinner is the app's ONE spinner, `components/Spinner` / `.nt-spinner` — frozen, not hidden,
  under `prefers-reduced-motion`; never add a local one. A terminal node's label row ends in a
  quiet ⌘M hint (`lib/mdViewHint.ts`, id `md-hint`, hideable in Settings → Appearance) naming the
  EFFECTIVE chord and what it opens on that node; it sits in a zero-basis trailing slot that
  clips, so it can never add a line to the row (a height flip would refit xterm and SIGWINCH
  tmux). It is not on the kanban card modal: that header already carries the ⌘M toggle.
  **The composer sends only in `done` or an unknown state** (`canSendFromChat`,
  `renderer/lib/chatSendGate.ts`), with ONE exception: `working` for an agent in
  `INPUT_QUEUE_CAPABLE` (claude — measured: a prompt submitted mid-turn waits in Claude Code's own
  queue and reaches the model at the next tool boundary), where Enter QUEUES (`chatSendMode`) and
  the bubble reads "Queued" until the transcript has it. Only a plain prompt queues (`canQueue`):
  a slash command or `!` line mid-turn is unmeasured and waits. While the agent works the textarea
  stays editable for every agent (`composerStandsDown`) — only sending is gated. Never in
  `waiting`/`blocked`:
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
  **A chat prompt is TYPED for claude, never pasted** (`core/typed-input.ts`, `TYPED_INPUT_CAPABLE`).
  Claude Code records a multi-line paste as `<pasted_content>`, which its model is told may not be
  the user's words; typed text (lines joined by tmux's `M-Enter`, measured on 2.1.281) is recorded
  as plain user text. Three rules: (1) **core decides it from the agent id** inside
  `sendChatPrompt` (`typedFor`), never a renderer-sent flag — every other agent and every other
  `sendText` caller keeps the paste; (2) **every write into a pane is serialized per pane**
  (`PtyManager.serializePaneWrite`, wrapping `sendText` AND `sendEnvelope`): a typed send takes
  seconds (one paste per line, then a settle wait before Enter), and an agent message, a reminder
  or dictation arriving in that window would otherwise land between its lines and be submitted as
  part of it; (3) **the screen is checked again right before the Enter** (`TypedSurface.canSubmit`):
  the dialog check `sendChatPrompt` makes is seconds old by then, and an Enter into a dialog that
  opened meanwhile would ANSWER it — the text stays in the composer and the caller hears
  `pasted-not-submitted`. The panel ignores a second Enter while a send is in flight (the draft is
  cleared only once it lands). **A backslash is never typed right before a line break or the Enter**
  (MEASURED, 2.1.319): the composer reads `\` + Enter and `\` + M-Enter alike as "new line" and eats
  the backslash, so a `!` command's continuation lines ran as separate commands and a message ending
  in `\` was never sent. A line's trailing backslashes are typed after its line break (Left, the
  run, Right; `typedRecords`), and a message ending in one is submitted with Left then Enter
  (`cursorLeftFirst`). **"The text arrived" is read from the COMPOSER, never counted
  across the screen** (`TypedSurface.draftOf` → `readClaudeDraft`, on a styled capture so the dim
  placeholder is not draft text): the draft must end with the message's tail and differ from the
  draft before typing. Typing also clears the placeholder and shortens the status line ("· ← for
  agents" goes away), so a one-letter answer like `a` appeared once more in the box and once less
  elsewhere; the screen-wide count never rose and every such send ended `pasted-not-submitted` with
  the answer sitting in the box. The screen-wide count stays only as the fallback for a poll with
  no readable input box (a draft too tall for the box reader).
  **Esc in the chat view interrupts a running turn** (`lib/chatEscInterrupt.ts`, core
  `PtyManager.interruptChat`, `pty:interrupt-chat`), as Esc in the terminal would. Only when ALL of:
  the agent is in `CHAT_INTERRUPT_CAPABLE` (claude, MEASURED on 2.1.318), the state is `working`
  (idle, two Escs open Claude's rewind picker, which fires no hook; blocked/waiting, Esc cancels the
  dialog), and the composer is EMPTY (with a draft, Esc means "never mind"). Core reads the screen
  first and refuses on a dialog, then sends a lone Esc through `sendPaneKeys`. An Esc before the
  reply's first token makes Claude put the prompt back into its own input box (measured 0.05-0.11 s);
  core takes it back out ONLY when the box holds the chat view's last send, and hands it to the
  composer. It clears the box with Ctrl-U, never Ctrl-C: Ctrl-C clears it too but then arms
  "Press Ctrl-C again to exit" for a few seconds. MEASURED on 2.1.319: one Ctrl-U clears one WRAPPED
  ROW, not a whole line, and the box stops growing at about half the pane's height and scrolls, so a
  long prompt shows only its end. So "holds the last send" accepts that end, each burst is two
  Ctrl-Us per row on screen (`readClaudeDraftBox`) plus spares, and bursts repeat while what is left
  ends earlier in the sent text (`endsEarlierIn`). Claude still writes such a prompt to the
  transcript as a branch it drops from its context; the reader hides it once the re-sent prompt
  is in the same read (`abandonedPromptUuids`: a childless prompt with a later non-tool-result
  sibling under the same `parentUuid`). The panel also makes the terminal's interrupt guess
  (`inferInterruptAfterSettle`), since an early Esc writes no transcript marker.
  **An interrupt is drawn as Claude draws it, not as a user bubble.** Claude saves its marker
  (`CLAUDE_INTERRUPT_MARKERS`, now in `shared/agents/claude-interrupt.ts`, shared with the context
  tail) as a USER record. On the `rich` read the parser turns it into an `interrupt` part on the
  assistant side, drawn as `⎿ Interrupted · What should Claude do instead?`, and a tool call it
  cancelled shows "Interrupted" instead of Claude's canned "The user doesn't want to proceed…"
  result. Without `rich` (the phone's `chat.page`, the golden fixtures) nothing changes; the iOS
  reader owes the same treatment (@eneskirca).
  **The agent's OWN dialogs are read off the screen** (`shared/agents/claude-screen.ts`, claude
  only — `SCREEN_DIALOG_READABLE`). The folder-trust prompt, `/model` and one-time setup questions
  fire NO hook, so the state gate above reads `done` while one owns the keyboard, and a paste into
  it was swallowed while its Enter answered the dialog (the trust prompt's default is "No, exit").
  A send therefore goes through `pty.sendChatPrompt`, where core captures the pane first and
  refuses (`ChatPromptBlocked`, nothing written, the draft kept) when the bottom of the screen is a
  dialog footer or has no input box; an empty or unreadable capture is NOT evidence and sends as
  before. A LOCAL pane is also polled every 2 s while the view is visible AND the window focused
  (an unfocused window skips ticks — ~30 tmux spawns a minute per view otherwise — and `focus`
  re-reads at once; unknown focus polls), to disable the composer and show the dialog's lines; SSH and relay panes are not polled (a round trip per read) and rely
  on the send-time check. Another CLI's layout would read as a permanent dialog, so an agent joins
  the list only with its own measured reader.
  The live box must end within `BOX_TAIL_LINES` (8) non-blank lines of the bottom, so an old box in
  the history is not taken for it; the agent list Claude Code draws under its status lines while
  background agents or teammates run (`● main`, `○ <name> …` rows, `↓ N more`; measured on 2.1.319)
  does not count toward those lines (`isAgentListLine`). Before that, five agents were enough for the
  view to say the input box was not on screen.
  **Claude's suggested next prompt is the composer's placeholder** (`readClaudeSuggestion`,
  `pty.readChatScreen`). A few seconds after a turn ends, and only when there is an obvious next
  step, Claude draws a suggestion as plain DIM text on its prompt line (MEASURED on 2.1.318); → in
  its TUI accepts it, and → in an EMPTY composer does the same here: it fills the draft with the
  caret at the end, and nothing is sent. The poll now makes ONE styled read for both the dialog
  check and the suggestion (a styled capture is the only way to tell dim text from a draft; a pane
  with no styled capture still gets the dialog check from the plain one). Two other dim texts sit
  in the same place and are refused: the fresh-session tips (always `Try "…"`) and `Press up to
  edit queued messages`. Shown only while a message could be sent and no dialog is on screen;
  cleared on every state change and on send. Claude draws it 1.1-2.2 s after the turn ends
  (measured, 5 turns), and the 2 s poll added up to 2 s more, which read as a lag; so after a turn
  ends a local pane is read every 300 ms for up to 5 s, stopping at the first suggestion
  (`SUGGESTION_BURST_MS`, at most ~15 extra reads per turn). An SSH node is never polled, so it is
  read twice after each turn (`REMOTE_SUGGESTION_READ_DELAYS_MS`, 2.5 s and 6 s); relay tabs offer
  none.
  **Live progress (2026-09).** While the agent works, a `role=status` row closes the thread (the ONE
  spinner + the placeholder's own "<agent> is working…"/"waiting for an answer" sentence; optimistic
  right after a send, bounded by `CHAT_OPTIMISTIC_WORKING_MS`), and every hook event re-reads the
  tail — throttled (`CHAT_LIVE_RELOAD_MIN_MS`, trailing read guaranteed), single-flight, never for a
  hidden panel or document (`lib/chatLive.ts`). The trigger is `agentStatus.onHookEvent`, NOT a
  `stateAt` selector: same-state events refresh `stateAt` in place and notify no zustand subscriber.
  A live read passes `applyTail(…, {carryUnconfirmed})`, which keeps the trailing unkeyed optimistic
  send until the tail holds a matching user line (the send's own UserPromptSubmit read races the
  transcript write); it never resets a failed older page or flips an empty state to "Loading…".
  Gap: the panel reads the DEFAULT agent-status store, the only one Canvas's hook listener writes, so
  a relay tab gets neither the row nor live reads until relay status is routed per session.
  **Plan and question bodies (2026-09).** A tool call is normally a collapsed chip (`name` + a
  ≤200-char `arg`), which left an `ExitPlanMode` plan — the full markdown the terminal shows as
  "Here is Claude's plan" — and an `AskUserQuestion` question + options unreadable in ⌘M, the one
  place meant for reading them. `core/chat-tool-body.ts` (pure) fills the tool part's optional
  `body` for exactly those two tools (`input.plan`; the questions rendered as markdown), capped at
  64K characters (never splitting an open code fence or a surrogate pair; model-authored labels are
  kept to one line with emphasis escaped), degrading to no body (the old chip) on any other shape;
  ChatPanel shows a part with a body as an expanded "Plan"/"Question" card through `MarkdownText` with its result under it, and
  the find-bar index (`linesFrom`) indexes the body in full like assistant text.
  **Answer controls on those cards (2026-09).** Only the card the node's `held` ticket belongs to gets
  controls (`lib/chatAnswer.ts` `activeAnswerCard`: newest unanswered card of the held tool; a question
  also needs identical question texts — `held.questions` and the card's `questions` come from the ONE
  `readQuestions`), and only while the pane is in a dialog state. They send a `PermissionAnswer`
  through `answerPermission`; a refusal is a quiet retryable error pointing at the terminal. Plan's
  default button is `restore` — never auto. See docs/hook-reply-approvals.md.
  **A card answers only the request the THREAD was read for** (`answerCardState`, same rule as
  iOS #41): `threadHeldFor` = the held ticket at the START of the last applied tail read, keyed by
  transcript identity. While held moves A → B (a revised plan) plan A's card can still be on screen
  unanswered, and a tool-name match would approve B from it — so until a read started under B lands,
  the latest unanswered card of that tool says "Updating… — or answer in the terminal" and nothing
  is answerable. A held change forces a tail reload (queued behind a read in flight, which started
  under A and cannot bind B, and behind an older-page fetch, which it never cancels). It is a QUIET
  read (no "Loading…"), and one path owns it: on working → blocked the turn-end reload does. While a
  request is unbound it retries with backoff (`rebindRetryDelay`: 2 s doubling to 30 s, reset per
  request) — card on screen or not; it stops once B surfaces on a new card (a duplicate ticket for the same tool_use keeps a quiet 30 s retry while the agent stays blocked). A read under B that still shows the card A was bound to (same tool id / line offset —
  the transcript can lag the hook) stays "Updating…": B must surface on a card the thread shows as
  new. The answer payload carries the BOUND id, re-checked against store and binding at send time.
  Residuals: the previous-card memory is per MOUNT (a panel opened fresh under B has none, so it
  binds B to the latest matching card); a re-issued ticket for the SAME tool_use (duplicate hooks)
  stays "Updating…" and is answered in the terminal; and the whole guarantee assumes Claude writes
  the tool_use to the transcript before the hook fires.
  **The thread look (2026-09-26, claude.ai-style)**: the user's message is a neutral rounded bubble
  on the right (`term-chat__bubble`, a tint lift — never the blue accent), the assistant's is plain
  full-width text with no bubble. One quiet action row per assistant TURN (`lib/chatThread.ts`
  `assistantTurnEnds` — a turn is a run of consecutive assistant lines, so a tool-heavy turn gets one
  row, not one per tool call), hidden until hover/focus and always shown on the latest turn: Copy (the
  turn's TEXT parts as markdown source, through `window.nodeTerminal.clipboard` — the app channel,
  which never rejects and bridges to execCommand in the browser) and a relative time from the new
  optional `ChatMessage.at` (epoch ms from claude's ISO `timestamp`, set by the core parser on BOTH
  the legacy and paged paths; absent when the line states none — never a made-up time). One
  60-second `now` tick in ChatPanel drives every row's label. No thumbs / read-aloud / retry (no
  terminal equivalent). `.term-chat__text` stays the markdown sink the link guard scopes to.
  **Every code block has the same Copy control in its top-right corner** (`nodes/CodeBlockCopy.tsx`;
  ONE button component, `ChatCopyButton`, shared with the per-turn Copy so the two cannot drift).
  The Markdown is an HTML string, so after each new string the hook wraps every `<pre>` in a
  positioned `.term-chat__code` (never inside the `<pre>`: it scrolls sideways and would carry the
  button) and portals the button beside it. It copies the block's `<code>` text minus marked's one
  trailing newline (`lib/codeBlockCopy.ts`) — a pasted command must not run on paste. Hover-revealed,
  kept visible while it says "Copied". Chat messages, thinking and plan/question cards all render
  through `MarkdownText`, so all get it; the ⌘M output view and the editor preview do not.
  **The composer (2026-09-26, claude.ai-style)** is one rounded box — textarea on top, a toolbar
  under it: "+" attach on the left; model label, muted effort label and a mic on the right (pure
  decisions in `lib/chatComposer.ts`). Four rules: (1) **attach = paths in the DRAFT, resolved the
  way a drop onto that node's terminal is** — the mount site passes `pathsForFiles` built on
  `droppedPaths` with the node's own SSH scope (`dropProjectId` in TerminalNode; `spawn.ssh` in the
  card modal), so an SSH node's file is uploaded to its HOST and the composer never grows a second
  resolver; "+" / drop / file-or-screenshot paste all feed it, and nothing is ever sent. (2) **The
  mic targets THIS composer's textarea, never the pane**: `nodeterm:dictate` carries a per-MOUNT
  `composerId` (the canvas node and the card modal can both mount one session's composer),
  `DictationTarget` gained `kind: 'chat-composer'`, and the overlay hands the take over
  `nodeterm:chat-dictation` (`lib/chatComposerDictation.ts`), saying so if the composer closed
  mid-take. (3) **The labels read the ContextMeter's store** (`useContextUsage` — ONE reader) and
  a click TYPES the agent's own picker command (`/model`, `/effort`) through the SAME
  `chatSendRefusal` gate as a message, re-read at click time, then flips to the terminal
  (`onShowTerminal`); `sendText` must answer `=== true` to flip. Measured for claude only
  (`composerPickerCommand`, via `capabilityAgentId`): any other agent shows no label, since a label
  that opens nothing is a lie. Hidden when the model is unknown; effort hidden with it. (4) **Effort
  was measured, not assumed** (Claude Code 2.1.283): read = the top-level `effort` the CLI writes on
  every assistant record it sent with one (`...E!==void 0&&{effort:E}`; its own history reader
  walks the same field; a transcript flips `medium`→`xhigh` on the first request after `/effort`);
  change = `/effort` (a `local-jsx` picker, levels `low|medium|high|xhigh|max`). `parseLatestUsage`
  takes it from the LATEST usage record only — never carried forward, a record without it means
  that model takes no effort — and both context tails push on an effort-only change
  (`ContextWindowUsage.effort`, optional: older hosts and other agents simply omit it). Like the
  model, it lags until the next request. Narrow composers drop effort first, then the model
  (`composerToolbarLayout`); "+" and the mic stay. No voice-conversation button: there is no
  terminal equivalent. Surfaces: Desktop + Server Edition identical (dictation and uploads already
  bridge — `files.saveUpload`, `speech.*`); SSH nodes upload to the host; kanban card modal shares
  ChatPanel and wires both props; relay tabs keep the panel's existing refusal; mobile N/A.
  **Its height** (`lib/chatComposerHeight.ts`): the textarea grows with the draft until the whole
  composer fills half the INNER space (top of `.term-chat__thread` to the bottom of the composer,
  never the whole panel), or keeps the height the user dragged the grip on its top edge to
  (localStorage, one value for every composer; double-click / Enter on the grip = auto again). The
  `/` and `@` menu takes at most 240px, half the inner space and the room above the composer
  (`completeMenuMax` → `--chat-complete-max`), so a tall box cannot push it under the panel header.
  Heights are layout pixels: a drag divides by the canvas zoom.
  **The draft is not component state** (`state/chatDraft.ts`): ChatPanel unmounts on every project
  switch, and a `useState` draft was lost with it. It is keyed by node id (the canvas node and the
  card modal share one draft) and persisted to localStorage (`nodeterm.chatDrafts`, machine-local),
  so it survives a reload and a restart as the TUI's own input box does in tmux. Writes are
  debounced, flushed on pagehide, and merge only this window's changes into the stored map (two
  Server Edition tabs); bounded by age (30 days), count (50) and size (32,000 chars stays in memory
  only). Pruned by age, not node existence: a closed project still holds its nodes.
  **Shell mode is drawn as Claude Code's TUI draws it** (`lib/chatShellMode.ts`, claude and custom
  agents built on it; MEASURED on 2.1.319): a draft starting with `!` — typed into an empty box or at
  the start of existing text, the TUI's rule — shows its `!` in `--sys-pink` beside the textarea, not
  in it, with a pink border and the TUI's own "! for shell mode" under the box; Backspace at the very
  start leaves it. The DRAFT keeps the `!` (it is what the send types and what puts the TUI in shell
  mode); only the display changes, and the completion/highlight stand down (the caret snapshot holds
  the shown text, not the draft). The `!` slot is always rendered so the textarea is never remounted.
  A `!` command in the THREAD (`nodes/ChatShellCommand.tsx`) is the TUI's `! cmd` with its output's
  first line under a `⎿`, opening to the whole output: the reader keeps a bash-family output's lines
  (`BASH_OUTPUT_MAX`, 16384) instead of `summarizeResult`, and gives a command that printed nothing
  `result: ""` (chat-fixtures README rules 4-5).
  **A draft carries across the user's own ⌘M flip** (`lib/chatDraftCarry.ts`, claude only; core
  `putChatDraft` / `takeChatDraft`). It MOVES, never copies, so it is never sent twice: chat → terminal
  types it unsent (`sendTyped`, `submit: false`) into an EMPTY input box only; terminal → chat takes
  only what `readClaudeDraftLine` can read back exactly (one row, the `❯` prompt, no `[Pasted text…]`
  placeholder — MEASURED on 2.1.319: a wrap and an M-Enter newline draw the same, and the wrap drops
  the space at the break), clears it with Ctrl-E Ctrl-U (Ctrl-U alone keeps what is right of a moved
  cursor), and hands it over only once the box reads empty. Anything else stays put and is named
  (a note under the chat box, or a toast). Only the chord and the header toggle carry; the composer's
  own flips (`onShowTerminal`: a `/model` label, an interactive built-in) never do, a picker having
  just opened there (`chat-draft-carry-wiring.test.ts`).
  Fix-round rules (same day): the composer is its OWN component (`nodes/ChatComposer.tsx`) so the
  thread and the composer restyle independently. A label click is an explicit "go to the
  terminal", so the flip FOCUSES the xterm whatever its entry state was
  (`requestTerminalFocusOnExit(nodeId)` before the state change, consumed once by the node's
  `useMdModeFocus` — TerminalNode and ModalTerminal both key it by node id). `/model` and `/effort`
  open LOCAL pickers that fire NO hook, so the gate still reads `done` while one is on screen: the
  composer holds a picker command in flight (ref + disabled/`aria-disabled` labels, and Enter is
  swallowed) from click until the flip or failure — a second click would otherwise paste
  `/model` + Enter INTO the picker, confirming its highlighted row. **Inherent limitation:**
  returning to ⌘M while a picker is still open reads `done` too, so a chat send or a label click
  there would type into it — the pane is not observable from here. Shortcut dictation (keyed chord
  and hold-to-talk) targets the composer holding the caret before the selected terminal (the pane
  under the view is hidden) via `composerFromElement`; the dispatcher offers keyed dictation in
  that one text field (`isChatComposerTarget`). Both are keyed on the composer BOX
  (`[data-chat-composer-id]`), never on the textarea's `term-chat__input` class — the plan
  "Revise…" textarea and the question "Other" input share that class and sit outside the box. With
  focus anywhere else inside `.term-chat` (those fields, the answer buttons) BOTH shortcut paths
  refuse (`shortcutDictationFocus` → `refuse`): their fallback, the selected terminal, is the hidden
  pane showing the very plan/question dialog, and typed characters landing there would move its
  highlight or fill its "Other" field (the overlay types with `enter: false`, so nothing submits).
  **Every mic that names only a NODE** — the terminal header mic, the card modal's header mic, the
  Dock mic and the shortcut fallback (selected terminal / open card) — goes through
  `dictationTargetForNode`: while that node's chat view is up (`.term-chat[data-chat-node-id]`) the
  take goes to its mounted composer (the card modal's own when the modal is open for that node, so
  a modal showing the LIVE terminal still targets it), a chat view with no composer refuses, and
  otherwise it is the terminal as before. Every refusal says so in one `nodeterm:toast`
  (`announceChatDictationRefusal`, naming the composer mic) instead of a silent dead key.
- **The composer completes `/` and `@` (2026-09-30).** Typing `/` at the START of the message (after
  optional whitespace) opens a menu of the node's CATALOG, and so does a `/` after whitespace anywhere
  in the message once a character follows it (2026-11-05, matching Claude Code 2.1.318's TUI, which
  opens its menu there too: `please use /tid`; never inside a word or path, `src/tid`). Mid-message a
  `/name` is text the model reads (a skill it may use), not a command the CLI runs, so the
  interactive-built-in flip (`isInteractiveBuiltin`) still looks at the start only. `@` at the start
  of a word opens the node's files. **A known `/command` is colored, as the TUI colors it**
  (`lib/chatComposerHighlight.ts`): a textarea cannot color part of its text, so while the draft holds
  one the textarea's text goes transparent and a layer behind it draws the same text (same box, font,
  padding and wrap; nothing that changes a glyph's width), and spell checking is off for that draft
  (a textarea checks all of its text or none). A draft with no known command renders as before. Arrows move, Enter/Tab ACCEPT,
  Esc closes the menu only (CardModal's capture-phase Esc already stands aside inside
  `.term-chat__compose`). **Accepting only inserts text** (`/name ` / `@path `): nothing is typed into
  the pane, and the send is still the composer's own gated Enter (`chatSendRefusal`) — completing
  `/clear` then pressing Enter is exactly typing it. **Enter accepts only when accepting CHANGES the
  draft**: a fully typed `/model` with the menu still open is a message and Enter sends it (the
  first version swallowed it, and `ChatPanel.live.test.tsx` caught the regression). Pure decisions in
  `renderer/lib/chatComposerComplete.ts`; the wire shape, sanitizer, measured tables and ranking in
  `@shared/chat-catalog`; the builder in `core/chat-catalog.ts` behind `chat:catalog`
  (`registerChatCatalogIpc`, registered by BOTH shells). Rules a refactor must not undo:
  - **Built-ins are only what was MEASURED** (2026-09-30), by typing `/` in each TUI inside a private
    tmux server and paging the whole menu: claude 2.1.285, codex 0.156.1, opencode 1.18.25, gemini
    0.62.0 (throwaway HOME + a dummy API key — the menu is client-side). **grok has no table**: 1.0.44
    would not start past its browser sign-in on the measuring host, and a list copied from docs is a
    guess about the binary the user runs. Plan-, login- and experiment-gated entries are left out.
    Any other agent (grok, copilot, antigravity, a custom agent with no base) gets `@` only; a custom
    agent inherits its base's table through `capabilityAgentId`. The descriptions are our own words.
  - **A built-in that opens a DIALOG in the TUI is `interactive`, and sending one flips to the
    terminal.** `/model`, `/rewind`, `/resume`, `/config`, `/permissions`, … open a picker the ⌘M view
    cannot see while the state still reads `done` — the next message's Enter would ANSWER it (confirm
    the highlighted row), the hazard the toolbar labels already guard. So every built-in is tagged
    `interactive` EXCEPT a per-agent `SAFE` set of measured no-dialog commands (claude
    `clear compact init recap reload-skills security-review`, codex `clear compact init new recap`,
    gemini `clear compress init`, opencode `new`) — unknown means dialog, because over-tagging costs a
    flip and under-tagging costs a wrong answer. `ChatPanel.send` calls `onShowTerminal` after a send
    confirmed `=== true` whose text `isInteractiveBuiltin` (menu-completed OR typed by hand, with or
    without arguments); a composer with no `onShowTerminal` does not offer those entries at all. The
    phone gets the tag in its catalog and owes the same rule.
  - **Custom commands and skills: claude and gemini only**, at the measured locations. claude:
    `<configDir>/commands/**/*.md` + `<cwd>/.claude/commands/**/*.md` (measured: a subfolder is a
    `dir:name` namespace; description = frontmatter `description`, else the first body line; a
    `SKILL.md` inside a commands folder names its FOLDER, `review/SKILL.md` → `review`, per the 2.1.285
    loader) and
    `<configDir>/skills/*/SKILL.md` + `<cwd>/.claude/skills/*/SKILL.md` (measured: the frontmatter
    `name` WINS over the folder name, the folder is the fallback, `user-invocable: false` is not
    offered). `<configDir>` is the bound account's dir (`claudeConfigDirFor`, linked accounts
    included), which REPLACES `~/.claude` — never both, and a malformed account id yields NO user
    root, never the system dir in its place (another identity's commands). gemini:
    `~/.gemini/commands/**/*.toml` + `<cwd>/.gemini/commands/**/*.toml` (its shipped
    custom-commands reference). Precedence project > user > built-in, deduped by name. Other agents'
    custom locations were not measured, so they list none — a guessed location offers commands the
    CLI does not have.
  - **Plugins, synced skills and `skillOverrides` (claude, LOCAL nodes; `claudeLocalExtras`)**,
    measured 2026-11-05 against Claude Code 2.1.318's own `/` menu with test settings passed by
    `--settings`. A plugin lists `/<plugin>:<skill>` and `/<plugin>:<command>` only when it is in
    `<configDir>/plugins/installed_plugins.json` AND `enabledPlugins["<plugin>@<marketplace>"]` is
    `true` (user < project < local settings); a plugin only in the cache, a disabled one, or a
    `project`/`local` install for another folder lists nothing. Files come from the install's
    `installPath` (older cached versions are ignored), the plugin manifest's `skills` / `commands`
    paths when it names them (a listed folder holding a SKILL.md is one skill), never a path outside
    the plugin. claude.ai-synced skills (`<configDir>/skills/synced/<bucket>/<name>/SKILL.md`) list
    as `/<name>`. `skillOverrides: "off"` hides a user, project or synced skill (`"<name>"`, and for a
    synced one `"anthropic-skills:<name>"`); `name-only` and `user-invocable-only` keep it; nothing
    hides a PLUGIN's skill that way (measured). Note that Claude Code's `/skills` menu writes to the
    folder's `.claude/settings.local.json`, so an "off" there applies to that folder only. **SSH nodes
    do not get any of this yet** (the remote leg reads the base roots only): a follow-up needs the
    host's settings and `installed_plugins.json`, i.e. a second round trip.
  - **A PROJECT root follows no symlink, at any level** (`CatalogRoot.within`). A cloned repository's
    `.claude/commands/notes.md -> ~/.git-credentials` otherwise put the token-bearing first line in
    the menu and in the phone's catalog (reproduced in review, both legs). Locally entries are
    lstat'ed and files opened `O_NOFOLLOW`; remotely `find -P` and `[ -L ]` on the skill folder and
    its SKILL.md; and the root itself must resolve inside the cwd (realpath / `pwd -P`), so a
    `.claude` linked out of the project lists nothing. USER roots (the person's own config dir) are
    followed — that is how shared system skills reach an account dir.
  - **Names and descriptions are hostile data** (a project's `.claude/commands` is whatever the
    repository holds): a name passes `catalogName` (closed alphabet `[A-Za-z0-9][A-Za-z0-9._:-]*`,
    ≤ 64, never trimmed) or the entry is dropped; a description is one line with C0/C1 and `\p{Cf}`
    (bidi, zero-width) removed, capped at 160 code points. The renderer re-runs
    `sanitizeChatCatalog` on every reply and renders both as text nodes. `@` never offers a path with
    whitespace, a control or format character, or one failing `isSafeQuickOpenRelPath`.
  - **The menu is DERIVED from the draft plus a caret snapshot taken for that exact draft**
    (`caretSnap.value === value`), never kept as its own state. A draft changed outside the textarea
    — ChatPanel clearing it after the async send, dictation, an attach — invalidates the snapshot and
    closes the menu (reproduced in review: send `/compact`, the Enter's keyup re-armed the menu from the
    old text, and Tab then turned the emptied draft back into `/compact `). A disabled composer derives
    nothing. A bare `@` is not a choice: Enter sends `hello @`, Tab still accepts.
  - **Cost: nothing is polled.** A composer asks on its first `/` (or `@`) and reuses the answer for
    `CATALOG_REUSE_MS` (30 s). Core caches every directory listing by the directory's mtime and
    every file head (first 4 KB) by (mtime, size), so an unchanged tree costs stats, no reads. Per
    root at most 200 files, commands 3 levels deep.
  - **`@` is the existing quick-open index**, not a new walker: `files.quickOpen(cwd)` on the
    session's api (this machine, or a relay peer's core) or `sshFs.quickOpen(scope, cwd)` for an SSH
    node — gitignore-aware, capped, traversal-guarded — rooted at the node's cwd, ranked by the
    quick-open fuzzy ranker. The SSH scope is the one the composer's attach already uploads through
    (`nodeUploadScope`), passed as ChatPanel's `sshProjectId` from both mount sites.
  - **An SSH node's catalog is read on its HOST, in ONE round trip** (`remoteCatalogCommand`, run over
    the node's master by the desktop's `runRemote`; tested under a real `/bin/sh` against a fake host
    tree). A remote node whose host cannot be asked — or a shell with no remote leg — answers
    built-ins + `partial`, never this machine's folders. Every file's bytes pass `tr -d '\036'`, so a
    hostile file cannot forge a record boundary. Remoteness is the shell's own record
    (`isRemoteTranscriptNode`), never an argument.
  - **Surfaces.** Desktop full (local + SSH). Server Edition full, local only (real ws-bridge
    `chat.catalog`; it runs on the host it reads). Relay tabs: `chat.catalog` REJECTS (stub) and the
    composer offers the shared built-in table alone; `@` uses the peer's own quick-open index, which
    is the right machine. Kanban card modal: the same ChatPanel/composer. **Mobile**: `chat.status`
    carries the same catalog as an OPTIONAL field when the phone sends `catalog: true`
    (docs/mobile-chat-view.md); an older phone never asks. It is bounded
    (`HOST_CHAT_CATALOG_TIMEOUT_MS`, 4 s, then the status goes out WITHOUT it — `chat.status` is the
    relay's status poll and must never wait on an ssh round trip to a half-dead master), and a client
    asks once per composer open, not on every poll. The Server Edition names an SSH-project node
    remote (`workspaceStore.sshProjectIdForNode`), so it answers built-ins + `partial` there instead of
    reading the server's own `~/.claude`. Adopting it in nodeterm mobile is an iOS
    follow-up.
- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events drive a transient `state/agentNodes.ts` store. For Claude they come from
  **Claude's own `SubagentStart`/`SubagentStop` hooks** whenever a session sends them (2026-09,
  see **Claude's native subagent hooks** below); the older reconstruction — `PreToolUse`/
  `PostToolUse` on tool `Agent`/`Task` correlated by `tool_use_id`, whose PostToolUse on an async
  launch is only an ack (`status:'async_launched'`), with the real end sniffed from the
  `<task-notification>` queued into the parent transcript (context tails → synthetic
  `subagent-end` in both shells) — is kept as the FALLBACK and as the source of the task label.
  Neither the notification's `UserPromptSubmit` nor the `[Subagent hand-back]` one is a `newTurn`,
  so neither clears the fan-out. Canvas renders each subagent
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
  live launch event; a running subagent emits no second one) — the card was gone for the rest of
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
  `core/subagent-tail.ts` tails the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl` — for a native card at the path DERIVED from the
  parent's transcript and the `agent_id`, `claudeSubagentTranscriptPath`; for a tool-path card
  matched by `tool_use_id` via the sibling `.meta.json`), read-only, formats each line (assistant
  text + tool calls + results), and streams chunks over `agent:subagent-activity` into the store.
  **Claude's native subagent hooks** (2026-09; `CLAUDE_HOOK_EVENTS` subscribes `SubagentStart` +
  `SubagentStop` for every installer — local, managed account dirs, SSH host). MEASURED on Claude
  Code **2.1.284** in a throwaway `CLAUDE_CONFIG_DIR` (nine scenarios, print mode and the
  interactive TUI; fixture `src/shared/agents/__fixtures__/claude/subagent-hook-payloads.json`,
  pinned by `normalize.claude.subagent-capture.test.ts`); the published npm bundles date them:
  `SubagentStop` gained `agent_id` + `agent_transcript_path` in **2.0.42**, `SubagentStart` first
  ships in **2.0.43**. Facts a refactor must not lose:
  **(1)** both events carry the PARENT's `session_id` and `transcript_path` (unlike grok, whose
  stop carries the child's), and `agent_id` (`a` + 16 hex, validated as a token by
  `isClaudeAgentId` because it becomes a card key and a file name) is the one id they share. The
  start names the child ONLY by `agent_id` + `agent_type` — no `tool_use_id`, no task text; the
  stop adds `last_assistant_message` + `agent_transcript_path`. **(2)** `SubagentStop` is the end
  of the child's TURN and arrives before the `<task-notification>`, sync or async — but a
  background child that stops while its OWN child still runs is **resumed under the same
  `agent_id`** (a second start, then a second stop): a native stop does not always mean
  "finished". **(3)** Claude fires `SubagentStop` for **internal side-agents** (prompt
  suggestions — after nearly every interactive turn) with `agent_type: ""` and **no start**. **(4)**
  a **killed** child (interrupt) fires **no** stop. **(5)** nested children fire both events
  through the same subscription and connect flat to the owning node; the tool path never saw them
  (their `PreToolUse` carries `agent_id` and is filtered), so native hooks are the first time a
  nested subagent gets a card at all. **(6)** `Stop` (and `SubagentStop`) carry
  `background_tasks` — every running BACKGROUND task of the session (async subagents incl.
  nested ones, background shells), never a foreground subagent; on `SubagentStop` the finishing
  child still lists itself, so only the parent `Stop`'s copy is read (`liveBackgroundTaskIds`,
  closed set of finished statuses, anything else counts as running). Absent through 2.1.112,
  present by 2.1.266 (not bisected — feature-detected per payload). **(7)** in interactive auto
  mode every `PreToolUse(Agent)` of a message fires FIRST, then the children start within 5 ms of
  each other (the permission classifier sits between; 20 ms gap in print mode, up to ~5 s
  interactive), each followed ~1 ms later by its async ack whose `tool_response.agentId` names the
  exact child. **(8)** the child's `SubagentHandback` tool injects `<agent-message from="…">
  [Subagent hand-back] …` into the parent before the task-notification — not a genuine turn
  (`isInjectedSubagentPrompt`, matched on the whole marker).
  **How the two paths coexist** — ONE core module, `core/claude-subagent-lifecycle.ts`, fed every
  normalized event (and the task-notification end) by BOTH shells before any consumer; events it
  does not act on come back as the same object. Latch per node+session on the first native
  start: before it a tool call draws its card immediately (an old CLI, or a session whose hook
  snapshot predates the upgrade, is byte-for-byte the old stream — pinned over the fixtures with
  the native events stripped); after it a tool call is only a pending LABEL and the card appears
  at the child's own `SubagentStart` (so a denied tool call draws nothing). The session's first
  child is drawn from its tool call and then REPLACED by its native card (`supersedes` — the
  renderer store, the host replay and the notch HUD move the card; nothing can know at the tool
  call that a native start is coming). Native cards are keyed by `agent_id`, so start/stop/resume
  follow the CLI exactly; only the label is paired, first-in-first-out by type, corrected exactly
  by the ack (also when the ack overtakes its start — and a call an ack already named is never
  handed to another child), and for a SYNC child by its end (`tool_response.agentId`), which
  takes its call out of the queue and relabels a still-running sibling that guessed it. Every
  turn-end `Stop`/`StopFailure` (never the `idle` rescue — an Agent call may be waiting on a
  permission prompt) clears the queue of calls whose child never started, with or WITHOUT an
  inventory: 2.0.43 had native hooks long before `background_tasks`, and a denied call's label
  must not go to the next child. A native stop for an id that never started is dropped
  (side-agents); a later start of a known id re-opens its card; the parent `Stop` inventory, when
  present, ends a native card it no longer lists (the killed child); a tool card whose child
  never started is ended at the turn end; a replaced tool card also gets a plain end AFTER the
  replacing start (for a consumer too old for `supersedes`); tool-path ends are re-keyed onto the
  native card (idempotent, and they bring the sync stats the native stop lacks — a late
  stats-bearing `finish()` fills them on a done card). Tails: the native start begins the child's tail in the RAW listener, which must run
  BEFORE the `ignoreQuestionHook` child-event gate (it ignores every `agent_id`-tagged payload);
  the lifecycle's `onRelease` ends it (local + remote); a resumed child continues from its
  remembered offset (`subagent-tail` / `remote-subagent-tail`) instead of re-streaming; a remote
  child is tailed at its derived host path with no `.meta.json` ssh polling. **Eco**: because a
  native stop can be a pause (fact 2), the parent `Stop`'s non-empty inventory stamps
  `backgroundTaskAt` (Canvas), the guard Eco and the bulk restart already read — a strictly safer
  rule than before (it also covers a background shell a subagent launched). Both shells pinned by
  `hook-verified-parity.test.ts`; the Server Edition also behaviorally over the fixture
  (`server/agent-status.test.ts`). Cost: one extra managed-hook process + POST per interactive turn
  (the side-agent stop). Residuals, stated: a SYNC child has no ack, so while it runs a reordered
  same-type burst can show a sibling's LABEL (never lifecycle) until the first of them ends; a
  killed child with no later parent `Stop` inventory still waits for the decay. **Device checklist** (not runnable
  here): (a) macOS + Windows canvas, interactive: cards at start, right labels, live activity,
  done at stop, nested card, resumed card re-opens; (b) SSH node: native tail over the
  ControlMaster at the derived path; (c) a session started BEFORE the upgrade (old hook snapshot —
  whether Claude reloads hooks mid-session is unmeasured): no double and no missing cards; (d) Eco
  with a background subagent paused on its own background shell: not hibernated, bulk restart
  skips it; (e) a managed-account node gets native cards (installer writes the account dir); (f)
  Windows: the derived path keeps the reported separator; (g) a pre-2.0.43 CLI tolerates the two
  new keys in settings.json (same class as `StopFailure`, which already shipped); (h) the
  hand-back turn (a background child reporting back wakes the parent for a turn, then the
  `<task-notification>` wakes it again) may chime "finished" twice — #708's quiet rule is per
  turn.
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
  the same `toolUseId` slot the store already uses (claude by `agent_id` natively, else
  `tool_use_id`; codex by `agent_id`; grok has no tool call behind a subagent). Facts a refactor must not
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
- **Canvas control (manage-nodeterm-canvas)** — agents in `CANVAS_CONTROL_CAPABLE`
  (claude/codex/gemini/copilot/opencode/grok) can create/organize/control canvas nodes from inside their
  session: a POSIX **sh+curl** shim (`nodeterm.sh`, `CONTROL_SHIM_SCRIPT` in
  `main/canvas-control-core.ts` — the Electron-as-Node CLI is retired) POSTs
  **form-urlencoded** (`nodeId` + `arg.<flag>` fields; `curl --data-urlencode` is the only
  escaping sh can be trusted with — `parseControlBody` reads both this and the JSON dialect) to
  the hook server's `/control/<verb>` routes; `Accept: text/plain` makes the server render the
  reply (sh has no JSON parser). Env-gated on `NODETERM_CANVAS_CONTROL` (set by
  `buildPtyEnv`/`remoteHookEnvArgs` per `canControlCanvas`). Discovery (since #744): EVERY
  consented agent gets `skills/manage-nodeterm-canvas/SKILL.md` in its OWN skills dir — claude's
  config dir (+ each local managed/linked account dir), `$CODEX_HOME/skills`, `~/.gemini/skills`,
  `$GROK_HOME/skills`, `$COPILOT_HOME/skills`, opencode's `<config>/skills`; on an SSH host claude's
  dir and `~/.agents/skills` (read by codex, gemini, opencode, grok — measured — and copilot,
  documented). The marker blocks (`<!-- nodeterm:manage-canvas:start/end -->`) in AGENTS.md /
  GEMINI.md / copilot-instructions.md are no longer written and an older build's copy is STRIPPED;
  see **Agent-integration consent** under Agent support.
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
  **Windows hosts**: a PowerShell/cmd-run agent cannot type `sh "<shim>"`, so a win32 core also
  writes `nodeterm.cmd` / `context.cmd` beside the shims (`syncWindowsShLauncher` — finds Git for
  Windows' `sh.exe`, passes `%*` through, fails LOUDLY without it) and the skills, the connect-time
  note and the verify prompts say `& "<shim>.cmd"` for every agent outside
  `POSIX_TOOL_SHELL_ON_WINDOWS` (claude only — its Bash tool is Git Bash). The dialect is
  `shimDialectFor(agent, <the shim-owning core's platform>)` (`shared/agents/shim-invocation.ts`;
  `context-link:info` now reports that platform); every builder defaults to POSIX, so SSH-host
  skills and macOS/Linux bodies are byte-identical.
  **SSH projects** (docs/ssh-agent-skills.md): the SAME shim + skill + blocks are put on the
  remote host and KEPT current by the agent-tools check (`RemoteHooks.refreshAgentTools`: on every
  connect and tunnel repair, rewriting only what differs from this build, managed-account skill
  dirs included — see "An SSH host's agent tools are CHECKED" under Agent support; an account's
  skill is also written when the account is added), gated on the VERIFIED reverse hook tunnel — the shim
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
  pane, a store writer or the board file — plus the five layout verbs
  `group`/`ungroup`/`move`/`arrange`/`align`), and `OFF_SCREEN_REFUSALS` (the six that genuinely
  need live React Flow, each with its own reason in the refusal the agent reads). A refusal an
  agent can act on is strictly better than hijacking someone's screen. **The layout verbs off
  screen lay out from PERSISTED sizes** (nothing there was measured; a node is born at a persisted
  default size and a user resize is persisted too, so the gap is at most the overlap a live canvas
  can already show) and write back through `commitCtlNodes` → `geometryMutations`
  (`renderer/lib/storedGeometry.ts`): only the geometry that changed (`position`/`size`/`parentId`/
  `group`) is patched onto the STORED node, a created frame is added whole, only a frame is ever
  removed, and the batch lands in one `applyOwnNodeMutations` re-sorted parents-first. Never write
  the hydrated array back whole: that round-trips every node through the serializers. They were
  refusals until 2026-09-30; an orchestrator that could open a team off screen but never frame it
  was the report that moved them. Load-bearing details:
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
  codex/gemini/copilot/opencode marker block — NOT INSTALLED since #744, its parity tests are what
  keep it; every agent now reads the skill) — both in `canvas-control-core.ts`. When you add or
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
  **A new verb must still not DEPEND on the fix.** The shim is rewritten locally at every app boot,
  and an SSH host's copy is checked on every connect and brought to this build's bytes, so an app
  update reaches the host on the first connect after the relaunch. A host can still run an older
  loop for a while: while its tunnel is down (nothing is installed through a dead tunnel), when the
  file is unreadable (never written over), or while a second desktop on an older build shares the
  host account (it rewrites its own copy on its connects; ours returns within the hour). Nothing
  on the wire says which loop is running. Give every flag a value and both loops agree.
  **A retried call must not open a second node (`--request-id`, `core/control-request-ledger.ts`).**
  The reply to an open can be lost while the open went through — the agent's own tool call is
  killed (~2 min for a Bash tool call while a slow host holds the POST), the ssh tunnel drops
  mid-reply, or the shim's endpoint walk re-posts after a transport that failed AFTER the request
  was read — and the agent's natural retry used to open a second agent, team or worktree. The
  verbs that create something (`REQUEST_ID_VERBS`) take `--request-id <id>`, and the shim also
  sends its own `requestId` form field, generated once per RUN (`od` of `/dev/urandom`, else
  pid+time), on every POST of that run, so its own re-post is covered for an agent that never read
  the docs. Rules a refactor must not undo: (1) **the ledger lives in the hook server's `/control/`
  route** (core), the one place desktop main's forwarder and the Server Edition's
  `createServerEditionControlHandler` both sit behind — putting it in either shell's handler
  leaves the other without it; (2) rows are keyed **(verified caller node, id)** only — an
  unverified caller gets no dedupe rather than a shared bucket, and an explicit id from one is
  answered with `REQUEST_ID_UNVERIFIED_NOTE`; (3) the row is **claimed before the handler runs**,
  synchronously after the lookup, so two concurrent POSTs cannot both run; (4) a fingerprint (verb
  + args minus the id, key order ignored) makes the same id with a different call a
  `request-id-conflict`; (5) a settled row stores the WHOLE reply and a replay returns it (text:
  a `replayed:` first line; JSON: `replayed: true`) — a refusal included, so an id never runs
  twice; (6) a handler that cannot say whether its effect happened answers `indeterminate: true`
  (desktop main's 120 s wait, now `src/main/control-forward.ts`: the renderer is not cancelled, and
  an `open-worktree` whose `git worktree add` outlives the wait still completes) or throws, and the
  row becomes UNKNOWN — refused, never re-run; the forwarder hands a late renderer answer back via
  the handler's `onLateAnswer`, and settlement only moves up (unknown → answer, never the reverse).
  **A late answer is finished exactly like an on-time one**: everything main does with a renderer
  answer (the `open-browser` ownership claim, `browser-open-claim.ts`; the `open-project` grant) is
  ONE `finishAnswer` step the forwarder runs on whichever answer arrives — replaying a late
  "opened browser b1" without the claim told the agent it had a browser it could never drive. And
  **an indeterminate reply names its id**: the route adds a `request id: <id>` line saying to pass
  it back as `--request-id <id>`, and the in-flight/unknown refusals spell the flag with its value —
  the shim's per-run id is otherwise never seen, so "retry with the same --request-id" sent agents
  to re-run the bare command, get a fresh id and open a second one. That reply is not enough on
  its own: an agent's tool call is typically killed at 120 s — the SAME instant the app gives up —
  so the shim also prints the per-run id to stderr BEFORE posting an open it carries no caller id
  for (`requestIdAnnounceLine`, skipped for a caller's own `--request-id` and for `--dry-run`), and
  both agent bodies say to pass an OWN unique id up front for slow opens (open-worktree,
  spawn-team, verify) with a tool timeout above 120 s. A `finishAnswer` step that throws never
  escapes into the IPC listener: on time it resolves indeterminate, late it hands nothing back (the
  row stays unknown);
  (7) an explicit id on a verb outside the set is REFUSED (`request-id-unsupported`), like
  `--dry-run` — an agent believing its `write` is protected when it is not is the failure the flag
  exists to end — while a malformed or out-of-set per-run id is silently ignored; (8) a dry run
  neither claims nor replays. The ledger is **durable** (24 h, 256 per caller, 4096 in total,
  in-flight rows never evicted), mirrored to `<userData>/orchestration-state/control-requests.json`
  and loaded by `hookServer.start()` in both shells: a retry after an app restart replays the reply,
  a row IN FLIGHT when the process ended comes back UNKNOWN (refused, never re-run), and unknown
  stays unknown — see **Durable orchestration state**. (It used to be process memory, on the theory
  that a restart between the effect and the retry was too rare to pay for; measured, the cost is
  small — below.) The timeout sentence is verb- and claim-aware (`controlTimeoutError`): only a
  confirm-gated verb, whose dialog dismisses itself at the same deadline, is still called "safe to
  retry"; a call with no ledger row (no id, or an unverified caller) is told to check the canvas for
  its effect before retrying, never pointed at a flag it has no value for. Ids suggested to agents
  must be UNIQUE (a uuid — `$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)`, since slim
  Linux lacks `uuidgen` and macOS lacks `/proc` — or a readable name with a random part): rows are per node for 24 h, so a
  later conversation in the same node reusing a readable id for the same call would be answered
  with the earlier reply. An SSH
  host gets the new shim at its first connect after the update (the agent-tools check,
  `RemoteHooks.refreshAgentTools`); until then — or while its tunnel is down — its runs carry no
  per-run id (an explicit `--request-id` still works through the old loop). Agent-facing text
  is rendered from `REQUEST_ID_VERBS` / `REQUEST_ID_RETRYABLE` / `REQUEST_ID_OUTCOME_GLOSS`
  (`requestIdDocLines`). Tests: the ledger alone, the route (both dialects, in flight, conflict,
  late answer, throw), the Server Edition handler behind it, and the real shim under `/bin/sh`
  through a proxy that forwards the request and drops the reply — the re-post case, red before.
  Deliberately NOT in the set: reads (a replay would serve a stale snapshot, and `browser
  --cookies` would sit in memory for a day), the idempotent-by-nature verbs, and the
  human-confirmed / rate-limited ones (`write`, `send`, `settings`, `report-issue`) — widening it
  to those is a separate decision.
  **WHICH CANVAS ANSWERS, and why an open never moves the camera** (`renderer/lib/controlRouting.ts`
  + `renderer/lib/coldOpen.ts`). React Flow holds only the ACTIVE project's nodes, but every other
  open project's tmux sessions keep running, so a control call routinely arrives from a node the
  live canvas has never heard of. `routeControlSource` resolves the OWNING project
  (`active | switch | reopen | blocked | unknown`) — before that, every agent outside the project
  the app happened to come up on was rejected as *"source node is not a control-capable agent"*,
  which is a capability sentence for a routing failure. **That fix must not regress.** What it
  originally did with the answer was TRAVEL there (`travelToProjectRef`), and that was a screen
  hijack: the user looks at project B, an agent in project A runs `open-claude`, the tab switches
  and A's saved viewport is applied, so the camera appears to jump and zoom on a background agent's
  say-so. THREE membership lists now decide, and their differences are the whole design:
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
  so a caller does not report a session as started. **Exception (#925):** `--run-now` (and `run`)
  restores a closed project's tab WITHOUT activating it (`unhideProject`) and starts the node
  headless. A session that is running must be findable somewhere more durable than a notice, and
  not activating it keeps the half of this rule that matters. Two cases keep the tab closed: an SSH
  project, because its nodes are refused before any claim (`remote-unsupported`), so nothing starts;
  and the welcome screen (no project active), because un-closing one there would render a canvas
  with no active project. On the welcome screen the session still starts; the project just stays in
  Recently closed.
  On the cold path `--group`/`--after` ARE resolved
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
  - **"Don't ask again" is bounded by SCOPE, not by permanence** (2026-09, revised 2026-10). The
    dialog offers three RADIOS, visible from the start (`waiveChoices`): **"ask me again next
    time"** (pre-selected, and not a waiver — an untouched dialog grants nothing), **"don't ask
    again for agents in <project name>"**, persisted in `settings.controlConfirmWaivers.projects` as
    `{ [projectId]: verbs }`, or **"don't ask again in any project until nodeterm quits"** — the
    transient `state/controlConfirm.ts`, memory only (not `settings.json`, not `localStorage`), per
    VERB in every project, so quitting restores the gate. It used to be a checkbox whose two reaches
    appeared only once ticked, defaulting to the app-run one: the per-project answer was invisible
    until the user had already said yes, and the 2026-10 report read it as missing. The labels say
    what each reach covers because the two are different shapes — "until nodeterm quits" must not
    sit under a project name, since the app-run waiver has no project bound. The machine-WIDE
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
    per-project waiver is listed with a Revoke in Settings → Agents. **The per-project scope can
    also be set UP FRONT**, before any agent has asked: each project tab's ⌄ menu has an "Agents
    may, without asking" group with one toggle per `CONFIRM_WAIVABLE_VERBS` member (labels in
    `WAIVABLE_VERB_ACTIONS`). It writes the same `projects` map — the dialog grant, the toggle and
    the Settings revoke all go through ONE pure merge, `withProjectWaiver` (prune, set, sanitize) —
    so it is no new mechanism and nothing it does reaches `project.json`. **A row shows the
    EFFECTIVE answer, not the map entry**: `projectWaiverState` asks `decideControlConfirm` itself,
    with and without this project's grant, so an app-run, machine-wide or global-Bypass waiver shows
    as in effect, names itself (`otherWaiverHint`) and points at Settings → Agents — a row that read
    only the `projects` map promised "agents here ask you first" while the gate still skipped the
    dialog. Surfaces: Desktop only. It is hidden in the browser Server Edition
    (`isBrowserRuntime()`), whose headless control is gated by creator ownership and never by these
    waivers, and on a relay tab, whose confirms belong to that machine; mobile N/A.
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
  - **`settings` can never be waived**, by table (`CONFIRM_WAIVABLE_VERBS`) rather than by a line
    somebody forgot at a call site: a settings change can GRANT a capability, and a CLI that could
    waive its own consent would make the consent decorative.
  - **`open-project` IS waivable (2026-10)** — it was excluded on the claim that it "cannot produce
    the dialog storm — `recordAttachConsent` already dedupes it per (caller, project)". That
    dedupe is keyed on the caller's NODE id, in memory, for one app run: every new orchestrator,
    every station a team spawns and every restart asked again about the same two projects, with no
    box to stop it (the field report: "an orchestrator in another project opens a node, a dialog
    each time"). Waiving it changes only whether the human is asked — main still requires a
    verified, local caller, an absolute existing `--cwd` and the grant cap, still records the
    grant from the reply, and the registration still never focuses a tab. Its waiver is keyed on
    the CALLER's project like `write`/`close` (the open-project block resolves that project
    itself, under the same `ctlProject` name, because it runs before the dispatch computes one);
    the waived and confirmed legs register through ONE `opFinish(opAdopt)`.
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
  (The walk's liveness probe IS bounded, and does not break this: it runs only against a FALLBACK
  candidate, only after the primary failed — a dead transport, or a 421 wrong-owner answer, which
  the server gives before dispatch, so no dialog exists — and before any POST to that candidate.)
  **Grouping verbs** (`group` / `ungroup` / `move` / `arrange` / `align`): `group` wraps **sibling**
  objects — nodes or frames — into a new frame in their shared container (a mixed-container set, or
  an ancestor plus its descendant, is refused with that reason); `ungroup --group <id>` dissolves a
  frame, promoting its direct children into the frame's own parent (nodes kept); `move
  --nodes <id,id> [--group <id>]` reparents nodes OR whole frame subtrees INTO a frame (or
  `top`/`none`/omit → out to top level) via `reparentNode` — the ONE way to move a node between
  frames, which `group` won't do; a cycle (a frame into itself or its own descendant) is refused.
  `arrange`/`align` now run in ONE coordinate space: all top-level, OR all children of one frame
  (`commonParentId` decides; a mixed set is refused, not silently subset-arranged — the old
  behavior). When the ids are a frame's children, that frame AND every ancestor frame are re-fitted
  to hug the tidied layout (`fitAncestorChain` — fitting only the one frame left a nested frame
  wider than its parent) — the fix for "grouping keeps scattered positions so the frame is too
  wide". `arrange` fills its slots in the order the ids are LISTED (`arrangeNodes` used to place in
  array order, which discarded every caller's sort). `move` also re-fits the source + destination
  frames. All pure + tested in `state/workspace.test.ts` + `workspace.layout.test.ts`.
  **`arrange --group <frameId> [--layout grid|row|column|lineage] [--cols N]`** names the FRAME
  instead of listing its children: the frame's direct children are laid out and the frame chain is
  re-fitted — `arrangeGroupChildren`, the SAME transform the frame's menu rows run (see
  **Arrange inside a group** under Canvas interaction). The flag gate is the pure
  `arrangeArgsRefusal` (`@shared/arrange-verb`), called in THREE places: `parseControlRequest`
  (Server Edition), desktop main's control handler (which never runs `parseControlRequest` — the
  `--issue` trap; with the gate only in the parser, all three refusals were missing on the desktop
  and the request ran as a grid), and Canvas's `case 'arrange'` as the belt: `--nodes` and
  `--group` together are refused rather than resolved silently, an unknown `--layout` on the
  `--group` form is refused by name, and `--layout lineage` on the `--nodes` form is refused
  instead of being delivered as a grid (any OTHER unknown word there still falls back to `grid`,
  as it always has). What only the canvas knows — no such frame, an empty frame, no lineage among
  the children — is `groupArrangeRefusal`, replied as `arrange: <reason>`; a frame already in
  place answers `ok` with `changed: false` and writes nothing. The agent-facing text for the form
  is `arrangeGroupGuidanceLines`, rendered into BOTH generated bodies from the same layout list the
  gate checks. **Server Edition: refused by name** — `arrange` is not in `SERVER_V1_VERBS` in either
  form (headless control keeps no measured node sizes), so `--group` gets the same permanent
  `control-unsupported-on-this-edition` reply and is never dropped on the way to an `ok`
  (`control-unsupported.test.ts` pins it). Off screen it works like the `--nodes` form: the
  stored nodes are laid out and written back through `commitCtlNodes`, and the lineage ropes are
  the OWNING project's (`offCanvas.project.ropes`, re-marked with `markLegacyWaitRopes` exactly as a
  load would — a project that has not been opened since waits were marked still holds unmarked
  ones), never the live canvas's. The rope **id** rides along on both paths: it is the only thing
  that tells a wait from an opener, and stripping it (as the first revision did) makes every wait
  read as an opener. **`arrange --group top [--layout tidy|lineage]`** (2026-10, issue #1114 — an
  orchestrator asked for a programmatic Tidy) names the canvas's TOP LEVEL with the same words
  `move` reads (`top`/`none`/`ungrouped`, `isTopLevelGroupArg`) and runs the user's own **Tidy
  canvas** (`tidyCanvas`, default) or its bands (`arrangeByLineage`) — the same transforms as the
  pane menu, nothing re-implemented. `grid`/`row`/`column` are refused there by name: `--nodes`
  already says them, and a top-level grid that ignores lineage is what Tidy no longer is. Same
  Server Edition refusal, same off-screen path.
  **Geometry verbs (issue #1288, 2026-10): `arrange --gap`, `resize`, `place`, `list --geometry`** —
  so an agent can rebuild an exact layout (the report: 8 sessions in two tight columns on a
  vertical monitor, rebuilt every time a session is replaced) instead of a human dragging. Every
  packing always took `opts.gap`; the verb simply never handed it the flag. The shape gate is ONE
  pure module, `@shared/geometry-verbs` (`geometryArgsRefusal`; `--gap` lives with the rest of
  `arrange` in `arrangeArgsRefusal`), called in the same THREE places as the arrange gate — desktop
  main before the forward, `parseControlRequest`, and Canvas's belt (once, BEFORE the routing, so
  the live AND the stored `list` read a well-formed call). Every flag takes a value (the SSH
  shim-loop rule) and the new verbs refuse an unknown flag by name (#539). The rules a refactor
  must keep: **(1) `--gap`** is a whole number 0–`ARRANGE_GAP_MAX` (400, ten times the default 40)
  for all three forms; above it the call is REFUSED, never clamped. Snapping cannot undo it:
  `arrangeNodes` never snaps positions, and with snapping on the `--group` form snaps only the
  frame's PADDING and the frame fit (which keeps root positions). Frame padding is not the gap.
  **(2) `resize`** (`resizeNodes`) CLAMPS each named axis to the kind's resizer minimum
  (`NODE_MIN_SIZES`) and `NODE_SIZE_MAX` (the default-size setting's ceiling) and reports what it
  applied; it applies exactly (no grid snap); a group frame refuses the WHOLE call (a frame is
  sized by what it holds); a **collapsed** node keeps drawing header-only — the width applies now,
  the height becomes `expandedHeight` (what the expand gives back and what `flowToNodeStates`
  persists); a **maximized** node is restored first (left holding `premaxRect`, the next panel-pin
  refit would put it back over the viewport); `measured` is dropped in the same tick (the
  serializer prefers it); the ancestor frames re-fit. Terminal cols/rows follow through the node's
  own ResizeObserver — there is no second path to tmux. **(3) `place`** (`placeNodes`) is a NEW
  verb, NOT `--x` on `move`: `move` without `--group` means "to the top level", so `move --nodes a
  --x 10` would pull a framed node out of its frame and ignore the `--x` — `move` now REFUSES
  `--x/--y/--dx/--dy/--width/--height` by name, naming `place`/`resize`. Coordinates are ROOT space
  (what `list` reports); a framed node keeps its parent (the root delta is applied to its relative
  position, then `fitAncestorChain`, which keeps root positions, so it lands exactly). Several ids
  with `--x/--y` move as ONE block (bounding-box top-left lands on the point — not stacked: every
  node on one point is not a layout); `--dx/--dy` shift each; the two forms are refused together; a
  listed descendant of a listed frame is carried, not moved twice; |coord| ≤ `PLACE_COORD_MAX`
  (100 000, a typo bound, refused not clamped). **(4) `list`**: the JSON rows ALWAYS carry `x`,
  `y` (root, whole px), `width`, `height`, `parent` (+ `collapsed`/`expandedHeight`); the text form
  only behind `--geometry on`. The live canvas reports React Flow's MEASURED size
  (`liveNodeGeometry`), persisted only before the first measure; an off-screen project reports the
  persisted size (`storedNodeGeometry`). **(5) Off screen** `resize`/`place` are stored-node verbs
  like `arrange` (`commitCtlNodes` → `geometryMutations`), which is also the shared-canvas path; for
  that, `premaxRect` joined the stored geometry fields — before, an off-screen `arrange` restored a
  maximized node in memory and left its restore rect on disk. **Surfaces:** desktop only for the
  verbs. The Server Edition never reaches the renderer dispatch (its bridge's `onAgentControl` is a
  noop and `createServerEditionControlHandler` serves no layout verb, `list` included), so all four
  take the named permanent `control-unsupported-on-this-edition` refusal. Relay tabs: an agent's
  call is answered by the HOST desktop's canvas, and the guest sees the result through canvas sync.
  Mobile N/A. Follow-up: `--width/--height` on the open verbs (today they ignore an unknown flag).
  Pure rules in `state/workspace.geometry.test.ts`; wiring pins in `canvas/geometry-verbs.source.test.ts`.
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
  **Issue-bound opens (`--issue`, 2026-09-28):** `open-agent`/`open-claude --issue <owner/repo#N |
  #N>` binds the new session to a GitHub issue exactly like the board's **Start with agent**. The
  SHAPE is refused by ONE gate, `issueFlagRefusal` (`canvas-control-core.ts`), which desktop MAIN
  runs in its control handler (desktop main does not run `parseControlRequest` at all — do not move
  the gate there alone) and the Server Edition runs inside `parseControlRequest`; any other verb
  carrying `--issue` is refused, not ignored. `#N` is resolved by each shell against the project the
  node OPENS IN (the `--project` target, the cold-open owner, or `ctlProject`) — the repository its
  kanban board syncs with, i.e. the GitHub host controller's answer (configured, else detected) —
  and a project with no GitHub board refuses `#N` and names the full form (`lib/issueFlag.ts`,
  `HeadlessNodeFactoryDeps.issueRepository`). **On the desktop it is resolved ONCE, at the top of
  the control handler (`issuePre`), before any open path snapshots the projects store**: the lookup
  is a host round trip (`git remote`, `gh auth`), and an await inside a path let a tab switch in that
  window write the node into the wrong project. A full `owner/repo#N` asks nobody. The same
  placement puts resolution before every path's dry-run branch. **But not before the gates**:
  `resolveIssueFlagForCall` first runs the renderer's authorization belt — the same
  `resolveProjectTarget` call and source-capability rule the paths apply — and answers a caller
  they would refuse with the path's own refusal, asking nobody (the lookup otherwise ran for a
  refused caller, and its refusal said whether that project had a GitHub board). Main's
  `gateProjectTarget` runs before the renderer as ever; the Server Edition already resolved after
  its identity, source and target gates, now pinned by a test.
  **The open PROMPT is decided in the same place, once, for every open path** (`openPrompt`, via
  `launchPromptFor` in `lib/promptSpill.ts`): the issue reference line composed through
  `issueLaunchPrompt`, then spilled to a file when it is over the typed-line budget (#706), judged
  "local" by the project the node opens in (an SSH project's pane cannot read a file written here),
  which comes from the SAME authorization belt (`issueFlagScope`, exported for this): a caller the
  paths refuse gets no project and no spill. The live open was the only path that spilled; the `--project` and cold opens typed the prompt
  inline, so the docs' "a long `--prompt` is safe on a local project" was false exactly where the
  ~490-byte issue line made it likeliest to bite, and the `--project` path silently DROPPED
  `--prompt-file` (the session started with no brief) and `--model`. A new open path types
  `openPrompt`, never its own prompt — `control-prompt-spill.source.test.ts` pins each path.
  **A spilled prompt is read at LAUNCH, which for a cold open can be weeks away**, so it is not a
  paste: `saveUpload` puts a `LAUNCH_PROMPT_FILE_PREFIX` name under `<userData>/launch-prompts`
  (`@shared/launch-prompt`), owner-only, swept after `LAUNCH_PROMPT_TTL_MS` (30 days) by the next
  spill — under `uploads` the 7-day sweep of the next paste deleted it and `"$(cat '<path>')"`
  started the agent with nothing. And because a cold open can wait longer than ANY TTL, the held
  launch records the file (`pendingLaunch.promptFile`, via `withLaunchBrief` on every arming path)
  and the delivery loop checks it right before typing (`launchBriefPresent`: local projects only,
  a failed check answers "present"); a definite "gone" persists `manualOnly`, raises the
  `brief-missing` delivery state (tooltip names the path, `list` says HELD) and waits for ▶ / `run`,
  which still run it on purpose. The one residue: a refused open may leave a spill file behind
  (the spill is decided before the paths, to keep awaits out of them), swept with the rest.
  `--prompt` replaces the default task after the reference line; `--prompt-file` stays the whole brief. Both
  generated agent bodies render the contract from `issueBindingDocLines` (the example first prompt
  is rendered from `issueLaunchPrompt` itself): move your OWN card with `assign` (In Progress on
  start, In Review on delivery), never close the issue, never Done, `Closes #N` in a PR, and **post
  to GitHub only when the user asked in that session — otherwise end with a proposed comment**.
  nodeterm has no automatic post-to-issue path and must not grow one. `list` marks a bound row
  `issue owner/repo#N`. Server Edition: `open-agent --issue` works under its verified-only,
  creator-owned rules and writes the run history; `assign` is unsupported there (the skill says so).
  **The board's GitHub lane for agents (`issues`, `prs`, 2026-09-30, read-only).** An orchestrator could
  start work on an issue (`--issue`) and wait on a PR (`--after-pr`) but not SEE the lane: `board` lists
  session cards only (measured: 21 session cards, zero issue/PR cards), so agents fell back to
  `gh issue list` / `gh pr checks`, which spend the account's budget outside the coordinator and cannot
  say which column an issue sits in, which session is bound to it, whether dispatch queued it, or what CI
  snapshot the board already holds. `issues [--state open|closed|all] [--label L] [--column <id|title|
  ungrouped>] [--limit N]` and `prs [--state open|merged|closed|all] [--limit N]` (default open, 30 rows,
  max 100, newest-updated first; both take `--project`) answer that. ONE module, `core/github/control-
  read.ts`, called by desktop main (after the `--project` grant gate, before any forward) and by the
  Server Edition's control handler (own project only — it keeps no grant ledger). Rules a refactor must
  not undo:
  - **Zero GitHub requests.** The read is `GitHubIssueService.controlSnapshot`: the issue cache plus the
    pull tracker's memory, through `projectContextForCache` — no credential resolve, no heartbeat, no
    poll (`service.pulls.test.ts` counts the client's calls and the credential chain, before and after a
    fetch). No snapshot yet, an unapproved repository and a board with no GitHub connection are each a
    NAMED refusal (`issues-no-snapshot`, `-not-approved`, `-no-github-board`), never "0 issues". An
    agent's read deliberately does NOT start a fetch: a repository's first fetch is a full paged harvest,
    and spending that is the person's call (opening the board), not a background agent's.
  - **An unapproved column mapping is not a fact.** The label → column mapping arrives through the
    git-shared project file; while this machine has not approved its digest (`mappingApproved` false)
    the board is read-only with "approve the column labels", and `issues` likewise shows NO `column:`,
    says so in its header, and refuses `--column` (`issues-mapping-not-approved`).
  - **One workspace load per call.** The host's cache context carries the `Project` it resolved
    (`GitHubIssueProjectContext.project`, in-process only) and `controlSnapshot` returns it; a second
    `githubProject` load per call re-fired the store's persist hooks for an agent polling `prs`.
  - **A harvested merge/close wins over an open status read**, which may be stale; the status read
    stays authoritative about draft vs open.
  - **The board's semantics, imported.** CI is `GitHubPullStatus.ci` (`pullStatusFrom`: a null rollup
    is "no checks", never passed; only the CURRENT head counts), merge `ready` only from CLEAN, a failed
    status read says STALE (`pullStatusFreshness`), merged/closed PRs carry no CI. PR ↔ session card is
    `pullsForCard` — MOVED to `@shared/pull-card-links` (the renderer's `lib/pullLinks.ts` re-exports it)
    with the nearest-bound-branch walk (`nearestBoundBranch`, which `worktreeBranchOf` now calls), so
    the card and the verb cannot link differently: worktree branch (never a fork, never on an SSH
    project) or the issue the session was started on, tombstones honoured. Bound sessions are terminal
    nodes whose `issueRef` names this repository, with the mirror's live state (`queued` for a held
    launch, `unknown` otherwise).
  - **Untrusted text.** Titles, labels, logins, branch names — and node ids and column ids, which come from
    the git-shared project file whose load checks only that they are strings — pass `untrustedLine` (one line, `\p{Cf}`
    bidi/zero-width stripped, capped); the reply's first line is `UNTRUSTED_TEXT_NOTE`; issue bodies and
    comments are never included (the agent reads them with `gh`, as the `--issue` prompt says).
  - **Dispatch state is the renderer's**, so the renderer REPORTS it: `boardDispatch.report` (display
    only, replaced whole on change, `@shared/board-dispatch-report`) into `core/board-dispatch-report.ts`,
    kept per sender and read only for senders still in `clientIds()` (a closed tab leaves no stale
    "queued"), owner clients only, the channel host-only (a relay tab's stub is inert). Desktop and
    Server Edition both register it.
  - Verified-only (`requiresVerified`, refusal `GitHub lane read refused.`, and desktop main checks
    `verified` again as a second guard, like open-project) — the project is resolved
    from the caller's node, so a forgeable caller could read any project's lane; `STORE_ANSWERED_VERBS`
    (a read needs no canvas, and polling `prs` must never travel the user's view); not a request-id
    verb. Both agent bodies render `githubReadDocLines` from the module's constants, including the loop
    (`issues` → `open-agent --issue #N` → `prs` / `--after-pr`) and "GitHub writes stay with the person".
    Relay peers cannot call these (their control belongs to the host). **Mobile: N/A** — the phone issues no
    control verbs.

  **Dependency edges (`--after`, 2026-07):** `open-terminal`/`open-claude`/`open-agent` accept
  `--after <id,id>`, which opens the node **armed** — `data.pendingLaunch` ({after, command},
  `PendingLaunch` in shared/types) holds the launch the factory built, and Canvas fires it once
  every dep reports `done`. This is what makes the canvas a DAG instead of a fan-out.
  **`pendingLaunch` is a MACHINE-LOCAL exec field, like `shell`** (@shared/node-exec): its `command`
  is typed into a shell once the wait is over, and `after: []` or a vanished dep counts as over, so
  a value that arrives from outside would run a command nobody here armed. It is persisted in
  workspace.json's `IndexEntryV3.localExec` (every ref kind: folder, SSH, local-data), NEVER in
  `.nodeterm/project.json` or an SSH mirror (`stripSharedNodeExec`), and a file that carries one is
  ignored on read — the one-time legacy hoist deliberately does not adopt it either (provenance
  cannot be told apart, so an armed node written by an older build loses its held launch on
  upgrade). On `canvas:mut` a peer's value is stripped and OUR value carried across its upserts
  (`carryLocalNodeExec`); the reflector forwards one only between OWNER clients
  (`CorePlatform.isOwnerClient`: the app window, a cookie-authenticated Server Edition tab — never a
  relay peer), stamped `origin: 'core'`, which a client cannot supply and a relay tab ignores. That
  owner→owner leg is load-bearing: it is how two Server Edition tabs converge on a launch's
  attempted/cleared state, and how a headless delivery's clear reaches the browser. **It is NOT the
  exactly-once guarantee** — it lands only after a publish → reflector → apply hop, and two tabs on
  one project both claimed a fresh node's launch inside that window and both typed it (#1173). The
  claim therefore asks the CORE first: `commitLaunchAttempt`'s `claim` → `workspace.claimLaunch`
  (`workspace:claim-launch`, `core/launch-claim-ledger.ts`, registered by `WorkspaceStore` in both
  shells, host-only). Keyed (node id, command) → the claiming CLIENT: the first claimant owns it, a
  later AUTOMATIC claim from another client answers `elsewhere` and types nothing and marks
  nothing (the writer's outcome `elsewhere` is not a failure; the canvas loop keeps it in flight),
  the owner asking again is still the owner, and a manual Run now is never refused. In memory and
  bounded (4096): a process restart forgets it, and the persisted `attempted` mark is the barrier
  then. Desktop has one renderer, so its single claimer always wins. Our OWN writes
  into a background project go through `applyOwnNodeMutation` (unstripped — a cold open keeps its
  launch, a patch to `undefined` clears it); `applyNodeMutation` is the peer path (the one reducer,
  `applyCanvasOp`). On a Server Edition that governs a shared project, the canvas authority hears
  every op WITHOUT its launch and a save's exec carry is what writes it (see **Shared canvas
  authority**). Load-bearing
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
  The Server Edition's immediate open and its `run`, and the desktop's headless start (`--run-now` /
  `run`, below), deliver through the SAME echo-verified writer (`@shared/command-delivery`, moved
  out of the renderer for this), via the headless launcher `core/headless-launch.ts` (#925): a tmux
  paste is not immune to zsh's rc-time tty flush (#556) or the canonical-line cap (#706). The
  Server Edition's deferred `--after` release (`refreshArmed`) still pastes with `sendText`.
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
  the dep→node edge is a **rope** (`ctrl-after-<dep>-<node>` — `waitRopeId`, marked so it can
  never be mistaken for the opener's `ctrl-<source>-<node>` once the canvas prunes that one; ropes
  saved before the mark are re-marked by append order at load, `markLegacyWaitRopes` — persisted in
  `project.ropes` like the opener's) whose LOOK is derived: dashed + ⏳ while the node's `pendingLaunch.after` still lists the
  dep, solid once it has launched (`lib/edgeModel.ts` `ropeVisual`, over the ONE `ropeInfoOf` lookup
  the render and BOTH delete paths ask — two builders would be two answers, and the label the user
  reads would stop describing what the delete does). The fan-in bridge `--after` also writes hides
  under that rope (`hiddenLinkIds`), so ONE edge per pair holds on the canvas. Deleting a WAITING
  rope drops that dep from `after` (`dropAfterDep`) and takes **nothing else** — the covered bridge
  survives, because "stop waiting for it" is not "stop being able to read its work"; an emptied
  list fires. Only the `open-*`/`verify` verbs write the rope, so `missingDepRopes` heals an armed
  node that has none at **project load**: `pendingLaunch` is persisted (machine-locally) and the rope is not, so a node
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
  and stored projects) names QUEUED / STARTING / LAUNCH FAILED / DROPPED / AGENT STATUS UNCONFIRMED, and every other agent row its state (WORKING / IDLE / NEEDS YOU: an unlabelled idle row and a row waiting on a person used to read the same)
  rather than treating absence of a hook as success. Server v1 still explicitly refuses `list`.
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
  **(10) A `done` from BEFORE new work was handed over does not release anything**
  (`core/station-handover.ts`, `@shared/station-handover`, 2026-09-30). A station is reused: an
  orchestrator hands it task B (`send` → `queued` because it is busy, or delivered to an idle pane
  it has not started on yet, or a `write` / `run`) and then opens D `--after <station>`. Until the
  station STARTS B its state is still task A's `done`, so D fired at once — on A's output, and a
  launched dependent cannot un-launch. #1042 closed the same hole for `--after-success` (reports);
  this is the plain-turn half. Rules a refactor must not undo:
  - **The fact is core's, per station, fed by the SAME hand-over moments #1042 uses**: the
    messaging layer's `onHandover` (`queued` = held from that instant; `landed` at the time the
    delivery attempt STARTED; a queued entry that `settled` without landing holds too, from the
    settle — the orchestrator armed D believing the task was handed; the turn running at the expiry
    does not end it, only a turn started after it does, and nothing starts one unless the station is
    given work again, so ▶ / `run` are the usual way out), and each shell's control answer
    (`noteControlAnswer`, on success only, never the caller naming itself) for `write` — stamped with
    the renderer's `typedAt`, when it STARTED TYPING after the human's confirm, never the request
    time: a turn that began while the dialog was open (a background child's task-notification) must
    not answer text not yet typed — and for `run` (starts the named node's held launch; no confirm,
    stamped at request arrival). A `write` into a station that was BLOCKED or WAITING at request time
    (read from the tracker's short state history) is NOT a hand-over: it answers the prompt and the
    same turn continues, so no new turn would ever start to end it. Board comments, station notices
    and a person typing are not hand-overs (the #1042 set).
  - **It ends with a turn that STARTED at or after the newest hand-over and has ENDED, with nothing
    still queued.** The tracker stamps turn starts itself (first working/waiting/blocked after an
    idle state, or any genuine `newTurn` — after an Esc interrupt core may never see the idle the
    renderer infers — on its own clock) for EVERY station, because a delivered prompt can start — and
    even finish — its turn before the delivery's `landed` event is emitted; a hand-over that finds
    its answering turn already over clears at once. Timestamps never cross a process: the renderer
    only reads a membership list, so the Server Edition browser's clock never enters it. A turn
    already running when the work landed does not end it (the typed text is answered by a LATER
    turn); if a CLI folds typed input into the running turn instead, the hold lasts until its next
    turn — the holding direction, with ▶ / `run` as the way out. The idle-prompt rescue (`idle: true`)
    counts only for a station still `working` (the reduceEntry rule): it also fires under an open
    permission prompt, and taking it as idle there let the approval's `working` stamp a fake turn
    start inside the same turn (review of #1052, reproduced).
  - **The tracker is fed every agent event BEFORE the messaging queue** (desktop `emitAgentStatus`,
    the Server Edition's `onAgentEvent`): the queue flushes new work on the very `done` the tracker
    must stamp, and the server's `refreshArmed` reads the tracker on that same event. Pinned at
    source level by `main/station-handover-wiring.test.ts`.
  - **The renderer reads it through a derived primitive signature** (`armedHandoverSig`, only the
    armed nodes' deps — the `armedDepSig` rule), and `launchesToFire` / `depSatisfied` take it as a
    trailing argument: a handed-over station is never a satisfied dep, a DELETED one still is.
    `successDepFacts.turnDone` applies it too, so a success wait never releases where plain
    `--after` would hold. The Server Edition's factory asks `handedOver` in `refreshArmed` AND in the
    creation shortcut (`mustWait`): "already satisfied at creation" must mean satisfied under this
    rule, or the node is launched immediately by the shortcut.
  - **Background SUBAGENTS hold the same way; background SHELLS do not** (same module, same list;
    `background: true` on the record). MEASURED live 2026-09-30: an agent's turn ended while its
    work went on in the background, and the node armed `--after` it fired before anything was
    pushed. Claude's `Stop` carries `background_tasks` (see **Claude's native subagent hooks**, fact
    6); `liveBackgroundSubagentIds` keeps only `type: 'subagent'` entries
    (`NormalizedAgentEvent.backgroundSubagentIds`). A `done` listing a live subagent holds the
    station; only a later `done` whose inventory is PRESENT with no subagent left releases it, or
    `SessionEnd`. Why only subagents: a child ENDS, and its task-notification wakes the parent into
    another turn, so that later `Stop` reliably comes; a background shell (a dev server, a watcher,
    `tail -f`) may never end and does not reliably wake the station — holding on shells held a
    dependent FOREVER ("S starts the dev server, T `--after` S runs e2e" never fired; review of
    #1052). Unknown `type`s are treated like shells. An ABSENT inventory is unknown and changes
    NOTHING (a CLI too old to send it keeps today's behaviour exactly; the idle rescue and
    `StopFailure` carry none). The agent bodies tell a station to wait for a background shell's
    result itself before ending its turn when a dependent needs it.
  - **Eviction prefers stations with nothing held** (the bound is 2000 tracked stations; the oldest
    with nothing held goes first) — dropping a held one would release its dependents. Only when
    every tracked station holds is the oldest held one dropped.
  - **The Server Edition re-runs `refreshArmed` on every tracker change**, not only on
    working/done events: a hold can end on an event the factory is not otherwise run for (a
    `SessionEnd` clearing a subagent hold).
  - Surfaces: `list` says `waiting for <station> to finish the work handed to it` (or `…the tasks
    still running in its background`); the QUEUED tooltip
    names it; both agent bodies render `afterHandoverDocLines` ("hand it the next task FIRST, then
    open the dependent"). DURABLE across a restart (`HANDOVER_FACT`, see **Durable orchestration
    state**): the holding stations are stored, `queued` is rebuilt from the durable queue.
    Relay tabs take the inert stub; the list channel is HOST_ONLY
    (unscoped: every project's stations). Mobile: N/A (the phone never sees `pendingLaunch`).
    Tests: `core/station-handover.test.ts`, `test/acceptance/after-handover.test.ts` (the REAL
    queue → tracker → the renderer's real `launchesToFire`, red on the old code) and the server
    factory's own cases.
  **Pull request waits (`--after-pr`, 2026-09-29).** `open-terminal --cmd …` / `open-claude` /
  `open-agent` take `--after-pr <N:checks|N:merged>[,…]` (N may be `#N` or `owner/repo#N`) and
  `--pr-deadline <90m|12h|3d>`: the held launch ALSO waits for pull requests of the project's
  board repository, ANDed with `after` and the setup gate. The grammar, the persisted shape
  (`pendingLaunch.afterPr = {repository, waits, deadlineAt}`) and main's shape gate are ONE module,
  `@shared/pr-wait`; when a wait is met is `renderer/lib/prWait.ts`. Rules a refactor must not undo:
  - **No new poller, no new request path.** The status is #1008's `GitHubPullBoard` from the host's
    memory. Canvas holds the board's own refcounted host subscription (`watchPulls`) while any live
    node holds a PR wait, so #1008's conditional heartbeat (free while nothing changes) keeps it
    fresh; a `checks` wait also asks the host's bounded chase (`usePullChase`, visible window only)
    because a finished check run does not move the heartbeat. Past the chase cap (12 reads, about
    48 minutes) a still-running CI is noticed on the next repository change — the deadline and ▶
    are the answer, never a timer of our own.
  - **#1008's semantics, not new ones.** `checks` = `ci === 'passed'`, which `pullStatusFrom`
    reports only for a SUCCESS rollup at the CURRENT head; a null rollup ("no checks") never passes;
    a STALE board never passes `checks` (a push since the last read carries other checks) but may
    pass `merged` (irreversible). A board whose repository differs from the hold's is `blocked`,
    which holds rather than fires — that is also what makes a mid-switch board harmless.
  - **`checks` needs a read that STARTED after arming.** The host remembers "passed at head A"
    across a closed board, so pushing B and arming at once would otherwise fire on A. The hold
    stores `armedAt` on the HOST clock (`pullStatus().now`), the tracker publishes `readStartedAt`,
    and `checks` is `unknown` until `readStartedAt >= armedAt`. Two host changes carry it: a
    FOREGROUND read now notifies even when nothing changed (else an already-green PR's fresh read
    would never reach the renderer), and Canvas asks for one (`startFreshReadAsks`: at once, then at
    most 3 more, 35 s apart — the 30 s refresh floor or a read already in flight can swallow one).
  - **"No such PR" needs a snapshot refreshed after the question** (`lookupPullRequests`). A board's
    snapshot can be a minute old and `subscribe` starts no refresh when a board already holds it,
    so `gh pr create` then `open-* --after-pr` used to be told "does not exist — do not retry". A
    miss now asks for one refresh and looks again; absence is proven only when the snapshot's
    `lastSuccessfulRefreshAt` is at or after the host time read before that refresh. Columns come
    from the first page's `counts`, so a PR filed under a deleted column is still found, and a
    truncated harvest says so instead of "retry in a minute" forever. The spilled-prompt TTL
    (30 days) outlives the longest `--pr-deadline` (14 days), pinned by a test.
  - **Unknown is never satisfied, in both directions.** `launchesToFire` treats a caller that passes
    no PR context as CLOSED for a PR hold (the opposite of the setup gate, whose absent probe is
    open for a restart reason that does not apply here), and a malformed persisted hold becomes
    `INVALID_PR_WAIT_HOLD` — present, expired, never satisfied — never `undefined`, because dropping
    it would start the node on its `--after` deps alone. `normalizePendingLaunch`
    (`@shared/pending-launch-shape`) now runs at BOTH serializer seams for the whole held launch: an
    `after` that is not a list used to throw inside the canvas's dep-signature selector; an
    unreadable gate turns the hold `manualOnly` instead of opening it.
  - **Deadline, and the escape.** Default 24h, 1m–14d, refused (not clamped) outside it. Past it the
    node never starts on its own: the badge reads ⚠ EXPIRED (TerminalNode sets its own timer — no
    store changes at a deadline), `list` says EXPIRED, and ▶ / `run` start it anyway (`planRunVerb`
    treats a PR hold like `--after`: the mount does not fire it). Exactly-once is unchanged:
    `launchInFlight` plus clearing `pendingLaunch` on submit.
  - **Refused at arm time, each with its reason** (`resolvePrWaitFor`, resolved ONCE next to
    `issuePre`, against the project the node OPENS in — and only for a caller `issueFlagScope`
    authorizes, since the lookup tells its caller whether a project's board exists): a relay tab; a board not connected to GitHub
    (a cwd-less project says why); no repository or sync not approved on this machine; a full
    `owner/repo#N` in another repository; a number the harvested PR list lacks — only from a WHOLE,
    refreshed snapshot (`lookupPullRequests`), anything less is the retryable
    `after-pr-unconfirmed`; a closed-unmerged PR; `:checks` on a merged PR. A `:merged` wait on an
    already-merged PR is met now and not stored. An SSH project is NOT refused on its own account:
    its board's status is read by this machine's GitHub client like any other.
  - Main (`afterPrFlagRefusal` in its handler) and the Server Edition (`parseControlRequest`) share
    the shape gate: `--run-now` with `--after-pr`, `--pr-deadline` alone, and `open-terminal` without
    `--cmd` (nothing to hold) are refused. The Server Edition then refuses the well-formed flag by
    name (its open allowlist) — it keeps no PR watch, and a silent drop would start the node at once.
  - A node in a project that is not on screen is judged when that project is next viewed (the watch
    follows the live canvas), the same contract as a cold-opened `--after` node. **Downgrade:** a
    build older than this one keeps `afterPr` in the file but ignores it, releasing the node on
    `after` alone. **Kanban / mobile:** the card does not show QUEUED for any held launch (a
    pre-existing gap, not new here); the phone never sees `pendingLaunch`.
  **Success waits (`--after-success`) and `report-outcome`** (2026-09-29). `--after` releases a
  node when every station's TURN ends; a turn ending is not the task succeeding (a station can give
  up, answer its own question or produce something broken, and end its turn cleanly), and #521 only
  catches a turn that ERRORED. So a station says how its task went —
  `report-outcome --outcome succeeded|failed [--note <line>]` — and `open-terminal --cmd` /
  `open-claude` / `open-agent --after-success <id,id> [--success-deadline <90m|12h|3d>]` waits for
  a reported success. Grammar, the persisted shape and the pure evaluation are ONE module,
  `@shared/station-outcome`, used by desktop main's shape gate, the Server Edition's parser AND
  headless factory, and the renderer's launch loop, so the two shells cannot disagree about when a
  dependent starts. `report-outcome --notify-opener` (#1356) also sends the opener one app-written
  notice through `deliverStationNotice`, to the recipient the failure monitor uses (each shell passes
  the same `opener` pair to both); a shell that passes none refuses the flag. It speaks only when
  the outcome the opener last HEARD changes (`StationOutcomeStore.openerHeard` — process-local,
  dropped with the report), never when the previous RECORD had the same outcome: a report made
  without the flag, or whose notice was not sent, told the opener nothing, and a flagged repeat of
  it must still wake the orchestrator. Rules a refactor must not undo:
  - **A success wait is `--after` plus the report.** Every `--after-success` id is FOLDED INTO
    `pendingLaunch.after` (renderer: once, right after `prWaitPre`; server: before `resolveAfter`),
    so the existing rules apply unchanged — the station must exist and report status, the wait rope
    is drawn and deleting it is the escape (`dropAfterDep` now drops the success half too), the
    `--run-now` / `--project` refusals, #521's errored-turn hold. The hold
    (`pendingLaunch.afterSuccess = {deps, deadlineAt}`) adds only "and it reported success". It is
    also the downgrade story: a build that ignores the field still waits for the turn.
  - **One grammar; the ambiguous form is refused by name.** `--after a1:ok` (any `:` in `--after` —
    node ids never contain one) is refused pointing at `--after-success`, not answered "no such
    node"; an id in both flags is refused ("name each station once").
  - **The matrix** (`evaluateSuccessDep`): `failed` BLOCKS (never fires; `list` BLOCKED BY FAILURE,
    badge ⚠ BLOCKED, tooltip names the station and its note); `succeeded` is met once the station's
    turn is over without an error; no report = waiting (no news is never success); a DELETED station
    counts only if it reported success before it went — the one place this differs from `--after`,
    where a deletion is satisfied, because closing a station is how an orchestrator abandons a failed
    attempt. Only a canvas-control agent can run `report-outcome`, so waiting on anything else is
    refused (`successDepRefusal`, checked where `--after` is checked). Deadline: the `--pr-deadline`
    grammar and bounds (`parseWaitDeadlineArg`, one parser for both), EXPIRED badge, `list` EXPIRED,
    ▶ / `run` start it (`planRunVerb` treats the hold like `--after`).
  - **The report is core's, and never read from a git-shared file.** `core/station-outcome-store.ts`
    holds it in MAIN (desktop) / the server process: a renderer reload does not lose it, and since
    the durable-state change an app restart does not either — it is mirrored to the machine-local
    `<userData>/orchestration-state/station-outcomes.json`, BOUND to the session that made it (see
    **Durable orchestration state**). The board-log line (`station-reported`, on the station's own
    card, NEVER_COLLAPSE) is display only — `project.json` and the board log are git-shared, and a
    success anyone can commit would release every dependent. `report-outcome` is verified-only
    (`requiresVerified`) and a node reports only about ITSELF: `--node` naming another node is
    refused (`report-outcome-not-self`), not ignored. The note is display text (`sanitizeOutcomeNote`:
    `oneLine` + format chars stripped, 200 code points) and is never typed into a pane.
  - **When a report ends — the "new task" rule, decided by when work REACHES THE PANE, never by
    when a control answer comes back.** A later report supersedes. Otherwise, "hand a station its next
    task, then open a dependent `--after-success` on it" releases the dependent on the PREVIOUS task's
    success. The first version withdrew the report on the `send`'s ANSWER, which for a busy station is
    `queued` (ok: true) long before the message lands — so the station's report for the task it was
    still on counted, its turn ended, D fired, and the queue flushed the new task on the same idle edge
    (review of #1034). Now:
    - `send` / `reply`: the messaging layer emits `AgentMessagingDeps.onHandover` — `queued` (the
      queue's own `onQueued`, synchronous at the push), `landed` (bytes reached the pane: `delivered`,
      `stalled`, `deliveredToReplacedTarget`, on a first attempt or a flush, `at` = when that attempt
      STARTED), `settled` (one per `queued`: flushed, refused on flush, or expired). The store
      (`StationOutcomeStore.onHandover`) marks a queued station WORK PENDING — its reports publish with
      `workPending` and do not count — withdraws reports older than a landing's start (so a report
      about the new work survives a stalled or late answer), and on a settle that never landed
      withdraws the report too (holding, not the old success; the orchestrator was told it expired).
      Only `send` / `reply` count: a board comment is a person steering and a station notice is the app.
    - `write` / `run`: their answer IS the landing (typed after the confirm; a held launch delivered),
      so `clearOutcomesAfterControl` withdraws reports older than the answer, from each shell's
      control handler (desktop `finishAnswer`, which runs on a late answer too).
    - A new TURN clears nothing (a turn is not a task: a station may report mid-turn, and a person
      typing "thanks" starts a turn), nor does typing in the pane. Closing a station keeps its report
      (the deleted-station rule reads it). Every rule errs toward holding, which the deadline and ▶ end.
    `main/station-outcome-handover.test.ts` replays the review's scenario through the REAL queue and
    fails on the answer-time rule.
  - **Both shells**: desktop main answers the verb before the forward; the Server Edition answers it
    through the same `handleReportOutcome` (`onRecorded` re-runs `refreshArmed`) and honours
    `--after-success` in the headless factory (`successFacts`: the mirror's `done`, the fresh-spawn
    `awaitingFirstWorking` rule, and #521's errored turn from its own event stream, `lastTurnErrored`
    — so a succeeded-then-errored station holds on both editions; the server's PLAIN `--after` still
    does not apply #521, a pre-existing gap). Both wire `onHandover` into their messaging deps and run
    `clearOutcomesAfterControl` on answers.
  - **The badge's deadline tick is a memo input** (`lib/useSuccessWait.ts`): nothing in any store
    changes when a deadline passes, and a timer whose tick the memo ignores re-rendered the node with
    the cached "waiting" — the badge kept QUEUED while `list` said EXPIRED. `useSuccessWait.test.tsx`.
  - Reports survive an app restart, so a station that reported success and was then CLOSED still
    counts for its dependents afterwards; one CLOSED without a success report reads BLOCKED ("closed
    without reporting success") and only ▶ / `run` start that dependent. A station that starts a
    DIFFERENT session loses its report (below). Both agent bodies say so.
    `station-outcome:list` is in `HOST_ONLY_CHANNELS` (unscoped: every project's notes); relay tabs
    take the inert stub. Pinned at source level by `main/station-outcome-wiring.test.ts`. **Not
    done:** a reported `failed` does not raise a station-failure notice to the opener (the opener
    reads BLOCKED BY FAILURE in `list`) — a candidate trigger for `@shared/station-notice`; the kanban
    card and the phone show no outcome (the phone never sees `pendingLaunch`).
  **Headless start (`--run-now`, `run`, #925):** `open-*` with `--run-now` into a project that is
  not on screen starts the new node's held launch at once instead of "when next viewed". A node
  with nothing held (an `open-terminal` without `--cmd`) has nothing to start, and gets the plain
  cold-open reply. `run --node <id> [--project <id>]` builds nothing: it claims and starts the held
  launch of a node that already exists, the CLI twin of the QUEUED badge's Run now (like ▶, a `run`
  that starts the node overrides its `--after` wait). Into a project that IS on screen `--run-now`
  changes nothing: the mount path already starts the node.
  - **Flow.** For `--run-now` the renderer first builds the node as a cold open; `run` starts from
    the node as stored. Either way it then writes an
    `executor:'core', attempted:true, manualOnly:true` claim to disk BEFORE any spawn (never
    spawn on an unsaved claim: a failed save restores the original launch and starts nothing,
    `claim-not-saved`). Desktop main's `pty.launchHeadless` runs core `launchHeadless` on
    `desktopHeadlessRequest(req)`: `createHeadless` (client 0), then settle a fresh shell (200 ms
    quiet / 1.5 s silence cap, under an absolute `SETTLE_MAX_MS` = 5 s ceiling that output never
    extends — nothing cancels this wait, and a pane that keeps painting never goes quiet), then the
    mounted writer's trust rule (`trustsFreshShell`, `@shared/launch-trust`: a fresh session-host
    session is trusted without a probe; every other pane must pass `isLaunchShell`, and an unknown
    answer is `no-shell`, nothing typed), then the echo-verified writer (`@shared/command-delivery`),
    then `releaseHeadless`.
  - **The IPC is desktop-only and host-only.** It is registered in `src/main`, not in core
    `registerIpc`, so a Server Edition browser cannot reach it (ws-bridge declares it
    `unsupported`), and `IPC.ptyLaunchHeadless` is in `HOST_ONLY_CHANNELS`, so a relay peer that
    sends the raw request is refused host-side.
  - **Remote nodes are fenced twice.** The primary fence is the renderer's: `startHeadless`
    answers `remote-unsupported` before any claim for every node of an SSH project (`project.ssh`)
    and for a node carrying `ssh` / `sshRemoteTmux`, and leaves its launch exactly as it was. The
    project is asked, not only the node's flags: a node of an SSH project may carry neither.
    Behind it is core's belt: `headlessPtyOptions` sets `requireRemote` for an SSH-project
    (`sshRemoteTmux`) node, and `desktopHeadlessRequest` keeps it while stripping `sshRemote`.
    So if such a node ever got past the fence, core's `spawnNew` would refuse it (`spawn-failed`)
    instead of starting a LOCAL `nt-<id>` wearing its identity. `desktopHeadlessRequest` also
    strips `viewerId` (a create under a viewer id subscribes `(0, viewer)`, while
    `releaseHeadless` detaches `(0, PRIMARY)`, so client 0 would stay attached forever) and
    `clearEnv` (a one-shot recycle flag, never a launch option).
  - **Why release the client.** An invisible client would fight the viewer's window size and
    keep the session "attached" for the reaper forever.
  - **No persistent backend** (tmux or session-host): releasing a plain shell would kill it, so the
    start fails `not-persistent`. In the normal case that happens before any spawn
    (`persistentSpawnAvailable`). In the race where the backend goes away between that probe and
    the spawn (tmux switched off in between), the spawn yields a plain shell; the launcher refuses
    it the same way, before typing anything, and its release kills that shell. Either way the node
    is handed back exactly as it was, so a cold open degrades to an ordinary queued node.
  - **Outcome patch.** It lands wherever the node lives at that moment (`savePendingAnywhere`):
    the live canvas if the user switched there mid-start, otherwise the store copy plus a disk
    write. `delivered` clears the launch; `not-persistent` restores the original (above); every
    other launch failure keeps the claim and marks the node failed (amber ⚠ QUEUED, recovered by
    Run now).
  - **While starting.** `launchDelivery` holds `starting`: the badge reads STARTING, ▶ is disabled
    (a click would splice a second copy into the pane), `launchesToFire` skips the node, and
    `list` names it. Canvas's delivery sweep spares it (`deliveriesToRetire`): the node lives in
    ANOTHER project by design, so "not armed on this canvas" does not mean "delivered".
  - **Notice.** A batch that started at least one session raises ONE sticky "Go there" notice
    (`headlessStartNoticeText`). A launch failure after the claim (`spawn-failed`, `no-shell`,
    `line-too-long`, `cancelled`) shows on the badge (amber ⚠ QUEUED) and in the reply.
    `not-persistent`, `claim-not-saved` and `remote-unsupported` show only in the reply: the node
    reads as it did before the attempt.
  - **`--run-now` with `--after` is refused on both editions**, before any node is built, with the
    shared `RUN_NOW_AFTER_REFUSAL` (`@shared/control-verbs`): "start now" and "start when X is
    done" contradict each other.
  - **`run` gates.** `run` is verified-only (`requiresVerified`), reaches another project only
    through `--project` + the existing grant gate (`PROJECT_TARGETABLE_VERBS`), and is
    `stored-node` off screen. The renderer's `--project` belt is ONE pure resolver,
    `resolveProjectTarget` (`lib/projectOpen.ts`), shared with the open verbs. A project ON screen
    never starts headless (`planRunVerb`): `run` there uses the mounted writer (the ▶ path) when
    the node has one. Without one, a plain queued launch replies `queued` / `starts-when-mounted`,
    because the mount delivers it; a `manualOnly` or `--after`-armed launch is refused with
    `run-not-mounted`, because the mount fires neither, and "starts when mounted" would be a
    promise nobody keeps.
  - **Server Edition.** It accepts `--run-now` as a no-op (its opens are already immediate) and
    implements `run` under creator ownership, resolving the node through the ownership record,
    never by first id match. It neither unhides a closed project nor raises a notice, the same as
    its other immediate opens. Its immediate open delivers through the same launcher with
    `release:false`: the attached client is what keeps even a plain shell reachable there.
  **Settings (`settings`, 2026-09):** `settings [--project <id>]` lists, `settings --get <key>`
  reads, `settings --set <key> --value <v> [--project <id>]` asks to change — flags only, because the
  shim drops a positional sub-action for an unlisted verb and an SSH host can still be running an
  older shim. The pure `@shared/settings-verb` is the whole rule set, shared by the desktop dispatch, the
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
  **Station-failure notices (2026-09, `src/core/agents/station-notice.ts` + the pure
  `@shared/station-notice`):** when a station an agent OPENED stops, that agent is told ONCE,
  with its options (retry or wait / reassign / skip / stop), instead of having to poll `list`.
  Load-bearing rules:
  - **The trigger is a closed table (`STATION_TRIGGERS`), first match wins:** `dropped` (the
    renderer's DROPPED verdict, about a station core does not know to be mid-turn or asking),
    `turn-errored` (a verified `done` carrying `errored`; a verified new turn OR a clean `done`
    retires it — it describes the LAST turn), `question-unanswered` (the status mirror still holds
    the station's correlated `pendingQuestion` 15 min after the verified event that asked it,
    `STATION_QUESTION_NOTICE_MS`, AND the recipient's own verified state is `done`). An unknown
    never triggers, and only VERIFIED events move a station: a notice leads an orchestrator to
    retry, reassign or END a workflow, so a forgeable event is not evidence. 15 min because the
    human already got NEEDS YOU + a notification; an orchestrator reassigning seconds before the
    user answers doubles the work.
  - **A permission prompt is NEVER a trigger, and that is a measurement, not caution.** On the main
    thread Claude paints its dialog CONCURRENTLY with our held hook (docs/hook-reply-approvals.md),
    and an approval given in the pane fires nothing until the approved tool FINISHES — so neither
    `blocked` nor a `pendingId` can tell "unanswered" from "approved, twenty-minute build running",
    and a notice there invites the orchestrator to close a working station. A question can be told
    apart: its answer is a tool result, and the mirror's `pendingQuestion` is held across unrelated
    traffic until it arrives. The monitor reads it through `pendingQuestionOf` (required dep)
    rather than re-deriving it.
  - **Once per episode, re-armed ONLY by a successful turn** — a turn that started after the notice
    and ended `done` with no error, no interruption and not the idle-prompt rescue — and the re-arm
    clears every fact the episode was about (error, DROPPED, question), or the next sweep re-fires
    it. The condition merely clearing does not re-arm: a usage-limited station fails again on
    every retry, and re-notifying each time would be a loop that burns the orchestrator's turns
    all night. The notice says so in its own text.
  - **Core withdraws DROPPED itself, on ANY verified hook event from the node** (the CLI speaking
    from inside the pane — the renderer's own self-heal in `agentStatus.setState`). It must not
    wait for the renderer's `reportDropped(false)`: the renderer's record of what it reported and
    its transient flag both die with a reload (⌘R, a Server Edition tab closing), and a verdict
    nobody withdraws re-fired on the healthy station after its next successful turn — typed into
    the orchestrator with "reassign: close it" as an option (the independent review's blocker).
  - **The recipient is the OPENER, and a rope alone cannot name it.** An `--after` station is roped
    to every station it waited on as well as to its opener, with the same `ctrl-<src>-<dst>` id, so
    "the other end of the rope" can be a sibling that opened nothing. The open verbs therefore
    STAMP `data.openedBy` where they draw the opener's rope (`connect` for the live paths —
    addAndConnect, verify, spawn-team — plus the off-canvas and cold-open writes; pure helper
    `lib/stationOpener.ts`), and `stationRecipient` requires BOTH: `openedBy` names a canvas-capable
    agent node in the same (single) project, AND that node's OPENER rope to the station still
    exists — never a `ctrl-after-` wait rope (deleting the rope detaches the station). Never a bridge-linked node. `openedBy` is git-shared,
    so `safeOpenedBy` (`isSafeNodeId`) runs at both serializer seams, and a duplicate drops it. A
    node opened before this build has no `openedBy` and is never attributed (no guessing).
  - **Server Edition: the creator LEDGER is the recipient rule** (`stationRecipientFromOwner` over
    `factory.openerOf`) — only stations opened during the current server run, the same creator rule
    as every other verb there; a restart clears it.
  - **Two legs.** The canvas leg needs no switch: a `station-failed` board-log line on the
    RECIPIENT's card (`from` = station id, `to` = reason code, `title` = the capped one-line
    title; in `NEVER_COLLAPSE`) and a STATION FAILED chip (`components/StationFailedChip.tsx`, one
    component on the node header and the card modal; the tooltip says whether the pane leg landed,
    so "stayed on the canvas because messaging is off" is visible). The pane leg is
    `deliverStationNotice` = the messaging service's WHOLE gate chain (scope, the per-project
    `agentMessaging` switch — off by default ⇒ canvas only — runtime pane ownership, flow limits,
    idle gate + deliver-on-idle queue, receipt, trace) under an internal verb
    `STATION_NOTICE_VERB` that is deliberately NOT in `AGENT_MESSAGE_VERBS`, so neither the IPC
    guard nor the shim can ask for a notice with a body of its choosing. The pane leg is followed to
    its END so the chip never says "queued" about a message that landed or lapsed: a queued
    notice's flush or expiry comes back through `AgentMessagingDeps.onQueuedResult` (called from
    `createDeliveryQueue`, read at call time). Two outcomes get exactly ONE more attempt, each
    because it would otherwise lose the pane leg for a reason unrelated to the notice:
    `rateLimited` (the station `send`s its result, then errors seconds later — the pair budget is
    spent) retries after the limiter's wait, capped at 60 s; an expiry (the orchestrator stayed busy
    past the queue's 5-min TTL) is offered again on the orchestrator's next verified `done`. Two differences from
    `send`, both because the APP is the author: the body is `stationNoticeBody` (fixed text from
    the table; the only station-influenced string is the title, `oneLine`d, capped at 80, quoted,
    and labelled data — NO station output is ever quoted), and the Server Edition's creator check
    runs reversed (`callerOwnsTarget(recipient, station)`). The pane leg honouring the switch is
    deliberate: the app typing into an agent's session is the capability that switch grants.
  - **DROPPED is the renderer's fact** (it needs `hibernated`/`paused`), forwarded as EDGES by
    `lib/stationNoticeWiring.ts` over `stationNotice.reportDropped`; the monitor never measures a
    pane. Both request channels are in `HOST_ONLY_CHANNELS`: a relay guest never measured the
    host's panes (its tab takes the inert stub), so a raw DROPPED report from one is a spoofed
    verdict, and `station-notice:list` is unscoped — every project's failed-station ids and titles
    — which a guest bound to one project must not read. It is therefore only as available as the liveness check, which asks for WATCHED nodes:
    a station that dies off screen is noticed when it next comes into view, and a Server Edition
    with no browser tab attached reports no DROPPED at all. Widening the check to unwatched
    stations costs one pane read per finished station per 30 s (an ssh exec on SSH projects) and
    is a deliberate follow-up, not an oversight.
  - **Both shells wire it and nothing type-checks that:** desktop main feeds
    `stationNotices.onAgentEvent(enriched)` from `emitAgentStatus`; the server's canvas-control
    `onAgentEvent` feeds its own monitor; both call `registerStationNoticeIpc`. Pinned at source
    level by `main/station-notice-wiring.test.ts`, along with every stamping site. Relay tabs take
    the inert stub (a relay tab's stations are the host's). Mobile: N/A — the notice reaches the
    orchestrator's pane, which the phone's chat view already shows.
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
  host whose transcripts and tmux it reads, and SSH projects are a desktop-only concept. Discovery is the `get-linked-context` skill in each consented
  context-link-capable agent's own skills dir (since #744; the old marker block
  `<!-- nodeterm:get-linked-context:start/end -->` in AGENTS.md / GEMINI.md is stripped — see
  **Agent-integration consent**). On connect a one-line discovery note is typed into each endpoint
  (claude → skill pointer; codex/gemini → inline CLI command via `contextLink.info()`) — **only into
  an idle agent at an EMPTY prompt** (issue #1144: it used to be a bare `sendText` gated only on
  `state !== 'working'`, so it was pasted in front of the user's half-typed draft and the Enter
  submitted both as one prompt, and a `blocked`/`waiting` pane would have had its dialog ANSWERED).
  Two halves: the renderer's `linkNoteRefusal` (`renderer/lib/noteLink.ts` — the ⌘M composer's
  `chatSendRefusal`: never working / waiting / blocked / CLI gone) and core's
  `PtyManager.sendToEmptyPrompt` (`pty:send-to-empty-prompt`, both shells), which reads a STYLED
  capture with `readClaudeComposer` (`shared/agents/claude-screen.ts`) and writes only on `empty`,
  inside `serializePaneWrite`. MEASURED on Claude Code 2.1.301 (fixtures
  `__fixtures__/claude/composer-capture.json`): the empty composer's placeholder is SGR 2 (dim), a
  draft is not, shell mode (`!`) is a draft. Only dim text counts as placeholder, so a capture that
  lost its SGR reads `draft` — the safe direction. Emptiness is therefore provable only for an agent
  in `SCREEN_DIALOG_READABLE` (claude); **every other agent gets no note** (`unsupported`). A refused
  note is DROPPED, not queued — the link is the capability (pull-based), the note only advertises
  it, and a note arriving minutes later is the same unsolicited prompt at a moment nobody chose —
  and every skipped endpoint is named in ONE info strip (`linkNoteSkippedNotice`). Residual: a
  keystroke in the milliseconds between the capture and the write.
  (Replaced the earlier MCP-based bridge.)
  **One-way links (issue #852):** a context bridge may carry `reader` (`BridgeLink.reader`, the ONE
  endpoint allowed to read the other); absent = both read, which is every pre-#852 link, so old
  `project.json` files load unchanged. The rule is `linkReadPairs` (`shared/canvas-link.ts`), and
  `buildLinkMap` is where it BITES: the non-reading side gets no map entry, so main serves it no
  document and the resolver refuses it — enforcement is at the read, not in the discovery note. A
  `reader` naming neither endpoint, or any present non-string value, authorizes nobody (fail closed)
and is carried VERBATIM through every conversion — dropping it as "absent" would widen it to two-way
on the next save. Set it from the context-link
  edge's right-click menu (both / A reads B / B reads A; arrowheads point at the reader — a rope
drawn over a hidden link resolves it by endpoint pair via `contextLinkForEdge`) or with
  `link --one-way` (`--from` reads). On the canvas it rides `edge.data.reader`; every bridge↔edge
  conversion goes through `bridgeToEdge`/`edgeToBridge` (renderer/lib/noteLink.ts; CLI-planned
bridges enter live state only via `appendBridgeEdges`) and the server
  merge keeps it (`serverChange.edgeRef`) — a field-by-field `{id, source, target}` copy silently
  turns a one-way link two-way again. A flip that GRANTS read access sends the same one-shot
  discovery note a new link sends; losing access sends nothing, like removing a link. Note: the
  premise "every submit triggers a full read" does not hold — nothing reads on submit; the linked
  agent reads only when it decides to run the skill/shim. What one-way removes is the other side's
  PERMISSION and its discovery note. **Team sync carries it too**: an `edge-upsert` of kind
  `bridge` keeps `reader` through the diff, the shape gate, the reflector's sanitize and the peer's
  apply (`edgeFields`/`sameEdge` in `shared/canvas-mutations.ts`), and a flip alone is a change. A
  three-id copy there never cast a flip and landed a cast one-way link on the peer as both-read,
  which the peer then saved and published back. A malformed reader on the wire REFUSES the op
  (never dropped — dropping widens), and a rope never carries one.
  **Note links:** a sticky note can be connected to ANY terminal node (one-way, sticky →
  terminal). On connect, agent sessions get a one-shot push of the note text
  (`buildNotePushMessage`, single-line, truncated at 2000 chars) through the SAME empty-prompt gate
  as the context-link note above (#1144); plain terminals get no push (the text would execute). The note's live text also rides
  the link file (`ContextLinkInfo.note`), so Claude reads the current text via the
  get-linked-context CLI (`summary`/`transcript` print it; `list` marks `(note)`). Pure
  edge/push/map logic in `renderer/lib/noteLink.ts`.
- **Managed Claude accounts** (Claude-only) — run several logged-in Claude identities side by
  side by giving each its own config dir. `settings.claudeAccounts` is a list of `ClaudeAccount
  {id, label, email?, host?, pending?, createdAt}` (in `settings.json`; the account **list** is
  config, not credentials). Isolation is **config-dir**, not token storage: a local account's dir
  is `{userData}/claude-accounts/<id>` (`claudeConfigDirFor` / pure `accountConfigDir`),
  a **remote** account's is `~/.nodeterm/claude-accounts/<id>` on its `host` (keyed by
  `sshHostKey` = `user@host`; `remoteAccountConfigDir` is `~`-relative for ssh expansion,
  `remoteAccountConfigDirAbs` resolves it against the connection's `remoteHome`). The **claude
  CLI owns login, credential storage, and token refresh** inside that dir — the app NEVER writes
  credentials. On macOS this works because Claude Code **≥ 2.1** scopes its Keychain service per
  config dir (`Claude Code-credentials-<sha256(configDir)[:8]>`, `claudeKeychainService`); on
  < 2.1 one unscoped service is shared → accounts collide, so add-account **warns** (`claude
  --version`, `isSupportedClaudeVersion`).
  - **`data.accountId` (terminal nodes)** — resolved **once at node creation**
    (`resolveNewNodeAccount`: explicit submenu pick → `project.defaultAccountId` → system default
    `~/.claude`), then **persisted** (serializers) and changed ONLY by an explicit **account switch**
    (below). `undefined` = system default
    = **bit-for-bit legacy behavior** (no env touched). Inherited by **Branch** (the
    terminal→chat fork it also fed is gone — the SDK chat node was removed 2026-07). Two #419
    rules inside the resolver: the submenu's **System row passes `null`** (an EXPLICIT system
    pick that skips the project default — before that, the row wearing the system email launched
    the project-default account), and validation runs against `accountsForProject`, not the raw
    list, so a **pending** account or one **pinned to another machine's host** is never stamped
    onto a node it cannot run on (both used to reach the missing-dir fallback at spawn).
  - **Switch Claude account (running node)** — node right-click → *Switch Claude
    account ▸* moves the conversation onto another account **already logged in** on this machine,
    with no `/login` in the pane. It works because a transcript carries **no account identity**
    (measured on 2.1.280: under a config dir lacking the file `--resume` says "No conversation found";
    with the file copied into `<configDir>/projects/<encoded cwd>/<id>.jsonl` only the login is
    missing). Choreography = "Restart agent and shell" with a `beforeRecycle` step
    (`agent-restart.ts`): exit the CLI (refused while working/blocked) → core
    `claudeAccounts.copySession` (`core/claude-session-copy.ts`) → rebind `accountId` → recycle, whose
    respawn gets the new `CLAUDE_CONFIG_DIR` and whose cold restore resumes the same id. Two rules:
    the copy runs **after** the exit, so the source is final and a target that is a byte-**prefix**
    of it is just an older copy (A→B→A) and may be replaced, while a **diverged** target is never
    overwritten; and the rebind is **returned** by `beforeRecycle` and merged into the closure's own
    `updateNodeData`, never set by a separate Canvas `setNodes` in the same tick (React Flow's update
    queue rebuilds the node from the store's copy and can drop it). Builtin `claude` only (the
    `boundAccountId` rule below). **SSH nodes** switch between the accounts pinned to THEIR host (and
    the host's own `~/.claude`): the copy runs ON the host as one generated `sh` script over the
    project's master (`core/remote-claude-session-copy.ts`, tested under a real `/bin/sh`; same
    prefix/diverged rule, via `head -c | cmp`), and `SshProjectManager.remoteClaudeSessionCopy`
    refuses an account pinned to another host. An SSH ctx with no remote leg (Server Edition) is
    refused, never answered from the local disk. Relay tabs: shown disabled.
    **Two more surfaces, one choreography** (`runClaudeAccountSwitch` returns a
    `ClaudeSwitchOutcome` instead of announcing it): the **kanban card** right-click menu gets the
    node's rows from the SAME builder the canvas node menu uses (`accountSwitchRows` → KanbanView's
    `accountMenuItems`), and the **usage popover** puts "⇄ Move N sessions" on each account row —
    every Claude session on this canvas running on that account, on the popover's machine
    (`bulkSwitchCandidates`), is moved to the picked account ALL AT ONCE (`startBulkSwitch`), busy
    ones skipped and counted, one summary line (`summarizeBulkSwitch`). It was one-at-a-time and
    that broke twice: N sessions cost N exits in a row, and a switch reads its node off the live
    canvas when it STARTS, so a project switch mid-run refused every node still waiting its turn.
    An SSH host's load is paced in core (`SshChildGate`, the pty spawn gate), not by serializing.
    While it runs, Canvas hands the popover `accountMove`: the moving sessions keep their OLD
    account until each lands, so the source row reads "Moving N sessions…" instead of re-offering
    them, and every other row's move is disabled (a second bulk move would be refused).
    **A recycling restart can outlive its canvas** (`settleRecycledNode`): if the project was
    switched while the CLI quit, React Flow no longer holds the node and `updateNodeData` is a
    silent no-op — the rebind then goes into the stored project (`projects.rebindNode`) and the
    park is DROPPED, because it holds the session this recycle just killed and re-adopting it on
    return showed a dead pane on the old account. The cross-project board (GlobalKanbanView) does not offer it:
    its cards belong to other projects' canvases, whose nodes have no restart closure mounted.
  - **`boundAccountId(accountId, agentId)` (`shared/agents/account-binding.ts`) is the ONE rule for
    whether a node is account-bound at all**, and it feeds `data.accountId` *and* the account color
    from a single decision — split them and a node carries an account it is not painted for, or is
    painted for one it does not carry. Two surfaces mint nodes and both ask it: `createAgentNode`
    (canvas) and `appendProjectNode` (the phone's `projects.registerNode`, which used to write
    whatever the wire sent, so a gemini node could come back bound to a Claude account). Managed
    accounts belong to the builtin **claude and codex** (S6); a **known** other agent — builtin or
    custom, since a custom agent inheriting one of those harnesses is still its own agent — never
    binds. **An UNSTATED agent keeps its binding** — the asymmetry is deliberate: the phone chooses
    `agentId` and `accountId` independently and is not known to always send the first
    (docs/ios-protocol-migration.md §6), dropping a real binding is the wrong-identity bug the
    field exists to prevent, while a stray one on an agent-less node only sets a config-home
    variable nothing reads. On the canvas `agentId` is always stated, so that path is bit-for-bit
    what it was. `main` resolves the color off the RAW id and lets the registrar refuse it, rather
    than re-deriving the gate at the call site.
  - **Account default node color (`ClaudeAccount.color` / `CodexAccount.color`, optional)** — a
    per-account default node color (Settings → Accounts) that beats the agent's own brand color in
    `createAgentNode`, so a second login is recognizable on the canvas. Read off the SAME
    `boundAccountId` that stamps `data.accountId`, so the color and the binding cannot drift.
    Applied **at creation** and baked into `data.color` like any other node color: a hand-picked
    node color is never overwritten and editing the account later repaints nothing. Unset / stale
    id / an agent that takes no managed account ⇒ the agent's color, unchanged.
    **Which list answers is `agentAccountColor`'s alone** (`shared/agents/account-color.ts`, one
    definition shared by `createAgentNode` and the phone-registered node path in `src/main`):
    claude reads `claudeAccounts`, codex reads `codexAccounts`, everything else reads nothing. The
    two lists are keyed **independently** — nothing stops the same id appearing in both — so a node
    colored from the other list would be repainted from a stranger's row; the swatch UI is one
    component (`AccountColorSwatches`) rendered by both row kinds for the same reason.
    The value is **re-validated as a string** at the read: the account lists come out of a
    hand-editable settings.json that nothing checks field-by-field on load, and a `"color": 123`
    would throw on `.trim()` INSIDE `createAgentNode` — stopping every new node under that account
    from opening, with nothing pointing back at the edited file.
  - **Env injection** — `pty-manager` sets `CLAUDE_CONFIG_DIR` in the spawn env AND as a tmux `-e`
    (local); for a remote node it emits an **absolute-path** remote tmux `-e` built from the
    connection-cached `remoteHome` (skipped **fail-open** if home is unresolved). `AUTH_ENV_STRIP`
    (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) is deleted from the
    child env so a stray env key can't shadow the account. A **missing** account dir → warn +
    silent system fallback. **The account-scope names ride the LOCAL conf's `update-environment`
    (`ACCOUNT_SCOPE_UPDATE_ENV`, issue #419)** — the shared tmux server inherits the env of the
    client that STARTS it, so a server started by a managed-account node used to leak that
    account's `CLAUDE_CONFIG_DIR` (and any un-stripped auth key) into every session created
    without a `-e` override: system nodes, plain terminals and the missing-dir fallback silently
    ran as that account ("the system account is entangled with the next account in the list").
    Listing the names makes tmux copy each from the creating client's env and **strip it when the
    client lacks it** (proven against a real tmux in `account-env.realtmux.test.ts`, seeded-server
    case included; `ensureUpdateEnvKeys` retrofits a long-lived pre-fix server). The same listing
    is what makes codex's explicit system-scope overwrite (`CODEX_HOME` /
    `NODETERM_CODEX_ACCOUNT_ID`) actually reach sessions on a shared server. **LOCAL conf only**
    — the remote conf must NOT get these names: a remote attach client's env is the login
    shell's, and the copy/strip would run against that wrong environment (pinned in
    `ssh.test.ts`).
  - **Login flow** — Settings → Accounts → **Add** creates a `pending` account and drops a canvas
    **login node** that runs `claude /login` under the account dir. Core polls the dir's
    `.claude.json` (`LOGIN_POLL_MS` 2 s, up to `LOGIN_TIMEOUT_MS` 5 min) for `oauthAccount.email`;
    on capture the account flips out of `pending` with its email as the default label. Account
    removal cancels any pending wait + `markDirty`. **A removal that deletes the dir first MOVES the
    account's Claude sessions to the system account** (`renderer/lib/accountRemoval.ts`): a running
    `claude` keeps the account's `CLAUDE_CONFIG_DIR` in its tmux env, so deleting the dir under it
    left the CLI logged out and repainting half-blank. Active canvas → the ordinary switch
    (`runClaudeAccountSwitch` to system), or copy + recycle for an idle node the switch cannot drive;
    other projects → `copySession` + tmux kill (they cold-resume on next open). Any busy session, or
    one that could not be moved, refuses the removal and keeps the account. Linked accounts and a
    disconnected host's account delete nothing, so they skip the move. **Codex accounts have the same two halves** —
    `createCodexAccountLoginNode` (`codex login`, title "Codex login") behind the
    `nodeterm:add-codex-account-login` listener, with `codexAccounts.waitLogin` polling the managed
    home's `auth.json`. **On Windows the Codex identity comes from that `auth.json`'s id_token JWT
    email (`readCodexAuthEmail` — a display label, unverified; the gate stays the real-file check),
    never the app-server**: `ws+unix` cannot dial there (`codexAppServerReachable`), so no daemon is
    started per poll and the codex title read degrades to the relayed copy. Shared assets go in via
    `linkSharedEntry` (junction / hardlink / warned copy — never a blocking EPERM; POSIX unchanged).
    Both flows mint an **agent-less terminal** carrying only `accountId`, and
    that shape is why `needsCodexAccountScope` takes an `isCodexAccount` resolver rather than
    reading `!!accountId`: the two account lists share an id alphabet, so the id alone cannot say
    which provider it belongs to. Guessing "codex" refused every managed **Claude** node (#345);
    guessing "not codex" would let `codex login` write into the system `~/.codex`. A dispatch with
    no listener is a silent no-op, which is how the Codex half shipped inert (#346) — pinned now by
    `renderer/lib/nodeterm-events.test.ts`, which fails on any `nodeterm:*` event that is sent but
    never heard. **All THREE login factories take a `cwd`** (`createAccountLoginNode`,
    `createCodexAccountLoginNode`, `createSystemLoginNode`), and every call site passes the active
    project's — a login node with none starts in `$HOME`, and an agent CLI whose trust check is
    keyed on the cwd (Claude Code's is) then asks the user to trust their entire home directory,
    SSH keys and cloud credentials included, before an OAuth round trip that touches no files
    (issue #553; a persisted "yes" there grants that workspace for good). It is not a promise the
    prompt disappears — an untrusted project still prompts — it makes it the exception rather than
    the rule, without nodeterm writing another tool's trust config on the user's behalf. A
    **remote** login ignores the local path: `createTerminalNode` prefers `ssh.remoteCwd`, which is
    the only cwd that means anything for a session running on the host. An SSH project has no local
    `cwd`, so a LOCAL account added from one still opens in `$HOME` — the honest answer, since that
    project owns no local directory.
  - **The lifecycle is CORE, and both shells register it** (issue #313) —
    `core/claude-accounts-service.ts` owns the five `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove / link) behind `platform().handle`; `main/claude-accounts.ts` is a thin desktop
    wrapper and `registerCoreHandlers` calls the same `registerClaudeAccountsIpc()`. Two optional
    deps carry everything core cannot reach: `installSkill` (desktop passes `installCanvasSkillInto`;
    an enabled Server canvas-control runtime installs its Server-specific skill separately) and
    `remote`, a **thunk** resolving the SSH legs
    (desktop's manager is created after the registration, and the server has none — in both cases
    an `AccountCtx` carrying a `projectId` degrades to the LOCAL path, which is the pre-existing
    behavior this preserves). **Three surfaces:** Desktop unchanged (same channels, same shapes,
    same remote fallbacks); **Server Edition** now full — real `buildClaudeAccountsApi` over the
    ws-bridge (the 5-min `waitLogin` is a straight passthrough because RpcClient has no request
    timeout), minus SSH accounts and the canvas skill; **Mobile: N/A** — the phone launches with
    the accounts the agent-status mirror advertises and never mints one. **Managed CODEX accounts
    stay desktop-only** and their bridge namespace stays an `E_UNSUPPORTED` stub: the switch verbs
    authorize the owning window by Electron WebContents id, which has no meaning over a WS
    connection. The Settings section now *names* that refusal instead of leaving an unhandled
    promise rejection — a spinner that stops and says nothing reads as a dead button.
  - **Hook install** — the managed hook is merged into **each account dir's** `settings.json` at
    add-account **and** at app launch (local, shared `install-helper.ts`) / via
    `RemoteHooks.installIntoAccountDir` (remote), so every identity reports agent status. The
    launch-time loop is ONE function (`installHooksIntoLocalAccounts`, beside the service) that
    both shells call — the desktop passing the canvas skill as its `extra`. A second copy is the
    drift this file warns about elsewhere: the Server Edition shipped without the per-account leg
    entirely, so a managed account there reported no agent status at all.
  - **Shared system skills (`shareSystemSkills`, issue #643, OFF by default)** — Claude Code resolves
    user skills as `join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'skills')` (MEASURED, 2.1.266), so an
    account dir **replaces** `~/.claude/skills` rather than adding to it and a fresh managed account
    shows only the skills nodeterm installed (that was #438). The isolation is correct and often the
    point; this per-account switch (Settings → Accounts) is the way back in.
    **Each system skill is linked INDIVIDUALLY** (`<accountDir>/skills/<name>` →
    `~/.claude/skills/<name>`), never the whole `skills` directory, and that choice is what makes
    everything else safe: `installCanvasSkillInto` writes *into* `<configDir>/skills/`, so a
    directory-level link would put nodeterm's canvas skill in the user's SYSTEM skills folder, and
    "turn it off" would have to restore a directory it had first moved aside. Per-skill links keep
    the account's `skills/` a real directory and make the off-switch a link removal.
    MEASURED with strace: Claude Code opens a symlinked entry inside `skills/` as a directory and
    reads its `SKILL.md` exactly like a real sibling — per-skill links are equivalent to the
    whole-directory link for discovery, not a compromise.
    - **Ownership is name-anchored**: an entry is ours iff it is a symlink whose target normalizes
      to exactly `join(systemSkillsDir, <that entry's own name>)`. What ON creates is precisely what
      OFF removes; a real directory is never ours, whatever its name — so "never delete through the
      link" is a property of the plan (`core/claude-skill-share-core.ts`, pure + mutation-tested),
      not a promise about the applier. Removal is `unlink` then `rmdir` (a Windows junction refuses
      `unlink`); both fail on a real non-empty directory, which is the second line of defence.
    - **`NODETERM_OWNED_SKILLS` (`manage-nodeterm-canvas`, `get-linked-context`) is never linked and
      never pruned.** Their presence in an account dir is decided by nodeterm's own installers; if
      sharing linked them, the off-switch would delete a skill the canvas-control installer had put
      there and the two owners would fight over the name at every launch.
    - **The realpath refusal is load-bearing.** The issue's manual workaround
      (`mv skills skills.bak && ln -s ~/.claude/skills skills`) makes the account's `skills/`
      RESOLVE to the system one; linking into it would plant links in the user's own folder and let
      the off-switch delete them from there. The planner compares REAL paths and refuses
      (`same-directory`), which also covers a linked account whose `configDir` was hand-edited to
      `~/.claude`.
    - **Windows uses a directory JUNCTION** (`fs.symlink(target, path, 'junction')`), not the `'dir'`
      symlink `worktree-shared-paths.ts` must use: a junction needs neither Developer Mode nor
      elevation, and every target here is an absolute directory — the two conditions it has. On
      POSIX Node ignores the type. So the feature is available on every desktop platform rather than
      gated off one.
    - **The launch sweep re-links but NEVER removes** (`installHooksIntoLocalAccounts`). ON has real
      work at boot (a skill added to `~/.claude/skills` since the last run; a stale link to prune);
      OFF is a removal, and ownership here is inferred from a link's SHAPE, which cannot tell our
      link from an identical hand-made one — and a LINKED account's dir is the user's own
      `~/.claude-2`, where exactly that is a normal thing to find. Removal therefore happens only
      through `claude-accounts:set-skill-sharing`, where the intent is explicit. The cost: a
      settings.json hand-edited to `false` while the app was closed keeps its links until the switch
      is flipped.
    - **The switch flips the filesystem FIRST and persists the flag only if that returned** — the
      flag is what the sweep replays, so a stored `true` whose links were never made would make the
      switch lie until the next boot. A refusal stores nothing.
    - **The copy says the edits flow both ways**, because a link is not a copy: editing a shared
      skill from inside the account edits the machine's own file. A user who reads "share" as "copy"
      finds that out by losing work. Result sentences are the pure `renderer/lib/skillSharing.ts`.
    - **Surfaces.** Desktop: full. **Server Edition: full** — the whole implementation is core, so
      the ws-bridge leg is a real passthrough and the machine the browser is served from is exactly
      the machine whose `~/.claude/skills` is shared (the canvas skill is not installed there, but
      its name stays reserved: a reserved name that is never created is inert). **SSH accounts:
      explicitly out of scope for v1** — their config dir is on the host, so the option would have to
      link that host's skills over the ControlMaster, with its own generated-shell proof obligation.
      The switch is DISABLED with that reason (never hidden), and core refuses (`remote-account`) as
      the backstop for a hand-edited settings.json. **Mobile: N/A** — the phone never mints an
      account and carries no skills concept.
  - **Account-aware readers** — transcript resolution is scoped per account (`transcriptRootFor`
    picks the account dir's `projects/`, composite cache key includes `accountId`); the same
    threading runs through the session-name poll, restart handoff, and `ChatPanel` (the ⌘M
    transcript view, `chat.readTranscript`). The **usage indicator** is per account (`claude-usage.ts`: scoped Keychain
    service only for managed accounts, then their credentials file; popover lists a row per account with **System**
    first). **Remote (SSH host) accounts are included** — see **Remote usage** below.
  - **Pickers** — New Claude exposes an account **submenu** (pane menu; flat entries in
    the dock; palette commands; TabBar sets the **per-project default**). A **local** project
    lists local accounts, an **SSH** project lists only accounts whose `host` matches its
    connection; both offer a **System account** option. An SSH project whose host has **no**
    matching accounts gets a disabled hint row instead of a bare System-only list
    (`sshAccountsHint` — pane submenu, dock, TabBar; the palette deliberately omits it: a
    disabled row would surface as a search result) saying accounts for this host are added in
    Settings → Accounts while the project is connected — local accounts being invisible there is
    correct (their credentials aren't on the host) but read as "multi-account is broken on SSH".
  - **Remote accounts** — selection + login + env injection, plus **usage** (below); no
    per-account transcript readers beyond env.
  - **Settings → Accounts is ONE machine-grouped surface for BOTH providers** (2026-09): a panel
    per machine (this one, then each saved SSH server ∪ the active project's server — a saved server
    with no accounts and no connection is folded into a footnote count), each holding a Claude and a
    Codex block with the SAME row, system row and Add button (`groupAccountsByMachine`). A remote
    machine's Add / Retry / Remove act ON that host over a **connected** project only — a
    disconnected host's Add is disabled and its Remove only forgets the record (the dialog says so);
    a remote id never reaches a LOCAL remove. Codex gained the remote lifecycle this needed:
    `codexAccounts.add/waitLogin/identity/remove` take an SSH `ctx` (desktop `src/main/codex-accounts.ts`
    → the `SshProjectManager.remoteCodex*` legs; the credential is written on the host by
    `codex login --device-auth` — the default browser flow calls back to the HOST's localhost), and
    `systemIdentity({projectId})` now asks the host instead of answering `null`.
  - **The remote spawn scopes the account BY PROVIDER** (`core/remote-account-env.ts`). It used to
    hand every `accountId` to Claude's `CLAUDE_CONFIG_DIR`, so a node bound to a managed Codex account
    on an SSH host got a Claude dir that does not exist and NO `CODEX_HOME` — its codex silently ran
    as the host's system login (`remoteCodexTmuxEnvArgs` existed with no caller). The system Codex
    account is left to the host's own env (a remote `CODEX_HOME` of the user's — a snap remap — must
    win).
  - **Switch Codex account on an SSH node** (2026-09) does NOT use the local three-phase reservation
    (it plans rollouts in LOCAL homes). It is one host-side exposure —
    `codexAccounts.switchThreadRemote` → `SshProjectManager.remoteCodexSwitchThread` →
    `remoteCodexExposeThread` (relay `expose-thread`): resolve the thread across every account
    catalog on the host, hardlink the one authoritative rollout into the target home, verify the
    target's app-server discovers it, roll the link back if not; an ambiguous thread is refused.
    Then the usual still-eligible check and a restart-shell recycle, with the rebind riding
    `beforeRecycle` (never a separate setNodes). A hardlink, not a copy: both accounts see ONE file,
    so there is no diverged-copy case. Needs the relay runtime on the host (node + codex + curl);
    without it the switch fails with a notice and nothing changes. `planCodexAccountSwitch` now
    refuses a target on another machine than the node (`hostKey`) — the switch never crosses
    machines (moving a local conversation to a host is `transferThreadToSsh`, a separate flow).
  - **Linked accounts** (`ClaudeAccount.configDir`) — a PRE-EXISTING local config
    dir the user already drives themselves (`export CLAUDE_CONFIG_DIR=~/.claude-2; claude …` in a
    plain terminal) adopted as a first-class account without a login node. Settings → Accounts →
    **Link existing config dir…** (or one click on a **Detected** dir) calls `claude-accounts:link`
    (core service): `~` expansion → `normalizeLinkedConfigDir` → string-only refusals (the system
    `~/.claude`, anything under `{userData}/claude-accounts`, an already-linked path) → `stat` →
    email from `<dir>/.claude.json` (missing = `email: null`, not an error) → managed hook install.
    `claudeConfigDirFor(id)` consults a **registered accounts source**
    (`registerClaudeAccountsSource`, both shells right after `settingsStore.init()` — BEFORE the
    mirror settings provider can flush, or the phone would be advertised a non-existent managed
    dir), so env injection, `transcriptRootFor`, the transcript index, usage rows and the pickers
    all resolve a linked id to the user's own dir with no per-caller branch. The transcript jails
    (`isSafeLocalTranscriptPath`, both raw listeners) accept `<linkedDir>/projects/**` for dirs
    **from settings only** — never a dir named by the POST. **Removing a linked account only
    forgets the record**: the `rm -rf` names `accountConfigDir(userData, id)` directly, so it is
    structurally incapable of reaching outside the managed root even if the settings row is gone
    before the IPC lands. The hook installer resolves `settings.json` symlinks and atomically updates their target
    (without replacing the link) — a profile whose `settings.json` symlinks to `~/.claude/settings.json` (the
    two-profile layout) stays a symlink; pinned by `claude-accounts-link-symlink.test.ts`, and
    switching that write to `renameAtomic` would be the regression (it replaces the link).
  - **Observed account** (`ObservedClaudeAccount`, `NormalizedAgentEvent.account`) — which account
    a session is ACTUALLY on, derived by the hook server from the payload's `transcript_path`
    (`<configDir>/projects/<slug>/<session>.jsonl`; `configDirFromTranscriptPath` walks up to the
    LAST `projects` segment, so `~/projects/.claude/projects/…` names `~/projects/.claude`, not
    `~`). `classifyClaudeConfigDir` is pure string matching, host-agnostic: managed local root →
    managed remote pattern (`…/.nodeterm/claude-accounts/<id>`) → linked (settings) → any
    `…/.claude` ⇒ system (`accountId: null`) → else `known: false`. It is a **LABEL** exactly like
    `verified`/`clientRevision`: attached to the normalized event in ONE place (the hook server),
    so both shells inherit it and neither raw listener changes; claude events only; never throws;
    **never reads the filesystem** (a forged POST naming `~/.ssh/projects/x` gets `known: false`
    and nothing is opened). Recorded by the mirror (`MirrorEntry.account`) and the renderer store
    (`agentStatus.account`, persisted like `agentId` — a hand-launched claude's identity exists
    nowhere else). **Effective account for READERS** = `data.accountId ?? observed.accountId`
    (`renderer/lib/accountChip.ts` `effectiveAccountId`): `readSessionName`, `context.ensure`, the
    transcript search and the ⌘M view use it; **spawn/env never does** (launch identity stays
    creation-time). The **account chip** (`components/AccountChip.tsx`, ONE component on the node
    header, kanban card, card modal and sidebar row) shows for any non-system account, and for
    system panes only when ≥ 2 distinct account keys (`sys` / `<id>` / `ext:<dir>`) are live on the
    core (`hasMultipleAccountKeys`, a primitive selector so headers don't re-render on every hook
    event). An unlinked dir is named by its last path segment (`.claude-2`, dashed chip) with a
    tooltip pointing at Settings → Accounts, where **Detected config dirs** lists it for one-click
    linking. Mobile: N/A (additive mirror fields).

- **Active Claude organization** (#552) — local Desktop and Server usage snapshots carry optional
  `organization` metadata from the SAME account's `.claude.json` (system, managed or linked).
  Read it even if Keychain/file credentials already have an email; unreadable/missing metadata
  preserves the email and usage. A known email mismatch drops metadata. Managed usage cannot use
  an unscoped Keychain token: a matching email alone does not prove it belongs to the same org.
  The popover names the org beneath the email; internal type/tier/id remain tooltip details.
  Refresh re-reads metadata together with usage; normal cache/poll intervals still apply.
  SSH's existing shell reader does not supply organization metadata and keeps its email-only
  fallback. Mobile's usage mirror currently omits it; displaying orgs there needs a follow-up
  mirror/iOS protocol change. No organization picker, credential writes or switching are added.

- **Bottom chrome shares a measured width budget** (issue #853). `CanvasPills` observes the canvas
  wrapper and actual dock, bounds the left row with an 8px gap, and uses a row above the dock when
  fewer than 200 CSS pixels remain. Rects are converted back through UI scale. Usage summary text
  ellipsizes; refresh never shrinks. Do not clip the whole row or give it a stacking context:
  usage/RAM popovers must escape independently above the sidebar and board. Desktop and Server
  share this renderer. The real-browser regression is `scripts/usage-layout.test.ts` (`CHROME_BIN`).

- **The usage indicator is scoped to the ACTIVE project** (`renderer/lib/usageScope.ts`, pure +
  unit-tested) — it describes **the machine that project runs on**, and nothing else. A local
  project shows this machine (system + managed local accounts + the billing providers, whose
  credentials are all local); an **SSH project shows that host's Claude and Codex accounts** — no local
  Claude, no local providers, no other host. Without this the panel showed every source at once:
  each addition was individually reasonable and the sum was unreadable, numbers from three
  machines sharing one line with nothing saying which was which. Deliberately NOT narrowed to the
  project's `defaultAccountId`: the local side lists every local identity, so the machine is the
  scope and the account is a row within it. The pill spells out the scoped machine's **system**
  account (falling back to the first identity with data, so a host used only through a managed
  login isn't blank), managed accounts stay popover-only — the rule the local side always had.
  `usageScopeKey`/`scopeFromKey` exist because the active project object is rebuilt on every node
  serialization: the zustand selector returns ONE primitive so the indicator doesn't re-render on
  every canvas edit. ⟳ refreshes only what is on screen, and `usage.remote({hostKey})` reads only
  that host (cache eviction still runs against the FULL target list, so switching between two SSH
  projects doesn't throw each host's cache away).

- **Grok billing failures** retain per-view HTTP status or a safe timeout/network/invalid-response category in `ProviderUsage.diagnostics`. The default view still runs after a credits failure; recovered limits keep their diagnostic. Only two successful empty views imply no quota. Never include raw exceptions, URLs or response bodies, or refresh/write credentials. Desktop and Server share the core reader and popover; provider-only errors must keep the pill visible.

- **Usage failure readouts** — an empty Claude snapshot with `status: error` says "Could not
  read usage." in both the single-account and multi-account popovers, including beside healthy
  provider rows. Nonempty snapshots retain their last-known bars on error; no error-specific
  authentication advice is inferred from the status.
  **Local Codex reads (issue #1168)**: an HTTP 429 from the backend returns `rateLimited` and
  starts a per-home cooldown (`Retry-After`, else 2 min doubling, 30 s–1 h); during it NEITHER
  tier is asked — the app-server fallback reads the same account's limits, so falling through
  after a 429 spent the budget twice. The service holds each account row's last good numbers
  (`holdLastGoodProvider`). The SSH Codex reader has no cooldown yet.

- **Remote usage** (SSH hosts, `src/core/usage/remote-claude-usage.ts`) — the source behind the
  SSH scope above. v1 excluded remote accounts, which left a user whose Claude only ever runs on a
  server staring at an empty indicator while the host had perfectly good numbers.
  **The token never leaves the host.** The desktop could `cat` the remote `.credentials.json` and
  call the API itself — it already reads remote transcripts over the same master — but a bearer
  token pulled off a (possibly shared) server into another machine's memory buys nothing: the host
  can make the request itself. So core generates a POSIX **sh+curl** command, the shell runs it
  over the project's ControlMaster, and only the JSON answer comes back. Three details are
  load-bearing:
  1. **The token is piped into `curl --config -`, never `-H` on the command line** — argv is
     world-readable via `ps` on a shared host.
  2. **`.credentials.json` holds more than one `accessToken`** — every MCP server the CLI has
     authorized keeps its own under `mcpOAuth`. The extraction narrows to the `claudeAiOauth`
     object first (exactly as the local `parseCreds` does), because grabbing the file's first match
     sends an MCP token to the endpoint, earns a 401, and reports a signed-in host as signed out.
     Caught only by running the command against a REAL credentials file — which is why
     `remote-claude-usage.test.ts` runs the generated script under a real `/bin/sh` against a fake
     `$HOME` + fake `curl`, the same discipline as the canvas-control shim.
  3. **A read that could not run is `error`, never `unavailable`** — a dead master says nothing
     about whether the account has a subscription, and 'unavailable' silently drops the row.
  4. **A failed read keeps the last good numbers** (`holdLastGood`, local AND remote): the
     endpoint answers **429** on a budget every Claude CLI using the same login also spends
     (measured on a host running 54 `claude` processes: 429 for minutes on end), and replacing
     the bars with "Could not read usage" made rows flicker for no change in the account. The
     held snapshot is `status: 'error'` + the old limits + the OLD `updatedAt`, so the debounce
     must key on the READ's time (`lastFetchAt`/`remoteCache.at`), never on `updatedAt` — keying
     it on the numbers' age re-reads on every call and hammers the endpoint that said 429.
  Shape: `remoteUsageTargets` (pure) elects ONE connected project per host (several projects share
  a host's `$HOME`) and offers its system `~/.claude` plus every managed account pinned to that
  host. The service (`usage:remote`) caches per target under the usual debounce, evicts targets
  whose host disconnected, and coalesces concurrent reads. **On demand, never polled** — each row
  is an ssh exec plus an HTTPS request on someone else's machine; the renderer asks on mount, on
  popover open, on ⟳, and when the active project's connection comes up (an SSH project is opened
  before its master is ready). Deps are injected exactly like
  Context Link's (`src/main` supplies the ControlMaster; **Server Edition passes none** ⇒ `[]`, so
  the UI needs no capability check). Own Settings switch (`claude-remote`), because hiding local
  Claude usage must not silently take the hosts down with it. **Mobile: N/A** — the
  slice pushed to a host still drops `usage` (a host reading its own numbers back off us is
  pointless), and no keychain leg exists remotely (a headless macOS host would hang on the prompt,
  so a mac host reports nothing).

- **Codex SSH usage** (`core/usage/remote-codex-usage.ts`) uses host-side Node JSON parsing
  and curl, reusing the local Codex quota mapper. Read only `tokens.access_token` and
  `tokens.account_id`; pass headers through stdin, disable curl config/redirects, and return
  only sanitized quota fields. Never download credentials, refresh tokens, or launch a remote
  app-server just to refresh usage. The host needs Node and curl; missing tools/transport or
  malformed responses are errors, not proof of a logged-out account. System reads use the
  host login environment's `CODEX_HOME`; managed reads use the validated account's remote
  home. Cache identity includes provider, host, account and connection/home identity.
  Remote Codex rows obey the Codex visibility setting and carry no Claude default-account
  or bulk-move actions. Desktop supports SSH reads; Server Edition keeps its local core
  readers and absent SSH dependency. The private mobile reader is separate. Device checks:
  `docs/codex-ssh-metrics.md`.

### Adding a new agent (or a new model) — what to watch out for

Every rule below is a mistake the grok branch or the codex/gemini-parity branch **actually made**, and
each one cost a review round or shipped a wrong number to the user. Read the concrete failure, not the
principle. Per-agent write-ups: `docs/grok-agent.md`, `docs/gemini-agent.md`.

**The mechanism**

1. **A capability is a membership list plus ONE leaf.** Add the id to the list in
   `src/shared/agents/config.ts`, write the one per-agent thing that list gates (a normalizer, a
   reader, a table row), and every consumer lights up — the whole point of the design. What you must
   never do is fork behavior at a call site with `=== 'claude'`; ask through the helper.
2. **Ask what ELSE the list gates before joining it.** `hasUsage` gated **three** features, not one.
   Joining `USAGE_CAPABLE` for the context meter also switched on `context.ensure` and the find bar's
   transcript index, both of which resolve through *claude's* `resolveTranscript` — whose **cwd
   fallback** then handed a codex node **the newest claude transcript for that cwd**: a stranger's
   session as its meter (wrong numerator *and* denominator, flapping against the correct tail) and that
   session's messages as its search hits. Preconditions were default-true, so it would have shipped.
   The fix was a new pure predicate (`readsClaudeTranscript`) reusing an existing list, not a fourth
   list meaning the same thing. **Grep every consumer of the helper before you add an id to its list.**
3. **A read leg and a write leg are different facts, and may need different lists.** Gemini names its
   own sessions but has **no rename command**, so `TITLE_READ_CAPABLE` (read) split from
   `RENAME_CAPABLE` (write), with `read ⊇ write` pinned as an invariant. One list would have lit the
   rename UI on a node where the write silently does nothing — the worst kind of feature, one that
   looks like it worked.
4. **State Desktop / Server Edition / Mobile for the capability, even when the answer is "N/A".**
   Put the logic in `src/core` behind `CorePlatform` or the Server Edition silently doesn't have it,
   and give `window.nodeTerminal` a REAL bridge implementation or a documented degrade — a `noop` stub
   compiles fine while doing nothing. (Live example: the session-title READ has no server handler at
   all, so it is stubbed for **claude too** — a pre-existing gap that keeps being rediscovered per
   agent.)

**Measuring the CLI**

5. **Measure the CLI; do not assume claude's shape.** Three real bugs, all from assuming:
   - grok's `--` is **end-of-options**, so a flag appended *after* the prompt separator is a
     positional — silently swallowed into the prompt, or a clap usage error that kills the launch.
     Where the flag lands is decided at the **composed** layer (`createAgentNode`); a
     `withPermissionMode` unit test passes while the composed line is wrong.
   - codex's `total_token_usage` is **CUMULATIVE**, not the live context: against its own window it
     rendered a 13%-full session at **79%** and would have crossed 100% two turns later. The right
     field is `last_token_usage`.
   - `cached` tokens are **INSIDE** `input` for codex and gemini, and **OUTSIDE** it for claude (whose
     reader therefore sums them). Copying claude's formula double-counts. **Do not unify the
     formulas.**
6. **Prefer the agent's own stated number over one you infer.** Codex prints
   `model_context_window` right beside its usage — use it. When there is none, mirror the CLI's own
   resolver rather than building a per-model allowlist: gemini's `tokenLimit()` is a family rule with
   a **1M catch-all default**, so an unreleased model gets the *right* answer where an allowlist would
   be confidently wrong, silently. **And if you cannot establish a trustworthy denominator, ship no
   meter** — a percentage over a guessed window is a wrong number presented as a fact. This used to
   cite grok as the example of having no meter; grok turned out to be the BEST case for this rule,
   stating `contextTokensUsed`, `contextWindowTokens` **and** the resulting `contextWindowUsage` in
   `signals.json` (all three present in 22 of 22 measured sessions, and the stated percentage agrees
   with the division in all 22 — an oracle pinned as a test). What was missing was never the number:
   it was a comment nobody could check, naming the wrong file.
7. **A closed set beats a substring, for notification/event types.** Grok's
   `type.includes('permission')` matched a notification grok fires before *every* tool call, so a
   working node strobed NEEDS YOU: unread dot + chime + OS notification + phone inbox card, per tool
   call. Gemini is matched `=== 'ToolPermission'` and stays quiet on an unknown type. A badge stuck on
   a finished node has no later hook to clear it, so widening "to be safe" is the unsafe direction.
8. **"Supports" can be as dishonest as "doesn't support."** Codex claimed `manual` / "Ask each time"
   while emitting **no flag** — but its built-in default is `OnRequest` ("the model decides when to
   ask"), so two dropdown entries collapsed onto one behavior under a label that promised otherwise.
   Rule: a mode the CLI cannot express emits **no flag** (never a substituted nearest match), and a
   mode it *can* express must actually emit it. Derive the UI copy from the mapping
   (`unsupportedModesNote`, `permissionModeAgentIds`) so a sentence cannot drift from the table.
   **The nearest match is most dangerous on the DEFAULT mode:** gemini has no value for `auto`, and
   `auto` is `DEFAULT_PERMISSION_MODE`, so translating it to `auto_edit` ("auto-approve edit tools")
   would have widened permissions for every existing gemini node at upgrade, with `modeSupported`
   answering `true` so the derived copy stayed silent. Check what an UNTOUCHED setting emits before
   you accept any mapping.
9. **A capability gate that is fed by a version probe belongs to the agent it probes.** Claude's
   `auto` gate is fed by `claude --version`; applying it to any other agent downgrades that agent's
   sessions on a machine whose *claude* is old or absent. `activePermissionMode` gates only
   `'claude'`, and every hint string names Claude for the same reason. An agent needing its own gate
   adds one beside claude's.

**Not writing the same rule twice**

10. **A duplicated rule drifts, and this branch was bitten three times.** The remote installer's hook
    event lists (it subscribed gemini to *claude's* event names, so remote gemini reported nothing at
    all), grok's raw-listener field decoding, and the two shells' session-name sweep gates (reverting
    both to `canRename` left the entire suite **green** while silently skipping every gemini node).
    The fix each time was **one definition in `src/core`** consumed by both shells — a default inside
    core beats an argument each shell passes correctly today.
11. **Both shells' raw hook listeners must stay in parity** (`src/main/index.ts`,
    `src/server/agent-status.ts`). If you add a branch to one, add it to the other or write down why
    not (the desktop's extra skip for remote SSH nodes is a legitimate asymmetry: the server has no
    SSH-project manager).
12. **Widen the transcript-path jail per ROOT, never to `$HOME`.** Hook POSTs can arrive over the
    remote reverse tunnel, and `isSafeLocalTranscriptPath` exists so a forged one cannot aim a read at
    `~/.ssh/id_rsa`. Add the narrowest directory that holds the transcripts (`~/.gemini/tmp`,
    `<codexHome>/sessions`) and honor the agent's own relocation env var — getting that wrong fails
    **closed** (the meter silently never fills), which is the quieter and therefore worse failure.
13. **Re-validate a hand-editable value at the interpolation site, not by its type.** Modes come from
    git-shared JSON and end up on a tmux `send-keys` line. A table lookup guarded only by
    `mode in table` accepted a forged `constructor` and returned a **Function** headed for that
    command line; `isPermissionMode` at the top of `approvalFlags` is what closes it. Same rule as
    `SAFE_SESSION_ID`. An unrecognized value must yield the **bare, safe** command.

**Degrading, and admitting what you did not measure**

14. **A guess must degrade to nothing, never to something wrong.** A title reader that cannot resolve
    returns `null` (the node keeps its own name); an unknown notification type is a no-op; a failed
    probe means the bare command, never a blocked launch. Say in the code which facts are *composed*
    rather than captured (gemini's resumed-transcript shape is) and what the wrong-guess cost is.
15. **Kill the "in place" actions carefully.** An exit sequence must be the CLI's documented primary
    and **bare**: gemini's `/quit` also takes `--delete`, which exits *and permanently deletes the
    session history* — the very conversation the restart exists to resume. It has its own test.
    Refuse the restart while the node is `working` **or** `blocked`: an exit line typed into a
    permission prompt **answers** it.
16. **Write the device checklist for what you could not run.** Every unverified claim becomes a
    numbered item; group the ones that fall out of a single capture run. `docs/grok-agent.md` §9 and
    `docs/gemini-agent.md` §9 are the format.
17. **Extend the base harness mapping, never a frontend allowlist.** Model support is
    `MODEL_SWITCH_CAPABLE` plus the protocol/env/flag leaf in `shared/agents/model-gateway.ts`.
    Frontends call `canSwitchModel` / `modelsForAgent`; they never spell Claude, Codex or a custom
    id themselves. This makes `baseAgent:'claude'` inherit discovery, filtering, environment and
    command grammar as one unit instead of four copies that drift.
18. **A model switch must refresh the shell environment without printing the key.** An already-live
    shell does not inherit a later `tmux set-environment`, and prefixing the resume line with
    `KEY=secret` leaks it into the pane/history. SIGTERM the pane's foreground non-shell process
    group (a typed `/exit` can land in the agent composer as prompt text), recycle the persistent
    session, and let cold restore resume with the new model under the newly injected environment.


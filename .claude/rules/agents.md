---
paths:
  - "src/shared/agents/**"
  - "src/core/agents/grok-paths.ts"
  - "src/core/agents/hooks/*.ts"
  - "src/core/claude-cli.ts"
  - "src/core/codex-cli.ts"
  - "src/core/codex-session.ts"
  - "src/core/gemini-session.ts"
  - "src/core/grok-*.ts"
  - "src/core/agent-session-name.ts"
  - "src/core/usage/**"
  - "src/core/handoff/**"
  - "src/renderer/lib/transcriptGates.ts"
  - "src/renderer/state/agentStatus.ts"
  - "src/renderer/state/permissionMode.ts"
  - "src/renderer/state/codexCli.ts"
  - "src/server/agent-status.ts"
  - "docs/*-agent.md"
---

## Agent support (Claude / Codex / Gemini / Copilot / opencode / Grok / custom)

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts).

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
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok** since 2026-09: grok's
  `chat_history.jsonl` gets its own reader, and `chat:read-transcript` routes by agent. That list had
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
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`** (there is none for codex — its approval mapping
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
  the pane. Ordinary Restart stays in-place. Custom-agent env is still merged last and may override
  the shared mapping. Desktop and Server Edition use the same core handler; relay tabs deliberately
  do not apply this machine's gateway to another core. Mobile needs a settings/model-picker surface
  before it can expose the feature.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
  `RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE`,
  `SESSION_ID_CAPABLE` and `SUBAGENT_CAPABLE`. Subagent cards come from grok's native
  `SubagentStart`/`SubagentStop` hooks, keyed by `subagentId` (two parallel `explore` children of the
  same type got different ids; the start/stop keying facts are under **Subagent visualization** in
  `.claude/rules/agent-status.md`). The other four came off the blocked list
  in 2026-09, once a machine with a logged-in grok session produced real fixtures: context links and
  the ⌘M panel read `chat_history.jsonl` (NOT `updates.jsonl` — see **Context Link** in `.claude/rules/canvas-control.md`), and the meter reads
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
  harmful. Permission-mode specifics (the claude-only `auto` gate; grok's flag goes before its `--`): see
  **Permission mode** below. Full picture, dialect traps and the device checklist: **`docs/grok-agent.md`**.
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
    resolver — see **Context-meter rehydration** in `.claude/rules/agent-status.md`; the find bar's index still has no routing and
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

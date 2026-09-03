# Grok as a nodeterm agent

Grok (`@xai-official/grok` 1.0.0, `grok` on PATH) is a builtin agent id alongside claude, codex,
gemini and opencode: `AGENT_CONFIG.grok` in `src/shared/agents/config.ts` — label `Grok`, colour
`#64748b`, `launchCmd: 'grok'`, `promptInjectionMode: 'argv'` **plus** `argvPromptSeparator: '--'`,
`expectedProcess: 'grok'`. Status comes from grok's own hooks, never from parsing output, so
everything downstream of `NormalizedAgentEvent` — the RUNNING / NEEDS YOU badges, the unread dot,
completion notifications, the notch capsule, kanban cards, the phone mirror — lit up the moment
`hasHooks('grok')` became true. Each further capability is one membership-list edit plus the one
leaf that list gates.

> Sibling documents: **`docs/gemini-agent.md`** is the same write-up for gemini. There is no
> per-agent document for codex; its `--ask-for-approval` mapping and the reasoning behind every value
> live in **`src/shared/agents/approval-mode.ts`** (`CODEX_MODES`) and its test. The distilled rules
> both branches produced are the
> **"Adding a new agent"** section of `CLAUDE.md`. Rows below that name another agent were
> re-verified against `src/shared/agents/config.ts` on 2026-08-09; verify them there, not against
> either document, when they matter.

> **Read the caveat before trusting any field name here.** There is no grok binary and no grok
> account on the machine this integration was implemented on. Facts marked *measured* come from the
> plan's reading of the shipped 1.0.0 binary and its docs
> (`docs/superpowers/plans/2026-08-09-grok-agent-integration.md`, "Global Constraints"); facts marked
> *unverified* are guesses placed where a wrong guess degrades to nothing rather than to a wrong
> answer. **§9 is the device checklist** that closes them, and three of the open unknowns collapse
> out of a single capture run (see item 10).

---

## 1. What grok is, capability by capability

Capabilities are membership lists in `src/shared/agents/config.ts`, not a flag bag. What matters for
maintenance is not *that* grok is in a list but **what had to be true before it could join** — that
is the cost of adding the next agent to the same list.

| List | grok | What had to be true first |
|---|---|---|
| `AGENT_HOOK_TARGETS` | **joined** | Five things: a pure normalizer for grok's dialect (`normalizeGrok`, `src/shared/agents/normalize.ts`); a subscription list covering every event grok publishes and `normalizeGrok` maps — **all fifteen** (`GROK_EVENTS`, `core/agents/hooks/grok.ts`); an installer able to write a **per-event matcher**, which meant widening the shared installer's event type to `ManagedHookEvent` (`core/agents/hooks/install-helper.ts`); one definition of grok's path algebra (`core/agents/grok-paths.ts`); and a raw-listener branch in **both** shells (`src/main/index.ts`, `src/server/agent-status.ts`) to derive the session directory (see the `transcriptPath` row below for why we derive it even though grok does send one). |
| `RESUMABLE_AGENTS` | **joined** (pre-branch) | `resumeCommand('grok', id)` → `grok --resume <id>`, and a session id that reaches the renderer — which it does, off every hook payload. **Never resume by TITLE:** `--resume` accepts one, matches it case-insensitively against the current directory's sessions, and fails as AMBIGUOUS on duplicates — so a node that resumed by name would break the day a second session shared it. The node carries its id; the id is what is used. |
| `SESSION_ID_CAPABLE` (minting the id, instead of waiting for a hook) | **joined**, on grok's OWN probe | `core/grok-cli.ts` reads `grok --help` and looks for `--session-id`, anchored on a word boundary. Feature-detection, never a version floor: an unknown flag makes grok **exit**, so a guessed floor kills every launch below it instead of degrading. The anchor is load-bearing twice — `--session-id-file` must not answer yes, and grok's own help MENTIONS `--session-id` inside the description of `--fork-session` (backticked), so a looser match would report the flag from prose alone. It is grok's probe and never claude's (rule 9: a gate fed by a version probe belongs to the agent it probes) — the two CLIs are installed and upgraded independently, and `supportsSessionIdFlag` takes grok's answer as a REQUIRED argument so no caller can silently omit it. Three grammar differences from claude, all measured on 1.0.13: the UUID **must not already exist** under the target session directory (minting a taken one is a launch error, not a resume — `mintFreeGrokSessionId` re-mints instead), `--session-id` combines with `--resume`/`--continue` only alongside `--fork-session`, and `--resume` also accepts a title (see the row above). The flag goes **before** the `--` separator: after it, grok swallows it into the prompt and the node starts looking healthy with a session nodeterm never learns. |
| `RENAME_CAPABLE` + `TITLE_READ_CAPABLE` | **joined both** | A **read** leg that resolves a session's own name *without searching* (`core/grok-session.ts`, keyed off the hook-fed `sessionId → session dir` map), a **write** leg byte-identical to claude's (`/rename <name>` typed into the pane via `pty.sendText`; grok also accepts `/title`), and one routing rule for the readers — `readAgentSessionName` in `core/agent-session-name.ts`, serving the desktop IPC handler *and* both shells' session-name sweeps. The list SPLIT in two after the grok branch (2026-08-09): `TITLE_READ_CAPABLE` is the read leg and `RENAME_CAPABLE` the write leg, because **gemini** names its own sessions but has no rename command. Grok is in both, so nothing about its behaviour changed — but a future agent must pick per leg, and every `RENAME_CAPABLE` member must also be `TITLE_READ_CAPABLE` (pinned in `config.capabilities.test.ts`). Routing is not cosmetic: claude's resolver scans `~/.claude/projects` on a cache miss, so an unrouted grok node paid that scan on every poll for a guaranteed null — a mounted node polls every **4 s** until the name first resolves and **15 s** after (`TerminalNode.tsx`), and the mirror's own `SESSION_NAME_SWEEP_MS` sweep adds one pass a minute. |
| `PERMISSION_MODE_CAPABLE` | **joined** | Grok shares claude's flag **spelling** and value vocabulary (`--permission-mode auto\|plan\|acceptEdits\|bypassPermissions`; our `manual` = no flag = grok's own `default`), which is why *its* membership needed no translation. Two things had to change around it: claude's `auto` **version gate** had to become agent-scoped (`activePermissionMode(agentId)`, `renderer/state/permissionMode.ts`), and the flag had to be emitted **before** grok's `--`. See §6. **Sharing the spelling is no longer what membership means:** the list is now `claude, grok, gemini, codex` (2026-08-09) and the last two spell it their own way (`--approval-mode`, `--ask-for-approval`), translated per agent in `src/shared/agents/approval-mode.ts` — which is also where `withPermissionMode` now lives, moved one layer up to break a `config ↔ approval-mode` cycle. |
| `CANVAS_CONTROL_CAPABLE` | **joined** | Nothing new to install: grok scans `~/.claude/skills` by default for Claude Code compatibility, which is exactly where `manage-nodeterm-canvas` is already written (locally, and on an SSH host by `RemoteHooks.installCanvasControl`). Membership is what sets `NODETERM_CANVAS_CONTROL=1` in the session env — `hook-server.buildPtyEnv` locally, `remoteHookEnvArgs` remotely, both through the single `canControlCanvas` predicate — i.e. what makes the sh+curl shim anything other than a no-op. **The discovery premise is MEASURED, not inferred** (grok 1.0.13, 2026-09-02): `grok inspect --json` lists `manage-nodeterm-canvas` and `get-linked-context` with `vendor: claude` and `compatibilityStatus: enabled`, and `externalCompat.cells` reports `{surface: 'skills', enabled: true, source: 'default'}`. `source: 'default'` is the part that matters: grok reads `~/.claude/skills` with **no** config edit by the user. Two per-user failure modes survive the measurement and cannot be exercised on a default-config machine — `[compat.claude] skills = false` in `~/.grok/config.toml`, and `GROK_CLAUDE_SKILLS_ENABLED=false`. In each, `NODETERM_CANVAS_CONTROL=1` is still set while the skill is undiscoverable: the shim is armed and mute. See §8.7 and checklist 21. |
| `USAGE_CAPABLE` (the per-node context meter) | **joined** | `signals.json` yields both numbers AND the answer: `contextTokensUsed`, `contextWindowTokens` and `contextWindowUsage` — the percentage grok has already computed. Measured on 22 real sessions (1.0.13, 2026-09-02): all three present in all 22, and the stated percentage agrees with used/window in all 22, which is a free oracle and is pinned as a test. The window is READ, never inferred from the model id, putting grok with codex rather than with gemini. The reader (`core/grok-signals.ts`) takes three of the file's 66 keys and returns null unless both numbers are there — no denominator, no meter. Its tail is created with `wholeFile`, because signals.json is rewritten in place rather than appended to; an offset read would hand the parser a JSON fragment and the meter would freeze after its first fill with nothing to say so. The rule this row used to state still holds for everyone: a percentage against a guessed denominator is a wrong number presented as a fact, so no total ⇒ no meter. (The list is now `claude, codex, gemini, grok`; **opencode** is the one builtin outside it. Codex states its own denominator in its rollout; gemini's comes from its model id through `geminiWindowFor`, mirroring the CLI's own `tokenLimit`. See `docs/gemini-agent.md` §4.) **The trap this row used to warn about was real and is now disarmed:** joining this list also switched on two features that read CLAUDE's transcript, because `readsClaudeTranscript` shared a list with them — a codex node once metered and searched a stranger's claude session that way. That gate now reads `CLAUDE_TRANSCRIPT_READABLE` (claude only), pinned in `config.capabilities.test.ts`, so grok joins the meter without joining those. Do not confuse this with grok *billing* usage — see the note below. |
| `CONTEXT_LINK_CAPABLE` | **joined** | Two pieces, both pinned by fixtures cut from real sessions rather than written from the docs: `linesFromGrok` (`core/context-link-render.ts`) renders grok's log, and `locateGrok` (`core/handoff/locate.ts`) finds it. The file is **`chat_history.jsonl`, not the `updates.jsonl`** this row used to name and grok's own hook payloads advertise — routing through the advertised path fails **silently**, handing the reader an empty transcript with nothing logged, which is why the locator pins it. The directory comes from the hook-fed `sessionId → dir` map, never from a scan. The path jail was widened to `$GROK_HOME/sessions` — that subdirectory, not `$GROK_HOME`, because `auth.json` lives in the same tree. Grok is no longer outside this list; the list is now `claude, codex, gemini, opencode, grok`, and the one builtin still outside it is **copilot**. |
| `SUBAGENT_CAPABLE` | **not joined** | Needs the `spawn_subagent` `PreToolUse`/`PostToolUse` payload fields, including whatever marks a **background** launch. Task 11 stops at its capture step. |
| `BRANCH_CAPABLE` | not joined | Branch sends claude's `/branch` and resumes by claude's session id; grok has no counterpart. |
| `CHAT_CAPABLE` | **joined**, and the list was SPLIT to do it safely | `chatMessagesFromGrok` (`core/grok-chat.ts`) builds the panel's bubbles from the same `grokParse` the context-link reader uses, so the two views of one file cannot drift. The channel is now routed by agent (`chat:read-transcript` takes an `agentId`), and that routing is the safety property, not a refinement: claude's `resolveTranscript` falls back to **the newest claude transcript for the node's cwd** whenever its sessionId leg misses, which a grok id always does — so an unrouted grok node is answered with a stranger's conversation rather than with nothing. **The list itself had to be split.** `CHAT_CAPABLE` carried two facts that coincided only while claude was its sole member: "we can render this agent's conversation" and "claude's resolver can locate and parse this agent's file". Grok is the first agent for which they differ, so the second now lives in `CLAUDE_TRANSCRIPT_READABLE` (claude only), which is what `renderer/lib/transcriptGates.ts` reads. Merging them back is a cross-session read of someone else's transcript, and it fails OPEN — it shows data. `config.capabilities.test.ts` pins the pair. |
| `TRANSFER_SOURCE_CAPABLE` | **joined** | `renderGrokTranscript` (`main/handoff/render-grok.ts`) sits beside the claude/codex/gemini renderers and, like them, is registered in `RENDERERS` and `LOCATORS`. It renders through `linesFromGrok` rather than re-reading grok's line shapes, and it gives harness-injected text its own heading — `## Injected (system_reminder)`, never `## User`. That distinction matters more here than anywhere else in the codebase: the receiving agent reads a `## User` heading as an instruction from the person, so mislabelling a skill reminder would hand it someone's tooling as a command. The **destination** list is separate (`transferTargets` derives it from `BUILTIN_AGENT_IDS`) and is untouched: grok was already a valid target, and unifying the two would light a menu over an operation that does nothing. |
| `RECURRING_CAPABLE` | not joined | `/loop`, `/schedule`, `/cron` are detected from claude's `Skill` / `CronCreate` / `ScheduleWakeup` tool names; grok's tool vocabulary for these is unknown. |

**Grok billing usage ≠ the grok context meter.** These are two different features and the plan once
conflated them. Grok has been a **billing usage provider** since main's `a2353f2` (PR #11):
`src/core/usage/grok-usage.ts` reads the CLI's own sign-in and reports weekly credits + monthly
budget; it is registered in `usage-service.ts`'s provider list and has its own Settings → Usage row
(`UsageSection.tsx`, `shared/usage-limits.ts`). That already works. `USAGE_CAPABLE` is the
**per-node context-window meter** in the node header, which grok still has no numbers for — it is no
longer a claude-only feature, though: codex and gemini joined on 2026-08-09. The one place the
two touch is `$GROK_HOME`: `grok-usage.ts`'s `grokHome()` now delegates to `grokHomeDir()` in
`core/agents/grok-paths.ts`, so there is exactly one definition of that rule.

---

## 2. The hook dialect

Grok's envelope is not claude's. **The payloads below were CAPTURED, on 2026-09-01, from grok 1.0.13
(build `5e9a58528b76`) running under a real logged-in account** — the redacted capture is the test
fixture `src/shared/agents/__fixtures__/grok/hook-payloads.json`, pinned by
`normalize.grok.capture.test.ts`. Fifteen distinct event/reason combinations were observed:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionDenied`, `Stop`
(`end_turn` and `shutdown`), `StopCancelled` (`user_interrupt`, `permission_rejected`, `max_turns`),
`Notification` (`idle_prompt`, `permission_prompt`), `PreCompact`, `PostCompact` and `SessionEnd`.
Two fields arrived that nothing reads yet, recorded so a later task does not rediscover them:
`StopCancelled` carries `cancelTrigger` on a user interrupt and `reasonDetails` on a rejected
permission. Neither is read today and neither should be adopted without its own measurement — one
sighting of a field is not its vocabulary.
What that capture cost us to learn is in `PreCompact`'s row below: an earlier version of this file
described the dialect from the docs alone, the tests were written from that same reading, and the
compaction events were rejected on every real payload while the suite stayed green. **A test whose
input we invented pins our reading of the documentation, not the agent's behaviour.**
Rows marked † are the remaining weak ones: inferred from another integration's reader, not from
grok's own documentation, and NOT exercised by the capture. Anything still marked *unverified* was
not produced by the 2026-09-01 run — see §9 for the list and the reason each one was out of reach.

| | claude | grok (file hooks) | grok (SDK-registered hooks) |
|---|---|---|---|
| event key | `hook_event_name` | `hookEventName` | `hook_event_name` |
| event **value** | `PreToolUse` | `pre_tool_use` | `pre_tool_use` |
| session id | `session_id` | `sessionId` | `session_id` |
| cwd | `cwd` | `cwd` (+ `workspaceRoot`) | `cwd` |
| tool name / input | `tool_name` / `tool_input` | `toolName` / `toolInput` | `tool_name` / `tool_input` |
| tool **output** | `tool_response` | **`toolResult`** | `tool_result` |
| transcript file | `transcript_path` | `transcriptPath` **and** `transcript_path` | same |
| last assistant text | `last_assistant_message` | `lastAssistantMessage` | `last_assistant_message` |
| notification kind † | `notification_type` | `notificationType`, `notification_type` or `type` | same |
| turn-end reason | — | `reason` (`end_turn` \| `channel_closed` \| `shutdown`) | same |
| also on every event | — | `timestamp`, `permissionMode` | same |

† Grok 1.0.13 publishes the `Notification` type vocabulary as `idle_prompt`, `permission_prompt`,
and `task_complete` (`~/.grok/docs/user-guide/10-hooks.md:99`), and states that
`permission_prompt` fires only while a permission UI is actually waiting (`:162`). The payload key
aliases remain defensive: file hooks use `notificationType`, the SDK uses `notification_type`, and
the bare `type` fallback comes from orca's reader (`src/shared/agent-hook-listener.ts:2370-2376`).

Consequences, in the order they bite:

- **camelCase keys with snake_case event values.** Both halves are unusual, and mixing them is why
  `normalizeGrok` **canonicalizes** the event name (`toLowerCase()`, strip non-letters) instead of
  comparing literals: `pre_tool_use`, `PreToolUse` and `preToolUse` all reach the same branch.
- **The SDK path flips the keys to snake_case,** so both spellings occur in the wild. Every field is
  therefore read twice (`p.toolName ?? p.tool_name`). The shells do not re-do that reading: they call
  the exported `grokRawFields(payload)`, one definition shared by `src/main` and `src/server`, so
  their two listeners can never drift apart on a dialect detail.
- **`toolResult`, not `tool_response`.** Nothing reads it yet (the subagent cards that would are
  unbuilt), but any future reader must not copy claude's key.
- **`transcriptPath` IS sent — and we derive the session directory anyway, verified to agree.**
  This entry used to read "No `transcript_path`", inherited from a branch written with no grok binary
  and no account. **Measured on grok 1.0.13 (2026-09-01, live capture from a logged-in session):**
  every turn-scoped event carries both `transcriptPath` and `transcript_path`, pointing at
  `$GROK_HOME/sessions/<url-encoded cwd>/<sessionId>/updates.jsonl`. `SessionStart` is the one
  measured exception — it arrives before the session directory exists.
  We keep **deriving** it from `(cwd, sessionId)` via `grokSessionDir()`, remembered in the shells'
  raw listener, and the capture is what lets us say the choice is validated rather than merely
  assumed: **the derived path and the transmitted one are byte-identical** in every captured event.
  Three reasons the derivation stays: `SessionStart` has no path to read, so a reader keyed on the
  field alone learns nothing at the one moment a node most wants its directory; the derived form
  yields the session DIRECTORY, while the field names a file *inside* it (`updates.jsonl`), and the
  other four files we read — `summary.json`, `signals.json`, `chat_history.jsonl`, `subagents/` — are
  siblings, not derivatives of that name; and a remote (SSH) node must resolve the directory under
  the HOST's `$GROK_HOME`, which a path minted on the host is fine for but a locally-jailed reader
  must re-derive regardless. Derived, never searched: a search of grok's sessions tree is how one
  node ends up adopting another node's name. `grokSessionDir` returns `null` (learn nothing) rather
  than half a path when either half is unusable.
  What the field buys us is a **cross-check**, and that is how task12 should use it: comparing the
  transmitted path against the derived one turns a silent layout change in a future grok release
  into a detectable disagreement instead of an empty meter.

All 15 events published by Grok 1.0.13 are subscribed. They map as follows (`normalizeGrok`);
unrecognized values inside a closed matcher vocabulary return `null`, a deliberate no-op:

| grok event | `NormalizedAgentEvent` | note |
|---|---|---|
| `SessionStart` / `SessionEnd` | session `start` / `end` | `SessionEnd` also drops the session's remembered directory |
| `UserPromptSubmit` | `working`, `newTurn: true` | the turn start; `newTurn` is what clears per-turn fan-out once per turn |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `working` | a **failed** tool is still mid-turn — grok fires `PostToolUseFailure` and carries on |
| `PermissionDenied` | `working` | post-decision event: the denied tool did not end the turn, and the permission UI is no longer waiting |
| `Stop` (`reason` anything but `channel_closed`/`shutdown`) | `done` + `lastMessage` | a **denylist**, not an allowlist of `end_turn`: `Stop` is the event the RUNNING badge depends on ending, so an unknown reason must fail towards reporting it |
| `Stop` (`channel_closed` / `shutdown`) | `done`, `interrupted: true` | the observe-only second `Stop` at session close; `interrupted` suppresses the completion alert and unread dot, and the stale `lastAssistantMessage` is dropped |
| `StopFailure` | `done` + `lastMessage` | fires **instead of** `Stop` when the turn dies on an API error — without it the badge sticks |
| `StopCancelled` (`user_interrupt`, session-level) | `done`, `interrupted` | clears RUNNING without an ordinary completion alert/unread |
| `StopCancelled` (`permission_rejected`, `permission_cancelled`, `max_turns`, `no_progress`) | `done` | visible non-interrupted terminal outcome; exact closed reasons only |
| `StopCancelled` with `subagentType`, or reason `unknown` | **no state change** | a child stop is not the session stop; unknown stays no-op so a future busy/cancel dialect cannot become a false completion |
| `Notification` `permission_prompt` | `blocked` | exact published type. **Measured on 1.0.13:** it fired when the approval dialog appeared (`message: "Tool permission requested"`) and did NOT fire for an auto-approved tool call in the same session — the spec's claim (`10-hooks.md:162`) now rests on observation, not on the sentence alone |
| `Notification` `idle_prompt` | `done`, `interrupted`, `idle` | exact published type (`10-hooks.md:99`), **captured live** (`message: "Waiting for your next prompt"`); reuses the mirror's `idleInferred` rescue, so it only clears `working` and cannot erase a live approval |
| `Notification` `task_complete` | **nothing** (`null`) | **NOT captured** — the 2026-09-01 run never produced one (see §9); published as a user-attention type, but the spec does not say it closes a turn; `Stop` remains the turn-end signal, so guessing `done` here would risk a false completion |
| any other `Notification` type | **nothing** (`null`) | closed-set default: a future permission-like name must not leave a sticky NEEDS YOU badge |
| `SubagentStart` / `SubagentStop` | subagent `start` / `end` | child lifecycle only; no invented instance id and no parent-session state transition (`SubagentEnd` is Grok's accepted alias of `SubagentStop`) |
| `PreCompact` / `PostCompact` | compaction `pre` / `post` | no badge transition. **The trigger field is `source` (`manual` / `auto`), NOT claude's `trigger`** — measured; reading only `trigger` rejected 100% of real events while docs-derived test payloads kept it green. Neither event carries a compaction id or a phase field: the phase is deduced from the event NAME, and there is no id to re-key a session association with |

`Stop` fires **once per turn plus once at close** — N+1 times in an N-turn session, the last one
observe-only — and interrupted / refused / max-turns turns **skip `Stop` hooks entirely**.

The configuration uses Grok's canonical `SubagentStop` spelling. Grok also accepts `SubagentEnd` as
an alias, but subscribing twice would only duplicate the same lifecycle signal.

---

## 3. One hook file we own, and the matcher that must be `.*`

Grok's hook config is a **directory**: it merges every `$GROK_HOME/hooks/*.json`. So unlike claude
and gemini there is no shared settings file to preserve — nodeterm **owns one file outright**,
`$GROK_HOME/hooks/nodeterm-status.json` (`GROK_HOOK_FILE`, path built by `grokHookConfigPath()` in
`core/agents/hooks/grok.ts`), and rewrites it wholesale. A user's own hooks live in sibling files in
the same directory and grok merges them; there is nothing of theirs inside ours.

We still route through the shared `installHooksInto`, because three behaviours live there and are
worth more than the twenty lines they cost: the **missing-script guard**
(`buildManagedHookCommand` emits `if [ -r '<script>' ]; then sh '<script>'; else cat >/dev/null
2>&1 || :; fi`, so a deleted script swallows stdin and exits 0 instead of failing the session), the
**idempotent** re-install (a second install leaves exactly one entry per event), and the **sweep**
that removes our entry from an event we no longer subscribe to. All three are pinned in
`core/agents/hooks/grok.test.ts`.

**The tool-event `matcher` is a REGEX, so a bare `*` would silently kill tool events.** grok's docs
call it "a regular expression" (`10-hooks.md:153`), and `*` is not a valid regex at all (nothing to
repeat) — so the expected failure is not an error message: the tool lifecycle hooks simply never fire,
the badge clears mid-turn on a long tool call, and nothing says why. We write `.*`. The same docs say
an omitted matcher already matches everything, so the value is **not required** — it states the intent
explicitly, and it keeps anyone from "fixing" it to `*`. Checklist **3** is what confirms tool events
actually fire with it; nothing here was run against a binary. This is the only reason `ManagedHookEvent` exists: it is
`string | { event, matcher }`, so claude/codex/gemini stay plain strings and their emitted config is
byte-identical to what it has always been, and the installer spreads the matcher **conditionally on
`!== undefined`** (the type permits `matcher: ''`, and silently dropping an empty matcher would emit
a subscription that does not say what its declaration said).

**SSH hosts** get the same file, written by `RemoteHooks.installGrokRemote`
(`src/main/remote-ssh/remote-hooks.ts`), which is separate from the `AGENT_TARGETS` loop for one
reason: grok's config path is **not `$HOME`-relative** when the host sets `GROK_HOME`, which is what
that loop assumes. So the host is asked (`printf %s "${GROK_HOME:-}"`), the answer is validated by
`isSafeRemoteGrokHome` — which judges the **exact** string, treating surrounding whitespace as a
rejection rather than quietly trimming a value whose embedded `\n` would be a command separator on
the command line we then build — and falls back to `$HOME/.grok`. Because the file is **ours**, a
malformed one is **healed** remotely exactly as it is locally; the never-clobber guard is only for
**user** files (codex's `hooks.json`). Every step fails open: a remote grok session simply runs
without status hooks.

---

## 4. The claude-compat cross-fire

Grok also merges **`~/.claude/settings.json`** (and `settings.local.json`, `~/.cursor/hooks.json`,
project `.grok/hooks/*.json`). nodeterm's **claude** managed hook already lives in that file. So
**8 of Grok's 15 events** also fire `claude.sh` and POST to `/hook/claude`: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `Notification`, and
`SessionEnd` — the intersection with `CLAUDE_HOOK_EVENTS`. This is by design left alone — we do not
disable grok's `[compat.claude]` scanning, because it is the user's config and it
is what makes our skills discoverable (§1), and we do not add a cross-agent guard to the shared
managed script, because `pty-manager` passes `options.agentId ?? 'claude'` — `NODETERM_AGENT_ID` is
`claude` for **plain terminal** nodes too, and a guard keyed on it would kill status for anyone who
typed `grok` into a plain terminal.

The extra leg is **inert**, and inertness is a *property with a test*, not a coincidence
(`normalize.grok.test.ts`, "the claude-compat cross-fire is inert"). Two legs, two different
mechanisms:

- **File hooks (camelCase):** grok sends `hookEventName`; `normalizeClaude` reads `hook_event_name`
  and finds nothing.
- **SDK hooks (snake_case):** grok sends the very key claude reads. Here inertness rests **entirely
  on claude's compare being case-sensitive and literal** — `'stop'` is not `'Stop'`.

**The one change that would make this harmful** is therefore lowercasing or canonicalizing
`normalizeClaude`'s event-name compare — the natural-looking "robustness" fix that would make every
grok event normalize twice, under two agent ids, producing duplicate completion notifications and a
badge that fights itself. The second, symmetrical, break would be grok emitting claude's PascalCase
event values from a file hook. If either happens, the fix is a real per-agent guard, not a patch to
the normalizer.

---

## 5. Session layout, the session name, and the fixture's provenance

Measured layout (shipped 1.0.0), encoded once in `core/agents/grok-paths.ts`:

```
$GROK_HOME/                                  # $GROK_HOME, else ~/.grok
  hooks/*.json                               # all merged; nodeterm-status.json is ours
  sessions/<url-encoded cwd>/<session-id>/
    summary.json  updates.jsonl  chat_history.jsonl  signals.json  plan.json  subagents/

Which of those is the conversation is the question this integration got wrong for months, so it is
worth stating exactly (measured on 1.0.13 across 29 local sessions, 2026-09-02):

| File | What it is |
|---|---|
| `chat_history.jsonl` | **the conversation**, one settled message per line — `system`, `user`, `assistant`, `tool_result`, `backend_tool_call`, `reasoning`. Read by context links, the ⌘M panel and transfer. |
| `updates.jsonl` | the ACP event **stream** (`session/update`). It is not empty of conversation — `agent_message_chunk`, `user_message_chunk`, `agent_thought_chunk` are all there — but they arrive as CHUNKS interleaved with `tool_call`/`tool_call_update`, `hook_execution`, `plan`, compaction and subagent events. Reading a message out of it means reassembling one. **Grok's hook payloads advertise THIS path as the transcript**, which is the whole trap: following the advertisement opens a real file, parses to nothing, and yields an empty transcript with no error. |
| `signals.json` | the meter's three numbers, plus 63 unrelated metrics. |
| `summary.json` | the session title and model. |
```

Path rules, all unit-tested in `grok-paths.test.ts`: the cwd is `encodeURIComponent`'d to name the
group directory; past **255 bytes** grok switches to a slug+hash name we cannot reconstruct, so we
resolve **nothing** there (`GROK_ENCODED_CWD_MAX_BYTES`); a session id must match
`/^[A-Za-z0-9_-]+$/` and be ≤ 128 chars, because it reaches both a path *and* — via
`grok --resume <id>` — a shell command line.

The session **name** (what `/resume` shows and what a node title with `titleAuto` adopts) is read by
`core/grok-session.ts` → `pickGrokSessionMeta` over `summary.json`, in preference order
`TITLE_KEYS = ['generated_title']`, plus `current_model_id` as the model. Reads are capped
at 256 KB and answer `null` — never a throw — for an absent, oversized or unparseable file.
Resolution is a **direct open** of the directory a hook told us about: `rememberGrokSessionDir` /
`grokSessionDirFor` / `forgetGrokSession` keep a bounded (512-entry, least-recently-seen-evicted)
`sessionId → dir` map, populated by the shells' raw listeners.

**The fixture is a real capture, with one authored value — and that value caused a wrong call.**
`src/core/__fixtures__/grok/summary.json` was captured from grok 1.0.13 on 2026-09-01; personal
paths and ids are redacted and every key and value type is preserved. But its `session_summary` was
REWRITTEN as a sentence so the fixture could prove which key wins, and a reader later took that
sentence for grok's own output and reasoned from it. Measured across 49 local `summary.json` files:
`session_summary` is never a sentence — 0 to 49 characters, mean 23, and identical to
`generated_title` in 28 of the 29 files that carry both. It is a title, not prose. The fixture now
carries a short title-shaped value, because a fixture that does not look like the real thing is a
loaded trap for whoever reads it next.

The capture has no `title` field. `generated_title` is grok's session name and is now the ONLY title
key: `session_summary` was dropped in favour of resolving to nothing. The reason is the rule this
repo states for itself — an uncertain value must degrade to NOTHING, never to something else — and
`pickGrokSessionMeta` feeds the node title with no length cap anywhere on the path, so a sentence in
that field would reach the header, the sidebar, the kanban card, the window title and
`project.json`. **The cost, stated rather than discovered:** of those 49 files, 20 carry
`session_summary` and no `generated_title` — young sessions, before grok names them. Those now
resolve to no name until grok generates one. No name is a state the UI already handles; a wrong name
is not.

**Not captured at all:** nothing, for the context meter. `signals.json` was the last entry here and
it has been captured (22 sessions): it states the used count, the window total AND the percentage.
The transcript log left this list earlier, and
the entry that used to sit here was wrong twice over: it named `updates.jsonl`, when the readable
conversation is its sibling `chat_history.jsonl`, and it said the gap blocked context links, which
have since shipped off a fixture cut from a real session. Recipes for both, and for the `spawn_subagent` payload, are
Step 1 of Tasks 5, 10 and 11 in
`docs/superpowers/plans/2026-08-09-grok-agent-integration.md`. **Do not add a speculative key to any
parser**: the rule that made these tasks stop cleanly is that an unrecognized shape returns nothing,
never a guessed number.

---

## 6. Permission mode, and the `--` separator trap

`activePermissionMode(agentId)` resolves the project override, else `settings.claudePermissionMode`
(the persisted key keeps its name — renaming it would silently reset every existing user's choice;
only the UI copy changed). Grok accepts `default`, `acceptEdits`, `auto`, `dontAsk`,
`bypassPermissions`, `plan`; our `manual` emits **no flag**, which reproduces `default` exactly.

**The `auto` version gate is claude's alone.** It exists because Claude Code < 2.1.71 *exits 1* on
`--permission-mode auto`, and it is fed by a `claude --version` probe — local, or the SSH host's.
Grok has accepted every mode we emit since 1.0.0, its first release. Applying claude's gate to it
would downgrade a grok session to `default` on a machine whose *claude* is old, or absent entirely.
So `activePermissionMode` gates only when `agentId === 'claude'`, and `ensureActivePermissionMode`
returns immediately for any other agent rather than awaiting a probe it will not consult — an
`await` that in the Server Edition is a real, 3 s-bounded WS-RPC per launch, and on an SSH host
without claude never answers at all. `sshAutoModeHint`'s wording names Claude explicitly for the
same reason: an unprefixed warning on a project that also runs grok sessions would read as a
limitation of the mode itself.

**The flag must be emitted BEFORE grok's `--`.** Grok's usage is `grok [OPTIONS] [PROMPT]
[COMMAND]`, so a one-word prompt collides with a subcommand name — `grok version` prints the version
and exits, `grok -- version` asks the model about "version". That is what `argvPromptSeparator: '--'`
is for. But `--` is **end of options**: everything after it is a positional. So

```
grok -- 'explain this repo' --permission-mode plan     # WRONG: the flag is a positional
grok --permission-mode plan -- 'explain this repo'     # right
```

The wrong form is what **shipped in the first attempt** and was caught by review. Its failure mode is
either silent (the flag swallowed into the prompt text, so the setting does nothing) or a clap
"unexpected argument" that kills the launch — and it hits exactly the prompt-carrying paths:
the transfer submenu, canvas-control `open-agent`, `spawn-team`, and any `pendingLaunch` armed from
them. Prompt-less and `--resume` paths were never affected.

`withPermissionMode` is still the single funnel, but **the assertion belongs one layer up**, at the
composed `createAgentNode` (`renderer/state/workspace.ts`): a `withPermissionMode` unit test passes
while the composed command line is wrong, because `withPermissionMode` only ever appends to whatever
it is handed. `createAgentNode` is where the two opposite conventions are decided — flag **last** for
an agent with no separator (claude, and since 2026-08-09 gemini and codex too, all byte-identical to
what nodeterm has always emitted), flag **before** the separator otherwise — so that is where a
regression is visible. Grok is still the only agent that declares a separator at all (pinned in
`config.capabilities.test.ts`), so it is still the only agent taking the second branch. The resume shape
(`grok --resume <id> --permission-mode X`) is composed outside `createAgentNode` and is pinned in
`agent-restart.test.ts` on the **composed string** — the test calls the same two functions
`TerminalNode` calls (`resumeCommand` then `withPermissionMode`) and composes them itself, so it
catches a change in either function but not a change in the component's call site.

**In-place restart** ("Restart agent (resume)") works for grok: `EXIT_SEQUENCES.grok = '/quit'`
(its `/exit` is an alias; the documented primary is what we type) plus `resumeCommand` is the whole
entry. The refusal while a session is `working` or `blocked` is agent-agnostic (`BUSY_STATES`) and
needs no grok branch — typing `/quit` into a permission prompt would *answer* it. That table is now
`claude: '/exit'`, `codex/grok/gemini: '/quit'`; gemini joined on 2026-08-09, and its entry must stay
**bare** because `/quit --delete` exits *and permanently deletes* the session history — the exact
conversation a restart exists to resume (`docs/gemini-agent.md` §6). The **single-node**
action lives in the node context menu only; the pane menu and the command palette host the **bulk**
"restart idle agents" action. Neither has a header button (`HIDEABLE_HEADER_BUTTONS` is refresh / mic /
ai-name / comments).

---

## 7. The three surfaces

| Feature | Desktop | Server Edition (browser) | Mobile (`~/projects/nodeterm-ios`) |
|---|---|---|---|
| Status hooks → badges, unread dot, notification | yes | yes — `wireAgentStatus` broadcasts the same normalized events, and the grok raw-listener branch is duplicated in `src/server/agent-status.ts` | yes, for free — the agent-status mirror threads `agentId` and is otherwise agent-agnostic |
| Hook installation | `installGrokHooks()` at launch, plus `RemoteHooks.installGrokRemote` per SSH connect | same core installer (`core/agents/hooks/*` is Electron-free) | N/A — the phone installs nothing |
| Session name ⇄ node title | both legs | **write only.** `ws-bridge.readSessionName` returns `''` — a **pre-existing** gap, not a grok one: `IPC.ptyReadSessionName` has never been registered server-side, so claude's read leg is equally stubbed. The fix is to move the routing into core and register it from both shells, exactly as `core/transcript-ipc.ts` did for the ⌘M channels | the mirror's session-name sweep runs in both shells and routes per agent, so a grok name reaches the phone when it resolves at all |
| Permission mode | yes | yes (pure renderer + the mode flag) | **follow-up owed** — see §8 |
| In-place restart + cold-restore resume | yes | yes | N/A |
| Canvas control | yes, via `~/.claude/skills` + the sh+curl shim. The discovery premise is no longer inferred: `grok inspect --json` on grok 1.0.13 lists `get-linked-context` with `vendor: claude` and `compatibilityStatus: enabled`, and `externalCompat.cells` reports `{surface: 'skills', enabled: true, source: 'default'}` — grok reads `~/.claude/skills` **by default**, without a config edit (§8.7) | **not wired at all** — `agent:control` has no server handler; pre-existing, unchanged by grok | N/A — no canvas |
| Context links | **yes** — `locateGrok` resolves the linked node's `chat_history.jsonl` and `linesFromGrok` renders it. The whole leaf is in core (`core/handoff/locate.ts`, `core/context-link.ts`, `core/grok-session.ts`, `core/claude-accounts-core.ts`); the renderer only asks the pure `canContextLink`, so **no `window.nodeTerminal` member was added** and nothing new crosses the preload bridge | **yes, for free** — the row's old claim that `initContextLink` is never called from `src/server` is stale: `src/server/context-link.ts` calls it, driven off the persisted `bridges[]` instead of the renderer's live edges. Both shells feed the same `sessionId → dir` map from their raw hook listeners (`src/main/index.ts`, `src/server/agent-status.ts`) and both pass `grokHomeDir()` into the path jail — invariant 11 | **N/A** — linking is a canvas gesture and the phone has no canvas (`~/projects/nodeterm-ios`). The transcript it would read is the same file, so this is a surface gap, not a capability one |
| ⌘M chat panel | **yes** — `chatMessagesFromGrok`, reached through the agent-routed `chat:read-transcript`. The panel is the same component; what is new is that the channel asks WHICH agent before it picks a reader | **yes, for free** — the channel is registered through the CorePlatform seam, so both shells serve it and both route the same way | the phone has no ⌘M panel |
| Cross-agent transfer (grok as SOURCE) | **yes** — `renderGrokTranscript` | **N/A** — `buildHandoff` lives in `src/main`; the Server Edition has no transfer path at all, pre-existing and unchanged by grok | N/A |
| Context meter | **yes** — a third tail, on `signals.json` rather than on a transcript, tracked from the session directory the hooks let us derive (there is no hook field pointing at it) | **yes** — both shells create the same tail the same way, with the same `wholeFile` flag. Invariant 11: a tail added in one shell only is a meter the Server Edition silently lacks | the phone reads the mirror, which is agent-agnostic, so the numbers arrive with no phone-side work |
| Session-id minting | **yes** — probed at boot (`ensureGrokCliCaps`), minted at node creation, checked against the ids already on disk for that cwd | **yes** — `registerGrokCliIpc` runs in this shell too, so the browser gets the same answer over WS-RPC. A probe registered in one shell only is minting that silently works on the desktop and not in the browser | N/A — the phone launches nothing (see §8) |
| Managed accounts | **deliberately N/A** — accounts are a claude config-dir mechanism. `createAgentNode` never stamps an `accountId` onto a non-claude node, and `CLAUDE_CONFIG_DIR` is irrelevant to `~/.grok/hooks`. A grok node in a managed-account project must still report status (checklist 7) | idem | idem |
| Brand logo | the **official** xAI mark, INLINED in `agentIcons.tsx` as `GrokMark` rather than shipped as an asset — it is a single monochrome path, so `fill="currentColor"` inherits the label colour and is correct in both themes. The other four marks are multi-colour and stay `<img src>` assets, where `currentColor` cannot inherit | same component, for free | the phone draws its own icons — **follow-up owed** |
| Working indicator | the **brand mark, breathing** — no critter. Since 2026-08-09 this is a THREE-agent mechanism (grok, gemini, opencode) driven by one pure decision, `brandPulsePlan` in `lib/brandPulse.ts`, with a thin renderer per surface: `BrandPulse` for the React badge (`AgentMascot` no longer imports `GrokMark`) and `workingMascot` for the notch strip. Grok is the only `kind: 'inline'` case — its mark is a single monochrome path from `lib/grokMark.ts` (`createGrokMarkSvg` in the HUD) pulsing with a `currentColor` drop-shadow bloom; the other marks are multi-colour assets whose bloom takes the label colour instead of their own ink. One decision, so an agent is never two things on two surfaces. See docs/mascot-sprites.md | **N/A** — no notch there; the canvas badge indicator works | the phone has its own SwiftUI renderer |
| Fullscreen TUI setting | **N/A** — grok runs full-screen by default, so `claude-tui.ts` has no grok analogue | idem | idem |
| Deterministic hook-reply approvals (phone Approve/Deny) | **claude-only** — `pty-manager` arms `NODETERM_PERM_WAIT_SECS` only for claude, and grok does not subscribe `PermissionRequest` at all | idem | a grok node's approvals are not answerable from the phone |
| Kanban card + card modal | badges and the 💬 comments panel work (derived from the same nodes and the same status store); the meter row has nothing to show for grok | same | the iOS board is a separate read/move mirror |

---

## 8. Known gaps and follow-ups

**Verified corrections to the original assumptions:**

1. **The `Notification` vocabulary is published and closed** — it was previously written up here as
   UNVERIFIED and able to fail in BOTH directions: silence (NEEDS YOU never lighting, since grok
   documents no counterpart to claude's `PermissionRequest`) or over-firing (orca reports a
   notification before *every* tool call, which the first mapping turned into an unread dot, a
   chime, an OS notification and a phone card **per call**). Neither was a guess worth keeping:
   the spec answers it. Grok 1.0.13 names `idle_prompt`,
   `permission_prompt`, and `task_complete` in `~/.grok/docs/user-guide/10-hooks.md:99`; `:162`
   explicitly says `permission_prompt` fires only while a permission UI is actually waiting. The
   normalizer therefore maps that exact type to `blocked`, maps exact `idle_prompt` through the
   existing `idleInferred` rescue, and treats `task_complete` as informational because the spec does
   not define it as a turn end (`Stop` does). Every unknown type is a no-op; no substring widens the
   permission set.
2. **The earlier Esc gap was based on a false premise; no watchdog is needed.** Grok 1.0.13
   publishes `StopCancelled` for turns that end without `Stop` (`10-hooks.md:98,336,348,354,384`). A
   session-level `user_interrupt` now clears RUNNING as an interrupted `done`; permission rejection
   or cancellation, `max_turns`, and `no_progress` are visible non-interrupted turn ends. A payload
   carrying `subagentType` cannot end the parent session, and an unknown reason is a closed-set
   no-op. Cancel-and-send emits no `StopCancelled` because the replacement turn stays busy. Exact
   `idle_prompt` remains as a bounded rescue for the documented case where no stop hook completes:
   it can clear only `working`, never a live approval or question.

**Remaining gaps — state these, do not paper over them:**

1. ~~The phone's per-node "what it's doing now" activity line does not work for grok.~~ **CLOSED,
   and the stated cause was wrong.** This said grok's file hooks "never send `PreToolUse`", so the
   `recordRawToolEvent` call was a no-op and was deleted. Measured on 1.0.13 (2026-09-02): grok DOES
   publish the event — it spells it **`pre_tool_use`**, its own snake_case, in both field dialects —
   and `recordRawToolEvent` gates on the exact string `PreToolUse`. The blocker was a SPELLING, not
   an absence, which is exactly why deleting the call looked correct and closed the door on a working
   feature for good. The shells now translate at the boundary (where `grokRawFields` already decodes
   grok's dialect) rather than loosening a claude-shaped gate. The **tool vocabulary** it needed is
   in `toolActivity` and is measured, not derived from the docs: the fifteen names in
   `signals.json.toolsUsed` across 22 real sessions. Only two argument keys were ever seen in a
   captured payload (`read_file.target_file`, `run_terminal_command.command`), so those two lines
   carry a detail and the other thirteen name the action and stop — a phrase with no detail is
   honest; one built on a guessed key renders wrong forever. Note grok's names collide with claude's
   by CASE alone in two places (`grep`/`Grep`, `write`/`Write`), so that switch must stay
   case-sensitive.
2. **A remote (SSH) grok node's session name never resolves.** The shells build the session directory
   from the **local** `grokSessionsDir()` while the payload's `cwd` came from the host. It degrades
   safely — a wrong name is never produced, only no name — but it is a real asymmetry: claude's leg
   right below handles remote via `setRemoteTranscriptReader`.
3. **The `sessionId → dir` map is in-memory,** so after an app restart a grok name does not resolve
   until that session's next hook. This is the deliberate "derive, never search" trade (claude
   resolves immediately *because* it scans, which is the behaviour that made nodes adopt each other's
   names); the checklist records how it feels.
4. **No live session-name poll in the browser** — see §7.
6b. **The FIRST grok node in a cwd mints without checking the disk.** The taken-id set is warmed
   per cwd on demand (`renderer/state/grokSessionIds.ts`), so the first mint in a directory
   nobody has opened yet answers "nothing taken" and the fetch it triggers only helps the NEXT
   node. Deliberate, and the alternative was worse: checking the first one too means making
   `createAgentNode` async, and it is a synchronous factory the canvas mounts from. The risk it
   leaves is a v4 UUID colliding with an existing session directory, which is not the failure
   this guard exists for — the real one is a node reusing an id from an earlier session, and
   that one IS caught once the cwd is warm.
5. ~~Canvas-control discovery is unverified.~~ **MEASURED, and the premise holds.** `grok inspect
   --json` on grok 1.0.13 lists `get-linked-context` with `vendor: claude` and
   `compatibilityStatus: enabled`, and `externalCompat.cells` reports
   `{surface: 'skills', enabled: true, source: 'default'}` — `source: 'default'` is the part that
   matters: grok reads `~/.claude/skills` with **no** config edit by the user. That closes checklist
   **21** and, with it, the same unverified premise underneath `CANVAS_CONTROL_CAPABLE` and
   `CONTEXT_LINK_CAPABLE`; the shipped docs (`~/.grok/docs/user-guide/08-skills.md`) turned out to be
   right, but we no longer rest on them. Two residual per-user failure modes exist even if the
   premise holds: `[compat.claude] skills = false` and `GROK_CLAUDE_SKILLS_ENABLED=false`, plus
   grok's undisclosed vendor-default-skills filter. In each case `NODETERM_CANVAS_CONTROL=1` is set
   while the skill is undiscoverable. **If grok does not list our skills, this changes shape** (a
   marker block into grok's own instruction file, as codex/gemini/opencode get) and should be
   re-planned, not forced.
6. ~~The brand logo is a placeholder.~~ **CLOSED.** The official xAI mark now ships, inlined in
   `agentIcons.tsx` as `GrokMark` (`fill="currentColor"`, the mark's own non-square 512×492 viewBox
   so it is never stretched). Inlining is what makes it theme-correct: the mark is a single
   monochrome path and the vendor's own usage is one ink that flips with the background, which
   `currentColor` reproduces exactly. As an `<img src>` it could not — an SVG in an `<img>` is an
   isolated document, so `currentColor` resolves against nothing and paints black, invisible on the
   default dark theme. That is also why the other four marks, which are multi-colour and carry their
   own fills, remain assets.
7. **The local `$GROK_HOME` is read from an environment a GUI app does not have.** `grokHomeDir()`
   defaults from `process.env`, but a desktop app launched from Finder/Dock/a `.desktop` entry never
   sourced the user's shell rc — while the grok CLI, started by the shell inside a tmux pane, did. For
   a user whose `export GROK_HOME=…` lives in `.zshrc`, we write the hook file under `~/.grok` and grok
   reads somewhere else: no badge, no unread dot, no notification, no session name, **ever**, and no
   diagnostic. Same class as `findTmux()` resolving an absolute path "because GUI apps don't inherit the
   shell PATH". The SSH side is **better but not immune**, and the distinction matters: it at least asks
   the host and validates the answer (`isSafeRemoteGrokHome`) before falling back deliberately — but the
   probe runs over a **plain ssh exec channel**, so a host exporting `GROK_HOME` only from `.bashrc`
   reports empty and silently gets `~/.grok`. That is checklist **26**, which exists because the remote
   side shares the blind spot, not because it is solved there. Fixing it
   means probing the login shell — a change with its own failure modes, not a comment — so checklist
   **31** asks first whether anyone sets the variable at all. The trap is documented at `grokHomeDir`.

**Follow-ups owed elsewhere:**

- **`~/projects/nodeterm-ios` — nothing on the phone can launch grok yet, and the permission-mode
  funnel is claude-only.** Two separate facts, both verified in that repo:
  - `NewSession.builtinAgents` (`NodeTerm/Features/Projects/NewSession.swift:25`) lists claude, codex,
    gemini and opencode — there is no grok entry, so the phone's own "new session" picker cannot create
    one. Its `command(for:)` would happily return `"grok"` for a node that already carries that agent
    id, which is the shape a launcher entry would build on.
  - `AgentLaunch.command` (`NodeTerm/Services/AgentLaunch.swift:32`) appends the permission-mode flag
    only `if agentId == "claude"`, so a grok launch gets **no flag at all** — not a wrongly gated one.
    `resumableAgents` (`:12`) likewise omits grok, so a phone-side relaunch of an existing grok node
    would emit a bare `grok` instead of `grok --resume <id>`. The desktop bug §6 fixed (one `auto` gate
    applied to every agent) is therefore *not* reproduced on the phone; the gap is that grok is absent
    from all three lists. `MirrorSettings.autoSupported` still has no agent dimension, and its field doc
    in `agent-status-mirror.ts` warns any reader against generalizing it — that warning is what keeps a
    future grok entry from inheriting claude's gate.
- **`~/projects/nodeterm-ios` — a grok icon.** The phone draws its own agent icons; grok status arrives
  for free (the mirror is agent-agnostic), the icon does not.
- **A malformed remote `~/.claude/settings.json` or `~/.gemini/settings.json` is merged from `{}`,
  discarding the user's other hooks.** `setup()`'s `AGENT_TARGETS` loop in
  `src/main/remote-ssh/remote-hooks.ts` parses the host's file, falls back to `cfg = {}` on a parse
  error, merges our hook into that empty object and **writes it back**. **Pre-existing and NOT
  introduced by this branch** — byte-identical at `9d07c85` (2026-07-27) and at the pre-branch
  baseline `3e9c95a`; `installIntoAccountDir` does the same. Only the codex path guards, and grok's
  own file is *ours* so healing it is correct (§3). This deserves its own change: for a **user** file,
  a parse failure must abort that target, not rewrite it.

---

## 9. Grok device checklist

Every item is something this branch could **not** verify without a real grok login on a real
machine. Run them in a project with one grok node, one claude node, and one SSH project. Items 10, 9
and the `spawn_subagent` capture all fall out of the **same** logging-hook run (Task 11 Step 1 of the
plan), so do that first and several unknowns collapse at once.

### What the 2026-09-01 capture measured, and what it did not

A capture run against grok 1.0.13 with a logged-in account closed part of this list. The method: a
temporary hook file of our own in `$GROK_HOME/hooks/` subscribing all fifteen events and dumping each
raw payload (a separate file, so `nodeterm-status.json` was never touched), driven from a real TTY —
grok's full TUI inside tmux — because the interesting events need interaction, not headless mode.

**Measured, and now pinned by `normalize.grok.capture.test.ts`:** the envelope's key dialect;
`transcriptPath`; `StopCancelled` with `user_interrupt`, `permission_rejected` and `max_turns`;
`PermissionDenied`; `Notification` `permission_prompt` and `idle_prompt`; `PreCompact` / `PostCompact`
and their `source` field; `Stop` firing twice with `end_turn` then `shutdown`.

**NOT measured, each with the reason it was out of reach — none of these may be described as
verified until someone runs them:**

| Unmeasured | Why the run could not produce it |
|---|---|
| `Notification` `task_complete` | Never emitted in the run. It is a user-attention type whose trigger is undocumented, so no prompt was known to force it. Its row stays a no-op **because** it is unverified, which is the safe direction. |
| `SubagentStart` / `SubagentStop` | Deliberately not attempted: the account's weekly quota was at **5%**, and a subagent run is the most expensive turn available. Deferred to task15, which is where the answer is needed and where the same run also has to settle whether `subagentType` distinguishes two concurrent instances of one type. |
| `StopFailure` | Requires an API-level failure (rate limit, auth error, server error) that cannot be provoked on demand without abusing the account. |
| `PostToolUseFailure` | No failing tool call occurred in the run; provoking one is easy and it simply was not part of this pass. |
| `SessionEnd` carrying `subagentType` | Depends on the subagent run above. |
| `StopCancelled` carrying `subagentType` | Not one of the three captured `StopCancelled` payloads carries the field (observed keys: `reason`, `cancelledBy`, `promptId`, plus `cancelTrigger` on the interrupt and `reasonDetails` on the rejection). So task05's early exit for a child cancellation still rests on the spec's sentence (`10-hooks.md:354`), not on observation. Same blocker as the two rows above: it needs a subagent run, deferred to task15 on quota. |
| `TITLE_KEYS[0] = 'title'` | Still a guess. `/rename` was never run in the captured session, so the key grok writes a MANUAL title to remains unconfirmed — the capture says nothing about it, and promoting it on the strength of "we captured something" would be exactly the error the rest of this pass corrects. |
| `grok inspect --json` (canvas-control discovery) | Not part of the hook capture; the premise that grok scans `~/.claude/skills` is still unverified (item 7 of §8). |
| The `type` fallback for notification kind † | Every captured `Notification` used `notificationType`. The bare `type` spelling comes from orca's reader and was not observed, so it stays marked as inferred. |

```
Hooks — the whole feature hangs off these five
 1. Run `grok` in a nodeterm node, then `/hooks`: is `nodeterm-status.json` listed, ENABLED,
    with all fifteen events? (If the file is missing, or it is there and item 2 still shows no badge,
    do item **31** before anything else — a `$GROK_HOME` split explains both.)
 2. Does the RUNNING badge appear on the first prompt and clear when the turn ends?
    (SessionStart / UserPromptSubmit / Stop reaching the hook server at all.)
 3. Do tool events fire? Watch the badge stay RUNNING through a long Bash call — this is the
    `matcher: ".*"` check. If it does not, capture the payload with the zz-capture hook from
    Task 11 Step 1 and try an OMITTED matcher.
 4. Does the guarded command form run? `grok` + `/hooks` shows a hook ERROR if
    `if [ -r … ]; then sh …; fi` is not accepted as an inline shell command.
 5. Rename `~/.nodeterm/agent-hooks/grok.sh` away and start a session: it must still work
    normally (the guard swallows stdin and exits 0), NOT refuse to submit prompts.

Env + identity
 6. Does `NODETERM_NODE_ID` reach the hook process from a tmux-spawned pane? (No badge at all,
    with the file loaded, points here.)
 7. Create a grok node in a project whose default is a MANAGED CLAUDE ACCOUNT: does it still
    report status? (`CLAUDE_CONFIG_DIR` must not affect `~/.grok/hooks`.)
 8. Is the claude-compat cross-fire really inert? With one grok turn, confirm the node's state
    only ever comes from /hook/grok — no flicker, no duplicate completion notification.

State machine edges
 9. Press Esc mid-turn. Expected: session `StopCancelled(reason=user_interrupt)` clears RUNNING as
    an interrupted stop (no ordinary completion alert/unread); a payload carrying `subagentType`
    leaves the session working. Record whether `idle_prompt` follows as the bounded fallback. Also
    try cancel-and-send: it emits no stop hook and the replacement turn must stay RUNNING. No
    watchdog is needed because the session-level terminal event exists.
8. Capture one real payload for each published `Notification` type and record which key carries the
    kind (`notificationType`, `notification_type`, or `type`). The type vocabulary and semantics are
    already published in `10-hooks.md:99,162`; this capture is only to replace the remaining
    defensive key aliases with measured envelope shapes. Message prose and severity do not classify
    state.
9. Force an API error (e.g. an invalid model). Does StopFailure clear the RUNNING badge?
10. Quit with `/quit`. Does the session-close Stop stay silent (no "agent finished" notification)?

Session identity + restore
11. Does the session chip fill in? The chip has exactly ONE source: the terminal-title OSC
    (`term.onTitleChange`, path/prompt-looking titles ignored). The summary.json poll feeds the node
    TITLE instead — that is item 12 — so a blank chip with a correct title is not a bug.
12. **Verified 2026-09-01, refined 2026-09-03:** a real grok 1.0.13 `summary.json` stores the
    session name in `generated_title` and has no `title` field. `session_summary` exists alongside it
    but is NOT a separate kind of value: across 49 local files it is identical to `generated_title`
    in 28 of the 29 that carry both, and never longer than 49 characters. It is not read as a title
    any more — see §5 for why resolving to nothing beats resolving to something unverified.
13. Rename the NODE by hand: does grok's own title change (the `/rename` write leg)?
14. Reboot (or `tmux kill-server`) and reopen the project: does the node cold-restore with
    `grok --resume <id>` and land in the SAME conversation, in the right cwd? Note that after
    an app restart the session NAME will not resolve until that session's next hook (§8.5).

Fixtures the unbuilt features need, modes, restart
15. ~~CAPTURE `signals.json` from a live session.~~ **DONE, 22 sessions (1.0.13, 2026-09-02).** The
    keys are `contextTokensUsed`, `contextWindowTokens` and `contextWindowUsage`; a total DOES
    appear, in all 22. Fixture at `core/__fixtures__/grok/signals.json`, survey in
    `evidence/grok-signals.txt`. What a NEW device should still check is the opposite case this item
    was written for: a session whose signals.json lacks `contextWindowTokens` (a future grok, an
    interrupted write). The meter must then vanish, not fall back to a guessed window.
16. Settings → Agents → Auto: does the launched command carry `--permission-mode auto`, on a
    machine WITHOUT claude installed? (The claude gate must not touch grok.)
17. Does `--permission-mode acceptEdits` launch cleanly, and what does grok actually do with it
    (its hook payload only ever reports default/auto/plan/bypassPermissions)? Check a
    prompt-carrying launch too (transfer / open-agent / spawn-team): the flag must appear
    BEFORE the `--`.
18. "Restart agent (resume)" on an idle grok node: does it `/quit`, wait for the shell, and
    resume the same session? Is it refused while the node is RUNNING?

Skills
19. ~~`grok inspect --json`: are `manage-nodeterm-canvas` and `get-linked-context` listed?~~
    **ANSWERED on this machine, grok 1.0.13 (2026-09-02): yes.** `get-linked-context` comes back with
    `vendor: claude` and `compatibilityStatus: enabled`, and `externalCompat.cells` reports
    `{surface: 'skills', enabled: true, source: 'default'}`. Recorded in
    `evidence/grok-skill-discovery.txt`. **What this item still asks of a NEW device** is the pair of
    per-user failure modes, which a default-config machine cannot exercise: set
    `[compat.claude] skills = false` in `~/.grok/config.toml`, and separately export
    `GROK_CLAUDE_SKILLS_ENABLED=false`. In each case `NODETERM_CANVAS_CONTROL=1` is still set while
    the skill is undiscoverable — i.e. the shim is armed and mute. Nobody has seen that state.
20. From a grok session, run the canvas shim: does a node appear on the canvas? The path differs
    per surface — LOCAL sessions get `<userData>/canvas-control/nodeterm.sh` (the path written
    into the skill's own SKILL.md), remote SSH sessions get `$HOME/.nodeterm/nodeterm.sh`.
21. CAPTURE the `spawn_subagent` PreToolUse/PostToolUse payloads (Task 11 Step 1). ~~And
    `updates.jsonl` (Task 10 Step 1).~~ **That half is done, and the file was the wrong one:** the
    readable conversation is `chat_history.jsonl`, its sibling; `updates.jsonl` is what the hook
    payloads advertise, and following the advertisement fails silently. The fixture cut from a real
    session lives at `src/core/__fixtures__/grok/chat_history.jsonl`. ~~Grok is NOT in
    CONTEXT_LINK_CAPABLE~~ — it is now, so `get-linked-context` from the grok side and a claude node
    linked to a grok node **should both read**. On a new device, check exactly that.

SSH
22. Connect an SSH project, then on the host: `cat $HOME/.grok/hooks/nodeterm-status.json`.
    Present, with the `.*` matcher?
23. Does a REMOTE grok node show badges? (Reverse tunnel + remote script.) Its session NAME will
    not resolve — that is the known asymmetry in §8.4, not a new bug.
24. If the host sets GROK_HOME, did the file land there and not in `$HOME/.grok`? NOTE the
    trap: we probe it with `printf %s "${GROK_HOME:-}"` over a NON-LOGIN ssh exec, so a host that
    exports GROK_HOME only from `.bashrc` reports EMPTY and silently gets `~/.grok` — the wrong
    directory, with no symptom at all. If it bites, give the probe the login-shell + PATH
    treatment `SshProjectManager.connect` uses for the remote `claude --version`.

Surfaces
25. Server Edition in a browser: grok badges, unread dot, notch N/A — and now a context meter too
    (both shells create the signals.json tail). Also confirm the node title does NOT adopt grok's
    session name there (readSessionName is stubbed).
26. Phone: does a grok node appear in the inbox with the right state, AND does its "what it's doing
    now" line now read grok's own phrases ("Reading fichero.txt", "Searching the code")? That line
    was absent until the `pre_tool_use` spelling was translated at the shells (§8.3). A claude phrase
    or a bare tool name appearing there means the vocabulary was bypassed.
27. macOS notch: does the grok mark pulse and bloom while it works, on the black capsule, next to
    claude's walking critter without looking out of place?
28. Kanban board + card modal: badges, the 💬 comments panel, and the meter row — which now HAS
    something to show on a grok card.

Two traps with no code fix — appended so the numbering above stays stable
29. `echo $GROK_HOME` in a nodeterm terminal, then check where the hook file actually went. The app
    resolves it from the APP's environment, and a GUI launch (Finder/Dock/`.desktop`) never sourced
    your shell rc — so an `export GROK_HOME=…` in `.zshrc`/`.bashrc` splits the two sides and
    EVERYTHING silently stops working: no badge, no unread, no notification, no session name, no
    error (§8.9). Compare a shell launch (`npm start`) with a GUI launch (`open -a nodeterm`): a
    difference between them IS the trap. Report whether you set the variable at all — that answer
    decides whether a login-shell probe gets built.
30. **Shift+Enter in a grok node.** nodeterm remaps it universally to `\x1b\r` (ESC+CR / M-Enter,
    `terminalKeyAction` / `SHIFT_ENTER_SEQ`), which is what claude and codex want for "insert a
    newline, don't submit". Grok's own key handling is unverified here — orca records a
    `ctrlEnterEncoding: 'csi-u'` for it, i.e. a different encoding family — so check both: does
    Shift+Enter insert a newline (not submit), and does plain Enter still submit? If the remap fights
    grok, the fix is a per-agent encoding in `terminal-config.ts`, not a global change.
31. **Does a grok elicitation survive its turn end?** Open an ask (whatever produces
    `elicitation_dialog` / `agent_needs_input`) and watch what the node does when the turn finishes.
    Codex has exactly this shape — its `request_user_input` ends the turn with the question still
    open, the answer arriving as a fresh `UserPromptSubmit` — so `normalizeCodex` marks the ask
    `awaitingInput` and `reduceEntry` holds `waiting` through the turn-end `done` (main's `7a40aab`,
    observed live on codex-cli 0.145.0). Grok does NOT set that flag, deliberately: if grok behaves
    like codex, a grok node goes green while it is still waiting on you; if it does not, setting the
    flag would pin NEEDS YOU on a node that genuinely finished. Report which happens — a green node
    over an open question means grok joins the `awaitingInput` path, one line in `normalizeGrok`.
32. **The Grok mark, at 16 px, in BOTH themes.** It is the official mark inlined with
    `fill="currentColor"` (§8.8), so readability is guaranteed by construction — it takes the label
    colour, black-on-light and white-on-dark, the way xAI uses it. What is *not* guaranteed is
    legibility at that size: it is a fine diagonal glyph, and thin strokes can turn to mush where the
    other four marks (heavier, multi-colour) do not. **The same glyph is also the RUNNING indicator**
    (§7, pulsing with a bloom), so check it there too, in both themes — the badge sits on
    `--panel-header`, which is the light surface where a `currentColor` bloom has the least to work
    with. Look at the pane submenu, the Dock `+`, the
    command palette and Settings → Agents, and flip the theme. If it reads as a smudge, the fix is a
    size-specific viewBox nudge, not a colour change.
```

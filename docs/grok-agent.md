# Grok as a nodeterm agent

Grok (`@xai-official/grok` 1.0.0, `grok` on PATH) is a builtin agent id alongside claude, codex,
gemini and opencode: `AGENT_CONFIG.grok` in `src/shared/agents/config.ts` — label `Grok`, colour
`#64748b`, `launchCmd: 'grok'`, `promptInjectionMode: 'argv'` **plus** `argvPromptSeparator: '--'`,
`expectedProcess: 'grok'`. Status comes from grok's own hooks, never from parsing output, so
everything downstream of `NormalizedAgentEvent` — the RUNNING / NEEDS YOU badges, the unread dot,
completion notifications, the notch capsule, kanban cards, the phone mirror — lit up the moment
`hasHooks('grok')` became true. Each further capability is one membership-list edit plus the one
leaf that list gates.

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
| `AGENT_HOOK_TARGETS` | **joined** | Five things: a pure normalizer for grok's dialect (`normalizeGrok`, `src/shared/agents/normalize.ts`); a subscription list restricted to the events `normalizeGrok` actually maps — nine of the fourteen grok documents (`GROK_HOOK_EVENTS`, `src/shared/agents/hook-events.ts`); an installer able to write a **per-event matcher**, which meant widening the shared installer's event type to `ManagedHookEvent` (`core/agents/hooks/install-helper.ts`); one definition of grok's path algebra (`core/agents/grok-paths.ts`); and a raw-listener branch in **both** shells (`src/main/index.ts`, `src/server/agent-status.ts`) to derive the session directory, because grok's envelope carries no transcript path. |
| `RESUMABLE_AGENTS` | **joined** (pre-branch) | `resumeCommand('grok', id)` → `grok --resume <id>`, and a session id that reaches the renderer — which it does, off every hook payload. |
| `RENAME_CAPABLE` | **joined** | A **read** leg that resolves a session's own name *without searching* (`core/grok-session.ts`, keyed off the hook-fed `sessionId → session dir` map), a **write** leg byte-identical to claude's (`/rename <name>` typed into the pane via `pty.sendText`; grok also accepts `/title`), and one routing rule for the two readers — `readAgentSessionName` in `core/agent-session-name.ts`, serving the desktop IPC handler *and* both shells' session-name sweeps. Routing is not cosmetic: claude's resolver scans `~/.claude/projects` on a cache miss, so an unrouted grok node paid that scan on every poll for a guaranteed null — a mounted node polls every **4 s** until the name first resolves and **15 s** after (`TerminalNode.tsx`), and the mirror's own `SESSION_NAME_SWEEP_MS` sweep adds one pass a minute. |
| `PERMISSION_MODE_CAPABLE` | **joined** | Grok shares claude's flag **spelling** and value vocabulary (`--permission-mode auto\|plan\|acceptEdits\|bypassPermissions`; our `manual` = no flag = grok's own `default`) — that is the whole membership requirement. Two things had to change around it: claude's `auto` **version gate** had to become agent-scoped (`activePermissionMode(agentId)`, `renderer/state/permissionMode.ts`), and the flag had to be emitted **before** grok's `--`. See §6. |
| `CANVAS_CONTROL_CAPABLE` | **joined** | Nothing new to install: grok scans `~/.claude/skills` by default for Claude Code compatibility, which is exactly where `manage-nodeterm-canvas` is already written (locally, and on an SSH host by `RemoteHooks.installCanvasControl`). Membership is what sets `NODETERM_CANVAS_CONTROL=1` in the session env — `hook-server.buildPtyEnv` locally, `remoteHookEnvArgs` remotely, both through the single `canControlCanvas` predicate — i.e. what makes the sh+curl shim anything other than a no-op. **Unverified:** `grok inspect --json` was never run (§8). |
| `USAGE_CAPABLE` (the per-node context meter) | **not joined** | Needs a real `signals.json` yielding **both** a used-token count **and** the window total. A percentage against a guessed denominator is a wrong number presented as a fact, so no total ⇒ no meter. Task 5 of the plan stops at its capture step. Do not confuse this with grok *billing* usage — see the note below. |
| `CONTEXT_LINK_CAPABLE` | **not joined** | Needs a parser for `updates.jsonl` pinned by a real fixture, plus a locator in `core/context-link.ts`. Task 10 stops at its capture step. (For reference, this list is `claude, codex, gemini, opencode` — grok is the only builtin outside it.) |
| `SUBAGENT_CAPABLE` | **not joined** | Needs the `spawn_subagent` `PreToolUse`/`PostToolUse` payload fields, including whatever marks a **background** launch. Task 11 stops at its capture step. |
| `BRANCH_CAPABLE` | not joined | Branch sends claude's `/branch` and resumes by claude's session id; grok has no counterpart. |
| `CHAT_CAPABLE` | not joined | The ⌘M `ChatPanel` renders claude's transcript `.jsonl`; grok's log is `updates.jsonl` and needs the same parser Task 10 is blocked on. |
| `TRANSFER_SOURCE_CAPABLE` | not joined | Cross-agent transfer reads the source's native transcript — again the missing parser. Grok is a valid transfer **target** (it is an agent node like any other); it just cannot be the source. |
| `RECURRING_CAPABLE` | not joined | `/loop`, `/schedule`, `/cron` are detected from claude's `Skill` / `CronCreate` / `ScheduleWakeup` tool names; grok's tool vocabulary for these is unknown. |

**Grok billing usage ≠ the grok context meter.** These are two different features and the plan once
conflated them. Grok has been a **billing usage provider** since main's `a2353f2` (PR #11):
`src/core/usage/grok-usage.ts` reads the CLI's own sign-in and reports weekly credits + monthly
budget; it is registered in `usage-service.ts`'s provider list and has its own Settings → Usage row
(`UsageSection.tsx`, `shared/usage-limits.ts`). That already works. `USAGE_CAPABLE` is the
**per-node context-window meter** in the node header, and it is still claude-only. The one place the
two touch is `$GROK_HOME`: `grok-usage.ts`'s `grokHome()` now delegates to `grokHomeDir()` in
`core/agents/grok-paths.ts`, so there is exactly one definition of that rule.

---

## 2. The hook dialect

Grok's envelope is not claude's. Both dialect differences come from grok's **shipped 1.0.0 docs**, and
both are load-bearing. **No hook payload in this table was ever captured**: the branch had the binary
(so its `--help` surface is measured) but never a logged-in session — `~/.grok/auth.json` was never
written — and a hook only fires inside one. Rows marked † are weaker still: they are inferred from
another integration's reader, not from grok's own documentation.

| | claude | grok (file hooks) | grok (SDK-registered hooks) |
|---|---|---|---|
| event key | `hook_event_name` | `hookEventName` | `hook_event_name` |
| event **value** | `PreToolUse` | `pre_tool_use` | `pre_tool_use` |
| session id | `session_id` | `sessionId` | `session_id` |
| cwd | `cwd` | `cwd` (+ `workspaceRoot`) | `cwd` |
| tool name / input | `tool_name` / `tool_input` | `toolName` / `toolInput` | `tool_name` / `tool_input` |
| tool **output** | `tool_response` | **`toolResult`** | `tool_result` |
| transcript file | `transcript_path` | **absent** | **absent** |
| last assistant text | `last_assistant_message` | `lastAssistantMessage` | `last_assistant_message` |
| notification kind † | `notification_type` | `notificationType`, `notification_type` or `type` | same |
| turn-end reason | — | `reason` (`end_turn` \| `channel_closed` \| `shutdown`) | same |
| also on every event | — | `timestamp`, `permissionMode` | same |

† **The `Notification` payload is the one row with no documented source.** Grok's docs describe the
event but not its body, so the three key spellings — plus the `message` and `level` fields the mapping
in §5 reads — come from **orca** (`/root/orca-main`, MIT, a shipping grok integration):
`notificationType ?? notification_type ?? type` at `src/shared/agent-hook-listener.ts:2370-2376`,
`message`/`level` at `:3973-3975`. Treat every Notification claim in this document as inference from
that reader until checklist **10** replaces it with a capture.

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
- **No `transcript_path`.** Claude's whole tail/meter/transcript plumbing keys off that field. Grok's
  session directory is instead **derived** from `(cwd, sessionId)` — two fields every grok hook does
  carry — by `grokSessionDir()`, and remembered in the shells' raw listener, the one place they arrive
  together. Derived, never searched: a search of grok's sessions tree is how one node ends up
  adopting another node's name. `grokSessionDir` returns `null` (learn nothing) rather than half a
  path when either half is unusable.

The nine subscribed events map as follows (`normalizeGrok`); everything else returns `null`, a
deliberate no-op:

| grok event | `NormalizedAgentEvent` | note |
|---|---|---|
| `SessionStart` / `SessionEnd` | session `start` / `end` | `SessionEnd` also drops the session's remembered directory |
| `UserPromptSubmit` | `working`, `newTurn: true` | the turn start; `newTurn` is what clears per-turn fan-out once per turn |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `working` | a **failed** tool is still mid-turn — grok fires `PostToolUseFailure` and carries on |
| `Stop` (`reason` anything but `channel_closed`/`shutdown`) | `done` + `lastMessage` | a **denylist**, not an allowlist of `end_turn`: `Stop` is the event the RUNNING badge depends on ending, so an unknown reason must fail towards reporting it |
| `Stop` (`channel_closed` / `shutdown`) | `done`, `interrupted: true` | the observe-only second `Stop` at session close; `interrupted` suppresses the completion alert and unread dot, and the stale `lastAssistantMessage` is dropped |
| `StopFailure` | `done` + `lastMessage` | fires **instead of** `Stop` when the turn dies on an API error — without it the badge sticks |
| `Notification` `permission_prompt` + message `tool permission requested` + level `info`/absent | **nothing** (`null`) | grok emits this before **every** tool call, even under `bypassPermissions` (orca's `isGrokRoutinePermissionPromptNotification`, `agent-hook-listener.ts:2378-2389`). The type is canonicalized first (`grokCanonical`, the same letters-only rule the event name uses), so the camelCase spelling grok's envelope would plausibly carry — `permissionPrompt` — is suppressed too; comparing raw would drop it into the ask row below and reinstate the strobe. Mapping it to `blocked` fired `markUnread` with no cooldown, the needs-you chime, an OS notification per tool call while unfocused, and a phone inbox card per `working→blocked` edge. Matched exactly, so a **louder** prompt with the same type still gets through |
| `Notification` `*permission*` / `approval_required` | `blocked` | substring for the permission family (its worst case is a badge the next hook clears), plus `approval_required` — which is **inference on inference**: `05-configuration.md:414` names it as a notification *trigger*, not as a `notificationType` value, and the bridge is `10-hooks.md:153` ("the matcher tests … the notification type on `Notification`"). Matched exactly for that reason. The two spellings share no substring, and matching both is what keeps this mapping from firing for nothing under either vocabulary |
| `Notification` `elicitation_dialog` / `agent_needs_input` | `waiting` | a **closed set**, exactly as in `normalizeClaude`: a substring test on `elicit` would also match claude's informational `elicitation_complete`/`_response` and leave NEEDS YOU on a node that just finished, with no later hook to clear it |
| `Notification` whose **message** reads idle (`type your message`, `enter send`, `shift-tab normal`, `ask a side question`; `*idle*` type as a fallback) | `done`, `interrupted`, `idle` | the **rescue** signal for a node stuck on `working` — see §8. Keyed on the MESSAGE because that is where grok states it (orca's `isGrokIdleNotification`, `:2391-2402`); a type-only test never fired, since no source names an "idle" type. Checked **after** the ask branches, mirroring orca's own precedence (`:3994-4012`) |

`Stop` fires **once per turn plus once at close** — N+1 times in an N-turn session, the last one
observe-only — and interrupted / refused / max-turns turns **skip `Stop` hooks entirely**.

Not subscribed in v1: `PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`,
`PostCompact` — documented exactly as the nine are, but with nothing here to consume them (a
post-decision event, subagent cards grok does not have, compaction nobody reads). Grok skips hook
event names it does not recognize (that is how a shared Claude settings file loads at all), so adding
one later is safe.

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
**8 of grok's 9 events** also fire `claude.sh` and POST to `/hook/claude` — every one except
`PostToolUseFailure`, which claude has no entry for (`CLAUDE_HOOK_EVENTS`). This is by design left
alone — we do not disable grok's `[compat.claude]` scanning, because it is the user's config and it
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
```

Path rules, all unit-tested in `grok-paths.test.ts`: the cwd is `encodeURIComponent`'d to name the
group directory; past **255 bytes** grok switches to a slug+hash name we cannot reconstruct, so we
resolve **nothing** there (`GROK_ENCODED_CWD_MAX_BYTES`); a session id must match
`/^[A-Za-z0-9_-]+$/` and be ≤ 128 chars, because it reaches both a path *and* — via
`grok --resume <id>` — a shell command line.

The session **name** (what `/resume` shows and what a node title with `titleAuto` adopts) is read by
`core/grok-session.ts` → `pickGrokSessionMeta` over `summary.json`, in preference order
`TITLE_KEYS = ['title', 'generated_title']`, plus `current_model_id` as the model. Reads are capped
at 256 KB and answer `null` — never a throw — for an absent, oversized or unparseable file.
Resolution is a **direct open** of the directory a hook told us about: `rememberGrokSessionDir` /
`grokSessionDirFor` / `forgetGrokSession` keep a bounded (512-entry, least-recently-seen-evicted)
`sessionId → dir` map, populated by the shells' raw listeners.

**The fixture is CONSTRUCTED, not captured.** `src/core/__fixtures__/grok/summary.json` was built
from the field list grok's shipped 1.0.0 documentation gives (`info`, `session_summary`,
`generated_title`, `created_at`, `updated_at`, `num_messages`, `num_chat_messages`,
`current_model_id`, `parent_session_id`, `agent_name`) — because no grok binary or account existed on
the implementation machine. The field **names** come from that list; every **value** is a placeholder,
the timestamp format is a guess, and nested shapes are left empty (`info: {}`) rather than invented.
Only the two keys the assertions pin, `generated_title` and `current_model_id`, may be relied on. The
provenance is written at the top of `grok-session.test.ts`; keep it there until the file is replaced
by a real capture.

**`TITLE_KEYS[0] = 'title'` is an unverified guess** at the key grok's `/rename` (alias `/title`)
writes a *manual* title to. `generated_title` is the documented auto-title. `'title'` is listed
first so a real manual title wins the moment the key is confirmed; a wrong guess degrades to the
generated title (right name, just not overridable from grok's side) rather than to a wrong name.
Confirming it is checklist item **14**.

**Not captured at all:** `signals.json` (blocks the context meter — the used-token key, the window
total, and whether a total exists anywhere) and `updates.jsonl` (blocks context links, the ⌘M
transcript view and transfer-as-source). Recipes for both, and for the `spawn_subagent` payload, are
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
an agent with no separator (claude, byte-identical to what nodeterm has always emitted), flag
**before** the separator otherwise — so that is where a regression is visible. The resume shape
(`grok --resume <id> --permission-mode X`) is composed outside `createAgentNode` and is pinned in
`agent-restart.test.ts` on the **composed string** — the test calls the same two functions
`TerminalNode` calls (`resumeCommand` then `withPermissionMode`) and composes them itself, so it
catches a change in either function but not a change in the component's call site.

**In-place restart** ("Restart agent (resume)") works for grok: `EXIT_SEQUENCES.grok = '/quit'`
(its `/exit` is an alias; the documented primary is what we type) plus `resumeCommand` is the whole
entry. The refusal while a session is `working` or `blocked` is agent-agnostic (`BUSY_STATES`) and
needs no grok branch — typing `/quit` into a permission prompt would *answer* it. The **single-node**
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
| Canvas control | yes, via `~/.claude/skills` + the sh+curl shim (unverified) | **not wired at all** — `agent:control` has no server handler; pre-existing, unchanged by grok | N/A — no canvas |
| Context links | **not implemented for grok** (§1) | not wired at all (`initContextLink` is never called from `src/server`) | N/A |
| Context meter | **not implemented for grok** (§1) | idem | idem |
| Managed accounts | **deliberately N/A** — accounts are a claude config-dir mechanism. `createAgentNode` never stamps an `accountId` onto a non-claude node, and `CLAUDE_CONFIG_DIR` is irrelevant to `~/.grok/hooks`. A grok node in a managed-account project must still report status (checklist 7) | idem | idem |
| Brand logo | `AGENT_LOGO.grok` → `renderer/assets/grok.svg` — a **placeholder monogram** (§8) | same asset, for free | the phone draws its own icons — **follow-up owed** |
| Notch mascot | yes — its own mid-slate (`#8494a8`) critter through the shared `buildQuadrantSprite`; the CSS rule block is *shared* with claude's, so the geometry cannot drift | **N/A** — there is no notch there; the canvas badge mascot works | the phone has its own SwiftUI renderer |
| Fullscreen TUI setting | **N/A** — grok runs full-screen by default, so `claude-tui.ts` has no grok analogue | idem | idem |
| Deterministic hook-reply approvals (phone Approve/Deny) | **claude-only** — `pty-manager` arms `NODETERM_PERM_WAIT_SECS` only for claude, and grok does not subscribe `PermissionRequest` at all | idem | a grok node's approvals are not answerable from the phone |
| Kanban card + card modal | badges and the 💬 comments panel work (derived from the same nodes and the same status store); the meter row has nothing to show for grok | same | the iOS board is a separate read/move mirror |

---

## 8. Known gaps and follow-ups

**Gaps in what shipped** — state these, do not paper over them:

1. **The `Notification` vocabulary is unverified, and it can fail in BOTH directions.** Grok documents
   no hook for "a permission prompt is on screen" — claude's `PermissionRequest` has no counterpart, and
   `PermissionDenied` is a post-decision event — so NEEDS YOU may never light. But the opposite is just
   as live: orca (a shipping integration) reports that grok fires a `permission_prompt` Notification
   before **every** tool call, even under `bypassPermissions`, and our first mapping turned each of
   those into `blocked`, i.e. an unread dot + chime + OS notification + phone inbox card **per tool
   call**. That routine case is now suppressed exactly as orca suppresses it, and both spellings of a
   genuine ask (`*permission*` and grok's own `approval_required`) still light the badge. Which of the
   two failures is real is unknown until checklist **10** records the vocabulary — so watch for
   **over**-firing as carefully as for silence.
2. **An interrupted turn (Esc) fires no hook at all**, by grok's design, so a node can sit on RUNNING
   until the next `UserPromptSubmit` re-syncs it. The only thing that can rescue it early is an idle
   `Notification`, if grok emits one — detected from its **message** text (orca's four phrases), since
   nothing in either source names an idle *type*. No watchdog was built; checklist **9** measures how
   bad it feels, which is the input to deciding whether one is worth it.
3. **The phone's per-node "what it's doing now" activity line does not work for grok.**
   `recordRawToolEvent` gates on `payload.hook_event_name === 'PreToolUse'`, which grok's file hooks
   never send, so calling it from the grok branch was a no-op and was deleted. Making it work needs a
   grok **tool vocabulary** (`run_terminal_command`, `read_file`, `search_replace`, …) in
   `agent-status-mirror.ts`'s `toolActivity`; feeding it claude's names would print nonsense.
4. **A remote (SSH) grok node's session name never resolves.** The shells build the session directory
   from the **local** `grokSessionsDir()` while the payload's `cwd` came from the host. It degrades
   safely — a wrong name is never produced, only no name — but it is a real asymmetry: claude's leg
   right below handles remote via `setRemoteTranscriptReader`.
5. **The `sessionId → dir` map is in-memory,** so after an app restart a grok name does not resolve
   until that session's next hook. This is the deliberate "derive, never search" trade (claude
   resolves immediately *because* it scans, which is the behaviour that made nodes adopt each other's
   names); the checklist records how it feels.
6. **No live session-name poll in the browser** — see §7.
7. **Canvas-control discovery is unverified.** `grok inspect --json` was never run, so the premise
   that grok lists our `~/.claude/skills` entries rests on its shipped docs
   (`~/.grok/docs/user-guide/08-skills.md`). Two residual per-user failure modes exist even if the
   premise holds: `[compat.claude] skills = false` and `GROK_CLAUDE_SKILLS_ENABLED=false`, plus
   grok's undisclosed vendor-default-skills filter. In each case `NODETERM_CANVAS_CONTROL=1` is set
   while the skill is undiscoverable. **If grok does not list our skills, this changes shape** (a
   marker block into grok's own instruction file, as codex/gemini/opencode get) and should be
   re-planned, not forced.
8. **`src/renderer/assets/grok.svg` is a placeholder monogram, not the official Grok/xAI mark.** It
   is a neutral "G" in the app's own line-icon style, deliberately *not* a lookalike, and it carries
   an XML comment saying so. Replace it with the official asset from an official press/brand page, at
   that asset's published proportions. It uses an explicit `#64748b` rather than `currentColor`
   because `agentIcons.tsx` renders these as `<img>` URLs, where `currentColor` cannot inherit.
9. **The local `$GROK_HOME` is read from an environment a GUI app does not have.** `grokHomeDir()`
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

```
Hooks — the whole feature hangs off these five
 1. Run `grok` in a nodeterm node, then `/hooks`: is `nodeterm-status.json` listed, ENABLED,
    with all nine events? (If the file is missing, or it is there and item 2 still shows no badge,
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
 9. Press Esc mid-turn. Expected (documented): NO hook fires and the badge stays RUNNING until
    the next prompt. Confirm, and record how bad it feels — this decides whether a watchdog is
    worth building.
10. The `Notification` capture — the highest-value item on this list, because the mapping in §5 rests
    entirely on another integration's reader. Record, VERBATIM and per notification, all THREE fields
    the mapping reads: the kind (`notificationType` / `notification_type` / `type` — note which key,
    and its exact casing), `message`, and `level`. Do it for BOTH cases, because they are handled
    oppositely and only the exact strings can tell them apart:
    (a) a **routine** run — one turn with several tool calls, under `auto` AND under
    `bypassPermissions`, window in the BACKGROUND. If a notification fires per tool call, our
    suppression must match its message/level exactly or the node strobes NEEDS YOU (chime + OS
    notification + phone card per tool call). Count the notifications against the tool calls.
    (b) a **genuine** ask that needs a human answer. That one must still reach `blocked`.
    Also note whether an IDLE notification exists at all and its exact message (item 9's rescue
    depends on the four phrases in `GROK_IDLE_MESSAGES`). This is the only path to a NEEDS YOU badge;
    record the vocabulary.
11. Force an API error (e.g. an invalid model). Does StopFailure clear the RUNNING badge?
12. Quit with `/quit`. Does the session-close Stop stay silent (no "agent finished" notification)?

Session identity + restore
13. Does the session chip fill in? The chip has exactly ONE source: the terminal-title OSC
    (`term.onTitleChange`, path/prompt-looking titles ignored). The summary.json poll feeds the node
    TITLE instead — that is item 14 — so a blank chip with a correct title is not a bug.
14. `/rename Something` in grok, then check the node title adopts it — and record WHICH
    summary.json key held it. TITLE_KEYS[0] = 'title' is a GUESS; correct it if it differs, and
    replace __fixtures__/grok/summary.json with the real file while you are there.
15. Rename the NODE by hand: does grok's own title change (the `/rename` write leg)?
16. Reboot (or `tmux kill-server`) and reopen the project: does the node cold-restore with
    `grok --resume <id>` and land in the SAME conversation, in the right cwd? Note that after
    an app restart the session NAME will not resolve until that session's next hook (§8.5).

Fixtures the unbuilt features need, modes, restart
17. CAPTURE `signals.json` from a live session (Task 5 Step 1): note `/session-info`'s used and
    total tokens first, then find the keys holding those two numbers. If NO total appears in
    signals.json or summary.json, record that — no window means no context meter, ever.
18. Settings → Agents → Auto: does the launched command carry `--permission-mode auto`, on a
    machine WITHOUT claude installed? (The claude gate must not touch grok.)
19. Does `--permission-mode acceptEdits` launch cleanly, and what does grok actually do with it
    (its hook payload only ever reports default/auto/plan/bypassPermissions)? Check a
    prompt-carrying launch too (transfer / open-agent / spawn-team): the flag must appear
    BEFORE the `--`.
20. "Restart agent (resume)" on an idle grok node: does it `/quit`, wait for the shell, and
    resume the same session? Is it refused while the node is RUNNING?

Skills
21. `grok inspect --json`: are `manage-nodeterm-canvas` and `get-linked-context` listed? If not,
    canvas control needs a different discovery path (§8.7) — re-plan, do not force it.
22. From a grok session, run the canvas shim: does a node appear on the canvas? The path differs
    per surface — LOCAL sessions get `<userData>/canvas-control/nodeterm.sh` (the path written
    into the skill's own SKILL.md), remote SSH sessions get `$HOME/.nodeterm/nodeterm.sh`.
23. CAPTURE `updates.jsonl` (Task 10 Step 1) and the `spawn_subagent` PreToolUse/PostToolUse
    payloads (Task 11 Step 1). Grok is NOT in CONTEXT_LINK_CAPABLE, so `get-linked-context` from
    the grok side does nothing yet; a claude node linked to a grok node likewise reads nothing.

SSH
24. Connect an SSH project, then on the host: `cat $HOME/.grok/hooks/nodeterm-status.json`.
    Present, with the `.*` matcher?
25. Does a REMOTE grok node show badges? (Reverse tunnel + remote script.) Its session NAME will
    not resolve — that is the known asymmetry in §8.4, not a new bug.
26. If the host sets GROK_HOME, did the file land there and not in `$HOME/.grok`? NOTE the
    trap: we probe it with `printf %s "${GROK_HOME:-}"` over a NON-LOGIN ssh exec, so a host that
    exports GROK_HOME only from `.bashrc` reports EMPTY and silently gets `~/.grok` — the wrong
    directory, with no symptom at all. If it bites, give the probe the login-shell + PATH
    treatment `SshProjectManager.connect` uses for the remote `claude --version`.

Surfaces
27. Server Edition in a browser: grok badges, unread dot, no context meter, notch N/A. Also
    confirm the node title does NOT adopt grok's session name there (readSessionName is stubbed).
28. Phone: does a grok node appear in the inbox with the right state? Its "what it's doing now"
    activity line will be absent (§8.3).
29. macOS notch: does the grok mascot walk while it works?
30. Kanban board + card modal: badges and the 💬 comments panel on a grok card (the meter row has
    nothing to show).

Two traps with no code fix — appended so the numbering above stays stable
31. `echo $GROK_HOME` in a nodeterm terminal, then check where the hook file actually went. The app
    resolves it from the APP's environment, and a GUI launch (Finder/Dock/`.desktop`) never sourced
    your shell rc — so an `export GROK_HOME=…` in `.zshrc`/`.bashrc` splits the two sides and
    EVERYTHING silently stops working: no badge, no unread, no notification, no session name, no
    error (§8.9). Compare a shell launch (`npm start`) with a GUI launch (`open -a nodeterm`): a
    difference between them IS the trap. Report whether you set the variable at all — that answer
    decides whether a login-shell probe gets built.
32. **Shift+Enter in a grok node.** nodeterm remaps it universally to `\x1b\r` (ESC+CR / M-Enter,
    `terminalKeyAction` / `SHIFT_ENTER_SEQ`), which is what claude and codex want for "insert a
    newline, don't submit". Grok's own key handling is unverified here — orca records a
    `ctrlEnterEncoding: 'csi-u'` for it, i.e. a different encoding family — so check both: does
    Shift+Enter insert a newline (not submit), and does plain Enter still submit? If the remap fights
    grok, the fix is a per-agent encoding in `terminal-config.ts`, not a global change.
33. **Does a grok elicitation survive its turn end?** Open an ask (whatever produces
    `elicitation_dialog` / `agent_needs_input`) and watch what the node does when the turn finishes.
    Codex has exactly this shape — its `request_user_input` ends the turn with the question still
    open, the answer arriving as a fresh `UserPromptSubmit` — so `normalizeCodex` marks the ask
    `awaitingInput` and `reduceEntry` holds `waiting` through the turn-end `done` (main's `7a40aab`,
    observed live on codex-cli 0.145.0). Grok does NOT set that flag, deliberately: if grok behaves
    like codex, a grok node goes green while it is still waiting on you; if it does not, setting the
    flag would pin NEEDS YOU on a node that genuinely finished. Report which happens — a green node
    over an open question means grok joins the `awaitingInput` path, one line in `normalizeGrok`.
```

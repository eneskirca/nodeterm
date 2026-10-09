# Cursor Agent CLI (`cursor-agent`) as a nodeterm agent

Builtin id `cursor` (`AGENT_CONFIG.cursor`, launch `cursor-agent`, prompt behind the `agent`
subcommand). Sections 1 to 8 cover the status-hook leaf: `cursor` is a member of
`AGENT_HOOK_TARGETS`, so a Cursor node gets the RUNNING badge, the unread dot, the completion
notification, `--after` dependencies and trigger targets. The later sections cover every capability
it joined since (model and permission flags, chat, meter, session continuity, NEEDS YOU,
orchestration). Sibling write-ups:
`docs/antigravity-agent.md` (closest precedent), `docs/grok-agent.md`.

**Where the facts come from.** Measured on `cursor-agent` 2026.09.28-64d2043 (macOS): five headless
(`-p`) runs on a paid account, two zero-cost interactive TUI launches, and the shipped JS bundle
(`~/.local/share/cursor-agent/versions/*/`). The installed CLI auto-updated from 2026.09.23 during
the work. Fixture: `src/shared/agents/__fixtures__/cursor/hook-payloads.json`.

## 1. The recorded id (for the resume work)

Every hook payload carries **`conversation_id`** and a duplicate **`session_id`** (equal in every
capture). `normalizeCursor` records `conversation_id` (falling back to `session_id`) as the event's
`sessionId`, which is how every agent's id reaches `agentStatus`. **Verified with zero cost:**
`cursor-agent --resume <conversation_id>` opens that chat with its history. `cursor-agent
create-chat` prints a new empty chat id. The transcript path is
`~/.cursor/projects/<workspace path with non-alphanumerics as "-">/agent-transcripts/<id>/<id>.jsonl`
(JSONL; the last line is `{"type":"turn_ended","status":"success"|"error"}`), and the payload's
`transcript_path` names it once the first turn is written (null before).

## 2. Hook config

- Files read: `~/.cursor/hooks.json`, `<workspace>/.cursor/hooks.json`, enterprise/team files, and
  **`~/.claude/settings.json` (+ project `.claude/settings*.json`)** as Claude compat.
- Shape: `{"version":1,"hooks":{"<camelCaseEvent>":[{"command":"...","timeout":5}]}}`, flat entries.
- 21 events exist. We subscribe six (`CURSOR_HOOK_EVENTS`): `beforeSubmitPrompt`, `preToolUse`,
  `postToolUse`, `postToolUseFailure`, `stop`, `sessionEnd` (see "Session continuity").
- Payload envelope (all events): `conversation_id`, `session_id`, `generation_id`, `model`,
  `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email`, `transcript_path`. Tool
  events add `tool_name` (`Shell`, ...), `tool_input`, `tool_use_id`, `cwd` (was `""`), and
  `postToolUse` adds `tool_output`, `duration`. Hook env carries `CURSOR_PROJECT_DIR`,
  `CURSOR_VERSION`, `CURSOR_TRANSCRIPT_PATH`, `CLAUDE_PROJECT_DIR`, and the parent's env
  (so `NODETERM_NODE_ID` reaches our script).
- `sessionStart` fires once at startup, **not on `--resume`** (measured in the TUI and in the bundle).
  Re-measured on 2026.10.01 (private tmux, project-level logger, no prompt): a plain `cursor-agent`
  fires it within seconds, before any prompt, with `conversation_id` (== `generation_id`); a
  `cursor-agent --resume <fresh uuid>` (how nodeterm launches EVERY node, minted id included) fired
  nothing until `/quit` (`sessionEnd`), two runs. So it is not subscribed: it would not give a fresh
  nodeterm node a status before its first turn (no DROPPED chip if it is killed before one).

## 3. Is the hook a gate? Yes, for some events; silence is the safe default

From the bundle (`executeCommandHook`) and confirmed by runs:

| hook result | effect |
|---|---|
| empty stdout, exit 0 | no-op; the tool ran (measured on `preToolUse`) |
| exit 2 | DENY on gating events (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `subagentStart`) |
| any other non-zero exit, timeout | logged as failed, fail-open unless the entry sets `failClosed` |
| stdout that is not valid JSON | DENY on gating events ("blocked for safety") |

So the installed command is `sh <script> >/dev/null 2>&1 || :` (`buildManagedHookCommand`
`silent`): a broken script can never print garbage or exit 2. Our script prints nothing anyway.

Traps found:
- Cursor strips `//...` from hooks.json as JSONC comments **ignoring quotes**, before parsing. A
  command containing `//` corrupts the whole file for every tool. The installer refuses to write one.
- **A headless run subscribed to 18 events (incl. `afterAgentResponse`, `afterAgentThought`,
  shell/MCP/file events) plus a claude-format project file lost its agent stream after the first
  reply three times ("Connection lost... WritableIterable is closed"); the same run with the five
  events plus sessionStart/sessionEnd finished clean.** Which difference broke it is unknown, so the
  extra events are not subscribed. Device item 3.
- Server tells the client which steps have hooks (`hooksConfig.configuredSteps`) and calls only those.

## 4. State mapping (`normalizeCursor`, pure, closed set of exact names)

| event | result |
|---|---|
| `beforeSubmitPrompt` | `working`, `newTurn` |
| `preToolUse` / `postToolUse` / `postToolUseFailure` | `working`; null for a subagent's call (`isCursorChildToolEvent`); the parent's `Task` preToolUse is `subagent-start` (see "Orchestration parity") |
| `stop` | `done`; `interrupted` if `status==="aborted"`, `errored` if `"error"` |
| `sessionEnd` | session phase `end` (skipped when `is_background_agent`) |
| anything else | null |

The phone's activity line comes from the raw listener (`applyCursorRaw`): a parent `preToolUse` is
recorded as claude's `PreToolUse` (tool name and input, so `Shell` reads "Running ..."), `stop` /
`sessionEnd` as `Stop`; a child's tool event is skipped.

**No NEEDS YOU from the normalizer.** Measured: the `AskQuestion` tool fires no tool hook (headless
and TUI); Cursor's own approval prompt has no hook either. Guessing one from events would strobe
(rule 7). The approval prompt and the AskQuestion box are detected from the pane instead: see
"NEEDS YOU, SSH hooks and lost stop" below.

## 5. Cross-fire with nodeterm's claude hook (measured)

With a matcher-bearing claude-format settings file, Cursor ran the claude hook command on its own
`sessionStart`/`preToolUse`/`postToolUse` (payload keys unchanged, `hook_event_name` camelCase).
A file with only matcher-less entries is NOT treated as claude-format (Cursor's `isClaudeFormat`
needs one `matcher`), but this machine's `~/.claude/settings.json` has other tools' matcher entries,
so nodeterm's `claude.sh` fires in every Cursor node here. **Inert:** `normalizeClaude` compares exact
PascalCase names and returns null for every captured cursor payload (pinned in
`normalize.cursor.test.ts`), and the claude raw listener returns before any association or tail write
for a payload that `isCursorPayload` recognises (`cursor_version` or `conversation_id`; no Claude
payload has either). It used to record `nodeContextSession.set(node, session_id)`, often a CHILD's
id, so `pty:destroy` released the wrong session and the parent's cursor tail leaked (pinned in
`src/server/agent-status.test.ts`). Cost: two POSTs per event. Do not canonicalise claude's
event-name compare.

## 6. Installer (`core/agents/hooks/cursor.ts`)

Merges into the SHARED `~/.cursor/hooks.json` (the real one holds another tool's `sessionStart`
entry) through `updateSettingsFile` (symlink-safe, locked, mode kept, ENOENT-only creation): our
entries are appended to the five events, ours are swept from any other event, every other
entry/key survives, an unparseable or mis-shaped file is left byte-for-byte, a second run writes
nothing. Only where `cursor-agent` is found (PATH, then `~/.local/bin`); one boot pass (no
login-shell re-probe like agy). Removal deletes only our entries and never creates the file. Ours =
command containing `.nodeterm/agent-hooks/cursor.sh`. Tests use a temp dir, never the real home.

Consent (issue #744, `core/agent-integrations.ts`): the installer runs only for a `cursor` choice of
`enabled`, like every other agent. `declined` runs `removeCursorHooks`, deletes `cursor.sh` and our
two skills from `~/.cursor/skills` (exact-content receipts; a file the user edited is kept). Never
asked = nothing written, nothing removed.

## 7. Surfaces and what is not done

- Desktop and Server Edition: both via the consent lifecycle (`installManagedAgentHooks`); state comes from the normalizer,
  and both raw listeners call the one shared `applyCursorRaw` (meter, subagents, activity line).
  Mobile: status mirror is agent-agnostic.
- SSH: `RemoteHooks.installCursorRemote` (see "NEEDS YOU, SSH hooks and lost stop" below).
- Windows: `installCursorHooks` writes nothing (`'refused'`). The command is POSIX sh, Windows
  hook execution is unmeasured, and a non-JSON byte on `preToolUse` denies the tool in every
  cursor session on the machine. The remote installer only targets POSIX hosts.
- Joined since this section was first written: resume, mint, session end and the model list
  ("Session continuity"), chat/transfer/context link and the meter, canvas control, rename and
  subagents ("Orchestration parity"), plan usage in the usage pill (see "Context meter"). Not joined:
  recurring (`/loop`), branch (claude-only).

## 8. Device checklist (unverified)

1. Answered: the interactive TUI fires `beforeSubmitPrompt` and `stop` (see "NEEDS YOU").
2. `stop` payload: `completed` captured (interactive subagent run); `aborted|error` still assumed, and whether Esc fires it.
3. Bisect the 18-event stream failure (add events back one at a time in a headless run).
4. ~~Subagent behaviour~~ measured on 2026.10.01, see "Orchestration parity".
5. Answered: `/quit` fires `sessionEnd`; cursor is in `SESSION_END_CAPABLE` ("Session continuity").
6. Answered: no hook for either (measured in the TUI); both the approval prompt and the AskQuestion box are read from the pane.
7. Hook latency inside a node (script backgrounds the POST; expected small).
8. Linux and Windows: hooks.json location, `cursor-agent` install dir.

## Model and permission flags

Measured on `cursor-agent` 2026.09.28-64d2043 (macOS). Cursor is in `MODEL_SWITCH_CAPABLE` and
`PERMISSION_MODE_CAPABLE`; the translation lives in `src/shared/agents/approval-mode.ts`
(`CURSOR_MODES`) and `withAgentModel` in `model-gateway.ts`.

### Where the flags go

The composed line is `cursor-agent [flags] agent '<prompt>'`, flags BEFORE `agent`. `agent` is a
commander subcommand with no options of its own; its action reads the root program's options
(`Ie()` is `root.opts()` in the bundle), and root parses `--model`, `--force`, `--mode` wherever they
sit. Measured in the TUI (no prompt, so no model cost) both `cursor-agent --model X agent` and
`cursor-agent agent --model X` show model X; the same for `--force` ("Run Everything"), `--mode plan`
and `--auto-review`. Both composers (`assembleLaunchCommand`, `core/agent-launch.ts`) are pinned by
tests.

### Mode table

| nodeterm mode | emitted | why |
|---|---|---|
| Ask each time (`manual`) | nothing | cursor's default is `approvalMode: allowlist`; a shell command off the allowlist stops at "Run this command? Not in allowlist" (measured) |
| Auto (`auto`, the default) | `--auto-review` | Cursor's Smart Auto: a classifier auto-runs safe calls and prompts for the rest, the same shape as claude's `auto`. Measured on 2026.10.01: `touch` ran unprompted, footer "Auto-review". Cursor ships in this change, so no existing node widens. |
| Accept edits | nothing | no flag means "auto-approve edits, prompt for shell" |
| Plan | `--mode plan` | measured: a "create a file" prompt produced a written plan ("Ready to build?"), no file |
| Bypass all | `--force` | measured: the shell command ran with no prompt, footer "Run Everything" |

Only `acceptEdits` shows in `unsupportedModesNote`. `--sandbox` is a separate axis and is not
touched (cursor's sandbox is off by default, so the Bypass caveat does not claim one). `--mode ask`
has no nodeterm mode.

### Models

`--model <id>`, quoted by `withAgentModel`. The catalogue is `cursor-agent models` (about 250
account-scoped ids, `<id> - <label>` lines, some with zero-width spaces at the end). Cursor is in
`OWN_MODEL_CATALOGUE` with grok: it never receives the gateway's models (`modelsForAgent` returns
none, transfer targets stay flat, the gateway default model is not applied).

### Model and permission: not verified / not built

1. Superseded: cursor is resumable now and the restart menu's "Switch model" lists
   `cursor-agent models` (see "Session continuity", Models). The transfer menu stays flat.
2. `--auto-review` measured on one safe command only (`touch` auto-ran); which calls its classifier still prompts for is Cursor's server-side policy and was not mapped.
3. What cursor does with an unknown `--model` id is unmeasured.
4. `--model` in the TUI adds the id to `modelParameters` / `modelSelectionHistory` in
   `~/.cursor/cli-config.json` (seen on the real config); it did not change the saved default model.
5. A model can be rate-limited per account ("You've hit your usage limit" for `gpt-5.4-nano-none`);
   that error comes from the backend and proves the flag reached it.

## Transcript, chat view and context link

Leaf: `src/core/cursor-chat.ts`. Measured on `cursor-agent` 2026.09.23 and 2026.09.28 (macOS), against
real chats (a `-p` run with a shell turn and a write/read/grep turn, plus an older subagent chat).

**Storage.** `<config>/chats/<md5(physical cwd)>/<chatId>/store.db`, where `<config>` is
`$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor` (the CLI's own rule).
`<chatId>` is a UUID: the `--resume` id and the stream-json `session_id` (stable across resume).
2026.09.28 also writes a `meta.json` sidecar. `--resume <id>` of an unknown id creates `store.db` at
once (meta key `0` = hex JSON with `latestRootBlobId: ""`); only a fresh TUI quit before any turn
leaves `meta.json` alone, with no `store.db`.
The store is SQLite (WAL): `meta` key `0` = hex(JSON) with `latestRootBlobId` and `name`; `blobs` is
content addressed (sha256). The root blob is protobuf (`ConversationStateStructure`): field 1 lists the
ordered ids of the model-context messages, each an AI-SDK-shaped JSON blob (system / user / assistant
parts `text`, `reasoning`, `redacted-reasoning`, `tool-call` / tool `tool-result`). The typed prompt is
`<user_query>` inside a user text part; everything else in user messages is injected context. The
root's field 5 holds `used / window` context tokens, which the meter reads ("Context meter"; verified
18335 / 200000 = the TUI footer's 9.2%).
Not used: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`. Its text reads `[REDACTED]`, it
has no tool results and lost the user line of a failed turn.

**Reading.** Built-in `node:sqlite`, read-only (Electron 42 = Node 24.19; `engines` floor has it). No new
dependency. Found strictly by the whole-UUID id; the cwd only orders the bucket search. There is no cwd
fallback, so another chat is never shown. One page, `olderCursor: null`. Newest 16 MiB of messages
are read. Compaction replaces the model context, so pre-compaction turns are not shown.

| Capability | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| ⌘M chat (`CHAT_CAPABLE`) | yes | yes (core handler) | yes, via relay `chat.page` | refused: "not supported yet" (`CHAT_LOCAL_ONLY`), never the local disk |
| Context link, both directions (`CONTEXT_LINK_CAPABLE`) | yes | yes | N/A | no transcript for a remote node ("no conversation transcript yet") |
| Transfer source (`TRANSFER_SOURCE_CAPABLE`) | yes | N/A (handoff is desktop main) | N/A | refused with its own sentence |
| Session name read (`TITLE_READ_CAPABLE`) | yes | sweep to the mirror only (the IPC read is stubbed there for every agent) | via mirror | none (node keeps its title) |

`get-linked-context` discovery: cursor-agent lists `~/.claude/skills/get-linked-context` in its own
`<agent_skills>` (measured). Since the consent change (#744) each agent gets the skills in its own
dir, so cursor's copy goes to `~/.cursor/skills` (below, "Canvas control"). The composer's model label, effort, plan/question
cards and `at` timestamps are not supported. `/rename` joined `RENAME_CAPABLE` later ("Orchestration parity").

## Device checklist (not verified)

1. ⌘M on a live interactive node after hooks supply the chat id (this leaf assumes the node's session id is it).
2. A chat with a very long history (compaction) and one over 16 MiB.
3. Title chip after cursor auto-names an interactive chat (print mode leaves `New Agent`).
4. Server Edition on Linux and Windows path hashing of the cwd bucket (only the id scan is relied on).

## Context meter (`USAGE_CAPABLE`)

Source: the agent's OWN numbers (CLAUDE.md rule 6), not the `stop` payload's `input_tokens` /
`cache_read_tokens` (no window there). The store's root protobuf field 5 is `token_details` {1
used_tokens, 2 max_tokens}; it matches the TUI's `/context`, and `max` varies per session (200000 /
256000 / 300000 / 1000000), so it is read, never inferred. No `max`, no meter. Read by the one store
reader (`readCursorStore` returns `tokens`; `rootMessageIds` and `rootTokenDetails` share one protobuf
walker in `core/cursor-chat.ts`). No second SQLite reader.

**Tail choice.** `createContextTail` gained one option, `readSource(path, lastKey)`, replacing the
byte read for a source that is not a text file. Cursor's is `readCursorContextSource`: stat of
`store.db` + `store.db-wal` as the change key (WAL leaves the db file untouched between checkpoints),
then the store read for the numbers only, handed to `cursorContextParse` as one JSON line. The shared
1 Hz poll does the re-reading; cursor hook events (`trackCursorContext`) only locate and track the
store, strictly by `conversation_id` (`locateCursorChat`, chats root only, whole-UUID). note: a
poll, not a hook-triggered reader; upgrade if the stat gate ever shows up in a profile.

**Jail.** No payload path is consumed: `transcript_path` names the redacted agent-transcripts jsonl and
is ignored, so there is nothing to widen in `safeTranscriptPath`; the only path is the one the locator
builds under `cursorConfigDir()` (honours `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME`).

**Gates.** `hasUsage` also gates `context.ensure` (now a `cursor` case: `locateCursorChat(id)`, no cwd)
and the find-bar index and cold-resume stay on `readsClaudeTranscript`, which is false for cursor (pinned).

| Surface | Status |
|---|---|
| Desktop | yes: raw listener `agentId === 'cursor'` in `src/main/index.ts`; ensure routes to `cursorContextTail` |
| Server Edition | yes: same branch in `src/server/agent-status.ts` (parity), `tailFor` in `src/server/index.ts` |
| Mobile | meter rides the shared context mirror (agent-agnostic); not device-verified |
| SSH node | "not yet": raw branch returns for a remote node, `ensureRemote` is terminal `unresolved`, never this machine's disk |

Plan usage is read separately, in the bottom usage pill (`src/core/usage/cursor-usage.ts`, provider
`cursor`, shown by default, Settings -> Usage toggle). Measured on cursor-agent 2026.10.01-e373342:
the CLI's own `/usage` calls `aiserver.v1.DashboardService/GetCurrentPeriodUsage` (Connect, plain
JSON POST `{}`) on `https://api2.cursor.sh` with the login's bearer token. Fields used:
`planUsage.totalPercentUsed` (else `includedSpend / limit`, the CLI's fallback), `autoPercentUsed`,
`apiPercentUsed`, and `billingCycleEnd` / `billingCycleStart` (epoch ms as strings) for the reset and
window. The credential is the CLI's: macOS login Keychain (account `cursor-user`, service
`cursor-access-token`, created by `/usr/bin/security`, so reading it with the same binary raises no
prompt), else `auth.json` (`~/.cursor/` with `AGENT_CLI_CREDENTIAL_STORE=file`, `$XDG_CONFIG_HOME/cursor/`
on Linux, `%APPDATA%/Cursor/` on Windows). Read only, never refreshed; the token stays in process
(only the service name is on argv). Not signed in, an expired token (401/403) or a reply over 256 KB
(read stops there, never parsed) = no row; network or
5xx = error status keeping the last good numbers of the same login for up to an hour. Not shown:
dollar spend, bonus credit, on-demand (spend limit) usage, the plan name, and enterprise accounts with
no `planUsage`. SSH hosts: local login only, no remote leg. Model is not shown in the context meter
(the store root states none cheaply; the popover omits it).
Verified live on the dev app: the header showed 90% left against the TUI footer's 10.1% used.
Unverified: a real store read in this branch's tests (fixtures are synthesized), Mobile on device.

## Session continuity (resume, mint, session end, restart, models)

Measured on `cursor-agent` 2026.09.28 (macOS, tmux TUI, project-level hooks logger). One paid run
(composer-2.5), the rest zero cost.

**Grammar.** `--resume [chatId]` is a ROOT option with an OPTIONAL value: the id must directly follow
it, then `agent '<prompt>'` may follow. Resume is `cursor-agent --resume <id> [--mode/--force] [--model X]`
(no prompt); flags may sit either side of the id. Both composers (`resumeCommandWith` ->
`assembleResumeCommand`, and `core/agent-launch.ts` argv) emit it; pinned in `cursor-launch.test.ts`
and `agent-launch.test.ts`.

**Dead id is safe.** `--resume <unknown uuid>` opens an empty chat that ADOPTS that id (exit 0, no
error; a `chats/<bucket>/<id>/` dir appears). So a wrong id costs the history, never the launch.

**Minting (`SESSION_ID_CAPABLE`, unconditional like copilot).** Because an unknown id is adopted, a
fresh UUID on first launch IS minting, with no model call: `cursor-agent --resume <uuid> [flags] agent
'<prompt>'`. Paid run: that exact line answered "pong" and `stop` carried `conversation_id` == the uuid.
`create-chat` (1.5 s, network) is NOT used: it returns a cursor-chosen id, and nodeterm needs the id
before launch. No help probe: the flag is the one resume already needs, and the adopt behavior is not a
flag a probe could see. An id that already exists just resumes (never grok's "taken id" launch error).
If an older CLI ignored the unknown id, the node degrades to the hook-learned id.

**Session end (`SESSION_END_CAPABLE`).** `/quit` + Enter fires `sessionEnd` (also with a resumed
chat). `normalizeCursor` maps it to `sessionPhase: 'end'` (skipped when `is_background_agent`), AND
`sessionEnd` is added to `CURSOR_HOOK_EVENTS`: the list is inert, and every quit would read as a
DROPPED crash, without the subscription. Existing installs gain it on the next installer pass.

**In-place restart.** `EXIT_SEQUENCES.cursor = '/quit'` (bare). Enter is a SEPARATE write (150 ms
split, as opencode): text+Enter in one write is not submitted. Ctrl-U (`KILL_LINE`) clears a half-typed
draft in the cursor TUI (measured). The `/quit` also waits `EXIT_KEY_GAP_MS` (150 ms) after the
Ctrl-U: measured on 2026.10.01 in a private tmux, Ctrl-U+`/quit` in one burst then Enter 150 ms later
left the CLI running 10 of 10 (the `/quit` was dropped, composer empty); Ctrl-U, 150 ms, `/quit`,
150 ms, Enter returned to the shell 10 of 10. Applies to every `submitsSeparately` agent. The restart rejects `working` and
`blocked` (the approval watch reports Cursor's approval prompt as `blocked`, see "NEEDS YOU").

**Relaunch clears the exit.** Our own `/quit` fires `sessionEnd`, which records `sessionEnded`, and
`--resume` fires no `sessionStart`. So once nodeterm delivers its own resume line (in-place restart,
Pause/Eco wake, and the cold-restore relaunch a model switch recycles into), the node withdraws
`sessionEnded` itself (`performResumePhase`'s `onResumed`, and the cold-restore delivery in
`TerminalNode.tsx`). Without it the chat composer and the phone refused the running CLI as
"exited" until its next turn.

**Models.** `cursorModelsFrom` parses `cursor-agent models` (`<id> - <label>`, zero-width spaces
stripped; 246 of 246 lines matched, header and Tip ignored) into `{id, name}`. Probe: `core/cursor-cli.ts`
(`registerCursorCliIpc`, in BOTH shells), memoized, a failed/empty probe is retried, fails open to [].
Channel mirrors grok's: `IPC.cursorCliCaps`, `window.nodeTerminal.cursor.cliCaps()` (preload, ws-bridge,
stub), renderer memo `ensureCursorCliCaps`/`cursorCliCapsNow` warmed at boot, and `modelsForAgent(...,
cursorModels)` fed by Canvas. This lights the restart menu's "Switch model" for cursor.

**Cold-resume presence: not built.** `transcriptExists`/`shouldProbeTranscript` is claude-only and has
no agent argument on its channel; the store locator (`locateCursorChat`, strictly by id) could answer,
but the dead-id behavior makes it unnecessary: a missing chat resumes into an empty chat under the same
id instead of failing like claude. The only loss is the "lost session" notice.

| Capability | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| Resume / cold restore / restart / mint | yes | yes (core + shared composer) | N/A | hooks via `installCursorRemote` give the id; mint also gives one; remote run unverified |
| Session end (DROPPED chip) | yes | yes (normalizer is shared) | status mirror | hooks via `installCursorRemote`; remote `sessionEnd` unverified |
| Model catalogue | yes (IPC) | yes (WS-RPC handler) | N/A | lists THIS machine's account |

### Not verified (device checklist)

1. `sessionEnd` on Ctrl-C twice, SIGTERM, and a closed terminal (only `/quit` measured).
2. Mint on an older cursor-agent that may not adopt an unknown id.
3. `sessionEnd` of a subagent chat (`is_background_agent` only guards the flag, never seen true).
4. `--resume <id>` after the real chat has history inside a restart, including the Switch model path.
5. Windows `cursor-agent` argv for resume (composer pinned, never run).
6. Models list under an account switch (memoized per process) and offline.

## NEEDS YOU, SSH hooks and lost stop

Measured on `cursor-agent` 2026.09.28-64d2043, interactive TUI in a private tmux, project-level
hooks logger, 4 model runs (composer-2.5).

### NEEDS YOU (`core/agents/cursor-approval.ts`)

| case | hook events | pane |
|---|---|---|
| shell off allowlist | `preToolUse` (Shell), `beforeShellExecution`, then silence | `Run this command?` / `Not in allowlist: touch` / `→ Run (once) (y)` ... `Skip & tell the agent what to do instead (esc or n)`; tool row `$ touch x Waiting for approval...` |
| MCP tool | `preToolUse` (`MCP:ping`), `beforeMCPExecution`, then silence | `Run this MCP tool?` / `→ Run (once) (y)` ... `Skip (esc or n)` |
| approve (y) or skip (n) | `postToolUse` for the same `tool_use_id` (skip too), then `stop` | dialog gone |
| file write (default mode) | no dialog: auto-approved | n/a |
| AskQuestion (measured again 2026-10-04, 6 runs) | NO tool hook on show, on answer (Enter) or on skip (Esc): after `beforeSubmitPrompt` only `afterAgentThought` (not subscribed) until the turn's `stop`, which came 20 to 55 s after the answer, status `error` in every run (the pane printed `WritableIterable is closed`) | bordered box at the bottom of the pane: a title (the model's own, e.g. `Color preference`, or the default `Clarifying Questions`) / `Question 1 of N` / `1. <question>` / `› [ ] Red` ... `[ ] Other: (type to answer)` / footer `↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip` (wraps onto two rows at 60 columns). Answered or skipped, it stays as a summary (`AskQuestion <title> (1)` and `[x]`/`[ ]` rows) with no footer |

Rule: a cursor `preToolUse` whose `tool_use_id` has no `postToolUse`/`postToolUseFailure` after
1.5 s gets a pane read (`ptyManager.captureSession`, bounded by `probeWithin`), retried at 4 s and
10 s (`CURSOR_APPROVAL_READS_MS`) because the dev app's first read once ran before the dialog drew. If the last 30
non-blank lines hold an exact heading from the bundle's `decision-logic.ts` (`Run this command?`,
`Run this command outside the sandbox?`, `Run this MCP tool?`, `Delete this file?`, `Write to this
file?`, `Read this file?`, `Allow this web search?`, `Allow this web fetch?`) followed by an option
ending in `(y)`, the hook server emits `blocked` on the same listener as every hook event. The next
event (`postToolUse` on y/n, `stop` on Esc) replaces it. No pending tool = no timer, no read; at most three reads
per call and one `blocked` per dialog (a second pending call reading the same dialog emits nothing), so a
long approved command never strobes. `stop`/`beforeSubmitPrompt`/`sessionEnd` drop the node's pending calls,
and closing or recycling the node releases them (`hookServer.releaseCursorNode`, both shells), so a read
still in flight cannot bring a deleted node back as `blocked`. A node has at most ONE capture in flight,
across turns, release and a replacement session: a read due while one is outstanding is skipped (never
handed that read's snapshot, which may be another turn's) and its next slot reads fresh. An empty or
timed-out read stops the node's reads until the next turn edge: retrying an unreadable pane stacks ssh
children (`pane-probe.ts`). Only a parent event names the node's session: any event with
`generation_id === conversation_id` is a child's and never lends its id to a synthetic event.
No subagent `sessionEnd` was seen in any capture (three subagent runs plus the reviewers'); the
parent's own `sessionEnd` also has `generation_id === conversation_id`, so the two could not be told
apart by that field if a child one ever appeared (unverified).

**Subagent calls** (`isCursorChildToolEvent`: `generation_id === conversation_id`) are watched too.
Measured on 2026.10.01 (private tmux, a Task/explore child running `find . -name '*.txt' | sed … |
sort`): the child's `preToolUse` Shell drew `Run this command?` / `Not in allowlist: find, sed, sort` /
`→ Run (once) (y)` on the PARENT pane while the parent turn was still working. The watch emits `blocked`
1.5 s later with the PARENT's chat id (remembered from the node's parent events; omitted if none was
seen yet), never the child's, which would replace the node's resume id. normalizeCursor drops child
events, so the child's `postToolUse` (measured for `y`, and for `n` + an empty "tell the agent" line)
makes the watch emit `working` itself. The parent's `Task` call is not watched: it never gets a
`postToolUse`, and watched it caught the child's dialog first and emitted a duplicate `blocked`
(measured before the fix).

**Plan mode.** Measured (`--mode plan`): the turn ends with `stop` status `completed`, then the pane
shows `Ready to build?` / `→ 1. Yes, build locally (b)` / `2. Yes, build in cloud (c)` / `3. No, propose
changes (p or Esc)`. A parent `stop` with status `completed` therefore arms the same three reads, and
`Ready to build?` followed only by option rows ending in a `(key)` hint and the box border (it must be
the bottom of the pane) emits `blocked`, as claude's ExitPlanMode is. Strict on purpose: the answered
box stays in the transcript, and the build's own `stop` read it 30 lines up (measured). `b` fires no
`beforeSubmitPrompt`; the build's first parent `preToolUse` ends the block (a `Task` normalizes to
`subagent-start`, not `working`, so the watch emits `working` itself) and cancels the reads. Cost:
up to three pane reads after every completed turn, plan mode or not.

**AskQuestion.** The box has no hook (table above), so the watch hangs the same bounded reads on a
quiet stretch of a working turn: `beforeSubmitPrompt` and every tool post (a child's too, since the
parent's `Task` never posts and the parent may ask once its child is done) arm them, a `preToolUse`
cancels them (a tool is running), `stop`/`sessionEnd`/release drop them. `cursorQuestionIn` matches
the box by structure, not by title (the title is the model's): the footer ending `Esc to skip` must be
the last row above the bottom border, with a `Question N of M` row and an option row (`› [ ] ...`,
`[x] ...`) above it, so the answered summary left in the transcript never matches (measured: the next
turn's first read saw it and did not). A match emits `waiting`, what Claude's AskUserQuestion
normalizes to (NEEDS YOU, a question card on the phone, chat send and agent messaging refused). The
next parent tool event replaces it (`working`; the watch emits it itself before a `Task`) and so does
`stop` (`done`, `errored` for the measured `error` status). Live replay (real hook log, real tmux
pane, `createCursorApprovalWatch`): the 1.5 s read missed the box both times and the 4 s read caught
it. Cost: up to three pane reads per quiet stretch of 1.5 s or more, on any turn.

| Surface | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| NEEDS YOU on approval and on the AskQuestion box | yes (`hookServer.setPaneReader` in main) | yes (same call in server) | yes (mirror is agent-agnostic) | yes: `captureSession` reads the remote tmux over the ControlMaster (one ssh child per read) |
| Kanban card, chips, card modal | `cardBadge` / `chatSendRefusal` read `blocked` for every agent | same | N/A | same |
| Chat send / agent messaging refuse while blocked | `chatSendRefusal` = `dialog`; `decideDelivery` = `targetBusy` | same | same | same |

Limits: an AskQuestion box first drawn more than 10 s after the last hook event (the last read of
the stretch) keeps the node on RUNNING; after the answer the node stays NEEDS YOU until the turn's
next hook, measured 20 to 55 s later (`stop`), because nothing marks the answer itself. The
headings other than shell and MCP are bundle-read, not seen in a pane. Unmeasured: `p`/Esc on the plan
prompt (no hook expected; the node stays NEEDS YOU until the next prompt's `beforeSubmitPrompt`).

### SSH hook installer (`RemoteHooks.installCursorRemote`)

`cursor` left `LOCAL_ONLY_HOOK_AGENTS`, so `--after` accepts a cursor node on an SSH project. On
connect, only where the host has `cursor-agent` (`command -v`, or `~/.local/bin/cursor-agent`, which a
non-login ssh shell often lacks): write `~/.nodeterm/agent-hooks/cursor.sh` (stdin), then merge into
the host's `~/.cursor/hooks.json` with the local installer's pure `applyCursorHooks` through
`updateRemoteSettingsFile` (content over stdin, lock dir, other tools' entries kept, an unparseable
file left byte-for-byte, a second run writes nothing). A command holding `//` is refused before
anything runs. Tested under a real `/bin/sh` against a fake host tree
(`remote-cursor-hooks.test.ts`). It runs only when the host's consent plan installs `cursor`; a plan
that removes it strips our entries from the host's `~/.cursor/hooks.json` (`stripRemoteSettingsFile`,
never creating the file) and deletes `cursor.sh`. Its skills go to `~/.agents/skills`, a root the
bundle loads (unverified on a host).

### Lost stop

A mid-turn network reconnect dropped `stop` (measured, wave 1). No new timer: the mirror's
`sweepStaleWorking` (core) and the renderer's `sweepStaleWorking` both match `state === 'working'` for
any agent, so a cursor node with a lost `stop` turns `done` after `WORKING_STALE_MS` (20 min) of
silence (pinned in `cursor-approval.test.ts`). `blocked` is not swept, by design (a person may take
long); its clearing event is the `postToolUse`/`stop` of the same turn.

### Device checklist (not verified)

1. A cursor node on the real canvas: NEEDS YOU badge, chime and phone card on the shell dialog;
   back to RUNNING on y.
2. Linux host over SSH: install lands, hooks fire through the tunnel, the remote pane read matches.
3. `Run this command outside the sandbox?` (sandbox on) and the Write/Delete/Read/web dialogs:
   heading text and a `(y)` option as rendered.
4. A very long command preview pushing the heading above the 30-line window (would degrade to RUNNING).
5. Two parallel tool calls with one approval: the other call's `postToolUse` returns the badge to
   RUNNING while the dialog is still up (no re-read).
6. A cursor node on the real canvas: NEEDS YOU and a question card on the phone for the AskQuestion
   box; DONE after Esc or after the answer's `stop`.

## Orchestration parity (canvas control, subagents, rename, loop)

Measured on `cursor-agent` 2026.10.01-e373342 (it auto-updated from 2026.09.28 during the work),
macOS, in the INTERACTIVE TUI inside a private tmux server, scratch workspace with a project
`.cursor/hooks.json` logger for ten events (incl. `subagentStart`/`subagentStop`). Five model turns
(composer-2.5). Fixture: `src/shared/agents/__fixtures__/cursor/subagent-payloads.json`.

### Canvas control (`CANVAS_CONTROL_CAPABLE`)

Membership is the whole wiring, like grok: it sets `NODETERM_CANVAS_CONTROL` (`buildPtyEnv`,
`remoteHookEnvArgs`) and lets `controlRouting`/the Server factory accept a cursor source. Discovery:
asked to list its skills, cursor named `~/.claude/skills/manage-nodeterm-canvas/SKILL.md` and
`get-linked-context`. The bundle loads skill roots in this order: `~/.cursor/skills-cursor` (built-in),
`~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, plugins; the three
third-party roots are gated by `thirdPartyExtensibility` (CLI default on; a team setting could turn
it off). Trap: cursor TRUNCATES a long skill list ("52 additional skills were omitted" here), from
the tail. `~/.claude/skills` sits third, so it survived; a user with hundreds of `~/.cursor/skills`
could push it out. Since #744 the skills are written into `~/.cursor/skills` under cursor's own
consent (`skillRootsFor`), which also keeps canvas control working when claude is declined. That
copy is not measured in a live session yet; the `~/.claude/skills` copy (when claude is enabled) is.

### Subagents (`SUBAGENT_CAPABLE`)

Three runs (two built-in `explore`, one custom `.cursor/agents` subagent), all the same:

| fact | measured |
|---|---|
| `subagentStart` / `subagentStop` | never fired, although subscribed |
| parent `Task` tool | `preToolUse` (with `tool_input.subagent_type`, `description`, `prompt`) and NO `postToolUse` |
| child tool events | `conversation_id` = `generation_id` = the CHILD's chat id; no `parent_tool_call_id`; `transcript_path` null on its first preToolUse, its own JSONL after |
| ordering | synchronous: every child event landed before the parent's `stop` |
| correlating key | none in any hook payload. The child's `store.db` meta has `subagentInfo {parentAgentId, rootParentAgentId, toolCallId, typeName}`; `toolCallId` == the parent `Task`'s `tool_use_id` |
| child transcript | `<config>/projects/<slug>/agent-transcripts/<childId>/<childId>.jsonl`, append-only, ends `{"type":"turn_ended","status":"success"}`; assistant text often `[REDACTED]` |

So: `normalizeCursor` turns the parent `Task` preToolUse into `subagent-start` (key `tool_use_id`),
and returns null for a child's tool event (`isCursorChildToolEvent`: `generation_id ===
conversation_id`). That rule also fixed a real bug: child events used to drive the parent badge AND
replace the node's recorded session id (the resume id) with the child's. The END and the live tail
live in ONE core helper both shells call (`core/cursor-subagents.ts`, `createCursorSubagentTracker`):
the parent's `stop` emits `subagent-end` for every Task opened in that turn, and a child is tailed
(`subagentTail.trackFile` + `createCursorSubagentFormatter` over its JSONL, path jailed under
`<config>/projects/`) when exactly one of the node's open Tasks is unclaimed.

Trade-offs, stated: a HEADLESS (`-p`) run has `generation_id === conversation_id` on its own tool
events (2026.09.28 capture), so they now read as a child's and drive nothing; headless runs fire no
`beforeSubmitPrompt`/`stop` either, so those events only ever lit a RUNNING badge nothing cleared.
Parallel Tasks get cards but no tail (note: read the child meta's `toolCallId` to claim them). A
lost `stop` (network reconnect) leaves the cards to the shared `WORKING_STALE_MS` decay. A node
closed or recycled mid-Task releases its entry and child tails (`tracker.release`, called from both
shells' `releaseNodeTails`). Not
subscribed: `subagentStart`/`subagentStop` (never fired; `subagentStart` is a GATING event, so a
subscription is only risk).

### Rename (`RENAME_CAPABLE`)

`/rename <name>` is a local TUI command (`agentStore.setMetadata("name")`, no model call, no hook)
and lands in the store meta `name` the read leg (`TITLE_READ_CAPABLE`) already reads, so read ⊇
write holds. MEASURED: nodeterm's one-shot `sendText` (bracketed paste and Enter in ONE tmux
invocation) left `/rename x` sitting unsubmitted in the composer; the same paste followed by a bare
Enter as a SECOND invocation renamed the chat (meta `name` changed). Hence `SEPARATE_SUBMIT_AGENTS`
(`submitsSeparately`): `PtyManager.sendText` pastes, then sends a bare Enter only after the paste
succeeded, one transaction at a time per node. Agent `send`/`reply` envelopes split the same way. The
agent comes from `create()` or, before the node mounts after a restart, the workspace records when every
placement agrees. An approval, AskQuestion or plan prompt already on screen gets nothing written (an
envelope answers `targetBusy`/`blocked`, retryable); one that opens after the paste gets no Enter (the text
stays composed: `pasted-not-submitted`, an envelope reports `stalled`). An empty capture is not a dialog.
Known limit: before mount the split trusts the records' `agentId`, so a shared project file naming
`cursor` for a pane that is not Cursor gets the split. `pushSessionRename` sends one ordinary line. The built-in `rename-chat` skill is model-driven
(`cursor-app-control.rename_chat`, not in the CLI) and is not used.

### Loop (`RECURRING_CAPABLE`): not joined

`/loop 2m <task>` read `~/.cursor/skills-cursor/loop/SKILL.md` (a `preToolUse Read`) and proposed a
Shell `while true; do sleep 120; echo 'AGENT_LOOP_TICK_<purpose> {...}'; done` (a `preToolUse
Shell`), which stopped at the allowlist prompt and was declined. So the SETUP has a signal (the
sentinel `AGENT_LOOP_TICK_` / `AGENT_LOOP_WAKE_` in a Shell command), but a tick, its turn shape
and the loop's end were never measured. A card counting turns it never saw would be a guess.

| Capability | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| Canvas control | yes | yes when its canvas control is enabled | N/A | same skill on the host via `installCanvasControl`; unverified for cursor |
| Subagent cards + tail | yes | yes (same tracker, `src/server/agent-status.ts`) | N/A (cards are renderer-only) | cards from `installCursorRemote` hooks; no live tail (child store is on the host) |
| Rename push | yes | yes (same renderer path, `sendText` over the bridge) | N/A | `sendText` over the ControlMaster; title READ is local only, so the chip will not confirm |

### Device checklist (not verified)

1. Does the FIRST turn of a node launched as `cursor-agent agent '<prompt>'` carry `generation_id
   !== conversation_id`? If it equals (like `sessionStart`), that turn's tool events and a `Task`
   in it are dropped (badge still from `beforeSubmitPrompt`/`stop`).
2. A backgrounded subagent (`SubagentRunState.backgrounded` exists in the bundle): its card ends at
   the parent's `stop` while it still runs.
3. Parallel Tasks in one turn (cards expected, no tail).
4. Rename while a turn runs, and rename when the composer still holds text: in this capture the
   composer KEPT a long prompt typed with `send-keys -l` after it was submitted, and the next typed
   line was appended to it. Whether nodeterm's paste path leaves the composer empty is unmeasured
   (the rename test cleared it first).
5. Canvas control end to end in a real cursor node (`nodeterm.sh list` from the agent).

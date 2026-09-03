# Devin as a nodeterm agent

Devin (`devin` on PATH) is a builtin agent id alongside
claude, codex, gemini, copilot, opencode and grok: `AGENT_CONFIG.devin` in
`src/shared/agents/config.ts` — label `Devin`, colour `#3969CA`, `launchCmd: 'devin'`,
`promptInjectionMode: 'argv'`, `argvPromptSeparator: '--'`, `expectedProcess: 'devin'`.
Status comes from devin's own hooks, never from parsing output.

**Versions measured.** Everything below was measured on **3000.4.25** unless a section says
otherwise; the permission-mode table and the exit line (§5, §5.1) were re-measured on **3000.6.12**,
which is where the `--permission-mode smart` launch route works. Each claim names the version it
rests on, because devin's own rollout gates move between them.

> **Measured, not guessed.** The CLI is installed and authenticated on the machine this
> integration was built on. The facts below come from `devin --help`, `devin skills paths`,
> `devin models list`, a captured `~/.config/devin/config.json` after a real hook install,
> and the live hook payloads in `/tmp/devin-test/logs/payloads.log`. Unverified items are
> marked and collected in §9.

---

## 1. What devin is, capability by capability

Capabilities are membership lists in `src/shared/agents/config.ts`, not a flag bag.

| List | devin | What had to be true first |
|---|---|---|
| `AGENT_HOOK_TARGETS` | **joined this branch** | A normalizer for devin's own event shape (`normalizeDevin`, `src/shared/agents/normalize.ts`), a subscription list (`DEVIN_HOOK_EVENTS`, `src/shared/agents/hook-events.ts`), and an installer writing the shared managed hook into `~/.config/devin/config.json` (`core/agents/hooks/devin.ts` → `installHooksInto`). |
| `RESUMABLE_AGENTS` | **joined this branch** | `resumeCommand('devin', id)` → `devin --resume <id>` (`devin --help` lists `--resume <SESSION_ID>`). |
| `PERMISSION_MODE_CAPABLE` | **joined this branch** | A per-agent translation because devin does not share claude's flag spelling: `devin --permission-mode auto\|accept-edits\|smart\|dangerous` against our `manual\|auto\|acceptEdits\|plan\|bypassPermissions`. `DEVIN_MODES` in `src/shared/agents/approval-mode.ts` maps `auto` (→ devin's `smart`, see §5), `acceptEdits` and `bypassPermissions`; `manual` and `plan` are unsupported — devin's default already auto-approves read-only tools, and its parser rejects `plan`. |
| `CANVAS_CONTROL_CAPABLE` | **joined this branch** | Devin has the same skill-discovery layout as Claude: `~/.config/devin/skills/<name>/SKILL.md` (measured with `devin skills paths`). `canvas-control.ts` and `RemoteHooks.installCanvasControl` now write `manage-nodeterm-canvas/SKILL.md` there, locally and on SSH hosts. |
| `CONTEXT_LINK_CAPABLE` | **joined this branch** | A skill dir for `get-linked-context` plus a transcript locator (`locateDevin` in `core/handoff/locate.ts`) and a parser (`linesFromDevin` in `core/context-link-render.ts`). Devin stores one monolithic JSON transcript per session at `~/.local/share/devin/cli/transcripts/<sessionId>.json` (measured). |
| `MODEL_SWITCH_CAPABLE` | **deliberately NOT joined** | Devin accepts `--model <slug>` (`devin models list` shows native slugs like `swe-1-7`), but the CLI has no documented `base-url` / `api-key` env and `modelGatewayEnv` in `src/shared/agents/model-gateway.ts` is for routing through a LiteLLM/Bifrost gateway. Passing a gateway model id to `devin --model` would rewrite the launch line while the backend stayed on Devin's own servers. |
| `CHAT_CAPABLE` | not joined | The ⌘M `ChatPanel` renders claude's transcript `.jsonl`; devin's transcript is a different JSON object with `steps[]`. |
| `SUBAGENT_CAPABLE` | not joined | Subagent cards are driven by claude's `Agent`/`Task` tool correlation; devin has no mapped equivalent. |
| `BRANCH_CAPABLE` | not joined | Branch sends claude's `/branch`; devin has no counterpart. |
| `RECURRING_CAPABLE` | not joined | `/loop`, `/schedule`, `/cron` are detected from claude's tool names. |
| `USAGE_CAPABLE` | not joined | Devin's transcript does not carry per-turn token usage numbers. Adding it would require a trustworthy denominator; none was measured. |
| `RENAME_CAPABLE` / `TITLE_READ_CAPABLE` | not joined | No measured command or transcript field for session-name sync. |
| `hasSharedIdentity` | not joined | No managed-account / shared-identity mechanism was measured. |

---

## 2. The hook dialect: snake_case envelope, no `transcript_path`

Devin's hook payload (measured on 3000.4.25) uses **snake_case** keys:

```
hook_event_name, session_id, prompt_id, prompt,
tool_name, tool_input, tool_use_id,
tool_response { success, output, error },
stop_hook_active
```

There is **no `transcript_path`** in the payload, so a devin node that wants to be a
context-link source is resolved by `locateDevin(sessionId)` from `~/.local/share/devin/cli/transcripts/<sessionId>.json`.
This is the opposite of claude/gemini, which hand us a path, and closer to grok (which also
carries none).

`DEVIN_HOOK_EVENTS` subscribes seven events: `SessionStart`, `UserPromptSubmit`, `Stop`,
`PermissionRequest`, `SessionEnd`, `PreToolUse`, `PostToolUse`. `PreToolUse` and `PostToolUse`
carry a regex `matcher: '.*'`; the others are plain string events.

`Stop` was measured with only `stop_hook_active: false`; it does **not** carry
`last_assistant_message`, so the node's `lastMessage` is not populated from the `Stop` hook.

`PermissionRequest` fires when the CLI needs user approval. The payload shape was not
observed in the single non-interactive capture, but it is documented and subscribed defensively.
**Critical unverified:** whether devin waits for and honours a JSON decision printed by the
hook script. Until that is measured, the deterministic `NODETERM_PERM_WAIT_SECS` wait branch is
**claude-only** (`PERM_WAIT_CAPABLE = ['claude']`).

---

## 3. Config file and claude cross-fire

Devin's global user config lives at `~/.config/devin/config.json` (macOS/Linux) or
`%APPDATA%\devin\config.json` (Windows). The `devin skills paths` command confirms devin
loads skills from `~/.config/devin/skills/<skill-name>/SKILL.md` and `.devin/skills/<skill-name>/SKILL.md`.

**Devin does NOT read `~/.claude/settings.json` by default.** This was measured: a `SessionStart`
hook in `~/.claude/settings.json` did **not** fire while devin was launched with a
`~/.config/devin/config.json` that had no matching hook. The comment in
`src/shared/agents/hook-events.ts` that claimed otherwise has been corrected. This means the
claude hook script cannot cross-fire into a devin session; the two configs are independent.

---

## 4. Launch grammar and the `--` separator

Devin's usage is `devin [OPTIONS] [PROMPT] [COMMAND]`, with subcommands (`list`, `auth`,
`models`, etc.) that collide with a positional prompt. Like grok, devin uses an
`argvPromptSeparator` of `'--'`. Permission and model flags (when applicable) must be placed
**before** the separator; the prompt is placed after it.

`withPermissionMode('devin', ..., 'acceptEdits')` emits `devin --permission-mode accept-edits`.
`withAgentModel` emits **nothing** for devin because devin is not in `MODEL_SWITCH_CAPABLE`.

---

## 5. Permission modes

`devin --permission-mode` accepts `normal` (alias `auto`, **its default**), `accept-edits`, `smart`,
`dangerous` (aliases `yolo`, `bypass`) and `autonomous` (requires `--sandbox`). Measured two ways on
3000.6.12: the parser lists the set itself when handed a bad value (`devin --permission-mode bogus`),
and the behaviour table is in the CLI's bundled `share/devin/docs/reference/permissions.mdx`.

| Tool type | normal (default) | accept-edits | smart | dangerous |
|---|---|---|---|---|
| Read-only | Auto | Auto | Auto | Auto |
| Shell / fetch | Prompt | Prompt | Auto when judged safe | Auto |
| Workspace edits | Prompt | Auto | Auto | Auto |

Our mapping (`DEVIN_MODES`):

| nodeterm mode | devin flag | note |
|---|---|---|
| `auto` | `--permission-mode smart` | the semantic match — see below |
| `acceptEdits` | `--permission-mode accept-edits` | |
| `bypassPermissions` | `--permission-mode dangerous` | the parser's own spelling; `/bypass` and `/yolo` are in-session aliases, not flag values |
| `manual` | **unsupported** | devin's default already auto-approves read-only tools; no devin mode asks before every action |
| `plan` | **unsupported** | devin has an in-session `/plan`, but `--permission-mode plan` is REJECTED by the parser (measured on 3000.4.25 and 3000.6.12), and a rejected value kills the launch |

`autonomous` is unreachable by construction: it requires `--sandbox`, a separate axis this table does
not set.

### `auto` → `smart`, and why devin's own `auto` is a false friend

The first version of this table mapped `auto → auto` on the reasoning that the word matched. It
does not: **devin's `auto` is an alias for `normal`, its default.** So the flag was emitted, the
command line changed, and the session's behaviour could not — a user who set Auto watched every
devin node start in the mode it would have started in anyway, which is what surfaced the bug.

The two CLIs mean different things by the word:

- **claude's `auto`** — *"Claude decides what is safe"* (Claude Code's own mode help, which
  recommends it "for long unattended tasks"). A model judges each action.
- **devin's `auto`** — `normal`: reads auto-approved, every edit and every shell command prompts.
  Nothing is judged.
- **devin's `smart`** — *"a fast model decides whether it is safe to run without asking"*, workspace
  edits auto-approved, and high-risk categories (package installs, mutating `git`, `rm`, `sudo`,
  destructive cloud CLIs, dotenv/key material) **always** prompt.

`smart` is therefore the equivalent, and this is not the substituted-nearest-match trap rule 8
warns about — it is the opposite. The trap is claiming a mode the CLI cannot express; here the CLI
expresses it exactly, under a different name, and the *matching name* was the wrong answer.

**Two gates sit behind `smart`, and both degrade visibly.** The launch-flag route shipped in devin
**3000.5.20** ("Switch with `/smart`, `/mode smart`, Shift+Tab, or `--permission-mode smart`"), and
smart itself is rolled out server-side per account. Measured on the older **3000.4.25**, with the
account's rollout already ON:

```
$ devin --permission-mode smart          # startup
Warning: Smart permission mode is not available. Falling back to normal.

> /smart                                 # same session, seconds later
✓ Switched to Smart mode                                   (smart mode on)
```

The flag was accepted, the session ran, and only the startup gate had not caught up — the in-session
switch proves the account's rollout was on. On **3000.6.12** the flag starts the session in smart
with no warning at all.

So **no version gate is added** (rule 9), and there is nothing worth gating: an older CLI, or an
account without the rollout, takes devin's OWN fallback — printed into the pane, exit 0, landing on
`normal`, which is precisely where the session would have started with no flag. A visible degrade
onto the status quo does not need a probe in front of it, and adding one would deny the flag to
users whose CLI handles it.

One artefact to know when re-measuring: `--permission-mode bogus` prints `Valid options: normal
(auto), accept-edits, dangerous (yolo, bypass), autonomous (requires --sandbox)` on 3000.6.12 —
`smart` is **absent from that list** because of the server-side rollout, while the parser accepts
it. The error text is not the authority on what the flag takes.

### 5.1 The in-place restart exit line

`EXIT_SEQUENCES.devin = '/exit'` (`renderer/terminal/agent-restart.ts`). MEASURED in the CLI's
own bundled docs, `share/devin/docs/reference/commands.mdx:439` (verified on devin-cli 3000.4.25 and 3000.6.12):

> `/exit` — Exit the application (alias: `/quit`). You can also type `exit` or `quit` without the
> `/` prefix.

So `/exit` is devin's DOCUMENTED PRIMARY and `/quit` its alias — the opposite orientation to grok
and gemini, whose primary is `/quit`. It takes **no arguments**, and devin's destructive verb is a
separate command entirely: `/rm-session <session-id>` — *"Irreversibly delete a session and all its
data"* (`commands.mdx:437`). That separation is the thing worth writing down. Gemini's `/quit`
carries its own `--delete`, which is why rule 15 says the exit line is sent **bare**; devin has no
such flag, but nothing may ever append one, and `agent-restart.test.ts` pins the value against both
`rm-session` and any whitespace.

This is load-bearing because `devin` is in `RESUMABLE_AGENTS` **and** in this table, which makes
devin nodes eligible for the bulk "restart idle agents" action and for Eco hibernation — both type
this string into a live session. `restartEligibility` still refuses a `working` or `blocked` node,
so the line is never typed into an open permission prompt.

---

### 5.2 Writing into devin's composer needs a delayed Enter

Any nodeterm path that types text into a devin session — the canvas-control `write` verb, an
agent-to-agent message envelope, a note push, the restart's `/exit` — must send the submitting
Enter as a SEPARATE key event ~150 ms after the text. `AGENT_CONFIG.devin.submitEnterDelayMs`
carries the number and every write path reads it.

**Devin's behaviour, not ours.** Measured on 3000.6.12, idle session, every delivery tmux offers:

| written by | Enter in the same burst | Enter ≥ ~80 ms later |
|---|---|---|
| bracketed paste (`paste-buffer -p`, our path) | stays in the composer | submitted |
| unframed paste | stays in the composer | submitted |
| `send-keys -l` literal | stays in the composer | submitted |

The threshold sits between 50 ms and 80 ms. Framing is irrelevant — devin keys off TIMING, treating
a CR that arrives inside an input burst as pasted content. The identical bracketed-paste delivery
into claude submits immediately (control test), which is why this is a per-agent number rather than
a change to the delivery.

**Why it mattered more than it looks.** `sendText` returns true once tmux has delivered the bytes,
so the canvas-control `write` verb answered **`sent`** to the ORCHESTRATING agent while the text sat
unsubmitted — a handoff reported as started that never began. The restart's `/exit` failed more
kindly: the poll never sees a shell and the run reports `exit-timeout`, leaving the session running.

**opencode had this first.** `agent-restart.ts` carried a hardcoded `agentId === 'opencode'` branch
with the same 150 ms, measured on 1.18.18-1.18.25 — so only the RESTART path knew, and every other
write into an opencode composer had the bug devin has. Devin arriving with the same behaviour is
what showed it is a property of the agent; the number now lives in `AGENT_CONFIG` and both agents
get it on every path.

**The guarantee this owes.** Text and Enter in one tmux command list is what makes "the Enter can
never fire after a failed text send" structural (tmux abandons the rest of a failed list).
`runDelayedEnterDelivery` (`core/tmux-naming.ts`) re-establishes it explicitly: the Enter is sent
only when the paste answered true, and the Enter's own failure is the caller's answer. A submit
firing into a composer that never got its text would send whatever the USER had typed there.

---

## 6. Canvas control and context-link discovery

Both features reach devin through skills in `~/.config/devin/skills/`:

- `manage-nodeterm-canvas/SKILL.md` — the canvas-control shim (`nodeterm.sh`) and verb list.
- `get-linked-context/SKILL.md` — the context-link shim (`context.sh`) and commands.

The same skills are written to remote hosts in `RemoteHooks.installCanvasControl` and
`installContextLink` at `${remoteHome}/.config/devin/skills/...`, because devin on a remote
host uses the same layout (assumption; see §9).

For agents without a skill system, the canvas-control / get-linked-context instruction blocks
are merged into `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.opencode/AGENTS.md`. Devin
is not in that set because it uses skills.

---

## 7. Transcript format for context-link

Devin writes one JSON file per session:

```json
{
  "schema_version": "ATIF-v1.7",
  "session_id": "...",
  "agent": { "name": "devin", "version": "3000.4.25", "model_name": "SWE-1.7 Max" },
  "steps": [
    { "step_id": 1, "timestamp": "...", "source": "system", "message": "...", "extra": {...} },
    { "step_id": 2, "source": "user", "message": "...", "extra": {...} },
    { "step_id": 3, "source": "agent", "message": "...", "extra": {...} }
  ]
}
```

`linesFromDevin` renders one line per `user`/`agent` step, collapsing whitespace and truncating
to `TOOL_RESULT_MAX` chars. Tool calls are not exposed separately in the captured format.

---

## 8. The three surfaces

| Surface | supported? | notes |
|---|---|---|
| Desktop | yes | hooks, permission modes, resume, canvas-control skill, context-link skill |
| Server Edition | yes | core logic is in `src/core` and `src/server/agent-status.ts`; the same normalizer is wired there. Skill install on the server host is unverified. |
| Mobile | N/A | devin is a CLI agent; mobile companion sees status over the same `agent:status` bridge as other agents. |

**Neither raw hook listener changed, and that is the answer here rather than a gap.** CLAUDE.md's
rule 11 asks that `src/main/index.ts` and `src/server/agent-status.ts` stay in parity because a
branch added to one shell silently leaves the other without the feature. Devin needs no branch in
either: it has no context tail (no per-turn token usage in its transcripts, so it is out of
`USAGE_CAPABLE`), no session-directory derivation of grok's kind (its config dir is fixed, not
hook-reported), and no subagent correlation. Devin is therefore in parity by having nothing to add
— "no change in both shells", not "a change in one".

---

## 9. Devin device checklist

1. **Permission hook decision contract** — `PermissionRequest` is subscribed, but we have not
   measured whether devin waits for the hook script's stdout and treats a JSON
   `{"behavior":"allow"}` / `{"behavior":"deny"}` as the answer. Until then,
   `NODETERM_PERM_WAIT_SECS` is **claude-only** — meaning the claude harness, so a custom agent
   declaring `baseAgent: 'claude'` inherits it (it runs claude's binary and hook script) while a
   devin-based or baseless one does not. That base resolution is the one deliberate widening
   relative to `main`, where `pty-manager` compared the raw agent id; pinned in
   `config.capabilities.test.ts`.

2. **Remote skill path** — we install devin skills on SSH hosts at
   `~/.config/devin/skills/<name>/SKILL.md`, matching local `devin skills paths`. This assumes
   the remote devin CLI uses the same XDG layout and was not verified on a real host.

3. **Remote context-link reads** — `resolveLinkTranscript` refuses remote nodes unless the path
   was learned from a hook (jailed). Devin hooks do not carry `transcript_path`, so reading a
   remote devin node from another devin node over SSH is not yet implemented.

4. **Title sync** — no measured devin command or transcript field for session-name sync.

5. **Usage meter** — devin transcripts do not carry per-turn token usage.

6. **Smart mode's live judgement** — the `auto` → `smart` mapping is measured at the CLI boundary on
   both sides (3000.6.12 starts in smart with no warning; 3000.4.25 takes devin's own announced
   fallback to normal, exit 0). What is NOT measured is a session actually WORKING in smart: that
   the fast-model judgement behaves as `reference/permissions.mdx` describes, and that the
   never-auto-approved categories (package installs, `rm`, `sudo`, mutating `git`, dotenv and key
   material) really do prompt. That is devin's own behaviour rather than nodeterm's, but this
   mapping is what points users at it.

7. **Windows skill/instruction paths** — `devinConfigDir()` switches to `%APPDATA%\devin`, but
   canvas-control and context-link skill writes on Windows are unverified.

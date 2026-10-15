# GitHub Copilot CLI agent support

Copilot is a builtin base harness. Its integrations live behind the same registry and capability
predicates as every other agent, so a custom agent with `baseAgent: 'copilot'` inherits its icon,
launch/resume grammar, hooks, canvas control, and model-gateway mapping without renderer allowlists.

## Verified contracts

The following were checked against the installed Copilot CLI 1.0.80 and GitHub's current official
CLI reference:

- `copilot --interactive <prompt>` opens the normal interactive TUI and submits the initial prompt;
  `--prompt` is non-interactive and exits after the response.
- `--session-id=<uuid>` creates a caller-addressable session, `--resume=<uuid>` resumes it, `/exit`
  cleanly returns to the shell, and `--model` (or `COPILOT_MODEL`) selects the startup model,
  including in BYOK mode.
- BYOK mode activates through `COPILOT_PROVIDER_BASE_URL`. The implementation also sets
  `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_MODEL_ID`, and
  `COPILOT_PROVIDER_WIRE_MODEL`; GPT-5-family OpenAI models use
  `COPILOT_PROVIDER_WIRE_API=responses` as the CLI requires.
- User hooks are merged from `$COPILOT_HOME/hooks/*.json` (default `~/.copilot/hooks`). PascalCase
  event aliases emit the snake_case payload nodeterm's shared hook transport expects.
- Global instructions live at `$COPILOT_HOME/copilot-instructions.md`.

Primary references:

- <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference>
- <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models>
- <https://docs.github.com/en/copilot/reference/hooks-reference>
- <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>

## Model gateway mapping

The user enters one gateway root and chooses either an environment-variable name (persisted as
`${env:VAR}`) or a write-only literal key held in protected local storage. Discovery calls the
OpenAI-compatible `<root>/v1/models` endpoint—the OpenAI Models API convention adopted by both
LiteLLM and Bifrost—and sends both bearer auth and Bifrost's `x-bf-vk` compatibility header.
An unavailable credential fails before any authenticated request. The
provider launch routes below are specifically the current Bifrost layout. For a selected Copilot
model:

- `anthropic/<model>` uses provider type `anthropic`, base URL `<root>/anthropic`, internal model id
  `<model>`, and wire model `anthropic/<model>`.
- Every other provider-prefixed model uses provider type `openai`, base URL `<root>/openai/v1`, an
  unprefixed internal id, and the original provider-prefixed wire id.

Launch and resume commands also pass `--model <internal-id>` explicitly. The provider metadata
variables do not replace Copilot's startup selection, and an ordinary in-place restart reuses the
existing shell environment. The flag must match `COPILOT_PROVIDER_MODEL_ID`; the provider-prefixed
gateway id remains in `COPILOT_PROVIDER_WIRE_MODEL`.

Copilot BYOK is not activated merely because gateway settings exist: a model must be selected for
that node first. This preserves ordinary GitHub Copilot routing for untouched nodes. Model changes
stop the agent's foreground process group, recycle the tmux session, then cold-resume the same
Copilot session under the new environment; the key is never typed into the pane.

## Status hooks

Nodeterm owns `nodeterm-status.json` in Copilot's hooks directory and writes the shared guarded
script to `~/.nodeterm/agent-hooks/copilot.sh`. It observes:

- session start/end;
- user prompt, pre-tool, post-tool, and failed-tool activity;
- turn completion (`Stop`);
- the closed notification types `permission_prompt` and `elicitation_dialog`.

On Windows each entry also carries a `powershell` key — the one Copilot runs there — pointing at
`~/.nodeterm/agent-hooks/copilot-hook.cmd` through `<abs cmd.exe> /d /c call "<wrapper> "`; the
wrapper finds Git for Windows' `sh.exe` and runs the same `copilot.sh`. `bash` is kept, and an SSH
host's file never gets the key.

`PermissionRequest` is deliberately not installed because it is a decision hook that can change
authorization. `ErrorOccurred` is omitted because recoverable errors can occur before a turn
continues. Unknown notifications are no-ops, preventing sticky NEEDS YOU badges.

## Chat view (⌘M) and the phone's Chat screen

`src/core/copilot-chat.ts` reads the session journal,
`<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`. Measured on copilot 1.0.88 by running the
real CLI in BYOK mode against a local fake OpenAI-compatible server (so all content was synthetic):
the `Stop` hook's `transcript_path` names that file, nodeterm's minted `--session-id=<uuid>` names
its directory, and the journal is append-only JSONL (compaction appends `session.compaction_*`
events rather than rewriting). It pages like claude's transcript, and the relay serves the phone
the same pages. The record rules and golden fixtures are in `src/shared/chat-fixtures/README.md`
("Copilot").

Not supported: remote (SSH) copilot nodes (the journal is on the host and there is no remote reader
yet, so the panel says so instead of reading this machine), reasoning (never shown), `effort` (not
recorded per response), plan/question answer cards, and the composer's model/effort labels.

**The snap package does not read `~/.copilot`.** `snap/copilot-cli` sets `HOME=$SNAP_USER_COMMON`
(`~/snap/copilot-cli/common`), so a snap-installed copilot reads its hooks, instructions and session
state under `~/snap/copilot-cli/common/.copilot`. The chat reader checks that root too, but the
status hooks nodeterm installs into `~/.copilot/hooks` are never seen there: a snap copilot node
reports no status and no hook-fed session id (so the desktop ⌘M falls back to the markdown output
view; the phone still reads it through the minted id). Same class as codex's snap `CODEX_HOME`
remap. An npm / install-script copilot is unaffected.

## Device checklist

These require an authenticated or real gateway-backed session and were not exercised by the unit
suite:

1. Start an authenticated Copilot node with an initial prompt; verify interactive TUI behavior and
   that SessionStart/UserPromptSubmit/Stop update the canvas badge and persisted session id.
2. Trigger one permission prompt and one `ask_user` elicitation; verify NEEDS YOU clears when work
   continues and that informational/idle notifications never create a badge.
3. Select an OpenAI Bifrost model, run a tool-using turn, switch models, and verify the same session
   resumes through `/openai/v1` using the provider-prefixed wire model.
4. Repeat with an Anthropic model through `/anthropic`, including one tool call.
5. Repeat 1–4 on an SSH project whose `COPILOT_HOME` differs from `~/.copilot`; verify both the hook
   file and `copilot-instructions.md` land under the host-reported directory.
6. Create a custom agent based on Copilot and verify its base icon, launch/resume behavior, hook
   status, canvas control, and model switch all match the builtin.
7. ⌘M on a logged-in copilot node after a tool-using turn: the prompt, answer, tool chips with
   results, and a denied tool's `Error:` result render; scrolling up pages older history; a turn in
   progress refreshes live. Repeat from the phone's Chat screen over the relay.
8. ⌘M on a copilot node in an SSH project shows "Reading a remote GitHub Copilot session's
   transcript isn't supported yet." with no Retry, and never a local conversation.
9. Windows: `nodeterm-status.json` entries carry both `bash` and `powershell`; with Git for Windows
   installed a turn flips RUNNING → IDLE and a permission prompt flips NEEDS YOU (i.e. Copilot does
   run the `powershell` key, under PowerShell, and the wrapper invocation survives it). Without
   Git, turns run with no hook error and the badge stays Unknown.
10. Windows: from a Copilot node run `& "<userData>\canvas-control\nodeterm.cmd" list` (the line
    the canvas skill now gives it) and a `--prompt "two words"` open; both arrive intact.


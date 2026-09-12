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

`PermissionRequest` is deliberately not installed because it is a decision hook that can change
authorization. `ErrorOccurred` is omitted because recoverable errors can occur before a turn
continues. Unknown notifications are no-ops, preventing sticky NEEDS YOU badges.

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

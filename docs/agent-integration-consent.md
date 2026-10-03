# Agent-integration consent

Issue #744 (redo of the superseded draft #900). nodeterm used to write into every agent CLI's
user-owned global configuration on every launch, and onto every SSH host at connect, with no
recorded decision and no way to say no: status hooks in `~/.claude/settings.json`,
`~/.gemini/settings.json`, `~/.codex/hooks.json` + `config.toml` trust, grok/copilot/opencode/
antigravity hook files, and ~17 KB of canvas-control + context-link instructions merged into
`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, copilot's and opencode's instruction files. The codex
blocks alone took 17,102 bytes of codex's 32 KiB `project_doc_max_bytes` budget, crowding out the
user's own repository instructions.

## The model

`settings.agentIntegrations` (`src/shared/agent-integrations.ts`), hand-editable and sanitized on
every read:

| field | meaning |
|---|---|
| `agents[<id>]` | `enabled` / `declined` per agent on THIS machine; absent = never asked |
| `hosts[<user@host>]` | per SSH host; keyed on `sshHostKey` only, so editing the identity file, port or extra args keeps the answer |
| `hostDefault` | the answer for a host with no entry; set to `enabled` only by grandfathering |
| `origin` | `grandfathered` (an install from before this feature) or `asked` |
| `noticeDismissed` | the grandfathered install's one-time notice was dismissed |

Per agent the lifecycle (`src/core/agent-integrations.ts`, booted by BOTH shells) does:

- **enabled**: install/refresh the status hook and the two skills (canvas control, context link) in
  that agent's OWN skills dir; strip the legacy marker blocks older builds merged into its global
  instruction file.
- **declined**: remove exactly what nodeterm wrote — hook entries by exact command match (a user's
  own hooks survive), skill files by exact-content receipt (a file the user edited is kept and
  listed in Settings), the legacy blocks, our hook scripts.
- **undecided**: nothing, in either direction.

The Server Edition's `installHooks: false` is a hard veto that outranks every choice.

## Default for existing vs new installs (product decision — confirm)

- **Existing installs are grandfathered as enabled.** Evidence is our own files only: a non-empty
  `~/.nodeterm/agent-hooks/` or the canvas/context shims under userData. The record is written at
  boot, before the renderer loads settings and before any install, with every agent enabled and
  `hostDefault: enabled`, so nobody's badges or canvas control stop on upgrade. A one-time
  dismissible notice says integrations are now a choice and links to Settings → Agents.
- **New installs are asked once**, by a banner (Enable all / Choose… / Not now). Until answered
  nothing global is written; terminals work, but agents have no status badges, notifications,
  session names, context meter, subagent cards, canvas control or linked-node reads. "Not now"
  records a decline for every agent, so it is asked once.
- **SSH hosts**: a host with no answer gets nothing (and nothing is removed). When the active
  project's host is connected and unanswered, a banner asks (Allow on this host / Not on this host).
  A host installs an agent only when BOTH the host and that agent are enabled.

## Where the skills go (measured 2026-10-03)

Local, each agent's own dir (so a per-agent decline is precise):

| agent | dir | measured with |
|---|---|---|
| claude | `$CLAUDE_CONFIG_DIR` or `~/.claude` `/skills`, plus every local managed/linked account dir | (existing) |
| codex 0.156.1 | `$CODEX_HOME/skills` (+ managed codex homes) | `codex debug prompt-input` |
| gemini 0.62.0 | `$GEMINI_CLI_HOME`/`~` `/.gemini/skills` | `gemini skills list --all` |
| opencode 1.18.33 | `<opencode config>/skills` | `opencode debug skill` |
| copilot 1.0.89 | `$COPILOT_HOME`/`~/.copilot` `/skills` | `copilot skill --help` (documented) |
| grok 1.0.44 | `$GROK_HOME`/`~/.grok` `/skills` | `grok inspect --json` |

On an SSH host: claude's `~/.claude/skills` (and remote account dirs), and **`~/.agents/skills`**
for everyone else — codex, gemini, opencode and grok were all measured reading it, copilot documents
it — because one env-independent dir is what a host we cannot introspect cheaply needs.

Copilot has no context link, so it gets the canvas skill only (as before). Antigravity has neither.

## What is deliberately not done

- `config.toml` codex trust entries are left on decline: a trust entry for a hook that no longer
  exists is inert, and the file is the user's.
- The `buildCanvasControlInstructions` / `buildLinkedContextInstructions` builders are no longer
  installed anywhere; their parity tests still pin them and should move to the skill bodies
  (follow-up).
- A file that held ONLY our block is removed locally; on an SSH host (or behind a symlink) it is
  left with one newline, because the guarded transaction never publishes an empty file.
- An SSH host's removal only recognises skill files this build would write, or whose bytes were
  recorded when this machine wrote them (receipts in `<userData>/integration-receipts.json`); an
  older build's copy on a host this machine never refreshed is kept and reported.

## Surfaces

Desktop: full. Server Edition: the same lifecycle and Settings rows (`installHooks: false` vetoes),
no SSH hosts. Relay tabs: the consent is the host's (settings are host-only); the relay tab's own
Settings describe THIS machine. Mobile: N/A for v1 — the phone reads status the host's hooks
produce; a phone-side explanation of "integration off" is an iOS follow-up.

## Device checklist (not runnable here)

1. macOS desktop upgrade from 0.4.x: grandfathered notice appears once; badges keep working.
2. Fresh macOS install: banner appears before any `~/.claude` write (`ls ~/.claude` unchanged);
   Enable all → badges and canvas control work.
3. Decline claude on macOS: `~/.claude/settings.json` keeps the user's own hooks, our entries gone;
   an edited `SKILL.md` is listed in Settings.
4. Codex on macOS reads the canvas skill from `~/.codex/skills` (ask it to list nodes).
5. SSH host (Linux, codex + gemini + claude installed): Allow → `~/.agents/skills` and
   `~/.claude/skills` populated, no `AGENTS.md` block; Not on this host → cleaned.
6. SSH host with an old 17 KB `AGENTS.md` block: stripped on the first connect after upgrade.
7. Copilot on a real login: `copilot skill list` shows manage-nodeterm-canvas from `~/.copilot/skills`
   (local) and `~/.agents/skills` (SSH) — only the help text was measured here.
8. Windows desktop: hooks for a consented codex (`codex-hook.cmd`) and the skills dirs resolve.

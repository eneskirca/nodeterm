# Agent integration consent

Agent integrations are optional and off until explicitly enabled in **Settings → Agents**.
Existing installations are not grandfathered in. The setup notice appears on Desktop and in
Server Edition until a local choice is recorded. Terminals work without integrations; hook-based
status, context updates and completion notifications may be unavailable.

`settings.agentIntegrations` stores machine-local, per-agent choices. Missing and malformed values
are not consent. A saved `false` requests cleanup and remains false across restarts. Installation
runs only after settings have been persisted. Server `installHooks: false` is an additional hard
veto; `true` alone does not authorize installation. Canvas/context runtime startup cannot grant
consent. The agent-facing `settings` verb cannot change integration choices.

SSH project settings contain a separate setup panel. Consent lives in local settings, keyed by
user, host, port, identity-file and extra SSH arguments, never in git-shared project metadata.
Local consent does not authorize the SSH host. Connected hosts reconcile changes without restarting
sessions; offline hosts reconcile when connected. Remote hook reconciliation is serialized so a
queued disable follows an in-flight install. The host's SSH trust/authentication remains unchanged.

The setup panel lists affected paths. Hook installation no longer changes Claude's `tui` preference.
No runtime writes detailed references into global AGENTS.md, GEMINI.md or equivalent files.
Local Claude and Codex use on-demand skills (Codex's documented user location is
`~/.agents/skills`: [OpenAI documentation](https://learn.chatgpt.com/docs/build-skills)). Other
harnesses retain hook support. Remote references live under `~/.nodeterm/{nodeterm,context}.sh.md`
and can be read on demand; no large startup prompt/include replaces the retired injection.

## Cleanup and limits

The app removes exactly recognized hook commands, preserving neighboring handlers and edited
commands. Skills carry an exact-content receipt in `integration-receipts.json`; a modified or
unrecognized file is retained and reported in Settings. Known legacy instruction blocks are removed
only when their complete content matches a shipped template. Unknown historical blocks, edited
skills, legacy TUI preferences, and remote historical account skills require manual review.
Cleanup cannot prove ownership retroactively. It must not guess from a directory name or marker
alone. The status panel reports retained paths; remote warnings last for the app run.

Disable integrations **before uninstalling**. The shell uninstaller uses receipts for skills and
preserves user-added files in their directories. Unrecognized historical instruction blocks/plugins
are reported, not erased. Removing an app bundle or using the Windows package uninstaller cannot
be assumed to run this cleanup. Remote hosts must be cleaned while they are accessible; uninstalling
the local application cannot clean an offline host.

Multiple nodeterm installations under one OS login share global agent files. Their consent settings
are separate: another explicitly enabled installation can reinstall its own integration. This is
not a filesystem-wide ownership lock. Atomic writes and snapshot comparisons narrow concurrent
editor races, but unrelated programs do not honor nodeterm's locks.

Desktop and Server Edition use the same core lifecycle and settings UI. The mobile companion
inherits the host's hook availability and cannot implicitly grant consent. A native setup/retained-file
surface is a separate nodeterm-ios follow-up for @eneskirca; use Desktop or the server web UI meanwhile.

Hardware validation still needed: Windows hook execution and uninstall UX, macOS onboarding,
actual SSH reconnect/offline cleanup, CLI skill discovery across supported versions, and mobile
behavior when the host declines integration. Unit tests do not claim these device checks.

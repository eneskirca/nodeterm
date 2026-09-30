# Uninstalling nodeterm — the full inventory, and the portable-install question

Issue #347 asked for a clean trial: install, evaluate, remove without residue.
`scripts/uninstall.sh` is that removal. This document is the inventory behind it — every
place the app writes at runtime, keyed to the code that writes it — plus a feasibility note
on the alternative the issue proposed (a fully portable install).

Run it safely first:

```bash
curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/uninstall.sh | bash -s -- --dry-run
```

`--dry-run` prints everything the script found on your machine (processes, tmux sessions,
files, config entries inside other tools' files) and changes nothing. Re-run with `--yes`
to apply. Interactive runs (downloaded script, no pipe) confirm before touching anything.

## What nodeterm writes, and who removes it

### 1. nodeterm's own state — deleted wholesale

| Location | What it holds | Written by |
| --- | --- | --- |
| `~/Library/Application Support/node-terminal` (macOS) / `~/.config/node-terminal` (Linux) | The Electron user-data dir: `workspace.json`, `settings.json`, generated `tmux.conf`, `terminal-scrollback/`, `hook-endpoint.env`, `context-links/`, `canvas-control/`, `claude-accounts/<id>/` (managed-account config dirs), `speech-models/`, media caches, secret stores, `device-id`, browser storage | everything behind `CorePlatform.userDataDir` |
| `~/.nodeterm` | Machine-stable state shared by every instance: `agent-hooks/*.sh` (the managed hook scripts), `ssh-cm/*.sock` (SSH ControlMaster sockets), `acks/`, `pending/`, `push-grants/`, `cx/`, `codex-thread-names/`, the app-private ssh-agent | `install-helper.ts`, `control-master.ts`, `pairing-service.ts`, … |
| `~/Library/Caches/node-terminal`, `~/Library/Caches/node-terminal-updater`, `~/Library/Caches/com.nodeterm.app*`, `~/Library/Preferences/com.nodeterm.app.plist`, `~/Library/Saved Application State/…`, `~/Library/HTTPStorages/com.nodeterm.app`, `~/Library/Logs/node-terminal` (macOS) / `~/.cache/node-terminal`, `~/.cache/node-terminal-updater` (Linux) | Chromium/electron-updater caches, macOS window state | Electron / macOS |
| Keychain entry `node-terminal Safe Storage` (macOS) | The key Electron `safeStorage` encrypts local secrets with | Electron |
| `/Applications/nodeterm.app` (or the Homebrew cask) | The app itself | `install.sh` / brew |
| `~/.nodeterm-server-app`, `~/.nodeterm-server`, systemd units `nodeterm-server.service` + `nodeterm-server-update.{service,timer}` (system or `--user`) | Server Edition checkout, private Node runtime, data dir, service + daily auto-update timer | `install-server.sh` |

**Why `node-terminal` and not `nodeterm`.** Everything Electron keys by the app's *name* — the
user-data dir, the `Safe Storage` Keychain entry, electron-updater's `<name>-updater` cache —
uses `app.name`, which Electron reads from the top-level `name` in package.json
(`node-terminal`). `productName` (`nodeterm`) lives only under `build`, which electron-builder
strips from the packaged package.json, so it names the bundle and the installer and never
reaches the running app. Every desktop build, dev or installed, therefore writes to
`…/node-terminal`. What is keyed by the bundle id (`com.nodeterm.app`: prefs, saved state,
HTTPStorages, ShipIt) or by the bundle itself (`/Applications/nodeterm.app`) does carry the
`nodeterm` spelling. `scripts/uninstall.test.ts` ties the script's `APP_NAME` to package.json
`name`.

### 2. Integration merged into OTHER tools' config — reverted surgically

nodeterm integrates with agent CLIs you already have by merging entries into their config.
Every merge is marker-identified, so removal never touches your own hooks, credentials, or
settings:

| File | What nodeterm added | How it's removed |
| --- | --- | --- |
| `~/.claude/settings.json`, `~/.gemini/settings.json` | Status-hook entries whose command references `~/.nodeterm/agent-hooks/` (legacy marker: `claude-signals`) | JSON filter keyed on those markers; other hooks and keys preserved |
| `~/.codex/hooks.json` + `~/.codex/config.toml` | Hook entries + the matching `[hooks.state."…"]` trust blocks | Our entries removed; trust blocks for surviving user hooks re-keyed to their shifted indexes (the hash covers content, not position) |
| `~/.claude/skills/manage-nodeterm-canvas/`, `~/.claude/skills/get-linked-context/` | nodeterm-owned skill dirs | Deleted |
| `~/.grok/hooks/nodeterm-status.json`, `~/.copilot/hooks/nodeterm-status.json` | nodeterm-owned hook files (those CLIs merge whole directories) | Deleted |
| `~/.config/opencode/plugins/nodeterm-status.js` | nodeterm-owned plugin (first-line marker checked before deletion) | Deleted |
| `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.copilot/copilot-instructions.md`, `~/.config/opencode/AGENTS.md` | `<!-- nodeterm:manage-canvas -->` / `<!-- nodeterm:get-linked-context -->` marker blocks | Block stripped; file deleted only if nothing but our blocks remains |

Two deliberate exceptions:

- **`"tui": "fullscreen"` in `~/.claude/settings.json` is left alone.** nodeterm writes it
  only when absent, so an existing value can be the user's own — removal can't tell the two
  apart, and the setting is harmless outside nodeterm.
- **If no JS runtime (`node`) is found, the JSON/TOML entries are left in place with a
  warning.** They are self-neutralizing: the installed hook command is
  `if [ -r <script> ]; then sh <script>; else cat >/dev/null; fi`, so once
  `~/.nodeterm/agent-hooks/` is deleted every entry is a silent no-op (this guard exists
  precisely so an uninstalled nodeterm can never block a Claude session — see
  `install-helper.ts`).

### 3. Processes — stopped cleanly, in order

1. Server Edition systemd units are disabled and their unit files removed.
2. The desktop app is asked to quit (AppleScript on macOS, SIGTERM elsewhere), with a
   10-second grace before a hard kill.
3. The tmux servers on nodeterm's private sockets (`node-terminal`, and `nodeterm-rmt` if
   another machine SSH'd in) are killed — **the script lists every live session first and
   warns that processes inside them end.** Your own tmux (default socket) is untouched.
4. Lingering SSH ControlMasters are closed via `ssh -O exit` on each
   `~/.nodeterm/ssh-cm/*.sock`.

### 4. What is deliberately KEPT

- **`<project>/.nodeterm/` inside your repos** (`project.json`, `board-log.jsonl`,
  `images/`). These are your canvas layouts — git-shareable by design, possibly committed,
  possibly another collaborator's. The script enumerates them from the workspace index
  *before* deleting it and prints the list with a manual `rm -rf` hint instead of deleting.
- **Remote SSH hosts.** A connected SSH project installs the same hook scripts/skills under
  the *host's* `~/.nodeterm` and agent dirs, and its sessions live on the host's
  `nodeterm-rmt` tmux socket. The script prints per-host cleanup instructions; it does not
  reach over the network.
- **The agent CLIs and tmux themselves** — nodeterm never owned them.

## Portable install — feasibility note

The issue's preferred shape was "everything in one folder; removal = delete the folder".
How close can nodeterm get?

**The easy 80%: redirecting user data.** Electron supports
`app.setPath('userData', …)` before `ready`. A `portable` marker file next to the app (or a
`NODETERM_PORTABLE_DATA=<dir>` env var) checked at boot in `src/main/index.ts` would move
the entire user-data table above into the chosen folder, and `TMUX_TMPDIR` can move the
tmux sockets there too. That's a small, low-risk change and worth doing.

**The structural 20%: integration cannot be portable.** The issue also asks to *keep* the
ability to connect to existing claude/codex/opencode installs — and that connection *is*
writes into those tools' own config dirs (`~/.claude`, `~/.codex`, …): they only read hooks,
skills and instruction files from their own locations, which nodeterm does not control.
Likewise `~/.nodeterm/agent-hooks` is deliberately machine-stable rather than
per-install: when the hook script path lived inside each instance's data dir, a second
install (dev build, Server Edition, E2E run) re-pointed the shared `settings.json` at *its*
copy, and when that dir vanished, hooks silently died for every session on the box (field
report — see the note in `install-helper.ts`). A "portable" mode that moved it back into
the app folder would reintroduce exactly that failure.

So the honest design is:

- **Portable data dir** (feasible follow-up): keeps canvases, settings, scrollback, caches,
  accounts in one deletable folder. Escape-hatch env var + marker file, ~30 lines.
- **Uninstall script** (this change): required regardless, because agent integration and
  the machine-stable hook path can never live inside the portable folder without breaking
  the integration the issue wants to keep. Every write outside the folder is env-gated
  (inert in sessions nodeterm didn't spawn) and marker-reversible.

Windows note: the desktop build ships as an NSIS installer with its own uninstaller
(Add/Remove Programs); after running it, delete `%APPDATA%\node-terminal` and
`%USERPROFILE%\.nodeterm`. The POSIX script does not run there.

# Codex's auto-started shared app-server (`daemon_auto_start`)

`help-<version>.txt` are the verbatim `codex --help` pages of three published npm builds, read by
`codexNoDaemonFrom` (`src/core/codex-cli.ts`) and by the remote probe's real-shell test.

| build   | `codex features list` → `daemon_auto_start` | `--no-daemon` in `--help` |
|---------|---------------------------------------------|---------------------------|
| 0.148.0 | (no such feature)                           | no                        |
| 0.156.1 | `experimental  false`                       | yes                       |
| 0.157.0 | `stable        true`                        | yes                       |
| 0.159.2 | `stable        true`                        | yes                       |

## The measurement (2026-09-30, Linux x86_64, codex-cli 0.159.2 from npm)

Private `CODEX_HOME` (only `auth.json` copied in, 0600, the whole directory deleted afterwards), a
fake `HOME`, a private tmux socket, and `env -i` so the only `NODETERM_*` variable in each pane is
the `NODETERM_NODE_ID` set deliberately. A `hooks.json` in that home (trusted through
`codex-trust.ts`) appended `NODETERM_NODE_ID` of every SessionStart / UserPromptSubmit /
PreToolUse hook process to a log. Paths below are shortened.

```
pane A: env -i … NODETERM_NODE_ID=node-A codex -a never -s danger-full-access
  → CODEX_HOME/app-server-daemon/daemon.pid, app-server-control/app-server-control.sock
  → process: …/packages/app-server-daemon/releases/0.159.2-…/bin/codex app-server --listen unix:// --managed-daemon
    /proc/<daemon>/environ: CODEX_HOME=… HOME=… NODETERM_NODE_ID=node-A …
  (the daemon outlives pane A's TUI)

pane B: … NODETERM_NODE_ID=node-B codex -a never -s danger-full-access
  → no second daemon: B joined A's
  prompt: run `echo "NODE=$NODETERM_NODE_ID PANE=$PROBE_PANE"`
  └ NODE=node-A PANE=node-A
  hook log: hook NODETERM_NODE_ID=node-A  (×3)

pane C: … NODETERM_NODE_ID=node-C codex --no-daemon -a never -s danger-full-access
  └ NODE=node-C PANE=node-C
  hook log: hook NODETERM_NODE_ID=node-C  (×3)

pane D: … NODETERM_NODE_ID=node-D codex -c features.daemon_auto_start=false -a never …
  └ NODE=node-A PANE=node-A          ← the feature switch does NOT leave a RUNNING daemon

codex --remote unix:// --no-daemon
  ERROR: --no-daemon cannot be used with --remote.
codex --no-daemon resume <id> / codex resume <id> --no-daemon / codex --no-daemon fork <id>
  all parse (answer: "No saved session found with ID …")
codex exec | review | login | mcp | app-server --help: no `--no-daemon` (not TUI clients)
```

The daemon is keyed by `CODEX_HOME`: every managed Codex account (its own `CODEX_HOME`) gets its
own, and every node on one account shares one. There is no environment-variable switch (the
binary's `CODEX_*` names were checked).

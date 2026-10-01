# Session backends: Zellij and herdr beside tmux

nodeterm keeps a local terminal alive across app restarts by running it inside a multiplexer
session named `nt-<node id>`: tmux on macOS/Linux, the session host on Windows. Some people live
in **Zellij** or **herdr** and want their canvas terminals to *be* sessions of that tool, so they
can attach to them from anywhere else. This document is the measurement behind v1: what
`PtyManager` needs from its backend, what each tool offers, which one v1 implements and why, and
what that backend does not do.

## How it was measured

- **Zellij 0.45.1** (`zellij-x86_64-unknown-linux-musl`, the latest GitHub release on 2026-09-30).
- **herdr 0.9.3** (`herdr-linux-x86_64`, latest release on 2026-09-30; source at 0.9.1 read for
  paste framing and config paths).
- Both run from `/var/tmp` with a throwaway `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, plus `ZELLIJ_SOCKET_DIR` (Zellij) / `HERDR_HOME` (herdr). The
  user's tmux servers were never touched; every server started was killed afterwards.
- A painter was a real client in a real pty (a 60-line Python `pty.fork` harness that writes
  scripted input, resizes, and sends SIGHUP). Linux, x86_64. **Nothing was measured on macOS.**

## What PtyManager needs, and what each tool answers

| Need (tmux today) | Zellij 0.45.1 | herdr 0.9.3 |
|---|---|---|
| **Create-or-attach by stable name** (`new-session -A -s nt-<id>`) | `zellij --config <kdl> --layout-string 'layout { pane; }' attach --create --close-on-exit nt-<id> -- <shell> [args]`. Atomic. The initial command is ignored on a reattach. `options --default-layout <file>` and a `default_layout` line both still produced the tab bar and status bar; `--layout-string` did not, and a reattach with it adds no tab. `options --default-shell` was ignored on a created session, hence the explicit initial command. | A *session* is a whole server holding workspaces/tabs/panes (`herdr --session <name> server`). A node would be a pane made with `workspace create --cwd … --env K=V` — and the only way to attach a pty to ONE pane is `agent attach <pane>`, which answered `agent_not_found` for a plain shell pane. A full `herdr --session X` attach draws herdr's own workspace UI. |
| **Detach, leave running** (client exit) | SIGHUP to the client: "Bye from Zellij!", session stays. | Server-side; clients detach. |
| **Strict exists** (`has-session -t =name`) | `list-sessions -n` lines `name [Created …]` (`(EXITED - attach to resurrect)` for serialized ones). No sessions = exit **1** plus "No active zellij sessions found" — exit status alone cannot tell absence from failure. Exact names only. | `session list --json` (`running: true/false`). |
| **Shell exit ends the session** | With a client attached: yes (client prints "Bye", session gone). **With no client attached: the session stays listed with no terminal pane** ("zombie"); an `attach --create` to it connects and exits at once. Right after creation a session also has no terminal pane *for a moment*. | Pane closes inside a still-running server. |
| **Capture screen + history** (`capture-pane -p [-e] -S`) | `action dump-screen --pane-id <p> --full [--ansi]` (viewport, or viewport + scrollback; `--ansi` keeps SGR). ~16 ms per call. | `pane read <pane> --source visible\|recent [--ansi] [--lines N]`. |
| **Send text as ONE paste honouring the app's paste mode, then Enter** (`paste-buffer -p`) | `action paste --pane-id <p> <text>`: **plain** when the app never asked, **framed** `ESC[200~…ESC[201~` after `printf '\e[?2004h'` (both measured against `cat -v`); `\n` stays `\n`. Enter = `action write --pane-id <p> 13`. Text rides ONE argv element: 131,000 bytes delivered, 140,000 failed (exit 126, Linux `MAX_ARG_STRLEN`). No stdin form. | `pane send-text` is **never framed** — measured: text arrived raw after `?2004h`. The mode-aware paste (`paste_payload` in `src/pane.rs`) is only behind `agent prompt`, which requires herdr's own agent detection. |
| **Targeting with no client** | An action without `--pane-id` silently did nothing headless (no focused pane without a client). `action list-panes --all --json` gives ids; the target is the focused live terminal pane, else the lowest id. | Pane ids (`w1:p1`) from `pane list`. |
| **Kill** (`kill-session -t =name`) | `kill-session <name>`, exact match (`nt-e` did not touch `nt-e1`). With `session_serialization false` the session is gone, not resurrectable. | `session stop` / `pane close`. |
| **List sessions + attached-client counts** (reaper, session memory) | Names: `list-sessions -n`. Clients: `--session <s> action list-clients` (one row per client). Not wired in v1 (see gaps). | `session list`; client counts not measured. |
| **Per-session environment at creation, no secrets on argv** (`-e` + `update-environment`) | Each session is its **own server process**, forked by the client that created it, so the session env IS the creating client's env. Measured: a variable exported only to the creating client was visible in the pane; nothing on argv. `ZELLIJ_SESSION_NAME` is set in the pane. | Per-pane `--env KEY=VALUE` is **argv** (visible in `/proc/<pid>/cmdline` while the CLI runs). A server started with a variable does pass it to its panes, but then one server per node. |
| **Pane foreground command** (`#{pane_current_command}`, restart/Eco gates) | No headless CLI: `list-clients` shows a running command only with a client attached (`N/A` for a shell); `list-panes` gives the launch command. The process table does: `zellij --server <socketdir>/contract_version_1/<name>` → its child shell → the shell's `tpgid` → that process. Measured `server → bash (tpgid = sleep) → sleep`. | `pane process-info --pane <id>` returns `foreground_processes` with argv and cwd — the best answer of the three. |
| **Resize / size ownership** | Pty resize → client SIGWINCH. Two clients: the session takes the **smallest** (100×30 + 80×20 → 80×20). | Not measured. |
| **Mouse / scroll / copy** | Client enters the alternate screen (`?1049h`) and enables `?1000h ?1002h ?1003h ?1006h`; wheel scrolls Zellij's own scrollback; a mouse drag emitted **OSC 52** (`ESC]52;c;<base64>`) to the client — the same model as tmux in nodeterm. | Own UI; not measured. |
| **Key passthrough** | Keybindings are **session-wide** (a session created with cleared keybinds ignored a second client's own config). In `default_mode "locked"` Ctrl-g, Ctrl-p, Ctrl-t, Ctrl-o all reached `cat -v`; with the unlock moved to Ctrl-Alt-g, Ctrl-Alt-g then Ctrl-o d detached. | Not measured. |

## Decision: Zellij for v1

Zellij maps onto the tmux contract nearly one to one: an atomic create-or-attach by name, a real
client as the painter (alternate screen, mouse, OSC 52 — the renderer needs nothing new), a paste
that applies the application's own bracketed-paste mode, and environment delivery with nothing on
argv. herdr is a workspace manager whose unit is a server of many panes: a node would have to be
one pane, which cannot be attached to on its own (`agent attach` refuses a non-agent pane), per-pane
environment is argv, and its text send does not honour paste mode.

**herdr gaps, for whoever picks it up:** single-pane attach for a non-agent pane; mode-aware paste
from the CLI (`pane send-text` framing like `paste_payload`); a per-pane environment that is not
argv (stdin or a file). herdr's `pane process-info` is better than anything Zellij offers for the
foreground-process question and would be the model for that leg.

## v1 design (what shipped)

- **Setting:** `settings.sessionBackend` = `tmux` (default) | `zellij`, Settings → Session
  protection → *Session backend*. Read through `normalizeSessionBackend`: anything else is tmux.
  The row is shown only by a core that reports Zellij discovery (POSIX), and says when Zellij is
  selected but not installed (new terminals then use tmux).
- **The backend follows the session that exists.** A warm tmux session is reattached in tmux; a
  live Zellij session is reattached in Zellij, whatever the setting says now; only a node with no
  session anywhere is created in the selected backend. Switching the setting therefore never
  strands a running agent in one multiplexer while cold restore relaunches it in the other.
- **Local projects only.** SSH projects keep the remote tmux; Windows keeps the session host.
- **Our config** (`<userData>/zellij.kdl`, rewritten when it changes): locked mode with the lock
  toggle on Ctrl-Alt-g, no pane frames, no startup tips, `session_serialization false`, mouse on;
  plus the bare one-pane layout. When nodeterm starts the default shell, it passes `-l` for
  bash/zsh/fish, as tmux runs its default shell as a login shell.
- **Zombies:** a session listed with no terminal pane is only believed after five pane-less reads
  300 ms apart (a just-created session looks the same for a moment); a confirmed zombie is killed
  before the node is created again.
- **Unknown is warm, whatever the setting.** When Zellij cannot be asked about a node, the create
  is never cold — even with tmux selected — because a node that may still run in Zellij must not
  get its snapshot replayed and its agent `--resume`d a second time in a new tmux shell (found in
  review: a first version folded to warm only when Zellij was selected). `sessionExists`, by
  contrast, claims a Zellij session only from a listing that parsed and shows it live.
- **Session names may contain spaces** (measured: `my work [Created 0s ago]`); the listing parser
  takes everything before the last ` [Created `. The first version rejected such a line, and one
  personal session made every probe `unknown`.
- **`--` before every positional text** (`paste`, `write-chars`): measured, `- item one` was
  refused as an unknown argument and `-h` printed help with exit 0 while delivering nothing.
- **Only when Zellij is in play.** Probes of nodes we know nothing about (the per-create
  `list-sessions`, the per-delete `kill-session`, the relay listing) run only when Zellij is
  selected or has been used on this machine (our `zellij.kdl` exists; it is written only when a
  Zellij terminal is created). A tmux user who merely has Zellij installed runs exactly the old
  path.
- **Socket path length.** Zellij refuses a socket path over the platform limit ("IPC socket path is
  too long (108 bytes, max 107)", measured in review on Linux; macOS allows 103). With the setting on and a
  path that would not fit, new terminals fall back to tmux and the Settings row says why. A stock
  Mac (no `XDG_RUNTIME_DIR`, 49-character `$TMPDIR`) with a real node id computes to ~104 bytes —
  over the limit — so on such a Mac the row is expected to say so until `XDG_RUNTIME_DIR` or
  `ZELLIJ_SOCKET_DIR` is set short. Calculated, not run.
- **Delete** kills `nt-<id>` in Zellij (exact name) whenever Zellij is in play, so a node deleted
  after a restart, never mounted since, does not leave its session running.
- **Paste:** refused (not split) above 120,000 UTF-8 bytes.
- **Session memory:** the sweep reads tmux; the panel reports how many Zellij sessions it did not
  measure instead of "No sessions are running here.".

### Not available with Zellij (named in the Settings row)

- Agent-to-agent messaging and triggers into Zellij sessions are refused (no pane-owner or paste-mode probe).
- Model switch refuses: it cannot stop the foreground process of a Zellij pane.
- The session-memory panel counts Zellij sessions but does not measure them; the idle-session reaper does not see them.
- Pasted text reaches Zellij as a command-line argument (readable by other local users while the call runs); pastes over 120 KB are refused.
- The stale-folder banner and the live pane folder for file links are unavailable.
- A live link to a Zellij node gets no screen snapshot (viewers start from the live stream), and can be watched only while its terminal is attached in this app.
- SSH projects and Windows keep tmux / the session host.
- nodeterm mobile’s direct SSH attach only finds tmux sessions.

Also true and not in that list: control-mode shadow clients do not exist for Zellij (a released
Zellij node is re-attached by a painter, not a zero-pty control client); the late cold-start check
is SSH-only anyway; `paneCursor` is unknown, so a resync paint leaves the cursor where it lands.

## Surfaces

- **Desktop:** measured and tested on Linux only. macOS is untested: see the checklist, whose
  first item decides whether Zellij can be used there at all without a short socket dir.
- **Server Edition:** the same core. The Settings row appears whenever the server host reports
  Zellij discovery; sessions are created on the server host.
- **Mobile:** over the relay, the phone's `pty.attach` goes through the same core and joins the
  Zellij session (`listNodetermSessions` includes Zellij sessions and remembers them for the attach).
  The phone's **direct SSH** path runs `tmux` on the host and cannot see Zellij sessions — an iOS
  follow-up.

## Device checklist (not run here)

1. **macOS socket path**: on a stock Mac, does the Settings row report the socket path as too long
   (expected, see above), and with `ZELLIJ_SOCKET_DIR` set short, do Zellij nodes open? Also run
   the `*.realzellij.test.ts` suites on a Mac (their sandbox falls back to a short `/tmp` socket
   dir when the sandbox path would not fit).
2. macOS: `ps -A -o pid=,ppid=,tpgid=,comm=,args=` shape and `tpgid` for the pane shell
   (Restart agent / Eco read the pane command from it).
3. macOS: Zellij from Homebrew is found from a Finder-launched app (`/opt/homebrew/bin`).
4. A canvas node in Zellij: typing, resize, wheel scroll, drag-copy (OSC 52 pill), Shift+Enter in
   an agent CLI, Ctrl-g reaching Claude Code.
5. Attach from an outside terminal with `zellij attach nt-<id>`; both clients see the same pane;
   the smaller one sizes it.
6. App restart with a Zellij node: warm reattach, no cold restore, agent still running.
7. Machine reboot: cold restore replays the scrollback snapshot and resumes the agent in a new
   Zellij session.
8. Server Edition on a Linux host with Zellij installed: create, reattach from a second tab.

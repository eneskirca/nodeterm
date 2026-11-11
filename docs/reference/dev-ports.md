# Dev-server ports (the Ports chip + same-port SSH forwarding) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Dev-server ports (the Ports chip + same-port SSH forwarding)

An agent starts a dev server inside a node's session; on an SSH project it listens on the HOST's
`127.0.0.1:<port>`, and before this the person had to build a tunnel by hand before a browser node
could show it. A terminal node's header (and its kanban card modal — one component, `PortsChip`)
now shows the TCP ports that node's session listens on; a row opens `http://localhost:<port>` in a
browser node beside it, and on an SSH project it first forwards the SAME port number over the
project's existing ControlMaster, so the URL the tool itself printed just works here. Pieces:
`core/dev-ports.ts` (probe + parsers), `core/remote-ssh/port-forward.ts` (lifecycle),
`core/dev-ports-service.ts` (routing), `renderer/components/PortsChip.tsx`,
`renderer/state/devPorts.ts` + `canvas/useDevPortScanner.ts` (cadence), `lib/devPorts.ts` (pure).

- **Discovery is by OWNERSHIP, never by probing.** A port is attributed to a node only when its
  listening socket belongs to a process inside that node's tmux pane tree (every pane of `nt-<id>`,
  the same tree session memory rolls up — `indexProcesses` is shared). Nothing is ever connected to,
  and another user's or another program's port is never reported. The owning pid comes from
  `ss -ltnp` (Linux), else `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (macOS, Linux without iproute2 — its
  exit 1 with no output is an ANSWER, "nothing listening"), else `/proc/net/tcp{,6}` joined to
  `ls -l /proc/*/fd` by socket inode (one `ls`, never a `readlink` per descriptor). No tool at all is
  its own failure (`no-listener-tool`), never "no ports".
- **The listener tools' output is attacker-influenced text — parse it as such** (review of #1063,
  reproduced on the dev host). ss prints a holder as `("<name>",pid=N,fd=M)` with the process NAME
  raw, and any process can rename itself: as root, a listener owned by `nobody` named
  `vite",pid=12345` printed `users:(("vite",pid=12345",pid=219072,fd=3))`. Collecting every `pid=`
  on the line handed that stranger's port to whichever node's tree holds 12345 (pane pids are
  visible to every user via `ps`), and the forward then served the attacker's page on
  `localhost:P` — where it receives the cookies of every OTHER localhost dev app (cookies are not
  port-scoped). Two defences: each `(…)` group is parsed on its own and only its LAST
  `,pid=N,fd=M` counts (ss cannot print `)` inside a name, so a greedy `[^)]*` cannot be steered
  past it), and `assembleDevPorts` requires the tool's name for that pid to agree with `ps`'s
  (prefix-tolerant: Linux comm is 15 bytes, lsof's `c` 9, macOS ps prints the full basename). The
  `/proc` branch had the same class: GNU `ls -l` prints a NEWLINE in an fd's link target raw, so a
  target `a\n/proc/100/fd:\nl -> socket:[999]` forged a pid header; it is `ls -lq` now. Both
  are tested under a real `/bin/sh`, and the ss one also END TO END: a real process outside the
  pane tree renames itself (`prctl(PR_SET_NAME)`) to name the pane's pid, real `ss` prints the
  forged group, and the port is not attributed.
- **The LOCAL scan asks the app's own tmux** (`tmuxBin: ptyManager.getTmuxBin()`, the resolver
  session memory is given, quoted into the script). A bare `tmux` answered 127 on both sockets for
  a Mac whose only tmux is the bundled one and for a Linux tmux reachable only on the login-shell
  PATH (nix, linuxbrew) — `unreachable`, no chip ever — and a different tmux client against the
  app's server can hit a protocol mismatch. No tmux at all is `unsupported` (plain shells own no
  pane tree). An SSH host keeps `tmux` via the PATH append.
- **One generated script, run on BOTH machines.** `devPortsProbeCommand` is POSIX sh; a local project
  runs it through `/bin/sh -c`, an SSH project over the master — one round trip carrying the panes of
  both nodeterm sockets (fenced per socket with the SAME `fencedListPanesCommand`/`parseFencedPanes`
  session memory uses, so "no server running" is an answer and a broken tmux on every socket is
  `unreachable`), `ps -eo pid=,ppid=,comm=`, and the listener section. One script, one parser: a
  separately written local leg is the drift the session-memory ledger records three times. PATH is
  APPENDED with the tmux dirs and `/usr/sbin:/sbin` (where `ss`/`lsof` live on some distros and a
  non-login exec channel's PATH lacks them). Every marker is quoted (`echo ##X` prints an empty line
  under POSIX sh). Tested under a real `/bin/sh` against a fake host tree, one case per branch, AND
  end to end on Linux: a real tmux session (private socket, sandboxed TMUX_TMPDIR) running a real
  listener two processes below its pane, read back through real `ps` + `ss`
  (`dev-ports.realsh.test.ts`).
- **Windows: the session host's panes + one PowerShell call** (`collectWin32DevPorts`). No `/bin/sh`
  and no tmux there, so the panes are the host's `sessionDetails` pids and the process table +
  listeners come from `Win32_Process` + `Get-NetTCPConnection` (the owning pid is a kernel field —
  no name to forge), else `netstat -ano` (a listener is a TCP row whose FOREIGN port is 0: the state
  column is localized). Same `assembleDevPorts`. A failed host read, an older host without pids, or a
  non-zero PowerShell exit is `unreachable`; `unsupported` only when the session host is not the
  backend; no nt- session means no PowerShell spawn at all.
- **Ports in the ephemeral range (≥ 32768) are listed but not counted.** A headless browser's
  debugging endpoint or an MCP helper asks for "any port" and lands there; a dev server a person
  means to open almost never does. The chip counts only the rest and is absent when there are none;
  the others sit one level down in the menu ("Other ports").
- **Cadence** (`lib/devPorts.ts`): a scan when the project comes on screen and on window focus; a
  debounced trailing scan 4 s after the project's agents report activity (`onHookEvent` — a dev
  server is usually an agent's tool call); a slow poll (30 s local, 60 s SSH) ONLY while the window is
  focused and visible — a server started by hand in a plain terminal fires no hook; and on demand when
  the chip's menu opens. **Both automatic triggers — the hook lull AND the poll — check "someone is
  watching" at fire time**; the hook one did not at first, so every agent turn in a backgrounded
  window cost an exec on the host (`ps` + `ss -p` across every process's fds as root). Automatic scans keep a 10 s gap; concurrent ones coalesce in core. An SSH
  project is scanned only while connected. One scan costs one `ps` plus one `ss` (a few lines) — an
  exec over the master on a host, never a login.
- **Forwarding rules — each a refusal, never a guess** (`PortForwardRegistry`):
  - The renderer names a node and a port, never an address. Core re-scans at click time and forwards
    only a port that scan attributes to THAT node; the host-side target FOLLOWS THE BIND
    (`forwardTarget`: any IPv4 wildcard/loopback → `127.0.0.1`, else `::1`, else the one specific
    address), because a server bound only to `::1` refuses `127.0.0.1`. The target is re-validated as
    an IP literal — it came off another machine's command output and lands in an ssh argument.
  - The local side binds `127.0.0.1` ONLY (`localForwardArgs`), never `*`: an unfinished app must not
    be published to the network the laptop is on. `localFwdSpec` re-validates both ports and the
    target at the argv site (rule 13) and throws, which the registry reports as a failed forward.
    An IPv4-mapped bind (`::ffff:127.0.0.1`) is normalized to its IPv4 address first — it used to
    make `forwardTarget` answer null, reported as a misleading SSH refusal (now its own
    `unreachable-address`).
  - **A taken local port is refused with the reason, never silently moved.** "Taken" means anything
    answers on `127.0.0.1:P` OR `[::1]:P`, or 127.0.0.1 cannot be bound: a local app bound only to
    `::1` leaves 127.0.0.1 free, the forward would succeed, and the browser's `localhost` (IPv6 first)
    would show the LOCAL app under the host's name. A different local port is only ever the person's
    explicit choice (a confirm naming a suggested free port, and saying the tool's printed links will
    not reach it). The facts are two connects and one bind, ordered by the pure `localPortVerdict`:
    an answer on `::1` is busy; a bind refused with EACCES/EPERM is `local-port-denied` (a confirmed
    privileged port on Linux as non-root — "already in use" was a lie), with a free unprivileged port
    offered; a bind refused as IN USE may be OUR OWN master's listener — after an app crash the
    adopted ControlPersist orphan keeps its forwards while the registry starts empty — so the
    identical forward is re-issued: the holding master acknowledges it with 0 (measured) and it is
    re-adopted, anything else answers 255 and it stays busy; a v4 answer we could still bind beside
    (BSD wildcard + SO_REUSEADDR) is busy, never shadowed.
  - A privileged port (< 1024, either side) is never forwarded until the person confirms it.
  - Lifecycle: cancelled (`-O cancel` with the exact spec) when the node's session ends
    (`PtyManager.onSessionEnded` — delete and recycle) or when a SUCCESSFUL scan no longer lists the
    host port UNDER THE NODE THAT OWNS THE FORWARD (the same number under another node is not the
    server the person opened). The renderer scans only the project on screen, so core re-checks on
    its own: a sweep (`FORWARD_SWEEP_MS`, 60 s) armed ONLY while a forward is held re-scans each
    forwarding project, skipping one reconciled within the interval — without it, a project switched
    away from or closed (neither disconnects) kept its forwards bound after the dev server died, the
    local port stayed taken (a local dev server silently moved to P+1), and whatever later bound the
    host's P got the traffic; dropped without ssh when the project leaves `connected` (the master takes its
    listeners with it). A failed scan cancels nothing — a failed read is never evidence. A master
    rebuilt behind our back by `ControlMaster=auto` (issue #735's mechanism) carries no `-L`, so every
    successful scan re-checks that the local listener is still held and forgets one that is not — the
    menu then offers to forward again instead of claiming a dead forward.
  - Main wires both lifecycle hooks; `main/dev-ports-wiring.test.ts` pins them at source level,
    because a dropped listener compiles and leaves forwards open after their node closed.
- **MEASURED against a real OpenSSH 9.6p1 sshd + mux master (2026-09-30, lab on loopback):**
  `-O forward -L 127.0.0.1:P:[::1]:P` exits 0 and `http://localhost:P` answers 200 through it (the
  bracketed IPv6 target works); the IDENTICAL forward again exits 0 (the master dedups it); a local
  port already bound by another process exits **255** with `mux_client_forward: forwarding request
  failed: Port forwarding failed` — synchronous, so a refusal is known at click time; `-O cancel`
  closes the listener (curl then gets connection refused) and exits **0 even when nothing was
  forwarded** (it only prints an error), which is why its exit code is ignored; `-O exit` takes every
  forward with it.
- **Surfaces.** Desktop: full (local projects: discovery + open, no forward — the port is already on
  this machine; SSH projects: discovery on the host + same-port forward). Windows: the local probe
  answers `unsupported` (no `/bin/sh`, no tmux) and the chip is not drawn; an SSH project from a
  Windows desktop still works (the probe runs on the host). **Server Edition: not served, on
  purpose** — the browser node is an Electron `<webview>` a browser tab does not have, and a page the
  viewer opened would load on the VIEWER's machine, where the server's port is not. Its bridge stub
  answers `unsupported`; nothing registers the service in `src/server`. Relay tabs: the same stub
  (their sessions live on the host). Kanban: the card modal draws the chip when the card's project is
  the one on the canvas; opening a port hands over to the canvas, where the browser node appears
  beside the node. **Mobile: follow-up** — the phone would need the port list over the relay and a
  forward of its own (it has no local browser node); noted for nodeterm-ios. All three channels are
  in `HOST_ONLY_CHANNELS` (a forward binds a port on the host machine's loopback).
- **Known limits, stated:** a re-adopted orphan forward (above) is only re-claimed when the person
  opens that port again; until then the chip does not show it as forwarded. A server that DAEMONIZES (double-fork, reparented to init) leaves the
  pane tree and is not found; `ss` without `-p` information for our own processes (hidepid, a
  container) finds listeners but no owner, so nothing is attributed; the Mac leg (lsof, the local
  bind/connect probes under BSD socket rules) has not been run on a Mac — device checklist in the PR.

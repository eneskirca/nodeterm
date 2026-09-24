# Windows session host

**What this is:** a tmux-equivalent session-persistence backend for Windows (and any other
platform where a real `tmux` cannot be found), so closing the app — or the app crashing — no
longer kills every running terminal and every agent CLI mid-task. It is a standalone,
long-lived Node process that owns the real PTYs and outlives the Electron app.

This document describes the Windows desktop implementation. It does not embed Microsoft Windows
Terminal, and it does not change the Server Edition or mobile companion.

Selected automatically, per session, in this order:

```
real tmux found on this machine  →  tmux (unchanged, every platform)
no tmux found, tmuxEnabled       →  session host (this document)
neither                          →  plain shell (no persistence, as before)
```

Stock Windows provides no native tmux, so the session host is the normal persistence backend
there. On macOS/Linux nothing changes: if tmux is installed, it is still preferred every time.

## Why not just port tmux's approach

tmux does not exist on Windows, full stop — there is no binary to bundle. The session host is a
from-scratch analogue built out of three pieces this codebase (or the wider Node ecosystem)
already has good building blocks for:

1. A **real PTY** per session — `node-pty`, the same dependency the rest of the app already uses.
2. A **server-side terminal emulator** per session — `@xterm/headless` + `@xterm/addon-serialize`,
   so the host can answer "what does this screen currently look like" without a human ever having
   looked at it. This is the piece tmux gets from its own C implementation; here it's the same
   xterm.js core the renderer itself uses, just running headless in Node.
3. A **tiny bespoke IPC protocol** (newline-delimited JSON over a local named pipe / unix socket)
   instead of tmux's binary control-mode protocol, because there is no existing "attach to a named
   session and stream its output" primitive to reuse on Windows.

## Architecture

```
Electron main process                    Session-host process (standalone, detached)
┌─────────────────────┐                  ┌──────────────────────────────────────────┐
│ PtyManager           │                  │ net.Server (named pipe / unix socket)     │
│  spawnSession()      │  local IPC       │  ── per-connection: hello + dispatch      │
│   └ SessionHostPty ──┼─── (JSON lines) ─┼─→ Map<name, HostSession>                  │
│      (IPty-shim)     │                  │      ├─ node-pty IPty  (the real process) │
│                       │                  │      ├─ TerminalEmulator (headless xterm) │
│  session-host-client  │                  │      └─ subscriber sockets (co-attach)    │
│   (one connection,    │                  │                                          │
│    auto-spawns host)  │                  │  exits when its last session is killed,  │
└─────────────────────┘                  │  plus a grace window (see "Lifetime")     │
                                           └──────────────────────────────────────────┘
```

- `src/session-host/` — the standalone process. Pure Node, no Electron dependency anywhere in
  this directory (verified: it does not even import `../core` or `../main`). Bundled with esbuild
  (`npm run host:build`, mirroring the existing `server:build` script) to
  `out/session-host/host.cjs`, with `node-pty` kept external (native module — the same reason
  `server:build` externalizes it).
- `src/core/session-host-client.ts` / `session-host-launcher.ts` / `session-host-backend.ts` /
  `session-host-pty.ts` — the Electron-main-side client. `src/core` stays Electron-free
  (`no-electron.test.ts`); these files import only `net`/`fs`/`crypto` and the pure protocol/paths
  modules.
- `src/core/pty-manager.ts` — the integration seam: `Session.sessionHost?: boolean`
  marks a session-host-backed `Session`, and every call site that reaches past `session.proc` to
  run a tmux CLI command directly (`sendText`, `paneCommand`, `captureSession`, `captureSnapshot`,
  `snapshotScrollback`, `captureForResync`, the final kill in `destroySession`,
  `listNodetermSessions`) gained one `else if (!this.tmuxPath) { … session-host equivalent … }`
  branch, in the same shape the existing `sshRemote` branch already used. `spawnSession()` selects
  this backend between the tmux branch and the plain-shell fallback, and constructs a
  `SessionHostPty` instead of calling `pty.spawn` directly.

## Availability notice

`pty:tmux-status` retains its tmux-only `available` field and adds `persistence`: the
user's `enabled` setting and the discovered `backend` (`tmux`, `session-host`, or null).
Discovery does not start the host or certify runtime health. POSIX prefers tmux; Windows
uses the session host. A missing/errored status stays unknown, including over Server Edition's
WS bridge. Older peers without the field also remain unknown.

The desktop/browser banner warns when protection is disabled, absent, or unknown; Settings
shows the same state and refreshes it after a setting change and periodically. The state is
about **new local terminals**, not SSH/relay hosts or an upgrade of existing plain shells.
An installer is offered only from a local project, so it cannot run on the selected remote
host by mistake. Runtime session-host attach failures still use the terminal's existing error
path; a bundle being present is not proof an individual session attached successfully.

## Windows profile resolution

The profile catalog is a trusted desktop service. Its public API returns only a stable `id`,
display label, kind, availability, and an optional unavailable reason. Executable paths and argv
remain private. `PtyCreateOptions.profileId` crosses the desktop bridge; the trusted core validates
and resolves it immediately before either `node-pty` or the session host spawns a process.

Stable ids are `auto`, `pwsh`, `windows-powershell`, `cmd`, `git-bash`, `custom`, and one
`wsl:<distribution>` per installed WSL distribution. `auto` is the only profile allowed to search
down a precedence list: PowerShell 7, then Windows PowerShell, then `%COMSPEC%`/`cmd.exe`. An
explicit unavailable or malformed profile fails; it never becomes a different shell.

For WSL, distribution discovery parses the UTF-16/NUL-padded output of
`wsl.exe --list --quiet`. The selected distribution's own `wslpath` translates the Windows project
directory, after which launch keeps the structured `wsl.exe -d <distribution> --cd <linux-path>`
prefix and runs a trusted distro-side cwd guard before replacing it with the configured default
shell. The guard independently changes to the positional Linux path so a directory removed after
translation cannot silently open in `/`. Enumeration,
translation, and launch failures keep their real reason and perform no fallback spawn. A
distribution name containing spaces remains one argv element.

The profile id is a machine-local snapshot, not project content. `terminalProfileId`, legacy
custom `shell`, and advanced SSH execution values are removed from shared project files, portable
exports, and inbound canvas traffic. A shared file or peer can therefore neither inject argv nor
select a local executable. See
[`features/terminals/windows-shell-profiles.md`](features/terminals/windows-shell-profiles.md).

### The IPty-shim (why the integration is this small)

`PtyManager`'s entire co-attach / flow-control / subscriber / park / reap machinery operates on
`Session.proc`, and only ever calls `.onData()`, `.onExit()`, `.write()`, `.resize()`, `.pause()`,
`.resume()`, `.kill()`/`.destroy()` on it — never `.pid`, never anything ConPTY/Unix-specific.
`SessionHostPty` (`src/core/session-host-pty.ts`) implements exactly that subset, backed by the
session-host connection instead of a real OS pty. Cast at the one construction site in
`spawnSession()` (`as unknown as pty.IPty`), it is otherwise indistinguishable from a real
node-pty `IPty` to every other line in `pty-manager.ts` — every subscriber, every flow-control
ticket, every park/reap decision keeps working unmodified.

## The protocol

Newline-delimited JSON, defined in `src/session-host/protocol.ts` (imported by both sides — it is
the one module the standalone bundle and the Electron-main bundle genuinely share). Every request
carries a monotonic `id`; the host echoes it on the response, so replies self-correlate over one
long-lived connection (no positional-FIFO fragility, unlike this app's tmux control-mode client).

| Verb (`SessionHostRequest.cmd`) | tmux equivalent                         | Coverage |
|---|---|---|
| `hello`                          | (no tmux equivalent — auth handshake)   | full |
| `attach`                         | `new-session -A` / `attach-session`     | full, plus a screen the tmux path never needed (see below) |
| `hasSession`                     | `has-session -t <name>`                 | full (implemented; not on the hot create path — see below) |
| `write`                          | raw bytes on an attached client's stdin | full |
| `resize`                         | ConPTY/pty resize + `refresh-client -C` | full; each view claims a size, the app's grid follows its most recently active view (issue #914) |
| `pause` / `resume`               | node-pty `pause()`/`resume()`           | full; per-viewer in core and per-connection in the host (first pause / last resume) |
| `sendKeys`                       | `send-keys -l -- <text>` (+ `Enter`)    | full — works with no attached client, exactly like tmux |
| `paneCommand`                    | `display-message -p '#{pane_current_command}'` | approximated — see `process-tree.ts` |
| `capture`                        | `capture-pane -p -e [-S -N]`            | full, and strictly more (mode restoration — tmux's plain-text capture carries none) |
| `killSession`                    | `kill-session -t <name>`                | full |
| `detach`                         | a client's own `tmux detach-client`     | full |
| `listSessions`                   | `list-sessions -F '#{session_name}'`    | full |
| `ping`                           | (liveness probe used during the startup race) | full |

**Not implemented — deliberately out of scope for this pass:**

- `paneOwner` / bracketed-paste detection (`bracket_paste_flag`) / `#{cursor_x} #{cursor_y}
#{cursor_flag}` as a _separate_ query. These are real tmux features this app also uses
  (`pty-manager.ts`'s `paneOwner`, `bracketPasteRequested`, `paneCursor`), but none of them are in
  the task's minimum verb list, and cursor position is already carried for free inside `capture`'s
  output (`SerializeAddon` repositions the cursor as part of its own serialization — see below), so
  a separate cursor query would be redundant for this backend specifically. A session-host-backed
  node simply never calls the tmux-only paths that use these (they stay gated on `this.tmuxPath`
  being set, which it never is when session-host is selected).
- The tmux control-mode "shadow client" / shared background-write client
  (`PtyManager.shadowAttach` / `shared`). Session-host does not need an equivalent at all: unlike a
  tmux CLI command (a whole subprocess per invocation), every session-host verb is a stateless
  request over the ONE already-open connection, addressed by session name — the exact problem the
  shadow-client machinery exists to make cheap for tmux is simply not a problem here. See the
  `sendKeys`/`paneCommand`/`capture` rows above: none of them need an attached client.

## The seeding trap (read this before touching `spawnNew`/`join`/`SessionHostPty`)

CLAUDE.md's tmux section states the load-bearing rule for THAT backend: on a warm reattach, the
renderer must **seed nothing**, because tmux's own attaching client repaints the screen by itself
(the redraw arrives as ordinary PTY output, over the same channel as everything else). Writing
into the buffer yourself on top of that is what produced black bands and duplicated screens in an
earlier design.

**The session host is not a painter.** Attaching a new connection to an existing `HostSession`
does not make anything repaint itself — nothing writes fresh bytes into the pty on attach. Get
this backwards in either direction and you ship a visible bug:

- Seed nothing on this backend (copying the tmux rule verbatim) → the reattached terminal is
  **blank** until the next byte of real output arrives.
- Seed unconditionally on every backend → the tmux backend gets a **duplicated screen** on top of
  its own real redraw.

The fix is `Session.proc.ready` + `PtyCreateResult.screen`, used exactly the way the pre-existing
co-attach JOIN path (`PtyManager.join()`) already used `screen` for a same-process second
subscriber — this task did not have to invent a new field, only populate the existing one from a
new source:

- `SessionHostPty.ready` resolves with `{fresh, screen}` from the SAME `attach` round trip the
  constructor kicks off. `fresh: true` (cold start — nothing to paint) or `fresh: false` with a
  `screen` string reconstructed from the host's live headless terminal.
- `spawnNew()` awaits `ready` (after `spawnSession()` returns) and folds `screen` into the
  `PtyCreateResult` it hands back — the exact field `join()` already populates for a same-process
  co-attach.
- A rejected `ready` is a failed create, never a cold-but-working terminal. The provisional local
  `Session` is detached and removed, queued output is cancelled, and the original error reaches the
  renderer. Racing creates wait behind that result instead of joining the provisional index entry;
  a detached relay receives a non-zero sink exit because its legacy API cannot return a promise.
- **The renderer needed zero changes.** `seedPaint()` (`src/renderer/terminal/terminal-config.ts`)
  already treats _any_ non-empty `screen` on a `warm-attach` replay as paintable
  (`create-screen`), regardless of whether it arrived via a co-attach join or a plain reattach —
  that generality already existed, unused by anything but `join()`, before this task. Verified by
  reading `seedPaint`'s body rather than assumed.

Relay/mobile attach does not use that renderer create round trip: it asks
`PtyManager.sessionExists()` and `captureSnapshot()` before `attachDetached()`. Those two public
leaves must route through `sessionHostHasSession` / `sessionHostCapture` when tmux is absent. If
they fall back to the older tmux-only implementation, a live Windows-hosted agent is reported as
fresh and its phone mirror starts blank even though the session host still owns it.

### Private-mode restoration (mouse tracking, bracketed paste, …)

A pane's cursor position and its DEC private modes (has the app running inside it requested mouse
tracking? bracketed paste? is it on the alternate screen?) are not visible in plain captured text.
tmux's own answer to this is `PtyCreateResult.coAttachMouse` / `CO_ATTACH_MOUSE_SEQ` — a hardcoded
mouse-enable sequence the renderer writes because tmux's `capture-pane` carries no mode
information at all, and this app always runs tmux with `mouse on`.

The session host does better, because `@xterm/headless` + `@xterm/addon-serialize` know the real
mode state:

- **Verified, not assumed** (read `SerializeAddon`'s compiled `_serializeModes()` in
  `node_modules/@xterm/addon-serialize/lib/addon-serialize.js` rather than trusted the docs):
  `serialize()`'s output already restores application-cursor-keys, application-keypad,
  bracketed-paste, insert mode, origin mode, reverse-wraparound, send-focus, wraparound, the
  alt-buffer switch, AND the cursor position — all embedded directly in the returned string as
  ANSI escape sequences.
- **The one known gap:** `SerializeAddon` does not emit `CSI ?1006h` (SGR extended mouse
  coordinates) even when mouse tracking is active — there is no separate field on the public
  `IModes` API for it to read (`mouseTrackingMode` only says which tracking _protocol_ is on:
  none/x10/vt200/drag/any, not the coordinate _encoding_). Filled in explicitly by
  `TerminalEmulator.serialize()` in `src/session-host/terminal-emulator.ts`: whenever
  `mouseTrackingMode !== 'none'`, `\x1b[?1006h` is appended by hand.

Because all of this rides inside the `screen` string itself (as real escape sequences the
renderer writes verbatim), **`PtyCreateResult.coAttachMouse` is never set for a session-host
session** — there is nothing left for that separate flag to carry.

### Output ordering, flow ownership, and geometry

`@xterm/headless` applies `Terminal.write()` asynchronously. A PTY data callback therefore does
not mean the emulator is ready to serialize that byte yet. `HostSession.recordOutput()` chains
those promises in arrival order, and every warm attach, capture, resize and final exit crosses the
same tail before it reads or disposes the emulator. Do not replace that with a fire-and-forget
`void term.write(data)`: a relay/phone can then receive a warm snapshot missing output the host has
already observed, and an attach racing a pending write can get the same chunk once live and once in
its seed. The new socket joins the subscriber set only _after_ the barrier and snapshot, which is
the other half of avoiding that duplicate.

That promise tail is also a memory boundary. Bytes accepted but not yet applied to xterm are
counted as UTF-8; at 4 MiB the host takes an emulator-flow ticket and pauses node-pty, then returns
only that ticket after the queue drains to 1 MiB. This ticket is independent from both explicit
renderer flow control and named-pipe backpressure. Likewise, a `socket.write()` returning `false`
takes one transport ticket for every session subscribed on that socket, and only that socket's
`drain` returns it. A drain must never cancel a renderer pause or an emulator backlog.

Ownership is preserved at both aggregation layers. Every in-process `SessionHostPty` is a distinct
pause and geometry owner even though all of them share one `SessionHostClient` socket. The client
sends a pause only on the local 0→1 edge and a resume only on 1→0; the host then combines that one
connection-level ticket with other process sockets. Geometry follows the same shape: the client
reduces its live view claims, the host reduces all socket claims componentwise, and it resizes the
PTY and headless terminal before serializing a warm screen. Detaching a viewer recomputes the grid.

**The client's reduction is "most recently active", not "smallest" (issue #914).** Under tmux a
phone mirroring a node is its own tmux client, and tmux's default `window-size latest` gives the
window to whichever client was active last — so a phone that dismissed its keyboard got its rows
back. Here the phone (a relay-served `SessionHostPty`) and the desktop node share ONE client
socket, and the old componentwise minimum held the phone to the desktop node's rows with nothing on
screen saying why. `latestClaimSize` (`core/pty-size.ts`) now picks the claim with the highest
recency: an attach, a claim that CHANGES (a re-fit to the same size does not count, or every fit
would steal the session), and a write that is not a terminal report (`core/terminal-reports.ts` —
every attached xterm answers a DA/CPR/OSC query, and counting those would hand the session to
whoever answered last). Three rules come with it:

- **A viewer that cannot adapt is a ceiling.** Every renderer view renders the size it is told
  (`pty:size`: letterbox a smaller grid, clip a larger one, as a tmux client does). A pty wider than
  the phone's screen would wrap into garbage there, or — rendered at the pty's size — be clipped to
  its left ~45 columns, so a relay sink is `bounding` unless `pty.attach` carried
  `resizedFrames: true`, and the chosen size is clamped componentwise to every bounding claim. The
  iOS app keeps it that way on purpose: it reads `OP.Resized` only to explain the empty band
  ("Sized to another screen") and to offer "Fit this screen", which re-claims the size with a
  rows+1 → rows wiggle (an unchanged claim is not activity). Because the phone clears that hint
  every time it sends a size, the host ANSWERS every sink report, unchanged or not — the sink's
  `sinkShown` is forgotten on each report.
- **The pty's real size flows back to every viewer.** `SessionHostPty.onSize` → `PtyManager`
  `applyBackendSize` → `pty:size` to each view whose xterm is not already at it, and `OP.Resized`
  (payload = `OP.Resize`'s, 2× uint16 LE) to the relay sink. A session-host `Session` only VOTES in
  `applySize`; its views are corrected from the backend's answer, which the client sends after every
  vote, changed or not.
- **The host's `geometry` push is negotiated at hello, never assumed.** `hello` carries
  `features: ['geometry']`; the host answers with the subset it speaks and pushes `geometry` frames
  (and adds `geometry` to attach replies) ONLY on connections that asked. This is not caution: an
  older client treats every push frame that is not `data` as an EXIT, so a geometry frame sent to it
  retires a live session on the first resize (`session-host/geometry-host.test.ts` pins it against
  the real bundled host). Against a host without the feature the client reports its own applied size,
  which is exact while it is the host's only connection. Across connections (two apps on one host)
  the HOST still takes the componentwise minimum.

The same name is also a generation boundary. Data and exit events contain a session name but no
generation id, so an exiting `HostSession` remains registered until its queued output, final exit
broadcast and disposal complete. A same-name attach waits on that retirement promise before it can
spawn a replacement. The old socket may therefore see its old exit before the new attach response,
but the replacement can never receive an indistinguishable delayed exit from its predecessor. The
whole wait/inspect/create decision is serialized per session name; otherwise two concurrent attach
requests can both wake from the same retirement promise, both observe the empty slot, and spawn two
PTYs before either continuation publishes its choice. Grace-exit cancellation is part of that
atomic claim and runs after the wait, so it also cancels any new empty-host timer retirement just
scheduled before the replacement was created.

### Reconnect (a dropped client connection is not a dead session)

Sessions live in the host process, not in the client. If the Electron-main-side connection drops
(a transient IPC hiccup — not the host dying), `SessionHostClient` begins bounded automatic
reconnect attempts while any desired subscriber remains; an idle viewer does not stay frozen until
some later keypress. Establishing the socket includes an awaited restoration barrier. It replays
every still-live attachment with the local effective geometry and aggregate `paused` flag before
the request that triggered the reconnect is allowed onto the wire. The host applies that pause
before snapshot or live subscriber activation, so output cannot leak through the reattach window.

Any returned `screen` is delivered through the ordinary `onData` path as a full-buffer replacement:
`CSI 3J` clears scrollback, `CSI 2J` clears the viewport, home resets the cursor, and the serialized
screen restores the authoritative cells and DEC modes. Omitting `CSI 3J` merely clears the visible
page and duplicates xterm scrollback after every reconnect. Reusing the ordinary data channel keeps
this recovery local to the session-host client instead of adding a separate renderer resync IPC.

Restoration is never fire-and-forget. A delayed replay attach cannot overtake `hasSession`, `write`,
or a confirmed `killSession` and resurrect the deleted name afterward. If a desired resume, detach,
or replay acknowledgement is transport-ambiguous, the client destroys that socket so the host's
close handler releases all connection-owned tickets, then reconnects and replays only the still-live
desired state. A final unsubscribe racing an in-flight attach schedules a compensating detach after
the attach settles, preventing a ghost subscription.

The `hello` hand-off owns named `connect`/`data`/`error`/`close` listeners. It removes only those
listeners, installs the production frame listener, and then resolves the connection promise. Never
restore broad `removeAllListeners('data')` cleanup here: the original ordering installed the
production listener and immediately deleted it, so all real responses disappeared while the socket
still looked connected.

An initial `attach` registers its local subscriber before sending because startup output may race
the response. If the request rejects, it rolls back only that subscriber and its own remembered
options; a concurrent co-attach remains intact. Empty capture and already-absent kill are confirmed
host responses, while transport rejection remains unknown and propagates. That distinction keeps a
failed snapshot dirty for retry and prevents deletion from claiming an unconfirmed persistent
process is gone.

The same truth boundary reaches the renderer. `pty.destroy` is an acknowledged request on both the
Electron preload bridge and the Server Edition WebSocket bridge. Canvas, sidebar, project, and
agent-control deletion paths remove local nodes and recovery state only after the backing kill is
confirmed; validation, rate-limit, and transport failures keep the node present and retryable.

### A provisional attach is not a session

An `attach` is provisional until the host has authenticated the connection and returned the
correlated successful response. `PtyManager` does not index that shim, report it as persistent, or
expose it to subscribers before `SessionHostPty.ready` resolves.

If the attach is rejected, times out, or the transport fails:

- the provisional shim is destroyed and never enters the persistent-session index;
- queued bytes and a late exit from that rejected shim are ignored;
- every caller coalesced behind the same in-flight create receives the real attach failure;
- failed subscriber registrations are rolled back, so reconnect cannot replay a ghost attach;
- capture or kill transport uncertainty remains an error rather than being read as absence; and
- no plain shell or different profile is spawned as a substitute.

This is deliberately fail-closed. A non-persistent fallback carrying the same node identity would
look healthy while losing the one property this backend promises, and could run a local command in
the wrong shell or directory.

The `hello` hand-off has an equally strict ownership boundary. The handshake installs named
`connect`/`data`/`error`/`close` listeners, accepts only the response carrying its captured hello
request id, removes only those listeners, and then installs the production frame listener before
resolving the connection promise. Never restore broad `removeAllListeners('data')` cleanup here:
the original order installed the production listener and immediately deleted it, so the first
`attach` response and every later frame disappeared while the socket still looked connected.

An initial `attach` registers its local subscriber before sending because startup output may race
the response. If the request rejects, it rolls back only that subscriber and its own remembered
attach options; a concurrent co-attach's state is left intact. Capture and kill preserve the same
failure distinction across reconnects: an empty capture and an idempotently absent kill are both
confirmed `{ok:true}` host responses, while a transport/request rejection remains unknown and is
propagated. That propagation is what lets the periodic snapshot keep its dirty bit for a retry and
what prevents a delete from claiming a persistent process is gone when the host never confirmed it.

The `hello` hand-off has an equally strict ownership boundary. The handshake installs named
`connect`/`data`/`error`/`close` listeners, accepts only the response carrying its captured hello
request id, removes only those listeners, and then installs the production frame listener before
resolving the connection promise. Never restore broad `removeAllListeners('data')` cleanup here:
the original order installed the production listener and immediately deleted it, so the first
`attach` response and every later frame disappeared while the socket still looked connected.

An initial `attach` registers its local subscriber before sending because startup output may race
the response. If the request rejects, it rolls back only that subscriber and its own remembered
attach options; a concurrent co-attach's state is left intact. Capture and kill preserve the same
failure distinction across reconnects: an empty capture and an idempotently absent kill are both
confirmed `{ok:true}` host responses, while a transport/request rejection remains unknown and is
propagated. That propagation is what lets the periodic snapshot keep its dirty bit for a retry and
what prevents a delete from claiming a persistent process is gone when the host never confirmed it.

## Windows updates and uninstalls

A running host maps the installed Electron executable and its DLLs. Its separate hard-link name
makes it identifiable; it does **not** make the install directory safe to replace. Closing the app
alone deliberately leaves the host and its sessions running (#829).

The NSIS install/uninstall preflight now refuses to proceed while the app or host is running from
any installation, or a process runs under the installation path prefix. It replaces electron-builder's
automatic process termination, including
its silent/`--updated` path. Cancel leaves sessions alone. Retry performs a fresh, read-only process
query. A failed query (including an inaccessible nodeterm process with no executable path) blocks
instead of guessing. Silent installation returns a nonzero exit code, without a dialog or kill.
The query uses Windows PowerShell with a child-process-only execution policy; no persistent policy
or trust setting is changed. Group Policy restrictions still cause a safe refusal.

This is deliberately conservative: an old uninstaller may use a machine-wide name match or a
path prefix without a directory boundary. Another installation (even a sibling directory whose
name begins with this installation's name) can therefore block an update. The new preflight must
cover those legacy targets before invoking the old executable; it never stops them on your behalf.

To update while keeping your saved canvas:

1. Cancel the installer and reopen nodeterm if you already quit it. Save work in every local
   terminal and agent, including closed/other projects and sessions accessed from a phone.
   Let active tasks finish, then use each program's normal exit command and exit its shell.
   Leave the canvas nodes in place. **Do not use Sessions → End session or delete nodes to prepare
   for an update**: those actions remove nodes, rather than just stopping their processes.
2. Quit nodeterm normally so workspace changes are saved and it cannot start replacement sessions.
   Wait at least 30 seconds after the last shell exits for the empty host to shut down naturally.
   Quitting the app alone does not empty the host; a host with sessions will remain running.
3. If the host remains, keep the installer cancelled. In Windows Task Manager's **Details** view,
   verify the user and executable path of `nodeterm-session-host.exe` for this installation.
   After saving work and accepting that **every terminal/agent process owned by that host will
   stop**, end only that verified host. This is a manual process shutdown, not a graceful agent
   exit, so complete step 1 first. Do not use a machine-wide name-based kill. If the host uses
   the fallback name `nodeterm.exe`, verify its identity/path rather than guessing which process
   to end. Another Windows user's host requires that user's decision.
4. Run the installer from Downloads, outside the installation directory, or Retry its preflight.
   Other nodeterm installations/users must prepare their own sessions too if they block the check.
   Do not reopen the app or start sessions while installation is in progress.

Stopping the host after quitting leaves saved node metadata (positions, groups, agent/session
identities) and existing closed-session history in place; it does not call the node-deletion path
or add deletion entries to `closedSessions`. Reopen nodeterm after installation to use those nodes.
This is **cold recovery**, not preservation of live processes: shell jobs and unsaved terminal state
are lost. An agent can resume only when its harness supports resume, nodeterm has saved a valid
conversation id, and the matching account's conversation history is still available. A saved node
alone does not guarantee resume, restore an in-flight task, or recover unsaved work.

New installers run this check before invoking the previous version's uninstaller. Already shipped
installers/uninstallers cannot be patched retroactively; use the same preparation steps for them.
This is a safe refusal and manual recovery path, not live host migration: sessions cannot yet
survive replacing the binaries they have mapped. A process could still start after the preflight;
it is not an installation-wide launch lock.

Server Edition has no NSIS updater and is unchanged. Mobile/relay clients must expect a disconnect
when the user deliberately ends desktop sessions; they cannot authorize an update shutdown.
Real Windows per-user/all-users upgrades, old uninstallers, PowerShell policy variations, and
phone reconnection still require device verification (fixtures do not prove file-lock behavior).

## Lifetime

Mirrors tmux's server lifetime rule as closely as a different OS allows:

- **Spawned detached, unref'd, `stdio: 'ignore'`, `windowsHide: true`**
  (`session-host-launcher.ts`) — survives the spawning app process exiting entirely.
- In a **packaged** app, `process.execPath` is the Electron binary itself (there is no separate
  `node` executable to shell out to), so the child is spawned with `ELECTRON_RUN_AS_NODE=1`,
  which tells Electron to run as a plain Node process with no Chromium/BrowserWindow machinery.
  Harmless on a real Node binary too (dev mode): unrecognized, ignored.
- A client disconnecting **detaches only** — the underlying `node-pty` process, and the
  `HostSession` holding it, are completely untouched. This is the entire point.
- The app quitting detaches every client (the OS closes the sockets; the host's own `'close'`
  handler removes that socket from every session's subscriber set **and returns its pause
  ticket**) and leaves the host
  running. `PtyManager.killAll()` was NOT touched — it already never kills tmux sessions, and it
  correctly does nothing to session-host sessions either (no code path in it reaches this backend
  at all).
- The host exits when its **last session is killed** (`killSession`, or a session's own pty
  exiting naturally with nothing else left), plus a **30-second grace window**
  (`GRACE_EXIT_MS` in `host.ts`) so an app restart that briefly closes every node does not tear
  down a host about to be handed a fresh session moments later. A host that never receives a
  single real `attach` also eventually exits via the same grace timer, armed at boot.
- **Startup race** (two app instances launched at once, or two windows racing a lazy first
  connect): both processes may spawn a host. Exactly one may create the state file exclusively
  (`fs.openSync(statePath, 'wx')`); the loser polls that file (bounded, ~1.5s) waiting for the
  winner to finish writing `{pid, endpoint, tokenPath, …}` and answer a real `hello`, then exits
  quietly. A state file that resolves to nothing alive within that window is treated as stale
  (a previous host crashed mid-startup) and reclaimed. The same "connect first, only spawn if that
  fails" shape is what `SessionHostClient.doConnect()` does from the app side, so a host from a
  _previous_ app run is found and reused rather than duplicated.
  The winning state publication uses a PID+counter temp path and a bounded retrying atomic rename
  (`session-host/state-file.ts`, kept local so the standalone bundle does not import `src/core`). A
  fixed `<state>.tmp` lets a stale-lock reclaim collide with another publisher, and a bare rename
  loses startup when a Windows scanner briefly holds the destination open.
  Binding the pipe/socket is not the success boundary: token write and atomic state publication
  must both finish. If either fails, the host closes its listener, destroys any socket from that
  pre-publication window, removes its owned token/state/endpoint, and exits nonzero. This catch is
  explicit because the daemon's `uncaughtException` hook is diagnostic and suppresses Node's
  default fatal exit; letting publication throw into it creates an undiscoverable orphan host.
  Only `ENOENT` means an ownership file is absent. Unreadable, directory, malformed, and empty-token
  observations fail closed without reclaiming or launching a competing host. The client also
  requires the state file's exact protocol version before hello; because the host outlives app
  upgrades, silently connecting a version-2 client to a version-1 host would lose atomic pause and
  geometry restoration.

The spawned program follows the same resolver as a direct local PTY. With no explicit program and
an empty `settings.defaultShell`, Windows selects PowerShell 7, then built-in Windows PowerShell,
then `COMSPEC`/`cmd.exe`; the host must never substitute POSIX-only `bash` there.

## Auth — bearer token, never on argv

`crypto.randomBytes(32)` generated at host start, written to `<userData>/session-host.token` with
mode `0600`, read by every client before its first request and sent in a `hello` frame. Every
other request is refused (`unauthorized`, socket closed) until `hello` succeeds.

**This repository has a measured security incident from putting a bearer token on a command
line** (`docs/node-identity.md` — a hook bearer landed in a long-lived tmux client's
`/proc/<pid>/cmdline` at mode 444, readable by anyone on the box). The session host repeats none
of that shape: the token is never an argv element anywhere (the host is launched with only
`<scriptPath> <userDataDir>` — nothing sensitive), never an environment variable a `ps`/Task
Manager listing could expose, and never logged (`host.ts`'s own diagnostic log never includes it).

**Honest limitation on the transport itself:** the endpoint is a Windows named pipe / POSIX unix
socket. Node's default pipe/socket creation does not carry an explicit, verified per-user ACL in
this implementation — the bearer-token check is the load-bearing access control, not the
transport's own permissions, exactly as the task's instructions require ("Refuse any connection
whose hello token does not match, and close it" is implemented; a separately audited pipe DACL is
not). A local unprivileged process that can guess/observe the token could still connect; guessing
a 256-bit random hex token is not feasible, and observing it requires filesystem access to a
0600-mode file this app's own user account owns — the same trust boundary every other secret this
app already keeps at rest (accounts, hook tokens) relies on.

## Memory bound

Each `HostSession` holds one `@xterm/headless` `Terminal` with `scrollback` capped at
`settings.tmuxScrollback` (default 50,000 lines) — the exact same setting that already bounds real
tmux's `history-limit`, so a machine that already accepted the cost of N tmux panes accepts the
same order of cost for N session-host sessions. The per-session cost is a cell buffer sized
`cols × (rows + scrollback)`, plus `SerializeAddon`'s own transient string-building cost only at
the moment `serialize()` is actually called (attach, join, periodic snapshot, capture request) —
never held continuously. This is a genuinely new per-session cost the tmux backend does not pay
(tmux's server keeps its own C-side pane buffer regardless, but that cost is outside this app's
process); it was a deliberate choice per the task brief ("bound the memory... document the cost
you chose and why") rather than an oversight.

## Honest limitations

- **If the session-host process dies, or the machine reboots, its sessions die with it.** This is
  a strictly weaker guarantee than a real tmux server, which is a mature, independently-shipped C
  daemon this project does not maintain. The existing **cold-restore path** (persisted scrollback
  snapshot + agent `--resume`) already exists for exactly the "machine rebooted" case and applies
  here unchanged: `spawnNew()` correctly reports `fresh: true` when a fresh host has no record of
  a previously-running session, which is what triggers the renderer's cold-start replay
  (`attachReplay` → `'cold-snapshot'`) and the agent CLI's `--resume`. The periodic scrollback
  snapshot (`snapshotScrollback`) runs for session-host-backed sessions on the same 15-second timer
  as the tmux path, using the same on-disk format (`scrollback-store.ts` is entirely
  backend-agnostic — no changes needed there at all).
- **A WSL profile does not turn its distribution's tmux into the Windows backend.** nodeterm
  launches that distribution's default shell through `wsl.exe`, and the Windows session host owns
  the resulting process. A genuinely Windows-reachable tmux found by the existing resolver still
  follows the tmux path; a `tmux` installed only inside WSL is not on the native Windows PATH.
- **`paneCommand`'s answer can be imprecise** when a session has multiple concurrent child
  processes (an agent CLI plus MCP servers) — see `process-tree.ts`'s doc comment. The one caller
  that depends on it (in-place agent restart) only needs "is a shell back in charge of this pane
  yet", which every non-shell answer satisfies equally, so this imprecision is harmless for that
  caller specifically; a future caller with finer-grained needs should not assume more precision
  than this.
- **The node-pty actuator is global, so ownership is ledgered rather than guessed.** Within one app
  process, `pty-manager.ts` keeps a per-viewer/owner `pausedBy` ledger. The standalone host then
  keeps a second set keyed by authenticated socket: the first socket to pause actuates node-pty,
  an unrelated socket's resume is a no-op, and only the last owner leaving/resuming actuates
  resume. `detach` and transport `close` return that socket's ticket. This cannot give two
  connections independent output streams (node-pty has one read side), but it preserves the
  necessary slowest-viewer semantics and, critically, a crashed viewer can no longer freeze the
  live session for every healthy viewer forever.
- **Windows named-pipe/unix-socket ACL is not independently audited** — see "Auth" above; the
  bearer token is the enforced boundary.
- **No equivalent of `paneOwner` / `bracketPasteRequested` / a standalone `paneCursor` query** —
  see the protocol table's "Not implemented" note. Nothing in this app currently calls these for a
  session-host-backed node (they are gated behind `this.tmuxPath` being set), so nothing is
  silently broken; a future feature that wants one of these on Windows needs a new host verb.
- **ConPTY helper teardown can emit `Error: AttachConsole failed`** from
  `node-pty/lib/conpty_console_list_agent.js`. The protocol test determines kill success from the
  host response and follow-up session state rather than stderr text. Whether this cosmetic
  dependency message appears in the packaged app remains part of the pending artifact run.

## Automated verification

### Direct ConPTY agent messages (separate from the persistent host)

The desktop can also hold a **non-persistent native PTY**, indexed by canvas node id but
without `Session.persistKey`. Checking only persisted sessions incorrectly returned `targetGone`
for such a running OpenCode. `hasLiveSession` now uses the common runtime lookup.

`core/native-windows-pane.ts` implements message delivery for those direct PTYs. It uses a
headless terminal for observed bracketed-paste mode and capture, and reads native executable
identity through console membership and an unambiguous shell-child chain. Process birth times
and a generation id detect replacement/PID reuse. It deliberately does not choose an arbitrary
deepest descendant, interpret prompt text as an executable, or accept a detached console.
This Windows ownership evidence is not POSIX foreground-group semantics; ambiguous console
trees refuse. An interpreter is identified by its script: the probe keeps only the first
positional argument (`CommandLineToArgvW`, inside PowerShell) and `scriptCommandName` resolves it
to the command its npm package publishes in `bin`, else to the script basename. Measured on
Windows 11 (2026-09-14) against a live Codex pane opened from the canvas: the PR-era probe read
`node` and the installed app refused `send` with `targetNotAgentPane (observed: node)`, while the
new probe read `codex` (`agent`) from the same console. A fake npm package in a separate console
confirmed the prompt argument never appears in the probe output. The
interpreter is the leaf; its children (a native `codex.exe`, MCP servers) do not count. Existing project consent, verified idle hooks,
delivery locks, post-write verification and receipt tracking remain in force.

The persistent host has a separate, additive messaging extension (`messageOwnerV1`,
`messagePasteReadyV1`, `messageEnvelopeV1`). `session-host/message-pane.ts` observes the OS console
under the **host's** session generation and reads the host's existing emulator after its output
barrier. Before sending, it repeats the identity probe, checks paste mode again, and confirms
that the same session object is still registered after every await. It then writes one sanitized
multiline bracketed paste, watches its own emulator until the envelope footer renders, and sends
Enter as a second write, only while the same generation is still registered
(`core/settled-submit.ts`, shared with the Server Edition). With the Enter inside the paste write,
Codex 0.154 left the envelope unsent in its composer and the delivery reported `stalled`. Main still owns the project/consent/hook/binary
and receipt gates. The direct adapter is never used for host-backed sessions.

A host-backed session stays addressable after the desktop releases its client (park expiry,
offscreen release). `targetLive` comes from `PtyManager.sessionExists`, and the three messaging
probes route by `sessionHostOwns`, which reads the release record when no `Session` is left and
otherwise applies `sendText`'s rule (no local tmux means the host owns persistence).

The extension is independently versioned so the existing terminal protocol v1/v2 is unchanged.
Old live hosts reject the new command names, and the client returns null/false without falling
back to `write`, `sendKeys`, or a local tmux. **Installing a new app does not upgrade an already
running host.** It must retire after its existing sessions have ended, at a user-coordinated time;
the next host starts from the new bundle. Never terminate a user's live host as an upgrade step.
There is no hot migration of an existing ConPTY generation to another host.

`scripts/smoke-session-host-messaging.ts` exercises a separate real Windows host over its named
pipe, using a native fake reader (no model/API call): OS identity, probe latency within the 2 s
budget, exact multiline framing, stale-generation refusal, and retirement of the isolated fixture.
This proves the transport extension, not message/reply delivery between actual OpenCode agents.

Installed-device acceptance (2026-09-13, local build `0.3.5-windows-messaging.2`): after each
resumed OpenCode posted a fresh verified status, the coordinator's native messages reached both
architect and coder; their `NT2-ARQ-OK` / `NT2-CODER-OK` replies arrived as native message
envelopes in the coordinator transcript. Board-log traces confirmed delivery in both directions,
including queued replies delivered after the coordinator became idle. These resumed sessions
were **direct Windows PTYs** (their shell processes were children of the desktop main process);
the old persistent host was no longer running. This acceptance therefore proves the installed
message workflow on that backend, while the persistent extension remains covered by the separate
real-host fixture above, not by a claim that these OpenCodes ran inside it.

Desktop message dispatch also waits for pending canvas publication before asking main to authorize
the pair. Without it, a newly opened node can appear in `list` and context links but be absent
from main's persisted project snapshot, whose scope resolver labels it `cross-project`. A file
conflict blocks that publication; it is never silently answered as Keep mine. Server control
already persists its creations; mobile is not a sender of these agent messages.

`scripts/smoke-windows-agent-messaging.ts` tests a real isolated ConPTY with a native reader:
console identity, one multiline bracketed paste, and refusal after disposal. It makes no LLM
call. The installed-app message/reply check with actual OpenCode agents is a separate acceptance.

`scripts/sim-agent-messaging-windows.ts` runs the coordinator ↔ architect ↔ coder scenario end to
end against an isolated real host, with the real mirror, decider, `deliverFromControl`, queue and
receipt watch; only the agent CLIs (paste-aware fake composers) and the hook transport are
simulated. Measured 2026-09-15: three rounds of send/reply pass, including busy targets queued
and flushed on idle, and a verified `SessionStart` + `idle_prompt` committing a verified idle
without a turn. Two findings it pins: after an app restart an idle agent whose CLI emits no hook
stays `targetStatusStale` on every retry (whether real Claude emits one there is not measured);
and against a reader that drains input every 150 ms, the `sendKeys` plan (paste, then an
immediate Enter write) had its Enter swallowed into the paste while the settled envelope
submitted.
OpenCode transcript export on Windows is not part of this change: it runs the resolved npm shim
through `directExecutableInvocation` (`opencodeExportAt`, #655).

The focused suites exercise behaviour rather than scan implementation source:

- the Windows profile resolver covers detection precedence, standard Git Bash locations, custom
  absolute paths containing spaces, `%COMSPEC%`, unavailable executables, malformed ids, WSL
  UTF-16/NUL output, distribution names containing spaces, and cwd-conversion failures;
- resolver/spawn tests assert that `node-pty` and session-host creation receive only the trusted
  launch plan, and that explicit unavailable profiles perform no fallback spawn;
- `pty-session-host.test.ts` exercises successful creation plus provisional/rejected attach
  teardown, coalesced callers, late events, and the persistent result;
- `session-host-client.test.ts` uses real local sockets to exercise the hello transition,
  correlated responses, failed-subscriber rollback, reconnect replay, and transport uncertainty;
  and
- workspace/node-exec tests prove `terminalProfileId` never enters shared/exported/inbound state
  and that the local overlay survives reload.

The guards were mutation-checked by temporarily accepting a hostile profile, allowing a missing
WSL distribution to fall back, and removing machine-local stripping; each corresponding focused
test must turn red. The former source-text shell regression test is intentionally gone.

The original session-host implementation was also verified by hand against a real ConPTY session.
The ordering, connection-owned pause ledger, no-tmux relay probe/capture, platform shell selection,
and atomic state publication are now additionally behaviour-tested with adversarial scheduling and
injected sharing violations. That source/runtime evidence does not replace the packaged check.

## Packaged verification still owed

The real Windows x64 installer must still be exercised through the required cheap headless route:
create every available profile, verify input/output/resize/Unicode/copy/cwd and labels, relaunch
around a long-running process, switch a node through the destructive profile warning, and record
the picker, profile terminal, unavailable state, and post-relaunch reattachment. Until that built
artifact evidence exists, this document makes no claim that the full packaged verification has
completed.

`paneOwner`, `bracketPasteRequested`, the standalone `paneCursor` query, and independently audited
Windows named-pipe DACL hardening remain outside this profile pass as described under
"Honest limitations".

## What was deliberately not done

- The original implementation was verified by hand against a real ConPTY session. The ordering,
  connection-owned pause ledger, no-tmux relay probe/capture, platform shell selection and atomic
  state publication are now additionally behavior-tested with adversarial scheduling and injected
  sharing violations. A packaged installer launch on a separate Windows device is still owed (see
  `docs/windows-support.md`); these tests do not pretend to replace that device check.
- `paneOwner`, `bracketPasteRequested`, and a standalone `paneCursor` query were not ported — see
  "Honest limitations".
- Windows named-pipe DACL hardening beyond Node's own defaults was not attempted — the bearer
  token is the enforced boundary, documented as such rather than silently assumed to be perfect.
- The relay host's `createDetached`/`attachDetached` paths were left to fall through to
  `spawnSession()`'s new branch automatically (they call it directly with no prior async
  pre-check), so they work, but were not separately hand-verified end-to-end through the relay
  feature itself in this pass — only the primary create/join/reconnect/capture/kill paths were.

### Non-message delivery result (#780)

New callers use additive `sendKeysV2`, returning `result.delivery`: `true` for completed
requested writes, `false` before input, or `pasted-not-submitted` when paste landed but the
settle/mode/generation checks withheld Enter, or a transmitted request lost its reply.
The latter case is uncertain: neither paste nor submission is claimed confirmed. The last result is terminal for automatic
delivery: inspect the terminal, do not resend or blindly press Enter. Canvas write, trigger
run history, and one-way UI writers surface it. An older host refuses this command and keeps
its sessions; there is no fallback to `sendKeys`, raw input, or automatic restart. Legacy
clients retain their existing `sendKeys` wire contract. No real Windows TUI measurement is
claimed by the fake-PTY regression fixtures.

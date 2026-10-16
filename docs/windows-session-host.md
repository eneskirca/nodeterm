# Windows session host

**What this is:** a tmux-equivalent session-persistence backend for Windows (and any other
platform where a real `tmux` cannot be found), so closing the app — or the app crashing — no
longer kills every running terminal and every agent CLI mid-task. It is a standalone,
long-lived Node process that owns the real PTYs and outlives the Electron app.

This document describes the Windows desktop implementation. It does not embed Microsoft Windows
Terminal, and it does not change the Server Edition or mobile companion.

Selected automatically, per session, in this order:

```
Windows + tmuxEnabled            →  session host (this document)
POSIX + real tmux found          →  tmux (unchanged)
POSIX + no tmux, tmuxEnabled     →  session host (this document)
tmuxEnabled off                 →  plain shell (no persistence)
```

Stock Windows provides no native tmux, and Windows tmux-compatible binaries do not implement the
Unix tmux control and console semantics this application relies on. The session host is therefore
the authoritative Windows persistence backend even when a `tmux.exe` appears on `PATH`. On
macOS/Linux nothing changes: a real tmux installation remains preferred there.

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

### Agent launches in a Windows-native shell (`pty:execute-launch`)

The renderer's agent launch line is POSIX source (`'it'\''s'`, `"$(cat '<file>')"`). PowerShell
breaks on the apostrophe, Windows PowerShell 5.1 drops embedded double quotes before the CLI sees
them, and cmd.exe splits a single-quoted prompt into separate arguments. So a prompt-bearing
builtin agent node also carries a semantic `data.launchIntent` (`shared/agents/launch-intent.ts`),
bound to its exact typed line and never serialized. When the launch writer is about to type that
line into a **local session-host pane on a win32 core**, it calls `pty:execute-launch` instead
(`renderer/terminal/launch-intent.ts` → `core/launch-intent-execute.ts`): the core resolves the
agent executable against the session's spawn PATH (native image, then `.ps1`; a `.cmd`-only
install is refused), reads a `--prompt-file` itself (whitespace flattened to one argument, exactly
what `"$(cat …)"` yields in PowerShell), encodes argv for the dialect the HOST recorded for that
generation (`launchDialect` on the attach result; set at spawn only for `pwsh`/`powershell`/`cmd`),
and delivers through the host's exactly-once launch ledger.

Rules that keep this safe:
- Every other pane (tmux, SSH, Zellij, plain shell, Git Bash/WSL, any POSIX core) answers
  `unsupported-shell` before anything is read, and the typed line is used, byte-identical.
- A refusal made before the host is asked falls back to the typed line; `delivery-failed` (or a
  lost reply) does NOT — the launch stays held for an explicit Run now, never typed twice.
- Excluded from the intent (legacy line only): resumes, custom agents, launch-command overrides,
  per-node models, SSH nodes. A resume line holds only flag words and a validated id.
- `pty:execute-launch` is host-only for relay peers (`shared/host-control.ts`).

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
| `writeDetachedV1`                | `send-keys -H` into a released session (no client) | full — additive; an older host answers `unknown command` and the write fails closed (never re-sent as `sendKeys`) |
| `terminateOwnerV1`               | `kill -TERM -<foreground pgid>`         | Windows shape — `taskkill /T /F` on the re-proven agent pid, never the console root (see below) |
| `resize`                         | ConPTY/pty resize + `refresh-client -C` | full; each view claims a size, the app's grid follows its most recently active view (issue #914) |
| `pause` / `resume`               | node-pty `pause()`/`resume()`           | full; per-viewer in core and per-connection in the host (first pause / last resume) |
| `sendKeys`                       | `send-keys -l -- <text>` (+ `Enter`)    | full — works with no attached client, exactly like tmux |
| `paneCommand`                    | `display-message -p '#{pane_current_command}'` | approximated — see `process-tree.ts` |
| `capture`                        | `capture-pane -p -e [-S -N]`            | full, and strictly more (mode restoration — tmux's plain-text capture carries none) |
| `paneModesV1`                    | (none — tmux owns the mouse itself)     | additive: the pane app's mouse-tracking protocol, for relay scroll routing; an older host answers `unknown command` = "no mouse" |
| `killSession`                    | `kill-session -t <name>`                | full |
| `detach`                         | a client's own `tmux detach-client`     | full |
| `listSessions`                   | `list-sessions -F '#{session_name}'` — plus, with `sessionDetails`, `list-windows`/`list-panes` | full; see "Observability" below |
| `ping`                           | (liveness probe used during the startup race) | full |
| `attachExisting {watch: true}`   | `attach-session -E -f ignore-size,read-only` (a live link watcher's client) | feature `watch-attach`: subscribes with NO geometry claim and no pause ticket, refuses `write`/`resize` from that connection, never spawns; on an already-attached connection it withdraws the claim (its last voting subscriber left) |
| `captureVisible`                 | `capture-pane -p -e` + `display-message '#{cursor_x} #{cursor_y}'` | feature `captureVisible`: visible rows of the ACTIVE buffer only (never history), viewport cursor, `altScreen` — a live link's keyframe |
| `paneCwd`                        | `display-message -p '#{pane_current_path}'` | feature `paneCwd`: the cwd the pane last REPORTED (OSC 7 / 9;9 / 633, parsed by `cwd-report.ts`), null until one arrives — never the spawn cwd |

The last three are **negotiated at hello** (`SESSION_HOST_FEATURES`) like `geometry`/`shutdown`: the
client never sends one to a host that did not advertise it (an older, long-lived host keeps serving
everything else and is never replaced for them). Without them: a live link viewer of a node this app
does not hold is refused (`join-only`), there is no keyframe (R36), and `paneCwd` is null.

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
  `sendKeys`/`paneCommand`/`capture` rows above: none of them need an attached client. A raw
  background write to a RELEASED node (`PtyManager.backgroundWrite`, the tier tmux serves through a
  shadow) uses `writeDetachedV1`: verbatim bytes, addressed by name, no attachment. It is not gated
  on `ptyShadowClients` (that switch governs `tmux -C` children) and is never retried — a lost
  reply may still have typed.

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

## Staged host runtime (issue #829, step 3)

A host launched as a hard link of `nodeterm.exe` inside the install directory maps the installed
executable, its DLLs and `resources.pak`, so the installer cannot replace them while it runs. On
macOS/Linux the sessions live in tmux, a separate binary, and survive an update; the staged runtime
gives Windows the same property.

**What happens.** In a packaged Windows build, before the app spawns a host it stages
(`src/core/session-host-runtime.ts`) a private copy of the runtime into

    %LOCALAPPDATA%\nodeterm\session-host\<app version>-<fingerprint>\
        nodeterm-sessionhost-v2.exe          (nodeterm.exe, renamed)
        *.dll, icudtl.dat, resources.pak, snapshot_blob.bin, v8_context_snapshot.bin, locales\
        resources\session-host\host.cjs + node_modules\node-pty\…
        nodeterm-runtime.json                (marker: file list, sizes, SHA-256)

and launches the host from there. The fingerprint hashes every source file's path, size and mtime,
so a reinstall of the same version with different bytes gets its own directory. `app.asar` is not
copied (the host never reads it).

**The file set is not measured.** It was written on Linux and is the conservative set an
`ELECTRON_RUN_AS_NODE` process can plausibly touch: `icudtl.dat` is required (Node's ICU data);
`resources.pak` was measured open by a running host in #829; the DLLs cover load-time and delayed
imports; `locales\` covers resource-bundle initialisation. The per-machine proof is the smoke run
below. Device checklist item 1 measures the real set so it can be pruned.

**Never a half-staged directory.** Files are copied into `.staging-<uuid>` beside the target, each
copy is re-read and compared by SHA-256 to what was read from the install directory, and the copy is
smoke-run once: `nodeterm-sessionhost-v2.exe -e …` with `ELECTRON_RUN_AS_NODE=1` must load,
`require` its own node-pty and exit `42`. Only then is the marker written, and the directory is
published by one `renameAtomic`. A directory without a valid marker (or whose files no longer have
their recorded sizes) is moved aside and restaged, never launched. Two app processes staging the
same version at once both succeed: the second rename loses and adopts the first one's directory.

**A new image name.** Uninstallers already in the field match `nodeterm.exe` and
`nodeterm-session-host.exe` machine-wide by name; the staged host runs as
`nodeterm-sessionhost-v2.exe` so none of them mistakes it for something that blocks them.

**Fail-safe.** Every staging failure (no `%LOCALAPPDATA%`, a missing required file, disk full, a
failed hash, a smoke run that does not answer 42 within 60 s — STATUS_DLL_NOT_FOUND, an AppLocker or
WDAC policy blocking executables under the profile) falls back to the legacy launch: the hard link
in the install directory, then `nodeterm.exe` itself. A staged host that dies within 10 s with an
exit code other than the host's own `0`/`1` also falls back, and staging is not offered again for
the rest of the app run. The legacy host still blocks the installer, so the preflight below still
protects the install. The first launch of a new version waits at most 45 s for staging (copy,
hashing, smoke run; usually a few seconds, longer behind an antivirus scan); past that the host is
launched the legacy way and the finished copy serves the next launch. Staging progress and failures
are appended to `<userData>\session-host.log` with an `[app]` tag.

**Old copies.** After staging, copies other than the current one are collected — fail-closed: only
when a Win32_Process query SUCCEEDS, no `nodeterm-sessionhost-v2.exe` process has an unreadable
path, nothing runs from under that directory, the directory is older than 10 minutes, and renaming
it aside succeeds (Windows refuses while an image inside is mapped). A failed query deletes nothing.
A host started by an older version therefore keeps its copy for as long as it runs; once it exits
(30 s after its last session), the next app launch removes that copy. Disk use: about 250 MB per
version, normally one or two versions.

**Versions talk to each other.** There is one host per user-data directory, whichever runtime
started it. A newer app connects to a host started by an older staged runtime through the existing
negotiation: the state file's protocol version (v1 or v2 accepted) and the `hello` feature list
(`SESSION_HOST_FEATURES`, e.g. `geometry`). New sessions go to that host as long as it is
compatible; it exits by itself once it empties, and the next host is launched from the current
version's copy. The rule for every future change: **the host protocol is additive-only** — a new
command or push frame is negotiated at `hello`, never assumed. An operation an older host cannot
perform is refused with `SessionHostProtocolCompatibilityError`, which tells the user why. A host
whose protocol version the app does not accept at all is left running and the connect fails with
that reason — an app never kills a host to replace it.

**Not covered.** A dev checkout (`electron-vite dev`) and an asar-resolved bundle keep the legacy
launch. Server Edition and macOS/Linux are unaffected (tmux).

## Windows updates and uninstalls

A host launched the legacy way (a hard link inside the install directory, or `nodeterm.exe` itself)
maps the installed Electron executable and its DLLs. Its separate hard-link name makes it
identifiable; it does **not** make the install directory safe to replace. Closing the app alone
deliberately leaves the host and its sessions running (#829). A host running from its staged
runtime (above) maps nothing in the install directory and does not block an update or an
uninstall: the preflight matches it neither by name nor by path, and the old version's uninstaller
does not know its name. Updating from a version that predates the staged runtime still meets that
version's legacy host once.

The uninstaller leaves `%LOCALAPPDATA%\nodeterm\session-host` in place, because a staged host may
still be running from it and the uninstaller never stops a host. `docs/uninstall.md` says how to
remove it afterwards.

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

**The in-app way (nodeterm with the `shutdown` host feature):** open the command palette
(Ctrl+K) → **Prepare for update…**, or the button on the update card. When the running host is the
staged copy, the dialog leads with **Quit nodeterm (sessions keep running)** — quit, including from
the system tray, then run the installer; **Stop all sessions instead…** is the secondary path. A
host whose location cannot be determined is treated as blocking. Otherwise it:

1. lists every session the host holds — every project, closed ones too — and waits while any agent
   is working or waiting for your answer (each listed with a **Go** button; **Check again** when
   it is done);
2. asks each idle agent whose terminal is open on the canvas to exit normally (`/exit`, `/quit`;
   Gemini's bare `/quit`, never `--delete`) so its conversation is saved, and reports any that did
   not;
3. shows what will still stop — shells and anything running in them (unsaved work there is lost),
   agents it could not exit — and asks you to confirm (Cancel is the default);
4. sends the host its `shutdown` command: the host ends every session with its ordinary kill path,
   replies, removes its state files and exits. nodeterm confirms the process is gone, then quits
   (optionally opening the download page).

Canvas nodes are kept; on the next launch every terminal cold-starts and agents resume with
`--resume` where their CLI and saved history allow. If the host cannot end a session it says which
and keeps running — nothing is quit. A host started by an older nodeterm does not have the
command; the dialog then shows the manual steps below. nodeterm never kills the host process
itself. The installer's own refusal is unchanged.

To update by hand (older host, or the in-app flow did not finish), while keeping your saved canvas:

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
This is a safe refusal and manual recovery path, not live host migration. A **staged** host
(0.4.1 and later, running from `%LOCALAPPDATA%\nodeterm\session-host`) maps none of the installed
files, so it does not block the installer and its sessions survive the update — quitting nodeterm
(from the tray too) is enough; device-verified across 0.4.1 → 0.4.2 → 0.4.3 in #829, all sessions
reattached warm. Only a legacy hard-link host inside the installation must be stopped first. A
process could still start after the preflight; it is not an installation-wide launch lock.

Unattended runs (silent, or the app's own `--updated` handoff) wait up to about 30 seconds for
nodeterm to finish exiting before refusing; "could not verify" (exit 20) still refuses at once. If
an `--updated` install still finds nodeterm running, it writes
`%LOCALAPPDATA%\nodeterm\update-failed.json`, restarts the installed version, and quits; the app
logs the failure on its next start.

Server Edition has no NSIS updater and is unchanged. Mobile/relay clients must expect a disconnect
when the user deliberately ends desktop sessions; they cannot authorize an update shutdown.
Real Windows per-user/all-users upgrades, old uninstallers, PowerShell policy variations, and
phone reconnection still require device verification (fixtures do not prove file-lock behavior).

## Lifetime

Mirrors tmux's server lifetime rule as closely as a different OS allows:

- **Spawned detached, unref'd, `stdio: 'ignore'`, `windowsHide: true`**
  (`session-host-launcher.ts`) — survives the spawning app process exiting entirely.
- In a packaged Windows build the binary is the **staged runtime's**
  `nodeterm-sessionhost-v2.exe` outside the install directory (see "Staged host runtime"), so a
  host also outlives an update of the app; the legacy hard link is the fallback.
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

Each `HostSession` holds one `@xterm/headless` `Terminal` whose `scrollback` is
`xtermScrollback(settings.tmuxScrollback)` — floored at 1,000 and **capped at 10,000 lines**
(`src/shared/scrollback.ts`), the same clamp as the renderer's own xterm. Core sends the clamped
value, and the host clamps again at the `attach` request boundary (`clampEmulatorScrollback`) so an
older client still sending the raw 50,000 is bounded too; the clamp runs before both the
replacement-replay fingerprint and construction, so a replay of the same request still matches.
The main-process `NativeWindowsPane` mirror (non-persisted win32 panes) uses the same clamp.

Why not reuse tmux's `history-limit` (default 50,000): the costs are not the same order. tmux
stores only the cells a line actually uses, in C. xterm's `BufferLine` is a `Uint32Array(cols × 3)`
— **12 B per cell for every buffered line, whatever it holds** — so a 120-column session that fills
50,000 lines holds ~72 MB of ArrayBuffer (measured ~91 MB with heap overhead; ~139 MB at 200 cols)
inside the one shared host process, against ~14–18 MB at 10,000. And lines past the renderer's
10,000 were never reachable: on this backend the renderer's xterm is the only surface a user
scrolls, yet every warm attach serialized the full history, shipped it over the pipe and IPC, and
the receiving xterm discarded 80% of it (measured: 50k lines → 5.4 MB string built synchronously in
~0.7 s, stalling every session's output; 10k → 1.1 MB in ~0.13 s). Capping the emulator bounds that
attach seed, the co-attach resync and `capture`'s `full: true` by construction — no protocol field
was needed.

Not reclaimed in place: a session that an OLDER host created at 50,000 keeps that buffer until it
ends — installing a new app does not upgrade a running host (see below), and an old host cannot be
told to shrink. Lowering the setting likewise applies to new sessions only. Beyond the emulator,
the remaining per-session cost is `SerializeAddon`'s transient string at the moment `serialize()`
runs (attach, join, periodic snapshot, capture request) — never held continuously.

Device check owed (not blocking): host RSS with 10–20 busy normal-screen sessions, before and after.

A DETACHED session's cost is bounded by the same session budget tmux sessions are
(`core/session-budget.ts`): past the grace window, under memory pressure or past the detached-count
cap, the reaper ends it through the host's generation-checked kill — see "Observability" above.

### Observability (`sessionDetails`): reaper, session-memory panel, dev-server ports

The three surfaces that ask tmux about its sessions — the session reaper (`list-windows` for
`session_attached` + `window_activity`), the session-memory panel and dev-server ports
(`list-panes` for `pane_pid`) — ask the host instead, through ONE additive hello feature,
`sessionDetails`. A connection that negotiated it gets, beside the unchanged `names`, a row per
LIVE generation: `{name, pid, subscribers, lastOutputMs, createdMs, generation}`
(`ListSessionsResult.sessions`). An older client never asks and reads `{names}` byte-for-byte; an
older host never answers, and the client reports `sessions: null` — named but undescribed.

- **`lastOutputMs` is the honest idleness clock** (tmux's `window_activity`, not its
  `session_activity`): stamped on every pty `data` callback, moved by nothing that only LOOKS —
  attach, detach, capture (`session-details-host.test.ts` pins both directions against the real
  bundled host).
- **`subscribers` needs no `shadowed` subtraction**: the host has no control-mode shadows (a
  background `sendKeys` needs no subscription), so every subscriber is a viewer. The reaper backend
  (`PtyManager.sessionHostReaperBackend`) instead ADDS one for a node this process holds a live
  session for — a host reconnect briefly reports zero subscribers for a terminal on screen.
- **The read never launches a host** (`listSessionsDetailed`), and a failed read is `null` — never
  an empty listing. Absent state is "no host"; PUBLISHED state is not proof of a live one (a host
  killed from Task Manager, a reboot), so a cold client connects with `ensureConnected({launch:
  false})` and nothing answering is a failed read — the ordinary `request()` path would otherwise
  start a fresh host from every poll. The reaper then plans nothing, the memory panel
  says "could not measure", dev ports say `unreachable`.
- **A reap kills exactly the generation the listing observed** (`killSession`'s
  `expectedGeneration`), never by name alone, and nothing else: no scrollback deletion, no
  tombstone. The client refuses such a kill for a name it is attached to, PtyManager re-asks
  "do we watch this node?" at kill time, and a successful observed-generation kill never clears a
  live local attachment (the host answers success for an already-gone generation, which may mean a
  same-name successor is the one attached). A reaped node cold-restores (`fresh: true`), the same contract as a tmux reap. The
  reaper's budget, triggers and kill-time re-verify are `session-budget.ts`'s, unchanged; the
  memory reading on Windows is `os.freemem()`, which there is the OS's available physical memory.
- **Memory panel**: each row's pid is rolled up over the Windows process table
  (`Get-CimInstance Win32_Process`, `WorkingSetSize`, one `powershell.exe -NoProfile` per panel
  open — never polled; always the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0` path,
  `powershellExe()`, because Windows resolves a bare name against the cwd first). Sessions an older host cannot describe are `unmeasured`, with their own
  sentence. No host running is "no sessions", not a failure.
- **The host's own cost** (`SessionMemoryReport.host`, `hostOverhead` in `core/session-memory.ts`):
  rows roll up from each pane's SHELL, and ConPTY's conhost/OpenConsole is the host's child (the
  shell's sibling), so neither it nor the host process itself — every session's headless emulator,
  node-pty's per-session conout worker thread — was in any row. The listing now carries the host pid
  from the state file (`SessionHostListing.hostPid`; every host version writes it, so no protocol
  change), and the panel shows one non-killable line, `nodeterm session host (N consoles)`, added to
  the total only under the `measured` gate. Both figures are MEASURED working sets, labelled as
  such; nothing is estimated. Every non-shell child is included, so while the host's pane-probe
  PowerShell worker (below) is warm — up to 60 s after a probe — its working set is part of the line
  too; it is genuinely the host's cost, but expect the line to drop when it idles out. Unknown host pid, a pid missing from the table, or an undescribed
  session (whose shell would be booked as host overhead) ⇒ no line, never `0 B`. An idle host with no
  session is still measured.
- **Dev-server ports**: one PowerShell call per scan — `Win32_Process` plus
  `Get-NetTCPConnection` (owning pid is a kernel field, nothing a process can rename itself into),
  falling back to `netstat -ano` (listeners recognised by a foreign port of 0, because the state
  column is localized). A non-zero exit is `unreachable`; with no nt- session nothing is spawned.

### Pane probes: one long-lived PowerShell per process

`paneCommand` (restart/Eco exit poll, agent liveness, launch readiness) and the console-owner probe
(`readWindowsConsoleOwner` — messaging, Eco's owner read, `terminateOwnerV1`) used to start a fresh
`powershell.exe` per call; the owner probe also re-ran `Add-Type` (csc + a temp assembly on PS 5.1)
every time. Both now go through `session-host/windows-probe-worker.ts`: one lazy child per process
(the host's, or main's for a direct Windows PTY) that compiles the type ONCE and answers JSON-line
requests FIFO. Rules a refactor must keep:

- **Fallback, not replacement.** `unavailable` (could not start, timed out, died, garbage) falls
  back to the original one-shot script; `failed` (the worker ran the probe and it failed) is a
  real answer and is not retried. Two consecutive transport failures bench the worker for 5 min —
  never a respawn loop. Deadlines: 6 s for the first request after a spawn (startup + compile),
  1.5 s warm. Idle exit after 60 s; stdin closing ends the loop, so it dies with its parent.
- **The worker holds its own stdio first** (`OpenStandardInput/Output` before any probe), because
  the probe `FreeConsole`/`AttachConsole`s. Unverified on a device — checklist item P1 below.
- **Table reads are coalesced in flight, never cached by time** (`createProcessTableReader`). The
  exit poll accepts a changed reading only on two CONSECUTIVE polls; a cached snapshot answering
  both would confirm a momentary child of a still-running CLI from ONE observation and type the
  resume line into a live agent.
- **Every one-shot path is the absolute `%SystemRoot%` PowerShell** (`powershellExe()`), never a
  bare name.
- **A slow read still gets its samples.** The exit phase owes a pane that keeps answering at least
  `RESTART_MIN_EXIT_SAMPLES` (4) readings, each with `max(window left, timeoutMs/2)`, so a cold
  ~1.5 s read cannot turn a CLI that quit at 8 s into a false `exit-timeout` (inert on tmux).

### node-pty's conout worker thread (documented, not changed)

node-pty 1.1.0 starts one `worker_threads` Worker (a full V8 isolate) per ConPTY
(`lib/windowsConoutConnection.js`), measured on plain Node at ~11–12 MB RSS each idle (10 workers
+118 MB, 30 workers +349 MB); under `ELECTRON_RUN_AS_NODE` it is probably a little more. It is
node-pty's design for keeping conout reads off the main thread (a `ClosePseudoConsole` must never
block on an undrained pipe), and we pin and patch exactly 1.1.0, so we do not remove it. It is now
VISIBLE — it is inside the session-host line of the memory panel — and the lever on our side is
session count (offscreen release, Eco, the reaper for detached sessions). Sharing one conout worker
via `scripts/patch-node-pty.mjs` is worth doing only if a device shows ≥ ~8 MB per session: item P4.

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
  processes (an agent CLI plus MCP servers) — see `process-tree.ts`'s doc comment. Its callers
  (in-place agent restart, wake, trigger delivery, RunBar, session rename) only need "is a shell
  back in charge of this pane yet", so the walk answers a SHELL name only when every live process in
  the tree is a shell; otherwise it answers a non-shell. This matters since `isShellCommand`
  recognises `pwsh.exe` / `cmd.exe` / `bash.exe`: a shell that is merely a leaf under a running agent
  (claude's Bash/PowerShell tool, an MCP server launched via `cmd /c npx`) must not read as "the CLI
  let go". A future caller with finer-grained needs should not assume more precision than this.
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
- **`paneCwd` only knows what the shell reports.** pwsh, Windows PowerShell and cmd report nothing
  by default (no OSC 7 / 9;9), so a plain Windows shell's relative file links still resolve against
  the launch cwd only; agent CLIs and shell integrations that emit OSC 7 / 9;9 / 633 work. No prompt
  hook is installed for them (it would rewrite the user's prompt); an opt-in one is a follow-up.
- **Control typing into a session-host node needs the node open when the viewer joins**: a viewer
  of a node nobody holds rides a read-only `watch-attach` attachment, which has no typing path (the
  host refuses its writes, and keys must not be retyped as a framed `sendKeys` paste). The input
  route is decided at join, so that viewer stays read-only after the owner opens the node, until it
  rejoins.
- **No equivalent of `paneOwner` / `bracketPasteRequested` / a standalone `paneCursor` query** —
  see the protocol table's "Not implemented" note. Nothing in this app currently calls these for a
  session-host-backed node (they are gated behind `this.tmuxPath` being set), so nothing is
  silently broken; a future feature that wants one of these on Windows needs a new host verb.
- **The phone relay has no tmux to drive on this backend.** Over SSH-less (relay-only) pairing the
  phone used to (a) type a POSIX launch line into a fresh pane and (b) scroll by writing SGR wheel
  bytes for tmux's copy-mode. Neither holds here: pwsh / cmd reject `2>/dev/null`, `env -u`,
  `VAR=x cmd`, and a wheel nobody asked for lands in the prompt as text. So the phone sends
  `pty.attach { launch }` and the HOST launches (`core/relay-launch.ts`: cwd/account ride the spawn
  options, the line is built for the pane's real parser and typed once; `launched:true` is promised
  only after a preflight build succeeded, and `paneShell` tells the phone whether a typed POSIX line
  is safe in that pane — an SSH-project node of a Windows desktop is `posix`), the attach reply says
  `scroll:'local'` with a full-buffer snapshot, and `pty.scroll` writes a wheel only when
  `paneModesV1` reports the app asked for the mouse. Keyed Inbox answers (`agent.key`), read-acks
  (`inbox.ack`), the folder browser (`fs.browse`) and plain capture (`pty.capture`) are relay
  verbs for the same reason. All additive; `host.info` lists them for feature detection.
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

**Stopping the agent (`terminateOwnerV1`, model switch / "Restart on subscription").** Windows has
no foreground process group, so `PtyManager.terminateForeground` cannot SIGTERM one. On a
session-host pane it sends the owner it just proved with `messageOwnerV1` (the agent-identity gate
is MANDATORY here — the legacy "not a shell" guard is not provable on Windows); the host re-reads
the owner, requires `sameNativeProcess` (pane generation, root pid, the single pid, OS birth time,
executable), refuses the console root and any shell, and only then runs `taskkill /T /F` on that
pid (`session-host/terminate-owner.ts`). The shell survives for the recycle that follows. A direct
ConPTY pane runs the same helper in core against `NativeWindowsPane.owner()`. An older host answers
`unknown command`; the client maps that to `'unsupported'` and the canvas says the host predates
the verb instead of "busy". Unlike SIGTERM, `/F` gives the agent no chance to flush — the CLI's
transcript is appended per message, so `--resume` still finds the conversation (device item).

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

### Staged host runtime (#829 step 3) — device checklist

Written and unit-tested on Linux; nothing below has run on Windows yet.

1. **Measure the file set.** On a packaged build, run Process Monitor filtered to
   `nodeterm-sessionhost-v2.exe` during host start and an attach; record every file opened under
   the staged directory. Prune `RUNTIME_*` in `session-host-runtime.ts` to that set (expect
   `locales\` and most DLLs to be unnecessary) and re-run the smoke check.
2. **Smoke run passes.** Fresh install of the new build, open a terminal: `session-host.log`
   shows `[app] staged runtime: published <key>`, and Task Manager → Details shows
   `nodeterm-sessionhost-v2.exe` with a path under `%LOCALAPPDATA%\nodeterm\session-host`.
3. **Update 0.3.x → new build with live sessions.** On a release with the legacy host, the first
   update still meets the legacy host (expected: prepare as before). Then, with the new build's
   staged host holding live shells/agents, install the NEXT build with the app closed: the installer
   must not prompt, must complete, and after reopening every session re-attaches **warm** (log:
   `attach (warm)`, same host pid as before the update).
4. **Same, with the app open** during the install: the preflight prompts for the app only; after
   closing it the install completes and sessions stay warm.
5. **Old uninstaller during update.** Confirm the previous version's uninstaller (both a pre-#868
   stock one and a #868 one) completes with the staged host running.
6. **Compatibility.** With a staged host from build N running, launch build N+1: new terminals go
   to the old host; after the last session closes and 30 s pass, the next terminal starts a host
   from N+1's copy and N's directory is removed on the following launch.
7. **GC fail-closed.** With a staged host of an old version running, launch the new app: that old
   directory is kept. With PowerShell blocked by policy: nothing is removed.
8. **Defender / AV.** First staging with real-time protection on: time it (log timestamps), check
   for quarantine or SmartScreen prompts, and that a scan holding the new exe does not fail the
   publish rename. Repeat with a third-party AV and with AppLocker/WDAC denying executables in the
   profile (expected: smoke run fails, legacy launch, installer still protects the install).
9. **Disk usage.** Size of one staged version directory; confirm only the current (plus running)
   versions remain after a few updates.
10. **Uninstall** with a staged host running: completes, host and sessions keep running, the
    staged folder remains; after the host exits the folder can be deleted.
11. **Two users / all-users install.** Each user stages their own copy; one user's host does not
    block another user's update.

### Session-host overhead and Windows probes — device checklist

P1. **Probe worker stdio.** With the worker warm, run 100 agent messages and an Eco cycle: every
    probe answers, no `csc.exe`/`powershell.exe` sawtooth in Process Explorer, and
    `FreeConsole`/`AttachConsole` inside the persistent process never breaks its own stdin/stdout.
P2. **Probe latency.** Time a cold and a warm `paneCommand` and owner probe on PS 5.1. Target: warm
    under ~300 ms, well inside the 2 s pane-probe budget; cold inside the 6 s first-request deadline.
P3. **conhost parentage.** `Get-CimInstance Win32_Process` shows conhost.exe / OpenConsole.exe with
    `ParentProcessId` = the session host's pid (so the panel's line counts it), for inbox ConPTY.
P4. **Per-session host cost.** Session-host working set + private bytes at 0 / 10 / 30 idle `cmd`
    sessions, and again with `useConptyDll`. Record the per-session delta here; patch a shared
    conout worker only if the worker share is ≥ ~8 MB per session.
P5. **Eco on Windows**, with pwsh and with cmd as the default shell: idle → `/exit` → SLEEPING →
    wake → `claude --resume <id>` typed once; the session-memory panel shows the tree drop to the
    shell alone. Repeat with a native `claude.exe` and an npm `claude.cmd`; a node with an MCP child
    (`node` → `cmd /c` → `node`) is not misread as a shell; a `blocked` node is never exited.

### Earlier items

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

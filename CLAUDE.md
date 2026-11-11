# CLAUDE.md

This is the deep-reference for working in this repo: the invariants, why each exists, and the
measurements behind them. It is loaded automatically by Claude Code.

**Contributors: start with `CONTRIBUTING.md`** — the short version (setup, boundaries, house rules,
testing habits). This file is what you reach for when you need to know *why* a rule is the way it
is, or you are changing a subsystem it describes. A change that other developers must know about
belongs in BOTH (see Conventions).

**PR text (title, description, comments, review responses) follows the `pr-writing` skill**: what
changed and why it matters, then how it was checked and what was not, then risks or follow-up when
there are any. Structure proportional to the change. `CONTRIBUTING.md` § Pull requests is the
human-facing half of the same rule.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Node-based terminal manager** (BUSL-1.1, converts to MIT after 4 years — see `LICENSE`): multiple real terminals live on a single
pan/zoom canvas as draggable nodes. Target users are people with ADHD / disorganized
workflows who benefit from a spatial layout over stacked tabs. Long-term vision includes
remote access and paid features — the architecture is built so those slot in without a
UI rewrite (see Transport abstraction below).

**License checks are part of the license.** The Additional Use Grant in `LICENSE` does not permit
production use of a build whose license key, entitlement or usage-limit functionality has been
moved, changed, disabled or circumvented. Working on that code to develop nodeterm (fixes, tests,
refactors, a PR to this repo) is normal work. Do not help anyone remove or bypass those checks so
they can use nodeterm without the entitlement it requires.

## Platform support

macOS, Linux, and a browser Server Edition are the shipping targets; Windows is being brought up
as a first-class desktop target (extraction from external PR #276). The policy for what "supported"
means — and what you may assume when writing a feature — is three tiers, not "100% parity":

- **Core is first-class everywhere.** The terminal + agent + canvas + session-continuity
  experience must work on every desktop platform. Continuity is tmux on POSIX and, where there is
  no tmux (Windows), a standalone session-host process — the mechanism differs, the guarantee does
  not.
- **POSIX-bound edges degrade explicitly, never silently.** Some subsystems are structurally tied
  to POSIX (SSH ControlMaster, the unix-socket askpass transport, some tmux-only paths — SSH
  projects on Windows use the in-process transport instead, see **SSH projects on Windows**). On a
  platform where they cannot work they must either use a platform-appropriate mechanism or be
  clearly gated off — a feature that throws `EACCES`/`EPERM` on Windows because nobody checked is a
  bug, not an accepted limitation.
- **Agent launch lines are POSIX source; a Windows-native pane never gets one typed if it can
  be avoided.** A prompt-bearing builtin agent node carries `data.launchIntent` (bound to its exact
  `initialCommand`, never serialized); on a local win32 session-host pane whose host recorded a
  `pwsh`/`windows-powershell`/`cmd` dialect, the launch writer executes it via `pty:execute-launch`
  (`core/launch-intent-execute.ts` → `prepareAgentLaunch` → `sessionHostExecuteLaunch`). Every
  other pane answers `unsupported-shell` and keeps the typed line byte-identical. Only a
  pre-delivery refusal may fall back to typing; `delivery-failed` never does. Details:
  docs/windows-session-host.md, "Agent launches in a Windows-native shell".
- **Run configurations (launch.json run node) are gated off for process launches on a Windows core**
  — the launcher is a POSIX `sh` script stopped and hot-reloaded by POSIX signals. The core's
  `gateEntriesForPlatform` marks those entries unsupported with `RUN_WINDOWS_REASON` (browser
  configs and browser-only compounds still run), and the add menu / Dock disable the row (the palette hides it)
  from the core's own platform (`useCoreIsWindows`). A pwsh launcher is the follow-up.
- **Windows terminals run on node-pty's BUNDLED ConPTY when it is installed**
  (`windowsConptySpawnOptions`, `src/core/windows-conpty-dll.ts`, spread into both `pty.spawn`
  sites). Windows 10's inbox ConPTY swallows mouse-tracking and alternate-screen modes, so a
  fullscreen TUI could not be scrolled. The DLL is looked up exactly where node-pty's native loader
  looks (beside the loaded `conpty.node`), restaged after `electron-rebuild` wipes `build/`
  (`scripts/stage-conpty-dll.mjs`), and missing ⇒ the inbox ConPTY. Details + device checklist:
  docs/windows-session-host.md, "Which ConPTY".
- **New code is platform-neutral by default.** Do not hardcode POSIX assumptions. Publish files
  through `renameAtomic`/`writeFileAtomic` (`src/core/fs-atomic.ts`), not a bare `fs.rename` — the
  guard test (`fs-atomic.guard.test.ts`) enforces this. Resolve path separators / absolute-path
  checks / file-link dialects against the filesystem-owning core's platform, not the viewer's, and
  never assume `/` or a unix socket. When a test can only run on one platform, gate it with
  `it.skipIf(process.platform === 'win32')` (or the inverse) and say why — never let it fail the
  cross-platform CI. The `windows-latest` CI job runs the platform-dependent suites on real Windows.
- **Line endings are decided by `.gitattributes` (`* text=auto eol=lf`), not by each contributor's
  git config.** Without it `text`/`eol` are unspecified and Git for Windows' default
  `core.autocrlf=true` gives every Windows clone CRLF working files — so a test that reads a
  checked-in file and slices on a `\n`-bearing literal (`CSS.indexOf('}\n}')`,
  `indexOf('\n}\n')`, `indexOf('\n}')`) matched nothing and failed on a checkout with ZERO local
  changes (issue #578). Two suites did; one reported 25 theme tokens missing that were all present,
  which reads like a regression rather than a broken slice. Attributes only apply on re-checkout
  (`git add --renormalize .` for a tree cloned earlier), so the readers ALSO normalize —
  `readFileSync(f, 'utf8').replace(/\r\n/g, '\n')` — and `src/shared/line-endings.guard.test.ts`
  fails on any such read that does not. `*.bat`/`*.cmd`/`*.ps1` are the deliberate exception and
  keep CRLF: cmd.exe is not reliably tolerant of LF, and those are the files a Windows contributor
  runs before anything else works.
- **PATH resolution and direct execution are separate on Windows.** `findInPathString` correctly
  follows `PATHEXT`, which means an npm-installed CLI may resolve to `<name>.cmd`; Node's
  `execFile`/`spawn` still cannot execute that path directly (`spawn EINVAL`). App-owned
  subprocesses must pass their resolved executable and argv through `directExecutableInvocation`
  (`src/core/exec-path.ts`), which invokes `.cmd` through a hidden `cmd.exe` with explicit escaping,
  verbatim arguments and delayed expansion off. Never replace this with `shell:true`: commit prompts
  and other user-controlled arguments would then be reinterpreted as shell syntax. The helper fails
  closed for `.bat`/`.ps1`, CR/LF/NUL inside argv, and command lines above cmd's real 8,191-character
  ceiling. stdin stays a byte stream directly into the shim; routing it through an npm `.ps1` shim's
  `$input | & node` text pipeline corrupts Unicode and line endings under Windows PowerShell 5.1.
  Interactive terminal agent launches keep using `agent-launch.ts`'s separately tested shell plan.

## Commands

**Direct Windows agent messaging:** `core/native-windows-pane.ts` owns a headless screen for
non-persistent native PTYs. Lookup uses the runtime node index, and the console identity probe
uses `GetConsoleProcessList` plus OS executable paths/birth times. A single process reached
through an unambiguous shell chain is required; detached or ambiguous candidates refuse. This
is not a POSIX foreground-process-group claim. **An interpreter (`node`, `bun`, `python`, …) is
named by its script, never by its own executable**: every npm-installed agent CLI on Windows is
`cmd` → `node <package>\bin\<cli>.js`, and naming that pane `node` made Codex and every npx
custom agent `not-agent`. The probe keeps only the interpreter's FIRST positional argument
(`CommandLineToArgvW`, inside PowerShell; the rest of the command line, prompt text included, never
leaves the probe) and `scriptCommandName` maps it to the key of its package's `bin` map, which is
the table npm generated the `.cmd` shim from, falling back to the script basename exactly as the
POSIX predicate does. The interpreter is the leaf, never a hop, so a CLI's own children (Codex's
native `codex.exe`, MCP servers) cannot make the pane ambiguous.
**A RELEASED session is still a messaging target.** Park expiry and the offscreen release drop the
`Session`, but the host keeps it running, so `targetLive` asks `PtyManager.sessionExists` (attached,
else tmux, else the host, with a failed read answering "exists") and the owner/paste/envelope probes
route through `sessionHostOwns`, which falls back to the release record. Asking only for an attached
client answered `targetGone`, terminal and never queued, about a live agent in another project. The project/verified-hook/idle/receipt gates still
apply, paste mode must be observed, and the exact generation/process is checked before writing.
`PtyManager.sendText` (the confirmed `write` verb, rename, note push, dictation) also routes a
direct native PTY through `NativeWindowsPane.sendText` — framed only when paste mode was requested,
no process attestation. It used to fall through to the session-host backend, which has no entry for
a direct PTY, so every `write` to such a pane failed.
Do not route the persistent session-host backend through this direct-PTY adapter. Its independently
versioned `messageOwnerV1` / `messagePasteReadyV1` / `messageEnvelopeV1` extension runs in the host:
the OS probe is bound to `HostSession.generation`, the session registry is rechecked after every
await, and the emulator's paste mode is checked again immediately before the synchronous write.
**The Enter is a SECOND write, sent only once the pane shows the envelope** — every backend
(Server Edition tmux, session host, direct PTY) runs the one `core/settled-submit.ts`. Measured on
the installed build (2026-09-14): with the `\r` in the same write as the paste, Codex rendered the
whole envelope in its composer and never submitted it, so the delivery reported `stalled`; a
separate Enter moments later sent it. A pane that never shows the envelope gets no Enter at all.
**Both Windows owner reads get a longer budget than the 2 s `PANE_PROBE_TIMEOUT_MS`.** The session
host's `messageOwnerV1` and `NativeWindowsPane.owner()` run the same PowerShell console/CIM probe
(`readWindowsConsoleOwner`), measured at ~2.4 s one-shot on a loaded Windows 11 machine — so under
the 2 s bound every Windows target read `unknown` and refused as `targetPaneUnreadable`, behind an
error that invites a retry (#1211). The #1206 probe worker is fast only once WARM and exits after
60 s idle, so a message sent minutes after the last meets its 6 s first-request deadline plus the 4 s
one-shot fallback. `PtyManager.paneProbeTimeoutMs` answers `WINDOWS_PANE_PROBE_TIMEOUT_MS` — DERIVED
from those two deadlines + 1 s (`session-host/windows-probe-budget.ts`; never a literal) — for exactly the backends
`paneOwner` routes to that probe, and both shells forward it as the optional
`AgentMessagingDeps.paneProbeTimeoutMs` through ONE helper, `ptyPaneProbeDeps`, which binds the read
and its budget together (an optional dep that is not forwarded fails silently). SSH and tmux keep 2 s: that bound exists because
a lapsed ssh probe leaves a child alive that can turn into a full login against a dead master, a
hazard a local `powershell.exe` does not have. The verdict rules are unchanged; only the deadline
moves.
An older live host refuses these unknown commands while keeping the v1/v2 terminal contract intact;
never replace it automatically or fall back to name-only input to enable messaging. Windows OpenCode
context exports go through `directExecutableInvocation` like every other app-owned subprocess (see
Platform support), never a bare `execFile('opencode')`, which cannot execute the npm shim.

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc for both node (main/preload) and web (renderer) projects
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
```

**`rebuild` and `postinstall` both run `scripts/patch-node-pty.mjs` first, and that is not
optional.** It carries TWO version-pinned native patches for node-pty 1.1.0, one per platform leg:
- **darwin** — `pty_posix_spawn` leaks a ptmx device on every SUCCESSFUL spawn (an off-by-one in
  the low-fd cleanup) and master+slave on every FAILED one; on this app's spawn churn that
  exhausts `kern.tty.ptmx_max` within hours, and terminals then simply stop opening
  (microsoft/node-pty#950). Rewrites `node_modules/node-pty/src/unix/pty.cc`.
- **Windows** — the native exit thread deletes its `pty_baton` without closing the HPCON the baton
  owns, so the session host's taskkill-first kill path (src/session-host/host.ts) leaves a
  host-parented conhost alive for the life of the long-lived session-host process, one per killed
  session, and `conpty.kill(id)` reports nothing. The patch serializes baton access, closes the
  exact HPCON before every baton deletion, and makes `kill(id)` return `true` only as positive
  proof — the contract `src/session-host/windows-conpty.ts` was ALREADY written against (it
  shipped with #305 expecting a patched node-pty that did not exist until this patch; do not
  wire `closeExactWindowsConpty` into the ordinary kill path — after taskkill the exit thread
  usually wins the race, has already closed the HPCON itself under the patch, and the primitive
  would then report `false`; it exists for a pre-first-output teardown that bypasses the exit
  thread). Rewrites `node_modules/node-pty/src/win/conpty.cc` on every host — the file only
  compiles for the win32 native target, so patching on mac/Linux is harmless and keeps packaged
  rebuilds honest.

Both patches run before electron-rebuild compiles the module.

`src/main/node-pty-patch.test.ts` asserts both markers are present in those sources, so a node-pty
upgrade that silently drops either patch fails loudly. **If that test is red, your `node_modules`
is unpatched, not your code** — run `npm run rebuild`. It deliberately does not measure descriptors
or handles (that is environment-dependent); it checks the source the native module is built from.
Upstream: the darwin leg tracks microsoft/node-pty#950; the Windows leg has no upstream issue yet.
When a leg's fix lands upstream, delete that leg (and the whole script + test once both are gone).
```
```

`npm test` runs the vitest suite (unit + integration; the remote e2e suites skip when the
companion server repo isn't checked out). `npm run typecheck` is the fastest correctness gate.

## Process model (Electron, three contexts)

The codebase is split by Electron process boundary — keep code on the correct side:

- **`src/main/`** — Node/Electron main process. The **shell** around `src/core/`: owns
  Electron/window/IPC wiring, dialogs, and the `CorePlatform` implementation
  (`platform-electron.ts`). The renderer must never import these.
- **`src/core/`** — Electron-free service core (pty, workspace/settings stores, git,
  hook server + hooks cluster, context/subagent tails, transcripts,
  model-window, license, context-link, and the pure ssh leaves under `src/core/remote-ssh/`
  — control-master, remote-git). Talks to its shell ONLY via the `CorePlatform` interface
  (`src/core/platform.ts`); importing `electron` (or `../main/*`) inside `src/core` is
  forbidden and enforced by `src/core/no-electron.test.ts`. The Electron implementation is
  `src/main/platform-electron.ts`. This is the seam the Server Edition's `src/server/` shell
  plugs into.
- **`src/server/`** — Server Edition shell (Phase 2): plain `node:http` + `ws`
  serve the built renderer to a browser and speak a WS-RPC protocol
  (`src/shared/rpc.ts`) that a browser-side `window.nodeTerminal` shim
  (`src/renderer/bridge/`) consumes. Boots the same core services via
  `ServerPlatform` (`src/server/platform-server.ts`). Single-user auth
  (scrypt + httpOnly cookie + Origin check; the rules a refactor must keep are under
  **Server Edition sign-in** below). `npm run server:dev` to try;
  docs/SERVER.md for details. `src/server` must not import electron or
  `src/main` (enforced by `src/server/no-electron.test.ts`). **Phase 3a** also
  serves fs/git/commit handlers (editor/diff/source-control now work in the
  browser) plus a web folder/file picker (in-app server-directory browser,
  replacing the native dialog) and WS backpressure; the renderer detects the
  bridge in `src/renderer/main.tsx` (desktop preload path is untouched).
  The picker's **folder** mode also creates directories (`createPickerFolder`,
  `renderer/bridge/dialog-picker.tsx`) — the native dialog it replaces has a New Folder
  button, so without one "Open folder…" in the browser could only ever adopt a directory
  that already existed on the server. It writes through the same `fs.mkdir`/`fs.exists`
  the Explorer's "New Folder…" uses and validates the typed name with the same envelope,
  `newEntryPath` (`renderer/lib/explorerCreate.ts`) — **do not add a second path
  validator here**; `..`, absolute and empty names are refused in exactly one place. The
  write deps are optional, so a caller with a read-only fs simply renders no button. File
  mode has none (nobody opens a file picker to make a folder). Relay tabs get the same
  button and it writes on the HOST, like every other `fs.*` the picker already uses. SSH
  projects are a separate flow (`SshProjectDialog` over `sshProject.mkdir`) and already
  had their own.
  **Phase 3b** boots the loopback **hook server** (`hookServer.start()`) + installs
  the managed hook scripts, and `wireAgentStatus` (`src/server/agent-status.ts`)
  broadcasts `agent:status` / `agent:subagent-activity` / `context:update` over the
  bridge, so agent-status badges, subagent cards, and the context meter now work in the
  browser (transcript-path jailed against forged POSTs). It also serves the two transcript READ
  channels (`registerTranscriptIpc` — the ⌘M chat view + the find-bar's transcript index; see the
  ⌘M bullet under Agent support). **Canvas control is opt-in**
  (`NODETERM_SERVER_CANVAS_CONTROL=1` / `--canvas-control`): the Server shell installs its own shim
  and runs a serialized `HeadlessNodeFactory`; disabled remains the default. Its project writes
  broadcast on `workspace:server-change`, NOT the outside-edit channel — they are this core's own
  writes and are three-way merged by the renderer, never put behind the conflict bar (see the
  workspace-store bullet). (The SDK **chat node**
  — once listed here as deferred — was removed entirely, 2026-07; see the chat-node note in the
  node-kinds list.)
- **`src/preload/`** — the only bridge. `index.ts` uses `contextBridge` to expose a
  narrow API on `window.nodeTerminal` (typed in `index.d.ts`). `contextIsolation` is on,
  `nodeIntegration` off.
- **`src/renderer/`** — React UI. Talks to main *only* through `window.nodeTerminal`.
- **`src/shared/`** — types and IPC channel names imported by all three sides. `ipc.ts`
  is the single source of truth for channel strings; never hardcode a channel elsewhere.

PTY output flows main → renderer over per-session channels (`pty:data:<sessionId>`),
input flows renderer → main over `pty:write`. node-pty is kept **external** in the bundle
(`externalizeDepsPlugin` in `electron.vite.config.ts`) because it's a native module.

**Process death and hangs are telemetry, never NEW triggers.** Until then the only handler was
`render-process-gone`, and it logged nothing, so a GPU-process crash or a renderer hang left no
trace. Now app `child-process-gone` (`{type, reason, exitCode, name}`, per-type session count;
`clean-exit` at info, every other reason at warn), the main window's `unresponsive` / `responsive`
pair (two lines per hang: one when it is declared, one when it ends with the duration, measured
from Electron's own hang timeout so it is a lower bound) and `render-process-gone` each write
`[process]` lines to the debug log ring (`main/process-health-log.ts`, wired in `index.ts`).
`child-process-gone` is registered before `ready` because the GPU process can die during boot.
The logging adds no action: `render-process-gone` keeps the crash reload it already had
(`createCrashReloadPolicy`, and it now also closes an open hang), while `child-process-gone` and a
hang reload, relaunch or kill nothing. Chromium respawns the GPU process itself, and repeated GPU
deaths can trip its per-domain 3D-API block "until restart", so provoking more of them degrades
the session. In the renderer, `webgl-budget.ts` counts EXTERNAL WebGL losses by
kind through `handle.contextLost(kind)` — `lost` (the addon's `onContextLoss`: still lost after
its 3s window) and `restored` (a GPU reset the browser recovered, which `TerminalNode` rebuilds on
a fresh addon) — and writes one `[webgl]` warn per loss carrying the session totals, which main's
`console-message` mirror puts in the ring. Our own `loseWebglContexts` releases are counted as
`released` and never logged per event (routine churn on every pan). A Server Edition tab has no
main, so its `[webgl]` lines stay in the browser console.

### Server Edition sign-in (security audit 2026-10)

The browser edition is reachable by anyone who can reach its login page, so its auth layer carries
rules that look like over-engineering and are not. Each was a measured finding; tests pin each
(`src/server/http-auth.test.ts`, `auth.test.ts`, `ws.test.ts`, `proxy-trust.test.ts`).
- **A login attempt reserves its rate-limit slot BEFORE the body is read** (`Auth.beginLoginAttempt`,
  settled exactly once as success / failure / abandoned), and the budget counts attempts in flight.
  Checked-before-body + charged-after-verify let 60 of 60 held-body guesses through. The lock is per
  CLIENT (5 → 1 min, doubling to 1 h) with a global ceiling (50 per 5 min, in-flight included) as the
  backstop; one global counter let a stranger lock the owner out. The client key is
  `client-address.ts`: the TCP peer, or — only when the peer is loopback/private/CGNAT/ULA or in the
  trust nets — the LAST `X-Forwarded-For` entry, never an earlier one (the caller wrote those).
- **Password verification is the async `crypto.scrypt` behind a 2-slot FIFO gate.** There is no
  synchronous verify on purpose: a `scryptSync` per guess froze every terminal's WebSocket.
- **Every `POST /auth/*` and the WS upgrade pass ONE same-origin rule** (`src/server/origin.ts`).
  A new auth POST route goes under `/auth/` or it skips the check.
- **Sign-out is server-side.** `/auth/logout` deletes the presented session, `/auth/logout-all`
  deletes all (signed-in callers only), and `ws.ts` closes a cookie socket (4401) when its session is
  revoked (`Auth.onSessionsRevoked`) or found expired on a heartbeat. The browser UI is
  Settings → Sign-in, Server Edition only (`nav.ts` `browserOnly`).
- **Header trust from loopback needs the proxy secret.** On loopback every local process is "the
  proxy", so `resolveConfig` turns header trust OFF (and the boot says what to set) when the nets
  cover loopback and `NODETERM_TRUST_PROXY_SECRET` is unset, and `proxyAuthDecision` refuses a
  loopback peer without a secret whatever the config. The secret is env-only (argv is world-readable)
  and never logged.
- **`NODETERM_PUBLIC_ORIGIN`** forces `Secure` + HSTS; without it `Secure` follows
  `X-Forwarded-Proto` and the first non-loopback `Host` logs a warning. Every response refuses framing
  by HTTP header (the app CSP is a `<meta>`, where `frame-ancestors` is ignored), and the served
  `connect-src` is `'self'` (same-origin ws/wss, CSP3; Chrome-verified).

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

## State & persistence model

**React Flow is the single live source of truth** for nodes. There is intentionally no
separate store mirroring node state — earlier dual-source designs caused sync bugs.
`src/renderer/state/workspace.ts` holds only pure helpers: the color palette, the node
factories (`createTerminalNode`, `createSshTerminalNode`, `createAgentNode(agentId, …)`,
`createAccountLoginNode`, `createStickyNode`, `createGroupNode`, `createEditorNode`,
`createDiffNode`, `createVideoNode`, `createWebNode`, `createBrowserNode`, `createFilesNode`,
`createDinoNode`, `createTriggerNode`), the
group transforms (`groupSelectedNodes`, `ungroupNodes`, `duplicateNode`), and the
`nodeStatesToFlow` / `flowToNodeStates` serializers. Node kinds (`NodeKind` in
`src/shared/types.ts`): `terminal | sticky | group | editor | diff | video | web | browser |
files | subagent | loop | dino | trigger | simulator | whiteboard` — `subagent` and `loop` are render-only (ephemeral hook-driven
viz) and never persisted. `trigger` (issue #493, all four
phases landed) is a first-class PERSISTED kind. The whole host-side
machine is composed ONCE in `core/trigger-service.ts` (`startTriggerService`) and booted
identically by BOTH shells: `core/trigger-scheduler.ts` (sweep-service shape, no catch-up for
missed slots, cron via the dependency-free `@shared/cron` with the vixie dom/dow OR rule) decides
WHEN, and `core/trigger-delivery.ts` decides WHETHER — the `sendText` paste path, an agent target
only on a mirror-verified idle `done` (busy/blocked/unknown → the messaging `DeliveryQueue`, own
instance, flushed by the mirror's `done` edge via `onNodeStateChange`, with FULL flush-time
re-validation: a trigger disarmed or spec-edited while queued is dropped), a plain-terminal target
only into a SHELL pane and never queued, a dead target an honest `missed` and never a cold start.
Fire-time `TriggerArmStore.isArmed` re-ask everywhere; every rule test-pinned. The kind's spec: its spec (`CanvasNodeState.trigger`,
@shared/trigger) is git-shared CONTENT sanitized as hostile input on every load path
(`sanitizeNodeTriggers`), and the definition alone never fires — execution consent is the
machine-local, content-bound `core/trigger-arm-store.ts` (a spec that arrives or CHANGES via git
reads as disarmed until armed on this machine). A node's `data`
carries `title, color, group, tags, collapsed, expandedHeight, shell, cwd, text,
initialCommand, filePath, diffStaged`, `icon` (a user-chosen emoji, glyph or picture — see **Node icons**
below), `agentId` (which agent CLI a terminal node runs —
persisted), and `accountId` (which managed Claude account a terminal node runs under — resolved
at creation, changed ONLY by the explicit account-switch actions, persisted; see **Managed Claude accounts**). `nodeStatesToFlow` defaults a
missing `kind` to `terminal` for backward compat and migrates the legacy `tags:['claude']` marker
to `data.agentId = 'claude'`. The SDK **chat node** was removed (2026-07); `nodeStatesToFlow` also
migrates a persisted `chat` node into a **sticky tombstone** in place, reading its legacy
`chatSessionId` to print a `claude --resume <id>` hint (a chat is an ordinary resumable Claude
session).

Persistence has two layers:

- **Layout + config**: schema v3. `workspace.json` (in `app.getPath('userData')`) is now an
  **index**: local folder projects are refs to `<cwd>/.nodeterm/project.json` (the source of
  truth — git-shareable, machine-portable; pretty-printed, portable `./` node cwds, monotonic
  `rev`), SSH projects are refs to the same file on the server (offline `cache` in the index,
  reconciled by rev on connect, mirrored via `SshFs` with a 5 s write throttle), and cwd-less
  canvases are refs to `userData/inline-projects/<id>.json`. **Every entry is a ref — one shape,
  three kinds:**

  | kind | source of truth for the CONTENT | what the index entry carries |
  |---|---|---|
  | folder-ref | `<cwd>/.nodeterm/project.json` (git-shared) | `cwd` + header + machine-local half |
  | ssh-ref | the same file on the host | `ssh` + header + `cache` (offline copy, rev-reconciled) |
  | local-data-ref | `userData/inline-projects/<id>.json` | `dataFile` + header + `project` (cache) |
  | folder-data-ref | `userData/inline-projects/<id>.json` | `cwd` + `dataFile` + header + `project` (cache, stored WITHOUT `cwd`) |

  **The folder-data-ref (issue #1145)** is a folder project whose canvas is kept in app data
  (`Project.storeInAppData`) so that nothing is written into the folder — for client repos and
  folders the user does not own. It is a local-data ref with a working directory: the file and the
  cache hold the project without `cwd` (node cwds stay absolute), so the inline load and write paths
  serve it unchanged and the entry adds the folder back. Three rules keep the promise:
  `folderFileCwd(e)`, not `e.cwd`, decides every read or write of `<cwd>/.nodeterm/project.json`
  (watcher, content authority, the phone writers, settings); a missing data file falls back to the
  cache and then to a grey placeholder, **never** to the folder branch (that would adopt a stale or
  a teammate's canvas); and the cache's missing `cwd` is the downgrade contract — an older build
  opens it as a plain inline canvas instead of writing a fresh file into the folder. Its side files
  follow it: settings.json and the board log under `userData/project-files/<id>/.nodeterm/`
  (`appDataProjectRoot`; settings still load as `'shared'`; removed with the project when it is
  deleted, kept when it moves back into its folder), whiteboards in the same root
  (`whiteboardLocationForProject`; the folder's boards, drawn before the move, are read after it and
  never written, and a move back copies the app-data boards over the folder's older files —
  `carryWhiteboards` in `prepareFolderStorage`; not the shared `userData/whiteboards`, which is
  keyed by node id, and two folders holding one committed canvas share node ids), canvas images to
  the existing `userData/canvas-images` fallback (`sideFilesFolderForProject`). `localCwdForProject` still answers
  the folder, because it means where terminals run and what a relay seat is jailed to. Moving
  between the two is the tab menu's "Store canvas in app data / in folder"
  (`lib/projectStorageMove.ts`): into app data = save, then `releaseFolderFiles` (refused until the
  data file holds the canvas; files git tracks are kept unless the user confirms); into the folder =
  `prepareFolderStorage` (refuses an occupied folder, like "Set folder…"), then save, then
  `projectStorage` (where the store has the canvas now). New folder projects follow
  `settings.newProjectStorage`; a folder that already has a project.json is adopted as it is, in its
  folder. Rules the moves rest on:
  - **The data file goes only when THIS save wrote the folder file** (`sweepRemovedDataFiles`'
    `folderFilesWritten`), never because `lastWritten` remembers one: a file can leave the folder
    behind the store's back (`git rm`, a branch checkout) while the record stays, an unchanged
    canvas then skipped the write as "unchanged", and the sweep deleted the only copy. For the same
    reason the record of a folder file is dropped when its project moves into app data (kept file
    or not) and when an entry takes a folder over from a data file ("Set folder…", a move back).
  - **A move into the folder whose folder write fails stays in app data, index included**: the
    folder leg swallows a failed write, so the save keeps that entry a folder-data-ref for that save
    (`appDataCanvas`, the one builder of its cache). The menu reads `projectStorage` after the save,
    puts the flag back and says the move failed; it never reads a landed save as a landed move.
  - The rev continues across a move (the sweep keeps it for an id that is still live).

  **Known limits:** an older build that opens a folder-data-ref while a folder `project.json` is
  still there (a tracked file the user kept) keys its watcher, its phone writer and `readLocalRef`
  on the entry's `cwd`, so until it next saves its index it can adopt that file as the project
  (after which the entry is a plain folder ref there and the data file is orphaned). Images and a
  board log stay on the side they were written on when a project moves, in either direction; so do
  a folder's whiteboard files after a move into app data (read, never removed). A board edited in
  app data replaces the folder's file on the move back, including a teammate's newer version of a
  tracked board pulled in the meantime (git still has it).
  Handoff files from Transfer still write `<node cwd>/.nodeterm/`. The iOS app does not know the
  kind: over direct SSH it reads the entry's `project` cache, which has no `cwd`, so it shows a
  project without a folder (it never reads or writes the folder file, and its board and label
  writers refuse with no write path; the relay verbs are handled here), and its repo scan finds no
  `project.json` in that folder, so it can offer the folder as a new project and write one there.
  SSH projects and Server `team bootstrap` cannot use the kind.

  In all three the file carries CONTENT and the entry carries the machine-local half — project
  `id`, `viewport`, `defaultAccountId`, `breadcrumbs`, `closedSessions`, `localApprovalId`,
  `localExec`, `localSettings` (the #510 rule). The renderer contract is untouched: `workspace.load()/save()` still
  speak an assembled v2-shaped `Workspace`; all fan-out lives in `core/workspace-store.ts` +
  pure `core/workspace-files.ts`. v2 files migrate on first save (backup `workspace.v2.bak`,
  one-time renderer note). Outside edits (git pull/sync) are detected by
  `core/workspace-watcher.ts` → silent reload, or a Reload/Keep-mine conflict bar when dirty; they
  ride `workspace:external-change`, and so do the phone's `appendRemoteNode` and the SSH
  reconcile, which really are "another device". The exception is a project a hosted Server Edition
  shares with its team: the canvas authority adopts that outside edit and publishes it as
  `canvas:mut` ops, with no `workspace:external-change`, then sends the persisted project on
  `workspace:server-change` so its non-content fields (name, permission default, capability flags…)
  reach the tabs too (see **Hosted team relay**).
  **A write this core made ITSELF rides `workspace:server-change` instead** — today that is Server
  Edition headless canvas control (`server/canvas-control.ts`) — and the renderer three-way merges
  it against the store baseline (`renderer/lib/serverChange.ts`: incoming nodes adopted silently,
  ropes/bridges merged by id with server-added installed, server-removed dropped, local unsaved
  edits kept, dangling edges pruned), never a bar and never a reload. It used to share the
  outside-edit channel and that was a data-loss path, not a cosmetic one: `decideExternalChange`
  compares the project shell, `ropes` included, so the one `ctrl-…` rope an `open-agent` appends
  read as a conflict whenever the canvas was dirty — which it is throughout a spawn burst (the
  paired `canvas:mut` marks it, spawns land 60–140 ms apart inside the 800 ms autosave debounce,
  and **the bar itself suspends autosave**, so once raised it stayed raised). Answering "Keep my
  version" then wrote the browser's edge state over the file, dropping the ropes the server had
  just persisted and resurrecting cards it had removed.
  Unreadable refs render as greyed **unavailable** tabs (never dropped); corrupt project files
  are set aside as `project.json.corrupt-<ts>`. "Open folder…" adopts an existing
  `.nodeterm/project.json` — the probe MINTS the project id (node ids — tmux names — kept), and
  re-opening the folder is answered by the cwd lookup, not a second adoption.
  **A cwd-less canvas is a supported, first-class project, not a degraded one** — "New project" on
  the welcome screen creates exactly that, and it survives a restart intact. It is the correct
  fallback layer and `localStorage` is not: `userData` is backed up with the app's data,
  atomic-written, and one store for all three shells, while localStorage is renderer-origin state
  the Server Edition would shard per browser profile.
  **What it used to lack was a SECOND copy, and that is what `local-data-ref` fixes.** A folder
  project's canvas also lives in `<cwd>/.nodeterm/project.json`, so a corrupt or clobbered index
  costs it nothing; an inline canvas existed ONLY inside the index — one file, last-writer-wins, so
  a second instance sharing that `userData` erased canvases that existed nowhere else, and a corrupt
  index left them only inside the `workspace.json.corrupt-<ts>` sideline with no UI path back.
  Each now has its own atomically written file, and the entry's `project` field is kept beside it as
  a **cache** — the dual-write that (a) lets a build older than this one still read the canvas out
  of the index (the downgrade contract, ONE release; the iOS SSH-browse path cats `workspace.json`
  directly and depends on it too) and (b) answers when the data file is missing or corrupt.
  The file wins whenever it reads. Rules that make this safe, all in `WorkspaceStore.writeDataFile`:
  an unchanged candidate is not written at all; **a lower `rev` may not overwrite a higher one** (a
  second instance wrote it after we looked — its canvas stands, the next load here adopts it, and
  there is deliberately NO merge: the guarantee is "two instances cannot erase each other", not
  "two instances stay in sync"); an empty candidate never overwrites a populated file this store has
  not read. A corrupt data file is set aside as `.corrupt-<ts>` like any other project file, and the
  sweep that deletes a removed project's file only ever touches ids THIS store had loaded — a file
  belonging to another instance is never deleted, at the price of some litter after a re-key.
  `userData/inline-projects` is deliberately NOT watched (`workspace-watcher` covers folder refs
  only): nothing external edits it — no git pull, no teammate — and the rev rule is the whole
  concurrency story. The corrupt-index note still matters and must stay honest; it used to promise
  "No project data was lost — each project's canvas is still in its own folder", which was true for
  refs and false for exactly the projects that had just vanished.
  **Binding a folder to an existing project is a WRITE, so probe before you bind.** "Set folder…"
  (tab ⌄) promotes an inline canvas to a ref, and the next autosave writes that folder's
  `project.json` — over whatever was already there. It used to bind unconditionally, so pointing a
  scratch project at a repo whose canvas a teammate had committed replaced it (rev 40 → rev 1, their
  nodes gone, no sideline copy, nothing on screen). The two entrances to "attach a folder" now agree:
  `openOrAdoptFolder` probes and ADOPTS, and `setProjectFolder` runs the pure
  `renderer/lib/setProjectFolder.ts` — an occupied OR unreadable `project.json` refuses the bind with
  its reason (a failed read is never evidence of absence, #385), and a folder another project already
  owns routes to that project, REOPENING it when it is closed rather than switching to a hidden tab.
  The store's own "never blind-write" guard does not cover this: it only refuses an EMPTY candidate
  over a populated file, and this candidate has nodes.
  **Features that need a folder degrade explicitly, never silently.** Explorer, Source Control and
  Project Settings already say so in words; the add menus now do too — "New file…" and "New
  worktree…" stay in the list DISABLED with `NEW_FILE_NO_CWD_HINT` / `WORKTREE_NO_CWD_HINT`
  (`lib/addMenuSpec`) instead of vanishing, and `openWorktreeDialog` refuses a cwd-less project at
  the same choke point it refuses an SSH one (the palette has no disabled state). The worktree
  dialog's "This project is not a git repository." was the wrong cause for a project that has no
  folder to be a repository at all.
  **An `unavailable` placeholder used to be a DEAD END** (issue #385): a save deliberately emits a
  header-only ref for it and never a file, so a `project.json` the user deleted was never
  recreated, every later load re-minted the placeholder, and nothing cleared the flag for a LOCAL
  project (`reopenProject` clears only `closed`; the sole `setProjectUnavailable(id,false)` caller
  is the relay reconnect). The tab went inert (`tabClickAction` → `'ignore'`) while the sessions
  sidebar — which has no concept of `unavailable` — still switched to it. An explicit "Open
  folder…" now breaks the loop, but only on EVIDENCE: `WorkspaceStore.projectFileState` reports
  `present | absent | unreadable` and **only a definite ENOENT counts as absence**, because
  clearing the flag lets the next save write the placeholder's empty canvas over whatever is
  there. Absent ⇒ clear; present ⇒ re-probe and rehydrate under the EXISTING entry id (a corrupt
  file stats fine, so a null probe keeps the placeholder); unreadable ⇒ change nothing. The
  decision is the pure `unavailableRecovery` (`renderer/lib/projectOpen.ts`), and it refuses to
  judge a REMOTE project from a local stat.
  **The shared file carries content, not identity**: no project `id`, no `viewport`, no
  `defaultAccountId` — those are machine-local and ride the index entry (`IndexEntryV3`), beside
  `localApprovalId`/`localExec`. Two folders holding the same committed canvas (worktree, branch
  checkout) are two independent projects, and the committed file is byte-identical on every
  machine. The file still carries a machine-INDEPENDENT legacy `id` (`legacyFileId`, derived from
  the canvas name) for one release, because a pre-change build sidelines an id-less file to
  `.corrupt-<ts>` inside the user's repo; it is ignored on read. Residual: node ids are still
  shared, so two worktrees still attach the same tmux sessions.
  **SSH mirror safety** (the ".nodeterm reset itself" bug — 12 fresh project ids and 45 orphaned
  tmux sessions in one field report): remote writes are atomic (`cat > f.tmp && mv`, `sshWriteArgs`);
  a mirror is never blind-written before the entry has read-compared the server file once
  (`WorkspaceStore.reconcileSsh` — the single decider; a checked read's `error` ≠ `absent`, and on
  error it decides NOTHING); cross-lineage conflicts (re-added folder, second machine, git checkout:
  the server file carries a different project id) are settled by content, not rev alone — an empty
  side never beats a populated one, adoption re-keys the file to the local project id (node ids =
  tmux session names are kept so terminals reattach), and a push outbids the losing lineage's rev;
  a throttled trailing write that drops after its optimistic ack re-owes the mirror
  (`markUnmirrored`); pending mirrors are flushed before the ControlMasters die at quit; and the
  SSH dialog **dedupes by endpoint+remoteCwd** (`openSshProject`, same contract as
  `openFolderProject`) instead of minting a fresh empty project for a folder that already has one.
  **The reconciler also recognizes its own writes** (the SSH twin of the watcher's `isSelfWrite`):
  the 15 s poll and the connect-time refresh read the very file the mirror writes, so
  `recentMirrorHashes` remembers the last few payloads handed to `remoteIO.write` and a read that
  returns those exact bytes decides "nothing new" — never an adopt/broadcast (which raised the
  Reload/Keep-mine conflict bar over the store's own autosave), and never a rescue of an OLDER own
  write still sitting under the 5 s throttle (which resurrected just-deleted nodes). Exact bytes
  only, so a phone append or another machine's save still reads as external. And
  `refreshSshProject` runs ON `saveChain`: off the chain a poll snapshotting the pre-save entry
  could complete its slow ssh read after the save's mirror landed and "adopt" the store's own
  write on rev alone.
  **A write ACK is not evidence about the server's CONTENT — only a read is** (2026-09-06 field
  report: 16 terminals deleted on an SSH project came straight back, announced as sessions
  registered from a phone the reporter does not own). `clearedNodes` is the tombstone set that
  tells the mirror's re-read "we deleted this, do not rescue it back", and it used to be dropped
  the moment `remoteIO.write` returned true. That ack is **optimistic for the 5 s throttle's
  trailing write** (`makeRemoteWorkspaceIO` returns true and schedules the run) — so when the
  connection died inside the window, `markUnmirrored` re-owed the mirror (`unmirrored.add`) while
  the tombstones were already gone, and the retry's re-read found every just-deleted node still on
  the server with nothing left to filter with: `rescueRemoteNodes` merged all 16 back into the
  cache, bumped the rev and broadcast them as an external change. The asymmetry was in one place —
  `unmirrored` was restored, `clearedNodes` was not. A tombstone is now retired ONLY by
  `confirmClearedDeletions`: a read that no longer lists the id (taken from reads the store already
  makes — the mirror's own re-read and `reconcileSsh` — so it costs no round-trip), or an adopt,
  which overrules our deletions outright. **Both** read sites must call it; wiring one leaves the
  other's tombstones alive for the whole run. The cost is that GC lags a landed write by one read,
  which only prolongs the suppression of a rescue we do not want; the benefit is that the rule no
  longer depends on a dropped write being REPORTED. Symmetrically restoring the set inside
  `markUnmirrored` was the smaller diff and was rejected: it needs the same shadow state anyway,
  and it only closes the one failure path that happens to report back. The set is runtime-only,
  bounded by the ids deleted this run, and pruned for projects that leave the index.
  **Neither surface may name a device for an adopted node** (`adoptedClause`,
  `renderer/lib/externalChange.ts`): nothing at that layer knows the source — a stale own mirror
  and a phone append are indistinguishable there — so the copy names the project FILE and offers
  the possibilities without asserting one.
- **Live terminal sessions** (tmux): terminals continue where they left off across node
  remounts *and* full app restarts, including running processes. See below.

**Autosave does no unchanged work** (`WorkspaceStore.save`): the parse of each `lastWritten` value is cached per raw string, and `workspace.json` is not rewritten when its bytes equal the store's last write AND the file still has the size+mtime+inode that write left — so another instance's rewrite is still answered (the inode catches a same-size rewrite on a coarse-mtime filesystem: every writer publishes by rename), a store's first save and a v2 migration always write, and every other index writer of ours clears the record.

`settings.json` is a separate store (`core/settings-store.ts`, `state/settings.ts`).

## Projects (tabs)

Each project is one canvas/page; terminals and notes belong to a project. The `projects`
zustand store (`renderer/state/projects.ts`) holds project metadata + the *serialized* nodes
of all projects. **React Flow remains the single live source of truth for the *active*
project's nodes only.** The contract:

- The active-project effect in `Canvas.tsx` (keyed on `activeProjectId`) loads that project's
  serialized nodes into React Flow. `loadingRef` suppresses dirty-marking during this load.
  A real switch applies the project's saved viewport; an **in-place reload**
  (`reloadActiveProject` — external file change / SSH reconcile) sets `preserveViewportRef` so
  the load **keeps the user's current camera** — the incoming file's viewport is wherever
  another machine last saved, and restoring it mid-work teleported the camera (most visibly
  right after a cross-project sidebar focus, when the connect-time SSH reconcile landed a
  second after fitView centered the node).
- **Project order = array order**, and it is ONE order shared by the tab bar and the sessions
  sidebar (the sidebar no longer hoists the active project to the top). Both surfaces reorder
  via drag-drop through `reorderProject(draggedId, beforeId|null)` (null = to the end; tab
  strip empty area and sidebar body are the end-drop zones), persisted like any node reorder.
  Sidebar disclosure is **persisted**, for group frames as well as projects:
  `settings.sidebarCollapsedItems` maps `project:<id>` / `project:<id>:group:<groupId>` → collapsed
  (`isGroupCollapsed`), and `settings.sidebarAutoCollapse` (default on) now only supplies the
  DEFAULT for a project row nobody has toggled (on = active expanded / others collapsed, off =
  everything expanded). **This deliberately replaced the old "a project switch resets every manual
  toggle" effect** (2026-08, with the nested sidebar tree): a tree the user shaped by hand should
  still be that shape after a restart, and one transient rule for projects plus a sticky one for
  frames would have been two contracts in one list. `projectHeadClickAction` is unchanged — an
  inactive project row switches, the active one toggles its own (now persisted) collapse — and
  every write **prunes** keys that no longer address a live project/frame (`pruneCollapsedItems` /
  `liveCollapseKeys`), because settings.json is forever and a canvas churns through group ids.
- The bottom-left **canvas lock** freezes the CAMERA only (pan/zoom): nodes stay draggable,
  resizable and connectable while locked — the point is "stop the map sliding", not "freeze
  the work". It is **transient by default and opt-in to remember**: a lock that survives a
  restart reads as "the app is frozen" to whoever opens the app next, and the lit button is a
  small thing to spot, so `settings.rememberCanvasLock` (Behavior, default OFF) is what turns it
  into a preference. The bit itself lives in localStorage (`nodeterm.canvasLocked`,
  `renderer/lib/canvasLock.ts`) beside the view mode and the explorer pin, never in settings.json
  and never in the git-shared `project.json`: the SETTING says whether to remember, the lock is
  one person's view state. Note the two tiers differ per surface: on Desktop both are
  machine-local, but in the **Server Edition** the setting rides that server's settings.json
  (shared by every browser hitting it) while the bit is per browser PROFILE, so two profiles can
  legitimately disagree about the lock. Desktop + Server Edition; **Mobile: N/A** (no canvas).
  **The lock covers middle-drag on NODES too, and ⌘/Ctrl+middle-drag gets past it** (issue
  #1130, `renderer/lib/modifierPan.ts`). React Flow's zoom filter accepts a middle-button
  `mousedown` on a node / edge / selection before it reads `panOnDrag`, so turning `panOnDrag` off
  never stopped a middle-drag that started on a node header or a terminal's hover guard (the xterm
  itself was only safe by accident, via the #84 middle-click guard). While locked,
  `installLockedMiddleGuard` stops a middle `mousedown` in the BUBBLE phase on
  `.react-flow__viewport` — after the node (tmux, the middle-click paste setting) has seen it, before
  React Flow's listener on an ancestor. `installModifierPan` is the deliberate way past the lock:
  ⌘+middle-drag (Ctrl off-mac) pans anywhere, locked or not, by cancelling the pointerdown in the
  capture phase on the flow wrapper (so no `mousedown` reaches d3, d3-drag or xterm). The
  `canvas.toggleLock` command ships UNBOUND (⌘⇧L is the sessions sidebar's) and, like every canvas
  command, does not fire while a terminal has the keyboard.
  It is one GLOBAL bit rather than per-project
  because `<Canvas />` is mounted once and is not keyed by project, so the lock always carried
  across project switches within a session. Restore is gated on settings HYDRATION (Canvas mounts
  first, so a `useState` initializer would read the default and the opt-in would silently never
  work) and latched to the first run, so switching the setting on mid-session never reaches into
  storage and locks a canvas somebody is working on.
- Before any project switch / add / delete, `commitActiveToStore()` serializes the live
  React Flow nodes back into the store, so nothing is lost. Then disk is written. The commit is
  guarded by the epoch tag `nodesProjectIdRef` (`canCommitCanvas`), and **that tag must live in
  React STATE beside the nodes** (`canvas/nodesEpoch.ts`), never in a ref alone: the load effect's
  `setNodes(flow)` is a DefaultLane update, every zustand write after it is a SyncLane re-render
  that skips it, and the render-time `nodesRef` mirror then paired the PREVIOUS project's nodes
  with the NEW project's tag. A commit in that window wrote an SSH project's 7 nodes over a local
  project's 18 in its `.nodeterm/project.json` (2026-09-26). `nodesEpoch.test.tsx` reproduces the
  interleaving with real React (no `act`, which would flush both lanes together and hide it).
  **The refs are the LATEST pair, not the last rendered one**: the tag ref is written only by
  `installEpoch`, and a render copies its `nodes` into `nodesRef` only when that state CHANGED and
  the render belongs to the installed epoch. An unconditional mirror rewound both refs to the
  outgoing project in that window, and a peer's `canvas:mut` for the incoming (active) project was
  applied to the outgoing nodes and queued after the load — the canvas ended on A's nodes plus the
  op, tagged B, and the next commit wrote them into B. So the receive path routes by
  `liveCanvasHolds` (tag AND active id; otherwise the store) and queues a FUNCTIONAL update
  (`rebaseOnLatest`). Consequence for readers: code pairing the tag with the RENDERED `nodes`
  (a render-time publish, an effect keyed on `nodes`) reads `renderedProjectId`, never the ref.
- **The node subtree's session follows the project whose nodes React Flow's STORE holds**
  (`useFlowStoreOwner`, `canvas/flowStoreOwner.ts`), never `activeProjectId`. xyflow copies the
  `nodes` prop into its store in a PASSIVE effect and `ReactFlowProvider` sits above the keyed
  `SessionProvider`, so a key that flipped with the active id remounted the OUTGOING project's
  nodes under the INCOMING session for a commit: a team tab's terminals were created on this
  desktop's own core, and a local terminal on the relay host. Each array handed to
  `<ReactFlow nodes>` is recorded against `renderedProjectId` and the store's array is looked up
  (unknown ⇒ the last known owner); the same id feeds `OwningProjectContext`. A local → local
  switch keeps the key `'local'` (no remount). A session-changing remount now lands one commit
  AFTER the load applied the project's camera and builds a fresh pan/zoom, so `<ReactFlow>` gets
  `defaultViewport={viewportRef.current}`, or the switch resets the camera to the origin. For the
  same reason the load's settle timer must not frame or read the incoming nodes itself: the
  pending focus / "Open recent" resume / `nodeterm://` link it finishes run through
  `useFlowLanding` (`canvas/flowLanding.ts`) once the owner IS that project — React may run the
  store copy's passive effect after a due timer, which then framed the pan/zoom the remount
  destroys and read the outgoing copy of a shared node id. The rule holds for a local → local
  switch too (no remount, but the owner still flips). A caller that would create and frame AT ONCE
  (`resumeWhenLanded`, `runLinkOpen`) must also ask `flowLanding.holds(projectId)`, never the epoch
  tag alone: after "Open folder & resume" or a link that opens a new folder, the switch is the
  folder open's last synchronous step, so the `.then` runs after the load effect installed the tag
  and before the store copy — every time, not by chance. Otherwise it leaves the work in
  `pendingResumeRef` / `pendingLinkRef` for the landing. A throw inside a landing is logged, never
  rethrown: it runs in a passive effect and `<Canvas />` has no error boundary.
  `flowStoreOwner.test.tsx` replays the switches through real React Flow, the timer firing inside
  that window and the folder-open continuation included.
- **A remote project's node never starts on this core, whatever it is mounted under** (bug F: a
  team tab's terminals were created as LOCAL tmux sessions here). The node itself cannot say so: a
  project shared from SSH with a team is ADOPTED by the host (`localizeAdoptedNode` drops
  `sshRemoteTmux`/`ssh`/`sshFs`), so its nodes reach the tab as plain terminals. Do NOT re-stamp
  `sshRemoteTmux` onto them — the host's core would then refuse its own sessions (`requireRemote`
  with no master of its own: `held-elsewhere` for a live one, a refused spawn otherwise). Three
  layers besides the keying above:
  (1) `sessionForProject` resolves a REMOTE project (`remote` in the store; once the store no longer
  holds it, bound while remote in this run) with no live binding to the OFFLINE relay session
  (`OFFLINE_RELAY_SESSION_ID`, `session/offline-relay-session.ts`: `source 'relay'`, `status
  'offline'`), never the local one.
  Its core-bound calls (pty, fs, git, workspace, …) reject, so no terminal can be created here; it
  is not a wall around this machine, since its api spreads `...local` like a live relay tab's (the
  local namespaces — contextLink, transcripts, handoff, media — still act here, and its `boardLog`
  read answers `unsupported`). "Is this project remote?" is ONE predicate, `isRemoteProjectId`
  (session.ts), shared by this resolution and the spawn refusal in (3). Lifecycle code asking "which
  session is bound to this tab?" (dispose it, reconnect it) asks `boundSessionForProject`, which
  never answers the sentinel.
  (2) A surface that mounts a project's node OUTSIDE Canvas's node subtree runs under that project's
  session. Both kanban boards render under App's LOCAL provider, so each mounts its card modal
  through `ProjectSessionScope` (`session/owning-project.ts`: `sessionForProject(<card's project>)`,
  keyed by session id, plus `OwningProjectContext`). Before it, opening a team tab's terminal card
  created the host's node id on this desktop every time. The terminal, the comments, the metadata
  strip and the pull-request panel now act on the card's project (`useOwningProjectId() ??
  activeProjectId`): the terminal runs under the card project's session, the comments panel reads
  and writes that project's board log, the metadata strip's member pool reads it, and the
  pull-request panel reads that project's pull requests, SSH flag and auto-move target. On the Omni
  board a lane is not the active project: pairing the lane's api with the active id blanked a relay
  lane's comments and saved new ones nowhere, and on a local lane filed them into the ACTIVE
  project's board log. A relay card's file links are switched off (`cardFileLinkRoute`) and its ⌘M
  chat is refused (`stub.chat`, `E_UNSUPPORTED`). **Known exceptions (pre-existing, follow-up):** the
  icon picker (`NodeIconPicker.chooseImage` resolves the ACTIVE project, so a team lane's card
  opened while a local project is active copies the picked image into the local project's
  `.nodeterm/images/`), and dictation and file-drop uploads in a relay card, which act on this
  machine. The session is resolved at render, so a reconnect while a modal is open takes effect at
  the board's next render.
  (3) TerminalNode and ModalTerminal ask `spawnBelongsElsewhere(isRemoteProjectId(owner),
  session.source)` (`owner` from `OwningProjectContext`; the predicate is the one (1) uses, so a tab
  the store deleted still counts) before any SSH resolve or create: a remote project under a
  non-relay session starts nothing and writes a gray "belongs to a remote project that is not
  connected here" line. ModalTerminal mirrors TerminalNode's `dialsSsh` (a relay card's SSH-project
  node is joined by the HOST with `requireRemote`; this machine dials, refuses and reports nothing
  for it), and a non-dialing node's `ownerProjectId` is the owning project, else the active one.
  `components/kanban/cardModalSession.test.tsx` renders both boards with real sessions and a probe
  in place of CardModal, asserting which session and owning project each modal mount gets, plus
  source pins for the two terminals; `components/kanban/boardLogPanelSession.test.tsx` and
  `cardOwnerProject.test.tsx` render the real comments panel, metadata strip and pull-request panel
  under a lane's `ProjectSessionScope`; `session/offline-relay-session.test.ts` replays the switches.
- Switching away unmounts the old project's `TerminalNode`s → their tmux clients detach but
  the sessions keep running; switching back reattaches. tmux session names are per-node-id
  (globally unique), so projects never collide.
- The tab caret menu's **Close project** (`closeProject`) is **non-destructive**: it sets
  `project.closed = true` (hidden from the tab bar, kept on disk with all nodes) and leaves the
  tmux sessions running, so closing just detaches like a project switch. Closed projects are
  reopenable from the **"Recently closed"** list on `WelcomeScreen` (`reopenProject` → restores
  nodes, which reattach warm or cold-restore). `hasProjects` counts only **open** projects, so
  closing the last open one shows the welcome screen. **Permanent** deletion (`deleteProject`:
  `transport.destroy(nodeId)` per terminal + drop agent status + SSH teardown) now only happens
  via the `×` on a "Recently closed" entry. **Closing now SAYS what it parks** (issue #442 —
  "close" read like cleanup while meaning "hide, and keep running"): a project with terminal
  nodes gets a confirm naming the count, with an opt-in **"end its sessions too"** checkbox
  (default OFF — parking stays the rule; checked flips the confirm to danger). The pure half is
  `renderer/lib/projectCloseSessions.ts`: **one definition of N** — the project's terminal-kind
  nodes, exactly the set the action addresses (`transport.destroy` is idempotent on a dead
  session), never a liveness-verified count that could disagree with the action; the END happens
  at confirm time against the re-resolved node set (agents spawn nodes on their own). A relay tab
  or a 0-terminal project closes silently (byte-identical old path). `endProjectSessions` mirrors
  `deleteProject`'s teardown EXCEPT it keeps agent status (the persisted sessionId is what lets a
  reopen cold-restore `--resume`) and never disconnects SSH masters (close never managed the
  connection). The `×` also confirms now, via `deleteConfirmCopy` — a relay tab gets "removes
  only this machine's view; reconnecting brings it back" with no danger styling (deleting the
  view is what turns the next connect into a first-connect re-adopt), local/SSH get the session
  count + "the folder (incl. .nodeterm/project.json) is not deleted". And "Recently closed" rows
  show a **live-session badge** (`closedSessionCounts` over ONE on-demand local
  `sessionMemory.read` per welcome-screen appearance — never a timer; `ok:false` ⇒ no badge,
  never "0"; an SSH project's host-side sessions are deliberately not claimed by the local
  count). Server Edition: all renderer-side; the ws-bridge `sessionMemory` is real, so badges
  describe the server machine; the `sshProject` legs only run for `project.ssh`, which that
  shell never has.
- **Closing a NODE keeps a pointer to its transcript** (issue #531). The per-project
  `closedSessions` ledger records the agent session id as `ClosedSessionEntry.sessionId`, captured
  at delete time from the live `agentStatus` entry — which that same delete drops, so this is the
  last instant it exists anywhere — falling back to the minted `node.agentSessionId`. It is a
  POINTER, never a copy: the `.jsonl` the agent CLI owns stays the only text, and a second store of
  transcript text would age, drift and need its own retention policy. The "Recently closed" row
  spends it on the **existing ⌘M reader** (`ChatPanel` in `readOnly` mode, hosted by
  `ClosedTranscriptDialog`), so resolution, the `{found}` vs empty distinction and Retry cannot
  drift from the live-node path. Two rules: it rides `IndexEntryV3.closedSessions` and is therefore
  **machine-local** — a session id is a `$HOME`-anchored fact about one person's machine, and
  `projectToFile` must never emit it — and it is **re-checked as a string** in
  `sanitizeLoadedClosedSessions`, because workspace.json is hand-editable and the value goes
  straight to a resolver. `closedTranscriptTarget` (pure) owns the refusals and NAMES each: a
  REMOTE session is refused (its transcript is on the host; locating it over the ControlMaster is
  separate work and must not hold the local fix hostage) and a pre-#531 entry says its id was never
  recorded. Only the "this was never an agent" refusal may render as nothing — for the others a
  vanished control would leave the user believing that closing destroyed the record, which is the
  belief this exists to correct.
- A project's `cwd` (folder picker, `dialog:select-folder`) is passed to terminal/Claude
  node factories so new terminals open there. **Folder ↔ project is deduped:** "Open folder…"
  reuses the existing project with that `cwd` (and its nodes) instead of creating a duplicate.

## Terminal session continuity (tmux)

`src/core/pty-manager.ts` runs each terminal inside a persistent tmux session
(`tmux new-session -A -D -s nt-<nodeId>`) on a dedicated socket (`-L node-terminal`) with
a generated config (`-f <userData>/tmux.conf`, so the user's `~/.tmux.conf` never
interferes; status bar off, **mouse on**, 50k history, `set-clipboard on` + `terminal-features
",*:clipboard"`, and the copy-mode mouse bindings). Because the tmux *server* outlives the app,
sessions survive when no client is attached. `src/shared/ssh.ts`'s `remoteTmuxConf` is the same
config for an SSH project's remote tmux.

**Exact tmux targets: every node id that becomes a `-t` goes through `exactPaneTarget` (`=name:`) or
`exactSessionTarget` (`=name`)** (`core/tmux-naming.ts`, security audit F1/F2, 2026-10). tmux resolves
a BARE target by exact name, then fnmatch, then PREFIX on a miss, and node ids end in a counter or a
random tail: with only `nt-term-abc-12` alive, `send-keys -t nt-term-abc-1` typed into it,
`capture-pane` read it and `display-message '#{pane_pid}'` named its process (measured, tmux 3.4).
That made every node-keyed verb (send-text, typed chat input, send-keys, capture, pane command/cwd,
pane owner, terminate-foreground, has-session, the control-mode shadow, an attach-only reattach) a way
to reach a DIFFERENT node, whether its own session was gone or the id was a relay peer's invention.
For an existing session `=name:` is the same pane the bare name was (current window, active pane,
re-measured with three windows and a split). An exact miss is `can't find session` (exit 1), except
`display-message`, which exits 0 with every format EMPTY — every parser here answers null for that.
On a REMOTE command line the target is single-quoted: zsh's EQUALS option expands a word starting
with `=`. Proven against a real tmux driving a real `PtyManager` (`pty-exact-target.realtmux.test.ts`).
A new tmux call site owes the same, and both helpers refuse a name `sessionName` did not produce.

**Every synchronous tmux call on main is bounded (`TMUX_BOOT_CMD_TIMEOUT_MS`, 2 s, via
`PtyManager.runTmuxSync`).** `ensureTmux`'s `source-file` runs before the first window exists, and
`ensureUpdateEnvKeys`' `show-options` / `set-option` run on a spawn; unbounded, a server that accepts
the connection and never answers held main for the wedge's whole lifetime (4.05 s in a repro, i.e.
forever against a server that never recovers). The bound kills only our short-lived
client (SIGKILL, so one that ignores SIGTERM cannot keep `execFileSync` waiting), never the server.
A timeout is `console.warn`ed and fails open (tmux stays resolved; the spawn goes ahead); "no server
yet" stays silent, as it always was. A timeout also ends the rest of that call's tmux work — the
next `set-option` would only wait out the same wedge — and a `show-options` / `set-option` timeout
starts `TMUX_UPDATE_ENV_COOLDOWN_MS` (60 s) in which `ensureUpdateEnvKeys` makes no tmux call at
all: every spawn passes the account-scope names, so without it each later spawn on a slow server
would stall main again (20 terminals ≈ 40 s). After it, the next spawn probes again. Proven against a real client in
`pty-tmux-wedged.realtmux.test.ts`. A new sync tmux call goes through `runTmuxSync`, not a bare
`execFileSync`.

**Every REMOTE tmux invocation starts with `remoteTmuxPathPrologue()`** (`shared/ssh.ts` — PATH
**append**: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `$HOME/.local/bin`): an ssh
exec channel gets a non-login shell, and on a macOS host Homebrew's `shellenv` lives in
`~/.zprofile`, so a host whose own terminal runs tmux fine answered
`zsh:1: command not found: tmux` to every command of ours (issue #449 — the same class as the
remote claude probe's login-shell + PATH fix). Append, never prepend: a PATH that already resolves
tmux keeps exactly that binary, so nothing re-pairs a long-lived tmux server with a different
client build. When tmux is genuinely absent the interactive spawn (`tmuxOrExplain`,
`control-master.ts`) prints what is missing, how to install it and what a tmux-less remote loses,
then degrades to a plain login shell — mirroring the local plain-shell fallback; the raw
`command not found` line must never be the user-facing error again.

**tmux owns the mouse — scrolling, selection, and the alternate screen are all its job.** This is
the native behavior, and it is deliberate:
- **The wheel scrolls tmux's own history** (`history-limit`), not the emulator's buffer.
- **The pane is on the alternate screen** (`\e[?1049h`) — capabilities are NOT blanked — which is
  what keeps a full-screen TUI's input box *put* instead of scrolling away with the text.
- **Selection is tmux copy-mode.** A drag copies; apps that request mouse tracking themselves
  (vim, htop) still get their own mouse events — tmux forwards those regardless.

**Do not take scrolling away from tmux again.** A previous design did exactly that (`mouse off` +
`terminal-overrides ',*:smcup@:rmcup@:indn@'` to keep tmux on the *normal* screen, so its output
flowed into xterm's scrollback, which was then hydrated from `tmux capture-pane` on reattach). It
failed structurally: **tmux is a screen PAINTER, not a stream.** Every redraw (attach, resize,
refresh) erases and repaints, so blank and duplicated rows leaked into the emulator's scrollback —
users saw black bands and duplicated screens when scrolling up — and the pane stopped behaving
natively. The hydration that design needed is gone (see the reattach seeding below).

**Copy → the system clipboard, via OSC 52.** `set-clipboard on` **plus** `set -as terminal-features
",*:clipboard"`: on copy, tmux emits OSC 52 to the attached client, and the renderer's OSC 52
handler (`parseOsc52` in `terminal/osc52.ts`, applied in `TerminalNode.tsx`) writes the system
clipboard. Two traps, both measured on
tmux 3.4:
- **The `terminal-overrides ',xterm*:Ms=…'` entry does NOT work on tmux 3.2+** — with it, a copy
  emitted **zero** OSC 52 to the client. `terminal-features` is what actually enables the sequence.
  Do not "fix" the `Ms=` override back; it is why copying from SSH sessions never worked.
- **No `pbcopy` pipe.** The copy-mode bindings are bare `copy-pipe-and-cancel` (no command): piping
  to `pbcopy` was macOS-only, and over SSH it would have copied on the *remote* host anyway. OSC 52
  is cross-platform and works over SSH.

**Copy-on-select (opt-in, `copyOnSelect`, default off — #759)** is the route for a selection
**xterm** owns, which OSC 52 never sees: a plain drag on Windows (no tmux), a forced Option/Shift
drag inside a mouse-tracking app. `terminal/copy-on-select.ts` triggers on the GESTURE (a press
xterm's SelectionService takes, then a release anywhere), not on `onSelectionChange` — the search
addon's `select()` must never touch the clipboard. Canvas node and kanban modal only, never the
settings preview; attached once per xterm (it survives park/adopt) and written via the bridge's
`{ quiet: true }` path so a failed write raises no toast per drag.

**Every viewer answers the tmux client's handshake; only one answer may reach it** (issue #1172).
A new tmux client queries the terminal it is drawn in (DA1 `ESC[c`, DA2 `ESC[>c`, XTVERSION, OSC
10/11 — measured on 3.4). With N viewers on one pty (two Server Edition tabs, a canvas node plus its
kanban card modal, a relay peer) all N xterms answer; tmux consumes ONE DA answer inside its ~5 s
query timeout and passes the rest — and a lone late one — to the pane as typed input, so
`1;2c0;276;0c` landed in front of agent launch lines (the echo check passes: the line itself is
intact) and in live prompts on every reattach. OSC replies are always consumed by tmux. The gate is
`core/da-reply-gate.ts`, per Session, fed from `proc.onData` and applied in `PtyManager.write`: a write
made ONLY of DA1/DA2 replies spends one open query of its kind per reply, and a reply with no open
query (a duplicate, an unsolicited one, or one past `DA_REPLY_TTL_TMUX_MS` = 4 s for a real tmux
client) is dropped. Rules: match only `CSI ? … c` / `CSI > … c` — no key produces them, while a
broader report match eats keystrokes (`ESC[1;2R` is CPR AND Shift+F3); touch only whole reply-only
writes (xterm.js emits each reply as its own data event, so a mixed write is a person); never close
the gate for the session's life (a pane app's DCS-passthrough query shows up as the same `ESC[c` and
gets exactly one answer).

**One tmux socket per host, whichever side opens the project (2026-11).** An SSH project's sessions
live on the host's `node-terminal` socket — the SAME socket a nodeterm running ON that host uses
(`RMT_TMUX_SOCKET === TMUX_SOCKET`, pinned by `core/remote-ssh/unified-socket.test.ts`). Both sides
read the same `.nodeterm/project.json` and name every session `nt-<nodeId>`, so the socket was the
only thing keeping them apart: with its own `nodeterm-rmt` socket (2026-06 → 2026-11) a canvas opened
locally on the server and the same folder opened over SSH from a laptop were two tmux servers holding
same-named sessions that never saw each other, and every switch of machines cold-restored into a
fresh shell (field report; issue #1319 was the mobile half of it). The original "never collide with
the user's own tmux" rationale is satisfied by `node-terminal` already — the user's own tmux is on
`default`. `nodeterm-rmt` survives only as `LEGACY_RMT_TMUX_SOCKET`: the session-memory sweep, the
dev-ports sweep, the reaper and the by-name kill still list it so sessions an older build left there
stay visible as orphans and reapable/killable; nothing is spawned or re-attached there (a node whose
session is still on the legacy socket cold-restores onto `node-terminal`, exactly as after a host
reboot, and the old one shows up in the session-memory panel as an orphan). Do not give the SSH path
a socket of its own again. **Known limit, deliberately out of scope here:** hook events reach ONE
nodeterm — the endpoint baked into the session's env at creation, or the failover winner when that
one is dead (`agents/hooks/managed-script.ts`) — so a session two machines share shows its RUNNING /
NEEDS YOU badge on whichever side the hook reaches; the terminal and the work are shared, the badge
is not yet.

**A tmux client is not necessarily a watcher.** `SessionInfo.clients` is a COUNT
(`#{session_attached}`), never a boolean, because one session can hold several: the app's painter,
the user's own `tmux -L node-terminal attach`, a second nodeterm on the same socket, and our own
**control-mode shadows** (`PtyManager.shadowAttach`, used for background writes without spawning a
painter). The session reaper subtracts ours via the `shadowed` seam — a shadow is a real client but
not a watcher, so a shadowed session must stay exactly as cullable as an idle detached one.

The count is carried numerically rather than collapsed at parse time **because the subtraction
needs it**: a session holding our shadow AND a real client must still read as attached, and a
boolean could only be forced to false — reaping the session out from under whoever that other
client belongs to. **Any future reader of `list-clients` / `session_attached` owes the same
subtraction.**

Lifecycle, by intent:
- **Offscreen release (in place, 2026-08-11)** → a mounted node fully offscreen past
  `settings.offscreenTerminalMinutes` detaches its PTY client and disposes its xterm without
  unmounting (plate shown; tmux keeps running; reattach-redraw on approach, measured <500 ms).
  See the Terminal node lifecycle section for the two invariants (mount-stable observer;
  `session.source` remote gate). Note the released node is a DETACHED tmux session — it joins
  the session reaper's candidate pool (6 h grace still protects it).
- **A hidden window counts as offscreen (2026-10)** → close-to-tray (the Windows default), macOS
  hide-on-close and minimize send `app:window-visibility` (`main/window-visibility.ts`); the
  renderer flag (`terminal/window-backgrounded.ts`) makes every node report itself offscreen
  through the SAME mount-stable observer path, so the release runs at `min(offscreen setting,
  BACKGROUND_RELEASE_DWELL_MS = 2 min)` behind every existing gate (live-work, held launch, Eco,
  remote, selected, `0 = never`); after that dwell Canvas runs the memory-pressure reclaim pair
  (`runReclaimLevers`), which now frees the on-screen terminals' WebGL contexts too because they
  all read hidden. Show cancels the dwell and revives warm. It feeds existing levers — it is not a
  new one — and an occluded window or a Server Edition tab switch never triggers it (explicit IPC,
  not `visibilitychange`; the bridge declares it a no-op). Eco and the liveness poll see a hidden
  window as "nobody watching" too. **A raw Electron `hide` is NOT the signal**: on macOS
  `BrowserWindow` emits `hide`/`show` from occlusion changes (a window merely covered by another
  app, another Space, ⌘H), so main forwards `hide` only when the close branch set
  `windowHiddenByApp` before its own `win.hide()`; `minimize` always counts. A focused renderer
  clears the flag (fail-safe for a WM that restores without a `restore` event).
- **Every memory lever must ask whether the kill ends live work** (`terminal/live-work.ts`). The
  renderer reclaims terminal memory in FOUR places — park window expiry, the park's LRU cap, the
  memory-pressure drop (all three in `park-budget.ts`) and the offscreen viewer release
  (`offscreen-policy.ts`) — and all four were written as if dropping a PTY client were free,
  because "the tmux session keeps running and re-attach redraws". **That sentence is only true
  where tmux is actually underneath.** On the plain-shell fallback (no tmux installed, tmux
  switched off in settings, or an install path `findTmux` missed) the pty IS the shell, so the
  identical call kills it and everything under it — an agent CLI mid-turn included. Issue #126: a
  project switch terminated a working Claude agent, which then auto-resumed from wherever the kill
  landed. The predicate is deliberately the narrowest one that closes it — a tmux-backed session is
  never protected (the kill costs a redraw), and neither is a plain terminal. **An IDLE agent CLI on
  a non-persistent pty IS protected** (`agentProcess`, `agentProcessInPane`; not once hibernated,
  paused, dropped, or once its CLI announced a SessionEnd, `sessionEnded`, which is its own
  transient flag because `state: undefined` alone is also what an idle agent looks like): killing it looked free because cold restore `--resume`s it on revive, but the
  resumed CLI fires `SessionStart:resume` and idles with no further hook event, the status mirror
  leaves it unverified, and agent messaging refused it for as long as it stayed idle — measured
  2026-09-13 on Windows native ptys. The mirror now also lets a verified `idle_prompt` right after a
  verified `SessionStart` commit a verified non-inferred `done` (`MirrorEntry.sessionStarted`), and
  the decider reports a proven node reset by a boundary as `targetNotIdleUnknown`, not
  `targetStatusStale`. **A fifth lever owes the same gate.**
  The fifth is the offscreen release of an ARMED node (`shouldDeferReleaseForHeldLaunch`):
  held launches now require the attached transport for echo verification, on every backend.
  Keep that transport until delivery or recovery; a blind paste by session name loses the
  shell-init repair and canonical-line protections.
- **Node unmount (project switch)** → the RENDERER **parks** the terminal (`TerminalNode.tsx`
  `parkedTerminals`): the xterm instance + its attached PTY stay alive with the `.xterm` element
  detached from the DOM, so a remount within the park window re-adopts them — instant, and
  exact (the tmux client never detaches, so mouse-tracking/alternate-screen modes and scrollback
  carry over; do NOT "optimize" this into a respawn+redraw — a fresh xterm on a reused client
  misses the attach-time mode sequences and breaks scrolling). The park timer then runs the real
  teardown: `kill()` detaches the PTY client; the tmux session keeps running. **Window and cap
  are settings (issue #886)**: `settings.terminalParkMinutes` (default **10**, raised from 5; **0 = until app quit** —
  `parkWindowMs` returns `null` and NO timer is armed, never `Infinity`, which `setTimeout` clamps
  to ~1 ms and would dispose every park at once) and `settings.terminalParkMax` (default **20**, raised from 12), both
  re-validated at park time. The LRU cap evicts **local parks before remote ones**
  (`planParkEviction`'s `isRemote`): a local re-adopt miss is a warm reattach in ms, an SSH one is
  a new client per terminal paced 4-per-master, plus a login if the master idled out
  (`ControlPersist`) — and a live parked client is also what keeps that master from idling out.
  Parking does not raise sshd `MaxSessions` pressure: masters are per project, so a parked SSH
  project holds exactly the channels it held while in view. Measured (headless xterm, 200×50): a
  parked tmux-backed terminal ≈ **2 MB** (alternate screen, empty normal buffer — tmux owns the
  history); a plain shell with a full 10k scrollback ≈ **27 MB**. WebGL contexts are
  **viewport-scoped and budgeted** (browsers cap ~16 live contexts, and a canvas holds far more
  terminals). A per-terminal `IntersectionObserver` (`rootMargin` pre-announces approach) only
  REPORTS visibility to a **module-level budget coordinator** (`terminal/webgl-budget.ts`) that owns
  every grant decision and all timing: it keeps the contexts WE hold at/under the live budget
  (`WEBGL_BUDGET` 12 default — the browser Server Edition; on DESKTOP main raises Chromium's cap
  itself via `--max-active-webgl-contexts` = 32 and boot raises the budget to 24 via
  `setWebglBudget`, constants in `src/shared/webgl.ts`) so
  the browser never has to **force-evict** — which is the bug that flashed Chromium's dead
  "lost context" placeholder (white box + sad-face) on a visible terminal during a fast pan / zoom
  out, because the old per-node observers each acquired independently and momentarily overshot the
  cap. Rules: a client granted only after an **acquire debounce** (`WEBGL_ACQUIRE_DEBOUNCE_MS`, so a
  pan-through never grabs a context for a two-frame flash); if granting would exceed the budget,
  **reclaim on demand from the least-recently-visible HIDDEN holder** (`hiddenAt` LRU order);
  if every holder is currently visible (zoomed way out), the newcomer is NOT granted and **stays on
  the DOM renderer** — we never push past the budget. A hidden holder keeps its context
  **indefinitely** (warm for a pan-back of any length) — there is no time-based release; it is
  reclaimed strictly on demand, either by a visible newcomer that needs its slot or by
  `releaseAllHiddenGrants` (queued through the drain) under memory pressure. `acquire()`
  returning false (WebGL2 unavailable) doesn't burn a slot; an externally-lost context
  (`onContextLoss`) is reported via `handle.contextLost()`, drops from the accounting, and — for a
  still-VISIBLE client — schedules ONE delayed budget-gated re-grant (sleep/wake GPU resets lose
  every context at once with no visibility change; without this every woken terminal sat on the
  DOM renderer until panned out and back). The NODE still never re-acquires itself (that loop is
  the eviction fight the design fears): the retry goes through `tryGrant` — never exceeds the
  budget, never reclaims a visible holder — and stops after `WEBGL_LOSS_STREAK_MAX` consecutive
  losses (visibility transition resets). The node registers via `registerWebglClient` on mount
  and `handle.dispose()`s on unmount (which releases + cancels timers). A parked terminal is
  off-screen so it holds no context. Permanent-delete paths call `disposeTerminalOnUnmount(id)` so a
  deleted node disposes instead of parking.
  **A renderer released while the node is unmeasurable mismeasures its own row spacing**
  (`terminal/dom-renderer-spacing.ts`): `WebglAddon.dispose()` is also the back-to-DOM-renderer
  path, and it runs from the lifecycle effect's CLEANUP — after React detached the element — so the
  fresh DOM renderer derives `letter-spacing` from a width cache whose `offsetWidth` is **0** and
  bakes in a whole extra cell per character. That is the "letters drift apart for a split second
  after a project switch": the adopting mount paints wide until the WebGL grant lands 150 ms later.
  Focus mode's `display:none` wrapper is the same shape. xterm re-derives the spacing on a char-size
  / dpr / options change and **not on a resize**, so nothing in the reattach path heals it —
  `applyFit` calls the change-gated `resyncDomRendererSpacing(term)`, which bails while the
  measurement is still 0 rather than re-baking the wrong number.
  **Which renderer a terminal uses** is `settings.terminalGpuRendering`, resolved by the single
  resolver `resolveTerminalRenderer(value)` (`src/shared/webgl.ts`) to `dom | webgl | shared`:
  `'off'` = xterm's DOM renderer, `'on'` = one budgeted WebGL context per terminal (everything the
  paragraph above describes), `'shared'` = **glyphgrid**, ONE canvas-wide WebGL2 context every
  terminal paints into (`src/renderer/glyphgrid/`, reached through `terminal/glyphgrid-attach.ts`;
  the per-terminal budget is OFF in this mode). `'auto'` (the default, and what legacy/unknown values
  fall back to) = **`webgl` on EVERY platform**, macOS included. The macOS branch has moved twice:
  it was `dom`, then `shared` on 2026-08-05 (per-terminal WebGL composited terminals black after
  zoom-out bursts, blamed on the OS compositor), and is now `webgl` — the blackout was root-caused
  not to context count but to a dependency skew (addon-webgl 0.19's dispose crashed on the 5.5 core
  and aborted its own DOM-renderer restore; pinned + healed, see
  `renderer/terminal/webgl-addon-pair.test.ts`). What actually guards macOS is a lower budget,
  `WEBGL_BUDGET_DESKTOP_MAC` (16, vs 24 elsewhere), capping compositor pressure at every zoom. The
  four-way setting stays as the escape hatch: `'shared'` is now opt-in only (also where the macOS
  default points back if the one unconfirmed 2026-07-30 whole-window-flicker report recurs), and
  `'off'` drops GPU rendering entirely.
- **Window close / app quit** → clients detach (`PtyManager.killAll()`); the tmux session keeps
  running. `killAll()` deliberately does NOT kill sessions.
- **Window close off macOS = background mode** (`settings.runInBackgroundOnClose`, `'auto'` = on for
  Windows, off for Linux; `resolveBackgroundOnClose` in `main/background-mode.ts`): the × HIDES the
  window into a notification-area tray (`main/tray.ts`, pure model `tray-model.ts`: Open / unread /
  phone-access status / Quit) so the phone relay host, hook server, notifications and updater keep
  running — the Dock analogue. A hide is not a quit, so no confirm dialog; tray **Quit** is plain
  `app.quit()` (before-quit + confirm run as for the menu Quit — File → Exit on Windows, where
  Electron's quit role has NO Ctrl+Q accelerator; never set `quitting` before it, a cancelled
  confirm must leave the × hiding). Hide only while the tray actually EXISTS
  (`backgroundOnCloseActive`), so a failed tray never turns × into a hide with no way back. The
  updater/update-prep quits keep flipping `quitting` first, or a hidden window would block them.
  First hide posts a one-time toast (userData marker file, not a settings key — the renderer's
  full-snapshot saves would overwrite a main-side settings write).
- **Node reopen / app relaunch** (nothing parked) → a new PTY attaches to the same
  `nt-<nodeId>` session and tmux redraws current state.
- **User clicks ×** → `destroy(persistKey)` runs `tmux kill-session`, permanently ending it. For a
  REMOTE node it kills the remote session **and then the local one of the same name** — normally a
  no-op, but it reaps the orphan the pre-`requireRemote` local fallback below could leave behind.
  **Whether a node IS remote is answered WITHOUT a live session** (`core/remote-end.ts`,
  `planRemoteEnd`). `runEndSession` used to read it off the dying `Session` alone
  (`dying?.sshRemote`), and its comment claimed "both callers run while the session is still live"
  — which is false for the case that matters: a delete arrives precisely when there may be nothing
  attached (an app restart, the offscreen release, the 5-min park expiry, a project that is not
  even open). `dying` was then `undefined`, remoteness read as "local", the remote branch was
  skipped **in silence**, and the one kill that went out went to the LOCAL socket, where a
  `requireRemote` node has nothing at all. Everything else about the teardown ran, so the node left
  the canvas looking deleted while its `nt-<id>` kept running on the host — a leak with no surface
  anywhere. The durable answer is the machine-local index: the shell wires
  `PtyManager.setRemoteNodeOwner` to `workspaceStore.sshProjectIdForNode` + that project's
  ControlMaster (`refForProject`). A LIVE `sshRemote` still wins when there is one — it is the exact
  master the session was spawned over, and a node created seconds ago may not be in the index cache
  yet — so the two sources are complementary, not redundant. The Server Edition wires no resolver
  (it has no SSH-project manager) and its deletes stay on the local path unchanged.
  **And the kill is CHECKED.** The old `catch {}` read "remote session may not exist / master down;
  ignore", which are not the same fact: tmux's own exit 1 ("can't find session", `probeSaysAbsent`)
  is an ANSWER, while ssh's 255 / a 127 / a spawn error is a NON-answer with the session still
  running. A non-answer — and a node whose project has no master at all — is **recorded**
  (`core/pending-remote-kills.ts`, atomic JSON under userData, keyed by `user@host` because several
  projects share one host's tmux server) and settled the next time that host connects
  (`SshProjectManager.settleOwedKills`, hung on the shared connect attempt so the REUSE branch pays
  too; an entry is dropped only on tmux exit 0 or 1). The delete itself is **never refused** over an
  unreachable host: the node is going, and a refusal strands it on the canvas with the same session
  still running plus a dialog — the user answers that by deleting it again. That trade is only
  defensible BECAUSE the debt is durable; drop the store and refusing becomes the honest option.
  **Only a `delete` may owe a debt.** A `recycle` keeps the node (worktree move, model switch,
  "pause & end session"), so a kill deferred to a later reconnect would land on the session that
  node has since RESPAWNED under the same name — ending live work hours after the action that
  queued it, with nothing on screen connecting the two. A recycle still ATTEMPTS the remote kill;
  it just records nothing when it cannot land, exactly as before.
- **A remote node is NEVER spawned locally** (`PtyCreateOptions.requireRemote`). `sshRemote` says
  "here is the master to run over"; `requireRemote` says "and if there isn't one, spawn NOTHING".
  Without it, a create with no `sshRemote` falls through to core's local tmux/plain-shell branches
  — which is how an SSH project's terminal opened while the ControlMaster was down (no network,
  host unreachable, `ssh` missing) quietly became a LOCAL shell in the local `$HOME`: same node id,
  same `SSH user@host` header chip, the REMOTE session's scrollback snapshot replayed into it, and
  — for an agent node — a cold-restore `claude --resume <remote session id>` running on the wrong
  machine under the local account, leaving an orphaned local `nt-<id>` behind. Refused on both
  sides: the renderer never calls `create` when `resolveSshRemote` came back empty
  (`CoState.offline` + the node's Reconnect button), and core refuses in `spawnNew`
  (`PtyCreateResult.unavailable`) so a master that dies inside the round-trip can't sneak through.
  The spawn refusal is in `spawnNew`, and `join` refuses (`'held-elsewhere'`) a `requireRemote`
  create whose held session is local or on another host (host, user, or port differs) — a join to
  the SAME remote's live session (a second view over the same endpoint) still attaches, and so does
  a create that names no `sshRemote` onto a held remote session (its master momentarily down, or a
  relay tab's create on the host, which carries none). The held session is never killed. A relay /
  team tab's node, which may carry no `sshRemoteTmux` at all, is kept off this core by the session
  it runs under plus a renderer-side `spawnBelongsElsewhere` refusal (Projects (tabs)). An
  offline node reports itself to `SshReconnector`, so the canvas heals itself; `retryNow` (banner
  Reconnect / node Reconnect) skips the backoff and clears the refuse window.
  **Whether a node is remote comes from its PROJECT, never from its own fields** (issue #1186,
  `@shared/ssh-project-nodes`). `requireRemote`/`sshRemoteTmux` used to be stamped only by this
  machine's node factories, but an SSH project's `project.json` lives on the host and other writers
  put nodes into it — above all the host's own desktop, which opens the same folder as a LOCAL
  project (`cwd: "."`, no `ssh` fields). Such a node ran on the VIEWING machine in an unrelated
  folder, under the id the host was running. Three layers: (1) `fileToProject` routes every session
  node of an SSH project to the project's host (`routeSshProjectNodes`: `ssh` = the project server,
  `sshRemoteTmux`, cwd resolved POSIX-style against `remoteCwd`; editor/video/files get `sshFs`),
  and `persistedCanvases` / `getNodeResolved` read the cache the same way; (2) `projectToFile`
  writes the SSH mirror NEUTRAL (`neutralSshProjectNodes` drops those fields, cwd back to `./x`),
  because the file is shared LAYOUT — a node stamped "runs over ssh on <host>" cannot run on the
  host's own desktop at all; (3) core refuses a local spawn whose `ownerProjectId` is an SSH project
  (`PtyManager.setSshProjectCheck`, wired in BOTH shells from the index) even without
  `requireRemote`. Kept as written: a plain `ssh <host>` terminal (`ssh` without `sshRemoteTmux` —
  `shell: 'ssh'` at the spawn) and a foreign host ATTACHMENT (`sshRemoteTmux` + another host). The one
  local terminal an SSH canvas may hold is a LOCAL-account login node, marked in memory only
  (`renderer/lib/localOnSshCanvas.ts` → `localOnSshCanvas` on the create; a scoped relay guest's is
  deleted); after a restart it routes to the host like any other node. **Downgrade:** a build older
  than this one reads the neutral file's nodes as local (the bug it already had for host-made nodes).
  **The phone's relay `pty.attach` is the other way in, and it is closed the same way**
  (`PtyManager.prepareRelayAttach`, pure routing in `core/relay-attach-plan.ts`). It used to call
  `attachDetached(nodeId)` → `tmux new-session -A` on the LOCAL socket for whatever id the phone
  named, with no `sshRemote` and no `requireRemote` — so an SSH project's node opened on the phone
  before the desktop mounted it became a local shell in this machine's `$HOME` (no context meter, ⌘M
  fell back to Markdown, work ran on the wrong machine), and the desktop's later mount created a
  SECOND `nt-<id>` on the host: one node id, two sessions, two machines. Rules a refactor must not
  undo:
  - **Where is decided from THIS machine's records, never the phone's words.** The desktop wires
    `setRelayNodeResolver` (`workspaceStore.relayNodePlacements` — EVERY project holding the id, the
    node as that project recorded it — plus `SshProjectManager.spawnRefFor` and the index's SSH
    identity). A node is remote when it carries `sshRemoteTmux` + `ssh` (a host attachment routes
    over its attachment scope, as `sshConnectionScope` does) or sits in an SSH project; a plain
    `ssh` terminal (`ssh` without `sshRemoteTmux`) runs `ssh` locally, as the renderer does. The
    phone's optional `projectId` may only CHOOSE among those placements, or REFUSE (an unknown id it
    places in an SSH project) — it never routes a node anywhere on its own.
  - **Remote = over the project's live master, with `requireRemote`, or refused** with a sentence
    the phone shows (`{message, reason}`: `not-connected` / `no-ssh` / `still-connecting` /
    `unregistered-remote`). Never a local fallback. A master whose connect setup has not finished
    (`Conn.setupDone`, set exactly where `connected` is emitted) may only JOIN a session the host
    positively lists — the renderer's `waitForSshRemote` rule: a session created before the setup
    chain carries no hook/account env and no tmux.conf, for life.
  - **The env is the desktop's, from the one builder.** The plan hands `spawnSession` the node's
    recorded `agentId` / `agentModel` / `accountId` / `cwd` / `shell` / `ownerProjectId`, so
    `buildPtyEnv` (agent id, canvas-control grant, permission wait), the account dir and project
    overrides apply exactly as on a desktop create; no second env is written for the relay. The
    shared pre-spawn refusals (`requireRemote`, the managed-Codex scope) are ONE helper,
    `spawnRefusal`, used by `spawnNew` and the relay. Pane ownership is still NOT recorded for a
    relay-created session (unchanged): the owner would be derived from project files, which is the
    one source that ledger refuses to trust.
  - **One id in a local AND an SSH project** (the same committed canvas opened in two folders) is
    answered by whichever session exists: a live LOCAL one wins, otherwise the remote one.
  - **Existing damage is reported, never killed.** A stray local `nt-<id>` the old path left for a
    node that only lives remotely is never attached from the relay again (and the desktop's own
    mounts already pass `requireRemote`), and a relay attach that finds one logs a `[relay] … left
    untouched` warning. It is not killed automatically: it may hold work typed into it, and nothing
    proves it idle. Do NOT point a user at the session-memory panel's × for it — a delete resolves
    remoteness from the index (`planRemoteEnd`) and would end the REAL remote session too; the
    manual cleanup is `tmux -L node-terminal kill-session -t =nt-<id>`.
  - Server Edition: no phone relay host, no resolver wired — `prepareRelayAttach` there is the bare
    local attach it always was. Tests: `relay-attach-plan.test.ts` (matrix),
    `pty-relay-attach.test.ts` (real PtyManager, node-pty mocked), `remote-security.test.ts`
    (host reply), `main/relay-attach-wiring.test.ts` (the desktop wire, at source level).
- **Codex's auto-started shared daemon: every nodeterm Codex TUI runs `--no-daemon`** (2026-09-30).
  From codex-cli **0.157.0** the `daemon_auto_start` feature is `stable, true` (0.156.1:
  `experimental, false`; 0.148.0: no such feature): a plain `codex` TUI no longer runs in-process
  but starts, or JOINS, ONE background `app-server` per `CODEX_HOME`, and that daemon keeps the
  environment of the pane that STARTED it and outlives it. The daemon is what spawns tool shells and
  hook processes, and nodeterm tells a node apart by environment (`buildPtyEnv`). MEASURED on
  0.159.2 (private `CODEX_HOME`, private tmux socket, `env -i`): pane A (`NODETERM_NODE_ID=node-A`)
  started the daemon; in pane B (`node-B`) the tool shell printed `node-A` and every hook process
  logged `node-A` — pane B's status, canvas-control verbs and context-link reads were pane A's.
  `--no-daemon` put pane C back on `node-C` in both; `-c features.daemon_auto_start=false` did NOT
  (it still joins a RUNNING daemon); there is no environment switch. Transcript and the three help
  pages: `src/core/__fixtures__/codex-daemon/`. Rules a refactor must not undo:
  - **Feature-detected, fail open.** `core/codex-cli.ts` `codexNoDaemonFrom` reads the flag off the
    option-header lines of the same memoized `codex --help` the approval vocabulary uses;
    `CodexCliCaps.noDaemon` rides the existing `ApprovalCaps` bag (`codexNoDaemon`) that every launch
    site already threads, and `withCodexNoDaemon` (`shared/agents/codex-daemon.ts`) appends it in
    BOTH assemblers — fresh launch and resume (cold restore, restart, restart-with-model, account
    switch, transfer, headless Server opens, custom agents whose `baseAgent` is codex, a launch-
    command override). Only a literal `true` emits it: clap exits on an unknown option, so an
    unprobed, remote-unknown or older CLI gets the line it always got.
  - **Await the answer before building a line — the race is the bug.** After a reboot every Codex
    node cold-restores in the same tick; a node that builds its line before the probe lands launches
    flagless, starts the shared daemon with ITS env, and every other node joins it. On a
    shared-identity machine `codex app-server daemon version` reports such a daemon `running`
    (verified in review), so the managed launcher adopts it too. So TerminalNode's four codex sites
    (cold restore, its fresh fallback, restart, wake) `await ensureCodexLaunchCaps(...)`
    (`renderer/state/codexCli.ts`, 3 s bound, fail open to the old line): local waits for the local
    probe, SSH waits for that host's answer to arrive in `useSshConn`, non-codex agents and relay
    tabs never wait. Pinned at source level by `nodes/codex-launch-caps-wiring.test.ts`.
    `createAgentNode` (a NEW node) is synchronous and still reads the landed answer — a node created
    inside the first ~second after boot can miss it; stated, not fixed.
  - **A relay tab never gets this machine's answer.** Its pane runs the HOST's codex; the guest's
    `true` typed into a host older than 0.156 dies on the unknown option. `codexApprovalCaps(remote,
    projectId)` treats a relay-bound project (checked through `registerCodexRelayProjectCheck`,
    registered by the projects store to avoid an import cycle) or a node's
    `session.source === 'relay'` as remote-with-no-probe: no flag, baseline vocabulary.
  - **One detection rule, two spellings.** `CODEX_NO_DAEMON_HELP_RE` / `_ERE`
    (`shared/agents/codex-daemon.ts`): an option header at indent <= 6 followed by whitespace or end
    of line, so a future `--no-daemon-x` is not this flag. TS reader, launcher and remote probe all
    use it; a test runs the ERE through real `grep -E` beside the regex.
  - **Never beside `--remote`** — measured: `ERROR: --no-daemon cannot be used with --remote.` The
    managed launcher (`buildCodexLauncherScript`) therefore STRIPS it before its own
    `codex --remote unix:// resume` and routes every plain-codex fallback through `nt_exec_plain`,
    which keeps it, or ADDS it when the codex about to run advertises it (the SSH launcher's host was
    never probed from here). This matters beyond the fallback node itself: a daemon started by a
    plain pane carries that pane's `NODETERM_NODE_ID`, and the thread-identity prelude only resolves
    a tool shell whose `NODETERM_NODE_ID` is EMPTY — so one plain launch used to poison every managed
    thread of that account too. Our own start stays the scrubbed `nt_start_app_server` (#350).
  - **SSH: the HOST's binary is asked.** `core/remote-ssh/codex-no-daemon-probe.ts` runs one
    marker-delimited `codex --help` through the login shell after connect (off the connect path, like
    the claude probe) and publishes `{hostKey, supported}` on a `connected` event and on a reused
    connect's result; the renderer keeps it per host (`useSshConn.codexNoDaemonByHost`). **The key
    is `user@host:port`** (`codexProbeHostKey`), NOT `sshHostKey`: two containers behind one machine
    (`root@localhost:2222` on 0.159, `:2223` on 0.148) are two binaries, and a portless key let the
    last probe answer for both. The SSH mirror slice carries the host's `true` to the phone.
  - `codex exec` (commit messages), `login`, `mcp` and `app-server` take no such flag and are not
    TUI clients of the daemon. The phone gets `MirrorSettings.codexNoDaemon`, local and per SSH slice (iOS
    reader: follow-up, @eneskirca). opencode was checked the same way: no published release has `serve --service`
    (latest 1.18.33 and the `dev` channel), and a plain TUI leaves no process behind.
  - **Residuals, stated:** (1) a `codex` TYPED into a pane rather than launched by us — by hand in a
    plain terminal, or by an agent through `open-terminal --cmd codex` / `write` — carries that
    node's `NODETERM_NODE_ID` and, on 0.157+, can still start the account's daemon with it; managed
    threads' tool shells then keep the leaked id (the prelude skips a set one). Changing the prelude
    to prefer the thread record over a set id was rejected FOR TOOL SHELLS: a bind-refused fallback
    pane legitimately runs a thread another node's record names. HOOKS are different (#1175, below):
    their payload names the event's own thread, so the codex hook script lets that thread's record
    outrank an inherited id unless the pane is marked `NODETERM_CODEX_PLAIN=1`. (2) A launch-command override or custom `launchCmd`
    that runs a DIFFERENT codex than PATH's (`npx @openai/codex@0.148.0`) is given the flag from
    PATH's probe and dies on it; the fix there is the user's (drop the pin or add the flag to their
    own command) — we cannot probe an arbitrary command line. (3) The Windows argv planner
    (`core/agent-launch.ts`) carries the flag but has no production caller today; Windows native
    Codex is unmeasured.
  - **Machines that ran a pre-fix build keep the mis-attribution until they recycle.** Panes already
    joined to the daemon stay joined across a warm reattach (the TUI process is still the old one); a
    daemon started before the fix keeps its first pane's env, and so does its `pid-update-loop`
    process (verified in review), so managed threads keep using it. We deliberately do NOT kill it:
    every unsupervised plain client attached to it would die with it. Recovery, in order: restart
    each Codex node (node menu → Restart, or close and reopen), then from a shell WITHOUT any
    `NODETERM_*` variables run `codex app-server daemon restart` (one per account: set that
    account's `CODEX_HOME`).
  - **Device checklist:** (a) macOS desktop, npm codex ≥ 0.157: two Codex nodes, each RUNNING badge
    and `nodeterm list` line on its own node; (b) standalone codex with shared identity: a node
    whose launcher fell back still reports as itself; (c) SSH project on a host with codex ≥ 0.157:
    the second remote Codex node's badge is its own after the probe landed (and flagless before);
    (d) Windows native codex: whether the daemon exists there at all is unmeasured — the flag rides
    only if its `--help` lists it; (e) reboot a Mac with 5+ Codex nodes: after cold restore each
    badge is its own (the bounded wait); (f) an upgraded machine: after the recovery steps above,
    `ps eww` on the daemon shows no `NODETERM_NODE_ID`; (g) two SSH projects on one host at
    different ports with different codex versions: only the newer one's lines carry the flag.
- **A shared Codex daemon restart is NOT a terminal-session restart.** tmux survives, and the Codex
  rollout/thread survives, but every `codex --remote unix://` TUI attached to that account's one
  app-server socket exits together. `buildCodexLauncherScript` therefore stays in the pane as a
  bounded transport supervisor after binding a thread instead of `exec`ing the remote TUI. On an
  abnormal client exit it resumes that exact thread only when `app-server daemon version` no longer
  reports `status: running` or the known control-socket inode changed; the same healthy generation
  returns the original status so a deterministic CLI error cannot relaunch forever. A reconnect
  never replays the launch prompt/options (that would duplicate the user's turn), and three rapid
  resets stop with a manual `codex resume <thread>` receipt. Preflight probes live protocol health
  before lifecycle start: Codex's PID ownership record can go stale while the shared process remains
  responsive, and killing that "orphan" would fan one bookkeeping failure out across every node.
  The generated-shell tests run the replaced-socket, missing-daemon, healthy-client-error, and
  responsive-orphan cases under real `/bin/sh`; the healthy-error case is the mutation guard.
  **Both shells wire this spine.** Electron and Server Edition arm the same signed record secret,
  thread start/bind handlers, capability refresh, and UI identity events; the server composition is
  isolated in `server/codex-shared-identity.ts` and behavior-tested. The old Server Edition
  "deliberate plain Codex" answer bypassed the launcher entirely, so a reconnect implementation in
  the launcher could be perfectly green while every headless pane still fell back to its shell.
  **No approval override ever rides that remote resume** (issue #811). MEASURED on
  `codex-cli 0.154.0` against a real thread on a running shared app-server, under a pty:
  `codex --remote unix:// resume <thread> --ask-for-approval on-request` answers
  `Error: Permission overrides are not supported when resuming a remote task.` and exits 1 —
  `on-request` being that build's own default policy and a member of its enum, so this is **not**
  the missing `untrusted` of #785. The same command with the flag removed resumes and the TUI stays
  up, and `-c approval_policy=never` is refused identically: the rule is about the OVERRIDE, not
  about a value or a spelling, so there is no mapping of `manual`/`auto`/`bypassPermissions` that
  survives this path and nothing to decide. Since `withPermissionMode` appends the flag to every
  agent launch, every shared-identity Codex node died on its first turn at a bare shell.
  `nt_run_shared` therefore strips `--ask-for-approval`/`-a` (both the spaced and the `=` form)
  from the first-launch argv. **The strip is in the LAUNCHER, not in the TypeScript that builds the
  line, and that placement is the invariant**: every identity-setup failure above it ends in
  `exec codex "$@"` — plain codex, no `--remote` — where 0.154 still accepts the flag, so
  suppressing it one layer up would take the permission mode away from exactly the nodes that could
  not get a managed identity. The `else` branch has always resumed with no caller options at all,
  so this only makes the first launch agree with the recovery beside it; the cost on an older codex
  that still accepts the flag on a resume is that the mode is not applied on the managed path, which
  after the first daemon reset was already true. **There is deliberately no capability gate**: the
  refusal is a runtime check, absent from `--help`, so `codexCliSupportsRemote`'s shape does not
  transfer — and it fires AFTER the session lookup, so a throwaway thread id answers "no saved
  session" with or without the flag. Probing costs a real resumable thread, which is the thing being
  launched.
- **"Restart agent (resume)"** → deliberately NOT a session lifecycle event: `terminal/
  agent-restart.ts` restarts the agent CLI *inside* the pane and leaves the PTY, the tmux session
  and its scrollback untouched. It exists for **new-model pickup** — a freshly released model only
  shows up in a CLI's model list on a fresh launch, and doing that by hand means closing and
  re-resuming every agent node on the canvas. Choreography: ask the CLI to quit with a fixed
  number of Ctrl-Cs (`CTRL_C_QUITS`: codex 2, claude 3, grok 3, opencode 2, copilot 2). In all
  five, Ctrl-U clears only the cursor's line, so a typed exit submitted the rest of a multi-line
  draft as a prompt, while Ctrl-C clears the whole composer and quits once it is empty (#842,
  #928). gemini alone still gets its typed exit (a bare `/quit`), because it was never measured
  — its composer is only reachable after a login. `EXIT_SEQUENCES` is still the
  gate — an agent not in it can never be restarted in place. Then poll `pty:pane-command` (`#{pane_current_command}`, local tmux socket or the
  project's SSH ControlMaster; any failure reads as "not a shell yet") every `RESTART_POLL_MS`
  (250 ms) until a SHELL owns the pane, then echo-deliver `resumeCommand(...)` — the same
  `claude --resume` / `codex resume` the cold restore uses. **Nothing is ever killed**: if the CLI
  has not quit within `RESTART_EXIT_TIMEOUT_MS` (6 s) the run reports `exit-timeout` and leaves the
  session running. **A user-asked restart gets a late window on top** (`RESTART_LATE_EXIT_MS`, 60 s,
  spent only while the pane still reads): issue #899 was a 19 h cron session whose CLI quit a moment
  AFTER the 6 s, with nothing left watching — the node sat at a bare shell with no agent and no
  resume. The Eco sweep and Pause keep the bare 6 s (the sweep is serialized canvas-wide). The
  exit-timeout notice (`exitTimeoutNotice`) hands over the bare resume line for exactly that
  late-quit case. A `working` **or `blocked`** session is refused — `/exit` typed into a
  permission prompt would ANSWER it, not quit — and a node is held one-restart-at-a-time until the
  resume line has actually LEFT the pane (an un-submitted line is where a second `/exit` would be
  spliced in). The bulk action runs the same per-node closure sequentially over every idle agent
  node in canvas order and reports one summary line. `performRestartResume` is now a COMPOSITION of
  `performExitPhase` + `performResumePhase` (2026-08-12, behavior-pinned split) — hibernation
  drives the halves separately; each half refuses independently.
- **Agent hibernation ("Eco", 2026-08-12, OPT-IN default off)** → `settings.agentHibernationEnabled`
  (+ `agentHibernationIdleMinutes`, default 30; Settings → Agents): a 60 s renderer sweep
  (`Canvas`) exits the CLI of up to **2** agent nodes per pass that are hook-idle in state `done`,
  fully offscreen (`isNodeWatched` — an open kanban card modal counts as watched), local, idle ≥
  window, non-recurring, without live subagents (`planHibernation` +
  `lib/hibernationCandidates.ts`, both pure/tested). tmux + shell survive; node shows a clickable
  SLEEPING chip; wake (view / chip / modal open) verifies a SHELL owns the pane
  (`isShellCommand` OR the persisted `hibernatedPane` the exit settled on — xonsh/elvish users) before
  the KILL_LINE'd, echo-verified `withPermissionMode(resumeCommand(...))`. Sweep/wake/menu-restart
  share ONE `guardConcurrentRestart` set. Load-bearing rules a refactor must not undo:
  (1) **recurring fact is durable** — both loop-card dismiss surfaces route through
  `lib/loopCard.ts`, which HIDES a cron/schedule card but retains `agentStatus.loop`
  (`dismissed: true`); clearing it would let Eco `/exit` a CLI whose cron wakeup lives in that
  process. (2) **Fire-time re-asks**: still-offscreen, remote, eligibility — a plan-time verdict
  is stale by seconds. (3) `hibernated` **self-heals** on live hook states + SessionStart (never
  on `done` — a late Stop POST must not undo a just-performed hibernate); cold restore (`fresh`)
  clears `hibernated` UNCONDITIONALLY and normally lets auto-resume own the node — **`paused` (see
  below) is what makes that auto-resume itself conditional**, the one deliberate exception: the
  flag it gates is still cleared, only the relaunch is skipped. (4) **Ordering with offscreen
  release**:
  Eco defers the Phase-2 viewer release until the node hibernates (hard cap idle+offscreen), but
  ONLY when the idle clock is known (`idleKnown` — `lastEventAt` is transient, so after an app
  restart nothing can hibernate and deferring would make Eco a memory regression). Eco is
  structurally inert for sessions with no turn in the current app run, and that is now a DECISION,
  not a follow-up: the persisted `agentStatus.lastSeen` clock (see **Status-grouped sessions**) is
  deliberately never an idle proof FOR ECO — see "A restored clock is not an idle proof" in
  `terminal/hibernation-policy.ts`. (A user-confirmed bulk pause is the one place it is read as weak
  evidence; see **Bulk pause** and the `lastSeen` rules under **Status-grouped sessions**.)
  The deferral is also unaware of `paused`: a deep-paused node's freshly recycled shell keeps its
  xterm alive until the hard cap, waiting for a hibernation that (being already exited, or having
  no CLI to exit) can never come — a second documented follow-up.
  Device checklist (8 items) in PR #130 — owed before recommending Eco to anyone.
- **"Pause session"** (manual, or via Eco when `settings.agentHibernationPersistAcrossRestart` is
  on) → `agentStatus.paused`, a persisted flag alongside `hibernated` with ONE job: stop a node
  from coming back on its own. Two depths, chosen per node: shallow — identical to an Eco exit
  (`registerAgentPause`'s `pause` closure reuses `performExitPhase`), plus `paused` — or "pause &
  end session" — the same recycle `restartAgentNode(…, restartShell: true)` uses
  (`transport.recycle` + a `respawnNonce` bump), so the node comes back `fresh` next time, with no
  live tmux session to hold memory. Two pure predicates in `terminal/hibernation-policy.ts` pin the
  contract: `shouldColdResume` (a `fresh` mount must not auto-relaunch a paused node — see Cold
  restore above) and `shouldAutoWake` (the mount-timer, visibility-edge, and kanban-card-modal-open
  auto-wake triggers must not fire for a paused node, hibernated or not — only an explicit Resume,
  which reuses the SAME `wakeHibernatedNode` trigger the SLEEPING/PAUSED chip's click uses, so it
  gets the same `WakeInputBuffer` splice protection and retry budget). Pausing an already-hibernated
  node skips the exit phase entirely (`alreadyExited` in the closure) — asking an idle CLI-less
  shell to quit would type `/exit` into it as a real command. `paused` is ALSO excluded from Eco's
  own candidate plan and its exit closure's fire-time re-ask (`HibernationCandidate.paused`,
  `hibernationCandidates.ts`) — a deep-paused node has `hibernated` unset (its tmux was recycled,
  not exited), so `!hibernated` alone would still admit it to a sweep whose dropped SessionEnd hook
  POST left a stale `done` behind: the same `/exit`-into-a-bare-shell mistake `alreadyExited` closes
  on the manual path, closed here on the automatic one. Node menu only today (canvas right-click +
  the sessions sidebar row menu, which shares the same `selectionItems` builder, plus a read-only
  kanban card badge and a clickable one in the card modal); no command palette entry.
- **Bulk pause** (tab menu and sessions-sidebar project menu: *Pause project* / *Cancel pending
  pauses* / *Resume all*; group frame menu: *Pause group*; a multi-selection of ≥2 agents: *Pause N
  sessions*; a count badge on the tab) → the shallow "Pause session" above, applied to many nodes
  at once, and it works on nodes that are NOT mounted (a project that is not on screen has no
  `TerminalNode`, so no registered pause closure). It never recycles a tmux session. Rules a
  refactor must not undo:
  (1) **Typing into a pane by node id is ONE primitive, `PtyManager.sendPaneKeys(persistKey, data)`**
  (`pty:send-pane-keys`, `HOST_ONLY`, classified `EDITOR_ONLY` in the relay access policy and
  `SCOPED_REFUSED` for a scoped guest). Keys go over stdin to `tmux source-file -` through the
  existing `controlInputPlan` / `remoteControlInputPlan`, never argv, to the exact `=nt-<id>:`.
  (2) **An SSH-project node is never read or typed into on the local socket.** `paneRemoteRef`
  resolves an unmounted SSH node through `remoteNodeOwner` (the machine-local index); a
  disconnected master, or a stray LIVE local session for an SSH-project node, is `not-connected` /
  unreachable, never a local fallback. `paneCommand` / `paneOwner` take an opt-in
  `{ resolveUnmounted: true }` and **the default stays the legacy live-only path ON PURPOSE**:
  agent messaging and `terminateForeground` also call them, and if they resolved an unmounted
  remote node they would prove an owner on the HOST and then act on the LOCAL socket. Zellij, the
  Windows session host, a native Windows pane and a plain shell answer `unsupported-backend`.
  (3) **`planBulkPause` (`lib/bulkPause.ts`) is the whole decision**: `now` (idle `done`, or an
  UNKNOWN state whose persisted `agentStatus.lastSeen.state` is `done` — `idleForPause`),
  `whenDone` (working / waiting / blocked, or a held question/approval ticket — typing `/exit` into
  those would answer a prompt), `alreadyExited` (hibernated by Eco: nothing to type, just mark it
  paused), and named skips, exactly the `BulkPauseSkip` reasons: `not-agent`, `no-session-id`,
  `not-resumable` (also an agent with no `exitSequence`, e.g. antigravity: resumable, but nothing
  can ask it to quit), `already-paused`, `relay`, `dropped`, `ended`, `state-unknown`. The
  unknown-state rule exists because state is transient: right after an app restart every node reads
  unknown, and an idle CLI and one mid-turn look the same — typing an exit into a running turn
  abandons it. `lastSeen` is the one clock that survives the restart, so a node last seen `done` is
  paused and every other unknown node is skipped, never guessed at (the runner re-asks the same
  rule at fire time). A skipped node says why; nothing is silently dropped, and the result line
  (`bulkPauseResultText`) counts EVERY outcome — paused, pending, unreachable, `unverified`, not
  eligible, still running, skipped — so a batch against a disconnected host never reads "Paused 0".
  (4) **`whenDone` is `state/pendingPause.ts`, TRANSIENT** (never persisted: after a restart nothing
  is watched, so a stored mark would lie). It fires on a CLEAN `done` edge only (not errored,
  interrupted or held), the mark is removed BEFORE the fire so a second edge cannot double it, and
  Resume, Cancel, node delete or the fire clear it, and the watcher also drops a mark when the node
  is paused elsewhere or its status disappears. **A mark is bound to the session it was planned
  against** (`BulkPauseTarget.sessionId`): the watcher drops it unfired when the node's session id
  changes, the runner refuses a mismatch, and every Canvas funnel that replaces the CLI —
  `restartAgentNode` (restart, fresh shell, model switch, reopen as), the Claude and Codex account
  switches, the bulk idle restart and both `transport.recycle` sites — removes it, or a mark taken
  for one turn would quit the NEW session on its first turn end.
  (5) **Every exit holds `guardConcurrentRestart(nodeId, …)`** (the Eco / Pause / restart set) and
  runs through ONE `createHostLimiter(BULK_PAUSE_HOST_CAP = 3)` per host key, shared by the batch
  and the pending fires; owner reads are bounded. The host key is `local` or the **SSH project id**,
  not the host: ControlMasters are per project, so the cap bounds channels per master.
  `pauseNodeHeadless` (`terminal/headless-pause.ts`) is `performExitPhase` over `sendPaneKeys`, with
  the menu restart's late window (`RESTART_LATE_EXIT_MS`) so a CLI that quits just after the base
  6 s is paused rather than reported "still running"; a failed key write ends that wait at once
  (`unreachable`). A pane owner that cannot be read before the exit (no live ControlMaster, a hung
  read) is `unverified`, distinct from `not-eligible` (read and refused): nothing is typed in
  either case.
  (6) **Resume all is the active project only**: waking is the mounted node's `wakeHibernatedNode`,
  so elsewhere the row is disabled with `Open the project to resume`.
  Surfaces: Desktop full (local + SSH); Server Edition has the core primitive and a real ws-bridge
  leg, but pending fires need an open browser tab (the watcher is the renderer's); relay tabs are
  refused; the kanban card menus inherit the rows through `nodeActionItems`; Mobile: follow-up.

The node id is the `persistKey` (passed to `transport.create`), so it must stay stable.
If tmux is unavailable, `PtyManager` falls back to a plain shell (no cross-restart
continuity). `findTmux()` resolves an absolute path because GUI apps don't inherit the
shell PATH, and it tries three sources **in this order: fixed system paths → the shell's
PATH → the tmux the macOS app SHIPS** (`bundledTmuxPath`). System first is deliberate — a
machine that already has tmux keeps using its own, so the bundled copy is a floor, never an
override. `resourcesPath` is `undefined` on the **Server Edition**, so the bundled binary is
unreachable there by construction; a Linux host is expected to have its own. Under
`electron-vite dev` the last candidate resolves against `process.cwd()`, which is where
`scripts/build-tmux.mjs` writes its artifact. If tmux is unavailable from all three,
`PtyManager` still falls back to a plain shell; `TMUX`/`TMUX_PANE` are stripped from the child env to avoid nesting refusal.
The same strip, one layer up, applies to a LAUNCHER that was itself an agent session: started from a
Claude Code terminal, the app used to hand `CLAUDE_CODE_CHILD_SESSION` and its siblings to every pane,
and the Claude CLI there then turned transcript saving off (no ⌘M view, no context meter, nothing for
`--resume`). `buildPtyEnv` deletes the explicit, measured `NESTED_AGENT_ENV_STRIP` list
(`core/nested-agent-env.ts`) and `ACCOUNT_SCOPE_UPDATE_ENV` lists the same names, so a tmux server
seeded from such an environment does not hand them back (the #419 mechanism). Explicit names, never a
`CLAUDE*` prefix sweep: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are how a managed account is selected.

**The local tmux CLIENT is spawned from `localTmuxClientCwd()` (home, else `/`), never the node's
cwd — the pane's directory rides `new-session -c` only** (issue #1131). Any client can be the one
that starts the shared server, the server keeps that client's cwd for life, and from tmux 3.7
`spawn.c` applies a pane's `-c` only when the server's own `getcwd()` succeeds: once the dir the
server started in is deleted (a removed worktree), every NEW pane on the server inherits the deleted
dir whatever `-c` said, and agents launched there hang. MEASURED on a locally built tmux 3.7c
(private socket): client in the doomed dir → `-c <proj>` pane at `<gone> (deleted)`; client in
`$HOME` → pane at `<proj>`. tmux 3.4–3.6 honour `-c` either way, which is why CI cannot reproduce it
and the guard is a spawn-options assertion (`pty-tmux-client-cwd.test.ts`). The plain-shell fallback
is the pane itself and keeps the project cwd; remote tmux is started from an ssh exec channel, which
sshd places in the login home. A server started by an earlier build keeps its old cwd until it is
restarted (`tmux -L node-terminal kill-server`, which ends every session).

**A session-host session follows its most recently ACTIVE viewer, like tmux's `window-size
latest`** (issue #914). Under tmux a relay-mirrored phone is its own tmux client, so dismissing its
keyboard gives it its rows back; on the session host the phone and the desktop node share ONE
client socket, and the old componentwise minimum held the phone to the desktop node's rows with an
empty band and no explanation. `latestClaimSize` (`core/pty-size.ts`) picks the claim with the
highest recency — bumped by an attach, a claim that CHANGES, and a write that is not an emulator's
automatic answer (`core/terminal-reports.ts`; every attached xterm answers a DA/CPR/OSC query, and
counting those would hand the session to whoever answered last). Three rules, each load-bearing:
(1) a viewer that cannot adapt is a CEILING — a pty wider than the phone's screen would wrap into
garbage there (or, rendered at the pty's size, be clipped to its left ~45 columns), so a relay sink is
`bounding` unless `pty.attach` said `resizedFrames: true`. The iOS app deliberately does NOT send it:
it reads `OP.Resized` only to show a "Sized to another screen · Fit this screen" hint, and every
phone report is ANSWERED (the sink's `sinkShown` is forgotten on each report) because the phone
clears that hint whenever it sends a size; (2) the real size flows back to every viewer (`SessionHostPty.onSize` →
`PtyManager.applyBackendSize` → `pty:size`, and `OP.Resized` to the sink), and a session-host
`Session`'s `applySize` only VOTES; (3) the host's `geometry` push is NEGOTIATED at `hello`
(`SESSION_HOST_FEATURES`) and sent only to sockets that asked — an older client reads every
non-`data` push frame as an EXIT. Across app connections the host still takes the minimum. Full
write-up: `docs/windows-session-host.md` → "Output ordering, flow ownership, and geometry".

### Cold restore (machine reboot)

tmux only survives an **app** restart — a **machine reboot kills the tmux server**, so every
`nt-<nodeId>` session is gone. To bridge that, `create()` returns `PtyCreateResult` with a
`fresh` flag: it asks the tmux server whether the session already exists *before* spawning, so
`fresh=false` means a warm reattach (tmux redraws) and `fresh=true` means a cold start (first open
OR post-reboot). Locally that ask is one `tmux has-session` per node; **on an SSH project it is ONE
`tmux list-sessions` per host per burst** (`core/remote-ssh/remote-session-index.ts`), because a
project switch mounts every node in the same tick and N probe channels on top of N pty channels
overrun a stock host's `MaxSessions 10`. The measurement and the failure chain it closes are in
that module's header; the two rules a refactor must not undo are **(1)** only tmux's own exit 1 is
evidence of absence — every other outcome answers "exists", because a transport failure read as
"cold" replays a snapshot and types `claude --resume …` into a LIVE agent pane — and **(2)** a
session this process just spawned is recorded (`markPresent`) and a remote kill invalidates the
cached list, so nothing inside the cache window can be told it is cold when it is not. On a
cold start the renderer (`TerminalNode.tsx`) reconstructs state instead of relying on the dead
session (you can't keep a live OS process across a reboot):
- **Scrollback replay** — `core/scrollback-store.ts` keeps a byte-capped (`256 KB`) snapshot of
  each tmux session's recent output under `<userData>/terminal-scrollback/`, refreshed on a
  timer (`SCROLLBACK_SNAPSHOT_MS`) + on detach/quit (`tmux capture-pane -e`). On a cold start the
  renderer reads it via `pty.readScrollback` and writes it back into xterm (with a "session
  restored" separator). Warm reattach skips it (tmux already redraws). Deleted with the node in
  `destroySession`.
  **The periodic capture is paced, serialized and deduplicated** (`snapshotTick`,
  `core/scrollback-cadence.ts`). A working agent's spinner keeps its session dirty forever, so the
  old tick spawned a `capture-pane -S -1500` (an ssh exec for a remote node) and rewrote up to
  256 KB for EVERY busy session, all in the same instant, every 15 s. Now: a dirty session is
  captured on its first `BUSY_AFTER_TICKS` (4) consecutive dirty ticks, then every
  `BUSY_EVERY_TICKS`-th (60 s); an off-cadence tick KEEPS the dirty bit, which is what lets
  detach/quit still take their final capture; an idle tick resets the count. Captures run one at a
  time on `snapshotChain`, a session whose capture is still queued is never queued twice
  (`snapshotQueued`), and a failed capture OR a failed disk write re-marks it dirty
  (`writeScrollbackIfChanged` reports the write; a skipped unchanged capture counts as done). Every write (periodic, detach, quit)
  goes through `writeScrollbackIfChanged`, which skips a capture whose sha1 matches the last one
  written; the digest is dropped with the file in `endSession`, so a recreated node always writes.
  The cost is bounded and deliberate: a continuously busy session's post-reboot replay can be up to
  ~60 s stale, since the snapshot only serves a machine reboot.
- **Agent resume** — on a cold start of a node whose `agentId` is in `RESUMABLE_AGENTS`, the
  renderer re-launches the agent CLI: `resumeCommand(agentId, sessionId)` (from the session id
  persisted in `agentStatus` localStorage — `claude --resume`, `codex resume`, `gemini
  --resume`) when known, else the bare `launchCmd`. The one-shot `data.initialCommand` still wins
  on the very first open, so the agent is never double-launched. **The one exception: a `paused`
  node** (see "Pause session" below) skips this auto-relaunch — that is the entire point of the
  flag — and instead records the pane its fresh shell settled on (`agentStatus.hibernatedPane`),
  so a later explicit Resume can recognize it even for a default shell outside the wake's
  `isShellCommand` allowlist.
  **A persisted session id is not evidence the conversation still exists**, and a dead one is not a
  no-op: `claude --resume <dead id>` prints *"No conversation found with session ID: <uuid>"* and
  EXITS, leaving the pane at a bare shell under a node still wearing its agent badge. Measured
  2026-09-09 on the reporting host (`nodeterm-rmt`, 108 live sessions): **20** panes sat in exactly
  that state, and not one of those 20 ids had a `<id>.jsonl` anywhere under the system
  `~/.claude/projects` or the managed account root. Claude's own 30-day cleanup, a `/clear`, a
  removed account and an id minted for a session that never ran all produce it. So the cold-restore
  branch now asks `chat.transcriptExists` first (`transcript:exists`, served by
  `registerTranscriptIpc` in BOTH shells) and, on a POSITIVE `absent`, launches the agent **bare**
  and raises a slim `CoState.lostSession` banner on the node — "The previous conversation could not
  be found — this agent started fresh." — instead of opening a blank session in silence. Three
  rules make that safe:
  - **The answer is a TRI-state** (`TranscriptPresence`: `present | absent | unknown`) and only
    `absent` drops the id. The two errors are wildly asymmetric — wrongly resuming a dead id costs
    one line and a bare shell (today's bug), wrongly dropping a LIVE id strands work the user
    believes is continuing — so an unreadable root, a `readdir` that threw, a downed ControlMaster,
    a relay tab, a rejected call and an id we would not put on a command line are ALL `unknown` =
    resume exactly as before. `transcriptPresence` (`core/transcript-reader.ts`) is
    `resolveTranscriptPath` plus that one distinction, not a second way of finding a transcript,
    and a root that does not exist at all still answers `unknown` on purpose: cold restore runs at
    boot, where a not-yet-mounted `$HOME` is indistinguishable from an empty one.
  - **The remote leg's `unknown` is TERMINAL, never a fallthrough.** A remote session's transcript
    is on the host, so searching this machine for it would find nothing and report `absent` about
    the wrong computer. `remoteTranscriptPresence` (`src/main`) exists beside
    `remoteTranscriptRefFor` rather than reusing it because that function collapses "not remote" /
    "no home" / "ssh failed" / "the host looked and there is nothing" into one `undefined` — fine
    for a reader that falls back, fatal for a caller that acts on absence.
    `locateRemoteTranscriptCommand` was already built for this distinction (it exits 0 on a clean
    miss, "so no transcript is an ANSWER, not a failed ssh"), and that is the property this reads;
    it is deliberately more permissive than the local leg (it searches the account root AND the
    system root), which errs toward `present` = keep the resume.
  - **Claude only**, gated by `readsClaudeTranscript` — a codex/gemini/grok id misses this
    resolver by construction every time, so probing one would answer `absent` for a healthy
    session and drop its resume. Those agents keep the pre-existing behaviour until the probe
    learns their layouts (`handoff/locate.ts` has the per-agent locators; that is the seam).
  Decision logic is the pure `terminal/cold-resume-session.ts`. **Adding a `CoState` field owes the
  hand-written equality list in `setCo`** — a patch touching only an uncompared field is SWALLOWED
  and its banner silently never renders (it happened once to `spawnError`);
  `nodes/cold-resume-wiring.test.ts` now asserts every field of the interface appears there.
  Surfaces: Desktop full; Server Edition full (the handler is core, the ws-bridge leg is real, and
  that shell runs on the host whose transcripts it reads, so it needs no remote leg); relay tabs
  answer `unknown` and resume as before. **Not yet on the kanban CARD MODAL** — `ModalTerminal`
  reads no `CoState`, so a user who only ever opens the session from the board does not see the
  notice; the honest fix is a shared node-notice surface rather than a second copy of the banner.

### SSH connect: the ControlMaster is published BEFORE its setup chain

`connectOnce` (`main/remote-ssh/ssh-project.ts`) used to publish a project's ControlMaster only with
`status: 'connected'` — i.e. after the reverse hook tunnel, ~23 serialized per-agent hook installs,
`printf $HOME`, the remote tmux.conf write + `source-file` and the Codex runtime staging had all
run. MEASURED against a real sshd through a 25 ms one-way delay proxy (50 ms RTT): that chain is
**3.54 s** on a fully-provisioned host, while **18 remote terminals attaching in parallel over a
warm master paint in a median of 0.16 s** and are all settled by 0.71 s. So the attach was never the
bottleneck — every terminal of a switched-to project simply sat in `resolveSshRemote`'s 20 s wait
printing `[connecting to user@host…]` into a blank pane, for a transport that was ready the whole
time.

Two additive changes, and the rules that keep them safe:

- **The early signal.** The moment `ssh -O check` answers, `connectOnce` emits
  `SshProjectStatusEvent.masterControlPath` on a `connecting` event. `connected` keeps its exact
  meaning (the whole chain finished) and everything hanging off it — git routing, the remote claude
  probe, the tunnel resync, the connection banner — is untouched. The renderer keeps it in its own
  map (`useSshConn.earlyByProject`), **never in `byProject`**, which a dozen readers treat as "this
  project is connected".
  - **Only a node whose remote tmux session ALREADY EXISTS may act on it**
    (`PtyApi.remoteSessionConfirmed` → `RemoteSessionIndex.verdict`, the strict `present`-only half
    of the coalesced `tmux list-sessions` read `create()` already makes, so a warm switch pays no
    extra round trip). `new-session -A` on a live session merely attaches, and the two things the
    setup chain provides — the remote tmux config (`-f`) and the hook/account environment (tmux
    `-e`) — are read at session CREATION only. A node whose session is ABSENT, **or whose host
    could not be read**, waits for `connected`: creating its session without the hook env costs it
    its agent-status badges silently, with no later event to repair it. That is why the index now
    exposes a TRI-STATE (`present | absent | unknown`) — `exists()` folds `unknown` into "exists"
    for its own caller, and this one needs the opposite fold. Decision logic is the pure
    `renderer/lib/sshRemoteWait.ts`; a cold node's wait is pinned by its own test.
  - **Never for an ADOPTED live-orphan master.** The tunnel-verification failure path may `-O exit`
    that master and rebuild it, which would kill a terminal that had attached over it meanwhile.
    The rebuild clears `reusedOrphan` and re-enters the loop, so a rebuilt master does publish.
- **The boot-time pre-warm** (`core/remote-ssh/ssh-prewarm.ts`, planner + runner pure and tested;
  wired in `main/index.ts`). The master for a project was dialed only when the user first switched
  to it, so the first visit of every app run paid the cold establish (**0.44 s** measured) plus the
  whole chain. `SshProjectManager.prewarm` now dials the masters of OPEN SSH projects shortly after
  boot, **one host at a time** (a burst of fresh masters is what trips a host's `MaxStartups`; the
  `SshChildGate` caps exec children per control path and does nothing about logins).
  - **A pre-warm is SILENT — no status event at all.** The user is by definition not looking (if
    they were, the active-project effect would have connected it loudly), so a failure must not
    raise the connection banner for a project they never opened. The mark is lifted the moment a
    real connect arrives for the same project, including one that coalesces onto the pre-warm's own
    in-flight attempt.
  - **It never prompts for a passphrase either** (`isQuietMasterPid` → main's prompt handler
    declines): a modal in front of a user who opened nothing is the loudest thing an SSH connect can
    do. That master fails auth quietly; the user's own connect spawns a new one and prompts normally.
  - **CLOSED projects are never dialed**, and neither is a project that already has a master or an
    attempt in flight. `closeProject` is non-destructive, so a closed tab is the user saying "not
    now".

### When a freshness verdict was a GUESS: the late cold-start check

The cold-restore section above states the rule that makes the remote freshness read safe: only
tmux's own exit 1 is evidence of absence, and every other outcome answers "exists", because a
transport failure read as "cold" types `claude --resume …` into a LIVE agent pane. That rule is
right and does not change. What it costs, and what this closes, is the other side of the fold.

**THE INCIDENT (measured on the reporting host, 2026-09-15).** The host's `nodeterm-rmt` tmux
server died, so every remote session was gone; ten minutes later a 108-node SSH project was opened
and 107 sessions had to be created in one mount burst. sshd logged **757 `Accepted publickey` full
logins in seven minutes** — on a healthy ControlMaster that number is ~0, because everything
multiplexes over one connection. Under that pressure the freshness read times out, the fold answers
"exists", `tmux new-session -A` CREATES an empty session, `fresh:false` skips cold restore, and the
node sits at a bare shell with the user's conversation stranded on disk:

    15:29 burst,  22 sessions: 18 claude /  4 bash  ->  82% resumed
    15:39 burst, 107 sessions: 41 claude / 66 bash  ->  38% resumed

Load-dependent, i.e. a race. Three changes, and the order matters — the first saves the
conversation, the other two stop the burst that strands it:

- **A second opinion, never a different fold.** `create()` now reports `freshUnverified` when
  `fresh:false` came from an `unknown` verdict rather than a read. The renderer re-asks ONCE, after
  the attach has landed and the burst is over, and tmux settles it authoritatively:
  `#{session_created}` survives a `new-session -A` attach, so a session created within seconds of
  our own attach is one WE made (`PtyApi.sessionAge` → `remoteSessionAgeArgs`, which prints the
  stamp AND the host's `date +%s` on one line so the host's clock skew never enters the number).
  Every rule in `renderer/terminal/cold-self-heal.ts` is a refusal: never for a verdict that was
  READ (that would spend a round trip per warm node on every switch), never for an unknown age,
  never past the window, and never unless a SHELL still owns the pane — the same gate the
  hibernation wake and the resume-miss watcher keep. The scrollback replay is deliberately NOT
  re-run: by then tmux has painted the live pane, and writing a snapshot over it splices two points
  in time (the warm-attach seeding rule). The agent relaunch is what matters and is what runs.
- **The per-node token write is coalesced, not gated** — the brief that prompted this said
  `ensureRemoteNodeToken` bypassed the `SshChildGate`, and that was measurably wrong: main wires
  `RemoteHooks` with the gated runner, so it queues like everything else. The real cost was that it
  is one round trip PER SPAWN for work the connect path already did (`materialiseNodeTokens` writes
  every node's token), competing for a budget of 6 for the whole burst. It now memoizes per
  (control path, node) for the app run — seeded by the connect — and coalesces a burst into ONE
  remote write.
- **Remote pty spawns are paced** (`core/remote-ssh/pty-spawn-gate.ts`, cap 4 per ControlMaster).
  A pty deliberately never went through the `SshChildGate` — "a terminal is never queued for a
  screen the user is looking at" — which is right for a handful of terminals and wrong for a
  canvas. The one thing that makes pacing acceptable is that a slot is held only until the session
  starts painting: released on the pty's FIRST OUTPUT (one round trip for a warm attach) and
  unconditionally after `REMOTE_PTY_SPAWN_SETTLE_MS`, because a gate that can hang is worse than no
  gate. A node that ends up waiting SAYS so (`SLOW_REMOTE_SPAWN_NOTICE_MS`), for the same reason the
  `[connecting…]` line exists. Measured in the lab (real sshd, `MaxSessions 10`, 50 ms RTT, one warm
  master, 107 attaches):

  | | full logins | panes painted | wall |
  |---|---|---|---|
  | ungated | 72 / 77 | 102 and 96 of 107 | 2.1 / 2.3 s |
  | gated at 4 | **1** / **1** | **107 / 107** | 3.2 / 4.0 s |

  Wall time is the price and it is the right trade: ungated, five to eleven panes never painted at
  all inside a 20 s budget — the same shape `remote-session-index.ts` reports for its own burst.

### Zellij as an optional local backend (`settings.sessionBackend`)

Local POSIX terminals can live in **Zellij** instead of tmux (`src/core/zellij-backend.ts`; the
measurement table, the herdr comparison and the device checklist are in
**`docs/session-backends.md`** — Zellij 0.45.1 and herdr 0.9.3 release binaries, Linux, sandboxed
HOME/XDG/socket dir). Default stays tmux; `normalizeSessionBackend` reads anything unknown as tmux;
SSH projects keep the remote tmux and Windows keeps the session host. herdr was measured and not
implemented: its unit is a server of workspaces, a plain pane cannot be attached on its own
(`agent attach` refuses a non-agent pane), per-pane env is argv, and `pane send-text` ignores the
app's paste mode (measured: unframed after `?2004h`).

Rules a refactor must not undo:
- **The backend follows the session that exists** (`decideZellij`). A warm tmux session wins and
  never reaches the Zellij probe; a LIVE Zellij session is reattached in Zellij whatever the setting
  now says; only a node with no session anywhere is created in the selected backend. Otherwise
  flipping the setting cold-restores (`--resume`) an agent into the other multiplexer while the
  original keeps running in the first.
- **Env rides the client, never argv.** Each Zellij session is its own server forked by the client
  that created it, so the painter's `env` (hook env, account scope, gateway/project/custom-agent
  values, all merged in `spawnSession`) IS the session env — measured. There is no `-e` list to
  maintain and nothing to leak; do not add one.
- **Only an answer is absence, and `unknown` is WARM whatever the setting.** `list-sessions -n`
  exits 1 both for "No active zellij sessions found" (absence) and for real failures; only the
  sentence counts. When Zellij cannot be asked, the create is never cold — even with tmux selected
  — or a node still live in Zellij gets its snapshot replayed and its agent resumed a SECOND time
  in a new tmux shell (the review blocker on #1067: the first version folded to warm only when
  Zellij was selected). `sessionExists` is the opposite fold: it claims a Zellij session only from
  a listing that PARSED and shows it live, or every node on the machine "exists" (the phone's End
  session always said "still running"). Session names may contain SPACES (`my work [Created …]`),
  and a space-intolerant parser turned ONE personal session into `unknown` for every probe.
- **`--` before every positional text** (`paste`, `write-chars`): otherwise clap reads a leading
  `-` as a flag — measured in review, a markdown bullet list was refused and `-h` printed help with
  exit 0, delivering nothing while the caller then pressed Enter.
- **Zellij is probed only when it is in play** (`zellijProbeRun`: selected, or `zellij.kdl`
  exists — written only when a Zellij painter is created), so a tmux user with Zellij merely
  installed runs exactly the old path: no `list-sessions` per cold create, no `kill-session` per
  delete.
- **Socket path length**: Zellij refuses a socket path over `sun_path` (107 bytes on Linux, 103 on
  macOS). `zellijSocketPath` mirrors its dir rule; a create that would not fit falls back to tmux
  and Settings says why. A stock Mac with no `XDG_RUNTIME_DIR` computes to ~104 bytes for a real
  node id — calculated, not run; it is the first device-checklist item.
- **A zombie needs confirming before it is killed.** A shell that exits with no client attached
  leaves the session listed with only the hidden plugin pane, and `attach --create` to it exits at
  once, so `decideZellij` kills it first. But a session a moment old ALSO has no terminal pane yet
  (measured, and it made the first version of this code kill its own fresh sessions): five pane-less
  reads 300 ms apart, and one pane at any read is `live`.
- **Every action names a pane** (`pickZellijPane`): without `--pane-id` an action silently did
  nothing headless. `action paste` is the `paste-buffer -p` contract (framed only when the app asked
  — measured both ways); Enter is a second `write 13`; a paste over 120,000 bytes is refused, never
  split (one argv element; 140,000 failed with exit 126).
- **Keybindings are session-wide**, so our `zellij.kdl` decides what everyone attached to a canvas
  session can press: locked mode (Ctrl-g/p/t/o reach the app — Claude Code uses Ctrl-g), unlock on
  Ctrl-Alt-g so an outside client can still detach, `session_serialization false` so a killed
  session is not resurrected by the next `attach --create`.
- **`tmuxBacked` is also true for a Zellij session** (it means "releasing the client destroys
  nothing"); every path that would talk to the tmux socket asks `isZellij` first. A delete kills
  `nt-<id>` in Zellij whenever Zellij is in play (exact-name match, a no-op for a tmux node), because a
  node deleted after a restart has no live session and no record (only when Zellij is in play).
- **Explicit degrades, named in Settings** (`ZELLIJ_BACKEND_GAPS`, pinned to the doc by
  `zellij-backend.test.ts`): messaging/triggers refused (`paneOwner` null), model switch refused
  (`terminateForeground` false), the session-memory panel COUNTS Zellij sessions it did not measure
  (`SessionMemoryReport.unmeasured` — never "No sessions are running here." over live ones) and the
  reaper ignores them, pasted text rides argv (readable while the call runs), no pane cwd /
  stale-cwd banner, mobile direct-SSH sees only tmux. The pane foreground command IS provided, from one `ps` read
  (server → shell → the shell's `tpgid`); ambiguous (two pane shells) answers null.
Surfaces: Desktop measured and tested on Linux only (macOS unverified — socket path first); Server Edition the same core (row shown when its host reports Zellij);
Mobile via relay joins the Zellij session (`listNodetermSessions` includes and remembers them),
the phone's direct SSH path does not — iOS follow-up. Real-binary suites: `*.realzellij.test.ts`
(`NODETERM_TEST_ZELLIJ` or `zellij` on PATH; skipped in CI, which has none).

### We have our own VT emulator — check it before asking tmux

xterm.js is not just a renderer. It parses the pane's output stream, so it **tracks DECSET modes
itself** and exposes them as public API (`term.modes`, `@xterm/xterm/typings/xterm.d.ts:1865`) —
bracketed paste, application-cursor, mouse tracking, origin mode, and the rest. We already read one
of them: `term.modes.mouseTrackingMode` decides whether a click means "follow this file link"
(`src/renderer/terminal/file-links.ts:341`).

We once did the opposite. `PtyManager.bracketPasteRequested` (now **deleted** — see the tombstone
in `pty-manager.ts`) asked **tmux** for the same class of fact, via `#{bracket_paste_flag}` — and
that format **first shipped in tmux 3.7** (2026-06-26). Ubuntu 24.04 LTS ships 3.4, Ubuntu 22.04 →
3.2a, Debian 12/13 → 3.3a/3.5a, Ubuntu 26.04 → 3.6a. On all of those it expanded to `''` exactly
like a bogus name, and the comparison against `'1'` answered **false for every pane**. The bundled
tmux did not rescue it: `extraResources` places it under `"mac"` only, and `bundledTmuxPath` is
deliberately the **last** candidate (see the comment at `pty-manager.ts:245-250` — preferring our
binary would pair a new client with the user's older running *server*, which upstream refuses). On
an **SSH project it was unfixable from our side entirely**: the remote's tmux is whatever the
user's server has.

**The rule this is an instance of: before asking tmux, ssh or `ps` something about a pane, check
whether the emulator already knows it.** Facts about *what the app in the pane is doing* (VT modes,
the alternate screen, the cursor shape it asked for) arrive as bytes we already parse. Facts about
*the session* (does it exist, what is the foreground process group, which panes are in it) are
genuinely tmux's and must be asked. Mixing the two up is how a feature acquires a dependency on a
tmux version we do not control. herdr has no version problem here for exactly this reason — it
reads `mode_get(MODE_BRACKETED_PASTE)` from its own state machine.

**Measured, and the emulator is NOT the answer here.** The `?2004h` a tmux *client* receives is
tmux's own paste-through on the outer terminal (`tty_start_tty`, gated on the outer terminfo
`BE`/`BD`), not the pane app's request: it arrives ~5 ms after attach and reads `true` even for a
pane running `sleep 30`. It never toggled across pane switches, window switches, re-attach or
co-attach. A constant is not a signal — so `term.modes.bracketedPasteMode` cannot stand in for the
pane's state, however tempting the symmetry with `mouseTrackingMode` looks.

**That paragraph is about a tmux CLIENT, and the SESSION HOST is the opposite case** (issue #686).
On Windows there is no tmux, so nothing sits between the pane's app and the host's headless
emulator: a `?2004h` it sees was written by the app itself, which is exactly the fact
`paste-buffer -p` asks tmux for. `HostSession.bracketedPasteRequested()` reads it (behind
`outputTail`, like `serialize` — xterm applies writes asynchronously, so an early read answers "no"
for the turn that just enabled it) and `sendKeysWrites` (`session-host/send-keys-delivery.ts`)
sanitizes ALWAYS and frames only when the app asked. Separate writes alone can still be read
as one burst (#780). Both native Windows `sendText` and host `sendKeys` now execute through
`core/settled-text.ts`: capture a baseline, paste without Enter, then poll at 40 ms for at most
15 polls for a changed, stable screen containing the sanitized text. Only then write one Enter,
after rechecking liveness/generation and paste mode. Unknown capture, unchanged output or timeout
leaves the paste unsubmitted and returns `pasted-not-submitted`, never `true`. The discriminant
survives IPC/WS and `sendKeysV2`; canvas writes name the partial delivery, trigger runs record
a terminal miss (including queue flush), and one-way UI writers raise a visible warning. Test
success with `=== true`, never truthiness. Do not retry an unconfirmed submit and duplicate the paste. Overlapping sendText operations on the same pane
are refused before input; insert-only, empty Enter and unframed input retain their contracts.
A collapsed/hidden/oversize paste may require manual Enter. This is an observed-screen heuristic,
not an application acknowledgement. Linux fake-PTY tests cover a 150 ms busy reader; real Windows
Codex/Claude, context-link/write, dictation and rename device checks remain required. Existing
hosts refuse the additive `sendKeysV2` command until they retire; no raw-write fallback or
automatic host restart is performed. Legacy clients still use the existing `sendKeys` command.


**The actual fix is older than the problem: `paste-buffer -p`.** From tmux's own man page — *"If
`-p` is specified, paste bracket control codes are inserted around the buffer **if the application
has requested bracketed paste mode**."* Introduced 2012-03-03, shipped in **tmux 1.7**, so it is
present on every tmux in the field. We do not have to ask whether the app wants framing; we ask
tmux to do the framing, and it applies the pane's real state. Measured on 3.4: framed when the app
requested it, unframed when it did not, correct for a non-active pane, and the whole thing in one
round trip —
`tmux load-buffer -b nt - \; if-shell -F -t <target> '#{pane_in_mode}' 'send-keys -t <target> -X
cancel' \; paste-buffer -d -p -r -b nt -t <target> \; send-keys -t <target> Enter` (`-r` keeps
`\n` as `\n` instead of tmux's default `\n`→`\r` rewrite; see `tmux-naming.ts`).

Two hazards that come with it, both measured:
- **Copy mode silently unframes.** With `#{pane_in_mode}` = 1, `paste-buffer -p` delivers unframed
  (tmux checks the copy-mode screen, not the app), so a user who scrolled the wheel up gets the
  one-turn-per-line bug. The `if-shell` guard above runs `send-keys -X cancel` first — only when the
  pane is in copy mode — in the same invocation, restoring it.
- **`set-buffer -- "$text"` hits ARG_MAX** around 200 KB. Use `load-buffer -` over stdin — and on
  the SSH path that means piping into the remote command rather than putting the text in argv.

There is no longer a probe or a fallback to weigh: `sendText` delivers through `paste-buffer -p`
**unconditionally** (the plan builders live in `tmux-naming.ts`). The old two-step path — probe
`#{bracket_paste_flag}`, and on a false answer deliver `line1\nline2\nline3\r`, raw newlines into
the app that *mangled* every multi-line write on a pre-3.7 tmux — is gone with the probe.

### Seeding a fresh xterm (`attachReplay` / `seedPaint` in `terminal/terminal-config.ts`)

A newly mounted xterm is empty. Since tmux paints its own client, there is usually **nothing to
seed** — the cases are:
- **`none`** — the terminal was **parked** (its buffer is still live and correct), or it is a
  brand-new node with an `initialCommand`. Seeding either would duplicate content.
- **`cold-snapshot`** (`fresh` — reboot/first open) — the tmux session is genuinely gone, so replay
  the persisted `scrollback-store` snapshot, with a "session restored" separator.
- **`warm-attach`** (`!fresh` — app restart, tmux still alive) — **seed nothing.** tmux is attached
  to this client: it redraws the visible screen and owns the history under the wheel. This is where
  a `warm-history` hydration (`transport.captureHistory` → `tmux capture-pane`) used to run; it was
  **removed**, because writing into a buffer that tmux then repaints is what produced the black
  bands and duplicated screens. The single exception is a **co-attach joiner** (`seedPaint` →
  `create-screen`): tmux only repaints on SIGWINCH, so a joiner that did not resize never gets a
  redraw, and the screen captured server-side inside `create()` (`PtyCreateResult.screen`) is the
  only thing that paints it — see docs/team-presence.md. **A co-attach joiner also misses tmux's
  MOUSE-TRACKING modes** (`?1000h/?1002h/?1006h`): tmux emits them only at its OWN attach, and
  neither the `screen` capture (`capture-pane` carries no private modes) nor a SIGWINCH redraw
  re-sends them — so the joiner's wheel can't scroll tmux history until a keystroke makes the app
  re-request mouse. `join()` therefore sets `PtyCreateResult.coAttachMouse` for tmux-backed joins
  (gated on a REAL tmux client — `tmuxBacked && !sessionHost`, the same local that gates
  `coAttachAltScreen`/`tmuxClient`; NOT `persistKey`, which a Windows session-host session also
  carries and whose joiner then sent wheel/drag to the shell as SGR reports — on BOTH the screen
  and resize branches) and the renderer writes
  `CO_ATTACH_MOUSE_SEQ` into the fresh xterm (both `ModalTerminal` and `TerminalNode`). tmux is
  always `mouse on`, so this matches its invariant client state; the enable is idempotent. Was the
  "can't scroll the kanban card-modal terminal until you press a key" bug. **A co-attach joiner
  ALSO misses tmux's attach-time `\e[?1049h`**, and a renderer reload is a joiner too (it re-joins
  the SAME still-alive tmux client via `join()`, so tmux never re-attaches it). `join()` therefore
  sets `coAttachAltScreen` for tmux-backed sessions only — gated on `tmuxBacked && !sessionHost`,
  never plain-shell/session-host, whose normal-buffer scrollback is their only history — and the
  renderer writes `CO_ATTACH_ALT_SCREEN_SEQ` **BEFORE** painting (entering the alternate buffer
  clears the display, so writing it after would erase the paint; TerminalNode skips it once a
  resync has superseded the seed, since that repaint may already be on screen). **Known
  limitation of "never plain-shell":** a REMOTE SSH session on a host WITHOUT tmux
  (`tmuxOrExplain`'s plain login-shell fallback) is still recorded `tmuxBacked` — core cannot tell
  from here that the remote command degraded — so it too gets the alt switch (and `coAttachMouse`,
  and `tmuxClient`'s resync re-apply), hiding that shell's normal-buffer scrollback; detecting the
  degrade is a follow-up. Without it a
  renderer reload left every terminal on the normal buffer, piling up to 10k lines of scrollback
  and forcing a layout per output frame — measured 16.1% vs 7.3% CPU for one terminal at
  20 lines/s, 313 vs 1 forced layouts per 20 s. **A resync repaint loses the same two modes**:
  `repaintResync`'s `term.reset()` drops ANY terminal — the solo spawn too, not only a joiner —
  back to the normal buffer and clears mouse tracking, and resyncs happen under backpressure, i.e.
  on exactly the streaming terminals the alt switch exists for. So every create now reports
  `PtyCreateResult.tmuxClient` (same `tmuxBacked && !sessionHost` gate, set on spawn AND join), and
  `repaintResync` writes `CO_ATTACH_ALT_SCREEN_SEQ + CO_ATTACH_MOUSE_SEQ` between the reset and the
  paint when it is set. Optional on purpose: an older core or relay peer omits it and gets the old
  behavior (nothing re-applied), never a guess. The recycle banner ("session restarted by another
  user") is written AFTER the joiner's seed paint for the same reason — written before the alt
  switch, it sat in a buffer nobody could see.

xterm's own `scrollback` (`xtermScrollback(settings.tmuxScrollback)`, floored at 1000, capped at
`XTERM_SCROLLBACK_MAX` = 10000) is kept for the sessions tmux does *not* back (a plain shell when
tmux is unavailable) and for the cold-snapshot replay — it is not what the user scrolls in a tmux
session. **The Windows session host's headless emulator (and `NativeWindowsPane`) uses the SAME
clamp** (`src/shared/scrollback.ts`, re-clamped inside the host for older clients), never the raw
`tmuxScrollback`: xterm holds every line at full width (cols × 12 B, ~72 MB for 50k × 120 cols per
session) where tmux stores only used cells, and nothing above the renderer's cap is ever shown.
tmux's `history-limit` keeps the raw value.

### Character widths — one table for every emulator (`@shared/terminal-width`)

Every xterm in the stack sizes characters through `activateTerminalWidths`: the renderer's
terminals (`renderer/terminal/unicode-width.ts`, which explains the move off Unicode 6) and the
Windows session host's headless emulator, which is what a reattaching viewer is repainted from.
The table is Unicode 11 plus one rule xterm's tables lack: **a one-cell emoji followed by VS16
(U+FE0F) is two cells**, as are the keycap sequences (`1️⃣`). The program writing to the pane
(`string-width` in every Node agent CLI) and tmux (`variation-selector-always-wide`, on by default)
both count those pairs as two cells; xterm counted one, and every repaint by absolute position after
such a character landed a column short and left stale text behind. Measured with claude-hud's
`⏱️` status line, which read `113` for `11%` and `2h 327` for `2h 32m`. VS15 is deliberately left
alone (`string-width` sizes `⭐︎` by its base, as xterm already does), and so is an ASCII base
with VS16 alone (`1️` is not an RGI emoji) and the unqualified keycap `1⃣` (one cell, as tmux sizes
it; some `string-width` releases say two). Known xterm limitation: in insert mode (IRM) a widened
join overwrites the next cell instead of shifting the line. Agreement is the goal, not a particular
number: change the table in that one module, never in one emulator.

## Terminal node lifecycle (gotchas)

`src/renderer/nodes/TerminalNode.tsx` is the trickiest file:

- The xterm instance + PTY session are created once in a `useEffect(…, [data.respawnNonce,
  offscreenEpoch])` and torn down on unmount. The component persists across re-renders because
  React Flow keys nodes by `id` — never change a node's id, or you'll respawn its terminal.
  **Third in-place state — "released" (2026-08-11, offscreen dispose):** a node fully offscreen
  in the canvas viewport for `settings.offscreenTerminalMinutes` (default 10, `0` = never;
  Settings → tmux) has its xterm + PTY client torn down IN PLACE — node stays mounted showing a
  plate, tmux session untouched — and revives (warm reattach) when it re-approaches the viewport.
  Pure policy: `terminal/offscreen-policy.ts`. Two load-bearing rules a refactor must not undo:
  (1) the **visibility IntersectionObserver lives in its own mount-stable `[termKey]` effect**,
  NOT the lifecycle effect — the down transition re-runs the lifecycle effect, and an observer
  owned there dies with it, making revive unreachable (permanent plate; caught in review). The
  lifecycle run publishes to it through refs (`visibilityReportRef`, `offscreenLiveRef`,
  identity-checked on clear). (2) The remote exclusion asks `offscreenCoreIsRemote(session.source)`
  (`'local'` only is eligible — relay/server tabs excluded), NOT `data.remote`, **a field nothing
  sets on node data** (a gate on it was constant false and type-invisible; pinned by tests).
  SSH-project nodes are also excluded; collapsed = hidden (same convention as the WebGL budget);
  a `respawnNonce` bump while released revives first. Agent-status/fan-out clears live in a
  dedicated unmount-only effect (a release or respawn must not blank a live badge).
- **React StrictMode is deliberately not used** (`main.tsx`) — double-mount would spawn
  two PTYs per node.
- The xterm container is `nodrag nowheel`; a transparent **hover-guard** overlay sits on top
  until you dwell `settings.panHoverDelay` (so quick drag = move node, scroll = pan). After
  the dwell the guard is removed and xterm takes input. The header stays draggable.
- **Sloppy focus** (default, `settings.terminalFocusFollowsPointer` ON): the dwell above TAKES the
  keyboard, and `mouseleave` only re-arms the guard — it never blurs the xterm or drops the active
  flag / presence focus. The terminal keeps the keyboard until another node takes it (its dwell, a
  click) or the user clicks elsewhere. This replaced strict focus-follows-mouse, where leaving the
  node released everything and typing with the pointer resting on the canvas went nowhere. Release
  follows DOM focus through the SAME hook click to focus uses (below), so a dwell onto a node whose
  ⌘M view covers its xterm blurs the OTHER terminal's xterm (`dwellBlursForeignTerminal`) — else the
  previous pane keeps eating keystrokes while another node reads as active. The guard stays a
  POINTER contract in this mode: the hook's `setArmed` is a no-op here (`focusDrivesGuard`).
- **Click to focus** (`settings.terminalFocusFollowsPointer` OFF; issue #757, Settings → Behavior):
  the pointer decides nothing: no dwell, and `mouseleave` changes nothing. A click (`HoverGuard`
  pointer events → `onGuardClick` → `enterNow`) or a "go to node" takes the keyboard, and the
  node's active flag, presence focus AND guard then follow DOM focus. ONE hook
  owns all of it, `nodes/useClickToFocus.ts`, and it binds to the stable `.term-node` ROOT, never
  the React Flow wrapper: focus mode MOVES that root into the fullscreen surface
  (`surface.appendChild(root)`), so a listener or containment check captured on the wrapper went
  deaf there and read every body press as an outside press. The wrapper is re-resolved at event
  time only to recognise the node's own React Flow chrome (resize handles). Root `focusin`/
  `focusout` run `focusLossOutcome` (`lib/terminalFocusMode.ts`): focus moving inside the node or
  the WINDOW blurring (Cmd+Tab) keeps it, a press on the node's own chrome (header drag — React Flow
  focuses its wrapper, MEASURED in Electron 42) hands it back to the element that lost it (the ⌘M
  composer) or the xterm (`reclaimTarget`), anything else — another node, a field, the empty canvas
  (`onPaneClick` blurs the xterm textarea, `shouldReleasePaneFocus`) — releases it and re-arms the
  guard. A press on the ⌘M chat's MESSAGE TEXT (`.term-chat__msgs`) is the start of a drag-selection, so
  its reclaim waits for the press to end (`reclaim-on-release` → `reclaimOnRelease`): a plain click
  still hands the keyboard back to the composer, but a press that selected text leaves the
  selection (and Cmd/Ctrl+C) alone — reclaiming at once moved the selection into the textarea and
  nothing in the chat could be highlighted or copied. One document capture `pointerdown` does the rest: outside the node it releases activity
  claimed WITHOUT focus (go-to-node under the ⌘M view, Canvas's own `setActive` on a jump — no
  focusout ever comes, `outsidePressReleases`), and a document capture `focusin` landing outside
  the node (its own wrapper counts as inside) does the same for KEYBOARD focus moves — ⌘M open,
  then ⌘K's autofocus — else the stale `activeId` suppresses that node's unread dot; inside the BODY, any deliberate primary press that is not on the guard runs `enterNow`
  (`bodyPressAcknowledges`) — guard down, xterm focused, ⌘M view open, all the same — so an unread
  finish is cleared by clicking the terminal, not only by clicking the guard. A focus RESTORE that
  no press caused (window activation) never acknowledges. The xterm blur that OPENING the ⌘M view
  causes is `keep`, not a release (`lostIsCoveredXterm`). Focus mode's reparent blurs a focused xterm SYNCHRONOUSLY inside
  `appendChild` (MEASURED, Electron 42: `relatedTarget` null, root still connected — so an
  `isConnected` test cannot see it); `nodes/reparentKeepingFocus.ts` brackets the move with a flag the
  hook honours (`reparenting`) and re-focuses the element that held the keyboard, in BOTH modes —
  before it, entering/leaving focus mode dropped the keyboard in the default mode too. The guard listens to POINTER events
  (`nodes/HoverGuard.tsx`): React Flow's d3-drag swallows a left `mousedown`/`mouseup` on a
  draggable node before React sees them, so the old mouse-event guard never received a left click
  (#87's click-to-focus only ever worked through the dwell). Only a literal `false` in
  settings.json selects it (`resolveFocusFollowsPointer`). The ⌘/ shortcuts panel prints "Click" instead of
  the dwell. Renderer only: Desktop + Server Edition identical; kanban card modal N/A (it has no
  hover guard); Mobile N/A.
- **Where the wheel stops being the terminal's is decided by HIT TEST, per packet** — `Canvas.tsx`
  answers `overNativeScrollable` with `target?.closest('.nowheel')`, and React Flow's own
  `panOnScroll` walks the same class (`noWheelClassName`). Two consequences, and issue #767 reported
  the second as the first. **(a) Inside the body the wheel is already the terminal's, band
  included.** `.term-node__xterm` carries `nowheel` AND is `position: absolute; inset: 0` over a
  body with no padding and no border, so the visible inset band (the host's own `4px 2px 6px 6px`)
  and a co-attach letterbox band are part of the HOST's hit area — MEASURED with `elementFromPoint`
  under headless Chromium against the verbatim rules, and now pinned as a three-link CSS invariant
  by `canvas/terminal-wheel-boundary.test.ts`. The styles.css line the report reads ("insets the
  xterm by a few px") is about PAINT — the band shows the body's `--term-bg` because the host paints
  none — and paint is not hit testing. An overlay laid over a LIVE terminal therefore owes
  `pointer-events: none` (`.term-node__stalecwd`, joining `.term-node__upload` and
  `.term-copy-pill`); an overlay that REPLACES a dead view (`.term-node__offscreen`,
  `.term-node__closed`) deliberately keeps the canvas wheel — there is nothing underneath to
  scroll, so panning is the useful answer. **(b) The boundary that actually moves is TEMPORAL, not
  spatial**: while it is up, `.term-hover-guard` covers the whole body and is NOT `nowheel`, so for
  the first `panHoverDelay` after the pointer enters — and again after it leaves — a wheel over
  terminal TEXT pans the canvas. That is the guard's own contract ("quick drag = move node, scroll
  = pan canvas") and the reason those incidents cannot be reproduced on demand. Hoisting `nowheel`
  to `.term-node__body` would swallow the guard with it (a second consumer, React Flow's, reads the
  class the same way and no per-element opt-out can reach it); hoisting it to the whole NODE would
  additionally take wheel-zoom-to-cursor away over every node, which is exactly where a
  `wheelZoom` user aims.
- **FitAddon reads the host's computed size, not its content rect.** The absolute, inset
  canvas host uses `box-sizing: content-box` so its padding is excluded from that size
  (#671). Its outer hit/plate rect still fills the body. The board modal instead keeps
  padding on a separate wrapper. Do not put border-box padding back on a fit host:
  it over-reports rows and clips the last line. `scripts/terminal-fit-layout.test.ts`
  measures real xterm layout through resize sweeps at DPR 1, 1.25, 1.5 and 2 in Chrome
  (`CHROME_BIN` overrides the executable); this does not verify GPU row-seam rendering.
- A `ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS
  transform, so it does *not* change `clientWidth` — cols/rows stay stable across zoom.
  `scale-fix.ts` patches xterm's mouse coords so text selection stays aligned when zoomed.

## Node kinds (all rendered by React Flow custom nodes)

- **terminal** (`TerminalNode.tsx`) — xterm + tmux (see above). Header: collapse, color,
  click-to-rename title, ✦ AI-name, ×. Body has a **hover guard** overlay: dwell
  `settings.panHoverDelay` (default 600 ms) before the terminal takes focus — before that,
  drag = move node, scroll = pan canvas. **Cmd/Ctrl+M** (while hovered) toggles a markdown
  render of the captured output — `nodes/TerminalMarkdownView.tsx`, which takes a node id + a
  `capture` function (no React Flow context, so the kanban card modal can reuse it) and owns the
  lifecycle: capture on mount + a ↻ refresh, a request token that drops stale/late answers, an
  explicit empty state ('' is an answer; a rejected capture is a failure, not empty), only the
  LAST `MD_OUTPUT_MAX_LINES` (5000) lines rendered and announced when cut, scrolled to the latest
  output. Entering the view (output or ChatPanel) blurs the xterm and, for the ChatPanel, puts the
  keyboard in its composer (only when focus was nowhere, in this node or in a terminal — never out
  of a text field elsewhere; a lazy-loading or disabled composer takes it when it mounts/enables,
  and an exit cancels the request); leaving it restores focus
  only if the terminal had it on entry AND focus is now nowhere or still inside this node
  (`terminal/useMdModeFocus.ts`). The open view is PERSISTED (`CanvasNodeState.mdMode`, written only
  when open), so a project switch or a reload brings the node back on the view it was left on.
  While the view is open, every "take the keyboard" path (hover
  dwell, click, sidebar/notification jump) goes through `focusXtermUnlessCovered` and leaves the
  hidden xterm unfocused — the overlay sits inside the node body, so a dwell over it used to route
  keystrokes into a pane nobody could see. The body's file DROP / file PASTE handlers (which focus
  the xterm and paste paths into it) are the other way in, and they stand aside while covered
  (`terminalOwnsFileInput`): a screenshot pasted into the ChatPanel composer used to be caught in
  the capture phase and typed as a path into the hidden pane. Both are source-pinned in
  `useMdModeFocus.test.tsx`. Tag chips via `NodeTags`.
  **Selection + copy is tmux's** (its mouse is on — see the tmux section): drag to select, wheel to
  scroll tmux's history. A drag copies via copy-mode, and tmux emits **OSC 52** to the client, whose
  handler writes the **system clipboard** — the one copy path on every platform *and* over SSH (no
  `pbcopy`). OSC 52 writes an app emits itself (vim `"+y`, gh, yazi) reach the clipboard through the
  same handler (write-only — a read query is refused). The emulator's own copy chords stay for a
  selection xterm *does* own (`copyKeyAction`/`isCopyShortcut`): **Cmd+C** (mac), **Ctrl+Shift+C**
  and **Ctrl+Insert** (Linux/Windows) — matched on `e.key` *or* the physical `KeyC`, so non-Latin
  layouts still copy. A copy chord is **always swallowed**, selection or not: letting Ctrl+Shift+C
  fall through would reach the pty as `\x03` (SIGINT). Ctrl+Insert exists because Chromium reserves
  Ctrl+Shift+C for the inspector and a page cannot `preventDefault()` it — which is where Server
  Edition users land. Plain **Ctrl+C** is never intercepted.
  **Text paste uses the platform event** (`isPasteShortcut` → the `'native'` action): ⌘V on
  mac reaches the Edit menu's `{role:'paste'}`, whose `paste` event xterm frames
  as a bracketed paste. All the terminal does is stop CANCELLING the chord, and that is a
  **Windows-only** claim: xterm's keymap turns Ctrl+V into `\x16` with `cancel`, which suppressed
  Chromium's paste command *and* the Ctrl+V accelerator behind it, so Ctrl+V pasted nothing at all
  there (issue #562). Off Windows the chord stays `\x16` on purpose — mac pastes with ⌘V, Linux
  with Ctrl+Shift+V, and Ctrl+V is a key vim/readline users really send. Ctrl+Shift+V and
  Shift+Insert need no branch: measured against `evaluateKeyboardEvent`, xterm produces neither a
  key nor a cancel for them, so the platform already pastes. To select in **xterm** instead of tmux
  (or inside an app that grabs the mouse, like vim/htop), hold **Option** (mac —
  xterm's `macOptionClickForcesSelection`) or **Shift** (Linux/Windows) while dragging.
  **Screenshot paste (#712):** the capture handler in both TerminalNode and ModalTerminal
  owns files/images: save/upload, then paste the path, suppressing accompanying text. A
  macOS Ctrl+V may instead let a local foreground agent read its own system clipboard.
  Configured agent identity proves neither foreground state nor clipboard support, and a
  PTY write has no image receipt. Never synthesize that key or fall back between routes.
  The macOS shortcuts reference explains both keys; its Server Edition copy explicitly
  says Ctrl+V cannot transfer the viewer's clipboard to the host. SSH keeps remote uploads.
  **The path paste has a receipt for claude, and only for claude** (`terminal/image-paste-confirm.ts`,
  both surfaces through `pasteWithImageReceipt`). MEASURED on Claude Code 2.1.285 (bracketed paste,
  captures in `terminal/__fixtures__/claude-image-paste.json`): a path to an existing
  png/jpg/jpeg/gif/webp (any case) becomes `[Image #N]` in the composer within ~60 ms; bmp, svg,
  heic, tiff and a missing file stay text; `N` keeps counting for the session and does NOT reset
  when the composer is cleared. So the receipt reads OUR xterm buffer (the emulator, not tmux) for
  placeholder numbers ABOVE the highest one on screen before the paste (the counter only rises,
  so an older placeholder scrolling into view cannot confirm it; with none on screen, two pastes
  inside ~60 ms can still confirm each other), up to 3 s: "Image attached", else
  "Pasted the path — not confirmed as an image" (`.term-paste-pill`, top-right so it never covers
  the copy pill or the agent's bottom-left input line). Only when a claude CLI is in the pane
  (`agentProcessInPane`); every other agent was not measured and gets the paste with no receipt
  either way — nothing is claimed on its behalf. A terminal disposed mid-wait reports nothing.
  **Copying now says so**: the OSC 52 handler floats a transient `Copied N lines` pill over the
  terminal's BOTTOM-RIGHT corner (`.term-copy-pill`, the same class on the canvas node and the
  kanban card modal — one session seen twice must not speak in two voices; bottom-right because
  every agent CLI writes its input line bottom-left, and `pointer-events: none` because it sits on
  the terminal and fires on every copy), because tmux's `copy-pipe-and-cancel`
  clears the highlight at the exact instant it copies — which read as "the copy failed" to a user
  whose other pane ran claude. And a drag that produced NEITHER an OSC 52 nor an xterm selection
  means the pane's app captured the mouse (claude does, codex does not), so a one-time
  `Hold ⌥ to select text` hint fires instead (`nodeterm.seenSelectHint`). **The whole layer is
  OFF for an agent in `SELF_REPORTS_COPY` (`reportsOwnCopy` — claude, which prints its own
  "copied N chars to tmux buffer" line): a second message for one gesture is noise, and a claude
  terminal is byte-identical to before the feature. **One owner per pill:**
  the `copied` receipt is raised ONLY by the OSC 52 path, the hint ONLY by the drag path — the two
  never race for the same slot. The emulator's own copy **chord** (Cmd+C / Ctrl+Shift+C) deliberately
  raises nothing: Claude Code prints its own copy line ("copied N chars to tmux buffer"), and a
  second message for one gesture is noise. Decision logic is the pure `terminal/copy-feedback.ts`;
  `useCopyFeedback` is the glue (it also yields to a clipboard-failure `nodeterm:toast`, so the
  Server Edition never shows a green receipt beside a red banner), and the node publishes its sink
  through the module-level `copySubs` map because the OSC handler survives a park.
  **Shift+Enter** is remapped to `\x1b\r` (ESC+CR / M-Enter) so agent CLIs insert a newline
  instead of submitting (`terminalKeyAction` / `SHIFT_ENTER_SEQ` in `terminal-config.ts`; sent in
  all terminals — harmless in a plain shell). **Cmd (mac) / Ctrl+click** opens links in the
  output: URLs → default browser (`@xterm/addon-web-links`), file paths → editor node and
  directories → Explorer reveal (`terminal/file-links.ts`, existence-verified against the project
  fs via cached parent-dir listings, with `path:line[:col]` compiler-output suffixes). **What counts
  as a path is `terminal/file-link-tokens.ts`**, and it is generous on purpose because existence is
  the arbiter: segments take any Unicode letter/number/mark (`var/otta-aktarım/çıktı.sql`) and
  route-folder brackets (`app/(shop)/[id]/page.tsx`; prose parentheses are dropped only when
  unbalanced); a separator path with SPACES is offered whole, ending at a word with a separator, a
  word completing `name.ext`, or the line end — AND as its space-free pieces, which is what keeps
  `/usr/bin/python failed to start app.py` from costing the `/usr/bin/python` link (tokens may
  overlap; the provider keeps the first that exists in start/longest order, `linkAtCell` carries the
  rest as `alternatives` for the Cmd+click fallback and the link menu); a BARE filename (`README`,
  `foo.ts`) only when `looksLikeBareFilename` says so — versions (`v1.2`), abbreviations (`e.g.`)
  and plain words are never looked up, and a right-click does not claim a bare word; a `file://`
  URI is percent-decoded to its absolute path (local host only; Windows needs a drive). **The scan
  must stay linear** — it runs per hovered row on padded TUI rows; no backtracking regex, and the
  ReDoS guard in `file-link-tokens.test.ts` pins it (the previous regex took 2.2 s on a 30k-char
  word). Hit-tests and underlines go through `Paragraph.cellStart/cellEnd` (xterm cells, not string
  indices), so wide CJK glyphs before or inside a path no longer shift its range. A relative
  path is anchored on the node's LAUNCH cwd first, then on the pane's LIVE cwd (`pty:pane-cwd` —
  tmux `#{pane_current_path}`, local or over the ControlMaster; `findExistingPath`), because an
  agent prints paths relative to where IT runs; the launch cwd wins a tie so a link never changes
  meaning when the pane moves. A Cmd/Ctrl+click on a path that exists under neither raises a
  `File not found: …` toast naming where it looked — the click is swallowed before the async
  lookup, so without it the gesture silently did nothing. **"Could not check" is never "not
  found"**: a lookup has three outcomes (`PathLookup.unverified`, `PathResolution.unverified`), and
  `makeDirListingLookup` treats a REJECTED listing and an EMPTY one as unverified — `FsApi` is
  fail-open (`listDir` ends `catch { return [] }`, and a dead ControlMaster lists `[]`), so only a
  listing WITH entries can prove absence (same rule as `classifyEmptyListing`); `.git` is unverified
  too (both listing legs strip it). A failure is cached as a failure for ~1 s, never as an empty
  directory for the 3 s TTL. An unchecked launch-cwd candidate still lets the live cwd be tried (a
  hit there is proof). The toast then reads `Couldn't check <path>: <reason>` (`fileMissMessage`),
  and the link menu shows `Couldn't check: <reason>` instead of `Not found`. The path
  dialect follows the FILESYSTEM-OWNING CORE, not the viewer: desktop-local may use its own
  platform, Server Edition and relay tabs use the core's reported `process.platform`, and SSH
  projects are POSIX. A failed host-platform read disables file links for that connection — it
  never guesses from the browser. Standalone `ssh` terminal nodes remain URL-only because they
  have no remote fs API with which to verify a token; relay tabs do have a core-bound, jailed fs
  API and therefore support file links. Windows existence matching is case-insensitive and accepts
  both separators; UNC tokens are refused whole before they can be reinterpreted as cwd-relative.
  **Dropped / pasted file paths** follow the same core-platform rule (`dropDialect` /
  `quoteDroppedPath`, `terminal/file-drop.ts`): POSIX backslash-escaping everywhere — every SSH
  pane and Git Bash included, byte-identical to before — except a Windows core, where `\` is the
  separator and is never doubled: bare when nothing needs quoting, else double-quoted (pwsh/agent
  panes single-quote a path holding `$` or a backtick; an UNSET shell is spelled for PowerShell,
  the core's own Windows default, so a `$` path is not expanded). The image receipt strips one pair
  of quotes before reading the extension. `isShellCommand` likewise normalises the session host's
  image names (`pwsh.exe`, `C:\…\cmd.exe`) — leading `-`, either separator, case, `.exe` — which is
  why the session host's `paneCommand` walk (`process-tree.ts`) answers a shell name only when EVERY
  process in the tree is a shell: claude's Bash/PowerShell tool or a `cmd /c npx` MCP launcher is a
  shell LEAF under a live agent, and must not read as "the CLI let go of the pane". A path an
  agent TUI wrapped under a **hanging indent** (Codex: 2 spaces, broken after a `/` or at a space)
  is neither a soft nor a hard wrap, so it is offered as extra READINGS (`hangingReadings` — the
  seam as nothing, and as one space), tried BEFORE the plain row's tokens by both the provider and
  `linkAtCell`; existence decides, and a click on the indent is not a click on the path.
  **Right-click on a link** opens a link menu (pure `terminal/link-menu.ts`; the listener is
  `installLinkContextMenu`, beside the Cmd+click fallback and sharing its `linkAtCell` hit-test):
  Open / Reveal in Explorer / Download / Copy path for a file, Open in browser / canvas browser /
  Copy link for a URL. The gates are the Explorer's, reused not restated — Download only where
  `downloadRoute` ≠ `none` (SSH project → scp to this machine, Server Edition → HTTP), never on a
  desktop LOCAL project; the OS reveal only under `canUseLocalShell`. **The decision is made on the
  right PRESS, not on `contextmenu`:** tmux 3.x binds `MouseDown3Pane` to its own `display-menu`, so
  the press is what must be swallowed; a right-click OFF a link stays byte-identical (tmux menu,
  agent TUI, node menu). A path-shaped token that turns out not to exist still gets a menu ("Not
  found" + Copy path; "Couldn't check: <reason>" when its existence could not be checked) — its
  press was already swallowed, and a silent swallow reads as broken.
  Downloads report in a `DownloadStrip` floated over the terminal, not in a drawer that may be
  shut. The kanban card modal's right-click menu has URL rows only and no "Open in canvas
  browser" (the node would land under the board). Its Cmd/Ctrl+click DOES follow file links, with
  main's token model and lookup, but routed by the CARD's project, not the active one
  (`lib/cardFileLinks.ts` — the Omni board opens cards from every project; any doubt turns file
  links off): a file opens in `LocalFilePreviewModal` over the card (HTML copied into the agent-web
  jail and shown under its strict CSP; source text in a browser tab, which has no webview), whose
  "Open on canvas" is offered only for a card of the active project. On the canvas a LOCAL `.html`
  opened by a link or that button renders as a WebNode (`fileViewerKind`'s `renderHtml`, carried as
  `view: true` on `nodeterm:open-file`); Explorer, ⌘K and the files node still open it in the editor.
  **Hovering a link says what a click opens** (`terminal/link-hover.ts`): the RESOLVED absolute
  path — which of the two cwds held it — plus the gestures, `<abs> (⌘-click to open · ⇧⌘-click to
  open with default app)` (Ctrl/Shift+Ctrl off-mac; a directory reads "reveal" / "open in
  Finder|file manager"; a URL just `<url> (⌘-click to open)`, OSC 8 included, whose target the label
  hides). It rides xterm's `ILink.hover`/`leave`, which fire in a tmux pane too — the linkifier
  listens to `mousemove` on the screen element whatever the mouse-tracking mode; only CLICKS need
  the capture fallback. One tooltip per xterm instance, INSIDE `term.element` (parks and dies with
  the terminal, scales with the canvas zoom like the copy pill; positioned by dividing the rect by
  the rendered/layout width ratio), `pointer-events: none` + `xterm-hover`, hidden by any press or
  wheel. **Shift+Cmd/Ctrl+click opens with the OS default app** (`linkOpenIntent` — ONE routing rule
  for the provider `activate` and `installLinkClickFallback`): `shell.openPath` behind
  `canUseLocalShell`, the same gate as Reveal in Finder, so a directory opens in the OS file
  manager. Everywhere that gate says no the click TOASTS its reason (`systemOpenRefusal`) and the
  hint omits the gesture: an SSH project is refused rather than downloaded-then-opened (a click must
  not silently copy a file or folder to this machine, and edits would land on a stale copy — the
  link menu's Download is one right-click away), the Server Edition is refused rather than falling
  back to the plain open (a modified gesture that quietly does something else is harder to learn;
  the bridge's `shell.openPath` stays its documented inert stub), and a relay tab is refused (the
  path is on the peer). Shift alone is never a link gesture (xterm's selection modifier); a
  modified press released on another cell is a drag and is left alone, and a Shift+Cmd click that
  extended an xterm selection does not open.
  **Home-relative `~/x` tokens** (Claude Code prints its plan file as `~/.claude/plans/<name>.md`)
  stay `~`-rooted all the way to the fs call and are expanded by the core that OWNS the filesystem
  — `expandHomePath` in `core/fs-handlers.ts` for desktop/Server Edition, the remote shell for
  `sshFs` — because the renderer does not know that home. A `~` after a path character (`a~/x`)
  or `~user/x` is not a home path and yields no link. The relay's jailed `fs.*` calls fs-ops
  directly and does not expand, so a relay tab's `~` token fails closed (no link).
- **Agent** (`createAgentNode(agentId, …)`) — a terminal preset that runs an agent CLI as its
  `initialCommand` (runs once on open via `transport.write`, then cleared), with `data.agentId`
  set. Builtins (`claude`/`codex`/`gemini`) come from `AGENT_CONFIG` (clay color etc.).
  Agent nodes get extra behavior **gated by the
  agent's capabilities** (see **Agent support** below): a busy/working badge + unread dot +
  completion notification + session-name chip (hook-capable agents), content search, and the
  Claude-only **Branch conversation** action. Custom user-defined agents spawn + show
  process/terminal-title status only.
- **sticky** (`StickyNode.tsx`) — colored note, free text, collapsible. Has link handles:
  connect a sticky to any terminal node to attach the note as context (see Context Link).
- **group** (`GroupNode.tsx`) — real React Flow parent/child frame, and frames **nest** (2026-08):
  a group may contain other groups to any depth. `groupSelectedNodes` wraps objects that share ONE
  container — frames included — creating the wrapper inside that container; a mixed-container set,
  or an ancestor selected together with its own descendant, is **refused** rather than scrambled
  (positions are only comparable within one container, and the descendant would be torn out of the
  ancestor being wrapped). Box-selection routinely catches both, so structural actions normalize
  the selection to its subtree roots first (`selectedRootIds`). `ungroupNodes` promotes a frame's
  direct children into **its own parent** (not to the root — that would move them by the whole
  ancestor offset); `reparentNode` moves a node OR a whole frame subtree, keeps its **root-space**
  position fixed (`rootPosition`, not the old add-one-parent's-origin math) and refuses a cycle;
  `addSelectionToGroup` adds a selection to an existing frame; `reorderGroupWithinParent` reorders
  a frame among its siblings, carrying its subtree. `nodeStatesToFlow`/`groupsFirst` emit frames
  **depth-first from the root** — a flat "groups first" sort is not enough once two groups compare
  equal — and that persisted order is also the downgrade contract (a pre-nesting build's stable
  sort leaves it alone, so a nested tree still hydrates parent-first and renders there). The order
  has ONE definition (`groupsFirstBy`, `src/shared/node-order.ts`), and the shared op reducer
  (`applyCanvasMutation`) re-sorts with it on an append or a `parentId` change — the same two points
  the live React Flow apply does — because a governed Server Edition project's file is written from
  the canvas authority's array, not from React Flow's.
  **A frame that gains a child bigger than itself is re-fitted, ancestors included**
  (`fitGroupToChildren` up the chain): a wrapper created at `(minX-28, minY-62)` relative to its
  parent is routinely negative, and `extent:'parent'` would make React Flow clamp it into an
  inverted range — snapping the frame hundreds of px away and dragging the whole wrapped subtree
  with it. Visually: a dashed rounded frame in the group color with a floating label pill (color
  dot + editable name) on the top border and ungroup/× top-right (on hover/selected). **The pill
  is the frame's `dragHandle`** and the frame body is `pointer-events: none` — a frame is a
  background container, not a giant drag target, so its body passes clicks to the pane and an
  outer frame cannot swallow the clicks meant for a frame drawn inside it. The
  `NodeResizer` line is hidden (`lineStyle` transparent) so it can't draw a sharp-cornered
  box; the selection ring is a `box-shadow` instead, which follows the same `border-radius`.
- **editor** (`EditorNode.tsx`) — Monaco code editor for a `filePath`; reads/writes via
  `fs:read`/`fs:write`, auto-detects language from the path, ⌘S saves, dirty dot. A
  **Preview / Edit** toggle (or ⌘M while hovered) renders the live content as markdown.
  **Image files** (png/jpg/gif/webp/bmp/ico/svg/avif) skip Monaco and show an `<img>`
  preview instead — read as base64 via `fs:read-binary` into a `data:` URL (CSP allows
  `img-src data:`), on a checkerboard backdrop with the pixel dimensions in the header.
- **diff** (`DiffNode.tsx`) — Monaco diff editor; `diffStaged` chooses HEAD↔index (staged)
  vs index↔working (unstaged) via `git:show-file` + `fs:read`. Read-only.
- **video** (`VideoNode.tsx`) — a video player; a local file is served over the `nt-media://`
  protocol (allowlisted on mount via `media.allow`) with native controls; an SSH-project file
  (`data.sshFs`) is first pulled into the local media cache over the project's ControlMaster
  (`media.allowSsh`) then played the same way.
- **web** (`WebNode.tsx`) — an Electron `<webview>` (locked down, no `nodeintegration`) that loads
  a live `data.url`, or serves local html at `data.filePath` over `nt-media://`.
- **browser** (`BrowserNode.tsx`) — a navigable Chromium browser wrapping the shared
  `BrowserSurface` (webview + toolbar); the last top-level URL persists to `data.url`, and the same
  surface backs the kanban card modal's browser popup.
  **Page zoom is owned by the GUEST boundary, not the canvas DOM** (`@shared/webview-zoom` +
  `main/webview-zoom.ts`, 2026-09-20). Measured on Electron 42.10.1 with a physical wheel injection:
  Ctrl+wheel over the page arrived in its OOPIF with `ctrl=true`, the host received NO `wheel`
  event, and Electron left the factor at 1 until the guest `WebContents`'s `zoom-changed` handler
  called `setZoomLevel` (one level produced 1.2). So `.browser-node__view` / the web node body KEEP
  `nowheel` — it prevents React Flow from taking a wheel packet over the page, and removing it
  cannot make an OOPIF event bubble. Main's one `web-contents-created` listener installs wheel and
  Cmd/Ctrl +/-/0 zoom only for `getType() === 'webview'`; the shared `WebviewZoomControls` calls the
  same 50%–300% policy for `WebNode` and `BrowserSurface`, which also covers the card modal. The app
  does NOT persist zoom in `project.json`: Electron propagates a zoom level by origin, so a per-node
  persisted value would make two nodes for one origin fight. Desktop: full; Server Edition:
  controls hidden (no Electron guest); Mobile: N/A (no canvas).
- **files** (`FilesNode.tsx`) — a file-manager node: ONE directory listing (`data.cwd`, persisted),
  pinned to the canvas beside the terminals working in it. Deliberately not a second Explorer: the
  drawer is a single tree rooted at the project cwd that covers the canvas, so it gives you one
  cursor and a lot of scrolling; several of these give you `src/renderer/nodes` next to the agent
  editing it and another on `docs/`. Navigate in place (breadcrumbs collapse deep paths but every
  crumb stays clickable), filter, create a file/folder, copy a path, reveal, and open a terminal in
  the folder shown (a `nodeterm:open-terminal` event, the sibling of `nodeterm:open-file`).
  - **It adds NO new IPC.** Everything runs on the existing `FsApi` (`list`/`mkdir`/`exists`/
    `write`) — which is why it works on Desktop, the Server Edition, an SSH project and a relay tab
    on day one; `mkdir`/`exists` are genuinely LIVE on a relay tab (see the Explorer bullet above —
    that line used to claim otherwise), so "New folder…" works there too. **Rename/move/delete are
    the deliberate v1 gap**: each needs a new leaf in `core/fs-ops`, an IPC channel, preload, the
    ws-bridge, `main/ssh-fs` (remote quoting) and the relay host-service, plus confirm dialogs and
    dangerous-path guards. That is a separate change with separate risk, not a corner to cut inside
    this one.
  - **Which filesystem** is `EditorNode`'s decision, read the same way: `data.sshFs` → the SSH
    project's host over the ControlMaster; otherwise the node's own SESSION api, which is the local
    core for a local project and the PEER's for a relay tab. Reading it off `useSession()` rather
    than `window.nodeTerminal` is the entire reason a relay tab browses the right machine.
  - **Opening is delegated, never reimplemented**: a file dispatches `nodeterm:open-file`, so
    editor-vs-video-vs-image routing stays in Canvas's one `openFile` and this node never grows a
    second opinion about what a `.png` is. `fileOpenTarget` decides only canvas-vs-OS, and a REMOTE
    listing never reaches the OS branch — `shell.openPath` opens a path on THIS machine. **The OS
    branch is now also gated on being ABLE to open locally**, not just on remoteness: `shell.openPath`
    is a documented `noop` in the Server Edition (`bridge/stubs.ts:180-186`), and a browser tab's own
    session `source` is `'local'` — `SessionSource` declares `'server'` but nothing ever constructs
    it (`session/session.ts:8`), so `source` alone can never tell you you're in a browser, only
    `isBrowserRuntime()` can. Opening a `.zip`/`.dmg` was therefore a silent dead click; closed by
    `canUseLocalShell` (`lib/download.ts`) — ONE predicate for every `shell.*` path action, with
    `canRevealLocally` kept as its older reveal-specific name so existing callers are untouched.
    Reveal was gated and openPath was not, and writing that rule twice is how they drifted.
  - **Two state bugs, both fixed.** (a) A directory a removed worktree took with it used to render
    as "This folder is empty." — not "Could not read this folder" — because `FsApi.list` is
    fail-open by contract (`core/fs-ops.listDir`/`SshFs.listDir` both end `catch { return [] }`, and
    the SSH IPC resolves `[]` even for a dead ControlMaster). `fs.exists` cannot disambiguate either:
    it's `stat`-based (true for a dir you can stat but not `readdir`), and on SSH its `false` can't
    separate "gone" from "the ControlMaster died" — the same conflation `SshFs.readTextChecked`
    (`main/ssh-fs.ts:164-176`) refuses, on the rule "a failed read is never evidence of absence". Now
    disambiguated by probing the PARENT's listing instead (`classifyEmptyListing`, pure,
    `lib/filesNode.ts` — the idiom `SshProjectDialog.tsx:112-125` and `file-links.ts`'s
    `makeDirListingLookup` already use), which answers `missing` / `empty` / `unreachable` /
    `unknown`. The parent CONTAINS the directory we are standing in, so it cannot legitimately be
    childless: an empty parent listing means we could not see it, which is `unreachable` and gets
    its own sentence naming both possible causes. That case used to answer `unknown` and render as
    "This folder is empty." over a dead ControlMaster, the commonest cause of an empty remote
    listing and the most reassuring possible lie. **`unknown` is reserved for the paths whose parent CANNOT answer** — a non-`/`-absolute cwd
    (an SSH project's `remoteCwd` defaults to **`~`**, where `parentDir` is `/` and `/` has no entry
    named `~`, so an empty remote HOME reported a deletion), a `.git` cwd (both listing legs strip
    it on purpose), and `.`/`..` segments; a case-folded match counts as present, for the
    case-insensitive filesystems where `readdir` answers with the on-disk spelling. `missing` must
    be the conclusion we are SURE of. Nothing is published until the verdict is in, so a deleted
    folder never flashes "empty" on its way to the error.
    (b) Nothing reset the list on navigation, so "Loading…" was reachable only on the very first
    mount — every later directory change showed the PREVIOUS directory's rows. Fixed by storing the
    listing WITH the cwd it belongs to, so a cwd change IS the loading state by construction; a
    re-list after a create deliberately keeps its rows (same directory, re-read).
  - The title tracks the folder only while `titleAuto` is unset — the same contract an agent node's
    session name uses, so navigating never overwrites a name the user typed.
  - A files node inside a REMOVED worktree is displaced like an editor, not like a terminal
    (`displacedByWorktree`): it has no session to disturb, so it is caught by path wherever it sits.
    The patch is the pure `displacedFilesPatch` (`lib/filesNode.ts`), where `null` means LEAVE IT
    ALONE on the dead path — the parent probe above then tells the truth — because
    `resetDisplacedCwd`'s fallback can be `undefined`, and writing that through would
    have cost the node the only thing it knows about itself. **The READ side is guarded too**: a
    files node with no `cwd` says so instead of falling back to `'/'` — `project.json` is
    git-shared, hand-editable input that nothing validates for this kind, so guarding only the
    writer left the silent root-browse reachable anyway. And `createFilesNode` places through
    `placeNode`, not `placeAt`, so snap-to-grid applies to its size as well as its position (React
    Flow resizes by adding a grid multiple to the START size, so an unsnapped box never lands on
    the grid later). The title
    rewrites alongside when `titleAuto` holds — the ONE cwd write that does not go through `navigate`.
  - **"New terminal here" was broken on BOTH remote kinds, and not by this node's own doing.**
    `addTerminal` resolves the project from `activeProjectId` and `createTerminalNode` does
    `cwd: ssh ? ssh.remoteCwd : cwd` (`state/workspace.ts`) — on an SSH project the folder on screen
    was silently DISCARDED and the terminal opened at the project root, a pre-existing hole in
    `addTerminal`'s `cwdOverride` contract affecting every caller, not just this one. Fixed by routing the call
    through the EXISTING `nodeSshFor`, which already carries this exact reasoning ("passing the
    project's ssh unchanged silently REPLACES the caller's cwd") and which `addTerminal` simply
    never used; it is handed `cwdOverride` and never the resolved `cwd`, because an SSH project can
    still carry a local `project.cwd` that `scmCwd` falls back to, and promoting that would root
    remote terminals at a path from the wrong machine. On a RELAY tab there is no `ssh` to
    rebind, so the row used to spawn a plain LOCAL terminal at the peer's remote path; it is now
    withheld there instead — spawning onto a peer's core is a real feature, not a one-liner.
  - Creation needs a project directory (`hasCwd`), and **the row degrades EXPLICITLY rather than
    vanishing** — disabled, carrying `FILES_NO_CWD_HINT` (an alias of `NEW_FILE_NO_CWD_HINT`), on
    the pane menu, the Dock and the sidebar "+". That is the rule #621 established for "New file…"
    and the SSH worktree row: a cwd-less project is a supported, persisted canvas, so a row that
    simply disappears takes its own reason with it while the fix ("Set folder…") sits one menu
    away. **⌘K is the deliberate exception** and hides the entry, exactly as main's "New file…"
    does — a disabled palette entry surfaces as a search result that does nothing, the same reason
    `sshAccountsHint` is omitted there. Inside a group frame it inherits a bound **worktree's** cwd
    via `cwdForNewNodeIn`, so a frame per branch also means a file tree per branch.
  - **A node kind not registered in `lib/reopenNode.ts` is a trap, and this one fell in it.** Every
    kind must sit in exactly one of `UNRESTORABLE` or a `buildBase` `case` — `files` was in neither,
    so ⇧⌘T recorded a snapshot (and a persisted `closedSessions` twin) that `buildBase`'s
    `default: return null` could never restore: a dead, clickable entry that compiles, typechecks and
    passes every test. `files` now has a `case` (it IS restorable — its whole state is the directory
    it shows), unlike `trigger`, excluded for the same missing-case reason
    (`reopenNode.ts:58-60`, the comment that made this findable). Two kinds have fallen in this trap
    now; treat registration as a checklist item for the next one.
  - **Kanban: deliberately not a card.** `canvas/toKanbanSession.ts` maps `browser`, `sticky` and
    `terminal` and returns `null` for everything else — cards do not "derive from terminal nodes",
    they derive from that explicit list. A files node has no session to co-attach and no text to
    edit; its value is spatial adjacency to the terminals working in the directory, which a column
    layout would discard.
  - `folderTitle` lives in `lib/explorerCreate.ts` (a zero-import leaf), not `lib/filesNode.ts`:
    `filesNode.ts` imports `isVideoFile` FROM `state/workspace`, so importing back would close a
    cycle. `filesNode.ts` re-exports it, so call sites are unchanged.
  - **The `/`-separator assumption is a KNOWN gap, shared with `explorerCreate`** (the Explorer
    drawer and canvas "New file…" already run on the same helpers) — `C:\x\y` reads as one segment.
    To be closed in ONE place for both, using the core-owns-the-dialect rule `terminal/file-links.ts`
    already implements. The TRAVERSAL half is closed: `newEntryPath` splits its `..` check on
    `[\\/]` and refuses a Windows-absolute name, because a guard that reads `\` as ordinary text is
    wrong about the machine that resolves the path. The construction half deliberately is not: on
    POSIX a backslash is legal filename text, so the join stays `/` and `weird\name.txt` is still
    one file. Guard on both dialects, construct in one.
  - **Mobile**: N/A — *nodeterm mobile* attaches to tmux sessions over the transport protocol and
    has no canvas or file-browsing concept; adding one means extending that protocol.
- **whiteboard** (`WhiteboardNode.tsx`, `whiteboard/WhiteboardEditor.tsx`) — an Excalidraw board;
  full write-up in `docs/whiteboard-node.md`. The invariants: (1) editing is ONE live editor
  portaled into `.canvas-root` over the node's box, never inside the scaled node (pointer drift,
  blur, and `.flow-wrap`'s wheel capture); (2) the scene is a side file the core addresses by
  (project, node id) — `core/whiteboards.ts` — and NEVER by a path from node data (project.json is
  git-shared, hostile input); node data holds only `whiteboardSource` (a copy's original, by id)
  and `boardRev` (once per session); (3) the overlay is `data-nt-keyboard-owner`, which every
  typing-aware key site honours via `isKeyboardOwnerTarget`; (4) every save is a COMPARE-AND-SET:
  it sends the revision its editor last read or wrote (`rev`, `dev:ino:size:mtimeNs` of the scene
  file — writers publish by rename, so it changes on every write; `null` = no board of its own yet)
  and the core refuses it when the file on disk has moved on, so a board open in two places (two
  tabs, a desktop and a browser on one folder, two hosted-team Editors, a `git pull`) is never
  silently replaced by the later writer — the editor says "Changed elsewhere" instead. Saves of one
  board are serialized within a core; two CORES on one folder can still interleave between the
  check and the rename. The editor's own "has anything changed" test compares with what IT last
  saved, not with disk. The unmount flush writes a snapshot kept from `onChange` — Excalidraw's api
  is empty by cleanup time, and reading it there once erased a board; (5) the project folder is
  bound by its REAL path — a `.nodeterm` or `.nodeterm/whiteboards` symlink leading out of the
  project is not followed (the board falls back to the app folder); (6) finishing (Esc, a press
  outside) waits for a save that SUCCEEDED — a failed or refused one keeps the editor open with
  "Keep mine" / "Discard my changes" in the header, since after the exit there is no flush left to
  retry — and a hosted-team Viewer opens the board view-only. Excalidraw loads lazily; fonts
  come from `scripts/excalidraw-assets-plugin.ts`; mermaid is aliased to a stub.
- **Run node** (a `terminal` node carrying `data.runConfig`, NOT a new NodeKind;
  `@shared/run-config`, `core/run-service.ts`, `nodes/RunBar.tsx`) — VS Code's "Run Without
  Debugging" for any `.vscode/launch.json` configuration. The toolbar picks a folder (defaults to
  the project's; sibling and `*.worktrees/*` folders with a launch.json or a Flutter pubspec are
  offered), a configuration or compound (stored by NAME, re-read at every run) and, for Flutter, a
  device. **launch.json runs nothing by itself** — each `type` belongs to an extension — so
  `planLaunch` is the table of what each extension would run: dart (flutter run / flutter test /
  dart run / dart test), node/pwa-node/node-terminal, python/debugpy, go, php, coreclr,
  lldb/cppdbg, and chrome/msedge (a browser node). Everything else is REFUSED with a sentence,
  never guessed: debugging itself, `"request": "attach"`, unknown types, PHP "listen for Xdebug",
  and variables that need an editor or extension (`${file}`, `${input:}`, `${command:}` except the
  Python interpreter one, `${config:}`). `preLaunchTask` (+ `dependsOn`, `${defaultBuildTask}`)
  runs shell/process/npm/dart/flutter/typescript/cargo tasks first; a background (watch) task is
  refused. Compounds run their first member in the node and open the rest beside it, started.
  Rules a refactor must keep: (1) **nothing from a repo is ever typed into a shell** — the host
  writes a POSIX launcher (`buildLauncher`, every token single-quoted, owner-only via
  `writeFileAtomic`) and only `sh '<launcher>'` is typed; env and `envFile` values live in that
  file, never in shell history; tested against injection and run for real under `/bin/sh`;
  (2) the launcher records its pid and exit status, and traps INT/TERM with a HANDLER (`trap ':'`,
  never `''`, which children would inherit as "ignore"); **Stop is SIGINT to the launcher's process
  group** (Ctrl+C), SIGTERM if it will not go, and only the launcher + its children when it is not
  a group leader — never a group that could hold the user's shell; (3) a pid is signalled only
  while `ps` says it is still ours (the launcher's path, or flutter for hot reload/restart, which
  are SIGUSR1/SIGUSR2 to `flutter run --pid-file`); (4) Flutter reload on save is a core
  `fs.watch` of `<dir>/lib` that deliberately OUTLIVES the node's view; (5) the terminal is hidden
  by default (`runConfig.showTerminal`, toggled by ⋯ with the extra-args field): collapse's
  `display: none` path via `.term-node:has(.run-bar--compact)` and a node height fitted to the
  rows; a run that ends without our Stop says where to look; (6) **switching folders keeps the app
  when it can** (`canHotSwitch`: a running Flutter run, same device, same flavor, Flutter on both
  sides): the toolbar offers **Switch (keep app)** beside **Rebuild** — type `d` (flutter's own
  detach: the tool exits, the app keeps running), `flutter attach` from the new folder (only the
  flags attach accepts survive, `attachArgs`, MEASURED against `flutter attach --help` — attach has
  no `--flavor`), wait until it prints its key help AFTER its own `▶ flutter attach` line
  (`attachConnected`), then a hot RESTART — never a reload: a freshly attached tool only pushes
  files changed after it connected (MEASURED live, Flutter 3.47 / iOS 27.1 simulator: a reload
  after attaching from the other checkout "Reloaded 0 libraries" and the old code kept running; a
  SIGUSR2 restart swapped it in 2.6 s, same app pid, no rebuild). **On an iOS simulator attach
  needs `--debug-url`**: it finds an already-running app by mDNS, which the simulator barely
  supports ("The Dart VM Service was not discovered after 30 seconds"), and the URL `flutter run`
  printed is its DDS proxy, gone with the detached tool. `simulatorVmServiceUrl` reads the app's
  own "The Dart VM service is listening on …" line from `simctl spawn <udid> log show` (~3 s) and
  takes the newest one whose process is still alive (`parseVmServiceLog`); not found ⇒ the switch
  is refused with Rebuild offered. Some Macs ship no registered `Simulator.app` (`open -a
  Simulator` fails); booting falls back to the active Xcode's copy and otherwise runs headless. Flutter REFUSES a hand-passed `FLUTTER_APP_FLAVOR`, so after an
  attach `appFlavor` is the pubspec default; an app whose `lib/` reads `appFlavor` is refused the
  switch with that reason. Dart `"request": "attach"` configurations run as `flutter attach` too;
  every other attach is still refused. No "bring simulator forward":
  Simulator.app can only be activated as a whole (same-named simulators are told apart by id in
  the dropdown). Add menus: **New view ▸ New run configuration**. Local projects only (disabled
  with `RUN_SSH_HINT` in SSH projects; relay stub answers "managed on the host"); POSIX only
  (refused on Windows). Server Edition: real. Kanban card modal: not yet. Mobile: N/A.
- **simulator** (`SimulatorNode.tsx`, `core/simulator/`, `@shared/simulator`) — a live iOS simulator
  screen on the canvas: click = tap, drag = swipe, wheel = a swipe, typing goes to the device (HID
  keyboard usages from `KeyboardEvent.code`; ⌘-chords stay with nodeterm), Home / Lock buttons, a
  device picker with Boot, and a Cover/Inner screen choice on foldables. DeviceHub (Xcode 27's
  replacement for Simulator.app) cannot be embedded — it exposes only a `devices://` URL scheme and
  macOS has no cross-app window embedding — so the node draws the device itself through
  `nt-simbridge`, a small Swift helper whose SOURCE ships in `simbridge-source.ts` and is compiled on
  first use with `xcrun swiftc` into `<userData>/simulator-bridge/<hash>/` (hash = source + version +
  Xcode build, so an Xcode update recompiles; MEASURED ~3 s). It uses Xcode's PRIVATE simulator
  frameworks (CoreSimulator / SimulatorKit — what DeviceHub uses), resolved at RUNTIME (dlopen /
  NSClassFromString / dlsym) so a moved symbol fails with a sentence, never a link-time crash; the
  Indigo HID message layout follows facebook/idb (MIT). Rules a refactor must keep, all MEASURED on
  Xcode 27: (1) frames are the display's IOSurface, encoded only when its seed changes (0 cost while
  still; ~19–30 fps while moving; first frame ~0.4 s); (2) a device can have SEVERAL main-class
  displays — a foldable ("iPhone Duo") has an inner and a cover screen and only one is lit — so the
  helper shows the lit one and follows a fold (switches when the shown one is still and another just
  changed), with a manual pin; (3) touches go to the SHOWN screen's own digitizer, `0x40000000 |
  screenID` (`screenProperties.screenID`): the generic main-screen target 0x32 reached neither screen
  on the foldable; (4) Home/Lock are HID Consumer usages (Menu 0x40 / Power 0x30) to 0x32 — a Face ID
  device ignores the legacy home-button source — falling back to the legacy source (0x33) when
  refused; (5) the display state objects are ROCK proxies: no key-value coding, message primitives
  through typed `objc_msgSend`. Input from the renderer is re-validated (`normalizeSimulatorInput`)
  before it reaches the helper. A run node with a simulator device shows a 📱 button that opens (or
  focuses) the Simulator node for it. **Desktop only** (iOS devices need macOS; Android ones run
  everywhere): the add rows are disabled with `SIMULATOR_UNAVAILABLE_HINT` in a browser tab and
  with `SIMULATOR_RELAY_HINT` in a relay tab (`simulatorRefusal`, one rule for the menu, the Dock,
  the palette and `addSimulator`), and a Simulator node that reaches a relay tab anyway (it is in
  the host's project file) shows that reason instead of streaming — a relay tab's project is the
  host's, and the devices this renderer can reach are THIS machine's. `simulator:*` is also in
  `HOST_ONLY_CHANNEL_PREFIXES`, so a relay peer is refused host-side. Kanban: not a card. Mobile: N/A.
  **A device takes input from its FIRST HID client only** (MEASURED: a second client's touches are
  dropped without an error). So the host runs ONE helper per device, shared by every node showing
  it (`bridges` keyed by UDID, a late joiner replayed the last displays/ready). That is why the
  Simulator node's OWN Boot is headless (`bootSimulator(id, { openWindow: false })`): a window
  showing the device is a client too, and it took touch input away from the node. A run node's
  Boot (`run:boot-device`) still opens Simulator.app as it always has — a user with no Simulator
  node must still see the device. "Open in DeviceHub" (⋯ menu) says so in its tooltip.
  **The ⋯ menu** (`simulatorMenu.tsx`, pure) is a complete map of DeviceHub's menus, from the
  `…MenuItemProvider` names in Xcode 27's DeviceKit: what nodeterm can do runs — HID buttons
  (Home/Lock/Side/Siri/Volume/Play-Pause) and rotation through the helper; everything else through
  public `simctl` in `core/simulator/simulator-actions.ts` (appearance, text size, Increase
  Contrast, location set/scenario/clear, status-bar overrides, shake and Face/Touch ID via the
  simulator's own `notifyutil` notifications, Open URL, push, privacy, pasteboard sync, install,
  add media, screenshot/recording, restart, erase) — and what it cannot is listed greyed out with
  "(Not Supported)" and the reason (App Switcher: the edge-swipe gesture is not recognised from
  outside DeviceHub; Action Button; Grayscale/Reduce Motion/Reduce Transparency/Liquid Glass: no
  public command; tvOS/watchOS/visionOS controls; device management). Actions are re-validated
  (`normalizeSimulatorAction`) and every argument is its own argv entry. All the simctl actions
  were run live against an iOS 27 simulator; `simctl location list` is a TABLE
  (`parseLocationScenarios` reads the first column).
  **Edge swipes carry the panel edge they start on** (`touchEdge`, `TOUCH_EDGE_MARGIN` 2.5%):
  iOS recognises its system edge gestures — the home swipe up from the bottom — from the Indigo
  contact's edge field, not from where the finger lands. MEASURED (Xcode 27): without the flag a
  swipe up from the very bottom only scrolled the app; 1 top / 2 left / 3 bottom / 4 right name
  PHYSICAL panel edges (an iPad turned left went home with 2, turned right with 4; top inferred), so
  the node computes the edge after mapping the touch to the panel and it holds for the whole
  contact. A swipe down from the top worked without it.
  **Inside a run node.** The screen, toolbar, ⋯ menu and input are one component, `SimulatorView`;
  `SimulatorNode` is a thin box around it (title, close, resize handles, fit-to-screen), and a run
  node mounts the same view under its control rows when `data.runSimulator` is present (persisted,
  `normalizeInlineSimulatorConfig`: the device only — the panel FILLS the node, so resizing the
  node scales the screen, letterboxed; no size of its own is stored). 📱 on every run node toggles that panel
  (the run's device preselected when it is an iOS UDID or an Android emulator's adb serial,
  `SimulatorDevice.serial`; else empty to pick); ⇱ splits it into a Simulator node carrying
  `dockTo: <runNodeId>`, whose ⇲ (or the run node's 📱) docks it back. The inline stream is keyed
  `<runNodeId>.sim`. While it is open the compact (terminal hidden) height fit stands down — the
  node's size is the user's — and the run bar flexes to fill the node; opening grows the node by
  `INLINE_SIM_HEIGHT`, closing hands that back. Inline there is no node of its own to snap to the
  screen's shape, so Actual Size / Fit to Screen are greyed out there (pop out for those).
  **The browser panel** (`@shared/run-preview`) is the same idea for a run whose result is a page:
  there is NO choice — a node runs one thing, so the button shows the panel the run calls for (📱
  or 🌐, `previewKindFor`), and an OPEN panel follows the run (switch the device to Chrome and the
  simulator becomes the browser, and back) — a `chrome`/`msedge` launch configuration,
  a Flutter web device, picked OR named by the configuration itself (`-d chrome` in its args — a
  rule that read only the picker showed 📱 for exactly those runs), or a run with no device, i.e.
  a dev server). `data.runBrowser` (persisted, http(s) only) holds the page: a browser
  configuration's own `url` (its Run/Open now lands in this panel, or in a panel popped out of it,
  instead of a separate browser node), else the URL picked out of the run's own output by
  `localUrlFromOutput` (the newest local http(s) URL on a "served at / Local: / listening on" line;
  DevTools / VM-service lines skipped; `0.0.0.0` opened as `localhost`), polled with `pty.capture`
  only while the panel is open, the run is up and no page is known. A picked-out URL is marked
  `auto` and re-read on the next run (the port may change); one the person navigated to is kept.
  A Flutter `chrome`/`edge` run is EMBEDDED only when the configuration opts in
  (`runConfig.embedBrowser: true`, ⋯ → "Show web inside this node", shown for a Flutter web run;
  `embedsFlutterWeb` is the one rule for host and bar) — an existing configuration keeps Flutter's
  own Chrome window. Opted in, `planLaunch` swaps the device for
  `web-server` (`webServerDevice`, `PlanContext.webServer`) wherever it is named — the pick, `-d` /
  `--device-id` / `-d=` in args or toolArgs, or Dart-Code's `deviceId` field (which used to be
  dropped, not passed as `-d`) — because Chrome would open a window of Flutter's own while the web
  server serves the same app to any browser and prints its URL; Run then opens the browser panel
  by itself. ⇱ pops it into a browser node with `dockTo`; its ⇲
  (`nodeterm:dock-preview`, shared with the Simulator node) or 🌐 docks it back. A run node holds
  one panel at a time. The inline page is not part of the browser-node keep-alive pool, so a
  project switch reloads it.
  **Android virtual devices** use the same node (`core/simulator/android-*.ts`). A device id is
  `avd:<name>` (the AVD name is stable; adb serials are not) in the same persisted `udid` field.
  The picker lists every AVD read from files (`<avdHome>/<name>.ini` → `config.ini`; no
  avdmanager, which needs a JDK), booted ones from the emulator's discovery files
  (`…/avd/running/pid_<pid>.ini`, pid checked: a crash leaves the file). Boot runs
  `emulator -avd <name> -no-window`, headless like iOS, logging to `<userData>/android-emulator/`.
  Everything streams over the emulator's own gRPC interface, spoken with a hand-written protobuf
  codec over `node:http2` (`android-grpc.ts`, no dependency), authenticated with the per-run
  `grpc.token` from the discovery file. MEASURED (emulator 36.6.11): PNG frames fitted into a
  SQUARE box (one box serves both orientations; width alone is ignored) run ~25 fps while moving
  and send nothing while still; keys need the full USB usage (`0x70000 | usage`, a bare usage
  types nothing); Home/Back/Recents/Power are W3C key names (`GoHome`, `GoBack`, `AppSwitch`,
  `Power`); rotation is `setPhysicalModel` ROTATION z (90 = turned left) and frames then arrive
  ALREADY TURNED while touches stay in PORTRAIT panel pixels — so the node does not turn an Android
  picture (`picturePreRotated`) but maps touches with the same `displayToFramebuffer`. A rotation
  of a portrait-locked app changes no guest pixels, so the stream sends nothing; the session takes
  a `getScreenshot` after each rotation. Input is queued and sent one call at a time (drag points
  coalesced) so it reaches the emulator in order. ⌘V sets the device clipboard (`setClipboard`)
  and presses Ctrl+V. Menu actions use gRPC where it exists (battery, GPS, clipboard, fingerprint,
  restart, shutdown, screenshots) and `adb -s emulator-<port>` otherwise (night mode, font scale,
  demo-mode status bar, URLs, APK installs, media) — every `adb shell` argument single-quoted for
  the DEVICE's shell. Not yet: screen recording, wipe data, foldables, the run node's 📱 for an
  Android emulator. The node is offered in the desktop app on every OS (iOS devices are simply
  absent off macOS); the Server Edition and relay tabs still refuse it. Install / Add Media accept a
  POSIX or a Windows drive path (`C:\…`, `C:/…`; UNC refused), since the emulator runs on Windows too.
  The emulator's discovery file is trusted only when every directory from the temp/runtime/home
  base down and the file itself are ours (uid, no symlink, file opened `O_NOFOLLOW`), and a pid we
  may not signal (EPERM) is another user's, not our emulator — `/tmp/android-<user>` can be created
  by anyone first, and a planted `grpc.port` would receive every key typed into the device.
- **dino** (`DinoNode.tsx`) — a small self-contained T-Rex-style runner on a canvas (no PTY);
  high score persists via `data.highScore`.
- **trigger** (`TriggerNode.tsx`) — a canvas-owned schedule (cron / interval / once) that
  delivers a payload into a connected terminal/agent node when due (issue #493 — the inverse of
  the ephemeral loop/cron cards, which visualize AGENT-initiated recurrence). The card shows the
  schedule + next-run countdown, the target (a derived, never-persisted edge — the
  pending-launch dep edge is NO longer one: since the 2026-09-02 edge model it is a persisted rope,
  `ctrl-after-<dep>-<node>`, whose dashed ⏳ LOOK is what is derived), the payload, an honest
  ARMED/DISARMED/CHANGED/SET-UP chip with the
  "definitions travel with the repo, consent never does" narrative, Run-now, and the last runs
  (fired / delivered-late / queued / missed / failed / expired). Arming passes a ConfirmDialog
  showing the exact schedule+payload+target being consented to; all decisions are the pure,
  tested `lib/triggerCard.ts`, all state is host-side over `window.nodeTerminal.triggers`
  (arm/disarm/status/runNow — `startTriggerService` registers the handlers in BOTH shells;
  `runNow` deliberately takes no spec: a caller chooses WHEN, never WHAT). The relay stub
  refuses and the card says triggers are managed on the host. Mobile: N/A (no canvas).
- **subagent** / **loop** (`SubagentNode.tsx` / `LoopNode.tsx`) — render-only, hook-driven viz
  nodes, **never persisted**. `subagent` visualizes a subagent the Claude session spawned (type +
  task + live timer, expand for its live transcript — subagents have no PTY); `loop` shows a
  loop/schedule/cron kind + task + per-iteration summaries, Play re-issues the task into the parent
  terminal's tmux session.
- **chat** — **REMOVED 2026-07.** The SDK-driven Claude chat node (`ChatNode.tsx`, `main/chat-driver.ts`,
  the `@anthropic-ai/claude-agent-sdk` dependency, and the whole chat-events/chatSessions stack) is
  gone — dropping the bundled SDK also removed a ~240 MB native binary per platform. A persisted `chat`
  node is migrated by `nodeStatesToFlow` into a **sticky tombstone** in place, carrying a
  `claude --resume <chatSessionId>` hint so the conversation continues in any terminal (a chat was an
  ordinary resumable Claude session). `CHAT_CAPABLE` / `canChat` survive but now gate **only** the
  ⌘M **ChatPanel** transcript view on a Claude *terminal* node (see the terminal bullet's Cmd/Ctrl+M),
  not any SDK chat node.

Monaco is wired in `renderer/editor/monaco-setup.ts` (language workers bundled via Vite
`?worker` — no CDN; CSP `worker-src` allows them). Markdown rendering is shared in
`renderer/lib/markdown.ts` (`marked` + DOMPurify sanitize). Terminal OUTPUT (the ⌘M output view)
goes through `renderer/lib/terminalOutputMarkdown.ts` instead: a private `Marked` instance with
`breaks` on (output is line-oriented — without it `ls -l` joined into one paragraph) that renders
raw-HTML tokens as escaped TEXT (a program's `<stdin>` is not markup; parsed as HTML, DOMPurify
stripped it) and trims capture-pane's trailing padding. The escape is on the `html` token, never a
global pre-escape of `<`, which would double-escape code spans/fences.

**The TS/JS worker is reaped, not idled** (`renderer/editor/tsWorkerReaper.ts`). Monaco 0.57 stops
the css/html/json workers after 2 min idle but never the TypeScript one (separate TS and JS
managers can pin two compiler isolates; their size has not been measured here). monaco-setup stops
it with a no-op `setCompilerOptions` on `monaco.typescript.*Defaults` (`onDidChange` →
`_stopWorker`; the next request restarts it lazily) 2 min after the last TS/JS model is disposed or
changes language. This only works if every node **disposes its models on unmount**: one leaked
`.ts` model pins the worker for the session.

**The rendered-Markdown font is a setting** (`markdownFontFamily` / `markdownFontSize`, Settings →
Appearance; `@shared/markdown-font`). App.tsx publishes it as `--md-font-family` / `--md-font-size`
on <html>, plus `--md-code-font-family` = the TERMINAL font family; styles.css keeps the defaults on
`:root`. Every rule that sizes rendered Markdown reads the tokens — `.term-md__content` (⌘M output
view, editor preview, the kanban file preview), `.term-chat__msg` and the ⌘M composer input —
headings are `em`, and code is `0.92em` of the body (relative, so it stays in proportion).
`styles.markdown-font.test.ts` pins this. Sticky notes keep their own font on purpose.

**A link in rendered markdown must never navigate the app window.** DOMPurify keeps an anchor's
href as written, and agents write relative links constantly (`[pty-manager.ts](src/core/pty-manager.ts:4100)`).
A click resolved it against the app document: on the desktop another `file://` path, which the old
`will-navigate` guard ALLOWED ("any `file://` is ours"), so the main window navigated to a file that
does not exist and the whole canvas was gone until a reload; in the Server Edition any `<a href>`
click, relative or http(s), navigated the app's own tab away. Two layers now:
- **Renderer, every surface** — ONE delegated, document-level click listener installed at boot
  (`renderer/lib/markdownLinks.ts`, from `boot.tsx`), scoped by `RENDERED_MARKDOWN_CONTAINERS`
  (`.term-md__content` — terminal ⌘M view + editor Preview, `.term-chat__text` — ChatPanel,
  `.sticky-node__md` — sticky notes on canvas AND in the kanban card modal). http/https/mailto →
  `shell.openExternal` (system browser / a new browser tab); `#fragment` and empty href → swallowed;
  anything else → swallowed + an error toast (`nodeterm:toast` — the only kind Canvas renders).
  Local links deliberately do NOT open a file: resolving one needs the owning node's cwd AND its
  filesystem dialect (session source, core platform, SSH/relay — TerminalNode's `pathConvention`),
  which a document-level handler cannot see; a wrong guess opens the wrong file on the wrong machine.
  **A new markdown surface must render inside a listed container** — `markdownLinks.test.ts` fails
  on a component that pipes `renderMarkdown` into `dangerouslySetInnerHTML` outside the list, and on
  a listed class nothing renders any more.
- **Main, desktop backstop** — `decideMainFrameNavigation` (`main/navigation-guard.ts`) allows a
  main-frame navigation ONLY to the entry document itself (scheme + host + decoded pathname; hash
  and query ignored, so reload and dev HMR work); a safe external scheme goes to the OS; everything
  else — any other `file://` path, any other dev-server path — is blocked.

### Browser control geometry (#539)

`browser-actions.ts` waits for quiet layout metrics after wheel input and before resolving
click/type targets; the CDP acknowledgement itself is not a rendered frame. Polling has an
initial grace period, a quiet window and a bounded sample count. A continuously moving page
returns a refusal instead of a misleading movement report.

`driveBrowser` permits only one active action per guest session so a click cannot overtake a
scroll's settlement. Revocation during a polling delay aborts without reattaching the debugger.

**`--screenshot --full true` renders the page as ONE viewport** (`browser-screenshot.ts`
`captureFullPage`). `captureBeyondViewport` alone paints off-viewport layers without re-laying the
page out: MEASURED on Electron 42.9.1 against a page scrolled 400px, the sticky header came out at
y=400 and the fixed footer mid-image — the reported "header twice / overlapping" shot. The capture
now sends `Emulation.setDeviceMetricsOverride` (width unchanged, height = content height, capped at
`MAX_VIEWPORT_OVERRIDE` 16384 and said so), settles, captures, clears in `finally`, and puts the
scroll back with one wheel (an override that tall clamps scroll to 0 and clearing does not restore
it — measured); a position it could not restore is in the reply. Rules a refactor must keep:
- **The allowlist admits exactly that shape** — the four keys, bounded integers,
  `deviceScaleFactor: 0`, `mobile: false`, plus a parameterless clear; every other Emulation method
  stays default-denied. No agent value reaches it; a caller-sized viewport (a resize verb, #539's
  feature ask) is a separate decision with its own validator.
- **The override survives `debugger.detach()` and a reload** (measured), so its lifecycle is the
  LEASE's: `BrowserSession.metricsOverridden` goes up when the set is sent and down only on a
  confirmed clear; every detach we make sends the clear first (measured to take effect when sent
  immediately before `detach()`), and after a detach we did not make the FIRST command of the next
  attach is the clear. The screenshot never reattaches a released lease to clear or restore.
- Side effect, stated in the agent text: the page sees one resize, so `100vh` content renders
  taller (one bounded re-measure follows growth).
- Residual, stated: a detach we did not make (not our release/idle/revoke, not page teardown) in
  the sub-second capture window leaves the page tall until the node is next driven. No path we
  know triggers one today (DevTools does not detach the lease — see browser-lease.ts's probe note).
The disposable probe `scripts/probes/browser-539.ts` asserts all of it on a real Electron
(header once at the top, footer once at the bottom, scroll restored, release clears).

`browser` and `open-browser` reject unknown flags through ONE gate, `browserFlagRefusal`
(`core/canvas-control-core.ts`): the Server Edition runs it inside `parseControlRequest`, and desktop
main calls it directly, because that handler never runs the parser (the `--issue` trap — #918's first
version only reached the Server Edition). This does not add resize, console, network or
attribute-reading actions. Server Edition retains its explicit
browser-control refusal; its supported `open-browser` route shares flag validation. Mobile has
no new wire fields or UI; host-side Desktop control inherits the fix.

### Webview keep-alive across project switches (browser/web nodes)

Issue #301: a project switch used to reload every browser node's page — SPA state, forms, scroll,
websockets gone — because the load effect swaps the whole React Flow node array and an Electron
`<webview>`'s guest process dies on DOM detach (a webview cannot be parked like xterm). The fix
keeps the ELEMENT mounted instead of trying to preserve anything through a remount. The facts it
rests on are measured (Electron 42.x probes + in-app verification, 2026-08-26):

- A guest **survives** sibling insert/remove around its element (React reconciliation of kept,
  order-stable keyed children never touches them), and **survives `display:none`** of itself or an
  ancestor — state intact, viewport size and scroll kept (the guest is NOT resized to 0), repaint
  pixel-identical on reveal, timers running throttled like a background tab.
- A guest **dies** on any DOM *move* (`insertBefore`/`appendChild` of an attached element detaches
  first), taking a full page reload with it. React moves a kept child exactly when its RELATIVE
  ORDER among kept children changes (`lastPlacedIndex`), and React Flow renders nodes in
  prop-array order keyed by id (`adoptUserNodes` rebuilds `nodeLookup` in array order) — so the
  merged prop's order discipline IS the feature.

Mechanics (`renderer/lib/webviewKeepAlive.ts` pure + tested, `state/webviewKeepAlive.ts` store,
merged in Canvas exactly like the ephemeral subagent cards — Canvas state, persistence, undo and
the wire never see any of it):

- Every webview-hosting node (`browser`/`web`) renders in ONE stable **pool region** at the tail
  of the `<ReactFlow>` nodes prop, ordered by the pool's entries; entry order never changes while
  an entry lives (append/remove only — `webviewKeepAlive.test.ts` pins the order-stability
  invariant, `webview-keepalive-reconcile.test.tsx` pins the no-detach consequence against real
  React). Visible cost of the hoist: an unselected browser/web node paints above other unselected
  z-0 nodes it overlaps (selection's z 1000 still wins).
- On switch-away the outgoing project's pages become **ghosts**: same node id, `display:none`,
  non-interactive, parked at the origin, `data.ghost` telling the surfaces to route facts at the
  pool (`updateGhostData`) instead of `updateNodeData`. On return the SAME element goes live
  again; `overlayKeepAliveData` folds ghost-time navigations into the loaded nodes inside the one
  `setNodes`, so the `url` prop never moves under the surviving surface (which would navigate it).
- **The merge is keyed on the MOUNTED project (`keepAliveFromRef`), never `activeProjectId`, and a
  mounted entry whose node is missing falls back to its ghost.** Both exist because the pool store
  (zustand/useSyncExternalStore), the ref and `setNodes` do not land in one commit: a switch renders
  interleavings where the id would otherwise drop out of the merged list for one commit — and one
  absent commit is an unmount, i.e. a dead guest ([MEASURED]: the ghost→live direction remounted
  every returning page until the fallback; live→ghost never did). A genuinely deleted node's entry
  is dropped at the deletion funnels (handleNodesChange's `remove`, `deleteNodes`, the peer-mutation
  remove, project deletion/prune), with the next retire as backstop — never by the merge.
- **The minimap must exclude ghosts from BOTH its node list and its bounds lookup** (#850/#786).
  React Flow's MiniMap ignores CSS `display:none`; setting `hidden` on the real node instead
  unmounts the guest. `canvas/VisibleMiniMap.tsx` projects the live flow store into a provider
  scoped to the map, preserving internal absolute positions, measured sizes and the original
  panZoom instance. Only the map's node collections are filtered; persistence and pool lifecycle
  are untouched. The real MiniMap regression tests cover ghost/live transitions, empty bounds,
  removals, grouped geometry and camera interaction. When upgrading React Flow, keep those
  tests: the projection deliberately mirrors the state fields consumed by MiniMap.
  **A pan/zoom frame takes a transform-only fast path**: when `transform` changed and the node
  collections did not, only the camera fields are copied and a full re-projection follows
  `MINIMAP_FULL_SYNC_DEBOUNCE_MS` after the move settles (rebuilding them per frame re-rendered
  every rectangle; measured 402 forced layouts per 20 s pan vs 1 with the map hidden). Identity
  checks alone cannot replace the full path: xyflow's `updateNodeInternals` mutates `nodeLookup`
  IN PLACE and then calls `set({})`, so any update that leaves `transform` alone syncs fully.
- **Memory bounds** (same posture as park/WebGL: a lever must not end live work): a ghost is
  hidden, so the existing Browser Memory Saver discards its guest after `BROWSER_DISCARD_MS`
  unless loading/audible/agent-driven — `onGuestDiscarded` then drops the entry (a husk would hold
  a cap slot). `BACKGROUND_WEBVIEW_MAX` (8) hard-caps live background guests, evicting
  longest-retired first; `activateProject` runs BEFORE `retireProject` on every switch so a
  returning page sheds its background clock before that eviction can pick it.
- E2E-verified under Xvfb (CDP): same webContents across Alpha→Beta→Alpha, typed form text + JS
  state + tick counter continuous, zero reloads; wrapper + webview DOM elements identity-stable in
  both directions. Server Edition: inert (no `<webview>` in a plain browser — ghosts are empty
  husks, nothing to preserve). Mobile: N/A (no canvas).

## Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / custom)

**Full reference: [`docs/reference/agent-support.md`](docs/reference/agent-support.md)** — the measurements, incidents and
per-feature rules behind everything below. **Read the matching part of it before changing agent
status, hooks, messaging, canvas control, context links, chat views, accounts, usage or permission
modes.** Per-agent write-ups: `docs/grok-agent.md`, `docs/gemini-agent.md`, `docs/copilot-agent.md`,
`docs/antigravity-agent.md`; codex's approval mapping lives in `src/shared/agents/approval-mode.ts`.
A rule that changes here or there changes in both places.

**The model.** Claude Code is one builtin of several. Per-agent behaviour comes from a registry
(`AGENT_CONFIG`, `src/shared/agents/config.ts`, open `AgentId`) and **capability membership lists**
(`AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`, `SUBAGENT_CAPABLE`, `USAGE_CAPABLE`, `CHAT_CAPABLE`,
`CLAUDE_TRANSCRIPT_READABLE`, `TITLE_READ_CAPABLE` ⊇ `RENAME_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
`CONTEXT_LINK_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `MODEL_SWITCH_CAPABLE`, `SESSION_END_CAPABLE`, …)
with helpers (`hasHooks`, `canChat`, …). Never fork at a call site with `=== 'claude'`. Custom
agents inherit their `baseAgent` through `capabilityAgentId`. State comes from each agent's own
**hooks**, normalized (`src/shared/agents/normalize.ts`) into `working | waiting | blocked | done`
plus annotations (`errored`, `interrupted`, …), and lives in the transient `state/agentStatus.ts`
store (a relay session gets its own keyless store; `applyAgentEvent` is the one reducer).

**Rules that cost real incidents — do not undo:**
- **Joining a capability list switches on EVERY consumer of it.** Grep every consumer before adding
  an id (joining `USAGE_CAPABLE` once handed codex nodes a stranger's claude transcript). Split a
  list when two consumers need different answers (`CHAT_CAPABLE` vs `CLAUDE_TRANSCRIPT_READABLE`).
- **Both shells' raw hook listeners stay in parity** (`src/main/index.ts`,
  `src/server/agent-status.ts`); `hook-verified-parity.test.ts` pins it. Shared logic goes in
  `src/core` with one definition, never one copy per shell.
- **Unknown is never "done" / "satisfied" / "absent".** A failed read is not evidence of absence;
  a tri-state (`present | absent | unknown`) is used wherever a wrong "absent" destroys work
  (transcript presence, remote session index, owner probes).
- **A remote (SSH) node is read on its HOST or not at all** — never fall through to this
  machine's resolvers (claude's cwd fallback would adopt a stranger's session).
- **Credentials never ride argv**, local or SSH (`curl --config -`, 0600 files, stdin).
- **Hook-identity:** per-node tokens (`docs/node-identity.md`); a verified-only gate never 403s a
  missing token on `/hook/*`; only the pane's foreground claude speaks for a node
  (`claude-pane-origin.ts`).
- **Agent-integration consent (#744):** `core/agent-integrations.ts` is the one writer of user
  agent config; nothing installs hooks/skills for an agent that is not `enabled`
  (`docs/agent-integration-consent.md`).
- **Hook installers** merge into the user's files and match only our own entries
  (`normalizeHookCommand` on both sides; codex trust tables matched by DECODED key, never
  duplicated). Windows agents other than claude go through a `<agent>-hook.cmd` wrapper.
- **Permission mode:** `withPermissionMode` is the single funnel; per-agent mapping in
  `approval-mode.ts`; a mode the CLI cannot express emits NO flag; claude's `auto` version gate is
  claude's alone; codex's vocabulary is probed (`core/codex-cli.ts`), baseline when unknown.
  Mode values are re-validated at the interpolation site.
- **`--after` / success waits / hand-over holds:** unknown state never releases a dependent; an
  errored or interrupted turn does not; a station handed new work does not until a later turn ends.
- **Canvas control:** no verb ever activates a project tab (`src/shared/control-off-screen.ts`,
  `control-verb-disposition.test.ts`); agent-facing help is generated from code
  (`buildCanvasSkillBody`) and must change in the same PR as the behaviour; destructive confirms
  are scoped waivers, `settings` is never waivable.
- **Never type into a pane a prompt the agent would misread:** messages/notes go only to an idle
  agent at an empty prompt; never Enter into a dialog (`waiting`/`blocked`); a chat send is gated
  by `canSendFromChat` / `agentProcessInPane`.
- **Managed accounts:** isolation is the config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); the app
  never writes credentials; `boundAccountId` is the one binding rule; account env names ride
  tmux `update-environment` on the LOCAL conf only.
- **Usage indicator** describes the active project's machine only; remote reads keep the token on
  the host; a failed read keeps last good numbers; never polled remotely.

**Adding a new agent or model:** follow the checklist at the end of `docs/reference/agent-support.md`
("Adding a new agent (or a new model)") — measure the CLI rather than assuming claude's shape,
prefer the agent's own stated numbers, use closed sets for event types, degrade to nothing rather
than to something wrong, and write the device checklist for what you could not run.

## Open recent (resume a past agent conversation from its history)

Past conversations live in each CLI's own history, and nodeterm used to resume only what a node
remembered. "Open recent" lists them — the start screen's **Recent conversations** (grouped by the
folder each ran in) and a **Recent conversations** section of ⌘K — and one click resumes one.
Reader: `core/recent-conversations.ts` (`recent-conversations:list`, registered by BOTH shells);
plan: the pure `renderer/lib/recentConversations.ts`; execution: Canvas `resumeRecentConversation`.

- **Which agents, and why only those** (`RECENT_CONVERSATION_AGENTS`, `@shared/recent-conversations`):
  claude (system root + every LOCAL settled managed and linked account — `claudeAccountsSnapshot`),
  codex (system `CODEX_HOME` + the managed homes whose ids the renderer sends; core re-validates
  each through `codexHomeForAccount`, which throws outside the id alphabet), gemini, grok, copilot.
  Each is in `RESUMABLE_AGENTS` AND has a measured on-disk shape. **opencode is out**: its history is
  a SQLite database we never open, and the only reader is `opencode export` (one spawn, ~1.5 s,
  ~320 MB per session). **antigravity is out**: its record shapes were never captured. An agent
  outside the list contributes no rows — nothing guesses at a layout.
- **Measured shapes the reader depends on** (dev host, 2026-09-30): codex `session_meta` carries
  `id`, `cwd` and `thread_source` — a spawned child says `"subagent"` with a `source: {subagent:…}`
  object (4 of 62 rollouts here) and is SKIPPED, a user's own thread says `"user"`; that first line
  also carries the whole base instructions (tens of KB), which is why the head read is 512 KB.
  gemini's project dir holds `.project_root` = the absolute cwd, and its header says `kind: "main"`;
  a session holding only harness `<session_context>` (no prompt, no title) is not a conversation
  and is skipped (all 3 gemini sessions on this host). grok's session group is the URL-encoded cwd;
  a group that does not re-encode to its own name (grok's slug+hash form for a long cwd) keeps a
  null cwd rather than a guessed one. copilot's `session.start` names `context.cwd`, and its
  `sessionId` must equal the directory it sits in.
- **Bounded**: per root only the newest `PER_ROOT` (25) files by mtime are OPENED; every other
  file costs a stat, and stats run in parallel capped at `STAT_CONCURRENCY` (32) — the first version
  awaited them one by one, which review measured at 2.8–4.0 s warm for 10,000 transcripts on every
  ⌘K. Codex walks its dated tree newest-first and stats at most 100. Each open is a 512 KB head plus,
  for a claude/gemini title, a 128 KB tail; the parse is cached by (path, size, mtime), and the whole
  answer is REUSED for `RESULT_REUSE_MS` (10 s, keyed by the exact roots + limit, concurrent callers
  share one read). Measured (fixture trees, this host): 300 files 45 ms cold / 17 ms warm, 3,000 →
  209 / 356 ms, 10,000 → 630 / 617 ms; the real dev-host history (313 claude transcripts, 62 codex
  rollouts) 227 ms cold, 20 ms cached, 46 rows. Read on demand only — once per start-screen
  appearance and per palette open, never a timer. (`core/transcript-index.ts` was not reused: it is
  claude-only and carries no account per entry.)
- **Title = display text, never a command.** The agent's own session name where it has one (claude
  `custom-title`/`ai-title` via `pickSessionName`, gemini `update_topic` via `pickGeminiTitle`, grok
  `summary.json`), else the first thing the user typed (the agent's own chat parser; a `<…>` harness
  wrapper is not a prompt). Every title goes through `untrustedLine` (no control, bidi or zero-width
  characters, one line, capped at 120). Every file the reader opens is `lstat`ed first and must be a
  regular file — transcripts, gemini's `.project_root` and grok's `summary.json` alike — so a symlink
  planted in a history dir is never followed. Only the SESSION ID reaches a pane, re-validated
  three times: `SAFE_SESSION_ID` at read, `canResumeWith` in the plan, and `createAgentNode`, which
  THROWS on an id the resume grammar refuses rather than silently starting a fresh conversation.
- **The resume funnel is the factory's own**: `createAgentNode`'s trailing `resumeSessionId` builds
  the line with `assembleResumeCommand` — the assembler cold restore uses, so a launch override,
  custom args, codex's launcher, `withPermissionMode` and the gateway model all apply — mints no id,
  and persists the RESUMED id as `agentSessionId`. The ⌘K transcript-search hit now uses the same
  path; before, it replaced the command by hand and kept a freshly minted id the node never ran, so
  its cold restore after a reboot resumed nothing — and it passed no account, so a hit from a
  managed/linked root resumed under the system login. `TranscriptHit.accountId` (from the index root
  that holds the file) now travels with it, refused if that account is gone or not local.
- **The account is the one that holds the history**, never the project default: a conversation in a
  managed account's config dir resumed under the system login answers "No conversation found".
  `boundAccountId` still decides binding; the plan REFUSES when that account is gone, pending or
  host-pinned (`RESUME_REFUSALS.accountGone`). A codex rollout HARDLINKED into a second home by
  "Switch Codex account" is one inode seen twice with the same mtime: `mergeRecent` credits the tie
  to the MANAGED account's copy. That is usually the account it was switched TO; a switch back to
  the system login is credited wrongly, which costs nothing — both homes hold the same file, so the
  resume finds it under either.
- **Where it resumes** (`planResume`):
  - A node already holding the session is FOCUSED — two CLIs on one transcript interleave it. A node
    holds exactly ONE session: its live hook id, ELSE its persisted `agentSessionId` — never both.
    `agentSessionId` is the launch-minted id and nothing rewrites it from hooks, so after `/clear`
    (live B) the node no longer holds A, and A must stay resumable (`closedHistory` uses the same
    `live || persisted`).
  - A folder that no longer exists (`cwdState: 'absent'`, a definite ENOENT/ENOTDIR from core — a
    failed stat is `unknown` and proceeds) is REFUSED: opening it would RECREATE it (the store
    mkdirs `<cwd>/.nodeterm`), and a removed worktree is the common case; a later
    `git worktree add` at that path would then fail.
  - Else the MOST SPECIFIC local owner of the folder: a worktree-bound group frame whose
    `worktree.path` is the folder or an ancestor (the node opens inside that frame), or the local
    project whose cwd is the folder or an ANCESTOR — segment-wise (`containsDir`), longest wins,
    then active > open > closed (reopened). A conversation in `/repo/packages/app` resumes in the
    `/repo` project; it does not mint a second project with a `project.json` inside the repository.
    The node's cwd is always the conversation's own folder (the CLI keys the transcript by it).
  - **Never an SSH project or a relay tab**: this is this machine's history, and those cwds are on
    another machine. `openFolderProject`/`openOrAdoptFolder` now skip relay tabs too — a relay tab
    carries the HOST's cwd, and the same path on two machines used to switch to it and do nothing.
  - No owner → "Open folder & resume" through `openOrAdoptFolder` (the same probe/adopt rules as
    "Open folder…"); the ⌘K row says "Open folder & resume: …", never a bare "Resume". A resume into
  another project lands via `pendingResumeRef`, consumed by the project-load effect beside
  `pendingFocusRef`, and RE-PLANS at creation (a node may have taken the session meanwhile).
  Refused rows stay on the start screen, disabled with the reason; the palette omits them (no
  disabled state there).
- **Surfaces.** Desktop: this machine's history. **Server Edition**: its own host's history — the
  machine the browser's sessions run on (real ws-bridge leg). **SSH projects: local history only in
  v1** — a remote host's transcripts would need a remote leg over the ControlMaster, and a local
  conversation is never resumed into an SSH project. **Relay tabs**: the list stays LOCAL (relay-api
  spreads `...local`), and `recent-conversations:list` is `HOST_ONLY` so a peer can never list the
  host's history (titles are prompts the host's user typed, in every project). **Mobile**: follow-up
  in nodeterm-ios — "open recent" on the phone needs this list over the relay dialect.

## Session memory (the RAM pill + the per-session panel)

A bottom-left **RAM pill** (`components/SystemResourcePill.tsx`) beside the usage pill, and the
**session-memory panel** it opens (`components/SessionMemoryPanel.tsx`): used/total RAM of the
machine the **active project** runs on, and every `nt-*` tmux session on that machine sorted by the
memory its whole process TREE holds, each row travelable (`goToNode`) and killable. Scope is
`usageScopeKey` — the same helper the usage indicator uses, so the two pills can never disagree
about which machine they describe. Reading + parsing is `core/session-memory.ts` (this machine) and
`core/session-memory-remote.ts` (an SSH project's host), served over one RPC by
`core/session-memory-service.ts`, which BOTH shells boot. Full write-up + the device checklist:
**`docs/session-memory.md`**.

- **The memory is the agent CLI's own V8 heap — nodeterm does not allocate it, and it is not a
  leak.** Measured on the production host that prompted this (64 GB, 95 live `claude` processes): a
  `claude` process alone averages **335 MB** and peaked at **1159 MB**; 95 of them held **31.1 GB**;
  MCP children add 30–200 MB per session (playwright-mcp + Chrome ≈ 200 MB alone), so one "Claude
  terminal" tree is **440 MB – 1.2 GB**. `RssAnon` is essentially all of the RSS (1165 MB of 1187 MB
  on the largest process) and the repo sets no `NODE_OPTIONS`, so V8 sizes its heap off system RAM
  (`heap_size_limit` 4144 MB there). It is flat with process age — 0–24 h avg **340 MB** vs 7 day+
  avg **326 MB** — so each process takes a baseline and never returns it. **Write those numbers down
  rather than re-deriving them.** The user's number was right and their attribution was wrong; what
  the product was missing was not the allocation but the **blindness** — nothing told them 18
  sessions were live, that one was 1.2 GB, or that six belonged to a project they closed weeks ago.
- **The reaper is deliberately unchanged.** `core/session-budget.ts` reaps only **detached** sessions
  past a grace window, so on that host its kill list was **EMPTY** — 60 `nt-` sessions, 50 attached,
  0 eligible — while 31 GB sat there. An open canvas is attached, and attached is untouchable.
  Retargeting it is a separate change with separate risk; this feature adds **sight**, not policy.
- **`ok:false` is not `ok:true` with no rows** — the rule the whole feature exists to honour, and
  every layer preserves it. A sweep fails (no tmux, unreadable process table, **no socket answered**,
  a missing or out-of-order marker in the SSH reply, a rejected call) ⇒ `ok:false` and no rows; the
  panel then says "Could not measure sessions on this machine", and the grand total and the "*n*
  sessions" count are gated on a `measured` flag so a failure can never render as `0 B / 0 sessions`.
  "We looked and there is nothing" is its own sentence. A socket with **no tmux server** is an
  ANSWER, not a failure (`isNoServerError`), and that classifier is **anchored to tmux's own connect
  message**: `promisify(execFile)` folds stderr into `err.message`, and a bare `no such file or
  directory` also matches a tmux client missing a shared library (exit 127 on *every* socket) and a
  dead ssh ControlMaster — laundering either into "no sessions here" prints an empty panel over 20
  live ones. **The SSH leg applies the SAME classifier to the same rule**: each socket is fenced in
  the reply with its tmux exit status and its stderr (`##SOCK <name>` … `##SOCKRC <n>`, `2>&1`), and
  zero answers ⇒ `ok:false`. Its first form threw both away (`{ tmux …; tmux …; } || true`), so a
  host whose tmux client could not start emitted a stream byte-identical to an idle host's and the
  panel reported thirty live sessions as "No sessions are running here.". Do not "simplify" the
  fence back out — and do not replace the classifier with a blunt "any error ⇒ ok:false" either: on
  a host with no tmux server at all EVERY socket fails, and there "there are no sessions" is the
  honest answer.
- **On Windows the session host's own cost is a separate, measured line** (`SessionMemoryReport.host`,
  `hostOverhead`): the host process plus its non-shell children (ConPTY's conhost/OpenConsole is the
  host's child, the shell's sibling, so no row reaches it). Never folded into a session row, never a
  fake `0` — an unknown host pid or an undescribed session (whose shell would be misbooked) means no
  line. Windows pane probes run through ONE long-lived PowerShell per process
  (`session-host/windows-probe-worker.ts`, one-shot fallback), and the table read is coalesced in
  flight but **never time-cached**: the exit poll's two-consecutive-readings rule must see two real
  observations. Details + device checklist: docs/windows-session-host.md.
- **`readMemInfo` has exactly one home** (`core/session-memory.ts`); `session-budget.ts` imports and
  re-exports it. The reaper's watermark and the pill must never disagree about how much RAM is free,
  and a second copy is exactly the drift this file warns about elsewhere. `null` = could not read,
  never zero.
- **The pill's swap figure and kernel-pressure tint live in `MemInfo.display`, and nothing but the
  pill reads it.** darwin: `sysctl vm.swapusage` and
  `kern.memorystatus_vm_pressure_level` (1/2/4 → normal/warn/critical), both in ONE
  `/usr/sbin/sysctl` run inside `darwinMemInfo`, each field optional on its own; Linux: copied from the same `/proc/meminfo` text. **Never fill
  `swapTotalMb`/`swapFreeMb` on darwin** — `hostUnderMemoryPressure` reads them, and a Mac can keep
  most of its swap in use for hours (the measured one: 7.7 of 9 GB, its kernel level moving between
  normal and warn), so the reaper's swap term would fire all day. The level only RAISES the used-% tint, never lowers it;
  a failed read omits its field (no "0 GB swap"). Not an input to the reaper, the pressure monitor
  or any lever — that is a separate, measured change.
- **"nodeterm itself" is a separate group, never a session row and never in the header total**
  (`SessionMemoryReport.app`). The GPU helper's footprint was 1557-1845 MB while
  `ps` rss said 96-153 MB, and no surface attributed it. The desktop shell injects
  `appProcesses` from `app.getAppMetrics()` for **pid, type and `cumulativeCPUUsage` only**: on
  macOS `memory.workingSetSize` is resident size (blind to IOSurfaces, like rss) and
  `privateBytes` is Windows-only, so memory comes from the sweep's OWN table — `top`'s footprint
  on darwin (`ProcEntry.footprint`; a pid `top` missed is "not measured", never its rss), VmRSS on
  Linux, working set on Windows. No second `top` (~0.5 s each). CPU is lifetime CPU TIME, not a
  rate: `percentCPUUsage` answers 0 on its first call. Local scope only; absent = not available
  (Server Edition, SSH, relay); `ok:false` = tried and could not, rendered as such. Measured on
  macOS only: the Linux (VmRSS) and Windows (working set) legs have unit tests but have not been
  checked against a real machine.
- **The local reader reads `/proc/<pid>/status`, never `statm`.** `status` carries `PPid` and `VmRSS`
  in one file, already in kB; `statm` reports RSS in **pages**, forcing a page-size assumption — a
  hard-coded 4096 under-reports **4×** on a 16 KiB-page arm64 kernel and **16×** on the 64 KiB-page
  enterprise arm64 builds (40 MB printed for a 640 MB session). **Do not optimise this back to
  `statm`.** Non-Linux falls through to one `ps -eo pid,ppid,rss` call, through the same injectable
  seam as tmux.
- **`childCount` counts ALL descendants**, the agent CLI included: `pane_pid` is the pane's SHELL, so
  a claude session with two MCP servers reports **3**. The UI therefore says "**child processes**",
  never "MCP" — a plain `npm run dev` has children too.
- **The cadence split follows the cost.** A **local** scope polls the pill's number every 30 s
  (`HOST_POLL_MS`, one file read, free). An **SSH** scope is **never polled**: one read on scope
  entry, one when that project's ControlMaster comes up (an SSH project is opened before its master
  is ready, and with no timer behind it a first read against a dead master leaves the pill blank),
  and one per panel open / `⟳`. Same rule this file already sets for **Remote usage**, for the same
  reason: every remote read is an ssh exec plus a `ps` of somebody else's whole process table. The
  full sweep runs on the panel's MOUNT (it is unmounted while closed) and on `⟳` — never on a timer,
  never from the pill. One more consumer, same discipline: the welcome screen runs ONE **local**
  sweep per appearance (only while "Recently closed" is non-empty) for its per-project
  live-session badges (issue #442), bypassing the panel's store on purpose — it must not disturb
  `state/sessionMemory.ts`'s module-level scope stamp, and its scope is always THIS machine.
- **The pill is the single owner of the store's `startHostPoll` / `stopHostPoll`** — the timer and the
  active-scope stamp are MODULE SINGLETONS. The panel must never call them: a `stopHostPoll` on
  unmount would clear the pill's interval with nothing left to restart it, and the number would
  silently freeze until the next scope change.
- **A closed project is not an orphan.** `closeProject` keeps the project and its nodes on disk, so
  its sessions resolve to a real title and are labelled with their project; calling them orphans
  would invite the user to kill sessions they deliberately parked. `resolveSessionRows` is therefore
  fed EVERY project — filtering to the open tabs defeats the rule silently, from outside the file
  that states it. And **`orphan` is the distinguishing field, NOT `state === null`**: a plain
  terminal never enters the agent-status map, so deriving orphan-ness from a missing agent state
  would flag every one of them. Orphans are the point — they are what the reaper cannot see and no
  canvas can show.
- **On an SSH scope the kill routes over the ACTIVE project's master** (`lib/sessionKill.ts` →
  `sshProject.killSessions`), because `transport.destroy(nodeId)` reaches a remote session only
  through a LIVE local client carrying `sshRemote` — which an orphan has not, and neither has a node
  owned by a non-active project. Before this, every orphan row's `×` on an SSH project **promised a
  kill it could not perform**: the local socket was touched, the host's `nt-<id>` kept running, and
  the row came back on the next refresh unexplained. It is safe because it is a **round trip, not a
  lookup** — the row's `nodeId` is literally `session.slice('nt-')` from the sweep and `killSessions`
  maps it back through the same idempotent `sessionName()`, so the exact session name the sweep
  observed is killed on the host it observed it on (node ids are only per-launch unique, and nothing
  here rests on more). Ownership is re-resolved at click time, not taken from the row's stale
  `orphan` flag, so a node created since the sweep is not killed as an orphan.
- **The panel's second action is PAUSE, and it is the one that should usually be clicked.** The `×`
  was the only thing a row offered, which is the wrong tool for what the panel is mostly opened
  for. Measured on the reporting host (2026-09-04, 149 `nt-` sessions, 46 GB of tree RSS): the
  median session with a live `claude` holds **321 MB**, the median session whose CLI has already
  gone holds **5.6 MB** — so exiting the CLI returns **98.3%** of it, and killing the tmux session
  on top buys the remaining 1.7% at the price of the pane, its scrollback and the warm reattach.
  Population-wide the same split is 95% `claude`+`node` against 1.8% shell. **This is the number to
  quote when someone proposes making a memory lever destroy sessions**, and it is why issue #616's
  "end the tmux session too" was not built. The control is NOT a third depth: it calls
  `pauseAgentNode(id, false)` — the same "Pause session" the node menu offers, the same
  `performExitPhase`, the same PAUSED chip and the same Resume — because a panel-only "hibernate"
  would be a third concept for the user and a second exit path to keep in step with Eco's. To pause
  many rows at once, use **Bulk pause** (Terminal session continuity), not a loop over this control. Which
  rows may offer it is the pure `renderer/lib/sessionPause.ts`, and its two directions are
  deliberate: a row that could NEVER be paused (an orphan, a plain terminal, an agent we cannot
  quit-and-resume) renders **nothing** — a dead control on most rows of a machine-wide list is
  noise about something that was never possible — while a row that is merely refused right now
  (busy, no session id, or its terminal is not mounted on this canvas, which is the common case in
  a panel that spans every project) renders **disabled with the reason**. Canvas answers, because
  it is the only place that can see the node's agent, its registered pause closure and its
  `restartEligibility` at once; it asks on the same narrow `st?.sessionId` the node menu uses, so a
  row cannot promise what the closure would refuse.
- **The name and the host were never the hard part — the SOCKET was.** Two nodeterm tmux sockets
  can live on one machine (`node-terminal` for every nodeterm — running ON it or, since the 2026-11
  unification, SSH-ing INTO it — and the legacy `nodeterm-rmt`, where a pre-unification build's SSH
  projects left sessions) and the sweep lists **both**, while the kill targeted one — so every row
  off the other socket got "this stops its tmux session" and a kill that landed nowhere. Not exotic
  at the time: a host running its own `nodeterm-server` while being SSH'd into was exactly that. A kill that knows only a NAME therefore goes to **every
  socket that name could be on** (`KILL_TMUX_SOCKETS` → `remoteTmuxKillEverySocketArgs` /
  `localKillSockets`), which is safe because tmux's "can't find session" was already the ignored
  case, because the target is **exact** (`-t =nt-<id>`: without `=` tmux falls back to fnmatch then
  PREFIX matching on a miss, and `nt-…-1` is a prefix of `nt-…-12`, so a miss could kill a different
  session), and because the fan-out is **opt-in and asked for by exactly one caller**: it needs both
  "we do not know the socket" AND `everySocket` from the caller (`localKillSockets(live, everySocket)`,
  `sshProject.killSessions(…, {everySocket:true})`, `transport.destroy(id, {everySocket:true})` —
  the wire legs demand a literal `true`). A destroy for a session we HOLD still fires exactly one
  kill; and the unheld branch is not rare — an ordinary node-× on a node never mounted in this
  process takes it, which is the norm after an app restart — so project deletion and every ordinary
  × stay narrow rather than inheriting the panel's blast radius. The sweep and the reaper keep their own copies of
  the socket list **on purpose**: for them the ORDER decides first-wins de-duplication, for a kill
  it means nothing.
- **The generated SSH shell is tested under a real `/bin/sh`** (`session-memory-remote.test.ts`
  against a fake host tree, same discipline as `remote-claude-usage.test.ts` and
  `canvas-control-shim.test.ts`) — and it is not ceremony: the plan's own script said `echo ##MEM`,
  which prints an **EMPTY LINE** under POSIX sh (an unquoted `#` starts a word-initial comment) and
  would have made **every healthy host report `ok:false`**. The markers are quoted for that reason,
  every section header is printed unconditionally (a missing one means the stream was cut short, not
  that the host had nothing), and the socket names + `-F` format come from the shared constants so
  the two legs cannot look at different sockets.
- **Which machine answers** is decided in `session-memory-service.ts` by OR-ing two independent
  claims of remoteness — the renderer's `remote` flag and the shell's `isRemoteProject` — because a
  source that answers "no" while momentarily uninformed (index not loaded, master just dropped)
  would turn a remote query into a LOCAL sweep and publish this machine's sessions under the host's
  name. `sshScopePredicate` answers from **identity, not liveness** (`workspaceStore.sshProjectIds()`
  — a DISCONNECTED SSH project is still someone else's machine), OR-ed with the live masters. The
  `remote` option pair is deliberately asymmetric: `run` is optional, `isRemoteProject` is
  **required** — reading-without-knowing is a compile error.
- **Surfaces.** **Desktop**: full. **Server Edition**: the service runs and the ws-bridge has a REAL
  implementation, so the pill and panel describe the machine the server is served from; an SSH scope
  answers `ok:false` (no ControlMaster injected) and says so **by identity** via `sshScopePredicate`
  rather than trusting the renderer's flag — see docs/SERVER.md, including the silent dependency on
  the boot-time `workspaceStore.load()`. **Relay tabs**: the stub answers `ok:false` and the panel
  says session memory is not available there, which is a different story from a failure. **Kanban**:
  Canvas passes `overBoard={kanbanOpen}` (the same prop `UsageIndicator` takes), raising the pill to
  z 26 over the board's opaque 25, and an open panel to 60; with the board CLOSED the open panel
  still has to clear the sessions sidebar (z 12), which is the separate
  `.sysres-indicator:has(.sessmem-panel) { z-index: 13 }` — both `:has()` rules work only because
  the pill cluster is mounted OUTSIDE `<ReactFlow>`, whose wrapper's inline `z-index: 0` would trap
  any value inside it. **Mobile**: **N/A for v1** — *nodeterm
  mobile* attaches to tmux sessions over the transport protocol and has no per-session host-memory
  concept; adding one means extending that protocol (follow-up in the iOS repo).
- **Windows (no tmux) — the session host is a third leg, not a special case.** Its sessions reach
  the reaper (`SessionReaperOpts.sessionHost`, consulted only when `tmuxBin()` is null), this panel
  (`collectSessionHostMemory`, CIM process table) and dev-server ports (`collectWin32DevPorts`, one
  PowerShell call) through ONE additive hello feature, `sessionDetails` (pid, subscribers, output
  clock, generation per session — docs/windows-session-host.md "Observability"). The rules above
  carry over unchanged: a failed host read is `ok:false` / no candidates / `unreachable`, never "no
  sessions"; no host running IS "no sessions"; a session an older host names but cannot describe is
  `unmeasured` (`unmeasuredBackend: 'session-host'`, its own sentence), never dropped; a reap kills
  exactly the observed generation. Both legs merge (`mergeLocalLegs`): a leg that answered is never
  overridden by one that failed. The tmux path is untouched wherever the session host is not the
  backend (`PtyManager.sessionHostListing()` answers `undefined`).

**Offscreen release makes the macOS reaper bug far more visible, and the two shipped days apart.**
A node released while offscreen detaches its PTY client — so it becomes a DETACHED tmux session and
joins the reaper's candidate pool once past the 6 h grace. On a Mac reading `os.freemem()` the
watermark was permanently tripped, so those sessions were culled on the next sweep. More automatic
detaching + an always-true pressure signal is why the symptom read as "my sessions keep
disappearing" rather than as an occasional cull. The `vm_stat` reader is what makes the pool safe
again; the grace window was never the thing that was wrong.

**macOS memory pressure is the KERNEL's level, on its own leg, fired on escalations only.** The
byte leg (`hostMemReader`) stays `null` on darwin and main's RSS never nears the 4 GB self leg, so
until this leg the renderer's reclaim levers never ran on a visible Mac window — the safety net #179
counted on was dead. `core/memory-pressure.ts` now samples `kern.memorystatus_vm_pressure_level`
(1 normal / 2 warn / 4 critical; async `sysctl` per 30 s tick, last landed value) and calls
`onKernelPressure` on an ESCALATION (normal→warn, →critical). Measured lever effect (dev, 12
hidden warm terminals): GPU footprint 331 → 152 MB, IOSurface 235 → 91 MB, all 12 re-granted on
pan-back. Three rules: never re-fire a HELD kernel level (the 60 s floor at a held WARN is #179's
timed release and its pan-back flicker again), and never let a FLAPPING one do the same: each fall
to normal re-arms the leg, so a run at the same or a lower severity than the last one waits out
`KERNEL_LEVER_GAP_MS` (10 min) and only an escalation above it (warning → critical) fires inside the
gap; never feed the level through `hostMemReader` /
`MemInfo` (`planReap` shares it — that would be a new reaper trigger); a kernel CRITICAL runs the
levers only, no reaper sweep, until that step is measured on its own (#211). A failed read is no
information: it neither fires nor resets the held level.

## Live links (Pro browser link to one terminal: watch, chat, or type)

A live link shows ONE node in a plain browser — read-only, or typeable on a Control link by a viewer
who also has its password — until it expires (≤ 24 h, or never for Unlimited) or is stopped; creating
one is Pro and the backend is the gate. Reference: **`docs/live-links.md`**. Invariants:
- `watchLink:*` (owner IPC) is host-only: no relay peer, hosted editors included, may create, list (a
  view carries the secret URL), stop, kick, chat, or change a link's control (typing, password, lock).
  The viewer protocol is `watch:*` and must never start with `watchLink:` — relay-host refuses
  host-only channels before any policy, so it could never arrive (`src/shared/host-control.test.ts`,
  `src/core/relay/scoped-guest-policy.test.ts`).
- A watcher never goes through `decideAccess` (it would get the VIEW table): `watcher-policy.ts` refuses
  every request and every cast but `watch:history` (every link), `watch:chat` (Commenter and Control
  links) and, on a Control link only, the three controller casts `watch:unlock` / `watch:input` /
  `watch:release`; it passes out only
  `watch:*`, its own pty frames and `pty:size`, and takes no `interceptReq` (`watcher-policy.test.ts`,
  `chat-cast.guard.test.ts`). The policy knows only the ROLE: "controlling" is the link host's state
  per CONNECTION (a right password; a reconnect unlocks again, a session restart keeps it). Input from
  a viewer that is not controlling is a breach, except within 5 s of losing control (dropped silently);
  every loss of control goes through `loseControl`, and every chunk is re-checked (control period,
  the record read live, the same session) before it goes.
- A controller's input reaches the node's PANE, never a tmux CLIENT: keys as `send-keys -H` lines read
  by `tmux source-file -` from stdin, after a mode cancel, on the exact `=nt-<id>:`; pastes as
  `load-buffer -` + `paste-buffer -d -p -r`, so tmux frames them by the pane's real state. A byte
  written into a client is its keyboard, and the prefix is the security boundary (`C-b s` = every
  session on the socket, `C-b :` = tmux's command prompt). Keys never ride a paste buffer (tmux 3.7
  vis-encodes control bytes there), and no payload ever rides argv, local or SSH. The viewer frames
  every paste itself and sends each emulator answer as its own cast, which the host drops whole
  (`isTerminalReport`); the contract is in `protocol.ts`. Zellij is refused (`watcherInputRoute` →
  `none`, `nodeControlSupport` → `unsupported`). Routing: `pty-manager.control-input.test.ts`; meaning
  on a real tmux: `pane-input.realtmux.test.ts`.
- The Control password is a scrypt hash only (no plaintext kept or logged anywhere; every scrypt run in
  one FIFO gate of 2; `timingSafeEqual`). Host throttles: 1 attempt per 2 s per viewer, 3 wrong end the
  connection, 10 wrong across the link lock it (lock AND count persisted in the record, so a restart
  resets neither; it and a new password reset the count). The lock LIFTS BY ITSELF (L2: any link
  holder could otherwise lock control for everyone for good): 15 min for the first since the owner last
  allowed control, doubling per lock, capped at 24 h; `lockedUntil` and `lockStep` are persisted (a
  restart neither lifts it early nor makes it permanent; a lapsed one is lifted at launch BEFORE the host
  is built; a lock written without `lockedUntil` still waits for the owner). Allow control again lifts
  it at once and resets the count AND the backoff. Viewers are told `lockedForMs`; the owner's notice
  names who tipped it (a claim). The unlock is SEALED to a per-connection X25519 key pair offered in that
  connection's meta (`unlockKey`, `shared/watch-link/unlock-seal.ts`, L3), because every link holder can
  derive the tunnel's keys; the client seals by itself and never sends the password in the clear on a
  connection that offered a key; a plain unlock (an older page) is still accepted, except on a
  connection that already sealed one. Typed input is NOT sealed (residual, docs).
  Owner changes go by direction: narrowing (typing off, a new password) applies at once and is NEVER
  undone by a failed or hung write — the brake must not fail open; the owner is told `'unsaved'` (holds
  until a restart unless a later write lands; Stop ends it for good) — widening (typing on, allow again)
  only after the write. A chunk handed to `PtyManager.controlInput` carries `isCurrent`, asked right
  before it spawns, so it never lands after control ended; a batch holds at most 64 chunks.
- Unlimited = `ttlSeconds: 0` → `expiresAt: null`: no expiry timer, never pruned for time. The backend
  grants it only with no TTL cap and asks the license's liveness at host-token at most once per 24 h per
  license (dead → 402 → the host stops minting, the view reads `refused`; keygen unreachable fails
  open).
  A build older than this one drops Control and unlimited records on load and its next write removes
  them (their server rows live on with no host until they expire or Stop all).
- Watchers are QUIET (no broadcast, not in `clientIds()`) and SELF-PACED (never paused, dropped or
  resynced by the registry); the reaper reads `quietClientIds()` too, or it releases a session only a
  viewer holds (`ui-sink-registry.watcher.test.ts`, `pty-reap.test.ts`).
- Read-back (`watch:history`, `core/watch-link/history.ts`) is the agent's CONVERSATION, never the
  terminal's history: a viewer's stream is a tmux client on the alternate screen and has nothing to
  scroll, and copy-mode would scroll the owner's pane. The host cuts every page at `record.createdAt`
  (a message with no time is never sent) and `readHistoryPage` cuts again on both ends; tool results and
  thinking never travel. The read is host-chat's `page`, bound to the link's node (a viewer sends only a
  cursor), one at a time per viewer, ≥ 500 ms apart.
- The stream filter sees every byte, has NO length cap (a cap leaked a measured clipboard), and every
  join resets it `midStream`, never to text mode and never on a keyframe. `captureVisible` never returns
  history (exact `=nt-<id>:`, no `-S`; the session host answers its negotiated `captureVisible`, the
  only route that sets `altScreen` itself; plain shell and a Zellij node get no keyframe). A
  viewer sizes nothing: `joinOnly` + `sizeVote: false`; its own tmux client is `-E -f ignore-size,read-only`,
  and a Zellij node never gets one (refused, never a Zellij attach — that client could type).
- Node gone is tri-state (only ABSENT ends a link; a lost or corrupt index is never a complete read —
  `knownNodeIdsStrict()`, which only live links call; the agent-status mirror keeps `knownNodeIds()`,
  which ignores that flag, because a whole-process pause of its pruning was R54's mistake).
  Link state is never canvas content, no canvas-control verb touches links, the chip is not hideable
  (`src/renderer/lib/live-link.guard.test.ts`); both shells wire one core service, the Server Edition as
  `unsupported` until it has a license layer (`src/main/watch-link-wiring.test.ts`).
- `src/shared/watch-link/` is vendored byte for byte into nodeterm-web: siblings and `tweetnacl` only,
  no Node API, type imports spelled `import type` (`isomorphism.guard.test.ts`); a change there owes the
  web repo a re-vendor. Chat text is stripped of controls AND bidi controls there, capped by code point;
  a NAME also loses every format character (`\p{Cf}`) and the blank letters, so look-alike names are
  equal (L4); chat TEXT keeps only ZWJ and ZWNJ of the format characters (emoji, Persian/Indic).
- The viewer page strips the secret fragment from the address bar after reading it (L1): kept in the
  tab's `sessionStorage` (`nodeterm.watchLink.<linkId>`) for a reload, a Copy link button rebuilds it;
  where storage cannot be written the fragment stays. A full link's status poll is 60 s (L6).
- Never silent about what a viewer gets. The session host's read-only client is a negotiated
  `watch-attach` attachment (no claim, no pause ticket, host refuses its writes, never spawns, never
  indexed as the node's session; an older host means refused, never an ordinary attach). Where local
  terminals are neither (tmux off or missing, Zellij, an older host) a viewer can watch only a terminal
  the app has OPEN (there is no read-only client to spawn): the create dialog says so, and a refused join turns the chip amber `LIVE · 1
  waiting` ("Viewers are waiting — open this terminal in nodeterm…"). The stream is the owner's tmux
  CLIENT's output, so its session chooser or a session switch reaches viewers; the warning names it.
  A controller's input that does not reach the pane is reported (`watch:control {controlling,
  dropped}`, cause-neutral: the rate limit or a failed delivery, e.g. an SSH host without tmux).
- The Live chat drawer has ONE `nodeterm:live-chat` listener (Canvas); no OS notification per chat
  message (`control-taken` is the only link notice that raises one); a message counts as read only
  while the window is visible and focused.
- Stop all is the only control that reaches other machines' links: it is offered to a Pro owner even
  with no link listed here, awaits the server and reports what it reached (`RevokeAllOutcome`) — a
  failed or skipped server call must never look like a stop.

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

## Node colors (one palette, two sections)

`src/shared/node-colors.ts` is the palette AND the control boundary — the picker's list and the
allowlist `color --color C` validates against are the same array, deliberately, so the two can
never disagree about what a legal colour is.

It has two sections. The seven macOS **system** colours are the list it always was. The **agent**
section is the brand colour of every builtin in `AGENT_CONFIG` plus `FALLBACK_AGENT_COLOR`, and it
exists because those colours were *already on the canvas*: `createAgentNode` paints a new node from
`AGENT_CONFIG` (the phone's `appendProjectNode` does the same), so a Claude node is born `#d97757`
— which the picker could not offer back once the user changed it, and which
`nodeterm color --color '#d97757'` refused with `node-color-invalid`, the app rejecting its own
colour. MEASURED against the live hook server before the change; both faces are one gap.

- **The agent section is DERIVED from `AGENT_CONFIG`, never re-typed.** Adding a builtin agent
  extends the palette by construction. `node-colors.test.ts` pins it three ways — every builtin's
  colour is in `NODE_COLORS`, every agent swatch's label is that agent's label, and `node-colors.ts`
  contains no agent hex as a literal on a non-comment line. A second copy of a colour table is the
  drift this file warns about everywhere else, and it has already happened once (see mobile below).
- **`SYSTEM_NODE_COLORS` is the subset for surfaces where the value is drawn as TEXT or as an
  opaque fill** — the app accent (`--accent` sits under hardcoded `#fff`), a project colour (the
  active tab's label is `color: p.color`) and a kanban column colour (`ColumnPill` draws the title
  in the raw hex at 10 px). It is also the **auto-assign rotation** for new frames, spawned teams
  and fresh columns: rotating a frame onto Claude's orange says "this frame is Claude's" and means
  nothing of the kind. The reason those surfaces differ is a measurement, not taste — on the dark
  theme white on gemini `#4285f4` is ~3.6:1 and on grok `#64748b` ~4.0:1, both under the 4.5:1 floor
  for the 10.5 px badge, and grok grey as tab text is ~2.6:1. Everywhere the colour is a dot, a
  border or a 6–20 % wash (node headers, sticky, files, group frames, the account default colour)
  offers the FULL palette.
- **`resolveNodeColor` runs BEFORE the allowlist, and only its output is ever persisted.** It takes
  a palette name (`blue`, `teal`, `claude`, `github copilot`) or the hex in any case, and yields a
  canonical value or `undefined`. Names are accepted because the refusal they earned was measured
  and expensive: seven opaque hexes taught nobody which one was teal, so a caller's next guess was
  another name and another refusal. The boundary is unchanged by this — a name can only ever
  resolve to a value the allowlist already held, and a name is never stored. The refusal now prints
  `name #hex` per swatch (`nodeColorChoices`), and the agent-facing skill text is generated from the
  same function per the canvas-control sync rule.
  `open-project --color` takes the same treatment against the **system** resolver; it used to reach
  `registerProject` with no validation at all.
- **One component draws every picker** (`components/NodeColorSwatches.tsx`), because the palette now
  has structure — headings and per-swatch names — and six copies of `NODE_COLORS.map(...)` are six
  places to forget the heading. `NodeColorSwatches.guard.test.ts` fails on a `.color-popover` this
  component does not own and on any renderer file that maps the palette into its own swatch row.
  The name is the feature: an agent brand colour is unidentifiable as a bare circle.
- **Mobile keeps its OWN list and is not updated here.** *nodeterm mobile* (`nodeterm-ios`,
  separate private repo) hand-copies the agent colours in `NewSession.swift`, stamped
  *"last verified 2026-07-17"*, to colour a session it creates; it has no node-colour picker at all,
  so the palette change reaches it as nothing to do. That mirror is the concrete precedent for why
  the desktop half is derived rather than typed — and it means a future brand-colour change owes an
  iOS follow-up (@eneskirca), not a desktop one.


## Semantic colours (one role per meaning)

Status and accent colours are TOKENS in `styles.css`, never hues at a call site. Two layers:
the Apple system palette `--sys-red … --sys-gray` (dark values in `:root`, light values in the light
block) and the ROLES that rules actually name — `--state-working | attention | unread | error |
success | warning | queued | automation` and `--git-modified | added | deleted | renamed |
conflict`. A role is a FILL value (glow, dot, stroke, and chip washes via
`color-mix(in srgb, var(--state-x) N%, transparent)`); text in a status hue keeps the text-safe
tokens `--danger --warn --caution --success --agent-working`, which the light theme darkens.

- **An appearance re-maps a MEANING by redefining a role**, not by restyling rules. The default look
  keeps its historical hues (working clay, unread = accent, attention red, warning orange); Liquid
  Glass maps them to the HIG semantics (see its section).
- **JS that needs a literal** (xterm find decorations, canvas-drawn sprites, the notch HUD, which does
  not load styles.css) reads `renderer/lib/palette.ts`; `styles.palette.test.ts` pins `--sys-*` to
  that table. JS that styles the DOM passes `'var(--role)'` strings (the minimap strokes, the git
  status letters, kanban priorities). Hex-with-alpha suffixes (`${c}2e`) do not work on a var —
  use `color-mix`.
- **Git status colours have ONE table**, `renderer/lib/gitStatusColors.ts`, used by Source Control
  and the history commit list; an unknown status draws in `--text`.
- **Minimap strokes are their own tokens, `--mm-working|attention|unread`.** The default look keeps
  its map language exactly (amber working, red needs-you, CLAY unread) on purpose: an uncoloured
  node's fallback stroke is the accent blue, so an accent "unread" would vanish into the map (the
  comment on `nodeStrokeColor` in Canvas.tsx). Under Liquid Glass the tokens map to the state roles,
  since node fills there are neutral ink and nothing can clash. The palette test pins both.
- **Left as-is on purpose:** agent brand colours (`AGENT_CONFIG`) on Claude-identity surfaces (the
  subagent node, the usage pill icon, the mascot), the node colour swatches (`node-colors.ts` is an
  allowlist — stored project colours must stay valid), node-kind default colours (persisted into
  project files at creation), kanban label chips (own palette), presence colours, the onboarding
  scenes, the notch HUD's own stylesheet.

## Node icons (emoji, glyph or picture)

A node may carry `data.icon` (`NodeIcon` in `@shared/node-icon`): `{type:'emoji', value}`,
`{type:'lucide', name}` or `{type:'image', path}`. Absent = the node draws exactly as it did before the feature, which is the
degrade every failure path falls back to. Set from the node right-click menu ("Set icon…", hideable
like Colors — id `icon`), from the icon itself in the terminal node header, and from the kanban card
modal's header slot; drawn by the one `NodeIconView` on all four surfaces that list a node (canvas
header, kanban card, card modal, sessions sidebar row), because a session seen in four places must
not look like four sessions. **Terminal (session) nodes only in v1** — the menu row is gated on the
kind, deliberately: offering it on an editor or a group frame would persist a value nothing draws,
which is the "looks like it worked" failure this file warns about elsewhere. Extending it to sticky
or browser nodes means adding the draw and the set together, in one change.

- **Glyphs (issue #291) are a closed allowlist, `NODE_GLYPHS`** — shell, git repo, database, server,
  … with a label each (tooltip / accessible name, never stored). It is typed as a SUBSET of the
  project icon's `LUCIDE_ICON_IDS`, so a glyph draws from the one `LUCIDE_ICONS` map `ProjectGlyph`
  owns; a new glyph needs an id already in that map (or added to both). The name is matched exactly —
  a name outside the list, a newer build's glyph, is no icon, and an OLDER build drops it on its next
  save of a shared project.json (its `normalizeNodeIcon` does not know the variant). Picked from the
  same dialog as emoji, drawn in `currentColor`. Agent nodes are terminal nodes, so they are offered
  a glyph like any icon: it sits beside the agent's own identity, it does not replace it. No
  auto-suggest (cwd is git → git glyph, pane command `psql` → database): an icon written without the
  user choosing it would land in the git-shared file.
- **The icon survives a close/reopen.** Both reopen paths carry it re-validated — `withCosmetics`
  (⇧⌘T and the sidebar history both end there) and `stateToReopenSnapshot` (the persisted twin is
  read from hand-editable workspace.json). Before, `icon` was not a cosmetic key and a reopened
  session came back bare.
- **`.nodeterm/project.json` is hostile input, so the icon is validated at BOTH serializer seams.**
  `normalizeNodeIcon` runs in `nodeStatesToFlow` (a cloned file becoming live state) *and* in
  `flowToNodeStates` (live state becoming the next reader's file — live node data is reachable by a
  peer canvas mutation, and whatever we write is what the next machine trusts). One-sided validation
  passes every round-trip test while leaving the other direction open; both seams are mutation-pinned
  in `workspace.test.ts`.
- **An emoji is ONE grapheme** (`Intl.Segmenter`, with a UTF-16 cap as the fallback, never as the
  primary rule — slicing units cuts a ZWJ sequence into a fragment). Uncapped, a shared file could
  put a 40 kB "emoji" into every header, card and sidebar row.
- **An image path must LOOK like an image** (extension → MIME). That gate is what stops a hand-edited
  project file from aiming `fs.readBinary` at `~/.ssh/id_rsa`. It is not a full jail — the path can
  still name any `*.png` on the machine, exactly as an editor node's `filePath` always could — but
  the bytes only ever become an `<img>` under a `'self'` CSP with no network, so the reachable
  outcome is "an icon fails to draw". A `./` path may not traverse (same rule as
  `isSafeQuickOpenRelPath`).
- **Two dialects in, one dialect out — and the traversal guard splits on BOTH separators, always.**
  The value is written by one machine and read by another, so `normalizeNodeIcon` ACCEPTS a Windows
  absolute (`C:\…`, `C:/…`) and a POSIX one wherever the check runs, while everything STORED is
  POSIX-separated. Both halves are load-bearing. Refuse `C:\…` on a mac and a mac user merely
  opening the shared canvas and saving it **silently strips a Windows teammate's icons** from
  `project.json` — such a path does not resolve on a mac, but not-drawing is a degrade and a degrade
  is not a reason to destroy the value on the way past. Store `.\a\b.png` and it means a file
  called `a\b.png` on POSIX and `b.png` inside `a` on Windows, so a relative path is canonicalized
  to `./` with forward slashes (the same way an emoji is canonicalized to its first grapheme).
  **`isSafeRelIconPath` splits on `[\\/]` on every platform**, because splitting on `/` alone made
  `./a\..\..\secret.png` ONE segment — neither `''`, `.` nor `..` — so it passed the guard
  everywhere and escaped the project root the moment a Windows reader resolved it; a segment may
  also not contain `:` (a drive qualifier, or an NTFS alternate data stream). **UNC is refused**,
  matching `renderer/terminal/file-links.ts`, which consumes UNC specifically so it can refuse it:
  reading one reaches another machine over SMB.
- **`localIconCwd` is the ONE definition of which cwd a `./` icon may resolve against**, asked by
  the picker's write side and by `useNodeIconSrc`'s read side. It was written twice and drifted: an
  SSH project's `cwd` is a path on the REMOTE host while the icon is read through the LOCAL `api.fs`
  (an SSH project runs on the local session — only a RELAY tab's api belongs to another machine), so
  the read side resolved a remote-rooted `./` path against this machine's filesystem and drew
  whatever happened to sit there. Undefined = the icon does not draw, which is the honest answer for
  a file on a filesystem this reader cannot see; absolute paths are unaffected, and absolute is what
  the write side stores for SSH.
- **A picked image is downscaled before it is written** (`lib/nodeIconThumbnail.ts`, 256 px long
  edge = 16× the drawn size). What lands in `.nodeterm/images/` is committed and cloned by everyone
  on the repo, and it draws at 13–16 px. SVG is passed through (rasterizing it would make it worse
  at every size, not merely smaller), as is anything already small in both dimensions and bytes (a
  canvas round-trip can make a hand-made 32 px PNG *bigger*) and any re-encode that came out larger.
  An animated GIF becomes a static PNG. The decision (`thumbnailPlan`) is pure so it tests under
  vitest's default `node` environment — jsdom has no canvas — and the browser half's decode/encode
  is injected. It **fails open in every direction**, including a decode that never settles
  (`DECODE_TIMEOUT_MS`): `chooseImage` awaits it before writing, so a hanging promise would leave
  the button stuck on "Copying…".
- **The extension is checked BEFORE the copy.** `dialog.selectFile` applies no filter, so an
  unsupported file is one click away — and validating after `saveCanvasImage` left an orphan file in
  the user's git-shared folder on every refusal, which nothing later removes.
- **The bytes are COPIED, not referenced.** The picker reads the chosen file and writes it through
  `files.saveCanvasImage` — the same seam canvas image nodes use — so it lands in the project's
  git-shared `.nodeterm/images/`. A path inside the project cwd is then stored `./`-relative
  (`portableIconPath`) and resolved on read (`resolveIconPath`), which is the convention
  `toPortableNodes` already set for node cwds. **This is the one place that convention is applied to
  a `filePath`-like field**: canvas image nodes still store theirs absolutely, so their file travels
  with the repo while the node naming it does not — an existing gap, not one this introduced.
  A cwd-less canvas, an SSH project (its cwd is on the host; the image is written app-locally) and
  the app-local fallback all keep an absolute path and simply do not travel. Not an error.
- **The picker owns Escape while it is the top dialog** (`useDialogStack()`'s answer, which was
  previously discarded). The gate is `isTop()` ALONE, matching `confirmKeyAction`, where `inDialog`
  guards Enter and never Escape: Enter is the affirmative key and must be aimed at the dialog, while
  requiring focus inside the box for Escape reproduces the original bug for a user whose focus sits
  on the body.
- **A relay tab is refused** (`canvasImportRefusal`, the same message and the same reason as canvas
  image import): the write is this machine's preload while the read is the peer's core, so the node
  would name a file only this machine has. Reads otherwise go through the PROJECT's session api, not
  `window.nodeTerminal` — which is what makes a peer-authored `./` icon resolve on the peer.
- Image reads are cached per `(projectId, absPath)` in `lib/nodeIconImage.ts`, because four surfaces
  mount independently and a thirty-card board would otherwise re-read the same bytes thirty times per
  open. Caching by path is safe: `saveCanvasImage` creates exclusively, so re-picking yields
  `logo (2).png` rather than overwriting.
- **Surfaces.** Desktop: full. **Server Edition**: full — every leg is already core (`fs.readBinary`,
  `files.saveCanvasImage`) or has a real browser implementation (`dialog.selectFile` → the web
  picker), so no new IPC was added and nothing is stubbed. **Mobile**: N/A for v1 — *nodeterm mobile*
  attaches to tmux sessions over the transport protocol and carries no per-node icon concept;
  surfacing one means extending that protocol (follow-up in the iOS repo).

## Desktop wallpaper + Liquid Glass (Settings → Appearance)

Two opt-in choices, both off by default so an update changes nothing on screen:
`settings.desktopWallpaper` (`none | {preset, id} | {image, path}`, read through
`normalizeWallpaper` in `@shared/wallpaper` — hand-editable, unknown ⇒ `none`) and the
**Liquid Glass appearance**, which is the fourth value of `settings.appTheme` (`'liquid-glass'`,
`isLiquidGlass` in `renderer/lib/appTheme.ts`) rather than a separate switch: it is a look, and its
light/dark base follows the terminal theme exactly like `auto`. Choosing it with no wallpaper picks
one (`defaultWallpaper`: the first macOS still, Sonoma Horizon when present, else a gradient) so
glass never sits over plain black; a wallpaper the user chose is never replaced. The pre-release
`glassTerminals: true` maps to it once in `settings-store` (only over `auto`).

- **The wallpaper is painted on `.canvas-root`** (`Canvas.tsx`), which spans the whole window —
  tab bar row included, so Liquid Glass's tab bar is glass over the picture — and is never
  transformed, so it stays put while the canvas pans and zooms. React Flow's own root goes
  transparent over it (`.react-flow.has-wallpaper`); the dot grid is faded to 30%, not removed,
  because snapping still aligns to it. **Settings → Appearance → Show grid dots**
  (`settings.canvasDots`, default ON in every appearance, read through `showCanvasDots` — only a
  literal `false` hides them) omits the React Flow `<Background>` entirely; it is display only, and
  snap-to-grid / align-to-grid keep using `gridSize`. Pure renderer + settings.json, so the Server
  Edition gets it unchanged. Under Liquid Glass the kanban overlay paints the SAME wallpaper
  (`useBoardWallpaperStyle`, `background-attachment: fixed` so it lines up with `.canvas-root`) and
  stays opaque to the canvas below — the covered-canvas animation gate stays valid; other looks keep
  the board's own background.
- **`background-image` + longhands, never a `background` shorthand next to `var(--canvas-bg)`.**
  MEASURED live: Chromium drops a var()-containing value once it passes ~2 MB, and a still's data:
  URL is ~3 MB, so the shorthand resolved to nothing and the canvas stayed black. The class rule
  supplies the colour underneath.
- **Images reach the page as data: URLs from core** (`core/wallpaper.ts`, `wallpaper:*` channels,
  registered by BOTH shells), so the CSP is untouched and no protocol was added. `load` never
  reads a renderer-named path: a macOS still is named by its `mac:` id and re-resolved against a fresh scan
  of `/System/Library/Desktop Pictures` (read at runtime, NEVER bundled — they are Apple's), and an
  imported image must be a hash-named DIRECT child of `<userData>/wallpapers/` (`cachedImagePath`,
  the whole jail). `import` is the exception — it copies any image-named regular file the caller
  names into that cache — which is no wider than the caller's own `fs:read`. Chromium cannot decode HEIC, so macOS converts with `/usr/bin/sips` to a JPEG
  ≤ 3840px — and `sips -Z` also UPSCALES (measured: 320px → 3840px), so it is passed only when the
  image is larger. An import is copied untouched unless it must be converted (HEIC, over 3840px or
  over the 25 MB load cap — re-encoding everything would flatten PNG/WebP alpha); where no converter
  can do it, HEIC or an over-cap image is refused at import time, where the picker shows the reason.
  **Conversion is a seam, `WallpaperImageOps`**: macOS always uses `sipsImageOps` (its `id` stays
  `'sips'` because it feeds the cache key — renaming it would orphan every existing cache file), the
  Electron shell registers `nativeImageWallpaperOps` (`main/wallpaper-native-image.ts`) on **win32
  only**, and Linux / the Server Edition register none (no stills, same refusals as before). With
  ops, Windows lists `%WINDIR%\Web\Wallpaper` stills as `win:` ids (same re-resolve-against-a-scan
  jail as `mac:`). nativeImage decodes no HEIC (`canHeic:false`, still refused) and cannot measure
  WebP, so an unmeasurable file is COPIED there (`convertUnknownSize:false`), never handed to it.
- **macOS Aerials are `aerial:<asset UUID>` / `aerial-shuffle:<category UUID>` presets** (UUID-only
  after the prefix, else `none`). Core reads `~/Library/Application Support/com.apple.wallpaper/aerials`
  (`manifest/entries.json`, `videos/<id>.mov` = only what macOS downloaded, `thumbnails/<id>.png`)
  with a FRESH scan per call and allowlists only those two shapes built from manifest UUIDs found as
  regular files; the renderer never names a path. Videos stream through nt-media:// via the
  `setWallpaperMediaUrl` seam (main registers `allowMediaPath`; the Server Edition registers none, so
  it lists no aerials). Never downloaded, never bundled. `load` returns the 214×130 thumbnail as the
  still; `AerialWallpaper.tsx` paints still + muted `<video>` on a `position: fixed`, z-index auto
  layer rendered as the SIBLING before `.canvas-root` (which then paints no background), so NO new
  stacking context is created and every panel/portal stacks exactly as over a still — an earlier
  `isolation: isolate` on the root changed portal-vs-chrome order (review of 095cf396). Under Liquid
  Glass each board renders its own layer (z −1 inside the overlay) and picks its own clip. Clip
  choice: the category's shuffle clips, else its other downloaded clips, else ANY downloaded aerial
  — the upscaled thumbnail read as a blurry regression in live review — so the thumbnail is the
  picture only with nothing downloaded at all or every clip failing. Reduce Motion mounts the video
  paused (a full-resolution frame). Paused while `data-nt-window="idle"` (unfocused or hidden — the
  CSS animation gate's signal) and, for the canvas layer, while a board covers it. MEASURED (4K
  240 fps HEVC Dubai clip, M-series, Liquid Glass + one terminal): GPU process ~70 % playing, ~0.1 %
  idle-paused or on a still; renderer ~3 % vs ~0 %.
- **The cache is pruned on a SAVED change and on import, never at boot.** `SettingsStore.init`
  answers an unreadable settings.json with the defaults, and pruning against that would delete the
  image the user chose. Only hash-named full-size files are candidates; thumbnails, temps and
  foreign files are never touched, nor is a conversion in flight. **The most recent imported image
  is kept too** (`settings.recentWallpaperImage`, written by `wallpaperChoice` when an image is chosen
  or left; `wallpapersToKeep` feeds the prune): choosing a preset once deleted it and the "Your image"
  tile vanished (visual QA H6). Core does not hot-reload in `electron-vite dev` — a prune change
  needs an app restart to take effect live. A failed renderer load is not
  cached (the file may appear).
- **Terminal nodes use their OWN theme's tint** (the chrome fill is for everything else). The node fill is the terminal theme's background at an alpha
  from `glassTintAlpha` (`renderer/lib/glassContrast.ts`): the smallest alpha at which the theme
  foreground keeps 4.5:1 over ANY backdrop. Checking white and black suffices because composite
  luminance is monotone in each backdrop channel — except when the text's luminance falls INSIDE
  that range, which `worstContrast` fails explicitly; a grey-backdrop sweep pins it per theme. The
  0.95 design ceiling yields to the guarantee: Solarized Dark gets 0.985, and Solarized Light — under
  4.5:1 even opaque — gets 1. The tint is per node (project theme override included) and the glass
  header takes the TERMINAL foreground for its text tokens, since it sits on the terminal's tint.
  **ANSI palette colours are NOT protected** (only the foreground is): protecting all 16 at
  min(3, own opaque contrast) forces alpha 1 on every built-in theme, because slots like `black` on
  a dark theme sit at ~1.3:1 and any translucency moves some backdrop onto them. Decided: keep the
  glass (foreground-only guarantee); the blur softens bright spots, and the Settings copy says
  coloured output can fade.
- **xterm paints no background under glass**: the theme background keeps its RGB at alpha 0
  (`glassTheme`, memoised per theme so `applyLiveOptions`' identity compare stays a no-op) plus
  `allowTransparency`, so the WebGL atlas is rasterised without a baked-in background. Both toggle
  LIVE through `applyLiveOptions` (the addon rebuilds its atlas on any option change); the card
  modal passes glass too (`useTerminalGlass`, shared with TerminalNode, sets the same
  `--term-glass-*` tint on `.kanban-modal__termwrap--glass`; its DOM renderer keeps app-painted cell
  backgrounds opaque); the settings preview never does. Glass stands down while a shared glyph grid is
  mounted (it paints text BELOW the nodes, so a tint would cover it), and, only when **Keep blur while
  moving** is off, the blur is dropped while the camera moves (`.canvas-moving`, toggled by
  `onMoveStart`/`onMoveEnd` via classList so a pan does not re-render Canvas). Only the blur
  pauses: nodes keep their backdrop squeeze (see **Backdrop squeeze**), which is what holds the text
  left of the Readable tick.
- **App-painted cell backgrounds become glass** (`terminal/glass-cell-backgrounds.ts`). addon-webgl
  0.18.0 paints every background rectangle at alpha 1 (`RectangleRenderer._updateRectangle`,
  `$a = 1`), so full-screen TUIs read as slabs: Grok's `48;2;20;20;20` screen fill, Codex's composer,
  Claude's bubble — and, worse, every DIM/ITALIC/hyperlink run on the DEFAULT bg, because those flags
  live in the bg word and the run gets a theme-background rectangle at alpha 1 (Codex's all-dim
  header box). No xterm option exists, so the private method is wrapped on the shared prototype
  (installed from `acquireWebgl`, original kept under a `Symbol.for` key so a hot reload never
  double-wraps; fail-open). `classifyRun`: inverse → stock opaque; attribute-only (default bg) → the
  theme bg's alpha (0 under glass); rendered bg ≠ the buffer cell's raw bg = a renderer override
  (selection, block cursor, search/decoration) → stock opaque; else an app PANEL → `glassPanelFill`.
  **A panel is a vibrancy LIFT or SINK of the glass, never the panel colour at the node's tint
  alpha** — that first version stacked a second tint on the node's own, and #3a3a3a over a bright
  wallpaper read as a dark smudge. Overlay alpha = `PANEL_K`(1) × OKLab distance(panel, theme bg),
  clamped [0.04, 0.22], dead zone < 0.02 (= draw nothing), INDEPENDENT of the slider (Claude's
  #3a3a3a on #1e1e1e → 0.11, Grok's #141414 → 0.044). Colour: the panel's own hue when OKLab chroma
  > 0.04, else white (lift) / black (sink). A move TOWARD the text (dark-theme lift, light-theme
  sink) at or right of the Readable tick uses the glass composite over the extreme backdrop
  (`B·t + white·(1−t)`) instead of pure white — the lift then never passes the glass's own worst
  case, so the theme fg keeps exactly the plain glass's 4.5:1; left of the tick it slides toward pure
  white by `(4.5 − glassWorst)/3.5`, continuous at the tick. Text check over the WHOLE run (the fg
  the renderer passes is only the first cell's): inverted-polarity text (dark text on a light bar,
  dark theme) must keep min(4.5, its opaque contrast) or the panel stays opaque; other text, while
  the guarantee is on, must fare no worse than on plain glass; glyphs under 3:1 on the opaque panel
  are decoration. **Polarity is judged against the PANEL, not the theme bg** (#303030 text is lighter
  than #1e1e1e yet dark on a #e4e4e4 bar — judged by the theme, that bar went translucent at 1.00:1).
  **One verdict per panel colour per terminal** (`panelVerdicts`): fill computed once, each text
  colour checked once, opaque sticks (a multi-row light box never stripes), reset on alpha or theme
  bg/fg change — addon-webgl rebuilds every row on any cell change, cursor blink included. Capped at
  `PANEL_VERDICTS_MAX` (4096) colours, cleared past it (truecolor images add thousands). A colour
  that turns opaque mid-pass re-runs `updateBackgrounds` once (also wrapped), so the rows already
  drawn in that pass do not stay translucent on an idle screen — `term.refresh` would not do it: the
  addon calls `updateBackgrounds` only when a model cell changed. The wrap
  body after the stock rectangle is try/caught per call (fail open per frame, not only at install). Reduce Transparency (t = 1) → opaque. Written premultiplied as `(c·√k, √k)` — the
  canvas is premultiplied and the addon blends alpha with SRC_ALPHA, so this stores exactly `(c·k, k)`.
  Only terminals registered through `setGlassCellAlpha` (TerminalNode, `glassOn` only) are touched —
  others are byte-identical; an alpha change calls `term.clearTextureAtlas()` because backgrounds
  only rebuild for changed cells — through `scheduleGlassCellAlpha`, which debounces a change between
  two glass alphas by 150 ms (a slider drag streams 0.01 steps and each rebuild wipes the SHARED glyph
  atlas); glass on/off is immediate. The test pins addon-webgl 0.18.0 and every private name, and
  sweeps both default themes to prove the Readable guarantee on panels. Ceilings: Increase Contrast
  does not strengthen panels (it pins the node to Tinted already); the DOM-renderer fallback keeps
  explicit backgrounds opaque (inline truecolor `background-color`).
- **Liquid Glass chrome** (`:root[data-nt-glass='on']`, set by App.tsx only for that appearance, so
  every other look is byte-identical). ONE chrome fill, `--glass-chrome-bg` = the resolved `--panel`
  at `glassChromeAlpha(--text, --panel, 4.5, highlights)` — **dark 0.74, light 0.745** on the shipped
  palettes. `highlights` (`glassChromeHighlights`) are the washes that stack on the SAME fill — the ink
  lift (`GLASS_LIFT_ALPHA` 0.14: hover rows, the active tab) and the accent selection
  (`GLASS_SELECT_MIX` 0.3) — each with the `--text-strong` ink styles.css gives highlighted states, so
  a highlighted row keeps 4.5:1 exactly like a plain one (plain fill alone: dark 0.70; the active tab
  then measured 3.9:1, visual QA round 2 N2). A new highlight wash on glass owes an entry there and
  `--text-strong` ink. The
  app's `--text` is itself TRANSLUCENT (`rgba(var(--tint-rgb), 0.85)`), so the ink moves with the
  backdrop and the white/black endpoint argument does not hold; the backdrop is SAMPLED (6×6×6 grid +
  grey ramp) and the test re-checks a fine sweep against the real tokens of both themes. App.tsx
  reads the tokens with the glass attribute removed first (harmless now that the tokens stay
  solid under glass; it keeps the solver independent of the gate). `--muted` has no guarantee
  (0.9 dark / 0.965 light would be needed). **Glass is OPT-IN per surface** (Slice D, visual QA
  round 3): the surface TOKENS (`--panel`, `--panel-header`, `--panel-2`, `--surface-*`,
  `--tabbar-bg`) keep their SOLID theme colours under glass, so any panel, menu, popover or tooltip
  that is not listed is opaque. They used to be redefined to the fill, and every unlisted floating
  surface became see-through with no blur — round 2 fixed five named ones and this file claimed
  "those five were the only traps"; round 3 found six more (Explorer and Source Control drawers,
  the context-menu flyout, the node and card-modal label pickers, the Members picker, tooltips).
  The translucent fill is handed out only by the two lists at the end of styles.css (plus the node
  kinds), each WITH a blur; a new glass surface goes in one of them. A piece INSIDE a glass surface
  that painted a token paints a lift, the input-well sink or nothing (find bar, markdown bar,
  session chips/fields, Settings sidebar, hover rows); small buttons keep their solid colour.
  **Never translucent without a working blur** (visual QA round 2 N1): an element with its own
  `backdrop-filter` (or filter, opacity < 1, mask, clip-path, blend mode) is a BACKDROP ROOT — a
  blur on anything inside it samples only the root's pixels, so a menu that pops out of it, or
  covers sharp content inside it, shows that content crisp through its tint. So: (a) a container
  that HOSTS pop-out menus keeps its glass on a `::before` layer (fill, hairline, blur) and is no
  backdrop root — `.dock`, `.dock-menu`, `.dock-menu__sub`, and every `.ctx-menu` that does not
  scroll (a scrolling menu cannot host a flyout, and a `::before` would scroll away with its rows);
  (b) a popover INSIDE a glass node or the card modal (`.ctx-popover`, `.color-popover`,
  `.label-picker`, `.kanban-meta__picker`; the host is its root) is simply not listed, so it is
  opaque — and all four paint ONE solid token, `--panel` (the colour the glass fill is `--panel` at
  an alpha of), with the glass hairline and one shadow (visual QA round 4 N4-M1: they were five
  greys); they keep the theme placeholder, not the glass one (N4-M2). Every MODAL dialog is glass
  (Remote access, Publish, consent, the GitHub issue modal and the mobile-launch card joined the
  text list); (c) in-flow pieces that only stack on their own blurred parent (node header, card-modal
  terminal) are fine. **Two guards.** `styles.glass-traps.test.ts` fails when a rule paints a glass
  fill (`--glass-chrome-bg`, `--glass-control-bg`, `--term-glass-bg`, `--term-glass-header-bg`) on
  a selector with no `backdrop-filter` in that rule or in a blur rule for the same element or its
  `::before` (in-flow exceptions are named with a reason), and when a surface token is redefined
  under the gate. It cannot see DOM nesting, so `scripts/glass-trap-probe.mjs` is the live half:
  run it against a dev build with remote debugging (`node scripts/glass-trap-probe.mjs --port
  9333`) with each overlay open; it lists every visible surface with background alpha < 0.9 whose
  blur is ineffective (none behind it, floating over a blurred/solid ancestor's content, or a blur
  escaping its backdrop root) and exits 1 on any. Slice D ran it over 27 states (dock menus,
  context menu + flyout, popovers, tab menu, palette, drawers, phone, help, Settings + theme menu,
  sessions, RAM, usage, label pickers, tooltips, kanban, card modal + pickers): 0 traps — at REST.
  **Glass never fades** (visual QA round 4, N4-H1): opacity < 1 makes an element a backdrop root, so
  a scrim fading its opacity turned the palette/dialog/drawer inside it into clear glass for the
  120–160 ms of every open, and a `::before`-hosted menu fading its own opacity did the same. Under
  glass scrims fade their `background-color`, glass surfaces enter by transform only (Remote access
  pops like its siblings), tooltips appear without motion and the focus-mode dock slides. The glass
  entrances sit in a no-preference query; under Reduce Motion the default-look `animation: none` list
  covers most surfaces, and a gated reduce rule covers the kanban card modal and its scrim (also the
  GitHub issue modal's), whose `kanban-fade`/`kanban-pop` opacity fades otherwise ran on glass (code
  review 7 #1). Both guards see motion: the static test fails on an opacity keyframe
  (`@-webkit-keyframes` too) or transition (a shorthand with no property name is `all`) on any glass
  surface, blurred `::before` layer, or scrim (the scrim list is the probe's exported `SCRIMS`)
  unless, in BOTH motion preferences, a rule overrides it — a gated rule, or a later default-look rule
  on the same selector; an override inside a media query counts only for the preference it names
  (the kanban modal passed because its only override sat in a no-preference query). A fade selector
  is matched when it can hit the same element as a surface (either covers the other, or they share a
  subject class). It reads the LAST backdrop-filter declaration, lets a later unconditional rule on
  the same element cancel a blur, counts `background-image` as a paint and matches coverage on the
  full selector (`:not()`/`:hover` kept). The probe runs a second pass that replays every finite
  animation, seeks every finite RUNNING animation to half its duration and scans (a blur inside a
  see-through backdrop root, or a blurred surface fading its own opacity, is a trap), inspects
  `::after`, gradient fills and mask-border roots. It never calls `pause()`/`play()` — on a CSS
  animation they install a play-state override, and an infinite animation then ignores the idle
  gate — since one synchronous evaluate cannot see the timeline advance, a seek freezes the frame and
  a seek back restores it; replayed elements get their `animation-name` re-set once more and lose a
  `style` attribute they did not have, and the pass verifies its own restoration. It exits 2 — never
  0 — when it checked nothing, the page does not answer within 20 s, or it left state behind. Slice E: 0 traps at rest and mid-animation, dark and light
  (palette, context menu, Explorer, Remote access, label picker, Settings, sessions). Node blur
  pauses during camera moves; chrome is static and keeps it. **Left opaque, deliberately:** Monaco, `<webview>` and `<video>` bodies (another
  renderer's surface), sticky notes (the colour is the note), and the `surface-sunken` wells
  (`bg-bg` inputs are a sink/lift of the page on glass). **Kanban**: header strip + columns are
  text-surface glass, cards a `--glass-lift-hover` lift WITHOUT their own blur, column/header dots
  neutral rings, status chips ink on a hue wash, drop target + reorder line neutral ink.
  **Two chrome fills (slider scope)**: `--glass-chrome-bg` for TEXT surfaces never drops below the
  readable alpha (and `--glass-text-blur` below the tick's blur); `--glass-control-bg` for the small
  floating CONTROLS (tab bar, dock, zoom, toolbar buttons, minimap, pills, sessions toggle) follows
  the slider down to `glassControlClearAlpha` — at least 0.35 and enough for 3:1 icons over every
  sampled backdrop after the control blur's `brightness(--glass-control-dim)`: dark 0.35, light 0.57
  (brightening cannot lift near-black water; round 2 H4) — and `--glass-control-blur` dims (dark, ×0.7) or
  brightens (light, ×1.3) their backdrop left of the tick — both from `glassChromeAlphas`. A new
  floating container goes in ONE of the two lists. **Highlights** are `--glass-lift(-hover)` (theme
  ink 14%/10%) or `--glass-select` (accent 30%) for THE selection, with `--text-strong` ink — never
  `--panel*`, a solid band on glass (visual QA H1/H2; round 2 N5: dock/zoom/sessions-row hovers and
  the default Button) — the hover lift carries `--text-strong` too (`--text` on it is 4.1:1). The
  readable alpha is solved for every accent swatch (Yellow needs 0.825 dark; bound 0.85). Segmented
  controls select with a neutral lifted thumb, so the one filled accent
  per view is the primary action (N12). `::placeholder` is `--glass-placeholder` (0.78 dark / 0.85
  light, 4.5:1 on the fill and never above `--text`, pinned by glassContrast.test.ts; the dark floor
  is 0.77); light has no room below `--text` at 4.5:1, so TYPED text in chrome fields is
  `--text-strong` and an empty field still reads empty (round 3 NM1). A placeholder ranks below
  secondary text (macOS: tertiary), so on dark glass the modal dialogs raise `--muted` to 0.82 (4.9:1
  worst case) and Remote access's hard-coded 0.55 lines take it (visual QA round 5, N5-M2); light
  cannot, and keeps the typed-text rule. The RAM panel's hard-coded 0.45–0.6 secondary lines take
  `--muted` (N5-L2). Destructive menu items (`.ctx-item.danger`) draw an
  ink label and keep red only on the icon; their hover is the ordinary lift (N5-M1: the red label was
  2.7–2.8:1 on dark glass). OK-range usage/context meters are
  neutral ink under glass (M1: green already means unread/success) — the fills are inline literals
  shared with the notch HUD, so the rule matches the serialised `rgb(48, 209, 88)`. Under glass `--muted` is 0.7 dark / 0.8 light and `--muted-2` = `--muted`. The minimap draws node rectangles in translucent theme ink
  (inline node colours overridden with `!important`), keeping the working/attention/unread strokes.
- **No window accents under Liquid Glass.** A terminal window's per-node colour arrives as INLINE
  styles (`borderTopColor`, the colour dot's background), so the overrides carry `!important`: a
  neutral `--glass-edge` border, the dot as a neutral ring (it is still the colour-picker button),
  neutral resize handles. State survives without the colour: selection is an ink (`--text`) outline,
  unread keeps its `--state-unread` border + glow, working/attention keep their `::after` glows and
  header badges. The sessions list and the kanban board keep node colours. `styles.liquid-glass.test.ts`
  pins the gate and every neutralising override.
- **Glass palette** (HIG color.md › Liquid Glass color). The block at the end of styles.css
  redefines only ROLES (see **Semantic colours**): working = the accent (no longer Claude clay),
  needs-you = orange, finished-unseen = green, warning = yellow, error = red — one hue per meaning,
  and orange means only "needs you" (`--warn` becomes `--caution`, the text-safe yellow). The glows,
  minimap strokes, sidebar signals and badges follow with no rule of their own. Status labels on a
  glass header are ink over a tinted chip (`-webkit-text-fill-color: var(--text)` with the chip
  mixed from `currentColor`), not coloured text. `styles.palette.test.ts` pins the mapping and that
  no two meanings resolve to the same colour, in both themes.
- **Backdrop squeeze: readable at every slider position** (`glassBackdropRange`,
  `glassChromeBackdropRange`, `glassBackdropFilter` in `glassContrast.ts`). Left of the tick the
  tint alone measured about 1:1 at Clear (dark text over a black wallpaper, light text over a white
  one). So each glass node appends a colour-matrix filter that squeezes the backdrop into a range
  the tint can cover: light glass lifts it to a floor (`contrast(c) brightness(b)` maps 0..1 to
  lo..1), dark glass caps it (`brightness(hi)`). CSS filter functions work per channel in gamma
  sRGB, the space `composite` blends in (measured live: predicted 153, rendered 154), so every
  squeezed channel lies in the range and the grey-endpoint argument still holds. The promise slides
  with the slider (`glassMinRatio`): `GLASS_CLEAR_RATIO` 3:1 at Clear rising to 4.5:1 at the tick,
  picked by eye over light and dark wallpapers in both themes (4.5:1 at Clear dimmed bright
  wallpapers to brown). Light glass also gets a frost floor that fades in toward the tick
  (`glassFrostFloor`, full `GLASS_LIGHT_FROST` 0.5 from the tick; without it light glass over a dark
  wallpaper read as grey mud); the text and control chrome chains carry the same floor as a static
  `--glass-frost` (light only). Terminal nodes get theirs per node as `--term-glass-backdrop`
  (`useTerminalGlass`); canvas cards (subagent, files, loop, trigger, dino) follow the slider too
  (`--glass-node-bg` at `glassSurfaceAlpha`, squeeze `--glass-node-squeeze`, both from App.tsx).
  Glass that needs no squeeze gets no filter (null; `var(--x,)` falls back to nothing), so dark
  glass at or right of the tick runs the exact chain it ran before. The kanban card modal's terminal
  has no backdrop filter of its own, so it never goes clearer than the tick
  (`useTerminalGlass(theme, true)`). Under Liquid Glass the empty-canvas hint is a text-surface pill
  (its faint ink vanished on the wallpaper). Measured with 4 terminals panning: no frame-time change.
- **Glass slider + refraction** (Settings → Appearance, shown only under Liquid Glass; iOS 26's
  Clear ↔ Tinted). `settings.glassTint` is a slider POSITION, not an alpha (`null` = the Readable
  tick, read through `resolveGlassSlider`): every surface has its own readable alpha, so each maps
  the position through three points — `GLASS_CLEAR_ALPHA` 0.05 at Clear (terminal nodes and canvas cards; chrome controls 0.35, text surfaces never below readable — see Liquid Glass chrome), its OWN computed readable
  alpha at `GLASS_READABLE_TICK` (0.7), `max(readable, 0.95)` at Tinted (`glassSliderAlpha`). At the
  tick every surface is exactly at the alpha `glassTintAlpha`/`glassChromeAlpha` computed, and every
  alpha right of it is higher, so Readable→Tinted keeps 4.5:1 from the tint alone; left of the tick
  the backdrop squeeze carries a sliding promise (see **Backdrop squeeze**). Measured: chrome dark
  0.05 / 0.70 / 0.95, chrome light 0.05 / 0.745 / 0.95, nodeterm-dark 0.05 / 0.675 / 0.95 (Clear /
  Readable / Tinted). App.tsx sets `--glass-t` (blur 16→28px on chrome text and controls; canvas
  cards (`--glass-blur`) and terminal nodes (`--glass-term-blur`, × 0.85) run 4px at Clear up to the
  same 24.4px at the tick, `16 + 12t − 12·max(0, 1 − t/0.7)`, picked by eye so Clear reads through; saturation
  `--glass-sat` 180% at Clear → 150% from the Readable tick to Tinted, text surfaces a flat 150% —
  round 2 N9: 1.6–2.0 turned glass olive or pink over bright wallpapers). **Refraction** is ONE shared SVG filter
  (`components/GlassRefraction.tsx`, `#nt-refract`: a 32² edge-lens displacement map generated once,
  `primitiveUnits="objectBoundingBox"` so one filter fits every element), referenced from
  `--glass-blur` as `var(--glass-refract,)` — no per-node filters. **It runs only LEFT of the
  Readable tick** (`glassRefractionOn`): App.tsx sets `--glass-refract: url(#nt-refract)` inline and
  mounts the filter only there; the stylesheet never declares it (`styles.palette.test.ts`). From the
  tick to Tinted it bent an already ~20px-blurred backdrop by ≤3px (0 at Tinted) and was the costliest
  filter in the chain: MEASURED (M2, six glass terminals, one streaming) 74% → 42% GPU without it. Its
  `feImage` source makes Chromium treat a refracting surface as damaged across its whole rect, so one
  changing pixel re-ran the blur of the glass around it. The map was 256²: that bitmap cost the
  renderer ~10% CPU per streaming terminal (paid per frame per refracting surface); 16–32² costs
  nothing measurable and draws the same lens (32 vs 256 at Clear: mean 0.02/255, max 7). **It runs after the blur**
  (`blur() saturate() url()`; only the colour-matrix squeeze may follow it, since it moves no pixels) and composites over its SourceGraphic so its output is opaque: first in
  the chain (plus an in-filter soft blur with default edgeMode) it let Chromium show a 20–40px band of
  SHARP backdrop inside every glass rim at every slider value (visual QA C1). Measured on an empty
  `.ctx-menu` over terminal text, rim-band high-frequency energy 2.55 → 0.20 (Clear), 1.90 → 0.07
  (Readable) = the interior's. **Terminal glass flattens luminance**: `--glass-term-blur` adds
  `contrast(calc(1 - var(--glass-t)))` (1 at Clear, 0.3 at Readable, 0 at Tinted) — a blurred photo
  under a big pane read as smudges; empty glass at Readable over the lake photo went 2.2:1 → 1.28:1
  brightness swing. It keeps the backdrop a backdrop colour, so the guarantee is untouched. The status
  chip wash is sized at the Readable tick for every slider position (the wash only grows with alpha).
  App.tsx sets `data-theme`, `data-nt-glass` and the glass custom properties in LAYOUT effects, so no
  frame paints the attribute without its fill. Its scale is `0.025 × (1 − t)`; it moves
  backdrop pixels, never the tint, so it cannot touch contrast. Glass NODES carry a 1px rim light instead of a sheen: a
  masked-ring `::before` (anchored to the React Flow wrapper), brightest top-left; a surface-wide
  diagonal sheen was tried and washed the pane out. Refraction scale max is 0.025 (was 0.06). Node blur+refraction pause while the camera moves
  (`.canvas-moving`) ONLY when **Keep blur while moving** is off (`settings.glassBlurWhileMoving`,
  default ON, read through `keepGlassBlurWhileMoving` — only a literal `false` pauses): on, Canvas
  never adds the class, so the glass stays live through a pan at a GPU cost; chrome keeps both always. MEASURED on the live dev build (CDP computed style):
  Chromium keeps `url("#nt-refract") blur(…) saturate(…)` on the tab bar, dock, sessions sidebar,
  minimap, zoom controls and terminal nodes (that was measured before refraction became Clear-side
  only; at Readable and right of it the chain now ends at the colour filters).
- **Glass terminal nodes frost with a STATIC copy of the wallpaper, not a live backdrop-filter**
  (`lib/glassFrost.ts`, `canvas/GlassFrostSync.tsx`, the `.term-node__frost` rules). Chromium re-runs
  a backdrop filter every time its surface is redrawn, and a terminal is redrawn for every line an
  agent prints, so each streaming terminal re-blurred itself (and, through damage expansion, the
  glass around it) at frame rate; idle cost nothing. MEASURED (M2, six glass terminals, Sonoma still,
  CDP + `ioreg` GPU utilisation, 3 interleaved rounds, medians): six streaming 92% → 42% GPU, 100% →
  50% CPU; one streaming 71% → 20% GPU, 32% → 20% CPU (with the refraction change above); no glass at
  all is 27% / 9%. A node's `.term-node__frost` child paints the wallpaper behind it with the SAME
  chain as an ordinary `filter` (`var(--glass-term-blur) var(--term-glass-backdrop,)`) and the tint
  on its `::after`; that content does not change while the camera is still, so Chromium draws it once
  and reuses it. Rules a refactor must keep:
  - **Alignment is in flow units.** `frostBox` maps `.canvas-root`'s wallpaper (cover, centred; a
    gradient fills the root box) into flow coordinates from React Flow's transform and the pane's
    offset; each node subtracts its own `positionAbsoluteX/Y` (`--node-x/y`). Measured against the
    live backdrop at zoom 1, 0.78 after a pan, and after a drag: node interiors mean ≤0.8/255, max 5.
  - **The alignment vars are written onto each frost layer, never onto React Flow's root**: a custom
    property change restyles every element under it (`lib/canvasZoomVar.ts`), and a pan is a change
    per frame. Layers register through `useFrostLayer`.
  - **The picture is ONE stylesheet rule** GlassFrostSync renders, a ≤1280px WebP copy as a data: URL
    (the CSP allows data: images, not blob:), never a custom property (Chromium drops a var() value
    past ~2 MB).
  - **No stacking context on the node** (no `isolation`): the frost's `z-index: -1` must land in the
    React Flow wrapper's context, under the node's border; inside the node it painted over the 1px
    glass edge.
  - It reaches `FROST_PAD` (80px) past the node so the blur samples the wallpaper beside it: the
    live backdrop clamped at the node's edge instead, so the outermost 1–2px are a touch lighter.
  - **Live backdrop stays** for a focused node (focus mode moves it out of the canvas), an aerial
    video wallpaper (cannot be copied), Reduce Transparency, and until the copy is ready. Canvas cards
    (files/subagent/loop/trigger/dino) still frost live.
  - **What it cannot show**: anything behind the node but the wallpaper — the dot grid, edges, and
    above all another node a glass node overlaps (visible at Clear, where the live glass was thin).
  - Pan cost: the frost re-renders per camera frame like the live blur did (measured 44% vs 38% GPU
    during a continuous pan, CPU equal); with Keep blur while moving off it drops to the squeeze.
  `scripts/glass-trap-probe.mjs` counts a displayed frost layer as the blurred backdrop of its node.
- **Needs-you on glass is an INNER light** (the user's pick, "variant B"): the outer red `::after`
  halo is hidden and a `::before` on the React Flow wrapper paints an inset rim light in
  `--state-attention` (orange) that breathes 0.35 → 1 over 2.4 s — `pointer-events: none`, above the
  glass body (z 5), and fading out ~36px inside the rim so terminal text stays readable. It reads
  `--nt-anim-state` (the covered-canvas pause), holds static-lit when the window is idle and static
  at 0.7 under Reduce Motion. The default look keeps its outer glow.
- **Accessibility outranks the slider** (HIG liquid-glass.md, like iOS). `lib/useGlassA11y.ts`
  reads `prefers-reduced-transparency` and `prefers-contrast: more` (one subscription, Electron and
  browser alike) and `glassSurfaceAlpha` applies them to every tint alpha: **Reduce Transparency**
  = alpha 1, no blur, no refraction filter in the DOM, no rim light, and the slider row is disabled
  with the reason; **Increase Contrast** = the slider pins to Tinted, `--glass-edge` goes to 0.5,
  terminal borders thicken and the `--sys-*` palette takes HIG's increased-contrast columns
  (`SYSTEM_COLORS.darkContrast|lightContrast`, pinned to the CSS). The alpha half lives in JS
  because the fills are INLINE custom properties a media query cannot override. **Reduce Motion**
  holds the three state glows static-lit (the idle gate's values) and stops the minimap and badge
  pulses, in every appearance — the state still reads, nothing breathes.
- **Agent TUIs after a live switch to a light terminal theme** keep the dark palette they latched at
  launch. A/B, nodeterm Light, Readable glass vs opaque Light, same frames: Codex composer 1.25:1 vs
  dark-on-black (unreadable both), Codex model line 1.6 vs 1.41, Claude dim status 1.96 vs 2.86, Grok
  identical — the apps' colours, not the glass (app colours are outside the guarantee). Left as is;
  restart agents after a theme switch.
- **Surfaces.** Desktop: full. Server Edition: gradients + glass; the stills list is empty (not
  macOS) and "Choose image…" is hidden (a picker there browses the SERVER's disk). Relay tabs keep
  a stub (no stills, import refused). Mobile: N/A (no canvas). Kanban: the board paints the wallpaper under Liquid Glass (see Liquid Glass chrome).

## Keybindings (registry, overrides, dispatch)

Every user-facing chord is a registry command, and the whole engine is **one module**:
`src/shared/keybindings.ts` holds the command registry, per-command validation
(`normalizeBindingForCommand`), effective-binding resolution, conflict detection, override
sanitization and the pure event→command resolver. **Do not split it** — main, the renderer and the
Server Edition bridge all import it, and a second copy of any of those five is how the dispatcher,
the Settings section and ShortcutsPanel start disagreeing about what a chord means.

- **Overrides live in `settings.keybindings`** (hand-editable JSON): an absent id = the registry
  default, `[]` = **disabled**, a list = exactly those chords. It is **sanitized at READ**
  (`sanitizeKeybindingOverrides` → `renderer/lib/keybindingOverrides.ts`, memoized on the raw
  object's identity), which is what makes a hand-edited file safe; the Settings section refuses a
  bad candidate BEFORE saving (`commitCandidate`) so the user learns which chord was refused
  instead of watching it vanish on the next launch. The write path is raw and the gates read the
  sanitized map, so a dropped hand-edit is invisible in the UI but still on disk until a UI write
  or Reset replaces the map.
- **Dispatch has exactly two owners per shell.** The renderer's is ONE window `keydown` listener
  in `Canvas.tsx`, on the **bubble** phase — the Settings recorder's `stopPropagation` on an armed
  capture depends on that, and moving it to capture would let a recorded chord fire the command it
  is being bound to. On the desktop the other is `src/main/keydown-intercept.ts`, a **closed
  allowlist** of chords it must steal back from the application menu before the page ever sees
  them. The **Server Edition** has no main process, so for `node.toggleMarkdown` ONLY the bridge's
  `renderer/bridge/markdown-toggle-key.ts` stands in for that intercept — still one owner per
  shell, never both — and it runs on the bubble phase for the same recorder reason. **The Canvas
  dispatcher must never gain a `node.toggleMarkdown` handler**: in the browser it would toggle
  every hovered node twice, and on the desktop it would duplicate main's forward. (`node.close`
  has no browser owner at all: the browser keeps ⌘W.)
- **Invariants**
  - **A bare letter or Space is only ever a `board`-scope binding.** `board` commands resolve only
    while a board is up and carry neither `allowWhileTyping` nor `allowInTerminal` — that pair of
    refusals is what makes a bare key a command rather than a character stolen from the user, so a
    `board` row must never gain either flag, and no other scope may be given bare letters
    (`normalizeBindingForCommand`).
  - **A conflict bucket is a DISPATCH CONTEXT, not a scope** (`conflictBuckets`): `canvas` resolves
    only with the board closed, `board` only with it open, `app` in both — so an app command sits in
    `canvas-view` AND `board-view`, and a canvas command never conflicts with a board one. One
    shared keyspace for all three reported a collision dispatch cannot produce, and the load-time
    sanitizer then STRIPPED the user's legitimate override (a bare-arrow canvas command against the
    board's arrow keys). A test walks every pair of view commands through the real
    `resolveCommandForKeyEvent`, so a new scope or a dispatch change that forgets the buckets reds.
  - **Never read `settings.speech.shortcut`.** The dictation chord is `dictationBinding()` (the
    first effective `speech.dictation` binding); the legacy field is a **downgrade mirror only**,
    written by `setKeybindingOverride` so an older build still finds the user's chord.
  - **`isHoldChord('')` is TRUE** (an all-false parse has a null key), and `''` is what a DISABLED
    dictation binding reads as — so every caller owes an explicit `=== ''` check first. Without it
    a disabled binding arms a modifier-less hold chord that fires on any keydown.
  - **`MAIN_INTERCEPTED_COMMAND_IDS` must mirror the registry-backed commands `keydown-intercept.ts`
    actually resolves** (`keydown-intercept.test.ts` pins it). The Settings UI's app-wide shadow
    warning reads that list and cannot derive it — main is not importable from the renderer. Note
    what the pin cannot cover: a HARDCODED intercept (the `Digit0` branch) has no command id, so it
    swallows its chord app-wide with the recorder reporting no conflict.
  - **Dictation has its own conflict bucket** (`conflictBuckets` — `speech.dictation` is never in
    a view bucket), because it never competes at dispatch: the resolver skips it and its own keyed
    listener claims the chord FIRST **in plain app focus or the ⌘M composer box** (`isChatComposerTarget`),
    which is precedence, not ambiguity.
    Overlap policy is deliberately asymmetric — the LOAD path PERMITS a shared chord (legacy
    settings.json files contain them and `sanitizeKeybindingOverrides` would otherwise strip the
    user's own binding with the migrated one), while the Settings UI REFUSES to create one
    (`commitCandidate`'s two dictation gates, both keyed-only — a modifier-only hold chord renders
    as `…:(hold)` and can never match a keyed identity).
  - **The terminal-first stand-down is `policyStandsDown(policy, terminalFocused)`, and both halves
    are refusals.** `settings.terminalShortcutPolicy` (`app-first` default, Settings → Keyboard
    Shortcuts, read everywhere through `normalizeTerminalShortcutPolicy` because it is
    hand-editable) never stands anything down under `app-first`, whatever the mirror reports — that
    is the byte-identical guarantee for a user who never touched it. Under `terminal-first` with a
    focused terminal, main stops claiming its chords AND disables the command-style menu items in
    `menuItemIdsToSuspend` — Minimize, Toggle Kanban Board (⌘⇧B) and Settings (⌘,) everywhere, plus
    Close off-mac, with **Reload deliberately excluded** (see **Window chrome**): not calling
    `preventDefault` alone would hand ⌘M straight to `{role:'minimize'}`, which is strictly worse
    than having no policy. **The MENU's state is the composed
    `menuStandsDown(shortcutRecording, policy, terminalFocused)`** — an armed shortcut recorder
    suspends the same items, so ⌘M / ⌘⇧B / ⌘, / off-mac Ctrl+W reach the recorder instead of the
    menu item that owns them; `menuStandsDown(false, …)` is `policyStandsDown(…)` by construction.
    The two INTERCEPT thunks stay independent parameters — only the menu ORs them.
    **The CLOSE leg has one extra, policy-independent stand-down** (issue #383, off-mac only):
    `closeStandsDownInTerminal(isMac, terminalFocused)` — off-mac `node.close`'s default chord is
    Ctrl+W, readline's kill-word, so while a terminal has focus the close intercept lets the chord
    fall through UNTOUCHED and `syncMenuForStandDown` disables the Close menu item on top of the
    shared list. mac's ⌘W is deliberately unaffected (not a shell key), and ⌘/Ctrl+M and ⌘/Ctrl+0
    keep firing — this is one chord whose terminal meaning outranks its app meaning, not a policy
    change. Falling through main is not enough: xterm's custom key handler runs before the Canvas
    dispatcher, whose main-intercepted command cases deliberately have no renderer handlers.
    `terminalChordBubbles` must therefore refuse every `MAIN_INTERCEPTED_COMMAND_IDS` command; if
    it returned true for `node.close`, xterm would withhold `^W` while the unclaimed event bubbled
    to Canvas. **`node.toggleMarkdown` is the one exception and BUBBLES**: in the Server Edition its
    owner is a WINDOW keydown listener in the bridge (`bridge/markdown-toggle-key.ts`, below), which
    xterm would otherwise starve by writing `\r` and cancelling the event. It changes nothing on the
    desktop — under app-first main claims the chord above the page, under terminal-first the
    resolver already refuses it, and main has no terminal-focus stand-down for it. One predicate,
    two main-process consumers are pinned in `keydown-intercept.test.ts`
    (including a source-level wiring pin, since the menu leg lives against a real Menu in index.ts),
    and `keybindingOverrides.test.ts` pins the renderer-to-xterm hand-off through
    `terminalKeyAction`.
  - **The Server Edition's ⌘/Ctrl+M is the bridge's own window listener**
    (`renderer/bridge/markdown-toggle-key.ts`, wired as `onMarkdownToggle` in `bridge/stubs.ts`):
    a browser has no `before-input-event`, so the stub used to be `noopUnsub` and the chord did
    nothing there. It mirrors the intercept — effective `node.toggleMarkdown` bindings read per
    keystroke, `policyStandsDown` (now in `shared/keybindings.ts`, re-exported by
    `keydown-intercept.ts`, so both shells run ONE predicate) with focus read from the DOM via
    `isTerminalTarget` — plus a `defaultPrevented` event is left alone. **A held-key auto-repeat
    is claimed but never re-toggles, in BOTH shells**: the browser listener preventDefaults it and
    forwards nothing, and `keydownIntercept` answers `{action: null}` for a repeated toggle-markdown
    chord (still swallowed, so the repeat cannot fall through to the menu's Minimize) — the same
    shape as the held ⌘0. Bubble phase for the recorder's sake, installed only
    while subscribed. It cannot double-fire on desktop (only `buildStubApi` reaches it; the relay
    tab takes `onMarkdownToggle` from the local preload). macOS Chrome reserves ⌘M for minimize,
    so the default chord only reaches a Mac browser tab after a remap (docs/SERVER.md).
  - **A status-reading command builds its answer PER KEYPRESS, never from a subscription.**
    `node.nextNeedingYou` (ships unbound, mirrored in ⌘K as "Go to next agent needing you") builds
    `needsYouQueue` (`lib/nextNeedingYou.ts`) from `useProjects`/`useAgentStatus` `getState()` on
    each press: the status-mode sidebar's "Need attention" rows (`buildStatusList` over the
    non-closed projects), re-sorted OLDEST wait first, minus rows `nodeTravel` reports `blocked`.
    Canvas must never subscribe to the status store's `byId` for it (every flip would re-render the
    canvas). Travel is `travelToNodeRef` (keeps the hosted-team reopen guard), the cycle cursor is a
    ref (memory only), the node the user is already in is skipped when another waits, and an empty
    queue is CLAIMED with an info notice — xterm has already withheld the chord, so declining would
    only make a deliberately bound chord silent. After a restart the notice counts agents whose
    restored `lastSeen` last said waiting/blocked (`waitingBeforeRestart`). Its handler entry is
    pinned by `keybindings-handler-parity.test.ts`, which checks only the ids in its `checkedIds`.
  - **ShortcutsPanel is DERIVED from the registry, never a hand-written list.**
    `buildShortcutSections` iterates `COMMAND_DEFINITIONS` — one section per `CommandGroup` in
    registry source order, the label from `def.title`, and EVERY one of the command's EFFECTIVE
    chords — and a command with no effective binding (ships unbound, or the user disabled it) is
    OMITTED rather than shown chord-less. All chords, not just the first: off-mac
    `terminal.copySelection` holds Ctrl+Shift+C AND Ctrl+Insert, and in the **Server Edition**
    Chromium reserves Ctrl+Shift+C for the inspector un-preventably — so a first-chord-only row
    advertised the one that cannot work there. The panel it replaced enumerated 24 ids by hand against a
    45-command registry, so ⌘⇧T (reopen last closed), ⌘⇧↵ (maximize node), the ⌃⌥arrow zone snaps
    and Copy terminal selection were live chords it never mentioned, and no ships-unbound command
    could ever appear even after the user assigned one. `ShortcutsPanel.test.tsx` is the watchdog:
    it binds every registry command and asserts a row per `def.title`, so a new command that fails
    to surface reds it. Same stale-doc rule as the canvas-control skill body (#269) — derive the
    text, don't retype it.
    Rows the registry does NOT own (mouse gestures, the two `zoomShortcut.ts` chords, the ⌘1-9
    project jump, tmux/xterm terminal behaviors) are literal, and still read from settings where
    the behavior does: the hover dwell prints `panHoverDelay` and the drag rows follow
    `canvasDragMode`, because the old fixed text claimed 0.6 s and a right-drag pan React Flow
    (`panOnDrag={[1]}`, middle button only) has never done.
    **One honest exception to "the chord shown is the chord that fires":** `terminal.copySelection`
    is a registry row whose matcher is still the hardcoded `isCopyShortcut`
    (`terminalKeyAction` keeps the copy chords and Shift+Enter "whatever the registry says"). Its
    registry defaults match that matcher on both platforms, so the row is accurate as shipped; a
    REMAP of it would not be, on this panel or in Settings. Wiring `isCopyShortcut` to the registry
    is the fix.
  - **`terminalFocused` is a MIRROR, and its fail-safe direction is `false` = not focused =
    intercepts ON.** `renderer/lib/terminalFocusMirror.ts` reports focus changes to main and is
    change-deduped (it never re-asserts), so a page that died mid-report, a reload, or a window that
    never had one all resolve to intercepts on — never to "off with nothing alive to turn them back
    on". Consequence: clear the bit ONLY where the renderer's DOCUMENT is ending (window `closed`,
    `render-process-gone`, main-frame navigation). Clearing it under a live page that is still
    focused on its terminal strands mirror and main out of sync with no event that can reconcile
    them, and the policy is dead until the user clicks away and back.

## Canvas interaction & panels (`Canvas.tsx` is the hub)

- **Context menus** (`components/ContextMenu.tsx`, portal, icons from `components/icons.tsx`):
  pane right-click = add nodes at cursor (terminal / Claude / sticky / open file) + select
  all + fit + **Tidy canvas** (`arrangeAllNodes` → `tidyCanvas` — packs every top-level node,
  including group frames as rigid units, without overlap, keeping each ORCHESTRATOR legible; see
  the Tidy canvas bullet below; mirrored in ⌘K as "Tidy canvas" and in the
  keybinding registry as `canvas.tidy` (default ⌘/Ctrl+Shift+A, remappable); both
  hidden below 2 top-level nodes, where it could only be a visual no-op that still writes
  `project.json`) + restart-idle-agents (the bulk in-place agent restart, mirrored in ⌘K; both
  hidden when the canvas holds no restartable agent node, where they could only report "0
  restarted");
  node/selection right-click = group, color, duplicate, align-to-grid, collapse,
  markdown-view (terminals), refresh-terminal (terminals — bumps `respawnNonce`: fresh PTY attach
  to the SAME tmux session; manual recovery for a stuck/unpainted terminal, and the same action
  sits in the node header as `term-node__refresh` since a dead view is a bad place to hunt for a
  right-click; nothing running is interrupted), restart-agent
  (single agent node — the in-place CLI restart above; absent for a CLI we cannot quit + resume,
  disabled with a hint while the session is busy or has no id yet), delete. Actions live
  in `Canvas.tsx`, operate on `targetIds`. **Conversation actions are grouped** so an agent node's
  menu fits on screen: **Transfer conversation ▸** holds one row per target (a model-capable target
  nests its gateway models one level further), and **Restart ▸** holds the restart variants —
  restart, restart + fresh shell, restart on subscription, then Reopen as. Switch model ▸ and Switch
  account ▸ stay first-level rows beside it (everyday choices, not recovery restarts).
  `ContextMenu` renders submenus to any depth (`MenuRows` is recursive); a flyout that hosts a
  submenu drops its scroll (`.ctx-submenu--host` — `overflow: auto` would clip the
  nested flyout) and `useSubmenuFlip` lifts a flyout that would run off the bottom. The non-destructive rows are user-hideable from
  **Settings → Appearance** ("Node menu items" / "Terminal header buttons"), stored as HIDDEN
  lists in `settings.hiddenNodeMenuItems` / `settings.hiddenHeaderButtons` (empty = everything
  shows). `lib/ui-visibility.ts` owns the two inventories and `isHidden`, which only answers for
  ids it knows — so Delete, restart-agent, branch/transfer, terminal Search and Close can never
  be hidden, whatever settings.json says. The group-frame menu's colors strip answers to the same
  `colors` id; builders run through `tidySeparators` so a hidden row leaves no dangling rule.
- **Tidy canvas keeps the orchestrator** (`tidyCanvas` in `state/workspace.ts`, 2026-10 — user
  feedback: *"I lose the sense who is orchestrator"*). The old Tidy packed every top-level unit
  into one reading-order grid, so an orchestrator landed wherever its (y, x) fell — routinely LAST,
  after the stations it opened and the loose notes between them. Now a unit that opened other units
  is placed first, at the top-left of its own cluster, with the units it opened packed in a ~square
  grid directly to its RIGHT, and a sub-orchestrator's own team clustered the same way inside that
  grid (recursive blocks, `flowBlocks` = `arrangeNodes`' row flow over rectangles). Clusters are
  packed in reading order of their orchestrators; every unit with NO lineage is packed after them,
  below, by the plain grid. Rules a refactor must keep:
  **(1) The relation is the OPENER only, and it is `openerByTarget`** (`lib/teamProgress.ts`) —
  the ONE definition team progress reads too (`data.openedBy` when recorded, else the first
  non-wait rope into the node; `stationsByOpener` now sits on it), so the ring and the layout
  cannot disagree about whose station a node is. Waits are NOT followed: a verify panel's
  reviewers wait on the reviewed node, but the orchestrator opened all of them — following waits
  would split its team under one of its own stations. And one opener per node makes the clusters
  a forest, so the layout has one answer.
  **(2) Ropes are lifted to the top-level unit** (the #1114 shape: a coordinator opens a lead
  INSIDE a frame, so the frame joins the coordinator's team). A frame whose contents were opened
  by different units belongs to the one that opened the MOST of them, ties to the earliest rope; a
  plain node's own opener always wins for it. A rope internal to one frame is dropped.
  **(3) A cycle never hangs** — lifting makes one easily (a in frame g opens b outside, b opens a2
  inside g); the cycle member that reads first loses its opener and leads.
  **(4) No lineage ⇒ exactly the old call**: `arrangeNodes(grid)` over the reading-order ids —
  pinned against that call verbatim, waits-only canvases included. (Not byte-identical to the
  pre-#836 *build*: `arrangeNodes` then placed in array order, ignoring the sort this action always
  documented — see Arrange by lineage below.)
  **(5) Same array when nothing moves**, so a second Tidy writes no undo entry and no
  `project.json` (it still fits the view). The layout is idempotent by construction: every block
  places its members in reading order, so a tidied canvas reads back in the order it was laid out.
  A dead opener (deleted; the rope pruned, or a stored file's unpruned rope) leads nothing — its
  stations fall loose. Desktop + Server Edition identical (pure renderer, no new IPC); kanban N/A
  (a board has no geometry); Mobile N/A (no canvas). Agents reach it as `arrange --group top`.
- **Arrange by lineage** (`arrangeByLineage` / `lineageLayers` in `state/workspace.ts`; pane menu
  beside Tidy canvas, ⌘K, and the registry command `canvas.tidyLineage`, which ships UNBOUND —
  ⌘⇧A is already the first tidy) — the second tidy: one row per LAYER of the lineage ropes
  (`project.ropes`, i.e. "opened by" and `--after`), growing downward, so a coordinator sits above
  the team it opened and that team above what IT opened. Four rules, each of which the naive
  version gets wrong: **(1)** a rope is LIFTED to its top-level ancestor before it counts — an
  agent opens a team INSIDE a frame, and the frame is the rigid unit that moves; a rope whose two
  ends lift to the SAME object is internal to that frame and dropped, or the frame would be its own
  opener. **(2)** a node's layer is its LONGEST path from a root, never its first — with `max`
  every rope points strictly downward, which is the whole reason the result reads as a flow; a
  reducer that keeps the LAST opener happens to be right in one edge order and wrong in the other,
  so the test asserts BOTH. **(3)** nodes no rope touches are NOT layer 0 — they are a final
  `loose` band, because a node with no lineage is not a root of anything and mixing the two puts
  every sticky note beside the coordinator. **(4)** a cycle never hangs and never throws (the edge
  that closes it contributes `0`): a rope cycle is not supposed to exist, but `--after` can be
  hand-built into one and `project.json` is editable. The refusal is the transform returning the
  SAME array — no usable rope, or under two top-level nodes — which is also what keeps a no-op out
  of the undo stack and out of `project.json`; **that verdict is taken from `nodesRef` BEFORE the
  write, never from a flag set inside the `setNodes` updater**, which runs when the state is
  processed and is therefore still false on the next line (it would cost every run its `markDirty`
  + `fitAll`). The pane row is then DISABLED with its reason while the palette OMITS it (no
  disabled state there). Built ON `arrangeNodes` — one `row` placement per band from a shared left
  origin — so packing, gap and the mixed-container refusal stay in ONE place. **That only holds
  because `arrangeNodes` fills its slots in the order of the ids it is handed**: it used to place
  in ARRAY order, which threw away the slot order `lineageLayers` computes (siblings under their
  opener) AND the reading-order sort `arrangeAllNodes` documents, with every existing test green
  because each asserted the layer LIST and never the positions. The interleaved case is now
  asserted on positions. **Bands read BOTH relations, slots read the opener first** (2026-10):
  layering follows openers AND waits (a wait is a flow edge too, and longest-path keeps it pointing
  down — a verify panel reads target → reviewers → judge), but a node's slot in its band follows
  its OPENER's slot when the opener is in the band above, else its earliest predecessor's, so a
  node opened by B that waits on A sits under B with the rest of B's team. Kept as its own command
  rather than folded into Tidy: bands answer "in what order does the work flow", Tidy answers
  "whose team is this", and on a pipeline the two disagree. Desktop + Server Edition identical
  (pure renderer, no new IPC); kanban N/A (a board shows cards, and geometry is exactly what a
  column layout discards); Mobile N/A (no canvas).
- **Arrange inside a group** (`arrangeGroupChildren` / `groupArrangeRefusal` in
  `state/workspace.ts`; the group-frame menu's **Tidy group** and **Arrange group by lineage**,
  ⌘K for the ONE selected frame, and the `arrange --group` control verb — one transform behind all
  three, pinned by `canvas/arrange-group.source.test.ts`) — the two canvas tidies one level down:
  organize a frame's own items, then size the frame to hold them. Four rules: **(1)** the members
  are the frame's DIRECT children, so a nested frame moves as one rigid unit with its own children
  untouched, exactly as Tidy canvas treats a top-level frame; `lineageLayers` /
  `arrangeByLineage` take a `containerId` for this, a rope is lifted to the MEMBER that holds its
  end, and a rope with an end outside the frame is dropped — the opener of a frame's whole team
  usually sits outside it and says nothing about the order inside. **(2)** the layout starts at
  the offset a fitted frame keeps its content at (`GROUP_PAD`, plus `GROUP_HEADER`), NOT at the
  children's bounding box: `fitGroupToChildren` re-anchors a frame to hug its children, so
  starting from the bounding box moves the frame to wherever its top-left child happened to sit,
  while starting from the content origin makes the fit re-derive the SAME origin and the frame
  only grows or shrinks to the right and downward (a frame that was off the grid still moves onto
  it, by under one cell, when snapping is on). That is also why the action calls no `fitAll` — the
  thing the user right-clicked must not slide out from under the cursor. **(3)** the fit walks UP
  the parent chain, innermost first (`fitAncestorChain`): fitting only the frame leaves a parent
  smaller than the child it holds, and `extent:'parent'` then clamps that child into an inverted
  range. **(4)** the refusal is the SAME array — a missing or empty frame, a lineage layout with no
  rope joining two of the children, or a frame whose contents already sit where the layout puts
  them (compared by geometry, so a second click writes no undo entry and no `project.json`); as
  with the canvas tidies the verdict is read off `nodesRef` BEFORE the write. The menu rows are
  DISABLED with the reason `groupArrangeRefusal` gives, the palette OMITS a refused entry, and the
  CLI replies that reason by name — one sentence, three surfaces. Desktop + Server Edition
  identical for the menu and palette (pure renderer, no new IPC); the control verb is desktop-only
  (see Grouping verbs); kanban N/A; Mobile N/A (no canvas).
- **Add menu** = bottom dock (`Dock.tsx`) `+`, mirrored by the pane menu and command palette.
  `lib/addMenuSpec` is the one source for WHICH kinds are addable, and since 2026-09 also for how
  the two `ContextMenu` surfaces GROUP them: `New terminal` · `New remote…` · the account-capable
  agents · `New agent ▸` · `New view ▸` · `Files ▸` · `Orchestrate ▸`, then the canvas actions. It
  replaced a flat 18-row list, on the rationale that ⌘K already makes every one of these
  searchable and the keybinding registry already carries a remappable command per agent and per
  node kind (`node.new*`) — so this menu does not have to be EXHAUSTIVE, it has to be FAST.
  Four rules hold it together, and the first is the one that is easy to get wrong:
  - **The submenu depth cap is STRUCTURAL.** `ContextMenu` renders a submenu's children with
    `if (child.type === 'colors' || child.type === 'submenu') return null` — a third level is
    dropped with no error and nothing on screen. Claude's and Codex's **account pickers are already
    level-two submenus**, so nesting either row behind `New agent ▸` would silently delete the
    account picker for exactly the users who have managed accounts. MEASURED, not assumed, in
    `components/ContextMenu.submenu-depth.test.tsx`; teach the component a third level and that
    test goes red so the pin can be reconsidered deliberately.
  - **Which agent rows stay at the first level is DERIVED, never a spelled-out agent id**
    (`isPinnedAgentEntry`): a row that IS a submenu (structural, per above) **or** whose agent is in
    `ACCOUNT_CAPABLE_AGENT_IDS` (`shared/agents/account-binding.ts` — the same list `boundAccountId`
    reads, so a third agent gaining managed accounts cannot light up one and not the other). The
    second half exists because rule one alone would move Codex in and out of the submenu as the
    user adds or removes accounts, and a menu that rearranges itself is a menu nobody can learn.
    A new builtin agent joins `New agent ▸` by itself; one that gains accounts is promoted by itself.
  - **`ADD_ITEM_GROUP` is a total `Record` over the kind union on purpose** — a new `AddItem` kind
    is a compile error until somebody routes it, instead of silently landing in one bucket forever.
    `remote` stays top-level because it is not an agent: burying the one SSH-session entry point
    under a menu named "New agent" puts it where nobody would look.
  - **Grouping is a rearrangement, never a filter, and a nested row keeps its REASON.** The rows
    still come from `contentAddItemsToMenuItems`, so `New worktree…` is greyed with
    `WORKTREE_SSH_HINT` inside `Orchestrate ▸` exactly as it was at the top level (the cap drops
    nested submenus, never a leaf's `disabled`/`hint`). Tests pin that nothing becomes unreachable.
  **Per surface**: the pane right-click and the sessions-sidebar project-header "+" share the
  grouped tree (`buildGroupedAddMenu`); the **group-frame** menu shares the agent half
  (`agentEntriesToMenuItems`) and keeps its own three content rows; the **Dock stays FLAT** (its
  popup is opened deliberately, it already omits terminal + remote, and its agent flyouts are
  bespoke JSX — grouping it means a second submenu implementation for crowding nobody reported);
  the **kanban column "+ New session" is NOT a consumer of the spec and never was** — its
  `KanbanCreateChoice` is a closed union of the kinds that become a CARD, so feeding it this list
  would offer kinds the board can never show. `addMenuSpec.surfaces.test.ts` pins all four.
  None of the add rows are in `ui-visibility`'s hide inventory (it covers the NODE menu and the
  terminal header), so grouping does not interact with hiding today; a future hideable add row
  would need the group's own row to disappear when it empties, which `buildGroupedAddMenu` already
  does — it emits no submenu for an empty bucket.
- **Edges** are all one React Flow type, `floating` (`canvas/FloatingEdge.tsx` over the pure
  `lib/floatingEdge.ts`): every family — ropes, context bridges, note links, subagent/loop card
  edges, trigger edges — is drawn between the midpoints of the two nodes' facing sides instead of
  fixed handle sides, so an edge to a node placed left of or above its source takes the short way
  round rather than looping across the canvas, and every edge using a side meets the node at ONE
  point (2026-09-03: enes's first try showed a hub with entries fanned along its whole top edge).
  Context and note links are the exception in one respect: they anchor only on the left/right
  sides (`data.anchor: 'horizontal'`), where the `link-out`/`link-in` drag handles are drawn. A terminal node's **eye** (`hide-fanout`, "Hide cards &
  connections") hides its subagent/loop cards AND every edge touching that node — display only:
  the links still authorise reads and an `--after` still waits. See the `--after` bullet under
  Canvas control for the rope model the eye hides.
  **Surfaces:** Desktop + Server Edition are identical (pure renderer + React Flow internals — no
  new IPC or bridge member); the kanban board is N/A (it shows cards, never edges); mobile is N/A
  (the transport protocol carries no edges).
- **Undo/redo**: debounced snapshot of the nodes array on settle (drag/edit), `pastRef`/
  `futureRef` stacks, ⌘Z / ⌘⇧Z + dock buttons. History resets per project load; skipped
  while typing in inputs/terminals.
- **Selection/pan**: box-select on left-drag (`SelectionMode.Partial` — touch to select);
  pan = middle-drag or trackpad two-finger (`panOnScroll`, `zoomOnScroll:false`); pinch
  zoom. Right mouse is free for the context menu.
- **Delete** (Delete/Backspace) opens `ConfirmDialog` before removing selected nodes.
- **Zoom chords** (`renderer/lib/zoomShortcut.ts`): **⌘/Ctrl+0 → `zoomTo100`** (actual size — what
  the browser AND Electron's default View menu already mean by that key) and **Shift+1 → `fitAll`**
  (the Figma/tldraw/Excalidraw "zoom to fit"). Matched on `e.code`, like the project-jump chord,
  which excludes `Digit0` so the two can never collide. The module is a PURE decision because both
  chords move the camera and a camera move here is not read-only — `onMove` → `markDirty` persists
  the viewport and casts it to the team session — so it refuses while the kanban board is up and
  while focus is in a text surface (input/textarea/contenteditable/Monaco/xterm, where Shift+1 is
  just the `!` key), and on auto-repeat (both actions animate; a held chord would restart the tween).
  Desktop ⌘0 does NOT arrive as a keydown: the default menu's `resetZoom` accelerator wins, so
  `main/index.ts` intercepts it in `before-input-event` and forwards `app:zoom-actual-size`, which
  re-asks the same refusals. Server Edition needs no intercept (no menu; Chrome/Firefox hand ⌘0 to
  the page) and stubs the subscription.
- **Per-terminal font size** (`renderer/terminal/terminal-font-zoom.ts`, issue #915). Opt-in
  `settings.terminalFontZoomKeys` (Settings → Terminal, default OFF). On, with a terminal focused:
  ⌘+ / ⌘− (Ctrl off-mac — exactly one primary, since Ctrl+− on mac is readline undo) step THAT
  node's `data.terminalFontSize` by 1 within the global field's 8–28 range; ⌘0 clears it back to the
  global `fontSize`. + and − match on `e.key` (German `+` key), 0 on `e.code` like the canvas chord.
  Before #915 ⌘+ / ⌘− did NOTHING (no menu zoom roles, React Flow's key zoom is off; only
  webview guests zoom on them) and ⌘0 in a terminal was claimed by main and then refused. Off, or
  with no terminal focused, every key behaves as before. The override is persisted per node
  (`normalizeTerminalFontSize` on both sides of `nodeStatesToFlow`/`flowToNodeStates`) and layered
  by `useXtermVisualSettings(projectId, fontSizeOverride)` — the SAME path for the canvas node and
  the card modal (`ModalSpawn.terminalFontSize`); the settings preview passes none. Font size is
  cell geometry, so `applyLiveOptions` reports `metricsChanged` and both surfaces re-fit and report
  the new grid exactly as for a global font change. **One writer:** both xterm key handlers and the
  forwarded desktop ⌘0 (resolved from focus via `data-font-zoom-node` on the xterm host) dispatch
  `nodeterm:terminal-font-zoom`; Canvas applies it (`nextTerminalFontSizeOverride`, `markDirty`).
  The toolbar / dock +/− buttons stay CANVAS zoom (they have no focused terminal to act on).
  Two review fixes: main forwards ⌘0 WITH `{meta, control}` and the renderer resets only on the
  platform chord (`forwardedResetMatches` — a mac Ctrl+0 keeps its old meaning); and under
  `terminalGpuRendering: 'shared'` a node whose size differs from the global one is held OFF the
  shared glyph canvas (`leavesSharedGlyphAtlas` → `glyphOff`) and paints its own pixels, because the
  shared atlas is rasterized for the global font and a grid's cell is fixed at `register`.
  Round 2: every xterm is BUILT from the effective visual (`visualRef`, both surfaces) — a refresh
  or offscreen revive recreates it in the same mount, where the live-options effect does not re-run;
  and keypad 0 resets only when it types `0` (Num Lock off it is Insert, and Ctrl+Insert copies).
  Round 3: Canvas also mirrors the step into the projects store for the ACTIVE project
  (`patchStoredFontSize`, same epoch guard as `commitActiveToStore`), because the Omni board builds
  its card modal's spawn from the store and would otherwise lag until the next autosave commit.
- **"Go to node" (`goToNode` → `frameNode`)** — the one camera-travel path (notification click,
  sessions sidebar, ⌘K jump, presence travel, minimap double-click, double-click focus).
  **It computes the viewport itself and applies it with `setViewport`. It must never go through
  `fitView`.** React Flow's `fitView` frames nothing when you call it: it sets `fitViewQueued` and
  the fit is RESOLVED LATER — from a subsequent `setNodes` (and only once EVERY node is measured,
  `nodesInitialized`) or from the next `updateNodeInternals` — against whatever `nodeLookup` holds
  by then. Its fit set is also filtered by `measured` (no `width`/`height` fallback in
  `getFitViewNodes`), so a set that comes out EMPTY collapses the bounds to `{0,0,0,0}` and
  `getViewportForBounds` parks the canvas **ORIGIN** in the middle of the screen at max zoom. On a
  canvas whose nodes sit thousands of px out that is the field report verbatim: right project,
  empty stretch of canvas, *sometimes*. **Cross-project** focus lands in that window every time —
  switch project → load its nodes → frame the target, all before the mount-time measuring has
  settled — and the second click always works, which is what makes it read as intermittent.
  The geometry is `renderer/lib/nodeFocus.ts`: the node's rect from React Flow's own measurement
  when it has one (`getInternalNode` — `measured` reaches OUR node objects one render later via
  `onNodesChange`, and `internals.positionAbsolute` also accounts for `extent:'parent'` clamping),
  else `nodeFitRect` from the PERSISTED size, resolving the group-parent chain. Then
  `viewportForRect`: **centred in the pane, and nothing else.** Framing a single focused node
  against the chrome-free rectangle was tried twice and is wrong both ways — centred IN that rect
  ("too far right on an ultrawide, half off-screen on a laptop") and centred in the pane then
  nudged clear of it ("still not in the middle") — because `.sessions-sidebar` is a 300px absolute
  OVERLAY and it is open exactly when this feature is used, so either rule pushes the node right by
  most of its width. The couple of dozen pixels that end up behind the sidebar cost far less than
  losing the centre. The free-rect solve (`solveFitFrame` / `solveFitPadding`) stays where it earns
  its keep: `fitAll`, which fits EVERY node and would otherwise tuck them under the dock.
  Unknowable size or no pane ⇒ the camera **stands still**.
  **ONE exception, and it is not a walk-back of that rule (issue #743): a MAXIMIZED node**
  (`isMaximized` — `data.premaxRect`, the flag `maximizeNodeToRect` writes and
  `restoreMaximizedNode` clears) is framed against the same rectangle `maximizeTargetRect` placed
  it in, through `viewportForNodeFocus`, which passes `measureMaximizeInsets(box)` to
  `viewportForRect` only for maximized nodes. `nodeFocus.policy.test.ts` exercises this shared
  Canvas decision for ordinary, maximized and restored nodes in both zoom modes.
  Maximize also measures `.controls-cluster` and `.dock` (#711): their screen rectangles reserve
  top/bottom space with an 8px gap, consuming the existing 24px margin first. Chrome outside the
  horizontally usable area contributes nothing. Menus and hover peeks never reserve a band. Both
  focus zoom branches use these same vertical insets; refitting observes the persistent chrome
  as well as pinned panels and compares all four insets. Zone snap retains its side-only policy. The trade-off above rests on
  ONE number — how much of the node ends up behind the panel — and for a maximized node that
  number is set by the PANEL rather than the node, **by construction**: maximize sized it to be
  *exactly* the free area, so centring it in the wider pane buries half the inset less the margin.
  Measured by the reporter on a signed v0.3.5 build with the sidebar pinned: an ordinary node lost
  33px, the maximized one 137px, and the camera drifted by `322 / 2 = 161` px on every "go to
  another node and back". Because the node is that rectangle minus two margins, centring it in the
  free area reproduces maximize's own origin (`marginPx + insets.left`) exactly — which is what
  makes this a fix rather than a second opinion about placement. It applies to BOTH zoom branches
  (the rectangle question is the same one; splitting it would be two rectangles again, which is
  the bug). With no pinned panels or overlapping persistent controls, `insets` is zero.
  A pane narrower than the panels over it falls back to the whole pane rather than solving against
  a negative width. `measureMaximizeInsets` reads the DOM only when framing a maximized node.
  **A second, narrower exception: a PINNED side panel (issue #854).** An ordinary node is still
  centred in the pane, but if that lands part of it under a pinned sessions sidebar or explorer
  (`measurePinnedInsets` — pinned only, never the hover overlay), `clearOfPinnedPanels` moves it
  the least distance that uncovers it (plus a 12px gap when there is room). A node too wide for
  the free area stays centred at a caller's zoom (a shift only swaps which edge is covered) and is
  fitted into the free area when the zoom is ours. This is not the rejected nudge of 5e8abfe7:
  that cleared the sidebar as an OVERLAY, which is open whenever the click comes from it, so every
  jump moved; pinning is the user's statement that the panel stays. The reporter measured 36–47px
  of a large node under a pinned 321px sidebar on every jump.
  `settings.focusZoomToNode` (Behavior, default ON) is the escape hatch for the rescale: off, the
  camera keeps the zoom `getZoom()` reports and only pans, and that zoom is passed through
  **unclamped** — it is one the canvas is already displaying, and re-clamping it to the framing
  range would rescale the view the option exists to leave alone. Two rules a refactor must not
  undo: framing goes through `frameNode` and nothing else (`canvas-wiring.test.tsx` pins that it
  contains no `fitView(`), and a "stands still" branch must never be "helpfully" replaced by a bare
  `fitView` — that IS the origin jump. `fitAll` still uses `fitView` deliberately: it is an
  explicit user gesture on a settled canvas and its fit set is every node, but it carries the same
  deferral, so do not reach for it from anything automatic.
- **Breadcrumb trail** (`renderer/lib/breadcrumbs.ts` — all the pure logic lives there) — every
  deliberate `goToNode` landing records a `NavStop` ({nodeId, at, note}) for the ACTIVE project, and
  **Cmd+[ / Cmd+]** (`canvas.goBack` / `canvas.goForward`, bound in `shared/keybindings.ts`) plus the
  two Dock buttons walk that trail; on a project activation a once-per-app-run **`ResumeCard`** offers
  the last few distinct stops ("resume where you left off") — **opt-in via
  `settings.showResumeCard` (Settings → Appearance, default OFF)**: while disabled the
  once-per-app-run slot is not spent, so enabling it later still shows the card on the next
  activation; the chords/Dock buttons work regardless. Load-bearing facts:
  - **The trail is MACHINE-LOCAL and rides `IndexEntryV3.breadcrumbs`, never `.nodeterm/project.json`** —
    the same tier as `viewport` / `defaultAccountId` / `capabilityAck`, for the same reason: a repo must
    not carry one person's camera history to everyone who clones it. `fileToProject` therefore ignores a
    `breadcrumbs` field found in the shared file (a forgery), and `projectToFile` never writes one.
  - **The cursor is not persisted either.** Only `list` rides the entry; `BreadcrumbState.index` is
    renderer-only and resets to the tip on activation. A step records no breadcrumb and rewrites no
    `project.json` — the only persistence it triggers is the ordinary `onMove` viewport persist
    (machine-local, same as any camera move; see the Zoom-chords bullet).
  - **Cap 20** (`BREADCRUMB_CAP`, oldest dropped) and a **3 s dedupe** (`BREADCRUMB_DEDUPE_MS`, so a
    re-triggered focus on the already-current node is a no-op — `recordBreadcrumb` returns the SAME
    object, which is the caller's skip test). Recording past a back-step drops the forward tail, exactly
    like a browser tab.
  - **`stepBreadcrumb` skips stops whose node is gone** (never lands on a dead entry; no reachable stop
    ⇒ `null` ⇒ the camera stands still), and `goToNode` **refuses to record ephemeral `subagent` / `loop`
    nodes**: they are merged into the `<ReactFlow nodes>` prop but never persisted (cleared on the next
    turn), so a breadcrumb for one is an id nothing can ever resolve, burning a slot forever.
  - The `note` is a **snapshot** taken at record time (agent nodes reuse the sessions sidebar's own
    `sessionStatusKind` + `STATE_LABEL` phrasing, preferring session name → node title → agent label), so
    a later state change never retroactively rewrites history.
  - **Surfaces:** Server Edition works as-is (shared renderer code + `WorkspaceStore`, which both
    shells boot — no new bridge member); mobile is N/A (no canvas, no camera); the kanban board is
    likewise N/A, and a project that activates ON the board neither shows nor spends its
    once-per-run resume card (it would sit invisible under the opaque overlay).
- **Canvas layouts** (`@shared/canvas-layout`, `renderer/lib/canvasLayout.ts` capture/apply +
  `renderer/lib/canvasLayoutView.ts` for the menu wording and the fallback camera; Dock button
  after "Fit view", mirrored in ⌘K) - a NAMED SNAPSHOT OF NODE GEOMETRY (position, size,
  collapse state) per project, so an arrangement built for the ultrawide can be restored after a
  day on the laptop screen. Load-bearing rules:
  - **Geometry only, and that is the whole safety story.** A restore never creates, deletes,
    renames, recolors, reparents or respawns a node, and never touches a tmux session - so the
    worst a bad layout can do is move things, which ⌘Z takes back (the debounced history effect
    picks up the `setNodes` like any other placement, which is why restore has no confirm and
    delete does).
  - **The two DESTRUCTIVE row actions confirm; restore does not, and the split is the undo stack.**
    ⌘Z replays node arrays, and a layout lives beside them rather than in them, so delete and
    "update to the arrangement on screen" are both unrecoverable the moment they run while a restore
    is one undo away. Update exists because the three-step alternative already worked (save, retype
    the name you are looking at, confirm the replace) and re-typing a name is friction, not a
    decision; it reuses `saveLayout`'s replace-by-id path, so `createdAt` survives, `updatedAt`
    moves, and the window size and camera are re-captured because you are updating FROM this screen.
    Both dialogs are built from `layoutIsShared` + `deleteLayoutMessage`/`updateLayoutMessage`
    (`canvasLayoutView.ts`), ONE definition of who else a destructive edit reaches: a folder project
    and an SSH project both keep their `project.json` where other people read it, and only a
    cwd-less canvas does not. Gating that on `cwd` alone (the first version) told an SSH project's
    user their edit was private when it was not. The layout is re-resolved AT CONFIRM TIME, never
    captured with the dialog: it is open for as long as the user looks at it, and a pull or a peer
    mutation can retire it underneath.
  - **The content half is git-shared, the camera half is machine-local.** `Project.layouts` rides
    `.nodeterm/project.json` beside `nodes` and `kanban`, because node geometry is already shared
    content in that file and a restore writes exactly those fields. `Project.layoutViewports` (this
    machine's camera per layout) rides `IndexEntryV3` in `workspace.json`. **The camera precedent
    (`viewport`, `breadcrumbs`) deliberately does NOT reach the geometry**: those are facts about
    where one person was looking, and nobody else's canvas moves when I pan - but where the nodes
    SIT is the canvas itself, and sharing an arrangement with the repo is the point.
  - **Restore rules** (`applyLayout`, pure + tested): a live node the layout does not mention is
    left exactly where it is, never tidied or stacked at the origin; an entry whose node is gone is
    skipped and counted, never resurrected; a frame the layout addresses gets the rect the user
    saved and is NOT re-fitted afterwards (the fit would overwrite it and the arrangement would
    drift a little on every restore), while a frame the layout does not mention but whose
    descendant just moved IS re-fitted, deepest first, so an out-of-layout child cannot be clamped
    by `extent:'parent'` into an inverted range. The whole layout lands in ONE transform as an
    explicit two-pass (resolve every target root origin, then emit) - a reduce over N placements
    re-fits an ancestor between two of them, so the second node is measured against a frame the
    first just moved and the result is differently wrong depending on array order. `collapsed` is
    restored with the CHROME height on the node and the real one in `expandedHeight` (the
    `flowToNodeStates` rule: the stored height is ALWAYS the expanded one, or a
    save-while-collapsed shrinks the node permanently). `premaxRect` and every non-geometry field
    ride the spread untouched - a restore is a placement, not a maximize.
  - **The camera is applied with `setViewport`, NEVER `fitView`** - the "Go to node" invariant
    above, and a canvas that has just been rearranged is exactly the unmeasured state where a
    queued fit collapses the bounds and flies to the origin. This machine's recorded camera wins;
    a layout restored here for the first time (a teammate's, or one saved on another machine) gets
    `layoutFramingViewport`, which is the core `framingViewport` rule rewritten locally because the
    renderer has no import path into `src/core` and because a layout's rects are ROOT-space, so
    unlike `CanvasNodeState` positions every entry anchors the camera.
  - **The window size is a LABEL, never a matcher.** `CanvasLayout.window` is the author's window
    at save time, shown in the menu so the user can tell the two arrangements apart. Nothing
    auto-applies a layout on a display change: the file travels, so matching on it would pick a
    stranger's monitor for this user's screen - and a canvas that rearranges itself when you plug
    in a projector is worse than one that does not.
  - **Cap 20** (`CANVAS_LAYOUTS_CAP`; a full node-geometry list in a file that is committed and
    cloned), name capped at 60, and **both sanitized on BOTH serializer seams** (`fileToProject`
    on the way in, `projectToFile` on the way out) - the same two-seam rule `normalizeNodeIcon`
    and `sanitizeNodeTriggers` follow, because live node data is reachable by a peer canvas
    mutation and whatever we write is what the next machine trusts. `sanitizeLayouts` DROPS a
    layout whole rather than repairing it: a repaired layout no longer describes the arrangement it
    is named after, and a non-finite coordinate is a white-screen crash (`adoptUserNodes`
    dereferences the position unguarded) that `JSON.stringify` then writes back as `null`.
  - **Downgrade note:** a build older than this one drops `layouts` on its first save, because
    `projectToFile` builds an explicit object and simply does not know the field. The layouts are
    gone from that checkout's file until someone on a current build saves again; nothing else
    breaks, and the machine-local cameras are pruned to match on the next load.
  - **Surfaces:** Desktop full; **Server Edition full with NO new IPC** (pure renderer plus
    `workspace.save`, which both shells already boot); **relay tabs REFUSED with the reason** -
    the Dock button is disabled with "Layouts are managed on the host" and the ⌘K entries are
    omitted (the palette has no disabled row), because a relay tab is a live connection to another
    machine and never a workspace on this disk; kanban N/A (a board shows cards, and geometry is
    what a column layout discards); mobile N/A - *nodeterm mobile* attaches to tmux sessions over
    the transport protocol and has no canvas, so surfacing a layout means extending that protocol
    (follow-up in the iOS repo).
- **Directional focus (⌘←/→/↑/↓, `node.focus*`)** — the multiplexer gesture (Ghostty `goto_split`,
  tmux `select-pane -L`) on a canvas with no split tree: `lib/directionalFocus.ts` ranks candidates
  by geometry (same-row/column overlap first, then diagonal with a sideways penalty; no wrap). The
  ONE decision — where to land AND how — is the pure `planDirectionalMove`, and the "how" has two
  answers that must not be merged: on the canvas the move **travels** (`focusNodeById`: frame +
  keyboard + read-ack), origin = the node the keyboard is in, else the selection, else the first
  press ADOPTS the node nearest the view center. In **focus mode** (⌘⇧F, issue #78) the move
  **swaps the focused node** (`useFocusNode.focus(next)`) — the flow pane is `display:none` there,
  so a travel would frame a node on a 0-sized pane (the origin-jump bug) while the user kept
  staring at the old terminal; before this, moving between two focused terminals was ⌘⇧F, ⌘→, ⌘⇧F.
  Three details carry it: the origin is the FOCUSED id (the reparent detaches the node root from
  its `.react-flow__node` wrapper, so the keyboard origin reads null there); candidates are
  TERMINALS only (the one kind focus mode can show — `focusTargetId`); and the keyboard is handed
  over explicitly (`useTerminalFocus.request`), because the reparent gives focus back to whichever
  xterm had it, i.e. the OLD node. Selection follows the swap so leaving focus mode lands on the
  node the user was in. An edge with nowhere to go is a CLAIMED no-op in both modes — declining
  would hand ⌘→ to the terminal, which is not "nothing".
- **Command palette** (`CommandPalette.tsx`): ⌘/Ctrl+K; `Canvas.buildCommands` (create,
  switch project, jump to node by title/tag, open file…).
- **Explorer** (`ExplorerPanel.tsx`, 🗂 / ⌘⇧E): lazy file tree of the active project `cwd`
  (`fs:list`); click a file → opens an editor node; right-click → Copy Path / Reveal /
  **New File… / New Folder…** (empty-area right-click targets the root; SSH projects create on the
  host). Canvas pane right-click and ⌘K also expose **New file…** (creates under the project cwd,
  opens an editor node). These use `mkdir` + `exists` added to `FsApi`/`SshFsApi` across
  desktop/server/SSH (`core/fs-ops.ts`, `main/ssh-fs.ts`). **Relay tabs are NOT degraded**: a
  relay tab's `fs` routes through `bridge/relay-api.ts:86` (`fs: files.fs`) → `buildFilesApi`'s
  `IPC.fsMkdir`/`IPC.fsExists` (`bridge/ws-bridge.ts:474-475`) → `core/fs-handlers.ts:43-44` →
  the real `fsOps.makeDir`/`fsOps.pathExists` on the peer's core, so both verbs are live there.
  What genuinely still lacks them is the legacy PHONE vocabulary
  (`main/remote/host-service.ts`), whose `handleFs` switches on `fs.list`/`read`/`readBinary`/
  `write` and nothing else, so `fs.mkdir`/`fs.exists` fall through to the dispatcher's
  `Unknown method` **rejection** (line 695) rather than degrading to `false` — a different
  dispatch path (`relay-host.ts:22-24`) from the relay tab above.
  Expanded dirs **persist per project** across drawer close + app restart (`state/explorer.ts`
  zustand store, localStorage `nodeterm.explorerExpanded`). The header pin docks it like the
  sessions sidebar (`lib/explorerPin.ts`, `nodeterm.explorerPinned`, default off): overlay
  click-outside closes the modal only, and a pinned overlay is `pointer-events: none` so it
  cannot steal canvas clicks. × is a transient hide and does not clear the pin. Pinned z-index
  is 26 so the tree stays visible on the kanban board with the controls cluster. Desktop +
  Server Edition (personal `localStorage`). Mobile companion: N/A — no explorer there. Source
  Control stays a modal.
- **Source Control** (`main/git-service.ts` system `git` + `gh`, `SourceControlPanel.tsx`,
  ⎇): file-level **stage/unstage** (+/−), **discard**, click a file → **diff node**,
  **branch switch/create**, commit (message box at top) + push / sync / publish, **gh
  sign-in** banner (runs `gh auth login` in a new terminal via `initialCommand`), recent
  commits. **AI commit message** (✦ Generate) and **AI terminal naming** both use
  `main/commit-message.ts`: a BYO local agent CLI (claude/codex/custom) spawned read-only on
  the staged diff / captured terminal output (no built-in model); agent + extra prompt in
  Settings. The panel operates on a **selected scope**, not on the project cwd — see Worktrees.
  **Open latency + reopen**: `status()` must never await `gh auth status` — it hits the GitHub
  API (~700ms) and used to hold the panel's first paint hostage; `ghAuthedSwr()` returns the
  cached answer and refreshes in the background (the accurate `ghAuthed()` is still awaited on
  the publish flow). Status/history live in the per-cwd `state/scmCache.ts` store (same pattern
  as `scmDraft`), so the close→reopen cycle paints the last-known data instantly while the
  mount refresh replaces it silently — do not move them back into component `useState`.
  **Branch observations** (`state/gitBranches.ts`) are shared by Source refreshes, Sessions project
  headers and existing worktree status polls. They are scoped by GitApi identity + exact cwd + SSH
  project id, never persisted, and latest-started reads win over late responses. Sessions resolves
  each project's owning session (including background projects); its header reads the project cwd,
  while a group header reads only its worktree path. No new timer: sidebar mount/reopen/cwd changes
  read local checkouts once, Source operations refresh as before, and worktrees keep their existing
  gated cadence.
  SSH headers only observe Source refreshes: background SSH connections are not git-routable.
  Local header probes also skip a cwd claimed by the active SSH route.
  The branch projection does not replace worktree staleness/ownership decisions or SCM history.
- **Worktrees** (bound to **group frames**) — a git worktree binds to a group node
  (`data.worktree: GroupWorktree {repoPath, branch, baseRef, path, createdByApp}`, persisted), and
  every node created inside that frame inherits the worktree path as its `cwd`
  (`cwdForNewNodeIn`) — the frame *is* the binding, so an agent per branch is just a group per
  branch. Creation is **one step** — **"New worktree…"** from the pane menu / command palette /
  Source Control — with the repo resolved from the project cwd via `git.repoRoot()` and existing
  worktrees listed for adoption. (Both git IPCs existed before this feature and had **zero**
  renderer callers, which is why it was unusable: the dialog's repo field was always empty and had
  to be typed by hand. Don't re-strand them.)
  - **Default location** — `settings.worktreePathTemplate` is a machine-global Behavior setting,
    expanded only by `shared/worktree.computeWorktreePath` for both the dialog and canvas-control
    CLI. It is relative to the repo root and supports `$repoName` (`$reponame` /
    `$defaultFolderName` aliases) and `$branch` in bare or `${…}` form. If branch is omitted, its
    safe slug is appended automatically. The shipped `../${repoName}.worktrees/${branch}` keeps
    worktrees beside — not nested inside — the main checkout. There is no general project-settings
    surface today, so the setting is intentionally global rather than hidden in a one-off menu.
  - **One create-and-bind** (`renderer/lib/worktreeCreate.ts`, `createBoundWorktree`) — the New
    worktree dialog, the `open-worktree` verb and the issue card's "Start with agent in a new
    worktree" all create through it: `git worktree add` (a REJECTED call becomes a failure, never a
    throw out of the caller), then `attachWorktree`. The frame's place is asked only once git
    succeeded. `projectId` opts in to the "the canvas moved on during the await" refusal: the dialog
    and the issue action pass it; `open-worktree` does not, and still binds to whatever is on screen
    when git returns (unchanged, and a known gap). `git worktree add` is reached from ONE place
    (`worktreeCreateDeps`), pinned by `canvas/issue-worktree.source.test.ts`. Three same-tick rules
    the issue action rests on: `attachWorktree` writes the new frame into `nodesRef` beside its
    `setNodes`, so a caller can open a node INTO a frame it just made; it closes the frame's setup
    gate from the bind (`markGroupPending` before the `sharedPaths` materialize, released in a
    `finally` once `startWorktreeSetup` took its own count), so a node opened into it at once holds
    its launch — the hold is ONE rule, `setupHoldGroup`, shared with the control opens' `armAfter`;
    and `addAgentNode` parents the node BEFORE `setNodes`, never inside the updater, because the
    updater runs at render time and a zustand-flushed SyncLane render may already have mirrored
    `nodesRef` back to a list without the fresh frame (the `nodesEpoch` lesson).
  - **Where a worktree may land** (`@shared/worktree-location`) — `worktree.basePath` can come from
    `.nodeterm/settings.json`, the git-SHARED project settings file, i.e. written by anyone who can
    commit to the repository, and `git worktree add` writes the whole tree there. Pointed at
    `../../.claude/skills`, the issue card's one click checked the repo out into
    `~/.claude/skills/issue-N-…/` and a root `SKILL.md` became a skill in every Claude session. Two
    layers, both for ALL create paths (dialog, `open-worktree`, issue card):
    `sharedWorktreeLocationRefusal` (renderer) refuses a location the SHARED file produced unless it
    stays inside the folder holding the repository — a sibling that is not hidden, or anywhere in
    the repository but its `.git` — and names the fix (a local override in Project Settings). It
    judges only the path that setting derives for the branch: a path the person typed in the dialog
    or passed as `--path` is theirs. `sharedBasePathOf` is the one reading of provenance (`source:
    'shared'`). `open-worktree` refuses before its dry run. The core backstop
    (`core/worktree-target.ts`, in `GitService.worktreeAdd`, so relay and browser clients pass it
    too) works on REAL paths, because a symlink committed into the repository defeats any lexical
    rule: never inside the repository's `.git`, and never REDIRECTED into a hidden folder directly
    under the home directory — a location that names such a folder outright (a person's own
    `/home/me/.worktrees`) is allowed, so the backstop is not a blanket refusal.
  - **A worktree per GitHub issue** (`@shared/issue-worktree`) — "Start with agent in a new
    worktree ▸" on an issue card and its summary modal: branch `issue-<N>-<slug>` at the templated
    path, off the SAME base the New worktree dialog defaults to (`effectiveWorktreeBaseRef`: the
    project's base-ref override, else the MAIN CHECKOUT's current branch — not `origin/HEAD`; a main
    checkout parked on a feature branch forks from it, so the success notice names the base), a
    frame titled `Issue #N`, and the agent opened inside it with the same ref-only prompt and
    `issueRef` as "Start with agent" (one `issueStartPrompt`, one `fileIssueSession` for both). The
    frame's binding is what links a pull request from that branch to the session card. Whatever
    `addAgentNode` would refuse (canvas not the active project's, an unusable Codex account) is asked
    BEFORE git runs (`agentCreateRefusal`, same functions and wording) — a refusal after it would
    leave a fresh worktree with no agent. The agent's launch rides `pendingLaunch` held on the
    frame's setup gate, so it shows QUEUED for the moment the setup ack takes even when the project
    has no setup script. **The title is attacker-controlled**: the slug is
    an allowlist `[a-z0-9-]` (lower-cased, NFKD with marks stripped so `café` → `cafe`; every other
    script, lookalike, bidi or zero-width character is dropped), capped at `ISSUE_BRANCH_SLUG_MAX`
    (40) and cut back to a word boundary, and `issue-<N>` alone when nothing survives; the name only
    ever reaches git as one argv element, and the tests run the real `git check-ref-format --branch`
    over the hostile set. **Nothing on disk is overwritten**: `planIssueWorktree` (filesystem only
    through an injected probe; a probe that REJECTS reads as "taken" — the app's `fs.exists` folds a
    stat error into `false`, and git refusing a non-empty folder is the backstop there) offers REUSE
    of what the issue already has — a frame on this canvas bound to `issue-<N>` / `issue-<N>-…` (open
    the agent in it), an unbound worktree of the issue (adopt it, `createdByApp: false`), or the exact
    branch existing but checked out nowhere (check it out, under the branch's OWN spelling — the
    match is case-insensitive, git's lookup is not; the new folder is the app's, so `createdByApp`
    is true exactly as the dialog's "Existing branch" mode sets it) — beside the next free `-2` …
    `-20`; a name or folder that is merely taken moves to the next suffix and the notice says why.
    Never the main checkout, never a prunable registration, and never a frame bound to ANOTHER
    repository (`issueWorktreeFrames` filters by `worktree.repoPath`, as the worktree store does — a
    foreign or hostile frame on an `issue-<N>-…` branch would otherwise be the preselected "Reuse").
    A branch that exists only on a REMOTE (`status.remoteBranches`, as fresh as the last fetch) is
    TAKEN, never checked out: a same-named local branch would diverge from it, its push would be
    rejected, and #1008's branch link could point at someone else's pull request. Reuse is
    re-checked at the dialog's click (a frame of this repo on that folder now, else a worktree git
    still lists), and one `runExclusive` key per issue covers the planning AND a dialog-confirmed
    create, so a second click cannot race the first for the same `-2`. The reuse-or-new dialog is a
    tracked confirm (`confirmFlags.issueWorktree`, read by `confirmBusy()`): it never opens over
    another confirm, and an agent's destructive verb is refused while it is up. Disabled WITH its reason on a relay tab, an SSH project, a cwd-less
    project and a folder with no repository (`issueWorktreeRefusal`). **There is no `--worktree`
    flag**: an agent composes `open-worktree --branch issue-<N>-<slug>` then `open-agent --group
    <groupId> --issue #N`, and both agent bodies render that convention from `issueWorktreeBranch`.
    A flag was judged not worth it: the two calls already reach the identical end state; the
    "worktree already exists" question needs a person's answer, which an agent gets from `list`
    instead; the slug needs the issue title, which the control dispatch does not hold reliably (only
    a subscribed board does), so the flag would name one issue's branch two ways; and a second copy
    of `open-worktree`'s surface (`--base`, `--path`, dry run, setup holds, refusals) inside
    `open-agent` is the drift this file warns about. Surfaces: Desktop and Server Edition (the
    whole path is renderer + the existing git/fs/worktree bridges); a relay tab is refused (above);
    the Omni board has no issue lanes; Mobile N/A like every worktree affordance.
  - **One store, one poller** — `renderer/state/worktrees.ts` is the **only** caller of the worktree
    /status *read* IPCs (`git.repoRoot`, `git.worktreeList`, `git.status`); the group chip, the
    creation dialog and the Source Control panel all read that store. Three independent pollers would
    triple the `git` subprocess load and drift out of sync. It is **epoch-guarded** (a project switch
    bumps the epoch, so a stale in-flight refresh can never overwrite the newer project's
    `repoRoot`/orphans — worktrees are *created* under `repoRoot` and orphans are offered for
    *deletion*) and **fails open**. Exactly **two** direct `git.status` reads live outside it, both in
    `Canvas.tsx` and both deliberate: the one-shot probes on the **Remove** confirm (the dirty-file
    count in the warning) and on **↪ Move into worktree** (staleness only arrives by poll, so the
    directory is re-checked immediately before an irreversible session kill). Two more one-shot
    reads take only the local BRANCH list: the New worktree dialog's dropdown and the issue action's
    planner (so a taken name is seen before git refuses it). Anything recurring belongs in the store.
  - **Scoped Source Control** — the panel operates on a selected `ScmScope` (the main checkout or a
    bound worktree). A worktree scope's **id is its group node id**, which is what lets the canvas
    selection preselect it. `scmScopes` / `defaultScmScope` / `selectedScmGroupId`
    (`shared/scm-scope.ts`) decide the list and the default. The panel derives its `cwd` **once** so
    its ~49 call sites follow — and every Canvas callback it invokes (`onOpenDiff`,
    `onOpenCommitDiff`, `onExplainCommit`, `onRunInTerminal`) must take the **scope's** cwd, never
    the project's.
  - **Reconciliation** (`shared/worktree-reconcile.ts`) — bindings are reconciled against `git
    worktree list`: a worktree deleted outside the app makes its group **stale** (chip reads
    "· missing", Merge/Remove hide, ↪ hides, and nothing spawns into the dead path — Unbind is the
    only action, and it takes the dead cwd off the children with it); a worktree bound to no group
    is an **orphan**, recoverable from the creation dialog.
  - **Two non-obvious facts the code depends on — do not "simplify" these away:**
    1. `git worktree list --porcelain` **keeps listing a worktree whose directory was deleted
       behind git's back**, tagging it `prunable` — and that tag only exists on **git ≥ 2.36**. So
       `worktreeList` additionally **stats** each path through an injected `pathExists` seam
       (`prunable: e.prunable || !pathExists(path)`; `git-service` wires `fs.existsSync`), or the
       whole stale/orphan story silently fails on the Server Edition's own target platform (Debian 11
       / Ubuntu 20.04 ship git 2.30).
    2. **A failed git read is never evidence of absence.** `listWorktrees` returns `{ok, entries}`
       so "git failed" (spawn EAGAIN, NFS hiccup, corrupt index) stays distinguishable from "git
       listed nothing" — a transient failure must never be read as "the worktree is gone", at any
       layer (`ok:false` changes no facts). Staleness from the status poll likewise needs **two
       consecutive** failed reads (`WORKTREE_STALE_STRIKES`), and the streak is scoped per project
       so a there-and-back tab switch cannot forget it.
  - **Path identity** — compare worktree/repo paths through `worktreePathKey` (`shared/worktree.ts`),
    never by string: git prints `C:/r/wt` on Windows while a typed binding says `C:\r\wt` or `c:/…`.
    The key folds separators + case only for a Windows-SHAPED path (backslash, drive letter, UNC);
    a POSIX path keeps exact case — keyed on shape because this module runs in the renderer, whose
    platform is not the core's. The removal guard also refuses a bare drive root.
  - **Destructive safety** — `createdByApp` gates removal: nodeterm deletes only worktrees it
    created; one the user merely **adopted** unbinds by default, and deleting its directory is an
    explicit opt-in that **defaults to off** (its branch is kept either way).
    `isDangerousWorktreeRemovalPath` refuses a path that is the repo, `$HOME`, `/`, or an ancestor
    of any of them, on **every** removal path. **Merge** always confirms — it merges into the base's
    *working tree* (`decideMergeStrategy`: merge in the base's checkout when it is clean, else a
    `fetch . branch:base` when the base is checked out nowhere, else blocked) — and its push to
    `origin/<base>` is disclosed in that dialog and **opt-in, default off**: a push to origin cannot
    be politely undone.
  - **Every path that drops a bound group goes through unbind** — Unbind, Remove, **Ungroup** and
    **Delete** all route through `releaseWorktreeBinding`, the one place that knows what a dropped
    binding owes: `displacedByWorktree`'s descendants (terminals whose cwd sits inside the
    worktree) get that cwd taken off them, and git's registration gets a `pruneOnly` prune. Ungroup
    and group-delete *keep* the children, so skipping this left a **dead cwd persisted in
    `project.json`** — invisible until a reboot cold-starts the terminal into a directory that is not
    there — and left a stale registration that makes a later `worktree add` at the same path fail.
  - **SSH projects: not supported in v1** — every affordance is shown **disabled with that reason**
    (a silently-missing row teaches nothing). The gate asks whether the node is a **remote session**
    (`data.ssh` / `data.sshRemoteTmux`) or the project is an SSH project — **not** `data.remote`,
    which only *relay* nodes carry: guarding the wrong field let a live remote tmux session be
    killed into a local path that does not exist on the host (`isRemoteSessionNode` asks about all
    three). The ops themselves **refuse** a remote repo (`git-service.isRemoteRepo`, via
    `resolveGitRemote`) rather than guess: the `git` executor routes over the project's ControlMaster
    while `pathExists` is a **local** `fs.existsSync`, so answering would stat the wrong machine and
    report *everything is gone* — a refusal is a plain failed op and, crucially, never `worktreeGone`,
    so nothing is destroyed on a bad guess. Real support needs the worktree path to derive from the
    connection's cached `remoteHome` and `pathExists` to stat the **remote** fs (a `test -e` over the
    ControlMaster).
  - **Mobile companion: not applicable in v1** (the three-surfaces call, made deliberately). A
    worktree binds to a **group frame** on the canvas, and *nodeterm mobile* (separate repo, `nodeterm-ios`)
    has no canvas — it attaches to tmux sessions over the `TerminalTransport` protocol, which carries
    no group/binding concept at all. So there is nothing to degrade gracefully: a worktree's terminals
    are ordinary tmux sessions and mobile already reaches them, it simply cannot see that they belong
    to a worktree. Surfacing the binding (a read-only "worktree: <branch>" label per session, say)
    would mean extending the transport protocol — a **follow-up in the iOS repo**, not this branch.
    Creation/merge/remove stay desktop+server only: they are destructive git operations, and a phone
    is the last place to confirm one.
  - **Known follow-up** — the Explorer tree and the ⌘K file index stay scoped to the **project cwd**,
    so a bound worktree's files are not browsable/searchable from them (its terminals and editor
    nodes work fine). Deliberately out of scope here: both index a single root, and making them
    scope-aware is the same "which checkout am I looking at?" question Source Control already answers
    with `ScmScope` — that is the seam to reuse when it is built.
- **Kanban view** (`components/kanban/KanbanView.tsx`; toggle is a Trello-style icon ON the
  **active project tab** (`.tab__board-toggle`, after the name, before the caret — the view
  belongs to the project; earlier homes were the tab-strip end, then the controls-cluster,
  both rejected in use) plus ⌘⇧B / ⌘K): per-project
  full-page board OVER the canvas. It is **dual-source** (PR #90): SESSION cards are the project's
  session nodes (React Flow type `terminal`), derived LIVE from the canvas nodes
  (title/color/kind/agentId), with RUNNING / NEEDS YOU badges + unread dot from the default
  `agentStatus` store (click = back to canvas + `focusNodeById`); GITHUB cards are the repo's
  issues (`GitHubIssueCardView` via `state/githubIssues.ts`, opened through
  `GitHubIssueSummaryModal`, a column move that closes/reopens the issue confirms first). A
  **source filter** (`KanbanSourceFilter`: All / Issues / Pull requests / Sessions) and a transient
  per-board **label filter** narrow what shows.
  **PULL REQUEST cards are harvested from the issue poll, not fetched** (2026-09-01, read-only):
  `/repos/{repo}/issues` returns pull requests too — `client.listIssues` used to `continue` past
  them — so keeping them costs ZERO extra requests and inherits the incremental `since` watermark,
  the heartbeat ETag (below), the 60 s poll and the cache snapshot the issue lane already has. The alternative was
  measured and rejected: **`/repos/{repo}/pulls` IGNORES `since`** (a day-old `since` returned the
  same 100 items as none), each item is ~25 KB against ~7 KB, and it would be a second
  ETag/paging/cache lineage — for `head`/`base` and nothing else (mergeable, reviews and checks are
  per-PR legs either way). The harvest's fields are `draft` and `pull_request.merged_at` (**the only
  thing separating merged from closed** — both report `state: 'closed'`), plus the labels/assignees
  the issue shape already carries. There is **no `head`** in that payload: `GitHubPullMeta.head`
  stays undefined until something asks per branch (`/repos/{repo}/pulls?head=owner:branch`), which
  is one request per question rather than a field on every poll.
  Three rules the harvest brought with it: **(1)** one snapshot now holds both kinds, so
  `GitHubIssueQuery.kind` (absent = `'issue'`) is what keeps the issue lane's items and counts
  byte-identical to before — and `moveIssue` refuses a PR by number (`invalid-target`) because the
  two share a number space and its membership check alone would hand one to a write path that
  cannot serve it. **(2)** `MAX_ISSUES` / the 64 MB bound are shared, so an overflow **evicts pull
  requests first, oldest-updated first** (`evictPullsToFit`) and marks the snapshot
  `pullsTruncated`; the existing `incomplete` read-only path fires only if the issues ALONE still
  miss the bound. A repository large enough to overflow degrades in the new half, never in the
  board it already had. An incremental pass carries the flag forward — it never re-fetches what it
  dropped, so only a full reconciliation may clear it. **(3)** the `pulls` source is `readOnly` in
  the registry: no drag, no move control, and its page reports `readOnly: true` on the wire rather
  than trusting every consumer to remember.
  **Sync foundation: what a poll costs, what a failure means, what a write needs** (2026-09-28,
  `core/github/*`; Desktop and Server Edition identical — all of it is core). Seven rules:
  **(1) A poll that finds nothing spends nothing.** Before each pass, `client.issuesHeartbeat` asks
  for the single most recently updated item (`state=all&sort=updated&direction=desc&per_page=1`)
  with `If-None-Match`; a 304 skips the scan. MEASURED against this repo (read-only `gh api`):
  twenty 304s moved `x-ratelimit-used` by **0**, the next 200 by 1; five plain 200s by 5. The `since`
  scan could never do this itself — `since` moves every pass, so its URL (and any ETag) never
  repeats, and the snapshot's `etags` map was declared and always written empty. The validator is
  the one read BEFORE the scan (a change landing mid-scan stays "new"), it is persisted in
  `snapshot.etags.heartbeat` (a restart does not pay a full read), and a 304 NEVER skips a full
  reconciliation (a deletion or transfer does not move the top item) or an incomplete repository.
  It covers pull requests by construction: same endpoint, same `updated_at` the scan filters on.
  **Only a completed scan advances the incremental cursor** (`lastSuccessfulRefreshAt`, the next
  scan's `since`): a board write folds its one confirmed issue into the snapshot and leaves the
  cursor alone. It used to set it to the write's time, so a third party's change landing between the
  last scan and our write fell outside the next `since` window until the daily full pass.
  **A 304 still prompts the board to re-read** (an empty delta, served from the local cache, no
  GitHub cost) exactly as every successful refresh always did: a page is not only issues — read
  only, the mapping approval and the completion column are derived by the host at query time, and
  the first version, which emitted nothing on a 304, left a board read only after its user
  approved the mapping (review of #1001). Approve and revoke also notify the project's open boards
  at once (`service.notifyProject`). **Unknown `state_reason` values decode as no reason**: GitHub
  added `duplicate` (one of cli/cli's last 100 closed issues, measured 2026-09-29), and the strict
  decoder failed that repository's whole scan as malformed — it never synced.
  **The credential check is conditional too** (`createTokenValidator`): every poll re-resolves the
  credential (30 s memo, 60 s poll), and each resolve was an unconditional `GET /user` — one real
  request per poll even after the heartbeat. With `If-None-Match` an unchanged identity is a free
  304 (MEASURED: ten conditional reads, +0), and a bogus token presenting a valid validator still
  gets 401. Idle polling now costs zero quota. **(2) The budget is read from every response and
  acted on before GitHub refuses.** `client.onRateLimit` reports `x-ratelimit-*` from 200, 304 and
  errors alike to `GitHubRequestCoordinator.noteRateSample`, keyed by the credential's identity
  (the host builds the client from token + userId); within one window the LOWEST reading wins. A
  spent `core` budget blocks new requests at once. Below `backgroundFloor(limit)` = max(100, 10%)
  the BACKGROUND poll stops until the window resets — the budget is the whole account's (`gh`, the
  browser, other tools) — while a refresh the user asks for still runs within its own floors.
  **Every wait is capped** (`MAX_RATE_WAIT_MS`, 10 s in TOTAL): past it the request is refused at
  once with its retry time, instead of holding one of four read slots and an IPC call for up to an
  hour. The page and the Settings status carry the `throttle`; both say "held until HH:MM"
  (`lib/githubSyncStatus.ts`), and subscribers are prompted once per deadline, not per skipped
  minute. Do NOT add a `/rate_limit` probe: measured for the same token in the same second it
  answered 5000 left / used 0 with a different reset time than the response headers (4968 / 32) —
  the headers are the truth. **(3) Throttled is not signed out.** `classifyGitHubFailure`
  (`core/github/failure.ts`) is the ONE classifier: only a 401 or a non-rate-limit 403 is
  `unauthorized`; network, timeout, 5xx and malformed bodies are `unreachable`; limits are
  `rate-limited`. Token validation is tri-state (`TokenValidation`); the resolver keeps the last
  credential GitHub vouched for — SAME token only — through an unknown answer, and with none throws
  a `GitHubReachabilityError` rather than returning the null that every caller reads as "sign in".
  Auto does not fall through to the saved token when the CLI's token merely could not be checked
  (that would switch identities for the length of an outage). **`gh auth status` is never run**:
  measured on gh 2.45 with GitHub unreachable it printed "The token in hosts.yml is invalid";
  `gh auth token` only reads the local store and our own classified `/user` check decides.
  Settings says "GitHub could not be reached to check the sign-in" and keeps the last confirmed
  sign-in on screen; `saveToken` refuses an unchecked token without calling it invalid.
  **(4) A close carries its reason.** `UpdateIssueInput.stateReason`: the close confirm offers
  Completed / Not planned (Completed preselected — GitHub's default), a reopen sends `reopened`.
  It rides ONLY with a state change (the "send `state` only when it changes" rule stands), the
  client refuses a reason of the wrong kind, and a close GitHub recorded with a different reason is
  not reported as confirmed. **(5) Writes need an approval that covers the column mapping.** The
  mapping (which label a column applies, which column closes) is in the git-shared project.json,
  so a pulled commit could re-aim writes under an approval given for something else. An approval
  records `githubMappingDigest(repository, completionColumnId, columnMappings)` — column ORDER and
  titles excluded (they change nothing GitHub sees; `config.revision` includes order and would make
  every column drag revoke writes). Moves and "Create missing labels" require the digest to match
  (`context.mappingApproved`); READS stay on the repository approval, since the mapping only decides
  what a write does. A mismatch makes the board read only and says why (`page.mappingNotApproved`);
  Settings offers "Approve column labels". **Upgrade:** an approval from before this change has no
  digest — it keeps reading and must be approved once more before the board writes. Pinning the
  on-disk mapping at first load was rejected: it would silently trust whatever a `git pull`
  delivered between the upgrade and that load. **(6) Revoke deletes the cache.** The plaintext
  issue cache (bodies included) is removed by the same bounded path as "Clear cached data", AFTER
  the revoke is recorded — a failed delete is reported (`revoked-cache-kept`), never left approved.
  The cache file is per (identity, repository), so another project on this machine bound to the
  same repository re-fetches too. **(7) Every client that leaves releases its subscription.** The
  service polls every 60 s per subscribed repository; the desktop window now releases on `closed`,
  `render-process-gone` and `did-navigate` (`main/renderer-client-release.ts` — not
  `did-start-navigation`, which also fires for a navigation the guard blocks), beside the relay
  peers and Server Edition sockets that already did. **Mobile: N/A** — the phone's board carries
  session cards only (the `githubIssues:*` channels are served to relay TABS, never the phone
  dialect), so nothing there can read a throttle as signed out; surfacing GitHub cards on the phone
  would need this whole contract carried over the relay.
  **Pull request CI, mergeability and links** (2026-09-29; core `graphql-pulls.ts` +
  `pull-status-tracker.ts`, shared `github-pull-status.ts` + `kanban-pull-links.ts`, renderer
  `lib/pullLinks.ts` / `lib/pullAutoMove.ts` / `lib/pullChase.ts`). The issues harvest cannot say a
  PR's head, checks or mergeability, so ONE GraphQL read per repository adds them: every open PR's
  `headRefName`/`headRefOid`/`isCrossRepository`/`isDraft`/`mergeable`/`mergeStateStatus`, the head
  commit's `statusCheckRollup`, `closingIssuesReferences`, plus the 30 most recently merged/closed
  PRs (so a branch link survives the merge). MEASURED on this repository (60 open PRs): **1 point**
  of the separate `graphql` budget, ~18 KB; the per-PR checks read (modal open only) is also 1.
  **When it runs:** after a heartbeat that reported a change, on a user refresh, on the first
  heartbeat of an app run, when the last read failed or the budget skipped one (`owed`) — never on a
  304 otherwise. A finished check run does NOT move the heartbeat, so an UNDECIDED PR (mergeable
  UNKNOWN or rollup PENDING/EXPECTED — measured: 40 of 50 open PRs read UNKNOWN on a first read, all
  settled 20 s later, because the first read is what starts GitHub's computation) is CHASED at
  30 s / 1 min / 2 min / 5 min, at most 12 reads per episode, and only while a board is VISIBLE: the
  renderer asks (`githubIssues.chasePulls`) every 15 s while `document.visibilityState` is visible,
  and the host answers from a map — schedule, cap and the synchronous `claimChase` live in core, and
  no context (credential chain) is resolved unless a read is due. A new undecided PR or a new head
  starts a new episode; the same stuck PR does not restart the count. **Semantics, each a shipped
  bug somewhere:** a null rollup is "no checks" and renders NOTHING (never a tick); only
  `mergeStateStatus === 'CLEAN'` is "Ready to merge" (MERGEABLE+BLOCKED is real: 2 of 31 here);
  a rollup counts only at the current `headRefOid`, and a CI result is never carried from an older
  head; a failed read keeps the last snapshot marked stale (`pullStatusFreshness`, greyed after
  15 min); a FORBIDDEN/INSUFFICIENT_SCOPES answer for the rollup or mergeability HIDES that region
  (`access`), which is not the same as a null rollup. Enum values (`mergeable`, rollup `state`,
  `mergeStateStatus`) decode LENIENTLY: a value GitHub adds later claims nothing and is not chased,
  and an unrecognised rollup state is `UNRECOGNIZED`, never `null` ("no checks") — one new value
  must not fail every read of the repository (it happened with `state_reason: duplicate`). **Budget:** GitHub meters `graphql` apart from
  `core`, and so does the coordinator now — `throttle(identity, at, resource)`, a primary limit is
  tagged with its resource (`GitHubClientError.resource`, from `x-ratelimit-resource`, or GraphQL's
  200-with-`RATE_LIMITED`) and holds only that resource; an untagged (secondary) limit still holds
  the identity. A spent graphql budget (the user's own `gh pr list` spends it) must not stall REST
  issue sync. **Links:** PR → issue = GitHub's own `closingIssuesReferences` (same repository only),
  deliberately NOT unlinkable on the board — GitHub closes the issue at merge whatever the board
  shows. PR → session card = the PR's head equals `data.worktree.branch` of the card's nearest bound
  group (`worktreeBranchOf`, no git read; a stale binding still names the branch, which is exactly
  when its PR merges); a FORK PR never links (36 of 50 open PRs here are forks). Unlinking writes a
  git-shared tombstone in `ProjectKanban.pullLinks` — a BOARD-LEVEL field on purpose: every card-meta
  setter rebuilds `meta[]` entries from a fixed field list, so a field added there is erased by the
  next member/due/label edit. On an SSH project NO card carries a worktree branch
  (`kanbanSessionsFrom` leaves it off where the cards are built), so the card face, the move and
  the modal — which states the worktree reason — cannot disagree. PR → issue → session card: a session started on an issue (`data.issueRef`, below) links to
  every PR whose `closingIssuesReferences` name that issue, matched against the pull board's own
  `repository` (a `closes` number means nothing in another repository); here a FORK PR does count —
  GitHub's "Closes #N" is meaningful wherever it comes from. The host memory remembers what a PR
  closed while open, so the link survives the merge that should move the card; the same tombstones
  apply, and an issue-bound card on an SSH project still links this way (only the branch half needs
  a worktree group).
  **What this machine observed lives on the HOST** (`core/github/pull-memory.ts`, persisted beside
  the issue cache per identity + repository, deleted with it): every PR it has seen, its head, its
  lifecycle, whether it was seen open, and `mergedSeenAt` — the first time it was seen merged AFTER
  being seen open (an OBSERVED merge). The read lists only 50 open + 30 recent PRs, so without it a
  closed-unmerged PR's block would expire once 30 newer PRs closed; remembered PRs stay on the pull
  board (closed ones until unlinked, merges for 30 days) and an unlisted one takes its lifecycle
  from the REST harvest. The first version kept a per-card "seen" map in settings.json instead, and
  review found three failures in that shape: the planner's output exceeded the sanitizer's bounds so
  the hook rewrote settings in a loop until React threw; the block expired; and two Server Edition
  tabs both moved the card while a background tab's settings write reverted another tab's changes.
  **Merge-driven move — session cards only, OFF by default.** The switch, the target column and
  `armedAt` are MACHINE-LOCAL (`settings.kanbanPullAutoMove.projects[projectId]`, written ONLY by
  the user's own Settings action): it makes this machine write the shared board on its own, so a
  switch in the project file would make every clone move and commit cards nobody on that machine
  asked for. Per-card opt-out is board content (`pullLinks.noAutoMove`). Guards in order
  (`decidePullAutoMove`): opted out → never; any linked PR open/draft → wait; any closed unmerged →
  blocked until the user unlinks it; already in target → nothing; no linked merge with
  `mergedSeenAt >= armedAt` → no move (arming never sweeps old merges; `armedAt` is taken from the
  HOST's clock via the pull board's `now`, because `mergedSeenAt` is stamped there and a Server
  Edition browser's clock can be off). Each planned move must then win the host's one-time CLAIM
  (`githubIssues:claim-pull-auto-move`, persisted in the same memory) — the first ask across every
  window wins, and a card dragged back is not moved again for the same merges. **Claims are
  recorded PER PR (project + card + PR), never per PR set**: the linked set changes on its own (a
  merged PR ages off the pull board, another PR on the branch joins), and a set-keyed claim read
  every such change as a new transition and moved a dragged-back card again. A claim is granted only
  for a PR that has not moved this card yet; set keys an earlier build wrote are read as a claim on
  each PR they list. The board asks each (card, PR set) ONCE while it is in flight or after it was
  won, and re-asks a REFUSED one only after `REFUSED_CLAIM_RETRY_MS` (60 s: the host also refuses
  transiently, before it is bound to the project or while it clears its cache, and remembering that
  for the board's lifetime lost the move); a failed call is forgotten. It re-plans only when a field
  the planner reads changes — it used to send a claim per canvas change for a dragged-back card. **The claim is refused unless THIS card was
  noted waiting on one of those PRs while it was open** (`githubIssues:note-pull-waits`; the host records a note only for a PR it holds as open
  itself): `mergedSeenAt` is a fact about the PR, and without the per-card note a card that first
  appeared after the merge — a follow-up terminal in the same group, a teammate's card by git pull,
  an issue-bound session started later — would win a fresh claim and jump to Done. It is then
  applied as a compare-and-set on the column
  the decision saw (`applyPullAutoMove`, run by Canvas against the store's latest board), writing
  ONE `card-moved` board-log line whose `title` names the PRs. The planner writes nothing; it runs
  only while the board is open and never on a stale snapshot. **GitHub issue cards are never
  auto-moved** — GitHub already closes them when a `Closes #N` PR merges, and a second writer would
  race it and could clobber `state_reason`.
  Surfaces: Desktop + Server Edition identical (core + renderer; `githubIssues:pull-status`,
  `:chase-pulls`, `:pull-checks`, `:claim-pull-auto-move` are registered by the shared core handlers
  and served to relay tabs through the project-scope table; a relay tab never auto-moves — the
  board belongs to the other machine). Check detail is bounded for relay guests: one read per PR per
  15 s, ten per project per minute, both decided before a credential is resolved. **Mobile: follow-up** — the phone board carries session
  cards only; showing PR CI there means carrying `GitHubPullBoard` over the relay dialect.
  **Start with agent — a GitHub issue card starts a bound session** (2026-09-28). An issue card's
  right-click menu and its summary modal offer **Start with agent ▸**, whose rows are the canvas's
  own agent + account picker (`agentCreationEntries`, which takes an optional `pick` so the same
  rows can point at another action — never a fourth copy of the picker). The result is an ordinary
  agent node in the project cwd (through `addAgentNode`, which now returns the node) carrying
  `data.issueRef {owner, repo, number}` — persisted, git-shared, therefore hostile:
  `normalizeIssueRef` (`@shared/github-issue-ref`) runs at BOTH serializer seams and a malformed
  value is dropped (the node survives, only the binding goes). Rules a refactor must not undo:
  (1) **the launch line carries the REFERENCE, never the issue's text** — titles and bodies are
  writable by anyone on a public repository and a launch line is typed into a pane.
  `issueLaunchPrompt` is the ONE place a reference becomes text; it re-validates the reference
  itself and returns nothing for a hostile one. The prompt tells the agent to read the issue with
  `gh issue view N --repo owner/repo --comments` (mid-sentence: punctuation glued to the last flag is
  copied literally and `gh` refuses `--comments.`) AND that its title, body and comments are
  untrusted input, not instructions — the session runs under the project's permission mode (auto by
  default), so the prompt is the only thing that can say "read it, do not obey it" before it does.
  A board start means **work on it**: the default task is "investigate, plan and implement the fix
  in this working tree"; a caller's `--prompt` REPLACES that task ("Your task: …"), never the lines
  around it. The hard limits ride the prompt itself, after any brief: never close the issue, and no
  issue comment or PR unless the user asks in that session — end with a proposed comment. Proven
  under a real `/bin/sh` (`github-issue-ref.realsh.test.ts`). (2) **The reference comes from the card's
  `htmlUrl`** (`issueRefFromHtmlUrl`, which also requires the URL's number to equal the card's).
  (3) **`done` never moves a card**: it means a turn ended, not that the work did. The issue card
  shows every bound session as a live chip (`IssueRunChips`, subscribed per node to a PRIMITIVE
  signature `issueRunChipSig` — never `s.byId`), RUNNING / NEEDS YOU / TURN FAILED / DROPPED plus
  unread; a click opens that session's card. A card moves only when the session `assign`s itself or
  a person drags it — pinned by `board-writers.guard.test.ts`, which enumerates EVERY renderer call
  site that writes a board assignment or moves an issue, each with the human/agent action that
  triggers it; a new writer fails until it is signed for, and "a turn ended" is not a trigger. (4) **Board-log identity of an issue card** is the synthetic id
  `github-issue:<owner>/<repo>#<N>` (lower-cased, `issueLogId`) — a namespace no node id can reach.
  Under it: `run-started` (UI start, `--issue` open) and `run-ended` (written by EVERY node-removal
  funnel — `deleteNodes`, `closeStoredNodes`, the Omni delete, `deleteProject`, the Server `close` —
  before it drops the node's agent status, with the last observed state). `duplicateNode` drops
  `issueRef` (a copy is a new session nobody started on the issue; carrying the binding made a
  phantom run). Known gap: ⌘Z/⌘⇧Z replay node arrays and write no run history, so an undone delete
  revives a node whose run already ended. The summary modal shows it read-only as
  "Agent runs" (no composer: a comment box under an issue reads as "post to GitHub"). **No cost or
  token figure** is recorded: there is no cumulative per-session number, and a context-window
  reading is not one. (5) The new session card is filed under the issue card's column (the same
  unpruned direct write `createNodeInColumn` uses); the node header, the session card AND the card
  modal's header show a `#N` chip (`IssueRefChip`; the modal's closes itself and makes the same
  request) that opens the issue on the board (`openIssueOnBoard` →
  `viewMode.requestedIssue`) ONLY when that board has GitHub sync — otherwise straight to GitHub,
  rather than flipping the project's persisted view to a board that cannot show it — and the board
  itself falls back to GitHub when the issue is not on a fetched page. Never a dead click. **"Start
  with agent in a new worktree ▸"** sits beside it on the card menu and in the summary modal: a
  fresh `issue-<N>-<slug>` worktree frame with the agent inside, reuse offered when the issue
  already has one — see the Worktrees bullet ("A worktree per GitHub issue"). Surfaces: Desktop + Server Edition (renderer + core); Omni board shows no
  issue lanes; **Mobile does not render the binding** — `issueRef` reaches the phone inside the
  project file, and nodeterm-ios ignores the unknown field (follow-up there).
  **Board dispatch — a card THIS person moves into the dispatch column starts its own run**
  (2026-09-30; `@shared/board-dispatch` consent, `renderer/lib/boardDispatch.ts` decisions,
  `state/boardDispatch.ts` queue, wired in Canvas `dispatchOnUserMove` / `drainDispatchQueue`). The
  run is exactly "Start with agent" — `issueRef` binding, the reference-only `issueLaunchPrompt`,
  `fileIssueSession` (card filed + `run-started`) — only nobody clicked it. The hard question is WHO
  may trigger a run on this machine, and the answer shapes everything else:
  - **The trigger is the person's own move in this app**, never a fact that arrives from outside.
    `decideDispatch` answers `ignore` for every origin but `'user-move'`, and the only caller that
    says `'user-move'` is the board's move-result path (`KanbanView.moveIssueByUser` →
    `onIssueMoved`, reached only from `requestGitHubMove` and the close/reopen confirm). A label
    set on GitHub (by anyone — on a public repository, ANYONE) reaches this app only as a refreshed
    page, and a board change arriving by `git pull` only as a new project file; neither has a path
    in. A move GitHub did not CONFIRM (`stale`, `failed`, `read-only`, …) is not a dispatch.
    `lib/board-dispatch.guard.test.ts` pins the WHOLE chain: `decideDispatch`'s one caller,
    `onIssueMoved`'s one firing site, `dispatchStart`'s two callers (after `decideDispatch` in
    `dispatchOnUserMove`, after `recheckQueued` in the drain), and that a `'queued'` entry — which
    the drain starts without asking `decideDispatch` again — is created only in `dispatchOnUserMove`.
  - **Why not a label with an actor allowlist** (the other design considered): it works from a
    phone, but it needs one issue-events read per candidate issue (budget), compares an actor
    against a credential that can change under it, and today the poll runs only while a board is
    subscribed — a network-derived fact standing in for consent, and no run at all when nobody has
    the board open. That is the follow-up, not v1.
  - **Consent is machine-local** (`settings.boardDispatch`, the `kanbanPullAutoMove` / trigger arm
    store tier), never `.nodeterm/project.json`: a switch in the project file would let a pull
    request make every clone start agents. Per project: the column, the agent, an optional account
    (absent = the project default through the same funnel as "New <agent>"), a cap (1–8, **default
    1**: dispatched runs are told to implement the fix in the project's own working tree, so two at
    once are two agents editing one checkout), and a **binding**.
  - **The consent binds what the column MEANS, not just its id** (`dispatchBinding`: repository +
    column title + its GitHub label). Titles and labels live in the git-shared project file, and
    titles are deliberately outside `githubMappingDigest` — so without it a pulled commit swapping
    the titles of "Agent" and "In Progress" would turn the person's routine drag into "In Progress"
    into a dispatch, and re-pointing the board at another repository (which needs only a mapping
    re-approval) would carry the dispatch switch along. Any difference refuses (`consent-stale`, on
    the card and in Settings) until the person presses "Re-confirm this column". Choosing a column
    binds; changing the agent or the cap does not re-bind. An entry without a binding is OFF.
  - Read through `sanitizeBoardDispatch`: an unreadable entry is OFF, an unreadable cap is 1, the
    kill switch (`paused`) is on only for a literal `true`. `boardDispatch` is in
    `SETTINGS_VERB_FORBIDDEN` — an agent that could switch the dispatcher on would grant itself more
    agents, and the name pattern does not catch the key, so the set is its only fence. Model: the
    same gateway default `addAgentNode` applies; there is no per-project model.
  - **Only agents that report their state through hooks** (`dispatchableAgent` →
    `hasHooks(capabilityAgentId(…))`, the `--after` rule) are offered or accepted. The cap counts
    sessions by hook state; a hookless custom agent never reports, so after the startup grace its
    slot would free and the cap would admit one more run every two minutes.
  - **Bounds.** One run per issue: a bound session that still exists in ANY project, or a dispatch
    already queued/starting, refuses the next with a reason on the card. The cap counts this
    project's bound sessions that are `working`/`waiting`/`blocked`, hold a launch that will start
    BY ITSELF (a `manualOnly` one waiting for Run now does not), or were started by dispatch within
    `DISPATCH_STARTUP_GRACE_MS` (no hook yet) — `done` frees the slot (the cap limits concurrent
    WORK), and an unknown state from before a restart does not hold one, or the cap would stay
    pinned. Over the cap the dispatch QUEUES; the drain runs on a 5 s timer only while something is
    queued. **Every queued entry is re-asked before it starts** (`recheckQueued`): kill switch,
    still switched on, project still open/local/not closed, binding unchanged, agent still
    dispatchable, and the issue still OPEN and still in the dispatch column (read from the host's
    issue cache with `githubIssues.query` — no GitHub request; an unreadable answer waits, it is
    never evidence). A teammate closing or moving the issue while it waited drops it with its
    reason. Moving a queued card out of the column withdraws it. The kill switch refuses new
    dispatches and drops the queue; running sessions are not touched.
  - **No dispatched node is ever left armed to start on its own.** The off-screen path writes the
    node ALREADY CLAIMED (`claimForHeadless`: `manualOnly`, in the same tick as the node — no window
    in which opening the project would auto-start it beside the headless start), then runs the #925
    headless start. Whatever it answers, a node that did not start waits for Run now; a Pause or a
    restart can therefore never be outrun by a held launch that fires on view. The failure notice
    says exactly that (Run now, or close the node to dispatch the issue again — it keeps the issue's
    one run until then).
  - **The queue is in memory, on purpose**: a queue that survived a restart would start agents at
    boot with nobody there. A restart drops it silently, and the drag (or Start with agent) can be
    repeated. Each renderer keeps its own queue, so **two Server Edition tabs on one project can
    each run up to the cap** (known; one tab per project is the supported use).
  - **The card says what happened** (`DispatchChip`): "Queued for an agent (#2)", "Dispatching an
    agent…", or "Not dispatched: <reason>" (`DISPATCH_REFUSAL_TEXT`). A started run shows as the
    ordinary run chip.
  - **Where it runs: the renderer**, because the trigger is a UI gesture core never sees. On screen
    it is `addAgentNode`. Off screen — a queued run whose slot freed later, or a project switch
    during the move's GitHub round trip — it is a cold open into the stored project (the control
    verbs' path) plus the headless start, which raises its "Go there" notice. A CLOSED project's
    queued run is dropped, not started (the headless start would unhide its tab). **Server
    Edition**: the browser renderer's `pty.launchHeadless` is unsupported (the server's own
    headless launcher serves canvas control, not a browser tab), so a dispatch there starts only
    for the project ON SCREEN; an off-screen one stays queued (still subject to Pause) until that
    project is shown. **SSH projects: refused by name** (the headless launcher is local-only).
    **Relay tabs: refused** (the board is the host's). **Mobile: N/A** (the phone board carries no
    issue cards). Never auto-posts to GitHub, never closes an issue, never moves a card on a turn
    `done` — the existing rules; the dispatch column may not be the completion column.
  **Where a card comes from is a registry, not a branch per call site** (`renderer/lib/kanbanSources.ts`,
  2026-08-30 — the same membership-plus-one-leaf discipline `AGENT_CONFIG` uses): each entry declares
  its filter `label`, its `placement` (`assignment` = the board's own persisted assignments,
  reorderable within a column; `provider` = the provider reports the column, the board persists
  nothing and a move is the provider's write), its in-column `lane` order and whether it is
  `configured` for a given board. Two orders live there deliberately: **declaration order is the
  source filter's button order** (All · GitHub · Sessions), **`lane` is the in-column stacking order**
  (sessions above issues) — they genuinely differ, and pinning both is what stops either being
  re-spelled elsewhere. `KanbanColumn` therefore takes ONE `lanes` prop (`{sourceId, cards, footer?,
  count}`) instead of a `cards` + eight `github*` props, places them via `byLane` and names no source;
  the board builds each source's leaf, and the drag union branches on `placement` (`isProviderDrag`)
  rather than on the string `'github'`. A lane's `count` is passed rather than derived from
  `cards.length` because a provider reports a server-side total larger than the page fetched so far.
  What deliberately did NOT move into the registry: the virtual **Ungrouped** column (board
  semantics, not a source's concern) and `validKanban`, which stays the single shape gate on every
  load path — a registry entry must never grow its own parallel validation. **Labels** are a per-project palette (`ProjectKanban` labels,
  edited inline via the Notion-style `LabelPicker`: create/assign/rename/recolor/delete through the
  pure `lib/kanban.ts` transforms) plus each GitHub issue's own labels, both filterable. The canvas stays MOUNTED under the opaque overlay (agent-status
  listeners live in Canvas.tsx; `display:none` would 0×0-resize every terminal into a tmux
  SIGWINCH), and canvas-only shortcuts (undo, ⌘T/⌘⇧C, Delete) early-return via `isKanbanOpen`.
  Board data is `project.kanban` ({columns, assignments: [{nodeId, columnId}]}, order = array
  order) in `.nodeterm/project.json` — git-shared, rides rev/mirror/watcher; absent until the
  first edit (`defaultKanban` seeds To Do / In Progress / Done). The virtual **Ungrouped**
  column (never persisted, undeletable/unrenamable, always first) holds every session with no —
  or dangling — assignment, in canvas order, so the board never opens empty. **Assignment is
  board metadata only**: drags never move canvas nodes or change groups; dead nodes' assignments
  prune lazily on each board change (`pruneAssignments`). Column delete is confirm-free (cards
  return to Ungrouped; no last-column rule — Ungrouped remains). The one shape rule is
  `validKanban` (`core/workspace-files.ts`), applied on EVERY load path — `fileToProject` AND
  `loadV3`'s inline (cwd-less) branch, which bypasses fileToProject — so a v1 `{columns, cards}`
  or hand-mangled board drops to the fresh default instead of crashing the render (view choice
  persists in localStorage, so a render throw would boot-loop). Pure transforms in
  `renderer/lib/kanban.ts`; view choice is personal (`state/viewMode.ts`, localStorage
  `nodeterm.projectView`). The board opens with a **title strip** (`.kanban-header`: project
  dot + name) whose height clears the floating controls-cluster icons — columns never sit under
  them. **Cards collapse/expand on single click** (transient state); the expanded detail row
  reuses `ContextMeter` (model + % pill, per the node header) + session chip + an ↗
  open-on-canvas button; double-click opens the node directly. Z-order contract: overlay 25 <
  `.controls-cluster` 26 (Explorer/SC/Settings stay clickable ON the board) < `.top-banners` 27
  (a mandatory-update card must not hide behind the board) < tabbar 30. An assigned session
  node shows its column as a **half-pill flush on the node's TOP edge** — see the pill sentence
  below. A card's ↗ / double-click opens the **card modal** (`components/kanban/CardModal.tsx`, body
  portal on the dialog-stack, scrim z 55, scrim/Esc close — Esc in CAPTURE phase, and an Esc
  during a header rename only cancels the edit). The modal runs under the CARD project's session
  (`ProjectSessionScope` — the boards themselves sit under App's local provider; see "A remote
  project's node never starts on this core" under Projects). Terminal cards get a LIVE second
  view of the tmux session (`ModalTerminal.tsx`): the pty subscriber ledger is keyed by the composite
  `(ClientId, viewerId ?? PRIMARY)` (`core/pty-manager.ts` — **viewer identity**; viewerId is an
  optional TRAILING arg through preload/ws-bridge/LocalTransport, absent = bit-for-bit legacy, and
  a client's per-connection socket pause survives a single view's departure). The modal viewer
  seed-paints from the joiner screen (`toXtermText` transforms — raw capture-pane staircases),
  handles fresh-cold via scrollback snapshot + hint (agent auto-resume stays canvas-only), has
  deliberately no park/WebGL/hover/flow-control, and kills ONLY its own viewer on close. Sticky
  cards edit their text in the modal (live both ways).
  The modal header carries the terminal node's actions (search via `useTerminalSearch`+
  `FindBar` on the modal xterm; dictate via the same `nodeterm:dictate` event — `.dictation`
  overlay z is 60, ABOVE the modal scrim; ✦ `pty.generateName` through the modal rename funnel;
  and the **⌘M view** — a header toggle (`IconMarkdown`) plus the chord, which lays the SAME face
  the canvas node shows over the live viewer: `ChatPanel` when `canChat(created agent)` and the
  session id is known, else `TerminalMarkdownView`. Three rules: the state is MODAL-LOCAL and per OPENING
  (never `data.mdMode` — that would flip the canvas node under the board too); the viewer
  stays MOUNTED underneath (covered, not swapped, so its co-attach never detaches/re-attaches) and
  gets the same focus hand-off as the node (`ModalTerminal`'s `covered` → `useMdModeFocus`); and the
  chord reaches the modal through `window.nodeTerminal.onMarkdownToggle` only while it is the top
  dialog, while the canvas terminal AND editor nodes' own subscriptions refuse the chord whenever a
  board is up (`lib/markdownChord.ts` `canvasOwnsMarkdownChord` — a hover flag can go stale under
  the opaque board, so one press could otherwise flip both). The header also carries the node's
  pause chips — DROPPED, PAUSED and SLEEPING (Eco, with the refused-wake sentence) — each clicking
  through the same `wakeHibernatedNode` trigger as the canvas chip. The overlay sits at z 5 in the pane, BELOW the
  sheet's resize handles (z 6/7, issue #389) — pinned in `styles.kanban.test.ts`.
  **The 💬 icon means COMMENTS on both surfaces** (repurposed from the markdown view — ⌘M still
  toggles markdown/chat on the canvas node, and on the card modal): on a terminal node it opens a right-side comments
  flyout (`.term-node__comments`, a sibling of the overflow:hidden root, hosting BoardLogPanel
  with `card: Pick<KanbanSession,'id'>`); in the modal it collapses/reopens the panel, which is
  OPEN BY DEFAULT there. Under the modal header sits the **card metadata strip** (`CardMetaBar.tsx`): Members (assign) —
  colored initial avatars, picker pool = me + live presence peers + board-log authors (name-keyed,
  NO separate membership system) — and a Due date (`datetime-local`, red Overdue chip past due;
  cards show mini avatars + a due chip). Data = `kanban.meta [{nodeId, assignees, dueAt, priority}]` (priority low/medium/high/urgent, colored chips)
  (tolerant readers via `cardMeta`; pruned with dead nodes; empty entries dropped). Assign/due
  changes are logged through the SAME diff funnel (`member-assigned/unassigned`, `due-set/cleared`,
  `priority-set/cleared`; agent-to-agent message deliveries are logged as `agent-message` by
  `agent-message-trace.recordDelivery`, where `from`/`to` are node ids and `title` is the outcome;
  unknown future event types render neutrally — the `BoardLogEvent.type` union in `shared/types.ts`
  is the source of truth). Feed rows show ABSOLUTE Trello-style stamps
  (relative in the tooltip). The modal's right third is the **board log** panel (`BoardLogPanel.tsx`, `state/boardLog.ts`):
  per-person comments + card activity from `<cwd>/.nodeterm/board-log.jsonl` — append-only JSONL
  (`core/board-log.ts`: tolerant newest-first parse cap 500; text clamped `BOARD_LOG_TEXT_MAX`
  16KB — an SSH append is ONE printf arg, ARG_MAX would silently drop it), author = presence
  identity, registered via `core/board-log-handlers.ts` in BOTH shells (client sends only a
  projectId — the path always derives from the server's own registry, no jail needed). Events
  come from ONE pure funnel (`lib/boardLogDiff.ts` — binding invariant: its `cardTitle` arg
  returns '' for and ONLY for dead nodes; column deletion suppresses per-card moved-to-Ungrouped
  noise; prunes/reorders log nothing) + `createNodeInColumn`'s card-created. Local projects push
  changes via fs.watch; desktop SSH projects poll 5s while subscribed; inline projects show a
  hint. Relay tabs BRIDGE boardLog to the host (pre-dispatch `sharedProjectId` scope guard in the
  relay dispatch — an out-of-scope projectId is refused before any registry/path resolution; a
  connection drop replays its outstanding onChanged unsubscribes). **The relay-guest scope jail is
  keyed on channel CLASS, not a per-feature list** (`main/remote/relay-project-scope.ts`): every
  method whose name starts with `githubIssues:` / `board-log:` / `projects.` is project-scoped, and
  one the table cannot read a projectId out of is REFUSED on a scoped session. The switch it
  replaced had a `default: not project-scoped` arm, so a new verb in one of those namespaces reached
  another project's data with no refusal anywhere. A new channel in a scoped class therefore needs a
  table row to become reachable — and `relay-project-scope.test.ts` fails if a live IPC channel in a
  scoped class has none, so the fail-closed default cannot silently swallow a shipped verb.
  **A comment can steer an agent**: its composer's @ picker (canvas flyout and card modal alike —
  both build the candidates through `lib/boardMentions`) mentions an agent session on this board,
  and on send that session receives the comment through agent messaging; the row shows each
  delivery's outcome. A comment that ARRIVES in the log is display-only, forever — see "A board
  comment that @mentions a session" under Agent support. Deliberate v1 gaps: column-level
  events are stored but no card feed shows them; canvas-born nodes get no card-created; no
  card-deleted type.
  Per-column "+ New session" menus create agents/terminal/sticky nodes assigned to the column
  (assignment written UN-pruned — the fresh node isn't in the derived list yet).
  **Multi-select** (2026-11, both boards): ⌘/Ctrl-click toggles a session card, Shift-click extends
  from the last picked card in BOARD order, and while anything is selected a plain click keeps
  picking instead of opening the modal (Esc / the bar's ✕ leave; the card menu's **Select** row is
  the way in without a modifier). The floating `CardSelectionBar` and the right-click menu of a card
  INSIDE a multi-card selection (`buildBulkCardMenuItems`) act on all of them — **Move to**
  (`assignNodes`, which lands the group together and in board order at every anchor; a loop of
  `assignNode` would reverse it at the top) and **Delete** (ONE canvas confirm: `onDeleteNodes`, or
  `nodeterm:global-delete` with `nodeIds` from an Omni lane) — and dragging a selected card carries
  the selection. Load-bearing: the selection is pruned against the cards ON SCREEN and callers read
  the pruned value in the same render (`useCardSelection`), so a bulk delete can never reach a card
  that a filter, a collapsed lane or a hidden closed column took out of sight; GitHub cards are
  never selectable (their column is the provider's); on the Omni board a selection lives in ONE
  lane (`selectionOwner` — two projects share no columns). Rules are pure in
  `lib/cardSelection.ts`. No keyboard chord yet (no `board.*` registry command selects or deletes). The column
  half-pill itself: (`components/kanban/ColumnPill.tsx`, `columnForNode` in lib/kanban; rendered
  as a SIBLING of the node root — the roots are overflow:hidden — hidden for Ungrouped/dangling,
  click opens the board). Server Edition works as-is (pure renderer + workspace.save). Scope: no
  agent-driven card movement yet, no board undo.
  **Mobile (nodeterm-ios) reaches the board through three relay verbs**, all landing in
  `WorkspaceStore.ensureRemoteBoard` / `setRemoteCardColumn` / `editRemoteCardLabels` (host-service
  `handleKanban`; wired in `main/index.ts`'s `hostBridge.kanban`; pure transforms in
  `core/project-kanban-write.ts`): `projects.ensureBoard` seeds the default columns on a project that
  has none, `projects.setCardColumn` moves one card, and `projects.editCardLabels` adds / removes /
  creates **board labels** on one card (the phone's long-press label sheet, 2026-09). There is ONE
  label model — the per-project palette in `kanban.labels` plus per-card ids in `kanban.meta[].labels`
  — and the label verb writes it through the SAME transforms the canvas node's "+ Label" row and the
  kanban card use: the card-meta + label half of `lib/kanban.ts` moved to `@shared/kanban-labels`
  (re-exported, renderer call sites unchanged) so core can apply it; a test pins that a phone edit
  produces the board `toggleCardLabel` produces. Params are validated at the write site
  (`parseCardLabelEdit`: bounded control-free ids, 1–60-char control-free names, colour from the closed
  palette, no id both added and removed) because they land in a git-shared, hand-editable file; a
  created name matching an existing label case-insensitively REUSES it (the picker offers no Create
  on an exact match); the first label on a board-less project seeds the default board, as the
  desktop's first "+ Label" does; a stale `add` answers `edited:false` with the CURRENT palette so the
  phone can redraw. Deleting/renaming palette entries is deliberately desktop-only (it touches every
  card). The iOS direct-SSH path has a Swift twin of the transform for projects on the host it dials. Three things make them necessary rather than convenient. (1) The desktop board is a
  LAZY default — `kanban` is not written until the user's first board edit — so most project files
  carry NO board and the phone, which knows a project only by its file, could not offer one
  (measured: 1 of 13 project files on the author's machine had a `kanban` block). The default columns
  therefore live in `@shared/kanban-default-board`, read by `defaultKanban()` AND by the core seeder,
  and copied verbatim (under a pinning test on both sides) by iOS `KanbanDefaults`. (2) An SSH
  project's file is on a THIRD machine the phone has no credentials for; the verb writes the entry's
  `cache` and lets the ordinary mirror push it, which is exactly what a desktop card drag does — so
  it needs nothing new from `reconcileSsh` (that decides by `rev` and unions only `nodes`). Its cache
  change IS persisted to workspace.json, because for an ssh entry the cache is the local record. (3)
  The phone's older direct-SSH write inlines the whole project.json into one argv string and so dies
  at Linux's `MAX_ARG_STRLEN` — this repo's own `.nodeterm/project.json` measured 114,695 bytes,
  ~15 KB under the 128 KB ceiling. **Both verbs announce their write on `workspaceExternalChange`
  and that is not optional**: the renderer holds its own board and the next whole-workspace save
  serializes THAT, so a change the renderer never heard about is one the next autosave reverts.
  **Board model + UX (2026-09).** Three tiers, and a new board feature must pick one: a board
  FACT is shared content in `project.kanban` (optional, sanitized, ignored harmlessly by an older
  build); a DISPLAY preference is per-user localStorage (`state/kanbanDisplay.ts`,
  `nodeterm.kanbanDisplay`, per project); a filter on LIVE agent state is component state only.
  - **`sanitizeKanban` (`core/workspace-files.ts`) is the shape rule now**, applied on all three
    seams — `fileToProject`, the store's inline-project branch (which bypasses it) and
    `projectToFile` on the way OUT (the two-seam rule `sanitizeLayouts` follows). It is
    `validKanban` plus per-entry repairs, never inventions: a column that is not an object with
    string `id` + `title` is dropped (React cannot render an object title — a render throw
    boot-loops the app, the view choice persists), a non-string `category` is dropped, a malformed
    assignment is dropped, a card's `assignees` that is not a list is dropped (entries without a
    string name + colour filtered), every other field round-trips, and a clean board comes back BY
    IDENTITY so a well-formed file is never rewritten. **Readers do not trust the load path alone**:
    `cardAssignees` (`@shared/kanban-labels`) is the one reader of `meta[].assignees` — the board,
    the card, the member filter, the log diff and the handoff pings all go through it, because an
    `assignees: 5` iterated raw threw during render (a boot loop) and inside the `assign` verb.
  - **Lifecycle category** (`KanbanColumn.category?: unstarted|started|done|closed`,
    `@shared/kanban-category`). Every reader goes through `columnCategory`: an unknown STRING reads
    as absent but is KEPT in the file (dropping it would erase a newer build's value on an older
    teammate's save); a non-string never reaches a comparison. The default board carries
    unstarted/started/done on every seeding surface (`defaultBoardColumns`, shared by
    `defaultKanban` and the relay's `ensureProjectBoard`/label seeding). It drives the header
    progress (`boardProgress`: live cards in done+closed columns over EVERY live card, Ungrouped
    included; null when no column is done/closed — a number over an undefined "complete" would be
    invented), hides `closed` columns behind a per-user toggle (default hidden), and gives the GitHub
    completion column its default (`defaultCompletionColumnId`: first done, else first closed, else
    the last column — the pre-category default, so an uncategorized board is unchanged). **A
    category change on a column that holds cards is never silent**: it is a claim about every card
    in the column (they start counting as finished, or leave view when it becomes closed), so
    `categoryChangeImpact` gates a `ConfirmDialog` naming the count and the consequence; an empty
    column changes at once. Confirm rather than refuse: refusing would only make the user empty
    the column first, which is friction, not safety. Set from the column's ⋯ menu / header
    right-click on the per-project board; Omni shows no column menu.
  - **An unanchored card move lands at the TOP** (`assignNode`): no `before`, or a `before` naming
    a card outside the destination column. An agent's `assign` into a long Done column used to
    append at the bottom and read as "disappeared". A POSITIONAL drop still says where it landed —
    below the last card or on the column body passes `AT_COLUMN_END` explicitly (both board views).
    The relay's `projects.setCardColumn` follows the same rule; the `assign` help in BOTH agent
    bodies says so (`canvas-control-core.test.ts` pins it).
  - **Status chips** (Running / Needs you / Unread, `lib/kanbanStatusChips.ts`) read the store
    through a derived primitive signature (`statusChipSig`) — never `byId`, the `armedDepSig` rule —
    and are NEVER persisted (component state, reset on project switch): a filter on
    second-by-second state that survived a restart shows a wrong board. The card badge and the chips
    share ONE rule, `cardBadge`, so a chip cannot select cards whose badge says something else. They
    narrow session cards only (like local labels); they AND with the label filter and OR within
    themselves.
  - **Board-log folding is a VIEW** (`lib/boardLogCollapse.ts`, `BoardLogFeed`): consecutive events
    by the same author (name AND colour) of the same type within two minutes of the run's NEWEST row
    render as one "×N" row that expands in place; the jsonl is never rewritten. The window is
    anchored, not chained, so a ×N never spans more than two minutes. Comments never fold, and
    neither do `agent-message` / `agent-read-cookies` (audit rows) or an issue's `run-started` /
    `run-ended` history (each row names a different session) — `NEVER_COLLAPSE`.
  - **Keyboard**: registry scope `board` (group Board) — Space opens the focused/hovered card,
    J/K + ArrowDown/Up walk board order (the session cards on screen, column by column, Ungrouped
    first; GitHub cards excluded), ArrowLeft/Right jump to the same row of the neighbouring
    non-empty column; in the card modal J/K step the modal. `board` resolves only while a board is
    up and has no `allowWhileTyping`/`allowInTerminal`, which is the ONLY reason
    `normalizeBindingForCommand` lets it bind a bare letter or Space (the card modal's terminal,
    the comment box and the chat composer keep every key). Dispatch stays in Canvas's one
    listener; the mounted per-project board answers through `lib/boardKeys.ts` and DECLINES (the
    key falls through) when the focused control uses the key (`keyOwnedByControl`: Space on a
    button/link/checkbox, anything in a `<select>` or ARIA composite), when any dialog other than
    its own card modal is open, or when a card menu is up. Two pre-existing bugs this had to fix:
    the canvas's CAPTURE-phase space-to-pan `preventDefault`ed every non-typing Space even while a
    board covered the canvas (so no board button could be pressed with Space) — `spacePanKeydown`
    now takes `canvasCovered`; and a `Space` binding could never match because `e.key` is `' '`
    (`normalizeKey` maps it to `SPACE`). The Settings recorder captures a bare key only for a
    command that may have one (`board` scope or `allowBareKey`).
  - **Rank strings** (`KanbanAssignment.rank?`, `@shared/kanban-rank` + `@shared/kanban-order`).
    Order within a column = rank; an entry without a valid one (every pre-rank board, an older
    build's move — its `assignNode` rebuilds the moved entry without the field — a hand edit) sits
    right after the entry before it in the ARRAY, ties keep array order. Keys are base-62
    fractional-index strings with an integer head, so the board's DEFAULT (top insert) is a
    decrement: a thousand top inserts stay four characters (a digits-only midpoint scheme grows a
    character every few). **A move never throws**: ~1.3k inserts into ONE gap grow a key past
    `RANK_MAX_LENGTH` (256), and only then is the destination column re-keyed evenly as one
    contiguous block (`rebalanceColumn`) — the one rebalance this scheme does. A rank STRING readers
    cannot use is kept in the file (like an unknown category) and re-keyed by the next write into
    that column; a non-string is dropped. A card assigned twice (a clean git merge can do that)
    keeps its FIRST assignment everywhere — `sanitizeKanban`, `columnOrder` and `placeAssignment`
    (which removes every copy of the moved card, as the pre-rank `assignNode` did). **Every write goes
    through `placeAssignment`** (renderer `assignNode` AND the relay's `setProjectCardColumn`), which
    also keeps the array in rank order so a build that ignores `rank` shows the same column — the
    brief's two goals ("a move is a one-line diff" and "keep writing the array in rank order") pull
    against each other, and the resolution is to move as little as the second allows: a
    cross-column move whose array slot already sits between its new neighbours changes ONE entry in
    place (two lines: `columnId` + `rank`); otherwise its block moves next to its successor; a
    reorder WITHIN a column always moves a block (the array must change for an old build to see
    it). A destination column is repaired first when it must be — missing/invalid/colliding ranks
    re-keyed in the order it was already showing (only those entries change; a board's first write
    into an unranked column ranks it once), an array that disagrees re-slotted within the column's
    own positions. MEASURED with `git merge-file` (`core/kanban-rank-merge.test.ts`): two
    ADJACENT cards filed into Done concurrently conflict under array-only placement and merge
    cleanly with ranks; two NON-adjacent ones merged cleanly either way, so do not claim more than
    that. The file's own `rev`/`savedAt` header still conflicts on any concurrent save — untouched.
  - **Saved views** (`kanban.views: [{id, name, query}]`, `@shared/kanban-views`) are SHARED
    content: a query carries source, labels, members and columns (the member and column filters are
    board filters of their own). `viewQuery` is the ONLY builder and reads only those four, so the
    status chips can never enter a view. The ACTIVE view and "show closed" are per user
    (`kanbanDisplay`), restored on entering the board; a view a teammate deleted is ignored.
    Deleting a view confirms (it goes for everyone). `sanitizeViews` runs inside `sanitizeKanban`,
    keeps query fields it does not know, and `KANBAN_VIEW_SOURCES` is pinned to the renderer's
    source registry (the shared sanitizer cannot import it).
  - **Handoff pings** (`lib/handoffPings.ts`): the `assign` verb notifies a card's ASSIGNEE (this
    machine's presence name) when an agent files it into a `done` column or a `started` column past
    the board's first — never on routine moves, and not for needs-you (the existing agent-status
    alert already covers every agent node). Same consent, background-only rule and per-node
    cooldown as the turn-end alert, and a handoff ping arms a one-shot FOLD so the Stop hook that
    follows seconds later is not a second notification for the same moment. The fold lasts only
    while the user is away: a window focus in between drops it (`installHandoffFocusReset`), or the
    next chime — for a turn the user sat and watched — was swallowed. v1 is agent-driven
    moves only: a teammate's move arriving by git, or the phone's relay move, pings nobody.
  - **Team progress** (`lib/teamProgress.ts`, `components/TeamProgressChip.tsx`): a session that
    opened stations shows "N of M done" as a small ring on its board card, its card modal header
    AND its canvas node header — ONE component, so three views of one node cannot count
    differently; clicking it lists the stations and a row travels to that node. A station is a
    session node that is the target of an OPENER rope. Ropes carry two relations — "opened by"
    (`ctrl-<source>-<node>`) and a wait (`--after`, the verify panel), which is minted
    `ctrl-after-<dep>-<node>` (`waitRopeId`, `lib/edgeModel.ts`) and skipped. **The mark is what
    makes this hold, not rope order**: the canvas prunes every rope with an endpoint off the canvas,
    so deleting an orchestrator (or the user deleting its rope, or a `--project` open whose opener
    lives in another project) removed the opener's rope, and under the old "first rope is the
    opener" rule the first surviving wait read as the opener — a pipeline's upstream station showed
    the next one as its team, a verify panel's reviewed node showed its reviewers. Canvases saved
    before the mark are re-marked at LOAD by append order (`markLegacyWaitRopes`: every rope into a
    node after its first is a wait), which must run before the prune; one already pruned and saved
    has lost that evidence. **A node that records its opener (`data.openedBy`, the station-notice
    stamp) closes that residual**: only the recorded opener's rope may claim it, so a surviving
    wait is never promoted; the rope still has to exist (delete it and the station leaves the team,
    the same pair the station-failure notice reads). Nodes opened before the field keep the rope
    rule. Tests run the canvas's load → heal → prune steps before `stationsByOpener`. Rules the count keeps: **unknown is unknown, never done** (state is
    transient; after a restart a station reads `unknown` until it reports), paused/hibernated count
    as a finished turn (both come only from an exit that refuses a working or blocked session), a
    CLI that announced its exit (`sessionEnded`) reads `ended` and counts (it is not running and
    never will be on its own — `unknown` would hold the ring below complete forever), a held launch
    reads `queued`, `done` + `lastTurnError` reads `errored` (the `--after` verdict), a station that
    can never report (plain terminal, hook-less agent) is listed as "no status" and kept OUT of M
    (the line `--after` draws), and a deleted station is not a station.
    Subscriptions: each chip reads `teamProgressSig` — one character per station, no ids — never
    `byId`; the per-project board gets the teams as a prop from Canvas, the Omni lanes derive
    theirs from the stored `p.ropes`/`p.nodes`, and the canvas node header reads `useTeamStations`
    (`state/teamStations.ts`, a transient store Canvas publishes from its live control ropes). The
    previous map is threaded back into `stationsByOpener`, so an unchanged team keeps its array
    identity across drag frames and nothing re-renders. Desktop + Server Edition identical;
    Mobile: follow-up (the phone board would need the ropes).
  - **The card does not repeat what its place says** (`lib/cardRedundancy.ts`). The session-name
    chip is hidden when it is the card's title (agent titles auto-track it) — the same rule the
    canvas node header has always had, now one function for both — and a past due date in a
    done/closed column keeps its date but drops the overdue alarm. The card MODAL keeps both facts:
    its header names a session that differs from the title, and its Due strip still says
    "Overdue". Audited and NOT hidden (written in the module so the next audit does not re-derive
    it): the card never names its column or its project, and there is no badge that restates a
    column category — RUNNING / NEEDS YOU describe the agent's turn right now, which is exactly
    what an idle card in In Progress needs distinguished.
  - **`bridges` / `ropes` are admitted through `sanitizeLinks`** (`core/workspace-files.ts`) on the
    same seams as `sanitizeKanban` — `fileToProject`, `projectToFile`, the inline-project branch
    and the legacy v2 path of the store — and on `persistedCanvases`, which reads the RAW index entry
    and last-written file for the context-link map (`buildBackgroundLinkMaps` iterates every
    bridge). They are git-shared, hand-editable input that every reader
    maps as `BridgeLink[]`, and the canvas's rope restore threw on one `null` entry at project load.
    A non-list is dropped, an entry without non-empty string `id`/`source`/`target` is dropped, and a
    clean list comes back BY IDENTITY.
  **Phone** (nodeterm-ios): must at least not break on `category`, `rank` or `views` (extra JSON
  keys its board decoder ignores). The relay-served move now lands at the top with a rank, while
  the phone's direct-SSH writer (`KanbanBoardWriter`) still appends without one — the next desktop
  write into that column ranks it, and array order already shows it correctly. `KanbanDefaults`
  should gain the three categories. All three are the iOS follow-up, not desktop work.
- **Omni Kanban (global swimlanes)** (`components/kanban/GlobalKanbanView.tsx`; one swimlane per open project; `state/viewMode.ts` `globalKanban` (localStorage `nodeterm.globalKanban`, machine-local, like `viewByProject`) + `settings.omniKanbanEnabled` (feature gate, default OFF, `settings.json`) / `omniKanbanAsDefault` (when true, `view.kanbanToggle` — Cmd+Shift+B — opens Omni; otherwise per-project; `view.globalKanbanToggle` registry command — unbound, remappable — always opens Omni when enabled); **Omni is a SCOPE of the kanban side, not a third view**: the view toggle (tab icon, ⌘⇧B, the menu) flips canvas ⇄ board, and a board header's `KanbanScopeSwitch` ("This project" / "All projects", rendered only while the feature is on) moves between the two scopes — so leaving Omni through the switch lands on the project's board, and the view toggle from Omni lands on the canvas (it used to fall through to whatever the project's view happened to be, so "Canvas view" from Omni could land on a board). The decisions live once in `state/viewMode.ts` (`toggleBoardView` / `toggleAllProjectsBoard` / `showProjectBoard` / `showCanvas`), called by TabBar, the menu IPC and both registry commands; Omni has no close button. `globalKanban` deliberately stays independent of the active project, so a project switch made from a lane does not drop the user out of Omni. `isGlobalKanbanOpen()` is the single gate (fail-closed, static import of `useSettings` — the earlier `require` failed open in the packaged renderer). Non-active lanes are derived from serialized `p.nodes` via `toKanbanSessionState` (the persisted-state counterpart to `toKanbanSession`); the ACTIVE project's lane is fed LIVE by Canvas (`GlobalKanbanLive`: the same `kanbanSessionsFrom(nodes)` cards + live `teamStations` the per-project board uses), because its edits reach the store only at the next ~800 ms autosave — a store-fed lane reverted the card modal's controlled sticky textarea on every keystroke and pruned the assignment of a card created a moment earlier. The open card modal is ONE overview-level fact reported to Canvas's `setKanbanModalNode` (watched for Eco, wake-on-open, dictation target), never per-lane state; each lane's board write resolves ITS project's session (`sessionForProject`) for the hosted read-only refusal and the board-log api; `pendingLaunch` never becomes `initialCommand` in the modal (the DAG launch must fire only when dependencies report done, and the canvas `TerminalNode` already delivers `initialCommand` via `writeWhenShellReady` after the `nodeterm:create-node` project switch). Active-project edits (rename / sticky / browser nav) route through Canvas live nodes (`setNodes` + `markDirty`), non-active through the store + `writeDisk`; delete uses `ConfirmDialog` (not `confirm`) and then `deleteNodes` (active project) or `closeStoredNodes` (any other) — the existing cross-project teardown funnel, never a hand-rolled copy. The top bar's project pills and Cmd/Ctrl+1..9 (`nodeterm:swimlane-jump`) jump to the lane; header hint shows the correct mod (`Cmd` on Mac, `Ctrl` elsewhere). Server Edition works as-is, Mobile N/A.
- **Settings** (`SettingsPage.tsx`, ⚙ / ⌘,): font/cursor (live to xterm + Monaco), default
  shell, grid + snap, **default node size** (one row with a kind picker: terminal/agent is the
  `defaultNodeWidth`/`defaultNodeHeight` pair, clamped in `terminalNodeSize()`; every other kind
  the add menus create is an optional entry in `defaultNodeSizes`, resolved by `defaultNodeSize(kind)`
  in `state/workspace.ts` through `@shared/default-node-size`, which clamps hand edits to the kind's
  `NODE_MIN_SIZES` and 2400×1600 — new factories must place through `placeSized`, not a literal
  `*_SIZE`, or the setting silently stops applying to that kind; the agent `settings` verb exposes
  only the terminal pair),
  pan-hover delay, double-click focus, accent, tmux on/scrollback, commit agent,
  `seenShortcuts`. **Every section is MOUNTED whenever Settings is open** — an inactive one
  returns null from `SettingsSection`, but its hooks and the whole render body above that return
  still run. So a throw in a section the user never navigated to blanks the entire page: #1090
  (0.4.0) was `GitHubIssuesSection` calling `dispatchBindingFor` during render, a closure over a
  `const repository` declared ~140 lines lower (below the early returns) — a TDZ ReferenceError on
  every Settings open once dispatch was switched on for the active project. **tsc does not flag a
  closure that reads a later `const`**, only a direct read, so declare anything a render-time
  helper closes over ABOVE the helper. Each section is now wrapped in `SettingsSectionBoundary`,
  which contains a throw to that section (fallback shown only while it is the viewed one) — keep
  new sections inside one.
- **Shortcuts** (`ShortcutsPanel.tsx`, ? / ⌘/): shown once on first launch (`seenShortcuts`).
  **Derived from the registry, never hand-listed** — see the Keybindings invariant below.
- **Welcome** (`WelcomeScreen.tsx`): shown when no projects exist.
- **Nothing raises the window without a user action** (issue #737, the THIRD in this family —
  #665 and #702 were canvas-control moving the user's VIEW; this one is the OS window activating
  over another app). The cause was `win.on('ready-to-show', () => win.show())`: `ready-to-show`
  fires on the first paint of EVERY main-frame navigation, not once per window (MEASURED on
  Electron 42.9.1 — a `webContents.reload()` on a VISIBLE window emits it again with `isVisible()`
  already true), and the crash auto-reload (`render-process-gone` → `webContents.reload()`) is an
  unattended navigation. So a backgrounded renderer being killed — macOS jetsam on a machine
  running several agent CLIs at 335 MB–1.2 GB each — silently raised nodeterm over whatever the
  user had ⌘Tabbed to. It is `win.once` now. **The gate must be FIRST PAINT, not `isVisible()`**:
  after macOS hide-on-close the window is hidden but alive, and an `isVisible()` gate would `show()`
  it on a background reload — the same bug inverted.
  The permitted raises are all a CLICK, and they are enumerated with their triggering action in
  **`src/main/window-raise.guard.test.ts`**, an allowlist-with-reasons in the shape of
  `fs-atomic.guard.test.ts`: a notification tap (the one exception the rule names), a Notch HUD
  row, a Dock activate, a second launch, and a file dropped onto a terminal. Nothing an AGENT can
  do reaches any of them — canvas control, trigger nodes, hook POSTs, relay/pairing/push and
  browser-drive contain no show/focus/dialog call, and agent confirms are in-renderer
  `ConfirmDialog`s, never native. The drop IPC's `app.focus({steal:true})` is the only
  renderer-reachable cross-app activation and now carries the same sender guard its two neighbours
  (`uiShortcutRecording`, `uiTerminalFocus`) already had — a `<webview>` guest is a webContents in
  this process. **KNOWN GAP, listed in the guard rather than fixed**: `standing-host.ts`'s
  `dialog.showErrorBox` for a locked keyring is app-modal, unparented, and raised from the relay
  RECONNECT TIMER; the honest fix routes it to a non-modal in-app surface and owes a macOS check
  that a sheet on a background window does not activate.
- **Window geometry is REMEMBERED** (`main/window-state.ts`, `<userData>/window-state.json`) — size,
  position and maximized state, restored at the next launch. Before this the window opened at a
  hard-coded 1400x900 every time, on every platform, so a user who works maximized re-maximized it
  on every launch; Electron persists nothing on its own and no platform does it for us. The module
  is Electron-free in the `keydown-intercept.ts` shape (pure decisions over plain rectangles,
  structural window interfaces), so the refusals below can be pressed by a test instead of only by
  someone with two monitors — `screen.getAllDisplays()` is called at the seam in `index.ts` and its
  **work areas** (not full display bounds) are passed in. The refusals ARE the feature, because each
  is a way the naive version is worse than the fixed size it replaces:
  - **While MAXIMIZED the size comes from `getNormalBounds()`, never `getBounds()`.** The latter
    returns the MAXIMIZED rectangle, so saving it makes the next un-maximize hand back a
    screen-sized window — state that looks right and behaves wrong, and only for the users who
    maximize. **Un-maximized it is `getBounds()`**, which is the same rectangle wherever both work:
    Electron documents `getNormalBounds()` as supported only on some Linux desktop environments, and
    the common case must not depend on the window manager. The maximized case still does and cannot
    be helped from here, but it matters less, because that record restores by re-maximizing rather
    than by its size.
  - **A position that is no longer reachable is DROPPED, not clamped.** A laptop undocked from the
    monitor its window was on would otherwise reopen the app off-screen: running, focusable from the
    dock, visible nowhere, with no gesture that rescues it. Reachable means a real overlap with some
    work area (`MIN_VISIBLE_WIDTH`/`HEIGHT`), judged against the CLAMPED size — a few pixels on
    screen is not a title bar anyone can grab. **Overlap alone is not enough, because it is
    symmetric**: a monitor mounted ABOVE the laptop and then unplugged leaves a record whose BOTTOM
    edge clips the laptop's work area by enough to clear the height floor while the title bar sits
    hundreds of px above the screen — and under `titleBarStyle: 'hiddenInset'` the title bar is the
    whole drag region. So the window's TOP edge must also land on that work area, within
    `TOP_OVERHANG_SLACK` (24px, because window managers report decorations inconsistently and a few
    pixels of overhang must not cost the user their position every launch). The rule is per-display,
    like the overlap it joins. Dropping keeps the user's size and lets the platform place a window it
    knows how to place; inventing a corner for it is the guess.
  - **No capture while minimized or fullscreen.** `isMaximized()` is FALSE while a macOS window is
    fullscreen, so capturing there records `maximized: false` and erases exactly the preference this
    exists to remember. The last non-fullscreen state stands, which also means the app never reopens
    INTO fullscreen — deliberate: a fullscreen window is usually a temporary mode and is much harder
    to escape on first launch than a maximized one.
  - **Maximize before the first paint**, while the window is still `show: false`; maximizing after
    `show()` is a visible jump from the restored size on every launch.
  - Every field is **re-validated as a number on read** — the file is hand-editable and its values
    reach the `BrowserWindow` constructor before there is a window in which to report a failure.
  - Saves are debounced (`resize`/`move` fire continuously through a drag) and flushed
    **synchronously** on `close`: that is the only moment guaranteed to see the final state, and an
    awaited write there races the process exit. Published through `renameAtomicSync` with a
    per-call unique temp, like every other store.
  - **NT_MULTI is excluded**: a throwaway dev sandbox may share the real app's userData, and it must
    not move the window of the app being developed.
  - Desktop only, and genuinely so — a browser tab's geometry is the browser's, and the mobile
    companion has no window. Nothing here belongs in `src/core`. **Wayland caveat**: a native-Wayland
    client cannot set its own position (the compositor owns placement), so x/y is honoured under
    XWayland and quietly ignored otherwise. Size and maximized restore either way, which is what the
    drop-don't-clamp rule already degrades to.
- **Window chrome**: macOS integrated title bar (`titleBarStyle: 'hiddenInset'`); the tab
  strip's stationary viewport is the only `no-drag` region for its contents. Explicit regions on
  scrolled descendants escape the overflow clip in Electron's native hit test and subtract from
  the wordmark after scrolling (#847). Keep tab/button/input descendants at the initial `none`;
  the viewport already excludes dragging over them. `scripts/tabbar-drag.test.ts` uses real
  Electron and native XTest input on a disposable Xvfb display (CDP input bypasses this hit test).
  It checks 41 tabs at start/partial/middle/end/back, 28/40/64px heights and both padding modes;
  it does not verify macOS traffic lights, Windows, or movement under a real window manager. The
  bar (`TabBar.tsx`) is the drag region with the `nodeterm` logo + a **Chrome-style tab strip**
  (2026-09-16): inactive tabs are flat and separated by a 1px divider that drops on both sides of a
  hovered or active tab, hover is an inset pill, and the active tab is `--canvas-bg` with rounded
  top corners and two concave flares (`.tab.active::after`, radial gradients) so it merges into the
  surface below — which is also the kanban overlay's colour, so it merges under both views. In
  LIGHT the strip steps back to `--surface-deep` (`--tabbar-bg`), because `--panel` and
  `--canvas-bg` are one value apart there and a canvas-coloured tab would vanish.
  **A tab is as wide as its own NAME and never shrinks** (`max-width: var(--tab-max)` 260px,
  `flex: 0 0 auto`; the name is `flex: 0 1 auto; min-width: 0` with `text-overflow: ellipsis`): the
  strip SCROLLS when the tabs stop fitting, and nothing shortens a name except that cap. This is
  the deliberate departure from Chrome, which shrinks because it must keep every tab reachable
  without scrolling — here the sessions sidebar and ⌘1..9 both reach a project without touching
  the strip, so a readable name is worth more than a visible tab edge.
  **Two earlier rounds tried to ration the name between tabs and both spent the one thing the strip
  is for**, which is why the third does not: #789 gave every tab one flex basis (at 8 tabs / 1340px
  the ACTIVE name measured 24px — zero characters — because it carried the most furniture and hit
  its floor first), and #790 added a 60px floor plus a `tabDensity` level that shed furniture to
  pay for it — whose middle level hid the SSH chip, and 8 tabs in a 1340px window land on exactly
  that level, so every remote tab lost its `SSH` label at the width people work at.
  **`renderer/lib/tabDensity.ts` is deleted**: with full names there is no name budget to protect,
  so there is nothing for a density level to buy. Do not reintroduce one without first saying what
  it is buying. Measured on the third shape (headless Chrome, the real CSS, 86px traffic-light
  reservation): 8 tabs in 1340px — every name whole, every SSH chip present, the strip 14px past
  its width; 12 tabs — every name still whole, the strip scrolling 559px; a 60-character project
  name stops at the 260px cap and is the only thing that ellipsises.
  The fade mask went with the shrinking: a mask gradient is unconditional and would fade the tail
  of a name that fits perfectly, while `text-overflow` is self-conditioning. **The bar's height is ONE number in two places that cannot read each
  other**: `--tabbar-h` in styles.css (every top-anchored panel, the kanban overlay and the usage
  popover position against it) and `TABBAR_HEIGHT_PX` in `@shared/window-chrome-metrics`, from
  which main derives the traffic-light `y` (`trafficLightY`) — a literal 15 for a 44px bar was
  what made shrinking the bar hazardous. It is **40px** (36 for one release, which read as cramped
  once the tabs carried whole names) **by default — the height is a SETTING**
  (`settings.tabBarHeight`, Settings → Appearance, 28–64): `App.tsx` writes the resolved value to
  `--tabbar-h` on `<html>`, and main re-centres the macOS traffic lights on the same settings
  change (`win.setWindowButtonPosition(trafficLightPositionFor(h))`, change-gated), so the two
  cannot disagree. Every reader goes through `resolveTabBarHeight`, which answers the default for
  a non-number and clamps — the floor is what keeps the 12px lights inside the bar. The stylesheet
  token keeps the default LITERAL so an un-hydrated renderer draws the default bar, not none.
  `styles.tabbar.test.ts` pins the token to the constant and
  every dependant to the token. The New-project `+` is a **sibling** of `.tabbar__tabs`, not its last child — inside
  the scroller it vanished once the strip overflowed (no visible scrollbar to hint it was
  still there). The wrapping `.tabbar__projects` is `flex: 1` and stays a drag region (not
  `no-drag`); the pill itself must not be `flex: 1` or it inflates into an empty capsule.
  Cmd+M is intercepted in `main/keydown-intercept.ts` (`before-input-event`, installed from
  `main/index.ts` — else macOS minimizes) and forwarded to the renderer via `app:toggle-markdown`;
  Cmd+W (`app:close-node`) and Cmd+0 (`app:zoom-actual-size`) are taken back the same way. **The
  application menu is OURS**: `buildAppMenu` (`main/index.ts`) calls `Menu.setApplicationMenu` and
  re-runs on every settings change. (This bullet used to claim we never call it — false since that
  function landed; check the template, not Electron's defaults.) **COMMAND-style accelerators are
  handled ABOVE the page on every platform** — Minimize, Close, Toggle Kanban Board, Settings,
  Reload — so a chord one of those owns never reaches the renderer, which is why those three are
  stolen in `before-input-event`. **This is not a blanket claim about the whole menu:** the Edit
  submenu's standard `{role:'cut'|'copy'|'paste'|'selectAll'|…}` items behave differently — Chromium
  routes them into the focused element, so ⌘C in a terminal or a text field does the ordinary thing
  and does not need stealing. Ask which kind an item is before reasoning from this bullet.
  That difference is also why the **stand-down has a menu leg**: while a terminal
  owns the keys under `terminal-first` **or while a shortcut recorder is armed**
  (`menuStandsDown(shortcutRecording, policy, terminalFocused)`), `syncMenuForStandDown` disables
  the command-style items
  named in `menuItemIdsToSuspend` — Minimize (`MENU_ITEM_ID_MINIMIZE`), **Toggle Kanban Board
  (`MENU_ITEM_ID_KANBAN`, ⌘⇧B)** and **Settings (`MENU_ITEM_ID_SETTINGS`, ⌘,)** on every platform,
  plus Close (`MENU_ITEM_ID_CLOSE`) on Windows/Linux — because a disabled item suppresses its
  accelerator and only then do those chords fall through to the terminal, or to the recorder.
  Off-mac the Close item is ALSO disabled whenever a terminal has focus, policy or no policy
  (`closeStandsDownInTerminal`, issue #383): its role owns the Ctrl+W accelerator, and that
  keystroke in a shell is readline's kill-word. The
  recorder leg is why ⌘M is bindable at all, and it fixed a live misfire: ⌘⇧B pressed into an armed
  recorder used to open the kanban board behind the Settings dialog, and ⌘, to re-open Settings.
  Kanban and Settings are
  the ones a reader gets wrong: they are **not** intercepted chords at all but ordinary registry
  commands (`view.kanbanToggle` / `app.settings`), so the renderer's dispatcher could never stand
  them down itself — under app-first the menu takes them before the keydown exists, which is also
  why their capture NOTICE is raised at the IPC receivers in `Canvas.tsx` rather than by the
  dispatcher. **Reload (⌘R / ⌘⇧R) is the named exception and stays live while stood down**: it is
  the crash-recovery lever (a wedged renderer is exactly when it is needed) and a main-frame
  navigation is one of the three sites that reset `terminalFocused` / `shortcutRecording`. **Of the
  items main suspends, Reload is therefore the deliberate exception** — the one it holds back from a
  shortcut recorder — which is what the Keyboard Shortcuts section's description now says.
  **KNOWN GAP, pre-existing and accepted:** the suspend list only ever covered the command-style
  items the terminal-first policy needed, so the always-on app roles — `quit` (⌘Q), `hide` /
  `hideOthers` (⌘H / ⌘⌥H), `toggleDevTools`, `togglefullscreen` — still act while a recorder is
  armed (⌘Q pressed into one QUITS the app). They are deliberately NOT added: ONE list drives both
  stand-downs, and making ⌘Q/⌘H unreachable for a terminal-first user is the worse trade — quit and
  hide must never be policy-gated. Splitting the list per stand-down is the change that would close
  it, and it has not been made.
  `keydown-intercept.test.ts` pins both the stolen chords and the suspended item ids (including
  that the list does not silently grow) — `getMenuItemById` answers `null` for a typo and the
  fail-safe is to do nothing, which is indistinguishable from the feature working.
- **Theme**: macOS dark palette as CSS tokens in `styles.css` `:root` (`--accent` = systemBlue,
  label/separator opacities, SF font stack). Canvas background is black with dot grid.

## Idle energy: an animation is a frame loop, not a decoration

**A running CSS animation obliges the compositor to produce a frame every vsync — on a ProMotion
display 120 of them a second — for as long as it runs, and each of those frames re-rasters and
re-composites the whole window.** That cost is paid once for the WINDOW, not once per animation, and
it does not care whether anybody is looking: an unfocused window that is still visible (a second
monitor, half behind an editor) is not `document.hidden` by any definition Chromium uses, so it
keeps producing frames at full display rate.

MEASURED on the Server Edition, 40 terminal nodes on one canvas, headless Chrome, 25 s idle windows,
total CPU across every Chrome process (`/proc/<pid>/stat`):

| state | CPU |
|---|---|
| idle, nothing animating | **1.5 %** |
| **one** visible node with the `working` glow | **33 %** |
| five | 66 % |
| twenty | 101 % |
| twenty, but all panned OFF screen | 2.2 % |
| twenty, under an opaque full-screen overlay | 12.8 % |
| twenty, `animation-play-state: paused` | **1.6 %** |
| twenty, `animation: none` + a static opacity | 1.9 % |
| first-run mobile-launch card open (5 animations, no node glows) | 97 % |

Four things to take from that table, because each one contradicts a reasonable guess:

- **The step is at the FIRST animation, not the twentieth.** What costs is that frames are produced
  at all. So a gate that covers most of the app's animations buys nothing — one that keeps running
  holds the frame loop open, while everything the gate DOES cover still looks correctly frozen. That
  is why `--nt-anim-state` is applied to EVERY `infinite` animation in `styles.css` and enforced by
  scan (`styles.animation-gate.test.ts`) rather than applied to the worst few by hand.
- **Offscreen nodes are already free** (2.2 %): Chromium skips raster and compositing for layers
  fully outside the viewport. There is nothing to fix there, and a viewport-gated animation would be
  work with no measurable return. A canvas of 119 nodes costs what its VISIBLE animated nodes cost.
- **`paused` is as cheap as `none`** (1.6 % vs 1.9 %), so the gate freezes each animation where it
  stands instead of snapping it to a resting frame — nothing MOVES at the moment focus is lost, and
  refocusing resumes rather than restarts.
- **The renderer's MAIN thread is idle throughout.** Over the 25 s window with one node pulsing,
  `Performance.getMetrics` reported 0.15 s of `TaskDuration`, 1 layout and 51 style recalcs, while
  the renderer PROCESS burned 14.8 % and the GPU process 17.9 %. This is compositor and raster work,
  invisible to every JS-level profiler and to a timer census.

**What the numbers are NOT.** Headless Chrome here rasters in software (SwiftShader), so the
absolute percentages are inflated relative to a real GPU and none of them is a prediction about
macOS. What the A/B establishes is the MECHANISM and its direction; the magnitude on a given machine
has to be measured there (`powermetrics --samplers gpu_power,tasks`, and Activity Monitor's Energy
Impact, which weights GPU use and wakeups heavily).

**Timers are not the problem, and the census that said so is worth not repeating.** Over the same
idle window the renderer fired **56 timer callbacks in 30 s** (~1.9/s: 40 per-node liveness polls at
1/30 Hz, the 2 s terminal-focus mirror, the 30 s host-RAM read) and **zero** `requestAnimationFrame`
callbacks — the default renderer path has no self-perpetuating rAF loop (glyphgrid's parks after 30
idle frames and is opt-in; the dino game's is focus-gated). Before adding a timer gate for energy
reasons, measure: at these frequencies a JS wakeup is nothing beside one frame of compositing.

**The board is the second gate, and it is a SEPARATE attribute on purpose.** The canvas stays
mounted under the kanban overlay (`display: none` would 0x0-resize every terminal into a tmux
SIGWINCH), so its glows and pulses keep animating under something nobody can see through — 12.8 %
in the table above. `renderer/lib/canvasCovered.ts` marks `data-nt-canvas="covered"` for as long as
a full-page board view is MOUNTED (mount is the signal: both board views are conditionally
rendered, so it cannot drift from the view state the way a recomputed `kanbanOpen` flag can, and it
needs nothing from Canvas), and `:root[data-nt-canvas='covered'] .react-flow` overrides
`--nt-anim-state` on that subtree alone — the variable INHERITS, so that one declaration is the
whole gate for every animation reading it. It is not a second writer of `data-nt-window` because
the two facts are independent (a board on a focused window; an unfocused window with no board) and
one attribute with two owners is a race over who clears it. The claim is refcounted: React can
mount the incoming view before unmounting the outgoing one, and a plain set/clear pair would let
that unmount erase the live view's claim.

**The board gate does not stop xterm; `terminal/board-render-pause.ts` does.** CSS reaches the glows,
not the terminals: xterm pauses only on its own GEOMETRIC IntersectionObserver, and a node under
the board still intersects. MEASURED BEFORE the pause (dev, 12 streaming terminals): board open
36.5 % GPU vs 0.0 % over silent terminals, and `visibility: hidden` on the canvas 35.5 % — no help.
The number WITH the pause has not been measured. Each
TerminalNode wraps its RenderService's `_handleIntersectionChange` so xterm is told "not
intersecting" while `boardOpen` (Omni included) is up and the node is not the focus-mode node (the
focus surface, z 40, sits above the board, z 25); uncovering replays the real entry through xterm's
own resume and then `fullRepaint`. Parsing never stops, so nothing is lost. Two rules: never fold
the board into `reportVisible` / the WebGL budget's visibility (that verdict drives hibernation and
the offscreen teardown — the board would put the very sessions it shows to sleep), and any other
"is the board up" predicate must OR in `isGlobalKanbanOpen()` (`boardCoversCanvas` missed the Omni
board until this change, the same omission 12564a20 fixed for focus restore).

**Specificity is the quiet failure mode in all of this, and it has already happened twice.** The
three glows carry their own `animation:` shorthand, which RESETS `animation-play-state` — so
inheriting the variable does nothing for them and every gate has to name them explicitly. A first
draft of the covered rule used `.react-flow__node::after`, lost to
`.react-flow__node:has(.term-node.working)::after` on specificity, and measured EXACTLY the
unpatched number while looking correct in the diff. When you add a gate, verify the COMPUTED
`animation-play-state` on a real element, not the presence of the declaration.

The gate itself: `renderer/lib/windowActivity.ts` sets `data-nt-window="idle"` on the document
element when the window loses focus or the page hides, `:root[data-nt-window='idle']` flips
`--nt-anim-state` to `paused`, and the three per-node glows take a static-lit rule instead of the
shared pause — pausing freezes a glow wherever its clock stopped, and the glow that says "this
agent finished while you were away" must still be on screen when you come back to look for it. `hud.css` is deliberately excluded: the notch HUD's window is never focused, so the
shared gate would freeze it permanently rather than while nobody is looking.

**The working and unread glows are BOUNDED; the attention glow is not.** The idle gate only helps an
unfocused window, and an agent mid-turn in a FOCUSED one kept `nt-working-glow` looping for the
whole turn — MEASURED (production build, M2, focused): one visible working node cost **+3 points
total CPU and ~25 style recalcs/s** for as long as it ran. It now runs 4 cycles of 2.6 s (~10 s) and
rests at `opacity: 0.7`, the same static-lit value the idle gate and Reduce Motion already hold it
at; the keyframes start and end at 0.7, so the settle is seamless. A new turn re-adds `.working`,
which restarts the pulse — and so does anything else that re-applies the animation: a window
refocus (the idle gate sets `animation: none`, so lifting it starts the shorthand afresh) and a node
remount (a project switch, a park re-adopt) each replay the four pulses. Still bounded every time.
**Unread is bounded the same way** (4 cycles of 2 s, resting lit at `opacity: 0.85`), and so are the
minimap's working and unread beats (`mm-pulse-soft` / `mm-pulse-unread`, resting at full stroke), and
a WAITING `--after` rope is dashed + ⏳ but no longer `animated` (React Flow's `dashdraw`, 0.5 s
infinite): an unread node stays unread until someone looks, and a wait can last hours, so on a busy
canvas those three kept the frame loop open indefinitely. MEASURED (46-node SSH canvas, 14 unread
nodes, 8 waiting ropes, FOCUSED window, dev build): idle renderer+GPU **~120% → ~25%**, and pausing
every remaining animation no longer moves it. Pausing any ONE family alone saved far less (85–104%),
which is the first-animation step above again. Only the attention glow (and its minimap beat) and
React Flow's animated edges (working subagent and loop edges, the driven-browser rope — see the
`dashdraw` paragraph below) stay infinite — needs-you is the one state that must keep pulling the
eye, and an edge animates only while its work runs — and the idle and covered gates pause all of
them when nobody is looking. The driven-browser rope still flows (it lasts only while an agent
drives the page).
`styles.animation-gate.test.ts` pins the bounded shorthands, the resting values and the keyframe
endpoints.

**React Flow's `dashdraw` is gated in `styles.css`, not by xyflow.** Every `animated` edge (working
subagent and loop edges, the driven-browser rope) and an animated connection line run xyflow's own
`dashdraw 0.5s linear infinite`, from a vendor sheet that never reads `--nt-anim-state` — so until
this rule it escaped BOTH the idle and the covered gate. MEASURED (dev build, one synthetic edge with
React Flow's real classes, idle gate set, 3 alternating 30 s rounds): Liquid Glass 79 % GPU + 36 %
renderer and +340 MB GPU footprint; dark 31.5 % + 29 %. With the play-state rule injected over CDP
(not the shipped stylesheet) the edge fell to the no-edge baseline of that run, 0.5 % / 3.3 %; the
shipped build has not been measured. The rule repeats xyflow's selectors verbatim (same specificity, wins on order after the
`@import`), and `styles.animation-gate.test.ts` scans the vendor sheet for infinite animations, so an
xyflow upgrade that adds one fails there. A FOCUSED window still pays the full per-edge cost while an
edge works; a cheaper working-edge style is an open design call (the driven rope keeps flowing).

**The viewport is never promoted — not even while the camera moves.** A `will-change: transform`
on `.react-flow__viewport` during pan/zoom was tried (00c9c5fc, measured 41–48% → 30–36% CPU on
12 WebGL terminals) and removed: the viewport layer spans the WHOLE canvas, and Chromium rasters it
at a scale it ratchets up during a zoom and never lowers. MEASURED on a 46-node SSH canvas (41
terminals, 1470×923 @2x, CDP-driven wheel zoom 0.8 ↔ 0.12 and pans, dev build): with it, 41–252
`tile memory limits exceeded, some content may not draw` warnings per gesture round — blank tiles,
which users saw as the canvas flickering on zoom — and no CPU gain (~170% total during the gesture
either way; the scripted gesture itself ran 36 s vs 28 s); without it, 0. The small-canvas gain
does not survive a real canvas. `canvas/camera-moving.test.ts` pins the absence.

## Performance: measure it, then fix what the measurement names

Performance work in this app has been wrong by intuition more often than right, so the rule is
the one every bullet below learned the hard way: **measure on the real thing, find the mechanism,
fix that, measure again — and write the before/after in the commit.** Say which build the
numbers come from (a dev build's React is several times slower than production; a percentage
from one is a direction, not a prediction).

**How to measure (works on the dev app, no code changes):** start it with
`npx electron-vite dev --remoteDebuggingPort 9333` and drive it over CDP from a small Node
script (`fetch('http://localhost:9333/json')`, then a WebSocket to the page):
- `Runtime.evaluate` for DOM facts; a module's live instance is reached with
  `import(<its URL from performance.getEntriesByType('resource')>)` — importing the bare path
  after an HMR update gives a SECOND copy of the module and silently measures nothing;
- `Profiler.start/stop` for where main-thread time goes (group samples by the outermost APP
  frame, not by self time — self time drowns in React internals);
- `document.getAnimations()` for what is keeping the compositor busy;
- patch `ResizeObserver.prototype.observe` / `setTimeout` for a few seconds to count who calls
  them; `Input.dispatchMouseEvent` (`mouseWheel`, `modifiers: 2`) for zoom/pan gestures;
- process CPU from `ps -o time` deltas of the renderer + GPU processes (not `%cpu`, which is a
  lifetime average); tile/raster trouble shows as `tile memory limits exceeded` in the dev log;
- for SSH: the host's `journalctl -u ssh | grep -c 'Accepted publickey'` over the test window is
  the number that says whether multiplexing held (healthy ≈ 0–1 per connect).

**Rules this produced (each has its measurement in the linked section or commit):**
- **One running animation keeps the whole window at display rate** — see **Idle energy** above.
  Status animations are bounded (they settle lit), never infinite, except needs-you. Measured on a
  46-node canvas: idle renderer+GPU ~120% → ~25% (#1050).
- **Never promote the React Flow viewport** (`will-change: transform`) — it is a canvas-sized
  layer; on a real canvas it overran the tile budget (flicker) with no CPU gain (#1047).
- **A `backdrop-filter` is re-run every time its surface is drawn, and nothing caches it** — not
  for the surface's own content changes, not when moved to a sibling layer under the content (both
  measured). Glass on anything that updates often (a terminal) costs a full blur per update, and
  pixel-moving filters spread the damage to neighbouring glass. A plain `filter` on content that
  does not change IS reused. Liquid Glass terminals therefore frost a static wallpaper copy (see
  **Glass terminal nodes frost with a STATIC copy**): six streaming terminals 92% → 42% GPU. And an
  SVG `feImage` in a filter chain marks its whole surface damaged: keep reference filters off
  surfaces that redraw.
- **An all-filtered node-change batch must not reach `onNodesChange`** (`handleNodesChange` returns
  early). `applyNodeChanges([])` returns a NEW array; a new `nodes` rebuilds the ephemeral
  subagent/loop cards without `measured`, React Flow re-observes them and its ResizeObserver
  (`force: true`) emits another change — the whole Canvas re-rendered every frame while idle with
  one subagent card on screen (~111% → ~55% idle, #1047; `canvas-empty-changes.test.ts`).
- **Per-terminal work on a project switch must be coalesced and ordered.** A switch mounts every
  node in one tick. Join an in-flight read instead of issuing one per node (the SSH project's
  settings.json read, `overridesInFlight` in pty-manager), and let on-screen nodes go first
  (`PtyCreateOptions.onScreen` → `pty-spawn-gate.ts`): on a 41-terminal SSH project the visible
  ones went from painting LAST (1.5–2.1 s) to first (0.55–1.1 s), 0 extra logins (#1057).
- **A hint must fail toward the old behavior.** `onScreen` absent/unknown = on screen = the old
  FIFO; a coalesced read is never a cache (a spawn after it settles reads again).
- **Search a large in-memory text set with one case-insensitive RegExp per query, never by
  lower-casing each entry.** The transcript index (`core/transcript-index-core.ts`, `queryRegExp`)
  lowered every entry per keystroke: 20-52 ms and 7-15 MB garbage per search on a 16 MB index,
  vs 2-13 ms and 0 MB as one `RegExp(escaped, 'iu')`. A stored lowered copy would retain +32 MB.
  `iu`, not `i`: `i` loses hits `toLowerCase` found (Kelvin K, Å, ẞ); escape only SyntaxCharacters
  and `/` (`\-` is a SyntaxError in `u` mode). Even `iu` loses Turkish İ (it lowers to `i` +
  U+0307, so `türki` matched `TÜRKİYE`), so each i/I of the escaped query is widened to `[iİ]`.
  The snippet uses the same matcher. The index file
  persists through `writeFileAtomic` (0600), only when a `dirty` flag says the file is behind.

## SSH projects on Windows: the in-process transport

Windows' own OpenSSH cannot multiplex, and that is measured, not assumed (windows-latest,
`OpenSSH_for_Windows_9.5p2`): `ssh -M` fails with `getsockname failed: Not a socket`, and a child
carrying `ControlPath` FAILS rather than falling back — so every remote command, terminal and
tunnel of an SSH project failed on a stock Windows machine. Git for Windows' ssh (10.5p1) starts a
master but every session over it is reset and falls back to a full login per command. So on
Windows the app does not run the ssh binary for SSH projects at all: `src/core/remote-ssh/native/`
holds ONE `ssh2` connection per ControlPath and carries every exec, pty, SFTP session, reverse
unix-socket forward and dev-server `-L` forward over it. POSIX keeps OpenSSH untouched.

- **One switch:** `useNativeSsh()` — always on win32; `NODETERM_NATIVE_SSH=1` turns it on anywhere
  (how it is tested live from macOS against a real host), `=0` forces it off. Decided once per app
  run for the SshProjectManager runners.
- **Call sites do not change.** They keep building OpenSSH argv (`control-master.ts`);
  `ssh-argv.ts` is a STRICT parser that reads it back and refuses (by name) any option it does not
  know. A builder that grows a flag must teach the parser, or the native path fails loudly —
  `ssh-argv.test.ts` parses every builder's output.
- **Seams wired:** SshProjectManager's runners (`initSshProject`), pty-manager's
  `runAsync`/`runWithStdin` and the remote terminal itself (`NativeSshPty`, a pty channel shaped
  like `IPty`), remote-git, the setup runner (`spawnSshArgvStream`), the workspace poll's
  master check. A new ssh call site owes the same routing.
- **Semantics are OpenSSH's:** ControlMaster auto/no, `-O check|exit|forward|cancel`,
  `StrictHostKeyChecking=accept-new` over the user's own known_hosts (hashed entries included —
  that is why HMAC-SHA1 appears; CodeQL's alert on it is dismissed with the reason) — with the
  recorded host key TYPE pinned: the types on record lead ssh2's `algorithms.serverHostKey`
  (OpenSSH's order_hostkeyalgs, `hostKeyAlgorithmsFor`), and a host that HAS a recorded key but
  presents another type is refused like a changed key, naming both types and `ssh-keygen -R`
  (stricter than OpenSSH's accept-new, which records the new type; type-blind, a MITM holding only
  an ed25519 key against a host recorded under ECDSA was silently recorded and trusted). The
  list handed to ssh2 is always a reordering of `SSH2_DEFAULT_SERVER_HOST_KEY`, pinned to the
  package by test, because an exact list naming anything ssh2 lacks makes `connect()` throw; publickey
  only (agent, then key files, passphrase through the existing dialog, never in BatchMode), the
  user's `~/.ssh/config` via `ssh -G` (never a second parser of it), a dropped connection ends
  every channel with 255 (what `SshReconnector` reads).
- **Channels past the server's MaxSessions spill onto more connections** (10 on a stock sshd; a
  live 89-terminal project left 25 terminals blank before this). A refusal marks that connection
  full until one of its channels closes; overflow connections are bounded
  (`MAX_OVERFLOW_CONNECTIONS`) and live and die with the primary. A key unlocked with a passphrase
  is held in memory while any connection is alive so overflow connections do not prompt again —
  the Windows tradeoff for having no app-private ssh-agent.
- **Channel races — keep these, each was a real bug:** open-confirmation, exit-status and close can
  arrive in ONE read, so the exit status is recorded inside ssh2's callback (`recordExit`) and exec
  consumers attach there too (`openOn`'s `onOpen`); late consumers check `channelExit(ch).closed`.
  A killed streaming child must never write to its ended pipes (an uncaught
  `ERR_STREAM_WRITE_AFTER_END` in main). A stream nobody reads never emits `close` — tests must
  `resume()` the channels they hold.
- **ssh2 is loaded on first use, never at module scope** (`ssh2()` in `native-mux.ts`; every other
  shipped import of it is `import type`). native-runtime → native-mux is on main's module-scope
  graph, which runs before Chromium's `ready`; a top-level import cost every launch 14–25 ms warm
  (~680 ms in one cold-cache sample) on machines that never open an SSH project.
  Pinned by `native-mux.lazy.test.ts` (import does not evaluate ssh2) and
  `src/main/lazy-deps.source.test.ts` (no shipped value import).
- **Tests run on every OS** against ssh2's own in-process `Server` (loopback, no sshd); the
  directory is in the `windows-latest` CI job. Live numbers (macOS, `NODETERM_NATIVE_SSH=1`,
  89-terminal project): 89/89 attached, 0 ssh processes, ~1 login per connect, main CPU 3–5% idle.
- **ProxyJump** (#1078) follows OpenSSH: each hop is resolved by ITS OWN `ssh -G` and gets its own
  host-key check and publickey auth; the chain is ssh2 `forwardOut` streams used as the next hop's
  socket. `ssh -J a,b t` means `ssh -J a -W t b`, so only the FIRST hop's own ProxyJump is followed
  (recursively); loops and chains deeper than 8 are refused by name. Jump connections belong to
  the target connection and die with it (a dropped jump → 255 on the target's channels). MaxSessions
  overflow connections REUSE the primary's chain (one bastion login; direct-tcpip does not count
  against the bastion's MaxSessions); one-off connections build their own. Known hosts are checked
  under `HostName` (or `HostKeyAlias`), as OpenSSH does — not under the alias as typed.
  **ProxyCommand** (`proxy-command.ts`) runs on the target or the FIRST hop, as OpenSSH does:
  `%h %p %r %n %k %%` expanded (an unknown `%x` is an error by name), POSIX `sh -c 'exec …'`,
  Windows `cmd.exe /d /s /c`, the child's stdio is the socket, its stderr is in the connect error,
  ConnectTimeout covers the wait for its first byte, and it is killed with the connection (on
  Windows as a TREE, `taskkill /t /f` — the proxy is cmd.exe's child, and killing cmd.exe alone
  orphans it). Every substituted VALUE (`%h %r %n %k`) is refused if it carries a shell/cmd
  metacharacter or a leading `-`: the line goes to `sh -c` / `cmd.exe /c`, and Windows' OpenSSH
  (9.5) predates the CVE-2023-51385 host/user check.
  `ProxyUseFdpass yes` is refused by name. ProxyJump wins when `ssh -G` prints both.
- **Other honored `~/.ssh/config` options:** `ForwardAgent` (yes / path / `$VAR`) — requested on
  the TARGET connection's PTY channels only, never on a hop or a background exec/SFTP channel, and
  a server that refuses it costs one log line, not the terminal. Note what that does NOT buy: sshd
  creates the agent socket once per CONNECTION, so after the first terminal asks, later sessions on
  that shared connection (background execs included) also see `SSH_AUTH_SOCK` — exactly what an
  OpenSSH ControlMaster does. Do not document it as "background calls never get the agent". Options it does NOT honor (`certificatefile`, config `Local/Remote/DynamicForward`)
  are named in ONE warning per connection (`UNSUPPORTED_OPTIONS`), never silently dropped; user and
  `@cert-authority` certificates are a later phase.
- **`-L` dev-server forwards** (`NativeMux.forwardLocal`): the parser accepts ONLY the loopback spec
  `localFwdSpec` emits; a duplicate spec is re-acknowledged (the port registry's `maybe-ours`
  adoption depends on it), a busy port is OpenSSH's "Port forwarding failed", and listeners close
  on `-O cancel`, `-O exit`, `exitAll` and a dropped connection.
- **No ssh.exe needed.** `resolveSshProgram()` (native-runtime.ts) is the one ssh lookup: the
  binary (Windows adds `System32\OpenSSH\ssh.exe`), else — under the native transport only — the
  bare `ssh` sentinel every runner routes to NativeMux. `findSshBinary()` is for the two callers
  that exec `ssh -G` themselves. Without a binary, `ssh -G` falls back to OpenSSH's no-config
  defaults (`defaultHostFromQuery`) and logs once per host that `~/.ssh/config` was not read.
- **Agents on Windows:** the default is the OpenSSH agent service's pipe, else the user's
  Pageant / KeeAgent pipe (`pageant.<user>.<hash>`, PuTTY ≥ 0.75); `IdentityAgent pageant` maps to
  that pipe — NEVER to ssh2's `'pageant'` string, which spawns a 32-bit `pagent.exe` we would have
  to ship and sign (`windows-agent-discovery.ts`).
- **Recursive downloads** rename children Windows cannot create (`a:b`, `CON`, trailing dots, and
  case-only collisions) per directory with `localChildName` / `uniqueChildName`
  (download-name.ts — the ONE rule, also used for the top-level name) and log how many changed.
- **The Windows ssh-agent only on the user's say-so** (#1080). MEASURED on windows-latest
  (OpenSSH_for_Windows_9.5p2): the agent service REFUSES any lifetime or confirm constraint
  (`ssh-add -t` / `-c` and our `ADD_ID_CONSTRAINED` alike), and an unconstrained key is stored in
  `HKCU\Software\OpenSSH\Agent\Keys` (DPAPI) and survives service restarts — "until removed" is
  the only add Windows offers. So a passphrase-unlocked key is added (`agent-add.ts`, our own
  agent-protocol writer; ssh2 only lists and signs) ONLY when the host's own config says
  `AddKeysToAgent yes` (what Windows' ssh.exe would do) or the user turned on Settings → Remote
  (SSH) → "Keep unlocked keys in the Windows ssh-agent" (`settings.windowsSshAgentAddKeys`, default
  OFF, copy says Windows keeps it until `ssh-add -d`). A config lifetime is sent as a constraint and
  Windows' refusal stands: a refused constrained add is NEVER retried unconstrained. Fail-open: an
  agent error never affects the connection. Reboot persistence is inferred from the registry hive,
  not measured.
- **Not done yet:** sleep/wake verification on the native transport, a like-for-like timing against
  OpenSSH on the same project, and any run on a real Windows desktop (all evidence so far is CI plus
  the macOS run of the same code path).

## Remote access (phone relay) — free, not Pro

- **Relay key intake: no low-order keys, one spelling per key, a 10-digit SAS** (security audit
  2026-10, relay-crypto F1–F5). (1) `deriveSharedKey` (`core/relay/e2ee.ts`) refuses a peer key whose
  RAW X25519 output is all zero (`WeakPeerKeyError`, `E_WEAK_PEER_KEY`): tweetnacl's `box.before`
  accepts low-order points, and with one the shared key is HSalsa20(0), a public constant — a
  secret-less client completed the handshake, both humans saw the same fixed SAS ("357 836"), and a
  0^32 key pinned through a tampered offer/join code let anyone back in silently (`autoApprove`).
  Check the raw X25519 output, never `box.before`'s. The host refuses in the `e2ee_hello` handler
  WITHOUT answering and closes the socket (no throw inside the ws emit), and sets `peerPubB64` only
  after a successful derive, so nothing can pin or auto-approve the refused key; a client throws in
  `connectRelay` before dialing. The intakes are belts on that choke point: `decodeOffer`,
  `decodeJoinCode`, `ownerKeyProblem`, `pinDevice`/`isPinned`, and the `/pair` `epk` (400 `bad
  epk`) — `isLowOrderPublicKey` uses a fixed probe scalar, since any clamped scalar sends exactly
  the low-order points to zero. Pinned by `relay-low-order.test.ts` (the audit's repro, against the
  real host and client). (2) Keys and nonces must be CANONICAL padded base64 (`canonicalB64ToBytes`):
  Node's decoder skips junk, so `"!!!" + key` decoded to the key, and pin stores compare strings.
  A join code's body is canonical base64url too, after removing ASCII whitespace (wrapped mail
  lines). Every producer (desktop, iOS, Android, web viewer) pads already. (3) The SAS is v2:
  `pad6(BE_u32(h[0..4]) mod 1e6) + pad4(BE_u32(h[4..8]) mod 1e4)`, "NNN NNN NNNN", h =
  SHA-512(shared). v1 (~20 bits) was grindable on both legs in seconds by whoever substitutes a
  pinned key. The first seven characters are the v1 code, and every surface shows
  `SAS_COMPARE_HINT` (`shared/remote/sas.ts`) under the code — the host approval dialog
  (`shared/remote/approval.ts`), the joiner's prompt (Canvas), the hosted owner dialog and `team
  status`. Nothing compares SAS strings in code, so mixed versions stay correct; vectors in
  `e2ee.test.ts` and docs/ios-protocol-migration.md §3.1 (the phones owe their own release). (4) The
  host SAS dialog has one slot: a DIFFERENT device's pending request is refused while one is open
  (`renderer/lib/pendingPeerAdmission.ts`: a phone is rejected and retries, a relay peer is never
  confirmed), never swapped in under the human comparing digits; the same device re-raising (#372
  retry churn) replaces in place. (5) The pairing QR carries `sshHostKeys` (`SHA256:…` `ssh-keygen
  -lf` spelling, ordered ed25519/ecdsa/rsa, at most 4, after `relay`, before `ssh`; always omitted
  with `ssh:false`), so the phone pins its first SSH connect instead of TOFU
  (`main/ssh-host-key-fingerprint.ts`; phones: nodeterm-ios#75 + Android). **COMPLETE OR ABSENT,
  never partial**: the phones REFUSE a host key not in the set, and sshd presents whichever key the
  client's algorithm preference picks, so a missing key locks the phone out until a new QR. The set
  is what sshd would serve: `HostKey` lines of sshd_config + its `Include`s (else sshd's defaults),
  each counted only if its private file exists (stat, never read), each `.pub` required to parse.
  Any doubt drops the field — an unreadable `.pub`, `HostKeyAgent`, a relative or `%`/`~` path, a
  glob form we do not model, more than 4 keys; an unreadable config falls back to the defaults
  only when all three are present and consistent. A superset is harmless.

- **A Team Access invite that shares ONE project is a boundary, not a label**
  (`core/relay/scoped-guest-policy.ts`, wired by `main/remote/relay-host.ts` as the core relay
  host's hooks). The invite is consent to run commands IN that project, and nothing else: inbound is
  an allowlist (`SCOPED`) where a node id must belong only to the shared project, paths realpath
  inside the project root and outside userData (symlinks and dangling links refused), `pty:create`
  loses `sshRemote` and defaults its cwd to the root, `workspace:save` is refused; outbound reuses
  the viewer policy's per-project event/terminal-frame attribution, presence included (only peers on
  the shared project, no node id outside it — `createPresenceFilter`). **A node id the guest itself
  introduces over `canvas:mut` (one no project holds yet: the host saves on a debounce, so a new
  terminal's first `pty:create` precedes its node on disk) is PENDING, and pending unlocks nothing
  but its own spawn** (security audit F1, 2026-10): its `pty:create` carries `newOnly` (core refuses
  a join, a reattach, and any session that already runs under that name, `unavailable: 'new-only'`),
  and only that create's own `fresh: true` response makes it the guest's node. Until then every
  node-keyed verb and the outbound stream refuse it, even after the host saved it into the project
  (being on the canvas is the guest's own doing, not ownership). Introduced ids are bounded (256) and
  must be `[A-Za-z0-9-]` (`sessionName` rewrites anything else, so two ids could name one tmux
  session). The audit's attack was an SSH-project guest (no local shell granted) recording a PREFIX
  of another project's node id and reaching that LOCAL terminal through tmux prefix matching (see
  "Exact tmux targets" under the tmux section). **A share rooted at the disk root, the home directory
  or an ancestor of either or of userData is never served** (`core/relay/share-root.ts`): every file
  under it would be readable, `~/.ssh` included; the invite UI shows such a project disabled with the
  reason (`relayHost.scopeProblems`), `addSeat` refuses to mint it, and the policy refuses every
  request of such a session. An unknown channel is refused, and the guard test
  forces a decision for every relay-tab channel. `connectRelayHost` THROWS for a scoped session
  given no scope deps rather than serve it unscoped. **What it does not claim**: the guest's own
  terminal is a shell as the host's user and can `cd` anywhere or attach another tmux session; the
  policy closes the app's RPC doors, not the OS. Secret-bearing RPCs are host-only for EVERY relay
  peer (`shared/host-control.ts`, now also enforced in core `relay-host.ts` `serve`, so the Server
  Edition's hosted peers meet it): `settings:*` (a peer that saved `modelGateway.baseUrl` and then
  called `agent:discover-models` would have the keychain-held gateway key sent to its URL),
  gateway credentials, `license:*`, `claude-accounts:*`/`codex-accounts:*`, `usage:*`, and the
  pairing/relay trust plane. An UNSCOPED invite (Team Access seats) stays full access, and its copy
  now says so. Known degrades of the scoped tab: the host-path picker starts at `/` and is refused
  (navigate from the project instead), and an SSH project's terminals do not open over the relay.

- Phone relay remote access ("Reach this Mac from anywhere") is a **Core (free) feature** as of
  2026-08-01 — the iOS app is itself paid, so a desktop Pro gate double-charged the same feature.
  The former Pro gate AND the free-tier monthly quota (`core/relay-quota.ts`, `RelayQuotaBanner`,
  the ProCompare meter, the `relayQuota` IPC/preload/bridge surface, docs/relay-quota.md) were all
  **removed**. The toggle (`settings.phoneAccessEnabled`, Settings → Phone + quick-pair popover)
  shows for everyone; the standing host reconciles on `enabled && relayAllowed()` alone, with no
  quota metering at `onPeerReady`. **Entitlement passthrough remains**: a stored Pro entitlement is
  sent on mints, else the `{deviceId,…}` body (host-token `{deviceId, hostPublicKeyB64}`, plus
  `popChallenge`/`popProof` when the backend supports it; device mint `{deviceId, hostDeviceId,
  hostPublicKeyB64, label}`). **The backend is the real gate now**:
  `POST /v1/relay/host-token` / `/v1/relay/device` must admit deviceId (no-entitlement) mints, and
  the relay server may rate-limit free hosts independently — a client-side gate must NOT be
  reintroduced to work around a backend refusal (fix the backend policy instead).
- **A paused phone stream is resumed by a drain sweep, never by "the next chunk"**
  (`main/remote/host-service.ts`, FLOW_SWEEP_MS). `sendFrame` refuses — and drops — a frame once the
  relay socket holds >8 MB, and the host pauses the pty; a paused node-pty emits no `onData`, so the
  old resume-on-next-successful-send never fired and the phone's terminal froze until it detached.
  A 250 ms sweep, armed only while a stream is paused and cleared in
  `dropStream`/`closeAll`, waits for `bufferedAmount() <= 256 KB`, then capture → `OP.Snapshot*` →
  `setFlow(resume)`, in that order (the dropped frame desynced the phone; resuming first lets live
  output race the repaint). The repaint is NOT the attach snapshot's bytes: the phone feeds a
  snapshot into its emulator with no reset, over the old screen, so the resume payload
  (`resumeRepaintText`, `@shared/capture-paint`) is SGR reset + home + clear, the screen with CRLF
  line endings (SwiftTerm runs convertEol off) and one trailing newline dropped, then the pane's
  cursor when `PtyManager.captureVisible` read it (else the attach's own capture, no cursor). The
  attach snapshot, painted into an empty emulator, stays the raw capture. A refused repaint retries with backoff (250 ms doubling to 10 s: a
  reconnecting relay reads 0 buffered but refuses every send, so no backoff = a tmux capture per
  tick). Output still queued after the pause is dropped, not streamed. An empty
  capture resumes WITHOUT a repaint — unlike `ui-sink-registry`'s keep-desynced rule, staying here
  means staying frozen. The same drain-sweep pattern as `core/ui-sink-registry.ts` (whose self-paced
  sinks are never dropped at all); do not reintroduce a chunk-driven
  resume. `~/.nodeterm/relay.json` is written only when its content changes or the file is missing
  (`relay-advertise.ts`): the ~90 s listener cycle used to rewrite it identically (~960/day).
- **The phone's Chat screen verbs** (`chat.page` / `chat.status` / `chat.send` / `agent.answer`,
  `host-service.ts` `handleChat` → `main/remote/host-chat.ts`, spec + exact error strings in
  `docs/mobile-chat-view.md` §3.2). Four rules a refactor must not undo: (1) **the phone sends only a
  node id**; cwd/account/agent/session are resolved from THIS machine's records
  (`WorkspaceStore.getNodeResolved` + the mirror). The session id is asked of the RENDERER's
  agent-status store first (what ⌘M reads; after a restart a hook-fed id lives only there), the
  mirror / minted id only as a fallback; the cwd rides only for a REMOTE node with a known id, so a
  local known-but-dead id — or no id at all — reads NOTHING rather than claude's cwd-newest fallback
  (a stranger's session). An SSH-project node is read REMOTE-ONLY (`remoteOnly`): over its live
  pty's master, else its PROJECT's (`remoteTargetForNode` — an idle tab or any node after a restart
  has no pty, and resolving through the pty alone sent it to THIS machine's disk), and a remote read
  that cannot happen is `unreadable` ⇒ "Could not read the transcript.", never `found:false`. Only
  chat-capable agents are served (`canChat(capabilityAgentId(agent))`); (2) **the send gate is the host mirror's, then the renderer's** — refused
  first when the mirror says working/waiting/blocked or holds a question/approval ticket (renderer
  state is transient after a reload), then an IPC round-trip (`host:chat-query` /
  `host:chat-reply`, sender-checked to the main window) answered from the agent-status store and the
  ⌘M composer's `chatSendRefusal` at send time plus "no held request". A renderer that does not
  answer FAILS CLOSED: status is an error; `'refused'` (with a `reason`) means nothing was typed
  (no window, a gate, past `startBy`, or `busy` — one send per node in flight until it SETTLES),
  while a send whose outcome the desktop cannot confirm (no answer in time, or a `sendText` that
  rejected after starting — it may or may not have been typed) is `'unconfirmed'`, never `'refused'`,
  which would invite the phone to resend and type the prompt twice. `ChatStatus` carries the mirror's
  view too (`hostRefuses`/`refusal`, `version: 1`): after a restart the window's `state` is null while
  the mirror may still hold a live dialog, and the phone must see the lock the send applies; (3) **text is capped raw (64000) then stripped of ESC + C0/C1** (`\n`/`\t` kept) and
  rides `pty.sendText` (stdin into tmux, never argv); `'sent'` only for `sendText === true`;
  (4) **`agent.answer` is the desktop answer path** — `answerHeldPermission` over the SAME
  `heldPermissionIoFor` (local fs or the SSH ControlMaster) and the in-process structured-ticket
  gate, and the `pendingId` must be THIS node's (a mirror approval ticket for it, or the renderer's
  `held.pendingId`), else `false` with no I/O and no answered event on the wrong node. The `chat`
  dependency is OPTIONAL at every hop, so a dropped hop compiles and ships the verbs
  inert ("not served"); `host-chat-wiring.test.ts` pins the chain at source level. Served only to an
  approved phone; Team-access relay guests never reach them (`relay-host.ts` serves no phone
  dialect). Server Edition: N/A (no phone relay; the bridge subscription is inert).
- **One relay pin store per ROLE, and only the phone store admits anyone** (`main/remote/approved-devices.ts`).
  `phonePins` (`remote-approved-phones.json`) is what the standing host auto-approves from, silently,
  with the full phone vocabulary; `guestPins` (Team Access desktops we host) and `joinedHostPins`
  (hosts we joined) are records that nothing reads to admit. They used to be ONE file, so a host you
  once joined, or a guest whose seat you revoked, was auto-admitted as a phone. The pre-split
  `remote-approved-devices.json` is deleted at boot and NOTHING in it is carried over: nothing on
  this machine can tell its roles apart (the phone's relay box key is never sent at pairing, so
  agent.json cannot vouch for one), so every phone re-approves by SAS once. **Every revoke goes
  through `main/remote/peer-revoke.ts`**: unpin from the named role stores, then run every
  registered host killer (standing host pool incl. pending consent, the interactive `initRemoteHost`
  session, the Team Access `live` set). A revoke that knows only one host leaves the others serving.
  Phone "Remove" (`pairing-service.revokeDevice`) revokes ALL phone pins and cuts ALL phone relay
  sessions, before the SSH key and the device entry go — all-phones because no box key maps to a
  device; a failure reports `local:false` and keeps the device listed to retry.
- **Phone pairing is platform-neutral, and revoke still speaks the iOS-era stamp.** New keys are
  stamped `nodeterm-mobile-<deviceId>` (`pairing-core.deviceCommentFor`); `filterAuthorizedKeys`
  matches BOTH that and the legacy `nodeterm-ios-<deviceId>` (`deviceCommentsFor`), because every
  iPhone paired before Android existed carries the old stamp — drop the legacy leg and "Remove"
  reports a phone removed while its SSH key stays live. The device name is what the phone sends
  (Android sends one), sanitized to one ≤64-code-point line; with none it is `'Phone'`, EXCEPT the
  iOS app — which has never sent a name — is recognised by its fixed key comment `nodeterm-ios` and
  keeps `'iPhone'`. Store links go through `renderer/lib/links.ts` `mobileStoreLinks()`; the Play
  link is hidden by the single `ANDROID_APP_PUBLISHED` flag until the listing exists, and
  `mobileStore.guard.test.ts` refuses a direct store URL anywhere else in the renderer. `LicenseSource` includes
  `'google'` (a Play purchase bridged from the phone, `google:<orderId>`), with its own
  `licenseCopy` sentence. `settings.mobileLiveActivities` keeps its key; the UI says "Live updates
  on phone".
- **A Windows desktop pairs relay-only — no SSH key, and do not "fix" that by writing one.** The
  phone's direct-SSH path is POSIX sh + tmux end to end (nodeterm-ios `HostCommands`, `TmuxBinary`,
  the typed `tmux new-session -A` attach, workspace paths with no `%APPDATA%` candidate). Windows
  OpenSSH hands out `cmd.exe`, and sessions live in the session host, which nothing on the phone
  can attach to over SSH. So on win32 `createPairingService` installs no key, the QR carries
  `"ssh":false`, the QR is gated on the RELAY instead of sshd (`shared/pairing-gate.ts`), and a
  failed relay mint pairs NOTHING (502 to the phone, `reason:'relay-failed'` to the UI) instead of
  the SSH platforms' LAN-only degrade. **A key sshd accepts makes things worse, not better**: the
  phone tries SSH before the relay, so a working key pins it to a path that cannot work, where a
  rejected one lets it fall through. Issue #758's `administrators_authorized_keys` rule is detected
  (`main/windows-ssh-keys.ts`) only to explain the missing key; revoke still sweeps that file IN
  PLACE (a temp + rename would swap its Administrators+SYSTEM ACL for the directory's, and sshd
  would then refuse every admin key in it). Relay attach on Windows rests on the session host
  being packaged (#575, shipped by #579): without that bundle `pty.attach` spawns a new plain shell
  instead of joining the node's session, while `sessionExists` still answers "warm".

- **The phone never types shell syntax into a relay host** (relay-only hosts — every Windows
  pairing — have no SSH, and a Windows pane is pwsh/cmd). `pty.attach { launch: {agentId,
  sessionId?, cwd?, accountId?, permissionMode?} }` makes the HOST launch, only into a session the
  attach CREATED, exactly once (`core/relay-launch.ts`, `PtyManager.prepareRelayAttach`): every
  field re-validated, cwd jailed to the fs roots, cwd/account folded into the SPAWN options of an
  unrecorded node (a recorded node keeps its records), and the line built for the pane's real
  parser — `assembleResumeCommand` on POSIX, the trusted Windows planner when its resolver is
  wired, else only a dialect-neutral line. Reply `launched: true` = "type nothing", and it is only
  promised after a preflight build succeeded (`relayLaunchPreflight` — an unset `${env:…}` or a
  non-neutral custom line on a Windows pane answers `launched:false`, never a launch that silently
  never comes). The reply also says `paneShell: 'posix' | 'windows'` — whether a typed POSIX line is
  safe in THAT pane, which is not `hostPlatform`: a Windows desktop's SSH-project node runs on a
  POSIX host (not host-launched; the phone types as before). Without `launch` the reply is
  byte-identical. `pty.scroll` writes the wheel only on a tmux /
  mouse-requesting pane (`PtyManager.scrollRoute`); a session-host / plain stream's reply says
  `scroll:'local'` and its snapshot is the full buffer. Keyed answers ride `agent.key` (closed key
  set, host-side state + open-ask guard, hook reply first; an SSH-project node with no client held
  goes over its owner's ControlMaster or nowhere — never the local socket), read-acks `inbox.ack`
  (`applyPhoneReadAck`, the ack sweeper's body), plus `fs.browse` (home-jailed, dirs only) and
  `pty.capture`; `host.info` lists them. All additive — an old phone keeps its old path.

## Free-tier open-project limit (shipped dormant; the server switches it on)

A non-Pro desktop install may keep FREE (a server value) projects open, a pre-cutoff install its
signed allowance; Pro is unlimited. Design, runbook, checklist: **`docs/project-limit.md`**.
- **One count**: `countOpenProjects` (`shared/project-limit.ts`) / `WorkspaceStore.openProjectCount`
  — in the workspace, not `closed`, not a relay tab. Never write a second one.
- **Never force-close.** The gate refuses a NEW open and nothing else; no project, node or tmux
  session is ever closed, deleted or detached because of the limit, even above the allowance.
- **Placement**: a human open calls `gateProjectOpen` (`renderer/lib/projectLimitGate.ts`) as the
  LAST await before its synchronous store mutation, skipped when `opensProject(...)` is false;
  allowed returns the literal `true` in the same tick, so while the limit is off every path stays
  synchronous with no network, dialog or write. The agent `open-project` verb decides and writes in
  one tick (`finishAgentProjectOpen`).
- **Relay tabs are never gated or counted**; `projectLimit:*` is host-only and `projectLimit:changed`
  reaches this machine's windows only. **The Server Edition has no gate** (stub answers inactive).
- `PROJECT_LIMIT_DEADLINE_MS` is bumped every release until the flip — release.yml refuses < 30 days.

## `nodeterm://` links (another app asks to open a node)

`nodeterm://open?agent=…&project=…|project-cwd=…&cwd=…&prompt=…|prompt-file=…&title=…&source=…`
lets an app with no node identity (a review tool, a script, a bookmark) ask for ONE node; the human
approves every link in a confirm sheet. Spec + as-built decisions:
`docs/superpowers/specs/2026-10-13-open-link-design.md`. Parser `@shared/open-link`, service
`main/open-link.ts` (electron-free, tested), wiring `main/open-link-wiring.ts`, sheet
`components/OpenLinkSheet.tsx`. Invariants:
- **Behind a flag, OFF by default** (`settings.allowOpenLinks`, Settings → Behavior "Allow
  nodeterm:// links"). Main reads it on every link and again on accept; off, a link is not even
  parsed — one notice says where to turn it on. The scheme is still registered, so the notice is
  what a click meets.
- **The parser refuses, never drops**: unknown/duplicate params, over-cap values, relative paths,
  controls. No canvas-control power flags exist here; `source` is display-only.
- **Paths are stat'ed before the sheet, so a path may not reach another machine.** A POSIX-form
  path with a backslash is refused (Windows reads `/\host\share` as UNC and a stat there
  authenticates to that host — NTLM), as are UNC and the macOS automount roots `/net`, `/Network`.
- **Nothing the sheet would not show reaches the agent**: `hasHiddenText` (every `\p{Cf}` except
  ZWJ, plus C1 — bidi overrides, zero-width, Unicode TAG "ASCII smuggling") refuses an inline
  prompt, a prompt file's text, every path and every label. The sheet prints the prompt's size.
- **The permission mode shown is the one launched.** A new-project choice adopts the folder's
  committed `project.json`, so the sheet probes it (Open waits) and labels from it; a mode that
  differs at landing refuses. `bypassPermissions` gets a warning in the sheet.
- **The prompt file is read from ONE non-blocking open** (no stat first, `O_NONBLOCK` so a FIFO
  cannot park a thread, looped read to EOF/cap). A project whose folder changed while the sheet was
  up refuses on accept; `/`, the home folder and its ancestors are never offered as a new project.
- **Main is the authority**: it resolves project candidates from ITS workspace index (SSH and
  handed-off projects never offered), stats the cwd, reads `prompt-file`, and on accept re-checks
  the renderer's choice (a candidate id or the offered new-project folder), re-reads the file,
  refuses if it changed, and copies it into `<userData>/launch-prompts`. Requests are single use and
  expire after 10 min.
- **Delivery**: `open-url` registered in `will-finish-launching` (macOS), argv on cold start and in
  `second-instance` (Windows/Linux); held until the renderer calls `openLink.ready()`, held again on
  every page death (`clearRendererKeyState`). 5 links a minute; a second link replaces only an
  untouched sheet. The window raise is the shared `raiseForUserLaunch`.
- **The sheet**: Enter never opens, nor Space on the focused button (`detail === 0` is ignored);
  Open is disabled for 1 s, then a pointer click only. A second link replaces the sheet only within
  that first second and untouched — after that it is dropped (reading fires no event). An accepted
  link waiting for its project to load is dropped after 30 s, never created later.
- `pair`/`join` links open the existing code prompt pre-filled; never auto-connect.
- Desktop only. Server Edition stub is inert; `open-link:` is a host-only prefix. A dev run registers
  the scheme only with `NODETERM_DEV_PROTOCOL=1`. An `NT_MULTI` sandbox takes links (argv,
  `second-instance`, `open -a <Electron.app> 'nodeterm://…'`) only with that variable and never
  registers the scheme — that is the live-test setup beside an installed app.

## Push webhook (a script or CI job rings the paired phone)

Settings → Phone → **Push webhook** mints a per-host bearer token; anything that can run `curl`
then pushes a plain-text notification to the phones relay-paired with this machine
(`POST https://api.nodeterm.dev/v1/push/webhook`, `{"title","body"}`). Agents already push through
their hooks; this is for the jobs that have no agent in the loop. The backend half lives in
nodeterm-server (`src/routes/push-webhook.ts`, `src/lib/host-proof.ts`); the desktop half is
`core/push-webhook.ts` (client), `shared/push-webhook.ts` (types, copy, the example) and
`PushWebhookPanel.tsx`. Rules a change must keep:

- **Minting, reading and revoking need the relay host SECRET key, not the public identity.** Other
  host-authenticated backend routes accept `(hostDeviceId, hostPublicKeyB64)` alone — except, since
  R44, for a LATCHED host (one that has proven its key once; every host after
  `POP_REQUIRED_AFTER`), whose host-token mint also needs a relay PoP proof and whose host-mode
  notify / live-update need a `hostAuth` session (§ Hosted team relay). Both fields are known to
  every paired phone; for a send that only lets the holder reach phones that already
  trust the host, but a webhook token is DURABLE — whoever can mint or revoke one can keep a live
  token or silently cut the owner's CI alerts. So each management call is a challenge: the server
  answers with an ephemeral X25519 key (derived from its own secret + the challenge, so no state
  and any instance verifies), and main returns `HMAC-SHA256(X25519(hostSecret, ephemeral),
  context)` with `context` = domain, challenge, action, host device id. The key never leaves main;
  a proof for `status` cannot be spent on `revoke`; a challenge lives 5 min and is single-use per
  process. `webhookProofContext` and the server's `proofContext` are ONE wire contract — change
  both. `core/push-webhook.test.ts` verifies the desktop's NaCl `scalarMult` proof against Node's
  own X25519 (the server's primitive), so the two cannot drift silently.
- **The token is shown ONCE and kept nowhere on this side.** 256 random bits (`ntwh_` + 43
  base64url), stored server-side only as its SHA-256 (a fast hash is right for a high-entropy
  token), returned `Cache-Control: no-store`. The panel holds it in component state until "Done";
  it is never written to settings.json, storage or a log (the panel test asserts local/session
  storage). There is no "show again" — Rotate mints a new one and revokes the old. One live token
  per host is enforced by a partial UNIQUE index on the backend (`host_id WHERE revoked_at IS
  NULL`), not by the mint's transaction: under READ COMMITTED two concurrent first mints each see
  no live row and both insert.
- **Viewing the page calls nothing without a paired phone.** The client asks `hasPairedPhone` (the
  same local check as `pushHasPairedPhone`: a phone pin or a registry device) BEFORE reading the
  host key or the network: the first read of `remote-host-key.json` CREATES it, and a status call
  sends the device id + public key to the backend — neither may happen because someone opened
  Settings → Phone. A failed local check reads as "no phone". And settings search unmounts and
  remounts every row, so the panel reuses its last status answer for 5 minutes
  (`STATUS_REUSE_MS`, module state) instead of spending a challenge + status round trip per remount
  against a per-IP budget that everyone behind one NAT shares.
- **The example never puts the token on argv.** `pushWebhookCurlExample` (labelled `sh`) reads
  `$NODETERM_WEBHOOK_TOKEN` and feeds the header to `curl --config -` through `printf` (a shell
  builtin), the house rule for every credential we generate. Windows has no `sh`, so there is a
  `PowerShell` twin (`pushWebhookPowerShellExample`): `Invoke-RestMethod` makes the request
  in-process, so there is no child argv at all (and PowerShell 5.1 mangles JSON quotes passed to
  `curl.exe`). `shared/push-webhook.test.ts` runs the
  example under a real `/bin/sh` with a recording curl and asserts the token reached stdin and not
  argv.
- **The push is labelled and inert.** Subtitle `Webhook · <hostname>`, its own `thread-id`, the
  phone's existing no-action category `AGENT_DONE`, and an `nt` block with `kind: 'webhook'` and no
  `nodeId`, so a tap opens the Inbox and nothing else: no Allow/Deny buttons, no deep link, no URL
  opened. Title is one line (≤ 120 code points), body ≤ 500; C0/C1 controls, lone surrogates and
  the bidi/zero-width controls are stripped — NOT all of `\p{Cf}`, which holds ZWJ and the tag
  characters (👨‍💻, subdivision flags) — and a payload over APNs' 4096 bytes is refused with a 413
  rather than answered `sent: 0` (lone surrogates JSON-escape to 6 bytes each; measured 4103 bytes
  before they were stripped).
- **KNOWN GAP — needs an iOS release (@eneskirca).** The phone shows these pushes without a release
  (unknown `kind` + no `nodeId` routes to a plain Inbox open), EXCEPT while its Inbox sheet is open:
  `PushPresentation.shouldSuppressBanner` suppresses every push then (the live feed is assumed to
  show it), so `willPresent` presents nothing — no banner, no sound, no Notification Center entry —
  and a webhook message never appears in the Inbox feed. It is lost. The fix is phone-side: do not
  suppress `nt.kind == "webhook"`.
- **Budgets:** 10 per minute per token, 60 per hour per HOST (keyed by hostId, so rotating does not
  reset it), 20 mints per host per day, plus per-IP shields. Fan-out = exactly a host-mode
  `/v1/push/notify`: this host's live relay pairings with a live APNs registration, minus phones
  that muted this host.
- **Relay-paired phones only.** An SSH-granted phone (push grants) has no row the backend can tie to
  this host, so it does not receive webhook pushes; minting with no live pairing answers
  `no_paired_phone` and the panel says so. The desktop refuses before calling at all when it knows
  of no paired phone, so a token left live after every phone is unpaired cannot be revoked from
  here until a phone is paired again (it sends to nobody meanwhile).
- **No canvas-control verb.** An agent already has hook-driven pushes, and a verb would need the
  desktop to hold the token, which it deliberately does not.

Surfaces: Desktop full. **Server Edition: N/A** — it has no relay host key or paired-phone
registry (same degrade as `push-notify.ts`); the bridge answers `E_UNSUPPORTED` and the row is
hidden in a browser tab. IPC is under `pairing:` so `HOST_ONLY_CHANNEL_PREFIXES` keeps it off the
relay. **Mobile:** the Inbox-open gap above needs an iOS release; an iOS follow-up could also give
`kind: 'webhook'` its own Inbox row and tap target.

## Hosted team relay (Server Edition as a relay host)

A Server Edition core can host a team over the E2EE relay: a standing listener on the tunnel
dialect, owner approval, roles, a `team` admin CLI, and desktops joining with a
`nodeterm://join?code=…` code. Operator guide, roles table, join-error table, limitations and the
device checklist: **`docs/hosted-team-relay.md`**. The relay mechanism moved to `src/core/relay/`
(`src/main/remote/` keeps re-export shims), and Team Access and the hosted team run the SAME
`connectRelayHost`: a host that passes no `RelayHostHooks` (the desktop) takes the unhooked path.
The invariants, each with its reason:

- **Roles are enforced in core, deny-by-default in BOTH directions** (`core/relay/access-policy.ts`).
  A Viewer/Commenter reaches a method only if `VIEW`/`COMMENT` lists it, and receives an event only
  if `VIEW_EVENTS` does: the core broadcasts to every attached client (the debug log, whole project
  documents), so an allow-by-default filter would hand a viewer whatever nobody remembered to list.
  **"Read" is not "safe"**: relay peers were fully trusted, so every VIEW entry carries its own
  argument check. `fs:*` is realpath-jailed to a shared project's realpathed cwd; `git:diff` jails
  the FILE too (`--no-index` diffs any file on the host); a `git:show-file` ref starting with `-`
  is an option (`--output=` writes a file); **every git read also needs the shared root holding
  the cwd to be the top of its OWN repository** (a `.git` dir holding `HEAD`, or a worktree's
  `.git` file; git skips an empty `.git` dir): `git show <ref>:<p>` resolves `<p>` against the
  repository's top level and `git status`/`log` report the whole repository, so from a shared
  `repo/shared/` a Viewer read `repo/secret/key.txt` (measured, C1) — a monorepo subfolder gets no
  git panel; `pty:create` is cut down to a whitelist, because
  `sshRemote`'s args run `ssh` on the host during the existence probe. A non-editor's terminal
  frames (output, resync, size, exit) are judged per frame by the session's node
  (`PtyManager.nodeOfSession`), because a subscription outlives `team unshare`. Editors pass untouched
  (Editor is shell access). The UI mirror (`@shared/hosted-access.ts`, `bridge/hosted-gate.ts`) is
  convenience; `access-policy.guard.test.ts` pins it equal and fails on any relay-API channel
  nobody classified.
- **The role is read from `team.json` on every message, never cached on a session**, so a removal
  or promotion applies to the next message. A session with NO team entry is served nothing: that
  is the window between a removal's write and its kill. The one exception is `pinFailed` (both
  humans approved but the pin write failed), served as Viewer. The renderer, by contrast, reads the
  role once per connection; that is UX only.
- **A viewer's size never votes, and a viewer's create is join-only.** `sizeVote: false` (a
  non-voting re-join also WITHDRAWS an earlier vote under the same subscriber key) and `pty:resize`
  rewritten to `(null, null)`: a small window must not shrink everyone's terminal. `joinOnly`
  asks the STRICT exact-target probe (`has-session -t =nt-<id>`), refuses when it cannot tell, and
  reattaches without `-D`. The folded probe reads a tmux error as "exists", which is the safe answer
  for an owner and would let a viewer's `new-session -A` CREATE the session.
- **The host key is never silently regenerated** (`host-key.ts`). Its public key IS the team's
  address (`hostId`), so a new key orphans every bookmark and sends every teammate back through
  first-join approval. Unreadable ⇒ hosting stays off with `host-key-unreadable`; only
  `team rotate-key` replaces it.
- **`team.json` is not the phone's pin file.** Push's `hasPairedPhone` counts the entries of
  `remote-approved-phones.json`, so a teammate pinned there would read as a paired phone. The same
  rule on the joiner: `hosted-join.ts` runs the core relay client with NO pin store, and the
  joiner-side pin is the bookmark's `approvedAt` (valid only for the exact host key it was recorded
  with).
- **The admin channel is a 0600 unix socket in a 0700 directory, with no token**
  (`core/relay/team-admin.ts`). Filesystem permissions are the whole gate, so there is nothing to
  leak into a pane's environment. The root of trust is the core's unix user, which also means an
  Editor's shell can run `team add-owner`. With no team, the socket serves only
  `init`/`status`/`info`/`bootstrap` (`bootstrap` is `init` plus the rest). The `relay:hosted:*`
  verbs are intercepted inside the relay session and never registered on the platform, so a Server
  Edition browser client cannot call them. An interceptor bypasses `access` and every jail, so each
  one judges the CALLER's own session key.
- **LOCAL confirms have exactly four call sites on the host side:** the Team Access dialog
  (`relay:host:confirm`), `autoApprove` for a key `team.json` pins, an owner's
  `relay:hosted:approve`, and a live link's `autoApprove` for the ONE viewer key derived from that
  link's own secret, read from the host's own link record (any other key is denied at once, never
  asked — `docs/live-links.md`). The joiner side has two: the human's `relay:client:confirm`, and the
  bookmark auto-confirm. The one remote confirm still arrives only on the encrypted tunnel. A new
  local confirm is a design change; the comment in `relay-trust.ts` lists all six.
- **Nothing is served before mutual approval.** Frames that arrive between approval and open (while
  the pin is being written) are HELD, at most `HELD_FRAMES_MAX` (256), then served through the same
  checks. Refusing them would fail a new teammate's first `workspace:load`, which routinely lands
  inside the host's pin write. Pending join requests go to connected OWNERS only (never a
  broadcast), at most one per device key and 16 at once, and expire after 10 minutes. A deny or
  expiry that lands during the pin write wins.
- **The scheduler's backoff resets only on proof the relay leg works** (an idle listener held to
  its refresh, or a completed handshake) or on a fresh `start()`, never on a successful mint. With
  the API up and the relay down every mint succeeds and every socket dies, and a reset-on-mint
  re-minted at round-trip speed (relay log, 2026-09-27). Successful mints are also capped at 200
  per rolling hour, whatever asks for them (the backend's free limit is 240).
- **A host-token mint and host-mode push prove the caller holds the relay host key's secret half
  (R44)** — device mints and join slots still take no proof (see "Still open" below). A
  join code carries the host's device id and public key, which used to be all a host-token mint
  asked for, so a code holder could spend the host's hourly mints. Now the host-token mint (desktop
  phone relay and Server Edition hosted mint) and the desktop's host-mode push first take a
  challenge from `/v1/relay/challenge` and send a proof. Rules a refactor must not undo:
  - **`src/core/relay/relay-pop.ts` is the ONLY computation of the relay PoP proof** (the
    host-token mint and push host-auth), and it refuses an all-zero shared secret (a low-order
    server key gives every caller the same secret). Its bytes are pinned by `relay-pop-vector.json`,
    mirrored byte for byte in nodeterm-server: a protocol change changes both. The push webhook's
    management proof (`core/push-webhook.ts` `webhookProof`, § Push webhook) is a SEPARATE,
    independent proof of the same host key, with its own challenge route
    (`/v1/push/webhook/challenge`), its own context string and its own wire contract (nodeterm-server
    `src/lib/host-proof.ts`). Do not fold either one into the other; the all-zero refusal here does
    not cover it.
  - **A request goes out unproven ONLY when the challenge answered 404/405** (a backend that
    predates the proof). **One exception, push only:** a challenge answered 200 followed by
    `/v1/push/host-auth` answering 404 also posts unproven, and that verdict is cached 10 minutes like
    a 404/405 one (`push-notify.ts` `establish`). One backend registers both routes or neither, so
    this happens only in a redeploy window; push stops nothing, and the backend gates the unproven
    post regardless (a latched host's is refused, which forgets the verdict, and the host proves
    again). Never after a transient failure (5xx, 429, network, an unusable challenge):
    the backend LATCHES a host at its first valid proof and refuses an unproven request from it
    (`403 pop_required`; every host after `POP_REQUIRED_AFTER`, default 2027-01-01), so an
    unproven mint there would stop hosting. Conversely, a `pop_required` answer to a mint sent
    unproven after a 404/405 is TRANSIENT: a reverse proxy answers 404 while the backend redeploys.
  - **A key-proof refusal stops hosting only on the SECOND in a row**, with a fresh challenge in
    between, on both editions: a `POP_SECRET` rotation or an instance mismatch inside one
    challenge-then-mint pair refuses an honest host once. A transient failure between the two does
    not reset the count; only a successful mint or a restart does. The Server Edition says
    `POP_REFUSED_MESSAGE` (it names `team rotate-key`); the desktop shows ONE dialog with
    `POP_REFUSED_MESSAGE_DESKTOP`, which must never name `team rotate-key` (Server Edition only).
  - **Push uses a 15-minute `hostAuth` session from `/v1/push/host-auth`**, re-proven after 10
    minutes on the client's clock (at once if that clock has stepped back since: a negative age is
    expired), one per stream (`core/push-notify.ts` `createHostAuthCache`). An
    old-backend verdict is cached 10 minutes; failed proofs back off 0/5/15/60 s (a hold further out
    than 60 s is a backward clock step and is ignored); overlapping flushes share one proof; a proof
    that throws is a failure, never a rejection. A batch that cannot be proven is DROPPED, never sent
    unproven. An unproven post refused 403 under a verdict cached from an EARLIER batch means the
    host latched elsewhere: that batch re-proves and re-posts once.
  - **Still open**: the team's 10 daily device mints and the 16 pending join slots (those routes
    take no proof), and, before a host's first proof, a code holder's legacy listeners evicting its
    idle one through the relay's 8-per-host cap. Recovery is a fresh `<dataDir>/device-id` +
    `team rotate-key` + fresh codes. Full write-up and the rollout (backend first; `POP_SECRET` set,
    boot log without `DISABLED`): `docs/hosted-team-relay.md` § Host key proof of possession.
- **The joiner never mints a device token it cannot keep.** Device mints are damped per HOST device
  id, so one team shares 10 a day. It probes the bookmarks file before minting and sends a PER-TEAM
  device id (`<machine id>:<hostId>`), because the backend will not re-register one id for a second
  host. Every failure carries a stable `[E_JOIN_…]` code, which is the only part of an error that
  survives Electron IPC. Only `E_JOIN_NETWORK` and `E_JOIN_THROTTLED` (at least 60 s) retry
  unattended. A drop the host did not explain retries 5 times (1/2/4/8/15 s), then stops and says so.

**Shared canvas authority** (doc section of that name; ordering rules in `docs/team-presence.md`).
`canvas:mut` carries nodes, edges (`edge-*`) and board items (`kb-*`, `shared/kanban-ops.ts`).

- **On the Server Edition, only the canvas authority writes a shared project's content**
  (`core/canvas-authority.ts`: nodes, bridges, ropes, board items; only in the process that owns the
  team). A client's whole-workspace save is a stale copy of every canvas it holds, so saves AND
  loads pass through the authority's overlay (`WorkspaceStore.setContentAuthority`), and an outside
  edit (a `git pull`) is adopted and published as ops instead of `workspace:external-change`, whose
  conflict bar would offer "Keep mine" over it; the persisted project follows on
  `workspace:server-change` (silent merge), or a stale tab's autosave would revert the pulled
  non-content fields, `defaultPermissionMode` and the capability flags included. It writes 1 s
  after the last op, at most 5 s after the first. The consequence for code: **a content change that is not cast as an op is dropped by
  the next overlaid save.** That is why server canvas control casts a diff of the whole content
  before every save (`castAndSave`, never a per-verb list, which drifts), and why a hosted relay
  peer may not `workspace:save` at all (refused for every role). One exception: a node too large
  to travel as an op is taken from saves. **Exec fields never enter the authority's state** —
  `shell`, `ssh.extraArgs`, and `pendingLaunch`, which the reflector strips from what it hands the
  authority even on an owner's op: a save carries this machine's own values onto the overlaid nodes
  (`carryLocalNodeExec`), and that carry is how an armed `--after` node — and server canvas
  control's claim/clear of its launch (`savePatches` → `castAndSave`) — reaches the index's
  `localExec` on a governed project. For the same reason the authority's outside-edit diff is
  published UNTRUSTED (`publishCanvasMutation(id, m, { trusted: false })`): vouched as a core write,
  its launch-less upserts read as "cleared" on every owner tab, and a git pull cancelled queued
  `--after` launches. **Server canvas control delivers only what landed**: `open` and
  `run` launch nothing when their write-ahead `castAndSave` was refused (canvas control stopping),
  and `refreshArmed` types a held command only when `savePatches` says both that the save landed and
  that its claim applied to the fresh read (a teammate may have deleted, re-armed or claimed the node
  since the verb looked); `NodePatch.apply` answers whether it landed.
- **One reducer, `applyCanvasOp`** (`shared/canvas-content.ts`), applies an op to the authority's
  state and to every client's STORED copy of a project (background projects, and every board op).
  Two appliers is how an authority and its clients silently diverge. The only other applier OF A
  RECEIVED OP patches the active project's live React Flow array for node ops
  (`applyMutationToFlow`), because a trip through the serializers would wipe the selection; live
  edge ops go through the reducer's own edge applier, `applyEdgeMutationToScene`. THIS renderer's
  own node writes into a background project are not received ops and take `applyOwnNodeMutation`
  (unstripped: the held launch is ours to set or clear — see the `pendingLaunch` paragraph). **The
  node publisher never casts them** (it diffs React Flow, and a load is ADOPTED as its baseline), so
  every own writer of the projects store (`applyOwnNodeMutation`, `appendCanvasLinks`, and the
  sessions sidebar's `renameNode` / `recolorNode` / `removeNode` / `moveNodeToGroup` / …) runs
  through `ownWrite`, which hands a lazy diff of the project's nodes and edges to
  `setStoredCanvasPublishHook`; Canvas casts it only for a GOVERNED project that is not the one React
  Flow holds (`canvas/stored-publish.ts`). Without it a ⌘⇧T reopen or a cold open into an off-screen
  shared project was dropped from disk by the next overlaid save, and a sidebar close killed the
  session while the overlay put the node back. An ungoverned project casts nothing new.
- **The solo-gate trap.** The publisher casts nothing while no teammate is attached, and on a governed
  project that loses every edit. The gate is `shouldPublishFor` = `(hasPeers || governed) && sameCore
  && !readOnly`: a Server Edition tab publishes every project until its first `canvas:authority`
  answer and re-asks on reconnect, and neither our own echo nor a src-less core op proves a peer
  (`provesPeer`). The desktop answers `[]`, so it is unchanged.
- **Prune removals are never cast** (`diffKanbanOps`' `liveNodeIds`). Every board commit prunes the
  cards of nodes that are not live locally, and a client whose node op has not arrived yet would
  otherwise cast the removal of a fresh card for everyone. `liveNodeIds` is one project's nodes
  (React Flow's for the rendered project, the Omni board's live lane included). Card and meta
  removals are last-writer-wins VALUES; only node, edge, column, label and view removals are rule-4
  deletions.

**Share with team (SSH → hosted team)** (doc section "Share with team from the desktop"). A desktop
SSH project's "Share with team…" installs (or just probes) nodeterm-server on the host as the SSH
login user, runs `team bootstrap` (init + owner + adoption by real path + share, one idempotent
admin verb), hands the terminals over (`team resume`) and joins. The renderer sequences it
(`lib/shareSshTeam.ts`, pure, every effect injected), main runs each step as ONE generated command
over the ControlMaster (`main/remote-ssh/share-team.ts`; the server binary, `main.cjs`, data dir and
the adopted folder come from the cached, validated probe, never from the renderer), and every command
is built in `core/remote-ssh/share-team-remote.ts` and run under a real `/bin/sh` by its test. The
invariants:

- **Never a home directory, at three layers.** A new SSH project's folder is `~`, and every teammate,
  Viewers included, may `fs:read` anything under a shared folder (the jail is the shared root and
  nothing else), so sharing the home hands out `~/.ssh`, the agents' credentials and the hook
  tokens. The probe prints the home's real path (`homeReal`); `sharePlan` refuses the root, the home
  and any ancestor of it, segment-wise (`SHARE_REFUSAL.homeFolder` / `homeAncestor`), and a home it
  could not read refuses rather than guess (`homeUnknown`). Main re-reads the cached probe's plan
  before every step (install only for a plan that does not refuse, bootstrap and resume only for a
  ready one) and bootstrap adopts THAT probe's folder; `bootstrap(projectId)` takes no path. The
  server's `adoptFolderNow` refuses the same set on real paths (`E_BAD_CWD`, against
  `os.homedir()`), so a hand-run `team bootstrap --adopt ~` is refused too.

- **Handover ordering: nothing ends before `bootstrap` succeeded; nothing is resumed before its old
  session is VERIFIED gone.** The kill runs on the host's `node-terminal` ONLY (`RMT_TMUX_SOCKET`,
  which is the same socket the server core resumes on since the 2026-11 unification — the kill
  precedes the resume, which is what keeps one process per conversation), with the exact target
  `-t '=nt-<id>'` built only through `sessionName`, then a `has-session` per node.
  `gone` needs tmux's OWN absence message: exit 1 is also a client/server protocol mismatch or a
  socket it may not open, where the kill failed too, and reading those as gone starts a second agent
  on one conversation (two CLIs appending to one transcript). `alive`/`unknown` nodes are reported
  "still running on SSH" and never resumed. **Never the every-socket kill** (`KILL_TMUX_SOCKETS`):
  `node-terminal` on that host is where the server core starts the very sessions being handed over.
  Every failure after the mark and before a successful bootstrap undoes the mark and reopens the
  project (and says so when the undo itself fails); after it, the SSH project is NEVER reopened,
  even when the kill or the join fails, because that would be a second writer. `team resume` re-asks
  with the core's exact `sessionVerdict` (the folded `sessionExists` prefix-matches): present ⇒
  `already-running`, unknown ⇒ refused, and a node another request in this process is still
  launching is `already-running` too (`ResumeDeps.inFlight`, ONE set per server process, claimed
  before the first await): the desktop's call times out at 60 s while the server keeps draining, so
  a re-run never doubles an agent.
- **What may be handed over is read twice, and only what the user confirmed may change nothing.**
  Busy is `working`, `blocked` AND `waiting` (a Codex approval prompt and an open AskUserQuestion
  are `waiting`); an agent only the status store knows (launched by hand) counts as busy
  (`ShareNode.liveAgentId`) but is never resumed — resume stays on `node.agentId`, so a stale status
  agent cannot make the server type `claude --resume`. A terminal attached to another host
  (`otherHost`, `sshConnectionIdForProject`) refuses the share by title: its kill on the project's
  host would read "gone" and leave it running elsewhere. The orchestrator re-reads the canvas
  (`ShareDeps.canvas()`, which commits the live canvas first) right before the mark: a busy agent or
  a changed terminal SET refuses with nothing changed, and the handover then uses that read. The
  flush check compares EVERY node id of the project (notes, frames) with the host's file, read
  again at the flush, because the server adopts that file.
- **Single writer: `handedOffTo` (machine-local, index entry only, never in `project.json`).** The
  in-progress mark (`{at}`, no `hostId`) is set and SAVED before the mirror flush, not at the close:
  a save between the flush and the close would otherwise queue a throttled mirror write that lands
  after the server adopted the file. From then on `mirrorSshCache`, `reconcileSsh`, the 15 s poll
  (`pollableSshProjectIds`; `sshProjectIds` stays IDENTITY, a handed-off project is still somebody
  else's machine), `kanbanWriteNow` and `pushSshSettings` all skip the entry, and the field survives
  restarts (threaded through every `fileToProject` base; a file field of that name is ignored).
  Every reopen path (Recently closed, ⇧⌘T, `openSshProject`'s endpoint reuse) warns first, and only
  "Open here anyway" clears it. That answer also marks the project's terminal nodes to skip their
  automatic cold-resume ONCE (`terminal/handed-off-resume.ts`; the node raises `CoState.resumeSkipped`
  and says why): the share killed their SSH sessions, so each would otherwise type `--resume <id>`
  over SSH while the server runs the same conversation. The mark is TRANSIENT on purpose and taken
  by the node's first local mount (warm or cold; never by a relay node), unlike the persisted
  `agentStatus.paused`, which is keyed by a node id the team tab shares.
- **The SAS skip lives in ONE writer of `approvedAt`, and `source` gates nothing.** The client
  auto-confirm is `autoApprove: approvedAt !== null` (`hosted-join.ts`, for the bookmark recorded
  with the code's exact host key); `relay-bookmarks.ts` only validates `source`, it is a label.
  Normally `approvedAt` is set by a human's OK after a SAS comparison. `shareTeam.seedBookmark`
  (`main/remote-ssh/share-team.ts`) is the one writer that sets it WITHOUT one: a new bookmark
  labelled `source:'ssh'`, or, for an existing bookmark with the same hostId and host key,
  `approvedAt` set on it while it keeps its token and its `source` (often `'code'`). It rides the
  existing client bookmark auto-confirm, so it is NOT a seventh confirm site. That is sound only for
  its input: the join code `team bootstrap` returned over the project's own ssh channel (host key
  authenticated by `known_hosts`; `decodeJoinCode` checks hostId = hash(key) and `wss:`/loopback
  `ws:`). Main enforces that: it remembers the code each project's last SUCCESSFUL bootstrap
  returned (in memory) and refuses to seed any other, however valid. A failed seed degrades to the
  SAS prompt, never to a skip; any pasted code compares the SAS.
- **Hosted tabs are one per shared project, and the tab id IS the host project id.** relay-api
  translates no ids, so a tab under any other id asks the host about a project it does not know: a
  closed relay copy under that id is replaced, anything else holding it (an open tab, a local
  project) is skipped, never renamed. One relay connection serves all of a team's tabs. They follow
  `relay:hosted:shared-changed {projectIds}`, which goes to EVERY connection the host serves —
  `tellMembers` asks `standing`, so the `pinFailed` viewer fallback is included (`EDITOR_ONLY` as a
  call, always passed by `VIEW_EVENTS`), because `workspace:server-change` ignores unknown ids
  and viewers never receive `canvas:authority-changed`. A tab the user closes is dismissed until
  the project is unshared; nothing shared keeps one placeholder tab. A hosted tab never cold-resumes
  an agent (`canColdRestore` excludes `source === 'relay'`). A CLOSED team tab is NEVER reopened: once
  closed its relay session is disposed and `sessionForProject` falls back to the LOCAL session, so a
  reopen mounts the host's node ids on this core (local shells, agent cold-resume). The ONE reopen
  funnel, `reopenProjectUnchecked`, refuses any `remote` project with `CLOSED_TEAM_TAB_NOTICE`
  (so does every path through `reopenProject`); "Recently closed" lists neither the tab
  (`isReopenableClosedProject`) nor its closed sessions (`isClosedTeamTab`); `planReopen` answers
  `refuse` for ANY entry into a closed team tab BEFORE recreating a node into it (a `nodes` entry
  would otherwise be written into it and reopen it), and ⇧⌘T drops that entry (kept on top it
  would answer every later ⇧⌘T with the notice and hide every older entry);
  `performCloseProject` does not push a project entry for a relay tab. What brings the tab back is
  joining the team again with none of its tabs open, or an unshare + share (a reconnect keeps it
  dismissed, `lib/hostedTeamTabs.ts`).
- **One node id, two projects: owner lookups go through `nodeOwner`** (`lib/nodeOwner.ts`). After a
  share the closed, handed-off SSH project and the team tab hold the same node ids, and the SSH
  project comes FIRST in the list (a team tab is appended), so a bare
  `projects.find(p => p.nodes.some(...))` sent every "go to node" to the reopen warning. `nodeOwner`
  prefers an open project, then one without `handedOffTo`, then any, and skips a CLOSED team tab
  entirely (its reopen is refused; the shared node then falls back to the handed-off SSH project,
  whose reopen asks first); `focusNodeById`, the agent
  rename-node handler, `presenceTravel.nodeTravel` and the Omni board's rename use it. Deleting a
  project keeps the agent status of node ids another project still holds (`nodeIdsHeldElsewhere`).
  Deliberately NOT moved to it: `routeControlSource` (a control request comes from a LOCAL agent, so
  preferring an open relay tab would route it to another machine).
- **A relay session owns its agent status** (bug D: a team tab never showed RUNNING / NEEDS YOU /
  unread, because the joiner's only `agent:status` subscriber was Canvas's listener on the LOCAL
  api, which writes the DEFAULT store). `wireRelayAgentStatus` (`session/relay-agent-status.ts`,
  held as a session teardown in `openRelayTab` right after `createSession`, before any further
  await, so the RpcClient's early buffer flushes into it) subscribes the session's OWN api's `onAgentStatus` for the session's
  lifetime and feeds `applyAgentEvent` into that session's keyless store
  (`getSessionStores(id).agentStatus`). Routing is by api, never by a project lookup: two relay
  sessions may serve one project id. **A reader of a team tab's node must not ask the default
  store** (the known ones that still do are the doc's follow-ups): after Share with team the
  handed-off SSH project (local session, default store) and its team tab (relay session) hold the
  SAME node ids, so a reader that asked the default store, or the active project's, shows one
  project's status on the other's node, and a restart that read it would quit a host session the
  badge shows as RUNNING. Readers resolve per project
  (`agentStatusForProject`; `useAgentStatusLookup` / `useAgentStatusSig` re-subscribe inside the
  session-registry listener, so a reconnect that leaves the signature unchanged still moves them to
  the new store) or per node (`useSessionStores()`, render-safe for a session disposed a moment
  ago). **No ack**: a read on a team tab clears unread on this desktop only (`agentStatusForApi`
  builds the store with no `ackDone` callback), because an `agent:ack-done` would dismiss the
  OWNER's phone Live Activity for a session they never looked at; the tab subscribes neither
  `agent:unread-clear` nor `agent:subagent-activity`, and plays no sound and raises no notification.
  **Snapshot ordering**: subscribe FIRST, then ask `agent:status-snapshot` (served by both shells
  through `registerAgentStatusSnapshotIpc`, the newest 2000 mirror entries, narrowed for VIEW roles
  and scoped guests by `narrowResponseForRole` via `sharedNode`), and apply it only to nodes no live
  event touched in between (`liveSeen`; subagent events do not count, or the subscribe-time subagent
  replay would hold the busiest nodes blank). A restored or identity-only mirror entry travels with
  no `state`. A stateful one carries `ageMs` (an age, so no host clock crosses the wire) and sets
  ONLY `stateAt = now - ageMs`, never `lastEventAt` / `lastSeen`: the joiner saw no transition, and
  a fabricated one would claim it did. The teardown empties the store, so a dropped tab reads
  Unknown. The status-driven readers that act on THIS machine are off for a relay node
  (`relayStatusGates`: Approve/Deny, title sync, transcript search, the ⌘M chat view; the card
  modal's `ModalTerminal` gates its transcript search the same way); only `'local'` runs them, and
  `'relay'`, `'server'` and an unknown source fail closed. A desktop Team
  Access host's agent emits go through `corePlatform.broadcast` (its window plus every non-quiet
  peer); `agent:unread-clear` stays main-window only. Mobile: N/A (the phone speaks the legacy
  dialect and reads the mirror file). Follow-ups, including the Canvas-level readers still on the
  default store: docs/hosted-team-relay.md, "Agent status on a joined tab".
- **Admin errors are stable codes, and a `--json` refusal goes to STDOUT.** `E_BAD_KEY`,
  `E_BAD_CWD`, `E_HOSTING_OFF`, `E_ADOPT_FAILED`, `E_BAD_REQUEST`, `E_UNSUPPORTED`
  (`core/relay/admin-error.ts`); a remote caller branches on the code, never the sentence, and
  Node's own errno codes never pass as one (`adminErrorCode`). Under `team <verb> --json` a server
  failure (exit 1: a refusal, or no server reachable) prints `{"ok":false,"error","code"?}` on
  stdout beside the human line on stderr (`code` only when the server sent one), because the
  desktop's ssh exec reads stdout only: a refusal on stderr alone arrives as an empty, unparseable
  reply. The CLI's own argv/stdin refusals (`parseTeamArgv`, the resume stdin parse) exit 2 on
  stderr only. Bootstrap starts hosting and waits up to 15 s for the relay's first verdict BEFORE it
  writes an owner, a project or a share: a refusal (`E_HOSTING_OFF`) writes none of them, and no
  verdict yet (`hosting:'starting'`) is still a success.
- **`curl | bash` is a trap: download to a temp file first** (`SHARE_INSTALL_SCRIPT`). With no
  `pipefail`, a failed download pipes an EMPTY script into bash, which exits 0, so a failed install
  reads as a success; the temp file goes on every exit, HUP/INT/TERM included. Related: the probe
  never RUNS a server bundle it has not recognised (`BOOTSTRAP_MARKER` grepped from `main.cjs`),
  because a build from before the `team` CLI ignores `team` and boots a second server on the live
  data dir. And a value with `'` or `\` is refused, never nested-quoted: fish's single quotes treat
  both as escapes, so no nesting survives every login shell.

**Known gap (accepted for v1): two writers of the same agent files on a shared host.** The server
core and the desktop's `RemoteHooks` (for any SSH project still on that host) write the same files
under one `$HOME`, with different bytes; the last writer wins.
- **What collides.** The hook script `~/.nodeterm/agent-hooks/<agent>.sh` (same path, command and
  event lists; `mergeManagedHook` strips our entries first, so a config never doubles, and under a
  version skew the last writer's event set stays): only the server's copy carries the Codex
  thread-identity prelude (`REMOTE_IDENTITY_ROOT` is null). And the discovery files: by default the
  server writes the `get-linked-context` skill and the context-link blocks in `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md` and opencode's `AGENTS.md` (`src/server/index.ts` `initServerContextLink`),
  and with server canvas control on the `manage-nodeterm-canvas` skill and blocks
  (`src/server/canvas-control.ts`), all naming its own shims under `<dataDir>`, which bake the
  prelude; `RemoteHooks` writes the same files naming the neutral `~/.nodeterm/context.sh` /
  `nodeterm.sh`.
- **When each re-asserts.** The server at every start (the daily auto-update restarts it). The
  desktop: the hook script on connect and on every hook-tunnel repair (the reuse branch re-runs
  `setup()`); the discovery files through the agent-tools freshness check, which rewrites any that
  differ on connect, on every tunnel repair, and hourly while a project on that host is connected.
- **Who is affected.** Only shared-identity Codex tool shells on the server: they carry no
  `NODETERM_*` env and need the prelude to find their node, so against the desktop's copies their
  hooks report nothing. Every other pane carries its own endpoint env and works with either copy
  (and when a session's endpoint is dead, the script's failover can deliver its event to the other
  core's endpoint).

**Outbound to non-editors, since security audit (a)/(d)/F3/F4:** presence is rewritten per peer
(`createPresenceFilter`: only peers on a shared project, node references outside nulled, joins and
leaves synthesised as a peer moves), `context:update` needs a shared node behind its session (the
payload's `nodeId`, else the mirror's `nodesForAgentSession`; unattributable = dropped), a
Commenter's board comment is reduced to a comment's fields and rate-bounded per peer key
(`append-budget.ts`), and a shared folder that is the disk root, the home directory or an ancestor of
either or of the data dir is not a root at all (`share-root.ts`).

**Known limitations** (full list in the doc): a viewer's socket backlog over 1 MB still
pauses the shared pty through Stage 2 backpressure; the canvas authority's own limits (a project's
non-content fields stay last writer wins between tabs, the share-time window, oversized nodes, board
edits to another core, load-time repairs that are never cast) are under "Known limits" in the doc;
the GitHub issue summary modal reading its "Agent runs" log from this machine on a relay tab is under
"Limitations (v1)".

**Surfaces:** Desktop is full (joiner, plus approval and invite code in an owner's hosted tab, plus
Share with team from any desktop OS onto a Linux host). Server Edition is the host (the `team` CLI,
`team bootstrap`/`team resume` included; its browser clients cannot approve and are not hosted
peers, and its `shareTeam` rejects with `E_UNSUPPORTED`, having no SSH projects). Mobile is N/A for
v1: the phone still speaks the legacy dialect, and the host it would join now exists in core. The
iOS follow-up is the tunnel-dialect migration.

## Speech / dictation (desktop + server)

Voice-to-text input captured via microphone, turned into terminal text via on-device Whisper. Works on desktop (Electron) and Server Edition (browser); iOS support is separate (`nodeterm-ios`, private — see the three-surfaces entry under Conventions).

- **Service seam** (`src/core/speech/`) — `SpeechService` (core) + `PlatformSpeechProvider` interface + shell implementations (`PlatformElectron` / `PlatformServer`). Models are stored under `${dataDir}/speech-models/`, with fenced downloads + orphan sweep (`removeUnusedModels`). Core validates license: **tiny** free (always); **base·small·large-v3-turbo** Pro (via `isPremium()`). One model loaded at a time (FIFO memory management), lazy smart-whisper import degrades to a friendly error if the native dep is unavailable (`"Local whisper is unavailable…"`).
- **Cloud contract (iOS parity)** — `/v1/transcribe` multipart endpoint (not built yet; SDK `transcribe()` call matches iOS byte-for-byte) for future remote transcription. IPC channels `speech:*` (in `src/shared/ipc.ts`) wired in **both** Electron and Server: `speech:transcribe` (returns `Promise<{text}>`), `speech:models`, `speech:model-download`, `speech:model-delete`, `speech:progress` (main/server → renderer download-progress broadcast), and `speech:mic-consent` (Electron mic-prompt only, server always true). There is no `speech:synthesize` / `speech:cancel` and no audio in the reply.
- **Renderer capture** — `PcmCapture` AudioWorklet (16kHz single-channel PCM, WebAudio or fallback SPN) + DictationOverlay (⌘⇧D dock mic / Cmd key; Settings → Speech section for model choice + progress). **Send** appends text + Enter to the terminal; **Insert** sends text-only via `sendText(…, {enter: false})`. **Nothing auto-submits** (user always decides when to send).
- **Language** — `SPEECH_LANGUAGES` (`src/shared/speech.ts`) is whisper's own `LANGUAGES` table
  (tokenizer.py) verbatim: 100 entries carrying the code, CLDR's English name, the endonym and the
  alternate spellings people type (whisper's own name where it differs, plus its documented alias
  table); Cantonese is flagged `sinceV3`, the one entry the pre-large-v3 models have no token for.
  It replaced a **7-entry array inside `SpeechSection`** which was the ONLY limit in the whole
  stack (issue #586): `SpeechSettings.language` is a free string nothing validates on the way to
  disk and whisper.cpp takes any code, so `"language": "pl"` hand-edited into settings.json
  transcribed Polish correctly while the dropdown rendered **blank** and overwrote it on the next
  click in the row. Three rules come out of that:
  - The control is the app's **searchable menu idiom** (`SpeechLanguageSelect` — `.bind-select`
    trigger + portaled `.tab-menu` with a pinned filter over a scrolling list, the Source Control
    branch quick-pick's shape), never a `<select>`: 101 rows with no search, unreachable by typing
    "polski", is not a picker. Rows are the pure `renderer/lib/speechLanguageRows.ts`.
  - **A code we cannot name is still the user's setting.** `speechLanguageLabel` returns an unknown
    code AS-IS (not `''`) and the picker gives it its own row, so a display gap can never become
    data loss the way the `<select>` made it.
  - **The cloud `locale` is passed through unchanged, `auto` included.** `register-ipc.ts` used to
    send `language === 'auto' ? 'en' : language`, so on the Cloud engine "Auto-detect" was a hard,
    silent English — on the one engine where a missing language could not be worked around at all.
    `/v1/transcribe` does not exist yet, so `auto` = detect is our contract to write.
  Deliberately NOT done here: seeding the initial value from the system locale (issue #586 §3) —
  the default is still `auto`. **Mobile** keeps its own list, tracked separately as issue #591.
- **Browser constraints** — `getUserMedia` requires HTTPS or `localhost`; mic permission prompt is the browser's own (not handled by nodeterm). Model downloads land on the **server's data dir** (accessible across sessions).
- **Electron + native dep** — smart-whisper is externalized + `asarUnpack`'d (not bundled); `postinstall` rebuilds it against Electron's ABI. Device verification of the ABI rebuild is not yet exercised on a dev machine — test paths exist but have not been run in CI.
- **Linux x64 ships TWO whisper binaries, picked per CPU (issue #1267).** smart-whisper's
  binding.gyp passes no `-m` flags, so on x86-64 ggml compiles at the SSE2 baseline and every
  AVX/AVX2/FMA/F16C kernel drops out (`objdump -d smart-whisper.node | grep -c ymm` = **0** on the
  shipped build). Measured, base model, 3 s of audio, 12-thread AVX2 box: **18.8 s** as shipped vs
  **1.9 s** with `-mavx -mavx2 -mfma -mf16c`, and the same 11.2 s → 1.5 s under Electron's ABI; the
  report was large-v3-turbo taking ~7 min for one sentence. `scripts/patch-smart-whisper.mjs` (run
  before `electron-rebuild` in `postinstall`/`rebuild`, beside the node-pty patch) adds a
  `smart-whisper-avx2` target behind a gyp `OS=="linux" and target_arch=="x64"` condition — mac and
  Windows builds are unchanged — and makes smart-whisper's loader read
  `globalThis.__NODETERM_WHISPER_BINARY__`. `pickWhisperBinary` sets it from `/proc/cpuinfo`.
  **Never ship a single `-mavx2` build**: on a CPU without AVX2 that is a SIGILL that takes the
  whole app down on the first dictation, which is why the baseline stays and why every failure
  (flags unreadable, variant file absent, variant fails to load) falls back to it rather than to
  "unavailable". `WHISPER_SIMD_FLAGS` and the script's `SIMD_FLAGS` must name the same set (pinned
  by `smart-whisper-patch.test.ts`, which also fails on an unpatched install). Threads:
  `whisperThreads` replaces whisper.cpp's `min(4, cpus)` with about half the logical CPUs plus two,
  capped at 8 — **not** every CPU: ggml's workers spin-wait, and 12 threads on 12 busy logical CPUs
  measured 12.8 s against 8 threads' 1.4 s. Not covered yet: macOS x64 (Accelerate, same missing
  SIMD flags in ggml), a GPU backend (this smart-whisper has no Vulkan build option), cancelling a
  running transcription, and the Server Edition (installed with `--ignore-scripts`, so it keeps the
  baseline; the startup log line `[speech] whisper binary: …` says which binary loaded).
- **macOS: smart-whisper's Metal shader path is patched to the unpacked copy** (second patch in
  `scripts/patch-smart-whisper.mjs`, marker `NODETERM-PATCH(smart-whisper-metal-asar)`). smart-whisper
  sets `GGML_METAL_PATH_RESOURCES` from its own `__dirname`, which in the packaged app is inside
  `app.asar`; native code cannot read inside an asar ("Not a directory"), so Metal init failed and
  whisper.cpp ran on the CPU with no error shown. The shader file is already unpacked (asarUnpack), so
  the patch rewrites `app.asar` to `app.asar.unpacked` in that path. MEASURED with the app's own binary
  on an M5 Pro, large-v3-turbo, 2.7 s clip: 5.97 s on the CPU, 0.64 s on Metal; in the app, dictation
  went from several seconds to under one. A dev install and an explicit `GGML_METAL_PATH_RESOURCES`
  are unchanged.
- **smart-whisper's model params are patched to start from whisper.cpp's defaults** (third patch in
  `scripts/patch-smart-whisper.mjs`, marker `NODETERM-PATCH(smart-whisper-ctx-params)`, every
  platform). Its `LoadModel` declared `whisper_context_params params;` and set only `use_gpu`, so DTW,
  `gpu_device`, `flash_attn` and the rest were uninitialized stack memory and the result depended on
  what was there. MEASURED on an M5 Pro, Electron 42, large-v3-turbo: the shipped binary crashed in 4
  of 4 runs outside the app (`aheads_masks_init` then a crash in `whisper_free_state`, because garbage
  switched DTW on with large-v3's alignment heads); with the defaults it ran without a crash, 0.56 s
  for a 2.7 s clip and 0.93 s for 21 s on Metal. The slow dictation inside the packaged app is a
  separate bug: Metal cannot read its shaders inside app.asar. A newer whisper.cpp is
  faster again (0.22 s / 0.43 s, measured the same way) but needs a build change on every platform;
  that is a separate follow-up.

## Packaging & auto-update

Built with **electron-builder** (config in the `package.json` `build` block: appId
`com.nodeterm.app`, productName `nodeterm`, mac dmg+zip for arm64 **and** x64, `asarUnpack`
node-pty, output `dist/`). The app icon is generated from the nodeterm mark by
`scripts/make-icon.mjs` (sharp → `build/icon.png` 1024² + multi-resolution `build/icon.ico`
for Windows, both gitignored — regenerated by `make-icon`, which every dist script runs first);
the same script hand-packs `build/icon.icns` (size-checked frames — issue #369) and `build/icon.ico`, which electron-builder embeds as-is. Scripts: `npm run make-icon`, `npm run dist`
(local **unsigned** arm64 `.dmg` smoke test), `npm run dist:win` (unsigned x64 NSIS installer +
zip, `--publish never`). Production release signing/notarization and the update-feed hosting are
handled outside this repo.

**The running app's name is `node-terminal`, not `nodeterm`.** Electron reads `app.name` from
package.json's top-level `name`; `productName` lives only under `build`, which electron-builder
strips from the packaged package.json, so it names the bundle and the installer and nothing else.
Everything keyed by the app NAME therefore says `node-terminal` on every build, dev or installed:
`userData` (`~/Library/Application Support/node-terminal`, `~/.config/node-terminal`,
`%APPDATA%\node-terminal`), the `node-terminal Safe Storage` Keychain entry, electron-updater's
`node-terminal-updater` cache. Only what is keyed by the bundle id (`com.nodeterm.app`) or the
bundle itself (`/Applications/nodeterm.app`) carries `nodeterm`. `scripts/uninstall.sh` looked
under `…/nodeterm` and never found the desktop's data; `scripts/uninstall.test.ts` now ties its
`APP_NAME` to package.json `name`.

**Linux ships AppImage + deb + rpm**, all unsigned, all built by `release-linux` on a plain
`ubuntu-latest` runner (`npm run dist:linux` locally). Three things about it are easy to get wrong:

- **The packages are named `node-terminal`, the AppImage is named `nodeterm`.** electron-builder's
  `linuxPackageName` is package.json's `name`, not `productName` (it only falls back to the product
  name for an `@scope/…` name), so the artifacts are `node-terminal_<version>_amd64.deb`,
  `node-terminal-<version>.x86_64.rpm` and `nodeterm-<version>.AppImage`, the launcher is
  `/usr/bin/node-terminal`, and the install prefix is `/opt/nodeterm` (that one IS the productName).
  Anything that matches on the package name (`scripts/uninstall.sh`'s `dpkg -s` / `rpm -q` probes,
  the README's install lines) must say `node-terminal` or it silently never fires. Renaming the
  package to match the app would strand existing `.deb` installs on a package apt no longer tracks,
  which is why the mismatch is documented rather than fixed.
- **The rpm target shells out to the system `rpmbuild`.** electron-builder bundles fpm, but not
  rpmbuild, so `release-linux` installs it explicitly (`apt-get install -y rpm`); without it the
  target dies with "Need executable 'rpmbuild' to convert dir to rpm". The default `Requires` set
  electron-builder emits (gtk3, libnotify, nss, libXScrnSaver, `(libXtst or libXtst6)`, xdg-utils,
  at-spi2-core, `(libuuid or libuuid1)`) resolves on Fedora 44 with nothing extra pulled in;
  verified by installing the built rpm, which also proved rpm 6.0.2 accepts fpm's spec.
- **Auto-update is already correct for rpm and needs no work**: `isManualUpdatePlatform`
  (src/shared/update-platform.ts) keys off the absence of `APPIMAGE` in the environment, so a deb
  and an rpm install both land on the manual-download card rather than downloading an AppImage
  they cannot install.
- **The ORDER of `build.linux.target` is load-bearing: AppImage stays FIRST.** electron-builder
  writes the update feed from the first target it can publish, so the entry at the head of that
  array is what `latest-linux.yml` points at — and the AppImage is the only Linux artifact
  electron-updater can actually install in place. `deb` has sat behind it for a long time without
  disturbing the feed, and `rpm` is appended behind both for the same reason. package.json is JSON
  and cannot carry the comment, so it is written here: **do not alphabetize or otherwise re-sort
  that array.**

**Building on a GCC 14+ distro needs `CFLAGS=-D_GNU_SOURCE`** (Fedora, Arch, recent openSUSE; the
CI runners are old enough not to care). smart-whisper's vendored `whisper.cpp/ggml/src/ggml.c`
calls `CPU_ZERO`, `CPU_SET_S`, `pthread_getaffinity_np` and `getcpu` without ever defining
`_GNU_SOURCE` (upstream ggml gets it from its CMake build, which node-gyp does not use), and GCC 14
promoted implicit function declarations from a warning to an error, so a bare `npm install` fails
in smart-whisper's own install script before our `postinstall` ever runs. Measured on Fedora 44 /
GCC 16.2.1: `CFLAGS=-D_GNU_SOURCE npm install` builds both native modules clean. Two Fedora runtime
packages are needed on top: **`libxcrypt-compat`** (fpm's bundled Ruby links `libcrypt.so.1`, which
Fedora's glibc dropped, and without it BOTH the deb and the rpm target fail), and **`fuse-libs`**
for anyone running the AppImage, whose default runtime is still the FUSE2 one. Switching
`build.toolsets.appimage` to `"1.0.3"` would drop that FUSE2 requirement, but the static runtime is
upstream-flagged beta and stops passing the `--no-sandbox` launcher argument the FUSE2 path adds,
so it is a deliberate not-yet.

**Windows ships as an UNSIGNED BETA** (extracted from external PR #276; the session-host phase
#305 merged 2026-08-20, and the decision to release without signing is #454 — CI-green, but no
real-device daily-use verification yet, and that is a stated risk, not an oversight). Deliberate
decisions: the target
is **NSIS via electron-builder** — the fork switched to Squirrel.Windows
(`electron-builder-squirrel-windows` + an 800-line `windows-installer.mjs` wrapper + its own
update feed), but our pipeline is electron-builder end-to-end and NSIS is built in, needs no
extra dependency, and is what electron-updater's generic provider expects on Windows — so
Squirrel was not adopted. Builds are **unsigned** (no Windows cert; electron-builder skips
signing when no cert env is present; SmartScreen warns on install). Release wiring is
`release.yml`'s `release-win` job: on every version tag it uploads the NSIS installer + zip as
GitHub Release assets — **best-effort by design** (the `publish` promote gate does not wait on
it, so a Windows failure never strands the mac+linux release) and with a **passive notice feed
only**: it builds `dist:win:release`, which stamps `nodeTermUpdates=manual` →
`updateDelivery` = `manual-install` (the marker wins over the platform), and uploads `latest.yml`
beside the installer + zip. The app checks the feed and shows the same "vX is available —
Download" card a Linux .deb gets; it never downloads, never installs on quit, and main refuses
`appRestartToUpdate` for any build that is not `self-install`/`dev` (`mayQuitAndInstall`), so
`quitAndInstall` cannot run on the unsigned beta whatever the renderer sends. A failed
AUTOMATIC check on that marker build is not carded (offline, or a mirror that does not
serve `latest.yml` yet, must not raise an error card on every launch) but is recorded
(`lastUpdateCheck`) and logged as one warning that names a 404 on `latest*.yml` as the mirror
missing the file (`describeCheckFailure`); a user-initiated check still reports its failure. Local `dist:win`
keeps `disabled` (never polls). Do not add `*.blockmap` (or a broad `*.yml`) to that job's
upload globs — differential downloads are the self-install leg, and it waits on signing; guarded
by `src/main/release-win-workflow.test.ts`. The nodeterm.dev/updates mirror serving `latest.yml`
lives outside this repo; `release.yml`'s `verify-feed` job (after the promote, never a gate) curls
each `latest*.yml` there and compares `version:` to the tag — mac/linux are errors, `latest.yml` a
warning until the mirror is confirmed to serve it. `bootstrap-windows.bat` (repo root) takes a fresh Windows
machine to a built checkout: it verifies Node ≥ 20 / VS Build Tools C++ / Python 3 with exact
winget hints (it never installs machine-wide tools itself, and the full bootstrap refuses to run
elevated) and runs `npm ci`. Its `--check-vs-build-tools` mode is the narrow exception used by
`quality-windows`: it branches before the elevation refusal, runs only the VS C++ probe, and exits
before the Node / Python / `npm ci` steps. Fixture injection additionally requires the explicit
`NODETERM_BOOTSTRAP_TESTING=1` sentinel. The C++ probe also verifies the x64 Spectre runtime that
`node-pty`'s `/Qspectre` build requires; the workload alone can be present while that optional
component is absent, which otherwise fails only after the full install with `MSB8040`. Before
`npm ci`, the bootstrap sets `npm_config_enable_thin_lto=false` and
`npm_config_enable_lto=false`: official Node 26 Windows builds carry clang/lld ThinLTO settings in
`process.config`, and node-gyp 12 copies them into an MSVC addon project where `link.exe` rejects
`/opt:lldltojobs` with `LNK1117`. These are gyp overrides, not a reason to reject a Node version
allowed by `package.json`. `.github/workflows/win-package-smoke.yml` is a
**workflow_dispatch-only** packaging smoke on windows-latest — build only, never publishes.
Windows installer safety (#829): `build/installer.nsh` overrides NSIS's process-killing check.
A running app or session host blocks install/uninstall, and a failed process query blocks too.
Never restore automatic host termination: quitting the app preserves those live sessions.
Update preparation must keep saved canvas nodes: exit programs normally, quit, then have the user
verify and stop any remaining host. Never recommend **End session** (it deletes nodes). Cold agent
resume depends on supported, saved conversation history; it does not preserve running tasks.
See `docs/windows-session-host.md` for the user-controlled preparation/recovery steps and limits.
**Unattended runs wait** (silent or `--updated`, the app's own handoff, which starts while
nodeterm.exe is still exiting): on preflight exit 10 they poll up to ~30 s; exit 20 stays fatal at
once, nothing is ever killed, and the machine-wide name match stays (old uninstallers kill by
name). A timed-out `--updated` install writes `%LOCALAPPDATA%\nodeterm\update-failed.json` and
relaunches the installed build before quitting; the updater reads + deletes that note on start
(`main/update-install-marker.ts`). This is the prerequisite for any future Windows self-install.

**Prepare for update (#829 step 2).** The in-app answer to the refusal above, Windows only.
Rules a refactor must not undo:
- **The host's `shutdown` command is the only thing that stops the host**, and only on a connection
  that negotiated the `shutdown` hello feature (`SESSION_HOST_FEATURES`). An older host answers
  `host-unsupported` and the dialog shows `MANUAL_UPDATE_STEPS` — never a taskkill/name-based
  fallback from the app. The host ends every session through the SAME `handleKill` path (taskkill
  of the tree, then node-pty's onExit as proof), refuses attach/attachExisting/executeLaunch while
  it runs, bounds each kill at 20 s, and on ANY unconfirmed kill answers `ok:false` naming the
  sessions and keeps serving. It exits only after the success reply is flushed (`socket.end`), and
  removes its state/token files. It touches no node metadata; nodes cold-restore next launch.
- **Inspection never launches a host** (`SessionHostClient.inspectForUpdate` /
  `shutdownForUpdate` read the published state first; absent = `no-host`). Once `shutdown` is
  sent the client latches `shutDownForUpdate` so a dropped connection cannot reconnect into a
  freshly launched host that re-locks the install dir; only the host's explicit refusal (or a frame
  provably never sent) clears it. "Shut down" means reply AND state file gone AND pid dead.
- **Busy blocks, from either source**: `planUpdatePrep` (`renderer/lib/updatePrep.ts`, pure)
  refuses on working / waiting / blocked / a held question or approval ticket, read from the
  renderer store AND core's mirror (`app:update-prep-inspect` carries `mirror` per session) — an
  unmounted node's renderer state is cleared, so the mirror is the only witness for closed/other
  projects. Only a MOUNTED node can be asked to quit (`registerAgentUpdateExit` in TerminalNode:
  Pause's exit half with its refusals, marking SLEEPING not PAUSED so cold restore resumes it);
  every other agent is disclosed as "stopped without a clean exit".
- The confirm is a danger `ConfirmDialog` with `enterConfirms={false}` (Cancel focused) and says
  plainly that shells and their unsaved work stop and that nodes are kept. Never route anything
  through End session / node deletion.
- **A staged host only needs a quit** (U3): the host publishes `exe` (its `process.execPath`) in
  its state file (optional, additive); `classifyHostImage` / `resolveHostStaging`
  (`core/session-host-runtime.ts`) answer `staged | install | unknown`, falling back to a process
  query by pid for 0.4.1–0.4.3 hosts. Only `staged` sets `UpdatePrepInspection.staged`, and only
  then does the dialog lead with "Quit nodeterm (sessions keep running)" (`prepareEntry`), with
  stopping sessions as the secondary path. `unknown` is never staged — fail closed to the stop flow.
- IPC (`app:update-prep-*`) is raw `ipcMain`, main-window senders only, and in
  `HOST_ONLY_CHANNELS`. Server Edition: the bridge stub answers `unsupported` (Linux tmux, no
  installer; a browser must never end every session on the server). Mobile: N/A — a phone cannot
  authorize an update shutdown; it sees its sessions end like any other end.

**Staged host runtime (#829 step 3).** The host used to run as a hard link of `nodeterm.exe` INSIDE
the install dir, so it mapped the installed exe/DLLs/`resources.pak` and every update stopped until
the user ended it (and every session). Packaged Windows builds now copy what the host needs into
`%LOCALAPPDATA%\nodeterm\session-host\<version>-<fingerprint>\` and launch
`nodeterm-sessionhost-v2.exe` from there (`core/session-host-runtime.ts`, wired in
`session-host-backend.ts`; the client waits at most `STAGED_RUNTIME_WAIT_MS` for the first staging
of a version). Rules a refactor must not undo:
- **Only a published, verified copy is launched.** Files are copied into `.staging-<uuid>`, each
  re-read and compared by SHA-256, the copy is smoke-run once (`ELECTRON_RUN_AS_NODE`, requires its
  node-pty, must exit `SMOKE_OK`), the marker is written LAST, and the dir is published by one
  `renameAtomic`. A dir without a valid marker (sizes checked on reuse) is moved aside, never run.
- **A new image name.** Old uninstallers match `nodeterm.exe`/`nodeterm-session-host.exe` by NAME
  machine-wide; the staged host must never answer to either. The preflight deliberately does not
  match it by name (path test still applies).
- **Fail-safe, not fail-open.** Any staging failure, or a staged host that dies within 10 s with a
  code other than the host's own 0/1 (`stagedExitWantsFallback` — a missing DLL, a policy block),
  falls back to the legacy hard-link launch for the rest of the run. That host still blocks the
  installer through the unchanged read-only preflight.
- **GC is fail-closed.** An old version dir is deleted only when a successful Win32_Process query
  shows nothing running under it, no staged-host process has an unreadable path, it is older than
  10 min, AND a rename aside succeeds (Windows refuses while an image inside is mapped). The
  uninstaller leaves the staged runtimes alone (never kills a host); `docs/uninstall.md` lists them.
- **The file set is not measured yet** (written on Linux): exe, top-level `*.dll`, `icudtl.dat`
  (required), `resources.pak`, snapshot blobs, `locales/`, `resources/session-host/**`. The smoke
  run is what proves it per machine; device checklist in docs/windows-session-host.md.
- **Protocol is additive-only across versions.** A newer app keeps using an older staged host
  (protocol v1/v2 + `hello` features); an unsupported one is left running and reported
  (`SessionHostProtocolCompatibilityError`), never killed. ~250 MB of disk per staged version.

**Follow-ups, in order:** code signing, then Windows self-install (drop the `manual` marker from
`dist:win:release` and upload blockmaps — blocked on signing: an unsigned auto-update is a
downgrade in trust; the passive notice already ships), and the fork's PE-identity polish (electron-builder leaves `OriginalFilename`
empty; the fork's
`resedit`-based afterSign hook fixes it — cosmetic for NSIS, load-bearing only for Squirrel).

**macOS permission prompts are declared in `build.mac.extendInfo`, and a missing one denies
SILENTLY.** On macOS 15+ a connection to the user's own subnet is gated by Local Network privacy,
and it is attributed to the **responsible process** — for everything nodeterm spawns (the tmux
server, the shell, an agent CLI, the `node` it runs) that is nodeterm.app, not the child. With no
`NSLocalNetworkUsageDescription` there is no string to prompt with, so the system never asks and
**no row appears** under System Settings → Privacy & Security → Local Network for the user to
grant: an agent gets `EHOSTUNREACH` on a LAN address while `/usr/bin/curl` (Apple-signed, exempt)
reaches the same host in the same second — a permission failure wearing a network outage's error
(issue #589). `NSBonjourServices` is the trap that travels with it: it is required only to *browse*
mDNS services, which this app does not do, and declaring service types we never browse is a false
claim to the user and to review — unicast LAN access needs the usage description alone. The key is
what makes the denial grantable; it is not itself proof anyone's access came back. Guarded as an
allowlist-with-reasons by `src/main/info-plist.test.ts`, the sibling of the entitlements guard.

Auto-update uses **electron-updater** (`src/main/updater.ts`, `initUpdater(hooks)` from `index.ts`):
runs **only when `app.isPackaged`** (dev = no-op), checks on launch + every 6h, auto-downloads,
forwards the lifecycle (`update-available` / `download-progress` / `update-downloaded` / errors)
to the renderer over IPC. `components/UpdateCard.tsx` shows the strip + **Restart to update** →
`updates.restart()` → the guarded `restartToUpdate()` (also the background-mode tray's "Restart to
update vX" item); on `update-downloaded` an OS notification also fires when the window is
unfocused. Exposed via `window.nodeTerminal.updates` (`UpdateApi`). macOS *silent* self-install
requires a signed+notarized build; unsigned builds still surface the card for a manual download.
Rules a refactor must not undo (pure + tested: `shared/update-gate.ts`, `renderer/lib/updateCardState.ts`):
- **electron-updater is never imported at module scope** (it cost 32–47 ms warm before `ready`, on
  every launch). `initUpdater` loads it through `UpdaterDeps.loadUpdater` (default: a
  plain `require`) only where it is used — at init for a build with a feed, on a restart click in
  dev, never for `no-channel` — and only AFTER the `appGetVersion` / `appGetStagedUpdate` /
  `appRestartToUpdate` handlers are registered, which stay eager on every build (the renderer
  invokes them on mount; an invoke with no handler rejects). Tests pass their double through
  `loadUpdater`, because `vi.mock` does not reach a `require()`. Pinned in
  `updater.no-channel.test.ts` and `src/main/lazy-deps.source.test.ts`.
- **electron-updater keeps re-announcing a STAGED update** (the running binary is still old, so every
  6h check emits `update-available` → cached `update-downloaded` again, and on macOS re-stages the zip
  through Squirrel). The gate forwards and notifies **once per version**; once staged, `autoDownload`
  goes off and only a strictly newer release is downloaded (`downloadUpdate()` on purpose). The card
  never downgrades `downloaded`/`required`, never un-minimizes on a repeat, respects a dismissed version.
  Two consequences that must stay paired with that: a renderer loading after the one-time
  announcement (⌘R, a recreated window) asks `updates.getStaged()` on mount, and a **failed
  Squirrel.Mac staging run is re-staged** on the next check (or a Restart click — once per click,
  never in a loop from the error itself), because with `autoDownload` off nothing else would.
- **macOS `update-downloaded` fires BEFORE Squirrel.Mac has the update** (MacUpdater dispatches, then
  asks the native updater to fetch + verify the zip). Until Electron's own `autoUpdater` emits
  `update-downloaded`, `quitAndInstall()` only queues a listener. So a click there sends
  `app:update-installing {phase:'preparing'}` and waits; only when ready does it send `restarting`,
  flush the renderer's canvas save (`main/renderer-flush.ts` — must happen HERE: quitAndInstall closes
  the windows before `before-quit`), and only THEN run `onBeforeRestart` (the `quitting` /
  `skipQuitConfirmation` flags). A native/install error calls `onRestartAborted` to put them back.
- **One error owner, and background failures are not cards**: the `'error'` listener classifies by
  origin (`classifyUpdaterError`) — an automatic check or background download failing (offline, captive
  portal, feed 5xx) only logs; a background download retries at 15/30/60/120 min. User-initiated
  checks (every button goes through `checkForUpdatesNow`, which is how the card knows) get a plain
  sentence (`friendlyUpdateErrorMessage`). Automatic checks are silent until `downloaded`.
- The mandatory policy is re-read every 6 h (one 60 s retry after an empty/failed first read); release
  highlights come from the feed's `releaseNotes` or `/v1/check` `update.notes` + `latestVersion`.
Server Edition: no updater (stubs; `onInstalling`/`onFlushRequest` are documented no-ops). Mobile: N/A.
The "auto-download off" setting is NOT here — that is PR #956's.

**Backend check feed** (`src/core/check.ts`, successor to the static `announcements.json`): the
**main process** calls `GET https://api.nodeterm.dev/v1/check?deviceId=&version=&os=&arch=&channel=stable&plan=`
(so the renderer CSP stays `'self'`) on launch + every 6h, cached 5 min, returning `{ messages, update }`.
The one cache exception: a reply fetched before the open-project count was known (launch reads the
feed before the workspace index has loaded) is refetched once the count is, so the launch check is
not left count-less for five minutes. `deviceId` is the anonymous install id the backend counts active installs by. **Only while Settings →
Privacy → Telemetry is on** does the query also carry `openProjects=<n>` (the open-project count, a
number only; the backend keeps each device's maximum for the project limit). The reply may also
carry `limits: { projects: { free, epoch } }` while the free-tier project limit is on (absent = off);
core hears it through `onCheckAnswer`, and only a CHECK-SHAPED reply (a `messages` array + an
`update` object) without `limits` reads as off and clears the latch — anything else is `unknown` and
changes nothing (see **Free-tier open-project limit**).
Exposed split over two IPC handlers: `announcements.fetch()` → `messages`, `appUpdatePolicy` →
`update`. `components/AnnouncementBanner.tsx` (stacked above `UpdateCard` under the tab bar in a
`.top-banners` column) shows the newest message the user hasn't dismissed (dismissed `id`s persist
in `localStorage`); `update.mandatory`/`minSupported` flips `UpdateCard` into a blocking required-
update state. **One-time popups** ride the same reply under their own `popups` key (admin console:
Display → "popup (once)") — a separate key, so every build that reads only `messages` (older
desktops, mobile) never receives one as a banner that would come back every launch.
`components/AnnouncementPopup.tsx` (pure rules in `lib/announcementPopup.ts`) shows the newest one
not shown before and records it in localStorage (`nodeterm.seenPopups`) the moment it is SHOWN, not
when closed, and shows at most one per feed read. It waits — re-reading the feed every 5 min, so a
deactivated popup is dropped — until settings AND the license are known (`useEntitlement.known`:
`isPremium` is a default `false` before that, and an upgrade popup must never reach a Pro user),
nothing is open on the dialog stack OR among Canvas's own non-stack surfaces (`blocked`: setup
tour, Settings, palette, dictation, …), and no key was pressed for 4 s. It then focuses its own box
— never a button, so Enter/Space press nothing, and keys stop reaching the terminal under the scrim
— and takes Escape in the CAPTURE phase: xterm stops propagation of Escape, so a bubble listener
never hears it and the agent in the pane gets an ESC that interrupts its turn. Its button opens
`url`, or with `action: 'upgrade'` starts the Pro checkout — an upgrade popup is skipped for a Pro
user, dropped the moment the plan flips, and closes when Pro arrives. A popup may carry a picture
(`image`, a SHA-256): `fetchPopupImage` in `core/check.ts` gets it from `API_BASE` by that hash, so
the feed can name no URL, checks the hash and the magic bytes, caps the size while reading, and hands
the renderer a `data:` URL because the CSP's `img-src` takes no network source. It is fetched as part
of the feed read, and a popup whose picture cannot be had waits for the next read, unrecorded: it
shows only once, and it was written around that picture. Never add HTML to these messages: a
picture carries a design with no code in it. Server Edition: the bridge answers `[]` (it does not read the feed). Mobile:
N/A for v1 (follow-up in the iOS repo). The call no-ops under
`DO_NOT_TRACK`/`NODETERM_TELEMETRY_DISABLED` or in unpackaged builds (unless `NODETERM_API_BASE`
targets a local server). Schema example:
`docs/announcements.example.json`. **The request also states `plan=pro|free`** (offline
`isPremium()`), because the admin console can aim a message at paid or free users and the feed is
anonymous — the backend cannot look a device's plan up, and matches only on what we send (a build
that sends no plan sees only audience-less messages). So an answer belongs to the plan it was asked
with: the 5-min cache is keyed by plan, a failed read after a plan change keeps the update policy but
NOT the other plan's messages, and the banner re-asks when `useEntitlement.isPremium` flips — else a
"try Pro" message stays up for six hours after the user pays. **Telemetry** (`src/main/telemetry.ts`) is a separate opt-out
ping to `api.nodeterm.dev/v1/ping` (version/OS on launch + daily), gated on
`settings.telemetryEnabled` + the same build/DNT guards; toggle in Settings → Privacy. **That toggle
gates the ping AND the check's `openProjects` count — never the check itself**, which runs whatever
it says (only DNT / `NODETERM_TELEMETRY_DISABLED` / an unpackaged build stop it).

## Atomic writes (never a bare `fs.rename`)

Every store persists temp-file-then-rename. That is correct on POSIX and **silently lossy on
Windows**: `MoveFileEx` fails with `EPERM` whenever the destination is open by anyone at that
instant, and what opens a file you just wrote is Defender's real-time scanner, the search indexer,
OneDrive over a synced profile, or two of our own concurrent writers racing one destination. The
save throws and the data is gone — intermittently, unreproducibly, and **more often on the machines
that are best protected**.

`renameAtomic` / `writeFileAtomic` (`src/core/fs-atomic.ts`) retry briefly. Each attempt is still
one indivisible rename, so a retry cannot tear a write. They deliberately do NOT retry forever
(several callers report a failed save as `persisted:false`, and that contract outranks a save that
eventually lands), do not retry `ENOENT`/`ENOSPC`, do not branch on platform (or the behaviour under
test on a Mac is not the behaviour shipped to Windows), and never swallow the final error.

**Nothing in the toolchain catches the bare version.** 28 files had it, across three spellings — the user's canvas, their
settings, their sealed credentials, their pinned devices — and every one of them reads as a correct
atomic write, because on the platform most of this was written on it is one. The only signal in a
6,000-test suite was one store's overlapping-saves test, red on Windows for that store's whole life.
So it is enforced by scan: `src/core/fs-atomic.guard.test.ts` fails on any bare `fs.rename` outside
the helper. Full write-up, including the separate shared-temp-name bug at the same sites:
**`docs/atomic-writes.md`**.

SSH/scp staging follows the same ownership rule outside direct `fs` calls. Atomic remote stdin
writes use `src/main/remote-atomic-write.ts`: a bounded `.nodeterm-<uuid>.tmp` leaf is placed beside
the target BEFORE both complete paths are quoted, then the shell preserves the write/move status
while cleaning that exact temp. The temp leaf must stay independent of the target leaf — appending
`.uuid.tmp` to a valid `NAME_MAX` target makes the write impossible.

**A remote write is only complete if the host checked the byte count, and a rename alone does not
check it.** `cat` cannot tell "the body ended" from "the ssh channel ended": when the channel dies
before the body arrives (the ControlMaster killed or rebuilt on a reconnect, the runner's 15 s
timeout SIGTERMing the child, a dropped link) it reads EOF and EXITS 0. Measured against OpenSSH 9.6
with the master SIGKILLed and with the child SIGTERMed, both before the body: a bare
`cat > f && chmod 755 f` left `f` at 0 bytes and flipped 644 → 755, and the temp + `mv` shape
published the empty temp over a good file just the same. That is how, on 2026-09-28, a host's
`~/.nodeterm/nodeterm.sh` and `context.sh` were 0 bytes after a reconnect and every agent's canvas
call exited 0 with no output. So `remoteAtomicWrite(path, body, options)` takes the BODY, checks
`[ "$(wc -c < temp)" -eq <utf-8 bytes> ]` before the rename (a short temp exits
`REMOTE_WRITE_SHORT_BODY` = 65 with the target untouched), returns the `stdin` it was built for,
and refuses an empty body unless `allowEmpty` (only the generic `ssh-fs` write passes it — an editor
may save an empty file; nothing we GENERATE is ever empty). `runRemoteAtomicWrite` also THROWS on a
non-zero exit: the runners resolve on failure, and awaiting them and moving on is what made the
failure silent. Every remote write goes through it — filesystem API writes, tmux.conf, the hook
endpoint, node tokens, agent status, pending answers, session env files, the Codex relay and
launcher, every agent hook script, the canvas/context shims and skills, and our own grok/copilot
hook configs. The USER's files — Claude/Gemini `settings.json`, codex `hooks.json` and
`config.toml`, and the AGENTS.md / GEMINI.md / copilot-instructions.md instruction blocks — go
through `updateRemoteTextFile` / `updateRemoteSettingsFile` (`core/agents/hooks/remote-settings-file.ts`)
instead: the same byte check plus our lock, symlink resolution (a dotfile link stays a link),
mode preservation, and a compare-before-publish; a read that fails is never treated as an empty
file (the old `cat f || true` then `cat > f` replaced an unreadable AGENTS.md with our block alone).
The local installers for the same files use `writeManagedHookFileAtomic` / `mergeInstructionFile`.
`src/main/remote-ssh/remote-write.guard.test.ts` fails on any new bare `cat > <file>` in
src/{core,main,server}, and `remote-write-truncation.test.ts` runs every installer under a real
`/bin/sh` with the body cut off.
**Never `chmod <mode> -- <file>` in a remote command.** BSD/macOS chmod does not permute: its
getopt stops at the MODE operand, so the `--` after it is a FILE named `--` ("No such file or
directory", exit 1) and the `&&` chain never publishes. `mkdir -p --`, `mv -f --` and `rm -f --` are
fine (their `--` comes before any operand). That spelling shipped from v0.3.3 (fbc65ad8) for the
hook endpoint and node tokens, so `setup()` returned null on every macOS SSH host — no status
hooks, canvas control or context link there. The real-shell tests put a non-permuting chmod
(`POSIXLY_CORRECT=1` GNU chmod) first on PATH for every mode-bearing caller.
**Canvas control and context link install as ONE chain** (`RemoteHooks.installAgentTools`): they
merge different blocks into the same AGENTS.md / GEMINI.md, and the transaction lets only one of two
racing writers publish a snapshot — fired side by side they lost 16–19 of 48 blocks over 8 fresh
hosts. Upload directories use UUIDs across app
processes. Downloads and media-cache copies use hidden UUID `.part` names; user-visible downloads
also hold an exclusive candidate lock until the rename and cleanup finish. Never simplify any of
those back to `<target>.tmp` / `<target>.part` or a read-only "does the destination exist?" check —
the overlap tests exercise the resulting race.

## Durable orchestration state (queue, station reports, hand-over holds, request ledger)

Four facts a canvas-control orchestration leans on used to live only in process memory, so an app
(or Server Edition) restart erased them while the work they described kept going: a `send` answered
`queued` vanished while its sender believed it would be delivered; every station report vanished, so
each `--after-success` dependent read BLOCKED and needed ▶ / `run`; and the `--request-id` ledger
emptied, so a retry after a restart re-ran an open that had already happened; and the plain-`--after`
hand-over hold (#1052) was forgotten, so a dependent fired on the first `done` after a restart. All
four are now
mirrored to `<userData>/orchestration-state/<kind>.json` through ONE storage module,
`core/durable-state.ts` (`DurableFactFile` + a per-fact `DurableFactSpec`), so a new fact is one more
spec, never a fourth copy of the read / sanitize / write / flush code.

- **Machine-local only** — userData, never `.nodeterm/project.json`: a queued body, a station verdict
  and a control reply are one machine's run state, and a clone must not inherit them. Written 0600
  (a queued message's body is the user's text). **Relay tabs and the phone: N/A** — the facts belong
  to the core that executes the calls; a relay tab talks to the host's core, whose files these are.
- **The file is hostile input.** Envelope `{kind, version, savedAt, records}`; an unknown kind or
  version starts empty (warned), a record the fact's sanitizer refuses is DROPPED (never repaired),
  lists are capped, and a file that is not JSON / too large (16 MB) / not an envelope is set aside as
  `<file>.corrupt` (one copy) and the fact starts EMPTY with a warning. **Loading never throws** — a
  bad orchestration file must not take the boot with it.
- **Writes** are a unique `wx` temp then `renameAtomicSync` (the fs-atomic guard applies), coalesced
  over 50 ms, one in flight, latest snapshot wins; `flushAllDurableFactsSync()` runs on the desktop's
  second `before-quit` pass, `hookServer.stop()` flushes the ledger, and the Server Edition's
  canvas-control `stop()` disposes its three files (queue, reports, holds). A **crash** inside the
  50 ms window loses that window. **A sync flush is never overwritten by an older async write**
  (review of #1054, reproduced: `save([1])`, `flush()`, `save([2])`, `flushSync()` left `[1]` on
  disk): `flushSync` bumps a generation, and the async path checks it and renames in ONE synchronous
  step, dropping its temp when stale.
- **Every owner budgets its bytes under the 16 MB load limit**, because a file past it is set aside
  WHOLE (reproduced in review: 80 queued 250K-char bodies wrote 20 MB and 0 of 80 came back). The
  queue writes full entries up to 8 MB of JSON and the rest REDUCED (no body, short fields only —
  `bodyOmitted`, which restore turns into an expiry the sender hears about); the ledger writes
  replies up to 8 MB and the rest as UNKNOWN rows (still refused, never re-run).
- **Only the instance that owns the hook endpoint owns the facts.** The ledger is loaded by
  `hookServer.start()`, which fails for a second instance; the queue, reports and holds follow the
  same rule (`standDown()` when `startForApp()` returned a warning — desktop `main/index.ts`, Server
  Edition `ownsDurableState`), so a second instance on the same userData neither expires messages
  the live one holds nor overwrites its files.
- **The desktop queue restore waits for the workspace INDEX** (`restoreDeliveryQueue(…, {ready:
  workspaceStore.load({sideline:false})})`): an entry that lapsed during the downtime is expired
  there, and its sender leg resolves the sender's project and board log through the index, which
  nothing else has loaded at that point of boot (review of #1054: the expiry otherwise reached only
  the in-memory trace ring). The Server Edition already awaited the load before canvas control.
- **Measured** (this Linux dev host, the ledger at its 4096-row cap with realistic open replies):
  377 bytes a row, a 1.5 MB file, 11.5 ms per full write, 16.6 ms to load at boot; a 20-row ledger
  writes in 0.41 ms. The queue is bounded far lower (16 per target), the reports at 1000.
- **Boot order is load-bearing** (desktop `main/index.ts` right after `initAgentStatusMirror()`;
  Server Edition inside `initServerCanvasControl`, which runs after the mirror): station reports
  first — their session check reads the restored mirror — then the hand-over holds, then the
  delivery queue, whose restore
  replays a `queued` hand-over per waiting message (so "work pending" is REBUILT from the queue, not
  stored twice) and settles, without landing, every message that lapsed while the app was down (which
  withdraws the station's report exactly like an in-run expiry).

What a restart MEANS, per fact — decided beside each fact, stated in its header:

- **Queued message** (`core/agents/delivery-queue.ts`, `QUEUE_FACT`):
  - **The TTL keeps running while the app is down** (deadline = `enqueuedAt + ttlMs`, wall clock). A
    message whose deadline passed is EXPIRED at restore — traced `expired`, the sender told through
    `onExpired` — never delivered late and never dropped in silence. The rest re-arm with the time
    they have LEFT (a clock that went backwards cannot stretch one past a full TTL).
  - **Same session only.** At enqueue the target's agent + session id are recorded from the status
    mirror (`bindingOf`). A RESTORED entry flushes only when the target's current session and agent
    are the recorded ones (`restoredBindingVerdict`): a different one — respawn, `/clear`, another
    agent in the pane — ends it `targetGone` with nothing typed; an entry with no recorded session is
    refused the same way; a target that has not named a session yet WAITS (TTL running). In-run
    entries are unchanged.
  - **The whole gate chain still runs at flush.** Consequence to know: after an app restart where tmux
    survived, pane ownership is unproven (`pane-ownership.ts` records only on a fresh spawn), so the
    first flush is refused `notPermitted` and the sender is TOLD — still strictly better than the
    silent loss it replaces. After a machine reboot the cold-restored pane is a fresh spawn, so a
    message for a session that resumed under its old id delivers. The Server Edition's creator
    ledger is process-local too, so a restored message there is refused `caller-not-owner`.
  - **Never replayed into a pane**: a board comment (only the local user, typing in THIS app, may
    trigger one — a message read back off disk must not speak as a person) and an app-composed
    station notice; both, and a body over 256 KB (written without it), are expired at restore so
    their row / sender still hears the end. Not flushed at boot: the first flush waits for the
    target's next `done`.
  - Threat model, stated: the file is as trustworthy as the per-node token files beside it — a
    same-user process can write either. A forged `send` entry still runs every gate at flush.
- **Station report** (`core/station-outcome-store.ts`, `OUTCOME_FACT`): stored with the station's
  session + agent (`sessionOf`). At load a report whose recorded session or agent differs from what
  the restored mirror now says for that node is dropped; afterwards a `SessionStart` naming a
  different session or agent withdraws it — in-run too, since a report is about a task in one
  conversation (a child's session event, `subagentType`, never counts). An unknown side keeps it. The
  withdrawal runs in `emitAgentStatus` BEFORE the renderer hears the event, so no dependent can fire
  on the stale report in between.
- **Hand-over hold** (`core/station-handover.ts`, `HANDOVER_FACT`, the plain-`--after` fact from
  #1052): the HOLDING stations are stored (`handedAt`, the current turn's start and state, the
  background flag); `queued` is rebuilt from the queue's replay. Times are wall clock, so a turn that
  began before the restart but after the hand-over still ends the hold. Hook events are lost while
  the app is down, so a turn that ended during the downtime is not seen and the hold lasts until the
  next turn end (holding direction; ▶ / `run`). Not bound to a session: a respawned station still
  owes the work it was handed. Loaded after the reports and before the queue.
- **Request ledger** (`core/control-request-ledger.ts`, `CONTROL_REQUEST_FACT`, owned by the hook
  server's route): settled rows replay; a row in flight at shutdown (or a crash) comes back UNKNOWN —
  refused, never re-run, and nothing can settle it any more because its late answer died with the
  old process; a reply over 64 KB is written as UNKNOWN rather than dropped (a missing row would let
  the retry run).
- **Delivery is at most once across a crash:** a flush writes the entry OFF disk before its
  attempt (claim before effect), so a crash mid-delivery loses that one message rather than typing
  it twice after the next boot. Lapsed entries at restore are never inserted into the live lists
  (so no flush can deliver one while the expiries are reported) and take no capacity slot.

## The test suite never touches a live tmux server

This repo is developed from inside nodeterm, so `tmux -L node-terminal` (and a legacy `-L nodeterm-rmt`) are
not fixture names on a contributor's machine — they are the servers holding every terminal they have
open. A test that binds one shares a process with the user's whole canvas, and the failure mode is
not a red test: it is every pane printing `[server exited unexpectedly]` (issue #629).

**Every vitest run gets a private `TMUX_TMPDIR`.** tmux resolves `-L <socket>` to
`$TMUX_TMPDIR/tmux-<uid>/<socket>` and falls back to `/tmp` when the variable is unset, so
re-pointing the variable re-points every socket name at once — including the real ones, including
in a suite nobody thought about. `test/setup/tmux-sandbox.ts` (`globalSetup`) creates the directory,
kills whatever is still bound inside it and removes it; `test/setup/tmux-worker-env.ts`
(`setupFiles`) re-asserts it inside each worker and **refuses to run** if it is missing, because
vitest's env inheritance into workers is an implementation detail and a silent fallback would put
every test back on the live server. `enterSandbox` also strips `TMUX`/`TMUX_PANE` — a suite run from
inside a nodeterm terminal inherits a live client's, and production strips both for the same reason.

Two suites deliberately name a real socket, and both are allowlisted with their reason in
`src/core/tmux-socket-isolation.guard.test.ts`: `agents/pane-owner.test.ts` (the production bytes
hardcode the remote socket name; re-spelling it would judge different bytes) and
`main/remote/host-destroy-tmux.test.ts` (`PtyManager` binds `TMUX_SOCKET` itself). The latter was
the one file that reached the live server by construction — measured, not inferred — and it now
refuses to start unless the sandbox is in effect.

**What the sandbox does NOT do:** two suites naming the same socket inside it still share one tmux
server, so a `kill-server` there is still a shared-server kill — it has just been moved somewhere
harmless. Measured on CI the day this landed: the guard test's own `kill-server` on
`node-terminal` ended `host-destroy-tmux.test.ts`'s session mid-assertion. A suite kills its OWN
sessions by exact target (`-t =<name>`, since a miss falls through to prefix matching), or it owns
a socket name nothing else uses.

The guard has three legs on purpose, and the weakest one is the scan: a test can still escape by
handing a real tmux an `env` object it built from scratch with no `TMUX_TMPDIR` in it, which no
regex sees. So the structural leg is the sandbox, the behavioural leg actually **starts a server on
the real socket name and proves the socket file landed inside the sandbox** (asserting the env var
would only prove we set a variable — the resolution rule is a property of tmux), and the scan exists
to make a third allowlist entry a decision somebody signs for. Same shape as the `fs.rename` guard,
for the same reason: nobody reading one file can see this.

**What this does not claim.** #629's server death was not traced to a test — the reporter's evidence
points at tmux's `server_accept()` calling `fatal()` under the suite's process/fd burst on a
memory-starved machine, and two identical runs finished clean. Sharing a server with the user's live
sessions is a hazard whatever kills it; this removes the hazard, not a proven cause.

**`fakePlatform()`'s directories live exactly as long as the run** (`test/setup/fake-platform-root.ts`,
the same per-RUN `globalSetup` shape as the tmux sandbox). Each call used to `mkdtemp` in the system
temp dir at construction and nothing removed it: a development server running the suite repeatedly
collected ~395,000 `nodeterm-fake-*` directories, `/tmp` ran out of inodes while still showing GBs
free, and full runs failed in 1,201 of 1,207 files with ENOSPC. Measured on 40 suites that use it:
271 directories left behind before, 0 after. Two halves, both needed: the directory is made on first
READ of `userDataDir` (a test that passes its own, or never reads it, makes none), and it is made
under a run root that teardown removes once every test file has finished (vitest tears global setup
down BEFORE it waits for its workers to exit, so a late timer is not ruled out — a per-file
`afterAll` would be strictly worse, sweeping while that file's debounced writes are still due). The
teardown never throws and is listed first so it runs last: vitest's teardown loop has no catch per
file, and a throw there would silently skip the tmux sandbox's teardown. The leaf under the root is a
bare `u-`, because every byte added is closer to the macOS unix-socket path budget
(`hook-sock-path.ts`) for anything a test binds under `userDataDir`. A run killed before teardown
leaves ONE directory. A test that builds its own `CorePlatform` takes its `userDataDir` from
`makeFakeUserDataDir()` (same root, removed with it) — never a bare `mkdtemp` in the system temp
dir and never a fixed `/tmp/...` literal.
`platform-fake.test.ts` fails if the root is not in effect, so dropping the `globalSetup` entry is loud.

## The test suite leaves nothing in the OS temp dir

Measured 2026-09-29 on a shared dev box: `/tmp` held ~41k top-level entries, and one full run of this
suite added ~1,560 of them (`nodeterm-fake-*` alone was 1,412 — see the `fakePlatform()` paragraph
above for that half). The filesystem ran out of INODES and every session's builds and tests broke.
For every OTHER test dir, two layers, both needed:

- **Every test dir is removed where it is made.** `testTmpDir(prefix)` (`src/core/test-tmp.ts`) is
  a tracked `mkdtemp` whose removal is an `afterAll` in the setup file `test/setup/tmp-worker-env.ts`
  — a setup file's hooks sit on the file's root suite and, with vitest's default stacked hook order,
  run AFTER the file's own `afterAll` hooks, i.e. after the suite stopped whatever was writing there.
- **The run is sandboxed and FAILS on a leak.** `test/setup/tmp-sandbox.ts` (`globalSetup`, listed
  AFTER the tmux sandbox so that one keeps its short base path) points `TMPDIR` (and `TEMP`/`TMP` on
  Windows) at one private directory; teardown lists what is left, removes the sandbox anyway, and
  sets `process.exitCode = 1` naming each prefix. **Not `throw`**: vitest only LOGS a teardown error
  (`error during close`) and still exits 0, and a throw skips the other globalSetup teardowns — the
  tmux sandbox's, measured. Windows warns instead of failing (a just-exited child's file can be
  EBUSY for a moment after a correct cleanup). `NODETERM_TEST_KEEP_TMP=1` keeps it for inspection.
  `FOREIGN_TMP_ENTRIES` is the short allowlist of names nothing in this repo creates (Chrome's own
  scratch files from the headless layout tests), each with its reason.
- **Two leaks were production memos, not test bugs**: `contextLinkDir()` and
  `HookServer.endpointFilePath()` cached the FIRST platform's `userDataDir` for the life of the
  process, so a process that booted a second core (the server e2e suites) wrote `context.sh` and
  `hook-endpoint.env` into the first core's already-removed directory. `initContextLink` and
  `hookServer.stop()` now drop the memo. Found with `strace -f -e trace=mkdir,rename` — an EMPTY
  leftover dir is the signature of a late writer, not of a missing `rm`.

## The test suite never touches the real home

The hook installers write the user's real agent config — `~/.codex/hooks.json` plus the
`[hooks.state."…"]` trust blocks in `~/.codex/config.toml`, `~/.claude/settings.json`,
`~/.gemini/settings.json`, grok's and copilot's hook files — and they resolve home through
`import { homedir } from 'os'`. **A `vi.spyOn(os, 'homedir')` does not reach that binding**:
measured on a Windows dev box, running `src/core/agents/hooks/index.test.ts` alone (which
"isolated" home with exactly that spy) rewrote the developer's real `~/.codex/config.toml` and
`hooks.json`. Runs from several worktrees then raced each other, and the user's own Codex, on those
files; a Codex session started inside that window had no trust entries for nodeterm's hooks, so its
hooks never fired and every agent message to it expired as `targetStatusStale`.

- **Every run gets a private home** (`test/setup/home-sandbox.ts` + `home-worker-env.ts`,
  `src/core/test-home.ts`): HOME and USERPROFILE point at one directory created and removed by
  `globalSetup`, re-asserted per worker (refusing to run without it), and the agents' relocation
  variables (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`,
  `KIMI_CODE_HOME`, `XDG_*`) are cleared. On Windows APPDATA/LOCALAPPDATA move inside it too.
  `os.homedir()` reads the variable on every call, so every installer and every child process lands
  in the sandbox whatever its import style. Registered BEFORE the temp sandbox (it lives in the real
  temp dir and is never counted as a leak there).
- A test that needs its own home uses a MODULE mock (`vi.mock('os', …)` returning `homedir`, as
  `install-helper.fs.test.ts` and `codex.ensure.test.ts` do), never the spy.
- `src/core/test-home.guard.test.ts` runs the real `installCodexHooks()` and proves it wrote the
  sandbox while the real `~/.codex` (read from `os.userInfo().homedir`, which ignores HOME) kept its
  size and mtime.

## Conventions

- **Two docs, two audiences — keep both.** This file holds the deep invariants with their
  reasoning and measurements; it is dense on purpose and is loaded automatically by coding agents.
  **`CONTRIBUTING.md` is the short human door**: setup, the process-boundary rules, the house rules
  that get a PR sent back, and the testing habits. When you change or discover something **other
  developers must know before touching the code** — a boundary that is now enforced, a trap that
  costs an hour to diagnose, a habit that catches a class of bug — **add it to `CONTRIBUTING.md`
  too, not only here.** An invariant that lives only in this file (or worse, only in a commit
  message) is one refactor away from being violated by a contributor who never opened it. Keep the
  split by audience, not by topic: the *why it must be this way* stays here, the *what you need to
  know before your first PR* goes there.


- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- **The local machine is not a Mac.** Every user-visible string naming it goes through
  `renderer/lib/machineName.ts` (`thisMachine()` / `thisMachineCap()` / `machineNoun()` →
  "this Mac" / "this PC" / "this computer"). A **browser tab always gets the neutral word**: the
  license, seats and sessions it describes belong to the SERVER, and the viewer's `navigator` says
  nothing about that machine's OS — a confident wrong noun is worse than a plain one. Issue #563
  found ~30 such strings, and the damage was not in Accounts but in the copy people must TRUST:
  "This Mac is not authorized on this license" and "a teammate on a seat can run commands on this
  Mac". `machineName.guard.test.ts` scans non-comment lines in `src/renderer` + `src/shared` and
  fails on a new one, with a named-and-reasoned exemption list (the ptmx-limit banner, whose
  `kern.tty.ptmx_max` really is macOS; the onboarding notch step, which only exists there).
  `@shared` code cannot ask the renderer, so it takes the machine word as a PARAMETER defaulting
  to the neutral one (`describeGrant(peer, machine)`) rather than hard-coding a brand.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
- **Subagent model:** when dispatching subagents (implementers, reviewers, etc. — e.g. in
  the subagent-driven-development workflow), use the latest model, **Opus 5**
  (`claude-opus-5`). This overrides any cheaper-model defaults in a skill's model-selection
  guidance.
- **Three surfaces — design every feature for all of them.** nodeterm now ships on three
  fronts, and a feature is not "done" until you've decided how it behaves on each (even if
  the decision is "not applicable here"):
  1. **Desktop** (Electron) — the primary app (`src/main` + `src/renderer` via the preload).
  2. **Server Edition** (Linux, browser) — `src/server` + the `src/renderer/bridge` shim (see
     the `src/server/` bullet above and docs/SERVER.md).
  3. **Mobile companion** — *nodeterm mobile*, two **separate PRIVATE repos**: `nodeterm-ios`
     (SwiftUI + SwiftTerm/Citadel) and `eneskirca/nodeterm-android` (Kotlin/Compose, in
     development) — outside contributors cannot see or PR either, so a mobile implication is
     raised in the desktop PR and **@eneskirca** is mentioned to carry it over. Both are
     tmux-integrated, talk the same `TerminalTransport`/RemoteTransport protocol and the same
     pairing/relay/mirror wire contracts, so a desktop change must not assume the phone is an
     iPhone (copy, defaults, store links — see **Phone pairing is platform-neutral**).

  **The canvas and the kanban board are TWO VIEWS of the same nodes — treat the board as a
  first-class surface, not an afterthought.** Every session/node feature you add to a canvas node
  (a header action, a context-menu item, a status badge, file drop, dictation, …) should be
  considered for the kanban **card** and its **card modal** too, so we don't keep shipping a
  feature on one view and then bolting it onto the other in a follow-up. The board already mirrors
  most of the node's surface: the card modal co-attaches the same tmux session (`ModalTerminal`),
  carries the node's actions (search / dictate / AI-name / comments), accepts file drops
  (`terminal/file-drop.ts`), renders browser webviews (`BrowserSurface`), and its cards support
  right-click actions + `+ New`. When you touch a node's UI, ask "does the board need this too?"
  and wire it through `KanbanView`/`SessionCard`/`CardModal` in the SAME change. Node menu rows live in ONE builder, `renderer/lib/nodeActionItems.tsx` (canvas menu, sessions sidebar, both boards' card menus via `kanban/cardMenu.tsx`); a card takes only `BOARD_NODE_ACTION_IDS` and writes through `nodeWritesFor(projectId)`, because the Omni board acts on nodes of projects that are not on the canvas.
  The card modal's ⋯ menu takes `BOARD_MODAL_ACTION_IDS` and closes the modal before any action
  runs, because restart-and-shell, switch model, account switch and pause-and-end recycle the tmux
  session its terminal is attached to; a card of a project the canvas does not hold shows these
  rows disabled with 'This terminal is not attached right now.', and a card with no session row
  (a plain shell, a non-resumable agent) gets no ⋯ button at all. A node the canvas holds but
  whose terminal was released while off screen is a different case (`NodeActionCtx.onCanvas`
  true, `attached` false): Refresh stays enabled, since its respawn is what revives the node,
  and the session rows say the terminal was released (`RELEASED_HINT`). Kanban itself is
  desktop+Server-Edition (pure renderer + `workspace.save`); the iOS board is a separate read/move
  mirror (`nodeterm-ios`, `KanbanGrouping`/`ProjectBoardView`).

  Practical rules that keep the surfaces in sync:
  - **Put new service/main-process logic in `src/core` behind `CorePlatform`, never inline in
    `src/main`.** That is the seam the Server Edition boots from — logic left in `src/main`
    silently doesn't exist on the server (the `no-electron` tests enforce the boundary, but
    they can't tell you a feature is *missing* server-side).
  - **A feature that touches `window.nodeTerminal` needs a real `src/renderer/bridge`
    implementation, not just a stub** — or a deliberate, documented graceful degrade
    (`E_UNSUPPORTED` + the affordance hidden, like the Electron-only `shell.reveal`). The
    bridge's `satisfies NodeTerminalApi` gate forces you to *declare* every member, but a
    `noopUnsub`/`unsupported` stub compiles fine while doing nothing — decide per member.
  - **Consider whether the mobile companion should surface the feature** over its
    transport/protocol. It's a different repo and stack (Swift), so this is usually a
    follow-up note rather than same-PR work — but flag it so it isn't forgotten.
  When a change is genuinely desktop-only (native menus, auto-update, Keychain), say so; the
  point is to make the call consciously, not to leave the other surfaces to rot.

An unanswered Claude `AskUserQuestion` is correlated by session and tool-use ID in the core
mirror, independently of its short-lived display stash. Ordinary hooks, subagent activity and
unrelated transcript results must not clear attention or archive its inbox card. Both shells
use `recordQuestionResult` for transcript rescue (including Escape/decline), and broadcast the
mirror's effective event. Keep result IDs through local and SSH tails; a boolean “some tool
finished” is insufficient. Explicit new user turns, interrupts and session boundaries reset it.

Claude child `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hooks must not drive parent state.
Child `PermissionRequest` and attention `Notification` hooks still reach needs-you and phone
approvals, including the raw approval summary and deterministic reply ticket. Keep raw summary
recording before the child transcript-association guard in both shells.

A held parent question can overlap child permissions: retain its question card and waiting
state while publishing each approval ticket separately. Approval replies resolve only their
own ticket; the picker stays pending until its correlated answer or explicit reset.
When the parent answers first, retain concurrent approval tickets and blocked attention until
their own replies; ordinary tool activity cannot settle them. Explicit turn/session resets
still cancel both kinds of pending attention.

Held approval attention must not replace subagent, recurring or background-task events, or refresh
state evidence from those lifecycle hooks. A parent may ask several questions while a child ticket
is outstanding: track each new picker and preserve child approval cards independently, including
when their display titles match. Answering either resolves only that question or ticket.

Remote Codex safety (#736): `spawnNew` requires managed SSH Codex accounts (including custom
Codex harnesses and known agent-less login terminals) to have a safe id in the saved Codex account
list and a safe resolved `remoteHome`. `remoteAccountScopeEnvArgs` then supplies the private
`CODEX_HOME` and account marker. An unresolved or unsafe home must refuse before env staging/spawn,
not fall back to the host's system login. System Codex retains the host environment even before
home discovery during early attach. Never guess HOME/CODEX_HOME. Desktop and Server share this
core gate; Desktop supports the remote lifecycle, while Server account management remains unavailable.

## Media playback lifetime (#680)

Audio routes through `isMediaFile` to the existing persisted `video` kind and native audio controls.
Legacy audio editor nodes migrate on load. Desktop uses the existing local/SSH allowlist; Server
and relay retain their explicit media transport degradation. Native mobile does not consume these
React nodes; its own player/IME behavior requires a separate device check.

Remote cache entries requested in this run are retained until exit, including cache hits; pruning
waits are coordinated with a concurrent cache reader. The 20-entry cap is soft for retained files,
so disk use may grow in a long run; prior-run entries are eligible again after restart. `mediaRange`
handles suffix ranges and rejects unsatisfiable ones without weakening the serve-time path jail.

## Subagent reload replay (#680)

`core/subagent-replay.ts` retains at most 512 running starts for the existing WORKING_STALE_MS,
with original host timestamps. The shared mirror event path feeds it (including synthetic async
ends); session boundaries and clearNode discard it. Both shells expose the same read, and desktop
preload / browser / relay subscribe before requesting it. Only lifecycle events wait behind the
snapshot (bounded to 512 events / 3 seconds); live permission alerts are not delayed or replayed.
No disk restore, transcript backlog, completed-card replay, or authorization evidence is provided.
A host restart or a missed original start is still outside this recovery.


## IME mode switching (#680)

`terminal/ime-mode-switch.ts` adapts xterm 5.5's composition helper after `open()` in both terminal
surfaces. Caps Lock must not finalize an active composition: the subsequent native compositionend
owns that commit. The test executes the dependency's real helper, with an unpatched double-send
control. This pins one event ordering, not every native IME; macOS Chinese Caps Lock still needs a
device run, including insertText and compositionend orderings. Revalidate the adapter on xterm upgrades.

### Standing phone consent lifetime (#819)

A browse socket can close before the human clicks the SAS dialog. `core/phone-approval.ts` retains
only the handshake-bound id/key for 120 seconds, at most 64 requests, one per key. Socket closure
releases presence and transport but does not discard that bounded consent; replacement, rejection,
expiry and host stop clear the exact dialog id. Approval requires BOTH id and displayed key (no
key-only match or mismatched-key fallback), consumes once, then persists before granting access.
`remote:phone:approve` is raw, owner-window Electron IPC, never a relay RPC. Its response separates
stale/persistence failure from approved/saved-disconnected; renderer rejection/timeout is explicitly
unconfirmed. SAS derivation and mutual trust verification are unchanged. Legacy interactive offers
remain session-only, and Server Edition rejects standing phone approval as unsupported.

Pin/revoke mutations use `updateApprovedDevices` to queue the entire read/modify/write in process;
unique-temp atomic rename alone cannot prevent lost updates. Non-ENOENT reads and malformed JSON
reject rather than overwrite unknown trust state. The queue is not a cross-process lock. A click
accepted before host stop may finish its disk save, but must never open the now-closed session.

Windows messaging final-submit checks cross a second OS identity probe and emulator barrier:
`NativeWindowsPane.sendEnvelope` and `hostMessagePane.send` retain accepted-paste semantics when
the child has changed or paste mode is off, but withhold Enter. The root PTY can outlive the CLI.
`SessionHostClient.sendKeys` tracks whether its V2 frame was handed to the socket separately
from an explicit negative host reply; loss of the reply after transmission returns conservative
partial/unknown delivery, with no resend. The SessionStart idle rescue latch stores its session,
agent and receive time; foreign/missing idle identity never creates proof or changes the
renderer-visible session. These boundaries have behavioral regressions in
`core/windows-delivery-safety.test.ts` and the mirror/client suites.

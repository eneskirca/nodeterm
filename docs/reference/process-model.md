# Process model (Electron, three contexts) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

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

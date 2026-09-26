# CLAUDE.md

This is the deep-reference for working in this repo: the invariants, why each exists, and the
measurements behind them. This root file holds the cross-cutting rules and is loaded in every
session; subsystem detail lives in `.claude/rules/*.md`, each loaded when Claude reads a file its
`paths:` frontmatter matches (see the index below).

**Contributors: start with `CONTRIBUTING.md`** — the short version (setup, boundaries, house rules,
testing habits). These files are what you reach for when you need to know *why* a rule is the way
it is, or you are changing a subsystem they describe. A change that other developers must know
about belongs in BOTH (see Conventions).

**PR text (title, description, comments, review responses) follows the `pr-writing` skill**: what
changed and why it matters, then how it was checked and what was not, then risks or follow-up when
there are any. Structure proportional to the change. `CONTRIBUTING.md` § Pull requests is the
human-facing half of the same rule.

## Topic index (`.claude/rules/`)

A code comment that says "see CLAUDE.md, <section>" means the section's file below. If your change
touches a subsystem whose file did not load (you edited outside its globs), read it before editing.
Add a new invariant to the file that owns its subsystem, not to this root.

- `.claude/rules/persistence-projects.md` — Workspace persistence (index, project files, SSH mirror, cwd-less canvases) and projects/tabs. Loads on `src/core/workspace-*.ts`, `src/core/settings-store.ts`, …
- `.claude/rules/tmux-sessions.md` — tmux continuity, lifecycle levers, park/WebGL, Eco hibernation, pause, cold restore, SSH connect, xterm seeding. Loads on `src/core/pty-*.ts`, `src/core/tmux-*.ts`, …
- `.claude/rules/terminal-node.md` — TerminalNode lifecycle gotchas, wheel/fit rules, IME. Loads on `src/renderer/nodes/TerminalNode.tsx`, `src/renderer/terminal/**`, …
- `.claude/rules/node-kinds.md` — Every node kind, markdown link safety, webview keep-alive, media playback. Loads on `src/renderer/nodes/**`, `src/renderer/editor/**`, …
- `.claude/rules/agents.md` — Agent registry and capability lists, model gateway, grok/gemini/codex notes, permission mode, adding a new agent. Loads on `src/shared/agents/**`, `src/core/agents/grok-paths.ts`, …
- `.claude/rules/agent-status.md` — Hook-driven state model, context meter, DROPPED, unread, session names, ⌘M ChatPanel, subagent/loop cards. Loads on `src/shared/agents/normalize*.ts`, `src/shared/agents/stale.ts`, …
- `.claude/rules/agent-hooks-identity.md` — Hook server, hook installers, SSH hook tunnel, per-node identity, endpoint ownership, held attention. Loads on `src/core/agents/**`, `src/core/agent-status-mirror.ts`, …
- `.claude/rules/agent-messaging.md` — Agent-to-agent messaging and Windows delivery. Loads on `src/core/agents/agent-message*.ts`, `src/core/agents/agent-messaging.ts`, …
- `.claude/rules/canvas-control.md` — Canvas control verbs, off-screen routing, destructive confirms, --after, verify, settings verb, Context Link. Loads on `src/main/canvas-control*.ts`, `src/core/canvas-control*.ts`, …
- `.claude/rules/accounts-usage.md` — Managed Claude/Codex accounts, skill sharing, observed account, usage indicator, remote usage. Loads on `src/core/claude-accounts*.ts`, `src/core/claude-config-dir.ts`, …
- `.claude/rules/session-memory.md` — RAM pill and session-memory panel, idle-energy animation gates. Loads on `src/core/session-memory*.ts`, `src/core/session-budget.ts`, …
- `.claude/rules/appearance.md` — Node colors, semantic colour tokens, node icons, wallpaper, Liquid Glass. Loads on `src/renderer/styles*.css`, `src/renderer/styles*.test.ts`, …
- `.claude/rules/keybindings.md` — Keybinding registry, overrides, dispatch owners, terminal-first stand-down. Loads on `src/shared/keybindings.ts`, `src/main/keydown-intercept.ts`, …
- `.claude/rules/canvas-ui.md` — Context/add menus, edges, focus and camera, breadcrumbs, layouts, palette, Explorer, Source Control, window chrome. Loads on `src/renderer/canvas/**`, `src/renderer/components/*.tsx`, …
- `.claude/rules/kanban-worktrees.md` — Worktrees bound to group frames, the kanban board, card modal, board log, Omni Kanban. Loads on `src/renderer/components/kanban/**`, `src/renderer/lib/kanban*.ts`, …
- `.claude/rules/remote-speech-packaging.md` — Phone relay, phone consent, dictation, packaging, Windows installer, auto-update. Loads on `src/main/remote/**`, `src/main/updater.ts`, …

## What this is

**Node-based terminal manager** (BUSL-1.1, converts to MIT after 4 years — see `LICENSE`): multiple real terminals live on a single
pan/zoom canvas as draggable nodes. Target users are people with ADHD / disorganized
workflows who benefit from a spatial layout over stacked tabs. Long-term vision includes
remote access and paid features — the architecture is built so those slot in without a
UI rewrite (see Transport abstraction below).

## Platform support

macOS, Linux, and a browser Server Edition are the shipping targets; Windows is being brought up
as a first-class desktop target (extraction from external PR #276). The policy for what "supported"
means — and what you may assume when writing a feature — is three tiers, not "100% parity":

- **Core is first-class everywhere.** The terminal + agent + canvas + session-continuity
  experience must work on every desktop platform. Continuity is tmux on POSIX and, where there is
  no tmux (Windows), a standalone session-host process — the mechanism differs, the guarantee does
  not.
- **POSIX-bound edges degrade explicitly, never silently.** Some subsystems are structurally tied
  to POSIX (SSH ControlMaster, the unix-socket askpass transport, some tmux-only paths). On a
  platform where they cannot work they must either use a platform-appropriate mechanism or be
  clearly gated off — a feature that throws `EACCES`/`EPERM` on Windows because nobody checked is a
  bug, not an accepted limitation.
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
  (scrypt + httpOnly cookie + Origin check). `npm run server:dev` to try;
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

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

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
`.uuid.tmp` to a valid `NAME_MAX` target makes the write impossible. It currently protects
filesystem API writes, tmux.conf, the private hook endpoint, node
tokens, agent status and pending answers; some generated hook scripts/config merges still use direct writes; only the guarded shared
Claude/Gemini settings transactions stage and rename here. Do not generalize that claim to every installer. Upload directories use UUIDs across app
processes. Downloads and media-cache copies use hidden UUID `.part` names; user-visible downloads
also hold an exclusive candidate lock until the rename and cleanup finish. Never simplify any of
those back to `<target>.tmp` / `<target>.part` or a read-only "does the destination exist?" check —
the overlap tests exercise the resulting race.

## The test suite never touches a live tmux server

This repo is developed from inside nodeterm, so `tmux -L node-terminal` and `-L nodeterm-rmt` are
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
hardcode `-L nodeterm-rmt`; re-spelling it would judge different bytes) and
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

## Conventions

- **Two docs, two audiences — keep both.** This file and `.claude/rules/` hold the deep invariants with their
  reasoning and measurements; it is dense on purpose and is loaded automatically by coding agents.
  **`CONTRIBUTING.md` is the short human door**: setup, the process-boundary rules, the house rules
  that get a PR sent back, and the testing habits. When you change or discover something **other
  developers must know before touching the code** — a boundary that is now enforced, a trap that
  costs an hour to diagnose, a habit that catches a class of bug — **add it to `CONTRIBUTING.md`
  too, not only here.** An invariant that lives only in these files (or worse, only in a commit
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
  3. **Mobile companion** — *nodeterm mobile*, a **separate PRIVATE repo** (`nodeterm-ios`)
     — outside contributors cannot see or PR it, so a mobile implication is raised in the
     desktop PR and **@eneskirca** is mentioned to carry it over
     (SwiftUI + SwiftTerm/Citadel, tmux-integrated, talks the `TerminalTransport`/RemoteTransport
     protocol).

  **The canvas and the kanban board are TWO VIEWS of the same nodes — treat the board as a
  first-class surface, not an afterthought.** Every session/node feature you add to a canvas node
  (a header action, a context-menu item, a status badge, file drop, dictation, …) should be
  considered for the kanban **card** and its **card modal** too, so we don't keep shipping a
  feature on one view and then bolting it onto the other in a follow-up. The board already mirrors
  most of the node's surface: the card modal co-attaches the same tmux session (`ModalTerminal`),
  carries the node's actions (search / dictate / AI-name / comments), accepts file drops
  (`terminal/file-drop.ts`), renders browser webviews (`BrowserSurface`), and its cards support
  right-click actions + `+ New`. When you touch a node's UI, ask "does the board need this too?"
  and wire it through `KanbanView`/`SessionCard`/`CardModal` in the SAME change. Kanban itself is
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

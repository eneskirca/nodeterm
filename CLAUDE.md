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
files | subagent | loop | dino | trigger` — `subagent` and `loop` are render-only (ephemeral hook-driven
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
  The refusal is **only** in `spawnNew` — a co-attach JOIN to a live session for that node id is
  still correct. An offline node reports itself to `SshReconnector`, so the canvas heals itself;
  `retryNow` (banner Reconnect / node Reconnect) skips the backoff and clears the refuse window.
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
    to prefer the thread record over a set id was rejected: a bind-refused fallback pane legitimately
    runs a thread another node's record names. (2) A launch-command override or custom `launchCmd`
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
  (`isShellCommand` OR the persisted `hibernatedPane` the exit settled on — nu/pwsh users) before
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
  deliberately never an idle proof — see "A restored clock is not an idle proof" in
  `terminal/hibernation-policy.ts`.
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
  (gated on `persistKey`, on BOTH the screen and resize branches) and the renderer writes
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
session.

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
  guard. One document capture `pointerdown` does the rest: outside the node it releases activity
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
  output. Entering the view (output or ChatPanel) blurs the xterm; leaving it restores focus
  only if the terminal had it on entry AND focus is now nowhere or still inside this node
  (`terminal/useMdModeFocus.ts`). While the view is open, every "take the keyboard" path (hover
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
  both separators; UNC tokens are refused whole before they can be reinterpreted as cwd-relative. A path an
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

**Message scope publication:** desktop `send`/`reply`/`notify` wait for pending active-canvas edits
to be saved when either endpoint is on that canvas (`renderer/lib/messageScopeSync.ts`). `list`
and context links can already see a newly opened node while main's `persistedCanvases()` cannot;
the scope resolver reports that absent target as `cross-project`. The publication barrier never
travels, never overrides an external-edit conflict, and does not authorize anything: main still
checks unique project membership, runtime ownership, consent, verified status and the native pane.
An unrelated active canvas is not saved for a background message. Server control already writes
its nodes through the authoritative store; the renderer barrier is a desktop concern. Mobile is
not an agent-message sender.

**A `send` to a node that has not STARTED yet is queued, not refused** (`targetNotStarted`,
`agent-messaging.ts`). A node opened into a project that is not on screen without `--run-now`
exists only as a held launch until the project is viewed, so no spawn has recorded its pane owner.
When the owner is unproven AND no session exists AND this machine holds a launch for it
(`WorkspaceStore.heldLaunch`, the machine-local `localExec` overlay), the outcome is
`targetNotStarted` and the deliver-on-idle queue holds it; the flush re-runs every gate against the
pane the spawn will have proven. A LIVE pane with no proven owner stays `unproven-target-owner` —
that refusal is the security property. Such a message waits up to 24 hours
(`NOT_STARTED_TTL_MS` = `QUEUE_PERSIST_TTL_MAX`): the start waits for a person to open the project,
and the ordinary 5-minute TTL lost the message in the field (queued 19:12, expired 19:17, project
opened 19:27). It is not carried across an app restart (no session was recorded to bind it to), and
a node deleted before it starts keeps it until the TTL. A `targetStatusStale` target — a station
started a moment ago (`--run-now`, `run`) that has not posted its first hook — is queued too, with the
ordinary TTL: a retry cannot help before that hook, and its first verified `done` flushes the queue.
Both shells wire `heldLaunch`.

**A board comment that @mentions a session is a message from a PERSON** (`@shared/board-comment`,
`deliverBoardCommentFromUi` in `core/agents/agent-messaging.ts`). The comment composer's @ picker
inserts an id-based token `@[label](node:<id>)` (the id is the authority, the label only a fallback
name); on send, each mentioned session gets its own delivery through the SAME `runDelivery` an
agent `send` takes — scope, runtime pane ownership, the per-project `agentMessaging` switch, flow
control, the pane probes, the nonce envelope, the receipt, the deliver-on-idle queue with its TTL.
What differs is only who it is from: the scope is "the target is on the comment's board"
(`resolveBoardCommentScope`); the PAIR window belongs to the board (`board:<projectId>` — one comment
per session per 10 s, whichever comment) while the FAN-OUT budget belongs to the comment itself
(`reserveFlow`'s `fanOutKey`, `board:<projectId>:<commentId>`), because a person's turn is one comment
and an earlier comment's in-flight holds or queued flush must never spend a newer one's (review
finding; both scenarios are tests); a comment mentions at most `BOARD_COMMENT_MENTION_MAX` =
`FANOUT_PER_TURN` sessions and is refused whole above it; a pair-limited board comment is QUEUED
rather than refused (`BOARD_QUEUE_ON` — an agent retries, a person could only post again; the
flush re-runs the limiter) AND re-offered on a timer when the window ends
(`DeliveryQueue.retryAfter`, armed at enqueue and at every `rateLimited` re-queue, one pending nudge
per target): the queue otherwise flushes only on the target's `done`, and a window ending emits
nothing — a session already idle, or whose `done` landed inside the window, left the comment to
expire at the TTL; and the envelope reads `from: board comment by <author>` with no node id
and `reply-to: none (…)` (`BOARD_COMMENT_REPLY_TO`; both agent-facing bodies render it from the
constants). An agent node TITLED like that is labelled `node titled "…"` in its own `from:` line, so
it cannot pass as a person. The body is the comment with each token turned into the `@<name>` its author saw
(`mentionNameForAgent`: the token's label reduced to letters, digits, spaces and `. _ - #`, capped at
40, else the node id — a node title is whatever the project file says, and it lands in another
agent's prompt), then `sanitizeChatText` (every C0/C1 control but `\n`/`\t` — the one shared rule)
and a cap. A comment's parallel mention deliveries share ONE `syncMessageScope` save (`coalesce`).
**Only the local user, typing in THIS app, can trigger it.** The log is a shared file — a git pull,
another instance, a relay peer or a team-presence guest can put a token in it — so NOTHING that
reads the log reaches a delivery: the one call site is `BoardLogPanel`'s send
(`board-comment-trigger.guard.test.ts`), the IPC (`agent:board-comment-deliver`) is a raw,
main-window-only `ipcMain` handler that no peer can dispatch into and is also `HOST_ONLY`, and the
renderer refuses a relay-bound project and a browser tab (`canDeliverBoardComments`). Around the IPC
Canvas takes the same two steps as `send`: the target's `guardConcurrentRestart` lock and
`syncMessageScope`. **No silent success**: every outcome is on the comment row — `sending…`, then
the reply's typed outcome (with the `notPermitted` reason) from this app run, else the latest
`agent-message` trace line in the log whose `from` is `board-comment:<commentId>` (the trace now
carries `reason` too, and the queue hands its trace leg the queued request, so a board comment's
`queued`/`expired` lines land on ITS board whoever owns the pane by then). Log lines are trusted
ONLY for comments this machine sent (`nodeterm.boardCommentsSent`, localStorage, bounded): the log
is shared, so a teammate's comment arrives with THEIR machine's trace lines and a forged line is one
append away — such a comment shows no status, and its lines stay ordinary feed rows. For our own:
a line dated in the future is ignored, a `queued` older than `BOARD_COMMENT_QUEUE_STALE_MS` (the
queue TTL + 1 min — a crash still never writes its end; a clean restart does, since the durable
queue expires a restored board comment at boot, see **Durable orchestration state**) says no outcome
was recorded, and a mention with no record at all says so too. A trace line is hidden as a row only
on the card whose comment row shows it; the mentioned session's own card keeps "routed a board
comment here: …". Text tables are read with `Object.hasOwn` (values come from the shared file).
The card modal's capture-phase Escape defers to the composer while its @ picker is open. Desktop: full. Server Edition and relay
tabs: display-only by design (the bridge answers `notPermitted: unsupported-edition`; the picker is
not offered) — a browser or a relay guest typing into this machine's panes is exactly the
cross-user injection this refuses. Mobile: N/A (the phone posts no board comments).

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts).

- **Agent registry + capabilities** — `src/shared/agents/config.ts` holds `AGENT_CONFIG`
  (claude/codex/gemini/copilot/opencode/grok: id, label, spawn command, color, `promptInjectionMode`, …) keyed
  by an **open** `AgentId`
  type (so custom ids fit). Capabilities are membership lists, not flags:
  `AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`, `SUBAGENT_CAPABLE`, `RECURRING_CAPABLE`,
  `BRANCH_CAPABLE`, `CONTEXT_LINK_CAPABLE`, `USAGE_CAPABLE`, `CHAT_CAPABLE`,
  `TRANSFER_SOURCE_CAPABLE`, `RENAME_CAPABLE`, `TITLE_READ_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `PERMISSION_MODE_CAPABLE`, `MODEL_SWITCH_CAPABLE`, with helpers (`hasHooks`,
  `canBranch`, `canContextLink`, `canChat`, `canRename`, `canReadTitle`, `hasPermissionMode`, …).
  Branch stays **Claude-only** purely by being in only `BRANCH_CAPABLE`. The ⌘M **ChatPanel**
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok + gemini + codex + copilot +
  opencode** since 2026-09: grok's `chat_history.jsonl`, gemini's session file, codex's rollout,
  copilot's `events.jsonl` and opencode's `opencode export` document each get their own reader, and
  `chat:read-transcript` routes by agent. That list had
  to be SPLIT to do it — `CHAT_CAPABLE` carried two facts that coincided while claude was its only
  member ("we can render this" and "claude's resolver can locate and parse this file"), and the
  second now lives in `CLAUDE_TRANSCRIPT_READABLE` (claude only). Merging them back is a
  cross-session read of someone else's transcript; `config.capabilities.test.ts` pins the pair.
  The other lists span more agents, and the memberships below are the ones to check before assuming
  "claude-only" (all verified against `config.ts`, 2026-09-02): the per-node **context meter** is
  `USAGE_CAPABLE = claude/codex/gemini/grok` — grok states BOTH numbers, and its own percentage, in
  `signals.json`;
  the **permission mode** is `PERMISSION_MODE_CAPABLE = claude/grok/gemini/codex`; the session-name
  sync is **split in two** — `TITLE_READ_CAPABLE = claude/codex/grok/gemini` (read) ⊇
  `RENAME_CAPABLE = claude/grok` (write), because gemini and codex name their own sessions but have
  no rename command (codex's read leg is `readCodexSessionName`);
  **Context Link** spans five builtins
  (`CONTEXT_LINK_CAPABLE = claude/codex/gemini/opencode/grok`; the one builtin outside it is
  copilot). UI gates
  on these helpers — no hardcoded `=== 'claude'`. **Custom agents** (user-defined in Settings,
  `customAgents`) inherit the declared `baseAgent` harness through `capabilityAgentId`; a custom
  agent with no base remains spawn + terminal-title + process status only. Per-agent write-ups:
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`**, **`docs/antigravity-agent.md`** (there is none for codex — its approval mapping
  and every value's reasoning live in `src/shared/agents/approval-mode.ts`);
  the distilled rules are **Adding a new agent** at the end of this section.
- **Model gateway / switcher** — `settings.modelGateway` stores one gateway root + a NON-SECRET
  credential reference: `${env:VAR}` for environment mode or
  `${secret:model-gateway-api-key}` for a literal held by `ModelGatewayCredentialService`. Desktop
  literal keys reuse the GitHub token store's safeStorage encryption / 0600 fallback; Server
  Edition uses the same generic 0600 atomic store. Legacy plaintext settings migrate only after
  the secret write succeeds. `shared/agents/model-gateway.ts` is the ONE mapping from a base
  harness to derived routes, env vars, compatible models and safely quoted model flags. Env
  expansion reuses `shared/agents/expansion.ts` and happens only in core against the host process
  environment; an unset reference fails closed instead of sending a token or partial credential.
  Discovery at `/v1/models` is the **OpenAI Models API convention**, implemented by both LiteLLM
  and Bifrost; the current `/openai/v1` + `/anthropic` launch-route derivation is Bifrost's layout,
  not the source of the discovery convention. Discovery sends the standard bearer header plus
  Bifrost's `x-bf-vk` header (needed by legacy, non-`sk-bf-` virtual keys), and runs in core
  (`agent:discover-models`) so browser CORS cannot block the Server Edition and the key never
  enters a terminal command. Support is a
  capability (`MODEL_SWITCH_CAPABLE = claude/codex/copilot`) resolved through `capabilityAgentId`, so a
  custom agent with a supported `baseAgent` inherits it automatically — the settings UI and canvas
  menu carry no agent allowlist. A model switch SIGTERMs the pane's foreground non-shell process
  group (never types `/exit`) and RECYCLES the tmux session before cold-resume: an existing shell may
  predate the gateway setting, and tmux env changes do not retroactively change that shell's
  environment. Recreating it guarantees the current URL/key applies without typing a secret into
  the pane. Ordinary Restart stays in-place. Custom-agent env is still merged last and may override
  the shared mapping. Desktop and Server Edition use the same core handler; relay tabs deliberately
  do not apply this machine's gateway to another core. Mobile needs a settings/model-picker surface
  before it can expose the feature.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
  `RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE`,
  `SESSION_ID_CAPABLE` and `SUBAGENT_CAPABLE`. Subagent cards come from grok's native
  `SubagentStart`/`SubagentStop` hooks, keyed by `subagentId` — measured on 1.0.13 by launching two
  `explore` children in parallel (same type, different ids; the start's `sessionId` is the PARENT's,
  the stop's is the CHILD's own and equals `subagentId`, so that is the only id both events share).
  The spawn tool call is not the card key. The other four came off the blocked list
  in 2026-09, once a machine with a logged-in grok session produced real fixtures: context links and
  the ⌘M panel read `chat_history.jsonl` (NOT `updates.jsonl` — see below), and the meter reads
  `signals.json`. Its hook config is a **directory** (`$GROK_HOME/hooks/*.json`, all merged), so nodeterm
  **owns one file outright** (`nodeterm-status.json`) instead of merging into a shared settings file —
  which is also why a malformed copy of it is *healed* rather than preserved, locally and on an SSH
  host (`RemoteHooks.installGrokRemote`, under the host's own `$GROK_HOME`). Its dialect is
  **camelCase keys with snake_case event VALUES** (`{"hookEventName":"pre_tool_use"}`) — the SDK path
  flips the keys to snake_case, so `normalizeGrok` canonicalizes the event name and reads every field
  twice, and the shells share one decoder (`grokRawFields`). It carries **no `transcript_path`**, so a
  session directory is DERIVED from `cwd` + `sessionId` (`core/agents/grok-paths.ts`, the one
  `$GROK_HOME` rule — `core/usage/grok-usage.ts` delegates to it) and remembered in the shells' raw
  listener; the name read is `core/grok-session.ts` over `summary.json`, routed per agent by
  `core/agent-session-name.ts`. **The tool-event `matcher` is a regex: `.*`, never `*`** — a bare `*`
  is invalid and silently stops tool events firing (hence `ManagedHookEvent`). Grok also reads
  **`~/.claude/skills`** (Claude compat), which is why canvas control needed no new installer, and
  **`~/.claude/settings.json`**, so every grok event ALSO fires nodeterm's claude hook — an **inert**
  cross-fire (`normalizeClaude` finds neither grok's camelCase keys nor, in the SDK dialect, its
  lowercase event values), pinned by tests; canonicalizing claude's event-name compare would make it
  harmful. The `auto` permission-mode **version gate is claude's alone** (it is fed by a `claude
  --version` probe), and grok's mode flag must go **BEFORE** its `--` separator, which is
  end-of-options. Full picture, dialect traps and the device checklist: **`docs/grok-agent.md`**.
- **Grok NEEDS YOU is confirmed against grok's own event log** (`core/agents/grok-permission-gate.ts`,
  inside the hook server, so both shells get it from one place). MEASURED on grok 1.0.13
  (2026-09-30, interactive TUI against a local fake chat_completions model, fixture
  `shared/agents/__fixtures__/grok/permission-events.json`): the `permission_prompt` notification is
  genuine (fired 1–20 ms after grok writes `permission_requested` to `<session dir>/events.jsonl`),
  but grok is silent about the ANSWER — approve fires no hook until the approved tool FINISHES (the
  capture's 10 s command read NEEDS YOU for 10 s), a dismissed dialog (Ctrl+C) fires none at all
  (the only later hook is `idle_prompt` 60 s on, which the mirror deliberately never lets clear a
  `blocked` node — a stuck badge until the next prompt), and a rejection fires `permission_denied`
  then cancels the turn with no Stop (RUNNING for 60 s). `events.jsonl` records all three:
  `permission_resolved {decision: allow|deny|cancelled}` and `turn_ended {outcome: cancelled}`. The
  gate ties each notification to ONE `permission_requested` written within 5 s before it and
  publishes what the file says: still pending ⇒ `blocked` + a bounded 1 s watch (a `stat` per tick
  while nothing changes); answered ⇒ `working` (unverified — a file read is not a hook POST — including when the
  answer is already on disk as the hook is read); a
  cancelled turn ⇒ `done` + `interrupted`. **The trap it is shaped around**: a SUBAGENT's prompt
  fires with the PARENT's `sessionId` while its request is in the CHILD's `events.jsonl` — reading
  the parent's file alone would find the parent's older, already-approved request and publish
  "answered" over an open child dialog. Candidates are the sessions this node's hooks named
  (children post their own ids), zero or several matches publish the hook unchanged, and every new
  prompt ends the previous watch (the replay found that exact race: the parent's spawn approval
  landed 90 ms before the child's prompt). The candidate set CAN miss the real request — a child's
  prompt may reach us before any of the child's own hooks, or a second request's line may not be
  on disk yet — and the older request found instead is then already answered. **The load-bearing
  rule is therefore: a request answered BEFORE the notification fired is never taken as its
  answer** (`resolvedTs < notifiedAt` ⇒ the hook is published unchanged, nothing watched): a
  notification cannot be about a dialog that closed before it. Every capture resolves after its
  notification (fastest 216 ms). Review of #1065 found that hole; tests A/B pin it. Closed sets throughout; an unknown decision, unreadable
  file or unparsable timestamp is today's behaviour, never a guess. Per-node ordering is kept (a
  confirm read holds that node's later hooks, ≤ 500 ms; polls run off that chain and discard a read
  that straddled a newer hook). A listener that throws costs that ONE event (as it did inside the
  hook server's try/catch before), never the node's delivery chain. A remote (SSH) grok node's file is on its host, so it reads "cannot
  tell" and behaves exactly as before — a remote leg is a follow-up. Unmeasured: `events.jsonl`'s
  shape on other grok versions (a changed shape degrades to today's behaviour).
- **Grok chat view (⌘M + phone `chat.page`)** — `parseGrokChat` (`core/grok-chat.ts`) reads
  `chat_history.jsonl` into claude's `ChatMessage`/`ChatPart` shapes (no new wire field): typed
  prompts, assistant text, tool calls (`arg` = the salient argument — `command`, `target_file`, …, in
  claude's `toolArg` order — else the raw JSON, 200 units) with results summarised like claude's,
  `web_search` backend calls, harness-injected `synthetic_reason` lines as assistant-side `[reason]`
  notes, and `model_id`/`reasoning_effort` of the NEWEST assistant record (never carried forward).
  `reasoning` is hidden. It does NOT page: measured on 1.0.13, the file is rewritten via
  `.sync.tmp` + rename and `/compact`/`/rewind`/history repair replace lines, so it is one capped
  whole-file read with no keys and no `at`. Routing is by `capabilityAgentId`, so a custom agent built
  on grok reaches grok's reader, never claude's cwd fallback. **A remote (SSH) grok node is read on its
  host** (`core/remote-grok-chat.ts`, one `sh -c` round trip: `$GROK_HOME` if absolute else
  `$HOME/.grok`, the session found by id across `sessions/*/<id>/`, two matches refused, the
  paged-transcript window at 5 MiB) — its failures are terminal, never this machine's disk (the
  hook-derived local map names a wrong-machine path for these nodes). The phone gets it for free:
  `chat.page` reads through the same deps. Golden fixtures + exact rules for the Swift port:
  `src/shared/chat-fixtures/grok/`. Not supported: the composer's model/effort labels (grok's `/model`
  and `/effort` pickers are unmeasured — the TUI needed a login here), plan/question answer cards
  (claude-only), pre-compaction history, and a local session whose map entry `SessionEnd` retired.
- **Copilot ⌘M chat view** (`core/copilot-chat.ts`, 2026-09; copilot 1.0.88 measured in BYOK mode
  against a local fake model, plus the CLI's own `schemas/session-events.schema.json`). Reads
  `<COPILOT_HOME>/session-state/<id>/events.jsonl` (then the snap package's
  `~/snap/copilot-cli/common/.copilot`), located STRICTLY by the node's session id and routed by
  `capabilityAgentId` before anything claude-shaped, so a missing journal is "not found", never
  claude's cwd-newest or another session. The journal is append-only JSONL (compaction appends), so it
  PAGES like claude's — `parseChatWindow`/`parseGrowingWindow` take copilot's record parser — and the
  phone gets the same pages over the relay (`page()` gates only on `canChat`). Shown: typed prompts
  (`content`, never `transformedContent`; the sources copilot's own timeline hides stay hidden),
  assistant text, tool calls with results (`Error: …` on failure), a user's `!` shell command as the
  `!` part, `Error:`/`Warning:`/`Info:` notices, and `model`. Never shown: the system prompt,
  reasoning, sub-agent events (envelope `agentId` / `data.agentId` / `data.parentToolCallId`). Not
  supported: remote (SSH) nodes (`unreadable`, "not supported yet" — never this machine's disk),
  `effort` (not recorded), plan/question answer cards (claude-only), composer model labels (claude's
  picker commands only). Golden fixtures: `src/shared/chat-fixtures/copilot/` (README "Copilot").
- **Antigravity** (`agy` 1.2.3 measured on Windows; the 1.2.12 Linux binary read; builtin since
  2026-09 — Google's replacement for Gemini CLI on personal accounts) — in `AGENT_HOOK_TARGETS`
  (badge, NEEDS YOU from `ask_question`, a closed set of one, `--after` and triggers) and
  `RESUMABLE_AGENTS` (`agy --conversation=<id>`, the spelling agy's own exit hint uses; a dead id
  is ignored by agy, which starts fresh — without it a reboot left a bare shell). Launch is
  `agy --prompt-interactive '<p>'` via the new optional `AgentConfig.promptFlag` (agy has no
  positional prompt). Its hooks live in the GLOBAL `~/.gemini/config/hooks.json` under our own
  `nodeterm-status` bundle, and **each one is a synchronous gate whose stdout agy reads as a
  decision** — we subscribe `PreToolUse`, so a wrong byte denies tools in every `agy` on the
  machine, inside nodeterm and outside it. Three rules for whoever touches it:
  - **The stdout table is written ONCE** (`core/agents/hooks/antigravity-decision.ts`): `PreToolUse`
    → `{"decision":"ask"}`, `Stop` → `{"decision":""}`, the rest → `{}`, an unknown/empty event →
    NOTHING. Measured on 1.2.3: silence runs the tool, while `{}`, `{"decision":""}`, any non-JSON
    byte and exit ≠ 0 DENY it. Never `allow`, never `force_ask`, never `"continue"` on `Stop`. The
    script answers first and then sends stdout/stderr to `/dev/null`, because hook stdout is also
    model input (`injectSteps`).
  - **No quotes in the Windows command.** agy passes it to `cmd /c` with inner `"` escaped as `\"`,
    which cmd.exe does not understand — the codex form (`cmd.exe /d /c call "…"`) exits 1 = DENY.
    The command is relative to the hooks.json directory (agy's hook cwd) and guarded:
    `if exist ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd (call … <Event>) & exit 0`. Test
    Windows dispatch WITHOUT `windowsVerbatimArguments` — Node's default escaping is agy's.
  - **AutoRun blocks the install.** agy's `cmd /c` has no `/d`, so a registry `AutoRun` runs first
    and its output would deny tools; the installer reads the three `Command Processor\AutoRun`
    values (`reg query`, absence decided by listing the parent key — reg's errors are localized)
    and installs NOTHING — and withdraws a bundle an earlier launch wrote — if one is set or the
    registry cannot be read.
  **The vendor-location fallback also owns launch reachability.** Measured on Windows 11 with agy
  1.2.7: the vendor installer wrote `%LOCALAPPDATA%\agy\bin` into the user PATH as `REG_SZ`, so the
  process inherited the percent expression literally and both `where agy` and `cmd /c agy` failed
  while `%LOCALAPPDATA%\agy\bin\agy.exe` existed and ran. `PtyManager` therefore APPENDS the
  directory returned by `findAgy()` to the PATH of a LOCAL Antigravity session, and only when no
  entry already names it (`pathWithAgyDir`) — prepending shadowed the user's own tools on
  macOS/Linux, where agy sits in a shared directory. The gate uses
  `capabilityAgentId`, so an Antigravity-based custom agent inherits it; plain terminals and SSH
  sessions do not. Detecting the binary only for hook installation recreates the original split:
  a configured badge for an agent the pane cannot launch.
  **Installed only where `agy` exists** (a file lookup — PATH, then the vendor's install dirs —
  never a spawn), in two passes per launch: the boot pass may only see the inherited PATH, so a miss
  there does NOTHING; after the login-shell PATH probe settles, a final pass repeats the lookup and
  only then withdraws a bundle of ours when agy is not found. An `agy` installed later gets the
  hook the next time nodeterm opens. **The opt-out is agy's own switch**: `"enabled": false` on our
  bundle is carried across every rewrite. hooks.json goes through the shared settings transaction
  (`updateSettingsFile`: a symlinked file keeps its link and mode, writers serialize, a file changed
  mid-update is not overwritten), and only entries under `.nodeterm/agent-hooks/` are swept as
  ours. The POSIX command forces exit 0 (`sh <script> || :`) — the answer is printed first, and a
  later failure (a broken endpoint file) must not turn into a non-zero status next to it. **No SSH
  hook installer yet** (`LOCAL_ONLY_HOOK_AGENTS` / `hasHooksOverSsh`): on an SSH project an agy node
  never reports, so `--after` refuses it as a dependency. The event name is not in agy's payloads:
  the command exports `NODETERM_AGY_EVENT`, the script POSTs `nodeterm_hook_event`, and the hook
  server merges it after `JSON.parse` — for antigravity ONLY, an empty field deleting a planted
  value. `newTurn` rides only the
  `PreInvocation` with `invocationNum === 0` (without it `lastTurnError` is never retired). Cost:
  on POSIX the POST already runs in the background and the part agy waits for measured 2–40 ms
  (pinned by a stalled-endpoint test, since a foreground POST plus the failover walk measured ~6 s
  against the 5 s handler timeout); the ~520 ms per event measured on Windows is Git Bash's fork
  cost before the backgrounding. Full picture,
  limits (permission prompt and ESC fire no hook) and the device checklist:
  **`docs/antigravity-agent.md`**.
  **No conversation view, and that is deliberate** (not in `CHAT_CAPABLE`): ⌘M shows the rendered
  terminal output, and the phone's Chat screen answers `unsupported`. The
  LOCATION is measured: every hook payload names `transcriptPath`, which is
  `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`,
  keyed by the id `normalizeAntigravity` already records as `sessionId`. The RECORD SHAPES were never
  captured; the 1.2.12 binary only describes them in prose. Four facts a parser needs are unknown:
  the `tool_calls` element keys, how a tool result links back to its call, the serialized enum
  spelling, and whether a line is rewritten when its step's status changes, which decides between
  claude's paged read and grok's single capped read. A parser built from that prose would be a rule-14
  wrong guess, so none ships, not even unwired. The capture recipe is §7.1 and §8.1 of the doc, using
  `scripts/agy-transcript-shape.mjs`, which dumps shapes and never text. When it lands: locate
  strictly by id (`brain/` holds every conversation on the machine), and have a remote node answer
  `remoteOnly` → unreadable like gemini.
- **Codex in the ⌘M chat view** (2026-09-28; the desktop panel, the kanban card modal, the phone's
  `chat.page`). `core/codex-chat.ts` reads the rollout with codex's own rules, never claude's
  resolver. It takes USER text from the UI stream only: `event_msg/user_message` (legacy, ≤ 0.146) or
  an `item_completed` `UserMessage` (paginated, ≥ 0.151). Model-side `role:user` messages also carry
  injected context (AGENTS.md, `<environment_context>`, image wrappers), so they are never read.
  Assistant text and tools come from `response_item`, correlated by `call_id`. The UI copies
  (`agent_message`, `AgentMessage`) and reasoning are skipped. Failed and interrupted turns become
  `[error] …` / `[turn aborted…]` notes. A tool result drops codex's `… Output:` preamble. The rollout
  is append-only, so it pages by byte offset like claude. The locator matches a WHOLE-uuid thread id
  (`CODEX_THREAD_ID_RE`), because a uuid's last group passes `SESSION_ID_RE` and suffix-matches
  another thread's file. It searches only the node's own account home, and uses the codex tail's hook
  path only as a checked hint. An SSH node is read on its host (`main/remote-codex-chat-page.ts`,
  through the same resolvers as its remote meter) or not at all. Because codex announces no session
  end, a chat send first asks the kernel (`renderer/lib/chatPaneGate.ts`, `isAgentPane`). After a
  `/quit` the store still reads `done`, and the message would otherwise run in the shell. **Not
  supported:** images in prompts, reasoning summaries, the composer's model/effort labels (the
  `/model` picker is measured for claude only), plan/question answer cards (codex never sets
  `held`), and a closed REMOTE session's transcript. Record rules and fixtures:
  `src/shared/chat-fixtures/codex/`.
- **opencode in the ⌘M chat view** (2026-09-28, opencode 1.18.25 measured) — opencode has NO
  transcript file (SQLite since 1.18; that database also holds its account tokens and is never
  opened), so `readChatTranscript` routes `capabilityAgentId(agentId) === 'opencode'` to
  `core/opencode-chat.ts`, which runs `opencode export <sessionId>` (argv only, no flag an older
  yargs-strict CLI might refuse) and parses the one JSON document into claude's `ChatMessage` shape:
  user/assistant text, tool chips (arg by an opencode key order, result = 3 lines / 500 units,
  `Error: …` on a failed call), `[name] message` for an errored turn, compaction/subtask chips,
  `at` from `time.created`, `model`/`effort` from the newest assistant's `modelID`/`variant`.
  Reasoning, `synthetic`/`ignored` text, file/agent parts and step bookkeeping are dropped;
  unmappable shapes are skipped and counted. **One page, always** (`olderCursor: null`): there are
  no byte offsets to page by. The page honours the caller's `maxBytes` (the phone asks 256 KB),
  grows ×4 up to 5 MB like claude's reader when it holds no whole message, and shows a newest
  message larger than 5 MB TRUNCATED (with a note) rather than as an empty conversation. Refusals: no/unsafe session id runs
  nothing (a bare `opencode export` opens a picker over the NEWEST sessions — someone else's); an
  export whose `info.id` is another session is `unreadable`; only `Session not found: <id>` with
  exit 1 and empty stdout is a clean miss. **Remote (SSH) nodes are refused** (`unreadable`, no
  export runs) — their sessions are in the host's database and there is no remote leg yet; the
  panel's copy names both causes an opencode `unreadable` can have. One export costs 1.0–1.7 s and
  ~320 MB, so `createOpencodeExportGate` runs at most one per session (a caller arriving mid-run
  gets a FRESH export) and two in total; the panel's hook-driven refreshes are marked
  `page.background` and spaced ≥ 5 s per session, while an open / ↻ / Retry is immediate (and wakes
  a sleeping background one). A **change gate** in front of it `stat`s (never opens) opencode's
  `opencode*.db` + `-wal` in `$XDG_DATA_HOME/opencode` (else `~/.local/share/opencode`, opencode's
  own xdg-basedir rule) BEFORE exporting, and an unchanged fingerprint answers from a 4-session LRU
  of parsed exports; no db file found, or `OPENCODE_DB` set, means no caching. The export runs with
  `cwd: os.tmpdir()` (from a repo cwd opencode writes `<repo>/.git/opencode`; sessions resolve by
  global id). **It inherits the APP's `process.env`, not the node's shell env**: a user who
  relocates opencode's data via `XDG_DATA_HOME` / `OPENCODE_*` only in their shell rc gets
  "Session not found" — an honest miss, not a bug in the reader. Plan/question answer
  cards stay claude-only (no `body`/`questions` on opencode's `question` tool). Desktop and Server
  Edition both serve it (core handler); the phone gets it over the relay `chat.page` for free.
  Fixtures + the exact rules for the iOS port: `src/shared/chat-fixtures/opencode/README.md`.
- **Gemini + codex parity** (2026-08-09) — brought both up to grok's level in the lists above. Unlike
  grok, **both CLIs are installed** and gemini **ships its own hook reference**
  (`/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md`), so almost every fact is
  measured. The load-bearing ones:
  - **Gemini's envelope IS claude-shaped** — `session_id`/`transcript_path`/`cwd`/`hook_event_name`
    (`reference.md:46-58`), the exact opposite of grok's missing `transcript_path`, so the shells just
    jail the path they are handed. The **event names** are gemini's own: eleven exist, `GEMINI_HOOK_EVENTS`
    subscribes **seven**. `AfterModel` is excluded because it fires **per streamed chunk**
    (`reference.md:236`) = one hook process per chunk; `BeforeModel` is **not** per-chunk (it fires once
    per request) and is excluded only because it reports nothing we render.
  - **`Notification` → `blocked`, matched as a CLOSED set** (`notification_type === 'ToolPermission'`).
    Before this, a gemini node sat on RUNNING while it waited for a permission answer. The closed match
    is measured, not cautious: gemini's `NotificationType` enum has exactly ONE member, and it fires
    only after `shouldConfirmExecute` returns details — i.e. only for a real dialog, so an
    auto-approved/`yolo` call fires nothing. **Grok's `includes('permission')` strobed on every tool
    call**; widening this "to be safe" is the unsafe direction.
  - **Context meter from each agent's own transcript** — one tail per agent, each with its own `parse`
    dep on `createContextTail` (`core/gemini-session.ts`, `core/codex-session.ts`), in **both** shells.
    Gemini: `tokens.input` and a window from `geminiWindowFor`, which mirrors the CLI's own
    `tokenLimit()` — a **family rule with a 1M catch-all default**, so an unknown model gets the right
    answer instead of a confident wrong denominator. Codex: `last_token_usage.input_tokens` and its own
    stated `model_context_window`. Two traps: `total_token_usage` is **CUMULATIVE** (would render a
    13%-full session at 79%), and `cached` is **INSIDE** `input` for both — while claude's input
    *excludes* cache reads, which is why claude sums them. **The formulas must not be unified.**
    The transcript jail is widened **per root** (`~/.gemini/tmp`, `<codexHome>/sessions`), never to
    `$HOME` — that predicate exists so a forged hook POST cannot aim a read at `~/.ssh/id_rsa`.
  - **`hasUsage` gated THREE features, not one.** Joining `USAGE_CAPABLE` also switched on
    `context.ensure` and the find bar's transcript index, both of which go through claude's
    `resolveTranscript` — whose **cwd fallback** then handed a codex node *the newest claude transcript
    for that cwd*: a stranger's session as its meter and its search hits. Gated by the pure
    `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`) rather than by a fourth list.
    `context.ensure` LEFT that gate in 2026-09 (issue #813) once its handler stopped *being* claude's
    resolver — see **Context-meter rehydration** below; the find bar's index still has no routing and
    so has not moved. The lasting rule is the one the episode taught: **grep every consumer of a
    helper before adding an id to its list**, and when two consumers need different answers, route
    the one that can be routed instead of widening the gate for both.
  - **`TITLE_READ_CAPABLE` was created here**: gemini names its own sessions through its `update_topic`
    tool (the title is in that call's `args.title`, NOT a top-level field) but has no rename command, so
    the read and write legs split. Its read path is the transcript the context tail already tracks
    (injected as `AgentSessionNameDeps.geminiPathFor`, held in a `let` in `src/main/index.ts` to avoid a
    TDZ throw that would kill a node's whole poll chain).
  - **In-place restart** works for gemini: `EXIT_SEQUENCES.gemini = '/quit'` — and it must stay **bare**,
    because `/quit --delete` exits *and permanently deletes* the session history, i.e. exactly what the
    restart exists to resume (pinned by its own test).
  Full picture, measurements, gaps and a device checklist: **`docs/gemini-agent.md`**.
- **Gemini CLI refuses personal Google accounts since 2026-06-18** (free / AI Pro / AI Ultra moved to
  Antigravity CLI — the `antigravity` agent above; Code Assist Standard/Enterprise, Vertex AI and paid
  API keys still work, so `gemini` stays a builtin). The refusal happens before any session, so no
  hook reports it: a gemini-harness node reads its own pane for the CLI's sentence
  (`renderer/terminal/gemini-retired.ts`, letters-and-digits match because the TUI wraps it in a
  box) and raises a slim banner — "Open Antigravity" (`nodeterm:open-agent`, an agy node beside it,
  in its frame) + Google's migration guide. It types and relaunches NOTHING, which is why a phrase
  match is enough here where `resume-fallback.ts` needs three refusals. `AgentConfig.notice` carries
  the one-line caveat to the menus/Dock tooltips; it is never read to decide behaviour.
- **Gemini ⌘M chat view** (2026-09, `core/gemini-chat.ts`) — gemini is in `CHAT_CAPABLE` with its own
  reader, routed in `readChatTranscript` via `capabilityAgentId` BEFORE anything claude-shaped and
  located only by the header session id (`locateGemini`, which now reads just the header and honours
  `GEMINI_CLI_HOME`). Its session file is an UPSERT log, not a message list: one id is rewritten in
  full as tool results/tokens land, `$rewindTo` truncates, and `$set.messages` replaces the MODEL's
  context at start, compression and rollback. The thread is the message records upserted by id with
  rewinds honoured and **`$set.messages` ignored** — honouring it erases the thread at every
  compression and shows the `<state_snapshot>` as the human's words. Not paged (a record depends on
  earlier ones): one read under the 5 MB cap, `olderCursor: null`, like grok. Shows typed prompts
  (`displayContent` over `@file` expansion; `<session_context>`/`<hook_context>` dropped per part),
  replies, tool calls with results, `[info]`/`[warning]`/`[error]` notes and (paged) the model;
  thinking is dropped. NOT supported: remote (SSH) nodes (`CHAT_LOCAL_ONLY` → "not supported yet"),
  plan/question answer cards, the composer's model/effort labels. The phone gets it over the relay
  unchanged; fixtures and exact rules: `src/shared/chat-fixtures/gemini/`, `docs/gemini-agent.md` §3.
- **Claude session context capacity (#818)** — the managed hook reports only
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from the effective Claude process environment (including
  `--settings` env), never the GUI/server process environment. HookServer validates decimal safe
  integers and verified node identity before passing optional `contextWindow` metadata to BOTH
  shells. Missing metadata means an older/unverified hook; explicit null means the current hook
  observed no valid override and clears the old observation. Local and SSH tails apply the exact
  per-session limit before the family estimate, including SMALLER limits; equal model ids do not
  share configuration. The renderer labels family fallbacks as estimates. Claude observations are
  not loaded from localStorage: `context.ensure` rehydrates usage, and until another verified hook
  observes the session env an idle Claude session has only an estimated window. No arbitrary
  endpoint fields, credentials, config-file reads or CLI commands are involved. A changed transcript
  starts fresh tracked state; unchanged hook observations never replay usage. Only `context.ensure`
  explicitly replays the live snapshot for a remounted consumer. Async reads from replaced/untracked
  entries cannot publish.
  Desktop and Server share validation; the SSH tail receives the remote hook's own env. Canvas and
  kanban share ContextMeter. Mobile's separate implementation needs the same provenance distinction.
  Gateway catalogue/accepted-launch work remains in #723/#725; this does not replace those PRs.
- **SSH context polling is a bounded byte protocol** (issue #816). The initial snapshot reads
  only the last 1 MiB and records the absolute end offset; subsequent polls process at most
  1 MiB. `core/remote-ssh/transcript-window.ts` measures size and uses block-aligned POSIX `dd`
  with base64, transferring less than 1.6 MiB including alignment/framing; idle replies contain
  only the size/range header. The encoded dd exit status must survive the shell pipeline:
  pipeline success alone can hide a failed read. Short/malformed replies and SSH failures throw,
  retain the cursor, and back off from 2s to 60s with payload-free diagnostics — logged when a
  streak starts, when it settles at 60 s and when it recovers, never per retry, and naming only the
  observed status (`exit 255`, `malformed reply`), never a guessed cause: the runner reports a
  timeout as status 1. **A transcript that does not exist is not a failure.** Claude creates it on
  the first prompt while SessionStart already hands over the path (measured on 2.1.283), so every
  unused remote Claude node used to walk the failure backoff and log a line a minute. The command
  answers `NODETERM_ABSENT` with status 0 and the tail polls it on the idle cadence; a file that
  appears after being seen missing is live from byte 0 when its bootstrap window covers all of it.
  A SEPARATE idle backoff (`idleDelayMs`) stretches the 1 s poll after three consecutive empty successful reads
  (2/4/8 s, capped at 10 s) and is reset by any data-bearing read and by every same-ref `track()`
  — i.e. every hook POST for the session, which is what keeps a `<task-notification>` (it rides
  a UserPromptSubmit hook) at ~1 s latency; never merge it with the failure backoff. That same
  `track()` also skips the rest of a pending failure wait (the host just reached us) but keeps the
  failure streak, so a read that fails again goes straight back to 60 s. Bootstrap and
  detected truncation restore usage without replaying historical task notifications/tool results,
  including a historical partial line completed later. A changed remote reference replaces its
  tracking generation so stale in-flight replies cannot publish. Server Edition uses the local
  core tail on its host (no SSH-project manager); mobile has its own direct-SSH implementation,
  so this desktop fix makes no claim about that separate path. Real `/bin/sh` fixtures cover
  >20 MiB idle files and a new notification split inside UTF-8; BSD/macOS SSH remains a device check.
- **Context-meter rehydration (`context:ensure`)** — the meter is fed by hook events, and a tmux
  session outlives the app, so a continuing session that is idle after a restart emits nothing and
  its meter stays blank until the user's next prompt. The mount-time read that exists to close that
  is `core/context-ensure.ts` (`registerContextEnsureIpc`), **in core so BOTH shells serve it** — it
  used to be inline in `src/main/index.ts` and the Server Edition had no handler at all, so a browser
  node's meter filled only on its next turn too (issue #813; the identical hole
  `core/transcript-ipc.ts` was moved to core to close). Three rules:
  - **It routes per agent; it does not widen a gate.** `agentId` picks that agent's OWN locator and
    tail — claude → `resolveTranscript`, codex → `locateCodex`, gemini → `locateGemini` (the last two
    keyed STRICTLY by session id, no cwd fallback, so neither can adopt a session that is not its
    own). A closed switch: an agent that is not in it gets **no meter**, never claude's resolver.
    That is what let the renderer gate move from `readsClaudeTranscript` to `showUsage` — the danger
    was never the meter, it was one resolver answering for four agents. **grok is deliberately
    absent**: its meter reads a `signals.json` whose directory is learned from a hook event, so after
    a restart there is nothing to rehydrate FROM (`locateGrok` resolves a different file, the
    conversation). Structural, not pending.
  - **A remote node is resolved on its HOST or not at all.** The desktop injects `ensureRemote`,
    which asks the host through `remoteTranscriptRefFor` — the ⌘M path's locator, jail
    (`isSafeRemoteTranscriptPath`) and cache, reused as a second consumer rather than copied. Its
    "could not resolve" is **terminal**: falling through to any local resolver would search THIS
    machine for a file that only ever existed on the other one, and claude's cwd fallback would
    happily meter an unrelated local session under the remote node's id. Remote Codex uses its own account-scoped locator and parser over the same bounded SSH
    reader. Its reported transcript window wins; Claude estimates must never supply a Codex
    denominator. Unresolved/disconnected remote nodes cannot fall through to local readers.
  - **Nothing negative is ever cached.** A clean miss and a failed ssh call are indistinguishable to
    the locator, so both cache NOTHING and the next mount retries in full — a momentarily dead
    ControlMaster must not be remembered as "this session has no transcript", or the meter stays
    blank until the next turn anyway, which is the bug arriving by another route. The only
    de-duplication is of **concurrent in-flight** calls (a canvas mounts dozens of remote nodes at
    once and each resolve is an ssh exec on someone else's machine); it releases on settle, so it is
    not a cache. **No timer** — one read at mount, the same rule Remote usage and session memory
    follow.
  Surfaces: Desktop full; **Server Edition** full and local-only (it runs ON the host whose
  transcripts it reads — the legitimate asymmetry, stated the way the SSH skip is); kanban card +
  card modal render the same `ContextMeter` from the same store and inherit it; mobile N/A (its own
  context display, separate path). Tests: `core/context-ensure.test.ts` (routing, remote
  fall-through, no negative cache) + `main/context-ensure-wiring.test.ts` (the shell's closure, at
  source level, because it closes over `ptyManager`/`sshProjectManager`).
- **Permission mode** (agents in `PERMISSION_MODE_CAPABLE` — claude, grok, **gemini**, **codex**) —
  the mode a session **starts** in (`claude --permission-mode <mode>`; Shift+Tab still cycles it at
  runtime). Membership no longer implies claude's flag spelling: **the per-agent translation lives in
  `src/shared/agents/approval-mode.ts`** (`approvalFlags` / `modeSupported`), which is also where
  `withPermissionMode` now lives — it moved one layer up out of `config.ts` to break a cycle.
  gemini = `--approval-mode default|auto_edit|yolo|plan`, codex = `--ask-for-approval
  on-request|never` (and `untrusted` too, but only on a codex that still has it — see the next
  paragraph). Two rules the mapping exists to enforce: a mode the CLI **cannot
  express emits NO flag**, never a substituted nearest match (codex has no `plan` and no
  edit-specific mode; **gemini has no `auto`** — nothing in its vocabulary means "approve most things
  but not edits", and since `auto` is the DEFAULT mode, mapping it to `auto_edit` would have switched
  auto-approve-edits on for every existing gemini node at upgrade time, silently), and "supports"
  must not be a lie either — codex's `manual` maps to
  `untrusted` because its built-in default is `OnRequest` (measured: `codex doctor`, no `approval`
  key in `~/.codex/config.toml`), so leaving it unflagged would deliver "the model decides when to
  ask" under an "Ask each time" label. **codex is the first agent where `manual` emits a flag.** The
  UI copy is DERIVED from the mapping (`permissionModeAgentIds` / `permissionModeAgentsLabel` /
  `unsupportedModesNote` / `bypassSandboxCaveat`) so a sentence cannot drift from what the table
  does — so the note now reads "Auto has no Gemini equivalent…" beside codex's gaps, and the
  residual wart is only that `auto` and `manual` land on the same gemini policy (the *prompting* one).
  `--sandbox` is a separate axis and deliberately untouched (`--ask-for-approval never`
  still sandboxes).
  **AN AGENT'S VOCABULARY IS NOT A CONSTANT — codex's moved, and the table is gated on a probe of
  the binary in front of us (#785).** Measured release by release on the published linux-x64
  binaries: 0.146.0 / 0.147.0 / 0.148.0 advertise `untrusted, on-request, never`; **0.149.0**
  through 0.154.0 advertise `on-request, never`. clap does not ignore a value it does not know, it
  prints `error: invalid value 'untrusted'` and **exits**, so a Manual-mode Codex node launched from
  the pinned table died at the prompt and left the pane at a bare shell. The gate is codex's OWN and
  sits beside claude's, never inside it (a gate fed by `claude --version` belongs to claude):
  **`core/codex-cli.ts`** reads `codex --help` once per app run — FEATURE-detected, not
  version-compared, because a floor guesses about builds that are not on npm — parses the option's
  own slice with `codexApprovalValuesFrom` (the neighbouring `-s, --sandbox` carries its own
  `[possible values: …]` two lines up, and a page-wide scan emits `--ask-for-approval read-only`),
  and publishes `CodexCliCaps` over `codex.cliCaps()`, registered by **both** shells. Every emitter
  threads it as `ApprovalCaps` — `approvalFlags` / `modeSupported` / `withPermissionMode` /
  `unsupportedModesNote` all take an optional trailing `caps`, and the **omitted** form resolves to
  the BASELINE `['on-request','never']`, the two values every measured codex accepts. That default
  is the design: a call site that forgets to thread its probe result loses a mode, never a launch.
  On 0.149.0+ `modeSupported('codex','manual')` is **false** and the derived note says so —
  measured before concluding it: `-a unless-trusted` is refused, `-c approval_policy=untrusted`
  fails config load, and `--approve-for-me` routes approvals through *automatic* review. **Remote is
  unknown, never guessed**: an SSH node runs the HOST's codex and there is no remote codex probe yet
  (claude has one, at connect), so `codexApprovalCaps(ssh)` and the mirror's SSH slice publish
  nothing and fall to the baseline. Same for a relay tab (the guest's machine) — its stub answers
  unknown on purpose. Three surfaces: **Desktop** and **Server Edition** both probe their own
  machine (the server's `registerCodexCliIpc` is REAL, unlike its deliberately-false
  `registerCodexIdentityIpc`); **Mobile** gets the vocabulary as `MirrorSettings.codexApprovalValues`
  — the desktop/server now publish it, the iOS reader is the follow-up. The app-server **usage
  tier** (`usage/codex-usage.ts`) carried the same dead `-a untrusted` and silently returned null on
  every current CLI; it is now `-a never` with **no probe**, because `never` is in both vocabularies
  (measured against 0.148.0 / 0.151.0 / 0.154.0) and `-s read-only` is what actually guards the
  user's files.
  `settings.claudePermissionMode` (global, default **`auto`** — a behavior change for existing
  users, who previously got a prompt per action) is overridden per project by
  `project.defaultPermissionMode` (persisted to `.nodeterm/project.json`, so a `bypassPermissions`
  override travels to everyone who clones the repo — the tab menu warns). Modes are
  `manual | auto | acceptEdits | plan | bypassPermissions`, labelled once in
  `PERMISSION_MODE_LABELS` (from which `ALL_PERMISSION_MODES` is derived — the dropdown and the
  validator can't desync). `resolvePermissionMode(project, settings)` is the resolver
  (`renderer/state/permissionMode.ts` `activePermissionMode(agentId)` binds it to the live stores **and
  applies the version gate below — for `agentId === 'claude'` only**), and
  **`withPermissionMode(cmd, agentId, mode)` is the single
  funnel through which every agent-node launch site appends the flag** (new node, cold-restore
  resume, Branch, handoff/transfer, explain-commit, add-agent, canvas-control open-agent + team
  spawn). **WHERE the flag lands is decided at the composed layer** (`createAgentNode`), not in
  `withPermissionMode`: with no `argvPromptSeparator` (claude) it goes LAST, keeping the historical
  command byte-identical; with one (grok's `--`) it must go **BEFORE** the separator, because `--` is
  end-of-options and a flag after it is a positional — silently swallowed into the prompt or a clap
  usage error. Assert that at `createAgentNode`; a `withPermissionMode` test passes while the composed
  line is wrong. (gemini and codex declare no separator, so their flag goes last and their command
  lines stay byte-identical; grok is still the only agent taking the other branch.)
  UI: Settings → Agents, and the tab ⌄ menu for the per-project override.
  **Version gate (`auto` only) — CLAUDE's alone:** `--permission-mode auto` exists only in **Claude Code ≥ 2.1.71**;
  older CLIs validate the value against their own choices list and **exit 1** — and `auto` is the
  default, so an ungated flag would kill every Claude launch on an older CLI. So the CLI is probed
  (`core/claude-cli.ts` → `claude --version`, memoized, registered on `CorePlatform` so **both**
  shells serve it; reached from the renderer via `window.nodeTerminal.claude.cliCaps()`, with a
  **real** ws-bridge implementation) and `gatePermissionMode(mode, autoSupported)` degrades **only
  `auto`**, and only to `manual` = **no flag** = the bare pre-feature command. Everything **fails
  open**: unknown/unreadable version, a probe that failed or hasn't answered yet ⇒ bare command,
  never a blocked launch; the other four modes are never touched by the gate, and the user's
  *setting* stays `auto` (only the emitted command line changes). **SSH projects** are gated on the
  **remote** host's CLI, never the local one: `SshProjectManager.connect` probes `claude --version`
  on the host (through a login shell — an ssh exec channel's rc file usually bails out early — with
  `$HOME/.local/bin` + `$HOME/.claude/local` prepended to PATH: the official installer targets
  `~/.local/bin`, which a stock root `.profile` never adds, so a host whose interactive shells run
  claude fine still probed "not found" and silently degraded `auto` to manual) and
  caches the answer on the connection → `useSshConn`; not connected / not yet probed ⇒ no `auto`
  flag. A FAILED remote probe (claude not found — often a transient login-shell hiccup) **retries
  on a bounded backoff** (`PROBE_RETRY_DELAYS_MS`; every attempt pushes its answer immediately so
  launch waiters never block on the retry tail; a definite version — old or new — never retries),
  and the status event carries `remoteClaudeVersion` (`null` = probe failed) beside the boolean.
  The cold-restore relaunch `await`s the (shell-warmed) local probe because it fires on mount —
  and on an SSH project whose resolved mode is `auto` it also waits (`SSH_AUTO_PROBE_WAIT_MS`,
  bounded, fail-open) for the REMOTE probe's first answer, which races the same mount. Because
  the degrade is silent by design, the tab menu's Auto rows surface it: `sshAutoModeHint`
  (tri-state `useSshConn.autoPermAnswer` + probed version) puts a ⚠︎ + tooltip on "Auto" / "Use
  global (Auto)" for an SSH project whose remote CLI is too old / missing / not yet probed.
  **Security:** mode values come from hand-editable, git-shared JSON and end up interpolated into
  a shell command line (tmux `send-keys`), so `permissionModeFlag` **re-validates** the mode at the
  interpolation site (the type is compile-time only) — an unrecognized mode yields **no flag**, i.e.
  the bare, safe command. `'manual'` likewise yields no flag, reproducing the pre-feature command
  bit-for-bit. The setting and the per-project override apply to **terminal (CLI) agent nodes only**
  (the SDK **chat node**, which never honored it, was removed 2026-07). **No other agent inherits this
  gate:** grok has accepted every mode since 1.0.0 and gemini/codex accept theirs on the versions we
  measured, so gating any of them on a `claude --version` probe would
  downgrade their sessions on a machine whose claude is old or absent — `activePermissionMode` gates
  only `'claude'`, `ensureActivePermissionMode` awaits the probes only for `'claude'`, and
  `sshAutoModeHint`'s copy names Claude in every sentence for the same reason. An agent needing its
  own gate adds one beside claude's.
- **State via each agent's hooks → shared 4-state model** — detection uses the agent's own
  hooks, **not** output parsing. `src/shared/agents/normalize.ts` has per-agent normalizers
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`/`normalizeAntigravity`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status`, drives the `agentStatus` store, fires throttled
  (5s/node) background notifications, and records the session id. Header shows a pulsing
  **RUNNING** (working) / **NEEDS YOU** (waiting/blocked) badge.
- **DROPPED — the CLI died and nobody told us** (`renderer/terminal/agent-liveness.ts`, issue #616).
  Every ORDERLY exit announces itself: Eco's `/exit` sets `hibernated`, "Pause session" sets
  `paused`, and a user typing `/exit` fires the CLI's own SessionEnd, which `setState(id, undefined)`
  records. A KILL announces nothing — the process is gone before it can run a hook, and tmux's shell
  still owns the pane so the PTY never closes. The node therefore kept rendering its last badge over
  a dead conversation, with the CLI's parting `Resume this session with: claude --resume <uuid>` and
  a stray `^[%` in the pane as the only evidence. Not exotic: measured on the reporting host
  (2026-09-04) 62 GB RAM with swap fully consumed, kernel `oom_kill` at 187, 147 live `claude`
  processes holding 44 GB. The signal is `#{pane_current_command}` reading as a shell while the
  status table still believes an agent is parked there, and the four refusals are the feature:
  a `null` pane read is NEVER evidence (a downed ControlMaster must not make a canvas of healthy
  remote nodes claim they died); `hibernated`/`paused` are our own exits and already have chips;
  **only `done`**, never `working` — a turn in flight is exactly when a tool subprocess can own the
  pane's foreground, so the alarm would fire on a healthy agent running a shell command; and the
  agent must be in **`SESSION_END_CAPABLE`**. That last list is the false-positive gate and is
  DERIVED from `normalize.ts`, not chosen: exactly four normalizers map `sessionPhase: 'end'`
  (claude, gemini, copilot, grok) and **codex and opencode map none**, so on those two a deliberate
  `/quit` and an OOM kill leave byte-identical evidence and the chip would be a coin flip shown as a
  fact. Adding an id without first adding its normalizer branch puts a chip on every session its
  owner quit on purpose — `agent-liveness.test.ts` asserts the list against that source. The verdict
  (`agentStatus.dropped`) is TRANSIENT, a stronger call than the other clocks: it is a claim about a
  pane, panes are re-measurable in milliseconds, and a persisted one would strand a stale chip on a
  node someone resumed by hand. ANY hook event withdraws it — the one self-heal that deliberately
  does not gate on `alive`, since `done` disproves "there is no CLI in this pane" even though it must
  not clear `hibernated`. Cost is bounded by asking only for a node that is BOTH watched and already
  believed to be a parked agent. Resume reuses the hibernation wake closure unchanged, which
  re-reads the pane and refuses anything that is not a shell. Chip on the node header, the kanban
  card and the card modal; Desktop and Server Edition identical; relay tabs answer `null` and are
  never judged. **A second thing this catches, unplanned:** in the same sweep 9 of 149 panes sat at a
  bare shell because a cold-restore `--resume` had answered *"No conversation found with session
  ID"* — the persisted `sessionId` outlived its transcript. The chip surfaces those too, but the
  Resume it offers still replays that dead id — but cold restore no longer creates the state: it
  probes `transcript:exists` first and launches bare on a positive `absent`, saying so on the node
  (see **Cold restore** above). Re-measured on the same host 2026-09-09: **20** of 108.
- **An interrupted Claude turn (Esc / Ctrl+C) fires NO hook — the transcript marker ends it**
  (`core/claude-turn-interrupt.test.ts`, fixture `shared/agents/__fixtures__/claude/interrupt-capture.json`).
  MEASURED on Claude Code **2.1.285**, interactive TUI in a private tmux server, capture hooks via
  `--settings`, every `NODETERM_*` unset: Esc while it streams, Esc during a foreground tool call,
  Esc on a permission dialog, and Ctrl+C once mid-stream each fire **nothing** — no `Stop`, no
  `StopFailure`, no `PostToolUse(Failure)`, and **no `idle_prompt` either**: that notification came
  60 s after a NORMAL `Stop` but not in 75 s / 80 s after an interrupt, so the `idle` rescue in
  `normalizeClaude` does not cover this case. Before this a node sat on RUNNING (or NEEDS YOU, for a
  dismissed permission dialog) until the 20-min stale sweep: `--after` dependents waited, Eco never
  saw it idle, the notch and the phone showed it working. What the interrupt DOES leave is a USER
  record, content `[{type:'text', text:'[Request interrupted by user]'}]` (`… for tool use]` when a
  tool call or its dialog was cancelled), whose **`promptId` equals the turn's `UserPromptSubmit`
  `prompt_id`** in every capture. Wiring, and the rules it rests on:
  - `normalizeClaude` puts `prompt_id` on the `UserPromptSubmit` event as **`turnId`**; the mirror
    keeps it (`MirrorEntry.turnId`, runtime-only, dropped at a session boundary).
  - The claude context tails (local, and the desktop's SSH one) scan COMPLETE lines with ONE
    stateful scanner per tracked transcript (`createTurnInterruptScanner`): a CLOSED set of the two
    texts, array content with exactly that one text part, non-sidechain (a typed prompt is a plain
    string, so typing the words matches nothing) — **and a marker counts for turn P only if P's
    OPENING prompt record was read BEFORE it** (bounded set of seen prompt ids, 256). The id alone
    is NOT enough, and this is not theoretical: in real transcripts on the dev host (2.1.209–2.1.283)
    34 of 114 accepted-shape markers carried the promptId of the prompt written AFTER them — "queue a
    message while Claude works, then Esc": the CLI tags the marker with the QUEUED prompt's id and
    writes that prompt ~36 ms later, and its `UserPromptSubmit` has already made it the node's
    current turn, so an id-only match ended the NEW live turn (fixture
    `__fixtures__/claude/interrupt-queued.json`). Measured on this host after the fix: all 26
    queued-shape markers rejected, no real interrupt lost. The one interrupt this drops is the one
    it cannot place; the interrupted turn really ended and the node is already in the next one. The
    remote tail's historical first read records prompts but never reports.
  - **Both shells** check the marker with `turnInterruptEvent` (a mirror PEEK) and push the result
    through their ONE hook-event path — desktop `emitAgentStatus` (mirror, broadcast, Notch HUD,
    agent messaging, station notices), Server Edition `emit` (mirror, broadcast, `opts.onEvent`:
    its delivery queue and `--after` scheduler). Pinned in `hook-verified-parity.test.ts`. It ends
    the turn ONLY when the marker names the node's CURRENT turn (same session, same `turnId`, state
    working/blocked/waiting): a marker read back from history, one from a finished turn or another
    session, one after a restart (no `turnId` then) changes nothing. A prompt event whose
    `prompt_id` is missing or not a plain token carries `turnId: ''`, which makes the mirror FORGET
    the previous id. The event is an ordinary `done` + `interrupted` (what a `Stop` with
    `is_interrupt` already produced), UNverified (a transcript read is not a hook POST), so no
    completion alert and the question/approval resets apply unchanged.
  - **`--after` does NOT release on an interrupted turn** (decision, 2026-09-30): the person
    stopped it, usually to redirect it, and the dependent would start on unfinished work — #521's
    reasoning for an errored turn. It is its OWN annotation, `agentStatus.lastTurnInterrupted`
    (transient; set by an interrupted `done`, cleared by a new turn or a `done` that is not
    interrupted), read by `depSatisfied`, the QUEUED tooltip (`interruptedDeps`), `list`
    (`LAST TURN INTERRUPTED`; an error outranks it), the canvas's `armedDepSig` (a verdict can clear
    under a steady `done` — a guessed interrupt then the real Stop — and the launch effect must
    re-run) and team progress (its own `interrupted` kind, NOT counted as done, so the ring never
    says "finished" beside a held dependent). It is deliberately NOT `lastTurnError`: the TURN
    FAILED chip, the station-failure notice and issue runs do not treat an interrupt as a failure.
    **The `idle_prompt` rescue does NOT set it** (`recordsTurnInterrupt`): it is flagged
    `interrupted` only to stay silent, and since `idle_prompt` follows a NORMAL Stop, a rescue means
    a lost Stop POST on a turn that finished — its dependents release as before. ▶ / `run` still
    start the dependent. The renderer's older keystroke
    guess (`inferInterruptAfterSettle`, 1.5 s after a lone Esc/Ctrl-C typed into THAT terminal)
    now records an interrupted `done` too, so a guess cannot release dependents before the marker
    lands; it stays because it is the only signal for the next case.
  - **Residual, measured:** Esc or Ctrl+C BEFORE the first token rewinds the prompt into the input
    box and writes NO marker (the transcript ends at the prompt record). Only the renderer guess
    (keystroke in that canvas terminal) sees it; the mirror — notch, phone, Eco's mirror reads, the
    Server Edition's headless `--after` — keeps `working` until the next hook or the stale sweep.
  - **Esc "during a subagent":** on 2.1.285 the Agent tool launched ASYNC even when asked for a
    foreground run, so the parent turn had already ended (`Stop`) — Esc at the prompt then fires
    nothing and does NOT stop the child, whose `SubagentStop` and `<task-notification>` arrive as
    usual. Nothing to fix there; a truly synchronous child being interrupted was not reproducible.
  - Server Edition: same core path (its tail + handler); its own headless `--after` still ignores
    both #521 and this annotation (pre-existing gap). Mobile: gets the `done` through the mirror.
  - **Device checklist:** (a) macOS desktop: Esc mid-stream / mid-tool / on a dialog → RUNNING
    clears within ~1 s, no chime, an armed `--after` dependent stays QUEUED with the interrupted
    tooltip; (b) SSH node: the same over the remote tail; (c) Server Edition browser tab; (d) a
    Claude older than 2.1.285 — whether the marker text and `promptId` match there is unmeasured
    (a changed text or a missing `promptId` matches nothing and degrades to the old behaviour); (e)
    queue a message while a turn runs, then Esc: the node must STAY working on the queued prompt;
    (f) the phone's Live
    Activity ends on the interrupt.
- **Hook server (loopback HTTP)** — `src/core/agents/hook-server.ts` is a main-process
  loopback HTTP server (per-session bearer token, fail-open) that the installed hook scripts
  POST to; it replaced the old `fs.watch` signal-log mechanism. `buildPtyEnv` injects the
  node id + endpoint/token into each spawned session's env; because tmux sessions **outlive
  the app**, the server also writes `<userData>/hook-endpoint.env` so a relaunched main
  process re-advertises the same endpoint (restart handoff). A `setRawListener` channel feeds
  the per-node context-window meter (`context-tail.ts` — **one tail per agent**, each with its own
  `parse` dep: claude's usage records, `codexContextParse`, `geminiContextParse`) and the subagent
  live-transcript (`subagent-tail.ts` — claude via meta-dir `track`, codex via `trackFile` with the
  stateful `codex-subagent-format.ts` formatter). The same events feed the **agent-status mirror**
  (`core/agent-status-mirror.ts`) the mobile companion reads; the mirror carries an optional
  `settings` block (`claudePermissionMode`/`autoSupported`/`claudeAccounts`) so the phone can
  launch agents with the desktop's permission mode + managed accounts, and SSH slices get their
  **per-host** settings (remote CLI caps + host-matched accounts) injected via
  `remote-status-push`'s `settingsFor` dep. `settings.customAgents` (`[{id, label, baseAgent?,
  binaries}]`) lets the phone chat with a custom agent: built ONLY by `core/mirror-custom-agents.ts`
  (one definition for all three providers — local file, which relay `projects.list` also serves,
  SSH slices, Server Edition), `binaries` = `binariesFor` from the pane-owner predicate, published
  only when every name fits the plain alphabet `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (else `[]`) —
  the builder enforces it because the tokenizer can "name" a slice of a secret (`oauth2:ghp_…` out
  of a git URL, a quoted env value, a `${env:…}` template). **Never put a custom agent's raw
  `launchCmd`/`args`/`env` in the mirror** — they carry API keys and the file lands on every SSH
  host. `binariesFor` resolves a BLANK launch command with a *builtin* `baseAgent` to the base's
  binaries (what `resolveAgentConfig` actually launches).
- **Agent-integration consent (#744)** — `core/agent-integrations.ts` (booted by BOTH shells) is the
  ONE writer of user-owned agent config; consent is `settings.agentIntegrations`
  (`@shared/agent-integrations`, sanitized on every read). Per agent: **enabled** = hook + both skills
  in the agent's own skills dir + strip older builds' AGENTS.md/GEMINI.md blocks (they were 17 KB of
  codex's 32 KiB `project_doc_max_bytes`); **declined** = remove exactly what we wrote (hooks by exact
  command, skills by exact-content receipt in `<userData>/integration-receipts.json` — a user-edited
  file is KEPT and listed in Settings, bounded at 20 — legacy blocks, our hook scripts);
  **undecided** = nothing either way. Server `installHooks: false` is a hard veto. Rules a refactor
  must not undo:
  - **Grandfathering is decided at boot from OUR files only** (non-empty `~/.nodeterm/agent-hooks/`
    or the userData shims), before `settingsStore.registerIpc()` and before any install: an existing
    install gets every agent + `hostDefault` enabled and a one-time notice; a new install gets NO
    record and a banner (Enable all / Choose… / Not now — "Not now" declines all, so it asks once).
  - **No caller reaches an installer by omission.** `installManagedAgentHooks(agents)` takes a
    REQUIRED set; `RemoteHooks` takes a REQUIRED plan (`NO_REMOTE_INTEGRATION` = fail-closed);
    account add/link asks `currentIntegrationLifecycle()` and writes nothing when none is registered.
    `agent-integrations-wiring.test.ts` pins every call site of the global installers.
  - **SSH consent is per HOST (`sshHostKey`, never identity file / port / args).** A host installs an
    agent only when the host AND the agent are enabled; an unanswered host is not touched at all
    (no clean-up, no ssh); removals run on connect and when the plan changes
    (`SshProjectManager.onIntegrationConsentChanged`). A removal never creates a missing config
    file (`stripRemoteSettingsFile`).
  - **`$CLAUDE_CONFIG_DIR` decides the system Claude dir** (`claudeSystemConfigDir`), never a
    hardcoded `~/.claude`; a decline also cleans the legacy `~/.claude` when they differ.
  - The fullscreen-TUI write is part of the claude integration and follows its consent.
  Measurements, the device checklist and the open product question: `docs/agent-integration-consent.md`.
- **Hook installers** — `src/core/agents/hooks/` holds per-agent hook services + an installer
  registry `MANAGED_HOOK_INSTALLERS`. `managed-script.ts` builds the POSIX hook script that
  POSTs to the server (env-gated: a no-op in the user's normal terminals, active only in
  sessions nodeterm spawns; the `claude-signals` string is kept as the idempotency marker that
  migrates users off the old hook). claude → `~/.claude/settings.json` and gemini →
  `~/.gemini/settings.json` (shared `install-helper.ts`, merged/idempotent, preserving other
  tools' hooks); codex → `~/.codex/hooks.json` + `~/.codex/config.toml` trust entries
  (`codex-trust.ts` — the hash gates whether codex runs the hook); **grok → our OWN file
  `$GROK_HOME/hooks/nodeterm-status.json`** (its hook config is a directory whose files are all
  merged, so there is nothing of the user's inside ours — which is also why a malformed copy is
  *healed*, not preserved, on both the local and the SSH path). The per-event **`matcher`** the grok
  installer needs is why events are typed `ManagedHookEvent` (`string | {event, matcher}`): grok's
  tool matcher is a REGEX and must be `.*` — a bare `*` is invalid and silently stops tool events
  firing. Plain-string events keep their byte-identical output for every other agent.
  **Codex is the one agent whose hook command is NOT a POSIX one-liner on Windows** (issue #567):
  it builds the command as `cmd.exe /C <string>` (`codex-rs/hooks/src/engine/command_runner.rs`,
  rust-v0.151.0) unless the session has a shell configured, which a default Windows install has
  not — so `if [ -x '…' ]; then …; fi` answered `-x was unexpected at this time.` and **exit 1 on
  every event**, for the life of the node. Claude is fine there only because Claude Code runs its
  hooks through Git Bash. The fix is a batch entry point (`codex-hook.cmd`,
  `codex-windows-wrapper.ts`) written beside `codex.sh` and named by `buildManagedCommand`'s win32
  branch; it **locates a POSIX shell and runs the same script** — deliberately not a second
  implementation of the hook protocol, which would be two copies of the POST/failover/token/
  permission-poll to drift. Three rules it must keep: pass stdin through, DRAIN stdin on every bail
  (codex writes the payload there; #186/#187), and exit 0 when there is no shell or no script.
  Two traps around it: `buildManagedCommand`'s `platform` is the platform of the machine that will
  RUN codex, so `RemoteHooks.installCodexRemote` passes POSIX explicitly (a Windows desktop must not
  put a `.cmd` command on a Linux host); and `isManagedCommand` matches **both** leaves
  (`codex.sh` AND `codex-hook.cmd`) on every platform — matching only the local one would leave a
  pre-fix entry unrecognized, so the fresh one is appended beside it, which is #558 on a second
  file. Matching both is what REPAIRS an existing Windows install at the next launch. **Both
  sides of the managed-entry match go through `normalizeHookCommand`** — the marker used to be
  folded to `/` while the stored command was compared raw, so on Windows nodeterm never recognized
  its OWN entry and appended a fresh set every launch (#558: nine copies of nine events, nine
  `claude.sh` processes per Stop, nine 45 s `PermissionRequest` waits racing one prompt). Because
  `mergeManagedHook` drops every managed entry before pushing one fresh, the corrected match IS the
  repair for a file already ruined — it runs at boot via `installManagedAgentHooks` and, being the
  ONE shared merge, heals claude/gemini/grok, every managed Claude account dir and all three SSH
  remote installers at once; a second repair mechanism would be exactly the duplicated rule this
  file warns about. It strips only OUR handler out of a definition, so a hook a user hand-merged
  beside ours survives.
- **A reused ControlMaster is not evidence of a live hook tunnel** (issue #735 — remote sessions
  stuck on **Unknown**, no completion notifications, no unread dots). `connect()`'s reuse branch
  returned the cached `hookEndpointPath` whenever `ssh -O check` answered, on the written-down
  assumption that *"a master that answered `-O check` never lost its tunnel"*. That is false, and
  the mechanism is **our own self-heal**: `childArgs` uses `ControlMaster=auto` + `ControlPersist`
  precisely so a dead master is rebuilt by the next child command (a status poll, a mirror push, a
  remote git call) on the same ControlPath. The rebuilt master answers `-O check` — and carries no
  `-R`, because `RemoteHooks.setup()` is the only caller of `hookForwardArgs` and it runs only on
  the branch where a master has just come up. The 45 s watchdog then parks on the reuse branch
  forever. Nothing reports it: the project says `connected`, terminals work, the mirror pushes, and
  only the hook POSTs die — into a socket file that still EXISTS with nobody listening.
  **MEASURED on the host that prompted the fix**: 10 per-project hook sockets on disk, exactly ONE
  with a listener (`ss -lxp`); the dead project's socket answered `curl` exit 7 while that same
  project's status mirror was being written the same second; **107 of 128** live `nodeterm-rmt`
  tmux sessions were pinned to that dead endpoint. Sessions are pinned for life
  (`new-session -A -e …` — tmux ignores `-e` on an existing session), so every one of them stayed
  dark until the app restarted. The reuse branch now probes the tunnel (`RemoteHooks.tunnelAlive`,
  one `curl` over the already-multiplexed master) and re-runs the idempotent `setup()` when it does
  not answer, firing `onTunnelVerified` so the working agents resync. **The retry is backed off**
  (`tunnel-repair.ts`, pure + tested): the FIRST failure repairs immediately — that is the common
  case — while a host that can never forward (`AllowStreamLocalForwarding no`, no `curl`, a `$HOME`
  the validator refuses) settles at one attempt per 15 minutes instead of rewriting every agent's
  hook config every 45 s. A missing spec answers "not alive" rather than "unknown": nothing of ours
  is bound, which is a tunnel that cannot deliver.
- **An SSH host's agent tools are CHECKED, not assumed** (since #744 the plan holds only what the
  host's consent installs — shims + skills, no instruction blocks; an unanswered host is skipped)
  (`RemoteHooks.refreshAgentTools`,
  `main/remote-ssh/agent-tools-freshness.ts`). The canvas/context shims, both SKILL.md files and our
  blocks in the codex/gemini/copilot/opencode instruction files used to be written only by the
  establish path, blind, and never looked at again, so a host could keep another build's text for
  a whole run: a fire-and-forget install that failed open was never retried; a tunnel that failed
  verification at connect and was repaired later on the reuse branch (#735, above) never got them
  at all; and a managed account's skill was written ONCE, when the account was added, so after
  every update each remote account session read the verb docs of the build that created the
  account. (The obvious suspect is not one: an app update never lands on the reuse branch. `conns`
  is in memory, so the first connect after a relaunch adopts the ControlPersist orphan on the
  ESTABLISH path, which always wrote. `ssh-project.test.ts` pins that it checks there too.)
  - **The stamp is the bytes.** One generated probe (one round trip, a few hundred bytes back)
    runs POSIX `cksum` over every file the host holds and, for an instruction file, over exactly
    the span `merge*Block` would replace (awk under `LC_ALL=C`: the first start marker through the
    first end marker, only when the end follows the start). That is compared with `posixCksum` of
    the exact bytes this build would write (`core/remote-ssh/posix-cksum.ts`, pinned against the
    real binary), and only what differs is rewritten, through the same appliers as the install. A
    current host costs the probe and no write. Nothing is embedded in the artifacts: a stamp line
    would be noise in every agent's context, would need a migration for hosts written by older
    builds, and would trust a file's claim about itself. `cksum` because it is the one checksum POSIX
    requires; CRC-32 + length is not collision resistant and does not need to be, because this
    detects drift and is not a security check. Ubuntu's own BusyBox build omits `cksum`, so such a
    host exists: missing, unreadable and gated files are still told apart there, the files it can
    read are written without comparison (what every connect did before) and the blocks merged. An
    awk that fails on a block is reported (`X`, through fd 3 — `awk | cksum` exits with cksum's
    status) and that block is merged, which writes only on a change. Only files ACTUALLY written
    are logged as "rewrote" or make the outcome `refreshed`. The permanent suite runs the probe
    under every shell × awk the machine has (what the CI image has); a one-off manual run added
    BusyBox sh, zsh 5.9 and the one-true awk 20231127 (`NT_PROBE_EXTRA_AWK` / `_SH`). macOS's own
    awk (20200816) and BSD `cksum` have never been run — that is on the PR's Mac checklist.
  - **The end marker is searched AFTER the start marker** — in both `merge*Block` functions and in
    the probe's awk alike. Taking the first end marker anywhere read a hand-deleted block's leftover
    end line as "no block": the merge appended a fresh copy every time, and with an hourly check a
    host's AGENTS.md grew by one block an hour (measured in review: 41,693 → 81,279 → 120,865 →
    160,451 bytes). The same merges run at boot for the desktop's and the Server Edition's own local
    instruction files (`initCanvasControl`, `initContextLink`), which grew by one block per launch.
  - **Refusals.** A file that is not a readable regular file (a directory, a dangling dotfile link,
    no permission) is NEVER written over, and the host is not called confirmed. A managed account's
    skill is refreshed only when its dir ALREADY exists — checked by the probe and again on the host
    in the write itself (`remoteAtomicWrite`'s `requireDir`), so a dir removed in between is not
    brought back by the parent `mkdir -p`. A report that does not
    parse changes nothing. Account ids from settings are re-validated (`isSafeAccountId`) before
    they become paths. The copilot block is judged at the host's `$COPILOT_HOME` only when the
    installer's validator would accept that value.
  - **Cadence.** A connect (establish, including the post-relaunch orphan adoption) and a tunnel
    repair always check. The 45 s reuse branch costs nothing once this run has confirmed the host
    for the current expected set (content + account list). An unconfirmed host is retried there on
    the tunnel-repair backoff (1/5/15 min). A confirmed host is looked at again hourly
    (`AGENT_TOOLS_RECHECK_MS`), because within a run only a writer outside it (another desktop,
    possibly an older build, on the same host account; a hand edit) can change the files. One check
    per host at a time: projects sharing a host share it.
  - **A new agent-facing doc on a host goes into the artifact plan in `remote-hooks.ts`**
    (`canvasControlArtifacts` / `contextLinkArtifacts` / `accountSkillArtifacts`) — shims, skills,
    instruction blocks. The installers and the probe both read it, so a file added there is written
    AND kept current. NOT the rest of what connect writes: the hook scripts and the agents' hook
    config belong to `setup()`'s ordered chain (after the verified tunnel and the endpoint file),
    and the endpoint file and node tokens carry credentials — none of those may be rewritten on a
    freshness cadence.
  - **What a running agent sees.** The shim's `help` is answered by the shim itself (baked from the
    verb registry), so it is current the moment the file is. Claude reads a SKILL.md body when the
    skill is invoked; codex, gemini and opencode read their instruction files at session start, so
    a session started before a rewrite keeps the old text until it restarts. Nothing is typed into
    a pane to announce it.
  - Surfaces: Desktop only (SSH projects are a desktop concept). The Server Edition runs ON its host
    and rewrites its local shims at every boot. Mobile: N/A.
- **The per-agent hook installs run CONCURRENTLY, and the order that still matters is the one above
  them.** `RemoteHooks.setup()` is the chain `connectOnce` awaits before a project reports
  `connected`, so every terminal of a switched-to project waits through it. Its shape was: resolve
  `$HOME`, open + VERIFY the reverse tunnel, write the endpoint file — and then install five agents'
  hooks strictly one after another, ~16 more remote round trips in a row. MEASURED against a real
  sshd through a 25 ms one-way delay proxy (50 ms RTT), 5 runs each: **3281 ms serial → 1471 ms
  concurrent** over the same 22–24 ssh children. The installers are independent by construction —
  each writes its own script under `<remoteDir>/agent-hooks/` and merges its own agent's config; no
  two touch the same remote path, and the only shared statement is an idempotent `mkdir -p` — and
  the `SshChildGate` (cap 6 per ControlMaster) is what makes the fan-out safe against a stock host's
  `MaxSessions`, which is the whole reason it exists.
  - **The tunnel and the endpoint file stay strictly BEFORE the fan-out**: that file is what every
    hook this installs POSTs through, and it is written only once the tunnel has verified end to
    end. `remote-hooks.test.ts` pins that ordering AND the overlap (a gated fake runner, so
    concurrency is observed rather than inferred from wall-clock; the overlap test fails on the
    serial version, checked by mutation).
  - **`allSettled`, not `all`.** By the fan-out the tunnel is verified and the endpoint written, so
    one installer failing must cost that agent its hooks and nothing else — not discard a working
    setup for every other agent, which is what a rejection propagating to `setup`'s outer catch
    would do (`return null` ⇒ no hooks at all, and post-#735 a repair retried on backoff forever).
    Every installer catches its own errors today; this is the guard for the next one that forgets.
  - The claude/gemini loop body became `installJsonAgentRemote`, with the same fail-open try/catch
    its three siblings already had. Its three steps stay strictly ordered inside: the merge reads
    the file the write then replaces.

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

- **Hook-reply answers: plans and questions** (`core/agents/permission-decision.ts`, full write-up in
  **`docs/hook-reply-approvals.md`**) — the managed hook holds a Claude `PermissionRequest` and polls an
  answer file. For `ExitPlanMode` / `AskUserQuestion` (`requiresUserInteraction`) Claude **DROPS a bare
  allow**, so the answer must carry `updatedInput`: plan = `{}` (+ optional session `setMode
  acceptEdits|default`, never `auto`), question = the request's own `questions` + `answers`. Rules a
  refactor must not undo: (1) **only core builds decision JSON**, from the pending request file on the
  agent's host (never renderer-echoed questions), validating every field; (2) the script prints only the
  fixed words' decisions or a file that passes the strict prefix/size/one-line bound
  (`isBoundedAnswerContent` is the TS twin — both writers refuse anything the script would ignore);
  (3) answer content never rides an argv (the answered POST carries the decoded verb; SSH writes go on
  stdin); (4) a plain `allow` maps to `updatedInput:{}` for a plan and is swallowed (hook keeps
  holding) for a question — core refuses to write it and the header hides ✓ Approve for that ticket;
  (5) these two tools hold 540 s (`PERM_WAIT_SECS_INTERACTIVE`) under the explicit `timeout: 600` we
  write on the PermissionRequest handler — except a subagent's request (payload carries `agent_id`),
  whose dialog awaits the hook; (6) structured answers are gated on the SCRIPT REVISION: an old script on
  an SSH host (rewritten only at connect) silently ignores JSON while the write succeeds, so the hook
  server keeps `held` only for `clientRevision >= MIN_STRUCTURED_ANSWER_REVISION` and core refuses a
  structured answer (or a plain plan allow) for a ticket it did not record as capable — never a false
  "answered". The renderer gets `held: {pendingId, toolName, questions?}` on the event/store (kept while blocked
  OR waiting), separate from the approve/deny `pendingId` the mirror strips from a question;
  `questions` (a held AskUserQuestion's exact question texts, from the one `readQuestions`) is what
  the ⌘M answer controls match their card by — absent = unreadable input = no controls. Desktop local + SSH, Server Edition local;
  relay unchanged; phone keeps `allow`/`deny` (its plan approve now works via the script mapping).
- **Per-node hook identity** (`src/core/agents/node-auth-*.ts`, `node-token-*.ts`,
  `node-identity-policy.ts` — full write-up in **`docs/node-identity.md`**) — the shared bearer proves
  "a session on this machine", never *which* session, so every node also gets a capability derived
  from one restart-stable secret (`kid.mac`, domain-separated HMAC over the node id), handed to the
  client as a 0600 file and verified three ways: `verified` / `legacy` / `forged`. `legacy` is "we
  cannot judge this", not a failure. Two invariants come out of this series and both cost real
  incidents to learn:
  - **A credential never rides argv — local or SSH.** Measured 2026-08-13: `buildPtyEnv` put the hook
    bearer in the tmux `-e` argv, which lands in a long-lived tmux client's `/proc/<pid>/cmdline`
    at **mode 444** on a stock Linux with no `hidepid`; combined with `open-terminal --cmd` not being
    in the confirm-gated `DESTRUCTIVE` set, that was arbitrary command execution as the victim from
    any account on the box. A remote command line is argv on **both** ends, so the same rule binds
    every `ssh`/`curl` we generate. Credentials travel by 0600 file or by **stdin**
    (`curl --config -`, already house style in `usage/remote-claude-usage.ts` and
    `codex-identity-proxy.ts`). Never add an argv fallback "for old curl" — that undoes the fix.
  - **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
    A new field on the hook event (the `verified` flag was one) that reaches only the desktop leaves
    the Server Edition silently without the feature; the boundary tests cannot tell you a field is
    *missing*. `hook-verified-parity.test.ts` asserts it at source level because this repo has
    shipped a one-shell hook-server change three times.
  - **Every generated sh client reads the token through ONE resolver** (`nt_read_node_token`,
    `core/agents/node-token-sh.ts`) — the managed hook script, `nodeterm.sh` and `context.sh`. The
    token dir is advertised only by the endpoint FILE, and a session is pinned for life to the
    endpoint PATH it got at tmux creation, so a client that reads only what that file advertises
    presents nothing forever when the file is pre-v2 (SSH hosts' shared `~/.nodeterm/hook-
    endpoint.env`, whose per-project socket path is re-bound on every connect, so it stays LIVE) or
    unreadable (a phone-spawned session). Issue #384: the hook script FAILS OVER and re-reads the
    token from the endpoint it adopts, the two shims did neither — so the same node proved itself
    through one client and was refused through the other by the trust-on-first-proof latch, for the
    life of the session. The resolver falls back to `<dir of the endpoint file>/node-tokens` (the
    layout by construction on all three surfaces) and then the well-known data dirs; it is monotone
    — advertised dir first, keyed by node-id filename in every candidate, and a foreign instance's
    dir yields a foreign `kid` = `legacy` = exactly what presenting nothing already gave.
  - **Every LOCAL generated sh client recovers shared-Codex identity before its env gate.** A tool
    shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
    `NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` therefore prepend
    `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
    `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL`. Before this was shared, status hooks recovered the
    node while both user-facing shims declared that same first-class Codex session outside
    nodeterm. The SSH constants remain machine-neutral: the local record root is not valid on a
    remote host and must never be baked into its copy — enforced by
    `main/remote-ssh/remote-shim-neutrality.guard.test.ts`, two legs (the exported neutral bodies
    carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a parameterised
    builder), because the failure is silent and one-sided: a remote shim carrying the prelude keeps
    working, and the only symptom is this machine's userData layout sitting in a file on someone
    else's server. **The prelude is shared; the RECORD it reads is desktop-only.** Those writers are
    the two hook-server handlers `src/main/index.ts` registers — and, since the daemon-reset work,
    the ones `wireServerCodexSharedIdentity` (`src/server/codex-shared-identity.ts`) registers at
    Server Edition boot as well. That shell used to answer a flat `shared: false`
    (`UNKNOWN_CODEX_IDENTITY_CAPS`) as a DELIBERATE degrade: its Codex nodes ran their own
    app-server, so no tool shell needed recovering. It no longer does. The Server Edition has the
    same local app-server, the same signed node tokens and the same persistent canvas store, so it
    wires the shared-thread spine **after** those secrets exist and its panes get the same
    supervisor. The registration is deliberately late for that reason, and `registerCodexIdentityIpc()`
    now answers from the live resolver instead of a constant — an early browser caller waits for the
    refresh rather than being pinned to a false "plain Codex" answer for the whole app run. What
    remains desktop-only is the record's REMOTE leg (SSH shims carry no record root or prelude, the
    paragraph above).
  - **That prelude EXPORTS WHAT THE RECORD SAYS — it never decides.** `NODETERM_AGENT_ID` and
    `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are
    `buildPtyEnv`'s answers about the PANE, which labels a node with its OWN agent id
    (`custom:<uuid>` for a custom agent whose `baseAgent` is codex, not `codex`) and gates the grant
    on `canControlCanvas`. The constants therefore mislabelled every custom codex-based node and
    asserted a grant that agrees with the pane only because
    `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence that list's own comment
    invites the next shared-identity agent to break, and breaking it hands a tool shell a capability
    its pane was denied. So the record carries `agentId` + `canvasControl` INSIDE the 6-tuple HMAC,
    and the prelude reads them; the grant is exported only when the record grants it and is left
    UNSET otherwise (absent, never `0` — the shape both shims' `[ -z … ]` gates expect). The **pane
    echoes its own label** on `/codex-thread/{start,bind}` (a tmux session outlives the app, so
    after a restart nothing server-side still knows what agent a node runs), but the **grant is
    never echoed**: the route derives it with `canControlCanvas`, so there is ONE decider and a
    forged id cannot manufacture a grant the table refuses. The three preimage generations are
    **selected by the record's shape, never tried in turn** — a record naming an agent must not
    verify under a preimage that ignores one — and a pre-agent record's implied `codex` + grant is
    keyed on the LINE being absent, never on the value being empty, so nothing that names an agent
    falls back to the guess. The env vars were never a security boundary in any case (anyone who can
    run the shim can `export` them by hand); the per-node token is, and
    `docs/shared-codex-node-identity.md` states that argument in full.
  - **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
    destructures the request without `agent`, and a record write that omits its optional trailing
    argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route,
    the launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
    `main/codex-identity-record-wiring.test.ts` pins it at source level, the same remedy
    `hook-verified-parity.test.ts` uses for the same class of hole.
  - Control/context endpoint discovery keeps a known node capability as a **routing rule, not an
    ownership proof**. A dead Desktop SSH tunnel must not redirect a command to a local Server
    Edition: its unsupported-edition response describes the wrong instance. The two shims use
    `nt_adopt_for_node` (`core/agents/hook-endpoint-failover-sh.ts`). The reference value is read
    from the PRIMARY endpoint's own token dir only — the one it advertises, else the adjacent
    `node-tokens` — never from the global search `nt_read_node_token` walks (that search exists to
    PRESENT a capability, #384; as a reference it let a Server Edition that opened the same
    project.json supply the "owner's" token whenever the desktop's token write had failed). Once
    that dir EXISTS, a candidate must hold the same value in its own dir — and when the reference
    is EMPTY (the write failed), a value proves nothing (a Server Edition that never heard of the
    node holds nothing too, and `"" = ""` relayed its permanent refusal, measured in review), so the
    candidate's token dir must be the same REAL directory (`pwd -P`) instead. Only a session with no
    such dir at all keeps legacy discovery. What a match shows is
    that the candidate reads the same token file for this node — on an SSH host that file is shared
    per unix ACCOUNT (`remote-hooks.ts`, KNOWN LIMITATION), so two desktops driving one account are
    indistinguishable here, and the receiving server still authorizes every request. Actual
    owning-endpoint refusals remain final. Skipped foreign candidates do not consume the
    three-attempt budget, and a skipped candidate restores the previous endpoint vars (the codex
    sandbox hint names `$NODETERM_HOOK_SOCK` as the socket to allow). Hook event delivery retains
    its existing independent failover policy.
    **Every FALLBACK candidate is probed before the real POST** (`nt_probe_endpoint`: `/hook/verify`,
    204 on the bearer alone on every server build, `--connect-timeout 0.5 --max-time 1.5`). A reverse
    tunnel whose sshd outlived the desktop's connection ACCEPTS and never answers, and once the
    foreign Server Edition stopped absorbing the walk, a call posted straight into such a socket
    hung. The bound is on the probe only: the primary is never probed and every real POST stays
    unbounded, because a confirm-gated verb waits for a human (see "two canvases cannot raise two
    dialogs" below). The probe writes into `$nt_out` like the POST would, so a 421 at the probe
    still prints its body (into /dev/null it left the control shim exiting 1 with an EMPTY stderr),
    and the control shim names a final 421 with `CONTROL_UNREACHABLE_MSG` as the context shim does.
    Consequence to know: while sshd still holds the session's OWN tunnel socket, the primary POST
    itself still hangs — unbounded by design, for the dialogs.
    **Measured on an SSH host (2026-09-28/29):** the desktop slept, the session's tunnel socket
    stayed on disk with no listener, and the walk reached an unrelated Server Edition whose
    `control-unsupported-on-this-edition … permanent … do not retry` (and, for context reads,
    "No linked nodes") was true about that server and false about the session; the tunnel came
    back minutes later. When a foreign candidate was skipped and no owner answered, the shims now
    print `FOREIGN_ENDPOINT_HINT` — the owning connection is unreachable, the state is temporary,
    the usual cause for an SSH project is the tunnel — INSTEAD OF `STALE_ENDPOINT_HINT`, so a failure
    carries one retry advice, not two. With nothing foreign skipped, a primary that is an SSH tunnel
    file (`~/.nodeterm/hook-endpoint*.env`, the only files the desktop writes there) gets
    `TUNNEL_DOWN_HINT` (reconnect) instead of the stale-endpoint advice (app restart); both hints
    open with the lead the bodies quote. All four agent-facing bodies quote its lead via
    `ownerUnreachableGuidanceLines`, because their other refusal lines rightly say "do not retry".
    `src/server/control-owner-tunnel-down.test.ts` rebuilds that host under real `/bin/sh` with the
    real Server Edition handlers as the foreign endpoint; `src/core/owned-endpoint-walk.test.ts`
    pins the probe (hanging sockets), the owner reference, the single advice and the restore, each
    mutation-checked.
  - **Every generated sh client walks the SAME endpoint failover** (`nt_candidates`/`nt_adopt`,
    `core/agents/hook-endpoint-failover-sh.ts`) — issue #445, the endpoint-level twin of #384: a
    session is pinned for life to the endpoint PATH it got at tmux creation, so an app
    quit/restart (or a retired project id) leaves it POSTing at a dead port while a live endpoint
    file sits right next to it. The managed hook script had the bounded candidate walk (locals
    before tunnels, `nt_fallback_max` 3, token re-read from the ADOPTED endpoint's dir); the two
    shims did not, so hook events healed themselves while every canvas-control verb died with
    "control endpoint unreachable" — in the field, a reviewer launch silently dropped. Now shared,
    one definition. Two server-side halves in `hook-server.ts`: a FAILED `listen()` un-wedges the
    singleton (it used to leave `this.server` set, making every retry a silent no-op at port 0)
    and `stop()` deletes only the endpoint contents this run published — a failed start cannot
    erase another owner's advertisement. A crash skips cleanup, which is why clients still walk
    the candidates.
    HTTP 421 means the bearer belongs to a different endpoint and is rejected BEFORE dispatch;
    it joins dead transport (curl 000/'') in the bounded discovery walk. A node-identity 403/400
    remains final and is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` for transport failures (#367); an explicit 421 proves
    transport worked and still permits discovery. The final error distinguishes "no endpoint
    anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  - **Hook endpoint ownership (#826):** startup first probes every transport in an existing
    endpoint advertisement and preserves a live or uncertain owner. The local Unix listener probes its socket before
    cleanup. Only `ECONNREFUSED` plus the same device/inode permits removal; a live listener,
    non-socket, symlink or uncertain probe disables hooks without replacing its endpoint.
    Both shells use `startForApp`: Desktop creates its window and then shows an actionable warning;
    Server Edition logs the same warning and continues boot. An authenticated owner must answer
    `/verify` with 204 for the advertised bearer AND reject a random bearer (403/421); unrelated
    HTTP responses are uncertain listeners, not authenticated nodeterm. Probes have a hard deadline.
    Endpoint writes are atomic and stop removes only the run's own advertised contents. SSH setup
    never removes a socket before binding: every forward gets a fresh random path, while discovery
    is stable per project + installation identity hash. Only a verified replacement is advertised;
    then this run cancels its previous forward. A legacy project endpoint is migrated only when its
    bearer matches the current run, the previous installation-qualified advertisement, or a stale
    conventional local advertisement retained at boot. Publication rechecks the snapshot digest,
    refuses symlinks, uses a migration lock and a private temp, and never places credentials in argv.
    Without ownership proof (including a first upgrade after the old local advertisement was deleted),
    it preserves the file and logs instructions to restart affected agent sessions; discovery still
    works but may incur the old dead-tunnel delay until then. No real-host upgrade is claimed by unit tests. A reused tunnel that loses bearer verification
    emits hook-only health updates: the desktop shows a warning and clears it after repair, without
    reconnecting terminals. These changes share the core listener in Desktop and Server Edition;
    the mobile wire protocol and node-identity rules are unchanged.

  - **No keyring is not "no identity" (#1088).** Electron 42 on a Linux session without Secret
    Service/kwallet picks `basic_text` and `safeStorage.encryptString` THROWS (measured under xvfb).
    The desktop secret load used to reject on every boot ⇒ no node token was ever written ⇒ `send` /
    `settings` refused forever with no visible cause. The loader now falls back to the Server
    Edition's raw 0600 `node-auth-key.bin` when it cannot seal and no sealed key exists (a sealed key
    it merely cannot unseal still rejects — rotating it orphans codex thread records), and both shells
    record a failed arming via `hookServer.setNodeIdentityUnavailable`, which a verified-only refusal
    then names. A secret that cannot be stored must degrade to the weaker store, never to a feature
    that is silently off.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Shared Claude/Gemini settings are user data (issue #851).** The local hook install/remove
  and Claude fullscreen writers share `core/agents/hooks/settings-file.ts`; SSH system/account
  hook installs and fullscreen writes share `remote-settings-file.ts`. Only ENOENT / the remote
  explicit missing-file status or a successfully read empty/whitespace file starts from `{}`.
  Malformed/non-object/read-error settings are preserved. Each transaction stages the complete output, takes a `.nodeterm-lock` directory,
  compares its original bytes before rename, and preserves the file mode. Remote snapshots and
  replacements travel on stdin, with a byte-count check against truncated transport; the shell
  needs no Python/Node/jq. Local profiles resolve symlinks and lock/update the shared target,
  rechecking resolution before publication. SSH does the same with plain readlink + cd -P
  (macOS-compatible, no GNU -f), bounding cycles and refusing dangling links/newline paths.
  Grok's owned file heals malformed JSON and hook shapes by rebuilding its managed config.
  A held or crash-left lock skips the update with a diagnostic naming the lock and instructing
  the user to stop writers before inspecting/removing a stale lock; it never gets stolen. External editors need not honor our lock: the final comparison detects edits
  during merge/staging, but cannot eliminate an external write between comparison and rename.
  No claim that the reporter's historical wipe was proven to take this path: the catch-to-empty
  writer and its data loss were reproduced in fixture homes.
- **Fullscreen TUI (Claude)** — through the SAME `settings.json` seam the hook installer uses,
  nodeterm ensures Claude's `"tui": "fullscreen"` so a session takes the alternate screen + mouse
  and behaves natively in tmux (else a drag falls into copy-mode). Two guardrails: **write-if-absent**
  (any existing `tui` value — e.g. a user's `/tui default` — is never touched;
  `core/agents/hooks/claude-tui.ts` `ensureFullscreenTui`) and **version-gated** to CLI ≥ 2.1.89
  (`supportsFullscreenTui` / `claudeCliCaps().fullscreenTui`; unknown ⇒ don't write). Runs
  everywhere the hook seam does: local `~/.claude` + managed account dirs at launch/add-account
  (`ensureClaudeFullscreenTui{,Into}`), and the remote host + account dirs on SSH connect
  (`RemoteHooks.ensureFullscreenTui{,InAccountDir}`, gated on the connection's cached remote probe).
  **Grok has no analogue** — it runs full-screen by default, so there is nothing to write.
- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Selecting, focusing, dwelling into, or opening a session card
  clears `unread` and ACKs the finish across phone/notch surfaces — existing read-on-view behavior.
  This NEVER changes the workflow bucket: read state is independent from agent state.
- **Sound alerts + custom sounds** (issue #289) — the `done` / `needsYou` alert (`SfxKind`) is a
  synthesized WebAudio chime (`renderer/lib/sfx.ts`, fired from Canvas's `alert` closure, gated by
  `soundEffects`, 5 s/node cooldown). Settings → Notifications lets the user replace either with their
  own file. The picked file's BYTES (never its path) go to `files.saveAlertSound`, a core handler in
  `registerFsHandlers` (both shells), which validates kind / extension allow-list / 5 MB cap / magic
  bytes and writes ONE format-independent name `<userData>/sounds/<kind>.sound` (`core/alert-sounds.ts`;
  a name per format needed a delete-the-others step, and two tabs saving different formats at once
  deleted each other's file — do not reintroduce per-format names); reads and Reset take only the
  kind (no path from the renderer, symlinks refused). Settings keep only
  `customAlertSounds[kind] = {name, stamp}`. Playback decodes the bytes with `decodeAudioData` — no
  `<audio>`, so CSP `media-src` is untouched on both surfaces — and **any failure (missing file,
  refused read, decode/playback error) falls back to the chime without throwing** (`lib/customSfx.ts`,
  read failures and a missing/closed audio context are retried on the next alert; a DECODE failure
  is cached for that `stamp`, so a new pick is tried afresh). Every `playSfx` caller must pass `customAlertSounds` (source-pinned in
  `customSfx.wiring.test.ts`). Server Edition: full — the browser's `<input type=file>` bytes are
  stored in the SERVER's data dir. Mobile: N/A (own notification sounds).
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
  **The clock survives an app restart as "last seen", never as a state** (`agentStatus.lastSeen`,
  `{at, state}`). `lastEventAt`/`stateAt`/`state` are transient, so before this every row after a
  restart sorted as "no clock" and lost its age. `lastSeen` is the time of the LAST hook event (a
  same-state one included) and the state it asserted, persisted beside the agentStatus record under
  its OWN small key (`nodeterm.agentStatus.lastSeen`) — chosen over the core mirror because the
  sidebar already reads this store,
  the mirror expires state after 6 h and identity later, and reading it would need a new IPC leg for
  a display fact. Rules a refactor must not undo:
  - **Restored as a clock only.** Load fills `lastSeen` and nothing else: `state` stays unknown (the
    hook server was down with the app, so a turn may have started or ended in between), and
    `lastEventAt` stays unset. Load marks the clock `restored` (transient, never written); the row
    reads `lastEventAt ?? lastSeen.at` and its `statusClock` is `transition` / `seen` (a hook event
    this run but no transition yet) / `restored`. Only `restored` says "before nodeterm restarted"
    (`seen 3h ago`, tooltip naming the state it was last seen in). **The first event after a restart
    is usually a SAME-state one** (a cold-restore `--resume` fires SessionStart = `state: undefined`
    on an entry whose state is already unknown), so the store's in-place fast path must not take it:
    it replaces the entry (the row loses `restored` and re-sorts at once) without stamping
    `lastEventAt` (an unknown state is not an idle clock).
  - **Eco never reads it** (so `idleKnown` and `planHibernation` are unchanged). Even a proven-idle
    prompt after boot would not be enough: the background-task stamp and the subagent cards Eco
    also needs are transient and cannot be rebuilt after a restart, and `/exit` kills both
    silently. A session becomes a candidate again from its next live `done`.
  - **Its own key, so the main table's write cadence is unchanged.** State events still write
    nothing to `nodeterm.agentStatus`. That matters twice: the main table carries `loop.items` (up to
    100 × 4000 chars per loop node — 428 KB and ~2.1 ms per stringify with one full loop, measured in
    review), and on the Server Edition every tab rewrites its whole in-memory table, so a periodic
    rewrite would let tab B undo tab A's `clearUnread`/`hibernated` within seconds. A first version
    stored the clock inside that table on a 2 s THROTTLE and rewrote it every 2 s while any agent
    worked. The clock key is saved on a real TRAILING debounce (5 s quiet, `LAST_SEEN_SAVE_MAX_WAIT_MS`
    30 s at most while never quiet) plus `pagehide`: 2 Hz hook events for 10 s = ONE write. Measured:
    ~59 bytes per clock, 1000 clocks = 59 KB and 0.7 ms per `JSON.stringify` on this dev host. Two
    Server Edition tabs still race on the CLOCK key (last writer wins), which costs only display.
  - **Bounded.** At most `LAST_SEEN_MAX` (1000) newest clocks are written; a clock older than 90 days
    or more than 5 min in the future is refused on load (hand-editable input — a future stamp would
    pin a row to the top); an unknown `state` keeps the time and drops the state; an unreadable clock
    key costs the clocks, never the table.
  - **It cannot create a row**: rows come from canvas nodes, never from the status table.
    `remove(id)` writes the clock key at once, a pending debounced save included; a deletion path
    that bypasses `remove` (e.g. `reloadActiveProject` dropping nodes) leaves a clock that simply
    ages out. Tests: `state/agentStatus.lastSeen.test.ts`.
  - Surfaces: Desktop full; Server Edition per browser profile (localStorage, like `unread`); relay
    tabs keep a keyless store and persist nothing; kanban has no clock-ordered view, so nothing to
    wire there; Mobile N/A (its own state).
- **Session name ⇄ node title** — **two lists, because the two directions are separate facts**:
  `TITLE_READ_CAPABLE` (`canReadTitle` — claude, **codex**, grok, **gemini**) is the READ leg,
  `RENAME_CAPABLE` (`canRename` — claude, grok) the WRITE leg, and **read ⊇ write** is an invariant
  pinned in `config.capabilities.test.ts`. Gemini and codex are the reason: they name their own
  sessions (codex via `readCodexSessionName`) but have **no rename command** (gemini's `/chat save
  <tag>` is a checkpoint, not a title), so one list for both legs would light the rename UI on a
  node where the write silently does nothing. The **write** is the same literal
  `/rename <name>` for claude and grok; the **read** legs are per-agent and none may ever
  search another's tree, so the routing lives in ONE place, `core/agent-session-name.ts`
  (`readAgentSessionName(sessionId, accountId?, agentId?, deps?)` — trailing/optional so every pre-grok
  caller is unchanged), serving the desktop IPC handler **and** both shells' session-name sweeps.
  Grok's read leg is `core/grok-session.ts` over `summary.json` in the session dir a hook told us
  about; gemini's is `pickGeminiTitle` (`core/gemini-session.ts`) over the transcript path its context
  tail already tracks — including the `$set` history a **resume** replays, which is exactly the case the
  read leg exists for. Routing is not cosmetic — claude's resolver *scans* `~/.claude/projects` on a
  cache miss, so an unrouted grok/gemini node paid that scan every 60 s for a guaranteed null.
  **The sweep's gate lives in core, not in the shells:** `startSessionNameSweep` defaults `supports` to
  `supportsTitleRead` (`core/session-name-sweep.ts`) and neither shell passes it — the duplicated copies
  drifted, and reverting both to `canRename` left the whole suite green while silently skipping every
  gemini node.
  - **session → title (read, claude):** the authoritative name lives in the transcript `.jsonl`, not the
    OSC terminal title (`/rename` does **not** update OSC — a known Claude gap — so reading the
    file is the only thing that works after a **resume**). `core/transcript-reader.ts`
    `readSessionName(sessionId)` resolves the session file **strictly by sessionId** (no cwd
    fallback — that would make every Claude node in one folder resolve to the same newest transcript
    and adopt each other's names) and `pickSessionName` returns the latest `custom-title`'s
    `customTitle` (the `/rename` name) else the latest `ai-title`'s `aiTitle` (auto name). Exposed
    over `pty.readSessionName`. `TerminalNode` polls it (~4 s) **only once this node's own sessionId
    is known** and **while the title still auto-tracks** (`data.titleAuto`, default true on agent
    nodes), and adopts it as the `title`. `term.onTitleChange` now feeds the `session` chip only.
    **A poll of an unchanged transcript reads no bytes**: the local read is gated on the resolved
    path's (size, mtime) (`titleCache`, bounded at 500, a failed tail read never cached), and the
    remote one (`main/remote-title-reader.ts`) on the remote context tail's `offsetFor` for the SAME
    path — that offset is the file size at the tail's last read, so a remote `/rename` lands within
    the tail's idle backoff (real gaps between idle reads ≈3/5/9/11 s) PLUS one title poll
    (4–15 s); an untracked session (offset unknown) always reads.
  - **title → session (write):** the moment the user renames the node by hand (header rename box /
    ✦ AI-name / sidebar / command palette → all funnel through `applyManualTitle` or
    `renameSession`), `titleAuto` flips to **false** (polling stops overwriting) and the chosen name
    is pushed into the live session as `/rename <name>` via `pty.sendText` (tmux `send-keys`, same
    one-way bridge as Branch's `/branch`; works whether or not the node is mounted).
  - The launch command is left bare (no `-n`) — Claude's own name is canonical until the user
    overrides it; `titleAuto` is persisted so an overridden name survives reload/resume.
- **Search** — the command palette (⌘K) matches the session name + tags + `nt-<id>` in the
  hint, and substring-searches each terminal's **visible buffer** (captured via `pty.capture`
  on palette open, cached ~3s); content matches show "found in output".
- **⌘M transcript view (`ChatPanel`) — resolution is three-legged, and each leg fails differently.**
  `chat.readTranscript(sessionId, cwd, accountId, nodeId)` returns `ChatTranscriptResult
  {messages, found}`, NOT a bare array: an empty thread and an unresolvable transcript are
  different facts, and rendering both as "No conversation yet." is what made every failure below
  look like an empty session. (1) **Remote (SSH) nodes** — `remoteTranscriptBySession` is fed
  ONLY by hook POSTs, and a tmux session outlives the app, so after a restart an idle remote node
  has no ref and the local resolvers search the WRONG MACHINE. `remoteTranscriptRefFor` (main)
  therefore asks the host itself: the pure `core/remote-transcript-locate.ts` builds one `sh` line
  (exact `<root>/<encoded cwd>/<id>.jsonl` per root, then a glob; account root before the system
  one; `*` outside the quotes; **exits 0 on a clean miss** — "no transcript" is an answer, not a
  failed ssh), it runs over the ControlMaster, and the reply is jailed by
  `isSafeRemoteTranscriptPath` before it is read. A ref WE located is tracked in
  `locatedTranscriptSessions` so a dead one can be dropped on an empty read (the panel's Retry
  would otherwise replay it forever) — a HOOK-fed ref is never dropped that way, since an empty
  read there is usually a transient master hiccup and forgetting it sends the next read local.
  It is generated shell, so `remote-transcript-locate.test.ts` runs it for real under `/bin/sh`
  against a fake host tree — keep it that way.
  **A remote node never falls through to this machine** (2026-09-28): the handler decides
  remoteness from the SHELL's records (`isRemoteNode` dep — live remote pty or
  `workspaceStore.sshProjectIdForNode`, never a renderer flag) and applies `remoteOnly` to the
  paged ⌘M read, the legacy read, the find-bar index (`[]`) and `transcriptExists` (`unknown`).
  The host locate is tri-state (`locateRemoteTranscriptRef`): a CLEAN MISS is `found:false`, a
  failure to ask is `unreadable` ("Couldn't read the transcript.") — the phone's `chat.page` shares
  the same deps and the same distinction. Before this, a mounted SSH node whose locate missed (or
  whose master was down) read THIS machine's resolver, cwd-newest fallback included. `transcriptExists` shares the same locate
  (`remotePresenceFromLocate`: ref/absent/unreadable → present/absent/unknown, a malformed id
  `unknown`), so it also works for a node with no live pty. A remote grok node is read on its host
  by its own leg (`readRemoteGrok`, see the grok chat bullet), with the same absent/unreadable split. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Which session id is read is ONE rule, `transcriptSessionFor`** (`renderer/lib/transcriptSession.ts`,
  2026-10): the hook-confirmed `agentStatus.sessionId`, else the id the node was LAUNCHED with
  (`data.agentSessionId` — minted with `--session-id`, or the id "Open recent" resumed). The canvas
  node, the ⌘M hint, the kanban card, the card modal and its viewer all ask it. Before, Chat (and
  the meter) were gated on the hook id alone, so a node whose hook events never reached this app —
  an SSH session pinned for life to a dead hook endpoint, the 107-of-128 case in "A reused
  ControlMaster…" — opened "Markdown view" and showed no meter while its transcript sat on disk
  under an id the node itself had on record; others in the same project opened Chat. The fallback
  is HONEST, because the persisted id can be stale (`/clear` / `/resume` in the CLI moves to
  another session; nothing rewrites `agentSessionId` from hooks): (1) ChatPanel's
  `sessionFallback` prints one quiet line saying so, and the meter's popover says "From the session
  this node was started with"; (2) the read carries **no cwd** (`transcriptReadCwd`), because
  claude's resolver answers a missing id with the newest transcript in the folder — under a
  fallback id that would be a stranger's conversation; the remote locator globs by id without a
  cwd, so SSH nodes are still read on their host; (3) plan/question answer controls are never
  offered on a fallback thread (an answer is a WRITE bound to the live `held` ticket). The composer
  still sends (it types into the pane, which is right whatever the transcript). The persisted id is
  the CREATED agent's, which is exactly the agent both mount sites pick the reader by, and it is
  re-validated against `SAFE_SESSION_ID` (hand-editable project.json). The find bar's transcript
  index still uses the hook id only (it has claude's cwd fallback and no `remoteOnly` here).
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
  **System-injected user records are not the user's words** — a `<task-notification>`, a peer
  `<agent-message>`/`<cross-session-message>`, an auto-continuation/coordinator prompt — so
  `parseChatRecords` (and the find-bar index) renders each as ONE assistant tool part
  (`classifySystemRecord`: "Background task" / "Agent message" / "System", no wire change; each is
  a turn boundary in `assistantTurnEnds`) and fences a human paste's `<pasted_content>` span (the
  CLI's own 4-hex-id grammar only; titles keep the raw text) — all `indexOf` scans, never a
  backtracking regex (quadratic on unclosed tags); exact rules in `src/shared/chat-fixtures/README.md`.
  **Paged reads (2026-09).** `chat.readTranscript` takes a trailing optional `page`
  (`{before?, maxBytes?}`, `shared/chat-page.ts`). Absent = the legacy 5 MB-tail read, byte for byte
  (result is exactly `{messages, found}`). Present = ONE window of at most `maxBytes` (clamped
  64 KB…5 MB — it is untrusted IPC/WS input; an invalid `before` REJECTS rather than being coerced
  to "end of file") ending at byte `before`, and the result adds `olderCursor` (where the window's
  first complete line starts — the next page's `before`; `null` = reached the start), a per-message
  `key` (the line's ABSOLUTE byte offset — stable across prepends and appends), `id` on tool parts,
  and `unmatchedResults` (tool results whose `tool_use` sits in an OLDER window: the newer page is
  read first, so the renderer holds them until that page arrives). Parsing is the pure
  `parseChatWindow` over BYTES (a multi-byte char cut by the window edge only lands in the dropped
  partial line), and every window is read with **one byte of lookbehind** — the only way to know a
  line begins exactly on the edge; without it that line is dropped as "partial" and lost. A window
  with **no complete line** (one record bigger than the window — in practice a `type:user` line
  carrying a pasted screenshot or an image tool_result; 181 lines over 512 KB in 30 days on one
  host) is flagged `noCompleteLine` and **re-read at the same `before` with ×4 the bytes, up to the 5 MB cap**
  (`parseGrowingWindow` in `core/transcript-ipc.ts` — local AND SSH leg; a failed re-read is
  not-found, never the skip). Only a line **longer than 5 MB** is skipped (`olderCursor = window
  start`, never the window end, which would re-request the identical window forever) — before this,
  every line bigger than the page vanished, a regression against the legacy 5 MB read. The **SSH leg** is a ranged read
  (`transcriptPageCommand`, `core/remote-ssh/transcript-window.ts` — size + window in ONE round
  trip, dd status inside the base64 like the context-tail's window command) instead of pulling the
  5 MB tail on every open and every turn-end reload; its `{ok:false}` is terminal (never the local
  disk), and it is tested under a real `/bin/sh` (`transcript-page.realsh.test.ts`). **Grok does not
  page** (its file is rewritten in place, so offsets are no identity): a paged request gets its whole
  capped read with `olderCursor: null`, no keys, and the newest record's `model`/`effort`.
  Server Edition passes `page` through ws-bridge to the same core handler; relay still refuses.
  **ChatPanel consumes it progressively** (pure state in `renderer/lib/chatPaging.ts`): the first
  read is a 256 KB tail (`CHAT_TAIL_PAGE_BYTES`, with a "Loading conversation…" row), older 512 KB
  pages load when the user scrolls within 200 px of the top (or by themselves while the thread is
  shorter than the viewport — it cannot scroll), one at a time behind their own token, prepended
  with the scroll position ANCHORED on the scrollHeight delta (the loading row's own appearance
  included). A turn-end reload / ↻ re-reads only the tail and **merges by key**, keeping the older
  pages already loaded — unless no rendered message reaches into the new window (the turn wrote
  more than a whole window, so the bytes in between were never read): then it RESETS to the tail
  rather than stitch over a hole. Carried tool results are held until their tool's page arrives and
  dropped at the start of the file. `found:false` on an OLDER page is a failed page load (retry row,
  thread kept), not a missing transcript; a reload that fails to resolve never blanks a rendered
  thread — only a read with nothing on screen says "No transcript found". The remote leg's
  forget-a-located-ref rule lives in `main/remote-transcript-page.ts` (a hook-fed ref is never
  dropped on a failed read, and a hook event re-marks a located ref as hook-fed). Grok: one
  unkeyed read, no older pages, no "Beginning of conversation" marker (a capped read cannot know).
  **Loading surfaces (2026-09).** The lazy ChatPanel chunk suspends into `ChatPanelFallback` at
  ALL THREE mount sites (canvas node, kanban card modal, closed-transcript dialog — it replaced a
  `fallback={null}` that left the ⌘M face blank over the terminal): the panel's own shell plus
  `ChatLoadingStatus`, which ChatPanel's initial "Loading conversation…" row renders too, so the
  handover is identical DOM (a second row swapped rings and re-announced its `role=status`). Its
  spinner is the app's ONE spinner, `components/Spinner` / `.nt-spinner` — frozen, not hidden,
  under `prefers-reduced-motion`; never add a local one. A terminal node's label row ends in a
  quiet ⌘M hint (`lib/mdViewHint.ts`, id `md-hint`, hideable in Settings → Appearance) naming the
  EFFECTIVE chord and what it opens on that node; it sits in a zero-basis trailing slot that
  clips, so it can never add a line to the row (a height flip would refit xterm and SIGWINCH
  tmux). It is not on the kanban card modal: that header already carries the ⌘M toggle.
  **The composer sends only in `done` or an unknown state** (`canSendFromChat`,
  `renderer/lib/chatSendGate.ts`), with ONE exception: `working` for an agent in
  `INPUT_QUEUE_CAPABLE` (claude — measured: a prompt submitted mid-turn waits in Claude Code's own
  queue and reaches the model at the next tool boundary), where Enter QUEUES (`chatSendMode`) and
  the bubble reads "Queued" until the transcript has it. Only a plain prompt queues (`canQueue`):
  a slash command or `!` line mid-turn is unmeasured and waits. While the agent works the textarea
  stays editable for every agent (`composerStandsDown`) — only sending is gated. Never in
  `waiting`/`blocked`:
  PermissionRequest and AskUserQuestion both normalize to `waiting`, the pane then holds a TUI
  select dialog this view does not show, and `sendText`'s Enter would ANSWER it ("Yes" is the
  default highlight). It also refuses any node whose CLI has left the pane — hibernated, paused,
  dropped, or **exited** (`/exit`/Ctrl+D: `state: undefined` + `sessionEnded`) — because a SHELL
  owns it and the message would run as a shell command. That test is `agentProcessInPane`
  (`terminal/live-work.ts`), the same single rule the memory levers use — never a second copy of
  the flag set — and it ranks above the state (`chatSendRefusal`). Everything is re-read from the
  store at send time, not only at render. Same trap as the in-place restart's `/exit`. The bar's ↻
  reloads on demand (beside the empty state's Retry), since a session whose hooks never report
  `working` never takes the turn-finish reload.
  **A chat prompt is TYPED for claude, never pasted** (`core/typed-input.ts`, `TYPED_INPUT_CAPABLE`).
  Claude Code records a multi-line paste as `<pasted_content>`, which its model is told may not be
  the user's words; typed text (lines joined by tmux's `M-Enter`, measured on 2.1.281) is recorded
  as plain user text. Three rules: (1) **core decides it from the agent id** inside
  `sendChatPrompt` (`typedFor`), never a renderer-sent flag — every other agent and every other
  `sendText` caller keeps the paste; (2) **every write into a pane is serialized per pane**
  (`PtyManager.serializePaneWrite`, wrapping `sendText` AND `sendEnvelope`): a typed send takes
  seconds (one paste per line, then a settle wait before Enter), and an agent message, a reminder
  or dictation arriving in that window would otherwise land between its lines and be submitted as
  part of it; (3) **the screen is checked again right before the Enter** (`TypedSurface.canSubmit`):
  the dialog check `sendChatPrompt` makes is seconds old by then, and an Enter into a dialog that
  opened meanwhile would ANSWER it — the text stays in the composer and the caller hears
  `pasted-not-submitted`. The panel ignores a second Enter while a send is in flight (the draft is
  cleared only once it lands).
  **The agent's OWN dialogs are read off the screen** (`shared/agents/claude-screen.ts`, claude
  only — `SCREEN_DIALOG_READABLE`). The folder-trust prompt, `/model` and one-time setup questions
  fire NO hook, so the state gate above reads `done` while one owns the keyboard, and a paste into
  it was swallowed while its Enter answered the dialog (the trust prompt's default is "No, exit").
  A send therefore goes through `pty.sendChatPrompt`, where core captures the pane first and
  refuses (`ChatPromptBlocked`, nothing written, the draft kept) when the bottom of the screen is a
  dialog footer or has no input box; an empty or unreadable capture is NOT evidence and sends as
  before. A LOCAL pane is also polled every 2 s while the view is visible, to disable the composer
  and show the dialog's lines; SSH and relay panes are not polled (a round trip per read) and rely
  on the send-time check. Another CLI's layout would read as a permanent dialog, so an agent joins
  the list only with its own measured reader.
  **Live progress (2026-09).** While the agent works, a `role=status` row closes the thread (the ONE
  spinner + the placeholder's own "<agent> is working…"/"waiting for an answer" sentence; optimistic
  right after a send, bounded by `CHAT_OPTIMISTIC_WORKING_MS`), and every hook event re-reads the
  tail — throttled (`CHAT_LIVE_RELOAD_MIN_MS`, trailing read guaranteed), single-flight, never for a
  hidden panel or document (`lib/chatLive.ts`). The trigger is `agentStatus.onHookEvent`, NOT a
  `stateAt` selector: same-state events refresh `stateAt` in place and notify no zustand subscriber.
  A live read passes `applyTail(…, {carryUnconfirmed})`, which keeps the trailing unkeyed optimistic
  send until the tail holds a matching user line (the send's own UserPromptSubmit read races the
  transcript write); it never resets a failed older page or flips an empty state to "Loading…".
  Gap: the panel reads the DEFAULT agent-status store, the only one Canvas's hook listener writes, so
  a relay tab gets neither the row nor live reads until relay status is routed per session.
  **Plan and question bodies (2026-09).** A tool call is normally a collapsed chip (`name` + a
  ≤200-char `arg`), which left an `ExitPlanMode` plan — the full markdown the terminal shows as
  "Here is Claude's plan" — and an `AskUserQuestion` question + options unreadable in ⌘M, the one
  place meant for reading them. `core/chat-tool-body.ts` (pure) fills the tool part's optional
  `body` for exactly those two tools (`input.plan`; the questions rendered as markdown), capped at
  64K characters (never splitting an open code fence or a surrogate pair; model-authored labels are
  kept to one line with emphasis escaped), degrading to no body (the old chip) on any other shape;
  ChatPanel shows a part with a body as an expanded "Plan"/"Question" card through `MarkdownText` with its result under it, and
  the find-bar index (`linesFrom`) indexes the body in full like assistant text.
  **Answer controls on those cards (2026-09).** Only the card the node's `held` ticket belongs to gets
  controls (`lib/chatAnswer.ts` `activeAnswerCard`: newest unanswered card of the held tool; a question
  also needs identical question texts — `held.questions` and the card's `questions` come from the ONE
  `readQuestions`), and only while the pane is in a dialog state. They send a `PermissionAnswer`
  through `answerPermission`; a refusal is a quiet retryable error pointing at the terminal. Plan's
  default button is `restore` — never auto. See docs/hook-reply-approvals.md.
  **A card answers only the request the THREAD was read for** (`answerCardState`, same rule as
  iOS #41): `threadHeldFor` = the held ticket at the START of the last applied tail read, keyed by
  transcript identity. While held moves A → B (a revised plan) plan A's card can still be on screen
  unanswered, and a tool-name match would approve B from it — so until a read started under B lands,
  the latest unanswered card of that tool says "Updating… — or answer in the terminal" and nothing
  is answerable. A held change forces a tail reload (queued behind a read in flight, which started
  under A and cannot bind B, and behind an older-page fetch, which it never cancels). It is a QUIET
  read (no "Loading…"), and one path owns it: on working → blocked the turn-end reload does. While a
  request is unbound it retries with backoff (`rebindRetryDelay`: 2 s doubling to 30 s, reset per
  request) — card on screen or not; it stops once B surfaces on a new card (a duplicate ticket for the same tool_use keeps a quiet 30 s retry while the agent stays blocked). A read under B that still shows the card A was bound to (same tool id / line offset —
  the transcript can lag the hook) stays "Updating…": B must surface on a card the thread shows as
  new. The answer payload carries the BOUND id, re-checked against store and binding at send time.
  Residuals: the previous-card memory is per MOUNT (a panel opened fresh under B has none, so it
  binds B to the latest matching card); a re-issued ticket for the SAME tool_use (duplicate hooks)
  stays "Updating…" and is answered in the terminal; and the whole guarantee assumes Claude writes
  the tool_use to the transcript before the hook fires.
  **The thread look (2026-09-26, claude.ai-style)**: the user's message is a neutral rounded bubble
  on the right (`term-chat__bubble`, a tint lift — never the blue accent), the assistant's is plain
  full-width text with no bubble. One quiet action row per assistant TURN (`lib/chatThread.ts`
  `assistantTurnEnds` — a turn is a run of consecutive assistant lines, so a tool-heavy turn gets one
  row, not one per tool call), hidden until hover/focus and always shown on the latest turn: Copy (the
  turn's TEXT parts as markdown source, through `window.nodeTerminal.clipboard` — the app channel,
  which never rejects and bridges to execCommand in the browser) and a relative time from the new
  optional `ChatMessage.at` (epoch ms from claude's ISO `timestamp`, set by the core parser on BOTH
  the legacy and paged paths; absent when the line states none — never a made-up time). One
  60-second `now` tick in ChatPanel drives every row's label. No thumbs / read-aloud / retry (no
  terminal equivalent). `.term-chat__text` stays the markdown sink the link guard scopes to.
  **The composer (2026-09-26, claude.ai-style)** is one rounded box — textarea on top, a toolbar
  under it: "+" attach on the left; model label, muted effort label and a mic on the right (pure
  decisions in `lib/chatComposer.ts`). Four rules: (1) **attach = paths in the DRAFT, resolved the
  way a drop onto that node's terminal is** — the mount site passes `pathsForFiles` built on
  `droppedPaths` with the node's own SSH scope (`dropProjectId` in TerminalNode; `spawn.ssh` in the
  card modal), so an SSH node's file is uploaded to its HOST and the composer never grows a second
  resolver; "+" / drop / file-or-screenshot paste all feed it, and nothing is ever sent. (2) **The
  mic targets THIS composer's textarea, never the pane**: `nodeterm:dictate` carries a per-MOUNT
  `composerId` (the canvas node and the card modal can both mount one session's composer),
  `DictationTarget` gained `kind: 'chat-composer'`, and the overlay hands the take over
  `nodeterm:chat-dictation` (`lib/chatComposerDictation.ts`), saying so if the composer closed
  mid-take. (3) **The labels read the ContextMeter's store** (`useContextUsage` — ONE reader) and
  a click TYPES the agent's own picker command (`/model`, `/effort`) through the SAME
  `chatSendRefusal` gate as a message, re-read at click time, then flips to the terminal
  (`onShowTerminal`); `sendText` must answer `=== true` to flip. Measured for claude only
  (`composerPickerCommand`, via `capabilityAgentId`): any other agent shows no label, since a label
  that opens nothing is a lie. Hidden when the model is unknown; effort hidden with it. (4) **Effort
  was measured, not assumed** (Claude Code 2.1.283): read = the top-level `effort` the CLI writes on
  every assistant record it sent with one (`...E!==void 0&&{effort:E}`; its own history reader
  walks the same field; a transcript flips `medium`→`xhigh` on the first request after `/effort`);
  change = `/effort` (a `local-jsx` picker, levels `low|medium|high|xhigh|max`). `parseLatestUsage`
  takes it from the LATEST usage record only — never carried forward, a record without it means
  that model takes no effort — and both context tails push on an effort-only change
  (`ContextWindowUsage.effort`, optional: older hosts and other agents simply omit it). Like the
  model, it lags until the next request. Narrow composers drop effort first, then the model
  (`composerToolbarLayout`); "+" and the mic stay. No voice-conversation button: there is no
  terminal equivalent. Surfaces: Desktop + Server Edition identical (dictation and uploads already
  bridge — `files.saveUpload`, `speech.*`); SSH nodes upload to the host; kanban card modal shares
  ChatPanel and wires both props; relay tabs keep the panel's existing refusal; mobile N/A.
  Fix-round rules (same day): the composer is its OWN component (`nodes/ChatComposer.tsx`) so the
  thread and the composer restyle independently. A label click is an explicit "go to the
  terminal", so the flip FOCUSES the xterm whatever its entry state was
  (`requestTerminalFocusOnExit(nodeId)` before the state change, consumed once by the node's
  `useMdModeFocus` — TerminalNode and ModalTerminal both key it by node id). `/model` and `/effort`
  open LOCAL pickers that fire NO hook, so the gate still reads `done` while one is on screen: the
  composer holds a picker command in flight (ref + disabled/`aria-disabled` labels, and Enter is
  swallowed) from click until the flip or failure — a second click would otherwise paste
  `/model` + Enter INTO the picker, confirming its highlighted row. **Inherent limitation:**
  returning to ⌘M while a picker is still open reads `done` too, so a chat send or a label click
  there would type into it — the pane is not observable from here. Shortcut dictation (keyed chord
  and hold-to-talk) targets the composer holding the caret before the selected terminal (the pane
  under the view is hidden) via `composerFromElement`; the dispatcher offers keyed dictation in
  that one text field (`isChatComposerTarget`). Both are keyed on the composer BOX
  (`[data-chat-composer-id]`), never on the textarea's `term-chat__input` class — the plan
  "Revise…" textarea and the question "Other" input share that class and sit outside the box. With
  focus anywhere else inside `.term-chat` (those fields, the answer buttons) BOTH shortcut paths
  refuse (`shortcutDictationFocus` → `refuse`): their fallback, the selected terminal, is the hidden
  pane showing the very plan/question dialog, and typed characters landing there would move its
  highlight or fill its "Other" field (the overlay types with `enter: false`, so nothing submits).
  **Every mic that names only a NODE** — the terminal header mic, the card modal's header mic, the
  Dock mic and the shortcut fallback (selected terminal / open card) — goes through
  `dictationTargetForNode`: while that node's chat view is up (`.term-chat[data-chat-node-id]`) the
  take goes to its mounted composer (the card modal's own when the modal is open for that node, so
  a modal showing the LIVE terminal still targets it), a chat view with no composer refuses, and
  otherwise it is the terminal as before. Every refusal says so in one `nodeterm:toast`
  (`announceChatDictationRefusal`, naming the composer mic) instead of a silent dead key.
- **The composer completes `/` and `@` (2026-09-30).** Typing `/` at the START of the message (after
  optional whitespace — every CLI measured reads `/x` mid-sentence as text) opens a menu of the
  node's CATALOG; `@` at the start of a word opens the node's files. Arrows move, Enter/Tab ACCEPT,
  Esc closes the menu only (CardModal's capture-phase Esc already stands aside inside
  `.term-chat__compose`). **Accepting only inserts text** (`/name ` / `@path `): nothing is typed into
  the pane, and the send is still the composer's own gated Enter (`chatSendRefusal`) — completing
  `/clear` then pressing Enter is exactly typing it. **Enter accepts only when accepting CHANGES the
  draft**: a fully typed `/model` with the menu still open is a message and Enter sends it (the
  first version swallowed it, and `ChatPanel.live.test.tsx` caught the regression). Pure decisions in
  `renderer/lib/chatComposerComplete.ts`; the wire shape, sanitizer, measured tables and ranking in
  `@shared/chat-catalog`; the builder in `core/chat-catalog.ts` behind `chat:catalog`
  (`registerChatCatalogIpc`, registered by BOTH shells). Rules a refactor must not undo:
  - **Built-ins are only what was MEASURED** (2026-09-30), by typing `/` in each TUI inside a private
    tmux server and paging the whole menu: claude 2.1.285, codex 0.156.1, opencode 1.18.25, gemini
    0.62.0 (throwaway HOME + a dummy API key — the menu is client-side). **grok has no table**: 1.0.44
    would not start past its browser sign-in on the measuring host, and a list copied from docs is a
    guess about the binary the user runs. Plan-, login- and experiment-gated entries are left out.
    Any other agent (grok, copilot, antigravity, a custom agent with no base) gets `@` only; a custom
    agent inherits its base's table through `capabilityAgentId`. The descriptions are our own words.
  - **A built-in that opens a DIALOG in the TUI is `interactive`, and sending one flips to the
    terminal.** `/model`, `/rewind`, `/resume`, `/config`, `/permissions`, … open a picker the ⌘M view
    cannot see while the state still reads `done` — the next message's Enter would ANSWER it (confirm
    the highlighted row), the hazard the toolbar labels already guard. So every built-in is tagged
    `interactive` EXCEPT a per-agent `SAFE` set of measured no-dialog commands (claude
    `clear compact init recap reload-skills security-review`, codex `clear compact init new recap`,
    gemini `clear compress init`, opencode `new`) — unknown means dialog, because over-tagging costs a
    flip and under-tagging costs a wrong answer. `ChatPanel.send` calls `onShowTerminal` after a send
    confirmed `=== true` whose text `isInteractiveBuiltin` (menu-completed OR typed by hand, with or
    without arguments); a composer with no `onShowTerminal` does not offer those entries at all. The
    phone gets the tag in its catalog and owes the same rule.
  - **Custom commands and skills: claude and gemini only**, at the measured locations. claude:
    `<configDir>/commands/**/*.md` + `<cwd>/.claude/commands/**/*.md` (measured: a subfolder is a
    `dir:name` namespace; description = frontmatter `description`, else the first body line; a
    `SKILL.md` inside a commands folder names its FOLDER, `review/SKILL.md` → `review`, per the 2.1.285
    loader) and
    `<configDir>/skills/*/SKILL.md` + `<cwd>/.claude/skills/*/SKILL.md` (measured: the frontmatter
    `name` WINS over the folder name, the folder is the fallback, `user-invocable: false` is not
    offered). `<configDir>` is the bound account's dir (`claudeConfigDirFor`, linked accounts
    included), which REPLACES `~/.claude` — never both, and a malformed account id yields NO user
    root, never the system dir in its place (another identity's commands). gemini:
    `~/.gemini/commands/**/*.toml` + `<cwd>/.gemini/commands/**/*.toml` (its shipped
    custom-commands reference). Precedence project > user > built-in, deduped by name. Other agents'
    custom locations were not measured, so they list none — a guessed location offers commands the
    CLI does not have.
  - **A PROJECT root follows no symlink, at any level** (`CatalogRoot.within`). A cloned repository's
    `.claude/commands/notes.md -> ~/.git-credentials` otherwise put the token-bearing first line in
    the menu and in the phone's catalog (reproduced in review, both legs). Locally entries are
    lstat'ed and files opened `O_NOFOLLOW`; remotely `find -P` and `[ -L ]` on the skill folder and
    its SKILL.md; and the root itself must resolve inside the cwd (realpath / `pwd -P`), so a
    `.claude` linked out of the project lists nothing. USER roots (the person's own config dir) are
    followed — that is how shared system skills reach an account dir.
  - **Names and descriptions are hostile data** (a project's `.claude/commands` is whatever the
    repository holds): a name passes `catalogName` (closed alphabet `[A-Za-z0-9][A-Za-z0-9._:-]*`,
    ≤ 64, never trimmed) or the entry is dropped; a description is one line with C0/C1 and `\p{Cf}`
    (bidi, zero-width) removed, capped at 160 code points. The renderer re-runs
    `sanitizeChatCatalog` on every reply and renders both as text nodes. `@` never offers a path with
    whitespace, a control or format character, or one failing `isSafeQuickOpenRelPath`.
  - **The menu is DERIVED from the draft plus a caret snapshot taken for that exact draft**
    (`caretSnap.value === value`), never kept as its own state. A draft changed outside the textarea
    — ChatPanel clearing it after the async send, dictation, an attach — invalidates the snapshot and
    closes the menu (reproduced in review: send `/compact`, the Enter's keyup re-armed the menu from the
    old text, and Tab then turned the emptied draft back into `/compact `). A disabled composer derives
    nothing. A bare `@` is not a choice: Enter sends `hello @`, Tab still accepts.
  - **Cost: nothing is polled.** A composer asks on its first `/` (or `@`) and reuses the answer for
    `CATALOG_REUSE_MS` (30 s). Core caches every directory listing by the directory's mtime and
    every file head (first 4 KB) by (mtime, size), so an unchanged tree costs stats, no reads. Per
    root at most 200 files, commands 3 levels deep.
  - **`@` is the existing quick-open index**, not a new walker: `files.quickOpen(cwd)` on the
    session's api (this machine, or a relay peer's core) or `sshFs.quickOpen(scope, cwd)` for an SSH
    node — gitignore-aware, capped, traversal-guarded — rooted at the node's cwd, ranked by the
    quick-open fuzzy ranker. The SSH scope is the one the composer's attach already uploads through
    (`nodeUploadScope`), passed as ChatPanel's `sshProjectId` from both mount sites.
  - **An SSH node's catalog is read on its HOST, in ONE round trip** (`remoteCatalogCommand`, run over
    the node's master by the desktop's `runRemote`; tested under a real `/bin/sh` against a fake host
    tree). A remote node whose host cannot be asked — or a shell with no remote leg — answers
    built-ins + `partial`, never this machine's folders. Every file's bytes pass `tr -d '\036'`, so a
    hostile file cannot forge a record boundary. Remoteness is the shell's own record
    (`isRemoteTranscriptNode`), never an argument.
  - **Surfaces.** Desktop full (local + SSH). Server Edition full, local only (real ws-bridge
    `chat.catalog`; it runs on the host it reads). Relay tabs: `chat.catalog` REJECTS (stub) and the
    composer offers the shared built-in table alone; `@` uses the peer's own quick-open index, which
    is the right machine. Kanban card modal: the same ChatPanel/composer. **Mobile**: `chat.status`
    carries the same catalog as an OPTIONAL field when the phone sends `catalog: true`
    (docs/mobile-chat-view.md); an older phone never asks. It is bounded
    (`HOST_CHAT_CATALOG_TIMEOUT_MS`, 4 s, then the status goes out WITHOUT it — `chat.status` is the
    relay's status poll and must never wait on an ssh round trip to a half-dead master), and a client
    asks once per composer open, not on every poll. The Server Edition names an SSH-project node
    remote (`workspaceStore.sshProjectIdForNode`), so it answers built-ins + `partial` there instead of
    reading the server's own `~/.claude`. Adopting it in nodeterm mobile is an iOS
    follow-up.
- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events drive a transient `state/agentNodes.ts` store. For Claude they come from
  **Claude's own `SubagentStart`/`SubagentStop` hooks** whenever a session sends them (2026-09,
  see **Claude's native subagent hooks** below); the older reconstruction — `PreToolUse`/
  `PostToolUse` on tool `Agent`/`Task` correlated by `tool_use_id`, whose PostToolUse on an async
  launch is only an ack (`status:'async_launched'`), with the real end sniffed from the
  `<task-notification>` queued into the parent transcript (context tails → synthetic
  `subagent-end` in both shells) — is kept as the FALLBACK and as the source of the task label.
  Neither the notification's `UserPromptSubmit` nor the `[Subagent hand-back]` one is a `newTurn`,
  so neither clears the fan-out. Canvas renders each subagent
  as an **ephemeral** `SubagentNode` (display-only card: type + task + working/done) connected by
  an **edge** to its parent agent node. These ephemeral nodes/edges live outside the React Flow
  `nodes` state (merged only at the `<ReactFlow>` prop), so they're never persisted
  (`flowToNodeStates`) nor in undo/dirty. **Two different clears, and the difference is
  load-bearing (issue #547):** the removal paths (node delete, project delete, the cross-project
  close, the orphan-session kill, `SessionEnd`) call `clearForParent`, which drops everything —
  a node that is gone has no work left to represent. A **new turn** calls
  `clearFinishedForParent`, which drops only `state === 'done'`. "The previous fan-out is stale by
  definition" is true of a finished card and false of a working one: Claude launches subagents
  **async**, so *"waiting for N background agents to finish"* is exactly the state in which the
  next prompt gets typed, and nothing rehydrates `byId` afterwards (`start()` fires only from a
  live launch event; a running subagent emits no second one) — the card was gone for the rest of
  the run while the agent kept working. The expensive half is not the missing card: Eco's
  hibernation guard derives `liveSubagents` from this same store, so the wipe let a parent with
  live background agents read as idle and get its CLI `/exit`ed. Keeping an unfinished card then
  **owes a decay** — `useAgentNodes.sweepStaleWorking`, on the same 60 s tick and the same
  `WORKING_STALE_MS` as `agentStatus`'s (imported, never re-chosen: `shared/agents/stale.ts` exists
  because three surfaces each invented their own timeout) — or a subagent whose end never arrives
  pins its card, and its parent, forever. It marks the card **done** rather than deleting it, so a
  late `finish()` is the no-op it already was and the next turn boundary takes it.
  **A third removal path is opt-in:** `settings.autoHideFinishedSubagentCards` (default OFF, and
  off reproduces the two paths above exactly) mirrors into the store as `autoHideFinished`, and
  with it on a card is dropped the moment its subagent REPORTS done, with no turn boundary. Only a
  DONE card is ever dropped, so #547's rule (a new turn keeps the cards of subagents still running)
  and Eco's `liveSubagents` are untouched. **The decay is deliberately NOT one of the paths it
  gates**: `sweepStaleWorking` fires precisely because the end never ARRIVED, which is the opposite
  of what the setting promises, and it is the one case where a visible card carries the most
  information — drop it and a fan-out whose subagents died silently leaves nothing on the canvas
  saying one was ever launched. It costs Eco nothing either way, since an absent card and a `done`
  card are the same answer to `liveSubagents`. Renderer only: Desktop and Server Edition identical,
  Mobile N/A.
  (Subagents share the parent's process — no PTY.) Each card shows
  duration/tokens/tool-uses and **expands** (click) to a **live transcript**:
  `core/subagent-tail.ts` tails the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl` — for a native card at the path DERIVED from the
  parent's transcript and the `agent_id`, `claudeSubagentTranscriptPath`; for a tool-path card
  matched by `tool_use_id` via the sibling `.meta.json`), read-only, formats each line (assistant
  text + tool calls + results), and streams chunks over `agent:subagent-activity` into the store.
  **Claude's native subagent hooks** (2026-09; `CLAUDE_HOOK_EVENTS` subscribes `SubagentStart` +
  `SubagentStop` for every installer — local, managed account dirs, SSH host). MEASURED on Claude
  Code **2.1.284** in a throwaway `CLAUDE_CONFIG_DIR` (nine scenarios, print mode and the
  interactive TUI; fixture `src/shared/agents/__fixtures__/claude/subagent-hook-payloads.json`,
  pinned by `normalize.claude.subagent-capture.test.ts`); the published npm bundles date them:
  `SubagentStop` gained `agent_id` + `agent_transcript_path` in **2.0.42**, `SubagentStart` first
  ships in **2.0.43**. Facts a refactor must not lose:
  **(1)** both events carry the PARENT's `session_id` and `transcript_path` (unlike grok, whose
  stop carries the child's), and `agent_id` (`a` + 16 hex, validated as a token by
  `isClaudeAgentId` because it becomes a card key and a file name) is the one id they share. The
  start names the child ONLY by `agent_id` + `agent_type` — no `tool_use_id`, no task text; the
  stop adds `last_assistant_message` + `agent_transcript_path`. **(2)** `SubagentStop` is the end
  of the child's TURN and arrives before the `<task-notification>`, sync or async — but a
  background child that stops while its OWN child still runs is **resumed under the same
  `agent_id`** (a second start, then a second stop): a native stop does not always mean
  "finished". **(3)** Claude fires `SubagentStop` for **internal side-agents** (prompt
  suggestions — after nearly every interactive turn) with `agent_type: ""` and **no start**. **(4)**
  a **killed** child (interrupt) fires **no** stop. **(5)** nested children fire both events
  through the same subscription and connect flat to the owning node; the tool path never saw them
  (their `PreToolUse` carries `agent_id` and is filtered), so native hooks are the first time a
  nested subagent gets a card at all. **(6)** `Stop` (and `SubagentStop`) carry
  `background_tasks` — every running BACKGROUND task of the session (async subagents incl.
  nested ones, background shells), never a foreground subagent; on `SubagentStop` the finishing
  child still lists itself, so only the parent `Stop`'s copy is read (`liveBackgroundTaskIds`,
  closed set of finished statuses, anything else counts as running). Absent through 2.1.112,
  present by 2.1.266 (not bisected — feature-detected per payload). **(7)** in interactive auto
  mode every `PreToolUse(Agent)` of a message fires FIRST, then the children start within 5 ms of
  each other (the permission classifier sits between; 20 ms gap in print mode, up to ~5 s
  interactive), each followed ~1 ms later by its async ack whose `tool_response.agentId` names the
  exact child. **(8)** the child's `SubagentHandback` tool injects `<agent-message from="…">
  [Subagent hand-back] …` into the parent before the task-notification — not a genuine turn
  (`isInjectedSubagentPrompt`, matched on the whole marker).
  **How the two paths coexist** — ONE core module, `core/claude-subagent-lifecycle.ts`, fed every
  normalized event (and the task-notification end) by BOTH shells before any consumer; events it
  does not act on come back as the same object. Latch per node+session on the first native
  start: before it a tool call draws its card immediately (an old CLI, or a session whose hook
  snapshot predates the upgrade, is byte-for-byte the old stream — pinned over the fixtures with
  the native events stripped); after it a tool call is only a pending LABEL and the card appears
  at the child's own `SubagentStart` (so a denied tool call draws nothing). The session's first
  child is drawn from its tool call and then REPLACED by its native card (`supersedes` — the
  renderer store, the host replay and the notch HUD move the card; nothing can know at the tool
  call that a native start is coming). Native cards are keyed by `agent_id`, so start/stop/resume
  follow the CLI exactly; only the label is paired, first-in-first-out by type, corrected exactly
  by the ack (also when the ack overtakes its start — and a call an ack already named is never
  handed to another child), and for a SYNC child by its end (`tool_response.agentId`), which
  takes its call out of the queue and relabels a still-running sibling that guessed it. Every
  turn-end `Stop`/`StopFailure` (never the `idle` rescue — an Agent call may be waiting on a
  permission prompt) clears the queue of calls whose child never started, with or WITHOUT an
  inventory: 2.0.43 had native hooks long before `background_tasks`, and a denied call's label
  must not go to the next child. A native stop for an id that never started is dropped
  (side-agents); a later start of a known id re-opens its card; the parent `Stop` inventory, when
  present, ends a native card it no longer lists (the killed child); a tool card whose child
  never started is ended at the turn end; a replaced tool card also gets a plain end AFTER the
  replacing start (for a consumer too old for `supersedes`); tool-path ends are re-keyed onto the
  native card (idempotent, and they bring the sync stats the native stop lacks — a late
  stats-bearing `finish()` fills them on a done card). Tails: the native start begins the child's tail in the RAW listener, which must run
  BEFORE the `ignoreQuestionHook` child-event gate (it ignores every `agent_id`-tagged payload);
  the lifecycle's `onRelease` ends it (local + remote); a resumed child continues from its
  remembered offset (`subagent-tail` / `remote-subagent-tail`) instead of re-streaming; a remote
  child is tailed at its derived host path with no `.meta.json` ssh polling. **Eco**: because a
  native stop can be a pause (fact 2), the parent `Stop`'s non-empty inventory stamps
  `backgroundTaskAt` (Canvas), the guard Eco and the bulk restart already read — a strictly safer
  rule than before (it also covers a background shell a subagent launched). Both shells pinned by
  `hook-verified-parity.test.ts`; the Server Edition also behaviorally over the fixture
  (`server/agent-status.test.ts`). Cost: one extra managed-hook process + POST per interactive turn
  (the side-agent stop). Residuals, stated: a SYNC child has no ack, so while it runs a reordered
  same-type burst can show a sibling's LABEL (never lifecycle) until the first of them ends; a
  killed child with no later parent `Stop` inventory still waits for the decay. **Device checklist** (not runnable
  here): (a) macOS + Windows canvas, interactive: cards at start, right labels, live activity,
  done at stop, nested card, resumed card re-opens; (b) SSH node: native tail over the
  ControlMaster at the derived path; (c) a session started BEFORE the upgrade (old hook snapshot —
  whether Claude reloads hooks mid-session is unmeasured): no double and no missing cards; (d) Eco
  with a background subagent paused on its own background shell: not hibernated, bulk restart
  skips it; (e) a managed-account node gets native cards (installer writes the account dir); (f)
  Windows: the derived path keeps the reported separator; (g) a pre-2.0.43 CLI tolerates the two
  new keys in settings.json (same class as `StopFailure`, which already shipped); (h) the
  hand-back turn (a background child reporting back wakes the parent for a turn, then the
  `<task-notification>` wakes it again) may chime "finished" twice — #708's quiet rule is per
  turn.
  **Codex** (2026-08-24, `spawn_agent` collaboration — issue #401) joined via its **native
  `SubagentStart`/`SubagentStop` hooks**, measured on codex-cli 0.146.0, keyed by `agent_id` (NOT
  `tool_use_id` — nothing correlates the spawn tool call with the Start it launches; agent_id is
  stable across the child's life, parallel + nested spawns included, and nested children fire
  through the same subscription so every card connects flat to the owning terminal node). Facts a
  refactor must not lose: **(1)** every agent_id-tagged codex event carries the PARENT's
  `session_id` with the CHILD's rollout as `transcript_path` — both raw listeners skip the
  context-meter track for them (else the parent's meter re-points at the child) and `normalizeCodex`
  returns null for child tool events (else a child Bash event flips a finished parent back to
  RUNNING after an async spawn); pinned by `hook-verified-parity.test.ts`. **(2)** the spawn task
  text is **encrypted end-to-end** (`tool_input.message` and the NEW_TASK payload are Fernet blobs)
  — there is no `taskLabel`; the readable `Task name:` header reaches the card via the activity
  stream instead. **(3)** the live tail is `subagentTail.trackFile` (the path is handed to us —
  no meta-dir matching) with the **stateful, per-entry** `createCodexSubagentFormatter`
  (`core/codex-subagent-format.ts`): a spawn child is a FORK of the parent thread, so its rollout
  opens with a replay of the parent's context, suppressed until the
  `inter_agent_communication_metadata` / NEW_TASK gate — per entry, because two concurrent
  subagents sharing one closure would gate each other. **(4)** codex's `SubagentStop` IS the real
  end (no async-launch-ack trap, no task-notification sniffing), carrying
  `last_assistant_message` as the card's result. Remote (SSH) codex nodes get cards but no live
  activity yet (the child rollout is on the host; claude's `remote-subagent-tail` has no codex
  counterpart — follow-up).
  **Grok** (2026-09) joined via its own native `SubagentStart`/`SubagentStop`, measured on
  grok 1.0.13 by launching two `explore` children in parallel. Keyed by `subagentId` occupying
  the same `toolUseId` slot the store already uses (claude by `agent_id` natively, else
  `tool_use_id`; codex by `agent_id`; grok has no tool call behind a subagent). Facts a refactor must not
  lose: **(1)** the start's `sessionId` is the PARENT's and the stop's is the CHILD's own
  (equal to `subagentId`) — keying on it files start and stop under different cards and the
  started one never closes. **(2)** the child's transcript is DERIVED from `subagentId` as
  `chat_history.jsonl` (`core/grok-subagent-format.ts`); the start's `transcriptPath` is the
  PARENT's, and even the stop names `updates.jsonl`, which parses to nothing. **(3)** a
  `session_end` bearing `subagentType` returns early in both raw listeners — without that a
  child finishing tears down the PARENT's session state. **(4)** `description` arrives only
  on the start. The four captured payloads live in
  `src/shared/agents/__fixtures__/grok/hook-payloads.json`, pinned by
  `normalize.grok.capture.test.ts`. Remote (SSH) grok nodes get cards from the hook but no
  live tail yet (the child dir is on the host; same gap as codex).
- **/loop, /schedule & /cron node** (agents in `RECURRING_CAPABLE`) — detected from the **tools**
  the agent invokes (robust; users often phrase it in natural language so the prompt rarely starts
  with the slash): `PreToolUse` for `Skill` (skill ∈ loop/schedule/cron), `CronCreate` (→ cron,
  label = cron expr · prompt), or `ScheduleWakeup` (→ loop) — plus a `UserPromptSubmit`
  `/loop|/schedule|/cron` prompt-prefix fallback, all surfaced as `recurring` normalized events.
  Sets `agentStatus.loop` ({count, prompt, items, kind}); for in-session `loop` each turn-done
  bumps the count + appends `lastMessage` (schedule/cron run in the background, so they aren't
  counted). Lifetime by kind: `loop` dies with its session; `cron`/`schedule` **outlive turns,
  sessions and app restarts** (`loop` is persisted in the agentStatus localStorage) and are
  cleared by a `CronDelete` `recurring`-end event or the card's own × (dismisses the card only).
  `clearForParent` (new turn) leaves the loop card's dragged position alone. Renders an ephemeral
  **LoopNode** labelled by kind, connected by an edge to the parent, plus a small header badge.
- **Branch conversation** — node action (`IconBranch`, Claude-only via `BRANCH_CAPABLE`): sends `/branch` into the
  existing terminal via `pty.sendText` (tmux `send-keys`) and opens a new Claude node that
  resumes the parked original with `claude --settings … -r <ORIGINAL_ID>`. The original id is
  the session id already known from hooks; `lib/claudeBranch.ts` is the fallback that parses
  `pty.capture` output when the id isn't known. The source node stays on the new branch.
- **Canvas control (manage-nodeterm-canvas)** — agents in `CANVAS_CONTROL_CAPABLE`
  (claude/codex/gemini/copilot/opencode/grok) can create/organize/control canvas nodes from inside their
  session: a POSIX **sh+curl** shim (`nodeterm.sh`, `CONTROL_SHIM_SCRIPT` in
  `main/canvas-control-core.ts` — the Electron-as-Node CLI is retired) POSTs
  **form-urlencoded** (`nodeId` + `arg.<flag>` fields; `curl --data-urlencode` is the only
  escaping sh can be trusted with — `parseControlBody` reads both this and the JSON dialect) to
  the hook server's `/control/<verb>` routes; `Accept: text/plain` makes the server render the
  reply (sh has no JSON parser). Env-gated on `NODETERM_CANVAS_CONTROL` (set by
  `buildPtyEnv`/`remoteHookEnvArgs` per `canControlCanvas`). Discovery (since #744): EVERY
  consented agent gets `skills/manage-nodeterm-canvas/SKILL.md` in its OWN skills dir — claude's
  config dir (+ each local managed/linked account dir), `$CODEX_HOME/skills`, `~/.gemini/skills`,
  `$GROK_HOME/skills`, `$COPILOT_HOME/skills`, opencode's `<config>/skills`; on an SSH host claude's
  dir and `~/.agents/skills` (read by codex, gemini, opencode, grok — measured — and copilot,
  documented). The marker blocks (`<!-- nodeterm:manage-canvas:start/end -->`) in AGENTS.md /
  GEMINI.md / copilot-instructions.md are no longer written and an older build's copy is STRIPPED;
  see **Agent-integration consent** under Agent support.
  **Server creator ownership (2026-08 incident hardening):** enabled Server control accepts only
  verified node identity. `HeadlessNodeFactory` records which source node opened each new node in a
  process-local ledger; link/group/rename/color/sticky-update, message delivery, and close validate
  the whole target set as current-run creations before writing or killing anything. Queued messages
  revalidate creator ownership before flush. The ledger is intentionally empty after restart —
  project JSON, titles, hook history and tmux names are not creator proof — so
  boot neither attaches/creates backends nor sends persisted queued commands. A live backend with a
  durable arm remains untouched until an explicit owner action or browser view. `open-terminal` and
  `open-agent` are verified-only at the Server handler boundary. A plain terminal keeps generic
  node hook wiring but receives neither `NODETERM_AGENT_ID` nor `NODETERM_CANVAS_CONTROL`; missing
  identity never defaults to Claude.
  **SSH projects** (docs/ssh-agent-skills.md): the SAME shim + skill + blocks are put on the
  remote host and KEPT current by the agent-tools check (`RemoteHooks.refreshAgentTools`: on every
  connect and tunnel repair, rewriting only what differs from this build, managed-account skill
  dirs included — see "An SSH host's agent tools are CHECKED" under Agent support; an account's
  skill is also written when the account is added), gated on the VERIFIED reverse hook tunnel — the shim
  carries no machine-specific paths and POSTs through the tunnel's unix socket, so remote agents
  control the desktop's canvas. The shim is generated source no compiler checks:
  `canvas-control-shim.test.ts` runs it for real (/bin/sh against a real hook server, port AND
  unix-socket transports) — keep it that way.
  **NO VERB MAY ACTIVATE A PROJECT TAB** (`src/shared/control-off-screen.ts`). Routing is by
  SOURCE — the request names the agent's own node, and the dispatch must find the canvas that owns
  it — so for years "that canvas is not on screen" was answered by `travelToProject`. The user was
  typing in project B; a background agent in project A issued a `close`; the tab switched and A's
  saved viewport was applied. Their focus, camera and typing context were taken by a call they did
  not make. Two carve-outs (the cold open for `open-*`, then the display verbs) were each written
  as if it were the last, because nothing walked the whole table — twenty-one verbs still
  travelled. Every verb now has a decided disposition and NONE of them is travel:
  `STORE_ANSWERED_VERBS` (no canvas at either end), `COLD_OPENABLE_VERBS` (a session node, armed
  and inert until shown), `OFF_CANVAS_VERBS` (a display node, complete when written),
  `STORED_NODE_VERBS` (`write`/`close`/`rename`/`color`/`link`/`board`/`assign` — each reaches a
  pane, a store writer or the board file — plus the five layout verbs
  `group`/`ungroup`/`move`/`arrange`/`align`), and `OFF_SCREEN_REFUSALS` (the six that genuinely
  need live React Flow, each with its own reason in the refusal the agent reads). A refusal an
  agent can act on is strictly better than hijacking someone's screen. **The layout verbs off
  screen lay out from PERSISTED sizes** (nothing there was measured; a node is born at a persisted
  default size and a user resize is persisted too, so the gap is at most the overlap a live canvas
  can already show) and write back through `commitCtlNodes` → `geometryMutations`
  (`renderer/lib/storedGeometry.ts`): only the geometry that changed (`position`/`size`/`parentId`/
  `group`) is patched onto the STORED node, a created frame is added whole, only a frame is ever
  removed, and the batch lands in one `applyOwnNodeMutations` re-sorted parents-first. Never write
  the hydrated array back whole: that round-trips every node through the serializers. They were
  refusals until 2026-09-30; an orchestrator that could open a team off screen but never frame it
  was the report that moved them. Load-bearing details:
  (1) **`ctlNodes()` is the one name for "the node array this call acts on"** — on screen it is
  `nodesRef.current` verbatim, off canvas it is the owning project's serialized nodes hydrated by
  `nodeStatesToFlow`. A verb body that resolves `--node` against the live array while answering
  for another project does not throw and does not travel; it silently renames, closes or reports
  on whatever the human happens to be looking at. `control-stored-node.source.test.ts` pins that
  no stored-node case mentions `nodesRef.current`. (2) **`board`/`assign` read `ctlProject`, not
  `activeProjectId`** — a second bug that was hiding behind the first, invisible while the travel
  made the two projects the same. (3) **`closeStoredNodes` is the ONE cross-project teardown**,
  shared with the sessions sidebar's `closeSession`; it is `deleteNodes` minus the closed-session
  ledger and ⇧⌘T history, which `deleteNodes` files against the ACTIVE project. `close` still ends
  the session off canvas because `transport.destroy` resolves a REMOTE node's host from the
  persisted index with no live client (`core/remote-end.ts`). (4) **There is no
  `travelToProjectRef` and there must not be one again**; `travelToProject` survives only for the
  facepile, the user's own navigation. (5) **The regression guard is
  `test/acceptance/control-verb-disposition.test.ts`**, cross-layer on purpose: it walks MAIN's
  `VERBS_FOR_TEST` against the RENDERER's disposition, which is the only way "every verb" is a
  checked claim rather than a list kept by hand. That is what nobody had, and why two carve-outs
  could ship without anyone noticing the other twenty verbs.
  **Keep the agent-facing text in sync with behaviour, in the SAME PR.** The verb help agents
  actually read is generated by `buildCanvasSkillBody` (the SKILL.md, rewritten into every config
  dir by `installCanvasSkillInto` on launch) and `buildCanvasControlInstructions` (the
  codex/gemini/copilot/opencode marker block — NOT INSTALLED since #744, its parity tests are what
  keep it; every agent now reads the skill) — both in `canvas-control-core.ts`. When you add or
  rename a verb, change a flag, or change what an outcome MEANS (e.g. PR 7 turned a busy target's
  `targetBusy` refusal into a deliver-on-idle queue), update those two functions in the same change,
  or the docs describe a product that no longer exists and an orchestrating agent acts on the stale
  contract. Derive from the code, never re-type: the retry guidance renders from `RETRYABLE`
  (`messagingGuidanceLines`) so a new outcome kind lands in the text the day it is added, and the
  off-screen paragraph renders from the verb table itself (`offScreenGuidanceLines`, which is why
  that table lives in `src/shared` — core cannot import the renderer) — prefer that shape over
  prose you have to remember to edit. `canvas-control-core.test.ts` walks both
  generated bodies and must red on the stale claim (it pins the queue wording and the RETRYABLE
  split); a doc line with no such test is a plan, not a fact — see the drift that shipped as #269.
  **Flag syntax**: `--flag value`, `--flag=value`, or a valueless flag anywhere on the line. The
  shim used to consume the next token after any `--flag` *unconditionally*, so `--read --node b1`
  became `arg.read=--node` with `b1` silently dropped and the server answering about the wrong
  flag; it now peeks. The trade: a value that itself starts with `--` must use the `=` form
  (`--cmd=--version`), which was previously unexpressible in either direction. Two parsers are in
  play and both are tested — the sh loop (`control-shim-parse.test.ts`, real `sh` + a fake `curl`
  that records argv) and `parseControlBody` reading what it built (`canvas-control-shim.test.ts`).
  **A new verb must still not DEPEND on the fix.** The shim is rewritten locally at every app boot,
  and an SSH host's copy is checked on every connect and brought to this build's bytes, so an app
  update reaches the host on the first connect after the relaunch. A host can still run an older
  loop for a while: while its tunnel is down (nothing is installed through a dead tunnel), when the
  file is unreadable (never written over), or while a second desktop on an older build shares the
  host account (it rewrites its own copy on its connects; ours returns within the hour). Nothing
  on the wire says which loop is running. Give every flag a value and both loops agree.
  **A retried call must not open a second node (`--request-id`, `core/control-request-ledger.ts`).**
  The reply to an open can be lost while the open went through — the agent's own tool call is
  killed (~2 min for a Bash tool call while a slow host holds the POST), the ssh tunnel drops
  mid-reply, or the shim's endpoint walk re-posts after a transport that failed AFTER the request
  was read — and the agent's natural retry used to open a second agent, team or worktree. The
  verbs that create something (`REQUEST_ID_VERBS`) take `--request-id <id>`, and the shim also
  sends its own `requestId` form field, generated once per RUN (`od` of `/dev/urandom`, else
  pid+time), on every POST of that run, so its own re-post is covered for an agent that never read
  the docs. Rules a refactor must not undo: (1) **the ledger lives in the hook server's `/control/`
  route** (core), the one place desktop main's forwarder and the Server Edition's
  `createServerEditionControlHandler` both sit behind — putting it in either shell's handler
  leaves the other without it; (2) rows are keyed **(verified caller node, id)** only — an
  unverified caller gets no dedupe rather than a shared bucket, and an explicit id from one is
  answered with `REQUEST_ID_UNVERIFIED_NOTE`; (3) the row is **claimed before the handler runs**,
  synchronously after the lookup, so two concurrent POSTs cannot both run; (4) a fingerprint (verb
  + args minus the id, key order ignored) makes the same id with a different call a
  `request-id-conflict`; (5) a settled row stores the WHOLE reply and a replay returns it (text:
  a `replayed:` first line; JSON: `replayed: true`) — a refusal included, so an id never runs
  twice; (6) a handler that cannot say whether its effect happened answers `indeterminate: true`
  (desktop main's 120 s wait, now `src/main/control-forward.ts`: the renderer is not cancelled, and
  an `open-worktree` whose `git worktree add` outlives the wait still completes) or throws, and the
  row becomes UNKNOWN — refused, never re-run; the forwarder hands a late renderer answer back via
  the handler's `onLateAnswer`, and settlement only moves up (unknown → answer, never the reverse).
  **A late answer is finished exactly like an on-time one**: everything main does with a renderer
  answer (the `open-browser` ownership claim, `browser-open-claim.ts`; the `open-project` grant) is
  ONE `finishAnswer` step the forwarder runs on whichever answer arrives — replaying a late
  "opened browser b1" without the claim told the agent it had a browser it could never drive. And
  **an indeterminate reply names its id**: the route adds a `request id: <id>` line saying to pass
  it back as `--request-id <id>`, and the in-flight/unknown refusals spell the flag with its value —
  the shim's per-run id is otherwise never seen, so "retry with the same --request-id" sent agents
  to re-run the bare command, get a fresh id and open a second one. That reply is not enough on
  its own: an agent's tool call is typically killed at 120 s — the SAME instant the app gives up —
  so the shim also prints the per-run id to stderr BEFORE posting an open it carries no caller id
  for (`requestIdAnnounceLine`, skipped for a caller's own `--request-id` and for `--dry-run`), and
  both agent bodies say to pass an OWN unique id up front for slow opens (open-worktree,
  spawn-team, verify) with a tool timeout above 120 s. A `finishAnswer` step that throws never
  escapes into the IPC listener: on time it resolves indeterminate, late it hands nothing back (the
  row stays unknown);
  (7) an explicit id on a verb outside the set is REFUSED (`request-id-unsupported`), like
  `--dry-run` — an agent believing its `write` is protected when it is not is the failure the flag
  exists to end — while a malformed or out-of-set per-run id is silently ignored; (8) a dry run
  neither claims nor replays. The ledger is **durable** (24 h, 256 per caller, 4096 in total,
  in-flight rows never evicted), mirrored to `<userData>/orchestration-state/control-requests.json`
  and loaded by `hookServer.start()` in both shells: a retry after an app restart replays the reply,
  a row IN FLIGHT when the process ended comes back UNKNOWN (refused, never re-run), and unknown
  stays unknown — see **Durable orchestration state**. (It used to be process memory, on the theory
  that a restart between the effect and the retry was too rare to pay for; measured, the cost is
  small — below.) The timeout sentence is verb- and claim-aware (`controlTimeoutError`): only a
  confirm-gated verb, whose dialog dismisses itself at the same deadline, is still called "safe to
  retry"; a call with no ledger row (no id, or an unverified caller) is told to check the canvas for
  its effect before retrying, never pointed at a flag it has no value for. Ids suggested to agents
  must be UNIQUE (a uuid — `$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)`, since slim
  Linux lacks `uuidgen` and macOS lacks `/proc` — or a readable name with a random part): rows are per node for 24 h, so a
  later conversation in the same node reusing a readable id for the same call would be answered
  with the earlier reply. An SSH
  host gets the new shim at its first connect after the update (the agent-tools check,
  `RemoteHooks.refreshAgentTools`); until then — or while its tunnel is down — its runs carry no
  per-run id (an explicit `--request-id` still works through the old loop). Agent-facing text
  is rendered from `REQUEST_ID_VERBS` / `REQUEST_ID_RETRYABLE` / `REQUEST_ID_OUTCOME_GLOSS`
  (`requestIdDocLines`). Tests: the ledger alone, the route (both dialects, in flight, conflict,
  late answer, throw), the Server Edition handler behind it, and the real shim under `/bin/sh`
  through a proxy that forwards the request and drops the reply — the re-post case, red before.
  Deliberately NOT in the set: reads (a replay would serve a stale snapshot, and `browser
  --cookies` would sit in memory for a day), the idempotent-by-nature verbs, and the
  human-confirmed / rate-limited ones (`write`, `send`, `settings`, `report-issue`) — widening it
  to those is a separate decision.
  **WHICH CANVAS ANSWERS, and why an open never moves the camera** (`renderer/lib/controlRouting.ts`
  + `renderer/lib/coldOpen.ts`). React Flow holds only the ACTIVE project's nodes, but every other
  open project's tmux sessions keep running, so a control call routinely arrives from a node the
  live canvas has never heard of. `routeControlSource` resolves the OWNING project
  (`active | switch | reopen | blocked | unknown`) — before that, every agent outside the project
  the app happened to come up on was rejected as *"source node is not a control-capable agent"*,
  which is a capability sentence for a routing failure. **That fix must not regress.** What it
  originally did with the answer was TRAVEL there (`travelToProjectRef`), and that was a screen
  hijack: the user looks at project B, an agent in project A runs `open-claude`, the tab switches
  and A's saved viewport is applied, so the camera appears to jump and zoom on a background agent's
  say-so. THREE membership lists now decide, and their differences are the whole design:
  - `STORE_ANSWERED_VERBS` (`needsLiveCanvas` false) = **no canvas is needed at either end** —
    `list` reads names, `send`/`reply` deliver into a tmux PANE, `sticky` rewrites a note,
    `open-project` acts on the projects store.
  - `COLD_OPENABLE_VERBS` (`canColdOpen` — `open-terminal`/`open-claude`/`open-agent`) = **a canvas
    IS needed, but the serialized one will do.** `needsLiveCanvas` stays TRUE for them; they take
    the `--project` cold-open path (issue #338 §2.2) applied to their own project: the composed
    launch MOVES into `pendingLaunch` (`armForColdOpen` — `initialCommand` is never serialized), the
    node is upserted through `applyNodeMutation`, edges go through `appendCanvasLinks` (the edge
    counterpart, so the opener's rope and the fan-in bridge are not lost), `writeDisk` persists, and
    the reply is the ONE shared `coldOpenMessage` sentence with `queued: true`.
  - `OFF_CANVAS_VERBS` (`answersOffCanvas` — `show-image`/`show-video`/`show-web`/`open-browser`)
    = **a canvas is needed, the serialized one will do, and there is nothing to defer.** The node
    these make has no session behind it: a page, a video, an image, a browser node is inert
    wherever it sits, so writing it into the owning project's serialized nodes IS the whole effect
    and it is complete when `writeDisk` returns. That is why it is a third set and not four more
    entries in the second one — a cold open reports `queued: true`, and a caller told its
    screenshot is queued waits for something that already happened. It gets
    `offCanvasReplyClause` and `offCanvas: true` instead. **This was the half the cold-open fix
    left open, and it is the half an agent meets most often**: a skill that renders its report as
    HTML reaches for `show-web` every time it finishes, and every one of those calls used to yank
    the user out of the project they were typing in. The verb bodies are untouched; three things
    they read from the canvas are staged — the colour index (`nodeCount`), the placement source
    (the stored node, hydrated through `nodeStatesToFlow` so its shape cannot drift from a live
    one's) and the append, where `applyNodeMutation` + `appendCanvasLinks` + `writeDisk` replace
    `setNodes` + `connect` + `markDirty`. The opener's edge is a **rope** and only a rope: a
    display node has nothing to read, so a bridge there would grant a context link the live path
    never draws. **`ctlProject` resolves from the SOURCE's project**, not the active one — off
    canvas it decides the ssh flag, the browser session key and the media allowlist route; on
    every other path the travel has already made the two the same project. None of the four takes
    `--group`, which is why this set owes no worktree question; a verb joining it that does would,
    because `cwdForNewNodeIn` subtracts `staleGroupIds`, which is epoch-scoped to the ACTIVE
    project.
  Everything else keeps travelling **on purpose**: `write`/`close`/`group`/`move`/`arrange`/
  `align`/`verify`/`spawn-team`/`open-worktree` read live canvas state the serialized copy does not
  carry (measured node sizes, worktree staleness, the React Flow edge arrays). **`browser` is the
  pair worth stating beside `open-browser`**: it NAVIGATES a mounted `<webview>` guest, which
  exists only while its project is on screen, so it travels; `open-browser` merely places the node
  and its guest is created when that project is next shown, exactly as a cold-opened terminal's PTY
  is. Route `active` is byte-identical to before.
  **The human is told, once, in the other voice.** The reply goes to the agent; without a strip the
  person sees nothing at all, and the whole point of not travelling is that the choice to go and
  look stays theirs — a choice they can only make if they are told there is something to look at.
  `offCanvasNoticeText` names the project and the button is `travelToNode` (which reopens a closed
  project first and resolves off the SERIALIZED nodes the write has already made). It is **sticky**:
  every other info strip reports something the user just did and is watching, this one reports work
  that landed while they were busy elsewhere, and once it fades nothing anywhere says it happened. Route **`reopen` (a CLOSED project) cold-writes
  too and does NOT reopen the tab** — closing is the user's explicit "park this, keep it running", so
  restoring the tab *and* activating it is the loudest form of the hijack; the reply names the closure
  so a caller does not report a session as started. **Exception (#925):** `--run-now` (and `run`)
  restores a closed project's tab WITHOUT activating it (`unhideProject`) and starts the node
  headless. A session that is running must be findable somewhere more durable than a notice, and
  not activating it keeps the half of this rule that matters. Two cases keep the tab closed: an SSH
  project, because its nodes are refused before any claim (`remote-unsupported`), so nothing starts;
  and the welcome screen (no project active), because un-closing one there would render a canvas
  with no active project. On the welcome screen the session still starts; the project just stays in
  Recently closed.
  On the cold path `--group`/`--after` ARE resolved
  (unlike with `--project`, where the ids would live in another project) against the serialized
  nodes, defaults come from the OWNING project (`projectPermissionMode(owner, …)`, its account,
  its `ssh`), and `--after`'s dep ropes are left to `missingDepRopes` at that project's next load.
  **The destructive confirm, and who may waive it** (`@shared/control-confirm`, 2026-09). The
  dialog `write` / `close` / `open-project` raise is the ONLY place a human stands between a
  canvas-control agent and the workspace — per-node identity is not enforced until
  `NODE_IDENTITY_STRICT_AFTER`, so a `legacy` caller still reaches the dispatch — and it used to
  ask EVERY time with no way to say "yes, all of them". Closing 14 finished stations was 14
  dialogs, and the 15th request was refused with `a confirmation is already pending`. Three things
  changed, and the last one was the actual bug:
  - **`close --node a,b,c` is ONE dialog** (`lib/closeTargets.ts`, pure). The grammar is not new —
    the Server Edition's headless `close` has read a comma list since it shipped, including its
    "validate the whole list before killing anything" rule; the DESKTOP dispatch read the flag as
    one id, so a comma list called `deleteNodes(['a,b,c'])` (a no-op) and answered `closed a,b,c`.
    A destructive verb reporting success for work it did not do is worse than either doing or
    refusing it. The single-id form is bit-identical, **deliberately including its lack of an
    existence check**; the bulk form refuses the WHOLE list on an unknown id and names it, because
    with 14 ids the user cannot audit the list themselves. Capped at `CLOSE_BULK_MAX` (50) and the
    dialog spells out at most 12 names then counts the rest — a name the user cannot see is not
    consent.
  - **"Don't ask again" is bounded by SCOPE, not by permanence** (2026-09, revised 2026-10). The
    dialog offers three RADIOS, visible from the start (`waiveChoices`): **"ask me again next
    time"** (pre-selected, and not a waiver — an untouched dialog grants nothing), **"don't ask
    again for agents in <project name>"**, persisted in `settings.controlConfirmWaivers.projects` as
    `{ [projectId]: verbs }`, or **"don't ask again in any project until nodeterm quits"** — the
    transient `state/controlConfirm.ts`, memory only (not `settings.json`, not `localStorage`), per
    VERB in every project, so quitting restores the gate. It used to be a checkbox whose two reaches
    appeared only once ticked, defaulting to the app-run one: the per-project answer was invisible
    until the user had already said yes, and the 2026-10 report read it as missing. The labels say
    what each reach covers because the two are different shapes — "until nodeterm quits" must not
    sit under a project name, since the app-run waiver has no project bound. The machine-WIDE
    `always` is still reachable only from Settings → Agents, where the option says "permanently":
    a dialog that appeared under the user's hands must not switch a destructive gate off
    *everywhere* on one stray click. The per-project scope is what makes the offer honest — an
    app-run waiver is not what a user who ticks "don't ask again" means, and with only that and a
    machine-wide switch the real choices were "be asked forever" or "turn it off everywhere".
    Load-bearing details: (1) the waiver is keyed on the project the call **acts on**
    (`ctlProject`), not the active one — canvas control answers a background agent in its own
    project without moving the user's tab (@shared/control-off-screen), so reading the project on
    screen would grant, or honour, a waiver in the wrong repo; the same argument applies to the
    permission MODE the bypass lock weighs, which is why `controlConfirmDecision` takes a project
    id and resolves both from it. (2) It is **machine-local** — never `.nodeterm/project.json`,
    which is git-shared; the whole trap `bypassMode` needs two locks for. (3) It is **pruned** on
    every write (`pruneControlConfirmWaivers`, the rule `pruneCollapsedItems` states for
    `sidebarCollapsedItems`) against EVERY project including CLOSED ones — a closed project is
    parked, not gone — because settings.json is forever and a stale entry is a live security
    waiver keyed to an id nothing can name. The id being granted survives that prune because the
    merge happens after it, not by an exemption inside it; a safeguard no test can turn red is a
    comment, not a mechanism. (4) Precedence is narrowest-first among the persisted grants
    (session → project → always → bypass), so the notice names the waiver the user most likely
    wants back. (5) A waiver granted by a CANCEL must not exist at all (the grant hangs off
    `onConfirm`, pinned by `control-destructive.test.ts` and
    `control-confirm-scope.source.test.ts`), and a per-project grant that cannot be made (no
    project owns the call) falls back to the app-run waiver rather than silently to nothing.
    Waiving is not silence: every waived application raises the info strip through `waivedNotice`,
    which names the waiver that let it through — and, for the project scope, the PROJECT, since
    "this project" would point at whatever the user happens to be looking at — and every
    per-project waiver is listed with a Revoke in Settings → Agents.
  - **`bypassPermissions` needs TWO locks, and this is the trap to understand before touching it.**
    The permission mode is persisted to `.nodeterm/project.json`, which is **git-shared** — so
    keying the waiver on the mode alone would let a repository the user CLONED silently disable
    their destructive-action gate. It therefore requires a machine-local opt-in
    (`controlConfirmWaivers.bypassMode`, default off) **and** a mode that came from the user's own
    GLOBAL setting: `resolvePermissionModeWithSource` answers `project | global | default`, and
    only `global` can waive. `default` is its own answer rather than folded into `global` because
    nobody chose it, and reading an unset setting as a deliberate choice is reading consent into
    silence. The claude version gate is deliberately NOT applied here (it exists to degrade `auto`
    for an old CLI; a security decision must not hang on a `claude --version` probe).
  - **`settings` can never be waived**, by table (`CONFIRM_WAIVABLE_VERBS`) rather than by a line
    somebody forgot at a call site: a settings change can GRANT a capability, and a CLI that could
    waive its own consent would make the consent decorative.
  - **`open-project` IS waivable (2026-10)** — it was excluded on the claim that it "cannot produce
    the dialog storm — `recordAttachConsent` already dedupes it per (caller, project)". That
    dedupe is keyed on the caller's NODE id, in memory, for one app run: every new orchestrator,
    every station a team spawns and every restart asked again about the same two projects, with no
    box to stop it (the field report: "an orchestrator in another project opens a node, a dialog
    each time"). Waiving it changes only whether the human is asked — main still requires a
    verified, local caller, an absolute existing `--cwd` and the grant cap, still records the
    grant from the reply, and the registration still never focuses a tab. Its waiver is keyed on
    the CALLER's project like `write`/`close` (the open-project block resolves that project
    itself, under the same `ctlProject` name, because it runs before the dispatch computes one);
    the waived and confirmed legs register through ONE `opFinish(opAdopt)`.
  **An agent-requested dialog knows its own request's lifetime** (`ConfirmState.expiresAt` /
  `onExpire`, `CONTROL_REQUEST_TIMEOUT_MS` now shared with main). Main abandons a control request
  after 120 s and tells the renderer NOTHING, so the dialog stayed on screen asking about work
  nobody was waiting for — and, worse, kept `confirmBusy()` true, which refused every later
  `write`/`close` with `a confirmation is already pending — try again` for the rest of the app run.
  **That is the "the same dialog keeps coming back" report**, and it is a single-canvas loop: the
  reply says retryable, the agent retries, every retry is refused by the orphan, and the moment the
  user finally answers it a queued retry raises a fresh dialog for the same node. The deadline is
  measured from the RENDERER's receipt, so it always fires a hair AFTER main gave up, never before
  (the other direction would abandon a dialog whose answer main would still accept); it replies
  `expired` rather than `denied by user` (nobody denied anything, and a reply main has already
  timed out is simply dropped); and the notice is a fading info strip, because raising an alert
  would keep `confirmBusy()` true — i.e. reproduce the bug with better wording.
  **`close-worktree --mode remove`'s dialog expires too** (2026-09-11), through the SAME
  `renderer/lib/useExpiringDialog.ts` the confirm uses — the rule was extracted rather than copied,
  because a second effect beside the first is how one gains a fix the other silently lacks. Three
  differences to keep in mind, all deliberate: it carries **no `onExpire`** (the verb replies
  "removal confirmation shown to the user — they decide" the instant the dialog opens, so nobody is
  waiting on an answer and an `onExpire` would be a reply to a call that finished minutes ago); its
  clear must also release **`removePendingRef`**, the guard covering the async `git.status` gap
  before `removeTarget` exists, which `confirmBusy()` reads directly — dropping the state while
  leaving that ref latched closes the dialog and keeps refusing every later destructive verb, i.e.
  the bug minus the only thing on screen that explained it; and the deadline is set **only when
  `requestedBy` is present**, because a removal the USER opened from the group menu must never
  vanish under them. It reuses `confirmExpiresAt` rather than inventing a second timeout: the fact
  is the same class ("an agent asked and the human is not at the machine"), and this is the most
  dangerous dialog to leave lying around — the one carrying a pre-ticked delete-from-disk choice on
  a worktree the human never asked about.
  **MEASURED, and the answer is no: two canvases cannot raise two dialogs for one request.** The
  suspicion was worth checking because the same project can be open on a desktop and in a Server
  Edition browser at once. Desktop main forwards each request to `getMainWindow()` — one
  BrowserWindow, so at most one dialog exists per request; the Server Edition raises none at all
  (its control is HEADLESS — `HeadlessNodeFactory.close` is gated by verified identity plus
  process-local creator ownership, and the browser bridge's `onAgentControl` is `noopUnsub`); and
  the shim's endpoint failover cannot duplicate a request either, because the control POST carries
  **no `--max-time`**, so a POST waiting on a human eventually gets an HTTP answer and
  `nt_reached()` is true — failover fires only on a dead transport (`000`/empty). If a future change
  gives that curl a timeout, this paragraph stops being true: a confirm-gated verb would then fail
  over mid-wait and a second instance WOULD open a second dialog for the same logical request.
  (The walk's liveness probe IS bounded, and does not break this: it runs only against a FALLBACK
  candidate, only after the primary failed — a dead transport, or a 421 wrong-owner answer, which
  the server gives before dispatch, so no dialog exists — and before any POST to that candidate.)
  **Grouping verbs** (`group` / `ungroup` / `move` / `arrange` / `align`): `group` wraps **sibling**
  objects — nodes or frames — into a new frame in their shared container (a mixed-container set, or
  an ancestor plus its descendant, is refused with that reason); `ungroup --group <id>` dissolves a
  frame, promoting its direct children into the frame's own parent (nodes kept); `move
  --nodes <id,id> [--group <id>]` reparents nodes OR whole frame subtrees INTO a frame (or
  `top`/`none`/omit → out to top level) via `reparentNode` — the ONE way to move a node between
  frames, which `group` won't do; a cycle (a frame into itself or its own descendant) is refused.
  `arrange`/`align` now run in ONE coordinate space: all top-level, OR all children of one frame
  (`commonParentId` decides; a mixed set is refused, not silently subset-arranged — the old
  behavior). When the ids are a frame's children, that frame AND every ancestor frame are re-fitted
  to hug the tidied layout (`fitAncestorChain` — fitting only the one frame left a nested frame
  wider than its parent) — the fix for "grouping keeps scattered positions so the frame is too
  wide". `arrange` fills its slots in the order the ids are LISTED (`arrangeNodes` used to place in
  array order, which discarded every caller's sort). `move` also re-fits the source + destination
  frames. All pure + tested in `state/workspace.test.ts` + `workspace.layout.test.ts`.
  **`arrange --group <frameId> [--layout grid|row|column|lineage] [--cols N]`** names the FRAME
  instead of listing its children: the frame's direct children are laid out and the frame chain is
  re-fitted — `arrangeGroupChildren`, the SAME transform the frame's menu rows run (see
  **Arrange inside a group** under Canvas interaction). The flag gate is the pure
  `arrangeArgsRefusal` (`@shared/arrange-verb`), called in THREE places: `parseControlRequest`
  (Server Edition), desktop main's control handler (which never runs `parseControlRequest` — the
  `--issue` trap; with the gate only in the parser, all three refusals were missing on the desktop
  and the request ran as a grid), and Canvas's `case 'arrange'` as the belt: `--nodes` and
  `--group` together are refused rather than resolved silently, an unknown `--layout` on the
  `--group` form is refused by name, and `--layout lineage` on the `--nodes` form is refused
  instead of being delivered as a grid (any OTHER unknown word there still falls back to `grid`,
  as it always has). What only the canvas knows — no such frame, an empty frame, no lineage among
  the children — is `groupArrangeRefusal`, replied as `arrange: <reason>`; a frame already in
  place answers `ok` with `changed: false` and writes nothing. The agent-facing text for the form
  is `arrangeGroupGuidanceLines`, rendered into BOTH generated bodies from the same layout list the
  gate checks. **Server Edition: refused by name** — `arrange` is not in `SERVER_V1_VERBS` in either
  form (headless control keeps no measured node sizes), so `--group` gets the same permanent
  `control-unsupported-on-this-edition` reply and is never dropped on the way to an `ok`
  (`control-unsupported.test.ts` pins it). Off screen it works like the `--nodes` form: the
  stored nodes are laid out and written back through `commitCtlNodes`, and the lineage ropes are
  the OWNING project's (`offCanvas.project.ropes`, re-marked with `markLegacyWaitRopes` exactly as a
  load would — a project that has not been opened since waits were marked still holds unmarked
  ones), never the live canvas's. The rope **id** rides along on both paths: it is the only thing
  that tells a wait from an opener, and stripping it (as the first revision did) makes every wait
  read as an opener. **`arrange --group top [--layout tidy|lineage]`** (2026-10, issue #1114 — an
  orchestrator asked for a programmatic Tidy) names the canvas's TOP LEVEL with the same words
  `move` reads (`top`/`none`/`ungrouped`, `isTopLevelGroupArg`) and runs the user's own **Tidy
  canvas** (`tidyCanvas`, default) or its bands (`arrangeByLineage`) — the same transforms as the
  pane menu, nothing re-implemented. `grid`/`row`/`column` are refused there by name: `--nodes`
  already says them, and a top-level grid that ignores lineage is what Tidy no longer is. Same
  Server Edition refusal, same off-screen path.
  **Fan-in (`link`, 2026-07):** a spawned fan-out was previously write-only — nodes an agent
  opened were joined to it by a **rope** (`project.ropes`, explicitly *"Display-only — never
  context links"*), so an orchestrator could not read back what its own team produced and the
  skill told it to have the USER relay results. Now `open-claude`/`open-agent`/`spawn-team` also
  draw a real **context bridge** (`project.bridges`) to each agent session they open, and the
  `link --to <id,id> [--from <id>]` verb links nodes the agent did not open (or two other nodes).
  The rope stays — the two edges mean different things (lineage vs readable context) and a
  non-context-capable target still gets only the rope. Deliberately **silent**: the manual
  `onConnect` path pushes a discovery note into both endpoints, but doing that per team member
  would inject a prompt into every session an agent just spawned — the exact intrusion that push
  was reverted for. Links are pull-based, so nothing is lost. The refusal matrix is the pure
  `planBridges` (`renderer/lib/noteLink.ts`, unit-tested); Canvas only wraps it in setState.
  A missing endpoint is only absent from the calling project: report that scope and the
  unsupported cross-project boundary, without probing other projects or exposing their metadata.
  Callers that create and link nodes **in the same tick** must pass their own `lookup` — `setNodes`
  is async, so resolving fresh nodes off `nodesRef` would skip every one as "no such node".
  **Issue-bound opens (`--issue`, 2026-09-28):** `open-agent`/`open-claude --issue <owner/repo#N |
  #N>` binds the new session to a GitHub issue exactly like the board's **Start with agent**. The
  SHAPE is refused by ONE gate, `issueFlagRefusal` (`canvas-control-core.ts`), which desktop MAIN
  runs in its control handler (desktop main does not run `parseControlRequest` at all — do not move
  the gate there alone) and the Server Edition runs inside `parseControlRequest`; any other verb
  carrying `--issue` is refused, not ignored. `#N` is resolved by each shell against the project the
  node OPENS IN (the `--project` target, the cold-open owner, or `ctlProject`) — the repository its
  kanban board syncs with, i.e. the GitHub host controller's answer (configured, else detected) —
  and a project with no GitHub board refuses `#N` and names the full form (`lib/issueFlag.ts`,
  `HeadlessNodeFactoryDeps.issueRepository`). **On the desktop it is resolved ONCE, at the top of
  the control handler (`issuePre`), before any open path snapshots the projects store**: the lookup
  is a host round trip (`git remote`, `gh auth`), and an await inside a path let a tab switch in that
  window write the node into the wrong project. A full `owner/repo#N` asks nobody. The same
  placement puts resolution before every path's dry-run branch. **But not before the gates**:
  `resolveIssueFlagForCall` first runs the renderer's authorization belt — the same
  `resolveProjectTarget` call and source-capability rule the paths apply — and answers a caller
  they would refuse with the path's own refusal, asking nobody (the lookup otherwise ran for a
  refused caller, and its refusal said whether that project had a GitHub board). Main's
  `gateProjectTarget` runs before the renderer as ever; the Server Edition already resolved after
  its identity, source and target gates, now pinned by a test.
  **The open PROMPT is decided in the same place, once, for every open path** (`openPrompt`, via
  `launchPromptFor` in `lib/promptSpill.ts`): the issue reference line composed through
  `issueLaunchPrompt`, then spilled to a file when it is over the typed-line budget (#706), judged
  "local" by the project the node opens in (an SSH project's pane cannot read a file written here),
  which comes from the SAME authorization belt (`issueFlagScope`, exported for this): a caller the
  paths refuse gets no project and no spill. The live open was the only path that spilled; the `--project` and cold opens typed the prompt
  inline, so the docs' "a long `--prompt` is safe on a local project" was false exactly where the
  ~490-byte issue line made it likeliest to bite, and the `--project` path silently DROPPED
  `--prompt-file` (the session started with no brief) and `--model`. A new open path types
  `openPrompt`, never its own prompt — `control-prompt-spill.source.test.ts` pins each path.
  **A spilled prompt is read at LAUNCH, which for a cold open can be weeks away**, so it is not a
  paste: `saveUpload` puts a `LAUNCH_PROMPT_FILE_PREFIX` name under `<userData>/launch-prompts`
  (`@shared/launch-prompt`), owner-only, swept after `LAUNCH_PROMPT_TTL_MS` (30 days) by the next
  spill — under `uploads` the 7-day sweep of the next paste deleted it and `"$(cat '<path>')"`
  started the agent with nothing. And because a cold open can wait longer than ANY TTL, the held
  launch records the file (`pendingLaunch.promptFile`, via `withLaunchBrief` on every arming path)
  and the delivery loop checks it right before typing (`launchBriefPresent`: local projects only,
  a failed check answers "present"); a definite "gone" persists `manualOnly`, raises the
  `brief-missing` delivery state (tooltip names the path, `list` says HELD) and waits for ▶ / `run`,
  which still run it on purpose. The one residue: a refused open may leave a spill file behind
  (the spill is decided before the paths, to keep awaits out of them), swept with the rest.
  `--prompt` replaces the default task after the reference line; `--prompt-file` stays the whole brief. Both
  generated agent bodies render the contract from `issueBindingDocLines` (the example first prompt
  is rendered from `issueLaunchPrompt` itself): move your OWN card with `assign` (In Progress on
  start, In Review on delivery), never close the issue, never Done, `Closes #N` in a PR, and **post
  to GitHub only when the user asked in that session — otherwise end with a proposed comment**.
  nodeterm has no automatic post-to-issue path and must not grow one. `list` marks a bound row
  `issue owner/repo#N`. Server Edition: `open-agent --issue` works under its verified-only,
  creator-owned rules and writes the run history; `assign` is unsupported there (the skill says so).
  **The board's GitHub lane for agents (`issues`, `prs`, 2026-09-30, read-only).** An orchestrator could
  start work on an issue (`--issue`) and wait on a PR (`--after-pr`) but not SEE the lane: `board` lists
  session cards only (measured: 21 session cards, zero issue/PR cards), so agents fell back to
  `gh issue list` / `gh pr checks`, which spend the account's budget outside the coordinator and cannot
  say which column an issue sits in, which session is bound to it, whether dispatch queued it, or what CI
  snapshot the board already holds. `issues [--state open|closed|all] [--label L] [--column <id|title|
  ungrouped>] [--limit N]` and `prs [--state open|merged|closed|all] [--limit N]` (default open, 30 rows,
  max 100, newest-updated first; both take `--project`) answer that. ONE module, `core/github/control-
  read.ts`, called by desktop main (after the `--project` grant gate, before any forward) and by the
  Server Edition's control handler (own project only — it keeps no grant ledger). Rules a refactor must
  not undo:
  - **Zero GitHub requests.** The read is `GitHubIssueService.controlSnapshot`: the issue cache plus the
    pull tracker's memory, through `projectContextForCache` — no credential resolve, no heartbeat, no
    poll (`service.pulls.test.ts` counts the client's calls and the credential chain, before and after a
    fetch). No snapshot yet, an unapproved repository and a board with no GitHub connection are each a
    NAMED refusal (`issues-no-snapshot`, `-not-approved`, `-no-github-board`), never "0 issues". An
    agent's read deliberately does NOT start a fetch: a repository's first fetch is a full paged harvest,
    and spending that is the person's call (opening the board), not a background agent's.
  - **An unapproved column mapping is not a fact.** The label → column mapping arrives through the
    git-shared project file; while this machine has not approved its digest (`mappingApproved` false)
    the board is read-only with "approve the column labels", and `issues` likewise shows NO `column:`,
    says so in its header, and refuses `--column` (`issues-mapping-not-approved`).
  - **One workspace load per call.** The host's cache context carries the `Project` it resolved
    (`GitHubIssueProjectContext.project`, in-process only) and `controlSnapshot` returns it; a second
    `githubProject` load per call re-fired the store's persist hooks for an agent polling `prs`.
  - **A harvested merge/close wins over an open status read**, which may be stale; the status read
    stays authoritative about draft vs open.
  - **The board's semantics, imported.** CI is `GitHubPullStatus.ci` (`pullStatusFrom`: a null rollup
    is "no checks", never passed; only the CURRENT head counts), merge `ready` only from CLEAN, a failed
    status read says STALE (`pullStatusFreshness`), merged/closed PRs carry no CI. PR ↔ session card is
    `pullsForCard` — MOVED to `@shared/pull-card-links` (the renderer's `lib/pullLinks.ts` re-exports it)
    with the nearest-bound-branch walk (`nearestBoundBranch`, which `worktreeBranchOf` now calls), so
    the card and the verb cannot link differently: worktree branch (never a fork, never on an SSH
    project) or the issue the session was started on, tombstones honoured. Bound sessions are terminal
    nodes whose `issueRef` names this repository, with the mirror's live state (`queued` for a held
    launch, `unknown` otherwise).
  - **Untrusted text.** Titles, labels, logins, branch names — and node ids and column ids, which come from
    the git-shared project file whose load checks only that they are strings — pass `untrustedLine` (one line, `\p{Cf}`
    bidi/zero-width stripped, capped); the reply's first line is `UNTRUSTED_TEXT_NOTE`; issue bodies and
    comments are never included (the agent reads them with `gh`, as the `--issue` prompt says).
  - **Dispatch state is the renderer's**, so the renderer REPORTS it: `boardDispatch.report` (display
    only, replaced whole on change, `@shared/board-dispatch-report`) into `core/board-dispatch-report.ts`,
    kept per sender and read only for senders still in `clientIds()` (a closed tab leaves no stale
    "queued"), owner clients only, the channel host-only (a relay tab's stub is inert). Desktop and
    Server Edition both register it.
  - Verified-only (`requiresVerified`, refusal `GitHub lane read refused.`, and desktop main checks
    `verified` again as a second guard, like open-project) — the project is resolved
    from the caller's node, so a forgeable caller could read any project's lane; `STORE_ANSWERED_VERBS`
    (a read needs no canvas, and polling `prs` must never travel the user's view); not a request-id
    verb. Both agent bodies render `githubReadDocLines` from the module's constants, including the loop
    (`issues` → `open-agent --issue #N` → `prs` / `--after-pr`) and "GitHub writes stay with the person".
    Relay peers cannot call these (their control belongs to the host). **Mobile: N/A** — the phone issues no
    control verbs.

  **Dependency edges (`--after`, 2026-07):** `open-terminal`/`open-claude`/`open-agent` accept
  `--after <id,id>`, which opens the node **armed** — `data.pendingLaunch` ({after, command},
  `PendingLaunch` in shared/types) holds the launch the factory built, and Canvas fires it once
  every dep reports `done`. This is what makes the canvas a DAG instead of a fan-out.
  **`pendingLaunch` is a MACHINE-LOCAL exec field, like `shell`** (@shared/node-exec): its `command`
  is typed into a shell once the wait is over, and `after: []` or a vanished dep counts as over, so
  a value that arrives from outside would run a command nobody here armed. It is persisted in
  workspace.json's `IndexEntryV3.localExec` (every ref kind: folder, SSH, local-data), NEVER in
  `.nodeterm/project.json` or an SSH mirror (`stripSharedNodeExec`), and a file that carries one is
  ignored on read — the one-time legacy hoist deliberately does not adopt it either (provenance
  cannot be told apart, so an armed node written by an older build loses its held launch on
  upgrade). On `canvas:mut` a peer's value is stripped and OUR value carried across its upserts
  (`carryLocalNodeExec`); the reflector forwards one only between OWNER clients
  (`CorePlatform.isOwnerClient`: the app window, a cookie-authenticated Server Edition tab — never a
  relay peer), stamped `origin: 'core'`, which a client cannot supply and a relay tab ignores. That
  owner→owner leg is load-bearing: it is how two Server Edition tabs agree a launch was claimed, and
  how a headless delivery's clear reaches the browser, so nothing types it twice. Our OWN writes
  into a background project go through `applyOwnNodeMutation` (unstripped — a cold open keeps its
  launch, a patch to `undefined` clears it); `applyNodeMutation` is the peer path (the one reducer,
  `applyCanvasOp`). On a Server Edition that governs a shared project, the canvas authority hears
  every op WITHOUT its launch and a save's exec carry is what writes it (see **Shared canvas
  authority**). Load-bearing
  details: (1) **an unknown agent state is NOT "satisfied"** — right after a fan-out no upstream has
  emitted a hook event yet, and reading "no news" as "finished" would fire every dependent
  instantly; a **deleted** dep IS satisfied (it can never report); and a dep that is `done` with a
  live **`lastTurnError`** is NOT (issue #521, below). (2) Only `hasHooks` agents may be
  waited on — a plain terminal never reports done, so `resolveAfter` **refuses** it rather than
  letting `launchesToFire` (which cannot tell "never will" from "not yet") hang the node forever.
  (3) **Control opens always retain the command in `pendingLaunch` until delivery lands**
  (#827/#811). Even a visible node with no deps has not mounted its PTY when the open reply is
  sent. `queueControlLaunch` moves the command out of `initialCommand`; the PTY-ready gate below
  makes this safe. The open reply says `queued`, and project serialization retains the brief.
  (4) Desktop automatic and manual launch delivery share `terminal/launch-command.ts`, which
  uses `deliverCommand`: echo verification, bounded Ctrl-U repair, platform kill-line and overlong
  line refusal. The PTY-lifetime writer coalesces concurrent requests and remembers submission
  across parked views. Relay queued/restored delivery, including Run now, is refused until a scoped durable
  claim API exists: a relay workspace load can be project-scoped, while save replaces the host
  index. Never use that load/save pair for a launch. A new relay UI initialCommand may instead
  use the verified writer once on a fresh PTY without creating pendingLaunch or writing workspace
  data. Its transient claim is consumed before settle and survives view remounts; relay snapshots
  omit that initial command rather than converting it to durable intent. A parked-project deferral before any input
  retains never-attempted intent and can proceed on activation without a retry timer.
  New intent has `attempted:false`; the writer awaits a workspace save of
  `attempted:true, manualOnly:true` before input, then rechecks the shell after that save. That
  save is **`localOnly`** (`WorkspaceStore.save`): durable in this machine's index, with no SSH
  read/reconcile/mirror — a changed entry is marked `unmirrored` and the next ordinary save pushes
  it. Awaiting the mirror put two SSH round trips in front of every new agent on an SSH project.
  A node's own first-open delivery (live `initialCommand`, no deps, no failure record) shows NO
  QUEUED chip: its `pendingLaunch` is only the write-ahead record, and it carries `manualOnly`
  from the claim until Enter lands, which painted "⚠ QUEUED" on every freshly opened agent. A warm
  attach may automatically deliver never-attempted intent, preserving long-running `--after`
  graphs through project switches/park expiry. Attempted/legacy-unknown intent stays manual: its
  clearing autosave may have been lost after Enter. Explicit Run now rechecks the foreground shell and
  clears any incomplete line; a refused/throwing/cancelled launch stays held, `manualOnly`.
  The Server Edition's immediate open and its `run`, and the desktop's headless start (`--run-now` /
  `run`, below), deliver through the SAME echo-verified writer (`@shared/command-delivery`, moved
  out of the renderer for this), via the headless launcher `core/headless-launch.ts` (#925): a tmux
  paste is not immune to zsh's rc-time tty flush (#556) or the canonical-line cap (#706). The
  Server Edition's deferred `--after` release (`refreshArmed`) still pastes with `sendText`.
  (5) UI `initialCommand` stays until submission; serialization converts unsubmitted UI intent
  into a never-attempted `pendingLaunch`, including a project switch during shell settle. A live
  initialCommand alias on remount cannot reset an attempted marker. Server saves
  `attempted:true, manualOnly:true` BEFORE sending and only clears the command after acknowledgment. Failed
  independent/dependent launches are never retried by unrelated hooks. Boot remains inert.
  Server deferred delivery is deliberately one-shot: a transient probe/send failure needs Run now.
  Desktop keeps the attached echo-verification transport even for offscreen held nodes; a large
  long-waiting fan-out therefore keeps those xterm instances in memory until delivery/recovery.
  (6) Canvas subscribes to `armedDepSig`, NOT `useAgentStatus(s => s.byId)` —
  the same discipline as `loopSig`; the full map re-renders the canvas on every hook event.
  Pure logic + refusal matrix in `renderer/lib/pendingLaunch.ts` (unit-tested);
  the dep→node edge is a **rope** (`ctrl-after-<dep>-<node>` — `waitRopeId`, marked so it can
  never be mistaken for the opener's `ctrl-<source>-<node>` once the canvas prunes that one; ropes
  saved before the mark are re-marked by append order at load, `markLegacyWaitRopes` — persisted in
  `project.ropes` like the opener's) whose LOOK is derived: dashed + ⏳ while the node's `pendingLaunch.after` still lists the
  dep, solid once it has launched (`lib/edgeModel.ts` `ropeVisual`, over the ONE `ropeInfoOf` lookup
  the render and BOTH delete paths ask — two builders would be two answers, and the label the user
  reads would stop describing what the delete does). The fan-in bridge `--after` also writes hides
  under that rope (`hiddenLinkIds`), so ONE edge per pair holds on the canvas. Deleting a WAITING
  rope drops that dep from `after` (`dropAfterDep`) and takes **nothing else** — the covered bridge
  survives, because "stop waiting for it" is not "stop being able to read its work"; an emptied
  list fires. Only the `open-*`/`verify` verbs write the rope, so `missingDepRopes` heals an armed
  node that has none at **project load**: `pendingLaunch` is persisted (machine-locally) and the rope is not, so a node
  armed by any other path — or by a build older than this one — would otherwise hold a launch with
  no arrow saying what for. All edges route through the single `floating` edge type
  (`canvas/FloatingEdge.tsx`, a bezier between the MIDPOINTS of the two nodes' facing sides — one
  anchor per side, so a hub's arrows converge instead of fanning along its border; context and note
  links are restricted to the left/right sides, where the bridge handles sit; an unmeasured node
  draws nothing rather than a path to the origin) — no family sets a handle side;
  and a node whose eye is closed (`hideFanout`) hides every edge touching it as well as its cards
  (2026-09-02 edge model, spec in docs/superpowers/specs).
  **(7) Delivery waits for the node's PTY, and never fails silently** (issue #569 item 1, 2026-09).
  A satisfied dependency says nothing about whether there is a terminal to type into, and the
  original loop conflated the two: a flat 5 × 400 ms budget started when the CANVAS held the node
  and was spent on loading the canvas, mounting it and spawning tmux — so on a cold project switch
  the launch was abandoned before its session existed, in a `console.warn`, and the node read
  QUEUED forever with only the manual ▶ left. `TerminalNode` therefore publishes a **session-ready**
  signal (`isSessionReady` / `subscribeSessionReady`, module-level like `offscreenNodes`): true for
  an ADOPTED park (already typeable, and its create continuation ran on a previous mount) and, for
  a fresh spawn, at the SAME `whenShellSettled` moment `writeWhenShellReady` delivers an
  `initialCommand` — both write a CLI command line, and a line delivered across zsh's rc-file tty
  flush comes out mangled. A **park keeps the writer and transport**; a real teardown removes
  the writer. The loop WAITS instead of burning attempts before readiness. Once attempted,
  only the verified writer's bounded echo repair runs; further recovery is explicit.
  Because a wait with no end is the failure mode this replaces, both give-up states are **visible**
  in the transient `state/launchDelivery.ts` and rendered by the QUEUED badge's amber ⚠ + tooltip
  (`launchTooltip`, pure): `stalled` = gate open, no terminal yet, **still held** (raised by a
  `LAUNCH_STALL_MS` timer with a fire-time re-ask; the launch still fires whenever the session
  finally comes up) and `failed` = submission is unconfirmed, so automatic retry is stopped.
  A persisted `manualOnly` record carries that warning after reload too. Neither is ever inferred from silence, and
  the tooltip names no cause it did not measure (the node's own overlay owns the diagnosis).
  The open verbs' replies carry the same fact for callers OUTSIDE the app: `result.queued` +
  `result.queuedIds` on `open-terminal`/`open-claude`/`open-agent`, always true for the
  `--project` cold-open branch — an orchestrator was previously told "opened" either way and
  routed work to a session that did not exist. Agent-facing copy is generated in
  `canvas-control-core.ts` and pinned in its test, per the sync rule above.
  `queued:false` is NOT proof of a running CLI: Server's `deliveredIds` acknowledges terminal
  delivery only. Its initial commands are persisted before attach/send and retained on failure;
  only acknowledged sends clear them. Boot ownership remains fail-closed. Desktop `list` (live
  and stored projects) names QUEUED / STARTING / LAUNCH FAILED / DROPPED / AGENT STATUS UNCONFIRMED, and every other agent row its state (WORKING / IDLE / NEEDS YOU: an unlabelled idle row and a row waiting on a person used to read the same)
  rather than treating absence of a hook as success. Server v1 still explicitly refuses `list`.
  **(8) An armed node must not cold-start its own agent** (found while fixing (7)). The mount-time
  cold-restore relaunch (`fresh && agentId && canResume(...)`) carries a second, independent
  refusal beside the `paused` one (`shouldColdResume`): `!data.pendingLaunch`. A first open is
  `fresh` by definition, so every `--after` / `verify` node
  was launching a bare CLI on mount — the session the hold exists to prevent — and the held launch
  then arrived as TEXT typed into it rather than as the command it is. The delivery race used to
  mask it; gating delivery on the shell settling would have made it deterministic.
  **(9) An ERRORED upstream does not release its dependents** (issue #521, 2026-09).
  `--after` fires on idle, and a station whose turn dies on an API/model error reaches idle
  **immediately** — so a malformed-prompt station looked healthy from every surface an
  orchestrator can read, and the whole chain armed behind it launched on what it had not
  produced. The signal was already there and was being thrown away: claude and grok both fire
  **`StopFailure`** instead of `Stop` on an errored turn (already in `CLAUDE_HOOK_EVENTS` /
  `GROK_HOOK_EVENTS` — without the subscription the badge sticks on RUNNING), and both
  normalizers collapsed it to a plain `done`. It now carries **`errored`** on
  `NormalizedAgentEvent`, which `agentStatus` keeps as **`lastTurnError: {at}`**.
  Three things about the shape, each deliberate: (a) it is an **annotation, not a fifth
  `AgentState`** — an errored station IS idle, the two facts coexist, and a fifth state would
  ripple through both raw listeners, the parity test and the mobile mirror for a fact that is
  not a state; (b) it is set in `src/shared`'s normalizers, so **both shells change by
  construction** — there is nothing to keep in parity; (c) it is **TRANSIENT** like `state`,
  because after a relaunch nothing armed can fire anyway and a restored verdict would describe
  another app run's turn. It is **cleared by the next genuine new turn** — not by any
  intermediate transition, which says nothing about whether that turn produced something — so
  the refusal ends by itself when the station answers successfully. Firing with a WARNING was
  considered and dropped: a dependent that has launched cannot un-launch. Surfaces: a
  **TURN FAILED** chip on the node (red, no pulse — a verdict on a turn that is over, not
  something being waited for), the QUEUED tooltip naming the errored upstream instead of
  promising a wait, and a **`LAST TURN ERRORED` marker on the `list` rows** — on the ROW
  because a seven-station fan-out should cost one call to learn this, not seven. **No error
  TEXT is claimed**: whether the hook payload carries the failure message has not been
  measured, and `last_assistant_message` is the previous assistant turn rather than the error,
  so reporting it as "the error" would be a confident wrong fact. Reading the text, and the
  *failed-to-start* watchdog (a station that never emits ANY hook event — the opposite failure,
  which hangs dependents honestly rather than firing them wrongly), stay open.
  **(10) A `done` from BEFORE new work was handed over does not release anything**
  (`core/station-handover.ts`, `@shared/station-handover`, 2026-09-30). A station is reused: an
  orchestrator hands it task B (`send` → `queued` because it is busy, or delivered to an idle pane
  it has not started on yet, or a `write` / `run`) and then opens D `--after <station>`. Until the
  station STARTS B its state is still task A's `done`, so D fired at once — on A's output, and a
  launched dependent cannot un-launch. #1042 closed the same hole for `--after-success` (reports);
  this is the plain-turn half. Rules a refactor must not undo:
  - **The fact is core's, per station, fed by the SAME hand-over moments #1042 uses**: the
    messaging layer's `onHandover` (`queued` = held from that instant; `landed` at the time the
    delivery attempt STARTED; a queued entry that `settled` without landing holds too, from the
    settle — the orchestrator armed D believing the task was handed; the turn running at the expiry
    does not end it, only a turn started after it does, and nothing starts one unless the station is
    given work again, so ▶ / `run` are the usual way out), and each shell's control answer
    (`noteControlAnswer`, on success only, never the caller naming itself) for `write` — stamped with
    the renderer's `typedAt`, when it STARTED TYPING after the human's confirm, never the request
    time: a turn that began while the dialog was open (a background child's task-notification) must
    not answer text not yet typed — and for `run` (starts the named node's held launch; no confirm,
    stamped at request arrival). A `write` into a station that was BLOCKED or WAITING at request time
    (read from the tracker's short state history) is NOT a hand-over: it answers the prompt and the
    same turn continues, so no new turn would ever start to end it. Board comments, station notices
    and a person typing are not hand-overs (the #1042 set).
  - **It ends with a turn that STARTED at or after the newest hand-over and has ENDED, with nothing
    still queued.** The tracker stamps turn starts itself (first working/waiting/blocked after an
    idle state, or any genuine `newTurn` — after an Esc interrupt core may never see the idle the
    renderer infers — on its own clock) for EVERY station, because a delivered prompt can start — and
    even finish — its turn before the delivery's `landed` event is emitted; a hand-over that finds
    its answering turn already over clears at once. Timestamps never cross a process: the renderer
    only reads a membership list, so the Server Edition browser's clock never enters it. A turn
    already running when the work landed does not end it (the typed text is answered by a LATER
    turn); if a CLI folds typed input into the running turn instead, the hold lasts until its next
    turn — the holding direction, with ▶ / `run` as the way out. The idle-prompt rescue (`idle: true`)
    counts only for a station still `working` (the reduceEntry rule): it also fires under an open
    permission prompt, and taking it as idle there let the approval's `working` stamp a fake turn
    start inside the same turn (review of #1052, reproduced).
  - **The tracker is fed every agent event BEFORE the messaging queue** (desktop `emitAgentStatus`,
    the Server Edition's `onAgentEvent`): the queue flushes new work on the very `done` the tracker
    must stamp, and the server's `refreshArmed` reads the tracker on that same event. Pinned at
    source level by `main/station-handover-wiring.test.ts`.
  - **The renderer reads it through a derived primitive signature** (`armedHandoverSig`, only the
    armed nodes' deps — the `armedDepSig` rule), and `launchesToFire` / `depSatisfied` take it as a
    trailing argument: a handed-over station is never a satisfied dep, a DELETED one still is.
    `successDepFacts.turnDone` applies it too, so a success wait never releases where plain
    `--after` would hold. The Server Edition's factory asks `handedOver` in `refreshArmed` AND in the
    creation shortcut (`mustWait`): "already satisfied at creation" must mean satisfied under this
    rule, or the node is launched immediately by the shortcut.
  - **Background SUBAGENTS hold the same way; background SHELLS do not** (same module, same list;
    `background: true` on the record). MEASURED live 2026-09-30: an agent's turn ended while its
    work went on in the background, and the node armed `--after` it fired before anything was
    pushed. Claude's `Stop` carries `background_tasks` (see **Claude's native subagent hooks**, fact
    6); `liveBackgroundSubagentIds` keeps only `type: 'subagent'` entries
    (`NormalizedAgentEvent.backgroundSubagentIds`). A `done` listing a live subagent holds the
    station; only a later `done` whose inventory is PRESENT with no subagent left releases it, or
    `SessionEnd`. Why only subagents: a child ENDS, and its task-notification wakes the parent into
    another turn, so that later `Stop` reliably comes; a background shell (a dev server, a watcher,
    `tail -f`) may never end and does not reliably wake the station — holding on shells held a
    dependent FOREVER ("S starts the dev server, T `--after` S runs e2e" never fired; review of
    #1052). Unknown `type`s are treated like shells. An ABSENT inventory is unknown and changes
    NOTHING (a CLI too old to send it keeps today's behaviour exactly; the idle rescue and
    `StopFailure` carry none). The agent bodies tell a station to wait for a background shell's
    result itself before ending its turn when a dependent needs it.
  - **Eviction prefers stations with nothing held** (the bound is 2000 tracked stations; the oldest
    with nothing held goes first) — dropping a held one would release its dependents. Only when
    every tracked station holds is the oldest held one dropped.
  - **The Server Edition re-runs `refreshArmed` on every tracker change**, not only on
    working/done events: a hold can end on an event the factory is not otherwise run for (a
    `SessionEnd` clearing a subagent hold).
  - Surfaces: `list` says `waiting for <station> to finish the work handed to it` (or `…the tasks
    still running in its background`); the QUEUED tooltip
    names it; both agent bodies render `afterHandoverDocLines` ("hand it the next task FIRST, then
    open the dependent"). DURABLE across a restart (`HANDOVER_FACT`, see **Durable orchestration
    state**): the holding stations are stored, `queued` is rebuilt from the durable queue.
    Relay tabs take the inert stub; the list channel is HOST_ONLY
    (unscoped: every project's stations). Mobile: N/A (the phone never sees `pendingLaunch`).
    Tests: `core/station-handover.test.ts`, `test/acceptance/after-handover.test.ts` (the REAL
    queue → tracker → the renderer's real `launchesToFire`, red on the old code) and the server
    factory's own cases.
  **Pull request waits (`--after-pr`, 2026-09-29).** `open-terminal --cmd …` / `open-claude` /
  `open-agent` take `--after-pr <N:checks|N:merged>[,…]` (N may be `#N` or `owner/repo#N`) and
  `--pr-deadline <90m|12h|3d>`: the held launch ALSO waits for pull requests of the project's
  board repository, ANDed with `after` and the setup gate. The grammar, the persisted shape
  (`pendingLaunch.afterPr = {repository, waits, deadlineAt}`) and main's shape gate are ONE module,
  `@shared/pr-wait`; when a wait is met is `renderer/lib/prWait.ts`. Rules a refactor must not undo:
  - **No new poller, no new request path.** The status is #1008's `GitHubPullBoard` from the host's
    memory. Canvas holds the board's own refcounted host subscription (`watchPulls`) while any live
    node holds a PR wait, so #1008's conditional heartbeat (free while nothing changes) keeps it
    fresh; a `checks` wait also asks the host's bounded chase (`usePullChase`, visible window only)
    because a finished check run does not move the heartbeat. Past the chase cap (12 reads, about
    48 minutes) a still-running CI is noticed on the next repository change — the deadline and ▶
    are the answer, never a timer of our own.
  - **#1008's semantics, not new ones.** `checks` = `ci === 'passed'`, which `pullStatusFrom`
    reports only for a SUCCESS rollup at the CURRENT head; a null rollup ("no checks") never passes;
    a STALE board never passes `checks` (a push since the last read carries other checks) but may
    pass `merged` (irreversible). A board whose repository differs from the hold's is `blocked`,
    which holds rather than fires — that is also what makes a mid-switch board harmless.
  - **`checks` needs a read that STARTED after arming.** The host remembers "passed at head A"
    across a closed board, so pushing B and arming at once would otherwise fire on A. The hold
    stores `armedAt` on the HOST clock (`pullStatus().now`), the tracker publishes `readStartedAt`,
    and `checks` is `unknown` until `readStartedAt >= armedAt`. Two host changes carry it: a
    FOREGROUND read now notifies even when nothing changed (else an already-green PR's fresh read
    would never reach the renderer), and Canvas asks for one (`startFreshReadAsks`: at once, then at
    most 3 more, 35 s apart — the 30 s refresh floor or a read already in flight can swallow one).
  - **"No such PR" needs a snapshot refreshed after the question** (`lookupPullRequests`). A board's
    snapshot can be a minute old and `subscribe` starts no refresh when a board already holds it,
    so `gh pr create` then `open-* --after-pr` used to be told "does not exist — do not retry". A
    miss now asks for one refresh and looks again; absence is proven only when the snapshot's
    `lastSuccessfulRefreshAt` is at or after the host time read before that refresh. Columns come
    from the first page's `counts`, so a PR filed under a deleted column is still found, and a
    truncated harvest says so instead of "retry in a minute" forever. The spilled-prompt TTL
    (30 days) outlives the longest `--pr-deadline` (14 days), pinned by a test.
  - **Unknown is never satisfied, in both directions.** `launchesToFire` treats a caller that passes
    no PR context as CLOSED for a PR hold (the opposite of the setup gate, whose absent probe is
    open for a restart reason that does not apply here), and a malformed persisted hold becomes
    `INVALID_PR_WAIT_HOLD` — present, expired, never satisfied — never `undefined`, because dropping
    it would start the node on its `--after` deps alone. `normalizePendingLaunch`
    (`@shared/pending-launch-shape`) now runs at BOTH serializer seams for the whole held launch: an
    `after` that is not a list used to throw inside the canvas's dep-signature selector; an
    unreadable gate turns the hold `manualOnly` instead of opening it.
  - **Deadline, and the escape.** Default 24h, 1m–14d, refused (not clamped) outside it. Past it the
    node never starts on its own: the badge reads ⚠ EXPIRED (TerminalNode sets its own timer — no
    store changes at a deadline), `list` says EXPIRED, and ▶ / `run` start it anyway (`planRunVerb`
    treats a PR hold like `--after`: the mount does not fire it). Exactly-once is unchanged:
    `launchInFlight` plus clearing `pendingLaunch` on submit.
  - **Refused at arm time, each with its reason** (`resolvePrWaitFor`, resolved ONCE next to
    `issuePre`, against the project the node OPENS in — and only for a caller `issueFlagScope`
    authorizes, since the lookup tells its caller whether a project's board exists): a relay tab; a board not connected to GitHub
    (a cwd-less project says why); no repository or sync not approved on this machine; a full
    `owner/repo#N` in another repository; a number the harvested PR list lacks — only from a WHOLE,
    refreshed snapshot (`lookupPullRequests`), anything less is the retryable
    `after-pr-unconfirmed`; a closed-unmerged PR; `:checks` on a merged PR. A `:merged` wait on an
    already-merged PR is met now and not stored. An SSH project is NOT refused on its own account:
    its board's status is read by this machine's GitHub client like any other.
  - Main (`afterPrFlagRefusal` in its handler) and the Server Edition (`parseControlRequest`) share
    the shape gate: `--run-now` with `--after-pr`, `--pr-deadline` alone, and `open-terminal` without
    `--cmd` (nothing to hold) are refused. The Server Edition then refuses the well-formed flag by
    name (its open allowlist) — it keeps no PR watch, and a silent drop would start the node at once.
  - A node in a project that is not on screen is judged when that project is next viewed (the watch
    follows the live canvas), the same contract as a cold-opened `--after` node. **Downgrade:** a
    build older than this one keeps `afterPr` in the file but ignores it, releasing the node on
    `after` alone. **Kanban / mobile:** the card does not show QUEUED for any held launch (a
    pre-existing gap, not new here); the phone never sees `pendingLaunch`.
  **Success waits (`--after-success`) and `report-outcome`** (2026-09-29). `--after` releases a
  node when every station's TURN ends; a turn ending is not the task succeeding (a station can give
  up, answer its own question or produce something broken, and end its turn cleanly), and #521 only
  catches a turn that ERRORED. So a station says how its task went —
  `report-outcome --outcome succeeded|failed [--note <line>]` — and `open-terminal --cmd` /
  `open-claude` / `open-agent --after-success <id,id> [--success-deadline <90m|12h|3d>]` waits for
  a reported success. Grammar, the persisted shape and the pure evaluation are ONE module,
  `@shared/station-outcome`, used by desktop main's shape gate, the Server Edition's parser AND
  headless factory, and the renderer's launch loop, so the two shells cannot disagree about when a
  dependent starts. Rules a refactor must not undo:
  - **A success wait is `--after` plus the report.** Every `--after-success` id is FOLDED INTO
    `pendingLaunch.after` (renderer: once, right after `prWaitPre`; server: before `resolveAfter`),
    so the existing rules apply unchanged — the station must exist and report status, the wait rope
    is drawn and deleting it is the escape (`dropAfterDep` now drops the success half too), the
    `--run-now` / `--project` refusals, #521's errored-turn hold. The hold
    (`pendingLaunch.afterSuccess = {deps, deadlineAt}`) adds only "and it reported success". It is
    also the downgrade story: a build that ignores the field still waits for the turn.
  - **One grammar; the ambiguous form is refused by name.** `--after a1:ok` (any `:` in `--after` —
    node ids never contain one) is refused pointing at `--after-success`, not answered "no such
    node"; an id in both flags is refused ("name each station once").
  - **The matrix** (`evaluateSuccessDep`): `failed` BLOCKS (never fires; `list` BLOCKED BY FAILURE,
    badge ⚠ BLOCKED, tooltip names the station and its note); `succeeded` is met once the station's
    turn is over without an error; no report = waiting (no news is never success); a DELETED station
    counts only if it reported success before it went — the one place this differs from `--after`,
    where a deletion is satisfied, because closing a station is how an orchestrator abandons a failed
    attempt. Only a canvas-control agent can run `report-outcome`, so waiting on anything else is
    refused (`successDepRefusal`, checked where `--after` is checked). Deadline: the `--pr-deadline`
    grammar and bounds (`parseWaitDeadlineArg`, one parser for both), EXPIRED badge, `list` EXPIRED,
    ▶ / `run` start it (`planRunVerb` treats the hold like `--after`).
  - **The report is core's, and never read from a git-shared file.** `core/station-outcome-store.ts`
    holds it in MAIN (desktop) / the server process: a renderer reload does not lose it, and since
    the durable-state change an app restart does not either — it is mirrored to the machine-local
    `<userData>/orchestration-state/station-outcomes.json`, BOUND to the session that made it (see
    **Durable orchestration state**). The board-log line (`station-reported`, on the station's own
    card, NEVER_COLLAPSE) is display only — `project.json` and the board log are git-shared, and a
    success anyone can commit would release every dependent. `report-outcome` is verified-only
    (`requiresVerified`) and a node reports only about ITSELF: `--node` naming another node is
    refused (`report-outcome-not-self`), not ignored. The note is display text (`sanitizeOutcomeNote`:
    `oneLine` + format chars stripped, 200 code points) and is never typed into a pane.
  - **When a report ends — the "new task" rule, decided by when work REACHES THE PANE, never by
    when a control answer comes back.** A later report supersedes. Otherwise, "hand a station its next
    task, then open a dependent `--after-success` on it" releases the dependent on the PREVIOUS task's
    success. The first version withdrew the report on the `send`'s ANSWER, which for a busy station is
    `queued` (ok: true) long before the message lands — so the station's report for the task it was
    still on counted, its turn ended, D fired, and the queue flushed the new task on the same idle edge
    (review of #1034). Now:
    - `send` / `reply`: the messaging layer emits `AgentMessagingDeps.onHandover` — `queued` (the
      queue's own `onQueued`, synchronous at the push), `landed` (bytes reached the pane: `delivered`,
      `stalled`, `deliveredToReplacedTarget`, on a first attempt or a flush, `at` = when that attempt
      STARTED), `settled` (one per `queued`: flushed, refused on flush, or expired). The store
      (`StationOutcomeStore.onHandover`) marks a queued station WORK PENDING — its reports publish with
      `workPending` and do not count — withdraws reports older than a landing's start (so a report
      about the new work survives a stalled or late answer), and on a settle that never landed
      withdraws the report too (holding, not the old success; the orchestrator was told it expired).
      Only `send` / `reply` count: a board comment is a person steering and a station notice is the app.
    - `write` / `run`: their answer IS the landing (typed after the confirm; a held launch delivered),
      so `clearOutcomesAfterControl` withdraws reports older than the answer, from each shell's
      control handler (desktop `finishAnswer`, which runs on a late answer too).
    - A new TURN clears nothing (a turn is not a task: a station may report mid-turn, and a person
      typing "thanks" starts a turn), nor does typing in the pane. Closing a station keeps its report
      (the deleted-station rule reads it). Every rule errs toward holding, which the deadline and ▶ end.
    `main/station-outcome-handover.test.ts` replays the review's scenario through the REAL queue and
    fails on the answer-time rule.
  - **Both shells**: desktop main answers the verb before the forward; the Server Edition answers it
    through the same `handleReportOutcome` (`onRecorded` re-runs `refreshArmed`) and honours
    `--after-success` in the headless factory (`successFacts`: the mirror's `done`, the fresh-spawn
    `awaitingFirstWorking` rule, and #521's errored turn from its own event stream, `lastTurnErrored`
    — so a succeeded-then-errored station holds on both editions; the server's PLAIN `--after` still
    does not apply #521, a pre-existing gap). Both wire `onHandover` into their messaging deps and run
    `clearOutcomesAfterControl` on answers.
  - **The badge's deadline tick is a memo input** (`lib/useSuccessWait.ts`): nothing in any store
    changes when a deadline passes, and a timer whose tick the memo ignores re-rendered the node with
    the cached "waiting" — the badge kept QUEUED while `list` said EXPIRED. `useSuccessWait.test.tsx`.
  - Reports survive an app restart, so a station that reported success and was then CLOSED still
    counts for its dependents afterwards; one CLOSED without a success report reads BLOCKED ("closed
    without reporting success") and only ▶ / `run` start that dependent. A station that starts a
    DIFFERENT session loses its report (below). Both agent bodies say so.
    `station-outcome:list` is in `HOST_ONLY_CHANNELS` (unscoped: every project's notes); relay tabs
    take the inert stub. Pinned at source level by `main/station-outcome-wiring.test.ts`. **Not
    done:** a reported `failed` does not raise a station-failure notice to the opener (the opener
    reads BLOCKED BY FAILURE in `list`) — a candidate trigger for `@shared/station-notice`; the kanban
    card and the phone show no outcome (the phone never sees `pendingLaunch`).
  **Headless start (`--run-now`, `run`, #925):** `open-*` with `--run-now` into a project that is
  not on screen starts the new node's held launch at once instead of "when next viewed". A node
  with nothing held (an `open-terminal` without `--cmd`) has nothing to start, and gets the plain
  cold-open reply. `run --node <id> [--project <id>]` builds nothing: it claims and starts the held
  launch of a node that already exists, the CLI twin of the QUEUED badge's Run now (like ▶, a `run`
  that starts the node overrides its `--after` wait). Into a project that IS on screen `--run-now`
  changes nothing: the mount path already starts the node.
  - **Flow.** For `--run-now` the renderer first builds the node as a cold open; `run` starts from
    the node as stored. Either way it then writes an
    `executor:'core', attempted:true, manualOnly:true` claim to disk BEFORE any spawn (never
    spawn on an unsaved claim: a failed save restores the original launch and starts nothing,
    `claim-not-saved`). Desktop main's `pty.launchHeadless` runs core `launchHeadless` on
    `desktopHeadlessRequest(req)`: `createHeadless` (client 0), then settle a fresh shell (200 ms
    quiet / 1.5 s silence cap, under an absolute `SETTLE_MAX_MS` = 5 s ceiling that output never
    extends — nothing cancels this wait, and a pane that keeps painting never goes quiet), then the
    mounted writer's trust rule (`trustsFreshShell`, `@shared/launch-trust`: a fresh session-host
    session is trusted without a probe; every other pane must pass `isLaunchShell`, and an unknown
    answer is `no-shell`, nothing typed), then the echo-verified writer (`@shared/command-delivery`),
    then `releaseHeadless`.
  - **The IPC is desktop-only and host-only.** It is registered in `src/main`, not in core
    `registerIpc`, so a Server Edition browser cannot reach it (ws-bridge declares it
    `unsupported`), and `IPC.ptyLaunchHeadless` is in `HOST_ONLY_CHANNELS`, so a relay peer that
    sends the raw request is refused host-side.
  - **Remote nodes are fenced twice.** The primary fence is the renderer's: `startHeadless`
    answers `remote-unsupported` before any claim for every node of an SSH project (`project.ssh`)
    and for a node carrying `ssh` / `sshRemoteTmux`, and leaves its launch exactly as it was. The
    project is asked, not only the node's flags: a node of an SSH project may carry neither.
    Behind it is core's belt: `headlessPtyOptions` sets `requireRemote` for an SSH-project
    (`sshRemoteTmux`) node, and `desktopHeadlessRequest` keeps it while stripping `sshRemote`.
    So if such a node ever got past the fence, core's `spawnNew` would refuse it (`spawn-failed`)
    instead of starting a LOCAL `nt-<id>` wearing its identity. `desktopHeadlessRequest` also
    strips `viewerId` (a create under a viewer id subscribes `(0, viewer)`, while
    `releaseHeadless` detaches `(0, PRIMARY)`, so client 0 would stay attached forever) and
    `clearEnv` (a one-shot recycle flag, never a launch option).
  - **Why release the client.** An invisible client would fight the viewer's window size and
    keep the session "attached" for the reaper forever.
  - **No persistent backend** (tmux or session-host): releasing a plain shell would kill it, so the
    start fails `not-persistent`. In the normal case that happens before any spawn
    (`persistentSpawnAvailable`). In the race where the backend goes away between that probe and
    the spawn (tmux switched off in between), the spawn yields a plain shell; the launcher refuses
    it the same way, before typing anything, and its release kills that shell. Either way the node
    is handed back exactly as it was, so a cold open degrades to an ordinary queued node.
  - **Outcome patch.** It lands wherever the node lives at that moment (`savePendingAnywhere`):
    the live canvas if the user switched there mid-start, otherwise the store copy plus a disk
    write. `delivered` clears the launch; `not-persistent` restores the original (above); every
    other launch failure keeps the claim and marks the node failed (amber ⚠ QUEUED, recovered by
    Run now).
  - **While starting.** `launchDelivery` holds `starting`: the badge reads STARTING, ▶ is disabled
    (a click would splice a second copy into the pane), `launchesToFire` skips the node, and
    `list` names it. Canvas's delivery sweep spares it (`deliveriesToRetire`): the node lives in
    ANOTHER project by design, so "not armed on this canvas" does not mean "delivered".
  - **Notice.** A batch that started at least one session raises ONE sticky "Go there" notice
    (`headlessStartNoticeText`). A launch failure after the claim (`spawn-failed`, `no-shell`,
    `line-too-long`, `cancelled`) shows on the badge (amber ⚠ QUEUED) and in the reply.
    `not-persistent`, `claim-not-saved` and `remote-unsupported` show only in the reply: the node
    reads as it did before the attempt.
  - **`--run-now` with `--after` is refused on both editions**, before any node is built, with the
    shared `RUN_NOW_AFTER_REFUSAL` (`@shared/control-verbs`): "start now" and "start when X is
    done" contradict each other.
  - **`run` gates.** `run` is verified-only (`requiresVerified`), reaches another project only
    through `--project` + the existing grant gate (`PROJECT_TARGETABLE_VERBS`), and is
    `stored-node` off screen. The renderer's `--project` belt is ONE pure resolver,
    `resolveProjectTarget` (`lib/projectOpen.ts`), shared with the open verbs. A project ON screen
    never starts headless (`planRunVerb`): `run` there uses the mounted writer (the ▶ path) when
    the node has one. Without one, a plain queued launch replies `queued` / `starts-when-mounted`,
    because the mount delivers it; a `manualOnly` or `--after`-armed launch is refused with
    `run-not-mounted`, because the mount fires neither, and "starts when mounted" would be a
    promise nobody keeps.
  - **Server Edition.** It accepts `--run-now` as a no-op (its opens are already immediate) and
    implements `run` under creator ownership, resolving the node through the ownership record,
    never by first id match. It neither unhides a closed project nor raises a notice, the same as
    its other immediate opens. Its immediate open delivers through the same launcher with
    `release:false`: the attached client is what keeps even a plain shell reachable there.
  **Settings (`settings`, 2026-09):** `settings [--project <id>]` lists, `settings --get <key>`
  reads, `settings --set <key> --value <v> [--project <id>]` asks to change — flags only, because the
  shim drops a positional sub-action for an unlisted verb and an SSH host can still be running an
  older shim. The pure `@shared/settings-verb` is the whole rule set, shared by the desktop dispatch, the
  Server Edition and main's `parseControlRequest`: an **allowlist** (`agentMessaging` per project;
  `snapToGrid`/`gridSize`/`defaultNodeWidth`/`defaultNodeHeight` machine-wide, bounds = the UI's) with
  a required `why` per entry, and a **forbidden set + name pattern that outranks it** (permission
  modes incl. `bypassPermissions`, `hookIdentityStrict`, `agentBrowserControl`, accounts/credentials/
  gateway/launch commands, telemetry, keybindings, confirm waivers, `capabilityAck`) — the test walks
  the table against both. Four load-bearing rules: (1) **every `--set` confirms**, and `settings` is
  in `DESTRUCTIVE_VERBS` (one dialog at a time) but NOT in `CONFIRM_WAIVABLE_VERBS` — no waiver of any
  scope, bypass included, answers for the user (`control-destructive.test.ts` pins no `waiveVerb`/no
  `controlConfirmDecision` in its block, and the write only on the confirm leg). (2) A capability read
  is the **grant** (`projectCapabilityGrantedFor`), never the file bit, and a capability write goes
  through `applySettingsChange` → the UI's own `setProjectCapability` (flag + `'kept'`), pinned by
  `settingsVerb.test.ts` comparing the two resulting projects. (3) Verified-only (`requiresVerified`)
  and `--project` is own-or-granted via `PROJECT_TARGETABLE_VERBS`/`gateProjectTarget`. (4) **Server
  Edition refuses every `--set` by name** — its headless opt-in (#537) is not consent to grant
  capabilities, and there is no dialog; `--get` answers from `capabilityProjectFor`, own project only.
  Mobile: N/A (the phone issues no control verbs).
  **Agent messaging's MACHINE DEFAULT (`settings.agentMessagingDefault`, 2026-09, ships OFF).** A
  project whose `.nodeterm/project.json` carries NO `agentMessaging` value is answered by this
  machine's settings.json; the rule is ONE function, `projectCapabilityEffective`
  (`@shared/project-capability-consent`), and `projectCapabilityGrantedFor` now REQUIRES the
  defaults argument so a consumer that forgot it fails to compile instead of reading every
  unconfigured project as off while Settings reads it as on. Four rules: (1) an explicit `true` still
  needs this machine's `'kept'` — `needsCapabilityNotice` is untouched and stays keyed on an explicit
  `true`, so a cloned file still notices and a project on only by default never does; (2) OFF is now
  WRITTEN — `setProjectCapability(…, false)` stores a literal `false` for a capability in
  `CAPABILITY_MACHINE_DEFAULTS` (browser control has none and still deletes the field), because
  absence now means "use the default"; `readProjectCapabilities` carries that `false` through the
  file; (3) an ABSENT field with a recorded `'declined'` stays off — that is how every pre-default
  build wrote "off", and a user's explicit no must not be undone by a default switched on later;
  "Use this machine's default" (`resetProjectCapabilityToDefault`) therefore clears the field AND the
  answer; (4) the default is forbidden to the `settings` verb (a grant over every project, clones
  included). **This does not trip the `project-capabilities.ts` header's trigger**: the notice is not
  dropped, and what the default answers is absence, whose value lives in machine-local settings.json.
  **Why it ships OFF:** `core/agents/pane-ownership.ts` records a pane's owner only on a FRESH spawn,
  so after an app restart or update every surviving pane is `unproven-target-owner` and refused —
  "on by default" would be false after every restart. The flip is a separate one-line change that
  waits for a cross-restart ownership proof (#659's signed record is the candidate). Settings →
  Agents shows the machine switch, and the per-project row is a three-way choice (default / on /
  off) plus "On in <project> (this machine's default)" — a two-position switch cannot draw absence.
  Downgrade: a pre-default build writes `false` back as a deleted field, which this build then reads
  as "use the default". Server Edition reads the same grant from its own settings.json; Mobile: N/A
  (the phone has no capability switch).
  **Review panel (`verify`, 2026-07):** `verify --node <id> [--lenses …] [--focus …] [--agent …]
  [--synthesis off]` opens one reviewer per LENS, each armed behind the target (`--after`) and
  bridged to it, wrapped in a `Verify: <title>` group, plus a judge armed behind the whole panel.
  It is **composition, not new machinery** — the two primitives above are the whole implementation.
  Prompt/lens logic is the pure, unit-tested `renderer/lib/verifyPanel.ts`; two wordings there are
  load-bearing and must not be "tightened away": reviewers are told **not to edit** (a panel is N
  agents pointed at ONE checkout — review and repair are different jobs, and only repair needs
  worktree isolation) and are explicitly **licensed to find nothing** (a reviewer under implicit
  pressure to produce findings invents them, and an invented finding costs someone else the time to
  disprove it). Unknown lens words are **kept** with a generic brief, not rejected — a table that
  only accepts what it already knows would be useless for the review nobody anticipated. Reviewers
  inherit the TARGET's `accountId` (its transcript resolves inside that account dir), not the
  caller's. The judge is armed on ids that exist only in that tick, which is why `armAfter` takes
  `extraLive` — without it the reviewers would look *deleted*, deletion counts as satisfied, and
  the judge would fire before a single review existed.
  **Station-failure notices (2026-09, `src/core/agents/station-notice.ts` + the pure
  `@shared/station-notice`):** when a station an agent OPENED stops, that agent is told ONCE,
  with its options (retry or wait / reassign / skip / stop), instead of having to poll `list`.
  Load-bearing rules:
  - **The trigger is a closed table (`STATION_TRIGGERS`), first match wins:** `dropped` (the
    renderer's DROPPED verdict, about a station core does not know to be mid-turn or asking),
    `turn-errored` (a verified `done` carrying `errored`; a verified new turn OR a clean `done`
    retires it — it describes the LAST turn), `question-unanswered` (the status mirror still holds
    the station's correlated `pendingQuestion` 15 min after the verified event that asked it,
    `STATION_QUESTION_NOTICE_MS`, AND the recipient's own verified state is `done`). An unknown
    never triggers, and only VERIFIED events move a station: a notice leads an orchestrator to
    retry, reassign or END a workflow, so a forgeable event is not evidence. 15 min because the
    human already got NEEDS YOU + a notification; an orchestrator reassigning seconds before the
    user answers doubles the work.
  - **A permission prompt is NEVER a trigger, and that is a measurement, not caution.** On the main
    thread Claude paints its dialog CONCURRENTLY with our held hook (docs/hook-reply-approvals.md),
    and an approval given in the pane fires nothing until the approved tool FINISHES — so neither
    `blocked` nor a `pendingId` can tell "unanswered" from "approved, twenty-minute build running",
    and a notice there invites the orchestrator to close a working station. A question can be told
    apart: its answer is a tool result, and the mirror's `pendingQuestion` is held across unrelated
    traffic until it arrives. The monitor reads it through `pendingQuestionOf` (required dep)
    rather than re-deriving it.
  - **Once per episode, re-armed ONLY by a successful turn** — a turn that started after the notice
    and ended `done` with no error, no interruption and not the idle-prompt rescue — and the re-arm
    clears every fact the episode was about (error, DROPPED, question), or the next sweep re-fires
    it. The condition merely clearing does not re-arm: a usage-limited station fails again on
    every retry, and re-notifying each time would be a loop that burns the orchestrator's turns
    all night. The notice says so in its own text.
  - **Core withdraws DROPPED itself, on ANY verified hook event from the node** (the CLI speaking
    from inside the pane — the renderer's own self-heal in `agentStatus.setState`). It must not
    wait for the renderer's `reportDropped(false)`: the renderer's record of what it reported and
    its transient flag both die with a reload (⌘R, a Server Edition tab closing), and a verdict
    nobody withdraws re-fired on the healthy station after its next successful turn — typed into
    the orchestrator with "reassign: close it" as an option (the independent review's blocker).
  - **The recipient is the OPENER, and a rope alone cannot name it.** An `--after` station is roped
    to every station it waited on as well as to its opener, with the same `ctrl-<src>-<dst>` id, so
    "the other end of the rope" can be a sibling that opened nothing. The open verbs therefore
    STAMP `data.openedBy` where they draw the opener's rope (`connect` for the live paths —
    addAndConnect, verify, spawn-team — plus the off-canvas and cold-open writes; pure helper
    `lib/stationOpener.ts`), and `stationRecipient` requires BOTH: `openedBy` names a canvas-capable
    agent node in the same (single) project, AND that node's OPENER rope to the station still
    exists — never a `ctrl-after-` wait rope (deleting the rope detaches the station). Never a bridge-linked node. `openedBy` is git-shared,
    so `safeOpenedBy` (`isSafeNodeId`) runs at both serializer seams, and a duplicate drops it. A
    node opened before this build has no `openedBy` and is never attributed (no guessing).
  - **Server Edition: the creator LEDGER is the recipient rule** (`stationRecipientFromOwner` over
    `factory.openerOf`) — only stations opened during the current server run, the same creator rule
    as every other verb there; a restart clears it.
  - **Two legs.** The canvas leg needs no switch: a `station-failed` board-log line on the
    RECIPIENT's card (`from` = station id, `to` = reason code, `title` = the capped one-line
    title; in `NEVER_COLLAPSE`) and a STATION FAILED chip (`components/StationFailedChip.tsx`, one
    component on the node header and the card modal; the tooltip says whether the pane leg landed,
    so "stayed on the canvas because messaging is off" is visible). The pane leg is
    `deliverStationNotice` = the messaging service's WHOLE gate chain (scope, the per-project
    `agentMessaging` switch — off by default ⇒ canvas only — runtime pane ownership, flow limits,
    idle gate + deliver-on-idle queue, receipt, trace) under an internal verb
    `STATION_NOTICE_VERB` that is deliberately NOT in `AGENT_MESSAGE_VERBS`, so neither the IPC
    guard nor the shim can ask for a notice with a body of its choosing. The pane leg is followed to
    its END so the chip never says "queued" about a message that landed or lapsed: a queued
    notice's flush or expiry comes back through `AgentMessagingDeps.onQueuedResult` (called from
    `createDeliveryQueue`, read at call time). Two outcomes get exactly ONE more attempt, each
    because it would otherwise lose the pane leg for a reason unrelated to the notice:
    `rateLimited` (the station `send`s its result, then errors seconds later — the pair budget is
    spent) retries after the limiter's wait, capped at 60 s; an expiry (the orchestrator stayed busy
    past the queue's 5-min TTL) is offered again on the orchestrator's next verified `done`. Two differences from
    `send`, both because the APP is the author: the body is `stationNoticeBody` (fixed text from
    the table; the only station-influenced string is the title, `oneLine`d, capped at 80, quoted,
    and labelled data — NO station output is ever quoted), and the Server Edition's creator check
    runs reversed (`callerOwnsTarget(recipient, station)`). The pane leg honouring the switch is
    deliberate: the app typing into an agent's session is the capability that switch grants.
  - **DROPPED is the renderer's fact** (it needs `hibernated`/`paused`), forwarded as EDGES by
    `lib/stationNoticeWiring.ts` over `stationNotice.reportDropped`; the monitor never measures a
    pane. Both request channels are in `HOST_ONLY_CHANNELS`: a relay guest never measured the
    host's panes (its tab takes the inert stub), so a raw DROPPED report from one is a spoofed
    verdict, and `station-notice:list` is unscoped — every project's failed-station ids and titles
    — which a guest bound to one project must not read. It is therefore only as available as the liveness check, which asks for WATCHED nodes:
    a station that dies off screen is noticed when it next comes into view, and a Server Edition
    with no browser tab attached reports no DROPPED at all. Widening the check to unwatched
    stations costs one pane read per finished station per 30 s (an ssh exec on SSH projects) and
    is a deliberate follow-up, not an oversight.
  - **Both shells wire it and nothing type-checks that:** desktop main feeds
    `stationNotices.onAgentEvent(enriched)` from `emitAgentStatus`; the server's canvas-control
    `onAgentEvent` feeds its own monitor; both call `registerStationNoticeIpc`. Pinned at source
    level by `main/station-notice-wiring.test.ts`, along with every stamping site. Relay tabs take
    the inert stub (a relay tab's stations are the host's). Mobile: N/A — the notice reaches the
    orchestrator's pane, which the phone's chat view already shows.
- **Context Link** — a node action gated by `CONTEXT_LINK_CAPABLE` (claude/codex/gemini/opencode/grok;
  custom agents + plain terminals excluded). **grok joined in 2026-09, and the file matters:** its
  readable conversation is `chat_history.jsonl`, NOT the `updates.jsonl` its own hook payloads
  advertise and this line used to name. Routing through the advertised path does not error — it opens
  a real file, parses nothing, and hands the linked agent an EMPTY transcript with no diagnostic, so
  a reader who trusts the old wording will build the silent failure this note exists to prevent
  (`core/handoff/locate.ts` pins it): drawing an edge between two builtin-agent nodes lets each
  READ the other's context on demand (pull, not push). Architecture (2026-07, SSH-capable — see
  docs/ssh-agent-skills.md): the **desktop does the reading AND the parsing**; the CLI the agent
  runs (`context.sh`) is a thin POSIX **sh+curl** shim that POSTs to the hook server's
  `/context-link/<verb>` route and prints the text/plain reply (the Electron-as-Node CLI is
  retired — its embedded-JS parser now lives as tested TS in `core/context-link-render.ts`:
  parsers for **all four** formats — claude JSONL / codex rollout / gemini event-sourced chat /
  opencode export — plus `renderContextLink` over injected fetchers). `src/core/context-link.ts`
  coalesces renderer updates before workspace-map construction with a non-resetting task.
  Intermediate ACL publications retain previously resolved paths keyed by node, agent, session,
  account, cwd, remote/local placement and hook path. Ingest prunes changed/removed identities,
  so changing back during queued discovery cannot revive an invalidated path. Reinitialization
  clears the cache, and only current-revision discovery may refill it. The service
  holds the link docs in memory (per-node files under `<userData>/context-links/` remain as a
  debug aid), carries per-entry `agentId`/`sessionId`/`accountId`, and answers the route;
  **authorization** = the doc is selected by the REQUESTER's node id, so a token-holding caller
  can only read nodes in its own (directional) link map. Codex/gemini paths resolve via the
  handoff locators (`locateCodex`/`locateGemini` by sessionId); claude keeps the hook-fed path +
  `locateClaude(sessionId, accountId)` fallback (cwd-newest is claude-only).
  `useContextLinkSync` publishes semantic map changes from live edges and subscribes to
  background project/status changes. Geometry/status render churn cannot postpone publication;
  relay-bound projects never enter the local core's map. A render-captured project epoch prevents
  outgoing live nodes replacing the incoming project's persisted map during a tab switch. Core
  replaces the read authorization map synchronously, then enriches/writes debug documents through
  a recoverable serialized queue; revision checks prevent obsolete enrichment restoring a removed
  link. Transcript paths can be temporarily unavailable while the current snapshot is enriched.
  **SSH projects:** the shim +
  skill are installed on the remote host at connect (`RemoteHooks.installContextLink`, gated on
  the VERIFIED reverse hook tunnel; POSTs ride `--unix-socket` through it); a remote node's
  transcript is read over the ControlMaster (`initContextLink(ptyManager, deps)` — `src/main`
  injects `isRemoteNode`/`readRemoteFile`/`runRemoteCommand`, bounded tail reads), its hook-fed
  path is jailed at ingest (`isSafeRemoteTranscriptPath`), and `resolveLinkTranscript` REFUSES
  the local locators for remote nodes (they'd resolve a stranger's local transcript). Server
  Edition IS wired (`src/server/context-link.ts` calls `initContextLink(ptyManager, {})`) but
  passes no remote deps → **local-only**, which is the complete answer there: that shell runs ON the
  host whose transcripts and tmux it reads, and SSH projects are a desktop-only concept. Discovery is the `get-linked-context` skill in each consented
  context-link-capable agent's own skills dir (since #744; the old marker block
  `<!-- nodeterm:get-linked-context:start/end -->` in AGENTS.md / GEMINI.md is stripped — see
  **Agent-integration consent**). On connect an idle-gated one-line note is injected into each endpoint
  (claude → skill pointer; codex/gemini → inline CLI command via `contextLink.info()`).
  (Replaced the earlier MCP-based bridge.)
  **One-way links (issue #852):** a context bridge may carry `reader` (`BridgeLink.reader`, the ONE
  endpoint allowed to read the other); absent = both read, which is every pre-#852 link, so old
  `project.json` files load unchanged. The rule is `linkReadPairs` (`shared/canvas-link.ts`), and
  `buildLinkMap` is where it BITES: the non-reading side gets no map entry, so main serves it no
  document and the resolver refuses it — enforcement is at the read, not in the discovery note. A
  `reader` naming neither endpoint, or any present non-string value, authorizes nobody (fail closed)
and is carried VERBATIM through every conversion — dropping it as "absent" would widen it to two-way
on the next save. Set it from the context-link
  edge's right-click menu (both / A reads B / B reads A; arrowheads point at the reader — a rope
drawn over a hidden link resolves it by endpoint pair via `contextLinkForEdge`) or with
  `link --one-way` (`--from` reads). On the canvas it rides `edge.data.reader`; every bridge↔edge
  conversion goes through `bridgeToEdge`/`edgeToBridge` (renderer/lib/noteLink.ts; CLI-planned
bridges enter live state only via `appendBridgeEdges`) and the server
  merge keeps it (`serverChange.edgeRef`) — a field-by-field `{id, source, target}` copy silently
  turns a one-way link two-way again. A flip that GRANTS read access sends the same one-shot
  discovery note a new link sends; losing access sends nothing, like removing a link. Note: the
  premise "every submit triggers a full read" does not hold — nothing reads on submit; the linked
  agent reads only when it decides to run the skill/shim. What one-way removes is the other side's
  PERMISSION and its discovery note. **Team sync carries it too**: an `edge-upsert` of kind
  `bridge` keeps `reader` through the diff, the shape gate, the reflector's sanitize and the peer's
  apply (`edgeFields`/`sameEdge` in `shared/canvas-mutations.ts`), and a flip alone is a change. A
  three-id copy there never cast a flip and landed a cast one-way link on the peer as both-read,
  which the peer then saved and published back. A malformed reader on the wire REFUSES the op
  (never dropped — dropping widens), and a rope never carries one.
  **Note links:** a sticky note can be connected to ANY terminal node (one-way, sticky →
  terminal). On connect, agent sessions get a one-shot idle-gated push of the note text
  (`buildNotePushMessage`, single-line, truncated at 2000 chars); plain terminals get no
  push (sendText appends Enter — the text would execute). The note's live text also rides
  the link file (`ContextLinkInfo.note`), so Claude reads the current text via the
  get-linked-context CLI (`summary`/`transcript` print it; `list` marks `(note)`). Pure
  edge/push/map logic in `renderer/lib/noteLink.ts`.
- **Managed Claude accounts** (Claude-only) — run several logged-in Claude identities side by
  side by giving each its own config dir. `settings.claudeAccounts` is a list of `ClaudeAccount
  {id, label, email?, host?, pending?, createdAt}` (in `settings.json`; the account **list** is
  config, not credentials). Isolation is **config-dir**, not token storage: a local account's dir
  is `{userData}/claude-accounts/<id>` (`claudeConfigDirFor` / pure `accountConfigDir`),
  a **remote** account's is `~/.nodeterm/claude-accounts/<id>` on its `host` (keyed by
  `sshHostKey` = `user@host`; `remoteAccountConfigDir` is `~`-relative for ssh expansion,
  `remoteAccountConfigDirAbs` resolves it against the connection's `remoteHome`). The **claude
  CLI owns login, credential storage, and token refresh** inside that dir — the app NEVER writes
  credentials. On macOS this works because Claude Code **≥ 2.1** scopes its Keychain service per
  config dir (`Claude Code-credentials-<sha256(configDir)[:8]>`, `claudeKeychainService`); on
  < 2.1 one unscoped service is shared → accounts collide, so add-account **warns** (`claude
  --version`, `isSupportedClaudeVersion`).
  - **`data.accountId` (terminal nodes)** — resolved **once at node creation**
    (`resolveNewNodeAccount`: explicit submenu pick → `project.defaultAccountId` → system default
    `~/.claude`), then **persisted** (serializers) and changed ONLY by an explicit **account switch**
    (below). `undefined` = system default
    = **bit-for-bit legacy behavior** (no env touched). Inherited by **Branch** (the
    terminal→chat fork it also fed is gone — the SDK chat node was removed 2026-07). Two #419
    rules inside the resolver: the submenu's **System row passes `null`** (an EXPLICIT system
    pick that skips the project default — before that, the row wearing the system email launched
    the project-default account), and validation runs against `accountsForProject`, not the raw
    list, so a **pending** account or one **pinned to another machine's host** is never stamped
    onto a node it cannot run on (both used to reach the missing-dir fallback at spawn).
  - **Switch Claude account (running node)** — node right-click → *Switch Claude
    account ▸* moves the conversation onto another account **already logged in** on this machine,
    with no `/login` in the pane. It works because a transcript carries **no account identity**
    (measured on 2.1.280: under a config dir lacking the file `--resume` says "No conversation found";
    with the file copied into `<configDir>/projects/<encoded cwd>/<id>.jsonl` only the login is
    missing). Choreography = "Restart agent and shell" with a `beforeRecycle` step
    (`agent-restart.ts`): exit the CLI (refused while working/blocked) → core
    `claudeAccounts.copySession` (`core/claude-session-copy.ts`) → rebind `accountId` → recycle, whose
    respawn gets the new `CLAUDE_CONFIG_DIR` and whose cold restore resumes the same id. Two rules:
    the copy runs **after** the exit, so the source is final and a target that is a byte-**prefix**
    of it is just an older copy (A→B→A) and may be replaced, while a **diverged** target is never
    overwritten; and the rebind is **returned** by `beforeRecycle` and merged into the closure's own
    `updateNodeData`, never set by a separate Canvas `setNodes` in the same tick (React Flow's update
    queue rebuilds the node from the store's copy and can drop it). Builtin `claude` only (the
    `boundAccountId` rule below). **SSH nodes** switch between the accounts pinned to THEIR host (and
    the host's own `~/.claude`): the copy runs ON the host as one generated `sh` script over the
    project's master (`core/remote-claude-session-copy.ts`, tested under a real `/bin/sh`; same
    prefix/diverged rule, via `head -c | cmp`), and `SshProjectManager.remoteClaudeSessionCopy`
    refuses an account pinned to another host. An SSH ctx with no remote leg (Server Edition) is
    refused, never answered from the local disk. Relay tabs: shown disabled.
    **Two more surfaces, one choreography** (`runClaudeAccountSwitch` returns a
    `ClaudeSwitchOutcome` instead of announcing it): the **kanban card** right-click menu gets the
    node's rows from the SAME builder the canvas node menu uses (`accountSwitchRows` → KanbanView's
    `accountMenuItems`), and the **usage popover** puts "⇄ Move N sessions" on each account row —
    every Claude session on this canvas running on that account, on the popover's machine
    (`bulkSwitchCandidates`), is moved to the picked account ALL AT ONCE (`startBulkSwitch`), busy
    ones skipped and counted, one summary line (`summarizeBulkSwitch`). It was one-at-a-time and
    that broke twice: N sessions cost N exits in a row, and a switch reads its node off the live
    canvas when it STARTS, so a project switch mid-run refused every node still waiting its turn.
    An SSH host's load is paced in core (`SshChildGate`, the pty spawn gate), not by serializing.
    While it runs, Canvas hands the popover `accountMove`: the moving sessions keep their OLD
    account until each lands, so the source row reads "Moving N sessions…" instead of re-offering
    them, and every other row's move is disabled (a second bulk move would be refused).
    **A recycling restart can outlive its canvas** (`settleRecycledNode`): if the project was
    switched while the CLI quit, React Flow no longer holds the node and `updateNodeData` is a
    silent no-op — the rebind then goes into the stored project (`projects.rebindNode`) and the
    park is DROPPED, because it holds the session this recycle just killed and re-adopting it on
    return showed a dead pane on the old account. The cross-project board (GlobalKanbanView) does not offer it:
    its cards belong to other projects' canvases, whose nodes have no restart closure mounted.
  - **`boundAccountId(accountId, agentId)` (`shared/agents/account-binding.ts`) is the ONE rule for
    whether a node is account-bound at all**, and it feeds `data.accountId` *and* the account color
    from a single decision — split them and a node carries an account it is not painted for, or is
    painted for one it does not carry. Two surfaces mint nodes and both ask it: `createAgentNode`
    (canvas) and `appendProjectNode` (the phone's `projects.registerNode`, which used to write
    whatever the wire sent, so a gemini node could come back bound to a Claude account). Managed
    accounts belong to the builtin **claude and codex** (S6); a **known** other agent — builtin or
    custom, since a custom agent inheriting one of those harnesses is still its own agent — never
    binds. **An UNSTATED agent keeps its binding** — the asymmetry is deliberate: the phone chooses
    `agentId` and `accountId` independently and is not known to always send the first
    (docs/ios-protocol-migration.md §6), dropping a real binding is the wrong-identity bug the
    field exists to prevent, while a stray one on an agent-less node only sets a config-home
    variable nothing reads. On the canvas `agentId` is always stated, so that path is bit-for-bit
    what it was. `main` resolves the color off the RAW id and lets the registrar refuse it, rather
    than re-deriving the gate at the call site.
  - **Account default node color (`ClaudeAccount.color` / `CodexAccount.color`, optional)** — a
    per-account default node color (Settings → Accounts) that beats the agent's own brand color in
    `createAgentNode`, so a second login is recognizable on the canvas. Read off the SAME
    `boundAccountId` that stamps `data.accountId`, so the color and the binding cannot drift.
    Applied **at creation** and baked into `data.color` like any other node color: a hand-picked
    node color is never overwritten and editing the account later repaints nothing. Unset / stale
    id / an agent that takes no managed account ⇒ the agent's color, unchanged.
    **Which list answers is `agentAccountColor`'s alone** (`shared/agents/account-color.ts`, one
    definition shared by `createAgentNode` and the phone-registered node path in `src/main`):
    claude reads `claudeAccounts`, codex reads `codexAccounts`, everything else reads nothing. The
    two lists are keyed **independently** — nothing stops the same id appearing in both — so a node
    colored from the other list would be repainted from a stranger's row; the swatch UI is one
    component (`AccountColorSwatches`) rendered by both row kinds for the same reason.
    The value is **re-validated as a string** at the read: the account lists come out of a
    hand-editable settings.json that nothing checks field-by-field on load, and a `"color": 123`
    would throw on `.trim()` INSIDE `createAgentNode` — stopping every new node under that account
    from opening, with nothing pointing back at the edited file.
  - **Env injection** — `pty-manager` sets `CLAUDE_CONFIG_DIR` in the spawn env AND as a tmux `-e`
    (local); for a remote node it emits an **absolute-path** remote tmux `-e` built from the
    connection-cached `remoteHome` (skipped **fail-open** if home is unresolved). `AUTH_ENV_STRIP`
    (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) is deleted from the
    child env so a stray env key can't shadow the account. A **missing** account dir → warn +
    silent system fallback. **The account-scope names ride the LOCAL conf's `update-environment`
    (`ACCOUNT_SCOPE_UPDATE_ENV`, issue #419)** — the shared tmux server inherits the env of the
    client that STARTS it, so a server started by a managed-account node used to leak that
    account's `CLAUDE_CONFIG_DIR` (and any un-stripped auth key) into every session created
    without a `-e` override: system nodes, plain terminals and the missing-dir fallback silently
    ran as that account ("the system account is entangled with the next account in the list").
    Listing the names makes tmux copy each from the creating client's env and **strip it when the
    client lacks it** (proven against a real tmux in `account-env.realtmux.test.ts`, seeded-server
    case included; `ensureUpdateEnvKeys` retrofits a long-lived pre-fix server). The same listing
    is what makes codex's explicit system-scope overwrite (`CODEX_HOME` /
    `NODETERM_CODEX_ACCOUNT_ID`) actually reach sessions on a shared server. **LOCAL conf only**
    — the remote conf must NOT get these names: a remote attach client's env is the login
    shell's, and the copy/strip would run against that wrong environment (pinned in
    `ssh.test.ts`).
  - **Login flow** — Settings → Accounts → **Add** creates a `pending` account and drops a canvas
    **login node** that runs `claude /login` under the account dir. Core polls the dir's
    `.claude.json` (`LOGIN_POLL_MS` 2 s, up to `LOGIN_TIMEOUT_MS` 5 min) for `oauthAccount.email`;
    on capture the account flips out of `pending` with its email as the default label. Account
    removal cancels any pending wait + `markDirty`. **Codex accounts have the same two halves** —
    `createCodexAccountLoginNode` (`codex login`, title "Codex login") behind the
    `nodeterm:add-codex-account-login` listener, with `codexAccounts.waitLogin` polling the managed
    home's `auth.json`. Both flows mint an **agent-less terminal** carrying only `accountId`, and
    that shape is why `needsCodexAccountScope` takes an `isCodexAccount` resolver rather than
    reading `!!accountId`: the two account lists share an id alphabet, so the id alone cannot say
    which provider it belongs to. Guessing "codex" refused every managed **Claude** node (#345);
    guessing "not codex" would let `codex login` write into the system `~/.codex`. A dispatch with
    no listener is a silent no-op, which is how the Codex half shipped inert (#346) — pinned now by
    `renderer/lib/nodeterm-events.test.ts`, which fails on any `nodeterm:*` event that is sent but
    never heard. **All THREE login factories take a `cwd`** (`createAccountLoginNode`,
    `createCodexAccountLoginNode`, `createSystemLoginNode`), and every call site passes the active
    project's — a login node with none starts in `$HOME`, and an agent CLI whose trust check is
    keyed on the cwd (Claude Code's is) then asks the user to trust their entire home directory,
    SSH keys and cloud credentials included, before an OAuth round trip that touches no files
    (issue #553; a persisted "yes" there grants that workspace for good). It is not a promise the
    prompt disappears — an untrusted project still prompts — it makes it the exception rather than
    the rule, without nodeterm writing another tool's trust config on the user's behalf. A
    **remote** login ignores the local path: `createTerminalNode` prefers `ssh.remoteCwd`, which is
    the only cwd that means anything for a session running on the host. An SSH project has no local
    `cwd`, so a LOCAL account added from one still opens in `$HOME` — the honest answer, since that
    project owns no local directory.
  - **The lifecycle is CORE, and both shells register it** (issue #313) —
    `core/claude-accounts-service.ts` owns the five `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove / link) behind `platform().handle`; `main/claude-accounts.ts` is a thin desktop
    wrapper and `registerCoreHandlers` calls the same `registerClaudeAccountsIpc()`. Two optional
    deps carry everything core cannot reach: `installSkill` (desktop passes `installCanvasSkillInto`;
    an enabled Server canvas-control runtime installs its Server-specific skill separately) and
    `remote`, a **thunk** resolving the SSH legs
    (desktop's manager is created after the registration, and the server has none — in both cases
    an `AccountCtx` carrying a `projectId` degrades to the LOCAL path, which is the pre-existing
    behavior this preserves). **Three surfaces:** Desktop unchanged (same channels, same shapes,
    same remote fallbacks); **Server Edition** now full — real `buildClaudeAccountsApi` over the
    ws-bridge (the 5-min `waitLogin` is a straight passthrough because RpcClient has no request
    timeout), minus SSH accounts and the canvas skill; **Mobile: N/A** — the phone launches with
    the accounts the agent-status mirror advertises and never mints one. **Managed CODEX accounts
    stay desktop-only** and their bridge namespace stays an `E_UNSUPPORTED` stub: the switch verbs
    authorize the owning window by Electron WebContents id, which has no meaning over a WS
    connection. The Settings section now *names* that refusal instead of leaving an unhandled
    promise rejection — a spinner that stops and says nothing reads as a dead button.
  - **Hook install** — the managed hook is merged into **each account dir's** `settings.json` at
    add-account **and** at app launch (local, shared `install-helper.ts`) / via
    `RemoteHooks.installIntoAccountDir` (remote), so every identity reports agent status. The
    launch-time loop is ONE function (`installHooksIntoLocalAccounts`, beside the service) that
    both shells call — the desktop passing the canvas skill as its `extra`. A second copy is the
    drift this file warns about elsewhere: the Server Edition shipped without the per-account leg
    entirely, so a managed account there reported no agent status at all.
  - **Shared system skills (`shareSystemSkills`, issue #643, OFF by default)** — Claude Code resolves
    user skills as `join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'skills')` (MEASURED, 2.1.266), so an
    account dir **replaces** `~/.claude/skills` rather than adding to it and a fresh managed account
    shows only the skills nodeterm installed (that was #438). The isolation is correct and often the
    point; this per-account switch (Settings → Accounts) is the way back in.
    **Each system skill is linked INDIVIDUALLY** (`<accountDir>/skills/<name>` →
    `~/.claude/skills/<name>`), never the whole `skills` directory, and that choice is what makes
    everything else safe: `installCanvasSkillInto` writes *into* `<configDir>/skills/`, so a
    directory-level link would put nodeterm's canvas skill in the user's SYSTEM skills folder, and
    "turn it off" would have to restore a directory it had first moved aside. Per-skill links keep
    the account's `skills/` a real directory and make the off-switch a link removal.
    MEASURED with strace: Claude Code opens a symlinked entry inside `skills/` as a directory and
    reads its `SKILL.md` exactly like a real sibling — per-skill links are equivalent to the
    whole-directory link for discovery, not a compromise.
    - **Ownership is name-anchored**: an entry is ours iff it is a symlink whose target normalizes
      to exactly `join(systemSkillsDir, <that entry's own name>)`. What ON creates is precisely what
      OFF removes; a real directory is never ours, whatever its name — so "never delete through the
      link" is a property of the plan (`core/claude-skill-share-core.ts`, pure + mutation-tested),
      not a promise about the applier. Removal is `unlink` then `rmdir` (a Windows junction refuses
      `unlink`); both fail on a real non-empty directory, which is the second line of defence.
    - **`NODETERM_OWNED_SKILLS` (`manage-nodeterm-canvas`, `get-linked-context`) is never linked and
      never pruned.** Their presence in an account dir is decided by nodeterm's own installers; if
      sharing linked them, the off-switch would delete a skill the canvas-control installer had put
      there and the two owners would fight over the name at every launch.
    - **The realpath refusal is load-bearing.** The issue's manual workaround
      (`mv skills skills.bak && ln -s ~/.claude/skills skills`) makes the account's `skills/`
      RESOLVE to the system one; linking into it would plant links in the user's own folder and let
      the off-switch delete them from there. The planner compares REAL paths and refuses
      (`same-directory`), which also covers a linked account whose `configDir` was hand-edited to
      `~/.claude`.
    - **Windows uses a directory JUNCTION** (`fs.symlink(target, path, 'junction')`), not the `'dir'`
      symlink `worktree-shared-paths.ts` must use: a junction needs neither Developer Mode nor
      elevation, and every target here is an absolute directory — the two conditions it has. On
      POSIX Node ignores the type. So the feature is available on every desktop platform rather than
      gated off one.
    - **The launch sweep re-links but NEVER removes** (`installHooksIntoLocalAccounts`). ON has real
      work at boot (a skill added to `~/.claude/skills` since the last run; a stale link to prune);
      OFF is a removal, and ownership here is inferred from a link's SHAPE, which cannot tell our
      link from an identical hand-made one — and a LINKED account's dir is the user's own
      `~/.claude-2`, where exactly that is a normal thing to find. Removal therefore happens only
      through `claude-accounts:set-skill-sharing`, where the intent is explicit. The cost: a
      settings.json hand-edited to `false` while the app was closed keeps its links until the switch
      is flipped.
    - **The switch flips the filesystem FIRST and persists the flag only if that returned** — the
      flag is what the sweep replays, so a stored `true` whose links were never made would make the
      switch lie until the next boot. A refusal stores nothing.
    - **The copy says the edits flow both ways**, because a link is not a copy: editing a shared
      skill from inside the account edits the machine's own file. A user who reads "share" as "copy"
      finds that out by losing work. Result sentences are the pure `renderer/lib/skillSharing.ts`.
    - **Surfaces.** Desktop: full. **Server Edition: full** — the whole implementation is core, so
      the ws-bridge leg is a real passthrough and the machine the browser is served from is exactly
      the machine whose `~/.claude/skills` is shared (the canvas skill is not installed there, but
      its name stays reserved: a reserved name that is never created is inert). **SSH accounts:
      explicitly out of scope for v1** — their config dir is on the host, so the option would have to
      link that host's skills over the ControlMaster, with its own generated-shell proof obligation.
      The switch is DISABLED with that reason (never hidden), and core refuses (`remote-account`) as
      the backstop for a hand-edited settings.json. **Mobile: N/A** — the phone never mints an
      account and carries no skills concept.
  - **Account-aware readers** — transcript resolution is scoped per account (`transcriptRootFor`
    picks the account dir's `projects/`, composite cache key includes `accountId`); the same
    threading runs through the session-name poll, restart handoff, and `ChatPanel` (the ⌘M
    transcript view, `chat.readTranscript`). The **usage indicator** is per account (`claude-usage.ts`: scoped Keychain
    service only for managed accounts, then their credentials file; popover lists a row per account with **System**
    first). **Remote (SSH host) accounts are included** — see **Remote usage** below.
  - **Pickers** — New Claude exposes an account **submenu** (pane menu; flat entries in
    the dock; palette commands; TabBar sets the **per-project default**). A **local** project
    lists local accounts, an **SSH** project lists only accounts whose `host` matches its
    connection; both offer a **System account** option. An SSH project whose host has **no**
    matching accounts gets a disabled hint row instead of a bare System-only list
    (`sshAccountsHint` — pane submenu, dock, TabBar; the palette deliberately omits it: a
    disabled row would surface as a search result) saying accounts for this host are added in
    Settings → Accounts while the project is connected — local accounts being invisible there is
    correct (their credentials aren't on the host) but read as "multi-account is broken on SSH".
  - **Remote accounts** — selection + login + env injection, plus **usage** (below); no
    per-account transcript readers beyond env.
  - **Settings → Accounts is ONE machine-grouped surface for BOTH providers** (2026-09): a panel
    per machine (this one, then each saved SSH server ∪ the active project's server — a saved server
    with no accounts and no connection is folded into a footnote count), each holding a Claude and a
    Codex block with the SAME row, system row and Add button (`groupAccountsByMachine`). A remote
    machine's Add / Retry / Remove act ON that host over a **connected** project only — a
    disconnected host's Add is disabled and its Remove only forgets the record (the dialog says so);
    a remote id never reaches a LOCAL remove. Codex gained the remote lifecycle this needed:
    `codexAccounts.add/waitLogin/identity/remove` take an SSH `ctx` (desktop `src/main/codex-accounts.ts`
    → the `SshProjectManager.remoteCodex*` legs; the credential is written on the host by
    `codex login --device-auth` — the default browser flow calls back to the HOST's localhost), and
    `systemIdentity({projectId})` now asks the host instead of answering `null`.
  - **The remote spawn scopes the account BY PROVIDER** (`core/remote-account-env.ts`). It used to
    hand every `accountId` to Claude's `CLAUDE_CONFIG_DIR`, so a node bound to a managed Codex account
    on an SSH host got a Claude dir that does not exist and NO `CODEX_HOME` — its codex silently ran
    as the host's system login (`remoteCodexTmuxEnvArgs` existed with no caller). The system Codex
    account is left to the host's own env (a remote `CODEX_HOME` of the user's — a snap remap — must
    win).
  - **Switch Codex account on an SSH node** (2026-09) does NOT use the local three-phase reservation
    (it plans rollouts in LOCAL homes). It is one host-side exposure —
    `codexAccounts.switchThreadRemote` → `SshProjectManager.remoteCodexSwitchThread` →
    `remoteCodexExposeThread` (relay `expose-thread`): resolve the thread across every account
    catalog on the host, hardlink the one authoritative rollout into the target home, verify the
    target's app-server discovers it, roll the link back if not; an ambiguous thread is refused.
    Then the usual still-eligible check and a restart-shell recycle, with the rebind riding
    `beforeRecycle` (never a separate setNodes). A hardlink, not a copy: both accounts see ONE file,
    so there is no diverged-copy case. Needs the relay runtime on the host (node + codex + curl);
    without it the switch fails with a notice and nothing changes. `planCodexAccountSwitch` now
    refuses a target on another machine than the node (`hostKey`) — the switch never crosses
    machines (moving a local conversation to a host is `transferThreadToSsh`, a separate flow).
  - **Linked accounts** (`ClaudeAccount.configDir`) — a PRE-EXISTING local config
    dir the user already drives themselves (`export CLAUDE_CONFIG_DIR=~/.claude-2; claude …` in a
    plain terminal) adopted as a first-class account without a login node. Settings → Accounts →
    **Link existing config dir…** (or one click on a **Detected** dir) calls `claude-accounts:link`
    (core service): `~` expansion → `normalizeLinkedConfigDir` → string-only refusals (the system
    `~/.claude`, anything under `{userData}/claude-accounts`, an already-linked path) → `stat` →
    email from `<dir>/.claude.json` (missing = `email: null`, not an error) → managed hook install.
    `claudeConfigDirFor(id)` consults a **registered accounts source**
    (`registerClaudeAccountsSource`, both shells right after `settingsStore.init()` — BEFORE the
    mirror settings provider can flush, or the phone would be advertised a non-existent managed
    dir), so env injection, `transcriptRootFor`, the transcript index, usage rows and the pickers
    all resolve a linked id to the user's own dir with no per-caller branch. The transcript jails
    (`isSafeLocalTranscriptPath`, both raw listeners) accept `<linkedDir>/projects/**` for dirs
    **from settings only** — never a dir named by the POST. **Removing a linked account only
    forgets the record**: the `rm -rf` names `accountConfigDir(userData, id)` directly, so it is
    structurally incapable of reaching outside the managed root even if the settings row is gone
    before the IPC lands. The hook installer resolves `settings.json` symlinks and atomically updates their target
    (without replacing the link) — a profile whose `settings.json` symlinks to `~/.claude/settings.json` (the
    two-profile layout) stays a symlink; pinned by `claude-accounts-link-symlink.test.ts`, and
    switching that write to `renameAtomic` would be the regression (it replaces the link).
  - **Observed account** (`ObservedClaudeAccount`, `NormalizedAgentEvent.account`) — which account
    a session is ACTUALLY on, derived by the hook server from the payload's `transcript_path`
    (`<configDir>/projects/<slug>/<session>.jsonl`; `configDirFromTranscriptPath` walks up to the
    LAST `projects` segment, so `~/projects/.claude/projects/…` names `~/projects/.claude`, not
    `~`). `classifyClaudeConfigDir` is pure string matching, host-agnostic: managed local root →
    managed remote pattern (`…/.nodeterm/claude-accounts/<id>`) → linked (settings) → any
    `…/.claude` ⇒ system (`accountId: null`) → else `known: false`. It is a **LABEL** exactly like
    `verified`/`clientRevision`: attached to the normalized event in ONE place (the hook server),
    so both shells inherit it and neither raw listener changes; claude events only; never throws;
    **never reads the filesystem** (a forged POST naming `~/.ssh/projects/x` gets `known: false`
    and nothing is opened). Recorded by the mirror (`MirrorEntry.account`) and the renderer store
    (`agentStatus.account`, persisted like `agentId` — a hand-launched claude's identity exists
    nowhere else). **Effective account for READERS** = `data.accountId ?? observed.accountId`
    (`renderer/lib/accountChip.ts` `effectiveAccountId`): `readSessionName`, `context.ensure`, the
    transcript search and the ⌘M view use it; **spawn/env never does** (launch identity stays
    creation-time). The **account chip** (`components/AccountChip.tsx`, ONE component on the node
    header, kanban card, card modal and sidebar row) shows for any non-system account, and for
    system panes only when ≥ 2 distinct account keys (`sys` / `<id>` / `ext:<dir>`) are live on the
    core (`hasMultipleAccountKeys`, a primitive selector so headers don't re-render on every hook
    event). An unlinked dir is named by its last path segment (`.claude-2`, dashed chip) with a
    tooltip pointing at Settings → Accounts, where **Detected config dirs** lists it for one-click
    linking. Mobile: N/A (additive mirror fields).

- **Active Claude organization** (#552) — local Desktop and Server usage snapshots carry optional
  `organization` metadata from the SAME account's `.claude.json` (system, managed or linked).
  Read it even if Keychain/file credentials already have an email; unreadable/missing metadata
  preserves the email and usage. A known email mismatch drops metadata. Managed usage cannot use
  an unscoped Keychain token: a matching email alone does not prove it belongs to the same org.
  The popover names the org beneath the email; internal type/tier/id remain tooltip details.
  Refresh re-reads metadata together with usage; normal cache/poll intervals still apply.
  SSH's existing shell reader does not supply organization metadata and keeps its email-only
  fallback. Mobile's usage mirror currently omits it; displaying orgs there needs a follow-up
  mirror/iOS protocol change. No organization picker, credential writes or switching are added.

- **Bottom chrome shares a measured width budget** (issue #853). `CanvasPills` observes the canvas
  wrapper and actual dock, bounds the left row with an 8px gap, and uses a row above the dock when
  fewer than 200 CSS pixels remain. Rects are converted back through UI scale. Usage summary text
  ellipsizes; refresh never shrinks. Do not clip the whole row or give it a stacking context:
  usage/RAM popovers must escape independently above the sidebar and board. Desktop and Server
  share this renderer. The real-browser regression is `scripts/usage-layout.test.ts` (`CHROME_BIN`).

- **The usage indicator is scoped to the ACTIVE project** (`renderer/lib/usageScope.ts`, pure +
  unit-tested) — it describes **the machine that project runs on**, and nothing else. A local
  project shows this machine (system + managed local accounts + the billing providers, whose
  credentials are all local); an **SSH project shows that host's Claude and Codex accounts** — no local
  Claude, no local providers, no other host. Without this the panel showed every source at once:
  each addition was individually reasonable and the sum was unreadable, numbers from three
  machines sharing one line with nothing saying which was which. Deliberately NOT narrowed to the
  project's `defaultAccountId`: the local side lists every local identity, so the machine is the
  scope and the account is a row within it. The pill spells out the scoped machine's **system**
  account (falling back to the first identity with data, so a host used only through a managed
  login isn't blank), managed accounts stay popover-only — the rule the local side always had.
  `usageScopeKey`/`scopeFromKey` exist because the active project object is rebuilt on every node
  serialization: the zustand selector returns ONE primitive so the indicator doesn't re-render on
  every canvas edit. ⟳ refreshes only what is on screen, and `usage.remote({hostKey})` reads only
  that host (cache eviction still runs against the FULL target list, so switching between two SSH
  projects doesn't throw each host's cache away).

- **Grok billing failures** retain per-view HTTP status or a safe timeout/network/invalid-response category in `ProviderUsage.diagnostics`. The default view still runs after a credits failure; recovered limits keep their diagnostic. Only two successful empty views imply no quota. Never include raw exceptions, URLs or response bodies, or refresh/write credentials. Desktop and Server share the core reader and popover; provider-only errors must keep the pill visible.

- **Usage failure readouts** — an empty Claude snapshot with `status: error` says "Could not
  read usage." in both the single-account and multi-account popovers, including beside healthy
  provider rows. Nonempty snapshots retain their last-known bars on error; no error-specific
  authentication advice is inferred from the status.

- **Remote usage** (SSH hosts, `src/core/usage/remote-claude-usage.ts`) — the source behind the
  SSH scope above. v1 excluded remote accounts, which left a user whose Claude only ever runs on a
  server staring at an empty indicator while the host had perfectly good numbers.
  **The token never leaves the host.** The desktop could `cat` the remote `.credentials.json` and
  call the API itself — it already reads remote transcripts over the same master — but a bearer
  token pulled off a (possibly shared) server into another machine's memory buys nothing: the host
  can make the request itself. So core generates a POSIX **sh+curl** command, the shell runs it
  over the project's ControlMaster, and only the JSON answer comes back. Three details are
  load-bearing:
  1. **The token is piped into `curl --config -`, never `-H` on the command line** — argv is
     world-readable via `ps` on a shared host.
  2. **`.credentials.json` holds more than one `accessToken`** — every MCP server the CLI has
     authorized keeps its own under `mcpOAuth`. The extraction narrows to the `claudeAiOauth`
     object first (exactly as the local `parseCreds` does), because grabbing the file's first match
     sends an MCP token to the endpoint, earns a 401, and reports a signed-in host as signed out.
     Caught only by running the command against a REAL credentials file — which is why
     `remote-claude-usage.test.ts` runs the generated script under a real `/bin/sh` against a fake
     `$HOME` + fake `curl`, the same discipline as the canvas-control shim.
  3. **A read that could not run is `error`, never `unavailable`** — a dead master says nothing
     about whether the account has a subscription, and 'unavailable' silently drops the row.
  4. **A failed read keeps the last good numbers** (`holdLastGood`, local AND remote): the
     endpoint answers **429** on a budget every Claude CLI using the same login also spends
     (measured on a host running 54 `claude` processes: 429 for minutes on end), and replacing
     the bars with "Could not read usage" made rows flicker for no change in the account. The
     held snapshot is `status: 'error'` + the old limits + the OLD `updatedAt`, so the debounce
     must key on the READ's time (`lastFetchAt`/`remoteCache.at`), never on `updatedAt` — keying
     it on the numbers' age re-reads on every call and hammers the endpoint that said 429.
  Shape: `remoteUsageTargets` (pure) elects ONE connected project per host (several projects share
  a host's `$HOME`) and offers its system `~/.claude` plus every managed account pinned to that
  host. The service (`usage:remote`) caches per target under the usual debounce, evicts targets
  whose host disconnected, and coalesces concurrent reads. **On demand, never polled** — each row
  is an ssh exec plus an HTTPS request on someone else's machine; the renderer asks on mount, on
  popover open, on ⟳, and when the active project's connection comes up (an SSH project is opened
  before its master is ready). Deps are injected exactly like
  Context Link's (`src/main` supplies the ControlMaster; **Server Edition passes none** ⇒ `[]`, so
  the UI needs no capability check). Own Settings switch (`claude-remote`), because hiding local
  Claude usage must not silently take the hosts down with it. **Mobile: N/A** — the
  slice pushed to a host still drops `usage` (a host reading its own numbers back off us is
  pointless), and no keychain leg exists remotely (a headless macOS host would hang on the prompt,
  so a mac host reports nothing).

- **Codex SSH usage** (`core/usage/remote-codex-usage.ts`) uses host-side Node JSON parsing
  and curl, reusing the local Codex quota mapper. Read only `tokens.access_token` and
  `tokens.account_id`; pass headers through stdin, disable curl config/redirects, and return
  only sanitized quota fields. Never download credentials, refresh tokens, or launch a remote
  app-server just to refresh usage. The host needs Node and curl; missing tools/transport or
  malformed responses are errors, not proof of a logged-out account. System reads use the
  host login environment's `CODEX_HOME`; managed reads use the validated account's remote
  home. Cache identity includes provider, host, account and connection/home identity.
  Remote Codex rows obey the Codex visibility setting and carry no Claude default-account
  or bulk-move actions. Desktop supports SSH reads; Server Edition keeps its local core
  readers and absent SSH dependency. The private mobile reader is separate. Device checks:
  `docs/codex-ssh-metrics.md`.

### Adding a new agent (or a new model) — what to watch out for

Every rule below is a mistake the grok branch or the codex/gemini-parity branch **actually made**, and
each one cost a review round or shipped a wrong number to the user. Read the concrete failure, not the
principle. Per-agent write-ups: `docs/grok-agent.md`, `docs/gemini-agent.md`.

**The mechanism**

1. **A capability is a membership list plus ONE leaf.** Add the id to the list in
   `src/shared/agents/config.ts`, write the one per-agent thing that list gates (a normalizer, a
   reader, a table row), and every consumer lights up — the whole point of the design. What you must
   never do is fork behavior at a call site with `=== 'claude'`; ask through the helper.
2. **Ask what ELSE the list gates before joining it.** `hasUsage` gated **three** features, not one.
   Joining `USAGE_CAPABLE` for the context meter also switched on `context.ensure` and the find bar's
   transcript index, both of which resolve through *claude's* `resolveTranscript` — whose **cwd
   fallback** then handed a codex node **the newest claude transcript for that cwd**: a stranger's
   session as its meter (wrong numerator *and* denominator, flapping against the correct tail) and that
   session's messages as its search hits. Preconditions were default-true, so it would have shipped.
   The fix was a new pure predicate (`readsClaudeTranscript`) reusing an existing list, not a fourth
   list meaning the same thing. **Grep every consumer of the helper before you add an id to its list.**
3. **A read leg and a write leg are different facts, and may need different lists.** Gemini names its
   own sessions but has **no rename command**, so `TITLE_READ_CAPABLE` (read) split from
   `RENAME_CAPABLE` (write), with `read ⊇ write` pinned as an invariant. One list would have lit the
   rename UI on a node where the write silently does nothing — the worst kind of feature, one that
   looks like it worked.
4. **State Desktop / Server Edition / Mobile for the capability, even when the answer is "N/A".**
   Put the logic in `src/core` behind `CorePlatform` or the Server Edition silently doesn't have it,
   and give `window.nodeTerminal` a REAL bridge implementation or a documented degrade — a `noop` stub
   compiles fine while doing nothing. (Live example: the session-title READ has no server handler at
   all, so it is stubbed for **claude too** — a pre-existing gap that keeps being rediscovered per
   agent.)

**Measuring the CLI**

5. **Measure the CLI; do not assume claude's shape.** Three real bugs, all from assuming:
   - grok's `--` is **end-of-options**, so a flag appended *after* the prompt separator is a
     positional — silently swallowed into the prompt, or a clap usage error that kills the launch.
     Where the flag lands is decided at the **composed** layer (`createAgentNode`); a
     `withPermissionMode` unit test passes while the composed line is wrong.
   - codex's `total_token_usage` is **CUMULATIVE**, not the live context: against its own window it
     rendered a 13%-full session at **79%** and would have crossed 100% two turns later. The right
     field is `last_token_usage`.
   - `cached` tokens are **INSIDE** `input` for codex and gemini, and **OUTSIDE** it for claude (whose
     reader therefore sums them). Copying claude's formula double-counts. **Do not unify the
     formulas.**
6. **Prefer the agent's own stated number over one you infer.** Codex prints
   `model_context_window` right beside its usage — use it. When there is none, mirror the CLI's own
   resolver rather than building a per-model allowlist: gemini's `tokenLimit()` is a family rule with
   a **1M catch-all default**, so an unreleased model gets the *right* answer where an allowlist would
   be confidently wrong, silently. **And if you cannot establish a trustworthy denominator, ship no
   meter** — a percentage over a guessed window is a wrong number presented as a fact. This used to
   cite grok as the example of having no meter; grok turned out to be the BEST case for this rule,
   stating `contextTokensUsed`, `contextWindowTokens` **and** the resulting `contextWindowUsage` in
   `signals.json` (all three present in 22 of 22 measured sessions, and the stated percentage agrees
   with the division in all 22 — an oracle pinned as a test). What was missing was never the number:
   it was a comment nobody could check, naming the wrong file.
7. **A closed set beats a substring, for notification/event types.** Grok's
   `type.includes('permission')` matched a notification grok fires before *every* tool call, so a
   working node strobed NEEDS YOU: unread dot + chime + OS notification + phone inbox card, per tool
   call. Gemini is matched `=== 'ToolPermission'` and stays quiet on an unknown type. A badge stuck on
   a finished node has no later hook to clear it, so widening "to be safe" is the unsafe direction.
8. **"Supports" can be as dishonest as "doesn't support."** Codex claimed `manual` / "Ask each time"
   while emitting **no flag** — but its built-in default is `OnRequest` ("the model decides when to
   ask"), so two dropdown entries collapsed onto one behavior under a label that promised otherwise.
   Rule: a mode the CLI cannot express emits **no flag** (never a substituted nearest match), and a
   mode it *can* express must actually emit it. Derive the UI copy from the mapping
   (`unsupportedModesNote`, `permissionModeAgentIds`) so a sentence cannot drift from the table.
   **The nearest match is most dangerous on the DEFAULT mode:** gemini has no value for `auto`, and
   `auto` is `DEFAULT_PERMISSION_MODE`, so translating it to `auto_edit` ("auto-approve edit tools")
   would have widened permissions for every existing gemini node at upgrade, with `modeSupported`
   answering `true` so the derived copy stayed silent. Check what an UNTOUCHED setting emits before
   you accept any mapping.
9. **A capability gate that is fed by a version probe belongs to the agent it probes.** Claude's
   `auto` gate is fed by `claude --version`; applying it to any other agent downgrades that agent's
   sessions on a machine whose *claude* is old or absent. `activePermissionMode` gates only
   `'claude'`, and every hint string names Claude for the same reason. An agent needing its own gate
   adds one beside claude's.

**Not writing the same rule twice**

10. **A duplicated rule drifts, and this branch was bitten three times.** The remote installer's hook
    event lists (it subscribed gemini to *claude's* event names, so remote gemini reported nothing at
    all), grok's raw-listener field decoding, and the two shells' session-name sweep gates (reverting
    both to `canRename` left the entire suite **green** while silently skipping every gemini node).
    The fix each time was **one definition in `src/core`** consumed by both shells — a default inside
    core beats an argument each shell passes correctly today.
11. **Both shells' raw hook listeners must stay in parity** (`src/main/index.ts`,
    `src/server/agent-status.ts`). If you add a branch to one, add it to the other or write down why
    not (the desktop's extra skip for remote SSH nodes is a legitimate asymmetry: the server has no
    SSH-project manager).
12. **Widen the transcript-path jail per ROOT, never to `$HOME`.** Hook POSTs can arrive over the
    remote reverse tunnel, and `isSafeLocalTranscriptPath` exists so a forged one cannot aim a read at
    `~/.ssh/id_rsa`. Add the narrowest directory that holds the transcripts (`~/.gemini/tmp`,
    `<codexHome>/sessions`) and honor the agent's own relocation env var — getting that wrong fails
    **closed** (the meter silently never fills), which is the quieter and therefore worse failure.
13. **Re-validate a hand-editable value at the interpolation site, not by its type.** Modes come from
    git-shared JSON and end up on a tmux `send-keys` line. A table lookup guarded only by
    `mode in table` accepted a forged `constructor` and returned a **Function** headed for that
    command line; `isPermissionMode` at the top of `approvalFlags` is what closes it. Same rule as
    `SAFE_SESSION_ID`. An unrecognized value must yield the **bare, safe** command.

**Degrading, and admitting what you did not measure**

14. **A guess must degrade to nothing, never to something wrong.** A title reader that cannot resolve
    returns `null` (the node keeps its own name); an unknown notification type is a no-op; a failed
    probe means the bare command, never a blocked launch. Say in the code which facts are *composed*
    rather than captured (gemini's resumed-transcript shape is) and what the wrong-guess cost is.
15. **Kill the "in place" actions carefully.** An exit sequence must be the CLI's documented primary
    and **bare**: gemini's `/quit` also takes `--delete`, which exits *and permanently deletes the
    session history* — the very conversation the restart exists to resume. It has its own test.
    Refuse the restart while the node is `working` **or** `blocked`: an exit line typed into a
    permission prompt **answers** it.
16. **Write the device checklist for what you could not run.** Every unverified claim becomes a
    numbered item; group the ones that fall out of a single capture run. `docs/grok-agent.md` §9 and
    `docs/gemini-agent.md` §9 are the format.
17. **Extend the base harness mapping, never a frontend allowlist.** Model support is
    `MODEL_SWITCH_CAPABLE` plus the protocol/env/flag leaf in `shared/agents/model-gateway.ts`.
    Frontends call `canSwitchModel` / `modelsForAgent`; they never spell Claude, Codex or a custom
    id themselves. This makes `baseAgent:'claude'` inherit discovery, filtering, environment and
    command grammar as one unit instead of four copies that drift.
18. **A model switch must refresh the shell environment without printing the key.** An already-live
    shell does not inherit a later `tmux set-environment`, and prefixing the resume line with
    `KEY=secret` leaks it into the pane/history. SIGTERM the pane's foreground non-shell process
    group (a typed `/exit` can land in the agent composer as prompt text), recycle the persistent
    session, and let cold restore resume with the new model under the newly injected environment.

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
- **`readMemInfo` has exactly one home** (`core/session-memory.ts`); `session-budget.ts` imports and
  re-exports it. The reaper's watermark and the pill must never disagree about how much RAM is free,
  and a second copy is exactly the drift this file warns about elsewhere. `null` = could not read,
  never zero.
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
  would be a third concept for the user and a second exit path to keep in step with Eco's. Which
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
  live on one machine at once (`node-terminal` for a nodeterm running ON it, `nodeterm-rmt` for one
  SSH-ing INTO it) and the sweep lists **both**, while the kill targeted one — so every row off the
  other socket got "this stops its tmux session" and a kill that landed nowhere. Not exotic: a host
  running its own `nodeterm-server` while being SSH'd into is exactly that, and the local mirror
  (this machine's panel listing the `nodeterm-rmt` sessions another machine's nodeterm spawned here,
  all orphans locally) is the same shape. A kill that knows only a NAME therefore goes to **every
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

**Offscreen release makes the macOS reaper bug far more visible, and the two shipped days apart.**
A node released while offscreen detaches its PTY client — so it becomes a DETACHED tmux session and
joins the reaper's candidate pool once past the 6 h grace. On a Mac reading `os.freemem()` the
watermark was permanently tripped, so those sessions were culled on the next sweep. More automatic
detaching + an always-true pressure signal is why the symptom read as "my sessions keep
disappearing" rather than as an occasional cull. The `vm_stat` reader is what makes the pool safe
again; the grace window was never the thing that was wrong.

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
  every request and every cast but `watch:chat` (Commenter and Control links) and, on a Control link
  only, the three controller casts `watch:unlock` / `watch:input` / `watch:release`; it passes out only
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
  resets neither; only Allow control again clears the lock; it and a new password reset the count).
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
- The stream filter sees every byte, has NO length cap (a cap leaked a measured clipboard), and every
  join resets it `midStream`, never to text mode and never on a keyframe. `captureVisible` never returns
  history (exact `=nt-<id>:`, no `-S`; session host, plain shell and a Zellij node get no keyframe). A
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
  web repo a re-vendor. Chat text is stripped of controls AND bidi controls there, capped by code point.
- Never silent about what a viewer gets. Where local terminals are not tmux (Windows' session host, tmux
  off or missing, Zellij) a viewer can watch only a terminal the app has OPEN (there is no read-only
  client to spawn): the create dialog says so, and a refused join turns the chip amber `LIVE · 1
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
  over the 25 MB load cap — re-encoding everything would flatten PNG/WebP alpha); off macOS, HEIC or
  an over-cap image is refused at import time, where the picker shows the reason.
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
  `onMoveStart`/`onMoveEnd` via classList so a pan does not re-render Canvas) — the tint alone
  carries the contrast guarantee.
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
- **Glass slider + refraction** (Settings → Appearance, shown only under Liquid Glass; iOS 26's
  Clear ↔ Tinted). `settings.glassTint` is a slider POSITION, not an alpha (`null` = the Readable
  tick, read through `resolveGlassSlider`): every surface has its own readable alpha, so each maps
  the position through three points — `GLASS_CLEAR_ALPHA` 0.2 at Clear (terminal nodes; chrome controls 0.35, text surfaces never below readable — see Liquid Glass chrome), its OWN computed readable
  alpha at `GLASS_READABLE_TICK` (0.7), `max(readable, 0.95)` at Tinted (`glassSliderAlpha`). At the
  tick every surface is exactly at the alpha `glassTintAlpha`/`glassChromeAlpha` computed, and every
  alpha right of it is higher — so Readable→Tinted keeps 4.5:1; left of the tick the row says the
  guarantee is off. Measured: chrome dark 0.20 / 0.70 / 0.95, chrome light 0.20 / 0.745 / 0.95,
  nodeterm-dark 0.20 / 0.675 / 0.95 (Clear / Readable / Tinted). App.tsx sets `--glass-t` (blur
  16→28px on chrome and × 0.85 = 13.6→23.8px on terminal nodes via `--glass-term-blur`; saturation
  `--glass-sat` 180% at Clear → 150% from the Readable tick to Tinted, text surfaces a flat 150% —
  round 2 N9: 1.6–2.0 turned glass olive or pink over bright wallpapers). **Refraction** is ONE shared SVG filter
  (`components/GlassRefraction.tsx`, `#nt-refract`: a 256² edge-lens displacement map generated once,
  `primitiveUnits="objectBoundingBox"` so one filter fits every element), referenced from
  `--glass-blur` as `url(#nt-refract)` — no per-node filters. **It runs LAST in the chain**
  (`blur() saturate() url()`) and composites over its SourceGraphic so its output is opaque: first in
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
  minimap, zoom controls and terminal nodes.
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
  during a header rename only cancels the edit). Terminal cards get a LIVE second view of the
  tmux session (`ModalTerminal.tsx`): the pty subscriber ledger is keyed by the composite
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
  (assignment written UN-pruned — the fresh node isn't in the derived list yet). The column
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
  shell, grid + snap, **default node size** (`defaultNodeWidth`/`defaultNodeHeight` — new
  terminal/agent nodes only, clamped in `terminalNodeSize()` in `state/workspace.ts`),
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
which is the first-animation step above again. Only the attention glow (and its minimap beat) stays
infinite — needs-you is the one state that must keep pulling the eye — and the idle gate covers the
unfocused case. The driven-browser rope still flows (it lasts only while an agent drives the page).
`styles.animation-gate.test.ts` pins the bounded shorthands, the resting values and the keyframe
endpoints.

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

## SSH projects on Windows: the in-process transport

Windows' own OpenSSH cannot multiplex, and that is measured, not assumed (windows-latest,
`OpenSSH_for_Windows_9.5p2`): `ssh -M` fails with `getsockname failed: Not a socket`, and a child
carrying `ControlPath` FAILS rather than falling back — so every remote command, terminal and
tunnel of an SSH project failed on a stock Windows machine. Git for Windows' ssh (10.5p1) starts a
master but every session over it is reset and falls back to a full login per command. So on
Windows the app does not run the ssh binary for SSH projects at all: `src/core/remote-ssh/native/`
holds ONE `ssh2` connection per ControlPath and carries every exec, pty, SFTP session and reverse
unix-socket forward over it. POSIX keeps OpenSSH untouched.

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
  that is why HMAC-SHA1 appears; CodeQL's alert on it is dismissed with the reason), publickey
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
  **ProxyCommand stays refused by name**, on the target and on a hop.
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

- **A Team Access invite that shares ONE project is a boundary, not a label**
  (`core/relay/scoped-guest-policy.ts`, wired by `main/remote/relay-host.ts` as the core relay
  host's hooks). The invite is consent to run commands IN that project, and nothing else: inbound is
  an allowlist (`SCOPED`) where a node id must belong only to the shared project (or be one the
  guest just created over `canvas:mut` that no project holds yet — the host saves on a debounce, so
  a new terminal's first `pty:create` precedes its node on disk), paths realpath inside the project
  root and outside userData (symlinks and dangling links refused), `pty:create` loses `sshRemote`
  and defaults its cwd to the root, `workspace:save` is refused; outbound reuses the viewer policy's
  per-project event/terminal-frame attribution. An unknown channel is refused, and the guard test
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
  session is VERIFIED gone.** The kill runs on `nodeterm-rmt` ONLY (`RMT_TMUX_SOCKET`), with the
  exact target `-t '=nt-<id>'` built only through `sessionName`, then a `has-session` per node.
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

**Known limitations** (full list in the doc): non-editors still receive cross-project presence and
`context:update` metadata (deploy one core per team); a viewer's socket backlog over 1 MB still
pauses the shared pty through Stage 2 backpressure; the canvas authority's own limits (a project's
non-content fields stay last writer wins between tabs, the share-time window, oversized nodes, board
edits to another core, load-time repairs that are never cast, the card modal's comments on a relay
tab) are under "Known limits" in the doc.

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
it, so a Windows failure never strands the mac+linux release) and with **no update-feed leg**:
`dist:win` stamps `nodeTermUpdates=disabled`, so the shipped app's updater is cleanly off (no
latest.yml anywhere, no 404 polling; users update by downloading the next installer). Do not
add `*.yml`/`*.blockmap` to that job's upload globs — that IS the auto-update leg, and it waits
on signing. `bootstrap-windows.bat` (repo root) takes a fresh Windows
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

**Follow-ups, in order:** code signing, then Windows auto-update wiring (electron-updater NSIS leg
+ `latest.yml` on the nodeterm.dev feed — blocked on signing: an unsigned auto-update is a
downgrade in trust), and the fork's PE-identity polish (electron-builder leaves `OriginalFilename`
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

Auto-update uses **electron-updater** (`src/main/updater.ts`, `initUpdater(onBeforeRestart?)` from `index.ts`):
runs **only when `app.isPackaged`** (dev = no-op), checks on launch + every 6h, auto-downloads,
forwards the lifecycle (`update-available` / `download-progress` / `update-downloaded` / errors)
to the renderer over IPC. `components/UpdateCard.tsx` shows the strip + **Restart to update** →
`updates.restart()` → `autoUpdater.quitAndInstall()`; on `update-downloaded` an OS notification
also fires when the window is unfocused. Exposed via `window.nodeTerminal.updates` (`UpdateApi`).
macOS *silent* self-install requires a signed+notarized build; unsigned builds still surface
the card for a manual download.

**Backend check feed** (`src/core/check.ts`, successor to the static `announcements.json`): the
**main process** calls `GET https://api.nodeterm.dev/v1/check?version=&os=&channel=stable` (so the
renderer CSP stays `'self'`) on launch + every 6h, cached 5 min, returning `{ messages, update }`.
Exposed split over two IPC handlers: `announcements.fetch()` → `messages`, `appUpdatePolicy` →
`update`. `components/AnnouncementBanner.tsx` (stacked above `UpdateCard` under the tab bar in a
`.top-banners` column) shows the newest message the user hasn't dismissed (dismissed `id`s persist
in `localStorage`); `update.mandatory`/`minSupported` flips `UpdateCard` into a blocking required-
update state. The call no-ops under `DO_NOT_TRACK`/`NODETERM_TELEMETRY_DISABLED` or in unpackaged
builds (unless `NODETERM_API_BASE` targets a local server). Schema example:
`docs/announcements.example.json`. **Telemetry** (`src/main/telemetry.ts`) is a separate opt-out
ping to `api.nodeterm.dev/v1/ping` (version/OS on launch + daily), gated on
`settings.telemetryEnabled` + the same build/DNT guards; toggle in Settings → Privacy.

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
  and wire it through `KanbanView`/`SessionCard`/`CardModal` in the SAME change. Node menu rows live in ONE builder, `renderer/lib/nodeActionItems.tsx` (canvas menu, sessions sidebar, both boards' card menus via `kanban/cardMenu.tsx`); a card takes only `BOARD_NODE_ACTION_IDS` and writes through `nodeWritesFor(projectId)`, because the Omni board acts on nodes of projects that are not on the canvas. Kanban itself is
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

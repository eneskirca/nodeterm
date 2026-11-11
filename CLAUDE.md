# CLAUDE.md

This is the index of invariants for working in this repo. It is loaded automatically by Claude
Code into every session, so it is kept SHORT: each subsystem section states the rules a change must
not break and links to its full write-up (the reasoning, measurements and incidents) in
**`docs/reference/`**. **Before changing a subsystem, read its reference doc.** When you add or
change a rule, put the full text in the reference doc and, only if it is load-bearing, a one-line
summary here — do not grow this file back into the reference.

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

**Full reference: [`docs/reference/commands-and-native-patches.md`](docs/reference/commands-and-native-patches.md).**

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build
npm run typecheck  # tsc for node + web projects — the fastest correctness gate
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
npm test           # vitest (remote e2e suites skip without the companion server repo)
```
- `rebuild`/`postinstall` run `scripts/patch-node-pty.mjs` first (darwin ptmx leak + Windows HPCON
  leak, version-pinned). **If `src/main/node-pty-patch.test.ts` is red, your `node_modules` is
  unpatched, not your code** — run `npm run rebuild`.
- Also in the reference: direct Windows agent messaging (`core/native-windows-pane.ts`, the
  settled-submit second Enter, Windows probe budgets).

## Process model (Electron, three contexts)

**Full reference: [`docs/reference/process-model.md`](docs/reference/process-model.md).**

- `src/main` = Electron shell (window, IPC, dialogs, `CorePlatform` impl). The renderer never
  imports it. `src/core` = Electron-free service core talking to its shell ONLY via `CorePlatform`
  (`no-electron.test.ts` enforces). `src/server` = Server Edition shell (node:http + ws, WS-RPC,
  `src/renderer/bridge` shim; must not import electron or `src/main`). `src/preload` = the only
  bridge (`window.nodeTerminal`, contextIsolation on). `src/shared` = types + `ipc.ts`, the single
  source of channel names — never hardcode a channel.
- PTY output flows `pty:data:<sessionId>` main→renderer; input `pty:write`. node-pty is external.
- Process death/hangs are telemetry only (`[process]` / `[webgl]` log lines), never new triggers.
- **Server Edition sign-in** rules (rate-limit slot reserved before the body, async scrypt behind a
  2-slot gate, one same-origin rule for `POST /auth/*` + WS, server-side sign-out, proxy-header trust
  needs the secret on loopback) are each a measured finding — see the reference before touching auth.

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

## State & persistence model

**Full reference: [`docs/reference/state-and-persistence.md`](docs/reference/state-and-persistence.md).**

- **React Flow is the single live source of truth** for nodes; `state/workspace.ts` holds only
  pure helpers (factories, group transforms, `nodeStatesToFlow`/`flowToNodeStates`). No mirror store.
- Schema v3: `workspace.json` is an **index of refs** (folder / ssh / local-data / folder-data);
  content lives in `<cwd>/.nodeterm/project.json` (git-shared) or `userData/inline-projects/<id>.json`;
  machine-local fields (`id`, `viewport`, accounts, breadcrumbs, `localExec`, …) ride the index entry
  and must never be written to the shared file.
- Never blind-write: a lower `rev` never overwrites a higher one; an empty candidate never
  overwrites a populated file; a failed read is never evidence of absence; **probe before binding a
  folder** (it is a write). SSH mirror writes are atomic, read-compared first, and only a READ (not a
  write ack) retires a deletion tombstone.
- The core's own writes ride `workspace:server-change` (three-way merged), never the outside-edit
  conflict channel. Unreadable refs stay as greyed `unavailable` tabs, never dropped.

## Projects (tabs)

**Full reference: [`docs/reference/projects-tabs.md`](docs/reference/projects-tabs.md).**

- React Flow holds only the ACTIVE project's nodes; `commitActiveToStore()` runs before every
  switch/add/delete. The commit's epoch tag lives in React STATE beside the nodes (`nodesEpoch.ts`),
  never a ref alone — a ref-only tag once wrote an SSH project's nodes over a local one.
- The node subtree's session follows the project React Flow's STORE holds (`useFlowStoreOwner`),
  never `activeProjectId`. **A remote project's node never starts on this core** (offline relay
  session, `spawnBelongsElsewhere`).
- Close project is non-destructive (tmux keeps running; confirm names the session count); permanent
  delete only via "Recently closed" ×. Closing a node keeps a POINTER to its transcript, machine-local.
- Folder ↔ project is deduped; tab order is one shared order with the sessions sidebar; canvas lock
  freezes the camera only.

## Terminal session continuity (tmux)

**Full reference: [`docs/reference/tmux-continuity.md`](docs/reference/tmux-continuity.md).**

- Each terminal runs in `tmux new-session -A -D -s nt-<nodeId>` on socket `-L node-terminal` with a
  generated config; sessions survive app restarts. SSH projects use the SAME socket name on the host.
- **Every node-id target goes through `exactPaneTarget`/`exactSessionTarget`** (`=name:`) — bare
  targets prefix-match another node. Every sync tmux call is bounded (`runTmuxSync`). Remote tmux
  calls start with `remoteTmuxPathPrologue()`. The local tmux client spawns from home, not the node cwd.
- **tmux owns the mouse, scrolling and the alternate screen** — do not take scrolling away from tmux
  again; copy goes via OSC 52 (`terminal-features ",*:clipboard"`, never `Ms=`), no `pbcopy`.
- **Every memory lever asks whether the kill ends live work** (`terminal/live-work.ts`) — on a
  plain-shell fallback the pty IS the shell. A remote node is NEVER spawned locally (`requireRemote`);
  remoteness comes from its PROJECT. A delete's remote kill is checked and a failure is recorded as a debt.
- Cold restore (reboot): `fresh` flag, scrollback snapshot replay, agent `--resume` — but only
  tmux's own exit 1 is evidence a session is absent, and a dead transcript id launches bare.
- Before asking tmux about a pane, check whether the emulator already knows; sendText uses
  `paste-buffer -p` unconditionally. Codex TUIs run `--no-daemon` (feature-detected, awaited).
- Also in the reference: Pause/Eco/bulk pause rules, offscreen release, park window, WebGL budget,
  Zellij backend, SSH connect early signal + prewarm, remote pty spawn gate, seeding a fresh xterm,
  character widths.

## Terminal node lifecycle (gotchas)

**Full reference: [`docs/reference/terminal-node-lifecycle.md`](docs/reference/terminal-node-lifecycle.md).**

- `TerminalNode.tsx`'s xterm + PTY are created once per `[respawnNonce, offscreenEpoch]`; never
  change a node's id. The offscreen visibility observer lives in its own mount-stable effect.
- No React StrictMode (double-mount = two PTYs). Hover guard + sloppy focus by default; click-to-focus
  is one hook (`useClickToFocus`) bound to the stable `.term-node` root.
- The wheel boundary is decided by hit test (`.nowheel`); overlays over a LIVE terminal need
  `pointer-events: none`. FitAddon hosts stay `content-box`.

## Node kinds (all rendered by React Flow custom nodes)

**Full reference: [`docs/reference/node-kinds.md`](docs/reference/node-kinds.md).**

- Kinds: `terminal | sticky | group | editor | diff | video | web | browser | files | subagent |
  loop | dino | trigger | simulator | whiteboard`; `subagent`/`loop` are render-only, never persisted.
- **Every kind must be registered in `lib/reopenNode.ts`** (`UNRESTORABLE` or a `buildBase` case) —
  two kinds have shipped dead ⇧⌘T entries by missing this. New kinds place through `placeSized`.
- Markdown links never navigate the app window (one delegated listener; new markdown surfaces render
  inside a listed container). Whiteboard saves are compare-and-set. Run nodes never type repo
  content into a shell (POSIX launcher file). Webview keep-alive depends on pool order never changing.
- Also in the reference: ⌘M view, file links, image paste receipts, files node, simulator, browser
  control geometry.

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

**Full reference: [`docs/reference/open-recent.md`](docs/reference/open-recent.md).**

- Lists past conversations for agents with a measured on-disk shape (claude, codex, gemini, grok,
  copilot); titles are untrusted display text; only the re-validated session id reaches a pane.
- Resumes through `createAgentNode`'s `resumeSessionId` (the cold-restore assembler) under the
  account that HOLDS the history; never into an SSH project or relay tab; a removed folder is refused.

## Session memory (the RAM pill + the per-session panel)

**Full reference: [`docs/reference/session-memory.md`](docs/reference/session-memory.md).**

- RAM pill + per-session panel; scope = `usageScopeKey`. The memory is agent CLIs' own V8 heaps,
  not a leak; the reaper is deliberately unchanged.
- **`ok:false` is not `ok:true` with no rows** at every layer; "no tmux server" is an answer only via
  the anchored classifier. Local reader uses `/proc/<pid>/status`, never `statm`. SSH scopes are never
  polled. The pill alone owns `startHostPoll`/`stopHostPoll`. Kills fan out to every socket only when
  explicitly asked. Pause (not kill) is the panel's main action. See also `docs/session-memory.md`.

## Live links (Pro browser link to one terminal: watch, chat, or type)

**Full reference: [`docs/reference/live-links.md`](docs/reference/live-links.md).**

- `watchLink:*` is host-only; watchers use their own policy (never `decideAccess`); controller input
  reaches the PANE via `send-keys -H` / `paste-buffer`, never a tmux client; the Control password is a
  scrypt hash only. `src/shared/watch-link/` is vendored into nodeterm-web — keep it isomorphic.
  Details: `docs/live-links.md`.

## Dev-server ports (the Ports chip + same-port SSH forwarding)

**Full reference: [`docs/reference/dev-ports.md`](docs/reference/dev-ports.md).**

- Discovery by OWNERSHIP (socket owned by a process in the node's pane tree), never probing. Tool
  output is attacker-influenced: parse ss groups strictly and cross-check names with `ps`.
- Forwards bind `127.0.0.1` only, follow the server's bind address, refuse a taken local port (never
  silently move), confirm privileged ports, and are cancelled when the session ends or the port goes.
  Not served on Server Edition.

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

**Full reference: [`docs/reference/node-icons.md`](docs/reference/node-icons.md).**

- `data.icon` (emoji / lucide glyph / image), terminal nodes only. `project.json` is hostile input:
  `normalizeNodeIcon` runs at BOTH serializer seams; image paths must look like images, split on both
  separators, refuse UNC; `localIconCwd` is the one cwd rule. Images are copied + downscaled.

## Desktop wallpaper + Liquid Glass (Settings → Appearance)

**Full reference: [`docs/reference/wallpaper-liquid-glass.md`](docs/reference/wallpaper-liquid-glass.md).**

- Wallpaper and the Liquid Glass appearance are opt-in. Images reach the page as data: URLs from core;
  `background-image` longhands only (var() shorthands over ~2 MB are dropped).
- **Never translucent without a working blur, and glass never fades** (backdrop roots).
  `styles.glass-traps.test.ts` + `scripts/glass-trap-probe.mjs` guard it; new glass surfaces go in
  one of the two lists at the end of styles.css. Contrast alphas are computed (`glassContrast.ts`).
- Glass terminals frost a STATIC wallpaper copy, not a live backdrop-filter (measured 92%→42% GPU).
  Accessibility (Reduce Transparency / Increase Contrast / Reduce Motion) outranks the slider.

## Keybindings (registry, overrides, dispatch)

**Full reference: [`docs/reference/keybindings.md`](docs/reference/keybindings.md).**

- One module, `src/shared/keybindings.ts` — do not split it. Overrides in `settings.keybindings`,
  sanitized at read. Two dispatch owners per shell (renderer bubble-phase listener + main's closed
  allowlist / the Server Edition bridge for ⌘M). Bare keys only in `board` scope. Never read
  `settings.speech.shortcut`. `isHoldChord('')` is true — check `=== ''` first. ShortcutsPanel is
  derived from the registry. `terminalFocused` is a mirror that fails safe to `false`.

## Canvas interaction & panels (`Canvas.tsx` is the hub)

**Full reference: [`docs/reference/canvas-interaction.md`](docs/reference/canvas-interaction.md).**

- **"Go to node" computes the viewport and applies `setViewport` — never `fitView`** (deferred fits
  collapse to the origin). Tidy canvas keeps orchestrators first (`openerByTarget` is the one opener
  relation); arrange-by-lineage and group arrange return the SAME array when nothing moves.
- The add menu's submenu depth cap is structural (third level silently dropped); grouping is
  rearrangement, never a filter.
- Worktrees bind to group frames; one store/poller (`state/worktrees.ts`); a failed git read is never
  absence; `worktreePathKey` for comparisons; never a path a shared settings file redirects outside the repo.
- Kanban: dual-source board over the mounted canvas; sanitized at every seam; rank strings; board
  dispatch only from the person's own move; consent is machine-local.
- Window never raises without a user action; window geometry restore drops unreachable positions.
- Also in the reference: context menus, undo, breadcrumbs, canvas layouts, directional focus,
  explorer, source control, GitHub issues/PR sync, settings, window chrome.

## Idle energy: an animation is a frame loop, not a decoration

**Full reference: [`docs/reference/idle-energy.md`](docs/reference/idle-energy.md).**

- **One running CSS animation keeps the whole window at display rate.** Every infinite animation
  reads `--nt-anim-state` (`styles.animation-gate.test.ts`); status glows are bounded and settle lit
  (only needs-you stays infinite); the covered-canvas gate is `data-nt-canvas`; xterm under a board is
  paused via `board-render-pause.ts`. Verify the COMPUTED play-state, not the declaration.
- Never promote the React Flow viewport (`will-change`).

## Performance: measure it, then fix what the measurement names

**Full reference: [`docs/reference/performance.md`](docs/reference/performance.md).**

- Measure first (CDP on `npx electron-vite dev --remoteDebuggingPort 9333`), say which build the
  numbers come from, write before/after in the commit. Known rules: no viewport promotion; no
  backdrop-filter on surfaces that redraw; empty node-change batches must not reach `onNodesChange`;
  coalesce per-terminal work on a project switch; hints fail toward old behaviour.

## SSH projects on Windows: the in-process transport

**Full reference: [`docs/reference/ssh-windows-native.md`](docs/reference/ssh-windows-native.md).**

- On Windows (or `NODETERM_NATIVE_SSH=1`) SSH projects use ONE in-process `ssh2` connection per
  ControlPath. Call sites keep building OpenSSH argv; `ssh-argv.ts` strictly parses it back. Host-key
  type is pinned; ssh2 is loaded lazily; MaxSessions overflow spills to more connections.

## Remote access (phone relay) — free, not Pro

**Full reference: [`docs/reference/remote-access-relay.md`](docs/reference/remote-access-relay.md).**

- Phone relay is free; the backend is the gate — never reintroduce a client-side gate.
- Relay crypto: refuse low-order keys, canonical base64 only, 10-digit SAS v2. Scoped Team Access is a
  boundary (`scoped-guest-policy.ts`); secret-bearing RPCs are host-only for every peer.
- One pin store per ROLE; every revoke goes through `peer-revoke.ts`. Windows pairs relay-only (no
  SSH key). The phone never types shell syntax into a relay host.

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

**Full reference: [`docs/reference/push-webhook.md`](docs/reference/push-webhook.md).**

- Management needs the relay host SECRET (challenge proof), the token is shown once and stored
  nowhere locally, the example never puts it on argv, pushes are inert. Desktop only.

## Hosted team relay (Server Edition as a relay host)

**Full reference: [`docs/reference/hosted-team-relay-invariants.md`](docs/reference/hosted-team-relay-invariants.md).**

- Roles enforced in core, deny-by-default both directions (`access-policy.ts`); role re-read from
  `team.json` per message; viewers never vote on size and only join. Host key never silently
  regenerated. Relay PoP proof in `relay-pop.ts` only. On a governed project only the canvas
  authority writes content, via the one reducer `applyCanvasOp`; a change not cast as an op is lost.
- Share with team: never a home directory; nothing ends before bootstrap succeeds; `handedOffTo` makes
  one writer. See also `docs/hosted-team-relay.md`.

## Speech / dictation (desktop + server)

**Full reference: [`docs/reference/speech.md`](docs/reference/speech.md).**

- Local Whisper via smart-whisper (tiny free, larger Pro). Language list is whisper's own; an unknown
  code is still the user's setting. Linux x64 ships two binaries chosen per CPU (never a single AVX2
  build); macOS Metal shader path and model params are patched (`scripts/patch-smart-whisper.mjs`).

## Packaging & auto-update

**Full reference: [`docs/reference/packaging-updates.md`](docs/reference/packaging-updates.md).**

- electron-builder. The running app's name is `node-terminal` (userData, packages), not `nodeterm`.
  Linux: AppImage must stay FIRST in `build.linux.target`. Windows: unsigned beta, NSIS, passive
  notice feed only; never auto-kill the session host; staged host runtime.
- Updater: electron-updater loaded lazily; re-announcements gated once per version; macOS waits for
  Squirrel before restarting; background failures are not cards. macOS permission strings live in
  `build.mac.extendInfo` (a missing one denies silently).

## Atomic writes (never a bare `fs.rename`)

**Full reference: [`docs/reference/atomic-writes-summary.md`](docs/reference/atomic-writes-summary.md).**

- **Never a bare `fs.rename`** — use `renameAtomic`/`writeFileAtomic` (`core/fs-atomic.ts`;
  guarded by `fs-atomic.guard.test.ts`). Remote writes go through `remoteAtomicWrite` with a host-side
  byte-count check; never `chmod <mode> -- <file>` remotely. See also `docs/atomic-writes.md`.

## Durable orchestration state (queue, station reports, hand-over holds, request ledger)

**Full reference: [`docs/reference/durable-orchestration-state.md`](docs/reference/durable-orchestration-state.md).**

- Queue, station reports, hand-over holds and the request ledger are mirrored to
  `<userData>/orchestration-state/` via one module (`core/durable-state.ts`). Files are hostile input;
  loading never throws; only the hook-endpoint owner owns them; delivery is at most once across a crash;
  a restored message flushes only into the same session.

## The test suite never touches a live tmux server

**Full reference: [`docs/reference/test-isolation-tmux.md`](docs/reference/test-isolation-tmux.md).**

- Every vitest run gets a private `TMUX_TMPDIR`; never `kill-server` a shared socket; kill by exact
  target. `fakePlatform()` dirs live for the run only.

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

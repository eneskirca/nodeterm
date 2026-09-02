# Contributing to nodeterm

Thanks for looking. This file is the short door: enough to get running, plus the house rules that
actually get a pull request sent back. The long version — every subsystem and the reasoning behind
its invariants — lives in `CLAUDE.md` at the repo root, which is also loaded automatically if you
work with an AI coding agent.

nodeterm is licensed **BUSL-1.1** (converts to MIT after four years — see `LICENSE`). Contributions
are accepted under that license.

## Getting set up

```bash
npm install        # also patches + rebuilds node-pty against Electron's ABI (postinstall)
npm run dev        # dev mode with renderer HMR
npm run typecheck  # tsc for both the node and web projects — the fastest correctness gate
npm test           # vitest, unit + integration
```

`npm run server:dev` boots the Server Edition (browser UI) if you are working on that surface.

**If `src/main/node-pty-patch.test.ts` is red, your `node_modules` is unpatched — not your code.**
Run `npm run rebuild`. node-pty 1.1.0 leaks a pty device per spawn on macOS
([node-pty#950](https://github.com/microsoft/node-pty/issues/950)) and, on Windows, leaves a
conhost alive per killed session (its exit thread deletes the ConPTY baton without closing the
HPCON); we patch both sources before `electron-rebuild` compiles them, and that test guards the
patches surviving upgrades.

## Where code goes

The repo is split by Electron process boundary and the split is enforced, not advisory:

| Directory | What lives there |
|---|---|
| `src/core/` | Electron-free service core. Talks to its shell only through `CorePlatform`. |
| `src/main/` | The Electron shell around `src/core` — windows, IPC, dialogs. |
| `src/server/` | The Server Edition shell (browser UI over WS-RPC). |
| `src/preload/` | The only bridge: `contextBridge` exposing `window.nodeTerminal`. |
| `src/renderer/` | React UI. Reaches main *only* through `window.nodeTerminal`. |
| `src/shared/` | Types and IPC channel names imported by all sides. |

`src/core/no-electron.test.ts` and `src/server/no-electron.test.ts` fail if `src/core` or
`src/server` import `electron` or `../main/*`.

**Put new service logic in `src/core` behind `CorePlatform`, not inline in `src/main`.** That is the
seam the Server Edition boots from; logic left in `src/main` silently does not exist there, and the
boundary tests cannot tell you a feature is *missing*.

## Three surfaces

A feature is not done until you have decided how it behaves on each — even if the decision is "not
applicable here":

1. **Desktop** (Electron)
2. **Server Edition** (Linux, browser)
3. **Mobile companion** — *nodeterm mobile*, a **private** repo (`nodeterm-ios`, SwiftUI). You
   cannot open a PR against it, so this is normally a follow-up note rather than same-PR
   work: say in your PR what the mobile side would need, and **mention @eneskirca** so it
   gets picked up there. "Not applicable" is a fine answer — just make it a stated one.

Anything reachable from `window.nodeTerminal` needs a **real** implementation in
`src/renderer/bridge/`, or a deliberate, documented degrade. The `satisfies NodeTerminalApi` gate
forces you to *declare* every member, but a no-op stub compiles fine while doing nothing.

The **canvas and the kanban board are two views of the same nodes.** When you add something to a
canvas node — a header action, a badge, a menu item — ask whether the board's card and card modal
need it too, and wire it in the same change. The global (Omni) board shows all open projects as
stacked swimlanes; it is off by default (`settings.omniKanbanEnabled`), has a dedicated remappable
shortcut (`view.globalKanbanToggle`), and can be made the default for Cmd+Shift+B via
`settings.omniKanbanAsDefault` — see CLAUDE.md for the full invariants.

A board card's **source** is a registry entry, not a branch you add at a call site
(`renderer/lib/kanbanSources.ts`). Declare the source once — filter label, `placement`
(`assignment` = the board's own persisted assignments, `provider` = the provider owns the column),
in-column `lane` order, whether it is `configured` for a board, whether it is `readOnly` (the
board never writes it: no drag, no move control) — and give it its one leaf (a card component and
the list path feeding it). Columns take lanes and name no source; the drag path branches on
`placement`. If you find yourself writing `=== 'github'` outside the registry, the registry is
missing a field.

Before adding a GitHub read, check what the existing poll already fetches. Pull request cards
needed no new request at all: `/repos/{repo}/issues` returns pull requests, and the client used to
discard them. `/repos/{repo}/pulls` looks like the obvious endpoint and is the expensive one — it
**ignores `since`**, so it can reuse none of the incremental machinery, and its items are ~3.5× the
bytes. CLAUDE.md's kanban section has the measurements and the eviction rule that keeps the issue
lane unaffected.

## House rules

- **Never call the user's machine a Mac in user-visible copy.** Use `thisMachine()` /
  `thisMachineCap()` / `machineNoun()` from `src/renderer/lib/machineName.ts` — "this Mac" on
  macOS, "this PC" on Windows, "this computer" elsewhere and in any Server Edition browser tab
  (where the machine being described is the SERVER, whose OS the viewer cannot know). Issue #563:
  ~30 strings said "this Mac", including *"This Mac is not authorized on this license"* and *"a
  teammate on a seat can run commands on this Mac"* — the one sentence a user has to trust before
  handing out shell access. `machineName.guard.test.ts` scans non-comment lines and will fail your
  PR; copy that really is macOS-specific (the ptmx-limit banner, the notch step) is exempt by name
  with its reason. Comments are not scanned.

- **Anything path-shaped: Windows is a delivery target.** Most of this was written on
  macOS/Linux, so the recurring defect is code that is genuinely correct on POSIX —
  `split('/')`, `startsWith('/')` as an is-absolute test, a bare `fs.rename`. Use
  `path.basename`/`join`/`sep`, publish files with `renameAtomic`, and write at least one test with
  a real `C:\`-shaped input. Guards enforce some of this and will fail your PR. In the Server
  Edition and relay tabs, the browser's OS is NOT the filesystem's OS: obtain the dialect from the
  core that owns the files, and keep an unobserved host unknown rather than guessing. Conversely,
  on POSIX a backslash is legal filename text — do not treat both separators as interchangeable
  unless the owning filesystem is known to be Windows.

- **Finding a Windows executable is not the same as being able to spawn it.** A PATH lookup may
  correctly resolve an npm CLI to `<name>.cmd`, but Node's `execFile`/`spawn` cannot execute that
  shim directly. For short-lived app-owned subprocesses, pass the resolved path and argv through
  `directExecutableInvocation` (`src/core/exec-path.ts`): it uses npm's sibling `.ps1` shim via
  PowerShell `-File`, preserving the argv boundary. Do not fix this with `shell: true`; prompts and
  other user-controlled arguments would become shell syntax. A `.bat` file has no equivalent safe
  entry point and must fail explicitly.

- **Normalize BOTH sides of a path comparison, through one function.** A marker normalized where
  it is built and matched raw where it is used is a no-op on the machine you wrote it on and a
  silent defect on Windows. That is issue #558: the managed-hook marker was folded to `/` while
  the stored command still carried `\`, so nodeterm stopped recognizing its own hook entries and
  appended a fresh copy of all nine on every launch — nine hook processes per event, nine
  concurrent 45 s permission waits racing one prompt. Write the normalizer once, use it on both
  sides, and pin it with a `C:\`-shaped test.

- **Never publish a file with a bare `fs.rename`.** Use `renameAtomic` or `writeFileAtomic` from
  `src/core/fs-atomic.ts`. On Windows a rename fails with `EPERM` whenever anything has the
  destination open — Defender scanning the file you just wrote, the search indexer, OneDrive — so
  the plain version loses saves intermittently and only on other people's machines. A test scans
  for this and will fail your PR; `docs/atomic-writes.md` explains why the retry is safe. Every
  temp/part staging name must also be unique per call across processes and cleaned by its owner —
  including paths embedded in generated SSH commands or handed to scp, which the `fs` scan cannot
  see. Keep a remote temp's own leaf bounded: extending an already-valid maximum-length target leaf
  with a UUID suffix turns an atomic write into a guaranteed `ENAMETOOLONG` failure.

- **Never write to a child's stdin without an `'error'` listener on that stream.** A pipe write's
  failure is not a throw at the call site: when the child exits before draining stdin (a CLI handed
  a flag it doesn't know, an unreachable ssh host), Node re-emits the EPIPE as an async `'error'`
  EVENT on the stream — a try/catch around the write is inert, and the unhandled event crashes the
  whole main process with an "Uncaught Exception: write EPIPE" dialog (issue #382's class). Attach
  `child.stdin.on('error', ...)` before the first write — log via `console.warn` so the debug ring
  sees it, or settle the pending call; the child's exit code stays the authority on the outcome
  (see `tmux-control-client.ts` and `pty-manager.ts` `runWithStdin` for the house pattern). A test
  (`src/core/stream-epipe.guard.test.ts`) scans for this and will fail your PR.

- **Never unmount, move or re-key a browser/web node's element.** An Electron `<webview>`'s guest
  process dies on DOM detach — and a detach includes any `insertBefore`/`appendChild` MOVE of an
  attached element, which React performs whenever a kept child's relative order among kept keyed
  children changes. That is why webview-hosting nodes render in one stable pool region at the tail
  of the `<ReactFlow>` nodes prop (`renderer/lib/webviewKeepAlive.ts` — read its header before
  touching the merge, the node array swap in Canvas's load effect, or anything that reorders
  nodes), and why a background project's pages stay mounted as hidden ghosts instead of
  unmounting. `display:none` is safe (measured: state, scroll and viewport size survive); a reorder
  or unmount reloads the user's page and loses their in-page state.

These are the ones that come up in review most often. Each exists because its absence caused a real
bug.

**A failed read is never evidence of absence.** "Could not measure" and "there is nothing" are
different facts and must stay distinguishable at every layer. Collapsing them is how a panel ends up
reporting "no sessions" on a host running thirty.

**Degrade to nothing, never to something wrong.** A probe that fails means the bare, safe command —
never a substituted nearest match. A hand-editable value that is unrecognised must yield the safe
default, never something more destructive than the default.

**A Server Edition agent owns only nodes it freshly opened in this server run.** The
creator ledger is process-local and must never be rebuilt from `.nodeterm/project.json`, titles,
hook history, or a surviving tmux name: all are writable or stale. A restart therefore clears
ownership, performs no node/session adoption, and leaves durable queued launches dormant. Metadata
mutations and message delivery validate every target before writing anything; missing proof is a
named refusal. Validate Server upgrades against a disposable data directory and port. Restarting a
shared live service is
an explicit operator action, never a test or an automatic repair step.

**A plain terminal is not a Claude node.** It may carry the generic node/endpoint wiring needed for
a hand-launched agent to report hooks, but it gets no `NODETERM_AGENT_ID` and no
`NODETERM_CANVAS_CONTROL` until the serialized node explicitly names an agent.

**Re-validate hand-editable values at the point of use**, not by their TypeScript type. Settings
come from git-shared JSON and can end up interpolated into a shell command line.

**Test generated shell for real.** If you generate a shell command, run it under an actual
`/bin/sh` against a fixture tree. A composed fixture will not tell you that `echo ##MEM` prints an
empty line because `#` starts a comment.

**Credentials never ride argv — local or SSH.** Not a tmux `-e` pair, not `curl -H`, not a remote
command string. `/proc/<pid>/cmdline` is mode 444 on a stock Linux, and a remote command line is argv
on the host too: we shipped the hook bearer that way and any other account on the machine could read
it and open a terminal running an arbitrary command. Pass secrets by 0600 file or by **stdin**
(`curl --config -`), and never add an argv fallback. See `docs/node-identity.md`.

**Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`. A new
field on a hook event that reaches only the desktop leaves the Server Edition quietly without the
feature, and the boundary tests can only tell you an import is wrong, never that a field is missing.
The same applies to any hook-server signature change; this repo has shipped one to a single shell
three times.

**A rule enforced at one mint site is enforced nowhere.** Nodes are created on two surfaces — the
canvas (`createAgentNode`) and the phone's `projects.registerNode` (`appendProjectNode`) — and a
constraint spelled out inline at one of them silently does not exist at the other. "Which agents
bind a managed account" lived as a ternary in the renderer while the phone leg wrote whatever the
wire sent.
Put the rule in one predicate under `src/shared` and have every mint site ask it, and derive the
things that follow from it (a node's color, say) from that same call rather than re-deriving the
condition per caller.

**Do not take scrolling away from tmux.** It owns the mouse, the scrollback and the alternate
screen. A previous design moved that into the emulator and failed structurally; `CLAUDE.md` explains
why in detail.

**A spawn-env write does not reach a tmux session on its own.** The shared tmux server takes each
new session's env from its own GLOBAL env (inherited from whichever client *started* the server) —
the creating client's process env only matters for names listed in `update-environment` (or passed
as non-secret `-e` pairs). Setting `env.FOO` in `pty-manager` therefore works for the plain-shell
fallback and for the one client that happens to start the server, and silently does nothing (or
worse, leaks the server-starter's value into everyone else) after that. That is how issue #419
shipped: managed-account `CLAUDE_CONFIG_DIR` leaked into system-account sessions. New per-session
env either joins `ACCOUNT_SCOPE_UPDATE_ENV` / the gateway list, or rides `-e` — and gets a
real-tmux test (`account-env.realtmux.test.ts` is the pattern).

**A new keyboard chord has to survive the shells, not just the renderer.** The application menu is
ours (`buildAppMenu` in `main/index.ts`), but its command-style accelerators — ⌘Q, ⌘M, ⌘W, ⌘0, ⌘⇧B,
⌘, — are still handled above the page, so your `keydown` branch simply never runs: steal the chord
back in `main/keydown-intercept.ts`'s `before-input-event` allowlist and forward it, like the three
already there. Two legs stand the menu down instead of stealing — the terminal-first policy and an
armed shortcut recorder (`menuStandsDown` → `menuItemIdsToSuspend`, since a disabled item suppresses
its accelerator) — and Reload (⌘R / ⌘⇧R) is the named exception that always stays with the app,
because it is the crash-recovery lever. Browsers own a different set. And any chord that reaches the canvas needs the two refusals every canvas shortcut
here has: not while the kanban board covers it, not while the user is typing.

**A new chord needs no edit to the shortcuts panel — and must not get one.** `ShortcutsPanel`
derives its whole inventory from `COMMAND_DEFINITIONS` (section per `CommandGroup`, label from
`def.title`, chord from the EFFECTIVE binding), so adding a registry command is all it takes to
make it show up; a command with no effective binding is omitted rather than listed chord-less.
`ShortcutsPanel.test.tsx` is the watchdog and reds if a command fails to surface. The panel it
replaced hand-listed 24 ids against a 45-command registry and had drifted four live chords behind
— if you find yourself typing a command id into that file, that is the bug reappearing.

**Comments explain WHY, and name the failure they prevent.** The codebase is deliberately dense with
reasoning. A comment that restates the code is noise; one that says "do not simplify this back,
here is what broke" is the point.

**A generated sh client reads its node token through the one resolver.** Every POSIX-sh client we
emit (the managed hook script, `nodeterm.sh`, `context.sh`) presents this node's per-node identity by
calling `nt_read_node_token` from `core/agents/node-token-sh.ts` — never by re-typing
`head -n 1 "$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID"`. That copy was issue #384: a session is
pinned for life to the endpoint FILE path it got at tmux creation, so a client that trusts only what
that file advertises presents nothing forever when the file is old or unreadable — and because the
hook script alone could heal itself, the same node proved itself through one client and was refused
through another for the life of the session.

**Local generated sh clients recover shared-Codex identity before their env gate.** A Codex tool
shell is forked by the account-scoped app-server, so it has `CODEX_THREAD_ID` but not the pane's
`NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` must prepend
`codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before checking `NODETERM_NODE_ID` or
`NODETERM_CANVAS_CONTROL`. Keep the SSH shim constants machine-neutral: baking the desktop/server
record path into a remote host is both wrong and a local-layout leak. A guard test enforces that
(`remote-shim-neutrality.guard.test.ts`), because the leak is silent — the remote shim keeps
working, and nothing goes red.

**That prelude may not decide anything a pane already decided.** It exports the agent id and the
canvas-control grant the ownership RECORD carries, never constants. They used to be hardcoded
(`codex`, granted) and both are `buildPtyEnv`'s answers: a custom agent inheriting the codex harness
is `custom:<uuid>`, and the grant comes from `canControlCanvas`. If you add a field the prelude
exports, put it inside the record's HMAC and have the desktop re-derive anything that grants a
capability — never accept the client's word for that. Withhold rather than assume: a tool shell
missing a verb its pane has is a bug report, a tool shell holding one its pane was denied is a
security question.

**A shell that forwards data into these records cannot be type-checked into correctness.** A
handler that destructures the request without the new field, and a call that omits an optional
trailing argument, are both well-typed — so the feature ships inert with a green suite. Pin the
wiring at source level (`codex-identity-record-wiring.test.ts`, `hook-verified-parity.test.ts`).

**A stream error is not a throw you can catch.** When a write to `process.stdout`/`stderr` fails —
`EPIPE` down a closed pipe, `EIO` after macOS revokes a closed terminal's tty — node reports it by
emitting `'error'` on the stream a tick later, and the default for an unhandled `'error'` event is
to kill the process. The stack it carries was captured at the write, so the crash *reads* as if it
happened synchronously at your `console.log`, and wrapping that call in `try/catch` changes nothing
(measured on node 22). If you write to a stream that can go away, attach an `'error'` listener and
latch the writer off — `installLogSink` (`src/core/log-sink.ts`) is the worked example. Issue #382.

**A retry budget must measure the thing it is waiting for, and running out must be VISIBLE.** The
armed-launch loop (canvas-control `--after`, and the cold open a `--project` node gets) delivered its
held command on a flat 5 × 400 ms budget started when the *canvas* held the node — so on a cold
project switch it was spent loading the canvas, mounting the node and spawning tmux, and the launch
was abandoned before the session it was for existed. Two rules came out of issue #569: wait on a
real signal (`isSessionReady`, published by the node when its shell settles) rather than on a
stopwatch aimed at the wrong start, and never let "we gave up" live only in a `console.warn` — the
node shows it (`state/launchDelivery.ts` → the QUEUED badge's ⚠ + tooltip) and the canvas-control
reply carries it (`queued` / `queuedIds`), because a user who cannot see the failure and an
orchestrator that is told "opened" both act on a session that is not there. If you add a bounded
retry anywhere, ask what the clock actually starts on and where its exhaustion becomes visible.

**Never move the user's view on a background agent's say-so.** Canvas-control requests route by
SOURCE, and React Flow holds only the ACTIVE project's nodes — so the dispatch used to travel to the
caller's project before answering. For an OPEN that was a screen hijack: the user is looking at
project B, an agent in project A runs `open-claude`, the tab switches and A's saved viewport is
applied, so the camera appears to jump and zoom. The rule now has two tiers, both membership lists in
`renderer/lib/controlRouting.ts`: `STORE_ANSWERED_VERBS` ("no canvas is needed at either end" —
`list`, `send`, `reply`, `sticky`, `open-project`) and `canColdOpen` ("a canvas IS needed, but the
serialized one will do" — `open-terminal`, `open-claude`, `open-agent`, which write into the owning
project's stored nodes with their launch armed and report `queued: true`). Everything that acts on
nodes which already exist still travels, because it reads live state the serialized copy does not
carry. When you add a verb, decide which tier it is in — and if you change what a verb DOES, update
`buildCanvasSkillBody` / `buildCanvasControlInstructions` in the same PR, with a test that goes red
on the stale claim (`src/main/canvas-control-core.test.ts`).

**Pointing a project at a folder is a WRITE — probe before you bind.** A project's canvas is
written to `<cwd>/.nodeterm/project.json`, so the moment a project gains a `cwd` the next autosave
owns that file. "Open folder…" always probed and adopted; "Set folder…" (tab ⌄) used to bind
unconditionally, which overwrote a canvas a teammate had committed to that repo — their nodes gone,
no backup, nothing on screen. Both entrances now share the rule (`renderer/lib/setProjectFolder.ts`):
an occupied *or unreadable* project file refuses the bind and says why. The store's "never
blind-write" guard will not save you — it only refuses an EMPTY canvas over a populated file.

**Every workspace entry is a REF — content in a file, machine-local state on the entry.** There are
three kinds and they now share one shape: a folder ref (`<cwd>/.nodeterm/project.json`, git-shared),
an SSH ref (the same file on the host, with an offline `cache`), and a cwd-less canvas
(`userData/inline-projects/<id>.json`, with the entry's `project` field kept as a cache for one
release so an older build still reads it). Two habits follow. **Content goes in the file; anything
this machine would legitimately disagree with another machine about — project id, viewport, default
account, breadcrumbs, closed-session history, per-node `shell` — goes on the index entry**
(`IndexEntryV3`), or a `git worktree add` / a second instance hands one machine's state to another.
And **`workspace.json` is one file with last-writer-wins semantics, so it may not be the only home
of any content**: that is precisely what let a second app instance erase a cwd-less canvas. Between
two instances the arbiter is the file's `rev` — a lower rev never overwrites a higher one — and
there is no merge; if you add a fourth kind, give it a file and say which rev wins.

**A project with no folder is a real project — degrade explicitly, never silently.** "New project"
creates a cwd-less canvas, so every folder-shaped feature meets one. Keep the affordance and
disable it with its reason (`NEW_FILE_NO_CWD_HINT`,
`WORKTREE_NO_CWD_HINT`, the Explorer/Source Control notes); a row that simply vanishes teaches
nothing, and a message that names the wrong cause ("not a git repository" for a project that has no
folder to be one) sends the user hunting a problem that does not exist.

**Agent features attach to base harness capabilities, not frontend allowlists.** A custom agent can
inherit a builtin harness, so add the capability and its one shared leaf (`src/shared/agents`) and
let every UI ask the helper. Repeating Claude/Codex/etc. cases in menus breaks that inheritance and
eventually drifts.

**Never put a raw NUL byte in a source file — write `\x00`.** Git classifies a file containing one
as *binary*, so it renders as "Binary files differ" in every diff surface (the PR page, `git diff`,
`git log -p`) and `git grep` skips it. It still compiles and its tests still pass, so nothing fails
— the file just becomes invisible to review, which is the worst way for this to go wrong. A
separator or sentinel is a fine reason to want the byte; the escape is the same byte and keeps the
file text. `src/shared/source-hygiene.test.ts` enforces this across every tracked `.ts`/`.tsx`.

**Paths cross machines, so treat `\` as a separator wherever you split one.** A value persisted in
`.nodeterm/project.json` is written by one machine and validated on another, so a guard that reads
`\` as an ordinary filename character is simply wrong about the machine that will resolve it. This
has already produced a real hole: a traversal check that split on `/` alone saw `./a\..\..\x.png`
as a single harmless segment on *every* platform. Split on `[\\/]`, and prefer accepting both
dialects while storing only one (see **Node icons** in CLAUDE.md for the worked example).

**Canvas edges are all `type: 'floating'`, and one relation gets one edge.** Never set
`sourceHandle`/`targetHandle` on an edge object — the rendered path is computed from the two nodes'
rectangles (`renderer/lib/floatingEdge.ts`), and a fixed side is what sent an edge to a node placed
left of its source looping across the whole canvas. And do not add a second edge family for a
relation a rope already carries: `--after` is a **rope** whose dashed "⏳ waits for" look is DERIVED
from the target's `pendingLaunch` (`renderer/lib/edgeModel.ts`), and the context bridge it also
writes stays hidden underneath it. One `open-claude --after` used to land three edges on one node.
`src/renderer/canvas/edge-model.source.test.ts` pins both halves.

**React Flow's `fitView` is queued, not immediate — never use it to frame something automatically.**
Calling it sets `fitViewQueued` and the fit runs from a later `setNodes` (only once every node is
measured) or the next `updateNodeInternals`, against whatever the node lookup holds by then; a fit
set that comes out empty parks the canvas origin in the middle of the screen. Compute the viewport
yourself and apply it with `setViewport` (`renderer/lib/nodeFocus.ts`, `canvas/fit-view.ts`), which
lands now and against the canvas you meant. `fitAll` is the one deliberate exception: an explicit
user gesture on a settled canvas.

## Testing

`npm test` must pass, and `npm run typecheck` is the fastest gate.

Beyond that, one habit is worth more than any other here:

**Mutation-test your guards.** Delete or invert the check you just added and confirm a test *fails*.
A green suite is not evidence on its own — during one recent feature this caught nine tests that
passed with the code they were meant to pin removed, including one mutation that survived the entire
4,500-test suite because the class it touched had no test file at all.

Watch for fixtures that cannot discriminate: if every row in your fixture happens to make the
mutant's output identical to the real one, the test proves nothing while looking thorough.

**Never pin behaviour by reading source text.** `expect(SRC).toContain('...')` is the fixture that
can never discriminate: it is satisfied by code that is present *and wrong*. We shipped one —
`src/main/menu-accelerator-intercepts.test.ts` matched three strings inside the `before-input-event`
handler, and stayed green on a tree where a shared guard had moved out from under them and the bare
`0` key was swallowed app-wide. It was, precisely, red on the fix and green on the break. If a
module is untestable because it imports `electron` at the top, that is the thing to fix: lift the
decision into a pure function next to it (`keydown-intercept.ts`, `main-window.ts`,
`zoomShortcut.ts`) and press the keys.

Where a behaviour can only be verified on hardware we do not have in CI (a Mac, a real SSH host, a
GPU), say so explicitly rather than implying coverage. Several docs carry numbered device
checklists for exactly this.

**A test that reads a checked-in file must not care how git checked it out.** `.gitattributes`
declares `* text=auto eol=lf`, so every working tree is LF — but attributes only take effect on a
re-checkout, so if you cloned before it landed, run `git add --renormalize .` (or re-clone) and your
tree catches up. Windows is where this bites: Git for Windows defaults to `core.autocrlf=true`, so
without the attributes file a fresh clone had CRLF working files and `CSS.indexOf('}\n}')` matched
nothing — two suites failed on a checkout with zero local changes, and one of them reported 25 theme
tokens missing that were all present. Normalize at the read
(`readFileSync(f, 'utf8').replace(/\r\n/g, '\n')`); `src/shared/line-endings.guard.test.ts` fails on
a read that slices a `\n`-bearing literal without it.

**A test never touches a live tmux server.** You will most likely run `npm test` from inside a
nodeterm terminal, where `-L node-terminal` and `-L nodeterm-rmt` are the servers holding every
node you have open — one stray `kill-server` there ends your whole canvas, not your test. Every run
therefore gets a private `TMUX_TMPDIR` (`test/setup/tmux-sandbox.ts`), which re-points every socket
name at once. Write real-tmux suites the normal way — pick your own socket name, and use
`makeTmuxTmpdir` if you also want your own directory — and do not build an `env` object for a real
tmux without carrying `TMUX_TMPDIR` into it, which is the one way left to escape the sandbox.
`src/core/tmux-socket-isolation.guard.test.ts` holds the short allowlist of suites that name a
production socket on purpose; adding a third is a review conversation, not a checkbox.

## Pull requests

- Branch from `main`. CI runs `quality`, `CodeQL` and `Dependency review`; all three are required.
- Explain **why**, not just what. If a decision has a trade-off, name it and say what you rejected.
- If you measured something, put the numbers in — they save the next person the same afternoon.
- Say what you did **not** verify. That is more useful than a confident summary.

## Documentation

Two files, two audiences:

- **`CONTRIBUTING.md`** (this file) — what another human needs before touching the code.
- **`CLAUDE.md`** — the deep invariants, per subsystem, with the reasoning and the measurements.

**If you change or discover something other contributors must know, update this file too.** An
invariant that only lives in a commit message is one refactor away from being violated by someone
who never saw it.

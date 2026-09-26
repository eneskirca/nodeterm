# Contributing to nodeterm

Thanks for looking. This file is the short door: enough to get running, plus the house rules that
actually get a pull request sent back. The long version — every subsystem and the reasoning behind
its invariants — lives in `CLAUDE.md` at the repo root and the per-subsystem files it indexes under
`.claude/rules/`, which are also loaded automatically if you work with an AI coding agent.

nodeterm is licensed **BUSL-1.1** (converts to MIT after four years — see `LICENSE`). Contributions
are accepted under that license.

## Getting set up

```bash
npm install        # also patches + rebuilds node-pty against Electron's ABI (postinstall)
npm run dev        # dev mode with renderer HMR
npm run typecheck  # tsc for both the node and web projects — the fastest correctness gate
npm test           # vitest, unit + integration
```

On Windows, run `bootstrap-windows.bat` instead of `npm install`. It verifies the Visual Studio
C++ workload and its separately installed Spectre-mitigated libraries before compiling `node-pty`.
It also shields MSVC addon builds from the clang/lld ThinLTO settings inherited from Node 26; a
plain `npm install` under a stock Node 26 with node-gyp 12 otherwise fails with `LNK1117`.

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
boundary tests cannot tell you a feature is *missing*. This keeps happening to the same subsystem:
the ⌘M transcript read and then the context meter's `context:ensure` both shipped desktop-only, and
in both cases the browser cast the message into the void and the feature just looked empty. If your
handler needs something only Electron has (an SSH ControlMaster, a native dialog), make that an
**injected dep** whose absence is a documented degrade — see `registerTranscriptIpc` /
`registerContextEnsureIpc` — rather than a reason to keep the whole handler in `src/main`.

**Windows agent messaging:** direct ConPTY terminals are looked up by the runtime node index,
not the persistence key. `NativeWindowsPane` checks console membership, the unambiguous native
process chain and process birth times, and frames paste only after the terminal requested it.
Do not replace that read with a stored `agentId` or the restart heuristic's deepest descendant.
An interpreter such as `node` is named by its script's package `bin` entry, never as `node`, so
npm-installed CLIs such as Codex are recognized. A session released by park expiry or offscreen
release is still messageable: existence and routing ask the backend, not the attached client.
Never put the submitting Enter in the same write as a message paste: `core/settled-submit.ts`
pastes, waits for the envelope to render, then submits separately, on every backend.
The persistent session-host transport has its own versioned messaging extension: the host checks
its session generation, OS process identity and emulator before writing. An older live host keeps
its terminals and refuses the extension; never restart it automatically or fall back to sendKeys.
Message dispatch publishes pending canvas edits before main resolves scope, without overwriting
an unresolved file conflict. See `docs/windows-session-host.md`.

Claude usage identity is scoped to the same config directory as its credentials. Read organization
metadata even when credentials already include an email, and degrade to the email-only row when
metadata cannot be read. Managed usage must never fall back to an unscoped system Keychain token:
that would label one account's limits with another account's organization.

Context-link maps authorize reads. Publish changes to edges, linked metadata, and background
projects independently of canvas geometry updates; a debounce reset by every node render can
starve publication indefinitely. Only merge projects owned by the same core, and use the rendered
canvas's project epoch during tab switches. Core must revoke removed links before asynchronous
transcript discovery or debug-file writes finish; an older write must never restore that access.
Coalesce renderer updates before building the workspace map, without resetting the scheduled task.
Intermediate publications retain resolved transcript paths only for unchanged identities; changing
a session/account/location/hook path or removing the target invalidates that cache immediately.

Windows installer safety (#829): `build/installer.nsh` overrides NSIS's process-killing check.
A running app or session host blocks install/uninstall, and a failed process query blocks too.
Never restore automatic host termination: quitting the app preserves those live sessions.
Update preparation must keep saved canvas nodes: exit programs normally, quit, then have the user
verify and stop any remaining host. Never recommend **End session** (it deletes nodes). Cold agent
resume depends on supported, saved conversation history; it does not preserve running tasks.
See `docs/windows-session-host.md` for the user-controlled preparation/recovery steps and limits.

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

- **Branch labels describe a checkout on one core.** Share existing status reads through
  `renderer/state/gitBranches.ts`; do not cache a branch forever by project id or copy a project
  branch onto worktree nodes. Source, Sessions and worktree headers consume the same observations,
  keyed by API identity, exact cwd and (for SSH) project identity. Never probe an SSH cwd locally
  from a background header: only the active SSH project is git-routable. SSH headers observe
  Source refreshes instead.

- **Never call the user's machine a Mac in user-visible copy.** Use `thisMachine()` /
  `thisMachineCap()` / `machineNoun()` from `src/renderer/lib/machineName.ts` — "this Mac" on
  macOS, "this PC" on Windows, "this computer" elsewhere and in any Server Edition browser tab
  (where the machine being described is the SERVER, whose OS the viewer cannot know). Issue #563:
  ~30 strings said "this Mac", including *"This Mac is not authorized on this license"* and *"a
  teammate on a seat can run commands on this Mac"* — the one sentence a user has to trust before
  handing out shell access. `machineName.guard.test.ts` scans non-comment lines and will fail your
  PR; copy that really is macOS-specific (the ptmx-limit banner, the notch step) is exempt by name
  with its reason. Comments are not scanned.

- **Bottom canvas pills must leave room for the measured dock.** `CanvasPills` bounds their row
  and moves it above the dock when the side budget is too small. Only usage summary text may
  truncate; keep refresh outside that overflow and keep the row free of stacking contexts so
  popovers can still clear the sidebar/board. `scripts/usage-layout.test.ts` verifies real Chrome
  layout and hit targets (set `CHROME_BIN` when Chrome is not at the Linux default path).

- **An overlay you lay over a live terminal steals its wheel — give it `pointer-events: none`.**
  Wheel routing is a per-packet hit test on `closest('.nowheel')` (ours in `Canvas.tsx`, and React
  Flow's own `panOnScroll` independently), so the element under the pointer decides, not the node.
  `.term-node__xterm` carries the class and covers the whole body, so a banner drawn ON a running
  terminal takes those pixels out of the terminal's wheel area and hands them to the canvas — the
  user scrolls and the canvas slides instead. `.term-node__upload` and `.term-copy-pill` were
  already `pointer-events: none` for this; `.term-node__stalecwd` was not (issue #767), and
  `canvas/terminal-wheel-boundary.test.ts` now fails on the next one. An overlay that REPLACES a
  dead view keeps the canvas wheel on purpose — there is nothing underneath to scroll. Same rule
  one layer up: do not "fix" a routing question by moving `nowheel` outward, because a second
  consumer reads the class and no per-element opt-out can reach it. Deep version: CLAUDE.md §
  Terminal node lifecycle.

- **The node colour palette is ONE list, and it is also the control boundary.**
  `src/shared/node-colors.ts` is what every picker draws and what `nodeterm color --color C`
  validates against — so a colour the UI offers and a colour the CLI accepts cannot drift apart.
  Its agent section is DERIVED from `AGENT_CONFIG`, never re-typed: add a builtin agent and the
  palette grows by itself. If you are adding a surface that lets someone choose a node colour,
  render `<NodeColorSwatches>` rather than mapping the array yourself (a guard test fails on a
  hand-rolled swatch row) — and if the value will be drawn as TEXT or as an opaque fill under
  white, take `SYSTEM_NODE_COLOR_SWATCHES` instead, with the contrast reason in a comment. Deep
  version, including the measured numbers: CLAUDE.md § Node colors.

- **Every loosening of a security gate must be a SETTING the user can see and revoke.** A "don't
  ask again" that lives only in a dialog is a permission granted once and never findable again. The
  canvas-control destructive confirm is the pattern to copy (`@shared/control-confirm`): a CANCEL
  never grants anything, a waived action still announces itself on screen and NAMES the waiver that
  let it through, and which gates may be waived at all is a TABLE, not an `if` at each call site —
  so "this one can never be waived" is a tested fact rather than a line somebody forgot to write.
  **What a dialog may grant is bounded by SCOPE, not by permanence.** It offers "while nodeterm is
  running" (in-memory — not `settings.json`, not `localStorage`, so quitting restores the gate) or
  "always in this project" (machine-local, keyed by project id, pruned like
  `settings.sidebarCollapsedItems`). The machine-WIDE waiver stays Settings-only, because that is
  the one a stray click in a dialog that appeared under the user's hands must not be able to grant.
  Offering only the app-run one was its own failure: it is not what a user who ticks "don't ask
  again" means, so the real choices were "be asked forever" or "turn it off everywhere". Two rules
  come with the project scope: it is keyed on the project the call ACTS ON (canvas control routes
  by source, so that is often not the project on screen), and it is machine-local — never
  `.nodeterm/project.json`, which is git-shared, or a cloned repo could switch someone's confirms
  off.

- **An agent may only reach settings through an ALLOWLIST, and every change asks.** The
  canvas-control `settings` verb (`src/shared/settings-verb.ts`) reads and asks to change a short
  table of keys; anything off the table is refused by name, and a forbidden set (permission modes,
  accounts/credentials, node identity, browser control, telemetry, keybindings, confirm waivers)
  outranks the table — its test walks the table against the set AND a name pattern, so an entry that
  would let an agent grant itself a power goes red even when added on purpose. `settings` is outside
  `CONFIRM_WAIVABLE_VERBS`: a CLI that could waive its own confirm would make the confirm decorative.
  A capability change must land through the UI's own setter (`setProjectCapability`: file flag AND
  this machine's `'kept'` answer), never a hand-rolled flag write. Adding a key is one line in the
  table plus a `why`. The Server Edition has no dialog, so it refuses every `--set` by name.

- **A permission mode (or anything else) that rides `project.json` is GIT-SHARED — never key a
  local gate on it alone.** `project.defaultPermissionMode` travels to everyone who clones the
  repo, so binding a confirmation-skip to "the mode is bypassPermissions" would let a cloned
  repository silently switch off a user's destructive-action gate. The rule that came out of it:
  ask `resolvePermissionModeWithSource` WHO chose the value (`project` / `global` / `default`) and
  act only on the user's own machine-local choice — and keep `default` distinct from `global`,
  because reading an unset setting as a deliberate choice is reading consent into silence. Anything
  machine-local goes in `settings.json`; nothing that grants a capability goes in `project.json`.
  A machine-local DEFAULT for a project capability (`agentMessagingDefault`) is allowed only because
  it answers ABSENCE: an explicit `true` in `project.json` still needs this machine's recorded
  answer, an explicit `false` still wins, and "off" must therefore be written as a literal `false`.
  Read grants through `projectCapabilityGrantedFor(project, cap, settings)` — never the file bit.

- **Nothing an agent asks for may take the user's screen.** Canvas control routes by SOURCE: the
  request names the agent's own node, and the dispatch has to find the canvas that owns it. For
  years "that canvas is not on screen" was answered by switching the project tab — so a background
  agent's `close` moved a user who was typing in another project, applied that project's saved
  viewport, and took their camera and typing focus for a call they did not make. Every verb now has
  a decided off-screen behaviour (`src/shared/control-off-screen.ts`) and none of them is "travel":
  it is answered against the owning project's serialized nodes, or REFUSED with a reason the agent
  can act on. If you add a verb, give it an entry — a refusal beats a hijack, and a verb with no
  entry falls into the generic refusal, which is fail-closed but is nobody's decision. Two traps
  the old shape hid: a verb body that resolves `--node` against the live `nodesRef.current` while
  answering for another project silently acts on whatever the human is looking at (use
  `ctlNodes()`), and reading `activeProjectId` inside a verb has the same bug (use `ctlProject`).
  The guard is `test/acceptance/control-verb-disposition.test.ts`, which walks main's verb table
  against the renderer's dispositions — deliberately cross-layer, because that is the only way
  "every verb" is checked rather than remembered.

- **A dialog raised on someone else's behalf must know that request's lifetime.** Main abandons a
  canvas-control request after 120 s and tells the renderer nothing, so an unanswered dialog sat
  there forever AND held the one-confirm-at-a-time guard, which refused every later destructive
  verb with "a confirmation is already pending" for the rest of the app run — the agent, told the
  refusal was retryable, retried into it in a loop. If you raise a dialog for a bounded request,
  give it the deadline (`ConfirmState.expiresAt`), import the bound rather than re-typing it, have
  it expire slightly AFTER the requester gives up, and answer with "expired" — never "denied by
  user", which claims a decision the human never made. Reach for the existing
  `useExpiringDialog` hook rather than a second effect: the worktree-removal dialog needed the
  identical rule a day later, and two copies is how one of them quietly misses the next fix. Give
  the deadline only to a dialog an AGENT raised — one the user opened themselves must never vanish
  under them — and remember that clearing a dialog is not always just nulling its state (that one
  also has to release the ref its own busy-guard reads).

- **An error must not name a remedy nobody measured — and the remedy needs its own test.** The
  `unproven-target-owner` refusal told its caller *"Re-open the target node so its owner is
  recorded, then try again"*, and re-opening is precisely the attach that records nothing
  (ownership is recorded only on a genuine fresh spawn), so a caller that obeyed got the identical
  refusal forever. It shipped because no test read the sentence. When you write a refusal, pin its
  claim against the MECHANISM it describes — assert the remedy's precondition by calling the
  function that decides it, so the copy goes red when the behaviour moves — and remember who reads
  it: telling a language model to do something only a human can do is not advice.

- **Anything path-shaped: Windows is a delivery target.** Most of this was written on
  macOS/Linux, so the recurring defect is code that is genuinely correct on POSIX —
  `split('/')`, `startsWith('/')` as an is-absolute test, a bare `fs.rename`. Use
  `path.basename`/`join`/`sep`, publish files with `renameAtomic`, and write at least one test with
  a real `C:\`-shaped input. Guards enforce some of this and will fail your PR. In the Server
  Edition and relay tabs, the browser's OS is NOT the filesystem's OS: obtain the dialect from the
  core that owns the files, and keep an unobserved host unknown rather than guessing. Conversely,
  on POSIX a backslash is legal filename text — do not treat both separators as interchangeable
  unless the owning filesystem is known to be Windows.

- **Anything tmux does for us on POSIX, the session host owes on Windows.** The two delivery paths
  are not symmetric and the missing half fails in the direction that LOOKS like success: `sendText`
  rides `tmux paste-buffer -p` on POSIX, which frames the payload from the pane's real
  bracketed-paste state and submits with a separate `send-keys Enter`; the session host answered the
  same call with one raw `text + '\r'`, so a paste-aware composer swallowed the Enter as pasted
  content and an injected prompt sat there unsubmitted (issue #686). Before adding a delivery, a
  probe or a pane query, check what the tmux leg does with it and write the host's equivalent in the
  same change. The host can usually answer more precisely than tmux, because its headless emulator
  sees the pane app's own bytes — see CLAUDE.md's "We have our own VT emulator" for the one place
  that reasoning is inverted.

- **A new session-host push frame must be negotiated at `hello`, never just sent.** An older
  `SessionHostClient` treats EVERY push frame whose `type` is not `data` as an exit, and a
  long-lived host routinely outlives the app that started it — so a frame the connection did not
  opt into retires a live session. Add the capability to `SESSION_HOST_FEATURES`, send it only to
  sockets that listed it (the `geometry` push of issue #914 is the worked example), and pin that
  against the real bundled host as `session-host/geometry-host.test.ts` does.

- **Finding a Windows executable is not the same as being able to spawn it.** A PATH lookup may
  correctly resolve an npm CLI to `<name>.cmd`, but Node's `execFile`/`spawn` cannot execute that
  shim directly. For short-lived app-owned subprocesses, pass the resolved path and argv through
  `directExecutableInvocation` (`src/core/exec-path.ts`): it uses hidden `cmd.exe` with explicit
  escaping, verbatim arguments and delayed expansion off. Do not fix this with `shell: true`;
  prompts and other user-controlled arguments would become shell syntax. `.bat`/`.ps1`, CR/LF/NUL
  arguments and lines above cmd's limit fail explicitly. Keep stdin direct: PowerShell's text
  pipeline changes Unicode and line endings under Windows PowerShell 5.1.

- **The phone reaches a Windows desktop through the relay only.** Everything the iOS app sends over
  SSH is POSIX sh plus tmux, and Windows OpenSSH hands out `cmd.exe`, so Windows pairing installs no
  SSH key and requires remote access instead of an SSH server (`src/shared/pairing-gate.ts`). Do not
  "fix" this by installing the key into `administrators_authorized_keys`. The phone tries SSH before
  the relay, so a key that works locks it onto a path that cannot work. CLAUDE.md, "Remote access",
  has the details.

- **A relay channel that names a project needs a row in `relay-project-scope.ts`.** A relay guest
  bound to one shared project must never reach another, and the jail is keyed on channel class:
  anything named `githubIssues:*`, `board-log:*` or `projects.*` is refused on a scoped session
  unless that table can read its projectId. Add the row in the same PR as the channel, or the verb
  is refused for every scoped guest (and `relay-project-scope.test.ts` goes red telling you so).

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

- **A write ack is a claim about a WRITE, never about what the remote now holds.** Do not retire
  state that records "the server still needs to be told X" just because the write returned true.
  The SSH mirror's writer acks the 5 s throttle's trailing write **optimistically** — it returns
  true and schedules the run — so a connection that dies inside that window leaves an ack behind
  with nothing on the wire. Deleting the deletion tombstones on that ack is how 16 terminals
  deleted on a slow link came back, announced as sessions from a phone the reporter does not own
  (`clearedNodes` / `confirmClearedDeletions`, `src/core/workspace-store.ts`). Retire such state on
  a READ that shows the remote no longer has it — which is the same rule this codebase already
  applies in the other direction, "a failed read is never evidence of absence". And when you cannot
  observe where incoming data came from, **do not name a source in the UI copy**: a wrong
  attribution sends the reader hunting for a device instead of at the file.

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

- **A `<webview>` page's wheel never reaches the host DOM.** The guest is an out-of-process frame:
  measured on Electron 42, physical Ctrl/Cmd+wheel reached the page and emitted `zoom-changed` on
  the guest `WebContents`, while no host `wheel` listener fired. Keep `nowheel` on the webview host
  (it protects React Flow routing) and install page zoom in main through `installWebviewZoom`;
  removing the class or adding a renderer wheel handler cannot implement guest zoom. The shared
  renderer controls call the same `@shared/webview-zoom` policy directly on the attached guest.

- **Rendered markdown goes inside a listed container.** A link in `renderMarkdown` output keeps its
  href as written, and a relative one used to navigate the whole app window away (the canvas was
  gone until a reload). One delegated handler (`renderer/lib/markdownLinks.ts`) intercepts clicks
  inside `RENDERED_MARKDOWN_CONTAINERS`; a new surface that injects markdown HTML must use one of
  those classes or join the list — `markdownLinks.test.ts` fails otherwise.

These are the ones that come up in review most often. Each exists because its absence caused a real
bug.

**A project-scoped lookup cannot prove a node does not exist elsewhere.** Link refusals must
name the project boundary and explain that cross-project linking is unsupported; do not scan other
projects just to improve a missing-endpoint diagnostic.

**A failed read is never evidence of absence.** "Could not measure" and "there is nothing" are
different facts and must stay distinguishable at every layer. Collapsing them is how a panel ends up
reporting "no sessions" on a host running thirty. When something ACTS on the negative, give it three
answers rather than two — `present | absent | unknown` (`TranscriptPresence` is the shape) — and let
only the positive finding trigger the action. Ask which of the two mistakes is recoverable: cold
restore wrongly resuming a dead session id costs an error line, while wrongly dropping a live one
opens a blank conversation over work the user believed was continuing.

**Degrade to nothing, never to something wrong.** A probe that fails means the bare, safe command —
never a substituted nearest match. A hand-editable value that is unrecognised must yield the safe
default, never something more destructive than the default.

**A node's OWNERSHIP is persisted state, never a live object.** "Is this node remote / whose host is
it on?" must be answerable with nothing attached, because the questions that ask it — a delete, a
kill, a cleanup — arrive precisely when nothing is: after an app restart, after the offscreen
release, after the park timer, for a project that is not open. `PtyManager.runEndSession` read it
off the dying in-memory `Session` instead, so an SSH node deleted with no live client had its remote
`kill-session` skipped **in silence** and its one kill sent to the LOCAL tmux socket, where a
`requireRemote` node has nothing; the node left the canvas looking deleted and its `nt-<id>` kept
running on the host. Ask the machine-local index (`workspaceStore.sshProjectIdForNode`), and treat a
live handle as the *complement* of that answer, not its source.

**A side effect you could not deliver is not a side effect you performed.** The `ok:false` rule is
not only for reads. `catch {}` around a remote kill folded "tmux says there is no such session" (an
ANSWER) into "the ControlMaster is down" (a NON-answer, session still running). Classify the failure
— and when the work genuinely cannot be done now, either refuse the action with a reason or write
the debt down and settle it later (`core/pending-remote-kills.ts`). Silently dropping it is the one
option that is never available.

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

**Remote context polling must bound bytes before SSH transports them.** Bootstrap from the
file's measured end, keep offsets in raw bytes, and distinguish an idle read from failure so
the poller can back off. Bootstrap history restores usage only, never task/result events.
`core/remote-ssh/transcript-window.ts` and the real-shell remote-context tests pin this contract.

**A shared agent daemon is live-session infrastructure.** Codex's app-server control socket is
shared by every `--remote` TUI in an account scope, so stopping or replacing one daemon disconnects
every attached canvas node. A managed launcher must keep the already-bound thread under a bounded
supervisor: resume only when protocol health failed or the known socket generation changed, never
loop an unrelated client error, and never replay the original prompt after reconnect. Probe a
responsive daemon before invoking lifecycle repair; stale PID bookkeeping is not permission to kill
working sessions. See `docs/shared-codex-node-identity.md`.

**Credentials never ride argv — local or SSH.** Not a tmux `-e` pair, not `curl -H`, not a remote
command string. `/proc/<pid>/cmdline` is mode 444 on a stock Linux, and a remote command line is argv
on the host too: we shipped the hook bearer that way and any other account on the machine could read
it and open a terminal running an arbitrary command. Pass secrets by 0600 file or by **stdin**
(`curl --config -`), and never add an argv fallback. See `docs/node-identity.md`.

**A hook socket path is not ownership proof.** Never unlink a live listener to bind a hook
socket, or overwrite an advertisement whose socket/TCP listener still answers. Local stale cleanup requires `ECONNREFUSED` and an unchanged socket inode; regular files,
symlinks and uncertain probes are preserved. SSH setup allocates a fresh socket and publishes an
installation-qualified endpoint only after bearer verification. A wrong bearer answers 421 before
any handler runs; only that explicit wrong-owner response (or transport failure) permits endpoint
failover. A node-identity 403 stays final. Test with disposable sockets, never a running user's tunnel.

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

**A feature that creates links owes an ownership rule, and it must be a property of the plan.**
"Share `~/.claude/skills` with this account" (issue #643) links each system skill into a managed
account's own `skills/` and removes those links again when switched off — one wrong removal deletes
somebody's real skills folder. Three habits made it safe and they generalize: link the LEAVES, not
the containing directory (nodeterm writes its own canvas skill into `<configDir>/skills/`, so a
directory-level link would have written it into the user's system folder); decide ownership by an
anchored SHAPE (a symlink at `<name>` pointing at `<system>/<name>`) so what the on-switch creates
is exactly what the off-switch removes, and a real directory can never qualify; and compare
REALPATHS before acting, because the hand-made version of the same feature makes the two directories
one and linking into it would plant links in the folder you are about to clean up. Verify the
removal against a real filesystem with real symlinks and real content — a mocked `fs` agrees with
whatever the code believed. And a launch-time sweep may re-create, never delete: ownership inferred
from shape cannot tell your link from an identical one the user made by hand.

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
applied, so the camera appears to jump and zoom. The rule now has three tiers, all membership lists
in `renderer/lib/controlRouting.ts`: `STORE_ANSWERED_VERBS` ("no canvas is needed at either end" —
`list`, `send`, `reply`, `sticky`, `open-project`, `settings`), `canColdOpen` ("a canvas IS needed, but the
serialized one will do" — `open-terminal`, `open-claude`, `open-agent`, which write into the owning
project's stored nodes with their launch armed and report `queued: true`) and `answersOffCanvas`
("…and there is nothing to defer" — `show-image`, `show-video`, `show-web`, `open-browser`, whose
node has no session behind it and is finished the moment it is written, so it reports `offCanvas:
true` and never `queued`). Everything that acts on nodes which already exist still travels, because
it reads live state the serialized copy does not carry — `browser` included, which navigates a
mounted `<webview>` guest, unlike `open-browser`, which only places the node.

Three things to carry over when you put a verb in one of the two off-screen tiers. **The acting
project is the SOURCE's**: `ctlProject` decides the ssh flag, the browser session key and the media
allowlist route, and reading `activeProjectId` there answers a background agent with whatever the
human is looking at. **Nothing may reach the live canvas**: `setNodes` / `setControlEdges` /
`markDirty` address the ACTIVE project, so the write goes through `applyNodeMutation` +
`appendCanvasLinks` + `writeDisk`. And **tell the human** — the reply goes to the agent, so without
a strip nothing anywhere reports that a node landed in another project; it is sticky, because it
describes work the user was not watching. When you add a verb, decide which tier it is in — and if
you change what a verb DOES, update `buildCanvasSkillBody` / `buildCanvasControlInstructions` in the
same PR, with a test that goes red on the stale claim (`src/main/canvas-control-core.test.ts`).

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

**A canvas layout is GEOMETRY, and its two halves live in different files.** A saved layout moves
nodes and nothing else: it never creates, deletes, renames, reparents or respawns one, and never
touches a tmux session. The snapshot itself (`Project.layouts`) is CONTENT and rides the git-shared
`.nodeterm/project.json`, while this machine's camera per layout (`Project.layoutViewports`) is
machine-local and rides `workspace.json` beside `viewport` and `breadcrumbs`. Restoring applies its
camera with `setViewport`, per the `fitView` rule below. Deleting a layout and updating one to the
arrangement on screen both confirm first, because layout edits are not in the undo stack; restoring
does not, because it is. Whether a dialog claims the edit reaches other people comes from
`layoutIsShared`, which is true for an SSH project as well as a folder one.

**Keep-alive webview ghosts must stay mounted, but must not enter minimap geometry.**
They use `display:none`, not React Flow's `hidden` (which unmounts the guest). Render canvas maps
through `VisibleMiniMap`: it filters both drawing and bounds in a minimap-only store while sharing
the live camera. A transparent rectangle alone still distorts the map's scale.

**React Flow's `fitView` is queued, not immediate — never use it to frame something automatically.**
Calling it sets `fitViewQueued` and the fit runs from a later `setNodes` (only once every node is
measured) or the next `updateNodeInternals`, against whatever the node lookup holds by then; a fit
set that comes out empty parks the canvas origin in the middle of the screen. Compute the viewport
yourself and apply it with `setViewport` (`renderer/lib/nodeFocus.ts`, `canvas/fit-view.ts`), which
lands now and against the canvas you meant. `fitAll` is the one deliberate exception: an explicit
user gesture on a settled canvas.

**A context menu is two levels deep, and the third level is discarded in silence.**
`ContextMenu` renders a submenu's children with
`if (child.type === 'colors' || child.type === 'submenu') return null` — no error, no warning,
nothing on screen. That matters most where you cannot see it: Claude's and Codex's **account
pickers are themselves submenus**, so moving one of those rows into another submenu deletes the
account picker for exactly the users who have managed accounts, and looks perfect to everyone
else. If you group rows in an add menu, get the decision from `isPinnedAgentEntry`
(`renderer/lib/addMenuSpec`) rather than judging by eye — and never spell an agent id there: which
rows stay at the top is derived from the row's own shape plus `ACCOUNT_CAPABLE_AGENT_IDS`, so a new
agent is handled the day it is added. The cap is measured in
`components/ContextMenu.submenu-depth.test.tsx`; if you teach the component a third level, that
test tells you which pin to revisit.

**Adding a node kind means touching the add menus once, not four times.**
`renderer/lib/addMenuSpec` owns which kinds are addable and how they are grouped, for the canvas
pane right-click, the sessions-sidebar "+" and the Dock. `ADD_ITEM_GROUP` is a total `Record` over
the kind union, so a new kind is a **compile error** until you route it. The kanban column's
"+ New session" is deliberately not a consumer — it can only offer kinds that become a card — and
`addMenuSpec.surfaces.test.ts` pins that split so "make them all consistent" stays a decision
rather than a reflex.

**A setting read at mount reads the DEFAULT, not the user's.** `useSettings` starts on
`DEFAULT_SETTINGS` and hydrates from disk asynchronously, while `<Canvas />` is mounted before that
lands. A `useState(() => settings.foo ? ...)` initializer therefore reads the shipped default and
never looks again, so an opt-in feature ships inert with a green suite and no error anywhere. Gate
on `hydrated` (the first-launch consent dialog and `settings.rememberCanvasLock` are the worked
examples). If the same effect also WRITES, latch its first run: otherwise switching the setting on
mid-session applies stored state to whatever the user is doing right then, which is a different
feature from the one they asked for.

Maximize placement and refocusing must use the same measured usable rectangle
(`measureMaximizeInsets`): pinned side panels plus persistent top controls and bottom dock.
Do not hardcode chrome heights or add the outer margin twice; transient menus must not resize
terminals. Ordinary focus and zone snap keep their own policies. Test the maximized-only
focus decision through `viewportForNodeFocus`, the same helper Canvas calls, rather than
passing preselected insets straight to the geometry function.

**Usage readouts distinguish failed reads from empty data.** For Claude, show the failure when
`status` is `error` and limits are empty, including beside other providers; preserve last-known
bars when limits remain. Keep both single-account and multi-account views covered.

**A context capacity needs session provenance.** Claude's effective `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
is reported by its managed hook, accepted only with verified node identity, and validated as a
positive decimal safe integer. Never read the app's global env for another session or let a
model-family guess enlarge an observed limit. Unobserved Claude windows are labelled estimates.
The renderer rehydrates through `context.ensure`; it does not restore Claude denominators from
storage. Other agents retain transcript-window persistence.
Only an explicit ensure replays an unchanged live snapshot; repeated hook observations must not
broadcast it again. Remote path, ControlMaster or connection changes replace the tracked generation.

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

Grok billing diagnostics must keep HTTP codes and safe failure categories per billing view. Never send raw error messages, URLs or response bodies to the UI; credentials remain read-only. A failed view is not proof that there is no quota, even when the other view responds.

## User-owned agent settings

Claude/Gemini settings must go through the guarded transactions in
`src/core/agents/hooks/{settings-file,remote-settings-file}.ts`. Confirmed absence or a successfully read empty/whitespace file may start from `{}`;
malformed, non-object and unreadable files must survive unchanged.
Keep unrelated settings and foreign hook handlers. Stage writes, serialize nodeterm writers,
and compare the original bytes again before publishing; never use `cat … || echo '{}'` or a
catch-all read fallback. Local and SSH symlinked profiles update and lock the resolved target without replacing
the link; recheck resolution before publishing. SSH uses plain readlink and cd -P (no GNU -f),
and refuses dangling/cyclic links and newline paths. A conflicting/stale lock skips installation
with a diagnostic naming the lock and safe manual recovery; do not steal it from another process. These locks
coordinate nodeterm, not external editors, so do not claim a filesystem-wide compare-and-swap.
**Creating an agent node is not proof it started.** Control opens retain their launch command
until delivery is acknowledged, and report `queued` while it is held. A successful terminal send
proves delivery only; never describe it as a healthy/running agent without agent evidence.
Desktop launches (automatic and Run now) use the echo-verified command writer, not `sendText`.
Keep unsubmitted UI intent durable through shell settle/unmount. New intent carries `attempted:false`;
Desktop and Server save `attempted:true` before input. Never-attempted warm `--after` launches may
proceed after shell verification; attempted/legacy-unknown intent requires Run now. Only confirmed
submission clears intent. Desktop open replies use `createControlOpenBatch` for queued accounting;
protect that contract and concurrent submission with behavior tests, never source-text pins.
Relay queued/restored launches and Run now are refused until a scoped durable claim API exists.
A new relay UI initialCommand may run once on a fresh PTY through the verified writer, without
workspace writes or pendingLaunch creation. Consume its transient attempt before shell settle;
never retry it on remount or serialize it as durable intent.
Never round-trip a relay workspace load into save: the load can contain only one shared project,
while save replaces the entire host index. A pre-input parked-project deferral keeps intent
never-attempted; it must not poison the writer or trigger a retry timer.
Held Desktop launches retain their attached transport even offscreen with tmux (large fan-outs cost
memory). Server deferred delivery is one-shot: a failed probe/send needs explicit recovery.

## Testing

**Screenshot paste has one route per gesture.** On macOS, Cmd+V saves/uploads a file and
pastes its path; Ctrl+V belongs to the foreground program. A node's configured agent is not
proof of foreground clipboard-image support. Keep shell/SSH/Server file routing and capture
suppression of accompanying text; do not synthesize Ctrl+V or try both routes without a
capability and receipt protocol. The shortcuts panel documents this distinction (#712).

The titlebar's scroll viewport owns its `no-drag` region. Do not add `app-region: no-drag`
to tabs or their descendants: Electron can subtract their off-screen rectangles from the
wordmark's drag area. `scripts/tabbar-drag.test.ts` checks native hit testing with isolated
Electron/Xvfb on Linux; macOS traffic lights and actual window movement still need device checks.

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

**An `infinite` CSS animation is a frame loop, and it runs whether or not anyone is looking.** A
running animation makes the compositor produce a frame every vsync — 120/s on a ProMotion display —
and re-raster the window each time; measured on a 40-terminal canvas, ONE visible pulsing node took
idle CPU from 1.5 % to 33 %, and twenty took it to 101 %. The cost is paid once for the window, so
the step is at the FIRST animation, not the twentieth. Two consequences when you add one: give it
`animation-play-state: var(--nt-anim-state);` right after the shorthand so it joins the idle-window
gate (`src/renderer/styles.animation-gate.test.ts` fails if you forget, because one ungated
animation takes the whole win back), and prefer a static state to a pulse wherever the pulse is not
carrying information the user needs at a glance. The full measurement table and the reasoning are
in CLAUDE.md § Idle energy.

## Pull requests

- Branch from `main`. CI runs `quality`, `CodeQL` and `Dependency review`; all three are required.
- Explain **why**, not just what. If a decision has a trade-off, name it and say what you rejected.
- If you measured something, put the numbers in — they save the next person the same afternoon.
- Say what you did **not** verify. That is more useful than a confident summary.
- **Lead with what changed and why it matters.** A reviewer who reads only your first two
  sentences should be able to decide whether to keep reading; implementation detail comes after.
- **Match the length to the change.** A one line fix gets a paragraph, a change that moves a
  boundary gets as much room as it needs, and neither is improved by headings it does not need.

## Documentation

Two files, two audiences:

- **`CONTRIBUTING.md`** (this file) — what another human needs before touching the code.
- **`CLAUDE.md`** + **`.claude/rules/`** — the deep invariants, per subsystem, with the reasoning and
  the measurements. `CLAUDE.md` holds the cross-cutting rules and an index of the rules files.

**If you change or discover something other contributors must know, update this file too.** An
invariant that only lives in a commit message is one refactor away from being violated by someone
who never saw it.

**Windows text submission waits for the composer.** Use `core/settled-text.ts` for native PTY and
session-host `sendText`: adjacent paste/Enter writes can be consumed in one read. The bounded
screen check may leave text unsubmitted; propagate `pasted-not-submitted` all the way to the
caller and tell the user to inspect the terminal. Never treat that truthy string as success or
automatically retry the paste. True means the requested writes completed, not that a turn began.
The versioned `sendKeysV2` host request refuses old hosts without fallback or restart. Collapsed
or hidden pastes may need manual Enter; device testing remains necessary.

An unanswered Claude `AskUserQuestion` is correlated by session and tool-use ID in the core
mirror, independently of its short-lived display stash. Ordinary hooks, subagent activity and
unrelated transcript results must not clear attention or archive its inbox card. Both shells
use `recordQuestionResult` for transcript rescue (including Escape/decline), and broadcast the
mirror's effective event. Keep result IDs through local and SSH tails; a boolean “some tool
finished” is insufficient. Explicit new user turns, interrupts and session boundaries reset it.

Remote Codex account safety (#736): managed SSH Codex sessions and agent-less login terminals
require a known safe account id and a safe resolved remote home before spawning. The remote env
builder supplies their private `CODEX_HOME`; never fall back to the system login when that scope
is unavailable. System SSH Codex retains the host environment, including during early attach
before home discovery; never inject a guessed `HOME` or `CODEX_HOME`. Custom Codex harnesses use
the same guard. Desktop supports remote account lifecycle; the Server browser still explicitly
rejects managed Codex account management.

- Media URLs live for the app run. Remote cache pruning must keep files already handed to
  players; the cache cap is soft until restart. Use the existing `video` node for audio too.
- Subagent reload replay is display-only and current-host-only. Never replay status/permission
  events or treat a replayed card as verified process ownership; subscribe before taking its snapshot.

**Phone consent belongs to the verified handshake, not the browse socket.** A standing phone's
SAS request survives transport closure only until its 120-second deadline; approval requires the
issued id and displayed box key together. Keep request/reply outcomes distinct (stale request,
failed pin save, missing IPC response, saved-but-disconnected). All production pin/revoke writers
must use `updateApprovedDevices` for the whole read/modify/write, so concurrent updates cannot
lose approvals or resurrect revoked keys. Server Edition does not host this legacy relay path.

Managed Codex login terminals are agent-less: core identifies their provider from the saved
account list. Before opening one, await `useSettings.getState().flush()` after adding the account.
The normal 300 ms coalesced save is too late: an unknown id can launch against the system home.

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

Optional hook ownership failures must never stop Desktop window creation or Server boot. Use the
shared nonfatal startup path and surface its actionable diagnostic. A responding HTTP port is not
nodeterm identity: verify bearer acceptance and rejection. Legacy SSH endpoint migration requires
ownership proof, an unchanged-file check, and stdin-only credential transfer; a project name alone
is not permission to replace another installation's advertisement.

Held approval attention must not replace subagent, recurring or background-task events, or refresh
state evidence from those lifecycle hooks. A parent may ask several questions while a child ticket
is outstanding: track each new picker and preserve child approval cards independently, including
when their display titles match. Answering either resolves only that question or ticket.

SSH Codex metrics must stay scoped to the host and account being read. Credentials and quota
HTTP requests remain on that host; only sanitized usage returns over SSH. Never route a failed
remote context lookup into a local transcript reader, or reuse Claude's token formula/window
estimate for Codex. The system account follows the host login environment; managed accounts
use their validated private home. Usage refresh must not start or repair a shared Codex daemon.

Delayed Windows message submission must recheck the attested child process/birth AND emulator
paste mode immediately before Enter, not just the surviving PTY root. A missing host reply after
a transmitted text request is uncertain delivery, never a pre-paste refusal; show the no-resend
warning. SessionStart idle rescue is scoped to that same nonempty session and agent identity,
and a foreign idle must not broadcast fresh state proof to the renderer.

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
need it too, and wire it in the same change.

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

- **Anything path-shaped: Windows is a delivery target.** Most of this was written on
  macOS/Linux, so the recurring defect is code that is genuinely correct on POSIX —
  `split('/')`, `startsWith('/')` as an is-absolute test, a bare `fs.rename`. Use
  `path.basename`/`join`/`sep`, publish files with `renameAtomic`, and write at least one test with
  a real `C:\`-shaped input. Guards enforce some of this and will fail your PR. In the Server
  Edition and relay tabs, the browser's OS is NOT the filesystem's OS: obtain the dialect from the
  core that owns the files, and keep an unobserved host unknown rather than guessing. Conversely,
  on POSIX a backslash is legal filename text — do not treat both separators as interchangeable
  unless the owning filesystem is known to be Windows.

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

**A stream error is not a throw you can catch.** When a write to `process.stdout`/`stderr` fails —
`EPIPE` down a closed pipe, `EIO` after macOS revokes a closed terminal's tty — node reports it by
emitting `'error'` on the stream a tick later, and the default for an unhandled `'error'` event is
to kill the process. The stack it carries was captured at the write, so the crash *reads* as if it
happened synchronously at your `console.log`, and wrapping that call in `try/catch` changes nothing
(measured on node 22). If you write to a stream that can go away, attach an `'error'` listener and
latch the writer off — `installLogSink` (`src/core/log-sink.ts`) is the worked example. Issue #382.

**Agent features attach to base harness capabilities, not frontend allowlists.** A custom agent can
inherit a builtin harness, so add the capability and its one shared leaf (`src/shared/agents`) and
let every UI ask the helper. Repeating Claude/Codex/etc. cases in menus breaks that inheritance and
eventually drifts.

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

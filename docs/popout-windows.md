# Pop-out project windows

Drag a project tab off the tab strip (or pick **Open in new window** from its caret menu) and the
project opens in its own OS window. Do it again for another project and you have two canvases side
by side on two monitors, each with its own terminals, agents, board and camera. Close the window and
the project goes back to the main window's strip exactly as it was.

> The condensed rules live in `CLAUDE.md` ("Pop-out project windows"); this document carries the
> reasoning, the measurements, and **§7, the device checklist** for what was not verified.

Files:

| Layer | File |
|---|---|
| Which projects a save may WRITE (pure) | `src/core/workspace-scope.ts` |
| The store: scoped saves, the pop-out boot slice | `src/core/workspace-store.ts` (`save(ws, scope)`, `loadFor` → `currentProject` → `buildEntry`) |
| The renderer store's ownership guard | `src/renderer/state/projects.ts` (`OWNERSHIP_GUARDED` / `OWNERSHIP_EXEMPT`) |
| The registry: which window shows which project (Electron-free) | `src/main/popout-windows.ts` |
| The window itself, flush-before-close, the IPC | `src/main/index.ts` (`createPopoutWindow`, beside `createWindow`) |
| The hash both sides read (`#popout=<id>`) | `src/shared/popout-window.ts` |
| The API | `WindowsApi` in `src/shared/types.ts`; `src/preload/index.ts`; browser stub in `src/renderer/bridge/stubs.ts` |
| Renderer identity + the detached mirror | `src/renderer/state/windows.ts` |
| Tear-off / eligibility / next-active (pure) | `src/renderer/lib/popout.ts` |
| The tab strip | `src/renderer/components/TabBar.tsx` |
| The gates (switch, focus, external change, flush, tear-off) | `src/renderer/canvas/Canvas.tsx` |

---

## 1. Why this needed a rule, not just a second `BrowserWindow`

The app was single-window by design. `getMainWindow()` names one window, every push from main
resolves it at send time, and the renderer holds **the whole workspace** — `useProjects` carries
every project's serialized nodes and `writeDisk` saves all of it with `toWorkspace()` on every
autosave. That is fine with one renderer. A pop-out is a **second full renderer**, and the naive
version — open another window on the same page — loses data within minutes:

1. main edits project A and saves;
2. the pop-out, showing B, autosaves — carrying the copy of A it loaded ten minutes ago;
3. `WorkspaceStore.saveNow` skips only an UNCHANGED candidate (`sameProjectContent`), and a stale
   copy is by definition changed, so A's file is written back to the ten-minute-old version, rev
   bumped, and the watcher then reports the store's own write as nothing new.

No conflict bar, no error: A silently loses the edits. The same shape in the other direction
overwrites the pop-out's work with main's stale copy of B. So the design is an **ownership rule**,
enforced where the writes happen:

- **A project is shown by exactly one window at a time.** The main window owns every project except
  the ones registered as popped out; a pop-out owns exactly one.
- **A save carries its sender's scope** (`SaveScope`: `main` with the detached list, or `popout`
  with one id) and the store writes ONLY what the sender owns. Everything else keeps the store's
  previous index entry verbatim and its file is not touched. The shell decides the scope from the
  sending window (`saveScopeFor` — any sender that is not a pop-out, a relay peer included, is
  `main`); the Server Edition sets no resolver and every save there stays unscoped and
  byte-identical. Pinned by `workspace-scope.test.ts` (the merge) and
  `workspace-store.scope.test.ts` (through the real store, on disk).
- **A window never edits what it does not own.** A pop-out cannot switch project — the refusal is in
  the projects store's `setActive`, the one funnel every switch path uses — and the main window
  keeps a *ghosted* tab for a popped-out project whose click brings that window forward.
- **The refusal is in the renderer too, and it has to be** (PR #804 review, blocking 1). The save
  scope drops the project.json half of a foreign edit, silently, and cannot stop anything that
  happens outside project.json. The review measured it: the main window's sessions sidebar renamed
  a popped-out project (reverted with no signal at the next pop-out save) and "Close project → end
  its sessions" KILLED the pop-out's live tmux session while the scope kept the project open on disk.
  So: every per-project mutator of `useProjects` refuses a project this window does not own
  (`OWNERSHIP_GUARDED`, with the value each answers when refused); the ones that must keep working
  are listed in `OWNERSHIP_EXEMPT` with a reason (`replaceProject` IS the mirror refresh); and
  `projects.ownership.test.ts` fails on a method in neither table, so a new mutator cannot slip past
  by being forgotten. The Canvas paths with side effects OUTSIDE the store — ending sessions
  (`closeStoredNodes`, `closeSession`, `endProjectSessions`, the Omni delete), a `/rename` typed
  into the pane (`renameSession`), and the Omni handlers that call `useProjects.setState` directly —
  ask `refuseForeignProject` first, which answers with an info strip naming the project and a
  **Show window** action. A detached project's sidebar project menu offers only **Show window** /
  **Bring back to this window** (the ghost tab's two rows), its session rows only **Go to (in its
  window)** / **Bring project back**, and its Omni Kanban lane is a one-line header with **Show
  window** instead of cards.

Two rules come out of the scope, both in `scopeIndex`:

- main cannot **delete** a detached project (an omitted entry is kept) and nothing can **introduce**
  one the store does not know (an out-of-scope entry with no previous counterpart is dropped);
- for a pop-out scope the previous tab ORDER and the previous `activeProjectId` stand: the pop-out
  is not the window whose tab order or "reopen on this project" preference the index records.

## 2. How a pop-out is born, and how it comes back

`popOutProject` (Canvas) does things in this order, and the order is the contract:

1. commit the live canvas into the store, mark the tab detached (optimistic — main confirms),
   activate the nearest open neighbour (`nextActiveAfterDetach`, the `closeProject` rule) or the
   start screen;
2. **await `writeDisk()` and read its answer** — the pop-out is booted from the project *as it is
   on disk*, so a save that did not land (refused, or the socket closed) means the window would open
   WITHOUT the edits it carried and then autosave over them. `writeDisk` resolves `false` then, and
   the pop-out is refused: the tab is un-ghosted, the canvas it was showing comes back, and the
   user is told;
3. ask main (`windows.popout`). Main refuses if nothing has saved the project yet, and gives the
   tab back on refusal.

Main creates the window with the same preload, lock-down, keydown intercepts and trackpad ledger as
`createWindow`, loads the same page with `#popout=<id>`, and answers that window's
`workspace:load` with a **one-project slice of the store's CURRENT copy** (`WorkspaceStore.loadFor`
→ `currentProject` → `buildEntry`, the same per-entry assembly a full load runs: the folder's
project.json, an ssh entry's cache, an inline data file), queued on `saveChain`. Never a second full
`load()`: that is the boot path — it sidelines corrupt files, runs migrations, re-seeds every
project's `revs` and `lastWritten` — and re-running it under a live main window would race that
window's autosaves for the store's own bookkeeping.

**It is not the renderer's last save either, and that was a data-loss bug** (PR #804 review,
blocking 2). The first version answered from `lastSaved`, which only `saveNow` updates — but the
store writes project files itself: `appendRemoteNode` (a phone registering a session), the
watcher's re-read after a git pull, the ssh reconcile, the kanban and `removeProjectNode` writers.
The pop-out adopts those live via `workspace:external-change` without marking itself dirty, so
nothing re-saves them; and the hash survives a reload (⌘R, the crash auto-reload), which re-enters
`loadFor`, whose answer the boot then saves. The reviewer's probe — save, detach, pop-out
load+save, `appendRemoteNode`, reload, save — ended with the phone's node deleted from disk. That
probe is now a test in `workspace-store.scope.test.ts`, and it fails on the snapshot version.

While the window is open, every save it makes is forwarded to the main window
(`window:popout-project-saved` → `replaceProject`), so main's serialized copy is never more than
one autosave debounce stale. That is what keeps the sessions sidebar, the board and the store-
answered control verbs honest about a project main only ghosts. The copy is never active in main
and main never edits it, so a plain replace can clobber nothing.

Closing the window (its × , ⌘W on the window, **Back to main window**, or the ghost tab's **Bring
back to this window**) runs a **flush handshake**: main intercepts `close`, sends
`window:popout-flush`, the renderer commits + saves and acks `window:popout-flushed`, and only then
does the window really close. Bounded at 2.5 s, because a wedged renderer must not hold a window
open — the ack means "you may close me", never "the save landed". The registry's `closed` handler
un-registers the project, `window:detached-change` clears the ghost, and the tab is clickable
again. On quit every window closes without the handshake, the same debounced-autosave exposure the
main window has always had.

## 3. Where per-node traffic goes

Main used to send everything to *the* window. Now:

- **Per-node pushes go to every app window** (`sendToAppWindows`: agent status, unread clears,
  codex identity, memory / pty pressure, external changes). A node lives in whichever window shows
  its project and the sender does not know which. `platform().broadcast` does the same, so
  presence, canvas mutations and the like reach a pop-out without any per-channel work.
- **Round trips go to the window showing the node** (`windowForNode`: a canvas-control request, a
  browser popup / open-link-in-node, the browser resolve, an OS-notification click). Exactly one
  window answers, so the reply contract (every path replies once) is unchanged.
- **External-change broadcasts are gated in the renderer** (`ownsProjectHere`): the change for a
  project another window owns is that window's to adopt, so main ignores a detached project's and a
  pop-out ignores everything but its own.
- **Alerts belong to one window.** The agent-status bookkeeping (state, session id, account) runs in
  every window — the sidebar needs it — but the interrupts (unread, chime, OS notification) run only
  where the node's project is owned (`alertsHere`, `lib/popout.ts`). Otherwise a popped-out node
  chimed twice, and the unfocused main window marked unread and notified a finish the user watched
  in the pop-out. `app:notify` checks the focus of the window that ASKED (the owner), not the main
  window's.
- **Menu commands go to the focused app window** (`menuTarget`, `popout-windows.ts`): the
  application menu is one per app, and its accelerators (⌘⇧B, ⌘,, the View items) all went to the
  main window — ⌘⇧B with a pop-out focused toggled the board in the window behind it. A focused
  window that is not an app window (DevTools, the notch HUD) still falls back to the main window.
- **Keyboard state is per window** (`main/window-key-state.ts`). The two bits the renderer mirrors
  into main — "a shortcut recorder is armed" and "a terminal has focus" (the `terminal-first`
  policy) — were one global pair guarded to the main window, so a pop-out's intercepts followed the
  MAIN window's terminal focus and a recorder armed in a pop-out's Settings stood nothing down. Each
  app window now reports its own (the sender guard accepts the main window or a pop-out, never a
  `<webview>` guest), its intercepts read its own, and each window's bits are cleared at the same
  three sites as before (closed, render-process-gone, a main-frame navigation), for that window
  only. The application MENU is one per app, so its stand-down follows the focused app window, and
  `browser-window-focus` re-syncs it when the user moves between windows. Verified in the built app
  (sandbox, `terminal-first`) from main's own log: the pop-out's terminal taking focus reported
  from the pop-out's webContents and disabled the menu's stand-down items while that window was
  the focused one. The move BETWEEN windows could not be driven reliably under automation (macOS
  often reports no focused window to a Playwright-driven app), so that half rests on the unit tests
  of its two parts (`menuTarget`, `window-key-state`) and is on the device checklist.
- **Pop-outs count as attached clients** (`clientIds()` includes them). Not optional: the pty
  manager decides "attached" against that list, and a subscriber missing from it reads as detached
  to the session reaper — a pop-out's terminals would be culled after the grace window.
- **Focus forwards.** `switchProject(id)` on a detached id raises that window instead;
  `focusNodeById` / `travelToNode` on a node in a detached project call `windows.focusNode`, which
  raises the window and sends it the same `app:focus-node` a notification click sends. Main's
  notification handler routes the click to the owning window directly.

## 4. What a pop-out deliberately is NOT

- **Not a second main window.** It does not register with `main-window.ts`, and it is NOT a
  presence peer: main never `join`s it, and the renderer's `presence.connect()` returns a no-op
  inside a pop-out, so it never says hello, draws no cursor and sees no peers. Measured on the first
  sandbox run: with only the main-side half, the hub answered the pop-out's hello with the main
  window's own entry and the "Someone else is on this canvas" prompt came up in a window the user
  had just opened. A pop-out is the same person; treating it as a teammate would also start every
  canvas mutation casting (`hasPeers`). Its saves cannot touch another project, and
  `mainWindowClientIds` is untouched.

  It does LISTEN, passively (PR #804 review, should-fix 6). The canvas publisher casts only when
  the presence table holds more than one entry, and a pop-out that never joined had an empty
  table, so its edits reached teammates only after one of THEIR mutations arrived. Now `connect()`
  in a pop-out subscribes to the peer diffs (which `broadcast` already delivered to it) and seeds the
  table from `windows.presencePeers` — main answers with the hub's table, for pop-out senders only.
  The table holds the main window's own entry, so "more than one" means exactly "a teammate is
  here", the same rule the main window applies. `myId` stays null, so every drawn selector
  (facepile, cursors, the name prompt) still answers nothing. Pinned in
  `presence-session.test.ts`.
- **Not persisted.** Which projects are popped out is runtime state; a restart opens everything in
  the main window. Remembering pop-out geometry per project is a follow-up (the main window's
  `window-state.ts` is deliberately not reused — it records THE window).
- **Not available in the Server Edition or a relay tab.** A browser tab cannot spawn app windows and
  a relay tab is a view of another machine: `windows.popout` rejects, the tab menu hides the row,
  the drag never tears off (`isBrowserRuntime()`). Mobile: N/A (no tab strip).
- **Not nestable.** Inside a pop-out the strip shows one tab, no `+`, and the palette omits New
  project / Clone / New Remote — a project minted there would be outside the window's scope and
  would never persist.

## 5. Measured / verified

- **Driven end to end on macOS** (Playwright over a throwaway `NT_MULTI` instance, own userData
  and `TMUX_TMPDIR`, three seeded cwd-less projects each holding one sticky note): caret menu →
  "Open in new window" opened Beta in a second window loaded with `#popout=beta`, showing only that
  tab, no `+`, the way back, and the note; a REAL drag of the active Alpha tab released on the
  canvas tore it off the same way; the main window kept both as ghosts and activated Gamma;
  renaming Beta inside its pop-out reached the ghost tab within one autosave; renaming Gamma in
  main persisted beside it; "Back to main window" closed Beta's window and its tab came back
  normal, and clicking it showed the pop-out's canvas. On disk afterwards: `alpha.json` name
  `Alpha` rev 2, `beta.json` name `Beta renamed` rev 3, `gamma.json` name `Gamma renamed` rev 3,
  index order unchanged — each file carries exactly its owner's edits. Zero renderer errors or
  warnings across all three windows.
- `workspace-store.scope.test.ts` runs the stale-copy scenario from §1 against the real store on a
  temp dir: after a pop-out save carrying a stale A, A's file still holds main's edit; after a main
  save carrying a stale B, B's file still holds the pop-out's edit; the index keeps main's order and
  active project throughout.
- The pop-out boot slice is the store's current copy of the project: a write the store made while
  the window was open (the reviewer's `appendRemoteNode` probe) is in the reload and survives the
  pop-out's next save.
- `projects.ownership.test.ts`: the main window cannot rename, recolor, re-folder, close, delete or
  edit the nodes of a popped-out project; `replaceProject` still refreshes its mirror; a pop-out
  writes only its own project; every store method is classified guarded or exempt.
- `popout-windows.test.ts`: a closed window un-registers itself, a late `closed` from a replaced
  window cannot un-register its successor, a destroyed window is already not a pop-out, the scope
  by sender, and the routing helpers.
- `TabBar.test.tsx`: the ghost tab (marker, not draggable, click → `onSwitch`, a two-row menu), the
  "Open in new window" row, the pop-out strip (one tab, no `+`, the way back, no Close project), and
  a drag released below the strip tearing off while a drop on another tab reorders.
- `window-raise.guard.test.ts` counts the four new raise calls with their reasons: the pop-out's
  first-paint `show` (once), and `raisePopout`'s restore/show/focus, reached only from sender-
  guarded IPC handlers whose callers are clicks.

## 6. Known gaps (v1)

- **Shared `localStorage`.** Both windows are the same origin, so the per-viewer stores (view mode,
  explorer expansion, `nodeterm.agentStatus`'s unread/session map) are last-writer-wins across
  windows. Reading `unread` in one window can be undone by the other's next persist. The honest fix
  is per-window keys or main-owned state; not done here.
- **A pop-out's geometry is not remembered** (§4).
- **The Omni Kanban and the sessions sidebar list a detached project from main's mirrored copy**,
  which lags the pop-out by one autosave debounce (≤ 800 ms). Only NAVIGATION routes to the window
  (row click, "Go to", Show window); every edit or teardown is refused there with a pointer to the
  window (§1). Moving those actions INTO the owning window (e.g. "End session" run by the pop-out)
  would need a cross-window command channel; not done.
- **The WebGL budget is per renderer.** `setWebglBudget` runs at each window's boot, so two windows
  can hold 2 × 24 contexts (2 × 16 on macOS) where one window held 24 (16). Chromium's
  `--max-active-webgl-contexts` cap is counted per renderer process, and each window is its own
  renderer, so the two budgets do not compete for one cap. What they do share is the GPU and the
  compositor, which is what the macOS number exists to limit — see the soak below.

## 7. Device checklist

Verified on macOS (see the PR for the run). Owed elsewhere:

1. **Windows / Linux**: releasing a dragged tab OUTSIDE the window. `dragend` coordinates are only
   trustworthy on macOS; Chromium on Linux can report an outside release as (0, 0), which reads as
   a cancelled drag inside the strip. The decision therefore no longer rests on them alone: the tab
   strip tracks the drag at the document level — a `dragleave` with no `relatedTarget` marks "left
   the window", and every `dragover` records the last position inside it — and `isTabTearOff` asks
   those first (unit-tested). Re-verified on macOS with real drags (a reorder opens nothing, a
   release on the canvas tears off). Still to confirm on the other two: that Chromium there fires
   the document `dragleave` when the pointer leaves the window. If it does not, the outside release
   still falls back to the old coordinates (a cancelled drag); the caret-menu row works either way.
2. **Linux**: the pop-out's window icon (`linuxWindowIcon`, the same png as the main window).
3. **Windows / Linux**: closing the MAIN window while pop-outs are open — main's `close` runs the
   quit confirm and `app.quit()`, which closes the pop-outs (without the flush handshake, as on any
   quit). Confirm no pop-out is left orphaned.
4. **Two pop-outs closing in the same tick** — the flush map is keyed by webContents id; confirm both
   ack independently rather than one timing out.
5. **macOS: two-window WebGL zoom-out soak — run 2026-09-23, clean.** MacBook Pro (Mac17,6, Apple
   M5 Max), macOS 26.6.2, Electron 42.10.1, a build of this branch in an `NT_MULTI` sandbox. The main
   window and a pop-out sat side by side, each on a canvas of 24 live terminals, and a driver ran
   61 cycles over 4 minutes in each window: fit all, pinch-zoom in, zoom out past fit, pan back and
   forth. Each window held exactly its budget of 16 WebGL terminals for the whole run (32 live
   contexts across the two), with **0** `webglcontextlost` events in either window. In the final
   screenshots every terminal was painted, with no "lost context" placeholder and no black terminal.
   An earlier 4-minute run that drifted to 1% zoom with the terminals scrolled off screen also saw 0
   losses, but it proves less. Not covered: an Intel Mac or a low-memory GPU, where a forced
   eviction is likelier, and terminals streaming output during the zoom (these showed their
   prompts). If an eviction does show up there, split one budget across the windows (main hands
   each renderer its share); do not raise the cap.
6. **`terminal-first` with two windows**: focus a terminal in a pop-out, then click into the main
   window (no terminal focused there) — ⌘M should minimize the main window; click back into the
   pop-out's terminal — ⌘M should reach the terminal.
7. **The reviewer's blocking scenarios on a device**: with a terminal-bearing project popped out,
   the main window's sidebar project menu shows only Show window / Bring back; sidebar ×, Omni
   delete and "Close project → end sessions" are refused with the strip, and `tmux ls` still lists
   the pop-out's session.

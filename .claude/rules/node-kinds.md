---
paths:
  - "src/renderer/nodes/**"
  - "src/renderer/editor/**"
  - "src/renderer/glyphgrid/**"
  - "src/renderer/state/workspace.ts"
  - "src/renderer/state/webviewKeepAlive.ts"
  - "src/renderer/canvas/VisibleMiniMap.tsx"
  - "src/renderer/canvas/toKanbanSession.ts"
  - "src/renderer/lib/download.ts"
  - "src/renderer/lib/explorerCreate.ts"
  - "src/renderer/lib/filesNode.ts"
  - "src/renderer/lib/markdown*.ts"
  - "src/renderer/lib/reopenNode.ts"
  - "src/renderer/lib/terminalOutputMarkdown.ts"
  - "src/renderer/lib/triggerCard.ts"
  - "src/renderer/lib/webviewKeepAlive.ts"
  - "src/renderer/terminal/copy-feedback.ts"
  - "src/renderer/terminal/file-links.ts"
  - "src/renderer/terminal/terminal-config.ts"
  - "src/renderer/terminal/useMdModeFocus.ts"
  - "src/renderer/boot.tsx"
  - "src/core/fs-*.ts"
  - "src/core/media*.ts"
  - "src/main/navigation-guard.ts"
  - "src/main/ssh-fs.ts"
  - "src/main/webview-zoom.ts"
  - "src/main/media*.ts"
  - "src/shared/webview-zoom.ts"
---

## Node kinds (all rendered by React Flow custom nodes)

- **terminal** (`TerminalNode.tsx`) — xterm + tmux (see `.claude/rules/tmux-sessions.md` and `.claude/rules/terminal-node.md`). Header: collapse, color,
  click-to-rename title, ✦ AI-name, ×. Body has a **hover guard** (dwell `settings.panHoverDelay`,
  default 600 ms; see **Terminal node lifecycle** in `.claude/rules/terminal-node.md`). **Cmd/Ctrl+M** (while hovered) toggles a markdown
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
  **Selection + copy is tmux's** (mouse, copy-mode and the OSC 52 → system-clipboard path: **Terminal
  session continuity** in `.claude/rules/tmux-sessions.md`). OSC 52 writes an app emits itself (vim `"+y`, gh, yazi) reach the clipboard through the
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
  fs via cached parent-dir listings, with `path:line[:col]` compiler-output suffixes). The path
  dialect follows the FILESYSTEM-OWNING CORE, not the viewer: desktop-local may use its own
  platform, Server Edition and relay tabs use the core's reported `process.platform`, and SSH
  projects are POSIX. A failed host-platform read disables file links for that connection — it
  never guesses from the browser. Standalone `ssh` terminal nodes remain URL-only because they
  have no remote fs API with which to verify a token; relay tabs do have a core-bound, jailed fs
  API and therefore support file links. Windows existence matching is case-insensitive and accepts
  both separators; UNC tokens are refused whole before they can be reinterpreted as cwd-relative.
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
  agent's capabilities** (see **Agent support** in `.claude/rules/agents.md`): a busy/working badge + unread dot +
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
  sort leaves it alone, so a nested tree still hydrates parent-first and renders there).
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
    on day one; `mkdir`/`exists` are genuinely LIVE on a relay tab (see the Explorer bullet in `.claude/rules/canvas-ui.md` —
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
- **dino** (`DinoNode.tsx`) — a small self-contained T-Rex-style runner on a canvas (no PTY);
  high score persists via `data.highScore`.
- **trigger** (`TriggerNode.tsx`) — a canvas-owned schedule (cron / interval / once) that
  delivers a payload into a connected terminal/agent node when due (issue #493 — the inverse of
  the ephemeral loop/cron cards, which visualize AGENT-initiated recurrence). The card shows the
  schedule + next-run countdown, the target (a derived, never-persisted edge — the
  pending-launch dep edge is NO longer one: since the 2026-09-02 edge model it is a persisted rope,
  `ctrl-<dep>-<node>`, whose dashed ⏳ LOOK is what is derived), the payload, an honest
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

## Media playback lifetime (#680)

Audio routes through `isMediaFile` to the existing persisted `video` kind and native audio controls.
Legacy audio editor nodes migrate on load. Desktop uses the existing local/SSH allowlist; Server
and relay retain their explicit media transport degradation. Native mobile does not consume these
React nodes; its own player/IME behavior requires a separate device check.

Remote cache entries requested in this run are retained until exit, including cache hits; pruning
waits are coordinated with a concurrent cache reader. The 20-entry cap is soft for retained files,
so disk use may grow in a long run; prior-run entries are eligible again after restart. `mediaRange`
handles suffix ranges and rejects unsatisfiable ones without weakening the serve-time path jail.

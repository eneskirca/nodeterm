# Node kinds (all rendered by React Flow custom nodes) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

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

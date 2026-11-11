# Node icons (emoji, glyph or picture) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

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

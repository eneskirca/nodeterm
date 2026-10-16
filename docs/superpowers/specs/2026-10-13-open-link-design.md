# Design: `nodeterm://open` links

**Date:** 2026-10-13
**Status:** Built (PR 1 + PR 2). Signed links are not built. See "As built" at the end.
**First consumer:** an external code-review tool's "Discuss" button.

## Problem

An app outside nodeterm, like a review tool, a script or a bookmark, has no way to open a session on the canvas. Canvas control (`open-claude`, `open-terminal`, …) only answers callers that carry a node identity. That is on purpose: a process without a node has nothing to prove who it is. So today such an app can only copy a `claude …` command for the user to paste into a terminal node.

A URL scheme fixes this without weakening canvas control. The link proves nothing about who sent it. Instead, **the human approves every link in a confirm sheet** before anything opens. The link only fills in the form.

## The link

```
nodeterm://open?agent=claude
               &project=<project id>            (or project-cwd=<absolute path>, or neither)
               &cwd=<absolute path>
               &prompt=<url-encoded text>        (or prompt-file=<absolute path>)
               &title=<node title>
               &source=<short label, e.g. my-tool>
```

| Param | Required | Rules |
|---|---|---|
| `agent` | yes | One of the agents nodeterm can already open: `claude`, `codex`, `gemini`, `opencode`, … or `terminal`. Unknown means the link is refused. |
| `project` | no | A project id from the workspace store. See "Choosing the project". |
| `project-cwd` | no | Absolute path. Matches the project whose `cwd` equals it. Can't be combined with `project`. |
| `cwd` | no | Absolute, existing directory. Defaults to the chosen project's `cwd`. |
| `prompt` | no | The first message for the agent. Capped at 8 KB after decoding. |
| `prompt-file` | no | Absolute path to a regular file of at most 64 KB, read when the user accepts. Lets a caller pass a long prompt without a giant URL. Can't be combined with `prompt`. |
| `title` | no | The node title, max 80 characters. `open-claude` has no title option today (`canvas-control-core.ts:865`), so this adds one, or renames the node right after it's created. |
| `source` | no | Display-only label shown in the sheet. It is never trusted for anything, because any web page can claim any `source`. |

The parser rejects:
- unknown params
- the same param given twice
- any value over its size cap
- relative paths.

It does **not** take canvas-control's power flags: `--count`, `--group`, `--after*`, `--run-now`, `--model`, `--issue`, or a permission mode. A link opens one node in the project's default permission mode. It can never ask for a looser one.

## Choosing the project

Requirement: a link must be able to name a project, and nodeterm must never quietly guess where a session goes.

1. **`project=<id>`**: that project, if it exists in the workspace store, either open or in the reopenable list (`projects.ts:246 reopenProject`). An unknown id isn't an error. The sheet says "Project not found" and shows the picker.
2. **`project-cwd=<path>`**: the project whose `cwd` is exactly that path. If several match, the picker is shown with those preselected first.
3. **Neither**: nodeterm suggests the project whose `cwd` is the longest prefix of the link's `cwd`, and falls back to the active project.

In every case the project is a **dropdown in the confirm sheet**, pre-filled from the rules above and changeable before accepting. The sheet also offers **"Open `<cwd>` as a new project"** (`projects.ts:78 openFolderProject`) when no project fits. The sheet always shows where the node will land, and the user always gets to change it.

SSH projects (`Project.ssh`) are out of scope for v1. They aren't offered in the picker, and a `project=` naming one says so.

If the chosen project isn't the one on screen, accepting switches to it (`setActive`). The new node is placed at the centre of that project's viewport. It has no parent edge, since no node asked for it.

## The confirm sheet

The sheet is a modal in the renderer. A native `dialog.showMessageBox` can't hold a project picker and a scrollable prompt. It shows:

- **Header:** "Open a Claude session?", plus `from <source>` in muted text with a note that the label is unverified.
- **Fields:**
  - Project (dropdown), working directory (with a warning if it's outside the project's `cwd`), and title.
  - The **full prompt**, read-only and scrollable. With `prompt-file`, it also shows the file path.
  - The permission mode the session will start in (the project default).
- **Buttons:** **Open** and **Cancel**. Enter doesn't accept until the sheet has been open for about 1 second, so a click or keypress that was already happening can't approve a link that just arrived.

Only one sheet is shown at a time. A second link that arrives while a sheet is up replaces it only if the sheet is untouched. Otherwise it is dropped with a toast. More than 5 links in a minute and the rest are dropped with a toast, so a page can't spam dialogs.

## Plumbing

All of this is in the desktop app only. The Server Edition and relay are untouched.

1. **Register the scheme.**
   - Add `"protocols": [{ "name": "nodeterm", "schemes": ["nodeterm"] }]` to the electron-builder `build` block (`package.json:38`). That writes `CFBundleURLTypes` on macOS.
   - Call `app.setAsDefaultProtocolClient('nodeterm')` at startup. Dev builds pass `process.execPath` and the script path so a dev run can be the handler.
2. **Receive the URL.**
   - **macOS:** `app.on('open-url')`. Register it in `will-finish-launching` so a link that cold-starts the app isn't lost. Hold the URL until the main window and renderer are ready.
   - **Windows/Linux:** the URL arrives in `process.argv` on first launch and in the `second-instance` argv afterwards. The current `second-instance` handler (`index.ts:825`) only focuses the window, so extend it to scan argv for `nodeterm://`.
3. **Parse in a pure module.** Add `src/shared/open-link.ts`, with no electron or fs imports, unit-tested on its own like `pairing.ts`. It returns a typed request or a refusal reason.
4. **Validate in main.** Main checks:
   - the `cwd` exists and is a directory
   - `prompt-file` is a regular file under the cap
   - the `agent` is installed
   - the named project resolves.

   The renderer never receives a path main hasn't checked, which matches the posture of the `open-project` gate (`index.ts:4231`).
5. **Ask.** Main focuses the window and sends `open-link:request` with the validated request and the resolved project candidates. The renderer shows the sheet and replies with the human's choices (project id, cwd, title) or a cancel.
6. **Open.** Main re-checks the reply. The renderer is the more attackable half: it can't swap in a different cwd or prompt, it can only pick among the candidates main offered or the "new project" folder. Main then calls the same node-creation path the `open-claude` dispatch uses (`Canvas.tsx:14046`), tagged `origin: 'link'` so it has no caller identity and doesn't touch the grant ledger (`project-grants.ts`).

**Existing `nodeterm://pair` and `nodeterm://join` strings.** Once the scheme is registered, clicking one of these opens nodeterm. Route them to the existing pairing and join screens with the code pre-filled. Never auto-accept, because those flows have their own approval. Any other host (`nodeterm://anything-else`) is ignored with a toast.

## The calling app's side

- **The button:** a "Discuss in nodeterm" action becomes a plain `<a href="nodeterm://open?…">`. It needs no server round-trip, apart from writing a prompt file when the prompt is long.
- **The project:** the app keeps its own map from its repositories to nodeterm project ids. Without a mapping, it sends `project-cwd=<path of the repository>`. If that matches nothing, the sheet's picker covers it. To make ids easy to copy, nodeterm adds **Copy project id** to the project tab's menu.
- **Fallbacks:** the app keeps its existing copy-a-command path for when nodeterm isn't running or isn't the registered handler.

## Later: signed links (optional)

If the sheet gets tedious for links the user makes themselves, add signed links:
- Nodeterm stores an HMAC key per trusted source in the system keychain, created from Settings, which the user pastes into the calling app once.
- The link carries `ts` and `sig` (HMAC over the canonical params plus `ts`). Nodeterm accepts a signature for 2 minutes and only once.
- A valid signature shows **"Verified: <source name>"** instead of the unverified label. It can also unlock an opt-in **"Open without asking"** for that source, stored machine-local in the same way as `trigger-arm-store.ts`.

Unsigned links always get the sheet.

## Tests

- **`open-link.ts`:** every param, cap, duplicate, unknown param, the mutually exclusive pairs, and encoding edge cases. Encoding cases are spaces, `+` versus `%20`, unicode, and `%00`.
- **Project resolution:** id hit, id miss, a `project-cwd` that matches exactly, several, or none, longest-prefix inference, SSH projects excluded.
- **Main validation:** a missing cwd, a cwd that is a file, a prompt file over the cap or not a regular file, an agent that isn't installed.
- **Renderer reply tampering:** a cwd or project that main didn't offer is refused.
- **Delivery:** a cold-start `open-url` is held until the renderer is ready; `second-instance` argv is parsed; links over the rate limit are dropped.
- **Manual:** on macOS, `open 'nodeterm://open?agent=claude&project-cwd=…&prompt=hi'` with the app closed, open, and on a different project.

## Suggested PR split

1. **Parser and scheme registration:** the `open-link.ts` module and its tests, the scheme registration, and `open-url`/argv receipt. It only logs the parsed request and routes `pair`/`join`.
2. **Confirm sheet and node creation:** the sheet, the project picker, main re-validation, the `origin: 'link'` open path, and the `title` support.
3. **Calling app:** switch its button to the link and add its project map. This change is outside nodeterm.
4. **Later:** signed links.

## Open questions

- Should `agent=terminal` with a `prompt` be allowed? Typing text into a shell is closer to running a command than to sending a chat message. The proposal is to refuse `prompt` for `terminal` in v1.
- Which Claude account should the session use? The proposal is the project's `defaultAccountId`, shown in the sheet, with no link param for it.
- Should the node join the project's kanban board in a column? The proposal is no; it lands like any new node.

## As built (2026-10-13)

Files: `src/shared/open-link.ts` (parser, project resolution, wire types), `src/main/open-link.ts`
(delivery, rate limit, validation, accept re-check; electron-free), `src/main/open-link-wiring.ts`
(fs/PATH/launch-prompt deps + three raw `ipcMain` handlers), `src/renderer/components/OpenLinkSheet.tsx`
and `src/renderer/lib/openLinkSheet.ts` (the sheet), and the Canvas wiring next to "Open recent".

Decisions where the proposal left room, or where the build differs from it:

- **Feature flag, off by default.** `settings.allowOpenLinks` (Settings → Behavior, "Allow
  nodeterm:// links"). Main checks it on every link before parsing and again on accept (switching
  it off while a sheet is up refuses that sheet's Open). Off, a click shows one notice naming the
  setting. The scheme is registered either way.

- **Enter never opens.** The proposal let Enter accept after ~1 s. Every dialog nodeterm raises on
  someone else's behalf answers only to a click (components/confirm-key), so this one does too: the
  Open button is disabled for 1 s, then needs a click. Escape cancels (after 500 ms, never a held key).
- **The agent check is a warning, not a refusal.** A launch-command override can make the bare
  binary irrelevant, so "`claude` was not found on this machine's PATH" is shown in the sheet.
- **Open questions answered as proposed:** `agent=terminal` refuses `prompt`/`prompt-file`; the
  account is the project's `defaultAccountId` (shown in the sheet for Claude); the node does not
  join a kanban column.
- **`prompt-file` is copied.** Main reads it when the link arrives (to show it), reads it again on
  accept, refuses if it changed, and copies the text into nodeterm's own launch-prompt store
  (`<userData>/launch-prompts`, 30-day TTL). The pane reads the copy, so the session gets exactly the
  text the human saw. The structure (newlines) is kept. An inline `prompt` is flattened and spilled
  to a file when it is too long for a typed line (#706), like every other open.
- **Main resolves projects from its own workspace index**, never from the renderer. The sheet replies
  with a candidate id or "new project" plus a title; main re-checks the id is still in the index and
  still offerable, re-stats the cwd, and the cwd and prompt in the final open come from main.
- **A pending request is single use** (forgotten on the first accept, refused or not) and expires
  after 10 minutes; at most 4 are kept.
- **Delivery.** macOS `open-url` is registered in `will-finish-launching`; Windows/Linux read
  `process.argv` and `second-instance`'s argv. Links are held until the renderer calls
  `openLink.ready()`, and held again from a main-frame navigation / renderer crash / window close
  until the next page says ready. The rate limit (5 a minute) counts every link, held ones included.
- **Registration.** `build.protocols` in package.json (CFBundleURLTypes on macOS, the desktop entry
  on Linux) plus `app.setAsDefaultProtocolClient('nodeterm')` in packaged builds. A dev run
  registers only with `NODETERM_DEV_PROTOCOL=1` (it would otherwise take the scheme from the
  installed app). NT_MULTI sandboxes take links only with `NODETERM_DEV_PROTOCOL=1` and never
  register the scheme (live test: `open -a node_modules/electron/dist/Electron.app 'nodeterm://…'`).
- **pair/join links** open the existing "paste the code" prompt pre-filled; the human presses
  Connect, and the existing SAS compare / join flow runs from there.
- **Copy project id** is on the project tab's menu (local projects only).
- **Server Edition / relay:** not applicable. The bridge stub never fires and refuses `accept`; the
  `open-link:` channels are host-only.

- **Hardening from review (before the PR):** a POSIX path with a backslash, UNC, and `/net` /
  `/Network` are refused (a pre-sheet stat must not reach another machine); hidden Unicode
  (`\p{Cf}` except ZWJ, C1) is refused in prompts, prompt files, paths and labels; the prompt file
  is read from one non-blocking open; the sheet probes a new project's committed permission mode and
  the launch refuses if it differs; a sheet is replaced only in its first second; Space does not
  activate Open; a project whose folder changed refuses on accept; `/` and the home folder are never
  offered as a new project; an accepted link that has not landed in 30 s is dropped.

Not built: signed links; a `title` option on the `open-claude` control verb (the link path sets the
title itself); a device run on macOS / Windows / Linux of a real click (static checks and unit
tests, plus one live macOS run: a dev sandbox, `open -a … 'nodeterm://open?agent=claude&project-cwd=…'`,
sheet confirmed, new project + Claude node opened and answered).

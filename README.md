<div align="center">

<img src="docs/assets/nodeterm.png" alt="nodeterm" width="120" height="120" />

# nodeterm

**A node-based terminal manager — your terminals and agents on an infinite canvas.**

Multiple real terminals live as draggable nodes on a single pan/zoom canvas, and every
project doubles as a **Trello-style board of live Claude Code sessions**. Built for
people with ADHD and scattered workflows: a spatial layout instead of a stack of
hidden tabs.

[![Platform](https://img.shields.io/badge/platform-macOS%20(arm64%20%2B%20x64)%20·%20Linux%20(x64)%20·%20Windows%20(x64%2C%20beta)-black)](https://nodeterm.dev)
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/eneskirca/nodeterm?style=flat)](https://github.com/eneskirca/nodeterm/stargazers)
[![Latest release](https://img.shields.io/github/v/release/eneskirca/nodeterm?include_prereleases&sort=semver)](https://github.com/eneskirca/nodeterm/releases)
<!-- Installer downloads: .dmg + .AppImage + .deb + Setup .exe across every release, hand-written on purpose.
     shields' github/downloads/…/total reads ~12× higher because electron-updater's own traffic
     (latest-*.yml polls, mac .zip deltas, blockmaps) is counted as downloads there. Recount with:
     gh api --paginate repos/eneskirca/nodeterm/releases --jq \
       '[.[].assets[] | select(.name|test("\\.(dmg|AppImage|deb|exe)$")) | .download_count] | add' -->
[![Downloads](https://img.shields.io/badge/downloads-1.2k-brightgreen)](https://github.com/eneskirca/nodeterm/releases)

<a href="https://trendshift.io/repositories/103825?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-103825" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/103825" alt="eneskirca%2Fnodeterm | Trendshift" width="250" height="55"/></a>

[Download](#-download) · [Docs](https://nodeterm.dev/docs) · [Features](#-features) · [Build from source](#-build-from-source) · [Architecture](#-architecture) · [License](#-license)

</div>

---

<div align="center">
  <a href="docs/assets/hero-tour.mp4">
    <img src="docs/assets/hero-tour.webp" alt="nodeterm in 30 seconds — canvas, agents, kanban board, three surfaces" width="900" />
  </a>
  <br/>
  <sub>▶ <a href="docs/assets/hero-tour.mp4">Watch the 30-second tour with sound</a></sub>
</div>

## Why nodeterm

Stacked terminal tabs hide context — you lose track of what's running where. nodeterm
turns that into a **map**: every shell is a node you can place, group, label, and zoom
into. Sessions are spatial and persistent, so your mental model stays intact across
restarts. And because the app is built around a clean service seam, the same canvas runs
three ways — as the **desktop app for macOS, Linux and Windows (beta)**, as a **self-hosted browser app**
you reach from anywhere (Server Edition), and an **iOS companion** that attaches to the
same live sessions.

📚 **Full documentation lives at [nodeterm.dev/docs](https://nodeterm.dev/docs)** — get
started, concepts, agents, remote access, troubleshooting.

## ✨ Features

<table>
<tr>
<td width="42%" valign="middle">

### Everything is a node

Right-click the canvas to open a **terminal** — or an AI **agent**. Each runs in its own
persistent tmux session, next to **sticky notes** (link one to feed an agent context),
**Monaco editors**, **diff views**, and **web/video** nodes — arranged spatially, like a
map. Quit the app, even **restart the machine** — every session comes back.

</td>
<td><img src="docs/assets/canvas-tour.webp" alt="The canvas — terminals, agents, notes, editors and diffs as nodes; sessions survive a full restart" /></td>
</tr>
<tr>
<td width="42%" valign="middle">

### Know when an agent needs you

Hook-driven status — no output scraping: pulsing **RUNNING / NEEDS YOU** badges,
**subagent** cards with live transcripts, a per-node **context meter**, and OS
notifications. Click the ping, answer the permission prompt right in the node, and get
told the moment the turn is **done**. On a MacBook, agents live in the **notch** too.

</td>
<td><img src="docs/assets/agents-tour.webp" alt="Agent status — NEEDS YOU flip, notification, answering a permission prompt, subagent fan-out" /></td>
</tr>
<tr>
<td width="42%" valign="middle">

### One project, two views

Every project is a canvas — **and also a kanban board**. Cards *are* your live
sessions: drag them across columns while the agent keeps running, open a card into a
**live card modal** (the real session + members, due date, priority, comments), and
assign teammates. Toggle with `⌘⇧B`.
<br/><sub>▶ <a href="docs/assets/kanban-launch.mp4">Watch the board video with sound</a></sub>

</td>
<td><img src="docs/assets/kanban-launch.webp" alt="The kanban board — live session cards, drag between columns, the card modal with a live Claude Code session" /></td>
</tr>
<tr>
<td width="42%" valign="middle">

### Your sessions, anywhere

**Pair your phone** with one QR — *scan with the nodeterm iOS app* — and the **same
live session continues in your pocket**, E2E encrypted **over the relay, not just your
LAN**. The same canvas also runs self-hosted in any browser (Server Edition).

</td>
<td><img src="docs/assets/remote-tour.webp" alt="Pair your phone — scan the QR, the same live session continues on the iPhone" /></td>
</tr>
<tr>
<td width="42%" valign="middle">

### Talk to your terminal

Hold `⌘⌥` and say it. On-device **Whisper** transcribes locally — review the text,
then **Send** (nothing auto-submits). Your voice never leaves the machine.

</td>
<td><img src="docs/assets/dictation-tour.webp" alt="Dictation — hold ⌘⌥, speak, review, send into the terminal" /></td>
</tr>
</table>

### Node kinds

🖥 **Terminal** (xterm + tmux, AI naming) · 🤖 **Agent** (Claude Code / Codex / Gemini /
GitHub Copilot / opencode / Grok / AGY / Pi / Goose / custom) · 📝 **Sticky note** (link to an agent as context) · 🗂 **Group**
(bind to a **git worktree** for agent-per-branch) · ✏️ **Editor** (Monaco, ⌘S) ·
🔀 **Diff** · 🌐 **Web / Video**

### More

- **Session continuity (tmux)** — terminals keep running across node remounts *and* full
  app restarts, including live processes; machine reboots restore scrollback and resume
  agent sessions (`claude --resume`). The macOS app **ships its own tmux**, so this works
  with nothing installed; a tmux already on your system is always used in preference to it,
  and terminals opened before an upgrade stay as they were until you refresh the node.
- **Agent superpowers** — **context links** so agent nodes read each other's transcripts
  on demand; Claude-only **branch a conversation** and **managed accounts** for several
  logged-in Claude identities side by side; agents can drive the canvas (open nodes,
  spawn teams, verify each other's work) via the built-in canvas-control CLI.
- **Remote / SSH projects** — open a project on a remote host over SSH; terminals, files,
  git, and even the board run there while the canvas stays local.
- **Source control** — VS Code-style stage/unstage, discard, branch switch/create,
  commit, push/sync/publish, **worktrees**, and `gh` sign-in — backed by system `git`.
- **GitHub Issues on Kanban** – opt-in issue cards, exact label-to-column mapping,
  All / GitHub / Sessions filtering, and two-way move, close, and reopen sync. See
  [setup and security details](./docs/github-issues-kanban.md).
- **AI commit messages & terminal names** — bring-your-own local agent CLI run read-only
  on the staged diff or captured output.
- **Your sessions, in your pocket** — **nodeterm mobile** (iOS) attaches to the same live
  tmux sessions: watch an agent work, answer a "needs you", or type into any terminal
  from your phone — plus push notifications and a mobile board view.
- **Power & sleep** — while an agent is working, nodeterm keeps the machine from
  idle-sleeping, and lets go the moment it finishes (on by default; toggle in the setup
  tour or Settings → Behavior). No app can hold a machine awake through a closed lid —
  for overnight runs keep the laptop open and plugged in, or run the agents on a box
  that doesn't sleep via the [Server Edition](./docs/SERVER.md).
- **Command palette** (⌘K), **file explorer** (⌘⇧E), **markdown view** (⌘M),
  **undo/redo**, and a native macOS dark UI.
- **Auto-update & in-app announcements** — the app checks a self-hosted feed and
  surfaces a "Restart to update" banner and product news.

### 🌍 Server Edition — nodeterm in your browser

The same canvas runs headless on a Linux (or macOS) host and is used from any browser —
so your terminals, editors, source control, board, and agents live on a server you reach
from anywhere. Single-user auth (password + secure cookie), a WebSocket bridge, and the
exact same renderer as the desktop app.

```bash
npm run server:dev     # build + serve; open http://127.0.0.1:8443 and set a password
```

Terminals, files/editor/diff, the full git panel, the kanban board, and agent-status
badges all work in the browser today. See [`docs/SERVER.md`](./docs/SERVER.md) for the
quickstart, security model, and current limitations.

#### 🔔 Get push notifications from any SSH host

The same server also runs **headless** as a background notification host: install it on any
Linux box you SSH into, and your phone gets **RUNNING / NEEDS YOU** push + Live-Activity
coverage for the agents running there — with **zero open ports** (the hook server stays
loopback-only and push goes out over HTTPS under a grant your phone drops over SSH).

```bash
curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/install-server.sh | bash
```

One line installs, builds, and runs it as a systemd service (`NODETERM_HEADLESS=1`); re-run it
to update. See the [headless notification host](./docs/SERVER.md#headless-notification-host)
section for details.

## 📦 Download

Grab the latest build from **[nodeterm.dev](https://nodeterm.dev)** — the download button
detects your platform. Everything is also listed at
[nodeterm.dev/releases](https://nodeterm.dev/releases):

- **macOS** — `.dmg` for Apple Silicon and Intel (auto-updates), or **Homebrew**:

  ```bash
  brew tap nodeterm/tap
  brew trust nodeterm/tap        # Homebrew ≥6 refuses to load an untrusted tap
  brew install --cask nodeterm
  ```

  Both first lines are required. On its own, `brew install --cask nodeterm` only searches
  `homebrew/cask` and reports the cask as not found; without the trust grant, Homebrew ≥6
  fails rather than prompting. The cask tracks each promoted release, and the app updates
  itself (electron-updater), so `brew upgrade` is rarely needed for it.
- **Linux (x64)** — self-updating **AppImage**, or a `.deb` for Debian/Ubuntu
  (`sudo apt install ./nodeterm-*.deb`; updates are manual for `.deb`).
- **Windows (x64) — beta** — `nodeterm-Setup-<version>.exe` (per-user installer) or a
  portable `-win.zip`. Early support, so know what you are getting: the installer is
  **unsigned** (SmartScreen will ask — *More info → Run anyway*), **updates are manual**
  for now (grab the next build from the same page), and **session continuity across
  restarts is still landing** — Windows has no tmux, so the standalone session host that
  replaces it is being packaged in [#579](https://github.com/eneskirca/nodeterm/pull/579).
  Everything else — canvas, agents, kanban, hooks — is the same app. Please
  [report what breaks](https://github.com/eneskirca/nodeterm/issues).
- **iOS** — **nodeterm mobile** on the
  [App Store](https://apps.apple.com/app/nodeterm/id6790581233).

**Trying it out?** Removal is one script — it stops every process nodeterm started, reverts
the status-hook/skill entries it merged into your agent CLIs' config (your own hooks and
credentials are never touched), and deletes all of nodeterm's own state. Run it with
`--dry-run` first to see the full list of what it found:

```bash
curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/uninstall.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/uninstall.sh | bash -s -- --yes
```

The full inventory of what nodeterm writes where (and what the script keeps, like the
`.nodeterm/` canvas folders inside your own repos) is documented in
[docs/uninstall.md](docs/uninstall.md).

## 🛠 Build from source

Requires Node.js 20+ on macOS or Linux (tmux recommended — it's what makes sessions
survive restarts). A source checkout does **not** carry the bundled tmux: run
`node scripts/build-tmux.mjs` once on macOS to build it into `resources/bin/tmux` (the
release job does this automatically), or just install tmux yourself. On **Windows**, run
`bootstrap-windows.bat` from a fresh checkout first — it checks for Node, the Visual Studio
C++ build tools and Python 3 (needed to compile node-pty) and points you at the exact
`winget` commands for anything missing, then runs `npm ci`.

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build
npm run typecheck  # fastest correctness gate
npm test           # vitest unit + integration suite
npm run dist       # local UNSIGNED .dmg into dist/ (smoke test)
npm run dist:linux # AppImage + .deb into dist/ (on a Linux host)
npm run dist:win   # unsigned NSIS installer + zip into dist/ (on a Windows host)
npm run server:dev # build + run the browser Server Edition (needs Node 22 + tmux)
```

## ⌨️ Keyboard shortcuts

These are the defaults — every one of them is remappable in **Settings → Keyboard Shortcuts**.

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘T` / `⌘⇧C` | New terminal / New Claude Code |
| `⌘⇧B` | Toggle the kanban board |
| `⌘W` | Close the selected node |
| `⌘←` `⌘→` `⌘↑` `⌘↓` | Focus the node left / right / above / below (`Ctrl+Shift+arrow` off macOS) |
| `⌘Z` / `⌘⇧Z` | Undo / Redo |
| `⌘M` | Toggle markdown view (terminal / editor) |
| Hold `⌘⌥` (`Ctrl+Alt`) | Dictate into the focused terminal |
| `⌘⇧E` | File explorer |
| `⌘,` | Settings · `⌘/` Shortcuts |
| `Right-click` | Actions menu (empty space or node) |

## 🏗 Architecture

- **Electron, three contexts** — `src/main` (the Electron shell), `src/preload` (the only
  bridge, `window.nodeTerminal`), `src/renderer` (React UI). `src/shared` holds the types
  and IPC channel names used by all three.
- **`CorePlatform` seam** — every service (PTY, workspace/settings, git, agents, hooks) lives
  in `src/core` behind a small platform interface and never imports `electron`. Electron is
  one implementation of that seam; the browser Server Edition (`src/server`) is another,
  booting the exact same services over a WebSocket-RPC bridge (`src/renderer/bridge` fills
  `window.nodeTerminal` in the browser). One codebase, one renderer, multiple shells.
- **`TerminalTransport` abstraction** — the renderer depends only on this interface, never on
  IPC or node-pty directly. `LocalTransport` talks to the local host; `RemoteTransport` talks
  to a remote agent over SSH — so remote projects drop in without touching the canvas UI.
- **React Flow is the single source of truth** for live nodes; projects persist serialized
  nodes to disk, and tmux keeps sessions alive across restarts.
- **Three surfaces** — the desktop app, the browser **Server Edition**, and the
  **mobile companion** (a separate SwiftUI repo) all ride the same core + transport seams.

See [`docs/SERVER.md`](./docs/SERVER.md) for the Server Edition, and the design docs
under [`docs/`](./docs) for deeper notes.

## 🤝 Contributing

Issues and pull requests are welcome. **Start with [CONTRIBUTING.md](./CONTRIBUTING.md)** —
setup, the process-boundary rules, and the house rules that come up in review.
[CLAUDE.md](./CLAUDE.md) is the deep reference behind them (and is loaded automatically if
you work with an AI coding agent). Questions or bug reports are also happy at
[nodeterm.dev/support](https://nodeterm.dev/support) / support@nodeterm.dev. nodeterm is licensed under the
[Business Source License 1.1](https://mariadb.com/bsl11/) — you can use, modify,
and redistribute it freely, including in production, except offering it as a
competing product or service (see [License](#-license)).

By submitting a contribution (pull request, patch, or code snippet), you agree
that it is licensed under the same [BUSL-1.1](./LICENSE) terms as the rest of
the project, and that the project may continue to relicense future versions
(including your contribution) as part of its normal licensing model.

## 📜 License

**[BUSL-1.1](./LICENSE)** ([Business Source License](https://mariadb.com/bsl11/)): you may
copy, modify, redistribute, and — under the Additional Use Grant — make **production
use** of nodeterm; the one thing you may not do is offer it (hosted, embedded, or as a
standalone product/service) in a way that **competes** with nodeterm or with the
Licensor's products built on it. Each release automatically becomes plain **MIT** four
years after it is published. See [`LICENSE`](./LICENSE) for the full terms and
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for the bundled open-source
components. For a commercial license beyond the grant, contact eneskirca@gmail.com.

> "Claude" and "Claude Code" are trademarks of Anthropic, and "Trello" is a trademark of
> Atlassian; nodeterm is not affiliated with or endorsed by either.

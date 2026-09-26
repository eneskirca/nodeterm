---
paths:
  - "src/core/pty-*.ts"
  - "src/core/tmux-*.ts"
  - "src/core/scrollback-store.ts"
  - "src/core/terminal-reports.ts"
  - "src/core/settled-text.ts"
  - "src/core/pending-remote-kills.ts"
  - "src/core/remote-end.ts"
  - "src/core/remote-ssh/**"
  - "src/main/remote-ssh/ssh-project.ts"
  - "src/shared/ssh.ts"
  - "src/shared/webgl.ts"
  - "src/session-host/**"
  - "src/renderer/terminal/**"
  - "src/renderer/nodes/TerminalNode.tsx"
  - "src/renderer/lib/hibernationCandidates.ts"
  - "src/renderer/lib/loopCard.ts"
  - "src/renderer/lib/sshRemoteWait.ts"
  - "scripts/build-tmux.mjs"
  - "scripts/patch-node-pty.mjs"
  - "docs/windows-session-host.md"
  - "docs/team-presence.md"
---

## Terminal session continuity (tmux)

`src/core/pty-manager.ts` runs each terminal inside a persistent tmux session
(`tmux new-session -A -D -s nt-<nodeId>`) on a dedicated socket (`-L node-terminal`) with
a generated config (`-f <userData>/tmux.conf`, so the user's `~/.tmux.conf` never
interferes; status bar off, **mouse on**, 50k history, `set-clipboard on` + `terminal-features
",*:clipboard"`, and the copy-mode mouse bindings). Because the tmux *server* outlives the app,
sessions survive when no client is attached. `src/shared/ssh.ts`'s `remoteTmuxConf` is the same
config for an SSH project's remote tmux.

**Every REMOTE tmux invocation starts with `remoteTmuxPathPrologue()`** (`shared/ssh.ts` — PATH
**append**: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `$HOME/.local/bin`): an ssh
exec channel gets a non-login shell, and on a macOS host Homebrew's `shellenv` lives in
`~/.zprofile`, so a host whose own terminal runs tmux fine answered
`zsh:1: command not found: tmux` to every command of ours (issue #449 — the same class as the
remote claude probe's login-shell + PATH fix). Append, never prepend: a PATH that already resolves
tmux keeps exactly that binary, so nothing re-pairs a long-lived tmux server with a different
client build. When tmux is genuinely absent the interactive spawn (`tmuxOrExplain`,
`control-master.ts`) prints what is missing, how to install it and what a tmux-less remote loses,
then degrades to a plain login shell — mirroring the local plain-shell fallback; the raw
`command not found` line must never be the user-facing error again.

**tmux owns the mouse — scrolling, selection, and the alternate screen are all its job.** This is
the native behavior, and it is deliberate:
- **The wheel scrolls tmux's own history** (`history-limit`), not the emulator's buffer.
- **The pane is on the alternate screen** (`\e[?1049h`) — capabilities are NOT blanked — which is
  what keeps a full-screen TUI's input box *put* instead of scrolling away with the text.
- **Selection is tmux copy-mode.** A drag copies; apps that request mouse tracking themselves
  (vim, htop) still get their own mouse events — tmux forwards those regardless.

**Do not take scrolling away from tmux again.** A previous design did exactly that (`mouse off` +
`terminal-overrides ',*:smcup@:rmcup@:indn@'` to keep tmux on the *normal* screen, so its output
flowed into xterm's scrollback, which was then hydrated from `tmux capture-pane` on reattach). It
failed structurally: **tmux is a screen PAINTER, not a stream.** Every redraw (attach, resize,
refresh) erases and repaints, so blank and duplicated rows leaked into the emulator's scrollback —
users saw black bands and duplicated screens when scrolling up — and the pane stopped behaving
natively. The hydration that design needed is gone (see the reattach seeding below).

**Copy → the system clipboard, via OSC 52.** `set-clipboard on` **plus** `set -as terminal-features
",*:clipboard"`: on copy, tmux emits OSC 52 to the attached client, and the renderer's OSC 52
handler (`parseOsc52` in `terminal/osc52.ts`, applied in `TerminalNode.tsx`) writes the system
clipboard. Two traps, both measured on
tmux 3.4:
- **The `terminal-overrides ',xterm*:Ms=…'` entry does NOT work on tmux 3.2+** — with it, a copy
  emitted **zero** OSC 52 to the client. `terminal-features` is what actually enables the sequence.
  Do not "fix" the `Ms=` override back; it is why copying from SSH sessions never worked.
- **No `pbcopy` pipe.** The copy-mode bindings are bare `copy-pipe-and-cancel` (no command): piping
  to `pbcopy` was macOS-only, and over SSH it would have copied on the *remote* host anyway. OSC 52
  is cross-platform and works over SSH.

**A tmux client is not necessarily a watcher.** `SessionInfo.clients` is a COUNT
(`#{session_attached}`), never a boolean, because one session can hold several: the app's painter,
the user's own `tmux -L node-terminal attach`, a second nodeterm on the same socket, and our own
**control-mode shadows** (`PtyManager.shadowAttach`, used for background writes without spawning a
painter). The session reaper subtracts ours via the `shadowed` seam — a shadow is a real client but
not a watcher, so a shadowed session must stay exactly as cullable as an idle detached one.

The count is carried numerically rather than collapsed at parse time **because the subtraction
needs it**: a session holding our shadow AND a real client must still read as attached, and a
boolean could only be forced to false — reaping the session out from under whoever that other
client belongs to. **Any future reader of `list-clients` / `session_attached` owes the same
subtraction.**

Lifecycle, by intent:
- **Offscreen release (in place, 2026-08-11)** → a mounted node fully offscreen past
  `settings.offscreenTerminalMinutes` detaches its PTY client and disposes its xterm without
  unmounting (plate shown; tmux keeps running; reattach-redraw on approach, measured <500 ms).
  See **Terminal node lifecycle** in `.claude/rules/terminal-node.md` for the two invariants (mount-stable observer;
  `session.source` remote gate). Note the released node is a DETACHED tmux session — it joins
  the session reaper's candidate pool (6 h grace still protects it).
- **Every memory lever must ask whether the kill ends live work** (`terminal/live-work.ts`). The
  renderer reclaims terminal memory in FOUR places — park window expiry, the park's LRU cap, the
  memory-pressure drop (all three in `park-budget.ts`) and the offscreen viewer release
  (`offscreen-policy.ts`) — and all four were written as if dropping a PTY client were free,
  because "the tmux session keeps running and re-attach redraws". **That sentence is only true
  where tmux is actually underneath.** On the plain-shell fallback (no tmux installed, tmux
  switched off in settings, or an install path `findTmux` missed) the pty IS the shell, so the
  identical call kills it and everything under it — an agent CLI mid-turn included. Issue #126: a
  project switch terminated a working Claude agent, which then auto-resumed from wherever the kill
  landed. The predicate is deliberately the narrowest one that closes it — a tmux-backed session is
  never protected (the kill costs a redraw), and neither is a plain terminal. **An IDLE agent CLI on
  a non-persistent pty IS protected** (`agentProcess`, `agentProcessInPane`; not once hibernated,
  paused, dropped, or once its CLI announced a SessionEnd, `sessionEnded`, which is its own
  transient flag because `state: undefined` alone is also what an idle agent looks like): killing it looked free because cold restore `--resume`s it on revive, but the
  resumed CLI fires `SessionStart:resume` and idles with no further hook event, the status mirror
  leaves it unverified, and agent messaging refused it for as long as it stayed idle — measured
  2026-09-13 on Windows native ptys. The mirror now also lets a verified `idle_prompt` right after a
  verified `SessionStart` commit a verified non-inferred `done` (`MirrorEntry.sessionStarted`), and
  the decider reports a proven node reset by a boundary as `targetNotIdleUnknown`, not
  `targetStatusStale`. **A fifth lever owes the same gate.**
  The fifth is the offscreen release of an ARMED node (`shouldDeferReleaseForHeldLaunch`):
  held launches now require the attached transport for echo verification, on every backend.
  Keep that transport until delivery or recovery; a blind paste by session name loses the
  shell-init repair and canonical-line protections.
- **Node unmount (project switch)** → the RENDERER **parks** the terminal (`TerminalNode.tsx`
  `parkedTerminals`): the xterm instance + its attached PTY stay alive with the `.xterm` element
  detached from the DOM, so a remount within the park window re-adopts them — instant, and
  exact (the tmux client never detaches, so mouse-tracking/alternate-screen modes and scrollback
  carry over; do NOT "optimize" this into a respawn+redraw — a fresh xterm on a reused client
  misses the attach-time mode sequences and breaks scrolling). The park timer then runs the real
  teardown: `kill()` detaches the PTY client; the tmux session keeps running. **Window and cap
  are settings (issue #886)**: `settings.terminalParkMinutes` (default **10**, raised from 5; **0 = until app quit** —
  `parkWindowMs` returns `null` and NO timer is armed, never `Infinity`, which `setTimeout` clamps
  to ~1 ms and would dispose every park at once) and `settings.terminalParkMax` (default **20**, raised from 12), both
  re-validated at park time. The LRU cap evicts **local parks before remote ones**
  (`planParkEviction`'s `isRemote`): a local re-adopt miss is a warm reattach in ms, an SSH one is
  a new client per terminal paced 4-per-master, plus a login if the master idled out
  (`ControlPersist`) — and a live parked client is also what keeps that master from idling out.
  Parking does not raise sshd `MaxSessions` pressure: masters are per project, so a parked SSH
  project holds exactly the channels it held while in view. Measured (headless xterm, 200×50): a
  parked tmux-backed terminal ≈ **2 MB** (alternate screen, empty normal buffer — tmux owns the
  history); a plain shell with a full 10k scrollback ≈ **27 MB**. WebGL contexts are
  **viewport-scoped and budgeted** (browsers cap ~16 live contexts, and a canvas holds far more
  terminals). A per-terminal `IntersectionObserver` (`rootMargin` pre-announces approach) only
  REPORTS visibility to a **module-level budget coordinator** (`terminal/webgl-budget.ts`) that owns
  every grant decision and all timing: it keeps the contexts WE hold at/under the live budget
  (`WEBGL_BUDGET` 12 default — the browser Server Edition; on DESKTOP main raises Chromium's cap
  itself via `--max-active-webgl-contexts` = 32 and boot raises the budget to 24 via
  `setWebglBudget`, constants in `src/shared/webgl.ts`) so
  the browser never has to **force-evict** — which is the bug that flashed Chromium's dead
  "lost context" placeholder (white box + sad-face) on a visible terminal during a fast pan / zoom
  out, because the old per-node observers each acquired independently and momentarily overshot the
  cap. Rules: a client granted only after an **acquire debounce** (`WEBGL_ACQUIRE_DEBOUNCE_MS`, so a
  pan-through never grabs a context for a two-frame flash); if granting would exceed the budget,
  **reclaim on demand from the least-recently-visible HIDDEN holder** (`hiddenAt` LRU order);
  if every holder is currently visible (zoomed way out), the newcomer is NOT granted and **stays on
  the DOM renderer** — we never push past the budget. A hidden holder keeps its context
  **indefinitely** (warm for a pan-back of any length) — there is no time-based release; it is
  reclaimed strictly on demand, either by a visible newcomer that needs its slot or by
  `releaseAllHiddenGrants` (queued through the drain) under memory pressure. `acquire()`
  returning false (WebGL2 unavailable) doesn't burn a slot; an externally-lost context
  (`onContextLoss`) is reported via `handle.contextLost()`, drops from the accounting, and — for a
  still-VISIBLE client — schedules ONE delayed budget-gated re-grant (sleep/wake GPU resets lose
  every context at once with no visibility change; without this every woken terminal sat on the
  DOM renderer until panned out and back). The NODE still never re-acquires itself (that loop is
  the eviction fight the design fears): the retry goes through `tryGrant` — never exceeds the
  budget, never reclaims a visible holder — and stops after `WEBGL_LOSS_STREAK_MAX` consecutive
  losses (visibility transition resets). The node registers via `registerWebglClient` on mount
  and `handle.dispose()`s on unmount (which releases + cancels timers). A parked terminal is
  off-screen so it holds no context. Permanent-delete paths call `disposeTerminalOnUnmount(id)` so a
  deleted node disposes instead of parking.
  **A renderer released while the node is unmeasurable mismeasures its own row spacing**
  (`terminal/dom-renderer-spacing.ts`): `WebglAddon.dispose()` is also the back-to-DOM-renderer
  path, and it runs from the lifecycle effect's CLEANUP — after React detached the element — so the
  fresh DOM renderer derives `letter-spacing` from a width cache whose `offsetWidth` is **0** and
  bakes in a whole extra cell per character. That is the "letters drift apart for a split second
  after a project switch": the adopting mount paints wide until the WebGL grant lands 150 ms later.
  Focus mode's `display:none` wrapper is the same shape. xterm re-derives the spacing on a char-size
  / dpr / options change and **not on a resize**, so nothing in the reattach path heals it —
  `applyFit` calls the change-gated `resyncDomRendererSpacing(term)`, which bails while the
  measurement is still 0 rather than re-baking the wrong number.
  **Which renderer a terminal uses** is `settings.terminalGpuRendering`, resolved by the single
  resolver `resolveTerminalRenderer(value)` (`src/shared/webgl.ts`) to `dom | webgl | shared`:
  `'off'` = xterm's DOM renderer, `'on'` = one budgeted WebGL context per terminal (everything the
  paragraph above describes), `'shared'` = **glyphgrid**, ONE canvas-wide WebGL2 context every
  terminal paints into (`src/renderer/glyphgrid/`, reached through `terminal/glyphgrid-attach.ts`;
  the per-terminal budget is OFF in this mode). `'auto'` (the default, and what legacy/unknown values
  fall back to) = **`webgl` on EVERY platform**, macOS included. The macOS branch has moved twice:
  it was `dom`, then `shared` on 2026-08-05 (per-terminal WebGL composited terminals black after
  zoom-out bursts, blamed on the OS compositor), and is now `webgl` — the blackout was root-caused
  not to context count but to a dependency skew (addon-webgl 0.19's dispose crashed on the 5.5 core
  and aborted its own DOM-renderer restore; pinned + healed, see
  `renderer/terminal/webgl-addon-pair.test.ts`). What actually guards macOS is a lower budget,
  `WEBGL_BUDGET_DESKTOP_MAC` (16, vs 24 elsewhere), capping compositor pressure at every zoom. The
  four-way setting stays as the escape hatch: `'shared'` is now opt-in only (also where the macOS
  default points back if the one unconfirmed 2026-07-30 whole-window-flicker report recurs), and
  `'off'` drops GPU rendering entirely.
- **Window close / app quit** → clients detach (`PtyManager.killAll()`); the tmux session keeps
  running. `killAll()` deliberately does NOT kill sessions.
- **Node reopen / app relaunch** (nothing parked) → a new PTY attaches to the same
  `nt-<nodeId>` session and tmux redraws current state.
- **User clicks ×** → `destroy(persistKey)` runs `tmux kill-session`, permanently ending it. For a
  REMOTE node it kills the remote session **and then the local one of the same name** — normally a
  no-op, but it reaps the orphan the pre-`requireRemote` local fallback below could leave behind.
  **Whether a node IS remote is answered WITHOUT a live session** (`core/remote-end.ts`,
  `planRemoteEnd`). `runEndSession` used to read it off the dying `Session` alone
  (`dying?.sshRemote`), and its comment claimed "both callers run while the session is still live"
  — which is false for the case that matters: a delete arrives precisely when there may be nothing
  attached (an app restart, the offscreen release, the 5-min park expiry, a project that is not
  even open). `dying` was then `undefined`, remoteness read as "local", the remote branch was
  skipped **in silence**, and the one kill that went out went to the LOCAL socket, where a
  `requireRemote` node has nothing at all. Everything else about the teardown ran, so the node left
  the canvas looking deleted while its `nt-<id>` kept running on the host — a leak with no surface
  anywhere. The durable answer is the machine-local index: the shell wires
  `PtyManager.setRemoteNodeOwner` to `workspaceStore.sshProjectIdForNode` + that project's
  ControlMaster (`refForProject`). A LIVE `sshRemote` still wins when there is one — it is the exact
  master the session was spawned over, and a node created seconds ago may not be in the index cache
  yet — so the two sources are complementary, not redundant. The Server Edition wires no resolver
  (it has no SSH-project manager) and its deletes stay on the local path unchanged.
  **And the kill is CHECKED.** The old `catch {}` read "remote session may not exist / master down;
  ignore", which are not the same fact: tmux's own exit 1 ("can't find session", `probeSaysAbsent`)
  is an ANSWER, while ssh's 255 / a 127 / a spawn error is a NON-answer with the session still
  running. A non-answer — and a node whose project has no master at all — is **recorded**
  (`core/pending-remote-kills.ts`, atomic JSON under userData, keyed by `user@host` because several
  projects share one host's tmux server) and settled the next time that host connects
  (`SshProjectManager.settleOwedKills`, hung on the shared connect attempt so the REUSE branch pays
  too; an entry is dropped only on tmux exit 0 or 1). The delete itself is **never refused** over an
  unreachable host: the node is going, and a refusal strands it on the canvas with the same session
  still running plus a dialog — the user answers that by deleting it again. That trade is only
  defensible BECAUSE the debt is durable; drop the store and refusing becomes the honest option.
  **Only a `delete` may owe a debt.** A `recycle` keeps the node (worktree move, model switch,
  "pause & end session"), so a kill deferred to a later reconnect would land on the session that
  node has since RESPAWNED under the same name — ending live work hours after the action that
  queued it, with nothing on screen connecting the two. A recycle still ATTEMPTS the remote kill;
  it just records nothing when it cannot land, exactly as before.
- **A remote node is NEVER spawned locally** (`PtyCreateOptions.requireRemote`). `sshRemote` says
  "here is the master to run over"; `requireRemote` says "and if there isn't one, spawn NOTHING".
  Without it, a create with no `sshRemote` falls through to core's local tmux/plain-shell branches
  — which is how an SSH project's terminal opened while the ControlMaster was down (no network,
  host unreachable, `ssh` missing) quietly became a LOCAL shell in the local `$HOME`: same node id,
  same `SSH user@host` header chip, the REMOTE session's scrollback snapshot replayed into it, and
  — for an agent node — a cold-restore `claude --resume <remote session id>` running on the wrong
  machine under the local account, leaving an orphaned local `nt-<id>` behind. Refused on both
  sides: the renderer never calls `create` when `resolveSshRemote` came back empty
  (`CoState.offline` + the node's Reconnect button), and core refuses in `spawnNew`
  (`PtyCreateResult.unavailable`) so a master that dies inside the round-trip can't sneak through.
  The refusal is **only** in `spawnNew` — a co-attach JOIN to a live session for that node id is
  still correct. An offline node reports itself to `SshReconnector`, so the canvas heals itself;
  `retryNow` (banner Reconnect / node Reconnect) skips the backoff and clears the refuse window.
- **A shared Codex daemon restart is NOT a terminal-session restart.** tmux survives, and the Codex
  rollout/thread survives, but every `codex --remote unix://` TUI attached to that account's one
  app-server socket exits together. `buildCodexLauncherScript` therefore stays in the pane as a
  bounded transport supervisor after binding a thread instead of `exec`ing the remote TUI. On an
  abnormal client exit it resumes that exact thread only when `app-server daemon version` no longer
  reports `status: running` or the known control-socket inode changed; the same healthy generation
  returns the original status so a deterministic CLI error cannot relaunch forever. A reconnect
  never replays the launch prompt/options (that would duplicate the user's turn), and three rapid
  resets stop with a manual `codex resume <thread>` receipt. Preflight probes live protocol health
  before lifecycle start: Codex's PID ownership record can go stale while the shared process remains
  responsive, and killing that "orphan" would fan one bookkeeping failure out across every node.
  The generated-shell tests run the replaced-socket, missing-daemon, healthy-client-error, and
  responsive-orphan cases under real `/bin/sh`; the healthy-error case is the mutation guard.
  **Both shells wire this spine.** Electron and Server Edition arm the same signed record secret,
  thread start/bind handlers, capability refresh, and UI identity events; the server composition is
  isolated in `server/codex-shared-identity.ts` and behavior-tested. The old Server Edition
  "deliberate plain Codex" answer bypassed the launcher entirely, so a reconnect implementation in
  the launcher could be perfectly green while every headless pane still fell back to its shell.
  **No approval override ever rides that remote resume** (issue #811). MEASURED on
  `codex-cli 0.154.0` against a real thread on a running shared app-server, under a pty:
  `codex --remote unix:// resume <thread> --ask-for-approval on-request` answers
  `Error: Permission overrides are not supported when resuming a remote task.` and exits 1 —
  `on-request` being that build's own default policy and a member of its enum, so this is **not**
  the missing `untrusted` of #785. The same command with the flag removed resumes and the TUI stays
  up, and `-c approval_policy=never` is refused identically: the rule is about the OVERRIDE, not
  about a value or a spelling, so there is no mapping of `manual`/`auto`/`bypassPermissions` that
  survives this path and nothing to decide. Since `withPermissionMode` appends the flag to every
  agent launch, every shared-identity Codex node died on its first turn at a bare shell.
  `nt_run_shared` therefore strips `--ask-for-approval`/`-a` (both the spaced and the `=` form)
  from the first-launch argv. **The strip is in the LAUNCHER, not in the TypeScript that builds the
  line, and that placement is the invariant**: every identity-setup failure above it ends in
  `exec codex "$@"` — plain codex, no `--remote` — where 0.154 still accepts the flag, so
  suppressing it one layer up would take the permission mode away from exactly the nodes that could
  not get a managed identity. The `else` branch has always resumed with no caller options at all,
  so this only makes the first launch agree with the recovery beside it; the cost on an older codex
  that still accepts the flag on a resume is that the mode is not applied on the managed path, which
  after the first daemon reset was already true. **There is deliberately no capability gate**: the
  refusal is a runtime check, absent from `--help`, so `codexCliSupportsRemote`'s shape does not
  transfer — and it fires AFTER the session lookup, so a throwaway thread id answers "no saved
  session" with or without the flag. Probing costs a real resumable thread, which is the thing being
  launched.
- **"Restart agent (resume)"** → deliberately NOT a session lifecycle event: `terminal/
  agent-restart.ts` restarts the agent CLI *inside* the pane and leaves the PTY, the tmux session
  and its scrollback untouched. It exists for **new-model pickup** — a freshly released model only
  shows up in a CLI's model list on a fresh launch, and doing that by hand means closing and
  re-resuming every agent node on the canvas. Choreography: write the CLI's own exit line (`/exit`
  for claude, `/quit` for codex — that table is also the gate, an agent not in it can never be
  restarted in place), poll `pty:pane-command` (`#{pane_current_command}`, local tmux socket or the
  project's SSH ControlMaster; any failure reads as "not a shell yet") every `RESTART_POLL_MS`
  (250 ms) until a SHELL owns the pane, then echo-deliver `resumeCommand(...)` — the same
  `claude --resume` / `codex resume` the cold restore uses. **Nothing is ever killed**: if the CLI
  has not quit within `RESTART_EXIT_TIMEOUT_MS` (6 s) the run reports `exit-timeout` and leaves the
  session running. **A user-asked restart gets a late window on top** (`RESTART_LATE_EXIT_MS`, 60 s,
  spent only while the pane still reads): issue #899 was a 19 h cron session whose CLI quit a moment
  AFTER the 6 s, with nothing left watching — the node sat at a bare shell with no agent and no
  resume. The Eco sweep and Pause keep the bare 6 s (the sweep is serialized canvas-wide). The
  exit-timeout notice (`exitTimeoutNotice`) hands over the bare resume line for exactly that
  late-quit case. A `working` **or `blocked`** session is refused — `/exit` typed into a
  permission prompt would ANSWER it, not quit — and a node is held one-restart-at-a-time until the
  resume line has actually LEFT the pane (an un-submitted line is where a second `/exit` would be
  spliced in). The bulk action runs the same per-node closure sequentially over every idle agent
  node in canvas order and reports one summary line. `performRestartResume` is now a COMPOSITION of
  `performExitPhase` + `performResumePhase` (2026-08-12, behavior-pinned split) — hibernation
  drives the halves separately; each half refuses independently.
- **Agent hibernation ("Eco", 2026-08-12, OPT-IN default off)** → `settings.agentHibernationEnabled`
  (+ `agentHibernationIdleMinutes`, default 30; Settings → Agents): a 60 s renderer sweep
  (`Canvas`) exits the CLI of up to **2** agent nodes per pass that are hook-idle in state `done`,
  fully offscreen (`isNodeWatched` — an open kanban card modal counts as watched), local, idle ≥
  window, non-recurring, without live subagents (`planHibernation` +
  `lib/hibernationCandidates.ts`, both pure/tested). tmux + shell survive; node shows a clickable
  SLEEPING chip; wake (view / chip / modal open) verifies a SHELL owns the pane
  (`isShellCommand` OR the persisted `hibernatedPane` the exit settled on — nu/pwsh users) before
  the KILL_LINE'd, echo-verified `withPermissionMode(resumeCommand(...))`. Sweep/wake/menu-restart
  share ONE `guardConcurrentRestart` set. Load-bearing rules a refactor must not undo:
  (1) **recurring fact is durable** — both loop-card dismiss surfaces route through
  `lib/loopCard.ts`, which HIDES a cron/schedule card but retains `agentStatus.loop`
  (`dismissed: true`); clearing it would let Eco `/exit` a CLI whose cron wakeup lives in that
  process. (2) **Fire-time re-asks**: still-offscreen, remote, eligibility — a plan-time verdict
  is stale by seconds. (3) `hibernated` **self-heals** on live hook states + SessionStart (never
  on `done` — a late Stop POST must not undo a just-performed hibernate); cold restore (`fresh`)
  clears `hibernated` UNCONDITIONALLY and normally lets auto-resume own the node — **`paused` (see
  below) is what makes that auto-resume itself conditional**, the one deliberate exception: the
  flag it gates is still cleared, only the relaunch is skipped. (4) **Ordering with offscreen
  release**:
  Eco defers the Phase-2 viewer release until the node hibernates (hard cap idle+offscreen), but
  ONLY when the idle clock is known (`idleKnown` — `lastEventAt` is transient, so after an app
  restart nothing can hibernate and deferring would make Eco a memory regression). Eco is
  structurally inert for sessions with no turn in the current app run — documented follow-up.
  The deferral is also unaware of `paused`: a deep-paused node's freshly recycled shell keeps its
  xterm alive until the hard cap, waiting for a hibernation that (being already exited, or having
  no CLI to exit) can never come — a second documented follow-up.
  Device checklist (8 items) in PR #130 — owed before recommending Eco to anyone.
- **"Pause session"** (manual, or via Eco when `settings.agentHibernationPersistAcrossRestart` is
  on) → `agentStatus.paused`, a persisted flag alongside `hibernated` with ONE job: stop a node
  from coming back on its own. Two depths, chosen per node: shallow — identical to an Eco exit
  (`registerAgentPause`'s `pause` closure reuses `performExitPhase`), plus `paused` — or "pause &
  end session" — the same recycle `restartAgentNode(…, restartShell: true)` uses
  (`transport.recycle` + a `respawnNonce` bump), so the node comes back `fresh` next time, with no
  live tmux session to hold memory. Two pure predicates in `terminal/hibernation-policy.ts` pin the
  contract: `shouldColdResume` (a `fresh` mount must not auto-relaunch a paused node — see Cold
  restore above) and `shouldAutoWake` (the mount-timer, visibility-edge, and kanban-card-modal-open
  auto-wake triggers must not fire for a paused node, hibernated or not — only an explicit Resume,
  which reuses the SAME `wakeHibernatedNode` trigger the SLEEPING/PAUSED chip's click uses, so it
  gets the same `WakeInputBuffer` splice protection and retry budget). Pausing an already-hibernated
  node skips the exit phase entirely (`alreadyExited` in the closure) — asking an idle CLI-less
  shell to quit would type `/exit` into it as a real command. `paused` is ALSO excluded from Eco's
  own candidate plan and its exit closure's fire-time re-ask (`HibernationCandidate.paused`,
  `hibernationCandidates.ts`) — a deep-paused node has `hibernated` unset (its tmux was recycled,
  not exited), so `!hibernated` alone would still admit it to a sweep whose dropped SessionEnd hook
  POST left a stale `done` behind: the same `/exit`-into-a-bare-shell mistake `alreadyExited` closes
  on the manual path, closed here on the automatic one. Node menu only today (canvas right-click +
  the sessions sidebar row menu, which shares the same `selectionItems` builder, plus a read-only
  kanban card badge and a clickable one in the card modal); no command palette entry.

The node id is the `persistKey` (passed to `transport.create`), so it must stay stable.
`findTmux()` resolves an absolute path because GUI apps don't inherit the
shell PATH, and it tries three sources **in this order: fixed system paths → the shell's
PATH → the tmux the macOS app SHIPS** (`bundledTmuxPath`). System first is deliberate — a
machine that already has tmux keeps using its own, so the bundled copy is a floor, never an
override. `resourcesPath` is `undefined` on the **Server Edition**, so the bundled binary is
unreachable there by construction; a Linux host is expected to have its own. Under
`electron-vite dev` the last candidate resolves against `process.cwd()`, which is where
`scripts/build-tmux.mjs` writes its artifact. If tmux is unavailable from all three,
`PtyManager` falls back to a plain shell (no cross-restart continuity); `TMUX`/`TMUX_PANE` are stripped from the child env to avoid nesting refusal.

**A session-host session follows its most recently ACTIVE viewer, like tmux's `window-size
latest`** (issue #914). Under tmux a relay-mirrored phone is its own tmux client, so dismissing its
keyboard gives it its rows back; on the session host the phone and the desktop node share ONE
client socket, and the old componentwise minimum held the phone to the desktop node's rows with an
empty band and no explanation. `latestClaimSize` (`core/pty-size.ts`) picks the claim with the
highest recency — bumped by an attach, a claim that CHANGES, and a write that is not an emulator's
automatic answer (`core/terminal-reports.ts`; every attached xterm answers a DA/CPR/OSC query, and
counting those would hand the session to whoever answered last). Three rules, each load-bearing:
(1) a viewer that cannot adapt is a CEILING — a pty wider than the phone's screen would wrap into
garbage there (or, rendered at the pty's size, be clipped to its left ~45 columns), so a relay sink is
`bounding` unless `pty.attach` said `resizedFrames: true`. The iOS app deliberately does NOT send it:
it reads `OP.Resized` only to show a "Sized to another screen · Fit this screen" hint, and every
phone report is ANSWERED (the sink's `sinkShown` is forgotten on each report) because the phone
clears that hint whenever it sends a size; (2) the real size flows back to every viewer (`SessionHostPty.onSize` →
`PtyManager.applyBackendSize` → `pty:size`, and `OP.Resized` to the sink), and a session-host
`Session`'s `applySize` only VOTES; (3) the host's `geometry` push is NEGOTIATED at `hello`
(`SESSION_HOST_FEATURES`) and sent only to sockets that asked — an older client reads every
non-`data` push frame as an EXIT. Across app connections the host still takes the minimum. Full
write-up: `docs/windows-session-host.md` → "Output ordering, flow ownership, and geometry".

### Cold restore (machine reboot)

tmux only survives an **app** restart — a **machine reboot kills the tmux server**, so every
`nt-<nodeId>` session is gone. To bridge that, `create()` returns `PtyCreateResult` with a
`fresh` flag: it asks the tmux server whether the session already exists *before* spawning, so
`fresh=false` means a warm reattach (tmux redraws) and `fresh=true` means a cold start (first open
OR post-reboot). Locally that ask is one `tmux has-session` per node; **on an SSH project it is ONE
`tmux list-sessions` per host per burst** (`core/remote-ssh/remote-session-index.ts`), because a
project switch mounts every node in the same tick and N probe channels on top of N pty channels
overrun a stock host's `MaxSessions 10`. The measurement and the failure chain it closes are in
that module's header; the two rules a refactor must not undo are **(1)** only tmux's own exit 1 is
evidence of absence — every other outcome answers "exists", because a transport failure read as
"cold" replays a snapshot and types `claude --resume …` into a LIVE agent pane — and **(2)** a
session this process just spawned is recorded (`markPresent`) and a remote kill invalidates the
cached list, so nothing inside the cache window can be told it is cold when it is not. On a
cold start the renderer (`TerminalNode.tsx`) reconstructs state instead of relying on the dead
session (you can't keep a live OS process across a reboot):
- **Scrollback replay** — `core/scrollback-store.ts` keeps a byte-capped (`256 KB`) snapshot of
  each tmux session's recent output under `<userData>/terminal-scrollback/`, refreshed on a
  timer (`SCROLLBACK_SNAPSHOT_MS`) + on detach/quit (`tmux capture-pane -e`). On a cold start the
  renderer reads it via `pty.readScrollback` and writes it back into xterm (with a "session
  restored" separator). Warm reattach skips it (tmux already redraws). Deleted with the node in
  `destroySession`.
- **Agent resume** — on a cold start of a node whose `agentId` is in `RESUMABLE_AGENTS`, the
  renderer re-launches the agent CLI: `resumeCommand(agentId, sessionId)` (from the session id
  persisted in `agentStatus` localStorage — `claude --resume`, `codex resume`, `gemini
  --resume`) when known, else the bare `launchCmd`. The one-shot `data.initialCommand` still wins
  on the very first open, so the agent is never double-launched. **The one exception: a `paused`
  node** (see "Pause session" below) skips this auto-relaunch — that is the entire point of the
  flag — and instead records the pane its fresh shell settled on (`agentStatus.hibernatedPane`),
  so a later explicit Resume can recognize it even for a default shell outside the wake's
  `isShellCommand` allowlist.
  **A persisted session id is not evidence the conversation still exists**, and a dead one is not a
  no-op: `claude --resume <dead id>` prints *"No conversation found with session ID: <uuid>"* and
  EXITS, leaving the pane at a bare shell under a node still wearing its agent badge. Measured
  2026-09-09 on the reporting host (`nodeterm-rmt`, 108 live sessions): **20** panes sat in exactly
  that state, and not one of those 20 ids had a `<id>.jsonl` anywhere under the system
  `~/.claude/projects` or the managed account root. Claude's own 30-day cleanup, a `/clear`, a
  removed account and an id minted for a session that never ran all produce it. So the cold-restore
  branch now asks `chat.transcriptExists` first (`transcript:exists`, served by
  `registerTranscriptIpc` in BOTH shells) and, on a POSITIVE `absent`, launches the agent **bare**
  and raises a slim `CoState.lostSession` banner on the node — "The previous conversation could not
  be found — this agent started fresh." — instead of opening a blank session in silence. Three
  rules make that safe:
  - **The answer is a TRI-state** (`TranscriptPresence`: `present | absent | unknown`) and only
    `absent` drops the id. The two errors are wildly asymmetric — wrongly resuming a dead id costs
    one line and a bare shell (today's bug), wrongly dropping a LIVE id strands work the user
    believes is continuing — so an unreadable root, a `readdir` that threw, a downed ControlMaster,
    a relay tab, a rejected call and an id we would not put on a command line are ALL `unknown` =
    resume exactly as before. `transcriptPresence` (`core/transcript-reader.ts`) is
    `resolveTranscriptPath` plus that one distinction, not a second way of finding a transcript,
    and a root that does not exist at all still answers `unknown` on purpose: cold restore runs at
    boot, where a not-yet-mounted `$HOME` is indistinguishable from an empty one.
  - **The remote leg's `unknown` is TERMINAL, never a fallthrough.** A remote session's transcript
    is on the host, so searching this machine for it would find nothing and report `absent` about
    the wrong computer. `remoteTranscriptPresence` (`src/main`) exists beside
    `remoteTranscriptRefFor` rather than reusing it because that function collapses "not remote" /
    "no home" / "ssh failed" / "the host looked and there is nothing" into one `undefined` — fine
    for a reader that falls back, fatal for a caller that acts on absence.
    `locateRemoteTranscriptCommand` was already built for this distinction (it exits 0 on a clean
    miss, "so no transcript is an ANSWER, not a failed ssh"), and that is the property this reads;
    it is deliberately more permissive than the local leg (it searches the account root AND the
    system root), which errs toward `present` = keep the resume.
  - **Claude only**, gated by `readsClaudeTranscript` — a codex/gemini/grok id misses this
    resolver by construction every time, so probing one would answer `absent` for a healthy
    session and drop its resume. Those agents keep the pre-existing behaviour until the probe
    learns their layouts (`handoff/locate.ts` has the per-agent locators; that is the seam).
  Decision logic is the pure `terminal/cold-resume-session.ts`. **Adding a `CoState` field owes the
  hand-written equality list in `setCo`** — a patch touching only an uncompared field is SWALLOWED
  and its banner silently never renders (it happened once to `spawnError`);
  `nodes/cold-resume-wiring.test.ts` now asserts every field of the interface appears there.
  Surfaces: Desktop full; Server Edition full (the handler is core, the ws-bridge leg is real, and
  that shell runs on the host whose transcripts it reads, so it needs no remote leg); relay tabs
  answer `unknown` and resume as before. **Not yet on the kanban CARD MODAL** — `ModalTerminal`
  reads no `CoState`, so a user who only ever opens the session from the board does not see the
  notice; the honest fix is a shared node-notice surface rather than a second copy of the banner.

### SSH connect: the ControlMaster is published BEFORE its setup chain

`connectOnce` (`main/remote-ssh/ssh-project.ts`) used to publish a project's ControlMaster only with
`status: 'connected'` — i.e. after the reverse hook tunnel, ~23 serialized per-agent hook installs,
`printf $HOME`, the remote tmux.conf write + `source-file` and the Codex runtime staging had all
run. MEASURED against a real sshd through a 25 ms one-way delay proxy (50 ms RTT): that chain is
**3.54 s** on a fully-provisioned host, while **18 remote terminals attaching in parallel over a
warm master paint in a median of 0.16 s** and are all settled by 0.71 s. So the attach was never the
bottleneck — every terminal of a switched-to project simply sat in `resolveSshRemote`'s 20 s wait
printing `[connecting to user@host…]` into a blank pane, for a transport that was ready the whole
time.

Two additive changes, and the rules that keep them safe:

- **The early signal.** The moment `ssh -O check` answers, `connectOnce` emits
  `SshProjectStatusEvent.masterControlPath` on a `connecting` event. `connected` keeps its exact
  meaning (the whole chain finished) and everything hanging off it — git routing, the remote claude
  probe, the tunnel resync, the connection banner — is untouched. The renderer keeps it in its own
  map (`useSshConn.earlyByProject`), **never in `byProject`**, which a dozen readers treat as "this
  project is connected".
  - **Only a node whose remote tmux session ALREADY EXISTS may act on it**
    (`PtyApi.remoteSessionConfirmed` → `RemoteSessionIndex.verdict`, the strict `present`-only half
    of the coalesced `tmux list-sessions` read `create()` already makes, so a warm switch pays no
    extra round trip). `new-session -A` on a live session merely attaches, and the two things the
    setup chain provides — the remote tmux config (`-f`) and the hook/account environment (tmux
    `-e`) — are read at session CREATION only. A node whose session is ABSENT, **or whose host
    could not be read**, waits for `connected`: creating its session without the hook env costs it
    its agent-status badges silently, with no later event to repair it. That is why the index now
    exposes a TRI-STATE (`present | absent | unknown`) — `exists()` folds `unknown` into "exists"
    for its own caller, and this one needs the opposite fold. Decision logic is the pure
    `renderer/lib/sshRemoteWait.ts`; a cold node's wait is pinned by its own test.
  - **Never for an ADOPTED live-orphan master.** The tunnel-verification failure path may `-O exit`
    that master and rebuild it, which would kill a terminal that had attached over it meanwhile.
    The rebuild clears `reusedOrphan` and re-enters the loop, so a rebuilt master does publish.
- **The boot-time pre-warm** (`core/remote-ssh/ssh-prewarm.ts`, planner + runner pure and tested;
  wired in `main/index.ts`). The master for a project was dialed only when the user first switched
  to it, so the first visit of every app run paid the cold establish (**0.44 s** measured) plus the
  whole chain. `SshProjectManager.prewarm` now dials the masters of OPEN SSH projects shortly after
  boot, **one host at a time** (a burst of fresh masters is what trips a host's `MaxStartups`; the
  `SshChildGate` caps exec children per control path and does nothing about logins).
  - **A pre-warm is SILENT — no status event at all.** The user is by definition not looking (if
    they were, the active-project effect would have connected it loudly), so a failure must not
    raise the connection banner for a project they never opened. The mark is lifted the moment a
    real connect arrives for the same project, including one that coalesces onto the pre-warm's own
    in-flight attempt.
  - **It never prompts for a passphrase either** (`isQuietMasterPid` → main's prompt handler
    declines): a modal in front of a user who opened nothing is the loudest thing an SSH connect can
    do. That master fails auth quietly; the user's own connect spawns a new one and prompts normally.
  - **CLOSED projects are never dialed**, and neither is a project that already has a master or an
    attempt in flight. `closeProject` is non-destructive, so a closed tab is the user saying "not
    now".

### When a freshness verdict was a GUESS: the late cold-start check

The cold-restore section above states the rule that makes the remote freshness read safe: only
tmux's own exit 1 is evidence of absence, and every other outcome answers "exists", because a
transport failure read as "cold" types `claude --resume …` into a LIVE agent pane. That rule is
right and does not change. What it costs, and what this closes, is the other side of the fold.

**THE INCIDENT (measured on the reporting host, 2026-09-15).** The host's `nodeterm-rmt` tmux
server died, so every remote session was gone; ten minutes later a 108-node SSH project was opened
and 107 sessions had to be created in one mount burst. sshd logged **757 `Accepted publickey` full
logins in seven minutes** — on a healthy ControlMaster that number is ~0, because everything
multiplexes over one connection. Under that pressure the freshness read times out, the fold answers
"exists", `tmux new-session -A` CREATES an empty session, `fresh:false` skips cold restore, and the
node sits at a bare shell with the user's conversation stranded on disk:

    15:29 burst,  22 sessions: 18 claude /  4 bash  ->  82% resumed
    15:39 burst, 107 sessions: 41 claude / 66 bash  ->  38% resumed

Load-dependent, i.e. a race. Three changes, and the order matters — the first saves the
conversation, the other two stop the burst that strands it:

- **A second opinion, never a different fold.** `create()` now reports `freshUnverified` when
  `fresh:false` came from an `unknown` verdict rather than a read. The renderer re-asks ONCE, after
  the attach has landed and the burst is over, and tmux settles it authoritatively:
  `#{session_created}` survives a `new-session -A` attach, so a session created within seconds of
  our own attach is one WE made (`PtyApi.sessionAge` → `remoteSessionAgeArgs`, which prints the
  stamp AND the host's `date +%s` on one line so the host's clock skew never enters the number).
  Every rule in `renderer/terminal/cold-self-heal.ts` is a refusal: never for a verdict that was
  READ (that would spend a round trip per warm node on every switch), never for an unknown age,
  never past the window, and never unless a SHELL still owns the pane — the same gate the
  hibernation wake and the resume-miss watcher keep. The scrollback replay is deliberately NOT
  re-run: by then tmux has painted the live pane, and writing a snapshot over it splices two points
  in time (the warm-attach seeding rule). The agent relaunch is what matters and is what runs.
- **The per-node token write is coalesced, not gated** — the brief that prompted this said
  `ensureRemoteNodeToken` bypassed the `SshChildGate`, and that was measurably wrong: main wires
  `RemoteHooks` with the gated runner, so it queues like everything else. The real cost was that it
  is one round trip PER SPAWN for work the connect path already did (`materialiseNodeTokens` writes
  every node's token), competing for a budget of 6 for the whole burst. It now memoizes per
  (control path, node) for the app run — seeded by the connect — and coalesces a burst into ONE
  remote write.
- **Remote pty spawns are paced** (`core/remote-ssh/pty-spawn-gate.ts`, cap 4 per ControlMaster).
  A pty deliberately never went through the `SshChildGate` — "a terminal is never queued for a
  screen the user is looking at" — which is right for a handful of terminals and wrong for a
  canvas. The one thing that makes pacing acceptable is that a slot is held only until the session
  starts painting: released on the pty's FIRST OUTPUT (one round trip for a warm attach) and
  unconditionally after `REMOTE_PTY_SPAWN_SETTLE_MS`, because a gate that can hang is worse than no
  gate. A node that ends up waiting SAYS so (`SLOW_REMOTE_SPAWN_NOTICE_MS`), for the same reason the
  `[connecting…]` line exists. Measured in the lab (real sshd, `MaxSessions 10`, 50 ms RTT, one warm
  master, 107 attaches):

  | | full logins | panes painted | wall |
  |---|---|---|---|
  | ungated | 72 / 77 | 102 and 96 of 107 | 2.1 / 2.3 s |
  | gated at 4 | **1** / **1** | **107 / 107** | 3.2 / 4.0 s |

  Wall time is the price and it is the right trade: ungated, five to eleven panes never painted at
  all inside a 20 s budget — the same shape `remote-session-index.ts` reports for its own burst.

### We have our own VT emulator — check it before asking tmux

xterm.js is not just a renderer. It parses the pane's output stream, so it **tracks DECSET modes
itself** and exposes them as public API (`term.modes`, `@xterm/xterm/typings/xterm.d.ts:1865`) —
bracketed paste, application-cursor, mouse tracking, origin mode, and the rest. We already read one
of them: `term.modes.mouseTrackingMode` decides whether a click means "follow this file link"
(`src/renderer/terminal/file-links.ts:341`).

We once did the opposite. `PtyManager.bracketPasteRequested` (now **deleted** — see the tombstone
in `pty-manager.ts`) asked **tmux** for the same class of fact, via `#{bracket_paste_flag}` — and
that format **first shipped in tmux 3.7** (2026-06-26). Ubuntu 24.04 LTS ships 3.4, Ubuntu 22.04 →
3.2a, Debian 12/13 → 3.3a/3.5a, Ubuntu 26.04 → 3.6a. On all of those it expanded to `''` exactly
like a bogus name, and the comparison against `'1'` answered **false for every pane**. The bundled
tmux did not rescue it: `extraResources` places it under `"mac"` only, and `bundledTmuxPath` is
deliberately the **last** candidate (see the comment at `pty-manager.ts:245-250` — preferring our
binary would pair a new client with the user's older running *server*, which upstream refuses). On
an **SSH project it was unfixable from our side entirely**: the remote's tmux is whatever the
user's server has.

**The rule this is an instance of: before asking tmux, ssh or `ps` something about a pane, check
whether the emulator already knows it.** Facts about *what the app in the pane is doing* (VT modes,
the alternate screen, the cursor shape it asked for) arrive as bytes we already parse. Facts about
*the session* (does it exist, what is the foreground process group, which panes are in it) are
genuinely tmux's and must be asked. Mixing the two up is how a feature acquires a dependency on a
tmux version we do not control. herdr has no version problem here for exactly this reason — it
reads `mode_get(MODE_BRACKETED_PASTE)` from its own state machine.

**Measured, and the emulator is NOT the answer here.** The `?2004h` a tmux *client* receives is
tmux's own paste-through on the outer terminal (`tty_start_tty`, gated on the outer terminfo
`BE`/`BD`), not the pane app's request: it arrives ~5 ms after attach and reads `true` even for a
pane running `sleep 30`. It never toggled across pane switches, window switches, re-attach or
co-attach. A constant is not a signal — so `term.modes.bracketedPasteMode` cannot stand in for the
pane's state, however tempting the symmetry with `mouseTrackingMode` looks.

**That paragraph is about a tmux CLIENT, and the SESSION HOST is the opposite case** (issue #686).
On Windows there is no tmux, so nothing sits between the pane's app and the host's headless
emulator: a `?2004h` it sees was written by the app itself, which is exactly the fact
`paste-buffer -p` asks tmux for. `HostSession.bracketedPasteRequested()` reads it (behind
`outputTail`, like `serialize` — xterm applies writes asynchronously, so an early read answers "no"
for the turn that just enabled it) and `sendKeysWrites` (`session-host/send-keys-delivery.ts`)
sanitizes ALWAYS and frames only when the app asked. Separate writes alone can still be read
as one burst (#780). Both native Windows `sendText` and host `sendKeys` now execute through
`core/settled-text.ts`: capture a baseline, paste without Enter, then poll at 40 ms for at most
15 polls for a changed, stable screen containing the sanitized text. Only then write one Enter,
after rechecking liveness/generation and paste mode. Unknown capture, unchanged output or timeout
leaves the paste unsubmitted and returns `pasted-not-submitted`, never `true`. The discriminant
survives IPC/WS and `sendKeysV2`; canvas writes name the partial delivery, trigger runs record
a terminal miss (including queue flush), and one-way UI writers raise a visible warning. Test
success with `=== true`, never truthiness. Do not retry an unconfirmed submit and duplicate the paste. Overlapping sendText operations on the same pane
are refused before input; insert-only, empty Enter and unframed input retain their contracts.
A collapsed/hidden/oversize paste may require manual Enter. This is an observed-screen heuristic,
not an application acknowledgement. Linux fake-PTY tests cover a 150 ms busy reader; real Windows
Codex/Claude, context-link/write, dictation and rename device checks remain required. Existing
hosts refuse the additive `sendKeysV2` command until they retire; no raw-write fallback or
automatic host restart is performed. Legacy clients still use the existing `sendKeys` command.


**The actual fix is older than the problem: `paste-buffer -p`.** From tmux's own man page — *"If
`-p` is specified, paste bracket control codes are inserted around the buffer **if the application
has requested bracketed paste mode**."* Introduced 2012-03-03, shipped in **tmux 1.7**, so it is
present on every tmux in the field. We do not have to ask whether the app wants framing; we ask
tmux to do the framing, and it applies the pane's real state. Measured on 3.4: framed when the app
requested it, unframed when it did not, correct for a non-active pane, and the whole thing in one
round trip —
`tmux load-buffer -b nt - \; if-shell -F -t <target> '#{pane_in_mode}' 'send-keys -t <target> -X
cancel' \; paste-buffer -d -p -r -b nt -t <target> \; send-keys -t <target> Enter` (`-r` keeps
`\n` as `\n` instead of tmux's default `\n`→`\r` rewrite; see `tmux-naming.ts`).

Two hazards that come with it, both measured:
- **Copy mode silently unframes.** With `#{pane_in_mode}` = 1, `paste-buffer -p` delivers unframed
  (tmux checks the copy-mode screen, not the app), so a user who scrolled the wheel up gets the
  one-turn-per-line bug. The `if-shell` guard above runs `send-keys -X cancel` first — only when the
  pane is in copy mode — in the same invocation, restoring it.
- **`set-buffer -- "$text"` hits ARG_MAX** around 200 KB. Use `load-buffer -` over stdin — and on
  the SSH path that means piping into the remote command rather than putting the text in argv.

There is no longer a probe or a fallback to weigh: `sendText` delivers through `paste-buffer -p`
**unconditionally** (the plan builders live in `tmux-naming.ts`). The old two-step path — probe
`#{bracket_paste_flag}`, and on a false answer deliver `line1\nline2\nline3\r`, raw newlines into
the app that *mangled* every multi-line write on a pre-3.7 tmux — is gone with the probe.

### Seeding a fresh xterm (`attachReplay` / `seedPaint` in `terminal/terminal-config.ts`)

A newly mounted xterm is empty. Since tmux paints its own client, there is usually **nothing to
seed** — the cases are:
- **`none`** — the terminal was **parked** (its buffer is still live and correct), or it is a
  brand-new node with an `initialCommand`. Seeding either would duplicate content.
- **`cold-snapshot`** (`fresh` — reboot/first open) — the tmux session is genuinely gone, so replay
  the persisted `scrollback-store` snapshot, with a "session restored" separator.
- **`warm-attach`** (`!fresh` — app restart, tmux still alive) — **seed nothing.** tmux is attached
  to this client: it redraws the visible screen and owns the history under the wheel. This is where
  a `warm-history` hydration (`transport.captureHistory` → `tmux capture-pane`) used to run; it was
  **removed**, because writing into a buffer that tmux then repaints is what produced the black
  bands and duplicated screens. The single exception is a **co-attach joiner** (`seedPaint` →
  `create-screen`): tmux only repaints on SIGWINCH, so a joiner that did not resize never gets a
  redraw, and the screen captured server-side inside `create()` (`PtyCreateResult.screen`) is the
  only thing that paints it — see docs/team-presence.md. **A co-attach joiner also misses tmux's
  MOUSE-TRACKING modes** (`?1000h/?1002h/?1006h`): tmux emits them only at its OWN attach, and
  neither the `screen` capture (`capture-pane` carries no private modes) nor a SIGWINCH redraw
  re-sends them — so the joiner's wheel can't scroll tmux history until a keystroke makes the app
  re-request mouse. `join()` therefore sets `PtyCreateResult.coAttachMouse` for tmux-backed joins
  (gated on `persistKey`, on BOTH the screen and resize branches) and the renderer writes
  `CO_ATTACH_MOUSE_SEQ` into the fresh xterm (both `ModalTerminal` and `TerminalNode`). tmux is
  always `mouse on`, so this matches its invariant client state; the enable is idempotent. Was the
  "can't scroll the kanban card-modal terminal until you press a key" bug.

xterm's own `scrollback` (`xtermScrollback(settings.tmuxScrollback)`, floored at 1000, capped at
`XTERM_SCROLLBACK_MAX` = 10000) is kept for the sessions tmux does *not* back (a plain shell when
tmux is unavailable) and for the cold-snapshot replay — it is not what the user scrolls in a tmux
session.

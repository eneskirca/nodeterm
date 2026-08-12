# Session memory: the RAM pill and the per-session panel

A bottom-left **RAM pill** beside the usage pill, and the **session-memory panel** it opens: how
much memory the machine the *active project* runs on is using, and which `nt-*` tmux session is
holding it.

> Design spec: `docs/superpowers/specs/2026-08-10-session-memory-panel-design.md`.
> The condensed rules live in `CLAUDE.md` ("Session memory"); this document carries the
> measurements, the reasoning that is too long for that file, and **§10, the device checklist** for
> everything that could not be verified on the headless Linux box this was built on.

Files:

| Layer | File |
|---|---|
| Local read + pure assembly | `src/core/session-memory.ts` |
| The SSH host's leg (generated `sh`) | `src/core/session-memory-remote.ts` |
| RPC + routing (booted by BOTH shells) | `src/core/session-memory-service.ts` |
| Renderer store (two cadences) | `src/renderer/state/sessionMemory.ts` |
| Rows → titles / projects / orphans | `src/renderer/lib/sessionMemoryRows.ts` |
| Where a kill has to land | `src/renderer/lib/sessionKill.ts` |
| Pill + panel | `src/renderer/components/SystemResourcePill.tsx`, `SessionMemoryPanel.tsx` |

---

## 1. What was measured, and what it means

The feature exists because a user reported *"Claude terminals are killing my memory, each one takes
2 GB"*. Measured on the production host (64 GB, 95 live `claude` processes):

| What | Measurement |
|---|---|
| `claude` process alone | avg **335 MB**, peak **1159 MB** |
| 95 `claude` processes | **31.1 GB** |
| MCP children per session | +30–200 MB (playwright-mcp + Chrome ≈ 200 MB alone) |
| One "Claude terminal" tree | **440 MB – 1.2 GB** |
| nodeterm-server (per user) | 49–82 MB |
| tmux client (per attached session) | 5.1 MB × 59 = 303 MB |

Two facts settle the attribution:

1. **nodeterm does not allocate it.** It is the agent CLI's own V8 heap. `RssAnon` is essentially
   all of the RSS (1165 MB of 1187 MB on the largest process), and this repo sets no `NODE_OPTIONS`
   / `--max-old-space-size`, so V8 sizes its heap from system RAM (`heap_size_limit = 4144 MB` on
   that host).
2. **It is not a leak.** RSS is flat with process age — 0–24 h avg **340 MB**, 1–7 day avg 339 MB,
   7 day+ avg **326 MB**. Each process takes a flat baseline and never returns it.

So the user's *number* was right and their *attribution* was wrong — but nodeterm is not innocent
either: it keeps those processes alive (only `×` kills a session; project close and app quit merely
detach) and the canvas invites many at once. One measured client held **51 attached sessions ≈
17 GB**.

**The gap this closes is the blindness, not the allocation.** Nothing in the product told the user
that 18 sessions were live, that one of them was 1.2 GB, or that six belonged to a project they
closed three weeks ago. Capping agent memory (`--max-old-space-size`) was considered and rejected
for v1: a low ceiling OOM-kills a long-context session, which is worse than the 2 GB.

**Do not re-derive these numbers.** They are here so the next person does not spend an afternoon on
`/proc` arithmetic to reach the same conclusion.

## 2. Why the reaper is deliberately untouched

`src/core/session-budget.ts` reaps only **detached** sessions idle past a grace window. On the
measured host that made its kill list **empty** — 60 `nt-` sessions, 50 attached, **0 eligible** —
while 31 GB sat there. An open canvas is attached, and attached is untouchable.

Retargeting the reaper is a separate change with separate risk (it would start killing sessions a
user is looking at). This feature adds **sight**, not policy: it shows the 31 GB and lets a human
decide. The one thing it shares with the reaper is `readMemInfo` (§3).


### The reaper does not cull on a byte watermark on macOS either

Fixing `readMemInfo` made the bytes HONEST; it did not make them the right instrument. The same
capture that verified the formula showed the machine at **82% used with macOS's own Memory Pressure
graph GREEN** (8.38 GB compressed, 1.77 GB swap in use). A 10%-available watermark therefore fires
in states the OS itself calls healthy — and the reaper's pressure trigger culls sessions.

So `hostMemReader` (darwin ⇒ `null`) is the reaper's **default** reader, not something the shells
inject. That is deliberate: a wiring line can be deleted with the whole suite green — measured twice
on this branch — whereas a default cannot. `planReap` treats `null` as *no pressure signal*, so on
macOS only the detached-COUNT cap can trigger a cull, and that is not memory-based at all.

The reaper keeps its purpose on macOS: the count cap bounds accumulation, the pty-pressure monitor
covers the resource that actually ran out, and this panel gives the user the visibility to cull
deliberately. What it loses is the ability to cull on a signal that was telling it the wrong thing.

**Guarded at the source, and honestly:** `hostMemReader` differs from `readMemInfo` ONLY on darwin,
and CI runs on Linux where they are the same function — so reverting the default leaves every
BEHAVIOURAL test green (measured). `session-budget.test.ts` therefore asserts the default in the
source text, with that limitation written next to it.

## 3. `readMemInfo` has exactly one home

It lives in `session-memory.ts`; `session-budget.ts` imports **and re-exports** it. Two features now
read host RAM — the reaper's watermark and the pill — and a second copy would drift. The reaper and
the pill must never disagree about how much RAM is free.

Linux `/proc/meminfo` `MemAvailable` is the honest number; `os.freemem()` is the fallback elsewhere
(on Linux that fallback would report `MemFree`, materially smaller under a warm page cache, which
is why the file read comes first). `null` when nothing is readable — **never zero**.

## 4. `ok:false` is not `ok:true` with no rows

This is the rule the whole feature exists to honour, and every layer preserves it:

- `collectSessionMemory` returns `ok:false` when there is no tmux binary, when the process table is
  unreadable, or when **no socket answered**. A socket with no tmux server is an *answer* (the
  normal state of a socket nobody has used), classified by `isNoServerError` — deliberately narrow
  and **anchored** to tmux's own connect message, because `promisify(execFile)` folds stderr into
  `err.message` and a bare `no such file or directory` also matches a tmux client missing a shared
  library (exit 127 on *every* socket) and a dead ssh ControlMaster. Laundering either into "no
  sessions here" prints an empty panel over 20 live ones.
- `parseRemoteSessionMemory` returns `ok:false` on a missing **or out-of-order** section marker, on
  an empty process table (a host always has processes), and — the remote counterpart of the rule
  above — when **no socket answered**. Each socket is fenced in the reply (`##SOCK <name>` … its
  tmux exit status as `##SOCKRC <n>`) with tmux's stderr folded in (`2>&1`), and the SAME
  `isNoServerError` classifies it: exit 0 answers with panes, "no server running" / "error
  connecting to … (no such file or directory)" answers "nothing here", **anything else did not
  answer** (nor did a fence the stream cut off mid-socket). Before this the sweep was
  `{ tmux …; tmux …; } || true` with stderr discarded, so a host whose tmux client could not start
  — exit 127 on *every* socket, live sessions untouched — produced a stream byte-identical to an
  idle host's and the panel said "No sessions are running here." over thirty of them.
- The store carries `ok:false` through untouched, and treats a *rejected* call as the same fact.
- The panel renders four distinct sentences: "Could not measure sessions on this machine.",
  "Measuring…", "No sessions are running here.", and the list. The grand total and the
  "*n* sessions" count are gated on a `measured` flag (`ok && loadedScope === scopeKey`), so a
  failure can never show "0 B / 0 sessions" beside it.

## 5. Reading this machine

`/proc/<pid>/status` is read for the whole table, **never `statm`**. `status` carries `PPid` and
`VmRSS` in one file and already in kB; `statm` reports RSS in **pages**, which forces a page-size
assumption — a hard-coded 4096 under-reports **4×** on a 16 KiB-page arm64 kernel and **16×** on the
64 KiB-page enterprise arm64 builds (it would print 40 MB for a 640 MB session). Do not "optimise"
this back to `statm`.

Non-Linux (and an unreadable `/proc`) falls through to one `ps -eo pid,ppid,rss` call, through the
same injectable seam as tmux — nothing in `session-memory.ts` reaches a subprocess around it.

`rollupTree` walks each pane pid's descendants with a `seen` guard (a table captured while pids are
recycling can present a cyclic ppid chain, and a sweep that hangs is worse than one that
under-reports). **`childCount` counts EVERY descendant**, the agent CLI included: `pane_pid` is the
pane's *shell*, so a claude session with two MCP servers reports **3**. The panel therefore says
"child processes", never "MCP" — a plain `npm run dev` has children too.

`list-panes -a` emits one line per **pane**, so the first pane of a session wins in both legs (same
key, same order) — one session is one row.

### On macOS the PANEL reads phys_footprint, not `ps`'s rss

Two surfaces describing one machine must not use two accountings. The pill's `vm_stat` reading
counts compressor pages and matches Activity Monitor to 0.05%; `ps`'s `rss` does not count them at
all, so the panel was measuring something else.

Measured on a real Mac (2026-08-12), 8 `claude` processes captured in the same tick against Apple's
own `footprint` tool — the source of Activity Monitor's "Memory" column:

| Process state | footprint / rss |
|---|---|
| Active | ~1, and one read **0.73x** |
| Idle | **1.84 - 2.20x** |

Both directions matter. `rss` counts shared resident pages footprint does not (hence 0.73x), and
drops the compressed pages of an idle process (hence 2x). **The idle case decides it:** this panel
exists to answer what idle sessions cost, and macOS compresses exactly those, so `rss` understated a
six-hour-idle session by about half.

`parseTopFootprint` reads `top -l 1 -stats pid,mem`, verified identical to the `footprint` tool.
`ps` is still called for the parent links (`top` has no ppid column) and the two merge on pid; a pid
`top` did not list keeps its `rss`, since the snapshots are a moment apart.

The format facts in that parser were CAPTURED, not composed — including the one that would have
broken a naive implementation: the MEM column is left-aligned in five characters, so values carry
TRAILING SPACES (`12M  `, `859M `, `1314M`) and a `/M$/` regex misses two thirds of the column. `G`
is accepted but was never observed (a 1314M process stayed in M); `B` and any restricted-process
rendering were not observed and are deliberately not guessed — an unrecognised suffix skips the row.

**Linux is untouched:** `/proc/<pid>/status`'s `VmRSS` is the right number there.

### macOS reads `vm_stat`, not `os.freemem()`

libuv's `os.freemem()` counts only genuinely FREE pages, and a healthy Mac keeps that near zero on
purpose — file-backed and purgeable pages are held until something needs them. So `total - free`
renders every Mac at ~100% used. Observed in the field: a 24 GB Mac reporting **23.9 / 24.0 GB**
while the panel's sessions summed to 2.8 GB.

`parseVmStat` computes what Activity Monitor calls Memory Used —
`anonymous - purgeable + wired + compressor` — and treats the rest as available. It is an
**approximation of Activity Monitor, not a reproduction**: Apple documents no exact figure, and on
Apple Silicon the parts are known not to sum to its total.

**The page size is read from `vm_stat`'s own header, never assumed.** Apple Silicon uses 16 KiB
pages; hard-coding 4096 would report a quarter of real usage — the identical mistake this file
already fixed on the Linux side, where `statm` tempted the same constant.

**This also fixed the reaper, which is why the change lives in `readMemInfo` rather than in the
pill.** `sessionBudgetConfig`'s watermark defaults to 10% of RAM (2457 MB on a 24 GB machine), and
`os.freemem()` sat permanently below it — so `planReap` saw memory pressure on EVERY sweep and a Mac
reaped idle detached sessions every 10 minutes regardless of how much memory was actually free. One
reader, two consumers: that is the reason they share a definition.

**A failed `vm_stat` yields NO SIGNAL, not a fallback.** `darwinMemInfo` returns `null` rather than
dropping through to `os.freemem()` — that value is exactly what caused the bug, so falling back to it
would restore it on any Mac where `vm_stat` is missing, slow or unparseable. Both consumers degrade
correctly on `null`: `planReap` treats it as no pressure (absence of evidence never triggers a kill)
and the pill pulses instead of printing a number it has not earned.

**Confirmed in the field.** The reaper symptom was reported independently as "my sessions keep
disappearing" on macOS, before the cause was known. Until this ships, the workaround on an affected
machine is the reaper's own kill switch: `NODETERM_SESSION_REAP_DISABLED=1`.

**VERIFIED on a real Mac (2026-08-12, 24 GB machine) — device checklist item 6 is closed.**
Activity Monitor reported App 7.67 GB + Wired 2.95 GB + Compressed 8.38 GB = **19.00 GB**; the pill
read **19.1 GB**. AM's own headline "Memory Used" said 19.73 GB — it exceeds the sum of its own
parts on Apple Silicon, a documented discrepancy rather than an error here. Before the fix the same
machine read **23.9 / 24.0 GB**.

The test fixture remains composed from Apple's documented format; what is verified is the FORMULA
against a real machine, not that fixture's specific numbers.

## 6. The SSH leg

An SSH project's sessions live on the host, so the sweep runs there: core generates ONE POSIX `sh`
script, the shell runs it over the project's ControlMaster, and only the printed sections come back
— the same division of labour as `remote-claude-usage.ts` (core owns the command *and* the parsing;
the shell owns the master). One round trip carries all three facts, because each extra `ssh` exec is
a login on someone else's machine.

It is generated shell that no compiler checks, so `session-memory-remote.test.ts` runs it **for real
under `/bin/sh`** against a fake host tree — the same discipline as `remote-claude-usage.test.ts` and
`canvas-control-shim.test.ts`. Keep it that way. It is not ceremony: the plan's own script said
`echo ##MEM`, which prints an **empty line** under POSIX sh (an unquoted `#` starts a word-initial
comment), and would have made **every healthy host report `ok:false`**. The markers are quoted for
that reason.

Three more properties of that script are load-bearing: every section header is printed
**unconditionally** (a missing one means the stream was cut short, not that the host had nothing);
the socket names + `-F` format come from the shared constants, so the remote sweep can never
look at a different socket or ask for different fields than the local one; and **each socket is
fenced with its own tmux exit status and its stderr** (§4) — an exit status alone cannot tell an
unused socket from a broken tmux, and dropping both is what let a failed sweep render as an empty
host. A non-Linux host has no
`/proc/meminfo`, so its `mem` is legitimately `null` — the pill must pulse there, never show 0.

## 7. Which machine answers

`session-memory-service.ts` makes exactly one decision: local sweep or remote leg. Two independent
sources say "remote" and **either is enough** (OR, never AND) — the renderer's own `remote` flag
(it already knows from `usageScope`) and the shell's `isRemoteProject`. A source that answers "no"
because it is momentarily uninformed (an index not loaded, a master that just dropped) would
otherwise turn a remote query into a local sweep and publish **this** machine's sessions under the
host's name.

`sshScopePredicate` builds that shell-side answer from **identity, not liveness**:
`workspaceStore.sshProjectIds()` (a disconnected SSH project is still someone else's machine),
OR-ed with the live masters for a project the index has not yet listed.

The `remote` option pair is deliberately asymmetric: `run` is optional (a shell may be unable to
read another host), `isRemoteProject` is **required** — reading-without-knowing is not coherent and
stays a compile error.

One in-flight remote read per project is coalesced (the panel wants both the RAM number and the
rows; that is two identical `ps` execs on someone else's machine otherwise). The key is the
`projectId` and nothing else, because that is the only thing deciding which host the command lands
on. It is cleared on settle — a concurrency guard, never a cache.

## 8. The renderer: scope, cadence, ownership

**Scope** is `usageScopeKey(activeProject)` — the same helper the usage indicator uses, so the two
pills cannot disagree about which machine they describe. The store stamps every request with the
scope itself (not a counter: `refreshFull` and `startHostPoll` can be called for different scopes
with no intervening bump), discards a response stamped with a scope it has left, and clears the
previous machine's facts on a real change.

**The cadence split follows the cost:**

- **Local scope** — the pill polls `HOST_POLL_MS` (30 s). One file read, free.
- **SSH scope** — **never polled.** One read on scope entry, one when the project's ControlMaster
  comes up (an SSH project is opened before its master is ready, and with no timer behind it a first
  read against a dead master would leave the pill blank), and one per panel open / `⟳`. This is the
  rule `CLAUDE.md` already sets for remote usage, for the same reason.

**The full sweep never runs on a timer and never from the pill.** The panel is *unmounted* while
closed and its mount is what triggers the sweep.

**The pill is icon-only at rest.** It sits on every canvas, always, so a permanent
`RAM 15.6 GB / 62.5 GB` is a row of numbers nobody asked for — the pill's job is to be findable, not
to report continuously. Hover (or keyboard focus, or an open panel) reveals used/total; the icon
itself carries the pressure reading through the same thresholds the old mini-bar used, tinting as
memory is CONSUMED. The reveal is **CSS, not a conditional mount**: the numbers stay in the DOM at
rest so they remain the button's accessible name, and a hover-mounted figure would be unreachable to
anything that reads the control without pointing at it. The pill sits to the LEFT of the usage pill
— this machine's resources before this account's quota.

**Ownership contract:** the store's poll timer and its active-scope stamp are **module singletons**,
and the **pill is their single owner**. The panel must never call `startHostPoll` / `stopHostPoll` —
a `stopHostPoll` on unmount would clear the pill's interval with nothing left to restart it, and the
number would silently freeze until the next scope change.

The store resolves its api through `sessionForProject(projectId).api`, not `window.nodeTerminal`: a
relay tab's renderer runs on the guest while its sessions live on the host, and its api is the
stub — `ok:false`, which the panel surfaces as *not available here*, not as a failure to retry.

## 9. Rows, orphans, and where a kill lands

`resolveSessionRows` resolves each `nt-<nodeId>` against **every** project the store holds:

- **A closed project is not an orphan.** `closeProject` only sets `closed = true` and keeps the
  project and its nodes on disk, so its sessions resolve to a real title and are labelled with their
  project. Calling them orphans would invite the user to kill sessions they deliberately parked. The
  panel therefore passes the full `projects` array — filtering to open tabs defeats this rule
  silently, from outside the file that states it.
- **`orphan` is the distinguishing field, not `state === null`.** A plain terminal never enters the
  agent-status map, so deriving orphan-ness from a missing agent state would flag every one of them.
  An orphan's state is dropped rather than passed on (the panel could not explain a "working" dot on
  a row it cannot travel to) and its dot renders hollow.
- Orphans are the point: they are exactly what the reaper cannot see and no canvas can show.

**The kill is routed by the SCOPE, not by the row** (`planSessionKill`). `transport.destroy(nodeId)`
reaches a *remote* tmux session only through a LIVE local client carrying `sshRemote` — which an
orphan has not, and neither has a node owned by a non-active project. Before this, every orphan
row's `×` on an SSH project promised a kill it could not perform: the local socket was touched, the
host's `nt-<id>` kept running, and the row came back on the next refresh with no explanation. So on
an SSH scope the kill *additionally* runs `sshProject.killSessions(activeProjectId, [nodeId])` over
that project's own ControlMaster, which needs no live session and is idempotent (the mounted case,
where `destroy` already ended it, is a harmless best-effort miss).

That is safe because it is a **round trip, not a lookup**: the panel's `nodeId` is literally
`session.slice('nt-')` from the sweep, and `killSessions` maps it back through the same idempotent
`sessionName()`, so the remote leg kills **the exact session name the sweep observed, on the host it
observed it on**. It does not rest on node ids being globally unique (they are only per-launch
unique).

**The name and the host were never the hard part — the SOCKET was.** Two nodeterm tmux sockets exist
on one machine at the same time: `node-terminal` for a nodeterm running ON it (desktop or Server
Edition) and `nodeterm-rmt` for one SSH-ing INTO it. The sweep lists **both**
(`session-memory.ts`, `session-memory-remote.ts`) while the kill targeted **one** — so every row that
came off the other socket got the confirm "this stops its tmux session" and a kill that landed
nowhere. That is not an exotic host: one running its own `nodeterm-server` *and* being SSH'd into is
exactly it, and the local mirror is the same shape (this machine's panel listing the `nodeterm-rmt`
sessions that another machine's nodeterm spawned here — all of them orphans locally, since their
nodes are on that machine's canvas). So a kill that knows only a NAME now goes to **every socket that
name could be on**: `KILL_TMUX_SOCKETS`, via `remoteTmuxKillEverySocketArgs` (remote) and
`localKillSockets` (local). Three things make that safe rather than reckless:

- It is **best-effort by contract**: tmux exits non-zero with "can't find session" on whichever
  socket does not hold it, which is the already-ignored case both legs were written around.
- The target is **exact** — `-t =nt-<id>`. Without `=`, tmux falls back to fnmatch and then to
  PREFIX matching whenever the name is not found, and "not found" is the normal outcome of a
  speculative kill. Node ids end in a counter, so `nt-…-1` is a prefix of `nt-…-12`: a miss could
  have killed a *different* session. The reaper already killed this way, for this reason.
- **The fan-out is opt-in, and only the panel opts in.** Two conditions have to hold: we do not know
  the socket, *and* the caller asked for it (`localKillSockets(liveSocket, everySocket)`,
  `sshProject.killSessions(…, { everySocket: true })`, `transport.destroy(id, { everySocket: true })`).
  A destroy for a session we hold aims at that session's socket alone whatever the caller asked, so
  the ordinary node-`×` on a mounted node still fires exactly one kill. But the **unheld** branch is
  not rare — an ordinary node-`×` on a node that was never mounted in this process takes it every
  time, which is the common case right after an app restart and for every non-active project's node
  — and project deletion is the same shape remotely. Those callers know their own nodes, so they
  stay narrow: speculating at `nodeterm-rmt` aims at sessions ANOTHER machine's nodeterm SSHed in to
  spawn here, and speculating at a host's `node-terminal` aims at sessions a nodeterm running ON it
  owns. Both defaults and both opt-ins are pinned (`pty-single-user.test.ts`,
  `control-master.test.ts`, `ssh-project.killSessions.test.ts`), including that the wire flag must
  be a literal `true`.

Note the deliberate duplication: the sweep and the reaper keep their own `[TMUX_SOCKET,
RMT_TMUX_SOCKET]` arrays. For them the ORDER is load-bearing — the sweep's `bySession` is first-wins,
so it decides which socket a duplicate name is attributed to — and for a kill it means nothing.
Sharing one constant would couple a de-duplication preference to a kill list.

Ownership is re-resolved at click time rather than taken from the row's `orphan` flag — the rows are
a snapshot of the last sweep, and a node created since would otherwise be killed as an orphan. With
an owner, the kill goes through `closeSession`, the same path the sessions sidebar and the node's
own `×` use.

### Surfaces

- **Desktop** — full, including the SSH leg.
- **Server Edition** — the service runs and reports the machine it is served from. An SSH scope
  answers `ok:false` (no ControlMaster is injected) — and it says so **by identity**, via
  `sshScopePredicate` over `workspaceStore.sshProjectIds()`, rather than trusting the renderer's
  flag. See `docs/SERVER.md`.
- **Relay tabs** — the ws-bridge stub answers `ok:false`; the panel says session memory is not
  available on a relay tab rather than reporting a failure.
- **Kanban board** — Canvas passes `overBoard={kanbanOpen}`, which raises the pill to z 26 over the
  board's opaque 25 (the same prop `UsageIndicator` takes beside it); an open panel rises to 60, over
  the board and the banners but below ConfirmDialog / the palette.
- **Sessions sidebar** — an open panel also has to clear the sidebar (z 12) when the board is
  *closed*, which is a separate rule: `.sysres-indicator:has(.sessmem-panel) { z-index: 13 }`,
  mirroring `.usage-indicator:has(.usage-popover)`. Both `:has()` rules only work because the pill
  cluster is mounted OUTSIDE `<ReactFlow>` — the library's wrapper carries an inline `z-index: 0`
  that would trap any value inside it, however large. The collapsed pill deliberately keeps its low
  layer (5) and passes *under* the sidebar.
- **Mobile companion** — **N/A for v1.** *nodeterm mobile* attaches to tmux sessions over the
  transport protocol and has no concept of per-session host memory; adding one means extending that
  protocol. A follow-up in `~/projects/nodeterm-ios`, not built here.

### Known gaps (v1, deliberate)

- The session list is **uncapped**. A host with hundreds of sessions makes a long list; truncating
  silently would hide exactly the rows that matter. If it becomes a problem the fix is a visible
  "showing top N" line, never a silent cap.
- A pane pid that exits between the tmux call and the process sweep emits a legitimate-looking
  **0 MB row** rather than being dropped — the same "measurement failure rendered as zero" shape as
  §4, at row granularity.
- Switching between two SSH projects with the **same `user@host`** (the scope key carries no port)
  leaves the previous rows on screen until the re-sweep, because `enterScope` only clears when the
  scope *string* changes.
- **FOLLOW-UP OWED — the sessions sidebar still has the bug this feature fixed in the panel, and the
  two surfaces now disagree about the same session.** `SessionsSidebar.tsx`'s close button calls
  `closeSession(projectId, id)` (via `Canvas.tsx`'s `onCloseSession`) with **no remote leg**: for an
  SSH project's node that is not mounted, `transport.destroy` has no live client carrying
  `sshRemote`, so it touches only the local socket while the host's `nt-<id>` keeps running — after
  a confirm that says it stopped. The session-memory panel routes the identical case through
  `planSessionKill` → `sshProject.killSessions`, so ending a session from the panel works and
  ending the same session from the sidebar does not.
  Deliberately out of scope here: the sidebar's rows span arbitrary projects on arbitrary hosts, so
  its correct fix is **owner-routed per row** (the owner project's own master, not the active
  project's — the panel's rule is only sound because the panel shows one machine at a time), which
  is a different rule on a surface this change does not own. Whoever takes it should reuse
  `planSessionKill`'s shape rather than inventing a third kill path, and should widen its
  `remoteProjectId` leg from "the active project" to "the row's owner" as the same change.

## 10. Device checklist

Everything below was argued from code, CSS or a Linux measurement and could **not** be exercised on
the headless Linux box this was built on. Format follows `docs/grok-agent.md` §9 /
`docs/gemini-agent.md` §9. Highest value first: items 1–5.

```
The kill actually reaching the host (the bug most recently fixed, and the one no test can prove)
 1. SSH project, a row with "no node": press ×, confirm, then on the HOST run BOTH
    `tmux -L nodeterm-rmt ls` and `tmux -L node-terminal ls` — the nt-<id> session must be GONE from
    wherever it was, not merely absent from the panel.
 2. Same, for a row owned by a CLOSED ssh project (it resolves to a title, so it takes the
    closeSession path plus the remote kill — both legs must land).
 2b. THE CROSS-SOCKET CASE, and the reason both sockets are now killed. On a host that also runs its
    own `nodeterm-server`, open an SSH project pointed at it: the panel lists that server's own
    sessions (they live on `node-terminal`, not `nodeterm-rmt`). Kill one and confirm with
    `tmux -L node-terminal ls` on the host. Before the fix this row's confirm was a no-op.
 2c. The LOCAL mirror of 2b: from another machine, SSH into this one with nodeterm and open a
    terminal (it lands on this machine's `nodeterm-rmt`). On THIS machine the panel shows it as an
    orphan; kill it and confirm with `tmux -L nodeterm-rmt ls` locally.
 3. Kill a node created less than a sweep ago (<1 s): the confirm wording may say "no node" from the
    stale snapshot, and the CANVAS node is currently left behind (§4's known hole) — confirm which
    of the two actually happens on a real machine.
 4. Local project, ordinary node ×: confirm `tmux -L node-terminal ls` loses it, that the node's own
    kill still fires exactly ONE kill-session (no fan-out on the path we hold a session for), and
    that no remote kill is attempted — a local nt-<id> whose node belongs to an SSH project must NOT
    be killed on the host.
 4b. tmux target exactness: create nodes until two session names share a prefix (`nt-…-1` and
    `nt-…-12` — same millisecond, counters 1 and 12), delete the SHORTER one, and confirm the longer
    one survives. This is what `-t =<name>` buys and it has only been reasoned about.

macOS (the ps path never runs on Linux)
 5. **DONE 2026-08-12** — measured, and it changed the code. `ps rss` is NOT the right number on
    macOS. Against Apple's own `footprint` tool, 8 `claude` processes in one tick: footprint/rss is
    ~1 for ACTIVE processes (one read 0.73x — rss counts shared resident pages footprint does not)
    but **1.84-2.20x for IDLE** ones, because macOS moves an idle process's pages into the
    compressor, which drops out of rss. That is the population this panel describes, so rss
    understated a six-hour-idle session by about half. The panel now reads phys_footprint via
    `top -l 1 -stats pid,mem`. (WindowServer's 8x gap was real but atypical — graphics allocations.)
    Residual: confirm the panel's per-row totals against AM's Memory column for the same pids, on a
    build containing that change.
 6. ~~macOS: check `parseVmStat` against Activity Monitor.~~ **DONE 2026-08-12** — 19.1 GB vs
    AM's 19.00 GB of parts on a 24 GB machine (was 23.9/24.0 before the fix). Still open on
    macOS: give the memory-PRESSURE monitor a real signal (`kern.memorystatus_vm_pressure_level`)
    rather than a byte watermark — the same capture showed 82% used with AM's pressure graph GREEN.
    RE-VERIFIED independently 2026-08-12 (second session, shipping function imported via esbuild
    bundle, vm_stat captured on the same tick as an AM screenshot): ours 18.87 GB used vs AM's
    parts 7.23 + 2.99 + 8.66 = 18.88 GB — 0.05% off; AM's HEADLINE "Memory Used" was 19.70 GB,
    0.83 GB (4.2%) above its own parts, confirming the header comment that the parts do not sum to
    the headline on Apple Silicon. Same capture: `os.freemem()` said 0.10 GB. Page-size trap
    mutation-verified: hard-coding 4096 against the machine's 16,384-byte pages under-reported used
    memory exactly 4.00× (18.87 → 4.72 GB). The darwin reaper default is now also guarded by a
    BEHAVIOURAL test (darwin-gated, mutation-verified on this machine: reverting the default to
    `readMemInfo` reaps 8) — see session-budget.test.ts, which CI's source-text check stands in for.
 7. Open an SSH project: the panel must list THAT host's sessions and no local ones, and its header
    scope + the pill's title must read `user@host`.
 8. Open an SSH project BEFORE its ControlMaster is up. The pill must end on a NUMBER, not a
    permanent pulse — this is the only place the connection-up re-read can be observed.
 9. A non-Linux SSH host (no /proc/meminfo): the pill must PULSE, never show "0 GB".
10. Kill the master mid-sweep (`ssh -O exit`) and press ⟳: "Could not measure", never an empty list.
10b. BREAK TMUX ON THE HOST while sessions are running (rename the binary, or `chmod 000` the socket
    dir) and press ⟳: the panel must say "Could not measure", NOT "No sessions are running here.".
    This is what the per-socket `##SOCKRC` fence buys, and the only place it can be seen for real.
11. Watch ⟳ during a slow remote sweep: the button must be disabled and spinning (loading is
    asserted nowhere).

Layout and theming (argued from CSS only)
12. Default window and ~900 px wide: the cluster at left:60px clears the React Flow controls and the
    canvas-lock button.
13. A machine with NO agent usage — UsageIndicator renders null, so the RAM pill must sit alone at
    left:60px, un-clipped.
14. Kanban board open: the pill is visible AND clickable over the board.
15. Sessions sidebar open: the collapsed pill passes UNDER the sidebar exactly as the usage pill
    does.
16. Usage popover open beside the RAM pill: no overlap, pill still clickable.
17. Both themes: hover (light is why the ink overlay exists) and the icon's colour steps at ~75% and
    ~90% used.
18. fitView / goToNode must no longer tuck nodes under the pill.

Rows, travel and the panel itself
19. A `claude` node with 2 MCP servers must read `+3 child processes`, not +2: `pane_pid` is the
    pane's SHELL, so the count includes the agent CLI itself. This is the ONLY item that can
    falsify the "reports 3" claim made twice above; everything else about the sub-line is arithmetic.
20. Travel to a row whose node lives in a CLOSED project: the tab must REOPEN and the camera land on
    the node. This is the likeliest thing on the list to be wrong — the load and the focus happen in
    the same tick, and `travelToNode` (not `focusNodeById`) is what handles it.
21. A LOCAL orphan row (`tmux -L node-terminal new-session -d -s nt-fake-1`) renders with a hollow
    dot and a "no node" chip, and its title is inert — clicking it must do nothing at all.
22. The panel STAYS OPEN through a kill: the ConfirmDialog is a portal outside the pill's container,
    and answering it must not dismiss the list the user is working through. Clicking anywhere else
    on the canvas must still close the panel.
23. The confirm on a row that HAS a node must say the node is removed too, and it must actually be
    gone from the canvas afterwards — the panel's purpose invites a user who only wanted the RAM.

Cadence and the other surfaces
24. Local project, panel closed: the pill's number moves after 30 s.
25. Local project: opening the panel triggers a sweep; closing and reopening triggers another; the
    pill alone never does (watch for `ps`/`/proc` activity, or an ssh exec on an SSH scope).
26. Server Edition in a browser: a local project's panel is full; an SSH project's panel says
    "Could not measure", with no local rows attributed to the host.
27. Relay tab: the panel says session memory is not available there, and offers no ⟳.
```

# Durable orchestration state (queue, station reports, hand-over holds, request ledger) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Durable orchestration state (queue, station reports, hand-over holds, request ledger)

Four facts a canvas-control orchestration leans on used to live only in process memory, so an app
(or Server Edition) restart erased them while the work they described kept going: a `send` answered
`queued` vanished while its sender believed it would be delivered; every station report vanished, so
each `--after-success` dependent read BLOCKED and needed ▶ / `run`; and the `--request-id` ledger
emptied, so a retry after a restart re-ran an open that had already happened; and the plain-`--after`
hand-over hold (#1052) was forgotten, so a dependent fired on the first `done` after a restart. All
four are now
mirrored to `<userData>/orchestration-state/<kind>.json` through ONE storage module,
`core/durable-state.ts` (`DurableFactFile` + a per-fact `DurableFactSpec`), so a new fact is one more
spec, never a fourth copy of the read / sanitize / write / flush code.

- **Machine-local only** — userData, never `.nodeterm/project.json`: a queued body, a station verdict
  and a control reply are one machine's run state, and a clone must not inherit them. Written 0600
  (a queued message's body is the user's text). **Relay tabs and the phone: N/A** — the facts belong
  to the core that executes the calls; a relay tab talks to the host's core, whose files these are.
- **The file is hostile input.** Envelope `{kind, version, savedAt, records}`; an unknown kind or
  version starts empty (warned), a record the fact's sanitizer refuses is DROPPED (never repaired),
  lists are capped, and a file that is not JSON / too large (16 MB) / not an envelope is set aside as
  `<file>.corrupt` (one copy) and the fact starts EMPTY with a warning. **Loading never throws** — a
  bad orchestration file must not take the boot with it.
- **Writes** are a unique `wx` temp then `renameAtomicSync` (the fs-atomic guard applies), coalesced
  over 50 ms, one in flight, latest snapshot wins; `flushAllDurableFactsSync()` runs on the desktop's
  second `before-quit` pass, `hookServer.stop()` flushes the ledger, and the Server Edition's
  canvas-control `stop()` disposes its three files (queue, reports, holds). A **crash** inside the
  50 ms window loses that window. **A sync flush is never overwritten by an older async write**
  (review of #1054, reproduced: `save([1])`, `flush()`, `save([2])`, `flushSync()` left `[1]` on
  disk): `flushSync` bumps a generation, and the async path checks it and renames in ONE synchronous
  step, dropping its temp when stale.
- **Every owner budgets its bytes under the 16 MB load limit**, because a file past it is set aside
  WHOLE (reproduced in review: 80 queued 250K-char bodies wrote 20 MB and 0 of 80 came back). The
  queue writes full entries up to 8 MB of JSON and the rest REDUCED (no body, short fields only —
  `bodyOmitted`, which restore turns into an expiry the sender hears about); the ledger writes
  replies up to 8 MB and the rest as UNKNOWN rows (still refused, never re-run).
- **Only the instance that owns the hook endpoint owns the facts.** The ledger is loaded by
  `hookServer.start()`, which fails for a second instance; the queue, reports and holds follow the
  same rule (`standDown()` when `startForApp()` returned a warning — desktop `main/index.ts`, Server
  Edition `ownsDurableState`), so a second instance on the same userData neither expires messages
  the live one holds nor overwrites its files.
- **The desktop queue restore waits for the workspace INDEX** (`restoreDeliveryQueue(…, {ready:
  workspaceStore.load({sideline:false})})`): an entry that lapsed during the downtime is expired
  there, and its sender leg resolves the sender's project and board log through the index, which
  nothing else has loaded at that point of boot (review of #1054: the expiry otherwise reached only
  the in-memory trace ring). The Server Edition already awaited the load before canvas control.
- **Measured** (this Linux dev host, the ledger at its 4096-row cap with realistic open replies):
  377 bytes a row, a 1.5 MB file, 11.5 ms per full write, 16.6 ms to load at boot; a 20-row ledger
  writes in 0.41 ms. The queue is bounded far lower (16 per target), the reports at 1000.
- **Boot order is load-bearing** (desktop `main/index.ts` right after `initAgentStatusMirror()`;
  Server Edition inside `initServerCanvasControl`, which runs after the mirror): station reports
  first — their session check reads the restored mirror — then the hand-over holds, then the
  delivery queue, whose restore
  replays a `queued` hand-over per waiting message (so "work pending" is REBUILT from the queue, not
  stored twice) and settles, without landing, every message that lapsed while the app was down (which
  withdraws the station's report exactly like an in-run expiry).

What a restart MEANS, per fact — decided beside each fact, stated in its header:

- **Queued message** (`core/agents/delivery-queue.ts`, `QUEUE_FACT`):
  - **The TTL keeps running while the app is down** (deadline = `enqueuedAt + ttlMs`, wall clock). A
    message whose deadline passed is EXPIRED at restore — traced `expired`, the sender told through
    `onExpired` — never delivered late and never dropped in silence. The rest re-arm with the time
    they have LEFT (a clock that went backwards cannot stretch one past a full TTL).
  - **Same session only.** At enqueue the target's agent + session id are recorded from the status
    mirror (`bindingOf`). A RESTORED entry flushes only when the target's current session and agent
    are the recorded ones (`restoredBindingVerdict`): a different one — respawn, `/clear`, another
    agent in the pane — ends it `targetGone` with nothing typed; an entry with no recorded session is
    refused the same way; a target that has not named a session yet WAITS (TTL running). In-run
    entries are unchanged.
  - **The whole gate chain still runs at flush.** Consequence to know: after an app restart where tmux
    survived, pane ownership is unproven (`pane-ownership.ts` records only on a fresh spawn), so the
    first flush is refused `notPermitted` and the sender is TOLD — still strictly better than the
    silent loss it replaces. After a machine reboot the cold-restored pane is a fresh spawn, so a
    message for a session that resumed under its old id delivers. The Server Edition's creator
    ledger is process-local too, so a restored message there is refused `caller-not-owner`.
  - **Never replayed into a pane**: a board comment (only the local user, typing in THIS app, may
    trigger one — a message read back off disk must not speak as a person) and an app-composed
    station notice; both, and a body over 256 KB (written without it), are expired at restore so
    their row / sender still hears the end. Not flushed at boot: the first flush waits for the
    target's next `done`.
  - Threat model, stated: the file is as trustworthy as the per-node token files beside it — a
    same-user process can write either. A forged `send` entry still runs every gate at flush.
- **Station report** (`core/station-outcome-store.ts`, `OUTCOME_FACT`): stored with the station's
  session + agent (`sessionOf`). At load a report whose recorded session or agent differs from what
  the restored mirror now says for that node is dropped; afterwards a `SessionStart` naming a
  different session or agent withdraws it — in-run too, since a report is about a task in one
  conversation (a child's session event, `subagentType`, never counts). An unknown side keeps it. The
  withdrawal runs in `emitAgentStatus` BEFORE the renderer hears the event, so no dependent can fire
  on the stale report in between.
- **Hand-over hold** (`core/station-handover.ts`, `HANDOVER_FACT`, the plain-`--after` fact from
  #1052): the HOLDING stations are stored (`handedAt`, the current turn's start and state, the
  background flag); `queued` is rebuilt from the queue's replay. Times are wall clock, so a turn that
  began before the restart but after the hand-over still ends the hold. Hook events are lost while
  the app is down, so a turn that ended during the downtime is not seen and the hold lasts until the
  next turn end (holding direction; ▶ / `run`). Not bound to a session: a respawned station still
  owes the work it was handed. Loaded after the reports and before the queue.
- **Request ledger** (`core/control-request-ledger.ts`, `CONTROL_REQUEST_FACT`, owned by the hook
  server's route): settled rows replay; a row in flight at shutdown (or a crash) comes back UNKNOWN —
  refused, never re-run, and nothing can settle it any more because its late answer died with the
  old process; a reply over 64 KB is written as UNKNOWN rather than dropped (a missing row would let
  the retry run).
- **Delivery is at most once across a crash:** a flush writes the entry OFF disk before its
  attempt (claim before effect), so a crash mid-delivery loses that one message rather than typing
  it twice after the next boot. Lapsed entries at restore are never inserted into the live lists
  (so no flush can deliver one while the expiries are reported) and take no capacity slot.

# SSH: keep the master alive, and resync agent state after a reconnect

Date: 2026-08-09
Status: design, approved for planning

## Problem

Switch away from an SSH project, come back later, and the connection banner has been through
`connecting`. The remote work itself is fine — the remote tmux session never stopped — but the
user cannot tell whether the agent running there **finished or not**.

That is not a UI gap. It is a real loss of information:

- Hook events are fire-and-forget POSTs through the reverse tunnel (`ssh -R`, set up in
  `SshProjectManager.connect` → `setup()`, src/main/remote-ssh/ssh-project.ts:484-519). The tunnel
  dies with the master. Nothing on the host queues the events, so any event that fires while the
  tunnel is down is **gone for good**.
- The completion notification is triggered by exactly that lost event, so it never arrives.
- The node stays `working` for `WORKING_STALE_MS` (20 minutes, src/shared/agents/stale.ts) on every
  surface: canvas badge, notch capsule, phone. Then `sweepStaleWorking` fires a synthetic end edge.
  That edge is **inferred from silence**, not from a real completion — "finished", "waiting on a
  permission prompt", and "the CLI died" all collapse into the same answer 20 minutes late.

Two independent causes put us in that state:

1. **Self-inflicted teardown.** Leaving a project's tab unmounts its terminals → the renderer parks
   them for `TERM_PARK_MS` (5 min, src/renderer/nodes/TerminalNode.tsx:260) → the PTY is killed →
   no client rides the master → `ControlPersist=300` (src/core/remote-ssh/control-master.ts:63)
   ends the master ~5 minutes later, and the hook tunnel with it.
2. **Real network loss.** `ServerAliveInterval=15` × `ServerAliveCountMax=4` ends the master after
   ~60s of silence (sleep/wake, Wi-Fi change, host reboot). No client-side policy can prevent this.

Cause 1 is ours to remove (Part C). Cause 2 is not, so the information loss has to be repaired
after the fact (Part A). Part A is the load-bearing half: it is the only one that helps in the case
the user actually notices, which is when the banner says `connecting`.

## Non-goals

- **No host-side event queue.** Making the hook script spool undelivered events on the host and
  replay them on reconnect ("option B") is the only way to lose literally nothing. It is
  deliberately out of scope: it needs delivery ordering, idempotency, and a spool lifecycle in a
  shell script that runs in every remote agent session. Part A gets the user the answer they want
  (did it finish?) without any of that.
- **No repair across an app restart.** The candidate list is `agentStatusMirror.workingNodes()`, and
  the mirror's state map is in-memory only (`src/core/agent-status-mirror.ts`, the `state` Map), so
  after a relaunch nothing is `working` and the resync is a no-op — an agent that finished while the
  app was down is never rescued by it. That is consistent rather than wrong (the renderer's badge is
  equally empty after a restart, so no surface is showing a stale `working` to contradict), and
  fixing it would mean persisting believed-working nodes across restarts and then trusting that
  file — a decision this part deliberately does not take.
- **No change to the 20-minute stale sweep.** It stays as the last-resort safety net, unchanged.
- **No new UI.** The existing badge / notch row / notification are the whole surface.

## Part C — keep the master alive

### Open measurement (first step of implementation)

The 45s watchdog (`MASTER_WATCHDOG_MS`, ssh-project.ts:114) already walks **every** cached
connection — not just the active project — and runs an idempotent `connect()`, which for a healthy
master is one multiplexed `ssh -O check`.

Whether that is already a keepalive depends on one fact nobody here has measured: **does `ssh -O
check` reset the master's `ControlPersist` idle timer?**

Measure it before writing any code, against a real host:

```sh
ssh -M -N -f -o ControlPersist=10 -o ControlPath=/tmp/cm.sock <host>
for i in $(seq 6); do sleep 4; ssh -o ControlPath=/tmp/cm.sock -O check <host>; done
```

Six checks 4s apart span 24s, well past a 10s `ControlPersist`. All six answering means the timer
is reset; the first failure after ~10s of quiet means it is not.

If every check answers, the timer is being reset and **Part C requires no code** — background
masters already survive as long as the app runs, and every drop the user sees is cause 2, which
only Part A addresses. Record the result in the implementation plan either way; it decides whether
the rest of this section is built at all.

### If the timer is not reset

Add a real multiplexed client to the watchdog tick: run a trivial command (`true`) over the
project's control path alongside the existing `-O check`. One mux'd exec per host per 45s is
negligible next to what a single attached terminal does, and it resets the idle timer by
definition, because it is a session.

**Do not raise `ControlPersist` to `yes`.** The current 300 is what makes an orphaned master from a
crashed app self-clean in five minutes; `yes` would leave one immortal `ssh` process per host after
every crash. `connect()`'s orphan-reuse branch handles a live orphan, but it should not have to
handle an immortal one.

Scope: connected SSH projects only, while the app is running. `disconnectAll()` on quit is
unchanged.

## Part A — resync agent state after a reconnect

### Trigger

In `SshProjectManager.connect()`, immediately after `setup()` returns a **verified**
`hookEndpointPath` (ssh-project.ts:519) — verification is what proves the reverse tunnel actually
reaches this app run, so it is the earliest point at which a repair is meaningful.

Only on a genuine re-establish. A `connect()` that took the reuse branch (`-O check` confirmed a
live master) never lost a tunnel and must not trigger a resync.

### Scope

The nodes of that project which the mirror currently reports as `working`, and nothing else.

This asymmetry is deliberate. A node stuck in `working` is the harmful state: it is silent, it
blocks the notification, and it persists for 20 minutes. The opposite error — a node we believe
idle that is really working — is self-correcting within seconds, because hook events fire
continuously through a turn.

### Deciding whether a node is still working

Two signals, cheapest first, per candidate node:

1. **Pane occupant** (`pty:pane-command`, `#{pane_current_command}` over the project's
   ControlMaster — the same probe `terminal/agent-restart.ts` polls). A shell owns the pane ⇒ the
   agent CLI exited ⇒ definitely not working. Decisive, one round trip.
2. **Transcript tail**, only when the CLI still owns the pane (which cannot distinguish "mid-turn"
   from "finished, waiting for input"). Locate the session's transcript on the host with the
   existing `core/remote-transcript-locate.ts` (path jailed by `isSafeRemoteTranscriptPath`), read a
   bounded tail over the master, and parse it with the existing claude JSONL parser in
   `core/context-link-render.ts`:
   - last record is a closed assistant message ⇒ the turn ended;
   - last record is a `tool_use` with no result ⇒ still working;
   - anything else, unparseable, or a failed read ⇒ **undecided**.

**Undecided changes nothing.** The node stays `working` and the 20-minute sweep remains its
backstop. This is what keeps a long-running tool call (Claude's Bash tool reaches ~10 minutes with
no transcript writes) from being declared finished by mistake. A resync only ever speaks when it is
sure.

A failed read is undecided, never "finished" — the same rule the worktree code follows: a failed
git read is not evidence of absence.

### Output

For each node decided as ended, synthesize one normalized event and push it through the existing
single funnel `emitAgentStatus` (src/main/index.ts:1384), which already fans to the renderer's
`agentStatus` store (canvas badge + completion notification), the mirror (phone), and the notch HUD:

```ts
{ nodeId, agentId, kind: 'state', state: 'done', idle: true, sessionId }
```

`idle: true` is the existing rescue-signal flag (src/shared/agents/normalize.ts:15-19): a `done`
carrying it **may only move a node that is still `working`**. That is exactly the guarantee this
feature needs, and it comes for free — a node sitting at `blocked` on a permission prompt cannot be
cleared by a resync.

Reusing `emitAgentStatus` also means no new mirror API and no new IPC channel.

### Result

When the banner leaves `connecting`, the badges are correct within one round trip instead of up to
20 minutes, and the completion notification the user missed is delivered at that moment.

## Three surfaces

- **Desktop (Electron)** — the whole feature. Both parts live in `src/main/remote-ssh` +
  `src/core`, driven by the existing manager.
- **Server Edition** — N/A. SSH projects are unsupported there (no ControlMaster manager,
  src/server/index.ts:286). Nothing to degrade.
- **Mobile companion** — inherits the fix with no work in `~/projects/nodeterm-ios`: the phone reads
  the mirror, and the resync writes through the same funnel every other status event uses.

## Testing

- **Pure decision function** (unit): pane occupant × transcript tail → `ended | working |
  undecided`. Cover the long-tool-call case (unclosed `tool_use` ⇒ working), the failed/unparseable
  read (⇒ undecided), and a shell-owned pane (⇒ ended). This is where the logic lives; keep it free
  of ssh and Electron.
- **Trigger gating** (unit, against the existing `SshProjectManager` fakes): resync runs after a
  verified re-establish, and does **not** run on the `-O check` reuse branch.
- **Event shape** (unit): a decided node emits exactly one `state:'done', idle:true` event per
  node through the injected emitter; an undecided node emits nothing.
- **Keepalive** (only if the measurement says it is needed): the watchdog tick issues the extra
  mux'd command per connected project, and an empty `conns` map stays a no-op.
- Manual: switch away from an SSH project running an agent, kill the master by hand
  (`ssh -O exit`), let the agent finish while disconnected, switch back — the badge clears and the
  notification fires on reconnect rather than 20 minutes later.

## Risks

- **The measurement may make Part C empty.** That is a fine outcome, not a failure: it would mean
  the drops are all cause 2 and Part A is the entire fix.
- **The transcript-tail heuristic is a heuristic.** Mitigated structurally: it can only ever move a
  node OFF `working`, undecided is the default, and any later hook event overrides it immediately.
- **Extra remote round trips on reconnect.** Bounded by the number of `working` remote nodes in one
  project, once per re-establish. Reconnect already does several remote round trips in `setup()`.

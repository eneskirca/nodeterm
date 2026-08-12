# Background-Task Guard for Eco Hibernation and Bulk Restart — Design

**Date:** 2026-08-12 · **Status:** approved by enes (scope + approach A) · **Follow-up to:** PR #130 (agent hibernation)

## Problem

Both Eco hibernation (opt-in, PR #130) and the bulk "Restart idle agents" action end an agent CLI by typing its exit command. A Claude Code **background shell task** (`Bash` with `run_in_background: true`) runs inside that CLI process and dies with it — silently lost work. Every other hazard has a guard (subagents, loop/cron, working/blocked); background shells are the one signal-less gap, because they produce no hook events while running and no subagent card. The window is real: a background task that runs >30 minutes with no other activity makes its node look exactly like Eco's target profile (done, offscreen, idle).

## Decision record

- **Scope (user decision):** Eco hibernation + bulk restart are guarded. The single-node "Restart agent (resume)" is deliberately untouched — the user clicks that node knowingly.
- **Approach (user decision, option A):** hook stamp + clear-on-turn. Alternatives rejected: process-tree inspection at fire time (every claude has MCP-server children — false positive on all nodes, guard would disable Eco), and transcript completion-sniffing (correct model, disproportionate machinery; the fallback if A proves insufficient).
- **Bulk-restart accounting (controller decision):** background-task skips are counted in the existing `skipped.working` bucket. The summary line is spec-frozen at four parts (see `agent-restart.ts` comments), and `'working'`'s documented meaning — "busy, try again in a moment" — is exactly what a live background task is.

## Design

### 1. Signal — `src/shared/agents/normalize.ts` (Claude only)

In `normalizeClaude`'s `PreToolUse` branch: `tool_name === 'Bash' && tool_input.run_in_background === true` emits a new `NormalizedAgentEvent` kind **`background-task`** (carrying the node id, like the recurring events). The Claude payload type gains `run_in_background?: boolean` under `tool_input`.

Claude-only in v1: the codex/gemini/grok dialects carry no equivalent field, and the house rule (CLAUDE.md "Adding a new agent" #7) is a closed set — no speculative widening. Their behavior stays byte-identical. A background task launched by a Claude *subagent* fires the same hook with the same node id, so protection extends there automatically — the safe direction.

Both shells get this for free: normalize is shared, and the raw listeners forward whole events.

### 2. Store — `src/renderer/state/agentStatus.ts`

Transient `backgroundTaskAt?: number` per node. **Not persisted** — same rationale as `lastEventAt`: after an app relaunch Eco is structurally inert until the node takes a turn, so a persisted stamp would only assert staleness with confidence.

- **Set:** Canvas's `agent:status` listener stamps `Date.now()` on a `background-task` event (a dedicated store action in house style, bail-when-unchanged not needed — re-stamping on every launch is correct).
- **Clear:** in `setState`'s transition branch, only at a turn **START** — `done` → `working`, and nothing else. `blocked`/`waiting` → `working` is a mid-turn resumption and KEEPS the stamp; so does `undefined` → `working`, because an unknown previous state is reachable mid-turn (a renderer reload starts with an empty table; `sweepStaleWorking` blanks a working entry) and is therefore no evidence of a turn start. Rationale: a background task's completion queues a `<task-notification>` into the parent transcript, which re-invokes the agent — a turn starts — `working` fires. Clearing on `done` would be wrong: a turn can end while the task still runs. And clearing on *every* `working` transition would be wrong too: a background `Bash` whose command needs approval runs UserPromptSubmit(working) → PreToolUse(stamp) → PermissionRequest(blocked) → approve → PostToolUse(working), so the resumption edge would clear the stamp milliseconds after it was set, for exactly the task this guard exists for.

### 3. Consumers

- **Eco:** `buildHibernationCandidates` gains a **required** `liveBackgroundTask: boolean` field (`backgroundTaskAt !== undefined`), and `planHibernation` excludes it. Required-field discipline per the `remote` precedent: typecheck forces every call site, an omission can never read as "no task".
- **Bulk restart:** `planBulkRestart`'s `BulkRestartCandidate` gains `backgroundTask: boolean`; a true value is counted as `skipped.working` (frozen four-part summary unchanged). Canvas's bulk action feeds it from the store. `restartEligibility` itself is untouched (the single-node menu path must not change).

### 4. Edge cases (accepted, documented)

- **Concurrent background tasks:** the first completion's turn clears the stamp while a second task may still run. Mitigation: that same turn resets `lastEventAt`, so Eco waits another full idle window (30 min default) — the residual exposure is a second task still running >30 min after the first one's completion turn, with no further hook activity. Documented here and in the Eco device checklist; approach C (completion counting) is the named escalation if this bites in practice.
- **App relaunch:** stamp is gone (transient) — consistent, because Eco cannot act until a turn happens, and any turn's `working` would have cleared the stamp anyway.
- **A task reporting back while the node sits `waiting`/`blocked`:** the clear needs a turn START, so a `<task-notification>` that lands while the session holds a question open (`waiting`/`blocked` → `working` is a resumption) leaves the stamp in place until the turn after that. Bounded and in the fail-safe direction — and such a node is never a hibernation candidate anyway, since `planHibernation` requires `state === 'done'`.
- **Manual task kill without a turn:** the stamp stays until the next turn — the node simply isn't hibernated. Fail-safe direction (memory not reclaimed; work never killed).
- **A stamp set while the node's state is unknown** (renderer reload, or `sweepStaleWorking` having blanked the entry): since only `done` → `working` clears, the completing `<task-notification>` turn is a resumption from `undefined` and does NOT clear — the stamp survives until the turn AFTER that, i.e. the node's hibernation is deferred by one more turn. Accepted: the cost is memory reclaimed one turn late, whereas clearing on `undefined` would delete the guard for a task that is still running.

### 5. Testing

- Normalize: a `PreToolUse` Bash payload with `run_in_background: true` yields the event; without the field (or with `false`, or another tool) yields nothing — mutation-sensitive both ways.
- Store: stamp set on event; cleared on a turn start (`done` → `working`); NOT cleared on `done`/`waiting`, on a `blocked`/`waiting` resumption, or from an unknown state; never persisted (extend the existing persistence tests).
- Adapter/policy: `liveBackgroundTask` row in `hibernationCandidates` + exclusion row in `planHibernation` (the oldest-node-surfaces mutation pattern already used there).
- Bulk plan: a background-task candidate lands in `skipped.working` and not in `runnable`.
- Device checklist: appended as **item 8** to the tracked Eco list in `docs/superpowers/plans/2026-08-10-ram-optimization.md` (Phase 5, which has 7 items) — a node with a running background shell is not hibernated by an enabled Eco sweep; after the task completes and its turn runs, hibernation happens one idle window later.

### 6. Surfaces

Shared normalize + renderer store/policy: Desktop and Server Edition both covered with no shell-specific work. Mobile: N/A (no sweep on the phone).

## Out of scope

- Single-node restart guard (user decision).
- Non-Claude agents (no signal in their dialects).
- Completion sniffing / task counting (escalation path, not v1).
- Any UI surface for "why didn't this node hibernate" (YAGNI).

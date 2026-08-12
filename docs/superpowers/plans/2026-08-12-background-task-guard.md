# Background-Task Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live Claude Code background shell task (`Bash` with `run_in_background: true`) protects its node from Eco hibernation and from the bulk "Restart idle agents" action — closing the one signal-less `/exit`-kills-work gap left by PR #130.

**Architecture:** Approved spec: `docs/superpowers/specs/2026-08-12-background-task-hibernation-guard-design.md` (on disk beside this plan; force-add BOTH files in this PR — `/docs/superpowers/` is gitignored, plans/specs ride feature PRs by convention). Approach A: normalize emits a `background-task` event from Claude's `PreToolUse` (replacing the generic "working" for that one call — harmless, the turn is full of other working events); `agentStatus` stamps transient `backgroundTaskAt`, cleared only at a **turn START** (`done`/`undefined` → `working`; a `blocked`/`waiting` → `working` resumption keeps it — see the spec's §2); `planHibernation` and `planBulkRestart` exclude stamped nodes (bulk counts them in the frozen `skipped.working` bucket). Single-node restart untouched (user decision).

**Tech Stack:** TypeScript, vitest. Two tasks, one PR.

## Global Constraints

- Branch off **origin/main** in a worktree; anchors below were read from origin/main on 2026-08-12 (`git show origin/main:<path>` — the main checkout is stale and belongs to a parallel session; NEVER commit there).
- Gates per task: `npm run typecheck` + the named vitest files; full `npm test` before the PR.
- English code/comments, constraint-style; CLAUDE.md rule 7 (closed sets — claude-only signal, no speculative widening) and rule 2 (grep what else a list/type gates before joining it).
- `agent-restart.test.ts` pre-existing tests must stay green **unmodified** (the Task 8 pin discipline).
- The bulk summary line is spec-frozen at four parts — background-task skips land in `skipped.working`, never a fifth part.

---

### Task 1: Signal + store (normalize event, agentStatus stamp/clear, Canvas wiring)

**Files:**
- Modify: `src/shared/agents/normalize.ts` (kind union at `:10`; `ClaudePayload.tool_input` type at `:92`; the claude `PreToolUse` branch — insert BEFORE the `// Any other tool use is just "working".` fallback)
- Modify: `src/renderer/state/agentStatus.ts` (transient field + action + clear in `setState`'s transition branch)
- Modify: `src/renderer/canvas/Canvas.tsx` (the `agent:status` listener — add a case beside the `recurring` handling; grep `kind === 'recurring'`)
- Test: `src/shared/agents/normalize.test.ts` (extend), `src/renderer/state/agentStatus` test files (extend the persistence + setState suites; grep `agentStatus.persist.test.ts` / `agentStatus-session.test.ts` for the house harness)

**Interfaces:**
- Produces: `NormalizedAgentEvent.kind` gains `'background-task'`; `useAgentStatus` gains `backgroundTaskAt?: number` (transient) and action `markBackgroundTask(id: string): void`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing normalize tests**

```ts
// in normalize.test.ts, beside the existing claude PreToolUse cases (match the file's envelope helper)
it('claude PreToolUse Bash with run_in_background=true is a background-task event', () => {
  const e = normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: {
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'sleep 999', run_in_background: true }
  }})
  expect(e?.kind).toBe('background-task')
})
it('foreground Bash, false/absent flag, PostToolUse, and other tools stay generic working', () => {
  for (const payload of [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: false } },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: true } },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { run_in_background: true } }
  ]) {
    const e = normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload })
    expect(e?.kind).toBe('state')
    expect(e?.state).toBe('working')
  }
})
```

(Adapt the call shape to the file's existing helpers — it may wrap payloads. The four negative rows are the mutation guard: a `tool_name` check dropped, an `ev` check dropped, or a truthiness check instead of `=== true` each flips one row.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/shared/agents/normalize.test.ts` — the first test fails (`kind` is `'state'`).

- [ ] **Step 3: Implement the normalize branch**

`kind` union (`:10`): add `'background-task'`. `ClaudePayload.tool_input` (`:92`): add `run_in_background?: boolean`. In the claude `PreToolUse|PostToolUse` block, directly before the `// Any other tool use is just "working".` line:

```ts
    // A background shell task lives INSIDE the CLI process: /exit kills it silently. This event
    // is the stamp Eco hibernation and the bulk restart exclude on (see hibernation-policy /
    // planBulkRestart). PreToolUse only, and `=== true` — an absent or false flag is a foreground
    // command, which the generic "working" below already covers. Claude-only: no other dialect
    // carries the field (closed set, CLAUDE.md agent rule 7).
    if (ev === 'PreToolUse' && tool === 'Bash' && p.tool_input?.run_in_background === true) {
      return { ...base, kind: 'background-task' }
    }
```

- [ ] **Step 4: Run** — normalize tests PASS.

- [ ] **Step 5: Write the failing store tests**

In the agentStatus suite (match its store-reset harness):

```ts
it('markBackgroundTask stamps; only a transition TO working clears it', () => {
  const s = useAgentStatus.getState()
  s.setState('n1', 'done', 'claude')
  s.markBackgroundTask('n1')
  expect(useAgentStatus.getState().byId['n1']?.backgroundTaskAt).toBeTypeOf('number')
  s.setState('n1', 'waiting', 'claude') // done -> waiting: NOT cleared
  expect(useAgentStatus.getState().byId['n1']?.backgroundTaskAt).toBeTypeOf('number')
  s.setState('n1', 'working', 'claude') // -> working: cleared
  expect(useAgentStatus.getState().byId['n1']?.backgroundTaskAt).toBeUndefined()
})
it('backgroundTaskAt is never persisted', () => {
  // extend the existing "never written" persistence assertions (lastEventAt/stateAt pattern)
})
```

- [ ] **Step 6: Implement the store**

`backgroundTaskAt?: number` on the entry type with a comment (transient — same rationale as `lastEventAt`: after a relaunch Eco is inert until a turn, and any turn's `working` would have cleared it). `markBackgroundTask(id)` in house action style (stamp `Date.now()`, no save — transient). In `setState`'s transition branch, beside the hibernated self-heal: `if (state === 'working') delete entry.backgroundTaskAt` (or set undefined, matching the file's idiom) — comment: a turn start follows the completed task's `<task-notification>`; clearing on `done` would drop the guard while the task still runs.

- [ ] **Step 7: Wire Canvas** — in the `agent:status` listener, beside the `recurring` case: `if (e.kind === 'background-task') { cs.markBackgroundTask(e.nodeId); return }` (match the listener's local naming). No re-render concern: the store write touches one entry and nothing subscribes to `backgroundTaskAt` reactively.

- [ ] **Step 8: Gates + commit**

`npx vitest run src/shared/agents/normalize.test.ts src/renderer/state && npm run typecheck`
Commit: `feat(agents): background-task hook signal + transient stamp` + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 2: Consumers (hibernation exclusion + bulk-restart skip) + spec/plan force-add

**Files:**
- Modify: `src/renderer/lib/hibernationCandidates.ts` (`HibernationStatusInput` + candidate assembly), `src/renderer/terminal/hibernation-policy.ts` (required field + exclusion), `src/renderer/terminal/agent-restart.ts` (`BulkRestartCandidate` + `planBulkRestart`), `src/renderer/canvas/Canvas.tsx` (both feeds: the sweep's status narrowing + the bulk action's candidate build — grep `planBulkRestart(`)
- Test: `src/renderer/lib/hibernationCandidates.test.ts`, `src/renderer/terminal/hibernation-policy.test.ts`, `src/renderer/terminal/agent-restart.test.ts` (ADDITIONS ONLY — zero deletions)
- Add to git: `docs/superpowers/specs/2026-08-12-background-task-hibernation-guard-design.md` + this plan (`git add -f`, both live on disk in the stale main checkout — copy them into the worktree first)

**Interfaces:**
- Consumes: Task 1's `backgroundTaskAt`.
- Produces: `HibernationCandidate.liveBackgroundTask: boolean` (required); `BulkRestartCandidate.backgroundTask: boolean` (required — typecheck forces the call sites, per the `remote`/`liveBackgroundTask` precedent).

- [ ] **Step 1: Failing tests, all three files**

```ts
// hibernation-policy.test.ts — the oldest-node-surfaces mutation pattern used by every exclusion row
it('never hibernates a node with a live background task', () => {
  expect(planHibernation([base('a', { liveBackgroundTask: true, lastEventAt: 0 })], NOW, cfg)).toEqual([])
})
// + add liveBackgroundTask: false to base() so every existing fixture still compiles

// hibernationCandidates.test.ts
it('liveBackgroundTask mirrors backgroundTaskAt presence', () => {
  // statusById: { a: { ...done..., backgroundTaskAt: 123 }, b: { ...done... } }
  // expect candidate a.liveBackgroundTask true, b false
})

// agent-restart.test.ts (append only)
it('bulk restart files a background-task node under the working skips', () => {
  const plan = planBulkRestart([
    { id: 'a', agentId: 'claude', state: 'done', sessionId: 's1', wired: true, backgroundTask: true },
    { id: 'b', agentId: 'claude', state: 'done', sessionId: 's2', wired: true, backgroundTask: false }
  ])
  expect(plan.runnable).toEqual(['b'])
  expect(plan.skipped.working).toBe(1)
})
```

- [ ] **Step 2: Run to verify failures** (type errors on the new required fields count as the red).

- [ ] **Step 3: Implement**

- `HibernationStatusInput` += `backgroundTaskAt?: number` (doc comment: the third safety fact this adapter exists for — see the header's pattern); candidate assembly: `liveBackgroundTask: st?.backgroundTaskAt !== undefined`.
- `HibernationCandidate` += required `liveBackgroundTask: boolean`; conjunction gains `!c.liveBackgroundTask` with a header sentence (a background shell dies with the CLI; no hook fires while it runs, so the stamp is the only signal).
- `BulkRestartCandidate` += required `backgroundTask: boolean`; in `planBulkRestart`, AFTER the eligibility gate and BEFORE the wired check: `if (c.backgroundTask) { plan.skipped.working++; continue }` — comment: counted as `working` ("busy, try again in a moment" — exactly what a live background task is), because the summary line is frozen at four parts. A not-resumable background-task node stays uncounted, as today.
- Canvas: the sweep's `statusById` narrowing passes `backgroundTaskAt` through; the bulk action's candidate build adds `backgroundTask: !!st?.backgroundTaskAt`.

- [ ] **Step 4: Gates**

`npx vitest run src/renderer/lib src/renderer/terminal src/renderer/state src/shared && npm run typecheck` — and verify `git diff --numstat` on `agent-restart.test.ts` shows **0 deletions**.

- [ ] **Step 5: Force-add the docs + commit + PR**

```bash
git add -f docs/superpowers/specs/2026-08-12-background-task-hibernation-guard-design.md docs/superpowers/plans/2026-08-12-background-task-guard.md
git add <code files>
git commit -m "feat(renderer): exclude background-task nodes from Eco and bulk restart" # + Co-Authored-By
```

PR body must include: the concurrent-tasks accepted edge (first completion's turn clears the stamp; mitigated by the idle-window reset), claude-only rationale, the frozen-four-parts accounting decision, and the new device-checklist item 9 (a node with a running background shell is not hibernated; after the task completes and its turn runs, hibernation happens one idle window later).

---

## Out of scope (spec §Out of scope)

Single-node restart guard; non-Claude agents; completion sniffing (named escalation: approach C); any "why didn't this hibernate" UI.

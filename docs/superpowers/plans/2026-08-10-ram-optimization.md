# RAM Optimization Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut nodeterm's marginal memory cost per terminal/agent node — silently where invisible, behind conservative defaults where barely perceptible, and opt-in where the user would feel it — following the herdr ("invisible things render nothing") and cmux ("session alive, renderer reclaimable") patterns documented in the 2026-08-10 RAM research (artifact `a330c1cf`, memory `ram-optimization-research.md`).

**Architecture:** Five independently shippable phases, one PR each. Phase 1: invisible caps (subagent-tail read cap, parked-terminal LRU cap). Phase 2: offscreen terminal dispose (auto "refresh-terminal" on approach — tmux already owns the state). Phase 3: memory-pressure responder chain in core, wired to existing reclaim levers. Phase 4: browser/web node "Memory Saver" (discard hidden webviews, restore from URL). Phase 5 (opt-in): agent hibernation — exit the idle CLI, resume on demand, reusing the agent-restart machinery.

**Tech Stack:** TypeScript (Electron main + core + React renderer), vitest, tmux. No new dependencies.

## Global Constraints

- **Concurrent sessions edit this repo.** Before every task: `git fetch origin && git switch -c <branch> origin/main` (branch off origin/main, never the checked-out branch), and diff any file you're told to modify before editing — line anchors in this plan were read at commit `76f4a56` and may have drifted.
- Verification gates per task: `npm run typecheck` (fastest) and the named vitest file. Full `npm test` before each PR.
- Code comments, UI strings, identifiers: **English**. Chat with the user: Turkish. PR titles/bodies: English.
- `src/core` must not import `electron` or `../main/*` (enforced by `src/core/no-electron.test.ts`). New service logic goes in `src/core` behind `CorePlatform` so the Server Edition gets it too.
- Three surfaces rule: every task states its Desktop / Server Edition / Mobile behavior, even when the answer is N/A.
- **Never auto-inject text into a user's terminal without opt-in** (user preference, memory `no-auto-inject-prompts`). Phase 5 writes `/exit` + resume lines into panes — that is why Phase 5 is opt-in and gated on the existing `restartEligibility` (never `working`/`blocked`).
- Do NOT touch: tmux mouse/scroll ownership, the park→re-adopt fidelity for *visible* nodes, `onlyRenderVisibleElements` (React Flow virtualization is explicitly out of scope — it would unmount → park-storm; Phase 2 achieves the same goal without unmounting).
- Defaults ship as agreed with the user: Phases 1–3 silent default-on; Phase 4 default-on with conservative thresholds; Phase 5 default-off (opt-in setting).

---

## Phase 1 — Invisible caps (one PR)

### Task 1: Cap subagent-tail reads at 1 MB per tick

The one tail without a read cap: `src/core/subagent-tail.ts:178` allocates `size - offset` in a single `Buffer.alloc` — the whole transcript on the first tick, any burst delta whole. `context-tail.ts` has `INITIAL_READ_CAP = 1024 * 1024` for exactly this; mirror it. Chunked reads are safe here because the tail is offset-based: reading less just means the next 400 ms tick continues where this one stopped.

**Files:**
- Modify: `src/core/subagent-tail.ts` (the `readOne` function, currently lines 176–190)
- Test: `src/core/subagent-tail.test.ts` (extend if it exists — check with `ls src/core/subagent-tail.test.ts` — else create)

**Interfaces:**
- Produces: exported `SUBAGENT_READ_CAP = 1024 * 1024` (exported for the test; no behavior consumers).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/subagent-tail.test.ts (add; if the file exists, append the describe block)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createSubagentTail, SUBAGENT_READ_CAP } from './subagent-tail'

describe('subagent-tail read cap', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads at most SUBAGENT_READ_CAP bytes per tick and continues next tick', async () => {
    // Real fs against a temp dir — the tail uses fs.promises directly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtail-'))
    const transcript = path.join(dir, 'session.jsonl')
    const subDir = path.join(dir, 'session', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'tu1' }))
    // One assistant line far larger than the cap: a single text block ~2.5 MB.
    const big = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x'.repeat(Math.floor(SUBAGENT_READ_CAP * 2.5)) }] }
    })
    fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), big + '\n')

    const chunks: string[] = []
    const tail = createSubagentTail((p) => chunks.push(p.chunk))
    tail.track('tu1', transcript)

    // Tick 1 resolves the meta + reads chunk 1 (≤ cap, no newline yet → all carried, nothing emitted).
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(400)
    // After enough ticks the full line has been consumed in ≤1 MB slices and emitted once.
    expect(chunks.join('')).toContain('xxx')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/subagent-tail.test.ts`
Expected: FAIL — `SUBAGENT_READ_CAP` is not exported (compile error), which is the missing piece.

- [ ] **Step 3: Implement the cap**

In `src/core/subagent-tail.ts`, add near the top (after imports):

```ts
/**
 * Per-tick read ceiling — the same discipline as context-tail's INITIAL_READ_CAP. Without it the
 * first tick after track() (or any burst) allocates the entire delta in one Buffer; a chunked
 * read just continues at the next 400 ms tick, offset-based, so nothing is lost.
 */
export const SUBAGENT_READ_CAP = 1024 * 1024
```

Replace the read block (currently):

```ts
      const size = (await fs.promises.stat(e.file)).size
      if (size <= e.offset) return
      const buf = Buffer.alloc(size - e.offset)
      const fd = await fs.promises.open(e.file, 'r')
      try {
        await fd.read(buf, 0, buf.length, e.offset)
      } finally {
        await fd.close()
      }
      e.offset = size
```

with:

```ts
      const size = (await fs.promises.stat(e.file)).size
      if (size <= e.offset) return
      const len = Math.min(size - e.offset, SUBAGENT_READ_CAP)
      const buf = Buffer.alloc(len)
      const fd = await fs.promises.open(e.file, 'r')
      try {
        await fd.read(buf, 0, len, e.offset)
      } finally {
        await fd.close()
      }
      e.offset += len
```

Nothing else changes: `splitCompleteLines` already handles a chunk that ends mid-line via `carry`, and a capped read that ends mid-multibyte-char is the exact tear `carry` (raw bytes) was built for.

- [ ] **Step 4: Run the test + the existing suite for this file**

Run: `npx vitest run src/core/subagent-tail.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/subagent-tail.ts src/core/subagent-tail.test.ts
git commit -m "fix(core): cap subagent-tail reads at 1MB per tick, matching context-tail"
```

### Task 2: LRU count cap on parked terminals

`parkedTerminals` (`src/renderer/nodes/TerminalNode.tsx:259`) is time-bounded (5 min) but count-unbounded: visiting N projects within 5 minutes parks every terminal of each. Cap it at 12 entries, evicting the oldest park (insertion order = park order, and a re-park always deletes before re-inserting via `disposeParkedTerminal(termKey)` at `:2495`, so Map order IS park recency). Eviction is invisible: a disposed park means the next remount is a warm tmux reattach — the exact behavior every user already gets after the 5-minute window.

**Files:**
- Create: `src/renderer/terminal/park-budget.ts`
- Modify: `src/renderer/nodes/TerminalNode.tsx` (park entry creation, currently lines 2480–2500)
- Test: `src/renderer/terminal/park-budget.test.ts`

**Interfaces:**
- Produces: `PARK_MAX = 12`; `planParkEviction(keysInParkOrder: string[], max: number): string[]` (pure — returns the keys to dispose, oldest first).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/terminal/park-budget.test.ts
import { describe, it, expect } from 'vitest'
import { PARK_MAX, planParkEviction } from './park-budget'

describe('planParkEviction', () => {
  it('returns nothing at or under the cap', () => {
    expect(planParkEviction(['a', 'b'], 2)).toEqual([])
    expect(planParkEviction([], 2)).toEqual([])
  })
  it('evicts the oldest entries beyond the cap, oldest first', () => {
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })
  it('default cap is 12', () => {
    expect(PARK_MAX).toBe(12)
    const keys = Array.from({ length: 13 }, (_, i) => `k${i}`)
    expect(planParkEviction(keys, PARK_MAX)).toEqual(['k0'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/terminal/park-budget.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the pure policy**

```ts
// src/renderer/terminal/park-budget.ts
/**
 * Count cap for parked terminals (see TerminalNode's parkedTerminals). The park window
 * (TERM_PARK_MS) bounds each entry in TIME but nothing bounded the COUNT: switching through N
 * projects inside the window parked every terminal of each — each holding a full xterm buffer
 * with a live PTY subscription. Evicting the oldest park is invisible to the user: a disposed
 * park just means the next remount is a warm tmux reattach (tmux redraws), the same path every
 * remount after the 5-minute window already takes.
 *
 * 12 ≈ one busy project's worth of terminals; the same order of magnitude as WEBGL_BUDGET.
 */
export const PARK_MAX = 12

/** Keys to dispose so the park stays within `max`, oldest first. Caller passes keys in park
 *  order (Map insertion order — TerminalNode always deletes before re-inserting on re-park). */
export function planParkEviction(keysInParkOrder: string[], max: number): string[] {
  if (keysInParkOrder.length <= max) return []
  return keysInParkOrder.slice(0, keysInParkOrder.length - max)
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/renderer/terminal/park-budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the park path**

In `src/renderer/nodes/TerminalNode.tsx`: add to imports (near the other `./` / `../terminal` imports):

```ts
import { PARK_MAX, planParkEviction } from '../terminal/park-budget'
```

Then in the unmount cleanup where the park entry is stored — currently:

```ts
        disposeParkedTerminal(termKey) // defensive: never stack two entries for one node
        parkedTerminals.set(termKey, entry)
```

append directly after `parkedTerminals.set(termKey, entry)`:

```ts
        // Enforce the park count cap: evict the OLDEST parks (their next remount becomes a warm
        // tmux reattach — the post-window behavior, just earlier). Never the entry just parked.
        for (const k of planParkEviction([...parkedTerminals.keys()], PARK_MAX)) {
          if (k !== termKey) disposeParkedTerminal(k)
        }
```

- [ ] **Step 6: Typecheck + full renderer suite touchpoint**

Run: `npm run typecheck && npx vitest run src/renderer/terminal`
Expected: PASS (no existing test asserts unbounded parking).

- [ ] **Step 7: Commit + PR**

```bash
git add src/renderer/terminal/park-budget.ts src/renderer/terminal/park-budget.test.ts src/renderer/nodes/TerminalNode.tsx
git commit -m "feat(renderer): LRU count cap (12) on parked terminals"
```

Open the Phase 1 PR (both tasks). PR body notes: considered and **rejected** pausing PTY flow for parked terminals — `setFlow` pauses the session for ALL subscribers, so a kanban card modal co-viewing the same session would freeze; and parked buffer growth is already ring-bounded by xterm's 10k-line scrollback clamp.

**Surfaces:** Desktop + Server Edition both get Task 1 automatically (core). Task 2 is renderer-shared (desktop + browser). Mobile: N/A (no xterm instances).

---

## Phase 2 — Offscreen terminal dispose ("cmux kademe 2", one PR)

**Concept:** a terminal that has been fully offscreen for `OFFSCREEN_DISPOSE_MS` (default 10 min) has its xterm instance + PTY client torn down *in place* — the node stays mounted, the tmux session keeps running (state lives server-side, herdr-style), and the body shows a lightweight plate. When the node re-approaches the viewport (the visibility observer's existing 256px `rootMargin` pre-announce), the terminal respawns: a fresh PTY attach to the SAME tmux session — exactly what the existing "Refresh terminal" action and every post-park remount already do (warm attach: tmux redraws, seeds nothing, emits its own mode sequences). This is NOT the forbidden "respawn instead of park" for visible nodes — it applies only to nodes offscreen for many minutes, whose park-fidelity nobody is looking at.

**Files:**
- Create: `src/renderer/terminal/offscreen-policy.ts`
- Modify: `src/renderer/nodes/TerminalNode.tsx` (visibility observer region ~`:2395-2416`; mount effect head; body render), `src/shared/types.ts` (setting + default), `src/renderer/components/SettingsPage.tsx` (one row)
- Test: `src/renderer/terminal/offscreen-policy.test.ts`

**Interfaces:**
- Produces: `OFFSCREEN_DISPOSE_MS_DEFAULT = 10 * 60_000`; `offscreenDisposeMs(settingMinutes: number | undefined): number | null` (null = feature off); pure gate `mayDisposeOffscreen(i: { visible: boolean; remote: boolean; selected: boolean; parkedElsewhere?: boolean }): boolean`.
- New setting: `offscreenTerminalMinutes: number` in `Settings` (default `10`; `0` = off).
- Consumes: Phase 1's `disposeParkedTerminal` is NOT involved — this acts on the mounted instance.

### Task 3: Pure policy + setting

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/terminal/offscreen-policy.test.ts
import { describe, it, expect } from 'vitest'
import { OFFSCREEN_DISPOSE_MS_DEFAULT, offscreenDisposeMs, mayDisposeOffscreen } from './offscreen-policy'

describe('offscreen dispose policy', () => {
  it('default is 10 minutes; 0 disables; undefined falls back to default', () => {
    expect(OFFSCREEN_DISPOSE_MS_DEFAULT).toBe(600_000)
    expect(offscreenDisposeMs(undefined)).toBe(600_000)
    expect(offscreenDisposeMs(10)).toBe(600_000)
    expect(offscreenDisposeMs(0)).toBeNull()
    expect(offscreenDisposeMs(-3)).toBeNull()
    expect(offscreenDisposeMs(2)).toBe(120_000)
  })
  it('never disposes a visible, selected, or remote terminal', () => {
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: false })).toBe(true)
    expect(mayDisposeOffscreen({ visible: true, remote: false, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: true, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: true })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/terminal/offscreen-policy.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/renderer/terminal/offscreen-policy.ts
/**
 * When to tear down an OFFSCREEN terminal's xterm+PTY client in place (node stays mounted; the
 * tmux session keeps running and re-attach redraws — same contract as the Refresh action and the
 * post-park remount). cmux's renderer-realization idea taken one level deeper: past this window
 * nobody has looked at the node for so long that reattach-redraw fidelity is indistinguishable
 * from park fidelity, and the buffer (up to ~16 MB full) is pure cost.
 *
 * REMOTE (SSH) nodes are excluded in v1: their spawn path runs the requireRemote/offline
 * machinery and a re-spawn while the ControlMaster is down would surface the offline overlay for
 * a node the user never touched. Follow-up once demand exists.
 */
export const OFFSCREEN_DISPOSE_MS_DEFAULT = 10 * 60_000

/** Setting is in minutes; 0 or negative = feature off; undefined = default. */
export function offscreenDisposeMs(settingMinutes: number | undefined): number | null {
  if (settingMinutes === undefined) return OFFSCREEN_DISPOSE_MS_DEFAULT
  if (!(settingMinutes > 0)) return null
  return Math.round(settingMinutes * 60_000)
}

export function mayDisposeOffscreen(i: {
  visible: boolean
  remote: boolean
  selected: boolean
}): boolean {
  return !i.visible && !i.remote && !i.selected
}
```

- [ ] **Step 4: Run test** — `npx vitest run src/renderer/terminal/offscreen-policy.test.ts` — PASS.

- [ ] **Step 5: Add the setting**

`src/shared/types.ts` — in the `Settings` interface (near `tmuxScrollback: number`, line ~832):

```ts
  /** Minutes a terminal may sit fully offscreen before its xterm+PTY client is torn down in
   *  place (tmux keeps the session; re-approach reattaches and redraws). 0 = never. */
  offscreenTerminalMinutes: number
```

and in `DEFAULT_SETTINGS` (line ~934+, near `tmuxScrollback: 50000`):

```ts
  offscreenTerminalMinutes: 10,
```

Run: `npm run typecheck` — expect errors ONLY if a settings-shape test pins the key list; fix by adding the key there too.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/terminal/offscreen-policy.ts src/renderer/terminal/offscreen-policy.test.ts src/shared/types.ts
git commit -m "feat(renderer): offscreen-dispose policy + offscreenTerminalMinutes setting"
```

### Task 4: Wire dispose + revive into TerminalNode

The mount effect is `useEffect(..., [data.respawnNonce])` (`TerminalNode.tsx:2511`). Mechanism: a local `offscreenEpoch` state joins the dep array; an `offscreenDown` flag makes the effect **skip spawning** while down. Going down = add `termKey` to `noParkIds` (so the cleanup DISPOSES instead of parking — `:2473` already honors `noParkIds.delete(termKey)`), then bump the epoch. Coming back = clear the flag, bump the epoch again → the effect re-runs and spawns fresh (warm tmux reattach).

- [ ] **Step 1: Read the current mount-effect head and visibility observer** (`sed -n '2340,2420p' src/renderer/nodes/TerminalNode.tsx` — anchors may have drifted; find `visibilityObserver` and the `rootMargin: '256px'` literal).

- [ ] **Step 2: Add state + refs near the component's other `useState`/`useRef` declarations**

```ts
  // Offscreen dispose (offscreen-policy.ts): while `offscreenDown` the mount effect skips
  // spawning and the body renders a plate; `offscreenEpoch` re-runs the effect on both edges.
  const [offscreenDown, setOffscreenDown] = useState(false)
  const offscreenDownRef = useRef(false)
  const offscreenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [offscreenEpoch, setOffscreenEpoch] = useState(0)
```

- [ ] **Step 3: Extend the visibility observer callback**

Inside the existing `visibilityObserver` callback (after the `wasVisible = visible` bookkeeping), add — using the node's existing remote detection (`data.ssh` / `data.sshRemoteTmux`; grep for how `isRemoteSessionNode` or equivalent is derived in this file and reuse that exact expression) and the `selected` prop:

```ts
        const disposeAfter = offscreenDisposeMs(useSettings.getState().settings.offscreenTerminalMinutes)
        if (!visible && disposeAfter !== null && !offscreenDownRef.current) {
          if (!offscreenTimerRef.current) {
            offscreenTimerRef.current = setTimeout(() => {
              offscreenTimerRef.current = null
              if (mayDisposeOffscreen({ visible: wasVisible, remote: isRemoteNode, selected: selectedRef.current })) {
                offscreenDownRef.current = true
                noParkIds.add(termKey) // cleanup must dispose, not park — parking would defeat the point
                setOffscreenDown(true)
                setOffscreenEpoch((n) => n + 1)
              }
            }, disposeAfter)
          }
        }
        if (visible) {
          if (offscreenTimerRef.current) {
            clearTimeout(offscreenTimerRef.current)
            offscreenTimerRef.current = null
          }
          if (offscreenDownRef.current) {
            offscreenDownRef.current = false
            setOffscreenDown(false)
            setOffscreenEpoch((n) => n + 1) // re-run the mount effect → fresh warm attach
          }
        }
```

Notes for the implementer: `selectedRef` — if the component doesn't already mirror the `selected` prop into a ref, add `const selectedRef = useRef(selected); selectedRef.current = selected`. `useSettings` is the settings zustand store already imported in this file (grep `useSettings` — it reads `settings.panHoverDelay` for the hover guard). Clear `offscreenTimerRef` in the observer-teardown cleanup (`:2418+`, beside `clearTimeout(resizeTimer)`).

- [ ] **Step 4: Gate the mount effect and add the epoch dep**

At the very top of the `useEffect` body that creates the terminal (the one ending with the park cleanup):

```ts
    if (offscreenDownRef.current) return // offscreen-disposed: no spawn until re-approach
```

and change its dep array from `[data.respawnNonce]` to `[data.respawnNonce, offscreenEpoch]` (keep the eslint-disable line).

- [ ] **Step 5: Render the plate**

In the body JSX, where the xterm container div renders, add a sibling shown only when down (reuse the offline-overlay styling class family; check `styles.css` for `term-node__offline` or similar and match):

```tsx
        {offscreenDown && (
          <div className="term-node__offscreen-plate">
            <span>Session running — reattaches on view</span>
          </div>
        )}
```

Add minimal CSS in `src/renderer/styles.css` next to the terminal-node block (muted text, centered, fills body).

- [ ] **Step 6: Manual verification recipe (Server Edition on this host)**

Run `npm run typecheck && npx vitest run src/renderer/terminal`. Then a live check: `npm run server:dev`, open two far-apart terminals, set `offscreenTerminalMinutes` to 1, pan away, wait >1 min, confirm in devtools that the disposed node has no `.xterm` element; pan back, confirm reattach redraw and that typing works; confirm an agent node's badge/context meter survive (hooks are node-id keyed, unaffected by PTY client identity).

- [ ] **Step 7: Commit + PR**

```bash
git add src/renderer/nodes/TerminalNode.tsx src/renderer/styles.css
git commit -m "feat(renderer): dispose offscreen terminals in place after 10 min; reattach on approach"
```

**Surfaces:** Desktop + Server Edition (renderer-shared). Mobile: N/A. **Known perceivable edge (PR body):** a node offscreen >10 min re-enters view with a redraw (~1 frame) instead of pixel-identical park fidelity; scroll position within tmux copy-mode is not preserved (it never was across parks either).

---

## Phase 3 — Memory-pressure responder chain (one PR)

cmux's two-signal design (OS pressure + own-footprint polling) reduced to nodeterm's reality: core polls `readMemInfo()` (already in `session-budget.ts`) + `process.memoryUsage().rss`, classifies `warning`/`critical`, and runs responders in priority order. Responders reuse EXISTING levers only: renderer (via a new IPC event) drops all hidden WebGL grants + disposes all parked terminals; core runs the session reaper's sweep immediately on `critical` instead of waiting for the 10-min timer.

**Files:**
- Create: `src/core/memory-pressure.ts`, `src/core/memory-pressure.test.ts`
- Modify: `src/shared/ipc.ts` (channel `app:memory-pressure`), `src/main/index.ts` (boot + forward to renderer + reaper hookup), `src/server/index.ts` (boot + reaper hookup only), `src/preload/index.ts` + `src/preload/index.d.ts` (event subscription), `src/renderer/bridge/` ws-bridge (documented degrade: server pushes nothing renderer-side in v1), `src/renderer/terminal/webgl-budget.ts` (add `releaseAllHiddenGrants()`), `src/renderer/nodes/TerminalNode.tsx` (export `disposeAllParkedTerminals()`), renderer wiring in `src/renderer/canvas/Canvas.tsx`

**Interfaces:**
- Produces (core): `type PressureSeverity = 'warning' | 'critical'`; `createMemoryPressureMonitor(opts: { readMem?: () => { availableMb: number; totalMb: number } | null; selfRssMb?: () => number; intervalMs?: number; onPressure: (s: PressureSeverity) => void }): { start(): void; stop(): void; check(): PressureSeverity | null }`. Thresholds: warning = available < 10% of total OR self RSS > 4096 MB; critical = available < 5% OR self RSS > 8192 MB; a `null` mem read is never pressure (CLAUDE.md rule: failed read ≠ evidence). Edge-triggered with a 60 s re-fire floor per severity.
- Produces (renderer): `releaseAllHiddenGrants(): void` in webgl-budget (release every non-visible holder immediately, bypassing `WEBGL_RELEASE_DELAY_MS`); `disposeAllParkedTerminals(): void` in TerminalNode module (`for (const k of [...parkedTerminals.keys()]) disposeParkedTerminal(k)`).

### Task 5: Core monitor (TDD)

- [ ] **Step 1: Failing test**

```ts
// src/core/memory-pressure.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createMemoryPressureMonitor } from './memory-pressure'

const mem = (availableMb: number, totalMb = 16000) => () => ({ availableMb, totalMb })

describe('memory pressure monitor', () => {
  it('classifies warning below 10% available and critical below 5%', () => {
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 500, onPressure: on })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(700), selfRssMb: () => 500, onPressure: on })
    expect(c.check()).toBe('critical')
  })
  it('a failed mem read is never pressure', () => {
    const m = createMemoryPressureMonitor({ readMem: () => null, selfRssMb: () => 500, onPressure: vi.fn() })
    expect(m.check()).toBeNull()
  })
  it('self-RSS thresholds fire independently of host memory', () => {
    const m = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 5000, onPressure: vi.fn() })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(c.check()).toBe('critical')
  })
  it('re-fires a severity at most once per 60s (edge-trigger + floor)', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 0, intervalMs: 1000, onPressure: on })
    m.start()
    vi.advanceTimersByTime(3500)
    expect(on).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(on).toHaveBeenCalledTimes(2)
    m.stop()
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Implement `src/core/memory-pressure.ts`**

```ts
// Two-signal memory pressure (cmux's MemoryPressureMonitor pattern, Electron-free): host
// available-memory watermarks (readMemInfo — the same source session-budget trusts) plus this
// process's own RSS, because the host signal alone can't tell you YOU are the problem.
// Consumers hang reclaim levers off onPressure; all levers must be idempotent — the monitor
// re-fires a held severity at most once per RE_FIRE_FLOOR_MS.
import { readMemInfo, type MemInfo } from './session-budget'

export type PressureSeverity = 'warning' | 'critical'

export const PRESSURE_INTERVAL_MS = 30_000
export const RE_FIRE_FLOOR_MS = 60_000
export const SELF_RSS_WARN_MB = 4096
export const SELF_RSS_CRIT_MB = 8192

export interface MemoryPressureMonitor {
  start(): void
  stop(): void
  /** One classification pass; null = no pressure (including "could not read"). */
  check(): PressureSeverity | null
}

export function createMemoryPressureMonitor(opts: {
  readMem?: () => MemInfo | null
  selfRssMb?: () => number
  intervalMs?: number
  onPressure: (s: PressureSeverity) => void
}): MemoryPressureMonitor {
  const readMem = opts.readMem ?? readMemInfo
  const selfRss = opts.selfRssMb ?? ((): number => Math.round(process.memoryUsage().rss / 1048576))
  let timer: ReturnType<typeof setInterval> | null = null
  let lastFired = 0

  const check = (): PressureSeverity | null => {
    const rss = selfRss()
    const m = readMem()
    // A failed read is never evidence of pressure; self-RSS still counts.
    const hostCrit = m !== null && m.availableMb < m.totalMb * 0.05
    const hostWarn = m !== null && m.availableMb < m.totalMb * 0.1
    if (hostCrit || rss > SELF_RSS_CRIT_MB) return 'critical'
    if (hostWarn || rss > SELF_RSS_WARN_MB) return 'warning'
    return null
  }

  return {
    check,
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        const s = check()
        if (!s) return
        const now = Date.now()
        if (now - lastFired < RE_FIRE_FLOOR_MS) return
        lastFired = now
        opts.onPressure(s)
      }, opts.intervalMs ?? PRESSURE_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
```

(If `MemInfo`/`readMemInfo` are not exported from `session-budget.ts`, they are — see `session-budget.ts:34,127`.)

- [ ] **Step 4: Run tests** — `npx vitest run src/core/memory-pressure.test.ts` — PASS. Also `npx vitest run src/core/no-electron.test.ts`.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): two-signal memory-pressure monitor"`

### Task 6: Wire responders in both shells + renderer

- [ ] **Step 1: Renderer levers.** In `src/renderer/terminal/webgl-budget.ts` add and export (below `reclaim` at `~:336`; it reuses the exact predicate `lruHiddenHolder` at `~:348` applies — match the `Client` field names used there, e.g. visibility + granted-ness):

```ts
/** Memory-pressure lever: reclaim EVERY hidden holder's context now, bypassing the release
 *  delay. Visible holders are untouched — same invariant as lruHiddenHolder. Idempotent. */
export function releaseAllHiddenGrants(): void {
  for (const c of clients.values()) {
    if (!c.visible && c.granted) reclaim(c)
  }
}
```

In `src/renderer/nodes/TerminalNode.tsx` add:

```ts
/** Memory-pressure lever: drop every parked terminal now (each becomes a warm reattach later). */
export function disposeAllParkedTerminals(): void {
  for (const k of [...parkedTerminals.keys()]) disposeParkedTerminal(k)
}
```

- [ ] **Step 2: IPC channel.** `src/shared/ipc.ts`: add `MEMORY_PRESSURE: 'app:memory-pressure'` following the file's existing constant style. Preload: expose `onMemoryPressure(cb: (severity: 'warning' | 'critical') => void): () => void` on `window.nodeTerminal.app` (match the declared type in `index.d.ts`). ws-bridge: declare the member with a documented no-op degrade (`// Server Edition v1: pressure levers run host-side only (reaper); the browser tab's memory belongs to the browser`) — the `satisfies NodeTerminalApi` gate forces the decision to be visible.

- [ ] **Step 3: Main shell.** In `src/main/index.ts` boot (near where `createSessionReaper` is started, `~:1425`):

```ts
  const pressure = createMemoryPressureMonitor({
    onPressure: (severity) => {
      mainWin?.webContents.send(IPC.MEMORY_PRESSURE, severity)
      if (severity === 'critical') void reaper.sweep() // don't wait for the 10-min timer
    }
  })
  pressure.start()
```

(`reaper` is the existing `createSessionReaper` instance — reuse the variable in scope.)

- [ ] **Step 4: Server shell.** In `src/server/index.ts` (near its reaper boot, `~:414`): same monitor, `onPressure` runs only the `critical → reaper.sweep()` leg.

- [ ] **Step 5: Renderer subscription.** In `src/renderer/canvas/Canvas.tsx`, one mount effect beside the other `window.nodeTerminal` listeners:

```ts
  useEffect(() => {
    const off = window.nodeTerminal.app.onMemoryPressure?.((severity) => {
      releaseAllHiddenGrants()
      disposeAllParkedTerminals()
      if (severity === 'critical') useContextWindow.getState().evictAll?.()
    })
    return () => off?.()
  }, [])
```

If `useContextWindow` has no `evictAll`, skip that line — do NOT add new store surface in this phase; the two required levers are the WebGL and park ones.

- [ ] **Step 6: Verify + commit + PR**

Run: `npm run typecheck && npx vitest run src/core src/renderer/terminal`. Commit `feat: memory-pressure responder chain (webgl + parks + early reaper sweep)`.

**Surfaces:** Desktop = full chain. Server Edition = core monitor + reaper leg (renderer leg documented N/A in v1 — the browser tab manages its own memory). Mobile: N/A.

---

## Phase 4 — Browser/web node Memory Saver (one PR)

Chrome's own "Memory Saver" semantics on canvas webviews: a `BrowserSurface`/`WebNode` webview hidden (**offscreen in the canvas viewport**) for 5 minutes is **discarded** — the `<webview>` element is unmounted, so the guest renderer process dies; the descriptor `{url, address}` is kept, a plate renders — and restored on visibility. Back/forward stack is lost on restore (Electron webview cannot serialize it); PR body states this openly.

**Files:**
- Create: `src/renderer/nodes/browser-discard-policy.ts`, `src/renderer/nodes/browser-discard-policy.test.ts`
- Modify: `src/renderer/nodes/BrowserSurface.tsx`, `src/renderer/nodes/WebNode.tsx`, `src/shared/types.ts` (setting `browserMemorySaver: boolean`, default `true`), `src/renderer/components/SettingsPage.tsx` (toggle row, Appearance/Advanced section per the file's grouping), `src/renderer/styles.css` (plate)

**Interfaces:**
- Produces: `BROWSER_DISCARD_MS = 5 * 60_000`; `shouldDiscard(i: { hiddenMs: number; loading: boolean; enabled: boolean }): boolean`.

### Task 7: Policy + BrowserSurface integration

- [ ] **Step 1: Failing test**

```ts
// src/renderer/nodes/browser-discard-policy.test.ts
import { describe, it, expect } from 'vitest'
import { BROWSER_DISCARD_MS, shouldDiscard } from './browser-discard-policy'

describe('browser discard policy', () => {
  it('discards only when enabled, hidden past the window, and not loading', () => {
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: false, enabled: true })).toBe(true)
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS - 1, loading: false, enabled: true })).toBe(false)
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: true, enabled: true })).toBe(false)
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: false, enabled: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

```ts
// src/renderer/nodes/browser-discard-policy.ts
/**
 * Hidden-webview discard (cmux "Browser Memory Saver" / Chrome tab discarding): each <webview>
 * is a full Chromium renderer process, and a canvas has no cap on browser nodes. A page hidden
 * this long is rebuilt from its URL on reveal. Never discard mid-load (a restore would replay a
 * half-finished navigation). Back/forward stack does not survive — Electron's webview cannot
 * serialize it; the URL and the user's history store do.
 */
export const BROWSER_DISCARD_MS = 5 * 60_000

export function shouldDiscard(i: { hiddenMs: number; loading: boolean; enabled: boolean }): boolean {
  return i.enabled && !i.loading && i.hiddenMs > BROWSER_DISCARD_MS
}
```

- [ ] **Step 4: Run test** — PASS. **Step 5: Integrate in `BrowserSurface.tsx`**

Add state + observer (component already holds `src`, `address`, `loading`):

```ts
  const [discarded, setDiscarded] = useState(false)
  const hiddenSinceRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const saverOn = () => useSettings.getState().settings.browserMemorySaver
    let timer: ReturnType<typeof setTimeout> | null = null
    const obs = new IntersectionObserver(([entry]) => {
      const visible = entry.isIntersecting
      if (!visible) {
        hiddenSinceRef.current = Date.now()
        if (!timer)
          timer = setTimeout(() => {
            timer = null
            const hiddenMs = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0
            if (shouldDiscard({ hiddenMs, loading, enabled: saverOn() })) {
              setDiscarded(true)
              setSrc('') // guest renderer process exits; address/url descriptor kept
            }
          }, BROWSER_DISCARD_MS + 1000)
      } else {
        hiddenSinceRef.current = null
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (discarded) {
          setDiscarded(false)
          setSrc(address || url) // rebuild from the descriptor
        }
      }
    })
    obs.observe(el)
    return () => {
      obs.disconnect()
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discarded, loading, address, url])
```

Attach `ref={rootRef}` to the root `.browser-surface` div. Render a plate when `discarded && !src` (in place of `BrowserStartPage`, which currently shows whenever `!src` — gate it with `!discarded`):

```tsx
        {discarded && !src && (
          <div className="browser-node__discarded">
            <span>Page released to save memory — reopens on view</span>
          </div>
        )}
```

Import `useSettings` (same store TerminalNode uses) and the policy module. Add `browserMemorySaver: boolean` to `Settings` + `DEFAULT_SETTINGS` (`browserMemorySaver: true`) + a Settings toggle row.

- [ ] **Step 6: WebNode.tsx** — same pattern, same policy module, on its root div; on restore re-run the existing `src` effect by re-setting state from `url`/`filePath` (the `media.allow` promise path already handles re-grant).

- [ ] **Step 7: Verify + commit + PR** — `npm run typecheck && npx vitest run src/renderer/nodes`. Manual: open a browser node, **pan the node fully off-screen** for >5 min, verify in Activity Monitor / `ps` that the guest process exited; pan it back into view and verify the reload. Commit `feat(renderer): browser Memory Saver — discard hidden webviews, restore from URL`.

**Surfaces:** Desktop only in practice (`<webview>` requires Electron; the Server Edition renders browser nodes via the same components but webview doesn't exist in a plain browser — verify how BrowserNode degrades there today and keep that behavior). Mobile: N/A.

**Deferred by user decision (v1 = pan-only):** "hidden" means **geometrically offscreen**, as reported by an `IntersectionObserver`. Two other senses of hidden were considered and deliberately left out. (1) **Kanban-covered** — the board is an opaque overlay, but the canvas stays MOUNTED beneath it and every node still intersects the viewport, so occlusion is invisible to an IntersectionObserver; discarding on it would need an explicit signal from `KanbanView`. (2) **Window-hidden** (`document.visibilityState`) — a minimized or background window would discard every browser node at once, and every one of them would reload on return. Both are follow-ups, not gaps in v1. A page that is **making sound** is never discarded regardless (Chrome's own rule), and a load in flight blocks a discard until it finishes.

---

## Phase 5 — Agent hibernation, opt-in "Eco" (one PR, own device checklist)

**Concept:** with `agentHibernationEnabled` (default **false**), an agent node that is (a) hook-idle in state `done`, (b) fully offscreen, (c) idle ≥ `agentHibernationIdleMinutes` (default 30), and (d) `restartEligibility(...).ok` gets the **exit half** of the existing in-place restart (`/exit`, wait until a shell owns the pane). The tmux session and shell survive; only the CLI process (hundreds of MB — the real RAM) exits. The node shows a **SLEEPING** badge; the **resume half** (`resumeCommand` through `withPermissionMode`, echo-verified delivery) fires when the node next becomes visible or the user clicks the badge. Max 2 hibernations per sweep pass. The hibernated flag persists (agentStatus localStorage) and suppresses cold-restore auto-resume until reveal.

**Why this is safe by construction:** every dangerous edge is already handled by machinery this reuses — `restartEligibility` refuses `working`/`blocked` (an exit typed into a permission prompt would answer it), `guardConcurrentRestart` serializes per node, `deliverCommand` echo-verifies the resume line, `performRestartResume`'s pre-flight refuses a pane it cannot watch.

### Task 8: Split agent-restart into exit-phase + resume-phase (behavior-pinning refactor)

**Files:** Modify `src/renderer/terminal/agent-restart.ts`; Test: extend `src/renderer/terminal/agent-restart.test.ts` (exists — the choreography is tested; read it first).

**Interfaces:**
- Produces: `performExitPhase(d: { agentId: string; sessionId: string; io: DeliveryIo; paneCommand: () => Promise<string | null>; timeoutMs?: number; pollMs?: number; isLive?: () => boolean }): Promise<'exited' | 'exit-timeout' | 'not-eligible'>` — everything `performRestartResume` does up to (and including) the wait-for-shell loop, nothing after. `performResumePhase(d: { agentId: string; sessionId: string; io: DeliveryIo; command?: string; deliveryTimeoutMs?: number; onDelivery?: (cancel: () => void) => void; isLive?: () => boolean }): Promise<'resumed' | 'not-eligible'>` — the delivery block.
- `performRestartResume` becomes a composition of the two; its exported signature and all four outcomes are **unchanged**.

- [ ] **Step 1:** Run the existing suite first to capture green: `npx vitest run src/renderer/terminal/agent-restart.test.ts`.
- [ ] **Step 2:** Write two new tests: `performExitPhase` returns `'exited'` once the pane reports a shell and writes nothing after; `performResumePhase` delivers `command ?? resumeCommand(...)` and returns `'resumed'` when the delivery settles. Model the fakes on the existing tests' `DeliveryIo` fakes in that file.
- [ ] **Step 3:** Extract the two functions by moving code, not rewriting it: the pre-flight + KILL_LINE + exit write + poll loop into `performExitPhase`; the `new Promise` delivery block + final `gone()` check into `performResumePhase`. Recompose `performRestartResume` as: eligibility gates (unchanged, including the bare-`resumeCommand` gate) → `performExitPhase` (map `'exited'` → continue) → `performResumePhase` (map `'resumed'` → `'restarted'`).
- [ ] **Step 4:** Full file suite green, byte-identical outcomes: `npx vitest run src/renderer/terminal/agent-restart.test.ts`. **Step 5:** Commit `refactor(renderer): split agent restart into exit + resume phases (behavior pinned)`.

### Task 9: Hibernation policy (pure) + settings + status flag

**Files:** Create `src/renderer/terminal/hibernation-policy.ts` + test; modify `src/shared/types.ts` (`agentHibernationEnabled: boolean` default `false`, `agentHibernationIdleMinutes: number` default `30`), `src/renderer/state/agentStatus.ts` (add `lastEventAt?: number` stamped in the state setter, and persisted `hibernated?: boolean` beside `unread`/`session`/`sessionId` — follow the store's existing persistence partialization), Settings UI row under Agents.

**Interfaces:**
- Produces: `HIBERNATE_BATCH_MAX = 2`; `planHibernation(candidates: Array<{ id: string; agentId?: string; state?: string; sessionId?: string; wired: boolean; offscreen: boolean; hibernated: boolean; recurring: boolean; liveSubagents: boolean; lastEventAt?: number }>, nowMs: number, cfg: { enabled: boolean; idleMinutes: number }): string[]` — eligible iff `enabled`, `!hibernated`, `wired`, `offscreen`, `state === 'done'`, `!recurring`, `!liveSubagents`, `restartEligibility(agentId, state, sessionId).ok`, and `nowMs - (lastEventAt ?? Infinity) >= idleMinutes * 60_000` (a node with NO `lastEventAt` is **never** eligible — unknown idle is not idle, same rule as pendingLaunch's "unknown is not satisfied"); take oldest-first, max 2.
- **`recurring` guard (load-bearing):** `/exit` kills the CLI *process*, and a `/loop`'s `ScheduleWakeup` and in-session cron wakeups die with it — between iterations such a node looks exactly like the target profile (`done`, offscreen, idle). Feed `recurring` from `agentStatus.loop` for the node (any kind — `loop`/`cron`/`schedule`; the card's own × clears it, `CronDelete` clears it). `liveSubagents` comes from `state/agentNodes.ts` (any non-done subagent card for this parent): an async-launched subagent's completion is queued into the PARENT's transcript, and a dead parent CLI never receives it.

- [ ] **Step 1: Failing test** (cases: disabled → `[]`; working/blocked/waiting/no-state excluded; missing `lastEventAt` excluded; batch cap 2 oldest-first; already-hibernated excluded; unwired excluded; onscreen excluded).

```ts
// src/renderer/terminal/hibernation-policy.test.ts — representative core
import { describe, it, expect } from 'vitest'
import { planHibernation, HIBERNATE_BATCH_MAX } from './hibernation-policy'

const base = (id: string, over: object = {}) => ({
  id, agentId: 'claude', state: 'done', sessionId: 's-' + id, wired: true,
  offscreen: true, hibernated: false, recurring: false, liveSubagents: false,
  lastEventAt: 0, ...over
})
const cfg = { enabled: true, idleMinutes: 30 }
const NOW = 100 * 60_000

describe('planHibernation', () => {
  it('takes only done, offscreen, wired, long-idle nodes; oldest first; max 2', () => {
    const out = planHibernation(
      [base('a', { lastEventAt: 10 * 60_000 }), base('b', { lastEventAt: 5 * 60_000 }),
       base('c', { lastEventAt: 1 * 60_000 }), base('d', { state: 'working' }),
       base('e', { offscreen: false }), base('f', { lastEventAt: undefined }),
       base('g', { hibernated: true }), base('h', { wired: false }),
       base('i', { state: 'waiting' }), base('j', { recurring: true }),
       base('k', { liveSubagents: true })],
      NOW, cfg)
    expect(out).toEqual(['c', 'b'])
    expect(HIBERNATE_BATCH_MAX).toBe(2)
  })
  it('never hibernates a recurring (loop/cron/schedule) node, however idle', () => {
    expect(planHibernation([base('a', { recurring: true, lastEventAt: 0 })], NOW, cfg)).toEqual([])
  })
  it('disabled → empty', () => {
    expect(planHibernation([base('a')], NOW, { ...cfg, enabled: false })).toEqual([])
  })
  it('idle window respected', () => {
    expect(planHibernation([base('a', { lastEventAt: NOW - 29 * 60_000 })], NOW, cfg)).toEqual([])
  })
})
```

- [ ] **Step 2: Run (FAIL) → implement → run (PASS).** Implementation is a direct transcription of the interface above; import `restartEligibility` from `./agent-restart`. Include a header comment naming the exclusion rationale: `waiting` is excluded because hibernating would silently swallow a NEEDS-YOU question; unknown idle is not idle.
- [ ] **Step 3: Settings + store fields** (typecheck-driven; stamp `lastEventAt: Date.now()` wherever `setState` records a state transition — read `agentStatus.ts` first and put the stamp at the single setter, not per call site). Persist `hibernated` alongside `session`/`sessionId`.
- [ ] **Step 4: Commit** `feat(renderer): hibernation policy + eco settings + status flags`.

### Task 10: Hibernation controller + wake + badge + cold-restore interplay

**Files:** Modify `src/renderer/canvas/Canvas.tsx` (60 s sweep interval), `src/renderer/nodes/TerminalNode.tsx` (offscreen fact publication, wake-on-visible, SLEEPING badge near the RUNNING/NEEDS-YOU badge, cold-restore suppression), reuse `registerAgentRestart`-style registry: create `registerAgentHibernate(nodeId, { exit, resume })` beside `restartFns` in `agent-restart.ts`.

- [ ] **Step 1: Node registration.** In TerminalNode, where `registerAgentRestart` is wired today (grep `registerAgentRestart(` — read that closure; it builds `io`/`paneCommand` for this node), register a sibling closure pair: `exit: () => guardConcurrentRestart(id, () => performExitPhase({...same deps...}))()` and `resume: () => guardConcurrentRestart(id, () => performResumePhase({ ...same deps..., command: withPermissionMode(resumeCommand(agentId, sessionId), agentId, activeMode) }))()` — mirror how the existing restart closure resolves `withPermissionMode`/`ensureActivePermissionMode` (copy its exact pattern; claude's probe-await included).
- [ ] **Step 2: Sweep.** Canvas effect: `setInterval(60_000)`; gather candidates from live nodes (agentStatus store per node: `state`, `sessionId`, `hibernated`, `lastEventAt`, and `recurring: !!loop` from the same store's `loop` entry; `liveSubagents` from `useAgentNodes` — any card for this parent not in a done state; offscreen fact from a module map the visibility observer already feeds — export a `isNodeOffscreen(termKey)` from TerminalNode, set in the same observer callback Phase 2 touches); `planHibernation(...)`; for each id run the registered `exit`; on `'exited'` set `hibernated: true` in agentStatus; on any other outcome do nothing (next sweep re-evaluates).
- [ ] **Step 3: Wake.** In TerminalNode's visibility observer: on `visible && hibernated` → run registered `resume`; on `'resumed'` clear `hibernated`. Also wake on badge click. While `hibernated`, render a `SLEEPING` chip (reuse the badge component/classes of RUNNING; muted color) with `title="Agent hibernated to save memory — click to resume"`.
- [ ] **Step 4: Cold-restore suppression.** Find the cold-restore auto-resume in TerminalNode (grep `RESUMABLE_AGENTS` / `resumeCommand(` in the mount path): gate it with `!persistedHibernated` so a reboot doesn't resurrect a hibernated CLI; the wake path owns it.
- [ ] **Step 5: Verify.** `npm run typecheck && npx vitest run src/renderer/terminal`. Manual (Server Edition, `agentHibernationEnabled` on, idle 1 min for the test): idle claude node offscreen → within 2 sweeps the pane shows the CLI exited to a shell, badge SLEEPING, `ps` shows the claude process gone; pan back → resume line delivered, conversation restored, badge cleared. Verify a `working` node is never touched and a `waiting` node keeps its NEEDS-YOU badge.
- [ ] **Step 6: Commit + PR** `feat: opt-in agent hibernation (eco) — exit idle offscreen CLIs, resume on view`.

**Surfaces:** Desktop + Server Edition (renderer-shared; the pane machinery is transport-level). SSH-remote agent nodes: **excluded v1** (same `isRemoteSessionNode` gate as Phase 2 — the exit/resume delivery would race the ControlMaster lifecycle; follow-up). Mobile: N/A (phone can't run the sweep; a hibernated node it attaches to shows a shell — acceptable, note in PR).

**Device checklist (owed before default-suggestion, house format per docs/grok-agent.md §9):**
1. Hibernate + wake on desktop Mac build (not just Server Edition).
2. `/exit` typed into claude ≥ current CLI actually exits (EXIT_SEQUENCES.claude = '/exit' — re-verify on the shipping CLI version).
3. Wake under `plan`/`acceptEdits` permission modes resumes with the mode flag (withPermissionMode funnel).
4. Hibernated node + app restart + reveal → resume works from persisted sessionId.
5. Kanban card modal co-attached while hibernation fires (modal viewer sees the exit; acceptable? decide + document).
6. Managed-account node (CLAUDE_CONFIG_DIR) resumes into the right account dir.
7. A `/loop` node (ScheduleWakeup) and a `/cron` node stay untouched through several sweeps while eligible-looking (done + offscreen + idle) — the `recurring` guard holds end-to-end, and their next scheduled wakeup fires on time.

---

## Explicitly out of scope (decided, not forgotten)

- **React Flow `onlyRenderVisibleElements`** — replaced by Phase 2's in-place dispose (unmount-based virtualization would park-storm and lose the mounted-node contract).
- **PTY flow-pause for parked terminals** — `setFlow` starves co-attach viewers (kanban modal); parked growth is ring-bounded.
- **Byte-based xterm scrollback + lowering tmux `history-limit` default** — deferred; the renderer clamp (10k lines) already bounds the buffer, and cutting tmux history is the one change heavy scrollback users would feel. Revisit as part of a future "Eco" umbrella once Phase 5 ships.
- **RTK/Headroom/Caveman integration** — docs-only follow-up (opt-in guidance; measured real-corpus saving is 3.7%, must be stated honestly). No launch-command injection.
- **Modal second xterm** — transient by design; not worth complexity.

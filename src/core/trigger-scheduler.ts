/**
 * The host-side trigger scheduler (issue #493, phase 2) — the machinery that decides WHEN an
 * armed trigger node is due and asks the injected `fire` to deliver it. Runs in core, booted by
 * BOTH shells (desktop main and the Server Edition), with no renderer anywhere in the loop: a
 * headless SE with no browser tab open must still fire.
 *
 * Everything is injected (clock, trigger list, arm gate, delivery), in the sweep-service shape
 * `session-name-sweep.ts` established: `start()/stop()`, an unref'd interval, a short first pass
 * after boot, and a `sweepOnce()` the tests drive directly.
 *
 * The rules, each of which is a decision from the #493 design thread:
 *  - **Host-alive v1.** Nothing here outlives the process; a fire that falls while the host is
 *    down is not run later. `nextAt` is always computed from NOW — never from the missed slot —
 *    so a host that slept through three intervals fires ONCE, not three times (no catch-up /
 *    anacron semantics).
 *  - **The arm gate is asked AT FIRE TIME**, per due trigger, never cached from plan time (the
 *    same fire-time-re-ask rule Eco hibernation follows): `deps.isArmed` goes to the machine-local
 *    `TriggerArmStore`, whose answer is bound to the spec's exact content. A disarmed (or
 *    spec-drifted) trigger that comes due advances its schedule silently — being disarmed is a
 *    state, not an event.
 *  - **Specs are re-sanitized at this use site** (`triggerRowsFromCanvases` runs every row through
 *    `sanitizeTriggerSpec`), whatever path the node object took to get here — the
 *    `permissionModeFlag` rule. An invalid spec schedules nothing.
 *  - **A `once` whose time already passed when first seen** (host was down, or the trigger just
 *    arrived) records ONE honest `missed` run — if it is armed; a disarmed clone spams nothing —
 *    and is done. It is never fired late.
 *  - **An interval anchors to first sight**: next = now + everyMinutes. Deterministic enough for
 *    v1 and honest about what an interval means on a host-alive scheduler; a wall-clock anchor is
 *    what `cron` is for.
 *  - **Exactly-once per due slot**: `nextAt` is advanced BEFORE the (async) fire is awaited, and
 *    an in-flight key is skipped by later sweeps, so a slow delivery cannot double-fire.
 *
 * Run history is a per-trigger in-memory ring (RUNS_CAP) — machine-local by design (the shared
 * file must not churn per fire) and transient for now; phase 4's UI reads it via `runsFor` and
 * the `onRun` callback, and persistence can be added there if the card needs history across
 * restarts.
 */

import type { CanvasNodeState } from '../shared/types'
import {
  sanitizeTriggerSpec,
  type TriggerRun,
  type TriggerRunOutcome,
  type TriggerSpec
} from '../shared/trigger'
import { nextCronFire, parseCron } from '../shared/cron'

// The run types moved to @shared/trigger (the card renders what the core records); re-exported so
// every phase-2/3 import path keeps working.
export type { TriggerRun, TriggerRunOutcome }

export interface TriggerRow {
  projectId: string
  nodeId: string
  spec: TriggerSpec
}

/**
 * The trigger view of `WorkspaceStore.persistedCanvases()` — every valid trigger node across all
 * projects, spec re-sanitized at this use site. ONE definition consumed by both shells' wiring,
 * so the two cannot drift (the duplicated-gate lesson).
 */
export function triggerRowsFromCanvases(
  canvases: Array<{ id: string; nodes: CanvasNodeState[] }>
): TriggerRow[] {
  const rows: TriggerRow[] = []
  for (const canvas of canvases) {
    for (const n of canvas.nodes) {
      if (n.kind !== 'trigger' || n.trigger === undefined) continue
      const spec = sanitizeTriggerSpec(n.trigger)
      if (spec) rows.push({ projectId: canvas.id, nodeId: n.id, spec })
    }
  }
  return rows
}

/** What one fire attempt reports back, recorded verbatim as the run. `queued` is not `fired`:
 *  the bytes have not reached the pane yet — the queue's flush/expiry reports the ending. */
export interface TriggerFireResult {
  outcome: 'fired' | 'missed' | 'failed' | 'queued'
  detail?: string
}

export interface TriggerSchedulerDeps {
  /** Every persisted trigger node (see `triggerRowsFromCanvases`). */
  listTriggers: () => TriggerRow[]
  /** The machine-local, content-bound arm gate (`TriggerArmStore.isArmed`). */
  isArmed: (projectId: string, nodeId: string, spec: TriggerSpec) => boolean
  /** Deliver the payload (phase 3). Resolve `{ok:false}` — or throw — for a failed delivery. */
  fire: (row: TriggerRow) => Promise<TriggerFireResult>
  /** Observe every recorded run (UI feed later; optional). */
  onRun?: (projectId: string, nodeId: string, run: TriggerRun) => void
  now?: () => number
  intervalMs?: number
}

/** Sweep cadence. Schedules are minute-granular, so half-minute polling keeps worst-case firing
 *  lag well under one schedule step while staying negligible (a pure in-memory pass). */
export const TRIGGER_SWEEP_MS = 30_000

/** Ring size of the per-trigger run history. */
export const TRIGGER_RUNS_CAP = 20

interface KeyState {
  canon: string
  /** Next due time (epoch ms); null = nothing scheduled (spent `once`, invalid cron). */
  nextAt: number | null
}

const keyOf = (projectId: string, nodeId: string): string => `${projectId}\n${nodeId}`

/** Next due time for a spec, from `fromMs`. Pure; `null` = never. */
export function computeNextFire(spec: TriggerSpec, fromMs: number): number | null {
  const s = spec.schedule
  if (s.kind === 'interval') return fromMs + s.everyMinutes * 60_000
  if (s.kind === 'once') {
    const at = Date.parse(s.at)
    return Number.isFinite(at) && at > fromMs ? at : null
  }
  const parsed = parseCron(s.expr)
  return parsed ? nextCronFire(parsed, fromMs) : null
}

export interface TriggerScheduler {
  start: () => void
  stop: () => void
  /** One pass over every trigger — what the interval runs, exposed for tests and shells. */
  sweepOnce: () => Promise<void>
  runsFor: (projectId: string, nodeId: string) => TriggerRun[]
  /** The computed next due time, or null — phase 4's card reads this for its countdown. */
  nextFireAt: (projectId: string, nodeId: string) => number | null
  /**
   * Record a run that ended OUTSIDE a fire attempt — the deliver-on-idle queue's late outcomes
   * (`delivered-late`, `expired`, a flush-time drop). Same ring, same `onRun`, so the card shows
   * one history however the run ended.
   */
  recordExternalRun: (projectId: string, nodeId: string, run: TriggerRun) => void
}

export function createTriggerScheduler(deps: TriggerSchedulerDeps): TriggerScheduler {
  const now = deps.now ?? Date.now
  const states = new Map<string, KeyState>()
  const runs = new Map<string, TriggerRun[]>()
  const inFlight = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let first: ReturnType<typeof setTimeout> | undefined

  const record = (projectId: string, nodeId: string, run: TriggerRun): void => {
    const key = keyOf(projectId, nodeId)
    const list = runs.get(key) ?? []
    list.push(run)
    if (list.length > TRIGGER_RUNS_CAP) list.splice(0, list.length - TRIGGER_RUNS_CAP)
    runs.set(key, list)
    deps.onRun?.(projectId, nodeId, run)
  }

  const sweepOnce = async (): Promise<void> => {
    let rows: TriggerRow[]
    try {
      rows = deps.listTriggers()
    } catch {
      return // a transient listing failure changes no schedule state
    }
    const t = now()
    const liveKeys = new Set<string>()
    const due: Array<{ row: TriggerRow; key: string }> = []

    for (const row of rows) {
      const key = keyOf(row.projectId, row.nodeId)
      liveKeys.add(key)
      const canon = JSON.stringify(row.spec)
      const st = states.get(key)
      if (!st || st.canon !== canon) {
        // New trigger, or its spec changed: (re)anchor the schedule from NOW — an edit is a
        // restart of the schedule, never a backfill of the old one's slots.
        const nextAt = computeNextFire(row.spec, t)
        states.set(key, { canon, nextAt })
        if (nextAt === null && row.spec.schedule.kind === 'once') {
          // The one-shot time passed while nobody was scheduling (host down, or the spec just
          // arrived). Honest `missed` — but only for a trigger this machine actually armed;
          // a disarmed clone from git must not spam records.
          if (deps.isArmed(row.projectId, row.nodeId, row.spec))
            record(row.projectId, row.nodeId, {
              at: t,
              outcome: 'missed',
              detail: 'scheduled time passed while the scheduler was not running'
            })
        }
        continue // never due on the sweep that (re)anchored it
      }
      if (st.nextAt !== null && t >= st.nextAt && !inFlight.has(key)) due.push({ row, key })
    }

    // Forget triggers that left the canvas (deleted node / project) — runs included.
    for (const key of [...states.keys()]) {
      if (liveKeys.has(key)) continue
      states.delete(key)
      runs.delete(key)
    }

    for (const { row, key } of due) {
      const st = states.get(key)
      if (!st) continue
      // Advance FIRST (exactly-once per slot, no catch-up), whatever happens below.
      st.nextAt = row.spec.schedule.kind === 'once' ? null : computeNextFire(row.spec, t)
      // Fire-time re-ask, never a plan-time verdict: the machine-local, content-bound arm gate.
      if (!deps.isArmed(row.projectId, row.nodeId, row.spec)) continue
      inFlight.add(key)
      try {
        const result = await deps.fire(row)
        record(row.projectId, row.nodeId, {
          at: now(),
          outcome: result.outcome,
          ...(result.detail ? { detail: result.detail } : {})
        })
      } catch (e) {
        record(row.projectId, row.nodeId, {
          at: now(),
          outcome: 'failed',
          detail: e instanceof Error ? e.message : String(e)
        })
      } finally {
        inFlight.delete(key)
      }
    }
  }

  return {
    start: () => {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMs ?? TRIGGER_SWEEP_MS)
      timer.unref?.()
      // One pass shortly after boot: anchor every schedule (and surface passed `once`s) without
      // waiting a whole interval.
      first = setTimeout(() => void sweepOnce(), 5_000)
      first.unref?.()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      if (first) clearTimeout(first)
      timer = undefined
      first = undefined
    },
    sweepOnce,
    runsFor: (projectId, nodeId) => [...(runs.get(keyOf(projectId, nodeId)) ?? [])],
    nextFireAt: (projectId, nodeId) => states.get(keyOf(projectId, nodeId))?.nextAt ?? null,
    recordExternalRun: record
  }
}

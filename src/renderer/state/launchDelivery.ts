import { create } from 'zustand'
import type { LaunchDelivery } from '../lib/pendingLaunch'

/**
 * What happened to an ARMED node's held launch (canvas-control `--after`, or the cold-open arming
 * a `--project` open leaves behind) — the visible half of the delivery loop that Canvas runs.
 *
 * TRANSIENT on purpose, like the live half of `agentStatus`. A delivery outcome describes THIS
 * app run's attempt to start a session: it is not a property of the canvas, it must not ride
 * `.nodeterm/project.json` to a teammate's machine, and a restart legitimately retries from
 * scratch. Nothing here is persisted.
 *
 * Absent = nothing to report: the node is simply waiting on its dependencies (which the QUEUED
 * badge already explains), or it has not been armed at all.
 *
 * The states, and why each exists:
 *  - `stalled` — the gate is OPEN (every dependency is satisfied) but the node's terminal has not
 *    come up, so there is nothing to deliver INTO yet. We keep waiting — an SSH host that comes
 *    back, a slow spawn and a project the user just switched to all end here first — but we say
 *    so, because "queued, indefinitely, with no reason given" is the exact complaint this whole
 *    change answers (#569 item 1).
 *  - `failed` — the terminal DID come up and refused the launch anyway, for every attempt in the
 *    backoff schedule. That is a real dead end: nothing further will retry it, so the badge must
 *    carry the warning and point at the manual ▶.
 *  - `starting` — a headless start (#925) is in flight: core has claimed the node and is typing its
 *    launch into the pane. NOT a warning: the badge reads STARTING and ▶ is disabled, because a
 *    click would splice a second copy of the command into the one core is typing. Its orchestrator
 *    owns it end to end — `clear` on a start (or a refusal before any spawn), `markFailed` on any
 *    other failure — which is why the Canvas sweep never retires it (`deliveriesToRetire`).
 *  - `brief-missing` — the gate opened and the session is up, but the file the launch reads its
 *    prompt from is gone. Typing the command would start the agent with no brief, so it is held
 *    (the node is persisted `manualOnly`) and the tooltip names the path; ▶ runs it anyway.
 *
 * No state is ever inferred from silence. `stalled` is raised by a timer that starts when the gate
 * opens, `failed` only after a delivery was actually attempted and refused, `starting` only by the
 * orchestrator that is about to launch.
 */
export type { LaunchDelivery }

interface LaunchDeliveryStore {
  byId: Record<string, LaunchDelivery | undefined>
  /** The gate opened but the node's session is not up yet — still waiting, and saying so. */
  markStalled: (nodeId: string) => void
  /** Every attempt in the schedule was refused. Terminal: only ▶ (or a respawn) revives it. */
  markFailed: (nodeId: string, attempts: number) => void
  /** A headless start (#925) is about to type this node's launch: ▶ must stand aside until it settles. */
  markStarting: (nodeId: string) => void
  /** The launch's prompt file was gone at delivery: held for ▶, with the path, never typed. */
  markBriefMissing: (nodeId: string, path: string) => void
  /** Delivered, disarmed, or the node is gone — nothing left to report. */
  clear: (nodeId: string) => void
}

export const useLaunchDelivery = create<LaunchDeliveryStore>((set) => ({
  byId: {},
  markStalled: (nodeId) =>
    set((s) =>
      // Idempotent: the sweep can re-raise this on every re-render, and a fresh `since` on each
      // would make the badge's age tick backwards. ANY existing record wins, so `failed` is never
      // downgraded to `stalled` and a `starting` start is never overwritten by one.
      s.byId[nodeId] ? s : { byId: { ...s.byId, [nodeId]: { kind: 'stalled', since: Date.now() } } }
    ),
  markStarting: (nodeId) =>
    // Unconditional: a start replaces whatever an earlier attempt left behind, `failed` included —
    // that record described the attempt this one is retrying.
    set((s) => ({ byId: { ...s.byId, [nodeId]: { kind: 'starting', since: Date.now() } } })),
  markBriefMissing: (nodeId, path) =>
    set((s) => ({ byId: { ...s.byId, [nodeId]: { kind: 'brief-missing', path, at: Date.now() } } })),
  markFailed: (nodeId, attempts) =>
    set((s) => {
      // Never let a later, smaller count shrink the record: the manual ▶ reports its own single
      // refusal, and it must not rewrite "5 attempts were refused" as "1 was".
      const prev = s.byId[nodeId]
      const total = Math.max(attempts, prev?.kind === 'failed' ? prev.attempts : 0)
      return { byId: { ...s.byId, [nodeId]: { kind: 'failed', attempts: total, at: Date.now() } } }
    }),
  clear: (nodeId) =>
    set((s) => {
      if (!s.byId[nodeId]) return s
      const { [nodeId]: _gone, ...rest } = s.byId
      return { byId: rest }
    })
}))

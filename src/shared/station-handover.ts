// A station that has been HANDED NEW WORK it has not finished yet — the fact plain `--after` needs
// so it does not release a dependent on a `done` from BEFORE that work arrived.
//
// WHY. `--after <station>` releases a node when the station's turn is over (`done`). A station is
// reused: an orchestrator hands it its next task (`send` / `reply`, `write`, `run`) and then opens a
// dependent `--after <station>` to consume that task's output. Until the station STARTS the new
// task its state is still `done` — from the previous task — so the dependent fired at once, on the
// old output, and a launched dependent cannot un-launch. #1042 closed the same hole for
// `--after-success` (a report stops counting once new work is handed over); this is the plain-turn
// half.
//
// The same hold covers BACKGROUND work: a turn that ended with background tasks still running
// (Claude's `background_tasks` on `Stop`) has not finished what a dependent is armed to read.
//
// THE RULE (decided in core, `core/station-handover.ts`; this module is only the wire shape): a
// station is "handed over" from the moment new work is queued for it, or lands in its pane, until a
// turn that STARTED at or after that hand-over has ENDED. While it is, `--after` on it is not
// satisfied, whatever its state reads. Everything here errs toward holding — the QUEUED badge's ▶
// and the `run` verb always end a hold by hand.
//
// Core publishes the WHOLE list after every change (never a delta), like station outcomes; the
// renderer mirrors it (`state/stationHandovers.ts`) and the Server Edition's headless factory asks
// the tracker directly. DURABLE across a restart: core stores the holding stations (HANDOVER_FACT).

import { isSafeNodeId } from './safe-id'

/** One station with unfinished handed-over work. */
export interface StationHandoverRecord {
  nodeId: string
  /** When the newest hand-over landed (the recording process's clock); absent while the only work
   *  handed over is still QUEUED and has not reached the pane. */
  since?: number
  /** A `send` / `reply` is still waiting in the station's queue. */
  queued?: true
  /** The station's last turn ended with background tasks still running (Claude's
   *  `background_tasks`): its output is still being produced. */
  background?: true
}

/** Parse a pushed / pulled list defensively: it crosses a process boundary (and, in the Server
 *  Edition, a network one). A malformed entry is dropped, never half-kept. */
export function sanitizeHandoverRecords(raw: unknown): StationHandoverRecord[] {
  if (!Array.isArray(raw)) return []
  const out: StationHandoverRecord[] = []
  for (const e of raw as unknown[]) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) continue
    const since = typeof r.since === 'number' && Number.isFinite(r.since) ? r.since : undefined
    out.push({
      nodeId: r.nodeId,
      ...(since !== undefined ? { since } : {}),
      ...(r.queued === true ? { queued: true as const } : {}),
      ...(r.background === true ? { background: true as const } : {})
    })
  }
  return out
}

/** Is this station holding unfinished handed-over work? `byId` has no prototype (a node id can be
 *  `__proto__`), so an own-property read is all it takes. */
export function isHandedOver(
  byId: Readonly<Record<string, StationHandoverRecord>> | undefined,
  nodeId: string
): boolean {
  return !!byId && Object.prototype.hasOwnProperty.call(byId, nodeId)
}

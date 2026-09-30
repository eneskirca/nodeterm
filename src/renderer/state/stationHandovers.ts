/**
 * Which stations have unfinished HANDED-OVER work — a MIRROR of core's tracker
 * (src/core/station-handover.ts), replaced whole on every push, never edited here. Core decides what
 * a hand-over is and when it ends; the renderer reads it for the plain `--after` gate
 * (`launchesToFire`), the QUEUED tooltip and `list`.
 *
 * Transient HERE: core re-sends the list on request after a reload, and core itself keeps the holds
 * across an app restart (HANDOVER_FACT) and pushes them when it loads them at boot.
 */
import { create } from 'zustand'
import type { StationHandoverRecord } from '@shared/station-handover'
export { isHandedOver } from '@shared/station-handover'

interface StationHandoversStore {
  byId: Record<string, StationHandoverRecord>
  setRecords(records: readonly StationHandoverRecord[]): void
}

export const useStationHandovers = create<StationHandoversStore>((set) => ({
  byId: Object.create(null) as Record<string, StationHandoverRecord>,
  setRecords: (records) => {
    // No prototype: `__proto__` passes the node-id charset.
    const byId = Object.create(null) as Record<string, StationHandoverRecord>
    for (const r of records) byId[r.nodeId] = r
    set({ byId })
  }
}))

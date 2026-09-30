/**
 * What each station last reported about its TASK (`report-outcome`) — a MIRROR of core's store
 * (src/core/station-outcome-store.ts), replaced whole on every push, never edited here. Core decides
 * what a report is and when it ends; the renderer reads it for the `--after-success` gate, the
 * QUEUED badge and `list`.
 *
 * Transient: core re-sends the list on request after a reload, and after an app restart there is
 * nothing to send — no station has reported in this run.
 */
import { create } from 'zustand'
import type { StationOutcomeRecord } from '@shared/station-outcome'
export { outcomeOf } from '@shared/station-outcome'

interface StationOutcomesStore {
  byId: Record<string, StationOutcomeRecord>
  setRecords(records: readonly StationOutcomeRecord[]): void
}

export const useStationOutcomes = create<StationOutcomesStore>((set) => ({
  byId: Object.create(null) as Record<string, StationOutcomeRecord>,
  setRecords: (records) => {
    // No prototype: `__proto__` passes the node-id charset, and assigning it on a plain object
    // would replace the object's prototype instead of adding a record.
    const byId = Object.create(null) as Record<string, StationOutcomeRecord>
    for (const r of records) byId[r.nodeId] = r
    set({ byId })
  }
}))


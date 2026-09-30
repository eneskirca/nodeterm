/**
 * Mirror core's station task outcomes (src/core/station-outcome-store.ts) into `useStationOutcomes`:
 * the initial pull (a push that fired before this renderer loaded is otherwise lost) and every later
 * push. Nothing flows the other way — a report is made by the station through canvas control, never
 * by this renderer.
 *
 * Installed once, on the app's own api (`window.nodeTerminal`): the stations core reports on are this
 * machine's (or, in the Server Edition, the server's).
 */
import type { NodeTerminalApi } from '@shared/types'
import { sanitizeOutcomeRecords } from '@shared/station-outcome'
import { useStationOutcomes } from '../state/stationOutcomes'

export function installStationOutcomeWiring(api: Pick<NodeTerminalApi, 'stationOutcome'>): () => void {
  const set = (raw: unknown): void => useStationOutcomes.getState().setRecords(sanitizeOutcomeRecords(raw))
  let live = true
  void api.stationOutcome
    .list()
    .then((records) => {
      if (live) set(records)
    })
    .catch(() => undefined)
  const off = api.stationOutcome.onChanged((records) => set(records))
  return () => {
    live = false
    off()
  }
}

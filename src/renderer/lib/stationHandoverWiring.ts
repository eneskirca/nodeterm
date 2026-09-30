/**
 * Mirror core's hand-over tracker (src/core/station-handover.ts) into `useStationHandovers`: the
 * initial pull (a push that fired before this renderer loaded is otherwise lost) and every later
 * push. Nothing flows the other way — a hand-over is observed by core, never declared here.
 *
 * Installed once, on the app's own api (`window.nodeTerminal`), like the station-outcome wiring.
 */
import type { NodeTerminalApi } from '@shared/types'
import { sanitizeHandoverRecords } from '@shared/station-handover'
import { useStationHandovers } from '../state/stationHandovers'

export function installStationHandoverWiring(api: Pick<NodeTerminalApi, 'stationHandover'>): () => void {
  const set = (raw: unknown): void =>
    useStationHandovers.getState().setRecords(sanitizeHandoverRecords(raw))
  let live = true
  // A push is always newer than the initial pull; a pull that resolves after one must not undo it.
  let pushed = false
  void api.stationHandover
    .list()
    .then((records) => {
      if (live && !pushed) set(records)
    })
    .catch(() => undefined)
  const off = api.stationHandover.onChanged((records) => {
    pushed = true
    set(records)
  })
  return () => {
    live = false
    off()
  }
}

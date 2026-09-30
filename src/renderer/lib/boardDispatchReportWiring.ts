/**
 * Reports this renderer's board-dispatch map (#1051, `state/boardDispatch.ts`) to core, so the
 * read-only `issues` control verb (core/github/control-read.ts) can say an issue is queued, starting
 * or refused for dispatch. The queue lives here on purpose and core cannot see it; this is a
 * display-only snapshot, replaced whole on every change, never acted on by core.
 *
 * Installed once, on the app's own api: the dispatcher is this machine's.
 */
import type { NodeTerminalApi } from '@shared/types'
import { dispatchReportFrom } from '@shared/board-dispatch-report'
import { useBoardDispatch } from '../state/boardDispatch'

export function installBoardDispatchReportWiring(api: Pick<NodeTerminalApi, 'boardDispatch'>): () => void {
  const send = (): void => api.boardDispatch.report(dispatchReportFrom(useBoardDispatch.getState().byKey))
  send()
  const off = useBoardDispatch.subscribe((s, prev) => {
    if (s.byKey !== prev.byKey) send()
  })
  return off
}

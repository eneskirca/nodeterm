import type { PendingLaunch } from '@shared/types'
import { useLaunchDelivery } from '../../state/launchDelivery'
import { firstOpenInFlight, launchTooltip } from '../../lib/pendingLaunch'
import { IconPlay } from '../icons'

/**
 * The canvas node's QUEUED chip, on the board: a session card and its card modal. A held launch
 * (`--after`, a setup gate, a cold open, a failed delivery) used to be visible ONLY on the canvas
 * node, so from the board a queued session looked idle and could not be started. ▶ runs the same
 * path as the `run` verb (Canvas `runQueuedNodeRef`): the mounted node's writer when its project is
 * on the canvas, a headless start when it is a background Omni lane.
 *
 * Deliberately smaller than the node's chip: the board does not hold the canvas's dep titles or the
 * PR / success-wait state, so the tooltip names the dependency ids and the command, nothing it
 * cannot see.
 */
export function QueuedLaunchChip({
  nodeId,
  pending,
  firstOpen = false,
  onRun,
  className = ''
}: {
  nodeId: string
  pending: PendingLaunch
  /** The node's first-open `initialCommand` is still set (`KanbanSession.launchFirstOpen`). */
  firstOpen?: boolean
  /** Absent = no ▶ (a board with no run wiring). A relay tab DOES get ▶: Canvas answers it with a
   *  notice that the launch runs on the host, rather than starting anything here. */
  onRun?: () => void
  className?: string
}) {
  const observed = useLaunchDelivery((s) => s.byId[nodeId])
  if (firstOpenInFlight(firstOpen, pending, observed)) return null
  const delivery = observed ?? (pending.manualOnly ? { kind: 'failed' as const, attempts: 1, at: 0 } : undefined)
  const starting = delivery?.kind === 'starting'
  const waitingOn = (pending.after ?? []).join(', ')
  return (
    <span
      className={`term-node__status term-node__status--queued kanban-queued${
        delivery && !starting ? ' term-node__status--queued-warn' : ''
      } ${className}`}
      title={launchTooltip(delivery, waitingOn, pending.command, undefined, !onRun)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className="term-node__status-dot" />
      {starting ? 'STARTING' : delivery ? '⚠ QUEUED' : 'QUEUED'}
      {onRun && (
        <button
          type="button"
          className="term-node__queued-run"
          aria-label="Run now"
          disabled={starting}
          title={starting ? 'Starting in the background' : pending.manualOnly ? 'Retry launch at a shell prompt' : 'Run now without waiting'}
          onClick={(e) => {
            e.stopPropagation()
            onRun()
          }}
        >
          <IconPlay />
        </button>
      )}
    </span>
  )
}

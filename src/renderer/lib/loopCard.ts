/**
 * Dismissing a /loop · /schedule · /cron CARD — the ONE place that knows what a dismiss owes.
 *
 * There are two dismiss surfaces for the same user action (the card's own × and the card's
 * right-click menu), and they drifted: one kept the durable recurring fact and the other destroyed
 * it. What is at stake is not the card. `agentStatus.loop` is the only record that this node has a
 * wakeup pending, and it is what stops Eco mode from asking the CLI to `/exit` — a `cron` whose
 * entry has been cleared looks EXACTLY like an idle session (done, offscreen, long silent), so the
 * next sweep quits the process the job was going to fire in. The card's own tooltip has always
 * promised the opposite: "does not remove the job".
 *
 * So: a `cron`/`schedule` dismiss MARKS the entry (`loop.dismissed` — every render site filters on
 * it, nothing else reads it), while an in-session `/loop` still clears outright, because that one
 * dies with its session and there is no fact left to keep. A real end (CronDelete) is a real clear,
 * and goes through `setLoop(id, false)` as it always has.
 */
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'

/** What dismissing a card of this kind must do to the durable entry. Pure — the whole decision. */
export function loopDismissAction(
  kind: string | undefined
): 'mark-dismissed' | 'clear' {
  // Unknown kinds clear, matching the historical behavior of every non-cron card.
  return kind === 'cron' || kind === 'schedule' ? 'mark-dismissed' : 'clear'
}

/**
 * Apply a dismiss to the parent terminal's card. The KIND is read from the store, not passed in:
 * that entry is where the card's own data came from, and a second source is how the two surfaces
 * disagreed in the first place.
 */
export function applyLoopDismiss(parentNodeId: string): void {
  const status = useAgentStatus.getState()
  const kind = status.byId[parentNodeId]?.loop?.kind
  if (loopDismissAction(kind) === 'mark-dismissed') status.dismissLoopCard(parentNodeId)
  else status.setLoop(parentNodeId, false)
  // The card's dragged position/size go either way — the card is gone from the screen.
  useAgentNodes.getState().clearLoop(parentNodeId)
}

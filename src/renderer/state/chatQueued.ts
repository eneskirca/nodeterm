import type { QueuedSendRecord } from '../lib/chatPaging'

/**
 * The ⌘M composer's sends that went into the agent CLI's own queue mid-turn and are not in the
 * transcript yet, keyed by node id. The "Queued" bubble is optimistic panel state, and the panel
 * unmounts on every project switch; without this a remounted panel rebuilt the thread from the
 * transcript, which does not hold a queued prompt until the CLI delivers it, so the prompt looked
 * lost while it was still waiting in the CLI's queue.
 *
 * In memory only, on purpose: after a reload the CLI's queue may have been delivered, edited (Esc
 * pulls it back into the input box) or dropped, and a stale bubble is worse than none.
 */
interface StoredQueuedSend extends QueuedSendRecord {
  /** The transcript identity the send was made under (ChatPanel's `identity`). */
  identity: string
}

/** Per node. A queue this deep is already unusual; the oldest go first. */
const PER_NODE_MAX = 20

const byNode = new Map<string, StoredQueuedSend[]>()

export function rememberQueuedSend(nodeId: string, send: StoredQueuedSend): void {
  const list = [...(byNode.get(nodeId) ?? []), send]
  byNode.set(nodeId, list.slice(-PER_NODE_MAX))
}

export function forgetQueuedSend(nodeId: string, id: string): void {
  const list = byNode.get(nodeId)
  if (list === undefined) return
  const next = list.filter((s) => s.id !== id)
  if (next.length === 0) byNode.delete(nodeId)
  else byNode.set(nodeId, next)
}

/** The sends remembered for this node under this transcript identity, oldest first. */
export function queuedSendsFor(nodeId: string, identity: string): QueuedSendRecord[] {
  return (byNode.get(nodeId) ?? [])
    .filter((s) => s.identity === identity)
    .map(({ id, text, afterKey }) => ({ id, text, afterKey }))
}

/** Test-only reset. */
export function clearQueuedSendsForTest(): void {
  byNode.clear()
}

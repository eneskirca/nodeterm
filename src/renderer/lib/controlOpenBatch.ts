import type { PendingLaunch } from '@shared/types'
import { queueControlLaunch } from './pendingLaunch'

/** The visible Desktop open handlers share creation-time delivery accounting. Mounting and
 * asynchronous delivery happen later; neither can turn an open response into a startup claim. */
export function createControlOpenBatch() {
  const opened: Array<{ id: string; queued: boolean }> = []
  return {
    add<T extends { id: string; data: { initialCommand?: string; pendingLaunch?: PendingLaunch } }>(node: T) {
      const held = queueControlLaunch(node)
      opened.push({ id: held.id, queued: !!held.data.pendingLaunch })
      return held
    },
    result(after: string[] = []) {
      const ids = opened.map((n) => n.id)
      const queuedIds = opened.filter((n) => n.queued).map((n) => n.id)
      return { ids, id: ids[0], after, queued: queuedIds.length > 0, queuedIds }
    }
  }
}

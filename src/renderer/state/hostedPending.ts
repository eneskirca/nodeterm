import { create } from 'zustand'
import type { HostedPendingClosedReason } from '@shared/types'
import {
  EMPTY_PENDING_QUEUE,
  addRequest,
  attachProject,
  beginAnswer,
  closeRequest,
  finishAnswer,
  dropProjectRequests,
  settleRequest,
  type PendingQueue,
  type QueuedRequest
} from '../lib/hostedPendingQueue'
import type { OwnerQueueSink } from '../lib/hostedOwner'

/**
 * The devices waiting for THIS owner's answer, across every hosted tab where this device is an
 * owner (the rules are the pure `lib/hostedPendingQueue.ts`). The approval dialog shows the head.
 * `notice` is the latest line worth telling the owner ("Another owner answered this request"),
 * bumped by `seq` so the same sentence twice is still two notices. Transient.
 */
interface HostedPendingStore {
  queue: PendingQueue
  notice: { seq: number; text: string } | null
  add: (item: QueuedRequest) => void
  close: (pendingId: string, reason: HostedPendingClosedReason) => void
  settle: (pendingId: string) => void
  /** An answer is on its way (off the screen, not re-added by a replay). */
  beginAnswer: (pendingId: string) => void
  /** It came back; `landed` settles it, otherwise it stays answerable (and goes back on screen
   *  once, while its owner tab is attached). */
  finishAnswer: (item: QueuedRequest, landed: boolean) => void
  /** An owner tab's subscription is live. */
  attach: (projectId: string) => void
  drop: (projectId: string) => void
}

export const useHostedPending = create<HostedPendingStore>((set) => ({
  queue: EMPTY_PENDING_QUEUE,
  notice: null,
  add: (item) => set((s) => {
    const queue = addRequest(s.queue, item)
    return queue === s.queue ? s : { queue }
  }),
  close: (pendingId, reason) =>
    set((s) => {
      const r = closeRequest(s.queue, pendingId, reason)
      return r.notice ? { queue: r.queue, notice: { seq: (s.notice?.seq ?? 0) + 1, text: r.notice } } : { queue: r.queue }
    }),
  settle: (pendingId) => set((s) => ({ queue: settleRequest(s.queue, pendingId) })),
  beginAnswer: (pendingId) => set((s) => ({ queue: beginAnswer(s.queue, pendingId) })),
  finishAnswer: (item, landed) => set((s) => ({ queue: finishAnswer(s.queue, item, landed) })),
  attach: (projectId) => set((s) => {
    const queue = attachProject(s.queue, projectId)
    return queue === s.queue ? s : { queue }
  }),
  drop: (projectId) => set((s) => {
    const queue = dropProjectRequests(s.queue, projectId)
    return queue === s.queue ? s : { queue }
  })
}))

/** The store as the owner subscription's sink. */
export const hostedPendingSink: OwnerQueueSink = {
  attach: (projectId) => useHostedPending.getState().attach(projectId),
  add: (item) => useHostedPending.getState().add(item),
  close: (pendingId, reason) => useHostedPending.getState().close(pendingId, reason),
  drop: (projectId) => useHostedPending.getState().drop(projectId)
}

// Board dispatch's TRANSIENT state: the queue, what is starting, and why a dispatch was refused —
// what an issue card shows ("Queued for an agent", "Starting…", "Not dispatched: <reason>").
//
// In memory only, on purpose: a queue that survived a restart would start agents at boot, while the
// person who dragged the card may not be there. A restart drops the queue; the cards say nothing
// afterwards and the drag (or "Start with agent") can be repeated. The consent itself is
// machine-local settings (`@shared/board-dispatch`).

import { create } from 'zustand'
import type { IssueRef } from '@shared/github-issue-ref'
import type { DispatchQueueEntry } from '../lib/boardDispatch'

export type DispatchCardStatus = 'queued' | 'starting' | 'refused'

export interface DispatchCardEntry extends DispatchQueueEntry {
  status: DispatchCardStatus
  /** Why nothing started (refused), in the card's words. */
  reason?: string
  /** The column the run's session card is filed under (the dispatch column). */
  columnId: string
}

interface BoardDispatchState {
  byKey: Record<string, DispatchCardEntry>
  /** Node id → when dispatch started it (this app run), for the startup grace of `occupiesSlot`. */
  startedAt: Record<string, number>
  put(entry: DispatchCardEntry): void
  remove(key: string): void
  markStarted(nodeId: string, at: number): void
  queue(): DispatchQueueEntry[]
}

export const useBoardDispatch = create<BoardDispatchState>((set, get) => ({
  byKey: {},
  startedAt: {},
  put: (entry) => set((s) => ({ byKey: { ...s.byKey, [entry.key]: entry } })),
  remove: (key) =>
    set((s) => {
      if (!(key in s.byKey)) return s
      const { [key]: _gone, ...rest } = s.byKey
      return { byKey: rest }
    }),
  markStarted: (nodeId, at) => set((s) => ({ startedAt: { ...s.startedAt, [nodeId]: at } })),
  queue: () => Object.values(get().byKey).filter((e) => e.status === 'queued')
}))

export function dispatchEntry(
  base: { key: string; projectId: string; ref: IssueRef; number: number; columnId: string },
  status: DispatchCardStatus,
  at: number,
  reason?: string
): DispatchCardEntry {
  return { ...base, queuedAt: at, status, ...(reason ? { reason } : {}) }
}

/** A primitive for one card's chip: `status|reason|position` (position = 1-based place in its
 *  project's queue), so the card re-renders only when its own line changes. */
export function dispatchChipSig(state: Pick<BoardDispatchState, 'byKey'>, key: string | undefined): string {
  const e = key ? state.byKey[key] : undefined
  if (!e) return ''
  let position = 0
  if (e.status === 'queued') {
    for (const other of Object.values(state.byKey)) {
      if (other.status === 'queued' && other.projectId === e.projectId && other.queuedAt <= e.queuedAt) position++
    }
  }
  return `${e.status}|${e.reason ?? ''}|${position}`
}

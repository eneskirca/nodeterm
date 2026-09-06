import { create } from 'zustand'
import type { ReopenNodeSnapshot } from '@renderer/lib/reopenNode'

/** A single "close" event this session recorded — a project tab close, or a batch of node
 *  deletions from one Delete/×/Cmd+W action. In-memory only: unlike closed-project state
 *  (`project.closed`), which persists, this history resets on app restart — the same
 *  convention a browser's own "reopen closed tab" uses. */
export type ReopenEntry =
  | { kind: 'project'; projectId: string; closedAt: number }
  | { kind: 'nodes'; projectId: string; closedAt: number; nodes: ReopenNodeSnapshot[] }

export const HISTORY_CAP = 10

/** Appends `entry` (most recent last) and drops the oldest entries past `cap`. */
export function pushEntry(stack: ReopenEntry[], entry: ReopenEntry, cap: number): ReopenEntry[] {
  return [...stack, entry].slice(-cap)
}

/** Removes and returns the most recently pushed entry, or `undefined` for an empty stack. */
export function popEntry(stack: ReopenEntry[]): { entry: ReopenEntry | undefined; rest: ReopenEntry[] } {
  if (!stack.length) return { entry: undefined, rest: stack }
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) }
}

/**
 * Drops every snapshot tagged with `entryId` (`ReopenNodeSnapshot.closedSessionId`) out of
 * `projectId`'s `kind: 'nodes'` entries, then drops any entry left with no nodes at all — an
 * empty batch would restore nothing if popped, so it must not linger as a dead stack slot.
 * `kind: 'project'` entries carry no snapshots and pass through untouched.
 *
 * This is the ⇧⌘T-stack twin of `useProjects.discardClosedSession`: the sidebar's persisted
 * "Recently closed" list and this in-memory stack both get a row for the SAME delete, and
 * reopening one must consume the other's matching entry too — otherwise a single delete can be
 * reopened twice, minting two duplicate nodes from one closed session.
 */
export function dropClosedSessionRef(
  stack: ReopenEntry[],
  projectId: string,
  entryId: string
): ReopenEntry[] {
  return stack
    .map((e) =>
      e.kind === 'nodes' && e.projectId === projectId
        ? { ...e, nodes: e.nodes.filter((n) => n.closedSessionId !== entryId) }
        : e
    )
    .filter((e) => e.kind !== 'nodes' || e.nodes.length > 0)
}

interface ReopenHistoryState {
  stack: ReopenEntry[]
  push: (entry: ReopenEntry) => void
  /** Pops and returns the most recent entry. Callers that find it stale (project already
   *  reopened another way, or permanently deleted) call this again to keep walking back. */
  popNext: () => ReopenEntry | undefined
  /** See `dropClosedSessionRef`. */
  dropByClosedSessionId: (projectId: string, entryId: string) => void
}

export const useReopenHistory = create<ReopenHistoryState>((set, get) => ({
  stack: [],
  push: (entry) => set((s) => ({ stack: pushEntry(s.stack, entry, HISTORY_CAP) })),
  popNext: () => {
    const { entry, rest } = popEntry(get().stack)
    if (entry) set({ stack: rest })
    return entry
  },
  dropByClosedSessionId: (projectId, entryId) =>
    set((s) => ({ stack: dropClosedSessionRef(s.stack, projectId, entryId) }))
}))

import { create } from 'zustand'

/**
 * Claude Remote Control on/off per node — TRANSIENT, never persisted. Fed by core's transcript
 * tails over `context.onRemoteControl` (see core/remote-control-scan.ts for what is and is not
 * measured about that signal). Keyed by node, stamped with the session it was read from, so a
 * node that moves to another conversation does not inherit the old one's state.
 */
interface RemoteControlStore {
  byNode: Record<string, { sessionId: string; on: boolean }>
  set(update: { nodeId: string; sessionId: string; on: boolean }): void
}

export const useRemoteControl = create<RemoteControlStore>((set) => ({
  byNode: {},
  set: ({ nodeId, sessionId, on }) =>
    set((s) => {
      const cur = s.byNode[nodeId]
      if (cur && cur.sessionId === sessionId && cur.on === on) return s
      return { byNode: { ...s.byNode, [nodeId]: { sessionId, on } } }
    })
}))

/** Is Remote Control known to be ON for this node's CURRENT session? Unknown reads as off. */
export function remoteControlOn(
  entry: { sessionId: string; on: boolean } | undefined,
  currentSessionId: string | null | undefined
): boolean {
  return !!entry && entry.on && !!currentSessionId && entry.sessionId === currentSessionId
}

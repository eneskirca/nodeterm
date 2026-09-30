// A relay connection this renderer closed ITSELF, announced locally.
//
// Main never reports a close it was asked for: `relay:client:disconnect` ends the socket
// intentionally, and an intentional close does not fire the relay socket's onClose
// (core relay-socket `handleClose`), so `relay:client:closed` never arrives. For a hosted team's
// connection that silence matters: the renderer holds ONE attempt per team until its connection
// ends (lib/hostedAttempts.ts), and a declined SAS or a closed tab would otherwise hold the team for
// good — or keep the approval wait running for the full ten minutes. So a hosted connection's own
// close is said here, and its listeners take it as the close it is. Team Access relay tabs never
// emit it, so their behaviour is unchanged. See docs/hosted-team-relay.md.

const listeners = new Map<string, Set<() => void>>()

/** Hear when this renderer closes `connectionId` itself. Returns the unsubscribe. */
export function onLocalRelayClose(connectionId: string, listener: () => void): () => void {
  let set = listeners.get(connectionId)
  if (!set) {
    set = new Set()
    listeners.set(connectionId, set)
  }
  set.add(listener)
  return () => {
    const s = listeners.get(connectionId)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) listeners.delete(connectionId)
  }
}

/** This renderer just closed `connectionId` (after `relayClient.disconnect`). */
export function emitLocalRelayClose(connectionId: string): void {
  for (const listener of [...(listeners.get(connectionId) ?? [])]) {
    try {
      listener()
    } catch (err) {
      console.warn('[relay] a local-close listener failed', err)
    }
  }
}

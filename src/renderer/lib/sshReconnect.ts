/**
 * Auto-reconnect coordinator for SSH-project terminals whose ssh client died with a CONNECTION
 * failure (exit 255 — sleep/wake, network change, NAT idle drop). The remote tmux sessions
 * survive such drops, so all that's needed is to re-establish the project's ControlMaster and
 * respawn the dead nodes (`new-session -A` reattaches).
 *
 * Pure timer/state logic — Canvas injects `connect` (re-establish the master) and `respawn`
 * (bump the nodes' respawnNonce). TerminalNode feeds drops in via Canvas's setSshDropHandler
 * bridge; Canvas forwards every 'connected' status event to onConnected so an EXTERNAL
 * reconnect (the active-project effect on a tab switch) also flushes pending nodes.
 */

/** Backoff schedule between connect attempts; ~30s total, then the loop gives up. A later
 *  `onConnected` (tab-switch reconnect) still flushes whatever is pending. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

/** A re-drop within this window of a node's respawn is refused: if the respawned ssh dies
 *  instantly the spawn itself is broken (bad key, revoked host, …) and reconnecting again
 *  would hot-loop connect→respawn→die forever. */
export const RESPAWN_REFUSE_MS = 10_000

// An open card can be the only mounted view of an offscreen project's terminal. Canvas's
// respawnNonce never reaches that view, so successful reconnects also notify these exact
// scope/node subscribers. This is renderer-only lifetime state, never persisted or replayed.
const reattachListeners = new Map<string, Map<string, Set<() => void>>>()

export function subscribeSshReattach(scopeId: string, nodeId: string, listener: () => void): () => void {
  let nodes = reattachListeners.get(scopeId)
  if (!nodes) reattachListeners.set(scopeId, nodes = new Map())
  let listeners = nodes.get(nodeId)
  if (!listeners) nodes.set(nodeId, listeners = new Set())
  listeners.add(listener)
  const scopeNodes = nodes
  const nodeListeners = listeners
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    nodeListeners.delete(listener)
    if (!nodeListeners.size) scopeNodes.delete(nodeId)
    if (!scopeNodes.size) reattachListeners.delete(scopeId)
  }
}

function notifySshReattach(scopeId: string, nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    const listeners = reattachListeners.get(scopeId)?.get(nodeId)
    if (listeners) for (const listener of [...listeners]) listener()
  }
}

interface ProjectLoop {
  /** Nodes waiting for a respawn once the master is back. */
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** Index into RECONNECT_DELAYS_MS for the NEXT attempt; delays.length ⇒ gave up. */
  attempt: number
}

export interface SshReconnectorDeps {
  /** Re-establish the project's ControlMaster. Resolve true on success. */
  connect: (projectId: string) => Promise<boolean>
  /** Respawn the given (dead) terminal nodes of the project. */
  respawn: (projectId: string, nodeIds: string[]) => void
}

export class SshReconnector {
  private readonly deps: SshReconnectorDeps
  private readonly loops = new Map<string, ProjectLoop>()
  private readonly lastRespawn = new Map<string, number>()
  private disposed = false

  constructor(deps: SshReconnectorDeps) {
    this.deps = deps
  }

  /** A remote terminal's ssh died with exit 255: queue it and (re)start the project's loop. */
  reportDrop(projectId: string, nodeId: string): void {
    if (this.disposed) return
    const respawnedAt = this.lastRespawn.get(nodeId)
    if (respawnedAt !== undefined && Date.now() - respawnedAt < RESPAWN_REFUSE_MS) return
    let loop = this.loops.get(projectId)
    if (!loop) {
      loop = { pending: new Set(), timer: null, attempt: 0 }
      this.loops.set(projectId, loop)
    }
    loop.pending.add(nodeId)
    // Only kick the loop when idle AND not exhausted: an exhausted loop stays parked until
    // onConnected; a running one will pick this node up on its own flush.
    if (loop.timer === null && loop.attempt < RECONNECT_DELAYS_MS.length) this.schedule(projectId, loop)
  }

  /**
   * The user asked for it (the connection banner's Reconnect, or an offline node's own button):
   * try NOW, whatever the backoff was doing.
   *
   * Three things separate this from `reportDrop`: it skips the first delay (a person is watching),
   * it resets an EXHAUSTED loop's attempt counter (giving up is for the automatic loop, not for
   * an explicit ask), and it clears the respawn-refuse window for the named nodes — that window
   * exists to stop a broken spawn from hot-looping by itself, and a click is not a hot loop.
   */
  retryNow(projectId: string, nodeIds: string[] = []): void {
    if (this.disposed) return
    let loop = this.loops.get(projectId)
    if (!loop) {
      loop = { pending: new Set(), timer: null, attempt: 0 }
      this.loops.set(projectId, loop)
    }
    for (const id of nodeIds) {
      loop.pending.add(id)
      this.lastRespawn.delete(id)
    }
    if (loop.timer !== null) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
    loop.attempt = 0
    void this.tryConnect(projectId, loop)
  }

  /** The project's master is (re)connected — by our loop or anyone else's. Flush pending nodes. */
  onConnected(projectId: string): void {
    if (this.disposed) return
    const loop = this.loops.get(projectId)
    if (!loop) return
    if (loop.timer !== null) clearTimeout(loop.timer)
    this.loops.delete(projectId)
    this.flush(projectId, loop)
  }

  dispose(): void {
    this.disposed = true
    for (const loop of this.loops.values()) {
      if (loop.timer !== null) clearTimeout(loop.timer)
    }
    this.loops.clear()
  }

  private schedule(projectId: string, loop: ProjectLoop): void {
    loop.timer = setTimeout(() => {
      loop.timer = null
      void this.tryConnect(projectId, loop)
    }, RECONNECT_DELAYS_MS[loop.attempt])
    loop.attempt++
  }

  private async tryConnect(projectId: string, loop: ProjectLoop): Promise<void> {
    let ok = false
    try {
      ok = await this.deps.connect(projectId)
    } catch {
      ok = false
    }
    if (this.disposed) return
    // onConnected may have flushed (and deleted) the loop while connect was in flight.
    if (this.loops.get(projectId) !== loop) return
    if (ok) {
      this.loops.delete(projectId)
      this.flush(projectId, loop)
    } else if (loop.attempt < RECONNECT_DELAYS_MS.length) {
      this.schedule(projectId, loop)
    }
    // else: exhausted — keep the loop parked with its pending set so onConnected can flush it.
  }

  private flush(projectId: string, loop: ProjectLoop): void {
    if (loop.pending.size === 0) return
    const nodeIds = [...loop.pending]
    const now = Date.now()
    for (const id of nodeIds) this.lastRespawn.set(id, now)
    notifySshReattach(projectId, nodeIds)
    this.deps.respawn(projectId, nodeIds)
  }
}

import type { PtyCreateOptions, PtyCreateResult, RecycledInfo } from '@shared/types'
import type { ClientId } from '@shared/presence'

/**
 * Abstraction over the terminal session layer.
 *
 * The renderer/UI depends only on this interface; it does not know the concrete
 * implementation. There is a single implementation, LocalTransport, driven by the
 * active session's `NodeTerminalApi` (`useSession().api`): the preload for a local
 * session, or the ws-bridge over the relay tunnel for a remote tab. Remote access is
 * "swap the api object", not "swap the transport" (see docs/remote-sessions.md).
 */
export interface TerminalTransport {
  create(options: PtyCreateOptions): Promise<PtyCreateResult>
  write(sessionId: string, data: string): void
  /**
   * REPORT the size this client could render (not a command — the pty runs at the smallest
   * subscriber's grid and answers over `onSize`). `null, null` means "subscribed, but not viewing"
   * (a parked terminal): it leaves the size set, so a parked small window never clamps the others.
   */
  resize(sessionId: string, cols: number | null, rows: number | null): void
  /** Flow control: pause (false) / resume (true) the source when the terminal is backed up. */
  setFlow(sessionId: string, resume: boolean): void
  /** Detaches the client; with tmux the underlying session survives. */
  kill(sessionId: string): void
  /**
   * Permanently ends a node's persistent session because the node is being DELETED (× / delete).
   * Co-viewers are told "closed by <name>" and must never respawn it.
   *
   * `opts.everySocket` widens a kill for a session this process holds NOTHING for to every local
   * tmux socket the name could be on. Opt-in for the session-memory panel's speculative kill only
   * (see `localKillSockets`); an ordinary × leaves it unset.
   */
  destroy(persistKey: string, opts?: { everySocket?: boolean }): void
  /**
   * Ends a node's persistent session so the SAME node id can respawn in a new cwd ("move into
   * worktree"). The tmux kill is identical to `destroy` — without it the respawn would just
   * reattach the old session, keeping the old working directory — but the INTENT is the opposite:
   * the node is not going anywhere. Co-viewers therefore get `onRecycled` (restart, re-attach to
   * the replacement session), never the permanent, un-respawnable closed state.
   */
  recycle(persistKey: string): void

  /** Listens for output; returns an unsubscribe function. */
  onData(sessionId: string, listener: (data: string) => void): () => void
  /** Fires when the session closes; returns an unsubscribe function. */
  onExit(sessionId: string, listener: (exitCode: number) => void): () => void
  /**
   * The authoritative size of a co-attached session: min(cols) × min(rows) over all subscribers
   * ("smallest subscriber wins"). The terminal must render at this size (letterboxing the slack)
   * instead of its own FitAddon result, or the two viewers' screens diverge.
   * OPTIONAL: a transport that cannot negotiate a shared size simply omits it, and the terminal
   * falls back to driving its own FitAddon. Returns an unsubscribe function.
   */
  onSize?(sessionId: string, listener: (size: { cols: number; rows: number }) => void): () => void
  /**
   * Another client permanently DESTROYED this node while we were co-viewing it: the session is
   * gone for good, so the terminal shows a "closed by <peer>" state instead of respawning it.
   * `by` is the destroying client's ClientId (null when no client was attributed — e.g. a local
   * destroy on the desktop); map it to a peer name via the presence store.
   * OPTIONAL for the same reason as onSize. Returns an unsubscribe function.
   */
  onClosed?(sessionId: string, listener: (info: { by: ClientId | null }) => void): () => void
  /**
   * Another client RECYCLED this node (moved it into a worktree): this session id is dead. With
   * `ready:true` a replacement is already live under the same node id — so restart the terminal
   * (its re-create co-attaches to the new session) rather than showing the closed state. Nothing
   * was deleted; the node is still on the canvas and still working.
   * With `ready:false` NO replacement ever came (the recycler's app died mid-move): do not
   * respawn — a restart would spawn the node in this client's own, stale cwd and silently undo the
   * move. The terminal ends and offers a manual reopen.
   * OPTIONAL for the same reason as onSize. Returns an unsubscribe function.
   */
  onRecycled?(sessionId: string, listener: (info: RecycledInfo) => void): () => void
  /**
   * This client fell so far behind that the server discarded its queued output (WS_DROP_WATER)
   * and is redrawing it from tmux: clear the emulator and write this capture — it is the CURRENT
   * screen.
   * CONTRACT: the server only ever emits a NON-EMPTY capture (a failed/empty capture is retried,
   * never sent). The listener must STILL ignore an empty/falsy payload — no reset, no separator:
   * a wrongly reset screen is unrecoverable, a skipped repaint is not.
   * OPTIONAL for the same reason as onSize. Returns an unsubscribe function.
   */
  onResync?(sessionId: string, listener: (screen: string) => void): () => void
}

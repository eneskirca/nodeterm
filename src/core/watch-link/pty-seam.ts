// The live link's pty seam (link-host.ts `WatchPty`) over PtyManager — ONE definition both shells
// wire, because the join's rules are easy to get subtly wrong and a second copy is how one shell
// ends up a rule behind the other:
//  - the join passes only ids the host chose: the node id, the viewer id the link host minted, and
//    remote fields from the shell's own records (`remoteFor`) — never a size (R39): a watcher's own
//    tmux client is spawned at the window size PtyManager reads itself, or not at all (R19/R20);
//  - the size the viewer is told is the JOINED session's current size (`sessionSize`, R25), and a
//    session whose size is unknown is REFUSED rather than given a guessed 80x24 (R37/R39);
//  - a refusal that had already attached leaves what it attached (the link host only knows a session
//    id this seam answered, so it could not leave it);
//  - `alive` is PtyManager's explicit `hasSession` (R38), `syncSize` its per-session serialized sync (R24).
import type { PtyCreateOptions } from '../../shared/types'
import type { PtyManager } from '../pty-manager'
import type { WatchPty } from './link-host'

export type WatchPtyManager = Pick<
  PtyManager,
  'joinAsWatcher' | 'sessionSize' | 'kill' | 'captureVisible' | 'syncWatcherClientSize' | 'hasSession'
>

/** Where a node's session lives, from the SHELL's own records. `requireRemote` for every node of an
 *  SSH project (a downed master must never let the local tmux attach a same-named local orphan). */
export interface WatchRemote {
  sshRemote?: PtyCreateOptions['sshRemote']
  requireRemote?: boolean
}

export function createWatchPty(pty: WatchPtyManager, remoteFor: (nodeId: string) => WatchRemote = () => ({})): WatchPty {
  return {
    async join(clientId, nodeId, viewerId) {
      const remote = remoteFor(nodeId)
      const res = await pty.joinAsWatcher(clientId, {
        persistKey: nodeId,
        viewerId,
        ...(remote.sshRemote ? { sshRemote: remote.sshRemote } : {}),
        ...(remote.requireRemote ? { requireRemote: true } : {})
      })
      if (!res.sessionId) return null
      const size = res.unavailable ? null : pty.sessionSize(res.sessionId)
      if (!size) {
        pty.kill(clientId, res.sessionId, viewerId)
        return null
      }
      return { sessionId: res.sessionId, cols: size.cols, rows: size.rows, altScreen: res.tmuxClient === true }
    },
    leave: (clientId, sessionId, viewerId) => pty.kill(clientId, sessionId, viewerId),
    captureVisible: (sessionId) => pty.captureVisible(sessionId),
    syncSize: (sessionId) => pty.syncWatcherClientSize(sessionId),
    alive: (sessionId) => pty.hasSession(sessionId)
  }
}

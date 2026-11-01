import type { SessionSource } from '../session/session'

/**
 * Which status-driven readers a terminal node may run, by the session it renders under (bug D).
 *
 * A team tab's node now reads its HOST session's agent status (Task 5), so a blocked relay node
 * carries a `pendingId` and its agent session id is known. Each reader below turns that status into
 * an action on THIS machine, or a write to the host's canvas, so a node whose core lives elsewhere
 * must not run it:
 *  - `approvalButtons`: Approve/Deny answer through `window.nodeTerminal.answerPermission`, the
 *    LOCAL main's permission server, which holds no ticket for the host's session.
 *  - `titleSync`: the session-name poll adopts the name into the node's title, i.e. writes the
 *    host's canvas on a timer, from every tab that has the node mounted.
 *  - `transcriptSearch`: the find bar's transcript leg reads `window.nodeTerminal.claude`, this
 *    machine's transcripts — a stranger's session, or nothing, for the host's id.
 *  - `chatView`: ⌘M opens the transcript view instead of the Markdown output view; the relay api
 *    refuses its reads (`stub.chat`), so a relay node keeps the Markdown output view, which captures
 *    the host's pane over the session api.
 *
 * Only `'local'` runs them. That is the Electron app AND the Server Edition's own browser session,
 * whose core is the server it is served from (the same reading `offscreenCoreIsRemote` takes).
 * `'relay'` and `'server'` (a tab whose core is a remote Server Edition) both mean the core is
 * elsewhere and get nothing — the same split `offscreenCoreIsRemote` draws. A value this table does
 * not know fails closed, like a relay session.
 */
export interface RelayStatusGates {
  approvalButtons: boolean
  titleSync: boolean
  transcriptSearch: boolean
  chatView: boolean
}

const ALL: RelayStatusGates = Object.freeze({
  approvalButtons: true,
  titleSync: true,
  transcriptSearch: true,
  chatView: true
})
const NONE: RelayStatusGates = Object.freeze({
  approvalButtons: false,
  titleSync: false,
  transcriptSearch: false,
  chatView: false
})

const GATES: Readonly<Record<SessionSource, RelayStatusGates>> = Object.freeze({
  local: ALL,
  relay: NONE,
  server: NONE
})

/** The gates for a node rendering under a session of `source`. A shared frozen object per source,
 *  so a caller may read it in render and put its fields in effect deps. */
export function relayStatusGates(source: SessionSource): RelayStatusGates {
  return Object.hasOwn(GATES, source) ? GATES[source] : NONE
}

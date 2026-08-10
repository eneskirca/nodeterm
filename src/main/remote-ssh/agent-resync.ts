// Repair agent status after an SSH project's reverse hook tunnel comes back.
//
// Hook events are fire-and-forget POSTs through that tunnel, and nothing on the host queues them:
// an agent that finishes while the master is down loses its `done` for good. The node then sits at
// `working` on every surface until `sweepStaleWorking` guesses from silence 20 minutes later — so
// the user cannot tell "finished" from "waiting on a permission prompt" from "the CLI died".
//
// So when the tunnel is verified again, ask the host what is actually true. This module is the
// orchestration only: the judgement is the pure `decideNode` (core/remote-ssh/agent-resync-decide),
// and every side effect is an injected dep.

import { decideFromPane, decideNode } from '../../core/remote-ssh/agent-resync-decide'
import { sessionName } from '../../core/tmux-naming'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { AgentId } from '@shared/agents/config'

/**
 * How much of a remote transcript the resync reads — a SMALL tail, deliberately.
 *
 * This is not a transcript to display, it is a verdict on the last few records, and
 * `decideFromTranscriptTail` is built for exactly that: it only tracks tool calls opened INSIDE the
 * window, so anything older cannot pin the verdict. Hand it the read path's 5 MB cap instead and
 * that premise collapses — one stale unmatched `tool_use` from hours earlier in a long session
 * reads as `working` forever, and the sessions with the biggest transcripts are precisely the ones
 * whose badge the user most wants repaired. 64 KB comfortably holds the last few records (the
 * title poll's TITLE_TAIL_BYTES is the same order of magnitude) while staying cheap enough to pull
 * per working node, over a link that just proved flaky, on a watchdog that retries every 45s.
 */
export const RESYNC_TRANSCRIPT_TAIL_BYTES = 64 * 1024

export interface AgentResyncDeps {
  /** Nodes the mirror still believes are working (agent-status-mirror.workingNodes). */
  workingNodes: () => { nodeId: string; agentId?: string; sessionId?: string }[]
  /**
   * The nodeterm tmux session names the HOST is running, over this project's ControlMaster.
   *
   * This replaced a per-node lookup in our own live pty map. That map is emptied by
   * `PtyManager.kill()` on detach, so a backgrounded project — the case this feature exists for —
   * had no entries at all and every node was skipped. The host's session list survives detach,
   * which is the whole point of running the agents inside tmux.
   */
  hostSessionNames: () => Promise<Set<string>>
  /** `#{pane_current_command}` for the node's REMOTE tmux session, over the project's master. */
  paneCommand: (nodeId: string) => Promise<string | null>
  /** A bounded tail of the node's transcript on the host, or null when it can't be read. */
  readTranscriptTail: (nodeId: string, sessionId: string) => Promise<string | null>
  /** The single normalized-event funnel (main/index.ts emitAgentStatus). */
  emit: (e: NormalizedAgentEvent) => void
}

/**
 * Resync every working node the project's host is actually running.
 *
 * Only nodes the mirror calls `working` are considered: that is the one state a lost hook event can
 * strand. The opposite error — a node we believe idle that is really working — corrects itself
 * within seconds, because hook events fire continuously through a turn.
 *
 * Returns the node ids declared ended (for logging/tests). Never throws: a probe that fails is
 * `undecided`, and undecided changes nothing.
 */
export async function resyncProjectAgents(deps: AgentResyncDeps): Promise<string[]> {
  const ended: string[] = []
  let working: { nodeId: string; agentId?: string; sessionId?: string }[]
  try {
    working = deps.workingNodes()
  } catch {
    return ended // no list ⇒ nothing to repair, and still not a rejection for the reconnect path
  }

  // Nothing believed working ⇒ nothing to repair, and the listing below is an ssh exec. "Nothing
  // working" is the COMMON case on a reconnect, so asking the host first would spend a remote round
  // trip per reconnect per SSH project to learn something we already knew.
  if (working.length === 0) return ended

  // ONE listing for the whole project, and a failed listing repairs nothing: an empty set matches
  // no node, which is the same safe direction as every other failed probe here.
  let hostSessions: Set<string>
  try {
    hostSessions = await deps.hostSessionNames()
  } catch {
    return ended
  }

  for (const node of working) {
    // One node's failure is `undecided` for THAT node — never a project-wide abort. `emit` is the
    // real risk here: it fans out into the mirror reducer, the inbox, a disk write and the HUD, and
    // a throw there would otherwise cost every later node its rescue and reject into the reconnect.
    try {
      // A synthetic event carries an agentId by contract; without one we cannot emit a well-formed
      // event, and inventing an agent would misattribute the node on every surface.
      if (!node.agentId) continue
      // FORWARD match only. `sessionName` is lossy (every non-[a-zA-Z0-9_-] char becomes `_`), so
      // parsing a node id back out of a session name could attribute the host's session to the
      // wrong node — and a rescue `done` on the wrong node is a false completion notification.
      if (!hostSessions.has(sessionName(node.nodeId))) continue

      const pane = await probe(() => deps.paneCommand(node.nodeId))
      let tail: string | null = null
      // Only pay for the transcript read when the pane could not answer on its own.
      if (!isDecisivePane(pane) && node.sessionId) {
        const sessionId = node.sessionId
        tail = await probe(() => deps.readTranscriptTail(node.nodeId, sessionId))
      }

      if (decideNode(pane, tail) !== 'ended') continue

      // `idle: true` is the existing rescue-signal flag: a done carrying it may only move a node
      // that is still `working`, so a node parked on a permission prompt can never be cleared here.
      deps.emit({
        nodeId: node.nodeId,
        agentId: node.agentId as AgentId,
        kind: 'state',
        state: 'done',
        idle: true,
        ...(node.sessionId ? { sessionId: node.sessionId } : {})
      })
      ended.push(node.nodeId)
    } catch {
      continue
    }
  }
  return ended
}

/**
 * Run one probe, degrading any failure to `null` — which `decideNode` reads as no evidence.
 *
 * The call itself is inside the try, not just the promise: a dep that throws SYNCHRONOUSLY never
 * returns a promise to `.catch`, so it would escape to the loop's guard and cost the node its OTHER
 * probe leg. One failed probe must only silence that probe.
 */
async function probe(run: () => Promise<string | null>): Promise<string | null> {
  try {
    return await run()
  } catch {
    return null
  }
}

/**
 * Did the pane probe settle it by itself? Asks `decideFromPane` directly — that IS the question,
 * and going through `decideNode` would make the answer depend on an internal ordering (its
 * pane-first short circuit) rather than on the pane verdict itself.
 */
function isDecisivePane(pane: string | null): boolean {
  return decideFromPane(pane) === 'ended'
}

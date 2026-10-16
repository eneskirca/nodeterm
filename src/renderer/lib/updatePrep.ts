// Prepare-for-update (Windows session host, issue #829) — the PURE half of the flow: given what the
// running host holds and what the app knows about each node, decide which sessions block the
// update, which agents get asked to quit cleanly first, and what the confirm dialog must say will
// stop. Every rule here is a refusal or a disclosure, never a guess:
//
//   • a session whose agent is WORKING, waiting on a question or blocked on an approval blocks the
//     whole flow — ending it would abandon a turn or throw away the dialog's answer. Either source
//     saying so is enough: the renderer's store (live for mounted nodes) or core's status mirror
//     (which also covers nodes in projects that are not on screen, closed projects included);
//   • only a node that is MOUNTED can be asked to `/exit` (its pane closure is registered by the
//     node itself); an agent in an unmounted project is listed as "stops without a clean exit" —
//     its conversation resumes from its last saved turn;
//   • a host session no project knows (an orphan) is still ended and is counted, never hidden.
//
// Nothing here ever deletes a node: the update ends processes, and the canvas cold-restores.

import { canResume } from '@shared/agents/config'
import { nodeSessionName } from '@shared/session-name'
import { exitSequence } from '../terminal/agent-restart'
import { agentProcessInPane } from '../terminal/live-work'

export interface PrepNode {
  nodeId: string
  projectId: string
  projectName: string
  /** The project is closed (parked in "Recently closed"); its sessions still run on the host. */
  projectClosed: boolean
  title: string
  /** The agent the node runs (`data.agentId`); undefined for a plain terminal. */
  agentId?: string
}

export interface PrepStatus {
  state?: string
  sessionId?: string
  hibernated?: boolean
  paused?: boolean
  dropped?: boolean
  sessionEnded?: boolean
}

export interface PrepMirror {
  state?: string
  /** An unanswered question or approval ticket is held for this node. */
  attention?: boolean
}

export type PrepRowKind =
  /** Working / waiting / blocked — the flow refuses until it settles. */
  | 'busy'
  /** Idle agent on a mounted node: will be asked to quit cleanly before the shutdown. */
  | 'exit'
  /** Idle agent that cannot be asked to quit (its project is not on screen): stops with the host. */
  | 'agent-unreachable'
  /** Agent CLI already left the pane (Eco, Pause, its own /exit): only the shell remains. */
  | 'agent-exited'
  /** Agent we cannot exit-and-resume (custom agent without a base, no session id yet). */
  | 'agent-no-resume'
  /** A plain terminal: its shell and anything running in it stop. */
  | 'shell'
  /** A host session no project knows. Still ended. */
  | 'orphan'

export interface PrepRow {
  session: string
  kind: PrepRowKind
  node?: PrepNode
  /** For `busy`: what it is doing, in words. */
  busyReason?: 'working' | 'needs-you'
}

export interface UpdatePrepPlan {
  rows: PrepRow[]
  blocking: PrepRow[]
  toExit: PrepRow[]
}

const BUSY_STATES = new Set(['working'])
const ATTENTION_STATES = new Set(['waiting', 'blocked'])

export function planUpdatePrep(input: {
  sessions: readonly string[]
  nodes: readonly PrepNode[]
  statusOf: (nodeId: string) => PrepStatus | undefined
  mirrorOf: (session: string) => PrepMirror | undefined
  /** A mounted node registered its update-exit closure. */
  canExitInPlace: (nodeId: string) => boolean
}): UpdatePrepPlan {
  const byName = new Map<string, PrepNode>()
  for (const node of input.nodes) {
    const name = nodeSessionName(node.nodeId)
    // First one wins: two projects holding the same node id (a worktree checkout) attach the same
    // session, and either is a correct name for it.
    if (!byName.has(name)) byName.set(name, node)
  }
  const rows: PrepRow[] = []
  for (const session of input.sessions) {
    const node = byName.get(session)
    const mirror = input.mirrorOf(session)
    if (!node) {
      // A session the canvas does not know can still carry a live agent the mirror reports.
      const busy = busyReason(undefined, mirror)
      rows.push(busy ? { session, kind: 'busy', busyReason: busy } : { session, kind: 'orphan' })
      continue
    }
    const status = input.statusOf(node.nodeId)
    const busy = busyReason(status, mirror)
    if (busy) {
      rows.push({ session, node, kind: 'busy', busyReason: busy })
      continue
    }
    if (!node.agentId) {
      rows.push({ session, node, kind: 'shell' })
      continue
    }
    if (!agentProcessInPane(node.agentId, status)) {
      rows.push({ session, node, kind: 'agent-exited' })
      continue
    }
    if (!canResume(node.agentId) || !exitSequence(node.agentId) || !status?.sessionId) {
      rows.push({ session, node, kind: 'agent-no-resume' })
      continue
    }
    rows.push({
      session,
      node,
      kind: input.canExitInPlace(node.nodeId) ? 'exit' : 'agent-unreachable'
    })
  }
  return {
    rows,
    blocking: rows.filter((r) => r.kind === 'busy'),
    toExit: rows.filter((r) => r.kind === 'exit')
  }
}

function busyReason(
  status: PrepStatus | undefined,
  mirror: PrepMirror | undefined
): PrepRow['busyReason'] {
  if (mirror?.attention) return 'needs-you'
  if (ATTENTION_STATES.has(status?.state ?? '') || ATTENTION_STATES.has(mirror?.state ?? ''))
    return 'needs-you'
  if (BUSY_STATES.has(status?.state ?? '') || BUSY_STATES.has(mirror?.state ?? '')) return 'working'
  return undefined
}

/** The confirm dialog's sentences about what will stop, by count. Pure so the wording is tested.
 *  `plan` is the one taken AFTER the clean exits ran, so any row still `exit` is an agent that did
 *  not quit; `exited` is how many did. */
export function updatePrepStopSummary(plan: UpdatePrepPlan, exited: number): string[] {
  const count = (k: PrepRowKind): number => plan.rows.filter((r) => r.kind === k).length
  const lines: string[] = []
  const shells = count('shell')
  const unreachable = count('agent-unreachable') + count('agent-no-resume')
  const exitFailed = count('exit')
  if (plan.rows.length > 0) {
    lines.push(
      `Every process still running in these ${plan.rows.length} session${
        plan.rows.length === 1 ? '' : 's'
      } will stop.`
    )
  }
  if (exited > 0) lines.push(`${exited} agent${exited === 1 ? '' : 's'} exited cleanly and will resume.`)
  if (exitFailed > 0)
    lines.push(
      `${exitFailed} agent${exitFailed === 1 ? '' : 's'} did not exit and will be stopped; ` +
        'each resumes from its last saved turn where its CLI supports --resume.'
    )
  if (unreachable > 0)
    lines.push(
      `${unreachable} agent${unreachable === 1 ? ' is' : 's are'} not open on the canvas (or cannot be ` +
        'exited cleanly) and will be stopped; they resume from their last saved turn where supported.'
    )
  if (shells > 0)
    lines.push(
      `${shells} plain terminal${shells === 1 ? '' : 's'}: anything running there stops and unsaved ` +
        'work in them is lost.'
    )
  if (count('orphan') > 0)
    lines.push(`${count('orphan')} session${count('orphan') === 1 ? '' : 's'} not on any canvas will also stop.`)
  lines.push('Canvas nodes are kept. Agents resume with --resume on the next launch.')
  return lines
}

/**
 * The prepare dialog's first screen for a running host (U3). A host running from its STAGED copy
 * (0.4.1+) maps none of the installed files, so a plain quit lets the installer run and every
 * session keeps running — that is offered first, and stopping sessions becomes the explicit
 * secondary path (`stopAnyway`). A legacy/install-dir host, or one whose location is unknown,
 * keeps the stop flow unchanged: `staged` is only ever true on a positive classification.
 */
export type PrepareEntry = 'quit-keeps-sessions' | 'stop-sessions'

export function prepareEntry(inspection: { kind: string; staged?: boolean }, stopAnyway: boolean): PrepareEntry {
  return inspection.kind === 'host' && inspection.staged === true && !stopAnyway
    ? 'quit-keeps-sessions'
    : 'stop-sessions'
}

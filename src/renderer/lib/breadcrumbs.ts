import type { NavStop, NodeKind } from '@shared/types'
import type { AgentId } from '@shared/agents/config'
import { agentConfig } from '@shared/agents/config'
import type { AgentNodeStatus } from '../state/agentStatus'
import { sessionStatusKind, STATE_LABEL } from './sessionList'

/** Camera navigation history is capped so it never grows unbounded on a long-lived project. */
export const BREADCRUMB_CAP = 20

/** Recording the same node twice inside this window is a no-op — a focus that immediately
 *  re-triggers (e.g. a sidebar click into an already-focused node) must not spam the trail. */
export const BREADCRUMB_DEDUPE_MS = 3000

const KIND_LABEL: Partial<Record<NodeKind, string>> = {
  terminal: 'terminal',
  sticky: 'sticky',
  editor: 'editor',
  diff: 'diff',
  video: 'video',
  web: 'web',
  browser: 'browser',
  dino: 'dino',
  whiteboard: 'whiteboard',
  pull: 'pull request',
  group: 'group'
}

/** The subset of a node `recordBreadcrumb`/`buildNote` need — loose on purpose so callers can
 *  pass a live React Flow node or a plain object without importing its full type. */
export interface BreadcrumbTarget {
  id: string
  kind: NodeKind | undefined
  title: string
  agentId?: AgentId
}

/** One project's breadcrumb array plus a cursor into it. The cursor is NOT persisted — only
 *  `list` rides `IndexEntryV3.breadcrumbs`; a project reactivation resets the cursor to the tip. */
export interface BreadcrumbState {
  list: NavStop[]
  index: number
}

/**
 * The note is a SNAPSHOT of what was happening at record time, not a live pointer — a later
 * state change must not retroactively rewrite history. For an agent node it mirrors the exact
 * phrasing the sessions sidebar already uses (`sessionStatusKind` + `STATE_LABEL`), so the note
 * is never an invented-fresh string; the session name (if set) is preferred over the bare agent
 * label, same precedence the header chip follows.
 */
export function buildNote(target: BreadcrumbTarget, status: AgentNodeStatus | undefined): string {
  if (target.agentId) {
    // agentConfig, not a raw AGENT_CONFIG lookup: AgentId is `BuiltinAgentId | (string & {})` (a
    // custom agent's id), and AGENT_CONFIG is only keyed by the builtin subset — indexing it
    // directly with a custom id fails to typecheck. agentConfig(id) exists for exactly this.
    const agentLabel = agentConfig(target.agentId)?.label ?? target.agentId
    // The node's own title comes before the bare agent label: it auto-tracks the session name
    // (`titleAuto`) and carries any manual rename, so an agent node with no live session AND no
    // hook state (the norm right after an app restart — `agentStatus.state` is transient) still
    // names the node instead of degrading to a generic "Claude Code · Unknown".
    const name = status?.session || target.title || agentLabel
    const stateLabel = STATE_LABEL[sessionStatusKind(status?.state)]
    return `${name} · ${stateLabel}`
  }
  // A missing kind defaults to 'terminal'; there is deliberately NO generic fallback beyond it —
  // goToNode refuses the only kinds KIND_LABEL omits (subagent/loop), so a dead `?? 'node'` arm
  // would just be an untestable claim.
  const kindLabel = KIND_LABEL[target.kind ?? 'terminal']
  return `${kindLabel} · ${target.title}`
}

/**
 * Records a deliberate node landing. Browser-style history: if the cursor is not at the tip (the
 * user went back, then navigated somewhere new — not via stepBreadcrumb), the forward tail is
 * dropped before the new stop is appended, exactly like a browser tab's history after navigating
 * away from a back-visited page.
 *
 * Returns the SAME object (by reference) when the call is a no-op dedupe, so callers can skip a
 * write (`next === state`) instead of comparing array contents.
 */
export function recordBreadcrumb(
  state: BreadcrumbState,
  target: BreadcrumbTarget,
  status: AgentNodeStatus | undefined,
  now: number
): BreadcrumbState {
  const current = state.list[state.index]
  if (current && current.nodeId === target.id && now - current.at < BREADCRUMB_DEDUPE_MS) {
    return state
  }
  const truncated = state.list.slice(0, state.index + 1)
  const appended: NavStop[] = [
    ...truncated,
    { nodeId: target.id, at: now, note: buildNote(target, status) }
  ]
  const capped = appended.length > BREADCRUMB_CAP
    ? appended.slice(appended.length - BREADCRUMB_CAP)
    : appended
  return { list: capped, index: capped.length - 1 }
}

/**
 * Moves the cursor one stop back/forward, skipping any breadcrumb whose node no longer exists
 * (never landing on a dead entry). Returns null when there is no reachable stop in that
 * direction — callers no-op rather than move the camera.
 */
export function stepBreadcrumb(
  state: BreadcrumbState,
  direction: 'back' | 'forward',
  nodeExists: (nodeId: string) => boolean
): BreadcrumbState | null {
  const delta = direction === 'back' ? -1 : 1
  let i = state.index + delta
  while (i >= 0 && i < state.list.length) {
    if (nodeExists(state.list[i].nodeId)) return { list: state.list, index: i }
    i += delta
  }
  return null
}

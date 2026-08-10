// WHICH CANVAS answers a canvas-control request — the routing half of the `nodeterm` CLI's
// authorization boundary (Canvas's onAgentControl effect). Pure, so it is unit-testable where the
// React component is not (vitest runs in the node environment); same reasoning as presenceTravel,
// whose project-travel rules this reuses.
//
// WHY IT EXISTS: React Flow only ever holds the ACTIVE project's nodes, but tmux sessions of every
// OTHER open project keep running — they survive an app restart and are re-adopted on boot. Their
// agents still hold NODETERM_CANVAS_CONTROL and still reach the (rewritten) hook endpoint, so their
// control calls arrive at a canvas that has never heard of the source node. Looking the source up
// in the live canvas alone therefore rejected every agent outside the project the app happened to
// come up on — reported as "source node is not a control-capable agent", which is what a node
// carrying a non-control agent gets, so the failure read as a lost capability rather than as the
// wrong canvas answering. Resolve the OWNING project instead, then travel to it (or, for a verb
// that reads and changes nothing, answer straight out of its serialized nodes).

import { canControlCanvas, type AgentId } from '@shared/agents/config'
import { projectTravel } from './presenceTravel'

/** The little the routing needs to know about a project (a structural subset of `Project`). */
export interface ControlProject {
  id: string
  closed?: boolean
  unavailable?: boolean
  nodes: readonly { id: string }[]
}

/** A serialized node, as the projects store keeps them for non-active projects. */
export interface StoredNode {
  id: string
  kind?: string
  title?: string
}

/**
 * Where a control request must be applied:
 * - `active`  — the source is on the live canvas (or its project is already active): apply here.
 * - `switch`  — an open project's canvas: activate that tab first.
 * - `reopen`  — a closed project (its sessions still run): restore the tab, then activate it.
 * - `blocked` — a project whose files are unreadable: travelling there would show an empty canvas.
 * - `unknown` — no open project owns this node id.
 */
export type ControlRoute =
  | { kind: 'active' }
  | { kind: 'switch'; projectId: string }
  | { kind: 'reopen'; projectId: string }
  | { kind: 'blocked'; projectId: string }
  | { kind: 'unknown' }

/** Which project owns `sourceNodeId`, and what Canvas must do to be able to act on it. */
export function routeControlSource(
  projects: readonly ControlProject[],
  activeProjectId: string,
  sourceNodeId: string
): ControlRoute {
  const owner = projects.find((p) => p.nodes.some((n) => n.id === sourceNodeId))
  if (!owner) return { kind: 'unknown' }
  const travel = projectTravel(
    projects.map((p) => ({ id: p.id, closed: p.closed, unavailable: p.unavailable, nodes: [] })),
    activeProjectId,
    owner.id
  )
  // `none` means "already there" — the live canvas is the right one even if its store copy lags.
  if (travel.kind === 'none') return { kind: 'active' }
  if (travel.kind === 'blocked') return { kind: 'blocked', projectId: owner.id }
  return travel
}

/**
 * Does this verb have to run against the LIVE canvas? Everything that creates, moves, writes to or
 * closes a node does. `list` reads names only, and it is the verb an agent calls most — answering
 * it out of the store keeps a background agent's polling from yanking the user's view to another
 * project tab on every call.
 */
export function needsLiveCanvas(verb: string): boolean {
  return verb !== 'list'
}

/**
 * The capability half of the guard: may a session in this node drive the canvas?
 *
 * The empty/absent default MIRRORS pty-manager's spawn-time default (`options.agentId ?? 'claude'`):
 * a plain terminal node received the claude hook env at spawn, so a manual `claude` there holds
 * NODETERM_CANVAS_CONTROL — rejecting it here would contradict the env it was handed.
 */
export function sourceIsControlCapable(agentId: unknown): boolean {
  const id = typeof agentId === 'string' && agentId ? agentId : 'claude'
  return canControlCanvas(id as AgentId)
}

/** `list`'s rows, built from serialized nodes — the same shape the live canvas answers with
 *  (`n.type` is the persisted `kind`, `n.data.title` the persisted `title`). */
export function storedNodeListing(
  nodes: readonly StoredNode[]
): { id: string; kind: string; title: string }[] {
  return nodes.map((n) => ({ id: n.id, kind: n.kind ?? 'terminal', title: n.title ?? '' }))
}

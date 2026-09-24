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
import { controlLaunchState, type LaunchDelivery, type StatusById } from './pendingLaunch'
import { projectTravel } from './presenceTravel'
import {
  projectCapabilityGrantedFor,
  type CapabilityAckMap
} from '@shared/project-capability-consent'

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
  pendingLaunch?: unknown
  agentId?: string
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
 * The off-screen verb table lives in `@shared/control-off-screen` because CORE renders the
 * agent-facing help from it and core cannot import the renderer. Re-exported here so every
 * renderer caller keeps one import for "how does canvas control route".
 */
export {
  needsLiveCanvas,
  canColdOpen,
  answersOffCanvas,
  answersFromStoredNodes,
  offScreenDisposition,
  offScreenRefusal,
  offScreenGuidanceLines,
  controlVerbSetsForTests,
  type OffScreenDisposition
} from '@shared/control-off-screen'

/**
 * The capability half of the guard: may a session in this node drive the canvas?
 *
 * Plain terminals are not agent nodes. Treating missing identity as Claude made a bare shell look
 * control-capable and let recovery code relabel it as an agent. A hand-launched CLI is still
 * observable through its runtime hooks, but the serialized node does not gain agent authority.
 */
export function sourceIsControlCapable(agentId: unknown): boolean {
  return typeof agentId === 'string' && agentId.length > 0 && canControlCanvas(agentId as AgentId)
}

/**
 * The `browser` verb's resolve answer — the two things ONLY the renderer knows, computed purely so
 * Canvas.tsx's IPC handler is a thin wrapper testable here. Main asks over `browserControlResolve`,
 * makes the security decision itself (owner + capability + CDP gate), and does the CDP work; this
 * function NEVER touches a debugger.
 *
 * WHY MAIN STILL DECIDES from these facts: an XSS-in-a-node-title-style bug lands in the renderer,
 * the more attackable half, so the allowlist and the ledger stay main-side. The renderer reports
 * facts (does this node's project exist, is the source control-capable, is the capability on right
 * now — read LIVE via `projectCapabilityGrantedFor`, never cached); main re-orders them into the
 * refusal decision in `browser-drive.ts`.
 */
export interface BrowserResolveNode {
  id: string
  agentId?: unknown
  /** The node's display title — reported so main can make the cookie-read trace human-readable
   *  (PR 9). Never a security input. */
  title?: string
}
export interface BrowserResolveProject {
  id: string
  cwd?: string
  agentBrowserControl?: boolean
  capabilityAck?: CapabilityAckMap
  nodes: readonly BrowserResolveNode[]
}
export type BrowserResolveAnswer =
  | { ok: false; refusal: string }
  | {
      ok: true
      projectId: string
      projectCwd?: string
      sourceControlCapable: boolean
      capabilityOn: boolean
      /** The owner (source) agent node's title and the driven browser node's title — for the cookie
       *  trace only. Empty string when unknown; main falls back to the node id. */
      sourceTitle: string
      browserTitle: string
    }

export function answerBrowserResolve(
  project: BrowserResolveProject | undefined,
  sourceNodeId: string,
  browserNodeId?: string
): BrowserResolveAnswer {
  // No open project owns the source, or the node is not on its canvas: a named, non-revoking
  // refusal. (Same class as every other verb's "source node is not on an open canvas".)
  if (!project) return { ok: false, refusal: 'source node is not on an open canvas' }
  const node = project.nodes.find((n) => n.id === sourceNodeId)
  if (!node) return { ok: false, refusal: 'source node is not on an open canvas' }
  const browserNode = browserNodeId ? project.nodes.find((n) => n.id === browserNodeId) : undefined
  return {
    ok: true,
    projectId: project.id,
    projectCwd: project.cwd,
    sourceControlCapable: sourceIsControlCapable(node.agentId),
    // LIVE read — the drive-time capability check the whole feature's safety rests on. A project.json
    // hand-edit that flipped the switch off is reflected here the next time an agent drives, which is
    // exactly drive time.
    // `{}`: browser control has no machine default (CAPABILITY_MACHINE_DEFAULTS) — an absent switch is
    // off, and no setting on this machine can change that.
    capabilityOn: projectCapabilityGrantedFor(project, 'agentBrowserControl', {}),
    sourceTitle: typeof node.title === 'string' ? node.title : '',
    browserTitle: typeof browserNode?.title === 'string' ? browserNode.title : ''
  }
}

/** `list`'s rows, built from serialized nodes — the same shape the live canvas answers with
 *  (`n.type` is the persisted `kind`, `n.data.title` the persisted `title`). */
export function storedNodeListing(
  nodes: readonly StoredNode[],
  statuses: StatusById & Record<string, { dropped?: boolean } | undefined> = {},
  deliveries: Record<string, LaunchDelivery | undefined> = {}
) {
  return nodes.map((n) => {
    const status = statuses[n.id]
    const launchState = controlLaunchState(!!n.pendingLaunch, deliveries[n.id] ?? ((n.pendingLaunch as { manualOnly?: boolean } | undefined)?.manualOnly ? { kind: 'failed', attempts: 1, at: 0 } : undefined), status) ??
      (n.agentId && !status?.state ? 'unconfirmed' as const : undefined)
    return {
      id: n.id, kind: n.kind ?? 'terminal', title: n.title ?? '',
      ...(status?.lastTurnError ? { lastTurnErrored: true } : {}),
      ...(launchState ? { launchState } : {})
    }
  })
}

const launchLabels = {
  queued: 'QUEUED',
  failed: 'LAUNCH FAILED',
  stalled: 'QUEUED (terminal not ready)',
  dropped: 'DROPPED',
  working: 'WORKING',
  unconfirmed: 'AGENT STATUS UNCONFIRMED'
} as const

export function controlListingText(rows: ReturnType<typeof storedNodeListing>): string {
  return rows.map((n) => `${n.id} [${n.kind}] ${n.title}` +
    (n.launchState ? ` — ${launchLabels[n.launchState]}` : '') +
    (n.lastTurnErrored ? ' — LAST TURN ERRORED' : '')
  ).join('\n')
}

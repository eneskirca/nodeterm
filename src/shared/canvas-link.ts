// Pure planning for persisted canvas links. Both the desktop renderer and the headless server
// use this exact refusal/deduplication matrix; neither shell may grow its own approximation.
import type { BridgeLink } from './types'

export interface LinkEndpoint {
  /** Canvas node kind: 'terminal' | 'sticky' | 'editor' | … */
  kind: string
  /**
   * Terminal node whose agent is `CONTEXT_LINK_CAPABLE`. Deliberately not spelled out here: the
   * list has gained two members since this comment was written (opencode, then grok) and named
   * them wrong in between. Ask `canContextLink`; the list lives in `shared/agents/config.ts`.
   */
  contextCapable: boolean
}

// A project-scoped miss says nothing about existence elsewhere. Do not probe other projects
// just to improve this diagnostic: that would turn a refusal into an existence oracle.
export const LINK_PROJECT_ONLY = 'cross-project linking is not supported'
export const LINK_ENDPOINT_NOT_FOUND = `node not found in this project; ${LINK_PROJECT_ONLY}`
export const LINK_NOT_LINKABLE =
  'not linkable (needs two context-capable agents, an agent + a terminal, or a sticky + terminal)'

/** 'pane': a context-capable agent reads a plain terminal's screen (`terminal --node <id>`). It is
 *  always one-way toward the agent — the terminal has no agent to read anything back with. */
export type LinkKind = 'context' | 'note' | 'pane'

/** The endpoints of a context link, plus its optional one-way reader (issue #852). */
export interface LinkEdge {
  source: string
  target: string
  reader?: string
}

/** One granted read: `reader` may read `read`'s context. */
export interface LinkRead {
  reader: string
  read: string
}

/**
 * Who may READ whom across one CONTEXT link. This is the rule the read authorization is built
 * from (buildLinkMap → main's per-node link documents), so it is the enforcement point, not a
 * display hint. No `reader` = both directions (every link persisted before issue #852); a reader
 * that names neither endpoint grants nothing — a restriction that cannot be understood must not
 * fall back to the wider permission.
 */
export function linkReadPairs(edge: LinkEdge): LinkRead[] {
  const { source, target } = edge
  if (!('reader' in edge) || edge.reader === undefined) {
    return [
      { reader: source, read: target },
      { reader: target, read: source }
    ]
  }
  if (edge.reader === source) return [{ reader: source, read: target }]
  if (edge.reader === target) return [{ reader: target, read: source }]
  return []
}

/** A copy of `edge` made one-way toward `reader`, or bidirectional again for `null`. A reader
 *  that is not an endpoint changes nothing (returns the same object). */
export function withLinkReader<T extends LinkEdge>(edge: T, reader: string | null): T {
  if (reader === null) {
    const { reader: _dropped, ...rest } = edge
    return rest as T
  }
  if (reader !== edge.source && reader !== edge.target) return edge
  return { ...edge, reader }
}

/** Endpoints that may read after a direction change but could not before — the ones owed the
 *  same one-shot discovery note a freshly drawn link sends. Losing access sends nothing, exactly
 *  like removing a link. */
export function gainedReaders(before: LinkEdge, after: LinkEdge): string[] {
  const had = new Set(linkReadPairs(before).map((p) => p.reader))
  return linkReadPairs(after)
    .map((p) => p.reader)
    .filter((r) => !had.has(r))
}

/** Decide what kind of link (if any) a new edge between two nodes forms. */
export function classifyLink(a: LinkEndpoint, b: LinkEndpoint): LinkKind | null {
  const stickies = (a.kind === 'sticky' ? 1 : 0) + (b.kind === 'sticky' ? 1 : 0)
  if (stickies === 0) {
    if (a.contextCapable && b.contextCapable) return 'context'
    // Without this an orchestrator could open a terminal (a test run, a build, a sandbox) and
    // never see what happened in it — the owner had to paste the output back by hand.
    if (a.contextCapable !== b.contextCapable && (a.contextCapable ? b : a).kind === 'terminal') {
      return 'pane'
    }
    return null
  }
  if (stickies === 2) return null
  const other = a.kind === 'sticky' ? b : a
  return other.kind === 'terminal' ? 'note' : null
}

/** One node the plan refused to link, with the reason to report back to the caller. */
export interface SkippedBridge {
  id: string
  why: string
}

export interface BridgePlan {
  /** Edges to append (already deduped against `existing` AND within the batch). */
  edges: BridgeLink[]
  linked: string[]
  skipped: SkippedBridge[]
}

/**
 * Plan the link edges connecting `fromId` to each of `targetIds`.
 *
 * The caller supplies node lookup and the already-persisted edges, so this stays independent of
 * React/store/server state. Note edges normalize to sticky→terminal; every pair dedupes in either
 * direction. Creating the edges has no delivery side effect: context is always read on demand.
 * `options.oneWay` makes each new context edge readable by `fromId` only (issue #852).
 */
export function planBridges(
  fromId: string,
  targetIds: string[],
  lookup: (id: string) => LinkEndpoint | null,
  existing: readonly { source: string; target: string }[],
  options: { oneWay?: boolean } = {}
): BridgePlan {
  const edges: BridgeLink[] = []
  const linked: string[] = []
  const skipped: SkippedBridge[] = []
  const se = lookup(fromId)
  const linkedAlready = (a: string, b: string) =>
    [...existing, ...edges].some(
      (edge) =>
        (edge.source === a && edge.target === b) ||
        (edge.source === b && edge.target === a)
    )

  for (const targetId of targetIds) {
    if (targetId === fromId) {
      skipped.push({ id: targetId, why: 'same node' })
      continue
    }
    const te = lookup(targetId)
    if (!se || !te) {
      skipped.push({ id: targetId, why: LINK_ENDPOINT_NOT_FOUND })
      continue
    }
    const kind = classifyLink(se, te)
    if (!kind) {
      skipped.push({
        id: targetId,
        why: LINK_NOT_LINKABLE
      })
      continue
    }
    const source = kind === 'note' && te.kind === 'sticky' ? targetId : fromId
    const target = source === fromId ? targetId : fromId
    if (linkedAlready(source, target)) {
      skipped.push({ id: targetId, why: 'already linked' })
      continue
    }
    // `oneWay` (issue #852): `fromId` reads the targets, never the reverse. Note links are
    // already one-way (the terminal reads the sticky) and never carry a reader. A pane link is
    // one-way whatever was asked: only its agent end can read.
    const reader =
      kind === 'pane'
        ? se.contextCapable
          ? fromId
          : targetId
        : kind === 'context' && options.oneWay
          ? fromId
          : undefined
    edges.push(
      reader !== undefined
        ? { id: `bridge-${source}-${target}`, source, target, reader }
        : { id: `bridge-${source}-${target}`, source, target }
    )
    linked.push(targetId)
  }
  return { edges, linked, skipped }
}

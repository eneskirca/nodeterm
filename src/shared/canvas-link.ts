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

export type LinkKind = 'context' | 'note'

/** Decide what kind of link (if any) a new edge between two nodes forms. */
export function classifyLink(a: LinkEndpoint, b: LinkEndpoint): LinkKind | null {
  const stickies = (a.kind === 'sticky' ? 1 : 0) + (b.kind === 'sticky' ? 1 : 0)
  if (stickies === 0) return a.contextCapable && b.contextCapable ? 'context' : null
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
 */
export function planBridges(
  fromId: string,
  targetIds: string[],
  lookup: (id: string) => LinkEndpoint | null,
  existing: readonly { source: string; target: string }[]
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
        why: 'not linkable (needs two context-capable agents, or a sticky + terminal)'
      })
      continue
    }
    const source = kind === 'note' && te.kind === 'sticky' ? targetId : fromId
    const target = source === fromId ? targetId : fromId
    if (linkedAlready(source, target)) {
      skipped.push({ id: targetId, why: 'already linked' })
      continue
    }
    edges.push({ id: `bridge-${source}-${target}`, source, target })
    linked.push(targetId)
  }
  return { edges, linked, skipped }
}

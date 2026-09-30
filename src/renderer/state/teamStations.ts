import { create } from 'zustand'
import type { CanvasNodeState } from '@shared/types'
import type { CanvasNode } from './workspace'
import { stationsByOpener, type StationNodeLike, type TeamStation } from '../lib/teamProgress'

/**
 * The ACTIVE canvas's stations per opener (lib/teamProgress `stationsByOpener` over React Flow's
 * nodes and the live control ropes), published by Canvas so a terminal node's header can draw the
 * same team-progress ring its board card does without owning the ropes itself.
 *
 * TRANSIENT and derived: nothing here is persisted, and Canvas rewrites it whenever the nodes or
 * the ropes change. The map it holds keeps each unchanged team's array identity (the previous map
 * is threaded back in), so a node header subscribed to `byNode.get(id)` re-renders only when ITS
 * team changed.
 */
interface TeamStationsState {
  byNode: ReadonlyMap<string, readonly TeamStation[]>
  set: (byNode: ReadonlyMap<string, readonly TeamStation[]>) => void
}

/** No ropes, no teams — one shared empty map so the store and the board see a stable identity. */
export const NO_TEAMS: ReadonlyMap<string, readonly TeamStation[]> = new Map()
const EMPTY = NO_TEAMS

export const useTeamStations = create<TeamStationsState>((set) => ({
  byNode: EMPTY,
  set: (byNode) => set((s) => (s.byNode === byNode ? s : { byNode }))
}))

/** A live React Flow node, as `stationsByOpener` reads it. */
export function stationNodeFromFlow(n: CanvasNode): StationNodeLike {
  const data = (n.data ?? {}) as Record<string, unknown>
  return {
    id: n.id,
    kind: n.type,
    title: data.title,
    agentId: data.agentId,
    queued: !!data.pendingLaunch,
    openedBy: data.openedBy
  }
}

/** A serialized node (a project's `nodes` in the store — the Omni board's lanes). */
export function stationNodeFromState(n: CanvasNodeState): StationNodeLike {
  if (!n || typeof n !== 'object') return { id: undefined, kind: undefined }
  return {
    id: n.id,
    // Same reading as the Omni card list (toKanbanSessionState): a station is a node the lane draws.
    kind: n.kind,
    title: n.title,
    agentId: n.agentId,
    queued: !!n.pendingLaunch,
    openedBy: n.openedBy
  }
}

/**
 * The active canvas's teams, from its live control ropes and React Flow nodes. Canvas calls this on
 * every node change (a drag frame included), so it is cheap where it can be: a canvas with no ropes
 * and no team to clear — most of them — skips the node walk and keeps the previous identity.
 */
export function canvasTeamStations(
  ropes: readonly unknown[],
  nodes: readonly CanvasNode[],
  previous?: ReadonlyMap<string, readonly TeamStation[]>
): ReadonlyMap<string, readonly TeamStation[]> {
  if (ropes.length === 0 && (previous?.size ?? 0) === 0) return previous ?? NO_TEAMS
  return stationsByOpener(ropes, nodes.map(stationNodeFromFlow), previous)
}

import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from './workspace'
import { NO_TEAMS, canvasTeamStations, stationNodeFromFlow, stationNodeFromState, useTeamStations } from './teamStations'

const flow = (id: string, data: Record<string, unknown> = {}, type = 'terminal'): CanvasNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title: `T ${id}`, agentId: 'claude', ...data } }) as unknown as CanvasNode
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })

describe('the canvas side of team progress', () => {
  it('reads a live node, a held launch included', () => {
    expect(stationNodeFromFlow(flow('a', { pendingLaunch: { after: [], command: 'x' } }))).toEqual({
      id: 'a', kind: 'terminal', title: 'T a', agentId: 'claude', queued: true
    })
    expect(stationNodeFromState({ id: 'b', kind: 'sticky' } as never)).toMatchObject({ id: 'b', kind: 'sticky', queued: false })
    expect(() => stationNodeFromState(null as never)).not.toThrow()
  })

  it('a canvas with no ropes skips the walk and keeps one identity', () => {
    const nodes = [flow('a'), flow('b')]
    expect(canvasTeamStations([], nodes)).toBe(NO_TEAMS)
    const prev = canvasTeamStations([], nodes)
    expect(canvasTeamStations([], [...nodes, flow('c')], prev)).toBe(prev)
  })

  it('derives teams from the control ropes, and clears them when the last rope goes', () => {
    const nodes = [flow('o'), flow('a')]
    const teams = canvasTeamStations([rope('o', 'a')], nodes)
    expect(teams.get('o')?.map((s) => s.id)).toEqual(['a'])
    // A drag frame: same ropes, fresh node objects — same map.
    expect(canvasTeamStations([rope('o', 'a')], nodes.map((n) => ({ ...n })), teams)).toBe(teams)
    const cleared = canvasTeamStations([], nodes, teams)
    expect(cleared.size).toBe(0)
    expect(canvasTeamStations([], nodes, cleared)).toBe(cleared)
  })

  it('the store only notifies when the map changes', () => {
    const map = canvasTeamStations([rope('o', 'a')], [flow('o'), flow('a')])
    useTeamStations.getState().set(map)
    const before = useTeamStations.getState()
    useTeamStations.getState().set(map)
    expect(useTeamStations.getState()).toBe(before)
  })
})

// The wiring has no compiler behind it: a node header that never reads the store, or a Canvas that
// never publishes, is well-typed and shows nothing. Pinned at source level, like the other
// *-wiring tests, because rendering Canvas / TerminalNode here is out of reach.
describe('wiring', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
  it('Canvas derives the teams from its live control ropes and publishes them', () => {
    const canvas = read('../canvas/Canvas.tsx')
    expect(canvas).toContain('canvasTeamStations(controlEdges, nodes, teamStationsRef.current)')
    expect(canvas).toContain('useTeamStations.getState().set(teamStations)')
    expect(canvas).toContain('teams={teamStations}')
  })
  it('Canvas marks legacy wait ropes at load, before its prune can erase the order, and mints marked waits', () => {
    const canvas = read('../canvas/Canvas.tsx')
    expect(canvas).toContain('const restoredRopes = markLegacyWaitRopes(project.ropes ?? [])')
    expect(canvas).toContain('setControlEdges((es) => pruneRopes(es, ids))')
    expect(canvas).toContain('ropeEdge(waitRopeId(dep, nid), dep, nid)')
    // No wait rope is minted with the opener's id shape anywhere on the canvas.
    expect(canvas).not.toContain('ropeEdge(`ctrl-${dep}-')
  })
  it("the node header reads its OWN team from the store, never the whole status map", () => {
    const node = read('../nodes/TerminalNode.tsx')
    expect(node).toContain('useTeamStations((s) => s.byNode.get(id))')
    expect(node).toMatch(/<TeamProgressChip stations=\{team\} onTravel=\{travelToStation\}/)
  })
})

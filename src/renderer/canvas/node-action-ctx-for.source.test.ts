// Canvas `nodeActionCtxFor` decides, per project, whether a node's action rows act on the LIVE
// canvas or on the project's stored copy. The wrong branch lets an Omni lane of a background
// project act on (or write to) the canvas the user is looking at. Canvas cannot be mounted in a
// test, so both branches are pinned at source level here; the off-canvas context itself is
// behaviour-tested in lib/nodeActionItems.offCanvas.test.tsx.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

function body(): string {
  const start = src.indexOf('const nodeActionCtxFor = useCallback(')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('const boardNodeActionItems = useCallback(', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('Canvas nodeActionCtxFor', () => {
  it('takes the live branch only when React Flow holds THAT project', () => {
    const b = body()
    expect(b).toMatch(
      /if \(liveCanvasHolds\(nodesProjectIdRef\.current, useProjects\.getState\(\)\.activeProjectId, projectId\)\) \{/
    )
    const live = b.slice(b.indexOf('if (liveCanvasHolds('), b.indexOf('const project = '))
    // Live: the live context, but color/icon still go through the project's router.
    expect(live).toContain('...liveNodeActionCtx()')
    expect(live).toContain('setNodesColor: writes.setColor')
    expect(live).toContain('pickNodeIcon: writes.pickIcon')
    expect(live).toContain('liveLinkMenuItems: liveLink')
  })

  it('every other project gets the stored copy, its own session source and its own router', () => {
    const b = body()
    expect(b).toContain('const writes = nodeWritesFor(projectId)')
    // Up to the dependency array, which legitimately names liveNodeActionCtx.
    const stored = b.slice(b.indexOf('const project = '), b.indexOf('\n    [nodeWritesFor'))
    expect(stored.length).toBeGreaterThan(0)
    expect(stored).toContain('useProjects.getState().getProject(projectId)')
    expect(stored).toContain('offCanvasNodeActionCtx({')
    expect(stored).toContain('nodes: project ? nodeStatesToFlow(project.nodes) : []')
    expect(stored).toContain('sessionSource: sessionForProject(projectId).source')
    expect(stored).toMatch(/\n\s+writes,\n/)
    expect(stored).toContain('message: OFF_CANVAS_REFUSAL')
    // Never the live array or the active tab's session in the stored branch.
    expect(stored).not.toContain('nodesRef.current')
    expect(stored).not.toContain('session.source')
    expect(stored).not.toContain('liveNodeActionCtx')
  })

  it('board rows are filtered to BOARD_NODE_ACTION_IDS', () => {
    expect(src).toContain(
      'buildNodeActionItems([nodeId], undefined, nodeActionCtxFor(projectId), { allow: BOARD_NODE_ACTION_IDS })'
    )
  })

  it('card modal session rows are BOARD_MODAL_ACTION_IDS through nodeActionCtxFor, wired to both boards', () => {
    const start = src.indexOf('const boardSessionActionItems = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const decl = src.slice(start, src.indexOf('\n  )\n', start))
    expect(decl).toContain(
      'buildNodeActionItems([nodeId], undefined, nodeActionCtxFor(projectId), { allow: BOARD_MODAL_ACTION_IDS })'
    )
    // The per-project board is bound to the active project with a stable identity.
    expect(src).toMatch(
      /const activeBoardSessionActionItems = useCallback\(\n\s+\(nodeId: string\): MenuItem\[\] => boardSessionActionItems\(nodeId, activeProjectId\),/
    )
    // The Omni board asks per lane; the per-project board gets the active binding.
    expect(src).toContain('sessionActionItems={boardSessionActionItems}')
    expect(src).toContain('sessionActionItems={activeBoardSessionActionItems}')
  })
})

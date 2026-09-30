// Source pins for the kanban half of canvas sync (Task 6). Canvas.tsx cannot be rendered in the node
// test environment, so the load-bearing SHAPES are pinned here; the behaviour behind each lives in
// kanban-sync.test.ts (the publisher, and the store funnel + reducer together),
// projects.mutation.test.ts (the hook) and canvas-sync.convergence.test.ts (boards converge).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const store = readFileSync(new URL('../state/projects.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const omni = readFileSync(new URL('../components/kanban/GlobalKanbanView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** From `start` to the first `end` after it (the whole rest of the file if `end` is missing). */
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i, `missing: ${start}`).toBeGreaterThan(-1)
  const j = src.indexOf(end, i + start.length)
  return src.slice(i, j === -1 ? undefined : j)
}

/** The publisher effect: from the order's creation to its teardown. */
const publisherEffect = (): string => between(canvas, 'const order = createCanvasOrder(src)', 'orderRef.current = null')
/** The peer-mutation receive handler. */
const receiveHandler = (): string =>
  between(canvas, 'return activeSession.api.canvas.onMutation((projectId, received) => {', '}, [activeSession.api, setNodes')

describe('kanban sync wiring', () => {
  it('Canvas registers the kanban publish hook and clears it', () => {
    const body = publisherEffect()
    expect(body).toMatch(/setKanbanPublishHook\(\(id, prev, next\) => kanbanPublisher\.publish\(id, prev, next\)\)/)
    expect(body).toMatch(/setKanbanPublishHook\(null\)/)
  })

  // The board ops ride the SAME cast as the nodes and edges: one order stamps and records them, one
  // gate decides whether anything is published at all (Task 9 extends that ONE gate).
  it('the kanban publisher casts through castFor and asks the node publisher’s gate', () => {
    const body = publisherEffect()
    expect(body).toContain('send: (projectId, m) => castFor(projectId, m)')
    expect(body).toContain('liveNodeIds: (projectId) => liveNodeIdsFor(projectId)')
    expect(body).toContain('shouldPublish: (projectId) => shouldPublishFor(projectId)')
    // R2: the repaired form lands through the store reducer, never through setProjectKanban.
    expect(body).toContain('applyLocal: (projectId, m) => applyToStored(projectId, m)')
    // …and the node publisher goes through the very same two functions.
    expect(body).toMatch(/return castFor\(projectId, m\)/)
    expect(body).toContain('shouldPublish: () => shouldPublishFor(useProjects.getState().activeProjectId)')
    expect(body).not.toMatch(/setProjectKanban\(/)
  })

  // Only the core whose echoes THIS order hears may be cast to: our own echo is our ack (rule 1), and
  // an echo from a core nobody subscribed never comes back to draw the pending entry down.
  it('castFor refuses a project on another core, and casts through the bound session', () => {
    const body = between(canvas, 'const castFor = (projectId: string, m: CanvasMutation): boolean => {', 'const pub = createCanvasPublisher(')
    expect(body).toContain('if (sessionForProject(projectId).api !== activeSession.api) return false')
    expect(body).toContain('const stamped = order.stamp({ ...m, src })')
    expect(body).toContain('activeSession.api.canvas.mutate(projectId, stamped)')
    const gate = between(canvas, 'const shouldPublishFor = (projectId: string): boolean =>', 'const pub = createCanvasPublisher(')
    expect(gate).toContain('sessionForProject(projectId).api === activeSession.api')
    expect(gate).toContain('hasPeersRef.current')
    expect(gate).toContain('!isHostedReadOnly(activeSession.id)')
  })

  // Never a mix of two projects: the rendered project's ids come from the epoch pair, every other
  // project's from the store.
  it('the live node ids are the epoch-correct set for the project asked about', () => {
    const body = between(canvas, 'const liveNodeIdsFor = (projectId: string): ReadonlySet<string> =>', 'const castFor = ')
    expect(body).toContain('boardLiveNodeIds({')
    expect(body).toMatch(/rendered: nodesProjectIdRef\.current === projectId \? nodesRef\.current\.map\(\(n\) => n\.id\) : null/)
    expect(body).toMatch(/stored: \(useProjects\.getState\(\)\.getProject\(projectId\)\?\.nodes \?\? \[\]\)\.map\(\(n\) => n\.id\)/)
    // N4: no Omni term — the Omni board's active lane prunes against React Flow too.
    expect(body).not.toContain('omniOpen')
    expect(body).not.toContain('isGlobalKanbanOpen')
  })

  // R7: the solo path (~20 Hz while dragging) asks the cheap question first.
  it('the one gate asks for a peer before it resolves any session', () => {
    const gate = between(canvas, 'const shouldPublishFor = (projectId: string): boolean =>', 'const pub = createCanvasPublisher(')
    expect(gate.indexOf('hasPeersRef.current')).toBeGreaterThan(-1)
    expect(gate.indexOf('hasPeersRef.current')).toBeLessThan(gate.indexOf('sessionForProject('))
  })

  // R7: spec §2 batch order — node adds before card adds. A board write casts at once from the
  // store funnel; `setNodes` lands on a later render. So a site that files a FRESH node's card casts
  // the node first.
  it('a fresh node is cast before the board write that files its card', () => {
    const helper = between(canvas, 'const castNewNodeNow = useCallback(', '[publishableLater]')
    expect(helper).toContain('if (nodesProjectIdRef.current !== projectId || loadingRef.current) return')
    expect(helper).toContain('if (!nodesRef.current.some((n) => n.id === node.id)) nodesRef.current = [...nodesRef.current, node]')
    expect(helper).toContain('publisherRef.current?.publish(publishableLater(nodesRef.current))')
    for (const [start, cast] of [
      ['const createNodeInColumn = useCallback(', 'castNewNodeNow(targetProjectId, node)'],
      ['const fileIssueSession = useCallback(', 'castNewNodeNow(targetProjectId, created.placed)']
    ]) {
      const body = between(canvas, start, 'useBoardLog.getState().append(')
      expect(body.indexOf(cast), start).toBeGreaterThan(-1)
      expect(body.indexOf(cast), start).toBeLessThan(body.indexOf('setProjectKanban('))
    }
    // …and the node cast is the one React Flow will hold: `addAgentNode` hands back the node as placed.
    expect(canvas).toContain('return { node, placed, projectId: targetProjectId }')
  })

  it('peer kanban ops are applied through the store reducer, never through setProjectKanban', () => {
    const recv = receiveHandler()
    expect(recv).toMatch(/if \(isKanbanOp\(mutation\)\) \{\s*applyToStored\(projectId, mutation\)\s*return\s*\}/)
    // Before the edge and node branches: a board op never touches React Flow, active project or not.
    expect(recv.indexOf('isKanbanOp(mutation)')).toBeLessThan(recv.indexOf('isEdgeMutation(mutation)'))
    expect(recv).not.toMatch(/setProjectKanban\(/)
    // The body is `applyToStoredCopy` (behaviour-tested in kanban-sync.test.ts, D12); Canvas only
    // hands it the save trigger.
    const apply = between(canvas, 'const applyToStored = useCallback(', '[markDirty]')
    expect(apply).toContain('applyToStoredCopy(projectId, mutation, markDirty)')
  })

  // Spec §5: only the originating client records a board-log entry — a client applying a peer's op
  // records nothing, or every move would be logged once per connected client.
  it('applying a peer op never appends to the board log', () => {
    const recv = receiveHandler()
    expect(recv).not.toMatch(/useBoardLog|boardLogEvents|\.append\(/)
  })

  // Spec §11.4: a relay tab's board log lives on its host. The board and the Omni board sit OUTSIDE
  // the per-session provider, so the mount-time `api` is the LOCAL core's.
  it('board-log appends use the project session', () => {
    const cb = canvas.slice(canvas.indexOf('boardLogEvents('), canvas.indexOf('boardLogEvents(') + 800)
    expect(cb).toMatch(/sessionForProject\(/)
    expect(canvas).not.toMatch(/useBoardLog\.getState\(\)\.append\(api,/)
    // The Omni board resolves the lane's session once (main's #1041 also needs it for the hosted
    // read-only refusal) and appends through it.
    expect(omni).toMatch(/const session = sessionForProject\(projectId\)/)
    expect(omni).toMatch(/useBoardLog\.getState\(\)\.append\(session\.api, projectId,/)
    expect(omni).not.toMatch(/useBoardLog\.getState\(\)\.append\(api,/)
  })

  it('setProjectKanban publishes after writing', () => {
    const fn = store.slice(store.indexOf('setProjectKanban(id, kanban) {'), store.indexOf('setProjectKanban(id, kanban) {') + 600)
    expect(fn).toMatch(/const prev = get\(\)\.getProject\(id\)\?\.kanban[\s\S]*set\(\(s\) =>[\s\S]*kanbanPublishHook\?\.\(id, prev, kanban\)/)
  })
})

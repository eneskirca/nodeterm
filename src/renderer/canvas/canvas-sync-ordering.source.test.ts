// Source pins for the ordering hardening of canvas sync (Task 3). Canvas.tsx cannot be rendered in
// the node test environment, so the load-bearing SHAPES are pinned here; the behaviour behind each is
// tested where it lives (canvas-order.test.ts, canvas-publish.test.ts,
// canvas-sync.convergence.test.ts, nodesEpoch.test.tsx).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The ONE cast both publishers send through (`castFor` — the node/edge publisher for the active
 *  project, the kanban publisher for whichever project a board write touched), from its creation to
 *  the cast. Task 6 moved the body here out of the node publisher's own send callback. */
function sendCallback(): string {
  const start = src.indexOf('const castFor = (projectId: string, m: CanvasMutation): boolean => {')
  expect(start).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('activeSession.api.canvas.mutate(projectId, stamped)', start))
}

/** The peer-mutation receive handler. */
function receiveHandler(): string {
  const start = src.indexOf('return activeSession.api.canvas.onMutation((projectId, received) => {')
  return src.slice(start, src.indexOf('}, [activeSession.api, setNodes, setLinkEdges', start))
}

describe('the re-creation gate (canvas-order hasPendingRemove)', () => {
  // A re-creation cast before our own remove's echo carries a `seen` below that remove, and every
  // peer drops it as a stale frame (rule 4) while we keep showing it.
  it('the send callback holds a non-remove op whose key has our remove in flight', () => {
    const body = sendCallback()
    const gate = body.indexOf('if (!isRemoveOp(stamped) && order.hasPendingRemove(mutationKey(stamped, projectId))) return false')
    expect(gate).toBeGreaterThan(-1)
    // …before anything records or casts it: a held op must not leave a pending entry behind.
    expect(gate).toBeLessThan(body.indexOf('order.onLocal(stamped, projectId)'))
  })

  // Held = owed, but nothing re-publishes on its own: our echo is an ack, it changes no React state,
  // so the [nodes] publish effect never runs. The release has to publish.
  // Counted over EVERY key (D4): an echo of ours also releases an EARLIER remove whose echo was lost
  // (canvas-order, FIFO), which is a different key than the one this echo addresses.
  it('our own remove coming back — or a later echo proving it lost — releases what the gate held', () => {
    const body = receiveHandler()
    const before = body.indexOf('const heldBefore = order.pendingRemoveCount()')
    const accept = body.indexOf('order.accept(mutation, projectId)')
    expect(before).toBeGreaterThan(-1)
    expect(before).toBeLessThan(accept) // asked BEFORE the ack draws the count down
    expect(body).toMatch(/if \(order\.pendingRemoveCount\(\) < heldBefore\) queueMicrotask\(releaseHeld\)/)
    expect(body).not.toContain('const released = held')
  })

  // RULING R4: one order serves every loaded project, and a board's two order ops are per-project
  // singletons — so both paths key, record and judge with the project the op belongs to. Dropping
  // the project from any one of these made our unacked reorder in A deafen a peer's reorder in B.
  it('both paths thread the project id into the order (key, onLocal, accept)', () => {
    const send = sendCallback()
    expect(send).toContain('mutationKey(stamped, projectId)')
    expect(send).toContain('order.onLocal(stamped, projectId)')
    expect(send).not.toMatch(/order\.onLocal\(stamped\)/)
    const recv = receiveHandler()
    expect(recv).toContain('order.accept(mutation, projectId)')
    expect(recv).not.toMatch(/order\.accept\(mutation\)/)
  })

  it('the release publishes only when something is owed, and never during a load', () => {
    const start = src.indexOf('const releaseHeld = (): void => {')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n    }', start))
    expect(body).toMatch(/!pub\.hasOwed\(\)/)
    expect(body).toMatch(/loadingRef\.current/)
    expect(body).toMatch(/pub\.publish\(publishableLater\(nodesRef\.current\)\)/)
  })
})

// The switch-window race (Task 2 review, risk E) — behaviour in nodesEpoch.test.tsx, which runs the
// real hook against a replica of this receive path; these pin that Canvas IS that replica.
describe('the canvas:mut receive path routes by the epoch tag', () => {
  it('both branches go live only when liveCanvasHolds says React Flow has that project', () => {
    const body = receiveHandler()
    const route = /if \(!liveCanvasHolds\(nodesProjectIdRef\.current, useProjects\.getState\(\)\.activeProjectId, projectId\)\) \{/g
    expect(body.match(route) ?? []).toHaveLength(2) // the edge branch and the node branch
    // …and the old active-id-only test is gone from both.
    expect(body).not.toMatch(/if \(projectId !== useProjects\.getState\(\)\.activeProjectId\)/)
  })

  it('the node branch queues a FUNCTIONAL update built on the latest state', () => {
    const body = receiveHandler()
    expect(body).toMatch(
      /setNodes\(rebaseOnLatest\(base, flow, \(ns\) => applyMutationToFlow\(ns as CanvasNode\[\], mutation\)\)\)/
    )
    expect(body).not.toMatch(/\n\s*setNodes\(flow\)\n/)
  })
})

describe('render-time readers pair the rendered nodes with the rendered epoch', () => {
  // `nodesProjectIdRef` is the LATEST installed epoch now (useNodesEpoch): in the switch window it
  // already names the incoming project while this render's `nodes` are still the outgoing one's.
  // The context-link map (which authorizes context reads) must not pair A's links with B's id.
  it('the context-link sync takes the rendered epoch', () => {
    expect(src).toContain('useContextLinkSync({ projectId: renderedProjectId, nodes, edges: linkEdges })')
    expect(src).not.toContain('useContextLinkSync({ projectId: nodesProjectIdRef.current')
  })

  it('the pull-request watch takes the rendered epoch', () => {
    expect(src).toContain("const prWatchProjectId = prWatchNeeded ? (renderedProjectId ?? '') : ''")
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the OFF-CANVAS branch of the canvas-control dispatch — the sibling of
 * `control-cold-open.source.test.ts`, and for the same reason: the branch lives inside a
 * 12,000-line React component's IPC listener with no unit seam, and what it must be pinned on are
 * properties of the SOURCE.
 *
 * Every behavioural half is proven separately against real primitives: the verb set and its
 * disjointness from the other two in `lib/controlRouting.test.ts`, the reply clause and the notice
 * copy in `lib/coldOpen.test.ts`, the edge append in `state/projects.links.test.ts`.
 *
 * THE BUG this closes, which the cold-open fix left open: the user is looking at project B; an
 * agent in project A renders its output as a node — a report as `show-web`, a screenshot as
 * `show-image` — and the app switched to A. Those are the commonest reason a background session
 * touches the canvas at all, so the fix that covered `open-claude` covered the rarer half.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The off-canvas block: from its `if (answersOffCanvas(verb))` guard to the travel call it stands
 *  in front of. */
function offCanvasBody(): string {
  const start = src.indexOf('if (answersOffCanvas(verb)) {')
  expect(start, 'the off-canvas guard').toBeGreaterThan(-1)
  const end = src.indexOf('travelToProjectRef.current(route.projectId)', start)
  expect(end, 'the travel call after the block').toBeGreaterThan(start)
  return src.slice(start, end)
}

/** Line comments explain what a block must NOT do, so a negative pin has to judge the code. */
function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

/** The `addAndConnect` helper, whose off-canvas half is the whole write. */
function addAndConnectBody(): string {
  const start = src.indexOf('const addAndConnect = (node: CanvasNode) => {')
  expect(start, 'addAndConnect').toBeGreaterThan(-1)
  const end = src.indexOf('const nodeCount = ()', start)
  expect(end, 'nodeCount after it').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the off-canvas dispatch block (source pins)', () => {
  it('stands IN FRONT of the travel call — a display verb never reaches it', () => {
    // The travel call is what moved the user's screen. Scoped to the dispatch's source-routing
    // block (Canvas has one other, unrelated travel for the browser-verb guest lookup), the
    // off-canvas guard must precede the single travel in it, or the block is dead code sitting
    // behind the very thing it replaces.
    const from = src.indexOf('routeControlSource(projects, activeId, sourceNodeId)')
    expect(from, 'the source-routing lookup').toBeGreaterThan(-1)
    const to = src.indexOf('waitForCanvasNode(', from)
    expect(to, 'the post-routing canvas wait').toBeGreaterThan(from)
    const routing = src.slice(from, to)
    expect(routing.match(/travelToProjectRef\.current\(route\.projectId\)/g)?.length).toBe(1)
    const guard = routing.indexOf('if (answersOffCanvas(verb)) {')
    const travel = routing.indexOf('travelToProjectRef.current(route.projectId)')
    expect(guard, 'the off-canvas guard inside the routing block').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(travel)
    // …and the travel is its ELSE, so the two are exclusive by construction rather than by a
    // `return` someone can move.
    expect(routing).toMatch(/\} else \{\s*travelToProjectRef\.current\(route\.projectId\)/)
  })

  it('the guard polarity is not inverted', () => {
    expect(src).toContain('if (answersOffCanvas(verb)) {')
    expect(src).not.toContain('if (!answersOffCanvas(verb))')
  })

  it('never travels, activates, reopens or moves the camera', () => {
    // The whole point. A "Go there" button exists and is the user's to press; nothing here presses
    // it for them.
    const body = code(offCanvasBody())
    expect(body).not.toContain('travelToProject')
    expect(body).not.toContain('travelToNodeRef')
    expect(body).not.toContain('setActive')
    expect(body).not.toContain('reopenProject')
    expect(body).not.toContain('goToNode')
    expect(body).not.toContain('focusNodeById')
  })

  it('does NOT wait for a canvas — waiting for one is what travelling was for', () => {
    // `waitForCanvasNode` polls the LIVE nodes for the source. Off canvas that node is never
    // going to appear there, so an ungated wait would burn the whole timeout and then answer
    // "source node is not on an open canvas" — a refusal for being off-screen, which is exactly
    // what cecb4dfe removed.
    expect(src).toContain('if (!offCanvas && route.kind !== \'unknown\' && route.kind !== \'blocked\') {')
  })

  it('keeps cecb4dfe’s fix: the only source refusal is the capability sentence', () => {
    const body = code(offCanvasBody())
    expect(body).toContain("error: 'source node is not a control-capable agent'")
    expect(body).not.toContain('is not on an open canvas')
    expect(body).not.toContain('not the active project')
  })

  it('resolves the source from the OWNING project’s serialized nodes', () => {
    const body = offCanvasBody()
    expect(body).toContain('ocStore.getProject(route.projectId)')
    expect(body).toMatch(/owner\?\.nodes\.find\(\(n\) => n\.id === sourceNodeId\)/)
    // Hydrated with the same transform the project load uses, so the shape cannot drift from a
    // live node's — the verb bodies read `src.data.title`, `src.data.cwd` and its geometry.
    expect(body).toContain('nodeStatesToFlow([ocSrc])[0]')
  })

  it('the acting project is the SOURCE’s, not whatever is on screen', () => {
    // `ctlProject` decides the ssh flag, the browser session key and the media allowlist route.
    // Reading `activeProjectId` off canvas answers a background agent with the human's project.
    expect(src).toMatch(/const ctlProject =\s*\n\s*offCanvas\?\.project \?\?/)
  })

  it('writes through the store, never into the live canvas', () => {
    // React Flow holds the ACTIVE project's nodes. `setNodes` / `setControlEdges` / `markDirty`
    // would put the node in front of the wrong person and dirty the wrong file.
    const body = addAndConnectBody()
    const off = code(body.slice(body.indexOf('if (offCanvas) {'), body.indexOf('setNodes((ns) =>')))
    expect(off.length).toBeGreaterThan(0)
    expect(off).toContain('applyNodeMutation(offCanvas.project.id, {')
    expect(off).toContain('appendCanvasLinks(offCanvas.project.id, {')
    expect(off).toContain('writeDisk()')
    expect(off).not.toContain('setNodes(')
    expect(off).not.toContain('setControlEdges')
    expect(off).not.toContain('markDirty()')
  })

  it('the opener’s edge is a ROPE, and only a rope', () => {
    // Same edge the live path's `connect` draws, under the same id, so the node reads as
    // "produced by that conversation" when the project is next shown. `appendCanvasLinks` takes
    // both arrays and the two mean different things: a rope is display-only lineage, a bridge is
    // a context link that authorizes a READ. A display node has nothing to read, and the live
    // path draws no bridge for one — writing it here would hand an agent a context edge on
    // another project's canvas that nobody asked for, and the swap is a one-word edit.
    const off = code(
      addAndConnectBody().slice(
        addAndConnectBody().indexOf('if (offCanvas) {'),
        addAndConnectBody().indexOf('setNodes((ns) =>')
      )
    )
    expect(off).toContain(
      'ropes: [ropeEdge(`ctrl-${sourceNodeId}-${placed.id}`, sourceNodeId, placed.id)]'
    )
    expect(off).not.toContain('bridges:')
  })

  it('the colour index comes from the owning project, not the live array', () => {
    expect(src).toContain(
      'const nodeCount = () => (offCanvas ? offCanvas.project.nodes.length : nodesRef.current.length)'
    )
    // …and every display verb asks through it. A bare `nodesRef.current.length` in one of these
    // four cases compiles, passes every other test, and colours by a count from another project.
    // Scoped to the case bodies: these factories have unrelated callers (the user's own "open
    // file"), which legitimately count the live array because they land on the live canvas.
    for (const verb of ['show-image', 'show-video', 'show-web', 'open-browser']) {
      const at = src.indexOf(`case '${verb}': {`)
      expect(at, verb).toBeGreaterThan(-1)
      const body = src.slice(at, src.indexOf("\n          case '", at + 1))
      expect(body.length, verb).toBeGreaterThan(0)
      expect(body, verb).toContain('nodeCount()')
      expect(body, verb).not.toContain('nodesRef.current')
    }
  })

  it('says WHERE it went in both voices, once, and only after a node was made', () => {
    // The reply the agent reads and the strip the human reads are raised in the same place, so
    // neither can be forgotten for a verb. `created.length` is the gate: a refusal and a
    // `--dry-run` decorate nothing, because they made nothing.
    const start = src.indexOf('const reply = (r: {')
    expect(start).toBeGreaterThan(-1)
    const decor = src.slice(start, src.indexOf('api.sendAgentControlResult({ requestId, ...r })', start))
    expect(decor).toContain('if (offCanvas && r.ok && offCanvas.created.length) {')
    expect(decor).toContain('offCanvasReplyClause(project.name, { closed })')
    expect(decor).toContain('offCanvasNoticeText(project.name, created.length)')
    expect(decor).toContain('sticky: true')
    expect(decor).toContain("label: 'Go there'")
  })

  it('a CLOSED project is written into, and both voices say so', () => {
    // The same choice route `reopen` gets on the cold path: restoring a tab AND activating it is
    // the loudest version of the hijack this fixes.
    expect(offCanvasBody()).toMatch(/closed: route\.kind === 'reopen'/)
  })

  it('the notice does not fade — it reports work the user was not watching', () => {
    // An info strip that reports something the user just did may fade; this one reports a node
    // that landed in another project while they were busy elsewhere, and once it fades nothing
    // anywhere says it happened.
    expect(src).toContain("if (notice?.kind !== 'info' || notice.sticky) return")
  })
})

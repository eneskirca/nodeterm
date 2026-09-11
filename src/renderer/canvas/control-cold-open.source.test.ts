import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the COLD-OPEN branch of the canvas-control dispatch — the same class of test
 * as `control-open-project.source.test.ts`, and for the same reason: the branch lives inside a
 * 12,000-line React component's IPC listener with no unit seam, and what it must be pinned on are
 * properties of the SOURCE (what it calls and, above all, what it never calls).
 *
 * Every behavioural half is proven separately against real primitives: the verb set and its
 * disjointness from the store-answered set in `lib/controlRouting.test.ts`, the flag resolution,
 * placement and reply sentence in `lib/coldOpen.test.ts`, the arming round-trip in
 * `lib/projectOpen.test.ts`, and the edge append in `state/projects.links.test.ts`.
 *
 * THE BUG: the user is looking at project B; an agent in project A runs `nodeterm open-claude`; the
 * app switched to A and applied A's saved viewport, so the camera appeared to jump and zoom
 * (cecb4dfe, first shipped v0.2.43).
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The cold-open block: from its `if (canColdOpen(verb))` guard to the off-canvas guard that
 *  follows it. Bounded by that guard rather than by the travel call further down, so the pins
 *  below judge THIS block and never inherit a passing verdict from the one after it — the two are
 *  separate branches with separate contracts (`control-off-canvas.source.test.ts`). */
function coldOpenBody(): string {
  const start = src.indexOf('if (canColdOpen(verb)) {')
  expect(start, 'the cold-open guard').toBeGreaterThan(-1)
  const end = src.indexOf('if (answersOffCanvas(verb)) {', start)
  expect(end, 'the off-canvas guard after the block').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the cold-open dispatch block (source pins)', () => {
  it('stands IN FRONT of the travel call — an open verb never reaches it', () => {
    // The travel call is what moved the user's screen. Scoped to the dispatch's source-routing
    // block (Canvas has one other, unrelated travel for the browser-verb guest lookup), the
    // cold-open guard must precede the single travel in it, or the block is dead code sitting
    // behind the very thing it replaces.
    const from = src.indexOf('routeControlSource(projects, activeId, sourceNodeId)')
    expect(from, 'the source-routing lookup').toBeGreaterThan(-1)
    const to = src.indexOf('waitForCanvasNode(', from)
    expect(to, 'the post-routing canvas wait').toBeGreaterThan(from)
    const routing = src.slice(from, to)
    expect(routing.match(/travelToProjectRef\.current\(route\.projectId\)/g)?.length).toBe(1)
    const guard = routing.indexOf('if (canColdOpen(verb)) {')
    const travel = routing.indexOf('travelToProjectRef.current(route.projectId)')
    expect(guard, 'the cold-open guard inside the routing block').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(travel)
    // …and it RETURNS, so control cannot fall through to the travel after writing the node.
    expect(coldOpenBody()).toMatch(/queuedIds: coldIds\s*\}\s*\}\)\s*return\s*\}/)
  })

  it('the guard polarity is not inverted — a NON-cold verb must still travel', () => {
    // `if (!canColdOpen(verb))` would cold-write `write`/`close`/`group` into a serialized project
    // (silently doing nothing useful) and travel for every open — the exact swap of the fix.
    expect(src).toContain('if (canColdOpen(verb)) {')
    expect(src).not.toContain('if (!canColdOpen(verb))')
  })

  it('never travels, activates, or reopens anything', () => {
    const body = coldOpenBody()
    expect(body).not.toContain('travelToProject')
    expect(body).not.toContain('setActive')
    expect(body).not.toContain('reopenProject')
    expect(body).not.toContain('goToNode')
    expect(body).not.toContain('focusNodeById')
  })

  it('never touches the LIVE canvas — no setNodes, no edge state, no nodesRef', () => {
    // React Flow holds the ACTIVE project's nodes. Writing the new node there would put it on the
    // wrong canvas, which is worse than the travel it replaces.
    const body = coldOpenBody()
    expect(body).not.toContain('setNodes(')
    expect(body).not.toContain('setControlEdges')
    expect(body).not.toContain('setLinkEdges')
    expect(body).not.toContain('nodesRef.current')
    expect(body).not.toContain('addAndConnect')
  })

  it('writes through the store: applyNodeMutation for nodes, appendCanvasLinks for edges', () => {
    const body = coldOpenBody()
    expect(body).toContain('applyNodeMutation(owner.id, {')
    expect(body).toContain('appendCanvasLinks(owner.id,')
    expect(body).toContain('writeDisk()')
  })

  it('arms every node through armForColdOpen — the launch must survive serialization', () => {
    // `flowToNodeStates` drops `initialCommand` by design, so a node upserted without moving its
    // command into `pendingLaunch` is the silent-never-starts mutation.
    const body = coldOpenBody()
    expect(body).toMatch(/const armed = armForColdOpen\(built\)/)
    expect(body).toMatch(/flowToNodeStates\(\[node\]\)\[0\]/)
    // `--after` rides that same held launch rather than a second mechanism.
    expect(body).toMatch(/pendingLaunch: \{ \.\.\.held, after: coldAfterIds \}/)
  })

  it('refusal-before-write: every refusal precedes the first store write', () => {
    const body = coldOpenBody()
    const firstWrite = Math.min(
      ...['applyNodeMutation', 'appendCanvasLinks'].map((s) => {
        const i = body.indexOf(s)
        return i === -1 ? body.length : i
      })
    )
    expect(firstWrite).toBeLessThan(body.length)
    for (const refusal of [
      'source node is not a control-capable agent',
      'coldGroup.error',
      'coldAfter.error',
      '--prompt-file not found'
    ]) {
      const at = body.indexOf(refusal)
      expect(at, refusal).toBeGreaterThan(-1)
      expect(at, `${refusal} after a write`).toBeLessThan(firstWrite)
    }
  })

  it('keeps cecb4dfe’s fix: the refusal is the capability sentence, not a new rejection', () => {
    // Before cecb4dfe an agent outside the active project was rejected as "not a control-capable
    // agent" purely because the wrong canvas answered. The cold path must not reintroduce a
    // refusal for being off-screen — the ONLY refusal on the source is the capability one.
    const body = coldOpenBody()
    expect(body).toContain("error: 'source node is not a control-capable agent'")
    expect(body).not.toContain('is not on an open canvas')
    expect(body).not.toContain('not the active project')
  })

  it('reports the batch as QUEUED — no process exists until that project is viewed', () => {
    const body = coldOpenBody()
    expect(body).toMatch(/queued: true/)
    expect(body).toMatch(/queuedIds: coldIds/)
    // The sentence comes from the ONE shared builder, not a second phrasing.
    expect(body).toContain('coldOpenMessage(')
  })

  it('resolves defaults from the OWNING project, never from whatever is on screen', () => {
    // `activePermissionMode` / the active project's account list describe the project the user
    // happens to be looking at, which is not the one this node runs in.
    const body = coldOpenBody()
    expect(body).toContain('projectPermissionMode(owner, coldAgentId)')
    expect(body).not.toContain('activePermissionMode(')
    expect(body).toMatch(/resolveNewNodeAccount\(\s*coldSrc\.accountId,\s*owner,/)
    expect(body).toContain('nodeSshFor(owner.ssh, coldCwd)')
  })

  it('supports the documented flags on the cold path', () => {
    const body = coldOpenBody()
    for (const flag of ['args.count', 'args.cwd', 'args.group', 'args.after', 'args.prompt', 'args.model', 'args.cmd']) {
      expect(body, flag).toContain(flag)
    }
  })

  it('a CLOSED project is written into, and the reply says so', () => {
    // The deliberate choice for route `reopen`: restoring a tab AND activating it is the loudest
    // version of the hijack this fixes, and refusing would undo cecb4dfe.
    const body = coldOpenBody()
    expect(body).toMatch(/closed: route\.kind === 'reopen'/)
  })
})

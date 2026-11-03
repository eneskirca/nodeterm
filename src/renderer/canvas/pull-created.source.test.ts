import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the hook-opened pull node inside Canvas's control dispatch (the same class of
 * test as control-color.source.test.ts: the blocks live inside a huge component with no unit seam).
 * The decisions are unit-tested in shared/pull-created-hook.test.ts (planPullCreated) and
 * nodes/PullNodeView.test.tsx (the Allow state); these pin that the hook event runs the SAME
 * `open-pr` case (placement beside the agent, dedupe, off-screen projects) and never moves the camera.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function openPrCase(): string {
  const start = src.indexOf("case 'open-pr': {")
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start)
  return rest.slice(0, rest.indexOf("\n          case 'pr-show':"))
}

describe('the hook-opened pull node (source pins)', () => {
  it('the hook event runs the open-pr case as the verified caller, through the one dispatch', () => {
    const sub = src.slice(src.indexOf('api.onPullCreated('), src.indexOf('api.onPullCreated(') + 400)
    expect(sub).toContain('runControl(')
    expect(sub).toContain("sourceNodeId: nodeId, verb: 'open-pr', args: { pr: String(created.pullNumber) }")
    expect(src).toContain('const offControl = api.onAgentControl((cmd) => void runControl(cmd))')
  })

  it('plans with planPullCreated (own repository only, approved or not), and open-pr keeps planOpenPr', () => {
    const body = openPrCase()
    expect(body).toContain('planPullCreated({ created: fromHook, repo: prRepo')
    expect(body).toContain('planOpenPr({ args, repo: prRepo')
    // Placement and dedupe are the verb's own: addAndConnect for a create, the plan's reuse id.
    expect(body).toContain('addAndConnect(createPullNode(')
    expect(body).toContain("prPlan.kind === 'reuse'")
  })

  it('never travels for the hook path, and offers a Jump toast for a new node', () => {
    const body = openPrCase()
    expect(body).toContain("if (prPlan.kind === 'reuse' && !offCanvas && !fromHook) travelToNodeRef.current(prId)")
    const toast = body.slice(body.indexOf("if (fromHook && prPlan.kind === 'create')"))
    expect(toast).toContain('text: `PR #${prPlan.ref.pullNumber} opened`')
    expect(toast).toContain("action: { label: 'Jump', run: () => travelToNodeRef.current(prId) }")
    // The only travel calls in the case are the guarded one and the toast button's.
    expect(body.match(/travelToNodeRef\.current\(/g)).toHaveLength(2)
  })

  it('a hook-opened PR answers no CLI and raises no off-canvas strip', () => {
    const reply = src.slice(src.indexOf('const reply = (r: {'), src.indexOf('api.sendAgentControlResult({ requestId, ...r })'))
    expect(reply).toContain('if (fromHook) return')
    expect(reply.indexOf('if (fromHook) return')).toBeLessThan(reply.indexOf('setNotice('))
  })
})

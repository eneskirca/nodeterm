import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the armed-launch delivery loop (issue #569 item 1) — same class of test as
 * `control-open-project.source.test.ts`, and for the same reason: the loop is an effect inside a
 * 9000-line React component with no unit seam. The DECISIONS it makes are proven against real
 * primitives elsewhere (`pendingLaunch.test.ts` for the schedule and the tooltip,
 * `launchDelivery.test.ts` for the record); what only the source can state is which signals the
 * effect consults and what it does when it runs out of them.
 *
 * The bug: delivery was a flat 5 × 400 ms budget started when the CANVAS held the node, spent
 * while its terminal was still being spawned, and abandoned into a `console.warn`. A node opened
 * into a project the user was not looking at therefore said QUEUED forever, and neither the user
 * nor the orchestrator that opened it could tell that apart from a node still waiting on a
 * dependency.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

/** The launch effect: from the `launchesToFire(` call to the end of its dependency array. */
function launchEffect(): string {
  const start = src.indexOf('const ready = launchesToFire(')
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.indexOf('armedSetupSig, launchNudge])')
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

describe('armed-launch delivery (source pins)', () => {
  it('gates delivery on the node reporting its session READY, not on a fixed attempt budget', () => {
    const body = launchEffect()
    expect(body).toContain('isSessionReady(f.id)')
    // The gate must SKIP, never deliver-and-hope: an attempt against a session that does not
    // exist is what burnt the old budget before the terminal was up.
    expect(body).toMatch(/if \(!isSessionReady\(f\.id\)\)[\s\S]{0,1400}?continue/)
    // And the flat constants must be gone — a grep for them is how a revert announces itself.
    expect(src).not.toContain('LAUNCH_RETRY_MS')
    expect(src).not.toMatch(/attempt < LAUNCH_DELIVERY_ATTEMPTS/)
  })

  it('subscribes to readiness so a session coming up re-runs the loop — no polling, no deadline', () => {
    // Without this the ready gate would be a WORSE bug than the budget: a node that becomes
    // typeable a second after the effect last ran would sit armed with nothing to wake it.
    expect(src).toContain('subscribeSessionReady(')
    expect(src).toContain('setLaunchNudge')
    // Filtered by id: forty terminals publishing on load must not re-render the canvas forty
    // times for the sake of one armed node.
    expect(src).toMatch(/subscribeSessionReady\(\(nodeId\) => \{[\s\S]{0,400}?n\.data\.pendingLaunch/)
  })


  it('a give-up is REPORTED, not only logged — the console.warn is no longer the whole story', () => {
    const body = launchEffect()
    const warn = body.indexOf("console.warn('[pending-launch]")
    expect(warn).toBeGreaterThan(-1)
    // markFailed must accompany the log. This is the misleading-error rule: a failure the user
    // can only find in DevTools is a failure the user cannot find.
    expect(body).toContain('markFailed(f.id, attempt)')
    expect(body.slice(0, warn)).toContain('markFailed')
  })

  it('says so while it waits — a long stall raises the visible warning rather than staying mute', () => {
    const body = launchEffect()
    expect(body).toContain('LAUNCH_STALL_MS')
    expect(body).toContain('markStalled(f.id)')
    // Fire-time re-ask, same discipline as the hibernation sweep: the plan is 45 s old by then,
    // and the node may have started, been delivered or been deleted since.
    expect(body).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,600}?!isSessionReady\(f\.id\)[\s\S]{0,300}?markStalled/)
  })


  it('stops reporting on a node that is no longer armed — no stale warning on a running session', () => {
    const body = launchEffect()
    expect(body).toMatch(/delivery\.clear\(id\)[\s\S]{0,120}?clearStallTimer\(id\)/)
  })
})

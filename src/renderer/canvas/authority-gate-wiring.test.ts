// Source pins for the canvas-authority half of the publish gate (docs/hosted-team-relay.md). Canvas.tsx
// cannot be rendered in the node test environment, so the load-bearing SHAPES are pinned here; the
// behaviour behind them is collab-sync.test.ts (the rule), the bridge tests (who answers `governed`)
// and canvas-sync.convergence.test.ts (a solo edit on a governed project reaches the authority).
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i, `missing: ${start}`).toBeGreaterThan(-1)
  const j = src.indexOf(end, i + start.length)
  return src.slice(i, j === -1 ? undefined : j)
}

describe('the publish gate hears the canvas authority', () => {
  it('the ONE gate opens for a peer OR a governed project, the peer check still first', () => {
    const gate = between(canvas, 'const shouldPublishFor = (projectId: string): boolean =>', 'const pub = createCanvasPublisher(')
    // Through the pure rule (collab-sync `shouldPublish`), the peer check first.
    expect(gate).toContain('shouldPublish(hasPeersRef.current, governedRef.current, projectId) &&')
    // The two other halves are unchanged: the same core, and never a hosted viewer/commenter.
    expect(gate).toContain('sessionForProject(projectId).api === activeSession.api')
    expect(gate).toContain('!isHostedReadOnly(activeSession.id)')
  })

  it('the governed set is read from the ACTIVE core, reset on every re-bind, and kept current', () => {
    const effect = between(canvas, 'const order = createCanvasOrder(src)', 'orderRef.current = null')
    // Per core, like `hasPeersRef`: a relay tab's governed projects must not leak onto a local tab.
    expect(effect).toContain('governedRef.current = NO_PROJECTS')
    // `followGoverned` (collab-sync.test.ts) asks the core and follows its changes.
    expect(effect).toContain('const governed = followGoverned(activeSession.api, (projects) => {')
    expect(effect).toContain('governedRef.current = projects')
    // Asked again on a reconnect, beside the order reset: a change may have been missed meanwhile.
    expect(effect).toMatch(/if \(reconnected\(activePresence\.store\.getState\(\)\.myId\)\) \{\s*order\.reset\(\)\s*governed\.refresh\(\)/)
    // The follower exists before the first presence read can ask it to refresh.
    expect(effect.indexOf('const governed = followGoverned(')).toBeLessThan(effect.indexOf('readPresence()'))
    // Released with the effect.
    expect(effect).toMatch(/governed\.release\(\)/)
  })

  it('only ANOTHER client\'s mutation proves a peer (never our own echo)', () => {
    const handler = between(canvas, 'return activeSession.api.canvas.onMutation((projectId, received) => {', 'const order = orderRef.current')
    expect(handler).toContain('if (provesPeer(mutation, canvasSrcRef.current)) hasPeersRef.current = true')
    expect(handler).not.toMatch(/^\s*hasPeersRef\.current = true/m)
    const tag = between(canvas, 'const src = `cv-${Math.random().toString(36).slice(2, 10)}`', 'const order = createCanvasOrder(src)')
    expect(tag).toContain('canvasSrcRef.current = src')
  })
})

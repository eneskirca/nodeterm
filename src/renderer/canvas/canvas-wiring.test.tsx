// @vitest-environment jsdom
//
// Two things Canvas.tsx wires that nothing else could see it stop wiring.
//
// Canvas is a monolith with no render harness, so the pieces below are pinned where they live: the
// chrome opt-in by RENDERING the cluster that carries it and asking `chromeObstacles` for it, and
// the wiring by reading the call site. A source read is a weak test in general, but it is the only
// thing standing between a one-character deletion and a silently reintroduced bug — which is
// exactly the shape that survived the whole suite once on this branch already.
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromeObstacles, FIT_VIEW_GAP } from './fit-view'

const CANVAS_SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8')

/** jsdom lays nothing out, so every rect is 0×0 and `chromeObstacles`'s size filter would drop the
 *  element. Give it the measurement a real bottom-left pill cluster has. */
function measured(el: Element, r: { left: number; top: number; right: number; bottom: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top }) as DOMRect
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the canvas pill cluster is fit-view chrome', () => {
  const VIEWPORT = { left: 0, top: 0, right: 1200, bottom: 800 }
  const PILLS = { left: 60, top: 740, right: 300, bottom: 766 }

  it('is picked up as an obstacle through data-canvas-chrome', () => {
    // Exactly the markup Canvas renders: the ATTRIBUTE is the whole opt-in — `.canvas-pills` is not
    // in CANVAS_CHROME_SELECTOR, so nothing else can reach this element.
    document.body.innerHTML = '<div class="canvas-pills" data-canvas-chrome></div>'
    const el = document.querySelector('.canvas-pills')!
    measured(el, PILLS)
    const obstacles = chromeObstacles(VIEWPORT)
    expect(obstacles).toHaveLength(1)
    // Inflated by the gap, so fitView keeps content clear of the pills rather than flush against.
    expect(obstacles[0]).toEqual({
      left: PILLS.left - FIT_VIEW_GAP,
      top: PILLS.top - FIT_VIEW_GAP,
      right: PILLS.right + FIT_VIEW_GAP,
      bottom: PILLS.bottom + FIT_VIEW_GAP
    })
  })

  it('is invisible to fit-view without the attribute', () => {
    // The failure this pins: dropping `data-canvas-chrome` leaves a rendering, clickable cluster and
    // a fitView that parks nodes underneath it — no error, no test, nothing to notice.
    document.body.innerHTML = '<div class="canvas-pills"></div>'
    measured(document.querySelector('.canvas-pills')!, PILLS)
    expect(chromeObstacles(VIEWPORT)).toEqual([])
  })

  it('is what Canvas actually renders', () => {
    expect(CANVAS_SRC).toContain('<div className="canvas-pills" data-canvas-chrome>')
  })
})

describe('the session-memory panel is the one caller that fans a kill across sockets', () => {
  // Both legs of the panel's speculative kill (see `localKillSockets`): its rows are swept off BOTH
  // of the machine's tmux sockets, so a row it offers to end can be on either. Every other caller
  // knows its own nodes and must stay narrow, which is why the flag is opt-in — and why dropping it
  // here restores the exact bug the confirm used to lie about, with the whole suite green.
  it('asks for every socket on the local destroy and the remote kill', () => {
    expect(CANVAS_SRC).toContain("transport.destroy(nodeId, { everySocket: true })")
    expect(CANVAS_SRC).toContain(
      ".killSessions(plan.remoteProjectId!, [nodeId], { everySocket: true })"
    )
  })

  it('leaves project deletion narrow', () => {
    // The other `killSessions` call site (deleteProject) passes ids and nothing else. `node-terminal`
    // on that host belongs to a nodeterm running ON it, not to the project being deleted.
    expect(CANVAS_SRC).toContain('.killSessions(id, nodeIds)')
  })
})

describe('the end-session confirm describes both things it does', () => {
  // `closeSession` stops the tmux session AND deletes the canvas node. The wording is inherited
  // from the sessions sidebar, where deleting the node is the obvious intent — but the
  // session-memory panel reuses the same path, and there the user came to reclaim RAM. Saying only
  // "this stops its tmux session" makes the node's removal a surprise on the one surface whose
  // purpose invites it. (Keeping the node would need a SECOND destroy path; deliberately not built.)
  it('says the node goes too, on every owned-session confirm', () => {
    const owned = CANVAS_SRC.match(/End this session\?[^']*/g) ?? []
    expect(owned.length).toBeGreaterThanOrEqual(3)
    for (const m of owned) {
      // The orphan row is the one exception, and it is honest: there is no node to remove.
      if (m.includes('no node on any canvas')) continue
      expect(m).toContain('removes the node from its canvas')
    }
  })
})
